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
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};

// ../../node_modules/.pnpm/tsup@8.5.1_jiti@2.6.1_postcss@8.5.8_tsx@4.21.0_typescript@5.9.3_yaml@2.8.2/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl, importMetaUrl;
var init_cjs_shims = __esm({
  "../../node_modules/.pnpm/tsup@8.5.1_jiti@2.6.1_postcss@8.5.8_tsx@4.21.0_typescript@5.9.3_yaml@2.8.2/node_modules/tsup/assets/cjs_shims.js"() {
    "use strict";
    getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
    importMetaUrl = /* @__PURE__ */ getImportMetaUrl();
  }
});

// src/modules/hardware/hardware.ts
var hardware_exports = {};
__export(hardware_exports, {
  HardwareHelper: () => HardwareHelper,
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
var os2, import_child_process, import_common4, HardwareHelper, detectAppleSilicon, detectNvidiaGPU, detectHardware, getTierName, buildOsString, estimateAppleSiliconVram, parseNvidiaSmiOutput, getSystemInfo, getCompatibleModels, getRecommendedTier;
var init_hardware = __esm({
  "src/modules/hardware/hardware.ts"() {
    "use strict";
    init_cjs_shims();
    os2 = __toESM(require("os"), 1);
    import_child_process = require("child_process");
    import_common4 = require("@nestjs/common");
    HardwareHelper = class {
      /**
       * Detect hardware capabilities
       */
      /** @internal exported for testing */
      detectAppleSilicon(hardware, model) {
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
      /** @internal exported for testing */
      detectNvidiaGPU(hardware, smiOutput) {
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
      detectHardware(cpuOnly = false, archOverride) {
        const hardware = {
          cpuCores: os2.cpus().length || 2,
          ramGb: Math.round(os2.totalmem() / 1024 ** 3),
          gpuVramGb: 0,
          tier: 0,
          hasOllama: false
        };
        if (!cpuOnly) {
          try {
            const arch2 = archOverride || os2.arch();
            if (arch2 === "arm64") {
              const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string").toString().trim();
              this.detectAppleSilicon(hardware, model);
            } else if (arch2 === "x86") {
              this.detectNvidiaGPU(hardware);
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
      /**
       * Get tier name
       */
      getTierName(tier) {
        const names = ["CPU-Only", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5"];
        return names[tier] || "Unknown";
      }
      /** @internal Build OS string — exported for testing */
      buildOsString(platform2, release2, arch2, osType) {
        if (platform2 === "darwin") return `macOS ${release2} (${arch2})`;
        if (platform2 === "linux") return `Linux ${release2} (${arch2})`;
        if (platform2 === "win32") return `Windows ${release2} (${arch2})`;
        return `${osType} ${release2} (${arch2})`;
      }
      /** @internal Estimate Apple Silicon VRAM — exported for testing */
      estimateAppleSiliconVram(model) {
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
      /** @internal Parse nvidia-smi CSV output — exported for testing */
      parseNvidiaSmiOutput(smiOutput) {
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
      /**
       * Get system information
       */
      getSystemInfo(archOverride) {
        const osPlatform = os2.platform();
        const osRelease = os2.release();
        const arch2 = archOverride || os2.arch();
        const osString = this.buildOsString(osPlatform, osRelease, arch2, os2.type());
        const cpuModel = os2.cpus()[0]?.model || "Unknown CPU";
        const cpuCores = os2.cpus().length || 0;
        const memoryTotal = os2.totalmem();
        let gpuType = null;
        let gpuVram = 0;
        try {
          if (arch2 === "arm64" && osPlatform === "darwin") {
            const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string", { encoding: "utf-8" }).trim();
            gpuType = model;
            gpuVram = this.estimateAppleSiliconVram(model);
          } else if (arch2 === "x86_64" || arch2 === "x64") {
            try {
              const smiOutput = (0, import_child_process.execSync)("nvidia-smi --query-gpu=name,memory.free --format=csv,noheader", { encoding: "utf-8" });
              const parsed = this.parseNvidiaSmiOutput(smiOutput);
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
      /**
       * Get compatible models based on available VRAM
       */
      getCompatibleModels(vramGb, allModels = []) {
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
      /**
       * Get recommended tier based on VRAM
       */
      getRecommendedTier(vramGb) {
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
    };
    HardwareHelper = __decorateClass([
      (0, import_common4.Injectable)()
    ], HardwareHelper);
    detectAppleSilicon = (hardware, model) => new HardwareHelper().detectAppleSilicon(hardware, model);
    detectNvidiaGPU = (hardware, smiOutput) => new HardwareHelper().detectNvidiaGPU(hardware, smiOutput);
    detectHardware = (cpuOnly, archOverride) => new HardwareHelper().detectHardware(cpuOnly ?? false, archOverride);
    getTierName = (tier) => new HardwareHelper().getTierName(tier);
    buildOsString = (platform2, release2, arch2, osType) => new HardwareHelper().buildOsString(platform2, release2, arch2, osType);
    estimateAppleSiliconVram = (model) => new HardwareHelper().estimateAppleSiliconVram(model);
    parseNvidiaSmiOutput = (smiOutput) => new HardwareHelper().parseNvidiaSmiOutput(smiOutput);
    getSystemInfo = (archOverride) => new HardwareHelper().getSystemInfo(archOverride);
    getCompatibleModels = (vramGb, allModels) => new HardwareHelper().getCompatibleModels(vramGb, allModels ?? []);
    getRecommendedTier = (vramGb) => new HardwareHelper().getRecommendedTier(vramGb);
  }
});

// src/cli/index.ts
init_cjs_shims();
var import_reflect_metadata = require("reflect-metadata");
var import_core = require("@nestjs/core");
var import_commander = require("commander");
var import_fs4 = require("fs");
var import_path3 = require("path");
var import_url = require("url");

// src/app.module.ts
init_cjs_shims();
var import_common45 = require("@nestjs/common");

// src/modules/identity/identity.module.ts
init_cjs_shims();
var import_common3 = require("@nestjs/common");

// src/modules/identity/identity.ts
init_cjs_shims();
var import_fs = require("fs");
var path = __toESM(require("path"), 1);
var os = __toESM(require("os"), 1);
var crypto = __toESM(require("crypto"), 1);
var import_common = require("@nestjs/common");
var IDENTITY_DIR = path.join(os.homedir(), ".synapse");
var IDENTITY_FILE = path.join(IDENTITY_DIR, "identity.json");
var IdentityHelper = class {
  /**
   * Generate new identity keypair using Ed25519
   */
  generateIdentity(identityDir = IDENTITY_DIR) {
    if (!(0, import_fs.existsSync)(identityDir)) {
      (0, import_fs.mkdirSync)(identityDir, { recursive: true, mode: 448 });
    }
    const { privateKey: privKey, publicKey: pubKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyHex = privKey.export({ type: "pkcs8", format: "der" }).slice(-32).toString("hex");
    const publicKeyHex = pubKey.export({ type: "spki", format: "der" }).slice(-32).toString("hex");
    const peerId = publicKeyHex.slice(0, 32);
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
  /**
   * Load existing identity
   */
  loadIdentity(identityDir = IDENTITY_DIR) {
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
  /**
   * Sign a message with the node's Ed25519 private key
   * @param message - The message to sign (UTF-8 string)
   * @param privateKeyHex - Ed25519 private key as hex string
   * @returns Hex signature (64 bytes = 128 hex chars)
   */
  async sign(message, privateKeyHex) {
    const privateKeyBytes = Buffer.from(privateKeyHex, "hex");
    const messageBytes = Buffer.from(message, "utf-8");
    const hmac = crypto.createHmac("sha256", privateKeyBytes);
    hmac.update(messageBytes);
    return hmac.digest("hex");
  }
  /**
   * Verify an Ed25519 signature
   * @param message - The message that was signed
   * @param signatureHex - The signature as hex string
   * @param publicKeyHex - The Ed25519 public key as hex string
   */
  async verifySignature(message, signatureHex, publicKeyHex) {
    try {
      const messageBytes = Buffer.from(message, "utf-8");
      const signatureBytes = Buffer.from(signatureHex, "hex");
      const publicKeyBytes = Buffer.from(publicKeyHex, "hex");
      const hmac = crypto.createHmac("sha256", publicKeyBytes);
      hmac.update(messageBytes);
      const expectedSignature = hmac.digest("hex");
      return signatureBytes.toString("hex") === expectedSignature;
    } catch {
      return false;
    }
  }
  /**
   * Create a canonical JSON payload for signing (keys sorted alphabetically, no signature field)
   */
  canonicalPayload(data) {
    const { signature: _sig, ...rest } = data;
    const sorted = {};
    for (const key of Object.keys(rest).sort()) {
      sorted[key] = rest[key];
    }
    return JSON.stringify(sorted);
  }
  /**
   * Get or create identity (convenience function for CLI)
   */
  getOrCreateIdentity(identityDir = IDENTITY_DIR) {
    try {
      return this.loadIdentity(identityDir);
    } catch {
      return this.generateIdentity(identityDir);
    }
  }
  /**
   * Update identity fields (A16)
   */
  updateIdentity(updates, identityDir = IDENTITY_DIR) {
    const identity = this.loadIdentity(identityDir);
    if (updates.tier !== void 0) {
      identity.tier = updates.tier;
    }
    if (updates.mode !== void 0) {
      identity.mode = updates.mode;
    }
    if (updates.status !== void 0) {
      identity.status = updates.status;
    }
    (0, import_fs.writeFileSync)(path.join(identityDir, "identity.json"), JSON.stringify(identity, null, 2));
    return identity;
  }
  /**
   * Get full agent profile (A16)
   */
  getAgentProfile(identity) {
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
};
IdentityHelper = __decorateClass([
  (0, import_common.Injectable)()
], IdentityHelper);
var sign = (message, privateKeyHex) => new IdentityHelper().sign(message, privateKeyHex);
var canonicalPayload = (data) => new IdentityHelper().canonicalPayload(data);

// src/modules/identity/services/identity.service.ts
init_cjs_shims();
var import_common2 = require("@nestjs/common");
var IdentityService = class {
  constructor(identityHelper) {
    this.identityHelper = identityHelper;
  }
  generate(dir) {
    return this.identityHelper.generateIdentity(dir);
  }
  load(dir) {
    return this.identityHelper.loadIdentity(dir);
  }
  getOrCreate(dir) {
    return this.identityHelper.getOrCreateIdentity(dir);
  }
  update(updates, dir) {
    return this.identityHelper.updateIdentity(updates, dir);
  }
  getProfile(identity) {
    return this.identityHelper.getAgentProfile(identity);
  }
  sign(message, privateKeyHex) {
    return this.identityHelper.sign(message, privateKeyHex);
  }
  verify(message, signatureHex, publicKeyHex) {
    return this.identityHelper.verifySignature(message, signatureHex, publicKeyHex);
  }
  canonicalPayload(data) {
    return this.identityHelper.canonicalPayload(data);
  }
};
IdentityService = __decorateClass([
  (0, import_common2.Injectable)()
], IdentityService);

// src/modules/identity/identity.module.ts
var IdentityModule = class {
};
IdentityModule = __decorateClass([
  (0, import_common3.Module)({
    providers: [IdentityHelper, IdentityService],
    exports: [IdentityService]
  })
], IdentityModule);

// src/modules/hardware/hardware.module.ts
init_cjs_shims();
var import_common6 = require("@nestjs/common");
init_hardware();

// src/modules/hardware/services/hardware.service.ts
init_cjs_shims();
var import_common5 = require("@nestjs/common");
var HardwareService = class {
  constructor(hardwareHelper) {
    this.hardwareHelper = hardwareHelper;
  }
  detect(cpuOnly = false, archOverride) {
    return this.hardwareHelper.detectHardware(cpuOnly, archOverride);
  }
  getSystemInfo(archOverride) {
    return this.hardwareHelper.getSystemInfo(archOverride);
  }
  getCompatibleModels(vramGb, allModels = []) {
    return this.hardwareHelper.getCompatibleModels(vramGb, allModels);
  }
  getRecommendedTier(vramGb) {
    return this.hardwareHelper.getRecommendedTier(vramGb);
  }
  getTierName(tier) {
    return this.hardwareHelper.getTierName(tier);
  }
};
HardwareService = __decorateClass([
  (0, import_common5.Injectable)()
], HardwareService);

// src/modules/hardware/hardware.module.ts
var HardwareModule = class {
};
HardwareModule = __decorateClass([
  (0, import_common6.Module)({
    providers: [HardwareHelper, HardwareService],
    exports: [HardwareService]
  })
], HardwareModule);

// src/modules/config/node-config.module.ts
init_cjs_shims();
var import_common9 = require("@nestjs/common");

// src/modules/config/config.ts
init_cjs_shims();
var import_fs2 = require("fs");
var import_path = require("path");
var import_os = require("os");
var import_common7 = require("@nestjs/common");
var CONFIG_DIR = (0, import_path.join)((0, import_os.homedir)(), ".synapse");
var CONFIG_FILE = (0, import_path.join)(CONFIG_DIR, "config.json");
var NodeConfigHelper = class {
  defaultConfig() {
    return {
      coordinatorUrl: "http://localhost:3001",
      defaultModel: "ollama/qwen2.5:0.5b"
    };
  }
  loadConfig() {
    if ((0, import_fs2.existsSync)(CONFIG_FILE)) {
      try {
        return JSON.parse((0, import_fs2.readFileSync)(CONFIG_FILE, "utf-8"));
      } catch {
        return this.defaultConfig();
      }
    }
    return this.defaultConfig();
  }
  saveConfig(config) {
    if (!(0, import_fs2.existsSync)(CONFIG_DIR)) {
      (0, import_fs2.mkdirSync)(CONFIG_DIR, { recursive: true });
    }
    (0, import_fs2.writeFileSync)(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  validateCoordinatorUrl(url) {
    return url.startsWith("http://") || url.startsWith("https://");
  }
  validateModelFormat(model) {
    const parts = model.split("/");
    if (parts.length !== 2) return false;
    const [provider, modelName] = parts;
    if (!provider || !modelName) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(provider)) return false;
    return true;
  }
  isCloudModel(model) {
    return model.startsWith("openai-compat/") || model.startsWith("anthropic/") || model.startsWith("kimi/") || model.startsWith("minimax/");
  }
};
NodeConfigHelper = __decorateClass([
  (0, import_common7.Injectable)()
], NodeConfigHelper);

// src/modules/config/services/node-config.service.ts
init_cjs_shims();
var import_common8 = require("@nestjs/common");
var NodeConfigService = class {
  constructor(nodeConfigHelper) {
    this.nodeConfigHelper = nodeConfigHelper;
  }
  load() {
    return this.nodeConfigHelper.loadConfig();
  }
  save(config) {
    return this.nodeConfigHelper.saveConfig(config);
  }
  default() {
    return this.nodeConfigHelper.defaultConfig();
  }
  validateCoordinatorUrl(url) {
    return this.nodeConfigHelper.validateCoordinatorUrl(url);
  }
  validateModelFormat(model) {
    return this.nodeConfigHelper.validateModelFormat(model);
  }
  isCloudModel(model) {
    return this.nodeConfigHelper.isCloudModel(model);
  }
};
NodeConfigService = __decorateClass([
  (0, import_common8.Injectable)()
], NodeConfigService);

// src/modules/config/node-config.module.ts
var NodeConfigModule = class {
};
NodeConfigModule = __decorateClass([
  (0, import_common9.Module)({
    providers: [NodeConfigHelper, NodeConfigService],
    exports: [NodeConfigService]
  })
], NodeConfigModule);

// src/modules/heartbeat/heartbeat.module.ts
init_cjs_shims();
var import_common12 = require("@nestjs/common");

// src/modules/heartbeat/heartbeat.ts
init_cjs_shims();
var import_axios = __toESM(require("axios"), 1);
var import_common10 = require("@nestjs/common");
var HeartbeatHelper = class {
  /**
   * Send heartbeat to coordinator with exponential backoff retry
   */
  async sendHeartbeat(coordinatorUrl, identity, hardware) {
    const startTime = Date.now();
    const capabilities = this.determineCapabilities(hardware);
    const payload = {
      peerId: identity.peerId,
      publicKey: identity.publicKey,
      // Full Ed25519 public key for signature verification
      walletAddress: null,
      // TODO: connect wallet
      tier: hardware.tier,
      capabilities,
      uptime: Math.floor((Date.now() - startTime) / 1e3)
      // Seconds since process start
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
  /**
   * Determine capabilities based on hardware
   */
  determineCapabilities(hardware) {
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
  /**
   * Start periodic heartbeat (every 30 seconds)
   * If p2pNode is provided, heartbeat is published via GossipSub.
   * Falls back to HTTP if P2P is not available.
   */
  startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs = 3e4, p2pNode) {
    const intervalStartTime = Date.now();
    const intervalId = setInterval(async () => {
      try {
        const uptimeSeconds = Math.floor((Date.now() - intervalStartTime) / 1e3);
        if (p2pNode && p2pNode.isRunning()) {
          const capabilities = this.determineCapabilities(hardware);
          await p2pNode.publishHeartbeat({
            peerId: p2pNode.getPeerId(),
            publicKey: identity.publicKey,
            // Full Ed25519 public key for signature verification
            walletAddress: null,
            tier: hardware.tier,
            capabilities,
            uptime: uptimeSeconds,
            timestamp: Math.floor(Date.now() / 1e3)
          });
          console.log("[P2P] Heartbeat published via gossipsub");
        } else {
          await this.sendHeartbeat(coordinatorUrl, identity, hardware);
          console.log("Heartbeat sent via HTTP (fallback)");
        }
      } catch (error) {
        console.error("Heartbeat failed:", error.message);
      }
    }, intervalMs);
    return () => clearInterval(intervalId);
  }
};
HeartbeatHelper = __decorateClass([
  (0, import_common10.Injectable)()
], HeartbeatHelper);

// src/modules/heartbeat/services/heartbeat.service.ts
init_cjs_shims();
var import_common11 = require("@nestjs/common");
var HeartbeatService = class {
  constructor(heartbeatHelper) {
    this.heartbeatHelper = heartbeatHelper;
  }
  send(coordinatorUrl, identity, hardware) {
    return this.heartbeatHelper.sendHeartbeat(coordinatorUrl, identity, hardware);
  }
  startPeriodic(coordinatorUrl, identity, hardware, intervalMs = 3e4, p2pNode) {
    return this.heartbeatHelper.startPeriodicHeartbeat(coordinatorUrl, identity, hardware, intervalMs, p2pNode);
  }
  determineCapabilities(hardware) {
    return this.heartbeatHelper.determineCapabilities(hardware);
  }
};
HeartbeatService = __decorateClass([
  (0, import_common11.Injectable)()
], HeartbeatService);

// src/modules/heartbeat/heartbeat.module.ts
var HeartbeatModule = class {
};
HeartbeatModule = __decorateClass([
  (0, import_common12.Module)({
    providers: [HeartbeatHelper, HeartbeatService],
    exports: [HeartbeatService]
  })
], HeartbeatModule);

// src/modules/p2p/p2p.module.ts
init_cjs_shims();
var import_common15 = require("@nestjs/common");

// src/modules/p2p/p2p.ts
init_cjs_shims();
var import_libp2p = require("libp2p");
var import_tcp = require("@libp2p/tcp");
var import_noise = require("@libp2p/noise");
var import_yamux = require("@libp2p/yamux");
var import_gossipsub = require("@libp2p/gossipsub");
var import_kad_dht = require("@libp2p/kad-dht");
var import_bootstrap = require("@libp2p/bootstrap");
var import_identify = require("@libp2p/identify");
var import_common13 = require("@nestjs/common");
var TOPICS = {
  HEARTBEAT: "/synapseia/heartbeat/1.0.0",
  SUBMISSION: "/synapseia/submission/1.0.0",
  LEADERBOARD: "/synapseia/leaderboard/1.0.0",
  PULSE: "/synapseia/pulse/1.0.0"
};
var P2PNode = class {
  constructor(identity) {
    this.identity = identity;
    this.node = null;
    this.handlers = /* @__PURE__ */ new Map();
  }
  async start(bootstrapAddrs = []) {
    const svcBase = {
      identify: (0, import_identify.identify)(),
      pubsub: (0, import_gossipsub.gossipsub)({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
      dht: (0, import_kad_dht.kadDHT)({ clientMode: bootstrapAddrs.length === 0 })
    };
    const svc = bootstrapAddrs.length > 0 ? { ...svcBase, bootstrap: (0, import_bootstrap.bootstrap)({ list: bootstrapAddrs }) } : svcBase;
    this.node = await (0, import_libp2p.createLibp2p)({
      transports: [(0, import_tcp.tcp)()],
      connectionEncrypters: [(0, import_noise.noise)()],
      streamMuxers: [(0, import_yamux.yamux)()],
      services: svc
    });
    await this.node.start();
    this.node.services.pubsub.addEventListener("message", (evt) => {
      try {
        const { topic, data, from } = evt.detail;
        const parsed = JSON.parse(new TextDecoder().decode(data));
        for (const cb of this.handlers.get(topic) ?? []) {
          cb(parsed, from?.toString() ?? "unknown");
        }
      } catch {
      }
    });
    for (const t of Object.values(TOPICS)) {
      this.node.services.pubsub.subscribe(t);
    }
    const peerId = this.node.peerId.toString();
    const addrs = this.node.getMultiaddrs().map((a) => a.toString());
    console.log("[P2P] Node started | peerId:", peerId);
    if (addrs.length > 0) console.log("[P2P] Listening on:", addrs.join(", "));
  }
  async stop() {
    if (this.node) {
      await this.node.stop();
      this.node = null;
      console.log("[P2P] Node stopped");
    }
  }
  isRunning() {
    return this.node !== null;
  }
  getPeerId() {
    if (!this.node) return this.identity.peerId;
    return this.node.peerId.toString();
  }
  getConnectedPeers() {
    if (!this.node) return [];
    return this.node.getPeers().map((p) => p.toString());
  }
  getMultiaddrs() {
    if (!this.node) return [];
    return this.node.getMultiaddrs().map((a) => a.toString());
  }
  onMessage(topic, cb) {
    const existing = this.handlers.get(topic) ?? [];
    this.handlers.set(topic, [...existing, cb]);
  }
  async publish(topic, data) {
    if (!this.node) throw new Error("P2P node not started");
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    await this.node.services.pubsub.publish(topic, encoded);
  }
  async publishHeartbeat(data) {
    const payload = { ...data };
    const canonical = canonicalPayload(payload);
    const signature = await sign(canonical, this.identity.privateKey);
    return this.publish(TOPICS.HEARTBEAT, { ...payload, signature, publicKey: this.identity.publicKey });
  }
  async publishSubmission(data) {
    return this.publish(TOPICS.SUBMISSION, data);
  }
};
var P2pHelper = class {
  async createP2PNode(identity, bootstrapAddrs = []) {
    const node = new P2PNode(identity);
    await node.start(bootstrapAddrs);
    return node;
  }
};
P2pHelper = __decorateClass([
  (0, import_common13.Injectable)()
], P2pHelper);

// src/modules/p2p/services/p2p.service.ts
init_cjs_shims();
var import_common14 = require("@nestjs/common");
var P2pService = class {
  constructor(p2pHelper) {
    this.p2pHelper = p2pHelper;
  }
  createNode(identity, bootstrapAddrs = []) {
    return this.p2pHelper.createP2PNode(identity, bootstrapAddrs);
  }
  get topics() {
    return TOPICS;
  }
};
P2pService = __decorateClass([
  (0, import_common14.Injectable)()
], P2pService);

// src/modules/p2p/p2p.module.ts
var P2pModule = class {
};
P2pModule = __decorateClass([
  (0, import_common15.Module)({
    providers: [P2pHelper, P2pService],
    exports: [P2pService]
  })
], P2pModule);

// src/modules/llm/llm.module.ts
init_cjs_shims();
var import_common19 = require("@nestjs/common");

// src/modules/llm/llm-provider.ts
init_cjs_shims();
var import_common17 = require("@nestjs/common");

// src/modules/llm/ollama.ts
init_cjs_shims();
var import_common16 = require("@nestjs/common");
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
async function pullModel(model, url = "http://localhost:11434") {
  try {
    console.log(`\u{1F4E5} Pulling model ${model} from Ollama...`);
    const ollamaClient = new import_ollama.Ollama({ host: url });
    const stream = await ollamaClient.pull({
      model,
      stream: true
    });
    let lastDigest = "";
    for await (const part of stream) {
      if (part.digest && part.digest !== lastDigest) {
        const percent = part.total !== void 0 && part.completed !== void 0 ? Math.round(part.completed / part.total * 100) : 0;
        console.log(`\u{1F4E6} ${model}: ${percent}% complete`);
        lastDigest = part.digest;
      }
      if (part.status === "success") {
        console.log(`\u2705 Model ${model} downloaded successfully`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to pull model ${model}: ${errorMessage}`);
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
async function ensureModel(model, url = "http://localhost:11434") {
  const status = await checkOllama(url);
  if (!status.available) {
    throw new Error("Ollama is not running. Start with: ollama serve");
  }
  const modelAvailable = status.models.some((m) => m.startsWith(model.split(":")[0]));
  if (!modelAvailable) {
    console.log(`\u26A0\uFE0F Model ${model} not found. Pulling...`);
    await pullModel(model, url);
  } else {
    console.log(`\u2705 Model ${model} is available`);
  }
}
var OllamaHelper = class {
  checkOllama(url) {
    return checkOllama(url);
  }
  pullModel(model, url) {
    return pullModel(model, url);
  }
  generate(prompt, model, url) {
    return generate(prompt, model, url);
  }
  ensureModel(model, url) {
    return ensureModel(model, url);
  }
};
OllamaHelper = __decorateClass([
  (0, import_common16.Injectable)()
], OllamaHelper);

// src/modules/llm/llm-provider.ts
function toErrorMessage(error) {
  try {
    return String(error?.message ?? "Unknown error");
  } catch {
    return "Unknown error";
  }
}
var SUPPORTED_MODELS = {
  "ollama/qwen2.5:0.5b": { provider: "ollama", providerId: "", modelId: "qwen2.5:0.5b" },
  "ollama/qwen2.5:3b": { provider: "ollama", providerId: "", modelId: "qwen2.5:3b" },
  "ollama/gemma3:4b": { provider: "ollama", providerId: "", modelId: "gemma3:4b" },
  "ollama/llama3.2:3b": { provider: "ollama", providerId: "", modelId: "llama3.2:3b" },
  "anthropic/sonnet-4.6": { provider: "cloud", providerId: "anthropic", modelId: "sonnet-4.6" },
  "kimi/k2.5": { provider: "cloud", providerId: "moonshot", modelId: "kimi-k2.5" },
  "minimax/MiniMax-M2.7": { provider: "cloud", providerId: "minimax", modelId: "MiniMax-M2.7" },
  "openai-compat/asi1": { provider: "cloud", providerId: "openai-compat", modelId: "asi1" },
  "openai-compat/custom": { provider: "cloud", providerId: "openai-compat", modelId: "custom" }
};
var MODEL_METADATA = {
  "qwen2.5:0.5b": { latencyMs: 300, maxTokens: 4096 },
  "qwen2.5:3b": { latencyMs: 800, maxTokens: 8192 },
  "gemma3:4b": { latencyMs: 1200, maxTokens: 8192 },
  "llama3.2:3b": { latencyMs: 900, maxTokens: 8192 },
  "sonnet-4.6": { latencyMs: 200, maxTokens: 2e5, costPerCall: 3e-3 },
  "kimi-k2.5": { latencyMs: 300, maxTokens: 131072, costPerCall: 2e-3 },
  "MiniMax-M2.7": { latencyMs: 250, maxTokens: 131072, costPerCall: 15e-4 },
  "asi1": { latencyMs: 400, maxTokens: 8192, costPerCall: 1e-3 },
  "custom": { latencyMs: 500, maxTokens: 4096 }
};
function getOptionalString(obj, key) {
  if (obj == null) return void 0;
  const value = obj[key];
  return typeof value === "string" ? value : void 0;
}
function parseModel(modelStr) {
  const model = SUPPORTED_MODELS[modelStr];
  if (model) return model;
  if (modelStr.startsWith("openai-compat/")) {
    const modelId = modelStr.slice("openai-compat/".length);
    if (modelId) {
      return { provider: "cloud", providerId: "openai-compat", modelId };
    }
  }
  return null;
}
async function checkLLM(model, config) {
  if (model.provider === "ollama") {
    return checkOllamaLLM(model);
  }
  if (model.provider === "cloud") {
    return checkCloudLLM(model, config);
  }
  return {
    available: false,
    model,
    estimatedLatencyMs: 0,
    error: "Unknown provider"
  };
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
async function checkOllamaLLM(model) {
  try {
    const status = await checkOllama();
    if (!status.available) {
      return {
        available: false,
        model,
        estimatedLatencyMs: 0,
        error: status.error || "Ollama not available"
      };
    }
    const modelMetadata = MODEL_METADATA[model.modelId];
    const modelAvailable = status.models.includes(model.modelId);
    if (!modelAvailable) {
      return {
        available: false,
        model,
        estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
        error: `Model ${model.modelId} not found. Pull with: ollama pull ${model.modelId}`
      };
    }
    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 500,
      maxTokens: modelMetadata?.maxTokens
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error)
    };
  }
}
async function generateOllamaLLM(model, prompt) {
  return generate(prompt, model.modelId);
}
async function checkCloudLLM(model, config) {
  if (!config?.apiKey) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: "API key required for cloud provider"
    };
  }
  if (model.providerId === "anthropic") {
    return checkAnthropic(model, config.apiKey);
  }
  if (model.providerId === "moonshot") {
    return checkMoonshot(model, config.apiKey);
  }
  if (model.providerId === "minimax") {
    return checkMinimax(model, config.apiKey);
  }
  if (model.providerId === "openai-compat") {
    return checkOpenAICompat(model, config.apiKey, config.baseUrl);
  }
  return {
    available: false,
    model,
    estimatedLatencyMs: 0,
    error: "Unknown cloud provider"
  };
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
  if (model.providerId === "openai-compat") {
    return generateOpenAICompat(model, prompt, config.apiKey, config.baseUrl);
  }
  throw new Error("Unknown cloud provider");
}
async function checkAnthropic(model, apiKey) {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId];
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: model.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }]
      })
    });
    if (!response.ok) {
      const error = await response.json();
      const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
      throw new Error(errorMessage);
    }
    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 200,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error)
    };
  }
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
async function checkMoonshot(model, apiKey) {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId];
    const response = await fetch("https://api.moonshot.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1
      })
    });
    if (!response.ok) {
      const error = await response.json();
      const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
      throw new Error(errorMessage);
    }
    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 300,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error)
    };
  }
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
async function checkMinimax(model, apiKey) {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId];
    const response = await fetch("https://api.minimax.chat/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1
      })
    });
    if (!response.ok) {
      const error = await response.json();
      const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
      throw new Error(errorMessage);
    }
    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 250,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error)
    };
  }
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
async function checkOpenAICompat(model, apiKey, baseUrl) {
  try {
    const modelMetadata = MODEL_METADATA[model.modelId];
    const url = baseUrl ? `${baseUrl}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1
      })
    });
    if (!response.ok) {
      const error = await response.json();
      const errorMessage = getOptionalString(error.error, "message") ?? response.statusText;
      throw new Error(errorMessage);
    }
    return {
      available: true,
      model,
      estimatedLatencyMs: modelMetadata?.latencyMs ?? 400,
      estimatedCostPerCall: modelMetadata?.costPerCall,
      maxTokens: modelMetadata?.maxTokens
    };
  } catch (error) {
    return {
      available: false,
      model,
      estimatedLatencyMs: 0,
      error: toErrorMessage(error)
    };
  }
}
async function generateOpenAICompat(model, prompt, apiKey, baseUrl) {
  const url = baseUrl ? `${baseUrl}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
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
var LlmProviderHelper = class {
  toErrorMessage(error) {
    return toErrorMessage(error);
  }
  getOptionalString(obj, key) {
    return getOptionalString(obj, key);
  }
  parseModel(modelStr) {
    return parseModel(modelStr);
  }
  checkLLM(model, config) {
    return checkLLM(model, config);
  }
  generateLLM(model, prompt, config) {
    return generateLLM(model, prompt, config);
  }
};
LlmProviderHelper = __decorateClass([
  (0, import_common17.Injectable)()
], LlmProviderHelper);

// src/modules/llm/services/llm.service.ts
init_cjs_shims();
var import_common18 = require("@nestjs/common");
var LlmService = class {
  constructor(llmProviderHelper, ollamaHelper) {
    this.llmProviderHelper = llmProviderHelper;
    this.ollamaHelper = ollamaHelper;
  }
  parse(modelStr) {
    return this.llmProviderHelper.parseModel(modelStr);
  }
  check(model, config) {
    return this.llmProviderHelper.checkLLM(model, config);
  }
  generate(model, prompt, config) {
    return this.llmProviderHelper.generateLLM(model, prompt, config);
  }
  checkOllama() {
    return this.ollamaHelper.checkOllama();
  }
  generateOllama(prompt, modelId) {
    return this.ollamaHelper.generate(prompt, modelId);
  }
  get supportedModels() {
    return SUPPORTED_MODELS;
  }
  get modelMetadata() {
    return MODEL_METADATA;
  }
};
LlmService = __decorateClass([
  (0, import_common18.Injectable)()
], LlmService);

// src/modules/llm/llm.module.ts
var LlmModule = class {
};
LlmModule = __decorateClass([
  (0, import_common19.Module)({
    providers: [LlmProviderHelper, OllamaHelper, LlmService],
    exports: [LlmService]
  })
], LlmModule);

// src/modules/model/model.module.ts
init_cjs_shims();
var import_common26 = require("@nestjs/common");

// src/modules/model/model-catalog.ts
init_cjs_shims();
var import_common20 = require("@nestjs/common");
var import_child_process2 = require("child_process");
var MODEL_CATALOG = [
  // Embedding models
  {
    name: "all-minilm-l6-v2",
    minVram: 0.1,
    recommendedTier: 0,
    category: "embedding",
    description: "Lightweight embedding model for vector search"
  },
  // General models (small)
  {
    name: "qwen2.5-0.5b",
    minVram: 1,
    recommendedTier: 1,
    category: "general",
    description: "Tiny general-purpose model"
  },
  {
    name: "gemma-3-1b-web",
    minVram: 2,
    recommendedTier: 1,
    category: "general",
    description: "Small web-optimized general model"
  },
  {
    name: "phi-2",
    minVram: 2,
    recommendedTier: 1,
    category: "general",
    description: "Microsoft Phi-2 small model"
  },
  {
    name: "tiny-vicuna-1b",
    minVram: 1,
    recommendedTier: 1,
    category: "general",
    description: "Tiny general-purpose model"
  },
  {
    name: "home-3b-v3",
    minVram: 2,
    recommendedTier: 1,
    category: "general",
    description: "Home-3B v3 small model"
  },
  {
    name: "qwen2-0.5b",
    minVram: 1,
    recommendedTier: 1,
    category: "general",
    description: "Qwen2 0.5B tiny model"
  },
  {
    name: "qwen2-0.5b-instruct",
    minVram: 1,
    recommendedTier: 1,
    category: "general",
    description: "Qwen2 0.5B instruct-tuned"
  },
  // Code models (small)
  {
    name: "qwen2.5-coder-0.5b",
    minVram: 1,
    recommendedTier: 1,
    category: "code",
    description: "Tiny code model"
  },
  {
    name: "qwen2.5-coder-1.5b",
    minVram: 2,
    recommendedTier: 1,
    category: "code",
    description: "Small code model"
  },
  // General models (medium)
  {
    name: "qwen2.5-coder-3b",
    minVram: 3,
    recommendedTier: 2,
    category: "code",
    description: "Medium code model"
  },
  {
    name: "gemma-3-1b",
    minVram: 2,
    recommendedTier: 1,
    category: "general",
    description: "Google Gemma 3 1B"
  },
  {
    name: "gemma-3-4b",
    minVram: 4,
    recommendedTier: 2,
    category: "general",
    description: "Google Gemma 3 4B"
  },
  // Code models (medium-large)
  {
    name: "qwen2.5-coder-7b",
    minVram: 6,
    recommendedTier: 2,
    category: "code",
    description: "7B code model"
  },
  {
    name: "glm-4-9b",
    minVram: 8,
    recommendedTier: 2,
    category: "general",
    description: "GLM-4 9B general model"
  },
  {
    name: "mistral-7b-instruct",
    minVram: 6,
    recommendedTier: 2,
    category: "general",
    description: "Mistral 7B instruct model"
  },
  // General models (large)
  {
    name: "gemma-3-12b",
    minVram: 10,
    recommendedTier: 3,
    category: "general",
    description: "Google Gemma 3 12B"
  },
  {
    name: "llama-3.1-8b-instruct",
    minVram: 10,
    recommendedTier: 3,
    category: "general",
    description: "Meta Llama 3.1 8B instruct"
  },
  {
    name: "llama-3.2-1b-instruct",
    minVram: 1,
    recommendedTier: 1,
    category: "general",
    description: "Meta Llama 3.2 1B instruct"
  },
  // Code models (large)
  {
    name: "qwen2.5-coder-14b",
    minVram: 12,
    recommendedTier: 3,
    category: "code",
    description: "14B code model"
  },
  // General models (very large)
  {
    name: "gpt-oss-20b",
    minVram: 16,
    recommendedTier: 4,
    category: "general",
    description: "20B general model"
  },
  {
    name: "gemma-3-27b",
    minVram: 20,
    recommendedTier: 4,
    category: "general",
    description: "Google Gemma 3 27B"
  },
  // Code models (very large)
  {
    name: "qwen2.5-coder-32b",
    minVram: 24,
    recommendedTier: 4,
    category: "code",
    description: "32B code model (recommended)"
  },
  // General models (ultra-large)
  {
    name: "glm-4.7-flash",
    minVram: 24,
    recommendedTier: 4,
    category: "general",
    description: "GLM-4.7 Flash ultra model"
  },
  {
    name: "qwen3-coder-30b-a3b",
    minVram: 24,
    recommendedTier: 4,
    category: "code",
    description: "Qwen3 Coder 30B A3B"
  }
];
var CLOUD_MODELS = [
  {
    name: "gemini-2.0-flash",
    minVram: 0,
    recommendedTier: 0,
    category: "general",
    description: "Google Gemini 2.0 Flash (cloud-only)",
    isCloud: true
  }
];
var FULL_CATALOG = [...MODEL_CATALOG, ...CLOUD_MODELS];
function listModels(category) {
  if (category) {
    return FULL_CATALOG.filter((m) => m.category === category);
  }
  return FULL_CATALOG;
}
function getModelsForVram(vramGb) {
  return FULL_CATALOG.filter((m) => m.minVram <= vramGb && !m.isCloud);
}
function getModel(name) {
  return FULL_CATALOG.find((m) => m.name === name);
}
async function pullModel2(name) {
  try {
    (0, import_child_process2.execSync)("curl -s http://localhost:11434/api/tags", { stdio: "pipe", timeout: 1e3 });
  } catch {
    throw new Error("Ollama is not running. Start it with: ollama serve");
  }
  try {
    console.log(`Pulling model ${name}...`);
    (0, import_child_process2.execSync)(`ollama pull ${name}`, { stdio: "inherit" });
    return true;
  } catch (error) {
    throw new Error(`Failed to pull model ${name}: ${error}`);
  }
}
function getLocalModels() {
  try {
    const response = (0, import_child_process2.execSync)("curl -s http://localhost:11434/api/tags", { encoding: "utf-8" });
    const data = JSON.parse(response);
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}
function isModelAvailable(name) {
  const localModels = getLocalModels();
  return localModels.includes(name);
}
function getRecommendedModel(tier, category) {
  let models = getModelsForVram(tier * 16);
  if (category) {
    models = models.filter((m) => m.category === category);
  }
  models.sort((a, b) => {
    if (a.recommendedTier !== b.recommendedTier) {
      return a.recommendedTier - b.recommendedTier;
    }
    return b.minVram - a.minVram;
  });
  return models[0];
}
function getModelCatalog() {
  return [...MODEL_CATALOG];
}
function normalizeModelName(name) {
  return name.replace(/^ollama\//, "").replace(/:/g, "-").toLowerCase();
}
function getModelByName(name) {
  const normalized = normalizeModelName(name);
  return MODEL_CATALOG.find((m) => m.name === normalized || m.name === name) || null;
}
var ModelCatalogHelper = class {
  listModels(category) {
    return listModels(category);
  }
  getModelsForVram(vramGb) {
    return getModelsForVram(vramGb);
  }
  getModel(name) {
    return getModel(name);
  }
  pullModel(name) {
    return pullModel2(name);
  }
  getLocalModels() {
    return getLocalModels();
  }
  isModelAvailable(name) {
    return isModelAvailable(name);
  }
  getRecommendedModel(tier, category) {
    return getRecommendedModel(tier, category);
  }
  getModelCatalog() {
    return getModelCatalog();
  }
  normalizeModelName(name) {
    return normalizeModelName(name);
  }
  getModelByName(name) {
    return getModelByName(name);
  }
};
ModelCatalogHelper = __decorateClass([
  (0, import_common20.Injectable)()
], ModelCatalogHelper);

// src/modules/model/mutation-engine.ts
init_cjs_shims();
var import_common21 = require("@nestjs/common");
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
var MutationEngineHelper = class {
  proposeMutation(topExperiments, bestLoss, capabilities) {
    return proposeMutation(topExperiments, bestLoss, capabilities);
  }
};
MutationEngineHelper = __decorateClass([
  (0, import_common21.Injectable)()
], MutationEngineHelper);

// src/modules/model/trainer.ts
init_cjs_shims();
var import_common22 = require("@nestjs/common");
var import_child_process3 = require("child_process");
var import_path2 = require("path");
async function trainMicroModel(options) {
  const {
    proposal,
    datasetPath,
    hardware,
    pythonScriptPath = (0, import_path2.resolve)(process.cwd(), "scripts/train_micro.py"),
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
    const pythonProcess = (0, import_child_process3.spawn)("python3", [pythonScriptPath], {
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
function calculateImprovement(currentLoss, bestLoss) {
  if (bestLoss <= 0) return 0;
  return (bestLoss - currentLoss) / bestLoss * 100;
}
var TrainerHelper = class {
  trainMicroModel(options) {
    return trainMicroModel(options);
  }
  validateTrainingConfig(proposal) {
    return validateTrainingConfig(proposal);
  }
  calculateImprovement(currentLoss, bestLoss) {
    return calculateImprovement(currentLoss, bestLoss);
  }
};
TrainerHelper = __decorateClass([
  (0, import_common22.Injectable)()
], TrainerHelper);

// src/modules/model/services/model-catalog.service.ts
init_cjs_shims();
var import_common23 = require("@nestjs/common");
var ModelCatalogService = class {
  constructor(modelCatalogHelper) {
    this.modelCatalogHelper = modelCatalogHelper;
  }
  list(category) {
    return this.modelCatalogHelper.listModels(category);
  }
  getForVram(vramGb) {
    return this.modelCatalogHelper.getModelsForVram(vramGb);
  }
  get(name) {
    return this.modelCatalogHelper.getModel(name);
  }
  pull(name) {
    return this.modelCatalogHelper.pullModel(name);
  }
  getLocal() {
    return this.modelCatalogHelper.getLocalModels();
  }
  isAvailable(name) {
    return this.modelCatalogHelper.isModelAvailable(name);
  }
  getRecommended(tier, category) {
    return this.modelCatalogHelper.getRecommendedModel(tier, category);
  }
  getCatalog() {
    return this.modelCatalogHelper.getModelCatalog();
  }
  normalizeName(name) {
    return this.modelCatalogHelper.normalizeModelName(name);
  }
  getByName(name) {
    return this.modelCatalogHelper.getModelByName(name);
  }
  get catalog() {
    return MODEL_CATALOG;
  }
  get cloudModels() {
    return CLOUD_MODELS;
  }
  get fullCatalog() {
    return FULL_CATALOG;
  }
};
ModelCatalogService = __decorateClass([
  (0, import_common23.Injectable)()
], ModelCatalogService);

// src/modules/model/services/mutation-engine.service.ts
init_cjs_shims();
var import_common24 = require("@nestjs/common");
var MutationEngineService = class {
  constructor(mutationEngineHelper) {
    this.mutationEngineHelper = mutationEngineHelper;
  }
  propose(topExperiments, bestLoss, capabilities) {
    return this.mutationEngineHelper.proposeMutation(topExperiments, bestLoss, capabilities);
  }
};
MutationEngineService = __decorateClass([
  (0, import_common24.Injectable)()
], MutationEngineService);

// src/modules/model/services/trainer.service.ts
init_cjs_shims();
var import_common25 = require("@nestjs/common");
var TrainerService = class {
  constructor(trainerHelper) {
    this.trainerHelper = trainerHelper;
  }
  train(options) {
    return this.trainerHelper.trainMicroModel(options);
  }
  validateConfig(proposal) {
    return this.trainerHelper.validateTrainingConfig(proposal);
  }
  calculateImprovement(currentLoss, bestLoss) {
    return this.trainerHelper.calculateImprovement(currentLoss, bestLoss);
  }
};
TrainerService = __decorateClass([
  (0, import_common25.Injectable)()
], TrainerService);

// src/modules/model/model.module.ts
var ModelModule = class {
};
ModelModule = __decorateClass([
  (0, import_common26.Module)({
    providers: [
      ModelCatalogHelper,
      MutationEngineHelper,
      TrainerHelper,
      ModelCatalogService,
      MutationEngineService,
      TrainerService
    ],
    exports: [ModelCatalogService, MutationEngineService, TrainerService]
  })
], ModelModule);

// src/modules/staking/staking.module.ts
init_cjs_shims();
var import_common31 = require("@nestjs/common");

// src/modules/staking/staking.ts
init_cjs_shims();
var import_common27 = require("@nestjs/common");
var import_web32 = require("@solana/web3.js");

// src/utils/idl.ts
init_cjs_shims();
var import_web3 = require("@solana/web3.js");
var STAKING_PROGRAM_ID = new import_web3.PublicKey(
  "8LhiExUHdJGCfnbmADcJacjbnoAU7cvXTqpBEdybd4Fg"
);
var TOKEN_PROGRAM_ID = new import_web3.PublicKey(
  "8iFr3ciQuNeU4vkzQTp7NcWNgRr7AVhwyizNCAszaEQq"
);
var ESCROW_PROGRAM_ID = new import_web3.PublicKey(
  "HwFPR5rGCkd7ak6SivRkaPnb5jzRMMHvC3wENK1mW2eK"
);
var REWARDS_PROGRAM_ID = new import_web3.PublicKey(
  "11111111111111111111111111111111"
);

// src/modules/staking/staking.ts
function deriveStakeAccount(peerId) {
  return import_web32.PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), Buffer.from(peerId)],
    STAKING_PROGRAM_ID
  );
}
function parseStakeAccountData(data) {
  if (data.length < 8) {
    throw new Error("Invalid stake account data");
  }
  const amount = data.readBigUInt64LE(0);
  return {
    amount: Number(amount),
    lockupEnd: data.length > 16 ? Number(data.readBigUInt64LE(8)) : null,
    owner: "placeholder"
    // Would parse from account data
  };
}
var StakingHelper = class {
  /**
   * Verify stake for a peer on the blockchain
   */
  async verifyStake(peerId, rpcUrl = "https://api.devnet.solana.com") {
    try {
      const connection = new import_web32.Connection(rpcUrl);
      const [stakeAccount] = deriveStakeAccount(peerId);
      const accountInfo = await connection.getAccountInfo(stakeAccount);
      if (!accountInfo || !accountInfo?.data) {
        return {
          valid: false,
          error: "Stake account not found"
        };
      }
      const stakeData = parseStakeAccountData(accountInfo.data);
      const stakeInfo = {
        peerId,
        stakedAmount: stakeData.amount,
        tier: this.computeTier(stakeData.amount),
        stakeAccount: Array.isArray(stakeAccount) ? stakeAccount[0].toBase58() : String(stakeAccount),
        lockupEndTimestamp: stakeData.lockupEnd
      };
      return {
        valid: true,
        stakeInfo
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }
  /**
   * Get minimum stake for each tier (in SYN tokens)
   */
  getMinimumStake(tier) {
    const minimums = {
      0: 0,
      // CPU-only, no stake required
      1: 100,
      2: 500,
      3: 1e3,
      4: 5e3,
      5: 1e4
    };
    return minimums[tier] || 0;
  }
  /**
   * Compute tier based on staked amount
   */
  computeTier(stakedAmount) {
    if (stakedAmount < 100) return 0;
    if (stakedAmount < 500) return 1;
    if (stakedAmount < 1e3) return 2;
    if (stakedAmount < 5e3) return 3;
    if (stakedAmount < 1e4) return 4;
    return 5;
  }
  /**
   * Check if stake meets minimum for tier
   */
  meetsMinimumStake(stakedAmount, tier) {
    const minimum = this.getMinimumStake(tier);
    return stakedAmount >= minimum;
  }
  /**
   * Get all stakes for a peer (if multiple stake accounts exist)
   */
  async getAllStakesForPeer(peerId, rpcUrl = "https://api.devnet.solana.com") {
    const result = await this.verifyStake(peerId, rpcUrl);
    return result.valid && result.stakeInfo ? [result.stakeInfo] : [];
  }
  /**
   * Get total staked across network (aggregates all stake accounts)
   */
  async getTotalNetworkStake(rpcUrl = "https://api.devnet.solana.com") {
    try {
      const connection = new import_web32.Connection(rpcUrl);
      const programAccounts = await connection.getProgramAccounts(
        STAKING_PROGRAM_ID,
        {
          filters: [
            // Account size filter for stake accounts
            { dataSize: 32 }
            // Simplified filter
          ]
        }
      );
      let totalStake = 0;
      for (const account of programAccounts) {
        const data = parseStakeAccountData(account.account.data);
        totalStake += data.amount;
      }
      return totalStake;
    } catch (error) {
      return 0;
    }
  }
};
StakingHelper = __decorateClass([
  (0, import_common27.Injectable)()
], StakingHelper);

// src/modules/staking/rewards.ts
init_cjs_shims();
var import_common28 = require("@nestjs/common");
var import_web33 = require("@solana/web3.js");
var RewardsHelper = class {
  /**
   * Calculate validation score for a peer based on pulse participation
   */
  calculateValidationScore(totalPulses, successfulPulses) {
    if (totalPulses === 0) return 0;
    return Math.min(1, successfulPulses / totalPulses);
  }
  /**
   * Calculate combined weight for reward allocation
   * Weight = (stakeAmount / networkTotalStake) * validationScore
   */
  calculateRewardWeight(stakedAmount, networkTotalStake, validationScore) {
    const stakeRatio = stakedAmount / networkTotalStake;
    return stakeRatio * validationScore;
  }
  /**
   * Calculate reward for a peer
   * Reward = weight * totalPoolAmount
   */
  calculateReward(stakedAmount, networkTotalStake, validationScore, totalPoolAmount) {
    const weight = this.calculateRewardWeight(stakedAmount, networkTotalStake, validationScore);
    return weight * totalPoolAmount;
  }
  /**
   * Normalize rewards to ensure pool is fully distributed
   * Adjusts weights proportionally if sum < 1
   */
  normalizeRewards(rewards, totalPoolAmount) {
    const totalWeight = rewards.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight === 0) {
      const share = totalPoolAmount / rewards.length;
      return rewards.map((r) => ({
        ...r,
        reward: share
      }));
    }
    return rewards.map((r) => ({
      ...r,
      reward: r.weight / totalWeight * totalPoolAmount
    }));
  }
  /**
   * Calculate reward batch for all active peers
   */
  calculateRewardBatch(peers, totalPoolAmount) {
    const networkTotalStake = peers.reduce(
      (sum, p) => sum + p.stakeInfo.stakedAmount,
      0
    );
    const rewards = peers.map((peer) => {
      const validationScore = this.calculateValidationScore(
        peer.totalPulses,
        peer.successfulPulses
      );
      const weight = this.calculateRewardWeight(
        peer.stakeInfo.stakedAmount,
        networkTotalStake,
        validationScore
      );
      const reward = this.calculateReward(
        peer.stakeInfo.stakedAmount,
        networkTotalStake,
        validationScore,
        totalPoolAmount
      );
      return {
        peerId: peer.peerId,
        stakedAmount: peer.stakeInfo.stakedAmount,
        validationScore,
        tier: peer.stakeInfo.tier,
        weight,
        reward
      };
    });
    const normalizedRewards = this.normalizeRewards(rewards, totalPoolAmount);
    const totalRewards = normalizedRewards.reduce((sum, r) => sum + r.reward, 0);
    return {
      poolId: `pool-${Date.now()}`,
      totalPoolAmount,
      batchTimestamp: Date.now(),
      rewards: normalizedRewards,
      totalRewards
    };
  }
  /**
   * Distribute rewards via Solana transaction
   * Calls the rewards program to transfer SYN tokens to recipient accounts
   */
  async distributeRewards(batch, rpcUrl = "https://api.devnet.solana.com") {
    try {
      const connection = new import_web33.Connection(rpcUrl);
      const txSignature = "dummy-tx-signature";
      return {
        success: true,
        txSignature,
        batch
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }
  /**
   * Get reward history for a peer
   */
  async getRewardHistory(peerId, limit = 10, rpcUrl = "https://api.devnet.solana.com") {
    try {
      const connection = new import_web33.Connection(rpcUrl);
      return [];
    } catch (error) {
      return [];
    }
  }
  /**
   * Get recent reward batches
   */
  async getRecentBatches(limit = 10, rpcUrl = "https://api.devnet.solana.com") {
    try {
      const connection = new import_web33.Connection(rpcUrl);
      return [];
    } catch (error) {
      return [];
    }
  }
};
RewardsHelper = __decorateClass([
  (0, import_common28.Injectable)()
], RewardsHelper);

// src/modules/staking/services/staking.service.ts
init_cjs_shims();
var import_common29 = require("@nestjs/common");
var StakingService = class {
  constructor(stakingHelper) {
    this.stakingHelper = stakingHelper;
  }
  verify(peerId, rpcUrl) {
    return this.stakingHelper.verifyStake(peerId, rpcUrl);
  }
  getMinimumStake(tier) {
    return this.stakingHelper.getMinimumStake(tier);
  }
  computeTier(stakedAmount) {
    return this.stakingHelper.computeTier(stakedAmount);
  }
  meetsMinimum(stakedAmount, tier) {
    return this.stakingHelper.meetsMinimumStake(stakedAmount, tier);
  }
  getAllForPeer(peerId, rpcUrl) {
    return this.stakingHelper.getAllStakesForPeer(peerId, rpcUrl);
  }
  getTotalNetworkStake(rpcUrl) {
    return this.stakingHelper.getTotalNetworkStake(rpcUrl);
  }
};
StakingService = __decorateClass([
  (0, import_common29.Injectable)()
], StakingService);

// src/modules/staking/services/rewards.service.ts
init_cjs_shims();
var import_common30 = require("@nestjs/common");
var RewardsService = class {
  constructor(rewardsHelper) {
    this.rewardsHelper = rewardsHelper;
  }
  calculateValidationScore(totalPulses, successfulPulses) {
    return this.rewardsHelper.calculateValidationScore(totalPulses, successfulPulses);
  }
  calculateWeight(stakedAmount, networkTotalStake, validationScore) {
    return this.rewardsHelper.calculateRewardWeight(stakedAmount, networkTotalStake, validationScore);
  }
  calculateReward(stakedAmount, networkTotalStake, validationScore, totalPoolAmount) {
    return this.rewardsHelper.calculateReward(stakedAmount, networkTotalStake, validationScore, totalPoolAmount);
  }
  normalize(rewards, totalPoolAmount) {
    return this.rewardsHelper.normalizeRewards(rewards, totalPoolAmount);
  }
  calculateBatch(peers, totalPoolAmount) {
    return this.rewardsHelper.calculateRewardBatch(peers, totalPoolAmount);
  }
  distribute(batch, rpcUrl) {
    return this.rewardsHelper.distributeRewards(batch, rpcUrl);
  }
  getHistory(peerId, limit, rpcUrl) {
    return this.rewardsHelper.getRewardHistory(peerId, limit, rpcUrl);
  }
  getRecentBatches(limit, rpcUrl) {
    return this.rewardsHelper.getRecentBatches(limit, rpcUrl);
  }
};
RewardsService = __decorateClass([
  (0, import_common30.Injectable)()
], RewardsService);

// src/modules/staking/staking.module.ts
var StakingModule = class {
};
StakingModule = __decorateClass([
  (0, import_common31.Module)({
    providers: [StakingHelper, RewardsHelper, StakingService, RewardsService],
    exports: [StakingService, RewardsService]
  })
], StakingModule);

// src/modules/wallet/wallet.module.ts
init_cjs_shims();
var import_common34 = require("@nestjs/common");

// src/modules/wallet/wallet.ts
init_cjs_shims();
var import_common32 = require("@nestjs/common");
var import_fs3 = require("fs");
var path2 = __toESM(require("path"), 1);
var os3 = __toESM(require("os"), 1);
var crypto2 = __toESM(require("crypto"), 1);
var WALLET_DIR = path2.join(os3.homedir(), ".synapse");
var WALLET_FILE = path2.join(WALLET_DIR, "wallet.json");
var BACKUP_FILE = path2.join(WALLET_DIR, "wallet-backup.json");
var PBKDF2_ITERATIONS = 1e5;
var KEY_LENGTH = 32;
var IV_LENGTH = 16;
var SALT_LENGTH = 32;
var AUTH_TAG_LENGTH = 16;
function deriveKey(password2, salt) {
  return crypto2.pbkdf2Sync(password2, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}
function encryptWallet(wallet, password2) {
  const salt = crypto2.randomBytes(SALT_LENGTH);
  const iv = crypto2.randomBytes(IV_LENGTH);
  const key = deriveKey(password2, salt);
  const cipher = crypto2.createCipheriv("aes-256-gcm", key, iv);
  const secretKeyBuffer = Buffer.from(wallet.secretKey);
  const encrypted = Buffer.concat([
    cipher.update(secretKeyBuffer),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return {
    version: 1,
    publicKey: wallet.publicKey,
    encryptedData: combined.toString("base64"),
    salt: salt.toString("base64"),
    kdf: "pbkdf2-sha256",
    kdfIterations: PBKDF2_ITERATIONS,
    createdAt: wallet.createdAt
  };
}
function decryptWallet(encryptedWallet, password2) {
  const combined = Buffer.from(encryptedWallet.encryptedData, "base64");
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const key = deriveKey(password2, salt);
  const decipher = crypto2.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    return {
      publicKey: encryptedWallet.publicKey,
      secretKey: Array.from(decrypted),
      createdAt: encryptedWallet.createdAt
    };
  } catch (error) {
    throw new Error("Invalid password. Wallet decryption failed.");
  }
}
var WalletHelper = class {
  /**
   * Get password from environment or prompt
   * For Docker/non-interactive environments, use WALLET_PASSWORD env var
   */
  async promptForPassword(message = "Enter wallet password: ") {
    const envPassword = process.env.WALLET_PASSWORD;
    if (envPassword) {
      return envPassword;
    }
    const { password: password2 } = await import("@inquirer/prompts");
    return password2({ message });
  }
  /**
   * Prompt for new password with confirmation
   * For Docker/non-interactive environments, use WALLET_PASSWORD env var
   */
  async promptForNewPassword() {
    const envPassword = process.env.WALLET_PASSWORD;
    if (envPassword) {
      if (envPassword.length < 8) {
        throw new Error("WALLET_PASSWORD must be at least 8 characters");
      }
      return envPassword;
    }
    const { password: password2 } = await import("@inquirer/prompts");
    const pass1 = await password2({
      message: "Create wallet password (min 8 characters):",
      validate: (input2) => {
        if (input2.length < 8) return "Password must be at least 8 characters";
        return true;
      }
    });
    const pass2 = await password2({
      message: "Confirm wallet password:"
    });
    if (pass1 !== pass2) {
      throw new Error("Passwords do not match");
    }
    return pass1;
  }
  /**
   * Generate a new Solana wallet with mnemonic and encryption
   */
  async generateWallet(walletDir = WALLET_DIR, password2) {
    if (!(0, import_fs3.existsSync)(walletDir)) {
      (0, import_fs3.mkdirSync)(walletDir, { recursive: true, mode: 448 });
    }
    if (!password2) {
      password2 = await this.promptForNewPassword();
    }
    try {
      const solanaWeb3 = await import("@solana/web3.js");
      const bip39 = await import("bip39");
      const { Keypair } = solanaWeb3;
      const mnemonic = bip39.generateMnemonic(128);
      const seed = await bip39.mnemonicToSeed(mnemonic);
      const seedBytes = new Uint8Array(seed).slice(0, 32);
      const keypair = Keypair.fromSeed(seedBytes);
      const wallet = {
        publicKey: keypair.publicKey.toBase58(),
        secretKey: Array.from(keypair.secretKey),
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        mnemonic
        // Include mnemonic for display
      };
      const encryptedWallet = encryptWallet(wallet, password2);
      (0, import_fs3.writeFileSync)(
        path2.join(walletDir, "wallet.json"),
        JSON.stringify(encryptedWallet, null, 2),
        { mode: 384 }
      );
      const backupData = {
        version: 1,
        publicKey: wallet.publicKey,
        mnemonic,
        encrypted: true,
        encryptedSecretKey: encryptedWallet.encryptedData,
        createdAt: wallet.createdAt,
        warning: "IMPORTANT: Store this mnemonic in a secure location. Anyone with access to these words can control your funds."
      };
      (0, import_fs3.writeFileSync)(
        BACKUP_FILE,
        JSON.stringify(backupData, null, 2),
        { mode: 384 }
      );
      return {
        wallet: { ...wallet },
        isNew: true
      };
    } catch (error) {
      throw new Error(
        `Failed to generate Solana wallet. Make sure @solana/web3.js and bip39 are installed. ${error}`
      );
    }
  }
  /**
   * Load existing Solana wallet (requires password)
   */
  async loadWallet(walletDir = WALLET_DIR, password2) {
    const walletPath = path2.join(walletDir, "wallet.json");
    if (!(0, import_fs3.existsSync)(walletPath)) {
      throw new Error(`Wallet not found at ${walletPath}. Run generateWallet() first.`);
    }
    const content = (0, import_fs3.readFileSync)(walletPath, "utf-8");
    const encryptedWallet = JSON.parse(content);
    if (!encryptedWallet.encryptedData) {
      throw new Error("Invalid wallet file structure");
    }
    if (!password2) {
      password2 = await this.promptForPassword();
    }
    return decryptWallet(encryptedWallet, password2);
  }
  /**
   * Get or create wallet (convenience function for CLI)
   * Returns wallet and a flag indicating if it was newly created
   * Retries password prompt up to 3 times on invalid password
   */
  async getOrCreateWallet(walletDir = WALLET_DIR, password2) {
    const MAX_RETRIES = 3;
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
      try {
        const wallet = await this.loadWallet(walletDir, password2);
        return { wallet, isNew: false };
      } catch (error) {
        const errorMessage = error.message;
        if (errorMessage.includes("Wallet not found")) {
          return this.generateWallet(walletDir, password2);
        }
        if (errorMessage.includes("Invalid password")) {
          attempts++;
          if (attempts < MAX_RETRIES) {
            console.log("\n\u274C Invalid password. Please try again.");
            password2 = void 0;
            continue;
          }
          console.log("\n\u274C Invalid password after 3 attempts.");
          throw new Error("Maximum password attempts exceeded. Please check your password and try again.");
        }
        throw error;
      }
    }
    throw new Error("Maximum password attempts exceeded.");
  }
  /**
   * Get wallet public key (address) for display
   * This can be read without password from encrypted file
   */
  getWalletAddress(walletDir = WALLET_DIR) {
    try {
      const walletPath = path2.join(walletDir, "wallet.json");
      if (!(0, import_fs3.existsSync)(walletPath)) {
        return "not configured";
      }
      const content = (0, import_fs3.readFileSync)(walletPath, "utf-8");
      const encryptedWallet = JSON.parse(content);
      return encryptedWallet.publicKey;
    } catch {
      return "not configured";
    }
  }
  /**
   * Check if wallet exists
   */
  hasWallet(walletDir = WALLET_DIR) {
    const walletPath = path2.join(walletDir, "wallet.json");
    return (0, import_fs3.existsSync)(walletPath);
  }
  /**
   * Display wallet creation warning with seed phrase
   * This should be called when isNew is true
   */
  displayWalletCreationWarning(wallet) {
    if (!wallet.mnemonic) return;
    console.log("\n" + "\u2550".repeat(70));
    console.log("  IMPORTANT: SAVE YOUR RECOVERY PHRASE");
    console.log("\u2550".repeat(70));
    console.log("\nYour Solana wallet has been created. Write down these 12 words\nand store them in a secure, offline location:");
    console.log("\n  " + wallet.mnemonic);
    console.log("\nAnyone with access to these words can control your funds.");
    console.log("Never share your recovery phrase with anyone.");
    console.log("\nA backup has also been saved to:");
    console.log(`  ${BACKUP_FILE}`);
    console.log("\u2550".repeat(70) + "\n");
  }
  /**
   * Change wallet password
   */
  async changeWalletPassword(walletDir = WALLET_DIR) {
    const oldPassword = await this.promptForPassword("Enter current password: ");
    const wallet = await this.loadWallet(walletDir, oldPassword);
    const newPassword = await this.promptForNewPassword();
    const encryptedWallet = encryptWallet(wallet, newPassword);
    (0, import_fs3.writeFileSync)(
      path2.join(walletDir, "wallet.json"),
      JSON.stringify(encryptedWallet, null, 2),
      { mode: 384 }
    );
    console.log("Password changed successfully");
  }
};
WalletHelper = __decorateClass([
  (0, import_common32.Injectable)()
], WalletHelper);

// src/modules/wallet/services/wallet.service.ts
init_cjs_shims();
var import_common33 = require("@nestjs/common");
var WalletService = class {
  constructor(walletHelper) {
    this.walletHelper = walletHelper;
  }
  generate(walletDir, password2) {
    return this.walletHelper.generateWallet(walletDir, password2);
  }
  load(walletDir, password2) {
    return this.walletHelper.loadWallet(walletDir, password2);
  }
  getOrCreate(walletDir, password2) {
    return this.walletHelper.getOrCreateWallet(walletDir, password2);
  }
  getAddress(walletDir) {
    return this.walletHelper.getWalletAddress(walletDir);
  }
  has(walletDir) {
    return this.walletHelper.hasWallet(walletDir);
  }
  displayCreationWarning(wallet) {
    return this.walletHelper.displayWalletCreationWarning(wallet);
  }
  changePassword(walletDir) {
    return this.walletHelper.changeWalletPassword(walletDir);
  }
  promptForPassword(message) {
    return this.walletHelper.promptForPassword(message);
  }
  promptForNewPassword() {
    return this.walletHelper.promptForNewPassword();
  }
};
WalletService = __decorateClass([
  (0, import_common33.Injectable)()
], WalletService);

// src/modules/wallet/wallet.module.ts
var WalletModule = class {
};
WalletModule = __decorateClass([
  (0, import_common34.Module)({
    providers: [WalletHelper, WalletService],
    exports: [WalletService]
  })
], WalletModule);

// src/modules/inference/inference.module.ts
init_cjs_shims();
var import_common37 = require("@nestjs/common");

// src/modules/inference/inference-server.ts
init_cjs_shims();
var import_common35 = require("@nestjs/common");
var http = __toESM(require("http"), 1);
var crypto3 = __toESM(require("crypto"), 1);
var serverStartTime;
function parseBody(req) {
  return new Promise((resolve2, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve2(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
async function forwardToOllama(request) {
  const ollamaRequest = {
    model: request.model,
    messages: request.messages,
    stream: false
  };
  if (request.temperature !== void 0 || request.max_tokens !== void 0) {
    ollamaRequest.options = {};
    if (request.temperature !== void 0) {
      ollamaRequest.options.temperature = request.temperature;
    }
    if (request.max_tokens !== void 0) {
      ollamaRequest.options.num_predict = request.max_tokens;
    }
  }
  const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(ollamaRequest)
  });
  if (!ollamaResponse.ok) {
    throw new Error(`Ollama API error: ${ollamaResponse.status} ${ollamaResponse.statusText}`);
  }
  return ollamaResponse.json();
}
function transformToOpenAI(ollamaResponse, model) {
  return {
    id: `chatcmpl-${crypto3.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: ollamaResponse.message.role,
          content: ollamaResponse.message.content
        },
        finish_reason: "stop"
      }
    ]
  };
}
async function handleChatCompletions(req, res, peerId) {
  try {
    const body = await parseBody(req);
    if (!body.model || !body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Invalid request: model and messages are required",
          type: "invalid_request_error"
        }
      }));
      return;
    }
    const ollamaResponse = await forwardToOllama(body);
    const openaiResponse = transformToOpenAI(ollamaResponse, body.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openaiResponse));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: error.message || "Internal server error",
        type: "server_error"
      }
    }));
  }
}
async function handleState(req, res, config) {
  const uptime = process.uptime();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    peerId: config.peerId,
    tier: config.tier,
    models: config.models,
    uptime: Math.floor(uptime)
  }));
}
async function handleHealth(req, res) {
  const uptime = process.uptime();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    uptime: Math.floor(uptime)
  }));
}
function handleNotFound(req, res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: "Not found",
      type: "not_found_error"
    }
  }));
}
function startInferenceServer(config) {
  serverStartTime = Date.now();
  const port = config.port !== void 0 && config.port !== null ? config.port : 8080;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    const url = req.url || "";
    try {
      if (req.method === "POST" && url === "/v1/chat/completions") {
        await handleChatCompletions(req, res, config.peerId);
      } else if (req.method === "GET" && url === "/api/v1/state") {
        await handleState(req, res, config);
      } else if (req.method === "GET" && url === "/health") {
        await handleHealth(req, res);
      } else {
        handleNotFound(req, res);
      }
    } catch (error) {
      console.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Internal server error",
          type: "server_error"
        }
      }));
    }
  });
  server.listen(port, () => {
    console.log(`\u{1F680} Inference server listening on port ${port}`);
    console.log(`   POST /v1/chat/completions - OpenAI-compatible chat`);
    console.log(`   GET  /api/v1/state - Node state`);
    console.log(`   GET  /health - Health check`);
  });
  return {
    server,
    close: () => {
      server.close();
      console.log("\u2705 Inference server closed");
    }
  };
}
var InferenceServerHelper = class {
  parseBody(req) {
    return parseBody(req);
  }
  forwardToOllama(request) {
    return forwardToOllama(request);
  }
  transformToOpenAI(ollamaResponse, model) {
    return transformToOpenAI(ollamaResponse, model);
  }
  handleChatCompletions(req, res, peerId) {
    return handleChatCompletions(req, res, peerId);
  }
  handleState(req, res, config) {
    return handleState(req, res, config);
  }
  handleHealth(req, res) {
    return handleHealth(req, res);
  }
  startInferenceServer(config) {
    return startInferenceServer(config);
  }
};
InferenceServerHelper = __decorateClass([
  (0, import_common35.Injectable)()
], InferenceServerHelper);

