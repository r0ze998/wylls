//! **MOCK runtime** (workstream 04): runs the permutation-prize program's own
//! `process_instruction` natively on the host, one instruction at a time,
//! against an account store — the S1 prize season end to end in one world
//! without an SBPF build or LiteSVM.
//!
//! What is real and what is not:
//!
//! - **Real**: the prize program's Rust code (`permutation_prize::process_instruction`,
//!   built for the host with the versions its own lock pins), the account
//!   layouts of frontier-abi, PDA derivation, and the loader's input format
//!   (accounts are serialized as the BPF loader does and read back with
//!   `solana_program::entrypoint::deserialize`, so `resize` and `assign` work
//!   as on chain).
//! - **MOCK**: the System program (CreateAccount, Transfer, Allocate, Assign,
//!   AllocateWithSeed — the last three for the game's own account creation,
//!   e.g. JoinResident under the `nft` feature) and SPL Token
//!   (InitializeMint2, InitializeAccount3, MintTo, TransferChecked) are
//!   re-implemented here; the Clock and Rent sysvars come from this host
//!   (through the vendored `solana-get-sysvar` hook); signatures are a set of
//!   keys said to have signed (no ed25519); no fees, compute budget,
//!   transaction size or account-lock limits.
//! - **Optionally real, the game program** ([`Host::with_game`]): its own
//!   `dispatch` (built for the host without its entrypoint) runs the
//!   instructions sent to its id, e.g. CloseCitizen and CloseProvince in
//!   `tests/claims_vs_closes.rs`. Its accounts are still
//!   written directly with frontier-abi layouts (no CreateSeason or Join is
//!   run: those need the drand and signature machinery this host does not
//!   have). Without `with_game`, the game program is not run at all, as in
//!   `permutation-prize/svm-tests` under LiteSVM.

use std::collections::BTreeMap;
use std::sync::Mutex;

pub use solana_program;
use solana_program::account_info::AccountInfo;
use solana_program::clock::Clock;
use solana_program::entrypoint::{deserialize, ProgramResult, MAX_PERMITTED_DATA_INCREASE};
use solana_program::instruction::Instruction;
use solana_program::program_error::ProgramError;
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use solana_program::pubkey::Pubkey;

pub const TOKEN: Pubkey = permutation_prize::TOKEN_PROGRAM;
pub const SYSTEM: Pubkey = permutation_prize::SYSTEM_PROGRAM;
/// Stands for the loader that owns executable programs (not checked).
pub const LOADER: Pubkey = Pubkey::new_from_array([2u8; 32]);

