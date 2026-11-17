//! Signed requests the store cannot fence (MOCK world). A compare-and-swap
//! stops a stale executor from *writing*; it cannot stop bytes it already
//! signed from being *sent*, and the chain accepts them until their
//! blockhash expires. These tests drive that window deterministically.

mod common;

use common::*;
use runexec::executor::{CrashPlan, Halt};
use runexec::model::*;
use runexec::ports::{Chain, Reject, SendResult};
use runexec::sim::SendFault;
use runexec::store::Step;

/// Executor A signs and journals the facility request, then stops before
/// sending (it still holds the bytes). Returns those bytes.
fn a_signs_and_stalls(h: &mut H) -> runexec::ports::Prepared {
    h.accept(&spec("r1", &h.scene));
    h.ex.crash = Some(CrashPlan::at("facility.before_send", 1));
    h.ex.tick().unwrap(); // Reserved
    assert_eq!(
        h.ex.tick().err(),
        Some(Halt::Crashed("facility.before_send"))
    );
    let atts = h.ex.store.attempts("r1", Step::Facility).unwrap();
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].status, "intent");
    atts[0].prepared.clone()
}

/// Cancel, lease hand-over, then the stalled executor wakes **within** the
/// bytes' validity and sends them: they land (the chain never sees the
/// store). The cancel is not reported complete until then, and when it
/// completes it names what landed; the stock shows exactly that.
#[test]
fn stale_bytes_sent_after_cancel_within_validity_land_and_are_reported() {
    let mut h = H::new("zombie-cancel-lands");
    let bytes = a_signs_and_stalls(&mut h);
    h.ex.store.request_cancel("r1").unwrap();
    assert_eq!(h.run("r1").cancel_phase(), Some(CancelPhase::StoppingNew));
    h.sim.with(|w| w.advance(9)); // A's lease (8) lapses; bytes valid ≤ 11
    let mut b = executor(&h.db, &h.sim, "exec-b");
    let sends = h.sim.with(|w| w.ledger.sends_received);
    b.tick().unwrap();
    assert_eq!(
        h.sim.with(|w| w.ledger.sends_received),
        sends,
        "B does not push a cancelled request"
    );
    let row = h.run("r1");
    assert_eq!(
        row.state,
        RunState::FacilityRequested,
        "not reported cancelled yet"
    );
    assert_eq!(
        row.cancel_phase(),
        Some(CancelPhase::AwaitingSigned {
            until: bytes.valid_until
        })
    );
    // A wakes up and sends: nothing in this store can stop it.
    assert_eq!(h.sim.send(&bytes), SendResult::Accepted);
    for _ in 0..20 {
        if h.run("r1").state.terminal() {
            break;
        }
        b.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Cancelled);
    let effects = vec!["facility_used fac:r1".to_string()];
    assert_eq!(
        row.cancel_phase(),
        Some(CancelPhase::Completed {
            effects: effects.clone()
        })
    );
    assert_eq!(row.detail.outcome.as_ref().unwrap().effects, effects);
    // The display and the resources agree: inputs used, outputs at stock,
    // nothing shipped.
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 1);
        assert!(w.caravans.is_empty());
        assert_eq!(
            w.stores(&h.scene.stock),
            runexec::model::res_add(&r(1, 5), &r(6, 3))
        );
    });
    h.audit();
    check_store(&b.store);
}

/// The same, but A wakes **after** the validity: the chain refuses the
/// bytes (blockhash expired). The cancel completes with no effect.
#[test]
fn stale_bytes_sent_after_validity_are_refused() {
    let mut h = H::new("zombie-cancel-expired");
    let bytes = a_signs_and_stalls(&mut h);
    h.ex.store.request_cancel("r1").unwrap();
    h.sim.with(|w| w.advance(9));
    let mut b = executor(&h.db, &h.sim, "exec-b");
    b.tick().unwrap();
    h.sim.with(|w| w.advance(3)); // past valid_until
    assert_eq!(h.sim.send(&bytes), SendResult::Rejected(Reject::Expired));
    for _ in 0..10 {
        b.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Cancelled);
    assert_eq!(
        row.cancel_phase(),
        Some(CancelPhase::Completed { effects: vec![] })
    );
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 0);
        assert_eq!(w.stores(&h.scene.stock), r(1, 10));
    });
    let book = b.store.fees("r1").unwrap();
    assert_eq!((book.charged, book.reserved, book.released), (0, 0, 5_000));
}

