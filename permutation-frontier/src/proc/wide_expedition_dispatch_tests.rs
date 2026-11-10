//! Fixed public accounts through the actual dispatcher and official native
//! serializer. No key, transaction, signature, seal creation/opening or CPI.
use super::*;
use alloc::boxed::Box;
use frontier_abi::world_index::{expedition_dispatch_ix as ix, expedition_terminal_ix as terminal};
#[cfg(feature = "expedition-dispatch-experimental")]
use runtime_contract_support::ReadableAccount;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, WritableAccount,
};
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::{Arc, Mutex};

type Accounts = Vec<(Pubkey, AccountSharedData)>;
struct Capture(Arc<Mutex<usize>>);
impl SyscallStubs for Capture {
    fn sol_invoke_signed(
        &self,
        _: &solana_program::instruction::Instruction,
        _: &[AccountInfo],
        _: &[&[&[u8]]],
    ) -> Result<(), solana_program::program_error::ProgramError> {
        panic!("CPI forbidden in dispatch fixture")
    }
    fn sol_log_data(&self, _: &[&[u8]]) {
        *self.0.lock().unwrap() += 1;
    }
}
struct Hook(Option<Box<dyn SyscallStubs>>);
impl Drop for Hook {
    fn drop(&mut self) {
        set_syscall_stubs(self.0.take().unwrap());
    }
}
fn hook() -> (Hook, Arc<Mutex<usize>>) {
    let logs = Arc::new(Mutex::new(0));
    (
        Hook(Some(set_syscall_stubs(Box::new(Capture(logs.clone()))))),
        logs,
    )
}
fn fixture() -> Accounts {
    let mut accounts: Accounts = expedition_return::tests::terminal_fixture()
        .into_iter()
        .map(|a| {
            let mut out = AccountSharedData::new(a.lamports(), a.data_len(), a.owner);
            out.set_data_from_slice(&a.try_borrow_data().unwrap());
            (*a.key, out)
        })
        .collect();
    let mut program = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    program.set_executable(true);
    accounts.push((Pubkey::new_from_array([12; 32]), program));
    accounts
}
fn roles() -> Vec<InstructionAccount> {
    (0..4)
        .map(|i| InstructionAccount::new(i, false, i != 0))
        .collect()
}
fn wire() -> Vec<u8> {
    ix::encode(
        ix::Kind::CloseTerminal,
        &terminal::DraftCommand::new(2).unwrap().to_bytes(),
    )
    .unwrap()
}
fn run(
    a: &Accounts,
    roles: Vec<InstructionAccount>,
    wire: Vec<u8>,
    refusal: bool,
) -> Vec<AccountSharedData> {
    // SAFETY: official aligned runtime serializer owns all AccountInfo backing;
    // no references escape and the caller keeps immutable original snapshots.
    unsafe {
        rt::run(a.clone(), 4, roles, wire, |p, a, d| {
            let result = crate::dispatch(p, a, d);
            if refusal {
                assert!(result.is_err());
                Ok(())
            } else {
                result.map_err(Into::into)
            }
        })
    }
    .unwrap()
}
fn unchanged(a: &Accounts, roles: Vec<InstructionAccount>, wire: Vec<u8>) {
    assert_eq!(
        run(a, roles, wire, true),
        a.iter().map(|(_, a)| a.clone()).collect::<Vec<_>>()
    );
}

#[test]
fn expedition_wire_is_exact_and_keeps_legacy_parsers_closed() {
    let d = wire();
    let decoded = ix::Command::decode(&d).unwrap();
    assert_eq!(decoded.kind(), ix::Kind::CloseTerminal);
    assert_eq!(
        decoded.inner(),
        terminal::DraftCommand::new(2).unwrap().to_bytes()
    );
    assert_eq!(ix::PROGRAM_VERSION, 0x4804);
    assert_eq!(ix::VERSION_BIT & (0x1000 | 0x2000 | 0x4000 | 0x8000), 0);
    assert!(wix::WideCommand::decode(&d).is_err());
    assert!(frontier_abi::v2::ix::tag_of(&d).is_err());
    for n in 0..d.len() {
        assert!(ix::Command::decode(&d[..n]).is_err());
    }
    let mut extra = d.clone();
    extra.push(0);
    assert!(ix::Command::decode(&extra).is_err());
    for i in 0..d.len() {
        let mut bad = d.clone();
        bad[i] ^= 0x80;
        assert!(ix::Command::decode(&bad).is_err());
    }
    assert!(ix::encode(ix::Kind::SettleMember, decoded.inner()).is_err());
    assert!(!expedition_exec::EXPEDITION_ENABLED);
}

