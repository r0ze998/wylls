//! Static-only prospective tests. Literal public identities, public PDA/hash,
//! account snapshots and integer/entry kernels only. No execution requested.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot;

fn fixture(ctx: &AddrCtx) -> (BridgeMarker, OwnedBridgeTransit, Vec<u8>) {
    let resolver = AccountResolver::for_season(ctx).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 2, 1, 0).unwrap())
        .unwrap();
    let t = WideTransit::depart(
        wm::HOST_IDENTITY_FULL_REF_V1,
        host,
        1,
        2,
        TileAddress::new(host.key(), 3).unwrap(),
        10,
        12,
        1_800_006_000,
        100_000,
        super::super::super::host::DEPART_STAMINA,
        250,
        [21; 32],
        0,
        0,
        [22; 32],
    )
    .unwrap();
    let bridge = OwnedBridgeTransit::new(ctx, 2, t, [33; 32]).unwrap();
    let marker = BridgeMarker::new(
        ctx,
        bridge.common(),
        7,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, 11));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::SITE, 2).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_u8(H::ORDER, 1).unwrap();
    w.set_u8(H::FACTION, 2).unwrap();
    w.set_u8(H::TILE, 3).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &[33; 32]).unwrap();
    w.set_arr(H::RENT_PAYER, &[22; 32]).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    w.set_u64(H::ESCROW, 37).unwrap();
    let off = H::transit(2);
    hd[off..off + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    (marker, bridge, hd)
}

fn ctx() -> AddrCtx {
    AddrCtx {
        season: [11; 32],
        program: [12; 32],
    }
}

fn arrival_fixture(
    ctx: &AddrCtx,
    bridge: &OwnedBridgeTransit,
    dest: ProvinceKey,
) -> ExpeditionArrivalSlot {
    let t = bridge.transit();
    ExpeditionArrivalSlot::new(
        ctx,
        WideArrivalSlot {
            season_id: 11,
            dest,
            bell: t.arrive_bell,
            faction: t.faction,
            i: 0,
            transit_slot: bridge.slot(),
            host: t.host,
            citizen: bridge.original_owner(),
            unit: t.unit,
            stance: 0,
            tile: 3,
            retreat_bps: 0,
            dealt_bps: 250,
            dep_mass: t.dep_mass,
            flags: 0,
            beneficiary: [36; 32],
            rent_to: [22; 32],
            ev_slot: 1,
            ev_price: 0,
            ev_limit: 0,
            ev_loaded: 0,
            claimed: false,
        },
        100,
    )
    .unwrap()
}

// The fields observed by return/capture follow OpenProvince's pending
// sentinels and a live, already settled original site. No terrain generation
// or source combat is claimed by this focused account fixture.
fn home_fixture() -> Vec<u8> {
    let mut pd = vec![0; K2::Province.size()];
    assert!(write_header(&mut pd, K2::Province, 11));
    let mut w = Rw(&mut pd);
    w.set_i16(PV::P, 128).unwrap();
    w.set_u16(PV::RING, 128).unwrap();
    w.set_u32(PV::RESOLVED_NEXT, 21).unwrap();
    w.set_u32(PV2::SCORE_NEXT_BELL, 21).unwrap();
    w.set_u8(PV::SITE_COUNT, 3).unwrap();
    w.set_u8(PV::N_SITES_USED, 1).unwrap();
    w.set_u8(PV::SITES, 0).unwrap();
    w.set_u8(PV::SITES + 1, 1).unwrap();
    w.set_u8(PV::SITES + 2, 3).unwrap();
    for i in 0..PV::SITES_N {
        let o = PV::site(i);
        w.set_u8(o + SM::FACTION, permutation_rules::frontier::clash::NEUTRAL)
            .unwrap();
        w.set_u32(o + SM::PEND0_BELL, SM::NO_BELL).unwrap();
        w.set_u32(o + SM::PEND1_BELL, SM::NO_BELL).unwrap();
    }
    let o = PV::site(2);
    w.set_u8(o + SM::STATE, SM::STATE_HOLDING).unwrap();
    w.set_u8(o + SM::FACTION, 2).unwrap();
    w.set_u8(o + SM::GEN, 1).unwrap();
    w.set_u8(o + SM::ORDER, 1).unwrap();
    pd
}

