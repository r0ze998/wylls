//! Literal preallocated pool/claim/slots, real private writes and arithmetic.
//! No allocation CPI, rollback harness, syscall overrides, signing, secret
//! derivation or cryptographic proof. Account history remains fixture input.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::arrival::wide_arrival_slot as AS;
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_transport::{OwnedBridgeTransit, WORN_BPS_OFFSET};
use solana_program::program_error::ProgramError;

const PROGRAM: [u8; 32] = [0x12; 32];
const KEEPER: [u8; 32] = [0xb1; 32];
const RENT_TO: [u8; 32] = [0xc1; 32];
const OWNER: [u8; 32] = [0xa1; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const BELL: u32 = 12;
const ANCHOR: i64 = GENESIS + 7803;
const BIG: u64 = 1_000_000_000;

fn ai(
    address: [u8; 32],
    owner: [u8; 32],
    data: Vec<u8>,
    lamports: u64,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        signer,
        writable,
        Box::leak(Box::new(lamports)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

fn fixture(n: usize) -> Vec<AccountInfo<'static>> {
    prologue::set_test_clock(ANCHOR + 61, 110);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(addr::host_id(128, 0, 0, 1, 0).unwrap())
        .unwrap();
    let dest = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
    let region = wr::wide_region(dest.coord());
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
    w.set_u8(S::LATENESS_SLOTS, 5).unwrap();
    w.set_u32(S::DEFENCE_CAP_MILLI, 1000).unwrap();
    let clock = SeasonClock::read(&sd).unwrap();
    assert_eq!(clock.round_time(clock.tlock_round(BELL)), ANCHOR - 1);
    let mut pd = vec![0; DP::SIZE];
    init_header(&mut pd, AccountKind::DefencePool, SID).unwrap();
    Rw(&mut pd)
        .set_u64(DP::PER_BELL_REGION_CAP, u64::MAX)
        .unwrap();
    Rw(&mut pd)
        .set_u64(DP::PER_KEEPER_DAY_CAP, u64::MAX)
        .unwrap();
    let mut cd = vec![0; DC::SIZE];
    init_header(&mut cd, AccountKind::DefenceClaim, SID).unwrap();
    Rw(&mut cd).set_arr(DC::BENEFICIARY, &KEEPER).unwrap();
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    let mut w = Rw(&mut ad);
    w.set_u32(BA::BELL, BELL).unwrap();
    w.set_u8(BA::REGION, region).unwrap();
    w.set_i64(BA::A, ANCHOR).unwrap();
    w.set_u64(BA::SLOT, 100).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(BELL)).unwrap();
    let anchor = ai(
        ctx.bell_anchor(BELL, region),
        PROGRAM,
        ad,
        BIG,
        false,
        false,
    );
    let mut a = vec![
        ai(KEEPER, [0; 32], vec![], BIG, true, true),
        ai(sk, PROGRAM, sd, BIG, false, false),
        ai(ctx.defence_pool(), PROGRAM, pd, BIG, false, true),
        ai(
            ctx.of(&defence_claim_seed(&keeper_tag8(&KEEPER), 0)),
            PROGRAM,
            cd,
            BIG,
            false,
            true,
        ),
        ai([0; 32], [0; 32], vec![], 0, false, false),
    ];
    for i in 0..n {
        let s = WideArrivalSlot {
            season_id: SID,
            dest,
            bell: BELL,
            faction: (i / 4) as u8,
            i: (i % 4) as u8,
            transit_slot: 0,
            host,
            citizen: OWNER,
            unit: 0,
            stance: 3,
            tile: 1,
            retreat_bps: 0,
            dealt_bps: 11_000,
            dep_mass: 200_000,
            flags: if i == 1 { AS::FLAG_CREATED_DAY } else { 0 },
            beneficiary: KEEPER,
            rent_to: RENT_TO,
            ev_slot: 105,
            ev_price: 1_000_000,
            ev_limit: 100_000,
            ev_loaded: 100_000,
            claimed: false,
        };
        let slot = ExpeditionArrivalSlot::new(&ctx, s, 1000 + i as u16).unwrap();
        a.push(ai(
            wa::arrival_slot_address(&ctx, dest, BELL, s.faction, s.i),
            PROGRAM,
            slot.to_bytes(&ctx).unwrap().to_vec(),
            BIG,
            false,
            true,
        ));
        a.push(anchor.clone());
    }
    a
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

fn command(n: u8) -> wix::ClaimDefence {
    wix::ClaimDefence { day: 0, n }
}

fn execute(a: &[AccountInfo], n: u8) -> R<()> {
    claim_expedition_defence(&Pubkey::new_from_array(PROGRAM), a, &command(n))
}

fn fail(a: &[AccountInfo], n: u8) -> crate::Error {
    let before = snapshot(a);
    let error = execute(a, n).unwrap_err();
    assert_eq!(snapshot(a), before);
    error
}

fn slot(a: &[AccountInfo], i: usize) -> ExpeditionArrivalSlot {
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    ExpeditionArrivalSlot::read(&ctx, &a[5 + 2 * i].try_borrow_data().unwrap()).unwrap()
}

fn edit_slot(a: &[AccountInfo], i: usize, f: impl FnOnce(&mut WideArrivalSlot)) {
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let s = slot(a, i);
    let mut common = *s.common();
    f(&mut common);
    let next = ExpeditionArrivalSlot::new(&ctx, common, s.worn_bps()).unwrap();
    a[5 + 2 * i]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&next.to_bytes(&ctx).unwrap());
}

fn claimed(a: &[AccountInfo]) -> u64 {
    Ro(&a[3].try_borrow_data().unwrap())
        .u64(DC::CLAIMED)
        .unwrap()
}

fn native_slot(a: &mut [AccountInfo], i: usize) {
    let mut s = *slot(a, i).common();
    s.host = WideHostRef::new(s.dest, 0, 1, 0).unwrap();
    let mut d = vec![0; AS::SIZE];
    s.write(&mut d).unwrap();
    a[5 + 2 * i]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&d);
}

