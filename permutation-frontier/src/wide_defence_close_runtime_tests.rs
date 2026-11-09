//! Claim-to-close coverage over literal accounts and direct dispatch.
//! Settlement is represented only by the production retained-slot helper;
//! this does not execute SettleTransit or its crypto-gated proof path.
use super::*;

fn close_command() -> [u8; wix::Close::LEN] {
    wix::Close {
        what: wix::CLOSE_WHAT_SLOT,
    }
    .to_bytes()
}

fn close_accounts(
    a: &[AccountInfo<'static>],
    rent_to: AccountInfo<'static>,
) -> Vec<AccountInfo<'static>> {
    vec![
        wallet(WALLET_B, true, false, 0),
        a[1].clone(),
        a[5].clone(),
        rent_to,
    ]
}

fn retain_settled_slot(a: &[AccountInfo<'static>]) {
    let before = a[5].try_borrow_data().unwrap().to_vec();
    edit_slot(a, |s| {
        *s = crate::proc::wide::retained_slot_after_settle(*s);
    });
    let mut expected = before;
    expected[wa::wide_arrival_slot::FLAGS] |= wa::wide_arrival_slot::FLAG_SETTLED;
    assert_eq!(&a[5].try_borrow_data().unwrap()[..], &expected);
}

fn assert_close_receipt(slot: &wa::WideArrivalSlot, lamports: u64) {
    let logs = WIDE_LOGS.lock().unwrap();
    assert_eq!(logs.len(), 1);
    let r = WideRecord::decode(&logs[0]).unwrap();
    assert_eq!(r.kind, WideKind::RecordClosed);
    assert_eq!(r.bell, 11);
    assert_eq!(r.province(), Some(slot.dest));
    assert_eq!(r.payload[0], wix::CLOSE_WHAT_SLOT);
    assert_eq!(&r.payload[1..5], &slot.bell.to_le_bytes());
    assert_eq!((r.payload[5], r.payload[6]), (slot.faction, slot.i));
    assert_eq!(&r.payload[7..39], &slot.rent_to);
    assert_eq!(&r.payload[39..47], &lamports.to_le_bytes());
    assert_eq!(r.links, [None, None]);
}

#[test]
fn retained_slot_adds_only_settled_and_preserves_created_day_eligibility() {
    let _g = begin();
    let params = permutation_rules::frontier::fees::DefenceParams {
        defence_cap_milli: 1000,
        tip_min: 27_328,
    };
    for created_day in [false, true] {
        let a = accounts(1);
        edit_slot(&a, |s| {
            s.flags = if created_day {
                wa::wide_arrival_slot::FLAG_CREATED_DAY
            } else {
                0
            };
            s.ev_price = 2_000_000;
            s.ev_limit = 26_000;
            s.ev_loaded = 32_768;
        });
        let before = wa::WideArrivalSlot::read(&a[5].try_borrow_data().unwrap()).unwrap();
        let eligible = |s: &wa::WideArrivalSlot| {
            crate::proc::wide::wide_claim_eligible(
                s,
                Some(100),
                5,
                &params,
                GENESIS + 6600,
                GENESIS + 6000,
            )
            .unwrap()
        };
        assert_eq!(before.ev_slot, 105);
        assert_eq!(before.evidence().created_day, created_day);
        // These evidence parameters refund 0 without the extra day write,
        // and 300 with it. Settlement must not erase that distinction.
        assert_eq!(eligible(&before), created_day);
        retain_settled_slot(&a);
        let after = wa::WideArrivalSlot::read(&a[5].try_borrow_data().unwrap()).unwrap();
        assert_eq!(after.evidence(), before.evidence());
        let mut expected = before;
        expected.flags |= wa::wide_arrival_slot::FLAG_SETTLED;
        assert_eq!(after, expected);
        assert_eq!(eligible(&after), created_day);
        assert_eq!(
            crate::proc::wide::retained_slot_after_settle(after),
            after,
            "the retained-slot transition is idempotent"
        );
    }
    assert!(LOGS.lock().unwrap().is_empty());
    assert!(WIDE_LOGS.lock().unwrap().is_empty());
}

#[test]
fn retained_settled_claim_closes_whole_to_immutable_rent_recipient() {
    let _g = begin();
    let a = accounts(1);
    edit_slot(&a, |s| s.flags = wa::wide_arrival_slot::FLAG_CREATED_DAY);
    retain_settled_slot(&a);
    let before_claim = snapshot(&a);
    exec(&a, &command(1)).unwrap();
    assert!(amount(&a) > 0);

    // Claim changes only its marker, preserving settlement, created-day,
    // beneficiary, immutable rent recipient, and every evidence byte.
    let mut expected_slot = before_claim[5].1.clone();
    expected_slot[wa::wide_arrival_slot::CLAIMED] = 1;
    assert_eq!(&a[5].try_borrow_data().unwrap()[..], &expected_slot);
    assert_eq!(a[5].lamports(), before_claim[5].0);
    let slot = wa::WideArrivalSlot::read(&expected_slot).unwrap();
    assert_eq!(slot.beneficiary, PAYER);
    assert_eq!(slot.rent_to, ANYONE);
    assert_ne!(slot.beneficiary, slot.rent_to);

    let rent_to = wallet(ANYONE, false, true, 0);
    let ca = close_accounts(&a, rent_to.clone());
    let after_claim = snapshot(&a);
    let claim_logs = LOGS.lock().unwrap().clone();
    // At bell 11, before the claim grace, with no anchor listed: the
    // successful claim plus settlement is sufficient for this close.
    exec(&ca, &close_command()).unwrap();
    assert_eq!(rent_to.lamports(), before_claim[5].0);
    assert_eq!(a[5].lamports(), 0);
    assert!(a[5].data_is_empty());
    assert_eq!(a[5].owner.to_bytes(), SYSTEM);
    let mut expected = after_claim;
    expected[5] = (0, vec![], Pubkey::new_from_array(SYSTEM));
    assert_eq!(snapshot(&a), expected);
    assert_eq!(*LOGS.lock().unwrap(), claim_logs);
    assert_close_receipt(&slot, before_claim[5].0);
}

#[test]
fn claimed_but_unsettled_slot_refuses_close_during_running() {
    let _g = begin();
    let a = accounts(1);
    exec(&a, &command(1)).unwrap();
    let s = wa::WideArrivalSlot::read(&a[5].try_borrow_data().unwrap()).unwrap();
    assert!(s.claimed);
    assert_eq!(s.flags & wa::wide_arrival_slot::FLAG_SETTLED, 0);
    assert_eq!(
        a[1].try_borrow_data().unwrap()[S::STATUS],
        S::STATUS_RUNNING
    );
    let ca = close_accounts(&a, wallet(ANYONE, false, true, 0));
    let before = snapshot(&a);
    assert_eq!(
        fail(&ca, &close_command()),
        ProgramError::Custom(FrontierError::TooEarly as u32)
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn claimed_settled_slot_rejects_wrong_rent_recipient_without_effects() {
    let _g = begin();
    let a = accounts(1);
    retain_settled_slot(&a);
    exec(&a, &command(1)).unwrap();
    let ca = close_accounts(&a, wallet(WALLET_A, false, true, 0));
    let before = snapshot(&a);
    assert_eq!(
        fail(&ca, &close_command()),
        ProgramError::Custom(FrontierError::BadAddress as u32)
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn claim_beneficiary_cannot_redirect_slot_rent_to_itself() {
    let _g = begin();
    let a = accounts(1);
    // The opposite ordering is supported too: claim first, then mark the
    // retained slot settled, without changing its claim or evidence.
    exec(&a, &command(1)).unwrap();
    retain_settled_slot(&a);
    let slot = wa::WideArrivalSlot::read(&a[5].try_borrow_data().unwrap()).unwrap();
    assert!(slot.claimed);
    assert_eq!(slot.beneficiary, a[0].key.to_bytes());
    assert_eq!(slot.rent_to, ANYONE);
    let before = snapshot(&a);
    let redirected = close_accounts(&a, a[0].clone());
    assert_eq!(
        fail(&redirected, &close_command()),
        ProgramError::Custom(FrontierError::BadAddress as u32)
    );
    assert_eq!(snapshot(&a), before);

    let rent_to = wallet(ANYONE, false, true, 0);
    let ca = close_accounts(&a, rent_to.clone());
    let claim_logs = LOGS.lock().unwrap().clone();
    exec(&ca, &close_command()).unwrap();
    assert_eq!(a[0].lamports(), before[0].0);
    assert_eq!(rent_to.lamports(), before[5].0);
    assert_eq!(a[5].lamports(), 0);
    assert!(a[5].data_is_empty());
    assert_eq!(a[5].owner.to_bytes(), SYSTEM);
    assert_eq!(*LOGS.lock().unwrap(), claim_logs);
    assert_close_receipt(&slot, before[5].0);
}

#[test]
fn recipient_overflow_refuses_before_slot_close_effects() {
    let _g = begin();
    let a = accounts(1);
    retain_settled_slot(&a);
    exec(&a, &command(1)).unwrap();
    let ca = close_accounts(&a, wallet(ANYONE, false, true, u64::MAX));
    let before = snapshot(&a);
    assert_eq!(
        fail(&ca, &close_command()),
        ProgramError::Custom(FrontierError::Overflow as u32)
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn recipient_lamport_borrow_refuses_before_slot_close_effects() {
    let _g = begin();
    let a = accounts(1);
    retain_settled_slot(&a);
    exec(&a, &command(1)).unwrap();
    let ca = close_accounts(&a, wallet(ANYONE, false, true, 0));
    let before_claim_accounts = snapshot(&a);
    let before_close_accounts = snapshot(&ca);
    let logs = (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    );
    let held = ca[3].try_borrow_lamports().unwrap();
    let error = exec(&ca, &close_command()).unwrap_err();
    drop(held);
    assert_eq!(error, ProgramError::AccountBorrowFailed);
    assert_eq!(snapshot(&ca), before_close_accounts);
    assert_eq!(snapshot(&a), before_claim_accounts);
    assert_eq!(
        (
            LOGS.lock().unwrap().clone(),
            WIDE_LOGS.lock().unwrap().clone(),
        ),
        logs
    );
}

#[test]
fn under_rent_refund_and_source_borrows_refuse_before_close() {
    let _g = begin();
    let a = accounts(1);
    retain_settled_slot(&a);
    exec(&a, &command(1)).unwrap();
    **a[5].try_borrow_mut_lamports().unwrap() = 1;
    let ca = close_accounts(&a, wallet(ANYONE, false, true, 0));
    assert_eq!(
        fail(&ca, &close_command()),
        ProgramError::Custom(FrontierError::BadAccount as u32)
    );

    for data in [false, true] {
        let a = accounts(1);
        retain_settled_slot(&a);
        exec(&a, &command(1)).unwrap();
        let ca = close_accounts(&a, wallet(ANYONE, false, true, 0));
        let before = snapshot(&ca);
        let logs = (
            LOGS.lock().unwrap().clone(),
            WIDE_LOGS.lock().unwrap().clone(),
        );
        let error = if data {
            let held = ca[2].try_borrow_data().unwrap();
            let error = exec(&ca, &close_command()).unwrap_err();
            drop(held);
            error
        } else {
            let held = ca[2].try_borrow_lamports().unwrap();
            let error = exec(&ca, &close_command()).unwrap_err();
            drop(held);
            error
        };
        assert_eq!(error, ProgramError::AccountBorrowFailed);
        assert_eq!(snapshot(&ca), before);
        assert_eq!(
            (
                LOGS.lock().unwrap().clone(),
                WIDE_LOGS.lock().unwrap().clone()
            ),
            logs
        );
        exec(&ca, &close_command()).unwrap();
        assert!(ca[2].data_is_empty());
        assert_eq!(ca[3].lamports(), before[2].0);
    }
}
