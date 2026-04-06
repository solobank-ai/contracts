use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111"); // Will be replaced after deploy

/// Solobank AI Decision Vault
///
/// A smart contract that accepts USDC deposits and records AI-driven
/// investment decisions on-chain. The AI agent (via MCP/SDK) analyzes
/// DeFi rates, makes decisions, and writes them to the blockchain.
///
/// Flow: AI analyzes market → records decision on-chain → contract validates
/// limits → decision becomes a permanent, auditable on-chain record.
#[program]
pub mod solobank_vault {
    use super::*;

    /// Initialize a new vault for an owner with configurable limits.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        max_per_tx: u64,
        daily_limit: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.balance = 0;
        vault.max_per_tx = max_per_tx;
        vault.daily_limit = daily_limit;
        vault.total_decisions = 0;
        vault.total_volume = 0;
        vault.daily_spent = 0;
        vault.last_reset_day = Clock::get()?.unix_timestamp / 86400;
        vault.is_locked = false;
        vault.bump = ctx.bumps.vault;

        emit!(VaultCreated {
            owner: vault.owner,
            max_per_tx,
            daily_limit,
        });
        Ok(())
    }

    /// Deposit lamports into the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        // Transfer SOL from depositor to vault PDA
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_add(amount).ok_or(VaultError::Overflow)?;

        emit!(DepositMade {
            vault: vault.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            new_balance: vault.balance,
        });
        Ok(())
    }

    /// AI agent records a decision on-chain.
    /// Only the vault owner (or authorized AI agent) can call this.
    /// The contract validates against per-tx and daily limits.
    pub fn ai_decision(
        ctx: Context<AiDecision>,
        decision_type: u8,
        asset: String,
        amount: u64,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        // Only owner can make decisions
        require!(
            ctx.accounts.agent.key() == vault.owner,
            VaultError::Unauthorized
        );
        require!(!vault.is_locked, VaultError::VaultLocked);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(amount <= vault.max_per_tx, VaultError::ExceedsPerTxLimit);
        require!(amount <= vault.balance, VaultError::InsufficientBalance);

        // Daily limit check with auto-reset
        let today = Clock::get()?.unix_timestamp / 86400;
        if today > vault.last_reset_day {
            vault.daily_spent = 0;
            vault.last_reset_day = today;
        }
        let new_daily = vault.daily_spent.checked_add(amount).ok_or(VaultError::Overflow)?;
        require!(new_daily <= vault.daily_limit, VaultError::ExceedsDailyLimit);

        // Record decision
        let decision = &mut ctx.accounts.decision;
        decision.vault = vault.key();
        decision.agent = ctx.accounts.agent.key();
        decision.decision_type = decision_type;
        decision.asset = asset.clone();
        decision.amount = amount;
        decision.reasoning_hash = reasoning_hash;
        decision.status = DecisionStatus::Pending;
        decision.timestamp = Clock::get()?.unix_timestamp;
        decision.bump = ctx.bumps.decision;

        // Update vault state
        vault.total_decisions += 1;
        vault.daily_spent = new_daily;

        emit!(DecisionRecorded {
            vault: vault.key(),
            agent: ctx.accounts.agent.key(),
            decision_id: decision.key(),
            decision_type,
            asset,
            amount,
            reasoning_hash,
            timestamp: decision.timestamp,
        });
        Ok(())
    }

    /// Execute a pending decision (marks it as executed).
    /// In production, this would trigger the actual DeFi operation.
    pub fn execute_decision(ctx: Context<ExecuteDecision>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let decision = &mut ctx.accounts.decision;

        require!(
            ctx.accounts.executor.key() == vault.owner,
            VaultError::Unauthorized
        );
        require!(
            decision.status == DecisionStatus::Pending,
            VaultError::InvalidStatus
        );

        decision.status = DecisionStatus::Executed;
        vault.balance = vault.balance.checked_sub(decision.amount).ok_or(VaultError::Overflow)?;
        vault.total_volume = vault.total_volume.checked_add(decision.amount).ok_or(VaultError::Overflow)?;

        emit!(DecisionExecuted {
            vault: vault.key(),
            decision_id: decision.key(),
            amount: decision.amount,
            remaining_balance: vault.balance,
        });
        Ok(())
    }

    /// Withdraw funds from the vault (owner only).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.owner.key() == vault.owner,
            VaultError::Unauthorized
        );
        require!(amount > 0, VaultError::ZeroAmount);
        require!(amount <= vault.balance, VaultError::InsufficientBalance);

        vault.balance = vault.balance.checked_sub(amount).ok_or(VaultError::Overflow)?;

        // Transfer SOL from vault PDA to owner
        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(WithdrawMade {
            vault: vault.key(),
            owner: ctx.accounts.owner.key(),
            amount,
            remaining_balance: vault.balance,
        });
        Ok(())
    }

    /// Emergency lock — disables all AI decisions.
    pub fn lock_vault(ctx: Context<LockVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.owner.key() == vault.owner,
            VaultError::Unauthorized
        );
        vault.is_locked = true;

        emit!(VaultLocked {
            vault: vault.key(),
        });
        Ok(())
    }

    /// Unlock the vault — re-enables AI decisions.
    pub fn unlock_vault(ctx: Context<UnlockVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.owner.key() == vault.owner,
            VaultError::Unauthorized
        );
        vault.is_locked = false;

        emit!(VaultUnlocked {
            vault: vault.key(),
        });
        Ok(())
    }
}

