//! Live feeds and archives retain ledger numbers but remain unproven:
//! status/feed reads are not an atomic snapshot.
//!
//! Keyless: a JSON-RPC stand-in over a plain socket (`frontier_feed`,
//! `frontier_status`), fixed byte-pattern signatures, opaque transactions;
//! no check runs (the verdict rule is applied to a hand-built report).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use fclient::ports::{Signature, TxRecord};
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use verify_core::history::{apply, History, Source};
use verify_core::input;
use verify_core::{Counts, Liveness, Report, Verdict};

fn prog() -> Address {
    Address::new_from_array([0xA1; 32])
}
fn other() -> Address {
    Address::new_from_array([0xB2; 32])
}
fn sig(i: u8) -> Signature {
    Signature::from([i; 64])
}

/// An unsigned legacy transaction calling `p` (zero-filled signature slot,
/// a fixed payer address: no key, no signature), base64.
fn base64_wire(p: &Address, s: u8) -> String {
    use base64::Engine;
    let ix = fclient::Instruction {
        program_id: *p,
        accounts: vec![],
        data: vec![s],
    };
    let budget = fclient::tx::TxBudget {
        cu_limit: 200_000,
        cu_price: 0,
        loaded_limit: 1 << 20,
        heap: None,
    };
    let m = fclient::tx::message(
        &[ix],
        &budget,
        &Address::new_from_array([0x99; 32]),
        &fclient::Hash::new_from_array([3; 32]),
    );
    base64::engine::general_purpose::STANDARD
        .encode(fclient::tx::wire(&fclient::Transaction::new_unsigned(m)))
}

#[derive(Clone, Default)]
struct Node {
    runs: Arc<Mutex<Vec<String>>>,
    /// `ledgerBytes` per `frontier_status` call (the last one after); empty:
    /// 100 per ledger entry.
    bytes: Arc<Mutex<Vec<u64>>>,
    status_calls: Arc<AtomicU64>,
    ledger: Arc<Mutex<Vec<(u8, Address)>>>,
}

impl Node {
    /// `runs[k]` and `bytes[k]` answer the k-th `frontier_status` (the last
    /// ones after).
    fn status(&self) -> Value {
        let k = self.status_calls.fetch_add(1, Ordering::SeqCst) as usize;
        let r = self.runs.lock().unwrap();
        let b = self.bytes.lock().unwrap();
        let len = self.ledger.lock().unwrap().len() as u64;
        json!({
            "runId": r[k.min(r.len() - 1)],
            "ledgerBytes": if b.is_empty() { 100 * len } else { b[k.min(b.len() - 1)] },
            "transactions": len,
        })
    }
}

fn answer(n: &Node, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "frontier_feed" => {
            let after = p.get(0).and_then(|x| x.as_u64()).unwrap_or(0);
            let want: Option<Address> = p
                .get(2)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok());
            let led = n.ledger.lock().unwrap().clone();
            json!(led
                .iter()
                .enumerate()
                .map(|(i, e)| (i as u64 + 1, e))
                .filter(|(seq, (_, pr))| *seq > after && want.is_none_or(|w| w == *pr))
                .map(|(seq, (s, pr))| json!({"seq": seq, "slot": seq, "signature": sig(*s).to_string(), "blockTime": 0,
                    "tx": base64_wire(pr, *s), "logs": [], "err": null, "units": 0, "fee": 0, "post": []}))
                .collect::<Vec<_>>())
        }
        "frontier_status" => {
            let status = n.status();
            if status["runId"] == "__unavailable__" {
                return json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32000,"message":"status unavailable"}});
            }
            status
        }
        _ => Value::Null,
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

async fn serve_one(n: Node, mut s: tokio::net::TcpStream) {
    let mut buf = vec![];
    let mut chunk = [0u8; 4096];
    let body = loop {
        let Ok(k) = s.read(&mut chunk).await else {
            return;
        };
        if k == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..k]);
        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
        let len = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buf.len() >= end + 4 + len {
            break buf[end + 4..end + 4 + len].to_vec();
        }
    };
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let out = answer(&n, &req).to_string();
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
        out.len()
    );
    let _ = s.write_all(resp.as_bytes()).await;
    let _ = s.shutdown().await;
}

async fn node(runs: &[&str], ledger: &[(u8, Address)]) -> (Node, String) {
    let n = Node {
        runs: Arc::new(Mutex::new(runs.iter().map(|s| s.to_string()).collect())),
        ledger: Arc::new(Mutex::new(ledger.to_vec())),
        ..Node::default()
    };
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    let m = n.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(serve_one(m.clone(), s));
        }
    });
    (n, format!("http://{addr}"))
}

