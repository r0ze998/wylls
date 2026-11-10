//! Unsigned native terminal-close execution. Reuses the existing literal
//! original bridge/marker fixture; no seal creation, signing or crypto API.
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
    let a = super::super::tests::terminal_fixture();
    let mut out: Accounts = a
        .iter()
        .map(|a| {
            let mut v = AccountSharedData::new(a.lamports(), a.data_len(), a.owner);
            v.set_data_from_slice(&a.try_borrow_data().unwrap());
            (*a.key, v)
        })
        .collect();
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
            let result = super::super::close_terminal_draft(p, a, d);
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
fn terminal_wire_closes_rent_only_with_present_or_closed_original_holding() {
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
fn terminal_wire_requires_actual_end_grace_or_canonical_closed_tombstone() {
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
fn terminal_wire_refusals_are_inert_after_successful_native_writeback() {
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
                assert!(super::super::close_terminal_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
        let out = unsafe {
            rt::run(a.clone(), 4, roles(), wire(), |p, a, d| {
                let _borrow = a[i].try_borrow_mut_lamports()?;
                assert!(super::super::close_terminal_draft(p, a, d).is_err());
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
                assert!(super::super::close_terminal_draft(p, a, d).is_err());
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
                assert!(super::super::close_terminal_draft(p, a, d).is_err());
                Ok(())
            })
        }
        .unwrap();
        assert_eq!(out, a.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
    }
    assert!(logs.lock().unwrap().is_empty());
}
