//! The machine-readable entry to the act registry: the `runexec act`
//! command, run as a separate process the way workstreams 03, 05 and 13
//! call it, against a scripted `GET /f/agent/fate` on loopback. No keys,
//! nothing signed, nothing sent.

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::{Arc, Mutex};

use common::*;
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_runexec");

fn act(db: &std::path::Path, args: &[&str]) -> (i32, Value) {
    let out = Command::new(BIN)
        .arg("act")
        .args(args)
        .arg("--db")
        .arg(db)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().last().unwrap_or("");
    (
        out.status.code().unwrap_or(-1),
        serde_json::from_str(line).unwrap_or(Value::Null),
    )
}

/// A loopback `GET /f/agent/fate?id=&key=` whose answer per (decoded) key
/// is scripted; it records every path it was asked.
struct Fate {
    port: u16,
    asked: Arc<Mutex<Vec<String>>>,
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

impl Fate {
    fn spawn(by_key: HashMap<String, Value>) -> Fate {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(vec![]));
        let a = asked.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { continue };
                // Read the whole head: a client may write it in pieces.
                let mut buf = [0u8; 8192];
                let mut raw = vec![];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    match c.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => raw.extend_from_slice(&buf[..n]),
                    }
                }
                let req = String::from_utf8_lossy(&raw).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                a.lock().unwrap().push(path.clone());
                let key = path
                    .split_once("key=")
                    .map(|x| decode(x.1.split('&').next().unwrap()))
                    .unwrap_or_default();
                let ok = path.starts_with("/f/agent/fate?id=");
                let (code, body) = match by_key.get(&key) {
                    Some(v) if ok => (200, v.clone()),
                    _ => (404, json!({ "error": "UnknownAgent" })),
                };
                let b = body.to_string();
                let _ = write!(c, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len());
            }
        });
        Fate { port, asked }
    }
}

fn signed(state: &str) -> Value {
    json!({ "state": state, "sent": true, "signature": "sigA", "lastValidBlockHeight": 5000, "slotFloor": 4000,
            "signedAt": 1_762_000_000_000u64, "commitment": if state == "landed" { "finalized" } else { "confirmed" }, "why": state })
}

#[test]
fn register_status_and_list_through_the_command() {
    let db = db_path("act-cli-basic");
    let (c, r) = act(
        &db,
        &[
            "register",
            "--agent",
            "agent1",
            "--key",
            "ai:p05.r1",
            "--source",
            "ai",
            "--run",
            "p05-run-1",
            "--slot",
            "7",
        ],
    );
    assert_eq!(c, 0, "{r}");
    let id = r["run4Id"].as_str().unwrap().to_string();
    assert_eq!(
        (
            r["state"].as_str(),
            r["next"].as_str(),
            r["newAttemptAllowed"].as_bool()
        ),
        (Some("registered"), Some("wait"), Some(false))
    );
    // Idempotent; the same id by (agent, key) or by run4Id.
    assert_eq!(
        act(
            &db,
            &[
                "register",
                "--agent",
                "agent1",
                "--key",
                "ai:p05.r1",
                "--source",
                "ai",
                "--run",
                "p05-run-1"
            ]
        )
        .1["run4Id"],
        json!(id)
    );
    assert_eq!(
        act(&db, &["status", "--agent", "agent1", "--key", "ai:p05.r1"]).1["run4Id"],
        json!(id)
    );
    assert_eq!(
        act(&db, &["status", "--run4", &id]).1["runId"],
        json!("p05-run-1")
    );
    let (c, l) = act(&db, &["list", "--run", "p05-run-1"]);
    assert_eq!((c, l["acts"].as_array().unwrap().len()), (0, 1));
}

