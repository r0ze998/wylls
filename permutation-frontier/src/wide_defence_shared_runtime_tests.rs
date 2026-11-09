//! Direct host dispatch across both slot families, sharing present accounts.
//! Literal fixtures and public address derivation only; no lifecycle or CPI.
use super::*;
use crate::layout::arrival_slot as AS;

fn legacy_command() -> [u8; frontier_abi::ix::ClaimDefence::LEN] {
    frontier_abi::ix::ClaimDefence { day: 0, n: 1 }.to_bytes()
}

fn mixed_accounts() -> (Vec<AccountInfo<'static>>, Vec<AccountInfo<'static>>) {
    let wide = accounts(1);
    {
        let mut d = wide[2].try_borrow_mut_data().unwrap();
        put(&mut d, DP::PER_BELL_REGION_CAP, &17u64.to_le_bytes());
        put(&mut d, DP::PER_KEEPER_DAY_CAP, &25u64.to_le_bytes());
    }
    edit_slot(&wide, |s| {
        s.flags = wa::wide_arrival_slot::FLAG_SETTLED | wa::wide_arrival_slot::FLAG_CREATED_DAY;
    });

    // Clone AccountInfos, not account bytes: both calls must mutate the
    // very same keeper, pool and existing keeper/day claim.
    let mut legacy = wide[..5].to_vec();
    let ctx = crate::addr::ctx(&wide[1].key.to_bytes(), &PROGRAM);
    let (p, q) = (1i16, 0i16);
    let region = permutation_rules::frontier::geometry::region_of(
        permutation_rules::frontier::geometry::ProvinceCoord::new(p as i32, q as i32),
    );
    let mut slot = vec![0; AS::SIZE];
    crate::layout::init_header(
        &mut slot,
        frontier_abi::layout::AccountKind::ArrivalSlot,
        SEASON_ID,
    )
    .unwrap();
    put(&mut slot, AS::P, &p.to_le_bytes());
    put(&mut slot, AS::Q, &q.to_le_bytes());
    put(&mut slot, AS::BELL, &10u32.to_le_bytes());
    put(&mut slot, AS::DEP_MASS, &100000u32.to_le_bytes());
    put(&mut slot, AS::DEALT_BPS, &10000u16.to_le_bytes());
    slot[AS::FLAGS] = AS::FLAG_SETTLED | AS::FLAG_CREATED_DAY;
    put(&mut slot, AS::BENEFICIARY, &PAYER);
    put(&mut slot, AS::RENT_TO, &ANYONE);
    put(&mut slot, AS::EV_SLOT, &105u64.to_le_bytes());
    put(&mut slot, AS::EV_PRICE, &1_000_000u64.to_le_bytes());
    put(&mut slot, AS::EV_LIMIT, &100000u32.to_le_bytes());
    put(&mut slot, AS::EV_LOADED, &100000u32.to_le_bytes());
    legacy.push(info(
        leak(
            ctx.arrival_slot(p as i32, q as i32, 10, 0, 0),
            PROGRAM,
            slot,
            0,
            BIG,
        ),
        false,
        true,
    ));
    let anchor_key = ctx.bell_anchor(10, region);
    let anchor = if wide[6].key.to_bytes() == anchor_key {
        wide[6].clone()
    } else {
        let mut d = wide[6].try_borrow_data().unwrap().to_vec();
        d[BA::REGION] = region;
        info(leak(anchor_key, PROGRAM, d, 0, BIG), false, false)
    };
    legacy.push(anchor);
    (legacy, wide)
}

#[test]
fn legacy_and_wide_claims_share_day_allowance_in_both_orders() {
    let _g = begin();
    for wide_first in [false, true] {
        let (legacy, wide) = mixed_accounts();
        let before_legacy = snapshot(&legacy);
        let before_wide = snapshot(&wide);
        let log_start = LOGS.lock().unwrap().len();
        let legacy_data = legacy_command();
        let wide_data = command(1);
        let (first, first_data, second, second_data) = if wide_first {
            (&wide, &wide_data[..], &legacy, &legacy_data[..])
        } else {
            (&legacy, &legacy_data[..], &wide, &wide_data[..])
        };
        for (a, data, total, count) in [
            (first, first_data, 17u64, 1u32),
            (second, second_data, 25u64, 2u32),
        ] {
            exec(a, data).unwrap();
            for shared in [&legacy, &wide] {
                assert_eq!(amount(shared), total);
                assert_eq!(shared[0].lamports(), before_legacy[0].0 + total);
                assert_eq!(shared[2].lamports(), before_legacy[2].0 - total);
                assert_eq!(shared[3].lamports(), before_legacy[3].0);
                let claim = shared[3].try_borrow_data().unwrap();
                assert_eq!(Ro(&claim).u32(DC::COUNT).unwrap(), count);
                assert_eq!(Ro(&claim).u32(DC::DAY).unwrap(), 0);
                assert_eq!(Ro(&claim).arr::<32>(DC::BENEFICIARY).unwrap(), PAYER);
                let pool = shared[2].try_borrow_data().unwrap();
                assert_eq!(Ro(&pool).u64(DP::PAID_TOTAL).unwrap(), total);
                assert_eq!(Ro(&pool).u64(DP::CLAIMS).unwrap(), count as u64);
            }
            let legacy_claimed = !wide_first || count == 2;
            let wide_claimed = wide_first || count == 2;
            for (a, before, offset, claimed) in [
                (&legacy, &before_legacy, AS::CLAIMED, legacy_claimed),
                (
                    &wide,
                    &before_wide,
                    wa::wide_arrival_slot::CLAIMED,
                    wide_claimed,
                ),
            ] {
                let mut expected = before[5].1.clone();
                expected[offset] = claimed as u8;
                assert_eq!(&a[5].try_borrow_data().unwrap()[..], &expected);
                assert_eq!(a[5].lamports(), before[5].0);
                assert_eq!(*a[5].owner, before[5].2);
                let after = snapshot(a);
                for index in [1, 4, 6] {
                    assert_eq!(after[index], before[index]);
                }
            }
        }
        assert!(WIDE_LOGS.lock().unwrap().is_empty());
        let logs = LOGS.lock().unwrap();
        assert_eq!(logs.len(), log_start + 2);
        for (body, paid) in logs[log_start..].iter().zip([17u64, 8]) {
            let record = frontier_abi::log::decode(body).unwrap();
            assert_eq!(record.kind, frontier_abi::log::Kind::DEFENCE_CLAIM);
            assert_eq!(record.bell, 11);
            assert_eq!(record.key, &PAYER);
            assert_eq!(record.n_links, 0);
            let mut payload = vec![0; 14];
            payload[4] = 1;
            payload[5..13].copy_from_slice(&paid.to_le_bytes());
            assert_eq!(record.payload, &payload); // day 0, one slot, partial 0
        }
    }
}

#[test]
fn legacy_and_wide_claims_reject_each_others_slot_bytes() {
    let _g = begin();
    let (legacy, wide) = mixed_accounts();
    assert_eq!(
        fail(&wide, &legacy_command()),
        ProgramError::from(crate::error::BAD_ACCOUNT)
    );
    assert_eq!(
        fail(&legacy, &command(1)),
        ProgramError::from(crate::error::BAD_ACCOUNT)
    );
    assert_eq!(amount(&legacy), 0);
    assert_eq!(
        Ro(&legacy[3].try_borrow_data().unwrap())
            .u32(DC::COUNT)
            .unwrap(),
        0
    );
    assert_eq!(
        Ro(&wide[2].try_borrow_data().unwrap())
            .u64(DP::CLAIMS)
            .unwrap(),
        0
    );
}
