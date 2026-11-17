// WRITTEN ONLY (2026-11-17). No test, build, import or syntax command has been run.
// The page contract between ④'s producer and ⑫'s held report: `read_store_observations` over a synthetic findex
// store directory must print EXACTLY the page in tests/fixtures/observe-page-contract.json, which 12's test
// (workstreams/12-memory/test/ws04-page-contract.test.mjs) reads as runexec's output. One file, both sides.
// Synthetic records only: not chain evidence. The fixture's body hashes were computed from the PS2 layout by hand
// (frontier_abi::v2::log: version, kind, bell u32, key, payload, 0 links); this test is what checks them.
use std::fs;
use std::path::{Path, PathBuf};

use frontier_abi::v2::log::{self, AnyKind, CqKind};
use runexec::observation::read_store_observations;

const FIXTURE: &str = include_str!("fixtures/observe-page-contract.json");

/// A PS2 body of `kind` with bell 9, the given key fields, and a zero payload with `fields` written by name.
fn body(kind: CqKind, owner: u64, seq: u32, fields: &[(&str, &[u8])]) -> Vec<u8> {
    let k = AnyKind::Cq(kind);
    let mut b = vec![frontier_abi::log::VERSION, k.code()];
    b.extend_from_slice(&9u32.to_le_bytes());
    b.resize(6 + k.key_len() + k.payload_len(), 0);
    for (name, bytes) in [("owner_tag", &owner.to_le_bytes()[..]), ("seq", &seq.to_le_bytes()[..])] {
        let (off, len) = log::field(k, name, false).expect("ABI key field");
        assert_eq!(len, bytes.len(), "{name}");
        b[6 + off..6 + off + len].copy_from_slice(bytes);
    }
    for (name, bytes) in fields {
        let (off, len) = log::field(k, name, true).expect("ABI payload field");
        assert_eq!(len, bytes.len(), "{name}");
        let start = 6 + k.key_len() + off;
        b[start..start + len].copy_from_slice(bytes);
    }
    b.push(0); // no links
    b
}
fn units(v: [u32; 8]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("runexec-page-contract-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("archive")).unwrap();
    d
}
fn store(dir: &Path, settled: &[u8], raided: &[u8]) {
    let db = rusqlite::Connection::open(dir.join("index.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
        INSERT INTO meta VALUES('schema',2),('strict_ps2_v2_reject_psw1',1),('strict_ps2_blocked',0);
        CREATE TABLE tx(seq INTEGER PRIMARY KEY, slot INTEGER NOT NULL, sig TEXT NOT NULL, err TEXT);
        CREATE TABLE record(seq INTEGER NOT NULL, idx INTEGER NOT NULL, kind INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(seq, idx));
        CREATE TABLE event(ev INTEGER PRIMARY KEY, seq INTEGER NOT NULL, idx INTEGER NOT NULL);").unwrap();
    for (s, kind, b) in [(1i64, 92i64, settled), (2, 93, raided)] {
        db.execute("INSERT INTO tx VALUES(?1, ?2, ?3, NULL)", rusqlite::params![s, 100 + s, format!("sig{s}")]).unwrap();
        db.execute("INSERT INTO record VALUES(?1, 0, ?2, ?3)", rusqlite::params![s, kind, b]).unwrap();
        db.execute("INSERT INTO event VALUES(?1, ?1, 0)", rusqlite::params![s]).unwrap();
    }
    let m = serde_json::json!({"version": 1, "segment_bytes": 1, "next_seq": 3, "cursor": null, "segments": [],
        "observed": [{"from_seq": 1, "source": "rpc_poll", "program_configured": "P", "commitment_requested": "finalized",
                      "genesis_hash": null, "endpoint": null}]});
    fs::write(dir.join("archive/manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
}

#[test]
fn the_store_page_is_exactly_the_shared_fixture() {
    let settled = body(CqKind::CARAVAN_SETTLED, u64::MAX, 3,
        &[("outcome", &[log::caravan_outcome::DELIVERED][..]), ("dst", &[2u8, 3, 0, 0, 0, 4, 1, 4][..]), ("cargo", &units([0, 3, 0, 0, 0, 0, 0, 0])[..])]);
    let raider: u64 = (1 << 63) + 5; // past 2^53: a consumer must keep it exact
    let raided = body(CqKind::CARAVAN_RAIDED, 119, 1,
        &[("choice", &[log::raid_choice::TAKE][..]), ("by", &[log::raid_choice::BY_RAIDER][..]), ("raider_tag", &raider.to_le_bytes()[..]),
          ("taken", &units([0, 1, 0, 0, 0, 0, 0, 0])[..])]);
    assert_eq!((settled.len(), raided.len()), (68, 99), "the PS2 lengths the fixture's hashes were computed for");
    let d = tmp();
    store(&d, &settled, &raided);
    let page = read_store_observations(&d, 0, 10).unwrap();
    let printed = serde_json::to_value(&page).unwrap();
    let expected: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    // field by field first, so a difference names its place; then the whole page
    for (i, (p, e)) in printed["observations"].as_array().unwrap().iter()
        .zip(expected["observations"].as_array().unwrap()).enumerate() {
        for k in ["event_cursor", "archive_sequence", "ps2_ordinal", "signature", "transaction_slot", "body_sha256",
                  "local_locator", "event", "held", "archive_epoch"] {
            assert_eq!(p[k], e[k], "observation {i}: {k}");
        }
    }
    assert_eq!(printed["store"], expected["store"], "store");
    assert_eq!(printed, expected, "the whole page");
    // what 12 relies on, said once more in this crate's own terms
    assert_eq!(printed["observations"][0]["event"]["value"]["key"]["owner"].as_u64(), Some(u64::MAX));
    assert_eq!(printed["observations"][1]["event"]["value"]["raider"].as_u64(), Some(raider));
    assert!(printed["world"].is_null() && printed["finality"].is_null() && printed["complete"].is_null());
    assert_eq!(printed["basis"], "unproven");
    // and the line runexec prints is this value, compact, on one line (main.rs `println!("{v}")`)
    let line = serde_json::to_string(&page).unwrap();
    assert!(!line.contains('\n'));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), expected);
    let _ = fs::remove_dir_all(&d);
}
