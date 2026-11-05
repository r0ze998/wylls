//! The world does not end (2026-10-31 direction). A period boundary — a war
//! period closing, a scoring window turning, whatever workstreams 4 and 8
//! define — is not a reason for custody to freeze, forfeit or release
//! anything. Here a boundary is [`World::boundary`], an event nothing in
//! custody reads, crossed in the middle of caravans, reservations,
//! consumption, raids and seizures, with and without a restart; the end
//! state must be the one without the boundary. A long run checks that the
//! state custody keeps does not grow with time, and that running totals
//! refuse rather than wrap.

mod common;
use common::*;

use wylls_custody::model::fixture::units;
use wylls_custody::model::{CaravanKey, Error, Event, Whereabouts, World};
use wylls_custody::*;

/// The world without its boundaries (what a run without them leaves).
fn without_boundaries(w: &World) -> World {
    let mut w = w.clone();
    w.boundaries = 0;
    w.log.retain(|e| !matches!(e, Event::Boundary { .. }));
    w
}

/// Every settlement of a caravan, by caravan (custody and ordinary).
fn settlements(w: &World) -> std::collections::BTreeMap<CaravanKey, u32> {
    let mut m = std::collections::BTreeMap::new();
    for e in &w.log {
        let k = match e {
            Event::Settled { caravan, .. } | Event::CaravanSettled { caravan, .. } => caravan,
            _ => continue,
        };
        *m.entry(*k).or_insert(0) += 1;
    }
    m
}

/// A fixed history with every kind of open business, and a hook called
/// between its steps (`at(step, world)`): a deposit, a carrier's
/// shipment, a raid left open, a partial use, an open ship order, then
/// their completion. Returns the final world.
fn history(mut at: impl FnMut(usize, &mut World)) -> World {
    let (mut c, lot) = stocked(600, 300);
    let ld = lot_d(&mut c, 400);
    let mut step = 0;
    let mut hook = |w: &mut World| {
        at(step, w);
        step += 1;
    };
    hook(&mut c.w); // 0
                    // A deposit on its way.
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let kd = c.w.deposit(&w(c.a), seq, home, lot, units(50), 0).unwrap();
    hook(&mut c.w); // 1
                    // A ship order, half used: one caravan on its way.
    let nonce = c.w.lot(&lot).unwrap().nonce;
    let spec = ship_order(&c, c.c, 200, c.vd);
    let sid = c.w.set_order(&w(c.a), lot, 0, nonce, spec).unwrap();
    let seq = c.w.next_seq(&c.c);
    let k1 =
        c.w.ship(
            &w(c.c),
            seq,
            lot,
            By::Order { slot: 0, id: sid },
            units(100),
            ShipTo::Lot(c.vd),
            0,
        )
        .unwrap();
    hook(&mut c.w); // 2
                    // A second caravan, raided on the way, the raid left open.
    let k2 = carry(&mut c, lot, 50);
    c.w.open_raid(k2, c.e).unwrap();
    hook(&mut c.w); // 3
                    // A use order, partly consumed.
    let nonce = c.w.lot(&lot).unwrap().nonce;
    let spec = use_order(&c, c.b, 40, 7);
    let uid = c.w.set_order(&w(c.a), lot, 2, nonce, spec).unwrap();
    c.w.consume(&w(c.b), lot, 2, uid, units(20), 7).unwrap();
    hook(&mut c.w); // 4
    c.w.advance(30);
    hook(&mut c.w); // 5: everything has arrived, nothing settled
    c.w.settle_custody(kd).unwrap();
    c.w.settle_custody(k1).unwrap();
    c.w.settle_raid(Some(&w(c.e)), k2, true).unwrap();
    hook(&mut c.w); // 6
    c.w.reconcile(ld).unwrap();
    c.w.consume(&w(c.b), lot, 2, uid, units(20), 7).unwrap();
    let seq = c.w.next_seq(&c.c);
    c.w.ship(
        &w(c.c),
        seq,
        lot,
        By::Order { slot: 0, id: sid },
        units(100),
        ShipTo::Lot(c.vd),
        0,
    )
    .unwrap();
    hook(&mut c.w); // 7
    let seq = c.w.next_seq(&c.a);
    c.w.advance(30);
    c.w.ship(
        &w(c.a),
        seq,
        ld,
        By::Owner,
        units(50),
        ShipTo::OwnPlace(home),
        0,
    )
    .unwrap();
    hook(&mut c.w); // 8
    c.w.drain();
    hook(&mut c.w); // 9
    c.w.check().unwrap();
    c.w
}

