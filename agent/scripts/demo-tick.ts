// Solobank AI Vault — deterministic demo tick
//
// Submits a hardcoded "AI decision" to the on-chain ai_vault program WITHOUT
// calling OpenAI. This lets a hackathon judge run a single command, get a
// real on-chain transaction, and click through to Solscan to verify that
// every field — strategy, amount, confidence, reasoning hash — is exactly
// what the agent claimed.
//
// Usage:
//   pnpm tsx scripts/demo-tick.ts allocate
//   pnpm tsx scripts/demo-tick.ts rebalance
//   pnpm tsx scripts/demo-tick.ts risk-off
//
// Required env (see .env.example):
//   SOLANA_RPC_URL, AI_ORACLE_KEYPAIR, AI_VAULT_PROGRAM_ID, VAULT_ASSET_MINT

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

// ── Config ──────────────────────────────────────────────────────────────────

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const ORACLE_PATH = env("AI_ORACLE_KEYPAIR");
const PROGRAM_ID = new PublicKey(env("AI_VAULT_PROGRAM_ID"));
const ASSET_MINT = new PublicKey(env("VAULT_ASSET_MINT"));

// ── Hardcoded "AI decisions" — what the LLM would have produced ────────────

const SCRIPTED = {
  allocate: {
    fn: "ai_allocate" as const,
    target_strategy: 1, // KAMINO_USDC
    amount: new BN(500_000_000), // 500 USDC (6 dec)
    confidence: 87,
    reasoning:
      "Kamino USDC APY at 6.42% with $12.4M utilisation depth — best risk-adjusted return right now. SOL volatility 24h at 2.3% (below 5% threshold). Allocating 500 USDC of liquid balance.",
  },
  rebalance: {
    fn: "ai_rebalance" as const,
    target_strategy: 2, // MARGINFI_USDC
    confidence: 91,
    reasoning:
      "Marginfi USDC APY just crossed 8.41%, 199 bps above Kamino. Same custody risk profile. Rebalancing full allocation from KAMINO_USDC → MARGINFI_USDC.",
  },
  "risk-off": {
    fn: "ai_risk_off" as const,
    confidence: 95,
    reasoning:
      "SOL realised volatility jumped to 9.1% over the last hour (up from 2.3%). Lending protocol liquidations historically follow volatility spikes by 20-40 minutes. Pulling all allocated funds back to IDLE until the market stabilises.",
  },
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function vaultPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function decisionPda(vault: PublicKey, id: BN): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ai-vault-decision"), vault.toBuffer(), buf],
    PROGRAM_ID,
  )[0];
}

async function readDecisionId(conn: Connection, vault: PublicKey): Promise<BN> {
  const acct = await conn.getAccountInfo(vault);
  if (!acct) throw new Error(`Vault not found: ${vault.toBase58()}`);
  return new BN(acct.data.subarray(152, 160), "le");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const action = process.argv[2] as keyof typeof SCRIPTED | undefined;
  if (!action || !(action in SCRIPTED)) {
    console.error("usage: demo-tick.ts <allocate | rebalance | risk-off>");
    process.exit(1);
  }
  const decision = SCRIPTED[action];

  const conn = new Connection(RPC_URL, "confirmed");
  const oracle = loadKeypair(ORACLE_PATH);
  const vault = vaultPda(ASSET_MINT);

  console.log("───────────────────────────────────────────────");
  console.log("Solobank AI Vault — demo tick");
  console.log("───────────────────────────────────────────────");
  console.log(`Vault    : ${vault.toBase58()}`);
  console.log(`Oracle   : ${oracle.publicKey.toBase58()}`);
  console.log(`Action   : ${decision.fn}`);
  console.log(`Reasoning: ${decision.reasoning}`);

  const reasoningHash = sha256(decision.reasoning);
  console.log(`SHA-256  : ${reasoningHash.toString("hex")}`);

  const id = await readDecisionId(conn, vault);
  const decisionPdaAddr = decisionPda(vault, id);
  console.log(`Decision : id=${id.toString()}  pda=${decisionPdaAddr.toBase58()}`);

  // Build instruction data
  let data: Buffer;
  if (decision.fn === "ai_allocate") {
    data = Buffer.concat([
      discriminator("ai_allocate"),
      Buffer.from([decision.target_strategy]),
      decision.amount.toArrayLike(Buffer, "le", 8),
      Buffer.from([decision.confidence]),
      reasoningHash,
    ]);
  } else if (decision.fn === "ai_rebalance") {
    data = Buffer.concat([
      discriminator("ai_rebalance"),
      Buffer.from([decision.target_strategy]),
      Buffer.from([decision.confidence]),
      reasoningHash,
    ]);
  } else {
    data = Buffer.concat([
      discriminator("ai_risk_off"),
      Buffer.from([decision.confidence]),
      reasoningHash,
    ]);
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
      { pubkey: oracle.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: decisionPdaAddr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(oracle);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");

  const cluster = RPC_URL.includes("devnet") ? "devnet" : "mainnet";
  console.log("───────────────────────────────────────────────");
  console.log("✓ confirmed");
  console.log(`Signature: ${sig}`);
  console.log(`Solscan  : https://solscan.io/tx/${sig}?cluster=${cluster}`);
  console.log("───────────────────────────────────────────────");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
