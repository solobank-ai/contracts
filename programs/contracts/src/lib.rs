use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, TransferChecked, Mint};
use anchor_lang::accounts::interface::Interface;
use anchor_lang::accounts::interface_account::InterfaceAccount;

declare_id!("9xpLht8FtpZgEGFpHpC6W3pupoHbfTsBMytj7CqxJ8us");

/// Fee rates in basis points (1 bps = 0.01%)
pub const SAVE_FEE_BPS: u16 = 10;    // 0.1% on lend/save
pub const BORROW_FEE_BPS: u16 = 5;   // 0.05% on borrow
pub const SWAP_FEE_BPS: u16 = 10;    // 0.1% on swap
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 500;    // 5% max
pub const MIN_AI_CONFIDENCE: u8 = 70; // 0-100, AI must be at least 70% confident

#[program]
pub mod contracts {
    use super::*;

    /// Initialize the treasury config. Called once by the admin.
    pub fn initialize(
        ctx: Context<Initialize>,
        treasury: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = treasury;
        config.ai_oracle = ctx.accounts.admin.key(); // admin is initial AI oracle
        config.save_fee_bps = SAVE_FEE_BPS;
        config.borrow_fee_bps = BORROW_FEE_BPS;
        config.swap_fee_bps = SWAP_FEE_BPS;
        config.paused = false;
        config.total_fees_collected = 0;
        config.total_ai_decisions = 0;
        config.bump = ctx.bumps.config;
        msg!("Treasury initialized. Admin: {}, Treasury: {}", config.admin, config.treasury);
        Ok(())
    }

    /// Collect fee on a lend/save operation.
    pub fn collect_save_fee(ctx: Context<CollectFee>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, TreasuryError::Paused);

        let fee = calculate_fee(amount, config.save_fee_bps)?;
        if fee == 0 {
            return Ok(());
        }

        transfer_fee(&ctx, fee)?;

        let config = &mut ctx.accounts.config;
        config.total_fees_collected = config.total_fees_collected.checked_add(fee).unwrap();

