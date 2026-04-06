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
        config.save_fee_bps = SAVE_FEE_BPS;
        config.borrow_fee_bps = BORROW_FEE_BPS;
        config.swap_fee_bps = SWAP_FEE_BPS;
        config.paused = false;
        config.total_fees_collected = 0;
        config.bump = ctx.bumps.config;
        msg!("Treasury initialized. Admin: {}, Treasury: {}", config.admin, config.treasury);
        Ok(())
    }

    /// Collect fee on a lend/save operation.
    /// Transfers fee_amount from user's token account to treasury token account.
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

    /// Admin: update fee rates.
    pub fn update_fees(
        ctx: Context<AdminOnly>,
        save_fee_bps: Option<u16>,
        borrow_fee_bps: Option<u16>,
        swap_fee_bps: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        if let Some(v) = save_fee_bps {
            require!(v <= 500, TreasuryError::FeeTooHigh); // max 5%
            config.save_fee_bps = v;
        }
        if let Some(v) = borrow_fee_bps {
            require!(v <= 500, TreasuryError::FeeTooHigh);
            config.borrow_fee_bps = v;
        }
        if let Some(v) = swap_fee_bps {
            require!(v <= 500, TreasuryError::FeeTooHigh);
            config.swap_fee_bps = v;
        }

        msg!("Fees updated: save={}bps, borrow={}bps, swap={}bps",
            config.save_fee_bps, config.borrow_fee_bps, config.swap_fee_bps);
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

    /// Token mint (USDC).
    pub mint: InterfaceAccount<'info, Mint>,

    /// User's USDC token account (fee is taken from here).
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ TreasuryError::InvalidOwner,
        constraint = user_token_account.mint == mint.key() @ TreasuryError::InvalidOwner,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Treasury's USDC token account (fee goes here).
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

// ── State ──

#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub save_fee_bps: u16,
    pub borrow_fee_bps: u16,
    pub swap_fee_bps: u16,
    pub paused: bool,
    pub total_fees_collected: u64,
    pub bump: u8,
}

// ── Errors ──

#[error_code]
pub enum TreasuryError {
    #[msg("Unauthorized: only admin can call this")]
    Unauthorized,
    #[msg("Fee collection is paused")]
    Paused,
    #[msg("Fee rate too high (max 500 bps / 5%)")]
    FeeTooHigh,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Treasury token account does not match config")]
    InvalidTreasury,
}
