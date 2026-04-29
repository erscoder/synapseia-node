/**
 * OpenTelemetry + Langfuse tracing bootstrap.
 * Opt-in: only activates when LANGFUSE_SECRET_KEY is set.
 * Uses dynamic imports so OTel packages never load when tracing is disabled —
 * avoids reflect-metadata side-effects that break NestJS DI.
 * Call initTracing() once, before NestJS bootstrap.
 */
export async function initTracing(): Promise<void> {
  if (!process.env.LANGFUSE_SECRET_KEY) return;
  const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@langfuse/otel'),
  ]);
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
}
