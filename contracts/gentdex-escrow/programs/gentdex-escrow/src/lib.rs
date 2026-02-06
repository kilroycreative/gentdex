use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("9hyscAyfR2puBXWFoGzeBq3QtSn5e83B7AUkcS1qC5RJ");

/// GentDex Escrow Program
/// 
/// Non-custodial escrow for on-chain trading agents.
/// Users deposit SOL into PDA vaults. Bots get limited session keys
/// that can ONLY execute swaps on whitelisted DEX programs.
/// Users retain full withdrawal rights at all times.
///
/// Architecture: Single PDA holds both state and SOL. The program owns
/// the PDA so it can manipulate lamports directly.

#[program]
pub mod gentdex_escrow {
    use super::*;

    /// Fee basis points (2.5% = 250 bps)
    pub const FEE_BPS: u64 = 250;
    /// Daily compute fee in lamports (0.01 SOL)
    pub const DAILY_COMPUTE_FEE: u64 = 10_000_000;
    /// Minimum deposit in lamports (0.1 SOL)
    pub const MIN_DEPOSIT: u64 = 100_000_000;

    /// Initialize a new trading session with escrow vault
    pub fn initialize(
        ctx: Context<Initialize>,
        session_id: [u8; 16],
        duration_days: u16,
        bot_pubkey: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.user = ctx.accounts.user.key();
        vault.bot = bot_pubkey;
        vault.session_id = session_id;
        vault.balance = 0;
        vault.fee_collected = 0;
        vault.compute_fees_paid = 0;
        vault.duration_days = duration_days;
        vault.status = VaultStatus::Pending;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.funded_at = 0;
        vault.expires_at = 0;
        vault.last_compute_deduction = 0;
        vault.bump = ctx.bumps.vault;
        vault.treasury = ctx.accounts.treasury.key();

        emit!(SessionCreated {
            session_id,
            user: ctx.accounts.user.key(),
            bot: bot_pubkey,
            duration_days,
        });

        Ok(())
    }

    /// Deposit SOL into the escrow vault. 2.5% fee taken, remainder is trading balance.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount >= MIN_DEPOSIT, EscrowError::DepositTooSmall);
        
        // Read-only checks first
        require!(ctx.accounts.vault.status == VaultStatus::Pending, EscrowError::InvalidStatus);
        require!(ctx.accounts.vault.user == ctx.accounts.user.key(), EscrowError::Unauthorized);

        // Calculate fee (2.5%)
        let fee = amount
            .checked_mul(FEE_BPS)
            .ok_or(EscrowError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::MathOverflow)?;
        let trading_balance = amount
            .checked_sub(fee)
            .ok_or(EscrowError::MathOverflow)?;

