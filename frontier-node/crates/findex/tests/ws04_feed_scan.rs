//! Workstream 04 (2026-11-07): `frontier_feed` with `{"scan": true}` answers,
//! from the same read as its records, how far it scanned the ledger, the
//! ledger's length, the transaction at the reader's cursor, the ledger's id
//! and its size. Checked here, over two programs' archives of one ledger
//! (A, B and a transaction of both): the normal case, the ledger growing
//! during a read, a rewind under the same runId during a read and between
//! reads, a short history, and a node without the scan. Nothing that cannot
//! be confirmed is taken for whole.
//!
//! Keyless: the node is a JSON-RPC stand-in, signatures are fixed byte
//! patterns, transactions unsigned (zero signature slots); nothing is
//! generated, derived or signed.

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
fn c() -> Address {
    Address::new_from_array([0xC3; 32])
}
fn sig(i: u8) -> Signature {
    Signature::from([i; 64])
}

/// An unsigned transaction calling each of `progs`.
fn wire(progs: &[Address], s: u8) -> Vec<u8> {
    let ixs: Vec<fclient::Instruction> = progs
        .iter()
        .map(|p| fclient::Instruction {
            program_id: *p,
            accounts: vec![],
            data: vec![s],
        })
        .collect();
    let budget = fclient::tx::TxBudget {
        cu_limit: 200_000,
        cu_price: 0,
        loaded_limit: 1 << 20,
        heap: None,
    };
    let m = fclient::tx::message(
        &ixs,
        &budget,
        &Address::new_from_array([0x99; 32]),
        &fclient::Hash::new_from_array([3; 32]),
    );
    fclient::tx::wire(&fclient::Transaction::new_unsigned(m))
}

/// Ledger entries: a signature byte and the programs (none: an airdrop).
type Entries = Vec<(u8, Vec<Address>)>;

/// What the stand-in does after its n-th `frontier_feed` answer.
#[derive(Clone)]
enum After {
    Push(u8, Vec<Address>),
    /// The tail lost (no fsync): `n` entries and their bytes.
    LoseTail(usize),
}

#[derive(Clone, Default)]
struct Node {
    run_id: Arc<Mutex<String>>,
    /// (signature byte, programs); no program: an airdrop.
    ledger: Arc<Mutex<Entries>>,
    /// The ledger's size in bytes (100 per entry).
    bytes: Arc<Mutex<u64>>,
    /// At most this many records per answer (0: no cap).
    cap: Arc<Mutex<usize>>,
    /// Answer the old array form (a node without the scan).
    old: Arc<Mutex<bool>>,
    /// Answer a scanned extent past the ledger's length (an inconsistent node).
    over_scan: Arc<Mutex<bool>>,
    calls: Arc<Mutex<usize>>,
    script: Arc<Mutex<Vec<(usize, After)>>>,
}

