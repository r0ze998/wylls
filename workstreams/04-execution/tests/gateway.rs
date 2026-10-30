//! The run's caravan send through the agent wallet's gateway (workstream
//! 03's patch 0005 + workstream 05's patch 0001, applied on this branch),
//! over the loopback test bridge. The gateway is the shared code; its chain
//! is the agent wallet tests' scripted chain and the run's canonical world is
//! the simulated one: **MOCK chain, real gateway code.**
//!
//! Needs `node` and `permutation-gateway/node_modules` (`npm ci` there), so
//! these tests are ignored by default: `cargo test --test gateway -- --ignored`.

mod common;

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use common::*;
use runexec::executor::{CrashPlan, Executor, Halt};
use runexec::gateway::{Agent, GatewayPort};
use runexec::model::*;
use runexec::sim::{Sim, SimWorld};
use runexec::store::{Step, Store};
use serde_json::{json, Value};

struct Bridge {
    child: Child,
    port: u16,
}

impl Bridge {
    fn spawn() -> Bridge {
        let path = format!(
            "{}/bridge/agent-gateway-bridge.mjs",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut child = Command::new("node")
            .arg(path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("node");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port = line
            .trim()
            .strip_prefix("PORT ")
            .expect("bridge port")
            .parse()
            .unwrap();
        Bridge { child, port }
    }

    fn call(&self, method: &str, path: &str, body: Value) -> Value {
        // The port's own client is private; a small one for the test.
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let b = body.to_string();
        write!(s, "{method} {path} HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len()).unwrap();
        let mut raw = String::new();
        s.read_to_string(&mut raw).unwrap();
        serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    fn sent(&self) -> u64 {
        self.call("GET", "/chain", json!({}))["sent"]
            .as_u64()
            .unwrap()
    }

    /// POSTs the gateway received (sends and replays).
    fn actions(&self) -> u64 {
        self.call("GET", "/chain", json!({}))["actions"]
            .as_u64()
            .unwrap()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// The scene at the gateway's village `[-3, 7, 11]`: the owner's holding
/// there (stock) and vault on tile 20 of the same Province (destination).
struct G {
    bridge: Bridge,
    agent: Agent,
    sim: Sim,
    db: std::path::PathBuf,
    ex: Executor<GatewayPort, Sim>,
    stock: PlaceRef,
    dst: PlaceRef,
}

fn port(g_sim: &Sim, bridge: &Bridge, agent: &Agent) -> GatewayPort {
    GatewayPort::new(g_sim.clone(), bridge.port, agent.clone(), OWNER)
}

fn scene(name: &str, setup: Value) -> G {
    let bridge = Bridge::spawn();
    let a = bridge.call("POST", "/setup", setup);
    let agent = Agent {
        agent_id: a["agentId"].as_str().unwrap().into(),
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
        "exec-gw",
        Store::open(&db).unwrap(),
        port(&sim, &bridge, &agent),
        sim.clone(),
    );
    let spec = RunSpec {
        run_id: "g1".into(),
        owner: OWNER,
        stock,
        inbound: None,
        facility,
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
    G {
        bridge,
        agent,
        sim,
        db,
        ex,
        stock,
        dst,
    }
}

impl G {
    fn run(&self) -> runexec::store::RunRow {
        self.ex.store.load("g1").unwrap().unwrap()
    }
    fn drive(&mut self, max: u32) -> Option<Halt> {
        for _ in 0..max {
            let r = self.run();
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
    fn advance_to_facility_confirmed(&mut self) {
        for _ in 0..30 {
            if self.run().state == RunState::FacilityConfirmed {
                return;
            }
            self.ex.tick().unwrap();
            self.sim.with(|w| w.advance(1));
        }
        panic!("never reached FacilityConfirmed");
    }
}

fn assert_shipped_once(g: &G) {
    let row = g.run();
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "{:?} {:?}",
        row.detail.reason,
        row.held
    );
    assert_eq!(
        g.bridge.sent(),
        1,
        "one transaction reached the gateway's chain"
    );
    g.sim.with(|w| {
        assert_eq!(w.stores(&g.dst), r(6, 3));
        assert_eq!(
            w.effects(
                &CaravanKey {
                    owner: OWNER,
                    seq: 0
                }
                .text()
            ),
            1
        );
        w.audit().unwrap();
    });
    let att = g.ex.store.attempts("g1", Step::Ship).unwrap();
    assert!(
        att[0].prepared.sig.starts_with("gw:"),
        "{}",
        att[0].prepared.sig
    );
    let sent =
        g.ex.store
            .receipts("g1")
            .unwrap()
            .into_iter()
            .find(|r| r.kind == "caravan_sent")
            .unwrap();
    assert!(
        !sent.source.contains("gw:"),
        "the receipt names the chain signature: {}",
        sent.source
    );
    check_store(&g.ex.store);
}

#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn gateway_send_fulfils_with_the_signed_content_checked() {
    let mut g = scene("gw-happy", json!({}));
    assert!(g.drive(80).is_none());
    assert_shipped_once(&g);
}

/// The gateway sent, the answer was lost: the run reads the agent's public
/// history, finds the signature, and the re-send of the same key is a
/// replay. One transaction.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn gateway_answer_lost_is_recovered_from_history_without_a_second_send() {
    let mut g = scene("gw-drop", json!({}));
    g.advance_to_facility_confirmed();
    g.ex.chain.faults.lock().unwrap().push_back("drop");
    assert!(g.drive(80).is_none());
    assert_shipped_once(&g);
    assert_eq!(g.run().detail.ship_attempts, 1);
}

/// The process stops after journalling the attempt and before the POST;
/// a restarted executor (a fresh port: nothing in memory) re-sends the same
/// key. One transaction.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn crash_before_the_gateway_call_resends_the_same_key() {
    let mut g = scene("gw-crash", json!({}));
    g.advance_to_facility_confirmed();
    g.ex.crash = Some(CrashPlan::at("ship.before_send", 1));
    assert_eq!(g.ex.tick().err(), Some(Halt::Crashed("ship.before_send")));
    assert_eq!(g.bridge.sent(), 0);
    g.ex = Executor::new(
        "exec-gw",
        Store::open(&g.db).unwrap(),
        port(&g.sim, &g.bridge, &g.agent),
        g.sim.clone(),
    );
    assert!(g.drive(80).is_none());
    assert_shipped_once(&g);
    assert_eq!(g.run().detail.ship_attempts, 1, "the same attempt, re-sent");
}

/// The owner's policy does not allow transport: refused before signing,
/// nothing sent, the run held with the outputs at stock.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn policy_refusal_holds_the_run_with_the_outputs_at_stock() {
    let mut g = scene("gw-refused", json!({ "allowed": ["economy"] }));
    assert!(g.drive(80).is_none());
    let row = g.run();
    assert_eq!(row.state, RunState::FacilityConfirmed);
    assert_eq!(
        row.held.as_deref(),
        Some("GatewayRefused(\"ActionNotAllowed\")")
    );
    assert_eq!(g.bridge.sent(), 0);
    g.sim.with(|w| assert_eq!(w.stores(&g.stock)[6], 3));
}

/// Manual mode (workstream 05's stop): refused (AgentStopped) and held;
/// the owner switches back to auto and resumes; the run re-pins and ships.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn manual_mode_holds_then_auto_and_resume_ship_once() {
    let mut g = scene("gw-manual", json!({}));
    g.advance_to_facility_confirmed();
    g.bridge.call("POST", "/mode", json!({ "mode": "manual" }));
    assert!(g.drive(40).is_none());
    assert_eq!(
        g.run().held.as_deref(),
        Some("GatewayRefused(\"AgentStopped\")")
    );
    assert_eq!(g.bridge.sent(), 0);
    g.bridge.call("POST", "/mode", json!({ "mode": "auto" }));
    assert!(g.ex.store.resume("g1").unwrap());
    assert!(g.drive(80).is_none());
    assert_shipped_once(&g);
    assert_eq!(
        g.run().detail.ship_attempts,
        2,
        "a new attempt (new key) after the hold"
    );
}

/// Workstream 05's patch 0001: the owner's permission ends (`expiresAt`)
/// between the facility and the send: PolicyExpired, held, nothing sent.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn expired_permission_from_patch_0001_holds_the_run() {
    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 1_500;
    let mut g = scene("gw-expired", json!({ "expiresAt": until }));
    g.advance_to_facility_confirmed();
    std::thread::sleep(std::time::Duration::from_millis(1_700));
    assert!(g.drive(40).is_none());
    assert_eq!(
        g.run().held.as_deref(),
        Some("GatewayRefused(\"PolicyExpired\")")
    );
    assert_eq!(g.bridge.sent(), 0);
}

/// The send left and landed, but the gateway's call failed afterwards: its
/// answer (`failed`) names no signature. The caravan exists (the chain has
/// it; the test lands it in the simulated world as the oracle of that
/// chain), yet nothing ties it to the run: held as indeterminate, never a
/// second send, never "in transit" by guess. This is the gap reported to
/// workstreams 03 and 05 (return the signature on a failure after signing).
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn failure_after_signing_without_a_signature_is_held_not_guessed() {
    let mut g = scene("gw-sendthrows", json!({}));
    g.advance_to_facility_confirmed();
    g.ex.chain.faults.lock().unwrap().push_back("sendThrows");
    g.ex.tick().unwrap();
    assert_eq!(g.bridge.sent(), 1, "the transaction left");
    let h = g.bridge.call("GET", "/history", json!({}));
    let failed = h["history"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|e| e["status"] == json!("failed"))
        .cloned();
    assert!(
        failed.is_some_and(|e| e["signature"].is_null()),
        "the gateway records no signature"
    );
    // The oracle: what the scripted chain holds, landed in the simulated world.
    let o = g.bridge.call("GET", "/oracle/sent", json!({}));
    for s in o["signatures"].as_array().unwrap() {
        g.ex.chain.land_from_chain(s.as_str().unwrap()).unwrap();
    }
    g.sim.with(|w| {
        assert_eq!(
            w.caravans.len(),
            1,
            "the caravan exists on the (simulated) chain"
        )
    });
    assert!(g.drive(40).is_none());
    let row = g.run();
    assert_eq!(
        row.held.as_deref(),
        Some("Indeterminate"),
        "{:?}",
        row.state
    );
    assert!(row.state.in_flight());
    assert_eq!(g.bridge.sent(), 1, "no second send");
}

/// The answer is lost and a cancel is requested: the run must not push the
/// request again, so it learns the outcome from the agent's public history
/// (read-only): the caravan left, the cancel is recorded as too late, and
/// the gateway received exactly one call.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn lost_answer_under_cancel_is_read_from_history_not_resent() {
    let mut g = scene("gw-drop-cancel", json!({}));
    g.advance_to_facility_confirmed();
    g.ex.chain.faults.lock().unwrap().push_back("drop");
    g.ex.tick().unwrap(); // pins, POSTs once, answer dropped
    assert_eq!(g.bridge.actions(), 1);
    assert!(g.run().state.in_flight());
    g.ex.store.request_cancel("g1").unwrap();
    assert!(g.drive(80).is_none());
    assert_eq!(
        g.bridge.actions(),
        1,
        "no second call: the outcome came from the history"
    );
    let row = g.run();
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.held);
    assert_eq!(
        row.cancel_phase(),
        Some(CancelPhase::Ineffective {
            at: "InTransit".into()
        })
    );
    assert_eq!(g.bridge.sent(), 1);
}

