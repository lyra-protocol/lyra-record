use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::LyraError;
use crate::state::{AgentConfig, TradeDirection, TradeOutcome, TradeRecord, TradeStatus};

/// Agent opens a new position. Creates a fresh TradeRecord PDA at
/// [TRADE_SEED, owner, config.trade_count.to_le_bytes()].
///
/// The agent pays the account rent. The config counter is atomically
/// incremented after the record is written, guaranteeing no gaps or replay.
#[derive(Accounts)]
pub struct OpenTrade<'info> {
    /// Config is loaded first so its `trade_count` field is available
    /// as the seed component for the `trade_record` init below.
    #[account(
        mut,
        seeds = [CONFIG_SEED, owner.key().as_ref()],
        bump = config.bump,
        has_one = owner @ LyraError::OwnerMismatch,
        constraint = config.is_active       @ LyraError::AgentRevoked,
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

    /// The agent signs and pays for the new account's rent.
    #[account(mut)]
    pub agent: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<OpenTrade>,
    pair: [u8; PAIR_LEN],
    direction: TradeDirection,
    entry_price: u64,
    notional_usd: u64,
    leverage: u8,
    open_ts: i64,
    strategy_id: [u8; STRATEGY_ID_LEN],
    signal_source: [u8; SOURCE_LEN],
    arweave_hash: [u8; ARWEAVE_HASH_LEN],
) -> Result<()> {
    require!(entry_price > 0,                    LyraError::InvalidEntryPrice);
    require!(notional_usd > 0,                   LyraError::InvalidNotional);
    require!(leverage >= 1 && leverage <= MAX_LEVERAGE, LyraError::InvalidLeverage);
    require!(open_ts > 0,                        LyraError::InvalidOpenTimestamp);

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
    trade.exit_price    = 0;
    trade.notional_usd  = notional_usd;
    trade.leverage      = leverage;
    trade.open_ts       = open_ts;
    trade.close_ts      = 0;
    trade.pnl           = 0;
    trade.outcome       = TradeOutcome::Pending;
    trade.status        = TradeStatus::Open;
    trade.arweave_hash  = arweave_hash;
    trade.signal_source = signal_source;
    trade.bump          = ctx.bumps.trade_record;

    // Increment after writing trade_index to ensure atomicity.
    config.trade_count = config
        .trade_count
        .checked_add(1)
        .ok_or(LyraError::ArithmeticOverflow)?;

    Ok(())
}
