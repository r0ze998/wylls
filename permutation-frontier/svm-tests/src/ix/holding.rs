//! Holding builders (§5.10): Harvest, Build, Train, Explore, SettleExplore
//! (W3-B). The builders are `fclient::ix`'s; the positions below serve
//! forgeries.
//!
//! **MC (CQ2-A, conquest contract §5.6):** Harvest, Build and Train carry
//! the holding's own Province (the capture lock): `[province r]` for
//! Harvest and Train, `[province r|w]` for Build (writable for walls and
//! the tier-up). The wrappers below append it to fclient's M1 lists, with
//! the same signatures, so every caller sends the v2 shape.

use fclient::addr::Addresses;
pub use fclient::ix::{explore, settle_explore, HoldingRef, Player, SeedSource};
use solana_instruction::{AccountMeta, Instruction};

/// The Build item of the tier-up (after the six buildings and the walls).
pub const ITEM_TIER_UP: u8 = permutation_rules::frontier::catalog::ITEM_COUNT;

/// 0x40 Harvest v2: P + `[holding w] [province r]`.
pub fn harvest(a: &Addresses, p: &Player, h: HoldingRef) -> Instruction {
    let mut ix = fclient::ix::harvest(a, p, h);
    ix.accounts
        .push(AccountMeta::new_readonly(h.province(a), false));
    ix
}

/// 0x41 Build v2: P + `[holding w] [province r|w]` (writable for walls and
/// the tier-up; `walls` as fclient's argument).
pub fn build_item(a: &Addresses, p: &Player, h: HoldingRef, item: u8, walls: bool) -> Instruction {
    let mut ix = fclient::ix::build_item(a, p, h, item, false);
    let writable = walls || item == ITEM_TIER_UP;
    ix.accounts.push(if writable {
        AccountMeta::new(h.province(a), false)
    } else {
        AccountMeta::new_readonly(h.province(a), false)
    });
    ix
}

/// 0x42 Train v2: P + `[holding w] [province r]`.
pub fn train(a: &Addresses, p: &Player, h: HoldingRef, unit: u8, n: u32) -> Instruction {
    let mut ix = fclient::ix::train(a, p, h, unit, n);
    ix.accounts
        .push(AccountMeta::new_readonly(h.province(a), false));
    ix
}

/// Positions of the player prologue and a resident instruction's accounts
/// (§5.6, §5.10).
pub mod at {
    pub const ACTOR: usize = 0;
    pub const PAYER: usize = 1;
    pub const SEASON: usize = 2;
    pub const CITIZEN: usize = 3;
    pub const HOLDING: usize = 4;
    pub const PROVINCE: usize = 5;
}

/// Positions of SettleExplore's accounts (§5.10).
pub mod settle_at {
    pub const PAYER: usize = 0;
    pub const SEASON: usize = 1;
    pub const HOLDING: usize = 2;
    pub const CITIZEN: usize = 3;
    pub const SEED: usize = 4;
    pub const ANCHOR: usize = 5;
}
