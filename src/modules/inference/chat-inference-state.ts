/**
 * Tracks whether this node is currently handling one or more inbound chat
 * inference requests. The WO poller consults this flag to refuse new
 * TRAINING / DILOCO_TRAINING work orders while chat is active — those
 * compete for CPU with the LLM and push per-chat latency past the
 * coordinator's stream timeout (reference incident: 2026-04-24, chat
 * completion took 114s against a 60s cap).
 *
 * Kept as a module-level singleton because ChatStreamHandler is instantiated
 * outside the Nest DI container (see node-runtime.ts: dynamic import + manual
 * construction) while FetchWorkOrdersNode lives inside it. A plain module
 * exports the only state both sides need to agree on.
 */
let active = 0;

export function beginChatInference(): void {
  active += 1;
}

export function endChatInference(): void {
  active = Math.max(0, active - 1);
}

export function isChatInferenceActive(): boolean {
  return active > 0;
}

export function activeChatInferences(): number {
  return active;
}

/** Test helper — reset without altering production API. */
export function _resetChatInferenceStateForTests(): void {
  active = 0;
}
