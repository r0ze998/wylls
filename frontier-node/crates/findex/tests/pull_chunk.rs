//! herald-pull-chunk (proposal inbox 2026-11-27 1651 §5 item 3a): a capped
//! `RpcPoll` (`max_batch`) archives a long backlog in chunks — each chunk
//! its own archive batch, with `Source::backlog` = listed − handed back —
//! and an `Enriched` getMultipleAccounts failure mid-backlog hands back at
//! most one chunk (≤ 50), not the whole listed batch. Loopback fake RPC
//! only (127.0.0.1:0): 0 devnet calls.

#[path = "support/chunk_rpc.rs"]
mod chunk_rpc;

use std::path::PathBuf;

use chunk_rpc::{recipient, Chain};
use findex::{Enriched, Findex, RpcPoll, Source};

const TOTAL: u64 = 1_587;
const N: usize = 50;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "findex-chunk-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn source(url: &str) -> Enriched<RpcPoll> {
    Enriched::new(
        RpcPoll::new(url.to_string(), recipient()).with_max_batch(N),
        url.to_string(),
        fclient::addr::system_program(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_1587_tx_backlog_is_archived_in_chunks_of_50() {
    let chain = Chain::with_transfers(TOTAL, 1_000);
    let url = chunk_rpc::start(chain.clone()).await;
    let d = tmp("chunks");
    let mut fx = Findex::open(&d, fclient::addr::system_program(), None, 1 << 22).unwrap();
    let mut src = source(&url);
    fx.resume(&mut src);
    assert_eq!(src.backlog(), None, "unknown before the first pull");

    let mut chunks = 0u64;
    let mut archived = 0u64;
    let mut last_slot = 0u64;
    loop {
        let got = fx.ingest(&mut src).await.unwrap();
        if got.is_empty() {
            break;
        }
        chunks += 1;
        assert!(got.len() <= N, "chunk {chunks}: {} > {N}", got.len());
        archived += got.len() as u64;
        // Each chunk is its own archive batch: the archive (and the cursor
        // stored with it) advance chunk by chunk.
        fx.commit().unwrap();
        assert_eq!(fx.archive.last_seq(), archived);
        assert_eq!(src.backlog(), Some(TOTAL - archived), "listed − archived");
        assert!(got.iter().all(|r| r.post.len() == 1), "enriched");
        let s = got.last().unwrap().slot;
        assert!(s > last_slot, "oldest first, chunk after chunk");
        last_slot = s;
    }
    assert!(chunks >= 32, "1,587 / 50 → ≥ 32 chunks, got {chunks}");
    assert_eq!(archived, TOTAL);
    assert_eq!(fx.archive.verify(), Ok(TOTAL));
    assert_eq!(src.backlog(), Some(0), "caught up");
    assert_eq!(
        chain.count("getTransaction"),
        TOTAL,
        "each transaction fetched once"
    );
    assert_eq!(chain.count("getMultipleAccounts"), TOTAL);
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mid_backlog_account_read_failure_loses_at_most_one_chunk() {
    let chain = Chain::with_transfers(TOTAL, 1_000);
    // The 3rd chunk's 25th account read fails (call 125).
    chain
        .fail_accounts_call
        .store(2 * N as u64 + 25, std::sync::atomic::Ordering::SeqCst);
    let url = chunk_rpc::start(chain.clone()).await;
    let d = tmp("fail");
    let mut fx = Findex::open(&d, fclient::addr::system_program(), None, 1 << 22).unwrap();
    let mut src = source(&url);
    fx.resume(&mut src);

    for _ in 0..2 {
        assert_eq!(fx.ingest(&mut src).await.unwrap().len(), N);
    }
    let e = fx.ingest(&mut src).await;
    assert!(e.is_err(), "the third chunk fails on its 25th account read");
    fx.commit().unwrap();
    assert_eq!(
        fx.archive.last_seq(),
        2 * N as u64,
        "the first two chunks stay archived"
    );
    assert_eq!(
        src.backlog(),
        Some(TOTAL - 2 * N as u64),
        "the failed chunk went back to the backlog"
    );
    let fetched_before_retry = chain.count("getTransaction");
    assert_eq!(fetched_before_retry, 3 * N as u64);

    loop {
        if fx.ingest(&mut src).await.unwrap().is_empty() {
            break;
        }
    }
    fx.commit().unwrap();
    assert_eq!(
        fx.archive.verify(),
        Ok(TOTAL),
        "nothing lost, nothing doubled"
    );
    let refetched = chain.count("getTransaction") - TOTAL;
    assert!(
        refetched <= N as u64,
        "the failure re-fetched {refetched} > {N}"
    );
    assert_eq!(refetched, N as u64, "exactly the failed chunk");
    let _ = std::fs::remove_dir_all(&d);
}

/// Without a cap (the default, as the keeper and verifier use it) one pull
/// still takes the whole listed batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_cap_one_pull_takes_everything() {
    let chain = Chain::with_transfers(120, 10);
    let url = chunk_rpc::start(chain.clone()).await;
    let mut poll = RpcPoll::new(url, recipient());
    let got = poll.pull().await.unwrap();
    assert_eq!(got.len(), 120);
    assert_eq!(poll.backlog(), Some(0));
    assert_eq!(RpcPoll::coverage(&poll)["heldBack"], 0);
}

/// verify-pr288: the chunked archive holds exactly the records (`TxRecord`
/// ==, seq and post-states included) of one unchunked run, also when
/// account reads fail on a chunk's first or last read or mid-chunk: no
/// transaction lost or doubled across a chunk boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chunked_archive_equals_the_unchunked_one() {
    async fn run(cap: usize, fails: &[u64], name: &str) -> (Vec<fclient::ports::TxRecord>, usize) {
        let chain = Chain::with_transfers(TOTAL, 1_000);
        let url = chunk_rpc::start(chain.clone()).await;
        let d = tmp(name);
        let mut fx = Findex::open(&d, fclient::addr::system_program(), None, 1 << 22).unwrap();
        let mut src = Enriched::new(
            RpcPoll::new(url.clone(), recipient()).with_max_batch(cap),
            url.clone(),
            fclient::addr::system_program(),
        );
        fx.resume(&mut src);
        let mut fails = fails.iter();
        let arm = |f: Option<&u64>| {
            chain
                .fail_accounts_call
                .store(f.copied().unwrap_or(0), std::sync::atomic::Ordering::SeqCst)
        };
        arm(fails.next());
        let mut errs = 0usize;
        loop {
            match fx.ingest(&mut src).await {
                Ok(got) if got.is_empty() => break,
                Ok(got) => assert!(got.len() <= cap),
                Err(_) => {
                    errs += 1;
                    arm(fails.next());
                }
            }
            fx.commit().unwrap();
        }
        assert_eq!(fx.archive.verify(), Ok(TOTAL), "{name}");
        let mut recs = vec![];
        fx.archive
            .for_each_after(0, |r| {
                recs.push(r);
                Ok(())
            })
            .unwrap();
        let _ = std::fs::remove_dir_all(&d);
        (recs, errs)
    }
    let (whole, _) = run(usize::MAX, &[], "whole").await;
    assert_eq!(whole.len() as u64, TOTAL);
    // Calls 101 / 150: the 3rd chunk's first / last account read; then the
    // retried chunk's 24th (call 175 = 151 + 24); cap 37: chunk 2's first.
    for (cap, fails, name) in [
        (N, vec![101, 175], "n50"),
        (N, vec![150], "n50-last"),
        (37, vec![38], "n37"),
    ] {
        let (recs, errs) = run(cap, &fails, name).await;
        assert_eq!(errs, fails.len(), "{name}: every armed failure hit");
        assert!(
            recs == whole,
            "{name}: archive differs from the unchunked run"
        );
    }
}
