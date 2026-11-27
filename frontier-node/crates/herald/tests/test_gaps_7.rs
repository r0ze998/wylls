//! test-gaps-7: what verify-pr288 / verify-pr292 checked by hand, as tests.
//!
//! - #288 (herald-pull-chunk) at the herald's level: a herald pulling in
//!   chunks of 50 (with getMultipleAccounts failures that hand a chunk back)
//!   ends with the SAME archive records and the SAME fold state as one
//!   pulling everything at once; reopened after a checkpoint plus a tail
//!   replay, `lastArchivedSlot` is the archive's newest record slot (the
//!   verifier's gap G3).
//! - #288 × #292 (rpc-pacer-per-method) through the real HTTP client: a
//!   getTransaction 429 storm on the shared per-method pacer never freezes
//!   the live slot (the Clock's getAccountInfo keeps its turns), every
//!   request still arrives ≥ the pacer's gap apart, and once the storm ends
//!   every transaction is archived once. The pre-#292 scope (`Process`) on
//!   the same run freezes it: the test can tell the two apart.
//! - #288's Clock failure log (the verifier's gap G1, checked only with the
//!   binary by hand): the real `frontier-herald` binary, every Clock read
//!   failing, writes ONE log line for hundreds of failures while its ingest
//!   archives everything.
//!
//! Loopback fake RPC only (127.0.0.1:0, the herald binary on
//! `--listen 127.0.0.1:0`), unsigned wires with placeholder signatures: no
//! key is generated, derived or signed; 0 devnet calls.

mod common;

#[path = "../../findex/tests/support/chunk_rpc.rs"]
mod chunk_rpc;

use std::collections::BTreeSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chunk_rpc::{recipient, Chain};
use common::tmp;
use fclient::ports::TxRecord;
use fclient::rpc::{Pacer, PacerScope, RpcClient, RpcPort};
use findex::{Enriched, RpcPoll};
use herald_fold::runner::{run_with, Ingest, IngestCfg};
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

fn cfg(data: &std::path::Path, checkpoint_slots: u64) -> IngestCfg {
    let mut cfg = IngestCfg::new(data, fclient::addr::system_program(), 1);
    cfg.exact_post = false;
    cfg.checkpoint_slots = checkpoint_slots;
    // Every batch committed at once: a run cancelled below loses no archived record.
    cfg.archive_commit = Duration::ZERO;
    cfg
}

fn open(cfg: IngestCfg) -> Ingest {
    let (tx, _) = broadcast::channel(4_096);
    Ingest::open(cfg, tx).unwrap()
}

/// The herald's rpc source, every call through `rpc` (as main.rs `paced`).
fn src(url: &str, cap: usize, rpc: impl Fn() -> RpcClient) -> Enriched<RpcPoll> {
    let mut poll = RpcPoll::new(url.to_string(), recipient()).with_max_batch(cap);
    poll.rpc = rpc();
    let mut e = Enriched::new(poll, url.to_string(), fclient::addr::system_program());
    e.rpc = rpc();
    e
}

fn records(data: &std::path::Path) -> Vec<TxRecord> {
    findex::Archive::open(
        &data.join("findex").join("archive"),
        findex::archive::SEGMENT_BYTES,
    )
    .unwrap()
    .read_after(0)
    .unwrap()
}

