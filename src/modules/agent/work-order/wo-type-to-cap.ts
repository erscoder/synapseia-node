/**
 * WorkOrder type → required-capability mapping.
 *
 * Single source of truth on the NODE side for local accept-gate enforcement
 * (Bug 22, 2026-05-17). Mirrors the coord-side tier matrix WO type column —
 * any cap a node strips at heartbeat time (e.g. `diloco_training` under
 * memory pressure) must also block the same WO type from being locally
 * accepted, even if coord still routes it (e.g. stake-tier passes, drift
 * detector lag, etc).
 *
 * Live bug: Mac M-series node-kike heartbeat correctly dropped
 * `diloco_training` from advertised caps (memory floor) but the node
 * still accepted `wo_diloco_*` because the accept path only checked
 * `BackpressureService.canAccept()` (in-flight slot count) — never the
 * cap list. Coord side accept gate passed because stake=9999 SYN
 * (tier 3 met). Node spun up Qwen2.5-7B and was heading for OOM.
 *
 * Reviewer-lessons applied:
 *   - **P2 fail-closed**: unknown WO type OR unknown cap name → reject.
 *   - **P6 grep all paths**: this mapping is referenced from BOTH the
 *     fetch-time filter (pre-coord) AND the accept-time guard (post-coord
 *     reply, pre-POST /accept). Both consult the same function so a new
 *     WO type added in the future fails-closed in both places.
 */

import type { WorkOrder } from './work-order.types';

/**
 * Canonical WO type → primary required capability.
 *
 * Value can be a single cap string OR an array of caps, where the array
 * means "any one of these caps is sufficient" (OR semantics). This lets
 * us express WOs whose required runtime can be satisfied by either a
 * floor-gated cap or its alias (e.g. RESEARCH accepts `inference` —
 * the floor-gated cap stripped under memory pressure — OR `llm`, the
 * backwards-compat alias declared by some cloud-LLM-only edge nodes).
 */
const WO_TYPE_TO_CAP: Record<
  NonNullable<WorkOrder['type']>,
  string | readonly string[]
> = {
  // Inference family
  CPU_INFERENCE: 'cpu_inference',
  GPU_INFERENCE: 'gpu_inference',
  // RESEARCH accepts either `inference` (preferred, floor-gated under
  // memory pressure) or `llm` (alias declared by cloud-LLM-only nodes,
  // documented in heartbeat.ts cap taxonomy as "alias for inference").
  // OR semantics — having either one is sufficient to serve RESEARCH.
  RESEARCH: ['inference', 'llm'],
  // Training family
  TRAINING: 'cpu_training',
  DILOCO_TRAINING: 'diloco_training',
  // Node-side aggregation re-architecture (Phase 3). The coord ships
  // `requiredCapabilities: ['gpu_training']` for DILOCO_AGGREGATION WOs
  // (reuses the existing cap — every DiLoCo training node already
  // advertises it, so no node-release gate for a new cap string, design
  // §3.1). The runner additionally fails closed when AWS_DILOCO_BUCKET is
  // unset, so an un-provisioned gpu_training node simply returns
  // success=false without aggregating.
  DILOCO_AGGREGATION: 'gpu_training',
  LORA_TRAINING: 'lora_training',
  // LoRA validation runs on the same Python stack as LoRA training.
  // Additional opt-in env gate (LORA_VALIDATOR_ENABLED) enforced in
  // canLocallyAcceptWorkOrder.
  LORA_VALIDATION: 'lora_training',
  // Molecular docking (AutoDock Vina, local subprocess).
  // Cap string is 'docking' (NOT 'molecular_docking') to match what
  // heartbeat.ts advertises (`caps.push('docking')` at line 1431) and
  // what the coord-side DockingDispatchCron requires
  // (`DOCKING_CAPABILITY = 'docking'`). Bug 26 (2026-05-17): an earlier
  // mapping used 'molecular_docking' which never matched the heartbeat
  // string, so MOLECULAR_DOCKING WOs were skipped locally despite the
  // pod advertising docking caps. Single source of truth = 'docking'.
  MOLECULAR_DOCKING: 'docking',
};

