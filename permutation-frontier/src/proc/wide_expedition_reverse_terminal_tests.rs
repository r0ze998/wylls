//! Unsigned native terminal-close execution. Reuses the existing literal
//! reverse record/marker fixture; no seal creation, signing or crypto API.
use super::*;
use alloc::boxed::Box;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
};
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::{Arc, Mutex};
type Accounts = Vec<(Pubkey, AccountSharedData)>;
type Logs = Vec<Vec<Vec<u8>>>;
struct Capture(Arc<Mutex<Logs>>);
impl SyscallStubs for Capture {
    fn sol_invoke_signed(
        &self,
        _: &solana_program::instruction::Instruction,
        _: &[AccountInfo],
        _: &[&[&[u8]]],
    ) -> Result<(), solana_program::program_error::ProgramError> {
        panic!("CPI forbidden in terminal cleanup")
    }
    fn sol_log_data(&self, f: &[&[u8]]) {
        self.0
            .lock()
            .unwrap()
            .push(f.iter().map(|b| b.to_vec()).collect());
    }
}
struct Hook(Option<Box<dyn SyscallStubs>>);
impl Drop for Hook {
    fn drop(&mut self) {
        set_syscall_stubs(self.0.take().unwrap());
    }
}
fn fixture(absent: bool) -> Accounts {
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    const PROGRAM: [u8; 32] = [12; 32];
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(11)], &p).1;
    let sk = addr::season_pda(11, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 0, 1, 0).unwrap())
        .unwrap();
    let wide = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
    let reverse = ReverseTransit::new(
        &ctx,
        2,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            TileAddress::new(wide, 30).unwrap(),
            10,
            12,
            1_800_006_000,
            200_000,
            100,
            10_000,
            [44; 32],
            0,
            0,
            [22; 32],
        )
        .unwrap(),
        [33; 32],
        host.key(),
    )
    .unwrap();
    let marker = ReverseMarker::new(
        &ctx,
        &reverse,
        7,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, 11));
    let mut w = Rw(&mut sd);
    w.set_u8(S::STATUS, S::STATUS_ABORTED).unwrap();
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, 1_800_000_000).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_u64(S::MARCH_FEE, 10).unwrap();
    w.set_u64(S::SEAL_BOND, 20).unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, 11));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &[33; 32]).unwrap();
    w.set_arr(H::RENT_PAYER, &[55; 32]).unwrap();
    w.set_u64(H::ESCROW, 37).unwrap();
    hd[H::transit(2)..H::transit(2) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    let holding = resolver.holding_address(&host).unwrap();
    let literal = |key: [u8; 32], owner: Pubkey, balance: u64, data: Vec<u8>| {
        let mut a = AccountSharedData::new(balance, data.len(), &owner);
        a.set_data_from_slice(&data);
        (Pubkey::new_from_array(key), a)
    };
    let mut out = vec![
        literal(sk, p, 20_000_000, sd),
        literal(holding, p, 20_000_000, hd),
        literal(
            wm::transit_address(&ctx, &holding, 2),
            p,
            1_000_000,
            reverse.to_bytes().to_vec(),
        ),
        literal([22; 32], init::SYSTEM, 1_000_000, vec![]),
    ];
    prologue::set_test_clock(1_800_006_000, 1);
    if absent {
        out[1].1 = AccountSharedData::new(17, 0, &init::SYSTEM);
    }
    let mut p = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    p.set_executable(true);
    out.push((Pubkey::new_from_array([12; 32]), p));
    out
}
fn roles() -> Vec<InstructionAccount> {
    (0..4)
        .map(|i| InstructionAccount::new(i, false, i != 0))
        .collect()
}
fn wire() -> Vec<u8> {
    ix::DraftCommand::new(2).unwrap().to_bytes().to_vec()
}
fn run(
    a: &Accounts,
    r: Vec<InstructionAccount>,
    d: Vec<u8>,
    refuse: bool,
) -> Vec<AccountSharedData> {
    // SAFETY: official serializer backing only; no account/reference escapes.
    unsafe {
        rt::run(a.clone(), 4, r, d, |p, a, d| {
            let result = execute_draft(p, a, d);
            if refuse {
                assert!(result.is_err());
                Ok(())
            } else {
                result.map_err(Into::into)
            }
        })
    }
    .unwrap()
}
fn unchanged(a: &Accounts, r: Vec<InstructionAccount>, d: Vec<u8>) {
    assert_eq!(
        run(a, r, d, true),
        a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>()
    );
}
fn edits(a: &mut Accounts, i: usize, edit: impl FnOnce(&mut [u8])) {
    let mut d = a[i].1.data().to_vec();
    edit(&mut d);
    a[i].1.set_data_from_slice(&d);
}
#[test]
fn reverse_terminal_wire_closes_rent_only_with_present_or_closed_original_holding() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let _hook = Hook(Some(set_syscall_stubs(Box::new(Capture(logs.clone())))));
    for absent in [false, true] {
        let a = fixture(absent);
        let ctx = addr::ctx(&a[0].0.to_bytes(), &[12; 32]);
        let before_total: u64 = a.iter().map(|(_, v)| v.lamports()).sum();
        let out = run(&a, roles(), wire(), false);
        assert_eq!(out.iter().map(|v| v.lamports()).sum::<u64>(), before_total);
        assert_eq!(out[0], a[0].1);
        assert!(out[2].data().is_empty());
        assert_eq!(*out[2].owner(), init::SYSTEM);
        assert_eq!(out[2].lamports(), 0);
        assert_eq!(out[3].lamports(), a[3].1.lamports() + a[2].1.lamports());
        assert_eq!(out[3].data(), a[3].1.data());
        assert_eq!(out[3].owner(), a[3].1.owner());
        if absent {
            assert_eq!(out[1], a[1].1);
        } else {
            let mut expected = a[1].1.data().to_vec();
            expected[H::transit(2)..H::transit(2) + MARKER_LEN].fill(0);
            assert_eq!(out[1].data(), expected);
            assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 37);
            assert_eq!(out[1].lamports(), a[1].1.lamports());
        }
        let records = core::mem::take(&mut *logs.lock().unwrap());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0][0], event::PREFIX);
        let receipt = event::Receipt::decode(&ctx, &records[0][1]).unwrap();
        assert_eq!(
            (receipt.slot, receipt.holding_present, receipt.rent),
            (2, !absent, a[2].1.lamports())
        );
        assert_eq!(receipt.rent_to, a[3].0.to_bytes());
        assert_eq!(receipt.original_owner, [33; 32]);
        assert_ne!(receipt.input, receipt.output);
        let snapshots = |accounts: &Accounts| {
            accounts[..4]
                .iter()
                .enumerate()
                .map(|(i, (k, a))| Snapshot {
                    address: k.to_bytes(),
                    owner: a.owner().to_bytes(),
                    present: !(a.owner() == &init::SYSTEM && a.data().is_empty()),
                    signer: false,
                    writable: i != 0,
                    lamports: a.lamports(),
                    data: a.data().to_vec(),
                })
                .collect::<Vec<_>>()
        };
        let after: Accounts = a.iter().map(|(k, _)| *k).zip(out).collect();
        assert_eq!(
            receipt.input,
            event::manifest(
                &ctx,
                &wire(),
                receipt.now_ts,
                receipt.now_slot,
                &manifest(&snapshots(&a))
            )
        );
        assert_eq!(
            receipt.output,
            event::manifest(
                &ctx,
                &wire(),
                receipt.now_ts,
                receipt.now_slot,
                &manifest(&snapshots(&after))
            )
        );
        for i in [4, 5, 6, 7, 24, 80, 112, 144, 152, 184, 216] {
            let mut bad = records[0][1].clone();
            bad[i] ^= 0x80;
            assert!(event::Receipt::decode(&ctx, &bad).is_err());
        }
        unchanged(&after, roles(), wire());
        assert!(logs.lock().unwrap().is_empty());
    }
}
#[test]
fn reverse_terminal_wire_requires_actual_end_grace_or_canonical_closed_tombstone() {
    let a = fixture(false);
    let mut running = a.clone();
    edits(&mut running, 0, |d| {
        Rw(d).set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    });
    unchanged(&running, roles(), wire());
    let mut ended = a.clone();
    edits(&mut ended, 0, |d| {
        Rw(d).set_u8(S::STATUS, S::STATUS_ENDED).unwrap();
    });
    let deadline = 1_800_000_000 + 1000 * 600 + crate::proc::map::END_GRACE_SECS;
    prologue::set_test_clock(deadline - 1, 5);
    unchanged(&ended, roles(), wire());
    prologue::set_test_clock(deadline, 6);
    assert!(run(&ended, roles(), wire(), false)[2].data().is_empty());
    let mut closed = ended.clone();
    let mut d = closed[0].1.data()[..S::TOMBSTONE_SIZE].to_vec();
    Rw(&mut d).set_u8(S::STATUS, S::STATUS_CLOSED).unwrap();
    closed[0].1.set_data_from_slice(&d);
    assert!(run(&closed, roles(), wire(), false)[2].data().is_empty());
    closed[0].0 = Pubkey::new_from_array([44; 32]);
    unchanged(&closed, roles(), wire());
}
#[test]
fn reverse_terminal_wire_refusals_are_inert_after_successful_native_writeback() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let _hook = Hook(Some(set_syscall_stubs(Box::new(Capture(logs.clone())))));
    let a = fixture(false);
    // Public dispatch is not admitted even with otherwise valid accounts.
    let out = unsafe {
        rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
            assert_eq!(crate::dispatch(p, a, d), Err(FrontierError::BadData.into()));
            Ok(())
        })
    }
    .unwrap();
    assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
    for n in 0..5 {
        unchanged(&a, roles(), wire()[..n].to_vec());
    }
    let mut extra = wire();
    extra.push(0);
    unchanged(&a, roles(), extra);
    for i in 0..5 {
        let mut bad = wire();
        bad[i] ^= 0x80;
        unchanged(&a, roles(), bad);
    }
    let mut wrong_slot = wire();
    wrong_slot[4] = 1;
    unchanged(&a, roles(), wrong_slot);
    unchanged(&a, roles()[..3].to_vec(), wire());
    let mut extra = roles();
    extra.push(InstructionAccount::new(0, false, false));
    unchanged(&a, extra, wire());
    for i in 1..4 {
        let mut r = roles();
        r[i] = InstructionAccount::new(i as u16, false, false);
        unchanged(&a, r, wire());
    }
    let mut alias = roles();
    alias[3] = InstructionAccount::new(1, false, true);
    unchanged(&a, alias, wire());
    for i in 0..4 {
        let mut bad = a.clone();
        bad[i].0 = Pubkey::new_from_array([44; 32]);
        unchanged(&bad, roles(), wire());
    }
    for i in 0..3 {
        let mut bad = a.clone();
        bad[i].1.set_owner(init::SYSTEM);
        unchanged(&bad, roles(), wire());
    }
    let mut bad = a.clone();
    bad[3].1.set_lamports(u64::MAX);
    unchanged(&bad, roles(), wire());
    let mut bad = a.clone();
    edits(&mut bad, 1, |d| {
        d[H::transit(2)..H::transit(2) + MARKER_LEN].fill(0)
    });
    unchanged(&bad, roles(), wire());
    for i in 1..4 {
        let out = unsafe {
            rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
                let _borrow = a[i].try_borrow_mut_data()?;
                assert!(execute_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
        let out = unsafe {
            rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
                let _borrow = a[i].try_borrow_mut_lamports()?;
                assert!(execute_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
    }
    // Shared borrows allow all read-only authentication/staging to finish;
    // refusal must still precede resize/assignment, marker clear or transfer.
    for i in [1, 2] {
        let out = unsafe {
            rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
                let _borrow = a[i].try_borrow_data()?;
                assert!(execute_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
    }
    for i in [2, 3] {
        let out = unsafe {
            rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
                let _borrow = a[i].try_borrow_lamports()?;
                assert!(execute_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
    }
    assert!(logs.lock().unwrap().is_empty());
}

#[test]
fn reverse_terminal_captured_owner_remains_immutable_and_bad_history_refuses() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let _hook = Hook(Some(set_syscall_stubs(Box::new(Capture(logs.clone())))));
    let current = fixture(false);
    let ctx = addr::ctx(&current[0].0.to_bytes(), &[12; 32]);
    let reverse = ReverseTransit::from_bytes(&ctx, current[2].1.data()).unwrap();
    let mut captured = current.clone();
    edits(&mut captured, 1, |d| {
        let mut w = Rw(d);
        w.set_u8(H::GEN, 2).unwrap();
        w.set_u32(H::HOST_SEQ, 0).unwrap();
        w.set_arr(H::OWNER_CITIZEN, &[77; 32]).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
            .unwrap();
        w.set_u8(H2::PREV_GEN, 1).unwrap();
        w.set_u64(H2::PREV_OWNER_TAG, addr::citizen_tag(&[33; 32]))
            .unwrap();
        w.set_u64(H::ESCROW, 17).unwrap();
        // Explicit captured prior-state fixture: the existing capture rule
        // already returned the bond, leaving fee and tip in the Holding.
        let marker = ReverseMarker::new(&ctx, &reverse, 7, T::FLAG_FEE_ESCROWED).unwrap();
        d[H::transit(2)..H::transit(2) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    });
    captured[1].1.set_lamports(current[1].1.lamports() - 20);
    let out = run(&captured, roles(), wire(), false);
    assert_eq!(out[1].lamports(), captured[1].1.lamports());
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 17);
    assert_eq!(
        Ro(out[1].data()).arr::<32>(H::OWNER_CITIZEN).unwrap(),
        [77; 32]
    );
    assert_eq!(
        out[3].lamports(),
        captured[3].1.lamports() + captured[2].1.lamports()
    );
    let record = logs.lock().unwrap()[0][1].clone();
    let receipt = event::Receipt::decode(&ctx, &record).unwrap();
    assert!(receipt.captured && receipt.holding_present);
    assert_eq!(receipt.original_owner, [33; 32]);
    assert_eq!(receipt.rent_to, [22; 32]);
    assert_eq!(receipt.escrow_remaining, 17);
    for case in 0..5 {
        let mut bad = captured.clone();
        edits(&mut bad, 1, |d| {
            let mut w = Rw(d);
            match case {
                0 => w.set_u8(H2::CAPTURE_FLAGS, 0).unwrap(),
                1 => w.set_u8(H2::PREV_GEN, 0).unwrap(),
                2 => w.set_u64(H2::PREV_OWNER_TAG, 99).unwrap(),
                3 => w.set_u8(H::GEN, 1).unwrap(),
                4 => d[H::transit(2) + T::SEAL_ROOT + 31] ^= 1,
                _ => unreachable!(),
            }
        });
        unchanged(&bad, roles(), wire());
    }
    let mut wrong_full_owner = current.clone();
    edits(&mut wrong_full_owner, 1, |d| d[H::OWNER_CITIZEN + 31] ^= 1);
    unchanged(&wrong_full_owner, roles(), wire());
    let mut never_issued = current.clone();
    edits(&mut never_issued, 1, |d| {
        Rw(d).set_u32(H::HOST_SEQ, 0).unwrap()
    });
    unchanged(&never_issued, roles(), wire());
}

#[test]
fn actual_original_close_holding_pays_remaining_escrow_before_or_after_reverse_close() {
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    for holding_first in [false, true] {
        let mut accounts = fixture(false);
        let ctx = addr::ctx(&accounts[0].0.to_bytes(), &[12; 32]);
        edits(&mut accounts, 1, |d| {
            Rw(d).set_u64(H::POOL_OWED, 13).unwrap()
        });
        accounts.push((
            Pubkey::new_from_array([66; 32]),
            AccountSharedData::new(1_000_000, 0, &init::SYSTEM),
        ));
        accounts.push((
            Pubkey::new_from_array([55; 32]),
            AccountSharedData::new(1_000_000, 0, &init::SYSTEM),
        ));
        let mut pool = vec![0; K2::DefencePool.size()];
        assert!(write_header(&mut pool, K2::DefencePool, 11));
        let mut pa =
            AccountSharedData::new(1_000_000, pool.len(), &Pubkey::new_from_array([12; 32]));
        pa.set_data_from_slice(&pool);
        accounts.push((Pubkey::new_from_array(ctx.defence_pool()), pa));
        let before = accounts.clone();
        let close_roles = vec![
            InstructionAccount::new(5, true, false),
            InstructionAccount::new(0, false, false),
            InstructionAccount::new(1, false, true),
            InstructionAccount::new(6, false, true),
            InstructionAccount::new(7, false, true),
        ];
        let original_close = |a: &Accounts| {
            // SAFETY: official runtime serialization; production CloseHolding
            // returns without retaining any AccountInfo or backing references.
            unsafe {
                rt::run(
                    a.clone(),
                    4,
                    close_roles.clone(),
                    frontier_abi::ix::CloseHolding {}.to_bytes().to_vec(),
                    |p, a, d| crate::proc::citizen::close_holding(p, a, d).map_err(Into::into),
                )
            }
            .unwrap()
        };
        let first = if holding_first {
            original_close(&accounts)
        } else {
            run(&accounts, roles(), wire(), false)
        };
        accounts = accounts.iter().map(|(k, _)| *k).zip(first).collect();
        if !holding_first {
            assert_eq!(Ro(accounts[1].1.data()).u64(H::ESCROW).unwrap(), 37);
            assert_eq!(accounts[1].1.lamports(), before[1].1.lamports());
        }
        let final_state = if holding_first {
            run(&accounts, roles(), wire(), false)
        } else {
            original_close(&accounts)
        };
        assert_eq!(final_state[1].lamports(), 0);
        assert!(final_state[1].data().is_empty());
        assert_eq!(*final_state[1].owner(), init::SYSTEM);
        assert_eq!(final_state[2].lamports(), 0);
        assert!(final_state[2].data().is_empty());
        assert_eq!(
            final_state[3].lamports(),
            before[3].1.lamports() + before[2].1.lamports()
        );
        // Existing original CloseHolding sends ALL remaining Holding lamports,
        // including the untouched 37 escrow, to H::RENT_PAYER after pool sweep.
        assert_eq!(
            final_state[6].lamports(),
            before[6].1.lamports() + before[1].1.lamports() - 13
        );
        assert_eq!(final_state[7].lamports(), before[7].1.lamports() + 13);
        assert_eq!(
            final_state
                .iter()
                .map(|a| a.lamports() as u128)
                .sum::<u128>(),
            before
                .iter()
                .map(|(_, a)| a.lamports() as u128)
                .sum::<u128>()
        );
        let after = before.iter().map(|(k, _)| *k).zip(final_state).collect();
        unchanged(&after, roles(), wire());
    }
}
