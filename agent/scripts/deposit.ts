// Quick deposit script — admin deposits tokens into the vault.
// Wraps @solobank/sdk vaultDeposit() so the demo can show real liquid
// balance before the AI Oracle allocates.
//
// Usage:
//   pnpm tsx scripts/deposit.ts <amount>

import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
} from "@solana/kit";
import { vaultDeposit } from "@solobank/sdk";

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

const RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const ADMIN_PATH = env("ADMIN_KEYPAIR");
const ASSET_MINT = address(env("VAULT_ASSET_MINT"));

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) {
    console.error("usage: deposit.ts <amount-in-tokens>");
    process.exit(1);
  }
  const amount = BigInt(Math.floor(Number(amountArg) * 1_000_000));

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws"));
  const secret = Uint8Array.from(JSON.parse(readFileSync(ADMIN_PATH, "utf8")) as number[]);
  const payer = await createKeyPairSignerFromBytes(secret);

  console.log(`Depositing ${amountArg} tokens (${amount}) from ${payer.address}…`);

  const result = await vaultDeposit({
    rpc,
    rpcSubscriptions,
    payer,
    assetMint: ASSET_MINT,
    amount,
  });

  console.log("✓ deposited");
  console.log(`  vault     : ${result.vault}`);
  console.log(`  amount    : ${result.amount}`);
  console.log(`  shares    : ${result.shares}`);
  console.log(`  signature : ${result.signature}`);
  console.log(`  solscan   : https://solscan.io/tx/${result.signature}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
