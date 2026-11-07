//! ⑳'s resident feed over ⑲'s per-program archives of one ledger (V28,
//! 2026-11-07): the resident program's archive and the Frontier program's
//! archive (or a live read of the same node) are one ledger order, and a
//! resident archive that is not the ledger's whole feed, or a different
//! ledger, never shows the resident history whole.
//!
//! Keyless, as ⑲'s `ledger_history.rs` (the stand-in below is copied from
//! it): a JSON-RPC stand-in over a plain socket, fixed byte-pattern
//! signatures, unsigned opaque transactions. No key pair, no signature.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use fclient::ports::Signature;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use verify_core::history::Source;
use verify_core::input;
use verify_core::resident_feed::ResidentFeed;
use verify_core::world::World;

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
    status_calls: Arc<AtomicU64>,
    ledger: Arc<Mutex<Vec<(u8, Address)>>>,
}

impl Node {
    /// `runs[k]` answers the k-th `frontier_status` (the last one after).
    fn run_id(&self) -> String {
        let k = self.status_calls.fetch_add(1, Ordering::SeqCst) as usize;
        let r = self.runs.lock().unwrap();
        r[k.min(r.len() - 1)].clone()
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
        "frontier_status" => json!({"runId": n.run_id()}),
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

/// Archives program `p`'s feed from the stand-in through findex.
async fn archive_of(url: &str, p: Address, run: Option<&str>) -> std::path::PathBuf {
    let d = tmp("arch");
    let mut f = findex::Findex::open(&d, p, None, 1 << 20).unwrap();
    let mut s = findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, p));
    if let Some(r) = run {
        s = s.with_ledger(r);
    }
    f.resume(&mut s);
    while !f.ingest(&mut s).await.unwrap().is_empty() {}
    f.commit().unwrap();
    d.join("archive")
}

/// The game (`prog`) at seqs 1, 4, 6; the resident program (`other`) at 2, 3, 5.
fn two_programs() -> Vec<(u8, Address)> {
    vec![
        (11, prog()),
        (12, other()),
        (13, other()),
        (14, prog()),
        (15, other()),
        (16, prog()),
    ]
}

#[tokio::test]
async fn both_archives_of_one_ledger_are_one_order() {
    let (_n, url) = node(&["run1"], &two_programs()).await;
    let (txs, h) = input::read_archive(&archive_of(&url, prog(), Some("run1")).await).unwrap();
    assert_eq!(txs.iter().map(|t| t.seq).collect::<Vec<_>>(), vec![1, 4, 6]);
    let rf = ResidentFeed::from_archive(
        &archive_of(&url, other(), Some("run1")).await,
        other(),
        BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(rf.history.source, Source::Unknown);
    assert!(rf.history.detail.contains("rollback"));
    assert_eq!(
        rf.txs.iter().map(|t| t.seq).collect::<Vec<_>>(),
        vec![2, 3, 5],
        "ledger numbers"
    );
    assert_eq!(rf.through, 0, "unproven archive claims no complete range");
    let w = World::parse(&prog(), &txs, BTreeMap::new(), 0);
    // Even within its cursor, archive freshness is not established.
    assert!(
        !rf.gaps_before(&w, &h, 6).is_empty(),
        "{:?}",
        rf.gaps_before(&w, &h, 6)
    );
    // ... and not past it: the cursor does not say how far the ledger was
    // scanned, so a later act stays UNVERIFIABLE (never claims more).
    assert!(!rf.gaps_before(&w, &h, 7).is_empty());
    // A live read cannot promote a stale archive to a complete resident feed.
    let (live, lh) = input::fetch_txs(&url, &prog(), true, None, None)
        .await
        .unwrap();
    assert_eq!(lh.source, Source::LedgerFeed);
    let lw = World::parse(&prog(), &live, BTreeMap::new(), 0);
    assert!(!rf.gaps_before(&lw, &lh, 6).is_empty());
}

#[tokio::test]
async fn a_resident_archive_not_the_ledgers_whole_feed_or_of_another_ledger_is_never_whole() {
    let (_n, url) = node(&["run1"], &two_programs()).await;
    let (txs, h) = input::read_archive(&archive_of(&url, prog(), Some("run1")).await).unwrap();
    let w = World::parse(&prog(), &txs, BTreeMap::new(), 0);
    // No ledger named: unknown, never whole.
    let rf = ResidentFeed::from_archive(
        &archive_of(&url, other(), None).await,
        other(),
        BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(rf.history.source, Source::Unknown);
    assert_eq!(rf.through, 0);
    assert!(!rf.gaps_before(&w, &h, 2).is_empty());
    // Another ledger's resident archive (a rebuilt node).
    let (_m, url2) = node(&["run2"], &two_programs()).await;
    let rf2 = ResidentFeed::from_archive(
        &archive_of(&url2, other(), Some("run2")).await,
        other(),
        BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(rf2.history.source, Source::Unknown);
    assert!(rf2.history.detail.contains("ledger run2") && rf2.history.detail.contains("rollback"));
    let why = rf2.gaps_before(&w, &h, 6);
    assert!(
        why.iter()
            .any(|x| x.contains("source (unknown) does not show a whole history")),
        "{why:?}"
    );
}

#[tokio::test]
async fn the_live_resident_feed_names_the_ledger_and_reads_through_the_game_feed() {
    let (_n, url) = node(&["run1"], &two_programs()).await;
    let (txs, h) = input::fetch_txs(&url, &prog(), true, None, None)
        .await
        .unwrap();
    let rf = verify_core::resident_feed::fetch(
        &url,
        &other(),
        &Address::new_from_array([0x76; 32]),
        &txs,
    )
    .await
    .unwrap();
    assert_eq!(rf.history, h, "the same ledger");
    assert_eq!(rf.through, 6, "the last game seq read before it");
    assert_eq!(
        rf.txs.iter().map(|t| t.seq).collect::<Vec<_>>(),
        vec![2, 3, 5]
    );
    let w = World::parse(&prog(), &txs, BTreeMap::new(), 0);
    assert!(rf.gaps_before(&w, &h, 7).is_empty());
    assert!(!rf.gaps_before(&w, &h, 8).is_empty());
}
