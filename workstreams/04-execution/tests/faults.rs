//! Fault injection against the simulated world (MOCK). Each test names the
//! requirement it covers (`docs/TEST-REPORT.ja.md` maps them).

mod common;

use common::*;
use runexec::executor::{Halt, CRASH_POINTS};
use runexec::model::*;
use runexec::sim::SendFault;
use runexec::store::Accept;

/// Fulfilled with one effect per step, and its fees settled: after the
/// last attempt's validity a reconciliation leaves nothing reserved or
/// unconfirmed, and what is charged is what the world charged.
fn assert_fulfilled(h: &mut H, id: &str) {
    settle_fees(h);
    let row = h.run(id);
    let book = h.ex.store.fees(id).unwrap();
    assert_eq!(book.reserved, 0, "{id}: {book:?}");
    assert_eq!(book.unconfirmed, 0, "{id}: {book:?}");
    assert_eq!(
        book.charged,
        h.sim.with(|w| w.ledger.fees),
        "{id}: fees counted = fees charged"
    );
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{id}: {:?} {:?}",
        row.detail.reason,
        row.held
    );
    let key = h.ship_key(id);
    h.sim.with(|w| {
        assert_eq!(w.effects(&format!("fac:{id}")), 1);
        assert_eq!(w.effects(&key), 1);
        assert_eq!(w.stores(&h.scene.dst), r(6, 3));
        assert_eq!(w.stores(&h.scene.stock), r(1, 5));
    });
    h.audit();
    check_store(&h.ex.store);
}

#[test]
fn happy_path_fulfils_with_three_receipts() {
    let mut h = H::new("happy");
    h.accept(&spec("r1", &h.scene));
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
    let kinds: Vec<String> =
        h.ex.store
            .receipts("r1")
            .unwrap()
            .into_iter()
            .map(|r| r.kind)
            .collect();
    assert_eq!(kinds, ["facility_used", "caravan_sent", "caravan_settled"]);
    let states: Vec<String> =
        h.ex.store
            .history("r1")
            .unwrap()
            .into_iter()
            .map(|t| t.1)
            .collect();
    for s in [
        "Reserved",
        "FacilityRequested",
        "FacilitySubmitted",
        "FacilityConfirmed",
        "ShipRequested",
        "ShipSubmitted",
        "InTransit",
        "Arrived",
        "Fulfilled",
    ] {
        assert!(states.iter().any(|x| x == s), "{s} not visited: {states:?}");
    }
}

/// 送信前・送信後・確定後の各時点で停止・再起動。
#[test]
fn stop_and_restart_at_every_point() {
    for point in CRASH_POINTS {
        let mut h = H::new("crash");
        h.accept(&spec("r1", &h.scene));
        h.crash_at(point, 1);
        let halt = h.drive("r1", 80);
        assert_eq!(halt, Some(Halt::Crashed(point)), "{point}");
        // The world goes on while the process is down.
        h.sim.with(|w| w.advance(3));
        h.restart();
        assert!(h.drive("r1", 120).is_none(), "{point}");
        assert_fulfilled(&mut h, "r1");
    }
}

/// The same, with the restart only after the attempt's validity ran out
/// (the journalled-but-unsent attempt can no longer land; a new one is
/// signed after fresh checks).
#[test]
fn restart_after_validity_ran_out() {
    for point in ["facility.before_send", "ship.before_send"] {
        let mut h = H::new("crash-late");
        h.accept(&spec("r1", &h.scene));
        h.crash_at(point, 1);
        assert_eq!(h.drive("r1", 80), Some(Halt::Crashed(point)));
        h.sim.with(|w| w.advance(30));
        h.restart();
        assert!(h.drive("r1", 120).is_none());
        assert_fulfilled(&mut h, "r1");
        let atts = h.run("r1").detail;
        assert_eq!(
            atts.fac_attempts + atts.ship_attempts,
            3,
            "{point}: one extra attempt"
        );
    }
}