// ── Accounts ──

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub balance: u64,
    pub max_per_tx: u64,
    pub daily_limit: u64,
    pub total_decisions: u64,
    pub total_volume: u64,
    pub daily_spent: u64,
    pub last_reset_day: i64,
    pub is_locked: bool,
    pub bump: u8,
}

#[account]
pub struct Decision {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub decision_type: u8,      // 1=lend, 2=swap, 3=rebalance, 4=withdraw
    pub asset: String,           // "USDC", "SOL", mint address
    pub amount: u64,
    pub reasoning_hash: [u8; 32], // SHA-256 of AI reasoning text
    pub status: DecisionStatus,
    pub timestamp: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DecisionStatus {
    Pending,
    Executed,
    Rejected,
}

// ── Contexts ──

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1, // 98 bytes
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(decision_type: u8, asset: String, amount: u64, reasoning_hash: [u8; 32])]
pub struct AiDecision<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = agent,
        space = 8 + 32 + 32 + 1 + (4 + 32) + 8 + 32 + 1 + 8 + 1, // ~161 bytes
        seeds = [b"decision", vault.key().as_ref(), &vault.total_decisions.to_le_bytes()],
        bump,
    )]
    pub decision: Account<'info, Decision>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteDecision<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut, has_one = vault)]
    pub decision: Account<'info, Decision>,
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct LockVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnlockVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

// ── Errors ──

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount exceeds per-transaction limit")]
    ExceedsPerTxLimit,
    #[msg("Amount exceeds daily limit")]
    ExceedsDailyLimit,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Vault is locked — AI decisions disabled")]
    VaultLocked,
    #[msg("Invalid decision status for this operation")]
    InvalidStatus,
}

// ── Events ──

#[event]
pub struct VaultCreated {
    pub owner: Pubkey,
    pub max_per_tx: u64,
    pub daily_limit: u64,
}

#[event]
pub struct DepositMade {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct DecisionRecorded {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub decision_id: Pubkey,
    pub decision_type: u8,
    pub asset: String,
    pub amount: u64,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct DecisionExecuted {
    pub vault: Pubkey,
    pub decision_id: Pubkey,
    pub amount: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct WithdrawMade {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct VaultLocked {
    pub vault: Pubkey,
}

#[event]
pub struct VaultUnlocked {
    pub vault: Pubkey,
}
