//! The machine-readable entry to runs: `runexec run accept | view`, run as
//! a separate process the way workstream 06's planner and workstream 13's
//! execution port call it. Fixed literal specs, the simulated world (MOCK)
//! only: no key is generated, derived, imported, signed with or verified,
//! and nothing is sent anywhere.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::*;
use runexec::model::*;
use runexec::sim::{Sim, SimWorld};
use runexec::store::{Accept, Change, Store};
use runexec::view::{run_view, run_view_at};
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_runexec");

/// Workstream 06's delivery: 4 iron from the owner's holding to the
/// owner's vault, no making step. The places are `common::scene`'s
/// (holding kind 1, vault kind 2); the owner tag 119 is `OWNER` (0x77).
const CARGO_SPEC: &str = r#"{
  "run_id": "ws06-cargo-1",
  "owner": 119,
  "stock": {"kind": 1, "p": 0, "q": 0, "at": 1, "gen": 1},
  "inbound": null,
  "inputs": [0, 0, 0, 0, 0, 0, 0, 0],
  "outputs": [0, 0, 0, 0, 0, 0, 0, 0],
  "rights_units": 0,
  "ship": {"dst": {"kind": 2, "p": 1, "q": 0, "at": 5, "gen": 1}, "cargo": [0, 4, 0, 0, 0, 0, 0, 0]},
  "deadline_slot": 400,
  "budget": {"max_attempts": 3, "max_fee": 200000, "max_port_errors": 5}
}"#;

/// A making run as before: 5 iron into 3 weapons at the other player's
/// forge, the 3 weapons shipped to the vault (`common::spec`).
const MAKING_SPEC: &str = r#"{
  "run_id": "make-1",
  "owner": 119,
  "stock": {"kind": 1, "p": 0, "q": 0, "at": 1, "gen": 1},
  "inbound": null,
  "facility": {"place": {"kind": 1, "p": 0, "q": 1, "at": 2, "gen": 1}, "recipe": 1},
  "inputs": [0, 5, 0, 0, 0, 0, 0, 0],
  "outputs": [0, 0, 0, 0, 0, 0, 3, 0],
  "rights_units": 1,
  "ship": {"dst": {"kind": 2, "p": 1, "q": 0, "at": 5, "gen": 1}, "cargo": [0, 0, 0, 0, 0, 0, 3, 0]},
  "deadline_slot": 400,
  "budget": {"max_attempts": 3, "max_fee": 200000, "max_port_errors": 5}
}"#;

const CARGO_ID: &str = "ws06-cargo-1";

