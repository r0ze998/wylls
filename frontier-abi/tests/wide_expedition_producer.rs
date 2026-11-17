//! Literal public identities, pure codecs and public hashes only; no runtime.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::{
    addr::{self, AddrCtx},
    log,
    prologue::{bounds_in, position_in},
    tags::Class,
    world_index::{
        expedition::AccountResolver,
        expedition_producer_event::*,
        expedition_transport::OwnedBridgeTransit,
        march::{transit_address, WideTransit},
        seal, wide_ix as w, ProvinceKey, TileAddress, WideCoord, WidePlain,
        HOST_IDENTITY_FULL_REF_V1,
    },
};
fn ctx() -> AddrCtx {
    AddrCtx {
        season: [7; 32],
        program: [9; 32],
    }
}
fn dest() -> ProvinceKey {
    ProvinceKey::new(
        AccountResolver::for_season(&ctx())
            .unwrap()
            .adapter()
            .world(),
        WideCoord::checked(129, 0).unwrap(),
    )
}
fn reveal() -> (Target, w::ExpeditionReveal, Vec<u8>) {
    let r = AccountResolver::for_season(&ctx()).unwrap();
    let host = r
        .legacy_host_ref(addr::host_id(128, 0, 2, 1, 0).unwrap())
        .unwrap();
    let holding = r.holding_address(&host).unwrap();
    let external = transit_address(&ctx(), &holding, 2);
    let t = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        host,
        1,
        2,
        TileAddress::new(host.key(), 3).unwrap(),
        10,
        12,
        600,
        100000,
        74,
        10500,
        [1; 32],
        0,
        0,
        [2; 32],
    )
    .unwrap();
    let owned = OwnedBridgeTransit::new(&ctx(), 2, t, [3; 32]).unwrap();
    let target = Target::Reveal {
        destination: dest(),
        identity: RevealIdentity {
            host,
            original_owner: [3; 32],
            holding,
            external,
            transit_slot: 2,
        },
    };
    let plain = WidePlain {
        version: seal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: 12,
        dest: dest(),
        dest_tile: 4,
        stance: 0,
        retreat_bps: 0,
        path_len: 1,
        path: Default::default(),
        reserved: [0; 8],
    };
    (
        target,
        w::ExpeditionReveal {
            transit_slot: 2,
            target_i: 1,
            plain: seal::pack(&plain),
            salt: [4; 32],
            ct_hash: [5; 32],
            beneficiary: [6; 32],
        },
        owned.to_bytes().to_vec(),
    )
}
fn snapshots<'a>(
    target: Target,
    data: &'a [u8],
    external: &'a [u8],
    count: usize,
) -> Vec<AccountSnapshot<'a>> {
    let mut a: Vec<_> = (0..count)
        .map(|i| AccountSnapshot {
            role: i as u16 + 1,
            address: [i as u8 + 40; 32],
            owner: ctx().program,
            present: true,
            signer: i == 0,
            writable: i == 0,
            lamports: 100,
            data,
        })
        .collect();
    a[0].lamports = 1000;
    a[1].address = ctx().season;
    let destination = AccountResolver::for_season(&ctx())
        .unwrap()
        .province_address(target.destination())
        .unwrap();
    match target {
        Target::Reveal { identity, .. } => {
            a[2].address = identity.holding;
            a[3].address = identity.external;
            a[3].data = external;
            a[8].address = destination;
            a[9].writable = true;
            a[11].writable = true;
        }
        Target::Gather { .. } => {
            a[2].address = destination;
            a[4].writable = true;
            for j in 0..(count - 8) / 3 {
                a[10 + 3 * j].writable = true;
            }
        }
    }
    a
}
fn outcomes() -> RevealOutcomes {
    RevealOutcomes {
        raw_secs: 120,
        watched_secs: 60,
        travel_secs: 120,
        wear_bps: 100,
        target_i: 1,
        create_slot: true,
        create_day: true,
        write_day: true,
        displaced: false,
        rent_slot: 10,
        rent_day: 20,
        paid_slot: 8,
        paid_day: 17,
        payer_debit: 25,
    }
}

