/**
 * OpenTelemetry + Langfuse tracing bootstrap.
 * Opt-in: only activates when LANGFUSE_SECRET_KEY is set.
 * Call initTracing() once, as early as possible, before NestJS bootstrap.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

export let tracingSDK: NodeSDK | null = null;

export function initTracing(): void {
  if (!process.env.LANGFUSE_SECRET_KEY) return;
  tracingSDK = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  tracingSDK.start();
}
