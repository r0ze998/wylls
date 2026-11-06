//! What the archived history covers (`RpcPoll::coverage`), on JSON-RPC
//! stand-in nodes whose histories have gaps mixed in: at the start (G1), at
//! the archive's last signature or in the cursor (G2), in the middle behind
//! a kept last signature (G3). Three outcomes are kept apart: a detected gap
//! (the pull stops, nothing archived, `gap`), an archived range nothing
//! checked (`unverifiable`, with the reasons), and nothing archived
//! (`not_fetched`, which is not an empty history). Without an origin anchor
//! or a witness the G1/G3 limits stand, asserted as `unverifiable`.
//!
//! Keyless: signatures are fixed byte patterns, transactions three opaque
//! bytes; nothing is generated, derived or signed.

use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use findex::ingest::{reason, COVERAGE_LIMIT};
use findex::{Findex, RpcPoll, Source};
use serde_json::{json, Value};
use solana_address::Address;

/// A node: its whole history, signatures oldest first with their slots.
#[derive(Clone, Default)]
struct Node {
    txs: Arc<Mutex<Vec<(String, u64)>>>,
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

/// A node serving `slots` (one transaction per slot, `sig(i)` at slot i).
async fn node(slots: &[u8]) -> (Node, String) {
    let n = Node::default();
    put(&n, slots);
    let url = start(n.clone()).await;
    (n, url)
}

fn put(n: &Node, slots: &[u8]) {
    let mut t = n.txs.lock().unwrap();
    t.clear();
    t.extend(slots.iter().map(|&i| (sig(i), i as u64)));
}

fn sig(i: u8) -> String {
    fclient::ports::Signature::from([i; 64]).to_string()
}

fn signature(i: u8) -> fclient::ports::Signature {
    fclient::ports::Signature::from([i; 64])
}

fn program() -> Address {
    Address::new_from_array([1; 32])
}

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("findex-cov-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn open(name: &str) -> Findex {
    Findex::open(&tmp(name), program(), None, 1 << 20).unwrap()
}

fn slots(f: &Findex) -> Vec<u64> {
    f.archive
        .read_after(0)
        .unwrap()
        .into_iter()
        .map(|r| r.slot)
        .collect()
}

/// One pull: the archived slots, or the error text.
async fn pull(f: &mut Findex, poll: &mut RpcPoll) -> Result<Vec<u64>, String> {
    f.ingest(poll)
        .await
        .map(|v| v.into_iter().map(|r| r.slot).collect())
        .map_err(|e| e.to_string())
}

fn state(p: &RpcPoll) -> String {
    p.coverage()["state"].as_str().unwrap().to_string()
}

fn reasons(p: &RpcPoll) -> Vec<String> {
    p.coverage()["unverifiable"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["reason"].as_str().unwrap().to_string())
        .collect()
}

fn range(p: &RpcPoll) -> Value {
    p.coverage()["range"].clone()
}

/// A port nothing listens on (bound, then released).
fn dead_url() -> String {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let a = l.local_addr().unwrap();
    drop(l);
    format!("http://{a}")
}

// ---------------------------------------------------------------- nothing

/// Nothing archived is `not_fetched` with no range, never an empty
/// history; every report carries the limit of what RPC can show.
#[tokio::test]
async fn nothing_fetched_is_not_an_empty_history() {
    let (_n, url) = node(&[]).await;
    let mut f = open("none");
    let mut poll = RpcPoll::new(url, program());
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![]));
    let c = poll.coverage();
    assert_eq!(c["state"], "not_fetched");
    assert_eq!(c["range"], Value::Null);
    assert_eq!(c["limit"], COVERAGE_LIMIT);
}

// ---------------------------------------------------------------- G1

