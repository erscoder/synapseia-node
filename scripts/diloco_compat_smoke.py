#!/usr/bin/env python3
"""DiLoCo torch-bump compat smoke test (audit item WS3).

PURPOSE
    Guard the ONE property a torch/numpy bump must preserve: the DiLoCo
    consensus key is the set of SCALAR INVARIANTS the aggregate executor
    emits (avgGradientNorm, velocityNorm, accepted/rejected peer sets).
    The coordinator reaches consensus on those scalars with a tolerance;
    it never compares adapter byte hashes (torch tensor pickling embeds
    non-deterministic storage metadata, so the adapter sha256 is
    informational only — design section 4.2). This harness therefore
    asserts INVARIANT STABILITY, not adapter-byte equality.

WHAT IT DOES
    Runs the REAL aggregation path (diloco_aggregate_executor.aggregate +
    diloco_train.compress_gradients_svd — the production source of truth,
    NOT a reimplementation) TWICE over byte-identical, seeded inputs and
    asserts every consensus-key invariant is bit-equal across the two runs.
    Any drift exits non-zero.

SCOPE
    Pure aggregation path only — does NOT import transformers and never
    loads a model, so it runs in any venv with torch installed (the full
    train pipeline needs the pinned /opt/training-venv that the Dockerfile
    builds). Everything is seeded; the path is CPU-pinned by the executor.

    NOTE on pickle: the on-disk gradient/adapter format produced by
    diloco_train.py and consumed by diloco_aggregate_executor.py is pickle.
    This harness reads/writes only its OWN, locally-generated fixtures in a
    private tempdir, never untrusted input, so it matches the production
    contract without introducing a deserialization risk.

AUTHORITATIVE RUN
    The version that matters for a release runs INSIDE the pinned
    torch==2.5.1 venv in CI (see test:diloco-compat in package.json). A
    green run on some other locally-installed torch only proves the path
    is version-robust on that machine — it is NOT the release gate.

USAGE
    python3 scripts/diloco_compat_smoke.py
    exit 0 = invariants stable; exit non-zero = invariant drift (BLOCKER).
"""

from __future__ import annotations

import pickle
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Tuple

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

try:
    import torch  # noqa: F401  (presence check; executor imports it itself)
except Exception as exc:  # pragma: no cover - torch missing is an env error
    print(f"[diloco-compat] FAIL: torch is not importable: {exc}", file=sys.stderr)
    sys.exit(2)

import diloco_aggregate_executor as agg  # noqa: E402
from diloco_train import compress_gradients_svd  # noqa: E402 — REAL compressor

# Deterministic, fixed inputs. No randomness leaks into the consensus key;
# the only seeded RNG builds a reproducible rank-k gradient for the SVD path.
_SEED = 20260529


def _torch():
    return agg._force_cpu_torch()


def _write_fixture(path: Path, obj: Dict[str, Any]) -> str:
    # Local, self-generated fixture only (see module docstring) — matches the
    # production on-disk format that diloco_train/diloco_aggregate_executor use.
    with open(path, "wb") as fh:
        pickle.dump(obj, fh)
    return str(path)


def _exact_rank_k_grad(rows: int, cols: int, k: int):
    """A dense gradient that is EXACTLY rank-k (A @ B with inner dim k) so the
    SVD round-trip in the executor is near-exact and fully reproducible."""
    t = _torch()
    t.manual_seed(_SEED)
    a = t.randn(rows, k)
    b = t.randn(k, cols)
    return (a @ b).float()


def _build_peers(tmp: Path):
    """Fixed peer set exercising the full filter: two aligned peers (kept),
    one opposite peer (rejected cosine_low) — same shapes every run."""
    t = _torch()
    aligned_a = {"w": t.tensor([1.0, 2.0, 3.0, 4.0])}
    aligned_b = {"w": t.tensor([2.0, 4.0, 6.0, 8.0])}
    opposite = {"w": t.tensor([-1.0, -2.0, -3.0, -4.0])}
    return [
        {"peerId": "a", "gradientPath": _write_fixture(tmp / "a.pt", aligned_a), "stakeWeight": 0.4},
        {"peerId": "b", "gradientPath": _write_fixture(tmp / "b.pt", aligned_b), "stakeWeight": 0.4},
        {"peerId": "bad", "gradientPath": _write_fixture(tmp / "bad.pt", opposite), "stakeWeight": 0.2},
    ]


