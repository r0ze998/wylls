//! Preparation/refusal tests only. No runtime close, fake AccountInfo memory
//! prefix, assign, successful-CPI stub, rollback emulation, or transaction.
use super::*;
use alloc::boxed::Box;

fn ai(address: [u8; 32], owner: [u8; 32], data: Vec<u8>, lamports: u64) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        false,
        true,
        Box::leak(Box::new(lamports)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}
fn snap(address: u8, owner: [u8; 32], balance: u64, len: usize) -> Snapshot {
    Snapshot {
        address: [address; 32],
        owner,
        present: len != 0,
        signer: false,
        writable: true,
        lamports: balance,
        data: vec![0; len],
    }
}

#[test]
fn sequential_shared_recipient_diversion_and_credit_are_not_aggregated() {
    let p = Pubkey::new_from_array([12; 32]);
    let floor = init::rent(0).unwrap();
    let mut s = vec![
        snap(0, [0; 32], 0, 0),
        snap(1, p.to_bytes(), 10 * floor, H::POOL_OWED + 8),
        snap(2, [0; 32], floor - 10, 0),
    ];
    s.push(s[2].clone());
    let tip = payment(&p, &mut s, 2, 5, false).unwrap();
    let fee = payment(&p, &mut s, 3, 10, false).unwrap();
    let bond = payment(&p, &mut s, 2, 7, false).unwrap();
    assert!(tip.diverted);
    assert!(!fee.diverted && !bond.diverted);
    assert_eq!(s[2].lamports, floor + 7);
    assert_eq!(s[3].lamports, floor + 7);
    assert_eq!(s[1].lamports, 10 * floor - 17);
    assert_eq!(Ro(&s[1].data).u64(H::POOL_OWED).unwrap(), 5);
    let records = prepare_diversions(&s[1].address, 42, &[tip, fee, bond]).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0][1], Kind::DIVERT as u8);
    assert_eq!(&records[0][6..38], &s[2].address);
    assert_eq!(&records[0][38..46], &5u64.to_le_bytes());
    assert_eq!(records[0][46], divert_reason::TIP);
    assert_eq!(records[0][47], 0); // No chained account is mutated by DIVERT.
}

#[test]
fn program_payee_diverts_and_whole_close_never_diverts() {
    let p = Pubkey::new_from_array([12; 32]);
    let mut s = vec![
        snap(0, [0; 32], 0, 0),
        snap(1, p.to_bytes(), 100, H::POOL_OWED + 8),
        snap(2, p.to_bytes(), 80, 4),
        snap(3, [0; 32], 0, 0),
    ];
    let tip = payment(&p, &mut s, 2, 20, false).unwrap();
    assert!(tip.diverted);
    assert_eq!(s[2].lamports, 80);
    assert_eq!(s[1].lamports, 100);
    let fee = payment(&p, &mut s, 2, 0, false).unwrap();
    let bond = payment(&p, &mut s, 1, 7, true).unwrap();
    let records = prepare_diversions(&s[1].address, 42, &[tip, fee, bond]).unwrap();
    assert_eq!(records.len(), 1); // Zero amount and self diversion emit nothing.
    assert_eq!(&records[0][6..38], &s[2].address);
    assert_eq!(&records[0][38..46], &20u64.to_le_bytes());
    assert_eq!(records[0][46], divert_reason::TIP);
    assert!(close_stage(&p, &mut s, 2, 3).is_err());
    assert_eq!(s[2].lamports, 80);
    // Program-owned rent recipients receive the whole close directly.
    assert_eq!(close_stage(&p, &mut s, 2, 1).unwrap(), 80);
    assert_eq!(s[1].lamports, 180);
    assert_eq!(Ro(&s[1].data).u64(H::POOL_OWED).unwrap(), 27);
    assert_eq!(s[2].owner, init::SYSTEM.to_bytes());
    assert!(s[2].data.is_empty());
}

