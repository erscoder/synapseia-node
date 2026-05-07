<!-- TODO: Replace <DASHBOARD_URL_TBD>, <COORD_URL_TBD>, and Discord/Twitter links before public launch -->

# @synapseia/node

The Synapseia Network compute node — contribute CPU/GPU cycles to autonomous AI agents and earn SYN tokens on Solana.

**🟡 Status: Closed Beta — Devnet only**

> ⚠️ **Beta capacity is capped.** New node registrations may be rejected with a `[BETA_LIMIT_REACHED]` message when the network is full. If that happens, your node exits cleanly — try again later, or wait for mainnet launch.

---

## What is Synapseia?

Synapseia is a peer-to-peer compute layer for autonomous AI agents. Operators run nodes that contribute training, inference, and research workloads to a decentralized coordinator. In exchange, nodes earn SYN — an SPL token on Solana.

This package is the operator-side runtime: a CLI you install globally and run as a long-lived process.

---

## Requirements

- **Node.js ≥ 20** (`node --version` to check).
- **~2 GB RAM** free, stable internet.
- **Ollama** (only if you plan to run inference workloads) — install from [ollama.com](https://ollama.com).
- **Solana wallet with devnet SOL** — the node generates one for you on first run; you fund it from a faucet.

---

## Quick start (TL;DR)

```bash
npm i -g @synapseia/node
synapseia start            # creates a wallet, prints the address, then waits
# In another terminal — fund the wallet on devnet:
solana airdrop 1 <YOUR_ADDRESS> --url devnet
# Re-run:
synapseia start --coordinator <COORD_URL_TBD>
```

For the full walkthrough, keep reading.

---

## Step-by-step beta onboarding

### Step 1 — Install

```bash
npm i -g @synapseia/node
synapseia --version
```

You can use `synapseia` or its short alias `syn` interchangeably.

### Step 2 — Initialize your node (creates a wallet)

The first run prompts you for a node name and a wallet password. The password encrypts your wallet at rest — **there is no recovery if you forget it**.

```bash
synapseia start
```

Output looks like:

```text
Wallet created at ~/.synapseia/wallet.json
Wallet address: 3xK...nQ8
⚠️  Save this address — you'll need it for funding.
```

**Copy the wallet address now.** You'll paste it into two faucets in the next steps.

### Step 3 — Fund with devnet SOL (gas)

Your node needs a small amount of SOL on Solana **devnet** to pay for on-chain operations (registration, staking transactions). This is test SOL — it has no real value.

**Option A — Solana CLI (recommended if installed):**

```bash
solana airdrop 1 <YOUR_ADDRESS> --url devnet
```

**Option B — Web faucet:**

1. Open [https://faucet.solana.com](https://faucet.solana.com).
2. Select **Devnet** from the network dropdown.
3. Paste your wallet address.
4. Click **Confirm Airdrop**.

Verify the balance arrived:

```bash
solana balance <YOUR_ADDRESS> --url devnet
```

You should see `1 SOL` within a few seconds.

### Step 4 — Request SYN tokens (optional, for staking)

SYN is the network's reward token. You can run a node without staking, but staking unlocks higher reward tiers.

1. Open `<DASHBOARD_URL_TBD>/faucet`.
2. Paste your wallet address.
3. Click **Request 10 SYN**.

**Limits:** 10 SYN per request, 1 request per 24 h per wallet.

### Step 5 — Start your node

Point the node at the public coordinator:

```bash
synapseia start --coordinator <COORD_URL_TBD>
```

Or set it once via environment variable:

```bash
export COORDINATOR_URL=<COORD_URL_TBD>
synapseia start
```

The node will:

- Register with the coordinator on the first heartbeat.
- Heartbeat every ~30 seconds.
- Wait for incoming work orders (training, inference, research).

You should see logs like:

```text
[heartbeat] registered as <peerId>
[heartbeat] tier=0 caps=cpu_inference,research
```

### Step 6 — Verify on the dashboard

Open `<DASHBOARD_URL_TBD>/nodes` and search for your wallet address. Your node should appear in the list within ~1 minute. If it doesn't, check the **Troubleshooting** table below.

---

## Optional — node-ui (desktop GUI)

Prefer a desktop app over the CLI? `node-ui` is a cross-platform Tauri app that wraps the same runtime, uses the same wallet (`~/.synapseia/wallet.json`), and points at the same coordinator.

Download from [https://github.com/synapseia-network/node/releases](https://github.com/synapseia-network/node/releases):

- **macOS:** `synapseia-node-ui_<version>_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel).
- **Windows:** `synapseia-node-ui_<version>_x64.msi`.
- **Linux:** `synapseia-node-ui_<version>_amd64.AppImage`.

Run the installer, follow the prompts, and on first launch the app will create or import the same `~/.synapseia/wallet.json` used by the CLI. Click **Start** to bring the node online — the GUI shows live logs and status.

---

## Troubleshooting

| Message / Symptom | What it means | Fix |
|---|---|---|
| `[BETA_LIMIT_REACHED] Beta tester limit reached.` | Coordinator beta cap is full. CLI exits with code 0. | Wait for the next slot bump or for mainnet. Re-run `synapseia start` later. |
| `Wallet not funded` / `insufficient SOL` | Wallet has 0 SOL on devnet. | Re-do Step 3 (devnet SOL faucet). |
| `Coordinator unreachable` / `ECONNREFUSED` | Wrong coord URL or coordinator is down. | Check the `--coordinator` flag or `COORDINATOR_URL` env var. |
| `Cannot find module 'X'` | Global npm install was incomplete. | `npm i -g --force @synapseia/node`. |
| Modal **"Beta tester limit reached"** in node-ui | Same as the CLI message above. | Same fix — re-try later. |
| Wallet password forgotten | The wallet is encrypted; there is no recovery path. | Delete `~/.synapseia/wallet.json` and re-run `synapseia start`. **You'll lose the old address — fund the new one.** |

---

## CLI command reference

### `synapseia start [options]`

Main loop — registers the node, heartbeats, executes work orders.

| Flag | Description | Default |
|---|---|---|
| `--coordinator <url>` | Coordinator URL | `http://localhost:3701` |
| `--model <name>` | Ollama model for inference workloads | — |
| `--llm-key <key>` | External LLM API key (optional) | — |
| `--inference` | Enable inference workloads | off |
| `--lat <n> --lng <n>` | Geolocation override (else IP-based) | — |
| `--set-name <name>` | Node display name | — |

### Other commands

- `synapseia status` — current runtime status of your node.
- `synapseia wallet` — wallet info, address, balance.
- `synapseia config` — show / edit local config.
- `synapseia staking` — stake / unstake SYN.

Run any command with `--help` for the full option list.

---

## Configuration & data location

- **Wallet:** `~/.synapseia/wallet.json` (encrypted with your password).
- **Config:** `~/.synapseia/config.json`.
- **Logs:** stdout / stderr. Redirect to file with:
  ```bash
  synapseia start 2>&1 | tee node.log
  ```
- **Override home dir:** set `SYNAPSEIA_HOME=/path/to/dir`.

---

## License

This software is licensed under the **Functional Source License v1.1 with Apache-2.0 future grant (FSL-1.1-Apache-2.0)**.

- **You can:** use it personally, modify it, run nodes for your own use, fork it for non-competing internal purposes.
- **You cannot (until 2028-05-07):** operate a service or distributed network that competes with Synapseia.
- **After 2028-05-07** the license auto-converts to **Apache-2.0** — anyone can use it for any purpose, including competing networks.

Full text: see the [`LICENSE`](./LICENSE) file in this directory.

---

## Links

- **Network dashboard:** `<DASHBOARD_URL_TBD>`
- **Solana devnet faucet:** [https://faucet.solana.com](https://faucet.solana.com)
- **Solana CLI install:** [https://docs.solana.com/cli/install](https://docs.solana.com/cli/install)
- **Ollama install:** [https://ollama.com](https://ollama.com)
- **Issues:** [https://github.com/synapseia-network/node/issues](https://github.com/synapseia-network/node/issues)

---

## Contributing & support

Found a bug? Have a feature request? File an issue on GitHub. For real-time support and beta-tester discussion, join us on Discord (`<TBD>`) or follow updates on Twitter (`<TBD>`). PRs welcome — please open an issue first to discuss non-trivial changes.
