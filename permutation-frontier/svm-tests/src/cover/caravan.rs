//! Coverage of the S1 vault and caravan instructions (stage 1b,
//! `docs/frontier/stage1b/S1-1B-CONTRACT.md` §6): BuildVault, SendCaravan,
//! SettleCaravan, RaidCaravan, SeizeVault, CloseVault and DefaultRaid. S1
//! codes are asserted as `CqErr(Cq::X)` (the v2 error space).
//!
//! Most raids are crafted in the Province's caravan slot; the
//! `g13_s1_clash_*` tests raid (and escort) through the program's own
//! clash (stage 1c).

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
        "caravan::g13_s1_raid_take_makes_the_caravan_the_raiders",
        &[CqErr(Cq::RaidState), Lands("settle the taken caravan")],
    ),
];

pub const RAID_CARAVAN: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_raid_take_makes_the_caravan_the_raiders",
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
        "caravan::g13_s1_clash_raids_a_caravan_and_the_raider_takes_it",
        &[Lands("RaidCaravan take after a real clash")],
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

/// S1 1e (decision K4).
pub const RAID_DOMESTIC: &[Cover] = &[
    Cover::Test(
        "caravan::g13_s1_raid_domestic_opens_a_raid_the_raider_settles",
        &[Lands("RaidDomestic"), CqErr(Cq::RaidState)],
    ),
    Cover::Test(
        "caravan::g13_s1_raid_domestic_refusals",
        &[
            CqErr(Cq::RaidWindow),
            CqErr(Cq::RaidState),
            CqErr(Cq::NotOnTile),
            Err(E::BadData),
            Err(E::BadAccount),
        ],
    ),
];
