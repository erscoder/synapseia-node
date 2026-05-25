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
import gc
import inspect
from pathlib import Path
from typing import Any, Dict, Mapping


def _trainer_tokenizer_kwarg(trainer_init_params: Mapping[str, Any], tokenizer: Any) -> Dict[str, Any]:
    """Pick the version-correct keyword for handing a tokenizer to a
    HuggingFace ``Trainer``.

    transformers 4.57+/5.x renamed the ``tokenizer=`` constructor argument to
    ``processing_class=`` and REMOVED ``tokenizer`` entirely — passing it now
    raises ``TypeError: __init__() got an unexpected keyword argument
    'tokenizer'`` (caught by main()'s top-level handler → exit 2, right after
    the dataset Map step). Older 4.x still expects ``tokenizer``.

    We inspect the real ``Trainer.__init__`` signature at runtime instead of
    sniffing the transformers version string, so this stays correct across the
    rename regardless of how the pod venv was pinned.

    PURE on purpose (no torch/transformers import) so it is unit-testable on a
    CI runner without the heavy deps — mirror of `_build_training_kwargs`.
    """
    if "processing_class" in trainer_init_params:
        return {"processing_class": tokenizer}
    return {"tokenizer": tokenizer}


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


# ── Objective routing (encoder-MLM vs decoder-CausalLM vs SeqCls) ────────────
#
# Bug (live, both GPU pods, 2026-05-25, repeating every dispatch of the
# `pubmedbert_v15` mission):
#
#   LoRA training failed [python] python3 train_lora.py exited with code 2:
#   If you want to use `BertLMHeadModel` as a standalone, add `is_decoder=True.`
#
# Root cause: the old model-class selection only branched on `subtype`:
#   LORA_CLASSIFICATION → AutoModelForSequenceClassification + SEQ_CLS
#   else (incl. LORA_GENERATION) → AutoModelForCausalLM + CAUSAL_LM
# `pubmedbert_v15` arrives as subtype LORA_GENERATION (the only non-CLS
# subtype the coordinator/TS wrapper knows), but its base model
# (microsoft/BiomedNLP-PubMedBERT-…) is an ENCODER-ONLY masked-LM BERT.
# `AutoModelForCausalLM.from_pretrained` on a BERT builds `BertLMHeadModel`
# WITHOUT `config.is_decoder=True` → transformers raises → exit 2. CausalLM is
# simply the wrong objective for an MLM encoder.
#
# Fix (operator decision): inspect the model CONFIG once up front and route
# encoder/masked-LM families to a third, MaskedLM objective — WITHOUT adding a
# new subtype (the TS wrapper / coordinator only know CLASSIFICATION /
# GENERATION). Detection is `model_type`-based against a documented allowlist
# of encoder families, with an architectures fallback, so it is robust to the
# exact model name. SeqCls remains keyed on the subtype.

# Encoder / masked-LM base families that must train with a MaskedLM head (NOT
# CausalLM). `config.model_type` is the HF-canonical, name-independent key.
# Conservative + documented: only well-known BERT-style encoders. Anything not
# here (gpt2, llama, mistral, biogpt, opt, gptj, falcon, …) stays on CausalLM.
_ENCODER_MLM_MODEL_TYPES = frozenset({
    "bert",
    "roberta",
    "xlm-roberta",
    "distilbert",
    "deberta",
    "deberta-v2",
    "electra",
    "albert",
    "camembert",
    "mpnet",
    "bigbird",
    "longformer",
})


