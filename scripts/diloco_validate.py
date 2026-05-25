#!/usr/bin/env python3
"""
DiLoCo B-validator (node-side, Phase 4B).

For each candidate peer in a DiLoCo outer round, compute a GENUINE
held-out validation loss measuring that peer's INDIVIDUAL delta quality
in ISOLATION: load the base foundation model, apply ONLY that peer's
raw pseudo-gradient on top of the previous round's adapter (no momentum,
no stake-weighting, no averaging across peers), run a REAL forward pass
over the held-out batches, and report the mean cross-entropy. The model
is restored between peers so peer i never sees peer i-1's delta. This is
per-peer-in-isolation by design — it is NOT a re-score of the
aggregator's stake-weighted + Nesterov merged update; it is the per-peer
quality signal that feeds the Phase-5 blend-ranking. It is also NOT the
synthetic `val_loss = train_loss * 1.05` heuristic `diloco_train.py`
emits during training — it is an independent forward pass on data the
trainer never saw.

Reads config from stdin as JSON (paths are produced + sandboxed by
`diloco_validation_runner.ts`):

    {
      "modelId":        "Qwen/Qwen2.5-7B",
      "prevAdapterPath": "/sandbox/prev_adapter.pkl" | null,   # round-N-1 adapter, null on round 0
      "valSetPath":     "/sandbox/val_set.jsonl",              # held-out text, one sample per line
      "peers": [
        {"peerId": "<id>", "gradientPath": "/sandbox/grad_<i>.pt"},
        ...
      ],
      "outputPath":     "/sandbox/val_result.json",            # optional; result is ALSO printed
      "maxValSamples":  256,                                   # optional cap (default 256)
      "maxSeqLen":      512                                    # optional (default 512)
    }

Each `gradientPath` is a pickle of `{tensorName: pseudo-gradient}` in the
SAME shape `diloco_train.py` produces — raw `{name: Tensor}` OR an SVD
bundle `{name: {U,S,V,shape}}` OR the `{name: {raw,shape}}` fallback. The
loaders below MIRROR `diloco_aggregate.py` (`_decompress_if_svd`,
`_as_f32_tensor`) so the validator and the aggregator decode identical
bytes identically.

Output JSON on stdout (single line):

    {"perPeerValLoss": {"<peerId>": <float rounded 4dp> | "NaN", ...}}

Per-peer failure handling (P22): ANY exception while evaluating ONE peer
(bad gradient shape, NaN loss, shape mismatch against the adapter, OOM on
that peer) maps that peer to the LITERAL STRING "NaN" and logs a warning
to stderr — the rest of the peers still get a genuine number. A bare
JSON `NaN` is INVALID JSON that the TS `JSON.parse` would reject, so we
ALWAYS emit the quoted `"NaN"` string (mirrors `diloco_aggregate.py`'s
cosine NaN sentinel).

CPU-pinned + float32 throughout: the validator runs on the same CPU path
the aggregator uses, never constructs a CUDA tensor (the runner also sets
`CUDA_VISIBLE_DEVICES=''`). A genuine, deterministic, side-effect-free
forward pass — model weights are restored between peers so peer i never
sees peer i-1's delta.
"""

import sys
import os
import json
import math
import pickle
from typing import Any, Dict, List, Optional

DEFAULT_MAX_VAL_SAMPLES = 256
DEFAULT_MAX_SEQ_LEN = 512


def _warn(msg: str) -> None:
    """Diagnostic to stderr (stdout is reserved for the single JSON result line)."""
    sys.stderr.write(f"[diloco-validate] {msg}\n")
    sys.stderr.flush()


# ── Pseudo-gradient decode (MIRRORS diloco_aggregate.py exactly) ─────────────

def _as_f32_tensor(value: Any):
    """Coerce a gradient component (list / ndarray / Tensor) to float32 tensor.

    `diloco_train.py::compress_gradients_svd` persists U/S/V/raw via
    `.tolist()`, so components arrive as nested Python lists. `torch.as_tensor`
    accepts list / ndarray / Tensor uniformly. Identical to the aggregator's
    coercion so both decode the same bytes the same way."""
    import torch

    if isinstance(value, torch.Tensor):
        return value.to(dtype=torch.float32)
    return torch.as_tensor(value, dtype=torch.float32)


