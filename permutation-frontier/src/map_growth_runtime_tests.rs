//! Key-free host harness of the dispersed first home (map growth): the
//! program's real `dispatch` runs PlaceHome (0x38) and ReleaseDormant
//! (0x35) over hand-built accounts of a season with `placement` 1
//! (dispersed) and `heartland_max_ring` 3, on a heartland province whose
//! nation is **not** its wedge. It checks the JoinShard accounting
//! (`holdings`, `holdings_by_wedge[province wedge]`, `released`) up on the
//! placement and down on the release, the lifetime grant, the records
//! logged, and the refusals the program raises.
//!
//! Separate from `resident_runtime_tests` (the NFT harness, built only
//! under `nft-experimental`) so a run can be filtered to exactly
//! `map_growth_runtime_tests::` and audited.
//!
//! **Contains public-address derivation; do not run under the no-PDA rule.**
//! Wallets and payer addresses are literal bytes, but setup derives the
//! Season PDA (`find_program_address`), and `AddrCtx` computes with-seed
//! addresses. CPI emulation also calls `create_program_address`.
//! No private keypair or cryptographic signature is created. This does not
//! make the harness permitted when PDA/with-seed derivation is prohibited.
//!
//! **Limits (what this does not show).**
//! - Signatures: `is_signer` is set by the test, as the runtime would after
//!   verifying a signature; no signature is verified (the same limit as a
//!   LiteSVM run with `sigverify` off).
//! - The SBF build: this is the host build of the same source (no compute
//!   budget, no loader, no account-size or ownership enforcement by a
//!   runtime).
//! - CPI: the System program's Transfer, Allocate, Assign and
//!   AllocateWithSeed are emulated by [`Stubs`] (lamports, size, owner and
//!   the signer seeds or the with-seed address checked as the runtime
//!   would); nothing else may be invoked.
//! - No rollback: a refused instruction keeps whatever it wrote before the
//!   refusal (on chain the transaction reverts). Every refusal exercised
//!   here is raised before any write other than the player bucket.
//! - The accounts are written as bytes in the states earlier instructions
//!   leave (a Running Season, a Frontier with rings 0–3 open, a Province
//!   with four free sites, a joined Citizen): OpenRing, OpenProvince, Join
//!   and FoldOccupancy are not run, so the Frontier's folded counters are
//!   not exercised.
//! - Clock and Rent: `prologue::set_test_clock` and the default rent
//!   (`init::rent` under `cfg(test)`).
//! - The syscall stubs and the log capture are process-global. The tests
//!   of this module serialise among themselves; when another harness is in
//!   the same test binary (`resident_runtime_tests` under
//!   `nft-experimental`) run with `--test-threads=1`.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use frontier_abi::ix as aix;
use frontier_abi::log::Kind;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::log::{decode as decode_record, AnyKind, EntityKind};
use frontier_abi::v2::presets::{
    ConquestParams, FRONTIER_7, PLACEMENT_DISPERSED, SEASON_CQ_OFFSET,
};
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::geometry::{
    home_nation, region_of, ring_provinces, ProvinceCoord,
};
use solana_program::{
    account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::addr::{citizen_tag, citizen_tag15, join_shard_of, AddrCtx};
use crate::layout::player::holding_ref as HR;
use crate::layout::{
    citizen as C, citizen2 as C2, frontier as FR, holding as H, join_shard as JS, province as PV,
    season as S, site as SM, Ro,
};
use crate::FrontierError as E;

/// One test at a time: the syscall stubs and the log capture are global.
static SERIAL: Mutex<()> = Mutex::new(());

/// Backing memory of every account created by a test: key → (data pointer,
/// capacity, owner pointer). The stub resizes and reassigns through it.
type Memory = HashMap<[u8; 32], (usize, usize, usize)>;
static MEMORY: Mutex<Option<Memory>> = Mutex::new(None);
/// The PS2 records the program logged (`sol_log_data`).
static LOGS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

const SYSTEM: [u8; 32] = crate::addr::ids::SYSTEM_PROGRAM;
/// Literal addresses (no key behind any of them).
const PROGRAM: [u8; 32] = [0x12; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const ANYONE: [u8; 32] = [0xe5; 32];
const WALLET_A: [u8; 32] = [0xa1; 32];
const WALLET_B: [u8; 32] = [0xb2; 32];
const WALLET_S: [u8; 32] = [0xc3; 32];
/// The season's GENESIS_SEED (a literal; the dispersed placement derives
/// each ring's nation offset from it).
const GENESIS_SEED: [u8; 32] = [0x5e; 32];
const GENESIS: i64 = 1_800_000_000;
const SEASON_ID: u64 = 11;
const R_MAX: u16 = 8;
const HMR: u8 = 3;
/// Rings 0–3 open (the heartland rings 2 and 3 among them).
const RINGS_OPENED: u16 = 4;
const SITE_COUNT: u8 = 4;
const SITE_TILES: [u8; 4] = [10, 20, 30, 40];
const BIG: u64 = 10_000_000_000;

/// Bytes kept before every data slice: `AccountInfo::resize` (the close of
/// a Holding) writes the new length as a u64 at `data_ptr − 8`, the
/// runtime's serialized layout.
const DATA_PAD: usize = 8;
/// Bytes kept before every key: `AccountInfo::resize` reads the original
/// data length as a u32 at `key_ptr − 4`.
const KEY_PAD: usize = 4;

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
        // A signer the runtime would accept: a signer of the outer
        // instruction, or the PDA of the caller's seeds.
        let signed = |k: &Pubkey| -> bool {
            find(k).is_some_and(|a| a.is_signer)
                || seeds.iter().any(|s| {
                    Pubkey::create_program_address(s, &Pubkey::new_from_array(PROGRAM))
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
    // SAFETY: `ptr` is the data start of a leaked buffer of `DATA_PAD + cap`
    // zeroed bytes made for this account by `leak`; no other slice of it is
    // alive (the account's data slice is empty).
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
    // SAFETY: `op` is the leaked owner cell `leak` made for this account;
    // the runtime's own `AccountInfo::assign` writes it the same way.
    unsafe { std::ptr::write_volatile(op as *mut Pubkey, Pubkey::new_from_array(owner)) };
    Ok(())
}

// ------------------------------------------------------------------ accounts

/// One account's leaked parts (the test's lifetime is the process's).
struct Parts {
    key: &'static Pubkey,
    lamports: &'static mut u64,
    data: &'static mut [u8],
    owner: &'static Pubkey,
}

/// Leaks an account: its key behind [`KEY_PAD`] bytes holding the original
/// data length, its data behind [`DATA_PAD`] bytes holding the length, so
/// the runtime's `AccountInfo::resize` (which the program calls when it
/// closes a Holding) reads and writes memory this test owns.
fn leak(key: [u8; 32], owner: [u8; 32], data: Vec<u8>, cap: usize, lamports: u64) -> Parts {
    let len = data.len();
    let cap = cap.max(len);
    let mut kb = vec![0u8; KEY_PAD + 32];
    kb[..KEY_PAD].copy_from_slice(&(len as u32).to_le_bytes());
    kb[KEY_PAD..].copy_from_slice(&key);
    let kb: &'static mut [u8] = Box::leak(kb.into_boxed_slice());
    // SAFETY: a Pubkey is 32 bytes of alignment 1; the block is leaked and
    // never written again.
    let key_ref: &'static Pubkey = unsafe { &*(kb.as_ptr().add(KEY_PAD) as *const Pubkey) };
    let owner_cell: &'static mut Pubkey = Box::leak(Box::new(Pubkey::new_from_array(owner)));
    let owner_ptr = owner_cell as *mut Pubkey as usize;
    let mut buf = vec![0u8; DATA_PAD + cap];
    buf[..DATA_PAD].copy_from_slice(&(len as u64).to_le_bytes());
    buf[DATA_PAD..DATA_PAD + len].copy_from_slice(&data);
    let buf: &'static mut [u8] = Box::leak(buf.into_boxed_slice());
    // SAFETY: `DATA_PAD ≤ buf.len()`.
    let base = unsafe { buf.as_mut_ptr().add(DATA_PAD) } as usize;
    MEMORY
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(key, (base, cap, owner_ptr));
    Parts {
        key: key_ref,
        lamports: Box::leak(Box::new(lamports)),
        data: &mut buf[DATA_PAD..DATA_PAD + len],
        owner: owner_cell,
    }
}

fn info(p: Parts, signer: bool, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(p.key, signer, writable, p.lamports, p.data, p.owner, false)
}

/// A wallet account (no data) at a literal address.
fn wallet(key: [u8; 32], signer: bool, writable: bool, lamports: u64) -> AccountInfo<'static> {
    info(leak(key, SYSTEM, vec![], 0, lamports), signer, writable)
}

fn put(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

fn rd_u16(d: &[u8], o: usize) -> u16 {
    Ro(d).u16(o).unwrap()
}
fn rd_u32(d: &[u8], o: usize) -> u32 {
    Ro(d).u32(o).unwrap()
}
fn rd_i16(d: &[u8], o: usize) -> i16 {
    Ro(d).i16(o).unwrap()
}
fn rd_i64(d: &[u8], o: usize) -> i64 {
    Ro(d).i64(o).unwrap()
}

/// The Season PDA's bump, found as AnnounceSeason finds it (an address
/// derivation by hashing; the System program only accepts an off-curve
/// signer address).
fn season_bump(id: u64) -> u8 {
    Pubkey::find_program_address(
        &[crate::addr::SEASON_PREFIX, &crate::addr::season_seed_id(id)],
        &Pubkey::new_from_array(PROGRAM),
    )
    .1
}

/// The season's conquest block: Frontier-7 with the dispersed placement.
fn conquest() -> ConquestParams {
    let mut cq = FRONTIER_7;
    cq.placement = PLACEMENT_DISPERSED;
    cq.heartland_max_ring = HMR;
    cq
}

/// A Running S1 Season of this program, as CreateSeason and
/// ConsumeGenesisSeed leave it.
fn season_bytes(bump: u8, cq: &ConquestParams) -> Vec<u8> {
    let mut d = vec![0u8; K2::Season.size()];
    assert!(write_header(&mut d, K2::Season, SEASON_ID));
    d[S::STATUS] = S::STATUS_RUNNING;
    d[S::BUMP] = bump;
    put(&mut d, S::R_MAX, &R_MAX.to_le_bytes());
    put(&mut d, S::RULESET_HASH, &crate::RULESET_HASH);
    put(
        &mut d,
        S::PROGRAM_VERSION,
        &crate::PROGRAM_VERSION.to_le_bytes(),
    );
    put(&mut d, S::GENESIS_TS, &GENESIS.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &100_000u32.to_le_bytes());
    put(&mut d, S::END_BELL, &200_000u32.to_le_bytes());
    put(&mut d, S::BUCKET_RATE_PER_H, &60u16.to_le_bytes());
    put(&mut d, S::BUCKET_BURST, &20u16.to_le_bytes());
    put(&mut d, S::GENESIS_SEED, &GENESIS_SEED);
    put(
        &mut d,
        S::DORMANT_AFTER_SECS,
        &cq.dormant_after_secs.to_le_bytes(),
    );
    put(
        &mut d,
        S::RELEASE_AFTER_SECS,
        &cq.release_after_secs.to_le_bytes(),
    );
    put(&mut d, SEASON_CQ_OFFSET, &cq.to_bytes());
    d
}

/// A Frontier with rings 0–3 open.
fn frontier_bytes() -> Vec<u8> {
    let mut d = vec![0u8; K2::Frontier.size()];
    assert!(write_header(&mut d, K2::Frontier, SEASON_ID));
    put(&mut d, FR::RINGS_OPENED, &RINGS_OPENED.to_le_bytes());
    put(&mut d, FR::OPEN_SITES, &100u32.to_le_bytes());
    d
}

fn shard_bytes(faction: u8, shard: u8) -> Vec<u8> {
    let mut d = vec![0u8; K2::JoinShard.size()];
    assert!(write_header(&mut d, K2::JoinShard, SEASON_ID));
    d[JS::FACTION] = faction;
    d[JS::SHARD] = shard;
    put(&mut d, JS::MEMBERS, &1u32.to_le_bytes());
    d
}

fn dpool_bytes() -> Vec<u8> {
    let mut d = vec![0u8; K2::DefencePool.size()];
    assert!(write_header(&mut d, K2::DefencePool, SEASON_ID));
    d
}

/// A joined Citizen with a full action bucket, no ticket and no holding.
fn citizen_bytes(key: &[u8; 32], wallet: &[u8; 32], faction: u8, shard: u8) -> Vec<u8> {
    let mut d = vec![0u8; K2::Citizen.size()];
    assert!(write_header(&mut d, K2::Citizen, SEASON_ID));
    put(&mut d, C::WALLET, wallet);
    d[C::FACTION] = faction;
    d[C::FLAGS] = C::FLAG_JOINED;
    d[C::EXPLORES_FLOOR_LEFT] = C::EXPLORES_FLOOR;
    d[C::JOIN_SHARD] = shard;
    put(&mut d, C::BUCKET_MILLI, &20_000u32.to_le_bytes());
    put(&mut d, C::TICKET_BELL, &C::NO_TICKET.to_le_bytes());
    put(&mut d, C::CITIZEN_TAG, &citizen_tag(key).to_le_bytes());
    put(&mut d, C::RENT_PAYER, &PAYER);
    for slot in 1..=3u8 {
        d[C2::holding_of_slot(slot) + HR::GEN] = C2::EMPTY_GEN;
    }
    d
}

/// An opened conquest Province with four free sites, no cohorts and zero
/// conquest records.
fn province_bytes(c: ProvinceCoord) -> Vec<u8> {
    let mut d = vec![0u8; K2::Province.size()];
    assert!(write_header(&mut d, K2::Province, SEASON_ID));
    put(&mut d, PV::P, &(c.p as i16).to_le_bytes());
    put(&mut d, PV::Q, &(c.q as i16).to_le_bytes());
    put(&mut d, PV::RING, &(c.ring() as u16).to_le_bytes());
    d[PV::WEDGE] = c.wedge().unwrap_or(6);
    d[PV::REGION] = region_of(c);
    put(&mut d, PV::SITES, &SITE_TILES);
    d[PV::SITE_COUNT] = SITE_COUNT;
    d
}

/// A Holding's record key `le32(P) ‖ le32(Q) ‖ site`.
fn site_key(c: ProvinceCoord, site: u8) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[..4].copy_from_slice(&c.p.to_le_bytes());
    k[4..8].copy_from_slice(&c.q.to_le_bytes());
    k[8] = site;
    k
}

fn heartland() -> Vec<ProvinceCoord> {
    (2..=HMR as u32).flat_map(ring_provinces).collect()
}

fn nation_of(c: ProvinceCoord) -> u8 {
    home_nation(c, PLACEMENT_DISPERSED, HMR, &GENESIS_SEED).expect("not the Concord")
}

/// The first heartland province the dispersed placement assigns to a nation
/// other than its wedge, with that nation.
fn off_wedge_province() -> (ProvinceCoord, u8) {
    heartland()
        .into_iter()
        .find(|c| c.wedge() != Some(nation_of(*c)))
        .map(|c| (c, nation_of(c)))
        .expect("the dispersed placement puts some nation off its wedge")
}

// ------------------------------------------------------------------ world

/// A citizen of the world: its wallet (a literal), nation and JoinShard.
struct Member {
    wallet: [u8; 32],
    faction: u8,
    shard_i: u8,
    key: [u8; 32],
    citizen: AccountInfo<'static>,
}

struct World {
    ctx: AddrCtx,
    cq: ConquestParams,
    season: AccountInfo<'static>,
    frontier: AccountInfo<'static>,
    dpool: AccountInfo<'static>,
    payer: AccountInfo<'static>,
    system: AccountInfo<'static>,
    provinces: HashMap<(i32, i32), AccountInfo<'static>>,
    shards: HashMap<(u8, u8), AccountInfo<'static>>,
    holdings: HashMap<(i32, i32, u8), AccountInfo<'static>>,
}

impl World {
    fn new() -> World {
        let bump = season_bump(SEASON_ID);
        let season = crate::addr::season_pda(SEASON_ID, bump, &PROGRAM);
        let ctx = crate::addr::ctx(&season, &PROGRAM);
        let cq = conquest();
        World {
            ctx,
            cq,
            season: info(
                leak(season, PROGRAM, season_bytes(bump, &cq), 0, BIG),
                false,
                false,
            ),
            frontier: info(
                leak(ctx.frontier(), PROGRAM, frontier_bytes(), 0, BIG),
                false,
                false,
            ),
            dpool: info(
                leak(ctx.defence_pool(), PROGRAM, dpool_bytes(), 0, BIG),
                false,
                true,
            ),
            payer: wallet(PAYER, true, true, BIG),
            system: info(leak(SYSTEM, [0; 32], vec![], 0, 1), false, false),
            provinces: HashMap::new(),
            shards: HashMap::new(),
            holdings: HashMap::new(),
        }
    }

    /// The Province of `c` (created on first use, at its canonical address).
    fn province(&mut self, c: ProvinceCoord) -> AccountInfo<'static> {
        let key = self.ctx.province(c.p, c.q);
        self.provinces
            .entry((c.p, c.q))
            .or_insert_with(|| info(leak(key, PROGRAM, province_bytes(c), 0, BIG), false, true))
            .clone()
    }

    fn shard(&mut self, faction: u8, shard: u8) -> AccountInfo<'static> {
        let key = self.ctx.join_shard(faction, shard);
        self.shards
            .entry((faction, shard))
            .or_insert_with(|| {
                info(
                    leak(key, PROGRAM, shard_bytes(faction, shard), 0, BIG),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The Holding of `(c, site)`: absent (System-owned, no data) until the
    /// program creates it; room for its full size.
    fn holding(&mut self, c: ProvinceCoord, site: u8) -> AccountInfo<'static> {
        let key = self.ctx.holding(c.p, c.q, site);
        self.holdings
            .entry((c.p, c.q, site))
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], H::SIZE, 0), false, true))
            .clone()
    }

    /// A joined citizen of `faction` with the literal `wallet`.
    fn member(&mut self, wallet: [u8; 32], faction: u8) -> Member {
        let shard_i = join_shard_of(&wallet);
        let key = self.ctx.citizen_by_tag15(&citizen_tag15(&wallet));
        let d = citizen_bytes(&key, &wallet, faction, shard_i);
        self.shard(faction, shard_i);
        Member {
            wallet,
            faction,
            shard_i,
            key,
            citizen: info(leak(key, PROGRAM, d, 0, BIG), false, true),
        }
    }

    /// PlaceHome(P, Q, site) by the member's wallet, the payer funding it.
    fn place_home(&mut self, m: &Member, c: ProvinceCoord, site: u8) -> Result<(), u32> {
        let province = self.province(c);
        let holding = self.holding(c, site);
        let shard = self.shard(m.faction, m.shard_i);
        let a = [
            wallet(m.wallet, true, false, 0),
            self.payer.clone(),
            self.season.clone(),
            m.citizen.clone(),
            self.frontier.clone(),
            province,
            holding,
            shard,
            self.system.clone(),
        ];
        let d = aix::PlaceHome {
            p: c.p as i16,
            q: c.q as i16,
            site,
        }
        .to_bytes();
        run(&a, &d)
    }

    /// ReleaseDormant of the member's holding at `(c, site)`, called by
    /// anyone, the rent going to `rent_payer`.
    fn release(
        &mut self,
        m: &Member,
        c: ProvinceCoord,
        site: u8,
        rent_payer: AccountInfo<'static>,
    ) -> Result<(), u32> {
        let a = [
            wallet(ANYONE, true, false, 0),
            self.season.clone(),
            self.holding(c, site),
            self.province(c),
            m.citizen.clone(),
            self.shard(m.faction, m.shard_i),
            rent_payer,
            self.dpool.clone(),
        ];
        run(&a, &aix::ReleaseDormant {}.to_bytes())
    }

    /// The member's JoinShard counters `(holdings, holdings_by_wedge, released)`.
    fn shard_counts(&mut self, m: &Member) -> (u32, [u32; 6], u32) {
        let s = self.shard(m.faction, m.shard_i);
        let d = s.try_borrow_data().unwrap().to_vec();
        let mut by = [0u32; 6];
        for (i, x) in by.iter_mut().enumerate() {
            *x = rd_u32(&d, JS::HOLDINGS_BY_WEDGE + 4 * i);
        }
        (rd_u32(&d, JS::HOLDINGS), by, rd_u32(&d, JS::RELEASED))
    }

    fn citizen_data(&self, m: &Member) -> Vec<u8> {
        m.citizen.try_borrow_data().unwrap().to_vec()
    }

    fn province_data(&mut self, c: ProvinceCoord) -> Vec<u8> {
        self.province(c).try_borrow_data().unwrap().to_vec()
    }

    fn holding_data(&mut self, c: ProvinceCoord, site: u8) -> Vec<u8> {
        self.holding(c, site).try_borrow_data().unwrap().to_vec()
    }
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
/// one bell after genesis.
fn begin() -> MutexGuard<'static, ()> {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    solana_program::program_stubs::set_syscall_stubs(Box::new(Stubs));
    LOGS.lock().unwrap().clear();
    at_day(0);
    g
}

