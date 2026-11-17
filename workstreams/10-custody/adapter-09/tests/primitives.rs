//! ⑩'s use-order primitives on the one lot table, without any bridge:
//! `release_by_order` (a use, once per job and deposit) and
//! `try_return_unused` (unused goods back un-consumed, the sub-unit rest
//! owed in custody). ⑨'s bridge10 drives them in a job's full cycle; those
//! tests are in `../with-bridge10` against ⑨'s own code.

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_capacity::custody::{Custody, CustodyError, Key};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::testkit::{B, SITE_A, X};
use wylls_custody::lot::CustodyError as LotError;
use wylls_custody_adapter_09::{use_place, LotCustody, Note, Refusal, UseLink};

const M: Actor = Actor::test(0x4D);
const ORE: u8 = Resource::Ore as u8;
const PURPOSE: u16 = 0x0901;
const UID: u64 = 7;

fn job() -> JobId {
    JobId {
        grant: GrantId {
            facility: wylls_capacity::model::FacilityId { at: SITE_A, gen: 1 },
            seq: 1,
        },
        seq: 1,
    }
}

/// M's lot (quota 40) holding 40 in V, a use order of 40 for B, and 30 of
/// it released for B's job (waiting in the job's transit place).
fn released() -> (LotCustody, u32) {
    let mut cu = LotCustody::new();
    cu.add_vault(V, SITE_A.p, SITE_A.q, 5, K, u(100));
    cu.open_lot(V, K, M, Resource::Ore, u(40)).unwrap();
    cu.try_import(arrival(1), Place::Vault(V), M, Resource::Ore, u(40))
        .unwrap();
    let o = cu
        .set_use_order(V, M, B, 0, u(40), 1_000, PURPOSE, 0)
        .unwrap();
    let link = UseLink {
        vault: V,
        owner: M,
        grantee: B,
        slot: 0,
        order: o,
        qty: u(30),
        bell: 1,
    };
    assert_eq!(cu.release_by_order(job(), UID, 1, link, PURPOSE), Ok(true));
    cu.check_between().unwrap();
    cu.take_notes();
    (cu, o)
}

fn key(n: u64) -> Key {
    Key {
        scope: UID,
        kind: 210,
        n,
    }
}

#[test]
fn a_use_is_once_per_job_and_deposit() {
    let (mut cu, o) = released();
    assert_eq!(cu.lot(V, M, ORE).unwrap().consumed, u(30));
    assert_eq!(
        Custody::balance(&cu, use_place(UID), Resource::Ore),
        (Some(B), u(30))
    );
    let link = UseLink {
        vault: V,
        owner: M,
        grantee: B,
        slot: 0,
        order: o,
        qty: u(30),
        bell: 1,
    };
    let lots = cu.lots.clone();
    assert_eq!(cu.release_by_order(job(), UID, 1, link, PURPOSE), Ok(false));
    assert_eq!(cu.lots, lots);
    assert_eq!(
        cu.release_by_order(job(), UID, 1, UseLink { qty: u(5), ..link }, PURPOSE),
        Err(Refusal::Nine(CustodyError::KeyReused))
    );
    // Beyond the order, a wrong purpose, a fraction: refused, nothing moves.
    for (n, l, p, want) in [
        (
            2,
            UseLink { qty: u(11), ..link },
            PURPOSE,
            LotError::Insufficient,
        ),
        (3, UseLink { qty: u(1), ..link }, 0x0777, LotError::Order),
        (
            4,
            UseLink { qty: 1_500, ..link },
            PURPOSE,
            LotError::Quantity,
        ),
    ] {
        let before = cu.clone();
        assert_eq!(
            cu.release_by_order(job(), UID, n, l, p),
            Err(Refusal::Lot(want))
        );
        assert_eq!(cu, before);
    }
}

