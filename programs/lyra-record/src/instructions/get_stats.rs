use crate::state::TradingRecord;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct GetStats<'info> {
    #[account(
        seeds = [b"lyra", owner.key().as_ref()],
        bump,
    )]
    pub trading_record: Account<'info, TradingRecord>,

    pub owner: SystemAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct StatsResponse {
    pub total_trades: u32,
    pub total_wins: u32,
    pub total_losses: u32,
    pub total_breakeven: u32,
    pub cumulative_pnl: i64,
    pub win_rate: u8,
    pub average_pnl: i64,
}

pub fn handler(ctx: Context<GetStats>) -> Result<StatsResponse> {
    let trading_record = &ctx.accounts.trading_record;

    // calculate win rate as a percentage 0-100
    let win_rate = if trading_record.total_trades > 0 {
        ((trading_record.total_wins as f64 / trading_record.total_trades as f64) * 100.0) as u8
    } else {
        0
    };

    // calculate average pnl per trade
    let average_pnl = if trading_record.total_trades > 0 {
        trading_record
            .cumulative_pnl
            .checked_div(trading_record.total_trades as i64)
            .unwrap_or(0)
    } else {
        0
    };

    Ok(StatsResponse {
        total_trades: trading_record.total_trades,
        total_wins: trading_record.total_wins,
        total_losses: trading_record.total_losses,
        total_breakeven: trading_record.total_breakeven,
        cumulative_pnl: trading_record.cumulative_pnl,
        win_rate,
        average_pnl,
    })
}
