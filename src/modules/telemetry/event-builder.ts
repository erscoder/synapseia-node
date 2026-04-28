/**
 * Typed factories for the 10 telemetry event shapes accepted by the
 * coordinator. Each factory pre-fills required fields (clientEventId,
 * eventAt, severity, subsystem) so callers can't drift from the
 * server-side discriminated union.
 *
 * Each factory returns a TelemetryEventInput — a node-side mirror of
 * the coordinator's TelemetryEventDto, minus the auth/ingest envelope.
 * The TelemetryClient adds peerId / appVersion at flush time.
 */

import { randomUUID } from 'crypto';

export type TelemetryEventType =
  | 'node.boot'
  | 'node.shutdown'
  | 'gpu.smoke.passed'
  | 'gpu.smoke.failed'
  | 'gpu.smoke.skipped'
  | 'subsystem.error'
  | 'subsystem.warning'
  | 'exception.uncaught'
  | 'exception.unhandled-rejection'
  | 'work-order.failed';

export type TelemetrySeverity = 'info' | 'warning' | 'error' | 'fatal';
export type TelemetrySubsystem =
  | 'training'
  | 'inference'
  | 'embedding'
  | 'p2p'
  | 'llm'
  | 'wallet'
  | 'auth'
  | 'boot'
  | 'gpu'
  | 'other';

export interface HwFingerprint {
  os: string;
  arch: string;
  appVersion?: string;
  gpuModel?: string;
  extra?: Record<string, unknown>;
}

export interface TelemetryEventInput {
  clientEventId: string;
  eventAt: string;
  eventType: TelemetryEventType;
  severity: TelemetrySeverity;
  subsystem: TelemetrySubsystem;
  message: string;
  errorName?: string;
  stack?: string;
  context: Record<string, unknown>;
  hwFingerprint: HwFingerprint;
}

export interface NodeBootContext {
  pid: number;
  uptime: number;
  env?: 'devnet' | 'testnet' | 'mainnet';
  capabilities?: string[];
}

export interface GpuSmokeContext {
  probe: 'ollama-cuda' | 'ollama-metal' | 'ollama-rocm' | 'cpu' | 'unknown';
  latencyMs?: number;
  vramUsedMB?: number;
  errorMessage?: string;
  fallbackToCpu?: boolean;
  model?: string;
}

export interface WorkOrderFailedContext {
  workOrderId: string;
  missionId?: string;
  modelId?: string;
  durationMs?: number;
  reason: string;
}

const newId = (): string => randomUUID();
const now = (): string => new Date().toISOString();

function inferSubsystem(message: string): TelemetrySubsystem {
  // The project logger uses [Subsystem] prefixes — extract the first
  // bracketed token and map to the closed set.
  const match = message.match(/^\[(\w+[\w-]*)\]/);
  if (!match) return 'other';
  const tag = match[1].toLowerCase();
  switch (tag) {
    case 'training':
    case 'trainer':
    case 'micro':
      return 'training';
    case 'inference':
    case 'infer':
      return 'inference';
    case 'embedding':
    case 'embeddings':
    case 'embed':
      return 'embedding';
    case 'p2p':
    case 'libp2p':
    case 'gossip':
      return 'p2p';
    case 'llm':
    case 'ollama':
      return 'llm';
    case 'wallet':
    case 'solana':
      return 'wallet';
    case 'auth':
    case 'identity':
      return 'auth';
    case 'boot':
    case 'startup':
      return 'boot';
    case 'gpu':
    case 'cuda':
      return 'gpu';
    default:
      return 'other';
  }
}

/** Joins logger args (strings + objects) to a single message string. */
export function joinLogArgs(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export function makeBootEvent(
  hw: HwFingerprint,
  ctx: NodeBootContext,
): TelemetryEventInput {
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'node.boot',
    severity: 'info',
    subsystem: 'boot',
    message: 'node booted',
    context: ctx as unknown as Record<string, unknown>,
    hwFingerprint: hw,
  };
}

