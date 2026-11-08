//! Key-free host harness of map growth: the program's real `dispatch` over
//! hand-built accounts, in two groups of tests.
//!
//! **The dispersed first home** (`map_growth_dispersed_*`,
//! `map_growth_release_*`): PlaceHome (0x38) and ReleaseDormant (0x35) on a
//! season with `placement` 1 (dispersed) and `heartland_max_ring` 3, on a
//! heartland province whose nation is **not** its wedge. They check the
//! JoinShard accounting (`holdings`, `holdings_by_wedge[province wedge]`,
//! `released`) up on the placement and down on the release, the lifetime
//! grant, the records logged, and the refusals the program raises.
//!
//! **The growing map** (`map_growth_expansion_*`): FoldOccupancy (0x23),
//! ExtendFrontier (0xC1), OpenRing (0x20) and OpenProvince (0x22), in the
//! order the keeper would send them, on a season whose `r_max` is 4 and
//! whose `r_max_ceiling` is 17 (the prize tally's last ring). They show the
//! world actually growing: the effective `r_max` rising one ring at a time,
//! a RingSeed created for the new ring, that ring's 30 Provinces created
//! from the wedge funds with terrain, keep, camp and Free City, the funds'
//! and the RingSeed's counters moving, and every record of it; then the
//! waits (a bell since the last opening, the crowding rule θ on the folded
//! values, a fund too low), the idempotency (a second ExtendFrontier,
//! OpenRing or OpenProvince of the same ring or province is `AlreadyDone`),
//! and the bounds that are kept: no ceiling means no growth, a ring past the
//! ceiling is `BadData`, and nothing passes ring 128 (`R_MAX_HARD`).
//!
//! Separate from `resident_runtime_tests` (the NFT harness, built only
//! under `nft-experimental`) so a run can be filtered to exactly
//! `map_growth_runtime_tests::` (or `map_growth_runtime_tests::map_growth_expansion_`
//! for the growth tests alone) and audited.
//!
//! **Public-address derivation only; no key.** Wallets and payer addresses
//! are literal bytes. Setup derives the Season PDA (`find_program_address`:
//! a public hash, the bump AnnounceSeason would store) and `AddrCtx`
//! computes with-seed addresses (sha256); the CPI stub calls
//! `create_program_address` to check the Season's signer seeds. No private
//! keypair is generated or derived and no cryptographic signature is
//! created or verified. A run that forbids even public PDA/with-seed
//! arithmetic cannot use this harness.
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
//! - ConsumeRingSeed (0x21) is **not run**: it verifies a drand quicknet
//!   BLS signature, which the host build cannot (the pairing syscalls are
//!   stubs off chain) and which no test may produce (it would need the
//!   beacon's private key). The growth tests write the two fields
//!   ConsumeRingSeed writes (`RingSeed.seed`, `RingSeed.status = seeded`)
//!   with a literal seed, as that instruction leaves them
//!   ([`World::seed_ring_as_consume_ring_seed_would`]); nothing else of the
//!   RingSeed is touched by the test. This is the one write of the growth
//!   path that is not the program's.
//! - The accounts are written as bytes in the states earlier instructions
//!   leave (a Running Season, a Frontier with its rings open, six
//!   ProvinceFunds, 48 JoinShards, a joined Citizen). The first-home tests
//!   do not run OpenRing, OpenProvince or FoldOccupancy; the growth tests
//!   do, so the Frontier's folded counters are exercised there.
//! - The JoinShard occupancy the growth tests fold (`holdings_by_wedge`) is
//!   written as pre-state; the first-home tests show PlaceHome producing it.
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
use frontier_abi::v2::log::{decode as decode_record, AnyKind, CqKind, EntityKind};
use frontier_abi::v2::presets::{
    ConquestParams, FRONTIER_7, PLACEMENT_DISPERSED, SEASON_CQ_OFFSET,
};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::beacon::{ring_seed_round, BeaconClock};
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::geometry::{
    home_nation, region_of, ring_provinces, ProvinceCoord, R_MAX_HARD,
};
use permutation_rules::frontier::terrain::{free_city_site, generate_province};
use solana_program::{
    account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::addr::{citizen_tag, citizen_tag15, join_shard_of, AddrCtx};
use crate::layout::player::holding_ref as HR;
use crate::layout::{
    citizen as C, citizen2 as C2, frontier as FR, holding as H, join_shard as JS, province as PV,
    province2 as PV2, province_fund as PF, ring_seed as RS, season as S, site as SM, site2 as SM2,
    Ro,
};
use crate::proc::map::{encode_terrain, terrain_digest, TERRAIN_BLOCK};
use crate::FrontierError as E;

/// One test at a time: the syscall stubs and the log capture are global.
static SERIAL: Mutex<()> = Mutex::new(());

// The experimental wide land write path (`wide-world-experimental`) shares
// this harness: its accounts, stubs, clock and serial lock, as a child
// module (`map_growth_runtime_tests::wide_land::`). It adds no account
// kind the deployed program knows and changes nothing above.
#[cfg(feature = "wide-world-experimental")]
#[path = "wide_land_runtime_tests.rs"]
mod wide_land;
// Workstream 09's capacity preview (`capacity-preview`) shares it too:
// `map_growth_runtime_tests::capacity::`.
#[cfg(feature = "capacity-preview")]
#[path = "capacity_runtime_tests.rs"]
mod capacity;

/// Backing memory of every account created by a test: key → (data pointer,
/// capacity, owner pointer). The stub resizes and reassigns through it.
type Memory = HashMap<[u8; 32], (usize, usize, usize)>;
static MEMORY: Mutex<Option<Memory>> = Mutex::new(None);
/// The PS2 records the program logged (`sol_log_data`).
static LOGS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
/// The wide records (`PSW1`, `world_index::event`) the experimental wide
/// handlers logged; never a PS2 record, never read by the deployed tests.
#[cfg(feature = "wide-world-experimental")]
static WIDE_LOGS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

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
/// The drand quicknet clock as CreateSeason stores it (the RingSeed round
/// of a ring beyond the genesis ring is computed from it).
const DRAND_GENESIS: i64 = 1_692_803_367;
const DRAND_PERIOD: u32 = 3;
const SEED_MARGIN: u32 = 60;
/// The crowding rule θ: 60% of a wedge's open sites early, 10% after two
/// days (`theta_switch_secs`). With 100 open sites and 60 first holdings in
/// wedge 0 the early rule holds exactly, so any site the growth adds breaks
/// it until the late rule applies.
const THETA_EARLY_BPS: u16 = 6_000;
const THETA_LATE_BPS: u16 = 1_000;
const THETA_SWITCH_SECS: u32 = 2 * 86_400;
/// Open sites each wedge fund reports before the growth (as rings 0–4's
/// OpenProvince left it), and the first holdings wedge 0's members hold.
const FUND_OPEN_SITES: u32 = 100;
const WEDGE0_HOMES: u32 = 60;
/// The literal seed the growth tests give a requested RingSeed, as
/// ConsumeRingSeed would (see the module doc).
const RING5_SEED: [u8; 32] = [0x5a; 32];
const RING6_SEED: [u8; 32] = [0x6b; 32];

/// How a world's Season and Frontier start: the season's `r_max`, its
/// genesis ring `g`, its growth ceiling (0: none), the rings already opened
/// and the Frontier's `r_max_ext` (0: never extended).
#[derive(Clone, Copy)]
struct Setup {
    r_max: u16,
    genesis_ring: u8,
    ceiling: u16,
    rings_opened: u16,
    r_max_ext: u16,
}

/// The first-home world: `r_max` 8, rings 0–3 open, no growth ceiling (the
/// default of every preset: the map ends at `r_max`).
const HOME: Setup = Setup {
    r_max: R_MAX,
    genesis_ring: 0,
    ceiling: 0,
    rings_opened: RINGS_OPENED,
    r_max_ext: 0,
};

/// The growing world: `r_max` 4 with rings 0–4 open (so the next ring needs
/// an extension), genesis ring 2 (rings 3 and 4 were opened by the
/// crowding rule, ring 5 will be), ceiling 17 (the prize tally's last ring,
/// `permutation_prize::MAX_RING`; InitPool refuses a higher one).
const GROWTH: Setup = Setup {
    r_max: 4,
    genesis_ring: 2,
    ceiling: 17,
    rings_opened: 5,
    r_max_ext: 0,
};

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
        #[cfg(feature = "wide-world-experimental")]
        if fields.len() == 2 && fields[0] == &frontier_abi::world_index::event::WIDE_LOG_PREFIX[..]
        {
            WIDE_LOGS.lock().unwrap().push(fields[1].to_vec());
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

/// The season's conquest block: Frontier-7 with the dispersed placement and
/// the setup's growth ceiling.
fn conquest(setup: &Setup) -> ConquestParams {
    let mut cq = FRONTIER_7;
    cq.placement = PLACEMENT_DISPERSED;
    cq.heartland_max_ring = HMR;
    cq.r_max_ceiling = setup.ceiling;
    cq
}

/// A Running S1 Season of this program, as CreateSeason and
/// ConsumeGenesisSeed leave it.
fn season_bytes(bump: u8, cq: &ConquestParams, setup: &Setup) -> Vec<u8> {
    let mut d = vec![0u8; K2::Season.size()];
    assert!(write_header(&mut d, K2::Season, SEASON_ID));
    d[S::STATUS] = S::STATUS_RUNNING;
    d[S::BUMP] = bump;
    d[S::GENESIS_RING] = setup.genesis_ring;
    put(&mut d, S::R_MAX, &setup.r_max.to_le_bytes());
    put(&mut d, S::RULESET_HASH, &crate::RULESET_HASH);
    put(
        &mut d,
        S::PROGRAM_VERSION,
        &crate::PROGRAM_VERSION.to_le_bytes(),
    );
    put(&mut d, S::GENESIS_TS, &GENESIS.to_le_bytes());
    put(&mut d, S::JOIN_CLOSE_BELL, &100_000u32.to_le_bytes());
    put(&mut d, S::END_BELL, &200_000u32.to_le_bytes());
    put(&mut d, S::DRAND_GENESIS, &DRAND_GENESIS.to_le_bytes());
    put(&mut d, S::DRAND_PERIOD, &DRAND_PERIOD.to_le_bytes());
    put(&mut d, S::SEED_MARGIN, &SEED_MARGIN.to_le_bytes());
    put(&mut d, S::BUCKET_RATE_PER_H, &60u16.to_le_bytes());
    put(&mut d, S::BUCKET_BURST, &20u16.to_le_bytes());
    put(&mut d, S::THETA_EARLY_BPS, &THETA_EARLY_BPS.to_le_bytes());
    put(&mut d, S::THETA_LATE_BPS, &THETA_LATE_BPS.to_le_bytes());
    put(
        &mut d,
        S::THETA_SWITCH_SECS,
        &THETA_SWITCH_SECS.to_le_bytes(),
    );
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

/// A Frontier with the setup's rings open, never folded (every wedge
/// counter zero), `r_max_ext` as the setup says.
fn frontier_bytes(setup: &Setup) -> Vec<u8> {
    let mut d = vec![0u8; K2::Frontier.size()];
    assert!(write_header(&mut d, K2::Frontier, SEASON_ID));
    put(&mut d, FR::RINGS_OPENED, &setup.rings_opened.to_le_bytes());
    put(&mut d, FR::R_MAX_EXT, &setup.r_max_ext.to_le_bytes());
    put(&mut d, FR::OPEN_SITES, &100u32.to_le_bytes());
    d
}

/// A wedge's ProvinceFund as the openings of rings 0–4 left it:
/// `open_sites` 100, nothing else counted (the lamports are the fund).
fn fund_bytes(wedge: u8) -> Vec<u8> {
    let mut d = vec![0u8; K2::ProvinceFund.size()];
    assert!(write_header(&mut d, K2::ProvinceFund, SEASON_ID));
    d[PF::WEDGE] = wedge;
    put(&mut d, PF::OPEN_SITES, &FUND_OPEN_SITES.to_le_bytes());
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
    setup: Setup,
    season: AccountInfo<'static>,
    frontier: AccountInfo<'static>,
    dpool: AccountInfo<'static>,
    payer: AccountInfo<'static>,
    system: AccountInfo<'static>,
    provinces: HashMap<(i32, i32), AccountInfo<'static>>,
    shards: HashMap<(u8, u8), AccountInfo<'static>>,
    holdings: HashMap<(i32, i32, u8), AccountInfo<'static>>,
    funds: HashMap<u8, AccountInfo<'static>>,
    ring_seeds: HashMap<u16, AccountInfo<'static>>,
}

/// The same account with the writability a given instruction's table
/// wants: a clone shares the account's lamports, data and owner (the
/// `AccountInfo` fields are `Rc`s), only the flag differs. The program's
/// account check refuses a program account listed read-only that is
/// writable, so the Frontier, a fund or a shard is handed over with exactly
/// the flag of the position it takes.
fn with_writable(ai: &AccountInfo<'static>, writable: bool) -> AccountInfo<'static> {
    let mut a = ai.clone();
    a.is_writable = writable;
    a
}

impl World {
    fn new() -> World {
        World::with(HOME)
    }

    /// The growing world ([`GROWTH`]).
    fn growing() -> World {
        World::with(GROWTH)
    }

    fn with(setup: Setup) -> World {
        let bump = season_bump(SEASON_ID);
        let season = crate::addr::season_pda(SEASON_ID, bump, &PROGRAM);
        let ctx = crate::addr::ctx(&season, &PROGRAM);
        let cq = conquest(&setup);
        World {
            ctx,
            cq,
            setup,
            season: info(
                leak(season, PROGRAM, season_bytes(bump, &cq, &setup), 0, BIG),
                false,
                false,
            ),
            frontier: info(
                leak(ctx.frontier(), PROGRAM, frontier_bytes(&setup), 0, BIG),
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
            funds: HashMap::new(),
            ring_seeds: HashMap::new(),
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

    /// The Province of `c` as it is before OpenProvince: absent
    /// (System-owned, no data) at its canonical address, with room for the
    /// full v2 size. Once the program creates it, [`World::province`] and
    /// [`World::province_data`] read what the program wrote.
    fn absent_province(&mut self, c: ProvinceCoord) -> AccountInfo<'static> {
        let key = self.ctx.province(c.p, c.q);
        self.provinces
            .entry((c.p, c.q))
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], PV2::SIZE, 0), false, true))
            .clone()
    }

    /// Wedge `w`'s ProvinceFund (created on first use, funded with `BIG`
    /// lamports), read-only as OpenRing lists it.
    fn fund(&mut self, w: u8) -> AccountInfo<'static> {
        let key = self.ctx.province_fund(w);
        self.funds
            .entry(w)
            .or_insert_with(|| info(leak(key, PROGRAM, fund_bytes(w), 0, BIG), false, false))
            .clone()
    }

    /// Ring `d`'s RingSeed: absent until OpenRing creates it, at its
    /// canonical address, with room for its full size.
    fn ring_seed(&mut self, d: u16) -> AccountInfo<'static> {
        let key = self.ctx.ring_seed(d);
        self.ring_seeds
            .entry(d)
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], RS::SIZE, 0), false, true))
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

    // ---------------------------------------------------------- map growth

    fn frontier_data(&self) -> Vec<u8> {
        self.frontier.try_borrow_data().unwrap().to_vec()
    }

    fn ring_seed_data(&mut self, d: u16) -> Vec<u8> {
        self.ring_seed(d).try_borrow_data().unwrap().to_vec()
    }

    fn fund_data(&mut self, w: u8) -> Vec<u8> {
        self.fund(w).try_borrow_data().unwrap().to_vec()
    }

    /// The Frontier's `(rings_opened, r_max_ext, last_ring_open_bell,
    /// wedge_open, wedge_occupied)`.
    fn frontier_state(&self) -> (u16, u16, u32, [u32; 6], [u32; 6]) {
        let d = self.frontier_data();
        let mut open = [0u32; 6];
        let mut occ = [0u32; 6];
        for w in 0..6 {
            open[w] = rd_u32(&d, FR::WEDGE_OPEN + 4 * w);
            occ[w] = rd_u32(&d, FR::WEDGE_OCCUPIED + 4 * w);
        }
        (
            rd_u16(&d, FR::RINGS_OPENED),
            rd_u16(&d, FR::R_MAX_EXT),
            rd_u32(&d, FR::LAST_RING_OPEN_BELL),
            open,
            occ,
        )
    }

    /// Pre-state of a JoinShard: `n` first holdings of its members, all in
    /// `wedge` (what `n` PlaceHomes leave, as the first-home tests show).
    fn set_shard_homes(&mut self, faction: u8, shard: u8, wedge: usize, n: u32) {
        let s = self.shard(faction, shard);
        let mut d = s.try_borrow_mut_data().unwrap();
        put(&mut d, JS::HOLDINGS, &n.to_le_bytes());
        put(&mut d, JS::HOLDINGS_BY_WEDGE + 4 * wedge, &n.to_le_bytes());
    }

    /// ExtendFrontier(d) paid by the payer.
    fn extend_frontier(&mut self, d: u16) -> Result<(), u32> {
        let a = [
            self.payer.clone(),
            self.season.clone(),
            with_writable(&self.frontier, true),
        ];
        run(&a, &frontier_abi::v2::ix::ExtendFrontier { d }.to_bytes())
    }

    /// OpenRing(d) paid by the payer: the six wedge funds read-only, in
    /// wedge order.
    fn open_ring(&mut self, d: u16) -> Result<(), u32> {
        let mut a = vec![
            self.payer.clone(),
            self.season.clone(),
            with_writable(&self.frontier, true),
            self.ring_seed(d),
        ];
        for w in 0..6u8 {
            a.push(with_writable(&self.fund(w), false));
        }
        a.push(self.system.clone());
        run(&a, &aix::OpenRing { d }.to_bytes())
    }

    /// OpenProvince(P, Q) paid by the payer, funded by the wedge's fund.
    fn open_province(&mut self, c: ProvinceCoord) -> Result<(), u32> {
        let ring = c.ring() as u16;
        let wedge = crate::proc::map::fund_wedge(c);
        let a = [
            self.payer.clone(),
            self.season.clone(),
            self.ring_seed(ring),
            with_writable(&self.fund(wedge), true),
            self.absent_province(c),
            self.system.clone(),
        ];
        run(
            &a,
            &aix::OpenProvince {
                p: c.p as i16,
                q: c.q as i16,
            }
            .to_bytes(),
        )
    }

    /// FoldOccupancy(part) by anyone: parts 0 and 1 list the 24 JoinShards
    /// of factions 0–2 and 3–5, part 2 the six funds, all read-only.
    fn fold_part(&mut self, part: u8) -> Result<(), u32> {
        let mut a = vec![
            wallet(ANYONE, true, false, 0),
            self.season.clone(),
            with_writable(&self.frontier, true),
        ];
        match aix::FoldOccupancy::factions_of(part) {
            Some((f0, f1)) => {
                for f in f0..f1 {
                    for s in 0..JS::SHARDS_PER_FACTION {
                        a.push(with_writable(&self.shard(f, s), false));
                    }
                }
            }
            None => {
                for w in 0..6u8 {
                    a.push(with_writable(&self.fund(w), false));
                }
            }
        }
        run(&a, &aix::FoldOccupancy { part }.to_bytes())
    }

    /// A whole fold: the three parts at the current bell.
    fn fold(&mut self) {
        for part in 0..aix::FoldOccupancy::PARTS {
            assert_eq!(self.fold_part(part), Ok(()), "fold part {part}");
        }
    }

    /// The two fields ConsumeRingSeed writes once the beacon round is
    /// verified (`proc::map::consume_ring_seed`): the seed and the status.
    /// Written by the test because the host build cannot verify a quicknet
    /// signature and no test may sign one (module doc). Nothing else of the
    /// RingSeed changes: its round, bell, time and payer stay the program's.
    fn seed_ring_as_consume_ring_seed_would(&mut self, d: u16, seed: &[u8; 32]) {
        let rs = self.ring_seed(d);
        let mut data = rs.try_borrow_mut_data().unwrap();
        assert_eq!(data.len(), RS::SIZE, "a RingSeed the program created");
        assert_eq!(data[RS::STATUS], RS::STATUS_REQUESTED);
        put(&mut data, RS::SEED, seed);
        data[RS::STATUS] = RS::STATUS_SEEDED;
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
    #[cfg(feature = "wide-world-experimental")]
    WIDE_LOGS.lock().unwrap().clear();
    at_day(0);
    g
}

