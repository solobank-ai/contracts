// Solobank AI Oracle Agent
//
// Periodically asks an LLM to evaluate the lending market and decide what
// the AI Vault should do (allocate / rebalance / risk-off / hold). The
// reasoning text is hashed (SHA-256) and the resulting decision is signed
// by the oracle keypair and submitted to the on-chain ai_vault program.
//
// Built on @solana/kit — no @solana/web3.js anywhere.
//
// Run modes:
//   pnpm dev          → infinite loop, every INTERVAL_SECONDS
//   pnpm once         → single tick, then exit (useful for cron / demos)

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Address,
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  pipe,
  compileTransaction,
  signTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  assertIsTransactionWithinSizeLimit,
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  fetchEncodedAccount,
  type KeyPairSigner,
  type Instruction,
  type AccountRole,
} from "@solana/kit";
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
const PROGRAM_ID = address(env("AI_VAULT_PROGRAM_ID"));
const ASSET_MINT = address(env("VAULT_ASSET_MINT"));
const INTERVAL = Number(env("INTERVAL_SECONDS", "900"));
const MIN_CONFIDENCE = Number(env("MIN_CONFIDENCE", "70"));

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const READONLY: AccountRole = 0 as AccountRole;
const WRITABLE: AccountRole = 1 as AccountRole;
const READONLY_SIGNER: AccountRole = 2 as AccountRole;
const WRITABLE_SIGNER: AccountRole = 3 as AccountRole;

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

async function loadOracleSigner(path: string): Promise<KeyPairSigner> {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(secret);
}

function sha256(input: string): Uint8Array {
  const buf = createHash("sha256").update(input, "utf8").digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function discriminator(name: string): Uint8Array {
  const buf = createHash("sha256").update(`global:${name}`).digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, 8);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

const addressEncoder = getAddressEncoder();
const u64Encoder = getU64Encoder();

async function vaultPda(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode("vault"), addressEncoder.encode(mint)],
  });
  return pda;
}

async function decisionPda(vault: Address, id: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      new TextEncoder().encode("ai-vault-decision"),
      addressEncoder.encode(vault),
      u64Encoder.encode(id),
    ],
  });
  return pda;
}

// Read vault.total_ai_decisions from chain (offset depends on Vault layout).
// Layout: 8 disc + 32 admin + 32 oracle + 32 mint + 32 vta + 8 deposits +
//         8 shares + 8 ai_decisions ...   → ai_decisions at offset 8+128+16 = 152
async function fetchVaultDecisionId(
  rpc: ReturnType<typeof createSolanaRpc>,
  vault: Address,
): Promise<bigint> {
  const acct = await fetchEncodedAccount(rpc as any, vault);
  if (!acct.exists) throw new Error(`Vault account not found: ${vault}`);
  return readU64LE(acct.data, 152);
}

function buildAiInstruction(
  fn: "ai_allocate" | "ai_rebalance" | "ai_risk_off",
  args: {
    vault: Address;
    decision: Address;
    oracle: Address;
    targetStrategy?: number;
    amount?: bigint;
    confidence: number;
    reasoningHash: Uint8Array;
  },
): Instruction {
  let data: Uint8Array;
  if (fn === "ai_allocate") {
    data = concatBytes(
      discriminator("ai_allocate"),
      new Uint8Array([args.targetStrategy!]),
      u64LE(args.amount!),
      new Uint8Array([args.confidence]),
      args.reasoningHash,
    );
  } else if (fn === "ai_rebalance") {
    data = concatBytes(
      discriminator("ai_rebalance"),
      new Uint8Array([args.targetStrategy!]),
      new Uint8Array([args.confidence]),
      args.reasoningHash,
    );
  } else {
    data = concatBytes(
      discriminator("ai_risk_off"),
      new Uint8Array([args.confidence]),
      args.reasoningHash,
    );
  }
  return {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: args.oracle, role: READONLY_SIGNER },
      { address: args.oracle, role: WRITABLE_SIGNER },
      { address: args.vault, role: WRITABLE },
      { address: args.decision, role: WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: READONLY },
    ],
    data,
  };
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function tick() {
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws"));
  const oracle = await loadOracleSigner(ORACLE_KP_PATH);
  const vault = await vaultPda(ASSET_MINT);

  console.log(`[${new Date().toISOString()}] tick — vault=${vault}`);

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

  const decisionId = await fetchVaultDecisionId(rpc, vault);
  const decisionAddr = await decisionPda(vault, decisionId);

  let ix: Instruction;
  switch (decision.action) {
    case "allocate":
      ix = buildAiInstruction("ai_allocate", {
        vault, decision: decisionAddr, oracle: oracle.address,
        targetStrategy: targetIdx,
        amount: BigInt(Math.floor(decision.amount_usdc * 1_000_000)), // USDC = 6 dec
        confidence: decision.confidence,
        reasoningHash,
      });
      break;
    case "rebalance":
      ix = buildAiInstruction("ai_rebalance", {
        vault, decision: decisionAddr, oracle: oracle.address,
        targetStrategy: targetIdx,
        confidence: decision.confidence,
        reasoningHash,
      });
      break;
    case "risk_off":
      ix = buildAiInstruction("ai_risk_off", {
        vault, decision: decisionAddr, oracle: oracle.address,
        confidence: decision.confidence,
        reasoningHash,
      });
      break;
    default:
      console.log("  → unsupported action");
      return;
  }

  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(oracle.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );

  const compiled = compileTransaction(txMessage);
  const signed = await signTransaction([(oracle as any).keyPair], compiled);
  assertIsTransactionWithinSizeLimit(signed);

  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: rpc as any,
    rpcSubscriptions: rpcSubscriptions as any,
  });
  await sendAndConfirm(signed, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(signed);

  console.log(`  ✓ submitted ${decision.action} → strategy=${STRATEGY_NAME[targetIdx]} sig=${sig}`);
  console.log(`    decision PDA: ${decisionAddr}`);
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
