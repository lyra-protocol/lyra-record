/// All prices and PnL values are stored as integers scaled by this factor.
/// $1.00 → 1_000_000. $45,231.50 → 45_231_500_000.
pub const PRICE_DECIMALS: u64 = 1_000_000;

/// Hard ceiling on leverage. Matches the MCP server cap.
pub const MAX_LEVERAGE: u8 = 40;

/// Byte length of the `pair` field on TradeRecord. Null-padded ASCII.
/// e.g. b"SOL/USDC\0\0\0\0\0\0\0\0"
pub const PAIR_LEN: usize = 16;

/// Byte length of the `signal_source` field. Null-padded ASCII.
/// e.g. b"tradingview:WHALE_COPY\0\0\0\0\0\0\0\0\0\0"
pub const SOURCE_LEN: usize = 32;

/// Byte length of the on-chain Arweave anchor.
/// Store the SHA-256 of the full 43-char base58 Arweave TX ID here.
/// Zero bytes until the Decision Object has been persisted off-chain.
pub const ARWEAVE_HASH_LEN: usize = 32;

/// 8-byte truncated fingerprint of the strategy parameter set active at execution.
pub const STRATEGY_ID_LEN: usize = 8;

/// PDA seed for AgentConfig accounts.
pub const CONFIG_SEED: &[u8] = b"lyra_config";

/// PDA seed for TradeRecord accounts.
pub const TRADE_SEED: &[u8] = b"lyra_trade";
