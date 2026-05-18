/**
 * Bug 20 v2 (2026-05-18) — two-tier `obabel --gen3d` retry tests.
 *
 * Pod fleet hit the 600s budget even after Bug 20's 180→600s bump
 * because a single `--gen3d med` invocation on drug-like ligands with
 * many rotatable bonds can exceed 10 minutes. Strategy: split the
 * existing wall budget in half. Run `--gen3d med` first (best
 * conformer quality). On timeout (NOT on other failure modes), retry
 * with `--gen3d fast` — same total budget, but the fast tier finishes
 * in seconds for the same ligands that timed out under med.
 *
 * These tests inject a stub `__runChildForTests` so we exercise the
 * retry decision logic without spawning real obabel. The contract:
 *   1. First call resolves           → no second call (happy path).
 *   2. First call rejects w/ timeout → second call with `--gen3d fast`.
 *   3. First call rejects w/ ENOENT  → rethrow, no second call.
 *
 * Pairs with obabel-timeout.spec.ts (env wiring, message format) and
 * vina-availability.spec.ts (real-binary spawn path).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __prepLigandPdbqtForTests } from '../docker';

describe('Bug 20 v2 — prepLigandPdbqt two-tier --gen3d retry', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-gen3d-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  });

  it('happy path: med tier succeeds → no fast-retry call', async () => {
    const runChild = jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockResolvedValue({ stdout: '', stderr: '' });

    const out = await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
    });

    expect(out).toBe(path.join(workDir, 'ligand.pdbqt'));
    expect(runChild).toHaveBeenCalledTimes(1);
    const args = runChild.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining(['--gen3d', 'med', '-h']));
    // Per-tier budget = total / 2.
    expect((runChild.mock.calls[0]![2] as { timeoutMs: number }).timeoutMs).toBe(300_000);
  });

  it('timeout on med tier → fast tier invoked with same per-tier budget', async () => {
    const runChild = jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockRejectedValueOnce(new Error(
        'Process timed out after 300000ms: obabel ligand.smi -O ligand.pdbqt --gen3d med -h\n  step: ligand-gen3d-med',
      ))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const out = await __prepLigandPdbqtForTests('CC(C)(C)NC(=O)[C@@H]1CN(...)', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
    });

    expect(out).toBe(path.join(workDir, 'ligand.pdbqt'));
    expect(runChild).toHaveBeenCalledTimes(2);

    const firstArgs = runChild.mock.calls[0]![1];
    const secondArgs = runChild.mock.calls[1]![1];
    expect(firstArgs).toEqual(expect.arrayContaining(['--gen3d', 'med', '-h']));
    expect(secondArgs).toEqual(expect.arrayContaining(['--gen3d', 'fast', '-h']));

    // Both tiers honor the per-tier budget (total split in half).
    expect((runChild.mock.calls[0]![2] as { timeoutMs: number }).timeoutMs).toBe(300_000);
    expect((runChild.mock.calls[1]![2] as { timeoutMs: number }).timeoutMs).toBe(300_000);

    // Second call carries a distinct diagnostic step so logs are
    // unambiguous about which tier the timeout came from.
    const secondCtx = (runChild.mock.calls[1]![2] as { timeoutContext: { step: string } }).timeoutContext;
    expect(secondCtx.step).toBe('ligand-gen3d-fast-retry');
  });

  it('non-timeout failure on med tier → rethrow, no fast-retry', async () => {
    const runChild = jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockRejectedValueOnce(new Error('spawn obabel ENOENT'));

    await expect(
      __prepLigandPdbqtForTests('CCO', workDir, {
        obabelBin: 'obabel',
        obabelTimeoutMs: 600_000,
        __runChildForTests: runChild,
      }),
    ).rejects.toThrow(/ENOENT/);

    // Only one call — binary missing / bad SMILES / exit-code failure
    // should NOT be papered over with a retry. P10 / P29 discipline:
    // fail loudly on non-recoverable errors.
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('writes the SMILES file before invoking obabel', async () => {
    const runChild = jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockImplementation(async () => {
        // Assert at spawn time: the .smi file must already exist.
        const smiPath = path.join(workDir, 'ligand.smi');
        const content = await fs.promises.readFile(smiPath, 'utf8');
        expect(content).toBe('CCO\n');
        return { stdout: '', stderr: '' };
      });

    await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
    });

    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('removes partial pdbqt file from failed med tier before fast retry', async () => {
    const ligandPdbqtPath = path.join(workDir, 'ligand.pdbqt');
    // Simulate a partial-write artifact from the timed-out med run.
    await fs.promises.writeFile(ligandPdbqtPath, 'PARTIAL', 'utf8');

    const runChild = jest.fn<(bin: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>>()
      .mockRejectedValueOnce(new Error('Process timed out after 300000ms: obabel'))
      .mockImplementationOnce(async () => {
        // At fast-retry time the partial must already be gone.
        await expect(fs.promises.access(ligandPdbqtPath)).rejects.toThrow();
        return { stdout: '', stderr: '' };
      });

    await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
    });

    expect(runChild).toHaveBeenCalledTimes(2);
  });
});
