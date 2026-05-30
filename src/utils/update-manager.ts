/**
 * update-manager.ts — periodic update orchestration for a running node.
 *
 * Owns the lifecycle concern of "keep this node on a current version
 * without ever interrupting a running training work order or taking the
 * fleet down in a restart loop". It is deliberately decoupled from the
 * pure check/install/restart primitives:
 *
 *   - `preflightVersionCheck` (update-checker.ts) decides UP_TO_DATE /
 *     UPDATE_AVAILABLE / UPDATE_REQUIRED. npm is the source of truth for
 *     the latest version; coord only supplies the security floor.
 *   - `attemptSelfUpdate` (self-updater.ts) installs the npm-resolved target
 *     version directly (`npm install -g @synapseia-network/node@<target>
 *     --ignore-scripts`), fail-closed. npm `latest` is the trust anchor;
 *     `--ignore-scripts` is the residual supply-chain mitigation.
 *   - `restartProcess` (self-updater.ts) flushes telemetry + p2p and, for
 *     unsupervised pods/shell runs, spawns a detached replacement before
 *     exiting.
 *
 * Everything this module reaches out to is injected via `UpdateManagerDeps`
 * so the whole orchestration — boot wiring, periodic timer, idle-gating,
 * loop-protection caps — is unit-testable with fake timers and stubs, no
 * real network / install / restart.
 *
 * SAFETY INVARIANTS (a regression here can take down the whole fleet):
 *   1. The boot check + periodic re-check NEVER block node startup or its
 *      normal operation. Every step is wrapped fail-closed: a thrown error
 *      logs and the node continues on its current version.
 *   2. A restart is only triggered when the node is IDLE — no HEAVY
 *      (training) work order in flight. A successful install while a HEAVY
 *      slot is occupied DEFERS the restart to the next idle re-check.
 *   3. At most one restart per check cycle, and at most
 *      `MAX_SELF_UPDATE_ATTEMPTS` install attempts per process lifetime,
 *      with exponential backoff between attempts. After a successful
 *      install, if the re-exec'd process is still not at the target
 *      version (failed install), we stop trying this lifetime rather than
 *      loop.
 */

import { lt, valid } from 'semver';
import logger from './logger';
import { getNodeVersion } from './version';
import {
  preflightVersionCheck,
  UpdateStatus,
  type UpdateCheckResult,
} from './update-checker';
import {
  attemptSelfUpdate,
  restartProcess,
  type SelfUpdateResult,
  type RestartShutdownHandles,
} from './self-updater';

/** Default re-check cadence. 30 min keeps the fleet current within an
 *  hour of a release without hammering npm / coord. Named const, not an
 *  operator-facing env var (project policy: operators don't configure
 *  env). */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Hard cap on install attempts per process lifetime. A restart loop
 *  (install → re-exec → still-stale → install …) would ripple across
 *  every pod that points at the same coord, so this is the primary
 *  fleet-safety brake. 2 attempts covers a transient npm hiccup on the
 *  first try without ever spinning. */
export const MAX_SELF_UPDATE_ATTEMPTS = 2;

/** Base backoff applied between install attempts; doubled each attempt.
 *  Cheap to keep small — the periodic re-check cadence already spaces
 *  cycles out by `UPDATE_CHECK_INTERVAL_MS`; this only guards against a
 *  same-process retry storm if multiple cycles fire close together. */
export const SELF_UPDATE_BACKOFF_BASE_MS = 60 * 1000;

/** Env var the manager sets on the SAME process env right before a
 *  self-update restart. It is inherited by the detached respawn (which
 *  copies `process.env`) so the freshly-booted process can detect "I was
 *  just restarted to reach vX". If that process is STILL below vX, the
 *  install did not take and we must NOT loop across process lifetimes —
 *  this is the cross-lifetime arm of the loop-protection in §5. */
export const SELF_UPDATE_TARGET_ENV = 'SYNAPSEIA_SELF_UPDATE_TARGET';

