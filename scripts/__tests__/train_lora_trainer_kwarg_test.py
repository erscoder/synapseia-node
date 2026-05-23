"""Tests for train_lora.py version-compatible Trainer tokenizer kwarg.

Bug (live, both A5000 pods, 2026-05-23): the pod venv updated transformers to
4.57.6, whose `Trainer.__init__` REMOVED the `tokenizer=` parameter (renamed to
`processing_class=`). `train_lora.py` passed `Trainer(..., tokenizer=tokenizer)`,
raising `TypeError: __init__() got an unexpected keyword argument 'tokenizer'`,
caught by main()'s top-level handler → exit 2, right after the dataset Map step.
This broke BOTH LORA_CLASSIFICATION and LORA_GENERATION (single shared Trainer
construction).

`_trainer_tokenizer_kwarg` selects the right kwarg from the live
`Trainer.__init__` signature. It is PURE (no torch/transformers import), so it
runs on a CI runner without the heavy deps — same as `train_lora_memconfig_test`.

Run:
    python -m pytest packages/node/scripts/__tests__/train_lora_trainer_kwarg_test.py -q
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

# Make the sibling script importable. (No torch needed — train_lora.py keeps
# its heavy imports inside _train.)
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import train_lora as tl  # noqa: E402


# A sentinel that stands in for the real tokenizer object.
_TOK = object()


# ───────────────── fake signatures (old 4.x vs new 4.57+/5.x) ────────────────

def _params(*names: str):
    """Build a `parameters`-like mapping from param names, mirroring what
    `inspect.signature(Trainer.__init__).parameters` returns (an ordered
    Mapping[str, Parameter]). Membership-by-name is all the SUT uses."""
    def _fn(**_kwargs):  # placeholder body — never called
        ...
    _fn.__signature__ = inspect.Signature(
        [inspect.Parameter("self", inspect.Parameter.POSITIONAL_OR_KEYWORD)]
        + [
            inspect.Parameter(n, inspect.Parameter.KEYWORD_ONLY, default=None)
            for n in names
        ]
    )
    return inspect.signature(_fn).parameters


# old transformers (<4.57): has `tokenizer`, no `processing_class`.
OLD_PARAMS = _params("model", "args", "train_dataset", "eval_dataset", "tokenizer", "data_collator")
# new transformers (4.57+/5.x): `tokenizer` removed, `processing_class` added.
NEW_PARAMS = _params("model", "args", "train_dataset", "eval_dataset", "processing_class", "data_collator")


def test_new_transformers_uses_processing_class() -> None:
    kw = tl._trainer_tokenizer_kwarg(NEW_PARAMS, _TOK)
    assert kw == {"processing_class": _TOK}
    assert "tokenizer" not in kw  # the removed kwarg must NOT be passed


def test_old_transformers_uses_tokenizer() -> None:
    kw = tl._trainer_tokenizer_kwarg(OLD_PARAMS, _TOK)
    assert kw == {"tokenizer": _TOK}
    assert "processing_class" not in kw


def test_processing_class_wins_when_both_present() -> None:
    # Defensive: if a transition build exposes both, prefer the modern name.
    both = _params("tokenizer", "processing_class")
    kw = tl._trainer_tokenizer_kwarg(both, _TOK)
    assert kw == {"processing_class": _TOK}


def test_returns_a_single_kwarg() -> None:
    # The result is spread into Trainer(...) — it must contribute exactly one
    # key so it never collides with the explicit Trainer args.
    assert len(tl._trainer_tokenizer_kwarg(NEW_PARAMS, _TOK)) == 1
    assert len(tl._trainer_tokenizer_kwarg(OLD_PARAMS, _TOK)) == 1
