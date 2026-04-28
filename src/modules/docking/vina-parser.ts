import type { AtomCoord, DockingPose } from './types';

/**
 * AutoDock Vina v1.2.5 emits PDBQT files with one MODEL per pose.
 * Each MODEL contains a `REMARK VINA RESULT:` line with affinity and
 * the lower/upper-bound RMSD vs the rank-1 pose, plus a sequence of
 * ATOM/HETATM records (PDBQT format).
 *
 * Example (truncated):
 *   MODEL 1
 *   REMARK VINA RESULT:    -8.500    0.000    0.000
 *   ATOM      1  C1  LIG A   1       1.234   2.345   3.456  1.00  0.00     0.000 C
 *   ...
 *   ENDMDL
 *   MODEL 2
 *   REMARK VINA RESULT:    -8.300    1.234    2.345
 *   ...
 *
 * This parser is intentionally pure — no I/O, no subprocess. Hand it the
 * PDBQT text, get back the parsed pose list. Tested in isolation.
 */

const VINA_RESULT_RE = /^REMARK\s+VINA\s+RESULT:\s+(-?\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)/;

/**
 * Map PDBQT atom-type codes (cols 77-78) to standard element symbols.
 * Vina uses extended types like A=aromatic carbon, OA=H-bond acceptor O,
 * HD=H-bond donor H, NA=H-bond acceptor N, SA=H-bond acceptor S.
 */
function pdbqtTypeToElement(pdbqtType: string): string {
  const t = pdbqtType.trim().toUpperCase();
  switch (t) {
    case 'A': return 'C';     // aromatic carbon
    case 'C': return 'C';
    case 'N': case 'NA': return 'N';
    case 'O': case 'OA': return 'O';
    case 'S': case 'SA': return 'S';
    case 'P': return 'P';
    case 'F': return 'F';
    case 'CL': return 'Cl';
    case 'BR': return 'Br';
    case 'I': return 'I';
    case 'H': case 'HD': return 'H';
    default:
      // Fallback: take the leading alpha chars as-is (best effort).
      const m = t.match(/^[A-Z]+/);
      return m ? (m[0][0] + m[0].slice(1).toLowerCase()) : t;
  }
}

interface PartialPose {
  rank: number;
  affinity?: number;
  rmsdLb?: number;
  rmsdUb?: number;
  atoms: AtomCoord[];
}

export function parseVinaPdbqt(text: string): DockingPose[] {
  const lines = text.split(/\r?\n/);
  const poses: PartialPose[] = [];
  let current: PartialPose | null = null;
  let nextRank = 1;

  for (const line of lines) {
    if (line.startsWith('MODEL')) {
      // MODEL <n> — we ignore the embedded number and use our own counter
      // because some PDBQT writers leave it as 0 / blank.
      current = { rank: nextRank++, atoms: [] };
      poses.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('ENDMDL')) {
      current = null;
      continue;
    }
    if (line.startsWith('REMARK')) {
      const m = line.match(VINA_RESULT_RE);
      if (m) {
        current.affinity = parseFloat(m[1]);
        current.rmsdLb = parseFloat(m[2]);
        current.rmsdUb = parseFloat(m[3]);
      }
      continue;
    }
    if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
      // PDBQT fixed-width columns. Note: PDBQT extends PDB by adding
      // partial charge (cols 67-76) and atom type (cols 77-78).
      // Columns are 1-indexed in spec; substring is 0-indexed.
      const serial = parseInt(line.slice(6, 11).trim(), 10);
      const x = parseFloat(line.slice(30, 38).trim());
      const y = parseFloat(line.slice(38, 46).trim());
      const z = parseFloat(line.slice(46, 54).trim());
      const pdbqtType = line.length >= 77 ? line.slice(76, 78) : '';
      const element = pdbqtTypeToElement(pdbqtType);
      if (!Number.isFinite(serial) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        // Malformed atom record — skip it rather than crash the whole parse.
        // The verification gate will catch the resulting atom-count mismatch.
        continue;
      }
      current.atoms.push({ serial, element, x, y, z });
    }
  }

  // Drop any pose missing a REMARK VINA RESULT — Vina always writes one,
  // so a missing line means the file is corrupted or truncated.
  return poses
    .filter(p => p.affinity !== undefined && p.rmsdLb !== undefined && p.rmsdUb !== undefined)
    .map<DockingPose>(p => ({
      rank: p.rank,
      affinity: p.affinity!,
      rmsdLb: p.rmsdLb!,
      rmsdUb: p.rmsdUb!,
      atoms: p.atoms,
    }));
}
