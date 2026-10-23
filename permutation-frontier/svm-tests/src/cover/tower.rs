//! Coverage of the S1 tower instructions (stage 1d,
//! `docs/frontier/stage1d/S1-1D-CONTRACT.md` §6): BuildTower, SeizeTower and
//! CloseTower. S1 codes are asserted as `CqErr(Cq::X)` (the v2 error
//! space). The wear (Reveal, GatherClash, SendCaravan) is tested in the same
//! file (`g13_s1_reveal_and_gather_wear_a_march_in_range`,
//! `g13_s1_a_late_arrival_is_not_worn_while_it_waits`,
//! `g13_s1_a_caravan_is_worn_by_a_tower_on_its_route`).

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const PENDING: &[(&str, &str)] = &[];

pub const BUILD_TOWER: &[Cover] = &[
    Cover::Test(
        "tower::g13_s1_build_tower_lands_pays_and_lists",
        &[Lands("BuildTower")],
    ),
    Cover::Test(
        "tower::g13_s1_build_tower_refusals",
        &[
            CqErr(Cq::TowerSite),
            CqErr(Cq::TowerLimit),
            CqErr(Cq::TowerFull),
            Err(E::BadData),
            Err(E::Insufficient),
        ],
    ),
];

pub const SEIZE_TOWER: &[Cover] = &[Cover::Test(
    "tower::g13_s1_seize_tower_by_standing_on_it",
    &[
        Lands("SeizeTower"),
        CqErr(Cq::NotOnTile),
        CqErr(Cq::TowerLimit),
    ],
)];

pub const CLOSE_TOWER: &[Cover] = &[Cover::Test(
    "tower::g13_s1_close_tower",
    &[
        Lands("CloseTower"),
        CqErr(Cq::WalletRequired),
        Err(E::NotOwner),
    ],
)];
