//! Plans of a resident's local orders (src/plans.rs): the store as the
//! executor of a multi-turn plan, through restarts, a second process and
//! chain refusals. Literal specs, temp SQLite files; no key, nothing sent.

use std::path::PathBuf;
use std::process::Command;

use runexec::plans::{self, PlanErr};
use runexec::store::Store;
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_runexec");
const SIG_A: &str = "5VERYLONGSIGNATUREaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIG_B: &str = "5VERYLONGSIGNATUREbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIG_C: &str = "5VERYLONGSIGNATUREccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn db(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("runexec-plans-{}-{name}.sqlite", std::process::id()));
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", p.display()));
    }
    p
}

fn spec(id: &str, steps: Value) -> Value {
    json!({ "schema": "p04-plan/0.1", "planId": id, "owner": "Wa11et", "world": "s1:100", "goal": "village-first", "steps": steps })
}

fn three() -> Value {
    json!([
        { "name": "Build", "fields": { "item": 1 }, "expect": { "copy": 0 } },
        { "name": "Train", "fields": { "unit": 0, "n": 100 } },
        { "name": "Muster", "fields": { "unit": 0, "troops": 100, "tile": 7 } }
    ])
}

fn code(r: Result<Value, PlanErr>) -> &'static str {
    r.err().map(|e| e.code).unwrap_or("ok")
}

/// One step through: intend → signed → landed.
fn land(s: &Store, plan: &str, h: &str, epoch: i64, idx: i64, bell: i64, sig: &str, now: i64) {
    plans::intend(s, plan, h, epoch, idx, bell, now).unwrap();
    plans::signed(s, plan, h, epoch, idx, sig, now + 1).unwrap();
    plans::settle(s, plan, h, epoch, idx, "landed", Some(sig), None, Some(bell), now + 2).unwrap();
}

#[test]
fn a_plan_runs_one_step_per_turn_to_done() {
    let s = Store::open(&db("done")).unwrap();
    let v = plans::accept(&s, &spec("p1", three()), 1_000).unwrap();
    assert_eq!(v["state"], "active");
    assert_eq!(v["replayed"], false);
    assert_eq!(plans::accept(&s, &spec("p1", three()), 1_001).unwrap()["replayed"], true);
    let c = plans::claim(&s, "p1", "h1", 30_000, 1_000).unwrap();
    assert_eq!(c["granted"], true);
    let e = c["epoch"].as_i64().unwrap();
    land(&s, "p1", "h1", e, 0, 5, SIG_A, 1_100);
    // the same turn is used: step 1 waits for turn 6
    assert_eq!(code(plans::intend(&s, "p1", "h1", e, 1, 5, 1_200)), "TurnUsed");
    // a later step out of order is not due
    assert_eq!(code(plans::intend(&s, "p1", "h1", e, 2, 6, 1_200)), "NotDue");
    land(&s, "p1", "h1", e, 1, 6, SIG_B, 1_300);
    land(&s, "p1", "h1", e, 2, 7, SIG_C, 1_400);
    let v = plans::view(&s, "p1").unwrap();
    assert_eq!(v["state"], "done");
    assert_eq!(v["landed"], 3);
    assert_eq!(v["steps"][2]["signature"], SIG_C);
}

#[test]
fn a_booked_later_turn_counts_as_used() {
    let s = Store::open(&db("booked")).unwrap();
    plans::accept(&s, &spec("p1", three()), 0).unwrap();
    let e = plans::claim(&s, "p1", "h", 30_000, 0).unwrap()["epoch"].as_i64().unwrap();
    plans::intend(&s, "p1", "h", e, 0, 5, 1).unwrap();
    plans::signed(&s, "p1", "h", e, 0, SIG_A, 2).unwrap();
    // the chain's turn after the send was 6: it books 6
    plans::settle(&s, "p1", "h", e, 0, "landed", Some(SIG_A), None, Some(6), 3).unwrap();
    assert_eq!(code(plans::intend(&s, "p1", "h", e, 1, 6, 4)), "TurnUsed");
    assert_eq!(code(plans::intend(&s, "p1", "h", e, 1, 7, 5)), "ok");
}