        msg!("Save fee collected: {} ({}bps on {})", fee, config.save_fee_bps, amount);
        Ok(())
    }

    /// Collect fee on a borrow operation.
    pub fn collect_borrow_fee(ctx: Context<CollectFee>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, TreasuryError::Paused);

        let fee = calculate_fee(amount, config.borrow_fee_bps)?;
        if fee == 0 {
            return Ok(());
        }

        transfer_fee(&ctx, fee)?;

        let config = &mut ctx.accounts.config;
        config.total_fees_collected = config.total_fees_collected.checked_add(fee).unwrap();

        msg!("Borrow fee collected: {} ({}bps on {})", fee, config.borrow_fee_bps, amount);
        Ok(())
    }

    /// Collect fee on a swap operation.
    pub fn collect_swap_fee(ctx: Context<CollectFee>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, TreasuryError::Paused);

        let fee = calculate_fee(amount, config.swap_fee_bps)?;
        if fee == 0 {
            return Ok(());
        }

        transfer_fee(&ctx, fee)?;

        let config = &mut ctx.accounts.config;
        config.total_fees_collected = config.total_fees_collected.checked_add(fee).unwrap();

        msg!("Swap fee collected: {} ({}bps on {})", fee, config.swap_fee_bps, amount);
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // AI-DRIVEN INSTRUCTIONS
    // ─────────────────────────────────────────────────────────────────────

    /// AI Oracle: dynamically adjust fees based on market analysis.
    ///
    /// The AI agent analyzes:
    /// - Upstream API costs (OpenAI, Anthropic pricing changes)
    /// - DeFi market conditions (TVL, APYs)
    /// - Solobank gateway demand
    ///
    /// Then submits new fee rates with on-chain reasoning hash for transparency.
    /// Only the designated AI oracle can call this. All decisions are logged on-chain.
    pub fn ai_update_fees(
        ctx: Context<AiOracleOnly>,
        save_fee_bps: Option<u16>,
        borrow_fee_bps: Option<u16>,
        swap_fee_bps: Option<u16>,
        confidence: u8,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        require!(confidence >= MIN_AI_CONFIDENCE, TreasuryError::LowConfidence);
        require!(confidence <= 100, TreasuryError::InvalidConfidence);

        let old_save = config.save_fee_bps;
        let old_borrow = config.borrow_fee_bps;
        let old_swap = config.swap_fee_bps;

        if let Some(v) = save_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.save_fee_bps = v;
        }
        if let Some(v) = borrow_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.borrow_fee_bps = v;
        }
        if let Some(v) = swap_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.swap_fee_bps = v;
        }

        config.total_ai_decisions = config.total_ai_decisions.checked_add(1).unwrap();

        emit!(AiFeesUpdated {
            decision_id: config.total_ai_decisions,
            oracle: ctx.accounts.ai_oracle.key(),
            old_save_bps: old_save,
            new_save_bps: config.save_fee_bps,
            old_borrow_bps: old_borrow,
            new_borrow_bps: config.borrow_fee_bps,
            old_swap_bps: old_swap,
            new_swap_bps: config.swap_fee_bps,
            confidence,
            reasoning_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("AI updated fees: save={}bps borrow={}bps swap={}bps (confidence={})",
            config.save_fee_bps, config.borrow_fee_bps, config.swap_fee_bps, confidence);
        Ok(())
    }

    /// Record an AI decision on-chain for audit trail.
    /// Used when AI recommends actions (lend, swap, rebalance) that are executed off-chain via SDK.
    /// Creates a permanent verifiable record of every AI decision.
    pub fn record_ai_decision(
        ctx: Context<RecordAiDecision>,
        decision_type: u8,      // 1=lend, 2=swap, 3=rebalance, 4=withdraw, 5=hold
        asset: [u8; 8],         // Asset symbol padded ("USDC", "SOL")
        amount: u64,            // Amount in smallest units
        confidence: u8,         // 0-100
        reasoning_hash: [u8; 32], // SHA-256 of full reasoning text
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let decision = &mut ctx.accounts.decision;

        require!(decision_type >= 1 && decision_type <= 5, TreasuryError::InvalidDecisionType);
        require!(confidence <= 100, TreasuryError::InvalidConfidence);

        decision.id = config.total_ai_decisions;
        decision.oracle = ctx.accounts.ai_oracle.key();
        decision.decision_type = decision_type;
        decision.asset = asset;
        decision.amount = amount;
        decision.confidence = confidence;
        decision.reasoning_hash = reasoning_hash;
        decision.timestamp = Clock::get()?.unix_timestamp;
        decision.bump = ctx.bumps.decision;

        config.total_ai_decisions = config.total_ai_decisions.checked_add(1).unwrap();

        emit!(AiDecisionRecorded {
            decision_id: decision.id,
            oracle: decision.oracle,
            decision_type,
            asset,
            amount,
            confidence,
            reasoning_hash,
            timestamp: decision.timestamp,
        });

        msg!("AI decision #{} recorded: type={} amount={} confidence={}",
            decision.id, decision_type, amount, confidence);
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN INSTRUCTIONS
    // ─────────────────────────────────────────────────────────────────────

    /// Admin: update fee rates manually.
    pub fn update_fees(
        ctx: Context<AdminOnly>,
        save_fee_bps: Option<u16>,
        borrow_fee_bps: Option<u16>,
        swap_fee_bps: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        if let Some(v) = save_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.save_fee_bps = v;
        }
        if let Some(v) = borrow_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.borrow_fee_bps = v;
        }
        if let Some(v) = swap_fee_bps {
            require!(v <= MAX_FEE_BPS, TreasuryError::FeeTooHigh);
            config.swap_fee_bps = v;
        }

        msg!("Fees updated: save={}bps, borrow={}bps, swap={}bps",
            config.save_fee_bps, config.borrow_fee_bps, config.swap_fee_bps);
        Ok(())
    }

    /// Admin: designate AI oracle account that can call ai_update_fees and record_ai_decision.
    pub fn set_ai_oracle(ctx: Context<AdminOnly>, new_oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.ai_oracle = new_oracle;
        emit!(AiOracleChanged {
            new_oracle,
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("AI oracle set to: {}", new_oracle);
        Ok(())
    }

    /// Admin: update treasury address.
    pub fn update_treasury(ctx: Context<AdminOnly>, new_treasury: Pubkey) -> Result<()> {
        ctx.accounts.config.treasury = new_treasury;
        msg!("Treasury updated to: {}", new_treasury);
        Ok(())
    }

    /// Admin: pause/unpause fee collection.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        msg!("Paused: {}", paused);
        Ok(())
    }

    /// Admin: transfer admin role.
    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        msg!("Admin transferred to: {}", new_admin);
        Ok(())
    }
}

