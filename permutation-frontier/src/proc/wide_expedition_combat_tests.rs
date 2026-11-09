//! Actual legacy ResolveFromInputs between staged Spend and bridge settlement.
//! Seed/anchor and fully gathered empty arrivals are literal prior-state
//! fixtures, not a PostSeed/Gather test. No signing, oracle, or crypto override.
//! Departure allocation CPI is not exercised: its staged bytes are installed
//! only into isolated fixture accounts. The public expedition gate stays shut.
use super::*;
use crate::layout::{bell_anchor as BA, camp as CP, clash_inputs as CI, seed_cache as SC};
use frontier_abi::v2::presets::{FRONTIER_7, SEASON_CQ_OFFSET};

#[test]
fn actual_legacy_resolve_hands_survivors_to_bridge_exactly_once() {
    let (a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    {
        let mut sd = a[2].try_borrow_mut_data().unwrap();
        let mut w = Rw(&mut sd);
        w.set_i64(S::DRAND_GENESIS, GENESIS - 100).unwrap();
        w.set_u32(S::DRAND_PERIOD, 3).unwrap();
        w.set_u32(S::REVEAL_WINDOW, 60).unwrap();
        w.set_u32(S::WINDOW_NEXT, 60).unwrap();
        w.set_u32(S::SEED_MARGIN, 60).unwrap();
        w.set_arr(SEASON_CQ_OFFSET, &FRONTIER_7.to_bytes()).unwrap();
    }
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        // An opposing resident on the departing host's tile forces a real
        // engagement. Neither survivor count nor post-clash stamina is injected.
        let mut enemy = read_entry(&pd, 0).unwrap();
        enemy.id = frontier_abi::addr::host_id(1, 0, 1, 1, 0).unwrap();
        enemy.faction = 1;
        enemy.troops = 100_000;
        write_entry(&mut pd, 1, &enemy).unwrap();
        Rw(&mut pd).set_u8(PV::N_ENTRIES, 2).unwrap();
        // This prior-state fixture has already resolved bells 0..9. Conquest
        // scoring must have the same cursor, even for a province with no keep.
        Rw(&mut pd)
            .set_u32(frontier_abi::v2::layout::province::province::SCORE_NEXT_BELL, 10)
            .unwrap();
        Rw(&mut pd)
            .set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1)
            .unwrap();
        Rw(&mut pd)
            .set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1000)
            .unwrap();
        pd[frontier_abi::v2::layout::province::province::KEEP
            + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
    }
    let plan = prepare_depart(&p, &a, &x, &Auth::Wallet).unwrap();
    let province = ai(key(&a[5]), PROGRAM, plan.after[5].data.clone(), false, true);
    let holding = ai(key(&a[4]), PROGRAM, plan.after[4].data.clone(), false, true);
    let bridge = ai(key(&a[8]), PROGRAM, plan.after[8].data.clone(), false, true);
    let original_id = read_entry(&province.try_borrow_data().unwrap(), 0)
        .unwrap()
        .id;
    let clock = SeasonClock::read(&a[2].try_borrow_data().unwrap()).unwrap();
    let region = permutation_rules::frontier::geometry::region_of(
        permutation_rules::frontier::geometry::ProvinceCoord::new(1, 0),
    );
    let landed = GENESIS + 11 * 600;
    let anchor_key = ctx.bell_anchor(10, region);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    let mut w = Rw(&mut ad);
    w.set_u32(BA::BELL, 10).unwrap();
    w.set_u8(BA::REGION, region).unwrap();
    w.set_i64(BA::A, landed).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(10)).unwrap();
    w.set_u64(BA::SLOT, 1).unwrap();
    let mut sc = vec![0; K2::SeedCache.size()];
    assert!(write_header(&mut sc, K2::SeedCache, SID));
    let mut w = Rw(&mut sc);
    w.set_u32(SC::BELL, 10).unwrap();
    w.set_u8(SC::REGION, region).unwrap();
    w.set_i64(SC::A, landed).unwrap();
    w.set_u64(SC::ROUND, clock.seed_round(10, landed)).unwrap();
    w.set_arr(SC::ANCHOR_KEY, &anchor_key).unwrap();
    w.set_arr(SC::SEED, &[0x5a; 32]).unwrap();
    let mut cd = vec![0; K2::ClashInputs.size()];
    assert!(write_header(&mut cd, K2::ClashInputs, SID));
    let mut w = Rw(&mut cd);
    w.set_i16(CI::P, 1).unwrap();
    w.set_u32(CI::BELL, 10).unwrap();
    w.set_u32(CI::ARRIVALS_MASK, CI::ALL_GATHERED).unwrap();
    let resolve_accounts = vec![
        a[1].clone(),
        a[2].clone(),
        province.clone(),
        ai(ctx.clash_inputs(1, 0, 10), PROGRAM, cd, false, true),
        ai(ctx.seed_cache(10, region, 0), PROGRAM, sc, false, false),
        ai(anchor_key, PROGRAM, ad, false, false),
        ai(
            frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR,
            [0; 32],
            vec![0, 0, 0, 0],
            false,
            false,
        ),
    ];
    prologue::set_test_clock(landed + 120, 2000);
    let resolve = frontier_abi::ix::ResolveFromInputs {
        bell: 10,
        beneficiary: WALLET,
    };
    // Diagnose the real handler's pure stages on disposable copies. These
    // results never replace account bytes or supply survivor values: the
    // actual instruction below must still execute every stage itself.
    {
        use frontier_abi::{clash_model as model, conquest_model as cq};
        use permutation_rules::frontier::clash as kernel;
        let mut pd = province.try_borrow_data().unwrap().to_vec();
        let cd = resolve_accounts[3].try_borrow_data().unwrap().to_vec();
        let built = model::build_v2(&pd, Some(&cd), 10).expect("build_v2 fixture");
        let out = kernel::resolve_clash(&kernel::frontier_ruleset(), &built.input(&[0x5a; 32]))
            .expect("clash kernel fixture");
        let report = cq::report_from_outcome(&built, &out).expect("conquest report fixture");
        let applied = model::apply_v2(&mut pd, &built, &out).expect("apply_v2 fixture");
        let settled = model::settle_bell(&mut pd, 10).expect("settle_bell fixture");
        let params = cq::StepParams::of_season(&a[2].try_borrow_data().unwrap()).unwrap();
        let step = cq::step(&mut pd, 10, &report, &params).expect("conquest step fixture");
        model::finish_bell(&mut pd, 10, applied.changed() || settled || step.roster_changed)
            .expect("finish_bell fixture");
    }
    crate::proc::clash::resolve_from_inputs(&p, &resolve_accounts, &resolve.to_bytes()).unwrap();
    let survivor = read_entry(&province.try_borrow_data().unwrap(), 0).unwrap();
    assert_eq!(survivor.id, original_id);
    assert_eq!(survivor.state, E::STATE_DEPARTED);
    assert!(survivor.troops > 0 && survivor.troops < 200_000);
    assert_eq!(
        Ro(&province.try_borrow_data().unwrap())
            .u32(PV::RESOLVED_NEXT)
            .unwrap(),
        11
    );
    assert_ne!(
        resolve_accounts[3].try_borrow_data().unwrap()[CI::FLAGS] & CI::FLAG_RESOLVED,
        0
    );
    let resolved = snapshot(&resolve_accounts);
    assert!(
        crate::proc::clash::resolve_from_inputs(&p, &resolve_accounts, &resolve.to_bytes())
            .is_err()
    );
    assert_eq!(snapshot(&resolve_accounts), resolved);
    let origin = vec![
        a[1].clone(),
        a[2].clone(),
        province.clone(),
        holding,
        province,
        bridge,
    ];
    let before = snapshot(&origin);
    execute_origin(&p, &origin, 0).unwrap();
    let t = BridgeTransit::from_bytes(&ctx, &origin[5].try_borrow_data().unwrap())
        .unwrap()
        .transit();
    assert_eq!(t.troops_after, survivor.troops);
    assert_eq!(t.stamina_after, survivor.stamina_value);
    assert_eq!(
        read_entry(&origin[2].try_borrow_data().unwrap(), 0).unwrap(),
        Entry::FREE
    );
    assert_eq!(
        Ro(&origin[3].try_borrow_data().unwrap())
            .u32(H::HOST_SEQ)
            .unwrap(),
        1
    );
    assert_eq!(
        origin.iter().map(|a| a.lamports()).collect::<Vec<_>>(),
        before.iter().map(|a| a.0).collect::<Vec<_>>()
    );
    let settled = snapshot(&origin);
    assert!(execute_origin(&p, &origin, 0).is_err());
    assert_eq!(snapshot(&origin), settled);
}