/// The host answers `Rent::default()`.
pub fn rent_exempt(len: usize) -> u64 {
    solana_program::rent::Rent::default().minimum_balance(len)
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Acct {
    pub lamports: u64,
    pub data: Vec<u8>,
    pub owner: Pubkey,
    pub executable: bool,
}

/// One run at a time: the syscall stubs, the clock and the caller stack are
/// process-global (as the stubs are).
static RUN: Mutex<()> = Mutex::new(());
static CLOCK: Mutex<Option<Clock>> = Mutex::new(None);
static CALLERS: Mutex<Vec<Pubkey>> = Mutex::new(Vec::new());
static LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static DATA: Mutex<Vec<Vec<Vec<u8>>>> = Mutex::new(Vec::new());

/// The world: accounts, the prize program's id, the clock.
pub struct Host {
    pub accounts: BTreeMap<Pubkey, Acct>,
    pub prize: Pubkey,
    /// The game program's id when it runs here (`with_game`).
    pub game: Option<Pubkey>,
    pub clock: Clock,
    /// Program logs of the last transaction.
    pub logs: Vec<String>,
    /// `sol_log_data` calls of the last transaction (each one's fields).
    pub data: Vec<Vec<Vec<u8>>>,
}

impl Host {
    pub fn new(prize: Pubkey) -> Host {
        let mut accounts = BTreeMap::new();
        for p in [prize, TOKEN, SYSTEM] {
            accounts.insert(
                p,
                Acct {
                    lamports: 1,
                    data: vec![],
                    owner: LOADER,
                    executable: true,
                },
            );
        }
        Host {
            accounts,
            prize,
            game: None,
            clock: Clock {
                slot: 1,
                unix_timestamp: 1_800_000_000,
                ..Clock::default()
            },
            logs: vec![],
            data: vec![],
        }
    }

    /// The same world with the game program `game` run for real.
    pub fn with_game(prize: Pubkey, game: Pubkey) -> Host {
        let mut h = Host::new(prize);
        h.accounts.insert(
            game,
            Acct {
                lamports: 1,
                data: vec![],
                owner: LOADER,
                executable: true,
            },
        );
        h.game = Some(game);
        h
    }

    pub fn set(&mut self, key: Pubkey, a: Acct) {
        self.accounts.insert(key, a);
    }

    pub fn get(&self, key: &Pubkey) -> Option<&Acct> {
        self.accounts.get(key)
    }

    /// A system account with `lamports` more (an airdrop; MOCK).
    pub fn fund(&mut self, key: Pubkey, lamports: u64) {
        let a = self.accounts.entry(key).or_insert(Acct {
            owner: SYSTEM,
            ..Acct::default()
        });
        a.lamports += lamports;
    }

    /// Executes one transaction (its instructions in order, all or nothing)
    /// with `signers` as the keys that signed it.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[Pubkey]) -> Result<(), String> {
        let _g = RUN.lock().unwrap_or_else(|e| e.into_inner());
        install();
        *CLOCK.lock().unwrap() = Some(self.clock.clone());
        LOGS.lock().unwrap().clear();
        DATA.lock().unwrap().clear();
        let before = self.accounts.clone();
        let total =
            |m: &BTreeMap<Pubkey, Acct>| m.values().map(|a| a.lamports as u128).sum::<u128>();
        let t0 = total(&self.accounts);
        let mut r = Ok(());
        for ix in ixs {
            if let Err(e) = self.run(ix, signers) {
                r = Err(e);
                break;
            }
        }
        if r.is_ok() && total(&self.accounts) != t0 {
            r = Err("UnbalancedInstruction (lamports created or destroyed)".into());
        }
        self.logs = std::mem::take(&mut *LOGS.lock().unwrap());
        self.data = std::mem::take(&mut *DATA.lock().unwrap());
        if r.is_err() {
            self.data.clear();
        }
        if r.is_err() {
            self.accounts = before;
        }
        self.clock.slot += 1;
        r
    }

    fn run(&mut self, ix: &Instruction, signers: &[Pubkey]) -> Result<(), String> {
        for m in &ix.accounts {
            if m.is_signer && !signers.contains(&m.pubkey) {
                return Err(format!("MissingRequiredSignature {}", m.pubkey));
            }
        }
        let mut buf = serialize(&self.accounts, ix);
        // SAFETY: `buf` is in the loader's aligned input format, built just
        // above, and outlives every AccountInfo read from it.
        let (pid, infos, data) = unsafe { deserialize(buf.as_mut_ptr() as *mut u8) };
        if let Err(e) = dispatch(pid, &infos, data, &self.prize, self.game.as_ref()) {
            return Err(err_text(&e));
        }
        let mut out = vec![];
        for ai in &infos {
            out.push((
                *ai.key,
                Acct {
                    lamports: **ai.lamports.borrow(),
                    data: ai.data.borrow().to_vec(),
                    owner: *ai.owner,
                    executable: ai.executable,
                },
            ));
        }
        drop(infos);
        drop(buf);
        for (k, a) in out {
            if a.lamports > 0 || !a.data.is_empty() || a.executable {
                self.accounts.insert(k, a);
            } else {
                self.accounts.remove(&k);
            }
        }
        Ok(())
    }
}

pub fn err_text(e: &ProgramError) -> String {
    match e {
        ProgramError::Custom(c) => format!("Custom({c})"),
        e => format!("{e:?}"),
    }
}

