//! Literal owned account fixtures, not evidence of historical execution.
//! Private writer tests use preallocated inputs: no allocation/payment CPI,
//! signing, keys, proof bypass or syscall-success overrides.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::write_header;
const PROGRAM: [u8; 32] = [0x12; 32];
const OWNER: [u8; 32] = [0xa1; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const ANCHOR: i64 = GENESIS + 7803;

fn ai(k: [u8; 32], o: [u8; 32], d: Vec<u8>, signer: bool, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(k))),
        signer,
        writable,
        Box::leak(Box::new(if d.is_empty() { 0 } else { 1_000_000_000 })),
        Box::leak(d.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(o))),
        false,
    )
}

fn fixture(
    troops: u32,
    destroyed: bool,
    wear: u16,
) -> (Vec<AccountInfo<'static>>, wix::ExpeditionGather) {
    prologue::set_test_clock(ANCHOR + 61, 77);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(addr::host_id(128, 0, 0, 1, 0).unwrap())
        .unwrap();
    let hk = resolver.holding_address(&host).unwrap();
    let dest = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
    let doctrine = of_faction_v3(0).unwrap();
    let departure_dealt =
        hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Hold), true)).unwrap();
    let arrival_dealt =
        hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Brace), true)).unwrap();
    assert_eq!(departure_dealt, 10_000);
    assert_eq!(arrival_dealt, 11_000);
    let departed = OwnedBridgeTransit::new(
        &ctx,
        0,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            TileAddress::new(host.key(), 0).unwrap(),
            10,
            12,
            GENESIS + 6000,
            200_000,
            crate::proc::host::DEPART_STAMINA,
            departure_dealt,
            [0x41; 32],
            0,
            0,
            OWNER,
        )
        .unwrap(),
        OWNER,
    )
    .unwrap();
    let min_tip = fees::min_tip_lamports(0, 0, 0);
    assert_eq!(min_tip, 2500);
    let marker = BridgeMarker::new(
        &ctx,
        departed.common(),
        min_tip,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let bridge = departed
        .settle_origin(&ctx, destroyed, Some((troops, 40, 0)))
        .unwrap();
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_i64(S::DRAND_GENESIS, GENESIS - 100).unwrap();
    w.set_u32(S::DRAND_PERIOD, 3).unwrap();
    w.set_u32(S::REVEAL_WINDOW, 60).unwrap();
    w.set_u32(S::WINDOW_NEXT, 60).unwrap();
    w.set_u32(S::SEED_MARGIN, 60).unwrap();
    let clock = SeasonClock::read(&sd).unwrap();
    assert_eq!(clock.round_time(clock.tlock_round(12)), GENESIS + 7802);
    assert!(ANCHOR >= clock.round_time(clock.tlock_round(12)));
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &OWNER).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    let mut pd = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SID,
        world: dest.world(),
        coord: dest.coord(),
        wedge: dest.coord().wedge().unwrap(),
        region: 0,
        opened_bell: 1,
        readiness: wl::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x51; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut pd)
    .unwrap();
    let mut anchor = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut anchor, K2::BellAnchor, SID));
    let mut w = Rw(&mut anchor);
    w.set_u32(BA::BELL, 12).unwrap();
    w.set_i64(BA::A, ANCHOR).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(12)).unwrap();
    w.set_u64(BA::SLOT, 76).unwrap();
    let common = WideArrivalSlot {
        season_id: SID,
        dest,
        bell: 12,
        faction: 0,
        i: 0,
        transit_slot: 0,
        host,
        citizen: OWNER,
        unit: 0,
        stance: 3,
        tile: 0,
        retreat_bps: 0,
        dealt_bps: arrival_dealt,
        dep_mass: 200_000,
        flags: 0,
        beneficiary: [0xb1; 32],
        rent_to: OWNER,
        ev_slot: 76,
        ev_price: 0,
        ev_limit: 0,
        ev_loaded: 0,
        claimed: false,
    };
    let slot = ExpeditionArrivalSlot::new(&ctx, common, wear).unwrap();
    let mut day = wa::WideArrivalDay::new(SID, dest, wa::day_of(12), OWNER);
    assert!(day.set(12));
    let mut dd = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut dd).unwrap();
    let mut a = vec![
        ai([0xd1; 32], [0; 32], vec![], true, true),
        ai(sk, PROGRAM, sd, false, false),
        ai(
            wl::province_address(&ctx, dest.coord()),
            PROGRAM,
            pd,
            false,
            false,
        ),
        ai(ctx.bell_anchor(12, 0), PROGRAM, anchor, false, false),
        ai(
            wa::clash_inputs_address(&ctx, dest, 12),
            [0; 32],
            vec![],
            false,
            true,
        ),
        ai(
            wa::arrival_day_address(&ctx, dest, wa::day_of(12)),
            PROGRAM,
            dd,
            false,
            false,
        ),
        ai(
            frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR,
            [0; 32],
            vec![0, 0, 0, 0],
            false,
            false,
        ),
        ai([0; 32], [0; 32], vec![], false, false),
        ai(
            wa::arrival_slot_address(&ctx, dest, 12, 0, 0),
            PROGRAM,
            slot.to_bytes(&ctx).unwrap().to_vec(),
            false,
            false,
        ),
        ai(hk, PROGRAM, hd, false, false),
        ai(
            wm::transit_address(&ctx, &hk, 0),
            PROGRAM,
            bridge.to_bytes().to_vec(),
            false,
            true,
        ),
    ];
    // Reachable allocated ClashInputs: an earlier Gather scanned absent
    // position1. Position0 remains unscanned, so this writer applies wear.
    let mut inputs = vec![0; wa::wide_clash_inputs::SIZE];
    let mut header = WideClashInputsHdr::new(SID, dest, 12, [0xd1; 32]);
    header.arrivals_mask = 1 << 1;
    header.ev_slot = 77;
    header.write(&mut inputs).unwrap();
    a[4] = ai(key(&a[4]), PROGRAM, inputs, false, true);
    (
        a,
        wix::ExpeditionGather {
            bell: 12,
            start: 0,
            n: 1,
        },
    )
}

