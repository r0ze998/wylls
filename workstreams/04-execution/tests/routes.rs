//! Other routes that use the owner's caravan seq: a send by hand, another
//! service, an executor on another store (MOCK world). The store's
//! one-send-per-owner rule does not reach them; the seq rule and the
//! content check do. `(owner, seq)` alone never makes a send ours.

mod common;

use common::*;
use runexec::model::*;
use runexec::sim::SendFault;
use runexec::store::Step;

fn to_facility_confirmed(h: &mut H, id: &str) {
    for _ in 0..30 {
        if h.run(id).state == RunState::FacilityConfirmed {
            return;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    panic!("{id} never reached FacilityConfirmed");
}

/// The player sends by hand the very shipment the run was about to make
/// (same places, same cargo) and takes the pinned seq. It is not ours: the
/// run does not report success, does not re-send on it, and stops when the
/// outputs are gone.
#[test]
fn identical_send_by_another_route_is_not_ours() {
    let mut h = H::new("route-identical");
    h.accept(&spec("r1", &h.scene));
    to_facility_confirmed(&mut h, "r1");
    h.sim.with(|w| w.faults.send.push_back(SendFault::Timeout));
    h.ex.tick().unwrap(); // pins seq 0, not landed
    let seq = h.run("r1").detail.ship_seq.unwrap();
    let (stock, dst) = (h.scene.stock, h.scene.dst);
    let manual = h.sim.with(|w| w.manual_send(OWNER, stock, dst, r(6, 3)));
    assert_eq!(manual.seq, seq);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::OutputShort));
    assert!(
        !h.ex
            .store
            .receipts("r1")
            .unwrap()
            .iter()
            .any(|r| r.kind == "caravan_sent"),
        "no shipment receipt for a send that is not ours"
    );
    for a in h.ex.store.attempts("r1", Step::Ship).unwrap() {
        assert!(!h.sim.with(|w| w.took_effect(&a.prepared.sig)));
    }
    h.audit();
    check_store(&h.ex.store);
}

/// Statuses, entity history and feed all unavailable, and a caravan exists
/// at `(owner, seq)` with exactly our content (made by hand). Nothing names
/// our signature: held as indeterminate, never success, never a re-send.
#[test]
fn owner_and_seq_alone_prove_nothing() {
    let mut h = H::new("route-seq-only");
    h.accept(&spec("r1", &h.scene));
    to_facility_confirmed(&mut h, "r1");
    h.sim.with(|w| w.faults.send.push_back(SendFault::Timeout));
    h.ex.tick().unwrap();
    let (stock, dst) = (h.scene.stock, h.scene.dst);
    h.sim.with(|w| {
        w.faults.status_unavailable = true;
        w.faults.history_unavailable = true;
        w.faults.pruned_before = u64::MAX;
        w.manual_send(OWNER, stock, dst, r(6, 3));
    });
    let sends = h.sim.with(|w| w.ledger.sends_received);
    assert!(h.drive("r1", 40).is_none());
    let row = h.run("r1");
    assert_eq!(row.held.as_deref(), Some("Indeterminate"));
    assert!(row.state.in_flight(), "{:?}", row.state);
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), sends, "no re-send");
    assert!(!h
        .ex
        .store
        .receipts("r1")
        .unwrap()
        .iter()
        .any(|r| r.kind == "caravan_sent"));
}

