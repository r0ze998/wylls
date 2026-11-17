//! Exact keyless receipt observer tests; no startup, keys, signing or network.
#![cfg(feature = "wide-world-experimental")]
#[path = "../../fclient/tests/fixtures/camp_observation.rs"]
mod fixture;
use frontier_abi::world_index::event::WideTarget;
use keeper_core::wideindex::{Limits, Scope, WideObserver};
fn observer() -> WideObserver {
    let c = fixture::ctx();
    WideObserver::new_with_expedition(
        Scope {
            program: fclient::Address::new_from_array(c.program),
            season: fclient::Address::new_from_array(c.season),
            world: fixture::province().world(),
            source: "synthetic unauthenticated camp receipt".into(),
        },
        Limits::default(),
    )
    .unwrap()
}
#[test]
fn camp_observer_tracks_v2_chain_without_creating_gameplay_or_duties() {
    let (a, b, link) = fixture::pair(fixture::zero());
    let p = fclient::Address::new_from_array(fixture::ctx().program);
    let mut o = observer();
    assert_eq!(
        o.observe_page(&[fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &b)])], &p),
        1
    );
    assert!(o.model.blocked().is_none());
    assert!(matches!(
        o.expedition_receipt(),
        Some(fclient::typed_log::ExpeditionRecord::CampSettlement(_))
    ));
    assert_eq!(
        o.chain(WideTarget::Province(fixture::province()))
            .unwrap()
            .head,
        link.head
    );
    assert!(o.model.hosts.is_empty());
    assert!(o.model.holdings.is_empty());
    let (a2, mut b2, _) = fixture::pair(link);
    *b2.last_mut().unwrap() ^= 1;
    assert_eq!(
        o.observe_page(&[fixture::tx(2, &[(b"PS2", &a2), (b"PSW1", &b2)])], &p),
        0
    );
    assert!(o.model.blocked().is_some());
    assert_eq!(
        o.chain(WideTarget::Province(fixture::province()))
            .unwrap()
            .head,
        link.head
    );
}