#[test]
fn six_v2_slots_pay_exact_refunds_and_only_claimed_bytes_change() {
    let a = fixture(6);
    let before = snapshot(&a);
    let params = DefenceParams {
        defence_cap_milli: 1000,
        tip_min: 2500,
    };
    let expected: u64 = (0..6)
        .map(|i| fees::defence_refund(&slot(&a, i).common().evidence(), &params))
        .sum();
    assert_eq!(expected, 6 * 98_852 + 300);
    execute(&a, 6).unwrap();
    assert_eq!(claimed(&a), expected);
    let mut after = before.clone();
    after[0].0 += expected;
    after[2].0 -= expected;
    Rw(&mut after[2].1)
        .set_u64(DP::PAID_TOTAL, expected)
        .unwrap();
    Rw(&mut after[2].1).set_u64(DP::CLAIMS, 6).unwrap();
    Rw(&mut after[3].1).set_u64(DC::CLAIMED, expected).unwrap();
    Rw(&mut after[3].1).set_u32(DC::COUNT, 6).unwrap();
    for i in 0..6 {
        after[5 + 2 * i].1[AS::CLAIMED] = 1;
        assert_eq!(slot(&a, i).worn_bps(), 1000 + i as u16);
        assert_eq!(slot(&a, i).common().citizen, OWNER);
        assert!(WideArrivalSlot::read(&a[5 + 2 * i].try_borrow_data().unwrap()).is_err());
    }
    assert_eq!(snapshot(&a), after);
    assert_eq!(fail(&a, 6), FrontierError::NotEligible.into());
}

