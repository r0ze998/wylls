//! Direct Resolve dispatch with literal gathered arrivals and an absent
//! roster. System CPIs use the parent's public-address-only host stubs.
//! No transaction executor or lifecycle/signature setup is used here.
use super::*;

fn arrival_accounts(prefund: u64, payer_balance: u64) -> Vec<AccountInfo<'static>> {
    let a = fixture();
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 1;
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        put(&mut pd, PV2::SCORE_NEXT_BELL, &10u32.to_le_bytes());
        put(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, &1u32.to_le_bytes());
    }
    let mut ra = resolve_accounts(&a, 10);
    let h = WideHolding::read(&a[4].try_borrow_data().unwrap()).unwrap();
    let pk = ProvinceKey::new(h.world, h.coord);
    let ctx = crate::addr::ctx(&a[2].key.to_bytes(), &PROGRAM);
    ra[0] = wallet(PAYER, true, true, payer_balance);
    ra[3] = info(
        leak(
            wro::roster_address(&ctx, pk),
            SYSTEM,
            vec![],
            wro::wide_roster::SIZE,
            prefund,
        ),
        false,
        true,
    );
    let mut day = wa::WideArrivalDay::new(SEASON_ID, pk, 0, PAYER);
    assert!(day.set(10));
    let mut db = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut db).unwrap();
    let mut ih = wa::WideClashInputsHdr::new(SEASON_ID, pk, 10, PAYER);
    ih.n_present = 1;
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    let mut cd = vec![0; wa::wide_clash_inputs::SIZE];
    ih.write(&mut cd).unwrap();
    wa::WideArrival {
        host: WideHostRef::new(
            ProvinceKey::new(h.world, WideCoord::checked(130, 0).unwrap()),
            0,
            2,
            1,
        )
        .unwrap(),
        citizen: [0x46; 32],
        dep_mass: 100_000,
        troops: 100_000,
        stamina: 61,
        retreat_bps: 0,
        dealt_bps: 10_000,
        faction: 1,
        unit: 0,
        tile: a[5].try_borrow_data().unwrap()[PV::SITES],
        stance: 0,
        present: true,
        fate: wa::wide_arrival::FATE_NONE,
        troops_after: 0,
    }
    .write_at(&mut cd, 4)
    .unwrap();
    ra[6] = info(
        leak(wa::clash_inputs_address(&ctx, pk, 10), PROGRAM, cd, 0, BIG),
        false,
        true,
    );
    ra[7] = info(
        leak(wa::arrival_day_address(&ctx, pk, 0), PROGRAM, db, 0, BIG),
        false,
        false,
    );
    at_bell(12);
    ra
}

fn resolve_data() -> Vec<u8> {
    wix::Resolve {
        bell: 10,
        beneficiary: ANYONE,
    }
    .to_bytes()
    .to_vec()
}

fn logs() -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    )
}

