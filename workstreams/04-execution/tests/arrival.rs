//! How much arrived (MOCK world). Only the settle record and the rules
//! decide; the destination's balance never does.

mod common;

use common::*;
use runexec::model::*;
use runexec::ports::Raid;

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

/// Drives a run until its caravan is on the road; returns its key.
fn to_transit(h: &mut H, id: &str) -> CaravanKey {
    for _ in 0..40 {
        if h.run(id).state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(h.run(id).state, RunState::InTransit);
    CaravanKey {
        owner: OWNER,
        seq: h.run(id).detail.ship_seq.unwrap(),
    }
}

/// R-1: more than zero and less than one unit arrives. The program credits
/// a holding in milli-units and logs the cargo rounded down, so the settle
/// record says 0 while the holding kept 0.9. Without a burn record this is
/// not "known zero": the run is Partial with a lower bound of 0, and the
/// destination really holds the fraction. With or without a `credited`
/// field (proposal P1 as whole units, rounded down: a bound too).
#[test]
fn fraction_below_one_unit_is_not_known_zero() {
    for with_credit in [false, true] {
        let mut h = H::new("arrival-fraction");
        let home2 = holding(1, 1, 3);
        h.sim.with(|w| {
            w.faults.settle_without_credit = !with_credit;
            w.add_place(home2, OWNER, ZERO, None);
            // 3 units × 1000 milli, worn 70%: 900 milli, logged as 0.
            w.wear_bps = 7_000;
        });
        let mut sp = spec("r1", &h.scene);
        sp.ship.dst = home2;
        h.accept(&sp);
        assert!(h.drive("r1", 80).is_none());
        let row = h.run("r1");
        assert_eq!(
            row.state,
            RunState::Partial,
            "not Failed: nothing proves zero"
        );
        assert_eq!(row.detail.reason, None);
        let o = row.detail.outcome.unwrap();
        assert_ne!(o.verification, Verification::KnownZero);
        assert_eq!(
            o.verification,
            if with_credit {
                Verification::Recorded
            } else {
                Verification::RuleDerived
            }
        );
        assert_eq!(o.delivered, Some(ZERO), "a lower bound of 0, not a known 0");
        assert_eq!(o.cargo_logged, Some(ZERO));
        h.sim.with(|w| {
            let p = &w.places[&home2.slot_key()];
            assert_eq!(p.stores, ZERO);
            assert_eq!(p.frac[6], 900, "the holding kept 0.9 units");
        });
        h.audit();
        check_store(&h.ex.store);
    }
}

/// 1.98 units kept, logged as 1, asked 3: Partial with a bound of 1 (the
/// kept amount is in [1, 2), short of this run's request). The fraction is
/// really there: a goal summing runs may count it (①'s judgement).
#[test]
fn lower_bound_below_request_is_partial() {
    let mut h = H::new("arrival-bound");
    let home2 = holding(1, 1, 3);
    h.sim.with(|w| {
        w.faults.settle_without_credit = true;
        w.add_place(home2, OWNER, ZERO, None);
        w.wear_bps = 3_400; // 3000 milli → 1980 milli
    });
    let mut sp = spec("r1", &h.scene);
    sp.ship.dst = home2;
    h.accept(&sp);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Partial);
    let o = row.detail.outcome.unwrap();
    assert_eq!(o.delivered, Some(r(6, 1)));
    assert_eq!(o.verification, Verification::RuleDerived);
    h.sim.with(|w| {
        let p = &w.places[&home2.slot_key()];
        assert_eq!((p.stores[6], p.frac[6]), (1, 980));
    });
    h.audit();
}

/// A burn record for this caravan is what makes a zero cargo known zero
/// (the existing `known_zero_outcomes` burn), even when the feed lost it:
/// the caravan's entity history has it.
#[test]
fn burn_record_from_history_makes_zero_known() {
    let mut h = H::new("arrival-burn-history");
    h.accept(&spec("r1", &h.scene));
    let key = to_transit(&mut h, "r1");
    let home = h.scene.raider_home;
    h.sim.with(|w| {
        w.raid(key, false, RAIDER, home);
        w.advance(20);
        w.faults.pruned_before = w.log_len() as u64 + 1;
    });
    assert!(h.drive("r1", 40).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::LostInTransit));
    assert_eq!(
        row.detail.outcome.unwrap().verification,
        Verification::KnownZero
    );
    h.audit();
}

