//! Coverage of the S1 nation instructions (stage 1e,
//! `docs/frontier/stage1e/S1-1E-CONTRACT.md` §3): Propose, Vote and
//! SettleProposal. S1 codes are asserted as `CqErr(Cq::X)` (the v2 error
//! space).

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const PENDING: &[(&str, &str)] = &[];

pub const PROPOSE: &[Cover] = &[
    Cover::Test(
        "nation::g13_s1_a_passed_stance_is_written_into_the_season",
        &[Lands("Propose")],
    ),
    Cover::Test(
        "nation::g13_s1_propose_and_vote_refusals",
        &[
            CqErr(Cq::NotVoter),
            CqErr(Cq::ProposalState),
            CqErr(Cq::ProposalsFull),
            Err(E::BadData),
        ],
    ),
];

pub const VOTE: &[Cover] = &[
    Cover::Test(
        "nation::g13_s1_a_passed_stance_is_written_into_the_season",
        &[Lands("Vote"), Err(E::AlreadyDone), CqErr(Cq::ProposalState)],
    ),
    Cover::Test(
        "nation::g13_s1_propose_and_vote_refusals",
        &[CqErr(Cq::NotVoter), CqErr(Cq::ProposalState)],
    ),
];

pub const SETTLE_PROPOSAL: &[Cover] = &[
    Cover::Test(
        "nation::g13_s1_a_passed_stance_is_written_into_the_season",
        &[
            Lands("SettleProposal"),
            CqErr(Cq::ProposalState),
            Err(E::TooManyAccounts),
        ],
    ),
    Cover::Test(
        "nation::g13_s1_expel_and_readmit_a_village",
        &[
            Lands("SettleProposal"),
            Err(E::TooManyAccounts),
            Err(E::BadAccount),
        ],
    ),
    Cover::Test(
        "nation::g13_s1_a_failed_proposal_changes_nothing",
        &[Lands("SettleProposal")],
    ),
    Cover::Test(
        "nation::g13_s1_an_expulsion_that_no_longer_applies_fails",
        &[Lands("SettleProposal")],
    ),
];
