// Solobank AI Vault
//
// An autonomous yield vault driven by an AI Oracle. Users deposit a single
// asset (e.g. USDC) into a vault PDA. An off-chain AI agent (GPT-4o-mini in
// the reference implementation) analyses lending markets and submits
// allocation decisions on-chain via `ai_allocate` / `ai_rebalance`.
//
// Every AI decision is recorded as a PDA-backed audit record carrying:
//   - decision_type        (allocate / rebalance / risk-off / withdraw)
//   - target_strategy      (which protocol bucket: kamino, marginfi, idle, ...)
//   - amount               (lamports or token base units)
//   - confidence           (0..=100, must be >= MIN_AI_CONFIDENCE)
//   - reasoning_hash       (sha256 of the LLM rationale, fetched off-chain)
//
// Built for Decentrathon 5.0 — Case 2: AI + Blockchain.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("74Er4xSaRKQbDL1X8UUjYP9M4vXNZUZR36qeMUdH7RU9");

// ── Constants ──────────────────────────────────────────────────────────────

pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTH_SEED: &[u8] = b"vault-auth";
pub const POSITION_SEED: &[u8] = b"position";
pub const DECISION_SEED: &[u8] = b"ai-vault-decision";

pub const MIN_AI_CONFIDENCE: u8 = 70;
pub const MAX_STRATEGIES: u8 = 8;

// Decision types
pub const DECISION_ALLOCATE: u8 = 1;
pub const DECISION_REBALANCE: u8 = 2;
pub const DECISION_RISK_OFF: u8 = 3;
pub const DECISION_WITHDRAW: u8 = 4;

#[program]
pub mod ai_vault {
    use super::*;

    /// Initialise a vault for a single asset mint.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        ai_oracle: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.ai_oracle = ai_oracle;
        vault.asset_mint = ctx.accounts.asset_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.total_deposits = 0;
        vault.total_shares = 0;
        vault.total_ai_decisions = 0;
        vault.active_strategy = 0; // 0 = idle
        vault.allocated_amount = 0;
        vault.paused = false;
        vault.bump = ctx.bumps.vault;
        vault.auth_bump = ctx.bumps.vault_authority;

