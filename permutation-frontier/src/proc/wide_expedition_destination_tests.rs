//! Test-only child of expedition_gather; intentionally unreferenced until audit.
//! Literal canonical prior accounts -> real private Gather stage -> real wide
//! Resolve handler. Only Gather's returned bytes are materialized as fixtures;
//! no combat outcome, roster admission, or survivor count is injected.
//!
//! The original Citizen, home, issued host, settled bridge, arrival slot,
//! destination, resident, and public beacon records are prior-state fixtures.
//! This does not execute their historical producers, allocations, proof, or
//! replay chain, and does not enable any public expedition/conquest gate.
//! No secret keys, signing, crypto-success stubs, processes, or runtime CPI.
use super::*;
use crate::layout::seed_cache as SC;
use alloc::boxed::Box;
use frontier_abi::v2::layout::write_header;
use frontier_abi::v2::presets::{FRONTIER_7, SEASON_CQ_OFFSET};

const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const DEPART_BELL: u32 = 10;
const BELL: u32 = 12;
const ANCHOR: i64 = GENESIS + 7803;
const HOST_SEQ: u32 = 7;
const DEP_MASS: u32 = 25_000_000;
const ORIGIN_SURVIVORS: u32 = 20_000_000;
const ORIGIN_STAMINA: u16 = 40;
const ENEMY_TROOPS: u32 = 100_000;
const FIELD: u8 = 1;

