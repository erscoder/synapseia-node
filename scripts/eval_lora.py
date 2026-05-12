#!/usr/bin/env python3
"""
LoRA adapter evaluator for biomedical models (Synapseia node-side).

Reads a JSON payload from stdin matching the LoraValidationPayload shape
exported by `lora_validator.ts`. Loads the base model + LoRA adapter,
runs a deterministic forward pass over a held-out validation set, and
writes:

  <outDir>/metrics.json

The output shape matches what `train_lora.py` writes:

  - LORA_CLASSIFICATION: {"accuracy": 0.0-1.0, "f1": 0.0-1.0}  (macro F1)
  - LORA_GENERATION:     {"perplexity": >0}

Progress lines are emitted to stdout (and ONLY progress lines — stdout
is line-by-line forwarded by the TS layer) in the form:

  progress {"step": N, "totalSteps": M, "phase": "load|eval|score"}

Errors go to stderr with the prefix `ERROR:` and a non-zero exit code.

Local invocation example:

  echo '{"adapterPath":"/abs/p/adapter_model.safetensors", \
         "validationSetPath":"/abs/p/holdout.jsonl", \
         "baseModel":"PubMedBERT","subtype":"LORA_CLASSIFICATION", \
         "peerId":"deadbeef","workOrderId":"wo-1", \
         "outDir":"/tmp/eval-out","seed":42}' \
    | python3 scripts/eval_lora.py

Stdin contract (single line JSON, then EOF):

  {
    "adapterPath": "/abs/path/to/adapter_model.safetensors",
    "validationSetPath": "/abs/path/to/holdout.jsonl",
    "baseModel": "PubMedBERT" | "BioGPT-Large",
    "subtype": "LORA_CLASSIFICATION" | "LORA_GENERATION",
    "peerId": "<hex>",
    "workOrderId": "<id>",
    "outDir": "/abs/path/where/metrics.json/goes",
    "seed": 42
  }

Determinism: fixed seed across random/numpy/torch (+ cuda), forward-only
pass under `torch.no_grad()`, deterministic algorithms enabled.

Mirrors `train_lora.py` conventions verbatim (imports, helpers, device
precedence). No new pip dependencies — every import here also appears
in the trainer.
"""
from __future__ import annotations

import json
import os
import sys
import math
import random
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _emit_progress(label: str, fields: Dict[str, Any]) -> None:
    print(f"progress {label} {json.dumps(fields)}", flush=True)


def _read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("LoRA evaluator: empty stdin payload")
    return json.loads(raw)


def _resolve_base_model(base_model: str) -> str:
    # Same mapping as `train_lora.py` — do NOT diverge; adapter weights
    # are bound to the exact base model the trainer used.
    table = {
        "PubMedBERT": "microsoft/BiomedNLP-PubMedBERT-base-uncased-abstract",
        "BioGPT-Large": "microsoft/BioGPT-Large",
    }
    if base_model not in table:
        raise SystemExit(f"Unsupported baseModel: {base_model}")
    return table[base_model]


def _detect_device(subtype: str) -> str:
    # Precedence mirrors `train_lora.py`: CUDA > MPS (classification only)
    # > CPU. LORA_GENERATION refuses MPS and CPU because BioGPT-Large is
    # too large to evaluate reliably without CUDA.
    try:
        import torch  # type: ignore
    except ImportError:
        raise SystemExit("LoRA evaluator: torch is not installed")
    if torch.cuda.is_available():
        return "cuda"
    if subtype == "LORA_CLASSIFICATION" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if subtype == "LORA_GENERATION":
        raise SystemExit("LORA_GENERATION requires CUDA; this node has no GPU")
    return "cpu"


def _set_determinism(seed: int) -> None:
    # CUDA workspace config must be set BEFORE any CUDA context is created.
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    random.seed(seed)
    try:
        import numpy as np  # type: ignore
        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch  # type: ignore
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        # warn_only=True so kernels without a deterministic impl don't crash
        # the eval — they just emit a warning. We still get reproducible
        # results for the deterministic majority of ops.
        torch.use_deterministic_algorithms(True, warn_only=True)
    except ImportError:
        pass


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"validationSetPath does not exist: {path}")
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_num, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"validation set line {line_num} is not valid JSON: {exc}")
    if len(rows) < 4:
        raise SystemExit(
            f"validation set has {len(rows)} examples; need at least 4 for statistically meaningful metrics"
        )
    return rows


def _macro_f1(labels, preds) -> float:
    # Same hand-rolled macro F1 as `train_lora.py` — no sklearn dep.
    if labels is None:
        return 0.0
    import numpy as np  # type: ignore
    classes = np.unique(labels)
    f1s: List[float] = []
    for c in classes:
        tp = float(((preds == c) & (labels == c)).sum())
        fp = float(((preds == c) & (labels != c)).sum())
        fn = float(((preds != c) & (labels == c)).sum())
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0)
    return float(sum(f1s) / len(f1s)) if f1s else 0.0


def _eval_classification(
    model, tokenizer, rows: List[Dict[str, Any]], device: str
) -> Dict[str, float]:
    import torch  # type: ignore
    import numpy as np  # type: ignore

    batch_size = 8
    total = len(rows)
    all_preds: List[int] = []
    all_labels: List[int] = []

    for start in range(0, total, batch_size):
        batch = rows[start:start + batch_size]
        texts = [row["text"] for row in batch]
        labels = [int(row["label"]) for row in batch]
        enc = tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        enc = {k: v.to(device) for k, v in enc.items()}
        with torch.no_grad():
            out = model(**enc)
        logits = out.logits.detach().cpu().numpy()
        preds = logits.argmax(axis=-1).tolist()
        all_preds.extend(preds)
        all_labels.extend(labels)
        _emit_progress("eval", {
            "step": min(start + batch_size, total),
            "totalSteps": total,
            "phase": "eval",
        })

    preds_arr = np.array(all_preds)
    labels_arr = np.array(all_labels)
    accuracy = float((preds_arr == labels_arr).mean()) if len(labels_arr) > 0 else 0.0
    f1 = _macro_f1(labels_arr, preds_arr)
    _emit_progress("score", {"phase": "score", "accuracy": accuracy, "f1": f1})
    return {"accuracy": accuracy, "f1": f1}


