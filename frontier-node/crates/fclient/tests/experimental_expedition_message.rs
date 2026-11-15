#![cfg(feature = "expedition-dispatch-experimental")]
//! Fixed public inputs and unsigned Message compilation only. No keys/network.
use fclient::experimental_expedition_message::{prepare_depart, prepare_resident, Error, Target, DEPART_HEAP_FRAME, RESIDENT_HEAP_FRAME};
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
/// A Depart's budget: the same three limits and the one fixed heap frame.
fn resident_budget() -> TxBudget {
    TxBudget { heap: Some(RESIDENT_HEAP_FRAME), ..budget() }
}
fn depart_budget() -> TxBudget {
    TxBudget {
        heap: Some(DEPART_HEAP_FRAME),
        ..budget()
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
        let p = prepare_depart(&draft, target(), observed(), depart_budget(), limits()).unwrap();
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
        // limit, zero price, loaded-data limit, the Depart's one heap frame, then the dispatch
        assert_eq!(p.message().instructions.len(), 5);
        assert_eq!(p.message().instructions[4].data, p.instruction().data);
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
            let p = prepare_resident(&draft, target(), observed(), resident_budget(), limits()).unwrap();
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
            let compiled = &p.message().instructions[4];
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
            prepare_depart(&draft, t, observed(), depart_budget(), limits()),
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
            prepare_depart(&draft, t, observed(), depart_budget(), limits()),
            Err(Error::Target)
        ));
    }
    for b in [
        TxBudget {
            cu_limit: 0,
            ..depart_budget()
        },
        TxBudget {
            loaded_limit: 0,
            ..depart_budget()
        },
        TxBudget {
            cu_price: 1,
            ..depart_budget()
        },
        // the heap frame of a Depart is exactly DEPART_HEAP_FRAME: none, the default size, half, one page less,
        // one byte more or the largest u32 is not a Depart's budget
        budget(),
        TxBudget {
            heap: Some(32768),
            ..budget()
        },
        TxBudget {
            heap: Some(DEPART_HEAP_FRAME / 2),
            ..budget()
        },
        TxBudget {
            heap: Some(DEPART_HEAP_FRAME - 1024),
            ..budget()
        },
        TxBudget {
            heap: Some(DEPART_HEAP_FRAME + 1),
            ..budget()
        },
        TxBudget {
            heap: Some(u32::MAX),
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
            prepare_resident(&draft, target(), observation, resident_budget(), limits()),
            Err(Error::Preflight(_))
        ));
    }
    assert!(matches!(
        prepare_resident(
            &draft,
            target(),
            observed(),
            resident_budget(),
            Limits {
                max_locks: 2,
                max_writes: 2,
                ..limits()
            }
        ),
        Err(Error::Preflight(_))
    ));
}

/// Each supported kind carries exactly one fixed heap frame.
#[test]
fn supported_actions_carry_exactly_one_fixed_heap_frame() {
    assert_eq!(DEPART_HEAP_FRAME, 256 * 1024);
    for same_actor in [false, true] {
        let draft = departures(same_actor);
        let p = prepare_depart(&draft, target(), observed(), depart_budget(), limits()).unwrap();
        let m = p.message();
        let cb: Address = "ComputeBudget111111111111111111111111111111".parse().unwrap();
        let program_of = |i: usize| m.account_keys[usize::from(m.instructions[i].program_id_index)];
        assert_eq!(m.instructions.len(), 5, "limit, price, loaded-data limit, heap frame, dispatch");
        let mut limit = vec![2u8];
        limit.extend_from_slice(&200_000u32.to_le_bytes());
        let mut price = vec![3u8];
        price.extend_from_slice(&0u64.to_le_bytes());
        let mut loaded = vec![4u8];
        loaded.extend_from_slice(&1_000_000u32.to_le_bytes());
        let mut heap = vec![1u8];
        heap.extend_from_slice(&DEPART_HEAP_FRAME.to_le_bytes());
        for (i, want) in [limit, price, loaded, heap].into_iter().enumerate() {
            assert_eq!(program_of(i), cb, "instruction {i} is the compute budget program's");
            assert!(m.instructions[i].accounts.is_empty());
            assert_eq!(m.instructions[i].data, want, "instruction {i}");
        }
        assert_eq!(program_of(4), target().program);
        assert_eq!(m.instructions[4].data, p.instruction().data);
        assert_eq!(m.instructions.iter().filter(|ix| ix.data.first() == Some(&1) && m.account_keys[usize::from(ix.program_id_index)] == cb).count(), 1, "one heap frame");
    }
    // Residents independently enforce the same strict fixed shape and reject old no-heap budgets.
    for action in [wire::Kind::Dissolve, wire::Kind::Return] {
        let draft = residents(action, false);
        let p = prepare_resident(&draft, target(), observed(), resident_budget(), limits()).unwrap();
        assert_eq!(p.message().instructions.len(), 5);
        let heap = &p.message().instructions[3];
        let cb: Address = "ComputeBudget111111111111111111111111111111".parse().unwrap();
        assert_eq!(p.message().account_keys[usize::from(heap.program_id_index)], cb);
        assert!(heap.accounts.is_empty());
        let mut expected = vec![1];
        expected.extend_from_slice(&RESIDENT_HEAP_FRAME.to_le_bytes());
        assert_eq!(heap.data, expected);
        for value in [None, Some(32768), Some(131072), Some(262143), Some(262145), Some(u32::MAX)] {
            assert!(matches!(prepare_resident(&draft, target(), observed(), TxBudget { heap: value, ..budget() }, limits()), Err(Error::Budget)));
        }
    }
}
