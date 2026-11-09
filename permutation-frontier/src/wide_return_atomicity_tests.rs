//! Direct-dispatch WideReturn regressions: no run_tx, restore, native
//! crypto, or lifecycle setup. All accounts are synthetic codec-written
//! fixtures at public derived addresses, not evidence of chain execution.
use super::*;
use frontier_abi::entry::Entry;
use frontier_abi::layout::header;
use frontier_abi::world_index::march as wm;

/// Three departed Leave entries: two current-generation returns around
/// one stale-generation loss. Fractional troops must be rounded once.
fn fixture() -> Vec<AccountInfo<'static>> {
    let bump = season_bump(SEASON_ID);
    let season_key = crate::addr::season_pda(SEASON_ID, bump, &PROGRAM);
    let ctx = crate::addr::ctx(&season_key, &PROGRAM);
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let pkey = ProvinceKey::new(world, coord);
    let hkey = wh::holding_address(&ctx, coord, 0);
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
    let roster = WideRoster::new(SEASON_ID, pkey, PAYER2);
    let mut rd = vec![0; wro::wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    for (i, gen) in [2, 1, 2].into_iter().enumerate() {
        let host = WideHostRef::new(pkey, 0, gen, i as u32).unwrap();
        let alias = roster.claim(&mut rd, i, &host).unwrap();
        write_entry(
            &mut pd,
            i,
            &Entry {
                id: alias,
                state: EN::STATE_DEPARTED,
                troops: 100_999 + 1_000 * i as u32,
                op: EntryOp::Leave,
                ..Entry::FREE
            },
        )
        .unwrap();
    }
    pd[PV::N_ENTRIES] = 3;
    let mut hd = vec![0; wh::wide_holding::SIZE];
    let mut holding = WideHolding::found(
        world,
        SEASON_ID,
        coord,
        0,
        2,
        2,
        WALLET_A,
        &wl::Decision::Decided(()),
    )
    .unwrap();
    holding.host_identity = HOST_IDENTITY_FULL_REF_V1;
    holding.write_identity(&mut hd).unwrap();
    hd[H::STATE] = H::STATE_FINAL;
    hd[H::ORDER] = 2;
    put(&mut hd, H::HOST_SEQ, &3u32.to_le_bytes());
    put(&mut hd, H::reserve(0), &7u32.to_le_bytes());
    let account = |key, bytes, writable| info(leak(key, PROGRAM, bytes, 0, BIG), false, writable);
    let mut accounts = vec![
        wallet(PAYER2, true, true, BIG),
        account(
            season_key,
            season_bytes(bump, &conquest(&HOME), &HOME),
            false,
        ),
        account(wl::province_address(&ctx, coord), pd, true),
        account(wro::roster_address(&ctx, pkey), rd, true),
        account(hkey, hd, true),
    ];
    for slot in 0..4 {
        accounts.push(wallet(
            wm::transit_address(&ctx, &hkey, slot),
            false,
            false,
            0,
        ));
    }
    accounts
}

