//! 複数実行者が同時に同じ処理を拾う場合 (MOCK world, real SQLite store
//! shared by several connections and threads).

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use common::*;
use runexec::executor::{CrashPlan, Halt};
use runexec::model::*;
use runexec::ports::Chain;
use runexec::sim::{SendFault, Sim, SimWorld};
use runexec::store::{Step, Store};

/// Two executors tick at the same slot: one holds the lease, the other
/// does nothing with that run.
#[test]
fn second_executor_cannot_claim_a_held_lease() {
    let mut h = H::new("claim");
    h.accept(&spec("r1", &h.scene));
    let mut b = executor(&h.db, &h.sim, "exec-b");
    let ra = h.ex.tick().unwrap();
    let rb = b.tick().unwrap();
    assert_eq!(ra.stepped, 1);
    assert_eq!(rb.stepped, 0, "B stepped a run A holds");
    // A stops; after the lease runs out B takes over and finishes.
    h.sim.with(|w| w.advance(20));
    for _ in 0..80 {
        if h.run("r1").state.terminal() {
            break;
        }
        b.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    let hist = h.ex.store.history("r1").unwrap();
    assert!(hist.iter().any(|t| t.2 == "exec-a") && hist.iter().any(|t| t.2 == "exec-b"));
    h.audit();
}

/// A zombie: A journals its facility attempt and stalls before sending;
/// its lease runs out; B takes over (re-broadcasting the same bytes) and
/// moves on. Then A wakes, sends its bytes and tries to write: the send is
/// a no-op (same signature) and the write is fenced.
#[test]
fn zombie_executor_is_fenced() {
    let mut h = H::new("zombie");
    h.accept(&spec("r1", &h.scene));
    h.ex.crash = Some(CrashPlan::at("facility.before_send", 1));
    h.ex.tick().unwrap(); // Reserved
    assert_eq!(
        h.ex.tick().err(),
        Some(Halt::Crashed("facility.before_send"))
    );
    let a_snapshot = h.run("r1");
    let journalled = h.ex.store.attempts("r1", Step::Facility).unwrap();
    assert_eq!(journalled.len(), 1);
    assert_eq!(journalled[0].status, "intent");
    h.sim.with(|w| w.advance(9)); // lease (8) runs out, attempt still valid
    let mut b = executor(&h.db, &h.sim, "exec-b");
    for _ in 0..80 {
        if h.run("r1").state.terminal() {
            break;
        }
        b.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    // A wakes up late.
    let _ = h.sim.send(&journalled[0].prepared);
    let now = h.sim.with(|w| w.slot);
    let mut rep = Default::default();
    h.ex.crash = None;
    assert!(
        !h.ex.step(&a_snapshot, now, &mut rep).unwrap(),
        "zombie write accepted"
    );
    assert_eq!(h.run("r1").state, RunState::Fulfilled);
    h.sim.with(|w| assert_eq!(w.effects("fac:r1"), 1));
    h.audit();
    check_store(&h.ex.store);
}

/// Two processes misconfigured with the same executor id: the second
/// takes the lapsed lease (same name, new epoch); the first one's write
/// from its old snapshot is refused even though no version moved.
#[test]
fn same_executor_id_twice_is_fenced_by_epoch() {
    let mut h = H::new("same-id");
    h.accept(&spec("r1", &h.scene));
    h.ex.tick().unwrap(); // A: Reserved
    let a_snapshot = h.run("r1");
    h.sim.with(|w| w.advance(20)); // A's lease lapses
    let b = executor(&h.db, &h.sim, "exec-a");
    let now = h.sim.with(|w| w.slot);
    assert!(b.store.claim("r1", "exec-a", now, 8).unwrap());
    let after = h.run("r1");
    assert_eq!(after.version, a_snapshot.version, "no write yet");
    assert_eq!(after.lease_epoch, a_snapshot.lease_epoch + 1);
    let sends = h.sim.with(|w| w.ledger.sends_received);
    assert!(!h
        .ex
        .step(&a_snapshot, now, &mut Default::default())
        .unwrap());
    assert_eq!(h.sim.with(|w| w.ledger.sends_received), sends);
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

/// One world, `runs` runs, `n` executor threads with their own store
/// connections, lossy sends, a feed that duplicates and reverses, and
/// (optionally) a canceller. Returns the db path and the sim.
fn stress(
    name: &str,
    runs: usize,
    n: usize,
    cancel: bool,
    seed: u64,
) -> (std::path::PathBuf, Sim, Vec<String>) {
    let mut w = SimWorld::new();
    let s = scene(&mut w);
    w.grant(OWNER, s.facility, 1_000, 1_000_000);
    w.faults.feed_duplicates = true;
    w.faults.feed_reversed = true;
    // The clock here runs ~2,000 slots a second against loaded threads; a
    // validity of 60 slots keeps Solana's ratio of validity (151 slots) to
    // tick cadence (≈ 1 slot) roughly. With 10 a stalled thread lets every
    // attempt expire and the run correctly stops at its attempt budget.
    w.validity = 60;
    let mut rng = Lcg(seed);
    for _ in 0..runs * 2 {
        w.faults.send.push_back(match rng.next() % 6 {
            0 => SendFault::LoseResponse,
            1 => SendFault::Timeout,
            2 => SendFault::LandLater(1 + rng.next() % 4),
            _ => SendFault::LandLater(0),
        });
    }
    let mut ids = vec![];
    let mut specs = vec![];
    for i in 0..runs {
        let stock = holding(10 + i as i16, 0, 1);
        w.add_place(stock, OWNER, r(1, 5), None);
        let mut sp = spec(&format!("s{i:02}"), &s);
        sp.stock = stock;
        sp.deadline_slot = 2_000;
        ids.push(sp.run_id.clone());
        specs.push(sp);
    }
    let sim = Sim::new(w);
    let db = db_path(name);
    {
        let ex = executor(&db, &sim, "setup");
        for sp in &specs {
            ex.accept(sp).unwrap();
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = vec![];
    for k in 0..n {
        let (db, sim, stop) = (db.clone(), sim.clone(), stop.clone());
        threads.push(thread::spawn(move || {
            let mut ex = executor(&db, &sim, &format!("exec-{k}"));
            ex.params.lease = 3;
            // Few runs per tick, so the work spreads over the executors.
            ex.params.max_runs_per_tick = 2;
            let mut rng = Lcg(seed ^ (k as u64 + 1));
            let mut ticks = 0u64;
            while !stop.load(Ordering::SeqCst) {
                ex.tick().expect("tick");
                ticks += 1;
                // Stall now and then, long enough for a lease to lapse.
                if rng.next() % 10 == 0 {
                    thread::sleep(Duration::from_millis(3));
                }
            }
            ticks
        }));
    }
    let canceller = cancel.then(|| {
        let (db, ids, stop) = (db.clone(), ids.clone(), stop.clone());
        thread::spawn(move || {
            let store = Store::open(&db).unwrap();
            let mut rng = Lcg(seed ^ 0xC0FFEE);
            let mut picks: Vec<(String, u64)> = vec![];
            for id in &ids {
                if rng.next() % 2 == 0 {
                    picks.push((id.clone(), rng.next() % 4_000));
                }
            }
            for (id, wait) in &picks {
                thread::sleep(Duration::from_micros(*wait));
                store.request_cancel(id).unwrap();
                if stop.load(Ordering::SeqCst) {
                    break;
                }
            }
        })
    });
    // The clock.
    let store = Store::open(&db).unwrap();
    for _ in 0..4_000 {
        thread::sleep(Duration::from_micros(500));
        sim.with(|w| w.advance(1));
        let open = ids
            .iter()
            .filter(|id| {
                let r = store.load(id).unwrap().unwrap();
                !r.state.terminal() && r.held.is_none()
            })
            .count();
        if open == 0 {
            break;
        }
    }
    stop.store(true, Ordering::SeqCst);
    let ticks: Vec<u64> = threads
        .into_iter()
        .map(|t| t.join().expect("executor thread"))
        .collect();
    if let Some(c) = canceller {
        c.join().unwrap();
    }
    assert!(ticks.iter().all(|&t| t > 0));
    (db, sim, ids)
}

#[test]
fn many_executors_many_runs() {
    let (db, sim, ids) = stress("stress", 16, 4, false, 7);
    let store = Store::open(&db).unwrap();
    let mut executors = std::collections::BTreeSet::new();
    for id in &ids {
        let row = store.load(id).unwrap().unwrap();
        assert_eq!(
            row.state,
            RunState::Fulfilled,
            "{id}: {:?} held {:?}",
            row.detail.reason,
            row.held
        );
        for t in store.history(id).unwrap() {
            executors.insert(t.2);
        }
        sim.with(|w| assert_eq!(w.effects(&format!("fac:{id}")), 1));
    }
    // How the work spread is up to the scheduler (≈ 1 run in 40 one thread
    // wins every claim); the hand-over itself is asserted deterministically
    // by `second_executor_cannot_claim_a_held_lease` and
    // `zombie_executor_is_fenced`. Reported, not asserted.
    eprintln!("executors that wrote transitions: {executors:?}");
    sim.with(|w| {
        w.audit().unwrap();
        assert_eq!(w.stores(&vault(1, 0, 5)), r(6, 3 * ids.len() as u64));
    });
    check_store(&store);
}

#[test]
fn cancels_race_executors() {
    let (mut cancelled, mut fulfilled, mut cancelled_after_facility) = (0, 0, 0);
    for seed in [3, 11, 29] {
        let (db, sim, ids) = stress("cancel-stress", 12, 3, true, seed);
        let store = Store::open(&db).unwrap();
        for id in &ids {
            let row = store.load(id).unwrap().unwrap();
            assert!(row.state.terminal(), "{id}: {:?}", row.state);
            let ships = store.attempts(id, Step::Ship).unwrap();
            // Our own landed SendCaravans (seqs are shared by every run of
            // the owner, so a key alone would also count another run's).
            let shipped = ships
                .iter()
                .filter(|a| sim.with(|w| w.took_effect(&a.prepared.sig)))
                .count();
            match row.state {
                RunState::Cancelled => {
                    assert_eq!(shipped, 0, "{id}: cancelled yet shipped");
                    cancelled += 1;
                    if sim.with(|w| w.effects(&format!("fac:{id}"))) == 1 {
                        cancelled_after_facility += 1;
                    }
                }
                RunState::Fulfilled => {
                    fulfilled += 1;
                    assert_eq!(shipped, 1);
                    assert_eq!(sim.with(|w| w.effects(&format!("fac:{id}"))), 1);
                }
                s => panic!(
                    "{id}: {s:?} {:?}\n{:#?}\n{:#?}",
                    row.detail,
                    store.history(id).unwrap(),
                    store
                        .attempts(id, Step::Ship)
                        .unwrap()
                        .iter()
                        .map(|a| (
                            a.request_key.clone(),
                            a.status.clone(),
                            a.prepared.valid_until
                        ))
                        .collect::<Vec<_>>()
                ),
            }
        }
        sim.with(|w| w.audit()).unwrap();
        check_store(&store);
    }
    eprintln!("cancelled {cancelled} (after the facility: {cancelled_after_facility}), fulfilled {fulfilled}");
    assert!(cancelled > 0 && fulfilled > 0, "the race was not exercised");
}
