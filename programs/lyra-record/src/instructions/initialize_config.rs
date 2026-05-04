use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::state::AgentConfig;

/// Creates the AgentConfig PDA for `owner`. Can only succeed once per owner address
/// because Anchor's `init` constraint rejects an account that already exists.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AgentConfig::LEN,
        seeds = [CONFIG_SEED, owner.key().as_ref()],
        bump
    )]
    pub config: Account<'info, AgentConfig>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    agent: Pubkey,
    agent_version: u32,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.owner = ctx.accounts.owner.key();
    config.agent = agent;
    config.agent_version = agent_version;
    config.is_active = true;
    config.trade_count = 0;
    config.total_closed = 0;
    config.total_wins = 0;
    config.total_losses = 0;
    config.total_breakeven = 0;
    config.cumulative_pnl = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}