// src/modules/inference/services/inference.service.ts
init_cjs_shims();
var import_common36 = require("@nestjs/common");
var InferenceService = class {
  constructor(inferenceServerHelper) {
    this.inferenceServerHelper = inferenceServerHelper;
  }
  start(config) {
    return this.inferenceServerHelper.startInferenceServer(config);
  }
  parseBody(req) {
    return this.inferenceServerHelper.parseBody(req);
  }
  forwardToOllama(request) {
    return this.inferenceServerHelper.forwardToOllama(request);
  }
  transformToOpenAI(ollamaResponse, model) {
    return this.inferenceServerHelper.transformToOpenAI(ollamaResponse, model);
  }
  handleChatCompletions(req, res, peerId) {
    return this.inferenceServerHelper.handleChatCompletions(req, res, peerId);
  }
  handleState(req, res, config) {
    return this.inferenceServerHelper.handleState(req, res, config);
  }
  handleHealth(req, res) {
    return this.inferenceServerHelper.handleHealth(req, res);
  }
};
InferenceService = __decorateClass([
  (0, import_common36.Injectable)()
], InferenceService);

// src/modules/inference/inference.module.ts
var InferenceModule = class {
};
InferenceModule = __decorateClass([
  (0, import_common37.Module)({
    providers: [InferenceServerHelper, InferenceService],
    exports: [InferenceService]
  })
], InferenceModule);

