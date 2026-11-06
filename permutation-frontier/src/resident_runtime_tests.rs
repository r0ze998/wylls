//! Key-free runtime harness for NFT residents (⑳, `nft-experimental`).
//!
//! The program's real `dispatch` runs on the host over hand-built accounts:
//! JoinResident (the first login), ResidentAct wrapping SetVigil, transfers,
//! A→B→A, sessions and the refusals.
//!
//! **No key is generated, derived or signed.** Every account address is
//! either a literal 32-byte value or an address the program itself computes
//! by hashing (the Season PDA, `find_program_address` for the policy, the
//! link, the resident account and the guard authority, `with_seed` for the
//! Citizen and the Frontier): the test computes the same hashes to place
//! the accounts there. No keypair, secret or signature exists anywhere.
//!
//! **What this does not show (limits).**
//! - Signatures: `is_signer` is set by the test, as the runtime would after
//!   verifying a signature; signature verification itself is not run (the
//!   same limit as a LiteSVM run with `sigverify` off).
//! - The SBF build: this is the host build of the same source (no compute
//!   budget, no SBF loader, no account-size or ownership enforcement by a
//!   runtime).
//! - CPI: the System program's Transfer / Allocate / Assign /
//!   AllocateWithSeed are emulated by [`Stubs`] (lamports, size, owner, and
//!   the signer seeds or the with-seed address checked as the runtime
//!   would); nothing else may be invoked.
//! - Metaplex Core and the resident program are not run: their accounts are
//!   written as bytes in the states their instructions leave (an asset with
//!   its owner and its transfer guard; a resident record with its
//!   generation and session). A transfer is modelled as the resident
//!   program's TransferResident leaves it: the asset's owner changes, the
//!   generation goes up by one.
//! - Clock and Rent: set through `prologue::set_test_clock` and the default
//!   rent (`init::rent` under `cfg(test)`).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use frontier_abi::resident_auth::Policy;
use frontier_abi::resident_citizen as rc;
use frontier_abi::resident_wire as wire;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use solana_program::{
    account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::layout::{frontier as FR, season as S};

/// One test at a time: the syscall stubs and the log capture are global.
static SERIAL: Mutex<()> = Mutex::new(());

/// Backing memory of every account created by a test: key → (data pointer,
/// capacity, owner pointer). The stub resizes and reassigns through it.
type Memory = HashMap<[u8; 32], (usize, usize, usize)>;
static MEMORY: Mutex<Option<Memory>> = Mutex::new(None);
/// The PS2 records the program logged (`sol_log_data`).
static LOGS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

const SYSTEM: [u8; 32] = crate::addr::ids::SYSTEM_PROGRAM;

struct Stubs;

impl solana_program::program_stubs::SyscallStubs for Stubs {
    fn sol_log(&self, _message: &str) {}

    fn sol_log_data(&self, fields: &[&[u8]]) {
        if fields.len() == 2 && fields[0] == &frontier_abi::log::PREFIX[..] {
            LOGS.lock().unwrap().push(fields[1].to_vec());
        }
    }

    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        if ix.program_id.to_bytes() != SYSTEM || ix.data.len() < 4 {
            return Err(ProgramError::IncorrectProgramId);
        }
        let find = |k: &Pubkey| infos.iter().find(|a| a.key == k).cloned();
        let target = find(&ix.accounts[0].pubkey).ok_or(ProgramError::NotEnoughAccountKeys)?;
        let caller = crate::resident_runtime_tests::PROGRAM;
        // A signer the runtime would accept: a signer of the outer
        // instruction, or the PDA of the caller's seeds.
        let signed = |k: &Pubkey| -> bool {
            find(k).is_some_and(|a| a.is_signer)
                || seeds.iter().any(|s| {
                    Pubkey::create_program_address(s, &Pubkey::new_from_array(caller))
                        .is_ok_and(|p| p == *k)
                })
        };
        let d = &ix.data;
        let u64at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        match u32::from_le_bytes(d[..4].try_into().unwrap()) {
            2 => {
                // Transfer: from (signs) → to.
                let to = find(&ix.accounts[1].pubkey).ok_or(ProgramError::NotEnoughAccountKeys)?;
                if !signed(target.key) || *target.owner != Pubkey::new_from_array(SYSTEM) {
                    return Err(ProgramError::MissingRequiredSignature);
                }
                let n = u64at(4);
                let f = target
                    .lamports()
                    .checked_sub(n)
                    .ok_or(ProgramError::InsufficientFunds)?;
                **target.try_borrow_mut_lamports()? = f;
                **to.try_borrow_mut_lamports()? += n;
                Ok(())
            }
            8 => {
                if !signed(target.key) {
                    return Err(ProgramError::MissingRequiredSignature);
                }
                resize(&target, u64at(4) as usize)
            }
            1 => {
                if !signed(target.key) {
                    return Err(ProgramError::MissingRequiredSignature);
                }
                assign(&target, d[4..36].try_into().unwrap())
            }
            9 => {
                // AllocateWithSeed: base(32) ‖ len u64 ‖ seed ‖ space u64 ‖ owner(32).
                let base: [u8; 32] = d[4..36].try_into().unwrap();
                let n = u64at(36) as usize;
                let seed = &d[44..44 + n];
                let space = u64at(44 + n) as usize;
                let owner: [u8; 32] = d[52 + n..84 + n].try_into().unwrap();
                let want = permutation_rules::hash::sha256(&[&base, seed, &owner]);
                if want != target.key.to_bytes() || !signed(&Pubkey::new_from_array(base)) {
                    return Err(ProgramError::InvalidSeeds);
                }
                resize(&target, space)?;
                assign(&target, owner)
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

fn resize(a: &AccountInfo, space: usize) -> Result<(), ProgramError> {
    let mem = MEMORY.lock().unwrap();
    let &(ptr, cap, _) = mem
        .as_ref()
        .and_then(|m| m.get(&a.key.to_bytes()))
        .ok_or(ProgramError::InvalidRealloc)?;
    if space > cap || a.data_len() != 0 {
        return Err(ProgramError::InvalidRealloc);
    }
    // SAFETY: `ptr` is a leaked buffer of `cap` zeroed bytes made for this
    // account by `World::account`; no other slice of it is alive.
    let s = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, space) };
    *a.try_borrow_mut_data()? = s;
    Ok(())
}

fn assign(a: &AccountInfo, owner: [u8; 32]) -> Result<(), ProgramError> {
    let mem = MEMORY.lock().unwrap();
    let &(_, _, op) = mem
        .as_ref()
        .and_then(|m| m.get(&a.key.to_bytes()))
        .ok_or(ProgramError::IllegalOwner)?;
    // SAFETY: `op` is the leaked owner cell `World::account` made for this
    // account; the runtime's own `AccountInfo::assign` writes it the same way.
    unsafe { std::ptr::write_volatile(op as *mut Pubkey, Pubkey::new_from_array(owner)) };
    Ok(())
}

// ------------------------------------------------------------------ world

pub(crate) const PROGRAM: [u8; 32] = [0x11; 32];
const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const CORE: [u8; 32] = [0x44; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const ASSET: [u8; 32] = [0x5a; 32];
const A: [u8; 32] = [0xa1; 32];
const B: [u8; 32] = [0xb2; 32];
const SESSION: [u8; 32] = [0xc3; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const GENESIS: i64 = 1_800_000_000;

/// The Season PDA's bump, found as AnnounceSeason finds it (the System
/// program only accepts an off-curve signer address).
fn season_bump(id: u64) -> u8 {
    Pubkey::find_program_address(
        &[crate::addr::SEASON_PREFIX, &crate::addr::season_seed_id(id)],
        &Pubkey::new_from_array(PROGRAM),
    )
    .1
}

/// One account's leaked parts (the test's lifetime is the process's).
struct Parts {
    key: &'static Pubkey,
    lamports: &'static mut u64,
    data: &'static mut [u8],
    owner: &'static Pubkey,
}

fn leak(key: [u8; 32], owner: [u8; 32], data: Vec<u8>, cap: usize, lamports: u64) -> Parts {
    let key: &'static Pubkey = Box::leak(Box::new(Pubkey::new_from_array(key)));
    let owner_cell: &'static mut Pubkey = Box::leak(Box::new(Pubkey::new_from_array(owner)));
    let owner_ptr = owner_cell as *mut Pubkey as usize;
    let mut buf = vec![0u8; cap.max(data.len())];
    buf[..data.len()].copy_from_slice(&data);
    let len = data.len();
    let buf: &'static mut [u8] = Box::leak(buf.into_boxed_slice());
    MEMORY
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(
            key.to_bytes(),
            (buf.as_mut_ptr() as usize, buf.len(), owner_ptr),
        );
    Parts {
        key,
        lamports: Box::leak(Box::new(lamports)),
        data: &mut buf[..len],
        owner: owner_cell,
    }
}

fn info(p: Parts, signer: bool, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(p.key, signer, writable, p.lamports, p.data, p.owner, false)
}

/// The Season, its Frontier, the policy, and the NFT's accounts.
struct World {
    season_id: u64,
    season: [u8; 32],
    ctx: frontier_abi::addr::AddrCtx,
    season_ai: AccountInfo<'static>,
    frontier: AccountInfo<'static>,
    config: AccountInfo<'static>,
    link: AccountInfo<'static>,
    asset: AccountInfo<'static>,
    resident: AccountInfo<'static>,
    citizen: AccountInfo<'static>,
    payer: AccountInfo<'static>,
    system: AccountInfo<'static>,
    /// The resident record's bytes (generation, session) as the resident
    /// program leaves them.
    generation: u32,
}

fn pda(seeds: &[&[u8]], program: &[u8; 32]) -> [u8; 32] {
    Pubkey::find_program_address(seeds, &Pubkey::new_from_array(*program))
        .0
        .to_bytes()
}

fn guard() -> [u8; 32] {
    pda(&[b"collection-authority"], &RESIDENT_PROGRAM)
}

/// `PluginHeaderV1` + `PluginRegistryV1` for a frozen Permanent Freeze
/// Delegate and a Permanent Transfer Delegate of `guard` after an AssetV1
/// base ending at `base` (the layout `resident_guard` reads).
fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(guard);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

/// A Core AssetV1 owned by `owner`, in the collection, with the guard
/// unless `unguarded`.
fn asset_bytes(owner: &[u8; 32], unguarded: bool) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0); // no sequence
    if !unguarded {
        let base = a.len();
        a.extend_from_slice(&guarded_tail(base, &guard()));
    }
    a
}

/// The resident program's record of `ASSET` (133 B).
fn resident_bytes(generation: u32, session: Option<([u8; 32], u32, [u8; 32])>) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    if let Some((key, gen, setter)) = session {
        r[52..84].copy_from_slice(&key);
        r[84..92].copy_from_slice(&i64::MAX.to_le_bytes());
        r[92..96].copy_from_slice(&gen.to_le_bytes());
        r[96..128].copy_from_slice(&setter);
    }
    r
}

impl World {
    fn new(season_id: u64) -> World {
        let bump = season_bump(season_id);
        let season = crate::addr::season_pda(season_id, bump, &PROGRAM);
        let ctx = crate::addr::ctx(&season, &PROGRAM);
        let mut sd = vec![0u8; K2::Season.size()];
        assert!(write_header(&mut sd, K2::Season, season_id));
        sd[S::STATUS] = S::STATUS_RUNNING;
        sd[S::BUMP] = bump;
        sd[S::R_MAX..S::R_MAX + 2].copy_from_slice(&8u16.to_le_bytes());
        sd[S::RULESET_HASH..S::RULESET_HASH + 32].copy_from_slice(&crate::RULESET_HASH);
        sd[S::GENESIS_TS..S::GENESIS_TS + 8].copy_from_slice(&GENESIS.to_le_bytes());
        sd[S::JOIN_CLOSE_BELL..S::JOIN_CLOSE_BELL + 4].copy_from_slice(&100_000u32.to_le_bytes());
        sd[S::END_BELL..S::END_BELL + 4].copy_from_slice(&200_000u32.to_le_bytes());
        sd[S::BUCKET_RATE_PER_H..S::BUCKET_RATE_PER_H + 2].copy_from_slice(&60u16.to_le_bytes());
        sd[S::BUCKET_BURST..S::BUCKET_BURST + 2].copy_from_slice(&20u16.to_le_bytes());
        let mut fd = vec![0u8; K2::Frontier.size()];
        assert!(write_header(&mut fd, K2::Frontier, season_id));
        fd[FR::OPEN_SITES..FR::OPEN_SITES + 4].copy_from_slice(&100u32.to_le_bytes());
        let policy = Policy {
            core_program: CORE,
            resident_program: RESIDENT_PROGRAM,
            collection: COLLECTION,
            guard_authority: guard(),
        };
        let mut pd = vec![0u8; frontier_abi::resident_policy::LEN];
        assert!(frontier_abi::resident_policy::write_once(&mut pd, &policy));
        let tag15 = rc::resident_tag15(&ASSET);
        let citizen = ctx.citizen_by_tag15(&tag15);
        let big = 10_000_000_000u64;
        World {
            season_id,
            season,
            ctx,
            season_ai: info(leak(season, PROGRAM, sd, 0, big), false, false),
            frontier: info(leak(ctx.frontier(), PROGRAM, fd, 0, big), false, false),
            config: info(
                leak(
                    pda(&[b"nft-resident-policy"], &PROGRAM),
                    PROGRAM,
                    pd,
                    0,
                    big,
                ),
                false,
                false,
            ),
            link: info(
                leak(
                    pda(&[b"nft-citizen-link", &ASSET], &PROGRAM),
                    SYSTEM,
                    vec![],
                    frontier_abi::resident_binding::LEN,
                    0,
                ),
                false,
                true,
            ),
            asset: info(
                leak(ASSET, CORE, asset_bytes(&A, false), 0, big),
                false,
                false,
            ),
            resident: info(
                leak(
                    pda(&[b"resident", &ASSET], &RESIDENT_PROGRAM),
                    RESIDENT_PROGRAM,
                    resident_bytes(0, None),
                    0,
                    big,
                ),
                false,
                false,
            ),
            citizen: info(
                leak(citizen, SYSTEM, vec![], crate::layout::citizen::SIZE, 0),
                false,
                true,
            ),
            payer: info(leak(PAYER, SYSTEM, vec![], 0, big), true, true),
            system: info(leak(SYSTEM, [0; 32], vec![], 0, 1), false, false),
            generation: 0,
        }
    }

    /// TransferResident as the resident program leaves it: the asset's
    /// owner is `to`, the generation goes up by one; `session` is the
    /// resident record's session afterwards (`None`: cleared).
    fn transfer(&mut self, to: &[u8; 32], session: Option<([u8; 32], u32, [u8; 32])>) {
        self.generation += 1;
        self.asset.try_borrow_mut_data().unwrap()[1..33].copy_from_slice(to);
        self.set_resident(session);
    }

    fn set_resident(&mut self, session: Option<([u8; 32], u32, [u8; 32])>) {
        self.resident
            .try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&resident_bytes(self.generation, session));
    }

    fn actor(&self, key: [u8; 32], signer: bool) -> AccountInfo<'static> {
        info(leak(key, SYSTEM, vec![], 0, 0), signer, false)
    }

    fn proof(&self) -> [AccountInfo<'static>; 4] {
        [
            self.config.clone(),
            readonly(&self.link),
            self.asset.clone(),
            self.resident.clone(),
        ]
    }

    fn join(&self, owner: [u8; 32], generation: u32) -> Result<(), u32> {
        let mut a = vec![
            self.actor(owner, true),
            self.payer.clone(),
            self.season_ai.clone(),
            self.frontier.clone(),
            self.citizen.clone(),
            self.system.clone(),
            self.config.clone(),
            self.link.clone(),
            self.asset.clone(),
            self.resident.clone(),
        ];
        a.shrink_to_fit();
        let mut d = vec![wire::JOIN_RESIDENT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.push(2);
        run(&a, &d)
    }

    /// ResidentAct(SetVigil) by `actor` with the signed `generation`.
    fn vigil(&self, actor: [u8; 32], signed: bool, generation: u32) -> Result<(), u32> {
        let mut a = vec![
            self.actor(actor, signed),
            self.payer.clone(),
            self.season_ai.clone(),
            self.citizen.clone(),
        ];
        a.extend(self.proof());
        let mut d = vec![wire::RESIDENT_ACT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.push(frontier_abi::v2::Ix::SetVigil.tag());
        d.extend_from_slice(&600u16.to_le_bytes());
        run(&a, &d)
    }
}

fn readonly(a: &AccountInfo<'static>) -> AccountInfo<'static> {
    let mut r = a.clone();
    r.is_writable = false;
    r
}

/// The program's custom error code of a result.
fn run(accounts: &[AccountInfo<'static>], data: &[u8]) -> Result<(), u32> {
    crate::dispatch(&Pubkey::new_from_array(PROGRAM), accounts, data).map_err(|e| {
        match ProgramError::from(e) {
            ProgramError::Custom(c) => c,
            other => panic!("not a program error code: {other:?}"),
        }
    })
}

/// Starts a test: one at a time, stubs installed, logs cleared, the clock
/// at `bell` bells after genesis.
fn begin() -> MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    solana_program::program_stubs::set_syscall_stubs(Box::new(Stubs));
    LOGS.lock().unwrap().clear();
    at_day(0);
    g
}

/// The clock `day` days (and one bell) after genesis.
fn at_day(day: i64) {
    crate::prologue::set_test_clock(GENESIS + 600 + day * 86_400, 1_000 + day as u64);
}

fn records() -> Vec<Vec<u8>> {
    std::mem::take(&mut *LOGS.lock().unwrap())
}

use crate::error::BAD_ACCOUNT;
use frontier_abi::v2::error::CqError as E;
const NOT_SIGNED: u32 = E::ResidentNotSigned as u32;
const ASSET_BAD: u32 = E::ResidentAsset as u32;
const RESIDENT_BAD: u32 = E::ResidentAccount as u32;
const UNGUARDED: u32 = E::ResidentUnguarded as u32;
const STALE: u32 = E::ResidentStaleGeneration as u32;
const NOT_CURRENT: u32 = E::ResidentNotCurrentAuthority as u32;

fn bad_account() -> u32 {
    match ProgramError::from(BAD_ACCOUNT) {
        ProgramError::Custom(c) => c,
        e => panic!("{e:?}"),
    }
}

// ------------------------------------------------------------------ tests

#[test]
fn first_login_creates_one_citizen_and_logs_resident_joined() {
    let _g = begin();
    let w = World::new(7);
    assert_eq!(w.join(A, 0), Ok(()));
    // The Citizen: at citizen_by_tag15(resident id), marked, zero wallet.
    assert_eq!(w.season_ai.key.to_bytes(), w.season);
    assert_eq!(
        w.citizen.key.to_bytes(),
        w.ctx.citizen_by_tag15(&rc::resident_tag15(&ASSET))
    );
    let cd = w.citizen.try_borrow_data().unwrap().to_vec();
    assert_eq!(*w.citizen.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(rc::resident_asset(&cd), Some(ASSET));
    assert_eq!(rc::record_tag15(&cd), Some(rc::resident_tag15(&ASSET)));
    // The link records the asset, the resident account and this Citizen.
    let link = frontier_abi::resident_binding::read(&w.link.try_borrow_data().unwrap()).unwrap();
    assert_eq!(link.citizen, w.citizen.key.to_bytes());
    // RESIDENT_JOINED (kind 130): keyed by the resident id, no links.
    let recs = records();
    assert_eq!(recs.len(), 1);
    let r = frontier_abi::v2::log::decode(&recs[0]).unwrap();
    use frontier_abi::v2::log::{AnyKind, CqKind};
    assert_eq!(r.kind, AnyKind::Cq(CqKind::RESIDENT_JOINED));
    assert_eq!(r.key, rc::resident_tag15(&ASSET));
    assert_eq!(&r.payload[..32], &ASSET);
    assert_eq!(r.payload[32], 2, "faction");
    assert_eq!(&r.payload[34..38], &0u32.to_le_bytes(), "generation");
    assert_eq!(r.n_links, 0);
    // One NFT, one Citizen: a second login is AlreadyDone.
    assert_eq!(w.join(A, 0), Err(crate::FrontierError::AlreadyDone as u32));
    let _ = w.season_id;
}

#[test]
fn only_the_current_owner_logs_in() {
    let _g = begin();
    let mut w = World::new(7);
    w.transfer(&B, None);
    // A is no longer the owner; its old generation is stale.
    assert_eq!(w.join(A, 0), Err(STALE));
    assert_eq!(w.join(A, 1), Err(NOT_CURRENT));
    assert_eq!(w.join(B, 1), Ok(()));
}

#[test]
fn transfer_and_buy_back_refuse_every_old_authority() {
    let _g = begin();
    let mut w = World::new(7);
    assert_eq!(w.join(A, 0), Ok(()));
    assert_eq!(w.vigil(A, true, 0), Ok(()), "owner A acts (generation 0)");
    // A → B (generation 1).
    w.transfer(&B, None);
    at_day(10);
    assert_eq!(w.vigil(A, true, 0), Err(STALE), "A's signature from before");
    assert_eq!(w.vigil(A, true, 1), Err(NOT_CURRENT), "A, fresh signature");
    assert_eq!(w.vigil(B, true, 0), Err(STALE), "B with the old generation");
    assert_eq!(w.vigil(B, true, 1), Ok(()), "new owner B acts at once");
    // B gives a session; it acts for B.
    w.set_resident(Some((SESSION, 1, B)));
    at_day(20);
    assert_eq!(w.vigil(SESSION, true, 1), Ok(()), "B's session");
    // B → A (generation 2). The session's record may linger: it is bound to
    // generation 1 and to B, so it no longer acts.
    w.transfer(&A, Some((SESSION, 1, B)));
    at_day(30);
    assert_eq!(
        w.vigil(SESSION, true, 2),
        Err(NOT_CURRENT),
        "B's old session"
    );
    assert_eq!(w.vigil(SESSION, true, 1), Err(STALE));
    assert_eq!(w.vigil(B, true, 1), Err(STALE), "B's signature from before");
    assert_eq!(w.vigil(B, true, 2), Err(NOT_CURRENT), "B, fresh signature");
    assert_eq!(
        w.vigil(A, true, 0),
        Err(STALE),
        "A's first-ownership signature"
    );
    assert_eq!(w.vigil(A, true, 2), Ok(()), "A again, with generation 2");
}

#[test]
fn unsigned_unguarded_and_substituted_accounts_are_refused() {
    let _g = begin();
    let mut w = World::new(7);
    assert_eq!(w.join(A, 0), Ok(()));
    // Unsigned: the player prologue refuses it first (`Auth`), before the
    // resident check would (`ResidentNotSigned`).
    assert_eq!(w.vigil(A, false, 0), Err(crate::FrontierError::Auth as u32));
    let _ = NOT_SIGNED;
    // The resident record of another asset.
    {
        let mut r = w.resident.try_borrow_mut_data().unwrap();
        r[1] ^= 1;
    }
    assert_eq!(w.vigil(A, true, 0), Err(RESIDENT_BAD));
    w.set_resident(None);
    // An asset of another collection.
    let keep = w.asset.try_borrow_data().unwrap().to_vec();
    w.asset.try_borrow_mut_data().unwrap()[40] ^= 1;
    assert_eq!(w.vigil(A, true, 0), Err(ASSET_BAD));
    // The same asset without its transfer guard (same length, registry
    // zeroed): it could move without a generation change.
    {
        let mut a = w.asset.try_borrow_mut_data().unwrap();
        a.copy_from_slice(&keep);
        let base = asset_bytes(&A, true).len();
        a[base] = 0;
    }
    assert_eq!(w.vigil(A, true, 0), Err(UNGUARDED));
    w.asset
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&keep);
    assert_eq!(w.vigil(A, true, 0), Ok(()));
}

/// A later Season of the same program, sharing this world's global
/// accounts (policy, link, asset, resident record): the NFT and its one
/// account are the same; only the Season (and so the Citizen's address) is
/// new.
fn later_season(first: &World, season_id: u64) -> World {
    let mut w = World::new(season_id);
    w.config = first.config.clone();
    w.link = first.link.clone();
    w.asset = first.asset.clone();
    w.resident = first.resident.clone();
    w.generation = first.generation;
    w
}

#[test]
fn the_same_nft_joins_a_later_season_with_its_one_link() {
    // 2026-11-06 candidate for U45: the link binds the asset to its resident
    // account for every Season; the Citizen it names is the first (history).
    let _g = begin();
    let w1 = World::new(7);
    assert_eq!(w1.join(A, 0), Ok(()));
    let link_before = w1.link.try_borrow_data().unwrap().to_vec();
    let w2 = later_season(&w1, 8);
    assert_ne!(w1.citizen.key, w2.citizen.key, "per-Season Citizen address");
    assert_eq!(w2.join(A, 0), Ok(()), "the same NFT joins Season 8");
    // One link, unchanged: it still names Season 7's Citizen as the first.
    assert_eq!(w1.link.try_borrow_data().unwrap().to_vec(), link_before);
    let link = frontier_abi::resident_binding::read(&link_before).unwrap();
    assert_eq!(link.citizen, w1.citizen.key.to_bytes());
    // Season 8's Citizen is this asset's, under the same resident id.
    let cd = w2.citizen.try_borrow_data().unwrap().to_vec();
    assert_eq!(rc::resident_asset(&cd), Some(ASSET));
    assert_eq!(rc::record_tag15(&cd), Some(rc::resident_tag15(&ASSET)));
    // Still one Citizen per NFT per Season.
    assert_eq!(w2.join(A, 0), Err(crate::FrontierError::AlreadyDone as u32));
    assert_eq!(w1.join(A, 0), Err(crate::FrontierError::AlreadyDone as u32));
    // The owner acts in both Seasons through the same link.
    assert_eq!(w1.vigil(A, true, 0), Ok(()));
    assert_eq!(w2.vigil(A, true, 0), Ok(()));
    // The Seasons are not mixed: Season 7's Citizen in Season 8 is refused.
    let mut a = vec![
        w2.actor(A, true),
        w2.payer.clone(),
        w2.season_ai.clone(),
        w1.citizen.clone(),
    ];
    a.extend(w2.proof());
    let mut d = vec![wire::RESIDENT_ACT];
    d.extend_from_slice(&0u32.to_le_bytes());
    d.push(frontier_abi::v2::Ix::SetVigil.tag());
    d.extend_from_slice(&600u16.to_le_bytes());
    assert_eq!(
        crate::dispatch(&Pubkey::new_from_array(PROGRAM), &a, &d).map_err(ProgramError::from),
        Err(ProgramError::InvalidAccountData),
        "another Season's Citizen is refused"
    );
}

#[test]
fn a_transfer_moves_the_one_account_in_every_season_at_once() {
    let _g = begin();
    let mut w1 = World::new(7);
    assert_eq!(w1.join(A, 0), Ok(()));
    let w2 = later_season(&w1, 8);
    assert_eq!(w2.join(A, 0), Ok(()));
    // A → B (generation 1): the resident record is global, so both Seasons
    // follow it at once.
    w1.transfer(&B, None);
    at_day(10);
    for w in [&w1, &w2] {
        assert_eq!(w.vigil(A, true, 0), Err(STALE));
        assert_eq!(w.vigil(A, true, 1), Err(NOT_CURRENT));
        assert_eq!(w.vigil(B, true, 1), Ok(()));
    }
    // A new Season after the transfer: only the current owner joins.
    let w3 = later_season(&w1, 9);
    assert_eq!(w3.join(A, 1), Err(NOT_CURRENT));
    assert_eq!(w3.join(A, 0), Err(STALE));
    assert_eq!(w3.join(B, 1), Ok(()));
    assert_eq!(w3.vigil(B, true, 1), Ok(()));
}

#[test]
fn a_later_season_refuses_a_link_of_another_asset_or_resident() {
    let _g = begin();
    let w1 = World::new(7);
    assert_eq!(w1.join(A, 0), Ok(()));
    let w2 = later_season(&w1, 8);
    let keep = w1.link.try_borrow_data().unwrap().to_vec();
    // The link's resident (bytes 40..72) altered: not this account's link.
    w1.link.try_borrow_mut_data().unwrap()[40] ^= 1;
    assert_eq!(w2.join(A, 0), Err(bad_account()));
    w1.link
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&keep);
    // The link's asset (bytes 8..40) altered.
    w1.link.try_borrow_mut_data().unwrap()[8] ^= 1;
    assert_eq!(w2.join(A, 0), Err(bad_account()));
    w1.link
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&keep);
    // Restored, it joins; the link is still write-once.
    assert_eq!(w2.join(A, 0), Ok(()));
    assert_eq!(w1.link.try_borrow_data().unwrap().to_vec(), keep);
}

