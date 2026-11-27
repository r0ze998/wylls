//! herald-pull-chunk (inbox 2026-11-27 1651 §5 item 3a–c): the ingest
//! loop over a capped `RpcPoll` archives a 1,587-transaction backlog chunk
//! by chunk while the Clock, read on its own timer, keeps the live slot
//! moving — also inside one long pull — and `/h/status` `ingest` carries
//! `backlog` (listed − archived, or "unknown") and `lastArchivedSlot`.
//! Loopback fake RPC only (127.0.0.1:0): 0 devnet calls.

mod common;

#[path = "../../findex/tests/support/chunk_rpc.rs"]
mod chunk_rpc;

use std::collections::BTreeSet;
use std::sync::atomic::Ordering;
use std::time::Duration;

use chunk_rpc::{recipient, Chain};
use common::tmp;
use fclient::rpc::RpcPort;
use findex::{Enriched, RpcPoll};
use herald_fold::runner::{run_with, Ingest, IngestCfg};
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

fn open(name: &str) -> (Ingest, std::path::PathBuf) {
    let data = tmp(name);
    let mut cfg = IngestCfg::new(&data, fclient::addr::system_program(), 1);
    cfg.exact_post = false;
    let (tx, _) = broadcast::channel(4_096);
    (Ingest::open(cfg, tx).unwrap(), data)
}

fn src(url: &str, cap: usize) -> Enriched<RpcPoll> {
    Enriched::new(
        RpcPoll::new(url.to_string(), recipient()).with_max_batch(cap),
        url.to_string(),
        fclient::addr::system_program(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_slot_and_archive_advance_chunk_by_chunk() {
    const TOTAL: u64 = 1_587;
    let chain = Chain::with_transfers(TOTAL, 5_000);
    chain.tx_delay_us.store(200, Ordering::SeqCst);
    let url = chunk_rpc::start(chain.clone()).await;
    let (ing, data) = open("chunk-live");
    let fold = ing.fold.clone();
    assert_eq!(
        fold.read().unwrap().ingest.json()["backlog"],
        json!("unknown")
    );
    assert_eq!(
        fold.read().unwrap().ingest.json()["lastArchivedSlot"],
        Value::Null
    );
    let (stop_tx, stop) = watch::channel(false);
    let port = RpcPort::new(url.clone(), recipient());
    let h = tokio::spawn(run_with(
        ing,
        src(&url, 50),
        Some(port),
        Duration::from_millis(20),
        Duration::from_millis(5),
        stop,
    ));

    // Sample (lastArchivedSlot, backlog, live slot) until caught up.
    let mut samples: Vec<(Option<u64>, Value, Option<u64>)> = vec![];
    let t0 = std::time::Instant::now();
    loop {
        let (j, live) = {
            let f = fold.read().unwrap();
            (f.ingest.json(), f.live.map(|l| l.0))
        };
        let las = j["lastArchivedSlot"].as_u64();
        samples.push((las, j["backlog"].clone(), live));
        if las == Some(5_000 + TOTAL - 1) && j["backlog"] == json!(0) {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "did not catch up: {:?}",
            samples.last()
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    stop_tx.send(true).unwrap();
    h.await.unwrap().unwrap();

    // Chunks: the archive's newest slot took many intermediate values
    // (≥ 32 chunks of ≤ 50; sampling may skip some, so ≥ 16 seen).
    let archived: BTreeSet<u64> = samples.iter().filter_map(|s| s.0).collect();
    assert!(
        archived.len() >= 16,
        "archive advanced in {} visible steps",
        archived.len()
    );
    // The backlog counts down while behind.
    let behind: Vec<u64> = samples
        .iter()
        .filter_map(|s| s.1.as_u64())
        .filter(|&b| b > 0)
        .collect();
    assert!(
        behind.len() >= 2 && behind.iter().all(|&b| b <= TOTAL),
        "{behind:?}"
    );
    assert!(
        behind.windows(2).all(|w| w[1] <= w[0]),
        "backlog never grows here"
    );
    // The live slot moved while the archive was still behind, and between
    // two archive steps.
    let live_behind: BTreeSet<u64> = samples
        .iter()
        .filter(|s| s.1.as_u64().is_some_and(|b| b > 0))
        .filter_map(|s| s.2)
        .collect();
    assert!(
        live_behind.len() >= 10,
        "live slot advanced {} times while behind",
        live_behind.len()
    );
    let mut moved_within_a_chunk = 0;
    for w in samples.windows(2) {
        if w[0].0 == w[1].0 && w[0].2.is_some() && w[0].2 != w[1].2 {
            moved_within_a_chunk += 1;
        }
    }
    assert!(
        moved_within_a_chunk >= 5,
        "live slot moved inside a chunk {moved_within_a_chunk} times"
    );
    // Every transaction fetched once; the Clock read on its own timer.
    assert_eq!(chain.count("getTransaction"), TOTAL);
    assert!(chain.count("getAccountInfo") >= 10);
    let _ = std::fs::remove_dir_all(&data);
}

/// Even one long uncapped pull no longer freezes the live slot (before
/// this change the Clock was read only after the pull returned).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_clock_ticks_during_one_long_pull() {
    let chain = Chain::with_transfers(150, 9_000);
    chain.tx_delay_us.store(3_000, Ordering::SeqCst); // ≥ 450 ms for the pull
    let url = chunk_rpc::start(chain.clone()).await;
    let (ing, data) = open("chunk-long");
    let fold = ing.fold.clone();
    let (stop_tx, stop) = watch::channel(false);
    let port = RpcPort::new(url.clone(), recipient());
    let h = tokio::spawn(run_with(
        ing,
        src(&url, usize::MAX),
        Some(port),
        Duration::from_millis(20),
        Duration::from_millis(10),
        stop,
    ));
    let mut seen = BTreeSet::new();
    let t0 = std::time::Instant::now();
    while chain.count("getTransaction") < 140 {
        let (folded, live) = {
            let f = fold.read().unwrap();
            (f.st.folded_through, f.live)
        };
        assert_eq!(folded, 0, "still inside the first pull");
        if let Some(l) = live {
            seen.insert(l.0);
        }
        assert!(t0.elapsed() < Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        seen.len() >= 5,
        "live slot advanced {} times inside one pull",
        seen.len()
    );
    stop_tx.send(true).unwrap();
    h.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&data);
}

/// verify-pr288: a pull that succeeds after failures (`IngestHealth::ok`)
/// keeps `backlog` and `lastArchivedSlot`; the loop records the backlog
/// before the pull's outcome, so dropping either here would blank it in
/// `/h/status` right after every recovery (health would then read
/// "behind, NOT progressing" for want of a lastArchivedSlot).
#[test]
fn a_recovered_pull_keeps_backlog_and_last_archived_slot() {
    let mut h = herald_fold::fold::IngestHealth {
        backlog: Some(412),
        last_archived_slot: Some(900),
        ..Default::default()
    };
    h.failed("getMultipleAccounts: 429", 1, false);
    assert_eq!(h.json()["state"], "failing");
    h.ok();
    let j = h.json();
    assert_eq!(j["state"], "ok");
    assert_eq!(j["backlog"], json!(412));
    assert_eq!(j["lastArchivedSlot"], json!(900));
}
