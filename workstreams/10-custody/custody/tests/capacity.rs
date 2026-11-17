//! The destination's room (workstream 10, review item 3). A custody
//! caravan reserves room in its lot when it leaves, and the lot's quota is
//! committed against the vault's `CAP`, so arrival never finds the lot
//! full — **as long as every writer of the vault's general stock keeps
//! `STORES + CUSTODY_QUOTA ≤ CAP`** (`World::check`; in the program, the
//! `vault_stock_writers_are_the_listed_ones` test lists the writers).
//! What the reservation does not promise: delivery. A seizure of the
//! destination, a raid or a burn on the way end it as a recorded loss.
//! Each reservation is released exactly once: by SettleCustody, or by
//! ReconcileLot after a take; never twice, never left behind.

mod common;
use common::*;

use wylls_custody::model::fixture::{units, Cast, ORE};
use wylls_custody::model::{Error, World};
use wylls_custody::*;

fn incoming(c: &Cast, lot: &wylls_custody::model::LotKey) -> i64 {
    c.w.lot(lot).unwrap().incoming() / 1000
}

/// D's own caravans into its vault while A's custody caravan is on its
/// way, in both orders: D's general stock stops at CAP − quota (the rest
/// of D's own cargo is the existing clamp's loss, credited < cargo), A's
/// cargo arrives whole.
#[test]
fn ordinary_deliveries_cannot_take_reserved_room_in_either_order() {
    for custody_first in [true, false] {
        let (mut c, lot) = stocked(500, 300);
        let ld = lot_d(&mut c, 300); // D's vault: CAP 600, quota 300
        let d = w(c.d);
        // D's home gets ore to send.
        let home_d = c.home(&c.d);
        c.w.holdings.get_mut(&home_d).unwrap().stores = ore(1_000);
        let k_custody = carry(&mut c, lot, 300);
        let k_own = c.w.send_caravan(&d, home_d, c.vd, ore(1_000)).unwrap();
        c.w.advance(20);
        if custody_first {
            c.w.settle_custody(k_custody).unwrap();
            c.w.settle_caravan(k_own).unwrap();
        } else {
            c.w.settle_caravan(k_own).unwrap();
            c.w.settle_custody(k_custody).unwrap();
        }
        assert_eq!(held(&c, &ld), 300, "custody first: {custody_first}");
        assert_eq!(general(&c, &c.vd), 300, "CAP 600 − quota 300");
        ok(&c);
    }
}

/// While a caravan is on its way: the destination's keeper can neither
/// close the vault nor the lot, nor shrink the quota below what is coming;
/// it cannot promise the same room to another lot.
#[test]
fn the_destination_cannot_close_shrink_or_relend_reserved_room() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    carry(&mut c, lot, 200);
    let d = w(c.d);
    assert_eq!(c.w.close_vault(&d, c.vd), Err(Error::NotEmpty));
    assert_eq!(
        c.w.close_lot(Some(&d), ld),
        Err(custody(CustodyError::NotEmpty))
    );
    assert_eq!(
        c.w.set_quota(&d, ld, units(199)),
        Err(custody(CustodyError::NotEmpty))
    );
    c.w.set_quota(&d, ld, units(200)).unwrap(); // down to what is coming
    assert_eq!(
        c.w.open_lot(&d, c.vd, c.e, ORE, units(401)),
        Err(custody(CustodyError::Capacity)),
        "CAP 600 − 200 committed"
    );
    ok(&c);
}

/// A resend of a departure reserves nothing more: the refused request
/// leaves the world as it was.
#[test]
fn a_resent_departure_does_not_reserve_twice() {
    let (mut c, lot) = stocked(500, 0);
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    c.w.deposit(&w(c.a), seq, home, lot, units(100), 0).unwrap();
    let before = c.w.clone();
    assert_eq!(
        c.w.deposit(&w(c.a), seq, home, lot, units(100), 0),
        Err(custody(CustodyError::Stale))
    );
    assert_eq!(c.w, before);
    assert_eq!(incoming(&c, &lot), 100);
    ok(&c);
}

