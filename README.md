# Solobank — AI-Controlled DeFi Vault on Solana

> AI decides. Blockchain executes. Everything is verifiable on-chain.

## The Problem

Smart contracts on Solana are powerful but rigid — they don't adapt to changing market conditions, don't analyze data, and can't make complex financial decisions. Managing DeFi positions (lending, swapping, rebalancing) requires constant human attention.

Meanwhile, AI can analyze markets and make decisions, but its actions are opaque and unverifiable.

## The Solution

**Solobank** bridges AI and blockchain by creating an autonomous DeFi banking system where:

1. **AI agent** (GPT-4o-mini) analyzes real-time lending rates across Kamino and Marginfi
2. **Smart contract** (Anchor on Solana) validates and records every AI decision on-chain
3. **SDK + MCP server** enables any AI assistant (Claude, Cursor, Copilot) to manage DeFi positions autonomously

Every decision is transparent, auditable, and constrained by on-chain safeguards.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│   AI Agent      │     │   Gateway    │     │   Solana Blockchain │
│   (GPT-4o-mini) │────▶│   (Hono)     │────▶│                     │
│                 │     │              │     │  ┌───────────────┐  │
│  Analyzes:      │     │  51 APIs     │     │  │  Vault        │  │
│  - Kamino APYs  │     │  USDC pay    │     │  │  - balance    │  │
│  - Marginfi APYs│     │  Helius RPC  │     │  │  - limits     │  │
│  - Risk levels  │     │              │     │  │  - decisions  │  │
│                 │     │  Verifies:   │     │  └───────────────┘  │
│  Decides:       │     │  - signature │     │                     │
│  - lend/swap    │     │  - amount    │     │  ┌───────────────┐  │
│  - rebalance    │     │  - replay    │     │  │  AI Decision  │  │
│  - withdraw     │     │              │     │  │  - type       │  │
│                 │     │              │     │  │  - amount     │  │
└─────────────────┘     └──────────────┘     │  │  - reasoning  │  │
        │                                     │  │  - status     │  │
        ▼                                     │  └───────────────┘  │
┌─────────────────┐                           │                     │
│  MCP Server     │                           │  Protocols:         │
│  15 tools       │──────────────────────────▶│  - Kamino (lend)   │
│                 │                           │  - Marginfi (lend) │
│  Claude/Cursor  │                           │  - Jupiter (swap)  │
│  can manage     │                           │  - SPL Token (pay) │
│  the vault      │                           └─────────────────────┘
└─────────────────┘

         ┌──────────────────────┐
         │  Frontend (Next.js)  │
         │  solobank.lol        │
         │  - Services catalog  │
         │  - Live stats        │
         │  - Documentation     │
         └──────────────────────┘
```

## How AI Controls the Smart Contract

```
Step 1: AI fetches DeFi rates
        GPT-4o-mini receives: Kamino USDC 8.2% APY, Marginfi USDC 7.1% APY

Step 2: AI makes a decision
        { action: "lend", asset: "USDC", amount: 100, protocol: "kamino",
          confidence: 85%, risk: "low" }

Step 3: Decision recorded on-chain
        → ai_decision instruction → Vault validates limits
        → Decision PDA created with reasoning hash
        → DecisionRecorded event emitted

Step 4: Decision executed
        → execute_decision instruction → Vault deducts balance
        → SDK calls Kamino to lend USDC
        → DecisionExecuted event emitted

Step 5: Everything verifiable
        → Solana Explorer shows all decisions, amounts, timestamps
        → reasoning_hash links to full AI reasoning off-chain