#[test]
fn balance_and_pool_overflow_are_refused_before_live_effects() {
    let p = Pubkey::new_from_array([12; 32]);
    let mut s = vec![
        snap(0, [0; 32], 0, 0),
        snap(1, p.to_bytes(), 1, H::POOL_OWED + 8),
        snap(2, [0; 32], u64::MAX, 0),
    ];
    assert!(payment(&p, &mut s, 2, 1, false).is_err());
    assert_eq!(s[1].lamports, 1);
    Rw(&mut s[1].data).set_u64(H::POOL_OWED, u64::MAX).unwrap();
    assert!(payment(&p, &mut s, 1, 1, true).is_err());
    assert_eq!(s[1].lamports, 1);
}

#[test]
fn diversion_records_keep_tip_fee_bond_order_and_native_encoding() {
    let payments = [
        receipt::Payment {
            recipient: [7; 32],
            amount: 3,
            diverted: true,
        },
        receipt::Payment {
            recipient: [8; 32],
            amount: 4,
            diverted: true,
        },
        receipt::Payment {
            recipient: [7; 32],
            amount: 5,
            diverted: true,
        },
    ];
    let records = prepare_diversions(&[1; 32], 77, &payments).unwrap();
    assert_eq!(records.len(), 3);
    for ((actual, payment), reason) in records.iter().zip(payments).zip([
        divert_reason::TIP,
        divert_reason::MARCH_FEE,
        divert_reason::BOND,
    ]) {
        let payload = Buf::<9>::new().u64(payment.amount).u8(reason);
        let mut expected = [0; events::MAX_RECORD];
        let n = events::record(
            Kind::DIVERT,
            77,
            &payment.recipient,
            payload.get().unwrap(),
            &mut [],
            &mut expected,
        )
        .unwrap();
        assert_eq!(actual, &expected[..n]);
    }
}

#[test]
fn fake_same_key_and_cross_key_shared_storage_are_refused() {
    let mut a: Vec<_> = (1..=14).map(|i| ai([i; 32], [0; 32], vec![], 0)).collect();
    a[10] = ai([10; 32], [0; 32], vec![], 0); // same key, different RefCells
    assert!(snapshots(&a, 8).is_err());
    a[10] = a[9].clone(); // legitimate repeated recipient
    assert!(snapshots(&a, 8).is_ok());
    a[10].key = Box::leak(Box::new(Pubkey::new_from_array([55; 32])));
    assert!(snapshots(&a, 8).is_err());
}

#[cfg(all(feature = "public-proof-tests", not(target_os = "solana")))]
mod proof {
    use super::*;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    const PROGRAM: [u8; 32] = [12; 32];
    const SLOT: u8 = 2;
    const POSITION: usize = wa::wide_clash_inputs::position(2, 0);

    struct Fixture {
        a: Vec<AccountInfo<'static>>,
        base: usize,
        commit: [u8; 32],
        seal: [u8; wseal::WIDE_SEAL_LEN],
    }
    fn fixture() -> Fixture {
        // Reuses only the already audited fixture constructor. Every call
        // verifies public Quicknet and actually recovers the existing key;
        // prepare then executes the real committed-seal proof again.
        let f = super::super::super::tests::fixture();
        let mut a = f.a;
        for item in &mut a[1..] {
            item.is_writable = true;
        }
        let base = a.len();
        a.push(f.anchor);
        let mut payer = ai([90; 32], [0; 32], vec![], 1_000_000_000);
        payer.is_signer = true;
        a.push(payer);
        a.push(ai([36; 32], [0; 32], vec![], 1_000_000_000));
        a.push(ai([35; 32], [0; 32], vec![], 1_000_000_000));
        a.push(a[7].clone());
        a.push(ai([91; 32], [0; 32], vec![], 1_000_000_000));
        Fixture {
            a,
            base,
            commit: f.commit,
            seal: f.seal,
        }
    }
    impl Fixture {
        fn prepare(&self) -> R<Prepared> {
            prepare(
                &Pubkey::new_from_array(PROGRAM),
                &self.a,
                self.base,
                SLOT,
                &self.commit,
                &self.seal,
            )
        }
        fn snapshot(&self) -> Vec<(u64, Vec<u8>, Pubkey)> {
            self.a
                .iter()
                .map(|a| {
                    (
                        a.lamports(),
                        a.try_borrow_data().unwrap().to_vec(),
                        *a.owner,
                    )
                })
                .collect()
        }
        fn fate(&self, fate: u8) {
            let mut d = self.a[5].try_borrow_mut_data().unwrap();
            let mut r = WideArrival::read_at(&d, POSITION).unwrap().unwrap();
            r.fate = fate;
            r.write_at(&mut d, POSITION).unwrap();
        }
        fn refuses(&self) {
            let before = self.snapshot();
            assert!(self.prepare().is_err());
            assert_eq!(self.snapshot(), before);
        }
    }

