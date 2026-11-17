//! Actual dispatch over literal accounts, plus actual Resolve of queued Forfeit.
//! No lifecycle setup, rollback wrapper, signature, RPC, or key constructor.
use super::*;
use frontier_abi::entry::Entry;
use frontier_abi::v2::layout::player::holding as H2;
use frontier_abi::world_index::march as wm;
use frontier_abi::world_index::tiles::TileAddress;

fn accounts(
    state: u8,
) -> (
    Vec<AccountInfo<'static>>,
    Vec<AccountInfo<'static>>,
    WideHostRef,
) {
    let base = fixture();
    {
        let mut pd = base[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 1;
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        put(&mut pd, PV2::SCORE_NEXT_BELL, &10u32.to_le_bytes());
        put(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, &1u32.to_le_bytes());
    }
    let ra = resolve_accounts(&base, 10);
    let h = WideHolding::read(&base[4].try_borrow_data().unwrap()).unwrap();
    let pk = ProvinceKey::new(h.world, h.coord);
    let host = WideHostRef::new(pk, h.site, 1, 7).unwrap();
    let mut rd = ra[3].try_borrow_mut_data().unwrap();
    let roster = WideRoster::read(&rd).unwrap();
    let alias = roster.claim(&mut rd, 0, &host).unwrap();
    drop(rd);
    {
        let mut pd = base[5].try_borrow_mut_data().unwrap();
        write_entry(
            &mut pd,
            0,
            &Entry {
                id: alias,
                state,
                troops: 100_999,
                stamina_value: 100,
                dealt_bps: 10_000,
                from_bell: 10,
                ..Entry::FREE
            },
        )
        .unwrap();
        pd[PV::N_ENTRIES] = 1;
    }
    let mut holding = base[4].clone();
    holding.is_writable = false;
    let mut a = vec![
        wallet(ANYONE, true, false, 0),
        base[2].clone(),
        base[5].clone(),
        ra[3].clone(),
        holding,
    ];
    let ctx = crate::addr::ctx(&a[1].key.to_bytes(), &PROGRAM);
    for slot in 0..4 {
        a.push(wallet(
            wm::transit_address(&ctx, &a[4].key.to_bytes(), slot),
            false,
            false,
            0,
        ));
    }
    (a, ra, host)
}
fn command(entry: u8) -> [u8; wix::DisbandStranded::LEN] {
    wix::DisbandStranded { entry }.to_bytes()
}
fn fail(a: &[AccountInfo<'static>], entry: u8) -> ProgramError {
    let before = snapshot(a);
    let logs = (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    );
    let error = exec(a, &command(entry)).unwrap_err();
    assert_eq!(snapshot(a), before);
    assert_eq!(*LOGS.lock().unwrap(), logs.0);
    assert_eq!(*WIDE_LOGS.lock().unwrap(), logs.1);
    error
}
fn custom(e: FrontierError) -> ProgramError {
    ProgramError::Custom(e as u32)
}

#[test]
fn orphan_forfeit_waits_for_actual_resolve_and_never_credits_reserve() {
    let _g = begin();
    for state in [EN::STATE_ROSTER, EN::STATE_MUSTER_PENDING] {
        let (a, ra, host) = accounts(state);
        let before = snapshot(&a);
        exec(&a, &command(0)).unwrap();
        let pd = a[2].try_borrow_data().unwrap();
        let e = read_entry(&pd, 0).unwrap();
        assert_eq!(
            (e.state, e.troops, e.op, e.pend_bell),
            (state, 100_999, EntryOp::Forfeit, 10)
        );
        assert_eq!(pd[PV::N_ENTRIES], 1);
        assert_eq!(Ro(&pd).u32(PV::ROSTER_EPOCH).unwrap(), 1);
        drop(pd);
        assert_eq!(snapshot(&a)[3], before[3]);
        for i in [0, 1, 4, 5, 6, 7, 8] {
            assert_eq!(snapshot(&a)[i], before[i]);
        }
        let logs = WIDE_LOGS.lock().unwrap();
        let r = WideRecord::decode(logs.last().unwrap()).unwrap();
        assert_eq!(r.kind, WideKind::Stranded);
        assert_eq!(r.bell, 10);
        assert_eq!(r.host(), Some(host));
        assert_eq!(r.payload, wev::stranded_payload(100_999, 0));
        let (seq, head) = crate::layout::chain_of(&before[2].1).unwrap();
        assert_eq!(
            r.link(WideEntity::Province),
            wev::advance(WideEntity::Province, seq, &head, r.body_without_tail)
        );
        assert_eq!(r.link(WideEntity::Holding), None);
        drop(logs);
        assert_eq!(fail(&a, 0), custom(FrontierError::HostBusy));
        at_bell(12);
        exec(
            &ra,
            &wix::Resolve {
                bell: 10,
                beneficiary: ANYONE,
            }
            .to_bytes(),
        )
        .unwrap();
        let pd = a[2].try_borrow_data().unwrap();
        assert_eq!(read_entry(&pd, 0).unwrap(), Entry::FREE);
        assert_eq!(pd[PV::N_ENTRIES], 0);
        assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), 11);
        drop(pd);
        let rd = a[3].try_borrow_data().unwrap();
        assert_eq!(WideRoster::read(&rd).unwrap().ref_at(&rd, 0).unwrap(), None);
        drop(rd);
        assert_eq!(snapshot(&a)[4], before[4]);
        assert_eq!(fail(&a, 0), custom(FrontierError::BadData));
        assert!(LOGS.lock().unwrap().is_empty());
    }
}