/// The clock `day` days (and one bell) after genesis; returns the time.
fn at_day(day: i64) -> i64 {
    let ts = GENESIS + 600 + day * 86_400;
    crate::prologue::set_test_clock(ts, 1_000 + day as u64);
    ts
}

/// The clock at the start of bell `b`; returns the time.
fn at_bell(b: u32) -> i64 {
    let ts = GENESIS + 600 * b as i64;
    crate::prologue::set_test_clock(ts, 1_000 + b as u64);
    ts
}

/// The decoded records logged since the last take, oldest first.
fn kinds_of(recs: &[Vec<u8>]) -> Vec<AnyKind> {
    recs.iter()
        .map(|r| decode_record(r).unwrap().kind)
        .collect()
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
    for (x, count) in by1.iter().enumerate() {
        assert_eq!(*count, u32::from(x == wedge), "wedge counter {x}");
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

// ------------------------------------------------------------------ growth

/// Ring 5 of the growing world, grown as the keeper would grow it at bell
/// 1: the fold, ExtendFrontier(5), OpenRing(5), the seed (the test's stand-in
/// for ConsumeRingSeed) and the 30 OpenProvinces. Returns the open sites
/// ring 5 added to wedge 0's fund. The records are drained.
fn grow_ring_5(w: &mut World) -> u32 {
    at_bell(1);
    w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
    w.fold();
    assert_eq!(w.extend_frontier(5), Ok(()));
    assert_eq!(w.open_ring(5), Ok(()));
    w.seed_ring_as_consume_ring_seed_would(5, &RING5_SEED);
    let mut sites0 = 0u32;
    for c in ring_provinces(5) {
        assert_eq!(w.open_province(c), Ok(()), "open {},{}", c.p, c.q);
        if crate::proc::map::fund_wedge(c) == 0 {
            sites0 += generate_province(&RING5_SEED, c).site_count as u32;
        }
    }
    records();
    sites0
}

/// The world grows by one ring, through the program: a fold of the
/// occupancy, ExtendFrontier(5) raising the effective `r_max` from 4 to 5
/// (FRONTIER_EXTENDED), OpenRing(5) creating the RingSeed with the beacon
/// round and `rings_opened` 6 (RING_OPEN), then, once the ring is seeded,
/// OpenProvince of each of its 30 provinces from the wedge funds: terrain
/// from the seed, the Free City, the keep, the funds' and the RingSeed's
/// counters, PROVINCE_OPEN with its terrain digest. Before the extension
/// ring 5 is beyond the map (`BadData`); without a fold the crowding rule
/// is not met (`Capacity`); a skipped ring is `TooEarly`; the same
/// extension, ring or province a second time is `AlreadyDone`; a province
/// of an unseeded ring is `SeedNotReady`; past the ceiling is `BadData`.
#[test]
fn map_growth_expansion_extends_the_frontier_opens_the_ring_and_creates_its_provinces() {
    let _g = begin();
    let now = at_bell(1);
    let mut w = World::growing();
    assert_eq!(w.cq.r_max_ceiling, 17, "the prize tally's last ring");
    w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);

    // Before any growth the map ends at r_max 4: ring 5 opens nothing.
    assert_eq!(w.open_ring(5), Err(E::BadData as u32));
    assert_eq!(
        w.open_province(ProvinceCoord::new(5, 0)),
        Err(E::SeedNotReady as u32),
        "inside the ceiling, but ring 5 has no RingSeed"
    );
    assert_eq!(
        w.open_province(ProvinceCoord::new(18, 0)),
        Err(E::BadData as u32),
        "past the ceiling"
    );
    // Never folded: no wedge is at θ occupancy.
    assert_eq!(w.extend_frontier(5), Err(E::Capacity as u32));
    assert!(records().is_empty(), "a refusal logs nothing");
    assert_eq!(w.frontier_state().1, 0);

    // The fold: wedge 0 has 60 of its 100 open sites held (θ early 60%: met exactly).
    w.fold();
    let recs = records();
    assert_eq!(recs.len(), 3);
    assert!(kinds_of(&recs)
        .iter()
        .all(|k| *k == AnyKind::V1(Kind::FOLD)));
    let (ro, ext, last, open, occ) = w.frontier_state();
    assert_eq!((ro, ext, last), (5, 0, 0));
    assert_eq!(open, [FUND_OPEN_SITES; 6]);
    assert_eq!(occ, [WEDGE0_HOMES, 0, 0, 0, 0, 0]);
    assert!(crate::proc::map::ring_occupancy_met(
        &occ,
        &open,
        THETA_EARLY_BPS
    ));

    // ExtendFrontier: one ring at a time (6 skips 5), to 5.
    assert_eq!(w.extend_frontier(6), Err(E::TooEarly as u32));
    assert_eq!(w.extend_frontier(5), Ok(()));
    let (ro, ext, last, ..) = w.frontier_state();
    assert_eq!(
        (ro, ext, last),
        (5, 5, 0),
        "r_max_ext 5, nothing else moved"
    );
    let recs = records();
    assert_eq!(recs.len(), 1);
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.kind, AnyKind::Cq(CqKind::FRONTIER_EXTENDED));
    assert_eq!(r.bell, 1);
    assert_eq!(r.key, &5u16.to_le_bytes()[..]);
    assert_eq!(
        r.payload,
        &[4u16.to_le_bytes(), w.setup.ceiling.to_le_bytes()].concat()[..],
        "(from, ceiling)"
    );
    assert_eq!(r.n_links, 1);
    assert_eq!(
        r.links[0].as_ref().map(|l| l.entity as u8),
        Some(EntityKind::Frontier as u8)
    );
    assert_eq!(w.extend_frontier(5), Err(E::AlreadyDone as u32));
    assert_eq!(
        w.open_ring(6),
        Err(E::BadData as u32),
        "still beyond the map"
    );

    // OpenRing(5): the RingSeed requested from the beacon, rings_opened 6.
    let payer_before = w.payer.lamports();
    assert_eq!(w.open_ring(5), Ok(()));
    let rent_rs = crate::init::rent(RS::SIZE).unwrap();
    let rs = w.ring_seed(5);
    assert_eq!(*rs.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(rs.lamports(), rent_rs);
    assert_eq!(
        w.payer.lamports(),
        payer_before - rent_rs,
        "the payer paid the RingSeed's rent"
    );
    let rd = w.ring_seed_data(5);
    assert_eq!(rd.len(), RS::SIZE);
    assert_eq!(rd_u16(&rd, RS::D), 5);
    assert_eq!(rd[RS::STATUS], RS::STATUS_REQUESTED);
    assert_eq!(rd_u32(&rd, RS::OPENED_BELL), 1);
    assert_eq!(rd_i64(&rd, RS::T_OPEN), now);
    let round = ring_seed_round(
        &BeaconClock {
            genesis: DRAND_GENESIS,
            period: DRAND_PERIOD as i64,
        },
        now,
        SEED_MARGIN,
    );
    assert_eq!(Ro(&rd).u64(RS::ROUND).unwrap(), round);
    assert_eq!(
        &rd[RS::SEED..RS::SEED + 32],
        &[0u8; 32],
        "the seed is on its way"
    );
    assert_eq!(rd_u16(&rd, RS::PROVINCES_CREATED), 0);
    assert_eq!(&rd[RS::PAYER..RS::PAYER + 32], &PAYER);
    let (ro, ext, last, ..) = w.frontier_state();
    assert_eq!((ro, ext, last), (6, 5, 1));
    let recs = records();
    assert_eq!(recs.len(), 1);
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.kind, AnyKind::V1(Kind::RING_OPEN));
    assert_eq!(r.bell, 1);
    assert_eq!(r.key, &5u16.to_le_bytes()[..]);
    assert_eq!(&r.payload[..8], &now.to_le_bytes());
    assert_eq!(&r.payload[8..16], &round.to_le_bytes());
    assert_eq!(&r.payload[16..48], &[0u8; 32]);
    assert_eq!(r.n_links, 1);
    assert_eq!(w.open_ring(5), Err(E::AlreadyDone as u32));
    assert_eq!(w.open_ring(6), Err(E::BadData as u32));
    let c = ProvinceCoord::new(5, 0);
    assert_eq!(
        w.open_province(c),
        Err(E::SeedNotReady as u32),
        "requested, not seeded"
    );
    assert!(records().is_empty());

    // The beacon round consumed (the test's stand-in, module doc).
    w.seed_ring_as_consume_ring_seed_would(5, &RING5_SEED);

    // OpenProvince(5, 0): the province from the wedge fund.
    let wedge = c.wedge().unwrap();
    let rent_pv = crate::init::rent(PV2::SIZE).unwrap();
    let fund_before = w.fund(wedge).lamports();
    let payer_before = w.payer.lamports();
    assert_eq!(w.open_province(c), Ok(()));
    let pv = w.province(c);
    assert_eq!(*pv.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(pv.lamports(), rent_pv);
    assert_eq!(
        w.fund(wedge).lamports(),
        fund_before - rent_pv,
        "the wedge fund paid"
    );
    assert_eq!(w.payer.lamports(), payer_before, "not the payer");
    let pd = w.province_data(c);
    assert_eq!(pd.len(), PV2::SIZE);
    assert_eq!(
        (
            rd_i16(&pd, PV::P),
            rd_i16(&pd, PV::Q),
            rd_u16(&pd, PV::RING)
        ),
        (5, 0, 5)
    );
    assert_eq!(pd[PV::WEDGE], wedge);
    assert_eq!(pd[PV::REGION], region_of(c));
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 1);
    assert_eq!(rd_u32(&pd, PV::OPENED_BELL), 1);
    // The terrain is the kernel's from the ring seed, byte for byte.
    let t = generate_province(&RING5_SEED, c);
    let mut want = vec![0u8; PV2::SIZE];
    encode_terrain(&t, &mut want).unwrap();
    assert_eq!(&pd[TERRAIN_BLOCK], &want[TERRAIN_BLOCK]);
    assert_eq!(pd[PV::SITE_COUNT], t.site_count);
    assert!(t.site_count > 0, "a ring-5 province has sites");
    // The genesis Free City (ring ≥ 4) on its site; the other sites free.
    let fc = free_city_site(&RING5_SEED, c, t.site_count) as usize;
    let fo = PV::site(fc);
    assert_eq!(pd[fo + SM2::STATE], SM2::STATE_FREE_CITY);
    assert_eq!(pd[fo + SM2::FACTION], NEUTRAL);
    assert_eq!(
        rd_u32(&pd, fo + SM2::GARRISON),
        w.cq.free_city_garrison * MILLI as u32
    );
    if let Some(i) = (0..t.site_count as usize).find(|i| *i != fc) {
        assert_eq!(pd[PV::site(i) + SM::STATE], SM::STATE_FREE);
    }
    assert_eq!(pd[PV::N_SITES_USED], 0);
    // The fund's live counters and the RingSeed's count; no Frontier write.
    let fd = w.fund_data(wedge);
    assert_eq!(
        rd_u32(&fd, PF::OPEN_SITES),
        FUND_OPEN_SITES + t.site_count as u32
    );
    assert_eq!(rd_u32(&fd, PF::PROVINCES_OPENED), 1);
    assert_eq!(rd_u32(&fd, PF::PROVINCES_FUNDED), 1);
    assert_eq!(Ro(&fd).u64(PF::SPENT_TOTAL).unwrap(), rent_pv);
    assert_eq!(rd_u16(&w.ring_seed_data(5), RS::PROVINCES_CREATED), 1);
    assert_eq!(w.frontier_state(), (6, 5, 1, open, occ));
    // PROVINCE_OPEN (the Province), then its keep and its Free City.
    let recs = records();
    let kinds = kinds_of(&recs);
    assert_eq!(kinds[0], AnyKind::V1(Kind::PROVINCE_OPEN));
    assert!(kinds[1..]
        .iter()
        .all(|k| *k == AnyKind::Cq(CqKind::KEEP) || *k == AnyKind::Cq(CqKind::NEUTRAL)));
    assert!(
        kinds.contains(&AnyKind::Cq(CqKind::NEUTRAL)),
        "the genesis Free City"
    );
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.bell, 1);
    assert_eq!(r.key, &crate::proc::map::raw_province(5, 0)[..]);
    assert_eq!(&r.payload[..2], &5u16.to_le_bytes());
    assert_eq!(r.payload[2], wedge);
    assert_eq!(r.payload[3], region_of(c));
    assert_eq!(&r.payload[4..36], &terrain_digest(&pd).unwrap());
    assert_eq!(r.payload[36], t.site_count);
    assert_eq!(r.payload[42], 0, "not a reserved ring");
    assert_eq!(r.n_links, 1);
    assert_eq!(
        r.links[0].as_ref().map(|l| l.entity as u8),
        Some(EntityKind::Province as u8)
    );
    assert_eq!(w.open_province(c), Err(E::AlreadyDone as u32));
    assert!(records().is_empty());

    // The rest of ring 5: 30 provinces, five per wedge, each paid once.
    let ring5 = ring_provinces(5);
    assert_eq!(ring5.len(), 30);
    for x in ring5.iter().copied().filter(|x| (x.p, x.q) != (c.p, c.q)) {
        assert_eq!(w.open_province(x), Ok(()), "open {},{}", x.p, x.q);
    }
    assert!(records().len() >= 29, "a PROVINCE_OPEN for each");
    assert_eq!(rd_u16(&w.ring_seed_data(5), RS::PROVINCES_CREATED), 30);
    for wd in 0..6u8 {
        let fd = w.fund_data(wd);
        assert_eq!(rd_u32(&fd, PF::PROVINCES_OPENED), 5, "wedge {wd}");
        assert_eq!(rd_u32(&fd, PF::PROVINCES_FUNDED), 5);
        assert_eq!(Ro(&fd).u64(PF::SPENT_TOTAL).unwrap(), 5 * rent_pv);
        assert_eq!(w.fund(wd).lamports(), BIG - 5 * rent_pv);
    }
    // Ring 6 is still unopened land of the map.
    assert_eq!(
        w.open_province(ProvinceCoord::new(6, 0)),
        Err(E::SeedNotReady as u32)
    );
}

