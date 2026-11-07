//! One ledger's history kept as per-program archives (`findex::ledger`, ⑲,
//! 2026-11-07): each record keeps its ledger number (`feed_seq`) beside the
//! archive's own `seq`; the cursor keeps where the feed started and which
//! ledger it is. Checked here: the same transaction in two archives (joined
//! once), the ledger number against the archive number, matching by
//! signature, a restart between the archives' commits, a node that started a
//! new ledger, archives written before these fields, and that none of these
//! is taken for a whole history.
//!
//! Keyless: the node is a JSON-RPC stand-in (`frontier_feed`,
//! `frontier_status`), signatures are fixed byte patterns, transactions three
//! opaque bytes; nothing is generated, derived or signed.

use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use fclient::ports::{Signature, TxRecord};
use findex::ingest::{LocalnetFeed, Source};
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

/// A node: one ledger (seq = position + 1), each entry naming the programs
/// it mentions (none: an airdrop, which the feed leaves out).
/// Ledger entries: a signature byte and the programs it mentions.
type Entries = Vec<(u8, Vec<Address>)>;

#[derive(Clone, Default)]
struct Node {
    run_id: Arc<Mutex<String>>,
    ledger: Arc<Mutex<Entries>>,
    /// Answer every program's transactions whatever the filter (a node
    /// that could not read the program argument).
    unfiltered: Arc<Mutex<bool>>,
}

/// An unsigned legacy transaction calling each of `progs` (no key, no
/// signature: zero-filled signature slots, a fixed payer address).
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

impl Node {
    fn new(run: &str, entries: &[(u8, &[Address])]) -> Node {
        let n = Node::default();
        n.reset(run, entries);
        n
    }
    fn reset(&self, run: &str, entries: &[(u8, &[Address])]) {
        *self.run_id.lock().unwrap() = run.into();
        *self.ledger.lock().unwrap() = entries.iter().map(|(s, p)| (*s, p.to_vec())).collect();
    }
    fn push(&self, s: u8, p: &[Address]) {
        self.ledger.lock().unwrap().push((s, p.to_vec()));
    }
    /// The ledger loses its last `n` entries (a tail never synced).
    fn lose_tail(&self, n: usize) {
        let mut l = self.ledger.lock().unwrap();
        let k = l.len() - n;
        l.truncate(k);
    }
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let led = n.ledger.lock().unwrap().clone();
    let unfiltered = *n.unfiltered.lock().unwrap();
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "frontier_feed" => {
            let after = p.get(0).and_then(|x| x.as_u64()).unwrap_or(0);
            let limit = p.get(1).and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let prog: Option<Address> = p
                .get(2)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok());
            json!(led
                .iter()
                .enumerate()
                .map(|(i, e)| (i as u64 + 1, e))
                .filter(|(seq, (_, ps))| {
                    *seq > after && !ps.is_empty() && (unfiltered || prog.is_none_or(|q| ps.contains(&q)))
                })
                .take(limit)
                .map(|(seq, (s, ps))| json!({"seq": seq, "slot": seq, "signature": sig(*s).to_string(), "blockTime": 0,
                    "tx": base64::engine::general_purpose::STANDARD.encode(wire(ps, *s)), "logs": [], "err": null,
                    "units": 0, "fee": 0, "post": []}))
                .collect::<Vec<_>>())
        }
        "frontier_status" => json!({"runId": *n.run_id.lock().unwrap(), "transactions": led.len(),
            "ledgerBytes": 100 * led.len() as u64}),
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
    let d = std::env::temp_dir().join(format!("findex-ledger-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn feed(url: &str, prog: Address, run: Option<&str>) -> LocalnetFeed<fclient::rpc::RpcPort> {
    let f = LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, prog)).with_program(prog);
    match run {
        Some(r) => f.with_ledger(r),
        None => f,
    }
}

/// Opens (or reopens) a program's archive and pulls the node until caught up.
async fn archive(
    dir: &std::path::Path,
    url: &str,
    prog: Address,
    run: Option<&str>,
) -> Result<Findex, String> {
    let mut f = Findex::open(dir, prog, None, 1 << 20).map_err(|e| e.to_string())?;
    let mut src = feed(url, prog, run);
    if let Some(b) = findex::ledger::node_status(url)
        .await
        .ok()
        .and_then(|s| s.ledger_bytes)
    {
        src = src.with_ledger_bytes(b);
    }
    f.resume(&mut src);
    while !f
        .ingest(&mut src)
        .await
        .map_err(|e| e.to_string())?
        .is_empty()
    {}
    f.commit().map_err(|e| e.to_string())?;
    Ok(f)
}

