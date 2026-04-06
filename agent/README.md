# Solobank AI Oracle Agent

Off-chain agent that drives the on-chain `ai_vault` program. Built for
Decentrathon 5.0 — Case 2: AI + Blockchain.

## How it works

```
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐
│ market data │──▶│   GPT-4o    │──▶│  signed Solana tx │
│ (APY, vol)  │    │   -mini     │    │  → ai_vault       │
└─────────────┘    └─────────────┘    └──────────────────┘
                          │                     │
                    reasoning text       reasoning_hash
                          │                     │
                          └─── sha256 ─────────┘
```

Every tick (default: every 15 minutes):

1. Build a market snapshot (APYs of Kamino / Marginfi / Drift, SOL volatility,
   current vault state).
2. Send it to OpenAI with a structured-output system prompt. The model
   responds with one of: `allocate` / `rebalance` / `risk_off` / `hold`.
3. SHA-256 the model's reasoning string. This hash is the on-chain
   audit anchor — anyone can re-derive it from the off-chain reasoning to
   verify nothing was tampered with.
4. Build the corresponding instruction (`ai_allocate`, `ai_rebalance`,
   `ai_risk_off`), sign with the oracle keypair, submit to mainnet/devnet.

The on-chain program rejects any decision with `confidence < 70` and stores
the full decision metadata in a PDA so judges (or anyone) can audit the
agent's behaviour from a block explorer.

## Setup

```bash
pnpm install
cp .env.example .env
# fill in OPENAI_API_KEY, AI_ORACLE_KEYPAIR, VAULT_ASSET_MINT

# single tick (good for demos)
pnpm once

# infinite loop
pnpm dev
```

## Environment

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI key (gpt-4o-mini) |
| `OPENAI_MODEL` | Model id, default `gpt-4o-mini` |
| `SOLANA_RPC_URL` | RPC endpoint |
| `AI_ORACLE_KEYPAIR` | Path to oracle keypair JSON (must match `vault.ai_oracle`) |
| `AI_VAULT_PROGRAM_ID` | Deployed `ai_vault` program id |
| `VAULT_ASSET_MINT` | Mint of the asset the vault manages (e.g. USDC) |
| `INTERVAL_SECONDS` | Loop interval, default 900 |
| `MIN_CONFIDENCE` | Local threshold (must be ≥ on-chain `MIN_AI_CONFIDENCE = 70`) |

## Verifying a decision

Every submitted tx writes an `AiDecision` PDA. The seeds are:

```
["ai-vault-decision", vault_pubkey, decision_id_le_u64]
```

To verify a reasoning string matches what's on chain:

```ts
const hash = sha256(reasoning);                    // off-chain
const onchain = (await program.account.aiDecision.fetch(pda)).reasoningHash;
assert(Buffer.from(onchain).equals(hash));         // proven
```

## Roadmap

- [ ] Replace stubbed market data with real Kamino / Marginfi / Drift API calls
- [ ] Add a second LLM as cross-checker before high-confidence allocations
- [ ] Stream reasoning text to a content-addressed store (Arweave/IPFS) so
      judges can resolve the hash → original text without trusting the agent
