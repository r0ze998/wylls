//! Pure wire + disposable SQLite fixtures. No keys, signing or network.
#![cfg(feature = "wide-records-experimental")]
#[path = "../../fclient/tests/fixtures/resident.rs"]
mod fixture;
use findex::wide_index::WideIndex;
use frontier_abi::world_index::{
    event::WideTarget,
    expedition_resident_event::{Action, Record},
    WorldId,
};
#[test]
fn paired_residents_preserve_identity_and_advance_only_real_wide_province_chain() {
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let mut index =
        WideIndex::open_with_resident(std::path::Path::new(":memory:"), p, world, c).unwrap();
    let (a, b) = fixture::pair(Action::Dissolve, fixture::zero());
    let r = Record::decode(&c, &b).unwrap();
    index
        .add(&[fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)])])
        .unwrap();
    index.mark_caught_up(1).unwrap();
    let page = index.events(0, 10).unwrap();
    assert_eq!(page.events.len(), 2);
    for row in page.events {
        assert_eq!(row.province, Some(r.identity.standing.to_bytes().to_vec()));
        assert_eq!(row.host, Some(r.identity.host.to_bytes().to_vec()));
        assert_eq!(row.holding, None);
    }
    assert_eq!(
        index
            .chain(WideTarget::Province(r.identity.standing))
            .unwrap()
            .unwrap()
            .seq,
        1
    );
    let (a, b) = fixture::pair(Action::Return, r.wide_link.unwrap());
    let r = Record::decode(&c, &b).unwrap();
    let mut tx = fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)]);
    tx.seq = 2;
    tx.signature = fclient::ports::Signature::from([2; 64]);
    index.add(&[tx]).unwrap();
    index.mark_caught_up(2).unwrap();
    assert_eq!(
        index
            .chain(WideTarget::Province(r.identity.standing))
            .unwrap()
            .unwrap()
            .seq,
        2
    );
    let (a, b) = fixture::pair(Action::Return, fixture::zero());
    let mut tx = fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)]);
    tx.seq = 3;
    tx.signature = fclient::ports::Signature::from([3; 64]);
    assert!(index.add(&[tx]).is_err());
    assert_eq!(index.status().unwrap().last_seq, 2);
    assert!(index.status().unwrap().blocked.is_some());
}
#[test]
fn normal_resolve_continues_resident_head_and_corruption_blocks_atomically() {
    use frontier_abi::world_index::event as e;
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    for corrupt in [false, true] {
        let mut i =
            WideIndex::open_with_resident(std::path::Path::new(":memory:"), p, world, c).unwrap();
        let (a, mut b) = fixture::pair(Action::Return, fixture::zero());
        let r = Record::decode(&c, &b).unwrap();
        if corrupt {
            let last = b.len() - 1;
            b[last] ^= 1;
            assert!(i
                .add(&[fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)])])
                .is_err());
            assert_eq!(i.status().unwrap().last_seq, 0);
            continue;
        }
        i.add(&[fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)])])
            .unwrap();
        let mut body = vec![0; 256];
        let n = e::write_body(
            e::WideKind::Resolve,
            11,
            &r.identity.standing.to_bytes(),
            &[0; 71],
            &mut body,
        )
        .unwrap();
        body.truncate(n);
        let prior = r.wide_link.unwrap();
        let link = e::advance(e::WideEntity::Province, prior.seq, &prior.head, &body).unwrap();
        let body = e::encode(
            e::WideKind::Resolve,
            11,
            &r.identity.standing.to_bytes(),
            &[0; 71],
            &[link],
        )
        .unwrap();
        let mut tx = fixture::tx(&[(b"PSW1", &body)]);
        tx.seq = 2;
        tx.signature = fclient::ports::Signature::from([2; 64]);
        i.add(&[tx]).unwrap();
        i.mark_caught_up(2).unwrap();
        assert_eq!(
            i.chain(WideTarget::Province(r.identity.standing))
                .unwrap()
                .unwrap()
                .head,
            link.head
        );
    }
}
#[test]
fn cache_scope_and_old_schema_are_never_silently_reopened() {
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let path = std::env::temp_dir().join(format!(
        "resident-schema-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    drop(WideIndex::open_with_resident(&path, p, world, c).unwrap());
    assert!(WideIndex::open(&path, p, world).is_err());
    drop(WideIndex::open_with_resident(&path, p, world, c).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE wide_meta SET schema=2", []).unwrap();
    drop(conn);
    assert!(WideIndex::open_with_resident(&path, p, world, c).is_err());
    assert!(findex::wide_index::WideReader::open(&path, p, world).is_err());
}
