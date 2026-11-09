//! Literal accounts with an original legacy roster. No WideRoster or already
//! crossed resident is constructed. Focused cases isolate combat through real
//! Host::apply_clash + settle. The nested combat_handoff case additionally runs
//! the complete legacy ResolveFromInputs instruction and checks real survivors.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};

const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const NOW: i64 = GENESIS + 6_000;

fn ai(
    address: [u8; 32],
    owner: [u8; 32],
    bytes: Vec<u8>,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        signer,
        writable,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(bytes.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

fn fixture() -> (Vec<AccountInfo<'static>>, wix::ExpeditionDepart) {
    prologue::set_test_clock(NOW, 1);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump = Pubkey::find_program_address(
        &[
            crate::addr::SEASON_PREFIX,
            &crate::addr::season_seed_id(SID),
        ],
        &p,
    )
    .1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let ck = ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET));
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_u16(S::BUCKET_RATE_PER_H, 60).unwrap();
    w.set_u16(S::BUCKET_BURST, 20).unwrap();
    let mut cd = vec![0; K2::Citizen.size()];
    assert!(write_header(&mut cd, K2::Citizen, SID));
    let mut w = Rw(&mut cd);
    w.set_arr(C::WALLET, &WALLET).unwrap();
    w.set_u8(
        C::FLAGS,
        C::FLAG_JOINED | C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL,
    )
    .unwrap();
    w.set_u32(C::BUCKET_MILLI, 20_000).unwrap();
    w.set_u32(C::TICKET_BELL, C::NO_TICKET).unwrap();
    w.set_u64(C::CITIZEN_TAG, frontier_abi::addr::citizen_tag(&ck))
        .unwrap();
    cd[C2::holding_of_slot(1)..C2::holding_of_slot(1) + 6].copy_from_slice(&[1, 0, 0, 0, 0, 1]);
    cd[C2::HOLDINGS_N] = 1;
    for slot in 2..=3 {
        cd[C2::holding_of_slot(slot) + 5] = C2::EMPTY_GEN;
    }
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let economy = cz::founded_holding(NOW, addr::day_of(10), 0).unwrap();
    write_founding(
        &mut hd,
        &Founding {
            p: 1,
            q: 0,
            site: 0,
            gen: 1,
            tile: 0,
            owner: ck,
            score: 0,
            faction: 0,
            ticket_bell: C::NO_TICKET,
            rent_payer: WALLET,
            final_ts: NOW,
            pool_owed: 0,
            shield_until: NOW,
            terrain_ore: 0,
        },
        &economy,
    )
    .unwrap();
    hd[H::STATE] = H::STATE_FINAL;
    Rw(&mut hd).set_u32(H::HOST_SEQ, 1).unwrap();
    let mut pd = vec![0; K2::Province.size()];
    assert!(write_header(&mut pd, K2::Province, SID));
    Rw(&mut pd).set_i16(PV::P, 1).unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, 10).unwrap();
    pd[PV::SITE_COUNT] = 1;
    pd[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    pd[PV::site(0) + SM::GEN] = 1;
    pd[PV::site(0) + SM::ORDER] = 1;
    pd[PV::N_ENTRIES] = 1;
    let id = frontier_abi::addr::host_id(1, 0, 0, 1, 0).unwrap();
    write_entry(
        &mut pd,
        0,
        &Entry {
            id,
            unit: 0,
            faction: 0,
            tile: 1,
            state: E::STATE_ROSTER,
            troops: 200_000,
            stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
            stamina_bell: 10,
            from_bell: 1,
            ..Entry::FREE
        },
    )
    .unwrap();
    let host = AccountResolver::for_season(&ctx)
        .unwrap()
        .legacy_host_ref(id)
        .unwrap();
    let hk = ctx.holding(1, 0, 0);
    let province = ai(ctx.province(1, 0), PROGRAM, pd, false, true);
    let a = vec![
        ai(WALLET, [0; 32], vec![], true, false),
        ai([0xd4; 32], [0; 32], vec![], true, true),
        ai(sk, PROGRAM, sd, false, false),
        ai(ck, PROGRAM, cd, false, true),
        ai(hk, PROGRAM, hd, false, true),
        province.clone(),
        ai([0; 32], [0; 32], vec![], false, false),
        province,
        ai(
            wm::transit_address(&ctx, &hk, 0),
            [0; 32],
            vec![],
            false,
            true,
        ),
    ];
    let mut seal = [0; frontier_abi::world_index::seal::WIDE_SEAL_LEN];
    seal[0] = 0x80;
    let tip = {
        let sd = a[2].try_borrow_data().unwrap();
        let r = Ro(&sd);
        fees::min_tip_lamports(
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI).unwrap(),
            r.u32(S::REVEAL_CU_LIMIT).unwrap(),
            r.u32(S::REVEAL_LOADED_LIMIT).unwrap(),
        )
    };
    // Zero priority still includes the existing 2,500-lamport base; this
    // fixture's march fee and bond are explicitly zero, not waived by code.
    assert_eq!(tip, 2_500);
    (
        a,
        wix::ExpeditionDepart {
            host: host.to_bytes(),
            transit_slot: 0,
            arrive_bell: 12,
            tip,
            commit: [0x31; 32],
            seal,
        },
    )
}