/**
 * Resolve the primary capability (or any-of list) required to locally
 * execute the given WO. Returns `null` for WOs whose `type` is missing
 * or unmapped — callers MUST treat `null` as "fail closed and reject"
 * (P2).
 *
 * For single-cap mappings returns the string. For OR-semantics mappings
 * (e.g. RESEARCH) returns the readonly array of acceptable caps.
 */
export function woTypeToCap(
  wo: Pick<WorkOrder, 'type'>,
): string | readonly string[] | null {
  if (!wo.type) return null;
  return WO_TYPE_TO_CAP[wo.type] ?? null;
}

/**
 * Check whether the node currently advertises the cap required by this WO.
 *
 * Returns `{ ok: true }` when the WO can be locally accepted, or
 * `{ ok: false, reason }` with a human-readable reason for the log.
 *
 * Failure modes (all fail-closed per P2):
 *  - unknown WO type / no mapping → reject
 *  - mapped cap missing from currentCaps → reject (for OR-semantics,
 *    at least one of the acceptable caps must be present)
 *  - currentCaps is empty (heartbeat hasn't primed yet) → reject
 *  - per-WO-type opt-in env gate not enabled (e.g. LORA_VALIDATION
 *    requires LORA_VALIDATOR_ENABLED=true) → reject
 *
 * `requiredCapabilities` from the WO is also intersected against
 * currentCaps for defense-in-depth — if coord adds new required caps
 * post-fetch, this catches them too.
 */
export function canLocallyAcceptWorkOrder(
  wo: Pick<WorkOrder, 'type' | 'requiredCapabilities'>,
  currentCaps: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  if (!currentCaps || currentCaps.length === 0) {
    return {
      ok: false,
      reason: 'no current capabilities advertised (heartbeat not primed)',
    };
  }

  const capSet = new Set(currentCaps);

  // 1. WO-type → cap mapping check (primary).
  const primary = woTypeToCap(wo);
  if (primary === null) {
    return {
      ok: false,
      reason: `unknown WO type "${wo.type ?? '<undefined>'}" — no cap mapping (fail-closed)`,
    };
  }

  // OR semantics: array means "any of these caps suffices".
  if (Array.isArray(primary)) {
    const hasAny = primary.some((c) => capSet.has(c));
    if (!hasAny) {
      return {
        ok: false,
        reason: `WO type ${wo.type} requires any of [${primary.join(',')}] — none in current caps [${currentCaps.join(',')}]`,
      };
    }
  } else {
    // Single-cap mapping.
    const single = primary as string;
    if (!capSet.has(single)) {
      return {
        ok: false,
        reason: `WO type ${wo.type} requires cap "${single}" not in current caps [${currentCaps.join(',')}]`,
      };
    }
  }

  // 2. Per-WO-type opt-in env gates. LORA_VALIDATION requires explicit
  // operator opt-in via LORA_VALIDATOR_ENABLED=true (Plan 1 Phase 2);
  // without it `execute-lora-validation.ts` refuses to run, so we must
  // reject here too — otherwise we POST /accept and waste a coord
  // round-trip plus burn the WO slot before the executor bails.
  if (
    wo.type === 'LORA_VALIDATION' &&
    process.env.LORA_VALIDATOR_ENABLED !== 'true'
  ) {
    return {
      ok: false,
      reason:
        'LORA_VALIDATOR_ENABLED is not true (validator opt-in required)',
    };
  }

  // 3. requiredCapabilities intersection (defense-in-depth).
  const required = wo.requiredCapabilities ?? [];
  const missing = required.filter((c) => !capSet.has(c));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `WO requires [${required.join(',')}] — missing [${missing.join(',')}] from current caps [${currentCaps.join(',')}]`,
    };
  }

  return { ok: true };
}
