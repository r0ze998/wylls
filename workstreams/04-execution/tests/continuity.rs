//! The world continues (2026-10-31 direction): runs cross war-period
//! boundaries and restarts with nothing lost, doubled or reset; today's
//! program, which ends the world at `end_bell`, is modelled only as LEGACY
//! (`legacy_end_slot`) to show what it does to work in flight; a store
//! belongs to one world. MOCK world (src/sim.rs).

mod common;

use common::*;
use runexec::model::*;
use runexec::store::{FeeBook, Store};

/// What a run ended as, everything that must not depend on boundaries.
#[derive(Debug, PartialEq)]
struct Seen {
    id: String,
    state: RunState,
    reason: Option<Reason>,
    delivered: Option<Option<Res>>,
    receipts: Vec<(String, String)>,
    fees: FeeBook,
}

/// Six runs over shared stock: two from the start, one waiting for an
/// inbound caravan, one to a holding, two started later (they cross the
/// first boundaries mid-flight). Drives them with `periods` (a boundary
/// every `n` slots) and, when `restart` is set, a new executor process at
/// every boundary (`other_id`: a different executor identity, which takes
/// the leases over after they expire).
fn season_free_run(
    periods: Option<u64>,
    restart: bool,
    other_id: bool,
) -> (Vec<Seen>, Vec<(String, Res)>, String) {
    let mut h = H::new(&format!(
        "continuity-{}-{restart}-{other_id}",
        periods.map_or("none".into(), |n| n.to_string())
    ));
    let home2 = holding(1, 1, 3);
    let src = vault(4, 4, 2);
    let inbound = h.sim.with(|w| {
        w.period_slots = periods;
        w.deposit(&h.scene.stock, &r(1, 15));
        w.add_place(home2, OWNER, ZERO, None);
        w.add_place(src, OWNER, r(1, 50), None);
        w.manual_send(OWNER, src, h.scene.stock, r(1, 5))
    });
    let mut specs = vec![];
    for i in 0..6 {
        let mut sp = spec(&format!("r{i}"), &h.scene);
        sp.deadline_slot = 600;
        if i == 2 {
            sp.inbound = Some(inbound);
        }
        if i == 3 {
            sp.ship.dst = home2;
        }
        specs.push(sp);
    }
    for sp in &specs[..4] {
        h.accept(sp);
    }
    let mut last_period = 0;
    for t in 0..400u64 {
        if t == 9 {
            for sp in &specs[4..] {
                h.accept(sp);
            }
        }
        let p = h.sim.with(|w| w.period_of(w.slot));
        if p != last_period {
            last_period = p;
            if restart {
                h.ex = executor(
                    &h.db,
                    &h.sim,
                    if other_id && p % 2 == 1 {
                        "exec-b"
                    } else {
                        "exec-a"
                    },
                );
            }
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
        if specs.iter().all(|s| h.run(&s.run_id).state.terminal()) && t > 20 {
            break;
        }
    }
    h.audit();
    check_store(&h.ex.store);
    let seen = specs
        .iter()
        .map(|s| {
            let row = h.run(&s.run_id);
            let mut receipts: Vec<(String, String)> =
                h.ex.store
                    .receipts(&s.run_id)
                    .unwrap()
                    .into_iter()
                    .map(|r| (r.kind, r.subject))
                    .collect();
            receipts.sort();
            Seen {
                id: s.run_id.clone(),
                state: row.state,
                reason: row.detail.reason.clone(),
                delivered: row.detail.outcome.map(|o| o.delivered),
                receipts,
                fees: h.ex.store.fees(&s.run_id).unwrap(),
            }
        })
        .collect();
    let stores = [h.scene.stock, h.scene.dst, home2, src]
        .iter()
        .map(|p| (p.slot_key(), h.sim.with(|w| w.stores(p))))
        .collect();
    let effects = h.sim.with(|w| format!("{:?}", w.ledger.effects));
    (seen, stores, effects)
}

/// War-period boundaries every 7 slots, a restart at each, with the same
/// or another executor identity: the same outcomes, receipts, fees, goods
/// and canonical effects (each at most once) as a world without periods.
#[test]
fn boundaries_and_restarts_change_nothing() {
    let control = season_free_run(None, false, false);
    assert!(
        control.0.iter().all(|s| s.state.terminal()),
        "{:?}",
        control.0
    );
    assert!(
        control
            .0
            .iter()
            .filter(|s| s.state == RunState::Fulfilled)
            .count()
            >= 4,
        "{:?}",
        control.0
    );
    for (restart, other) in [(false, false), (true, false), (true, true)] {
        let run = season_free_run(Some(7), restart, other);
        assert_eq!(
            run.0, control.0,
            "outcomes (restart {restart}, other {other})"
        );
        assert_eq!(run.1, control.1, "goods at every place");
        assert_eq!(run.2, control.2, "canonical effects");
    }
}

/// LEGACY: today's program closes player actions at `end_bell`. A caravan
/// already on the road still settles and its run completes; a run that has
/// not used the facility yet is held WorldClosed in Reserved — not failed,
/// nothing used, its inputs still at stock, nobody blamed. When the world
/// takes actions again (a migration that keeps the world), it resumes.
#[test]
fn legacy_world_end_holds_unstarted_work_and_settles_the_road() {
    let mut h = H::new("continuity-legacy-end");
    h.accept(&spec("early", &h.scene));
    // Drive "early" onto the road.
    for _ in 0..40 {
        if h.run("early").state == RunState::InTransit {
            break;
        }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(h.run("early").state, RunState::InTransit);
    let end = h.sim.with(|w| w.slot);
    h.sim.with(|w| w.legacy_end_slot = Some(end));
    let stock_before = h.sim.with(|w| w.stores(&h.scene.stock));
    h.accept(&spec("late", &h.scene));
    assert!(h.drive("early", 80).is_none());
    assert_eq!(
        h.run("early").state,
        RunState::Fulfilled,
        "the road settles after the end"
    );
    assert!(h.drive("late", 80).is_none());
    let late = h.run("late");
    assert_eq!(late.state, RunState::Reserved);
    assert_eq!(late.held.as_deref(), Some("WorldClosed"));
    assert_eq!(late.detail.outcome, None, "no outcome: nothing happened");
    assert_eq!(
        h.sim.with(|w| w.stores(&h.scene.stock)),
        stock_before,
        "inputs untouched"
    );
    assert_eq!(h.sim.with(|w| w.effects("fac:late")), 0);
    // The world takes actions again: resume completes it.
    h.sim.with(|w| w.legacy_end_slot = None);
    assert!(h.ex.store.resume("late").unwrap());
    assert!(h.drive("late", 120).is_none());
    assert_eq!(h.run("late").state, RunState::Fulfilled);
    h.audit();
    check_store(&h.ex.store);
}

/// A store belongs to one world: every key, seq and run in it means
/// something only there. Opened against another world, the executor does
/// nothing and says so; the runs stay as they were.
#[test]
fn a_store_is_never_applied_to_another_world() {
    let mut h = H::new("continuity-world");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap();
    let before = h.run("r1");
    assert_eq!(h.ex.store.world().unwrap().as_deref(), Some("sim-world-1"));
    h.sim.with(|w| w.world = "sim-world-2".into());
    h.restart();
    for _ in 0..30 {
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let after = h.run("r1");
    assert_eq!((after.state, after.version), (before.state, before.version));
    assert!(h
        .ex
        .store
        .alerts()
        .unwrap()
        .iter()
        .any(|a| a.2 == "world_mismatch"));
    // Back on its own world it continues.
    h.sim.with(|w| w.world = "sim-world-1".into());
    h.restart();
    assert!(h.drive("r1", 120).is_none());
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
}

/// Long-run growth, separately from the boundary: the query that picks the
/// due runs reads an index over open runs only, so finished runs piling up
/// over years do not make every tick scan them.
#[test]
fn finished_runs_do_not_slow_the_due_query() {
    let db = db_path("continuity-growth");
    let store = Store::open(&db).unwrap();
    let plan = store.explain_due().unwrap();
    assert!(plan.contains("runs_open_due"), "{plan}");
    assert!(!plan.contains("SCAN runs"), "{plan}");
}
