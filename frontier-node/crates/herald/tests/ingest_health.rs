//! `/h/status` says when the ingest is not keeping up: a pull that keeps
//! failing (here "history gap", as findex reports a node that pruned past
//! the archive) leaves the views where they were, and the status shows
//! `failing` with the error, the count and since when, until a pull
//! succeeds. A failed store (findex poisoned) is `stopped` and ends the
//! loop, as before, so a supervisor reopens it.

mod common;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use common::{tmp, VecSource};
use fclient::ports::{PortError, PortResult, TxRecord};
use herald_fold::fixture;
use herald_fold::fold::{Fold, IngestHealth};
use herald_fold::runner::{run, Ingest, IngestCfg};
use serde_json::Value;
use tokio::sync::{broadcast, watch};

/// Fails `fail` pulls with a history gap, then serves `inner`.
struct Gappy {
    inner: VecSource,
    fail: Arc<std::sync::atomic::AtomicU64>,
}

impl findex::Source for Gappy {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        let left = self.fail.load(std::sync::atomic::Ordering::SeqCst);
        if left > 0 {
            self.fail
                .store(left - 1, std::sync::atomic::Ordering::SeqCst);
            return Err(PortError::Unavailable(
                "history gap: the node's history no longer reaches the archive's last signature"
                    .into(),
            ));
        }
        self.inner.pull().await
    }
    fn cursor(&self) -> Value {
        self.inner.cursor()
    }
    fn restore(&mut self, v: &Value) {
        self.inner.restore(v)
    }
    fn coverage(&self) -> Option<Value> {
        let gap = self.fail.load(std::sync::atomic::Ordering::SeqCst) > 0;
        Some(serde_json::json!({"state": if gap { "gap" } else { "unverifiable" }}))
    }
}

async fn health(fold: &Arc<RwLock<Fold>>) -> (IngestHealth, u64) {
    let f = fold.read().unwrap();
    (f.ingest.clone(), f.st.folded_through)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_pull_shows_in_status_until_one_succeeds() {
    let txs = fixture::mini_season(4);
    let data = tmp("health");
    let (diffs, _) = broadcast::channel(16_384);
    let mut c = IngestCfg::new(&data, fixture::program(), fixture::SEASON_ID);
    c.checkpoint_slots = u64::MAX / 2;
    let ing = Ingest::open(c, diffs).unwrap();
    let fold = ing.fold.clone();
    let fail = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
    let src = Gappy {
        inner: VecSource::new(txs.clone(), 1_000),
        fail: fail.clone(),
    };
    let (stop_tx, stop) = watch::channel(false);
    let task = tokio::spawn(run(
        ing,
        src,
        None::<fclient::rpc::RpcPort>,
        Duration::from_millis(5),
        stop,
    ));

    // Failing: the views stay at nothing folded, the status says why.
    let mut seen = None;
    for _ in 0..400 {
        let (h, folded) = health(&fold).await;
        if h.failures >= 3 {
            seen = Some((h, folded));
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let (h, folded) = seen.expect("failures counted");
    assert_eq!(folded, 0);
    assert!(!h.stopped);
    assert!(h.since_ms > 0);
    let j = h.json();
    assert_eq!(j["state"], "failing");
    assert!(j["error"].as_str().unwrap().contains("history gap"), "{j}");
    assert_eq!(
        j["coverage"]["state"], "gap",
        "the source's coverage is shown"
    );

    // The node serves again: the status clears, the views catch up.
    fail.store(0, std::sync::atomic::Ordering::SeqCst);
    let mut ok = false;
    for _ in 0..400 {
        let (h, folded) = health(&fold).await;
        if h.failures == 0 && folded == txs.len() as u64 {
            assert_eq!(h.json()["state"], "ok");
            assert_eq!(
                h.json()["coverage"]["state"],
                "unverifiable",
                "a successful pull does not make the history complete"
            );
            assert!(h.json()["sinceMs"].is_null());
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(ok, "caught up and cleared");
    stop_tx.send(true).unwrap();
    task.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn a_failed_store_reads_stopped() {
    let mut h = IngestHealth::default();
    h.failed("archive save failed", 7, false);
    h.failed("findex store failed; reopen required", 9, true);
    let j = h.json();
    assert_eq!(j["state"], "stopped");
    assert_eq!(j["failures"], 2);
    assert_eq!(j["sinceMs"], 7);
}

#[test]
fn coverage_is_kept_when_a_pull_succeeds() {
    let mut h = IngestHealth {
        coverage: Some(serde_json::json!({"state": "unverifiable"})),
        ..IngestHealth::default()
    };
    h.failed("history gap", 1, false);
    h.ok();
    assert_eq!(h.json()["coverage"]["state"], "unverifiable");
    assert_eq!(IngestHealth::default().json()["coverage"], Value::Null);
}