fn snapshot(a: &[AccountInfo]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    a.iter()
        .map(|a| {
            (
                a.lamports(),
                a.try_borrow_data().unwrap().to_vec(),
                *a.owner,
            )
        })
        .collect()
}

#[test]
fn legacy_departure_stages_spend_without_mutation_or_reissue() {
    let (a, x) = fixture();
    let before = snapshot(&a);
    let plan = stage_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).unwrap();
    assert_eq!(snapshot(&a), before);
    let e = read_entry(&plan.province, 0).unwrap();
    assert_eq!(e.id, frontier_abi::addr::host_id(1, 0, 0, 1, 0).unwrap());
    assert!(matches!(
        e.op,
        EntryOp::Spend {
            cost: super::super::super::host::DEPART_STAMINA
        }
    ));
    assert_eq!(e.state, E::STATE_ROSTER);
    assert_eq!(Ro(&plan.holding).u32(H::HOST_SEQ).unwrap(), 1);
    assert_eq!(e.troops, 200_000);
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge).unwrap();
    assert_eq!(bridge.original_owner(), key(&a[3]));
    assert_eq!(plan.bridge.len(), 336);
}

#[test]
fn departure_rejects_a_different_original_holding_owner() {
    let (a, x) = fixture();
    a[4].try_borrow_mut_data().unwrap()[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].fill(0x55);
    let before = snapshot(&a);
    assert_eq!(
        stage_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).err(),
        Some(FrontierError::NotOwner.into())
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn departure_refusals_preserve_all_accounts() {
    for case in 0..5 {
        let (mut a, mut x) = fixture();
        match case {
            0 => a[0].is_signer = false,
            1 => Rw(&mut a[4].try_borrow_mut_data().unwrap())
                .set_u32(H::HOST_SEQ, 0)
                .unwrap(),
            2 => x.transit_slot = 4,
            3 => a[8].is_writable = false,
            _ => x.arrive_bell = 11,
        }
        let before = snapshot(&a);
        let expected = match case {
            0 => FrontierError::Auth.into(),
            2 => FrontierError::BadData.into(),
            4 => FrontierError::ArrivalBell.into(),
            _ => BAD_ACCOUNT,
        };
        assert_eq!(
            stage_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).err(),
            Some(expected)
        );
        assert_eq!(snapshot(&a), before);
    }
}