/// G1 without an anchor or witness: the pruned start is still archived
/// without an error (one node cannot reveal it), but the coverage says the
/// range is unverifiable, from where, and why.
#[tokio::test]
async fn g1_a_pruned_start_without_anchor_is_archived_as_unverifiable() {
    let (_n, url) = node(&[3, 4, 5, 6]).await; // 1 and 2 pruned
    let mut f = open("g1-plain");
    let mut poll = RpcPoll::new(url, program());
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![3, 4, 5, 6]));
    assert_eq!(state(&poll), "unverifiable");
    assert_eq!(range(&poll), json!({"firstSlot": 3, "lastSlot": 6}));
    let r = reasons(&poll);
    assert!(
        r.contains(&reason::FIRST_PULL_UNANCHORED.to_string()),
        "{r:?}"
    );
    assert!(r.contains(&reason::NO_WITNESS.to_string()), "{r:?}");
}

/// G1 with the origin anchor: a node that pruned the start stops the first
/// pull (nothing archived, `gap`); a node that holds the whole history then
/// fills the archive from the origin, and the start is no longer a reason.
#[tokio::test]
async fn g1_the_origin_anchor_stops_a_first_pull_that_misses_the_start() {
    let (n, url) = node(&[3, 4, 5, 6]).await;
    let mut f = open("g1-origin");
    let mut poll = RpcPoll::new(url, program()).with_origin(signature(1));
    let e = pull(&mut f, &mut poll).await.unwrap_err();
    assert!(e.contains("history gap") && e.contains("origin"), "{e}");
    assert_eq!(slots(&f), Vec::<u64>::new(), "nothing archived");
    assert_eq!(state(&poll), "gap");
    assert_eq!(range(&poll), Value::Null);
    // A node with the full history (an archival endpoint) is put in place.
    put(&n, &[1, 2, 3, 4, 5, 6]);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2, 3, 4, 5, 6]));
    assert_eq!(range(&poll), json!({"firstSlot": 1, "lastSlot": 6}));
    assert_eq!(reasons(&poll), vec![reason::NO_WITNESS.to_string()]);
}

/// An origin that is not the oldest signature the node holds is an error
/// too (a wrong anchor must not pass as a checked start).
#[tokio::test]
async fn g1_an_origin_with_older_history_before_it_stops() {
    let (_n, url) = node(&[1, 2, 3]).await;
    let mut f = open("g1-wrong");
    let mut poll = RpcPoll::new(url, program()).with_origin(signature(2));
    let e = pull(&mut f, &mut poll).await.unwrap_err();
    assert!(e.contains("older than the origin"), "{e}");
    assert_eq!(slots(&f), Vec::<u64>::new());
}

/// G1 caught by a witness with longer history (no anchor): the first pull
/// stops; the missing start was not archived as if it never happened.
#[tokio::test]
async fn g1_a_witness_with_the_start_stops_the_first_pull() {
    let (_p, url) = node(&[3, 4, 5, 6]).await;
    let (_w, wurl) = node(&[1, 2, 3, 4, 5, 6]).await;
    let mut f = open("g1-witness");
    let mut poll = RpcPoll::new(url, program()).with_witness(wurl);
    let e = pull(&mut f, &mut poll).await.unwrap_err();
    assert!(e.contains("history gap") && e.contains("witness"), "{e}");
    assert_eq!(slots(&f), Vec::<u64>::new());
    assert_eq!(state(&poll), "gap");
}

// ---------------------------------------------------------------- G2

/// G2: the node no longer holds the archive's last signature: the pull
/// stops and the coverage shows the gap; the archived range stays.
#[tokio::test]
async fn g2_losing_the_last_archived_signature_shows_a_gap() {
    let (n, url) = node(&[1, 2]).await;
    let mut f = open("g2-last");
    let mut poll = RpcPoll::new(url, program()).with_origin(signature(1));
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2]));
    put(&n, &[5, 6]);
    let e = pull(&mut f, &mut poll).await.unwrap_err();
    assert!(e.contains("history gap"), "{e}");
    let c = poll.coverage();
    assert_eq!(c["state"], "gap");
    assert_eq!(c["range"], json!({"firstSlot": 1, "lastSlot": 2}));
    assert!(c["gap"].as_str().unwrap().contains("no longer reaches"));
    assert_eq!(slots(&f), vec![1, 2]);
}

