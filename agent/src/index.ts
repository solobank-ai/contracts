// Solobank AI Oracle Agent
//
// Periodically asks an LLM to evaluate the lending market and decide what
// the AI Vault should do (allocate / rebalance / risk-off / hold). The
// reasoning text is hashed (SHA-256) and the resulting decision is signed
// by the oracle keypair and submitted to the on-chain ai_vault program.
//
// Run modes:
//   pnpm dev          → infinite loop, every INTERVAL_SECONDS
//   pnpm once         → single tick, then exit (useful for cron / demos)

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import OpenAI from "openai";

// ── Config ──────────────────────────────────────────────────────────────────

const env = (key: string, fallback?: string) => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
};

const OPENAI_KEY = env("OPENAI_API_KEY");
const OPENAI_MODEL = env("OPENAI_MODEL", "gpt-4o-mini");
const RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const ORACLE_KP_PATH = env("AI_ORACLE_KEYPAIR");
const PROGRAM_ID = new PublicKey(env("AI_VAULT_PROGRAM_ID"));
const ASSET_MINT = new PublicKey(env("VAULT_ASSET_MINT"));
const INTERVAL = Number(env("INTERVAL_SECONDS", "900"));
const MIN_CONFIDENCE = Number(env("MIN_CONFIDENCE", "70"));

// ── Strategy enum (must match on-chain) ────────────────────────────────────

const STRATEGIES = {
  IDLE: 0,
  KAMINO_USDC: 1,
  MARGINFI_USDC: 2,
  KAMINO_JLP: 3,
  DRIFT_USDC: 4,
} as const;

const STRATEGY_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(STRATEGIES).map(([k, v]) => [v, k]),
);

// ── Decision schema returned by the LLM ────────────────────────────────────

type Action = "allocate" | "rebalance" | "risk_off" | "hold";

interface Decision {
  action: Action;
  target_strategy: keyof typeof STRATEGIES;
  amount_usdc: number;     // ignored for rebalance / risk_off / hold
  confidence: number;      // 0..100
  reasoning: string;       // human-readable, hashed on-chain
}

// ── Market snapshot (in production: query Kamino/Marginfi/Drift APIs) ──────

interface MarketSnapshot {
  timestamp: string;
  kamino_usdc_apy: number;
  marginfi_usdc_apy: number;
  drift_usdc_apy: number;
  sol_volatility_24h: number;
  vault_liquid_usdc: number;
  vault_allocated_usdc: number;
  vault_active_strategy: string;
}

async function snapshotMarket(): Promise<MarketSnapshot> {
  // TODO: replace with real API calls. Stubbed numbers are fine for the demo
  // — what matters is that the LLM sees a structured input and produces a
  // structured decision the chain can verify.
  return {
    timestamp: new Date().toISOString(),
    kamino_usdc_apy: 6.21 + Math.random() * 0.5,
    marginfi_usdc_apy: 8.10 + Math.random() * 0.5,
    drift_usdc_apy: 5.4 + Math.random() * 0.3,
    sol_volatility_24h: 2.1 + Math.random() * 4,
    vault_liquid_usdc: 800,
    vault_allocated_usdc: 200,
    vault_active_strategy: "KAMINO_USDC",
  };
}

// ── LLM call ───────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: OPENAI_KEY });

const SYSTEM_PROMPT = `You are the AI Oracle for the Solobank AI Vault on Solana.
Your job: analyse the market snapshot and produce ONE structured decision
for the vault. You must respond with valid JSON matching:

{
  "action":          "allocate" | "rebalance" | "risk_off" | "hold",
  "target_strategy": "IDLE" | "KAMINO_USDC" | "MARGINFI_USDC" | "KAMINO_JLP" | "DRIFT_USDC",
  "amount_usdc":     number,   // only used for "allocate"; otherwise 0
  "confidence":      number,   // integer 0..100, your confidence in the call
  "reasoning":       string    // 1-3 sentences, will be hashed on-chain
}

Rules:
- "allocate"   → move liquid → strategy. Pick the highest-APY safe option.
- "rebalance"  → move all allocated funds to a different strategy.
- "risk_off"   → pull everything back to IDLE (use when volatility spikes).
- "hold"       → no transaction this tick.
- Confidence < 70 means the on-chain program will REJECT the call. Be honest.
- Prefer "hold" over noisy decisions.
- Never invent strategies that are not in the enum.`;

async function askLLM(snapshot: MarketSnapshot): Promise<Decision> {
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(snapshot, null, 2) },
    ],
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("LLM returned empty content");
  return JSON.parse(raw) as Decision;
}

// ── On-chain helpers ───────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function vaultPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    PROGRAM_ID,
  );
}

function decisionPda(vault: PublicKey, decisionId: BN): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(decisionId.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ai-vault-decision"), vault.toBuffer(), idBuf],
    PROGRAM_ID,
  );
}

// Anchor instruction discriminators (sha256("global:<name>")[..8])
function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