#[test]
fn native_dispatch_and_private_counterpart_keep_strict_versions() {
    let p = Pubkey::new_from_array(PROGRAM);
    let a = fixture(1);
    let before = snapshot(&a);
    assert_eq!(
        crate::dispatch(&p, &a, &command(1).to_bytes().unwrap()).err(),
        Some(BAD_ACCOUNT),
    );
    assert_eq!(snapshot(&a), before);
    let mut a = fixture(1);
    native_slot(&mut a, 0);
    assert_eq!(fail(&a, 1), BAD_ACCOUNT);
    let before = snapshot(&a);
    crate::dispatch(&p, &a, &command(1).to_bytes().unwrap()).unwrap();
    let mut expected_slot = before[5].1.clone();
    expected_slot[AS::CLAIMED] = 1;
    assert_eq!(&a[5].try_borrow_data().unwrap()[..], &expected_slot);
    assert_eq!(claimed(&a), 98_852);
    for native_i in 0..2 {
        let mut a = fixture(2);
        native_slot(&mut a, native_i);
        assert_eq!(fail(&a, 2), BAD_ACCOUNT);
        let before = snapshot(&a);
        assert!(crate::dispatch(&p, &a, &command(2).to_bytes().unwrap()).is_err());
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn native_and_expedition_claims_share_day_allowance_in_both_orders() {
    for native_first in [false, true] {
        let mut a = fixture(2);
        let native_i = if native_first { 0 } else { 1 };
        native_slot(&mut a, native_i);
        Rw(&mut a[2].try_borrow_mut_data().unwrap())
            .set_u64(DP::PER_BELL_REGION_CAP, 17)
            .unwrap();
        Rw(&mut a[2].try_borrow_mut_data().unwrap())
            .set_u64(DP::PER_KEEPER_DAY_CAP, 25)
            .unwrap();
        for i in 0..2 {
            let mut selected = a[..5].to_vec();
            selected.extend_from_slice(&a[5 + 2 * i..7 + 2 * i]);
            if i == native_i {
                claim_defence(&Pubkey::new_from_array(PROGRAM), &selected, &command(1)).unwrap();
            } else {
                execute(&selected, 1).unwrap();
            }
            assert_eq!(claimed(&a), if i == 0 { 17 } else { 25 });
        }
        assert_eq!(
            Ro(&a[3].try_borrow_data().unwrap()).u32(DC::COUNT).unwrap(),
            2
        );
        assert_eq!(
            Ro(&a[2].try_borrow_data().unwrap())
                .u64(DP::PAID_TOTAL)
                .unwrap(),
            25
        );
    }
}

#[test]
fn caps_pool_rent_and_zero_payment_still_consume_slot_entitlement() {
    for (region, day, available, prior, expected) in [
        (17, 100, 100, 0, 17),
        (100, 23, 100, 20, 3),
        (100, 100, 7, 0, 7),
        (100, 100, 0, 0, 0),
        (100, 0, 100, 0, 0),
        (0, 100, 100, 0, 0),
        (100, 10, 100, 11, 0),
    ] {
        let a = fixture(2);
        let mut pool = a[2].try_borrow_mut_data().unwrap();
        Rw(&mut pool)
            .set_u64(DP::PER_BELL_REGION_CAP, region)
            .unwrap();
        Rw(&mut pool).set_u64(DP::PER_KEEPER_DAY_CAP, day).unwrap();
        drop(pool);
        Rw(&mut a[3].try_borrow_mut_data().unwrap())
            .set_u64(DC::CLAIMED, prior)
            .unwrap();
        let rent = init::rent(DP::SIZE).unwrap();
        **a[2].try_borrow_mut_lamports().unwrap() = rent + available;
        execute(&a, 2).unwrap();
        assert_eq!(claimed(&a), prior + expected);
        assert_eq!(a[0].lamports(), BIG + expected);
        assert_eq!(a[2].lamports(), rent + available - expected);
        assert_eq!(
            Ro(&a[2].try_borrow_data().unwrap())
                .u64(DP::CLAIMS)
                .unwrap(),
            2
        );
        assert!(slot(&a, 0).common().claimed && slot(&a, 1).common().claimed);
        assert_eq!(fail(&a, 2), FrontierError::NotEligible.into());
    }
    let a = fixture(1);
    let below_rent = init::rent(DP::SIZE).unwrap() - 1;
    **a[2].try_borrow_mut_lamports().unwrap() = below_rent;
    execute(&a, 1).unwrap();
    assert_eq!(claimed(&a), 0);
    assert_eq!(a[2].lamports(), below_rent);
    assert!(slot(&a, 0).common().claimed);
}

#[test]
fn separate_bell_region_groups_receive_their_own_per_call_cap() {
    let mut a = fixture(3);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let original = *slot(&a, 0).common();
    let original_region = wr::wide_region(original.dest.coord());
    let other_coord = (130..=256)
        .map(|p| WideCoord::checked(p, 0).unwrap())
        .find(|&c| wr::wide_region(c) != original_region)
        .unwrap();
    for (i, bell, dest) in [
        (1, BELL - 1, original.dest),
        (
            2,
            BELL,
            ProvinceKey::new(original.dest.world(), other_coord),
        ),
    ] {
        let mut common = *slot(&a, i).common();
        common.bell = bell;
        common.dest = dest;
        let next = ExpeditionArrivalSlot::new(&ctx, common, 1000).unwrap();
        a[5 + 2 * i] = ai(
            wa::arrival_slot_address(&ctx, dest, bell, common.faction, common.i),
            PROGRAM,
            next.to_bytes(&ctx).unwrap().to_vec(),
            BIG,
            false,
            true,
        );
        let region = wr::wide_region(dest.coord());
        let mut anchor = a[6].try_borrow_data().unwrap().to_vec();
        let mut w = Rw(&mut anchor);
        w.set_u32(BA::BELL, bell).unwrap();
        w.set_u8(BA::REGION, region).unwrap();
        w.set_i64(BA::A, ANCHOR - (BELL - bell) as i64 * 600)
            .unwrap();
        let clock = SeasonClock::read(&a[1].try_borrow_data().unwrap()).unwrap();
        w.set_u64(BA::ROUND, clock.tlock_round(bell)).unwrap();
        a[6 + 2 * i] = ai(
            ctx.bell_anchor(bell, region),
            PROGRAM,
            anchor,
            BIG,
            false,
            false,
        );
    }
    Rw(&mut a[2].try_borrow_mut_data().unwrap())
        .set_u64(DP::PER_BELL_REGION_CAP, 17)
        .unwrap();
    execute(&a, 3).unwrap();
    assert_eq!(claimed(&a), 51);
}

#[test]
fn evidence_refunds_keep_tip_rounding_and_u128_fallback_arithmetic() {
    for (price, limit, priority, exact) in [
        (500_001, 100_000, 433, 38_060),
        (u64::MAX, 1_400_000, 0, 1_398_852),
    ] {
        let a = fixture(1);
        let mut sd = a[1].try_borrow_mut_data().unwrap();
        let mut w = Rw(&mut sd);
        w.set_u32(S::MIN_REVEAL_PRIORITY_MILLI, priority).unwrap();
        w.set_u32(S::REVEAL_CU_LIMIT, 26_000).unwrap();
        w.set_u32(S::REVEAL_LOADED_LIMIT, fees::LOADED_DEFAULT)
            .unwrap();
        drop(sd);
        edit_slot(&a, 0, |s| {
            s.ev_price = price;
            s.ev_limit = limit;
        });
        let params = DefenceParams {
            defence_cap_milli: 1000,
            tip_min: fees::min_tip_lamports(priority, 26_000, fees::LOADED_DEFAULT),
        };
        let expected = fees::defence_refund(&slot(&a, 0).common().evidence(), &params);
        assert_eq!(expected, exact);
        execute(&a, 1).unwrap();
        assert_eq!(claimed(&a), expected);
        assert_eq!(a[0].lamports(), BIG + expected);
        assert_eq!(a[2].lamports(), BIG - expected);
    }
}

#[test]
fn grace_lateness_created_day_and_settled_flags_match_existing_rules() {
    let a = fixture(1);
    let clock = SeasonClock::read(&a[1].try_borrow_data().unwrap()).unwrap();
    let end = clock.reveal_close(BELL, ANCHOR) + DC::CLAIM_GRACE_BELLS as i64 * 600;
    prologue::set_test_clock(end - 1, 110);
    execute(&a, 1).unwrap();
    let a = fixture(1);
    prologue::set_test_clock(end, 110);
    assert_eq!(fail(&a, 1), FrontierError::WindowClosed.into());
    for flags in [0, AS::FLAG_SETTLED, AS::FLAG_CREATED_DAY, AS::FLAGS_MASK] {
        let a = fixture(1);
        a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
        edit_slot(&a, 0, |s| s.flags = flags);
        execute(&a, 1).unwrap();
        assert_eq!(
            claimed(&a),
            98_852
                + if flags & AS::FLAG_CREATED_DAY != 0 {
                    300
                } else {
                    0
                }
        );
        assert_eq!(slot(&a, 0).common().flags, flags);
    }
    for evidence_slot in [99, 100, 104] {
        let a = fixture(1);
        edit_slot(&a, 0, |s| s.ev_slot = evidence_slot);
        assert_eq!(fail(&a, 1), FrontierError::NotEligible.into());
    }
}

#[test]
fn malformed_slot_versions_owners_wear_and_families_refuse_atomically() {
    for case in 0..12 {
        let a = fixture(1);
        let mut bytes = a[5].try_borrow_mut_data().unwrap();
        match case {
            0 => bytes[AS::FAMILY_VERSION] = 9,
            1 => bytes[AS::CITIZEN..AS::CITIZEN + 32].fill(0),
            2 => {
                bytes[WORN_BPS_OFFSET..WORN_BPS_OFFSET + 2].copy_from_slice(&u16::MAX.to_le_bytes())
            }
            3 => bytes[WORN_BPS_OFFSET + 2] = 1,
            4 => bytes[AS::CLAIMED] = 2,
            5 => bytes[AS::RSV_29] = 1,
            6 => bytes[AS::FLAGS] = 4,
            7 => bytes[AS::WORLD] ^= 1,
            8 => bytes[AS::HDR_MAGIC] ^= 1,
            9 => bytes[AS::SEASON_ID] ^= 1,
            10 => {
                let dest = ExpeditionArrivalSlot::read(&addr::ctx(&key(&a[1]), &PROGRAM), &bytes)
                    .unwrap()
                    .common()
                    .dest;
                let host = WideHostRef::new(dest, 0, 1, 0).unwrap();
                bytes[AS::HOST..AS::HOST + 56].copy_from_slice(&host.to_bytes());
            }
            _ => bytes[AS::SORT_KEY..AS::SORT_KEY + 17]
                .copy_from_slice(&WideCoord::checked(128, 0).unwrap().sort_key()),
        }
        drop(bytes);
        assert_eq!(fail(&a, 1), BAD_ACCOUNT);
    }
}

#[test]
fn account_identity_evidence_and_shape_refusals_precede_writes() {
    for case in 0..18 {
        let mut a = fixture(2);
        match case {
            0 => {
                a[7] = a[5].clone();
                a[8] = a[6].clone();
            }
            1 => edit_slot(&a, 0, |s| s.beneficiary = RENT_TO),
            2 => edit_slot(&a, 0, |s| s.claimed = true),
            3 => edit_slot(&a, 0, |s| s.ev_price = 0),
            4 => edit_slot(&a, 0, |s| s.bell += 1),
            5 => a[6].try_borrow_mut_data().unwrap()[BA::REGION] ^= 1,
            6 => a[6].try_borrow_mut_data().unwrap()[BA::BELL] ^= 1,
            7 => a[3].try_borrow_mut_data().unwrap()[DC::BENEFICIARY] ^= 1,
            8 => a[3].try_borrow_mut_data().unwrap()[DC::DAY] = 1,
            9 => a[0].is_signer = false,
            10 => a[7].is_writable = false,
            11 => a[2].is_writable = false,
            12 => a[3].is_writable = false,
            13 => {
                a.pop();
            }
            14 => {
                a.push(a[6].clone());
            }
            15 => {
                let data = a[5].try_borrow_data().unwrap().to_vec();
                a[5] = ai(key(&a[5]), [0; 32], data, BIG, false, true);
            }
            16 => a[6] = ai(key(&a[6]), [0; 32], vec![], 0, false, false),
            _ => a[1].try_borrow_mut_data().unwrap()[S::PROGRAM_VERSION] ^= 1,
        }
        fail(&a, 2);
    }
    let a = fixture(1);
    assert_eq!(fail(&a, 0), FrontierError::BadData.into());
    assert_eq!(fail(&a, 7), FrontierError::BadData.into());
    let before = snapshot(&a);
    assert_eq!(
        claim_expedition_defence(
            &Pubkey::new_from_array(PROGRAM),
            &a,
            &wix::ClaimDefence { day: 1, n: 1 }
        )
        .err(),
        Some(FrontierError::BadData.into()),
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn counters_and_recipient_overflows_are_atomic() {
    for case in 0..4 {
        let a = fixture(2);
        match case {
            0 => Rw(&mut a[3].try_borrow_mut_data().unwrap())
                .set_u32(DC::COUNT, u32::MAX)
                .unwrap(),
            1 => Rw(&mut a[2].try_borrow_mut_data().unwrap())
                .set_u64(DP::CLAIMS, u64::MAX)
                .unwrap(),
            2 => Rw(&mut a[2].try_borrow_mut_data().unwrap())
                .set_u64(DP::PAID_TOTAL, u64::MAX)
                .unwrap(),
            _ => **a[0].try_borrow_mut_lamports().unwrap() = u64::MAX,
        }
        assert_eq!(fail(&a, 2), OVERFLOW);
    }
}

#[test]
fn all_output_data_and_balance_borrows_precede_every_effect() {
    for at in [2, 3, 5, 7] {
        for mutable in [false, true] {
            let a = fixture(2);
            let before = snapshot(&a);
            let result = if mutable {
                let _held = a[at].try_borrow_mut_data().unwrap();
                execute(&a, 2)
            } else {
                let _held = a[at].try_borrow_data().unwrap();
                execute(&a, 2)
            };
            assert_eq!(result.err(), Some(ProgramError::AccountBorrowFailed.into()));
            assert_eq!(snapshot(&a), before);
        }
    }
    for at in [0, 2] {
        let a = fixture(2);
        let before = snapshot(&a);
        let held = a[at].try_borrow_lamports().unwrap();
        assert_eq!(
            execute(&a, 2).err(),
            Some(ProgramError::AccountBorrowFailed.into())
        );
        drop(held);
        assert_eq!(snapshot(&a), before);
    }
    // Every supplied role is read by the common account-list prologue. The
    // private v2 probe must refuse an exclusive balance borrow, not panic.
    let a = fixture(2);
    for at in 0..a.len() {
        let before = snapshot(&a);
        let held = a[at].try_borrow_mut_lamports().unwrap();
        assert_eq!(
            execute(&a, 2).err(),
            Some(ProgramError::AccountBorrowFailed.into())
        );
        drop(held);
        assert_eq!(snapshot(&a), before);
    }
    let mut a = fixture(2);
    a[0].lamports = a[2].lamports.clone();
    assert_eq!(fail(&a, 2), ProgramError::AccountBorrowFailed.into());
}

#[test]
fn absent_claim_with_unfunded_keeper_refuses_before_allocation_cpi() {
    let mut a = fixture(1);
    a[3] = ai(key(&a[3]), [0; 32], vec![], 0, false, true);
    **a[0].try_borrow_mut_lamports().unwrap() = 0;
    assert_eq!(fail(&a, 1), FrontierError::Insufficient.into());
}

#[test]
fn real_claim_is_orthogonal_to_retained_owner_and_once_only_gather_wear() {
    // Actual claim writes feed the existing pure transport transition. This
    // is not a claim that the full Gather account writer or its producers ran.
    for claim_first in [false, true] {
        let a = fixture(1);
        let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
        let s = slot(&a, 0);
        let c = s.common();
        let departed = OwnedBridgeTransit::new(
            &ctx,
            c.transit_slot,
            WideTransit::depart(
                wm::HOST_IDENTITY_FULL_REF_V1,
                c.host,
                c.unit,
                c.faction,
                TileAddress::new(c.host.key(), 0).unwrap(),
                10,
                BELL,
                GENESIS + 6000,
                c.dep_mass,
                crate::proc::host::DEPART_STAMINA,
                10_000,
                [0x41; 32],
                0,
                0,
                RENT_TO,
            )
            .unwrap(),
            OWNER,
        )
        .unwrap();
        let settled = departed
            .settle_origin(&ctx, false, Some((80_001, 40, 0)))
            .unwrap();
        if claim_first {
            execute(&a, 1).unwrap();
        }
        let gathered = settled.gather_worn(&ctx, &slot(&a, 0)).unwrap();
        if !claim_first {
            execute(&a, 1).unwrap();
        }
        let claimed_slot = slot(&a, 0);
        let repeated = gathered.gather_worn(&ctx, &claimed_slot).unwrap();
        assert_eq!(repeated, gathered);
        assert_eq!(repeated.original_owner(), OWNER);
        assert_eq!(repeated.transit().dep_mass, 200_000);
        assert_eq!(
            repeated.transit().troops_after,
            permutation_rules::frontier::structure::wear(80_001, 1000) as u32
        );
        assert_eq!(claimed_slot.worn_bps(), 1000);
        assert_eq!(fail(&a, 1), FrontierError::NotEligible.into());
    }
}
