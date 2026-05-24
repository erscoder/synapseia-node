"""Tests for diloco_aggregate_executor.py — node-side aggregation (Phase 3).

Pure-piece unit tests (no GPU required — the executor is CPU-pinned by
design). Covers: invariant computation, cosine accept/reject sets,
Nesterov momentum (cold-start + carry-over), adapter accumulation, and
the CLI end-to-end with the JSON stdin/stdout contract.

Run:
    python -m pytest packages/node/scripts/__tests__/diloco_aggregate_executor_test.py -q

NOTE on determinism: the SCALAR INVARIANTS (avgGradientNorm, velocityNorm,
accepted/rejected sets) are bit-stable across runs and are the consensus
key (design §4.2). The adapter PICKLE bytes are NOT asserted equal across
runs — torch tensor pickling embeds non-deterministic storage metadata,
and the coord consensus is tolerance-based on the invariants, NOT on the
adapter sha256 (which §4.2 treats as informational only).
"""

from __future__ import annotations

import json
import math
import os
import pickle
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict

import pytest

torch = pytest.importorskip("torch")

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import diloco_aggregate_executor as agg  # noqa: E402
from diloco_train import compress_gradients_svd  # noqa: E402 — REAL compressor (source of truth)


def _w(path: Path, obj: Dict[str, Any]) -> str:
    with open(path, "wb") as f:
        pickle.dump(obj, f)
    return str(path)


def _peer(pid: str, path: str, weight: float = 1.0):
    return {"peerId": pid, "gradientPath": path, "stakeWeight": weight}


def test_byzantine_filter_accepts_aligned_rejects_opposite(tmp_path: Path) -> None:
    ref = {"w": torch.tensor([1.0, 2.0, 3.0])}
    same = {"w": torch.tensor([2.0, 4.0, 6.0])}
    opp = {"w": torch.tensor([-3.0, -6.0, -9.0])}
    peers = [
        _peer("a", _w(tmp_path / "a.pt", ref), 0.4),
        _peer("b", _w(tmp_path / "b.pt", same), 0.4),
        _peer("c", _w(tmp_path / "c.pt", opp), 0.2),
    ]
    res = agg.byzantine_cosine_filter(peers, cosine_reject_threshold=0.3)
    assert set(res["accepted"]) == {"a", "b"}
    assert {r["peerId"]: r["reason"] for r in res["rejected"]} == {"c": "cosine_low"}
    assert res["perPeerCosine"]["a"] == pytest.approx(1.0, abs=1e-6)
    assert res["perPeerCosine"]["c"] == pytest.approx(-1.0, abs=1e-6)


def test_zero_magnitude_peer_rejected_as_cosine_nan(tmp_path: Path) -> None:
    ref = {"w": torch.tensor([1.0, 2.0, 3.0])}
    zero = {"w": torch.tensor([0.0, 0.0, 0.0])}
    peers = [
        _peer("r", _w(tmp_path / "r.pt", ref), 0.7),
        _peer("z", _w(tmp_path / "z.pt", zero), 0.3),
    ]
    res = agg.byzantine_cosine_filter(peers, cosine_reject_threshold=0.3)
    assert math.isnan(res["perPeerCosine"]["z"])
    assert {r["peerId"]: r["reason"] for r in res["rejected"]} == {"z": "cosine_nan"}
    assert res["accepted"] == ["r"]


def test_layout_mismatch_raises(tmp_path: Path) -> None:
    p1 = _w(tmp_path / "a.pt", {"w": torch.tensor([1.0, 2.0])})
    p2 = _w(tmp_path / "b.pt", {"w": torch.tensor([1.0, 2.0, 3.0])})
    with pytest.raises(ValueError):
        agg.byzantine_cosine_filter([_peer("a", p1), _peer("b", p2)], 0.3)


def test_nesterov_cold_start_equals_avg(tmp_path: Path) -> None:
    avg = torch.tensor([1.0, 2.0, 3.0], dtype=torch.float64)
    new_v, update = agg.apply_nesterov_momentum(avg, None, 0.9)
    assert torch.equal(new_v, avg)
    assert torch.equal(update, avg)


