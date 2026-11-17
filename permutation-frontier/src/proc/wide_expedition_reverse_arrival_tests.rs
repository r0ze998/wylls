//! Literal public stored-account fixtures, not proof that a seal was valid or
//! these inputs were historically produced. No keys, signing or CPI stubs.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::write_header;
const PROGRAM: [u8; 32] = [0x12; 32];
const OWNER: [u8; 32] = [0xa1; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const ANCHOR: i64 = GENESIS + 7803;
fn ai(k: [u8; 32], d: Vec<u8>, signer: bool, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(k))),
        signer,
        writable,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(d.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(PROGRAM))),
        false,
    )
}
fn fixture(destroyed: bool) -> Vec<AccountInfo<'static>> {
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
    let dest = host.key();
    let origin = ProvinceKey::new(dest.world(), WideCoord::checked(129, 0).unwrap());
    let hk = resolver.holding_address(&host).unwrap();
    let departed = ReverseTransit::new(
        &ctx,
        0,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            TileAddress::new(origin, 30).unwrap(),
            10,
            12,
            GENESIS + 6000,
            200_000,
            crate::proc::host::DEPART_STAMINA,
            10_000,
            [0x41; 32],
            0,
            0,
            OWNER,
        )
        .unwrap(),
        OWNER,
        dest,
    )
    .unwrap();
    let marker = ReverseMarker::new(
        &ctx,
        &departed,
        2500,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let reverse = departed
        .settle_origin(&ctx, destroyed, (180_000, 40, 0))
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
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &OWNER).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    let mut pd = vec![0; K2::Province.size()];
    assert!(write_header(&mut pd, K2::Province, SID));
    Rw(&mut pd).set_i16(PV::P, 128).unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, 12).unwrap();
    let coord = permutation_rules::frontier::geometry::ProvinceCoord::new(128, 0);
    let region = permutation_rules::frontier::geometry::region_of(coord);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    let mut w = Rw(&mut ad);
    w.set_u32(BA::BELL, 12).unwrap();
    w.set_u8(BA::REGION, region).unwrap();
    w.set_i64(BA::A, ANCHOR).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(12)).unwrap();
    w.set_u64(BA::SLOT, 76).unwrap();
    let mut day = vec![0; AD::SIZE];
    assert!(write_header(&mut day, K2::ArrivalDay, SID));
    Rw(&mut day).set_i16(AD::P, 128).unwrap();
    let (at, bit) = AD::bit(12);
    day[at] |= bit;
    let mut slot = vec![0; AS::SIZE];
    assert!(write_header(&mut slot, K2::ArrivalSlot, SID));
    let mut w = Rw(&mut slot);
    w.set_i16(AS::P, 128).unwrap();
    w.set_u32(AS::BELL, 12).unwrap();
    w.set_u64(AS::HOST_ID, resolver.legacy_host_id(&host).unwrap())
        .unwrap();
    w.set_u64(AS::CITIZEN_TAG, addr::citizen_tag(&OWNER))
        .unwrap();
    w.set_u32(AS::DEP_MASS, 200_000).unwrap();
    w.set_u16(AS::DEALT_BPS, 10_000).unwrap();
    w.set_u8(AS::TILE, 30).unwrap();
    w.set_u16(frontier_abi::v2::layout::s1::arrival::WORN_BPS, 500)
        .unwrap();
    let mut cd = vec![0; CI::SIZE];
    assert!(write_header(&mut cd, K2::ClashInputs, SID));
    Rw(&mut cd).set_i16(CI::P, 128).unwrap();
    Rw(&mut cd).set_u32(CI::BELL, 12).unwrap();
    vec![
        ai([0xd1; 32], vec![], true, true),
        ai(sk, sd, false, false),
        ai(ctx.province(128, 0), pd, false, false),
        ai(ctx.bell_anchor(12, region), ad, false, false),
        ai(ctx.arrival_day(128, 0, 0), day, false, false),
        ai(ctx.arrival_slot(128, 0, 12, 0, 0), slot, false, false),
        ai(hk, hd, false, false),
        ai(
            wm::transit_address(&ctx, &hk, 0),
            reverse.to_bytes().to_vec(),
            false,
            true,
        ),
        ai(ctx.clash_inputs(128, 0, 12), cd, false, true),
    ]
}
fn snapshot(a: &[AccountInfo]) -> Vec<(Vec<u8>, u64, Pubkey)> {
    a.iter()
        .map(|a| {
            (
                a.try_borrow_data().unwrap().to_vec(),
                a.lamports(),
                *a.owner,
            )
        })
        .collect()
}
fn execute_fixture(a: &[AccountInfo]) -> R<()> {
    execute(&Pubkey::new_from_array(PROGRAM), a, 12, 0)
}