fn tmp(name: &str) -> std::path::PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let k = N.fetch_add(1, Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("verify-ledger-{name}-{}-{k}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn report() -> Report {
    Report {
        verdict: Verdict::Pass,
        season: 1,
        program: prog().to_string(),
        slot_range: (0, 0),
        entities: 0,
        bells: 0,
        counts: Counts::default(),
        findings: vec![],
        liveness: Liveness::default(),
        checks_run: vec!["V1"],
        provenance: String::new(),
        history: None,
    }
}

fn ledger() -> Vec<(u8, Address)> {
    vec![
        (11, prog()),
        (12, other()),
        (13, other()),
        (14, prog()),
        (15, prog()),
    ]
}

/// Archives the program's feed from the stand-in through findex.
async fn archive(url: &str, run: Option<&str>) -> std::path::PathBuf {
    let d = tmp("arch");
    let mut f = findex::Findex::open(&d, prog(), None, 1 << 20).unwrap();
    let mut s = findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, prog()));
    if let Some(r) = run {
        s = s.with_ledger(r);
    }
    if let Some(b) = findex::ledger::node_status(url)
        .await
        .ok()
        .and_then(|x| x.ledger_bytes)
    {
        s = s.with_ledger_bytes(b);
    }
    f.resume(&mut s);
    while !f.ingest(&mut s).await.unwrap().is_empty() {}
    f.commit().unwrap();
    d.join("archive")
}

/// Ledger numbers survive, but neither live nor archived observations
/// prove a complete snapshot.
#[tokio::test]
async fn a_whole_feed_archive_is_the_ledgers_and_pairs_with_a_live_read() {
    let (_n, url) = node(&["run1"], &ledger()).await;
    let archive_dir = archive(&url, Some("run1")).await;
    let (txs, h) = input::read_archive(&archive_dir).unwrap();
    assert_eq!(
        txs.iter().map(|t| t.seq).collect::<Vec<_>>(),
        vec![1, 4, 5],
        "the ledger numbers, not the archive's 1, 2, 3"
    );
    assert_eq!(
        txs.iter().map(|t| t.signature).collect::<Vec<_>>(),
        vec![sig(11), sig(14), sig(15)]
    );
    assert_eq!(h.source, Source::Unknown);
    assert!(h.detail.contains("rollback"));
    let (live, lh) = input::fetch_txs(&url, &prog(), true, None, None)
        .await
        .unwrap();
    assert_eq!(
        live.iter().map(|t| t.seq).collect::<Vec<_>>(),
        vec![1, 4, 5]
    );
    assert_eq!(lh.source, Source::Unknown);
    assert!(lh.detail.contains("not an atomic ledger snapshot"));
    assert_eq!(apply(&lh, report()).verdict, Verdict::Unverifiable);
    assert_ne!(
        lh, h,
        "an archive not checked against the node does not pair with a live read"
    );
    // Checked against the node: the same ledger, one detail.
    let dir = archive_dir.clone();
    let ch = input::confirm_archive(&dir, &url, h).await.unwrap();
    assert_eq!(ch.source, Source::Unknown);
    assert!(ch.detail.contains("cross-check matched"));
    assert_eq!(apply(&ch, report()).verdict, Verdict::Unverifiable);
}

/// The node's ledger rewound under the same runId after the archive was
/// written (its last transaction's seq now holds another): the archive is
/// not confirmed, the history is unproven (UNVERIFIABLE). A ledger that
/// shrank, or a node that cannot be read, likewise.
#[tokio::test]
async fn an_archive_the_node_no_longer_matches_is_unproven() {
    let (n, url) = node(&["run1"], &ledger()).await;
    let dir = archive(&url, Some("run1")).await;
    let (_, h) = input::read_archive(&dir).unwrap();
    // Same runId, last entry (A's 15 at seq 5) replaced by another program's.
    {
        let mut l = n.ledger.lock().unwrap();
        l.pop();
        l.push((99, other()));
    }
    let ch = input::confirm_archive(&dir, &url, h.clone()).await.unwrap();
    assert_eq!(ch.source, Source::Unknown, "{ch:?}");
    assert!(ch.detail.contains("rewound"), "{}", ch.detail);
    assert_eq!(apply(&ch, report()).verdict, Verdict::Unverifiable);
    // The ledger shorter than when archived.
    n.ledger.lock().unwrap().truncate(3);
    let ch = input::confirm_archive(&dir, &url, h.clone()).await.unwrap();
    assert!(ch.detail.contains("shrank"), "{}", ch.detail);
    assert_eq!(apply(&ch, report()).verdict, Verdict::Unverifiable);
    // A node that cannot be read.
    let dead = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let a = l.local_addr().unwrap();
        drop(l);
        format!("http://{a}")
    };
    let ch = input::confirm_archive(&dir, &dead, h).await.unwrap();
    assert_eq!(ch.source, Source::Unknown);
    assert!(ch.detail.contains("could not be read"), "{}", ch.detail);
    assert_eq!(apply(&ch, report()).verdict, Verdict::Unverifiable);
}

