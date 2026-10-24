//! Coverage of the S2 ticket instructions (stage 2a,
//! `docs/frontier/stage2/S2-2A-CONTRACT.md` §3): IssueTickets, GiveLot and
//! CloseLot. S2 codes are asserted as `CqErr(Cq::X)` (the v2 error space).

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const ISSUE_TICKETS: &[Cover] = &[
    Cover::Test(
        "ticket::g13_s2_issue_a_receipt_and_a_use_ticket",
        &[Lands("issue_receipt")],
    ),
    Cover::Test(
        "ticket::g13_s2_issue_refusals",
        &[
            CqErr(Cq::TicketTerms),
            CqErr(Cq::TicketLimit),
            Err(E::NotOwner),
            Err(E::Insufficient),
        ],
    ),
    Cover::Test(
        "shares::g13_s2_a_shared_vault_is_the_holders",
        &[CqErr(Cq::VaultShared)],
    ),
];

pub const GIVE_LOT: &[Cover] = &[
    Cover::Test(
        "ticket::g13_s2_split_give_and_add",
        &[
            Lands("GiveLot"),
            CqErr(Cq::WalletRequired),
            Err(E::BadData),
            Err(E::NotOwner),
        ],
    ),
    Cover::Test(
        "ticket::g13_s2_a_seized_vaults_tickets_are_void_and_close",
        &[CqErr(Cq::TicketVoid)],
    ),
];

pub const CLOSE_LOT: &[Cover] = &[
    Cover::Test(
        "ticket::g13_s2_a_seized_vaults_tickets_are_void_and_close",
        &[Lands("CloseLot"), Err(E::BadData)],
    ),
    Cover::Test(
        "ticket::g13_s2_an_empty_lot_and_its_issue_close",
        &[Lands("CloseLot"), Err(E::BadData), Err(E::NotOwner)],
    ),
    Cover::Test(
        "receipts::g13_s2_orphan_lots_close",
        &[Lands("CloseLot (an orphan lot)")],
    ),
];
