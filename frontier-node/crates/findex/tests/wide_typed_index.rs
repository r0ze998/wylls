//! Dedicated fixed-byte index tests. No signing/keypair generation, network,
//! program execution or live-world claim. SHA chain computation is public.
#![cfg(feature = "wide-records-experimental")]

use base64::Engine;
use fclient::{
    ports::{PortResult, Signature, TxRecord},
    Address,
};
use findex::{wide_index::WideIndex, wide_store::WideFindex, Source};
use frontier_abi::world_index::{event as e, ProvinceKey, WideCoord, WideHostRef, WorldId};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn world() -> WorldId {
    WorldId::new([7; 32]).unwrap()
}
fn key(p: i64) -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(p, 0).unwrap())
}
fn host() -> WideHostRef {
    WideHostRef::new(key(129), 2, 3, 17).unwrap()
}
fn tmp() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "wide-index-{}-{serial}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
fn index(path: &Path) -> WideIndex {
    WideIndex::open(path, program(), world()).unwrap()
}
fn line(tag: &[u8], body: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b.encode(tag), b.encode(body))
}
fn tx(seq: u64, lines: Vec<String>) -> TxRecord {
    let mut sig = [0; 64];
    sig[..8].copy_from_slice(&seq.to_le_bytes());
    TxRecord {
        seq,
        slot: 100 + seq,
        signature: Signature::from(sig),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(&program(), lines),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
#[derive(Default)]
struct Chains(BTreeMap<(u8, Vec<u8>), (u64, [u8; 32])>);
impl Chains {
    fn record(&mut self, kind: e::WideKind, keybytes: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut b = vec![0; 1024];
        let n = e::write_body(kind, 9, keybytes, payload, &mut b).unwrap();
        b.truncate(n);
        // Format decode of a zero-link-shaped temporary provides canonical attribution.
        let fake: Vec<_> = kind
            .links()
            .iter()
            .map(|entity| e::WideLink {
                entity: *entity,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        let shape = e::encode(kind, 9, keybytes, payload, &fake).unwrap();
        let r = e::WideRecord::decode(&shape).unwrap();
        let links: Vec<_> = kind
            .links()
            .iter()
            .map(|entity| {
                let identity = match entity {
                    e::WideEntity::Province => r.province_of().unwrap().to_bytes().to_vec(),
                    e::WideEntity::Holding => r.holding_of().unwrap().to_bytes().to_vec(),
                };
                let old = self
                    .0
                    .entry((*entity as u8, identity))
                    .or_insert((0, [0; 32]));
                let next = e::advance(*entity, old.0, &old.1, &b).unwrap();
                *old = (next.seq, next.head);
                next
            })
            .collect();
        e::encode(kind, 9, keybytes, payload, &links).unwrap()
    }
    fn muster(&mut self, standing: ProvinceKey) -> Vec<u8> {
        self.record(
            e::WideKind::Muster,
            &e::host_key(&host(), standing),
            &e::muster_payload(0, 300, 17, 0, 1),
        )
    }
}
/// A canonical economy receipt payload (the holding-keyed kinds refuse a
/// zero payload at the codec): a Harvest under `Economy`, a walls Build
/// under `EconomyMirror`. Literal digests: nothing here verifies them.
fn economy_payload(kind: e::WideKind) -> Vec<u8> {
    let action = if kind == e::WideKind::EconomyMirror {
        frontier_abi::world_index::EconomyAction::Build { item: 6 }
    } else {
        frontier_abi::world_index::EconomyAction::Harvest
    };
    e::economy_payload(&frontier_abi::world_index::EconomyReceipt {
        action,
        now_ts: 1_700_060_000,
        became_final: false,
        input_digest: [0x1A; 32],
        output_digest: [0x0B; 32],
    })
    .unwrap()
    .to_vec()
}
fn ps2() -> Vec<u8> {
    let mut b = vec![0; 512];
    let k = frontier_abi::log::Kind::ANCHOR;
    let n = frontier_abi::log::write_body(k, 3, &[0; 5], &[0; 56], &mut b).unwrap();
    let n = frontier_abi::log::write_tail(&[], &mut b, n).unwrap();
    b.truncate(n);
    b
}
fn raw_count(path: &Path, table: &str) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn mixed_records_preserve_full_id_and_chains_without_legacy_tables_or_verification() {
    let path = tmp();
    let mut i = index(&path);
    let standing = key(9_007_199_254_740_993);
    let mut c = Chains::default();
    let body = c.muster(standing);
    i.add(&[tx(1, vec![line(b"PS2", &ps2()), line(b"PSW1", &body)])])
        .unwrap();
    assert!(i.events(0, 10).is_err());
    i.mark_caught_up(1).unwrap();
    let status = i.status().unwrap();
    assert_eq!(status.source_coverage, "unknown");
    assert_eq!(status.capture_verification, "unverified");
    let p = i.events(0, 1).unwrap();
    assert!(p.more);
    assert_eq!(p.events[0].format, "PS2");
    assert!(p.events[0].province.is_none());
    let p = i.events(p.next, 1).unwrap();
    assert!(!p.more);
    assert_eq!(p.events[0].format, "PSW1");
    assert_eq!(p.events[0].province, Some(standing.to_bytes().to_vec()));
    assert_eq!(
        p.events[0].holding,
        Some(host().holding_ref().to_bytes().to_vec())
    );
    assert_eq!(p.events[0].host, Some(host().to_bytes().to_vec()));
    assert_eq!(p.events[0].body, body);
    assert_eq!(
        i.chain(e::WideTarget::Province(standing))
            .unwrap()
            .unwrap()
            .seq,
        1
    );
    assert!(i
        .chain(e::WideTarget::Province(key(129)))
        .unwrap()
        .is_none());
    assert_eq!(
        i.chain(e::WideTarget::Holding(host()))
            .unwrap()
            .unwrap()
            .seq,
        1
    );
    let conn = rusqlite::Connection::open(&path).unwrap();
    let legacy:i64=conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('record','event','entity','account','link')",[],|r|r.get(0)).unwrap();
    assert_eq!(legacy, 0);
    drop(conn);
    drop(i);
    let i = index(&path);
    assert_eq!(i.events(0, 256).unwrap().events.len(), 2);
    assert!(WideIndex::open(&path, program(), WorldId::new([8; 32]).unwrap()).is_err());
    drop(i);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn every_kind_has_a_separate_wide_record_and_canonical_attribution() {
    let path = tmp();
    let mut i = index(&path);
    let p = key(9_007_199_254_740_993);
    let mut c = Chains::default();
    // Zero payloads test codec widths, not gameplay semantics or valid
    // outcomes; the holding-keyed economy kinds need a canonical receipt.
    // `ProvinceClosed` is the terminal record of a province chain, so it
    // is generated last whatever `ALL_KINDS`' code order says (the
    // terminal rule is not weakened for the enumeration).
    let mut kinds: Vec<e::WideKind> = e::ALL_KINDS
        .iter()
        .copied()
        .filter(|k| *k != e::WideKind::ProvinceClosed)
        .collect();
    kinds.push(e::WideKind::ProvinceClosed);
    assert_eq!(kinds.len(), 16);
    let mut lines = Vec::new();
    for kind in kinds {
        let kb = if kind.host_keyed() {
            e::host_key(&host(), p).to_vec()
        } else if kind.holding_keyed() {
            host().holding_ref().to_bytes().to_vec()
        } else {
            p.to_bytes().to_vec()
        };
        let payload = if kind.holding_keyed() {
            economy_payload(kind)
        } else {
            let mut payload = vec![0; kind.payload_len()];
            if kind == e::WideKind::TransitSettled {
                payload[e::TRANSIT_SETTLED_DEST_AT..].copy_from_slice(&p.to_bytes());
            }
            payload
        };
        lines.push(line(b"PSW1", &c.record(kind, &kb, &payload)));
    }
    i.add(&[tx(1, lines)]).unwrap();
    i.mark_caught_up(1).unwrap();
    let page = i.events(0, 256).unwrap();
    assert_eq!(page.events.len(), 16);
    assert!(
        i.chain(e::WideTarget::Province(p))
            .unwrap()
            .unwrap()
            .terminal
    );
    // The economy receipts are attributed to the holding's own province
    // (`host().key()`, not the standing `p`), name the holding and no host;
    // the mirror receipt alone chains that province.
    let own = host().key();
    let economy: Vec<_> = page
        .events
        .iter()
        .filter(|ev| {
            ev.body[1] == e::WideKind::Economy as u8
                || ev.body[1] == e::WideKind::EconomyMirror as u8
        })
        .collect();
    assert_eq!(economy.len(), 2);
    for ev in &economy {
        assert_eq!(ev.province, Some(own.to_bytes().to_vec()));
        assert_eq!(ev.holding, Some(host().holding_ref().to_bytes().to_vec()));
        assert!(ev.host.is_none(), "no phantom host from a holding key");
    }
    assert_eq!(
        i.chain(e::WideTarget::Province(own)).unwrap().unwrap().seq,
        1
    );
    // Muster, Dissolve, Return, Departed, TransitSettled, DepartureSettled,
    // Economy, EconomyMirror chain the holding: eight.
    assert_eq!(
        i.chain(e::WideTarget::Holding(host()))
            .unwrap()
            .unwrap()
            .seq,
        8
    );
    drop(i);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn bad_head_rolls_back_the_whole_batch_and_durable_block_refuses_later_reads() {
    let path = tmp();
    let mut i = index(&path);
    let mut c = Chains::default();
    let first = c.muster(key(900));
    let mut second = c.muster(key(900));
    *second.last_mut().unwrap() ^= 1;
    assert!(i
        .add(&[
            tx(1, vec![line(b"PSW1", &first)]),
            tx(2, vec![line(b"PSW1", &second)])
        ])
        .is_err());
    assert_eq!(i.status().unwrap().last_seq, 0);
    assert!(i.status().unwrap().blocked.is_some());
    assert_eq!(raw_count(&path, "wide_event"), 0);
    assert_eq!(raw_count(&path, "wide_chain"), 0);
    assert!(i.mark_caught_up(0).is_err());
    assert!(i.events(0, 1).is_err());
    drop(i);
    let mut i = index(&path);
    assert!(i.add(&[tx(1, vec![line(b"PSW1", &first)])]).is_err());
    drop(i);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn missing_chain_prefix_wrong_world_and_terminal_continuation_are_not_accepted() {
    for mode in 0..3 {
        let path = tmp();
        let mut i = index(&path);
        let mut c = Chains::default();
        let p = key(900);
        let first = c.muster(p);
        let bad = match mode {
            0 => c.muster(p), // missing first chain record
            1 => {
                let other = ProvinceKey::new(
                    WorldId::new([8; 32]).unwrap(),
                    WideCoord::checked(900, 0).unwrap(),
                );
                c.record(
                    e::WideKind::RecordClosed,
                    &other.to_bytes(),
                    &e::record_closed_payload(2, 0, 0, 0, &[0; 32], 0),
                )
            }
            _ => {
                i.add(&[tx(1, vec![line(b"PSW1", &first)])]).unwrap();
                let close = c.record(
                    e::WideKind::ProvinceClosed,
                    &p.to_bytes(),
                    &e::province_closed_payload(&[0; 32], 0),
                );
                i.add(&[tx(2, vec![line(b"PSW1", &close)])]).unwrap();
                c.muster(p)
            }
        };
        let seq = if mode == 2 { 3 } else { 1 };
        assert!(i.add(&[tx(seq, vec![line(b"PSW1", &bad)])]).is_err());
        assert!(i.status().unwrap().blocked.is_some());
        drop(i);
        std::fs::remove_file(path).unwrap();
    }
}
#[test]
fn archive_gap_replay_signature_duplicate_and_slot_regression_stop_before_advance() {
    for mode in 0..4 {
        let path = tmp();
        let mut i = index(&path);
        let first = tx(1, vec![]);
        i.add(std::slice::from_ref(&first)).unwrap();
        let mut bad = tx(2, vec![]);
        match mode {
            0 => bad.seq = 3,
            1 => bad.seq = 1,
            2 => bad.signature = first.signature,
            3 => bad.slot = 99,
            _ => unreachable!(),
        };
        assert!(i.add(&[bad]).is_err());
        assert_eq!(i.status().unwrap().last_seq, 1);
        assert_eq!(raw_count(&path, "wide_tx"), 1);
        drop(i);
        std::fs::remove_file(path).unwrap();
    }
}
#[test]
fn rollback_and_unrelated_frames_never_advance_wide_heads() {
    let path = tmp();
    let mut i = index(&path);
    let p = key(900);
    let body = Chains::default().muster(p);
    let mut failed = tx(1, vec![line(b"PSW1", &body)]);
    failed.err = Some("rollback".into());
    let foreign = Address::new_from_array([24; 32]);
    let mut caught = tx(2, vec![]);
    caught.logs = vec![
        format!("Program {foreign} invoke [1]"),
        format!("Program {} invoke [2]", program()),
        line(b"PSW1", &body),
        format!("Program {} failed: caught", program()),
        format!("Program {foreign} success"),
    ];
    i.add(&[failed, caught, tx(3, vec![line(b"PSW1", &body)])])
        .unwrap();
    i.mark_caught_up(3).unwrap();
    assert_eq!(i.events(0, 10).unwrap().events.len(), 1);
    assert_eq!(i.chain(e::WideTarget::Province(p)).unwrap().unwrap().seq, 1);
    drop(i);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn unknown_records_missing_frames_and_partial_catchup_are_never_empty_success() {
    for logs in [
        vec![],
        fclient::log::in_frame(&program(), [line(b"PSW1", &[0x82, 255])]),
        fclient::log::in_frame(&program(), ["Program data:".into()]),
    ] {
        let path = tmp();
        let mut i = index(&path);
        let mut t = tx(1, vec![]);
        t.logs = logs;
        assert!(i.add(&[t]).is_err());
        assert_eq!(i.status().unwrap().last_seq, 0);
        assert!(i.events(0, 1).is_err());
        drop(i);
        std::fs::remove_file(path).unwrap();
    }
    let path = tmp();
    let i = index(&path);
    assert!(i.events(0, 1).is_err());
    assert!(i.mark_caught_up(1).is_err());
    i.mark_caught_up(0).unwrap();
    let p = i.events(0, 1).unwrap();
    assert!(p.events.is_empty());
    assert_eq!(p.source_coverage, "unknown");
    assert!(i.events(0, 0).is_err());
    assert!(i.events(0, 257).is_err());
    drop(i);
    std::fs::remove_file(path).unwrap();
}
struct Rows {
    rows: Vec<TxRecord>,
    after: u64,
    pulls: usize,
}
impl Source for Rows {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        self.pulls += 1;
        let out: Vec<_> = self
            .rows
            .iter()
            .filter(|r| r.seq > self.after)
            .cloned()
            .collect();
        if let Some(r) = out.last() {
            self.after = r.seq;
        }
        Ok(out)
    }
    fn cursor(&self) -> Value {
        json!({"after":self.after})
    }
    fn restore(&mut self, v: &Value) {
        self.after = v["after"].as_u64().unwrap_or(0);
    }
}
#[tokio::test]
async fn dedicated_store_archives_indexes_and_resumes_without_promoting_captures() {
    let dir = tmp();
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let mut rows = Rows {
        rows: vec![tx(
            1,
            vec![line(b"PSW1", &Chains::default().muster(key(900)))],
        )],
        after: 0,
        pulls: 0,
    };
    store.ingest(&mut rows).await.unwrap();
    store.commit().unwrap();
    assert_eq!(store.archive().last_seq(), 1);
    assert_eq!(store.index.events(0, 1).unwrap().events.len(), 1);
    assert_eq!(
        store.index.status().unwrap().capture_verification,
        "unverified"
    );
    drop(store);
    let store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    rows.after = 0;
    store.resume(&mut rows);
    assert_eq!(rows.after, 1);
    assert_eq!(store.index.events(0, 1).unwrap().events.len(), 1);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn unsupported_store_retains_raw_archive_and_stops_pulls_and_reopening() {
    let dir = tmp();
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let mut rows = Rows {
        rows: vec![tx(1, vec![line(b"PSW1", &[0x82, 255])])],
        after: 0,
        pulls: 0,
    };
    assert!(store.ingest(&mut rows).await.is_err());
    assert!(store.is_poisoned());
    assert_eq!(store.archive().read_after(0).unwrap().len(), 1);
    assert_eq!(store.index.status().unwrap().last_seq, 0);
    assert!(store.index.events(0, 1).is_err());
    assert!(store.ingest(&mut rows).await.is_err());
    assert_eq!(rows.pulls, 1);
    drop(store);
    assert!(WideFindex::open(&dir, program(), world(), 1 << 20).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn durable_archive_tail_is_replayed_on_reopen_and_ahead_index_is_refused() {
    let dir = tmp();
    let mut c = Chains::default();
    let first = tx(1, vec![line(b"PSW1", &c.muster(key(900)))]);
    let second = tx(2, vec![line(b"PSW1", &c.muster(key(900)))]);
    // Simulate the archive/index crash window using the real archive codec.
    let store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    drop(store);
    let mut archive = findex::Archive::open(&dir.join("archive"), 1 << 20).unwrap();
    archive
        .append(&[first, second], json!({"after":2}))
        .unwrap();
    archive.commit().unwrap();
    drop(archive);
    let store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    assert_eq!(store.index.events(0, 10).unwrap().events.len(), 2);
    assert_eq!(
        store
            .index
            .chain(e::WideTarget::Province(key(900)))
            .unwrap()
            .unwrap()
            .seq,
        2
    );
    drop(store);
    let db = rusqlite::Connection::open(dir.join("wide-index.sqlite")).unwrap();
    db.execute("UPDATE wide_meta SET last_seq=3 WHERE id=1", [])
        .unwrap();
    drop(db);
    assert!(WideFindex::open(&dir, program(), world(), 1 << 20).is_err());
    let i = index(&dir.join("wide-index.sqlite"));
    assert!(!i.status().unwrap().caught_up);
    assert!(i.events(0, 10).is_err());
    drop(i);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn sqlite_write_failure_preserves_raw_data_and_commits_no_partial_index() {
    let dir = tmp();
    let mut store = WideFindex::open(&dir, program(), world(), 1 << 20).unwrap();
    let db = rusqlite::Connection::open(dir.join("wide-index.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_wide_event BEFORE INSERT ON wide_event BEGIN SELECT RAISE(FAIL,'injected test write failure'); END;").unwrap();
    drop(db);
    let mut rows = Rows {
        rows: vec![tx(
            1,
            vec![line(b"PSW1", &Chains::default().muster(key(900)))],
        )],
        after: 0,
        pulls: 0,
    };
    assert!(store.ingest(&mut rows).await.is_err());
    assert!(store.is_poisoned());
    assert_eq!(store.archive().last_seq(), 1);
    assert_eq!(store.index.status().unwrap().last_seq, 0);
    assert!(store.index.status().unwrap().blocked.is_some());
    assert_eq!(raw_count(&dir.join("wide-index.sqlite"), "wide_tx"), 0);
    assert_eq!(raw_count(&dir.join("wide-index.sqlite"), "wide_chain"), 0);
    drop(store);
    assert!(WideFindex::open(&dir, program(), world(), 1 << 20).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn readonly_pages_pin_content_not_just_cursor_and_never_upgrade_old_schema() {
    use findex::wide_index::WideReader;
    let first = tmp();
    let second = tmp();
    let mut old_stamp = [0; 32];
    for (n, path) in [&first, &second].into_iter().enumerate() {
        let mut i = index(path);
        let mut body = ps2();
        body[6] = n as u8;
        i.add(&[tx(1, vec![line(b"PS2", &body)])]).unwrap();
        i.mark_caught_up(1).unwrap();
        if n == 0 {
            old_stamp = i.status().unwrap().snapshot;
        }
    }
    let before = std::fs::read(&second).unwrap();
    let r = WideReader::open(&second, program(), world()).unwrap();
    assert_eq!(r.status().unwrap().last_seq, 1);
    assert_ne!(r.status().unwrap().snapshot, old_stamp);
    assert!(r.events(0, 20, 1, old_stamp).is_err());
    assert_eq!(
        r.events(0, 20, 1, r.status().unwrap().snapshot)
            .unwrap()
            .events
            .len(),
        1
    );
    drop(r);
    assert_eq!(std::fs::read(&second).unwrap(), before);
    let db = rusqlite::Connection::open(&second).unwrap();
    db.execute("UPDATE wide_meta SET schema=1", []).unwrap();
    drop(db);
    let before = std::fs::read(&second).unwrap();
    assert!(WideReader::open(&second, program(), world()).is_err());
    assert_eq!(std::fs::read(&second).unwrap(), before);
    std::fs::remove_file(first).unwrap();
    std::fs::remove_file(second).unwrap();
}