#[test]
fn dedicated_envelopes_have_exact_roles_classes_and_stay_closed() {
    let (_, reveal, _) = reveal();
    let rb = reveal.to_bytes();
    let gather = w::ExpeditionGather {
        bell: 12,
        start: 0,
        n: 24,
    };
    let gb = gather.to_bytes();
    assert_eq!((rb.len(), gb.len()), (238, 10));
    assert_eq!(&rb[..4], &[0xee, 255, 1, 1]);
    assert_eq!(&gb[..4], &[0xdc, 255, 1, 11]);
    assert_eq!(
        w::WideCommand::decode(&rb),
        Ok(w::WideCommand::ExpeditionReveal(reveal))
    );
    assert_eq!(
        w::WideCommand::decode(&gb),
        Ok(w::WideCommand::ExpeditionGather(gather))
    );
    assert!(w::Reveal::decode(&rb).is_err());
    assert!(w::Gather::decode(&gb).is_err());
    for (b, class, bounds) in [(&rb[..], Class::W, (16, 19)), (&gb[..], Class::D, (8, 80))] {
        let c = w::WideCommand::decode(b).unwrap();
        assert_eq!(c.class(), class);
        assert!(c.top_level_only() && c.march_stage());
        assert!(!c.is_player());
        assert_eq!(bounds_in(c.accounts()), bounds);
        let mut wrapped = vec![0; b.len() + w::ResidentAct::HEAD];
        w::ResidentAct {
            generation: 1,
            inner: b,
        }
        .encode_into(&mut wrapped)
        .unwrap();
        assert!(w::ResidentAct::decode(&wrapped).is_err());
        let mut long = b.to_vec();
        long.push(0);
        assert!(w::WideCommand::decode(&long).is_err());
        for at in 0..4 {
            let mut bad = b.to_vec();
            bad[at] = 0;
            assert!(w::WideCommand::decode(&bad).is_err());
        }
    }
    for end in 0..rb.len() {
        assert!(w::ExpeditionReveal::decode(&rb[..end]).is_err());
    }
    for end in 0..gb.len() {
        assert!(w::ExpeditionGather::decode(&gb[..end]).is_err());
    }
    for (start, n) in [(0, 0), (23, 2), (24, 1), (255, 255)] {
        assert!(w::ExpeditionGather::decode(
            &w::ExpeditionGather { bell: 12, start, n }.to_bytes()
        )
        .is_err());
    }
    assert_eq!(position_in(w::EXPEDITION_GATHER, 80, "slot", 23), Some(77));
    assert_eq!(
        position_in(w::EXPEDITION_GATHER, 80, "original_holding", 23),
        Some(78)
    );
    assert_eq!(
        position_in(w::EXPEDITION_GATHER, 80, "owned_bridge", 23),
        Some(79)
    );
}

#[test]
fn exact_zero_tail_records_are_separate_from_all_old_kinds() {
    assert!(log::Kind::from_u8(KIND).is_none());
    assert!(frontier_abi::v2::log::AnyKind::from_u8(KIND).is_none());
    assert_eq!(KIND, 147);
    assert_eq!(PREFIX, b"PS2");
    for target in [
        reveal().0,
        Target::Gather {
            destination: dest(),
        },
    ] {
        let r = Record {
            bell: 12,
            target,
            receipt: Receipt::new(target.action(), [1; 32], [2; 32]),
        };
        let b = r.encode(&ctx()).unwrap();
        assert_eq!(
            b.len(),
            if target.action() == Action::Reveal {
                314
            } else {
                161
            }
        );
        assert_eq!(b[b.len() - 1], 0);
        assert!(b.len() <= 800);
        assert!(b.len() - 1 > log::SOFT_BODY_MAX);
        assert_eq!(Record::decode(&ctx(), &b), Ok(r));
        for end in 0..b.len() {
            assert!(Record::decode(&ctx(), &b[..end]).is_err());
        }
        for at in [0, 1, 6, 7, 8, 9, b.len() - 1] {
            let mut bad = b.clone();
            bad[at] = 255;
            assert!(Record::decode(&ctx(), &bad).is_err());
        }
        let mut extra = b.clone();
        extra.push(0);
        assert!(Record::decode(&ctx(), &extra).is_err());
        let old = frontier_abi::world_index::expedition_event::Receipt::new(
            frontier_abi::world_index::expedition_event::Action::Depart,
            [1; 32],
            [2; 32],
        );
        assert_ne!(r.receipt.operation_id, old.operation_id);
    }
}