        emit!(VaultInitialized {
            vault: vault.key(),
            admin: vault.admin,
            ai_oracle: vault.ai_oracle,
            asset_mint: vault.asset_mint,
        });
        Ok(())
    }

    /// Deposit asset into the vault. Mints shares 1:1 on first deposit, then
    /// pro-rata against current vault accounting.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);

        // Move tokens from user → vault token account.
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            mint: ctx.accounts.asset_mint.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        // Share accounting: 1:1 on bootstrap, otherwise pro-rata.
        let shares_minted = if vault.total_shares == 0 || vault.total_deposits == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(vault.total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault.total_deposits as u128)
                .ok_or(VaultError::MathOverflow)? as u64
        };

        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.vault = vault.key();
            position.bump = ctx.bumps.position;
        }
        position.shares = position
            .shares
            .checked_add(shares_minted)
            .ok_or(VaultError::MathOverflow)?;
        position.deposited = position
            .deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        vault.total_deposits = vault
            .total_deposits
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_add(shares_minted)
            .ok_or(VaultError::MathOverflow)?;

        emit!(Deposited {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            amount,
            shares: shares_minted,
        });
        Ok(())
    }

    /// Withdraw `shares` worth of asset from the vault.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(shares > 0, VaultError::ZeroAmount);

        let position = &mut ctx.accounts.position;
        require!(position.shares >= shares, VaultError::InsufficientShares);
        require!(vault.total_shares > 0, VaultError::EmptyVault);

        let amount = (shares as u128)
            .checked_mul(vault.total_deposits as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(vault.total_shares as u128)
            .ok_or(VaultError::MathOverflow)? as u64;

        // Liquid balance check: cannot withdraw what's been allocated.
        let liquid = vault
            .total_deposits
            .checked_sub(vault.allocated_amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(amount <= liquid, VaultError::InsufficientLiquidity);

        // Vault PDA signs the transfer back to the user.
        let vault_key = vault.key();
        let auth_bump = vault.auth_bump;
        let auth_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, vault_key.as_ref(), &[auth_bump]];
        let signer = &[auth_seeds];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.asset_mint.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        position.shares = position.shares.checked_sub(shares).unwrap();
        position.deposited = position.deposited.saturating_sub(amount);

        vault.total_deposits = vault.total_deposits.checked_sub(amount).unwrap();
        vault.total_shares = vault.total_shares.checked_sub(shares).unwrap();

        emit!(Withdrawn {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            amount,
            shares,
        });
        Ok(())
    }

    /// AI Oracle commits an allocation decision: move `amount` of liquid funds
    /// into `target_strategy`. The actual CPI to the lending protocol happens
    /// off-chain (or in a future v2); this instruction records the AI's intent
    /// on-chain and updates vault accounting.
    pub fn ai_allocate(
        ctx: Context<AiOracleAction>,
        target_strategy: u8,
        amount: u64,
        confidence: u8,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        require!(confidence >= MIN_AI_CONFIDENCE, VaultError::LowConfidence);
        require!(confidence <= 100, VaultError::InvalidConfidence);
        require!(target_strategy <= MAX_STRATEGIES, VaultError::InvalidStrategy);
        require!(amount > 0, VaultError::ZeroAmount);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);

        let liquid = vault
            .total_deposits
            .checked_sub(vault.allocated_amount)
            .ok_or(VaultError::MathOverflow)?;
        require!(amount <= liquid, VaultError::InsufficientLiquidity);

        vault.allocated_amount = vault
            .allocated_amount
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.active_strategy = target_strategy;

        let decision = &mut ctx.accounts.decision;
        decision.id = vault.total_ai_decisions;
        decision.vault = vault.key();
        decision.oracle = ctx.accounts.ai_oracle.key();
        decision.decision_type = DECISION_ALLOCATE;
        decision.target_strategy = target_strategy;
        decision.amount = amount;
        decision.confidence = confidence;
        decision.reasoning_hash = reasoning_hash;
        decision.timestamp = Clock::get()?.unix_timestamp;

        vault.total_ai_decisions = vault
            .total_ai_decisions
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        emit!(AiAllocated {
            vault: vault.key(),
            decision_id: decision.id,
            target_strategy,
            amount,
            confidence,
            reasoning_hash,
        });
        Ok(())
    }

    /// AI Oracle rebalances: moves funds from the active strategy to a new
    /// `target_strategy`. The amount moved is the entire `allocated_amount`.
    pub fn ai_rebalance(
        ctx: Context<AiOracleAction>,
        target_strategy: u8,
        confidence: u8,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        require!(confidence >= MIN_AI_CONFIDENCE, VaultError::LowConfidence);
        require!(confidence <= 100, VaultError::InvalidConfidence);
        require!(target_strategy <= MAX_STRATEGIES, VaultError::InvalidStrategy);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(vault.allocated_amount > 0, VaultError::NothingAllocated);
        require!(
            target_strategy != vault.active_strategy,
            VaultError::SameStrategy
        );

        let prev_strategy = vault.active_strategy;
        let amount = vault.allocated_amount;
        vault.active_strategy = target_strategy;

        let decision = &mut ctx.accounts.decision;
        decision.id = vault.total_ai_decisions;
        decision.vault = vault.key();
        decision.oracle = ctx.accounts.ai_oracle.key();
        decision.decision_type = DECISION_REBALANCE;
        decision.target_strategy = target_strategy;
        decision.amount = amount;
        decision.confidence = confidence;
        decision.reasoning_hash = reasoning_hash;
        decision.timestamp = Clock::get()?.unix_timestamp;

        vault.total_ai_decisions = vault
            .total_ai_decisions
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        emit!(AiRebalanced {
            vault: vault.key(),
            decision_id: decision.id,
            from_strategy: prev_strategy,
            to_strategy: target_strategy,
            amount,
            confidence,
            reasoning_hash,
        });
        Ok(())
    }

    /// AI Oracle pulls everything back to idle (e.g. on volatility spike).
    pub fn ai_risk_off(
        ctx: Context<AiOracleAction>,
        confidence: u8,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        require!(confidence >= MIN_AI_CONFIDENCE, VaultError::LowConfidence);
        require!(confidence <= 100, VaultError::InvalidConfidence);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.paused, VaultError::Paused);
        require!(vault.allocated_amount > 0, VaultError::NothingAllocated);

        let amount = vault.allocated_amount;
        let prev_strategy = vault.active_strategy;
        vault.allocated_amount = 0;
        vault.active_strategy = 0;

        let decision = &mut ctx.accounts.decision;
        decision.id = vault.total_ai_decisions;
        decision.vault = vault.key();
        decision.oracle = ctx.accounts.ai_oracle.key();
        decision.decision_type = DECISION_RISK_OFF;
        decision.target_strategy = 0;
        decision.amount = amount;
        decision.confidence = confidence;
        decision.reasoning_hash = reasoning_hash;
        decision.timestamp = Clock::get()?.unix_timestamp;

        vault.total_ai_decisions = vault
            .total_ai_decisions
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        emit!(AiRiskOff {
            vault: vault.key(),
            decision_id: decision.id,
            from_strategy: prev_strategy,
            amount,
            confidence,
            reasoning_hash,
        });
        Ok(())
    }

    /// Admin can rotate the AI oracle (e.g. key rotation, model upgrade).
    pub fn set_ai_oracle(ctx: Context<AdminOnly>, new_oracle: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let prev = vault.ai_oracle;
        vault.ai_oracle = new_oracle;
        emit!(AiOracleChanged {
            vault: vault.key(),
            previous_oracle: prev,
            new_oracle,
        });
        Ok(())
    }

    /// Admin pause/resume.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PausedChanged {
            vault: ctx.accounts.vault.key(),
            paused,
        });
        Ok(())
    }
}