/// The loader's (aligned) input format; a duplicate account by its index.
fn serialize(accounts: &BTreeMap<Pubkey, Acct>, ix: &Instruction) -> Vec<u64> {
    let mut b: Vec<u8> = vec![];
    b.extend_from_slice(&(ix.accounts.len() as u64).to_le_bytes());
    let mut seen: Vec<Pubkey> = vec![];
    for m in &ix.accounts {
        if let Some(i) = seen.iter().position(|k| *k == m.pubkey) {
            b.push(i as u8);
            b.extend_from_slice(&[0u8; 7]);
            seen.push(m.pubkey);
            continue;
        }
        seen.push(m.pubkey);
        let a = accounts.get(&m.pubkey).cloned().unwrap_or(Acct {
            owner: SYSTEM,
            ..Acct::default()
        });
        // A key listed more than once has the union of its privileges (as
        // the runtime merges them).
        let same = || ix.accounts.iter().filter(|x| x.pubkey == m.pubkey);
        b.push(u8::MAX);
        b.push(same().any(|x| x.is_signer) as u8);
        b.push(same().any(|x| x.is_writable) as u8);
        b.push(a.executable as u8);
        b.extend_from_slice(&[0u8; 4]);
        b.extend_from_slice(m.pubkey.as_ref());
        b.extend_from_slice(a.owner.as_ref());
        b.extend_from_slice(&a.lamports.to_le_bytes());
        b.extend_from_slice(&(a.data.len() as u64).to_le_bytes());
        b.extend_from_slice(&a.data);
        b.extend(std::iter::repeat_n(0u8, MAX_PERMITTED_DATA_INCREASE));
        b.extend_from_slice(&0u64.to_le_bytes()); // rent epoch
        while b.len() % 8 != 0 {
            b.push(0);
        }
    }
    b.extend_from_slice(&(ix.data.len() as u64).to_le_bytes());
    b.extend_from_slice(&ix.data);
    b.extend_from_slice(ix.program_id.as_ref());
    let mut out = vec![0u64; b.len().div_ceil(8)];
    // SAFETY: `out` holds at least `b.len()` bytes.
    unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), out.as_mut_ptr() as *mut u8, b.len()) };
    out
}

fn dispatch(
    pid: &Pubkey,
    infos: &[AccountInfo],
    data: &[u8],
    prize: &Pubkey,
    game: Option<&Pubkey>,
) -> ProgramResult {
    if Some(pid) == game {
        CALLERS.lock().unwrap().push(*pid);
        let r = permutation_frontier::dispatch(pid, infos, data).map_err(ProgramError::from);
        CALLERS.lock().unwrap().pop();
        r
    } else if pid == prize {
        CALLERS.lock().unwrap().push(*pid);
        let r = permutation_prize::process_instruction(pid, infos, data);
        CALLERS.lock().unwrap().pop();
        r
    } else if *pid == SYSTEM {
        system(infos, data)
    } else if *pid == TOKEN {
        token(infos, data)
    } else {
        Err(ProgramError::IncorrectProgramId)
    }
}

// ----- syscall stubs (CPI, logs) and the sysvar hook --------------------

struct Stubs;

impl SyscallStubs for Stubs {
    fn sol_log(&self, message: &str) {
        LOGS.lock().unwrap().push(message.to_string());
    }

    fn sol_log_data(&self, fields: &[&[u8]]) {
        DATA.lock()
            .unwrap()
            .push(fields.iter().map(|f| f.to_vec()).collect());
    }

    /// A CPI: signers are the caller's signers and the caller's PDAs from
    /// `seeds`; a callee never gets a privilege the caller lacks.
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        let caller = *CALLERS
            .lock()
            .unwrap()
            .last()
            .ok_or(ProgramError::InvalidArgument)?;
        let pdas = seeds
            .iter()
            .map(|s| Pubkey::create_program_address(s, &caller))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ProgramError::InvalidSeeds)?;
        let mut sub: Vec<AccountInfo> = vec![];
        for m in &ix.accounts {
            let ai = infos
                .iter()
                .find(|a| *a.key == m.pubkey)
                .ok_or(ProgramError::NotEnoughAccountKeys)?;
            let signed = ai.is_signer || pdas.contains(&m.pubkey);
            if m.is_signer && !signed {
                return Err(ProgramError::MissingRequiredSignature);
            }
            if m.is_writable && !ai.is_writable {
                return Err(ProgramError::InvalidArgument);
            }
            let mut c = ai.clone();
            c.is_signer = m.is_signer;
            c.is_writable = m.is_writable;
            sub.push(c);
        }
        CALLERS.lock().unwrap().push(ix.program_id);
        let r = if ix.program_id == SYSTEM {
            system(&sub, &ix.data)
        } else if ix.program_id == TOKEN {
            token(&sub, &ix.data)
        } else {
            Err(ProgramError::IncorrectProgramId)
        };
        CALLERS.lock().unwrap().pop();
        r
    }
}

