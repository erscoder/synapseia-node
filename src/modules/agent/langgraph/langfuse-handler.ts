/**
 * Langfuse LangChain callback handler factory.
 *
 * Bridges LangGraph runs into the Langfuse OTel pipeline already
 * bootstrapped by `src/instrumentation.ts` (NodeSDK + LangfuseSpanProcessor).
 * Each LangGraph node, LLM call, and tool invocation surfaces as a child
 * span under a single trace per `graph.invoke()`, with `userId=peerId` and
 * `sessionId=workOrderId` so traces are filterable in the Langfuse UI.
 *
 * Production-safe: when `LANGFUSE_SECRET_KEY` is unset the factory returns
 * an empty callbacks array, so `graph.invoke({ callbacks: ... })` runs
 * with zero overhead. Connection details are read from env by the
 * underlying `@langfuse/otel` exporter — this module never instantiates
 * a transport directly.
 *
 * Required env (set in `.env` for local dev, leave unset in prod):
 *   LANGFUSE_PUBLIC_KEY
 *   LANGFUSE_SECRET_KEY
 *   LANGFUSE_BASE_URL  — read directly by `@langfuse/otel`. No fallback at
 *     this layer. If unset, the SDK targets `https://cloud.langfuse.com`
 *     (its built-in default). docker-compose injects
 *     `http://langfuse-web:3000` into the container env so local stacks
 *     hit the in-network instance.
 *
 * NOTE: handlers are intentionally NOT cached. Each `graph.invoke()` needs
 * its own handler because `userId` and `sessionId` are constructor params
 * in the v5 scoped SDK (`@langfuse/langchain`). Allocation cost is
 * negligible compared to a graph run.
 */

import type { Callbacks } from '@langchain/core/callbacks/manager';
import { CallbackHandler } from '@langfuse/langchain';

export interface LangfuseHandlerParams {
  /** Maps to Langfuse trace `userId`. */
  userId?: string;
  /** Maps to Langfuse trace `sessionId` (groups invocations of the same work order). */
  sessionId?: string;
  /** Free-form metadata attached to the trace for UI filtering. */
  metadata?: Record<string, unknown>;
  /** Optional tags for additional filtering. */
  tags?: string[];
}

/**
 * Build a Langfuse LangChain callback handler bound to the given trace
 * identity. Returns `null` when tracing is disabled so callers can pass
 * `callbacks: handler ? [handler] : []` without conditional logic.
 */
export function getLangfuseHandler(params: LangfuseHandlerParams = {}): CallbackHandler | null {
  if (!process.env.LANGFUSE_SECRET_KEY?.trim()) return null;

  return new CallbackHandler({
    userId: params.userId,
    sessionId: params.sessionId,
    tags: params.tags,
    traceMetadata: params.metadata,
  });
}

/**
 * Convenience wrapper: returns a `Callbacks` array ready to spread into
 * `graph.invoke(input, { callbacks })`. Empty array when tracing is off.
 */
export function langfuseCallbacks(params: LangfuseHandlerParams = {}): Callbacks {
  const h = getLangfuseHandler(params);
  return h ? [h] : [];
}
