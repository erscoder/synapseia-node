"""Tests for train_lora.py objective routing (`select_objective`).

Bug (live, both GPU pods, 2026-05-25, `pubmedbert_v15` mission, every dispatch):

    LoRA training failed [python] python3 train_lora.py exited with code 2:
    If you want to use `BertLMHeadModel` as a standalone, add `is_decoder=True.`

Root cause: the old model-class selection branched on `subtype` only —
LORA_CLASSIFICATION → SeqCls, else → CausalLM. `pubmedbert_v15` arrives as
subtype LORA_GENERATION but its base (PubMedBERT) is an ENCODER-ONLY masked-LM
BERT. `AutoModelForCausalLM.from_pretrained` on a BERT builds `BertLMHeadModel`
WITHOUT `config.is_decoder=True` → exit 2.

`select_objective(config, subtype)` now inspects the model CONFIG and returns
"SEQ_CLS" | "MLM" | "CAUSAL". These tests assert the predicate with lightweight
fake config objects — no model download, no torch, no transformers.

Run:
    python -m pytest packages/node/scripts/__tests__/train_lora_objective_test.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the sibling script importable. (No torch needed — train_lora.py keeps
# its heavy imports inside _train.)
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import train_lora as tl  # noqa: E402


class _FakeConfig:
    """Lightweight stand-in for a transformers PretrainedConfig — only the
    attributes `select_objective` reads."""

    def __init__(self, model_type="", is_decoder=False, is_encoder_decoder=False, architectures=None):
        self.model_type = model_type
        self.is_decoder = is_decoder
        self.is_encoder_decoder = is_encoder_decoder
        self.architectures = architectures


# ───────────────────────── SEQ_CLS short-circuit ────────────────────────────

def test_classification_subtype_is_seq_cls_for_encoder() -> None:
    cfg = _FakeConfig(model_type="bert", architectures=["BertForMaskedLM"])
    assert tl.select_objective(cfg, "LORA_CLASSIFICATION") == "SEQ_CLS"


def test_classification_subtype_is_seq_cls_for_decoder() -> None:
    # A SequenceClassification head is valid on a decoder too — subtype wins.
    cfg = _FakeConfig(model_type="biogpt", is_decoder=True, architectures=["BioGptForCausalLM"])
    assert tl.select_objective(cfg, "LORA_CLASSIFICATION") == "SEQ_CLS"


# ─────────────────────────── encoder → MLM ──────────────────────────────────

def test_pubmedbert_routes_to_mlm() -> None:
    """The exact regression: PubMedBERT under subtype LORA_GENERATION → MLM
    (NOT CausalLM)."""
    cfg = _FakeConfig(model_type="bert", architectures=["BertForMaskedLM"])
    assert tl.select_objective(cfg, "LORA_GENERATION") == "MLM"


def test_known_encoder_families_route_to_mlm() -> None:
    for mt in ("bert", "roberta", "distilbert", "electra", "deberta", "deberta-v2", "xlm-roberta", "albert"):
        cfg = _FakeConfig(model_type=mt)
        assert tl.select_objective(cfg, "LORA_GENERATION") == "MLM", mt


def test_bare_encoder_model_arch_routes_to_mlm() -> None:
    # Unknown model_type but a bare `*Model` arch with no causal arch → encoder.
    cfg = _FakeConfig(model_type="some_new_encoder", architectures=["SomeNewModel"])
    assert tl.select_objective(cfg, "LORA_GENERATION") == "MLM"


def test_masked_arch_routes_to_mlm() -> None:
    cfg = _FakeConfig(model_type="unknownenc", architectures=["FooForMaskedLM"])
    assert tl.select_objective(cfg, "LORA_GENERATION") == "MLM"


# ─────────────────────────── decoder → CAUSAL ───────────────────────────────

def test_known_decoder_families_route_to_causal() -> None:
    for mt in ("gpt2", "llama", "mistral", "biogpt", "opt", "gptj", "falcon"):
        cfg = _FakeConfig(model_type=mt)
        assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL", mt


def test_is_decoder_flag_forces_causal() -> None:
    cfg = _FakeConfig(model_type="bert", is_decoder=True)
    assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL"


def test_encoder_decoder_flag_forces_causal() -> None:
    cfg = _FakeConfig(model_type="t5", is_encoder_decoder=True)
    assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL"


def test_causal_arch_routes_to_causal() -> None:
    cfg = _FakeConfig(model_type="newdecoder", architectures=["NewForCausalLM"])
    assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL"


def test_lmheadmodel_arch_routes_to_causal() -> None:
    cfg = _FakeConfig(model_type="somegpt", architectures=["SomeLMHeadModel"])
    assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL"


# ─────────────────────── ambiguous → historical CAUSAL ──────────────────────

def test_ambiguous_defaults_to_causal() -> None:
    # No model_type hint, no architectures → preserve the historical CausalLM
    # default so unknown decoder families keep working.
    cfg = _FakeConfig()
    assert tl.select_objective(cfg, "LORA_GENERATION") == "CAUSAL"


# ───────────────────────── _mlm_probability helper ──────────────────────────

def test_mlm_probability_default() -> None:
    assert tl._mlm_probability({}) == 0.15


def test_mlm_probability_from_cfg() -> None:
    assert tl._mlm_probability({"mlm_probability": 0.25}) == 0.25


def test_mlm_probability_clamps_out_of_range() -> None:
    assert tl._mlm_probability({"mlm_probability": 0}) == 0.15
    assert tl._mlm_probability({"mlm_probability": 1.0}) == 0.15
    assert tl._mlm_probability({"mlm_probability": "bad"}) == 0.15
