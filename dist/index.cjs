#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/hardware.ts
var hardware_exports = {};
__export(hardware_exports, {
  buildOsString: () => buildOsString,
  detectAppleSilicon: () => detectAppleSilicon,
  detectHardware: () => detectHardware,
  detectNvidiaGPU: () => detectNvidiaGPU,
  estimateAppleSiliconVram: () => estimateAppleSiliconVram,
  getCompatibleModels: () => getCompatibleModels,
  getRecommendedTier: () => getRecommendedTier,
  getSystemInfo: () => getSystemInfo,
  getTierName: () => getTierName,
  parseNvidiaSmiOutput: () => parseNvidiaSmiOutput
});
function detectAppleSilicon(hardware, model) {
  if (model.includes("M3 Ultra")) hardware.tier = 5;
  else if (model.includes("M3 Max") || model.includes("M3 Pro")) hardware.tier = 4;
  else if (model.includes("M2 Ultra")) hardware.tier = 3;
  else if (model.includes("M2 Max")) hardware.tier = 3;
  else if (model.includes("M2 Pro") || model.includes("M1 Ultra")) hardware.tier = 2;
  else if (model.includes("M1 Max")) hardware.tier = 2;
  else if (model.includes("M3") || model.includes("M2") || model.includes("M1")) hardware.tier = 1;
  if (model.includes("Ultra")) hardware.gpuVramGb = hardware.tier === 5 ? 192 : 128;
  else if (model.includes("Max")) hardware.gpuVramGb = 96;
  else if (model.includes("Pro")) hardware.gpuVramGb = hardware.tier >= 3 ? 48 : 18;
  else hardware.gpuVramGb = hardware.tier === 1 ? 10 : 7;
}
function detectNvidiaGPU(hardware, smiOutput) {
  if (!smiOutput) {
    smiOutput = (0, import_child_process.execSync)("nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits", { encoding: "utf-8" });
  }
  if (smiOutput.includes("GiB")) {
    const match = smiOutput.match(/(\d+)\s*GiB/);
    if (match) hardware.gpuVramGb = parseInt(match[1]);
  } else if (smiOutput.includes("MiB")) {
    const match = smiOutput.match(/(\d+)\s*MiB/);
    if (match) hardware.gpuVramGb = Math.round(parseInt(match[1]) / 1024);
  }
  if (hardware.gpuVramGb >= 80) hardware.tier = 5;
  else if (hardware.gpuVramGb >= 64) hardware.tier = 5;
  else if (hardware.tier < 5 && hardware.gpuVramGb >= 24) hardware.tier = 4;
  else if (hardware.tier < 4 && hardware.gpuVramGb >= 14) hardware.tier = 3;
  else if (hardware.tier < 3 && hardware.gpuVramGb >= 10) hardware.tier = 2;
  else if (hardware.tier < 2 && hardware.gpuVramGb >= 6) hardware.tier = 1;
}
function detectHardware(cpuOnly = false, archOverride) {
  const hardware = {
    cpuCores: os2.cpus().length || 2,
    ramGb: Math.round(os2.totalmem() / 1024 ** 3),
    gpuVramGb: 0,
    tier: 0,
    hasOllama: false
  };
  if (!cpuOnly) {
    try {
      const arch3 = archOverride || os2.arch();
      if (arch3 === "arm64") {
        const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string").toString().trim();
        detectAppleSilicon(hardware, model);
      } else if (arch3 === "x86") {
        detectNvidiaGPU(hardware);
      }
    } catch {
    }
    try {
      (0, import_child_process.execSync)("curl -s http://localhost:11434/api/tags", { stdio: "pipe", timeout: 1e3 });
      hardware.hasOllama = true;
    } catch {
      hardware.hasOllama = false;
    }
  }
  return hardware;
}
function getTierName(tier) {
  const names = ["CPU-Only", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5"];
  return names[tier] || "Unknown";
}
function buildOsString(platform3, release2, arch3, osType) {
  if (platform3 === "darwin") return `macOS ${release2} (${arch3})`;
  if (platform3 === "linux") return `Linux ${release2} (${arch3})`;
  if (platform3 === "win32") return `Windows ${release2} (${arch3})`;
  return `${osType} ${release2} (${arch3})`;
}
function estimateAppleSiliconVram(model) {
  if (model.includes("M3 Ultra")) return 192;
  if (model.includes("M3 Max")) return 128;
  if (model.includes("M2 Ultra")) return 128;
  if (model.includes("M2 Max")) return 96;
  if (model.includes("M3 Pro")) return 48;
  if (model.includes("M2 Pro")) return 18;
  if (model.includes("M1 Ultra")) return 128;
  if (model.includes("M1 Max")) return 96;
  if (model.includes("M3") || model.includes("M2")) return 10;
  if (model.includes("M1")) return 7;
  return 0;
}
function parseNvidiaSmiOutput(smiOutput) {
  const lines = smiOutput.trim().split("\n");
  const parts = lines[0]?.split(",")?.map((s) => s.trim()) || [];
  const name = parts[0] || "NVIDIA GPU";
  const vramStr = parts[1] || "";
  const match = vramStr.match(/(\d+)\s*(GiB|MiB)/);
  if (!match) return { name, vramGb: 0 };
  const value = parseInt(match[1]);
  const unit = match[2];
  const vramGb = unit === "GiB" ? value : Math.round(value / 1024);
  return { name, vramGb };
}
function getSystemInfo(archOverride) {
  const osPlatform = os2.platform();
  const osRelease = os2.release();
  const arch3 = archOverride || os2.arch();
  const osString = buildOsString(osPlatform, osRelease, arch3, os2.type());
  const cpuModel = os2.cpus()[0]?.model || "Unknown CPU";
  const cpuCores = os2.cpus().length || 0;
  const memoryTotal = os2.totalmem();
  let gpuType = null;
  let gpuVram = 0;
  try {
    if (arch3 === "arm64" && osPlatform === "darwin") {
      const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string", { encoding: "utf-8" }).trim();
      gpuType = model;
      gpuVram = estimateAppleSiliconVram(model);
    } else if (arch3 === "x86_64" || arch3 === "x64") {
      try {
        const smiOutput = (0, import_child_process.execSync)("nvidia-smi --query-gpu=name,memory.free --format=csv,noheader", { encoding: "utf-8" });
        const parsed = parseNvidiaSmiOutput(smiOutput);
        gpuType = parsed.name;
        gpuVram = parsed.vramGb;
      } catch {
      }
    }
  } catch (error) {
  }
  return {
    os: osString,
    cpu: {
      model: cpuModel,
      cores: cpuCores
    },
    memory: {
      totalGb: Math.round(memoryTotal / 1024 ** 3)
    },
    gpu: {
      type: gpuType,
      vramGb: gpuVram
    }
  };
}
function getCompatibleModels(vramGb, allModels = []) {
  if (!allModels || allModels.length === 0) {
    const defaultModels = [
      { name: "qwen2.5-0.5b", minVram: 1, recommendedTier: 1 },
      { name: "gemma-3-1b-web", minVram: 2, recommendedTier: 1 },
      { name: "phi-2", minVram: 2, recommendedTier: 1 },
      { name: "gemma-3-4b", minVram: 4, recommendedTier: 2 },
      { name: "qwen2.5-coder-7b", minVram: 6, recommendedTier: 2 },
      { name: "llama-3.1-8b-instruct", minVram: 10, recommendedTier: 3 },
      { name: "gemma-3-12b", minVram: 10, recommendedTier: 3 },
      { name: "gpt-oss-20b", minVram: 16, recommendedTier: 4 },
      { name: "qwen2.5-coder-32b", minVram: 24, recommendedTier: 4 },
      { name: "glm-4.7-flash", minVram: 24, recommendedTier: 5 },
      { name: "qwen3-coder-30b-a3b", minVram: 24, recommendedTier: 5 }
    ];
    return defaultModels.filter((model) => model.minVram <= vramGb);
  }
  return allModels.filter((model) => model.minVram <= vramGb);
}
function getRecommendedTier(vramGb) {
  if (vramGb >= 80) return 5;
  if (vramGb >= 48) return 5;
  if (vramGb >= 24) return 4;
  if (vramGb >= 16) return 4;
  if (vramGb >= 14) return 3;
  if (vramGb >= 10) return 3;
  if (vramGb >= 6) return 2;
  if (vramGb >= 1) return 1;
  return 0;
}
var os2, import_child_process;
var init_hardware = __esm({
  "src/hardware.ts"() {
    "use strict";
    os2 = __toESM(require("os"), 1);
    import_child_process = require("child_process");
  }
});

// src/index.ts
var import_commander = require("commander");
var fs = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);
var os3 = __toESM(require("os"), 1);

