//! Literal owned account fixtures, not evidence of historical execution.
//! No keys generated, signing, proof bypass, allocations/CPI or live mutation.
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

fn fixture(troops: u32, destroyed: bool, wear: u16) -> (Vec<AccountInfo<'static>>, wix::Gather) {
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
    let a = vec![
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
    (
        a,
        wix::Gather {
            bell: 12,
            start: 0,
            n: 1,
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
fn run(a: &[AccountInfo], x: &wix::Gather) -> R<GatherPlan> {
    let before = snapshot(a);
    let out = stage(&Pubkey::new_from_array(PROGRAM), a, x);
    assert_eq!(snapshot(a), before);
    out
}
/// Replace test fixtures, not an execution/commit API.
fn retained(a: &mut [AccountInfo<'static>], plan: &GatherPlan) {
    a[4] = ai(key(&a[4]), PROGRAM, plan.inputs.clone(), false, true);
    for (i, bytes) in &plan.bridges {
        a[*i] = ai(key(&a[*i]), PROGRAM, bytes.clone(), false, true);
    }
}

#[test]
fn real_wear_once_dep_mass_and_arrival_multiplier_and_full_repeat() {
    let wear = permutation_rules::frontier::structure::wear_bps(720);
    assert_eq!(wear, 1200);
    let (mut a, x) = fixture(80_001, false, wear);
    let first = run(&a, &x).unwrap();
    assert!(first.create_inputs);
    assert_eq!(first.bridges.len(), 1);
    let row = WideArrival::read_at(&first.inputs, 0).unwrap().unwrap();
    assert_eq!(
        row.troops,
        permutation_rules::frontier::structure::wear(80_001, wear) as u32
    );
    assert_eq!(row.dep_mass, 200_000);
    assert_eq!(row.dealt_bps, 11_000);
    assert_eq!(row.citizen, OWNER);
    assert_eq!(
        row.stamina,
        frontier_abi::clash_model::arrival_stamina(40, 10, 12)
    );
    retained(&mut a, &first);
    let second = run(&a, &x).unwrap();
    assert_eq!(first.inputs, second.inputs);
    assert!(second.bridges.is_empty());
    assert!(!second.create_inputs);
    let before = snapshot(&a);
    assert_eq!(
        execute(&Pubkey::new_from_array(PROGRAM), &a, &x).err(),
        Some(FrontierError::NotImplemented.into())
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn destroyed_origin_and_below_threshold_repeat_identically() {
    let route_wear = permutation_rules::frontier::structure::wear_bps(600);
    assert_eq!(route_wear, 1000);
    for (troops, destroyed, wear, expected) in [
        (0, true, route_wear, 0),
        (500, false, route_wear, 450),
        (500, false, 0, 500),
    ] {
        let (mut a, x) = fixture(troops, destroyed, wear);
        let first = run(&a, &x).unwrap();
        let row = WideArrival::read_at(&first.inputs, 0).unwrap().unwrap();
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
        assert_eq!(
            row.fate,
            if expected < 500 {
                wa::wide_arrival::FATE_DESTROYED
            } else {
                wa::wide_arrival::FATE_NONE
            }
        );
        retained(&mut a, &first);
        assert_eq!(run(&a, &x).unwrap().inputs, first.inputs);
        let off = wa::wide_clash_inputs::arrival(0);
        a[4].try_borrow_mut_data().unwrap()[off..off + wa::wide_arrival::SIZE].fill(0);
        assert!(run(&a, &x).is_err());
    }
}

#[test]
fn repeats_need_exact_row_mask_and_destination() {
    for change in 0..3 {
        let (mut a, x) = fixture(80_000, false, 1000);
        let first = run(&a, &x).unwrap();
        retained(&mut a, &first);
        let mut cd = a[4].try_borrow_mut_data().unwrap();
        if change == 0 {
            let mut h = WideClashInputsHdr::read(&cd).unwrap();
            h.arrivals_mask = 0;
            h.write(&mut cd).unwrap();
        } else {
            let mut row = WideArrival::read_at(&cd, 0).unwrap().unwrap();
            if change == 1 {
                row.stamina += 1;
            } else {
                row.dealt_bps += 1;
            }
            row.write_at(&mut cd, 0).unwrap();
        }
        drop(cd);
        assert!(run(&a, &x).is_err());
    }
    let (mut a, x) = fixture(80_000, false, 1000);
    let first = run(&a, &x).unwrap();
    retained(&mut a, &first);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let slot = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap()).unwrap();
    let mut common = *slot.common();
    common.dest = ProvinceKey::new(common.dest.world(), WideCoord::checked(130, 0).unwrap());
    let other = ExpeditionArrivalSlot::new(&ctx, common, 1000).unwrap();
    let b = OwnedBridgeTransit::from_bytes(&ctx, &a[10].try_borrow_data().unwrap()).unwrap();
    assert!(b.gather_worn(&ctx, &other).is_err());
}

#[test]
fn owner_marker_slot_and_season_disagreements_refuse_without_mutation() {
    for change in 0..5 {
        let (a, x) = fixture(80_000, false, 1000);
        match change {
            0 => {
                Rw(&mut a[9].try_borrow_mut_data().unwrap())
                    .set_arr(H::OWNER_CITIZEN, &[0xb2; 32])
                    .unwrap();
            }
            1 => {
                a[9].try_borrow_mut_data().unwrap()[H::transit(0) + T::SEAL_ROOT] ^= 1;
            }
            2 => {
                a[8].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::CITIZEN] ^= 1;
            }
            3 => {
                a[8].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::SEASON_ID] ^= 1;
            }
            _ => {
                Rw(&mut a[9].try_borrow_mut_data().unwrap())
                    .set_u32(H::HOST_SEQ, 0)
                    .unwrap();
            }
        }
        assert!(run(&a, &x).is_err());
    }
}

#[test]
fn actual_capture_history_original_owner_and_missing_released_semantics() {
    let (a, x) = fixture(80_000, false, 1000);
    {
        let mut hd = a[9].try_borrow_mut_data().unwrap();
        let mut w = Rw(&mut hd);
        w.set_u8(H::GEN, 2).unwrap();
        w.set_u32(H::HOST_SEQ, 0).unwrap();
        w.set_arr(H::OWNER_CITIZEN, &[0xb2; 32]).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
            .unwrap();
        w.set_u8(H2::PREV_GEN, 1).unwrap();
        w.set_u64(H2::PREV_OWNER_TAG, addr::citizen_tag(&OWNER))
            .unwrap();
    }
    let plan = run(&a, &x).unwrap();
    assert_eq!(
        WideArrival::read_at(&plan.inputs, 0)
            .unwrap()
            .unwrap()
            .citizen,
        OWNER
    );
    Rw(&mut a[9].try_borrow_mut_data().unwrap())
        .set_u8(H2::PREV_GEN, 0)
        .unwrap();
    let plan = run(&a, &x).unwrap();
    assert!(plan.bridges.is_empty());
    let row = WideArrival::read_at(&plan.inputs, 0).unwrap().unwrap();
    assert!(!row.present);
    assert_eq!(row.fate, wa::wide_arrival::FATE_NONE);
    for missing in [false, true] {
        let (mut a, x) = fixture(80_000, false, 1000);
        if missing {
            a[9] = ai(key(&a[9]), [0; 32], vec![], false, false);
        } else {
            Rw(&mut a[9].try_borrow_mut_data().unwrap())
                .set_u8(H::STATE, H::STATE_RELEASED)
                .unwrap();
        }
        let plan = run(&a, &x).unwrap();
        assert!(plan.bridges.is_empty());
        let row = WideArrival::read_at(&plan.inputs, 0).unwrap().unwrap();
        assert_eq!(row.citizen, OWNER);
        assert!(!row.present);
        assert_eq!(row.stamina, 0);
        assert_eq!(row.fate, wa::wide_arrival::FATE_NONE);
    }
}

#[test]
fn window_latch_empty_day_and_invalid_producer_state() {
    let (a, x) = fixture(80_000, false, 1000);
    prologue::set_test_clock(ANCHOR + 59, 77);
    assert!(run(&a, &x).is_err());
    prologue::set_test_clock(ANCHOR + 61, 77);
    Rw(&mut a[2].try_borrow_mut_data().unwrap())
        .set_u32(PV::RESOLVED_NEXT, 13)
        .unwrap();
    assert!(run(&a, &x).is_err());
    let (mut a, x) = fixture(80_000, false, 1000);
    a[5] = ai(key(&a[5]), [0; 32], vec![], false, false);
    let plan = run(&a, &x).unwrap();
    let h = WideClashInputsHdr::read(&plan.inputs).unwrap();
    assert_eq!(h.arrivals_mask, wa::wide_clash_inputs::ALL_GATHERED);
    assert_ne!(h.flags & wa::wide_clash_inputs::FLAG_NO_ARRIVALS, 0);
    assert!(plan.bridges.is_empty());
    let (a, x) = fixture(499, false, 0);
    assert!(run(&a, &x).is_err());
}

#[test]
fn native_variant_is_explicitly_refused_and_old_wire_is_not_reused() {
    let (mut a, x) = fixture(80_000, false, 1000);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let s = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap()).unwrap();
    let mut native = *s.common();
    native.host = WideHostRef::new(native.dest, 0, 1, 0).unwrap();
    let mut bytes = vec![0; wa::wide_arrival_slot::SIZE];
    native.write(&mut bytes).unwrap();
    a[8] = ai(key(&a[8]), PROGRAM, bytes, false, false);
    assert_eq!(
        run(&a, &x).err().unwrap(),
        FrontierError::NotImplemented.into()
    );
    a.remove(9);
    assert!(run(&a, &x).is_err());
}

#[test]
fn clock_cap_unit_arithmetic_and_real_account_producer_sentinels() {
    // Arithmetic boundary only: this is not an assertion that a 90-bell
    // route was executed. Origin Spend74 bounds post-origin stamina at46;
    // the ordinary account fixture below uses40, not an impossible120.
    assert_eq!(frontier_abi::clash_model::arrival_stamina(46, 10, 100), 120);
    let (mut a, x) = fixture(80_000, false, 1000);
    let first = run(&a, &x).unwrap();
    assert_eq!(
        WideArrival::read_at(&first.inputs, 0)
            .unwrap()
            .unwrap()
            .stamina,
        frontier_abi::clash_model::arrival_stamina(40, 10, 12)
    );
    retained(&mut a, &first);
    assert_eq!(first.inputs, run(&a, &x).unwrap().inputs);
    let mut cd = a[4].try_borrow_mut_data().unwrap();
    let mut h = WideClashInputsHdr::read(&cd).unwrap();
    h.resolver = OWNER;
    h.write(&mut cd).unwrap();
    drop(cd);
    assert!(run(&a, &x).is_err());
}

#[test]
fn claimed_refund_does_not_invalidate_first_or_repeat_combat_gather() {
    // Native ClaimDefence currently reads only v1. These v2 snapshots exercise
    // the same orthogonal claimed-bit semantics, not an assertion that the
    // existing public claim handler can already consume expedition v2.
    for claim_before_first in [false, true] {
        let (mut a, x) = fixture(80_000, false, 1000);
        let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
        if claim_before_first {
            let s = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap()).unwrap();
            let bytes = s.with_claimed(true).to_bytes(&ctx).unwrap().to_vec();
            a[8] = ai(key(&a[8]), PROGRAM, bytes, false, false);
        }
        let first = run(&a, &x).unwrap();
        retained(&mut a, &first);
        if !claim_before_first {
            let s = ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap()).unwrap();
            let bytes = s.with_claimed(true).to_bytes(&ctx).unwrap().to_vec();
            a[8] = ai(key(&a[8]), PROGRAM, bytes, false, false);
        }
        let second = run(&a, &x).unwrap();
        assert_eq!(first.inputs, second.inputs);
        assert!(second.bridges.is_empty());
        assert!(
            ExpeditionArrivalSlot::read(&ctx, &a[8].try_borrow_data().unwrap())
                .unwrap()
                .common()
                .claimed
        );
    }
}
