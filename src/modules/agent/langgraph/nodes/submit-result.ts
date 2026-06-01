import { Injectable } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from '../../work-order/work-order.coordinator';
import { WorkOrderExecutionHelper } from '../../work-order/work-order.execution';
import { FetchWorkOrdersNode } from './fetch-work-orders';
import { validateResearchResultJsonString } from '../../../../shared/node-side-submission-quality';
import type { AgentState } from '../state';
import logger from '../../../../utils/logger';

@Injectable()
export class SubmitResultNode {
  /**
   * Bug Z1 (2026-06-01) — number of CONSECUTIVE null probes
   * (`getWorkOrder` → null, i.e. 404 or network error) on the SAME
   * non-research WO id before the node treats it as terminal-for-us and
   * drops it permanently. A single null stays fail-open so one coord blip
   * can't nuke a legitimate in-flight result; the cap closes the fail-open
   * hole that let the node POST a CANCELLED/purged WO into a closed round
   * forever.
   */
  private static readonly NULL_PROBE_TERMINAL_AFTER = 2;

  /** Per-WO consecutive null-probe counter (reset by any non-null probe). */
  private readonly nullProbeStreak = new Map<string, number>();

  constructor(
    private readonly coordinator: WorkOrderCoordinatorHelper,
    private readonly fetchNode: FetchWorkOrdersNode,
    private readonly execution: WorkOrderExecutionHelper,
  ) {}


