//! verify-pr158: the archive's lookup table snapshots (`"tables"` of a
//! record frame, verifier-alt-archive) — old archives (no `tables`) read
//! unchanged and byte-identical, a snapshot rides in its record's frame
//! (sealed sha256 covers it), a malformed one is refused, never dropped.

use std::path::{Path, PathBuf};

use fclient::alt::Snapshot;
use fclient::ports::{Signature, TxRecord};
use findex::archive::Archive;
use serde_json::json;
use solana_address::Address;

fn record(n: u64) -> TxRecord {
    let mut sig = [0u8; 64];
    sig[..8].copy_from_slice(&n.to_le_bytes());
    TxRecord {
        seq: n,
        slot: 100 + n,
        signature: Signature::from(sig),
        block_time: 0,
        tx: vec![n as u8; 120],
        logs: vec![format!("log {n}")],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
        loaded: Default::default(),
    }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("findex-pr158-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn segment_bytes(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy() != "manifest.json")
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read(&p).unwrap(),
            )
        })
        .collect();
    v.sort();
    v
}

fn snapshot(t: u8, used_by: &TxRecord) -> Snapshot {
    Snapshot {
        table: Address::new_from_array([t; 32]),
        used_by: Some((used_by.signature, used_by.slot)),
        read_slot: Some(used_by.slot + 1),
        account: Some(None),
        history: Some(vec![]),
        source: "findex".into(),
    }
}

#[test]
fn an_archive_without_tables_is_byte_identical_and_reads_no_snapshots() {
    let recs: Vec<TxRecord> = (1..=10).map(record).collect();
    let (a, b) = (tmp("old"), tmp("new-none"));
    let mut old = Archive::open(&a, 700).unwrap();
    old.append(&recs, json!({"after": 10})).unwrap();
    old.commit().unwrap();
    let mut new = Archive::open(&b, 700).unwrap();
    new.append_with_tables(&recs, &vec![None; recs.len()], json!({"after": 10}), false)
        .unwrap();
    new.commit().unwrap();
    assert_eq!(segment_bytes(&a), segment_bytes(&b));
    // the old archive (as main's findex wrote it) reopens and reads
    let old = Archive::open(&a, 700).unwrap();
    assert!(old.lookup_snapshots().unwrap().is_empty());
    let mut got = vec![];
    old.for_each_after(0, |r| {
        got.push(r);
        Ok(())
    })
    .unwrap();
    assert_eq!(got.len(), 10);
    old.verify().unwrap();
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}

#[test]
fn tables_ride_in_their_record_frame_and_are_covered() {
    let recs: Vec<TxRecord> = (1..=10).map(record).collect();
    let d = tmp("tables");
    let mut ar = Archive::open(&d, 700).unwrap();
    let mut tables = vec![None; recs.len()];
    tables[1] = Some(json!([snapshot(7, &recs[1]).to_json()]));
    tables[8] = Some(json!([
        snapshot(8, &recs[8]).to_json(),
        snapshot(9, &recs[8]).to_json()
    ]));
    ar.append_with_tables(&recs, &tables, json!({"after": 10}), false)
        .unwrap();
    ar.commit().unwrap();
    let ar = Archive::open(&d, 700).unwrap();
    let s = ar.lookup_snapshots().unwrap();
    assert_eq!(
        s.iter()
            .map(|(q, s)| (*q, s.table.to_bytes()[0]))
            .collect::<Vec<_>>(),
        vec![(2, 7), (9, 8), (9, 9)]
    );
    // the records themselves read as without tables
    let mut got = vec![];
    ar.for_each_after(0, |r| {
        got.push(r);
        Ok(())
    })
    .unwrap();
    assert_eq!(got.len(), 10);
    assert_eq!(got[1].signature, recs[1].signature);
    ar.verify().unwrap();
    // a byte of a sealed segment's snapshot flipped: the archive check
    // refuses it (sha256), and so does the read (frame check / JSON)
    let segs = segment_bytes(&d);
    let (name, mut bytes) = segs
        .into_iter()
        .find(|(_, b)| b.windows(7).any(|w| w == b"findex\""))
        .expect("a segment with a snapshot");
    let at = bytes.windows(7).position(|w| w == b"findex\"").unwrap();
    bytes[at] = b'X';
    std::fs::write(d.join(&name), &bytes).unwrap();
    let ar = Archive::open(&d, 700);
    let refused = match ar {
        Err(_) => true,
        Ok(ar) => ar.verify().is_err(),
    };
    assert!(refused, "a tampered snapshot byte goes unnoticed");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_malformed_tables_value_is_an_error_not_dropped() {
    let recs: Vec<TxRecord> = (1..=3).map(record).collect();
    for bad in [
        json!("not a list"),
        json!([{"table": "nope"}]),
        json!([{"table": Address::new_from_array([1; 32]).to_string(), "history": [{"slot": 1}]}]),
    ] {
        let d = tmp("bad");
        let mut ar = Archive::open(&d, 1 << 20).unwrap();
        let mut tables = vec![None; recs.len()];
        tables[0] = Some(bad.clone());
        ar.append_with_tables(&recs, &tables, json!({}), false)
            .unwrap();
        ar.commit().unwrap();
        let ar = Archive::open(&d, 1 << 20).unwrap();
        assert!(ar.lookup_snapshots().is_err(), "{bad}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
