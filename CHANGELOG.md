# Changelog — @synapseia/node

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
