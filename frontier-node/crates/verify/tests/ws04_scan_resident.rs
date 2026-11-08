//! Workstream 04 (2026-11-07): the resident program's archive keeps how far
//! the node's ledger was scanned for it (`frontier_feed` with `{"scan":
//! true}`, `feed_scanned`), and the node check validates that extent. On the
//! published candidate (c7b3c54c, the owner's policy) an archive is never
//! whole, even when the node check matches; these tests check that, and that
//! the node check names every inconsistency.
//!
//! Keyless, as ⑳'s `resident_ledger.rs` (the stand-in below is copied from
//! it, with the scan added): a JSON-RPC stand-in over a plain socket, fixed
//! byte-pattern signatures, unsigned opaque transactions. No key pair, no
//! signature.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use fclient::ports::Signature;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
            let txs = json!(led
                .iter()
                .enumerate()
                .map(|(i, e)| (i as u64 + 1, e))
                .filter(|(seq, (_, pr))| *seq > after && want.is_none_or(|w| w == *pr))
                .map(|(seq, (s, pr))| json!({"seq": seq, "slot": seq, "signature": sig(*s).to_string(), "blockTime": 0,
                    "tx": base64_wire(pr, *s), "logs": [], "err": null, "units": 0, "fee": 0, "post": []}))
                .collect::<Vec<_>>());
            if p.get(3).and_then(|o| o.get("scan")) == Some(&json!(true)) {
                json!({"txs": txs, "scannedThrough": led.len(), "ledgerLen": led.len(),
                    "atAfter": (after > 0).then(|| led.get(after as usize - 1)).flatten().map(|(s, _)| sig(*s).to_string()),
                    "runId": n.runs.lock().unwrap().last().cloned(), "ledgerBytes": 100 * led.len(), "durable": true})
            } else {
                txs
            }
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
    let mut s =
        findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, p)).with_program(p);
    if let Some(r) = run {
        s = s.with_ledger(r);
    }
    f.resume(&mut s);
    while !f.ingest(&mut s).await.unwrap().is_empty() {}
    f.commit().unwrap();
    d.join("archive")
}

/// The game (`prog`) at seqs 1, 4, 6, 8; the resident program (`other`) at
/// 2, 3, 5; 7 is a third program's.
fn two_programs() -> Vec<(u8, Address)> {
    vec![
        (11, prog()),
        (12, other()),
        (13, other()),
        (14, prog()),
        (15, other()),
        (16, prog()),
        (17, Address::new_from_array([0xC3; 32])),
        (18, prog()),
    ]
}

/// A resident archive of another ledger, scanned or not, is never whole.
#[tokio::test]
async fn a_scanned_resident_archive_of_another_ledger_is_never_whole() {
    let (_n, url) = node(&["run1"], &two_programs()).await;
    let (txs, h) = input::read_archive(&archive_of(&url, prog(), Some("run1")).await).unwrap();
    let (_m, url2) = node(&["run2"], &two_programs()).await;
    let rf = ResidentFeed::from_archive(
        &archive_of(&url2, other(), Some("run2")).await,
        other(),
        BTreeMap::new(),
    )
    .unwrap();
    let w = World::parse(&prog(), &txs, BTreeMap::new(), 0);
    assert!(!rf.gaps_before(&w, &h, 6).is_empty());
}

/// Rewrites an archive's stored cursor field `k` (a crash or a bad write
/// that left the cursor ahead of the records it covers).
fn tamper_cursor(dir: &std::path::Path, k: &str, v: Value) {
    let mp = dir.join("manifest.json");
    let mut m: Value = serde_json::from_slice(&std::fs::read(&mp).unwrap()).unwrap();
    m["cursor"][k] = v;
    std::fs::write(&mp, serde_json::to_vec_pretty(&m).unwrap()).unwrap();
}