/// Runs the binary; the exit code and the whole of stdout.
fn text(args: &[&str]) -> (i32, String) {
    let out = Command::new(BIN).args(args).output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

/// Runs the binary; the exit code and the last stdout line as JSON.
fn jsonl(args: &[&str]) -> (i32, Value) {
    let (code, out) = text(args);
    let line = out.lines().last().unwrap_or("");
    (code, serde_json::from_str(line).unwrap_or(Value::Null))
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn spec_file(db: &Path, name: &str, body: &str) -> PathBuf {
    let p = db.with_extension(format!("{name}.json"));
    std::fs::write(&p, body).unwrap();
    p
}

fn accept(db: &Path, spec: &Path, slot: &str) -> (i32, Value) {
    jsonl(&[
        "run",
        "accept",
        "--db",
        s(db),
        "--spec",
        s(spec),
        "--slot",
        slot,
    ])
}

/// `--spec -`: the spec on stdin.
fn accept_stdin(db: &Path, body: &str) -> (i32, Value) {
    let mut child = Command::new(BIN)
        .args(["run", "accept", "--db", s(db), "--spec", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // The child may stop reading (an oversized input) before everything
    // is written: a broken pipe here is not a test failure.
    let _ = child.stdin.take().unwrap().write_all(body.as_bytes());
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let line = text.lines().last().unwrap_or("");
    (
        out.status.code().unwrap_or(-1),
        serde_json::from_str(line).unwrap_or(Value::Null),
    )
}

fn view(db: &Path, id: &str) -> (i32, Value) {
    jsonl(&["run", "view", "--db", s(db), "--run", id])
}

/// The operator's `status` block's `byState` (the whole store's truth).
fn by_state(db: &Path) -> Value {
    let (code, out) = text(&["status", "--db", s(db), "--slot", "0"]);
    assert_eq!(code, 0, "{out}");
    serde_json::from_str::<Value>(&out).unwrap()["byState"].clone()
}

/// The cargo-only spec as the executor tests build it (`tests/cargo_only.rs`).
fn cargo_spec(sc: &Scene) -> RunSpec {
    RunSpec {
        run_id: CARGO_ID.to_string(),
        owner: OWNER,
        stock: sc.stock,
        inbound: None,
        facility: None,
        inputs: ZERO,
        outputs: ZERO,
        rights_units: 0,
        ship: ShipSpec {
            dst: sc.dst,
            cargo: r(1, 4),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    }
}

#[test]
fn a_cargo_only_run_is_accepted_viewed_and_replayed_without_a_duplicate() {
    let db = db_path("run-cli-cargo");
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    let (c, v) = accept(&db, &f, "7");
    assert_eq!(c, 0, "{v}");
    assert_eq!(
        (v["accept"].as_str(), v["replayed"].as_bool()),
        (Some("Created"), Some(false))
    );
    assert_eq!(v["view_version"], json!("p04-run/0.1"));
    assert_eq!(v["run_id"], json!(CARGO_ID));
    assert_eq!(v["state"], json!("Accepted"));
    assert_eq!(v["cargo_only"], json!(true));
    assert_eq!(
        (v["terminal"].as_bool(), v["in_flight"].as_bool()),
        (Some(false), Some(false))
    );
    assert_eq!(
        (v["sent"].as_bool(), v["settled"].as_bool()),
        (Some(false), Some(false)),
        "a stored request is neither a send nor an arrival"
    );
    for empty in ["effects", "attempts", "receipts", "transitions"] {
        assert_eq!(v[empty], json!([]), "{empty}");
    }
    for null in ["held_reason", "cancel_phase", "outcome", "reason"] {
        assert!(v[null].is_null(), "{null}: {}", v[null]);
    }
    assert_eq!(v["cancel_requested"], json!(false));
    assert_eq!(
        (v["version"].as_i64(), v["next_check"].as_u64()),
        (Some(0), Some(7))
    );
    assert_eq!(
        v["fees"],
        json!({ "reserved": 0, "charged": 0, "unconfirmed": 0, "released": 0 })
    );
    assert!(
        v["spec"].get("facility").is_none(),
        "a cargo-only spec has no facility field: {}",
        v["spec"]
    );
    assert_eq!(v["spec"]["ship"]["cargo"], json!([0, 4, 0, 0, 0, 0, 0, 0]));
    assert_eq!(v["detail"]["fac_attempts"], json!(0));

    // What was persisted is exactly the executor tests' cargo-only spec.
    let expected = cargo_spec(&scene(&mut SimWorld::new()));
    let row = Store::open(&db).unwrap().load(CARGO_ID).unwrap().unwrap();
    assert_eq!(row.spec, expected);
    assert_eq!(row.state, RunState::Accepted);
    assert_eq!(v["spec_digest"], json!(expected.digest()));

    // The same spec again, from a file and then from stdin, answers the
    // existing run and writes nothing (its version and slot stay).
    let (c, again) = accept(&db, &f, "9");
    assert_eq!(
        (c, again["accept"].as_str(), again["replayed"].as_bool()),
        (0, Some("Existing"), Some(true)),
        "{again}"
    );
    assert_eq!(
        (again["version"].as_i64(), again["next_check"].as_u64()),
        (Some(0), Some(7))
    );
    let (c, from_stdin) = accept_stdin(&db, CARGO_SPEC);
    assert_eq!(
        (c, from_stdin["accept"].as_str()),
        (0, Some("Existing")),
        "{from_stdin}"
    );
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));

    // The view is the same answer without the acceptance fields.
    let (c, seen) = view(&db, CARGO_ID);
    assert_eq!(c, 0, "{seen}");
    assert!(seen.get("accept").is_none() && seen.get("replayed").is_none());
    assert_eq!(seen["spec_digest"], v["spec_digest"]);
    assert_eq!(seen["state"], json!("Accepted"));

    // The operator's existing commands work on a run accepted here, and the
    // view reports what they wrote.
    let (c, out) = text(&["cancel", "--db", s(&db), "--run", CARGO_ID]);
    assert_eq!(c, 0, "{out}");
    let (_, seen) = view(&db, CARGO_ID);
    assert_eq!(seen["cancel_requested"], json!(true));
    assert_eq!(seen["cancel_phase"], json!("StoppingNew"));
    assert_eq!(seen["version"], json!(1));
    assert_eq!(
        seen["state"],
        json!("Accepted"),
        "a cancel is a request, not a state"
    );
    let (c, out) = text(&["show", "--db", s(&db), "--run", CARGO_ID]);
    assert_eq!(c, 0, "{out}");
    assert!(
        out.starts_with(&format!("run {CARGO_ID}: Accepted")),
        "{out}"
    );
}

#[test]
fn a_making_run_is_stored_as_before_same_json_same_digest() {
    let db = db_path("run-cli-making");
    let f = spec_file(&db, "making", MAKING_SPEC);
    let (c, v) = accept(&db, &f, "0");
    assert_eq!(c, 0, "{v}");
    assert_eq!(v["accept"], json!("Created"));
    assert_eq!(v["cargo_only"], json!(false));
    let sc = scene(&mut SimWorld::new());
    let expected = spec("make-1", &sc);
    assert_eq!(
        v["spec"]["facility"],
        serde_json::to_value(sc.facility).unwrap(),
        "the facility is its value, not wrapped"
    );
    let store = Store::open(&db).unwrap();
    let row = store.load("make-1").unwrap().unwrap();
    assert_eq!(row.spec, expected);
    // The stored text and digest are the ones the executor has always
    // written for a making run.
    let (stored, digest): (String, String) = store
        .conn
        .query_row(
            "SELECT spec, spec_digest FROM runs WHERE run_id = 'make-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, serde_json::to_string(&expected).unwrap());
    assert_eq!(digest, expected.digest());
    assert_eq!(v["spec_digest"], json!(digest));
    // The library's own acceptance of that spec is the existing run.
    assert_eq!(
        store.accept(&expected, 3).unwrap(),
        Accept::Existing(RunState::Accepted)
    );
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
}

#[test]
fn the_same_id_with_another_spec_is_refused_and_nothing_changes() {
    let db = db_path("run-cli-conflict");
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    assert_eq!(accept(&db, &f, "0").0, 0);
    let five = CARGO_SPEC.replace("[0, 4, 0, 0, 0, 0, 0, 0]", "[0, 5, 0, 0, 0, 0, 0, 0]");
    assert_ne!(five, CARGO_SPEC);
    let g = spec_file(&db, "cargo5", &five);
    let (c, e) = accept(&db, &g, "0");
    assert_eq!((c, e["error"].as_str()), (4, Some("Conflict")), "{e}");
    assert!(
        e["message"].as_str().unwrap().contains("another run_id"),
        "{e}"
    );
    // A making run under the cargo-only run's id: refused too, never merged.
    let m = MAKING_SPEC.replace("\"make-1\"", &format!("\"{CARGO_ID}\""));
    assert_ne!(m, MAKING_SPEC);
    let h = spec_file(&db, "making-as-cargo", &m);
    let (c, e) = accept(&db, &h, "0");
    assert_eq!((c, e["error"].as_str()), (4, Some("Conflict")), "{e}");
    let (c, seen) = view(&db, CARGO_ID);
    assert_eq!(c, 0);
    assert_eq!(
        seen["spec"]["ship"]["cargo"],
        json!([0, 4, 0, 0, 0, 0, 0, 0])
    );
    assert!(seen["spec"].get("facility").is_none());
    assert_eq!(seen["version"], json!(0));
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
}

#[test]
fn malformed_input_and_options_are_refused_before_anything_is_written() {
    let db = db_path("run-cli-malformed");
    let good = spec_file(&db, "good", CARGO_SPEC);
    let derived = |from: &str, old: &str, new: &str| -> String {
        let out = from.replace(old, new);
        assert_ne!(out, from, "the fixture text {old:?} is in the spec");
        out
    };
    let bad_specs: Vec<(&str, String)> = vec![
        ("not-json", "{ \"run_id\": ".to_string()),
        ("not-an-object", "[]".to_string()),
        ("a-string", "\"ws06-cargo-1\"".to_string()),
        (
            "misspelt-facility",
            derived(MAKING_SPEC, "\"facility\"", "\"facilty\""),
        ),
        (
            "unknown-top-level-field",
            derived(
                CARGO_SPEC,
                "\"deadline_slot\": 400",
                "\"deadline_slot\": 400, \"sent\": true",
            ),
        ),
        (
            "unknown-nested-field",
            derived(
                CARGO_SPEC,
                "\"at\": 5, \"gen\": 1}",
                "\"at\": 5, \"gen\": 1, \"tile\": 9}",
            ),
        ),
        (
            "missing-ship",
            derived(CARGO_SPEC, "\"ship\":", "\"shipment\":"),
        ),
        (
            "short-resource-array",
            derived(
                CARGO_SPEC,
                "\"cargo\": [0, 4, 0, 0, 0, 0, 0, 0]",
                "\"cargo\": [0, 4]",
            ),
        ),
        (
            "owner-as-text",
            derived(CARGO_SPEC, "\"owner\": 119", "\"owner\": \"0x77\""),
        ),
        (
            "negative-amount",
            derived(
                CARGO_SPEC,
                "\"cargo\": [0, 4, 0, 0, 0, 0, 0, 0]",
                "\"cargo\": [0, -4, 0, 0, 0, 0, 0, 0]",
            ),
        ),
        (
            "empty-cargo",
            derived(
                CARGO_SPEC,
                "\"cargo\": [0, 4, 0, 0, 0, 0, 0, 0]",
                "\"cargo\": [0, 0, 0, 0, 0, 0, 0, 0]",
            ),
        ),
        (
            "cargo-only-with-inputs",
            derived(
                CARGO_SPEC,
                "\"inputs\": [0, 0, 0, 0, 0, 0, 0, 0]",
                "\"inputs\": [0, 1, 0, 0, 0, 0, 0, 0]",
            ),
        ),
        (
            "cargo-only-with-right-units",
            derived(CARGO_SPEC, "\"rights_units\": 0", "\"rights_units\": 1"),
        ),
        (
            "same-tile",
            derived(
                CARGO_SPEC,
                "\"dst\": {\"kind\": 2, \"p\": 1, \"q\": 0, \"at\": 5, \"gen\": 1}",
                "\"dst\": {\"kind\": 1, \"p\": 0, \"q\": 0, \"at\": 1, \"gen\": 2}",
            ),
        ),
        (
            "zero-attempts",
            derived(CARGO_SPEC, "\"max_attempts\": 3", "\"max_attempts\": 0"),
        ),
        (
            "too-many-attempts",
            derived(CARGO_SPEC, "\"max_attempts\": 3", "\"max_attempts\": 17"),
        ),
        ("empty-id", derived(CARGO_SPEC, "\"ws06-cargo-1\"", "\"\"")),
    ];
    assert!(!db.exists());
    for (name, body) in &bad_specs {
        let f = spec_file(&db, name, body);
        let (c, e) = accept(&db, &f, "0");
        assert_eq!(
            (c, e["error"].as_str()),
            (2, Some("BadRequest")),
            "{name}: {e}"
        );
        assert!(e["message"].is_string(), "{name}: {e}");
        assert!(!db.exists(), "{name}: the store was opened or written");
    }
    // Options: every refusal before the store exists.
    let g = s(&good);
    let d = s(&db);
    let option_errors: Vec<Vec<&str>> = vec![
        vec!["run", "accept", "--db", d],
        vec!["run", "accept", "--spec", g],
        vec!["run", "accept", "--db", d, "--spec"],
        vec![
            "run",
            "accept",
            "--db",
            d,
            "--spec",
            "/nonexistent/ws06.json",
        ],
        vec!["run", "accept", "--db", d, "--spec", g, "--sl0t", "1"],
        vec!["run", "accept", "--db", d, "--spec", g, "--slot", "soon"],
        vec!["run", "accept", "--db", d, "--spec", g, "--slot", "-1"],
        vec!["run", "accept", "--db", d, "--spec", g, "--spec", g],
        vec!["run", "accept", "--db", d, "--spec", g, "--run", CARGO_ID],
        vec!["run", "accept", "--db", d, "--spec", g, "extra"],
        vec!["run", "submit", "--db", d, "--spec", g],
        vec!["run"],
        vec!["run", "view", "--db", d],
        vec!["run", "view", "--run", CARGO_ID],
        vec!["run", "view", "--db", d, "--run", CARGO_ID, "--spec", g],
    ];
    for args in &option_errors {
        let (c, e) = jsonl(args);
        assert_eq!(
            (c, e["error"].as_str()),
            (2, Some("BadRequest")),
            "{args:?}: {e}"
        );
        assert!(!db.exists(), "{args:?}: the store was opened or written");
    }
    // A good spec after all that, then a bad one against the store that
    // now exists: the store is unchanged and the bad id has no record.
    assert_eq!(accept(&db, &good, "0").0, 0);
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
    let f = spec_file(&db, "misspelt-facility", &bad_specs[3].1);
    assert_eq!(accept(&db, &f, "0").0, 2);
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
    let (c, e) = view(&db, "make-1");
    assert_eq!((c, e["error"].as_str()), (3, Some("NoRecord")), "{e}");
    // The stdin form refuses the same way.
    let (c, e) = accept_stdin(&db, "{ \"run_id\": ");
    assert_eq!((c, e["error"].as_str()), (2, Some("BadRequest")), "{e}");
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
}

#[test]
fn a_missing_run_is_no_record_only_in_a_readable_store_and_an_unreadable_one_is_no_answer() {
    let db = db_path("run-cli-missing");
    // No store at the path: nothing is known. Not "no record": a deleted,
    // unmounted or wrongly named store does not show that nothing was
    // accepted (and maybe sent) there.
    let (c, e) = view(&db, "never");
    assert_eq!(
        (c, e["error"].as_str()),
        (5, Some("StoreUnavailable")),
        "{e}"
    );
    assert!(e["message"].as_str().unwrap().contains("never"));
    assert!(!db.exists());
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    assert_eq!(accept(&db, &f, "0").0, 0);
    assert_eq!(view(&db, CARGO_ID).0, 0);
    // The store was opened and read: this id is not in it.
    let (c, e) = view(&db, "ws06-cargo-2");
    assert_eq!(
        (c, e["error"].as_str()),
        (3, Some("NoRecord")),
        "another id is not this run: {e}"
    );
    // Then the store goes away (a wrong path after a move): no record
    // becomes no answer, for the id that was in it too.
    let moved = db.with_extension("moved.sqlite");
    std::fs::rename(&db, &moved).unwrap();
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db.display()));
    }
    let (c, e) = view(&db, CARGO_ID);
    assert_eq!(
        (c, e["error"].as_str()),
        (5, Some("StoreUnavailable")),
        "{e}"
    );
    assert!(!db.exists(), "view created a store at the old path");
    std::fs::rename(&moved, &db).unwrap();
    assert_eq!(view(&db, CARGO_ID).0, 0, "the run is still there");
    // A file that is not a database: an error, never "no record" and
    // never an acceptance.
    let broken = db.with_extension("broken.sqlite");
    std::fs::write(&broken, vec![b'x'; 4096]).unwrap();
    let (c, e) = view(&broken, CARGO_ID);
    assert_eq!((c, e["error"].as_str()), (1, Some("StoreError")), "{e}");
    let (c, e) = accept(&broken, &f, "0");
    assert_eq!((c, e["error"].as_str()), (1, Some("StoreError")), "{e}");
    assert_eq!(
        std::fs::read(&broken).unwrap(),
        vec![b'x'; 4096],
        "untouched"
    );
}

#[test]
fn view_only_reads_it_creates_no_store_and_leaves_an_existing_one_as_it_was() {
    let db = db_path("run-cli-readonly");
    let sibling = |ext: &str| PathBuf::from(format!("{}{ext}", db.display()));
    // No store at the path: no answer about the run, and looking does not
    // create a store.
    let (c, e) = view(&db, CARGO_ID);
    assert_eq!(
        (c, e["error"].as_str()),
        (5, Some("StoreUnavailable")),
        "{e}"
    );
    assert!(e["message"].as_str().unwrap().contains("no store"), "{e}");
    assert!(!db.exists(), "view created the store");
    assert!(!sibling("-wal").exists() && !sibling("-shm").exists());
    // An existing store is read, not rewritten: the file's bytes are the
    // same after the view (the accepting process closed cleanly, so the
    // WAL was folded in before the view opened the file).
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    assert_eq!(accept(&db, &f, "0").0, 0);
    let before = std::fs::read(&db).unwrap();
    let (c, v) = view(&db, CARGO_ID);
    assert_eq!((c, v["version"].as_i64()), (0, Some(0)), "{v}");
    assert_eq!(
        std::fs::read(&db).unwrap(),
        before,
        "the view wrote to the store"
    );
    // A file that is a database but not a run store: an error, and no
    // schema is created in it.
    let other = db.with_extension("other.sqlite");
    {
        let c = rusqlite::Connection::open(&other).unwrap();
        c.execute_batch("CREATE TABLE other(x INTEGER);").unwrap();
    }
    let (c, e) = view(&other, CARGO_ID);
    assert_eq!((c, e["error"].as_str()), (1, Some("StoreError")), "{e}");
    assert!(
        e["message"].as_str().unwrap().contains("not a run store"),
        "{e}"
    );
    let tables: Vec<String> = {
        let c = rusqlite::Connection::open(&other).unwrap();
        let mut st = c
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        st.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(tables, ["other"], "view initialised a schema");
    // An empty file: the same, and it stays empty.
    let empty = db.with_extension("empty.sqlite");
    std::fs::write(&empty, b"").unwrap();
    let (c, e) = view(&empty, CARGO_ID);
    assert_eq!((c, e["error"].as_str()), (1, Some("StoreError")), "{e}");
    assert_eq!(
        std::fs::metadata(&empty).unwrap().len(),
        0,
        "view wrote a schema"
    );
}

#[test]
fn a_null_member_is_unknown_unless_the_spec_omits_it_and_a_member_given_twice_is_refused() {
    let db = db_path("run-cli-null-dup");
    let derived = |old: &str, new: &str| -> String {
        let out = CARGO_SPEC.replace(old, new);
        assert_ne!(out, CARGO_SPEC, "the fixture text {old:?} is in the spec");
        out
    };
    // `facility: null` is the cargo-only spec itself (the field is omitted
    // when absent): the same digest, so a replay, not a new run.
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    assert_eq!(accept(&db, &f, "0").0, 0);
    let with_null = derived(
        "\"inbound\": null,",
        "\"inbound\": null,\n  \"facility\": null,",
    );
    let g = spec_file(&db, "facility-null", &with_null);
    let (c, v) = accept(&db, &g, "0");
    assert_eq!((c, v["accept"].as_str()), (0, Some("Existing")), "{v}");
    assert!(v["spec"].get("facility").is_none());
    // Any other null member, at any depth, is unknown.
    let refused: Vec<(&str, String, &str)> = vec![
        (
            "top-level null",
            derived(
                "\"inbound\": null,",
                "\"inbound\": null,\n  \"facilty\": null,",
            ),
            "facilty",
        ),
        (
            "nested null",
            derived(
                "\"at\": 5, \"gen\": 1}",
                "\"at\": 5, \"gen\": 1, \"gne\": null}",
            ),
            "ship.dst.gne",
        ),
        (
            "null inside budget",
            derived(
                "\"max_port_errors\": 5}",
                "\"max_port_errors\": 5, \"max_fee_total\": null}",
            ),
            "budget.max_fee_total",
        ),
        (
            "member given twice",
            derived(
                "\"deadline_slot\": 400,",
                "\"deadline_slot\": 400,\n  \"run_id\": \"ws06-cargo-9\",",
            ),
            "run_id",
        ),
        (
            "member given twice, escaped name",
            derived(
                "\"deadline_slot\": 400,",
                "\"deadline_slot\": 400,\n  \"run\\u005fid\": \"ws06-cargo-9\",",
            ),
            "run_id",
        ),
        (
            "nested member given twice",
            derived(
                "\"cargo\": [0, 4, 0, 0, 0, 0, 0, 0]}",
                "\"cargo\": [0, 4, 0, 0, 0, 0, 0, 0], \"cargo\": [0, 5, 0, 0, 0, 0, 0, 0]}",
            ),
            "ship.cargo",
        ),
        (
            "member given twice with the same value",
            derived("\"owner\": 119,", "\"owner\": 119,\n  \"owner\": 119,"),
            "owner",
        ),
    ];
    for (name, body, named) in &refused {
        let h = spec_file(&db, &name.replace(' ', "-"), body);
        let (c, e) = accept(&db, &h, "0");
        assert_eq!(
            (c, e["error"].as_str()),
            (2, Some("BadRequest")),
            "{name}: {e}"
        );
        assert!(
            e["message"].as_str().unwrap().contains(named),
            "{name}: the message names {named}: {e}"
        );
    }
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
    let (_, seen) = view(&db, CARGO_ID);
    assert_eq!(
        seen["spec"]["ship"]["cargo"],
        json!([0, 4, 0, 0, 0, 0, 0, 0])
    );
}

#[test]
fn a_slot_beyond_sqlite_integers_is_refused_and_the_largest_one_is_kept() {
    let db = db_path("run-cli-slot");
    let f = spec_file(&db, "cargo", CARGO_SPEC);
    for too_big in [
        "9223372036854775808",
        "18446744073709551615",
        "18446744073709551616",
    ] {
        let (c, e) = accept(&db, &f, too_big);
        assert_eq!(
            (c, e["error"].as_str()),
            (2, Some("BadRequest")),
            "{too_big}: {e}"
        );
        assert!(!db.exists(), "{too_big}: the store was opened or written");
    }
    let (c, v) = accept(&db, &f, "9223372036854775807");
    assert_eq!((c, v["accept"].as_str()), (0, Some("Created")), "{v}");
    assert_eq!(v["next_check"].as_u64(), Some(i64::MAX as u64));
    let (_, seen) = view(&db, CARGO_ID);
    assert_eq!(seen["next_check"].as_u64(), Some(i64::MAX as u64), "{seen}");
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
}

/// What one snapshot of a run must satisfy, whatever moment it is of.
/// Every executor write adds exactly one transition row with the new
/// version, and the `caravan_sent` receipt is written in the same
/// transaction as the move to InTransit; so a view mixing two moments
/// breaks one of these.
fn assert_consistent(v: &Value) {
    let version = v["version"].as_i64().unwrap();
    let tr = v["transitions"].as_array().unwrap();
    assert_eq!(
        tr.len() as i64,
        version,
        "transitions and version are of different moments: {v}"
    );
    let state = v["state"].as_str().unwrap();
    match tr.last() {
        Some(last) => assert_eq!(
            last["to"],
            json!(state),
            "state and transitions differ: {v}"
        ),
        None => assert_eq!(state, "Accepted", "{v}"),
    }
    let sent = v["sent"].as_bool().unwrap();
    let left = [
        "InTransit",
        "Arrived",
        "Fulfilled",
        "Partial",
        "DeliveredUnverified",
    ]
    .contains(&state);
    let moved = tr.iter().any(|t| t["to"] == json!("InTransit"));
    assert!(
        !left || sent,
        "a run past the send has no send receipt: {v}"
    );
    assert!(
        !sent || moved,
        "a send receipt without the move to InTransit: {v}"
    );
    let d = &v["detail"];
    let ship_attempts = v["attempts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["step"] == json!("ship"))
        .count() as u64;
    assert_eq!(d["ship_attempts"].as_u64().unwrap(), ship_attempts, "{v}");
}

#[test]
fn a_view_is_one_snapshot_a_write_committed_while_it_reads_does_not_show() {
    let db = db_path("run-cli-snapshot");
    let sc = scene(&mut SimWorld::new());
    let writer = Store::open(&db).unwrap();
    assert_eq!(writer.accept(&cargo_spec(&sc), 0).unwrap(), Accept::Created);
    let reader = Store::open_read_only(&db).unwrap();
    // Between the view's first read and the rest, another connection
    // commits a transition (Accepted → Cancelled: a new version, a new
    // transition row). The view must be all of the earlier moment.
    let v = run_view_at(&reader, CARGO_ID, || {
        assert!(writer.claim(CARGO_ID, "w", 0, 100).unwrap());
        let row = writer.load(CARGO_ID).unwrap().unwrap();
        let c = Change {
            to: RunState::Cancelled,
            detail: row.detail.clone(),
            next_check: u64::MAX,
            reason: "test: committed while a view reads".into(),
            ops: vec![],
            unless_cancelled: false,
            sole_owner_send: false,
            hold: None,
        };
        assert!(
            writer.transition(&row, "w", 0, &c).unwrap(),
            "the write landed"
        );
        assert_eq!(writer.load(CARGO_ID).unwrap().unwrap().version, 1);
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        (v["version"].as_i64(), v["state"].as_str()),
        (Some(0), Some("Accepted")),
        "{v}"
    );
    assert_eq!(
        v["transitions"],
        json!([]),
        "a transition of a later moment leaked in: {v}"
    );
    assert_consistent(&v);
    // After the snapshot ends the reader sees the write, whole.
    let after = run_view(&reader, CARGO_ID).unwrap().unwrap();
    assert_eq!(
        (after["version"].as_i64(), after["state"].as_str()),
        (Some(1), Some("Cancelled")),
        "{after}"
    );
    assert_eq!(after["transitions"].as_array().unwrap().len(), 1);
    assert_consistent(&after);
    // The command reads the same way.
    let (c, seen) = view(&db, CARGO_ID);
    assert_eq!(c, 0, "{seen}");
    assert_consistent(&seen);
}

/// A reader looking at every run as fast as it can, in its own thread and
/// connection, while the executor carries seven runs to the end: every
/// view it gets is of one moment (`assert_consistent`). Reads that mixed
/// moments would fail here on some iteration; a snapshot never does.
#[test]
fn views_beside_a_running_executor_never_mix_moments() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    let db = db_path("run-cli-concurrent");
    let mut w = SimWorld::new();
    let sc = scene(&mut w);
    // Six cargo-only runs of one iron each and one making run (5 iron):
    // 11 iron, so deposit one more. Sends of one owner go one at a time.
    w.deposit(&sc.stock, &r(1, 1));
    let sim = Sim::new(w);
    let mut ex = executor(&db, &sim, "exec-a");
    let mut ids: Vec<String> = (0..6).map(|i| format!("c{i}")).collect();
    for id in &ids {
        let sp = RunSpec {
            run_id: id.clone(),
            ship: ShipSpec {
                dst: sc.dst,
                cargo: r(1, 1),
            },
            ..cargo_spec(&sc)
        };
        assert_eq!(ex.accept(&sp).unwrap(), Accept::Created);
    }
    assert_eq!(ex.accept(&spec("m1", &sc)).unwrap(), Accept::Created);
    ids.push("m1".into());

    let done = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let reader = {
        let (db, ids, done, reads) = (db.clone(), ids.clone(), done.clone(), reads.clone());
        std::thread::spawn(move || {
            let store = Store::open_read_only(&db).unwrap();
            while !done.load(Ordering::SeqCst) {
                for id in &ids {
                    match run_view(&store, id) {
                        Ok(Some(v)) => {
                            assert_consistent(&v);
                            reads.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(None) => panic!("{id}: an accepted run vanished"),
                        // A moment the WAL cannot be read (recovery, a
                        // checkpoint): read again; never a wrong answer.
                        Err(e) if e.contains("locked") || e.contains("busy") => {}
                        Err(e) => panic!("{id}: {e}"),
                    }
                }
            }
        })
    };
    let all_done = |st: &Store| {
        ids.iter()
            .all(|id| st.load(id).unwrap().unwrap().state.terminal())
    };
    for _ in 0..1500 {
        if all_done(&ex.store) {
            break;
        }
        ex.tick().unwrap();
        sim.with(|w| w.advance(1));
    }
    done.store(true, Ordering::SeqCst);
    reader.join().expect("a view mixed two moments");
    for id in &ids {
        let row = ex.store.load(id).unwrap().unwrap();
        assert_eq!(row.state, RunState::Fulfilled, "{id}: {:?}", row.detail);
    }
    assert!(
        reads.load(Ordering::SeqCst) >= 7,
        "the reader ran beside the executor"
    );
    sim.with(|w| w.audit()).unwrap();
}

#[test]
fn a_spec_over_one_mebibyte_is_refused_before_the_store_exists() {
    const MAX: usize = 1 << 20;
    let db = db_path("run-cli-size");
    // Trailing whitespace is still the same JSON: pad to the boundary.
    let pad = |n: usize| -> String {
        let mut s = CARGO_SPEC.to_string();
        s.push_str(&" ".repeat(n - CARGO_SPEC.len()));
        assert_eq!(s.len(), n);
        s
    };
    let over = pad(MAX + 1);
    let f = spec_file(&db, "over", &over);
    let (c, e) = accept(&db, &f, "0");
    assert_eq!((c, e["error"].as_str()), (2, Some("BadRequest")), "{e}");
    assert!(
        e["message"]
            .as_str()
            .unwrap()
            .contains("larger than 1048576 bytes"),
        "{e}"
    );
    assert!(!db.exists(), "the store was opened or written");
    let (c, e) = accept_stdin(&db, &over);
    assert_eq!(
        (c, e["error"].as_str()),
        (2, Some("BadRequest")),
        "stdin: {e}"
    );
    assert!(!db.exists());
    // Far over, on both inputs: refused the same way, no store.
    let big = pad(4 * MAX);
    let g = spec_file(&db, "big", &big);
    assert_eq!(accept(&db, &g, "0").0, 2);
    assert_eq!(accept_stdin(&db, &big).0, 2);
    assert!(!db.exists());
    // Not UTF-8: refused, no store.
    let mut bytes = CARGO_SPEC.as_bytes().to_vec();
    bytes.push(0xff);
    let bad = db.with_extension("bad-utf8.json");
    std::fs::write(&bad, &bytes).unwrap();
    let (c, e) = accept(&db, &bad, "0");
    assert_eq!((c, e["error"].as_str()), (2, Some("BadRequest")), "{e}");
    assert!(e["message"].as_str().unwrap().contains("UTF-8"), "{e}");
    assert!(!db.exists());
    // Exactly the limit is accepted, from a file and (as a replay) from stdin.
    let exact = pad(MAX);
    let h = spec_file(&db, "exact", &exact);
    let (c, v) = accept(&db, &h, "0");
    assert_eq!((c, v["accept"].as_str()), (0, Some("Created")), "{v}");
    let (c, v) = accept_stdin(&db, &exact);
    assert_eq!((c, v["accept"].as_str()), (0, Some("Existing")), "{v}");
    assert_eq!(by_state(&db), json!({ "Accepted": 1 }));
}

#[test]
fn runs_accepted_by_the_command_persist_and_the_executor_carries_them_to_the_end() {
    let db = db_path("run-cli-executor");
    let cargo = spec_file(&db, "cargo", CARGO_SPEC);
    let making = spec_file(&db, "making", MAKING_SPEC);
    assert_eq!(accept(&db, &cargo, "0").0, 0);
    assert_eq!(accept(&db, &making, "0").0, 0);
    // Another process reads the same truth.
    let (c, before) = view(&db, CARGO_ID);
    assert_eq!(
        (c, before["state"].as_str(), before["sent"].as_bool()),
        (0, Some("Accepted"), Some(false)),
        "{before}"
    );

    // The executor (MOCK world) opens the same store: both runs are its own
    // (same digests, so Existing, not Conflict), and it carries them to the
    // end. It is stopped and restarted on the same store in between.
    let mut w = SimWorld::new();
    let sc = scene(&mut w);
    let sim = Sim::new(w);
    let mut ex = executor(&db, &sim, "exec-a");
    assert_eq!(
        ex.accept(&spec("make-1", &sc)).unwrap(),
        Accept::Existing(RunState::Accepted)
    );
    assert_eq!(
        ex.accept(&cargo_spec(&sc)).unwrap(),
        Accept::Existing(RunState::Accepted)
    );
    let ids = [CARGO_ID, "make-1"];
    let done = |st: &Store| {
        ids.iter()
            .all(|id| st.load(id).unwrap().unwrap().state.terminal())
    };
    for i in 0..300 {
        if done(&ex.store) {
            break;
        }
        if i == 10 {
            ex = executor(&db, &sim, "exec-a");
        }
        ex.tick().unwrap();
        sim.with(|w| w.advance(1));
    }
    for id in ids {
        let row = ex.store.load(id).unwrap().unwrap();
        assert_eq!(
            row.state,
            RunState::Fulfilled,
            "{id}: {:?} {:?}",
            row.detail,
            ex.store.history(id).unwrap()
        );
        for (from, to, _, _) in ex.store.history(id).unwrap() {
            let (f, t) = (
                RunState::parse(&from).unwrap(),
                RunState::parse(&to).unwrap(),
            );
            assert!(allowed_for(&row.spec, f, t), "{id}: {from} → {to}");
        }
        assert_eq!(ex.store.reservations_of(id).unwrap(), 0);
    }
    sim.with(|w| w.audit()).unwrap();
    sim.with(|w| {
        assert_eq!(w.stores(&sc.dst), res_add(&r(1, 4), &r(6, 3)));
        assert_eq!(w.stores(&sc.stock), r(1, 1));
    });
    drop(ex);

    // The command reports what the executor persisted, in a new process.
    for (id, delivered) in [
        (CARGO_ID, json!([0, 4, 0, 0, 0, 0, 0, 0])),
        ("make-1", json!([0, 0, 0, 0, 0, 0, 3, 0])),
    ] {
        let (c, v) = view(&db, id);
        assert_eq!(c, 0, "{v}");
        assert_eq!(v["state"], json!("Fulfilled"), "{id}: {v}");
        assert_eq!(
            (v["terminal"].as_bool(), v["in_flight"].as_bool()),
            (Some(true), Some(false))
        );
        assert_eq!(
            (v["sent"].as_bool(), v["settled"].as_bool()),
            (Some(true), Some(true)),
            "{id}: {}",
            v["effects"]
        );
        assert_eq!(v["outcome"]["delivered"], delivered, "{id}");
        assert!(
            ["Recorded", "RuleDerived"]
                .contains(&v["outcome"]["verification"].as_str().unwrap_or("")),
            "{id}: a verified amount: {}",
            v["outcome"]
        );
        let effects = v["effects"].as_array().unwrap();
        assert!(
            effects.contains(&json!("caravan_sent")) && effects.contains(&json!("caravan_settled"))
        );
        assert_eq!(v["receipts"].as_array().unwrap().len(), effects.len());
        assert!(
            v["transitions"].as_array().unwrap().len() >= 3,
            "{id}: {}",
            v["transitions"]
        );
        assert!(v["version"].as_i64().unwrap() >= 3);
        let ship: Vec<&Value> = v["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["step"] == json!("ship"))
            .collect();
        assert_eq!(ship.len(), 1, "{id}: {}", v["attempts"]);
        assert_eq!(ship[0]["status"], json!("landed"));
        assert!(ship[0]["sig"].is_string() && ship[0]["valid_until"].is_u64());
        assert!(
            v["fees"]["charged"].as_u64().unwrap() > 0,
            "{id}: {}",
            v["fees"]
        );
        assert!(v["detail"]["ship_seq"].is_u64());
    }
    let (_, cv) = view(&db, CARGO_ID);
    assert_eq!(cv["cargo_only"], json!(true));
    assert_eq!(cv["effects"], json!(["caravan_sent", "caravan_settled"]));
    assert!(
        cv["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["step"] != json!("facility")),
        "no facility request for a cargo-only run"
    );
    assert_eq!(cv["detail"]["fac_attempts"], json!(0));
    let (_, mv) = view(&db, "make-1");
    let mut made: Vec<&str> = mv["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    made.sort_unstable();
    assert_eq!(made, ["caravan_sent", "caravan_settled", "facility_used"]);

    // Submitting the finished run again replays the persisted truth: no
    // new run, no new attempt.
    let (c, again) = accept(&db, &cargo, "0");
    assert_eq!(
        (c, again["accept"].as_str(), again["state"].as_str()),
        (0, Some("Existing"), Some("Fulfilled")),
        "{again}"
    );
    assert_eq!(by_state(&db), json!({ "Fulfilled": 2 }));
}