impl Node {
    fn new(run: &str, entries: &[(u8, &[Address])]) -> Node {
        let n = Node::default();
        *n.run_id.lock().unwrap() = run.into();
        for (s, p) in entries {
            n.push(*s, p);
        }
        n
    }
    fn push(&self, s: u8, p: &[Address]) {
        self.ledger.lock().unwrap().push((s, p.to_vec()));
        *self.bytes.lock().unwrap() += 100;
    }
    fn lose_tail(&self, k: usize) {
        let mut l = self.ledger.lock().unwrap();
        let n = l.len() - k;
        l.truncate(n);
        *self.bytes.lock().unwrap() -= 100 * k as u64;
    }
    /// Runs `what` right after the `n`-th feed answer (1-based).
    fn after_call(&self, n: usize, what: After) {
        self.script.lock().unwrap().push((n, what));
    }
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "frontier_feed" => {
            let after = p.get(0).and_then(|x| x.as_u64()).unwrap_or(0);
            let mut limit = p.get(1).and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let cap = *n.cap.lock().unwrap();
            if cap > 0 {
                limit = limit.min(cap);
            }
            let prog: Option<Address> = p
                .get(2)
                .and_then(|x| x.as_str())
                .map(|s| s.parse().unwrap());
            let scan = p
                .get(3)
                .and_then(|o| o.get("scan"))
                .and_then(|x| x.as_bool())
                == Some(true);
            let led = n.ledger.lock().unwrap().clone();
            // The same scan as the node's (`localnet::chain::scan_ledger`).
            let (idx, extent) = localnet::chain::scan_ledger(led.len(), after, limit, |i| {
                !led[i].1.is_empty() && prog.is_none_or(|q| led[i].1.contains(&q))
            });
            let txs: Vec<Value> = idx
                .iter()
                .map(|&i| {
                    let (s, ps) = &led[i];
                    json!({"seq": i as u64 + 1, "slot": i as u64 + 1, "signature": sig(*s).to_string(), "blockTime": 0,
                        "tx": base64::engine::general_purpose::STANDARD.encode(wire(ps, *s)), "logs": [], "err": null,
                        "units": 0, "fee": 0, "post": []})
                })
                .collect();
            let at_after = (after > 0)
                .then(|| led.get(after as usize - 1))
                .flatten()
                .map(|(s, _)| sig(*s).to_string());
            let v = if scan && !*n.old.lock().unwrap() {
                let over = if *n.over_scan.lock().unwrap() { 5 } else { 0 };
                json!({"txs": txs, "scannedThrough": extent.scanned_through + over, "ledgerLen": extent.ledger_len,
                    "atAfter": at_after, "runId": *n.run_id.lock().unwrap(), "ledgerBytes": *n.bytes.lock().unwrap(),
                    "durable": false})
            } else {
                json!(txs)
            };
            // The scripted change, after this answer was read.
            let k = {
                let mut c = n.calls.lock().unwrap();
                *c += 1;
                *c
            };
            let todo: Vec<After> = n
                .script
                .lock()
                .unwrap()
                .iter()
                .filter(|(at, _)| *at == k)
                .map(|(_, w)| w.clone())
                .collect();
            for w in todo {
                match w {
                    After::Push(s, ps) => n.push(s, &ps),
                    After::LoseTail(k) => n.lose_tail(k),
                }
            }
            v
        }
        "frontier_status" => {
            json!({"runId": *n.run_id.lock().unwrap(), "transactions": n.ledger.lock().unwrap().len()})
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

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("findex-ws04-scan-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Opens (or reopens) a program's archive and pulls until caught up.
async fn archive(dir: &std::path::Path, url: &str, prog: Address) -> Result<Findex, String> {
    let mut f = Findex::open(dir, prog, None, 1 << 20).map_err(|e| e.to_string())?;
    let mut src = LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, prog))
        .with_program(prog)
        .with_ledger("run1");
    f.resume(&mut src);
    let r = loop {
        match f.ingest(&mut src).await {
            Ok(b) if b.is_empty() => break Ok(()),
            Ok(_) => {}
            Err(e) => break Err(e.to_string()),
        }
    };
    f.commit().map_err(|e| e.to_string())?;
    r.map(|_| f)
}

fn part(name: &str, f: &Findex) -> Part {
    Part::of_archive(name, &f.archive).unwrap()
}

fn seqs(parts: &[Part]) -> Vec<u64> {
    join(parts).entries.iter().map(|e| e.feed_seq).collect()
}

/// 1 A, 2 an airdrop, 3 B, 4 both, 5 A, 6 B, 7 C (another program), 8 airdrop.
fn ledger() -> Vec<(u8, Vec<Address>)> {
    vec![
        (11, vec![a()]),
        (12, vec![]),
        (13, vec![b()]),
        (14, vec![a(), b()]),
        (15, vec![a()]),
        (16, vec![b()]),
        (17, vec![c()]),
        (18, vec![]),
    ]
}

fn node() -> Node {
    let n = Node::new("run1", &[]);
    for (s, p) in ledger() {
        n.push(s, &p);
    }
    n
}

/// Normal: both programs' archives are whole through the end of the ledger
/// the node scanned (8), past either program's last transaction (A 5, B 6);
/// the shared transaction is joined once.
#[tokio::test]
async fn both_programs_are_whole_through_the_scanned_end_of_the_ledger() {
    let url = start(node()).await;
    let (da, db) = (tmp("na"), tmp("nb"));
    let fa = archive(&da, &url, a()).await.unwrap();
    let fb = archive(&db, &url, b()).await.unwrap();
    let (pa, pb) = (part("A", &fa), part("B", &fb));
    assert_eq!(pa.cursor["feed_scanned"], 8);
    assert_eq!(pa.cursor["feed_after"], 5);
    let j = join(&[pa.clone(), pb.clone()]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 8, "the scanned extent, not the last own seq");
    assert_eq!(seqs(&[pa, pb]), vec![1, 3, 4, 5, 6]);
    assert_eq!(j.beyond, 0);
}

/// The ledger grows while A is read (two records per answer): every new A
/// transaction is archived, nothing is skipped, and the extent is the
/// ledger's length at the last read.
#[tokio::test]
async fn a_ledger_growing_during_the_read_is_read_through_and_nothing_is_skipped() {
    let n = node();
    *n.cap.lock().unwrap() = 2;
    n.after_call(1, After::Push(21, vec![a()])); // seq 9
    n.after_call(2, After::Push(22, vec![c()])); // seq 10
    n.after_call(2, After::Push(23, vec![a(), b()])); // seq 11
    let url = start(n.clone()).await;
    let da = tmp("ga");
    let fa = archive(&da, &url, a()).await.unwrap();
    let pa = part("A", &fa);
    let got: Vec<u64> = pa.records.iter().map(|(_, f)| f.unwrap()).collect();
    assert_eq!(got, vec![1, 4, 5, 9, 11], "every A transaction, in order");
    assert_eq!(pa.cursor["feed_scanned"], 11);
    // B read afterwards: one ledger, joined whole through 11.
    let fb = archive(&tmp("gb"), &url, b()).await.unwrap();
    let j = join(&[pa, part("B", &fb)]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 11);
}

/// A rewind under the same runId between two answers of one read: the
/// transaction at the cursor is another one (or none). The read is refused
/// and the archive is never whole.
#[tokio::test]
async fn a_rewind_during_the_read_is_refused() {
    let n = node();
    *n.cap.lock().unwrap() = 2;
    // After the first answer (A's 1 and 4), the tail from 4 is lost and 4 is
    // now another transaction.
    n.after_call(1, After::LoseTail(5));
    n.after_call(1, After::Push(31, vec![c()]));
    let url = start(n).await;
    let da = tmp("ra");
    let e = archive(&da, &url, a()).await.err().expect("refused");
    assert!(e.contains("rewound or rebuilt"), "{e}");
    let f = Findex::open(&da, a(), None, 1 << 20).unwrap();
    let pa = part("A", &f);
    assert!(!join(&[pa]).whole(), "a refused archive is never whole");
}

/// A rewind between two reads under the same runId: A was archived (ledger
/// 1..8), the tail 5..8 was lost and 5..9 are other transactions; 5 is no
/// longer A's. B is read afterwards.
///
/// - A's own next read is refused: the transaction at its cursor is gone
///   (`atAfter`, in the same answer as the read).
/// - The join of the stale A with B alone does not see it when the ledger
///   grew back past A's size: B holds nothing at 5. Checking the archives
///   against the node (`findex::ledger::check_node`) does, without
///   re-reading A; a node that cannot be read confirms nothing.
#[tokio::test]
async fn a_rewind_between_the_reads_is_refused_on_the_next_read() {
    let n = node();
    let url = start(n.clone()).await;
    let da = tmp("ba");
    drop(archive(&da, &url, a()).await.unwrap());
    n.lose_tail(4); // 5..8 gone
    for (s, p) in [(41, c()), (42, b()), (43, c()), (44, b()), (45, c())] {
        n.push(s, &[p]); // 5..9
    }
    let fb = archive(&tmp("bb"), &url, b()).await.unwrap();
    assert_eq!(part("B", &fb).cursor["feed_scanned"], 9);
    let before = part("A", &Findex::open(&da, a(), None, 1 << 20).unwrap());
    // Every attempt to bring A up to date is refused, and changes nothing.
    for _ in 0..2 {
        let e = archive(&da, &url, a()).await.err().expect("A refused");
        assert!(e.contains("rewound or rebuilt"), "{e}");
    }
    let after = part("A", &Findex::open(&da, a(), None, 1 << 20).unwrap());
    assert_eq!(
        after.cursor, before.cursor,
        "nothing written over the stale archive"
    );
    assert_eq!(after.records.len(), before.records.len());
    // The stale A on disk, joined offline with B, shows nothing wrong (B holds
    // nothing at 5 and the ledger grew back past A's size): the join alone
    // cannot see it ...
    let pb = part("B", &fb);
    let j = join(&[after.clone(), pb.clone()]);
    assert!(j.whole() && j.through == 8, "join alone: {:?}", j.problems);
    // ... and the node check does, without re-reading A (19's check_node with
    // the scan): A's last transaction is no longer at its ledger number.
    let why = findex::ledger::check_node(&url, &[after.clone(), pb.clone()]).await;
    assert!(
        why.iter()
            .any(|w| w.starts_with("A:") && w.contains("rewound or rebuilt")),
        "{why:?}"
    );
    assert!(
        !why.iter().any(|w| w.starts_with("B:")),
        "B is current: {why:?}"
    );
    // A node that cannot be read confirms nothing.
    let why = findex::ledger::check_node("http://127.0.0.1:9", &[after, pb]).await;
    assert!(
        why.iter().any(|w| w.contains("nothing confirmed")),
        "{why:?}"
    );
}

/// The bytes between parts: one part scanned further than another with fewer
/// ledger bytes means the ledger shrank between the reads (it only grows).
#[test]
fn a_part_scanned_further_with_fewer_bytes_shows_a_rewind() {
    let mk = |name: &str, scanned: u64, bytes: u64| Part {
        name: name.into(),
        records: vec![],
        cursor: json!({"feed_after": 0, "feed_start": 0, "ledger": "run1",
            "feed_scanned": scanned, "ledger_bytes": bytes}),
    };
    let j = join(&[mk("A", 8, 800), mk("B", 9, 750)]);
    assert!(!j.whole());
    assert!(
        j.problems
            .iter()
            .any(|p| p.contains("rewound between the reads")),
        "{:?}",
        j.problems
    );
    // Consistent sizes: no such problem.
    assert!(join(&[mk("A", 8, 800), mk("B", 9, 900)]).whole());
    // A ledger kept only in memory reports 0 bytes: not compared.
    assert!(join(&[mk("A", 8, 0), mk("B", 9, 0)]).whole());
}

/// A short history: B was read before the ledger grew; A after. The join is
/// cut at B's extent; A's later transactions are counted as beyond, never
/// joined as whole.
#[tokio::test]
async fn a_short_history_cuts_the_join_at_its_scanned_extent() {
    let n = node();
    let url = start(n.clone()).await;
    let fb = archive(&tmp("sb"), &url, b()).await.unwrap();
    n.push(51, &[a()]); // 9
    n.push(52, &[a(), b()]); // 10: B has not read it
    let fa = archive(&tmp("sa"), &url, a()).await.unwrap();
    let j = join(&[part("A", &fa), part("B", &fb)]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 8, "B's extent");
    assert!(j.entries.iter().all(|e| e.feed_seq <= 8));
    assert_eq!(j.beyond, 2, "A's 9 and 10");
}

/// A node without the scan (the array form): nothing past each program's
/// own last transaction is known to have been scanned, so the join is cut at
/// the lowest own last seq, as before.
#[tokio::test]
async fn without_the_scan_only_the_own_last_seq_counts() {
    let n = node();
    *n.old.lock().unwrap() = true;
    let url = start(n).await;
    let fa = archive(&tmp("oa"), &url, a()).await.unwrap();
    let fb = archive(&tmp("ob"), &url, b()).await.unwrap();
    let (pa, pb) = (part("A", &fa), part("B", &fb));
    assert!(pa.cursor["feed_scanned"].is_null());
    let j = join(&[pa, pb]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 5, "min(A 5, B 6)");
}

/// A cursor that claims a scanned extent below its own last seq is a
/// contradiction, not a cut.
#[test]
fn a_scanned_extent_below_the_own_cursor_is_not_whole() {
    let p = Part {
        name: "A".into(),
        records: vec![],
        cursor: json!({"feed_after": 5, "feed_start": 0, "ledger": "run1", "feed_scanned": 3}),
    };
    let j = join(&[p]);
    assert!(!j.whole());
    assert!(
        j.problems
            .iter()
            .any(|x| x.contains("before its own cursor")),
        "{:?}",
        j.problems
    );
}

/// The ledger shorter than the archive's cursor at resume (rewound or
/// rebuilt under the same runId): refused.
#[tokio::test]
async fn a_ledger_shorter_than_the_cursor_is_refused() {
    let n = node();
    let url = start(n.clone()).await;
    let da = tmp("la");
    drop(archive(&da, &url, a()).await.unwrap());
    n.lose_tail(6); // 2 entries left; A's cursor is 5
    let e = archive(&da, &url, a()).await.err().expect("refused");
    assert!(e.contains("rewound or rebuilt"), "{e}");
}

/// 20's condition 2: a scanned extent past the ledger's length in the same
/// answer is refused, not taken.
#[tokio::test]
async fn a_scan_past_the_ledger_length_is_refused() {
    let n = node();
    *n.over_scan.lock().unwrap() = true;
    let url = start(n).await;
    let e = archive(&tmp("over"), &url, a())
        .await
        .err()
        .expect("refused");
    assert!(e.contains("inconsistent answer"), "{e}");
}

/// 20's condition 3: on resume the extent carries over only with the record
/// it was read after (checked by the next read); a cursor without it drops
/// the extent and falls back to the own last seq.
#[test]
fn the_extent_carries_over_only_with_its_last_record() {
    use findex::ingest::Source;
    let port = fclient::rpc::RpcPort::localnet("http://127.0.0.1:9", a());
    let mut f = LocalnetFeed::new(port)
        .with_program(a())
        .with_ledger("run1");
    let with_last = json!({"feed_after": 5, "feed_start": 0, "ledger": "run1", "feed_scanned": 8,
        "feed_last": {"seq": 5, "signature": sig(15).to_string()}});
    f.restore(&with_last);
    assert_eq!(f.cursor()["feed_scanned"], 8);
    let without = json!({"feed_after": 5, "feed_start": 0, "ledger": "run1", "feed_scanned": 8});
    f.restore(&without);
    assert!(f.cursor()["feed_scanned"].is_null(), "{}", f.cursor());
    // An empty archive's cursor (from the ledger's start) keeps its extent.
    f.restore(&json!({"feed_after": 0, "feed_start": 0, "ledger": "run1", "feed_scanned": 3}));
    assert_eq!(f.cursor()["feed_scanned"], 3);
}
