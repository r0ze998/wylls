#![cfg(feature = "wide-records-experimental")]
//! Pure fixed-public-input codec/address tests. No key generation, sealing,
//! signing, transactions, network, process startup or account execution.
use fclient::{
    original_expedition_settlement_draft::{Draft, Error, Evidence, Recipients, Selection},
    Address,
};
use frontier_abi::{
    addr::AddrCtx,
    world_index::{
        arrival::{arrival_slot_address, clash_inputs_address},
        expedition::AccountResolver,
        expedition_settlement_ix::{AccountLayout, DraftCommand},
        march::transit_address,
        wide_ix::{ResidentAct, WideCommand},
        ProvinceKey, WideCoord,
    },
};
fn address(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn context() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn selection(ctx: &AddrCtx) -> Selection {
    let r = AccountResolver::for_season(ctx).unwrap();
    Selection {
        host: r
            .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap(),
        destination: ProvinceKey::new(r.adapter().world(), WideCoord::checked(129, 0).unwrap()),
        transit_slot: 2,
        arrive_bell: 144,
        faction: 2,
        arrival_position: 3,
        previous_home: None,
    }
}
fn recipients() -> Recipients {
    Recipients {
        external_rent_to: address(10),
        payer: address(11),
        slot_beneficiary: address(12),
        resolver: address(13),
        holding_rent_payer: address(14),
        settle_beneficiary: address(15),
    }
}
fn build(ctx: &AddrCtx, s: Selection, e: Evidence, r: Recipients) -> Result<Draft, Error> {
    Draft::for_member(ctx, s, e, r, [17; 32], [29; 264])
}
#[test]
fn member_roles_are_exact_public_derivations_for_both_account_counts() {
    let ctx = context();
    for previous in [false, true] {
        for archive in [false, true] {
            let mut s = selection(&ctx);
            let resolver = AccountResolver::for_season(&ctx).unwrap();
            if previous {
                s.previous_home = Some(
                    resolver
                        .legacy_host_ref(frontier_abi::addr::host_id(127, 0, 0, 1, 0).unwrap())
                        .unwrap(),
                );
            }
            let e = if archive {
                Evidence::Archive { region: 3 }
            } else {
                Evidence::Anchor { region: 3 }
            };
            let d = build(&ctx, s, e, recipients()).unwrap();
            let l = d.layout();
            let holding = resolver.holding_address(&s.host).unwrap();
            assert_eq!(
                l,
                if previous {
                    AccountLayout::Previous
                } else {
                    AccountLayout::Current
                }
            );
            assert_eq!(d.roles().len(), l.count());
            let mut keys = vec![
                ctx.season,
                holding,
                transit_address(&ctx, &holding, 2),
                resolver.province_address(s.host.key()).unwrap(),
                resolver.province_address(s.destination).unwrap(),
                clash_inputs_address(&ctx, s.destination, 144),
                arrival_slot_address(&ctx, s.destination, 144, 2, 3),
                [10; 32],
            ];
            if let Some(p) = s.previous_home {
                keys.push(resolver.holding_address(&p).unwrap());
            }
            keys.extend([
                if archive {
                    ctx.anchor_archive(3, 2)
                } else {
                    ctx.bell_anchor(144, 3)
                },
                [11; 32],
                [12; 32],
                [13; 32],
                [14; 32],
                [15; 32],
            ]);
            for (i, role) in d.roles().iter().enumerate() {
                assert_eq!(role.address.to_bytes(), keys[i]);
                assert_eq!(role.name, l.spec(i).unwrap().name);
                assert_eq!(role.signer, i == l.base() + 1);
                assert_eq!(role.writable, i != 0 && i != l.base());
            }
            assert_eq!(d.program().to_bytes(), ctx.program);
            assert_eq!(d.season().to_bytes(), ctx.season);
            assert_eq!(d.selection(), s);
        }
    }
}
#[test]
fn member_draft_cannot_claim_proof_or_public_admission() {
    let ctx = context();
    let d = build(
        &ctx,
        selection(&ctx),
        Evidence::Anchor { region: 0 },
        recipients(),
    )
    .unwrap();
    let bytes = d.proposed_bytes();
    assert_eq!(DraftCommand::decode(&bytes).unwrap(), d.command());
    assert_eq!(&bytes[..5], &[0xDC, 0xFF, 1, 13, 2]);
    assert_eq!(&bytes[5..37], &[17; 32]);
    assert_eq!(&bytes[37..], &[29; 264]);
    assert!(!d.admitted() && !d.public_dispatch_available() && !d.seal_verified());
    assert!(d.not_proven().len() >= 6);
    assert!(WideCommand::decode(&bytes).is_err());
    assert!(frontier_abi::v2::ix::tag_of(&bytes).is_err());
    let mut wrapper = [0; 306];
    let n = ResidentAct {
        generation: 2,
        inner: &bytes,
    }
    .encode_into(&mut wrapper)
    .unwrap();
    assert!(ResidentAct::decode(&wrapper[..n]).is_err());
    let zero = Draft::for_member(
        &ctx,
        selection(&ctx),
        Evidence::Anchor { region: 0 },
        recipients(),
        [0; 32],
        [0; 264],
    )
    .unwrap();
    assert!(!zero.seal_verified());
}
#[test]
fn repeated_payees_union_flags_without_inventing_owner_signatures() {
    let ctx = context();
    let mut r = recipients();
    r.external_rent_to = r.payer;
    r.slot_beneficiary = r.payer;
    r.resolver = r.payer;
    r.holding_rent_payer = r.payer;
    r.settle_beneficiary = r.payer;
    let d = build(&ctx, selection(&ctx), Evidence::Anchor { region: 0 }, r).unwrap();
    for (i, role) in d.roles().iter().enumerate() {
        assert_eq!(role.signer, i == 7 || i >= 9);
    }
    let mut r = recipients();
    r.holding_rent_payer = d.roles()[1].address;
    assert!(build(&ctx, selection(&ctx), Evidence::Anchor { region: 0 }, r).is_ok());
}
#[test]
fn member_draft_rejects_invalid_context_family_position_and_region() {
    let ctx = context();
    let s = selection(&ctx);
    let e = Evidence::Anchor { region: 0 };
    for bad in [
        AddrCtx {
            program: [0; 32],
            ..ctx
        },
        AddrCtx {
            season: [0; 32],
            ..ctx
        },
        AddrCtx {
            program: ctx.season,
            ..ctx
        },
    ] {
        assert!(build(&bad, s, e, recipients()).is_err());
    }
    let mut bad = s;
    bad.destination = s.host.key();
    assert_eq!(build(&ctx, bad, e, recipients()), Err(Error::Destination));
    let other = AddrCtx {
        season: [6; 32],
        ..ctx
    };
    let mut bad = s;
    bad.destination = selection(&other).destination;
    assert_eq!(build(&ctx, bad, e, recipients()), Err(Error::Destination));
    for bad in [
        Selection {
            transit_slot: 4,
            ..s
        },
        Selection { faction: 6, ..s },
        Selection {
            arrival_position: 4,
            ..s
        },
    ] {
        assert_eq!(build(&ctx, bad, e, recipients()), Err(Error::Position));
    }
    assert_eq!(
        build(&ctx, s, Evidence::Anchor { region: 16 }, recipients()),
        Err(Error::Region)
    );
    assert_eq!(
        build(&ctx, s, Evidence::Archive { region: 255 }, recipients()),
        Err(Error::Region)
    );
}
#[test]
fn member_draft_rejects_structural_aliases_and_invalid_payees() {
    let ctx = context();
    let s = selection(&ctx);
    let e = Evidence::Anchor { region: 0 };
    let d = build(&ctx, s, e, recipients()).unwrap();
    for i in [0, 2, 6, 8] {
        let mut r = recipients();
        r.external_rent_to = d.roles()[i].address;
        assert_eq!(build(&ctx, s, e, r), Err(Error::Alias));
    }
    for key in [Address::default(), Address::new_from_array(ctx.program)] {
        let mut r = recipients();
        r.payer = key;
        assert_eq!(build(&ctx, s, e, r), Err(Error::ZeroOrProgramRecipient));
    }
    assert_eq!(
        build(
            &ctx,
            Selection {
                previous_home: Some(s.host),
                ..s
            },
            e,
            recipients()
        ),
        Err(Error::Alias)
    );
    let foreign = selection(&AddrCtx {
        season: [6; 32],
        ..ctx
    })
    .host;
    assert_eq!(
        build(
            &ctx,
            Selection {
                previous_home: Some(foreign),
                ..s
            },
            e,
            recipients()
        ),
        Err(Error::PreviousHome)
    );
}
