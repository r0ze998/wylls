//! What a local ledger's history could not show, by name (⑲, 2026-11-08):
//! `archive_only`, `tail_mismatch`, `prefix_identity_unverified`,
//! `point_in_time_unverified`. A history with any of them is unproven (never
//! PASS): an archive whose tail matches the node is not promoted (no digest
//! shows the ledger's records before the tail are the node's), and a live
//! read is whole only when every read was scanned from a ledger that cannot
//! rewind under its runId and the node was still at the read's ledger point
//! after the final states were read.
//!
//! Keyless: a JSON-RPC stand-in over a plain socket (`frontier_feed` with and
//! without `{"scan": true}`, `frontier_status`), fixed byte-pattern
//! signatures, unsigned zero-signature transactions; no check runs (the
//! verdict rule is applied to a hand-built report). Nothing is generated,
//! derived or signed.

use std::sync::{Arc, Mutex};

use fclient::ports::Signature;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use verify_core::history::{apply, Gap, History, Source};
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
/// a fixed payer address), base64.
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

/// A local node: one ledger; what its scan answers can be set.
#[derive(Clone)]
struct Node {
    run: Arc<Mutex<String>>,
    ledger: Arc<Mutex<Vec<(u8, Address)>>>,
    /// Answers `{"scan": true}` (a node from before the scan does not).
    scan: Arc<Mutex<bool>>,
    durable: Arc<Mutex<bool>>,
    /// Bytes per ledger entry (0: a ledger held only in memory).
    bytes_per: Arc<Mutex<u64>>,
}

impl Node {
    fn bytes(&self) -> u64 {
        *self.bytes_per.lock().unwrap() * self.ledger.lock().unwrap().len() as u64
    }
}