/// The clock `day` days (and one bell) after genesis; returns the time.
fn at_day(day: i64) -> i64 {
    let ts = GENESIS + 600 + day * 86_400;
    crate::prologue::set_test_clock(ts, 1_000 + day as u64);
    ts
}

fn records() -> Vec<Vec<u8>> {
    std::mem::take(&mut *LOGS.lock().unwrap())
}

// ------------------------------------------------------------------ tests

/// A dispersed first home on a province of another wedge: the Holding,
/// the Citizen, the Province mirror, the JoinShard (`holdings` + 1 and
/// `holdings_by_wedge[province wedge]` + 1, the nation's index untouched)
/// and the HOME_PLACED record, as PlaceHome leaves them.
#[test]
fn map_growth_dispersed_home_lands_off_its_wedge_and_counts_under_the_provinces_wedge() {
    let _g = begin();
    let now = GENESIS + 600;
    let mut w = World::new();
    let (c, nation) = off_wedge_province();
    let wedge = c.wedge().unwrap() as usize;
    assert_ne!(nation as usize, wedge, "the home is off its nation's wedge");
    let a = w.member(WALLET_A, nation);
    let payer_before = w.payer.lamports();
    let (h0, by0, _) = w.shard_counts(&a);
    assert_eq!((h0, by0), (0, [0; 6]));

    assert_eq!(w.place_home(&a, c, 0), Ok(()));

    // The Holding: created at its canonical address, final, the citizen's.
    let h = w.holding(c, 0);
    assert_eq!(*h.owner, Pubkey::new_from_array(PROGRAM));
    let hd = w.holding_data(c, 0);
    assert_eq!(hd.len(), H::SIZE);
    assert_eq!(hd[H::STATE], H::STATE_FINAL);
    assert_eq!(hd[H::ORDER], 1);
    assert_eq!(hd[H::GEN], 1);
    assert_eq!(hd[H::TILE], SITE_TILES[0]);
    assert_eq!(hd[H::FACTION], nation);
    assert_eq!(hd[H::FLAGS], H::FLAG_INTRO_BUILD_AVAILABLE);
    assert_eq!(&hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], &a.key);
    assert_eq!(&hd[H::RENT_PAYER..H::RENT_PAYER + 32], &PAYER);
    assert_eq!(rd_i64(&hd, H::FINAL_TS), now);
    assert_eq!(rd_i64(&hd, H::FOUNDED_TS), now);
    assert_eq!(rd_u32(&hd, H::TICKET_BELL), C::NO_TICKET);
    assert_eq!(
        rd_i64(&hd, H::SHIELD_UNTIL),
        now + w.cq.shield_secs as i64,
        "the season's first-holding shield"
    );
    // The sponsor paid exactly the Holding's rent.
    assert_eq!(
        w.payer.lamports(),
        payer_before - crate::init::rent(H::SIZE).unwrap()
    );
    assert_eq!(h.lamports(), crate::init::rent(H::SIZE).unwrap());

    // The Citizen: the lifetime grant and the final first holding in slot 1.
    let cd = w.citizen_data(&a);
    assert_eq!(
        cd[C::FLAGS],
        C::FLAG_JOINED | C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL
    );
    assert_eq!(cd[C::HOLDINGS_N], 1);
    let o = C2::holding_of_slot(1);
    assert_eq!(
        (
            rd_i16(&cd, o + HR::P),
            rd_i16(&cd, o + HR::Q),
            cd[o + HR::SITE],
            cd[o + HR::GEN]
        ),
        (c.p as i16, c.q as i16, 0, 1)
    );
    assert_eq!(rd_u32(&cd, C::TICKET_BELL), C::NO_TICKET);

    // The Province mirror.
    let pd = w.province_data(c);
    let so = PV::site(0);
    assert_eq!(pd[so + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[so + SM::FACTION], nation);
    assert_eq!(pd[so + SM::ORDER], 1);
    assert_eq!(pd[so + SM::GEN], 1);
    assert_eq!(pd[PV::N_SITES_USED], 1);
    assert_eq!(rd_u32(&pd, PV::ROSTER_EPOCH), 1);

    // The JoinShard: counted under the province's wedge, never the nation.
    let (h1, by1, released) = w.shard_counts(&a);
    assert_eq!(h1, 1);
    for x in 0..6 {
        assert_eq!(by1[x], u32::from(x == wedge), "wedge counter {x}");
    }
    assert_eq!(by1[nation as usize], 0, "the nation's index is untouched");
    assert_eq!(released, 0);

    // One HOME_PLACED record, keyed by the site, chaining the four accounts.
    let recs = records();
    assert_eq!(recs.len(), 1);
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.kind, AnyKind::V1(Kind::HOME_PLACED));
    assert_eq!(r.bell, 1);
    assert_eq!(r.key, &site_key(c, 0)[..]);
    assert_eq!(&r.payload[..8], &citizen_tag(&a.key).to_le_bytes());
    assert_eq!(r.payload[8], 1, "gen");
    assert_eq!(&r.payload[9..17], &now.to_le_bytes(), "final_ts");
    assert_eq!(&r.payload[17..49], &PAYER, "funder");
    assert_eq!(r.n_links, 4);
    let ents: Vec<u8> = r
        .links
        .iter()
        .take(r.n_links)
        .flatten()
        .map(|l| l.entity as u8)
        .collect();
    assert_eq!(
        ents,
        [
            EntityKind::JoinShard as u8,
            EntityKind::Citizen as u8,
            EntityKind::Holding as u8,
            EntityKind::Province as u8
        ]
    );
}