    #[test]
    fn every_resolved_member_fate_prepares_same_call_proof_and_paired_receipts() {
        for fate in wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED {
            let f = fixture();
            f.fate(fate);
            let before = f.snapshot();
            let prepared = f.prepare().unwrap();
            assert_eq!(f.snapshot(), before);
            assert_eq!(Ro(&prepared.after[1].data).u64(H::ESCROW).unwrap(), 0);
            assert!(prepared.after[1].data
                [H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
                .iter()
                .all(|x| *x == 0));
            assert!(prepared.after[2].data.is_empty());
            assert_eq!(prepared.after[2].lamports, 0);
            assert_eq!(prepared.after[2].owner, [0; 32]);
            let ih = WideClashInputsHdr::read(&prepared.after[5].data).unwrap();
            assert_ne!(ih.settled_mask & (1 << POSITION), 0);
            let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
            let original = receipt::Record::decode(&ctx, &prepared.receipts.original).unwrap();
            let wide = receipt::Record::decode(&ctx, &prepared.receipts.wide).unwrap();
            original.pair(&wide).unwrap();
        }
    }

    #[test]
    fn camp_winner_bad_seal_nonmember_and_privilege_failures_have_no_effects() {
        let f = fixture();
        f.fate(wa::wide_arrival::FATE_STAYS);
        {
            let mut d = f.a[5].try_borrow_mut_data().unwrap();
            let mut ih = WideClashInputsHdr::read(&d).unwrap();
            ih.camp_mask = 1 << POSITION;
            ih.write(&mut d).unwrap();
        }
        f.refuses();
        let mut f = fixture();
        f.seal[0] ^= 1;
        f.refuses();
        let f = fixture();
        {
            let mut d = f.a[5].try_borrow_mut_data().unwrap();
            let mut r = WideArrival::read_at(&d, POSITION).unwrap().unwrap();
            r.present = false;
            r.write_at(&mut d, POSITION).unwrap();
        }
        f.refuses();
        let mut f = fixture();
        f.a[4].is_writable = false;
        f.refuses();
        let mut f = fixture();
        f.a[f.base + 1].is_signer = false;
        f.refuses();
    }

    #[test]
    fn absent_slot_diverts_tip_and_retained_claimed_slot_preserves_v2_identity() {
        let mut f = fixture();
        f.a[6] = ai(key(&f.a[6]), [0; 32], vec![], 0);
        let prepared = f.prepare().unwrap();
        assert_eq!(Ro(&prepared.after[1].data).u64(H::POOL_OWED).unwrap(), 7);
        assert!(prepared.diversions.is_empty()); // Native implicit pool leg.
        let f = fixture();
        let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
        let old = ArrivalSlot::read(&ctx, &f.a[6].try_borrow_data().unwrap()).unwrap();
        let mut common = *old.common();
        common.rent_to = [123; 32]; // immutable recipient not in listed roles
        common.claimed = true;
        let old = frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot::new(
            &ctx,
            common,
            old.worn_bps(),
        )
        .unwrap();
        f.a[6]
            .try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&old.to_bytes(&ctx).unwrap());
        let prepared = f.prepare().unwrap();
        let retained = ArrivalSlot::read(&ctx, &prepared.after[6].data).unwrap();
        assert!(retained.common().claimed);
        assert_eq!(retained.worn_bps(), old.worn_bps());
        assert_eq!(retained.common().citizen, old.common().citizen);
        assert_ne!(
            retained.common().flags & wa::wide_arrival_slot::FLAG_SETTLED,
            0
        );
    }