#[test]
fn refusals_are_machine_readable() {
    let db = db_path("act-cli-refusals");
    let (c, r) = act(
        &db,
        &[
            "register", "--agent", "agent1", "--key", "k", "--source", "nobody",
        ],
    );
    assert_eq!((c, r["error"].as_str()), (2, Some("BadRequest")));
    act(
        &db,
        &[
            "register", "--agent", "agent1", "--key", "k", "--source", "mcp",
        ],
    );
    let (c, r) = act(
        &db,
        &[
            "register", "--agent", "agent1", "--key", "k", "--source", "ai",
        ],
    );
    assert_eq!(
        (c, r["error"].as_str()),
        (4, Some("Conflict")),
        "another source under the same key"
    );
    let (c, r) = act(&db, &["status", "--agent", "agent1", "--key", "never"]);
    assert_eq!(
        (c, r["error"].as_str()),
        (3, Some("NoRecord")),
        "no record is not a state"
    );
    let (c, r) = act(
        &db,
        &[
            "status",
            "--agent",
            "agent1",
            "--key",
            "k",
            "--gateway",
            "not-a-port",
        ],
    );
    assert_eq!((c, r["error"].as_str()), (2, Some("BadRequest")));
}

#[test]
fn the_states_stay_apart_and_only_proved_nothing_allows_a_new_attempt() {
    let db = db_path("act-cli-states");
    let mut m = HashMap::new();
    m.insert("ai:land".to_string(), signed("landed"));
    m.insert("ai:pend".to_string(), signed("pending"));
    m.insert("ai:unk".to_string(), signed("unknown"));
    m.insert("ai:exp".to_string(), signed("expired"));
    m.insert(
        "ai:none".to_string(),
        json!({ "state": "not-sent", "sent": false, "why": "refused before signing" }),
    );
    m.insert(
        "ai:gone".to_string(),
        json!({ "state": "unqueryable", "retained": false, "why": "not kept here" }),
    );
    let f = Fate::spawn(m);
    let port = f.port.to_string();
    let get = |key: &str| {
        act(
            &db,
            &[
                "register", "--agent", "agent/1", "--key", key, "--source", "ai", "--run", "r",
            ],
        );
        let (c, v) = act(
            &db,
            &[
                "status",
                "--agent",
                "agent/1",
                "--key",
                key,
                "--gateway",
                &port,
            ],
        );
        assert_eq!(c, 0, "{v}");
        (
            v["state"].as_str().unwrap().to_string(),
            v["next"].as_str().unwrap().to_string(),
            v["newAttemptAllowed"].as_bool().unwrap(),
            v,
        )
    };
    let (s, n, a, v) = get("ai:land");
    assert_eq!((s.as_str(), n.as_str(), a), ("landed", "done", false));
    assert_eq!(
        (
            v["signature"].as_str(),
            v["commitment"].as_str(),
            v["final"].as_bool()
        ),
        (Some("sigA"), Some("finalized"), Some(true))
    );
    assert_eq!(get("ai:pend").0, "pending");
    let (s, n, a, v) = get("ai:unk");
    assert_eq!(
        (s.as_str(), n.as_str(), a),
        ("unknown", "hold", false),
        "result unknown: never a reason to send again"
    );
    assert_eq!(v["signature"], json!("sigA"));
    let (s, n, a, _) = get("ai:exp");
    assert_eq!(
        (s.as_str(), n.as_str(), a),
        ("expired", "new-attempt", true)
    );
    let (s, n, a, _) = get("ai:none");
    assert_eq!(
        (s.as_str(), n.as_str(), a),
        ("not-sent", "new-attempt", true)
    );
    let (s, n, a, _) = get("ai:gone");
    assert_eq!(
        (s.as_str(), n.as_str(), a),
        ("unqueryable", "read-again", false),
        "not kept by the gateway is not 'not sent'"
    );
    // The agent id and key were sent percent-encoded to the gateway's route.
    assert!(f
        .asked
        .lock()
        .unwrap()
        .iter()
        .any(|p| p == "/f/agent/fate?id=agent%2F1&key=ai%3Aunk"));
}