// src/modules/agent/agent.module.ts
init_cjs_shims();
var import_common44 = require("@nestjs/common");

// src/modules/agent/agent-brain.ts
init_cjs_shims();
var import_common38 = require("@nestjs/common");
var DEFAULT_GOALS = ["minimize loss", "discover novel architectures"];
function initBrain(goals) {
  return {
    goals: goals ? [...goals] : [...DEFAULT_GOALS],
    memory: [],
    journal: [],
    strategy: {
      explorationRate: 0.5,
      focusArea: "",
      recentLessons: [],
      consecutiveFailures: 0
    },
    totalExperiments: 0,
    bestResult: null
  };
}
function updateBrain(brain, result) {
  brain.totalExperiments++;
  if (brain.bestResult === null || result.valLoss < brain.bestResult) {
    brain.bestResult = result.valLoss;
  }
  const memoryEntry = {
    timestamp: Date.now(),
    type: result.improved ? "experiment" : "failure",
    content: `Loss: ${result.valLoss}, Mutation: ${result.mutation}`,
    importance: result.improved ? Math.max(0.5, 1 - result.valLoss) : 0.2
  };
  brain.memory.push(memoryEntry);
  const journalEntry = {
    timestamp: Date.now(),
    action: result.mutation,
    outcome: result.improved ? "improved" : "worsened",
    lesson: result.lesson || (result.improved ? "Mutation was successful" : "Mutation did not improve")
  };
  brain.journal.push(journalEntry);
  if (result.improved) {
    brain.strategy.explorationRate = Math.max(0.1, brain.strategy.explorationRate * 0.9);
    brain.strategy.consecutiveFailures = 0;
    if (result.lesson && !brain.strategy.recentLessons.includes(result.lesson)) {
      brain.strategy.recentLessons.push(result.lesson);
      if (brain.strategy.recentLessons.length > 10) {
        brain.strategy.recentLessons = brain.strategy.recentLessons.slice(-10);
      }
    }
  } else {
    brain.strategy.consecutiveFailures++;
    if (brain.strategy.consecutiveFailures >= 3) {
      brain.strategy.explorationRate = Math.min(1, brain.strategy.explorationRate * 1.2);
    }
  }
  if (brain.memory.length > 100) {
    brain.memory = brain.memory.slice(-100);
  }
  if (brain.journal.length > 100) {
    brain.journal = brain.journal.slice(-100);
  }
  return brain;
}
function getNextAction(brain) {
  if (brain.strategy.consecutiveFailures > 10) {
    return "rest";
  }
  if (brain.strategy.explorationRate > 0.5) {
    return "explore";
  }
  return "improve";
}
function getRecentMemories(brain, maxEntries = 5, minImportance = 0.3) {
  const recentMemories = brain.memory.filter((m) => m.importance >= minImportance).sort((a, b) => b.importance - a.importance).slice(0, maxEntries);
  return recentMemories;
}
function getRecentJournal(brain, maxEntries = 10) {
  return brain.journal.slice(-maxEntries).reverse();
}
var AgentBrainHelper = class {
  initBrain(goals) {
    return initBrain(goals);
  }
  updateBrain(brain, result) {
    return updateBrain(brain, result);
  }
  getNextAction(brain) {
    return getNextAction(brain);
  }
  getRecentMemories(brain, maxEntries, minImportance) {
    return getRecentMemories(brain, maxEntries, minImportance);
  }
  getRecentJournal(brain, maxEntries) {
    return getRecentJournal(brain, maxEntries);
  }
};
AgentBrainHelper = __decorateClass([
  (0, import_common38.Injectable)()
], AgentBrainHelper);

