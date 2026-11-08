//! The local node's feed read in pages (⑲, 2026-11-08): a pull that fails
//! part-way (a transport error, a page that repeats or goes back, a record
//! of another program, a ledger that grows or rewinds between pages) must
//! not leave the feed's cursor past records it did not hand back. The
//! herald's loop calls `ingest` again after a failed pull with the same
//! source, so a cursor left past them archives the next records after a
//! hole, and the archived cursor then moves past it for good.
//!
//! Keyless: a JSON-RPC stand-in (`frontier_feed` with and without the scan,
//! `frontier_status`) that pages its answers and fails or misbehaves on
//! chosen calls; fixed byte-pattern signatures; unsigned zero-signature
//! transactions. Nothing is generated, derived or signed.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use fclient::ports::Signature;
use findex::ingest::LocalnetFeed;
use findex::ledger::{join, Part};
use findex::Findex;
use serde_json::{json, Value};
use solana_address::Address;

fn a() -> Address {
    Address::new_from_array([0xA1; 32])
}
fn b() -> Address {
    Address::new_from_array([0xB2; 32])
}
fn sig(i: u8) -> Signature {
    Signature::from([i; 64])
}

/// An unsigned legacy transaction calling `p` (zero-filled signature slot,
/// a fixed payer address: no key, no signature).
fn wire(p: &Address, s: u8) -> Vec<u8> {
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
    fclient::tx::wire(&fclient::Transaction::new_unsigned(m))
}

/// What a chosen `frontier_feed` call does instead of answering.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Misbehave {
    /// A JSON-RPC error.
    Fail,
    /// The page starts again with the record before `after` (a repeat).
    Repeat,
    /// The page's records come newest first.
    Reverse,
    /// One record of another program in the page.
    Foreign,
}

#[derive(Clone)]
struct Node {
    ledger: Arc<Mutex<Vec<(u8, Address)>>>,
    /// Records per `frontier_feed` answer.
    page: usize,
    scan: bool,
    calls: Arc<AtomicUsize>,
    /// `(n, what)`: the n-th `frontier_feed` call (1-based) misbehaves.
    plan: Arc<Mutex<Vec<(usize, Misbehave)>>>,
}

impl Node {
    fn new(entries: &[(u8, Address)], page: usize, scan: bool) -> Node {
        Node {
            ledger: Arc::new(Mutex::new(entries.to_vec())),
            page,
            scan,
            calls: Arc::new(AtomicUsize::new(0)),
            plan: Arc::new(Mutex::new(vec![])),
        }
    }
    fn on(&self, n: usize, what: Misbehave) {
        self.plan.lock().unwrap().push((n, what));
    }
}