fn part(name: &str, f: &Findex) -> Part {
    Part::of_archive(name, &f.archive).unwrap()
}

fn seqs(j: &findex::ledger::Joined) -> Vec<u64> {
    j.entries.iter().map(|e| e.feed_seq).collect()
}

/// The ledger: 1 A, 2 an airdrop, 3 B, 4 both, 5 A, 6 B.
fn ledger() -> Vec<(u8, &'static [Address])> {
    static A: std::sync::OnceLock<[Address; 1]> = std::sync::OnceLock::new();
    static B: std::sync::OnceLock<[Address; 1]> = std::sync::OnceLock::new();
    static AB: std::sync::OnceLock<[Address; 2]> = std::sync::OnceLock::new();
    let (ra, rb, rab) = (
        A.get_or_init(|| [a()]),
        B.get_or_init(|| [b()]),
        AB.get_or_init(|| [a(), b()]),
    );
    vec![
        (11, &ra[..]),
        (12, &[][..]),
        (13, &rb[..]),
        (14, &rab[..]),
        (15, &ra[..]),
        (16, &rb[..]),
    ]
}

/// Two programs' archives of one ledger join in ledger order, the shared
/// transaction once; each archive numbers its records 1.. while keeping the
/// ledger number, and the join matches them by signature.
#[tokio::test]
async fn two_archives_join_in_ledger_order_with_the_shared_transaction_once() {
    let n = Node::new("run1", &ledger());
    let url = start(n).await;
    let fa = archive(&tmp("a"), &url, a(), Some("run1")).await.unwrap();
    let fb = archive(&tmp("b"), &url, b(), Some("run1")).await.unwrap();
    let pa = part("A", &fa);
    let pb = part("B", &fb);
    // The archive's own numbers and the ledger's differ.
    assert_eq!(
        pa.records.iter().map(|(r, _)| r.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        pa.records.iter().map(|(_, f)| *f).collect::<Vec<_>>(),
        vec![Some(1), Some(4), Some(5)]
    );
    assert_eq!(
        pb.records.iter().map(|(_, f)| *f).collect::<Vec<_>>(),
        vec![Some(3), Some(4), Some(6)]
    );
    let j = join(&[pa, pb]);
    assert!(j.whole(), "{:?}", j.problems);
    // Each cursor records its own program's last number only (A: 5, B: 6):
    // the join claims no more than the lower one, so B's 6 waits outside.
    assert_eq!(
        seqs(&j),
        vec![1, 3, 4, 5],
        "ledger order, 4 once, the airdrop absent"
    );
    assert_eq!(j.beyond, 1);
    let shared = j.entries.iter().find(|e| e.feed_seq == 4).unwrap();
    assert_eq!(shared.signature, sig(14));
    assert_eq!(
        shared.held_by,
        vec![(0, 2), (1, 2)],
        "held by both, at each archive's own seq"
    );
    assert_eq!(j.through, 5);
    assert_eq!(j.ledger.as_deref(), Some("run1"));
}

fn rec(arch_seq: u64, s: u8) -> TxRecord {
    TxRecord {
        seq: arch_seq,
        slot: arch_seq,
        signature: sig(s),
        block_time: 0,
        tx: vec![1, 2, 3],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn cursor(after: u64) -> Value {
    json!({"feed_after": after, "feed_start": 0, "ledger": "run1"})
}

fn mk(name: &str, recs: &[(u8, Option<u64>)], c: Value) -> Part {
    Part {
        name: name.into(),
        records: recs
            .iter()
            .enumerate()
            .map(|(i, (s, f))| (rec(i as u64 + 1, *s), *f))
            .collect(),
        cursor: c,
    }
}

fn not_whole(parts: &[Part], says: &str) {
    let j = join(parts);
    assert!(!j.whole(), "{says}: taken as whole");
    assert!(
        j.problems.iter().any(|p| p.contains(says)),
        "{says} not in {:?}",
        j.problems
    );
}

/// Duplicates, one ledger number with two signatures, one signature at two
/// ledger numbers, a reorder, a number past the cursor, a record without
/// its number: each is named, and none is whole.
#[test]
fn duplicates_and_mismatched_numbers_are_never_whole() {
    let good_b = mk("B", &[(13, Some(3)), (14, Some(4))], cursor(6));
    not_whole(
        &[
            mk("A", &[(11, Some(1)), (99, Some(4))], cursor(6)),
            good_b.clone(),
        ],
        "two transactions, one ledger number",
    );
    not_whole(
        &[
            mk("A", &[(11, Some(1)), (14, Some(5))], cursor(6)),
            good_b.clone(),
        ],
        "one transaction, two ledger numbers",
    );
    not_whole(
        &[mk("A", &[(11, Some(1)), (11, Some(1))], cursor(6))],
        "does not follow",
    );
    not_whole(
        &[mk("A", &[(15, Some(5)), (11, Some(1))], cursor(6))],
        "does not follow",
    );
    not_whole(
        &[mk("A", &[(11, Some(1)), (17, Some(7))], cursor(6))],
        "past its own cursor",
    );
    not_whole(
        &[mk("A", &[(11, Some(1)), (15, None)], cursor(6))],
        "has no feed_seq",
    );
    // The same transaction twice in one part at one number.
    not_whole(
        &[mk("A", &[(11, Some(1)), (11, Some(1))], cursor(6))],
        "feed_seq 1",
    );
}

/// The cursor must say the feed started at the ledger's start and which
/// ledger it is, and every part must be of the same ledger.
#[test]
fn start_and_ledger_must_be_known_and_shared() {
    let r = [(11, Some(1))];
    not_whole(
        &[mk("A", &r, json!({"feed_after": 6, "ledger": "run1"}))],
        "where the feed started is not recorded",
    );
    not_whole(
        &[mk(
            "A",
            &r,
            json!({"feed_after": 6, "feed_start": 3, "ledger": "run1"}),
        )],
        "started after ledger seq 3",
    );
    not_whole(
        &[mk("A", &r, json!({"feed_after": 6, "feed_start": 0}))],
        "which ledger it is is not recorded",
    );
    not_whole(
        &[
            mk("A", &r, cursor(6)),
            mk(
                "B",
                &[(13, Some(3))],
                json!({"feed_after": 6, "feed_start": 0, "ledger": "run2"}),
            ),
        ],
        "different ledgers",
    );
    not_whole(
        &[mk("A", &r, json!({"rpc_last": null}))],
        "not a local feed's",
    );
    not_whole(&[mk("A", &r, json!({"feed_refused": "x"}))], "refused");
}

/// A restart between the two archives' commits: one is ahead. The join is
/// cut at the lower cursor (what is past it is counted, not joined); once the
/// other resumes from its own cursor, the join reaches the end, nothing twice.
#[tokio::test]
async fn a_restart_between_the_archives_cuts_the_join_at_the_lower_cursor() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let (da, db) = (tmp("ra"), tmp("rb"));
    drop(archive(&da, &url, a(), Some("run1")).await.unwrap());
    drop(archive(&db, &url, b(), Some("run1")).await.unwrap());
    n.push(17, &[a()]);
    n.push(18, &[b()]);
    // Only B pulls before the stop.
    let fb = archive(&db, &url, b(), Some("run1")).await.unwrap();
    let fa = Findex::open(&da, a(), None, 1 << 20).unwrap();
    let j = join(&[part("A", &fa), part("B", &fb)]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 5, "A's cursor");
    assert_eq!(seqs(&j), vec![1, 3, 4, 5]);
    assert_eq!(j.beyond, 2, "B's 6 and 8 are past A's cursor");
    drop(fa);
    // A restarts from its archived cursor.
    let fa = archive(&da, &url, a(), Some("run1")).await.unwrap();
    let pa = part("A", &fa);
    assert_eq!(
        pa.records
            .iter()
            .map(|(_, f)| f.unwrap())
            .collect::<Vec<_>>(),
        vec![1, 4, 5, 7],
        "once each"
    );
    let j = join(&[pa, part("B", &fb)]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(seqs(&j), vec![1, 3, 4, 5, 6, 7]);
    assert_eq!(j.beyond, 1, "B's 8 is past A's last number 7");
}

/// The node started a new ledger (its data rebuilt: a new runId, seq from 1
/// again). Resuming the old archive is refused, nothing is appended; an
/// archive of the new ledger does not join one of the old.
#[tokio::test]
async fn a_new_ledger_is_refused_not_resumed() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let da = tmp("na");
    drop(archive(&da, &url, a(), Some("run1")).await.unwrap());
    n.reset(
        "run2",
        &[
            (21, &[a()][..]),
            (22, &[b()][..]),
            (23, &[a()][..]),
            (24, &[a()][..]),
            (25, &[a()][..]),
            (26, &[a()][..]),
            (27, &[a()][..]),
        ],
    );
    let e = archive(&da, &url, a(), Some("run2"))
        .await
        .err()
        .expect("refused");
    assert!(
        e.contains("ledger run1") && e.contains("ledger run2"),
        "{e}"
    );
    let fa = Findex::open(&da, a(), None, 1 << 20).unwrap();
    assert_eq!(fa.archive.last_seq(), 3, "nothing appended");
    let fb = archive(&tmp("nb"), &url, b(), Some("run2")).await.unwrap();
    let j = join(&[part("A", &fa), part("B", &fb)]);
    assert!(!j.whole());
    assert!(
        j.problems.iter().any(|p| p.contains("different ledgers")),
        "{:?}",
        j.problems
    );
}

/// Archives written before these fields: a plain `append` and a cursor with
/// only `feed_after`. They still open, read and resume (the herald's archive
/// keeps working), but are never whole; what they hold reads back the same.
#[tokio::test]
async fn archives_from_before_resume_but_are_never_whole() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let d = tmp("old");
    {
        let mut f = Findex::open(&d, a(), None, 1 << 20).unwrap();
        let recs: Vec<TxRecord> = [(1, 11), (4, 14)]
            .iter()
            .map(|(s, g)| rec(*s, *g))
            .collect();
        f.archive.append(&recs, json!({"feed_after": 4})).unwrap();
        f.commit().unwrap();
    }
    let f = archive(&d, &url, a(), Some("run1")).await.unwrap();
    let p = part("A", &f);
    assert_eq!(
        p.records
            .iter()
            .map(|(r, x)| (r.signature, *x))
            .collect::<Vec<_>>(),
        vec![(sig(11), None), (sig(14), None), (sig(15), Some(5))]
    );
    assert_eq!(
        f.archive.read_after(0).unwrap().len(),
        3,
        "the plain reader is unchanged"
    );
    let j = join(&[p]);
    assert!(!j.whole());
    for says in [
        "has no feed_seq",
        "where the feed started is not recorded",
        "which ledger it is is not recorded",
    ] {
        assert!(
            j.problems.iter().any(|x| x.contains(says)),
            "{says}: {:?}",
            j.problems
        );
    }
}

/// A cursor that is not a local feed's (another source's, or a lost one
/// marked by `resume`) is refused: the feed does not start again from 0
/// behind an archive that already holds records.
#[tokio::test]
async fn a_cursor_that_is_not_a_feeds_is_refused() {
    let n = Node::new("run1", &ledger());
    let url = start(n).await;
    for bad in [
        json!({"rpc_last": "x"}),
        json!({"cursor_missing_after_seq": 3}),
        json!({}),
    ] {
        let mut s = feed(&url, a(), Some("run1"));
        s.restore(&bad);
        let e = s.pull().await.unwrap_err().to_string();
        assert!(e.contains("not a local feed's"), "{bad}: {e}");
        assert_eq!(s.coverage().unwrap()["state"], "gap");
    }
}

/// The node lost the tail it had served (a ledger without fsync after a
/// power loss): the same runId, but the archive's last seq now holds another
/// transaction. Resuming is refused; nothing is appended over it.
#[tokio::test]
async fn a_rewound_ledger_under_the_same_run_id_is_refused() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let d = tmp("rewind");
    drop(archive(&d, &url, a(), Some("run1")).await.unwrap());
    n.lose_tail(2); // 5 (A) and 6 (B) gone
    n.push(31, &[a()]); // seq 5 is now another transaction
    n.push(32, &[a()]);
    let e = archive(&d, &url, a(), Some("run1"))
        .await
        .err()
        .expect("refused");
    assert!(e.contains("no longer holds") && e.contains("seq 5"), "{e}");
    let f = Findex::open(&d, a(), None, 1 << 20).unwrap();
    assert_eq!(f.archive.last_seq(), 3, "nothing appended");
    // The tail simply not yet re-served: also refused (nothing at seq 5).
    let n2 = Node::new("run1", &ledger());
    let url2 = start(n2.clone()).await;
    let d2 = tmp("rewind2");
    drop(archive(&d2, &url2, a(), Some("run1")).await.unwrap());
    n2.lose_tail(2);
    let e = archive(&d2, &url2, a(), Some("run1"))
        .await
        .err()
        .expect("refused");
    assert!(e.contains("nothing there"), "{e}");
}

