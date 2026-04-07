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

## Quickstart (devnet)

```bash
git clone https://github.com/solobank-ai/contracts.git
cd contracts
yarn install

# 1. Point Solana CLI at devnet and fund the deploy wallet
solana config set --url https://api.devnet.solana.com
solana airdrop 2

# 2. Build both programs
anchor build

# 3. Run the test suite (proves contracts work end-to-end against localnet)
anchor test

# 4. Deploy to devnet
anchor deploy --provider.cluster devnet

# 5. Initialise an AI Vault for devnet USDC (one time, by the admin)
#    See agent/scripts/init-vault.ts (or use the SDK directly).

# 6. Deterministic demo tick — no OpenAI key needed
cd agent
pnpm install
cp .env.example .env   # fill in oracle keypair + program id
pnpm tsx scripts/demo-tick.ts allocate
# → prints a Solscan devnet link to the on-chain decision
```

The reserved devnet program ID is
[`74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9`](https://solscan.io/account/74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9?cluster=devnet)
— hard-coded in `Anchor.toml`, `programs/ai-vault/src/lib.rs` (`declare_id!`),
the agent `.env.example`, and `@solobank/sdk` (`AI_VAULT_PROGRAM_ID`).

## End-user surfaces

Once deployed, every wallet talks to the vault via:

| Surface | Command / tool |
|---|---|
| CLI | `solobank vault info` / `position` / `deposit <amount>` / `withdraw <shares>` / `decisions` |
| MCP (Claude / agents) | `solobank_vault_info`, `solobank_vault_position`, `solobank_vault_decisions`, `solobank_vault_deposit`, `solobank_vault_withdraw` |
| SDK | `import { vaultDeposit, vaultWithdraw, getVault, getRecentDecisions } from '@solobank/sdk'` |

## Live demo (devnet)

The full happy path is deployed and verifiable on Solana devnet right now.
Click any link to see the actual on-chain account / transaction.

**Program:** [`74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9`](https://solscan.io/account/74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9?cluster=devnet)
**Vault PDA:** [`DhSrRebGTh6arqLSkXaAjXeN9nggQXT1sk413r7uyRd6`](https://solscan.io/account/DhSrRebGTh6arqLSkXaAjXeN9nggQXT1sk413r7uyRd6?cluster=devnet)
**Asset mint (test USDC):** `2GUgqi7x96YNfag52mpPa5ug8egvux2aidabbQnp3sin`
**AI Oracle:** [`5DZBWHU97cVowTBq6CpzpL6TTLYy7kSZY2AxT8KDPFcn`](https://solscan.io/account/5DZBWHU97cVowTBq6CpzpL6TTLYy7kSZY2AxT8KDPFcn?cluster=devnet)

| # | Step | Tx |
|---|---|---|
| 1 | Program deploy | [`4etYAH…YTwQ`](https://solscan.io/tx/4etYAHW4QmdBUS9U8sVNksopniAbRSdFWtER4mk7p6g6Jux6kRXmhpLw8DWrxQpLh72P7genQX9ajR7dJPziYTwQ?cluster=devnet) |
| 2 | `initialize_vault` | [`54V2Gi…3r6K`](https://solscan.io/tx/54V2Gidrc674579hmbGCBabP88tRaQqc7ht24s9ez9wcrjPSjqyeDwLMvqtQ5DGrGXer464Sv9t6KT6WeqBF3r6K?cluster=devnet) |
| 3 | `deposit` 1000 USDC | [`55ZKz7…jDh`](https://solscan.io/tx/55ZKz7PpeLDZTRfGGvozwebcM1r52sramjUwK1MymJbnUQL9mNtWKR3KaJMTcwHdNw9RcEY43LoXavNRJ53gEjDh?cluster=devnet) |
| 4 | AI Oracle `ai_allocate` 500 → KAMINO_USDC (conf 87) | [`31NVrL…ykHm`](https://solscan.io/tx/31NVrLnQ5JpdVr6ogojRC6vEqCMTScGZdKpFt9M7P28jGfRw2soc52prfpY6Q3jXuPCePifixcAR4RnoWdhGykHm?cluster=devnet) |
| 5 | AI Oracle `ai_rebalance` → MARGINFI_USDC (conf 91) | [`39TZ2B…swg`](https://solscan.io/tx/39TZ2B1zw1hQrJVVvzP5STu234xPDLLhQ3as2cM2iDUbV4ePNEX8bHEB6ww2hEy1QsGA6t9BfVVwyckCVh1twswg?cluster=devnet) |
| 6 | AI Oracle `ai_risk_off` → IDLE (conf 95) | [`2xUquD…Tv2M`](https://solscan.io/tx/2xUquDJgfkBWxMkgEigUurM1XpUdrKxyUFkYTfPuUKhPg28QtuWZbWPDhtqxxqjp5EVHCYYMB8ry4xxoWQJNTv2M?cluster=devnet) |

The three AI decisions are stored as PDA accounts and are independently
verifiable by anyone with the program ID:

| Decision id | PDA | Reasoning hash (sha256) |
|---|---|---|
| 0 | [`HVUxGv…Xhca`](https://solscan.io/account/HVUxGvffy6K71c6Fm5JRwg7eh2BfMzBZuz99ACGeXhca?cluster=devnet) | `e90de2291338e3403c644008d64634cf6e89ffa36ca10a2cf5b417ddd9141ef8` |
| 1 | [`3gNkv6…8eWh`](https://solscan.io/account/3gNkv6d2mEaH9MUuk9RfUciNfXJ87HnouYtoBdY38eWh?cluster=devnet) | `70ded1c48bbf12e57cc88ffdc02462986a9a15dc2579b575a7aa2a1fd356fd6e` |
| 2 | [`FPqk3r…q24L`](https://solscan.io/account/FPqk3r42uFE4NvhWZFqgafwnMYehAox2XBCCmQmTq24L?cluster=devnet) | `b77f616f656f99d59101022823e4ae886b2748deb3e82e74f0e55baa8b5caeea` |

To verify a hash off-chain (e.g. for decision 0):

```bash
echo -n "Kamino USDC APY at 6.42% with \$12.4M utilisation depth — best risk-adjusted return right now. SOL volatility 24h at 2.3% (below 5% threshold). Allocating 500 USDC of liquid balance." \
  | sha256sum
# → e90de2291338e3403c644008d64634cf6e89ffa36ca10a2cf5b417ddd9141ef8
```

Open any of the AI Oracle txs above. You'll see the `AiDecision` PDA being
created with the exact strategy, amount, confidence, and reasoning hash from
the script — the same data the on-chain program enforced.

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
| `ai_vault` | `74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9` (devnet) |

## License

MIT
