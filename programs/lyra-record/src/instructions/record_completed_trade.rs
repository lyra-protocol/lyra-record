use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LyraError;
use crate::state::{AgentConfig, TradeDirection, TradeOutcome, TradeRecord, TradeStatus};

/// Records a fully completed trade in a single transaction.
///
/// Equivalent to `open_trade` followed immediately by `close_trade`, but cheaper
/// in compute and rent because only one account is created. Use this when trade
/// data (e.g. Hyperliquid historical fills) arrives already resolved.
#[derive(Accounts)]
pub struct RecordCompletedTrade<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, owner.key().as_ref()],
        bump = config.bump,
        has_one = owner @ LyraError::OwnerMismatch,
        constraint = config.is_active            @ LyraError::AgentRevoked,
        constraint = config.agent == agent.key() @ LyraError::UnauthorizedAgent,
    )]
    pub config: Account<'info, AgentConfig>,

    #[account(
        init,
        payer = agent,
        space = 8 + TradeRecord::LEN,
        seeds = [TRADE_SEED, owner.key().as_ref(), &config.trade_count.to_le_bytes()],
        bump
    )]
    pub trade_record: Account<'info, TradeRecord>,

    /// CHECK: Verified via `has_one = owner` on config above.
    pub owner: AccountInfo<'info>,

    #[account(mut)]
    pub agent: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordCompletedTrade>,
    pair: [u8; PAIR_LEN],
    direction: TradeDirection,
    entry_price: u64,
    exit_price: u64,
    notional_usd: u64,
    leverage: u8,
    open_ts: i64,
    close_ts: i64,
    pnl: i64,
    outcome: TradeOutcome,
    strategy_id: [u8; STRATEGY_ID_LEN],
    signal_source: [u8; SOURCE_LEN],
    arweave_hash: [u8; ARWEAVE_HASH_LEN],
) -> Result<()> {
    require!(entry_price > 0,                          LyraError::InvalidEntryPrice);
    require!(exit_price > 0,                           LyraError::InvalidExitPrice);
    require!(notional_usd > 0,                         LyraError::InvalidNotional);
    require!(leverage >= 1 && leverage <= MAX_LEVERAGE, LyraError::InvalidLeverage);
    require!(open_ts > 0,                              LyraError::InvalidOpenTimestamp);
    require!(close_ts >= open_ts,                      LyraError::InvalidCloseTimestamp);
    require!(outcome != TradeOutcome::Pending,         LyraError::InvalidOutcome);

    let config = &mut ctx.accounts.config;
    let trade_index = config.trade_count;

    let trade = &mut ctx.accounts.trade_record;
    trade.owner         = ctx.accounts.owner.key();
    trade.agent         = ctx.accounts.agent.key();
    trade.agent_version = config.agent_version;
    trade.strategy_id   = strategy_id;
    trade.trade_index   = trade_index;
    trade.pair          = pair;
    trade.direction     = direction;
    trade.entry_price   = entry_price;
    trade.exit_price    = exit_price;
    trade.notional_usd  = notional_usd;
    trade.leverage      = leverage;
    trade.open_ts       = open_ts;
    trade.close_ts      = close_ts;
    trade.pnl           = pnl;
    trade.outcome       = outcome.clone();
    trade.status        = TradeStatus::Closed;
    trade.arweave_hash  = arweave_hash;
    trade.signal_source = signal_source;
    trade.bump          = ctx.bumps.trade_record;

    // Update counter and stats atomically in one instruction.
    config.trade_count = config
        .trade_count
        .checked_add(1)
        .ok_or(LyraError::ArithmeticOverflow)?;
    config.total_closed = config
        .total_closed
        .checked_add(1)
        .ok_or(LyraError::ArithmeticOverflow)?;
    config.cumulative_pnl = config
        .cumulative_pnl
        .checked_add(pnl)
        .ok_or(LyraError::ArithmeticOverflow)?;

    match outcome {
        TradeOutcome::Win => {
            config.total_wins = config
                .total_wins
                .checked_add(1)
                .ok_or(LyraError::ArithmeticOverflow)?;
        }
        TradeOutcome::Loss => {
            config.total_losses = config
                .total_losses
                .checked_add(1)
                .ok_or(LyraError::ArithmeticOverflow)?;
        }
        TradeOutcome::Breakeven => {
            config.total_breakeven = config
                .total_breakeven
                .checked_add(1)
                .ok_or(LyraError::ArithmeticOverflow)?;
        }
        TradeOutcome::Pending => unreachable!(), // guarded by require! above
    }

    Ok(())
}