#[test]
fn a_boundary_anywhere_changes_nothing() {
    let plain = history(|_, _| {});
    // The plain history did everything once.
    assert!(settlements(&plain).values().all(|&n| n == 1));
    let a = plain.tag(&[b'A'; 32]);
    let consumed: i64 = plain
        .log
        .iter()
        .filter_map(|e| match e {
            Event::Consumed { qty, .. } => Some(*qty),
            _ => None,
        })
        .sum();
    assert_eq!(consumed, units(40));
    for at in 0..10 {
        // One boundary.
        let w1 = history(|s, w| {
            if s == at {
                w.boundary();
            }
        });
        assert_eq!(without_boundaries(&w1), plain, "boundary at step {at}");
        // A boundary and a restart there (keepers and heralds read the
        // accounts again).
        let w2 = history(|s, w| {
            if s == at {
                w.boundary();
                *w = World::restore(&w.snapshot());
            }
        });
        assert_eq!(
            without_boundaries(&w2),
            plain,
            "boundary + restart at step {at}"
        );
    }
    // A boundary at every step.
    let w3 = history(|_, w| w.boundary());
    assert_eq!(w3.boundaries, 10);
    assert_eq!(without_boundaries(&w3), plain);
    // Same owner, same quantities, same processing counts, same losses.
    assert_eq!(settlements(&w3), settlements(&plain));
    assert_eq!(w3.custody_balance(a), plain.custody_balance(a));
    assert_eq!(w3.losses(a), plain.losses(a));
}

#[test]
fn a_boundary_does_not_settle_a_pending_forfeiture() {
    // A seizure is a game event; the boundary after it neither completes
    // nor undoes it, and the owner cannot use it to take the goods out.
    let (mut c, lot) = stocked(500, 300);
    c.w.seize_vault(&w(c.e), c.vb).unwrap();
    c.w.boundary();
    let frozen =
        c.w.whereabouts(c.w.tag(&c.a))
            .into_iter()
            .filter(|x| matches!(x, Whereabouts::Frozen { .. }))
            .count();
    assert_eq!(frozen, 1);
    let seq = c.w.next_seq(&c.a);
    let home = c.home(&c.a);
    assert_eq!(
        c.w.ship(
            &w(c.a),
            seq,
            lot,
            By::Owner,
            units(1),
            ShipTo::OwnPlace(home),
            0
        ),
        Err(Error::Custody(CustodyError::Forfeited))
    );
    c.w.reconcile(lot).unwrap();
    ok(&c);
}

