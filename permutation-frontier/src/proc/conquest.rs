//! The conquest instructions (MC contract §5.5): DeclareSiege (0xA0),
//! SettleSiege (0xA1), SettleCapture (0xA2), FileOutpost (0xA3, CQ2-A),
//! FoldMarch (0xA5), RetireHost (0xA6), CloseMarch (0xA7).
//!
//! **Stub (CQ2-A's first commit, §11 Wave 2):** every handler returns
//! `NotImplemented` (99) until its unit hands it in (CQ2-C; FileOutpost
//! CQ2-A).

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use crate::{FrontierError, R};

macro_rules! stubs {
    ($($name:ident),* $(,)?) => {$(
        pub fn $name(_p: &Pubkey, _a: &[AccountInfo], _d: &[u8]) -> R<()> {
            Err(FrontierError::NotImplemented.into())
        }
    )*};
}

stubs!(
    declare_siege,
    settle_siege,
    settle_capture,
    file_outpost,
    fold_march,
    retire_host,
    close_march,
);
