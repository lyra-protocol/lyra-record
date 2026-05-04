use anchor_lang::prelude::*;

#[error_code]
pub enum LyraError {
    // ── Authorization ──────────────────────────────────────────────────────────
    #[msg("Only the account owner may call this instruction.")]
    Unauthorized,

    #[msg("The signer is not the authorized agent for this owner.")]
    UnauthorizedAgent,

    #[msg("The owner field does not match the provided owner account.")]
    OwnerMismatch,

    #[msg("Agent authority has been revoked. Owner must call update_agent to re-authorize.")]
    AgentRevoked,

    // ── Input validation ───────────────────────────────────────────────────────
    #[msg("Entry price must be greater than zero.")]
    InvalidEntryPrice,

    #[msg("Exit price must be greater than zero.")]
    InvalidExitPrice,

    #[msg("Notional USD must be greater than zero.")]
    InvalidNotional,

    #[msg("Leverage must be between 1 and MAX_LEVERAGE (40).")]
    InvalidLeverage,

    #[msg("open_ts must be a positive Unix timestamp (seconds).")]
    InvalidOpenTimestamp,

    #[msg("close_ts must be greater than or equal to open_ts.")]
    InvalidCloseTimestamp,

    /// Prevents a resolved outcome (Win/Loss/Breakeven) from being treated as
    /// Pending when closing a trade, which would corrupt aggregate stats.
    #[msg("outcome must be Win, Loss, or Breakeven when closing a trade — not Pending.")]
    InvalidOutcome,

    /// close_trade must transition to Closed or Liquidated, never back to Open.
    #[msg("status supplied to close_trade must be Closed or Liquidated, not Open.")]
    InvalidCloseStatus,

    // ── Immutability ───────────────────────────────────────────────────────────
    /// The core safety guarantee: once closed, a TradeRecord is permanently immutable.
    #[msg("This trade record is already Closed or Liquidated. Closed records cannot be modified.")]
    TradeAlreadyClosed,

    // ── Arithmetic ─────────────────────────────────────────────────────────────
    #[msg("Arithmetic overflow. Operation would exceed the maximum representable value.")]
    ArithmeticOverflow,
}