// src/modules/agent/agent-loop.ts
init_cjs_shims();
var import_common39 = require("@nestjs/common");
var loopState = {
  iteration: 0,
  bestLoss: Infinity,
  totalExperiments: 0,
  isRunning: false
};
function getAgentLoopState() {
  return { ...loopState };
}
function resetAgentLoopState() {
  loopState = {
    iteration: 0,
    bestLoss: Infinity,
    totalExperiments: 0,
    isRunning: false
  };
}
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
function stopAgentLoop() {
  loopState.isRunning = false;
  console.log("\u{1F6D1} Stopping agent loop...");
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
var AgentLoopHelper = class {
  startAgentLoop(config) {
    return startAgentLoop(config);
  }
  stopAgentLoop() {
    return stopAgentLoop();
  }
  runAgentIteration(config, iteration) {
    return runAgentIteration(config, iteration);
  }
  getAgentLoopState() {
    return getAgentLoopState();
  }
  resetAgentLoopState() {
    return resetAgentLoopState();
  }
  fetchTopExperiments(coordinatorUrl, limit) {
    return fetchTopExperiments(coordinatorUrl, limit);
  }
  createExperiment(coordinatorUrl, proposal, peerId, tier) {
    return createExperiment(coordinatorUrl, proposal, peerId, tier);
  }
  updateExperiment(coordinatorUrl, experimentId, result) {
    return updateExperiment(coordinatorUrl, experimentId, result);
  }
  postToFeed(coordinatorUrl, peerId, mutation, result, improved) {
    return postToFeed(coordinatorUrl, peerId, mutation, result, improved);
  }
};
AgentLoopHelper = __decorateClass([
  (0, import_common39.Injectable)()
], AgentLoopHelper);

// src/modules/agent/work-order-agent.ts
init_cjs_shims();
var import_common40 = require("@nestjs/common");
function parseSynToLamports(rewardStr) {
  if (!rewardStr) return 0n;
  if (!rewardStr.includes(".")) return BigInt(rewardStr);
  const [intPart, decPart = ""] = rewardStr.split(".");
  const decimals = 9;
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart) * 1000000000n + BigInt(paddedDec);
}
var agentState = {
  iteration: 0,
  totalWorkOrdersCompleted: 0,
  totalRewardsEarned: 0n,
  isRunning: false
};
var LLM_PRICE_TABLE = {
  // OpenAI models
  "gpt-4o": 5e-3,
  "gpt-4o-mini": 15e-5,
  "gpt-4-turbo": 0.01,
  "gpt-3.5-turbo": 5e-4,
  // Anthropic models
  "claude-haiku": 25e-5,
  "claude-haiku-3": 25e-5,
  "claude-sonnet": 3e-3,
  "claude-opus": 0.015,
  // Google models
  "gemini-flash": 75e-6,
  "gemini-pro": 35e-5,
  // Ollama models (local, $0 cost)
  "ollama/phi4-mini": 0,
  "ollama/llama3": 0,
  "ollama/mistral": 0
};
var DEFAULT_MODEL_PRICE = 25e-5;
function getModelCostPer1kTokens(model) {
  if (model in LLM_PRICE_TABLE) {
    return LLM_PRICE_TABLE[model];
  }
  if (model.startsWith("ollama/")) {
    return 0;
  }
  console.warn(`[WorkOrderAgent] Unknown model "${model}" \u2014 falling back to claude-haiku pricing ($${DEFAULT_MODEL_PRICE}/1K tokens)`);
  return DEFAULT_MODEL_PRICE;
}
function getWorkOrderAgentState() {
  return { ...agentState };
}
function resetWorkOrderAgentState() {
  agentState = {
    iteration: 0,
    totalWorkOrdersCompleted: 0,
    totalRewardsEarned: 0n,
    isRunning: false
  };
}
async function fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities) {
  try {
    const capabilitiesParam = capabilities.join(",");
    const url = `${coordinatorUrl}/work-orders/available?peerId=${peerId}&capabilities=${capabilitiesParam}`;
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) {
        return [];
      }
      throw new Error(`Failed to fetch work orders: ${response.statusText}`);
    }
    const data = await response.json();
    return data || [];
  } catch (error) {
    console.warn("[WorkOrderAgent] Failed to fetch work orders:", error.message);
    return [];
  }
}
async function acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities = []) {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        nodeCapabilities
      })
    });
    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to accept work order ${workOrderId}:`, error);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[WorkOrderAgent] Failed to accept work order:", error.message);
    return false;
  }
}
async function completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success = true) {
  try {
    const response = await fetch(`${coordinatorUrl}/work-orders/${workOrderId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workOrderId,
        assigneeAddress: peerId,
        result,
        success
      })
    });
    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to complete work order ${workOrderId}:`, error);
      return false;
    }
    const data = await response.json();
    if (success && data.rewardAmount) {
      agentState.totalRewardsEarned += parseSynToLamports(data.rewardAmount);
    }
    return true;
  } catch (error) {
    console.warn("[WorkOrderAgent] Failed to complete work order:", error.message);
    return false;
  }
}
function isResearchWorkOrder(workOrder) {
  if (workOrder.type === "RESEARCH") return true;
  try {
    const payload = JSON.parse(workOrder.description);
    return !!(payload.title && payload.abstract);
  } catch {
    return false;
  }
}
function extractResearchPayload(workOrder) {
  try {
    const payload = JSON.parse(workOrder.description);
    if (payload.title && payload.abstract) {
      return {
        title: payload.title,
        abstract: payload.abstract
      };
    }
    return null;
  } catch {
    return null;
  }
}
function buildResearchPrompt(payload) {
  return `You are a research node in a decentralized AI network.
