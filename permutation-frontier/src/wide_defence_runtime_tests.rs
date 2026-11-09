//! Direct, literal-account dispatch. No lifecycle executor or crypto.
use super::*;
use crate::layout::{defence_claim as DC, defence_pool as DP};
use frontier_abi::addr::{defence_claim_seed, keeper_tag8};

#[path = "wide_defence_close_runtime_tests.rs"]
mod wide_defence_close;

#[path = "wide_defence_shared_runtime_tests.rs"]
mod wide_defence_shared;

fn command(n: u8) -> Vec<u8> {
    wix::ClaimDefence { day: 0, n }.to_bytes().unwrap().to_vec()
}
fn accounts(n: usize) -> Vec<AccountInfo<'static>> {
    let base = fixture();
    let season = base[2].clone();
    {
        let mut d = season.try_borrow_mut_data().unwrap();
        d[S::LATENESS_SLOTS] = 5;
        put(&mut d, S::DEFENCE_CAP_MILLI, &1000u32.to_le_bytes());
    }
    let ctx = crate::addr::ctx(&season.key.to_bytes(), &PROGRAM);
    let h = WideHolding::read(&base[4].try_borrow_data().unwrap()).unwrap();
    let dest = ProvinceKey::new(h.world, h.coord);
    let region = frontier_abi::world_index::rules::wide_region(h.coord);
    let account =
        |key, d, lamports, writable| info(leak(key, PROGRAM, d, 0, lamports), false, writable);
    let mut pd = vec![0; DP::SIZE];
    crate::layout::init_header(
        &mut pd,
        frontier_abi::layout::AccountKind::DefencePool,
        SEASON_ID,
    )
    .unwrap();
    put(&mut pd, DP::PER_BELL_REGION_CAP, &u64::MAX.to_le_bytes());
    put(&mut pd, DP::PER_KEEPER_DAY_CAP, &u64::MAX.to_le_bytes());
    let mut cd = vec![0; DC::SIZE];
    crate::layout::init_header(
        &mut cd,
        frontier_abi::layout::AccountKind::DefenceClaim,
        SEASON_ID,
    )
    .unwrap();
    put(&mut cd, DC::BENEFICIARY, &PAYER);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut ad,
        K2::BellAnchor,
        SEASON_ID
    ));
    put(&mut ad, BA::BELL, &10u32.to_le_bytes());
    ad[BA::REGION] = region;
    put(&mut ad, BA::A, &(GENESIS + 6000).to_le_bytes());
    put(&mut ad, BA::SLOT, &100u64.to_le_bytes());
    let anchor = account(ctx.bell_anchor(10, region), ad, BIG, false);
    let mut a = vec![
        wallet(PAYER, true, true, BIG),
        season,
        account(ctx.defence_pool(), pd, BIG, true),
        account(
            ctx.of(&defence_claim_seed(&keeper_tag8(&PAYER), 0)),
            cd,
            BIG,
            true,
        ),
        info(leak(SYSTEM, SYSTEM, vec![], 0, 0), false, false),
    ];
    for i in 0..n {
        let s = wa::WideArrivalSlot {
            season_id: SEASON_ID,
            dest,
            bell: 10,
            faction: (i / 4) as u8,
            i: (i % 4) as u8,
            transit_slot: 0,
            host: WideHostRef::new(dest, 0, 2, 1).unwrap(),
            citizen: [0x46; 32],
            unit: 0,
            stance: 0,
            tile: 0,
            retreat_bps: 0,
            dealt_bps: 10000,
            dep_mass: 100000,
            flags: 0,
            beneficiary: PAYER,
            rent_to: ANYONE,
            ev_slot: 105,
            ev_price: 1_000_000,
            ev_limit: 100000,
            ev_loaded: 100000,
            claimed: false,
        };
        let mut d = vec![0; wa::wide_arrival_slot::SIZE];
        s.write(&mut d).unwrap();
        a.push(account(
            wa::arrival_slot_address(&ctx, dest, 10, s.faction, s.i),
            d,
            BIG,
            true,
        ));
        a.push(anchor.clone());
    }
    at_bell(11);
    a
}
fn edit_slot(a: &[AccountInfo<'static>], f: impl FnOnce(&mut wa::WideArrivalSlot)) {
    let mut d = a[5].try_borrow_mut_data().unwrap();
    let mut s = wa::WideArrivalSlot::read(&d).unwrap();
    f(&mut s);
    s.write(&mut d).unwrap();
}
fn fail(a: &[AccountInfo<'static>], d: &[u8]) -> ProgramError {
    let before = snapshot(a);
    let logs = LOGS.lock().unwrap().clone();
    let wide_logs = WIDE_LOGS.lock().unwrap().clone();
    let error = exec(a, d).unwrap_err();
    assert_eq!(snapshot(a), before);
    assert_eq!(*LOGS.lock().unwrap(), logs);
    assert_eq!(*WIDE_LOGS.lock().unwrap(), wide_logs);
    error
}
fn amount(a: &[AccountInfo<'static>]) -> u64 {
    Ro(&a[3].try_borrow_data().unwrap())
        .u64(DC::CLAIMED)
        .unwrap()
}

#[test]
fn six_slots_pay_shared_claim_and_keep_immutable_records() {
    let _g = begin();
    let a = accounts(6);
    let before = snapshot(&a);
    exec(&a, &command(6)).unwrap();
    let paid = amount(&a);
    assert!(paid > 0);
    assert_eq!(a[0].lamports(), before[0].0 + paid);
    assert_eq!(a[2].lamports(), before[2].0 - paid);
    assert_eq!(
        Ro(&a[3].try_borrow_data().unwrap()).u32(DC::COUNT).unwrap(),
        6
    );
    assert_eq!(
        Ro(&a[2].try_borrow_data().unwrap())
            .u64(DP::CLAIMS)
            .unwrap(),
        6
    );
    for i in 0..6 {
        let d = a[5 + 2 * i].try_borrow_data().unwrap();
        let s = wa::WideArrivalSlot::read(&d).unwrap();
        assert!(s.claimed);
        let mut expected = before[5 + 2 * i].1.clone();
        expected[wa::wide_arrival_slot::CLAIMED] = 1;
        assert_eq!(&d[..], &expected);
        assert_eq!(a[5 + 2 * i].lamports(), before[5 + 2 * i].0);
    }
    assert!(WIDE_LOGS.lock().unwrap().is_empty());
    let logs = LOGS.lock().unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0][1], frontier_abi::log::Kind::DEFENCE_CLAIM as u8);
    drop(logs);
    fail(&a, &command(6));
}

#[test]
fn malformed_identity_evidence_and_duplicate_refuse_without_effects() {
    let _g = begin();
    for case in 0..11 {
        let mut a = accounts(2);
        match case {
            0 => {
                a[7] = a[5].clone();
                a[8] = a[6].clone();
            }
            1 => edit_slot(&a, |s| s.beneficiary = ANYONE),
            2 => edit_slot(&a, |s| s.claimed = true),
            3 => edit_slot(&a, |s| s.ev_slot = 104),
            4 => edit_slot(&a, |s| s.ev_price = 0),
            5 => edit_slot(&a, |s| s.bell = 9),
            6 => edit_slot(&a, |s| s.season_id += 1),
            7 => a[6] = wallet(ANYONE, false, false, 0),
            8 => {
                a[6].try_borrow_mut_data().unwrap()[BA::REGION] ^= 1;
            }
            9 => {
                put(
                    &mut a[3].try_borrow_mut_data().unwrap(),
                    DC::BENEFICIARY,
                    &ANYONE,
                );
            }
            _ => {
                put(
                    &mut a[3].try_borrow_mut_data().unwrap(),
                    DC::DAY,
                    &1u32.to_le_bytes(),
                );
            }
        }
        fail(&a, &command(2));
    }
    let a = accounts(1);
    let mut d = command(1);
    d[4] = 1;
    fail(&a, &d);
}

#[test]
fn grace_boundary_status_and_created_day_evidence() {
    let _g = begin();
    let a = accounts(1);
    crate::prologue::set_test_clock(GENESIS + 9600 - 1, 1000);
    exec(&a, &command(1)).unwrap();
    let a = accounts(1);
    crate::prologue::set_test_clock(GENESIS + 9600, 1000);
    fail(&a, &command(1));
    let a = accounts(1);
    a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
    exec(&a, &command(1)).unwrap();
    let plain = amount(&a);
    let b = accounts(1);
    edit_slot(&b, |s| s.flags = wa::wide_arrival_slot::FLAG_CREATED_DAY);
    exec(&b, &command(1)).unwrap();
    assert!(amount(&b) > plain);
}

#[test]
fn per_call_region_and_shared_actual_paid_day_caps_empty_pool() {
    let _g = begin();
    for (region, day, available, before, expected, partial) in [
        (17, 100, 100, 0, 17, 0),
        (100, 23, 100, 20, 3, 0),
        (100, 100, 7, 0, 7, 1),
        (100, 100, 0, 0, 0, 1),
        (100, 0, 100, 0, 0, 0),
        (0, 100, 100, 0, 0, 0),
    ] {
        let a = accounts(2);
        {
            let mut d = a[2].try_borrow_mut_data().unwrap();
            put(
                &mut d,
                DP::PER_BELL_REGION_CAP,
                &(region as u64).to_le_bytes(),
            );
            put(&mut d, DP::PER_KEEPER_DAY_CAP, &(day as u64).to_le_bytes());
        }
        put(
            &mut a[3].try_borrow_mut_data().unwrap(),
            DC::CLAIMED,
            &(before as u64).to_le_bytes(),
        );
        **a[2].try_borrow_mut_lamports().unwrap() =
            crate::init::rent(DP::SIZE).unwrap() + available;
        exec(&a, &command(2)).unwrap();
        assert_eq!(amount(&a), before + expected);
        assert!(
            wa::WideArrivalSlot::read(&a[5].try_borrow_data().unwrap())
                .unwrap()
                .claimed
        );
        let logs = LOGS.lock().unwrap();
        assert_eq!(logs.last().unwrap()[51], partial);
        drop(logs);
    }
}

#[test]
fn prefunded_shared_claim_rent_is_only_shortfall() {
    let _g = begin();
    let rent = crate::init::rent(DC::SIZE).unwrap();
    for prefund in [0, rent - 17, rent, rent + 71] {
        let mut a = accounts(1);
        let ck = a[3].key.to_bytes();
        a[3] = info(leak(ck, SYSTEM, vec![], DC::SIZE, prefund), false, true);
        **a[0].try_borrow_mut_lamports().unwrap() = rent.saturating_sub(prefund);
        exec(&a, &command(1)).unwrap();
        assert_eq!(a[0].lamports(), amount(&a));
        assert_eq!(a[3].lamports(), prefund.max(rent));
        assert_eq!(a[3].owner.to_bytes(), PROGRAM);
    }
}

#[test]
fn counter_and_recipient_overflows_are_failure_atomic() {
    let _g = begin();
    for case in 0..4 {
        let a = accounts(1);
        match case {
            0 => put(
                &mut a[3].try_borrow_mut_data().unwrap(),
                DC::COUNT,
                &u32::MAX.to_le_bytes(),
            ),
            1 => put(
                &mut a[2].try_borrow_mut_data().unwrap(),
                DP::CLAIMS,
                &u64::MAX.to_le_bytes(),
            ),
            2 => put(
                &mut a[2].try_borrow_mut_data().unwrap(),
                DP::PAID_TOTAL,
                &u64::MAX.to_le_bytes(),
            ),
            _ => **a[0].try_borrow_mut_lamports().unwrap() = u64::MAX,
        }
        fail(&a, &command(1));
    }
}

#[test]
fn existing_and_allocation_borrow_conflicts_precede_all_effects() {
    let _g = begin();
    for absent in [false, true] {
        for index in [2, 3, 5, 7] {
            let mut a = accounts(2);
            if absent {
                a[3] = info(
                    leak(a[3].key.to_bytes(), SYSTEM, vec![], DC::SIZE, 0),
                    false,
                    true,
                );
            }
            let before = snapshot(&a);
            let count = LOGS.lock().unwrap().len();
            let held = a[index].try_borrow_data().unwrap();
            assert!(exec(&a, &command(2)).is_err());
            drop(held);
            assert_eq!(snapshot(&a), before);
            assert_eq!(LOGS.lock().unwrap().len(), count);
        }
    }
}

#[test]
fn per_region_cap_resets_per_call_but_shared_day_does_not() {
    let _g = begin();
    let a = accounts(2);
    {
        let mut d = a[2].try_borrow_mut_data().unwrap();
        put(&mut d, DP::PER_BELL_REGION_CAP, &17u64.to_le_bytes());
        put(&mut d, DP::PER_KEEPER_DAY_CAP, &25u64.to_le_bytes());
    }
    exec(&a[..7], &command(1)).unwrap();
    assert_eq!(amount(&a), 17);
    let mut second = a[..5].to_vec();
    second.extend_from_slice(&a[7..9]);
    exec(&second, &command(1)).unwrap();
    assert_eq!(amount(&a), 25);
    assert_eq!(
        Ro(&a[3].try_borrow_data().unwrap()).u32(DC::COUNT).unwrap(),
        2
    );
}

#[test]
fn absent_anchor_insufficient_rent_and_lamport_borrows_refuse_atomically() {
    let _g = begin();
    let mut a = accounts(1);
    a[6] = info(
        leak(a[6].key.to_bytes(), SYSTEM, vec![], 0, 0),
        false,
        false,
    );
    fail(&a, &command(1));
    let mut a = accounts(1);
    a[3] = info(
        leak(a[3].key.to_bytes(), SYSTEM, vec![], DC::SIZE, 0),
        false,
        true,
    );
    **a[0].try_borrow_mut_lamports().unwrap() = 0;
    fail(&a, &command(1));
    for absent in [false, true] {
        for index in [0, 2] {
            let mut a = accounts(1);
            if absent {
                a[3] = info(
                    leak(a[3].key.to_bytes(), SYSTEM, vec![], DC::SIZE, 0),
                    false,
                    true,
                );
            }
            let before = snapshot(&a);
            let logs = LOGS.lock().unwrap().clone();
            let held = a[index].try_borrow_lamports().unwrap();
            assert!(exec(&a, &command(1)).is_err());
            drop(held);
            assert_eq!(snapshot(&a), before);
            assert_eq!(*LOGS.lock().unwrap(), logs);
        }
    }
}