#[test]
fn departed_and_season_resolved_orphans_release_pairing_immediately() {
    let _g = begin();
    for (state, ended) in [
        (EN::STATE_DEPARTED, false),
        (EN::STATE_ROSTER, true),
        (EN::STATE_MUSTER_PENDING, true),
    ] {
        let (mut a, _, _) = accounts(state);
        // An authenticated absent holding is also a valid orphan proof.
        a[4] = wallet(a[4].key.to_bytes(), false, false, 71);
        if ended {
            a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
            let end = Ro(&a[1].try_borrow_data().unwrap())
                .u32(S::END_BELL)
                .unwrap();
            put(
                &mut a[2].try_borrow_mut_data().unwrap(),
                PV::RESOLVED_NEXT,
                &end.to_le_bytes(),
            );
        }
        put(
            &mut a[2].try_borrow_mut_data().unwrap(),
            PV::ROSTER_EPOCH,
            &u32::MAX.to_le_bytes(),
        );
        let before = snapshot(&a);
        exec(&a, &command(0)).unwrap();
        let pd = a[2].try_borrow_data().unwrap();
        assert_eq!(read_entry(&pd, 0).unwrap(), Entry::FREE);
        assert_eq!(pd[PV::N_ENTRIES], 0);
        assert_eq!(Ro(&pd).u32(PV::ROSTER_EPOCH).unwrap(), 0);
        drop(pd);
        let rd = a[3].try_borrow_data().unwrap();
        assert_eq!(WideRoster::read(&rd).unwrap().ref_at(&rd, 0).unwrap(), None);
        drop(rd);
        for i in [0, 1, 4, 5, 6, 7, 8] {
            assert_eq!(snapshot(&a)[i], before[i]);
        }
        assert_eq!(fail(&a, 0), custom(FrontierError::BadData));
    }
}

#[test]
fn live_and_captured_previous_generation_are_protected() {
    let _g = begin();
    for state in [H::STATE_PROVISIONAL, H::STATE_FINAL] {
        let (a, _, _) = accounts(EN::STATE_ROSTER);
        {
            let mut hd = a[4].try_borrow_mut_data().unwrap();
            hd[H::STATE] = state;
            hd[H::GEN] = 1;
        }
        assert_eq!(fail(&a, 0), custom(FrontierError::NotDormant));
        {
            let mut hd = a[4].try_borrow_mut_data().unwrap();
            hd[H::GEN] = 2;
            hd[H2::CAPTURE_FLAGS] = H2::CAPTURE_FLAG_CAPTURED;
            hd[H2::PREV_GEN] = 1;
        }
        assert_eq!(fail(&a, 0), custom(FrontierError::NotDormant));
        // Existing rules explicitly disable the previous-generation protection.
        let mut cq = conquest(&HOME);
        cq.retire_hosts = 0;
        put(
            &mut a[1].try_borrow_mut_data().unwrap(),
            SEASON_CQ_OFFSET,
            &cq.to_bytes(),
        );
        exec(&a, &command(0)).unwrap();
    }
}