/// A ledger that shrank while it was read live (a rewind between the two
/// `frontier_status` reads, the runId the same) is unproven.
#[tokio::test]
async fn a_ledger_that_shrank_during_a_live_read_is_unproven() {
    let (n, url) = node(&["run1"], &ledger()).await;
    *n.bytes.lock().unwrap() = vec![900, 400];
    let (_, h) = input::fetch_txs(&url, &prog(), true, None, None)
        .await
        .unwrap();
    assert_eq!(h.source, Source::Unknown, "{h:?}");
    assert!(h.detail.contains("shrank"), "{}", h.detail);
    assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);
}

/// An archive without the ledger named (the herald started without
/// `frontier_status`), or written before `feed_seq` was kept, is unproven:
/// never PASS.
#[tokio::test]
async fn an_archive_without_its_ledger_or_numbers_is_unproven() {
    let (_n, url) = node(&["run1"], &ledger()).await;
    let (_, h) = input::read_archive(&archive(&url, None).await).unwrap();
    assert_eq!(h.source, Source::Unknown, "{h:?}");
    assert!(
        h.detail.contains("which ledger it is is not recorded"),
        "{}",
        h.detail
    );
    assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);

    let d = tmp("old");
    {
        let mut a = findex::archive::Archive::open(&d, findex::archive::SEGMENT_BYTES).unwrap();
        let r = TxRecord {
            seq: 1,
            slot: 1,
            signature: sig(11),
            block_time: 0,
            tx: vec![1, 2, 3],
            logs: vec![],
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
        };
        a.append(&[r], json!({"feed_after": 1})).unwrap();
        a.commit().unwrap();
    }
    let (txs, h) = input::read_archive(&d).unwrap();
    assert_eq!(txs.len(), 1);
    assert_eq!(h.source, Source::Unknown);
    for says in ["has no feed_seq", "where the feed started is not recorded"] {
        assert!(h.detail.contains(says), "{says}: {}", h.detail);
    }
    assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);
    // From the cursor alone a feed archive is not known to be whole.
    assert!(History::of_archive(&json!({"feed_after": 1}), true, "x").unproven());
}

/// A ledger that changed while it was read (the node's data rebuilt between
/// the two `frontier_status` reads) is unproven.
#[tokio::test]
async fn a_ledger_that_changed_during_the_read_is_unproven() {
    let (_n, url) = node(&["run1", "run2"], &ledger()).await;
    let (_, h) = input::fetch_txs(&url, &prog(), true, None, None)
        .await
        .unwrap();
    assert_eq!(h.source, Source::Unknown, "{h:?}");
    assert!(h.detail.contains("changed"), "{}", h.detail);
    assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);
}

#[tokio::test]
async fn successful_feed_with_unreadable_status_is_unproven() {
    for runs in [
        vec!["__unavailable__"],
        vec!["run1", "__unavailable__"],
        vec!["__unavailable__", "run1"],
    ] {
        let (_n, url) = node(&runs, &ledger()).await;
        let (txs, h) = input::fetch_txs(&url, &prog(), true, None, None)
            .await
            .unwrap();
        assert!(!txs.is_empty());
        assert_eq!(h.source, Source::Unknown);
        assert!(h.detail.contains("status unavailable"));
        assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);
    }
}

#[tokio::test]
async fn matching_live_status_never_proves_completeness_or_hides_local_failures() {
    for sizes in [vec![500, 500], vec![500, 900]] {
        let (n, url) = node(&["run1"], &ledger()).await;
        *n.bytes.lock().unwrap() = sizes;
        let (txs, h) = input::fetch_txs(&url, &prog(), true, None, None)
            .await
            .unwrap();
        assert_eq!(txs.len(), 3);
        assert_eq!(h.source, Source::Unknown);
        assert_eq!(h.report()["complete"], false);
        assert_eq!(apply(&h, report()).verdict, Verdict::Unverifiable);
        for (check, code) in [
            ("V0", "UnknownInstruction"),
            ("V27", "ResidentJoinMismatch"),
        ] {
            let mut r = report();
            r.verdict = Verdict::Fail;
            r.findings.push(verify_core::Finding {
                check,
                code: code.into(),
                severity: verify_core::Severity::Fail,
                entity: "tx".into(),
                bell: 0,
                signature: String::new(),
                detail: "literal finding".into(),
            });
            let out = apply(&h, r);
            assert_eq!(out.verdict, Verdict::Fail);
            assert!(out
                .findings
                .iter()
                .any(|f| f.check == check && f.code == code));
        }
    }
}
