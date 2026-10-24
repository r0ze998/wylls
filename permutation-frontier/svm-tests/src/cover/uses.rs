//! Coverage of the S2 use instruction (stage 2d,
//! `docs/frontier/stage2/S2-2D-CONTRACT.md` §3): UseRun.

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const USE_RUN: &[Cover] = &[
    Cover::Test(
        "uses::g13_s2_use_runs_convert_in_the_holders_vault",
        &[Lands("UseRun"), CqErr(Cq::UseLimit)],
    ),
    Cover::Test(
        "uses::g13_s2_use_run_refusals",
        &[
            Lands("UseRun (the 24th)"),
            CqErr(Cq::UseLimit),
            Err(E::BadData),
            Err(E::Insufficient),
            Err(E::NotOwner),
        ],
    ),
];