#[test]
fn expedition_wrapper_does_not_steal_legacy_ff02_payloads() {
    let p = Pubkey::new_from_array([12; 32]);
    let mut open = vec![wix::TAG_OPEN_PROVINCE];
    open.extend_from_slice(&767i64.to_le_bytes());
    open.extend_from_slice(&0i64.to_le_bytes());
    let mut seed = vec![wix::TAG_REQUEST_RING_SEED];
    seed.extend_from_slice(&767u64.to_le_bytes());
    assert!(matches!(
        wix::WideCommand::decode(&open),
        Ok(wix::WideCommand::OpenProvince(_))
    ));
    assert!(matches!(
        wix::WideCommand::decode(&seed),
        Ok(wix::WideCommand::RequestRingSeed(_))
    ));
    let expected_open = open_province(&p, &[], &open);
    let expected_seed = request_ring_seed(&p, &[], &seed);
    assert_ne!(expected_open, Err(FrontierError::BadData.into()));
    assert_ne!(expected_seed, Err(FrontierError::BadData.into()));
    assert_eq!(crate::dispatch(&p, &[], &open), expected_open);
    assert_eq!(crate::dispatch(&p, &[], &seed), expected_seed);
}

#[test]
fn retained_failure_kind11_is_exact_disjoint_and_rejects_without_runtime_accounts() {
    use frontier_abi::world_index::{
        expedition_failure_ix as v1, expedition_forfeit_ix as v2,
        expedition_retained_failure_ix as v3,
    };
    let inner = v3::DraftCommand::new(2, [1; 32], [0; 264])
        .unwrap()
        .to_bytes();
    let d = ix::encode(ix::Kind::SettleRetainedFailure, &inner).unwrap();
    assert_eq!(&d[..4], &[wix::TAG_SETTLE_TICKET, 0xff, 2, 11]);
    assert_eq!(ix::Kind::SettleRetainedFailure.season_index(), 0);
    assert_eq!(
        wix::WideIx::from_tag(d[0]).unwrap().class(),
        frontier_abi::tags::Class::D
    );
    assert_eq!(ix::Command::decode(&d).unwrap().inner(), inner);
    assert!(wix::WideCommand::decode(&d).is_err());
    assert!(frontier_abi::v2::ix::tag_of(&d).is_err());
    for older in [
        v1::DraftCommand::new(2, [1; 32], [0; 264])
            .unwrap()
            .to_bytes(),
        v2::DraftCommand::new(2, [1; 32], [0; 264])
            .unwrap()
            .to_bytes(),
    ] {
        assert!(ix::encode(ix::Kind::SettleRetainedFailure, &older).is_err());
    }
    assert!(ix::encode(ix::Kind::SettleForfeit, &inner).is_err());
    assert!(ix::encode(ix::Kind::SettleFailure, &inner).is_err());
    for n in 0..d.len() {
        assert!(ix::Command::decode(&d[..n]).is_err());
    }
    let mut long = d.clone();
    long.push(0);
    assert!(ix::Command::decode(&long).is_err());
    for i in 0..9 {
        let mut bad = d.clone();
        bad[i] ^= 0x80;
        assert!(ix::Command::decode(&bad).is_err());
    }
    let p = Pubkey::new_from_array([12; 32]);
    #[cfg(feature = "expedition-dispatch-experimental")]
    assert_eq!(
        crate::dispatch(&p, &[], &d),
        Err(FrontierError::TooManyAccounts.into())
    );
    #[cfg(not(feature = "expedition-dispatch-experimental"))]
    assert_eq!(
        crate::dispatch(&p, &[], &d),
        Err(FrontierError::BadData.into())
    );
    assert_eq!(
        crate::dispatch(&p, &[], &inner),
        Err(FrontierError::BadData.into())
    );
}