/// Growth repeats under the program's waits: a bell since the last ring
/// opening (`TooEarly`), the crowding rule on the folded values (the sites
/// ring 5 added break θ early: `Capacity`, until the late θ applies), a
/// wedge fund short of the ring's rent (`Insufficient`, nothing created);
/// then ExtendFrontier(6) and OpenRing(6) land, a second of either is
/// `AlreadyDone`, a ring past the effective `r_max` is `BadData`, a ring
/// past the ceiling is `BadData` whatever the state, and the new ring's
/// provinces open once, the old ring's untouched.
#[test]
fn map_growth_expansion_waits_a_bell_and_the_crowding_rule_then_grows_again_within_the_funds() {
    let _g = begin();
    let mut w = World::growing();
    let sites0 = grow_ring_5(&mut w);
    assert!(sites0 > 0, "ring 5 added open sites to wedge 0");
    let rent_pv = crate::init::rent(PV2::SIZE).unwrap();

    // The bell of the opening of ring 5: too early for the next extension.
    assert_eq!(w.extend_frontier(6), Err(E::TooEarly as u32));
    // A bell later: the fold counts ring 5's sites; θ early no longer holds.
    at_bell(2);
    w.fold();
    records();
    let (ro, ext, last, open, occ) = w.frontier_state();
    assert_eq!((ro, ext, last), (6, 5, 1));
    assert_eq!(open[0], FUND_OPEN_SITES + sites0);
    assert_eq!(occ, [WEDGE0_HOMES, 0, 0, 0, 0, 0]);
    assert!(!crate::proc::map::ring_occupancy_met(
        &occ,
        &open,
        THETA_EARLY_BPS
    ));
    assert_eq!(w.extend_frontier(6), Err(E::Capacity as u32));
    assert!(records().is_empty());
    assert_eq!(w.frontier_state().1, 5, "unchanged");

    // Three days in: the late θ (10%) applies; the extension lands.
    let now = at_day(3);
    let bell = ((now - GENESIS) / 600) as u32;
    assert!(crate::proc::map::ring_occupancy_met(
        &occ,
        &open,
        THETA_LATE_BPS
    ));
    assert_eq!(w.extend_frontier(6), Ok(()));
    let recs = records();
    let r = decode_record(&recs[0]).unwrap();
    assert_eq!(r.kind, AnyKind::Cq(CqKind::FRONTIER_EXTENDED));
    assert_eq!(r.bell, bell);
    assert_eq!(r.payload, &[5, 0, 17, 0][..]);
    assert_eq!(w.frontier_state().1, 6);
    assert_eq!(
        w.extend_frontier(7),
        Err(E::TooEarly as u32),
        "ring 6 not opened yet"
    );

    // OpenRing(6) needs every wedge fund to cover six provinces above its rent.
    let need = 6 * rent_pv;
    let floor = crate::init::rent(PF::SIZE).unwrap();
    {
        let f = w.fund(3);
        **f.try_borrow_mut_lamports().unwrap() = floor + need - 1;
    }
    assert_eq!(w.open_ring(6), Err(E::Insufficient as u32));
    assert_eq!(w.ring_seed(6).data_len(), 0, "nothing created");
    assert_eq!(w.frontier_state().0, 6);
    assert!(records().is_empty());
    {
        let f = w.fund(3);
        **f.try_borrow_mut_lamports().unwrap() = floor + need;
    }
    assert_eq!(w.open_ring(6), Ok(()));
    let (ro, ext, last, ..) = w.frontier_state();
    assert_eq!((ro, ext, last), (7, 6, bell));
    let rd = w.ring_seed_data(6);
    assert_eq!(rd[RS::STATUS], RS::STATUS_REQUESTED);
    assert_eq!(rd_u32(&rd, RS::OPENED_BELL), bell);
    assert_eq!(kinds_of(&records()), [AnyKind::V1(Kind::RING_OPEN)]);

    // Idempotent and bounded.
    assert_eq!(w.extend_frontier(6), Err(E::AlreadyDone as u32));
    assert_eq!(w.open_ring(6), Err(E::AlreadyDone as u32));
    assert_eq!(
        w.open_ring(7),
        Err(E::BadData as u32),
        "beyond the effective r_max 6"
    );
    assert_eq!(
        w.extend_frontier(7),
        Err(E::TooEarly as u32),
        "a bell since the opening"
    );
    assert_eq!(
        w.extend_frontier(18),
        Err(E::BadData as u32),
        "past the ceiling 17"
    );
    assert!(records().is_empty());

    // Ring 6 takes its provinces once seeded, each once; ring 5 is untouched.
    w.seed_ring_as_consume_ring_seed_would(6, &RING6_SEED);
    let c6 = ProvinceCoord::new(6, 0);
    assert_eq!(w.open_province(c6), Ok(()));
    assert_eq!(w.open_province(c6), Err(E::AlreadyDone as u32));
    assert_eq!(rd_u16(&w.ring_seed_data(6), RS::PROVINCES_CREATED), 1);
    assert_eq!(rd_u16(&w.ring_seed_data(5), RS::PROVINCES_CREATED), 30);
    let c5 = ProvinceCoord::new(5, 0);
    let pd = w.province_data(c5);
    let mut want = vec![0u8; PV2::SIZE];
    encode_terrain(&generate_province(&RING5_SEED, c5), &mut want).unwrap();
    assert_eq!(
        &pd[TERRAIN_BLOCK], &want[TERRAIN_BLOCK],
        "the old land is unchanged"
    );
    assert_eq!(rd_u32(&pd, PV::OPENED_BELL), 1);
    records();

    // A bell later the next extension passes the bell rule (θ late still
    // holds) and stops again at the unopened ring: one ring at a time.
    at_bell(bell + 1);
    assert_eq!(w.extend_frontier(7), Ok(()));
    assert_eq!(w.frontier_state().1, 7);
    assert_eq!(w.extend_frontier(8), Err(E::TooEarly as u32));
    assert_eq!(w.open_ring(8), Err(E::BadData as u32));
    assert_eq!(
        kinds_of(&records()),
        [AnyKind::Cq(CqKind::FRONTIER_EXTENDED)]
    );
}