def _invariant_key(res: Dict[str, Any]) -> Tuple[Any, ...]:
    """The consensus key (design section 4.2). The adapter pickle / sha256 is
    deliberately EXCLUDED — it is informational only and non-deterministic."""
    return (
        repr(res["avgGradientNorm"]),                       # bit-exact float repr
        repr(res["velocityNorm"]),
        tuple(sorted(res["acceptedPeerIds"])),
        tuple(sorted((r["peerId"], r["reason"]) for r in res["rejectedPeerIds"])),
        res["participatingNodes"],
        tuple(sorted(
            (pid, repr(cos)) for pid, cos in res["perPeerCosine"].items()
        )),
    )


def _run_once(label: str) -> Dict[str, Any]:
    """One full aggregation over fixed inputs in an isolated tmp dir.

    Also drives a real SVD bundle through compress_gradients_svd so the bump
    re-validates the production compress/decompress path, not just dense
    tensors. The SVD aggregation uses a SEPARATE config (its flat layout
    differs from the dense peers) but feeds the same invariant check."""
    with tempfile.TemporaryDirectory(prefix=f"diloco_compat_{label}_") as d:
        tmp = Path(d)
        dense_cfg = {
            "gradients": _build_peers(tmp),
            "prevAdapterPath": None,
            "prevVelocityPath": None,
            "momentum": 0.9,
            "cosineRejectThreshold": 0.3,
            "outputAdapterPath": str(tmp / "adapter.pkl"),
            "outputVelocityPath": str(tmp / "velocity.pkl"),
        }
        dense_res = agg.aggregate(dense_cfg)

        # Real SVD bundle from the production compressor (U/S/V are Python
        # lists via .tolist(), the exact on-disk format).
        dense = _exact_rank_k_grad(16, 32, 8)
        svd_grad = {"w": compress_gradients_svd({"w": dense}, top_k=8)["w"]}
        svd_cfg = {
            "gradients": [{
                "peerId": "svd",
                "gradientPath": _write_fixture(tmp / "svd.pt", svd_grad),
                "stakeWeight": 1.0,
            }],
            "prevAdapterPath": None,
            "prevVelocityPath": None,
            "momentum": 0.9,
            "cosineRejectThreshold": 0.3,
            "outputAdapterPath": str(tmp / "svd_adapter.pkl"),
            "outputVelocityPath": str(tmp / "svd_velocity.pkl"),
        }
        svd_res = agg.aggregate(svd_cfg)

    return {"dense": dense_res, "svd": svd_res}


def main() -> int:
    torch_version = getattr(_torch(), "__version__", "unknown")
    print(f"[diloco-compat] running against torch=={torch_version}")
    print(
        "[diloco-compat] NOTE: the AUTHORITATIVE pre-release run MUST use the "
        "pinned torch==2.5.1 venv (/opt/training-venv) in CI. A pass here only "
        "shows the consensus-key path is version-robust on THIS torch."
    )

    run1 = _run_once("run1")
    run2 = _run_once("run2")

    failures = []
    for path in ("dense", "svd"):
        k1 = _invariant_key(run1[path])
        k2 = _invariant_key(run2[path])
        if k1 != k2:
            failures.append(
                f"INVARIANT DRIFT in '{path}' path across identical runs:\n"
                f"  run1={k1}\n  run2={k2}"
            )

    if failures:
        for f in failures:
            print(f"[diloco-compat] FAIL: {f}", file=sys.stderr)
        print(
            "[diloco-compat] FAIL: consensus-key invariants are NOT stable on "
            f"torch=={torch_version}. Do NOT ship this bump.",
            file=sys.stderr,
        )
        return 1

    sample = run1["dense"]
    print(
        "[diloco-compat] PASS: consensus-key invariants bit-stable across runs.\n"
        f"           avgGradientNorm={sample['avgGradientNorm']!r}\n"
        f"           velocityNorm={sample['velocityNorm']!r}\n"
        f"           accepted={sorted(sample['acceptedPeerIds'])} "
        f"rejected={[r['peerId'] for r in sample['rejectedPeerIds']]}\n"
        "           (adapter sha256 intentionally NOT checked — informational "
        "only, non-deterministic; section 4.2)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
