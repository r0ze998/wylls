// WRITTEN ONLY (2026-11-17). No test, build, import or syntax command has been run.
// read_store_observations over a hand-made findex store directory (index.sqlite with the columns the reader's query
// joins, archive/manifest.json as findex writes it). Synthetic records, not chain evidence.
use std::fs;
use std::path::{Path, PathBuf};

use frontier_abi::v2::log::{self, AnyKind, CqKind};
use runexec::observation::{read_observations, read_store_observations};

fn body(kind: CqKind) -> Vec<u8> {
    let k = AnyKind::Cq(kind);
    let mut b = vec![frontier_abi::log::VERSION, k.code()];
    b.extend_from_slice(&9u32.to_le_bytes());
    b.extend_from_slice(&7u64.to_le_bytes());
    b.extend_from_slice(&3u32.to_le_bytes());
    b.resize(6 + k.key_len() + k.payload_len(), 0);
    b.push(0);
    b
}
fn put(b: &mut [u8], k: CqKind, name: &str, bytes: &[u8]) {
    let kind = AnyKind::Cq(k);
    let (off, len) = log::field(kind, name, true).expect("ABI field");
    assert_eq!(len, bytes.len());
    let start = 6 + kind.key_len() + off;
    b[start..start + len].copy_from_slice(bytes);
}
fn settled() -> Vec<u8> {
    let k = CqKind::CARAVAN_SETTLED;
    let mut b = body(k);
    put(&mut b, k, "dst", &[2, 3, 0, 0, 0, 4, 1, 4]);
    b
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("runexec-store-{name}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("archive")).unwrap();
    d
}
/// An index with `rows` settled records at seq 1..=rows (one per transaction).
fn index(dir: &Path, rows: u64) {
    let db = rusqlite::Connection::open(dir.join("index.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
        INSERT INTO meta VALUES('schema',2),('strict_ps2_v2_reject_psw1',1),('strict_ps2_blocked',0);
        CREATE TABLE tx(seq INTEGER PRIMARY KEY, slot INTEGER NOT NULL, sig TEXT NOT NULL, err TEXT);
        CREATE TABLE record(seq INTEGER NOT NULL, idx INTEGER NOT NULL, kind INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(seq, idx));
        CREATE TABLE event(ev INTEGER PRIMARY KEY, seq INTEGER NOT NULL, idx INTEGER NOT NULL);").unwrap();
    for s in 1..=rows {
        db.execute("INSERT INTO tx VALUES(?1, ?2, ?3, NULL)", rusqlite::params![s as i64, (100 + s) as i64, format!("sig{s}")]).unwrap();
        db.execute("INSERT INTO record VALUES(?1, 0, 92, ?2)", rusqlite::params![s as i64, settled()]).unwrap();
        db.execute("INSERT INTO event VALUES(?1, ?1, 0)", rusqlite::params![s as i64]).unwrap();
    }
}
fn manifest(dir: &Path, next_seq: u64, observed: Option<serde_json::Value>) {
    let mut m = serde_json::json!({"version": 1, "segment_bytes": 1, "next_seq": next_seq, "cursor": null, "segments": []});
    if let Some(o) = observed { m["observed"] = o; }
    fs::write(dir.join("archive/manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
}
const RPC: &str = r#"{"from_seq": 1, "source": "rpc_poll", "program_configured": "P", "commitment_requested": "finalized", "genesis_hash": null, "endpoint": null}"#;

#[test]
fn every_hold_is_kept_and_each_row_gets_its_epoch_or_why_not() {
    let d = tmp("epochs");
    index(&d, 3);
    manifest(&d, 3, Some(serde_json::json!([serde_json::from_str::<serde_json::Value>(RPC).unwrap()])));
    let page = read_store_observations(&d, 0, 10).unwrap();
    let v = serde_json::to_value(&page).unwrap();
    assert_eq!(v["format"], "ws04-observation/0");
    assert_eq!(v["basis"], "unproven");
    assert!(v["world"].is_null() && v["finality"].is_null() && v["complete"].is_null());
    for h in ["not_executor_receipts", "source_provenance_unproven", "resume_cursor_not_admitted",
              "store_pairing_is_not_a_snapshot_or_proof", "archive_epoch_is_producer_setting_not_evidence"] {
        assert!(v["held"].as_array().unwrap().iter().any(|x| *x == h), "{h}");
    }
    let obs = v["observations"].as_array().unwrap();
    assert_eq!(obs.len(), 3);
    for o in obs {
        assert_eq!(o["held"].as_array().unwrap().len(), 4, "the four per-row holds, unchanged");
    }
    assert_eq!(obs[0]["archive_epoch"]["why"], "covered_by_epoch");
    assert_eq!(obs[0]["archive_epoch"]["epoch"]["source"], "rpc_poll");
    assert_eq!(obs[0]["archive_epoch"]["epoch"]["commitment_requested"], "finalized");
    assert!(obs[0]["archive_epoch"]["epoch"].get("endpoint").is_none(), "no endpoint is carried");
    // the index holds seq 3, the manifest only up to 2: the row past it has no epoch
    assert_eq!(obs[2]["archive_epoch"]["why"], "past_manifest_end");
    assert!(obs[2]["archive_epoch"]["epoch"].is_null());
    assert_eq!(v["store"]["generation"], "index_ahead_of_manifest");
    assert_eq!(v["store"]["index_last_seq"], 3);
    assert_eq!(v["store"]["manifest_stable"], true);
    assert_eq!(v["store"]["same_directory"], true);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn no_epochs_means_before_first_epoch_never_a_guess() {
    let d = tmp("none");
    index(&d, 2);
    manifest(&d, 3, None);
    let v = serde_json::to_value(read_store_observations(&d, 0, 10).unwrap()).unwrap();
    assert_eq!(v["store"]["generation"], "index_matches_manifest");
    for o in v["observations"].as_array().unwrap() {
        assert_eq!(o["archive_epoch"]["why"], "before_first_epoch");
        assert!(o["archive_epoch"]["epoch"].is_null());
    }
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_malformed_manifest_or_epoch_list_refuses_the_whole_read() {
    let d = tmp("bad");
    index(&d, 3);
    let e = |from: u64| serde_json::json!({"from_seq": from, "source": "s"});
    for bad in [serde_json::json!([e(2), e(1)]), serde_json::json!([e(1), e(1)]), serde_json::json!([e(0)]), serde_json::json!([e(4)]),
                serde_json::json!("x"), serde_json::json!([{"from_seq": 1}]), serde_json::json!([{"from_seq": 1, "source": "s", "program_configured": 7}])] {
        manifest(&d, 4, Some(bad.clone()));
        assert!(read_store_observations(&d, 0, 10).is_err(), "{bad}");
    }
    fs::write(d.join("archive/manifest.json"), b"{").unwrap();
    assert!(read_store_observations(&d, 0, 10).is_err());
    fs::write(d.join("archive/manifest.json"), br#"{"version": 2, "next_seq": 4}"#).unwrap();
    assert!(read_store_observations(&d, 0, 10).is_err());
    fs::remove_file(d.join("archive/manifest.json")).unwrap();
    assert!(read_store_observations(&d, 0, 10).is_err(), "no manifest: refused, not read as empty");
    let _ = fs::remove_dir_all(&d);
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_refused() {
    let d = tmp("link");
    index(&d, 1);
    manifest(&d, 2, None);
    let other = tmp("link-other");
    index(&other, 1);
    manifest(&other, 2, None);
    fs::remove_file(d.join("archive/manifest.json")).unwrap();
    std::os::unix::fs::symlink(other.join("archive/manifest.json"), d.join("archive/manifest.json")).unwrap();
    assert!(read_store_observations(&d, 0, 10).is_err(), "a manifest of another store");
    let linked_dir = tmp("link-dir");
    fs::remove_dir_all(&linked_dir).unwrap();
    std::os::unix::fs::symlink(&other, &linked_dir).unwrap();
    assert!(read_store_observations(&linked_dir, 0, 10).is_err(), "the store directory itself");
    let _ = fs::remove_dir_all(&d);
    let _ = fs::remove_dir_all(&other);
    let _ = fs::remove_file(&linked_dir);
}

#[test]
fn nothing_is_written_and_the_plain_reader_is_unchanged() {
    let d = tmp("nowrite");
    index(&d, 2);
    manifest(&d, 3, Some(serde_json::json!([serde_json::from_str::<serde_json::Value>(RPC).unwrap()])));
    let stat = |p: &Path| fs::metadata(p).map(|m| (m.len(), m.modified().unwrap())).unwrap();
    let before = (stat(&d.join("index.sqlite")), stat(&d.join("archive/manifest.json")), fs::read(d.join("archive/manifest.json")).unwrap());
    read_store_observations(&d, 0, 10).unwrap();
    assert_eq!(before, (stat(&d.join("index.sqlite")), stat(&d.join("archive/manifest.json")), fs::read(d.join("archive/manifest.json")).unwrap()));
    // the plain reader (a DB path) writes no store or epoch keys: its page is as before for existing consumers
    let v = serde_json::to_value(read_observations(&d.join("index.sqlite"), 0, 10).unwrap()).unwrap();
    assert!(v.get("store").is_none());
    assert!(v["observations"].as_array().unwrap().iter().all(|o| o.get("archive_epoch").is_none()));
    assert_eq!(v["held"].as_array().unwrap().len(), 3);
    let _ = fs::remove_dir_all(&d);
}