#[cfg(not(feature = "expedition-dispatch-experimental"))]
#[test]
fn expedition_version2_is_refused_by_the_existing_wide_dispatcher() {
    let (_hook, logs) = hook();
    unchanged(&fixture(), roles(), wire());
    assert_eq!(*logs.lock().unwrap(), 0);
}

#[cfg(feature = "expedition-dispatch-experimental")]
#[test]
fn expedition_version2_actual_dispatch_closes_only_the_exact_terminal_bridge() {
    let (_hook, logs) = hook();
    let a = fixture();
    let out = run(&a, roles(), wire(), false);
    assert_eq!(
        out.iter().map(|a| a.lamports()).sum::<u64>(),
        a.iter().map(|(_, a)| a.lamports()).sum::<u64>()
    );
    assert_eq!(out[0], a[0].1);
    assert_eq!(out[1].lamports(), a[1].1.lamports());
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 37);
    assert_eq!(out[2].lamports(), 0);
    assert!(out[2].data().is_empty());
    assert_eq!(out[2].owner(), &init::SYSTEM);
    assert_eq!(out[3].lamports(), a[3].1.lamports() + a[2].1.lamports());
    assert_eq!(*logs.lock().unwrap(), 1);
    let after: Accounts = a.iter().map(|(key, _)| *key).zip(out).collect();
    unchanged(&after, roles(), wire());
    assert_eq!(*logs.lock().unwrap(), 1);
}

#[cfg(feature = "expedition-dispatch-experimental")]
#[test]
fn expedition_version2_rejects_wrong_revision_scope_flags_and_raw_inner_without_effects() {
    let (_hook, logs) = hook();
    let a = fixture();
    for version in [4, 0x4004, 0x4805, 0xc804] {
        let mut bad = a.clone();
        let mut d = bad[0].1.data().to_vec();
        Rw(&mut d).set_u16(S::PROGRAM_VERSION, version).unwrap();
        bad[0].1.set_data_from_slice(&d);
        unchanged(&bad, roles(), wire());
    }
    for offset in [0, 16, S::BUMP, S::RULESET_HASH] {
        let mut bad = a.clone();
        let mut d = bad[0].1.data().to_vec();
        d[offset] ^= 0x80;
        bad[0].1.set_data_from_slice(&d);
        unchanged(&bad, roles(), wire());
    }
    let mut bad = a.clone();
    bad[0].1.set_owner(Pubkey::new_from_array([77; 32]));
    unchanged(&bad, roles(), wire());
    let mut bad = a.clone();
    bad[0].0 = Pubkey::new_from_array([78; 32]);
    unchanged(&bad, roles(), wire());
    for index in 1..4 {
        let mut flags = roles();
        flags[index] = InstructionAccount::new(index as u16, false, false);
        unchanged(&a, flags, wire());
    }
    unchanged(
        &a,
        roles(),
        terminal::DraftCommand::new(2).unwrap().to_bytes().to_vec(),
    );
    assert_eq!(*logs.lock().unwrap(), 0);
}