/// 送信応答は不明だが、実際には確定していた場合。
#[test]
fn response_lost_but_committed() {
    let mut h = H::new("lost-resp");
    h.sim.with(|w| {
        w.faults.send.push_back(SendFault::LoseResponse);
        w.faults.send.push_back(SendFault::LoseResponse);
    });
    h.accept(&spec("r1", &h.scene));
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
    let d = h.run("r1").detail;
    assert_eq!(
        (d.fac_attempts, d.ship_attempts),
        (1, 1),
        "no second attempt was signed"
    );
    // Only landed fees are charged.
    assert_eq!(
        h.ex.store.fees("r1").unwrap().charged,
        h.sim.with(|w| w.ledger.fees)
    );
}

/// Timeouts that never reached the leader: the same bytes are sent again,
/// within the validity, and take effect once.
#[test]
fn timeout_without_commit_is_rebroadcast() {
    let mut h = H::new("timeout");
    h.sim.with(|w| {
        w.faults.send.push_back(SendFault::Timeout);
        w.faults.send.push_back(SendFault::Timeout);
    });
    h.accept(&spec("r1", &h.scene));
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
    let d = h.run("r1").detail;
    assert_eq!(
        (d.fac_attempts, d.ship_attempts),
        (1, 1),
        "the same bytes were re-sent; no new attempt signed"
    );
}

/// 同じイベントの重複・順序逆転。
#[test]
fn duplicated_and_reversed_feed() {
    let mut h = H::new("feed");
    h.sim.with(|w| {
        w.faults.feed_duplicates = true;
        w.faults.feed_reversed = true;
    });
    h.accept(&spec("r1", &h.scene));
    h.accept(&spec("r2", &h.scene));
    h.sim.with(|w| w.deposit(&h.scene.stock, &r(1, 5)));
    assert!(h.drive("r1", 120).is_none());
    assert!(h.drive("r2", 120).is_none());
    for id in ["r1", "r2"] {
        let row = h.run(id);
        assert_eq!(
            row.state,
            RunState::Fulfilled,
            "{id}: {:?} {:?}",
            row.detail,
            h.ex.store.history(id).unwrap()
        );
        // One receipt per fact despite every record arriving twice.
        assert_eq!(h.ex.store.receipts(id).unwrap().len(), 3);
    }
    h.audit();
    check_store(&h.ex.store);
}

/// The settle record seen before the send record (reordered across pages):
/// the run still waits for its own canonical confirmation.
#[test]
fn settle_seen_before_send_is_harmless() {
    let mut h = H::new("reorder");
    h.accept(&spec("r1", &h.scene));
    // Lose the ship response so the run waits in ShipRequested while the
    // caravan travels; reverse the feed.
    h.sim.with(|w| {
        w.faults.send.push_back(SendFault::Timeout); // facility: rebroadcast
        w.faults.feed_reversed = true;
    });
    assert!(h.drive("r1", 120).is_none());
    assert_fulfilled(&mut h, "r1");
}

/// 履歴の欠落: the feed lost records (a gap); the entity history fills in.
#[test]
fn history_gap_is_reconciled_from_entity_history() {
    let mut h = H::new("gap");
    h.accept(&spec("r1", &h.scene));
    // Run until in transit, then lose the feed (the executor is down long
    // enough for the feed to prune everything it had not read).
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(h.run("r1").state, RunState::InTransit);
    h.sim.with(|w| {
        w.advance(40); // settles meanwhile
        w.faults.pruned_before = w.log_len() as u64 + 1;
    });
    h.restart();
    let rep = h.ex.tick().unwrap();
    assert!(rep.gap);
    assert!(h.drive("r1", 40).is_none());
    assert_fulfilled(&mut h, "r1");
    let src: Vec<String> =
        h.ex.store
            .receipts("r1")
            .unwrap()
            .into_iter()
            .map(|r| r.source)
            .collect();
    assert!(src.iter().any(|s| s.starts_with("history:")), "{src:?}");
    assert!(h
        .ex
        .store
        .alerts()
        .unwrap()
        .iter()
        .any(|a| a.2 == "history_gap"));
}