#[test]
fn reveal_full_manifests_bind_raw_headers_owner_context_and_prefund_transfers() {
    // Output byte fixtures test raw commitment/pairing only, not valid slot
    // production or route replay; those belong to authenticated runtime tests.
    let (target, cmd, external) = reveal();
    let command = cmd.to_bytes();
    let data = vec![8; 80];
    let new_slot = vec![9; 288];
    let new_day = vec![7; 144];
    let c = Context {
        command: &command,
        now_ts: 600,
        now_slot: 44,
        bell: 12,
        season: &data,
        evidence: &[1, 2, 3],
    };
    let mut before = snapshots(target, &data, &external, 16);
    for (i, lamports) in [(9, 3), (11, 2)] {
        before[i].present = false;
        before[i].owner = [0; 32];
        before[i].data = &[];
        before[i].lamports = lamports;
    }
    let mut after = before.clone();
    after[0].lamports -= 25;
    for (i, d, lamports) in [(9, &new_day[..], 20), (11, &new_slot[..], 10)] {
        after[i].present = true;
        after[i].owner = ctx().program;
        after[i].data = d;
        after[i].lamports = lamports;
    }
    let out = Outcomes::Reveal(outcomes());
    let r = prepare(&ctx(), target, &c, &before, &after, out).unwrap();
    assert_eq!(Record::decode(&ctx(), &r.encode(&ctx()).unwrap()), Ok(r));
    let mut changed = after.clone();
    let mut header = data.clone();
    header[24] ^= 1;
    changed[2].data = &header;
    assert_ne!(
        r.receipt.output,
        output_digest(&ctx(), target, &c, &changed, out).unwrap(),
        "legacy headers are NOT normalized"
    );
    assert_eq!(
        prepare(&ctx(), target, &c, &before, &changed, out),
        Err(Error::Effects)
    );
    changed = after.clone();
    changed[0].lamports += 1;
    assert_eq!(
        prepare(&ctx(), target, &c, &before, &changed, out),
        Err(Error::Effects)
    );
    assert_ne!(
        r.receipt.input,
        input_digest(&ctx(), target, &Context { now_slot: 45, ..c }, &before).unwrap()
    );
    assert_ne!(
        r.receipt.input,
        input_digest(
            &ctx(),
            target,
            &Context {
                evidence: &[9],
                ..c
            },
            &before
        )
        .unwrap()
    );
    let mut bad_bridge = external.clone();
    bad_bridge[304] ^= 1;
    let mut changed = before.clone();
    changed[3].data = &bad_bridge;
    assert!(input_digest(&ctx(), target, &c, &changed).is_err());
    let bad = Outcomes::Reveal(RevealOutcomes {
        paid_slot: 9,
        payer_debit: 26,
        ..outcomes()
    });
    assert_eq!(
        prepare(&ctx(), target, &c, &before, &after, bad),
        Err(Error::Effects)
    );
    let mut changed = before.clone();
    changed[11].data = &[1];
    assert_eq!(
        input_digest(&ctx(), target, &c, &changed),
        Err(Error::Manifest)
    );
    let mut worn = new_slot.clone();
    worn[188] ^= 1;
    let mut changed = after.clone();
    changed[11].data = &worn;
    assert_ne!(
        r.receipt.output,
        output_digest(&ctx(), target, &c, &changed, out).unwrap(),
        "wear bytes are committed raw"
    );
    let old = w::Reveal {
        transit_slot: cmd.transit_slot,
        target_i: cmd.target_i,
        plain: cmd.plain,
        salt: cmd.salt,
        ct_hash: cmd.ct_hash,
        beneficiary: cmd.beneficiary,
    }
    .to_bytes();
    assert_eq!(
        input_digest(&ctx(), target, &Context { command: &old, ..c }, &before),
        Err(Error::Command)
    );
}