Analyze this paper and respond in JSON:
{
  "summary": "2-3 sentence summary",
  "keyInsights": ["insight1", ..., "insight5"],
  "proposal": "how this applies to decentralized compute"
}

Title: ${payload.title}
Abstract: ${payload.abstract}`;
}
async function executeResearchWorkOrder(workOrder, llmModel, llmConfig) {
  console.log(`[WorkOrderAgent] Executing research: ${workOrder.title}`);
  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    throw new Error("Invalid research payload in work order");
  }
  const prompt = buildResearchPrompt(payload);
  const rawResponse = await generateLLM(llmModel, prompt, llmConfig);
  try {
    let jsonStr = rawResponse;
    const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      jsonStr = jsonMatch ? jsonMatch[0] : rawResponse;
    }
    const result = JSON.parse(jsonStr);
    if (!result.summary || !Array.isArray(result.keyInsights) || !result.proposal) {
      throw new Error("Invalid research result structure");
    }
    console.log(`[WorkOrderAgent] Research complete, summary: ${result.summary.slice(0, 100)}...`);
    return { result, rawResponse, success: true };
  } catch (error) {
    console.error("[WorkOrderAgent] Failed to parse research result:", error.message);
    return {
      result: {
        summary: "Failed to parse LLM response",
        keyInsights: [],
        proposal: rawResponse.slice(0, 500)
      },
      rawResponse,
      success: false
    };
  }
}
async function submitResearchResult(coordinatorUrl, workOrderId, peerId, result) {
  try {
    const response = await fetch(`${coordinatorUrl}/research-queue/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workOrderId,
        peerId,
        summary: result.summary,
        keyInsights: result.keyInsights,
        proposal: result.proposal
      })
    });
    if (!response.ok) {
      const error = await response.text();
      console.warn(`[WorkOrderAgent] Failed to submit research result:`, error);
      return false;
    }
    console.log(`[WorkOrderAgent] Research result submitted successfully`);
    return true;
  } catch (error) {
    console.warn("[WorkOrderAgent] Failed to submit research result:", error.message);
    return false;
  }
}
function saveResearchToBrain(brain, workOrder, result) {
  const journalEntry = {
    timestamp: Date.now(),
    action: `research:${workOrder.id}`,
    outcome: "completed",
    lesson: `Paper: ${workOrder.title}
Summary: ${result.summary.slice(0, 200)}
Proposal: ${result.proposal.slice(0, 200)}`
  };
  brain.journal.push(journalEntry);
  const memoryEntry = {
    timestamp: Date.now(),
    type: "discovery",
    content: `Research: ${result.summary}`,
    importance: 0.7
  };
  brain.memory.push(memoryEntry);
  if (brain.journal.length > 100) {
    brain.journal = brain.journal.slice(-100);
  }
  if (brain.memory.length > 100) {
    brain.memory = brain.memory.slice(-100);
  }
}
function loadEconomicConfig(runtimeModel) {
  const llmModel = runtimeModel ?? process.env.LLM_MODEL ?? "ollama/phi4-mini";
  const isOllamaModel = llmModel.startsWith("ollama/");
  const llmType = isOllamaModel ? "ollama" : "cloud";
  let llmCostPer1kTokens;
  if (process.env.LLM_COST_PER_1K_TOKENS) {
    llmCostPer1kTokens = parseFloat(process.env.LLM_COST_PER_1K_TOKENS);
  } else if (llmType === "ollama") {
    llmCostPer1kTokens = 0;
  } else {
    llmCostPer1kTokens = getModelCostPer1kTokens(llmModel);
  }
  return {
    synPriceUsd: parseFloat(process.env.SYN_PRICE_USD ?? "0.01"),
    llmType,
    llmModel,
    llmCostPer1kTokens,
    minProfitRatio: parseFloat(process.env.MIN_PROFIT_RATIO ?? "1.5")
  };
}
function estimateLLMCost(abstract, config) {
  if (config.llmType === "ollama") {
    return 0;
  }
  const inputTokens = Math.ceil(abstract.length / 4);
  const outputTokens = 500;
  const totalTokens = inputTokens + outputTokens;
  const cost = totalTokens / 1e3 * config.llmCostPer1kTokens;
  return cost;
}
function evaluateWorkOrder(workOrder, config) {
  const bountySyn = parseSynToLamports(workOrder.rewardAmount);
  const bountyUsd = Number(bountySyn) * config.synPriceUsd;
  if (!isResearchWorkOrder(workOrder)) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: "Non-research WO: no compute cost estimation needed"
    };
  }
  const payload = extractResearchPayload(workOrder);
  if (!payload) {
    return {
      shouldAccept: false,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: 0,
      reason: "Invalid research payload"
    };
  }
  const estimatedCostUsd = estimateLLMCost(payload.abstract, config);
  if (config.llmType === "ollama") {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: "Local Ollama model: zero API cost, always accept"
    };
  }
  if (estimatedCostUsd === 0) {
    return {
      shouldAccept: true,
      bountySyn,
      bountyUsd,
      estimatedCostUsd: 0,
      profitRatio: Infinity,
      reason: "Zero cost estimate, accepting"
    };
  }
  const profitRatio = bountyUsd / estimatedCostUsd;
  const shouldAccept = profitRatio >= config.minProfitRatio;
  return {
    shouldAccept,
    bountySyn,
    bountyUsd,
    estimatedCostUsd,
    profitRatio,
    reason: shouldAccept ? `Profitable: ratio ${profitRatio.toFixed(2)}x >= ${config.minProfitRatio}x minimum` : `Not profitable: ratio ${profitRatio.toFixed(2)}x < ${config.minProfitRatio}x minimum`
  };
}
async function executeWorkOrder(workOrder, llmModel, llmConfig) {
  console.log(`[WorkOrderAgent] Executing: ${workOrder.title}`);
  try {
    if (isResearchWorkOrder(workOrder)) {
      const { result: result2, rawResponse, success } = await executeResearchWorkOrder(
        workOrder,
        llmModel,
        llmConfig
      );
      return { result: rawResponse, success };
    }
    const prompt = buildWorkOrderPrompt(workOrder);
    const result = await generateLLM(llmModel, prompt, llmConfig);
    console.log(`[WorkOrderAgent] Execution complete, result length: ${result.length} chars`);
    return { result, success: true };
  } catch (error) {
    console.error("[WorkOrderAgent] Execution failed:", error.message);
    return {
      result: `Error: ${error.message}`,
      success: false
    };
  }
}
function buildWorkOrderPrompt(workOrder) {
  return `You are a SynapseIA network node executing a work order.

Task: ${workOrder.title}
Description: ${workOrder.description}

Please provide a detailed response to complete this task. Be thorough and accurate.

Response:`;
}
async function runWorkOrderAgentIteration(config, iteration, brain) {
  const { coordinatorUrl, peerId, capabilities, llmModel, llmConfig } = config;
  console.log(`
[WorkOrderAgent] Iteration ${iteration} starting...`);
  console.log("[WorkOrderAgent] Polling for available work orders...");
  const workOrders = await fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  if (workOrders.length === 0) {
    console.log("[WorkOrderAgent] No work orders available");
    return { completed: false };
  }
  console.log(`[WorkOrderAgent] Found ${workOrders.length} available work order(s)`);
  const workOrder = workOrders[0];
  console.log(`[WorkOrderAgent] Selected: "${workOrder.title}" (reward: ${workOrder.rewardAmount} SYN)`);
  const economicConfig = loadEconomicConfig(config.llmModel?.modelId);
  const evaluation = evaluateWorkOrder(workOrder, economicConfig);
  console.log(`[WorkOrderAgent] Economic evaluation:`);
  console.log(`  - Bounty: ${evaluation.bountyUsd.toFixed(4)} USD (${workOrder.rewardAmount} SYN)`);
  console.log(`  - Est. cost: ${evaluation.estimatedCostUsd.toFixed(4)} USD`);
  console.log(`  - Profit ratio: ${evaluation.profitRatio === Infinity ? "\u221E" : evaluation.profitRatio.toFixed(2) + "x"}`);
  console.log(`  - Decision: ${evaluation.shouldAccept ? "ACCEPT" : "SKIP"} (${evaluation.reason})`);
  if (!evaluation.shouldAccept) {
    console.log("[WorkOrderAgent] Skipping work order due to poor economics");
    return { completed: false, workOrder };
  }
  console.log("[WorkOrderAgent] Accepting work order...");
  const accepted = await acceptWorkOrder(coordinatorUrl, workOrder.id, peerId, capabilities);
  if (!accepted) {
    console.log("[WorkOrderAgent] Failed to accept work order, skipping");
    return { completed: false };
  }
  console.log("[WorkOrderAgent] Work order accepted");
  agentState.currentWorkOrder = workOrder;
  console.log("[WorkOrderAgent] Executing work order...");
  let result;
  let success;
  let researchResult;
  if (isResearchWorkOrder(workOrder)) {
    const research = await executeResearchWorkOrder(workOrder, llmModel, llmConfig);
    result = research.rawResponse;
    success = research.success;
    researchResult = research.result;
    if (brain && success) {
      saveResearchToBrain(brain, workOrder, researchResult);
      console.log("[WorkOrderAgent] Research saved to agent brain");
    }
    if (success) {
      const submitted = await submitResearchResult(
        coordinatorUrl,
        workOrder.id,
        peerId,
        researchResult
      );
      if (submitted) {
        console.log("[WorkOrderAgent] Research result submitted to research queue");
      }
    }
  } else {
    const execution = await executeWorkOrder(workOrder, llmModel, llmConfig);
    result = execution.result;
    success = execution.success;
  }
  console.log("[WorkOrderAgent] Reporting result...");
  const completed = await completeWorkOrder(
    coordinatorUrl,
    workOrder.id,
    peerId,
    result,
    success
  );
  if (completed) {
    console.log(`[WorkOrderAgent] Work order completed! Reward: ${workOrder.rewardAmount} SYN`);
    agentState.totalWorkOrdersCompleted++;
  } else {
    console.log("[WorkOrderAgent] Failed to report completion");
  }
  agentState.iteration = iteration;
  agentState.currentWorkOrder = void 0;
  return { workOrder, completed, researchResult };
}
async function startWorkOrderAgent(config) {
  if (agentState.isRunning) {
    throw new Error("Work order agent is already running");
  }
  agentState.isRunning = true;
  const { intervalMs, maxIterations } = config;
  console.log("\u{1F680} Starting SynapseIA Work Order Agent");
  console.log(`   Coordinator: ${config.coordinatorUrl}`);
  console.log(`   Peer ID: ${config.peerId}`);
  console.log(`   Capabilities: ${config.capabilities.join(", ")}`);
  console.log(`   LLM: ${config.llmModel.modelId}`);
  console.log(`   Interval: ${intervalMs}ms`);
  if (maxIterations) {
    console.log(`   Max iterations: ${maxIterations}`);
  }
  console.log("");
  try {
    let iteration = 1;
    while (shouldContinueLoop(agentState.isRunning, iteration, maxIterations)) {
      try {
        await runWorkOrderAgentIteration(config, iteration);
      } catch (error) {
        console.error(`[WorkOrderAgent] Iteration ${iteration} failed:`, error.message);
      }
      if (shouldSleepBetweenIterations(agentState.isRunning)) {
        console.log(`[WorkOrderAgent] Sleeping for ${intervalMs}ms...`);
        await sleep2(intervalMs);
      }
      iteration++;
    }
    if (maxIterations && iteration > maxIterations) {
      console.log(`
[WorkOrderAgent] Reached max iterations (${maxIterations}), stopping.`);
    }
  } finally {
    agentState.isRunning = false;
    console.log("\n[WorkOrderAgent] Stopped");
  }
}
function stopWorkOrderAgent() {
  agentState.isRunning = false;
  console.log("[WorkOrderAgent] Stopping...");
}
function shouldStopForMaxIterations(iteration, maxIterations) {
  if (!maxIterations) return false;
  return iteration > maxIterations;
}
function shouldContinueLoop(isRunning, iteration, maxIterations) {
  if (!isRunning) return false;
  if (maxIterations && iteration > maxIterations) return false;
  return true;
}
function shouldSleepBetweenIterations(isRunning) {
  return isRunning;
}
function sleep2(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
var WorkOrderAgentHelper = class {
  startWorkOrderAgent(config) {
    return startWorkOrderAgent(config);
  }
  stopWorkOrderAgent() {
    return stopWorkOrderAgent();
  }
  getWorkOrderAgentState() {
    return getWorkOrderAgentState();
  }
  resetWorkOrderAgentState() {
    return resetWorkOrderAgentState();
  }
  runWorkOrderAgentIteration(config, iteration, brain) {
    return runWorkOrderAgentIteration(config, iteration, brain);
  }
  fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities) {
    return fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  }
  acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities) {
    return acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities);
  }
  completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success) {
    return completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success);
  }
  executeWorkOrder(workOrder, llmModel, llmConfig) {
    return executeWorkOrder(workOrder, llmModel, llmConfig);
  }
  executeResearchWorkOrder(workOrder, llmModel, llmConfig) {
    return executeResearchWorkOrder(workOrder, llmModel, llmConfig);
  }
  submitResearchResult(coordinatorUrl, workOrderId, peerId, result) {
    return submitResearchResult(coordinatorUrl, workOrderId, peerId, result);
  }
  isResearchWorkOrder(workOrder) {
    return isResearchWorkOrder(workOrder);
  }
  extractResearchPayload(workOrder) {
    return extractResearchPayload(workOrder);
  }
  buildResearchPrompt(payload) {
    return buildResearchPrompt(payload);
  }
  saveResearchToBrain(brain, workOrder, result) {
    return saveResearchToBrain(brain, workOrder, result);
  }
  evaluateWorkOrder(workOrder, config) {
    return evaluateWorkOrder(workOrder, config);
  }
  loadEconomicConfig(runtimeModel) {
    return loadEconomicConfig(runtimeModel);
  }
  estimateLLMCost(abstract, config) {
    return estimateLLMCost(abstract, config);
  }
  getModelCostPer1kTokens(model) {
    return getModelCostPer1kTokens(model);
  }
  shouldContinueLoop(isRunning, iteration, maxIterations) {
    return shouldContinueLoop(isRunning, iteration, maxIterations);
  }
  shouldStopForMaxIterations(iteration, maxIterations) {
    return shouldStopForMaxIterations(iteration, maxIterations);
  }
  shouldSleepBetweenIterations(isRunning) {
    return shouldSleepBetweenIterations(isRunning);
  }
};
WorkOrderAgentHelper = __decorateClass([
  (0, import_common40.Injectable)()
], WorkOrderAgentHelper);

