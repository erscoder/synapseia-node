# Changelog — @synapseia/node

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
