//! Direct-dispatch, literal/codec-written fixtures only. No lifecycle
//! setup, rollback executor, signing, native crypto, exporter or network.
use super::*;
use crate::FrontierError;
use frontier_abi::layout::header;
use frontier_abi::world_index::economy::{Action, Snapshots};

fn fixture() -> Vec<AccountInfo<'static>> {
    let bump = season_bump(SEASON_ID);
    let sk = crate::addr::season_pda(SEASON_ID, bump, &PROGRAM);
    let ctx = crate::addr::ctx(&sk, &PROGRAM);
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let ck = ctx.citizen_by_tag15(&citizen_tag15(&WALLET_A));
    let mut cd = citizen_bytes(&ck, &WALLET_A, 0, join_shard_of(&WALLET_A));
    wh::bind(&mut cd, 2).unwrap();
    let mut hd = vec![0; wh::wide_holding::SIZE];
    WideHolding::found(
        world,
        SEASON_ID,
        coord,
        0,
        2,
        2,
        ck,
        &wl::Decision::Decided(()),
    )
    .unwrap()
    .write_identity(&mut hd)
    .unwrap();
    hd[H::STATE] = H::STATE_FINAL;
    hd[H::ORDER] = 2;
    put(&mut hd, H::reserve(0), &100u32.to_le_bytes());
    for i in 0..RESOURCES {
        put(
            &mut hd,
            H::store(i) + AC::VALUE,
            &(1900 * MILLI).to_le_bytes(),
        );
        put(
            &mut hd,
            H::store(i) + AC::CAP,
            &(2000 * MILLI).to_le_bytes(),
        );
        put(&mut hd, H::store(i) + AC::T0, &GENESIS.to_le_bytes());
    }
    let mut pd = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SEASON_ID,
        world,
        coord,
        wedge: coord.wedge().unwrap(),
        region: 0,
        opened_bell: 1,
        readiness: readiness::REQUIRED,
        seed_round: 1,
        ring_seed: RING129_SEED,
        funded_lamports: 0,
    }
    .write_identity(&mut pd)
    .unwrap();
    put(&mut pd, PV::RESOLVED_NEXT, &10u32.to_le_bytes());
    pd[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    pd[PV::site(0) + SM::GEN] = 2;
    let account = |key, bytes, writable| info(leak(key, PROGRAM, bytes, 0, BIG), false, writable);
    at_bell(10);
    vec![
        wallet(WALLET_A, true, false, 0),
        wallet(PAYER, true, true, BIG),
        account(sk, season_bytes(bump, &conquest(&HOME), &HOME), false),
        account(ck, cd, true),
        account(wh::holding_address(&ctx, coord, 0), hd, true),
        account(wl::province_address(&ctx, coord), pd, true),
    ]
}