#[test]
fn caravans_and_unknown_orders_are_not_plan_steps() {
    let s = Store::open(&db("caravan")).unwrap();
    let r = plans::accept(&s, &spec("c", json!([{ "name": "SendCaravan", "fields": {} }])), 0);
    assert_eq!(r.as_ref().unwrap_err().code, "NotLocalOrder");
    assert!(r.unwrap_err().message.contains("Q4"));
    assert_eq!(code(plans::accept(&s, &spec("c", json!([{ "name": "March", "fields": {} }])), 0)), "NotLocalOrder");
    assert_eq!(code(plans::accept(&s, &spec("c", json!([])), 0)), "BadRequest");
    let mut x = spec("c", three());
    x["extra"] = json!(1);
    assert_eq!(code(plans::accept(&s, &x, 0)), "BadRequest");
    // the same id with another spec
    plans::accept(&s, &spec("c", three()), 0).unwrap();
    assert_eq!(code(plans::accept(&s, &spec("c", json!([{ "name": "Harvest", "fields": {} }])), 0)), "Conflict");
}

#[test]
fn an_open_step_blocks_everything_until_settled_and_stop_waits_for_it() {
    let s = Store::open(&db("open")).unwrap();
    plans::accept(&s, &spec("p", three()), 0).unwrap();
    let e = plans::claim(&s, "p", "h", 30_000, 0).unwrap()["epoch"].as_i64().unwrap();
    plans::intend(&s, "p", "h", e, 0, 5, 1).unwrap();
    plans::signed(&s, "p", "h", e, 0, SIG_A, 2).unwrap();
    plans::settle(&s, "p", "h", e, 0, "unknown", None, None, None, 3).unwrap();
    assert_eq!(code(plans::stop(&s, "p", "h", e, "state changed", 4)), "OpenStep");
    // landed needs the recorded signature
    assert_eq!(code(plans::settle(&s, "p", "h", e, 0, "landed", Some(SIG_B), None, None, 5)), "BadSettle");
    assert_eq!(code(plans::settle(&s, "p", "h", e, 0, "not-sent", None, None, None, 5)), "BadSettle");
    plans::settle(&s, "p", "h", e, 0, "landed", Some(SIG_A), None, None, 6).unwrap();
    plans::stop(&s, "p", "h", e, "state changed", 7).unwrap();
    assert_eq!(plans::view(&s, "p").unwrap()["state"], "stopped");
    assert_eq!(code(plans::intend(&s, "p", "h", e, 1, 9, 8)), "Stopped");
}

#[test]
fn not_sent_reopens_a_step_until_its_attempts_are_used() {
    let s = Store::open(&db("notsent")).unwrap();
    let mut x = spec("p", three());
    x["maxAttempts"] = json!(2);
    plans::accept(&s, &x, 0).unwrap();
    let e = plans::claim(&s, "p", "h", 30_000, 0).unwrap()["epoch"].as_i64().unwrap();
    for t in 0..2 {
        plans::intend(&s, "p", "h", e, 0, 5, 10 + t).unwrap();
        plans::settle(&s, "p", "h", e, 0, "not-sent", None, Some("LocalActBusy"), None, 20 + t).unwrap();
    }
    // nothing reached the chain: the turn is not used, but the attempts are
    assert_eq!(code(plans::intend(&s, "p", "h", e, 0, 5, 30)), "Exhausted");
    let v = plans::view(&s, "p").unwrap();
    assert_eq!(v["state"], "stopped");
    assert!(v["stopReason"].as_str().unwrap().starts_with("attempts"));
}