#[test]
fn staying_arrival_allocates_and_pairs_roster_with_pinned_rent_recipient() {
    let _g = begin();
    let rent = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    assert_eq!(
        rent, 23_496_960,
        "default host rent for the 3,248-byte roster"
    );
    for (prefund, payer_balance) in [(0, rent), (rent - 17, 17), (rent, 0), (rent + 71, 0)] {
        let a = arrival_accounts(prefund, payer_balance);
        assert!(crate::init::is_absent(&a[3]));
        let before_logs = logs();
        let original = wa::WideArrival::read_at(&a[6].try_borrow_data().unwrap(), 4)
            .unwrap()
            .unwrap();
        exec(&a, &resolve_data()).unwrap();
        assert_eq!(
            a[0].lamports(),
            payer_balance - rent.saturating_sub(prefund)
        );
        assert_eq!(a[3].lamports(), prefund.max(rent));
        assert_eq!(a[3].owner.to_bytes(), PROGRAM);
        let rd = a[3].try_borrow_data().unwrap();
        let r = WideRoster::read(&rd).unwrap();
        assert_eq!(r.rent_to, PAYER, "beneficiary is not the rent funder");
        let table = r.table(&rd).unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].2, original.host);
        let pd = a[2].try_borrow_data().unwrap();
        let entry = frontier_abi::entry::read_entry(&pd, table[0].0).unwrap();
        assert_eq!(entry.id, wide_host_alias(&original.host));
        assert_eq!(entry.troops, original.troops);
        assert_eq!(entry.state, EN::STATE_ROSTER);
        assert_eq!(entry.from_bell, 11);
        assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), 11);
        let cd = a[6].try_borrow_data().unwrap();
        let arrived = wa::WideArrival::read_at(&cd, 4).unwrap().unwrap();
        assert_eq!(arrived.fate, wa::wide_arrival::FATE_STAYS);
        assert_eq!(arrived.troops_after, entry.troops);
        assert_eq!(wa::WideClashInputsHdr::read(&cd).unwrap().resolver, ANYONE);
        assert_eq!(logs().0, before_logs.0);
        assert_eq!(logs().1.len(), before_logs.1.len() + 1);
        drop((rd, pd, cd));
        // Replay under another payer cannot recreate or reattribute the roster.
        let mut replay = a.clone();
        replay[0] = wallet(WALLET_B, true, true, BIG);
        let before = snapshot(&replay);
        let before_logs = logs();
        assert!(exec(&replay, &resolve_data()).is_err());
        assert!(snapshot(&replay) == before);
        assert_eq!(logs(), before_logs);
    }
}

#[test]
fn allocation_preflight_refusals_preserve_every_account_and_log() {
    let _g = begin();
    let rent = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    for overflow in [false, true] {
        let a = arrival_accounts(0, if overflow { rent } else { rent - 1 });
        if overflow {
            put(
                &mut a[2].try_borrow_mut_data().unwrap(),
                header::EVENT_SEQ,
                &u64::MAX.to_le_bytes(),
            );
        }
        let before = snapshot(&a);
        let before_logs = logs();
        let expected = if overflow {
            FrontierError::Overflow
        } else {
            FrontierError::Insufficient
        };
        assert_eq!(
            exec(&a, &resolve_data()),
            Err(ProgramError::Custom(expected as u32))
        );
        assert!(snapshot(&a) == before);
        assert_eq!(logs(), before_logs);
    }
    // CPI's own borrow preflight catches a shared absent-roster data borrow
    // before Transfer debits the payer, even though data_len() can read it.
    let a = arrival_accounts(0, rent);
    let before = snapshot(&a);
    let before_logs = logs();
    let borrowed = a[3].try_borrow_data().unwrap();
    assert_eq!(
        exec(&a, &resolve_data()),
        Err(ProgramError::AccountBorrowFailed)
    );
    drop(borrowed);
    assert!(snapshot(&a) == before);
    assert_eq!(logs(), before_logs);
}

#[test]
fn conflicting_borrows_are_refused_before_allocation_and_recoverable() {
    let _g = begin();
    let rent = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    for index in [2, 3, 6] {
        let a = arrival_accounts(0, rent);
        let before = snapshot(&a);
        let before_logs = logs();
        let borrowed = a[index].try_borrow_data().unwrap();
        assert_eq!(
            exec(&a, &resolve_data()),
            Err(ProgramError::AccountBorrowFailed)
        );
        drop(borrowed);
        assert!(snapshot(&a) == before);
        assert_eq!(logs(), before_logs);
        exec(&a, &resolve_data()).unwrap();
        assert_eq!(a[3].owner.to_bytes(), PROGRAM);
        assert_eq!(a[3].lamports(), rent);
    }
    for index in [0, 3] {
        let a = arrival_accounts(0, rent);
        let before = snapshot(&a);
        let before_logs = logs();
        let borrowed = a[index].try_borrow_lamports().unwrap();
        assert_eq!(
            exec(&a, &resolve_data()),
            Err(ProgramError::AccountBorrowFailed)
        );
        drop(borrowed);
        assert!(snapshot(&a) == before);
        assert_eq!(logs(), before_logs);
        exec(&a, &resolve_data()).unwrap();
        assert_eq!(a[3].owner.to_bytes(), PROGRAM);
        assert_eq!(a[3].lamports(), rent);
    }
}