def test_nesterov_with_prev_velocity(tmp_path: Path) -> None:
    avg = torch.tensor([1.0, 1.0], dtype=torch.float64)
    prev = torch.tensor([2.0, 2.0], dtype=torch.float64)
    m = 0.9
    new_v, update = agg.apply_nesterov_momentum(avg, prev, m)
    # v_t = m*prev + avg ; update = m*v_t + avg
    exp_v = m * prev + avg
    exp_u = m * exp_v + avg
    assert torch.allclose(new_v, exp_v)
    assert torch.allclose(update, exp_u)


def test_adapter_accumulation_round0_is_update_alone(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 2.0, 3.0])}
    cfg = {
        "gradients": [_peer("a", _w(tmp_path / "a.pt", g))],
        "prevAdapterPath": None,
        "prevVelocityPath": None,
        "momentum": 0.9,
        "cosineRejectThreshold": 0.3,
        "outputAdapterPath": str(tmp_path / "adap.pkl"),
        "outputVelocityPath": str(tmp_path / "vel.pkl"),
    }
    res = agg.aggregate(cfg)
    adapter = pickle.load(open(cfg["outputAdapterPath"], "rb"))
    # round 0, single peer, cold-start velocity → update == avg grad → adapter == grad.
    assert torch.allclose(adapter["w"], g["w"])
    assert res["acceptedPeerIds"] == ["a"]


def test_adapter_accumulation_adds_to_prev(tmp_path: Path) -> None:
    g = {"w": torch.tensor([1.0, 1.0])}
    prev = {"w": torch.tensor([10.0, 20.0])}
    cfg = {
        "gradients": [_peer("a", _w(tmp_path / "a.pt", g))],
        "prevAdapterPath": _w(tmp_path / "prev.pkl", prev),
        "prevVelocityPath": None,
        "momentum": 0.9,
        "cosineRejectThreshold": 0.3,
        "outputAdapterPath": str(tmp_path / "adap.pkl"),
        "outputVelocityPath": str(tmp_path / "vel.pkl"),
    }
    agg.aggregate(cfg)
    adapter = pickle.load(open(cfg["outputAdapterPath"], "rb"))
    # new = prev + update; cold-start update == avg grad == g.
    assert torch.allclose(adapter["w"], prev["w"] + g["w"])


def test_velocity_carryover_pinned_not_local(tmp_path: Path) -> None:
    # A pinned prevVelocity must change the result vs cold-start (§2).
    g = {"w": torch.tensor([1.0, 1.0])}
    prev_vel = {"w": torch.tensor([5.0, 5.0])}
    base = {
        "gradients": [_peer("a", _w(tmp_path / "a.pt", g))],
        "prevAdapterPath": None,
        "momentum": 0.9,
        "cosineRejectThreshold": 0.3,
    }
    cold = dict(base, prevVelocityPath=None,
                outputAdapterPath=str(tmp_path / "c_a.pkl"),
                outputVelocityPath=str(tmp_path / "c_v.pkl"))
    warm = dict(base, prevVelocityPath=_w(tmp_path / "pv.pkl", prev_vel),
                outputAdapterPath=str(tmp_path / "w_a.pkl"),
                outputVelocityPath=str(tmp_path / "w_v.pkl"))
    rc = agg.aggregate(cold)
    rw = agg.aggregate(warm)
    assert rc["velocityNorm"] != rw["velocityNorm"]