/// 履歴の欠落 with no status history and no entity index: the run is held,
/// not guessed; an operator resumes it once a source is back.
#[test]
fn indeterminate_is_held_then_resumed() {
    let mut h = H::new("indeterminate");
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LoseResponse));
    // No status history, no entity index and no feed: nothing names the
    // signature that made the caravan.
    h.sim.with(|w| {
        w.faults.status_unavailable = true;
        w.faults.history_unavailable = true;
        w.faults.pruned_before = u64::MAX;
    });
    h.accept(&spec("r1", &h.scene));
    // The facility is found by key (status not needed) …
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    // … but the ship's landing cannot be attributed: held.
    assert_eq!(row.state, RunState::ShipSubmitted);
    assert_eq!(row.held.as_deref(), Some("Indeterminate"));
    let sends = h.sim.with(|w| w.ledger.sends_received);
    for _ in 0..10 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(
        h.sim.with(|w| w.ledger.sends_received),
        sends,
        "a held run sends nothing"
    );
    // While held: the fee of the landed facility use is unconfirmed (its
    // status could not be read), not assumed.
    assert!(h.ex.store.fees("r1").unwrap().unconfirmed > 0);
    h.sim.with(|w| {
        w.faults.history_unavailable = false;
        w.faults.status_unavailable = false;
        w.faults.pruned_before = 0;
    });
    assert!(h.ex.store.resume("r1").unwrap());
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
}

/// 古い状態: a write from a stale snapshot changes nothing and sends nothing.
#[test]
fn stale_snapshot_writes_and_sends_nothing() {
    let mut h = H::new("stale");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // → Reserved
    let snapshot = h.run("r1");
    assert_eq!(snapshot.state, RunState::Reserved);
    h.ex.tick().unwrap(); // → FacilityRequested/Submitted (sends)
    let sends = h.sim.with(|w| w.ledger.sends_received);
    let now = h.sim.with(|w| w.slot);
    let mut rep = Default::default();
    assert!(
        !h.ex.step(&snapshot, now, &mut rep).unwrap(),
        "stale write accepted"
    );
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), sends);
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
}

/// 権利失効 before the send: nothing is used, inputs stay.
#[test]
fn rights_expired_before_send() {
    let mut h = H::new("rights");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // Reserved
    h.sim.with(|w| {
        let s = w.slot;
        w.grant(OWNER, h.scene.facility, 10, s); // expires now
    });
    assert!(h.drive("r1", 20).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::RightsExpired));
    assert_eq!(row.detail.fac_attempts, 0, "refused before signing");
    h.sim.with(|w| {
        assert_eq!(w.ledger.sends_received, 0);
        assert_eq!(w.effects("fac:r1"), 0);
        assert_eq!(w.stores(&h.scene.stock), r(1, 10));
    });
    assert_eq!(h.ex.store.reservations_of("r1").unwrap(), 0);
    h.audit();
}

/// 権利失効 between the check and the landing: the canonical side refuses
/// atomically; the run fails without effect.
#[test]
fn rights_expire_while_in_flight() {
    let mut h = H::new("rights-flight");
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LandLater(3)));
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // Reserved
    h.ex.tick().unwrap(); // sent; lands in 3 slots
    h.sim.with(|w| {
        let s = w.slot;
        w.grant(OWNER, h.scene.facility, 10, s + 1);
    });
    assert!(h.drive("r1", 30).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::RightsExpired));
    h.sim.with(|w| assert_eq!(w.effects("fac:r1"), 0));
    h.audit();
}

/// Two runs on one right with one unit left: the local reservation keeps
/// the second from even trying.
#[test]
fn right_units_are_reserved_across_runs() {
    let mut h = H::new("rights-units");
    h.sim.with(|w| {
        w.grant(OWNER, h.scene.facility, 1, 10_000);
        w.deposit(&h.scene.stock, &r(1, 5));
    });
    h.accept(&spec("r1", &h.scene));
    h.accept(&spec("r2", &h.scene));
    for _ in 0..80 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let (a, b) = (h.run("r1"), h.run("r2"));
    let states = [a.state, b.state];
    assert!(states.contains(&RunState::Fulfilled), "{states:?}");
    assert!(
        states.contains(&RunState::Failed),
        "the second run fails on the right, not on the chain: {states:?}"
    );
    let failed = if a.state == RunState::Failed { a } else { b };
    assert_eq!(failed.detail.reason, Some(Reason::RightsInsufficient));
    assert_eq!(failed.detail.fac_attempts, 0);
    h.audit();
}