#[test]
fn original_reverse_gather_writes_actual_inputs_and_transport_once() {
    let a = fixture(false);
    let before = snapshot(&a);
    execute_fixture(&a).unwrap();
    let after = snapshot(&a);
    for i in 0..a.len() {
        assert_eq!(before[i].1, after[i].1);
        assert_eq!(before[i].2, after[i].2);
        if ![7, 8].contains(&i) {
            assert_eq!(before[i].0, after[i].0);
        }
    }
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let reverse = ReverseTransit::from_bytes(&ctx, &after[7].0).unwrap();
    assert_eq!(reverse.transit().state, MarchState::Gathered);
    assert_eq!(reverse.transit().troops_after, 171_000);
    assert_eq!(reverse.transit().dest, Some(reverse.destination()));
    assert_eq!(reverse.original_owner(), OWNER);
    let c = Ro(&after[8].0);
    assert_eq!(c.u32(CI::ARRIVALS_MASK).unwrap(), 1);
    assert_eq!(c.u8(CI::N_PRESENT).unwrap(), 1);
    let row = CI::arrival(0);
    assert_eq!(c.u32(row + AR::TROOPS).unwrap(), 171_000);
    assert_eq!(c.u8(row + AR::PRESENT).unwrap(), 1);
    assert_eq!(crate::layout::chain_of(&after[8].0).unwrap().0, 1);
    execute_fixture(&a).unwrap();
    assert_eq!(snapshot(&a), after, "repeat neither wears nor chains twice");
}
#[test]
fn original_reverse_gather_destroyed_origin_is_absent_and_never_regenerates() {
    let a = fixture(true);
    execute_fixture(&a).unwrap();
    let cd = a[8].try_borrow_data().unwrap();
    let c = Ro(&cd);
    let row = CI::arrival(0);
    assert_eq!(c.u8(CI::N_PRESENT).unwrap(), 0);
    assert_eq!(c.u32(row + AR::TROOPS).unwrap(), 0);
    assert_eq!(c.u16(row + AR::STAMINA).unwrap(), 0);
    assert_eq!(c.u8(row + AR::FATE).unwrap(), AR::FATE_DESTROYED);
}
#[test]
fn original_reverse_gather_rejects_swapped_identity_latch_owner_wear_and_day_without_effects() {
    for case in 0..8 {
        let a = fixture(false);
        match case {
            0 => a[5].try_borrow_mut_data().unwrap()[AS::HOST_ID] ^= 1,
            1 => a[5].try_borrow_mut_data().unwrap()[AS::CITIZEN_TAG] ^= 1,
            2 => Rw(&mut a[2].try_borrow_mut_data().unwrap())
                .set_u32(PV::RESOLVED_NEXT, 13)
                .unwrap(),
            3 => a[6].try_borrow_mut_data().unwrap()[H::OWNER_CITIZEN + 31] ^= 1,
            4 => a[6].try_borrow_mut_data().unwrap()[H::GEN] = 2,
            5 => Rw(&mut a[5].try_borrow_mut_data().unwrap())
                .set_u16(frontier_abi::v2::layout::s1::arrival::WORN_BPS, 10001)
                .unwrap(),
            6 => {
                let (at, _) = AD::bit(12);
                a[4].try_borrow_mut_data().unwrap()[at] = 0;
            }
            _ => a[8].try_borrow_mut_data().unwrap()[CI::FLAGS] = CI::FLAG_RESOLVED,
        };
        let before = snapshot(&a);
        assert!(execute_fixture(&a).is_err(), "case {case}");
        assert_eq!(snapshot(&a), before);
    }
}
#[test]
fn original_reverse_gather_held_second_write_borrow_and_alias_fail_atomically() {
    let a = fixture(false);
    let before = snapshot(&a);
    let held = a[8].try_borrow_data().unwrap();
    assert!(execute_fixture(&a).is_err());
    drop(held);
    assert_eq!(snapshot(&a), before);
    let mut a = fixture(false);
    a[8].data = a[7].data.clone();
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
    let mut a = fixture(false);
    a[2].is_writable = true;
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
    let a = fixture(false);
    Rw(&mut a[6].try_borrow_mut_data().unwrap())
        .set_i16(H::P, 127)
        .unwrap();
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
}
#[test]
fn original_reverse_gather_repeat_mismatch_and_preclose_window_fail_without_effects() {
    let a = fixture(false);
    execute_fixture(&a).unwrap();
    a[8].try_borrow_mut_data().unwrap()[CI::arrival(0) + AR::TROOPS] ^= 1;
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
    let a = fixture(false);
    prologue::set_test_clock(ANCHOR + 59, 77);
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
}

