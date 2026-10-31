//! Reproductions of the open items the ER candidate reported to the
//! integrator (④): what findex does today, on a JSON-RPC stand-in that can
//! refuse a transaction, drop one from its fork, or fail once. These tests
//! describe current behaviour (they decide no specification); the fixes
//! they motivate are proposals in `docs/frontier/er-candidate/OPEN-ITEMS.ja.md`.
//!
//! The one bug fixed alongside (a transaction lost when a later one of the
//! same batch failed) is asserted as fixed in
//! `a_failure_mid_batch_loses_nothing`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use fclient::ports::PortError;
use findex::{Findex, RpcPoll};
use serde_json::{json, Value};
use solana_address::Address;

/// A node: signatures oldest first with their slots; per-signature
/// `getTransaction` errors `(code, times)` (`times` 0 = always).
#[derive(Clone, Default)]
struct Node {
    txs: Arc<Mutex<Vec<(String, u64)>>>,
    errors: Arc<Mutex<HashMap<String, (i64, u32)>>>,
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let all = n.txs.lock().unwrap().clone();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if method == "getTransaction" {
        let sig = p.get(0).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let mut errs = n.errors.lock().unwrap();
        if let Some((code, times)) = errs.get_mut(&sig) {
            let code = *code;
            if *times == 1 {
                errs.remove(&sig);
            } else if *times > 1 {
                *times -= 1;
            }
            return Json(
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": "refused"}}),
            );
        }
        let result = match all.iter().find(|(s, _)| *s == sig) {
            None => Value::Null,
            Some((_, slot)) => json!({"slot": slot, "blockTime": 7,
                "transaction": [base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]), "base64"],
                "meta": {"err": null, "fee": 5000, "logMessages": [], "computeUnitsConsumed": 9}}),
        };
        return Json(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
    let result = if method == "getSignaturesForAddress" {
        let cfg = p.get(1).cloned().unwrap_or(json!({}));
        let limit = cfg.get("limit").and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
        let mut newest: Vec<&(String, u64)> = all.iter().rev().collect();
        if let Some(b) = cfg.get("before").and_then(|x| x.as_str()) {
            let i = newest
                .iter()
                .position(|(s, _)| s == b)
                .map_or(newest.len(), |i| i + 1);
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
            .map(|(s, slot)| json!({"signature": s, "slot": slot, "err": null, "blockTime": 0}))
            .collect::<Vec<_>>())
    } else {
        Value::Null
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn start(n: Node) -> String {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
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
    let d = std::env::temp_dir().join(format!("findex-open-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Fixed with this item's findex patch: a transaction fetched before a
/// later one of the same batch failed used to be dropped while the
/// in-memory cursor moved past it (the next pull skipped it, and the
/// continuity check saw it as archived). Now the pull returns what it
/// fetched and stops at the failure.
#[tokio::test]
async fn a_failure_mid_batch_loses_nothing() {
    let n = Node::default();
    for i in 1..=3u8 {
        n.txs.lock().unwrap().push((sig(i), i as u64));
    }
    n.errors.lock().unwrap().insert(sig(2), (-32603, 1)); // fails once
    let url = start(n).await;
    let mut f = Findex::open(&tmp("midbatch"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    let mut got = vec![];
    for _ in 0..3 {
        if let Ok(v) = f.ingest(&mut poll).await {
            got.extend(v.into_iter().map(|r| r.slot));
        }
    }
    assert_eq!(
        got,
        vec![1, 2, 3],
        "every transaction archived once, in order"
    );
}

/// Open item 1 (version-1 transactions): a transaction the client cannot
/// request (`maxSupportedTransactionVersion: 0` against a version-1
/// transaction: -32015) stops every pull at it; nothing after it is
/// archived. Reproduced against a local MagicBlock stack too
/// (`rpc_poll_against_a_live_node`, `docs/frontier/er-candidate/results/`).
#[tokio::test]
async fn a_version_1_transaction_stops_every_pull() {
    let n = Node::default();
    for i in 1..=4u8 {
        n.txs.lock().unwrap().push((sig(i), i as u64));
    }
    n.errors.lock().unwrap().insert(sig(3), (-32015, 0)); // always
    let url = start(n).await;
    let mut f = Findex::open(&tmp("v1"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    let mut archived = vec![];
    let mut errors = 0;
    for _ in 0..4 {
        match f.ingest(&mut poll).await {
            Ok(v) => archived.extend(v.into_iter().map(|r| r.slot)),
            Err(findex::IngestError::Port(PortError::Rpc { code: -32015, .. })) => errors += 1,
            Err(e) => panic!("{e}"),
        }
    }
    assert_eq!(
        archived,
        vec![1, 2],
        "stops before the version-1 transaction"
    );
    assert!(errors >= 3, "and fails there on every later pull");
}

/// Open item 3 (confirmed records cannot be withdrawn): a transaction
/// archived at `confirmed` that then leaves the node's history (its fork
/// was dropped) stays in the archive. With the history-continuity check
/// the next pull stops ("history gap": the archive's last signature is
/// gone) instead of archiving past it; nothing marks the archived one as
/// withdrawn.
#[tokio::test]
async fn a_confirmed_transaction_dropped_from_its_fork_stays_archived() {
    let n = Node::default();
    for i in 1..=2u8 {
        n.txs.lock().unwrap().push((sig(i), i as u64));
    }
    let url = start(n.clone()).await;
    let dir = tmp("fork");
    let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    assert_eq!(f.ingest(&mut poll).await.unwrap().len(), 2);
    f.commit().unwrap();
    // The fork holding 2 is dropped; 3 lands on the surviving fork.
    {
        let mut t = n.txs.lock().unwrap();
        t.retain(|(s, _)| *s != sig(2));
        t.push((sig(3), 3));
    }
    let e = f.ingest(&mut poll).await.unwrap_err();
    assert!(
        matches!(&e, findex::IngestError::Port(PortError::Unavailable(m)) if m.starts_with("history gap")),
        "{e}"
    );
    let kept: Vec<u64> = f
        .archive
        .read_after(0)
        .unwrap()
        .into_iter()
        .map(|r| r.slot)
        .collect();
    assert_eq!(
        kept,
        vec![1, 2],
        "the dropped transaction is still archived"
    );
}

/// Open item 5 (archive growth): bytes the archive takes per transaction,
/// for a logs-only transaction and for one whose post-state holds a
/// Province (4,736 B) and a Citizen (384 B), as an RPC-enriched record
/// does. Printed for the report; the archive keeps every one for good.
#[test]
fn archive_bytes_per_transaction() {
    use fclient::ports::{Account, Signature, TxRecord};
    let rec = |seq: u64, post: Vec<(Address, Option<Account>)>| TxRecord {
        seq,
        slot: seq,
        signature: Signature::from([(seq % 250) as u8; 64]),
        block_time: 0,
        tx: vec![7u8; 600],
        logs: vec!["Program log: x".repeat(8); 12],
        err: None,
        code: None,
        units: 50_000,
        fee: 5_000,
        post,
    };
    let acct = |len: usize| {
        Some(Account {
            lamports: 1,
            data: vec![0xA5; len],
            owner: program(),
            executable: false,
        })
    };
    let mut sizes = vec![];
    for (name, post) in [
        ("logs only", vec![]),
        (
            "province + citizen post-state",
            vec![
                (Address::new_from_array([2; 32]), acct(4_736)),
                (Address::new_from_array([3; 32]), acct(384)),
            ],
        ),
    ] {
        let dir = tmp(&format!("growth-{}", name.len()));
        let mut a = findex::Archive::open(&dir, 1 << 30).unwrap();
        let n = 200u64;
        let recs: Vec<TxRecord> = (1..=n).map(|i| rec(i, post.clone())).collect();
        a.append(&recs, json!({})).unwrap();
        a.commit().unwrap();
        let bytes: u64 = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok()?.metadata().ok())
            .map(|m| m.len())
            .sum();
        sizes.push((name, bytes / n));
    }
    eprintln!("archive bytes per transaction: {sizes:?}");
    // A post-state of ~5 KB raw costs several times that in the archive
    // (JSON, base64); the logs-only record is about a kilobyte.
    assert!(sizes[1].1 > 5 * 1_024, "{sizes:?}");
    assert!(sizes[0].1 < sizes[1].1);
}