/// 材料不足: the run waits for the inbound caravan, then proceeds.
#[test]
fn waits_for_inbound_materials() {
    let mut h = H::new("inbound");
    let src = vault(4, 4, 2);
    let inbound = h.sim.with(|w| {
        w.add_place(src, OWNER, r(1, 50), None);
        w.spend(&h.scene.stock, &r(1, 10));
        w.manual_send(OWNER, src, h.scene.stock, r(1, 5))
    });
    let mut sp = spec("r1", &h.scene);
    sp.inbound = Some(inbound);
    h.accept(&sp);
    for _ in 0..10 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(
        h.run("r1").state,
        RunState::Accepted,
        "waits for the inputs"
    );
    assert!(h.drive("r1", 120).is_none());
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    h.audit();
}

/// 材料不足 for good: the inbound caravan is taken by a raider.
#[test]
fn inbound_taken_fails_the_run() {
    let mut h = H::new("inbound-lost");
    let src = vault(4, 4, 2);
    let inbound = h.sim.with(|w| {
        w.add_place(src, OWNER, r(1, 50), None);
        w.spend(&h.scene.stock, &r(1, 10));
        w.manual_send(OWNER, src, h.scene.stock, r(1, 5))
    });
    let mut sp = spec("r1", &h.scene);
    sp.inbound = Some(inbound);
    h.accept(&sp);
    h.ex.tick().unwrap();
    let home = h.scene.raider_home;
    h.sim.with(|w| w.raid(inbound, true, RAIDER, home));
    assert!(h.drive("r1", 60).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::InputLost));
    h.audit();
}

/// R-1 for inbound materials: the inbound caravan settles with a cargo
/// logged as 0 (worn below one unit; the stock kept the fraction). No burn
/// record: not "lost" (no InputLost claim); the run waits on the canonical
/// stock until its deadline and expires.
#[test]
fn inbound_fraction_is_not_reported_lost() {
    let mut h = H::new("inbound-fraction");
    let src = vault(4, 4, 2);
    let inbound = h.sim.with(|w| {
        w.add_place(src, OWNER, r(1, 50), None);
        w.spend(&h.scene.stock, &r(1, 10));
        w.wear_bps = 9_000; // 1 unit → 100 milli, logged 0
        w.manual_send(OWNER, src, h.scene.stock, r(1, 1))
    });
    h.sim.with(|w| w.wear_bps = 0);
    let mut sp = spec("r1", &h.scene);
    sp.inbound = Some(inbound);
    sp.deadline_slot = 60;
    h.accept(&sp);
    assert!(h.drive("r1", 120).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Expired);
    assert_ne!(row.detail.reason, Some(Reason::InputLost));
    h.audit();
}

/// 材料不足 until the deadline: expired, nothing used.
#[test]
fn no_materials_expires() {
    let mut h = H::new("expire-input");
    h.sim.with(|w| w.spend(&h.scene.stock, &r(1, 8)));
    let mut sp = spec("r1", &h.scene);
    sp.deadline_slot = 30;
    h.accept(&sp);
    assert!(h.drive("r1", 60).is_none());
    assert_eq!(h.run("r1").state, RunState::Expired);
    h.sim.with(|w| assert_eq!(w.effects("fac:r1"), 0));
}

/// The stock is spent by hand between reservation and send: back to
/// waiting, never a refused send.
#[test]
fn stock_spent_after_reservation_goes_back_to_waiting() {
    let mut h = H::new("spent");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap();
    assert_eq!(h.run("r1").state, RunState::Reserved);
    h.sim.with(|w| w.spend(&h.scene.stock, &r(1, 8)));
    h.ex.tick().unwrap();
    assert_eq!(h.run("r1").state, RunState::Accepted);
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), 0);
    h.sim.with(|w| w.deposit(&h.scene.stock, &r(1, 3)));
    assert!(h.drive("r1", 80).is_none());
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    h.audit();
}

/// 部分到着: the towers' wear.
#[test]
fn wear_gives_partial() {
    let mut h = H::new("wear");
    h.sim.with(|w| w.wear_bps = 3_400);
    let mut sp = spec("r1", &h.scene);
    sp.outputs = r(6, 10);
    sp.ship.cargo = r(6, 10);
    h.accept(&sp);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Partial);
    let o = row.detail.outcome.unwrap();
    assert_eq!(o.delivered, Some(r(6, 6)));
    assert_eq!(o.verification, Verification::Recorded);
    assert_eq!(row.detail.sent_cargo, Some(r(6, 6)));
    h.audit();
}

