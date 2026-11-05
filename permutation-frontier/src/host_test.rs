//! **Test-only host seam (workstream 02-rights, `cfg(test)` only).** On a
//! host target `solana_program`'s CPI is a no-op returning `Ok` and the
//! Clock and Rent sysvars are unsupported, so the real [`crate::dispatch`]
//! cannot create an account or read the time natively. Under `cfg(test)`
//! [`crate::init`] calls [`invoke`]/[`invoke_signed`] here and
//! [`crate::prologue::now`] / [`crate::init::rent`] read [`clock`] and
//! [`rent`]: a minimal System program (Transfer, Allocate, Assign,
//! AllocateWithSeed) that checks signers and PDA seeds as the runtime
//! would, and a per-thread clock. Nothing here exists in an SBF build.
//!
//! What it does **not** model: compute units, loaded-data limits, account
//! locks, rent-exemption checks at the end of a transaction, transaction
//! atomicity (a failed instruction's writes are not rolled back here; the
//! harness snapshots accounts itself), and the SBF memory model.

extern crate std;

use core::cell::Cell;
use std::boxed::Box;
use std::vec;

use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, instruction::Instruction,
    program_error::ProgramError, pubkey::Pubkey,
};

std::thread_local! {
    static NOW: Cell<i64> = const { Cell::new(0) };
}

/// Sets this thread's clock.
pub fn set_now(ts: i64) {
    NOW.with(|c| c.set(ts));
}

/// This thread's clock (`unix_timestamp`; slot = ts).
pub fn clock() -> (i64, u64) {
    let ts = NOW.with(|c| c.get());
    (ts, ts.max(0) as u64)
}

/// The default Rent's exempt minimum (the sysvar formula of
/// `frontier_abi::layout::rent`).
pub fn rent(space: usize) -> u64 {
    frontier_abi::layout::rent(space)
}

/// A leaked, zeroed data buffer of `len` bytes with the 8-byte length
/// prefix `AccountInfo::resize` writes before the data on chain.
pub fn leak_data(len: usize) -> &'static mut [u8] {
    let v: &'static mut [u8] = Box::leak(vec![0u8; 8 + len].into_boxed_slice());
    v[..8].copy_from_slice(&(len as u64).to_le_bytes());
    &mut v[8..]
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> [u8; 32] {
    let mut parts: std::vec::Vec<&[u8]> = seeds.to_vec();
    parts.push(program.as_ref());
    parts.push(b"ProgramDerivedAddress");
    permutation_rules::hash::sha256(&parts)
}

fn find<'x, 'a>(
    infos: &'x [AccountInfo<'a>],
    k: &Pubkey,
) -> Result<&'x AccountInfo<'a>, ProgramError> {
    infos
        .iter()
        .find(|i| i.key == k)
        .ok_or(ProgramError::NotEnoughAccountKeys)
}

/// Signed: a transaction signer, or a PDA of `program` under one of the
/// seed sets.
fn signed(ai: &AccountInfo, seeds: &[&[&[u8]]], program: &Pubkey) -> bool {
    ai.is_signer || seeds.iter().any(|s| pda(s, program) == ai.key.to_bytes())
}

fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?))
}
fn u64_at(d: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(d.get(o..o + 8)?.try_into().ok()?))
}
fn key_at(d: &[u8], o: usize) -> Option<Pubkey> {
    Some(Pubkey::new_from_array(d.get(o..o + 32)?.try_into().ok()?))
}

fn allocate(ai: &AccountInfo, space: usize) -> ProgramResult {
    if ai.owner != &crate::init::SYSTEM || ai.data_len() != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    *ai.data.borrow_mut() = leak_data(space);
    Ok(())
}

