//! ⑯ independent check of ⑲ r2 (c022f4fc): `RpcPoll::coverage` on the G1/G3 scenes of v16_history_gaps.rs.
//! continuity check sees, on a JSON-RPC stand-in node whose history can be
//! pruned at the start, at the archive's last signature, or in the middle.
//!
//! ⑲'s own statement (`findex/src/ingest.rs` header): the check cannot see
//! a gap (i) on the first pull, (ii) after a missing or old-format cursor,
//! (iii) on a node that still holds the last archived signature but lacks a
//! range in the middle; passing it does not prove a complete history. These
//! tests pin (i) and (iii) as the measured limits and check that the case
//! the check claims (the last archived signature gone) stops the pull.

use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use findex::{Findex, RpcPoll};
use serde_json::{json, Value};
use solana_address::Address;

/// Signatures oldest first with their slots (the node's whole history).
#[derive(Clone, Default)]
struct Node {
    txs: Arc<Mutex<Vec<(String, u64)>>>,
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let all = n.txs.lock().unwrap().clone();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let result = match method {
        "getTransaction" => {
            let sig = p.get(0).and_then(|x| x.as_str()).unwrap_or("");
            match all.iter().find(|(s, _)| s == sig) {
                None => Value::Null,
                Some((_, slot)) => json!({"slot": slot, "blockTime": 7,
                    "transaction": [base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]), "base64"],
                    "meta": {"err": null, "fee": 5000, "logMessages": [], "computeUnitsConsumed": 9}}),
            }
        }
        "getSignaturesForAddress" => {
            let cfg = p.get(1).cloned().unwrap_or(json!({}));
            let limit = cfg.get("limit").and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let mut newest: Vec<&(String, u64)> = all.iter().rev().collect();
            if let Some(b) = cfg.get("before").and_then(|x| x.as_str()) {
                let i = newest.iter().position(|(s, _)| s == b).map_or(newest.len(), |i| i + 1);
                newest = newest.split_off(i);
            }
            if let Some(u) = cfg.get("until").and_then(|x| x.as_str()) {
                if let Some(i) = newest.iter().position(|(s, _)| s == u) {
                    newest.truncate(i);
                }
            }
            json!(newest
                .iter()
                .take(limit)
                .map(|(s, slot)| json!({"signature": s, "slot": slot, "err": null, "blockTime": 0, "confirmationStatus": "finalized"}))
                .collect::<Vec<_>>())
        }
        "getMultipleAccounts" => {
            json!({"context": {"slot": 100}, "value": vec![Value::Null; p.get(0).and_then(Value::as_array).map_or(0, Vec::len)]})
        }
        "getSlot" => json!(1000),
        _ => Value::Null,
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn start(n: Node) -> String {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = l.local_addr().unwrap();
    let app = Router::new().route("/", post(rpc)).with_state(n);
    tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    format!("http://{addr}")
}

fn sig(i: u8) -> String {
    fclient::ports::Signature::from([i; 64]).to_string()
}

fn program() -> Address {
    Address::new_from_array([1; 32])
}

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("findex-v16-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn put(n: &Node, slots: &[u8]) {
    let mut t = n.txs.lock().unwrap();
    t.clear();
    t.extend(slots.iter().map(|&i| (sig(i), i as u64)));
}

/// What one pull archived (slots), or the error text.
async fn pull(f: &mut Findex, poll: &mut RpcPoll) -> Result<Vec<u64>, String> {
    f.ingest(poll).await.map(|v| v.into_iter().map(|r| r.slot).collect()).map_err(|e| e.to_string())
}

fn state(poll: &RpcPoll) -> String {
    poll.coverage()["state"].as_str().unwrap_or("?").to_string()
}

#[tokio::test]
async fn v16_c1_g1_default_is_never_reported_complete() {
    let n = Node::default();
    put(&n, &[3, 4, 5, 6]);
    let url = start(n).await;
    let mut f = Findex::open(&tmp("c1"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![3, 4, 5, 6]), "default settings still archive the pruned start");
    assert_eq!(state(&poll), "unverifiable", "{}", poll.coverage());
}

#[tokio::test]
async fn v16_c2_g1_with_the_origin_anchor_stops() {
    let n = Node::default();
    put(&n, &[3, 4, 5, 6]);
    let url = start(n).await;
    let mut f = Findex::open(&tmp("c2"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    poll.origin = Some(fclient::ports::Signature::from([1u8; 64]));
    let got = pull(&mut f, &mut poll).await;
    assert!(got.is_err(), "the first pull must not reach a start it cannot see: {got:?}");
    assert_eq!(state(&poll), "gap", "{}", poll.coverage());
}

#[tokio::test]
async fn v16_c3_g3_default_is_unverifiable_and_with_a_witness_stops() {
    // Default: the middle gap is archived without a signal but not called complete.
    let n = Node::default();
    put(&n, &[1, 2]);
    let url = start(n.clone()).await;
    let mut f = Findex::open(&tmp("c3a"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2]));
    put(&n, &[1, 2, 5, 6]);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![5, 6]));
    assert_ne!(state(&poll), "cross_checked", "{}", poll.coverage());
    // With a witness that holds 3 and 4: the second pull stops.
    let n2 = Node::default();
    put(&n2, &[1, 2]);
    let url2 = start(n2.clone()).await;
    let full = Node::default();
    put(&full, &[1, 2, 3, 4, 5, 6]);
    let wurl = start(full).await;
    let mut f2 = Findex::open(&tmp("c3b"), program(), None, 1 << 20).unwrap();
    let mut poll2 = RpcPoll::new(url2, program()).with_witness(wurl);
    poll2.origin = Some(fclient::ports::Signature::from([1u8; 64]));
    assert_eq!(pull(&mut f2, &mut poll2).await, Ok(vec![1, 2]));
    put(&n2, &[1, 2, 5, 6]);
    let got = pull(&mut f2, &mut poll2).await;
    assert!(got.is_err(), "a witness that holds 3 and 4 must stop the pull: {got:?}");
    assert_eq!(state(&poll2), "gap", "{}", poll2.coverage());
}

#[tokio::test]
async fn v16_c4_control_full_history_with_origin_and_witness_is_cross_checked() {
    let n = Node::default();
    put(&n, &[1, 2, 3, 4]);
    let url = start(n).await;
    let w = Node::default();
    put(&w, &[1, 2, 3, 4]);
    let wurl = start(w).await;
    let mut f = Findex::open(&tmp("c4"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program()).with_witness(wurl);
    poll.origin = Some(fclient::ports::Signature::from([1u8; 64]));
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2, 3, 4]));
    assert_eq!(state(&poll), "cross_checked", "{}", poll.coverage());
    assert!(poll.coverage()["limit"].as_str().is_some(), "the limit is stated");
}