/// 部分到着: a vault at capacity drops the excess. With a settle record that
/// states the credited amount it is measured; without (today's chain) it is
/// reported as unverified, never as full.
#[test]
fn capacity_clip_gives_partial() {
    for with_credit in [true, false] {
        let mut h = H::new("cap");
        h.sim.with(|w| {
            w.faults.settle_without_credit = !with_credit;
            w.places.get_mut(&h.scene.dst.slot_key()).unwrap().cap = Some(1);
        });
        h.accept(&spec("r1", &h.scene));
        assert!(h.drive("r1", 80).is_none());
        let row = h.run("r1");
        let o = row.detail.outcome.clone().unwrap();
        assert_eq!(o.cargo_logged, Some(r(6, 3)), "an upper bound only");
        if with_credit {
            assert_eq!(row.state, RunState::Partial);
            assert_eq!(o.delivered, Some(r(6, 1)));
            assert_eq!(o.verification, Verification::Recorded);
        } else {
            // Not "partial confirmed": the amount is unknown.
            assert_eq!(row.state, RunState::DeliveredUnverified);
            assert_eq!(o.delivered, None);
            assert_eq!(o.verification, Verification::Unverifiable);
        }
        h.audit();
    }
}

/// 襲撃による損失: take and burn.
#[test]
fn raids() {
    for take in [true, false] {
        let mut h = H::new("raid");
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
        h.sim.with(|w| w.raid(key, take, RAIDER, home));
        assert!(h.drive("r1", 80).is_none());
        let row = h.run("r1");
        assert_eq!(row.state, RunState::Failed);
        assert_eq!(
            row.detail.reason,
            Some(if take {
                Reason::Raided
            } else {
                Reason::LostInTransit
            })
        );
        assert!(h
            .ex
            .store
            .receipts("r1")
            .unwrap()
            .iter()
            .any(|r| r.kind == "caravan_raided"));
        h.sim.with(|w| assert_eq!(w.stores(&h.scene.dst), ZERO));
        h.audit();
        check_store(&h.ex.store);
    }
}

/// A take never seen (feed and status gone): the settlement at another
/// destination still tells it.
#[test]
fn unseen_take_is_found_at_settlement() {
    let mut h = H::new("raid-unseen");
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
    h.sim.with(|w| {
        w.raid(key, true, RAIDER, home);
        w.advance(10);
        w.faults.pruned_before = w.log_len() as u64 + 1;
    });
    assert!(h.drive("r1", 40).is_none());
    assert_eq!(h.run("r1").detail.reason, Some(Reason::Raided));
}

/// 宛先の世代変更 before the send: the outputs stay at stock.
#[test]
fn destination_seized_before_send() {
    let mut h = H::new("gen-before");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..20 {
        if h.run("r1").state == RunState::FacilityConfirmed {
            break;
        }
        h.ex.tick().unwrap();
    }
    assert_eq!(h.run("r1").state, RunState::FacilityConfirmed);
    let dst = h.scene.dst;
    h.sim.with(|w| w.seize(&dst, OTHER));
    assert!(h.drive("r1", 20).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::DestinationChanged));
    assert_eq!(row.detail.ship_attempts, 0, "refused before signing");
    h.sim
        .with(|w| assert_eq!(w.stores(&h.scene.stock), crate::res_add(&r(1, 5), &r(6, 3))));
    h.audit();
}

/// 宛先の世代変更 in transit: the cargo is lost at settlement.
#[test]
fn destination_seized_in_transit() {
    let mut h = H::new("gen-transit");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let dst = h.scene.dst;
    h.sim.with(|w| w.seize(&dst, OTHER));
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::DestinationChanged));
    h.sim.with(|w| assert_eq!(w.stores(&h.scene.dst), ZERO));
    h.audit();
}