/// G2: an archive with records whose cursor cannot be read is refused,
/// not taken for a first pull (which would archive the node's history again
/// after it, or start late). The refusal survives a failed enrichment's
/// rewind (it is in the cursor) and a restart (resume).
#[tokio::test]
async fn g2_an_unreadable_cursor_is_refused_not_restarted() {
    let (_n, url) = node(&[1, 2, 3]).await;
    for bad in [
        json!({}),
        json!({"feed_after": 2}),
        json!({"rpc_last": "not a signature"}),
        json!({"cursor_missing_after_seq": 2}),
    ] {
        let mut f = open("g2-cursor");
        let mut poll = RpcPoll::new(url.clone(), program());
        poll.restore(&bad);
        let e = pull(&mut f, &mut poll).await.unwrap_err();
        assert!(e.contains("cursor cannot be read"), "{bad}: {e}");
        assert_eq!(state(&poll), "gap", "{bad}");
        assert_eq!(slots(&f), Vec::<u64>::new(), "{bad}");
        // Its own cursor carries the refusal.
        let c = poll.cursor();
        let mut again = RpcPoll::new(url.clone(), program());
        again.restore(&c);
        assert!(pull(&mut f, &mut again).await.is_err(), "{bad}");
    }
    // A fresh poller's own cursor and `null` (an empty archive) are first
    // pulls, not refusals.
    for fresh in [RpcPoll::new(url.clone(), program()).cursor(), Value::Null] {
        let mut f = open("g2-fresh");
        let mut poll = RpcPoll::new(url.clone(), program());
        poll.restore(&fresh);
        assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2, 3]), "{fresh}");
    }
}

/// An archive written before coverage was recorded (a cursor without it)
/// resumes, but its range is reported unverifiable for that reason.
#[tokio::test]
async fn g2_an_older_cursor_resumes_as_unverifiable() {
    let (_n, url) = node(&[1, 2, 3]).await;
    let mut f = open("g2-old");
    let mut poll = RpcPoll::new(url, program()).with_origin(signature(1));
    poll.restore(&json!({"rpc_last": sig(1), "rpc_last_slot": 1, "rpc_last_slot_sigs": [sig(1)]}));
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![2, 3]));
    assert_eq!(state(&poll), "unverifiable");
    assert!(reasons(&poll).contains(&reason::BEFORE_COVERAGE.to_string()));
    assert_eq!(range(&poll), json!({"firstSlot": null, "lastSlot": 3}));
}

// ---------------------------------------------------------------- G3

/// G3 without a witness (⑯'s case): the middle gap is not seen, 5 and 6
/// are archived after 2; the coverage does not claim the range is checked.
#[tokio::test]
async fn g3_a_middle_gap_without_witness_is_reported_unverifiable() {
    let (n, url) = node(&[1, 2]).await;
    let mut f = open("g3-plain");
    let mut poll = RpcPoll::new(url, program()).with_origin(signature(1));
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2]));
    put(&n, &[1, 2, 5, 6]); // 3 and 4 lost by this node's long-term store
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![5, 6]));
    assert_eq!(state(&poll), "unverifiable");
    assert_eq!(reasons(&poll), vec![reason::NO_WITNESS.to_string()]);
}

