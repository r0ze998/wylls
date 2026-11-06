//! The NFT resident commands (tags 0xE0–0xE2, workstream 4's allocation,
//! provisional). Only compiled with `nft-experimental`; the default build
//! refuses these tags as unknown.
use crate::{FrontierError, R};
use frontier_abi::resident_wire::{self, Command};
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

pub fn dispatch(program: &Pubkey, accounts: &[AccountInfo<'_>], data: &[u8]) -> R<()> {
    match resident_wire::decode(data).ok_or(FrontierError::BadData)? {
        Command::CreatePolicy(policy) => {
            let [authority, config, program_account, programdata, system] = accounts else {
                return Err(FrontierError::TooManyAccounts.into());
            };
            if *system.key != crate::init::SYSTEM
                || !authority.is_signer
                || !authority.is_writable
                || !config.is_writable
            {
                return Err(FrontierError::BadAccount.into());
            }
            crate::resident_binding::create_policy(
                program,
                authority,
                config,
                program_account,
                programdata,
                &policy,
            )
        }
        Command::Act { generation, inner } => {
            crate::proc::resident::act(program, accounts, generation, inner)
        }
        Command::Join {
            generation,
            faction,
        } => crate::proc::resident::join(program, accounts, generation, faction),
    }
}