#[test]
fn original_reverse_gather_manifest_binds_readonly_raw_chain_and_balance() {
    let a = fixture(false);
    let p = Pubkey::new_from_array(PROGRAM);
    let first = prepare(&p, &a, 12, 0).unwrap();
    crate::layout::set_chain(&mut a[6].try_borrow_mut_data().unwrap(), 7, &[0x77; 32]).unwrap();
    let chain_changed = prepare(&p, &a, 12, 0).unwrap();
    assert_eq!(
        first.record, chain_changed.record,
        "original GATHER does not rewrite the readonly Holding"
    );
    assert_ne!(first.manifest[33..65], chain_changed.manifest[33..65]);
    assert_ne!(first.manifest[65..97], chain_changed.manifest[65..97]);
    **a[5].try_borrow_mut_lamports().unwrap() += 1;
    let balance_changed = prepare(&p, &a, 12, 0).unwrap();
    assert_ne!(
        chain_changed.manifest[33..65],
        balance_changed.manifest[33..65]
    );
    assert_ne!(
        chain_changed.manifest[65..97],
        balance_changed.manifest[65..97]
    );
    let before = snapshot(&a);
    execute_fixture(&a).unwrap();
    assert_eq!(a[6].try_borrow_data().unwrap().to_vec(), before[6].0);
    assert_eq!(a[5].lamports(), before[5].1);
}

#[test]
fn original_reverse_gather_chain_overflow_refuses_before_transport_write() {
    let a = fixture(false);
    crate::layout::set_chain(
        &mut a[8].try_borrow_mut_data().unwrap(),
        u64::MAX,
        &[0x55; 32],
    )
    .unwrap();
    let before = snapshot(&a);
    assert!(execute_fixture(&a).is_err());
    assert_eq!(snapshot(&a), before);
}

#[test]
fn original_reverse_gather_creation_requires_suffix_and_preflights_before_cpi() {
    let mut a = fixture(false);
    let system = Box::leak(Box::new(Pubkey::new_from_array(ap::ids::SYSTEM_PROGRAM)));
    let ci_key = key(&a[8]);
    a[8] = ai(ci_key, vec![], false, true);
    a[8].owner = system;
    **a[8].try_borrow_mut_lamports().unwrap() = 500;
    a[0].owner = system;
    let before = snapshot(&a);
    assert!(
        execute_fixture(&a).is_err(),
        "absence cannot create without fee-evidence and System roles"
    );
    assert_eq!(snapshot(&a), before);
    a.push(ai(
        ap::ids::INSTRUCTIONS_SYSVAR,
        vec![0, 0, 0, 0],
        false,
        false,
    ));
    a.push(ai(ap::ids::SYSTEM_PROGRAM, vec![], false, false));
    let plan = prepare(&Pubkey::new_from_array(PROGRAM), &a, 12, 0).unwrap();
    assert!(plan.create_inputs);
    assert_eq!(plan.inputs.len(), CI::SIZE);
    assert_eq!(plan.inputs_after, init::rent(CI::SIZE).unwrap());
    assert_eq!(
        plan.payer_after,
        a[0].lamports() - (plan.inputs_after - 500)
    );
    let before = snapshot(&a);
    let held = a[8].try_borrow_data().unwrap();
    assert!(
        execute_fixture(&a).is_err(),
        "held output refuses before invoking System"
    );
    drop(held);
    assert_eq!(snapshot(&a), before);
    let held = a[0].try_borrow_lamports().unwrap();
    assert!(
        execute_fixture(&a).is_err(),
        "held payer refuses before invoking System"
    );
    drop(held);
    assert_eq!(snapshot(&a), before);
}