#[test]
fn identity_range_privilege_and_busy_refusals_are_atomic() {
    let _g = begin();
    let (a, _, _) = accounts(EN::STATE_ROSTER);
    for entry in [1, 55, 56, 255] {
        assert_eq!(fail(&a, entry), custom(FrontierError::BadData));
    }
    for i in [0, 2, 3] {
        let mut changed = a.clone();
        if i == 0 {
            changed[i].is_signer = false;
        } else {
            changed[i].is_writable = false;
        }
        fail(&changed, 0);
    }
    for i in [2, 3, 4, 5, 8] {
        let mut changed = a.clone();
        let old = &a[i];
        changed[i] = info(
            leak(
                [0xf7; 32],
                old.owner.to_bytes(),
                old.try_borrow_data().unwrap().to_vec(),
                0,
                old.lamports(),
            ),
            old.is_signer,
            old.is_writable,
        );
        fail(&changed, 0);
    }
    for i in [2, 3, 4] {
        let mut changed = a.clone();
        let old = &a[i];
        changed[i] = info(
            leak(
                old.key.to_bytes(),
                [0xf8; 32],
                old.try_borrow_data().unwrap().to_vec(),
                0,
                old.lamports(),
            ),
            old.is_signer,
            old.is_writable,
        );
        fail(&changed, 0);
    }
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &8u32.to_le_bytes(),
    );
    assert_eq!(fail(&a, 0), custom(FrontierError::NotResident));
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &10u32.to_le_bytes(),
    );
    let mut e = read_entry(&a[2].try_borrow_data().unwrap(), 0).unwrap();
    e.op = EntryOp::Leave;
    write_entry(&mut a[2].try_borrow_mut_data().unwrap(), 0, &e).unwrap();
    assert_eq!(fail(&a, 0), custom(FrontierError::HostBusy));
    e.op = EntryOp::None;
    e.id ^= 1;
    write_entry(&mut a[2].try_borrow_mut_data().unwrap(), 0, &e).unwrap();
    assert_eq!(fail(&a, 0), custom(FrontierError::BadAccount));
}

#[test]
fn open_transit_chain_overflow_and_held_borrows_never_partially_remove() {
    let _g = begin();
    for state in [EN::STATE_ROSTER, EN::STATE_DEPARTED] {
        let (a, _, host) = accounts(state);
        for i in [2, 3] {
            let held = a[i].try_borrow_data().unwrap();
            assert_eq!(fail(&a, 0), ProgramError::AccountBorrowFailed);
            drop(held);
        }
        put(
            &mut a[2].try_borrow_mut_data().unwrap(),
            header::EVENT_SEQ,
            &u64::MAX.to_le_bytes(),
        );
        assert_eq!(fail(&a, 0), ProgramError::from(crate::error::OVERFLOW));
        put(
            &mut a[2].try_borrow_mut_data().unwrap(),
            header::EVENT_SEQ,
            &0u64.to_le_bytes(),
        );
        for slot in 0..4 {
            let t = wm::WideTransit::depart(
                wm::HOST_IDENTITY_FULL_REF_V1,
                host,
                0,
                0,
                TileAddress::new(host.key(), 0).unwrap(),
                10,
                12,
                GENESIS + 6000,
                100_999,
                25,
                10_000,
                [0x74; 32],
                0,
                0,
                PAYER,
            )
            .unwrap();
            let mut changed = a.clone();
            let i = 5 + slot;
            changed[i] = info(
                leak(a[i].key.to_bytes(), PROGRAM, t.to_bytes().to_vec(), 0, BIG),
                false,
                false,
            );
            assert_eq!(fail(&changed, 0), custom(FrontierError::HostInTransit));
        }
        exec(&a, &command(0)).unwrap();
    }
}

