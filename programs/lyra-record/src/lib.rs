use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::get_stats::__client_accounts_get_stats;
use instructions::get_stats::{GetStats, StatsResponse};
use instructions::initialize::Initialize;
use instructions::initialize::__client_accounts_initialize;
use instructions::record_trade::RecordTrade;
use instructions::record_trade::__client_accounts_record_trade;

declare_id!("EWhJUBt4mTrpPmwwZFrsC2aCRR7tPpMFUxCKE1JGWFZK");

#[program]
pub mod lyra_record {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    pub fn record_trade(
        ctx: Context<RecordTrade>,
        entry_price: i64,
        exit_price: i64,
        open_timestamp: i64,
        close_timestamp: i64,
        pair: String,
        pnl: i64,
        result: state::TradeResult,
    ) -> Result<()> {
        instructions::record_trade::handler(
            ctx,
            entry_price,
            exit_price,
            open_timestamp,
            close_timestamp,
            pair,
            pnl,
            result,
        )
    }

    pub fn get_stats(ctx: Context<GetStats>) -> Result<StatsResponse> {
        instructions::get_stats::handler(ctx)
    }
}