/// 期限切れ後の遅い応答: the facility use lands after the deadline but
/// within its validity. The run records it (truth wins), ships nothing and
/// expires with the outputs at stock.
#[test]
fn late_landing_after_deadline() {
    let mut h = H::new("late");
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LandLater(8)));
    let mut sp = spec("r1", &h.scene);
    sp.deadline_slot = 6;
    h.accept(&sp);
    assert!(h.drive("r1", 40).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Expired);
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 1, "it did land");
        assert_eq!(w.caravans.len(), 0, "nothing shipped after the deadline");
        assert_eq!(w.stores(&h.scene.stock), crate::res_add(&r(1, 5), &r(6, 3)));
    });
    assert!(h
        .ex
        .store
        .receipts("r1")
        .unwrap()
        .iter()
        .any(|r| r.kind == "facility_used"));
    let hist: Vec<String> =
        h.ex.store
            .history("r1")
            .unwrap()
            .into_iter()
            .map(|t| t.1)
            .collect();
    assert!(hist.contains(&"FacilityConfirmed".to_string()), "{hist:?}");
    h.audit();
}

/// 期限切れ: the late answer never lands (past its validity): expired with
/// the inputs untouched; nothing is signed after the deadline.
#[test]
fn expired_attempt_never_lands() {
    let mut h = H::new("late-never");
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LandLater(50)));
    let mut sp = spec("r1", &h.scene);
    sp.deadline_slot = 6;
    h.accept(&sp);
    assert!(h.drive("r1", 80).is_none());
    assert_eq!(h.run("r1").state, RunState::Expired);
    h.sim.with(|w| w.advance(60));
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 0);
        assert_eq!(w.stores(&h.scene.stock), r(1, 10));
    });
    assert_eq!(h.run("r1").detail.fac_attempts, 1);
    h.audit();
}

/// 取消と実行の競合 (1): cancel before anything is sent.
#[test]
fn cancel_before_send() {
    let mut h = H::new("cancel-early");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // Reserved
    h.ex.store.request_cancel("r1").unwrap();
    assert!(h.drive("r1", 10).is_none());
    assert_eq!(h.run("r1").state, RunState::Cancelled);
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), 0);
    assert_eq!(h.ex.store.reservations_of("r1").unwrap(), 0);
}

/// 取消と実行の競合 (2): the cancel lands between the executor's read and
/// its write: the write is refused, nothing is sent.
#[test]
fn cancel_races_the_send_write() {
    let mut h = H::new("cancel-race");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // Reserved
    let snapshot = h.run("r1");
    h.ex.store.request_cancel("r1").unwrap(); // after the executor's read
    let now = h.sim.with(|w| w.slot);
    assert!(!h.ex.step(&snapshot, now, &mut Default::default()).unwrap());
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), 0);
    assert!(h.drive("r1", 10).is_none());
    assert_eq!(h.run("r1").state, RunState::Cancelled);
}

/// 取消と実行の競合 (3): cancel while the facility request is in flight. It
/// cannot be recalled: the run waits for the decision, the use lands, and
/// the run stops there with the outputs at stock (nothing shipped).
#[test]
fn cancel_while_in_flight() {
    let mut h = H::new("cancel-flight");
    h.sim
        .with(|w| w.faults.send.push_back(SendFault::LandLater(3)));
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap();
    h.ex.tick().unwrap(); // in flight
    assert!(h.run("r1").state.in_flight());
    h.ex.store.request_cancel("r1").unwrap();
    assert!(h.drive("r1", 30).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Cancelled);
    h.sim.with(|w| {
        assert_eq!(w.effects("fac:r1"), 1);
        assert!(w.caravans.is_empty());
        assert_eq!(w.stores(&h.scene.stock), crate::res_add(&r(1, 5), &r(6, 3)));
    });
    h.audit();
}

/// A cancel in transit changes nothing (no recall): the run completes.
#[test]
fn cancel_in_transit_is_too_late() {
    let mut h = H::new("cancel-transit");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    h.ex.store.request_cancel("r1").unwrap();
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
}

