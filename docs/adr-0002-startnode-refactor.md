# ADR-0002: Phased refactor of `startNode()` in node-runtime.ts

- **Status:** Proposed (deferred — no code change yet)
- **Date:** 2026-05-29
- **Context source:** 2026-05-29 full-stack audit, deferred item WS1.

## Context

`packages/node/src/node-runtime.ts` exposes `startNode()`, a single function of
~1160 lines that is the entire boot sequence of a node: hardware detection wiring,
the coordinator watchdog, the blocking initial heartbeat + periodic heartbeat, the
A2A server, the OpenAI-compatible inference server, the GossipSub subscription
graph (the six coordinator-signed topics + the coordinator trust-anchor load), the
KG-shard hosting/query/snapshot protocols, the LangGraph work-order agent + round
listener, and graceful shutdown.

This is **maintainability debt, not a bug**. It is flagged here rather than fixed
because:

1. It is the core of the runtime. A botched extraction regresses node boot for the
   entire fleet, and node ships via npm + self-update (non-atomic rollout), so a
   regression is expensive to claw back.
2. **There is no boot-integration test.** The existing specs construct pieces in
   isolation (mocked p2p/keystore) or assert wiring indirectly. Nothing exercises
   `startNode()` end-to-end and asserts the boot contract. Refactoring without that
   safety net is exactly the regression class reviewer-lessons P27 warns about
   (DI/wiring drift that unit tests with manual instantiation do not catch).

Therefore this ADR records a **phased plan** for a future dedicated task. Do not
attempt it as part of an unrelated change.

## Decision

Refactor `startNode()` in three phases, each phase its own commit + reviewer pass +
green suite. **Phase 0 is mandatory and must land before any extraction.**

Line ranges below are approximate (node-runtime.ts is edited periodically; re-locate
each block by responsibility at execution time, do not trust the numbers blindly).

### Phase 0 — Boot-integration safety net (no extraction)

Add a boot-integration test that arranges `startNode()` with p2p, keystore, and the
coordinator HTTP/WS surface mocked, then asserts the **observable boot contract**:

- the six coordinator-signed GossipSub topics are subscribed with the verifying
  handlers wired,
- the coordinator trust anchor (pinned pubkey) is loaded and bound to those handlers,
- the KG-shard hosting/query wiring is registered,
- the blocking initial heartbeat is awaited before the WS/agent starts (this is the
  invariant the coordinator `ws-auth.guard` TOFU comment depends on; see ADR/comment
  there),
- `stop()` tears down the inference HTTP server + RoundListener WS (the 2026-05-29
  sweep already closed those leaks; the test pins that they stay closed).

This test is the regression oracle for Phases 1 and 2. It must be green before and
after every subsequent extraction.

### Phase 1 — Low-risk extractions (cohesive, few external deps)

Extract these already-cohesive blocks into named services/helpers. Each is largely
self-contained, so the blast radius is small:

- **HeartbeatBootstrap** — the hardware-shape resolution + blocking initial
  heartbeat + periodic-heartbeat startup (~:401-491).
- **A2AServerBootstrap** — the optional A2A server start (~:508-551).
- **InferenceServerBootstrap** — the OpenAI-compatible + Vickrey-bid inference
  server start, including the inference server close-handle captured for `stop()`
  (~:552-610).

One extraction per commit. Reviewer + full node suite + the Phase-0 boot test green
after each.

### Phase 2 — High-risk extractions (security-sensitive wiring)

These carry the coordinator trust boundary and the most cross-cutting state, so they
go last, each as its own commit + reviewer:

- **P2pSubscriptionService** — the six coordinator-signed topics + the coordinator
  trust-anchor load + the verifying dispatch (~:611-787). This is the security spine
  of inbound coordinator messages; an extraction bug here is a P2/P10 fail-open or a
  silently-unverified topic.
- **KgShardHostingService** — KG-shard hosting/query/snapshot registration (~:791-990),
  including the requester-auth gaps already flagged in the 2026-05-29 sweep
  (kg-shard-snapshot handler, kg-shard-query auth) so the extraction is a natural
  place to also resolve those follow-ups.

## Consequences

- `startNode()` becomes a thin composition root that wires the extracted services;
  each service is independently testable.
- The Phase-0 boot test becomes a permanent guard against future wiring drift.
- Until this task runs, `startNode()` stays as-is. No partial extraction should be
  done opportunistically inside other PRs.

## Verification (when executed)

Full node suite green + the new Phase-0 boot-integration test green after every
commit. Phase 2 commits additionally require a reviewer pass focused on the
coordinator-signature verification paths (no topic left unverified, trust anchor
still bound, fail-closed preserved).
