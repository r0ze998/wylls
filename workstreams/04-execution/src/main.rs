//! `runexec`: the operator's tool over a run store, and a demo against the
//! simulated world (MOCK). There is no adapter to the real chain yet: the
//! executor loop runs only against `sim` (`README.ja.md`, 実チェーン: 未実行).
//!
//! ```text
//! runexec demo   --db <path> [--scenario happy|lost-response|crash|raid]
//! runexec status --db <path> [--slot <n>]
//! runexec show   --db <path> --run <id>
//! runexec cancel --db <path> --run <id>
//! runexec resume --db <path> --run <id>
//! ```

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runexec::executor::{CrashPlan, Executor};
use runexec::model::*;
use runexec::sim::{SendFault, Sim, SimWorld};
use runexec::store::Store;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1).map(String::as_str) else {
        eprintln!("usage: runexec demo|status|show|cancel|resume --db <path> [...]");
        return ExitCode::from(2);
    };
    let Some(db) = arg(&args, "--db").map(PathBuf::from) else {
        eprintln!("--db <path> is required");
        return ExitCode::from(2);
    };
    let r = match cmd {
        "demo" => demo(&db, arg(&args, "--scenario").as_deref().unwrap_or("happy")),
        "status" => Store::open(&db).and_then(|s| {
            let slot = arg(&args, "--slot")
                .and_then(|x| x.parse().ok())
                .unwrap_or(0);
            println!(
                "{}",
                serde_json::to_string_pretty(&s.status(slot)?).unwrap()
            );
            Ok(())
        }),
        "show" => with_run(&args, &db, show),
        "cancel" => with_run(&args, &db, |s, id| {
            let st = s.request_cancel(id)?.ok_or("no such run")?;
            println!(
                "cancel requested; {id} is {} (a send in flight is decided first; in transit nothing can be recalled)",
                st.name()
            );
            Ok(())
        }),
        "resume" => with_run(&args, &db, |s, id| {
            if s.resume(id)? {
                println!("{id} resumed");
            } else {
                println!("{id} was not held");
            }
            Ok(())
        }),
        _ => Err(format!("unknown command {cmd}")),
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn with_run(
    args: &[String],
    db: &Path,
    f: impl FnOnce(&Store, &str) -> Result<(), String>,
) -> Result<(), String> {
    let id = arg(args, "--run").ok_or("--run <id> is required")?;
    let s = Store::open(db)?;
    f(&s, &id)
}

fn show(s: &Store, id: &str) -> Result<(), String> {
    let r = s.load(id)?.ok_or("no such run")?;
    println!(
        "run {id}: {} (version {}, held {:?}, cancel {})",
        r.state.name(),
        r.version,
        r.held,
        r.cancel_requested
    );
    println!("detail: {}", serde_json::to_string(&r.detail).unwrap());
    let (own, res, back) = ownership(r.state);
    println!("owns: {own}\nreserved: {res}\ngives back: {back}");
    println!("transitions:");
    for (from, to, by, why) in s.history(id)? {
        println!("  {from} → {to}  [{by}] {why}");
    }
    for step in [runexec::store::Step::Facility, runexec::store::Step::Ship] {
        for a in s.attempts(id, step)? {
            println!(
                "attempt {:?} {} {} valid≤{} {}",
                step,
                a.request_key,
                &a.prepared.sig[..12],
                a.prepared.valid_until,
                a.status
            );
        }
    }
    println!("receipts (evidence of past events, not of current stock):");
    for rc in s.receipts(id)? {
        println!(
            "  {} {} @{} from {}",
            rc.kind, rc.subject, rc.slot, rc.source
        );
    }
    Ok(())
}

/// A scripted run against the simulated world. Prints `MOCK` so nobody
/// mistakes it for a chain run.
fn demo(db: &Path, scenario: &str) -> Result<(), String> {
    use frontier_abi::v2::layout::s1::place::{KIND_HOLDING, KIND_VAULT};
    println!("MOCK: simulated canonical world (no chain, no ② rights service)");
    let p = |kind, p, q, at| PlaceRef {
        kind,
        p,
        q,
        at,
        gen: 1,
    };
    let (stock, fac, dst, home) = (
        p(KIND_HOLDING, 0, 0, 1),
        FacilityRef {
            place: p(KIND_HOLDING, 0, 1, 2),
            recipe: 1,
        },
        p(KIND_VAULT, 1, 0, 5),
        p(KIND_HOLDING, 3, 3, 1),
    );
    let one = |i: usize, n: u64| {
        let mut x = ZERO;
        x[i] = n;
        x
    };
    let mut w = SimWorld::new();
    w.add_place(stock, 0x77, one(1, 10), None);
    w.add_place(fac.place, 0x99, ZERO, None);
    w.add_place(dst, 0x77, ZERO, Some(1_000));
    w.add_place(home, 0x55, ZERO, None);
    w.grant(0x77, fac, 5, 10_000);
    match scenario {
        "lost-response" => {
            w.faults.send.push_back(SendFault::LoseResponse);
            w.faults.send.push_back(SendFault::LoseResponse);
        }
        "happy" | "crash" | "raid" => {}
        s => return Err(format!("unknown scenario {s}")),
    }
    let sim = Sim::new(w);
    let open = || -> Result<Executor<Sim, Sim>, String> {
        Ok(Executor::new(
            "demo",
            Store::open(db)?,
            sim.clone(),
            sim.clone(),
        ))
    };
    let mut ex = open()?;
    if scenario == "crash" {
        ex.crash = Some(CrashPlan::at("ship.after_send", 1));
    }
    let spec = RunSpec {
        run_id: format!("demo-{scenario}"),
        owner: 0x77,
        stock,
        inbound: None,
        facility: fac,
        inputs: one(1, 5),
        outputs: one(6, 3),
        rights_units: 1,
        ship: ShipSpec {
            dst,
            cargo: one(6, 3),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    };
    println!("accept: {:?}", ex.accept(&spec)?);
    let id = spec.run_id.clone();
    for _ in 0..120 {
        let row = ex.store.load(&id)?.ok_or("vanished")?;
        if row.state.terminal() || row.held.is_some() {
            break;
        }
        if scenario == "raid" && row.state == RunState::InTransit && row.detail.raid.is_none() {
            let key = CaravanKey {
                owner: 0x77,
                seq: row.detail.ship_seq.unwrap(),
            };
            if sim.with(|w| {
                w.caravans
                    .get(&(key.owner, key.seq))
                    .is_some_and(|c| c.owner_now == 0x77)
            }) {
                sim.with(|w| w.raid(key, true, 0x55, home));
                println!("MOCK: the caravan {} is raided (take)", key.text());
            }
        }
        if let Err(h) = ex.tick() {
            println!("stopped: {h:?}; restarting the executor on the same store");
            ex = open()?;
        }
        sim.with(|w| w.advance(1));
    }
    show(&ex.store, &id)?;
    sim.with(|w| w.audit())?;
    println!("MOCK audit: conservation and once-only effects hold");
    let slot = sim.with(|w| w.slot);
    println!(
        "{}",
        serde_json::to_string_pretty(&ex.store.status(slot)?).unwrap()
    );
    Ok(())
}
