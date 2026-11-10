#![cfg(feature = "expedition-dispatch-experimental")]
//! Fixed public inputs and unsigned Message compilation only. No keys/network.
use fclient::experimental_expedition_message::{prepare_depart, prepare_resident, Error, Target};
use fclient::original_expedition_depart_draft::Draft as Depart;
use fclient::tx::TxBudget;
use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
use fclient::wide_resident_draft::Draft as Resident;
use fclient::Address;
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::world_index::{
    expedition::AccountResolver, expedition_dispatch_ix as wire, wide_ix, ProvinceKey, WideCoord,
};

fn context() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn addr(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn target() -> Target {
    Target {
        program: addr(4),
        season: addr(5),
        program_version: wire::PROGRAM_VERSION,
    }
}
fn observed() -> BlockhashObservation {
    BlockhashObservation {
        blockhash: [24; 32],
        context_slot: 101,
        valid: true,
        block_height: 200,
        last_valid_block_height: 210,
    }
}
fn budget() -> TxBudget {
    TxBudget {
        cu_limit: 200_000,
        cu_price: 0,
        loaded_limit: 1_000_000,
        heap: None,
    }
}
fn limits() -> Limits {
    Limits {
        max_locks: 32,
        max_writes: 16,
        min_context_slot: 100,
        min_remaining_block_heights: 2,
    }
}

fn departures(same_actor: bool) -> Depart {
    let ctx = context();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    Depart::for_wallet(
        &ctx,
        host,
        host.key(),
        if same_actor { addr(8) } else { addr(7) },
        addr(8),
        0,
        20,
        3,
        [1; 32],
        [0; 264],
    )
    .unwrap()
}
fn residents(action: wire::Kind, same_actor: bool) -> Resident {
    let ctx = context();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let standing = ProvinceKey::new(
        resolver.adapter().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    match action {
        wire::Kind::Dissolve => Resident::for_wallet(
            &ctx,
            host,
            standing,
            if same_actor { addr(8) } else { addr(7) },
            addr(8),
        )
        .unwrap(),
        wire::Kind::Return => Resident::return_home(&ctx, host, standing, addr(8)).unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn departure_wraps_exact_inner_bytes_and_preserves_roles_with_unsigned_budget_message() {
    for alias in [false, true] {
        let draft = departures(alias);
        let p = prepare_depart(&draft, target(), observed(), budget(), limits()).unwrap();
        assert_eq!(
            &p.instruction().data[..4],
            &[wide_ix::TAG_DEPART, 0xff, 2, 0]
        );
        assert_eq!(p.instruction().data.len(), 373);
        assert_eq!(&p.instruction().data[4..], draft.proposed_bytes());
        assert!(wide_ix::WideCommand::decode(&p.instruction().data).is_err());
        assert_eq!(
            wire::Command::decode(&p.instruction().data).unwrap().kind(),
            wire::Kind::Depart
        );
        for (meta, role) in p.instruction().accounts.iter().zip(draft.roles()) {
            assert_eq!(
                (meta.pubkey, meta.is_signer, meta.is_writable),
                (role.address, role.signer, role.writable)
            );
        }
        assert_eq!(p.message().account_keys[0], addr(8));
        assert_eq!(
            p.expected_signers(),
            if alias {
                vec![addr(8)]
            } else {
                vec![addr(8), addr(7)]
            }
        );
        assert_eq!(p.message().instructions.len(), 4);
        assert_eq!(p.message().instructions[3].data, p.instruction().data);
        assert_eq!(p.report().shape.sigs, if alias { 1 } else { 2 });
        assert_eq!(p.report().remaining_block_heights, 10);
        assert!(!draft.admitted());
        assert!(!p.admitted());
        assert!(!p.deployment_verified());
        assert!(!p.relay_submission_available());
    }
}

#[test]
fn resident_actions_compile_separate_version_and_exact_required_signers() {
    for kind in [wire::Kind::Dissolve, wire::Kind::Return] {
        for alias in [false, true] {
            let draft = residents(kind, alias);
            let p = prepare_resident(&draft, target(), observed(), budget(), limits()).unwrap();
            assert_eq!(
                &p.instruction().data[..4],
                &[kind.tag(), 0xff, 2, kind as u8]
            );
            assert_eq!(p.instruction().data.len(), 64);
            assert_eq!(&p.instruction().data[4..], draft.proposed_bytes());
            let sigs = if kind == wire::Kind::Return || alias {
                1
            } else {
                2
            };
            assert_eq!(p.report().shape.sigs, sigs);
            assert_eq!(p.message().header.num_required_signatures as usize, sigs);
            assert_eq!(p.message().account_keys[0], addr(8));
            let compiled = &p.message().instructions[3];
            for (index, role) in compiled.accounts.iter().zip(draft.roles()) {
                assert_eq!(p.message().account_keys[*index as usize], role.address);
            }
            assert!(p.report().shape.bytes <= 1232);
            assert!(!p.admitted());
        }
    }
}

#[test]
fn old_seasons_target_substitution_and_unsupported_budgets_are_refused() {
    let draft = departures(false);
    for version in [4, 0x4004, 0x0804, 0xffff] {
        let mut t = target();
        t.program_version = version;
        assert!(matches!(
            prepare_depart(&draft, t, observed(), budget(), limits()),
            Err(Error::Version)
        ));
    }
    for t in [
        Target {
            program: addr(6),
            ..target()
        },
        Target {
            season: addr(6),
            ..target()
        },
    ] {
        assert!(matches!(
            prepare_depart(&draft, t, observed(), budget(), limits()),
            Err(Error::Target)
        ));
    }
    for b in [
        TxBudget {
            cu_limit: 0,
            ..budget()
        },
        TxBudget {
            loaded_limit: 0,
            ..budget()
        },
        TxBudget {
            cu_price: 1,
            ..budget()
        },
        TxBudget {
            heap: Some(32768),
            ..budget()
        },
    ] {
        assert!(matches!(
            prepare_depart(&draft, target(), observed(), b, limits()),
            Err(Error::Budget)
        ));
    }
}

#[test]
fn fresh_blockhash_context_and_lock_policy_are_checked_after_compilation() {
    let draft = residents(wire::Kind::Return, false);
    for observation in [
        BlockhashObservation {
            context_slot: 99,
            ..observed()
        },
        BlockhashObservation {
            valid: false,
            ..observed()
        },
        BlockhashObservation {
            block_height: 211,
            ..observed()
        },
        BlockhashObservation {
            blockhash: [0; 32],
            ..observed()
        },
    ] {
        assert!(matches!(
            prepare_resident(&draft, target(), observation, budget(), limits()),
            Err(Error::Preflight(_))
        ));
    }
    assert!(matches!(
        prepare_resident(
            &draft,
            target(),
            observed(),
            budget(),
            Limits {
                max_locks: 2,
                max_writes: 2,
                ..limits()
            }
        ),
        Err(Error::Preflight(_))
    ));
}
