use anchor_lang::prelude::*;
use crate::constants::{ARWEAVE_HASH_LEN, CONFIG_SEED, TRADE_SEED};
use crate::errors::LyraError;
use crate::state::{AgentConfig, TradeOutcome, TradeRecord, TradeStatus};

/// Agent closes an open position.
///
/// After this call the TradeRecord is permanently immutable — the `TradeAlreadyClosed`
/// constraint on `trade_record` prevents any future writes to it.
///
/// The `trade_index` argument is consumed by `#[instruction]` to derive the
/// correct TradeRecord PDA; it is not used again in the handler body.
#[derive(Accounts)]
#[instruction(trade_index: u64)]
pub struct CloseTrade<'info> {
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
        mut,
        seeds = [TRADE_SEED, owner.key().as_ref(), &trade_index.to_le_bytes()],
        bump = trade_record.bump,
        constraint = trade_record.owner == owner.key()        @ LyraError::OwnerMismatch,
        constraint = trade_record.status == TradeStatus::Open @ LyraError::TradeAlreadyClosed,
    )]
    pub trade_record: Account<'info, TradeRecord>,

    /// CHECK: Verified via `has_one = owner` on config above.
    pub owner: AccountInfo<'info>,

    pub agent: Signer<'info>,
}

pub fn handler(
    ctx: Context<CloseTrade>,
    _trade_index: u64,
    exit_price: u64,
    close_ts: i64,
    pnl: i64,
    outcome: TradeOutcome,
    status: TradeStatus,
    arweave_hash: [u8; ARWEAVE_HASH_LEN],
) -> Result<()> {
    require!(exit_price > 0,                                      LyraError::InvalidExitPrice);
    require!(close_ts >= ctx.accounts.trade_record.open_ts,       LyraError::InvalidCloseTimestamp);
    require!(status != TradeStatus::Open,                         LyraError::InvalidCloseStatus);
    require!(outcome != TradeOutcome::Pending,                    LyraError::InvalidOutcome);

    // Write close fields — this record is now immutable.
    let trade = &mut ctx.accounts.trade_record;
    trade.exit_price   = exit_price;
    trade.close_ts     = close_ts;
    trade.pnl          = pnl;
    trade.outcome      = outcome.clone();
    trade.status       = status;
    trade.arweave_hash = arweave_hash;

    // Update aggregate stats on config.
    let config = &mut ctx.accounts.config;
    config.cumulative_pnl = config
        .cumulative_pnl
        .checked_add(pnl)
        .ok_or(LyraError::ArithmeticOverflow)?;
    config.total_closed = config
        .total_closed
        .checked_add(1)
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
        TradeOutcome::Pending => {
            // Guarded by require! above; unreachable in practice.
            return Err(LyraError::InvalidOutcome.into());
        }
    }

    Ok(())
}
