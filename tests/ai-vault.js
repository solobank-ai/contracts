// Solobank AI Vault — happy path + AI Oracle integration tests
//
// What this proves:
//   1. Vault can be initialised under an arbitrary asset mint.
//   2. Users can deposit and the share accounting is correct.
//   3. The AI Oracle can submit allocate / rebalance / risk-off decisions
//      and they are recorded on-chain in `AiDecision` PDAs that anyone
//      can read and verify (id, decision_type, confidence, reasoning_hash).
//   4. The on-chain confidence floor (>= 70) actually rejects bad calls.
//   5. A non-oracle signer cannot impersonate the oracle.
//   6. Users can withdraw (against liquid funds only).

const anchor = require("@coral-xyz/anchor");
const { BN } = anchor;
const {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} = require("@solana/spl-token");
const { createHash } = require("crypto");
const assert = require("assert");

const VAULT_SEED = Buffer.from("vault");
const VAULT_AUTH_SEED = Buffer.from("vault-auth");
const POSITION_SEED = Buffer.from("position");
const DECISION_SEED = Buffer.from("ai-vault-decision");

const STRATEGY = {
  IDLE: 0,
  KAMINO_USDC: 1,
  MARGINFI_USDC: 2,
  KAMINO_JLP: 3,
  DRIFT_USDC: 4,
};

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();

function decisionPda(programId, vault, id) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync(
    [DECISION_SEED, vault.toBuffer(), idBuf],
    programId,
  )[0];
}