```

## Smart Contract: AI Decision Vault

**Program**: `solobank-vault` (Anchor/Rust)

### Instructions

| Instruction | Description |
|---|---|
| `initialize_vault` | Create vault with owner, per-tx limit, daily limit |
| `deposit` | Deposit SOL into the vault |
| `ai_decision` | AI records a decision (lend/swap/rebalance/withdraw) |
| `execute_decision` | Execute a pending decision |
| `withdraw` | Owner withdraws funds |
| `lock_vault` | Emergency lock — disables AI decisions |
| `unlock_vault` | Re-enable AI decisions |

### On-Chain Accounts

**Vault** — stores balance, limits, and stats:
```
owner, balance, max_per_tx, daily_limit, total_decisions, total_volume,
daily_spent, last_reset_day, is_locked
```

**Decision** — each AI decision is a separate on-chain account:
```
vault, agent, decision_type, asset, amount, reasoning_hash,
status (Pending/Executed/Rejected), timestamp
```

### Safeguards
- Per-transaction amount limit
- Rolling 24-hour daily limit (auto-resets)
- Emergency lock (owner only, disables all AI decisions)
- Only vault owner can make decisions and withdrawals

## AI Agent: GPT-4o-mini

**Model**: `gpt-4o-mini` — fast, cheap ($0.00009/decision), sufficient for financial analysis

**What it analyzes**:
- Current lending APYs across Kamino and Marginfi
- Risk levels of each protocol
- Portfolio balance and existing positions

**What it outputs** (structured JSON):
```json
{
  "action": "lend",
  "asset": "USDC",
  "amount": 100,
  "protocol": "kamino",
  "reasoning": "Kamino offers higher APY (8.2% vs 7.1%) with similar risk",
  "confidence": 85,
  "riskLevel": "low"
}
```

The `reasoning` field is SHA-256 hashed and stored on-chain. Full reasoning stored off-chain for transparency.

## Components

### Smart Contract (`/contracts`)
- Anchor program on Solana
- 7 instructions, 2 account types
- PDA-based architecture

### Backend Gateway (`/backend`)
- Hono HTTP server
- 51 API services (OpenAI, Anthropic, Gemini, Brave, Jupiter, etc.)
- Payment verification via Helius RPC
- AI agent (GPT-4o-mini)
- Redis replay protection + PostgreSQL logging

### SDK (`/package/packages/sdk`)
- TypeScript SDK: `@solobank/sdk`
- Wallet management with AES-256-GCM encryption
- Lending (Kamino + Marginfi), Swap (Jupiter), Send, Pay
- Safeguards: per-tx limits, daily limits, lock/unlock

### MCP Server (`/package/packages/mcp`)
- `@solobank/mcp` — 15 tools for AI assistants
- Works with Claude Desktop, Cursor, Windsurf
- Auto-install: `solobank mcp install`

### CLI (`/package/packages/cli`)
- `@solobank/cli`
- Install: `curl -fsSL https://solobank.lol/install.sh | bash`
- Commands: init, balance, send, swap, lend, borrow, repay, rebalance, lock/unlock

### Frontend (`/frontend`)
- Next.js 16 + React 19 on Vercel
- Service catalog, live stats, documentation
- https://solobank.lol

### Skills (`/solobank-skills`)
- 11 agent skills for Claude Code, Cursor, Copilot
- `npx skills add solobank-ai/solobank-skills`

## Demo

### Quick Start
```bash
# Install
curl -fsSL https://solobank.lol/install.sh | bash

# Check balance
solobank balance

# AI manages your vault via MCP
solobank mcp install
# → Claude/Cursor now has 15 DeFi tools
```

### Live Gateway
```bash
# Try the payment gateway (devnet)
curl -X POST http://130.61.175.254:3001/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hello"}]}'
# → 402 Payment Required (pay with SOL/USDC to proceed)
```

### Mainnet Test Results
```
Settlement:  1361ms (Solana finality)
Verify:       355ms (Helius getTransaction)
Total:       3917ms (including OpenAI response)
Cost:        $0.005 USDC + ~$0.001 gas
```

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contract | Anchor 0.30 + Rust |
| Backend | Hono + Node.js + TypeScript |
| AI | OpenAI GPT-4o-mini |
| RPC | Helius (mainnet + devnet) |
| Database | PostgreSQL 16 + Redis 7 |
| Frontend | Next.js 16 + React 19 |
| SDK | TypeScript + @solana/kit |
| Protocols | Kamino, Marginfi, Jupiter |
| Deploy | Docker + GitHub Actions CI/CD |

## Repositories

| Repo | Description |
|---|---|
| [solobank-ai/contracts](https://github.com/solobank-ai/contracts) | Anchor smart contract |
| [solobank-ai/backend](https://github.com/solobank-ai/backend) | Gateway + AI agent |
| [solobank-ai/package](https://github.com/solobank-ai/package) | SDK + MCP + CLI |
| [solobank-ai/solobank_frontend](https://github.com/solobank-ai/solobank_frontend) | Frontend |
| [solobank-ai/solobank-skills](https://github.com/solobank-ai/solobank-skills) | Agent Skills |

## Team

Solobank — Decentrathon 5.0

## License

MIT
