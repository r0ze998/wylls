//! Prospective unsigned native runtime-contract tests. Run only this module in
//! an independently audited, isolated process with --test-threads=1. No result
//! is claimed until that run succeeds. The ordinary proof fixture is copied to
//! literal accounts; it is never resized, assigned or closed itself.
//!
//! The unsafe boundary is the SDK operational AccountInfo contract: official
//! aligned serialization owns the length prefix, owner storage and growth area.
//! No AccountInfo, borrow, cloned reference or pointer escapes its closure.
//! This is not Rust soundness, SBF execution, authenticated signatures, producer
//! history, bank atomicity or rollback evidence. Failed contexts are discarded.
use super::*;
use alloc::boxed::Box;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, InstructionError, ProgramError,
    ReadableAccount, RunError, WritableAccount,
};
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::{Arc, Mutex};

const PROGRAM: [u8; 32] = [12; 32];
const SLOT: u8 = 2;
const POSITION: usize = wa::wide_clash_inputs::position(2, 0);
type Logs = Vec<Vec<Vec<u8>>>;

struct Capture(Arc<Mutex<Logs>>);
impl SyscallStubs for Capture {
    fn sol_invoke_signed(
        &self,
        _: &solana_program::instruction::Instruction,
        _: &[AccountInfo],
        _: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        panic!("CPI is forbidden in this unsigned runtime-contract test")
    }
    fn sol_log_data(&self, fields: &[&[u8]]) {
        self.0
            .lock()
            .unwrap()
            .push(fields.iter().map(|v| v.to_vec()).collect());
    }
}
struct Hook(Option<Box<dyn SyscallStubs>>, Arc<Mutex<Logs>>);
impl Hook {
    fn install() -> Self {
        let logs = Arc::new(Mutex::new(Vec::new()));
        Self(
            Some(set_syscall_stubs(Box::new(Capture(logs.clone())))),
            logs,
        )
    }
    fn take(&self) -> Logs {
        core::mem::take(&mut *self.1.lock().unwrap())
    }
}
impl Drop for Hook {
    fn drop(&mut self) {
        set_syscall_stubs(self.0.take().unwrap());
    }
}

fn literal(owner: Pubkey, balance: u64, data: &[u8]) -> AccountSharedData {
    let mut a = AccountSharedData::new(balance, data.len(), &owner);
    a.set_data_from_slice(data);
    a
}

struct Input {
    accounts: Vec<(Pubkey, AccountSharedData)>,
    roles: Vec<InstructionAccount>,
    base: usize,
    commit: [u8; 32],
    seal: [u8; wseal::WIDE_SEAL_LEN],
}
impl Input {
    fn fixture() -> Self {
        // Actual public Quicknet verification and symmetric-key recovery, then
        // a deterministic in-memory body. No new keypair/signature/RNG/export.
        let f = super::super::tests::fixture();
        let mut accounts: Vec<_> =
            f.a.iter()
                .chain(core::iter::once(&f.anchor))
                .map(|a| {
                    (
                        *a.key,
                        literal(*a.owner, a.lamports(), &a.try_borrow_data().unwrap()),
                    )
                })
                .collect();
        let base = f.a.len();
        let mut roles: Vec<_> = (0..accounts.len())
            .map(|i| InstructionAccount::new(i as u16, false, i > 0 && i < base))
            .collect();
        for (key, signer) in [([90; 32], true), ([36; 32], false), ([35; 32], false)] {
            roles.push(InstructionAccount::new(accounts.len() as u16, signer, true));
            accounts.push((
                Pubkey::new_from_array(key),
                literal(init::SYSTEM, 1_000_000_000, &[]),
            ));
        }
        // Real duplicate instruction index, never fake independent storage.
        roles.push(InstructionAccount::new(7, false, true));
        roles.push(InstructionAccount::new(accounts.len() as u16, false, true));
        accounts.push((
            Pubkey::new_from_array([91; 32]),
            literal(init::SYSTEM, 1_000_000_000, &[]),
        ));
        Self {
            accounts,
            roles,
            base,
            commit: f.commit,
            seal: f.seal,
        }
    }
    fn index(&self, role: usize) -> usize {
        self.roles[role].index_in_transaction as usize
    }
    fn account_mut(&mut self, role: usize) -> &mut AccountSharedData {
        let i = self.index(role);
        &mut self.accounts[i].1
    }
    fn run<F>(&self, helper: F) -> Result<Vec<AccountSharedData>, RunError>
    where
        F: for<'buffer, 'borrow> FnOnce(
            &'buffer Pubkey,
            &'borrow [AccountInfo<'buffer>],
            &'buffer [u8],
        ) -> Result<(), ProgramError>,
    {
        let mut accounts = self.accounts.clone();
        let program_index = accounts.len() as u16;
        let mut program = literal(solana_program::bpf_loader::id(), 1, &[]);
        program.set_executable(true);
        accounts.push((Pubkey::new_from_array(PROGRAM), program));
        // SAFETY: only official serializer bytes reach SDK deserialize. Every
        // caller below confines AccountInfo values and guards to this closure.
        unsafe { rt::run(accounts, program_index, self.roles.clone(), vec![], helper) }
    }
    fn settle(&self) -> Result<Vec<AccountSharedData>, RunError> {
        self.run(|p, a, _| {
            settle(p, a, self.base, SLOT, &self.commit, &self.seal).map_err(Into::into)
        })
    }
}

