#!/usr/bin/env python3
"""
Bug 20 v3 (2026-05-18) — RDKit-based ligand 3D conformer generation as
a tier-3 fallback for AutoDock Vina ligand prep.

Why: `obabel --gen3d med` and `--gen3d fast` (Bug 20 v2 two-tier retry)
both timed out 4 consecutive times on
`wo_docking_dp_5542e258-9c6_a_1779120600222_dbf771` — a drug-like ligand
with many rotatable bonds. RDKit's ETKDGv3 conformer generator typically
finishes in under 5s for the same molecule because it uses experimental
torsion-knowledge instead of brute-force conformer enumeration.

Pipeline:
  1. Parse SMILES → RDKit Mol.
  2. Add explicit hydrogens (matches Vina's expectation; obabel does
     this with `-h`).
  3. Embed a single 3D conformer via ETKDGv3 (experimental torsion
     knowledge + universal force field, deterministic per-seed).
  4. Optimize with MMFF94 (the same forcefield obabel falls back to).
  5. Write as PDB. Caller then runs `obabel out.pdb -O ligand.pdbqt`
     for format conversion (no `--gen3d` — just format convert,
     completes in <1s).

Output format: PDB (not PDBQT). PDBQT requires partial charges +
AutoDock atom types which RDKit doesn't emit natively — obabel
post-converts. Total budget budget = 60s RDKit + 10s obabel.

Exit codes:
  0 — success, PDB written
  1 — invalid SMILES (Chem.MolFromSmiles returned None)
  2 — embedding failed (ETKDGv3 returned -1, e.g. impossible geometry)
  3 — optimization failed (MMFFOptimizeMolecule returned -1)
  4 — RDKit not installed in the active venv

Usage:
  docking_rdkit_fallback.py <SMILES> <OUT_PDB_PATH> [--seed N]

P10 reviewer-lesson — comments describe ACTUAL behaviour. The
non-deterministic embedding default is overridden via `randomSeed` so
two pods given the same WO produce the same conformer (deterministic
docking is part of the validation contract).
"""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Tier-3 ligand 3D conformer fallback (Bug 20 v3, 2026-05-18)",
    )
    parser.add_argument("smiles", help="SMILES string to embed")
    parser.add_argument("out_pdb", help="Output PDB file path")
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="ETKDGv3 randomSeed for deterministic conformer (default 42)",
    )
    args = parser.parse_args()

    try:
        from rdkit import Chem  # type: ignore
        from rdkit.Chem import AllChem  # type: ignore
    except ImportError:
        sys.stderr.write(
            "RDKit is not installed in the active Python environment. "
            "Install via `pip install rdkit` in the same venv that runs "
            "the Synapseia node.\n",
        )
        return 4

    mol = Chem.MolFromSmiles(args.smiles)
    if mol is None:
        sys.stderr.write(f"Invalid SMILES: {args.smiles!r}\n")
        return 1

    # Add explicit hydrogens. Vina expects them present in the docking
    # ligand; obabel's `-h` does the same.
    mol = Chem.AddHs(mol)

    # ETKDGv3 — experimental torsion-knowledge distance geometry, 3rd
    # generation. Deterministic with a fixed seed so paired-replication
    # docking remains reproducible across pods.
    params = AllChem.ETKDGv3()
    params.randomSeed = args.seed
    embed_status = AllChem.EmbedMolecule(mol, params)
    if embed_status < 0:
        sys.stderr.write(
            f"ETKDGv3 embedding failed for SMILES {args.smiles!r} (status={embed_status})\n",
        )
        return 2

    # MMFF94 optimization. Matches the FF obabel uses internally so the
    # downstream Vina docking energetics are comparable. Cap at 200
    # iterations — typical drug-like ligand converges in <50.
    opt_status = AllChem.MMFFOptimizeMolecule(mol, maxIters=200)
    if opt_status < 0:
        sys.stderr.write(
            f"MMFF94 optimization failed for SMILES {args.smiles!r} (status={opt_status})\n",
        )
        return 3

    Chem.MolToPDBFile(mol, args.out_pdb)
    sys.stdout.write(f"OK rdkit_etkdg_v3 seed={args.seed} out={args.out_pdb}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