#[test]
fn a_chain_refusal_or_an_unknown_past_its_life_stops_the_plan_for_a_replan() {
    let s = Store::open(&db("refuse")).unwrap();
    plans::accept(&s, &spec("p", three()), 0).unwrap();
    let e = plans::claim(&s, "p", "h", 30_000, 0).unwrap()["epoch"].as_i64().unwrap();
    plans::intend(&s, "p", "h", e, 0, 5, 1).unwrap();
    plans::signed(&s, "p", "h", e, 0, SIG_A, 2).unwrap();
    plans::settle(&s, "p", "h", e, 0, "failed", Some(SIG_A), Some("Custom(26)"), Some(5), 3).unwrap();
    let v = plans::view(&s, "p").unwrap();
    assert_eq!(v["state"], "stopped");
    assert!(v["stopReason"].as_str().unwrap().contains("Custom(26)"));
    // the replan: a new plan that replaces it; while p was active a second plan was refused
    let mut q = spec("q", three());
    q["replaces"] = json!("p");
    plans::accept(&s, &q, 4).unwrap();
    assert_eq!(code(plans::accept(&s, &spec("r", three()), 5)), "ActivePlan");
    let e = plans::claim(&s, "q", "h", 30_000, 6).unwrap()["epoch"].as_i64().unwrap();
    // turn 5 is still used by p's failed step (the world counted it)
    assert_eq!(code(plans::intend(&s, "q", "h", e, 0, 5, 7)), "TurnUsed");
    plans::intend(&s, "q", "h", e, 0, 6, 8).unwrap();
    plans::signed(&s, "q", "h", e, 0, SIG_B, 9).unwrap();
    plans::settle(&s, "q", "h", e, 0, "expired-unknown", None, None, None, 10).unwrap();
    let v = plans::view(&s, "q").unwrap();
    assert_eq!(v["state"], "stopped");
    assert!(v["stopReason"].as_str().unwrap().starts_with("outcome-unknown"));
    assert_eq!(v["replaces"], "p");
}

#[test]
fn a_new_holder_fences_the_old_one_and_drops_its_unsigned_intent() {
    let s = Store::open(&db("fence")).unwrap();
    plans::accept(&s, &spec("p", three()), 0).unwrap();
    let e1 = plans::claim(&s, "p", "old", 10_000, 0).unwrap()["epoch"].as_i64().unwrap();
    plans::intend(&s, "p", "old", e1, 0, 5, 1).unwrap();
    // the lease is still the old holder's
    assert_eq!(plans::claim(&s, "p", "new", 10_000, 5_000).unwrap()["granted"], false);
    // it ran out (the old process was stopped mid-step): the new holder takes it
    let c = plans::claim(&s, "p", "new", 10_000, 10_001).unwrap();
    assert_eq!(c["granted"], true);
    assert_eq!(c["resetIntents"], 1);
    let e2 = c["epoch"].as_i64().unwrap();
    assert_eq!(e2, e1 + 1);
    // the old one wakes up: it can neither record its signature (so it must not submit) nor settle
    assert_eq!(code(plans::signed(&s, "p", "old", e1, 0, SIG_A, 10_002)), "Fenced");
    assert_eq!(plans::view(&s, "p").unwrap()["steps"][0]["state"], "not-sent");
    land(&s, "p", "new", e2, 0, 6, SIG_B, 10_003);
    // the new holder's lease runs out too: renew before writing
    assert_eq!(code(plans::intend(&s, "p", "new", e2, 1, 7, 30_000)), "Fenced");
    assert_eq!(plans::claim(&s, "p", "new", 10_000, 30_000).unwrap()["epoch"], e2);
    plans::intend(&s, "p", "new", e2, 1, 7, 30_001).unwrap();
}

#[test]
fn a_signed_step_survives_a_restart_and_is_settled_by_its_signature_only() {
    let path = db("restart");
    {
        let s = Store::open(&path).unwrap();
        plans::accept(&s, &spec("p", three()), 0).unwrap();
        let e = plans::claim(&s, "p", "pid1", 10_000, 0).unwrap()["epoch"].as_i64().unwrap();
        plans::intend(&s, "p", "pid1", e, 0, 5, 1).unwrap();
        plans::signed(&s, "p", "pid1", e, 0, SIG_A, 2).unwrap();
        // SIGKILL here: the store is dropped mid-step
    }
    let s = Store::open(&path).unwrap();
    let cur = plans::current(&s, "Wa11et", "s1:100").unwrap();
    assert_eq!(cur["open"].as_array().unwrap().len(), 1);
    assert_eq!(cur["open"][0]["signature"], SIG_A);
    let c = plans::claim(&s, "p", "pid2", 10_000, 20_000).unwrap();
    assert_eq!(c["resetIntents"], 0, "a signed step is not an unsigned intent");
    let e = c["epoch"].as_i64().unwrap();
    assert_eq!(code(plans::intend(&s, "p", "pid2", e, 0, 7, 20_001)), "NotDue");
    plans::settle(&s, "p", "pid2", e, 0, "landed", Some(SIG_A), None, Some(5), 20_002).unwrap();
    assert_eq!(plans::view(&s, "p").unwrap()["cursor"], 1);
}

