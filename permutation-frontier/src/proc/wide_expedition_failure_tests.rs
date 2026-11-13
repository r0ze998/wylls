//! Exact unsigned native failure tests. The existing public Quicknet signature
//! is verified; the input seal is corrupted public ciphertext with a bad point.
//! No key recovery, valid body creation, signing, CPI or fixture export.
use super::*;
use alloc::boxed::Box;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ProgramError, ReadableAccount, RunError,
    WritableAccount,
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
        // Existing public signature verification and invalid public ciphertext only.
        // No recovery of opening keys, sealing, signing or randomness.
        let f = super::super::super::tests::bad_point_fixture();
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
        let mut rec = WideArrival::read_at(accounts[5].1.data(), POSITION)
            .unwrap()
            .unwrap();
        rec.fate = wa::wide_arrival::FATE_DESTROYED;
        rec.troops_after = 0;
        let mut cd = accounts[5].1.data().to_vec();
        rec.write_at(&mut cd, POSITION).unwrap();
        accounts[5].1.set_data_from_slice(&cd);
        accounts[6].1 = literal(init::SYSTEM, 0, &[]); // canonical absent arrival slot
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
    fn run_with_data<F>(&self, data: &[u8], helper: F) -> Result<Vec<AccountSharedData>, RunError>
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
        unsafe {
            rt::run(
                accounts,
                program_index,
                self.roles.clone(),
                data.to_vec(),
                helper,
            )
        }
    }
    fn wire(&self) -> [u8; ix::DRAFT_LEN] {
        ix::DraftCommand::new(SLOT, self.commit, self.seal)
            .unwrap()
            .to_bytes()
    }
    fn settle(&self) -> Result<Vec<AccountSharedData>, RunError> {
        self.run_with_data(&self.wire(), |p, a, wire| {
            crate::proc::wide::expedition_return::settle_failure_draft(p, a, wire)
                .map_err(Into::into)
        })
    }
}