// src/identity.ts
var import_fs = require("fs");
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var crypto = __toESM(require("crypto"), 1);
var IDENTITY_DIR = path.join(os.homedir(), ".synapse");
var IDENTITY_FILE = path.join(IDENTITY_DIR, "identity.json");
function generateIdentity(identityDir = IDENTITY_DIR) {
  if (!(0, import_fs.existsSync)(identityDir)) {
    (0, import_fs.mkdirSync)(identityDir, { recursive: true, mode: 448 });
  }
  const privateKey = crypto.randomBytes(32);
  const privateKeyHex = privateKey.toString("hex");
  const hash = crypto.createHash("sha256").update(privateKey).digest();
  const publicKeyHex = hash.toString("hex");
  const peerIdHash = crypto.createHash("sha256").update(publicKeyHex, "hex").digest("hex");
  const peerId = peerIdHash.slice(0, 32);
  const agentId = publicKeyHex.slice(0, 8);
  const identity = {
    peerId,
    publicKey: publicKeyHex,
    privateKey: privateKeyHex,
    createdAt: Date.now(),
    agentId,
    // A16
    tier: 0,
    // A16 - default tier
    mode: "chill",
    // A16 - default mode
    status: "idle"
    // A16 - default status
  };
  (0, import_fs.writeFileSync)(path.join(identityDir, "identity.json"), JSON.stringify(identity, null, 2));
  (0, import_fs.writeFileSync)(path.join(identityDir, "publickey.pem"), `public key: ${publicKeyHex}
`);
  return identity;
}
function loadIdentity(identityDir = IDENTITY_DIR) {
  const idPath = path.join(identityDir, "identity.json");
  if (!(0, import_fs.existsSync)(idPath)) {
    throw new Error(`Identity not found at ${idPath}. Run generateIdentity() or 'synapse start' first.`);
  }
  const content = (0, import_fs.readFileSync)(idPath, "utf-8");
  const identity = JSON.parse(content);
  if (!identity.peerId || !identity.publicKey || !identity.privateKey) {
    throw new Error("Invalid identity file structure");
  }
  if (!identity.agentId) {
    identity.agentId = identity.publicKey.slice(0, 8);
  }
  if (identity.tier === void 0) {
    identity.tier = 0;
  }
  if (!identity.mode) {
    identity.mode = "chill";
  }
  if (!identity.status) {
    identity.status = "idle";
  }
  return identity;
}
function getAgentProfile(identity) {
  return {
    agentId: identity.agentId || identity.publicKey.slice(0, 8),
    peerId: identity.peerId,
    tier: identity.tier || 0,
    mode: identity.mode || "chill",
    status: identity.status || "idle",
    createdAt: identity.createdAt,
    publicKey: identity.publicKey
  };
}

