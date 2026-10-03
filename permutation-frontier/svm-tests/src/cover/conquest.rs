//! Coverage of the MC conquest instructions (conquest contract §5.5, §13.3):
//! DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost and
//! CloseMarch. Added by CQ2-A's first commit as `Pending`; owned by CQ2-C
//! from then on (§11 Wave 2). MC codes are asserted as `CqErr(Cq::X)`.
//!
//! The `Loaded` outcome (`g01_loaded_limit_*` at `L(kind)`) is a Gate CQ4
//! item (CQ4-A, `RELEASE_CHECK=1`); the G1 CU rows are `g01_cq_*` in
//! `tests/conquest.rs`. `Refused` rows are not used: every refusal here has
//! a code.

use super::{Cover, Cq, CqErr, Err, Lands, E};

/// Ignored tests of this area waiting for a fix: (test, unit). Each is a
/// documented gap with the amendment or dependency request that closes it
/// (`CQ2-C-NOTES.md`): they run with `--include-ignored` and fail today.
pub const PENDING: &[(&str, &str)] = &[
    // D-1: the capture lock cannot see a Holding's own Province when the
    // named Province is another: needs the Province as an account
    // (dependency request R-C1, CQ2-C-NOTES §5).
    (
        "host::p_cq_p3_foreign_province_gap",
        "integrator: R-C1 own-Province account",
    ),
];

pub const DECLARE_SIEGE: &[Cover] = &[
    Cover::Test(
        "conquest::g13_cq_declare_siege_on_an_outpost_reserves_a_slot",
        &[Lands("declare_on("), CqErr(Cq::SiegeBusy)],
    ),
    Cover::Test(
        "conquest::g13_cq_declare_siege_on_a_first_holding_reserves_nothing",
        &[Lands("declare_on(")],
    ),
    Cover::Test(
        "conquest::g13_cq_declare_siege_on_a_free_city",
        &[Lands("declare_free_city(")],
    ),
    Cover::Test(
        "conquest::g13_cq_declare_siege_refusals_steps_2_to_7",
        &[
            Err(E::NotFinal),
            Err(E::NotResident),
            CqErr(Cq::CapturePending),
            CqErr(Cq::NotBesiegeable),
            CqErr(Cq::NotOnHex),
            CqErr(Cq::NotLead),
            CqErr(Cq::StakeUnsettled),
            CqErr(Cq::Immune),
            CqErr(Cq::SiegeCap),
            CqErr(Cq::HoldingsFull),
        ],
    ),
    Cover::Test(
        "conquest::g13_cq_declare_siege_refusals_steps_8_to_10",
        &[
            Err(E::ReservedSite),
            Err(E::Shielded),
            Err(E::Insufficient),
            Err(E::RulesetMismatch),
            Err(E::TooManyAccounts),
            CqErr(Cq::Friendly),
            CqErr(Cq::FrontierProtected),
            CqErr(Cq::Heartland),
            CqErr(Cq::TooLate),
        ],
    ),
    Cover::Test(
        "conquest::g03_cq_declare_siege_forgeries",
        &[Err(E::BadAddress), Err(E::BadAccount), Err(E::NotOwner)],
    ),
    Cover::Test(
        "conquest::p_cq_p2a_the_horn_does_not_depend_on_the_order_of_declarations",
        &[CqErr(Cq::NotLead)],
    ),
    Cover::Test(
        "conquest::p_cq_p10_respite_bars_only_the_occupier_and_only_when_earned",
        &[CqErr(Cq::Immune)],
    ),
];

pub const SETTLE_SIEGE: &[Cover] = &[
    Cover::Test(
        "conquest::g13_cq_settle_siege_pays_the_defender_and_frees_the_slot",
        &[Lands("settle_siege_ix("), Err(E::AlreadyDone)],
    ),
    Cover::Test(
        "conquest::g13_cq_settle_siege_lapses_a_siege_at_season_end",
        &[Lands("settle_siege_ix("), Err(E::TooEarly)],
    ),
    Cover::Test(
        "conquest::g13_cq_settle_siege_refusals",
        &[
            Err(E::AlreadyDone),
            Err(E::BadAccount),
            Err(E::BadAddress),
            Err(E::TooManyAccounts),
        ],
    ),
    Cover::Test(
        "conquest::p_cq_p4_a_lagging_province_cannot_be_lapsed_before_its_last_bell",
        &[Err(E::TooEarly), Err(E::AlreadyDone)],
    ),
    Cover::Test(
        "conquest::g03_cq_settle_and_retire_forgeries",
        &[Err(E::BadAddress)],
    ),
];

pub const SETTLE_CAPTURE: &[Cover] = &[
    Cover::Test(
        "conquest::g13_cq_settle_capture_takes_the_outpost",
        &[Lands("capture_ix("), Err(E::AlreadyDone)],
    ),
    Cover::Test(
        "conquest::g13_cq_settle_capture_of_a_free_city_creates_the_holding",
        &[Lands("qix::settle_capture(")],
    ),
    Cover::Test(
        "conquest::g13_cq_settle_capture_refusals",
        &[
            Err(E::AlreadyDone),
            Err(E::BadAddress),
            Err(E::Kernel),
            Err(E::BadAccount),
            Err(E::Insufficient),
            Err(E::TooManyAccounts),
            CqErr(Cq::NotDue),
        ],
    ),
];

pub const FOLD_MARCH: &[Cover] = &[
    Cover::Test(
        "conquest::g13_cq_fold_march_folds_hours_in_order",
        &[
            Lands("fold_ix("),
            Err(E::BadData),
            CqErr(Cq::FoldOutOfOrder),
            CqErr(Cq::FoldTooEarly),
        ],
    ),
    // v1.5 (A-49): an Ended season refuses an hour at or after `end_bell`,
    // and any fold from `end + 72 h` (a closed March is never re-created).
    Cover::Test(
        "conquest::g13_cq_fold_march_in_the_grace_but_not_after_it",
        &[Lands("fold in the grace"), Err(E::WrongStatus)],
    ),
    Cover::Test(
        "conquest::g03_cq_fold_march_forged_members_and_march",
        &[Err(E::BadAddress)],
    ),
];

pub const RETIRE_HOST: &[Cover] = &[
    Cover::Test(
        "conquest::p_cq_p7_p11_retire_host_by_the_victim_returns_to_prev_home",
        &[
            Lands("retire_ix("),
            Err(E::Auth),
            Err(E::HostBusy),
            CqErr(Cq::NotLead),
        ],
    ),
    Cover::Test(
        "conquest::g13_cq_retire_host_refusals",
        &[
            Err(E::WrongStatus),
            Err(E::NotOwner),
            Err(E::BadAddress),
            Err(E::NotResident),
            Err(E::BadData),
            CqErr(Cq::NotLead),
        ],
    ),
    Cover::Test(
        "conquest::g13_cq_retire_host_after_the_end_by_anyone",
        &[Err(E::TooEarly)],
    ),
    Cover::Test(
        "conquest::g13_cq_retire_host_binds_a_departed_leave",
        &[Err(E::AlreadyDone)],
    ),
];

pub const CLOSE_MARCH: &[Cover] = &[Cover::Test(
    "conquest::g13_cq_close_march_after_the_grace",
    &[
        Lands("close("),
        Err(E::WrongStatus),
        Err(E::TooEarly),
        Err(E::BadAccount),
    ],
)];
