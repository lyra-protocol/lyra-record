use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TradeResult {
    Win,
    Loss,
    Breakeven,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Trade {
    pub entry_price: i64,
    pub exit_price: i64,
    pub open_timestamp: i64,
    pub close_timestamp: i64,
    pub pair: String,
    pub pnl: i64,
    pub result: TradeResult,
}

#[account]
pub struct TradingRecord {
    pub owner: Pubkey,
    pub is_initialized: bool,
    pub trades: Vec<Trade>,
    pub total_trades: u32,
    pub total_wins: u32,
    pub total_losses: u32,
    pub total_breakeven: u32,
    pub cumulative_pnl: i64,
}
impl TradingRecord {
    // Keep max account size under Solana CPI reallocation limits during `init`.
    pub const MAX_TRADES: usize = 150;

    pub const LEN: usize = 8 +                              // Anchor account discriminator
        32 +                             // owner Pubkey
        4 + (Trade::LEN * Self::MAX_TRADES) + // trades Vec (4 byte prefix + max trades)
        4 +                              // total_trades u32
        4 +                              // total_wins u32
        4 +                              // total_losses u32
        4 +                              // total_breakeven u32
        1+                               // initialize bool
        8; // cumulative_pnl i64
}

impl Trade {
    pub const LEN: usize = 8 +   // entry_price i64
        8 +   // exit_price i64
        8 +   // open_timestamp i64
        8 +   // close_timestamp i64
        4 + 12 + // pair String (4 bytes length prefix + 12 bytes max)
        8 +   // pnl i64
        1; // result enum (1 byte)
}
