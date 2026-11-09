//! Literal Garrison observations only: no keys, signing, RPC or dispatch.
#![cfg(feature = "wide-world-experimental")]
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId, event as e};
use keeper_core::wideindex::{Limits, Scope, WideBatch, WideDiscovery};
use solana_address::Address;

#[test]
fn garrison_observes_only_holding_and_province_without_host_or_authority() {
    let world = WorldId::new([7; 32]).unwrap();
    let province = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let holding = WideHostRef::new(province, 3, 1, 0).unwrap();
    let payload = e::garrison_payload(&e::GarrisonReceipt {
        delta: 123,
        now_ts: 100,
        became_final: false,
        input_digest: [1; 32],
        output_digest: [2; 32],
    })
    .unwrap();
    let links: Vec<_> = e::WideKind::Garrison
        .links()
        .iter()
        .map(|entity| e::WideLink {
            entity: *entity,
            seq: 1,
            head: [3; 32],
        })
        .collect();
    let body = e::encode(
        e::WideKind::Garrison,
        9,
        &holding.to_bytes(),
        &payload,
        &links,
    )
    .unwrap();
    let mut model = WideDiscovery::new(
        Scope {
            program: Address::new_from_array([23; 32]),
            season: Address::new_from_array([24; 32]),
            world,
            source: "literal synthetic Garrison observation".into(),
        },
        Limits::default(),
    );
    let applied = model
        .apply(&WideBatch {
            seq: 1,
            slot: 100,
            signature: "literal".into(),
            bodies: vec![body],
        })
        .unwrap();
    assert_eq!(applied.records, 1);
    assert!(applied.hosts.is_empty());
    assert_eq!(model.provinces[&province].records.get(&17), Some(&1));
    assert_eq!(model.holdings[&holding].last_seq, 1);
    assert!(model.hosts.is_empty());
    assert!(model.holdings[&holding].hosts.is_empty());
    assert!(model.open_transits(holding).seen.is_empty());
    let coverage = model.coverage();
    assert!(!coverage.automatic_writes && !coverage.source_complete);
}
