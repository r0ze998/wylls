//! Literal public identities, public hashing only. No runtime, signing or IO.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::{
    addr::AddrCtx,
    log::{self, EntityKind, Link},
    world_index::{
        expedition::AccountResolver, expedition_event::*, march::transit_address, wide_ix::Depart,
        ProvinceKey, WideCoord, WideHostRef,
    },
};

fn ctx() -> AddrCtx {
    AddrCtx {
        season: [7; 32],
        program: [9; 32],
    }
}
fn identity(action: Action) -> Identity {
    let c = ctx();
    let r = AccountResolver::for_season(&c).unwrap();
    let origin = ProvinceKey::new(r.adapter().world(), WideCoord::checked(128, 0).unwrap());
    let host = WideHostRef::new(origin, 3, 2, 17).unwrap();
    let holding = r.holding_address(&host).unwrap();
    Identity {
        host,
        slot: 2,
        citizen: if action == Action::Depart {
            [3; 32]
        } else {
            [0; 32]
        },
        holding,
        origin,
        province: r.province_address(origin).unwrap(),
        external: transit_address(&c, &holding, 2),
    }
}
fn previous(action: Action) -> Vec<Link> {
    action
        .entities()
        .iter()
        .enumerate()
        .map(|(i, entity)| Link {
            entity: *entity,
            seq: 40 + i as u64,
            head: [i as u8; 32],
        })
        .collect()
}
fn source(action: Action) -> SourceReceipt {
    SourceReceipt {
        bell: 12,
        identity: identity(action),
        receipt: Receipt::new(action, [1; 32], [2; 32]),
    }
}

#[test]
fn original_ps2_chains_exact_width_and_unknown_kind() {
    assert_eq!(BODY_WITHOUT_TAIL_LEN, 344);
    assert!(BODY_WITHOUT_TAIL_LEN > log::SOFT_BODY_MAX);
    assert!(DEPART_LEN <= 800);
    assert_eq!(PREFIX, b"PS2");
    assert!(log::Kind::from_u8(KIND).is_none());
    assert!(frontier_abi::v2::log::AnyKind::from_u8(KIND).is_none());
    for action in [Action::Depart, Action::SettleOrigin] {
        let s = source(action);
        let p = previous(action);
        let (b, links) = s.prepare(&ctx(), &p).unwrap();
        assert_eq!(b.len(), if action == Action::Depart { 468 } else { 427 });
        let record = Record::decode(&ctx(), &b).unwrap();
        assert_eq!(record.source, s);
        assert_eq!(record.links, links);
        record.verify_previous(&ctx(), &p).unwrap();
        for (old, new) in p.iter().zip(&links) {
            assert_eq!(
                new.head,
                log::next_head(&old.head, old.seq + 1, &b[..BODY_WITHOUT_TAIL_LEN])
            );
        }
        let mut wrong = p.clone();
        wrong[0].seq = 0;
        assert_eq!(record.verify_previous(&ctx(), &wrong), Err(Error::Chain));
        wrong[0].seq = u64::MAX;
        assert_eq!(s.prepare(&ctx(), &wrong), Err(Error::Chain));
        for end in 0..b.len() {
            assert!(Record::decode(&ctx(), &b[..end]).is_err());
        }
        let mut extra = b.clone();
        extra.push(0);
        assert!(Record::decode(&ctx(), &extra).is_err());
        for off in [
            0,
            1,
            6,
            7,
            8,
            9,
            10,
            BODY_WITHOUT_TAIL_LEN,
            BODY_WITHOUT_TAIL_LEN + 1,
        ] {
            let mut bad = b.clone();
            bad[off] = 255;
            assert!(Record::decode(&ctx(), &bad).is_err(), "offset {off}");
        }
        let mut swapped = p.clone();
        swapped.swap(0, 1);
        assert_eq!(s.prepare(&ctx(), &swapped), Err(Error::Chain));
    }
    assert_eq!(
        Action::Depart.entities(),
        &[
            EntityKind::Citizen,
            EntityKind::Holding,
            EntityKind::Province
        ]
    );
    assert_eq!(
        Action::SettleOrigin.entities(),
        &[EntityKind::Holding, EntityKind::Province]
    );
}

#[test]
fn identity_and_operation_domains_are_not_conquest() {
    let mut s = source(Action::Depart);
    let original = s.receipt;
    assert_ne!(
        original.operation_id,
        frontier_abi::world_index::event::conquest::Receipt::new(1, 0, [1; 32], [2; 32])
            .unwrap()
            .operation_id
    );
    assert_ne!(
        original.operation_id,
        Receipt::new(Action::SettleOrigin, [1; 32], [2; 32]).operation_id
    );
    let mut encoded = original.encode();
    encoded[4] ^= 1;
    assert!(Receipt::decode(&encoded).is_err());
    s.identity.slot = 3;
    assert!(s.prepare(&ctx(), &previous(Action::Depart)).is_err());
    s = source(Action::Depart);
    s.identity.holding[0] ^= 1;
    assert!(s.prepare(&ctx(), &previous(Action::Depart)).is_err());
    s = source(Action::SettleOrigin);
    s.identity.citizen = [3; 32];
    assert!(s.prepare(&ctx(), &previous(Action::SettleOrigin)).is_err());
}