/// Another send takes our pinned seq while ours did not land: ours is
/// refused (seq mismatch), the run re-pins after fresh checks, one caravan.
#[test]
fn seq_taken_by_another_send() {
    let mut h = H::new("seq");
    h.sim.with(|w| {
        w.faults.send.push_back(SendFault::Timeout); // facility goes through on rebroadcast
    });
    h.accept(&spec("r1", &h.scene));
    for _ in 0..20 {
        if h.run("r1").state == RunState::FacilityConfirmed {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(h.run("r1").state, RunState::FacilityConfirmed);
    // Our SendCaravan times out; the player sends by hand (seq taken).
    h.sim.with(|w| w.faults.send.push_back(SendFault::Timeout));
    h.ex.tick().unwrap();
    let pinned = h.run("r1").detail.ship_seq.unwrap();
    let other = h.scene.dst;
    let stock = h.scene.stock;
    h.sim.with(|w| w.manual_send(OWNER, stock, other, r(1, 1)));
    assert!(h.drive("r1", 120).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Fulfilled);
    assert_eq!(row.detail.ship_seq, Some(pinned + 1));
    assert_eq!(row.detail.ship_attempts, 2);
    h.sim.with(|w| {
        assert_eq!(
            w.effects(
                &CaravanKey {
                    owner: OWNER,
                    seq: pinned
                }
                .text()
            ),
            1,
            "the player's"
        );
        assert_eq!(
            w.effects(
                &CaravanKey {
                    owner: OWNER,
                    seq: pinned + 1
                }
                .text()
            ),
            1,
            "ours"
        );
    });
    h.audit();
    check_store(&h.ex.store);
}

/// 停止条件: every send times out; the run stops after `max_attempts` with
/// bounded sends and fees.
#[test]
fn attempts_are_bounded() {
    let mut h = H::new("bounded");
    h.sim.with(|w| {
        for _ in 0..200 {
            w.faults.send.push_back(SendFault::Timeout);
        }
    });
    h.accept(&spec("r1", &h.scene));
    assert!(h.drive("r1", 200).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::AttemptsExhausted));
    assert_eq!(row.detail.fac_attempts, 3);
    let book = h.ex.store.fees("r1").unwrap();
    assert_eq!(
        (book.charged, book.reserved, book.unconfirmed),
        (0, 0, 0),
        "nothing landed, nothing charged; every expired attempt released: {book:?}"
    );
    assert_eq!(book.released, 3 * 5_000);
    let sends = h.sim.with(|w| w.ledger.sends_received);
    assert!(
        sends <= 3 * 12,
        "sends bounded by attempts × rebroadcasts: {sends}"
    );
    h.audit();
}

/// 停止条件: a fee budget below one attempt.
#[test]
fn fee_budget_is_bounded() {
    let mut h = H::new("budget");
    let mut sp = spec("r1", &h.scene);
    sp.budget.max_fee = 7_000; // one 5_000 attempt fits, two do not
    h.accept(&sp);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Failed);
    assert_eq!(row.detail.reason, Some(Reason::BudgetExhausted));
    assert!(h.ex.store.fees("r1").unwrap().exposure() <= 7_000);
}

/// 停止条件: the canonical side is unreachable. A full outage stops the
/// tick (nothing decided); a partial one is counted per run and holds it.
#[test]
fn port_down_holds_then_resumes() {
    let mut h = H::new("down");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap();
    h.sim.with(|w| w.faults.down = true);
    for _ in 0..10 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert!(h.run("r1").held.is_none(), "no clock, no decision");
    h.sim.with(|w| {
        w.faults.down = false;
        w.faults.reads_down = true;
    });
    for _ in 0..20 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let row = h.run("r1");
    assert_eq!(row.held.as_deref(), Some("PortUnavailable"));
    assert_eq!(row.detail.port_errors, row.spec.budget.max_port_errors);
    h.sim.with(|w| w.faults.reads_down = false);
    assert!(h.ex.store.resume("r1").unwrap());
    assert!(h.drive("r1", 80).is_none());
    assert_fulfilled(&mut h, "r1");
}

/// A send to another player's place needs the wallet: held, outputs stay,
/// and the owner's other runs still ship (the seq is not kept pinned).
#[test]
fn send_to_another_player_is_held_for_the_wallet() {
    let mut h = H::new("wallet");
    let mut sp = spec("r1", &h.scene);
    sp.ship.dst = h.scene.other_place;
    h.accept(&sp);
    h.sim.with(|w| w.deposit(&h.scene.stock, &r(1, 5)));
    h.accept(&spec("r2", &h.scene));
    for _ in 0..80 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let row = h.run("r1");
    assert_eq!(row.held.as_deref(), Some("WalletRequired"));
    assert_eq!(
        row.state,
        RunState::FacilityConfirmed,
        "the owner's seq is not blocked"
    );
    assert_eq!(row.detail.ship_seq, None);
    assert_eq!(h.run("r2").state, RunState::Fulfilled);
    h.sim.with(|w| {
        assert!(w.stores(&h.scene.other_place) == ZERO);
        // r1's outputs stay at stock (r2's left).
        assert_eq!(w.stores(&h.scene.stock)[6], 3);
    });
    h.audit();
    // The person cancels it: it ends with the outputs at stock.
    h.ex.store.request_cancel("r1").unwrap();
    h.ex.store.resume("r1").unwrap();
    assert!(h.drive("r1", 10).is_none());
    assert_eq!(h.run("r1").state, RunState::Cancelled);
    check_store(&h.ex.store);
}