/// Waits until `/h/status` ingest says archived through `last` with no backlog.
async fn caught_up(fold: &Arc<std::sync::RwLock<herald_fold::fold::Fold>>, last: u64, secs: u64) {
    let t0 = Instant::now();
    loop {
        let j = fold.read().unwrap().ingest.json();
        if j["lastArchivedSlot"] == json!(last) && j["backlog"] == json!(0) {
            return;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(secs),
            "not caught up: {j}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chunked_herald_archives_and_folds_the_same_as_an_unchunked_one() {
    const TOTAL: u64 = 600;
    const BASE: u64 = 7_000;
    const LAST: u64 = BASE + TOTAL - 1;

    // A: one uncapped pull per poll, no failure; stopped normally.
    let chain_a = Chain::with_transfers(TOTAL, BASE);
    let url_a = chunk_rpc::start(chain_a.clone()).await;
    let da = tmp("tg7-unchunked");
    let ing = open(cfg(&da, 150));
    let fold_a = ing.fold.clone();
    let (stop_a, stop) = watch::channel(false);
    let u = url_a.clone();
    let h = tokio::spawn(run_with(
        ing,
        src(&url_a, usize::MAX, move || RpcClient::new(u.clone())),
        Some(RpcPort::new(url_a.clone(), recipient())),
        Duration::from_millis(10),
        Duration::from_millis(10),
        stop,
    ));
    caught_up(&fold_a, LAST, 120).await;
    let state_a = fold_a.read().unwrap().st.clone();
    stop_a.send(true).unwrap();
    h.await.unwrap().unwrap();
    assert_eq!(chain_a.count("getTransaction"), TOTAL);

    // B: chunks of 50, the archive grown in two runs. Run 1 sees the first 300 transactions and stops (its
    // checkpoint covers them); run 2 sees all 600 with getMultipleAccounts failing twice (each hands one chunk
    // back), checkpoints only at its start, and is CANCELLED once caught up: no closing checkpoint, so the reopen
    // below re-folds the 300-record tail from the checkpoint.
    let chain_b = Chain::with_transfers(TOTAL, BASE);
    let all = chain_b.sigs.lock().unwrap().clone();
    chain_b.sigs.lock().unwrap().truncate(300);
    let url_b = chunk_rpc::start(chain_b.clone()).await;
    let db = tmp("tg7-chunked");
    let ing = open(cfg(&db, 150));
    let fold_b = ing.fold.clone();
    let (stop_b, stop) = watch::channel(false);
    let u = url_b.clone();
    let h = tokio::spawn(run_with(
        ing,
        src(&url_b, 50, move || RpcClient::new(u.clone())),
        Some(RpcPort::new(url_b.clone(), recipient())),
        Duration::from_millis(10),
        Duration::from_millis(10),
        stop,
    ));
    caught_up(&fold_b, BASE + 299, 120).await;
    stop_b.send(true).unwrap();
    h.await.unwrap().unwrap();
    let ck = herald_fold::checkpoint::load_full(
        &db.join("herald.ckpt"),
        &fclient::addr::system_program().to_bytes(),
        1,
    )
    .unwrap()
    .0;
    assert_eq!(ck.folded_through, 300, "run 1's closing checkpoint");

    *chain_b.sigs.lock().unwrap() = all;
    let gma_before = chain_b.count("getMultipleAccounts");
    chain_b
        .fail_accounts_call
        .store(gma_before + 2, Ordering::SeqCst);
    let ing = open(cfg(&db, u64::MAX / 2));
    let fold_b = ing.fold.clone();
    assert_eq!(
        fold_b.read().unwrap().ingest.json()["lastArchivedSlot"],
        json!(BASE + 299),
        "reopened at the newest archived slot"
    );
    let (_stop_b, stop) = watch::channel(false);
    let u = url_b.clone();
    let h = tokio::spawn(run_with(
        ing,
        src(&url_b, 50, move || RpcClient::new(u.clone())),
        Some(RpcPort::new(url_b.clone(), recipient())),
        Duration::from_millis(10),
        Duration::from_millis(10),
        stop,
    ));
    // the second failure armed after the first one has happened
    let t0 = Instant::now();
    while chain_b.count("getMultipleAccounts") < gma_before + 4 {
        assert!(t0.elapsed() < Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    chain_b
        .fail_accounts_call
        .store(chain_b.count("getMultipleAccounts") + 3, Ordering::SeqCst);
    caught_up(&fold_b, LAST, 120).await;
    let state_b = fold_b.read().unwrap().st.clone();
    h.abort();
    let _ = h.await;

    // The same records (seq, slot, signature, wire, logs, post-states), the same fold state.
    let (ra, rb) = (records(&da), records(&db));
    assert_eq!(ra.len(), TOTAL as usize);
    assert_eq!(
        ra.iter().map(|r| r.seq).collect::<Vec<_>>(),
        (1..=TOTAL).collect::<Vec<_>>(),
        "no gap, no duplicate"
    );
    assert!(ra == rb, "the chunked archive equals the unchunked one");
    assert_eq!(state_a, state_b, "the same fold state");
    // Two failures, each refetched at most one chunk (50).
    let gt = chain_b.count("getTransaction");
    assert!(
        (TOTAL + 2..=TOTAL + 100).contains(&gt),
        "getTransaction {gt}: two failures re-fetch ≤ 50 each"
    );

    // G3: reopened from a checkpoint (300) plus the tail (301..600), lastArchivedSlot = the newest record's slot,
    // and the fold equals the one that saw every record live.
    let ck = herald_fold::checkpoint::load_full(
        &db.join("herald.ckpt"),
        &fclient::addr::system_program().to_bytes(),
        1,
    )
    .unwrap()
    .0;
    assert_eq!(
        ck.folded_through, 300,
        "the cancelled run left no closing checkpoint"
    );
    let newest = rb.iter().map(|r| r.slot).max().unwrap();
    for d in [&da, &db] {
        let ing = open(cfg(d, 150));
        let f = ing.fold.read().unwrap();
        assert_eq!(
            f.ingest.json()["lastArchivedSlot"],
            json!(newest),
            "{}",
            d.display()
        );
        assert_eq!(f.st, state_a, "reopened fold state");
    }
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

/// The live slots seen while `secs` pass, the run's pacer, and the chain.
async fn storm(scope: PacerScope, secs: u64) -> (BTreeSet<u64>, Arc<Pacer>, Chain, Value) {
    let chain = Chain::with_transfers(120, 3_000);
    chain.tx_429.store(true, Ordering::SeqCst);
    chain.tx_429_retry_after.store(1, Ordering::SeqCst);
    let url = chunk_rpc::start(chain.clone()).await;
    let data = tmp(&format!("tg7-storm-{scope:?}"));
    let ing = open(cfg(&data, 150));
    let fold = ing.fold.clone();
    // One pacer for the poller, the enrichment and the Clock (main.rs `paced`), 20 ms apart, 30 s cap.
    let pacer = Pacer::with_scope(Duration::from_millis(20), Duration::from_secs(30), scope);
    let paced = {
        let (u, p) = (url.clone(), pacer.clone());
        move || RpcClient::new(u.clone()).with_pacer(p.clone())
    };
    let mut port = RpcPort::new(url.clone(), recipient());
    port.rpc = paced();
    let (stop_tx, stop) = watch::channel(false);
    let h = tokio::spawn(run_with(
        ing,
        src(&url, 50, paced),
        Some(port),
        Duration::from_millis(20),
        Duration::from_millis(20),
        stop,
    ));
    let mut seen = BTreeSet::new();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        if let Some(l) = fold.read().unwrap().live {
            seen.insert(l.0);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The storm ends: everything is archived (within the pacer's last penalty, ≤ a few s).
    chain.tx_429.store(false, Ordering::SeqCst);
    let status = if scope == PacerScope::Method {
        caught_up(&fold, 3_119, 60).await;
        fold.read().unwrap().ingest.json()
    } else {
        Value::Null
    };
    stop_tx.send(true).unwrap();
    h.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&data);
    (seen, pacer, chain, status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_get_transaction_429_storm_never_freezes_the_live_slot() {
    let (seen, pacer, chain, status) = storm(PacerScope::Method, 3).await;
    // ≈ 3 s / 20 ms: the Clock keeps (nearly) every turn; the storm's 429s back off getTransaction alone.
    assert!(
        seen.len() >= 40,
        "live slot advanced {} times in 3 s of 429s",
        seen.len()
    );
    let m = pacer.methods();
    let of = |name: &str| m.iter().find(|s| s.method == name).cloned();
    let gt = of("getTransaction").expect("getTransaction paced");
    assert!(gt.throttles >= 1, "{m:?}");
    assert_eq!(of("getAccountInfo").map(|s| s.throttles), Some(0), "{m:?}");
    // The 429 path really went through RpcClient::call: its turns were held ≥ Retry-After (1 s) apart.
    let stamps = chain.stamps.lock().unwrap().clone();
    let tx: Vec<Instant> = stamps
        .iter()
        .filter(|(m, _)| m == "getTransaction")
        .map(|s| s.1)
        .collect();
    let storm_429 = chain.count("429");
    assert!(
        (1..=4).contains(&storm_429),
        "{storm_429} getTransaction 429s in 3 s: each waits ≥ Retry-After"
    );
    for w in tx.windows(2).take(storm_429 as usize) {
        assert!(
            w[1] - w[0] >= Duration::from_millis(950),
            "a getTransaction only {:?} after its 429",
            w[1] - w[0]
        );
    }
    // The process total stays ≤ 1 per gap (20 ms) across every method: each request ≥ half the gap after the
    // previous one (loopback connect / scheduling skew), and no 50 in a row inside 49 gaps.
    let at: Vec<Instant> = stamps.iter().map(|s| s.1).collect();
    for w in at.windows(2) {
        assert!(
            w[1] - w[0] >= Duration::from_millis(10),
            "two requests {:?} apart",
            w[1] - w[0]
        );
    }
    for w in at.windows(50) {
        assert!(w[49] - w[0] >= Duration::from_millis(49 * 20 - 10));
    }
    // The storm over: every transaction archived, each answered once.
    assert_eq!(status["backlog"], json!(0));
    assert_eq!(chain.count("getTransaction"), 120);
    assert_eq!(status["lastArchivedSlot"], json!(3_119));

    // The same run under the pre-#292 scope (FCLIENT_PACER_SCOPE=process): every 429 holds the Clock back too.
    let (frozen, _, _, _) = storm(PacerScope::Process, 3).await;
    assert!(
        frozen.len() * 4 < seen.len(),
        "process scope: live slot advanced {} times (method scope {})",
        frozen.len(),
        seen.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failing_clock_is_logged_once_a_minute_by_the_herald_binary() {
    const TOTAL: u64 = 120;
    let chain = Chain::with_transfers(TOTAL, 4_000);
    chain.clock_fail.store(true, Ordering::SeqCst);
    let url = chunk_rpc::start(chain.clone()).await;
    let data = tmp("tg7-clock-bin");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_frontier-herald"))
        .arg("--data")
        .arg(&data)
        .args(["--program", &recipient().to_string(), "--season", "1"])
        .args(["--rpc", &url, "--source", "rpc", "--cluster", "localnet"])
        .args([
            "--listen",
            "127.0.0.1:0",
            "--poll-ms",
            "20",
            "--clock-ms",
            "5",
        ])
        .args(["--rpc-min-gap-ms", "0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut err = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut err, &mut s);
        s
    });
    // ≥ 300 failed Clock reads (≥ 1.5 s at 5 ms) and the whole backlog archived.
    let t0 = Instant::now();
    while chain.count("getAccountInfo") < 300 || chain.count("getTransaction") < TOTAL {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "herald: {} clock reads, {} getTransaction",
            chain.count("getAccountInfo"),
            chain.count("getTransaction")
        );
        assert!(child.try_wait().unwrap().is_none(), "the herald exited");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let failed = chain.count("getAccountInfo");
    let st = std::process::Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(st.success());
    let code = tokio::task::spawn_blocking(move || child.wait().unwrap())
        .await
        .unwrap();
    let log = reader.join().unwrap();
    let lines: Vec<&str> = log
        .lines()
        .filter(|l| l.contains("clock read failed"))
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "{failed} failed Clock reads, {} log lines:\n{}",
        lines.len(),
        lines.join("\n")
    );
    assert!(
        lines[0].contains("(1 since the last log line)")
            && lines[0].contains("temporary clock read failure"),
        "{}",
        lines[0]
    );
    assert!(code.success(), "clean stop on SIGINT: {code:?}\n{log}");
    assert_eq!(
        chain.count("getTransaction"),
        TOTAL,
        "ingest went on regardless"
    );
    assert_eq!(records(&data).len(), TOTAL as usize);
    let _ = std::fs::remove_dir_all(&data);
}
