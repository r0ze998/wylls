//! Unused ore from another owner's lot back to that lot, on the one lot
//! store (⑨'s request T3/T4): whole units un-consumed, the sub-unit rest
//! owed in custody until it makes whole units, nothing counted twice.

mod common;

use common::*;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{CustodyError, Key};
use wylls_capacity::ledger::Op;
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::{B, T0, X};
use wylls_custody::lot::CustodyError as LotError;
use wylls_custody_adapter_09::connect::*;
use wylls_custody_adapter_09::{Note, Refusal};

const M: Actor = Actor::test(0x4D);
const ORE: u8 = Resource::Ore as u8;

/// M's lot (quota 40, holding 40) with a use order of 40 for B; B's job
/// took 30 of it into its hopper.
fn fed() -> (Connected, JobId) {
    let (mut w, f) = world(Policies::PROVISIONAL);
    w.custody.open_lot(V, K, M, Resource::Ore, u(40)).unwrap();
    w.custody
        .try_import(arrival(10), Place::Vault(V), M, Resource::Ore, u(40))
        .unwrap();
    let o = w
        .custody
        .set_use_order(V, M, B, 0, u(40), 1_000, PURPOSE_WORKSHOP_ARMS, 0)
        .unwrap();
    let mut c = Connected::new(w, T0);
    let j = job(f, 1, 1);
    c.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: u(20),
        },
    )
    .unwrap();
    c.deposit_from_lot(T0 + 20, B, j, 1, V, M, 0, o, 30)
        .unwrap();
    c.w.custody.take_notes();
    (c, j)
}

fn key(n: u64) -> Key {
    Key {
        scope: 1,
        kind: 210,
        n,
    }
}

fn totals(c: &Connected) -> ([i64; 8], [i64; 8]) {
    (c.w.custody.imported, c.w.custody.exported)
}

#[test]
fn whole_units_come_back_un_consumed_and_the_rest_is_owed() {
    let (mut c, j) = fed();
    let lot0 = c.w.custody.lot(V, M, ORE).unwrap();
    let io = totals(&c);
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, 12_345),
        Ok((u(12), 345))
    );
    let l = c.w.custody.lot(V, M, ORE).unwrap();
    assert_eq!(l.held, lot0.held + u(12));
    assert_eq!(l.consumed, lot0.consumed - u(12));
    assert_eq!(l.in_total, lot0.in_total, "not counted in again");
    assert_eq!(totals(&c), io, "no import or export on this path");
    c.w.custody.check().unwrap();
    // The same call again changes nothing; another under the key is refused.
    let before = c.w.custody.clone();
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, 12_345),
        Ok((0, 345))
    );
    assert_eq!(c.w.custody.lots, before.lots);
    assert_eq!(c.w.custody.owed, before.owed);
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, 1),
        Err(Refusal::Nine(CustodyError::KeyReused))
    );
    // Rests add up: 0.345 + 0.655 = 1 whole unit, paid.
    assert_eq!(
        c.w.custody
            .try_return_unused(key(2), Place::Hopper(j), V, M, 655),
        Ok((u(1), 0))
    );
    assert_eq!(
        c.w.custody.lot(V, M, ORE).unwrap().consumed,
        lot0.consumed - u(13)
    );
    c.w.custody.check().unwrap();
    let notes = c.w.custody.take_notes();
    assert_eq!(
        notes
            .iter()
            .filter(|n| matches!(n, Note::Unused { .. }))
            .count(),
        2
    );
}

#[test]
fn never_more_back_than_was_taken() {
    let (mut c, j) = fed();
    let before = c.w.custody.clone();
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, u(30) + 1),
        Err(Refusal::Lot(LotError::Quantity))
    );
    assert_eq!(c.w.custody, before);
    c.w.custody
        .try_return_unused(key(2), Place::Hopper(j), V, M, u(20))
        .unwrap();
    assert_eq!(
        c.w.custody
            .try_return_unused(key(3), Place::Hopper(j), V, M, u(10) + 1),
        Err(Refusal::Lot(LotError::Quantity))
    );
    // Not into another lot's account, nor from a lot.
    assert_eq!(
        c.w.custody
            .try_return_unused(key(4), Place::Vault(V), V, M, u(1)),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    c.w.custody.check().unwrap();
}

#[test]
fn a_frozen_or_full_lot_keeps_it_owed_and_takes_it_when_it_can() {
    // Frozen: everything stays owed, nothing lost, nothing paid later
    // (what a seizure does to the lot is not decided).
    let (mut c, j) = fed();
    c.w.custody.seize_vault(V, X).unwrap();
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, u(7)),
        Ok((0, u(7)))
    );
    c.w.custody.check().unwrap();
    // Full: an arrival fills the room; the return waits, then the keeper
    // raises the quota and the owed units are paid.
    let (mut c, j) = fed();
    c.w.custody
        .begin_inbound(V, M, Resource::Ore, (9, 1), u(30))
        .unwrap();
    assert_eq!(
        c.w.custody
            .try_return_unused(key(1), Place::Hopper(j), V, M, u(7)),
        Ok((0, u(7)))
    );
    c.w.custody.check().unwrap();
    // The vault's CAP is fully committed (B 30, C 30, M 40): free C's lot
    // room first by cutting its quota, then raise M's.
    c.w.custody
        .set_quota(V, K, C_, Resource::Ore, u(10))
        .unwrap();
    c.w.custody
        .set_quota(V, K, M, Resource::Ore, u(47))
        .unwrap();
    assert_eq!(c.w.custody.pay_owed(V, M), u(7));
    assert_eq!(c.w.custody.owed.get(&(V, M)).copied(), Some(0));
    c.w.custody.check().unwrap();
}

const C_: Actor = wylls_capacity::testkit::C;

/// ⑨'s request T2: ⑩'s reason reaches ⑨ (`Refused(code)`, ⑨'s kernel from
/// 004836e2; this branch's copy of ⑨'s kernel predates it).
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
    // Through the trait: a fractional refund into a lot says why.
    let (mut c, j) = fed();
    use wylls_capacity::custody::{By, Custody};
    let _ = &mut c;
    let mut cu = c.w.custody.clone();
    assert_eq!(
        cu.transfer(
            key(9),
            By::Kernel,
            Place::Hopper(j),
            Place::Vault(V),
            Resource::Ore,
            1_500,
            M
        ),
        Err(CustodyError::Refused(lot_code(LotError::Quantity)))
    );
}
