#!/usr/bin/env python3
"""
DiLoCo gradient aggregator.

Bug 35 (2026-05-18) — coordinator-driven peer-review needs per-peer
cosine similarity against the aggregated mean so it can reject
outliers (poisoned or stale peers) before applying the update.

Reads config from stdin as JSON:
    {
      "peers": [
        {"peerId": "<id>", "gradientPath": "/path/to/grad.pt", "weight": 1.0},
        ...
      ],
      "outputPath": "/path/to/aggregated.pt"   # optional
    }

Each `gradientPath` is a pickle of a dict { tensorName: torch.Tensor }
in the same shape `diloco_train.py` produces (uncompressed pseudo-
gradients OR a {name: {U,S,V,shape}} SVD bundle — both supported).

Outputs JSON on stdout:
    {
      "participatingNodes": <int>,
      "avgGradientNorm":   <float>,
      "velocityNorm":      <float>,
      "perPeerCosine":     { "<peerId>": <float|NaN>, ... },
      "outputPath":        "<str|null>"
    }

Notes
-----
- Per-peer cosine: `cosine(flatten(g_i), flatten(agg))`. If either side
  has zero magnitude (peer dropped all-zeros, or aggregated to zero
  because peers cancel exactly), emit `NaN` so coord picks it up as
  `cosine_nan` — never crash the aggregator (P22).
- Existing JSON keys (`participatingNodes`, `avgGradientNorm`,
  `velocityNorm`) are emitted alongside `perPeerCosine` for back-compat
  with coord 0.8.71 (which ignores extra fields).
- Layout / dtype / device of inputs must be compatible. Zero-element
  tensors are tolerated; `NaN`s in inputs propagate into the cosine
  output (callers can detect and drop).
"""

import sys
import json
import math
import pickle
from typing import Any, Dict, List, Optional, Tuple


def _load_gradient_bundle(path: str) -> Dict[str, Any]:
    """Load a pickle file written by `diloco_train.py`.

    Two shapes are accepted:
      A) {name: torch.Tensor}                — raw pseudo-gradients
      B) {name: {"U": T, "S": T, "V": T, "shape": list}} — SVD compressed
    """
    with open(path, "rb") as fh:
        bundle = pickle.load(fh)
    if not isinstance(bundle, dict):
        raise ValueError(f"gradient file {path} did not contain a dict")
    return bundle


def _as_f32_tensor(value: Any):
    """Coerce a gradient component (Python list, numpy array, or torch
    Tensor) to a float32 tensor.

    `diloco_train.py::compress_gradients_svd` persists U/S/V (and the `raw`
    fallback) via `.tolist()`, so by contract they arrive as nested Python
    LISTS — tensor ops (`unsqueeze`/`transpose`) raised AttributeError on a
    list (round 1228 production failure). `torch.as_tensor` accepts list /
    ndarray / Tensor uniformly. Defense-in-depth (P2): be liberal in what
    we accept so the averaging math never crashes on a list."""
    import torch

    if isinstance(value, torch.Tensor):
        return value.to(dtype=torch.float32)
    return torch.as_tensor(value, dtype=torch.float32)


def _decompress_if_svd(name: str, value: Any):
    """If `value` is an SVD bundle, reconstruct the dense tensor.

    Accepts the two on-disk shapes `diloco_train.py` emits — the SVD bundle
    `{U,S,V,shape}` and the `{raw,shape}` non-SVD fallback — plus a bare
    tensor. U/S/V/raw are stored as Python lists (`.tolist()`); they are
    coerced to float32 tensors before any tensor op (P2).
    """
    import torch  # local import — keep top-level light for tests

    if isinstance(value, dict) and {"U", "S", "V", "shape"}.issubset(value.keys()):
        U = _as_f32_tensor(value["U"])
        S = _as_f32_tensor(value["S"])
        V = _as_f32_tensor(value["V"])
        shape = value["shape"]
        # reconstruct: U @ diag(S) @ Vh  → reshape to original.
        # `diloco_train.py::compress_gradients_svd` stores the "V" key as
        # `Vh[:k, :]` — it ALREADY holds Vh (the conjugate transpose from
        # `torch.linalg.svd`), shape (k, cols). So `U`=(rows,k), `S`=(k,),
        # `V`=Vh=(k,cols), and (U * S) @ V = (rows,cols) directly. NO
        # transpose on V — transposing would silently corrupt square layers
        # and crash rectangular ones.
        dense = (U * S.unsqueeze(0)) @ V
        return dense.reshape(shape)
    if isinstance(value, dict) and {"raw", "shape"}.issubset(value.keys()):
        # Non-SVD fallback bundle (SVD raised on the training side).
        return _as_f32_tensor(value["raw"]).reshape(value["shape"])
    if isinstance(value, torch.Tensor):
        return value
    raise ValueError(f"unsupported gradient entry shape for tensor {name!r}: {type(value)}")


def _flatten_bundle(bundle: Dict[str, Any]):
    """Concatenate all named tensors into a single 1-D flat vector.

    Ordering is sorted-by-name to keep peers aligned even if dict order
    differs across pickles.
    """
    import torch

    parts = []
    for name in sorted(bundle.keys()):
        t = _decompress_if_svd(name, bundle[name])
        parts.append(t.detach().to(dtype=torch.float32).reshape(-1))
    if not parts:
        return torch.zeros(0, dtype=torch.float32)
    return torch.cat(parts, dim=0)


