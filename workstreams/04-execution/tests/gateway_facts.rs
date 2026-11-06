//! The run's caravan send through the agent wallet's gateway, with the
//! gateway's answers **scripted** (a loopback stub in this file stands in for
//! the bridge): no node, no keys, nothing signed. It checks the contract the
//! port reads since workstream 04's gateway change (2026-11-06): every answer
//! says whether signed bytes left (`sent`), a signed one carries its
//! signature, lifetime and signing time, also when it failed after signing,
//! and `GET /fate?key=` gives the chain's word (finalized-only, proved
//! expiry, `unknown` for "cannot prove", `unqueryable` for "could not ask").
//!
//! The SendCaravan bytes the stub serves for a signature are encoded from the
//! request the run sent (frontier-abi), so the port lands exactly what the run
//! asked for in the simulated world.

mod common;

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use common::*;
use runexec::executor::Executor;
use runexec::gateway::{Agent, GatewayPort};
use runexec::model::*;
use runexec::sim::{Sim, SimWorld};
use runexec::store::Store;
use serde_json::{json, Value};

/// How the stub answers the next POST /action.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Answer {
    Sent,
    /// The bytes left, signed, and the call failed afterwards.
    FailedSigned,
    /// Nothing left (a fault before sending).
    FailedUnsent,
    /// An older gateway: `failed`, no `sent`, no signature.
    FailedOld,
}

#[derive(Default)]
struct Script {
    answer: VecDeque<Answer>,
    /// `/fate` answers in order (the last one repeats); `"http500"` fails the read.
    fate: VecDeque<&'static str>,
    /// Per transaction, in the order they were signed: its own `/fate`
    /// answers (overrides `fate` for that key; a proved expiry stays one).
    fate_per_tx: Vec<VecDeque<&'static str>>,
    /// key → index into `fate_per_tx`.
    key_tx: HashMap<String, usize>,
    /// POSTs received (a replay of a key counts here, not in `txs`).
    actions: u32,
    /// Transactions the stub "signed" (new keys only).
    txs: u32,
    /// key → the cached answer (the gateway's idempotency replay).
    cached: HashMap<String, Value>,
    /// signature → the SendCaravan data the stub "signed".
    data: HashMap<String, Vec<u8>>,
    /// key → history entry.
    history: Vec<Value>,
}

struct Stub {
    port: u16,
    s: Arc<Mutex<Script>>,
}

fn body_of(raw: &str) -> Value {
    serde_json::from_str(raw.split_once("\r\n\r\n").map(|x| x.1).unwrap_or(""))
        .unwrap_or(Value::Null)
}

fn caravan_data(f: &Value) -> Vec<u8> {
    let bytes = |v: &Value, n: usize| -> Vec<u8> {
        let mut b: Vec<u8> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u8)
            .collect();
        b.resize(n, 0);
        b
    };
    frontier_abi::v2::ix::SendCaravan {
        seq: f["seq"].as_u64().unwrap() as u32,
        dst_kind: f["dst_kind"].as_u64().unwrap() as u8,
        dst_p: f["dst_p"].as_i64().unwrap() as i16,
        dst_q: f["dst_q"].as_i64().unwrap() as i16,
        dst_at: f["dst_at"].as_u64().unwrap() as u8,
        dst_gen: f["dst_gen"].as_u64().unwrap() as u8,
        steps: f["steps"].as_u64().unwrap() as u8,
        path: bytes(&f["path"], 12).try_into().unwrap(),
        cargo: bytes(&f["cargo"], 32).try_into().unwrap(),
        fee: f["fee"].as_str().unwrap().parse().unwrap(),
    }
    .to_bytes()
    .to_vec()
}

