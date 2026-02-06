import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GentdexEscrow } from "../target/types/gentdex_escrow";
import { assert } from "chai";
import { v4 as uuidv4 } from "uuid";

describe("gentdex-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GentdexEscrow as Program<GentdexEscrow>;
  const user = provider.wallet;
  const bot = anchor.web3.Keypair.generate();
  const treasury = anchor.web3.Keypair.generate();

  function makeSessionId(): number[] {
    const uuid = uuidv4().replace(/-/g, "");
    return Array.from(Buffer.from(uuid.slice(0, 32), "hex"));
  }

  function getVaultPda(sessionId: number[], userKey: anchor.web3.PublicKey) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(sessionId), userKey.toBuffer()],
      program.programId
    );
  }

  let sessionId: number[];
  let vaultPda: anchor.web3.PublicKey;

  before(async () => {
    const sig = await provider.connection.requestAirdrop(
      treasury.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  });

  it("Initializes a session", async () => {
    sessionId = makeSessionId();
    [vaultPda] = getVaultPda(sessionId, user.publicKey);

    await program.methods
      .initialize(sessionId, 7, bot.publicKey)
      .accounts({
        vault: vaultPda,
        user: user.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.user.toBase58(), user.publicKey.toBase58());
    assert.equal(vault.bot.toBase58(), bot.publicKey.toBase58());
    assert.equal(vault.durationDays, 7);
    assert.deepEqual(vault.status, { pending: {} });
    assert.equal(vault.balance.toNumber(), 0);
  });

  it("Rejects deposit below minimum (0.1 SOL)", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(50_000_000)) // 0.05 SOL
        .accounts({
          vault: vaultPda,
          user: user.publicKey,
          treasury: treasury.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected small deposit");
    } catch (err) {
      assert.include(err.toString(), "DepositTooSmall");
    }
  });

  it("Deposits SOL with 2.5% fee", async () => {
    const depositAmount = 5 * anchor.web3.LAMPORTS_PER_SOL; // 5 SOL
    const expectedFee = (depositAmount * 250) / 10_000; // 0.125 SOL
    const expectedBalance = depositAmount - expectedFee;

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        vault: vaultPda,
        user: user.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.balance.toNumber(), expectedBalance);
    assert.equal(vault.feeCollected.toNumber(), expectedFee);
    assert.deepEqual(vault.status, { active: {} });
    assert.ok(vault.expiresAt.toNumber() > 0);

    // Verify treasury received the fee
    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(treasuryAfter - treasuryBefore, expectedFee);

    console.log(`    Deposited: ${depositAmount / 1e9} SOL`);
    console.log(`    Fee (2.5%): ${expectedFee / 1e9} SOL`);
    console.log(`    Trading balance: ${expectedBalance / 1e9} SOL`);
  });

  it("Rejects second deposit (already funded)", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
        .accounts({
          vault: vaultPda,
          user: user.publicKey,
          treasury: treasury.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have rejected second deposit");
    } catch (err) {
      assert.include(err.toString(), "InvalidStatus");
    }
  });

  it("Bot cannot withdraw funds", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          vault: vaultPda,
          user: bot.publicKey,
        })
        .signers([bot])
        .rpc();
      assert.fail("Bot should not be able to withdraw");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("Rejects swap from non-whitelisted DEX", async () => {
    const fakeDex = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .executeSwap(
          new anchor.BN(100_000_000),
          new anchor.BN(90_000_000)
        )
        .accounts({
          vault: vaultPda,
          bot: bot.publicKey,
          dexProgram: fakeDex.publicKey,
        })
        .signers([bot])
        .rpc();
      assert.fail("Should reject non-whitelisted DEX");
    } catch (err) {
      assert.include(err.toString(), "DexNotWhitelisted");
    }
  });

  it("Rejects swap from non-bot signer", async () => {
    const jupiterV6 = new anchor.web3.PublicKey(
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    );

    try {
      await program.methods
        .executeSwap(
          new anchor.BN(100_000_000),
          new anchor.BN(90_000_000)
        )
        .accounts({
          vault: vaultPda,
          bot: user.publicKey,
          dexProgram: jupiterV6,
        })
        .rpc();
      assert.fail("Should reject non-bot signer");
    } catch (err) {
      assert.include(err.toString(), "Unauthorized");
    }
  });

  it("User can pause trading", async () => {
    await program.methods
      .pause()
      .accounts({
        vault: vaultPda,
        user: user.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.deepEqual(vault.status, { paused: {} });
  });

  it("User can resume trading", async () => {
    await program.methods
      .resume()
      .accounts({
        vault: vaultPda,
        user: user.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.deepEqual(vault.status, { active: {} });
  });

  it("Rejects compute fee deduction before 1 day", async () => {
    try {
      await program.methods
        .deductComputeFee()
        .accounts({
          vault: vaultPda,
          treasury: treasury.publicKey,
          cranker: user.publicKey,
        })
        .rpc();
      assert.fail("Should reject early deduction");
    } catch (err) {
      assert.include(err.toString(), "TooEarlyForDeduction");
    }
  });

  it("User can withdraw all funds (emergency exit)", async () => {
    const vaultBefore = await program.account.vault.fetch(vaultPda);
    const balanceBefore = vaultBefore.balance.toNumber();
    const userLamportsBefore = await provider.connection.getBalance(user.publicKey);

    await program.methods
      .withdraw()
      .accounts({
        vault: vaultPda,
        user: user.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.balance.toNumber(), 0);
    assert.deepEqual(vault.status, { withdrawn: {} });

    const userLamportsAfter = await provider.connection.getBalance(user.publicKey);
    // User should have gotten funds back (minus small tx fee)
    const gained = userLamportsAfter - userLamportsBefore;
    assert.ok(gained > balanceBefore - 100_000, `User should gain ~${balanceBefore} lamports, got ${gained}`);

    console.log(`    Withdrew: ${balanceBefore / 1e9} SOL`);
  });

  it("Full lifecycle: init → fund → expire → withdraw", async () => {
    const sid2 = makeSessionId();
    const [vault2Pda] = getVaultPda(sid2, user.publicKey);

    // Initialize with 0 day duration (expires immediately for testing)
    await program.methods
      .initialize(sid2, 0, bot.publicKey)
      .accounts({
        vault: vault2Pda,
        user: user.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Deposit 1 SOL
    await program.methods
      .deposit(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts({
        vault: vault2Pda,
        user: user.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    let vault2 = await program.account.vault.fetch(vault2Pda);
    assert.deepEqual(vault2.status, { active: {} });

    // Expire (duration=0, so it should expire immediately)
    await program.methods
      .expire()
      .accounts({
        vault: vault2Pda,
        cranker: user.publicKey,
      })
      .rpc();

    vault2 = await program.account.vault.fetch(vault2Pda);
    assert.deepEqual(vault2.status, { expired: {} });
    assert.ok(vault2.balance.toNumber() > 0, "Funds should still be in vault");

    // User can still withdraw after expiry
    await program.methods
      .withdraw()
      .accounts({
        vault: vault2Pda,
        user: user.publicKey,
      })
      .rpc();

    vault2 = await program.account.vault.fetch(vault2Pda);
    assert.equal(vault2.balance.toNumber(), 0);
    assert.deepEqual(vault2.status, { withdrawn: {} });

    console.log("    ✓ Full lifecycle completed: Pending → Active → Expired → Withdrawn");
  });
});