// ── Helpers ──

fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(TreasuryError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(TreasuryError::Overflow)? as u64;
    Ok(fee)
}

fn transfer_fee(ctx: &Context<CollectFee>, fee: u64) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.treasury_token_account.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, fee, ctx.accounts.mint.decimals)
}

// ── Accounts ──

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + TreasuryConfig::INIT_SPACE,
        seeds = [b"treasury-config"],
        bump,
    )]
    pub config: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectFee<'info> {
    #[account(
        mut,
        seeds = [b"treasury-config"],
        bump = config.bump,
    )]
    pub config: Account<'info, TreasuryConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ TreasuryError::InvalidOwner,
        constraint = user_token_account.mint == mint.key() @ TreasuryError::InvalidOwner,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury @ TreasuryError::InvalidTreasury,
        constraint = treasury_token_account.mint == mint.key() @ TreasuryError::InvalidTreasury,
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"treasury-config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ TreasuryError::Unauthorized,
    )]
    pub config: Account<'info, TreasuryConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AiOracleOnly<'info> {
    #[account(
        mut,
        seeds = [b"treasury-config"],
        bump = config.bump,
        constraint = config.ai_oracle == ai_oracle.key() @ TreasuryError::NotAiOracle,
    )]
    pub config: Account<'info, TreasuryConfig>,
    pub ai_oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct RecordAiDecision<'info> {
    #[account(
        mut,
        seeds = [b"treasury-config"],
        bump = config.bump,
        constraint = config.ai_oracle == ai_oracle.key() @ TreasuryError::NotAiOracle,
    )]
    pub config: Account<'info, TreasuryConfig>,

    #[account(
        init,
        payer = ai_oracle,
        space = 8 + AiDecision::INIT_SPACE,
        seeds = [b"ai-decision", &config.total_ai_decisions.to_le_bytes()],
        bump,
    )]
    pub decision: Account<'info, AiDecision>,

    #[account(mut)]
    pub ai_oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── State ──

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub ai_oracle: Pubkey,
    pub save_fee_bps: u16,
    pub borrow_fee_bps: u16,
    pub swap_fee_bps: u16,
    pub paused: bool,
    pub total_fees_collected: u64,
    pub total_ai_decisions: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AiDecision {
    pub id: u64,
    pub oracle: Pubkey,
    pub decision_type: u8,
    pub asset: [u8; 8],
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
    pub bump: u8,
}

// ── Events ──

#[event]
pub struct AiFeesUpdated {
    pub decision_id: u64,
    pub oracle: Pubkey,
    pub old_save_bps: u16,
    pub new_save_bps: u16,
    pub old_borrow_bps: u16,
    pub new_borrow_bps: u16,
    pub old_swap_bps: u16,
    pub new_swap_bps: u16,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct AiDecisionRecorded {
    pub decision_id: u64,
    pub oracle: Pubkey,
    pub decision_type: u8,
    pub asset: [u8; 8],
    pub amount: u64,
    pub confidence: u8,
    pub reasoning_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct AiOracleChanged {
    pub new_oracle: Pubkey,
    pub timestamp: i64,
}

// ── Errors ──

#[error_code]
pub enum TreasuryError {
    #[msg("Unauthorized: only admin can call this")]
    Unauthorized,
    #[msg("Not the designated AI oracle")]
    NotAiOracle,
    #[msg("Fee collection is paused")]
    Paused,
    #[msg("Fee rate too high (max 500 bps / 5%)")]
    FeeTooHigh,
    #[msg("AI confidence too low (min 70)")]
    LowConfidence,
    #[msg("AI confidence value invalid (must be 0-100)")]
    InvalidConfidence,
    #[msg("Invalid decision type (must be 1-5)")]
    InvalidDecisionType,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Treasury token account does not match config")]
    InvalidTreasury,
}
