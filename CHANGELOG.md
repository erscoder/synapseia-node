# Changelog — @synapseia/node

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
