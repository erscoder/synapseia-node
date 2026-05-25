"""Tests for train_lora.py subtype-aware data collator + tokenized columns.

Bug (live, 2026-05-23): subtype=LORA_GENERATION failed at the FIRST training
step with `RuntimeError: Expected input batch_size (256) to match target
batch_size (1)`. The generation path reused the CLASSIFICATION data setup:
`tokenize()` returns only input_ids/attention_mask (no `labels`), and the
collator was `DataCollatorWithPadding` for BOTH subtypes. For CausalLM the model
needs `labels = input_ids` (next-token loss); DataCollatorWithPadding does not
build them and instead forwards the classification scalar `label` → input
[B, 256] vs target [1] → batch_size mismatch.

These tests assert the GENERATION path now selects DataCollatorForLanguageModeling
(mlm=False) and drops the original `text`/`label` columns, while CLASSIFICATION
keeps DataCollatorWithPadding and keeps its `label` column. The helpers under
test are PURE (no torch import) — `_build_data_collator` takes the two collator
CLASSES injected by the caller, so this runs on a CI runner without transformers.

Run:
    python -m pytest packages/node/scripts/__tests__/train_lora_collator_test.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling script importable. (No torch needed — train_lora.py keeps
# its heavy imports inside _train.)
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import train_lora as tl  # noqa: E402


# ── Collator stand-ins (mirror the transformers constructor signatures) ──────


class _FakePaddingCollator:
    """Stand-in for DataCollatorWithPadding(tokenizer=...)."""

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.mlm = None  # padding collator has no mlm flag


class _FakeLMCollator:
    """Stand-in for DataCollatorForLanguageModeling(tokenizer=..., mlm=..., mlm_probability=...)."""

    def __init__(self, tokenizer, mlm, mlm_probability=0.15):
        self.tokenizer = tokenizer
        self.mlm = mlm
        self.mlm_probability = mlm_probability


def _build(objective: str, mlm_probability: float = 0.15):
    return tl._build_data_collator(
        objective,
        tokenizer="TOK",
        padding_cls=_FakePaddingCollator,
        lm_cls=_FakeLMCollator,
        mlm_probability=mlm_probability,
    )


# ───────────────────────── data collator selection ──────────────────────────
#
# NB: `_build_data_collator` now discriminates on the resolved OBJECTIVE
# ("CAUSAL" | "MLM" | "SEQ_CLS"), not the raw subtype — `select_objective`
# computes the objective up front. CausalLM behaviour is unchanged.

def test_causal_uses_language_modeling_collator_mlm_false() -> None:
    """CAUSAL selects DataCollatorForLanguageModeling(mlm=False) so it
    derives labels=input_ids — fixing the batch_size mismatch."""
    collator = _build("CAUSAL")
    assert isinstance(collator, _FakeLMCollator)
    assert collator.mlm is False
    assert collator.tokenizer == "TOK"


def test_mlm_uses_language_modeling_collator_mlm_true() -> None:
    """MLM selects DataCollatorForLanguageModeling(mlm=True, mlm_probability=…)
    so labels are masked-token targets — NOT labels=input_ids."""
    collator = _build("MLM", mlm_probability=0.2)
    assert isinstance(collator, _FakeLMCollator)
    assert collator.mlm is True
    assert collator.mlm_probability == 0.2
    assert collator.tokenizer == "TOK"


def test_classification_uses_padding_collator() -> None:
    """SEQ_CLS keeps DataCollatorWithPadding (scalar `label` is target)."""
    collator = _build("SEQ_CLS")
    assert isinstance(collator, _FakePaddingCollator)
    assert collator.tokenizer == "TOK"


def test_unknown_objective_defaults_to_padding_collator() -> None:
    # Any unexpected objective falls back to the classification collator.
    collator = _build("SOMETHING_ELSE")
    assert isinstance(collator, _FakePaddingCollator)


# ─────────────────────── tokenized columns to remove ────────────────────────

def test_generation_drops_text_and_label_columns() -> None:
    """GENERATION strips the original text/label so only input_ids/attention_mask
    remain and the LM collator builds labels from input_ids."""
    removed = tl._columns_to_remove("LORA_GENERATION", ["text", "label"])
    assert set(removed) == {"text", "label"}


def test_generation_drops_only_present_columns() -> None:
    # Generation corpora may carry only `text` (no `label`). Don't list absent
    # columns — datasets.map(remove_columns=...) raises on unknown column names.
    removed = tl._columns_to_remove("LORA_GENERATION", ["text"])
    assert removed == ["text"]


def test_generation_ignores_unrelated_columns() -> None:
    # Only `text`/`label` are dropped; anything else (e.g. an id column) stays.
    removed = tl._columns_to_remove("LORA_GENERATION", ["text", "label", "id"])
    assert set(removed) == {"text", "label"}
    assert "id" not in removed


def test_classification_keeps_label_column() -> None:
    """CLASSIFICATION removes nothing → its `label` (the target) is kept."""
    assert tl._columns_to_remove("LORA_CLASSIFICATION", ["text", "label"]) == []


def test_unknown_subtype_keeps_all_columns() -> None:
    assert tl._columns_to_remove("SOMETHING_ELSE", ["text", "label"]) == []