fn resident_entry(i: usize, faction: u8, state: u8) -> Entry {
    let id = frontier_abi::addr::host_id(120 + faction as i32, 0, 0, 1, i as u32 + 1).unwrap();
    Entry {
        id,
        faction,
        unit: 1,
        tile: i as u8,
        state,
        troops: 100_000,
        stamina_value: 40,
        stamina_bell: 20,
        ready_bell: 20,
        from_bell: 1,
        ..Entry::FREE
    }
}

#[test]
fn generation_history_is_single_and_never_inferred() {
    let (_, bridge, mut hd) = fixture(&ctx());
    let t = bridge.transit();
    assert!(!previous_generation(&hd, &t).unwrap());
    Rw(&mut hd).set_u32(H::HOST_SEQ, 0).unwrap();
    assert!(previous_generation(&hd, &t).is_err());
    Rw(&mut hd).set_u8(H::GEN, 2).unwrap();
    assert!(previous_generation(&hd, &t).is_err());
    Rw(&mut hd)
        .set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
        .unwrap();
    Rw(&mut hd).set_u8(H2::PREV_GEN, 1).unwrap();
    assert!(previous_generation(&hd, &t).unwrap());
    Rw(&mut hd).set_u8(H2::PREV_GEN, 0).unwrap();
    assert!(previous_generation(&hd, &t).is_err());
}

#[test]
fn original_id_returns_once_as_legacy_muster_pending() {
    let (_, bridge, mut hd) = fixture(&ctx());
    let t = bridge.transit();
    let id = AccountResolver::for_season(&ctx())
        .unwrap()
        .legacy_host_id(&t.host)
        .unwrap();
    let mut pd = home_fixture();
    assert_eq!(
        stage_legacy_home(&mut pd, &mut hd, &t, id, 12_345, 40, 12, 20).unwrap(),
        12_345
    );
    let e = frontier_abi::entry::read_entry(&pd, 0).unwrap();
    assert_eq!(
        (e.id, e.state, e.troops, e.from_bell),
        (id, E::STATE_MUSTER_PENDING, 12_345, 21)
    );
    let before = (pd.clone(), hd.clone());
    assert!(stage_legacy_home(&mut pd, &mut hd, &t, id, 12_345, 40, 12, 20).is_err());
    assert_eq!((pd, hd), before);
}

#[test]
fn full_faction_returns_whole_units_to_original_reserve() {
    let (_, bridge, mut hd) = fixture(&ctx());
    let t = bridge.transit();
    let id = AccountResolver::for_season(&ctx())
        .unwrap()
        .legacy_host_id(&t.host)
        .unwrap();
    let mut pd = home_fixture();
    for i in 0..PV::FACTION_CAP {
        write_entry(&mut pd, i, &resident_entry(i, t.faction, E::STATE_ROSTER)).unwrap();
    }
    Rw(&mut pd)
        .set_u8(PV::N_ENTRIES, PV::FACTION_CAP as u8)
        .unwrap();
    Rw(&mut hd)
        .set_u32(H::HOST_SEQ, PV::FACTION_CAP as u32 + 1)
        .unwrap();
    let before = pd.clone();
    assert_eq!(
        stage_legacy_home(&mut pd, &mut hd, &t, id, 12_345, 40, 12, 20).unwrap(),
        12_000
    );
    assert_eq!(pd, before);
    assert_eq!(Ro(&hd).u32(H::reserve(1)).unwrap(), 12);
    Rw(&mut hd).set_u32(H::reserve(1), u32::MAX).unwrap();
    let before = hd.clone();
    assert!(reserve_credit(&mut hd, 1, 1000).is_err());
    assert_eq!(hd, before);
}

