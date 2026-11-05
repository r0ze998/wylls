//! The contract every reader of the archive keeps, and any later sealing,
//! compression or checkpointing must keep with it: a damaged or missing
//! part of the archive is an error, never fewer records. The herald's
//! catch-up and the index's rebuild read through `for_each_after`; a gap
//! there would leave the fold and `/h/events` short with no sign of it.
//!
//! Separate from this, and not tested as passing here: the archive cannot
//! see transactions it never received (first pull, missing or older cursor,
//! a node missing a middle range). A clean walk is no proof of a complete
//! history.

use std::path::{Path, PathBuf};

use fclient::ports::{Signature, TxRecord};
use findex::{Archive, Findex};
use serde_json::json;
use solana_address::Address;

fn record(i: u64) -> TxRecord {
    TxRecord {
        seq: i,
        slot: i,
        signature: Signature::from([i as u8; 64]),
        block_time: 0,
        tx: vec![7; 40],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("findex-gap-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Ten records of about 200 B in 700-B segments: three sealed segments
/// of three records and an open one.
fn archive(dir: &Path) -> Archive {
    let mut a = Archive::open(dir, 700).unwrap();
    let recs: Vec<TxRecord> = (1..=10).map(record).collect();
    a.append(&recs, json!({"after": 10})).unwrap();
    a.commit().unwrap();
    a
}

/// The segments of the manifest (name, records, sealed).
fn segments(dir: &Path) -> Vec<(String, u64, bool)> {
    let m: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    m["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                s["records"].as_u64().unwrap(),
                !s["sha256"].is_null(),
            )
        })
        .collect()
}

fn seqs(a: &Archive) -> std::io::Result<Vec<u64>> {
    a.read_after(0)
        .map(|v| v.into_iter().map(|r| r.seq).collect())
}

/// A byte flipped inside a sealed segment's second frame: before this
/// contract the walk stopped at the damaged frame and went on with the next
/// segment, so a reader got fewer records and no error.
#[test]
fn a_damaged_frame_in_a_sealed_segment_is_an_error_not_a_shorter_archive() {
    let d = tmp("damaged");
    let a = archive(&d);
    let segs = segments(&d);
    assert!(segs.len() >= 3, "{segs:?}");
    let (name, records, sealed) = segs[0].clone();
    assert!(records >= 2 && sealed, "{segs:?}");
    let p = d.join(&name);
    let mut bytes = std::fs::read(&p).unwrap();
    let at = bytes.len() * 2 / 3; // inside a later frame of the segment
    bytes[at] ^= 0xFF;
    std::fs::write(&p, &bytes).unwrap();
    drop(a);
    let a = Archive::open(&d, 700).unwrap();
    assert!(a.verify().is_err(), "verify sees it");
    let e = seqs(&a).unwrap_err();
    assert!(e.to_string().contains(&name), "{e}");
    let _ = std::fs::remove_dir_all(&d);
}

/// A sealed segment whose file is gone (moved away, lost in a copy): an
/// error, not the remaining segments.
#[test]
fn a_missing_sealed_segment_is_an_error() {
    let d = tmp("missing");
    let a = archive(&d);
    let name = segments(&d)[1].0.clone();
    std::fs::remove_file(d.join(&name)).unwrap();
    drop(a);
    let a = Archive::open(&d, 700).unwrap();
    assert!(a.verify().is_err());
    assert!(seqs(&a).is_err());
    let _ = std::fs::remove_dir_all(&d);
}

/// A sealed segment rewritten with one record left out and its frames
/// still well formed (what a careless compaction or a partial copy could
/// produce): the record count and the sequence no longer match the
/// manifest, so readers stop.
#[test]
fn a_segment_missing_a_record_but_well_formed_is_an_error() {
    let d = tmp("short");
    let a = archive(&d);
    let p = d.join(&segments(&d)[0].0);
    let bytes = std::fs::read(&p).unwrap();
    // Drop the first frame (len u32 ‖ 8-byte hash ‖ payload), keep the rest,
    // pad to the manifest length so only the content differs.
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let mut rest = bytes[12 + len..].to_vec();
    rest.resize(bytes.len(), 0);
    std::fs::write(&p, &rest).unwrap();
    drop(a);
    let a = Archive::open(&d, 700).unwrap();
    assert!(
        seqs(&a).is_err(),
        "one record short is not a shorter archive"
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// The index rebuilt from the archive (index file removed) refuses a
/// damaged archive instead of indexing what it could read.
#[test]
fn the_index_rebuild_refuses_a_damaged_archive() {
    let d = tmp("rebuild");
    let program = Address::new_from_array([1; 32]);
    {
        let mut f = Findex::open(&d, program, None, 700).unwrap();
        let recs: Vec<TxRecord> = (1..=10).map(record).collect();
        f.archive.append(&recs, json!({"after": 10})).unwrap();
        f.commit().unwrap();
    }
    assert!(segments(&d.join("archive")).len() >= 3);
    let seg = d.join("archive").join("seg-000001.log");
    let mut bytes = std::fs::read(&seg).unwrap();
    let at = bytes.len() * 2 / 3;
    bytes[at] ^= 0xFF;
    std::fs::write(&seg, &bytes).unwrap();
    std::fs::remove_file(d.join("index.sqlite")).unwrap();
    assert!(Findex::open(&d, program, None, 700).is_err());
    let _ = std::fs::remove_dir_all(&d);
}
