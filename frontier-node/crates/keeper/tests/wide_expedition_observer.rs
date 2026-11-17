//! Exact offline observer fixtures: public identities and receipt bytes only.
//! No signer, account execution, network or transaction submission.
#![cfg(feature = "wide-world-experimental")]
use base64::Engine;
use frontier_abi::{
    addr::AddrCtx,
    log,
    world_index::{
        event as e, expedition::AccountResolver, expedition_event as source,
        expedition_producer_event as producer, expedition_settlement_event as settlement, march,
        ProvinceKey, WideCoord,
    },
};
use keeper_core::wideindex::{Limits, Scope, WideObserver};
use solana_address::Address;
fn ctx() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn scope() -> Scope {
    let c = ctx();
    Scope {
        program: Address::new_from_array(c.program),
        season: Address::new_from_array(c.season),
        world: AccountResolver::for_season(&c).unwrap().adapter().world(),
        source: "unauthenticated literal fixture".into(),
    }
}
fn province() -> ProvinceKey {
    ProvinceKey::new(scope().world, WideCoord::checked(129, 0).unwrap())
}
fn observer() -> WideObserver {
    WideObserver::new_with_expedition(scope(), Limits::default()).unwrap()
}
fn feed(seq: u64, bodies: &[(&[u8], Vec<u8>)]) -> fclient::ports::TxRecord {
    let b64 = base64::engine::general_purpose::STANDARD;
    fclient::ports::TxRecord {
        seq,
        slot: seq + 100,
        signature: Default::default(),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(
            &scope().program,
            bodies
                .iter()
                .map(|(p, b)| format!("Program data: {} {}", b64.encode(p), b64.encode(b))),
        ),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
fn zero() -> e::WideLink {
    e::WideLink {
        entity: e::WideEntity::Province,
        seq: 0,
        head: [0; 32],
    }
}
fn wide(kind: e::WideKind, prior: e::WideLink, payload: Vec<u8>) -> (Vec<u8>, e::WideLink) {
    let mut b = vec![0; e::MAX_BODY];
    let n = e::write_body(kind, 10, &province().to_bytes(), &payload, &mut b).unwrap();
    b.truncate(n);
    let l = e::advance(prior.entity, prior.seq, &prior.head, &b).unwrap();
    (
        e::encode(kind, 10, &province().to_bytes(), &payload, &[l]).unwrap(),
        l,
    )
}
fn resolve(prior: e::WideLink) -> (Vec<u8>, e::WideLink) {
    wide(
        e::WideKind::Resolve,
        prior,
        e::resolve_payload(&[1; 32], &[2; 32], 11, 0, 0, false).to_vec(),
    )
}
fn gather() -> Vec<u8> {
    producer::Record {
        bell: 10,
        target: producer::Target::Gather {
            destination: province(),
        },
        receipt: producer::Receipt::new(producer::Action::Gather, [1; 32], [2; 32]),
    }
    .encode(&ctx())
    .unwrap()
}
fn settlement_pair(prior: e::WideLink) -> (Vec<u8>, Vec<u8>, e::WideLink) {
    let c = ctx();
    let r = AccountResolver::for_season(&c).unwrap();
    let host = r
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let holding = r.holding_address(&host).unwrap();
    let receipt = settlement::Receipt::new([1; 32], [2; 32]);
    let body = |wide: bool| {
        let mut b = vec![
            if wide {
                e::WIDE_EVENT_VERSION
            } else {
                log::VERSION
            },
            if wide { 25 } else { 148 },
        ];
        b.extend_from_slice(&10u32.to_le_bytes());
        b.extend_from_slice(&[1, 0, 0, 0]);
        b.extend_from_slice(&host.to_bytes());
        for a in [[7; 32], holding, march::transit_address(&c, &holding, 0)] {
            b.extend_from_slice(&a);
        }
        b.extend_from_slice(&province().to_bytes());
        b.extend_from_slice(&r.province_address(province()).unwrap());
        b.extend_from_slice(&[0; frontier_abi::world_index::key::PROVINCE_KEY_LEN]);
        b.extend_from_slice(&[0; 64]);
        for d in [receipt.operation_id, receipt.input, receipt.output] {
            b.extend_from_slice(&d);
        }
        assert_eq!(b.len(), settlement::BODY_LEN);
        b
    };
    let mut a = body(false);
    let l = log::advance(log::EntityKind::Holding, 0, &[0; 32], &a).unwrap();
    a.push(1);
    a.push(l.entity as u8);
    a.extend_from_slice(&l.seq.to_le_bytes());
    a.extend_from_slice(&l.head);
    let mut b = body(true);
    let l = e::advance(prior.entity, prior.seq, &prior.head, &b).unwrap();
    b.push(1);
    b.push(l.entity as u8);
    b.extend_from_slice(&l.seq.to_le_bytes());
    b.extend_from_slice(&l.head);
    settlement::Record::decode(&c, &a)
        .unwrap()
        .pair(&settlement::Record::decode(&c, &b).unwrap())
        .unwrap();
    (a, b, l)
}
#[test]
fn ordered_settlement_mixed_batch_is_atomic_and_no_fake_host() {
    let (first, l1) = resolve(zero());
    let (a, b, l2) = settlement_pair(l1);
    let (last, l3) = resolve(l2);
    let records = vec![
        (b"PSW1".as_slice(), first),
        (b"PS2".as_slice(), a),
        (b"PS2".as_slice(), gather()),
        (b"PSW1".as_slice(), b),
        (b"PSW1".as_slice(), last),
    ];
    let tx = feed(1, &records);
    let mut o = observer();
    assert_eq!(o.observe_page(&[tx.clone()], &scope().program), 1);
    assert!(o.model.blocked().is_none());
    assert_eq!(
        o.chain(e::WideTarget::Province(province())).unwrap().head,
        l3.head
    );
    assert!(o.model.hosts.is_empty());
    assert!(o.model.holdings.is_empty());
    assert_eq!(o.status()["expedition_receipts"]["records"], 3);
    assert_eq!(o.observe_page(&[tx], &scope().program), 0);
    let mut bad = records.clone();
    let n = bad[4].1.len();
    bad[4].1[n - 1] ^= 1;
    let mut o = observer();
    assert_eq!(o.observe_page(&[feed(1, &bad)], &scope().program), 0);
    assert!(o.model.blocked().is_some());
    assert!(o.chain(e::WideTarget::Province(province())).is_none());
    assert!(o.model.provinces.is_empty());
    assert!(o.expedition_receipt().is_none());
    assert_eq!(o.status()["expedition_receipts"]["records"], 0);
}
#[test]
fn producer_zero_link_caps_and_generic_refusal() {
    let tx = feed(1, &[(b"PS2", gather())]);
    let mut o = observer();
    assert_eq!(o.observe_page(&[tx.clone()], &scope().program), 1);
    assert!(o.chain(e::WideTarget::Province(province())).is_none());
    assert!(o.model.inputs.is_empty());
    let mut generic = WideObserver::new(scope(), Limits::default());
    assert_eq!(generic.observe_page(&[tx.clone()], &scope().program), 0);
    assert!(generic.model.blocked().is_some());
    let mut cap = WideObserver::new_with_expedition(
        scope(),
        Limits {
            max_batch_bytes: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(cap.observe_page(&[tx], &scope().program), 0);
    assert!(cap.expedition_receipt().is_none());
}
#[test]
fn lifecycle_and_sidecar_stay_outside_discovery_and_scope_is_checked() {
    let receipt = e::conquest::Receipt::new(e::conquest::RESOLVE, 0, [1; 32], [2; 32]).unwrap();
    let (b, l) = wide(
        e::WideKind::ConquestResolved,
        zero(),
        receipt.encode().to_vec(),
    );
    let side = e::conquest::SidecarClose {
        season: ctx().season,
        citizen: [7; 32],
        bell: 10,
        receipt: e::conquest::Receipt::new(e::conquest::ESCROW_CLOSE, 0, [3; 32], [4; 32]).unwrap(),
    }
    .encode()
    .unwrap()
    .to_vec();
    let mut o = observer();
    assert_eq!(
        o.observe_page(
            &[feed(1, &[(b"PSW1", b.clone()), (b"PSWC", side.clone())])],
            &scope().program
        ),
        1
    );
    assert_eq!(
        o.chain(e::WideTarget::Province(province())).unwrap().head,
        l.head
    );
    assert!(o.model.provinces.is_empty());
    assert_eq!(o.status()["lifecycle_commitments"]["records"], 1);
    assert_eq!(
        o.status()["lifecycle_commitments"]["semantic_replay_verified"],
        false
    );
    let mut wrong = side;
    wrong[1] ^= 1;
    let mut o = observer();
    assert_eq!(
        o.observe_page(
            &[feed(1, &[(b"PSW1", b), (b"PSWC", wrong)])],
            &scope().program
        ),
        0
    );
    assert!(o.chain(e::WideTarget::Province(province())).is_none());
}

#[test]
fn source_depart_settle_origin_and_reveal_keep_original_identity_only() {
    let c = ctx();
    let r = AccountResolver::for_season(&c).unwrap();
    let host = r
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let holding = r.holding_address(&host).unwrap();
    let external = march::transit_address(&c, &holding, 0);
    let mut records = vec![];
    for action in [source::Action::Depart, source::Action::SettleOrigin] {
        let receipt = source::SourceReceipt {
            bell: 10,
            identity: source::Identity {
                host,
                slot: 0,
                citizen: if action == source::Action::Depart {
                    [7; 32]
                } else {
                    [0; 32]
                },
                holding,
                origin: host.key(),
                province: r.province_address(host.key()).unwrap(),
                external,
            },
            receipt: source::Receipt::new(action, [1; 32], [2; 32]),
        };
        let previous = action
            .entities()
            .iter()
            .map(|entity| log::Link {
                entity: *entity,
                seq: 0,
                head: [0; 32],
            })
            .collect::<Vec<_>>();
        records.push((b"PS2".as_slice(), receipt.prepare(&c, &previous).unwrap().0));
    }
    let reveal = producer::Record {
        bell: 10,
        target: producer::Target::Reveal {
            destination: province(),
            identity: producer::RevealIdentity {
                host,
                original_owner: [7; 32],
                holding,
                external,
                transit_slot: 0,
            },
        },
        receipt: producer::Receipt::new(producer::Action::Reveal, [1; 32], [2; 32]),
    }
    .encode(&c)
    .unwrap();
    records.push((b"PS2".as_slice(), reveal));
    let mut o = observer();
    assert_eq!(o.observe_page(&[feed(1, &records)], &scope().program), 1);
    assert_eq!(o.expedition_receipt().unwrap().host(), Some(host));
    assert_eq!(o.status()["expedition_receipts"]["records"], 3);
    assert_eq!(o.status()["chain"]["keys"], 0);
    assert!(o.model.hosts.is_empty());
    assert!(o.model.slots.is_empty());
    assert!(o.model.holdings.is_empty());
    assert!(
        !o.status()["expedition_receipts"]["original_history_verified"]
            .as_bool()
            .unwrap()
    );
}

fn resident_pair(
    action: frontier_abi::world_index::expedition_resident_event::Action,
    prior: e::WideLink,
) -> (Vec<u8>, Vec<u8>, e::WideLink) {
    use frontier_abi::world_index::expedition_resident_event as re;
    let c = ctx();
    let resolver = AccountResolver::for_season(&c).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let receipt = re::Receipt::new([action as u8; 32], [9; 32]);
    let body = |wide: bool| {
        let mut b = vec![
            if wide {
                e::WIDE_EVENT_VERSION
            } else {
                log::VERSION
            },
            if wide {
                re::WIDE_KIND
            } else {
                re::ORIGINAL_KIND
            },
        ];
        b.extend_from_slice(&10u32.to_le_bytes());
        b.extend_from_slice(&[re::VERSION, action as u8, 0, 0]);
        b.extend_from_slice(&host.to_bytes());
        b.extend_from_slice(&[7; 32]);
        b.extend_from_slice(&resolver.holding_address(&host).unwrap());
        b.extend_from_slice(&province().to_bytes());
        b.extend_from_slice(&resolver.province_address(province()).unwrap());
        b.extend_from_slice(&[2, 2]);
        b.extend_from_slice(&12345u32.to_le_bytes());
        b.extend_from_slice(
            &(if action == re::Action::Dissolve {
                10u32
            } else {
                9u32
            })
            .to_le_bytes(),
        );
        b.extend_from_slice(
            &(if action == re::Action::Dissolve {
                0u32
            } else {
                12u32
            })
            .to_le_bytes(),
        );
        for d in [receipt.operation_id, receipt.input, receipt.output] {
            b.extend_from_slice(&d);
        }
        assert_eq!(b.len(), re::BODY_LEN);
        b
    };
    let mut a = body(false);
    let links = action
        .entities()
        .iter()
        .map(|entity| log::advance(*entity, 0, &[0; 32], &a).unwrap())
        .collect::<Vec<_>>();
    a.push(links.len() as u8);
    for link in links {
        a.push(link.entity as u8);
        a.extend_from_slice(&link.seq.to_le_bytes());
        a.extend_from_slice(&link.head);
    }
    let mut b = body(true);
    let link = e::advance(prior.entity, prior.seq, &prior.head, &b).unwrap();
    b.push(1);
    b.push(link.entity as u8);
    b.extend_from_slice(&link.seq.to_le_bytes());
    b.extend_from_slice(&link.head);
    (a, b, link)
}

#[test]
fn multiple_resident_pairs_count_one_transaction_and_preserve_chain_order() {
    use frontier_abi::world_index::expedition_resident_event::Action;
    let (a, b, first) = resident_pair(Action::Dissolve, zero());
    let (middle, second) = resolve(first);
    let (c, d, third) = resident_pair(Action::Return, second);
    let tx = feed(
        1,
        &[
            (b"PS2", a),
            (b"PSW1", b),
            (b"PSW1", middle),
            (b"PS2", c),
            (b"PSW1", d),
        ],
    );
    let mut o = observer();
    assert_eq!(o.observe_page(&[tx], &scope().program), 1);
    assert_eq!(o.status()["resident_receipts"]["transactions"], 1);
    assert_eq!(
        o.chain(e::WideTarget::Province(province())).unwrap().head,
        third.head
    );
    assert_eq!(o.status()["resident_receipts"]["completion_proven"], false);
    assert!(o.model.hosts.is_empty());
}

#[path = "../../fclient/tests/fixtures/original_boundary.rs"]
mod native_fixture;

#[test]
fn native_capture_trace_continues_exact_chain_without_claiming_lifecycle_completion() {
    use fclient::typed_log::{
        decode_transaction_with_expedition, ProgramRecord, TransactionRecords,
    };
    let (c, txs) = native_fixture::trace();
    assert_eq!(txs.len(), 51);
    let world =
        frontier_abi::world_index::WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
    let program = Address::new_from_array(c.program);
    let mut o = WideObserver::new_with_expedition(Scope { program, season: Address::new_from_array(c.season), world, source: "immutable native log fixture; supplied observations, not live authenticated history".into() }, Limits::default()).unwrap();
    let mut count = 0;
    let mut last = None;
    let mut captured = false;
    for tx in &txs {
        let TransactionRecords::Committed(records) =
            decode_transaction_with_expedition(tx, &program, &c).unwrap()
        else {
            panic!("fixture must commit")
        };
        count += records.len();
        for record in &records {
            match record {
                ProgramRecord::Psw1 { body } => {
                    let r = e::WideRecord::decode(body).unwrap();
                    captured |= r.kind == e::WideKind::ConquestCaptured;
                    for link in r.links.iter().flatten() {
                        let target = match link.entity {
                            e::WideEntity::Province => {
                                e::WideTarget::Province(r.province_of().unwrap())
                            }
                            e::WideEntity::Holding => {
                                e::WideTarget::Holding(r.holding_of().unwrap())
                            }
                        };
                        last = Some((target, *link));
                    }
                }
                ProgramRecord::ExpeditionWide { body } => {
                    let r = settlement::Record::decode(&c, body).unwrap();
                    last = Some((
                        e::WideTarget::Province(r.identity.destination),
                        r.wide_link.unwrap(),
                    ));
                }
                ProgramRecord::ResidentWide { body } => {
                    let r = frontier_abi::world_index::expedition_resident_event::Record::decode(
                        &c, body,
                    )
                    .unwrap();
                    last = Some((
                        e::WideTarget::Province(r.identity.standing),
                        r.wide_link.unwrap(),
                    ));
                }
                _ => {}
            }
        }
        o.observe_page(std::slice::from_ref(tx), &program);
        assert!(
            o.model.blocked().is_none(),
            "seq {}: {:?}",
            tx.seq,
            o.model.blocked()
        );
        assert_eq!(o.accepted_prefix, 1);
        if let Some((p, link)) = last {
            let head = o.chain(p).unwrap();
            assert_eq!((head.seq, head.head), (link.seq, link.head));
        }
        assert!(o.model.hosts.is_empty());
        assert!(o.model.holdings.is_empty());
    }
    assert_eq!(count, 56);
    assert!(captured);
    assert_eq!(o.last_seq_seen, Some(51));
    assert_eq!(o.status()["lifecycle_commitments"]["records"], 40);
    assert_eq!(o.status()["resident_receipts"]["transactions"], 2);
    assert_eq!(o.status()["resident_receipts"]["completion_proven"], false);
    assert_eq!(
        o.status()["lifecycle_commitments"]["semantic_replay_verified"],
        false
    );
    assert_eq!(o.status()["source_complete"], false);
    // Actual original Return remains only a read selection, not a completed task.
    assert!(o.resident_selection().is_some());
    let before = o.status();
    assert_eq!(o.observe_page(&txs, &program), 0);
    assert_eq!(o.status(), before);
}

#[test]
fn target_only_lapse_and_capture_are_unverified_and_orphan_sources_are_atomic() {
    use frontier_abi::world_index::WideHostRef;
    for (kind, action) in [
        (e::WideKind::ConquestSettled, e::conquest::LAPSE),
        (e::WideKind::ConquestCaptured, e::conquest::CAPTURE),
    ] {
        let holding = WideHostRef::new(province(), 2, 3, 0).unwrap();
        let (ordinary, prior) = resolve(zero());
        let receipt = e::conquest::Receipt::new(action, 0, [31; 32], [32; 32])
            .unwrap()
            .encode();
        let key = if kind.holding_keyed() {
            holding.to_bytes().to_vec()
        } else {
            province().to_bytes().to_vec()
        };
        let mut raw = vec![0; e::MAX_BODY];
        let n = e::write_body(kind, 10, &key, &receipt, &mut raw).unwrap();
        raw.truncate(n);
        let links = kind
            .links()
            .iter()
            .map(|entity| {
                let (seq, head) = if *entity == e::WideEntity::Province {
                    (prior.seq, prior.head)
                } else {
                    (0, [0; 32])
                };
                e::advance(*entity, seq, &head, &raw).unwrap()
            })
            .collect::<Vec<_>>();
        let target = e::encode(kind, 10, &key, &receipt, &links).unwrap();
        let mut o = observer();
        assert_eq!(
            o.observe_page(
                &[feed(
                    1,
                    &[(b"PSW1", ordinary.clone()), (b"PSW1", target.clone())]
                )],
                &scope().program
            ),
            1
        );
        assert!(o.model.blocked().is_none());
        for link in &links {
            let key = match link.entity {
                e::WideEntity::Province => e::WideTarget::Province(province()),
                e::WideEntity::Holding => e::WideTarget::Holding(holding),
            };
            let observed = o.chain(key).unwrap();
            assert_eq!((observed.seq, observed.head), (link.seq, link.head));
        }
        assert!(o.model.hosts.is_empty());
        assert!(o.model.holdings.is_empty());
        assert!(o.expedition_receipt().is_none());
        assert_eq!(o.status()["expedition_receipts"]["records"], 0);
        assert_eq!(o.status()["lifecycle_commitments"]["records"], 1);
        assert_eq!(
            o.status()["lifecycle_commitments"]["completion_proven"],
            false
        );
        assert_eq!(
            o.status()["lifecycle_commitments"]["semantic_replay_verified"],
            false
        );
        assert_eq!(
            o.status()["lifecycle_commitments"]["source_authenticated"],
            false
        );

        // A source with a different operation has no matching target. Even a
        // valid target-only operation earlier in this transaction cannot make
        // that orphan acceptable or leak its staged ordinary/target effects.
        let source_kind = e::WideKind::ConquestCredited;
        let orphan_receipt = e::conquest::Receipt::new(action, 0, [41; 32], [42; 32])
            .unwrap()
            .encode();
        let mut raw = vec![0; e::MAX_BODY];
        let n = e::write_body(
            source_kind,
            10,
            &holding.to_bytes(),
            &orphan_receipt,
            &mut raw,
        )
        .unwrap();
        raw.truncate(n);
        let source_links = source_kind
            .links()
            .iter()
            .map(|entity| e::advance(*entity, 0, &[0; 32], &raw).unwrap())
            .collect::<Vec<_>>();
        let orphan = e::encode(
            source_kind,
            10,
            &holding.to_bytes(),
            &orphan_receipt,
            &source_links,
        )
        .unwrap();
        let mut bad = observer();
        assert_eq!(
            bad.observe_page(
                &[feed(
                    1,
                    &[(b"PSW1", ordinary), (b"PSW1", target), (b"PSW1", orphan)]
                )],
                &scope().program
            ),
            0
        );
        assert!(bad.model.blocked().is_some());
        assert_eq!(bad.status()["chain"]["keys"], 0);
        assert_eq!(bad.status()["lifecycle_commitments"]["records"], 0);
        assert!(bad.model.provinces.is_empty());
        assert!(bad.model.holdings.is_empty());
        assert_eq!(bad.last_seq_seen, None);
    }
}
