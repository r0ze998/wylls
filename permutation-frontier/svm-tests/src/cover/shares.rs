//! Coverage of the S2 share instructions (stage 2b,
//! `docs/frontier/stage2/S2-2B-CONTRACT.md` §3): OpenShares,
//! WithdrawShares and SettleDeposit.

use super::{Cover, Cq, CqErr, Err, Lands, E};

pub const OPEN_SHARES: &[Cover] = &[
    Cover::Test(
        "shares::g13_s2_open_deposit_and_withdraw_shares",
        &[Lands("OpenShares")],
    ),
    Cover::Test(
        "shares::g13_s2_a_shared_vault_is_the_holders",
        &[CqErr(Cq::VaultShared)],
    ),
    Cover::Test(
        "receipts::g13_s2_receipts_and_shares_exclude",
        &[Lands("OpenShares"), CqErr(Cq::ReceiptState)],
    ),
];

pub const WITHDRAW_SHARES: &[Cover] = &[
    Cover::Test(
        "shares::g13_s2_open_deposit_and_withdraw_shares",
        &[Lands("WithdrawShares")],
    ),
    Cover::Test(
        "shares::g13_s2_a_shared_vault_is_the_holders",
        &[Err(E::BadData), Err(E::NotOwner)],
    ),
    Cover::Test(
        "shares::g13_s2_a_seizure_voids_the_shares",
        &[CqErr(Cq::TicketVoid)],
    ),
];

pub const SETTLE_DEPOSIT: &[Cover] = &[
    Cover::Test(
        "shares::g13_s2_open_deposit_and_withdraw_shares",
        &[Lands("SettleDeposit")],
    ),
    Cover::Test(
        "shares::g13_s2_a_shared_vault_is_the_holders",
        &[Err(E::BadAccount)],
    ),
];