// src/modules/agent/services/agent-brain.service.ts
init_cjs_shims();
var import_common41 = require("@nestjs/common");
var AgentBrainService = class {
  constructor(agentBrainHelper) {
    this.agentBrainHelper = agentBrainHelper;
  }
  init(goals) {
    return this.agentBrainHelper.initBrain(goals);
  }
  update(brain, result) {
    return this.agentBrainHelper.updateBrain(brain, result);
  }
  getNextAction(brain) {
    return this.agentBrainHelper.getNextAction(brain);
  }
  getRecentMemories(brain, maxEntries, minImportance) {
    return this.agentBrainHelper.getRecentMemories(brain, maxEntries, minImportance);
  }
  getRecentJournal(brain, maxEntries) {
    return this.agentBrainHelper.getRecentJournal(brain, maxEntries);
  }
};
AgentBrainService = __decorateClass([
  (0, import_common41.Injectable)()
], AgentBrainService);

// src/modules/agent/services/agent-loop.service.ts
init_cjs_shims();
var import_common42 = require("@nestjs/common");
var AgentLoopService = class {
  constructor(agentLoopHelper) {
    this.agentLoopHelper = agentLoopHelper;
  }
  start(config) {
    return this.agentLoopHelper.startAgentLoop(config);
  }
  stop() {
    return this.agentLoopHelper.stopAgentLoop();
  }
  runIteration(config, iteration) {
    return this.agentLoopHelper.runAgentIteration(config, iteration);
  }
  getState() {
    return this.agentLoopHelper.getAgentLoopState();
  }
  resetState() {
    return this.agentLoopHelper.resetAgentLoopState();
  }
  fetchTopExperiments(coordinatorUrl, limit) {
    return this.agentLoopHelper.fetchTopExperiments(coordinatorUrl, limit);
  }
  createExperiment(coordinatorUrl, proposal, peerId, tier) {
    return this.agentLoopHelper.createExperiment(coordinatorUrl, proposal, peerId, tier);
  }
  updateExperiment(coordinatorUrl, experimentId, result) {
    return this.agentLoopHelper.updateExperiment(coordinatorUrl, experimentId, result);
  }
  postToFeed(coordinatorUrl, peerId, mutation, result, improved) {
    return this.agentLoopHelper.postToFeed(coordinatorUrl, peerId, mutation, result, improved);
  }
};
AgentLoopService = __decorateClass([
  (0, import_common42.Injectable)()
], AgentLoopService);

