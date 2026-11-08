//! The test harness: a simulated world (MOCK), a store on disk, executors
//! that can be stopped and restarted on it.
#![allow(dead_code)]

pub mod passnode;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use frontier_abi::v2::layout::s1::place::{KIND_HOLDING, KIND_VAULT};
use runexec::executor::{CrashPlan, Executor, Halt};
use runexec::model::*;
use runexec::sim::{Sim, SimWorld};
use runexec::store::{RunRow, Store};

pub const OWNER: u64 = 0x77;
pub const OTHER: u64 = 0x99;
pub const RAIDER: u64 = 0x55;

pub fn holding(p: i16, q: i16, site: u8) -> PlaceRef {
    PlaceRef {
        kind: KIND_HOLDING,
        p,
        q,
        at: site,
        gen: 1,
    }
}
pub fn vault(p: i16, q: i16, tile: u8) -> PlaceRef {
    PlaceRef {
        kind: KIND_VAULT,
        p,
        q,
        at: tile,
        gen: 1,
    }
}

pub fn r(i: usize, n: u64) -> Res {
    let mut x = ZERO;
    x[i] = n;
    x
}

static N: AtomicU64 = AtomicU64::new(0);

pub fn db_path(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("runexec-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(format!(
        "{name}-{}-{}.sqlite",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", p.display()));
    }
    p
}

/// The standard scene: the owner's holding `stock` with iron, another
/// player's facility (a forge) the owner holds a right to, the owner's
/// vault `dst` two provinces away, and the raider's holding.
pub struct Scene {
    pub stock: PlaceRef,
    pub facility: FacilityRef,
    pub dst: PlaceRef,
    pub raider_home: PlaceRef,
    pub other_place: PlaceRef,
}

pub fn scene(w: &mut SimWorld) -> Scene {
    let s = Scene {
        stock: holding(0, 0, 1),
        facility: FacilityRef {
            place: holding(0, 1, 2),
            recipe: 1,
        },
        dst: vault(1, 0, 5),
        raider_home: holding(3, 3, 1),
        other_place: holding(2, 2, 1),
    };
    w.add_place(s.stock, OWNER, r(1, 10), None);
    w.add_place(s.facility.place, OTHER, ZERO, None);
    w.add_place(s.dst, OWNER, ZERO, Some(1_000));
    w.add_place(s.raider_home, RAIDER, ZERO, None);
    w.add_place(s.other_place, OTHER, ZERO, None);
    w.grant(OWNER, s.facility, 10, 10_000);
    s
}

/// 5 iron → 3 weapons, ship the 3 weapons to the vault.
pub fn spec(id: &str, s: &Scene) -> RunSpec {
    RunSpec {
        run_id: id.to_string(),
        owner: OWNER,
        stock: s.stock,
        inbound: None,
        facility: Some(s.facility),
        inputs: r(1, 5),
        outputs: r(6, 3),
        rights_units: 1,
        ship: ShipSpec {
            dst: s.dst,
            cargo: r(6, 3),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    }
}

pub struct H {
    pub sim: Sim,
    pub db: PathBuf,
    pub ex: Executor<Sim, Sim>,
    pub scene: Scene,
}

pub fn executor(db: &Path, sim: &Sim, id: &str) -> Executor<Sim, Sim> {
    Executor::new(id, Store::open(db).unwrap(), sim.clone(), sim.clone())
}

impl H {
    pub fn new(name: &str) -> H {
        let mut w = SimWorld::new();
        let scene = scene(&mut w);
        let sim = Sim::new(w);
        let db = db_path(name);
        let ex = executor(&db, &sim, "exec-a");
        H { sim, db, ex, scene }
    }

    pub fn accept(&self, spec: &RunSpec) {
        assert_eq!(
            self.ex.accept(spec).unwrap(),
            runexec::store::Accept::Created
        );
    }

    /// A process restart: a new executor (same identity) on the same store.
    /// Its lease is still valid, so it continues at once.
    pub fn restart(&mut self) {
        self.ex = executor(&self.db, &self.sim, "exec-a");
    }

    pub fn run(&self, id: &str) -> RunRow {
        self.ex.store.load(id).unwrap().unwrap()
    }

    /// Ticks and advances the world one slot at a time until the run is
    /// terminal or held, or `max` ticks. Returns the halt of a crash.
    pub fn drive(&mut self, id: &str, max: u32) -> Option<Halt> {
        for _ in 0..max {
            let r = self.run(id);
            if r.state.terminal() || r.held.is_some() {
                return None;
            }
            if let Err(h) = self.ex.tick() {
                return Some(h);
            }
            self.sim.with(|w| w.advance(1));
        }
        None
    }

    pub fn crash_at(&mut self, point: &'static str, nth: u32) {
        self.ex.crash = Some(CrashPlan::at(point, nth));
    }

    pub fn audit(&self) {
        self.sim.with(|w| w.audit()).unwrap();
    }

    pub fn ship_key(&self, id: &str) -> String {
        CaravanKey {
            owner: OWNER,
            seq: self.run(id).detail.ship_seq.expect("seq"),
        }
        .text()
    }
}

/// Every recorded transition is in the run's table (`allowed_for`: a
/// cargo-only run has its own) and a terminal run holds no reservation
/// (checked over a whole store).
pub fn check_store(store: &Store) {
    for id in store.run_ids().unwrap() {
        let row = store.load(&id).unwrap().unwrap();
        for (from, to, _, _) in store.history(&id).unwrap() {
            let (f, t) = (
                RunState::parse(&from).unwrap(),
                RunState::parse(&to).unwrap(),
            );
            assert!(allowed_for(&row.spec, f, t), "{id}: {from} → {to}");
        }
        if row.state.terminal() {
            assert_eq!(
                store.reservations_of(&id).unwrap(),
                0,
                "{id} holds reservations"
            );
        }
        assert!(
            store.fees(&id).unwrap().exposure() <= row.spec.budget.max_fee,
            "{id}: fees over budget"
        );
        assert!(row.detail.fac_attempts <= row.spec.budget.max_attempts);
        assert!(row.detail.ship_attempts <= row.spec.budget.max_attempts);
    }
}
