use anchor_lang::prelude::*;

declare_id!("EWhJUBt4mTrpPmwwZFrsC2aCRR7tPpMFUxCKE1JGWFZK");

#[program]
pub mod lyra_record {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