    #[test]
    fn real_proof_prepares_native_diversions_without_emitting_or_paying() {
        let mut f = fixture();
        f.a[f.base + 2] = ai([36; 32], [0; 32], vec![], 0);
        f.a[f.base + 3] = ai([35; 32], PROGRAM, vec![], 1_000_000_000);
        let before = f.snapshot();
        let prepared = f.prepare().unwrap();
        assert_eq!(f.snapshot(), before);
        assert_eq!(prepared.diversions.len(), 2);
        assert_eq!(prepared.diversions[0][46], divert_reason::TIP);
        assert_eq!(prepared.diversions[1][46], divert_reason::MARCH_FEE);
        assert_eq!(&prepared.diversions[0][6..38], &[36; 32]);
        assert_eq!(&prepared.diversions[1][6..38], &[35; 32]);
        assert_eq!(Ro(&prepared.after[1].data).u64(H::POOL_OWED).unwrap(), 17);
        assert_eq!(prepared.after[f.base + 2].lamports, before[f.base + 2].0);
        assert_eq!(prepared.after[f.base + 3].lamports, before[f.base + 3].0);
    }

    #[test]
    fn captured_previous_home_uses_second_original_holding_chain() {
        let mut f = fixture();
        let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
        let previous = addr::host_id(127, 0, 0, 3, 0).unwrap();
        {
            let mut hd = f.a[1].try_borrow_mut_data().unwrap();
            let off = H::transit(SLOT as usize);
            let marker = BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).unwrap();
            let capture = marker.capture_bond_plan(37, 20).unwrap();
            hd[off..off + MARKER_LEN].copy_from_slice(&capture.marker_after.to_bytes());
            let mut w = Rw(&mut hd);
            w.set_u64(H::ESCROW, capture.escrow_after).unwrap();
            w.set_u8(H::GEN, 2).unwrap();
            w.set_u8(H2::PREV_GEN, 1).unwrap();
            w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
                .unwrap();
            w.set_u64(H2::PREV_OWNER_TAG, addr::citizen_tag(&[33; 32]))
                .unwrap();
            w.set_u64(H2::PREV_HOME, previous).unwrap();
            w.set_arr(H::OWNER_CITIZEN, &[99; 32]).unwrap();
            w.set_u32(H::HOST_SEQ, 0).unwrap();
        }
        Rw(&mut f.a[3].try_borrow_mut_data().unwrap())
            .set_u8(PV::site(2) + SM::GEN, 2)
            .unwrap();
        let mut hd = vec![0; K2::Holding.size()];
        assert!(write_header(&mut hd, K2::Holding, 11));
        Rw(&mut hd).set_i16(H::P, 127).unwrap();
        Rw(&mut hd).set_u8(H::GEN, 3).unwrap();
        Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
        f.a.insert(8, ai(ctx.holding(127, 0, 0), PROGRAM, hd, 1_000_000_000));
        f.base = 9;
        let prepared = f.prepare().unwrap();
        assert_eq!(prepared.receipts.original_links.len(), 2);
        assert_eq!(
            prepared.receipts.original_links[1].entity,
            frontier_abi::log::EntityKind::Holding
        );
        assert_eq!(Ro(&prepared.after[8].data).u32(H::reserve(1)).unwrap(), 12);
        assert_eq!(prepared.after[3].data, prepared.before[3].data);
        Rw(&mut f.a[8].try_borrow_mut_data().unwrap())
            .set_u8(H::GEN, 4)
            .unwrap();
        let prepared = f.prepare().unwrap();
        assert_eq!(prepared.receipts.original_links.len(), 1);
        assert_eq!(prepared.after[8].data, prepared.before[8].data);
    }

    #[test]
    fn late_mutable_borrow_refuses_before_resize_or_payment() {
        let f = fixture();
        let before = f.snapshot();
        let guard = f.a[4].try_borrow_data().unwrap();
        assert!(settle(
            &Pubkey::new_from_array(PROGRAM),
            &f.a,
            f.base,
            SLOT,
            &f.commit,
            &f.seal
        )
        .is_err());
        drop(guard);
        assert_eq!(f.snapshot(), before);
    }
}