impl Stub {
    fn spawn(s: Script) -> Stub {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let s = Arc::new(Mutex::new(s));
        let st = s.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { continue };
                let mut buf = vec![0u8; 65536];
                let mut raw = String::new();
                // Read the head and the declared body.
                loop {
                    let n = c.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some((head, rest)) = raw.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|h| {
                                h.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if rest.len() >= len {
                            break;
                        }
                    }
                }
                let line = raw.lines().next().unwrap_or("").to_string();
                let (code, out) = Stub::route(&st, &line, &raw);
                let b = out.to_string();
                let _ = write!(c, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len());
            }
        });
        Stub { port, s }
    }

    fn route(st: &Arc<Mutex<Script>>, line: &str, raw: &str) -> (u16, Value) {
        let mut s = st.lock().unwrap();
        let path = line.split_whitespace().nth(1).unwrap_or("");
        if line.starts_with("POST /action") {
            s.actions += 1;
            let req = body_of(raw)["request"].clone();
            let key = req["idempotencyKey"].as_str().unwrap().to_string();
            if let Some(c) = s.cached.get(&key) {
                // The same request again: the gateway replays its answer, sends nothing.
                let mut c = c.clone();
                c["replayed"] = json!(true);
                return (200, c);
            }
            let a = s.answer.pop_front().unwrap_or(Answer::Sent);
            if !matches!(a, Answer::FailedUnsent) {
                s.txs += 1;
                let i = s.txs as usize - 1;
                s.key_tx.insert(key.clone(), i);
            }
            let sig = format!("sig{}", s.actions);
            let signed = json!({ "sent": true, "signature": sig, "lastValidBlockHeight": 5000, "slotFloor": 4000, "signedAt": 1_762_000_000_000u64 });
            let (res, entry) = match a {
                Answer::Sent => {
                    s.data
                        .insert(sig.clone(), caravan_data(&req["action"]["fields"]));
                    let mut r = json!({ "ok": true, "status": "sent" });
                    r.as_object_mut()
                        .unwrap()
                        .extend(signed.as_object().unwrap().clone());
                    (r.clone(), r)
                }
                Answer::FailedSigned => {
                    s.data
                        .insert(sig.clone(), caravan_data(&req["action"]["fields"]));
                    let mut r = json!({ "ok": false, "status": "failed", "error": { "code": "SendFailed" } });
                    r.as_object_mut()
                        .unwrap()
                        .extend(signed.as_object().unwrap().clone());
                    (r.clone(), r)
                }
                Answer::FailedUnsent => {
                    let r = json!({ "ok": false, "status": "failed", "sent": false, "error": { "code": "SendFailed" } });
                    (r.clone(), r)
                }
                Answer::FailedOld => {
                    let r = json!({ "ok": false, "status": "failed", "error": { "code": "SendFailed" } });
                    (r.clone(), r)
                }
            };
            let mut e = entry;
            e["key"] = json!(key);
            e["type"] = json!("action");
            if let Some(c) = e["error"]["code"].as_str() {
                e["code"] = json!(c);
            }
            s.history.push(e);
            s.cached.insert(key, res.clone());
            return (200, res);
        }
        if path == "/history" {
            return (200, json!({ "history": s.history }));
        }
        if let Some(q) = path.strip_prefix("/tx?sig=") {
            return match s.data.get(q) {
                Some(d) => (
                    200,
                    json!({ "found": true, "data": hex::encode(d), "srcIsVillage": true }),
                ),
                None => (200, json!({ "found": false })),
            };
        }
        if let Some(key) = path.strip_prefix("/fate?key=") {
            let key = key.to_string();
            let i = s.key_tx.get(&key).copied();
            let q = match i {
                Some(i) if i < s.fate_per_tx.len() => &mut s.fate_per_tx[i],
                _ => &mut s.fate,
            };
            let st = if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                *q.front().unwrap_or(&"pending")
            };
            if st == "http500" {
                return (500, json!({ "error": "boom" }));
            }
            let e = s
                .history
                .iter()
                .rev()
                .find(|e| e["key"] == json!(key.as_str()))
                .cloned();
            let mut out = json!({ "state": st, "why": format!("scripted {st}") });
            if let Some(e) = e {
                for k in ["signature", "lastValidBlockHeight", "slotFloor", "signedAt"] {
                    out[k] = e[k].clone();
                }
            }
            out["commitment"] = match st {
                "landed" | "failed" => json!("finalized"),
                "pending" => json!("confirmed"),
                _ => Value::Null,
            };
            return (200, out);
        }
        (404, json!({ "error": "no such route" }))
    }

    fn actions(&self) -> u32 {
        self.s.lock().unwrap().actions
    }
    fn txs(&self) -> u32 {
        self.s.lock().unwrap().txs
    }
}

