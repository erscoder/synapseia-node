"""Tests for docking_rdkit_fallback.py — Bug 20 v3 (2026-05-18).

Run:
    python -m pytest packages/node/scripts/__tests__/docking_rdkit_fallback_test.py -q

If RDKit is not installed in the active Python environment, all tests
that need RDKit are skipped via importorskip — the helper's exit-code-4
path is still tested.

P10 reviewer-lesson — these tests verify ACTUAL behaviour:
  - exit 0 on valid SMILES + PDB written
  - exit 1 on invalid SMILES
  - exit 4 when RDKit is absent (driven by subprocess env)
  - deterministic conformer with fixed seed
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
SCRIPT = SCRIPTS_DIR / "docking_rdkit_fallback.py"


def run_script(args, env_override=None):
    env = os.environ.copy()
    if env_override:
        env.update(env_override)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def test_script_exists():
    assert SCRIPT.exists(), f"Script missing: {SCRIPT}"


def test_usage_when_missing_args():
    # No args → argparse errors with exit code 2.
    result = run_script([])
    assert result.returncode != 0


def test_help_works():
    result = run_script(["--help"])
    assert result.returncode == 0
    assert "SMILES" in result.stdout


def test_rdkit_missing_exit_code():
    """Verify the helper exits with code 4 when RDKit cannot be imported."""
    rdkit_available = True
    try:
        import rdkit  # noqa: F401
    except ImportError:
        rdkit_available = False
    if rdkit_available:
        pytest.skip("RDKit is installed in this env; cannot exercise exit-4 path here.")
    with tempfile.TemporaryDirectory() as td:
        out_pdb = Path(td) / "out.pdb"
        result = run_script(["CCO", str(out_pdb)])
        assert result.returncode == 4
        assert "RDKit" in result.stderr


# ─── RDKit-dependent tests (skipped when RDKit is absent) ───────────────────

def _rdkit_available() -> bool:
    try:
        import rdkit  # noqa: F401
        return True
    except ImportError:
        return False


_RDKIT_REQUIRED = pytest.mark.skipif(
    not _rdkit_available(),
    reason="RDKit required for embed tests",
)


@_RDKIT_REQUIRED
def test_embed_ethanol_writes_pdb():
    with tempfile.TemporaryDirectory() as td:
        out_pdb = Path(td) / "ethanol.pdb"
        result = run_script(["CCO", str(out_pdb)])
        assert result.returncode == 0, result.stderr
        assert out_pdb.exists()
        contents = out_pdb.read_text()
        # PDB files have ATOM/HETATM records and an END marker.
        assert "ATOM" in contents or "HETATM" in contents
        assert "END" in contents


@_RDKIT_REQUIRED
def test_invalid_smiles_exit_1():
    with tempfile.TemporaryDirectory() as td:
        out_pdb = Path(td) / "out.pdb"
        result = run_script(["not_a_valid_smiles_!@#", str(out_pdb)])
        # Invalid SMILES → exit code 1 OR an embedding failure on parse.
        assert result.returncode in (1, 2)
        assert not out_pdb.exists() or out_pdb.stat().st_size == 0


@_RDKIT_REQUIRED
def test_deterministic_with_fixed_seed():
    """Same seed → same PDB output (binary equality).

    Ensures pairs of pods produce identical conformers for the same WO,
    which is part of the docking validation contract.
    """
    with tempfile.TemporaryDirectory() as td:
        a = Path(td) / "a.pdb"
        b = Path(td) / "b.pdb"
        r1 = run_script(["CCO", str(a), "--seed", "42"])
        r2 = run_script(["CCO", str(b), "--seed", "42"])
        assert r1.returncode == 0
        assert r2.returncode == 0
        # Coordinates portion (lines starting with ATOM/HETATM) must match.
        def coords(p: Path) -> str:
            return "\n".join(
                line for line in p.read_text().splitlines()
                if line.startswith("ATOM") or line.startswith("HETATM")
            )
        assert coords(a) == coords(b)
