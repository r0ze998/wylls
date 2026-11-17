// WRITTEN ONLY (2026-11-17). No test, build, import or syntax command has been run.
// `runexec observe store|db`, run as a separate process. A hand-made findex store directory with synthetic records
// (not chain evidence). No run store is opened, nothing is sent, no key is used.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use frontier_abi::v2::log::{self, AnyKind, CqKind};
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_runexec");

fn body() -> Vec<u8> {
    let k = AnyKind::Cq(CqKind::CARAVAN_SETTLED);
    let mut b = vec![frontier_abi::log::VERSION, k.code()];
    b.extend_from_slice(&9u32.to_le_bytes());
    b.extend_from_slice(&7u64.to_le_bytes());
    b.extend_from_slice(&3u32.to_le_bytes());
    b.resize(6 + k.key_len() + k.payload_len(), 0);
    b.push(0);
    let (off, len) = log::field(k, "dst", true).expect("ABI field");
    let start = 6 + k.key_len() + off;
    b[start..start + len].copy_from_slice(&[2, 3, 0, 0, 0, 4, 1, 4]);
    b
}
fn store(name: &str, rows: u64, next_seq: u64) -> PathBuf {
    let d = std::env::temp_dir().join(format!("runexec-observe-{name}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("archive")).unwrap();
    let db = rusqlite::Connection::open(d.join("index.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
        INSERT INTO meta VALUES('schema',2),('strict_ps2_v2_reject_psw1',1),('strict_ps2_blocked',0);
        CREATE TABLE tx(seq INTEGER PRIMARY KEY, slot INTEGER NOT NULL, sig TEXT NOT NULL, err TEXT);
        CREATE TABLE record(seq INTEGER NOT NULL, idx INTEGER NOT NULL, kind INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(seq, idx));
        CREATE TABLE event(ev INTEGER PRIMARY KEY, seq INTEGER NOT NULL, idx INTEGER NOT NULL);").unwrap();
    for s in 1..=rows {
        db.execute("INSERT INTO tx VALUES(?1, ?2, ?3, NULL)", rusqlite::params![s as i64, (100 + s) as i64, format!("sig{s}")]).unwrap();
        db.execute("INSERT INTO record VALUES(?1, 0, 92, ?2)", rusqlite::params![s as i64, body()]).unwrap();
        db.execute("INSERT INTO event VALUES(?1, ?1, 0)", rusqlite::params![s as i64]).unwrap();
    }
    let m = serde_json::json!({"version": 1, "segment_bytes": 1, "next_seq": next_seq, "cursor": null, "segments": [],
        "observed": [{"from_seq": 1, "source": "rpc_poll", "program_configured": "P", "commitment_requested": "finalized"}]});
    fs::write(d.join("archive/manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
    d
}
fn observe(args: &[&str]) -> (i32, Value) {
    let out = Command::new(BIN).arg("observe").args(args).output().unwrap();
    let line = String::from_utf8(out.stdout).unwrap();
    (out.status.code().unwrap_or(-1), serde_json::from_str(line.trim()).unwrap_or(Value::Null))
}
fn s(p: &Path) -> &str { p.to_str().unwrap() }

#[test]
fn bad_requests_are_refused_before_anything_is_opened() {
    let d = store("bad", 1, 2);
    let st = s(&d);
    for args in [
        vec![], vec!["both"], vec!["store"], vec!["db"],
        vec!["store", "--store"],                                   // no value
        vec!["store", "--store", st, "--store", st],               // repeated
        vec!["store", "--store", st, "--db", st],                  // the other mode's option: no auto-detection
        vec!["db", "--store", st],
        vec!["store", "--store", st, "--verbose", "1"],            // unknown
        vec!["store", "--store", "--limit"],                       // a value that is another option
        vec!["store", "--store", ""], vec!["db", "--db", ""],      // an empty value: a bad request, not an unreadable store
        vec!["store", "--store", st, "--limit", "0"], vec!["store", "--store", st, "--limit", "257"],
        vec!["store", "--store", st, "--limit", "-1"], vec!["store", "--store", st, "--limit", "+5"],
        vec!["store", "--store", st, "--limit", " 5"], vec!["store", "--store", st, "--limit", "5x"],
        vec!["store", "--store", st, "--after", "-1"], vec!["store", "--store", st, "--after", "9223372036854775808"],
        vec!["store", "--store", st, "--after", "99999999999999999999999"],
    ] {
        let (code, v) = observe(&args);
        assert_eq!(code, 2, "{args:?}");
        assert_eq!(v["error"], "BadRequest", "{args:?}");
    }
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_store_that_cannot_be_read_is_observation_not_read_never_no_record() {
    let missing = std::env::temp_dir().join(format!("runexec-observe-missing-{}", std::process::id()));
    let _ = fs::remove_dir_all(&missing);
    for args in [vec!["store", "--store", s(&missing)], vec!["db", "--db", s(&missing.join("index.sqlite"))]] {
        let (code, v) = observe(&args);
        assert_eq!(code, 1, "{args:?}");
        assert_eq!(v["error"], "ObservationNotRead");
        assert_ne!(v["error"], "NoRecord");
    }
    assert!(!missing.exists(), "nothing was created at the path");
}

#[test]
fn store_mode_prints_the_held_page_with_epoch_diagnostics() {
    let d = store("ok", 2, 2);
    let (code, v) = observe(&["store", "--store", s(&d), "--limit", "10"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["format"], "ws04-observation/0");
    assert_eq!(v["basis"], "unproven");
    assert!(v["world"].is_null() && v["finality"].is_null() && v["complete"].is_null());
    assert!(v["held"].as_array().unwrap().iter().any(|h| *h == "store_pairing_is_not_a_snapshot_or_proof"));
    let obs = v["observations"].as_array().unwrap();
    assert_eq!(obs[0]["archive_epoch"]["why"], "covered_by_epoch");
    assert_eq!(obs[1]["archive_epoch"]["why"], "past_manifest_end");
    assert_eq!(v["store"]["generation"], "index_ahead_of_manifest");
    assert!(v["store"]["limits"].as_array().unwrap().iter().any(|l| l.as_str().unwrap_or("").contains("-shm")));
    // the db mode over the same index: the plain page, no store diagnostics
    let (code, w) = observe(&["db", "--db", s(&d.join("index.sqlite"))]);
    assert_eq!(code, 0, "{w}");
    assert!(w.get("store").is_none());
    assert_eq!(w["held"].as_array().unwrap().len(), 3);
    let _ = fs::remove_dir_all(&d);
}

#[cfg(unix)]
#[test]
fn a_path_that_is_not_utf8_is_a_bad_request_in_json_not_a_panic() {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::OsStr::from_bytes(b"/tmp/runexec-observe-\xff\xfe");
    let out = Command::new(BIN).args(["observe", "store", "--store"]).arg(path).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "BadRequest");
}

#[test]
fn observe_is_dispatched_first_and_reaches_no_run_store_or_network_path() {
    let src = include_str!("../src/main.rs");
    let first = src.find("if raw.get(1).and_then(|a| a.to_str()) == Some(\"observe\")").expect("observe dispatch");
    for later in ["== Some(\"run\")", "== Some(\"act\")", "let Some(db) = arg(&args, \"--db\")"] {
        assert!(src.find(later).expect(later) > first, "{later} comes after observe");
    }
    let f = &src[src.find("fn observe(args: &[String])").unwrap()..src.find("fn main() -> ExitCode").unwrap()];
    for forbidden in ["Store::", "open_read_only", "gateway", "intake", "Executor", "Sim", "acts::", "http", "rpc"] {
        assert!(!f.contains(forbidden), "observe reaches {forbidden}");
    }
    assert!(f.contains("read_store_observations") && f.contains("read_observations"));
}