// src/index.ts
init_hardware();

// src/heartbeat.ts
var import_axios = __toESM(require("axios"), 1);
async function sendHeartbeat(coordinatorUrl, identity, hardware) {
  const startTime = Date.now();
  const capabilities = determineCapabilities(hardware);
  const payload = {
    peerId: identity.peerId,
    walletAddress: null,
    // TODO: connect wallet
    tier: hardware.tier,
    capabilities,
    uptime: startTime
    // Process start time (simplified)
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const client = import_axios.default.create({
        baseURL: coordinatorUrl,
        timeout: 5e3,
        headers: {
          "Content-Type": "application/json"
        }
      });
      const response = await client.post("/peer/heartbeat", payload);
      return response.data;
    } catch (error) {
      lastError = error;
      console.warn(`Heartbeat attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < 2) {
        const delayMs = 1e3 * Math.pow(2, attempt);
        await new Promise((resolve2) => setTimeout(resolve2, delayMs));
      }
    }
  }
  throw new Error(`Failed to send heartbeat after 3 attempts: ${lastError?.message}`);
}
function determineCapabilities(hardware) {
  const capabilities = [];
  capabilities.push("cpu");
  if (hardware.hasOllama) {
    capabilities.push("inference");
  }
  if (hardware.hasOllama && hardware.ramGb >= 8) {
    capabilities.push("embedding");
  }
  return capabilities;
}
function startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs = 3e4) {
  const intervalId = setInterval(async () => {
    try {
      await sendHeartbeat(coordinatorUrl, identity, hardware);
      console.log("Heartbeat sent successfully");
    } catch (error) {
      console.error("Heartbeat failed:", error.message);
    }
  }, intervalMs);
  return () => clearInterval(intervalId);
}

// src/ollama.ts
var import_axios2 = __toESM(require("axios"), 1);
var import_ollama = require("ollama");
async function checkOllama(url = "http://localhost:11434") {
  try {
    const response = await import_axios2.default.get(`${url}/api/tags`, {
      timeout: 5e3
    });
    const models = response.data.models.map((m) => m.name);
    const { detectHardware: detectHardware2 } = await Promise.resolve().then(() => (init_hardware(), hardware_exports));
    const hwInfo = await detectHardware2();
    const hasGPU = hwInfo.gpuVramGb > 0;
    const recommendedModel = hasGPU ? "qwen2.5:3b" : "qwen2.5:0.5b";
    return {
      available: true,
      url,
      models,
      recommendedModel
    };
  } catch (error) {
    const isAxiosError = error && typeof error === "object" && "isAxiosError" in error;
    if (isAxiosError) {
      return {
        available: false,
        url,
        models: [],
        recommendedModel: "qwen2.5:0.5b",
        error: `Cannot connect to Ollama at ${url}: ${error.message}`
      };
    }
    let errorMessage = "Unknown error";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return {
      available: false,
      url,
      models: [],
      recommendedModel: "qwen2.5:0.5b",
      error: errorMessage
    };
  }
}
async function generate(prompt, model, url = "http://localhost:11434") {
  try {
    let targetModel = model;
    if (!targetModel) {
      const status = await checkOllama(url);
      if (!status.available) {
        throw new Error("Ollama is not available");
      }
      targetModel = status.recommendedModel;
    }
    console.log(`\u{1F9E0} Generating with model: ${targetModel}`);
    const ollamaClient = new import_ollama.Ollama({ host: url });
    const response = await ollamaClient.chat({
      model: targetModel,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      stream: false
    });
    return response.message.content.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Generation failed: ${errorMessage}`);
  }
}