def test_invariants_bit_stable_across_runs(tmp_path: Path) -> None:
    g1 = {"w": torch.tensor([1.0, 2.0, 3.0])}
    g2 = {"w": torch.tensor([2.0, 4.0, 6.0])}
    peers = [_peer("a", _w(tmp_path / "a.pt", g1), 0.5),
             _peer("b", _w(tmp_path / "b.pt", g2), 0.5)]
    invs = set()
    for i in range(4):
        cfg = {
            "gradients": peers,
            "prevAdapterPath": None,
            "prevVelocityPath": None,
            "momentum": 0.9,
            "cosineRejectThreshold": 0.3,
            "outputAdapterPath": str(tmp_path / f"a{i}.pkl"),
            "outputVelocityPath": str(tmp_path / f"v{i}.pkl"),
        }
        r = agg.aggregate(cfg)
        invs.add((r["avgGradientNorm"], r["velocityNorm"],
                  tuple(sorted(r["acceptedPeerIds"])),
                  tuple(sorted(x["peerId"] for x in r["rejectedPeerIds"]))))
    assert len(invs) == 1  # consensus key is deterministic given pinned inputs


def test_no_usable_gradients_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        agg.aggregate({
            "gradients": [],
            "prevAdapterPath": None,
            "prevVelocityPath": None,
            "momentum": 0.9,
            "cosineRejectThreshold": 0.3,
            "outputAdapterPath": str(tmp_path / "a.pkl"),
            "outputVelocityPath": str(tmp_path / "v.pkl"),
        })