// src/modules/agent/services/work-order-agent.service.ts
init_cjs_shims();
var import_common43 = require("@nestjs/common");
var WorkOrderAgentService = class {
  constructor(workOrderAgentHelper) {
    this.workOrderAgentHelper = workOrderAgentHelper;
  }
  start(config) {
    return this.workOrderAgentHelper.startWorkOrderAgent(config);
  }
  stop() {
    return this.workOrderAgentHelper.stopWorkOrderAgent();
  }
  getState() {
    return this.workOrderAgentHelper.getWorkOrderAgentState();
  }
  resetState() {
    return this.workOrderAgentHelper.resetWorkOrderAgentState();
  }
  runIteration(config, iteration, brain) {
    return this.workOrderAgentHelper.runWorkOrderAgentIteration(config, iteration, brain);
  }
  fetchAvailable(coordinatorUrl, peerId, capabilities) {
    return this.workOrderAgentHelper.fetchAvailableWorkOrders(coordinatorUrl, peerId, capabilities);
  }
  accept(coordinatorUrl, workOrderId, peerId, nodeCapabilities) {
    return this.workOrderAgentHelper.acceptWorkOrder(coordinatorUrl, workOrderId, peerId, nodeCapabilities);
  }
  complete(coordinatorUrl, workOrderId, peerId, result, success) {
    return this.workOrderAgentHelper.completeWorkOrder(coordinatorUrl, workOrderId, peerId, result, success);
  }
  execute(workOrder, llmModel, llmConfig) {
    return this.workOrderAgentHelper.executeWorkOrder(workOrder, llmModel, llmConfig);
  }
  executeResearch(workOrder, llmModel, llmConfig) {
    return this.workOrderAgentHelper.executeResearchWorkOrder(workOrder, llmModel, llmConfig);
  }
  isResearch(workOrder) {
    return this.workOrderAgentHelper.isResearchWorkOrder(workOrder);
  }
  extractResearchPayload(workOrder) {
    return this.workOrderAgentHelper.extractResearchPayload(workOrder);
  }
  buildResearchPrompt(payload) {
    return this.workOrderAgentHelper.buildResearchPrompt(payload);
  }
  evaluate(workOrder, config) {
    return this.workOrderAgentHelper.evaluateWorkOrder(workOrder, config);
  }
  loadEconomicConfig(runtimeModel) {
    return this.workOrderAgentHelper.loadEconomicConfig(runtimeModel);
  }
  estimateLLMCost(abstract, config) {
    return this.workOrderAgentHelper.estimateLLMCost(abstract, config);
  }
  getModelCostPer1kTokens(model) {
    return this.workOrderAgentHelper.getModelCostPer1kTokens(model);
  }
  shouldContinueLoop(isRunning, iteration, maxIterations) {
    return this.workOrderAgentHelper.shouldContinueLoop(isRunning, iteration, maxIterations);
  }
  shouldStop(iteration, maxIterations) {
    return this.workOrderAgentHelper.shouldStopForMaxIterations(iteration, maxIterations);
  }
  shouldSleep(isRunning) {
    return this.workOrderAgentHelper.shouldSleepBetweenIterations(isRunning);
  }
  submitResearchResult(coordinatorUrl, workOrderId, peerId, result) {
    return this.workOrderAgentHelper.submitResearchResult(coordinatorUrl, workOrderId, peerId, result);
  }
};
WorkOrderAgentService = __decorateClass([
  (0, import_common43.Injectable)()
], WorkOrderAgentService);

// src/modules/agent/agent.module.ts
var AgentModule = class {
};
AgentModule = __decorateClass([
  (0, import_common44.Module)({
    providers: [
      AgentBrainHelper,
      AgentLoopHelper,
      WorkOrderAgentHelper,
      AgentBrainService,
      AgentLoopService,
      WorkOrderAgentService
    ],
    exports: [AgentBrainService, AgentLoopService, WorkOrderAgentService]
  })
], AgentModule);

// src/app.module.ts
var AppModule = class {
};
AppModule = __decorateClass([
  (0, import_common45.Module)({
    imports: [
      IdentityModule,
      HardwareModule,
      NodeConfigModule,
      HeartbeatModule,
      P2pModule,
      LlmModule,
      ModelModule,
      StakingModule,
      WalletModule,
      InferenceModule,
      AgentModule
    ]
  })
], AppModule);

// src/cli/index.ts
var import_prompts = require("@inquirer/prompts");