fn assert_unchanged(f: &Input, result: &[AccountSharedData]) {
    for ((_, before), after) in f.accounts.iter().zip(result) {
        assert_eq!(before, after);
    }
}
fn refused(f: &Input, hook: &Hook) {
    assert!(hook.take().is_empty());
    let out = f
        .run_with_data(&f.wire(), |p, a, d| {
            assert!(crate::proc::wide::expedition_return::settle_failure_draft(p, a, d).is_err());
            Ok(()) // successful official writeback, not a discarded failed context
        })
        .unwrap();
    assert_unchanged(f, &out);
    assert!(hook.take().is_empty());
}
fn observed(f: &Input, out: &[AccountSharedData], hook: &Hook) -> event::Receipt {
    let logs = hook.take();
    let log = logs.last().unwrap();
    assert_eq!(log[0], event::PREFIX);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let r = event::Receipt::decode(&ctx, &log[1]).unwrap();
    assert_eq!(log[1].len(), event::LEN);
    r.verify_previous(
        &ctx,
        event::Chain::from_account(f.accounts[1].1.data()).unwrap(),
        event::Chain::from_account(f.accounts[4].1.data()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        event::Chain::from_account(out[1].data()).unwrap(),
        r.holding_chain
    );
    assert_eq!(
        event::Chain::from_account(out[4].data()).unwrap(),
        r.destination_chain
    );
    let snapshots = |accounts: &[AccountSharedData]| -> Vec<Snapshot> {
        f.roles
            .iter()
            .map(|role| {
                let index = role.index_in_transaction as usize;
                let a = &accounts[index];
                Snapshot {
                    address: f.accounts[index].0.to_bytes(),
                    owner: a.owner().to_bytes(),
                    present: !(a.owner() == &init::SYSTEM && a.data().is_empty()),
                    signer: role.is_signer(),
                    writable: role.is_writable(),
                    lamports: a.lamports(),
                    data: a.data().to_vec(),
                }
            })
            .collect()
    };
    let before = snapshots(
        &f.accounts
            .iter()
            .map(|(_, a)| a.clone())
            .collect::<Vec<_>>(),
    );
    let after = snapshots(out);
    assert_eq!(
        r.input,
        event::manifest(
            &ctx,
            &f.wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&before),
            &[]
        )
        .unwrap()
    );
    assert_eq!(
        r.output,
        event::manifest(
            &ctx,
            &f.wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&after),
            &[before[1].address, before[4].address]
        )
        .unwrap()
    );
    let mut corrupt = log[1].clone();
    corrupt[242] ^= 1;
    assert!(event::Receipt::decode(&ctx, &corrupt).is_err());
    let mut corrupt = r;
    corrupt.holding_chain.head[0] ^= 1;
    assert!(corrupt
        .verify_previous(
            &ctx,
            event::Chain::from_account(f.accounts[1].1.data()).unwrap(),
            event::Chain::from_account(f.accounts[4].1.data()).unwrap()
        )
        .is_err());
    let total: u128 = f.accounts.iter().map(|(_, a)| a.lamports() as u128).sum();
    assert_eq!(
        out.iter().map(|a| a.lamports() as u128).sum::<u128>(),
        total + 1
    );
    assert_eq!(r.seal_code, seal_code::BAD_POINT);
    assert_eq!(r.reward, 37);
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 0);
    assert!(
        out[1].data()[H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
            .iter()
            .all(|b| *b == 0)
    );
    assert_eq!(out[2].owner(), &init::SYSTEM);
    assert_eq!(out[2].lamports(), 0);
    assert!(out[2].data().is_empty());
    assert_eq!(out[3], f.accounts[3].1); // no troop return or home mutation
    assert_eq!(out[6], f.accounts[6].1); // no retained claim or slot closure invented
    assert_ne!(
        WideClashInputsHdr::read(out[5].data())
            .unwrap()
            .settled_mask
            & (1 << POSITION),
        0
    );
    r
}
#[test]
fn bad_destroyed_wire_pays_existing_reward_and_closes_during_running() {
    let hook = Hook::install();
    let mut f = Input::fixture();
    assert_eq!(
        Ro(f.accounts[0].1.data()).u8(S::STATUS).unwrap(),
        S::STATUS_RUNNING
    );
    let out = f.settle().unwrap();
    let r = observed(&f, &out, &hook);
    assert!(!r.diverted);
    assert_eq!(
        out[f.index(f.base + 5)].lamports(),
        f.accounts[f.index(f.base + 5)].1.lamports() + 37
    );
    assert_eq!(out[1].lamports(), f.accounts[1].1.lamports() - 37);
    assert_eq!(
        out[7].lamports(),
        f.accounts[7].1.lamports() + f.accounts[2].1.lamports()
    );
    for ((_, a), after) in f.accounts.iter_mut().zip(out) {
        *a = after;
    }
    refused(&f, &hook);
}
#[test]
fn bad_destroyed_reward_diversion_and_recipient_alias_are_exact() {
    let hook = Hook::install();
    let mut f = Input::fixture();
    f.account_mut(f.base + 5).set_lamports(0);
    let out = f.settle().unwrap();
    let r = observed(&f, &out, &hook);
    assert!(r.diverted);
    assert_eq!(Ro(out[1].data()).u64(H::POOL_OWED).unwrap(), 37);
    assert_eq!(out[1].lamports(), f.accounts[1].1.lamports());
    // Program-owned input can be a payee: reward diverts to Holding, and all
    // duplicate views must contain the same updated settled bit in manifests.
    let mut f = Input::fixture();
    f.roles[f.base + 5] = InstructionAccount::new(5, false, true);
    let out = f.settle().unwrap();
    let r = observed(&f, &out, &hook);
    assert!(r.diverted);
    assert_eq!(Ro(out[1].data()).u64(H::POOL_OWED).unwrap(), 37);
    let mut f = Input::fixture();
    f.roles[f.base + 5] = InstructionAccount::new(7, false, true);
    let out = f.settle().unwrap();
    let r = observed(&f, &out, &hook);
    assert!(!r.diverted);
    assert_eq!(
        out[7].lamports(),
        f.accounts[7].1.lamports() + f.accounts[2].1.lamports() + 37
    );
}
#[test]
fn bad_destroyed_unsupported_proofs_roles_and_late_failures_are_inert() {
    let hook = Hook::install();
    for fate in [
        wa::wide_arrival::FATE_STAYS,
        wa::wide_arrival::FATE_WITHDREW,
        wa::wide_arrival::FATE_BOUNCED,
        wa::wide_arrival::FATE_RETREATED,
    ] {
        let mut f = Input::fixture();
        let mut data = f.account_mut(5).data().to_vec();
        let mut rec = WideArrival::read_at(&data, POSITION).unwrap().unwrap();
        rec.fate = fate;
        rec.write_at(&mut data, POSITION).unwrap();
        f.account_mut(5).set_data_from_slice(&data);
        refused(&f, &hook);
    }
    let mut f = Input::fixture();
    let mut data = f.account_mut(5).data().to_vec();
    let mut rec = WideArrival::read_at(&data, POSITION).unwrap().unwrap();
    rec.present = false;
    rec.write_at(&mut data, POSITION).unwrap();
    f.account_mut(5).set_data_from_slice(&data);
    refused(&f, &hook);
    let mut f = Input::fixture();
    let existing = super::super::super::tests::bad_point_fixture();
    f.accounts[6].1 = literal(
        *existing.a[6].owner,
        existing.a[6].lamports(),
        &existing.a[6].try_borrow_data().unwrap(),
    );
    refused(&f, &hook); // retained claims need their own supported contract
    let f = Input::fixture();
    let now = prologue::now().unwrap();
    prologue::set_test_clock(now.ts - 1, now.slot);
    refused(&f, &hook);
    let mut f = Input::fixture();
    f.roles[13] = InstructionAccount::new(2, false, true);
    refused(&f, &hook); // reward cannot alias the closing bridge
    let mut f = Input::fixture();
    f.roles.pop();
    refused(&f, &hook);
    let mut f = Input::fixture();
    f.commit[0] ^= 1;
    refused(&f, &hook);
    let mut f = Input::fixture();
    f.account_mut(f.base + 5).set_lamports(u64::MAX);
    refused(&f, &hook);
    let mut f = Input::fixture();
    let mut data = f.account_mut(4).data().to_vec();
    crate::layout::set_chain(&mut data, u64::MAX, &[0; 32]).unwrap();
    f.account_mut(4).set_data_from_slice(&data);
    refused(&f, &hook);
    for role in [1, 2, 4, 5, 7, 13] {
        let f = Input::fixture();
        let out = f
            .run_with_data(&f.wire(), |p, a, d| {
                let _guard = a[role].try_borrow_data()?;
                // Balance-only recipient roles require balance conflicts instead.
                if role == 7 || role == 13 {
                    let _guard = a[role].try_borrow_lamports()?;
                    assert!(
                        crate::proc::wide::expedition_return::settle_failure_draft(p, a, d)
                            .is_err()
                    );
                } else {
                    assert!(
                        crate::proc::wide::expedition_return::settle_failure_draft(p, a, d)
                            .is_err()
                    );
                }
                Ok(())
            })
            .unwrap();
        assert_unchanged(&f, &out);
        assert!(hook.take().is_empty());
    }
    let f = Input::fixture();
    for i in 0..f.roles.len() {
        let mut altered = Input::fixture();
        if i == 0 || i == altered.base {
            continue;
        }
        let index = altered.roles[i].index_in_transaction;
        for role in &mut altered.roles {
            if role.index_in_transaction == index {
                *role = InstructionAccount::new(index, role.is_signer(), false);
            }
        }
        refused(&altered, &hook);
    }
    let mut f = Input::fixture();
    f.roles[f.base + 1] =
        InstructionAccount::new(f.roles[f.base + 1].index_in_transaction, false, true);
    refused(&f, &hook);
    let f = Input::fixture();
    let member = frontier_abi::world_index::expedition_settlement_ix::DraftCommand::new(
        SLOT, f.commit, f.seal,
    )
    .unwrap()
    .to_bytes();
    let out = f
        .run_with_data(&member, |p, a, d| {
            assert!(crate::proc::wide::expedition_return::settle_draft(p, a, d).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
    // Generic public admission still does not recognize the private bytes.
    let out = f
        .run_with_data(&f.wire(), |p, a, d| {
            assert!(crate::dispatch(p, a, d).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
    let f = Input::fixture();
    for wire in [
        f.wire()[..300].to_vec(),
        frontier_abi::world_index::expedition_settlement_ix::DraftCommand::new(
            SLOT, f.commit, f.seal,
        )
        .unwrap()
        .to_bytes()
        .to_vec(),
    ] {
        let out = f
            .run_with_data(&wire, |p, a, d| {
                assert!(
                    crate::proc::wide::expedition_return::settle_failure_draft(p, a, d).is_err()
                );
                Ok(())
            })
            .unwrap();
        assert_unchanged(&f, &out);
        assert!(hook.take().is_empty());
    }
}

#[path = "wide_expedition_forfeit_tests.rs"]
mod forfeiture;

#[path = "wide_expedition_reverse_settlement_tests.rs"]
mod reverse_final;
