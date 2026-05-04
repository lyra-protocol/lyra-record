use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::errors::LyraError;
use crate::state::AgentConfig;

/// Emergency stop: owner sets `is_active = false`.
/// The agent cannot open or close any trades until `update_agent` is called.
/// Trades already open on external exchanges are unaffected; they simply
/// will not be recorded until authority is restored.
#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, owner.key().as_ref()],
        bump = config.bump,
        has_one = owner @ LyraError::Unauthorized,
    )]
    pub config: Account<'info, AgentConfig>,

    pub owner: Signer<'info>,
}

pub fn handler(ctx: Context<RevokeAgent>) -> Result<()> {
    ctx.accounts.config.is_active = false;
    Ok(())
}