#[test]
fn a_citizen_without_this_assets_mark_is_refused() {
    // The link no longer names the Season's Citizen, so the Citizen's own
    // resident mark (the asset) carries that check (proc::resident::check).
    let _g = begin();
    let w1 = World::new(7);
    assert_eq!(w1.join(A, 0), Ok(()));
    let w2 = later_season(&w1, 8);
    assert_eq!(w2.join(A, 0), Ok(()));
    let keep = w2.citizen.try_borrow_data().unwrap().to_vec();
    let mut other = keep.clone();
    assert!(rc::mark(&mut other, &[0x6b; 32]));
    assert_ne!([0x6b; 32], ASSET);
    w2.citizen
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&other);
    assert_eq!(w2.vigil(A, true, 0), Err(bad_account()));
    w2.citizen
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&keep);
    assert_eq!(w2.vigil(A, true, 0), Ok(()));
}

#[test]
fn the_frontier_session_and_the_wallet_paths_never_act_for_an_nft_citizen() {
    let _g = begin();
    let w = World::new(7);
    assert_eq!(w.join(A, 0), Ok(()));
    // ResidentAct(SetSession) by the current owner: refused (an NFT
    // resident's session lives in the resident program only).
    let mut a = vec![
        w.actor(A, true),
        w.payer.clone(),
        w.season_ai.clone(),
        w.citizen.clone(),
    ];
    a.extend(w.proof());
    let mut d = vec![wire::RESIDENT_ACT];
    d.extend_from_slice(&0u32.to_le_bytes());
    d.push(frontier_abi::v2::Ix::SetSession.tag());
    d.extend_from_slice(&SESSION);
    d.extend_from_slice(&i64::MAX.to_le_bytes());
    assert_eq!(run(&a, &d), Err(crate::FrontierError::Auth as u32));
    // The plain wallet SetVigil on the NFT Citizen, by the owner A: the
    // Citizen is not at A's wallet address, so the wallet prologue refuses.
    let plain = [
        w.actor(A, true),
        w.payer.clone(),
        w.season_ai.clone(),
        w.citizen.clone(),
    ];
    let mut v = vec![frontier_abi::v2::Ix::SetVigil.tag()];
    v.extend_from_slice(&600u16.to_le_bytes());
    assert!(run(&plain, &v).is_err());
    // The same by the all-zero wallet (the NFT Citizen's WALLET field): an
    // unsigned zero key is refused too.
    let zero = [
        w.actor([0; 32], false),
        w.payer.clone(),
        w.season_ai.clone(),
        w.citizen.clone(),
    ];
    assert!(run(&zero, &v).is_err());
}
