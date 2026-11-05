//! A failed store write must not let the same source advance past an
//! unarchived batch. Recovery starts from the durable manifest, not the
//! partially advanced in-memory Archive.

use std::path::PathBuf;
use std::time::Duration;

use fclient::ports::{PortResult, Signature, TxRecord};
use fclient::Address;
use findex::{Findex, Source};
use serde_json::{json, Value};

struct VecSource {
    records: Vec<TxRecord>,
    after: u64,
    pulls: usize,
}

impl VecSource {
    fn new(n: u64) -> Self {
        Self {
            records: (1..=n).map(record).collect(),
            after: 0,
            pulls: 0,
        }
    }
}

impl Source for VecSource {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        self.pulls += 1;
        let got: Vec<_> = self
            .records
            .iter()
            .filter(|r| r.seq > self.after)
            .cloned()
            .collect();
        if let Some(last) = got.last() {
            self.after = last.seq;
        }
        Ok(got)
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
        signature: Signature::from([i as u8; 64]),
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
        "findex-store-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn open(dir: &PathBuf, segment_bytes: u64) -> Findex {
    Findex::open(dir, Address::new_from_array([23; 32]), None, segment_bytes).unwrap()
}

#[tokio::test]
async fn manifest_write_failure_requires_reopen_and_replays_the_batch() {
    let d = tmp("manifest");
    let mut fx = open(&d, 1 << 20);
    let mut src = VecSource::new(2);
    let fault = d.join("archive/manifest.json.tmp");
    std::fs::create_dir(&fault).unwrap();

    assert!(fx.ingest(&mut src).await.is_err());
    assert!(fx.is_poisoned());
    assert_eq!(src.after, 2, "source has already advanced");
    let pulls = src.pulls;
    assert!(fx.ingest(&mut src).await.is_err());
    assert_eq!(src.pulls, pulls);
    assert!(fx.commit().is_err());
    drop(fx);

    std::fs::remove_dir(&fault).unwrap();
    let mut fx = open(&d, 1 << 20);
    assert_eq!(fx.archive.verify(), Ok(0));
    assert_eq!(fx.index.last_seq().unwrap(), 0);
    fx.resume(&mut src);
    assert_eq!(src.after, 0);
    let got = fx.ingest(&mut src).await.unwrap();
    assert_eq!(got.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(fx.archive.verify(), Ok(2));
    assert_eq!(fx.index.tx_count().unwrap(), (2, 0));
    drop(fx);
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn mid_batch_roll_failure_discards_unnamed_frames_before_replay() {
    let d = tmp("midbatch");
    let mut fx = open(&d, 1);
    let mut src = VecSource::new(2);
    let fault = d.join("archive/seg-000002.log");
    std::fs::create_dir(&fault).unwrap();

    assert!(fx.ingest(&mut src).await.is_err());
    assert!(fx.is_poisoned());
    assert!(d.join("archive/seg-000001.log").exists());
    assert!(fx.commit().is_err());
    drop(fx);

    std::fs::remove_dir(&fault).unwrap();
    let mut fx = open(&d, 1);
    assert_eq!(fx.archive.verify(), Ok(0), "unnamed first frame is removed");
    fx.resume(&mut src);
    let got = fx.ingest(&mut src).await.unwrap();
    assert_eq!(got.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(fx.archive.verify(), Ok(2));
    drop(fx);
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn failed_roll_after_uncommitted_batch_truncates_the_ahead_index() {
    let d = tmp("group");
    let mut fx = open(&d, 1);
    fx.archive.commit_every = Duration::from_secs(3_600);
    let mut src = VecSource::new(1);
    assert_eq!(fx.ingest(&mut src).await.unwrap().len(), 1);
    assert!(fx.archive.uncommitted());
    assert_eq!(fx.index.last_seq().unwrap(), 1);
    src.records.push(record(2));
    let fault = d.join("archive/seg-000002.log");
    std::fs::create_dir(&fault).unwrap();
    assert!(fx.ingest(&mut src).await.is_err());
    assert!(fx.commit().is_err());
    drop(fx);

    std::fs::remove_dir(&fault).unwrap();
    let mut fx = open(&d, 1);
    assert_eq!(fx.archive.verify(), Ok(0));
    assert_eq!(fx.index.last_seq().unwrap(), 0, "rollback the ahead index");
    fx.resume(&mut src);
    let got = fx.ingest(&mut src).await.unwrap();
    assert_eq!(got.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(fx.archive.verify(), Ok(2));
    assert_eq!(fx.index.tx_count().unwrap(), (2, 0));
    drop(fx);
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn checkpoint_failure_cannot_publish_an_uncommitted_index() {
    let d = tmp("checkpoint");
    let mut fx = open(&d, 1 << 20);
    fx.archive.commit_every = Duration::from_secs(3_600);
    let mut src = VecSource::new(1);
    assert_eq!(fx.ingest(&mut src).await.unwrap().len(), 1);
    assert!(fx.archive.uncommitted());
    assert_eq!(fx.index.last_seq().unwrap(), 1);
    let fault = d.join("archive/manifest.json.tmp");
    std::fs::create_dir(&fault).unwrap();
    assert!(fx.commit().is_err());
    assert!(fx.is_poisoned());
    let pulls = src.pulls;
    assert!(fx.ingest(&mut src).await.is_err());
    assert_eq!(src.pulls, pulls);
    drop(fx);

    std::fs::remove_dir(&fault).unwrap();
    let mut fx = open(&d, 1 << 20);
    assert_eq!(fx.archive.verify(), Ok(0));
    assert_eq!(fx.index.last_seq().unwrap(), 0);
    fx.resume(&mut src);
    assert_eq!(fx.ingest(&mut src).await.unwrap().len(), 1);
    assert_eq!(fx.archive.verify(), Ok(1));
    drop(fx);
    std::fs::remove_dir_all(d).unwrap();
}

#[tokio::test]
async fn index_failure_requires_reopen_and_catches_up_from_the_archive() {
    let d = tmp("index");
    let mut fx = open(&d, 1 << 20);
    let mut src = VecSource::new(1);
    fx.index.conn.execute_batch("PRAGMA query_only=ON").unwrap();
    assert!(fx.ingest(&mut src).await.is_err());
    assert!(fx.is_poisoned());
    assert!(fx.commit().is_err());
    drop(fx);

    let mut fx = open(&d, 1 << 20);
    assert_eq!(fx.archive.verify(), Ok(1));
    assert_eq!(fx.index.tx_count().unwrap(), (1, 0));
    fx.resume(&mut src);
    assert!(fx.ingest(&mut src).await.unwrap().is_empty());
    src.records.push(record(2));
    let got = fx.ingest(&mut src).await.unwrap();
    assert_eq!(got.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![2]);
    assert_eq!(fx.archive.verify(), Ok(2));
    drop(fx);
    std::fs::remove_dir_all(d).unwrap();
}
