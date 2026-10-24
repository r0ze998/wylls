//! Coverage of the S2 escrow instructions (stage 2e,
//! `docs/frontier/stage2/S2-2E-CONTRACT.md` §3): OpenEscrow, AcceptEscrow,
//! CancelEscrow and WithdrawEscrow.

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const OPEN_ESCROW: &[Cover] = &[
    Cover::Test(
        "escrow::g13_s2_escrow_goods_for_a_lot",
        &[Lands("OpenEscrow")],
    ),
    Cover::Test(
        "escrow::g13_s2_escrow_cancels_and_refusals",
        &[Err(E::BadData), CqErr(Cq::TicketTerms)],
    ),
];

pub const ACCEPT_ESCROW: &[Cover] = &[
    Cover::Test(
        "escrow::g13_s2_escrow_goods_for_a_lot",
        &[Lands("AcceptEscrow"), CqErr(Cq::EscrowState)],
    ),
    Cover::Test(
        "escrow::g13_s2_escrow_owed_goods_die_with_their_vault",
        &[Lands("AcceptEscrow")],
    ),
    Cover::Test(
        "escrow::g13_s2_escrow_refuses_huge_short_or_void_items",
        &[CqErr(Cq::EscrowState), CqErr(Cq::TicketVoid)],
    ),
];

pub const CANCEL_ESCROW: &[Cover] = &[
    Cover::Test(
        "escrow::g13_s2_escrow_cancels_and_refusals",
        &[Lands("CancelEscrow"), CqErr(Cq::EscrowState)],
    ),
    Cover::Test(
        "escrow::g13_s2_escrow_owed_goods_die_with_their_vault",
        &[Lands("CancelEscrow (void goods)"), CqErr(Cq::EscrowState)],
    ),
];

pub const WITHDRAW_ESCROW: &[Cover] = &[Cover::Test(
    "escrow::g13_s2_escrow_goods_for_a_lot",
    &[Lands("WithdrawEscrow"), CqErr(Cq::EscrowState)],
)];