/// The bounds that stay: a season without a ceiling (every preset's
/// default) never grows past its `r_max`, however crowded; a season at
/// ring 128 (`R_MAX_HARD`, the most a ceiling may be) grows no further, and
/// no province beyond ring 128 can be named.
#[test]
fn map_growth_expansion_is_refused_without_a_ceiling_and_never_past_ring_128() {
    let _g = begin();
    at_bell(1);
    // No ceiling: r_max 8, rings 0–3 open, wedge 0 crowded.
    let mut w = World::new();
    assert_eq!(w.cq.r_max_ceiling, 0);
    w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
    w.fold();
    records();
    assert_eq!(
        w.extend_frontier(9),
        Err(E::BadData as u32),
        "no ceiling: no growth"
    );
    assert_eq!(
        w.extend_frontier(4),
        Err(E::BadData as u32),
        "no ceiling: refused before any other check (never AlreadyDone)"
    );
    assert_eq!(w.open_ring(9), Err(E::BadData as u32));
    assert_eq!(
        w.open_province(ProvinceCoord::new(9, 0)),
        Err(E::BadData as u32)
    );
    let (ro, ext, ..) = w.frontier_state();
    assert_eq!((ro, ext), (RINGS_OPENED, 0));
    assert!(records().is_empty());

    // Ring 128: a season extended to the program's hard maximum.
    assert_eq!(R_MAX_HARD, 128);
    let mut w = World::with(Setup {
        r_max: 4,
        genesis_ring: 2,
        ceiling: R_MAX_HARD,
        rings_opened: 129,
        r_max_ext: R_MAX_HARD,
    });
    w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
    w.fold();
    records();
    assert_eq!(w.extend_frontier(129), Err(E::BadData as u32));
    assert_eq!(w.open_ring(129), Err(E::BadData as u32));
    assert_eq!(
        w.open_province(ProvinceCoord::new(129, 0)),
        Err(E::BadData as u32)
    );
    assert!(ProvinceCoord::checked(128, 0, u16::MAX).is_ok());
    assert!(
        ProvinceCoord::checked(129, 0, u16::MAX).is_err(),
        "no coordinate past ring 128"
    );
    let (ro, ext, ..) = w.frontier_state();
    assert_eq!((ro, ext), (129, 128));
    assert!(records().is_empty());
}