interface BuiltIx {
  ix: TransactionInstruction;
  decisionPda: PublicKey;
}

function buildAiAllocateIx(
  vault: PublicKey,
  decisionId: BN,
  oracle: PublicKey,
  payer: PublicKey,
  targetStrategy: number,
  amount: BN,
  confidence: number,
  reasoningHash: Buffer,
): BuiltIx {
  const [decision] = decisionPda(vault, decisionId);
  const data = Buffer.concat([
    discriminator("ai_allocate"),
    Buffer.from([targetStrategy]),
    amount.toArrayLike(Buffer, "le", 8),
    Buffer.from([confidence]),
    reasoningHash,
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: decision, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, decisionPda: decision };
}

function buildAiRebalanceIx(
  vault: PublicKey,
  decisionId: BN,
  oracle: PublicKey,
  payer: PublicKey,
  targetStrategy: number,
  confidence: number,
  reasoningHash: Buffer,
): BuiltIx {
  const [decision] = decisionPda(vault, decisionId);
  const data = Buffer.concat([
    discriminator("ai_rebalance"),
    Buffer.from([targetStrategy]),
    Buffer.from([confidence]),
    reasoningHash,
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: decision, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, decisionPda: decision };
}

function buildAiRiskOffIx(
  vault: PublicKey,
  decisionId: BN,
  oracle: PublicKey,
  payer: PublicKey,
  confidence: number,
  reasoningHash: Buffer,
): BuiltIx {
  const [decision] = decisionPda(vault, decisionId);
  const data = Buffer.concat([
    discriminator("ai_risk_off"),
    Buffer.from([confidence]),
    reasoningHash,
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: decision, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, decisionPda: decision };
}

// Read vault.total_ai_decisions from chain (offset depends on Vault layout).
// Layout: 8 disc + 32 admin + 32 oracle + 32 mint + 32 vta + 8 deposits +
//         8 shares + 8 ai_decisions ...   → ai_decisions at offset 8+128+16 = 152
async function fetchVaultDecisionId(
  conn: Connection,
  vault: PublicKey,
): Promise<BN> {
  const acct = await conn.getAccountInfo(vault);
  if (!acct) throw new Error(`Vault account not found: ${vault.toBase58()}`);
  const slice = acct.data.subarray(152, 160);
  return new BN(slice, "le");
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function tick() {
  const conn = new Connection(RPC_URL, "confirmed");
  const oracle = loadKeypair(ORACLE_KP_PATH);
  const [vault] = vaultPda(ASSET_MINT);

  console.log(`[${new Date().toISOString()}] tick — vault=${vault.toBase58()}`);

  const snapshot = await snapshotMarket();
  console.log("  snapshot:", snapshot);

  const decision = await askLLM(snapshot);
  console.log("  decision:", decision);

  if (decision.action === "hold") {
    console.log("  → hold (no tx)");
    return;
  }
  if (decision.confidence < MIN_CONFIDENCE) {
    console.log(`  → confidence ${decision.confidence} < ${MIN_CONFIDENCE}, skipping`);
    return;
  }

  const reasoningHash = sha256(decision.reasoning);
  const targetIdx = STRATEGIES[decision.target_strategy];
  if (targetIdx === undefined) {
    console.log(`  → unknown strategy ${decision.target_strategy}, skipping`);
    return;
  }

  const decisionId = await fetchVaultDecisionId(conn, vault);

  let built: BuiltIx;
  switch (decision.action) {
    case "allocate":
      built = buildAiAllocateIx(
        vault,
        decisionId,
        oracle.publicKey,
        oracle.publicKey,
        targetIdx,
        new BN(Math.floor(decision.amount_usdc * 1_000_000)), // USDC = 6 dec
        decision.confidence,
        reasoningHash,
      );
      break;
    case "rebalance":
      built = buildAiRebalanceIx(
        vault,
        decisionId,
        oracle.publicKey,
        oracle.publicKey,
        targetIdx,
        decision.confidence,
        reasoningHash,
      );
      break;
    case "risk_off":
      built = buildAiRiskOffIx(
        vault,
        decisionId,
        oracle.publicKey,
        oracle.publicKey,
        decision.confidence,
        reasoningHash,
      );
      break;
    default:
      console.log("  → unsupported action");
      return;
  }

  const tx = new Transaction().add(built.ix);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(oracle);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  ✓ submitted ${decision.action} → strategy=${STRATEGY_NAME[targetIdx]} sig=${sig}`);
  console.log(`    decision PDA: ${built.decisionPda.toBase58()}`);
}

async function main() {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  console.log(`Solobank AI Oracle agent started — interval=${INTERVAL}s, model=${OPENAI_MODEL}`);
  // Fire immediately, then on interval.
  await tick().catch((e) => console.error("tick error:", e));
  setInterval(() => {
    tick().catch((e) => console.error("tick error:", e));
  }, INTERVAL * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