def _eval_generation(
    model, tokenizer, rows: List[Dict[str, Any]], device: str
) -> Dict[str, float]:
    # Perplexity = exp(sum(token_nll) / sum(num_tokens)) over the held-out
    # corpus. We use the standard "shift labels = input_ids" pattern so
    # `model(...).loss` is the mean NLL per token in the batch; multiplying
    # by the token count recovers a sum for cross-batch aggregation.
    import torch  # type: ignore

    total = len(rows)
    total_nll = 0.0
    total_tokens = 0

    for idx, row in enumerate(rows):
        text = row.get("text", "")
        completion = row.get("completion", "")
        full = f"{text}{completion}" if completion else text
        enc = tokenizer(
            full,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        )
        input_ids = enc["input_ids"].to(device)
        # Skip degenerate single-token rows — loss requires shift >= 1.
        num_tokens = int(input_ids.shape[1])
        if num_tokens < 2:
            _emit_progress("eval", {
                "step": idx + 1,
                "totalSteps": total,
                "phase": "eval",
                "skipped": True,
            })
            continue
        with torch.no_grad():
            out = model(input_ids=input_ids, labels=input_ids)
        # `loss` is mean NLL per shifted token: (num_tokens - 1) targets.
        mean_nll = float(out.loss.detach().cpu().item())
        contributing = num_tokens - 1
        total_nll += mean_nll * contributing
        total_tokens += contributing
        _emit_progress("eval", {
            "step": idx + 1,
            "totalSteps": total,
            "phase": "eval",
        })

    if total_tokens == 0:
        raise SystemExit("generation eval produced zero scoring tokens (all rows too short)")
    mean_loss = total_nll / total_tokens
    # Same overflow guard as `train_lora.py`.
    perplexity = math.exp(mean_loss) if mean_loss < 50 else float("inf")
    _emit_progress("score", {"phase": "score", "perplexity": perplexity})
    return {"perplexity": perplexity}


def _evaluate(payload: Dict[str, Any]) -> Dict[str, float]:
    import torch  # type: ignore
    from transformers import (  # type: ignore
        AutoTokenizer,
        AutoModelForSequenceClassification,
        AutoModelForCausalLM,
    )
    from peft import PeftModel  # type: ignore

    subtype = payload["subtype"]
    base_model_name = _resolve_base_model(payload["baseModel"])
    device = _detect_device(subtype)

    adapter_path = Path(payload["adapterPath"])
    if not adapter_path.exists():
        raise SystemExit(f"adapterPath does not exist: {adapter_path}")
    # PEFT loads from the directory containing adapter_model.safetensors +
    # adapter_config.json. Accept either the file or the directory.
    adapter_dir = adapter_path if adapter_path.is_dir() else adapter_path.parent

    val_path = Path(payload["validationSetPath"])
    out_dir = Path(payload["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    _emit_progress("load", {"phase": "load", "step": 0, "totalSteps": 3})
    tokenizer = AutoTokenizer.from_pretrained(base_model_name)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    _emit_progress("load", {"phase": "load", "step": 1, "totalSteps": 3})

    if subtype == "LORA_CLASSIFICATION":
        base = AutoModelForSequenceClassification.from_pretrained(base_model_name, num_labels=2)
    else:
        base = AutoModelForCausalLM.from_pretrained(base_model_name)
    _emit_progress("load", {"phase": "load", "step": 2, "totalSteps": 3})

    # NOTE: no try/except around PeftModel.from_pretrained — let validation
    # errors propagate to the global handler (P23: wrapping libraries that
    # already raise must not swallow the exception).
    model = PeftModel.from_pretrained(base, str(adapter_dir))
    model.eval()
    model.to(device)
    _emit_progress("load", {"phase": "load", "step": 3, "totalSteps": 3})

    rows = _load_jsonl(val_path)

    if subtype == "LORA_CLASSIFICATION":
        metrics = _eval_classification(model, tokenizer, rows, device)
    else:
        metrics = _eval_generation(model, tokenizer, rows, device)

    (out_dir / "metrics.json").write_text(json.dumps(metrics))
    return metrics


def main() -> None:
    payload = _read_payload()
    seed = int(payload.get("seed", 42))
    # Determinism gates must be set BEFORE any model/CUDA context init.
    _set_determinism(seed)
    _emit_progress("start", {
        "workOrderId": payload.get("workOrderId"),
        "subtype": payload["subtype"],
        "baseModel": payload["baseModel"],
    })
    metrics = _evaluate(payload)
    _emit_progress("end", {"metrics": metrics})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit as exc:
        # SystemExit with a string message → write to stderr with ERROR:
        # prefix so the TS layer's stderr capture surfaces a clean line.
        code = exc.code
        if isinstance(code, str):
            print(f"ERROR: {code}", file=sys.stderr, flush=True)
            sys.exit(1)
        if isinstance(code, int):
            sys.exit(code)
        sys.exit(0 if code is None else 1)
    except Exception as exc:  # pragma: no cover — surfaced by TS layer
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