#[cfg(feature = "expedition-dispatch-experimental")]
fn resident_fixture(bytes: &[u8]) -> (Accounts, Vec<InstructionAccount>, Vec<u8>, Accounts) {
    use frontier_abi::{bytes::Cursor, world_index::expedition_resident_ix as resident};
    let mut r = Cursor::new(bytes);
    assert_eq!(r.take(8).unwrap(), b"BRESv001");
    let kind = match r.u8().unwrap() {
        1 => ix::Kind::Dissolve,
        2 => ix::Kind::Return,
        _ => panic!("fixture action"),
    };
    let program = r.arr::<32>().unwrap();
    let season = r.arr::<32>().unwrap();
    let host = WideHostRef::from_bytes(r.take(56).unwrap()).unwrap();
    let (now, slot) = (r.i64().unwrap(), r.u64().unwrap());
    prologue::set_test_clock(now, slot);
    let count = r.u8().unwrap() as usize;
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut roles = Vec::new();
    for is_after in [false, true] {
        for i in 0..count {
            let key = Pubkey::new_from_array(r.arr().unwrap());
            let owner = Pubkey::new_from_array(r.arr().unwrap());
            let _present = r.u8().unwrap();
            let signer = r.u8().unwrap() != 0;
            let writable = r.u8().unwrap() != 0;
            let executable = r.u8().unwrap() != 0;
            let balance = r.u64().unwrap();
            let len = r.u32().unwrap() as usize;
            let data = r.take(len).unwrap();
            let mut account = AccountSharedData::new(balance, len, &owner);
            account.set_data_from_slice(data);
            account.set_executable(executable);
            if is_after {
                after.push((key, account));
            } else {
                roles.push(InstructionAccount::new(i as u16, signer, writable));
                before.push((key, account));
            }
        }
    }
    assert_eq!(r.u8().unwrap(), 2);
    for _ in 0..2 {
        let n = r.u32().unwrap() as usize;
        r.take(n).unwrap();
    }
    assert!(r.done());
    // Explicit new-version initial state, not a claim that the old fixture's
    // receipts prove this Season. No signature, seal or outcome is generated.
    let s = kind.season_index();
    let mut data = before[s].1.data().to_vec();
    Rw(&mut data)
        .set_u16(S::PROGRAM_VERSION, ix::PROGRAM_VERSION)
        .unwrap();
    before[s].1.set_data_from_slice(&data);
    assert_eq!(before[s].0.to_bytes(), season);
    let mut executable = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    executable.set_executable(true);
    before.push((Pubkey::new_from_array(program), executable));
    let ctx = AddrCtx { program, season };
    let action = if kind == ix::Kind::Dissolve {
        resident::Action::Dissolve
    } else {
        resident::Action::Return
    };
    let inner = resident::DraftCommand::new(&ctx, action, host)
        .unwrap()
        .to_bytes();
    (before, roles, ix::encode(kind, &inner).unwrap(), after)
}

#[cfg(feature = "expedition-dispatch-experimental")]
#[test]
fn expedition_version2_resident_dissolve_and_return_reach_real_consumers() {
    let (_hook, logs) = hook();
    for bytes in [
        include_bytes!("../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin").as_slice(),
        include_bytes!("../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/return_v1.bin").as_slice(),
    ] {
        let (a, roles, wire, expected) = resident_fixture(bytes);
        let program_index = (a.len() - 1) as u16;
        let kind = ix::Command::decode(&wire).unwrap().kind();
        // SAFETY: fixed public fixture through the official owned serializer.
        let out = unsafe { rt::run(a.clone(), program_index, roles.clone(), wire.clone(), |p,a,d| crate::dispatch(p,a,d).map_err(Into::into)) }.unwrap();
        assert_eq!(out.iter().map(|a| a.lamports()).sum::<u64>(), a.iter().map(|(_,a)| a.lamports()).sum::<u64>());
        let holding = 4; let province = if kind == ix::Kind::Dissolve { 5 } else { 2 };
        // Program version enters the receipt digests, so chain heads change.
        // Check the economic/body bytes against the immutable old fixture.
        assert_eq!(&out[holding].data()[64..], &expected[holding].1.data()[64..]);
        assert_eq!(&out[province].data()[64..], &expected[province].1.data()[64..]);
        for i in 0..roles.len() {
            if !roles[i].is_writable() { assert_eq!(out[i], a[i].1); }
        }
        let before_logs = *logs.lock().unwrap();
        assert_eq!(before_logs, if kind == ix::Kind::Dissolve { 2 } else { 4 });
        // Both source authority and readonly-role downgrade remain enforced.
        for index in if kind == ix::Kind::Dissolve { vec![0, 1, 4, 5] } else { vec![0, 2, 3, 4] } {
            let mut bad_roles = roles.clone();
            bad_roles[index] = InstructionAccount::new(index as u16, false, false);
            let rejected = unsafe { rt::run(a.clone(), program_index, bad_roles, wire.clone(), |p,a,d| {
                assert!(crate::dispatch(p,a,d).is_err()); Ok(())
            }) }.unwrap();
            assert_eq!(rejected, a.iter().map(|(_,a)| a.clone()).collect::<Vec<_>>());
        }
        assert_eq!(*logs.lock().unwrap(), before_logs);
    }
}

