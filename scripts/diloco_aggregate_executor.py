#!/usr/bin/env python3
"""
DiLoCo node-side aggregation executor (re-architecture Phase 3).

Ports the coordinator's `scripts/diloco_aggregate.py` algorithm onto the
compute node. The coordinator becomes a pure orchestrator/verifier with
zero torch; the node does the tensor work (it has the RAM the 512 MB
worker VM lacked, which is the whole point of the re-architecture).

DETERMINISM (design doc §2 / OPEN DECISION 1 = yes):
  - CPU-PINNED: every tensor is forced onto CPU; CUDA is never used even
    when present. GPU `mean`/`stack` order is nondeterministic across
    driver/cuda/model and would blow the coord's tolerance consensus.
  - FLOAT64 ACCUMULATION: gradients are upcast to float64 for the
    weighted mean + momentum, then downcast to the adapter's dtype only
    at write time. This shrinks cross-node float drift so the coord's
    tight (1e-5 when CPU-pinned) tolerance holds across heterogeneous
    nodes. The output adapter is a tiny LoRA (~92 MB) so CPU/float64 is
    seconds, not minutes.
  - Sorted-by-name flatten + sorted peer iteration → the same byte
    layout regardless of dict insertion order across pickles.

ALGORITHM (mirrors coord `scripts/diloco_aggregate.py`):
  1. Load each peer gradient bundle (raw {name: Tensor} OR SVD
     {name: {U,S,V,shape}} — both supported, same as `diloco_train.py`).
  2. Node-side Byzantine / cosine filter (mirrors the coord's
     `byzantineFilter` + `evaluateCosineReview`): compute the
     stake-weighted mean, then per-peer cosine vs that mean. Peers below
     `cosineRejectThreshold` are dropped (`cosine_low`); zero-magnitude
     or NaN cosines are dropped (`cosine_nan`). The mean is RECOMPUTED
     over survivors only (a poisoned peer must not bias the accepted
     update).
  3. Nesterov momentum with the pinned `prevVelocity` (NOT node-local —
     §2 velocity carry-over): v_t = momentum*v_{t-1} + avg_grad;
     update = momentum*v_t + avg_grad.
  4. new_adapter = current_adapter + update (current_adapter = pinned
     `prevAdapter`; round 0 → update alone, §2 cold-start).
  5. Write adapter + velocity pickles; emit the canonical scalar
     invariants the result contract needs.

INPUT (single-line JSON on stdin):
  {
    "gradients": [
      {"peerId": "<hex>", "gradientPath": "/abs/path/grad.pt",
       "stakeWeight": 0.41},
      ...
    ],
    "prevAdapterPath":  "/abs/path/prev_adapter.pkl" | null,   # round 0 → null
    "prevVelocityPath": "/abs/path/prev_velocity.pkl" | null,  # round 0 → null
    "momentum": 0.9,
    "cosineRejectThreshold": 0.3,
    "outputAdapterPath":  "/abs/path/candidate_adapter.pkl",
    "outputVelocityPath": "/abs/path/candidate_velocity.pkl"
  }

OUTPUT (single-line JSON on stdout, the canonical scalar invariants):
  {
    "avgGradientNorm": <float>,
    "velocityNorm":    <float>,
    "perPeerCosine":   {"<peerId>": <float | "NaN">, ...},
    "acceptedPeerIds": ["<peerId>", ...],
    "rejectedPeerIds": [{"peerId": "<hex>", "reason": "cosine_low|cosine_nan"}, ...],
    "participatingNodes": <int>,
    "adapterPath":  "<str>",
    "velocityPath": "<str>"
  }

On any failure the script prints `{"error": "...", "errorType": "..."}` to
stdout and exits non-zero (P2 fail-closed — the TS caller treats a
non-zero exit OR an `error` key as an abort, never aggregates a partial /
tampered result).
"""

from __future__ import annotations

import json
import math
import os
import pickle
import sys
from typing import Any, Dict, List, Optional, Tuple

# Accumulation dtype — float64 for cross-node reproducibility (see header).
_ACCUM_DTYPE = "float64"


def _force_cpu_torch():
    """Import torch and hard-disable CUDA so accumulation is CPU-only.

    CPU float64 is far more reproducible than GPU float32 across
    heterogeneous nodes (design §2). We never construct a CUDA tensor;
    `map_location='cpu'` on load + explicit `.cpu()` keeps everything on
    the host even if torch was built with CUDA.
    """
    import torch  # local import — keep top-level light for pure-fn tests

    torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "4")))
    return torch