#[test]
fn an_unreachable_gateway_is_unqueryable_and_keeps_what_was_known() {
    let db = db_path("act-cli-down");
    let mut m = HashMap::new();
    m.insert("mcp:x".to_string(), signed("pending"));
    let f = Fate::spawn(m);
    act(
        &db,
        &[
            "register", "--agent", "a", "--key", "mcp:x", "--source", "mcp",
        ],
    );
    let (_, p) = act(
        &db,
        &[
            "status",
            "--agent",
            "a",
            "--key",
            "mcp:x",
            "--gateway",
            &f.port.to_string(),
        ],
    );
    assert_eq!(p["state"], json!("pending"));
    // A port nothing listens on.
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (c, u) = act(
        &db,
        &[
            "status",
            "--agent",
            "a",
            "--key",
            "mcp:x",
            "--gateway",
            &closed.to_string(),
        ],
    );
    assert_eq!(c, 0);
    assert_eq!(
        (
            u["state"].as_str(),
            u["next"].as_str(),
            u["newAttemptAllowed"].as_bool()
        ),
        (Some("unqueryable"), Some("read-again"), Some(false))
    );
    assert_eq!(
        u["signature"],
        json!("sigA"),
        "the signature is still known"
    );
    assert!(u["lastReadError"].is_string());
    // Without --gateway the stored reading is answered, nothing is read.
    assert_eq!(
        act(&db, &["status", "--agent", "a", "--key", "mcp:x"]).1["state"],
        json!("unqueryable")
    );
}

#[test]
fn final_states_survive_later_contradicting_reads() {
    let db = db_path("act-cli-final");
    let mut first = HashMap::new();
    first.insert("resident:t1:0".to_string(), signed("expired"));
    let f1 = Fate::spawn(first);
    act(
        &db,
        &[
            "register",
            "--agent",
            "res1",
            "--key",
            "resident:t1:0",
            "--source",
            "resident",
        ],
    );
    assert_eq!(
        act(
            &db,
            &[
                "status",
                "--agent",
                "res1",
                "--key",
                "resident:t1:0",
                "--gateway",
                &f1.port.to_string()
            ]
        )
        .1["state"],
        json!("expired")
    );
    let mut later = HashMap::new();
    later.insert("resident:t1:0".to_string(), signed("landed"));
    let f2 = Fate::spawn(later);
    let (_, v) = act(
        &db,
        &[
            "status",
            "--agent",
            "res1",
            "--key",
            "resident:t1:0",
            "--gateway",
            &f2.port.to_string(),
        ],
    );
    assert_eq!(v["state"], json!("expired"));
    assert_eq!(
        v["conflict"]["state"],
        json!("landed"),
        "kept for the operator, not applied"
    );
}

/// Workstream 05's finding: processes registering the same new key at the
/// same moment must all get the same run4Id (exit 0), never a BadRequest
/// from the losing insert; another source under that key is still a
/// Conflict. 8 processes per key, 10 keys, at once.
#[test]
fn concurrent_first_registrations_of_one_key_agree() {
    let db = db_path("act-cli-race");
    // Create the store and table first, as a running executor would have.
    act(&db, &["list", "--run", "none"]);
    let mut fails = vec![];
    let mut ids = std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
    for round in 0..3 {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(80));
        let handles: Vec<_> = (0..80)
            .map(|i| {
                let db = db.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    let key = format!("ai:race{round}.{}", i % 10);
                    b.wait();
                    let r = act(
                        &db,
                        &[
                            "register", "--agent", "a", "--key", &key, "--source", "ai", "--run",
                            "r",
                        ],
                    );
                    (key, r)
                })
            })
            .collect();
        for h in handles {
            let (key, (c, v)) = h.join().unwrap();
            if c == 0 {
                ids.entry(key)
                    .or_default()
                    .insert(v["run4Id"].as_str().unwrap().to_string());
            } else {
                fails.push(format!("{key}: exit {c} {v}"));
            }
        }
    }
    assert!(
        fails.is_empty(),
        "{} of 240 failed: {:?}",
        fails.len(),
        &fails[..fails.len().min(3)]
    );
    assert_eq!(ids.len(), 30);
    assert!(ids.values().all(|s| s.len() == 1), "one run4Id per key");
    let (c, v) = act(
        &db,
        &[
            "register",
            "--agent",
            "a",
            "--key",
            "ai:race0.0",
            "--source",
            "mcp",
            "--run",
            "r",
        ],
    );
    assert_eq!((c, v["error"].as_str()), (4, Some("Conflict")));
}
