"""Tests for diloco_aggregate.py — Bug 35 / D-py-1.

Run:
    python -m pytest packages/node/scripts/__tests__/diloco_aggregate_test.py -q
"""

from __future__ import annotations

import io
import json
import math
import os
import pickle
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict

import pytest

torch = pytest.importorskip("torch")

# Make sibling script importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import diloco_aggregate as agg  # noqa: E402
from diloco_train import compress_gradients_svd  # noqa: E402 — REAL compressor (source of truth)


# ----------------------------- helpers -----------------------------

def _dump_grad(tmp: Path, name: str, tensors: Dict[str, "torch.Tensor"]) -> Path:
    p = tmp / f"{name}.pt"
    with p.open("wb") as fh:
        pickle.dump(tensors, fh)
    return p


def _peer(peer_id: str, path: Path, weight: float = 1.0) -> dict:
    return {"peerId": peer_id, "gradientPath": str(path), "weight": weight}


# ------------------------- per-peer cosine -------------------------

def test_identical_gradients_cosine_is_one(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 2.0, 3.0, 4.0])}
    p1 = _dump_grad(tmp_path, "peer1", g)
    p2 = _dump_grad(tmp_path, "peer2", g)

    res = agg.average_gradients([_peer("a", p1), _peer("b", p2)])

    assert res["participatingNodes"] == 2
    assert set(res["perPeerCosine"].keys()) == {"a", "b"}
    assert res["perPeerCosine"]["a"] == pytest.approx(1.0, abs=1e-6)
    assert res["perPeerCosine"]["b"] == pytest.approx(1.0, abs=1e-6)


def test_opposite_direction_pulls_cosine_to_near_minus_one(tmp_path: Path) -> None:
    g_pos = {"w": torch.tensor([1.0, 2.0, 3.0])}
    g_neg = {"w": torch.tensor([-1.0, -2.0, -3.0])}
    # Three peers tipping the mean toward g_pos so the negative peer
    # ends up near -1.
    p1 = _dump_grad(tmp_path, "pos1", g_pos)
    p2 = _dump_grad(tmp_path, "pos2", g_pos)
    p3 = _dump_grad(tmp_path, "neg", g_neg)

    res = agg.average_gradients([_peer("a", p1), _peer("b", p2), _peer("c", p3)])

    for v in res["perPeerCosine"].values():
        assert -1.0 <= v <= 1.0 or math.isnan(v)
    assert res["perPeerCosine"]["a"] == pytest.approx(1.0, abs=1e-6)
    assert res["perPeerCosine"]["b"] == pytest.approx(1.0, abs=1e-6)
    assert res["perPeerCosine"]["c"] == pytest.approx(-1.0, abs=1e-6)


def test_zero_magnitude_peer_emits_nan_without_crash(tmp_path: Path) -> None:
    g_real = {"w": torch.tensor([1.0, 2.0, 3.0])}
    g_zero = {"w": torch.tensor([0.0, 0.0, 0.0])}
    p1 = _dump_grad(tmp_path, "real", g_real)
    p2 = _dump_grad(tmp_path, "zero", g_zero)

    res = agg.average_gradients([_peer("r", p1), _peer("z", p2)])

    # real peer matches a non-zero mean → finite cosine.
    assert math.isfinite(res["perPeerCosine"]["r"])
    # zero peer → NaN, NOT a crash.
    assert math.isnan(res["perPeerCosine"]["z"])


def test_count_matches_input_peers(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 0.0])}
    paths = [_dump_grad(tmp_path, f"p{i}", g) for i in range(5)]

    res = agg.average_gradients([_peer(f"id{i}", p) for i, p in enumerate(paths)])

    assert res["participatingNodes"] == 5
    assert len(res["perPeerCosine"]) == 5
    for v in res["perPeerCosine"].values():
        assert math.isnan(v) or -1.0 <= v <= 1.0


def test_cosine_values_clamped_to_unit_range(tmp_path: Path) -> None:
    # Slight FP noise can push cosine to 1.0000001 — guard against it.
    g = {"w": torch.tensor([1.0e-7, 2.0e-7, 3.0e-7, 4.0e-7])}
    p1 = _dump_grad(tmp_path, "a", g)
    p2 = _dump_grad(tmp_path, "b", g)

    res = agg.average_gradients([_peer("a", p1), _peer("b", p2)])

    for v in res["perPeerCosine"].values():
        assert math.isnan(v) or -1.0 <= v <= 1.0


# ------------------------- output JSON shape -------------------------

def test_existing_fields_present_for_back_compat(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 2.0])}
    p = _dump_grad(tmp_path, "one", g)

    res = agg.average_gradients([_peer("only", p)])

    # All legacy keys present (coord 0.8.71 reads these).
    assert "participatingNodes" in res
    assert "avgGradientNorm" in res
    assert "velocityNorm" in res
    # And the new key.
    assert "perPeerCosine" in res
    assert isinstance(res["perPeerCosine"], dict)


def test_empty_peer_list_returns_empty_map(tmp_path: Path) -> None:
    res = agg.average_gradients([])
    assert res["participatingNodes"] == 0
    assert res["perPeerCosine"] == {}


def test_layout_mismatch_raises(tmp_path: Path) -> None:
    g1 = {"w": torch.tensor([1.0, 2.0, 3.0])}
    g2 = {"w": torch.tensor([1.0, 2.0])}  # different flat size
    p1 = _dump_grad(tmp_path, "g1", g1)
    p2 = _dump_grad(tmp_path, "g2", g2)
    with pytest.raises(ValueError):
        agg.average_gradients([_peer("a", p1), _peer("b", p2)])