def _decompress_if_svd(name: str, value: Any):
    """Reconstruct the dense pseudo-gradient tensor for `name`.

    Accepts the three on-disk shapes `diloco_train.py` emits — the SVD bundle
    `{U,S,V,shape}`, the `{raw,shape}` non-SVD fallback, and a bare tensor —
    byte-for-byte mirroring `diloco_aggregate.py::_decompress_if_svd` (NO
    transpose on V: the training side stores `Vh[:k,:]` already, so
    `(U * S) @ V` reconstructs directly)."""
    import torch

    if isinstance(value, dict) and {"U", "S", "V", "shape"}.issubset(value.keys()):
        U = _as_f32_tensor(value["U"])
        S = _as_f32_tensor(value["S"])
        V = _as_f32_tensor(value["V"])
        shape = value["shape"]
        dense = (U * S.unsqueeze(0)) @ V
        return dense.reshape(shape)
    if isinstance(value, dict) and {"raw", "shape"}.issubset(value.keys()):
        return _as_f32_tensor(value["raw"]).reshape(value["shape"])
    if isinstance(value, torch.Tensor):
        return value.to(dtype=torch.float32)
    raise ValueError(f"unsupported gradient entry shape for tensor {name!r}: {type(value)}")


def _load_gradient_bundle(path: str) -> Dict[str, Any]:
    with open(path, "rb") as fh:
        bundle = pickle.load(fh)
    if not isinstance(bundle, dict):
        raise ValueError(f"gradient file {path} did not contain a dict")
    return bundle


# ── Model / snapshot resolution (MIRRORS diloco_train.py) ────────────────────

def _resolve_local_snapshot(model_id: str) -> str:
    """Resolve the local snapshot path from the install-deps marker.

    Fail-fast (RuntimeError) when no valid marker exists — DiLoCo runtime is
    local-only by design and MUST NOT attempt any HF Hub round-trip (P2
    fail-closed). Mirrors `diloco_train.py::_resolve_local_snapshot`."""
    base = os.environ.get("SYNAPSEIA_HOME")
    if base:
        marker_path = os.path.join(base, "diloco-model-ok")
    else:
        marker_path = os.path.join(os.path.expanduser("~"), ".synapseia", "diloco-model-ok")

    hint = (
        f"DiLoCo model '{model_id}' not cached locally. "
        f"Run `syn install-deps` to pre-download the foundation model. "
        f"(Looked for marker at {marker_path})"
    )
    if not os.path.exists(marker_path):
        raise RuntimeError(hint)
    try:
        with open(marker_path, "r", encoding="utf-8") as f:
            marker = json.load(f)
    except Exception as e:
        raise RuntimeError(f"{hint} — marker exists but is unreadable: {e}")
    if not isinstance(marker, dict):
        raise RuntimeError(f"{hint} — marker is not a JSON object")
    if marker.get("modelId") != model_id:
        raise RuntimeError(
            f"{hint} — marker is for modelId={marker.get('modelId')!r}, requested {model_id!r}"
        )
    cache_dir = marker.get("cacheDir")
    if not isinstance(cache_dir, str) or not os.path.exists(cache_dir):
        raise RuntimeError(
            f"{hint} — marker points to cacheDir={cache_dir!r} which does not exist on disk"
        )
    return cache_dir