#[cfg(all(
    feature = "expedition-dispatch-experimental",
    feature = "system-cpi-tests"
))]
#[test]
fn expedition_version2_actual_departure_passes_prologue_and_native_system_writeback() {
    let (fixture, command) = expedition_exec::tests::fixture();
    let mut accounts: Accounts = Vec::new();
    let mut roles = Vec::new();
    for ai in &fixture {
        let index = accounts
            .iter()
            .position(|(k, _)| k == ai.key)
            .unwrap_or_else(|| {
                let mut value = AccountSharedData::new(ai.lamports(), ai.data_len(), ai.owner);
                value.set_data_from_slice(&ai.try_borrow_data().unwrap());
                accounts.push((*ai.key, value));
                accounts.len() - 1
            });
        roles.push(InstructionAccount::new(
            index as u16,
            ai.is_signer,
            ai.is_writable,
        ));
    }
    let at = |role: usize| roles[role].index_in_transaction as usize;
    let system = &mut accounts[at(6)].1;
    system.set_owner(Pubkey::from_str_const(
        "NativeLoader1111111111111111111111111111111",
    ));
    system.set_executable(true);
    let program_index = accounts.len() as u16;
    let mut program = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    program.set_executable(true);
    accounts.push((Pubkey::new_from_array([0x12; 32]), program));
    let wire = ix::encode(ix::Kind::Depart, &command.to_bytes()).unwrap();
    // SAFETY: literal public accounts, official serializer and existing native
    // System processor. Signer flags are fixtures, not wallet signatures.
    let out = unsafe {
        rt::system_cpi::run(
            accounts.clone(),
            program_index,
            roles.clone(),
            wire.clone(),
            |p, a, d| crate::dispatch(p, a, d).map_err(Into::into),
        )
    }
    .unwrap();
    assert_eq!(out.logs.len(), 1);
    assert!(!out.cpis.is_empty());
    assert_eq!(out.accounts[at(8)].owner().to_bytes(), [0x12; 32]);
    assert_eq!(
        out.accounts[at(8)].data().len(),
        frontier_abi::world_index::expedition_transport::OWNED_BRIDGE_LEN
    );
    assert_eq!(
        out.accounts[at(1)].lamports(),
        accounts[at(1)].1.lamports() - command.tip
    );
    assert_eq!(
        out.accounts[at(4)].lamports(),
        accounts[at(4)].1.lamports() + command.tip
    );
    assert_eq!(
        Ro(out.accounts[at(4)].data()).u64(H::ESCROW).unwrap(),
        command.tip
    );
    assert_eq!(
        out.accounts.iter().map(|a| a.lamports()).sum::<u64>(),
        accounts.iter().map(|(_, a)| a.lamports()).sum::<u64>()
    );
    // Old raw command stays closed, and insufficient actor privileges still
    // fail before any CPI or live-account change in the new wrapper.
    for raw in [true, false] {
        let mut supplied = roles.clone();
        if !raw {
            supplied[0] = InstructionAccount::new(at(0) as u16, false, false);
        }
        let data = if raw {
            command.to_bytes().to_vec()
        } else {
            wire.clone()
        };
        let rejected = unsafe {
            rt::system_cpi::run(
                accounts.clone(),
                program_index,
                supplied,
                data,
                |p, a, d| {
                    assert!(crate::dispatch(p, a, d).is_err());
                    Ok(())
                },
            )
        }
        .unwrap();
        assert!(rejected.cpis.is_empty());
        assert!(rejected.logs.is_empty());
        assert_eq!(
            rejected.accounts,
            accounts.iter().map(|(_, a)| a.clone()).collect::<Vec<_>>()
        );
    }
}