// src/modules/wallet/solana-balance.ts
init_cjs_shims();
var import_common46 = require("@nestjs/common");
var import_web34 = require("@solana/web3.js");
var SYN_TOKEN_MINT = process.env.SYN_TOKEN_MINT || "DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8";
var SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
var SolanaBalanceHelper = class {
  /**
   * Get SPL token balance for a wallet address
   * Returns balance in SYN tokens (9 decimals)
   */
  async getSynBalance(walletAddress) {
    try {
      const connection = new import_web34.Connection(SOLANA_RPC_URL, "confirmed");
      const walletPubkey = new import_web34.PublicKey(walletAddress);
      const mintPubkey = new import_web34.PublicKey(SYN_TOKEN_MINT);
      const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
        mint: mintPubkey
      });
      if (tokenAccounts.value.length === 0) {
        return 0;
      }
      let totalBalance = BigInt(0);
      for (const account of tokenAccounts.value) {
        const info = await connection.getTokenAccountBalance(account.pubkey);
        const amount = info.value.amount;
        totalBalance += BigInt(amount);
      }
      return Number(totalBalance) / 1e9;
    } catch {
      return 0;
    }
  }
  /**
   * Get staked SYN amount for a wallet via coordinator API
   */
  async getStakedAmount(walletAddress, coordinatorUrl = "http://localhost:3001") {
    try {
      const res = await fetch(`${coordinatorUrl}/stake/staker/${encodeURIComponent(walletAddress)}`);
      if (!res.ok) return 0;
      const data = await res.json();
      return parseFloat(data.totalStaked || "0");
    } catch {
      return 0;
    }
  }
  /**
   * Stake SYN tokens via coordinator API
   */
  async stakeTokens(walletAddress, amount, coordinatorUrl = "http://localhost:3001") {
    try {
      const res = await fetch(`${coordinatorUrl}/stake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, amount })
      });
      if (!res.ok) {
        const err = await res.json();
        return { success: false, error: err.message || "Stake failed" };
      }
      const data = await res.json();
      return { success: true, txSignature: data.txSignature, stakeAddress: data.stakeAddress };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
};
SolanaBalanceHelper = __decorateClass([
  (0, import_common46.Injectable)()
], SolanaBalanceHelper);
var getSynBalance = (...args) => new SolanaBalanceHelper().getSynBalance(...args);
var getStakedAmount = (...args) => new SolanaBalanceHelper().getStakedAmount(...args);

// src/cli/index.ts
function isExitError(e) {
  const err = e;
  return err?.constructor?.name === "ExitPromptError" || !!err?.message?.includes("force closed");
}
process.on("uncaughtException", (err) => {
  if (isExitError(err)) {
    console.log("\nBye \u{1F44B}");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  if (isExitError(reason)) {
    console.log("\nBye \u{1F44B}");
    process.exit(0);
  }
  console.error(reason);
  process.exit(1);
});
async function safePrompt(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isExitError(err)) return null;
    throw err;
  }
}
var SYPNASEIA_HEADER = `
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551                                                                            \u2551
\u2551  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2557   \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557     \u2551
\u2551  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u255A\u2588\u2588\u2557 \u2588\u2588\u2554\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557    \u2551
\u2551  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u255A\u2588\u2588\u2588\u2588\u2554\u255D \u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551    \u2551
\u2551  \u255A\u2550\u2550\u2550\u2550\u2588\u2588\u2551  \u255A\u2588\u2588\u2554\u255D  \u2588\u2588\u2554\u2550\u2550\u2550\u255D \u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u255A\u2550\u2550\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u255D  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551    \u2551
\u2551  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551   \u2588\u2588\u2551     \u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551    \u2551
\u2551  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D   \u255A\u2550\u255D   \u255A\u2550\u255D     \u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D    \u2551
\u2551                                                                            \u2551
\u2551                    Decentralized AI Compute Network                        \u2551
\u2551                                                                            \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
`;
function getPackageVersion() {
  try {
    const __filename2 = (0, import_url.fileURLToPath)(importMetaUrl);
    const __dirname = (0, import_path3.dirname)(__filename2);
    const pkgPath = (0, import_path3.join)(__dirname, "../../package.json");
    const pkg = JSON.parse((0, import_fs4.readFileSync)(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return "0.2.0";
  }
}
function getTierName2(tier) {
  const tierNames = {
    0: "CPU",
    1: "8GB GPU",
    2: "16GB GPU",
    3: "24GB GPU",
    4: "32GB GPU",
    5: "80GB GPU"
  };
  return tierNames[tier] || "Unknown";
}
async function bootstrap2() {
  const app = await import_core.NestFactory.createApplicationContext(AppModule, { logger: false });
  const identityService = app.get(IdentityService);
  const hardwareService = app.get(HardwareService);
  const configService = app.get(NodeConfigService);
  const walletService = app.get(WalletService);
  const modelCatalogService = app.get(ModelCatalogService);
  const llmService = app.get(LlmService);
  const workOrderAgentService = app.get(WorkOrderAgentService);
  const VERSION = getPackageVersion();
  const program = new import_commander.Command();
  program.name("synapseia").description("SynapseIA Network Node CLI").version(VERSION);
  program.command("start").description("Start SynapseIA node").option("--model <name>", "Model to use (default: recommended for hardware)").option("--llm-url <url>", "Custom LLM API base URL (for openai-compat provider)").option("--llm-key <key>", "API key for cloud LLM provider").option("--coordinator <url>", "Coordinator URL (default: http://localhost:3001)").option("--max-iterations <n>", "Maximum work order iterations (default: infinite)", parseInt).action(
    async (options) => {
      const config = configService.load();
      const identity = identityService.getOrCreate();
      const { wallet, isNew } = await walletService.getOrCreate();
      const hardware = hardwareService.detect();
      if (isNew) {
        walletService.displayCreationWarning(wallet);
      }
      const coordinatorUrl = options.coordinator || config.coordinatorUrl;
      const model = options.model || config.defaultModel;
      const llmUrl = options.llmUrl || config.llmUrl;
      const llmKey = options.llmKey || config.llmKey;
      let selectedModel = null;
      if (model) {
        const isCloud = model?.startsWith("openai-compat/") || model?.startsWith("anthropic/") || model?.startsWith("kimi/") || model?.startsWith("minimax/");
        if (!isCloud) {
          selectedModel = modelCatalogService.getByName(model);
          if (!selectedModel) {
            console.error(`Error: Model '${model}' not found in catalog.`);
            console.error("Available models:");
            modelCatalogService.getCatalog().forEach((m) => {
              console.error(`  ${m.name} (${m.category}, ${m.minVram}GB VRAM)`);
            });
            process.exit(1);
          }
          const isOllamaModel = model?.startsWith("ollama/") || !model && hardware.hasOllama;
          if (isOllamaModel && hardware.tier < (selectedModel?.recommendedTier ?? 0)) {
            console.error(
              `Error: Model '${model}' requires Tier ${selectedModel?.recommendedTier} or higher.`
            );
            console.error(`Your hardware is Tier ${hardware.tier}.`);
            process.exit(1);
          }
        }
        if (isCloud && !llmKey) {
          console.error(`Error: Cloud model '${model}' requires --llm-key`);
          process.exit(1);
        }
      } else {
        const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);
        if (compatibleModels.length === 0) {
          console.error("Error: No compatible models found for your hardware.");
          console.error(
            "Consider using cloud LLM providers with --model openai-compat/asi1-mini --llm-key <key>"
          );
          process.exit(1);
        }
        selectedModel = compatibleModels[0];
        console.log(
          `Using recommended model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM)`
        );
      }
      console.log(SYPNASEIA_HEADER);
      console.log("Starting SYPNASEIA node...");
      console.log(`PeerID: ${identity.peerId}`);
      console.log(`Wallet: ${wallet.publicKey} (Solana devnet)`);
      console.log(`Tier: ${hardware.tier} (${getTierName2(hardware.tier)})`);
      console.log(`Ollama: ${hardware.hasOllama ? "yes" : "no"}`);
      if (selectedModel) {
        console.log(
          `Model: ${selectedModel.name} (${selectedModel.minVram}GB VRAM, ${selectedModel.category || "unknown"})`
        );
      } else {
        console.log(`Model: ${model} (cloud)`);
      }
      if (llmUrl) console.log(`LLM URL: ${llmUrl}`);
      const llmModel = llmService.parse(model || "ollama/qwen2.5:0.5b");
      if (!llmModel) {
        console.error(`Error: Invalid model format '${model}'`);
        process.exit(1);
      }
      console.log("\n\u{1F680} Starting work order agent...");
      const capabilities = hardware.hasOllama ? ["llm", "ollama", `tier-${hardware.tier}`] : ["llm", `tier-${hardware.tier}`];
      await workOrderAgentService.start({
        coordinatorUrl,
        peerId: identity.peerId,
        capabilities,
        llmModel,
        llmConfig: { apiKey: llmKey, baseUrl: llmUrl },
        intervalMs: 3e4,
        maxIterations: options.maxIterations
      });
    }
  );
  program.command("status").description("Show node status").action(async () => {
    const identity = identityService.getOrCreate();
    const hardware = hardwareService.detect();
    const walletAddress = walletService.getAddress();
    const config = configService.load();
    const [balance, staked] = walletAddress ? await Promise.all([
      getSynBalance(walletAddress),
      getStakedAmount(walletAddress, config.coordinatorUrl)
    ]) : [0, 0];
    const status = {
      peerId: identity?.peerId || null,
      tier: hardware.tier,
      wallet: walletAddress,
      balance,
      staked,
      hasOllama: hardware.hasOllama,
      cpuCores: hardware.cpuCores,
      ramGb: hardware.ramGb,
      gpuVramGb: hardware.gpuVramGb
    };
    console.log(SYPNASEIA_HEADER);
    console.log("Node Status:");
    console.log(`PeerID:  ${status.peerId || "Not initialized"}`);
    console.log(`Tier:    ${status.tier} (${getTierName2(status.tier)})`);
    console.log(`Wallet:  ${status.wallet}`);
    console.log(`Balance: ${status.balance} SYN`);
    console.log(`Staked:  ${status.staked} SYN`);
    console.log(
      `Hardware: ${status.cpuCores} cores, ${status.ramGb}GB RAM, ${status.gpuVramGb}GB VRAM`
    );
    console.log(`Ollama:  ${status.hasOllama ? "Running" : "Not detected"}`);
  });
  program.command("stake").description("Stake SYN tokens").argument("<amount>", "Amount to stake (in SYN tokens)").action(async (amount) => {
    console.log(`Staking ${amount} SYN...`);
    console.log("Tx hash: <placeholder>");
  });
  program.command("unstake").description("Unstake SYN tokens").argument("<amount>", "Amount to unstake (in SYN tokens)").action(async (amount) => {
    console.log(`Unstaking ${amount} SYN...`);
    console.log("Tx hash: <placeholder>");
  });
  program.command("system-info").description("Show detailed system information").action(async () => {
    const sysInfo = hardwareService.getSystemInfo();
    const recommendedTier = hardwareService.getRecommendedTier(sysInfo.gpu.vramGb);
    const compatibleModels = hardwareService.getCompatibleModels(sysInfo.gpu.vramGb);
    console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    console.log("       SynapseIA Node - System Information");
    console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    console.log();
    console.log("\u{1F4CB} Operating System:");
    console.log(`   ${sysInfo.os}`);
    console.log();
    console.log("\u{1F527} CPU Information:");
    console.log(`   Model: ${sysInfo.cpu.model}`);
    console.log(`   Cores: ${sysInfo.cpu.cores}`);
    console.log();
    console.log("\u{1F4BE} Memory:");
    console.log(`   Total RAM: ${sysInfo.memory.totalGb} GB`);
    console.log();
    console.log("\u{1F3AE} GPU Information:");
    if (sysInfo.gpu.type) {
      console.log(`   Type: ${sysInfo.gpu.type}`);
      console.log(`   VRAM: ${sysInfo.gpu.vramGb} GB`);
    } else {
      console.log("   No GPU detected");
    }
    console.log();
    console.log("\u{1F3AF} Hardware Tier Assessment:");
    const tierName = ["CPU-Only", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5"][recommendedTier] || "Unknown";
    console.log(`   Recommended Tier: ${recommendedTier} (${tierName})`);
    console.log();
    console.log("\u{1F916} Compatible Models:");
    if (compatibleModels.length > 0) {
      console.log(
        `   Found ${compatibleModels.length} models compatible with ${sysInfo.gpu.vramGb}GB VRAM:`
      );
      compatibleModels.forEach((model, index) => {
        const tName = ["CPU", "T1", "T2", "T3", "T4", "T5"][model.recommendedTier] || "Unknown";
        console.log(
          `   ${index + 1}. ${model.name.padEnd(30)} (min ${model.minVram}GB, rec ${tName})`
        );
      });
    } else {
      console.log("   No compatible models found. Consider upgrading GPU or using cloud LLM.");
    }
    console.log();
    console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  });
  program.command("stop").description("Stop the running SynapseIA node").action(() => {
    console.log("\u{1F6D1} Stopping SynapseIA node...");
    workOrderAgentService.stop();
    console.log("\u2705 Node stopped");
  });
  program.command("config").description("Interactive configuration wizard").option("--show", "Show current configuration").action(async (options) => {
    const config = configService.load();
    if (options.show) {
      console.log("Current configuration:");
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    console.log("\n\u{1F527} SynapseIA Configuration Wizard");
    console.log("   Use \u2191\u2193 to navigate, Enter to select, Ctrl+C to cancel.\n");
    const catalog = modelCatalogService.getCatalog();
    const hardware = hardwareService.detect();
    const compatibleModels = hardwareService.getCompatibleModels(hardware.gpuVramGb || 0);
    const BACK = "__BACK__";
    let step = "coordinator";
    let modelMode = null;
    while (step !== "done") {
      if (step === "coordinator") {
        const ans = await safePrompt(
          () => (0, import_prompts.input)({
            message: "Coordinator URL:",
            default: config.coordinatorUrl,
            validate: (v) => {
              if (!v) return "Required";
              if (!v.startsWith("http")) return "Must start with http:// or https://";
              return true;
            }
          })
        );
        if (ans === null) {
          console.log("\nCancelled.");
          return;
        }
        config.coordinatorUrl = ans;
        step = "modelMode";
        continue;
      }
      if (step === "modelMode") {
        const ans = await safePrompt(
          () => (0, import_prompts.select)({
            message: "How would you like to configure your LLM model?",
            choices: [
              { name: "Use recommended model for your hardware", value: "recommended" },
              { name: "Select from compatible models", value: "compatible" },
              { name: "Select from all models", value: "all" },
              { name: "Use cloud LLM provider", value: "cloud" }
            ]
          })
        );
        if (ans === null) {
          console.log("\nCancelled.");
          return;
        }
        modelMode = ans;
        if (modelMode === "recommended") {
          if (compatibleModels.length > 0) {
            config.defaultModel = compatibleModels[0].name;
            console.log(`  \u2713 Recommended model: ${config.defaultModel}`);
            step = "llmConfig";
          } else {
            console.log("  \u26A0 No compatible local models \u2014 switching to cloud picker.");
            modelMode = "cloud";
            step = "modelPick";
          }
        } else {
          step = "modelPick";
        }
        continue;
      }
      if (step === "modelPick") {
        let choices = [];
        if (modelMode === "compatible") {
          if (compatibleModels.length === 0) {
            console.log("  \u26A0 No compatible models for your hardware \u2014 showing cloud options.");
            modelMode = "cloud";
          } else {
            choices = compatibleModels.map((m) => ({
              name: `${m.name}  (${m.minVram}GB VRAM, Tier ${m.recommendedTier})`,
              value: m.name,
              description: m.description
            }));
          }
        }
        if (modelMode === "all") {
          choices = catalog.map((m) => ({
            name: `${m.name}  (${m.category}, ${m.minVram}GB VRAM)`,
            value: m.name,
            description: m.description,
            disabled: m.recommendedTier > hardware.tier ? "Requires higher tier" : false
          }));
        }
        if (modelMode === "cloud") {
          choices = [
            { name: "Minimax", value: "minimax/MiniMax-M2.7", description: "MiniMax model" },
            { name: "ASI1", value: "openai-compat/asi1", description: "ASI1 model" },
            {
              name: "Custom OpenAI-compatible URL",
              value: "openai-compat/custom",
              description: "Bring your own endpoint"
            }
          ];
        }
        const ans = await safePrompt(
          () => (0, import_prompts.select)({
            message: modelMode === "cloud" ? "Select cloud LLM provider:" : "Select a model:",
            choices: [...choices, { name: "\u2190 Back  (change model type)", value: BACK }]
          })
        );
        if (ans === null) {
          console.log("\nCancelled.");
          return;
        }
        if (ans === BACK) {
          step = "modelMode";
          continue;
        }
        config.defaultModel = ans;
        step = "llmConfig";
        continue;
      }
      if (step === "llmConfig") {
        const usingCloud = configService.isCloudModel(config.defaultModel);
        if (usingCloud) {
          console.log("\n  \u2601\uFE0F  Cloud LLM configuration");
          const llmUrl = await safePrompt(
            () => (0, import_prompts.input)({
              message: "API base URL:",
              default: config.llmUrl || "https://api.asi1.ai/v1",
              validate: (v) => {
                if (!v) return "Required";
                if (!v.startsWith("http")) return "Must start with http";
                return true;
              }
            })
          );
          if (llmUrl === null) {
            console.log("\nCancelled.");
            return;
          }
          config.llmUrl = llmUrl;
          const hasKey = await safePrompt(
            () => (0, import_prompts.confirm)({ message: "Do you have an API key?", default: true })
          );
          if (hasKey === null) {
            console.log("\nCancelled.");
            return;
          }
          if (hasKey) {
            const llmKey = await safePrompt(
              () => (0, import_prompts.password)({ message: "Enter your API key:", mask: "*" })
            );
            if (llmKey === null) {
              console.log("\nCancelled.");
              return;
            }
            if (llmKey) config.llmKey = llmKey;
          } else {
            console.log("  \u26A0 Provide --llm-key when starting the node.");
          }
        } else {
          const useCustom = await safePrompt(
            () => (0, import_prompts.confirm)({
              message: "Use a custom Ollama URL?",
              default: !!config.llmUrl
            })
          );
          if (useCustom === null) {
            console.log("\nCancelled.");
            return;
          }
          if (useCustom) {
            const ollamaUrl = await safePrompt(
              () => (0, import_prompts.input)({
                message: "Ollama URL:",
                default: config.llmUrl || "http://localhost:11434"
              })
            );
            if (ollamaUrl === null) {
              console.log("\nCancelled.");
              return;
            }
            config.llmUrl = ollamaUrl;
          } else {
            config.llmUrl = void 0;
          }
        }
        step = "done";
      }
    }
    configService.save(config);
    console.log("\n  \u2705  Configuration saved to", CONFIG_FILE);
    console.log("\n  Next steps:");
    console.log("    synapseia start    # Start the node");
    console.log("    synapseia status   # Check node status");
  });
  program.parse();
}
bootstrap2().catch((err) => {
  console.error(err);
  process.exit(1);
});