/// Materialize staged departure only in isolated fixture memory, then supply
/// an explicit combat result to the actual Host Spend kernel. This is not a
/// program commit helper and cannot be reached by dispatch.
fn resolved_fixture(survivors: u32) -> Vec<AccountInfo<'static>> {
    let (a, x) = fixture();
    let plan = stage_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).unwrap();
    let mut pd = plan.province;
    let mut e = read_entry(&pd, 0).unwrap();
    let mut host = e.to_host().unwrap();
    host.apply_clash(
        10,
        survivors,
        permutation_rules::frontier::host::STAMINA_CAP - 10,
        true,
    )
    .unwrap();
    host.settle(11).unwrap();
    e.set_host(&host);
    e.state = E::STATE_DEPARTED;
    write_entry(&mut pd, 0, &e).unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, 11).unwrap();
    let province = ai(key(&a[5]), PROGRAM, pd, false, true);
    vec![
        a[1].clone(),
        a[2].clone(),
        province.clone(),
        ai(key(&a[4]), PROGRAM, plan.holding, false, true),
        province,
        ai(key(&a[8]), PROGRAM, plan.bridge.to_vec(), false, true),
    ]
}

#[test]
fn origin_uses_only_post_combat_survivors_and_replay_refuses() {
    let a = resolved_fixture(123_000);
    let before = snapshot(&a);
    let p = Pubkey::new_from_array(PROGRAM);
    let plan = stage_origin(&p, &a, 0).unwrap();
    assert_eq!(snapshot(&a), before);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge)
        .unwrap()
        .transit();
    assert_eq!(bridge.troops_after, 123_000);
    assert!(bridge.stamina_after < permutation_rules::frontier::host::STAMINA_CAP - 10);
    assert_eq!(bridge.flags, 0);
    assert_eq!(bridge.tip, 0);
    assert_eq!(read_entry(&plan.province, 0).unwrap(), Entry::FREE);
    assert_eq!(Ro(&plan.province).u8(PV::N_ENTRIES).unwrap(), 0);
    a[2].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&plan.province);
    a[5].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&plan.bridge);
    let committed = snapshot(&a);
    assert!(stage_origin(&p, &a, 0).is_err());
    assert_eq!(snapshot(&a), committed);
}

#[test]
fn captured_origin_preserves_current_bond_flag_and_never_credits_captor() {
    let a = resolved_fixture(123_000);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let original = OwnedBridgeTransit::from_bytes(&ctx, &a[5].try_borrow_data().unwrap())
        .unwrap()
        .original_owner();
    {
        let mut hd = a[3].try_borrow_mut_data().unwrap();
        hd[H::GEN] = 2;
        hd[frontier_abi::v2::layout::player::holding::PREV_GEN] = 1;
        Rw(&mut hd).set_u32(H::HOST_SEQ, 0).unwrap();
        hd[H::transit(0) + T::FLAGS] &= !T::FLAG_BOND_ESCROWED;
        hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].fill(0x55);
    }
    a[2].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 2;
    let before = snapshot(&a);
    let plan = stage_origin(&Pubkey::new_from_array(PROGRAM), &a, 0).unwrap();
    assert_eq!(snapshot(&a), before);
    assert_eq!(plan.bridge.len(), OWNED_BRIDGE_LEN);
    let settled = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge).unwrap();
    assert_eq!(settled.original_owner(), original);
    assert_ne!(settled.original_owner(), [0x55; 32]);
    assert_eq!(
        a[3].try_borrow_data().unwrap()[H::transit(0) + T::FLAGS],
        T::FLAG_FEE_ESCROWED
    );
}