def _load_bundle(path: str) -> Dict[str, Any]:
    """Load a pickle bundle written by `diloco_train.py`.

    Accepts {name: Tensor} or {name: {U,S,V,shape}} SVD bundles.
    """
    with open(path, "rb") as fh:
        bundle = pickle.load(fh)
    if not isinstance(bundle, dict):
        raise ValueError(f"gradient/adapter file {path} did not contain a dict")
    return bundle


def _is_meta_key(name: str) -> bool:
    """Adapter bundles carry coord metadata keys (`_velocity`, `_round`,
    `_model_id`, …) prefixed with `_`. They are NOT tensors and must be
    skipped when flattening / accumulating."""
    return name.startswith("_")


def _decompress_if_svd(name: str, value: Any):
    """Reconstruct a dense tensor from an SVD bundle, else pass through."""
    torch = _force_cpu_torch()
    if isinstance(value, dict) and {"U", "S", "V", "shape"}.issubset(value.keys()):
        U = value["U"].cpu()
        S = value["S"].cpu()
        V = value["V"].cpu()
        shape = value["shape"]
        dense = (U * S.unsqueeze(0)) @ V.transpose(-2, -1)
        return dense.reshape(shape)
    if isinstance(value, torch.Tensor):
        return value.cpu()
    raise ValueError(f"unsupported gradient entry for tensor {name!r}: {type(value)}")


def _tensor_keys(bundle: Dict[str, Any]) -> List[str]:
    """Sorted list of real tensor keys (metadata `_*` keys excluded)."""
    return sorted(k for k in bundle.keys() if not _is_meta_key(k))


def _flatten(bundle: Dict[str, Any]):
    """Concatenate all named tensors into one 1-D float64 vector on CPU.

    Sorted-by-name so two peers with different dict order still align.
    """
    torch = _force_cpu_torch()
    parts = []
    for name in _tensor_keys(bundle):
        t = _decompress_if_svd(name, bundle[name])
        parts.append(t.detach().to(dtype=getattr(torch, _ACCUM_DTYPE)).reshape(-1))
    if not parts:
        return torch.zeros(0, dtype=getattr(torch, _ACCUM_DTYPE))
    return torch.cat(parts, dim=0)


def _cosine(a, b) -> float:
    """Cosine similarity with zero-magnitude / NaN guard returning NaN.

    Mirrors the coord's per-peer cosine review. NaN means "drop this peer
    as cosine_nan" — never crash the aggregator (P22)."""
    torch = _force_cpu_torch()
    if a.numel() == 0 or b.numel() == 0 or a.numel() != b.numel():
        return float("nan")
    na = float(torch.linalg.vector_norm(a).item())
    nb = float(torch.linalg.vector_norm(b).item())
    if na == 0.0 or nb == 0.0 or not math.isfinite(na) or not math.isfinite(nb):
        return float("nan")
    cos = torch.nn.functional.cosine_similarity(a.unsqueeze(0), b.unsqueeze(0), dim=1).item()
    if not math.isfinite(cos):
        return float("nan")
    return max(-1.0, min(1.0, float(cos)))


def _weighted_mean(flats_weights: List[Tuple["Any", float]], flat_dim: int):
    """Stake-weighted mean over flat vectors (float64). Degenerate weights
    (sum <= 0) fall back to the unweighted mean so a bad coord contract
    can't zero out the update."""
    torch = _force_cpu_torch()
    if flat_dim == 0 or not flats_weights:
        return torch.zeros(flat_dim, dtype=getattr(torch, _ACCUM_DTYPE))
    total_w = sum(w for _, w in flats_weights)
    if total_w <= 0:
        total_w = float(len(flats_weights))
        flats_weights = [(t, 1.0) for t, _ in flats_weights]
    acc = torch.zeros(flat_dim, dtype=getattr(torch, _ACCUM_DTYPE))
    for t, w in flats_weights:
        acc = acc + t * (w / total_w)
    return acc