fn ai(
    address: [u8; 32],
    owner: [u8; 32],
    bytes: Vec<u8>,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    // Fixed-size fixture backing only. The roster is already present, so the
    // tested Resolve must not enter its System allocation branch.
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

struct Fixture {
    gather: Vec<AccountInfo<'static>>,
    citizen: AccountInfo<'static>,
    home_province: AccountInfo<'static>,
    roster: AccountInfo<'static>,
    seed: AccountInfo<'static>,
    host: WideHostRef,
    enemy: WideHostRef,
    wear: u16,
    now: i64,
}

fn fixture() -> Fixture {
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let packed = addr::host_id(128, 0, 0, 1, HOST_SEQ).unwrap();
    let host = resolver.legacy_host_ref(packed).unwrap();
    assert_eq!(resolver.legacy_host_id(&host).unwrap(), packed);
    let home_key = resolver.holding_address(&host).unwrap();
    let dest = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
    let ck = ctx.citizen_by_tag15(&addr::citizen_tag15(&WALLET));
    assert_ne!(ck, WALLET);

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
    w.set_arr(SEASON_CQ_OFFSET, &FRONTIER_7.to_bytes()).unwrap();
    let clock = SeasonClock::read(&sd).unwrap();
    assert_eq!(clock.round_time(clock.tlock_round(BELL)), ANCHOR - 1);

    let mut cd = vec![0; K2::Citizen.size()];
    assert!(write_header(&mut cd, K2::Citizen, SID));
    let mut w = Rw(&mut cd);
    w.set_arr(C::WALLET, &WALLET).unwrap();
    w.set_u64(C::CITIZEN_TAG, addr::citizen_tag(&ck)).unwrap();
    w.set_u8(
        C::FLAGS,
        C::FLAG_JOINED | C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL,
    )
    .unwrap();
    w.set_u32(C::TICKET_BELL, C::NO_TICKET).unwrap();
    cd[C2::holding_of_slot(1)..C2::holding_of_slot(1) + 6].copy_from_slice(&[128, 0, 0, 0, 0, 1]);
    cd[C2::HOLDINGS_N] = 1;
    for slot in 2..=3 {
        cd[C2::holding_of_slot(slot) + 5] = C2::EMPTY_GEN;
    }

    let doctrine = of_faction_v3(0).unwrap();
    let departure_dealt =
        hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Hold), true)).unwrap();
    let arrival_dealt =
        hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Brace), true)).unwrap();
    assert_eq!((departure_dealt, arrival_dealt), (10_000, 11_000));
    let departed = OwnedBridgeTransit::new(
        &ctx,
        0,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            TileAddress::new(host.key(), FIELD).unwrap(),
            DEPART_BELL,
            BELL,
            GENESIS + 6000,
            DEP_MASS,
            crate::proc::host::DEPART_STAMINA,
            departure_dealt,
            [0x41; 32],
            0,
            0,
            PAYER,
        )
        .unwrap(),
        ck,
    )
    .unwrap();
    let marker = BridgeMarker::new(
        &ctx,
        departed.common(),
        fees::min_tip_lamports(0, 0, 0),
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    // Literal post-origin precursor, not a claim that this test ran departure
    // or origin combat. Actual destination survivors are never supplied here.
    let bridge = departed
        .settle_origin(&ctx, false, Some((ORIGIN_SURVIVORS, ORIGIN_STAMINA, 0)))
        .unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let economy = cz::founded_holding(GENESIS + 600, addr::day_of(1), 0).unwrap();
    write_founding(
        &mut hd,
        &Founding {
            p: 128,
            q: 0,
            site: 0,
            gen: 1,
            tile: 0,
            owner: ck,
            score: 0,
            faction: 0,
            ticket_bell: C::NO_TICKET,
            rent_payer: PAYER,
            final_ts: GENESIS + 600,
            pool_owed: 0,
            shield_until: GENESIS + 600,
            terrain_ore: 0,
        },
        &economy,
    )
    .unwrap();
    Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    Rw(&mut hd).set_u32(H::HOST_SEQ, HOST_SEQ + 1).unwrap();
    hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    crate::layout::set_chain(&mut hd, 7, &[0x6a; 32]).unwrap();
    let mut hp = vec![0; K2::Province.size()];
    assert!(write_header(&mut hp, K2::Province, SID));
    Rw(&mut hp).set_i16(PV::P, 128).unwrap();
    Rw(&mut hp)
        .set_u32(PV::RESOLVED_NEXT, DEPART_BELL + 1)
        .unwrap();
    hp[PV::SITE_COUNT] = 1;
    hp[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    hp[PV::site(0) + SM::GEN] = 1;
    hp[PV::site(0) + SM::ORDER] = 1;

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
        ring_seed: [0x81; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut pd)
    .unwrap();
    let mut w = Rw(&mut pd);
    w.set_u32(PV::RESOLVED_NEXT, BELL).unwrap();
    w.set_u32(PV2::SCORE_NEXT_BELL, BELL).unwrap();
    w.set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1).unwrap();
    // No camp spawn/keep/site on this isolated field-combat fixture.
    w.set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1).unwrap();
    write_no_keep(&mut pd).unwrap();
    let roster = WideRoster::new(SID, dest, PAYER);
    let mut rd = vec![0; wro::wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    let enemy = WideHostRef::new(dest, 1, 1, 3).unwrap();
    let alias = roster.claim(&mut rd, 0, &enemy).unwrap();
    write_entry(
        &mut pd,
        0,
        &Entry {
            id: alias,
            faction: 2,
            unit: 0,
            tile: FIELD,
            state: E::STATE_ROSTER,
            troops: ENEMY_TROOPS,
            stamina_value: 120,
            stamina_bell: BELL,
            ready_bell: BELL,
            from_bell: 1,
            dealt_bps: 10_000,
            ..Entry::FREE
        },
    )
    .unwrap();
    Rw(&mut pd).set_u8(PV::N_ENTRIES, 1).unwrap();
    roster
        .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
        .unwrap();

    let anchor_key = ctx.bell_anchor(BELL, 0);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    let mut w = Rw(&mut ad);
    w.set_u32(BA::BELL, BELL).unwrap();
    w.set_i64(BA::A, ANCHOR).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(BELL)).unwrap();
    w.set_u64(BA::SLOT, 76).unwrap();
    let mut sc = vec![0; K2::SeedCache.size()];
    assert!(write_header(&mut sc, K2::SeedCache, SID));
    let mut w = Rw(&mut sc);
    w.set_u32(SC::BELL, BELL).unwrap();
    w.set_i64(SC::A, ANCHOR).unwrap();
    let seed_round = clock.seed_round(BELL, ANCHOR);
    w.set_u64(SC::ROUND, seed_round).unwrap();
    w.set_arr(SC::ANCHOR_KEY, &anchor_key).unwrap();
    w.set_arr(SC::SEED, &[0x5a; 32]).unwrap();

    let wear = permutation_rules::frontier::structure::wear_bps(720);
    assert_eq!(wear, 1200);
    let slot = ExpeditionArrivalSlot::new(
        &ctx,
        WideArrivalSlot {
            season_id: SID,
            dest,
            bell: BELL,
            faction: 0,
            i: 0,
            transit_slot: 0,
            host,
            citizen: ck,
            unit: 0,
            stance: 3,
            tile: FIELD,
            retreat_bps: 0,
            dealt_bps: arrival_dealt,
            dep_mass: DEP_MASS,
            flags: 0,
            beneficiary: PAYER,
            rent_to: PAYER,
            ev_slot: 76,
            ev_price: 0,
            ev_limit: 0,
            ev_loaded: 0,
            claimed: false,
        },
        wear,
    )
    .unwrap();
    let mut day = wa::WideArrivalDay::new(SID, dest, wa::day_of(BELL), PAYER);
    assert!(day.set(BELL));
    let mut dd = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut dd).unwrap();
    let mut gather = vec![
        ai(PAYER, [0; 32], vec![], true, true),
        ai(sk, PROGRAM, sd, false, false),
        ai(
            wl::province_address(&ctx, dest.coord()),
            PROGRAM,
            pd,
            false,
            false,
        ),
        ai(anchor_key, PROGRAM, ad, false, false),
        ai(
            wa::clash_inputs_address(&ctx, dest, BELL),
            [0; 32],
            vec![],
            false,
            true,
        ),
        ai(
            wa::arrival_day_address(&ctx, dest, wa::day_of(BELL)),
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
            wa::arrival_slot_address(&ctx, dest, BELL, 0, 0),
            PROGRAM,
            slot.to_bytes(&ctx).unwrap().to_vec(),
            false,
            false,
        ),
        ai(home_key, PROGRAM, hd, false, false),
        ai(
            wm::transit_address(&ctx, &home_key, 0),
            PROGRAM,
            bridge.to_bytes().to_vec(),
            false,
            true,
        ),
    ];
    // Every other slot is absent at its own canonical address. Real Gather
    // scans all positions instead of the test setting ALL_GATHERED itself.
    for k in 1..wa::wide_clash_inputs::POSITIONS {
        gather.push(ai(
            wa::arrival_slot_address(&ctx, dest, BELL, (k / 4) as u8, (k % 4) as u8),
            [0; 32],
            vec![],
            false,
            false,
        ));
        gather.push(ai([0; 32], [0; 32], vec![], false, false));
        gather.push(ai([0; 32], [0; 32], vec![], false, false));
    }
    let now = clock.round_time(seed_round);
    assert!(now >= ANCHOR + 120);
    prologue::set_test_clock(now, 77);
    Fixture {
        gather,
        citizen: ai(ck, PROGRAM, cd, false, false),
        home_province: ai(ctx.province(128, 0), PROGRAM, hp, false, false),
        roster: ai(wro::roster_address(&ctx, dest), PROGRAM, rd, false, true),
        seed: ai(ctx.seed_cache(BELL, 0, 0), PROGRAM, sc, false, false),
        host,
        enemy,
        wear,
        now,
    }
}