fn checked_settlement(f: &Input, hook: &Hook) -> Vec<AccountSharedData> {
    assert!(hook.take().is_empty());
    let mut expected_logs = Vec::new();
    let mut expected_accounts = Vec::new();
    let result = f
        .run(|p, a, _| {
            let expected =
                prepare(p, a, f.base, SLOT, &f.commit, &f.seal).map_err(ProgramError::from)?;
            for record in &expected.diversions {
                expected_logs.push(vec![frontier_abi::log::PREFIX.to_vec(), record.clone()]);
            }
            expected_logs.push(vec![
                frontier_abi::world_index::expedition_event::PREFIX.to_vec(),
                expected.receipts.original.clone(),
            ]);
            expected_logs.push(vec![
                wev::WIDE_LOG_PREFIX.to_vec(),
                expected.receipts.wide.clone(),
            ]);
            // Actual writer repeats the proof; the prepared plan is not passed in.
            settle(p, a, f.base, SLOT, &f.commit, &f.seal).map_err(ProgramError::from)?;
            for (actual, expected) in a.iter().zip(&expected.after) {
                assert_eq!(actual.try_lamports()?, expected.lamports);
                assert_eq!(actual.owner.to_bytes(), expected.owner);
                assert_eq!(&**actual.try_borrow_data()?, expected.data.as_slice());
            }
            expected_accounts = expected.after;
            Ok(())
        })
        .expect("actual helper, official writeback and balance check must all succeed");
    let logs = hook.take();
    assert_eq!(logs, expected_logs);
    for (role, expected) in expected_accounts.iter().enumerate() {
        let actual = &result[f.index(role)];
        assert_eq!(actual.lamports(), expected.lamports);
        assert_eq!(actual.owner().to_bytes(), expected.owner);
        assert_eq!(actual.data(), expected.data);
    }
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let original = receipt::Record::decode(&ctx, &logs[logs.len() - 2][1]).unwrap();
    let wide = receipt::Record::decode(&ctx, &logs[logs.len() - 1][1]).unwrap();
    original.pair(&wide).unwrap();
    assert_eq!(Ro(result[f.index(1)].data()).u64(H::ESCROW).unwrap(), 0);
    assert!(result[f.index(1)].data()
        [H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
        .iter()
        .all(|b| *b == 0));
    assert_eq!(result[f.index(2)].lamports(), 0);
    assert_eq!(result[f.index(2)].owner(), &init::SYSTEM);
    assert!(result[f.index(2)].data().is_empty());
    assert_ne!(
        WideClashInputsHdr::read(result[f.index(5)].data())
            .unwrap()
            .settled_mask
            & (1 << POSITION),
        0
    );
    let before: u128 = f.accounts.iter().map(|(_, a)| a.lamports() as u128).sum();
    assert_eq!(
        result.iter().map(|a| a.lamports() as u128).sum::<u128>(),
        before + 1
    );
    result
}

#[test]
fn runtime_contract_member_return_diversions_retained_close_and_refusals() {
    let hook = Hook::install();
    let f = Input::fixture();
    let before_home = f.accounts[f.index(3)].1.data().to_vec();
    let result = checked_settlement(&f, &hook);
    assert_ne!(result[f.index(3)].data(), before_home);
    assert!(result[f.index(6)].data().is_empty());
    assert_eq!(result[f.index(7)].lamports(), 3_000_000_020);

    let mut f = Input::fixture();
    let base = f.base;
    f.account_mut(base + 2).set_lamports(0);
    f.account_mut(base + 3)
        .set_owner(Pubkey::new_from_array(PROGRAM));
    let result = checked_settlement(&f, &hook);
    assert_eq!(Ro(result[f.index(1)].data()).u64(H::POOL_OWED).unwrap(), 17);
    assert_eq!(result[f.index(base + 2)].lamports(), 0);
    assert_eq!(result[f.index(base + 3)].lamports(), 1_000_000_000);

    // All three payments really alias one runtime account. The first small
    // payment diverts below rent; the second reaches rent and the third pays.
    let mut f = Input::fixture();
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let old = ArrivalSlot::read(&ctx, f.accounts[f.index(6)].1.data()).unwrap();
    let mut common = *old.common();
    common.beneficiary = [22; 32];
    let slot = frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot::new(
        &ctx,
        common,
        old.worn_bps(),
    )
    .unwrap();
    f.account_mut(6)
        .set_data_from_slice(&slot.to_bytes(&ctx).unwrap());
    let mut ih = WideClashInputsHdr::read(f.accounts[f.index(5)].1.data()).unwrap();
    ih.resolver = [22; 32];
    ih.write(f.account_mut(5).data_as_mut_slice()).unwrap();
    let floor = init::rent(0).unwrap();
    f.account_mut(7).set_lamports(floor - 10);
    f.roles[f.base + 2] = InstructionAccount::new(7, false, true);
    f.roles[f.base + 3] = InstructionAccount::new(7, false, true);
    let result = checked_settlement(&f, &hook);
    assert_eq!(Ro(result[f.index(1)].data()).u64(H::POOL_OWED).unwrap(), 7);
    assert_eq!(result[f.index(7)].lamports(), floor + 2_000_000_020);

    // Captured generation routes returned whole troops to authenticated
    // PREV_HOME and emits the additional original Holding chain link.
    let mut f = Input::fixture();
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let previous = addr::host_id(127, 0, 0, 3, 0).unwrap();
    {
        let hd = f.account_mut(1).data_as_mut_slice();
        let off = H::transit(SLOT as usize);
        let marker = BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).unwrap();
        let capture = marker.capture_bond_plan(37, 20).unwrap();
        hd[off..off + MARKER_LEN].copy_from_slice(&capture.marker_after.to_bytes());
        let mut w = Rw(hd);
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
    Rw(f.account_mut(3).data_as_mut_slice())
        .set_u8(PV::site(2) + SM::GEN, 2)
        .unwrap();
    let mut hd = vec![0; frontier_abi::v2::layout::AccountKind::Holding.size()];
    assert!(frontier_abi::v2::layout::write_header(
        &mut hd,
        frontier_abi::v2::layout::AccountKind::Holding,
        11
    ));
    Rw(&mut hd).set_i16(H::P, 127).unwrap();
    Rw(&mut hd).set_u8(H::GEN, 3).unwrap();
    Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    f.roles.insert(
        8,
        InstructionAccount::new(f.accounts.len() as u16, false, true),
    );
    f.accounts.push((
        Pubkey::new_from_array(ctx.holding(127, 0, 0)),
        literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &hd),
    ));
    f.base = 9;
    let home_before = f.accounts[f.index(3)].1.data().to_vec();
    let result = checked_settlement(&f, &hook);
    assert_eq!(
        Ro(result[f.index(8)].data()).u32(H::reserve(1)).unwrap(),
        12
    );
    assert_eq!(result[f.index(3)].data(), home_before);

    let mut f = Input::fixture();
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let old = ArrivalSlot::read(&ctx, f.accounts[f.index(6)].1.data()).unwrap();
    let mut common = *old.common();
    common.claimed = true;
    common.rent_to = [123; 32];
    let retained = frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot::new(
        &ctx,
        common,
        old.worn_bps(),
    )
    .unwrap();
    f.account_mut(6)
        .set_data_from_slice(&retained.to_bytes(&ctx).unwrap());
    let result = checked_settlement(&f, &hook);
    let slot = ArrivalSlot::read(&ctx, result[f.index(6)].data()).unwrap();
    assert!(slot.common().claimed);
    assert_eq!(slot.common().citizen, common.citizen);
    assert_eq!(slot.worn_bps(), retained.worn_bps());
    assert_ne!(slot.common().flags & wa::wide_arrival_slot::FLAG_SETTLED, 0);
    // A second disposable runtime invocation uses the successful output, not
    // a fabricated closed account or a writer-success stub.
    let close = Input {
        accounts: vec![
            f.accounts[f.index(f.base + 1)].clone(),
            (f.accounts[0].0, result[0].clone()),
            (f.accounts[f.index(6)].0, result[f.index(6)].clone()),
            (
                Pubkey::new_from_array([123; 32]),
                literal(init::SYSTEM, 1_000_000_000, &[]),
            ),
        ],
        roles: vec![
            InstructionAccount::new(0, true, false),
            InstructionAccount::new(1, false, false),
            InstructionAccount::new(2, false, true),
            InstructionAccount::new(3, false, true),
        ],
        base: 0,
        commit: [0; 32],
        seal: [0; wseal::WIDE_SEAL_LEN],
    };
    let output = close
        .run(|p, a, _| crate::proc::wide::expedition_close::close_slot(p, a).map_err(Into::into))
        .unwrap();
    assert!(output[2].data().is_empty());
    assert_eq!(output[2].lamports(), 0);
    assert_eq!(output[2].owner(), &init::SYSTEM);
    assert_eq!(output[3].lamports(), 2_000_000_000);
    let logs = hook.take();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0][0], wev::WIDE_LOG_PREFIX);

    let mut f = Input::fixture();
    f.roles[f.base + 1].set_is_signer(false);
    assert_eq!(
        f.settle().unwrap_err(),
        RunError::Helper(BAD_ACCOUNT.into())
    );
    assert!(hook.take().is_empty());
    let mut f = Input::fixture();
    f.roles[4].set_is_writable(false);
    assert_eq!(
        f.settle().unwrap_err(),
        RunError::Helper(BAD_ACCOUNT.into())
    );
    assert!(hook.take().is_empty());
    let mut f = Input::fixture();
    f.seal[0] ^= 1; // mismatched committed root, not invented forfeiture
    assert_eq!(
        f.settle().unwrap_err(),
        RunError::Helper(ProgramError::from(crate::Error::from(
            FrontierError::CommitMismatch
        )))
    );
    assert!(hook.take().is_empty());
    let mut f = Input::fixture();
    let data = f.account_mut(5).data_as_mut_slice();
    let mut member = WideArrival::read_at(data, POSITION).unwrap().unwrap();
    member.fate = wa::wide_arrival::FATE_STAYS;
    member.write_at(data, POSITION).unwrap();
    let mut ih = WideClashInputsHdr::read(data).unwrap();
    ih.camp_mask = 1 << POSITION;
    ih.write(data).unwrap();
    assert_eq!(
        f.settle().unwrap_err(),
        RunError::Helper(ProgramError::from(crate::Error::from(
            FrontierError::NotImplemented
        )))
    );
    assert!(hook.take().is_empty());
    // No failed account output is returned. This is discard, not rollback.
}

