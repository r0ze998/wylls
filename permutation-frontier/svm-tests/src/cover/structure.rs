//! Coverage of the S1 structure instructions (stages 1d and 1e,
//! `docs/frontier/stage1d/S1-1D-CONTRACT.md` §6,
//! `docs/frontier/stage1e/S1-1E-CONTRACT.md` §2): BuildStructure,
//! SeizeStructure and CloseStructure. S1 codes are asserted as
//! `CqErr(Cq::X)` (the v2 error space). The wear and the stop rule
//! (Reveal, GatherClash, SendCaravan) are tested in the same file
//! (`g13_s1_reveal_and_gather_wear_a_march_in_range`,
//! `g13_s1_a_late_arrival_is_not_worn_while_it_waits`,
//! `g13_s1_a_caravan_is_worn_by_a_tower_on_its_route`,
//! `g13_s1_a_palisade_stops_whom_its_nation_stops`,
//! `g13_s1_a_fort_does_not_stop_a_march`,
//! `g13_s1_a_palisade_stops_a_caravan`).

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const PENDING: &[(&str, &str)] = &[];

pub const BUILD_STRUCTURE: &[Cover] = &[
    Cover::Test(
        "structure::g13_s1_build_tower_lands_pays_and_lists",
        &[Lands("BuildStructure")],
    ),
    Cover::Test(
        "structure::g13_s1_build_tower_refusals",
        &[
            CqErr(Cq::StructureSite),
            CqErr(Cq::StructureLimit),
            CqErr(Cq::StructureFull),
            Err(E::BadData),
            Err(E::Insufficient),
        ],
    ),
    Cover::Test(
        "structure::g13_s1_build_palisades_and_forts",
        &[
            Lands("BuildStructure"),
            CqErr(Cq::StructureLimit),
            CqErr(Cq::StructureFull),
            Err(E::BadData),
        ],
    ),
];

pub const SEIZE_STRUCTURE: &[Cover] = &[
    Cover::Test(
        "structure::g13_s1_seize_tower_by_standing_on_it",
        &[
            Lands("SeizeStructure"),
            CqErr(Cq::NotOnTile),
            CqErr(Cq::StructureLimit),
        ],
    ),
    Cover::Test(
        "structure::g13_s1_seize_a_fort_once_it_has_fallen",
        &[Lands("SeizeStructure"), CqErr(Cq::FortManned)],
    ),
];

pub const CLOSE_STRUCTURE: &[Cover] = &[Cover::Test(
    "structure::g13_s1_close_tower",
    &[
        Lands("CloseStructure"),
        CqErr(Cq::WalletRequired),
        Err(E::NotOwner),
    ],
)];

/// S1 1e (step 5).
pub const FORT_GARRISON: &[Cover] = &[Cover::Test(
    "structure::g13_s1_fort_garrison_and_refusals",
    &[
        Lands("FortGarrison"),
        CqErr(Cq::StructureLimit),
        Err(E::BadData),
        Err(E::Insufficient),
        Err(E::NotOwner),
        Err(E::NotResident),
    ],
)];
