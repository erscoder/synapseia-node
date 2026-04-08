# Synapseia Node

The node software that runs on operator machines — executes training and inference work orders, participates in research rounds, and earns SYN rewards.

## What it does

- **Training work orders** — executes micro-transformer and DiLoCo training tasks
- **Inference work orders** — CPU/GPU inference for model responses
- **Research participation** — analyzes AI papers, submits results to coordinator
- **Heartbeat** — keeps the network aware of node availability
- **Solana integration** — receives rewards via SPL token transfers

## Stack

- **Node.js** (TypeScript)
- **LangGraph** (agent orchestration)
- **Ollama** (local LLM inference)
- **Prisma** (local SQLite for state)
- **Docker**

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your Solana wallet and coordinator URL

# Run the node
pnpm start
# or for development with hot reload
pnpm start:dev
```

## Environment Variables

```env
SOLANA_NETWORK=devnet
COORDINATOR_URL=http://localhost:3001
NODE_WALLET_PATH=./data/wallet.json
OLLAMA_URL=http://localhost:11434
PORT=3002
```

## Docker

```bash
docker compose up -d
```

---

Part of the **synapseia-network** monorepo. See also:

- [synapseia-coordinator](https://github.com/erscoder/synapseia-coordinator) — protocol central API
- [synapseia-dashboard](https://github.com/erscoder/synapseia-dashboard) — operator control panel
- [synapseia-contracts](https://github.com/erscoder/synapseia-contracts) — Solana programs
