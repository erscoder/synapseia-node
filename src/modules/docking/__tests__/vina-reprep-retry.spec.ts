/**
 * Bug 20 v5 (2026-05-26) — Vina parse/tree-error re-prep + single retry.
 *
 * Live failure on an operator's Mac node: `vina` exits code 1 with
 *   "An internal error occurred in ../../../src/lib/tree.h(101)"
 * because the `obabel --gen3d fast` (fast-tier) ligand PDBQT had a
 * degenerate/malformed torsion tree that Vina rejects at parse time. The
 * documented `med` fallback existed in `prepLigandPdbqt` but was keyed on
 * an obabel PREP timeout, never on a Vina rejection, so the WO just failed
 * even though a `med`/RDKit re-prep would have salvaged it.
 *
 * The fix wires `runDocking` to: on a Vina parse/tree error (NOT a timeout,
 * NOT a genuine "no poses" result), re-prep the ligand with
 * `forceTier: 'med'` and retry Vina exactly once. If the retry also fails,
 * the WO fails as before (no infinite loop).
 *
 * DETERMINISM: the tier escalation is keyed only on the SMILES + failure
 * class, never on a random seed or wall-clock — so both nodes of a docking
 * pair escalate identically and tolerance-based pair consensus is preserved.
 *
 * These tests inject `__runChildForTests` (obabel prep) and
 * `__runVinaForTests` (Vina) so the retry decision is exercised without
 * spawning real binaries. They stub the real-binary precheck the same way
 * the other docking specs do (`/usr/bin/true`).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDocking, isVinaLigandParseError, __resetVinaCacheForTests } from '../docker';
import type { DockingWorkOrderPayload } from '../types';

import { existsSync } from 'fs';
const TRUE_BIN = ['/usr/bin/true', '/bin/true'].find(existsSync)!;

const VINA_TREE_ERROR =
  'vina exited with code 1: \nAn internal error occurred in ../../../src/lib/tree.h(101)\n';

// Minimal one-pose Vina PDBQT the parser accepts (one MODEL, one VINA
// RESULT remark, one ATOM record at fixed PDBQT columns).
const VALID_OUT_PDBQT = [
  'MODEL 1',
  'REMARK VINA RESULT:    -8.500    0.000    0.000',
  'ATOM      1  C   LIG A   1       1.234   2.345   3.456  1.00  0.00     0.000 C',
  'ENDMDL',
  '',
].join('\n');

function makePayload(): DockingWorkOrderPayload {
  return {
    pairId: 'wo_docking_dp_test_pair',
    missionId: 'mission_test',
    receptorPdbId: '1IEP',
    // Imatinib (1IEP ligand) — the live offender. ~59 chars, under the
    // complexity gate so the normal fast tier IS attempted first.
    ligandSmiles: 'Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1',
    bindingSite: { x: 0, y: 0, z: 0, sizeX: 20, sizeY: 20, sizeZ: 20 },
    vinaSeed: 'deadbeefcafef00d',
    vinaVersion: '1.2.5',
    vinaParams: { exhaustiveness: 8, num_modes: 9, energy_range: 3 },
    slot: 'A',
  };
}

describe('Bug 20 v5 — isVinaLigandParseError classifier', () => {
  it('classifies a Vina tree.h internal-error as a ligand parse error', () => {
    expect(isVinaLigandParseError(new Error(VINA_TREE_ERROR))).toBe(true);
  });

  it('does NOT classify a Vina timeout as a parse error', () => {
    expect(
      isVinaLigandParseError(
        new Error('Process timed out after 1200000ms: vina --receptor r.pdbqt --ligand l.pdbqt'),
      ),
    ).toBe(false);
  });

  it('does NOT classify a non-Error value as a parse error', () => {
    expect(isVinaLigandParseError('tree.h(101)')).toBe(false);
    expect(isVinaLigandParseError(undefined)).toBe(false);
  });
});

describe('Bug 20 v5 — runDocking Vina parse/tree re-prep + single retry', () => {
  let workDir: string;

  beforeEach(async () => {
    __resetVinaCacheForTests();
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-vina-reprep-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  });

  function obabelStub() {
    // Receptor protonation + ligand gen3d all succeed (write nothing — the
    // ligand .pdbqt content is irrelevant because Vina is stubbed). The
    // receptor prep path uses prepReceptorPdbqt which also goes through
    // runChild; we accept any obabel invocation as success.
    return jest
      .fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockResolvedValue({ stdout: '', stderr: '' });
  }

  it('parse/tree failure on fast tier → re-prep med → Vina succeeds → result returned', async () => {
    const obabel = obabelStub();

    // Vina: first call (fast-tier ligand) rejects with a tree error; second
    // call (med re-prep) writes a valid out.pdbqt and resolves.
    let vinaCalls = 0;
    const ligandPaths: string[] = [];
    const runVina = jest
      .fn<(args: { ligandPath: string; outPath: string }) => Promise<void>>()
      .mockImplementation(async ({ ligandPath, outPath }) => {
        vinaCalls += 1;
        ligandPaths.push(ligandPath);
        if (vinaCalls === 1) throw new Error(VINA_TREE_ERROR);
        await fs.promises.writeFile(outPath, VALID_OUT_PDBQT, 'utf8');
      });

    const result = await runDocking(
      { workOrderId: 'wo_1', peerId: 'peer_1', payload: makePayload() },
      {
        workDir,
        vinaBin: TRUE_BIN,
        obabelBin: TRUE_BIN,
        __runChildForTests: obabel,
        __runVinaForTests: runVina as any,
        hardwareReporter: async () => ({ cpu: 'test', ramMb: 1024 }),
      },
    );

    // Result salvaged from the med re-prep, not failed.
    expect(result.bestAffinity).toBe(-8.5);
    expect(result.poses).toHaveLength(1);
    expect(result.resultHash).toMatch(/^sha256:/);

    // Vina invoked exactly twice (one reject + one retry).
    expect(runVina).toHaveBeenCalledTimes(2);

    // The med re-prep skipped the fast tier: it ran obabel `--gen3d med`
    // (and never `--gen3d fast`) on the re-prep pass. Assert at least one med
    // invocation exists in the obabel call log.
    const medCalls = obabel.mock.calls.filter(c => c[1].join(' ').includes('--gen3d med'));
    expect(medCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('Vina TIMEOUT does NOT trigger re-prep — WO fails after one Vina call', async () => {
    const obabel = obabelStub();

    const runVina = jest
      .fn<(args: { ligandPath: string; outPath: string }) => Promise<void>>()
      .mockRejectedValue(
        new Error('Process timed out after 1200000ms: vina --receptor r --ligand l'),
      );

    await expect(
      runDocking(
        { workOrderId: 'wo_2', peerId: 'peer_1', payload: makePayload() },
        {
          workDir,
          vinaBin: TRUE_BIN,
          obabelBin: TRUE_BIN,
          __runChildForTests: obabel,
          __runVinaForTests: runVina as any,
        },
      ),
    ).rejects.toThrow(/timed out/i);

    // A timeout is a different failure class — Vina is NOT retried, and no
    // med re-prep happens.
    expect(runVina).toHaveBeenCalledTimes(1);
    const medCalls = obabel.mock.calls.filter(c => c[1].join(' ').includes('--gen3d med'));
    expect(medCalls.length).toBe(0);
  });

  it('genuine "no poses" (Vina exit 0, empty out) does NOT trigger re-prep', async () => {
    const obabel = obabelStub();

    // Vina resolves but writes an out.pdbqt with no parseable poses.
    const runVina = jest
      .fn<(args: { outPath: string }) => Promise<void>>()
      .mockImplementation(async ({ outPath }) => {
        await fs.promises.writeFile(outPath, 'REMARK no models here\n', 'utf8');
      });

    await expect(
      runDocking(
        { workOrderId: 'wo_3', peerId: 'peer_1', payload: makePayload() },
        {
          workDir,
          vinaBin: TRUE_BIN,
          obabelBin: TRUE_BIN,
          __runChildForTests: obabel,
          __runVinaForTests: runVina as any,
        },
      ),
    ).rejects.toThrow(/produced no poses/i);

    // "no poses" is a DockingError(stage='parse'), NOT a Vina rejection — no
    // retry, no med re-prep.
    expect(runVina).toHaveBeenCalledTimes(1);
    const medCalls = obabel.mock.calls.filter(c => c[1].join(' ').includes('--gen3d med'));
    expect(medCalls.length).toBe(0);
  });

  it('still fails after the med retry → WO fails (exactly one retry, no loop)', async () => {
    const obabel = obabelStub();

    // Both Vina calls reject with a tree error.
    const runVina = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error(VINA_TREE_ERROR));

    await expect(
      runDocking(
        { workOrderId: 'wo_4', peerId: 'peer_1', payload: makePayload() },
        {
          workDir,
          vinaBin: TRUE_BIN,
          obabelBin: TRUE_BIN,
          __runChildForTests: obabel,
          __runVinaForTests: runVina as any,
        },
      ),
    ).rejects.toThrow(/tree\.h/);

    // Exactly two Vina calls: the original + ONE retry. No infinite loop.
    expect(runVina).toHaveBeenCalledTimes(2);
  });

  it('tier decision is deterministic — same parse-error input yields the same single med escalation twice', async () => {
    const runOnce = async (woId: string) => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-vina-det-'));
      const obabel = obabelStub();
      let calls = 0;
      const runVina = jest
        .fn<(args: { outPath: string }) => Promise<void>>()
        .mockImplementation(async ({ outPath }) => {
          calls += 1;
          if (calls === 1) throw new Error(VINA_TREE_ERROR);
          await fs.promises.writeFile(outPath, VALID_OUT_PDBQT, 'utf8');
        });
      try {
        await runDocking(
          { workOrderId: woId, peerId: 'peer_1', payload: makePayload() },
          {
            workDir: dir,
            vinaBin: TRUE_BIN,
            obabelBin: TRUE_BIN,
            __runChildForTests: obabel,
            __runVinaForTests: runVina as any,
            hardwareReporter: async () => ({ cpu: 'test', ramMb: 1024 }),
          },
        );
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
      }
      // The escalation tier sequence on the re-prep pass — only `med` (never
      // `fast`) should appear on the second prep.
      return {
        vinaCalls: runVina.mock.calls.length,
        usedMed: obabel.mock.calls.some(c => c[1].join(' ').includes('--gen3d med')),
        usedFastOnReprep: obabel.mock.calls.filter(c => c[1].join(' ').includes('--gen3d fast')).length,
      };
    };

    const a = await runOnce('wo_det_a');
    const b = await runOnce('wo_det_b');

    // Identical escalation behaviour across two independent runs of the same
    // SMILES + same parse-error class → both nodes of a pair escalate the
    // same way (deterministic, symmetric).
    expect(a).toEqual(b);
    expect(a.vinaCalls).toBe(2);
    expect(a.usedMed).toBe(true);
    // Exactly one `--gen3d fast` invocation total (the original prep); the
    // med re-prep never re-runs fast.
    expect(a.usedFastOnReprep).toBe(1);
  });
});