/// The refusals of the dispersed placement: another nation's province
/// (even in the stranger's own wedge), a ring outside the heartland, a
/// taken site, and a second home for a citizen already granted one.
#[test]
fn map_growth_dispersed_placement_refuses_a_stranger_a_taken_site_and_a_second_grant() {
    let _g = begin();
    let mut w = World::new();
    let (c, nation) = off_wedge_province();
    let wedge = c.wedge().unwrap() as usize;
    let other = (nation + 1) % 6;
    let stranger = w.member(WALLET_S, other);

    // Another nation's assigned province: BadData (the nation rule).
    assert_eq!(w.place_home(&stranger, c, 0), Err(E::BadData as u32));
    // ...even one lying in the stranger's own wedge (the wedge rule would
    // have allowed it: the dispersed placement does not).
    let own_wedge_foreign = heartland()
        .into_iter()
        .find(|x| x.wedge() == Some(other) && nation_of(*x) != other)
        .expect("a province of the stranger's wedge assigned to another nation");
    assert_eq!(
        w.place_home(&stranger, own_wedge_foreign, 0),
        Err(E::BadData as u32)
    );
    // Outside the heartland (ring 4) and inside the Seats (ring 1): ReservedSite.
    assert_eq!(
        w.place_home(&stranger, ProvinceCoord::new(4, 0), 0),
        Err(E::ReservedSite as u32)
    );
    assert_eq!(
        w.place_home(&stranger, ProvinceCoord::new(1, 0), 0),
        Err(E::ReservedSite as u32)
    );
    assert!(records().is_empty(), "a refusal logs nothing");
    let (hs, bys, _) = w.shard_counts(&stranger);
    assert_eq!((hs, bys), (0, [0; 6]), "a refusal counts nothing");

    // Two members of the nation: the first takes site 0, the second cannot
    // take it (TicketState) but takes site 1; the first is granted once.
    let a = w.member(WALLET_A, nation);
    let b = w.member(WALLET_B, nation);
    assert_eq!(w.place_home(&a, c, 0), Ok(()));
    assert_eq!(w.place_home(&b, c, 0), Err(E::TicketState as u32));
    assert_eq!(w.place_home(&b, c, 1), Ok(()));
    assert_eq!(w.place_home(&a, c, 2), Err(E::AlreadyDone as u32));
    assert_eq!(records().len(), 2, "two homes, two HOME_PLACED");
    let pd = w.province_data(c);
    assert_eq!(pd[PV::site(0) + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[PV::site(1) + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[PV::site(2) + SM::STATE], SM::STATE_FREE);
    assert_eq!(pd[PV::N_SITES_USED], 2);
    // Each home counted once under the province's wedge in its member's shard.
    let same_shard = a.shard_i == b.shard_i;
    let want = if same_shard { 2 } else { 1 };
    for m in [&a, &b] {
        let (h, by, _) = w.shard_counts(m);
        assert_eq!(h, want);
        assert_eq!(by[wedge], want);
        assert_eq!(by[nation as usize], 0, "the nation's index is untouched");
    }
}

/// ReleaseDormant of a dispersed home: the same JoinShard index PlaceHome
/// bumped goes back down (`holdings` − 1, `holdings_by_wedge[province
/// wedge]` − 1, `released` + 1), the site is released-free at its
/// generation, the Holding closes to its rent payer, the citizen becomes a
/// refugee who may file a ticket again, and the lifetime grant stays
/// consumed. Before `release_after` the release is `NotDormant`; a wrong
/// rent payer is `BadAddress`.
#[test]
fn map_growth_release_dormant_undoes_the_wedge_counter_and_keeps_the_lifetime_grant() {
    let _g = begin();
    let mut w = World::new();
    let (c, nation) = off_wedge_province();
    let wedge = c.wedge().unwrap() as usize;
    let a = w.member(WALLET_A, nation);
    assert_eq!(w.place_home(&a, c, 0), Ok(()));
    records();
    let holding_lamports = w.holding(c, 0).lamports();
    assert_eq!(holding_lamports, crate::init::rent(H::SIZE).unwrap());
    let payer = w.payer.clone();

    // Not dormant yet: release_after is 7 days from the founding.
    at_day(1);
    assert_eq!(
        w.release(&a, c, 0, payer.clone()),
        Err(E::NotDormant as u32)
    );
    // Dormant: but the rent must go to the Holding's rent payer.
    let now = at_day(8);
    assert_eq!(
        w.release(&a, c, 0, wallet(ANYONE, false, true, BIG)),
        Err(E::BadAddress as u32)
    );
    assert!(records().is_empty(), "a refusal logs nothing");
    let (h0, by0, rel0) = w.shard_counts(&a);
    assert_eq!((h0, by0[wedge], rel0), (1, 1, 0));
    let payer_before = w.payer.lamports();

    assert_eq!(w.release(&a, c, 0, payer.clone()), Ok(()));

    // The Holding closed to its rent payer.
    let h = w.holding(c, 0);
    assert_eq!(h.data_len(), 0);
    assert_eq!(*h.owner, Pubkey::new_from_array(SYSTEM));
    assert_eq!(h.lamports(), 0);
    assert_eq!(w.payer.lamports(), payer_before + holding_lamports);
    // The Citizen: a refugee without its first holding; the grant kept.
    let cd = w.citizen_data(&a);
    assert_eq!(
        cd[C::FLAGS],
        C::FLAG_JOINED | C::FLAG_HOME_GRANTED | C::FLAG_REFUGEE
    );
    assert_eq!(cd[C::HOLDINGS_N], 0);
    assert_eq!(cd[C2::holding_of_slot(1) + HR::GEN], C2::EMPTY_GEN);
    assert_eq!(rd_u32(&cd, C::TICKET_BELL), C::NO_TICKET);
    // The Province: released-free at the same generation.
    let pd = w.province_data(c);
    let so = PV::site(0);
    assert_eq!(pd[so + SM::STATE], SM::STATE_RELEASED_FREE);
    assert_eq!(pd[so + SM::FACTION], NEUTRAL);
    assert_eq!(pd[so + SM::GEN], 1);
    assert_eq!(pd[PV::N_SITES_USED], 0);
    assert_eq!(rd_u32(&pd, PV::ROSTER_EPOCH), 2);
    // The JoinShard: the province's wedge index back to zero, released + 1.
    let (h1, by1, rel1) = w.shard_counts(&a);
    assert_eq!(h1, 0);
    assert_eq!(by1, [0; 6], "every wedge counter back to zero");
    assert_eq!(rel1, 1);
    // RELEASE (four accounts chained) then CLOSE (the Holding).
    let recs = records();
    assert_eq!(recs.len(), 2);
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.kind, AnyKind::V1(Kind::RELEASE));
    assert_eq!(r.bell as i64, (now - GENESIS) / 600);
    assert_eq!(r.key, &site_key(c, 0)[..]);
    assert_eq!(&r.payload[..8], &citizen_tag(&a.key).to_le_bytes());
    assert_eq!(r.n_links, 4);
    let cl = decode_record(&recs[1]).unwrap();
    assert_eq!(cl.kind, AnyKind::V1(Kind::CLOSE));
    assert_eq!(cl.n_links, 1);
    assert_eq!(
        cl.links[0].as_ref().map(|l| l.entity as u8),
        Some(EntityKind::Holding as u8)
    );
    assert_eq!(&cl.payload[40..72], &PAYER, "recipient");
    assert_eq!(&cl.payload[72..80], &holding_lamports.to_le_bytes());

    // The grant was consumed for life: no second home after the release...
    assert_eq!(w.place_home(&a, c, 1), Err(E::AlreadyDone as u32));
    // ...while FileTicket's entitlement (no first holding, no open ticket)
    // is back, as the legacy path keeps it (not executed here).
    let cd = w.citizen_data(&a);
    assert_eq!(
        cd[C::FLAGS] & (C::FLAG_PROVISIONAL | C::FLAG_FIRST_HOLDING_FINAL),
        0
    );
    assert_eq!(rd_u32(&cd, C::TICKET_BELL), C::NO_TICKET);
    // Nothing else of the season moved.
    assert_eq!(
        rd_u16(&w.frontier.try_borrow_data().unwrap(), FR::RINGS_OPENED),
        RINGS_OPENED
    );
}