#[test]
fn full_manifest_binds_external_headers_aliases_privileges_time_and_outcomes() {
    let id = identity(Action::Depart);
    let d = Depart {
        host: id.host.to_bytes(),
        transit_slot: id.slot,
        arrive_bell: 14,
        tip: 9,
        commit: [4; 32],
        seal: [0; 264],
    }
    .to_bytes();
    let mut command = vec![0xDA, 0xFF, 1, 6];
    command.extend_from_slice(&d[1..]);
    let data = vec![8; 80];
    let external = vec![4; 304];
    let c = Context {
        command: &command,
        now_ts: 100,
        bell: 12,
        season: &data,
        evidence: &[0],
    };
    let addresses = [
        [1; 32],
        [2; 32],
        ctx().season,
        id.citizen,
        id.holding,
        id.province,
        [0; 32],
        id.province,
        id.external,
    ];
    let a: Vec<_> = addresses
        .iter()
        .enumerate()
        .map(|(i, address)| AccountSnapshot {
            role: i as u16 + 1,
            address: *address,
            owner: ctx().program,
            present: true,
            signer: i < 2,
            writable: matches!(i, 1 | 3 | 4 | 5 | 8),
            lamports: 40,
            data: if i == 8 { &external } else { &data },
        })
        .collect();
    let input = input_digest(&ctx(), Action::Depart, &id, &c, &a).unwrap();
    let outcomes = Outcomes {
        escrow: 3,
        rent: 4,
        dep_mass: 1000,
        march_stamina: 200,
        finalized: true,
        ..Outcomes::default()
    };
    let output = output_digest(&ctx(), Action::Depart, &id, &c, &a, outcomes).unwrap();
    let mut header_change = data.clone();
    header_change[24..64].fill(9);
    let mut changed = a.clone();
    for i in [3, 4, 5, 7] {
        changed[i].data = &header_change;
    }
    assert_ne!(
        input,
        input_digest(&ctx(), Action::Depart, &id, &c, &changed).unwrap()
    );
    assert_eq!(
        output,
        output_digest(&ctx(), Action::Depart, &id, &c, &changed, outcomes).unwrap()
    );
    changed[7].data = &data;
    assert!(output_digest(&ctx(), Action::Depart, &id, &c, &changed, outcomes).is_err());
    changed = a.clone();
    let mut external_change = external.clone();
    external_change[24] ^= 1;
    changed[8].data = &external_change;
    assert_ne!(
        output,
        output_digest(&ctx(), Action::Depart, &id, &c, &changed, outcomes).unwrap()
    );
    changed = a.clone();
    changed[0].signer = false;
    assert_ne!(
        input,
        input_digest(&ctx(), Action::Depart, &id, &c, &changed).unwrap()
    );
    assert_ne!(
        input,
        input_digest(
            &ctx(),
            Action::Depart,
            &id,
            &Context { now_ts: 101, ..c },
            &a
        )
        .unwrap()
    );
    assert_ne!(
        output,
        output_digest(
            &ctx(),
            Action::Depart,
            &id,
            &c,
            &a,
            Outcomes {
                escrow: 4,
                ..outcomes
            }
        )
        .unwrap()
    );
    assert!(input_digest(&ctx(), Action::Depart, &id, &c, &a[..8]).is_err());
    changed = a.clone();
    changed[1].role = 1;
    assert!(input_digest(&ctx(), Action::Depart, &id, &c, &changed).is_err());
}

