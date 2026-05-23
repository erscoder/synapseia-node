/**
 * Bug 20 v4 (2026-05-23) — MOLECULAR_DOCKING contention/timeout fixes.
 *
 * Covers the four node-side levers added to relieve obabel gen3d timeouts:
 *   1. nice/cpulimit contention fix — prep spawns wrap with `nice -n 19`.
 *   2. SIGKILL escalation — a child that ignores SIGTERM is SIGKILLed
 *      after a short grace, with no surviving zombie.
 *   3. fast-tier-first ordering — `--gen3d fast` runs FIRST with a short
 *      budget; `--gen3d med` is the fallback.
 *   4. complexity pre-filter — large/flexible ligands skip obabel and go
 *      straight to RDKit (or fail fast with a clear reason).
 *
 * Style mirrors gen3d-retry.spec.ts (injected `__runChildForTests` stub for
 * the tier-ordering / pre-filter logic) and obabel-timeout.spec.ts (real
 * `/bin/sleep` spawn for the kill path, so no long sleeps in CI).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import {
  __prepLigandPdbqtForTests,
  __resetNiceCacheForTests,
  __runChildForTests,
  estimateSmilesComplexity,
  shouldSkipObabelGen3d,
} from '../docker';

type RunChildStub = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number; nice?: boolean; timeoutContext?: { step?: string; input?: string } },
) => Promise<{ stdout: string; stderr: string }>;

const SLEEP_BIN = ['/usr/bin/sleep', '/bin/sleep'].find(existsSync);

// Indinavir (~57 heavy atoms) — a named pod offender that must stay UNDER
// the complexity gate so it still attempts obabel first.
const INDINAVIR =
  'CC(C)(C)NC(=O)[C@@H]1CN(Cc2cccnc2)CCN1C[C@H](O)CC(Cc3ccccc3)C(=O)N[C@H]4[C@H](O)CC5CCCCC54';

describe('Bug 20 v4 — SMILES complexity pre-filter', () => {
  it('small ligand (ethanol) is well under both gates', () => {
    const c = estimateSmilesComplexity('CCO');
    expect(c.heavyAtoms).toBe(3);
    expect(shouldSkipObabelGen3d('CCO')).toBeNull();
  });

  it('Indinavir stays UNDER the heavy-atom gate (still attempts obabel)', () => {
    const c = estimateSmilesComplexity(INDINAVIR);
    // Sanity: a real drug-like ligand counts dozens of heavy atoms but well
    // below the conservative 80 default.
    expect(c.heavyAtoms).toBeGreaterThan(30);
    expect(c.heavyAtoms).toBeLessThanOrEqual(80);
    expect(shouldSkipObabelGen3d(INDINAVIR)).toBeNull();
  });

  it('a pathologically large ligand trips the heavy-atom gate', () => {
    // 100 carbons in a chain → 100 heavy atoms > 80 default gate.
    const huge = 'C'.repeat(100);
    const reason = shouldSkipObabelGen3d(huge);
    expect(reason).toContain('heavy-atom count');
    expect(reason).toContain('100');
  });

  it('a highly flexible chain trips the rotatable-bond gate before the heavy-atom gate', () => {
    // 50 single-bonded carbons → 49 rotatable proxy > 40 default gate, and
    // 50 heavy atoms < 80 so the rotatable gate is what fires first.
    const flexible = 'C'.repeat(50);
    const c = estimateSmilesComplexity(flexible);
    expect(c.heavyAtoms).toBeLessThanOrEqual(80);
    expect(c.rotatableProxy).toBeGreaterThan(40);
    expect(shouldSkipObabelGen3d(flexible)).toContain('rotatable-bond proxy');
  });

  it('multi-bonds are not counted as rotatable (only single bonds between heavy atoms are)', () => {
    // C=C C=C C=C: the two single bonds bridging the three ethene units are
    // rotatable; the three double bonds are not. Proxy must equal the count
    // of inter-unit single bonds (2), not 5.
    const c = estimateSmilesComplexity('C=CC=CC=C');
    expect(c.heavyAtoms).toBe(6);
    expect(c.rotatableProxy).toBe(2);
  });
});

describe('Bug 20 v4 — prepLigandPdbqt fast-tier-first ordering', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syn-v4-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  });

  it('happy path: FAST tier runs first and succeeds → no med call', async () => {
    const runChild = jest.fn<RunChildStub>().mockResolvedValue({ stdout: '', stderr: '' });

    await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
    });

    expect(runChild).toHaveBeenCalledTimes(1);
    const firstArgs = runChild.mock.calls[0]![1];
    // FAST first — inverted from the old med-first order.
    expect(firstArgs).toEqual(expect.arrayContaining(['--gen3d', 'fast', '-h']));
    // Short fast-tier budget (default 90s), NOT the old 300s half-split.
    expect(runChild.mock.calls[0]![2].timeoutMs).toBe(90_000);
    // Prep spawns are niced to yield to torch training.
    expect(runChild.mock.calls[0]![2].nice).toBe(true);
  });

  it('fast tier honors DOCKING_FAST_TIER_MS override clamped to half budget', async () => {
    const runChild = jest.fn<RunChildStub>().mockResolvedValue({ stdout: '', stderr: '' });

    await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 120_000,
      fastTierMs: 90_000, // > half of 120k → clamped to 60k
      __runChildForTests: runChild,
    });

    expect(runChild.mock.calls[0]![2].timeoutMs).toBe(60_000);
  });

  it('fast tier timeout → med tier fallback with the remaining budget', async () => {
    const runChild = jest.fn<RunChildStub>()
      .mockRejectedValueOnce(new Error(
        'Process timed out after 90000ms: obabel ligand.smi -O ligand.pdbqt --gen3d fast -h\n  step: ligand-gen3d-fast',
      ))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await __prepLigandPdbqtForTests('CCO', workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      fastTierMs: 90_000,
      __runChildForTests: runChild,
    });

    expect(runChild).toHaveBeenCalledTimes(2);
    const firstArgs = runChild.mock.calls[0]![1];
    const secondArgs = runChild.mock.calls[1]![1];
    expect(firstArgs).toEqual(expect.arrayContaining(['--gen3d', 'fast', '-h']));
    expect(secondArgs).toEqual(expect.arrayContaining(['--gen3d', 'med', '-h']));
    // Med gets the remaining budget (total - fast = 510s).
    expect(runChild.mock.calls[1]![2].timeoutMs).toBe(510_000);
    expect(runChild.mock.calls[1]![2].nice).toBe(true);
    expect(runChild.mock.calls[1]![2].timeoutContext!.step).toBe('ligand-gen3d-med-retry');
  });

  it('complexity pre-filter: oversized ligand skips obabel and uses RDKit directly', async () => {
    // 100-carbon chain trips the heavy-atom gate. With a stub RDKit helper
    // that succeeds, obabel gen3d must NEVER be invoked.
    const runChild = jest.fn<RunChildStub>().mockResolvedValue({ stdout: '', stderr: '' });

    await __prepLigandPdbqtForTests('C'.repeat(100), workDir, {
      obabelBin: 'obabel',
      obabelTimeoutMs: 600_000,
      __runChildForTests: runChild,
      // tryRdkitFallback runs python then obabel format-convert via the same
      // stub — both resolve here, so the pre-filter path returns success.
    });

    // No `--gen3d` invocation at all — straight to RDKit + format convert.
    const gen3dCalls = runChild.mock.calls.filter((c) => c[1].includes('--gen3d'));
    expect(gen3dCalls).toHaveLength(0);
    // RDKit python step + obabel pdb→pdbqt convert = 2 calls.
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  it('complexity pre-filter: oversized ligand with RDKit unavailable fails fast (timeout-shaped)', async () => {
    // RDKit python step rejects (helper missing) → pre-filter path must
    // throw a timeout-shaped DockingError so submit-result counts it.
    const runChild = jest.fn<RunChildStub>()
      .mockRejectedValue(new Error('spawn python3 ENOENT'));

    await expect(
      __prepLigandPdbqtForTests('C'.repeat(100), workDir, {
        obabelBin: 'obabel',
        obabelTimeoutMs: 600_000,
        __runChildForTests: runChild,
      }),
    ).rejects.toThrow(/timed out \(pre-filter\)/i);

    // obabel gen3d never attempted on a known-doomed ligand.
    const gen3dCalls = runChild.mock.calls.filter((c) => c[1].includes('--gen3d'));
    expect(gen3dCalls).toHaveLength(0);
  });
});

describe('Bug 20 v4 — SIGKILL escalation reaps a SIGTERM-ignoring child', () => {
  const originalGrace = process.env.DOCKING_KILL_GRACE_MS;

  beforeEach(() => {
    __resetNiceCacheForTests();
  });

  afterEach(() => {
    if (originalGrace === undefined) delete process.env.DOCKING_KILL_GRACE_MS;
    else process.env.DOCKING_KILL_GRACE_MS = originalGrace;
  });

  it('runChild SIGKILLs a child that traps SIGTERM after the grace — no zombie left', async () => {
    if (process.platform === 'win32') {
      console.warn('SIGKILL/process-group semantics are POSIX-only; skipping on win32');
      return;
    }
    // Drive the REAL runChild path: a shell that traps SIGTERM and keeps
    // sleeping — exactly the obabel-ignores-SIGTERM zombie scenario. Tiny
    // timeout (50ms) + short grace (300ms) so the test resolves in <1s.
    process.env.DOCKING_KILL_GRACE_MS = '300';

    // Capture the child's PID by spying on the group kill is overkill; instead
    // we spawn through runChild and, after the timeout rejects, confirm no
    // matching `sleep 47` process survives. The marker arg makes the child
    // findable via /proc-independent `ps`.
    const marker = `syn-zombie-${Date.now()}`;
    const promise = __runChildForTests(
      'sh',
      ['-c', `trap "" TERM; exec sleep 47 # ${marker}`],
      { timeoutMs: 50, timeoutContext: { step: 'kill-test' } },
    );

    await expect(promise).rejects.toThrow(/timed out/i);

    // After SIGTERM (ignored) + grace + SIGKILL, the stubborn child must be
    // gone. Poll briefly to let the OS reap it.
    let survived = true;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const found = await new Promise<boolean>((resolve) => {
        const ps = spawn('sh', ['-c', `ps -A -o args 2>/dev/null | grep -F "${marker}" | grep -v grep`]);
        let out = '';
        ps.stdout.on('data', (d) => { out += d.toString(); });
        ps.on('close', () => resolve(out.trim().length > 0));
        ps.on('error', () => resolve(false));
      });
      if (!found) { survived = false; break; }
    }
    expect(survived).toBe(false);
  }, 10_000);

  it('SLEEP_BIN sanity — a normal child runs through runChild without firing the kill path', async () => {
    if (!SLEEP_BIN) {
      console.warn('no /bin/sleep on this host; skipping');
      return;
    }
    // A fast child that exits well within the timeout resolves cleanly.
    await expect(
      __runChildForTests(SLEEP_BIN, ['0.05'], { timeoutMs: 5_000 }),
    ).resolves.toEqual({ stdout: '', stderr: '' });
  });
});