fn snapshot(a: &[AccountInfo]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    a.iter()
        .map(|ai| {
            (
                ai.lamports(),
                ai.try_borrow_data().unwrap().to_vec(),
                *ai.owner,
            )
        })
        .collect()
}

#[test]
fn private_writer_commits_exact_staged_rows_bridges_and_receipt() {
    let (a, x) = fixture(
        80_001,
        false,
        permutation_rules::frontier::structure::wear_bps(720),
    );
    let p = Pubkey::new_from_array(PROGRAM);
    let before = snapshot(&a);
    let plan = prepare(&p, &a, &x).unwrap();
    assert_eq!(snapshot(&a), before);
    assert!(!plan.staged.create_inputs);
    assert_eq!(
        plan.rent_inputs,
        init::rent(wa::wide_clash_inputs::SIZE).unwrap()
    );
    assert_eq!(plan.staged.bridges.len(), 1);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let record = receipt::Record::decode(&ctx, &plan.body).unwrap();
    assert_eq!(
        record.target,
        receipt::Target::Gather {
            destination: plan.destination
        }
    );
    assert_eq!(plan.body.len(), receipt::GATHER_RECORD_LEN);
    assert_eq!(plan.body[1], receipt::KIND);
    assert_eq!(plan.body.last(), Some(&0));
    assert_eq!(record.encode(&ctx).unwrap(), plan.body);
    execute(&p, &a, &x).unwrap();
    assert_eq!(a[4].try_borrow_data().unwrap().to_vec(), plan.staged.inputs);
    assert_eq!(
        a[10].try_borrow_data().unwrap().to_vec(),
        plan.staged.bridges[0].1
    );
    for i in 0..a.len() {
        assert_eq!(a[i].lamports(), before[i].0);
        assert_eq!(*a[i].owner, before[i].2);
        if i != 4 && i != 10 {
            assert_eq!(a[i].try_borrow_data().unwrap().to_vec(), before[i].1);
        }
    }
    let row = WideArrival::read_at(&a[4].try_borrow_data().unwrap(), 0)
        .unwrap()
        .unwrap();
    assert_eq!(
        WideClashInputsHdr::read(&a[4].try_borrow_data().unwrap())
            .unwrap()
            .arrivals_mask,
        3
    );
    assert_eq!(
        row.troops,
        permutation_rules::frontier::structure::wear(80_001, 1200) as u32
    );
    assert_eq!(row.dep_mass, 200_000);
    assert_eq!(row.dealt_bps, 11_000);
    assert_eq!(row.citizen, OWNER);
}

#[test]
fn true_writes_repeat_without_second_wear_or_destroyed_stamina_drift() {
    let p = Pubkey::new_from_array(PROGRAM);
    for (troops, destroyed, expected) in [(80_000, false, 72_000), (500, false, 450), (0, true, 0)]
    {
        let (a, x) = fixture(troops, destroyed, 1000);
        execute(&p, &a, &x).unwrap();
        let once = snapshot(&a);
        let plan = prepare(&p, &a, &x).unwrap();
        assert!(plan.staged.bridges.is_empty());
        execute(&p, &a, &x).unwrap();
        assert_eq!(snapshot(&a), once);
        let row = WideArrival::read_at(&a[4].try_borrow_data().unwrap(), 0)
            .unwrap()
            .unwrap();
        assert_eq!(row.troops, expected);
        assert_eq!(row.present, expected >= 500);
        assert_eq!(
            row.stamina,
            if destroyed {
                0
            } else {
                frontier_abi::clash_model::arrival_stamina(40, 10, 12)
            }
        );
    }
}

