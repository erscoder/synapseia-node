#!/usr/bin/env python3
"""
LoRA fine-tuning runner for biomedical models (Synapseia node-side).

Reads a JSON payload from stdin matching the LoraWorkOrderPayload shape
exported by `lora_trainer.ts`. Trains a LoRA adapter on the provided
training dataset, evaluates on the validation dataset, and writes:

  <outDir>/adapter_model.safetensors
  <outDir>/adapter_config.json
  <outDir>/metrics.json

Progress lines are emitted to stdout in the form:

  progress {"step": 12, "loss": 0.42, "lr": 5e-5}
  progress epoch_done {"epoch": 1, "val_loss": 0.31}

The TS wrapper (`lora_trainer.ts`) surfaces them via the node logger.

Why a single Python script instead of a NestJS-style module:

  - HuggingFace Transformers + PEFT are Python-only.
  - The training step is the only place the node needs torch — keeping
    it isolated as a subprocess avoids loading torch into the node
    runtime, mirrors the `train_micro.py` pattern shipped earlier.

Required Python deps (installed once on the node):

  pip install transformers peft datasets safetensors torch accelerate

Hardware:

  - PubMedBERT (~110M) trains on CPU in ~4-6h, on a single 8GB GPU
    in <30 min.
  - BioGPT-Large (~1.5B) requires GPU. The TS wrapper refuses
    LORA_GENERATION on CPU-only nodes; this script also asserts CUDA
    when subtype == LORA_GENERATION, as a defence in depth.
"""
from __future__ import annotations

import json
import os
import sys
import math
from pathlib import Path
from typing import Any, Dict


def _emit_progress(label: str, fields: Dict[str, Any]) -> None:
    print(f"progress {label} {json.dumps(fields)}", flush=True)


def _read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("LoRA trainer: empty stdin payload")
    return json.loads(raw)


def _resolve_base_model(base_model: str) -> str:
    table = {
        "PubMedBERT": "microsoft/BiomedNLP-PubMedBERT-base-uncased-abstract",
        "BioGPT-Large": "microsoft/BioGPT-Large",
    }
    if base_model not in table:
        raise SystemExit(f"Unsupported baseModel: {base_model}")
    return table[base_model]


def _detect_device(subtype: str) -> str:
    try:
        import torch  # type: ignore
    except ImportError:
        raise SystemExit("LoRA trainer: torch is not installed")
    if torch.cuda.is_available():
        return "cuda"
    # Apple Silicon MPS works for PubMedBERT but not for BioGPT-Large
    # at the model sizes in question; gate it for CLASSIFICATION only.
    if subtype == "LORA_CLASSIFICATION" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if subtype == "LORA_GENERATION":
        raise SystemExit("LORA_GENERATION requires CUDA; this node has no GPU")
    return "cpu"


def _load_dataset(uri: str):
    """
    The `uri` is either a HuggingFace dataset id (no scheme) or an
    https:// URL pointing at a JSONL file (one record per line, with
    the standard `text`/`label` shape for classification or `text`
    alone for generation). For V1 we only support HF dataset ids and
    https-jsonl. The coordinator's mission corpus is exposed via a
    pre-signed download URL the WO payload can carry.
    """
    from datasets import load_dataset  # type: ignore
    if uri.startswith("https://") or uri.startswith("http://"):
        return load_dataset("json", data_files=uri, split="train")
    return load_dataset(uri, split="train")


def _peft_target_modules(default: list[str]) -> list[str]:
    return list(default) if default else ["q_proj", "v_proj"]


