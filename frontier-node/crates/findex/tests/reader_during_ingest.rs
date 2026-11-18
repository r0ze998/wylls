//! loop-play B4-D: a reader on its own connection (the herald's
//! `/h/events`, `findex::Reader`) must never find the index blocked while
//! a healthy ingest commits. Before, `Findex::ingest` committed
//! mark-incomplete, the rows and mark-complete as three SQLite
//! transactions, and a read between them got "index coverage is blocked"
//! (503 IndexBusy). Now the rows, `last_seq` and the complete mark are one
//! transaction (WAL: a reader sees the state before or after it).
//!
//! Literal records only: no keys, signatures, network or test server.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use fclient::ports::{PortResult, Signature, TxRecord};
use fclient::Address;
use findex::{Findex, Reader, Source};
use serde_json::{json, Value};

/// Hands out one record per pull, so every pull is one ingest commit.
struct OneByOne {
    n: u64,
    after: u64,
}

impl Source for OneByOne {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        if self.after >= self.n {
            return Ok(vec![]);
        }
        self.after += 1;
        Ok(vec![record(self.after)])
    }
    fn cursor(&self) -> Value {
        json!({"after": self.after})
    }
    fn restore(&mut self, v: &Value) {
        self.after = v.get("after").and_then(Value::as_u64).unwrap_or(0);
    }
}

fn record(i: u64) -> TxRecord {
    TxRecord {
        seq: i,
        slot: i,
        signature: Signature::from([(i % 251) as u8; 64]),
        block_time: 0,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn tmp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "findex-reader-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reader_never_sees_a_healthy_ingest_as_blocked() {
    const N: u64 = 400;
    let d = tmp("race");
    let mut fx = Findex::open(&d, Address::new_from_array([23; 32]), None, 1 << 20).unwrap();
    let path = d.join("index.sqlite");
    let done = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicU64::new(0));
    let reader = {
        let (done, reads, path) = (done.clone(), reads.clone(), path.clone());
        std::thread::spawn(move || -> Vec<String> {
            let mut errors = vec![];
            // One long-lived reader (the herald keeps its `Reader`) and a
            // fresh open each round (the herald reopens after an error).
            let kept = Reader::open(&path).unwrap();
            while !done.load(Ordering::Acquire) {
                if let Err(e) = kept.events_after(0, 10) {
                    errors.push(format!("kept reader: {e}"));
                }
                match Reader::open(&path) {
                    Ok(r) => {
                        if let Err(e) = r.events_after(0, 10) {
                            errors.push(format!("fresh reader: {e}"));
                        }
                    }
                    Err(e) => errors.push(format!("open: {e}")),
                }
                reads.fetch_add(1, Ordering::Relaxed);
            }
            errors
        })
    };
    let mut src = OneByOne { n: N, after: 0 };
    let mut ingested = 0;
    loop {
        let got = fx.ingest(&mut src).await.unwrap();
        if got.is_empty() {
            break;
        }
        ingested += got.len();
        // Give the reader thread a chance between commits.
        tokio::task::yield_now().await;
    }
    done.store(true, Ordering::Release);
    let errors = reader.join().unwrap();
    assert_eq!(ingested as u64, N);
    assert_eq!(fx.index.last_seq().unwrap(), N);
    assert!(reads.load(Ordering::Relaxed) > 0, "the reader never ran");
    assert!(
        errors.is_empty(),
        "{} of {} reads failed, first: {:?}",
        errors.len(),
        reads.load(Ordering::Relaxed),
        errors.first()
    );
    drop(fx);
    let _ = std::fs::remove_dir_all(d);
}

/// The single transaction still fails closed: a batch the index cannot
/// take (a sequence gap) commits nothing and leaves the coverage blocked
/// for readers, and the ingester stops (reopen required).
#[tokio::test]
async fn a_failed_ingest_still_blocks_readers() {
    struct Gap;
    impl Source for Gap {
        async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
            Ok(vec![record(1)])
        }
        fn cursor(&self) -> Value {
            json!({})
        }
        fn restore(&mut self, _: &Value) {}
    }
    let d = tmp("gap");
    let mut fx = Findex::open(&d, Address::new_from_array([23; 32]), None, 1 << 20).unwrap();
    assert!(Reader::open(&d.join("index.sqlite")).is_ok());
    // Make the index refuse the batch: a row for seq 1 already in `tx`
    // (PRIMARY KEY) while `last_seq` is still 0.
    fx.index
        .conn
        .execute("INSERT INTO tx(seq, slot, sig) VALUES(1, 1, 'x')", [])
        .unwrap();
    assert!(fx.ingest(&mut Gap).await.is_err());
    assert!(fx.is_poisoned());
    assert_eq!(fx.index.last_seq().unwrap(), 0);
    assert!(
        Reader::open(&d.join("index.sqlite")).is_err(),
        "a failed index write must leave readers refused"
    );
    drop(fx);
    let _ = std::fs::remove_dir_all(d);
}