def _build_lora_model(pretrained_name: str, prev_adapter_path: Optional[str]):
    """Load base model on CPU/fp32 + attach a trainable LoRA adapter.

    When `prev_adapter_path` points to a peft adapter directory we load it;
    otherwise (round 0 cold-start, or a pickled pseudo-gradient snapshot
    without a peft dir) we create a fresh LoRA adapter with the SAME config
    `diloco_train.py` uses so the parameter names match the pseudo-gradient
    keys. Returns `(model, tokenizer)`."""
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, PeftModel

    load_kwargs = {"local_files_only": True, "use_safetensors": True}
    # transformers 5.x renamed torch_dtype → dtype; mirror diloco_train.py.
    try:
        base_model = AutoModelForCausalLM.from_pretrained(
            pretrained_name, dtype=torch.float32, **load_kwargs
        )
    except (TypeError, ValueError):
        base_model = AutoModelForCausalLM.from_pretrained(
            pretrained_name, torch_dtype=torch.float32, **load_kwargs
        )
    base_model = base_model.to("cpu")

    # A peft adapter dir has adapter_config.json; a pickled pseudo-gradient
    # snapshot does not. Only PeftModel.from_pretrained on a real adapter dir.
    if (
        prev_adapter_path
        and os.path.isdir(prev_adapter_path)
        and os.path.exists(os.path.join(prev_adapter_path, "adapter_config.json"))
    ):
        model = PeftModel.from_pretrained(
            base_model, prev_adapter_path, is_trainable=True, use_safetensors=True
        )
    else:
        lora_config = LoraConfig(
            r=16,
            lora_alpha=32,
            target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(base_model, lora_config)

    # use_cache is incompatible with a clean eval-grad-free forward on some
    # configs; force off to match the training path and avoid KV-cache surprises.
    if hasattr(model, "config") and getattr(model.config, "use_cache", False):
        model.config.use_cache = False
    base_cfg = getattr(getattr(model, "base_model", None), "config", None)
    if base_cfg is not None and getattr(base_cfg, "use_cache", False):
        base_cfg.use_cache = False

    tokenizer = AutoTokenizer.from_pretrained(pretrained_name, **load_kwargs)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    return model, tokenizer


def _load_val_texts(path: str, max_samples: int) -> List[str]:
    """Load held-out text samples — one per line. Accepts plain lines OR
    JSONL objects with a "text"/"content"/"prompt" field (best-effort)."""
    texts: List[str] = []
    if not path or not os.path.exists(path):
        raise ValueError(f"validation set not found at {path}")
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            if s[0] == "{":
                try:
                    obj = json.loads(s)
                    if isinstance(obj, dict):
                        s = str(obj.get("text") or obj.get("content") or obj.get("prompt") or "")
                except json.JSONDecodeError:
                    pass  # treat as raw text
            if s:
                texts.append(s)
            if len(texts) >= max_samples:
                break
    if not texts:
        raise ValueError(f"validation set {path} produced 0 usable samples")
    return texts


def _capture_lora_params(model):
    """Snapshot the trainable LoRA params keyed by name (clones, so applying
    a delta then restoring is exact)."""
    snap = {}
    for name, param in model.named_parameters():
        if param.requires_grad:
            snap[name] = param.data.clone()
    return snap


def _apply_pseudo_gradient(model, bundle: Dict[str, Any]) -> int:
    """Add the peer's pseudo-gradient deltas onto the matching LoRA params.

    Returns the number of params actually updated. A pseudo-gradient key that
    does not match any trainable param is skipped (logged) — the trainer and
    validator share the LoRA config so names line up, but be liberal (P2)."""
    import torch

    decoded: Dict[str, Any] = {}
    for k in bundle.keys():
        decoded[k] = _decompress_if_svd(k, bundle[k])

    applied = 0
    with torch.no_grad():
        for name, param in model.named_parameters():
            if not param.requires_grad:
                continue
            delta = decoded.get(name)
            if delta is None:
                continue
            d = delta.to(dtype=param.dtype, device=param.device).reshape(param.shape)
            param.data.add_(d)
            applied += 1
    if applied == 0:
        raise ValueError(
            "pseudo-gradient matched 0 trainable LoRA params (name/shape mismatch)"
        )
    return applied


def _restore_lora_params(model, snapshot: Dict[str, Any]) -> None:
    import torch

    with torch.no_grad():
        for name, param in model.named_parameters():
            if name in snapshot:
                param.data.copy_(snapshot[name])


def _mean_cross_entropy(model, tokenizer, texts: List[str], max_seq_len: int) -> float:
    """Genuine held-out mean cross-entropy over `texts` (CPU, no grad).

    Tokenizes with padding/truncation, masks pad tokens to -100 so they don't
    contribute to the loss (mirrors `diloco_train.py`'s labels masking), and
    averages the per-batch model loss. Raises if the result is non-finite so
    the caller maps the peer to "NaN" (P22)."""
    import torch

    model.eval()
    enc = tokenizer(
        texts,
        truncation=True,
        padding="max_length",
        max_length=max_seq_len,
        return_tensors="pt",
    )
    input_ids = enc["input_ids"]
    attention_mask = enc.get("attention_mask")
    n = input_ids.shape[0]
    batch_size = 4
    total_loss = 0.0
    batches = 0
    with torch.no_grad():
        for start in range(0, n, batch_size):
            ids = input_ids[start : start + batch_size]
            labels = ids.clone()
            labels[labels == tokenizer.pad_token_id] = -100
            kwargs = {"input_ids": ids, "labels": labels}
            if attention_mask is not None:
                kwargs["attention_mask"] = attention_mask[start : start + batch_size]
            out = model(**kwargs)
            loss = float(out.loss.item())
            if not math.isfinite(loss):
                raise ValueError(f"non-finite loss on batch {batches}")
            total_loss += loss
            batches += 1
    if batches == 0:
        raise ValueError("no batches evaluated")
    mean = total_loss / batches
    if not math.isfinite(mean):
        raise ValueError("non-finite mean loss")
    return mean


def validate_peers(config: Dict[str, Any]) -> Dict[str, Any]:
    """Compute a genuine per-peer held-out valLoss. Per-peer failures map to
    the literal "NaN" string (P22) and never abort the whole job."""
    model_id = config.get("modelId", "Qwen/Qwen2.5-7B")
    prev_adapter_path = config.get("prevAdapterPath")
    val_set_path = config.get("valSetPath", "")
    peers = config.get("peers") or []
    max_val_samples = int(config.get("maxValSamples", DEFAULT_MAX_VAL_SAMPLES))
    max_seq_len = int(config.get("maxSeqLen", DEFAULT_MAX_SEQ_LEN))

    per_peer_val_loss: Dict[str, Any] = {}
    if not peers:
        return {"perPeerValLoss": per_peer_val_loss}

    # Resolve + load ONCE; reused across peers (apply delta → eval → restore).
    pretrained_name = _resolve_local_snapshot(model_id)
    model, tokenizer = _build_lora_model(pretrained_name, prev_adapter_path)
    texts = _load_val_texts(val_set_path, max_val_samples)
    baseline = _capture_lora_params(model)

    for entry in peers:
        peer_id = str(entry.get("peerId"))
        grad_path = str(entry.get("gradientPath", ""))
        try:
            bundle = _load_gradient_bundle(grad_path)
            _apply_pseudo_gradient(model, bundle)
            loss = _mean_cross_entropy(model, tokenizer, texts, max_seq_len)
            per_peer_val_loss[peer_id] = round(float(loss), 4)
        except Exception as e:  # noqa: BLE001 — P22: one peer failing never kills the rest
            _warn(f"peer {peer_id} eval failed: {type(e).__name__}: {e}")
            per_peer_val_loss[peer_id] = "NaN"
        finally:
            # Restore so the next peer evaluates against the SAME prev-adapter
            # baseline (peer i never sees peer i-1's delta).
            _restore_lora_params(model, baseline)

    return {"perPeerValLoss": per_peer_val_loss}


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

    try:
        result = validate_peers(config)
    except Exception as e:  # noqa: BLE001 — job-level failure surfaced verbatim
        print(json.dumps({"error": str(e), "errorType": type(e).__name__}))
        return 1

    # `perPeerValLoss` values are already either a Python float (round-tripped
    # cleanly by json) or the literal "NaN" STRING — never a bare float NaN
    # (which would emit invalid JSON the TS JSON.parse rejects). Defensive
    # double-check mirrors diloco_aggregate.py's sentinel emission.
    serializable = {"perPeerValLoss": {}}
    for pid, v in result["perPeerValLoss"].items():
        if isinstance(v, float) and math.isnan(v):
            serializable["perPeerValLoss"][pid] = "NaN"
        else:
            serializable["perPeerValLoss"][pid] = v

    out_path = config.get("outputPath")
    if out_path:
        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump(serializable, fh)
        except OSError as e:
            _warn(f"could not write outputPath {out_path}: {e}")

    print(json.dumps(serializable))
    return 0


if __name__ == "__main__":
    sys.exit(main())