fn rec(seq: u64, s: u8, p: &Address) -> Value {
    json!({"seq": seq, "slot": seq, "signature": sig(s).to_string(), "blockTime": 0,
           "tx": base64::engine::general_purpose::STANDARD.encode(wire(p, s)), "logs": [], "err": null,
           "units": 0, "fee": 0, "post": []})
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let led = n.ledger.lock().unwrap().clone();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if method == "frontier_status" {
        return Json(json!({"jsonrpc": "2.0", "id": id, "result":
            {"runId": "run1", "transactions": led.len(), "ledgerBytes": 100 * led.len()}}));
    }
    if method != "frontier_feed" {
        return Json(json!({"jsonrpc": "2.0", "id": id, "result": null}));
    }
    let k = n.calls.fetch_add(1, Ordering::SeqCst) + 1;
    let what = n
        .plan
        .lock()
        .unwrap()
        .iter()
        .find(|(c, _)| *c == k)
        .map(|(_, w)| *w);
    if what == Some(Misbehave::Fail) {
        return Json(
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "stand-in: page lost"}}),
        );
    }
    let after = p.get(0).and_then(|x| x.as_u64()).unwrap_or(0);
    let want: Option<Address> = p
        .get(2)
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok());
    let mut picked: Vec<(u64, u8, Address)> = led
        .iter()
        .enumerate()
        .map(|(i, (s, pr))| (i as u64 + 1, *s, *pr))
        .filter(|(seq, _, pr)| *seq > after && want.is_none_or(|w| w == *pr))
        .take(n.page)
        .collect();
    let scanned = picked.last().map_or(led.len() as u64, |x| {
        if picked.len() == n.page {
            x.0
        } else {
            led.len() as u64
        }
    });
    match what {
        Some(Misbehave::Repeat) if after > 0 => {
            let (s, pr) = led[after as usize - 1];
            picked.insert(0, (after, s, pr));
        }
        Some(Misbehave::Reverse) => picked.reverse(),
        Some(Misbehave::Foreign) => {
            if let Some(x) = picked.first_mut() {
                x.2 = b();
            }
        }
        _ => {}
    }
    let txs: Vec<Value> = picked.iter().map(|(q, s, pr)| rec(*q, *s, pr)).collect();
    let asked = p.get(3).and_then(|o| o.get("scan")) == Some(&json!(true));
    let result = if asked && n.scan {
        let at_after = (after > 0)
            .then(|| {
                led.get(after as usize - 1)
                    .map(|(s, _)| sig(*s).to_string())
            })
            .flatten();
        json!({"txs": txs, "scannedThrough": scanned, "ledgerLen": led.len(), "atAfter": at_after,
               "runId": "run1", "ledgerBytes": 100 * led.len(), "durable": true})
    } else {
        json!(txs)
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

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("findex-ws19-pages-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Seven entries of program A (one of B between): seq 1..8.
fn ledger() -> Vec<(u8, Address)> {
    vec![
        (11, a()),
        (12, a()),
        (13, b()),
        (14, a()),
        (15, a()),
        (16, a()),
        (17, a()),
        (18, a()),
    ]
}

fn feed_seqs(f: &Findex) -> Vec<u64> {
    f.archive
        .read_after_feed(0)
        .unwrap()
        .into_iter()
        .map(|(_, s)| s.unwrap())
        .collect()
}

/// The herald's loop: ingest until a pull archives nothing, carrying on
/// after a failed pull with the same source (as `runner::run` does).
async fn herald_loop(f: &mut Findex, src: &mut LocalnetFeed<fclient::rpc::RpcPort>) -> Vec<String> {
    let mut errors = vec![];
    for _ in 0..20 {
        match f.ingest(src).await {
            Ok(v) if v.is_empty() => break,
            Ok(_) => {}
            Err(e) => errors.push(e.to_string()),
        }
    }
    errors
}

async fn run(n: Node, name: &str) -> (Findex, Vec<String>, String) {
    let url = start(n).await;
    let mut f = Findex::open(&tmp(name), a(), None, 1 << 20).unwrap();
    let mut src = LocalnetFeed::new(fclient::rpc::RpcPort::localnet(&url, a()))
        .with_ledger("run1")
        .with_program(a());
    f.resume(&mut src);
    let errors = herald_loop(&mut f, &mut src).await;
    (f, errors, url)
}

const ALL_A: [u64; 7] = [1, 2, 4, 5, 6, 7, 8];

/// A page lost in transit part-way through a pull: the pull fails, nothing
/// it read is skipped, and the next pull archives every record once.
#[tokio::test]
async fn a_page_lost_part_way_skips_nothing() {
    for scan in [true, false] {
        let n = Node::new(&ledger(), 2, scan);
        n.on(2, Misbehave::Fail);
        let (f, errors, _) = run(n, &format!("lost-{scan}")).await;
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(feed_seqs(&f), ALL_A, "scan {scan}: once each, no hole");
    }
}

/// A page that repeats the record before its start, or comes out of order,
/// or carries another program's record: the pull fails on it and skips
/// nothing; once the node answers properly every record is archived once.
#[tokio::test]
async fn a_repeated_reordered_or_foreign_page_skips_nothing() {
    for what in [Misbehave::Repeat, Misbehave::Reverse, Misbehave::Foreign] {
        let n = Node::new(&ledger(), 2, true);
        n.on(2, what);
        let (f, errors, _) = run(n, &format!("bad-{what:?}")).await;
        assert!(!errors.is_empty(), "{what:?} is refused");
        assert_eq!(feed_seqs(&f), ALL_A, "{what:?}: once each, no hole");
    }
}

/// Failures on several pages of one ledger, and the ledger growing between
/// the reads: every record once, in ledger order; the archive then joins
/// whole (cursor, start and ledger recorded).
#[tokio::test]
async fn several_lost_pages_and_a_growing_ledger_leave_no_hole() {
    let n = Node::new(&ledger(), 2, true);
    n.on(2, Misbehave::Fail);
    n.on(4, Misbehave::Fail);
    n.ledger.lock().unwrap().push((19, a()));
    let (f, errors, _) = run(n.clone(), "several").await;
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert_eq!(feed_seqs(&f), vec![1, 2, 4, 5, 6, 7, 8, 9]);
    let j = join(&[Part::of_archive("A", &f.archive).unwrap()]);
    assert!(j.whole(), "{:?}", j.problems);
}

/// A failed pull followed by a restart from the durable archive: the
/// reopened store resumes from its cursor and the records come once.
#[tokio::test]
async fn a_failed_pull_then_a_restart_skips_nothing() {
    let n = Node::new(&ledger(), 2, true);
    n.on(3, Misbehave::Fail);
    let url = start(n).await;
    let dir = tmp("restart");
    {
        let mut f = Findex::open(&dir, a(), None, 1 << 20).unwrap();
        let mut src = LocalnetFeed::new(fclient::rpc::RpcPort::localnet(&url, a()))
            .with_ledger("run1")
            .with_program(a());
        f.resume(&mut src);
        // One good pull and the failing one, then the process stops.
        let _ = f.ingest(&mut src).await;
        let _ = f.ingest(&mut src).await;
        f.commit().unwrap();
    }
    let mut f = Findex::open(&dir, a(), None, 1 << 20).unwrap();
    let mut src = LocalnetFeed::new(fclient::rpc::RpcPort::localnet(&url, a()))
        .with_ledger("run1")
        .with_program(a());
    f.resume(&mut src);
    let errors = herald_loop(&mut f, &mut src).await;
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(feed_seqs(&f), ALL_A);
}