def _train(payload: Dict[str, Any]) -> Dict[str, Any]:
    import torch  # type: ignore
    from transformers import (  # type: ignore
        AutoTokenizer,
        AutoModelForSequenceClassification,
        AutoModelForCausalLM,
        TrainingArguments,
        Trainer,
        DataCollatorWithPadding,
    )
    from peft import LoraConfig, get_peft_model, TaskType  # type: ignore

    subtype = payload["subtype"]
    base_model_name = _resolve_base_model(payload["baseModel"])
    device = _detect_device(subtype)
    out_dir = Path(payload["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg = payload["loraConfig"]
    lora_cfg = LoraConfig(
        r=int(cfg.get("r", 8)),
        lora_alpha=int(cfg.get("alpha", 16)),
        lora_dropout=float(cfg.get("dropout", 0.1)),
        bias="none",
        target_modules=_peft_target_modules(cfg.get("target_modules", [])),
        task_type=TaskType.SEQ_CLS if subtype == "LORA_CLASSIFICATION" else TaskType.CAUSAL_LM,
    )

    tokenizer = AutoTokenizer.from_pretrained(base_model_name)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    if subtype == "LORA_CLASSIFICATION":
        model = AutoModelForSequenceClassification.from_pretrained(base_model_name, num_labels=2)
    else:
        model = AutoModelForCausalLM.from_pretrained(base_model_name)

    model = get_peft_model(model, lora_cfg)
    model.to(device)

    train_ds = _load_dataset(payload["trainingDatasetUri"])
    val_ds = _load_dataset(payload["validationDatasetUri"])

    def tokenize(batch: Dict[str, Any]) -> Dict[str, Any]:
        return tokenizer(batch["text"], padding=False, truncation=True, max_length=512)

    train_ds = train_ds.map(tokenize, batched=True)
    val_ds = val_ds.map(tokenize, batched=True)

    args = TrainingArguments(
        output_dir=str(out_dir / "trainer_state"),
        num_train_epochs=int(payload.get("maxEpochs", 3)),
        per_device_train_batch_size=8,
        per_device_eval_batch_size=8,
        learning_rate=2e-4,
        eval_strategy="epoch",
        save_strategy="no",
        logging_steps=50,
        seed=int(payload.get("seed", 42)),
        report_to=[],
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        tokenizer=tokenizer,
        data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
    )
    train_result = trainer.train()
    eval_result = trainer.evaluate()

    # Save adapter
    model.save_pretrained(out_dir, safe_serialization=True)

    metrics: Dict[str, float] = {}
    if subtype == "LORA_CLASSIFICATION":
        # Trainer.evaluate() returns eval_loss; we approximate accuracy
        # by running a fresh prediction pass. Cheap because val set is
        # small (mission corpora typically hundreds of items).
        preds = trainer.predict(val_ds)
        labels = preds.label_ids
        pred_ids = preds.predictions.argmax(axis=-1)
        accuracy = float((pred_ids == labels).mean()) if labels is not None else 0.0
        metrics = {"accuracy": accuracy, "f1": _macro_f1(labels, pred_ids)}
    else:
        # CausalLM perplexity from eval_loss.
        loss = float(eval_result.get("eval_loss", float("inf")))
        metrics = {"perplexity": math.exp(loss) if loss < 50 else float("inf")}

    (out_dir / "metrics.json").write_text(json.dumps(metrics))
    _emit_progress("done", {"metrics": metrics, "train_loss": float(train_result.training_loss)})
    return metrics


def _macro_f1(labels, preds) -> float:
    if labels is None:
        return 0.0
    import numpy as np  # type: ignore
    classes = np.unique(labels)
    f1s: list[float] = []
    for c in classes:
        tp = float(((preds == c) & (labels == c)).sum())
        fp = float(((preds == c) & (labels != c)).sum())
        fn = float(((preds != c) & (labels == c)).sum())
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0)
    return float(sum(f1s) / len(f1s)) if f1s else 0.0


def main() -> None:
    payload = _read_payload()
    _emit_progress("start", {
        "adapterId": payload["adapterId"],
        "subtype": payload["subtype"],
        "baseModel": payload["baseModel"],
    })
    metrics = _train(payload)
    _emit_progress("end", {"metrics": metrics})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover — surfaced by TS layer
        print(f"error: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