struct G {
    stub: Stub,
    sim: Sim,
    ex: Executor<GatewayPort, Sim>,
    dst: PlaceRef,
}

fn scene(name: &str, script: Script) -> G {
    let stub = Stub::spawn(script);
    let agent = Agent {
        agent_id: "agent-x".into(),
        policy_version: 1,
        village: (-3, 7, 11),
    };
    let stock = holding(-3, 7, 11);
    let dst = vault(-3, 7, 20);
    let facility = FacilityRef {
        place: holding(-3, 8, 2),
        recipe: 1,
    };
    let mut w = SimWorld::new();
    w.add_place(stock, OWNER, r(1, 10), None);
    w.add_place(dst, OWNER, ZERO, Some(1_000));
    w.add_place(facility.place, OTHER, ZERO, None);
    w.grant(OWNER, facility, 10, 10_000);
    let sim = Sim::new(w);
    let db = db_path(name);
    let ex = Executor::new(
        "exec-gwf",
        Store::open(&db).unwrap(),
        GatewayPort::new(sim.clone(), stub.port, agent, OWNER),
        sim.clone(),
    );
    let spec = RunSpec {
        run_id: "g1".into(),
        owner: OWNER,
        stock,
        inbound: None,
        facility: Some(facility),
        inputs: r(1, 5),
        outputs: r(6, 3),
        rights_units: 1,
        ship: ShipSpec {
            dst,
            cargo: r(6, 3),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    };
    ex.accept(&spec).unwrap();
    G { stub, sim, ex, dst }
}

impl G {
    fn run(&self) -> runexec::store::RunRow {
        self.ex.store.load("g1").unwrap().unwrap()
    }
    fn reach_facility_confirmed(&mut self) {
        for _ in 0..30 {
            if self.run().state == RunState::FacilityConfirmed {
                return;
            }
            self.ex.tick().unwrap();
            self.sim.with(|w| w.advance(1));
        }
        panic!("never reached FacilityConfirmed");
    }
    /// Ticks until terminal, held, or `max`; returns how many ticks errored.
    fn drive(&mut self, max: u32) -> u32 {
        let mut errs = 0;
        for _ in 0..max {
            let r = self.run();
            if r.state.terminal() || r.held.is_some() {
                break;
            }
            if self.ex.tick().is_err() {
                errs += 1;
            }
            self.sim.with(|w| w.advance(1));
        }
        errs
    }
    fn ship_handle(&self) -> String {
        let atts = self
            .ex
            .store
            .attempts("g1", runexec::store::Step::Ship)
            .unwrap();
        atts.iter()
            .rev()
            .find(|a| a.prepared.sig.starts_with("gw:"))
            .unwrap()
            .prepared
            .sig
            .clone()
    }
}

/// A plain send: finalized landed → the caravan is the run's, delivered once.
#[test]
fn sent_and_finalized_is_fulfilled_once() {
    let mut g = scene(
        "gwf-sent",
        Script {
            fate: VecDeque::from(["pending", "landed"]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(60);
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?}",
        row.detail.reason,
        row.held
    );
    assert_eq!(g.stub.txs(), 1, "one transaction signed");
    g.sim.with(|w| assert_eq!(w.stores(&g.dst), r(6, 3)));
    let f = g.ex.chain.facts(&g.ship_handle()).unwrap();
    assert_eq!(f.state, "landed");
    let s = f.signed.unwrap();
    assert_eq!(
        (
            s.signature.as_str(),
            s.last_valid_block_height,
            s.slot_floor,
            s.signed_at
        ),
        ("sig1", Some(5000), Some(4000), Some(1_762_000_000_000))
    );
    assert_eq!(f.commitment.as_deref(), Some("finalized"));
}

/// The bytes left and the call failed afterwards: the answer now names the
/// signature, so the run follows the chain's word instead of holding as
/// indeterminate — and never sends a second time.
#[test]
fn failure_after_signing_is_followed_by_its_signature() {
    let mut g = scene(
        "gwf-failsigned",
        Script {
            answer: VecDeque::from([Answer::FailedSigned]),
            fate: VecDeque::from(["pending", "pending", "landed"]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(60);
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?}",
        row.detail.reason,
        row.held
    );
    assert_eq!(
        g.stub.txs(),
        1,
        "no second transaction (a re-send of the same key is the gateway's replay)"
    );
    g.sim
        .with(|w| assert_eq!(w.stores(&g.dst), r(6, 3), "delivered once"));
}

/// Past its lifetime and not provably absent (`unknown`): held, not guessed,
/// not re-sent. (A failure after signing, so the simulated world has no
/// caravan from the answer itself.)
#[test]
fn result_unknown_holds_as_indeterminate() {
    let mut g = scene(
        "gwf-unknown",
        Script {
            answer: VecDeque::from([Answer::FailedSigned]),
            fate: VecDeque::from(["unknown"]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(60);
    let row = g.run();
    assert_eq!(
        row.held.as_deref(),
        Some("Indeterminate"),
        "{:?}",
        row.state
    );
    assert!(row.state.in_flight());
    assert_eq!(g.stub.txs(), 1);
    let f = g.ex.chain.facts(&g.ship_handle()).unwrap();
    assert_eq!(f.state, "unknown");
    assert_eq!(
        f.signed.unwrap().signature,
        "sig1",
        "the receipt still names the signature"
    );
}

/// The fate read itself fails: the port says "could not ask" (a port
/// error), the run neither advances nor re-sends, and resumes when the read
/// answers again.
#[test]
fn unqueryable_is_a_read_failure_not_an_outcome() {
    let mut g = scene(
        "gwf-unqueryable",
        Script {
            fate: VecDeque::from(["http500", "http500", "http500", "landed"]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    let errs = g.drive(60);
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?} (tick errors {errs})",
        row.detail.reason,
        row.held
    );
    assert_eq!(g.stub.txs(), 1, "a failed read is no reason to send again");
}

/// Proved never to land (`expired`): the attempt is absent, and the run
/// makes one new attempt (a new key, a new transaction), which lands.
#[test]
fn proved_expiry_allows_one_new_attempt() {
    let mut g = scene(
        "gwf-expired",
        Script {
            answer: VecDeque::from([Answer::FailedSigned, Answer::Sent]),
            fate_per_tx: vec![
                VecDeque::from(["expired"]),
                VecDeque::from(["pending", "landed"]),
            ],
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(80);
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?}",
        row.detail.reason,
        row.held
    );
    let keys: Vec<String> = g
        .stub
        .s
        .lock()
        .unwrap()
        .history
        .iter()
        .map(|e| format!("{}={}", e["key"], e["status"]))
        .collect();
    let atts: Vec<(String, String)> =
        g.ex.store
            .attempts("g1", runexec::store::Step::Ship)
            .unwrap()
            .iter()
            .map(|a| (a.prepared.sig.clone(), a.status.clone()))
            .collect();
    assert_eq!(g.stub.txs(), 2, "the expired attempt was replaced by exactly one new one; posts {} history {keys:?} attempts {atts:?}", g.stub.actions());
    g.sim
        .with(|w| assert_eq!(w.stores(&g.dst), r(6, 3), "delivered once"));
}

/// Nothing left the gateway (`sent: false`): absent, never indeterminate.
#[test]
fn failure_before_sending_is_absent() {
    let mut g = scene(
        "gwf-unsent",
        Script {
            answer: VecDeque::from([Answer::FailedUnsent, Answer::Sent]),
            fate: VecDeque::from(["not-sent", "landed"]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(80);
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?}",
        row.detail.reason,
        row.held
    );
    assert_eq!(
        g.stub.txs(),
        1,
        "the first try sent nothing; the second one is the only transaction"
    );
}

/// An older gateway (no `sent`, no signature on a failure): as before, held
/// as indeterminate.
#[test]
fn older_gateway_failure_is_still_held() {
    let mut g = scene(
        "gwf-old",
        Script {
            answer: VecDeque::from([Answer::FailedOld]),
            ..Default::default()
        },
    );
    g.reach_facility_confirmed();
    g.drive(60);
    let row = g.run();
    assert_eq!(
        row.held.as_deref(),
        Some("Indeterminate"),
        "{:?}",
        row.state
    );
    assert_eq!(g.stub.txs(), 1);
}
