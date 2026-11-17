//! Literal public identities and canonical receipt bytes only. No signing,
//! transactions, network, PDA derivation, model replay or verification claim.
#![cfg(feature = "wide-world-experimental")]

use frontier_abi::world_index::{event as e, ProvinceKey, WideCoord, WideHostRef, WorldId};
use keeper_core::wideindex::{Limits, Refusal, Scope, WideBatch, WideDiscovery};
use solana_address::Address;

fn batch(seq: u64, bodies: Vec<Vec<u8>>) -> WideBatch {
    WideBatch {
        seq,
        slot: 100 + seq,
        signature: format!("literal-{seq}"),
        bodies,
    }
}

#[test]
fn every_lifecycle_kind_blocks_atomically_and_stays_read_only() {
    use e::conquest as c;
    let world = WorldId::new([7; 32]).unwrap();
    let p = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let holding = WideHostRef::new(p, 2, 3, 0).unwrap();
    let kinds = [
        (e::WideKind::ConquestDeclared, c::DECLARE),
        (e::WideKind::ConquestDebited, c::DECLARE),
        (e::WideKind::ConquestResolved, c::RESOLVE),
        (e::WideKind::ConquestSettled, c::FAILED),
        (e::WideKind::ConquestCaptured, c::CAPTURE),
        (e::WideKind::ConquestCredited, c::LAPSE),
        (e::WideKind::ConquestTableClosed, c::TABLE_CLOSE),
    ];
    let links = |kind: e::WideKind| {
        kind.links()
            .iter()
            .map(|entity| e::WideLink {
                entity: *entity,
                seq: 1,
                head: [9; 32],
            })
            .collect::<Vec<_>>()
    };
    let valid = e::encode(
        e::WideKind::Resolve,
        9,
        &p.to_bytes(),
        &vec![0; e::WideKind::Resolve.payload_len()],
        &links(e::WideKind::Resolve),
    )
    .unwrap();
    for (kind, action) in kinds {
        for seeded in [false, true] {
            let mut model = WideDiscovery::new(
                Scope {
                    program: Address::new_from_array([23; 32]),
                    season: Address::new_from_array([24; 32]),
                    world,
                    source: "literal receipt regression".into(),
                },
                Limits::default(),
            );
            if seeded {
                model.apply(&batch(1, vec![valid.clone()])).unwrap();
            }
            let before = model.clone();
            let key = if kind.holding_keyed() {
                holding.to_bytes().to_vec()
            } else {
                p.to_bytes().to_vec()
            };
            let receipt = c::Receipt::new(action, 0, [1; 32], [2; 32])
                .unwrap()
                .encode();
            let unsupported = e::encode(kind, 9, &key, &receipt, &links(kind)).unwrap();
            assert_eq!(e::WideRecord::decode(&unsupported).unwrap().kind, kind);
            assert_eq!(
                model.apply(&batch(2, vec![valid.clone(), unsupported])),
                Err(Refusal::UnsupportedKind {
                    seq: 2,
                    body: 1,
                    kind
                })
            );
            assert_eq!(model.provinces, before.provinces);
            assert_eq!(model.holdings, before.holdings);
            assert_eq!(model.hosts, before.hosts);
            assert_eq!(model.slots, before.slots);
            assert_eq!(model.days, before.days);
            assert_eq!(model.inputs, before.inputs);
            assert_eq!(model.anomalies, before.anomalies);
            assert_eq!(model.cursor(), before.cursor());
            let mut coverage = model.coverage();
            let blocker = coverage.blocked.take().unwrap();
            assert_eq!((blocker.seq, blocker.body), (2, Some(1)));
            assert!(blocker
                .reason
                .contains("semantic replay and operation pairing required"));
            assert!(blocker
                .reason
                .contains(&format!("{} ({kind:?})", kind as u8)));
            assert_eq!(coverage, before.coverage());
            assert!(!coverage.automatic_writes && !coverage.source_complete);
            let blocked = model.blocked().cloned();
            assert!(matches!(
                model.apply(&batch(3, vec![valid.clone()])),
                Err(Refusal::Blocked { since_seq: 2, .. })
            ));
            assert_eq!(model.blocked(), blocked.as_ref());
            assert_eq!(model.cursor(), before.cursor());
        }
    }
}

#[test]
fn citizen_sidecar_blocks_observer_without_legacy_or_partial_acceptance() {
    use base64::Engine;
    use e::conquest as c;
    use keeper_core::wideindex::{observe_tx, WideObserver};
    let program = Address::new_from_array([23; 32]);
    let body = c::SidecarClose {
        season: [24; 32],
        citizen: [25; 32],
        bell: 9,
        receipt: c::Receipt::new(c::ESCROW_CLOSE, 0, [1; 32], [2; 32]).unwrap(),
    }
    .encode()
    .unwrap();
    let b = base64::engine::general_purpose::STANDARD;
    let tx = fclient::ports::TxRecord {
        seq: 1,
        slot: 101,
        signature: fclient::ports::Signature::from([3; 64]),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(
            &program,
            [format!(
                "Program data: {} {}",
                b.encode(b"PSWC"),
                b.encode(body)
            )],
        ),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    };
    assert!(matches!(
        observe_tx(&tx, &program),
        Err(fclient::typed_log::DecodeError::UnsupportedSidecar)
    ));
    let mut observer = WideObserver::new(
        Scope {
            program,
            season: Address::new_from_array([24; 32]),
            world: WorldId::new([7; 32]).unwrap(),
            source: "literal sidecar".into(),
        },
        Limits::default(),
    );
    assert_eq!(observer.observe_page(&[tx.clone()], &program), 0);
    assert!(observer.model.blocked().is_some());
    assert_eq!(observer.legacy_txs, 0);
    assert_eq!(observer.model.coverage().records, 0);
    assert_eq!(observer.model.cursor(), None);
    assert!(!observer.model.coverage().automatic_writes);
    assert_eq!(observer.observe_page(&[tx], &program), 0);
}