#[test]
fn whole_units_come_back_un_consumed_and_the_rest_is_owed() {
    let (mut cu, _) = released();
    let l0 = cu.lot(V, M, ORE).unwrap();
    let io = (cu.imported, cu.exported);
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, 12_345),
        Ok((u(12), 345))
    );
    let l = cu.lot(V, M, ORE).unwrap();
    assert_eq!(
        (l.held, l.consumed, l.in_total),
        (l0.held + u(12), l0.consumed - u(12), l0.in_total)
    );
    assert_eq!(
        (cu.imported, cu.exported),
        io,
        "no import or export on this path"
    );
    cu.check_between().unwrap();
    // Replayed: nothing; another call under the key: refused.
    let before = cu.clone();
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, 12_345),
        Ok((0, 345))
    );
    assert_eq!(
        (cu.lots.clone(), cu.owed.clone()),
        (before.lots, before.owed)
    );
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, 1),
        Err(Refusal::Nine(CustodyError::KeyReused))
    );
    // The rests add up to a whole unit.
    assert_eq!(
        cu.try_return_unused(key(2), use_place(UID), V, M, 655),
        Ok((u(1), 0))
    );
    assert_eq!(cu.lot(V, M, ORE).unwrap().consumed, l0.consumed - u(13));
    cu.check_between().unwrap();
    assert_eq!(
        cu.take_notes()
            .iter()
            .filter(|n| matches!(n, Note::Unused { .. }))
            .count(),
        2
    );
}

#[test]
fn never_more_back_than_was_taken_and_never_from_a_lot() {
    let (mut cu, _) = released();
    let before = cu.clone();
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, u(30) + 1),
        Err(Refusal::Lot(LotError::Quantity))
    );
    assert_eq!(cu, before);
    assert_eq!(
        cu.try_return_unused(key(2), Place::Vault(V), V, M, u(1)),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    cu.check_between().unwrap();
}

#[test]
fn a_frozen_or_full_lot_keeps_it_owed() {
    let (mut cu, _) = released();
    cu.seize_vault(V, X).unwrap();
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, u(7)),
        Ok((0, u(7)))
    );
    cu.check_between().unwrap();
    let (mut cu, _) = released();
    cu.begin_inbound(V, M, Resource::Ore, (9, 1), u(30))
        .unwrap();
    assert_eq!(
        cu.try_return_unused(key(1), use_place(UID), V, M, u(7)),
        Ok((0, u(7)))
    );
    cu.set_quota(V, K, M, Resource::Ore, u(47)).unwrap();
    assert_eq!(cu.pay_owed(V, M), u(7));
    cu.check_between().unwrap();
}

#[test]
fn a_restart_keeps_uses_returns_and_what_is_owed() {
    use borsh::BorshDeserialize;
    let (mut cu, _) = released();
    cu.try_return_unused(key(1), use_place(UID), V, M, 4_500)
        .unwrap();
    let back = LotCustody::try_from_slice(&borsh::to_vec(&cu).unwrap()).unwrap();
    assert_eq!(back, cu);
    let mut a = cu.clone();
    let mut b = back;
    assert_eq!(
        a.try_return_unused(key(2), use_place(UID), V, M, 500),
        b.try_return_unused(key(2), use_place(UID), V, M, 500)
    );
    assert_eq!(a, b);
    a.check_between().unwrap();
}

/// ⑨'s request T2 (⑨'s kernel from 004836e2 has `Refused`).
#[cfg(feature = "nine-refused")]
#[test]
fn tens_reasons_reach_nine_as_refused_codes() {
    use wylls_custody_adapter_09::{lot_code, to_nine};
    for e in [
        LotError::Capacity,
        LotError::Forfeited,
        LotError::Quantity,
        LotError::Resource,
    ] {
        assert_eq!(to_nine(Refusal::Lot(e)), CustodyError::Refused(lot_code(e)));
    }
    assert_eq!(
        to_nine(Refusal::Lot(LotError::Insufficient)),
        CustodyError::Insufficient
    );
}
