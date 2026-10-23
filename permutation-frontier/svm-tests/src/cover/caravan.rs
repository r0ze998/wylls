//! Coverage of the S1 vault and caravan instructions (stage 1b,
//! `docs/frontier/stage1b/S1-1B-CONTRACT.md` §6): BuildVault, SendCaravan,
//! SettleCaravan, RaidCaravan, SeizeVault, CloseVault and DefaultRaid. S1
//! codes are asserted as `CqErr(Cq::X)` (the v2 error space).
//!
//! The raids are crafted in the Province's caravan slot until stage 1c's
//! clash raids caravans (`tests/caravan.rs`, module note).

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const PENDING: &[(&str, &str)] = &[];

pub const BUILD_VAULT: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_build_vault_lands_pays_and_counts",
        &[Lands("build_vault()")],
    ),
    Cover::Test(
        "caravan::g13_s1_build_vault_refusals",
        &[
            CqErr(Cq::VaultSite),
            CqErr(Cq::VaultLimit),
            Err(E::Insufficient),
        ],
    ),
];

pub const SEND_CARAVAN: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_send_and_settle_to_own_vault",
        &[Lands("k.send(&x)")],
    ),
    Cover::Test(
        "caravan::g13_s1_send_from_vault_to_holding_and_a_lost_destination",
        &[Lands("SendCaravan from a vault")],
    ),
    Cover::Test(
        "caravan::g13_s1_send_caravan_refusals",
        &[
            Err(E::BadData),
            Err(E::Path),
            Err(E::Insufficient),
            CqErr(Cq::WalletRequired),
            CqErr(Cq::ProvinceBusy),
        ],
    ),
];

pub const SETTLE_CARAVAN: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_send_and_settle_to_own_vault",
        &[
            Lands("SettleCaravan"),
            CqErr(Cq::CaravanEarly),
            Err(E::BadAccount),
        ],
    ),
    Cover::Test(
        "caravan::g13_s1_send_from_vault_to_holding_and_a_lost_destination",
        &[Lands("SettleCaravan, lost")],
    ),
    Cover::Test(
        "caravan::g13_s1_raid_take_sends_the_loot_and_the_rest_goes_on",
        &[CqErr(Cq::RaidState), Lands("settle the loot")],
    ),
];

pub const RAID_CARAVAN: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_raid_take_sends_the_loot_and_the_rest_goes_on",
        &[
            Lands("RaidCaravan take"),
            Err(E::NotOwner),
            CqErr(Cq::RaidState),
        ],
    ),
    Cover::Test(
        "caravan::g13_s1_raid_take_on_the_raiders_own_tile",
        &[Lands("RaidCaravan take on the raider")],
    ),
    Cover::Test(
        "caravan::g13_s1_raid_burn_and_the_window",
        &[Lands("burn"), CqErr(Cq::RaidWindow)],
    ),
];

pub const SEIZE_VAULT: &[Cover] = &[Cover::Test(
    "caravan::g13_s1_seize_vault_by_standing_on_it",
    &[
        Lands("SeizeVault"),
        CqErr(Cq::NotOnTile),
        CqErr(Cq::VaultLimit),
    ],
)];

pub const CLOSE_VAULT: &[Cover] = &[Cover::Test(
    "caravan::g13_s1_close_vault",
    &[
        Lands("CloseVault"),
        CqErr(Cq::WalletRequired),
        Err(E::BadData),
        Err(E::NotOwner),
    ],
)];

pub const DEFAULT_RAID: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_default_raid_takes_home_after_the_window",
        &[Lands("DefaultRaid"), CqErr(Cq::RaidWindow)],
    ),
    Cover::Test(
        "caravan::g13_s1_default_raid_burns_when_the_raiders_holding_is_gone",
        &[Lands("DefaultRaid burn")],
    ),
    Cover::Test(
        "caravan::g13_s1_default_raid_burns_late_without_a_walk_home",
        &[Lands("DefaultRaid late burn"), CqErr(Cq::RaidWindow)],
    ),
];