// ── Accounts ───────────────────────────────────────────────────────────────

#[account]
pub struct Vault {
    pub admin: Pubkey,
    pub ai_oracle: Pubkey,
    pub asset_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_deposits: u64,
    pub total_shares: u64,
    pub total_ai_decisions: u64,
    pub allocated_amount: u64,
    pub active_strategy: u8,
    pub paused: bool,
    pub bump: u8,
    pub auth_bump: u8,
}

impl Vault {
    pub const LEN: usize = 8 + 32 * 4 + 8 * 4 + 1 + 1 + 1 + 1;
}

#[account]
pub struct UserPosition {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub shares: u64,
    pub deposited: u64,
    pub bump: u8,
}

impl UserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct AiDecision {
    pub id: u64,
    pub vault: Pubkey,
    pub oracle: Pubkey,
    pub decision_type: u8,
    pub target_strategy: u8,
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
}

impl AiDecision {
    pub const LEN: usize = 8 + 8 + 32 + 32 + 1 + 1 + 8 + 1 + 32 + 8;
}

// ── Contexts ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Vault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: PDA used as the vault token account authority.
    #[account(
        seeds = [VAULT_AUTH_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        token::mint = asset_mint,
        token::authority = vault_authority,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = vault_token_account,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserPosition::LEN,
        seeds = [POSITION_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, UserPosition>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = vault_token_account,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: PDA, signs token transfers out.
    #[account(
        seeds = [VAULT_AUTH_SEED, vault.key().as_ref()],
        bump = vault.auth_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = owner @ VaultError::NotPositionOwner,
        has_one = vault @ VaultError::WrongVault,
    )]
    pub position: Account<'info, UserPosition>,

    /// CHECK: must equal position.owner (verified via has_one above).
    pub owner: UncheckedAccount<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AiOracleAction<'info> {
    pub ai_oracle: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref()],
        bump = vault.bump,
        constraint = vault.ai_oracle == ai_oracle.key() @ VaultError::NotAiOracle,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = payer,
        space = AiDecision::LEN,
        seeds = [
            DECISION_SEED,
            vault.key().as_ref(),
            &vault.total_ai_decisions.to_le_bytes(),
        ],
        bump,
    )]
    pub decision: Account<'info, AiDecision>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref()],
        bump = vault.bump,
        has_one = admin @ VaultError::NotAdmin,
    )]
    pub vault: Account<'info, Vault>,
}

// ── Events ─────────────────────────────────────────────────────────────────

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub ai_oracle: Pubkey,
    pub asset_mint: Pubkey,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct AiAllocated {
    pub vault: Pubkey,
    pub decision_id: u64,
    pub target_strategy: u8,
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
}

#[event]
pub struct AiRebalanced {
    pub vault: Pubkey,
    pub decision_id: u64,
    pub from_strategy: u8,
    pub to_strategy: u8,
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
}

#[event]
pub struct AiRiskOff {
    pub vault: Pubkey,
    pub decision_id: u64,
    pub from_strategy: u8,
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
}

#[event]
pub struct AiOracleChanged {
    pub vault: Pubkey,
    pub previous_oracle: Pubkey,
    pub new_oracle: Pubkey,
}

#[event]
pub struct PausedChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

// ── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Vault is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Vault has no shares")]
    EmptyVault,
    #[msg("Insufficient liquid balance — too much is allocated")]
    InsufficientLiquidity,
    #[msg("Signer is not the configured AI oracle")]
    NotAiOracle,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("AI confidence below MIN_AI_CONFIDENCE")]
    LowConfidence,
    #[msg("Confidence must be 0..=100")]
    InvalidConfidence,
    #[msg("Strategy index out of range")]
    InvalidStrategy,
    #[msg("Nothing is currently allocated")]
    NothingAllocated,
    #[msg("Target strategy is the same as the active one")]
    SameStrategy,
    #[msg("Position owner mismatch")]
    NotPositionOwner,
    #[msg("Position belongs to a different vault")]
    WrongVault,
}