def select_objective(config: Any, subtype: str) -> str:
    """Decide the training objective for a base model + subtype. PURE — takes a
    transformers-style config object (anything exposing `model_type`,
    `is_decoder`, `is_encoder_decoder`, `architectures`) so it is unit-testable
    with lightweight fakes (no model download / no torch).

    Returns one of: "SEQ_CLS" | "MLM" | "CAUSAL".

    Predicate (first match wins):
      1. subtype == LORA_CLASSIFICATION → "SEQ_CLS" (unchanged, regardless of
         the base architecture — a SequenceClassification head is valid on both
         encoders and decoders).
      2. else, if the config indicates a genuine DECODER
         (`is_decoder` truthy, or `is_encoder_decoder` truthy, or `model_type`
         is NOT in the encoder allowlist while its architectures look causal)
         → "CAUSAL".
      3. else, if `model_type` is in the encoder/masked-LM allowlist, OR the
         declared `architectures` contain a BERT-style `*ForMaskedLM` / bare
         `*Model` entry and NOT a `*ForCausalLM`/decoder arch → "MLM".
      4. genuinely ambiguous → default CAUSAL (the historical behaviour for
         every non-classification mission, so unknown decoder families keep
         working). Known BERT families are caught in (3) before reaching here.
    """
    if subtype == "LORA_CLASSIFICATION":
        return "SEQ_CLS"

    model_type = (getattr(config, "model_type", "") or "").lower()
    is_decoder = bool(getattr(config, "is_decoder", False))
    is_enc_dec = bool(getattr(config, "is_encoder_decoder", False))
    architectures = list(getattr(config, "architectures", None) or [])
    archs_lower = [a.lower() for a in architectures]
    has_causal_arch = any(
        a.endswith("forcausallm") or a.endswith("lmheadmodel") for a in archs_lower
    )
    has_masked_arch = any(a.endswith("formaskedlm") for a in archs_lower)

    # (2) Genuine decoder → CausalLM (unchanged historical path).
    if is_decoder or is_enc_dec:
        return "CAUSAL"
    # A clearly causal architecture wins even if model_type is unknown.
    if has_causal_arch and not has_masked_arch:
        return "CAUSAL"

    # (3) Encoder / masked-LM family → MaskedLM. model_type allowlist first
    # (name-independent), architectures inspection as the fallback.
    if model_type in _ENCODER_MLM_MODEL_TYPES:
        return "MLM"
    if has_masked_arch and not has_causal_arch:
        return "MLM"
    # A bare `*Model` (e.g. "BertModel") with no causal arch is encoder-style.
    if archs_lower and all(a.endswith("model") for a in archs_lower) and not has_causal_arch:
        return "MLM"

    # (4) Ambiguous → preserve historical CausalLM default.
    return "CAUSAL"


def _mlm_probability(cfg: Mapping[str, Any]) -> float:
    """Masked-token probability for DataCollatorForLanguageModeling(mlm=True).
    PURE. Honours an optional `mlm_probability` in loraConfig; defaults to the
    standard BERT 0.15. Clamped to the open interval (0, 1)."""
    try:
        p = float(cfg.get("mlm_probability", 0.15))
    except (TypeError, ValueError):
        p = 0.15
    if not (0.0 < p < 1.0):
        p = 0.15
    return p


