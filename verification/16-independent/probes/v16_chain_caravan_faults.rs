//! ⑯ independent check of ④'s chain flow, stage B, under faults (place in
//! workstreams/04-execution/tests/). The same caravan as `chain_caravan.rs`
//! (the NFT pass's Citizen from stage A's committed output
//! `tools/chain-flow/fixtures-20261106/a-join.json`), driven through the run
//! executor on the simulated world (MOCK chain) with: a duplicate and a
//! conflicting acceptance, a lost send answer, a send timeout, a late
//! landing, a crash just before the send with a restart, and a feed that
//! repeats every record. The measure is the world, not the executor's view:
//! exactly 4 units arrive, one caravan_sent and one caravan_settled receipt.
//! No key is generated, derived or signed (the simulated chain takes no
//! signatures); no PDA is computed here.
mod common;
use common::*;
use runexec::executor::CrashPlan;
use runexec::model::*;
use runexec::sim::{SendFault, Sim, SimWorld};
use runexec::store::Accept;

fn chain_citizen() -> (u64, String) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/chain-flow/fixtures-20261106/a-join.json");
    let a: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    let tag: u64 = a["citizen_tag"].as_str().unwrap().parse().unwrap();
    (tag, format!("game:{}/season:{}", a["program"].as_str().unwrap(), a["season"].as_str().unwrap()))
}

struct Case {
    sim: Sim,
    db: std::path::PathBuf,
    spec: RunSpec,
    dst: PlaceRef,
}

fn case(name: &str, f: impl FnOnce(&mut SimWorld)) -> Case {
    let (tag, world) = chain_citizen();
    let mut w = SimWorld::new();
    w.world = world;
    let stock = holding(0, 0, 1);
    let dst = vault(1, 0, 5);
    w.add_place(stock, tag, r(1, 10), None);
    w.add_place(dst, tag, ZERO, Some(1_000));
    f(&mut w);
    let spec = RunSpec {
        run_id: "chain-1".into(),
        owner: tag,
        stock,
        inbound: None,
        facility: None,
        inputs: ZERO,
        outputs: ZERO,
        rights_units: 0,
        ship: ShipSpec { dst, cargo: r(1, 4) },
        deadline_slot: 400,
        budget: Budget::default(),
    };
    Case { sim: Sim::new(w), db: db_path(name), spec, dst }
}

fn drive(ex: &mut runexec::executor::Executor<Sim, Sim>, sim: &Sim, max: u32) -> bool {
    for _ in 0..max {
        let row = ex.store.load("chain-1").unwrap().unwrap();
        if row.state.terminal() || row.held.is_some() {
            return true;
        }
        if ex.tick().is_err() {
            return false;
        }
        sim.with(|w| w.advance(1));
    }
    true
}

fn outcome(c: &Case, ex: &runexec::executor::Executor<Sim, Sim>) {
    let row = ex.store.load("chain-1").unwrap().unwrap();
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.detail);
    c.sim.with(|w| {
        assert_eq!(w.stores(&c.dst), r(1, 4), "exactly one delivery arrived");
        w.audit().unwrap();
    });
    let rs = ex.store.receipts("chain-1").unwrap();
    let n = |k: &str| rs.iter().filter(|r| r.kind == k).count();
    assert_eq!((n("caravan_sent"), n("caravan_settled")), (1, 1), "receipts: {:?}", rs.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>());
    check_store(&ex.store);
}

#[test]
fn v16_b1_duplicate_and_conflicting_acceptance() {
    let c = case("v16-b1", |_| {});
    let mut ex = executor(&c.db, &c.sim, "exec-v16");
    assert_eq!(ex.accept(&c.spec).unwrap(), Accept::Created);
    assert!(matches!(ex.accept(&c.spec).unwrap(), Accept::Existing(_)), "same run id, same spec");
    let mut other = c.spec.clone();
    other.ship.cargo = r(1, 5);
    assert_eq!(ex.accept(&other).unwrap(), Accept::Conflict, "same run id, another spec");
    assert!(drive(&mut ex, &c.sim, 120));
    assert!(matches!(ex.accept(&c.spec).unwrap(), Accept::Existing(RunState::Fulfilled)), "re-asked after it finished");
    outcome(&c, &ex);
}

#[test]
fn v16_b2_lost_answer_timeout_and_late_landing_send_once() {
    for (i, fault) in [SendFault::LoseResponse, SendFault::Timeout, SendFault::LandLater(3)].into_iter().enumerate() {
        let c = case(&format!("v16-b2-{i}"), |w| w.faults.send.push_back(fault.clone()));
        let mut ex = executor(&c.db, &c.sim, "exec-v16");
        assert_eq!(ex.accept(&c.spec).unwrap(), Accept::Created);
        assert!(drive(&mut ex, &c.sim, 200), "{fault:?}");
        outcome(&c, &ex);
    }
}

#[test]
fn v16_b3_crash_before_the_send_then_restart() {
    let c = case("v16-b3", |_| {});
    let mut ex = executor(&c.db, &c.sim, "exec-v16");
    assert_eq!(ex.accept(&c.spec).unwrap(), Accept::Created);
    ex.crash = Some(CrashPlan::at("ship.before_send", 1));
    assert!(!drive(&mut ex, &c.sim, 120), "the planned crash happens");
    drop(ex);
    let mut ex = executor(&c.db, &c.sim, "exec-v16"); // a new process on the same store
    assert!(drive(&mut ex, &c.sim, 200));
    outcome(&c, &ex);
}

#[test]
fn v16_b4_a_feed_that_repeats_every_record_counts_once() {
    let c = case("v16-b4", |w| w.faults.feed_duplicates = true);
    let mut ex = executor(&c.db, &c.sim, "exec-v16");
    assert_eq!(ex.accept(&c.spec).unwrap(), Accept::Created);
    assert!(drive(&mut ex, &c.sim, 200));
    outcome(&c, &ex);
}
