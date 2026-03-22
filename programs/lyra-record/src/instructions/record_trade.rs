use crate::errors::LyraError;
use crate::state::{Trade, TradeResult, TradingRecord};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RecordTrade<'info> {
    #[account(
        mut,
        seeds = [b"lyra", owner.key().as_ref()],
        bump,
        has_one = owner @ LyraError::Unauthorized
    )]
    pub trading_record: Account<'info, TradingRecord>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn handler(
    ctx: Context<RecordTrade>,
    entry_price: i64,
    exit_price: i64,
    open_timestamp: i64,
    close_timestamp: i64,
    pair: String,
    pnl: i64,
    result: TradeResult,
) -> Result<()> {
    let trading_record = &mut ctx.accounts.trading_record;

    // 1. check account is not full
    require!(
        trading_record.total_trades < TradingRecord::MAX_TRADES as u32,
        LyraError::AccountFull
    );

    // 2. validate prices
    require!(entry_price > 0 && exit_price > 0, LyraError::InvalidPrice);

    // 3. validate pair
    require!(!pair.is_empty(), LyraError::InvalidPair);
    require!(pair.len() <= 12, LyraError::PairTooLong);

    // 4. validate timestamps
    require!(
        close_timestamp > open_timestamp,
        LyraError::InvalidTimestamp
    );

    // 5. build the trade
    let trade = Trade {
        entry_price,
        exit_price,
        open_timestamp,
        close_timestamp,
        pair,
        pnl,
        result: result.clone(),
    };

    // 6. update running stats atomically
    match result {
        TradeResult::Win => trading_record.total_wins += 1,
        TradeResult::Loss => trading_record.total_losses += 1,
        TradeResult::Breakeven => trading_record.total_breakeven += 1,
    }

    trading_record.cumulative_pnl = trading_record
        .cumulative_pnl
        .checked_add(pnl)
        .ok_or(LyraError::Overflow)?;

    trading_record.total_trades += 1;
    trading_record.trades.push(trade);

    Ok(())
}