describe("ai-vault", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.aiVault;
  const connection = provider.connection;

  // Actors
  const admin = provider.wallet;
  const oracle = Keypair.generate();
  const attacker = Keypair.generate();
  const user = Keypair.generate();

  let mint;
  let vault;
  let vaultAuthority;
  let vaultTokenAccount;
  let userAta;

  before(async () => {
    // Fund test signers
    for (const kp of [oracle, attacker, user]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create a fake USDC-like mint (6 decimals)
    mint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      6,
    );

    // Derive vault PDAs
    vault = PublicKey.findProgramAddressSync(
      [VAULT_SEED, mint.toBuffer()],
      program.programId,
    )[0];
    vaultAuthority = PublicKey.findProgramAddressSync(
      [VAULT_AUTH_SEED, vault.toBuffer()],
      program.programId,
    )[0];

    // User ATA + mint 1000 tokens to user
    userAta = await createAssociatedTokenAccount(
      connection,
      user,
      mint,
      user.publicKey,
    );
    await mintTo(
      connection,
      admin.payer,
      mint,
      userAta,
      admin.payer,
      1000n * 1_000_000n, // 1000 USDC
    );
  });

  it("initialises a vault", async () => {
    const vaultTa = Keypair.generate();
    vaultTokenAccount = vaultTa.publicKey;

    await program.methods
      .initializeVault(oracle.publicKey)
      .accounts({
        admin: admin.publicKey,
        vault,
        vaultAuthority,
        assetMint: mint,
        vaultTokenAccount: vaultTa.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([vaultTa])
      .rpc();

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.admin.toBase58(), admin.publicKey.toBase58());
    assert.strictEqual(v.aiOracle.toBase58(), oracle.publicKey.toBase58());
    assert.strictEqual(v.assetMint.toBase58(), mint.toBase58());
    assert.strictEqual(v.totalDeposits.toNumber(), 0);
    assert.strictEqual(v.totalShares.toNumber(), 0);
    assert.strictEqual(v.totalAiDecisions.toNumber(), 0);
    assert.strictEqual(v.activeStrategy, 0);
    assert.strictEqual(v.paused, false);
  });

  it("user deposits 1000 USDC and gets 1000 shares (1:1 bootstrap)", async () => {
    const position = PublicKey.findProgramAddressSync(
      [POSITION_SEED, vault.toBuffer(), user.publicKey.toBuffer()],
      program.programId,
    )[0];

    await program.methods
      .deposit(new BN(1000 * 1_000_000))
      .accounts({
        user: user.publicKey,
        vault,
        position,
        assetMint: mint,
        userTokenAccount: userAta,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.userPosition.fetch(position);
    assert.strictEqual(pos.shares.toNumber(), 1000 * 1_000_000);
    assert.strictEqual(pos.deposited.toNumber(), 1000 * 1_000_000);

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.totalDeposits.toNumber(), 1000 * 1_000_000);
    assert.strictEqual(v.totalShares.toNumber(), 1000 * 1_000_000);

    const vta = await getAccount(connection, vaultTokenAccount);
    assert.strictEqual(Number(vta.amount), 1000 * 1_000_000);
  });

  it("AI Oracle allocates 500 USDC into KAMINO_USDC", async () => {
    const reasoning = "Kamino USDC APY 6.4% is currently the safest yield with deepest liquidity. Volatility is low at 2.3%.";
    const reasoningHash = sha256(reasoning);

    const decision = decisionPda(program.programId, vault, 0);

    await program.methods
      .aiAllocate(
        STRATEGY.KAMINO_USDC,
        new BN(500 * 1_000_000),
        87,
        Array.from(reasoningHash),
      )
      .accounts({
        aiOracle: oracle.publicKey,
        payer: oracle.publicKey,
        vault,
        decision,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.allocatedAmount.toNumber(), 500 * 1_000_000);
    assert.strictEqual(v.activeStrategy, STRATEGY.KAMINO_USDC);
    assert.strictEqual(v.totalAiDecisions.toNumber(), 1);

    const d = await program.account.aiDecision.fetch(decision);
    assert.strictEqual(d.id.toNumber(), 0);
    assert.strictEqual(d.decisionType, 1); // allocate
    assert.strictEqual(d.targetStrategy, STRATEGY.KAMINO_USDC);
    assert.strictEqual(d.amount.toNumber(), 500 * 1_000_000);
    assert.strictEqual(d.confidence, 87);
    assert.deepStrictEqual(Buffer.from(d.reasoningHash), reasoningHash);
    assert.strictEqual(d.oracle.toBase58(), oracle.publicKey.toBase58());

    // Audit invariant: anyone can re-derive the hash from the off-chain
    // reasoning text and prove it matches what's on chain.
    assert.deepStrictEqual(sha256(reasoning), Buffer.from(d.reasoningHash));
  });

  it("AI Oracle rebalances KAMINO → MARGINFI", async () => {
    const reasoning = "Marginfi USDC APY just crossed 8.4%, 2pp better than Kamino. Same risk profile. Rebalance.";
    const reasoningHash = sha256(reasoning);
    const decision = decisionPda(program.programId, vault, 1);

    await program.methods
      .aiRebalance(STRATEGY.MARGINFI_USDC, 91, Array.from(reasoningHash))
      .accounts({
        aiOracle: oracle.publicKey,
        payer: oracle.publicKey,
        vault,
        decision,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.activeStrategy, STRATEGY.MARGINFI_USDC);
    assert.strictEqual(v.allocatedAmount.toNumber(), 500 * 1_000_000);
    assert.strictEqual(v.totalAiDecisions.toNumber(), 2);

    const d = await program.account.aiDecision.fetch(decision);
    assert.strictEqual(d.decisionType, 2); // rebalance
    assert.strictEqual(d.targetStrategy, STRATEGY.MARGINFI_USDC);
    assert.strictEqual(d.confidence, 91);
  });

  it("rejects an AI call with confidence < 70", async () => {
    const reasoning = "I'm not sure about anything.";
    const reasoningHash = sha256(reasoning);
    const decision = decisionPda(program.programId, vault, 2);

    let threw = false;
    try {
      await program.methods
        .aiAllocate(
          STRATEGY.DRIFT_USDC,
          new BN(50 * 1_000_000),
          50, // below floor
          Array.from(reasoningHash),
        )
        .accounts({
          aiOracle: oracle.publicKey,
          payer: oracle.publicKey,
          vault,
          decision,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
    } catch (e) {
      threw = true;
      assert.match(String(e), /LowConfidence|0x[0-9a-f]+/i);
    }
    assert.ok(threw, "expected low-confidence call to be rejected");

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.totalAiDecisions.toNumber(), 2, "decision counter must not advance");
  });

  it("rejects an attacker pretending to be the oracle", async () => {
    const reasoning = "trust me";
    const reasoningHash = sha256(reasoning);
    const decision = decisionPda(program.programId, vault, 2);

    let threw = false;
    try {
      await program.methods
        .aiAllocate(
          STRATEGY.DRIFT_USDC,
          new BN(50 * 1_000_000),
          99,
          Array.from(reasoningHash),
        )
        .accounts({
          aiOracle: attacker.publicKey,
          payer: attacker.publicKey,
          vault,
          decision,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
    } catch (e) {
      threw = true;
      assert.match(String(e), /NotAiOracle|0x[0-9a-f]+/i);
    }
    assert.ok(threw, "expected non-oracle signer to be rejected");
  });

  it("AI Oracle goes risk-off — full unwind", async () => {
    const reasoning = "SOL volatility just spiked to 9% over 1h. Pull everything to idle until it cools.";
    const reasoningHash = sha256(reasoning);
    const decision = decisionPda(program.programId, vault, 2);

    await program.methods
      .aiRiskOff(95, Array.from(reasoningHash))
      .accounts({
        aiOracle: oracle.publicKey,
        payer: oracle.publicKey,
        vault,
        decision,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.allocatedAmount.toNumber(), 0);
    assert.strictEqual(v.activeStrategy, 0);
    assert.strictEqual(v.totalAiDecisions.toNumber(), 3);

    const d = await program.account.aiDecision.fetch(decision);
    assert.strictEqual(d.decisionType, 3); // risk_off
    assert.strictEqual(d.amount.toNumber(), 500 * 1_000_000);
  });

  it("user withdraws all shares", async () => {
    const position = PublicKey.findProgramAddressSync(
      [POSITION_SEED, vault.toBuffer(), user.publicKey.toBuffer()],
      program.programId,
    )[0];

    await program.methods
      .withdraw(new BN(1000 * 1_000_000))
      .accounts({
        user: user.publicKey,
        vault,
        vaultAuthority,
        position,
        owner: user.publicKey,
        assetMint: mint,
        userTokenAccount: userAta,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.userPosition.fetch(position);
    assert.strictEqual(pos.shares.toNumber(), 0);

    const v = await program.account.vault.fetch(vault);
    assert.strictEqual(v.totalDeposits.toNumber(), 0);
    assert.strictEqual(v.totalShares.toNumber(), 0);

    const userToken = await getAccount(connection, userAta);
    assert.strictEqual(Number(userToken.amount), 1000 * 1_000_000);
  });
});