def test_cli_end_to_end(tmp_path: Path) -> None:
    g1 = {"w": torch.tensor([1.0, 2.0, 3.0])}
    g2 = {"w": torch.tensor([2.0, 4.0, 6.0])}
    opp = {"w": torch.tensor([-1.0, -2.0, -3.0])}
    cfg = {
        "gradients": [
            _peer("x", _w(tmp_path / "x.pt", g1), 0.4),
            _peer("y", _w(tmp_path / "y.pt", g2), 0.4),
            _peer("bad", _w(tmp_path / "bad.pt", opp), 0.2),
        ],
        "prevAdapterPath": None,
        "prevVelocityPath": None,
        "momentum": 0.9,
        "cosineRejectThreshold": 0.3,
        "outputAdapterPath": str(tmp_path / "adap.pkl"),
        "outputVelocityPath": str(tmp_path / "vel.pkl"),
    }
    proc = subprocess.run(
        [sys.executable, "-u", str(SCRIPTS_DIR / "diloco_aggregate_executor.py")],
        input=json.dumps(cfg),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert set(out["acceptedPeerIds"]) == {"x", "y"}
    assert [r["peerId"] for r in out["rejectedPeerIds"]] == ["bad"]
    assert out["participatingNodes"] == 2
    assert os.path.exists(cfg["outputAdapterPath"])
    assert os.path.exists(cfg["outputVelocityPath"])


def _exact_rank_k_grad(rows: int, cols: int, k: int):
    """A dense gradient that is EXACTLY rank-k, so truncated SVD at top_k>=k
    reconstructs it (near-)exactly. Built as A @ B with inner dim k."""
    torch = agg._force_cpu_torch()
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
    truth), NOT a hand-built fixture. The "V" key holds `Vh[:k,:]` (k,cols),
    so the correct reconstruction is `(U * S) @ V` with NO transpose.

    The SQUARE case (16x16) is the critical one: a wrong `V.transpose()`
    does NOT crash there — it silently reconstructs garbage. With the input
    forced to be exactly rank-k, truncated SVD is near-exact, so the
    decompressed tensor must match the original to tight tolerance. If the
    transpose is re-added, the recon error blows up (~O(1)) and this fails."""
    torch = agg._force_cpu_torch()
    original = _exact_rank_k_grad(rows, cols, k)

    # Bundle byte-identical to production: U/S/V are Python lists via .tolist().
    bundle = compress_gradients_svd({"w": original}, top_k=k)["w"]
    assert set(bundle.keys()) >= {"U", "S", "V", "shape"}
    assert isinstance(bundle["U"], list) and isinstance(bundle["S"], list)
    assert isinstance(bundle["V"], list)

    decompressed = agg._decompress_if_svd("w", bundle)
    assert tuple(decompressed.shape) == (rows, cols)
    assert decompressed.dtype == torch.float32
    # atol 1e-4: input is exactly rank-k so truncated SVD is near-exact; the
    # only residual is float32 SVD round-off, comfortably below 1e-4.
    assert torch.allclose(decompressed, original, atol=1e-4), (
        f"recon error {(decompressed - original).abs().max().item():.3e} "
        f"for {rows}x{cols} k={k}"
    )


def test_decompress_svd_list_inputs_match_tensor_inputs() -> None:
    """List-vs-tensor equivalence (regression round 1228): the SAME SVD
    bundle, once with list components and once coerced to tensors, must
    reconstruct identically and never raise `'list' object has no attribute`."""
    torch = agg._force_cpu_torch()
    original = _exact_rank_k_grad(16, 32, 8)
    list_bundle = compress_gradients_svd({"w": original}, top_k=8)["w"]
    tensor_bundle = {
        "U": torch.tensor(list_bundle["U"]),
        "S": torch.tensor(list_bundle["S"]),
        "V": torch.tensor(list_bundle["V"]),
        "shape": list_bundle["shape"],
    }

    dense_from_lists = agg._decompress_if_svd("w", list_bundle)
    dense_from_tensors = agg._decompress_if_svd("w", tensor_bundle)

    assert tuple(dense_from_lists.shape) == tuple(tensor_bundle["shape"])
    assert dense_from_lists.dtype == torch.float32
    assert torch.allclose(dense_from_lists, dense_from_tensors, atol=1e-6)


def test_decompress_raw_fallback_list_input() -> None:
    """The non-SVD `{raw, shape}` fallback (SVD raised on the training side)
    also arrives as a Python list via `.tolist()` and must reconstruct."""
    torch = agg._force_cpu_torch()
    raw = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    out = agg._decompress_if_svd("w", {"raw": raw, "shape": [2, 3]})
    assert tuple(out.shape) == (2, 3)
    assert out.dtype == torch.float32
    assert torch.allclose(out, torch.tensor(raw, dtype=torch.float32))


def test_decompress_unsupported_type_still_raises() -> None:
    """Fail-closed (P2): a genuinely unknown entry (neither tensor,
    dict-SVD/raw, nor array-like) must still raise — never silently skip a
    tensor entry, which would corrupt the average."""
    with pytest.raises(ValueError):
        agg._decompress_if_svd("w", object())


def test_aggregate_end_to_end_with_list_svd_bundle(tmp_path: Path) -> None:
    """Full aggregation over an SVD bundle produced by the ACTUAL
    `compress_gradients_svd` from `diloco_train.py` (U/S/V are Python LISTS,
    the exact on-disk format) must not crash and must produce a reconstructed
    adapter equal to the original dense gradient (rectangular layer)."""
    torch = agg._force_cpu_torch()
    dense = _exact_rank_k_grad(16, 32, 8)
    list_grad = {"w": compress_gradients_svd({"w": dense}, top_k=8)["w"]}
    cfg = {
        "gradients": [_peer("a", _w(tmp_path / "a.pt", list_grad))],
        "prevAdapterPath": None,
        "prevVelocityPath": None,
        "momentum": 0.9,
        "cosineRejectThreshold": 0.3,
        "outputAdapterPath": str(tmp_path / "adap.pkl"),
        "outputVelocityPath": str(tmp_path / "vel.pkl"),
    }
    res = agg.aggregate(cfg)
    assert res["acceptedPeerIds"] == ["a"]
    adapter = pickle.load(open(cfg["outputAdapterPath"], "rb"))
    # round 0, single peer, cold-start → adapter == dense gradient. Input is
    # exactly rank-k so truncated SVD round-trips near-exactly (float32 SVD
    # round-off only) → atol 1e-4.
    assert torch.allclose(adapter["w"].float(), dense, atol=1e-4)


def test_cli_emits_error_json_on_bad_input(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, "-u", str(SCRIPTS_DIR / "diloco_aggregate_executor.py")],
        input="{ not json",
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
    out = json.loads(proc.stdout.strip())
    assert "error" in out