#[test]
fn claimed_entitlement_before_and_between_true_writes_is_orthogonal() {
    let p = Pubkey::new_from_array(PROGRAM);
    for before_first in [false, true] {
        let (mut a, x) = fixture(80_000, false, 1000);
        let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
        if before_first {
            let s = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap())
                .unwrap()
                .with_claimed(true);
            a[8] = ai(
                key(&a[8]),
                PROGRAM,
                s.to_bytes(&ctx).unwrap().to_vec(),
                false,
                false,
            );
        }
        execute(&p, &a, &x).unwrap();
        let first_inputs = a[4].try_borrow_data().unwrap().to_vec();
        if !before_first {
            let s = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap())
                .unwrap()
                .with_claimed(true);
            a[8] = ai(
                key(&a[8]),
                PROGRAM,
                s.to_bytes(&ctx).unwrap().to_vec(),
                false,
                false,
            );
        }
        let before = snapshot(&a);
        execute(&p, &a, &x).unwrap();
        assert_eq!(snapshot(&a), before);
        assert_eq!(a[4].try_borrow_data().unwrap().to_vec(), first_inputs);
    }
}

#[test]
fn all_data_and_money_borrow_conflicts_refuse_before_any_byte_write() {
    let p = Pubkey::new_from_array(PROGRAM);
    for at in [0, 4, 10] {
        for kind in 0..4 {
            let (a, x) = fixture(80_000, false, 1000);
            let before = snapshot(&a);
            let result = match kind {
                0 => {
                    let _held = a[at].try_borrow_data().unwrap();
                    execute(&p, &a, &x)
                }
                1 => {
                    let _held = a[at].try_borrow_mut_data().unwrap();
                    execute(&p, &a, &x)
                }
                2 => {
                    let _held = a[at].try_borrow_lamports().unwrap();
                    execute(&p, &a, &x)
                }
                _ => {
                    let _held = a[at].try_borrow_mut_lamports().unwrap();
                    execute(&p, &a, &x)
                }
            };
            assert_eq!(
                result.err(),
                Some(solana_program::program_error::ProgramError::AccountBorrowFailed.into())
            );
            assert_eq!(snapshot(&a), before);
        }
    }
}

#[test]
fn malformed_inputs_privileges_aliases_and_unsettled_state_are_atomic_refusals() {
    let p = Pubkey::new_from_array(PROGRAM);
    for change in 0..6 {
        let (mut a, x) = fixture(80_000, false, 1000);
        match change {
            0 => {
                a[10].is_writable = false;
            }
            1 => {
                a[9].try_borrow_mut_data().unwrap()[H::transit(0) + T::SEAL_ROOT] ^= 1;
            }
            2 => {
                let bytes = a[10].try_borrow_data().unwrap().to_vec();
                a[10] = ai(key(&a[10]), [0; 32], bytes, false, true);
            }
            3 => {
                let mut data = a[4].try_borrow_mut_data().unwrap();
                let mut h = WideClashInputsHdr::read(&data).unwrap();
                h.flags |= wa::wide_clash_inputs::FLAG_RESOLVED;
                h.write(&mut data).unwrap();
            }
            4 => {
                a[4].is_writable = false;
            }
            _ => {
                let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
                let b = OwnedBridgeTransit::from_bytes(&ctx, &a[10].try_borrow_data().unwrap())
                    .unwrap();
                let mut t = b.transit();
                t.state = MarchState::Departed;
                t.troops_after = 0;
                t.stamina_after = 0;
                t.ready_bell_off = 0;
                let departed = OwnedBridgeTransit::new(&ctx, 0, t, OWNER).unwrap();
                a[10] = ai(
                    key(&a[10]),
                    PROGRAM,
                    departed.to_bytes().to_vec(),
                    false,
                    true,
                );
            }
        }
        let before = snapshot(&a);
        assert!(execute(&p, &a, &x).is_err());
        assert_eq!(snapshot(&a), before);
    }
    let (mut a, x) = fixture(80_000, false, 1000);
    a.push(a[10].clone());
    assert!(check_aliases(&a, &[0, 4, 10]).is_err());
    a.pop();
    // Distinct addresses but shared data/balance cells are also refused.
    a[0].data = a[10].data.clone();
    assert!(check_aliases(&a, &[0, 4, 10]).is_err());
    let before = snapshot(&a);
    assert!(execute(&p, &a, &x).is_err());
    assert_eq!(snapshot(&a), before);
}

#[test]
fn absent_inputs_only_prepared_never_allocated_and_insufficient_fails_before_cpi() {
    let p = Pubkey::new_from_array(PROGRAM);
    let (mut a, x) = fixture(80_000, false, 1000);
    a[4] = ai(key(&a[4]), [0; 32], vec![], false, true);
    // Zero payer funds deterministically refuses before init_with_seed.
    let before = snapshot(&a);
    assert_eq!(
        execute(&p, &a, &x).err(),
        Some(FrontierError::Insufficient.into())
    );
    assert_eq!(snapshot(&a), before);
    let rent = init::rent(wa::wide_clash_inputs::SIZE).unwrap();
    **a[0].try_borrow_mut_lamports().unwrap() = rent;
    **a[4].try_borrow_mut_lamports().unwrap() = 123;
    let before = snapshot(&a);
    let plan = prepare(&p, &a, &x).unwrap();
    assert!(plan.staged.create_inputs);
    assert_eq!(plan.rent_inputs, rent);
    assert_eq!(plan.after_balances[4], rent);
    assert_eq!(plan.after_balances[0], 123);
    assert_eq!(snapshot(&a), before);
    // Intentionally do not call execute on a funded absent-input fixture.
}