fn exec(a: &[AccountInfo<'static>]) -> Result<(), ProgramError> {
    crate::dispatch(&Pubkey::new_from_array(PROGRAM), a, &wix::Return.to_bytes())
        .map_err(ProgramError::from)
}

fn snapshot(a: &[AccountInfo<'static>]) -> Vec<(u64, Vec<u8>, Pubkey)> {
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

fn unchanged(a: &[AccountInfo<'static>], before: &[(u64, Vec<u8>, Pubkey)]) {
    assert_eq!(snapshot(a), before);
    assert!(wide_records().is_empty());
    assert!(records().is_empty());
}

#[test]
fn chain_overflow_refuses_without_partial_returns_or_logs() {
    let _g = begin();
    for (account, seq) in [
        (2, u64::MAX),
        (2, u64::MAX - 1),
        (4, u64::MAX),
        (4, u64::MAX - 1),
    ] {
        let a = fixture();
        put(
            &mut a[account].try_borrow_mut_data().unwrap(),
            header::EVENT_SEQ,
            &seq.to_le_bytes(),
        );
        let before = snapshot(&a);
        assert_eq!(exec(&a), Err(ProgramError::from(crate::error::OVERFLOW)));
        unchanged(&a, &before);
    }
}

#[test]
fn held_borrows_refuse_without_partial_returns_or_logs() {
    let _g = begin();
    for index in [2, 3, 4] {
        let a = fixture();
        let before = snapshot(&a);
        // An immutable borrow permits validation/staging, but prevents the
        // final write borrow. No emulated rollback hides partial writes.
        let held = a[index].try_borrow_data().unwrap();
        assert_eq!(exec(&a), Err(ProgramError::AccountBorrowFailed));
        drop(held);
        unchanged(&a, &before);
    }
}

#[test]
fn mixed_returns_credit_once_and_chain_every_record_in_entry_order() {
    let _g = begin();
    let a = fixture();
    let before = snapshot(&a);
    assert_eq!(exec(&a), Ok(()));
    assert_eq!(rd_u32(&a[4].try_borrow_data().unwrap(), H::reserve(0)), 209);
    let pd = a[2].try_borrow_data().unwrap();
    let rd = a[3].try_borrow_data().unwrap();
    let roster = WideRoster::read(&rd).unwrap();
    assert_eq!(pd[PV::N_ENTRIES], 0);
    for i in 0..3 {
        assert_eq!(read_entry(&pd, i).unwrap(), Entry::FREE);
        assert_eq!(roster.ref_at(&rd, i).unwrap(), None);
    }
    drop(pd);
    drop(rd);
    let logs = wide_records();
    assert_eq!(logs.len(), 3);
    let mut pchain = crate::layout::chain_of(&before[2].1).unwrap();
    let mut hchain = crate::layout::chain_of(&before[4].1).unwrap();
    for (i, bytes) in logs.iter().enumerate() {
        let record = WideRecord::decode(bytes).unwrap();
        assert_eq!(
            record.kind,
            if i == 1 {
                WideKind::Stranded
            } else {
                WideKind::Return
            }
        );
        let plink = record.link(WideEntity::Province).unwrap();
        assert_eq!(
            plink,
            wev::advance(
                WideEntity::Province,
                pchain.0,
                &pchain.1,
                record.body_without_tail
            )
            .unwrap()
        );
        pchain = (plink.seq, plink.head);
        if i != 1 {
            let hlink = record.link(WideEntity::Holding).unwrap();
            assert_eq!(
                hlink,
                wev::advance(
                    WideEntity::Holding,
                    hchain.0,
                    &hchain.1,
                    record.body_without_tail
                )
                .unwrap()
            );
            hchain = (hlink.seq, hlink.head);
            assert_eq!(
                &record.payload[..4],
                &(100_000 + 1_000 * i as u32).to_le_bytes()
            );
        } else {
            assert!(record.link(WideEntity::Holding).is_none());
            assert_eq!(&record.payload[..4], &101_999u32.to_le_bytes());
        }
    }
    assert_eq!(
        crate::layout::chain_of(&a[2].try_borrow_data().unwrap()).unwrap(),
        pchain
    );
    assert_eq!(
        crate::layout::chain_of(&a[4].try_borrow_data().unwrap()).unwrap(),
        hchain
    );
    for (i, ai) in a.iter().enumerate() {
        assert_eq!((ai.lamports(), *ai.owner), (before[i].0, before[i].2));
        if ![2, 3, 4].contains(&i) {
            assert_eq!(&ai.try_borrow_data().unwrap()[..], &before[i].1[..]);
        }
    }
    assert!(records().is_empty());
    let after = snapshot(&a);
    assert_eq!(exec(&a), Err(ProgramError::Custom(E::AlreadyDone as u32)));
    unchanged(&a, &after);
}