#[test]
fn capture_cleared_bond_is_not_reintroduced_by_external() {
    let (marker, bridge, _) = fixture(&ctx());
    let settled = bridge
        .settle_origin(&ctx(), false, Some((80_000, 40, 0)))
        .unwrap();
    let after_capture = marker.capture_bond_plan(37, 20).unwrap();
    let holding = AccountResolver::for_season(&ctx())
        .unwrap()
        .holding_address(&settled.transit().host)
        .unwrap();
    let ext = wm::transit_address(&ctx(), &holding, 2);
    let input = authenticate_pair(
        &ctx(),
        &holding,
        2,
        &ext,
        &after_capture.marker_after,
        settled.common(),
    )
    .unwrap()
    .financial_input(10, 20)
    .unwrap();
    assert_eq!(
        (input.transit.tip, input.fee, input.bond, input.total),
        (7, 10, 0, 17)
    );
    assert_eq!(settled.transit().tip, 0);
    assert_eq!(settled.transit().rent_to, [22; 32]);
}

fn account(address: [u8; 32], owner: [u8; 32], data: Vec<u8>) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        false,
        false,
        Box::leak(Box::new(1_000_000)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

fn terminal_fixture() -> Vec<AccountInfo<'static>> {
    const PROGRAM: [u8; 32] = [12; 32];
    let p = Pubkey::new_from_array(PROGRAM);
    let bump = Pubkey::find_program_address(
        &[crate::addr::SEASON_PREFIX, &crate::addr::season_seed_id(11)],
        &p,
    )
    .1;
    let sk = addr::season_pda(11, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, 11));
    let mut w = Rw(&mut sd);
    w.set_u8(S::STATUS, S::STATUS_ABORTED).unwrap();
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, 1_800_000_000).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    prologue::set_test_clock(1_800_006_000, 1);
    let (_, bridge, hd) = fixture(&ctx);
    let holding = AccountResolver::for_season(&ctx)
        .unwrap()
        .holding_address(&bridge.transit().host)
        .unwrap();
    vec![
        account(sk, PROGRAM, sd),
        account(holding, PROGRAM, hd),
        account(
            wm::transit_address(&ctx, &holding, 2),
            PROGRAM,
            bridge.to_bytes().to_vec(),
        ),
        account([22; 32], [0; 32], vec![]),
    ]
}

