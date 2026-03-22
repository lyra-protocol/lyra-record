use anchor_lang::prelude::*;

#[error_code]
pub enum LyraError {
    #[msg("Unauthorized. Only the account owner can record trades.")]
    Unauthorized,

    #[msg("Invalid price. Entry and exit prices must be greater than zero.")]
    InvalidPrice,

    #[msg("Invalid pair. Trading pair cannot be empty.")]
    InvalidPair,

    #[msg("Invalid pair. Trading pair cannot exceed 12 characters.")]
    PairTooLong,

    #[msg("Invalid timestamps. Close time cannot be before open time.")]
    InvalidTimestamp,

    #[msg("Arithmetic overflow. Cumulative PnL exceeded maximum value.")]
    Overflow,

    #[msg("Account is full. Maximum trades reached.")]
    AccountFull,

    #[msg("Account already initialized.")]
    AlreadyInitialized,
}