#[test]
fn original_rim_host_gathered_into_actual_wide_combat_keeps_full_identity() {
    let mut f = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let ctx = addr::ctx(&key(&f.gather[1]), &PROGRAM);
    let original_home = wh::binding_of(&f.citizen.try_borrow_data().unwrap(), 1).unwrap();
    let source_accounts = [
        f.citizen.clone(),
        f.home_province.clone(),
        f.gather[9].clone(),
    ];
    let source_before = snapshot(&source_accounts);
    let before = snapshot(&f.gather);
    let plan = stage(
        &p,
        &f.gather,
        &wix::Gather {
            bell: BELL,
            start: 0,
            n: wa::wide_clash_inputs::POSITIONS as u8,
        },
    )
    .unwrap();
    assert_eq!(snapshot(&f.gather), before);
    assert!(plan.create_inputs);
    assert_eq!(plan.bridges.len(), 1);
    assert_eq!(plan.bridges[0].0, 10);
    let ih = WideClashInputsHdr::read(&plan.inputs).unwrap();
    assert_eq!(ih.arrivals_mask, wa::wide_clash_inputs::ALL_GATHERED);
    assert_eq!(ih.n_present, 1);
    let arrival_before = WideArrival::read_at(&plan.inputs, 0).unwrap().unwrap();
    assert_eq!(arrival_before.host, f.host);
    assert_eq!(arrival_before.citizen, key(&f.citizen));
    assert_eq!(arrival_before.dep_mass, DEP_MASS);
    assert_eq!(
        arrival_before.troops,
        permutation_rules::frontier::structure::wear(ORIGIN_SURVIVORS as u64, f.wear) as u32
    );
    assert_eq!(
        arrival_before.stamina,
        frontier_abi::clash_model::arrival_stamina(ORIGIN_STAMINA, DEPART_BELL, BELL)
    );
    assert_eq!(arrival_before.dealt_bps, 11_000);
    assert_eq!(arrival_before.fate, wa::wide_arrival::FATE_NONE);
    assert_eq!(arrival_before.troops_after, 0);

    // This replacement is a test fixture boundary, NOT Gather allocation or
    // atomic commitment. No survivor/fate/roster value is supplied by the test.
    f.gather[4] = ai(key(&f.gather[4]), PROGRAM, plan.inputs, false, true);
    for (i, bytes) in plan.bridges {
        f.gather[i] = ai(key(&f.gather[i]), PROGRAM, bytes, false, true);
    }
    let bridge =
        OwnedBridgeTransit::from_bytes(&ctx, &f.gather[10].try_borrow_data().unwrap()).unwrap();
    assert_eq!(bridge.original_owner(), key(&f.citizen));
    assert_eq!(bridge.transit().host, f.host);
    assert_eq!(bridge.transit().dep_mass, DEP_MASS);
    assert_eq!(bridge.transit().troops_after, arrival_before.troops);
    assert_eq!(bridge.transit().state, MarchState::Gathered);
    let retained = [
        f.gather[8].clone(),
        f.gather[10].clone(),
        f.gather[5].clone(),
    ];
    let retained_before = snapshot(&retained);
    let mut province = f.gather[2].clone();
    province.is_writable = true;
    let resolve_accounts = vec![
        f.gather[0].clone(),
        f.gather[1].clone(),
        province,
        f.roster.clone(),
        f.seed.clone(),
        f.gather[3].clone(),
        f.gather[4].clone(),
        f.gather[5].clone(),
        f.gather[7].clone(),
    ];
    let resolve = wix::Resolve {
        bell: BELL,
        beneficiary: PAYER,
    };

    // A real-handler refusal with a missing scan bit, without rollback or
    // mutation of the valid gathered fixture.
    let mut incomplete = resolve_accounts.clone();
    let mut cd = incomplete[6].try_borrow_data().unwrap().to_vec();
    let mut ih = WideClashInputsHdr::read(&cd).unwrap();
    ih.arrivals_mask &= !(1 << (wa::wide_clash_inputs::POSITIONS - 1));
    ih.write(&mut cd).unwrap();
    incomplete[6] = ai(key(&incomplete[6]), PROGRAM, cd, false, true);
    let incomplete_before = snapshot(&incomplete);
    assert_eq!(
        super::super::resolve(&p, &incomplete, &resolve).err(),
        Some(FrontierError::NotGathered.into())
    );
    assert_eq!(snapshot(&incomplete), incomplete_before);

    let lamports_before: Vec<_> = resolve_accounts.iter().map(|a| a.lamports()).collect();
    super::super::resolve(&p, &resolve_accounts, &resolve).unwrap();
    let pd = resolve_accounts[2].try_borrow_data().unwrap();
    let rd = resolve_accounts[3].try_borrow_data().unwrap();
    let cd = resolve_accounts[6].try_borrow_data().unwrap();
    let roster = WideRoster::read(&rd).unwrap();
    let row = WideArrival::read_at(&cd, 0).unwrap().unwrap();
    let ih = WideClashInputsHdr::read(&cd).unwrap();
    assert!(Ro(&pd).u32(PV::RESOLVE_SUMMARY + SU::ENGAGEMENTS).unwrap() > 0);
    assert_eq!(Ro(&pd).u8(PV::RESOLVE_SUMMARY + SU::ARRIVALS).unwrap(), 1);
    assert!(Ro(&pd).u8(PV::RESOLVE_SUMMARY + SU::DESTROYED).unwrap() > 0);
    assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), BELL + 1);
    assert_eq!(
        ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED,
        wa::wide_clash_inputs::FLAG_RESOLVED
    );
    assert_eq!(ih.resolver, PAYER);
    assert_eq!(ih.resolved_ts, (f.now - GENESIS) as u32);
    assert_eq!(row.fate, wa::wide_arrival::FATE_STAYS);
    assert!(row.troops_after >= DESTROYED_BELOW && row.troops_after < row.troops);
    // Resolve may write only the result fields; full owner, original issue
    // identity, pre-clash troops, stance and immutable dep_mass all remain.
    assert_eq!(
        row,
        WideArrival {
            fate: row.fate,
            troops_after: row.troops_after,
            ..arrival_before
        }
    );
    let live = roster.table(&rd).unwrap();
    assert_eq!(live.len(), 1);
    assert!(!live.iter().any(|(_, _, host)| *host == f.enemy));
    let (i, alias, host) = live[0];
    assert_eq!(host, f.host);
    assert_eq!(alias, wide_host_alias(&f.host));
    assert_ne!(
        alias,
        AccountResolver::for_season(&ctx)
            .unwrap()
            .legacy_host_id(&f.host)
            .unwrap()
    );
    let survivor = read_entry(&pd, i).unwrap();
    assert_eq!(survivor.id, alias);
    assert_eq!(survivor.troops, row.troops_after);
    assert_eq!(survivor.state, E::STATE_ROSTER);
    assert_eq!(
        (survivor.faction, survivor.unit, survivor.tile),
        (0, 0, FIELD)
    );
    assert_eq!(survivor.from_bell, BELL + 1);
    assert_eq!(survivor.stamina_bell, BELL);
    // A large damage ratio may refund the engagement's stamina cost. It is
    // still the real kernel's value, not an assumed mandatory deduction.
    assert!(survivor.stamina_value <= row.stamina);
    assert_eq!(
        survivor.ready_bell,
        permutation_rules::frontier::clash::ready_bell_after(BELL)
    );
    roster
        .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
        .unwrap();
    drop((pd, rd, cd));
    assert_eq!(snapshot(&source_accounts), source_before);
    assert_eq!(snapshot(&retained), retained_before);
    assert_eq!(
        wh::binding_of(&f.citizen.try_borrow_data().unwrap(), 1).unwrap(),
        original_home
    );
    assert_eq!(
        Ro(&f.gather[9].try_borrow_data().unwrap())
            .u32(H::HOST_SEQ)
            .unwrap(),
        HOST_SEQ + 1
    );
    assert_eq!(
        resolve_accounts
            .iter()
            .map(|a| a.lamports())
            .collect::<Vec<_>>(),
        lamports_before
    );
    let resolved = snapshot(&resolve_accounts);
    assert_eq!(
        super::super::resolve(&p, &resolve_accounts, &resolve).err(),
        Some(FrontierError::OutOfOrder.into())
    );
    assert_eq!(snapshot(&resolve_accounts), resolved);
}