# ── Memory configuration (subtype-aware) ─────────────────────────────────────
#
# Bug (live, both A5000 pods, 24 GB each, 2026-05-23):
#   subtype=LORA_GENERATION on BioGPT-Large (~1.5B params, causal LM) OOMs at
#   training step 0 — "CUDA out of memory. Tried to allocate 902 MiB. GPU 0
#   has total 23.56 GiB, 847 MiB free, this process 22.72 GiB in use". The GPU
#   is empty before the run (4 MiB used) so this is NOT contention — the old
#   GENERATION config genuinely needed > 24 GB.
#
# Root cause (the previous `_train` hardcoded these for BOTH subtypes):
#   - per_device_train_batch_size = 8  → 8 concurrent fwd/bwd activation sets
#     over 512-token sequences on a generative LM head (vocab-sized logits per
#     position) is the dominant activation cost for a 1.5B causal model.
#   - NO mixed precision → weights + activations + gradients materialize in
#     fp32. AdamW also keeps two fp32 optimizer-state tensors per trainable
#     param. Even though LoRA freezes the base, the fp32 activation graph over
#     batch=8 × seq=512 × |vocab| is what blows the budget.
#   - NO gradient_checkpointing → every layer's activations are retained for
#     the backward pass instead of being recomputed.
#   - max_length = 512 → long generative sequences amplify all of the above.
#
# CONTRAST: LORA_CLASSIFICATION on the same BioGPT-Large fits and uploads an
# adapter — an encoder-style 2-logit head over 512 tokens has a tiny output
# projection vs. the full causal LM head, so batch=8/fp32 stays under 24 GB.
#
# Fix levers (least-invasive, NO new dependency — bitsandbytes/QLoRA NOT used;
# we deliberately avoid the 4-bit path so this can't regress classification or
# depend on bnb being importable at training time):
#   1. gradient_checkpointing=True for GENERATION (trade compute for memory).
#   2. per_device_train_batch_size=1 + gradient_accumulation_steps=8 for
#      GENERATION → same effective batch (8) as before, ~8× less activation
#      memory at any instant.
#   3. bf16 mixed precision when the CUDA device supports it (A5000 / Ampere
#      does). Falls back to fp16 on older CUDA GPUs, and to fp32 on CPU/MPS
#      (where bf16/fp16 autocast is unreliable / unsupported) — classification
#      keeps working unchanged on those backends.
#   4. max_seq_length capped at 256 for GENERATION (down from 512). Mission
#      generative corpora are short; 256 is a sane cap that halves the
#      activation footprint.
#
# CLASSIFICATION is intentionally left at its proven config (batch=8, no
# gradient checkpointing, seq=512, fp32 on CPU/MPS) so the working path does
# not regress; it only opts into bf16/fp16 when running on a capable CUDA GPU,
# which is a free win and never enabled on the CPU/MPS backends it normally
# uses.
#
# All helpers below are PURE (no torch import) so they are unit-testable on a
# CI runner without CUDA / torch installed.

# Effective batch size kept constant across subtypes so learning dynamics are
# unchanged: GENERATION uses batch=1 × accum=8, CLASSIFICATION uses batch=8 ×
# accum=1. Both = 8.
_EFFECTIVE_TRAIN_BATCH = 8

# Per-subtype tokenizer truncation cap. GENERATION is capped lower (256) to
# bound the causal-LM activation footprint that caused the 24 GB OOM;
# CLASSIFICATION keeps its proven 512.
_MAX_SEQ_LENGTH = {
    "LORA_CLASSIFICATION": 512,
    "LORA_GENERATION": 256,
}


def _max_seq_length(subtype: str) -> int:
    """Tokenizer truncation length per subtype. PURE (no torch)."""
    return _MAX_SEQ_LENGTH.get(subtype, 512)


def _precision_flags(subtype: str, device: str, bf16_supported: bool) -> Dict[str, bool]:
    """
    Decide mixed-precision flags for `TrainingArguments`. PURE (no torch) —
    `bf16_supported` is probed by the caller and injected so this stays
    unit-testable without a GPU.

    - CUDA + bf16-capable (A5000 / Ampere+)  → bf16=True  (best: no loss
      scaling, full dynamic range).
    - CUDA without bf16 (older GPUs)         → fp16=True  (half the memory of
      fp32; needs the Trainer's built-in grad scaler).
    - CPU / MPS                              → fp32 (both False). bf16/fp16
      autocast is unreliable/unsupported there; CLASSIFICATION runs here today
      and MUST stay on its working fp32 path.
    """
    if device != "cuda":
        return {"bf16": False, "fp16": False}
    if bf16_supported:
        return {"bf16": True, "fp16": False}
    return {"bf16": False, "fp16": True}