export function makeShutdownEvent(
  hw: HwFingerprint,
  reason: string,
): TelemetryEventInput {
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'node.shutdown',
    severity: 'info',
    subsystem: 'boot',
    message: `node shutting down: ${reason}`,
    context: { reason },
    hwFingerprint: hw,
  };
}

export function makeGpuSmokeEvent(
  hw: HwFingerprint,
  result: GpuSmokeContext & { status: 'passed' | 'failed' | 'skipped' },
): TelemetryEventInput {
  const eventType: TelemetryEventType =
    result.status === 'passed'
      ? 'gpu.smoke.passed'
      : result.status === 'failed'
        ? 'gpu.smoke.failed'
        : 'gpu.smoke.skipped';
  const severity: TelemetrySeverity =
    result.status === 'failed' ? 'warning' : 'info';
  const message =
    result.status === 'passed'
      ? `GPU smoke passed (${result.probe}, ${result.latencyMs ?? '?'} ms)`
      : result.status === 'failed'
        ? `GPU smoke failed (${result.probe}): ${result.errorMessage ?? 'unknown'}`
        : `GPU smoke skipped (no GPU detected)`;
  const { status: _status, ...ctx } = result;
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType,
    severity,
    subsystem: 'gpu',
    message,
    context: ctx as unknown as Record<string, unknown>,
    hwFingerprint: hw,
  };
}

export function makeSubsystemErrorEvent(
  hw: HwFingerprint,
  args: unknown[],
): TelemetryEventInput {
  const message = joinLogArgs(args);
  const subsystem = inferSubsystem(message);
  // Pull the first Error-shaped arg to extract structured fields.
  const errArg = args.find((a): a is Error => a instanceof Error);
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'subsystem.error',
    severity: 'error',
    subsystem,
    message,
    errorName: errArg?.name,
    stack: errArg?.stack,
    context: { argCount: args.length },
    hwFingerprint: hw,
  };
}

export function makeSubsystemWarningEvent(
  hw: HwFingerprint,
  args: unknown[],
): TelemetryEventInput {
  const message = joinLogArgs(args);
  const subsystem = inferSubsystem(message);
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'subsystem.warning',
    severity: 'warning',
    subsystem,
    message,
    context: { argCount: args.length },
    hwFingerprint: hw,
  };
}

export function makeUncaughtExceptionEvent(
  hw: HwFingerprint,
  err: unknown,
): TelemetryEventInput {
  const e = (err instanceof Error ? err : new Error(String(err))) as Error;
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'exception.uncaught',
    severity: 'fatal',
    subsystem: 'other',
    message: `[uncaughtException] ${e.name}: ${e.message}`,
    errorName: e.name,
    stack: e.stack,
    context: {},
    hwFingerprint: hw,
  };
}

export function makeUnhandledRejectionEvent(
  hw: HwFingerprint,
  reason: unknown,
): TelemetryEventInput {
  const e = (reason instanceof Error ? reason : new Error(String(reason))) as Error;
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'exception.unhandled-rejection',
    severity: 'fatal',
    subsystem: 'other',
    message: `[unhandledRejection] ${e.name}: ${e.message}`,
    errorName: e.name,
    stack: e.stack,
    context: {},
    hwFingerprint: hw,
  };
}

export function makeWorkOrderFailedEvent(
  hw: HwFingerprint,
  ctx: WorkOrderFailedContext,
  cause?: Error,
): TelemetryEventInput {
  return {
    clientEventId: newId(),
    eventAt: now(),
    eventType: 'work-order.failed',
    severity: 'error',
    subsystem: 'training',
    message: `work-order ${ctx.workOrderId} failed: ${ctx.reason}`,
    errorName: cause?.name,
    stack: cause?.stack,
    context: ctx as unknown as Record<string, unknown>,
    hwFingerprint: hw,
  };
}