/// A settlement at another destination without any raid record: the cause
/// is unconfirmed. Not Failed, not Raided, no amount, nobody named; after
/// looking a while the run is held for a person. A raid record that turns
/// up later (late feed) resolves it on resume.
#[test]
fn destination_mismatch_without_raid_record_is_unconfirmed() {
    let mut h = H::new("arrival-mismatch");
    h.accept(&spec("r1", &h.scene));
    let key = to_transit(&mut h, "r1");
    let other = h.scene.other_place;
    // MOCK: the destination changes with no record of why (a missing raid
    // record, or a bad read). Ownership stays the sender's.
    h.sim
        .with(|w| w.caravans.get_mut(&(key.owner, key.seq)).unwrap().dst = other);
    // A raid record of the other kind (a burn) for this caravan is not
    // evidence of a take.
    let slot0 = h.sim.with(|w| w.slot);
    h.sim.with(|w| {
        w.log_raid_record(Raid {
            key,
            choice: frontier_abi::v2::log::raid_choice::BURN,
            raider: RAIDER,
            taken: ZERO,
            slot: slot0,
        })
    });
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Arrived, "not judged");
    assert_eq!(row.held.as_deref(), Some("DestinationMismatch"));
    assert_eq!(row.detail.reason, Some(Reason::DestinationMismatch));
    assert_eq!(row.detail.outcome, None, "no amount is stated");
    assert_ne!(row.detail.reason, Some(Reason::Raided), "nobody is named");
    let take = frontier_abi::v2::log::raid_choice::TAKE as u64;
    assert!(!h
        .ex
        .store
        .receipts("r1")
        .unwrap()
        .iter()
        .any(|r| r.kind == "caravan_raided" && r.body["choice"].as_u64() == Some(take)));
    // The record shows up late: a take by the raider. On resume it decides.
    let slot = h.sim.with(|w| w.slot);
    h.sim.with(|w| {
        w.log_raid_record(Raid {
            key,
            choice: frontier_abi::v2::log::raid_choice::TAKE,
            raider: RAIDER,
            taken: r(6, 3),
            slot,
        })
    });
    assert!(h.ex.store.resume("r1").unwrap());
    assert!(h.drive("r1", 40).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::Raided));
    assert_eq!(row.detail.outcome.unwrap().delivered, Some(ZERO));
    assert!(h
        .ex
        .store
        .receipts("r1")
        .unwrap()
        .iter()
        .any(|r| r.kind == "caravan_raided" && r.body["choice"].as_u64() == Some(take)));
}

/// A raid record of the other kind, or for another caravan, is not
/// evidence: a burn of someone else's caravan does not make ours zero.
#[test]
fn raid_record_must_match_the_caravan_and_the_kind() {
    let mut h = H::new("arrival-mismatch-other");
    let home2 = holding(1, 1, 3);
    h.sim.with(|w| {
        w.faults.settle_without_credit = true;
        w.add_place(home2, OWNER, ZERO, None);
        w.wear_bps = 7_000;
    });
    let mut sp = spec("r1", &h.scene);
    sp.ship.dst = home2;
    h.accept(&sp);
    let key = to_transit(&mut h, "r1");
    let slot = h.sim.with(|w| w.slot);
    h.sim.with(|w| {
        // A burn of another caravan (another seq of the same owner)…
        w.log_raid_record(Raid {
            key: CaravanKey {
                owner: key.owner,
                seq: key.seq + 7,
            },
            choice: frontier_abi::v2::log::raid_choice::BURN,
            raider: RAIDER,
            taken: ZERO,
            slot,
        });
    });
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Partial);
    assert_ne!(
        row.detail.outcome.unwrap().verification,
        Verification::KnownZero
    );
}
