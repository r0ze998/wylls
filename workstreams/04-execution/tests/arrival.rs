//! How much arrived (MOCK world). Only the settle record and the rules
//! decide; the destination's balance never does.

mod common;

use common::*;
use runexec::model::*;

/// A vault, a settle record without `credited` (today's chain), no
/// clipping, and the vault's balance shows exactly the cargo. Still not
/// "fulfilled": the balance is not evidence for this caravan.
#[test]
fn vault_record_without_credit_is_unverified_even_if_balance_matches() {
    let mut h = H::new("arrival-unverified");
    h.sim.with(|w| w.faults.settle_without_credit = true);
    h.accept(&spec("r1", &h.scene));
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::DeliveredUnverified);
    let o = row.detail.outcome.unwrap();
    assert_eq!(o.delivered, None);
    assert_eq!(o.cargo_logged, Some(r(6, 3)));
    h.sim.with(|w| assert_eq!(w.stores(&h.scene.dst), r(6, 3)));
}

/// Other deposits and withdrawals at the destination while the caravan
/// settles do not change the verdict either way.
#[test]
fn concurrent_movements_at_the_destination_do_not_change_the_verdict() {
    for with_credit in [true, false] {
        let mut h = H::new("arrival-concurrent");
        h.sim
            .with(|w| w.faults.settle_without_credit = !with_credit);
        h.accept(&spec("r1", &h.scene));
        let dst = h.scene.dst;
        for i in 0..80 {
            if h.run("r1").state.terminal() {
                break;
            }
            h.ex.tick().unwrap();
            h.sim.with(|w| {
                // Someone keeps moving weapons in and out of the vault.
                if i % 2 == 0 {
                    w.deposit(&dst, &r(6, 2));
                } else {
                    w.spend(&dst, &r(6, 2));
                }
                w.advance(1);
            });
        }
        let row = h.run("r1");
        if with_credit {
            assert_eq!(row.state, RunState::Fulfilled);
            assert_eq!(
                row.detail.outcome.unwrap().verification,
                Verification::Recorded
            );
        } else {
            assert_eq!(row.state, RunState::DeliveredUnverified);
        }
        h.audit();
    }
}

/// A holding destination credits the whole cargo by rule (no cap on a
/// credit, holding.rs `Accrual::add`): verified without the record field.
#[test]
fn holding_destination_is_rule_derived() {
    let mut h = H::new("arrival-holding");
    let home2 = holding(1, 1, 3);
    h.sim.with(|w| {
        w.faults.settle_without_credit = true;
        w.add_place(home2, OWNER, ZERO, None);
    });
    let mut sp = spec("r1", &h.scene);
    sp.ship.dst = home2;
    h.accept(&sp);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Fulfilled);
    let o = row.detail.outcome.unwrap();
    assert_eq!(o.verification, Verification::RuleDerived);
    assert_eq!(o.delivered, Some(r(6, 3)));
}

/// A capture-locked destination: settlement waits (CapturePending); the
/// run stays in transit, then completes once the lock is settled.
#[test]
fn capture_locked_destination_waits() {
    let mut h = H::new("arrival-locked");
    let home2 = holding(1, 1, 3);
    h.sim.with(|w| {
        w.add_place(home2, OWNER, ZERO, None);
        w.places.get_mut(&home2.slot_key()).unwrap().capture_locked = true;
    });
    let mut sp = spec("r1", &h.scene);
    sp.ship.dst = home2;
    h.accept(&sp);
    for _ in 0..60 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(
        h.run("r1").state,
        RunState::InTransit,
        "past its arrival, still locked"
    );
    h.sim
        .with(|w| w.places.get_mut(&home2.slot_key()).unwrap().capture_locked = false);
    assert!(h.drive("r1", 20).is_none());
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    h.audit();
}

/// The verdicts that are known zero: a take, a burn, a lost destination.
#[test]
fn known_zero_outcomes() {
    // Burn: the settle record logs an empty cargo.
    let mut h = H::new("arrival-burn");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let key = CaravanKey {
        owner: OWNER,
        seq: h.run("r1").detail.ship_seq.unwrap(),
    };
    let home = h.scene.raider_home;
    h.sim.with(|w| w.raid(key, false, RAIDER, home));
    assert!(h.drive("r1", 80).is_none());
    let o = h.run("r1").detail.outcome.unwrap();
    assert_eq!(o.verification, Verification::KnownZero);
    assert_eq!(o.delivered, Some(ZERO));
}
