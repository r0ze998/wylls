//! Literal NFT proofs through actual WideResidentAct -> WideGarrison.
//! No Join, transfer, lifecycle, signing, rollback executor or native crypto.
use super::*;
use frontier_abi::resident_auth::resident_account as RR;

fn nft_fixture() -> Vec<AccountInfo<'static>> {
    let mut a = fixture();
    let season = a[2].key.to_bytes();
    let ctx = crate::addr::ctx(&season, &PROGRAM);
    let citizen = ctx.citizen_by_tag15(&resident_citizen::resident_tag15(&ASSET));
    let mut cd = citizen_bytes(&citizen, &[0; 32], 0, join_shard_of(&ASSET));
    assert!(resident_citizen::mark(&mut cd, &ASSET));
    wh::bind(&mut cd, 2).unwrap();
    a[3] = info(leak(citizen, PROGRAM, cd, 0, BIG), false, true);
    put(
        &mut a[4].try_borrow_mut_data().unwrap(),
        H::OWNER_CITIZEN,
        &citizen,
    );
    let resident = pda(&[b"resident", &ASSET], &RESIDENT_PROGRAM);
    let mut policy = vec![0; resident_policy::LEN];
    assert!(resident_policy::write_once(
        &mut policy,
        &Policy {
            core_program: CORE,
            resident_program: RESIDENT_PROGRAM,
            collection: COLLECTION,
            guard_authority: guard(),
        }
    ));
    let mut link = vec![0; resident_binding::LEN];
    assert!(resident_binding::write_once(
        &mut link,
        &resident_binding::Record {
            asset: ASSET,
            resident,
            citizen,
        }
    ));
    for (key, owner, bytes) in [
        (pda(&[b"nft-resident-policy"], &PROGRAM), PROGRAM, policy),
        (
            pda(&[b"nft-citizen-link", &season, &ASSET], &PROGRAM),
            PROGRAM,
            link,
        ),
        (ASSET, CORE, asset_bytes(&WALLET_A)),
        (resident, RESIDENT_PROGRAM, resident_bytes(0)),
    ] {
        a.push(info(leak(key, owner, bytes, 0, BIG), false, false));
    }
    a
}

fn act(generation: u32) -> Vec<u8> {
    let inner = data(1);
    let mut out = vec![0; wix::ResidentAct::HEAD + inner.len()];
    let n = wix::ResidentAct {
        generation,
        inner: &inner,
    }
    .encode_into(&mut out)
    .unwrap();
    assert_eq!(n, out.len());
    out
}

