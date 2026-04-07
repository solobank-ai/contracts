// Solobank AI Vault — deterministic demo tick
//
// Submits a hardcoded "AI decision" to the on-chain ai_vault program WITHOUT
// calling OpenAI. This lets a hackathon judge run a single command, get a
// real on-chain transaction, and click through to Solscan to verify that
// every field — strategy, amount, confidence, reasoning hash — is exactly
// what the agent claimed.
//
// Built on @solana/kit — no @solana/web3.js anywhere.
//
// Usage:
//   pnpm tsx scripts/demo-tick.ts allocate
//   pnpm tsx scripts/demo-tick.ts rebalance
//   pnpm tsx scripts/demo-tick.ts risk-off

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

// ── Config ──────────────────────────────────────────────────────────────────

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const ORACLE_PATH = env("AI_ORACLE_KEYPAIR");
const PROGRAM_ID = address(env("AI_VAULT_PROGRAM_ID"));
const ASSET_MINT = address(env("VAULT_ASSET_MINT"));

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const READONLY: AccountRole = 0 as AccountRole;
const WRITABLE: AccountRole = 1 as AccountRole;
const READONLY_SIGNER: AccountRole = 2 as AccountRole;
const WRITABLE_SIGNER: AccountRole = 3 as AccountRole;

// ── Hardcoded "AI decisions" — what the LLM would have produced ────────────

const SCRIPTED = {
  allocate: {
    fn: "ai_allocate" as const,
    target_strategy: 1, // KAMINO_USDC
    amount: 500_000_000n, // 500 USDC (6 dec)
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

async function loadOracleSigner(path: string): Promise<KeyPairSigner> {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(secret);
}

function sha256(s: string): Uint8Array {
  const buf = createHash("sha256").update(s, "utf8").digest();
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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

async function readDecisionId(
  rpc: ReturnType<typeof createSolanaRpc>,
  vault: Address,
): Promise<bigint> {
  const acct = await fetchEncodedAccount(rpc as any, vault);
  if (!acct.exists) throw new Error(`Vault not found: ${vault}`);
  return new DataView(acct.data.buffer, acct.data.byteOffset + 152, 8).getBigUint64(0, true);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const action = process.argv[2] as keyof typeof SCRIPTED | undefined;
  if (!action || !(action in SCRIPTED)) {
    console.error("usage: demo-tick.ts <allocate | rebalance | risk-off>");
    process.exit(1);
  }
  const decision = SCRIPTED[action];

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws"));
  const oracle = await loadOracleSigner(ORACLE_PATH);
  const vault = await vaultPda(ASSET_MINT);

  console.log("───────────────────────────────────────────────");
  console.log("Solobank AI Vault — demo tick");
  console.log("───────────────────────────────────────────────");
  console.log(`Vault    : ${vault}`);
  console.log(`Oracle   : ${oracle.address}`);
  console.log(`Action   : ${decision.fn}`);
  console.log(`Reasoning: ${decision.reasoning}`);

  const reasoningHash = sha256(decision.reasoning);
  console.log(`SHA-256  : ${hex(reasoningHash)}`);

  const id = await readDecisionId(rpc, vault);
  const decisionAddr = await decisionPda(vault, id);
  console.log(`Decision : id=${id.toString()}  pda=${decisionAddr}`);

  let data: Uint8Array;
  if (decision.fn === "ai_allocate") {
    data = concatBytes(
      discriminator("ai_allocate"),
      new Uint8Array([decision.target_strategy]),
      u64LE(decision.amount),
      new Uint8Array([decision.confidence]),
      reasoningHash,
    );
  } else if (decision.fn === "ai_rebalance") {
    data = concatBytes(
      discriminator("ai_rebalance"),
      new Uint8Array([decision.target_strategy]),
      new Uint8Array([decision.confidence]),
      reasoningHash,
    );
  } else {
    data = concatBytes(
      discriminator("ai_risk_off"),
      new Uint8Array([decision.confidence]),
      reasoningHash,
    );
  }

  const ix: Instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: oracle.address, role: READONLY_SIGNER },
      { address: oracle.address, role: WRITABLE_SIGNER },
      { address: vault, role: WRITABLE },
      { address: decisionAddr, role: WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: READONLY },
    ],
    data,
  };

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