#[test]
fn unrelated_transit_is_preserved_and_malformed_or_foreign_owner_refuses() {
    let _g = begin();
    let (a, _, host) = accounts(EN::STATE_DEPARTED);
    let other = WideHostRef::new(host.key(), host.site(), host.gen(), host.seq() + 1).unwrap();
    let t = wm::WideTransit::depart(
        wm::HOST_IDENTITY_FULL_REF_V1,
        other,
        0,
        0,
        TileAddress::new(host.key(), 0).unwrap(),
        10,
        12,
        GENESIS + 6000,
        100_999,
        25,
        10_000,
        [0x74; 32],
        0,
        0,
        PAYER,
    )
    .unwrap();
    for (owner, malformed) in [(PROGRAM, true), ([0xf8; 32], false)] {
        let mut changed = a.clone();
        let mut bytes = t.to_bytes().to_vec();
        if malformed {
            bytes[0] ^= 1;
        }
        changed[5] = info(
            leak(a[5].key.to_bytes(), owner, bytes, 0, BIG),
            false,
            false,
        );
        assert_eq!(fail(&changed, 0), custom(FrontierError::BadAccount));
    }
    let mut changed = a.clone();
    changed[5] = info(
        leak(a[5].key.to_bytes(), PROGRAM, t.to_bytes().to_vec(), 0, BIG),
        false,
        false,
    );
    let transit_before = snapshot(&changed)[5].clone();
    exec(&changed, &command(0)).unwrap();
    assert_eq!(snapshot(&changed)[5], transit_before);
    assert_eq!(
        read_entry(&changed[2].try_borrow_data().unwrap(), 0).unwrap(),
        Entry::FREE
    );
}

#[test]
fn foreign_home_above_js_integer_precision_keeps_full_identity() {
    let _g = begin();
    let (mut a, _, old_host) = accounts(EN::STATE_DEPARTED);
    let home = ProvinceKey::new(
        old_host.key().world(),
        WideCoord::checked(9_007_199_254_740_993, -1).unwrap(),
    );
    let host = WideHostRef::new(home, old_host.site(), old_host.gen(), old_host.seq()).unwrap();
    let ctx = crate::addr::ctx(&a[1].key.to_bytes(), &PROGRAM);
    let mut hd = a[4].try_borrow_data().unwrap().to_vec();
    let mut holding = WideHolding::read(&hd).unwrap();
    holding.coord = home.coord();
    holding.write_identity(&mut hd).unwrap();
    a[4] = info(
        leak(
            wh::holding_address(&ctx, home.coord(), host.site()),
            PROGRAM,
            hd,
            0,
            BIG,
        ),
        false,
        false,
    );
    {
        let mut rd = a[3].try_borrow_mut_data().unwrap();
        let roster = WideRoster::read(&rd).unwrap();
        roster.release(&mut rd, 0).unwrap();
        let alias = roster.claim(&mut rd, 0, &host).unwrap();
        let mut pd = a[2].try_borrow_mut_data().unwrap();
        let mut e = read_entry(&pd, 0).unwrap();
        e.id = alias;
        write_entry(&mut pd, 0, &e).unwrap();
    }
    for slot in 0..4 {
        a[5 + slot] = wallet(
            wm::transit_address(&ctx, &a[4].key.to_bytes(), slot as u8),
            false,
            false,
            0,
        );
    }
    exec(&a, &command(0)).unwrap();
    let logs = WIDE_LOGS.lock().unwrap();
    let r = WideRecord::decode(logs.last().unwrap()).unwrap();
    assert_eq!(r.host(), Some(host));
    assert_eq!(r.home_of(), Some(home));
    assert_eq!(r.province_of(), Some(old_host.key()));
    assert_ne!(r.home_of(), r.province_of());
}