export interface UpdateManagerDeps {
  /** Coordinator base URL. Used only for the security-floor check
   *  (`minNodeVersion`); the install target comes from npm, not coord. */
  coordinatorUrl: string;
  /**
   * Number of HEAVY (training) work orders currently in flight. The node
   * is restart-eligible only when this is 0. Backed by
   * `BackpressureService.getInFlightByClass('HEAVY')`.
   */
  getActiveHeavyCount: () => number;
  /**
   * Toggle the BackpressureService drain latch. Set true right before
   * the (multi-minute) npm install so `acquire('HEAVY')` refuses NEW
   * training work during the install→restart window; cleared on any
   * abort path so a deferred/failed update never permanently blocks
   * HEAVY acceptance. Backed by `BackpressureService.setDraining`.
   */
  setDraining: (draining: boolean) => void;
  /**
   * Graceful-shutdown handles forwarded to `restartProcess` so telemetry
   * + p2p are flushed and (for unsupervised runs) a detached replacement
   * is spawned before exit. The manager always sets `respawn: true`;
   * `restartProcess` itself gates the actual respawn on the launch source
   * (UI runs are excluded).
   */
  restartHandles: Omit<RestartShutdownHandles, 'respawn'>;
  /** Injected for tests. Defaults to the real `preflightVersionCheck`. */
  checkFn?: (coordinatorUrl: string) => Promise<UpdateCheckResult | null>;
  /** Injected for tests. Defaults to the real `attemptSelfUpdate`. Called
   *  with the npm-resolved target version to install (pinned). */
  selfUpdateFn?: (targetVersion: string) => Promise<SelfUpdateResult>;
  /** Injected for tests. Defaults to the real `restartProcess`. */
  restartFn?: (handles: RestartShutdownHandles) => Promise<never>;
  /** Injected for tests. Defaults to the real `getNodeVersion`. */
  getCurrentVersion?: () => string;
  /**
   * Read/write the cross-lifetime "I was just restarted to reach vX"
   * marker. Defaults to `process.env[SELF_UPDATE_TARGET_ENV]` accessors.
   * Injected so tests can exercise the post-restart-still-stale latch
   * without mutating the real process env.
   */
  getRestartTarget?: () => string | undefined;
  setRestartTarget?: (version: string) => void;
  /** Re-check cadence override (tests). Defaults to UPDATE_CHECK_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Orchestrates the boot check + periodic re-check + idle-gated self-update
 * restart for the lifetime of the process. Construct once in the CLI start
 * path, call `start()` (non-blocking) right after the runtime boots, and
 * `stop()` on shutdown.
 */
export class UpdateManager {
  private readonly coordinatorUrl: string;
  private readonly getActiveHeavyCount: () => number;
  private readonly setDraining: (draining: boolean) => void;
  private readonly restartHandles: Omit<RestartShutdownHandles, 'respawn'>;
  private readonly checkFn: (url: string) => Promise<UpdateCheckResult | null>;
  private readonly selfUpdateFn: (targetVersion: string) => Promise<SelfUpdateResult>;
  private readonly restartFn: (handles: RestartShutdownHandles) => Promise<never>;
  private readonly getCurrentVersion: () => string;
  private readonly getRestartTarget: () => string | undefined;
  private readonly setRestartTarget: (version: string) => void;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private cycleInProgress = false;
  /** Install attempts consumed this process lifetime (loop-protection). */
  private attempts = 0;
  /**
   * Latched once the attempt cap is hit OR a post-install version check
   * shows the install did not take. Once true, no further install is
   * attempted this lifetime — the node stays on its current version and
   * logs rather than looping.
   */
  private giveUp = false;

  constructor(deps: UpdateManagerDeps) {
    this.coordinatorUrl = deps.coordinatorUrl;
    this.getActiveHeavyCount = deps.getActiveHeavyCount;
    this.setDraining = deps.setDraining;
    this.restartHandles = deps.restartHandles;
    this.checkFn = deps.checkFn ?? preflightVersionCheck;
    this.selfUpdateFn = deps.selfUpdateFn ?? attemptSelfUpdate;
    this.restartFn = deps.restartFn ?? restartProcess;
    this.getCurrentVersion = deps.getCurrentVersion ?? getNodeVersion;
    this.getRestartTarget =
      deps.getRestartTarget ?? (() => process.env[SELF_UPDATE_TARGET_ENV]);
    this.setRestartTarget =
      deps.setRestartTarget ??
      ((version: string) => {
        process.env[SELF_UPDATE_TARGET_ENV] = version;
      });
    this.intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  }

