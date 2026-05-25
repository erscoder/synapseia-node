"""Tests for diloco_validate.py — DiLoCo B-validator (Phase 4B).

The full per-peer forward pass needs the pre-downloaded foundation model on
disk, so these tests cover the model-independent contract surface:
  - pseudo-gradient decode mirrors diloco_aggregate.py byte-for-byte (uses the
    REAL `compress_gradients_svd` from diloco_train.py as the source of truth),
  - the held-out val-set parser (plain lines + JSONL),
  - the per-peer "NaN" string sentinel + JSON output contract (a bare float NaN
    would be invalid JSON the TS JSON.parse rejects),
  - per-peer failure isolation (one bad peer → "NaN", the rest survive).

Run:
    python -m pytest packages/node/scripts/__tests__/diloco_validate_test.py -q
"""

from __future__ import annotations

import json
import math
import pickle
import subprocess
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import diloco_validate as val  # noqa: E402
import diloco_aggregate as agg  # noqa: E402 — cross-check decode parity
from diloco_train import compress_gradients_svd  # noqa: E402


# ----------------------------- decode parity -----------------------------

def _exact_rank_k_grad(rows: int, cols: int, k: int):
    torch.manual_seed(rows * 1000 + cols * 10 + k)
    a = torch.randn(rows, k)
    b = torch.randn(k, cols)
    return (a @ b).float()


@pytest.mark.parametrize("rows,cols,k", [(16, 32, 8), (32, 16, 8), (16, 16, 8)])
def test_decompress_matches_aggregator_and_compressor(rows, cols, k):
    """The validator MUST decode a peer's SVD pseudo-gradient identically to
    the aggregator (same bytes → same delta). The SQUARE case catches a silent
    V transpose. Driven by the production compressor as the source of truth."""
    original = _exact_rank_k_grad(rows, cols, k)
    bundle = compress_gradients_svd({"w": original}, top_k=k)["w"]

    via_validator = val._decompress_if_svd("w", bundle)
    via_aggregator = agg._decompress_if_svd("w", bundle)

    assert tuple(via_validator.shape) == (rows, cols)
    assert torch.allclose(via_validator, via_aggregator, atol=1e-6)
    assert torch.allclose(via_validator, original, atol=1e-4)


def test_decompress_raw_fallback_and_bare_tensor():
    raw = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    out = val._decompress_if_svd("w", {"raw": raw, "shape": [2, 3]})
    assert tuple(out.shape) == (2, 3)
    bare = val._decompress_if_svd("w", torch.tensor([1.0, 2.0]))
    assert bare.dtype == torch.float32


def test_decompress_unsupported_raises():
    with pytest.raises(ValueError):
        val._decompress_if_svd("w", object())


# ----------------------------- val-set parser -----------------------------

def test_load_val_texts_plain_and_jsonl(tmp_path: Path):
    p = tmp_path / "val.jsonl"
    p.write_text(
        "plain line one\n"
        '{"text": "from text field"}\n'
        '{"content": "from content field"}\n'
        "\n"  # blank skipped
        "plain line two\n",
        encoding="utf-8",
    )
    texts = val._load_val_texts(str(p), max_samples=10)
    assert texts == ["plain line one", "from text field", "from content field", "plain line two"]


def test_load_val_texts_caps_samples(tmp_path: Path):
    p = tmp_path / "val.txt"
    p.write_text("\n".join(f"line {i}" for i in range(100)), encoding="utf-8")
    texts = val._load_val_texts(str(p), max_samples=5)
    assert len(texts) == 5


def test_load_val_texts_empty_raises(tmp_path: Path):
    p = tmp_path / "empty.txt"
    p.write_text("\n\n  \n", encoding="utf-8")
    with pytest.raises(ValueError):
        val._load_val_texts(str(p), max_samples=10)


# ---------------------- per-peer eval + "NaN" sentinel ----------------------

class _StubLoss:
    def __init__(self, v):
        self._v = v

    def item(self):
        return self._v