/// A run whose stock is not the agent's village: refused before any gateway
/// call or signature, held, nothing sent.
#[test]
#[ignore = "needs node and permutation-gateway/node_modules; run with --ignored"]
fn source_other_than_the_village_is_refused_before_any_call() {
    let bridge = Bridge::spawn();
    let a = bridge.call("POST", "/setup", json!({}));
    let agent = Agent {
        agent_id: a["agentId"].as_str().unwrap().into(),
        policy_version: 1,
        village: (-3, 7, 11),
    };
    let stock = vault(-3, 7, 21);
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
    let mut ex = Executor::new(
        "exec-gw",
        Store::open(&db_path("gw-src")).unwrap(),
        port(&sim, &bridge, &agent),
        sim.clone(),
    );
    let spec_ = RunSpec {
        run_id: "g1".into(),
        owner: OWNER,
        stock,
        inbound: None,
        facility,
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
    ex.accept(&spec_).unwrap();
    for _ in 0..60 {
        ex.tick().unwrap();
        sim.with(|w| w.advance(1));
    }
    let row = ex.store.load("g1").unwrap().unwrap();
    assert_eq!(
        row.held.as_deref(),
        Some("GatewayRefused(\"SourceNotVillage\")")
    );
    assert_eq!(bridge.actions(), 0);
    assert_eq!(bridge.sent(), 0);
}
