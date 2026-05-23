/**
 * Bug 20 v3 (2026-05-18) — tier-3 RDKit ETKDGv3 fallback tests.
 *
 * Pipeline:
 *   1. obabel --gen3d med  → timeout
 *   2. obabel --gen3d fast → timeout
 *   3. python rdkit_fallback.py <smiles> <out.pdb> → success
 *   4. obabel <out.pdb> -O ligand.pdbqt (format-convert only) → success
 *   → ligand.pdbqt produced via RDKit, no exception.
 *
 * Tests:
 *   - Happy fallback: both obabel tiers time out, RDKit succeeds → return ligand path.
 *   - RDKit not installed (exit 4): rethrow the original obabel timeout.
 *   - RDKit succeeds but format-convert fails: rethrow original timeout.
 *   - Med-tier non-timeout error (ENOENT): rethrow immediately, do NOT call RDKit.
 *
 * Stubs `__runChildForTests` to inject the same fake-spawn used by
 * gen3d-retry.spec.ts. We dispatch on `bin === 'obabel'` vs python
 * binary to model the four-step pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __prepLigandPdbqtForTests } from '../docker';

const TIMEOUT_MSG = 'Process timed out after 300000ms: obabel ligand.smi -O ligand.pdbqt --gen3d med -h';
const FAST_TIMEOUT_MSG = 'Process timed out after 300000ms: obabel ligand.smi -O ligand.pdbqt --gen3d fast -h';

describe('Bug 20 v3 — prepLigandPdbqt RDKit tier-3 fallback', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-rdkit-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  });

  function makePipelineStub(plan: {
    medResult: 'timeout' | 'ok' | 'enoent' | 'never';
    fastResult: 'timeout' | 'ok' | 'enoent' | 'never';
    rdkitResult: 'ok' | 'enoent' | 'rdkit-missing' | 'never';
    formatConvertResult: 'ok' | 'timeout' | 'never';
  }) {
    return jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockImplementation(async (bin: string, args: string[]) => {
        const argStr = args.join(' ');
        if (bin === 'obabel' && argStr.includes('--gen3d med')) {
          if (plan.medResult === 'never') throw new Error('unexpected: med-tier should not be called');
          if (plan.medResult === 'timeout') throw new Error(TIMEOUT_MSG);
          if (plan.medResult === 'enoent') throw new Error('obabel: ENOENT');
          return { stdout: '', stderr: '' };
        }
        if (bin === 'obabel' && argStr.includes('--gen3d fast')) {
          if (plan.fastResult === 'never') throw new Error('unexpected: fast-tier should not be called');
          if (plan.fastResult === 'timeout') throw new Error(FAST_TIMEOUT_MSG);
          if (plan.fastResult === 'enoent') throw new Error('obabel: ENOENT');
          return { stdout: '', stderr: '' };
        }
        // Python RDKit fallback step
        if (bin !== 'obabel' && argStr.includes('rdkit_fallback')) {
          if (plan.rdkitResult === 'never') throw new Error('unexpected: rdkit should not be called');
          if (plan.rdkitResult === 'rdkit-missing') {
            throw new Error('python3 exited with code 4: RDKit is not installed in the active Python environment.');
          }
          if (plan.rdkitResult === 'enoent') throw new Error('python3: ENOENT');
          return { stdout: 'OK rdkit_etkdg_v3 seed=42', stderr: '' };
        }
        // obabel pdb→pdbqt format-convert step (no --gen3d flag)
        if (bin === 'obabel' && !argStr.includes('--gen3d')) {
          if (plan.formatConvertResult === 'never') throw new Error('unexpected: format-convert should not be called');
          if (plan.formatConvertResult === 'timeout') throw new Error('Process timed out after 10000ms: obabel ...');
          return { stdout: '', stderr: '' };
        }
        throw new Error(`unexpected stub call: ${bin} ${argStr}`);
      });
  }

  it('happy fallback: both obabel tiers time out → RDKit produces ligand.pdbqt', async () => {
    const stub = makePipelineStub({
      medResult: 'timeout',
      fastResult: 'timeout',
      rdkitResult: 'ok',
      formatConvertResult: 'ok',
    });
    const out = await __prepLigandPdbqtForTests('CC(C)(C)NC(=O)complex', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      rdkitScriptPath: '/tmp/fake_rdkit_fallback.py',
      pythonBin: 'python3',
      __runChildForTests: stub,
    });
    expect(out).toBe(path.join(workDir, 'ligand.pdbqt'));
    // 4 calls: med (timeout), fast (timeout), rdkit (ok), pdb→pdbqt (ok)
    expect(stub).toHaveBeenCalledTimes(4);
  });

  it('RDKit not installed → rethrow the fast-tier obabel timeout', async () => {
    const stub = makePipelineStub({
      medResult: 'timeout',
      fastResult: 'timeout',
      rdkitResult: 'rdkit-missing',
      formatConvertResult: 'never',
    });
    await expect(__prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      rdkitScriptPath: '/tmp/fake_rdkit_fallback.py',
      pythonBin: 'python3',
      __runChildForTests: stub,
    })).rejects.toThrow(/timed out/i);
    // 3 calls: med, fast, rdkit (fails); format-convert NEVER fires.
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it('RDKit succeeds but format-convert fails → rethrow obabel timeout', async () => {
    const stub = makePipelineStub({
      medResult: 'timeout',
      fastResult: 'timeout',
      rdkitResult: 'ok',
      formatConvertResult: 'timeout',
    });
    await expect(__prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      rdkitScriptPath: '/tmp/fake_rdkit_fallback.py',
      pythonBin: 'python3',
      __runChildForTests: stub,
    })).rejects.toThrow(/timed out/i);
    expect(stub).toHaveBeenCalledTimes(4);
  });

  it('first-tier (fast) non-timeout ENOENT → rethrow immediately, no med/rdkit calls', async () => {
    // Bug 20 v4 (2026-05-23): fast is now the FIRST tier. A non-timeout
    // failure on the first tier must rethrow without trying med or RDKit.
    const stub = makePipelineStub({
      medResult: 'never',
      fastResult: 'enoent',
      rdkitResult: 'never',
      formatConvertResult: 'never',
    });
    await expect(__prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      rdkitScriptPath: '/tmp/fake_rdkit_fallback.py',
      pythonBin: 'python3',
      __runChildForTests: stub,
    })).rejects.toThrow(/ENOENT/);
    // Only the first (fast) tier was attempted.
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('happy path: first-tier (fast) succeeds → no med, no rdkit, no format-convert', async () => {
    // Bug 20 v4 (2026-05-23): fast is now the FIRST tier and succeeds on the
    // common drug-like ligand, so med/RDKit are never reached.
    const stub = makePipelineStub({
      medResult: 'never',
      fastResult: 'ok',
      rdkitResult: 'never',
      formatConvertResult: 'never',
    });
    const out = await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      rdkitScriptPath: '/tmp/fake_rdkit_fallback.py',
      pythonBin: 'python3',
      __runChildForTests: stub,
    });
    expect(out).toBe(path.join(workDir, 'ligand.pdbqt'));
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
