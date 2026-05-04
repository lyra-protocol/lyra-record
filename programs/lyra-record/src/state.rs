use anchor_lang::prelude::*;
use crate::constants::*;

// ─── Enums ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum TradeDirection {
    Long,
    Short,
}

/// A TradeRecord begins as `Open`. `close_trade` transitions it to `Closed` or
/// `Liquidated`. Once the status is no longer `Open`, the record is immutable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum TradeStatus {
    Open,
    Closed,
    Liquidated,
}

/// `Pending` is only valid while a trade is Open.
/// `close_trade` and `record_completed_trade` must supply a resolved outcome.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum TradeOutcome {
    Pending,
    Win,
    Loss,
    Breakeven,
}

// ─── AgentConfig ──────────────────────────────────────────────────────────────

/// Per-owner configuration account. Stores agent authority and aggregate stats.
///
/// PDA: [CONFIG_SEED, owner.key()]
#[account]
pub struct AgentConfig {
    /// The user who controls this config. Immutable after initialization.
    pub owner: Pubkey,
    /// The Solana keypair authorized to open and close trades on this owner's behalf.
    pub agent: Pubkey,
    /// Incremented each time the self-improvement loop deploys a new strategy version.
    /// Every TradeRecord stores the version active at execution so versions can be compared.
    pub agent_version: u32,
    /// When false the agent cannot write any records.
    /// Owners can revoke at any time; re-authorize via `update_agent`.
    pub is_active: bool,
    /// Monotonically increasing counter. Determines the PDA seed for the next TradeRecord.
    /// Represents total trades ever created (open + closed).
    pub trade_count: u64,
    /// Number of resolved (Closed + Liquidated) trades. Used with `trade_count` to
    /// compute open positions count off-chain: open = trade_count - total_closed.
    pub total_closed: u32,
    pub total_wins: u32,
    pub total_losses: u32,
    pub total_breakeven: u32,
    /// Cumulative realized PnL from closed trades in PRICE_DECIMALS units.
    /// Negative values represent a net loss. Overflow-checked on every update.
    pub cumulative_pnl: i64,
    /// Canonical PDA bump stored to avoid recomputation in CPIs.
    pub bump: u8,
}

impl AgentConfig {
    pub const LEN: usize =
          32  // owner
        + 32  // agent
        + 4   // agent_version
        + 1   // is_active
        + 8   // trade_count
        + 4   // total_closed
        + 4   // total_wins
        + 4   // total_losses
        + 4   // total_breakeven
        + 8   // cumulative_pnl
        + 1;  // bump
    // Serialized payload: 102 bytes + 8-byte Anchor discriminator = 110 bytes
}

// ─── TradeRecord ──────────────────────────────────────────────────────────────

/// Immutable record of a single trade. Each trade lives at its own PDA, giving
/// an unbounded, paginatable history. Once `status` is Closed or Liquidated,
/// no instruction may modify this account.
///
/// PDA: [TRADE_SEED, owner.key(), trade_index.to_le_bytes()]
#[account]
pub struct TradeRecord {
    /// The user this trade belongs to.
    pub owner: Pubkey,
    /// The agent keypair that executed this trade.
    pub agent: Pubkey,
    /// Agent version at time of execution. Links the trade to a specific
    /// self-improvement iteration for performance attribution.
    pub agent_version: u32,
    /// 8-byte truncated fingerprint of the strategy parameter set active at
    /// execution. Computed off-chain; used to group trades by strategy version.
    pub strategy_id: [u8; STRATEGY_ID_LEN],
    /// Sequence number within the owner's trade history. Matches the value of
    /// `AgentConfig.trade_count` at the moment this record was created.
    /// Immutable after open.
    pub trade_index: u64,
    /// Trading pair identifier, null-padded ASCII.
    /// e.g. b"SOL/USDC\0\0\0\0\0\0\0\0"
    pub pair: [u8; PAIR_LEN],
    pub direction: TradeDirection,
    /// Fill price at open in PRICE_DECIMALS units. Must be > 0.
    pub entry_price: u64,
    /// Fill price at close in PRICE_DECIMALS units. Zero while Open.
    pub exit_price: u64,
    /// Notional position size in USD × PRICE_DECIMALS.
    pub notional_usd: u64,
    /// Leverage multiplier (1–MAX_LEVERAGE). Enforced at the instruction level.
    pub leverage: u8,
    /// Unix timestamp (seconds) when the position was opened.
    pub open_ts: i64,
    /// Unix timestamp (seconds) when the position was closed. Zero while Open.
    pub close_ts: i64,
    /// Realized profit/loss in PRICE_DECIMALS units. Negative for a loss. Zero while Open.
    pub pnl: i64,
    pub outcome: TradeOutcome,
    pub status: TradeStatus,
    /// SHA-256 of the Arweave TX ID that holds the full Decision Object.
    /// Zero bytes until the Decision Object has been persisted to Arweave.
    /// The full Arweave TX ID is derived off-chain: base58_encode(sha256^-1(arweave_hash)).
    pub arweave_hash: [u8; ARWEAVE_HASH_LEN],
    /// Human-readable signal source, null-padded ASCII.
    /// e.g. b"tradingview:WHALE_COPY\0..." or b"claude:v3.0\0..."
    pub signal_source: [u8; SOURCE_LEN],
    /// Canonical PDA bump.
    pub bump: u8,
}

impl TradeRecord {
    pub const LEN: usize =
          32              // owner
        + 32              // agent
        + 4               // agent_version
        + STRATEGY_ID_LEN // strategy_id [u8; 8]
        + 8               // trade_index
        + PAIR_LEN        // pair [u8; 16]
        + 1               // direction enum
        + 8               // entry_price
        + 8               // exit_price
        + 8               // notional_usd
        + 1               // leverage
        + 8               // open_ts
        + 8               // close_ts
        + 8               // pnl
        + 1               // outcome enum
        + 1               // status enum
        + ARWEAVE_HASH_LEN// arweave_hash [u8; 32]
        + SOURCE_LEN      // signal_source [u8; 32]
        + 1;              // bump
    // Serialized payload: 177 bytes + 8-byte discriminator = 185 bytes
}