#[test]
fn aborted_cleanup_clears_matching_marker_but_never_escrow() {
    let a = terminal_fixture();
    let before: Vec<_> = a
        .iter()
        .map(|a| (a.lamports(), a.try_borrow_data().unwrap().to_vec()))
        .collect();
    let plan = stage_terminal(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    let hd = plan.holding_marker_clear.unwrap();
    assert_eq!(Ro(&hd).u64(H::ESCROW).unwrap(), 37);
    assert!(hd[H::transit(2)..H::transit(2) + MARKER_LEN]
        .iter()
        .all(|b| *b == 0));
    assert_eq!((plan.rent, plan.rent_to), (1_000_000, [22; 32]));
    let after: Vec<_> = a
        .iter()
        .map(|a| (a.lamports(), a.try_borrow_data().unwrap().to_vec()))
        .collect();
    assert_eq!(after, before);
    assert!(stage_terminal(&Pubkey::new_from_array([12; 32]), &a, 1).is_err());
    let mut cleared = a.clone();
    cleared[1] = account(key(&a[1]), [12; 32], hd);
    assert!(stage_terminal(&Pubkey::new_from_array([12; 32]), &cleared, 2).is_err());
}

#[test]
fn terminal_cleanup_after_holding_close_is_rent_only() {
    let mut a = terminal_fixture();
    a[1] = account(key(&a[1]), [0; 32], vec![]);
    let plan = stage_terminal(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    assert!(plan.holding_marker_clear.is_none());
    assert_eq!(plan.rent_to, [22; 32]);
    let old = a[3].clone();
    a[3] = account([23; 32], [0; 32], vec![]);
    assert!(stage_terminal(&Pubkey::new_from_array([12; 32]), &a, 2).is_err());
    a[3] = old;
    a[2] = account(key(&a[2]), [0; 32], vec![]);
    assert!(stage_terminal(&Pubkey::new_from_array([12; 32]), &a, 2).is_err());
}

fn resolved_fixture() -> Vec<AccountInfo<'static>> {
    let mut a = terminal_fixture();
    prologue::set_test_clock(1_800_012_600, 1);
    Rw(&mut a[0].try_borrow_mut_data().unwrap())
        .set_u8(S::STATUS, S::STATUS_RUNNING)
        .unwrap();
    Rw(&mut a[0].try_borrow_mut_data().unwrap())
        .set_u64(S::MARCH_FEE, 10)
        .unwrap();
    Rw(&mut a[0].try_borrow_mut_data().unwrap())
        .set_u64(S::SEAL_BOND, 20)
        .unwrap();
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let (_, bridge, _) = fixture(&ctx);
    let dkey = ProvinceKey::new(
        bridge.transit().host.key().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let arrival = arrival_fixture(&ctx, &bridge, dkey);
    let bridge = bridge
        .settle_origin(&ctx, false, Some((80_000, 40, 0)))
        .unwrap()
        .gather_worn(&ctx, &arrival)
        .unwrap();
    a[2] = account(key(&a[2]), [12; 32], bridge.to_bytes().to_vec());
    let home = home_fixture();
    let mut dest = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: 11,
        world: dkey.world(),
        coord: dkey.coord(),
        wedge: dkey.coord().wedge().unwrap(),
        region: 0,
        opened_bell: 0,
        readiness: wl::readiness::REQUIRED,
        seed_round: 0,
        ring_seed: [44; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut dest)
    .unwrap();
    Rw(&mut dest).set_u32(PV::RESOLVED_NEXT, 13).unwrap();
    Rw(&mut dest).set_u32(PV2::SCORE_NEXT_BELL, 13).unwrap();
    for i in 0..PV::SITES_N {
        Rw(&mut dest)
            .set_u32(PV::site(i) + SM::PEND0_BELL, SM::NO_BELL)
            .unwrap();
        Rw(&mut dest)
            .set_u32(PV::site(i) + SM::PEND1_BELL, SM::NO_BELL)
            .unwrap();
    }
    let mut inputs = vec![0; wa::wide_clash_inputs::SIZE];
    let mut ih = WideClashInputsHdr::new(11, dkey, 12, [31; 32]);
    ih.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
    ih.n_present = 1;
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    ih.resolver = [35; 32];
    ih.resolved_ts = 12_600;
    ih.write(&mut inputs).unwrap();
    let t = bridge.transit();
    WideArrival {
        host: t.host,
        citizen: [33; 32],
        dep_mass: t.dep_mass,
        troops: t.troops_after,
        stamina: frontier_abi::clash_model::arrival_stamina(
            t.stamina_after,
            t.depart_bell,
            t.arrive_bell,
        ),
        retreat_bps: 0,
        dealt_bps: 250,
        faction: t.faction,
        unit: t.unit,
        tile: 3,
        stance: 0,
        present: true,
        fate: wa::wide_arrival::FATE_BOUNCED,
        troops_after: 12_345,
    }
    .write_at(&mut inputs, wa::wide_clash_inputs::position(t.faction, 0))
    .unwrap();
    vec![
        a[0].clone(),
        a[1].clone(),
        a[2].clone(),
        account(ctx.province(128, 0), [12; 32], home),
        account(resolver.province_address(dkey).unwrap(), [12; 32], dest),
        account(wa::clash_inputs_address(&ctx, dkey, 12), [12; 32], inputs),
        account(
            wa::arrival_slot_address(&ctx, dkey, 12, t.faction, 0),
            [12; 32],
            arrival.to_bytes(&ctx).unwrap().to_vec(),
        ),
        a[3].clone(),
    ]
}

#[test]
fn resolved_runtime_accounts_yield_only_a_read_only_candidate() {
    let a = resolved_fixture();
    let before: Vec<_> = a
        .iter()
        .map(|a| (a.lamports(), a.try_borrow_data().unwrap().to_vec()))
        .collect();
    let plan = stage_resolved_return(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    assert_eq!(plan.payments_if_valid.total, 37);
    assert_eq!(plan.payments_if_valid.tip.1, PayTo::SlotBeneficiary);
    assert!(matches!(
        plan.retained_slot,
        Some(ArrivalSlot::Expedition(_))
    ));
    assert_eq!(plan.retained_slot.unwrap().worn_bps(), 100);
    assert_eq!(plan.credited_milli, 12_345);
    assert!(plan.home.is_some());
    let returned = frontier_abi::entry::read_entry(plan.home.as_ref().unwrap(), 0).unwrap();
    assert_eq!((returned.stamina_value, returned.stamina_bell), (41, 12));
    assert!(plan.previous_home.is_none());
    assert_eq!(Ro(&plan.holding).u64(H::ESCROW).unwrap(), 0);
    assert_eq!(plan.external_rent_to, [22; 32]);
    let after: Vec<_> = a
        .iter()
        .map(|a| (a.lamports(), a.try_borrow_data().unwrap().to_vec()))
        .collect();
    assert_eq!(after, before);
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let mut ci = a[5].try_borrow_mut_data().unwrap();
    let mut ih = WideClashInputsHdr::read(&ci).unwrap();
    ih.settled_mask |= 1 << plan.arrival_position;
    ih.write(&mut ci).unwrap();
    drop(ci);
    assert!(stage_resolved_return(&Pubkey::new_from_array(ctx.program), &a, 2).is_err());
}

#[test]
fn captured_return_goes_only_to_live_previous_home() {
    let mut a = resolved_fixture();
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let prev_id = frontier_abi::addr::host_id(127, 0, 0, 3, 0).unwrap();
    {
        let mut hd = a[1].try_borrow_mut_data().unwrap();
        let off = H::transit(2);
        let marker = BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).unwrap();
        let capture = marker
            .capture_bond_plan(Ro(&hd).u64(H::ESCROW).unwrap(), 20)
            .unwrap();
        assert_eq!(capture.refund, 20);
        hd[off..off + MARKER_LEN].copy_from_slice(&capture.marker_after.to_bytes());
        let mut w = Rw(&mut hd);
        w.set_u64(H::ESCROW, capture.escrow_after).unwrap();
        w.set_u8(H::GEN, 2).unwrap();
        w.set_u8(H2::PREV_GEN, 1).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
            .unwrap();
        w.set_u64(
            H2::PREV_OWNER_TAG,
            frontier_abi::addr::citizen_tag(&[33; 32]),
        )
        .unwrap();
        w.set_u64(H2::PREV_HOME, prev_id).unwrap();
        w.set_arr(H::OWNER_CITIZEN, &[99; 32]).unwrap();
        w.set_u32(H::HOST_SEQ, 0).unwrap();
    }
    Rw(&mut a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::GEN, 2)
        .unwrap();
    let mut ph = vec![0; K2::Holding.size()];
    assert!(write_header(&mut ph, K2::Holding, 11));
    Rw(&mut ph).set_i16(H::P, 127).unwrap();
    Rw(&mut ph).set_u8(H::GEN, 3).unwrap();
    Rw(&mut ph).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    a.push(account(ctx.holding(127, 0, 0), [12; 32], ph));
    let plan = stage_resolved_return(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    assert!(plan.home.is_none());
    assert_eq!(plan.payments_if_valid.bond.0, 0);
    assert_eq!(plan.payments_if_valid.total, 17);
    assert_eq!(plan.credited_milli, 12_000);
    assert_eq!(Ro(&plan.holding).u32(H::reserve(1)).unwrap(), 0);
    assert_eq!(
        Ro(plan.previous_home.as_ref().unwrap())
            .u32(H::reserve(1))
            .unwrap(),
        12
    );
    Rw(&mut a[8].try_borrow_mut_data().unwrap())
        .set_u8(H::GEN, 4)
        .unwrap();
    let plan = stage_resolved_return(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    assert!(plan.previous_home.is_none());
    assert_eq!(plan.credited_milli, 0);
    a[8] = account(ctx.holding(127, 0, 0), [0; 32], vec![]);
    let plan = stage_resolved_return(&Pubkey::new_from_array([12; 32]), &a, 2).unwrap();
    assert!(plan.previous_home.is_none());
    assert_eq!(plan.credited_milli, 0);
    a.pop();
    assert!(stage_resolved_return(&Pubkey::new_from_array([12; 32]), &a, 2).is_err());
}

#[test]
fn capture_lock_blocks_live_issuer_but_released_current_still_returns() {
    let a = resolved_fixture();
    let p = Pubkey::new_from_array([12; 32]);
    Rw(&mut a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::GEN, 2)
        .unwrap();
    let before = a[1].try_borrow_data().unwrap().to_vec();
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    assert_eq!(a[1].try_borrow_data().unwrap().to_vec(), before);
    // Released holdings retain their generation and issuance history. The
    // mirror's subsequent state must not turn legacy returns into a capture.
    Rw(&mut a[1].try_borrow_mut_data().unwrap())
        .set_u8(H::STATE, H::STATE_RELEASED)
        .unwrap();
    Rw(&mut a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::STATE, SM::STATE_RELEASED_FREE)
        .unwrap();
    let plan = stage_resolved_return(&p, &a, 2).unwrap();
    assert!(plan.home.is_some());
    assert!(plan.previous_home.is_none());
    assert_eq!(plan.credited_milli, 12_345);
}

#[test]
fn full_roster_and_full_storage_preserve_all_entries_and_use_reserve() {
    let (_, bridge, hd) = fixture(&ctx());
    let t = bridge.transit();
    let id = AccountResolver::for_season(&ctx())
        .unwrap()
        .legacy_host_id(&t.host)
        .unwrap();
    // Forty-eight actual residents, eight per faction, at distinct tiles.
    // Then eight departed entries fill the 56-entry storage without counting
    // as residents. These are storage snapshots, not source-resolution tests.
    for count in [PV::ROSTER_CAP, PV::ENTRIES_N] {
        let mut hd = hd.clone();
        let mut pd = home_fixture();
        for i in 0..count {
            let state = if i < PV::ROSTER_CAP {
                E::STATE_ROSTER
            } else {
                E::STATE_DEPARTED
            };
            write_entry(&mut pd, i, &resident_entry(i, (i % 6) as u8, state)).unwrap();
        }
        Rw(&mut pd).set_u8(PV::N_ENTRIES, count as u8).unwrap();
        let before = pd.clone();
        assert_eq!(
            stage_legacy_home(&mut pd, &mut hd, &t, id, 12_345, 40, 12, 20).unwrap(),
            12_000
        );
        assert_eq!(pd, before);
        assert_eq!(Ro(&hd).u32(H::reserve(1)).unwrap(), 12);
    }
}

#[test]
fn terminal_ended_grace_and_closed_tombstone_follow_existing_deadline() {
    let mut a = terminal_fixture();
    let p = Pubkey::new_from_array([12; 32]);
    Rw(&mut a[0].try_borrow_mut_data().unwrap())
        .set_u8(S::STATUS, S::STATUS_ENDED)
        .unwrap();
    let deadline = 1_800_000_000 + 1000 * 600 + crate::proc::map::END_GRACE_SECS;
    prologue::set_test_clock(deadline - 1, 1);
    assert!(stage_terminal(&p, &a, 2).is_err());
    prologue::set_test_clock(deadline, 1);
    assert_eq!(stage_terminal(&p, &a, 2).unwrap().rent_to, [22; 32]);
    // CloseSeason's last part retains its prefix and marks Closed before
    // shrinking to TOMBSTONE_SIZE. Do not execute the real closing handler.
    let mut sd = a[0].try_borrow_data().unwrap()[..S::TOMBSTONE_SIZE].to_vec();
    Rw(&mut sd).set_u8(S::STATUS, S::STATUS_CLOSED).unwrap();
    a[0] = account(key(&a[0]), [12; 32], sd);
    assert_eq!(stage_terminal(&p, &a, 2).unwrap().rent_to, [22; 32]);
    a[1] = account(key(&a[1]), [0; 32], vec![]);
    assert!(stage_terminal(&p, &a, 2)
        .unwrap()
        .holding_marker_clear
        .is_none());
}

#[test]
fn original_owner_is_full_identity_not_mutable_holding_or_history_tag() {
    let mut a = resolved_fixture();
    let p = Pubkey::new_from_array([12; 32]);
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let mut cd = a[5].try_borrow_mut_data().unwrap();
    let position = wa::wide_clash_inputs::position(2, 0);
    let mut rec = WideArrival::read_at(&cd, position).unwrap().unwrap();
    rec.citizen = [99; 32];
    rec.write_at(&mut cd, position).unwrap();
    drop(cd);
    Rw(&mut a[1].try_borrow_mut_data().unwrap())
        .set_arr(H::OWNER_CITIZEN, &[99; 32])
        .unwrap();
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    // Even matching the sole previous-owner tag to substituted final-set
    // evidence cannot override the immutable full departure identity.
    {
        let mut hd = a[1].try_borrow_mut_data().unwrap();
        let mut w = Rw(&mut hd);
        w.set_u8(H::GEN, 2).unwrap();
        w.set_u8(H2::PREV_GEN, 1).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
            .unwrap();
        w.set_u64(
            H2::PREV_OWNER_TAG,
            frontier_abi::addr::citizen_tag(&[99; 32]),
        )
        .unwrap();
        w.set_u64(
            H2::PREV_HOME,
            frontier_abi::addr::host_id(127, 0, 0, 3, 0).unwrap(),
        )
        .unwrap();
    }
    Rw(&mut a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::GEN, 2)
        .unwrap();
    a.push(account(ctx.holding(127, 0, 0), [0; 32], vec![]));
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    a.pop();
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &a[2].try_borrow_data().unwrap()).unwrap();
    assert_eq!(bridge.original_owner(), [33; 32]);
    // Restore current generation so the refusal below reaches slot-owner
    // binding rather than stopping at the required previous-home account.
    Rw(&mut a[1].try_borrow_mut_data().unwrap())
        .set_u8(H::GEN, 1)
        .unwrap();
    Rw(&mut a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::GEN, 1)
        .unwrap();
    Rw(&mut a[1].try_borrow_mut_data().unwrap())
        .set_arr(H::OWNER_CITIZEN, &[33; 32])
        .unwrap();
    let mut cd = a[5].try_borrow_mut_data().unwrap();
    rec.citizen = [33; 32];
    rec.write_at(&mut cd, position).unwrap();
    drop(cd);
    let mut sd = a[6].try_borrow_mut_data().unwrap();
    let old = ExpeditionArrivalSlot::read(&ctx, &sd).unwrap();
    let mut common = *old.common();
    common.citizen = [99; 32];
    sd.copy_from_slice(
        &ExpeditionArrivalSlot::new(&ctx, common, old.worn_bps())
            .unwrap()
            .to_bytes(&ctx)
            .unwrap(),
    );
    drop(sd);
    assert!(stage_resolved_return(&p, &a, 2).is_err());
}

#[test]
fn v1_bridge_and_v1_legacy_slot_are_never_promoted() {
    let mut a = resolved_fixture();
    let p = Pubkey::new_from_array([12; 32]);
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &a[2].try_borrow_data().unwrap()).unwrap();
    let owned = a[2].clone();
    a[2] = account(key(&a[2]), [12; 32], bridge.common().to_bytes().to_vec());
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    a[2] = owned;
    let mut sd = a[6].try_borrow_mut_data().unwrap();
    let slot = ExpeditionArrivalSlot::read(&ctx, &sd).unwrap();
    slot.common().write(&mut sd).unwrap();
    drop(sd);
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    let mut terminal = terminal_fixture();
    let ctx = addr::ctx(&key(&terminal[0]), &[12; 32]);
    let bridge =
        OwnedBridgeTransit::from_bytes(&ctx, &terminal[2].try_borrow_data().unwrap()).unwrap();
    terminal[2] = account(
        key(&terminal[2]),
        [12; 32],
        bridge.common().to_bytes().to_vec(),
    );
    assert!(stage_terminal(&p, &terminal, 2).is_err());
}

#[test]
fn incomplete_gather_and_changed_retained_departure_facts_are_refused() {
    let a = resolved_fixture();
    let p = Pubkey::new_from_array([12; 32]);
    let ctx = addr::ctx(&key(&a[0]), &[12; 32]);
    let original_inputs = a[5].try_borrow_data().unwrap().to_vec();
    {
        let mut cd = a[5].try_borrow_mut_data().unwrap();
        let mut hdr = WideClashInputsHdr::read(&cd).unwrap();
        hdr.arrivals_mask &= !1;
        hdr.write(&mut cd).unwrap();
    }
    assert!(stage_resolved_return(&p, &a, 2).is_err());
    a[5].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original_inputs);
    let original_slot = a[6].try_borrow_data().unwrap().to_vec();
    let slot = ExpeditionArrivalSlot::read(&ctx, &original_slot).unwrap();
    for changed_unit in [true, false] {
        let mut common = *slot.common();
        if changed_unit {
            common.unit = 0;
        } else {
            common.dep_mass += 1;
        }
        let changed = ExpeditionArrivalSlot::new(&ctx, common, slot.worn_bps()).unwrap();
        a[6].try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&changed.to_bytes(&ctx).unwrap());
        assert!(stage_resolved_return(&p, &a, 2).is_err());
    }
    a[6].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original_slot);
    assert!(stage_resolved_return(&p, &a, 2).is_ok());
}

#[test]
fn departed_entries_alone_exhaust_storage_without_resident_caps() {
    let (_, bridge, mut hd) = fixture(&ctx());
    let t = bridge.transit();
    let id = AccountResolver::for_season(&ctx())
        .unwrap()
        .legacy_host_id(&t.host)
        .unwrap();
    let mut pd = home_fixture();
    // Distinct issuers avoid fabricating more than four outstanding marches
    // for a single Holding. None of these rows is a resident or pending muster.
    for i in 0..PV::ENTRIES_N {
        let mut e = resident_entry(i, (i % 6) as u8, E::STATE_DEPARTED);
        e.id = frontier_abi::addr::host_id(60 + i as i32, 0, 0, 1, 0).unwrap();
        write_entry(&mut pd, i, &e).unwrap();
    }
    Rw(&mut pd)
        .set_u8(PV::N_ENTRIES, PV::ENTRIES_N as u8)
        .unwrap();
    let before = pd.clone();
    assert_eq!(
        stage_legacy_home(&mut pd, &mut hd, &t, id, 12_345, 40, 12, 20).unwrap(),
        12_000
    );
    assert_eq!(pd, before);
    assert_eq!(Ro(&hd).u32(H::reserve(1)).unwrap(), 12);
}