fn nft_refused(a: &[AccountInfo<'static>], instruction: &[u8]) -> ProgramError {
    let before = snapshot(a);
    let logs = (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    );
    let err = exec(a, instruction).unwrap_err();
    assert_eq!(snapshot(a), before);
    assert_eq!(
        (
            LOGS.lock().unwrap().clone(),
            WIDE_LOGS.lock().unwrap().clone()
        ),
        logs
    );
    err
}

#[test]
fn current_literal_owner_commits_garrison_and_preserves_proofs() {
    let _g = begin();
    let a = nft_fixture();
    let before = snapshot(&a);
    exec(&a, &act(0)).unwrap();
    let after = snapshot(&a);
    assert_eq!(&after[..3], &before[..3]);
    assert_eq!(&after[6..], &before[6..]);
    assert_eq!(Ro(&after[4].1).u32(H::reserve(0)).unwrap(), 99);
    assert_eq!(
        Ro(&after[5].1).i64(PV::site(0) + SM::PEND0_DELTA).unwrap(),
        MILLI
    );
    assert_eq!(
        Ro(&after[3].1).i64(C::LAST_ACTION_TS).unwrap(),
        GENESIS + 6000
    );
    assert!(LOGS.lock().unwrap().is_empty());
    let logs = WIDE_LOGS.lock().unwrap();
    assert_eq!(logs.len(), 1);
    let record = WideRecord::decode(&logs[0]).unwrap();
    assert_eq!(record.kind, WideKind::Garrison);
    assert_eq!(
        wev::GarrisonReceipt::decode(record.payload).unwrap().delta,
        1
    );
}

#[test]
fn changed_owner_and_stale_generation_refuse_without_writes() {
    let _g = begin();
    let mut a = nft_fixture();
    assert_eq!(
        nft_refused(&a, &act(1)),
        ProgramError::Custom(CE::ResidentStaleGeneration.code())
    );
    put(&mut a[8].try_borrow_mut_data().unwrap(), 1, &WALLET_B);
    put(
        &mut a[9].try_borrow_mut_data().unwrap(),
        RR::GENERATION,
        &1u32.to_le_bytes(),
    );
    assert_eq!(
        nft_refused(&a, &act(0)),
        ProgramError::Custom(CE::ResidentStaleGeneration.code())
    );
    assert_eq!(
        nft_refused(&a, &act(1)),
        ProgramError::Custom(CE::ResidentNotCurrentAuthority.code())
    );
    a[0] = wallet(WALLET_B, true, false, 0);
    exec(&a, &act(1)).unwrap();
    // Literal buy-back pre-state: the original owner's old generation stays stale.
    put(&mut a[8].try_borrow_mut_data().unwrap(), 1, &WALLET_A);
    put(
        &mut a[9].try_borrow_mut_data().unwrap(),
        RR::GENERATION,
        &2u32.to_le_bytes(),
    );
    a[0] = wallet(WALLET_A, true, false, 0);
    assert_eq!(
        nft_refused(&a, &act(0)),
        ProgramError::Custom(CE::ResidentStaleGeneration.code())
    );
    exec(&a, &act(2)).unwrap();
}

#[test]
fn resident_session_must_be_current_and_unexpired() {
    let _g = begin();
    let mut a = nft_fixture();
    a[0] = wallet([0x5e; 32], true, false, 0);
    {
        let mut r = a[9].try_borrow_mut_data().unwrap();
        put(&mut r, RR::SESSION, &[0x5e; 32]);
        put(&mut r, RR::SESSION_SETTER, &WALLET_A);
        put(&mut r, RR::SESSION_EXPIRY, &(GENESIS + 6001).to_le_bytes());
    }
    exec(&a, &act(0)).unwrap();
    for (offset, invalid, restore) in [
        (
            RR::SESSION_EXPIRY,
            (GENESIS + 6000).to_le_bytes().to_vec(),
            (GENESIS + 6001).to_le_bytes().to_vec(),
        ),
        (RR::SESSION_SETTER, WALLET_B.to_vec(), WALLET_A.to_vec()),
        (
            RR::SESSION_GENERATION,
            1u32.to_le_bytes().to_vec(),
            0u32.to_le_bytes().to_vec(),
        ),
    ] {
        put(&mut a[9].try_borrow_mut_data().unwrap(), offset, &invalid);
        assert_eq!(
            nft_refused(&a, &act(0)),
            ProgramError::Custom(CE::ResidentNotCurrentAuthority.code())
        );
        put(&mut a[9].try_borrow_mut_data().unwrap(), offset, &restore);
    }
}

#[test]
fn signer_policy_proof_and_wallet_bypass_refuse_without_writes() {
    let _g = begin();
    let a = nft_fixture();
    let mut unsigned = a.clone();
    unsigned[0].is_signer = false;
    nft_refused(&unsigned, &act(0));
    nft_refused(&a[..6], &data(1));
    for i in 6..10 {
        let mut wrong = a.clone();
        wrong[i].is_writable = true;
        nft_refused(&wrong, &act(0));
        let mut wrong = a.clone();
        wrong[i] = info(
            leak(
                a[i].key.to_bytes(),
                [0x66; 32],
                a[i].try_borrow_data().unwrap().to_vec(),
                0,
                BIG,
            ),
            false,
            false,
        );
        nft_refused(&wrong, &act(0));
        let mut wrong = a.clone();
        wrong[i] = info(
            leak(
                [0x66; 32],
                a[i].owner.to_bytes(),
                a[i].try_borrow_data().unwrap().to_vec(),
                0,
                BIG,
            ),
            false,
            false,
        );
        nft_refused(&wrong, &act(0));
    }
}

#[test]
fn malformed_guard_and_binding_bytes_refuse_without_writes() {
    let _g = begin();
    // The literal asset builder appends exactly guarded_tail to the base.
    let base = asset_bytes(&WALLET_A).len() - guarded_tail(0, &guard()).len();
    // Missing plugin header, thawed permanent freeze, wrong permanent
    // transfer authority. The latter's address starts after the registry
    // header (5), first entry (42), and second entry kind/authority (2).
    for offset in [base, base + 10, base + 12 + 5 + 42 + 2] {
        let a = nft_fixture();
        a[8].try_borrow_mut_data().unwrap()[offset] ^= 1;
        assert_eq!(
            nft_refused(&a, &act(0)),
            ProgramError::Custom(CE::ResidentUnguarded.code())
        );
    }
    // Correct canonical link address/owner, but each embedded identity
    // mismatches in turn: asset, resident, then Citizen.
    for offset in [8, 40, 72] {
        let a = nft_fixture();
        a[7].try_borrow_mut_data().unwrap()[offset] ^= 1;
        assert_eq!(nft_refused(&a, &act(0)), ProgramError::InvalidAccountData);
    }
    let a = nft_fixture();
    a[3].try_borrow_mut_data().unwrap()[resident_citizen::RESIDENT_ASSET] ^= 1;
    assert_eq!(
        nft_refused(&a, &act(0)),
        ProgramError::Custom(FrontierError::BadAccount.code())
    );
}