/// No status history, but the entity history shows the pinned seq made
/// another sender's caravan: re-pin (no hold), one caravan of ours.
#[test]
fn seq_taken_seen_in_entity_history() {
    let mut h = H::new("seq-history");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..20 {
        if h.run("r1").state == RunState::FacilityConfirmed {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    h.sim.with(|w| w.faults.send.push_back(SendFault::Timeout));
    h.ex.tick().unwrap(); // pins seq, times out
    let pinned = h.run("r1").detail.ship_seq.unwrap();
    let (stock, dst) = (h.scene.stock, h.scene.dst);
    h.sim.with(|w| {
        w.manual_send(OWNER, stock, dst, r(1, 1));
        w.faults.status_unavailable = true;
    });
    assert!(h.drive("r1", 120).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.held);
    assert_eq!(row.detail.ship_seq, Some(pinned + 1));
    h.audit();
}

/// A single read that cannot decide (the caravan absent, no settle record
/// yet: a lagging node) is looked at again, not held at once.
#[test]
fn transient_indeterminate_is_retried_not_held() {
    let mut h = H::new("transient");
    h.accept(&spec("r1", &h.scene));
    for _ in 0..40 {
        if h.run("r1").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    // It settles while the feed and the entity index are briefly missing.
    h.sim.with(|w| {
        w.advance(30);
        w.faults.history_unavailable = true;
        w.faults.pruned_before = w.log_len() as u64 + 1;
    });
    h.ex.tick().unwrap();
    h.ex.tick().unwrap();
    let row = h.run("r1");
    assert!(row.held.is_none());
    assert!(row.detail.unresolved >= 1);
    h.sim.with(|w| w.faults.history_unavailable = false);
    assert!(h.drive("r1", 20).is_none());
    assert_fulfilled(&mut h, "r1");
    assert_eq!(h.run("r1").detail.unresolved, 0);
}

#[test]
fn acceptance_is_idempotent() {
    let h = H::new("accept");
    let sp = spec("r1", &h.scene);
    h.accept(&sp);
    assert_eq!(
        h.ex.accept(&sp).unwrap(),
        Accept::Existing(RunState::Accepted)
    );
    let mut other = sp.clone();
    other.ship.cargo = r(6, 2);
    assert_eq!(h.ex.accept(&other).unwrap(), Accept::Conflict);
}

#[test]
fn every_state_has_an_ownership_row_and_terminal_states_are_final() {
    for s in RunState::ALL {
        let (own, _, _) = ownership(s);
        assert!(!own.is_empty());
        if s.terminal() {
            for t in RunState::ALL {
                assert!(!allowed(s, t), "{s:?} → {t:?}");
            }
        }
    }
    // No path skips confirmation: nothing reaches InTransit but from a ship
    // request, nothing reaches FacilityConfirmed but from a facility request.
    for s in RunState::ALL {
        if allowed(s, RunState::InTransit) && s != RunState::InTransit {
            assert!(matches!(
                s,
                RunState::ShipRequested | RunState::ShipSubmitted
            ));
        }
        if allowed(s, RunState::FacilityConfirmed) && s != RunState::FacilityConfirmed {
            assert!(matches!(
                s,
                RunState::FacilityRequested
                    | RunState::FacilitySubmitted
                    | RunState::ShipRequested
                    | RunState::ShipSubmitted
            ));
        }
    }
}

/// Moves past every attempt's validity and ticks, so the reconciliation
/// reads the fees of attempts no run waits on.
fn settle_fees(h: &mut H) {
    h.sim.with(|w| w.advance(w.validity + 2));
    for _ in 0..3 {
        h.ex.tick().unwrap();
    }
}

fn res_add(a: &Res, b: &Res) -> Res {
    runexec::model::res_add(a, b)
}
