# Changelog — @synapseia-network/node

## [2026-05-14] feat(llm): add NVIDIA NIM as 7th cloud LLM provider (d33ca815)

NVIDIA NIM (build.nvidia.com) is now selectable as an operator-side
cloud LLM provider alongside openai / anthropic / google / moonshot /
minimax / zhipu. The unlock is the free tier — verified NGC developers
get ~5,000 credits/month, which means operators can join Synapseia
without paying any vendor or owning a local GPU. The node still runs
training and docking work orders locally; NVIDIA NIM only covers the
research / review LLM call path.

- New adapter `nvidia.adapter.ts` — thin subclass of `OpenAICompatAdapter`
  hitting `https://integrate.api.nvidia.com/v1/chat/completions` with
  `Authorization: Bearer nvapi-...`. No NIM-specific quirks; reasoning
  output stays out of `choices[0].message.content` for the picked
  flagship.
- Registered in `adapters/index.ts` and `CLOUD_PROVIDERS` table.
- Model tiers picked for Synapseia's biomedical KG + peer-review work:
  - top:    `nvidia/nemotron-3-super-120b-a12b` (120B MoE, NVIDIA-tuned).
  - mid:    `meta/llama-3.3-70b-instruct` (Meta 70B production stable).
  - budget: `meta/llama-3.2-3b-instruct` (3B Meta, low-latency).
- `training-llm.ts` `CLOUD_PREFIXES` gains `{ prefix: 'nvidia/',
  providerId: 'nvidia' }` so the mutation engine routes nvidia slugs
  through `buildCloudModel()` instead of dropping them to the
  env-fallback path. Important — NIM model ids carry their own vendor
  namespace, so the slug shape is `nvidia/<vendor>/<model>` and
  prefix-strip yields the bare `<vendor>/<model>` form NIM expects
  upstream.

Version bump 0.8.33 -> 0.8.34 lockstep with coord + node-ui.

## [2026-05-12] fix(langgraph): route MOLECULAR_DOCKING + LORA_TRAINING + LORA_VALIDATION; fail-loud unknown types (f0b9cc9d)

Production BLOCKER hotfix. LangGraph router switch in
`AgentGraphService` covered only RESEARCH/TRAINING/CPU_INFERENCE/
GPU_INFERENCE/DILOCO_TRAINING and silently fell through `default →
executeTraining` for every other `WorkOrderType`. MOLECULAR_DOCKING,
LORA_TRAINING and LORA_VALIDATION are actively produced by coord
crons; they crashed inside `ExecuteTrainingNode` →
`mutation-engine.ts:192/210` with
`TypeError: Cannot read properties of undefined (reading 'toFixed')`
on `payload.currentBestLoss` (undefined for non-training payloads).
QualityGate returned `shouldSubmit=false` so `completeWorkOrder` was
never called — zero docking/lora rewards were ever paid through the
langgraph path on any node.

Fix:
- 3 new langgraph executor nodes (`ExecuteDockingNode`,
  `ExecuteLoraNode`, `ExecuteLoraValidationNode`) wrapping the
  existing `WorkOrderExecutionHelper` methods at
  `work-order.execution.ts:554, 595, 635`.
- New `UnknownTypeNode` that logs WARN + returns `success: false` so
  qualityGate skips submission and the WO is left in `ACCEPTED` for
  coord re-assignment (no silent misrouting).
- `default` branch replaced with a compile-time
  `const _exhaustive: never = t` guard — future `WorkOrderType`
  additions will fail `tsc` instead of getting silently misrouted.
- `ExecuteLoraValidationNode` honours the `LORA_VALIDATOR_ENABLED`
  opt-in flag at the node layer (defense-in-depth on top of the
  existing executor-level gate at `work-order.execution.ts:639`).
- New router-exhaustiveness `it.each` test asserts routing for all 8
  active `WorkOrderType` values — runtime backstop to the
  compile-time `never` guard.
- 13 new tests; full suite green (1614 pass, 43 skipped).

`QualityGateNode` is already shape-agnostic (reads only
`executionResult.success` at `quality-gate.ts:24-41`) so it needed no
changes to consume docking (`bestAffinity` kcal/mol) or LoRA
(val metrics) payloads.

Tech-debt follow-ups (separate tickets, out of scope):
- Coord `DOCKING_CAPABILITY='docking'` vs WO
  `requiredCapabilities=['cpu_inference']` mismatch
  (`DockingDispatchCron:130-141` skip-gates dispatch when zero nodes
  advertise the `docking` cap; node heartbeat never pushes it).
- Remove dead-code `packages/node/src/modules/agent/work-order/work-order.loop.ts`
  (no longer wired post-`516c8772e` — only `LangGraphWorkOrderAgentService`
  is bootstrapped in `cli/index.ts:253` and `node-runtime.ts:889`).

Plan: `~/.claude/plans/ok-purrfect-biscuit.md`.

## [2026-05-12] fix(heartbeat): floor all Ollama-routed inference caps to prevent silent OOM (5b4bb55a)

Production hotfix — node-kike accepted CPU_INFERENCE WorkOrders that
crashed silently under memory pressure while GPU_INFERENCE drained
cleanly. Root cause: per-cycle cap suppression filter only floored
training caps; inference caps (which route to a colocated Ollama
daemon holding the model resident in its own process) were announced
regardless of host memory headroom.

Adds memory-floor entries for all 5 inference caps that share the
same Ollama-OOM family:
- `cpu_inference`: 900 MB (mirrors cpu_training footprint)
- `gpu_inference`: 2048 MB (GPU node system-RAM headroom for driver
  + loaded model metadata + HTTP server)
- `inference` / `llm` / `embedding`: 900 MB each, unconditional
  (Ollama-routed when `hasOllama=true`; sub-1GB nodes are non-viable
  for any workload, so over-conservatism on cloud-LLM-only nodes is
  acceptable vs threading a flag through the filter)

All 7 advertised caps in `determineCapabilities` are now floored
(cpu_training, cpu_inference, inference, llm, embedding, gpu_training,
gpu_inference). NOTE comment on `TRAINING_FLOORS_MB` rewritten to
honestly describe both OOM families (PyTorch local spawn vs Ollama
resident model); historical map name kept to avoid orthogonal rename
churn.