fn answer(n: &Node, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let led = n.ledger.lock().unwrap().clone();
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "frontier_feed" => {
            let after = p.get(0).and_then(|x| x.as_u64()).unwrap_or(0);
            let want: Option<Address> = p
                .get(2)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok());
            let txs: Vec<Value> = led
                .iter()
                .enumerate()
                .map(|(i, e)| (i as u64 + 1, e))
                .filter(|(seq, (_, pr))| *seq > after && want.is_none_or(|w| w == *pr))
                .map(|(seq, (s, pr))| json!({"seq": seq, "slot": seq, "signature": sig(*s).to_string(), "blockTime": 0,
                    "tx": base64_wire(pr, *s), "logs": [], "err": null, "units": 0, "fee": 0, "post": []}))
                .collect();
            let asked = p.get(3).and_then(|o| o.get("scan")) == Some(&json!(true));
            if asked && *n.scan.lock().unwrap() {
                let at_after = (after > 0)
                    .then(|| {
                        led.get(after as usize - 1)
                            .map(|(s, _)| sig(*s).to_string())
                    })
                    .flatten();
                json!({"txs": txs, "scannedThrough": led.len(), "ledgerLen": led.len(), "atAfter": at_after,
                       "runId": *n.run.lock().unwrap(), "ledgerBytes": n.bytes(), "durable": *n.durable.lock().unwrap()})
            } else {
                json!(txs)
            }
        }
        "frontier_status" => {
            json!({"runId": *n.run.lock().unwrap(), "transactions": led.len(), "ledgerBytes": n.bytes()})
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

async fn node(scan: bool, durable: bool, bytes_per: u64) -> (Node, String) {
    let n = Node {
        run: Arc::new(Mutex::new("run1".into())),
        ledger: Arc::new(Mutex::new(vec![
            (11, prog()),
            (12, other()),
            (13, prog()),
            (14, other()),
            (15, prog()),
        ])),
        scan: Arc::new(Mutex::new(scan)),
        durable: Arc::new(Mutex::new(durable)),
        bytes_per: Arc::new(Mutex::new(bytes_per)),
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
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let k = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("verify-assure-{name}-{}-{k}", std::process::id()));
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

fn missing(h: &History) -> Vec<&'static str> {
    h.gaps.iter().map(|g| g.name()).collect()
}

/// The report says the same names and the verdict follows them.
fn verdict(h: &History) -> Verdict {
    let r = apply(h, report());
    let j = r.json();
    let names: Vec<String> = j["history"]["missing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, missing(h), "report.json names what is missing");
    if !h.gaps.is_empty() {
        assert_eq!(j["history"]["basis"], "unproven");
        assert_eq!(j["history"]["complete"], false);
    }
    r.verdict
}

async fn live(url: &str) -> History {
    input::fetch_txs(url, &prog(), true, None, None)
        .await
        .unwrap()
        .1
}

// ------------------------------------------------------------ live reads

/// Scanned throughout, from a synced ledger, and the node still at the read's
/// point after the final states: nothing missing, the verdict stands.
#[tokio::test]
async fn a_scanned_durable_live_read_at_the_final_states_point_can_pass() {
    let (_n, url) = node(true, true, 100).await;
    let mut h = live(&url).await;
    assert_eq!(h.source, Source::LedgerFeed);
    assert_eq!(
        missing(&h),
        vec!["point_in_time_unverified"],
        "until the final states are read"
    );
    assert_eq!(verdict(&h), Verdict::Unverifiable);
    input::seal_point_in_time(&url, &mut h).await;
    assert_eq!(missing(&h), Vec::<&str>::new());
    assert_eq!(verdict(&h), Verdict::Pass);
    let m = h.mark.as_ref().unwrap();
    assert_eq!(
        (m.run_id.as_str(), m.ledger_len, m.ledger_bytes),
        ("run1", 5, Some(500))
    );
}

/// The ledger moved between the history read and the final states: the two
/// are not at one point. Only that is missing.
#[tokio::test]
async fn a_ledger_that_moved_before_the_final_states_is_not_at_one_point() {
    let (n, url) = node(true, true, 100).await;
    let mut h = live(&url).await;
    n.ledger.lock().unwrap().push((16, prog()));
    input::seal_point_in_time(&url, &mut h).await;
    assert_eq!(missing(&h), vec!["point_in_time_unverified"]);
    assert!(h.detail.contains("point in time"), "{}", h.detail);
    assert_eq!(verdict(&h), Verdict::Unverifiable);
    // Another ledger under the node by then: also not one point.
    let (n2, url2) = node(true, true, 100).await;
    let mut h2 = live(&url2).await;
    *n2.run.lock().unwrap() = "run2".into();
    input::seal_point_in_time(&url2, &mut h2).await;
    assert_eq!(missing(&h2), vec!["point_in_time_unverified"]);
}

/// A node that can rewind under the same runId (a ledger on disk not synced
/// before it is served): the records read are not shown to be the ones the
/// node keeps, even with the scan and the point matching.
#[tokio::test]
async fn a_live_read_from_a_ledger_that_can_rewind_lacks_prefix_identity() {
    let (_n, url) = node(true, false, 100).await;
    let mut h = live(&url).await;
    input::seal_point_in_time(&url, &mut h).await;
    assert_eq!(missing(&h), vec!["prefix_identity_unverified"]);
    assert_eq!(verdict(&h), Verdict::Unverifiable);
    // A ledger held only in memory (0 bytes) is lost whole with its process,
    // under a new runId: it cannot rewind under the same one.
    let (_m, url2) = node(true, false, 0).await;
    let mut h2 = live(&url2).await;
    input::seal_point_in_time(&url2, &mut h2).await;
    assert_eq!(missing(&h2), Vec::<&str>::new());
    assert_eq!(verdict(&h2), Verdict::Pass);
}

/// A node from before the scan: neither the prefix identity nor the read's
/// point is known (no extent), so both stay missing.
#[tokio::test]
async fn a_live_read_without_the_scan_shows_neither() {
    let (_n, url) = node(false, true, 100).await;
    let mut h = live(&url).await;
    input::seal_point_in_time(&url, &mut h).await;
    assert_eq!(
        missing(&h),
        vec!["prefix_identity_unverified", "point_in_time_unverified"]
    );
    assert_eq!(verdict(&h), Verdict::Unverifiable);
}

// ------------------------------------------------------------ archives

async fn archive(url: &str) -> std::path::PathBuf {
    let d = tmp("arch");
    let mut f = findex::Findex::open(&d, prog(), None, 1 << 20).unwrap();
    let mut s = findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, prog()))
        .with_ledger("run1");
    f.resume(&mut s);
    while !f.ingest(&mut s).await.unwrap().is_empty() {}
    f.commit().unwrap();
    d.join("archive")
}