/// Each way a reservation can end, and the second attempt to end it.
#[test]
fn every_reservation_ends_exactly_once() {
    // Delivered.
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    c.w.advance(20);
    c.w.settle_custody(k).unwrap();
    assert_eq!(incoming(&c, &ld), 0);
    assert_eq!(c.w.settle_custody(k), Err(Error::NotFound));
    assert_eq!(c.w.reconcile(ld), Err(custody(CustodyError::State)));
    ok(&c);

    // Burned on the way: released at settlement, with the burn logged.
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    c.w.open_raid(k, c.e).unwrap();
    assert_eq!(
        c.w.reconcile(ld),
        Err(custody(CustodyError::State)),
        "still custody"
    );
    c.w.settle_raid(Some(&w(c.e)), k, false).unwrap();
    c.w.advance(20);
    c.w.settle_custody(k).unwrap();
    assert_eq!(incoming(&c, &ld), 0);
    assert_eq!(c.w.settle_custody(k), Err(Error::NotFound));
    ok(&c);

    // Taken on the way: released at reconciliation, once.
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    c.w.open_raid(k, c.e).unwrap();
    c.w.settle_raid(None, k, true).unwrap();
    assert_eq!(incoming(&c, &ld), 100, "pending until reconciled");
    assert_eq!(c.w.settle_custody(k), Err(Error::CustodyCaravan));
    c.w.reconcile(ld).unwrap();
    assert_eq!(incoming(&c, &ld), 0);
    assert_eq!(c.w.reconcile(ld), Err(custody(CustodyError::State)));
    c.w.advance(30);
    c.w.settle_caravan(k).unwrap(); // the raider's, now ordinary
    assert_eq!(c.w.reconcile(ld), Err(custody(CustodyError::State)));
    ok(&c);

    // Destination seized: released at settlement (a DestinationGone loss),
    // the forfeited lot's quota released at reconciliation, once.
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    let vd2 = c.w.seize_vault(&w(c.e), c.vd).unwrap();
    // The captor's own deliveries meanwhile still stop at CAP − quota.
    assert_eq!(c.w.vault(&vd2).unwrap().quota[ORE as usize], units(300));
    c.w.advance(20);
    let st = c.w.settle_custody(k).unwrap();
    assert_eq!(st.dest_gone, units(100));
    assert_eq!(incoming(&c, &ld), 0);
    c.w.reconcile(ld).unwrap();
    assert_eq!(c.w.vault(&vd2).unwrap().quota[ORE as usize], 0);
    assert_eq!(c.w.reconcile(ld), Err(custody(CustodyError::State)));
    ok(&c);
}

/// The keepers' end of everything: after a mix of deliveries, a burn, a
/// take and a seizure, draining leaves no caravan and no reservation, and
/// a restart in the middle changes nothing.
#[test]
fn draining_leaves_no_reservation() {
    let (mut c, lot) = stocked(900, 600);
    let ld = lot_d(&mut c, 600);
    let k1 = carry(&mut c, lot, 100);
    let k2 = carry(&mut c, lot, 100);
    let k3 = carry(&mut c, lot, 100);
    c.w.open_raid(k1, c.e).unwrap();
    c.w.settle_raid(None, k1, false).unwrap();
    c.w.open_raid(k2, c.e).unwrap(); // left open: DefaultRaid in the drain
    c.w = World::restore(&c.w.snapshot());
    let _ = k3;
    c.w.seize_vault(&w(c.e), c.vd).unwrap();
    c.w.drain();
    ok(&c);
    assert!(c.w.caravans.is_empty());
    assert_eq!(incoming(&c, &ld), 0);
    let (dep, acc) = c.w.custody_balance(c.w.tag(&c.a));
    assert_eq!(dep, acc);
}

/// An arrival that cannot happen does not exist in S1: the path is checked
/// at departure and a caravan cannot be recalled or redirected; what ends
/// the trip early is a raid (settled by the raider or DefaultRaid, whose
/// burn is allowed after `RAID_BURN_AFTER_BELLS`), and a destination gone
/// is a loss at settlement. The model's drain stands for those keepers;
/// the program's DefaultRaid guarantees the raid ends.
#[test]
fn an_open_raid_blocks_settlement_until_it_is_settled() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    c.w.open_raid(k, c.e).unwrap();
    c.w.advance(500);
    assert_eq!(c.w.settle_custody(k), Err(Error::RaidState));
    assert_eq!(
        incoming(&c, &ld),
        100,
        "reserved while the outcome is unknown"
    );
    c.w.drain();
    assert_eq!(incoming(&c, &ld), 0);
    ok(&c);
}
