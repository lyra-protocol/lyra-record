use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::errors::LyraError;
use crate::state::AgentConfig;

/// Owner rotates the agent keypair or bumps the strategy version.
/// Also re-activates a previously revoked config.
#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, owner.key().as_ref()],
        bump = config.bump,
        has_one = owner @ LyraError::Unauthorized,
    )]
    pub config: Account<'info, AgentConfig>,

    pub owner: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateAgent>,
    new_agent: Pubkey,
    new_version: u32,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.agent = new_agent;
    config.agent_version = new_version;
    config.is_active = true;
    Ok(())
}