// src/llm-provider.ts
function getOptionalString(obj, key) {
  if (obj == null) return void 0;
  const value = obj[key];
  return typeof value === "string" ? value : void 0;
}
async function generateLLM(model, prompt, config) {
  if (model.provider === "ollama") {
    return generateOllamaLLM(model, prompt);
  }
  if (model.provider === "cloud") {
    return generateCloudLLM(model, prompt, config);
  }
  throw new Error("Unknown provider");
}
async function generateOllamaLLM(model, prompt) {
  return generate(prompt, model.modelId);
}
async function generateCloudLLM(model, prompt, config) {
  if (!config?.apiKey) {
    throw new Error("API key required for cloud provider");
  }
  if (model.providerId === "anthropic") {
    return generateAnthropic(model, prompt, config.apiKey);
  }
  if (model.providerId === "moonshot") {
    return generateMoonshot(model, prompt, config.apiKey);
  }
  if (model.providerId === "minimax") {
    return generateMinimax(model, prompt, config.apiKey, config.baseUrl);
  }
  throw new Error("Unknown cloud provider");
}
async function generateAnthropic(model, prompt, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model.modelId,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  if (!response.ok) {
    const error = await response.json();
    const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
    throw new Error(errorMessage);
  }
  const data = await response.json();
  return data.content[0].text;
}
async function generateMoonshot(model, prompt, apiKey) {
  const response = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  if (!response.ok) {
    const error = await response.json();
    const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
    throw new Error(errorMessage);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}
async function generateMinimax(model, prompt, apiKey, baseUrl) {
  const url = baseUrl ?? "https://api.minimax.chat/v1/text/chatcompletion_v2";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  if (!response.ok) {
    const error = await response.json();
    const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
    throw new Error(errorMessage);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// src/mutation-engine.ts
async function proposeMutation(topExperiments, bestLoss, capabilities) {
  if (topExperiments.length === 0) {
    return {
      model: { provider: "ollama", providerId: "", modelId: "qwen2.5:0.5b" },
      type: "explore",
      baseExperimentId: null,
      hyperparams: {
        learningRate: 1e-3,
        batchSize: 32,
        hiddenDim: 128,
        numLayers: 4,
        numHeads: 4,
        activation: "gelu",
        normalization: "layernorm",
        initScheme: "xavier",
        warmupSteps: 100,
        weightDecay: 0.01,
        maxTrainSeconds: capabilities.includes("gpu") ? 300 : 120
      },
      reasoning: "Starting with default configuration for initial exploration"
    };
  }
  const prompt = buildPrompt(topExperiments, bestLoss, capabilities);
  const model = { provider: "ollama", providerId: "", modelId: "qwen2.5:0.5b" };
  const response = await generateLLM(model, prompt);
  return parseMutationResponse(response, topExperiments, bestLoss, capabilities);
}
function buildPrompt(topExperiments, bestLoss, capabilities) {
  const expsJson = JSON.stringify(topExperiments.slice(0, 5), null, 2);
  const hasGpu = capabilities.includes("gpu");
  return `You are a machine learning researcher. Given these experiment results:

${expsJson}

The best loss so far is ${bestLoss.toFixed(4)}.

Available hardware: ${capabilities.join(" and ")}.

Propose a new hyperparameter configuration that could improve the loss.
Reason about WHY your changes should work based on the patterns you see.

Output JSON with this structure:
{
  "type": "explore" or "improve",
  "baseExperimentId": null or "experiment_id_string",
  "hyperparams": {
    "learningRate": 0.001,
    "batchSize": 32,
    "hiddenDim": 128,
    "numLayers": 4,
    "numHeads": 4,
    "activation": "gelu" or "silu" or "relu",
    "normalization": "layernorm" or "rmsnorm",
    "initScheme": "xavier" or "kaiming" or "normal",
    "warmupSteps": 100,
    "weightDecay": 0.01,
    "maxTrainSeconds": ${hasGpu ? 300 : 120}
  },
  "reasoning": "Explanation of why this mutation should work"
}

Constraints:
- learningRate: 0.0001 to 0.01
- batchSize: 16, 32, 64, 128
- hiddenDim: 64, 128, 192, 256
- numLayers: 2 to 8
- numHeads: 2, 4, 8
- activation: 'gelu', 'silu', 'relu'
- normalization: 'layernorm', 'rmsnorm'
- initScheme: 'xavier', 'kaiming', 'normal'`;
}
function parseMutationResponse(response, topExperiments, bestLoss, capabilities) {
  const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse JSON from LLM response");
  }
  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const parsed = JSON.parse(jsonStr);
  const hyperparams = {
    learningRate: clampValue(parsed.hyperparams?.learningRate ?? 1e-3, 1e-4, 0.01),
    batchSize: clampValueToBatch(parsed.hyperparams?.batchSize ?? 32),
    hiddenDim: clampToDimension(parsed.hyperparams?.hiddenDim ?? 128),
    numLayers: clampValue(parsed.hyperparams?.numLayers ?? 4, 2, 8),
    numHeads: clampToHeads(parsed.hyperparams?.numHeads ?? 4),
    activation: validateActivation(parsed.hyperparams?.activation),
    normalization: validateNormalization(parsed.hyperparams?.normalization),
    initScheme: validateInitScheme(parsed.hyperparams?.initScheme),
    warmupSteps: clampValue(parsed.hyperparams?.warmupSteps ?? 100, 0, 1e3),
    weightDecay: clampValue(parsed.hyperparams?.weightDecay ?? 0.01, 0, 0.1),
    maxTrainSeconds: capabilities.includes("gpu") ? clampValue(parsed.hyperparams?.maxTrainSeconds ?? 300, 120, 600) : clampValue(parsed.hyperparams?.maxTrainSeconds ?? 120, 60, 300)
  };
  const model = { provider: "ollama", providerId: "", modelId: "qwen2.5:0.5b" };
  return {
    model,
    type: parsed.type === "explore" || parsed.type === "improve" ? parsed.type : "explore",
    baseExperimentId: parsed.baseExperimentId || null,
    hyperparams,
    reasoning: parsed.reasoning || "Proposed mutation"
  };
}
function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function clampValueToBatch(value) {
  const validBatchSizes = [16, 32, 64, 128];
  const closest = validBatchSizes.reduce(
    (prev, curr) => Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}
function clampToDimension(value) {
  const validDims = [64, 128, 192, 256];
  const closest = validDims.reduce(
    (prev, curr) => Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}
function clampToHeads(value) {
  const validHeads = [2, 4, 8];
  const closest = validHeads.reduce(
    (prev, curr) => Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
  return closest;
}
function validateActivation(value) {
  const valid = ["gelu", "silu", "relu"];
  return valid.includes(value) ? value : "gelu";
}
function validateNormalization(value) {
  const valid = ["layernorm", "rmsnorm"];
  return valid.includes(value) ? value : "layernorm";
}
function validateInitScheme(value) {
  const valid = ["xavier", "kaiming", "normal"];
  return valid.includes(value) ? value : "xavier";
}

// src/trainer.ts
var import_child_process2 = require("child_process");
var import_path = require("path");
async function trainMicroModel(options) {
  const {
    proposal,
    datasetPath,
    hardware,
    pythonScriptPath = (0, import_path.resolve)(process.cwd(), "scripts/train_micro.py"),
    runNumber = 1
  } = options;
  const startTime = Date.now();
  const lossCurve = [];
  const hyperparamsPayload = {
    ...proposal.hyperparams,
    dataPath: datasetPath,
    hardware
  };
  return new Promise((resolve2, reject) => {
    const pythonProcess = (0, import_child_process2.spawn)("python3", [pythonScriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let finalResult = null;
    pythonProcess.stdin.write(JSON.stringify(hyperparamsPayload));
    pythonProcess.stdin.end();
    pythonProcess.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((line) => line.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.step !== void 0 && parsed.loss !== void 0) {
            lossCurve.push(parsed.loss);
          }
          if (parsed.result) {
            finalResult = {
              finalLoss: parsed.result.finalLoss,
              valLoss: parsed.result.valLoss
            };
          }
        } catch {
        }
      }
      stdout += data.toString();
    });
    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    pythonProcess.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      if (code !== 0) {
        reject(new Error(`Training failed with exit code ${code}: ${stderr || "Unknown error"}`));
        return;
      }
      if (!finalResult) {
        reject(new Error("Training completed but no result received from Python script"));
        return;
      }
      const improvementPercent = 0;
      const result = {
        runNumber,
        finalLoss: finalResult.finalLoss ?? 0,
        valLoss: finalResult.valLoss ?? 0,
        improvementPercent,
        durationMs,
        config: proposal.hyperparams,
        lossCurve,
        hardwareUsed: hardware
      };
      resolve2(result);
    });
    pythonProcess.on("error", (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });
  });
}
function validateTrainingConfig(proposal) {
  const { hyperparams } = proposal;
  if (hyperparams.learningRate < 1e-4 || hyperparams.learningRate > 0.01) {
    return { valid: false, error: "learningRate must be between 0.0001 and 0.01" };
  }
  const validBatchSizes = [16, 32, 64, 128];
  if (!validBatchSizes.includes(hyperparams.batchSize)) {
    return { valid: false, error: `batchSize must be one of: ${validBatchSizes.join(", ")}` };
  }
  const validHiddenDims = [64, 128, 192, 256];
  if (!validHiddenDims.includes(hyperparams.hiddenDim)) {
    return { valid: false, error: `hiddenDim must be one of: ${validHiddenDims.join(", ")}` };
  }
  if (hyperparams.numLayers < 2 || hyperparams.numLayers > 8) {
    return { valid: false, error: "numLayers must be between 2 and 8" };
  }
  const validNumHeads = [2, 4, 8];
  if (!validNumHeads.includes(hyperparams.numHeads)) {
    return { valid: false, error: `numHeads must be one of: ${validNumHeads.join(", ")}` };
  }
  const validActivations = ["gelu", "silu", "relu"];
  if (!validActivations.includes(hyperparams.activation)) {
    return { valid: false, error: `activation must be one of: ${validActivations.join(", ")}` };
  }
  const validNormalizations = ["layernorm", "rmsnorm"];
  if (!validNormalizations.includes(hyperparams.normalization)) {
    return { valid: false, error: `normalization must be one of: ${validNormalizations.join(", ")}` };
  }
  const validInitSchemes = ["xavier", "kaiming", "normal"];
  if (!validInitSchemes.includes(hyperparams.initScheme)) {
    return { valid: false, error: `initScheme must be one of: ${validInitSchemes.join(", ")}` };
  }
  if (hyperparams.maxTrainSeconds < 10 || hyperparams.maxTrainSeconds > 600) {
    return { valid: false, error: "maxTrainSeconds must be between 10 and 600" };
  }
  return { valid: true };
}

// src/agent-loop.ts
var loopState = {
  iteration: 0,
  bestLoss: Infinity,
  totalExperiments: 0,
  isRunning: false
};
async function fetchTopExperiments(coordinatorUrl, limit = 5) {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments?limit=${limit}&status=completed`);
    if (!response.ok) {
      throw new Error(`Failed to fetch experiments: ${response.statusText}`);
    }
    const data = await response.json();
    return (data.experiments || []).filter((exp) => exp.valLoss !== null && exp.valLoss !== void 0).sort((a, b) => (a.valLoss ?? Infinity) - (b.valLoss ?? Infinity)).slice(0, limit);
  } catch (error) {
    console.warn("Failed to fetch experiments:", error.message);
    return [];
  }
}
async function createExperiment(coordinatorUrl, proposal, peerId, tier) {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "micro-transformer-120k",
        hyperparams: proposal.hyperparams,
        tier
      })
    });
    if (!response.ok) {
      throw new Error(`Failed to create experiment: ${response.statusText}`);
    }
    const data = await response.json();
    return data.experiment.id;
  } catch (error) {
    throw new Error(`Failed to create experiment: ${error.message}`);
  }
}
async function updateExperiment(coordinatorUrl, experimentId, result) {
  try {
    const response = await fetch(`${coordinatorUrl}/experiments/${experimentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        progress: 100,
        valLoss: result.valLoss
      })
    });
    if (!response.ok) {
      throw new Error(`Failed to update experiment: ${response.statusText}`);
    }
  } catch (error) {
    console.error("Failed to update experiment:", error.message);
    throw error;
  }
}
async function postToFeed(coordinatorUrl, peerId, mutation, result, improved) {
  try {
    console.log(`[FEED] ${improved ? "\u{1F389} IMPROVEMENT" : "\u{1F4DD} Result"}: ${mutation.type} - ${mutation.reasoning} (loss: ${result.valLoss.toFixed(4)})`);
  } catch (error) {
    console.warn("Failed to post to feed:", error.message);
  }
}
async function runAgentIteration(config, iteration) {
  const { coordinatorUrl, peerId, capabilities, datasetPath } = config;
  console.log(`
\u{1F504} Iteration ${iteration} starting...`);
  console.log("\u{1F4E5} Fetching top experiments...");
  const topExperiments = await fetchTopExperiments(coordinatorUrl);
  console.log(`   Found ${topExperiments.length} experiments`);
  if (topExperiments.length > 0 && topExperiments[0].valLoss) {
    loopState.bestLoss = Math.min(loopState.bestLoss, topExperiments[0].valLoss);
  }
  console.log(`   Best loss so far: ${loopState.bestLoss.toFixed(4)}`);
  console.log("\u{1F9E0} Proposing mutation via LLM...");
  const mutation = await proposeMutation(topExperiments, loopState.bestLoss, capabilities);
  console.log(`   Type: ${mutation.type}`);
  console.log(`   Reasoning: ${mutation.reasoning.slice(0, 100)}...`);
  const validation = validateTrainingConfig(mutation);
  if (!validation.valid) {
    throw new Error(`Invalid training config: ${validation.error}`);
  }
  console.log("\u{1F4DD} Creating experiment...");
  const tier = capabilities.includes("gpu") ? 2 : 0;
  const experimentId = await createExperiment(coordinatorUrl, mutation, peerId, tier);
  console.log(`   Experiment ID: ${experimentId}`);
  console.log("\u{1F680} Training micro-model...");
  const hardware = capabilities.includes("gpu") ? "gpu" : "cpu";
  const trainingResult = await trainMicroModel({
    proposal: mutation,
    datasetPath,
    hardware,
    runNumber: iteration
  });
  console.log(`   Training complete: ${trainingResult.valLoss.toFixed(4)} loss`);
  console.log(`   Duration: ${trainingResult.durationMs}ms`);
  console.log(`   Steps: ${trainingResult.lossCurve.length * 10}`);
  console.log("\u{1F4BE} Updating experiment...");
  await updateExperiment(coordinatorUrl, experimentId, trainingResult);
  const improved = trainingResult.valLoss < loopState.bestLoss;
  if (improved) {
    loopState.bestLoss = trainingResult.valLoss;
    console.log(`\u{1F389} New best loss: ${loopState.bestLoss.toFixed(4)}!`);
  }
  await postToFeed(coordinatorUrl, peerId, mutation, trainingResult, improved);
  loopState.iteration = iteration;
  loopState.totalExperiments++;
  return {
    iteration,
    mutation,
    trainingResult,
    experimentId,
    improved
  };
}
async function startAgentLoop(config) {
  if (loopState.isRunning) {
    throw new Error("Agent loop is already running");
  }
  loopState.isRunning = true;
  const { intervalMs, maxIterations } = config;
  console.log("\u{1F680} Starting SynapseIA Agent Loop");
  console.log(`   Coordinator: ${config.coordinatorUrl}`);
  console.log(`   Peer ID: ${config.peerId}`);
  console.log(`   Capabilities: ${config.capabilities.join(", ")}`);
  console.log(`   Interval: ${intervalMs}ms`);
  if (maxIterations) {
    console.log(`   Max iterations: ${maxIterations}`);
  }
  console.log("");
  try {
    let iteration = 1;
    while (loopState.isRunning) {
      if (maxIterations && iteration > maxIterations) {
        console.log(`
\u2705 Reached max iterations (${maxIterations}), stopping.`);
        break;
      }
      try {
        await runAgentIteration(config, iteration);
      } catch (error) {
        console.error(`\u274C Iteration ${iteration} failed:`, error.message);
      }
      if (loopState.isRunning) {
        console.log(`\u23F3 Sleeping for ${intervalMs}ms...`);
        await sleep(intervalMs);
      }
      iteration++;
    }
  } finally {
    loopState.isRunning = false;
    console.log("\n\u{1F6D1} Agent loop stopped");
  }
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}