fn cli(args: &[&str]) -> (i32, Value) {
    let o = Command::new(BIN).args(args).output().unwrap();
    let line = String::from_utf8_lossy(&o.stdout).trim().lines().last().unwrap_or("").to_string();
    (o.status.code().unwrap_or(-1), serde_json::from_str(&line).unwrap_or(Value::Null))
}

#[test]
fn the_cli_speaks_one_json_line_with_exit_codes() {
    let path = db("cli");
    let d = path.display().to_string();
    let spec_file = std::env::temp_dir().join(format!("runexec-plans-{}-spec.json", std::process::id()));
    std::fs::write(&spec_file, spec("p", three()).to_string()).unwrap();
    let sf = spec_file.display().to_string();
    let (x, v) = cli(&["plan", "accept", "--db", &d, "--spec", &sf, "--now-ms", "0"]);
    assert_eq!((x, v["state"].as_str()), (0, Some("active")));
    let (x, v) = cli(&["plan", "claim", "--db", &d, "--plan", "p", "--holder", "h", "--lease-ms", "10000", "--now-ms", "0"]);
    assert_eq!(x, 0);
    let e = v["epoch"].to_string();
    let (x, _) = cli(&["plan", "intend", "--db", &d, "--plan", "p", "--holder", "h", "--epoch", &e, "--step", "0", "--bell", "3", "--now-ms", "1"]);
    assert_eq!(x, 0);
    let (x, v) = cli(&["plan", "signed", "--db", &d, "--plan", "p", "--holder", "x", "--epoch", &e, "--step", "0", "--signature", SIG_A, "--now-ms", "2"]);
    assert_eq!((x, v["error"].as_str()), (6, Some("Fenced")));
    let (x, _) = cli(&["plan", "signed", "--db", &d, "--plan", "p", "--holder", "h", "--epoch", &e, "--step", "0", "--signature", SIG_A, "--now-ms", "2"]);
    assert_eq!(x, 0);
    let (x, v) = cli(&["plan", "intend", "--db", &d, "--plan", "p", "--holder", "h", "--epoch", &e, "--step", "1", "--bell", "4", "--now-ms", "3"]);
    assert_eq!((x, v["error"].as_str()), (7, Some("NotDue")));
    let (x, v) = cli(&["plan", "current", "--db", &d, "--owner", "Wa11et", "--world", "s1:100"]);
    assert_eq!((x, v["open"][0]["state"].as_str()), (0, Some("signed")));
    let (x, v) = cli(&["plan", "settle", "--db", &d, "--plan", "p", "--holder", "h", "--epoch", &e, "--step", "0", "--outcome", "landed", "--signature", SIG_A, "--now-ms", "4"]);
    assert_eq!((x, v["cursor"].as_i64()), (0, Some(1)));
    let (x, v) = cli(&["plan", "view", "--db", &d, "--plan", "nope"]);
    assert_eq!((x, v["error"].as_str()), (3, Some("NoRecord")));
    let (x, _) = cli(&["plan", "view", "--db", &d, "--plan", "p", "--plan", "p"]);
    assert_eq!(x, 2);
    let (x, _) = cli(&["plan", "view", "--db", "/nonexistent/x.sqlite", "--plan", "p"]);
    assert_eq!(x, 5);
    let _ = std::fs::remove_file(spec_file);
}

#[test]
fn two_processes_racing_for_one_plan_get_one_lease() {
    let path = db("race");
    let s = Store::open(&path).unwrap();
    plans::accept(&s, &spec("p", three()), 0).unwrap();
    let d = path.display().to_string();
    let hs: Vec<_> = (0..6)
        .map(|i| {
            let d = d.clone();
            std::thread::spawn(move || {
                let h = format!("h{i}");
                cli(&["plan", "claim", "--db", &d, "--plan", "p", "--holder", &h, "--lease-ms", "60000"]).1["granted"].as_bool()
            })
        })
        .collect();
    let answers: Vec<Option<bool>> = hs.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(answers.iter().filter(|a| **a == Some(true)).count(), 1, "{answers:?}");
    assert_eq!(answers.iter().filter(|a| **a == Some(false)).count(), 5, "{answers:?}");
}