/// A node that answers every program's transactions (the filter not read):
/// the feed stops at the first record without the program instead of
/// archiving another program's history as this one's.
#[tokio::test]
async fn an_unfiltered_feed_is_refused() {
    let n = Node::new("run1", &ledger());
    *n.unfiltered.lock().unwrap() = true;
    let url = start(n).await;
    let d = tmp("unfiltered");
    let e = archive(&d, &url, a(), Some("run1"))
        .await
        .err()
        .expect("refused");
    assert!(e.contains("does not mention the program"), "{e}");
    let f = Findex::open(&d, a(), None, 1 << 20).unwrap();
    assert_eq!(f.archive.last_seq(), 0);
}

// ------------------------------------------------------------ against the node

fn c() -> Address {
    Address::new_from_array([0xC3; 32])
}

fn says(why: &[String], what: &str) -> bool {
    why.iter().any(|w| w.contains(what))
}

/// Both archives match the node: nothing to report.
#[tokio::test]
async fn archives_that_match_the_node_are_confirmed() {
    let n = Node::new("run1", &ledger());
    let url = start(n).await;
    let fa = archive(&tmp("ca"), &url, a(), Some("run1")).await.unwrap();
    let fb = archive(&tmp("cb"), &url, b(), Some("run1")).await.unwrap();
    let why = findex::ledger::check_node(&url, &[part("A", &fa), part("B", &fb)]).await;
    assert!(why.is_empty(), "{why:?}");
}

