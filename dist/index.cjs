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
    cpuCores: os3.cpus().length || 2,
    ramGb: Math.round(os3.totalmem() / 1024 ** 3),
    gpuVramGb: 0,
    tier: 0,
    hasOllama: false
  };
  if (!cpuOnly) {
    try {
      const arch2 = archOverride || os3.arch();
      if (arch2 === "arm64") {
        const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string").toString().trim();
        detectAppleSilicon(hardware, model);
      } else if (arch2 === "x86") {
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
function buildOsString(platform2, release2, arch2, osType) {
  if (platform2 === "darwin") return `macOS ${release2} (${arch2})`;
  if (platform2 === "linux") return `Linux ${release2} (${arch2})`;
  if (platform2 === "win32") return `Windows ${release2} (${arch2})`;
  return `${osType} ${release2} (${arch2})`;
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
  const osPlatform = os3.platform();
  const osRelease = os3.release();
  const arch2 = archOverride || os3.arch();
  const osString = buildOsString(osPlatform, osRelease, arch2, os3.type());
  const cpuModel = os3.cpus()[0]?.model || "Unknown CPU";
  const cpuCores = os3.cpus().length || 0;
  const memoryTotal = os3.totalmem();
  let gpuType = null;
  let gpuVram = 0;
  try {
    if (arch2 === "arm64" && osPlatform === "darwin") {
      const model = (0, import_child_process.execSync)("sysctl -n machdep.cpu.brand_string", { encoding: "utf-8" }).trim();
      gpuType = model;
      gpuVram = estimateAppleSiliconVram(model);
    } else if (arch2 === "x86_64" || arch2 === "x64") {
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
var os3, import_child_process;
var init_hardware = __esm({
  "src/hardware.ts"() {
    "use strict";
    os3 = __toESM(require("os"), 1);
    import_child_process = require("child_process");
  }
});

// src/cli/index.ts
var import_commander = require("commander");
var import_fs4 = require("fs");
var import_path2 = require("path");
var import_url = require("url");

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
function getOrCreateIdentity(identityDir = IDENTITY_DIR) {
  try {
    return loadIdentity(identityDir);
  } catch {
    return generateIdentity(identityDir);
  }
}

// src/wallet.ts
var import_fs2 = require("fs");
var path2 = __toESM(require("path"), 1);
var os2 = __toESM(require("os"), 1);
var crypto2 = __toESM(require("crypto"), 1);
var WALLET_DIR = path2.join(os2.homedir(), ".synapse");
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
async function promptForPassword(message = "Enter wallet password: ") {
  const envPassword = process.env.WALLET_PASSWORD;
  if (envPassword) {
    return envPassword;
  }
  const { password: password2 } = await import("@inquirer/prompts");
  return password2({ message });
}
async function promptForNewPassword() {
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
async function generateWallet(walletDir = WALLET_DIR, password2) {
  if (!(0, import_fs2.existsSync)(walletDir)) {
    (0, import_fs2.mkdirSync)(walletDir, { recursive: true, mode: 448 });
  }
  if (!password2) {
    password2 = await promptForNewPassword();
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
    (0, import_fs2.writeFileSync)(
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
    (0, import_fs2.writeFileSync)(
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
async function loadWallet(walletDir = WALLET_DIR, password2) {
  const walletPath = path2.join(walletDir, "wallet.json");
  if (!(0, import_fs2.existsSync)(walletPath)) {
    throw new Error(`Wallet not found at ${walletPath}. Run generateWallet() first.`);
  }
  const content = (0, import_fs2.readFileSync)(walletPath, "utf-8");
  const encryptedWallet = JSON.parse(content);
  if (!encryptedWallet.encryptedData) {
    throw new Error("Invalid wallet file structure");
  }
  if (!password2) {
    password2 = await promptForPassword();
  }
  return decryptWallet(encryptedWallet, password2);
}
async function getOrCreateWallet(walletDir = WALLET_DIR, password2) {
  const MAX_RETRIES = 3;
  let attempts = 0;
  while (attempts < MAX_RETRIES) {
    try {
      const wallet = await loadWallet(walletDir, password2);
      return { wallet, isNew: false };
    } catch (error) {
      const errorMessage = error.message;
      if (errorMessage.includes("Wallet not found")) {
        return generateWallet(walletDir, password2);
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
function getWalletAddress(walletDir = WALLET_DIR) {
  try {
    const walletPath = path2.join(walletDir, "wallet.json");
    if (!(0, import_fs2.existsSync)(walletPath)) {
      return "not configured";
    }
    const content = (0, import_fs2.readFileSync)(walletPath, "utf-8");
    const encryptedWallet = JSON.parse(content);
    return encryptedWallet.publicKey;
  } catch {
    return "not configured";
  }
}
function displayWalletCreationWarning(wallet) {
  if (!wallet.mnemonic) return;
  console.log("\n" + "\u2550".repeat(70));
  console.log("  \u{1F510} IMPORTANT: SAVE YOUR RECOVERY PHRASE");
  console.log("\u2550".repeat(70));
  console.log("\nYour Solana wallet has been created. Write down these 12 words\nand store them in a secure, offline location:");
  console.log("\n  " + wallet.mnemonic);
  console.log("\n\u26A0\uFE0F  Anyone with access to these words can control your funds.");
  console.log("\u26A0\uFE0F  Never share your recovery phrase with anyone.");
  console.log("\nA backup has also been saved to:");
  console.log(`  ${BACKUP_FILE}`);
  console.log("\u2550".repeat(70) + "\n");
}

// src/cli/index.ts
init_hardware();

// src/model-catalog.ts
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

// src/ollama.ts
var import_axios = __toESM(require("axios"), 1);
var import_ollama = require("ollama");
async function checkOllama(url = "http://localhost:11434") {
  try {
    const response = await import_axios.default.get(`${url}/api/tags`, {
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
  if (model.providerId === "openai-compat") {
    return generateOpenAICompat(model, prompt, config.apiKey, config.baseUrl);
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

// src/work-order-agent.ts
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
        await sleep(intervalMs);
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
function shouldContinueLoop(isRunning, iteration, maxIterations) {
  if (!isRunning) return false;
  if (maxIterations && iteration > maxIterations) return false;
  return true;
}
function shouldSleepBetweenIterations(isRunning) {
  return isRunning;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/cli/index.ts
var import_prompts = require("@inquirer/prompts");

// src/config.ts
var import_fs3 = require("fs");
var import_path = require("path");
var import_os = require("os");
var CONFIG_DIR = (0, import_path.join)((0, import_os.homedir)(), ".synapse");
var CONFIG_FILE = (0, import_path.join)(CONFIG_DIR, "config.json");
function defaultConfig() {
  return {
    coordinatorUrl: "http://localhost:3001",
    defaultModel: "ollama/qwen2.5:0.5b"
  };
}
function loadConfig() {
  if ((0, import_fs3.existsSync)(CONFIG_FILE)) {
    try {
      return JSON.parse((0, import_fs3.readFileSync)(CONFIG_FILE, "utf-8"));
    } catch {
      return defaultConfig();
    }
  }
  return defaultConfig();
}
function saveConfig(config) {
  if (!(0, import_fs3.existsSync)(CONFIG_DIR)) {
    (0, import_fs3.mkdirSync)(CONFIG_DIR, { recursive: true });
  }
  (0, import_fs3.writeFileSync)(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function isCloudModel(model) {
  return model.startsWith("openai-compat/") || model.startsWith("anthropic/") || model.startsWith("kimi/") || model.startsWith("minimax/");
}

// src/solana-balance.ts
var import_web3 = require("@solana/web3.js");
var SYN_TOKEN_MINT = process.env.SYN_TOKEN_MINT || "DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8";
var SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
async function getSynBalance(walletAddress) {
  try {
    const connection = new import_web3.Connection(SOLANA_RPC_URL, "confirmed");
    const walletPubkey = new import_web3.PublicKey(walletAddress);
    const mintPubkey = new import_web3.PublicKey(SYN_TOKEN_MINT);
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
async function getStakedAmount(walletAddress, coordinatorUrl = "http://localhost:3001") {
  try {
    const res = await fetch(`${coordinatorUrl}/stake/staker/${encodeURIComponent(walletAddress)}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return parseFloat(data.totalStaked || "0");
  } catch {
    return 0;
  }
}

// src/cli/index.ts
var import_meta = {};
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
var program = new import_commander.Command();
function getPackageVersion() {
  try {
    const __filename = (0, import_url.fileURLToPath)(import_meta.url);
    const __dirname = (0, import_path2.dirname)(__filename);
    const pkgPath = (0, import_path2.join)(__dirname, "../../package.json");
    const pkg = JSON.parse((0, import_fs4.readFileSync)(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return "0.2.0";
  }
}
var VERSION = getPackageVersion();
program.name("synapseia").description("SynapseIA Network Node CLI").version(VERSION);
program.command("start").description("Start SynapseIA node").option("--model <name>", "Model to use (default: recommended for hardware)").option("--llm-url <url>", "Custom LLM API base URL (for openai-compat provider)").option("--llm-key <key>", "API key for cloud LLM provider").option("--coordinator <url>", "Coordinator URL (default: http://localhost:3001)").option("--max-iterations <n>", "Maximum work order iterations (default: infinite)", parseInt).action(
  async (options) => {
    const config = loadConfig();
    const identity = await getOrCreateIdentity();
    const { wallet, isNew } = await getOrCreateWallet();
    const hardware = await detectHardware();
    if (isNew) {
      displayWalletCreationWarning(wallet);
    }
    const coordinatorUrl = options.coordinator || config.coordinatorUrl;
    const model = options.model || config.defaultModel;
    const llmUrl = options.llmUrl || config.llmUrl;
    const llmKey = options.llmKey || config.llmKey;
    let selectedModel = null;
    if (model) {
      const isCloudModel2 = model?.startsWith("openai-compat/") || model?.startsWith("anthropic/") || model?.startsWith("kimi/") || model?.startsWith("minimax/");
      if (!isCloudModel2) {
        selectedModel = getModelByName(model);
        if (!selectedModel) {
          console.error(`Error: Model '${model}' not found in catalog.`);
          console.error("Available models:");
          const catalog = getModelCatalog();
          catalog.forEach((m) => {
            console.error(`  ${m.name} (${m.category}, ${m.minVram}GB VRAM)`);
          });
          process.exit(1);
        }
        const isOllamaModel = model?.startsWith("ollama/") || !model && hardware.hasOllama;
        if (isOllamaModel && hardware.tier < selectedModel.recommendedTier) {
          console.error(
            `Error: Model '${model}' requires Tier ${selectedModel.recommendedTier} or higher.`
          );
          console.error(`Your hardware is Tier ${hardware.tier}.`);
          process.exit(1);
        }
      }
      if (isCloudModel2 && !llmKey) {
        console.error(`Error: Cloud model '${model}' requires --llm-key`);
        process.exit(1);
      }
    } else {
      const compatibleModels = getCompatibleModels(hardware.gpuVramGb || 0);
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
    if (llmUrl) {
      console.log(`LLM URL: ${llmUrl}`);
    }
    const llmModel = parseModel(model || "ollama/qwen2.5:0.5b");
    if (!llmModel) {
      console.error(`Error: Invalid model format '${model}'`);
      process.exit(1);
    }
    console.log("\n\u{1F680} Starting work order agent...");
    const capabilities = hardware.hasOllama ? ["llm", "ollama", `tier-${hardware.tier}`] : ["llm", `tier-${hardware.tier}`];
    await startWorkOrderAgent({
      coordinatorUrl,
      peerId: identity.peerId,
      capabilities,
      llmModel,
      llmConfig: {
        apiKey: llmKey,
        baseUrl: llmUrl
      },
      intervalMs: 3e4,
      // 30 seconds
      maxIterations: options.maxIterations
    });
  }
);
program.command("status").description("Show node status").action(async () => {
  const identity = getOrCreateIdentity();
  const hardware = await detectHardware();
  const walletAddress = getWalletAddress();
  const config = loadConfig();
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
  const sysInfo = getSystemInfo();
  const recommendedTier = getRecommendedTier(sysInfo.gpu.vramGb);
  const compatibleModels = getCompatibleModels(sysInfo.gpu.vramGb);
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
      const tierName2 = ["CPU", "T1", "T2", "T3", "T4", "T5"][model.recommendedTier] || "Unknown";
      console.log(
        `   ${index + 1}. ${model.name.padEnd(30)} (min ${model.minVram}GB, rec ${tierName2})`
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
  stopWorkOrderAgent();
  console.log("\u2705 Node stopped");
});
program.command("config").description("Interactive configuration wizard").option("--show", "Show current configuration").action(async (options) => {
  const config = loadConfig();
  if (options.show) {
    console.log("Current configuration:");
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  console.log("\n\u{1F527} SynapseIA Configuration Wizard");
  console.log("   Use \u2191\u2193 to navigate, Enter to select, Ctrl+C to cancel.\n");
  const catalog = getModelCatalog();
  const hardware = await detectHardware();
  const compatibleModels = getCompatibleModels(hardware.gpuVramGb || 0);
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
      const usingCloud = isCloudModel(config.defaultModel);
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
  saveConfig(config);
  console.log("\n  \u2705  Configuration saved to", CONFIG_FILE);
  console.log("\n  Next steps:");
  console.log("    synapseia start    # Start the node");
  console.log("    synapseia status   # Check node status");
});
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
program.parse();