        // Transfer trading balance from user to vault PDA
        let vault_info = ctx.accounts.vault.to_account_info();
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: vault_info,
                },
            ),
            trading_balance,
        )?;

        // Transfer fee from user to treasury
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;

        // Now mutate vault state
        let vault = &mut ctx.accounts.vault;
        let now = Clock::get()?.unix_timestamp;
        let duration_days = vault.duration_days;
        vault.balance = trading_balance;
        vault.fee_collected = fee;
        vault.status = VaultStatus::Active;
        vault.funded_at = now;
        vault.last_compute_deduction = now;
        vault.expires_at = now
            .checked_add((duration_days as i64) * 86400)
            .ok_or(EscrowError::MathOverflow)?;

        emit!(Deposited {
            session_id: vault.session_id,
            amount,
            fee,
            trading_balance,
            expires_at: vault.expires_at,
        });

        Ok(())
    }

    /// Bot executes a swap via a whitelisted DEX program.
    /// This is the ONLY action the bot can take — it cannot withdraw or transfer arbitrarily.
    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(vault.status == VaultStatus::Active, EscrowError::InvalidStatus);
        require!(vault.bot == ctx.accounts.bot.key(), EscrowError::Unauthorized);
        
        // Check not expired
        let now = Clock::get()?.unix_timestamp;
        require!(now < vault.expires_at, EscrowError::SessionExpired);
        
        // Check amount doesn't exceed balance
        require!(amount_in <= vault.balance, EscrowError::InsufficientBalance);

        // Validate DEX program is whitelisted
        let dex_program = &ctx.accounts.dex_program;
        require!(
            is_whitelisted_dex(&dex_program.key()),
            EscrowError::DexNotWhitelisted
        );

        // The actual CPI to the DEX happens here via remaining_accounts
        // The DEX-specific instruction data is passed through
        // This is where we'd build DEX-specific adapters
        
        emit!(SwapExecuted {
            session_id: vault.session_id,
            bot: ctx.accounts.bot.key(),
            dex_program: dex_program.key(),
            amount_in,
            minimum_amount_out,
            timestamp: now,
        });

        Ok(())
    }

    /// Deduct daily compute fee from vault. Callable by anyone (protocol crank).
    pub fn deduct_compute_fee(ctx: Context<DeductComputeFee>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active || vault.status == VaultStatus::Paused,
            EscrowError::InvalidStatus
        );

        let now = Clock::get()?.unix_timestamp;
        let seconds_since_last = now
            .checked_sub(vault.last_compute_deduction)
            .ok_or(EscrowError::MathOverflow)?;
        
        // Calculate days elapsed (minimum 1 day between deductions)
        let days_elapsed = seconds_since_last / 86400;
        require!(days_elapsed >= 1, EscrowError::TooEarlyForDeduction);

        let fee = (days_elapsed as u64)
            .checked_mul(DAILY_COMPUTE_FEE)
            .ok_or(EscrowError::MathOverflow)?;
        
        let actual_fee = fee.min(vault.balance);

        // Transfer compute fee from vault PDA to treasury
        // The vault PDA is owned by this program, so we can debit it directly
        let vault_info = vault.to_account_info();
        let treasury_info = ctx.accounts.treasury.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= actual_fee;
        **treasury_info.try_borrow_mut_lamports()? += actual_fee;

        vault.balance = vault.balance
            .checked_sub(actual_fee)
            .ok_or(EscrowError::MathOverflow)?;
        vault.compute_fees_paid = vault.compute_fees_paid
            .checked_add(actual_fee)
            .ok_or(EscrowError::MathOverflow)?;
        vault.last_compute_deduction = now;

        // If balance is zero, expire the session
        if vault.balance == 0 {
            vault.status = VaultStatus::Expired;
        }

        emit!(ComputeFeeDeducted {
            session_id: vault.session_id,
            fee: actual_fee,
            remaining_balance: vault.balance,
        });

        Ok(())
    }

    /// Pause trading. Only the user can pause.
    pub fn pause(ctx: Context<UserAction>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.user == ctx.accounts.user.key(), EscrowError::Unauthorized);
        require!(vault.status == VaultStatus::Active, EscrowError::InvalidStatus);
        
        vault.status = VaultStatus::Paused;

        emit!(SessionPaused {
            session_id: vault.session_id,
        });

        Ok(())
    }

    /// Resume trading. Only the user can resume.
    pub fn resume(ctx: Context<UserAction>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.user == ctx.accounts.user.key(), EscrowError::Unauthorized);
        require!(vault.status == VaultStatus::Paused, EscrowError::InvalidStatus);
        
        let now = Clock::get()?.unix_timestamp;
        require!(now < vault.expires_at, EscrowError::SessionExpired);
        
        vault.status = VaultStatus::Active;

        emit!(SessionResumed {
            session_id: vault.session_id,
        });

        Ok(())
    }

    /// Withdraw all funds. Only the user can withdraw. Works in ANY state except Pending.
    /// This is the emergency exit — user can ALWAYS get their funds back.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.user == ctx.accounts.user.key(), EscrowError::Unauthorized);
        require!(vault.status != VaultStatus::Pending, EscrowError::InvalidStatus);

        let balance = vault.balance;
        require!(balance > 0, EscrowError::InsufficientBalance);

        // Transfer remaining SOL back to user from the vault PDA
        let vault_info = vault.to_account_info();
        let user_info = ctx.accounts.user.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= balance;
        **user_info.try_borrow_mut_lamports()? += balance;

        vault.balance = 0;
        vault.status = VaultStatus::Withdrawn;

        emit!(Withdrawn {
            session_id: vault.session_id,
            amount: balance,
            user: ctx.accounts.user.key(),
        });

        Ok(())
    }

    /// Expire a session that has passed its duration. Callable by anyone.
    /// Remaining funds stay in vault until user withdraws.
    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active || vault.status == VaultStatus::Paused,
            EscrowError::InvalidStatus
        );

        let now = Clock::get()?.unix_timestamp;
        require!(now >= vault.expires_at, EscrowError::SessionNotExpired);

        vault.status = VaultStatus::Expired;

        emit!(SessionExpiredEvent {
            session_id: vault.session_id,
            remaining_balance: vault.balance,
        });

        Ok(())
    }
}