/// The System program, the only program the Frontier program calls.
pub fn invoke_signed(ix: &Instruction, infos: &[AccountInfo], seeds: &[&[&[u8]]]) -> ProgramResult {
    if ix.program_id != crate::init::SYSTEM {
        return Err(ProgramError::IncorrectProgramId);
    }
    // The caller is the Frontier program: the seeds are its PDAs. The test
    // program id is fixed by the harness (`PROGRAM`).
    let program = PROGRAM.with(|p| p.get());
    let d = &ix.data;
    let bad = ProgramError::InvalidInstructionData;
    match u32_at(d, 0).ok_or(bad.clone())? {
        2 => {
            let from = find(infos, &ix.accounts[0].pubkey)?;
            let to = find(infos, &ix.accounts[1].pubkey)?;
            if !signed(from, seeds, &program) {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let n = u64_at(d, 4).ok_or(bad)?;
            let f = from
                .lamports()
                .checked_sub(n)
                .ok_or(ProgramError::InsufficientFunds)?;
            **from.try_borrow_mut_lamports()? = f;
            let t = to
                .lamports()
                .checked_add(n)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            **to.try_borrow_mut_lamports()? = t;
            Ok(())
        }
        8 => {
            let t = find(infos, &ix.accounts[0].pubkey)?;
            if !signed(t, seeds, &program) {
                return Err(ProgramError::MissingRequiredSignature);
            }
            allocate(t, u64_at(d, 4).ok_or(bad)? as usize)
        }
        1 => {
            let t = find(infos, &ix.accounts[0].pubkey)?;
            if !signed(t, seeds, &program) {
                return Err(ProgramError::MissingRequiredSignature);
            }
            t.assign(&key_at(d, 4).ok_or(bad)?);
            Ok(())
        }
        9 => {
            // AllocateWithSeed: target = with_seed(base, seed, owner), base
            // signs.
            let t = find(infos, &ix.accounts[0].pubkey)?;
            let base = find(infos, &ix.accounts[1].pubkey)?;
            if !signed(base, seeds, &program) {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let b = key_at(d, 4).ok_or(bad.clone())?;
            let n = u64_at(d, 36).ok_or(bad.clone())? as usize;
            let seed = d.get(44..44 + n).ok_or(bad.clone())?;
            let space = u64_at(d, 44 + n).ok_or(bad.clone())? as usize;
            let owner = key_at(d, 52 + n).ok_or(bad)?;
            let want = permutation_rules::hash::sha256(&[b.as_ref(), seed, owner.as_ref()]);
            if b != *base.key || want != t.key.to_bytes() {
                return Err(ProgramError::InvalidSeeds);
            }
            allocate(t, space)?;
            t.assign(&owner);
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

pub fn invoke(ix: &Instruction, infos: &[AccountInfo]) -> ProgramResult {
    invoke_signed(ix, infos, &[])
}

std::thread_local! {
    /// The program id the harness runs (the caller of every CPI).
    pub static PROGRAM: Cell<Pubkey> = const { Cell::new(Pubkey::new_from_array([0; 32])) };
}

// ------------------------------------------------------------ log capture

std::thread_local! {
    /// `sol_log_data` calls of this thread, field by field.
    static LOGS: core::cell::RefCell<std::vec::Vec<std::vec::Vec<std::vec::Vec<u8>>>> =
        const { core::cell::RefCell::new(std::vec::Vec::new()) };
}

/// Syscall stubs that keep each thread's `sol_log_data` (the PS2 records)
/// and drop text logs. Every other stub is the default.
struct Capture;

impl solana_program::program_stubs::SyscallStubs for Capture {
    fn sol_log(&self, _message: &str) {}
    fn sol_log_data(&self, fields: &[&[u8]]) {
        LOGS.with(|l| {
            l.borrow_mut()
                .push(fields.iter().map(|f| f.to_vec()).collect())
        });
    }
}

/// Installs the capturing stubs (once per process).
pub fn capture_logs() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = solana_program::program_stubs::set_syscall_stubs(Box::new(Capture));
    });
}

/// This thread's captured `sol_log_data` calls since the last take.
pub fn take_logs() -> std::vec::Vec<std::vec::Vec<std::vec::Vec<u8>>> {
    LOGS.with(|l| core::mem::take(&mut *l.borrow_mut()))
}