/// Two executors on two stores, one owner: the per-store rule cannot stop
/// them pinning the same seq. One send takes it; the other lands failed
/// (seq mismatch, fee charged), is recognised as not ours from the record
/// naming another signature, and re-pins. One caravan each, no double effect.
#[test]
fn executor_on_another_store_takes_the_seq() {
    let mut h = H::new("route-two-stores");
    h.sim.with(|w| w.deposit(&h.scene.stock, &r(1, 5)));
    h.accept(&spec("r1", &h.scene));
    let db2 = db_path("route-two-stores-2");
    let mut ex2 = executor(&db2, &h.sim, "exec-2");
    ex2.accept(&spec("r2", &h.scene)).unwrap();
    // Lock-step until both are ready to ship.
    for _ in 0..30 {
        if h.run("r1").state == RunState::FacilityConfirmed
            && ex2.store.load("r2").unwrap().unwrap().state == RunState::FacilityConfirmed
        {
            break;
        }
        h.ex.tick().unwrap();
        ex2.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    // r1's send lands two slots late; r2's is processed at once and takes
    // the seq both pinned.
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LandLater(2)));
    h.ex.tick().unwrap();
    ex2.tick().unwrap();
    let s1 = h.run("r1").detail.ship_seq;
    let s2 = ex2.store.load("r2").unwrap().unwrap().detail.ship_seq;
    assert_eq!(s1, s2, "both pinned the same seq");
    for _ in 0..120 {
        let done2 = ex2.store.load("r2").unwrap().unwrap().state.terminal();
        if h.run("r1").state.terminal() && done2 {
            break;
        }
        h.ex.tick().unwrap();
        ex2.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let r1 = h.run("r1");
    let r2 = ex2.store.load("r2").unwrap().unwrap();
    assert_eq!(r1.state, RunState::Fulfilled);
    assert_eq!(r2.state, RunState::Fulfilled);
    assert_eq!(r1.detail.ship_attempts, 2, "r1 re-pinned");
    assert_eq!(r2.detail.ship_attempts, 1);
    assert_ne!(r1.detail.ship_seq, r2.detail.ship_seq);
    // r1's first attempt landed failed: its fee is charged, not released.
    let first = &h.ex.store.attempts("r1", Step::Ship).unwrap()[0];
    assert!(!h.sim.with(|w| w.took_effect(&first.prepared.sig)));
    h.sim.with(|w| w.advance(20));
    h.ex.tick().unwrap();
    let book = h.ex.store.fees("r1").unwrap();
    assert_eq!(book.unconfirmed, 0, "{book:?}");
    assert_eq!(book.charged, 3 * 5_000, "facility + failed ship + ship");
    h.sim.with(|w| assert_eq!(w.stores(&h.scene.dst), r(6, 6)));
    h.audit();
    check_store(&h.ex.store);
    check_store(&ex2.store);
}

/// A record names our signature but with other content (a destination
/// that is not ours). A real chain cannot produce this; an adapter or
/// indexer bug could. It is held as inconsistent, never taken as success.
/// (The record is injected into the store: the MOCK world never lies.)
#[test]
fn our_signature_with_other_content_is_held() {
    use runexec::ports::{Event, EventRec};
    let mut h = H::new("route-content");
    h.accept(&spec("r1", &h.scene));
    to_facility_confirmed(&mut h, "r1");
    h.sim.with(|w| w.faults.send.push_back(SendFault::Timeout));
    h.ex.tick().unwrap();
    let a = h.ex.store.attempts("r1", Step::Ship).unwrap()[0].clone();
    let seq = h.run("r1").detail.ship_seq.unwrap();
    // Keep our bytes from landing, and lie in the store.
    h.sim.with(|w| w.advance(w.validity + 2));
    let fake = EventRec {
        id: "fake:0".into(),
        pos: 0,
        event: Event::CaravanSent {
            key: CaravanKey { owner: OWNER, seq },
            sig: a.prepared.sig.clone(),
            src: h.scene.stock,
            dst: h.scene.other_place,
            cargo: r(6, 3),
            arrive_slot: 99,
        },
    };
    h.ex.store.record_event(&fake, 0).unwrap();
    assert!(h.drive("r1", 20).is_none());
    let row = h.run("r1");
    assert!(
        row.held
            .as_deref()
            .is_some_and(|x| x.starts_with("Inconsistent")),
        "{:?} {:?}",
        row.state,
        row.held
    );
    assert_ne!(row.state, RunState::InTransit);
}