/// A finite season's map is the one it ends with (workstream 08,
/// `f3f23442`): ExtendFrontier from the season's end bell is `WrongStatus`
/// while EndSeason has not been sent (the effective status is still
/// Running), and writes and logs nothing; in the bell before the end the
/// same extension lands. A continuous world's end bell is `NO_END_BELL`
/// (u32::MAX), which no bell reaches.
#[test]
fn map_growth_expansion_is_refused_from_the_end_bell_of_a_finite_season() {
    let _g = begin();
    at_bell(1);
    let mut w = World::growing();
    w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
    w.fold();
    let _ = records();
    {
        // The same Season, ending at bell 2 (joins closed at bell 1).
        let mut d = w.season.try_borrow_mut_data().unwrap();
        put(&mut d, S::JOIN_CLOSE_BELL, &1u32.to_le_bytes());
        put(&mut d, S::END_BELL, &2u32.to_le_bytes());
    }
    at_bell(2);
    let before = w.frontier_data();
    assert_eq!(w.extend_frontier(5), Err(E::WrongStatus as u32));
    assert_eq!(w.frontier_data(), before, "nothing written");
    assert!(records().is_empty(), "nothing logged");
    at_bell(3);
    assert_eq!(w.extend_frontier(5), Err(E::WrongStatus as u32), "nor later");
    at_bell(1);
    assert_eq!(w.extend_frontier(5), Ok(()), "the last bell still grows");
    assert_eq!(w.frontier_state().1, 5);
}

