//! Coverage of the S2 receipt instructions (stage 2c,
//! `docs/frontier/stage2/S2-2C-CONTRACT.md` §4): ClaimReceipt and
//! WithdrawReceipt.

use super::{Cover, Cq, CqErr, Lands};

pub const CLAIM_RECEIPT: &[Cover] = &[
    Cover::Test(
        "receipts::g13_s2_receipts_claim_prorate_and_withdraw",
        &[Lands("ClaimReceipt"), CqErr(Cq::ReceiptState)],
    ),
    Cover::Test(
        "receipts::g13_s2_receipts_gifts_and_seizure",
        &[CqErr(Cq::TicketVoid)],
    ),
];

pub const WITHDRAW_RECEIPT: &[Cover] = &[
    Cover::Test(
        "receipts::g13_s2_receipts_claim_prorate_and_withdraw",
        &[Lands("WithdrawReceipt"), CqErr(Cq::ReceiptState)],
    ),
    Cover::Test(
        "receipts::g13_s2_receipts_gifts_and_seizure",
        &[CqErr(Cq::TicketVoid)],
    ),
];
