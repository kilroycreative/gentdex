import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GentdexEscrow } from "../target/types/gentdex_escrow";
import { v4 as uuidv4 } from "uuid";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GentdexEscrow as Program<GentdexEscrow>;
  const user = provider.wallet;
  const bot = anchor.web3.Keypair.generate();
  const treasury = anchor.web3.Keypair.generate();

  console.log("\n🦞 GentDex Escrow — Devnet Integration Test");
  console.log("=".repeat(50));
  console.log(`Program:  ${program.programId.toBase58()}`);
  console.log(`User:     ${user.publicKey.toBase58()}`);
  console.log(`Bot:      ${bot.publicKey.toBase58()}`);
  console.log(`Treasury: ${treasury.publicKey.toBase58()}`);

  // Generate session ID
  const uuid = uuidv4().replace(/-/g, "");
  const sessionId = Array.from(Buffer.from(uuid.slice(0, 32), "hex"));

  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(sessionId), user.publicKey.toBuffer()],
    program.programId
  );
  console.log(`Vault:    ${vaultPda.toBase58()}`);

  // Fund treasury from user wallet (devnet airdrop rate-limited)
  console.log("\n📦 Step 1: Funding treasury...");
  const sig1 = await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: treasury.publicKey,
        lamports: 0.01 * anchor.web3.LAMPORTS_PER_SOL,
      })
    )
  );
  console.log("   ✅ Treasury funded");

  // Initialize — let Anchor auto-resolve PDA accounts
  console.log("\n📝 Step 2: Initialize session (7 day duration)...");
  const tx1 = await program.methods
    .initialize(sessionId, 7, bot.publicKey)
    .accountsPartial({
      user: user.publicKey,
      treasury: treasury.publicKey,
    })
    .rpc();
  console.log(`   ✅ TX: ${tx1}`);

  let vault = await program.account.vault.fetch(vaultPda);
  console.log(`   Status: ${JSON.stringify(vault.status)}`);

  // Deposit 0.1 SOL (minimum)
  console.log("\n💰 Step 3: Deposit 0.1 SOL...");
  const depositAmount = 0.1 * anchor.web3.LAMPORTS_PER_SOL;
  const tx2 = await program.methods
    .deposit(new anchor.BN(depositAmount))
    .accountsPartial({
      vault: vaultPda,
      user: user.publicKey,
      treasury: treasury.publicKey,
    })
    .rpc();
  console.log(`   ✅ TX: ${tx2}`);

  vault = await program.account.vault.fetch(vaultPda);
  const fee = vault.feeCollected.toNumber();
  const balance = vault.balance.toNumber();
  console.log(`   Fee (2.5%):       ${fee / 1e9} SOL`);
  console.log(`   Trading balance:  ${balance / 1e9} SOL`);
  console.log(`   Status:           ${JSON.stringify(vault.status)}`);
  console.log(`   Expires:          ${new Date(vault.expiresAt.toNumber() * 1000).toISOString()}`);

  // Pause
  console.log("\n⏸️  Step 4: Pause trading...");
  const tx3 = await program.methods
    .pause()
    .accountsPartial({ vault: vaultPda, user: user.publicKey })
    .rpc();
  console.log(`   ✅ TX: ${tx3}`);

  // Resume
  console.log("\n▶️  Step 5: Resume trading...");
  const tx4 = await program.methods
    .resume()
    .accountsPartial({ vault: vaultPda, user: user.publicKey })
    .rpc();
  console.log(`   ✅ TX: ${tx4}`);

  // Withdraw
  console.log("\n💸 Step 6: Emergency withdraw...");
  const userBefore = await provider.connection.getBalance(user.publicKey);
  const tx5 = await program.methods
    .withdraw()
    .accountsPartial({ vault: vaultPda, user: user.publicKey })
    .rpc();
  const userAfter = await provider.connection.getBalance(user.publicKey);
  console.log(`   ✅ TX: ${tx5}`);
  console.log(`   Recovered: ~${((userAfter - userBefore) / 1e9).toFixed(4)} SOL`);

  vault = await program.account.vault.fetch(vaultPda);
  console.log(`   Final status: ${JSON.stringify(vault.status)}`);

  console.log("\n" + "=".repeat(50));
  console.log("🎉 All devnet tests passed!");
  console.log(`\nView on explorer:`);
  console.log(`https://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet`);
  console.log(`https://explorer.solana.com/address/${vaultPda.toBase58()}?cluster=devnet`);
}

main().catch(console.error);
