//! Direct dispatch only: rejected resolution must not activate a pending
//! reinforcement, change any byte/lamport/owner, or publish a receipt.
//! Literal cache and present roster fixtures avoid crypto and allocation.
use super::*;

fn pending_resolve() -> Vec<AccountInfo<'static>> {
    let a = fixture();
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 1;
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        put(&mut pd, PV2::SCORE_NEXT_BELL, &10u32.to_le_bytes());
        put(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, &1u32.to_le_bytes());
    }
    exec(&a, &data(20)).unwrap();
    let mut ra = resolve_accounts(&a, 10);
    // A present, fully gathered empty input still receives the resolved
    // flag, beneficiary and timestamp. It exercises the third commit.
    let h = WideHolding::read(&a[4].try_borrow_data().unwrap()).unwrap();
    let pk = ProvinceKey::new(h.world, h.coord);
    let ctx = crate::addr::ctx(&a[2].key.to_bytes(), &PROGRAM);
    let mut ih = wa::WideClashInputsHdr::new(SEASON_ID, pk, 10, PAYER);
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    let mut cd = vec![0; wa::wide_clash_inputs::SIZE];
    ih.write(&mut cd).unwrap();
    ra[6] = info(
        leak(wa::clash_inputs_address(&ctx, pk, 10), PROGRAM, cd, 0, BIG),
        false,
        true,
    );
    at_bell(12);
    ra
}

fn resolve_data() -> Vec<u8> {
    wix::Resolve {
        bell: 10,
        beneficiary: PAYER,
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
fn receipt_overflow_preserves_pending_garrison_and_all_accounts() {
    let _g = begin();
    let a = pending_resolve();
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        header::EVENT_SEQ,
        &u64::MAX.to_le_bytes(),
    );
    let before = snapshot(&a);
    let before_logs = logs();
    assert_eq!(
        exec(&a, &resolve_data()),
        Err(ProgramError::Custom(FrontierError::Overflow as u32))
    );
    assert!(
        snapshot(&a) == before,
        "rejected resolve changed account state"
    );
    assert_eq!(logs(), before_logs);
}

#[test]
fn later_borrow_refusals_are_atomic_and_recoverable() {
    let _g = begin();
    for i in [3, 6] {
        let a = pending_resolve();
        let before = snapshot(&a);
        let before_logs = logs();
        let borrowed = a[i].try_borrow_data().unwrap();
        assert_eq!(
            exec(&a, &resolve_data()),
            Err(ProgramError::AccountBorrowFailed)
        );
        drop(borrowed);
        assert!(
            snapshot(&a) == before,
            "rejected resolve changed account state"
        );
        assert_eq!(logs(), before_logs);
        // Releasing the conflicting borrow permits the original bell,
        // without a skipped clash, duplicate activation or extra receipt.
        exec(&a, &resolve_data()).unwrap();
        let pd = a[2].try_borrow_data().unwrap();
        assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), 11);
        assert_eq!(Ro(&pd).u32(PV::site(0) + SM::GARRISON).unwrap(), 20_000);
        assert_eq!(Ro(&pd).i64(PV::site(0) + SM::PEND0_DELTA).unwrap(), 0);
        let cd = a[6].try_borrow_data().unwrap();
        let ih = wa::WideClashInputsHdr::read(&cd).unwrap();
        assert_ne!(ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED, 0);
        assert_eq!(ih.resolver, PAYER);
        let after_logs = logs();
        assert_eq!(after_logs.0, before_logs.0);
        assert_eq!(after_logs.1.len(), before_logs.1.len() + 1);
        let rec = WideRecord::decode(after_logs.1.last().unwrap()).unwrap();
        let (seq, head) = crate::layout::chain_of(&before[2].1).unwrap();
        let link = wev::advance(WideEntity::Province, seq, &head, rec.body_without_tail).unwrap();
        assert_eq!(rec.links[0], Some(link));
        assert_eq!(crate::layout::chain_of(&pd).unwrap(), (link.seq, link.head));
    }
}
