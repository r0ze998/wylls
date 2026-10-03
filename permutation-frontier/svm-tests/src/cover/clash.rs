//! Coverage of the clash area (§5.11): GatherClash, ResolveFromInputs,
//! ResolveClash (oracle), SkipQuiet, CloseClashInputs, CloseArrivalDay,
//! CloseArrivalSlot (W4-A). The return settle (SettleDeparture with
//! `transit_slot = 0xFF`, §21) is covered by
//! `clash::clash_dissolve_returns_troops_to_the_reserve` and
//! `clash::clash_return_settle_loses_troops_of_a_refounded_holding`
//! (SettleDeparture's row belongs to `host.rs`, W3-B's file: integrator).
//!
//! **MC (CQ2-B):** the `g13_cq_`, `g11_cq_`, `g01_cq_` and `cq_` rows below
//! cover the v2 path of GatherClash, ResolveFromInputs and SkipQuiet on a
//! Province v2 (conquest contract §5.6, §5.7, §13.1, §13.3).

use super::{Cover, Err, Lands, Loaded, E};

/// Ignored tests of this area waiting for a fix: (test, unit).
pub const PENDING: &[(&str, &str)] = &[];

pub const GATHER_CLASH: &[Cover] = &[
    Cover::Test(
        "clash::clash_gather_refusals",
        &[
            Err(E::NoAnchor),
            Err(E::TooEarly),
            Err(E::LatchClosed),
            Err(E::WrongStatus),
            Err(E::BadData),
            Err(E::TooManyAccounts),
            Err(E::BadAddress),
            Err(E::BadAccount),
            Err(E::DepartureUnsettled),
            Err(E::Auth),
            Lands("w.gather_ix("),
        ],
    ),
    Cover::Test(
        "clash::g06_a_gather_that_omits_a_present_slot_cannot_complete",
        &[Err(E::BadData), Lands("GatherClash")],
    ),
    Cover::Test(
        "clash::g02_prefund_clash_inputs_gather",
        &[Lands("GatherClash")],
    ),
    Cover::Test(
        "clash::g02_recreation_clash_inputs_latch",
        &[Err(E::LatchClosed)],
    ),
    Cover::Test("clash::g03_forgery_clash_accounts", &[Err(E::BadAccount)]),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
    Cover::Test(
        "clash::clash_g13_top_level_ruleset_status_kernel",
        &[
            Err(E::NotTopLevel),
            Err(E::RulesetMismatch),
            Lands("GatherClash"),
        ],
    ),
    Cover::Test(
        "clash::cq_gather_reads_a_captured_holdings_previous_generation",
        &[Lands("GatherClash")],
    ),
    Cover::Test("clash::g13_cq_clash_refusals", &[Err(E::BadAccount)]),
];

pub const RESOLVE_FROM_INPUTS: &[Cover] = &[
    Cover::Test(
        "clash::clash_resolve_refusals",
        &[
            Err(E::NotGathered),
            Err(E::SeedNotReady),
            Err(E::OutOfOrder),
            Err(E::BadAddress),
            Lands("w.resolve_ix("),
        ],
    ),
    Cover::Test(
        "clash::clash_gather_and_resolve_a_fill_as_the_kernel_does",
        &[Lands("w.resolve_ix(")],
    ),
    Cover::Test("clash::g03_forgery_clash_accounts", &[Err(E::BadAccount)]),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
    Cover::Test(
        "clash::clash_g13_top_level_ruleset_status_kernel",
        &[
            Err(E::NotTopLevel),
            Err(E::WrongStatus),
            Err(E::Kernel),
            Lands("ResolveFromInputs"),
        ],
    ),
    Cover::Test(
        "clash::cq_resolve_runs_the_conquest_step_as_the_shared_models",
        &[Lands("w.resolve_ix(")],
    ),
    Cover::Test(
        "clash::g13_cq_clash_refusals",
        &[
            Err(E::Kernel),
            Err(E::BadAccount),
            Lands("ResolveFromInputs"),
        ],
    ),
    Cover::Test("clash::g01_cq_resolve_worst", &[Lands("ResolveFromInputs")]),
    Cover::Test(
        "clash::cq_keep_taken_sends_the_donor_home_through_the_return_settle",
        &[Lands("ResolveFromInputs")],
    ),
];

pub const RESOLVE_CLASH: &[Cover] = &[Cover::Test(
    "clash::g08_gathers_in_any_order_equal_the_oracle_and_the_kernel",
    &[Lands("ResolveClash")],
)];

pub const SKIP_QUIET: &[Cover] = &[
    Cover::Test(
        "clash::clash_skip_refusals",
        &[
            Err(E::NoAnchor),
            Err(E::TooEarly),
            Err(E::OutOfOrder),
            Err(E::BadAddress),
            Err(E::BadData),
            Err(E::NotQuiet),
            Err(E::WrongStatus),
            Lands("w.skip_ix("),
        ],
    ),
    Cover::Test("clash::g01_skip_quiet_budget", &[Lands("SkipQuiet")]),
    Cover::Test(
        "clash::g01_skip_quiet_kernel_quiet_roster_budget",
        &[Lands("SkipQuiet")],
    ),
    Cover::Test(
        "clash::g11_skip_stop_commits_exactly_its_bells",
        &[Lands("SkipQuiet")],
    ),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
    Cover::Test(
        "clash::clash_g13_top_level_ruleset_status_kernel",
        &[Err(E::NotTopLevel), Lands("SkipQuiet")],
    ),
    Cover::Test(
        "clash::g13_cq_clash_refusals",
        &[Err(E::Kernel), Err(E::BadAccount), Lands("SkipQuiet")],
    ),
    Cover::Test("clash::g01_cq_skip_worst", &[Lands("SkipQuiet")]),
    Cover::Test(
        "clash::cq_snapshot_counts_a_provisional_holding_before_its_final_ts",
        &[Lands("SkipQuiet")],
    ),
];

pub const CLOSE_CLASH_INPUTS: &[Cover] = &[
    Cover::Test(
        "clash::clash_close_clash_inputs",
        &[
            Err(E::InputsOpen),
            Err(E::BadAccount),
            Err(E::LatchClosed),
            Lands("cix::close_clash_inputs("),
        ],
    ),
    Cover::Test(
        "clash::clash_close_clash_inputs_needs_only_present_records",
        &[Lands("CloseClashInputs")],
    ),
    Cover::Test(
        "clash::clash_close_no_arrival_inputs_after_a_skip",
        &[Err(E::InputsOpen), Lands("CloseClashInputs")],
    ),
    Cover::Test(
        "clash::clash_closes_after_the_season_end",
        &[Err(E::InputsOpen), Lands("CloseClashInputs after the end")],
    ),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
];

pub const CLOSE_ARRIVAL_DAY: &[Cover] = &[
    Cover::Test(
        "clash::clash_close_arrival_day",
        &[
            Err(E::TooEarly),
            Err(E::BadAccount),
            Lands("cix::close_arrival_day("),
        ],
    ),
    Cover::Test(
        "clash::clash_closes_after_the_season_end",
        &[Err(E::TooEarly), Lands("CloseArrivalDay after the end")],
    ),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
];

pub const CLOSE_ARRIVAL_SLOT: &[Cover] = &[
    Cover::Test(
        "clash::clash_close_arrival_slot",
        &[
            Err(E::TooEarly),
            Err(E::BadAccount),
            Lands("cix::close_arrival_slot("),
        ],
    ),
    Cover::Test("clash::g01_budget_clash_kinds", &[Loaded]),
];