def _build_training_kwargs(
    subtype: str, device: str, bf16_supported: bool
) -> Dict[str, Any]:
    """
    Build the subtype-aware memory knobs for `TrainingArguments`. PURE (no
    torch) so it is unit-testable on a CI runner without CUDA. The caller
    merges the result into the full `TrainingArguments(...)` call.

    GENERATION (BioGPT-Large causal LM) — the path that OOMed on 24 GB:
        per_device_train_batch_size = 1
        gradient_accumulation_steps = 8        (effective batch unchanged = 8)
        gradient_checkpointing      = True
        + bf16/fp16 per `_precision_flags`

    CLASSIFICATION — the proven, working path. Left unchanged on memory knobs
    (batch=8, accum=1, no gradient checkpointing); only opts into bf16/fp16
    when on a capable CUDA GPU (free win, never enabled on its usual CPU/MPS).
    """
    precision = _precision_flags(subtype, device, bf16_supported)
    if subtype == "LORA_GENERATION":
        return {
            "per_device_train_batch_size": 1,
            "per_device_eval_batch_size": 1,
            "gradient_accumulation_steps": _EFFECTIVE_TRAIN_BATCH,  # → eff. batch 8
            "gradient_checkpointing": True,
            # Non-reentrant checkpointing is the recommended path for PEFT +
            # frozen base: it composes correctly with the input-require-grads
            # hook set in `_train` and avoids the reentrant-autograd warning
            # newer transformers emit.
            "gradient_checkpointing_kwargs": {"use_reentrant": False},
            **precision,
        }
    # LORA_CLASSIFICATION (and any future encoder subtype): proven config.
    return {
        "per_device_train_batch_size": _EFFECTIVE_TRAIN_BATCH,
        "per_device_eval_batch_size": _EFFECTIVE_TRAIN_BATCH,
        "gradient_accumulation_steps": 1,
        "gradient_checkpointing": False,
        **precision,
    }


# ── Data collator + tokenized columns (subtype-aware) ────────────────────────
#
# Bug (live, 2026-05-23): subtype=LORA_GENERATION failed at the FIRST training
# step with `RuntimeError: Expected input batch_size (256) to match target
# batch_size (1)`. The generation path reused the CLASSIFICATION data setup:
#
#   - `tokenize()` returns only input_ids / attention_mask (no `labels`).
#   - The collator was `DataCollatorWithPadding` for BOTH subtypes.
#
# For CLASSIFICATION that is correct: the dataset's scalar `label` column is the
# target, and DataCollatorWithPadding passes it straight through as `labels`.
# For GENERATION (AutoModelForCausalLM) the model needs `labels = input_ids`
# (next-token loss), but DataCollatorWithPadding does NOT build them — it instead
# forwards the classification scalar `label`, so the loss saw input [B, seq=256]
# vs target [1] → the batch_size mismatch.
#
# Fix (GENERATION only; CLASSIFICATION left exactly as is):
#   1. Use `DataCollatorForLanguageModeling(tokenizer, mlm=False)` for GENERATION.
#      It derives `labels` from `input_ids` (causal LM), so target shape becomes
#      [B, seq] and matches the input — the mismatch is gone.
#   2. Drop the original dataset columns (`text` and, if present, `label`) after
#      tokenization for GENERATION so no stray classification `label` reaches the
#      collator/model. CLASSIFICATION KEEPS its `label` column intact (it is the
#      target there).
#
# Both helpers are PURE: `_columns_to_remove` takes no torch; `_build_data_collator`
# takes the collator CLASSES injected by the caller (mirror of `_precision_flags`
# injecting `bf16_supported`) so it is unit-testable without transformers.


def _build_data_collator(
    objective: str, tokenizer: Any, *, padding_cls: Any, lm_cls: Any, mlm_probability: float = 0.15
) -> Any:
    """Select the version-correct data collator for the training OBJECTIVE.
    PURE — the two collator classes are injected so this is unit-testable
    without transformers.

    - CAUSAL  → DataCollatorForLanguageModeling(mlm=False): derives `labels`
      from `input_ids` (next-token loss), fixing the batch_size mismatch.
    - MLM     → DataCollatorForLanguageModeling(mlm=True, mlm_probability=…):
      masks tokens and builds `labels` as the masked-token targets. Feeding
      `labels = input_ids` (the causal trick) is WRONG for MLM.
    - SEQ_CLS (+default) → DataCollatorWithPadding: the proven path, passes the
      scalar `label` column through as the target.
    """
    if objective == "CAUSAL":
        return lm_cls(tokenizer=tokenizer, mlm=False)
    if objective == "MLM":
        return lm_cls(tokenizer=tokenizer, mlm=True, mlm_probability=mlm_probability)
    return padding_cls(tokenizer=tokenizer)