/// The RingSeed of ring `d` as genesis (rings up to the genesis ring:
/// `genesis_ring_seed`) or OpenRing + ConsumeRingSeed (beyond it: `seed`)
/// leave it: present, seeded. Test pre-state, not the program's write (a
/// beacon round cannot be verified or signed here; module doc).
fn seeded_ring_seed_bytes(d: u16, seed: &[u8; 32]) -> Vec<u8> {
    let mut b = vec![0u8; RS::SIZE];
    assert!(write_header(&mut b, K2::RingSeed, SEASON_ID));
    put(&mut b, RS::D, &d.to_le_bytes());
    b[RS::STATUS] = RS::STATUS_SEEDED;
    put(&mut b, RS::SEED, seed);
    b
}

impl World {
    /// Rings `2..=last` opened province by province through OpenProvince,
    /// from funds whose `open_sites` start at 0 (so they count exactly what
    /// the program opened). Rings up to the genesis ring take the genesis
    /// seed, outer rings a literal seed each.
    fn open_rings_for_capacity(&mut self, last: u16) {
        for w in 0..6u8 {
            let f = self.fund(w);
            let mut d = f.try_borrow_mut_data().unwrap();
            put(&mut d, PF::OPEN_SITES, &0u32.to_le_bytes());
        }
        for d in 2..=last {
            let seed = if d <= self.setup.genesis_ring as u16 {
                crate::proc::map::genesis_ring_seed(&GENESIS_SEED, d)
            } else {
                [0x30 + d as u8; 32]
            };
            let key = self.ctx.ring_seed(d);
            self.ring_seeds.insert(
                d,
                info(
                    leak(key, PROGRAM, seeded_ring_seed_bytes(d, &seed), 0, BIG),
                    false,
                    true,
                ),
            );
            for c in permutation_rules::frontier::geometry::ring_provinces(d as u32) {
                assert_eq!(self.open_province(c), Ok(()), "OpenProvince {c:?}");
            }
        }
    }

