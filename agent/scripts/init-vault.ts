// Solobank AI Vault — bootstrap script
//
// One-shot script that initialises an `ai_vault` for a given asset mint.
// Designed to run AFTER `anchor deploy --provider.cluster devnet`.
//
// Built on @solana/kit — no @solana/web3.js anywhere.
//
// What it does:
//   1. Derives the vault PDA + vault authority PDA from the asset mint.
//   2. Creates a fresh token account owned by the vault authority (the
//      Anchor `init` macro on `vault_token_account` finishes the setup).
//   3. Calls `initialize_vault` with the configured AI Oracle pubkey.
//   4. Prints the vault address + Solscan link.
//
// Usage:
//   pnpm tsx scripts/init-vault.ts
//
// Required env (see .env.example):
//   SOLANA_RPC_URL
//   AI_ORACLE_KEYPAIR        (path to JSON keypair — will become vault.ai_oracle)
//   AI_VAULT_PROGRAM_ID
//   VAULT_ASSET_MINT         (e.g. devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
//   ADMIN_KEYPAIR            (path to JSON keypair — funds the init + becomes vault.admin)

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
  generateKeyPairSigner,
  getProgramDerivedAddress,
  getAddressEncoder,
  fetchEncodedAccount,
  type KeyPairSigner,
  type Instruction,
  type AccountRole,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";

// ── Config ──────────────────────────────────────────────────────────────────

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const ORACLE_PATH = env("AI_ORACLE_KEYPAIR");
const ADMIN_PATH = env("ADMIN_KEYPAIR");
const PROGRAM_ID = address(env("AI_VAULT_PROGRAM_ID"));
const ASSET_MINT = address(env("VAULT_ASSET_MINT"));

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
const SPL_TOKEN_ACCOUNT_SIZE = 165n;

const READONLY: AccountRole = 0 as AccountRole;
const WRITABLE: AccountRole = 1 as AccountRole;
const READONLY_SIGNER: AccountRole = 2 as AccountRole;
const WRITABLE_SIGNER: AccountRole = 3 as AccountRole;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadSigner(path: string): Promise<KeyPairSigner> {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(secret);
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

const addressEncoder = getAddressEncoder();

async function vaultPda(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode("vault"), addressEncoder.encode(mint)],
  });
  return pda;
}

async function vaultAuthorityPda(vault: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [new TextEncoder().encode("vault-auth"), addressEncoder.encode(vault)],
  });
  return pda;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws"));
  const admin = await loadSigner(ADMIN_PATH);
  const oracle = await loadSigner(ORACLE_PATH);
  const vault = await vaultPda(ASSET_MINT);
  const vaultAuth = await vaultAuthorityPda(vault);

  console.log("───────────────────────────────────────────────");
  console.log("Solobank AI Vault — bootstrap");
  console.log("───────────────────────────────────────────────");
  console.log(`RPC          : ${RPC_URL}`);
  console.log(`Program ID   : ${PROGRAM_ID}`);
  console.log(`Asset mint   : ${ASSET_MINT}`);
  console.log(`Admin        : ${admin.address}`);
  console.log(`AI Oracle    : ${oracle.address}`);
  console.log(`Vault PDA    : ${vault}`);
  console.log(`Vault auth   : ${vaultAuth}`);

  // Refuse to re-init if vault already exists.
  const existing = await fetchEncodedAccount(rpc as any, vault);
  if (existing.exists) {
    console.log("\n✗ Vault already initialised. Aborting.");
    process.exit(1);
  }

  // Generate a fresh keypair for the vault token account; the Anchor program
  // takes care of the SPL Token init step inside `initialize_vault`.
  const vaultTokenAccount = await generateKeyPairSigner();
  console.log(`Vault TA     : ${vaultTokenAccount.address}`);

  // Pre-create the token account so the program's `init` constraint can
  // attach to a System-owned, rent-exempt account of the right size.
  const lamports = await rpc
    .getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_SIZE)
    .send();

  const createTaIx = getCreateAccountInstruction({
    payer: admin,
    newAccount: vaultTokenAccount,
    lamports,
    space: SPL_TOKEN_ACCOUNT_SIZE,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });

  // initialize_vault instruction:
  //   discriminator(8) + ai_oracle: Pubkey(32)
  const initData = concatBytes(
    discriminator("initialize_vault"),
    addressEncoder.encode(oracle.address),
  );

  const initIx: Instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: admin.address, role: WRITABLE_SIGNER },
      { address: vault, role: WRITABLE },
      { address: vaultAuth, role: READONLY },
      { address: ASSET_MINT, role: READONLY },
      { address: vaultTokenAccount.address, role: WRITABLE_SIGNER },
      { address: TOKEN_PROGRAM_ADDRESS, role: READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: READONLY },
      { address: SYSVAR_RENT, role: READONLY },
    ],
    data: initData,
  };

  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(admin.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([createTaIx, initIx], m),
  );

  const compiled = compileTransaction(txMessage);
  const signed = await signTransaction(
    [(admin as any).keyPair, (vaultTokenAccount as any).keyPair],
    compiled,
  );
  assertIsTransactionWithinSizeLimit(signed);

  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: rpc as any,
    rpcSubscriptions: rpcSubscriptions as any,
  });
  await sendAndConfirm(signed, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(signed);

  const cluster = RPC_URL.includes("devnet") ? "devnet" : "mainnet";
  console.log("───────────────────────────────────────────────");
  console.log("✓ vault initialised");
  console.log(`Signature : ${sig}`);
  console.log(`Solscan   : https://solscan.io/tx/${sig}?cluster=${cluster}`);
  console.log(`Vault     : https://solscan.io/account/${vault}?cluster=${cluster}`);
  console.log("───────────────────────────────────────────────");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