/// The ledger rewound under the same runId after both archives were
/// written, the seqs then taken by another program's transactions (so its
/// size is back where it was): `join` alone cannot see it (the archives are
/// consistent with each other), the node check does, for both.
#[tokio::test]
async fn a_rewind_under_the_same_run_id_is_seen_against_the_node() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let fa = archive(&tmp("rwa"), &url, a(), Some("run1")).await.unwrap();
    let fb = archive(&tmp("rwb"), &url, b(), Some("run1")).await.unwrap();
    n.lose_tail(2); // A's 5, B's 6
    n.push(31, &[c()]);
    n.push(32, &[c()]);
    let parts = [part("A", &fa), part("B", &fb)];
    let j = join(&parts);
    assert!(
        j.whole(),
        "the limit: the archives alone agree ({:?})",
        j.problems
    );
    let why = findex::ledger::check_node(&url, &parts).await;
    assert!(says(&why, "A: the archive's last transaction"), "{why:?}");
    assert!(says(&why, "B: the archive's last transaction"), "{why:?}");
    assert!(says(&why, "rewound"), "{why:?}");
}

/// A rewind that left the ledger shorter: its size and its transaction
/// count are below what the archive saw, and nothing is at the last seq.
#[tokio::test]
async fn a_shrunk_ledger_is_seen_against_the_node() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let fa = archive(&tmp("sha"), &url, a(), Some("run1")).await.unwrap();
    n.lose_tail(2);
    let why = findex::ledger::check_node(&url, &[part("A", &fa)]).await;
    assert!(says(&why, "it shrank"), "{why:?}");
    assert!(says(&why, "holds 4 transactions"), "{why:?}");
    assert!(
        says(&why, "nothing at the archive's last ledger seq 5"),
        "{why:?}"
    );
}