    /// Free sites (state FREE) of the opened Province of `c`.
    fn free_sites(&mut self, c: ProvinceCoord) -> u32 {
        let pd = self.province_data(c);
        (0..pd[PV::SITE_COUNT] as usize)
            .filter(|&i| pd[PV::site(i) + SM::STATE] == SM::STATE_FREE)
            .count() as u32
    }
}

/// First homes alone against the crowding rule, on real openings
/// (workstream 08; the real dispatch; θ and its switch of the S1 seasons'
/// base preset `M1_LOCAL_7D`: 55 % early, 65 % after 3 days).
///
/// Only first homes count as occupied (PlaceHome, SettleTicket; released
/// by ReleaseDormant) and a season with the instant home places them only
/// in the heartland (rings 2..=3). Rings 2–4 opened through OpenProvince
/// give each wedge 108 open sites and 60 free heartland sites:
/// - early, the first extension (ring 5) lands only when every free
///   heartland site of a wedge is homed (60/108 = 55.6 %); one fewer is
///   Capacity;
/// - late (65 %), a full heartland is Capacity;
/// - once ring 5 is open (its sites added), ring 6 is Capacity in both
///   phases (60/168 = 35.7 %).
///
/// Homes are written as the folded JoinShard pre-state (every heartland
/// site of the wedge homed), as the growth tests write theirs; the rest is
/// the program's. The rule is unchanged here: this pins what it implies.
#[test]
fn map_growth_heartland_first_homes_alone_stop_the_map_at_ring_5() {
    let _g = begin();
    at_bell(1);
    let mut w = World::growing();
    {
        let base = frontier_abi::presets::M1_LOCAL_7D;
        let mut d = w.season.try_borrow_mut_data().unwrap();
        put(&mut d, S::THETA_EARLY_BPS, &base.theta_early_bps.to_le_bytes());
        put(&mut d, S::THETA_LATE_BPS, &base.theta_late_bps.to_le_bytes());
        put(&mut d, S::THETA_SWITCH_SECS, &base.theta_switch_secs.to_le_bytes());
    }
    w.open_rings_for_capacity(4);
    let hmr = w.cq.heartland_max_ring as u32;
    assert_eq!(hmr, 3);
    let mut heart = [0u32; 6];
    for d in 2..=hmr {
        for c in permutation_rules::frontier::geometry::ring_provinces(d) {
            heart[crate::proc::map::fund_wedge(c) as usize] += w.free_sites(c);
        }
    }
    let open = |w: &mut World| -> Vec<u32> {
        (0..6u8)
            .map(|x| rd_u32(&w.fund_data(x), PF::OPEN_SITES))
            .collect()
    };
    assert_eq!(heart, [60; 6], "free heartland sites per wedge");
    assert_eq!(open(&mut w), vec![108; 6], "open sites of rings 2-4 per wedge");

    // Early: one home short of a full heartland in wedge 0 is not enough.
    w.set_shard_homes(0, 0, 0, heart[0] - 1);
    w.fold();
    assert_eq!(w.extend_frontier(5), Err(E::Capacity as u32));
    // Every free heartland site of wedge 0 homed: 60/108 >= 55 %.
    w.set_shard_homes(0, 0, 0, heart[0]);
    w.fold();
    let _ = records();
    assert_eq!(w.extend_frontier(5), Ok(()));

    // Ring 5 opened and created (the program's OpenRing and OpenProvince;
    // its seed written as ConsumeRingSeed leaves it).
    at_bell(2);
    w.fold();
    assert_eq!(w.open_ring(5), Ok(()));
    w.seed_ring_as_consume_ring_seed_would(5, &RING5_SEED);
    for c in permutation_rules::frontier::geometry::ring_provinces(5) {
        assert_eq!(w.open_province(c), Ok(()), "OpenProvince {c:?}");
    }
    let opened = open(&mut w);
    assert!(opened.iter().all(|&o| o > 108), "ring 5's sites counted: {opened:?}");
    at_bell(3);
    w.fold();
    assert_eq!(
        w.extend_frontier(6),
        Err(E::Capacity as u32),
        "early: {} of {} open sites",
        heart[0],
        opened[0]
    );

    // Late phase (after theta_switch_secs): a full heartland is not 65 %.
    let late_bell = (frontier_abi::presets::M1_LOCAL_7D.theta_switch_secs / 600) + 4;
    at_bell(late_bell);
    w.fold();
    assert_eq!(w.extend_frontier(6), Err(E::Capacity as u32), "late, ring 6");
    assert!(
        (heart[0] as u64) * 10_000
            < frontier_abi::presets::M1_LOCAL_7D.theta_late_bps as u64 * 108,
        "late, even before ring 5: 60/108 < 65 %"
    );
}