fn data(delta: i64) -> Vec<u8> {
    // Raw canonical-width envelope also permits exercising invalid deltas.
    let mut d = vec![
        wix::TAG_DEPART,
        wix::ENVELOPE_ESCAPE,
        wix::ENVELOPE_VERSION,
        wix::OP_GARRISON,
    ];
    d.extend_from_slice(&delta.to_le_bytes());
    d
}
fn exec(a: &[AccountInfo<'static>], d: &[u8]) -> Result<(), ProgramError> {
    crate::dispatch(&Pubkey::new_from_array(PROGRAM), a, d).map_err(ProgramError::from)
}
fn snapshot(a: &[AccountInfo<'static>]) -> Vec<(u64, Vec<u8>, Pubkey)> {
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
fn refused(a: &[AccountInfo<'static>], delta: i64) -> ProgramError {
    let before = snapshot(a);
    let logs = (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    );
    let e = exec(a, &data(delta)).unwrap_err();
    assert_eq!(snapshot(a), before);
    assert_eq!(
        (
            LOGS.lock().unwrap().clone(),
            WIDE_LOGS.lock().unwrap().clone()
        ),
        logs
    );
    e
}

#[test]
fn train_then_garrison_debits_only_unit_zero_and_commits_receipt() {
    let _g = begin();
    let a = fixture();
    exec(
        &a,
        &wix::Economy {
            action: Action::Train { unit: 0, n: 10 },
        }
        .to_bytes()
        .unwrap(),
    )
    .unwrap();
    let before = snapshot(&a);
    exec(&a, &data(20)).unwrap();
    assert_eq!(
        Ro(&a[4].try_borrow_data().unwrap())
            .u32(H::reserve(0))
            .unwrap(),
        90
    );
    let pd = a[5].try_borrow_data().unwrap();
    assert_eq!(Ro(&pd).u32(PV::site(0) + SM::GARRISON).unwrap(), 0);
    assert_eq!(Ro(&pd).u32(PV::site(0) + SM::PEND0_BELL).unwrap(), 10);
    assert_eq!(
        Ro(&pd).i64(PV::site(0) + SM::PEND0_DELTA).unwrap(),
        20 * MILLI
    );
    drop(pd);
    let logs = WIDE_LOGS.lock().unwrap();
    let rec = WideRecord::decode(logs.last().unwrap()).unwrap();
    assert_eq!(rec.kind, WideKind::Garrison);
    let receipt = wev::GarrisonReceipt::decode(rec.payload).unwrap();
    let h = WideHolding::read(&before[4].1).unwrap();
    let href = WideHostRef::new(ProvinceKey::new(h.world, h.coord), h.site, h.gen, 0).unwrap();
    let after = snapshot(&a);
    for unit in 1..H::RESERVE_N {
        assert_eq!(
            Ro(&before[4].1).u32(H::reserve(unit)).unwrap(),
            Ro(&after[4].1).u32(H::reserve(unit)).unwrap()
        );
    }
    for link in rec.links.iter().flatten() {
        let i = match link.entity {
            WideEntity::Province => 5,
            WideEntity::Holding => 4,
        };
        let (seq, head) = crate::layout::chain_of(&before[i].1).unwrap();
        assert_eq!(
            *link,
            wev::advance(link.entity, seq, &head, rec.body_without_tail).unwrap()
        );
        assert_eq!(
            crate::layout::chain_of(&after[i].1).unwrap(),
            (link.seq, link.head)
        );
    }
    assert_eq!(
        receipt.input_digest,
        wev::garrison_input_digest(
            &href,
            20,
            GENESIS + 6000,
            &before[2].1,
            &Snapshots {
                citizen: &before[3].1,
                holding: &before[4].1,
                province: &before[5].1
            }
        )
        .unwrap()
    );
    assert_eq!(
        receipt.output_digest,
        wev::garrison_output_digest(
            &href,
            20,
            GENESIS + 6000,
            false,
            &Snapshots {
                citizen: &after[3].1,
                holding: &after[4].1,
                province: &after[5].1
            }
        )
        .unwrap()
    );
    assert_eq!(
        crate::layout::chain_of(&before[3].1).unwrap(),
        crate::layout::chain_of(&after[3].1).unwrap()
    );
    drop(logs);
    exec(&a, &data(5)).unwrap();
    assert_eq!(
        Ro(&a[5].try_borrow_data().unwrap())
            .i64(PV::site(0) + SM::PEND0_DELTA)
            .unwrap(),
        25 * MILLI
    );
}

#[test]
fn invalid_delta_insufficiency_and_owner_refuse_without_writes() {
    let _g = begin();
    let a = fixture();
    for delta in [0, -1, i64::MAX, u32::MAX as i64 + 1] {
        refused(&a, delta);
    }
    assert_eq!(
        refused(&a, 101),
        ProgramError::Custom(FrontierError::Insufficient as u32)
    );
    let mut wrong = a.clone();
    wrong[0] = wallet(WALLET_B, true, false, 0);
    refused(&wrong, 1);
    wrong[0] = a[0].clone();
    wrong[0].is_signer = false;
    refused(&wrong, 1);
    put(
        &mut a[4].try_borrow_mut_data().unwrap(),
        H::OWNER_CITIZEN,
        &[0x66; 32],
    );
    assert_eq!(
        refused(&a, 1),
        ProgramError::Custom(FrontierError::NotOwner as u32)
    );
}

#[test]
fn chain_overflow_and_late_borrows_are_atomic() {
    let _g = begin();
    for i in [4, 5] {
        let a = fixture();
        put(
            &mut a[i].try_borrow_mut_data().unwrap(),
            header::EVENT_SEQ,
            &u64::MAX.to_le_bytes(),
        );
        refused(&a, 1);
    }
    for i in [3, 4, 5] {
        let a = fixture();
        let guard = a[i].try_borrow_data().unwrap();
        assert_eq!(refused(&a, 1), ProgramError::AccountBorrowFailed);
        drop(guard);
    }
}

#[test]
fn resident_lag_capacity_pending_slots_and_finality_are_atomic() {
    let _g = begin();
    let a = fixture();
    put(
        &mut a[5].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &8u32.to_le_bytes(),
    );
    assert_eq!(
        refused(&a, 1),
        ProgramError::Custom(FrontierError::NotResident as u32)
    );
    put(
        &mut a[5].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &10u32.to_le_bytes(),
    );
    {
        let mut p = a[5].try_borrow_mut_data().unwrap();
        put(
            &mut p,
            PV::site(0) + SM::GARRISON,
            &permutation_rules::frontier::host::MAX_HOST_TROOPS.to_le_bytes(),
        );
    }
    refused(&a, 1);
    {
        let mut p = a[5].try_borrow_mut_data().unwrap();
        put(&mut p, PV::site(0) + SM::GARRISON, &0u32.to_le_bytes());
        for (b, d, bell) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA, 11u32),
            (SM::PEND1_BELL, SM::PEND1_DELTA, 12),
        ] {
            put(&mut p, PV::site(0) + b, &bell.to_le_bytes());
            put(&mut p, PV::site(0) + d, &MILLI.to_le_bytes());
        }
    }
    assert_eq!(
        refused(&a, 1),
        ProgramError::Custom(FrontierError::HostBusy as u32)
    );
    let a = fixture();
    {
        let mut h = a[4].try_borrow_mut_data().unwrap();
        h[H::STATE] = H::STATE_PROVISIONAL;
        put(&mut h, H::FINAL_TS, &(GENESIS + 10000).to_le_bytes());
    }
    assert_eq!(
        refused(&a, 1),
        ProgramError::Custom(FrontierError::NotFinal as u32)
    );
}

#[test]
fn literal_session_authentication_and_expiry() {
    let _g = begin();
    let mut a = fixture();
    a[0] = wallet([0x5e; 32], true, false, 0);
    {
        let mut c = a[3].try_borrow_mut_data().unwrap();
        put(&mut c, C::SESSION, &[0x5e; 32]);
        put(&mut c, C::SESSION_EXPIRY, &(GENESIS + 6001).to_le_bytes());
    }
    exec(&a, &data(1)).unwrap();
    put(
        &mut a[3].try_borrow_mut_data().unwrap(),
        C::SESSION_EXPIRY,
        &(GENESIS + 6000).to_le_bytes(),
    );
    refused(&a, 1);
}

#[test]
fn due_finality_is_receipted_and_capture_lock_is_atomic() {
    let _g = begin();
    let a = fixture();
    {
        let mut h = a[4].try_borrow_mut_data().unwrap();
        h[H::STATE] = H::STATE_PROVISIONAL;
        put(&mut h, H::FINAL_TS, &(GENESIS + 6000).to_le_bytes());
    }
    exec(&a, &data(1)).unwrap();
    assert_eq!(a[4].try_borrow_data().unwrap()[H::STATE], H::STATE_FINAL);
    let logs = WIDE_LOGS.lock().unwrap();
    let rec = WideRecord::decode(logs.last().unwrap()).unwrap();
    assert!(
        wev::GarrisonReceipt::decode(rec.payload)
            .unwrap()
            .became_final
    );
    drop(logs);
    let a = fixture();
    a[5].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 3;
    refused(&a, 1);
}

/// Codec fixtures for an actual no-arrivals resolve. The cache seed is a
/// literal, not evidence of drand provenance. No PostAnchor/PostSeed or
/// lifecycle helper executes. A present empty roster excludes allocation.
fn resolve_accounts(a: &[AccountInfo<'static>], bell: u32) -> Vec<AccountInfo<'static>> {
    let sk = a[2].key.to_bytes();
    let ctx = crate::addr::ctx(&sk, &PROGRAM);
    let h = WideHolding::read(&a[4].try_borrow_data().unwrap()).unwrap();
    let pk = ProvinceKey::new(h.world, h.coord);
    let clock = SeasonClock::read(&a[2].try_borrow_data().unwrap()).unwrap();
    let landed = clock.genesis_ts + 600 * bell as i64 + 100;
    let round = clock.seed_round(bell, landed);
    let ak = ctx.bell_anchor(bell, 0);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut ad,
        K2::BellAnchor,
        SEASON_ID
    ));
    put(&mut ad, BA::BELL, &bell.to_le_bytes());
    put(&mut ad, BA::ROUND, &round.to_le_bytes());
    put(&mut ad, BA::A, &landed.to_le_bytes());
    let mut cd = vec![0; K2::SeedCache.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut cd,
        K2::SeedCache,
        SEASON_ID
    ));
    put(&mut cd, SC::BELL, &bell.to_le_bytes());
    put(&mut cd, SC::ROUND, &round.to_le_bytes());
    put(&mut cd, SC::A, &landed.to_le_bytes());
    put(&mut cd, SC::ANCHOR_KEY, &ak);
    put(&mut cd, SC::SEED, &[0x72; 32]);
    let mut rd = vec![0; wro::wide_roster::SIZE];
    WideRoster::new(SEASON_ID, pk, PAYER)
        .write_header(&mut rd)
        .unwrap();
    let account = |key, bytes, writable| info(leak(key, PROGRAM, bytes, 0, BIG), false, writable);
    vec![
        a[1].clone(),
        a[2].clone(),
        a[5].clone(),
        account(wro::roster_address(&ctx, pk), rd, true),
        account(ctx.seed_cache(bell, 0, 0), cd, false),
        account(ak, ad, false),
        wallet(wa::clash_inputs_address(&ctx, pk, bell), false, true, 0),
        wallet(
            wa::arrival_day_address(&ctx, pk, bell / 144),
            false,
            false,
            0,
        ),
        wallet(SYSTEM, false, false, 0),
    ]
}

#[test]
fn actual_resolve_activates_reinforcement_after_its_bell_clash() {
    let _g = begin();
    let a = fixture();
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 1;
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        put(&mut pd, PV2::SCORE_NEXT_BELL, &10u32.to_le_bytes());
        // Suppress the independent daily camp spawn in this fixture.
        put(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, &1u32.to_le_bytes());
    }
    exec(
        &a,
        &wix::Economy {
            action: Action::Train { unit: 0, n: 10 },
        }
        .to_bytes()
        .unwrap(),
    )
    .unwrap();
    exec(&a, &data(20)).unwrap();
    assert_eq!(
        Ro(&a[5].try_borrow_data().unwrap())
            .u32(PV::site(0) + SM::GARRISON)
            .unwrap(),
        0
    );
    let ra = resolve_accounts(&a, 10);
    at_bell(12);
    exec(
        &ra,
        &wix::Resolve {
            bell: 10,
            beneficiary: PAYER,
        }
        .to_bytes(),
    )
    .unwrap();
    let pd = a[5].try_borrow_data().unwrap();
    assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), 11);
    assert_eq!(Ro(&pd).u32(PV::site(0) + SM::GARRISON).unwrap(), 20_000);
    assert_eq!(Ro(&pd).i64(PV::site(0) + SM::PEND0_DELTA).unwrap(), 0);
    let logs = WIDE_LOGS.lock().unwrap();
    assert_eq!(
        WideRecord::decode(logs.last().unwrap()).unwrap().kind,
        WideKind::Resolve
    );
}