  async execute(state: AgentState): Promise<Partial<AgentState>> {
    const { selectedWorkOrder, executionResult, researchResult, coordinatorUrl, peerId, walletAddress } = state;
    if (!selectedWorkOrder || !executionResult) return { submitted: false };

    // Hard guard: never ship a failed execution AS a success. QualityGateNode
    // is supposed to route around this via `shouldSubmit: false`, but a
    // belt-and-suspenders check here protects against graph-edge regressions
    // AND any legacy path that might invoke this node directly. Also arms the
    // cooldown so the node doesn't hot-loop on the same broken WO.
    if (executionResult.success === false) {
      logger.warn(
        ` Execution failed for WO ${selectedWorkOrder.id} — ` +
        `${executionResult.result.slice(0, 120)}`,
      );
      // Bug 20 v3 (2026-05-18) — when a docking WO fails with a timeout
      // (obabel --gen3d in either tier OR vina), increment the per-WO
      // failure counter. After the cap (default 2), FetchWorkOrdersNode's
      // pre-fetch filter skips this WO on subsequent polls, avoiding the
      // observed 4-consecutive-failures pattern on
      // wo_docking_dp_5542e258-9c6_a_1779120600222_dbf771. Detection is
      // regex-based on the result string because `runDocking` wraps the
      // child-process error before bubbling. Non-timeout failures (Vina
      // exit non-zero, parse error) do NOT increment — they have
      // different root causes and shouldn't trigger the same skip.
      if (this.execution.isDockingWorkOrder(selectedWorkOrder)) {
        const resultStr = executionResult.result;
        const isTimeout = /timed out/i.test(resultStr);
        if (isTimeout) {
          // Disambiguate the timeout source for telemetry: obabel
          // `--gen3d` (med/fast/retry) vs Vina vs other obabel steps.
          // The error message embeds the binary name + flags via
          // `buildObabelTimeoutMessage`, so a substring scan suffices.
          const isObabelGen3d = /--gen3d/i.test(resultStr) || /gen3d/i.test(resultStr);
          const reason = isObabelGen3d ? 'obabel-gen3d-timeout' : 'docking-timeout';
          this.fetchNode.markFailedTimeout(selectedWorkOrder.id, reason);
        }
      }

      // Bug 20 v4 (2026-05-23) — report the failure to the coordinator
      // instead of silently abandoning it (P21/P22). Previously this branch
      // only armed the local cooldown via `markCompleted`, so the WO sat in
      // ACCEPTED until the coord's ACCEPTED-TTL reaper (minutes), blocking
      // re-dispatch the whole time. We now POST `success: false` to the
      // SAME `/work-orders/:id/complete` endpoint the success path uses
      // (`completeWorkOrder` already carries the `success` flag) so the
      // coordinator releases the WO promptly. The endpoint treats a stale
      // WO (status flipped away from ACCEPTED) as a benign 400 drop, so a
      // race with the reaper is harmless. We pass no-op reward callbacks
      // because a failed WO earns nothing. The LIGHT backpressure slot is
      // released independently by AgentGraphService after this node returns.
      const failCompletedIds = new Set<string>(state.completedWorkOrderIds ?? []);
      const reported = await this.coordinator.completeWorkOrder(
        coordinatorUrl, selectedWorkOrder.id, peerId, walletAddress,
        executionResult.result, false,
        failCompletedIds,
        () => {},
        () => {},
        () => 0n,
      );
      if (reported) {
        logger.info(`[Submit] reported failure for WO ${selectedWorkOrder.id} to coordinator — released for re-dispatch`);
      } else {
        // Network error / non-400 reject: the coord did not release the WO.
        // It will fall back to the ACCEPTED-TTL reaper. Log clearly so the
        // delayed release is not mistaken for a silent drop (P22).
        logger.warn(`[Submit] failure report for WO ${selectedWorkOrder.id} not acked — coord will release via ACCEPTED-TTL reaper`);
      }

      this.fetchNode.markCompleted(selectedWorkOrder);
      return { submitted: false };
    }

    // Bug 31 (2026-05-18) — client-side quality gate for RESEARCH WOs.
    // Mirrors the coord's `application/work-orders/submission-quality.ts`
    // contract so we reject obviously-malformed submissions locally and
    // save the POST + a coord-side `WOSubmit reject` log line. Observed
    // live 2026-05-18 on wo_1779113721582_cb5db91b: pod shipped a
    // 1-char `summary="{"`, coord rejected with
    // `hypothesis_too_short detail=1 chars < 30 min`.
    //
    // Belt-and-suspenders for the synthesizer-node empty-summary fix:
    // even if a future regression re-introduces the bare-`{` path or
    // any other unparseable-output path, this gate stops it before the
    // POST. Non-RESEARCH WOs (TRAINING/DILOCO_TRAINING/LORA_TRAINING/
    // MOLECULAR_DOCKING/CPU_INFERENCE/GPU_INFERENCE) ship
    // shape-incompatible payloads (numeric metrics, gradient binaries,
    // docking scores) and are exempt from this check — their quality is
    // verified by the coord's domain-specific validators
    // (DockingSubmissionService, LoRA validation, training loss checks).
    //
    // Bug 0.8.90 (2026-05-18) — SCOPE STRICTLY to `type === 'RESEARCH'`.
    // The 0.8.89 implementation used `this.execution.isResearchWorkOrder`,
    // which falls back to `extractResearchPayload(workOrder) !== null` —
    // and that helper returns truthy for any WO with `title` + `description`
    // (i.e. effectively all WOs). Result: TRAINING + DILOCO_TRAINING
    // submissions were incorrectly gated and their `/complete` ACKs were
    // skipped on pod 213 (verified live 2026-05-18 19:01-19:14Z on
    // wo_training_1779109561108_fc0e5f62 and
    // wo_diloco_1779126050262_57df2e77). DILOCO gradients still landed via
    // the separate `/diloco/medical/gradients` route, but the WO-completion
    // ACK was skipped so coord may re-dispatch and reward distribution
    // breaks. TRAINING/DOCKING only have the `/complete` path so impact
    // is worse there. P10 reviewer-lesson: comments must match real
    // behaviour; gate scope must match its stated intent. Uppercase
    // compare is defensive against any future case-variant wire format
    // ("diloco_training" alias seen in `work-order.execution.ts:65`).
    // P22: undefined `wo.type` fails CLOSED for RESEARCH-vs-unknown
    // intent — but here we fail OPEN (skip the gate) because the gate
    // only catches the RESEARCH-shaped failure mode; gating an unknown
    // type with research-shaped checks recreates the very bug we are
    // fixing. The coord's domain validator is the authoritative gate
    // for everything else.
    const woTypeUpper = (selectedWorkOrder.type ?? '').toString().toUpperCase();
    if (woTypeUpper === 'RESEARCH') {
      const gate = validateResearchResultJsonString(executionResult.result);
      if (!gate.ok) {
        logger.warn(
          `[SubmitResult] Local quality gate rejected WO ${selectedWorkOrder.id} ` +
          `(reason=${gate.reason}, ${gate.detail}) — skipping POST`,
        );
        this.fetchNode.markCompleted(selectedWorkOrder);
        return { submitted: false };
      }
    }

    const completedIds = new Set<string>(state.completedWorkOrderIds ?? []);
    const updatedIds = [...completedIds];

    // Pre-submit status probe. The coordinator expires WOs on a cron and may
    // have reassigned this WO to another node. Drop the result, arm the
    // cooldown, and let the agent loop close cleanly when the WO has truly
    // moved past us.
    //
    // Coordinator's WorkOrderStatus enum: PENDING | ACCEPTED | COMPLETED |
    // VERIFIED | CANCELLED. The submittable states differ by WO type:
    //
    //   - RESEARCH: a research round runs the cyclic re-offer model — while
    //     the round is OPEN the coordinator re-offers the round's WOs
    //     round-robin and flips them back to PENDING while a node is still
    //     working them (on a single-node network the re-offer always returns
    //     to the same node). So PENDING is a VALID submittable state here: the
    //     coordinator ACCEPTS a research submit for a PENDING WO as long as the
    //     round is OPEN (WorkOrderSubmissionService.ts, the OPEN-round RESEARCH
    //     branch ~L372-374). We must NOT
    //     drop a re-offered (PENDING) research WO locally — proceed to
    //     completeWorkOrder and let the server's round-OPEN check decide; if
    //     the round actually closed it returns RoundClosedException/410, which
    //     the downstream error handling already covers. Only drop on the
    //     genuinely terminal/reassigned states COMPLETED | VERIFIED | CANCELLED.
    //   - Non-research: the WO stays in ACCEPTED until completion, so any
    //     status other than ACCEPTED means it was completed by someone else,
    //     already verified, or cancelled — drop.
    //
    // Bug Z1 (2026-06-01, P2 fail-closed) — `probe === null` (404 OR network
    // error; `getWorkOrder` collapses both to null) used to be treated as
    // "still ours, proceed" UNCONDITIONALLY. That is a fail-OPEN hole: a
    // CANCELLED non-research WO whose row was purged 404s, so the node POSTed
    // into a closed round on EVERY iteration — the observed zombie loop
    // (iter=715,716 on a CANCELLED WO). We cannot tell a 404 apart from a
    // network blip here (same null), so we keep a transient-blip guard:
    //   - RESEARCH: a null probe stays fail-open ALWAYS. The authoritative
    //     gate for research is the server-side round-OPEN check on POST, so a
    //     missing row must never escalate to a local terminal drop.
    //   - Non-research: a SINGLE null stays fail-open (don't nuke a
    //     legitimate in-flight result on one blip), but after
    //     `NULL_PROBE_TERMINAL_AFTER` (2) CONSECUTIVE nulls for the SAME id
    //     we treat the WO as terminal-for-us and drop it PERMANENTLY. Any
    //     non-null probe resets the streak. P10: the comment now matches the
    //     fail-closed-after-N behaviour, not the old unconditional fail-open.
    // Terminal coordinator states for ANY WO type (research and non-research
    // alike): once a WO reaches one of these it is permanently dead for this
    // node. (Renamed from RESEARCH_TERMINAL_STATES — the set is now consulted
    // by the non-research branch below too, so the research-specific name was
    // misleading. P10.)
    const TERMINAL_STATES = ['COMPLETED', 'VERIFIED', 'CANCELLED'];
    const probe = await this.coordinator.getWorkOrder(coordinatorUrl, selectedWorkOrder.id);
    const isResearch = woTypeUpper === 'RESEARCH';

    // A non-null probe ends any consecutive-miss streak for this id.
    if (probe) this.nullProbeStreak.delete(selectedWorkOrder.id);

    let dropKind: 'terminal' | 'reassigned' | null = null;
    if (probe) {
      if (isResearch) {
        // Research terminal states are permanently dead for this node.
        if (TERMINAL_STATES.includes(probe.status)) dropKind = 'terminal';
      } else if (probe.status !== 'ACCEPTED') {
        // CANCELLED/COMPLETED/VERIFIED are dead; PENDING means the coord
        // reaper reset/reassigned it (it MAY be legitimately re-offered
        // later), so that is a softer "reassigned" drop (cooldown), not a
        // permanent one.
        dropKind = TERMINAL_STATES.includes(probe.status) ? 'terminal' : 'reassigned';
      }
    } else if (!isResearch) {
      // Null probe on a non-research WO: count consecutive misses.
      const streak = (this.nullProbeStreak.get(selectedWorkOrder.id) ?? 0) + 1;
      this.nullProbeStreak.set(selectedWorkOrder.id, streak);
      if (streak >= SubmitResultNode.NULL_PROBE_TERMINAL_AFTER) {
        logger.warn(
          `[Submit] WO ${selectedWorkOrder.id} probe returned null ${streak}x consecutively ` +
          `— treating as terminal (round closed / WO purged) and dropping permanently`,
        );
        dropKind = 'terminal';
      }
      // streak < cap → dropKind stays null → fail-open POST (single blip).
    }

    if (dropKind) {
      const statusLabel = probe ? probe.status : `null-probe×${this.nullProbeStreak.get(selectedWorkOrder.id) ?? 0}`;
      logger.info(`[Submit] dropping stale result for WO ${selectedWorkOrder.id} (status=${statusLabel})`);
      if (dropKind === 'terminal') {
        // Bug Z1 — terminal (CANCELLED / closed-round / repeated-404) WOs are
        // removed from the iteration/active set PERMANENTLY so the node stops
        // re-selecting + re-training them. `markCompleted` only arms a 60s
        // cooldown for TRAINING/DiLoCo, which lapses and lets the WO back in.
        this.nullProbeStreak.delete(selectedWorkOrder.id);
        this.fetchNode.markPermanentlyDropped(selectedWorkOrder);
      } else {
        // Reassigned (non-research PENDING): the coord may re-offer it; a
        // cooldown is the right lever, matching the prior behaviour.
        this.fetchNode.markCompleted(selectedWorkOrder);
      }
      updatedIds.push(selectedWorkOrder.id);
      return { submitted: true, completedWorkOrderIds: updatedIds };
    }

    logger.log(' Reporting result...');
    const completed = await this.coordinator.completeWorkOrder(
      coordinatorUrl, selectedWorkOrder.id, peerId, walletAddress,
      executionResult.result, executionResult.success,
      completedIds,
      (id: string) => updatedIds.push(id),
      () => {},
      (s: string) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    if (completed) {
      // Bug Z1 (2026-06-01, leak fix) — a successful POST means we are done
      // with this id, so drop any residual consecutive-null-probe counter for
      // it. Without this the `nullProbeStreak` map keeps one stale entry per
      // WO-id that hit exactly one transient null then succeeded (the streak
      // is otherwise only deleted on a non-null probe or on reaching the cap),
      // a slow leak on a node running for weeks.
      this.nullProbeStreak.delete(selectedWorkOrder.id);
      // Bug 34 (2026-05-18) — honest log. The previous form printed
      // `Potential reward: ${rewardAmount} SYN` which was the *round
      // pool* (e.g. 6000), not the per-peer payout. Actual settlement
      // splits 60/25/15 among top-3 (3600/1500/900 SYN) with 0 for
      // everyone else — the round-listener's post-settlement log is
      // the only honest source for what this peer earned. We keep
      // useful context (WO type, iteration) and drop the misleading
      // SYN amount entirely. P10 reviewer-lesson: no lying logs.
      const woType = selectedWorkOrder.type ?? 'UNKNOWN';
      logger.log(`[WO complete] id=${selectedWorkOrder.id} type=${woType} iter=${state.iteration} submitted=true`);
      // Arm per-WO cooldowns so the next poll doesn't immediately re-accept
      // the same WO. markCompleted branches by type (RESEARCH long cooldown,
      // TRAINING short cooldown, everything else permanent). Without this
      // call the cooldowns declared in FetchWorkOrdersNode were effectively
      // dead code in the langgraph flow — node submitted + re-accepted the
      // same WO within 30s, flooding the coordinator with redundant
      // submissions for the same research paper.
      this.fetchNode.markCompleted(selectedWorkOrder);
      // Research results are registered in the ResearchRound via completeWorkOrder().
      // The coordinator extracts summary/insights/proposal from the result JSON automatically.
      void researchResult; // kept in state for brain/memory
    } else {
      const woType = selectedWorkOrder.type ?? 'UNKNOWN';
      logger.log(`[WO complete] id=${selectedWorkOrder.id} type=${woType} iter=${state.iteration} submitted=false`);
    }

    return { submitted: completed, completedWorkOrderIds: updatedIds };
  }

  /**
   * Bug Z1 (2026-06-01) — clear the per-WO consecutive-null-probe counters.
   * Mirrors `FetchWorkOrdersNode.reset()` so a caller that re-initialises the
   * fetch node's in-memory state can drop this node's `nullProbeStreak` map in
   * the same pass and the two nodes never disagree about a WO's fate. The map
   * is otherwise pruned incrementally (deleted on any non-null probe, on a
   * successful submit, and on reaching the terminal cap), so this is the
   * coarse fallback that bounds the map across long-lived runs.
   */
  reset(): void {
    this.nullProbeStreak.clear();
  }
}
