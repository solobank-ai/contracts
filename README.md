# Solobank Contracts

Smart contracts that turn an AI agent into a first-class participant on Solana.

> Built for **Decentrathon 5.0 — Case 2: AI + Blockchain (Autonomous Smart Contracts)**.

```
                ┌─────────────────────────────┐
                │   off-chain AI Oracle       │
                │   (gpt-4o-mini)             │
                │   /agent                    │
                └──────────────┬──────────────┘
                  market data  │  signed tx
                               ▼
┌──────────┐  deposit  ┌────────────────────┐  reads / verifies
│  user    │──────────▶│  ai_vault          │◀──────────────────┐
│ (or AI)  │           │  programs/ai-vault │                   │
└──────────┘           └─────────┬──────────┘                   │
      ▲                          │                              │
      │                 emits AiAllocated /                     │
      │                 AiRebalanced / AiRiskOff                │
      │                          │                              │
      │                  ┌───────▼─────────┐           ┌────────┴───────┐
      │                  │  AiDecision PDA │           │  @solobank/sdk │
      │                  │  audit trail    │           │  vault.ts      │
      │                  └─────────────────┘           └────────────────┘
      │                                                         ▲
      │                                                         │
      └────────────── solobank vault deposit / withdraw ────────┘
                              (CLI / MCP / web)
```

## What's in the repo

| Path | What it is |
|---|---|
| `programs/contracts` | Treasury fee collection contract — extended with AI Oracle instructions for dynamic fee management. |
| `programs/ai-vault` | Autonomous yield vault. Users deposit; an AI Oracle decides allocation strategy on-chain. |
| `agent` | Off-chain Node.js process that calls OpenAI, hashes the reasoning, signs the decision, and submits it. |
| `tests` | Anchor mocha tests covering both programs. |

## The two contracts

### 1. `contracts` — Treasury with AI fees

The original treasury collected static fees on save / borrow / swap (10/5/10 bps).
The AI extension adds:

- **`ai_update_fees(save_bps, borrow_bps, swap_bps, confidence, reasoning_hash)`**
  AI Oracle re-prices fees based on market conditions. Confidence floor: 70.
- **`record_ai_decision(decision_type, asset, amount, confidence, reasoning_hash)`**
  Stand-alone audit record for any AI decision the off-chain agent wants to anchor.
- **`set_ai_oracle(new_oracle)`** — admin rotation.

### 2. `ai-vault` — Autonomous yield vault

A new program. Users deposit a single asset (e.g. USDC), receive shares, and an
AI Oracle drives the allocation strategy.

| Instruction | Caller | What it does |
|---|---|---|
| `initialize_vault(ai_oracle)` | admin | Creates the vault PDA + token account for an asset mint. |
| `deposit(amount)` | user | Transfers tokens in, mints shares (1:1 bootstrap, pro-rata after). |
| `withdraw(shares)` | user | Burns shares, returns tokens. Caps at `total_deposits - allocated_amount`. |
| `ai_allocate(strategy, amount, confidence, reasoning_hash)` | AI Oracle | Commits liquid funds to a strategy bucket. |
| `ai_rebalance(strategy, confidence, reasoning_hash)` | AI Oracle | Moves entire allocation between strategies. |
| `ai_risk_off(confidence, reasoning_hash)` | AI Oracle | Pulls everything back to idle (volatility kill-switch). |
| `set_ai_oracle(new_oracle)` | admin | Key rotation. |
| `set_paused(paused)` | admin | Emergency stop. |

**Account model**

```
Vault          PDA  ["vault", asset_mint]
VaultAuthority PDA  ["vault-auth", vault]              # signs SPL transfers out
UserPosition   PDA  ["position", vault, user]
AiDecision     PDA  ["ai-vault-decision", vault, id]   # one per AI call, sequential id
```

**Audit invariant**

Every AI call writes an `AiDecision` PDA containing the SHA-256 hash of the
LLM's reasoning text. The full reasoning lives off-chain (logs, IPFS, etc).
Anyone can re-derive the hash and prove it matches what's on chain — so the
agent cannot retroactively change its story.

```ts
import { createHash } from "node:crypto";
const recomputed = createHash("sha256").update(reasoningText).digest();
assert(Buffer.from(decision.reasoningHash).equals(recomputed));
```

The on-chain program rejects any decision with `confidence < 70`
(`MIN_AI_CONFIDENCE`) so a low-quality model output cannot move funds.

## The off-chain agent

`agent/src/index.ts` is a single-file Node.js loop:

1. `snapshotMarket()` — APY of Kamino / Marginfi / Drift, SOL volatility,
   current vault state. Stubs in this version, real APIs in v2.
2. `askLLM(snapshot)` — `gpt-4o-mini` with `response_format: json_object`
   and a strict system prompt. Returns
   `{ action, target_strategy, amount_usdc, confidence, reasoning }`.
3. `sha256(reasoning)` → 32 bytes that go on chain.
4. Build `ai_allocate` / `ai_rebalance` / `ai_risk_off` instruction (Anchor
   discriminator computed locally — no IDL dependency), sign with the oracle
   key, send.

Run modes: `pnpm dev` (loop, default 15 min), `pnpm once` (single tick).

## Quickstart

```bash
git clone https://github.com/solobank-ai/contracts.git
cd contracts
yarn install

# 1. Build both programs
anchor build

# 2. Run the test suite (proves contracts work end-to-end)
anchor test

# 3. Deploy to devnet (one time)
anchor deploy --provider.cluster devnet

# 4. Deterministic demo tick — no OpenAI key needed
cd agent
pnpm install
cp .env.example .env   # fill in oracle keypair + program id
pnpm tsx scripts/demo-tick.ts allocate
# → prints a Solscan link to the on-chain decision
```

## Live demo

After running the demo tick the agent prints a link like:

```
✓ confirmed
Signature: 5mRx3kLpAiVau1tDemoTickSignaturE4vGh8mKp...
Solscan  : https://solscan.io/tx/5mRx...?cluster=devnet
```

Open it. You'll see the `AiDecision` PDA being created with the exact
strategy, amount, confidence, and reasoning hash from the script — the same
data the on-chain program enforced.

## Hackathon mapping

| Criterion | Where to look |
|---|---|
| **Product (20)** | `README.md` quickstart + the `agent/` README — end-to-end story from user deposit → AI decision → on-chain audit. |
| **Technical (25)** | `programs/ai-vault/src/lib.rs` — PDA model, share accounting, confidence floor, oracle constraint, event emission. |
| **Solana usage (15)** | Native Anchor program, SPL Token via `TokenInterface`, PDA-signed transfers, `init_if_needed` positions. |
| **Innovation (15)** | On-chain SHA-256 reasoning hash makes the AI's *judgement* itself auditable, not just its actions. |
| **UX (10)** | `@solobank/sdk` → CLI (`solobank vault ...`) and MCP tools (Claude Desktop / web) wrap every method. |
| **Demo (10)** | `agent/scripts/demo-tick.ts` — one command, real tx, Solscan link. |
| **Docs (5)** | This file + `agent/README.md` + per-instruction doc comments in the Rust source. |

## Programs

| Program | Program ID |
|---|---|
| `contracts` (Treasury) | `9xpLht8FtpZgEGFpHpC6W3pupoHbfTsBMytj7CqxJ8us` |
| `ai_vault` | `AiVau1tSo1obankAiVau1tSo1obankAiVau1tSo1o` |

## License

MIT
