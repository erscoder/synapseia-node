"""Tests for train_lora.py subtype-aware memory config.

Bug (live, both A5000 pods, 24 GB each, 2026-05-23): subtype=LORA_GENERATION
on BioGPT-Large OOMed at training step 0 because the trainer hardcoded
per_device_train_batch_size=8, no mixed precision, no gradient checkpointing,
and max_length=512 for BOTH subtypes. LORA_CLASSIFICATION on the same model
fit. These tests assert the GENERATION path now sets the memory-saving flags
and the CLASSIFICATION path is unchanged.

The config helpers under test are PURE (no torch import), so this runs on a
CI runner without CUDA / torch installed. We import the module directly; its
torch/transformers/peft imports live inside `_train`, not at module scope.

Run:
    python -m pytest packages/node/scripts/__tests__/train_lora_memconfig_test.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling script importable. (No torch needed — train_lora.py keeps
# its heavy imports inside _train.)
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import train_lora as tl  # noqa: E402


# ───────────────────────── max sequence length ──────────────────────────────

def test_generation_seq_length_is_capped_at_256() -> None:
    assert tl._max_seq_length("LORA_GENERATION") == 256


def test_classification_seq_length_unchanged_512() -> None:
    assert tl._max_seq_length("LORA_CLASSIFICATION") == 512


def test_unknown_subtype_defaults_to_512() -> None:
    assert tl._max_seq_length("SOMETHING_ELSE") == 512


# ───────────────────────── precision flags ──────────────────────────────────

def test_generation_bf16_on_ampere_cuda() -> None:
    # A5000 / Ampere: bf16 supported → bf16 True, fp16 False.
    flags = tl._precision_flags("LORA_GENERATION", "cuda", bf16_supported=True)
    assert flags == {"bf16": True, "fp16": False}


def test_generation_fp16_on_older_cuda_without_bf16() -> None:
    flags = tl._precision_flags("LORA_GENERATION", "cuda", bf16_supported=False)
    assert flags == {"bf16": False, "fp16": True}


def test_precision_disabled_on_cpu() -> None:
    # CPU / MPS keep fp32 — bf16/fp16 autocast unreliable there. Classification
    # runs here today and MUST stay fp32.
    assert tl._precision_flags("LORA_CLASSIFICATION", "cpu", bf16_supported=False) == {
        "bf16": False,
        "fp16": False,
    }
    assert tl._precision_flags("LORA_CLASSIFICATION", "mps", bf16_supported=True) == {
        "bf16": False,
        "fp16": False,
    }


# ──────────────────── full training-kwargs (the OOM fix) ─────────────────────

def test_generation_config_fits_24gb_levers_on_ampere() -> None:
    """LORA_GENERATION on a bf16-capable CUDA GPU (A5000) sets ALL the
    memory-saving flags that make it fit 24 GB."""
    kw = tl._build_training_kwargs("LORA_GENERATION", "cuda", bf16_supported=True)
    assert kw["per_device_train_batch_size"] == 1
    assert kw["per_device_eval_batch_size"] == 1
    assert kw["gradient_checkpointing"] is True
    # Non-reentrant checkpointing → composes with PEFT input-require-grads.
    assert kw["gradient_checkpointing_kwargs"] == {"use_reentrant": False}
    assert kw["bf16"] is True
    assert kw["fp16"] is False
    # Effective batch unchanged (1 × 8 == old 8) so learning dynamics hold.
    assert kw["gradient_accumulation_steps"] == 8
    assert (
        kw["per_device_train_batch_size"] * kw["gradient_accumulation_steps"] == 8
    )


def test_generation_uses_fp16_when_bf16_unsupported() -> None:
    kw = tl._build_training_kwargs("LORA_GENERATION", "cuda", bf16_supported=False)
    assert kw["per_device_train_batch_size"] == 1
    assert kw["gradient_checkpointing"] is True
    assert kw["bf16"] is False
    assert kw["fp16"] is True


def test_classification_config_not_regressed() -> None:
    """LORA_CLASSIFICATION keeps its proven config: batch 8, no gradient
    checkpointing, effective batch 8. It only opts into bf16/fp16 on a
    capable CUDA GPU (free win) — never enabled on its usual CPU/MPS path."""
    # On CPU (its usual backend): fp32, batch 8, no checkpointing.
    kw_cpu = tl._build_training_kwargs("LORA_CLASSIFICATION", "cpu", bf16_supported=False)
    assert kw_cpu["per_device_train_batch_size"] == 8
    assert kw_cpu["per_device_eval_batch_size"] == 8
    assert kw_cpu["gradient_accumulation_steps"] == 1
    assert kw_cpu["gradient_checkpointing"] is False
    assert "gradient_checkpointing_kwargs" not in kw_cpu  # no reentrant override
    assert kw_cpu["bf16"] is False
    assert kw_cpu["fp16"] is False

    # On a bf16-capable CUDA GPU: same memory knobs, just gains bf16.
    kw_cuda = tl._build_training_kwargs("LORA_CLASSIFICATION", "cuda", bf16_supported=True)
    assert kw_cuda["per_device_train_batch_size"] == 8
    assert kw_cuda["gradient_checkpointing"] is False
    assert kw_cuda["bf16"] is True
    assert kw_cuda["fp16"] is False


def test_generation_and_classification_share_effective_batch() -> None:
    gen = tl._build_training_kwargs("LORA_GENERATION", "cuda", bf16_supported=True)
    cls = tl._build_training_kwargs("LORA_CLASSIFICATION", "cuda", bf16_supported=True)
    gen_eff = gen["per_device_train_batch_size"] * gen["gradient_accumulation_steps"]
    cls_eff = cls["per_device_train_batch_size"] * cls["gradient_accumulation_steps"]
    assert gen_eff == cls_eff == 8
