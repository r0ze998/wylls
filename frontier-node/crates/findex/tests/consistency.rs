//! The archive against the node's later history, across restarts and
//! failed saves, on a JSON-RPC stand-in (`Node`). What findex detects and
//! stops on, what a restart recovers, and what it cannot see (asserted as
//! such, so a change is noticed). Covered elsewhere and not repeated: a
//! failed fetch mid-batch and a confirmed transaction dropped from its
//! fork (`open_items.rs`), the history gap and another order within a slot
//! (`ingest.rs`), a crash inside a group commit and herald restarts from
//! checkpoints (`herald/tests/fold.rs`, `herald/tests/cq_fold.rs`).

use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use fclient::ports::PortError;
use findex::{Findex, IngestError, RpcPoll};
use serde_json::{json, Value};
use solana_address::Address;

/// A node: signatures oldest first with their slots.
#[derive(Clone, Default)]
struct Node {
    txs: Arc<Mutex<Vec<(String, u64)>>>,
}

impl Node {
    fn push(&self, i: u8) {
        self.txs.lock().unwrap().push((sig(i), i as u64));
    }
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let all = n.txs.lock().unwrap().clone();
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
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
        }
        _ => Value::Null,
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
    let d = std::env::temp_dir().join(format!("findex-cons-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn slots(f: &Findex) -> Vec<u64> {
    f.archive
        .read_after(0)
        .unwrap()
        .into_iter()
        .map(|r| r.slot)
        .collect()
}

/// Pulls until a pull archives nothing (errors stop the loop too).
async fn drain(f: &mut Findex, poll: &mut RpcPoll) -> Result<(), IngestError> {
    while !f.ingest(poll).await?.is_empty() {}
    Ok(())
}

/// A save that fails after the source moved on (the archive cannot write):
/// findex stops — every later ingest fails until the store is reopened —
/// instead of pulling on past the transactions it could not save (the
/// herald's loop keeps calling `ingest` after an error). Reopening resumes
/// at the durable cursor: every transaction archived once, in order.
#[tokio::test]
async fn a_failed_save_stops_until_reopened_then_resumes_without_a_gap() {
    let n = Node::default();
    for i in 1..=2u8 {
        n.push(i);
    }
    let url = start(n.clone()).await;
    let dir = tmp("save");
    // One record per segment, so the next save creates `seg-000003.log`.
    let mut f = Findex::open(&dir, program(), None, 1).unwrap();
    let mut poll = RpcPoll::new(url, program());
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(slots(&f), vec![1, 2]);
    // The disk refuses the next segment (a directory where the file goes).
    let blocker = dir.join("archive").join("seg-000003.log");
    std::fs::create_dir(&blocker).unwrap();
    n.push(3);
    let e = f.ingest(&mut poll).await.unwrap_err();
    assert!(matches!(e, IngestError::Store(_)), "{e}");
    // The disk recovers at once and more history arrives. Pulling on in the
    // same process would archive 4 after 2: the source had already moved
    // past 3. The store stays stopped instead.
    std::fs::remove_dir(&blocker).unwrap();
    n.push(4);
    for _ in 0..2 {
        let e = f.ingest(&mut poll).await.unwrap_err();
        assert!(
            matches!(&e, IngestError::Store(m) if m.contains("reopen")),
            "{e}"
        );
    }
    assert_eq!(slots(&f), vec![1, 2], "nothing archived past the failure");
    // Restarted (the same poller, resumed): continues from the durable
    // cursor, forgetting what it pulled but could not save.
    drop(f);
    let mut f = Findex::open(&dir, program(), None, 1).unwrap();
    f.resume(&mut poll);
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(slots(&f), vec![1, 2, 3, 4], "once each, in order");
}

/// A crash inside a group commit with the RPC source: the cursor (with the
/// last slot's signatures) is durable only with the frames it covers, so
/// the restart re-pulls the lost tail — no gap, no duplicate.
#[tokio::test]
async fn a_crash_inside_a_group_commit_re_pulls_the_tail_from_the_node() {
    let n = Node::default();
    for i in 1..=3u8 {
        n.push(i);
    }
    let url = start(n.clone()).await;
    let dir = tmp("crash");
    let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
    f.archive.commit_every = std::time::Duration::from_secs(3_600);
    let mut poll = RpcPoll::new(url.clone(), program());
    drain(&mut f, &mut poll).await.unwrap();
    f.commit().unwrap();
    for i in 4..=6u8 {
        n.push(i);
    }
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(slots(&f), vec![1, 2, 3, 4, 5, 6]);
    drop(f); // crash: 4..6 were never committed
    let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
    assert_eq!(slots(&f), vec![1, 2, 3], "the durable archive");
    let mut poll = RpcPoll::new(url, program());
    f.resume(&mut poll);
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(slots(&f), vec![1, 2, 3, 4, 5, 6]);
}

/// After a restart the node's history no longer holds the archive's last
/// transaction (its fork was dropped while the store was down): the first
/// pull stops ("history gap") rather than archiving the other fork after
/// it. The archived transaction is not withdrawn (no automatic rollback);
/// a person decides.
#[tokio::test]
async fn a_restart_then_a_disagreeing_history_stops() {
    let n = Node::default();
    for i in 1..=2u8 {
        n.push(i);
    }
    let url = start(n.clone()).await;
    let dir = tmp("diverge");
    {
        let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
        let mut poll = RpcPoll::new(url.clone(), program());
        drain(&mut f, &mut poll).await.unwrap();
    }
    {
        let mut t = n.txs.lock().unwrap();
        t.retain(|(s, _)| *s != sig(2));
    }
    n.push(3);
    let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    f.resume(&mut poll);
    let e = f.ingest(&mut poll).await.unwrap_err();
    assert!(
        matches!(&e, IngestError::Port(PortError::Unavailable(m)) if m.starts_with("history gap")),
        "{e}"
    );
    assert_eq!(
        slots(&f),
        vec![1, 2],
        "nothing archived past it, nothing withdrawn"
    );
}

/// Limit, asserted as current behaviour: a transaction in the middle of the
/// archive that later leaves the node's history (not the last one) is not
/// noticed — the check only joins the new batch to the last archived
/// signature. The archive keeps it; a record there is no proof it stands.
#[tokio::test]
async fn limit_a_middle_transaction_that_leaves_history_is_not_noticed() {
    let n = Node::default();
    for i in 1..=3u8 {
        n.push(i);
    }
    let url = start(n.clone()).await;
    let mut f = Findex::open(&tmp("middle"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    drain(&mut f, &mut poll).await.unwrap();
    n.txs.lock().unwrap().retain(|(s, _)| *s != sig(2));
    n.push(4);
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(slots(&f), vec![1, 2, 3, 4], "2 stays archived, unnoticed");
}

/// Limit, asserted as current behaviour: the first pull (no cursor) takes
/// whatever history the node still holds; a node that pruned its oldest
/// transactions gives an archive that starts late, unnoticed. Absence of a
/// record is no proof the transaction never happened.
#[tokio::test]
async fn limit_the_first_pull_cannot_see_pruned_history() {
    let n = Node::default();
    for i in 1..=5u8 {
        n.push(i);
    }
    n.txs.lock().unwrap().drain(..2); // pruned 1 and 2
    let url = start(n).await;
    let mut f = Findex::open(&tmp("first"), program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    drain(&mut f, &mut poll).await.unwrap();
    assert_eq!(
        slots(&f),
        vec![3, 4, 5],
        "1 and 2 are absent without an error"
    );
}