#[test]
fn runtime_contract_support_integrity_and_exact_failure_stages() {
    let _hook = Hook::install();
    let fixture = || Input {
        accounts: vec![(
            Pubkey::new_from_array([1; 32]),
            literal(Pubkey::new_from_array(PROGRAM), 10, &[0]),
        )],
        roles: vec![InstructionAccount::new(0, false, true)],
        base: 0,
        commit: [0; 32],
        seal: [0; wseal::WIDE_SEAL_LEN],
    };
    let f = fixture();
    let output = f.run(|_, _, _| Ok(())).unwrap();
    assert_eq!(output[0], f.accounts[0].1);
    let mut f = fixture();
    f.roles.push(f.roles[0]);
    let output = f
        .run(|_, a, _| {
            assert!(alloc::rc::Rc::ptr_eq(&a[0].data, &a[1].data));
            assert!(alloc::rc::Rc::ptr_eq(&a[0].lamports, &a[1].lamports));
            a[0].try_borrow_mut_data()?[0] = 9;
            assert_eq!(a[1].try_borrow_data()?[0], 9);
            Ok(())
        })
        .unwrap();
    assert_eq!(output[0].data(), &[9]);
    f.roles[1].set_is_writable(false);
    assert_eq!(
        f.run(|_, _, _| panic!("conflicting privilege must refuse before helper"))
            .unwrap_err(),
        RunError::Fixture(InstructionError::InvalidArgument)
    );
    let mut f = fixture();
    f.roles[0].set_is_writable(false);
    assert_eq!(
        f.run(|_, a, _| {
            a[0].try_borrow_mut_data()?[0] = 1;
            Ok(())
        })
        .unwrap_err(),
        RunError::Writeback(InstructionError::ReadonlyDataModified)
    );
    let mut f = fixture();
    f.accounts[0].1.set_owner(init::SYSTEM);
    assert_eq!(
        f.run(|_, a, _| {
            a[0].try_borrow_mut_data()?[0] = 1;
            Ok(())
        })
        .unwrap_err(),
        RunError::Writeback(InstructionError::ExternalAccountDataModified)
    );
    let f = fixture();
    assert_eq!(
        f.run(|_, a, _| {
            **a[0].try_borrow_mut_lamports()? += 1;
            Ok(())
        })
        .unwrap_err(),
        RunError::Balance(InstructionError::UnbalancedInstruction)
    );
    assert_eq!(
        f.run(|_, a, _| {
            a[0].try_borrow_mut_data()?[0] = 1;
            Err(ProgramError::InvalidArgument)
        })
        .unwrap_err(),
        RunError::Helper(ProgramError::InvalidArgument)
    );
    assert_eq!(
        f.run(
            |_, a, _| a[0].resize(1 + solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE + 1)
        )
        .unwrap_err(),
        RunError::Helper(ProgramError::InvalidRealloc)
    );
    assert_eq!(f.accounts[0].1.data(), &[0]); // retained input, not rollback
}