// ============================================================
// Whitelisted DEX programs
// ============================================================

fn is_whitelisted_dex(program_id: &Pubkey) -> bool {
    let whitelisted: [&str; 5] = [
        // Jupiter Aggregator v6
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        // Raydium AMM
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        // Raydium CLMM
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        // Orca Whirlpool
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        // PumpSwap (Pump.fun AMM)
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    ];

    for addr in whitelisted.iter() {
        if let Ok(key) = addr.parse::<Pubkey>() {
            if key == *program_id {
                return true;
            }
        }
    }
    false
}

// ============================================================
// Accounts
// ============================================================

#[derive(Accounts)]
#[instruction(session_id: [u8; 16])]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", session_id.as_ref(), user.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Treasury wallet for fee collection
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Treasury wallet for fee collection
    #[account(
        mut,
        constraint = treasury.key() == vault.treasury @ EscrowError::InvalidTreasury
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub bot: Signer<'info>,

    /// CHECK: The DEX program to CPI into — validated in instruction logic
    pub dex_program: UncheckedAccount<'info>,
    // Additional DEX accounts passed via remaining_accounts
}

#[derive(Accounts)]
pub struct DeductComputeFee<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: Treasury wallet
    #[account(
        mut,
        constraint = treasury.key() == vault.treasury @ EscrowError::InvalidTreasury
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Anyone can crank this
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct UserAction<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.session_id.as_ref(), vault.user.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    pub cranker: Signer<'info>,
}

// ============================================================
// State
// ============================================================

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub user: Pubkey,               // 32 — owner, can always withdraw
    pub bot: Pubkey,                // 32 — session key, can only swap
    pub treasury: Pubkey,           // 32 — fee recipient
    pub session_id: [u8; 16],       // 16 — unique session identifier
    pub balance: u64,               // 8  — current trading balance (lamports)
    pub fee_collected: u64,         // 8  — setup fee taken
    pub compute_fees_paid: u64,     // 8  — total compute fees deducted
    pub duration_days: u16,         // 2  — session length
    pub status: VaultStatus,        // 1  — current state
    pub bump: u8,                   // 1  — PDA bump seed
    pub created_at: i64,            // 8  — unix timestamp
    pub funded_at: i64,             // 8  — when deposit landed
    pub expires_at: i64,            // 8  — when session ends
    pub last_compute_deduction: i64,// 8  — last daily fee timestamp
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum VaultStatus {
    Pending,    // Created, awaiting deposit
    Active,     // Funded, bot is trading
    Paused,     // User paused trading
    Expired,    // Duration ended or balance depleted
    Withdrawn,  // User withdrew all funds
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum EscrowError {
    #[msg("Unauthorized: caller is not the vault owner or bot")]
    Unauthorized,
    #[msg("Invalid vault status for this operation")]
    InvalidStatus,
    #[msg("Deposit amount below minimum (0.1 SOL)")]
    DepositTooSmall,
    #[msg("Insufficient balance in vault")]
    InsufficientBalance,
    #[msg("DEX program is not whitelisted")]
    DexNotWhitelisted,
    #[msg("Trading session has expired")]
    SessionExpired,
    #[msg("Session has not expired yet")]
    SessionNotExpired,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Too early for compute fee deduction")]
    TooEarlyForDeduction,
    #[msg("Invalid treasury account")]
    InvalidTreasury,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct SessionCreated {
    pub session_id: [u8; 16],
    pub user: Pubkey,
    pub bot: Pubkey,
    pub duration_days: u16,
}

#[event]
pub struct Deposited {
    pub session_id: [u8; 16],
    pub amount: u64,
    pub fee: u64,
    pub trading_balance: u64,
    pub expires_at: i64,
}

#[event]
pub struct SwapExecuted {
    pub session_id: [u8; 16],
    pub bot: Pubkey,
    pub dex_program: Pubkey,
    pub amount_in: u64,
    pub minimum_amount_out: u64,
    pub timestamp: i64,
}

#[event]
pub struct ComputeFeeDeducted {
    pub session_id: [u8; 16],
    pub fee: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct SessionPaused {
    pub session_id: [u8; 16],
}

#[event]
pub struct SessionResumed {
    pub session_id: [u8; 16],
}

#[event]
pub struct Withdrawn {
    pub session_id: [u8; 16],
    pub amount: u64,
    pub user: Pubkey,
}

#[event]
pub struct SessionExpiredEvent {
    pub session_id: [u8; 16],
    pub remaining_balance: u64,
}