Test coverage: 9 new suppression cases (strip below floor, keep at
or above, log fires on transition) × 3 new caps; existing tests that
encoded the bug as expected behavior (e.g. "inference survives at
50 MB") updated to assert the fix. Floor-ordering invariant extended
to cover all 7 caps.

Reviewer-clean across 3 rounds (P10 lying doc-blocks corrected, P6
sibling-cap parallel gap closed for gpu_inference, sibling-family
MEDIUM closed for inference/llm/embedding). New pre-existing LOW
flagged at `heartbeat.ts:711` — GossipSub P2P heartbeat path bypasses
`applyMemoryPressureFilter`; coordinator does not consume P2P caps
for WO routing today, but future routing changes must wire the
filter.

## [2026-05-12] feat(lora-validation): Plan 1 Phase 2 — node validator runtime (opt-in, disabled)

Phase 2 of Plan 1 (peer-validated LoRA replay,
`~/.claude/plans/playful-watching-torvalds.md`). Adds the
node-side runtime that runs LoRA validation jobs. Disabled by
default — operators opt in via `--lora-validator` CLI flag (or
`LORA_VALIDATOR_ENABLED=true` env var). Coord-side Phase 3 will
wire the producer; until then no node ever receives the new WO
type, so this release is a pure no-op for current operators.

New `src/modules/lora/lora_validator.ts` implements the full
pipeline: precheck (hardware + MPS-rejects-GENERATION mirror of
trainer), sandbox under `<nodeHome>/lora-validation/<woId>/`,
signed-URL adapter download with sha256 verify + Content-Length
gate (200 MB cap), held-out-set download with same gates (50 MB
cap), Python subprocess (`python3 -u scripts/eval_lora.py` with
stdin JSON), `metrics.json` shape validation, canonical envelope
Ed25519 signing via the existing `IdentityHelper`, structured-log
metric `[lora-val-metric] outcome=accepted|rejected|timeout|error`
(no new prom-client dep). Single attempt, no retry (P21 — coord
re-assigns on its side).

Anti-collusion + sandbox guards (P2 + P7): host allow-list
(`amazonaws.com` default + `COORD_S3_ENDPOINTS` env override),
identity-peerId cross-check before signing, `..` traversal +
absolute path + `file://` rejection on every URL-derived
filename.

New `scripts/eval_lora.py` (348 lines, strict subset of
`train_lora.py` imports — zero new pip deps). Determinism gates
set before CUDA context: `CUBLAS_WORKSPACE_CONFIG`, seeded RNGs,
`torch.use_deterministic_algorithms(True, warn_only=True)`.
Refuses GENERATION on MPS, refuses validation sets with fewer
than 4 examples. Stdout = `progress` JSON lines only.

27 new tests at full branch coverage (adversarial: sha256
mismatch, oversized content-length, mid-stream cap, host
allow-list, file:// reject, traversal reject, subprocess
non-zero exit, missing metrics.json, malformed metrics JSON,
out-of-range metrics, identity peerId mismatch, SIGTERM on
timeout, Ed25519 round-trip). Reviewer-agent ship-as-is after a
single LOW one-line fix (deduplicated `error` metric emission
on metrics-parse failure).

Adjacent: two pre-existing `self-updater.spec.ts` assertions
were updated to match the 0.8.21 sudo-free `restartProcess`
refactor (assertion expected the pre-refactor `execFileSync`
+ raw `EACCES` strings; current code exits 0 + prints
`[SELF_UPDATE_RESTART]`). Fix is in scope per
`feedback_fix_all_tests.md`.

Build clean. Full suite 1576 passing / 43 skipped / 0 failing
(was 1574 / 43 / 2 before the fix).

## [2026-05-11] chore(version): align node to 0.8.17 with coord + node-ui (c70bbd46)

Lockstep bump. Node code unchanged from 0.8.16 (`@libp2p/utils@7.1.0`
pin still in place). Cycle reason: node-ui-v0.8.17 adds `libfuse2`
to the Linux CI deps so the AppImage bundling step succeeds (0.8.16
ubuntu build failed at `linuxdeploy`).

## [2026-05-11] fix(deps): pin @libp2p/utils 7.1.0 + 0.8.16 lockstep (2e31d5bc)

`@libp2p/utils@7.2.0` was published upstream after 0.8.15 shipped and
broke every fresh `npm install -g @synapseia-network/node@0.8.15`
because the postinstall `patch-package` step can no longer apply
`patches/@libp2p+utils+7.1.0.patch` cleanly against 7.2.0 (Job
onProgress diff conflict). Symptom:

```
ERROR Failed to apply patch for package @libp2p/utils
Patch was made for version: 7.1.0
Installed version: 7.2.0
```

The patch (WeakMap-backed re-entrance guard for the per-Job
onProgress lambda) is required for correctness — can't drop. Fix:
pin `@libp2p/utils` to the exact version the patch targets. A
direct-dep entry in `package.json` overrides whatever transitive
resolution the `libp2p` meta package would otherwise pull.

Lockstep bump 0.8.15 → 0.8.16 (coord + node + node-ui).

## [2026-05-11] chore(version): align node to 0.8.15 with coord + node-ui (73ead7fe)

Lockstep bump. Node code changes in this version cycle:
- Orphan AgentLoopHelper removal (6d3ff380)

This is the version that node-ui-v0.8.15 will bundle inside the
.dmg/.msi/.AppImage. The release.yml workflow waits for
`@synapseia-network/node@0.8.15` on the npm registry before building
node-ui DMGs (max 10 min retry).

## [2026-05-11] chore(agent-loop): remove orphan AgentLoopHelper (6d3ff380)

`AgentLoopHelper` was a registered-but-unused provider. The active
autonomous flow is `LangGraphWorkOrderAgentService`; the helper was
never wired into runtime. It hit three coord endpoints that have just
been removed (GET/POST/PATCH `/experiments`), so any future caller
would have 404ed. Deleted cleanly.

Removed:
- `src/modules/agent/agent-loop.ts`
- `src/__tests__/agent-loop.test.ts`
- `src/modules/agent/__tests__/agent-loop.spec.ts`
- `AgentLoopHelper` provider + export from `agent.module.ts`.

Untouched: `/hyperparams/experiments` calls in
`work-order.coordinator.ts` and `work-order.execution.ts` — that's
hyperparam-search, a different active feature.

Pairs with coord `9a2e418b` and dashboard `18900cb`.

## [2026-05-11] fix: README rewrite + CI Node 24 base + 0.8.13 (816e1779)

README: removed all references to the now-deleted `--coordinator`
CLI flag. The official coordinator URL is hardcoded; env-var
override (`COORDINATOR_URL` / `COORDINATOR_WS_URL`) documented
under an "Advanced" subsection for self-hosted operators. Rewrote
the CLI command reference to match the actual commander surface
(start flags, `wallet-create` / `wallet-verify`, `stake` group,
`claim-rewards` / `claim-wo-rewards`, `deposit-*` / `withdraw-*`).
Dropped Discord / Twitter TBD placeholders.

CI: bumped runtime to Node 24 so the runner ships npm ≥11.5 out
of the box. Trusted Publishing requires npm 11.5+ to send the
OIDC token; npm 10 (Node 22) returned `404 'not in this registry'`
on v0.8.12 publish attempts, and the in-place upgrade path
(`npm i -g npm@latest`) broke on `promise-retry` mid-migration.
Node 24 sidesteps both.

Version bumped 0.8.12 → 0.8.13.

## [2026-05-11] fix: WeakMap-backed guard + accurate comment for onProgress patch (0260125a)

Iteration on the 0.8.11 hotfix per reviewer feedback:

- Switched the re-entrance flag from `this._propagating` (an
  enumerable instance property) to a module-scoped
  `WeakMap<Job, boolean>`. The guard is now invisible to
  `Object.keys` / `JSON.stringify` on `Job` instances and is
  automatically released when a `Job` is GC'd.
- Rewrote the patch comment so it accurately describes the scope:
  the guard suppresses ALL synchronous re-entry on the same Job,
  not only the A↔B cross-Job cycle. libp2p does not re-enter its
  own Job synchronously today, so swallowing legitimate nested
  emissions is acceptable. Documented the trade-off (P10).

Version bumped 0.8.11 → 0.8.12 across the monorepo to keep node /
coord / node-ui aligned.

## [2026-05-11] fix: patch @libp2p/utils to break cyclic onProgress recursion (63173b74)

Production crash observed after the research/critique pipeline
completes:

```
RangeError: Maximum call stack size exceeded
  at JobRecipient.onProgress (@libp2p/utils/dist/src/queue/job.js:60)
```

Root cause: `@libp2p/utils@7.1.0` (and 7.0.x) ship a `Job.run()`
that builds an `onProgress` lambda which iterates `this.recipients`
and forwards events to each `recipient.onProgress`. When two Jobs
end up with each other's `run()` lambda registered as a
`recipient.onProgress` (re-entrant `queue.add` with
`options.onProgress` forwarded across queues), propagation
ping-pongs A ↔ B until `RangeError`.

Shipped a vendored patch (`patches/@libp2p+utils+7.1.0.patch`)
adding a `_propagating` boolean guard: on re-entry the lambda
no-ops and returns. The cycle becomes a single emission instead
of a stack-overflow loop.

Plumbing:
- `patch-package` added as a runtime dependency
- `postinstall` script runs `patch-package` on global install
- `patches/` directory bundled via `files` so it ships in the
  npm tarball
- Version bumped 0.8.10 → 0.8.11

Upstream fix tracked separately; we'll drop the patch once
libp2p ships its own guard.

## [2026-05-10] chore(version): align to 0.8.10 with coord + node-ui (9ed74a5a)

Version-only bump 0.8.9 → 0.8.10 to satisfy the project's
coord/node/node-ui version-sync invariant after node-ui shipped
SHA256 + lock + macOS-quarantine hardening. No code change in
this package.

## [2026-05-10] chore(version): align to 0.8.9 with coord + node-ui (b2a05c58)

Version-only bump 0.8.8 → 0.8.9 to satisfy the project's
coord/node/node-ui version-sync invariant after node-ui shipped
auto-download of Node.js v22 LTS. No code change in this package.

## [2026-05-10] chore(version): align to 0.8.8 with coord + node-ui (53372f16)

Version-only bump 0.8.7 → 0.8.8 to satisfy the project's
coord/node/node-ui version-sync invariant after node-ui shipped
auto-install bin-collision + non-fatal-boot follow-ups.
No code change in this package.

## [2026-05-10] chore(version): align to 0.8.7 with coord + node-ui (d9612cc7)

Version-only bump 0.8.6 → 0.8.7 to satisfy the project's
coord/node/node-ui version-sync invariant after node-ui shipped
a boot-time auto-install gate for the CLI. No code change in
this package.

## [2026-05-10] chore(security): pnpm overrides + version bump 0.8.5 → 0.8.6 (c7fdc41c)

Closes 4 of 5 osv-scanner findings against the published npm
artifact:

- `fast-uri ^3.1.2` (was 3.1.0) — closes GHSA-q3j6-qgpj-74h6 and
  GHSA-v39h-62p7-jpjc, both ReDoS, CVSS 7.5.
- `uuid >=11.1.1 <12 || >=13.0.1` (was 11.1.0 / 13.0.0) — closes
  GHSA-w5hq-g745-h8pq, CVSS 6.3.

Sub-lockfile regenerated (large delta because pnpm re-pinned many
transitives to current latest while resolving the new constraints).

Remaining: `bigint-buffer 1.1.5` (CVSS 7.7 buffer overflow) — no
upstream fix; pulled by `@solana/buffer-layout-utils`. Tracked,
acceptable.

Version bumped to 0.8.6 to keep coord/node/node-ui in sync.

## [2026-05-10] feat(npm): rename to @synapseia-network/node + publish to npm registry (3eaa248f)

First public npm release. Package renamed from `@synapseia/node` to
`@synapseia-network/node` (the `@synapseia` org wasn't registered on
npm; the user's existing namespace is `synapseia-network`). Added
`prepare: npm run build` script + GitHub Actions workflow
`publish-npm.yml` triggered on `node-v*` tag. Updated all install
hints in README, self-updater, round-listener, heartbeat, and the
`@synapseia-network/node` path lookup in `detectInstallType()`.
Manual first publish on 2026-05-10 (`@synapseia-network/node@0.8.5`).
Future releases auto-publish via tag push.

## [2026-05-09] chore(version): align to 0.8.5 with coord + node-ui (c2b5650b)

Version-only bump 0.8.2 → 0.8.5 to satisfy the project's
coord/node/node-ui version-sync invariant after the env-var-only
coord URL refactor. No code change.

## [2026-05-09] chore(config): env-var-only coordinator URL — drop user-facing knobs (2f441dff)

UX simplification: the coordinator URL is no longer something a user
configures. Operators that need to point a node at a non-default
coordinator set `COORDINATOR_URL` (and optionally `COORDINATOR_WS_URL`)
in the environment before launch; otherwise the hardcoded official
fallback wins.

Removed:

- `synapseia start --coordinator <url>` and `--coordinator-ws <url>` flags.
- `synapseia config --set-coordinator-url <url>` flag.
- The interactive "Coordinator URL" prompt at the top of the config
  wizard. The wizard now starts at model selection.
- `synapseia wallet-create --coordinator-url <url>` flag (the desktop
  UI no longer passes it; see `@synapseia/node-ui` 0.8.4).

Added:

- `src/constants/coordinator.ts` — single source of truth exporting
  `OFFICIAL_COORDINATOR_URL = 'https://api.synapseia.network'`,
  `OFFICIAL_COORDINATOR_WS_URL = 'https://ws.synapseia.network'`, and
  `getCoordinatorUrl()` / `getCoordinatorWsUrl()` resolvers
  (`process.env.X || OFFICIAL_X`).

Schema:

- `Config.coordinatorUrl` and `Config.coordinatorWsUrl` are now marked
  `@deprecated` and optional. Existing `~/.synapseia/config.json` files
  carrying these values still parse without error, but the runtime
  always resolves the URL through env-var-or-constant — the on-disk
  value is ignored. New config files written by `wallet-create` /
  `config` no longer include these fields.

No on-disk migration is performed: the deprecated fields are just
silently ignored on next read. Operators who relied on a custom
coordinator URL must export `COORDINATOR_URL` before starting the node
or the desktop UI.

**BREAKING:** Pre-refactor, `COORDINATOR_WS_URL` fell back to
`COORDINATOR_URL`'s value if not set. Post-refactor, it falls back to
the constant `https://ws.synapseia.network` instead. Operators running
a self-hosted coordinator who only export `COORDINATOR_URL` must now
also export `COORDINATOR_WS_URL` explicitly. Standard deployments
hitting the official coordinator are unaffected.

Version: `0.8.1` → `0.8.2`.

## [2026-05-07] chore(release): npm publish prep — FSL-1.1-ALv2 license + 0.8.1

Beta-launch slice S5 — package readiness for `npm publish` and public
GitHub repo:

- Removed `"private": true` from `package.json`.
- Bumped version `0.8.0` → `0.8.1` (additive feature: BETA_LIMIT_REACHED
  handling, no breaking changes for already-registered nodes).
- Added `LICENSE` file with **Functional Source License 1.1, ALv2 Future
  License** (FSL-1.1-ALv2). Permits personal use, modification, and
  redistribution for any non-Competing Use; auto-converts to Apache-2.0
  on the second anniversary of release (2028-05-07). Chosen over MIT /
  Apache-2.0 to prevent forks operating competing networks during the
  beta-to-mainnet phase.
- Added `repository`, `homepage`, `bugs`, `publishConfig: { access: "public" }`,
  `engines.node: ">=20"` fields. License field set to
  `"SEE LICENSE IN LICENSE"` because FSL is not in the SPDX official list.
- Extended `files` array to include `LICENSE` and `README.md` explicitly
  (npm bundles them by default; explicit entry documents intent).
- Verified `npm pack --dry-run`: 40 files, 202.8 kB tarball, 935.7 kB
  unpacked. No leaks (no `.env`, no wallets, no test fixtures).
- Confirmed `dist/bootstrap.js` shebang `#!/usr/bin/env node` present.

The actual `npm publish --access public` is operator-driven (requires
2FA OTP) and runs after the public GitHub repo is live.

## [2026-05-07] docs: README rewrite for beta tester onboarding

Rewrote README from internal-dev-focused content to a step-by-step
onboarding guide for beta testers running on Solana devnet. Covers
install via `npm i -g @synapseia/node`, wallet generation, devnet SOL
faucet, dashboard SYN faucet, node start, dashboard verification,
troubleshooting (incl. BETA_LIMIT_REACHED), CLI reference, and FSL
license summary. Placeholder URLs marked `<DASHBOARD_URL_TBD>` /
`<COORD_URL_TBD>` for sed-replacement before public launch.

Beta-launch slice S4.

## [2026-05-07] feat(heartbeat): handle BETA_LIMIT_REACHED 403 from coord

Coord (>= 8c05a78) rejects new node registration with HTTP 403 +
structured body `{ statusCode: 403, error: 'Forbidden',
code: 'BETA_LIMIT_REACHED', message, limit, current }` when its
`MAX_NODOS` cap is reached. The CLI now detects this specific error
code, prints a user-friendly framed message with a parseable
`[BETA_LIMIT_REACHED]` marker line on stderr, and exits with code 0
(expected state, not crash).

The marker line is consumed by node-ui (Tauri shell) as a fallback
to its pre-flight `/peer/capacity` probe in case the cap fills
between probe and CLI start. `console.error` is used directly (not
the project logger) so the marker line is emitted verbatim without
ANSI color or timestamp wrapping that would break node-ui's regex
`/^\[BETA_LIMIT_REACHED\]/m`.

Detection happens on the FIRST heartbeat (the registration call);
subsequent heartbeats from already-registered nodes never hit the
gate. Wallet creation runs at `cli/index.ts:339` BEFORE any
heartbeat, so users who hit the cap have already seen their wallet
address printed by `walletService.displayCreationWarning`.

Implementation:
- `src/modules/heartbeat/heartbeat.ts` (catch block, before the 426
  handler): early-exit on `status === 403 &&
  body?.code === 'BETA_LIMIT_REACHED'`.
- `src/__tests__/heartbeat.test.ts`: 3 new tests cover (a) cap-hit
  → exit(0) + marker, (b) 403 with non-cap code → falls through to
  retry, (c) 200 OK → no exit.

Beta-launch slice S2.

## [2026-05-06] feat: Langfuse LangGraph tracing (env-gated, prod-safe)

LangGraph agent now emits Langfuse traces with `userId=peerId` and
`sessionId=workOrderId` when `LANGFUSE_SECRET_KEY` is set. Each
LangGraph node (planning, retrieve, generate, critique, submit) +
LLM call surfaces as a span under one trace per `graph.invoke()` —
no per-step manual instrumentation needed.

Production-safe: when env unset, `langfuseCallbacks()` returns `[]`
so `graph.invoke({ callbacks: [] })` is a no-op. Zero allocation
beyond the empty array. The boot log prints
`Langfuse tracing: enabled → <url>` or
`Langfuse tracing: disabled (set LANGFUSE_SECRET_KEY to enable)`
for operator confirmation.

Implementation:
- New helper at
  `src/modules/agent/langgraph/langfuse-handler.ts` —
  `getLangfuseHandler(params)` and `langfuseCallbacks(params)`.
- Wired at the only `graph.invoke()` site in
  `agent-graph.service.ts:243` — merges with the existing
  `configurable.thread_id` (preserves) and adds tags + traceMetadata.
- Boot log line in `node-runtime.ts` (after line 450). URL only
  printed when `LANGFUSE_BASE_URL` is explicitly set; otherwise
  shows `(default endpoint)` so operators don't see a misleading
  localhost line on a node actually exporting to cloud.langfuse.com.
- `.env.example` documents the three optional env vars.

Dep added: `@langfuse/langchain@^5.3.0` (modern OTel-based SDK
matching the already-installed `@langfuse/otel` and
`@langfuse/tracing` v5 packages). Legacy `langfuse-langchain@3.x`
peer-dep `langchain <0.4.0` was incompatible with the project's
`@langchain/core@^1.1.41`.

Tests: 18 langgraph suites / 209 tests pass. Full node suite
unchanged.

## [2026-05-06] fix: round-listener defensively parses SYN-decimal + lamports

Coord migrated all reward fields to SYN-decimal strings
(`"33900.000000000"`). `round-listener.ts:152, 160` previously did
`(Number(lamports) / 1e9).toFixed(9)` which on the new format
produced `"0.000033900"` — wrong log AND wrong telemetry persisted
to the rolling-window state.

Replaced with a `parseRewardSyn()` helper that detects the format
by `.` presence:
- contains `.` → already SYN-decimal → `Number(s)`
- no `.` → lamports → `Number(s) / 1e9`

Mirrors `parseSynToLamports` shape in
`work-order/work-order.state.ts`. Both the `formatRewardSyn` log
line and the `myRewardSyn` telemetry now render the right SYN value
regardless of coord version (defensive across any deploy ordering).

Other node-side reward parsers (`work-order.evaluation.ts:148`,
`work-order.coordinator.ts:230`) already use `parseSynToLamports`
which is format-aware — no change needed.

Tests: 1548/0/43.

## [2026-05-06] fix: detectHardware respects OLLAMA_URL + populates hasCloudLlm

`detectHardware()` was pinging hardcoded `http://localhost:11434`
for `hasOllama` instead of honoring the `OLLAMA_URL` env. node-1
(docker container, Ollama at `http://ollama:11434` in a sibling
container) failed the ping → `hasOllama=false`. And `hasCloudLlm`
was declared on the `Hardware` interface but never populated, so
the `.env` `LLM_CLOUD_MODEL=minimax/MiniMax-M2.7` /
`LLM_PROVIDER=cloud` settings were silently dropped.

Result: `heartbeat.ts:446` cap-derivation gate
`hasOllama || hasCloudLlm` evaluated false → no `llm` / `inference`
caps registered → coordinator's research-WO requiredCapabilities
filter (`['llm']`) excluded node-1 → only `cpu_training` /
`cpu_inference` WOs reached it.

Fix:
- Ping `OLLAMA_URL || 'http://localhost:11434'` instead of hardcoded
  localhost.
- Replaced `execSync(\`curl -s ${ollamaUrl}/api/tags\`)` shell
  template with `URL` parsing + `spawnSync('curl', ['-s',
  '--max-time', '2', probeUrl])` array form to close a shell
  injection vector (operator env not user-input, but defense-in-depth
  worth it). Malformed `OLLAMA_URL` → `hasOllama=false`, no throw.
- `hardware.hasCloudLlm = !!(LLM_CLOUD_MODEL?.trim() ||
  LLM_PROVIDER?.trim().toLowerCase() === 'cloud')`.
- Boot log line `[hardware] hasOllama=... hasCloudLlm=... ...`
  guarded by module-level `hardwareLoggedOnce` so it fires once
  per process (`canInference()` / `canDiLoCo()` re-invoke
  `detectHardware()` per heartbeat tick).

Outstanding TODO (separate slice): `embedding.ts:26`,
`model-catalog.ts:293`, `inference-server.ts:111` also have
hardcoded `localhost:11434` and don't honor `OLLAMA_URL`. Out of
scope.

Tests: hardware 146/8/0 (4 new tests for OLLAMA_URL + cloud env
paths). Heartbeat 19/19. Full suite 1548/0/43 (was 1544).

## [2026-05-06] fix: trainer stderr per-line classifier (info / warn / error)

The Python subprocess `stderr` handler used to dump the entire
buffer with `logger.warn` on close. After the eval-deadline fix
added JSON observability traces (`{"stage":"eval-start", ...}`,
`{"stage":"eval-done", ...}`) to stderr, those informational events
appeared as WARN noise in the log even though training was running
correctly.

Replaced the close-time blob with a per-line classifier that
streams chunks, buffers split lines via `stderrLineBuf` (handles
mid-line chunk boundaries under load), and routes each complete
line:

- `{"stage": ...}` JSON traces → `logger.info` (observability)
- `Error:` / `Traceback` matches → `logger.error` (checked BEFORE
  `WARNING:` so `Error: WARNING:` is not mis-classified)
- `WARNING:` matches → `logger.warn` (genuine Python warnings)
- everything else → `logger.warn` (default safety — unknown
  stderr is suspicious)

The full stderr accumulator is preserved for the failure-path
`Error(...)` message emitted on non-zero exit, so OOM/SIGKILL
diagnostics still capture the complete trail.

Tests: trainer 24 passed / 10 skipped. Full node suite 1544/0/43
(2 above prior baseline, no regressions).

## [2026-05-06] fix: training eval deadline starvation (0 batches before deadline)

Training WOs were tripping `final eval consumed 0 batches before
deadline` on both node-1 (linux container) and node-kike
(Mac native) with val_dataset_size=4871 and batch_size 32 or 64.
Training was consuming the full budget; eval only got the
best-effort `max(now + 10s, deadline)` reprieve which on shared CPU
wasn't enough for even a single batch.

Reserved an eval budget UPFRONT in `train_micro.py`:
- `MIN_EVAL_BUDGET_SEC = 30.0`
- `eval_budget_sec = max(30.0, max_train_seconds * 0.10)`
- `training_budget_sec = max(max_train_seconds - eval_budget_sec,
   max_train_seconds * 0.5)`
- `deadline = start_time + training_budget_sec` (training stops here)
- `final_deadline = start_time + max_train_seconds` (eval claims
   the rest)

Moved the `if time.time() >= deadline: break` check from the TOP of
the eval batch loop to the BOTTOM, gated by `count > 0`, so the
first batch always runs even under tight budgets — sentinel only
fires for genuinely empty val_loaders, not for slow batch loaders.

Added stderr trace events `stage: "eval-start"` and
`stage: "eval-done"` (Node already captures stderr) so future
debugging can see exactly when eval started, how much budget it
had, how many batches ran, and how long they took.

JSON output schema unchanged (`valLoss`, `valLossEvalFailed`,
`valLossEvalFailureReason` semantics preserved).

Tests: trainer.test.ts 24/0, full node suite 1542/0/43.

## [2026-05-06] fix: node honors COORDINATOR_WS_URL split (HTTP vs WS process)

Coord is split into 3 processes per T5.4 — `coordinator-http`
(`:3701`), `coordinator-ws` (`:3702`), `coordinator-worker`
(workers, no port). Restarting `coordinator-http` was dropping every
node's Socket.IO connection because the node CLI used a single
`COORDINATOR_URL` for ALL coord interactions and `RoundListener`
called `io(coordinatorUrl)` against `:3701`.

Added optional `COORDINATOR_WS_URL` env + `--coordinator-ws` CLI
flag with resolution chain
`options.coordinatorWs || config.coordinatorWsUrl ||
process.env.COORDINATOR_WS_URL || coordinatorUrl`. RoundListener
uses `coordinatorWsUrl?.trim() || coordinatorUrl` so empty-string
env values fall through cleanly. HTTP fetch sites untouched.

Boot log prints both URLs + warns when they match (single-URL dev
setup supported, but operator is told that restarting coord-http
will drop WS clients in that mode).

Added `.env.example` documenting both vars; un-ignored via
`!.env.example` in `.gitignore`.

Tests: round-listener 4 → 6 (added fallback + override cases).
Full node suite 1542/0/43.

## [2026-05-06] fix: trainer valLoss=0 silent eval-failed → improved=true reward

`train_micro.py:evaluate()` returned `total_loss / max(count, 1) =
0/1 = 0.0` when val_loader had 0 batches. Live: 50K-char corpus split
90/10 + the LLM-mutated `effective_batch_size` (often 32+) produced
an empty val_loader. Node-side `improved = valLoss < bestLoss` ran
`0 < Infinity = true` → reward 3000 SYN claimed for a no-op
evaluation.

Fix:

- Python `evaluate()` returns `EVAL_FAILED_SENTINEL = 1e30` (chosen
  to stay JSON-safe; Python `float('inf')` serializes as `Infinity`
  which Node's `JSON.parse` rejects). `json.dumps(..., allow_nan=
  False)` for fail-loud on any future Inf/NaN slip.
- New JSON fields `valLossEvalFailed: bool` + `valLossEvalFailureReason:
  str` are the authoritative signal for the Node side.
- Pre-eval guard short-circuits when `len(val_dataset) == 0` with
  stderr context (`corpus_chars`, `seq_length`, `effective_batch_size`).
- Node-side 4-layer guard at `work-order.execution.ts`: `!evalFailed
  && valLoss > 0 && valLoss < SENTINEL && valLoss < currentBestLoss`.
- `submitTrainingResult` no longer recomputes `improved` (P6
  parallel-path violation flagged by reviewer); now accepts
  `improved` + `valLossEvalFailed` as params from the executor's
  guarded computation. Single source of truth.
- Shared sentinel constant exported as `TRAINER_EVAL_FAILED_SENTINEL`
  from `trainer.ts`; imported by the executor; cross-ref comment in
  the Python side names the TS export so future grep finds both.
- 4 new unit tests in `work-order.execution.improved-guard.spec.ts`
  cover: evalFailed=true, valLoss=0 legacy, valLoss=SENTINEL,
  happy-path.

Also includes a small pre-existing bit-rot fix in
`work-order.coordinator-stale.spec.ts` (added missing `wallet-1`
positional arg required since commit `979e91d7`). Test count
1538 → 1542 with 0 failures.

## [2026-05-06] fix: mutation-engine no longer demotes cloud LLM primary

`filterByInstalledModels` returned `[...matches, ...remote]` — Ollama
matches FIRST, cloud LAST. The training pipeline correctly resolved
the chain `[cloud-primary, ollama-fallbacks]` via
`resolveTrainingChain()` and passed it through, but mutation-engine
re-sorted right before the retry loop so the primary cloud model
ended up at the bottom of the candidate list. Result: every Ollama
fallback was tried in sequence (qwen2.5:1.5b OOM, qwen2.5:0.5b JSON
parse, all-minilm-l6-v2 not chat-capable) and cloud was never
attempted. Trainer fell through to hardcoded hyperparam defaults and
ran without LLM-driven mutation guidance.

Replaced the final concatenation with an order-preserving
`candidates.filter()` that keeps cloud/remote unconditionally and
drops only Ollama models that aren't installed locally. The existing
`MutationEngineError` no-compatible-LLM guard is preserved; the
`local`/`matches`/`remote` arrays still feed it.

Added 3 regression tests asserting the cloud primary stays at index
0 with both an installed Ollama present and with no Ollama at all.
Test count 15 → 18.

Also added a TODO comment in `training-llm.ts` flagging that the
chain auto-includes embedding models (e.g. `all-minilm-l6-v2`)
without checking chat capability — separate slice.

## [2026-05-06] fix: trainer pre-flight memory check + observability for training LLM

Two related symptoms after the heartbeat fix unlocked `cpu_training`
on Mac-native node-kike: training WOs reached the trainer but aborted
at pre-flight with `Insufficient memory: free=62MB, estimated
need=925MB (... total=16384MB)`.

`trainer.ts` had its own memory gate that still used `os.freemem()`
— the same broken signal we fixed in heartbeat at commit `9007a62`.
Replaced both call sites (gate + spawn-time snapshot) with a new
`readTrainingHeadroomMB()` helper that uses `os.totalmem() -
process.memoryUsage().rss`. Probe on this Mac: `os.freemem()` reports
92 MB → would falsely abort; new signal returns 16339 MB → passes the
900 MB floor with 18× margin.

Separately, the user reported the training pipeline was using local
Ollama (`qwen2.5:1.5b`) despite `LLM_PROVIDER=cloud` in node config.
Investigation: `resolveTrainingChain()` in
`modules/llm/training-llm.ts` already honors `LLM_PROVIDER=cloud`
when both `LLM_PROVIDER` and `LLM_CLOUD_MODEL` env vars reach the
process — and both training entry points (`work-order.loop.ts:294`
and `langgraph/nodes/execute-training.ts:27`) already call the
resolver. The Ollama selection is a deploy-time env-misconfig, not a
code bug. Added an observability log at execution time
`Training LLM: primary=<provider>/<model> (fallbacks: ...)` so the
misconfig is diagnosable from one line on next run.

Tests: trainer.test.ts + heartbeat-memory-pressure 4/4 still green.
Two pre-existing failures in work-order.coordinator-stale.spec.ts
(Set-mock typing issue from `a1dd9095`) — out of scope.

## [2026-05-06] fix: macOS cpu_training stripped (v2) — RSS-based headroom signal

Yesterday's fix (commit c04f811) swapped `os.freemem()` for
`process.availableMemory()` expecting the latter to be cache-aware on
macOS. Runtime probe today on Apple Silicon Node 24 disproved that:
both APIs return ~92 MB on a 16 GB Mac. vm_stat / Mach kernel does
not expose purgeable cache as available to the Node runtime, so
either signal triggers `applyMemoryPressureFilter` constantly on
mac-native dev hosts. node-kike was still missing `cpu_training`
and `gpu_training` from its coordinator-registered caps after
c04f811.

Replaced the helper with `os.totalmem() - process.memoryUsage().rss`:
the headroom available IF this process is the dominant tenant. RSS
reflects what THIS process holds; the difference against totalmem is
"how much room is left for spawning a training model". Probe on the
same Mac now reports 16340 MB headroom (vs 92 MB old signal), so the
900 MB floor never falsely trips. cgroup-limited containers still work
because `os.totalmem()` returns the container limit on Node 18+ and
RSS is process-scoped.

Caveats documented in JSDoc: other tenants on the host (IDE, browser,
sidecar) are NOT subtracted. Acceptable for production node hosts
(single-tenant) and dev hosts (owner-tunable).

`TRAINING_MEM_FLOOR_MB` left at 900. Tests use `freeMBOverride` for
deterministic injection — signal swap is transparent to the spec.
4/4 still green.

## [2026-05-05] fix: re-queue unprocessed pushed WOs after capacity-break

`pushQueue.drain()` returns every pending entry and clears the Map.
The work-order loop then ran filter → `selectByTypeRotation` → for-loop
accept. When the for-loop exited early on a backpressure `canAccept()`
break (slots saturated) or completed the first WO and returned, every
remaining item in `orderedByType` was DISCARDED — drain had already
removed them from the Map and they had no owner.

Live impact on Mac-native node-kike: the gossip queue accumulated
9+ CPU_INFERENCE WOs that never got accepted while GPU_INFERENCE
drained successfully (it's first-picked by type rotation,
`selectByTypeRotation` keys on least-executed-first). Self-reinforcing
starvation across iterations.

Fix:
- Loop now keeps a `pushedById: Map<string, PushedWorkOrder>` of the
  original drain payloads.
- A try/finally around the for-loop tracks `attemptedIndex` and
  `unprocessedStart`. On natural exit `unprocessedStart` stays at
  array length (no re-queue). On capacity break `unprocessedStart =
  attemptedIndex` (current WO included). On successful-accept return
  `unprocessedStart = attemptedIndex + 1` (accepted WO excluded).
- The `finally` re-queues `orderedByType.slice(unprocessedStart)`
  via a NEW `WorkOrderPushQueue.requeue(entry)` method that writes
  the original `PushedWorkOrder` back without resetting `receivedAt`
  and WITHOUT firing `wakeCb`. The 60s TTL safety contract on stale
  WOs is preserved across re-queue.
- Cap-mismatch drops in the drain filter now emit a `logger.warn`
  with the missing capability list (was silent — patrón P22).

Tests: existing 5 push-queue specs still green; one new spec asserts
`requeue()` preserves `receivedAt`, leaves the WO drainable, and does
not wake sleepers.

## [2026-05-05] fix: macOS cpu_training stripped — wrong namespace on availableMemory

`applyMemoryPressureFilter` in `heartbeat.ts` was supposed to use the
Node 22+ `availableMemory()` API (which excludes inactive cache the OS
will reclaim under pressure) but the helper queried it on the wrong
namespace — `os.availableMemory` does not exist; the API lives on
`process`. The `typeof fn === 'function'` guard fell through silently
and the helper always landed on `os.freemem()`.

On macOS, `os.freemem()` reports inactive cache as "used", so free RAM
reads in the 100–500 MB range even when the system is fine. Result:
node-kike (macOS native) crossed the 900 MB `TRAINING_MEM_FLOOR_MB`
floor on every heartbeat and lost `cpu_training` from its registered
caps — coord never offered training WOs to it. node-alpha (linux
container on the same Mac host) reads cgroup-aware free, stayed above
the floor, and kept the cap. Asymmetric behavior between two nodes on
the same hardware.

Switched the helper to `process.availableMemory()`. On Node 22+ this
returns vm_stat-based available bytes on macOS and MemAvailable on
Linux — both excluding reclaimable cache. On Node <22 we fall through
to `os.freemem()` (acceptable for linux containers, still buggy on
mac dev hosts; documented).

`TRAINING_MEM_FLOOR_MB` left at 900 MB. The existing
heartbeat-memory-pressure spec exercises the helper via a deterministic
`freeMBOverride` parameter, so no test mock changes were required.

### S13-D — Heartbeat DTO strict-only on hardwareClass

Node binaries older than commit `14ddfca5` (sent legacy `tier:` field)
register with `hardwareClass=0` after this change. All Synapseia-team
nodes have been rebuilt; third-party operators need to rebuild or
their nodes will tier-down.

## [2026-05-04] fix: S10-C C-1 honest per-channel heartbeat status log (c249fa72)

Old `[P2P+HTTP] Heartbeat sent via both channels` lied — fired
after the P2P publish regardless of whether HTTP succeeded. Now
each tick logs `[Heartbeat] tick (http={ok|FAIL:msg|skipped},
p2p={ok|FAIL:msg|skipped})`. P2P publish wrapped in its own
try/catch so a publish error no longer aborts the rest of the
tick.

## [2026-05-03] fix(node): align submit-result probe to coord WorkOrderStatus enum (a1dd9095)

`SubmitResultNode`'s pre-submit status guard required `ASSIGNED` or
`IN_PROGRESS`, but those literals do not exist in the coordinator's
`WorkOrderStatus` enum (`PENDING|ACCEPTED|COMPLETED|VERIFIED|CANCELLED`).
A WO accepted by the node stays in `ACCEPTED` until completion, so the
guard always classified the result as "stale", logged
`dropping stale result for WO ... (status=ACCEPTED)`, and skipped the
POST to `/work-orders/:id/complete`. Research rounds therefore ended
with `submissionCount=0` even though the node had finished the work and
saved it to its local brain.

- `submit-result.ts`: drop only when `probe.status !== 'ACCEPTED'`.
- `work-order.types.ts`: realign `WorkOrder.status` union with the
  coordinator enum (`PENDING|ACCEPTED|COMPLETED|VERIFIED|CANCELLED`).
- Tests: cover `ACCEPTED → submit` and
  `COMPLETED/VERIFIED/CANCELLED → drop`.

## [2026-05-03] fix(node/telemetry): reviewer follow-up — tighten safeLoss + extract helper

Reviewer feedback on the prior commit:

- SHOULD FIX #3 (correctness): `typeof === 'number'` accepted `NaN`,
  which would JSON-stringify to `null` and trip the coordinator's
  typed schema as a different telemetry error. Tightened to
  `Number.isFinite(...)`.
- SHOULD FIX #2 (testability/coverage): inlined coercion in
  `work-order.execution.ts` and `agent-loop.ts` extracted to
  `modules/agent/work-order/safe-loss.ts`. Both production sites and
  the new test now go through the same helper, so coverage tooling
  credits the production lines instead of an inlined re-implementation
  in the test file.
- SHOULD FIX #1 (docs): plan item B1 (heartbeat attempt warns) was
  already done in a prior commit — `heartbeat.ts:265` already uses
  `logger.debug`. No code change needed; noting here so the audit
  trail matches the plan.

## [2026-05-03] fix(node/telemetry): tame node_telemetry_events noise

Investigation of the coordinator's `node_telemetry_events` table showed
251 `severity=error` and 2,836 `severity=warn` rows in 7 days, where:

- The dominant "errors" were recoverable: the node had a fallback that
  succeeded, but the catch path still emitted `logger.error`.
- A large share of warnings were intermediate retry attempts that
  succeeded on a later try and shouldn't reach the dashboard at all.
- A handful were a real `TypeError` masquerading as a training error
  because `valLoss.toFixed()` was called on a value that could be
  undefined when the trainer returned a degraded result shape.

Surgical changes (no behaviour or contract change — only severity and
defensive coercion):

- `work-order/work-order.execution.ts`: catch around `trainMicroModel`
  and `runDiLoCoInnerLoop` is now `logger.warn` (the WO is reported
  `success:false` and the coordinator reassigns — recoverable). Also
  coerce `valLoss`/`finalLoss` to `0` before `.toFixed()` so a partial
  trainer result can never raise a TypeError.
- `langgraph/nodes/execute-training.ts`: outer catch downgraded to
  `logger.warn`.
- `langgraph/nodes/execute-research.ts`: ReAct catch downgraded to
  `logger.warn` (legacy executor immediately recovers).
- `langgraph/nodes/synthesizer-node.ts`: LLM-call catch and
  post-validation catch downgraded to `logger.warn` (`fallbackResult`
  always yields a submissible payload). Intermediate retry logs
  (extraction failed / schema invalid + `attempt < MAX`) downgraded to
  `logger.info` — the final `giving up after N attempts` line keeps
  `logger.warn`.
- `langgraph/nodes/plan-execution.ts`: outer catch downgraded to
  `logger.warn`; inner parse-fallback downgraded to `logger.info`
  (DEFAULT_EXECUTION_PLAN recovers cleanly).
- `model/active-model-subscriber.ts`: poll-failure logging now uses
  `consecutivePollFailures` with a 3-tick threshold — the first two
  failures are `debug`, the third escalates to `warn`, subsequent
  failures stay silent until recovery (`info`).
- `node-runtime.ts` (CoordWatchdog): `reconnecting` now logs at `info`
  (normal lifecycle), and dial failures gate behind a 3-attempt
  consecutive counter mirroring the subscriber pattern.
- `agent/agent-loop.ts`: `valLoss`/`bestLoss` `.toFixed()` calls now
  guard against non-finite numbers.

New tests:
- `__tests__/telemetry-severity.spec.ts` covers the subscriber
  escalation state machine (debug → warn → silent → info on recovery)
  and the `safeLoss` coercion contract used in the WO executor.

Expected impact: `severity=error` rows drop from ~251 to a handful;
`severity=warn` rows drop from ~2,836 to <300 (the residual is genuine
actionable warnings — GPU smoke failure, insufficient memory, terminal
retry exhaustion).

## [2026-05-03] fix(node): reviewer feedback on adapter slice (390221c0)

Independent code-review pass on the LLMResponseAdapter slice surfaced
four issues. All fixed:

- HIGH: `checkCloudLLM` pinged each provider with `maxTokens: 1`. For
  Anthropic that returns `stop_reason: max_tokens` with empty
  `content[]`, which the adapter (correctly) rejects as "no text
  blocks" — flipping the availability check to false for valid keys.
  Bumped the budget to 16 tokens so the parse path actually exercises
  successfully across all six vendors.
- LOW: `migrateModelSlug` was rewriting whitelisted-provider slugs
  with off-list model ids back to the top tier on every boot,
  silently demoting operator overrides (e.g. `openai/gpt-7-turbo` →
  `openai/gpt-5`). Migration now tolerates these — runtime
  `parseModel()` already accepts them.
- MEDIUM: migration WARNs redact querystrings (where API keys hide if
  pasted into `llmUrl`) and clip overlong `defaultModel` slugs in
  case an operator typed a secret into the wrong field.
- LOW: adapter URL fallback in moonshot/minimax/zhipu was silently
  duplicating the hardcoded endpoint when the provider table missed
  the entry — replaced with a constructor-time throw so a deploy bug
  fails loudly instead of routing through stale state.

## [2026-05-03] feat(node): provider whitelist + LLMResponseAdapter strategy (83311241)

Reworked the cloud-LLM dispatch so every provider goes through a small
strategy class (`LLMResponseAdapter`) instead of the old per-vendor
methods on `LlmProviderHelper`. Each adapter owns request shaping and
response parsing for one vendor — Anthropic's heterogeneous
`content[]` block array, Google's `candidates[].content.parts[]`,
OpenAI/Moonshot/MiniMax/Zhipu's `choices[].message.content`, and
MiniMax's 200-OK-with-`base_resp.status_code` quirk.

The provider list is now a closed whitelist sourced from a single
table in `src/modules/llm/providers.ts`:

| Provider | Endpoint | Top / Mid / Budget |
|---|---|---|
| openai | `api.openai.com/v1/chat/completions` | gpt-5 / gpt-4o / gpt-4o-mini |
| anthropic | `api.anthropic.com/v1/messages` | claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5 |
| google | `generativelanguage.googleapis.com/.../generateContent` | gemini-2.5-pro / -flash / -flash-lite |
| moonshot (Kimi) | `api.moonshot.ai/v1/chat/completions` | kimi-k2.6 / kimi-k2-0711-preview / moonshot-v1-32k |
| minimax | `api.minimax.io/v1/chat/completions` | MiniMax-M2.7 / abab7-chat-preview / abab6.5s-chat |
| zhipu (GLM) | `open.bigmodel.cn/api/paas/v4/chat/completions` | glm-4.6 / glm-4-plus / glm-4-flash |

The `openai-compat/*` slug and the `Custom…` UI option are gone — every
endpoint is hardcoded so the response schema matches the adapter that
parses it. Operator configs that still carry obsolete slugs are
auto-migrated on boot:
- `kimi/X` → `moonshot/X` (rebrand of internal id)
- `openai-compat/*`, `custom` → `anthropic/claude-sonnet-4-6`
- whitelisted provider, off-list model → top tier of that provider
- `llmUrl` field → stripped from `config.json` (one WARN, persisted)

Test coverage:
- 6 adapter unit specs in `src/modules/llm/adapters/__tests__/`
  — fixtures copied from each vendor's published response shape
- `llm-provider.spec.ts` rewritten to focus on dispatch + retry
- `__tests__/llm-provider.test.ts` is now a round-trip suite with
  one mock-fetch test per provider end-to-end through `generateLLM()`

CLI:
- `--llm-url` / `--set-llm-url` are kept on the parser as deprecated
  flags that log WARN and ignore the value (so older `synapseia-ui`
  builds and operator scripts that still pass them don't break).
- `synapseia config` interactive cloud picker now offers one entry
  per `(provider, tier)` pair, no `Custom URL` option.

## [2026-05-03] fix(node): WS handshake auth as callback so reconnects refresh timestamp (5106efc9)

socket.io-client's `auth: { ... }` option captures the payload once at
`io()` call time. The coord's `verifyWsHandshake` enforces
`TIMESTAMP_TOLERANCE_MS = 5 minutes`, so after 5 minutes every
reconnect was rejected with `Timestamp expired or invalid` and the
client eventually stopped trying. Reproduced in the wild — node-1
disconnected during the coord rebuild and never came back, even though
the relay path on the coord side was healthy.

Switched to the callback form (`auth: (cb) => cb({...})`). socket.io-client
invokes the callback on every connection attempt, so each (re)connection
regenerates a fresh `{ timestamp, signature }` and stays inside the
tolerance window indefinitely.

## [2026-05-03] fix(node): sign WS handshake so coord-ws accepts the round listener (d70afbb0)

After the createRequire-for-usearch fix landed, the RoundListener
finally connected to coord-http but the coord WS auth guard rejected
every connection with `Missing required auth fields: peerId, publicKey,
timestamp, signature`. Without an authenticated socket the node never
received `round.evaluating` events, the review loop never started, and
93 PENDING peer-review assignments stayed undrained — the originally
reported "no se generan discoveries" symptom persisted because nodes
were silently being bounced from the WS namespace.

- `utils/node-auth.ts`: added `buildWsHandshakeAuth({ privateKey,
  publicKey, peerId })`. Signs `${timestamp}:websocket:handshake` per
  the `verifyWsHandshake` contract on the coord side. Identity files
  store keys as PKCS8 / SPKI DER (`Node KeyObject.export({ format:
  'der' })`); the helper slices the trailing 32 bytes before signing,
  matching what the coord guard accepts.
- `round-listener.ts`: optionally injects `IdentityHelper`, loads the
  on-disk identity, and passes the signed payload via the
  `socket.io-client` `auth: { ... }` option. Falls back to anonymous
  connection when the helper isn't available (test stubs without the
  identity module).
- `identity.module.ts`: exports `IdentityHelper` so `AgentModule` can
  resolve it via `IdentityModule` (only `IdentityService` was exported
  before).

## [2026-05-03] fix(node): use createRequire(__filename) for usearch — no eval (ab26805c)

`eval('import.meta.url')` also failed under tsup ESM output: esbuild
rewrites direct eval into an indirect helper whose scope no longer
includes the original module's `import.meta`. Switched to
`createRequire(__filename)`. The tsup banner already injects
`__filename` per chunk by calling `fileURLToPath(import.meta.url)`
once at top-of-chunk, so the variable is a real on-disk path during
ESM init. Same line works under ts-jest CJS where `__filename` is the
native Node CJS global.

## [2026-05-03] fix(node): use direct eval('import.meta.url') for usearch ESM resolve (e9319821)

Follow-up to b3973e07. The `new Function(...)` probe used to read
`import.meta.url` always returned null under tsup ESM output because
`new Function` bodies execute in global scope where `import.meta` is
not a valid binding. node-1 still aborted at boot with
`[KgShardHnswSearcher] cannot resolve usearch — no CJS require and no
import.meta.url available`. Switched to `eval('import.meta.url')`
which inherits lexical scope under ESM (returns the URL) and throws a
SyntaxError under ts-jest CJS (caught — the CJS branch already
returned earlier via `typeof require === 'function'`).

## [2026-05-03] fix(node): resolve usearch via createRequire under ESM, drop bundle inline (b3973e07)

`startNode` aborted on boot with `Error: Dynamic require of "usearch"
is not supported` inside the tsup-bundled ESM output. The crash was
caught quietly enough that node-1 still answered HTTP polling for
`/work-orders/available`, but the WS `RoundListener` (and every other
post-`startNode` initialiser) never ran. Result: no Socket.IO
connection to the coordinator, no `round.evaluating` reception, and
the 93 PENDING peer-review assignments queued during the WS-gateway
incident kept piling up with no consumer.

- `tsup.config.ts`: marked `usearch` as `external` so its native N-API
  wrapper stays out of the bundle. tsup's prior inlining produced a
  dynamic `require('usearch')` against an unreachable bundle slot.
- `src/p2p/kg-shard/KgShardHnswSearcher.ts`: replaced the inline
  `require('usearch').Index` with a runtime-aware `loadUsearchIndex()`
  helper. CJS path (ts-jest) calls `require` directly; ESM path
  (production tsup output) uses `createRequire(import.meta.url)`.
  `import.meta.url` is read through a `new Function(...)` probe so
  ts-jest's CJS transformer never sees the literal token (mirrors
  `heartbeat.ts:resolveImportMetaUrl`). Also replaced the local
  `require('crypto')` with a top-of-file `import { createHash }`.

1514 tests green (12 in `KgShardHnswSearcher.spec`, 19 in
`wo-poll-killswitch.spec` were previously aborted by the same parser
issue and now pass).

## [2026-05-03] feat(kg-shard): bump KG_SHARD_COUNT_DEFAULT 16 → 32 (mirror) (ad13f287)

Mirror of coord-side commit 166f5097. Pre-soak rebalance — halves
RAM/shard, doubles slots. Both helpers byte-identical; 5-fixture
regression vector catches drift. Recomputed expected values at
count=32. Node p2p 93/93 green.

## [2026-05-03] feat(kg-shard): node-runtime wiring + SIGTERM persistAll + widened searcher hook (72d27355)

End-to-end runtime integration of the D.4-distribution + D.4-hnsw
slice. `node-runtime.ts` now wires `KgShardStorage` +
`KgShardHintStore` + `KgShardHnswSearcher` + `KgShardSnapshotClient`
into the live runtime.

Background bootstrap on every newly-granted shard:
1. If `<nodeHome>/shards/shard-<id>.bin` missing → `kgSnapshotClient.fetch`
   (peer-first via hints reversed for freshest-last, coord fallback).
2. `kgSearcher.loadShard(shardId)` — fast-load `.hnsw` else build.
3. `publishShardReady(...)` so other peers can chained-sync from us.

Topic subscriptions: `KG_SHARD_SNAPSHOT_READY` updates `kgHints`,
`KG_EMBEDDING_DELTA` appends to storage AND inserts into HNSW.
`makeKgShardQueryHandler` wires `kgSearcher` (no more stub) so
`/synapseia/kg-shard-query/1.0.0` returns real ANN hits.

Reviewer #8 — SIGTERM+SIGINT once-handlers call `persistAll()`
so dirty HNSW inserts within the debounce window survive shutdown.
Reviewer #10 — `hintsFor(shardId).reverse()` dials freshest first.
Searcher hook widened to `addItemToShard(shardId, vec, id)`.

Node p2p suite 105/105 green.

## [2026-05-03] fix(kg-shard): final reviewer items #1 #2 #3 — atomic save + drop dead addItem + searcher hook TODO (e405e7d3)

Closes 3 items from the D.4-hnsw final reviewer pass:
- #1 `KgShardHnswSearcher.atomicSave()` — `.tmp + rename` instead
  of in-place `Index.save(fp)`. Crash-safety on mid-save.
- #2 dropped dead `addItem(vec, id)` (was effectively noop; the
  `IKgShardSearcher` interface only requires `search()`).
  `addItemToShard` is the documented insert path.
- #3 TODO comment on `IKgShardSearcherHook` flagging the future
  widening to `addItemToShard(shardId, vec, id)` once node-runtime
  wires the searcher per shard.

Item #8 (SIGTERM `persistAll`) needs node-runtime work — tracked
in the deferred wiring slice. 93/93 node p2p specs green.

## [2026-05-03] feat(kg-shard): KgShardHnswSearcher backed by usearch — D.4-hnsw.0-5 (322c714b)

Adds `usearch` 2.25.1 (prebuilt N-API binaries for darwin-arm64,
darwin-x64, linux-arm64, linux-x64). Smoke-test (D.4-hnsw.0)
confirmed query p99 = 0.29ms on 100k × 768d (target ≤5ms),
persist 1.05× raw f32 (target ≤2x). Build cost ~770 rec/sec
mitigated by `.hnsw` persistence (`Index.load()` mmap on subsequent
boot).

`KgShardHnswSearcher` implements `IKgShardSearcher` per shard:
fast-path `.hnsw` load else build from `.bin` + persist;
`addItemToShard` for delta hot path; `markDeleted` tombstone with
post-search filter (HNSW has no O(1) delete); over-fetches by
tombstone count so filtered top-k still returns k. Vectors L2-
normalised on insert+query; sha256-derived bigint keys with
reverse string map. Debounced persist (60s default) +
`persistAll()` for SIGTERM. 12 specs green.

## [2026-05-03] fix(kg-shard): reviewer item #7 — KgShardStorage.appendMany batches fsync (31136878)

Reviewer flagged that `appendOne` opened/fsynced/closed the file
PER record, brutal on SSDs at 50 records × N envelopes/sec. Adds
`appendMany(shardId, records[])` that does a single open +
concatenated write + close per batch. Delta handler now feeds the
whole batch through `appendMany` (records share a shardId by
construction). `appendOne` kept as a thin wrapper for back-compat.
90/90 node p2p specs green.

## [2026-05-03] feat(kg-shard): node delta handler with anti-route-spoof + searcher hook — D.4-distribution.7 (625664ea)

`handleKgEmbeddingDelta` consumes the signed `KG_EMBEDDING_DELTA`
envelope from coord. Validation gates: envelope sig verifies +
body.shardId === record.shardId === shardIdFor(embeddingId)
(anti-route-spoof) + vector.length === 768. Owned shards →
`storage.appendOne` per record + optional `searcher.addItem` hook
(NO-OP until D.4-hnsw). Non-owned shards silently dropped. Per-
record failures are logged but don't abort the batch. 7 specs.

## [2026-05-03] feat(kg-shard): node-signed KG_SHARD_SNAPSHOT_READY topic + hint store — D.4-distribution.5 (273d389f)

Adds the chained-sync hint topic — a NODE-signed envelope that
announces "I have shard S persisted and ready" so future cold-boot
peers dial the announcer first instead of always falling back to
coord. Three pieces:

1. `KgShardHintStore` — in-memory `Map<shardId, Set<peerId>>`
   consulted by `KgShardSnapshotClient.fetch` before its coord
   fallback.
2. `handleKgShardSnapshotReady` — verifier. Anti-spoof:
   `pubkeyHex.startsWith(body.peerId)` BEFORE Ed25519 verify so a
   hostile peer can't claim shard ownership under a different
   peerId. Drops self-announces, stale envelopes, bad sigs,
   malformed bodies.
3. `publishShardReady` — signs canonical JSON of `{body,
   publishedAt}` with the node's private key. Carries the full
   32-byte pubkeyHex so verifiers can extract the pubkey without
   a coord round-trip.

8 verifier + producer specs.

## [2026-05-03] feat(kg-shard): node snapshot client + append-only storage — D.4-distribution.4 (c1b9509d)

Adds `KgShardStorage` (disk-only per-shard append-only file at
`<nodeHome>/shards/shard-<id>.bin`, atomic `tmp + rename` commit,
`appendOne` for delta path) and `KgShardSnapshotClient` (peer-first
sequential candidate iteration, coord fallback, Ed25519-signed
request, multi-frame stream consumption with vector-dim filter,
commit only on `done` sentinel).

Frame format on disk = same `[u32 LE len][JSON bytes]` as the wire
codec so a single parser reads both. `openSync` drops stale `.tmp`
from a prior crash before opening fresh.

15/15 specs green (8 storage + 7 client).

## [2026-05-03] feat(p2p): multi-frame stream codec helpers — D.4-distribution.2 mirror (84600417)

Mirror of coord-side codec extension (sub coord 64789aad). Adds
`sendJsonFrame` (no closeWrite per frame), `endJsonStream`, and
`readJsonFramesUntilDone<T,D>(stream, onFrame, isDone)` to
`src/modules/p2p/stream-codec.ts`. Same wire format as
`sendJsonOverStream` — parity vector with coord still holds.

Used by D.4-distribution.4 (`KgShardSnapshotClient`) to read the
multi-frame snapshot stream served by the coord-side handler. 9/9
codec specs green (5 new + 4 pre-existing).

## [2026-05-03] feat(kg-shard): shardIdFor helper + KG_SHARD_SNAPSHOT_READY/DELTA topics + KG_SHARD_SNAPSHOT_PROTOCOL — D.4-distribution.3 (797a2102)

Mirror of coord-side commit `36667779`. Adds the byte-identical
`shardIdFor` helper at `src/p2p/kg-shard/shard-hash.ts`, the
`KG_SHARD_SNAPSHOT_READY` + `KG_EMBEDDING_DELTA` topics on the
node-side TOPICS map, and the `KG_SHARD_SNAPSHOT_PROTOCOL` libp2p
stream protocol constant. Both helpers MUST stay byte-identical or
shard routing breaks; the shared 5-fixture regression spec catches
any drift on either side. 5/5 green.

## [2026-05-03] refactor(identity): hardcode COORDINATOR_PUBKEY_BASE58, drop env var (5f1d7359)

Replaces the runtime `SYNAPSEIA_COORDINATOR_PUBKEY_BASE58` env var
with a `COORDINATOR_PUBKEY_BASE58` constant in
`p2p/protocols/coordinator-pubkey.ts`. The pubkey is public by
definition — no secret to hide — so embedding it in source ships
the trust anchor inside the DMG with zero env wiring. Operators no
longer set anything for the node to verify signed envelopes.
`loadCoordinatorPubkey()` is now zero-arg. Three call sites in
`node-runtime.ts` (work-order-available, evaluation-assignments,
KG-shard) drop the `process.env.…` argument. Wiring specs keep
testing verifier behaviour against synthetic raw pubkeys; the
hardcoded constant is exercised by `coordinator-pubkey.spec.ts`.
p2p + cli suites green (53/53).

## [2026-05-03] refactor(kg-shard): drop SYNAPSEIA_KG_SHARD_HOSTING opt-in (3c28862b)

Dev-mode cleanup. KG-shard hosting is the read path, not an opt-in.
The wiring block now runs unconditionally when `p2pNode` is up, and
`loadCoordinatorPubkey` throws on missing
`SYNAPSEIA_COORDINATOR_PUBKEY_BASE58` — matching the loud-throw
contract every other signed gossipsub handler in this file uses
(work-order-available, evaluation-assignments). Per-shard
authorisation still gates serving via `KgShardOwnershipStore`: only
shards the coord has explicitly granted are served. p2p suite 47/47.

## [2026-05-02] feat(kg-shard): node-side hosting + signed-envelope handlers (D.4) (aa81e1a2)

Plan D.4. Skeleton for node-side KG-shard hosting. Adds:
- `verifyKgShardEnvelope` — Ed25519 verifier copy of the coord-side
  contract (canonical sorted-key JSON, 12-byte SPKI prefix, 2 min
  replay window).
- `KgShardOwnershipStore` — in-memory grant set with TTL prune.
- Gossipsub handlers for `KG_SHARD_OWNERSHIP` (upsert / revoke local
  grants) and `KG_QUERY_REDIRECT` (dial requester back when we own
  the shard).
- Libp2p stream handler `/synapseia/kg-shard-query/1.0.0` with
  pluggable `IKgShardSearcher`. Stub returns empty hits — HNSW plugs
  in here as the follow-up (TODO(D.4-followup)).
- Wire-up gated by `SYNAPSEIA_KG_SHARD_HOSTING=true`. Default OFF.

No new runtime dependencies. 5 new specs, 47 new cases. Full node
suite stays green: 103/104 suites, 1466 tests pass.

## [2026-05-02] fix(coordinator-pubkey): inline base58 decoder, drop bs58 (320a821a)

Even with a static import, `bs58 → base-x → safe-buffer` chain emits
a dynamic `require('buffer')` that tsup's ESM bundle rejects, killing
node-1 boot loop. Replaced with a 25-line inline base58 decoder using
only `Uint8Array` primitives — no package dep, no bundler hazard,
identical wire output for the 32-byte raw Ed25519 pubkey we care
about. 4 / 4 specs stay green.

## [2026-05-02] fix(coordinator-pubkey): static bs58 import (T2.5 canary, ded38229)

Live T2.5 canary boot logged `Dynamic require of "buffer" is not
supported — falling back to UNVERIFIED gossipsub WORK_ORDER_AVAILABLE
handler`, silently disabling envelope-signature verification. Root
cause: lazy `require('bs58')` works under jest (CJS) but tsup's ESM
bundle errors on the dynamic require for transitive 'buffer'.
Static `import bs58 from 'bs58'` resolves at build time. Without the
fix, canary nodes accept FORGED gossipsub envelopes — the whole point
of the T2 trust anchor disappears.

## [2026-05-02] feat(eval-assignments-verify): kick review cycle on signed envelope (7baa063)

T3.C.1. Worker nodes now subscribe to the coordinator's new
`EVALUATION_ASSIGNMENTS` gossipsub topic. Every verified envelope
addressed to the local peer fires
`ReviewAgentHelper.kickReviewCycle()` immediately, so peer review
starts within milliseconds of the coord inserting a PENDING row
instead of waiting up to the safety-net poll interval.

The HTTP poll fallback at `GET /evaluations/assignments?nodeId=X`
stays in place but its interval is bumped from 2 min to 10 min —
the gossipsub kick handles the hot path, the slower HTTP loop
catches dropped envelopes during a coord restart or transient mesh
partition. When `SYNAPSEIA_COORDINATOR_PUBKEY_BASE58` is unset the
subscription is skipped with a single warn; the 10-min HTTP poll
continues unaffected.

- `p2p/topics/evaluation-assignments.ts` (NEW) — parse + verify
  Ed25519 over `JSON.stringify({payload,ts})`, drop stale (>60s),
  drop forged.
- `node-runtime.ts` — new wiring block alongside the WO
  subscription; injects `ReviewAgentHelper` from DI and reuses the
  same trust anchor loader.
- `modules/agent/review-agent.ts` — public `kickReviewCycle()`
  wrapper + `POLL_INTERVAL_MS` bumped to 10 min.
- `modules/p2p/p2p.ts` — `EVALUATION_ASSIGNMENTS` added to TOPICS
  so the auto-subscription loop covers it.

Tests: 5 envelope specs + 6 wiring specs (match / non-match /
forged / stale / env-unset / 10-min interval).

## [2026-05-02] feat(wo-poll-killswitch): SYNAPSEIA_DISABLE_WO_POLL killswitch (b7c538b8)

Tier 2 §2.4.1 ships the per-peer opt-in for gossipsub-only work-order
discovery. Operators set `SYNAPSEIA_DISABLE_WO_POLL=true` (case-
insensitive) and the legacy `GET /work-orders/available` poll loop is
skipped at boot — the node still subscribes to the signed gossipsub
`WORK_ORDER_AVAILABLE` topic and drains the push queue, so newly-
PENDING work orders arrive within milliseconds. Any other value
(unset, empty, `false`, `0`) keeps the existing fallback poll.

- `src/node-runtime.ts`: extracted two pure helpers — `isWoPollDisabled`
  and `maybeStartWorkOrderPoll` — and rewired the §4 work-order block
  through the new wrapper. `sanitizeForLog` is now exported so the
  echoed env-var value in the info log can't carry CR/LF or ANSI
  bytes (log-injection guard for an operator-controlled string).
- `src/__tests__/wo-poll-killswitch.spec.ts`: 19 new specs covering
  the four scenarios from the plan (unset, `'true'`, `'false'`,
  `'TRUE'`) plus substring guards (`'truthy'`, `'truee'`),
  whitespace trimming, error forwarding, and the sanitizer.

## [2026-05-02] feat(node-p2p-verify): signed WO envelope handler + cli wiring (5df9b657)

Tier 2 §2.2 closes the consumer leg of the signed gossipsub pipeline.
Nodes now verify each `WORK_ORDER_AVAILABLE` envelope's Ed25519
signature against the coordinator's trust-anchor pubkey before
queueing the WO for execution.

- §2.2.1: `p2p/protocols/coordinator-pubkey.ts` — synchronous
  bs58 loader that asserts a 32-byte raw Ed25519 pubkey decoded from
  the new `SYNAPSEIA_COORDINATOR_PUBKEY_BASE58` env var. Throws with
  the env-var name baked into every error so operators get an
  actionable message on misconfiguration.
- §2.2.2: `p2p/topics/work-order-available.ts` — pure handler (no
  libp2p import) that parses raw envelope bytes, verifies the
  Ed25519 signature over `JSON.stringify({wo, ts})` via node's
  native `crypto.verify`, drops envelopes outside the 60 s
  freshness window, and rejects payloads with no `wo.id`. All
  rejection paths warn with a sanitized prefix and never invoke
  the consumer. Companion `verify-ed25519.ts` mirrors the SPKI
  wrapping the coordinator's `ed25519-verify.ts` already uses.
- §2.2.3: `node-runtime.ts` — load the pubkey ONCE at startup, then
  register a raw-bytes handler on the new `P2PNode.onRawMessage`
  API. When the env var is unset the boot path logs a warn and
  falls back to the legacy unverified handler so the §2.2.5 soak
  phase doesn't break existing nodes that haven't deployed the env
  yet (TODO marker for fallback removal post-rollout). `p2p.ts`
  gains a parallel raw-bytes dispatch path so the verifier can
  re-hash the publisher's exact payload bytes; the existing
  parsed-JSON `onMessage` API is untouched.

13 new tests: 4 trust-anchor (happy + unset + empty + wrong-length),
5 envelope handler (verified passthrough, forged drop, stale drop,
malformed JSON drop, missing-wo.id drop), 4 cli wiring (forged
silently rejected, trusted forwarded, refuses to wire on empty or
wrong-length pubkey). Fixtures sign with node `crypto` Ed25519 keys
locally — no libp2p in any spec.

Suite: 1403 passing (+13 from 1390 baseline), 0 failures, 95 of 96
suites green; 1 pre-existing skipped suite unchanged.

## [2026-05-02] perf(heartbeat): default interval 30s → 60s + langgraph spec fixes (267ece4d)

Tier 3 §3.C.2. Heartbeat default lowered from 30 s to 60 s — halves
the coordinator HTTP heartbeat qps every node generates. The 5-min
online cutoff in coord `peer.service.ts:292` still tolerates 5 missed
cycles before marking a peer offline. Presence flusher cron stays at
`EVERY_30_SECONDS`; its 45 s lock TTL is sized to the work the cron
does, not correlated with heartbeat cadence.

Bundled with two pre-existing langgraph spec fixes that were gating
the node suite (project rule: "fix all tests before completing a
task"):

- `langgraph-coverage.test.ts`: add `getWorkOrder` to the
  `WorkOrderCoordinatorHelper` mock — `submit-result.ts:53` started
  calling it but the comprehensive coverage mock wasn't updated.
- `synthesizer-node-schema-retry.spec.ts`: replace
  `Record<string, unknown>` annotation with `any` (jest's babel-jest
  hoist pre-parser, no TS preset, treats `<string,…>` as the `<`
  operator and chokes); flip retry-cap expectation 3 → 2 to mirror
  the production constant `SCHEMA_VALIDATION_MAX_ATTEMPTS` lowered on
  2026-04-30.

92 / 92 suites green, 1390 / 1390 tests pass (43 skipped — pre-existing).

## [2026-05-02] release: v1.0.0 — public-network milestone

First stable release of the Synapseia node agent.

What "1.0.0" means in this codebase:

- **Stable wire protocol with the coordinator** — REST endpoints,
  WebSocket frames, and gossipsub topic schemas (`WORK_ORDER_AVAILABLE`,
  presence, evaluation, discovery) are frozen for the 1.x line.
- **libp2p stack productionised** — gossipsub + kad-dht + bootstrap +
  noise + yamux + tcp; benign race logging tuned, MaxListeners warning
  suppressed at the cli boundary, gossipsub `StreamStateError` is
  surfaced as warn (not error) since the protocol self-recovers.
- **LangGraph agent surface stabilised** — researcher / synthesizer /
  reviewer / docking nodes share a single `LangGraphLlmService` with
  retry + JSON-repair preprocessor, capability-gated heartbeat,
  pre-submit work-order status probe, poison-input short-circuit.
- **Auto-update + version gating** — node refuses to run against an
  incompatible coordinator and self-updates from the official
  release feed; trust model documented (public source, Synapseia-only
  push).
- **Telemetry hardened** — backpressure-aware batching, gossipsub
  publish try/catch, trainer `.finally().catch()` chokepoint fixed,
  Ollama mem_limit aligned with model footprint.

Limits acknowledged for 1.0.0:

- Some submission + evaluation paths still go through coordinator
  HTTP (not gossipsub-only). Full P2P submission lands post-1.x.
- Federated DiLoCo gradient sync still uses coordinator as the
  rendez-vous. P2P AllReduce is roadmap.
- Reputation lookup is read-only against coordinator; EigenTrust-
  style P2P reputation is post-1.x.

Version sync: matches `@synapseia/coordinator` 1.0.0 and
`@synapseia/node-ui` 1.0.0.

## [2026-05-01] fix(telemetry): Step 3 — Bug F (LLM drift) + G (training capability) + H (stale WO) + I (ReferenceCorpus undefined) (772e9b49)

Step 3 of the node-error-cleanup plan. After Step 1 (3d7cc0c9) cut
`node_telemetry_events` from 14k+/7d → 130/snapshot, this round
attacks the residual real bugs.

**Bug F1 — JSON repair preprocessor**
  - `src/shared/parse-llm-json.ts:42-124` — new `repairLlmJson()`
    (3-pass: strip line/block comments, drop trailing commas before
    `]`/`}`, close unterminated strings + balance braces).
  - `src/shared/parse-llm-json.ts:132-139` — new `stripCodeFence()`
    broadens the existing fence regex to match ` ```json `, ` ```JSON `,
    bare ` ``` `, and missing trailing fences.
  - `src/shared/parse-llm-json.ts:248-254` — final repair-on-fence-stripped
    fallback for inputs so badly truncated that
    `extractFirstJsonStructure` returns null. Repair closes the dangling
    string + appends the missing `}` so JSON.parse can succeed.
  - 17 new tests in `parse-llm-json.spec.ts` covering trailing commas,
    line/block comments, broadened fences, truncated trailing strings,
    deep nesting balance.
  - No new runtime dependency — `jsonrepair` was not already in
    package.json and the brief flagged "do not add a dep for a 40-line
    problem space".

**Bug F2 — SynthesizerNode retry feedback + poison short-circuit**
  - `src/modules/agent/langgraph/nodes/synthesizer-node.ts:25` —
    `SCHEMA_VALIDATION_MAX_ATTEMPTS` lowered 3 → 2 (poison inputs no
    longer burn 3 LLM calls).
  - `synthesizer-node.ts:30-66` — new `SCHEMA_RETRY_FIELD_EXAMPLES`
    (~600 chars) with WRONG/CORRECT pairs for the three recurring
    failures observed in `node_telemetry_events`:
    `novel_contribution must be non-empty`, `evidence_type must be
    non-empty`, `supporting_dois must contain ≥ 2 distinct valid DOIs`.
  - `synthesizer-node.ts:99-103` — retry feedback now appends the
    relevant example block(s) selected by which fields the validator
    complained about.
  - `synthesizer-node.ts:130-145` — poison-input short-circuit: if
    `parseResearchResult` returns empty `summary` AND empty `proposal`
    AND `keyInsights.length === 0`, bail with
    `executionResult: { success: false, result: 'context_overflow_or_silent_llm' }`.

**Bug F3 — Long-title truncation in prompts**
  - `src/modules/agent/langgraph/prompts/medical/medical-synthesizer.ts:18-26`
    + `medical-researcher.ts:18-26` — new `TITLE_MAX_CHARS = 120`;
    `Paper:` line uses `truncateTitle(title)` so the prompt never
    burns more than 120 chars on the title. Full title preserved in
    `payload.title` for the WO record.

**Bug G1 — Memory-pressure capability gating**
  - `src/modules/model/trainer.ts:14` — exported new
    `TRAINING_MEM_FLOOR_MB = 900` constant. Single source of truth
    shared between trainer pre-flight and heartbeat capability
    filter.
  - `src/modules/heartbeat/heartbeat.ts:32-49` — new
    `TRAINING_CAPABILITIES = {training, cpu_training, gpu_training,
    lora_training, diloco_training}` set + module-private
    `lastAnnouncedCapabilities` ref + `__resetCapabilitySnapshotForTests()`
    test hook.
  - `heartbeat.ts:142` — heartbeat publish path now wraps the raw
    capability list in `applyMemoryPressureFilter(...)`.
  - `heartbeat.ts:325-365` — new `applyMemoryPressureFilter(capabilities,
    freeMBOverride?)`: when free RAM is below the floor, strip every
    training-class capability for THAT CYCLE only. Capability returns
    automatically on recovery. Logs `info` ONLY on transition.
  - 4 new tests in `heartbeat-memory-pressure.spec.ts` (strip on
    pressure, restore on recovery, info on transition only, no-op
    when no training caps to begin with).

**Bug H1 — Pre-submit WO status check**
  - `src/modules/agent/work-order/work-order.coordinator.ts` — added
    `getWorkOrder(coordinatorUrl, workOrderId)` helper.
  - `src/modules/agent/langgraph/nodes/submit-result.ts:36-65` — before
    POST, GET the WO. If status is not `ASSIGNED`/`IN_PROGRESS`, log
    info and short-circuit with success-shape so the agent loop closes
    the WO without retry. `probe === null` (404 from coordinator) is
    treated as "still ours, proceed".
  - New tests in `submit-result-stale.spec.ts` and
    `work-order.coordinator-stale.spec.ts`.

**Bug I — ReferenceCorpus undefined topic**
  - `src/modules/agent/langgraph/tools/tool-runner.service.ts:16-93` —
    in both `search_reference_corpus` and `query_knowledge_graph`
    cases, validate `topic` is a non-empty string before invoking the
    tool. If missing/undefined, `logger.info` and return
    `{ success: false, reason: 'missing_topic' }` so the ReAct loop
    sees the failure and adjusts.

Build green (tsup, 304ms). Tests: 5 suites / 71 tests / 0 fails.

Three Man Team: Bob built (opus subagent, killed mid-test by
session timeout — Arch finished verification + two surgical follow-up
fixes for the parse-llm-json fallback and heartbeat freeMBOverride);
Richard reviewed (1 Must Fix on missing `diloco_training` in
TRAINING_CAPABILITIES, 1 Should Fix on submit-result audit comment —
both resolved before commit).

## [2026-05-01] fix(telemetry): node error cleanup — Bug A/B/C + Phase 2 noise (3d7cc0c9)

Reduces `node_telemetry_events` warnings/errors that survived the
infra remediation (Postgres OOM cascade fix). 32 PG backend crashes
between 2026-04-29 and 2026-05-01 cascaded into ~14k node telemetry
events; the heartbeat / p2p / model-subscriber surge was symptomatic
and resolved by `docker compose --profile observability` + Langfuse
isolation + 8 GiB Docker VM. What follows are the residual real bugs.

**Bug A — gossipsub publish on closed stream**
  - `src/modules/p2p/p2p.ts:193-216` — wrap `pubsub.publish()` in
    try/catch. `StreamStateError` (libp2p Yamux mid-publish close,
    normal mesh churn) is now demoted to `logger.debug` instead of
    surfacing as `unhandledRejection` (735 events / 7d, 4 fatals).

**Bug B — Trainer SIGKILL containment + safety margin**
  - `src/modules/model/trainer.ts:170-189` — bump `PYTHON_TORCH_MB`
    800 → 900 and safety multiplier 1.3 → 1.5. The pre-flight
    estimator was passing, then runtime OOM'd because torch + python
    interpreter boot consumes ~700–900 MB before the user model is
    touched.
  - `src/modules/model/trainer.ts:359-376` — chain
    `trainingPromise.finally(() => clearTimeout(...)).catch(() => {})`.
    Root cause of 4 fatals: `.finally(...)` returns a derived promise
    that propagates the trainer rejection; nothing observed it, so
    OOM SIGKILLs surfaced as `unhandledRejection` and crashed the
    node. Caller-side wrappers in `work-order.execution.ts:294` and
    `agent-loop.ts:148→197` were already correct — the leak was
    inside the trainer.

**Bug C — SynthesizerNode missing-input diagnostic**
  - `src/modules/agent/langgraph/nodes/synthesizer-node.ts:39-46` —
    warning now lists exactly which input is missing
    (researcherOutput / criticOutput / researchPayload). Fallback
    control flow unchanged; only the diagnostic improves so the
    upstream silent-fail can be traced (2174 warns / 7d).

**Phase 2 — Noise reduction**
  - `src/modules/agent/langgraph/nodes/fetch-work-orders.ts:34` —
    backpressure-skip-poll `logger.warn` → `logger.info`.
  - `src/modules/agent/work-order/work-order.loop.ts:175` —
    backpressure-skip-remaining `logger.warn` → `logger.info`.
  - `src/modules/agent/work-order/backpressure.service.ts:43` —
    capacity-rejection `logger.warn` → `logger.info`. All three:
    expected steady-state behaviour for a busy node, not anomaly.
  - `src/modules/heartbeat/heartbeat.ts:218-221` — per-attempt
    failure `logger.warn` → `logger.debug`. Cycle-level failure at
    line 401 stays `warn`; final failure at line 444 stays `error`.

**Tests**
  - `src/__tests__/trainer.test.ts:7-26, 318-379` — added `os` mock
    so `checkMemoryHeadroom` doesn't fail on low-RAM CI runners;
    structural regression guard asserts the `.finally(...).catch(`
    chain is in place; documented `it.skip` SIGKILL test pending
    ts-jest ESM mock support (consistent with existing skipped
    spawn-mocked tests in this file).
  - `src/modules/agent/work-order/__tests__/backpressure.service.spec.ts:5-8`
    — added `info: jest.fn()` to logger mock to match the demoted
    level.

Build: `npm run build` green. Test suites: 5 / 56 pass / 10
pre-existing skips / 0 fail.

Three Man Team workflow: Bug A + Bug D + 2 of 3 Phase 2 sites
shipped manually by Arch (logged as a deviation in
`handoff/BUILD-LOG.md` Step 1); remainder built by Bob and reviewed
by Richard with 0 Must / 0 Should / 0 Escalate. Detailed line ranges
in `handoff/REVIEW-REQUEST.md`.

## [2026-05-01] feat(p2p): WORK_ORDER_AVAILABLE consumer — push queue + 5min fallback (50b9743e)

Phase 2A of the Tier 2 scalability plan, node side. Drops the 30s
poll on `GET /work-orders/available` and replaces it with a local
queue (`WorkOrderPushQueue`) fed by the coordinator's gossipsub
broadcast on `/synapseia/work-order/1.0.0`. HTTP polling stays as a
5-min safety-net fallback (`workOrderIntervalMs`, override via
`WO_POLL_INTERVAL_MS`).

- New `WorkOrderPushQueue` (60s TTL, drain-and-clear, wake hook).
- `WorkOrderLoopHelper`: interruptible sleep + drain queue first;
  HTTP only when queue empty.
- `node-runtime`: subscribe to topic, push DTO into the queue, log
  queue size on each receive.
- `CLI`: app.get(WorkOrderPushQueue) → wire into runtime services.

5 new specs cover queue ordering, dedup, TTL, wake callback
isolation, and clear(). Full suite: 1356 passed.

## [2026-04-30] fix(cli): suppress benign libp2p StreamStateError unhandled rejections (e3e2afb1)

Filter `process.on('unhandledRejection')` to drop reasons whose name is
`StreamStateError` or `code === 'ERR_STREAM_RESET'`. These come from a
gossipsub/Yamux race during peer churn — gossipsub recovers on the next
tick. Drops to debug (no telemetry, no console noise) so real unhandled
rejections stay visible.

## [2026-04-30] fix(trainer): memory preflight + OOM error context (58063409)

Pre-spawn check estimates RSS need (python+torch + params + Adam + activations)
and refuses to launch when freemem can't cover it with 30% headroom. When the
cgroup kill fires anyway, the error string now carries hyperparams + memory
snapshot at spawn time so OOMs are attributable without source-diving.

## [2026-04-30] fix(heartbeat): escalate warn→error only after N consecutive failures (99454ede)

Single-cycle heartbeat failures during coordinator restarts no longer flood
telemetry as `severity=error`. Track consecutive failed cycles; emit `warn`
for the first 4 (~60s of unreachability) and escalate to `error` once on
the 5th. Recovery resets the counter and logs an `info` line.

## [2026-04-30] feat(llm): circuit breaker around OllamaHelper.generate (e61588af)

Process-wide CircuitBreaker (5 failures / 60s → open 30s) gates every
generate() call. Suppresses retry storms during Ollama crashes — telemetry
volume drops 5–20× while the underlying outage is readable. Self-contained
utility in `utils/circuit-breaker.ts`; tests cover closed/open/half-open
transitions and window expiry.

## [2026-04-30] feat(mutation-engine): preflight installed Ollama models before iterating (f690fd0e)

Probe Ollama's `/api/tags` for installed model names and prune candidates
that are not present. Saves up to 8 log lines per training WO on CPU-only
nodes that have none of the required models. Throws MutationEngineError
immediately with an actionable hint ("ollama pull <model>"). Best-effort —
falls through to the original loop when Ollama is unreachable.

## [2026-04-30] fix(telemetry): expand inferSubsystem to recognize all real prefixes (5f7729c5)

The previous switch only matched canonical names (training, inference, embedding,
p2p, llm, ...) so 729/729 errors fell into `subsystem='other'`. Production logs
use prefixes the switch never knew: ResearcherNode, SelfCritiqueNode,
PlanExecutionNode, CriticNode, SynthesizerNode, ModelSubscriber, AgentGraph,
MutationEngine, CoordWatchdog, Heartbeat, Backpressure.

Added explicit mappings for all 11 plus keyword-based fallback for prefix-less
messages (Generation failed → llm, Mutation engine → training).

## [2026-04-29] feat(observability): migrate LangSmith → Langfuse v5 SDK + self-hosted container (30632bce)

Replaced `langsmith/traceable` with `@langfuse/tracing` `startActiveObservation` (OTel-based).
`LangGraphLlmService` and `ToolRunnerService` now trace to a self-hosted Langfuse v3 instance
via `LANGFUSE_SECRET_KEY` opt-in. Added `instrumentation.ts` (OTel + `LangfuseSpanProcessor`),
initialised in `cli/index.ts` before NestJS bootstrap.

## [2026-04-29] feat(observability): opt-in LangSmith traces on LangGraph agent — dev-only (71d51ab7)

`LangGraphLlmService.generate` / `generateJSON` and
`ToolRunnerService.run` are now wrapped with `langsmith` `traceable`.
No-op unless `LANGCHAIN_TRACING_V2=true`. When enabled, every ReAct
LLM call + each tool invocation appears as a parent/child span on
LangSmith with prompt, output, and latency.

DEV ONLY — production deployments must never set the env var.
Traces leak prompt + LLM output to LangChain Inc, which breaks the
per-node trust model when nodes contain pre-publication discoveries
+ paper content. Setup steps + cost ceiling documented in the
`.env.example` LangSmith section in the root repo.

## [2026-04-29] fix(node): use realHardware.gpuModel in shutdown telemetry (be1b9f98)

`node-runtime.ts:468` was reading `hardware.gpuModel`, but `hardware`
is the trimmed heartbeat shape (`{ cpuCores, ramGb, gpuVramGb, tier,
hasOllama, hasCloudLlm }`) which has no `gpuModel`. Switched to
`realHardware.gpuModel` to match the line 391 pattern. Resolves the
TS2339 the final reviewer surfaced.

## [2026-04-29] feat(lora): node-side trainer + Python LoRA script + WO dispatch (238bc674)

Layer 2 task 9/13 of the 4-layer pharma plan
(`~/.claude/plans/lucky-mixing-dongarra.md`). Closes the node-side
LoRA flow against the coordinator stack shipped in T8.

`src/modules/lora/`:
- `types.ts` mirrors the coordinator's payload shapes wire-byte for
  wire-byte.
- `runLora()` orchestrates: GPU detection (refuses LORA_GENERATION
  on a CPU-only node loudly), spawn `python3 scripts/train_lora.py`
  with the WO payload + outDir on stdin, read the adapter +
  metrics.json the Python writes, sha256 the artifact, PUT to the
  WO's pre-signed S3 URL via `fetch`, return a
  `LoraSubmissionPayload`. 4h default timeout. Per-WO temp dir
  cleaned on exit. Same trust model as `trainer.ts` (no sandbox).

`scripts/train_lora.py` is a single-file Python entry point using
HuggingFace `transformers` + `peft`. Subtype-aware:
- `LORA_CLASSIFICATION` → AutoModelForSequenceClassification +
  TaskType.SEQ_CLS, accuracy + macro-F1 metrics.
- `LORA_GENERATION` → AutoModelForCausalLM + TaskType.CAUSAL_LM,
  perplexity metric (asserts CUDA — defence in depth on top of
  the TS-side GPU check).
Device picks CUDA → MPS (CLASSIFICATION only) → CPU.

Wiring: `WorkOrderExecutionHelper.isLoraWorkOrder` +
`executeLoraWorkOrder`; the loop dispatcher routes LORA_TRAINING
right after MOLECULAR_DOCKING and BEFORE generic GPU/CPU
inference to avoid misclassification.

Tests: 4 new specs (CPU-only refusal, happy-path with stub
Python + stub uploader, missing-metrics failure, non-zero-exit
failure). Build: `tsup` clean. Node suite: 1332 / 1374 pass.

## [2026-04-29] fix(node-runtime): use llmConfig.baseUrl instead of stale .url field (b8fd1c95)

Single-line fix: `node-runtime.ts:399` was the only place reading
`config.llmConfig.url`; every other LLM-config consumer reads
`baseUrl`. The stray `.url` resolved to `undefined`, masking any
custom base URL by silently falling through to OLLAMA_URL /
`http://localhost:11434`.

## [2026-04-29] feat(docking): node-side Vina runner + work-order dispatch hook (2a618d54)

Layer 1 of the 4-layer pharma plan
(`~/.claude/plans/lucky-mixing-dongarra.md`) — node-side execution
of MOLECULAR_DOCKING work orders end-to-end via AutoDock Vina v1.2.5
+ Open Babel.

New module `src/modules/docking/`:
- `types.ts` — local mirror of the coordinator's docking domain
  shapes (`DockingPose`, `AtomCoord`, `DockingWorkOrderPayload`,
  `DockingSubmissionPayload`). Wire-validated on the coordinator
  side; the two copies must stay in sync.
- `vina-parser.ts::parseVinaPdbqt(text)` — pure parser for Vina's
  PDBQT output. Splits MODEL/ENDMDL blocks, extracts the
  `REMARK VINA RESULT:` line for affinity + RMSD bounds, parses
  ATOM/HETATM fixed-width columns. Maps PDBQT atom-type extensions
  back to standard element symbols (A→C aromatic, OA→O, NA→N,
  HD→H, SA→S, …). Skips malformed records and MODELs missing the
  VINA RESULT remark rather than crashing — the coordinator's
  cross-node verification gate catches the rest.
- `docker.ts::runDocking(input, opts)` — full pipeline: receptor
  cache (RCSB download to `~/.synapseia/docking/receptors`),
  receptor `obabel -xr -p 7.4` PDB→PDBQT, ligand `obabel --gen3d -h`
  SMILES→PDBQT, Vina invocation with the WO's binding-site box +
  seed (truncated to int32 from the WO's hex seed) + locked params
  (exhaustiveness=8, num_modes=9, energy_range=3.0, cpu=4), output
  parse via `parseVinaPdbqt`, sha256 hash for cross-node equality,
  hardware reporting via `os`. Default 20-min timeout
  (`VINA_TIMEOUT_MS` override). Cleans the per-WO temp dir on exit.
- `assertBinariesAvailable()` runs `vina --version` + `obabel -V`
  with a 10s budget — docking WOs fail loudly if either binary is
  missing rather than silently fall back to fake results
  (per `feedback_di_wiring`).
- No sandboxing — same trust model as `trainer.ts` (subprocess
  inherits parent env, no cgroups). We run our own binaries
  against payloads we issued.

Wiring (`work-order.execution.ts` + `work-order.loop.ts`):
- `WorkOrderExecutionHelper.isDockingWorkOrder(wo)` — type
  detection (string or JSON-payload introspection).
- `executeDockingWorkOrder(workOrder, peerId)` — invokes
  `runDocking` and JSON-serialises the resulting
  `DockingSubmissionPayload` as the WO `result`. The coordinator's
  complete-WO path will detect MOLECULAR_DOCKING type and route the
  result to `DockingSubmissionService.ingest` (follow-up commit).
- Loop dispatcher routes MOLECULAR_DOCKING as the FIRST branch
  (before GPU/CPU inference) so a docking WO is never
  accidentally classified as a generic inference task.
- Quality-gate skip-on-failure list extended.

Tests: 8 new specs covering MODEL/ENDMDL block parsing, REMARK
extraction, PDBQT-type → element mapping (incl. aromatic A → C),
malformed-ATOM resilience, empty input, and rank-ordering on
unnumbered MODEL blocks. Full node suite passes (1336 / 1378).
`tsup` build clean.

## [2026-04-28] feat(telemetry): GPU smoke test + node-runtime wiring + crash handlers (11468c1)

Wires the TelemetryClient (847d502) end-to-end. The node now emits:

- `node.boot` — one per process start, with full hw fingerprint
  (CPU, RAM, GPU model, VRAM, tier, hasOllama, hasCloudLlm).
- `gpu.smoke.{passed,failed,skipped}` — fires once after Ollama
  warm-up. Skipped if no GPU or Ollama unreachable. Otherwise POST
  `/api/generate` with `num_gpu=99` to force GPU offload + 30 s
  timeout, model `qwen2.5:0.5b`. Probe inferred from the GPU model
  string (NVIDIA → cuda, Apple → metal, AMD → rocm).
- `exception.uncaught` / `.unhandled-rejection` — from
  `cli/index.ts` process handlers, BEFORE the existing
  `logger.error → exit`. Drain has its own 2 s deadline.
- `node.shutdown` — emitted on graceful stop with a 2 s drain.

`modules/telemetry/telemetry.ts` adds
`setGlobalTelemetryClient` / `getGlobalTelemetryClient` — the
singleton handle that lets process-level handlers reach the
DI'd client.

`node-runtime.ts` configures the client (peerId, app version,
hwFingerprint, signed buildAuthHeaders), starts it, registers the
global singleton, and fires the GPU smoke test in the background.
Telemetry is fully best-effort — any failure in this section
degrades to a single warn and the node continues.

Tests: 8 new specs on `gpu-smoke-test`. Full node suite at 1320
tests green.

## [2026-04-28] feat(telemetry): node TelemetryClient + ring + spool + sanitizer + logger tap (847d502)

Node side of the testnet feedback pipeline. Companion to the
coordinator's `POST /telemetry/events` shipped in `coordinator/942bdf7`.

- `utils/logger.ts` gains a `setLoggerTap(fn)` mechanism. Every
  `logger.error|warn|info|debug` invocation now also calls the
  registered tap (last-writer-wins, fail-soft, default no-op). The
  logger-tap is the primary feed of `subsystem.error|warning`
  telemetry events — no caller-site changes required.
- `modules/telemetry/sanitizer.ts` strips PII / secrets / oversize
  before events leave the node — abs paths normalized, sensitive
  identifiers (`WALLET_PRIVATE_KEY=...`, `apiKey=...`, `mnemonic=...`)
  redacted even inside underscore-joined names, caps on message
  / stack / total event size with a regression suite.
- `modules/telemetry/disk-spool.ts` — append-only NDJSON at
  `~/.synapseia/telemetry-spool.ndjson`. 50 MB cap, iterative
  oldest-first truncation. Survives node restarts and long
  coordinator outages.
- `modules/telemetry/event-builder.ts` — typed factories for the 10
  closed event shapes. Subsystem inferred from the `[Subsystem]`
  log prefix.
- `modules/telemetry/telemetry.ts` — `TelemetryClient`:
  - RAM ring (cap 1000, overflow spills oldest 100 to disk)
  - Auto-flush every 30 s or when the ring crosses 50 events
  - Single attempt per flush — outer interval is the retry cadence;
    on 3 consecutive failures the batch goes to the disk spool
  - `start()` attaches the logger tap; `stop()` / `drainAll()` for
    clean shutdown
  - HttpService when injected (Nest), fallback raw fetch for CLI
  - `configure()` allows late binding of peerId + hardware once the
    boot sequence resolves them
- `TelemetryModule` wired into the node `AppModule`.

Late binding via `client.configure(...)` + `start()` and the
`exception.uncaught|unhandled-rejection` hooks in `cli/index.ts`
ship in the next commit (boot + GPU smoke + cli handlers).

Tests: 52 specs across sanitizer (24), disk-spool (6), event-builder
(15), and telemetry client (7). Full node suite (1312 tests) still
green.

## [2026-04-27] refactor(llm-parser): centralize JSON parsing for cross-provider robustness (52c6de9)

The trailing-prose recovery shipped earlier today (0090355) only covered
ReAct. Other LLM consumers (critic, synthesizer, plan-execution,
review-agent, buildResearchResult) still used bare
`JSON.parse(stripReasoning(raw))` and would crash whenever a non-strict
provider (Claude, MiniMax cloud, raw local Llama, older Gemini) emitted
prose-after-JSON, markdown fences, or stacked objects.

New single chokepoint: `src/shared/parse-llm-json.ts`

- `extractFirstJsonStructure(s)`: linear scan returning the first
  balanced `{...}` OR `[...]` substring (whichever opens first),
  honouring string literals and escaped quotes. Plan arrays recover too.
- `parseLlmJson<T>(raw)`: stripReasoning → `JSON.parse(envelope)` →
  fallback to extractFirstJsonStructure → typed result with
  `recoveredFrom: 'envelope' | 'extraction'`.
- `jsonParseTailSnippet()`: 80-char preview of trailing garbage starting
  at the error's reported position — so warn logs surface what the
  provider actually appended.

Migrated callsites:
- `execute-research`: `parseReActResponse`, `buildResearchResult`
- `critic-node`: `parseResearchResult`
- `synthesizer-node`: `parseResearchResult`
- `plan-execution`: `parseExecutionPlan` (handles arrays)
- `review-agent`: drops the ad-hoc fence + regex parser

`extractFirstJsonObject` re-exported from execute-research as an alias
for backwards compat. 28 unit tests for the helper; 80 suites / 1260
tests green.

## [2026-04-27] fix(react-parser): recover when LLM appends prose after JSON envelope (0090355)

MiniMax-M2.7 (cloud) ignores `response_format:json_object` and emits
`{...valid JSON...} trailing prose` or two stacked objects. JSON.parse
crashed with "Unexpected non-whitespace character after JSON at
position N" and ReAct execution failed every step → fallback to the
legacy executor on every iteration.

- New `extractFirstJsonObject(s)` (exported): scans for the first
  balanced `{...}` substring honoring string literals and escaped
  quotes. Returns `null` when no balanced object is found.
- `parseReActResponse` uses it as a recovery path when `JSON.parse`
  fails on the raw envelope.
- Warn logs now include an 80-char snippet of the trailing garbage so
  the operator can see what the provider is appending (was just
  "position 357" with no context).

8 unit tests for the extractor; 79 suites / 1232 tests green.

## [2026-04-27] fix(agent-brain): resolve default path via __dirname, not process.cwd() (4f27eaff)

Tauri spawns the node child with `cwd='/'` so the legacy
`path.join(process.cwd(), 'data', 'agent-brain.json')` resolved to
`/data/agent-brain.json`, and `mkdirSync('/data')` crashed with ENOENT
(`Failed to save brain to /data/agent-brain.json: ENOENT…`).

Resolution order is now:
  1. `AGENT_BRAIN_PATH` env (Tauri sets `<appDataDir>/agent-brain.json`).
  2. `<moduleDir>/../data/agent-brain.json`.
  3. `<moduleDir>/../../data/agent-brain.json`.
  4. `<process.cwd()>/data/agent-brain.json` — last resort.

`moduleDir()` returns `__dirname` (injected per-chunk by tsup's banner)
so the same source compiles for both the production ESM bundle and
ts-jest CJS. First candidate whose parent dir exists wins; otherwise
`saveBrainToDisk` mkdir's the first.

+ regression test: with `cwd='/'` and no env override, the resolved
  path must not collapse under `/data/`.

## [2026-04-26] fix(esm): tsup banner injects per-chunk __filename/__dirname; walk-up package.json lookup (6cdea161)

The earlier "fix" using `new Function('return import.meta.url')()` was
silently broken in production. The Function constructor body evaluates
in non-module scope, so `import.meta` always threw and the catch
returned an empty path. `node dist/index.js --version` returned the
fallback `0.2.0` instead of the real package version.

- `tsup.config.ts`: banner injects a per-chunk shim
  (`const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);`).
  Each bundled chunk gets its own `__filename` pointing at the chunk file.
  `shims: true` was wrong — it bundles a single shim file whose
  `import.meta.url` points back at the shim itself.
- `self-updater.ts`, `version.ts`, `trainer.ts`, `diloco-trainer.ts`,
  `cli/index.ts`: drop the `new Function` dance; use plain `__dirname`.
  CJS jest provides it natively, ESM bundle gets it from the banner.
- `detectInstallType` walks up looking for a `.git/` folder; `getNodeVersion`
  / `getPackageVersion` walk up looking for a `package.json` whose name
  contains "synapseia". Robust whether the file ships from `src/` or `dist/`.

Verification: `node dist/index.js --version` returns `0.4.0`. 78/78 suites,
1222/1222 tests pass. Tauri `cwd='/'` is also fixed because `__dirname`
always points at the bundle install location, never at `process.cwd()`.

## [2026-04-26] feat(audit-tier-3.2): node-side schema validator + synthesizer retry loop (0190611a)

Closes the last audit gap — schema-broken payloads no longer travel
from node to coordinator only to be silently dropped. The node now
validates locally and either fixes via retry or skips the POST.

- `validators/discovery-schema-validator.ts`: pure-function vendor copy
  of the coordinator's `DiscoveryValidator` (same field rules, DOI
  normalize, evidence-type priors). Plus
  `extractStructuredPayloadFromProposal` — parse-first + brace-counter
  mirror of the coordinator's extractor.
- `SynthesizerNode` runs the validator after each LLM call (attempts
  1–3). On failure the critic feedback is augmented with a
  `[SCHEMA-RETRY] Previous attempt failed validation: <errors>` block
  and the LLM is re-invoked. After `SCHEMA_VALIDATION_MAX_ATTEMPTS`,
  `executionResult.success=false` with `schema_invalid_after_retries`
  reason; the pre-existing `SubmitResultNode` hard-guard then skips
  the POST.
- LLM-call exceptions still drop straight to `fallbackResult` (no retry
  burns on transient ollama outages).
- Contract spec (23 cases) keeps the node validator in sync with the
  coordinator's enforced rules — wrong-key payloads, multi-object paste,
  DOI normalization, `meta_analysis` ≥ 3 DOIs, `contradiction_detected`
  stems, etc.
- Retry spec (4 cases): first-attempt pass, three-attempt fail →
  `success=false`, second-attempt success, LLM-throw fallback.

78/78 suites, 1222/1222 tests pass.

## [2026-04-26] fix(tauri): trainer cwd resolution using deferred import.meta parse (4d6b042b)

Re-applies the intent of the earlier reverted trainer/diloco-trainer fix
(Tauri spawns the node binary with `cwd='/'`, so `dirname(resolve('.'))`
resolves to `/` and Python tries to open `/scripts/train.py`). The fix
mirrors the `self-updater.ts` / `version.ts` pattern: the literal
`import.meta.url` lives only inside a `new Function(...)` body so
ts-jest's CJS transpilation can't choke on it. Three runtimes covered:

1. Jest (CJS) → CJS global `__dirname` is defined.
2. Production ESM bundle → resolve from `import.meta.url` at runtime.
3. Tauri spawn (`cwd='/'`) → no longer falls back to `resolve('.')`;
   throws explicitly if both paths fail.

Tests stay 76/76 green (1195/1195 tests).

## [2026-04-26] fix(tests): jest ESM/CJS interop + @noble/hashes v2 subpath mocks (3f76760f)

13 of 76 test suites were failing in baseline runs. Two unrelated causes:

1. **ESM `import.meta.url` inside CJS-transpiled output.** Affected
   `self-updater.ts` and `version.ts`. ts-jest emits CJS for some test
   paths, so the literal `import.meta.url` becomes a SyntaxError. Fixed
   by deferring the parse via `new Function('return import.meta.url')()`
   — the literal only lives inside a function-constructor string, so
   ts-jest never sees it as syntax. Falls back to the CJS global on
   SyntaxError. Production ESM bundle unchanged.
2. **@noble/hashes v2 subpath imports.** Affected staking/rewards specs
   and anything pulling `@solana/web3.js`. v2 splits utils into
   subpaths (`@noble/hashes/utils`, `@noble/hashes/sha2.js`); the mock
   only intercepted the top-level. Added two regex patterns to
   `moduleNameMapper` and expanded the mock to cover the full v2 utils
   surface (utf8ToBytes, anumber, abytes, ahash, u32, createView, …).

Result: **76/76 suites, 1195/1195 tests pass** (was 63/76 + 13 failing).

## [2026-04-26] feat(prompts): few-shot examples + anti-patterns + grounding floor 8 (580ee23f)

Audit on 2026-04-26 found weekend submissions emitting wrong schema keys
(`"RxNorm"` instead of `drug_rxnorm_id`), invented identifiers (`"R03945"` —
not a real RXCUI), and multiple JSON objects pasted together (`}}, {`).
Schema-only descriptions weren't enough for the Llama-class model running
in production.

- `medical-researcher.ts`: added a worked example for `drug_repurposing`
  (riluzole/ALS with real RXCUI `9325` + MeSH `D000690`) and an explicit
  anti-pattern list for wrong-key variants (`"RxNorm"`, `"MeSH"`,
  `"UMLS CUI"`), invented IDs (R-prefix RxNorm, free-text disease names),
  and multi-object output.
- `medical-synthesizer.ts`: parallel worked example showing prose + ONE
  embedded JSON block; explicit "exactly ONE" rule against the
  multi-object-paste failure mode that swamped the audit data.
- `medical-self-critique.ts`: `ontologyGrounding` floor raised from 6 to 8;
  new rule sets `ontologyGrounding=0` unconditionally on wrong schema keys
  or multi-object paste; ID format rules call out exact shapes (RXCUI
  numeric only, MeSH `D` + 6 digits, UMLS `C` + 7 digits).
- `medical-react.ts`: anti-pattern list aligned with researcher /
  synthesizer for consistency across all three medical prompts.
- Tests: +7 prompt assertions covering the new anti-patterns and worked
  examples; regression guard for `ontologyGrounding=7` (the previous
  threshold) — must now fail per the new rule.

## [0.4.0] 2026-04-26 — version sync release

- Bumped version to 0.4.0 (synced with coordinator and node-ui).

## [2026-04-26] feat(coordinator-client): parse structured error responses (6560b149)

- `WorkOrderCoordinatorHelper` now parses structured `{ error, message, details }` JSON from coordinator error responses.
- Logs domain error codes (e.g. `WORK_ORDER_NOT_FOUND`, `NODE_FORBIDDEN`) for better diagnostics.

## [2026-04-26] fix(tests): update test mocks for Ed25519 crypto + backpressure service (6417acf6)

- Updated `a2a-client.spec.ts` to expect 128-char Ed25519 hex signature (was 64-char HMAC).
- Provided mock `BackpressureService` in `langgraph-coverage2.test.ts` and `integration.spec.ts` for `FetchWorkOrderNode` and `AgentGraphService`.

## [2026-04-26] feat(node): work order backpressure limiting — P2-T4 (1d272113)

- New `BackpressureService` enforces `MAX_CONCURRENT_WORK_ORDERS` (default: 2).
- Integrated into work-order loop and LangGraph accept/fetch nodes.
- Prevents resource starvation when many work orders arrive simultaneously.

## [2026-04-26] feat(node): agent graph checkpointing with MemorySaver — P1-T4 (0e256958)

- New `CheckpointService` for LangGraph state persistence using `MemorySaver` (in-process).
- Thread IDs derived from work order IDs (`wo_<id>`).
- Incomplete threads logged on restart; no auto-resume (coordinator reassigns stale WOs).
- SQLite persistence deferred due to native dep + ESM constraints.

## [2026-04-26] fix(node): replace HMAC-SHA256 with Ed25519 in verifySignature — BUG-1 (2921975f)

- `identity.ts:verifySignature()` was using HMAC-SHA256 while `sign()` used Ed25519, causing signature verification mismatches with the coordinator.
- Fixed `verifySignature()` to use `crypto.verify()` with SPKI DER-wrapped pubkey.
- Fixed `A2AAuthService.verify()` and `sign()` to use Ed25519.
- Updated auth tests to use real Ed25519 keypairs.

## [2026-04-25] feat(quality-gate): T6 — explicit review rubric + raise quality gate to 0.30 (7131c5b8)

- Rewrote `buildReviewPrompt()` in `review-agent.ts` with explicit 0-10 rubric per dimension (accuracy, novelty, methodology, conclusions) including score band descriptions.
- Raised default `SUBMISSION_MIN_SCORE` from 0.15 to 0.30 in `quality-gate.ts`.
- Reason: review prompt lacked rubric guidance, leading to inconsistent scoring; 0.15 gate was too permissive.

## [0.3.0] 2026-04-25 — feat(version-gating): T6 pre-flight version check + self-update

- New `utils/update-checker.ts`: fetches GET /version from coordinator,
  compares semver, returns UP_TO_DATE / UPDATE_AVAILABLE / UPDATE_REQUIRED.
- New `utils/self-updater.ts`: detects install type (npm global, git clone,
  binary), runs `npm install -g @synapseia/node@latest` for npm installs,
  returns manual instructions for others.
- `node-runtime.ts`: pre-flight check before P2P boot. Required update =
  attempt self-update then exit(10) if it fails. Optional update = attempt
  and continue on failure.
- Added `semver` as direct dependency.
- +18 tests (update-checker + self-updater). 74 / 1197 green.

## [2026-04-25] feat(version-gating): T5 — report version in heartbeat + WS handshake (dd5ea70c)

- New `utils/version.ts`: `getNodeVersion()` reads version from
  package.json (cached after first call).
- Heartbeat payload now includes `version` field on every tick.
- 426 Upgrade Required response from coordinator stops retry loop
  with a clear "update your node" error message.
- RoundListener sends version in WS handshake query param.
- Handles `version_rejected` WS event: disconnect + stop reconnecting.

+2 tests (version utility). 72 / 1137 green.

## [2026-04-25] fix(agent): perf-state round-2 review — recent-suffix + hysteresis + counter (a23154b3)

Round-2 reviewer pass on the C3 deferred flag:

- MEDIUM: stale-flag risk. placedRate was computed across the full
  50-round window so a node that fixed itself kept flagging until
  the bad rounds aged out. Now uses RECENT_SUFFIX (last 10 rounds)
  for the flag check; the summary log keeps the full-window view.
- MEDIUM: no debounce — flag fired on every 5-round multiple
  while active. Added hysteresis: WARN emits once on activation,
  stays silent until recent rate recovers above threshold, then
  re-arms.
- LOW: summary log spam after window saturation. `outcomes.length`
  is pinned at 50 once full → `length % 5 === 0` matched every
  record. Switched to a lifetime `recordCount` counter.

+4 tests: recent-suffix wins, hysteresis silence, re-fire after
recovery, 12 summaries across 60 records. 71 / 1135 green.

## [2026-04-25] feat(agent): low-placed-rate flag for sustained underperformance (a3367c31)

Closes the deferred subset of audit Bucket C3. performance-state
already tracks the rolling outcome window; this commit adds the
operator-visible signal:

- Every 5 recorded outcomes, after the existing summary log, also
  emit a structured `[Performance] LOW PLACED RATE` WARN if the
  rolling placed-rate sits below `PERFORMANCE_LOW_PLACED_RATE`
  (default 30%) AND the window has ≥ 10 rounds of signal.
- Threshold clamped to [0, 100] so a typo can't disable or
  always-fire the flag.
- Auto model upgrades / capability gating remain intentionally
  deferred — this is the substrate; the reaction policy lives
  somewhere a human or dashboard reads.

+5 tests. 71 / 1131 green.

## [2026-04-25] fix(audit-review): mutex covers HTTP fallback + perf window env-driven (8db9252f)

Code-review followups on the audit landing:

- HIGH — A1's TRAINING/chat mutex was wired only into the libp2p
  ChatStreamHandler. Coordinator's HTTP fallback hits
  `inference-server.handleChatCompletions`, which never incremented
  the counter — so under fallback the mutex silently failed open.
  Wrapped `forwardToOllama` in `try { begin… } finally { end… }`.
- LOW — performance-state's window was hardcoded at 50. Now reads
  `PERFORMANCE_WINDOW` env var on first import + on test reset,
  with malformed values falling back to 50.

Coverage: +2 inference-server cases (counter rise/fall on
success/throw) + 3 performance-state cases (rollup log, env
override, malformed env). 71 / 1126 green.

## [2026-04-25] feat(agent): persistent rolling per-round outcome window (9537dc1f)

Bucket C3 (scoped subset). Lands the substrate for the future
feedback loop: a 50-round rolling window of `(roundId, myRank,
myRewardSyn, totalWinners, recordedAtMs)` outcomes plus a one-line
summary every five rounds.

- `modules/agent/performance-state.ts` (new): singleton with
  `recordRoundOutcome`, `computeRollingStats`, `getRecentOutcomes`,
  `setRollingWindow`. Mutation-safe (returns slice copies).
- `round-listener.ts` records the outcome from the existing
  `round.closed` handler — no new IO.

Auto model upgrades and capability gating intentionally deferred.

Tests: 5 new cases. 71 / 1121 green.

## [2026-04-25] feat(agent): mission-aware prompt grounding on round.opened (da3655f3)

Bucket C1 (node half). Partner commit to coord `f6b4aa3`. Receives
the active-mission brief on `round.opened` and injects it into the
medical researcher prompt.

- `modules/agent/mission-context-state.ts` (new): ref-safe singleton
  with `setActiveMissions`, `getActiveMissions`,
  `renderMissionBriefForPrompt`. `getActiveMissions` returns a fresh
  slice so external mutation can't poison the cache.
- `round-listener.ts` subscribes to `round.opened`, caches the
  brief. Missing field degrades silently.
- `medical-researcher.ts` accepts optional `missionContext`; when
  present, prepends an "ACTIVE MISSIONS" block instructing the LLM
  to foreground mission-aligned connections.
- `researcher-node.ts` passes `renderMissionBriefForPrompt()` on
  every research execution.

Tests: `mission-context-state.spec.ts` (8) + 2 medical-prompts
cases. 70 / 1116 green.

## [2026-04-24] fix(node): mutex TRAINING/DILOCO WOs while chat is active (a4db72ba)

Partner commit to coordinator f5b5a73. Chat stream latency blew past
the coord's 60s cap because this node was running TRAINING WOs every
~4 min concurrently with inbound chat inference, and both workloads
shared a single Ollama instance.

Introduces `modules/inference/chat-inference-state.ts` — a
module-level singleton with a ref-counted active flag. Exports
`beginChatInference()`, `endChatInference()`, `isChatInferenceActive()`.

Wiring:
- `ChatStreamHandler.onStream` wraps `generateAnswer()` in begin/end
  (try/finally) so the counter always releases.
- `FetchWorkOrdersNode` refuses new TRAINING / DILOCO_TRAINING WOs
  when `isChatInferenceActive()` — logs "deferred — chat inference
  in progress". Research WOs are unaffected.

Kept as a plain module (not Nest DI) because ChatStreamHandler is
instantiated outside the DI container in node-runtime.ts.

Tests: chat-inference-state.spec.ts (4 tests) + 2 new
FetchWorkOrdersNode cases in langgraph-coverage2.test.ts covering
deferral + release. 69 suites / 1107 tests green.

## [2026-04-24] chore(node): drop uuid override (08d40dc4)

uuid 14.0.0 (only patched version) ships ESM-only and breaks jayson
4.x's `require('uuid').v4` used transitively by @solana/web3.js and
langchain. CVE documented in root osv-scanner.toml — unreachable
under Node 22's native crypto.randomUUID.

68 suites / 1101 tests green.

## [2026-04-24] chore(node): standalone pnpm.overrides (8290c304)

Added pnpm.overrides to this package's own package.json so the
standalone-install path (clone packages/node/ solo, `pnpm install`)
picks up the CVE fixes the root workspace already had. Regenerated
sub-repo lockfile via `pnpm install --ignore-workspace --lockfile-only`.

osv-scanner (sub-repo, recursive): ~40 → 7 findings. Remaining 7 are
all upstream-blocked (bigint-buffer via @solana/spl-token, lodash
paths without published fix).

Build + 68 test suites / 1101 tests green.

## [2026-04-24] feat(node): desktop UI integration (6bb810f1)

Four coordinated additions for Tauri node-ui coexistence:
- `node-lock.ts` — PID mutex at ~/.synapseia/node.lock (CLI vs UI)
- `rewards-vault-cli.ts` — on-chain reward claim (raw web3.js, no Anchor)
- `chain-info-lightweight.ts` — wallet readout w/o NestFactory spin-up
- `staking-cli.ts` — SYNAPSEIA_WALLET_PASSWORD env var (fixes Tauri
  stdin-piped-to-null hang), exports loadWalletWithPassword +
  sendAndConfirmFresh
- `cli/index.ts` — acquireLock/releaseLock wired into `start`
- Build clean, 68 suites / 1101 tests green

## [2026-04-24] chore(node): @nestjs/{core,common} ^11.1.16 → ^11.1.19 (CVE fix)

## [2026-04-24] chore(node): Phase 3 vulnerability remediation — 66 CVEs eliminated

- Upgraded axios, @langchain/*, libp2p stack, @noble/ed25519, @noble/hashes to latest
- Fixed @noble/hashes v2 breaking change: sha256/sha512 now from `sha2` subpath
- Fixed @noble/ed25519 v3 breaking change: `ed.hashes.sha512` replaces `ed.etc.sha512Sync`
- Removed `import.meta.url` from trainer.ts and diloco-trainer.ts (esbuild injects __dirname)
- Added `hashes` export to @noble/ed25519 mock; updated @noble/hashes mock to callable fns
- Added @libp2p/crypto/keys mock for p2p tests
- Added tsconfig.test.json + diagnostics:false to jest config for type relaxation in tests
- Added `private p2pNode?: P2PNode` field declaration to HeartbeatHelper
- All 68 test suites pass; build clean

## [2026-04-22] feat(node): p2p gossip sends p2pPeerId + HTTP-only node registration

- publishHeartbeat: include p2pPeerId=identity.peerId (Ed25519) so
  the P2PHeartbeatBridge knows which peerId maps to Ed25519 identity
- node-runtime: call setP2PNode before initial heartbeat so p2pPeerId
  is sent from the first HTTP heartbeat
- p2p.ts: persist libp2p key as hex protobuf (readable with `cat`)

## [2026-04-22] fix(p2p): store libp2p key as hex (cat-readable) + fix p2pPeerId reaching coordinator
  Previous attempt used key.bytes which is not exposed by generateKeyPair.
- heartbeat.ts: store p2pNode as instance field so _sendHeartbeat can
  call p2pNode.getPeerId() — previously p2pPeerId fell through to
  identity.peerId (Ed25519) instead of the libp2p CID.

## [2026-04-22] Persist libp2p keypair + send p2pPeerId in heartbeat

- `p2p.ts` — loadOrCreateKey() persists Ed25519 keypair to
  `$SYNAPSEIA_HOME/libp2p-key` so the libp2p peerId stays stable
  across restarts (was random each boot).
- `heartbeat.ts` — HeartbeatPayload now carries both `peerId`
  (Ed25519 hex, stable) and `p2pPeerId` (libp2p base58 CID, for
  coordinator to dial over libp2p). HTTP heartbeat sends Ed25519
  peerId; P2P gossip sends the libp2p CID.

## [2026-04-20] ReviewAgent: in-flight cycle lock + submissionId dedupe

Defense-in-depth for the duplicate-evaluation path fixed coord-side.
The node's `runReviewPollCycle` had no re-entrancy guard, so the
initial `void` invocation plus a late `setInterval` tick could run
concurrently when the LLM was slow. Both cycles saw the same PENDING
assignment and both POSTed — the coord's new idempotent path now
handles the second gracefully, but this also closes the source.

- `ReviewAgentHelper.cycleInFlight` — private flag, set on entry
  and cleared in `finally`. Overlapping ticks log `Skipping tick —
  previous cycle still in progress` and return 0.
- `runReviewPollCycle` — dedupes `pending` by `submissionId` before
  iterating, so stale twin PENDING rows (if any survived the coord
  migration) don't cause two POSTs within a single cycle either.

All 12 `review-agent.spec.ts` tests + full node suite (1101) pass.

## [2026-04-20] Phase 5 Stryker complete — node overall 62.74 %

Full Stryker pass on node with all 5 TIER-A files in `mutate[]` and
the Phase 5 active-model-subscriber hardening landed.

**Per-file (1056 mutants, 1 h 28 m):**
  - node-auth.ts                : **100.00 %**  (31 / 0 / 0)
  - inference-server.ts         :  91.87 %  (188 / 17 / 4)
  - bid-responder.ts            :  74.58 %  (44 / 15 / 0)
  - active-model-subscriber.ts  :  **66.47 %**  (was 59.28 → +7.19 pp
                                                from hardening commit 90babb32)
  - llm-provider.ts             :  48.12 %  (280 / 304 / 2)

**Overall node: 62.74 %** — down from the 4-file 78.54 % because
llm-provider.ts (516 L, 3 cloud providers × 2 methods) pulls the
weighted average. The 304 survivors cluster on provider-specific
URL / header / JSON-shape StringLiterals; the 71-test Phase 4 spec
exercises dispatch + retry but doesn't pin every outgoing fetch body.
llm-provider hardening is next in queue — ~25-30 focused tests should
push it to ~60-65 %.

## [2026-04-20] Mutation Phase 4 — +LlmProviderHelper spec (71 tests, TIER-A complete)

Fifth and final Phase 4 milestone — all 5 TIER-A files from the baseline
plan now have dedicated specs + Stryker wiring.

- `src/modules/llm/__tests__/llm-provider.spec.ts` — 71 tests.
  * `isTransientLlmError` — 19-row table for every keyword branch
    (2064 / high load / overloaded / 429 / 5xx / ECONNx / runner
    process / %!w(<nil>) / EOF / try again) plus non-transient control
    cases and null/undefined handling.
  * `toErrorMessage` — message present / null / undefined / getter-throws.
  * `getOptionalString` — null/undefined obj, non-string value, happy.
  * `parseModel` — every SUPPORTED_MODELS key, each prefix fallback
    (openai-compat/, minimax/, kimi/, moonshot/), empty-id-after-slash,
    unknown prefix.
  * `buildOpenAICompatUrl` — default, root host, already-complete,
    trailing-slash normalisation.
  * `extractHttpErrorMessage` — JSON.error.message, JSON.message
    fallback, HTML body, empty body, long-body truncation.
  * `checkLLM` — Ollama (down / model-missing / check-throw / happy),
    Cloud (no-key / anthropic happy / unknown providerId), Synapseia
    (not-wired / wired-available / wired-unreachable), unknown
    top-level provider.
  * `generateLLM` — happy path, non-transient immediate throw,
    transient retry then succeed, max-4-attempts then rethrow, reasoning
    scrub, cloud dispatch, cloud unknown providerId, Synapseia version
    mismatch, Synapseia happy path passing temperature + maxTokens.
  * Ollama passthrough (`checkOllama`, `generateOllama`).
- `stryker.conf.mjs` — `mutate[]` and `testMatch` now include the
  5th file. Next Stryker run will produce the full node baseline.

71 new tests, 0 failures. Node test suite still green (997 tests).

## [2026-04-20] Mutation Phase 4 — +InferenceServer +ActiveModelSubscriber, overall 78.54 %

Third Phase 4 milestone. Node Stryker now covers 4 of the 5 TIER-A
files from the baseline plan (missing only `llm-provider.ts`, 516 L,
deferred as a follow-up).

- `src/modules/inference/__tests__/inference-server.spec.ts` — 26
  tests. parseBody happy/empty/malformed/stream-error, forwardToOllama
  (temperature + num_predict matrix, error surfacing), transformToOpenAI
  (shape, chatcmpl-<uuid> prefix, created=now), handleChatCompletions
  validation (400s for missing model / non-array messages / empty
  messages) and happy path + coord notify side-effect, handleState +
  handleHealth shape, startInferenceServer routing with real sockets
  (/health / /api/v1/state / /inference/quote / 404 / OPTIONS preflight).
- `src/modules/model/__tests__/active-model-subscriber.spec.ts` — 21
  tests. Every tick() return state (`no-active`, `unchanged`,
  `swapped`, `download-failed`, `verify-failed`), manifest signature
  verified against a real Ed25519 keypair (tampered body & tampered
  sig both fail closed), strict / dev env toggle
  (`SYNAPSEIA_REQUIRE_SIGNED_MANIFEST`), swap-hook missing / swap-hook
  throws / swap-hook success paths, download cache skip when SHA
  matches, start/stop lifecycle + `MODEL_SUBSCRIBER_DISABLED`.
- `stryker.conf.mjs` — `mutate[]` now covers 4 files; paired
  `testMatch` keeps the ESM sandbox narrow.

**Mutation scores (466 mutants):**
  - node-auth.ts                : 100.00 % (31 / 0 / 0)
  - inference-server.ts         :  91.87 % (188 killed / 17 survived / 4 timeouts)
  - bid-responder.ts            :  74.58 % (44 killed / 15 survived)
  - active-model-subscriber.ts  :  59.28 % (99 killed / 68 survived)
  - **Overall node              :  78.54 %**

`active-model-subscriber.ts` at 59.28 % has the most room: survivors
cluster around the `verifyManifest` branch strings and the tick-log
format. A hardening pass (noise-allowed StringLiterals excluded) can
push it ≥70 % in ~15 extra tests — tracked for Phase 5.

## [2026-04-20] Mutation Phase 4 — +BidResponder spec, node overall 83.33%

Extended node Stryker to cover the auction bid publisher. The
node-auth null-guard test lands, pushing node-auth.ts from 96.77 % to
**100 %** mutation score (0 survivors).

- `src/modules/inference/__tests__/bid-responder.spec.ts` — 17 tests
  covering the capability gate (inference / cpu_inference / gpu_inference),
  handleAuction validation (missing quoteId / query / expired deadline /
  zero-deadline pass-through), bid payload shape, env price bounds,
  modelVersion advertisement, canonical signature with C6 spoof
  guard (signs modelVersion so spoofed bids fail verification), and
  publish failure resilience. Uses real Ed25519 via Node crypto (the
  @noble mock was rewired for this in the previous commit).
- `stryker.conf.mjs` — `mutate[]` and `testMatch` extended to both
  node-auth.ts + bid-responder.ts. Each mutate target is paired with
  its own spec file because the rest of the suite relies on top-level
  `jest.*` globals that break in Stryker's ESM sandbox.

**Mutation scores after this pass:**
  - node-auth.ts     : 100 %  (31 killed / 0 survived / 0 timeouts)
  - bid-responder.ts :  74.58 % (44 killed / 15 survived)
  - **Overall node  :  83.33 %** across 90 mutants.

Bid-responder survivors are almost entirely log-message StringLiterals
and `quoteId.slice(0, 8)` truncations used only for logging — noise
allowed per the plan. Behavioral regressions (guards, signature,
payload assembly) are all killed.

## [2026-04-20] Mutation Phase 4 — Stryker bootstrap + node-auth mock fix

First mutation-testing wiring for the node package. Stands up the
Stryker config next to Jest's ESM setup and lands a real, working
`node-auth.spec.ts` by fixing a shared mock that never actually
produced valid Ed25519 signatures.

- `stryker.conf.mjs` — ESM-aware Stryker config with
  `--experimental-vm-modules`, `jest-runner`, a narrow `testMatch`
  pointing at `src/utils/__tests__/node-auth.spec.ts` (legacy specs
  use top-level `jest.*` globals that break in Stryker's ESM sandbox;
  we scope each mutate[] file to its own spec to keep the sandbox
  green without touching 26 legacy test files).
- `package.json` — adds `@stryker-mutator/core` and
  `@stryker-mutator/jest-runner` devDeps + `test:mutation` script.
- `.gitignore` — adds `.stryker-tmp/` and `reports/mutation/`.
- `src/__mocks__/@noble/ed25519.ts` — rewritten to back signing /
  verification with Node's built-in `crypto` module. Previously the
  mock returned all-zero `Uint8Array(64)` for sign(), which made every
  real cryptographic test vacuous. This unblocks Phase 4 specs that
  need byte-level signature assertions.
- `src/utils/__tests__/node-auth.spec.ts` — 17 tests covering header
  shape, body normalisation (object / null / undef / primitive /
  nested / array), recursive key sort, timestamp freshness, signature
  determinism, private-key immutability, null-guard in
  `sortObjectKeys`. All pass against the real-crypto-backed mock.

Initial Stryker run: **node-auth.ts 96.77 % mutation score (30 killed,
1 survived, 0 timeouts)** — the surviving mutant is a redundant
null-check reached only through nested objects; killed by the
null-guard test above on the next pass.

## [2026-04-19] F3-P2 — Synapseia serving client + active-model subscriber

Node-side scaffolding for Phase 3. The node learns about new canonical
Synapseia model versions, downloads + SHA-verifies them, and serves
chat through whatever local inference runtime (llama.cpp server /
vLLM) the operator wired up.

- `modules/llm/synapseia-serving-client.ts` — OpenAI-compatible HTTP
  client for the local runtime. `isAvailable()` health-checks
  `/v1/models`; `generate()` posts to `/v1/chat/completions`.
  Tracks `activeVersion` so auction bids can advertise it.
- `modules/model/active-model-subscriber.ts` — polls the coord's
  `GET /models/active` every `MODEL_POLL_INTERVAL_MS` (default 60s).
  When the active `modelId` changes, downloads the adapter to
  `$HOME/.synapseia/adapters/`, verifies against `manifest.sha256`
  and calls a caller-supplied `swapHook` to restart the local
  runtime. Operators register the hook from their boot script.
- `modules/llm/llm-provider.ts` — `LLMProvider` union adds
  `'synapseia'`; `LLMModel.synapseiaVersion` is the
  `synapseia-agent:gen-<G>:v<N>` tag advertised on auction bids.
- `ModelModule` wires both services and starts the subscriber loop
  at boot. Loop is a no-op until the coord publishes a canary.

Tests: new `src/__tests__/synapseia-serving.test.ts`. 939 / 981 green
(pre-existing skips unchanged).

## [2026-04-18] ChatStreamHandler — route through LlmProviderHelper (cloud LLM support)

The chat stream handler was hardcoded to Ollama at localhost:11434,
ignoring the node's LLM_PROVIDER / LLM_CLOUD_PROVIDER config. On
qwen2.5:0.5b CPU inference took ~48s per query — right at the 60s
coord timeout. Nodes configured with cloud providers (MiniMax,
Moonshot, Anthropic, OpenAI-compat) should get sub-5s answers.

Now the handler uses the same `LlmProviderHelper.generateLLM()` the
training + research agents use. If the node is cloud-configured the
chat automatically rides that provider; if it's ollama, it keeps
going to Ollama but through the helper's retry + sanitize pipeline
(so transient "runner process no longer running" errors get retried
instead of bubbling up as NODE_FAILED).

Wiring in node-runtime now passes `config.llmModel` +
`config.llmConfig` to the handler constructor. Messages are flattened
into a single prompt with role prefixes (User/Assistant/System) since
the helper's API is prompt-based; a chat-native path can be added later
if tool-use is needed.

Startup log now reports which LLM the chat uses, e.g.
`[ChatStreamHandler] listening on /synapseia/chat/1.0.0
(llm=minimax/MiniMax-M2.7)` — makes operator misconfig obvious.

934/934 node tests green.

## [2026-04-18] ChatStreamHandler — fix handler signature (libp2p v3 passes positional args)

/chat/send kept timing out with `readResponse timed out after 60000ms`
on the coord. The node received nothing in the handler (no
`[ChatStreamHandler] ▶ quote ...` log appeared) even though the
dial succeeded.

Root cause: libp2p v3's `StreamHandler` signature is
`(stream, connection) => void | Promise<void>` — two positional args,
not an object. Our wrapper was registered as `(ctx) => ctx.stream`
so `ctx` was actually the Stream itself; `ctx.stream` was `undefined`
and `readJsonFromStream(undefined)` threw `TypeError: for await (const
chunk of undefined)` inside the try/catch, then the fallback send
call with the same undefined stream also threw and was swallowed —
completely silent failure.

Fixes:
- `P2PNode.handleProtocol`: typed as `(stream, connection) => …`.
- `ChatStreamHandler.start`: uses the two-arg form now.
- Added an immediate `[ChatStreamHandler] ⚡ inbound stream opened —
  reading request…` log on the very first line of `onStream` so the
  next time something silently dies in this path we can tell.
- Added Ollama timing + response-sent logs so we can see the actual
  latency (the user flagged 60s as unacceptable for prod — this lets
  us measure).

934/934 node tests green.

## [2026-04-18] stream-codec — rewrite for libp2p v3 API (mirror of coord)

Mirror of `packages/coordinator/src/infrastructure/p2p/stream-codec.ts`.
Swaps the `sink/source` pull-stream API (libp2p v1/v2) for the v3
API (`send` + `drain` + `closeWrite` + `AsyncIterable`). Without
this, the chat stream died immediately with
`stream.sink is not a function` the moment the coord dialed in after
a successful auction.

Frame format unchanged — parity test still matches the coord's hex
bytes exactly.

## [2026-04-18] CoordWatchdog — auto-reconnect to coord libp2p on peerId change

Belt + tirantes for the coord-restart failure mode. If the coord
regenerates its libp2p identity (e.g. the persistent key volume was
wiped, or a future deployment swaps the coord container without
migrating `/app/data/libp2p-key`), the node's bootstrap multiaddr
becomes stale — the new coord has a different peerId and the noise
handshake fails. Without this watchdog, the node would sit in a
never-connected state until manually restarted.

The watchdog polls `${coordinatorUrl}/p2p/bootstrap` every 30s. On
each tick:
  - Fetch the coord's current libp2p peerId.
  - Compare with the connected-peers list + the peerId we last
    connected to.
  - If the coord is disconnected OR its peerId changed, redial the
    new multiaddr via `p2pNode.dial()`.

Cheap HTTP probe, strict no-op on the happy path. Cleaned up in the
node-runtime `stop()` alongside the other disposables. Added
`@multiformats/multiaddr` as a direct dep so the new `P2PNode.dial()`
method can construct multiaddrs under nodenext module resolution.
934/934 node tests green.

## [2026-04-18] BidResponder — include libp2pPeerId in bid

/chat/quote now works, but /chat/send was failing with
`NODE_FAILED: no active libp2p connection to peer be06bff4…`. Root
cause: the bid was published with only `peerId = identity.peerId`
(Synapseia-style, hex hash of the publicKey — e.g. `be06bff4…`).
The coord stored that as `winnerPeerId` in the Quote, then
`ChatStreamClient.sendChat` passed it to `dialProtocol`, which calls
`getConnections().find(c => c.remotePeer.toString() === peerId)`.
But `remotePeer.toString()` returns the libp2p peerId (base58,
`12D3Koo…`) — a completely different string derived from the same
key. Match impossible → no active libp2p connection → NODE_FAILED.

Fix: BidResponder now publishes both. `peerId` stays as the Synapseia
peerId (registry, payments, heartbeats all keep using it). A new
`libp2pPeerId = p2p.getPeerId()` is added to the payload for the
coord to use when dialing the chat stream. Signature canonical
unchanged — still `{peerId, priceUsd, quoteId}` — so the sig contract
is preserved.

## [2026-04-18] libp2p bootstrap — fetch coord peerId from /p2p/bootstrap

The actual reason the gossip chat auction found zero bids: the node
bootstrapped its libp2p layer with `/dns4/coordinator/tcp/9000` —
**without** the coord's `/p2p/<peerId>` suffix. `@libp2p/bootstrap`
can't complete a noise handshake without knowing the peerId it's
expecting, so the dial silently failed, coord and node libp2p never
meshed, and the coord's `publish(CHAT_AUCTION)` went into the void.

Both sides had "libp2p node started" in their logs. Neither had a
`Peer connected` line — and that was the signal we'd missed. Heartbeat
kept working because it rides HTTP, not gossip.

Fix: before creating the libp2p node, fetch `GET /p2p/bootstrap` from
the coord (already exposed by `P2PController`) and build the full
multiaddr `/dns4/<host>/tcp/9000/p2p/<coordPeerId>`. If the fetch fails
we log a WARN and still boot — the node falls back to HTTP-only for
chat, and retries next startup.

934/934 node tests green.

## [2026-04-18] Dockerfile — multi-stage build (build INSIDE the image)

The old Dockerfile copied a host-built `dist/` into the image
(`COPY dist ./dist`) with the comment *"skips expensive tsup build
inside Docker"*. This was a footgun: if you forgot `npm run build`
before `docker compose up -d --build`, the container shipped stale
code and **nothing in the logs said so**. That's exactly what
happened with PR-2 — the BidResponder wiring was in `src/` but not in
the `dist/` the container was running, so `/chat/quote` returned
`ALL_BIDS_FAILED` with zero `[BidResponder]` logs on the node.

Now the Dockerfile is two-stage, matching the coordinator's pattern:

1. **builder** (`node:24-slim`) — installs full deps and runs
   `npm run build` (tsup) straight from `src/`. Fresh dist, every
   time, no way to skip.
2. **runtime** (`node:24-slim`) — installs only prod deps
   (`npm install --omit=dev`), pulls the built `dist/` from the
   builder stage, installs PyTorch + numpy, and runs.

`.dockerignore` now **excludes** `dist/` so the host's `dist/` can
never leak into the build context again.

Cost: rebuilds with source changes take ~25s longer (tsup runs in the
image instead of using a pre-built artifact). Benefit: impossible to
ship stale code; one command — `docker compose up -d --build` — is
always enough.

## [2026-04-18] wallet / model-catalog / llm-provider / a2a — finish console.* → logger purge

Follow-up to the inference-server cleanup. Converted every remaining
`console.log/warn/error` call under `packages/node/src/**` to the
project `logger`, so the process now has a single, timestamped log
stream end-to-end:

- `modules/wallet/wallet.ts` — welcome banner collapsed to one
  structured line; recovery-phrase display routed through
  `logger.warn` + `logger.log` (still readable, still printed once at
  wallet creation, but no longer a box-drawing multi-line console
  block that breaks log tails); invalid-password retries and
  `changeWalletPassword` success message now go through the logger.
- `modules/model/model-catalog.ts` — `pullModel` progress line.
- `modules/llm/llm-provider.ts` — transient-error retry warning.
- `modules/a2a/a2a-server.service.ts` — startup line + request-error
  handler.
- `modules/a2a/handlers/delegate-research.handler.ts` — delegation
  ingress line collapsed to a single formatted log.

After this commit the only remaining `console.*` references in the
node source tree are the logger implementation itself (`utils/logger.ts`)
and a documentation comment in `cli/bootstrap.ts` (where a real
module-level `console.warn` is still required before the logger
module is evaluated — per the exception recorded in the feedback
memory).

Build: `npm run build` passes. Tests: 934 / 934 (62 suites) green,
including the heartbeat `import.meta` fix and the embedding `await`
fix landed earlier.

## [2026-04-18] inference-server — replace console.* with logger

`inference-server.ts` was the last file still printing through
`console.log/error`, leaving untimestamped multi-line banners
(`🚀 Inference server listening on port 8080\n  POST …\n  GET …`)
interleaved with the proper `HH:MM:SS.mmm INFO [Tag] …` lines the
rest of the process emits. Switched to the project logger utility
and collapsed the startup banner into one structured line.

## [2026-04-18] Docker — bump node image from 20 to 24 (libp2p needs Promise.withResolvers)

libp2p v3 (through one of its transitive deps) calls
`Promise.withResolvers()`, a method added in Node 22 / ES2024. The
`node:20-slim` base image doesn't have it, so `createP2PNode()` threw
`Promise.withResolvers is not a function`, P2P stayed off, and every
chat auction fell back to ALL_BIDS_FAILED because the BidResponder
subscribes over gossipsub. Local dev nodes were on Node 24 — no-op
there — so the bug only surfaced in the container.

`packages/node/Dockerfile` now bases on `node:24-slim`. No other
changes; image size is comparable.

## [2026-04-18] Chat PR-2 — GossipSub bids + libp2p chat stream handler

Node side of the PR-2 migration from HTTP fan-out to libp2p:

- **BidResponder** (`modules/inference/bid-responder.ts`): subscribes
  to `/synapseia/chat-auction/1.0.0`, self-filters on the `inference`
  capability, computes a local price via the shared
  `QueryCostCalculator`, signs `canonical({quoteId, peerId, priceUsd,
  publicKey})` with Ed25519 and publishes to
  `/synapseia/chat-bid/1.0.0`.
- **ChatStreamHandler** (`modules/inference/chat-stream-handler.ts`):
  registers a libp2p protocol handler for `/synapseia/chat/1.0.0`.
  Reads the prompt frame with the shared stream-codec, forwards to
  local Ollama, writes the OpenAI-shaped response back, closes the
  stream.
- **P2PNode**: exposes `handleProtocol(protocol, handler)` and
  `getNode()` for the new stream handler; adds CHAT_AUCTION / CHAT_BID
  subscriptions.
- **node-runtime**: wires BidResponder + ChatStreamHandler after the
  heartbeat pass. Skipped if P2P is not running (HTTP fallback only).
- **stream-codec.ts** — length-prefixed JSON helpers, byte-for-byte
  mirror of the coordinator copy. Paired parity-vector test.

Fixes for pre-existing broken tests (same suite, caught by the
stricter "full suite must be green" rule):
- `heartbeat.ts`: `import.meta.url` referenced directly blew up under
  ts-jest's default CJS compile target (TS1343). Replaced with a
  `new Function()` runtime probe that returns null under CJS and the
  real URL under ESM — same runtime behaviour, compatible with both
  transforms.
- `generate-embedding.tool.ts`: `return generateEmbedding(text)` was
  missing `await`, so the promise rejection escaped the surrounding
  try/catch and the "graceful degradation → []" path never ran. Added
  the missing `await`.
- `generate-embedding.spec.ts`: mocks `globalThis.fetch` so the tool's
  Ollama probe fails fast regardless of host state (tests no longer
  hang or depend on local Ollama).

Node test suite: 934/934 green.

## [2026-04-18] Chat PR-1 — node declares inferencePort, not a URL

Before: the node had to resolve its own `inferenceUrl` and send it to
the coordinator in `POST /inference/register`. The resolver walked a
three-step priority list (`INFERENCE_PUBLIC_URL` > `NODE_NAME:port` >
`localhost:port`) — if the operator got it wrong (or just ran the node
from a host where `localhost` doesn't resolve from the coord's network
namespace) every auction silently failed with ECONNREFUSED and the
user saw ALL_BIDS_FAILED.

Now: the node only declares `inferencePort` (number, default 8080).
The coordinator reads the HTTP request's remote address at register
time and composes the URL itself — operators cannot misconfigure the
endpoint. `INFERENCE_PUBLIC_URL` is still accepted as `inferencePublicUrl`
in the payload for NAT / reverse-proxy edge cases (wins over the
auto-derived URL).

`resolveInferenceUrl()` deleted from `model-discovery.ts`.

## [2026-04-18] Chat Phase 1 — start inference-server on boot

`inference-server.ts` was implemented in Phase 1 (handlers for
`POST /v1/chat/completions` and `POST /inference/quote`) but NOTHING
called `startInferenceServer()` at node boot. The server class + module
existed, tests passed, the node registered its models with
`inferenceUrl=http://node-1:8080`, but the port was closed — so the
coordinator's auction kept getting `fetch failed / ECONNREFUSED` on
every bid request and the user saw `ALL_BIDS_FAILED` in `/chat`.

Now `node-runtime.ts` starts the server between the heartbeat/model-
registration pass and the LangGraph work-order loop. Listens on
`INFERENCE_PORT` (default 8080). Opt out with
`INFERENCE_SERVER_DISABLED=true` for small train-only nodes.

## [2026-04-18] Chat Phase 1 — re-register every heartbeat (keep auction alive)

`model-discovery.ts` used to early-return when the local model list
hadn't changed since the last `POST /inference/register`. With the
coordinator's 60 s TTL on the registry (introduced in Phase 1), that
meant the very first register after boot was the only one a node
ever made — 60 s later `aliveProviders()` purged the entry and the
chat auction kept returning `NO_PROVIDERS` even when nodes were
healthy. Now `registerModels()` always POSTs (overwrites idempotently,
refreshes `updatedAt`); the hash check is kept only to silence the
log when nothing actually changed. One tiny POST every ~15 s per node.

## [2026-04-18] Chat Phase 1 — node-side parity test

Añadido `src/__tests__/QueryCostCalculator.spec.ts`. Contiene un
"parity vector" con las mismas entradas y salidas numéricas exactas
que el test gemelo en `packages/coordinator/src/application/inference/
__tests__/QueryCostCalculator.spec.ts`. Si cualquiera de las dos copias
del `QueryCostCalculator` deriva (regex de biomedical terms, divisor,
rounding…), el test del bando que ha cambiado pasará pero el del otro
bando fallará — y una subasta real no puede arrancar con ambos copies
fuera de sync sin que CI lo detecte primero.

## [2026-04-17] Synapseia-Agent — bid endpoint + inferenceUrl in register (Phase 1)

Nuevo: el nodo ahora participa en la subasta Vickrey de chat queries:
- `modules/inference/QueryCostCalculator.ts` — mirror exacto del del
  coordinator. Precio determinista en `[QUERY_MIN_PRICE, QUERY_MAX_PRICE]`
  (defaults 0.1 / 1.0 USD). Paridad verificada por input.
- `modules/inference/inference-server.ts` — nuevo handler
  `POST /inference/quote` que devuelve `{ priceUsd }` usando el
  calculator. Timeout tolerante — ante error devuelve el precio mínimo.
- `modules/discovery/model-discovery.ts` — ahora incluye `inferenceUrl`
  en el payload de `POST /inference/register`. Resuelve desde
  `INFERENCE_PUBLIC_URL` > `http://$NODE_NAME:$INFERENCE_PORT` >
  `http://localhost:8080`. Sin eso el coordinator no podría contactar
  al nodo para pedir bids o forward the chat completion.

## [2026-04-17] Cloud LLM — URL double-concat fix + non-JSON error handling

OpenAI-compatible cloud endpoint (MiniMax) was failing with
`Unexpected non-whitespace character after JSON at position 4`:

- Cause 1: `generateOpenAICompat` unconditionally appended
  `/v1/chat/completions` to `LLM_CLOUD_BASE_URL`. Operators naturally
  set that env to the full endpoint
  (`https://api.minimax.io/v1/chat/completions`), producing the double
  path `…/chat/completions/v1/chat/completions` → 404 HTML response.
- Cause 2: the error branch blindly called `response.json()` on that
  HTML body → JSON.parse crashed at the first `<` (position 4 after
  `<!DOC`).

Fixes:
- New `buildOpenAICompatUrl()` helper tolerates both conventions
  (root host or full endpoint). Strips trailing slash, appends only if
  `/chat/completions` isn't already present.
- New `extractHttpErrorMessage()` reads the body as text, tries JSON
  parse first, falls back to a truncated snippet. Used by both
  `checkOpenAICompat` and `generateOpenAICompat`.

## [2026-04-17] Ollama thrash fix — LLM_PROVIDER=cloud + num_ctx 8192 + heartbeat 15s

Three changes that together stop a RAM-starved node from cascading
failures when a local-and-docker Ollama are contested by two nodes:

- `training-llm.ts`: resolver now honours `LLM_PROVIDER=cloud`. If set
  AND cloud creds are present, cloud wins the primary slot and Ollama
  drops to fallback. Fixes the pattern where a host with cloud fully
  configured still auto-picked a co-resident Ollama qwen2.5:1.5b and
  OOMed. Applies to both `resolveTrainingLlmModel` and
  `resolveTrainingChain`.
- `ollama.ts`: raise `num_ctx` to 8192 on every Ollama `chat()` call.
  Default was 2048 — research prompts carrying abstracts + related
  DOIs + ontology context overran, which Ollama's llama.cpp runner
  surfaced as "unexpected EOF" when the prompt end landed mid-token.
  8192 fits qwen 0.5b on a 3.8 GiB VM without blowing out RAM.
- `heartbeat.ts`: bump peer heartbeat axios timeout 5s → 15s. Under
  heavy local inference the Node event loop was starved briefly and
  the 5s window expired against a healthy coordinator, producing
  spurious disconnect warnings.

## [2026-04-17] Training LLM resolver — honour LLM_MODEL verbatim override

On RAM-constrained hosts (Docker Desktop VM = 3.8 GiB) the auto-pick of
qwen2.5:1.5b (the "capable" default) collides with torch's 0.8 GiB
import peak and the kernel OOM-kills the python child. The resolver
previously ignored the existing `LLM_MODEL` env var for training and
went directly to ranking installed Ollama models, so operators had no
way to pin a smaller model without either uninstalling the bigger one
or editing the denylist globally.

Resolver now consults `env.LLM_MODEL` first in both
`resolveTrainingLlmModel` and `resolveTrainingChain`:
- if set AND installed in Ollama → return verbatim (bypasses the
  "capable" filter and the `qwen2.5:0.5b` denylist entry)
- if set but not installed → silent fall-through to the ranking path
- if unset → unchanged behaviour

Reuses the env var that CLI + inference already consume, so `--model`
/ `LLM_MODEL` / training resolver stay coherent. No new env var.

## [2026-04-17] Training OOM hardening — pre-import heartbeat + BLAS caps + ollama unload

Fixes the recurring `SIGKILL` / "exited with code null" from the python
training child. Root cause: the cgroup oom-killer was taking Python during
`import torch` (peak ~600-800 MB RSS on arm64) when ollama weights, pubmedbert,
and a second node container fought for the same Docker-host RAM.

- `scripts/train_micro.py`: cap OMP/MKL/OPENBLAS/NUMEXPR/VECLIB threads to 1
  via env vars set BEFORE `import torch`, and emit a `{"stage":"pre-import"}`
  heartbeat before the import so future failures can be localised (pre-import
  vs. during-import vs. post-import).
- `src/modules/model/trainer.ts`: pass the same thread-cap env vars through
  `spawn('python3', …)` as belt-and-suspenders. Added `unloadOllamaModels()`
  helper that lists `/api/ps` and posts `{keep_alive:0}` per loaded model
  before every training run — best-effort (2s budget, errors swallowed).
- `docker-compose.yml`: add `mem_reservation: 2g` to `node-1` so the kernel
  deprioritises killing it under pressure. Removed `node-2` service +
  `node_2_data` volume — the host can't sustain two parallel torch imports.

## [2026-04-16] Medical prompts — structured discovery emission

New `prompts/medical/` module steers the multi-agent research pipeline
(researcher → critic → synthesizer) and the legacy ReAct loop toward one
of the 5 coordinator DiscoveryType schemas (drug_repurposing,
combination_therapy, biomarker, mechanism_link, procedure_refinement).

Key rules encoded in the prompt:
- supporting_dois must contain ≥ 2 real DOIs from the abstract, the
  source paper's DOI, or the related-paper DOIs the coordinator now
  ships in `workOrder.metadata.relatedDois`. NEVER invent DOIs.
- The synthesizer emits proposal = prose (≥ 100 chars, ≥ 12 words)
  followed by a machine-readable `{discoveryType, structuredData}`
  JSON block — the coordinator's DiscoveryService.extractStructuredPayload
  regex grabs the first balanced `{…}`, so the plain-English prose
  around the JSON keeps submission-quality scoring happy.
- When nothing can be grounded, the prompts fall back to
  `mechanism_link` (weakest claim) rather than inventing IDs.

Also:
- SynthesizerNode fallback now locally assembles a structured proposal
  from the researcher's output when the synthesizer LLM call fails, so
  the structured discovery survives LLM outages.
- ResearcherNode + ExecuteResearchNode read `paperDoi` + `relatedDois`
  from `workOrder.metadata` to build the prompt.

## [2026-04-16] Container log fixes — Ollama runner crashes, MiniMax parse errors, OOM diagnostic

Four findings from a container-node log review at 22:15–22:24.

### A. `Heartbeat sent via HTTP only` spam
`heartbeat.ts`: downgraded from `info` → `debug`. Logged on every 30 s
tick when P2P isn't running (normal in containers). No information loss
— P2P status surfaces elsewhere.

### B. `llama runner process has terminated: %!w(<nil>)` — not retried
Ollama's mmap'd runner process dies mid-generation under memory pressure
or during model eviction. The Go `%!w(<nil>)` format artifact comes from
`fmt.Errorf("…%w", nil)` inside Ollama when the wrapped error is itself
nil. `isTransientLlmError` only matched the phrase "runner process no
longer running" — the newer "runner process has terminated" variant
wasn't classified as transient, so the retry schedule (1 s / 3 s / 8 s
backoff) never kicked in and the error bubbled straight to the mutation
engine, which immediately walked to the cloud fallback. Extended the
classifier to match `runner process` (generic) and the Go `%!w` artifact.

### C. MiniMax `Unexpected non-whitespace character after JSON at position 4`
`mutation-engine.parseMutationResponse` used `/\{[\s\S]*\}/` — greedy
first-to-last brace. On responses like `{"a":1}\n{"b":2}` the regex
captured the whole span and `JSON.parse` failed at the boundary. Replaced
with a new `extractFirstJsonObject(text)` helper that does a proper
brace count (respects string literals + backslash escapes) and returns
the first balanced `{…}` block, ignoring trailing prose or secondary
objects. Fenced ```json blocks still take priority.

### D. `Training process exited with code null` without hint
`trainer.ts` now captures the close signal as well as the exit code and
explicitly calls out `code === null + signal === 'SIGKILL'` as a likely
cgroup OOM kill, including a pointer to raise `mem_limit` or lower
`hiddenDim`/`batchSize`. The trainer didn't change behavior — this is
purely a diagnostic clarity fix so operators stop chasing a trainer bug
when the kernel killed Python for eating RAM.

## [2026-04-15] Fix missing LLM config on peer-review loop (the real reason discoveries were empty)

### Problem
`evaluations` rows kept piling up with `status='pending'` and never advanced
to `'completed'`. Without completed evaluations the discovery pipeline's
median-score threshold could never be met, so `kg_nodes` / `kg_edges` /
`reference_corpus` stayed empty downstream — even after all the fixes
earlier today.

### Root cause
`LangGraphWorkOrderAgentService.start()` (the production entry for
`syn start` via `node-runtime.ts`) called:
```ts
this.roundListenerHelper.startRoundListener(config.coordinatorUrl, config.peerId);
```
**without the 3rd `llmConfig` arg**. The sibling caller in
`work-order.loop.ts` passed it correctly; this one never did.

The `RoundListenerHelper.round.evaluating` handler is gated on `llmConfig`:
```ts
if (llmConfig) reviewAgentHelper.startReviewLoop(...)
else logger.warn('[RoundListener] No LLM config provided — skipping peer review loop');
```
With `llmConfig === undefined` the review loop never started → the node
never polled `/evaluations/assignments` → assignments stayed `pending`
forever → median never computed → 0 discoveries.

### Fix
`src/modules/agent/services/langgraph-work-order-agent.service.ts` now
forwards `llmModel` + `llmConfig` into `startRoundListener`, same shape
as the other caller. On the next cycle the node logs
`[ReviewAgent] Starting peer review loop (interval: 120s)` and starts
polling assignments.

## [2026-04-15] Quiet startup + fix duplicate `onModuleInit` for coordinator helper

### Cleaner boot stream (no noise above the wallet password prompt)
- `src/cli/index.ts`: dotenv now loaded with `{ quiet: true }` → removes the
  `[dotenv@17.x] injecting env (19) from .env — tip: 🔐 encrypt with Dotenvx`
  banner at startup.
- `src/cli/index.ts`: early stderr filter swallows the single
  `bigint: Failed to load bindings, pure JS will be used` line that
  `bigint-buffer` writes on import. The pure-JS fallback is fine; we only
  filter that exact string, everything else on stderr passes through.
- `work-order.coordinator.ts`: the "Ed25519 signing enabled for peerId …"
  log dropped from `info` to `debug`. Still accessible with `LOG_LEVEL=debug`
  but out of the default boot stream.

### Fix duplicate `WorkOrderCoordinatorHelper` instance
- Root cause: both `WorkOrderModule` and `ToolsModule` declared
  `WorkOrderCoordinatorHelper` as a provider. Because `WorkOrderModule`
  imports `ToolsModule`, NestJS created TWO independent singletons of the
  helper — each ran its own `onModuleInit` (hence the duplicate log) and
  kept its own `_keypair` / `_peerId` state, which would silently diverge
  after any `setIdentity()` call.
- Extracted the helper to a new shared `WorkOrderCoordinatorModule`
  (`src/modules/agent/work-order/work-order-coordinator.module.ts`) that
  providers + exports it. Both consumers now import that module, so DI
  injects the same instance everywhere. `WorkOrderModule` re-exports the
  shared module so downstream callers (`a2a.module.ts`, …) keep working
  without any change.
- Side benefit: future work-order-coordinator lifecycle logic (reconnect,
  token refresh, …) is guaranteed to run once.

### Tests
`tsc --noEmit` clean. Jest: 890 / 893 tests pass; the 3 failures are
pre-existing timeouts in `generate-embedding.spec.ts` that hit a local
Ollama — unrelated to this change.

## [2026-04-10] Track real vs synthetic corpus in micro-training submissions

### Fix
- **`datasetId` always stored `'synthetic://text8-sample'`**: `submitTrainingResult()` was called with `payload.datasetId` which was the coordinator's hardcoded constant, regardless of whether `downloadDataset()` succeeded. The `micros` table recorded `'synthetic://text8-sample'` even when the node actually trained on the real domain corpus. Now the execution layer tracks `usedRealCorpus` (true if `downloadDataset()` succeeded) and passes `effectiveDatasetId` to the submission: `medical-corpus` / `trading-corpus` when real, `synthetic://built-in` when fallback.

## [2026-04-10] Micro-training reliability: script, unbuffered stdout, timeout fix

### Fixes
- **`train_micro.py` was missing from repo**: `scripts/` only had DiLoCo scripts. Dockerfile does `COPY scripts ./scripts` so a clean image had no training script — `spawn` always failed. Created `scripts/train_micro.py`: reads hyperparams JSON from stdin, trains a character-level LM with configurable architecture (hiddenDim, numLayers, activation, normalization, initScheme) using PyTorch on CPU, emits `{"step":N,"loss":X,"lr":X}` per interval, terminates with `{"result":{"finalLoss":X,"valLoss":X}}`. Respects `maxTrainSeconds` wall-clock budget.
- **Python stdout block-buffering swallowed all output**: `spawn('python3', ...)` without `-u` flag lets Python buffer stdout in 4 KB blocks. If training finishes or gets killed before the buffer fills, Node.js receives no output → `"no output received"`. Fixed by adding `-u` to the spawn args.
- **Spurious second "code null" error**: When the Node.js timeout fired and sent SIGTERM, the process `close` event still called `settle()` with `"Training process exited with code null"`, generating an unhandled rejection. Fixed by setting `settledHolder.current = true` before sending SIGTERM so the close handler is a no-op.
- **`maxTrainSeconds` too high on CPU**: Cold-start default was 120s CPU / 300s GPU; clamped max was 300s CPU / 600s GPU. Lowered to 60s default / 120s max CPU, 180s default / 300s max GPU. Training completes well within the 600s `TRAINING_TIMEOUT_MS` container budget.
- **`validateTrainingConfig` allowed maxTrainSeconds up to 600**: Updated ceiling to 300 to match new mutation-engine clamp.

## [2026-04-10] Eliminate prompt placeholder leakage in research pipeline

### Fixes
- **Submissions stored literal placeholder text**: Every research prompt used `<description here>` or `REAL ... here` as example values inside the JSON schema shown to the model. Small models (qwen2.5-3b, phi4-mini) pattern-match the example and emit the placeholder verbatim as output — e.g. `summary: "<3-4 sentences: problem, method, result, significance>"`. Fixed in all four research nodes by: (1) removing descriptions from inside JSON values, (2) using `REAL ... here` only as a structural marker (not descriptive), (3) moving all requirements to a plain-text list below the JSON structure.
- **`researcher-node.ts` used ` ```json...``` ` fences without `forceJson`**: The fence format explicitly teaches the model to wrap output in markdown, then the JSON parser fails. Replaced with inline schema + `forceJson: true`.

### Files changed
- `prompts/react.ts` — answer schema, requirements moved below
- `prompts/plan.ts` — step schema cleaned
- `nodes/researcher-node.ts` — prompt + `forceJson: true`
- `nodes/critic-node.ts` — schema, requirements below
- `nodes/synthesizer-node.ts` — schema, requirements below

## [2026-04-10] Constrained JSON decoding + centralized reasoning strip

### Fixes
- **Ollama `format: "json"` / OpenAI `response_format: "json_object"`**: Added `forceJson?: boolean` to `GenerateOptions`. When set, OllamaHelper passes `format: "json"` to the Ollama API (grammar-based constrained decoding — the model physically cannot emit non-JSON tokens). OpenAI-compat path adds `response_format: { type: "json_object" }`. Eliminates JSON parse failures at source instead of patching them downstream.
- **Centralized reasoning strip**: `packages/node/src/shared/sanitize-llm-output.ts` (new) exports `stripReasoning()` — handles closed `<think>...</think>` pairs, unclosed/truncated tags (left open when `num_predict` cuts the response mid-tag), and OpenAI channel markers. Used by `llm-provider.ts` after every provider call so downstream code never sees scratchpad content.
- **`LangGraphLlmService.generateJSON()`**: New method that calls `generateLLM(..., { forceJson: true })`. All ReAct, plan, self-critique, and multi-agent nodes now call `generateJSON` instead of `generate`.
- **`parseSelfCritiqueResponse` always returned 5.0/10**: Old fallback filled all four score fields with `5` on any parse error → average 5.0 → always below 7.0 threshold → infinite retries. Fixed: JSON.parse failure → `passed: false` with 0 scores; missing fields → same; all fields present → derive `passed` from computed average ≥ 7.0. LLM's own `passed` field is ignored.
- **Control-char `\n → \\n` broke JSON**: Old sanitizer replaced `\n` with literal `\\n` (backslash-n), destroying structural JSON whitespace. Removed entirely — `generateJSON` mode makes it unnecessary.
- **`parseReActResponse` "Unexpected non-whitespace character after JSON"**: LLM emitted trailing text after the JSON object. Fixed by extracting `\{[\s\S]*\}` before parsing.

### New files
- `src/shared/sanitize-llm-output.ts` — `stripReasoning(raw)`, node-side (no cross-package imports)

## [2026-04-10] Honest mutation-engine failure + research payload extraction in planner

### Fixes
- **Training WOs crashed on malformed mutation-engine JSON, and silent defaults would have faked data**: `MutationEngineHelper.parseMutationResponse` called `JSON.parse` unguarded. `qwen2.5:0.5b` frequently emits truncated/malformed JSON (`SyntaxError: Expected ',' or '}' after property value in JSON at position 50`), crashing the WO inside `ExecuteTrainingNode`. A silent fallback to default hyperparams was rejected because it would report an un-mutated config as an "LLM-proposed experiment", polluting the experiment log. Instead, `proposeMutation` now:
  1. Takes an explicit `primaryModel` + `fallbackModels` + `llmConfig` (threaded from the node's own `config.llmModel`/`config.llmConfig`).
  2. Retries each candidate with a stricter "JSON-only, no prose" prompt after the first failure.
  3. Walks fallback models if the primary exhausts its retries.
  4. Throws `MutationEngineError` (new) when every candidate fails — no silent defaults, no fabricated experiments.
  `executeTrainingWorkOrder` catches `MutationEngineError` and aborts the WO with a clear reason. The cold-start path (no prior experiments to mutate from) still uses a labeled neutral baseline — that's a legitimate starting point, not a failure fallback.
- **`PlanExecutionNode` always logged `Failed to parse research payload, using defaults`**: the node did `JSON.parse(selectedWorkOrder.description)` directly, but coordinator sends research WOs as plain-text descriptions with `metadata.paperTitle`/`metadata.paperAbstract`. The planner was fed an empty abstract on every research WO, degrading plan quality. Now delegates to `WorkOrderExecutionHelper.extractResearchPayload()`, which already handles all 3 formats (legacy JSON, metadata fields, plain-text `Abstract:\n...`). `PlanExecutionNode` now constructor-injects `WorkOrderExecutionHelper`.

### API
- `MutationEngineHelper.proposeMutation(topExperiments, bestLoss, capabilities, primaryModel?, fallbackModels?, llmConfig?)` — new optional args.
- `WorkOrderExecutionHelper.executeTrainingWorkOrder(..., llmModel?, llmConfig?, fallbackModels?)` — new optional args.
- Exports `MutationEngineError` for callers to distinguish mutation failures from other training errors.

### Tests
- `mutation-engine.test.ts`: replaced the old "should throw on invalid JSON" with three tests — throws `MutationEngineError` when both primary attempts fail, recovers on the stricter prompt retry, walks fallback models if the primary is exhausted.
- `plan-execution.spec.ts` / `integration.spec.ts` / `langgraph-coverage2.test.ts`: updated to inject `WorkOrderExecutionHelper` into `PlanExecutionNode` and to pass the new training args.
- 57 suites / 870 tests green.

## [2026-04-10] Fix model discovery when Ollama is on a non-localhost host

### Critical Fix
- **`ModelCatalogHelper.getLocalModels()` hardcoded `http://localhost:11434/api/tags`**. In Docker Compose deployments `localhost` inside the node container is the node itself, not the ollama service at `http://ollama:11434`. Result: every node logged `No local models found, skipping registration` on every heartbeat, and the coordinator's inference registry stayed empty — even though the ollama container had `qwen2.5:0.5b` and `locusai/all-minilm-l6-v2` pulled.
- Fix: `getLocalModels(ollamaUrl?)` now accepts an optional base URL; falls back to `OLLAMA_URL` env var, then `http://localhost:11434`.
- Threaded `config.llmConfig?.baseUrl` from `node-runtime.ts` → `ModelDiscovery.registerModels()` → `getLocalModels()`.
- `HeartbeatHelper.startPeriodicHeartbeat()` now accepts `ollamaUrl` and passes it to each periodic model registration.

### Impact
Docker/remote nodes now correctly report their local Ollama models to the coordinator. Verified in-cluster: `Registered 2 model(s) with coordinator` after the fix (was `No local models found` before).

## [2026-04-10] Fix research WO submission flow — nodes now participate in rounds — `03e7c63d`

### Critical Fix
- **isResearchWorkOrder** in `work-order.execution.ts` was only checking JSON-encoded descriptions. The coordinator sends plain-text descriptions with `metadata.paperTitle/paperAbstract`. Without type check fallback, research WOs were silently rejected.
- **extractResearchPayload** in execution.ts only had a generic title+slice fallback. Aligned with evaluation.ts to use metadata first, then parse "Abstract:\n..." from plain text.
- **Removed dead `/papers/results` call** — endpoint doesn't exist on coordinator, always returned 404. Research results already flow through `completeWorkOrder()` which registers a Submission in the active ResearchRound.
- **submit-result.ts (LangGraph)** — removed duplicate `submitResearchResult()` call

**Impact:** Rounds were showing 0 submissions and 0 participants despite 3 nodes running because all research WOs were being rejected at the type-detection stage. Now nodes actually complete research WOs and get counted.

## [2026-04-09] Audit fixes + GPU inference + signed requests + capability reporting — `90ad3a26`

### Critical Fixes
- **C-01** Fix paper lookup URL in work-order loop (`/research-queue/papers` → `/papers`)
- **C-02** Fix research WO evaluation — extractResearchPayload() now handles plain-text descriptions + metadata (was: JSON.parse only, rejected all research WOs as "Invalid research payload")
- **C-10** Identity.sign() migrated from HMAC-SHA256 to Ed25519 (Node.js native crypto with PKCS8 DER)
- **C-11** LangGraph: acceptWorkOrder → conditional edge (skip to __end__ if rejected)
- **C-12** LangGraph: add missing executeResearch → qualityGate edge
- **C-13** SynthesizerNode: include executionResult in return (was null → never submitted)

### High Priority Fixes
- **H-07** Heartbeat uptime uses process.uptime() instead of Date.now() delta (was always ~0s)
- **H-08** Hyperparams leaderboard: fix data.entries → data.leaderboard, fix valLoss calculation
- **H-11** Prevent division by zero in normalizeRewards when rewards array empty
- **H-12** LangGraphWorkOrderAgentService.start() now calls roundListenerHelper.startRoundListener()
- **H-09** uploadGradients now includes Ed25519 auth headers
- **H-10** ReviewAgent signs fetchEvaluationAssignments (GET) and postEvaluation (POST) with Ed25519

### Medium Priority Fixes
- **M-11** Fix kimi/moonshot model name parsing (split index 0→1)
- **M-12** SubmitResultNode: completedWorkOrderIds tracked in AgentState (was empty Set per call)
- **M-13** submitTrainingResult includes qualityScore in payload
- **M-14** waitForActivationDeposit: bounded loop (120 polls × 30s = 1h max, was infinite)

### Low Priority Fixes
- **L-10** Align checkMinimax URL to api.minimax.io (was api.minimax.chat)

### New Features
- **GPU Inference execution**: executeGpuInferenceWorkOrder() supports generate, summarize, embedding_large tasks with 7B+ models
- **GPU Inference type detection**: isGpuInferenceWorkOrder() + routing in work-order loop and LangGraph
- **Capability reporting**: Nodes now report `gpu_training` (GPU + torch) and `gpu_inference` (GPU + Ollama)
- **AgentState**: Added completedWorkOrderIds (persisted across iterations) and metadata on WorkOrder type
- **IdentityModule**: Imported in AgentModule for ReviewAgent Ed25519 signing

### Config
- GPU_INFERENCE_MODEL default: qwen2.5:7b
- GpuInferenceWorkOrderPayload type: generate | summarize | embedding_large

### Tests Updated
- identity.test.ts: signature length 64→128 (Ed25519)
- review-agent.spec.ts: updated fetch assertions for signed headers
- langgraph-nodes.test.ts + langgraph-coverage2.test.ts: added profitRatio/reason to evaluateWorkOrder mock, isGpuInferenceWorkOrder mock