def byzantine_cosine_filter(
    peers: List[Dict[str, Any]],
    cosine_reject_threshold: float,
) -> Dict[str, Any]:
    """Node-side Byzantine / cosine filter (mirrors coord byzantineFilter +
    evaluateCosineReview). Returns the accepted survivors, the per-peer
    cosine map, the rejected set, and the FINAL survivor-only weighted-mean
    flat vector (the update source).

    Two-pass: (1) provisional mean over all peers to score cosine;
    (2) drop low/NaN cosine peers; (3) recompute the mean over survivors
    so a poisoned peer never biases the accepted update."""
    torch = _force_cpu_torch()

    loaded: List[Tuple[str, Dict[str, Any], "Any", float]] = []
    for entry in peers:
        peer_id = str(entry["peerId"])
        path = str(entry["gradientPath"])
        weight = float(entry.get("stakeWeight", 1.0))
        bundle = _load_bundle(path)
        flat = _flatten(bundle)
        loaded.append((peer_id, bundle, flat, weight))

    if not loaded:
        return {
            "accepted": [],
            "rejected": [],
            "perPeerCosine": {},
            "aggFlat": torch.zeros(0, dtype=getattr(torch, _ACCUM_DTYPE)),
            "canonicalBundle": None,
            "flatDim": 0,
        }

    flat_sizes = {t.numel() for _, _, t, _ in loaded}
    if len(flat_sizes) > 1:
        raise ValueError(
            f"peer gradient flat-sizes disagree: {sorted(flat_sizes)} — refusing to aggregate"
        )
    flat_dim = next(iter(flat_sizes))

    # Pass 1 — provisional mean over ALL peers to score cosine.
    provisional = _weighted_mean([(t, w) for _, _, t, w in loaded], flat_dim)

    per_peer_cosine: Dict[str, float] = {}
    accepted: List[Tuple[str, Dict[str, Any], "Any", float]] = []
    rejected: List[Dict[str, str]] = []
    for peer_id, bundle, flat, weight in loaded:
        cos = _cosine(flat, provisional)
        per_peer_cosine[peer_id] = cos
        if math.isnan(cos):
            rejected.append({"peerId": peer_id, "reason": "cosine_nan"})
        elif cos < cosine_reject_threshold:
            rejected.append({"peerId": peer_id, "reason": "cosine_low"})
        else:
            accepted.append((peer_id, bundle, flat, weight))

    # Pass 2 — recompute the mean over survivors only. If the filter
    # dropped everyone, fall back to the provisional all-peer mean so the
    # round still produces an update (the coord's quorum floor + consensus
    # will catch a genuinely degenerate round).
    if accepted:
        agg_flat = _weighted_mean([(t, w) for _, _, t, w in accepted], flat_dim)
        canonical_bundle = accepted[0][1]
    else:
        agg_flat = provisional
        canonical_bundle = loaded[0][1]

    return {
        "accepted": [pid for pid, _, _, _ in accepted],
        "rejected": rejected,
        "perPeerCosine": per_peer_cosine,
        "aggFlat": agg_flat,
        "canonicalBundle": canonical_bundle,
        "flatDim": flat_dim,
    }


def _rebuild_dict(canonical_bundle: Dict[str, Any], flat) -> Dict[str, Any]:
    """Reshape a flat float64 vector back into a {name: Tensor} dict using
    the canonical bundle's layout (sorted-by-name)."""
    torch = _force_cpu_torch()
    rebuilt: Dict[str, "Any"] = {}
    cursor = 0
    for name in _tensor_keys(canonical_bundle):
        ref = _decompress_if_svd(name, canonical_bundle[name])
        n = ref.numel()
        slab = flat[cursor : cursor + n].reshape(ref.shape)
        rebuilt[name] = slab
        cursor += n
    if cursor != flat.numel():
        raise ValueError(
            f"reconstruction cursor {cursor} != flat dim {flat.numel()} — layout mismatch"
        )
    return rebuilt


def _flat_norm(flat) -> float:
    torch = _force_cpu_torch()
    return float(torch.linalg.vector_norm(flat).item()) if flat.numel() else 0.0


def apply_nesterov_momentum(
    avg_grad_flat,
    prev_velocity_flat,
    momentum: float,
):
    """Nesterov momentum on the flat update vector (mirrors coord
    `apply_nesterov_momentum_torch`).

      v_t   = momentum * v_{t-1} + avg_grad
      update = momentum * v_t + avg_grad   (look-ahead)

    Round-0 cold-start (§2): prev_velocity is None → v_t = avg_grad,
    update = avg_grad."""
    torch = _force_cpu_torch()
    if prev_velocity_flat is None or prev_velocity_flat.numel() != avg_grad_flat.numel():
        new_velocity = avg_grad_flat.clone()
        update = avg_grad_flat.clone()
    else:
        new_velocity = momentum * prev_velocity_flat + avg_grad_flat
        update = momentum * new_velocity + avg_grad_flat
    return new_velocity, update