def test_output_path_written_when_requested(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 2.0, 3.0, 4.0])}
    p1 = _dump_grad(tmp_path, "a", g)
    p2 = _dump_grad(tmp_path, "b", g)
    out = tmp_path / "agg.pt"

    res = agg.average_gradients(
        [_peer("a", p1), _peer("b", p2)], output_path=str(out)
    )
    assert res["outputPath"] == str(out)
    assert out.exists()
    with out.open("rb") as fh:
        rebuilt = pickle.load(fh)
    assert "w" in rebuilt
    assert torch.allclose(rebuilt["w"], g["w"])


# ----------------------- CLI / stdin contract -----------------------

def test_cli_end_to_end_emits_perpeercosine(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 0.0, -1.0])}
    p1 = _dump_grad(tmp_path, "x", g)
    p2 = _dump_grad(tmp_path, "y", g)
    config = {
        "peers": [
            {"peerId": "x", "gradientPath": str(p1), "weight": 1.0},
            {"peerId": "y", "gradientPath": str(p2), "weight": 1.0},
        ]
    }

    script = SCRIPTS_DIR / "diloco_aggregate.py"
    proc = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["participatingNodes"] == 2
    assert set(out["perPeerCosine"].keys()) == {"x", "y"}
    # Identical inputs → cosine ~1.0.
    for v in out["perPeerCosine"].values():
        assert v == pytest.approx(1.0, abs=1e-6)


def test_cli_handles_zero_peer_without_crash(tmp_path: Path) -> None:
    g_real = {"w": torch.tensor([1.0, 2.0])}
    g_zero = {"w": torch.tensor([0.0, 0.0])}
    p1 = _dump_grad(tmp_path, "real", g_real)
    p2 = _dump_grad(tmp_path, "zero", g_zero)
    config = {
        "peers": [
            {"peerId": "r", "gradientPath": str(p1), "weight": 1.0},
            {"peerId": "z", "gradientPath": str(p2), "weight": 1.0},
        ]
    }
    script = SCRIPTS_DIR / "diloco_aggregate.py"
    proc = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    # NaN serialized as sentinel string "NaN" for JSON.parse compat.
    assert out["perPeerCosine"]["z"] == "NaN"
    # Real peer is a finite number.
    assert isinstance(out["perPeerCosine"]["r"], (int, float))


def _exact_rank_k_grad(rows: int, cols: int, k: int):
    """A dense gradient that is EXACTLY rank-k, so truncated SVD at top_k>=k
    reconstructs it (near-)exactly. Built as A @ B with inner dim k."""
    torch.manual_seed(rows * 1000 + cols * 10 + k)
    a = torch.randn(rows, k)
    b = torch.randn(k, cols)
    return (a @ b).float()


@pytest.mark.parametrize(
    "rows,cols,k",
    [
        (16, 32, 8),   # rectangular wide
        (32, 16, 8),   # rectangular tall
        (16, 16, 8),   # SQUARE — the case that catches a silent V transpose
    ],
)
def test_decompress_svd_matches_real_compressor(rows: int, cols: int, k: int) -> None:
    """BLOCKER-2: drive the reconstruction with the ACTUAL
    `compress_gradients_svd` from `diloco_train.py` (the production source of
    truth). The "V" key holds `Vh[:k,:]` (k,cols), so the correct
    reconstruction is `(U * S) @ V` with NO transpose. The SQUARE case
    (16x16) is critical: a wrong `V.transpose()` does NOT crash there — it
    silently reconstructs garbage. Input forced exactly rank-k → near-exact
    round-trip; re-adding the transpose blows up the error and this fails."""
    original = _exact_rank_k_grad(rows, cols, k)
    bundle = compress_gradients_svd({"w": original}, top_k=k)["w"]
    assert set(bundle.keys()) >= {"U", "S", "V", "shape"}
    assert isinstance(bundle["U"], list) and isinstance(bundle["V"], list)

    decompressed = agg._decompress_if_svd("w", bundle)
    assert tuple(decompressed.shape) == (rows, cols)
    # atol 1e-4: exactly rank-k input → only float32 SVD round-off remains.
    assert torch.allclose(decompressed, original, atol=1e-4), (
        f"recon error {(decompressed - original).abs().max().item():.3e} "
        f"for {rows}x{cols} k={k}"
    )


def test_decompress_svd_list_inputs_match_tensor_inputs() -> None:
    """List-vs-tensor equivalence (regression round 1228): the SAME bundle
    from the real compressor, once with list components and once coerced to
    tensors, must reconstruct identically and never raise on `list`."""
    original = _exact_rank_k_grad(16, 32, 8)
    list_bundle = compress_gradients_svd({"w": original}, top_k=8)["w"]
    tensor_bundle = {
        "U": torch.tensor(list_bundle["U"]),
        "S": torch.tensor(list_bundle["S"]),
        "V": torch.tensor(list_bundle["V"]),
        "shape": list_bundle["shape"],
    }

    dense_from_tensors = agg._decompress_if_svd("w", tensor_bundle)
    dense_from_lists = agg._decompress_if_svd("w", list_bundle)

    assert tuple(dense_from_lists.shape) == tuple(tensor_bundle["shape"])
    assert torch.allclose(dense_from_lists, dense_from_tensors, atol=1e-6)


def test_decompress_raw_fallback_list_input() -> None:
    """Non-SVD `{raw, shape}` fallback also arrives as a list via
    `.tolist()` and must reconstruct."""
    raw = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    out = agg._decompress_if_svd("w", {"raw": raw, "shape": [2, 3]})
    assert tuple(out.shape) == (2, 3)
    assert torch.allclose(out, torch.tensor(raw, dtype=torch.float32))


def test_decompress_unsupported_type_still_raises() -> None:
    """Fail-closed (P2): unknown entry must raise, never silently skip."""
    with pytest.raises(ValueError):
        agg._decompress_if_svd("w", object())