#[test]
fn gather_triples_aliases_stamp_masks_and_all_raw_bytes_are_committed() {
    let target = Target::Gather {
        destination: dest(),
    };
    let command = w::ExpeditionGather {
        bell: 12,
        start: 0,
        n: 2,
    }
    .to_bytes();
    let data = vec![8; 80];
    let bridge = vec![3; 336];
    let changed_bridge = vec![4; 336];
    let ci = vec![6; 3008];
    let c = Context {
        command: &command,
        now_ts: 700,
        now_slot: 55,
        bell: 12,
        season: &data,
        evidence: &[],
    };
    let mut before = snapshots(target, &data, &[], 14);
    before[10].data = &bridge;
    before[13] = AccountSnapshot {
        role: 14,
        ..before[10]
    };
    // Both roles name one external account; every alias must reflect the write.
    let mut after = before.clone();
    after[4].data = &ci;
    after[10].data = &changed_bridge;
    after[13].data = &changed_bridge;
    let outcome = GatherOutcomes {
        create_inputs: false,
        rent_inputs: 10,
        paid_inputs: 0,
        payer_debit: 0,
        arrivals_mask: 3,
        stamped_mask: 3,
        n_present: 1,
        no_arrivals: false,
    };
    let out = Outcomes::Gather(outcome);
    let r = prepare(&ctx(), target, &c, &before, &after, out).unwrap();
    let mut bad = after.clone();
    bad[13].data = &bridge;
    assert_eq!(
        output_digest(&ctx(), target, &c, &bad, out),
        Err(Error::Manifest)
    );
    bad = after.clone();
    bad[13].owner = [0; 32];
    assert_eq!(
        output_digest(&ctx(), target, &c, &bad, out),
        Err(Error::Manifest)
    );
    bad = after.clone();
    bad[13].lamports += 1;
    assert_eq!(
        output_digest(&ctx(), target, &c, &bad, out),
        Err(Error::Manifest)
    );
    bad = after.clone();
    bad.swap(8, 9);
    assert_eq!(
        output_digest(&ctx(), target, &c, &bad, out),
        Err(Error::Manifest)
    );
    assert!(input_digest(&ctx(), target, &c, &before[..13]).is_err());
    let mut no_stamp = outcome;
    no_stamp.stamped_mask = 0;
    assert_eq!(
        prepare(
            &ctx(),
            target,
            &c,
            &before,
            &after,
            Outcomes::Gather(no_stamp)
        ),
        Err(Error::Effects)
    );
    assert_ne!(
        r.receipt.output,
        output_digest(
            &ctx(),
            target,
            &c,
            &after,
            Outcomes::Gather(GatherOutcomes {
                n_present: 2,
                ..outcome
            })
        )
        .unwrap()
    );
    let mut privilege = before.clone();
    privilege[0].signer = false;
    assert_ne!(
        r.receipt.input,
        input_digest(&ctx(), target, &c, &privilege).unwrap()
    );
}

#[test]
fn gather_creation_prefund_and_invalid_outcomes_fail_closed() {
    let target = Target::Gather {
        destination: dest(),
    };
    let command = w::ExpeditionGather {
        bell: 12,
        start: 0,
        n: 1,
    }
    .to_bytes();
    let data = vec![8; 80];
    let ci = vec![6; 3008];
    let c = Context {
        command: &command,
        now_ts: 700,
        now_slot: 55,
        bell: 12,
        season: &data,
        evidence: &[],
    };
    let mut before = snapshots(target, &data, &[], 11);
    before[4].present = false;
    before[4].data = &[];
    before[4].owner = [0; 32];
    before[4].lamports = 3;
    let mut after = before.clone();
    after[4].present = true;
    after[4].data = &ci;
    after[4].owner = ctx().program;
    after[4].lamports = 10;
    after[0].lamports -= 7;
    let outcome = GatherOutcomes {
        create_inputs: true,
        rent_inputs: 10,
        paid_inputs: 7,
        payer_debit: 7,
        arrivals_mask: 0xffffff,
        stamped_mask: 0,
        n_present: 0,
        no_arrivals: true,
    };
    assert!(prepare(
        &ctx(),
        target,
        &c,
        &before,
        &after,
        Outcomes::Gather(outcome)
    )
    .is_ok());
    for bad in [
        GatherOutcomes {
            paid_inputs: 8,
            ..outcome
        },
        GatherOutcomes {
            arrivals_mask: 1,
            ..outcome
        },
        GatherOutcomes {
            n_present: 25,
            ..outcome
        },
        GatherOutcomes {
            stamped_mask: 1 << 24,
            ..outcome
        },
    ] {
        assert!(Outcomes::Gather(bad).encode().is_err());
    }
    for bad in [
        RevealOutcomes {
            wear_bps: 3001,
            ..outcomes()
        },
        RevealOutcomes {
            watched_secs: 121,
            ..outcomes()
        },
        RevealOutcomes {
            create_slot: false,
            ..outcomes()
        },
        RevealOutcomes {
            write_day: false,
            ..outcomes()
        },
    ] {
        assert!(Outcomes::Reveal(bad).encode().is_err());
    }
}
