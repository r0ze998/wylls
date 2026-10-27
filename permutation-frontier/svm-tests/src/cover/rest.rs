//! Coverage of FastForward (S1 map growth,
//! `docs/frontier/map-growth/keeper-load-rules.ja.md` §2.4): a resting
//! Province advanced in closed form on the chain's evidence.

use super::{Cover, Err, Lands, E};

pub const PENDING: &[(&str, &str)] = &[];

pub const FAST_FORWARD: &[Cover] = &[
    Cover::Test(
        "rest::g11_fast_forward_equals_skipping_every_bell",
        &[Lands("FastForward")],
    ),
    Cover::Test(
        "rest::fast_forward_proves_with_archives_and_anchors",
        &[Lands("FastForward")],
    ),
    Cover::Test(
        "rest::fast_forward_stops_at_the_evidence_and_refuses",
        &[
            Lands("FastForward"),
            Err(E::NotQuiet),
            Err(E::BadData),
            Err(E::BadAccount),
            Err(E::BadAddress),
        ],
    ),
    Cover::Test("rest::g01_fast_forward_budget", &[Lands("FastForward")]),
];