def _columns_to_remove(subtype: str, dataset_columns: list[str]) -> list[str]:
    """Columns to strip from the tokenized dataset via `.map(remove_columns=...)`.
    PURE (no torch).

    GENERATION: drop the original columns (`text`, and `label` if present) so the
    LM collator builds `labels` from `input_ids` with nothing stale interfering.
    CLASSIFICATION: keep everything (its scalar `label` is the target) → [].
    """
    if subtype != "LORA_GENERATION":
        return []
    return [c for c in dataset_columns if c in ("text", "label")]


def _train(payload: Dict[str, Any]) -> Dict[str, Any]:
    import torch  # type: ignore
    from transformers import (  # type: ignore
        AutoConfig,
        AutoTokenizer,
        AutoModelForSequenceClassification,
        AutoModelForCausalLM,
        AutoModelForMaskedLM,
        TrainingArguments,
        Trainer,
        DataCollatorWithPadding,
        DataCollatorForLanguageModeling,
    )
    from peft import LoraConfig, get_peft_model, TaskType  # type: ignore

    subtype = payload["subtype"]
    base_model_name = _resolve_base_model(payload["baseModel"])
    device = _detect_device(subtype)
    out_dir = Path(payload["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    # Bug fix (2026-05-25 — `BertLMHeadModel` / is_decoder exit-2 on the
    # `pubmedbert_v15` mission): load the base CONFIG once up front and route to
    # SeqCls / MaskedLM / CausalLM by inspecting it, instead of forcing every
    # non-classification subtype onto CausalLM (wrong for the PubMedBERT encoder).
    # See `select_objective`. The route choice is logged so the pod logs show
    # which head was built and why.
    base_config = AutoConfig.from_pretrained(base_model_name)
    objective = select_objective(base_config, subtype)
    _emit_progress("objective", {
        "objective": objective,
        "subtype": subtype,
        "model_type": (getattr(base_config, "model_type", "") or ""),
        "architectures": list(getattr(base_config, "architectures", None) or []),
    })

    cfg = payload["loraConfig"]
    # PEFT TaskType: SeqCls / CausalLM map to dedicated TaskTypes. There is NO
    # MASKED_LM TaskType in PEFT — the MaskedLM route omits task_type (None) and
    # relies on EXPLICIT `target_modules` (BERT attention/FFN names) so
    # get_peft_model wraps the AutoModelForMaskedLM cleanly.
    if objective == "SEQ_CLS":
        peft_task_type = TaskType.SEQ_CLS
    elif objective == "CAUSAL":
        peft_task_type = TaskType.CAUSAL_LM
    else:  # MLM — no MASKED_LM TaskType in PEFT.
        peft_task_type = None

    lora_cfg = LoraConfig(
        r=int(cfg.get("r", 8)),
        lora_alpha=int(cfg.get("alpha", 16)),
        lora_dropout=float(cfg.get("dropout", 0.1)),
        bias="none",
        # BERT-family modules: explicit target_modules for the MLM route. PEFT's
        # string matcher resolves these as suffixes of the BERT module paths
        # (encoder.layer.N.attention.self.{query,key,value} and the FFN/output
        # `dense`), so they apply across all layers. GPT names (`c_attn`) would
        # NOT match BERT — that is exactly why a hardcoded causal default broke
        # the encoder mission. Falls back to the cfg-provided list when set.
        target_modules=(
            _peft_target_modules(cfg.get("target_modules", []) or ["query", "key", "value", "dense"])
            if objective == "MLM"
            else _peft_target_modules(cfg.get("target_modules", []))
        ),
        task_type=peft_task_type,
    )

    tokenizer = AutoTokenizer.from_pretrained(base_model_name)
    if tokenizer.pad_token is None:
        # GPT-family decoders ship no PAD token → reuse EOS. BERT-family
        # encoders (the MLM route) already have `[PAD]`, so this guard is a
        # no-op for them and does NOT clobber their pad token.
        tokenizer.pad_token = tokenizer.eos_token

    # Slice 11 (Plan B, 2026-05-17) — OOM mitigation
    # --------------------------------------------
    # Try `low_cpu_mem_usage=True` (accelerate-backed lazy weight
    # loading via `init_empty_weights`). When supported it reduces
    # the load-time fp16 weight materialization peak — meaningful
    # because LoRA loads a 7B-class base unquantized. Wrap in a
    # fallback: older transformers without accelerate raise
    # TypeError / ValueError, in which case retry without the kwarg.
    def _load_base():
        # Objective-routed model class (was: subtype-only → wrong CausalLM head
        # for the PubMedBERT encoder). MLM adds the third branch with the SAME
        # low_cpu_mem_usage try/except fallback as SeqCls/Causal.
        try:
            if objective == "SEQ_CLS":
                return AutoModelForSequenceClassification.from_pretrained(
                    base_model_name, num_labels=2, low_cpu_mem_usage=True
                )
            if objective == "MLM":
                return AutoModelForMaskedLM.from_pretrained(
                    base_model_name, low_cpu_mem_usage=True
                )
            return AutoModelForCausalLM.from_pretrained(
                base_model_name, low_cpu_mem_usage=True
            )
        except (TypeError, ValueError) as exc:
            _emit_progress(
                "warn",
                {"msg": f"low_cpu_mem_usage unsupported; retrying without it: {exc}"},
            )
            if objective == "SEQ_CLS":
                return AutoModelForSequenceClassification.from_pretrained(base_model_name, num_labels=2)
            if objective == "MLM":
                return AutoModelForMaskedLM.from_pretrained(base_model_name)
            return AutoModelForCausalLM.from_pretrained(base_model_name)

    model = _load_base()

    # Subtype-aware memory config (see `_build_training_kwargs` for the OOM
    # root cause). bf16 support is probed once here and injected into the
    # PURE helpers so they remain torch-free / unit-testable.
    bf16_supported = bool(
        device == "cuda"
        and getattr(torch.cuda, "is_bf16_supported", None)
        and torch.cuda.is_bf16_supported()
    )
    mem_kwargs = _build_training_kwargs(subtype, device, bf16_supported)

    # gradient_checkpointing (GENERATION) is incompatible with the KV cache:
    # `use_cache=True` makes the checkpointed forward pass recompute against a
    # cache that no longer matches, so transformers warns and silently
    # disables caching. Disable it explicitly on the base config to keep the
    # backward pass correct and silence the warning.
    if mem_kwargs.get("gradient_checkpointing"):
        if getattr(model, "config", None) is not None:
            model.config.use_cache = False

    model = get_peft_model(model, lora_cfg)

    # PEFT + gradient_checkpointing (GENERATION): the base model is frozen, so
    # the checkpointed segment's input tensor has requires_grad=False and the
    # backward pass would produce NO gradient for the LoRA adapters (silent
    # no-op training). `enable_input_require_grads()` registers the forward
    # hook that flags the embedding output as requiring grad, restoring the
    # gradient path through the checkpointed layers. Must be called AFTER
    # get_peft_model and BEFORE the Trainer enables checkpointing.
    if mem_kwargs.get("gradient_checkpointing") and hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()

    model.to(device)

    # Slice 11 (Plan B, 2026-05-17): drop transient load buffers
    # before training starts. `from_pretrained` leaves cudaMalloc /
    # MPS staging fragments that empty_cache() returns to the allocator,
    # and CPU-side temporary buffers that gc.collect() reclaims.
    gc.collect()
    if device == "cuda" and torch.cuda.is_available():
        torch.cuda.empty_cache()

    train_ds = _load_dataset(payload["trainingDatasetUri"])
    val_ds = _load_dataset(payload["validationDatasetUri"])

    # Subtype-aware truncation cap: GENERATION is capped at 256 (down from
    # 512) to bound the causal-LM activation footprint behind the 24 GB OOM;
    # CLASSIFICATION keeps 512. See `_max_seq_length`.
    max_seq_length = _max_seq_length(subtype)

    def tokenize(batch: Dict[str, Any]) -> Dict[str, Any]:
        return tokenizer(batch["text"], padding=False, truncation=True, max_length=max_seq_length)

    # Subtype-aware column handling (Bug 2026-05-23 — GENERATION batch_size
    # mismatch): for GENERATION drop the original `text`/`label` columns after
    # tokenization so only input_ids/attention_mask remain and the LM collator
    # builds `labels` from input_ids. CLASSIFICATION keeps its `label` (the
    # target). See `_columns_to_remove`.
    train_ds = train_ds.map(
        tokenize, batched=True, remove_columns=_columns_to_remove(subtype, train_ds.column_names)
    )
    val_ds = val_ds.map(
        tokenize, batched=True, remove_columns=_columns_to_remove(subtype, val_ds.column_names)
    )

    _emit_progress("mem_config", {
        "subtype": subtype,
        "device": device,
        "max_seq_length": max_seq_length,
        "bf16_supported": bf16_supported,
        **mem_kwargs,
    })

    args = TrainingArguments(
        output_dir=str(out_dir / "trainer_state"),
        num_train_epochs=int(payload.get("maxEpochs", 3)),
        learning_rate=2e-4,
        eval_strategy="epoch",
        save_strategy="no",
        logging_steps=50,
        seed=int(payload.get("seed", 42)),
        report_to=[],
        # Slice 11 (Plan B, 2026-05-17): disable DataLoader pinned-
        # memory pool. Each pinned page lives outside the cgroup
        # reclaimable set so it stacks with the base model and inflates
        # the OOM headroom required by `LORA_REQUIRED_FREE_MB`. The
        # H2D copy is fast enough that pinning is a luxury, not a need.
        dataloader_pin_memory=False,
        # Subtype-aware memory knobs (Bug 2026-05-23 — LORA_GENERATION OOM on
        # 24 GB A5000): per_device_train_batch_size / eval_batch_size,
        # gradient_accumulation_steps, gradient_checkpointing, and bf16/fp16.
        # GENERATION → batch 1 + accum 8 + checkpointing + bf16; CLASSIFICATION
        # → batch 8 + no checkpointing (proven config). See
        # `_build_training_kwargs`.
        **mem_kwargs,
    )

    # transformers 4.57+/5.x removed `Trainer(tokenizer=...)` (renamed to
    # `processing_class=`). Select the kwarg from the live signature so the
    # same script runs on both old 4.x and new 4.57+/5.x pod venvs.
    # NB: both collator constructors still take `tokenizer=` in 4.57/5.x — only
    # the Trainer renamed it — so the collator keeps `tokenizer=`.
    _tok_kw = _trainer_tokenizer_kwarg(inspect.signature(Trainer.__init__).parameters, tokenizer)
    # Objective-aware collator:
    #   CAUSAL  → DataCollatorForLanguageModeling(mlm=False)  (labels=input_ids);
    #   MLM     → DataCollatorForLanguageModeling(mlm=True, mlm_probability=…)
    #             (masked-token targets — NOT labels=input_ids);
    #   SEQ_CLS → DataCollatorWithPadding (scalar label is the target).
    # See `_build_data_collator`.
    data_collator = _build_data_collator(
        objective,
        tokenizer,
        padding_cls=DataCollatorWithPadding,
        lm_cls=DataCollatorForLanguageModeling,
        mlm_probability=_mlm_probability(cfg),
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=data_collator,
        **_tok_kw,
    )
    train_result = trainer.train()
    eval_result = trainer.evaluate()

    # Save adapter
    model.save_pretrained(out_dir, safe_serialization=True)

    metrics: Dict[str, float] = {}
    if objective == "SEQ_CLS":
        # Trainer.evaluate() returns eval_loss; we approximate accuracy
        # by running a fresh prediction pass. Cheap because val set is
        # small (mission corpora typically hundreds of items).
        preds = trainer.predict(val_ds)
        labels = preds.label_ids
        pred_ids = preds.predictions.argmax(axis=-1)
        accuracy = float((pred_ids == labels).mean()) if labels is not None else 0.0
        metrics = {"accuracy": accuracy, "f1": _macro_f1(labels, pred_ids)}
    else:
        # CausalLM AND MaskedLM both report perplexity = exp(eval_loss). For MLM
        # this is the standard pseudo-perplexity over the masked-token loss the
        # collator produced (mirrors the CausalLM branch — same metric key so
        # `reportedValMetrics` shape is unchanged for the TS wrapper).
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