#[test]
fn origin_rejects_ownerless_v1_without_promoting_it() {
    let mut a = resolved_fixture(123_000);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &a[5].try_borrow_data().unwrap()).unwrap();
    a[5] = ai(
        key(&a[5]),
        PROGRAM,
        bridge.common().to_bytes().to_vec(),
        false,
        true,
    );
    let before = snapshot(&a);
    assert_eq!(
        stage_origin(&Pubkey::new_from_array(PROGRAM), &a, 0).err(),
        Some(BAD_ACCOUNT)
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn origin_receipt_binds_every_original_owner_byte() {
    use frontier_abi::world_index::expedition_transport::ORIGINAL_OWNER_OFFSET;
    let a = resolved_fixture(123_000);
    let p = Pubkey::new_from_array(PROGRAM);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let base = prepare_origin(&p, &a, 0).unwrap();
    let base = receipt::Record::decode(&ctx, &base.body).unwrap();
    for offset in ORIGINAL_OWNER_OFFSET..OWNED_BRIDGE_LEN {
        // Mutate isolated prior-state bytes solely to test full manifest binding,
        // not to claim that a caller may rewrite an authenticated departure.
        a[5].try_borrow_mut_data().unwrap()[offset] ^= 1;
        let changed = prepare_origin(&p, &a, 0).unwrap();
        let changed = receipt::Record::decode(&ctx, &changed.body).unwrap();
        assert_ne!(changed.source.receipt.input, base.source.receipt.input);
        assert_ne!(changed.source.receipt.output, base.source.receipt.output);
        a[5].try_borrow_mut_data().unwrap()[offset] ^= 1;
    }
}

#[test]
fn origin_destroyed_and_refusal_snapshots() {
    let p = Pubkey::new_from_array(PROGRAM);
    let a = resolved_fixture(0);
    let before = snapshot(&a);
    let plan = stage_origin(&p, &a, 0).unwrap();
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let t = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge)
        .unwrap()
        .transit();
    assert_eq!(t.state, MarchState::DestroyedAtOrigin);
    assert_eq!((t.troops_after, t.stamina_after), (0, 0));
    assert_eq!(snapshot(&a), before);
    for case in 0..5 {
        let mut a = resolved_fixture(123_000);
        match case {
            0 => Rw(&mut a[2].try_borrow_mut_data().unwrap())
                .set_u32(PV::RESOLVED_NEXT, 10)
                .unwrap(),
            1 => a[5].is_writable = false,
            2 => a[3].try_borrow_mut_data().unwrap()[H::transit(0) + T::RSV_93] = 7,
            3 => Rw(&mut a[3].try_borrow_mut_data().unwrap())
                .set_u32(H::HOST_SEQ, 0)
                .unwrap(),
            _ => a[2].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 2,
        }
        let before = snapshot(&a);
        assert!(stage_origin(&p, &a, 0).is_err());
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn staged_departure_receipt_binds_original_chains_and_prefunded_rent() {
    let (a, x) = fixture();
    let before = snapshot(&a);
    let plan = prepare_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).unwrap();
    assert_eq!(snapshot(&a), before);
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let record = receipt::Record::decode(&ctx, &plan.body).unwrap();
    assert_eq!(record.source.receipt.action, receipt::Action::Depart);
    assert_eq!(record.links.len(), 3);
    for (link, i) in record.links.iter().zip([3, 4, 5]) {
        let (seq, head) = crate::layout::chain_of(&plan.after[i].data).unwrap();
        assert_eq!((seq, head), (link.seq, link.head));
    }
    // External address was prefunded; only tip escrow leaves the payer.
    assert_eq!(plan.after[1].lamports, before[1].0 - x.tip);
    assert_eq!(plan.after[8].lamports, before[8].0);
    assert_eq!(plan.after[5].data, plan.after[7].data);
    let t = OwnedBridgeTransit::from_bytes(&ctx, &plan.after[8].data)
        .unwrap()
        .transit();
    assert_eq!(t.rent_to, key(&a[1]));
    assert_eq!(t.troops_after, 0);
}

#[test]
fn private_origin_commit_is_atomic_and_replay_cannot_retransfer() {
    let a = resolved_fixture(123_000);
    let p = Pubkey::new_from_array(PROGRAM);
    let before = snapshot(&a);
    let plan = prepare_origin(&p, &a, 0).unwrap();
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let record = receipt::Record::decode(&ctx, &plan.body).unwrap();
    assert_eq!(record.links.len(), 2);
    execute_origin(&p, &a, 0).unwrap();
    for i in [2, 3, 5] {
        assert_eq!(a[i].try_borrow_data().unwrap().to_vec(), plan.after[i].data);
    }
    assert_eq!(
        &a[3].try_borrow_data().unwrap()[H::transit(0)..H::transit(0) + MARKER_LEN],
        &before[3].1[H::transit(0)..H::transit(0) + MARKER_LEN]
    );
    assert_eq!(
        a.iter().map(|a| a.lamports()).collect::<Vec<_>>(),
        before.iter().map(|a| a.0).collect::<Vec<_>>()
    );
    let after = snapshot(&a);
    assert!(execute_origin(&p, &a, 0).is_err());
    assert_eq!(snapshot(&a), after);
}

#[test]
fn chain_overflow_and_borrow_conflict_precede_origin_writes() {
    let p = Pubkey::new_from_array(PROGRAM);
    let a = resolved_fixture(123_000);
    crate::layout::set_chain(
        &mut a[3].try_borrow_mut_data().unwrap(),
        u64::MAX,
        &[0x41; 32],
    )
    .unwrap();
    let before = snapshot(&a);
    assert!(execute_origin(&p, &a, 0).is_err());
    assert_eq!(snapshot(&a), before);
    let a = resolved_fixture(123_000);
    let before = snapshot(&a);
    let held = a[5].try_borrow_data().unwrap();
    assert!(execute_origin(&p, &a, 0).is_err());
    drop(held);
    assert_eq!(snapshot(&a), before);
}

#[test]
fn public_commands_remain_closed_before_any_effect() {
    assert!(!EXPEDITION_ENABLED);
    let p = Pubkey::new_from_array(PROGRAM);
    let (a, x) = fixture();
    let before = snapshot(&a);
    assert_eq!(
        super::super::dispatch(&p, &a, &x.to_bytes()),
        Err(FrontierError::NotImplemented.into())
    );
    assert_eq!(snapshot(&a), before);
    let a = resolved_fixture(123_000);
    let before = snapshot(&a);
    let x = wix::ExpeditionSettleOrigin { transit_slot: 0 };
    assert_eq!(
        super::super::dispatch(&p, &a, &x.to_bytes()),
        Err(FrontierError::NotImplemented.into())
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn prefunded_departure_accepts_exact_escrow_balance() {
    let (a, x) = fixture();
    **a[1].try_borrow_mut_lamports().unwrap() = x.tip;
    let before = snapshot(&a);
    let plan = prepare_depart(&Pubkey::new_from_array(PROGRAM), &a, &x, &Auth::Wallet).unwrap();
    assert_eq!(plan.after[1].lamports, 0);
    assert_eq!(snapshot(&a), before);
}

#[test]
fn departure_borrow_refusals_happen_before_any_cpi() {
    let p = Pubkey::new_from_array(PROGRAM);
    for i in [3, 4, 5, 8] {
        let (a, x) = fixture();
        let before = snapshot(&a);
        let held = a[i].try_borrow_data().unwrap();
        // All semantic/receipt checks pass, then simultaneous mutable preflight
        // fails before the first System transfer/allocation instruction.
        assert_eq!(
            execute_depart(&p, &a, &x, &Auth::Wallet),
            Err(solana_program::program_error::ProgramError::AccountBorrowFailed.into())
        );
        drop(held);
        assert_eq!(snapshot(&a), before);
    }
    for i in [1, 4, 8] {
        let (a, x) = fixture();
        let before = snapshot(&a);
        let held = a[i].try_borrow_lamports().unwrap();
        assert_eq!(
            execute_depart(&p, &a, &x, &Auth::Wallet),
            Err(solana_program::program_error::ProgramError::AccountBorrowFailed.into())
        );
        drop(held);
        assert_eq!(snapshot(&a), before);
    }
}

#[path = "wide_expedition_combat_tests.rs"]
mod combat_handoff;