/// G3 with a witness: the witness holds 3 and 4, which the node skipped:
/// the pull stops, nothing past 2 is archived. Once the node serves the
/// range the archive continues without the gap, cross-checked.
#[tokio::test]
async fn g3_a_witness_stops_a_middle_gap_and_the_range_fills_later() {
    let (n, url) = node(&[1, 2]).await;
    let (w, wurl) = node(&[1, 2]).await;
    let mut f = open("g3-witness");
    let mut poll = RpcPoll::new(url, program())
        .with_origin(signature(1))
        .with_witness(wurl);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2]));
    assert_eq!(state(&poll), "cross_checked");
    put(&n, &[1, 2, 5, 6]);
    put(&w, &[1, 2, 3, 4, 5, 6]);
    for _ in 0..2 {
        let e = pull(&mut f, &mut poll).await.unwrap_err();
        assert!(e.contains("history gap") && e.contains("witness"), "{e}");
        assert_eq!(state(&poll), "gap");
    }
    assert_eq!(slots(&f), vec![1, 2], "nothing archived past the gap");
    put(&n, &[1, 2, 3, 4, 5, 6]);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![3, 4, 5, 6]));
    assert_eq!(slots(&f), vec![1, 2, 3, 4, 5, 6]);
    let c = poll.coverage();
    assert_eq!(c["state"], "cross_checked");
    assert_eq!(c["gap"], Value::Null);
    assert_eq!(
        c["limit"], COVERAGE_LIMIT,
        "cross-checked is still not a proof"
    );
}

/// A witness that cannot be read does not stop the archive, but the range
/// it should have checked is unverifiable.
#[tokio::test]
async fn an_unreadable_witness_leaves_the_range_unverifiable() {
    let (_n, url) = node(&[1, 2, 3]).await;
    let mut f = open("w-dead");
    let mut poll = RpcPoll::new(url, program())
        .with_origin(signature(1))
        .with_witness(dead_url());
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2, 3]));
    assert_eq!(
        reasons(&poll),
        vec![reason::WITNESS_UNAVAILABLE.to_string()]
    );
}

/// A witness behind the node: the batch is archived up to the witness's
/// newest slot; past it the pull waits; a witness that stays behind does not
/// stop the archive for good, but what it did not check is unverifiable.
#[tokio::test]
async fn a_witness_behind_holds_the_batch_then_marks_it() {
    let (_n, url) = node(&[1, 2, 3, 4]).await;
    let (_w, wurl) = node(&[1, 2]).await;
    let mut f = open("w-behind");
    let mut poll = RpcPoll::new(url, program())
        .with_origin(signature(1))
        .with_witness(wurl);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![1, 2]));
    assert_eq!(state(&poll), "cross_checked");
    let mut waited = 0;
    let got = loop {
        let got = pull(&mut f, &mut poll).await.unwrap();
        if !got.is_empty() {
            break got;
        }
        waited += 1;
        assert!(waited <= 64, "a stuck witness must not stop the archive");
    };
    assert!(waited >= 1);
    assert_eq!(got, vec![3, 4]);
    assert_eq!(state(&poll), "unverifiable");
    assert_eq!(reasons(&poll), vec![reason::WITNESS_LACKS.to_string()]);
}

// ---------------------------------------------------------------- restart

/// The coverage is kept in the archived cursor: a restart reports the same
/// range and reasons (an unverifiable range does not become checked by
/// restarting).
#[tokio::test]
async fn coverage_survives_a_restart() {
    let (n, url) = node(&[3, 4]).await;
    let dir = tmp("restart");
    let before = {
        let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
        let mut poll = RpcPoll::new(url.clone(), program());
        assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![3, 4]));
        f.commit().unwrap();
        poll.coverage()
    };
    put(&n, &[3, 4, 5]);
    let mut f = Findex::open(&dir, program(), None, 1 << 20).unwrap();
    let mut poll = RpcPoll::new(url, program());
    f.resume(&mut poll);
    assert_eq!(poll.coverage(), before);
    assert_eq!(pull(&mut f, &mut poll).await, Ok(vec![5]));
    assert_eq!(range(&poll), json!({"firstSlot": 3, "lastSlot": 5}));
    assert!(reasons(&poll).contains(&reason::FIRST_PULL_UNANCHORED.to_string()));
}

/// `Enriched` reports the inner source's coverage (what `/h/status` shows).
#[tokio::test]
async fn enriched_reports_the_inner_coverage() {
    let (_n, url) = node(&[]).await;
    let e = findex::Enriched::new(RpcPoll::new(url.clone(), program()), url, program());
    assert_eq!(e.coverage().unwrap()["state"], "not_fetched");
}