#[test]
fn settlement_six_roles_bind_holding_and_unchained_external() {
    use frontier_abi::world_index::wide_ix::ExpeditionSettleOrigin;
    let id = identity(Action::SettleOrigin);
    let command = ExpeditionSettleOrigin {
        transit_slot: id.slot,
    }
    .to_bytes();
    let data = vec![8; 80];
    let external = vec![4; 304];
    let c = Context {
        command: &command,
        now_ts: 100,
        bell: 12,
        season: &data,
        evidence: &[0],
    };
    let addresses = [
        [1; 32],
        ctx().season,
        id.province,
        id.holding,
        id.province,
        id.external,
    ];
    let accounts: Vec<_> = addresses
        .iter()
        .enumerate()
        .map(|(i, address)| AccountSnapshot {
            role: i as u16 + 1,
            address: *address,
            owner: ctx().program,
            present: true,
            signer: i == 0,
            writable: i != 1,
            lamports: 40,
            data: if i == 5 { &external } else { &data },
        })
        .collect();
    let outcomes = Outcomes {
        dep_mass: 1000,
        march_stamina: 200,
        troops_after: 900,
        stamina_after: 180,
        ready_bell_off: 3,
        ..Outcomes::default()
    };
    let before = input_digest(&ctx(), Action::SettleOrigin, &id, &c, &accounts).unwrap();
    let after = output_digest(&ctx(), Action::SettleOrigin, &id, &c, &accounts, outcomes).unwrap();
    let mut changed = accounts.clone();
    changed.swap(2, 3);
    assert_eq!(
        input_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed),
        Err(Error::Manifest)
    );
    assert_eq!(
        input_digest(&ctx(), Action::SettleOrigin, &id, &c, &accounts[..5]),
        Err(Error::Manifest)
    );
    let mut header_change = data.clone();
    header_change[24..64].fill(9);
    changed = accounts.clone();
    for i in [2, 3, 4] {
        changed[i].data = &header_change;
    }
    assert_ne!(
        before,
        input_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed).unwrap()
    );
    assert_eq!(
        after,
        output_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed, outcomes).unwrap()
    );
    let mut holding_change = data.clone();
    holding_change[64] ^= 1;
    changed = accounts.clone();
    changed[3].data = &holding_change;
    assert_ne!(
        after,
        output_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed, outcomes).unwrap()
    );
    let mut bridge_change = external.clone();
    bridge_change[24] ^= 1;
    changed = accounts.clone();
    changed[5].data = &bridge_change;
    assert_ne!(
        after,
        output_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed, outcomes).unwrap()
    );
    for owner_mismatch in [true, false] {
        changed = accounts.clone();
        if owner_mismatch {
            changed[4].owner = [77; 32];
        } else {
            changed[4].lamports += 1;
        }
        assert_eq!(
            input_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed),
            Err(Error::Manifest)
        );
        assert_eq!(
            output_digest(&ctx(), Action::SettleOrigin, &id, &c, &changed, outcomes),
            Err(Error::Manifest)
        );
    }
    assert_ne!(
        after,
        output_digest(
            &ctx(),
            Action::SettleOrigin,
            &id,
            &c,
            &accounts,
            Outcomes {
                ready_bell_off: 4,
                ..outcomes
            }
        )
        .unwrap()
    );
}

#[test]
fn prefunded_absent_creation_and_malformed_outcomes_are_explicit() {
    use frontier_abi::world_index::wide_ix::ExpeditionDepart;
    let id = identity(Action::Depart);
    let command = ExpeditionDepart {
        host: id.host.to_bytes(),
        transit_slot: id.slot,
        arrive_bell: 14,
        tip: 9,
        commit: [4; 32],
        seal: [0; 264],
    }
    .to_bytes();
    let data = vec![8; 80];
    let c = Context {
        command: &command,
        now_ts: 100,
        bell: 12,
        season: &data,
        evidence: &[0],
    };
    let addresses = [
        [1; 32],
        [2; 32],
        ctx().season,
        id.citizen,
        id.holding,
        id.province,
        [0; 32],
        id.province,
        id.external,
    ];
    let mut accounts: Vec<_> = addresses
        .iter()
        .enumerate()
        .map(|(i, address)| AccountSnapshot {
            role: i as u16 + 1,
            address: *address,
            owner: ctx().program,
            present: true,
            signer: i < 2,
            writable: matches!(i, 1 | 3 | 4 | 5 | 7 | 8),
            lamports: 40,
            data: &data,
        })
        .collect();
    accounts[8].owner = [0; 32];
    accounts[8].present = false;
    accounts[8].data = &[];
    let prefunded = input_digest(&ctx(), Action::Depart, &id, &c, &accounts).unwrap();
    accounts[8].lamports = 0;
    assert_ne!(
        prefunded,
        input_digest(&ctx(), Action::Depart, &id, &c, &accounts).unwrap()
    );
    accounts[8].data = &[1];
    assert_eq!(
        input_digest(&ctx(), Action::Depart, &id, &c, &accounts),
        Err(Error::Manifest)
    );
    for malformed in [
        Outcomes {
            troops_after: 1,
            ..Outcomes::default()
        },
        Outcomes {
            stamina_after: 1,
            ..Outcomes::default()
        },
        Outcomes {
            ready_bell_off: 1,
            ..Outcomes::default()
        },
        Outcomes {
            destroyed: true,
            ..Outcomes::default()
        },
    ] {
        assert_eq!(malformed.encode(Action::Depart), Err(Error::Receipt));
    }
    for malformed in [
        Outcomes {
            escrow: 1,
            ..Outcomes::default()
        },
        Outcomes {
            rent: 1,
            ..Outcomes::default()
        },
        Outcomes {
            finalized: true,
            ..Outcomes::default()
        },
        Outcomes {
            destroyed: true,
            troops_after: 1,
            ..Outcomes::default()
        },
        Outcomes {
            destroyed: true,
            stamina_after: 1,
            ..Outcomes::default()
        },
    ] {
        assert_eq!(malformed.encode(Action::SettleOrigin), Err(Error::Receipt));
    }
    assert_eq!(
        Outcomes::default().encode(Action::Depart).unwrap().len(),
        34
    );
    assert!(Outcomes {
        destroyed: true,
        ..Outcomes::default()
    }
    .encode(Action::SettleOrigin)
    .is_ok());
}
