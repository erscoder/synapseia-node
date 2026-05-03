/**
 * Coerces a possibly-undefined / NaN / non-numeric trainer result field
 * into a finite number so downstream `.toFixed()` calls and JSON payloads
 * can never carry `NaN`/`null` through the coordinator schema.
 *
 * Used by the WO executor to defend against a degraded trainer return
 * shape — see `work-order.execution.ts` and `agent-loop.ts`.
 */
export function safeLoss(input: unknown): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : 0;
}