fn host_sysvar(id: *const u8, var: *mut u8, offset: u64, length: u64) -> u64 {
    // SAFETY: impl_get_sysvar passes the address of a 32-byte sysvar id.
    let id = Pubkey::new_from_array(unsafe { *(id as *const [u8; 32]) });
    let bytes: Vec<u8> = if id == solana_program::sysvar::clock::ID {
        let c = CLOCK.lock().unwrap().clone().unwrap_or_default();
        let mut v = vec![];
        v.extend_from_slice(&c.slot.to_le_bytes());
        v.extend_from_slice(&c.epoch_start_timestamp.to_le_bytes());
        v.extend_from_slice(&c.epoch.to_le_bytes());
        v.extend_from_slice(&c.leader_schedule_epoch.to_le_bytes());
        v.extend_from_slice(&c.unix_timestamp.to_le_bytes());
        v
    } else if id == solana_program::sysvar::rent::ID {
        #[allow(deprecated)]
        let r = solana_program::rent::Rent::default();
        let mut v = vec![];
        v.extend_from_slice(&r.lamports_per_byte.to_le_bytes());
        #[allow(deprecated)]
        v.extend_from_slice(&r.exemption_threshold);
        #[allow(deprecated)]
        v.push(r.burn_percent);
        v
    } else {
        return 2;
    };
    let (o, n) = (offset as usize, length as usize);
    if o + n > bytes.len() {
        return 1;
    }
    // SAFETY: the caller's buffer holds `length` bytes.
    unsafe { std::ptr::copy_nonoverlapping(bytes[o..].as_ptr(), var, n) };
    0
}

fn install() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        set_syscall_stubs(Box::new(Stubs));
        solana_get_sysvar::set_host_sysvar(host_sysvar);
    });
}

// ----- MOCK System program --------------------------------------------

fn u64_at(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .ok_or(ProgramError::InvalidInstructionData)
}

fn two<'b, 'a>(
    a: &'b [AccountInfo<'a>],
) -> Result<(&'b AccountInfo<'a>, &'b AccountInfo<'a>), ProgramError> {
    match a {
        [x, y, ..] => Ok((x, y)),
        _ => Err(ProgramError::NotEnoughAccountKeys),
    }
}

