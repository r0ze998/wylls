//! In-memory SQLite and synthetic public receipts only; no runtime or network.
#![cfg(feature = "wide-records-experimental")]
#[path = "../../fclient/tests/fixtures/camp_observation.rs"]
mod fixture;
use findex::wide_index::WideIndex;
use frontier_abi::world_index::event::WideTarget;
fn index() -> WideIndex {
    let c = fixture::ctx();
    WideIndex::open_with_expedition(
        std::path::Path::new(":memory:"),
        fclient::Address::new_from_array(c.program),
        fixture::province().world(),
        c,
    )
    .unwrap()
}
#[test]
fn camp_pair_indexes_exact_bytes_and_advances_only_wide_province_chain() {
    let (a, b, link) = fixture::pair(fixture::zero());
    let mut index = index();
    index
        .add(&[fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &b)])])
        .unwrap();
    index.mark_caught_up(1).unwrap();
    let events = index.events(0, 10).unwrap().events;
    assert_eq!(events.len(), 2);
    for (event, body) in events.iter().zip([&a, &b]) {
        assert_eq!(&event.body, body);
        assert_eq!(
            event.province,
            Some(fixture::province().to_bytes().to_vec())
        );
        assert!(event.host.is_some());
        assert!(event.holding.is_none());
    }
    let head = index
        .chain(WideTarget::Province(fixture::province()))
        .unwrap()
        .unwrap();
    assert_eq!((head.seq, head.head), (link.seq, link.head));
    assert_eq!(index.status().unwrap().capture_verification, "unverified");
}
#[test]
fn camp_chain_corruption_and_orphan_latch_without_partial_index_writes() {
    let (a, b, link) = fixture::pair(fixture::zero());
    for orphan in [false, true] {
        let mut index = index();
        let good = fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &b)]);
        let (next_a, mut next_b, _) = fixture::pair(link);
        let bad = if orphan {
            fixture::tx(2, &[(b"PS2", &next_a)])
        } else {
            *next_b.last_mut().unwrap() ^= 1;
            fixture::tx(2, &[(b"PS2", &next_a), (b"PSW1", &next_b)])
        };
        assert!(index.add(&[good, bad]).is_err());
        assert_eq!(index.status().unwrap().last_seq, 0);
        assert!(index.status().unwrap().blocked.is_some());
        assert!(index.events(0, 10).is_err());
    }
}