/// The published candidate's policy (c7b3c54c, the owner's): an archive is
/// never whole, even when the node check matches (its tail is not an atomic
/// snapshot of the whole ledger). The scan's extent is still kept and
/// checked: the consistent archive gives the node check nothing to object
/// to, and the feed is still never whole, for any act.
#[tokio::test]
async fn archives_stay_unproven_even_when_the_node_check_matches() {
    let (_n, url) = node(&["run1"], &two_programs()).await;
    let fd = archive_of(&url, prog(), Some("run1")).await;
    let rd = archive_of(&url, other(), Some("run1")).await;
    let (txs, h) = input::read_archive(&fd).unwrap();
    assert!(h.unproven(), "{h:?}");
    let h = input::confirm_archive(&fd, &url, h).await.unwrap();
    assert!(h.unproven(), "{h:?}");
    // ⑲ 2026-11-08: the tail matched; the prefix is still not shown.
    assert!(
        h.gaps
            .contains(&verify_core::history::Gap::PrefixIdentityUnverified),
        "{h:?}"
    );
    assert_eq!(
        txs.iter().map(|t| t.seq).collect::<Vec<_>>(),
        vec![1, 4, 6, 8]
    );
    // The resident archive's extent is the node's scan (8), and the node
    // check of both archives finds nothing.
    let a = findex::archive::Archive::open(&rd, findex::archive::SEGMENT_BYTES).unwrap();
    assert_eq!(a.cursor()["feed_scanned"], 8);
    let parts = [
        findex::ledger::Part::of_archive(
            "G",
            &findex::archive::Archive::open(&fd, findex::archive::SEGMENT_BYTES).unwrap(),
        )
        .unwrap(),
        findex::ledger::Part::of_archive("R", &a).unwrap(),
    ];
    assert!(findex::ledger::check_node(&url, &parts).await.is_empty());
    let mut rf = ResidentFeed::from_archive(&rd, other(), BTreeMap::new()).unwrap();
    rf.history = input::confirm_archive(&rd, &url, rf.history.clone())
        .await
        .unwrap();
    let w = World::parse(&prog(), &txs, BTreeMap::new(), 0);
    for act in [3u64, 6, 9] {
        assert!(!rf.gaps_before(&w, &h, act).is_empty(), "act {act}");
    }
}

/// An archive used without being read again, after a rewind under the same
/// runId (the game archive's last transaction, 8, gone; 6 is now another
/// program's): the node check names it; never whole, alone or checked.
#[tokio::test]
async fn a_stale_archive_is_named_by_the_node_check_and_never_whole() {
    let (n, url) = node(&["run1"], &two_programs()).await;
    let fd = archive_of(&url, prog(), Some("run1")).await;
    let (_txs, h) = input::read_archive(&fd).unwrap();
    assert!(h.unproven());
    {
        let mut l = n.ledger.lock().unwrap();
        l.truncate(5);
        l.push((61, Address::new_from_array([0xC3; 32])));
    }
    let part = findex::ledger::Part::of_archive(
        "G",
        &findex::archive::Archive::open(&fd, findex::archive::SEGMENT_BYTES).unwrap(),
    )
    .unwrap();
    let why = findex::ledger::check_node(&url, std::slice::from_ref(&part)).await;
    assert!(why.iter().any(|w| w.contains("rewound")), "{why:?}");
    let hr = input::confirm_archive(&fd, &url, h).await.unwrap();
    assert!(hr.unproven());
    assert!(
        hr.detail.contains("not confirmed against the node"),
        "{}",
        hr.detail
    );
}

/// 20's condition 4 (2026-11-07): a cursor that says the archive was scanned
/// further than the records it holds (a resident transaction landed at 9
/// after the read, the cursor set to 11 without it) is found by the node
/// check (the program's transaction inside the claimed extent); a claimed
/// extent past the node's ledger is a rewind; a cursor without its program
/// cannot have its extent checked. Never whole in any case.
#[tokio::test]
async fn a_cursor_ahead_of_its_records_is_never_confirmed() {
    let (n, url) = node(&["run1"], &two_programs()).await;
    let rd = archive_of(&url, other(), Some("run1")).await;
    n.ledger.lock().unwrap().push((19, other())); // 9: resident, not archived
    n.ledger.lock().unwrap().push((20, prog())); // 10
    n.ledger.lock().unwrap().push((21, prog())); // 11
    let why = |d: &std::path::Path| {
        let a = findex::archive::Archive::open(d, findex::archive::SEGMENT_BYTES).unwrap();
        findex::ledger::Part::of_archive("R", &a).unwrap()
    };
    tamper_cursor(&rd, "feed_scanned", json!(11));
    let w1 = findex::ledger::check_node(&url, &[why(&rd)]).await;
    assert!(
        w1.iter().any(|w| w.contains("claims more than it holds")),
        "{w1:?}"
    );
    tamper_cursor(&rd, "feed_scanned", json!(40));
    let w2 = findex::ledger::check_node(&url, &[why(&rd)]).await;
    assert!(w2.iter().any(|w| w.contains("rewound")), "{w2:?}");
    tamper_cursor(&rd, "feed_scanned", json!(8));
    tamper_cursor(&rd, "feed_program", Value::Null);
    let w3 = findex::ledger::check_node(&url, &[why(&rd)]).await;
    assert!(w3.iter().any(|w| w.contains("cannot be checked")), "{w3:?}");
    let rf = ResidentFeed::from_archive(&rd, other(), BTreeMap::new()).unwrap();
    let h = input::confirm_archive(&rd, &url, rf.history.clone())
        .await
        .unwrap();
    assert!(h.unproven());
}