  /**
   * Cross-lifetime loop-protection. If this process was spawned by a prior
   * self-update aiming for vX (marker env var present) but the running
   * version is STILL below vX, the install silently failed. Returning true
   * latches `giveUp` so we never restart-loop across process lifetimes —
   * the node keeps running on whatever it actually has.
   */
  private restartedButStillStale(): boolean {
    const target = this.getRestartTarget();
    if (!target || !valid(target)) return false;
    const current = valid(this.getCurrentVersion()) ?? '0.0.0';
    return lt(current, target);
  }

  /**
   * Fire the boot check immediately (non-blocking — the returned promise
   * is intentionally not awaited by callers) and arm the periodic timer.
   * The timer is `unref`'d so it never keeps the process alive on its own.
   */
  start(): void {
    if (this.timer) return; // already started — idempotent
    // Boot check: fire-and-forget so node startup is never delayed.
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
    // Never let the update timer be the reason the process stays alive.
    this.timer.unref();
  }

  /** Clear the periodic timer. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One check-and-maybe-update cycle. Fully fail-closed: any thrown error
   * is caught and logged so a check/install/restart failure never crashes
   * the node or blocks its normal operation. Re-entrancy guarded so two
   * overlapping cycles (boot + first interval, or a slow check) cannot
   * double-attempt an install or fire two restarts.
   */
  async runCycle(): Promise<void> {
    if (this.cycleInProgress) return;
    if (this.giveUp) return; // attempt cap reached / install confirmed stale
    // Cross-lifetime brake: if a prior self-update restarted us toward a
    // target we still haven't reached, the install failed — stop trying
    // this lifetime instead of restart-looping the whole fleet.
    if (this.restartedButStillStale()) {
      this.giveUp = true;
      const target = this.getRestartTarget();
      logger.error(
        `[UpdateManager] restarted to reach v${target} but running ` +
          `v${this.getCurrentVersion()} — install did not take. Halting ` +
          `self-update for this process lifetime; staying on current version.`,
      );
      return;
    }
    this.cycleInProgress = true;
    try {
      const result = await this.checkFn(this.coordinatorUrl);
      if (!result) return; // npm unreachable / skipped — preflight logged it
      if (
        result.status !== UpdateStatus.UPDATE_AVAILABLE &&
        result.status !== UpdateStatus.UPDATE_REQUIRED
      ) {
        return; // UP_TO_DATE — nothing to do
      }

      // Downgrade guard (P22 supply-chain): a registry serving an
      // OLD/rolled-back version must never trigger a downgrade-install.
      // Mirror restartedButStillStale's coercion so a prerelease/dirty
      // version compares consistently. valid() returns null for an
      // uncoercible string → treat as 0.0.0 (never blocks a real upgrade).
      const latest = valid(result.latestVersion);
      const running = valid(this.getCurrentVersion()) ?? '0.0.0';
      if (latest && lt(latest, running)) {
        logger.warn(
          `[UpdateManager] downgrade blocked: latest v${latest} < running ` +
            `v${running} — skipping self-update this cycle.`,
        );
        return;
      }

      // Loop-protection: never exceed the lifetime attempt cap.
      if (this.attempts >= MAX_SELF_UPDATE_ATTEMPTS) {
        this.giveUp = true;
        logger.error(
          `[UpdateManager] reached MAX_SELF_UPDATE_ATTEMPTS=${MAX_SELF_UPDATE_ATTEMPTS} ` +
            `without a successful upgrade to v${result.latestVersion}. Staying on ` +
            `v${result.currentVersion} for this process lifetime.`,
        );
        return;
      }

      // Idle-gate: never interrupt a running HEAVY (training) work order.
      // A restart would kill the in-flight training. Defer to the next
      // re-check — the periodic timer will catch the idle window.
      const heavy = this.getActiveHeavyCount();
      if (heavy > 0) {
        logger.warn(
          `[UpdateManager] update v${result.currentVersion} -> v${result.latestVersion} ` +
            `pending: ${heavy} HEAVY work order(s) in flight — deferring restart until idle.`,
        );
        return;
      }

      // Close the idle-gate race: the install below can take minutes
      // (npm pack + install), and the heavy>0 check above is a
      // point-in-time snapshot. Set the drain latch NOW so the
      // BackpressureService refuses any NEW HEAVY (training) work for
      // the rest of this window — otherwise a training WO accepted
      // mid-install would be killed by the restart. Cleared on every
      // abort path below so a deferred/failed update never permanently
      // blocks HEAVY acceptance.
      this.setDraining(true);

      // Exponential backoff between attempts (attempts already consumed
      // this lifetime). attempt 0 → no wait, attempt 1 → base, etc.
      if (this.attempts > 0) {
        const backoff = SELF_UPDATE_BACKOFF_BASE_MS * 2 ** (this.attempts - 1);
        logger.log(`[UpdateManager] backing off ${Math.round(backoff / 1000)}s before retry.`);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }

      this.attempts += 1;
      logger.log(
        `[UpdateManager] node idle — attempting self-update ` +
          `(attempt ${this.attempts}/${MAX_SELF_UPDATE_ATTEMPTS}) to v${result.latestVersion}.`,
      );

      let installResult: SelfUpdateResult;
      try {
        // Install the EXACT npm-resolved target version (pinned), not a
        // floating `@latest` — `result.latestVersion` is the npm dist-tags
        // `latest` the pre-flight check decided on.
        installResult = await this.selfUpdateFn(result.latestVersion);
      } catch (err) {
        // attemptSelfUpdate is documented fail-closed, but belt-and-
        // suspenders: a throw here must not crash the node.
        this.setDraining(false); // abort — resume HEAVY acceptance
        logger.error(`[UpdateManager] self-update threw: ${(err as Error).message}`);
        return;
      }

      if (!installResult.success) {
        this.setDraining(false); // abort — resume HEAVY acceptance
        logger.warn(`[UpdateManager] self-update did not apply: ${installResult.message}`);
        return; // attempt consumed; next cycle will retry until the cap
      }

      // Re-confirm idle IMMEDIATELY before the restart. Despite the drain
      // latch (which only stops NEW HEAVY work), a HEAVY WO that was
      // already in flight at the idle-gate check could in principle still
      // be running, or one slipped through a non-backpressure admission
      // path. Killing it mid-flight loses the training. If any HEAVY WO
      // is active, ABORT this restart, clear draining, and retry on the
      // next idle cycle — never exit mid-WO. The install already landed
      // on disk, so the next cycle restarts cheaply once idle.
      const heavyNow = this.getActiveHeavyCount();
      if (heavyNow > 0) {
        this.setDraining(false);
        logger.warn(
          `[UpdateManager] self-update installed but ${heavyNow} HEAVY work order(s) ` +
            `became/stayed active before restart — aborting restart to avoid killing ` +
            `training. Will restart on the next idle cycle.`,
        );
        return;
      }

      logger.log(`[UpdateManager] ${installResult.message}`);
      // Stamp the target version on the env BEFORE restart. The detached
      // respawn inherits process.env, so the freshly-booted process can
      // detect "I was restarted to reach vX" and latch giveUp if the
      // install silently didn't take (cross-lifetime loop-protection).
      this.setRestartTarget(result.latestVersion);
      // Restart into the freshly-installed binary. respawn:true asks
      // restartProcess to spawn a detached replacement for unsupervised
      // runs (pods/shell); the UI path is gated off inside restartProcess.
      // This call exits the process, so anything past it only runs if the
      // injected restartFn is a test stub. The drain latch is intentionally
      // NOT cleared here: the process is exiting, and the respawned child
      // boots with a fresh (non-draining) BackpressureService.
      await this.restartFn({ ...this.restartHandles, respawn: true });
    } catch (err) {
      // Outermost fail-closed guard. The node keeps running on its current
      // version no matter what blew up in the cycle.
      logger.error(`[UpdateManager] update cycle failed (continuing): ${(err as Error).message}`);
    } finally {
      this.cycleInProgress = false;
    }
  }
}
