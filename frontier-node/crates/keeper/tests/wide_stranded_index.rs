//! Literal PSW1 Stranded notifications in the read-only discovery model.
//! No keys are generated or derived, no account is read, no chain or
//! signature is verified, and no program or transaction is executed.
#![cfg(feature = "wide-world-experimental")]

use frontier_abi::world_index::event::{self as wev, WideEntity, WideKind, WideLink, encode};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use keeper_core::wideduty::{return_candidates, settle_candidates};
use keeper_core::wideindex::{Limits, Presence, Scope, WideBatch, WideDiscovery};
use solana_address::Address;

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}
fn province() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(129, 0).unwrap())
}
fn host() -> WideHostRef {
    WideHostRef::new(province(), 3, 1, 7).unwrap()
}
fn model() -> WideDiscovery {
    WideDiscovery::new(
        Scope {
            program: Address::new_from_array([23; 32]),
            season: Address::new_from_array([24; 32]),
            world: world(),
            source: "test: literal stranded notifications, no account evidence".into(),
        },
        Limits::default(),
    )
}
fn record(kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(
        kind,
        bell,
        key,
        payload,
        &[WideLink {
            entity: WideEntity::Province,
            seq: 1,
            head: [0x31; 32],
        }],
    )
    .unwrap()
}
fn stranded(bell: u32) -> Vec<u8> {
    record(
        WideKind::Stranded,
        bell,
        &wev::host_key(&host(), province()),
        &wev::stranded_payload(300_000, 2),
    )
}
fn batch(seq: u64, body: Vec<u8>) -> WideBatch {
    WideBatch {
        seq,
        slot: 1_000 + seq,
        signature: format!("literal-notification-{seq}"),
        bodies: vec![body],
    }
}
fn expected(bell: u32) -> Presence {
    Presence::Stranded {
        observed_bell: bell,
        troops_lost_milli: 300_000,
        entry: 2,
        removal_unverified: true,
    }
}

#[test]
fn notification_cannot_distinguish_pending_forfeit_from_immediate_removal() {
    // Both operations use the same kind and payload. These literal bytes
    // deliberately contain no origin hint: neither interpretation can be
    // established by replay, even when the receipt is format-correct.
    let pending_notification = stranded(100);
    let immediate_notification = stranded(100);
    assert_eq!(pending_notification, immediate_notification);
    for notification in [pending_notification, immediate_notification] {
        let mut d = model();
        d.apply(&batch(10, notification)).unwrap();
        assert_eq!(d.hosts[&host()].presence, expected(100));
        assert_eq!(d.hosts[&host()].standing, province());
        assert_eq!(
            d.hosts.len(),
            1,
            "notification retains the host observation"
        );
        assert!(return_candidates(&d).is_empty());
        assert!(settle_candidates(&d).is_empty());
        let coverage = d.coverage();
        assert!(!coverage.automatic_writes && !coverage.source_complete);
    }
}

#[test]
fn resolve_and_duplicate_replay_do_not_verify_host_removal() {
    let mut d = model();
    let notification = batch(10, stranded(100));
    assert!(!d.apply(&notification).unwrap().replay);
    assert!(d.apply(&notification).unwrap().replay);
    assert_eq!(d.coverage().records, 1);
    assert_eq!(d.hosts[&host()].presence, expected(100));
    let resolve = record(
        WideKind::Resolve,
        100,
        &province().to_bytes(),
        &wev::resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true),
    );
    d.apply(&batch(11, resolve)).unwrap();
    assert!(d.provinces[&province()].resolved_bells.contains(&100));
    assert_eq!(d.hosts.len(), 1);
    assert_eq!(d.hosts[&host()].presence, expected(100));
    assert!(return_candidates(&d).is_empty());
    assert!(settle_candidates(&d).is_empty());
    assert_eq!(d.coverage().records, 2);
    assert!(!d.coverage().automatic_writes);
}