class _StubModel:
    """Minimal model double: trainable params named to match pseudo-gradient
    keys; returns a fixed (or NaN) loss. Lets us exercise apply→eval→restore
    without loading a real transformer."""

    def __init__(self, loss_value):
        self._loss_value = loss_value
        self._w = torch.zeros(2, 2)
        self._w.requires_grad_(True)

    def named_parameters(self):
        yield ("base_model.model.layers.0.self_attn.q_proj.lora_A.weight", self._w)

    def eval(self):
        return self

    def __call__(self, **kwargs):
        class _Out:
            loss = _StubLoss(self._loss_value)

        out = _Out()
        out.loss = _StubLoss(self._loss_value)
        return out


class _StubTokenizer:
    pad_token = "<pad>"
    pad_token_id = 0

    def __call__(self, texts, **kwargs):
        n = len(texts)
        return {
            "input_ids": torch.ones(n, 4, dtype=torch.long),
            "attention_mask": torch.ones(n, 4, dtype=torch.long),
        }


def test_apply_pseudo_gradient_then_restore_is_exact():
    model = _StubModel(loss_value=1.0)
    baseline = val._capture_lora_params(model)
    grad = {"base_model.model.layers.0.self_attn.q_proj.lora_A.weight": torch.ones(2, 2)}
    applied = val._apply_pseudo_gradient(model, grad)
    assert applied == 1
    # param moved by +1
    assert torch.allclose(model._w.data, torch.ones(2, 2))
    val._restore_lora_params(model, baseline)
    assert torch.allclose(model._w.data, torch.zeros(2, 2))


def test_apply_pseudo_gradient_no_match_raises():
    model = _StubModel(loss_value=1.0)
    with pytest.raises(ValueError):
        val._apply_pseudo_gradient(model, {"nonexistent.param": torch.ones(2, 2)})


def test_mean_cross_entropy_finite():
    model = _StubModel(loss_value=2.5)
    loss = val._mean_cross_entropy(model, _StubTokenizer(), ["a", "b", "c"], max_seq_len=4)
    assert loss == pytest.approx(2.5)


def test_mean_cross_entropy_nonfinite_raises():
    model = _StubModel(loss_value=float("nan"))
    with pytest.raises(ValueError):
        val._mean_cross_entropy(model, _StubTokenizer(), ["a"], max_seq_len=4)


def test_main_emits_nan_sentinel_as_string(monkeypatch, tmp_path: Path, capsys):
    """End-to-end main(): one peer evaluates to a number, one raises → its
    valLoss is the literal "NaN" STRING (valid JSON), the other is a float."""
    # Patch the heavy model-load path so no foundation model is needed.
    monkeypatch.setattr(val, "_resolve_local_snapshot", lambda model_id: "/fake/snapshot")
    monkeypatch.setattr(val, "_build_lora_model", lambda name, prev: (_StubModel(1.5), _StubTokenizer()))

    # Two peers: good grad (matches the stub param) + bad grad (no match → raises).
    good = tmp_path / "good.pt"
    bad = tmp_path / "bad.pt"
    with good.open("wb") as fh:
        pickle.dump({"base_model.model.layers.0.self_attn.q_proj.lora_A.weight": torch.ones(2, 2)}, fh)
    with bad.open("wb") as fh:
        pickle.dump({"unmatched.param": torch.ones(2, 2)}, fh)
    valset = tmp_path / "val.txt"
    valset.write_text("sample one\nsample two\n", encoding="utf-8")

    config = {
        "modelId": "Qwen/Qwen2.5-7B",
        "prevAdapterPath": None,
        "valSetPath": str(valset),
        "peers": [
            {"peerId": "good", "gradientPath": str(good)},
            {"peerId": "bad", "gradientPath": str(bad)},
        ],
        "maxValSamples": 10,
    }
    monkeypatch.setattr("sys.stdin", _StdinStub(json.dumps(config)))
    rc = val.main()
    captured = capsys.readouterr()
    assert rc == 0
    out = json.loads(captured.out.strip().splitlines()[-1])  # must be valid JSON
    assert "perPeerValLoss" in out
    assert out["perPeerValLoss"]["good"] == pytest.approx(1.5)
    assert out["perPeerValLoss"]["bad"] == "NaN"  # literal string, never bare NaN
    # Confirm the emitted payload contains NO bare NaN token.
    assert "NaN" in captured.out
    assert ": NaN" not in captured.out  # never a bare JSON NaN value


class _StdinStub:
    def __init__(self, data: str):
        self._data = data

    def read(self) -> str:
        return self._data