def aggregate(config: Dict[str, Any]) -> Dict[str, Any]:
    """Full aggregation: filter → momentum → adapter accumulation → write."""
    torch = _force_cpu_torch()

    peers = config.get("gradients") or []
    momentum = float(config.get("momentum", 0.9))
    cosine_reject_threshold = float(config.get("cosineRejectThreshold", 0.3))
    prev_adapter_path = config.get("prevAdapterPath")
    prev_velocity_path = config.get("prevVelocityPath")
    output_adapter_path = config.get("outputAdapterPath")
    output_velocity_path = config.get("outputVelocityPath")

    if not output_adapter_path or not output_velocity_path:
        raise ValueError("outputAdapterPath and outputVelocityPath are required")

    filt = byzantine_cosine_filter(peers, cosine_reject_threshold)
    canonical_bundle = filt["canonicalBundle"]
    flat_dim = filt["flatDim"]
    avg_grad_flat = filt["aggFlat"]

    if canonical_bundle is None or flat_dim == 0:
        raise ValueError("no usable gradients after filter — refusing to aggregate")

    avg_grad_norm = _flat_norm(avg_grad_flat)

    # Pinned prevVelocity (§2 — NOT node-local). Flatten with the SAME
    # canonical layout so element alignment holds.
    prev_velocity_flat = None
    if prev_velocity_path and os.path.exists(prev_velocity_path):
        prev_velocity_flat = _flatten(_load_bundle(prev_velocity_path))

    new_velocity_flat, update_flat = apply_nesterov_momentum(
        avg_grad_flat, prev_velocity_flat, momentum
    )
    velocity_norm = _flat_norm(new_velocity_flat)

    # new_adapter = prev_adapter + update  (§2 adapter accumulation).
    # Round 0 → prev_adapter None → adapter = update alone.
    if prev_adapter_path and os.path.exists(prev_adapter_path):
        prev_adapter = _load_bundle(prev_adapter_path)
        prev_flat = _flatten(prev_adapter)
        if prev_flat.numel() != update_flat.numel():
            raise ValueError(
                f"prevAdapter flat dim {prev_flat.numel()} != update dim {update_flat.numel()}"
            )
        new_adapter_flat = prev_flat + update_flat
        # Preserve the prev adapter's dtype layout on write.
        adapter_layout = prev_adapter
    else:
        new_adapter_flat = update_flat
        adapter_layout = canonical_bundle

    new_adapter = _rebuild_dict_with_dtype(adapter_layout, new_adapter_flat)
    new_velocity = _rebuild_dict_with_dtype(canonical_bundle, new_velocity_flat)

    os.makedirs(os.path.dirname(os.path.abspath(output_adapter_path)), exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(output_velocity_path)), exist_ok=True)
    with open(output_adapter_path, "wb") as fh:
        pickle.dump(new_adapter, fh)
    with open(output_velocity_path, "wb") as fh:
        pickle.dump(new_velocity, fh)

    return {
        "avgGradientNorm": avg_grad_norm,
        "velocityNorm": velocity_norm,
        "perPeerCosine": filt["perPeerCosine"],
        "acceptedPeerIds": filt["accepted"],
        "rejectedPeerIds": filt["rejected"],
        "participatingNodes": len(filt["accepted"]),
        "adapterPath": output_adapter_path,
        "velocityPath": output_velocity_path,
    }


def _rebuild_dict_with_dtype(layout_bundle: Dict[str, Any], flat) -> Dict[str, Any]:
    """Like `_rebuild_dict` but downcasts each tensor back to the layout
    bundle's original dtype at write time (float64 accumulation is internal;
    the persisted adapter/velocity keeps the model's dtype)."""
    torch = _force_cpu_torch()
    rebuilt: Dict[str, "Any"] = {}
    cursor = 0
    for name in _tensor_keys(layout_bundle):
        ref = _decompress_if_svd(name, layout_bundle[name])
        n = ref.numel()
        slab = flat[cursor : cursor + n].reshape(ref.shape).to(dtype=ref.dtype)
        rebuilt[name] = slab
        cursor += n
    if cursor != flat.numel():
        raise ValueError(
            f"reconstruction cursor {cursor} != flat dim {flat.numel()} — layout mismatch"
        )
    return rebuilt


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "empty stdin", "errorType": "ValueError"}))
        return 1
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON: {e}", "errorType": "JSONDecodeError"}))
        return 1

    try:
        result = aggregate(config)
    except Exception as e:  # noqa: BLE001 — surface aggregator-level failures verbatim
        print(json.dumps({"error": str(e), "errorType": type(e).__name__}))
        return 1

    # NaN cosines → "NaN" string sentinel (coord parses with JSON.parse,
    # which rejects bare NaN — the executor detects the sentinel).
    serializable = dict(result)
    serializable["perPeerCosine"] = {
        pid: ("NaN" if isinstance(v, float) and math.isnan(v) else v)
        for pid, v in result["perPeerCosine"].items()
    }
    print(json.dumps(serializable))
    return 0


if __name__ == "__main__":
    sys.exit(main())