#[test]
fn orders_expire_on_their_own_bells_not_at_boundaries() {
    let (mut c, lot) = stocked(500, 300);
    lot_d(&mut c, 300);
    let mut s = ship_order(&c, c.c, 100, c.vd);
    s.expires_bell = c.w.bell + 50;
    let id = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
    // Boundaries before the expiry change nothing: the carrier can still
    // ship, the reservation still holds.
    for _ in 0..3 {
        c.w.boundary();
    }
    c.w.advance(10);
    assert_eq!(c.w.lot(&lot).unwrap().reserved(c.w.bell), units(100));
    let seq = c.w.next_seq(&c.c);
    c.w.ship(
        &w(c.c),
        seq,
        lot,
        By::Order { slot: 0, id },
        units(40),
        ShipTo::Lot(c.vd),
        0,
    )
    .unwrap();
    // The order's own expiry ends it, with no boundary.
    c.w.advance(40);
    let seq = c.w.next_seq(&c.c);
    assert_eq!(
        c.w.ship(
            &w(c.c),
            seq,
            lot,
            By::Order { slot: 0, id },
            units(1),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(Error::Custody(CustodyError::Expired))
    );
    assert_eq!(c.w.lot(&lot).unwrap().reserved(c.w.bell), 0);
    ok(&c);
}

/// Many cycles of deposit → carrier → withdrawal from the destination →
/// use, a boundary every
/// 50 cycles: what custody keeps does not grow (two lots, at most four
/// orders and four reservations each, no caravan left between cycles);
/// only the counters grow, by one a cycle, far from their limits; the
/// books balance throughout.
#[test]
fn a_long_run_keeps_custody_state_bounded() {
    let (mut c, lot) = stocked(900, 0);
    let ld = lot_d(&mut c, 300);
    let home = c.home(&c.a);
    c.w.holdings.get_mut(&home).unwrap().stores = ore(1_000_000);
    let a = c.w.tag(&c.a);
    let cycles = 2_000;
    for n in 0..cycles {
        let seq = c.w.next_seq(&c.a);
        let k = c.w.deposit(&w(c.a), seq, home, lot, units(5), 0).unwrap();
        c.w.advance(10);
        c.w.settle_custody(k).unwrap();
        let k = carry(&mut c, lot, 3);
        c.w.advance(10);
        c.w.settle_custody(k).unwrap();
        let seq = c.w.next_seq(&c.a);
        let k =
            c.w.ship(
                &w(c.a),
                seq,
                ld,
                By::Owner,
                units(3),
                ShipTo::OwnPlace(home),
                0,
            )
            .unwrap();
        c.w.advance(10);
        c.w.settle_caravan(k).unwrap();
        let nonce = c.w.lot(&lot).unwrap().nonce;
        let slot =
            c.w.lot(&lot)
                .unwrap()
                .orders
                .iter()
                .position(|o| !o.live(c.w.bell))
                .unwrap() as u8;
        let spec = use_order(&c, c.b, 2, 0);
        let id = c.w.set_order(&w(c.a), lot, slot, nonce, spec).unwrap();
        c.w.consume(&w(c.b), lot, slot, id, units(2), 0).unwrap();
        if n % 50 == 0 {
            c.w.boundary();
        }
        if n % 250 == 0 {
            c.w.check().unwrap();
            assert!(c.w.caravans.is_empty());
            assert_eq!(c.w.lots.len(), 2);
        }
    }
    c.w.check().unwrap();
    let l = c.w.lot(&lot).unwrap();
    assert_eq!(l.held, 0); // 5 in, 3 carried, 2 used: nothing left a cycle
    assert_eq!(l.in_total, units(5 * cycles as i64));
    assert_eq!(l.nonce as usize, 2 * cycles); // a ship and a use order a cycle
    assert!(l.inbound.iter().all(|i| !i.live));
    assert!(c.w.caravans.is_empty());
    assert_eq!(c.w.lots.len(), 2);
    let (dep, acc) = c.w.custody_balance(a);
    assert_eq!(dep, acc);
    // The counters' headroom: u32 sequences and nonces, i64 totals.
    assert!(c.w.next_seq(&c.a) < u32::MAX / 1_000);
    assert!(l.in_total < i64::MAX / 1_000_000);
    assert!(c.w.bell < u32::MAX / 10_000);
}

/// A running total at its limit refuses the move and changes nothing; it
/// never wraps (the rules crate is built without overflow checks). Only
/// `IN_TOTAL` can reach the limit in practice (it only grows); `OUT_TOTAL`,
/// `CONSUMED` and `FORFEITED` are bounded by it through the lot's law
/// (`IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED`), and their checks
/// are defensive.
#[test]
fn running_totals_refuse_rather_than_wrap() {
    let (mut c, lot) = stocked(500, 300);
    {
        let mut l = c.w.lot(&lot).unwrap();
        l.in_total = i64::MAX - 1;
        l.out_total = l.in_total - l.held; // keep the law
        let mut d = c.w.lots[&lot].clone();
        l.encode(&mut d).unwrap();
        c.w.lots.insert(lot, d);
    }
    c.w.check().unwrap();
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let k = c.w.deposit(&w(c.a), seq, home, lot, units(1), 0).unwrap();
    c.w.advance(20);
    let before = c.w.clone();
    assert_eq!(
        c.w.settle_custody(k),
        Err(Error::Custody(CustodyError::Overflow))
    );
    assert_eq!(c.w, before, "a refusal changes nothing");
    // The goods are not lost: the owner still has them in the lot and the
    // reservation is still there; withdrawing works.
    let seq = c.w.next_seq(&c.a);
    c.w.ship(
        &w(c.a),
        seq,
        lot,
        By::Owner,
        units(300),
        ShipTo::OwnPlace(home),
        0,
    )
    .unwrap();
    c.w.check().unwrap();
}

/// A core limit for workstream 4 (not custody's to fix): a caravan's slot
/// id keeps the low 16 bits of its sender's sequence
/// (`permutation_rules::frontier::caravan::caravan_id`), and a settled
/// caravan's Province slot is not cleared until another caravan reuses it.
/// In a world that never resets, a citizen's 65,537th caravan has the id of
/// its 1st, so a stale slot can answer for it where SettleCaravan and
/// SettleCustody look slots up by id (the raid-open check included).
#[test]
fn caravan_slot_ids_repeat_after_65536_sends() {
    use permutation_rules::frontier::caravan::caravan_id;
    let tag = 0x1041;
    assert_eq!(caravan_id(tag, 1), caravan_id(tag, 1 + 65_536));
    assert_ne!(caravan_id(tag, 1), caravan_id(tag, 2));
    // The custody records themselves key caravans by the full (tag, seq).
    assert_ne!((tag, 1u32), (tag, 1 + 65_536u32));
}
