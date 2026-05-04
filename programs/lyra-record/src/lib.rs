use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

// Anchor's #[program] macro requires both the Accounts struct and the
// auto-generated __client_accounts_* companion to build the IDL dispatcher.
use instructions::close_trade::{CloseTrade, __client_accounts_close_trade};
use instructions::initialize_config::{InitializeConfig, __client_accounts_initialize_config};
use instructions::open_trade::{OpenTrade, __client_accounts_open_trade};
use instructions::record_completed_trade::{
    RecordCompletedTrade, __client_accounts_record_completed_trade,
};
use instructions::revoke_agent::{RevokeAgent, __client_accounts_revoke_agent};
use instructions::update_agent::{UpdateAgent, __client_accounts_update_agent};

declare_id!("BGi3VRCKEoRcc85MsND4C4tA1i1v9TbzDPA2vN3LfXcj");

#[program]
pub mod lyra_record {
    use super::*;

    /// Creates the AgentConfig PDA for `owner`. Must be called once before any
    /// trades can be recorded. The `agent` keypair passed here will be the only
    /// wallet authorized to call `open_trade`, `close_trade`, and
    /// `record_completed_trade`.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        agent: Pubkey,
        agent_version: u32,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, agent, agent_version)
    }

    /// Owner rotates the authorized agent keypair and/or bumps the strategy version.
    /// Also re-activates a previously revoked config.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        new_agent: Pubkey,
        new_version: u32,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, new_agent, new_version)
    }

    /// Owner emergency-stops the agent. No trades can be recorded until
    /// `update_agent` is called again.
    pub fn revoke_agent(ctx: Context<RevokeAgent>) -> Result<()> {
        instructions::revoke_agent::handler(ctx)
    }

    /// Agent opens a new position. Creates an immutable TradeRecord PDA with
    /// `status = Open`. The record can be finalized later via `close_trade`.
    pub fn open_trade(
        ctx: Context<OpenTrade>,
        pair: [u8; 16],
        direction: state::TradeDirection,
        entry_price: u64,
        notional_usd: u64,
        leverage: u8,
        open_ts: i64,
        strategy_id: [u8; 8],
        signal_source: [u8; 32],
        arweave_hash: [u8; 32],
    ) -> Result<()> {
        instructions::open_trade::handler(
            ctx, pair, direction, entry_price, notional_usd,
            leverage, open_ts, strategy_id, signal_source, arweave_hash,
        )
    }

    /// Agent finalizes an open position. Sets `status` to `Closed` or `Liquidated`
    /// and writes exit data. The record becomes permanently immutable after this call.
    pub fn close_trade(
        ctx: Context<CloseTrade>,
        trade_index: u64,
        exit_price: u64,
        close_ts: i64,
        pnl: i64,
        outcome: state::TradeOutcome,
        status: state::TradeStatus,
        arweave_hash: [u8; 32],
    ) -> Result<()> {
        instructions::close_trade::handler(
            ctx, trade_index, exit_price, close_ts, pnl,
            outcome, status, arweave_hash,
        )
    }

    /// Agent records a fully completed trade in a single transaction.
    /// Use this when trade data arrives already resolved (e.g. Hyperliquid fills).
    /// Cheaper than `open_trade` + `close_trade` combined.
    pub fn record_completed_trade(
        ctx: Context<RecordCompletedTrade>,
        pair: [u8; 16],
        direction: state::TradeDirection,
        entry_price: u64,
        exit_price: u64,
        notional_usd: u64,
        leverage: u8,
        open_ts: i64,
        close_ts: i64,
        pnl: i64,
        outcome: state::TradeOutcome,
        strategy_id: [u8; 8],
        signal_source: [u8; 32],
        arweave_hash: [u8; 32],
    ) -> Result<()> {
        instructions::record_completed_trade::handler(
            ctx, pair, direction, entry_price, exit_price, notional_usd,
            leverage, open_ts, close_ts, pnl, outcome, strategy_id,
            signal_source, arweave_hash,
        )
    }
}