/// No cancel: B takes over while A's bytes are still valid and cannot get
/// them through (timeouts). B signs a **new** attempt only after A's bytes
/// expired; when A later sends its old bytes, the chain refuses them. One
/// effect.
#[test]
fn new_attempt_only_after_stale_bytes_expired() {
    let mut h = H::new("zombie-resign");
    h.sim.with(|w| {
        for _ in 0..12 {
            w.faults.send.push_back(SendFault::Timeout);
        }
    });
    let bytes = a_signs_and_stalls(&mut h);
    h.sim.with(|w| w.advance(9));
    let mut b = executor(&h.db, &h.sim, "exec-b");
    for _ in 0..150 {
        if h.run("r1").state.terminal() {
            break;
        }
        b.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let atts = b.store.attempts("r1", Step::Facility).unwrap();
    assert!(atts.len() >= 2);
    // Each new signature was made only after the one before it expired.
    let validity = h.sim.with(|w| w.validity);
    for pair in atts.windows(2) {
        let signed_at = pair[1].prepared.valid_until - validity;
        assert!(
            signed_at > pair[0].prepared.valid_until,
            "signed at {signed_at} while earlier bytes were valid until {}",
            pair[0].prepared.valid_until
        );
    }
    assert_eq!(atts[0].prepared.sig, bytes.sig);
    assert_eq!(h.sim.send(&bytes), SendResult::Rejected(Reject::Expired));
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    h.sim.with(|w| assert_eq!(w.effects("fac:r1"), 1));
    h.audit();
}

/// A refusal at preflight (another player spent the stock between our
/// check and our send) does not end the step at once: the same signed
/// bytes can still land while valid. Here they are sent again after the
/// stock came back, and land: the run goes on, never reported failed.
#[test]
fn preflight_refusal_is_not_final_while_bytes_are_valid() {
    let mut h = H::new("preflight-lands");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // Reserved
    let stock = h.scene.stock;
    h.sim
        .with(|w| w.faults.spend_before_send = Some((stock, r(1, 8))));
    h.ex.tick().unwrap(); // signed, sent, refused (Insufficient)
    let row = h.run("r1");
    assert_eq!(row.state, RunState::FacilityRequested);
    assert_eq!(row.detail.pending, Some(Reason::InputShort));
    let bytes = h.ex.store.attempts("r1", Step::Facility).unwrap()[0]
        .prepared
        .clone();
    h.sim.with(|w| w.deposit(&stock, &r(1, 8)));
    assert_eq!(h.sim.send(&bytes), SendResult::Accepted, "a copy lands");
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.detail.reason);
    h.audit();
}

/// Without a second copy, the refusal ends the step — only after the
/// bytes' validity, and with nothing consumed.
#[test]
fn preflight_refusal_fails_only_after_validity() {
    let mut h = H::new("preflight-fails");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap();
    let stock = h.scene.stock;
    h.sim
        .with(|w| w.faults.spend_before_send = Some((stock, r(1, 8))));
    h.ex.tick().unwrap();
    let valid_until = h.ex.store.attempts("r1", Step::Facility).unwrap()[0]
        .prepared
        .valid_until;
    while h.sim.with(|w| w.slot) <= valid_until {
        h.ex.tick().unwrap();
        assert!(
            !h.run("r1").state.terminal(),
            "failed while the bytes were valid"
        );
        h.sim.with(|w| w.advance(1));
    }
    assert!(h.drive("r1", 10).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::InputShort));
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 0);
        assert_eq!(w.stores(&stock), r(1, 2));
    });
    let book = h.ex.store.fees("r1").unwrap();
    assert_eq!((book.charged, book.reserved), (0, 0));
}

/// A cancel in transit is recorded as too late (no recall), and the run's
/// outcome follows the road.
#[test]
fn cancel_in_transit_is_recorded_ineffective() {
    let mut h = H::new("cancel-ineffective");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    h.ex.store.request_cancel("r1").unwrap();
    h.ex.tick().unwrap();
    assert_eq!(
        h.run("r1").cancel_phase(),
        Some(CancelPhase::Ineffective {
            at: "InTransit".into()
        })
    );
    assert!(h.drive("r1", 80).is_none());
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
}
