//! Immutable log observations and in-memory SQLite only.
#![cfg(feature = "wide-records-experimental")]
#[path = "../../fclient/tests/fixtures/original_boundary.rs"]
mod fixture;
use findex::wide_index::WideIndex;
use frontier_abi::world_index::{event::WideTarget, WorldId};
#[test]
fn native_trace_indexes_without_fabricating_original_holding_chains() {
    let (c, txs) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let mut index =
        WideIndex::open_with_expedition(std::path::Path::new(":memory:"), p, world, c).unwrap();
    index.add(&txs).unwrap();
    index.mark_caught_up(txs.len() as u64).unwrap();
    let rows = index.events(0, 256).unwrap().events;
    assert_eq!(rows.len(), 56);
    let mut original = 0;
    for row in rows {
        if (row.format == "PS2" && (145..=149).contains(&row.body[1]))
            || (row.format == "PSW1" && [25, 26].contains(&row.body[1]))
        {
            assert!(row.holding.is_none());
            assert!(row.province.is_some());
            original += 1;
        }
        if row.format == "PSW1" && row.body[1] == 25 {
            let r = frontier_abi::world_index::expedition_settlement_event::Record::decode(
                &c, &row.body,
            )
            .unwrap();
            assert!(
                index
                    .chain(WideTarget::Province(r.identity.destination))
                    .unwrap()
                    .unwrap()
                    .seq
                    >= r.wide_link.unwrap().seq
            );
        }
    }
    assert!(original >= 12);
}
#[test]
fn malformed_pair_latches_and_rolls_back_entire_batch() {
    let (c, mut txs) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let mut index =
        WideIndex::open_with_expedition(std::path::Path::new(":memory:"), p, world, c).unwrap();
    txs[7].logs.remove(1);
    assert!(index.add(&txs).is_err());
    assert_eq!(index.status().unwrap().last_seq, 0);
    assert!(index.status().unwrap().blocked.is_some());
    assert!(index.events(0, 10).is_err());
}
#[test]
fn expedition_cache_mode_is_pinned_separately() {
    let (c, _) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let path = std::env::temp_dir().join(format!(
        "expedition-mode-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    drop(WideIndex::open_with_expedition(&path, p, world, c).unwrap());
    assert!(WideIndex::open_with_resident(&path, p, world, c).is_err());
    assert!(WideIndex::open(&path, p, world).is_err());
    assert!(WideIndex::open_with_expedition(&path, p, world, c).is_ok());
}

#[path = "../../fclient/tests/fixtures/conquest_observation.rs"]
mod conquest_fixture;
#[test]
fn lone_lapse_and_capture_index_but_source_and_declaration_orphans_block() {
    use frontier_abi::world_index::event::{conquest as c, WideKind as K};
    let ctx = conquest_fixture::ctx();
    let p = fclient::Address::new_from_array(ctx.program);
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
    for (kind, action, accepted) in [
        (K::ConquestSettled, c::LAPSE, true),
        (K::ConquestCaptured, c::CAPTURE, true),
        (K::ConquestCredited, c::LAPSE, false),
        (K::ConquestCredited, c::CAPTURE, false),
        (K::ConquestDeclared, c::DECLARE, false),
        (K::ConquestDebited, c::DECLARE, false),
    ] {
        let mut index =
            WideIndex::open_with_expedition(std::path::Path::new(":memory:"), p, world, ctx)
                .unwrap();
        let body = conquest_fixture::body(kind, action, 7);
        let tx = conquest_fixture::tx(&[(b"PSW1", &body)]);
        assert_eq!(index.add(&[tx]).is_ok(), accepted, "{kind:?}");
        if accepted {
            index.mark_caught_up(1).unwrap();
            let page = index.events(0, 10).unwrap();
            assert_eq!(page.events.len(), 1);
            assert_eq!(page.events[0].body, body);
            assert_eq!(index.status().unwrap().capture_verification, "unverified");
        } else {
            assert_eq!(index.status().unwrap().last_seq, 0);
            assert!(index.status().unwrap().blocked.is_some());
        }
    }
}