// src/index.ts
var program = new import_commander.Command();
program.name("synapse").description("Synapse Node CLI \u2014 Join the decentralized compute network").version("0.0.1");
program.command("start").description("Start Synapse node and begin autonomous research").option("--model <string>", "LLM model to use (e.g., ollama/qwen2.5:0.5b, anthropic/sonnet-4.6, kimi/k2.5)").option("--dataset <string>", "Path to training dataset").option("--coordinator <string>", "Coordinator URL").option("--interval <number>", "Research loop interval (ms)").option("--max-iterations <number>", "Max research iterations").option("--interval-ms <number>", "Heartbeat interval (ms)").option("--inference", "Enable inference capability (requires GPU)").option("--cpu", "Only use CPU (no GPU)").action(async (options) => {
  console.log("\u{1F9E0} Synapse Node CLI v0.0.1");
  console.log("");
  const datasetPath = options.dataset || path2.join(process.cwd(), "data", "astro-sample.txt");
  const coordinatorUrl = options.coordinator || "http://localhost:3001";
  const interval = options.interval || 12e4;
  const maxIterations = options.maxIterations || 0;
  const intervalMs = options.intervalMs || 36e5;
  let model;
  if (options.model) {
    const parts = options.model.split("/");
    const provider = parts[0];
    const modelId = parts[1] || "qwen2.5:0.5b";
    let llmProvider;
    let providerId = "";
    if (provider === "anthropic") {
      llmProvider = "cloud";
      providerId = "anthropic";
    } else if (provider === "kimi") {
      llmProvider = "cloud";
      providerId = "moonshot";
    } else {
      llmProvider = "ollama";
    }
    if (llmProvider === "cloud") {
      const apiKey = process.env.SYN_LLMAPI_KEY;
      if (!apiKey) {
        console.error(`\u274C Error: SYN_LLMAPI_KEY required for ${provider} models`);
        console.log(`   export SYN_LLMAPI_KEY=your-key-here`);
        process.exit(1);
      }
    }
    console.log(`\u{1F916} Using model: ${options.model}`);
    model = { provider: llmProvider, providerId, modelId };
  } else {
    console.log("\u{1F916} No model specified. Using default: ollama/qwen2.5:0.5b");
    model = { provider: "ollama", providerId: "", modelId: "qwen2.5:0.5b" };
  }
  console.log("");
  const identityPath = path2.join(os3.homedir(), ".synapse");
  if (!fs.existsSync(path2.join(identityPath, "identity.json"))) {
    console.log("\u{1F511} No identity found. Generating Keypair...");
    generateIdentity(identityPath);
    console.log(`\u2705 Saved to: ${path2.join(identityPath, "identity.json")}`);
  } else {
    console.log(`\u2705 Identity loaded from: ${identityPath}`);
  }
  const identity = loadIdentity(identityPath);
  console.log(`   Peer ID: ${identity.peerId.slice(0, 16)}...`);
  console.log("");
  console.log("\u{1F50D} Detecting hardware...");
  const hardware = detectHardware(options.cpu);
  console.log(`   CPU: ${hardware.cpuCores} cores`);
  console.log(`   RAM: ${hardware.ramGb} GB`);
  console.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + "GB VRAM" : "None"}`);
  console.log(`   Tier: ${hardware.tier} (${getTierName(hardware.tier)})`);
  const capabilities = [];
  if (!options.cpu) capabilities.push("gpu");
  if (hardware.hasOllama) capabilities.push("ollama");
  console.log(`   Capabilities: ${capabilities.join(", ") || "cpu"}`);
  console.log("");
  if (!fs.existsSync(datasetPath)) {
    console.warn(`\u26A0\uFE0F  Dataset not found: ${datasetPath}`);
    console.log(`   Using embedded sample data...`);
  } else {
    const stats = fs.statSync(datasetPath);
    console.log(`\u{1F4CA} Dataset: ${datasetPath} (${(stats.size / 1024).toFixed(1)}KB)`);
  }
  console.log("");
  console.log("\u{1F493} Starting heartbeat loop...");
  const heartbeatCleanup = startPeriodicHeartbeat(
    coordinatorUrl,
    identity,
    hardware,
    intervalMs
  );
  console.log(`   Coordinator: ${coordinatorUrl}`);
  console.log(`   Interval: ${(intervalMs / 1e3).toFixed(0)}s`);
  console.log("");
  console.log("\u{1F504} Starting agent research loop...");
  const config = {
    coordinatorUrl,
    peerId: identity.peerId,
    capabilities,
    intervalMs: interval,
    datasetPath,
    maxIterations
  };
  console.log(`   Experiment interval: ${(interval / 1e3).toFixed(0)}s`);
  if (maxIterations > 0) {
    console.log(`   Max iterations: ${maxIterations}`);
  }
  console.log("   Model:", options.model || "ollama/qwen2.5:0.5b");
  console.log("");
  console.log("\u{1F680} Synapse Node running. Press Ctrl+C to stop.\n");
  startAgentLoop(config);
  process.on("SIGINT", async () => {
    console.log("\n\n\u{1F6D1} Shutting down...");
    heartbeatCleanup();
    console.log("\u2705 Goodbye!");
    process.exit(0);
  });
});
program.command("status").description("Show node status").action(() => {
  console.log("\u{1F4CA} Synapse Node Status\n");
  const identityPath = path2.join(os3.homedir(), ".synapse");
  if (fs.existsSync(path2.join(identityPath, "identity.json"))) {
    const identity = loadIdentity(identityPath);
    console.log(`   Peer ID: ${identity.peerId}`);
    console.log(`   Public Key: ${identity.publicKey.slice(0, 64)}...`);
  } else {
    console.log("   Status: Node not configured (run `synapse start` first)");
    return;
  }
  const hardware = detectHardware(false);
  console.log(`   Hardware: ${hardware.tier} (${hardware.cpuCores} cores, ${hardware.ramGb}GB RAM)`);
  console.log(`   GPU: ${hardware.gpuVramGb > 0 ? hardware.gpuVramGb + "GB" : "None"}`);
  console.log(`   Ollama: ${hardware.hasOllama ? "\u2705 Installed" : "\u274C Not found"}`);
  const capabilities = [];
  if (!hardware.gpuVramGb) capabilities.push("cpu");
  if (hardware.hasOllama) capabilities.push("ollama");
  console.log(`   Capabilities: ${capabilities.join(", ")}`);
  console.log(`   Uptime: ${process.uptime().toFixed(0)}s`);
  console.log(`   Platform: ${os3.platform()} ${os3.arch()}`);
});
program.command("models").description("Manage local models (Ollama)").action(async () => {
  console.log("\u{1F4E6} Synapse Models\n");
  const hardware = detectHardware(false);
  if (!hardware.hasOllama) {
    console.log("\u274C Ollama not found at localhost:11434");
    console.log("   Install: https://ollama.com/download");
    return;
  }
  console.log("   Checking available models...\n");
  console.log("   <model list from Ollama API>");
  console.log("");
  console.log(`Recommended for Tier ${hardware.tier}:`);
  if (hardware.tier >= 5) {
    console.log("   \u2022 Llama-3.3-70B (requires >48GB VRAM)");
    console.log("   \u2022 Mixtral 8x7B (requires >32GB VRAM)");
  } else if (hardware.tier >= 4) {
    console.log("   \u2022 Llama-3.3-70B (requires 48GB VRAM)");
    console.log("   \u2022 Mixtral 8x7B (requires 24GB VRAM)");
  } else if (hardware.tier >= 3) {
    console.log("   \u2022 Gemma-3-1B (4GB VRAM)");
    console.log("   \u2022 Phi-3-mini (2.5GB VRAM)");
  } else if (hardware.tier >= 2) {
    console.log("   \u2022 Qwen2.5-1.5B (3GB VRAM)");
    console.log("   \u2022 Llama-3-8B (16GB VRAM)");
  } else {
    console.log("   \u2022 Gemma-3-1B (4GB VRAM)");
    console.log("   \u2022 Phi-3-mini (2.5GB VRAM)");
  }
  console.log("");
  console.log("Pull with: ollama pull <model-name>");
});
program.command("hive").description("Hive operations").command("whoami").description("Show agent identity information").action(() => {
  const identityPath = path2.join(os3.homedir(), ".synapse");
  if (!fs.existsSync(path2.join(identityPath, "identity.json"))) {
    console.log("\u274C No identity found. Run `synapse start` first.");
    return;
  }
  const identity = loadIdentity(identityPath);
  const profile = getAgentProfile(identity);
  console.log("\u{1F41D} Hive Agent Identity\n");
  console.log(`   Agent ID: ${profile.agentId}`);
  console.log(`   Peer ID:  ${profile.peerId}`);
  console.log(`   Tier:     ${profile.tier} (${getTierName(profile.tier)})`);
  console.log(`   Mode:     ${profile.mode.toUpperCase()}`);
  console.log(`   Status:   ${profile.status.toUpperCase()}`);
  console.log(`   Created:  ${new Date(profile.createdAt).toISOString()}`);
});
program.parse();