/// One archive older than the other: A was written before the ledger grew,
/// B after. Only the newest entry (B's last) is rewound: A still matches, B
/// does not, and the report names B only.
#[tokio::test]
async fn only_the_archive_whose_tail_was_rewound_is_named() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let fa = archive(&tmp("oa"), &url, a(), Some("run1")).await.unwrap();
    n.push(17, &[b()]);
    let fb = archive(&tmp("ob"), &url, b(), Some("run1")).await.unwrap();
    // Older A and newer B, the node as it is: both confirmed.
    let parts = [part("A", &fa), part("B", &fb)];
    assert!(findex::ledger::check_node(&url, &parts).await.is_empty());
    n.lose_tail(1);
    n.push(41, &[c()]);
    let why = findex::ledger::check_node(&url, &parts).await;
    assert!(says(&why, "B: the archive's last transaction"), "{why:?}");
    assert!(!says(&why, "A:"), "A's tail is still there: {why:?}");
}

/// A node that cannot be read confirms nothing; a node of another ledger
/// is named as such.
#[tokio::test]
async fn an_unreadable_or_other_node_confirms_nothing() {
    let n = Node::new("run1", &ledger());
    let url = start(n.clone()).await;
    let fa = archive(&tmp("ua"), &url, a(), Some("run1")).await.unwrap();
    let dead = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}")
    };
    let why = findex::ledger::check_node(&dead, &[part("A", &fa)]).await;
    assert!(says(&why, "could not be read"), "{why:?}");
    n.reset("run2", &ledger());
    let why = findex::ledger::check_node(&url, &[part("A", &fa)]).await;
    assert!(
        says(
            &why,
            "archived from ledger run1, the node serves ledger run2"
        ),
        "{why:?}"
    );
}