def _cosine(a, b) -> float:
    """Cosine similarity with zero-magnitude guard returning NaN.

    P22 — single peer with zero-magnitude gradient must NOT crash the
    aggregator. NaN propagates into the result JSON; coord interprets
    it as `cosine_nan` and excludes the peer from the peer-review pool.
    """
    import torch

    if a.numel() == 0 or b.numel() == 0 or a.numel() != b.numel():
        return float("nan")
    na = float(torch.linalg.vector_norm(a).item())
    nb = float(torch.linalg.vector_norm(b).item())
    if na == 0.0 or nb == 0.0 or not math.isfinite(na) or not math.isfinite(nb):
        return float("nan")
    cos = torch.nn.functional.cosine_similarity(a.unsqueeze(0), b.unsqueeze(0), dim=1).item()
    if not math.isfinite(cos):
        return float("nan")
    # clamp tiny FP noise outside [-1, 1]
    if cos > 1.0:
        cos = 1.0
    elif cos < -1.0:
        cos = -1.0
    return float(cos)


def average_gradients(
    peer_inputs: List[Dict[str, Any]],
    output_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Weighted-mean per-peer gradients and emit per-peer cosine.

    Args
    ----
    peer_inputs:
        List of `{"peerId": str, "gradientPath": str, "weight": float}`.
    output_path:
        Optional path to write the aggregated pickle bundle to.

    Returns
    -------
    Dict with keys: participatingNodes, avgGradientNorm, velocityNorm,
    perPeerCosine, outputPath.
    """
    import torch

    if not peer_inputs:
        return {
            "participatingNodes": 0,
            "avgGradientNorm": 0.0,
            "velocityNorm": 0.0,
            "perPeerCosine": {},
            "outputPath": None,
        }

    # 1) Load + flatten each peer.
    loaded: List[Tuple[str, Dict[str, Any], "torch.Tensor", float]] = []
    for entry in peer_inputs:
        peer_id = str(entry["peerId"])
        path = str(entry["gradientPath"])
        weight = float(entry.get("weight", 1.0))
        bundle = _load_gradient_bundle(path)
        flat = _flatten_bundle(bundle)
        loaded.append((peer_id, bundle, flat, weight))

    # 2) Weighted mean over the flat representation. We aggregate in
    #    flat space and then re-shape per-tensor in step 4 so cosine
    #    and downstream consumers see identical layouts.
    flat_sizes = {t.numel() for _, _, t, _ in loaded}
    if len(flat_sizes) > 1:
        raise ValueError(
            f"peer gradient flat-sizes disagree: {sorted(flat_sizes)} — refusing to aggregate"
        )
    total_w = sum(w for _, _, _, w in loaded)
    if total_w <= 0:
        # Degenerate weights: fall back to unweighted mean.
        total_w = float(len(loaded))
        normalized = [(pid, b, t, 1.0) for pid, b, t, _ in loaded]
    else:
        normalized = loaded

    flat_dim = next(iter(flat_sizes))
    if flat_dim == 0:
        agg_flat = torch.zeros(0, dtype=torch.float32)
    else:
        agg_flat = torch.zeros(flat_dim, dtype=torch.float32)
        for _, _, t, w in normalized:
            agg_flat = agg_flat + t * (w / total_w)

    # 3) Per-peer cosine.
    per_peer_cosine: Dict[str, float] = {}
    for peer_id, _, t, _ in normalized:
        per_peer_cosine[peer_id] = _cosine(t, agg_flat)

    # 4) Reconstruct dict-of-tensors using the FIRST peer's layout as
    #    the canonical shape. (Inner step 1 guaranteed flat sizes match.)
    canonical_bundle = normalized[0][1]
    rebuilt: Dict[str, "torch.Tensor"] = {}
    cursor = 0
    for name in sorted(canonical_bundle.keys()):
        ref = _decompress_if_svd(name, canonical_bundle[name])
        n = ref.numel()
        slab = agg_flat[cursor : cursor + n].reshape(ref.shape)
        rebuilt[name] = slab.to(dtype=ref.dtype)
        cursor += n
    # cursor should equal flat_dim now; if not, layouts disagreed.
    if cursor != flat_dim:
        raise ValueError(
            f"reconstruction cursor {cursor} != flat_dim {flat_dim} — layout mismatch"
        )

    # 5) Persist if requested.
    out_path = None
    if output_path:
        with open(output_path, "wb") as fh:
            pickle.dump(rebuilt, fh)
        out_path = output_path

    # 6) Diagnostic norms (used today by coord 0.8.71).
    avg_norm = float(torch.linalg.vector_norm(agg_flat).item()) if agg_flat.numel() else 0.0
    # velocityNorm: per-peer norm averaged. Coord uses this as a proxy
    # for "how much did the aggregated update push the model". Today
    # the simplest definition is just `avgGradientNorm`. Keeping a
    # separate field for future divergence (e.g. momentum-aware).
    velocity_norm = avg_norm

    return {
        "participatingNodes": len(normalized),
        "avgGradientNorm": avg_norm,
        "velocityNorm": velocity_norm,
        "perPeerCosine": per_peer_cosine,
        "outputPath": out_path,
    }


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "empty stdin"}))
        return 1
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON: {e}"}))
        return 1

    peers = config.get("peers") or []
    output_path = config.get("outputPath")
    try:
        result = average_gradients(peers, output_path=output_path)
    except Exception as e:  # noqa: BLE001 — surface aggregator-level failures verbatim
        print(json.dumps({"error": str(e), "errorType": type(e).__name__}))
        return 1

    # Normalize NaN to JSON's `NaN` token explicitly via allow_nan=True
    # (default). Coord parses with `JSON.parse` which rejects bare NaN —
    # we emit it as a string sentinel so coord can detect.
    serializable = dict(result)
    serializable["perPeerCosine"] = {
        pid: ("NaN" if isinstance(v, float) and math.isnan(v) else v)
        for pid, v in result["perPeerCosine"].items()
    }
    print(json.dumps(serializable))
    return 0


if __name__ == "__main__":
    sys.exit(main())