/// An archive alone: it says it was not checked against the node, nor its
/// prefix, nor its point; never PASS.
#[tokio::test]
async fn an_archive_alone_names_all_it_cannot_show() {
    let (_n, url) = node(true, true, 100).await;
    let (txs, h) = input::read_archive(&archive(&url).await).unwrap();
    assert_eq!(txs.iter().map(|t| t.seq).collect::<Vec<_>>(), vec![1, 3, 5]);
    assert_eq!(
        missing(&h),
        vec![
            "archive_only",
            "prefix_identity_unverified",
            "point_in_time_unverified"
        ]
    );
    assert_eq!(verdict(&h), Verdict::Unverifiable);
}

/// An archive whose tail matches the node, at the final states' point: the
/// tail match removes `archive_only` and the seal removes the point, but the
/// ledger's records before the tail are still not shown to be the node's:
/// it stays unproven, for that one named reason.
#[tokio::test]
async fn a_matching_tail_does_not_promote_an_archive() {
    let (_n, url) = node(true, true, 100).await;
    let dir = archive(&url).await;
    let (_, h) = input::read_archive(&dir).unwrap();
    let mut c = input::confirm_archive(&dir, &url, h).await.unwrap();
    assert_eq!(c.source, Source::LedgerFeed);
    assert_eq!(c.detail, "ledger run1");
    input::seal_point_in_time(&url, &mut c).await;
    assert_eq!(missing(&c), vec!["prefix_identity_unverified"]);
    assert_eq!(verdict(&c), Verdict::Unverifiable);
}

/// The node rewound under the same runId after the archive was written (its
/// last record's number now holds another transaction): `tail_mismatch`.
#[tokio::test]
async fn a_rewound_node_is_a_tail_mismatch() {
    let (n, url) = node(true, true, 100).await;
    let dir = archive(&url).await;
    let (_, h) = input::read_archive(&dir).unwrap();
    {
        let mut l = n.ledger.lock().unwrap();
        l.pop();
        l.push((99, other()));
    }
    let c = input::confirm_archive(&dir, &url, h).await.unwrap();
    assert_eq!(c.source, Source::Unknown);
    assert_eq!(missing(&c), vec!["tail_mismatch"]);
    assert_eq!(verdict(&c), Verdict::Unverifiable);
}

// ------------------------------------------------------------ fixtures

/// Saved into a fixture, a history keeps what it could not show; a
/// `ledger_feed` saved before gaps were recorded is taken as showing neither
/// the prefix nor the point; a gap this verifier does not know is unknown.
#[test]
fn gaps_survive_a_fixture_and_old_or_foreign_ones_are_never_whole() {
    let h = History::ledger_feed("ledger run1").with_gaps(&[Gap::PointInTimeUnverified]);
    let back = History::from_json(h.to_json().as_ref());
    assert_eq!(back, h);
    let old = History::from_json(Some(
        &json!({"source": "ledger_feed", "detail": "ledger run1"}),
    ));
    assert_eq!(
        missing(&old),
        vec!["prefix_identity_unverified", "point_in_time_unverified"]
    );
    assert!(old.unproven());
    let foreign = History::from_json(Some(
        &json!({"source": "ledger_feed", "detail": "x", "gaps": ["something_new"]}),
    ));
    assert_eq!(foreign.source, Source::Unknown);
    assert!(foreign.unproven());
    // With nothing missing it is the ledger's feed (the verdict stands).
    let whole = History::from_json(Some(
        &json!({"source": "ledger_feed", "detail": "x", "gaps": []}),
    ));
    assert!(!whole.unproven());
}
