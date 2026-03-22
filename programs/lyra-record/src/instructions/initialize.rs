use crate::errors::LyraError;
use crate::state::TradingRecord;
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let trading_record = &mut ctx.accounts.trading_record;

    require!(
        !trading_record.is_initialized,
        LyraError::AlreadyInitialized
    );

    trading_record.owner = ctx.accounts.owner.key();
    trading_record.trades = Vec::new();
    trading_record.total_trades = 0;
    trading_record.total_wins = 0;
    trading_record.total_losses = 0;
    trading_record.total_breakeven = 0;
    trading_record.cumulative_pnl = 0;
    trading_record.is_initialized = true;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = TradingRecord::LEN,
        seeds = [b"lyra", owner.key().as_ref()],
        bump
    )]
    pub trading_record: Account<'info, TradingRecord>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}