fn system(a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let tag = d
        .get(..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        // CreateAccount { lamports, space, owner }
        0 => {
            let (from, to) = two(a)?;
            if !from.is_signer || !to.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let lamports = u64_at(d, 4)?;
            let space = u64_at(d, 12)? as usize;
            let owner = d.get(20..52).ok_or(ProgramError::InvalidInstructionData)?;
            let owner = Pubkey::new_from_array(owner.try_into().unwrap());
            // AccountAlreadyInUse (system error 0)
            if to.lamports() > 0 || !to.data_is_empty() || *to.owner != SYSTEM {
                return Err(ProgramError::Custom(0));
            }
            transfer(from, to, lamports)?;
            to.resize(space)?;
            to.assign(&owner);
            Ok(())
        }
        // Transfer { lamports }
        2 => {
            let (from, to) = two(a)?;
            if !from.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            transfer(from, to, u64_at(d, 4)?)
        }
        // Allocate { space }: the account signs (a PDA through the caller's seeds).
        8 => {
            let to = a.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
            if !to.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            allocate(to, u64_at(d, 4)? as usize)
        }
        // Assign { owner }
        1 => {
            let to = a.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
            if !to.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let owner = d.get(4..36).ok_or(ProgramError::InvalidInstructionData)?;
            assign_system(to, &Pubkey::new_from_array(owner.try_into().unwrap()))
        }
        // AllocateWithSeed { base, seed, space, owner }: accounts [to, base];
        // `to` must be `create_with_seed(base, seed, owner)` and `base` signs.
        9 => {
            let (to, base) = two(a)?;
            let base_key = d.get(4..36).ok_or(ProgramError::InvalidInstructionData)?;
            let n = u64_at(d, 36)? as usize;
            let seed = d
                .get(44..44 + n)
                .ok_or(ProgramError::InvalidInstructionData)?;
            let space = u64_at(d, 44 + n)? as usize;
            let owner = d
                .get(52 + n..84 + n)
                .ok_or(ProgramError::InvalidInstructionData)?;
            let owner = Pubkey::new_from_array(owner.try_into().unwrap());
            let base_key = Pubkey::new_from_array(base_key.try_into().unwrap());
            if *base.key != base_key || !base.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let seed = core::str::from_utf8(seed).map_err(|_| ProgramError::InvalidSeeds)?;
            let want = Pubkey::create_with_seed(&base_key, seed, &owner)
                .map_err(|_| ProgramError::InvalidSeeds)?;
            if *to.key != want {
                return Err(ProgramError::InvalidSeeds);
            }
            allocate(to, space)?;
            assign_system(to, &owner)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// System Allocate: only a System-owned account with no data.
fn allocate(to: &AccountInfo, space: usize) -> ProgramResult {
    if *to.owner != SYSTEM || !to.data_is_empty() {
        return Err(ProgramError::Custom(0)); // AccountAlreadyInUse
    }
    to.resize(space)
}

/// System Assign: only a System-owned account.
fn assign_system(to: &AccountInfo, owner: &Pubkey) -> ProgramResult {
    if *to.owner != SYSTEM {
        return Err(ProgramError::IllegalOwner);
    }
    to.assign(owner);
    Ok(())
}

fn transfer(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> ProgramResult {
    if *from.owner != SYSTEM || !from.data_is_empty() {
        return Err(ProgramError::InvalidArgument);
    }
    let have = from.lamports();
    if have < lamports {
        return Err(ProgramError::Custom(1)); // ResultWithNegativeLamports
    }
    **from.lamports.borrow_mut() = have - lamports;
    **to.lamports.borrow_mut() += lamports;
    Ok(())
}

// ----- MOCK SPL Token (the four instructions the season uses) ---------

/// SPL Token's account (165 bytes) and mint (82 bytes) layouts, error codes.
pub mod spl {
    pub const ACCOUNT_LEN: usize = 165;
    pub const MINT_LEN: usize = 82;
    pub const A_MINT: usize = 0;
    pub const A_OWNER: usize = 32;
    pub const A_AMOUNT: usize = 64;
    pub const A_STATE: usize = 108;
    pub const M_AUTH_TAG: usize = 0;
    pub const M_AUTH: usize = 4;
    pub const M_SUPPLY: usize = 36;
    pub const M_DECIMALS: usize = 44;
    pub const M_INIT: usize = 45;
    pub const E_INSUFFICIENT_FUNDS: u32 = 1;
    pub const E_MINT_MISMATCH: u32 = 3;
    pub const E_OWNER_MISMATCH: u32 = 4;
    pub const E_ALREADY_IN_USE: u32 = 6;
    pub const E_UNINITIALIZED: u32 = 9;
    pub const E_DECIMALS: u32 = 18;
}

fn key_at(b: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(b[o..o + 32].try_into().unwrap())
}

fn token(a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    use spl::*;
    let acc = |i: usize| a.get(i).ok_or(ProgramError::NotEnoughAccountKeys);
    let owned = |ai: &AccountInfo, len: usize| {
        if *ai.owner != TOKEN || ai.data_len() != len {
            Err(ProgramError::IncorrectProgramId)
        } else {
            Ok(())
        }
    };
    let set_u64 = |ai: &AccountInfo, o: usize, v: u64| -> ProgramResult {
        ai.try_borrow_mut_data()?[o..o + 8].copy_from_slice(&v.to_le_bytes());
        Ok(())
    };
    match d
        .first()
        .copied()
        .ok_or(ProgramError::InvalidInstructionData)?
    {
        // InitializeMint2 { decimals, authority, freeze: Option }
        20 => {
            let m = acc(0)?;
            owned(m, MINT_LEN)?;
            let auth = d.get(2..34).ok_or(ProgramError::InvalidInstructionData)?;
            let mut md = m.try_borrow_mut_data()?;
            if md[M_INIT] != 0 {
                return Err(ProgramError::Custom(E_ALREADY_IN_USE));
            }
            md[M_AUTH_TAG] = 1;
            md[M_AUTH..M_AUTH + 32].copy_from_slice(auth);
            md[M_DECIMALS] = d[1];
            md[M_INIT] = 1;
            Ok(())
        }
        // InitializeAccount3 { owner }
        18 => {
            let (t, m) = (acc(0)?, acc(1)?);
            owned(t, ACCOUNT_LEN)?;
            owned(m, MINT_LEN)?;
            if m.try_borrow_data()?[M_INIT] != 1 {
                return Err(ProgramError::Custom(E_UNINITIALIZED));
            }
            let owner = d.get(1..33).ok_or(ProgramError::InvalidInstructionData)?;
            let mut td = t.try_borrow_mut_data()?;
            if td[A_STATE] != 0 {
                return Err(ProgramError::Custom(E_ALREADY_IN_USE));
            }
            td[A_MINT..A_MINT + 32].copy_from_slice(m.key.as_ref());
            td[A_OWNER..A_OWNER + 32].copy_from_slice(owner);
            td[A_STATE] = 1;
            Ok(())
        }
        // MintTo { amount }
        7 => {
            let (m, t, auth) = (acc(0)?, acc(1)?, acc(2)?);
            owned(m, MINT_LEN)?;
            owned(t, ACCOUNT_LEN)?;
            let amount = u64_at(d, 1)?;
            {
                let md = m.try_borrow_data()?;
                if md[M_AUTH_TAG] != 1 || key_at(&md, M_AUTH) != *auth.key {
                    return Err(ProgramError::Custom(E_OWNER_MISMATCH));
                }
                let td = t.try_borrow_data()?;
                if td[A_STATE] != 1 {
                    return Err(ProgramError::Custom(E_UNINITIALIZED));
                }
                if key_at(&td, A_MINT) != *m.key {
                    return Err(ProgramError::Custom(E_MINT_MISMATCH));
                }
            }
            if !auth.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            let supply = u64_at(&m.try_borrow_data()?, M_SUPPLY)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            let bal = u64_at(&t.try_borrow_data()?, A_AMOUNT)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            set_u64(m, M_SUPPLY, supply)?;
            set_u64(t, A_AMOUNT, bal)
        }
        // TransferChecked { amount, decimals }
        12 => {
            let (src, m, dst, auth) = (acc(0)?, acc(1)?, acc(2)?, acc(3)?);
            owned(src, ACCOUNT_LEN)?;
            owned(m, MINT_LEN)?;
            owned(dst, ACCOUNT_LEN)?;
            let amount = u64_at(d, 1)?;
            let decimals = *d.get(9).ok_or(ProgramError::InvalidInstructionData)?;
            if m.try_borrow_data()?[M_DECIMALS] != decimals {
                return Err(ProgramError::Custom(E_DECIMALS));
            }
            for ai in [src, dst] {
                let x = ai.try_borrow_data()?;
                if x[A_STATE] != 1 {
                    return Err(ProgramError::Custom(E_UNINITIALIZED));
                }
                if key_at(&x, A_MINT) != *m.key {
                    return Err(ProgramError::Custom(E_MINT_MISMATCH));
                }
            }
            if key_at(&src.try_borrow_data()?, A_OWNER) != *auth.key {
                return Err(ProgramError::Custom(E_OWNER_MISMATCH));
            }
            if !auth.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            if !src.is_writable || !dst.is_writable {
                return Err(ProgramError::InvalidArgument);
            }
            let have = u64_at(&src.try_borrow_data()?, A_AMOUNT)?;
            if have < amount {
                return Err(ProgramError::Custom(E_INSUFFICIENT_FUNDS));
            }
            if src.key == dst.key {
                return Ok(());
            }
            let got = u64_at(&dst.try_borrow_data()?, A_AMOUNT)?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            set_u64(src, A_AMOUNT, have - amount)?;
            set_u64(dst, A_AMOUNT, got)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// A token account's balance (SPL layout), or None.
pub fn token_balance(h: &Host, key: &Pubkey) -> Option<u64> {
    let a = h.get(key)?;
    (a.owner == TOKEN && a.data.len() == spl::ACCOUNT_LEN)
        .then(|| u64::from_le_bytes(a.data[spl::A_AMOUNT..spl::A_AMOUNT + 8].try_into().unwrap()))
}
