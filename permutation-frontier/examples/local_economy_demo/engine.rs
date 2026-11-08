//! The private in-memory sandbox of the local wide-economy demo.
//!
//! **What runs.** Every Harvest, Build and Train is the program's real
//! `permutation_frontier::dispatch` (0xDA op 3, `WideEconomy`) over six
//! `AccountInfo`s that borrow this module's owned buffers for the length of
//! one call. Nothing of the economy is re-implemented here: this file only
//! stages, calls, judges and commits.
//!
//! **MOCK AUTH NO SIGNATURE.** The actor and payer `is_signer` flags are set
//! by this file, as the runtime would set them after verifying a signature.
//! No key exists, nothing is derived from one and no signature is created or
//! verified. Addresses are the fixed literals below plus public with-seed
//! hashes of the fixed Season 11 address.
//!
//! **Per mutation.** 1. clone the four account images (the stage);
//! 2. dispatch on the stage with the simulated clock set for this thread only
//! (`prologue::set_local_demo_clock`, cleared afterwards, so a stray call
//! fails closed); 3. judge: zero CPI (every CPI is denied and counted), only
//! the one expected `PSW1` record, lamports as they were, the Season
//! untouched, only the allowed bytes of every account changed, exactly one
//! valid receipt recomputed from the complete before/after bytes with the
//! ABI helpers, and the event chains walked; 4. commit the stage. A handler
//! refusal drops the stage: memory, logs and revision as they were. Any
//! failed judgement is a `Fault` and commits nothing.
//!
//! **Stores.** The fixtures' stores were set by hand to 1,900 units before
//! the first action (a fixture, not a rule). This file has no way to write a
//! store: the only writer of the images is the commit of a judged dispatch,
//! so a stock never comes back except through `reset`, which reloads the
//! original bytes verbatim.
//!
//! **Time.** The simulated clock moves only through [`Sandbox::advance`]
//! (a demo control, not a game rule). It changes nothing in the images:
//! production, queue completion and finality are settled by the next
//! economic action, as on chain.

use std::sync::{Mutex, MutexGuard, Once};

use frontier_abi::prologue::bell_at;
use frontier_abi::world_index::economy::{self as weco, Action, EconomyReceipt, Snapshots};
use frontier_abi::world_index::event::{
    self as wev, WideEntity, WideRecord, WideTarget, WIDE_LOG_PREFIX,
};
use frontier_abi::world_index::holding::{self as wh, wide_holding as WHL, WideHolding};
use frontier_abi::world_index::land as wl;
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{ProvinceKey, WideHostRef, WideProvince};
use permutation_frontier::addr::{self, citizen_tag15};
use permutation_frontier::error::Error;
use permutation_frontier::layout::{chain_of, citizen as C, header, holding as H, season as S, Ro};
use solana_program::{
    account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
    pubkey::Pubkey,
};

// ------------------------------------------------------------ constants

/// Fixed literal addresses (no key behind any of them).
pub const PROGRAM: [u8; 32] = [0x12; 32];
pub const WALLET: [u8; 32] = [0xa1; 32];
pub const PAYER: [u8; 32] = [0xd4; 32];
const SYSTEM: [u8; 32] = addr::ids::SYSTEM_PROGRAM;
/// Lamports of every program-owned account and of the payer (the harness's).
const BIG: u64 = 10_000_000_000;
const ACTOR_LAMPORTS: u64 = 0;

/// The recorded Season.
pub const SEASON_ID: u64 = 11;
/// The program version of the recorded fixtures: S1 (4) with the wide bit.
pub const FIXTURE_VERSION: u16 = 0x4004;
/// Initial demo time: Season genesis + 147 bells.
pub const INITIAL_NOW: i64 = 1_800_088_200;
#[cfg(test)]
pub const INITIAL_BELL: u32 = 147;
const BELL_SECS: i64 = 600;

/// The only demo time skips (seconds).
pub const ADVANCE_SECS: [i64; 3] = [600, 3_600, 86_400];

macro_rules! fixture {
    ($case:literal, $file:literal) => {
        include_bytes!(concat!(
            "../../../frontier-node/crates/verify/tests/fixtures/wide_economy/",
            $case,
            "/",
            $file
        ))
    };
}

// The recorded originals: the harvest case's pre-state. Verbatim.
const SEASON_BIN: &[u8] = fixture!("harvest", "season.bin");
const CITIZEN_BIN: &[u8] = fixture!("harvest", "citizen_pre.bin");
const HOLDING_BIN: &[u8] = fixture!("harvest", "holding_pre.bin");
const PROVINCE_BIN: &[u8] = fixture!("harvest", "province_pre.bin");

// ------------------------------------------------------------ images

/// The four program-owned accounts of the one holding being played.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Images {
    pub season: Vec<u8>,
    pub citizen: Vec<u8>,
    pub holding: Vec<u8>,
    pub province: Vec<u8>,
}

impl Images {
    /// The recorded harvest pre-state, byte for byte.
    pub fn original() -> Images {
        Images {
            season: SEASON_BIN.to_vec(),
            citizen: CITIZEN_BIN.to_vec(),
            holding: HOLDING_BIN.to_vec(),
            province: PROVINCE_BIN.to_vec(),
        }
    }
}

/// The fixed identity of the played holding, derived from the images.
#[derive(Clone, Copy, Debug)]
struct Ident {
    season_key: [u8; 32],
    citizen_key: [u8; 32],
    holding_key: [u8; 32],
    province_key: [u8; 32],
    href: WideHostRef,
    pkey: ProvinceKey,
    genesis: i64,
    end_ts: i64,
}

/// Checks the images are the recorded Season 11 / wallet 0xa1 / program
/// 0x12 world of this build and derives the public addresses.
fn identify(im: &Images) -> Result<Ident, &'static str> {
    let season = Ro(&im.season);
    let citizen = Ro(&im.citizen);
    let id = season.u64(header::SEASON_ID).map_err(|_| "INIT_SEASON")?;
    if id != SEASON_ID {
        return Err("INIT_SEASON_ID");
    }
    let version = season.u16(S::PROGRAM_VERSION).map_err(|_| "INIT_SEASON")?;
    if version != permutation_frontier::PROGRAM_VERSION || version != FIXTURE_VERSION {
        return Err("INIT_PROGRAM_VERSION");
    }
    let bump = season.u8(S::BUMP).map_err(|_| "INIT_SEASON")?;
    let genesis = season.i64(S::GENESIS_TS).map_err(|_| "INIT_SEASON")?;
    let end_bell = season.u32(S::END_BELL).map_err(|_| "INIT_SEASON")?;
    let end_ts = (end_bell as i64)
        .checked_mul(BELL_SECS)
        .and_then(|s| genesis.checked_add(s))
        .ok_or("INIT_SEASON")?;
    let season_key = addr::season_pda(SEASON_ID, bump, &PROGRAM);
    let ctx = addr::ctx(&season_key, &PROGRAM);
    let wallet = citizen.arr::<32>(C::WALLET).map_err(|_| "INIT_CITIZEN")?;
    if wallet != WALLET {
        return Err("INIT_WALLET");
    }
    let citizen_key = ctx.citizen_by_tag15(&citizen_tag15(&WALLET));
    let h = WideHolding::read(&im.holding).map_err(|_| "INIT_HOLDING")?;
    if h.season_id != SEASON_ID || h.owner_citizen != citizen_key {
        return Err("INIT_HOLDING_OWNER");
    }
    let p = WideProvince::read(&im.province).map_err(|_| "INIT_PROVINCE")?;
    if p.season_id != h.season_id || p.world != h.world || p.coord != h.coord {
        return Err("INIT_PROVINCE_IDENTITY");
    }
    let pkey = ProvinceKey::new(h.world, h.coord);
    let href = WideHostRef::new(pkey, h.site, h.gen, 0).map_err(|_| "INIT_HOST_REF")?;
    Ok(Ident {
        season_key,
        citizen_key,
        holding_key: wh::holding_address(&ctx, h.coord, h.site),
        province_key: wl::province_address(&ctx, h.coord),
        href,
        pkey,
        genesis,
        end_ts,
    })
}

// ------------------------------------------------------------ stubs

/// What the denying syscall stubs saw during one dispatch.
struct Collected {
    records: Vec<Vec<u8>>,
    cpi: u64,
    other_logs: u64,
}

static COLLECTED: Mutex<Collected> = Mutex::new(Collected {
    records: Vec::new(),
    cpi: 0,
    other_logs: 0,
});
/// One dispatch at a time (stubs and collector are process-global).
static RUN_LOCK: Mutex<()> = Mutex::new(());
static STUBS: Once = Once::new();
/// Most records one dispatch may leave in the collector.
const MAX_COLLECTED: usize = 4;

fn collected() -> MutexGuard<'static, Collected> {
    COLLECTED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Denies and counts every CPI, collects the expected `PSW1` record only and
/// counts every other log line. No file, no network.
struct DenyStubs;

impl solana_program::program_stubs::SyscallStubs for DenyStubs {
    fn sol_log(&self, _message: &str) {
        collected().other_logs += 1;
    }

    fn sol_log_data(&self, fields: &[&[u8]]) {
        let mut c = collected();
        if fields.len() == 2 && fields[0] == &WIDE_LOG_PREFIX[..] && c.records.len() < MAX_COLLECTED
        {
            c.records.push(fields[1].to_vec());
        } else {
            c.other_logs += 1;
        }
    }

    fn sol_invoke_signed(
        &self,
        _ix: &Instruction,
        _infos: &[AccountInfo],
        _seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        collected().cpi += 1;
        Err(ProgramError::IncorrectProgramId)
    }
}

fn install_stubs() {
    STUBS.call_once(|| {
        let _ = solana_program::program_stubs::set_syscall_stubs(Box::new(DenyStubs));
    });
}

// ------------------------------------------------------------ dispatch

/// Everything one dispatch did, before it is judged.
pub struct Run {
    pub result: Result<(), Error>,
    pub records: Vec<Vec<u8>>,
    pub cpi: u64,
    pub other_logs: u64,
    pub lamports_ok: bool,
    pub panicked: bool,
}

/// The slot the simulated clock reports (synthetic, like the harness's).
fn slot_of(id: &Ident, now: i64) -> u64 {
    1_000 + bell_at(id.genesis, now).unwrap_or(0) as u64
}

/// One real `dispatch` of `action` on `stage` (mutated in place), with the
/// simulated clock `clock` set on this thread for the call only (`None`
/// leaves it unset: the program must refuse).
fn run_dispatch(id: &Ident, stage: &mut Images, action: Action, clock: Option<(i64, u64)>) -> Run {
    let _serial = RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    install_stubs();
    {
        let mut c = collected();
        c.records.clear();
        c.cpi = 0;
        c.other_logs = 0;
    }
    match clock {
        Some((ts, slot)) => permutation_frontier::prologue::set_local_demo_clock(ts, slot),
        None => permutation_frontier::prologue::clear_local_demo_clock(),
    }
    let program = Pubkey::new_from_array(PROGRAM);
    let system = Pubkey::new_from_array(SYSTEM);
    let k_actor = Pubkey::new_from_array(WALLET);
    let k_payer = Pubkey::new_from_array(PAYER);
    let k_season = Pubkey::new_from_array(id.season_key);
    let k_citizen = Pubkey::new_from_array(id.citizen_key);
    let k_holding = Pubkey::new_from_array(id.holding_key);
    let k_province = Pubkey::new_from_array(id.province_key);
    let (mut l_actor, mut l_payer) = (ACTOR_LAMPORTS, BIG);
    let (mut l_season, mut l_citizen, mut l_holding, mut l_province) = (BIG, BIG, BIG, BIG);
    let mut d_actor: [u8; 0] = [];
    let mut d_payer: [u8; 0] = [];
    let mirror = action.mirror_write();
    let data = wix::Economy { action }.to_bytes();
    let (result, panicked) = match data {
        None => (
            Err(Error::Frontier(
                permutation_frontier::FrontierError::BadData,
            )),
            false,
        ),
        Some(data) => {
            let caught = {
                // MOCK AUTH NO SIGNATURE: the signer flags are simulated.
                let accounts = [
                    AccountInfo::new(
                        &k_actor,
                        true,
                        false,
                        &mut l_actor,
                        &mut d_actor[..],
                        &system,
                        false,
                    ),
                    AccountInfo::new(
                        &k_payer,
                        true,
                        true,
                        &mut l_payer,
                        &mut d_payer[..],
                        &system,
                        false,
                    ),
                    AccountInfo::new(
                        &k_season,
                        false,
                        false,
                        &mut l_season,
                        &mut stage.season[..],
                        &program,
                        false,
                    ),
                    AccountInfo::new(
                        &k_citizen,
                        false,
                        true,
                        &mut l_citizen,
                        &mut stage.citizen[..],
                        &program,
                        false,
                    ),
                    AccountInfo::new(
                        &k_holding,
                        false,
                        true,
                        &mut l_holding,
                        &mut stage.holding[..],
                        &program,
                        false,
                    ),
                    AccountInfo::new(
                        &k_province,
                        false,
                        mirror,
                        &mut l_province,
                        &mut stage.province[..],
                        &program,
                        false,
                    ),
                ];
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    permutation_frontier::dispatch(&program, &accounts, &data)
                }))
            };
            match caught {
                Ok(r) => (r, false),
                Err(_) => (Ok(()), true),
            }
        }
    };
    permutation_frontier::prologue::clear_local_demo_clock();
    let lamports_ok = l_actor == ACTOR_LAMPORTS
        && l_payer == BIG
        && l_season == BIG
        && l_citizen == BIG
        && l_holding == BIG
        && l_province == BIG;
    let mut c = collected();
    Run {
        result,
        records: std::mem::take(&mut c.records),
        cpi: c.cpi,
        other_logs: c.other_logs,
        lamports_ok,
        panicked,
    }
}

// ------------------------------------------------------------ judgement

/// A program refusal as a short ASCII code: `E<n>` for a Frontier or MC
/// code, `P<n>` for a runtime error passed through.
pub fn code_of(e: &Error) -> String {
    match e {
        Error::Frontier(f) => format!("E{}", f.code()),
        Error::Cq(c) => format!("E{}", c.code()),
        Error::Program(p) => format!("P{}", u64::from(p.clone())),
    }
}

/// Whether every differing byte lies in an allowed `(offset, len)` range.
fn only_within(pre: &[u8], post: &[u8], allowed: &[(usize, usize)]) -> bool {
    pre.len() == post.len()
        && pre
            .iter()
            .zip(post)
            .enumerate()
            .all(|(i, (a, b))| a == b || allowed.iter().any(|(o, n)| i >= *o && i < o + n))
}

/// A mirror Build writes a handful of site-mirror bytes in the province;
/// this bounds them (a sanity bound, not the mirror rule, which is the
/// program's).
const MAX_MIRROR_BYTES: usize = 32;

/// Judges a successful dispatch (module doc): `Err` is a fault code.
fn verify_success(
    id: &Ident,
    pre: &Images,
    post: &Images,
    action: Action,
    now: i64,
    record: &[u8],
) -> Result<(), &'static str> {
    if post.season != pre.season {
        return Err("SEASON_CHANGED");
    }
    if post.citizen.len() != pre.citizen.len()
        || post.holding.len() != pre.holding.len()
        || post.province.len() != pre.province.len()
    {
        return Err("SIZE_CHANGED");
    }
    // the Citizen: bucket and owner-action stamp, header untouched
    let allowed = [
        (C::BUCKET_MILLI, 4),
        (C::BUCKET_T, 4),
        (C::LAST_ACTION_TS, 8),
    ];
    if !only_within(&pre.citizen, &post.citizen, &allowed)
        || post.citizen[..header::H_SIZE] != pre.citizen[..header::H_SIZE]
    {
        return Err("CITIZEN_BYTES");
    }
    if Ro(&post.citizen)
        .i64(C::LAST_ACTION_TS)
        .map_err(|_| "CITIZEN_BYTES")?
        != now
    {
        return Err("CITIZEN_STAMP");
    }
    // the holding: identity, ticket, rent, pool debt and trailer as they were
    let (a, b) = (&pre.holding, &post.holding);
    if b[WHL::TRAILER..] != a[WHL::TRAILER..]
        || b[header::MAGIC..header::EVENT_SEQ] != a[header::MAGIC..header::EVENT_SEQ]
        || b[H::P..=H::TILE] != a[H::P..=H::TILE]
        || b[H::OWNER_CITIZEN..=H::ORDER] != a[H::OWNER_CITIZEN..=H::ORDER]
        || b[H::TICKET_BELL..H::TICKET_BELL + 4] != a[H::TICKET_BELL..H::TICKET_BELL + 4]
        || b[H::ESCROW..H::POOL_OWED + 8] != a[H::ESCROW..H::POOL_OWED + 8]
    {
        return Err("HOLDING_IDENTITY");
    }
    if Ro(b)
        .i64(H::LAST_OWNER_ACTION)
        .map_err(|_| "HOLDING_BYTES")?
        != now
    {
        return Err("HOLDING_STAMP");
    }
    let (s_pre, s_post) = (a[H::STATE], b[H::STATE]);
    let became_final = s_pre == H::STATE_PROVISIONAL && s_post == H::STATE_FINAL;
    if s_pre != s_post && !became_final {
        return Err("HOLDING_STATE");
    }
    // the province: byte-identical unless a mirror item
    let mirror = action.mirror_write();
    if mirror {
        let chain = header::EVENT_SEQ..header::EVENT_HEAD + 32;
        if post.province[..header::EVENT_SEQ] != pre.province[..header::EVENT_SEQ] {
            return Err("PROVINCE_HEADER");
        }
        let changed = pre
            .province
            .iter()
            .zip(&post.province)
            .enumerate()
            .filter(|(i, (x, y))| x != y && !chain.contains(i))
            .count();
        if changed == 0 || changed > MAX_MIRROR_BYTES {
            return Err("PROVINCE_MIRROR_BYTES");
        }
        let (p0, p1) = (
            WideProvince::read(&pre.province).map_err(|_| "PROVINCE_READ")?,
            WideProvince::read(&post.province).map_err(|_| "PROVINCE_READ")?,
        );
        if (p0.season_id, p0.world, p0.coord) != (p1.season_id, p1.world, p1.coord) {
            return Err("PROVINCE_IDENTITY");
        }
    } else if post.province != pre.province {
        return Err("PROVINCE_CHANGED");
    }
    // exactly one valid receipt over the complete before/after bytes
    let rec = WideRecord::decode(record).map_err(|_| "RECORD_DECODE")?;
    if rec.kind != action.kind() {
        return Err("RECORD_KIND");
    }
    if Some(rec.bell) != bell_at(id.genesis, now) {
        return Err("RECORD_BELL");
    }
    let key = weco::economy_key(&id.href).map_err(|_| "RECORD_KEY")?;
    if rec.key != &key[..] {
        return Err("RECORD_KEY");
    }
    let want = EconomyReceipt {
        action,
        now_ts: now,
        became_final,
        input_digest: weco::input_digest(
            &id.href,
            action,
            now,
            &pre.season,
            &Snapshots {
                citizen: &pre.citizen,
                holding: &pre.holding,
                province: &pre.province,
            },
        )
        .map_err(|_| "RECEIPT_INPUT")?,
        output_digest: weco::output_digest(
            &id.href,
            action,
            now,
            became_final,
            &Snapshots {
                citizen: &post.citizen,
                holding: &post.holding,
                province: &post.province,
            },
        )
        .map_err(|_| "RECEIPT_OUTPUT")?,
    };
    if rec.receipt() != Some(want) {
        return Err("RECEIPT_MISMATCH");
    }
    // the chains: the holding always, the province for mirror items only
    let h_pre = chain_of(&pre.holding).map_err(|_| "CHAIN_READ")?;
    let h_post = chain_of(&post.holding).map_err(|_| "CHAIN_READ")?;
    let p_pre = chain_of(&pre.province).map_err(|_| "CHAIN_READ")?;
    let p_post = chain_of(&post.province).map_err(|_| "CHAIN_READ")?;
    let lh = rec.link(WideEntity::Holding).ok_or("CHAIN_LINK")?;
    if Some(lh.seq) != h_pre.0.checked_add(1) || (lh.seq, lh.head) != h_post {
        return Err("HOLDING_CHAIN");
    }
    match (mirror, rec.link(WideEntity::Province)) {
        (true, Some(lp)) => {
            if Some(lp.seq) != p_pre.0.checked_add(1) || (lp.seq, lp.head) != p_post {
                return Err("PROVINCE_CHAIN");
            }
        }
        (false, None) => {
            if p_post != p_pre {
                return Err("PROVINCE_CHAIN");
            }
        }
        _ => return Err("CHAIN_LINK"),
    }
    let walk_h = wev::verify_chain(WideTarget::Holding(id.href), h_pre, std::iter::once(record));
    let walk_p = wev::verify_chain(
        WideTarget::Province(id.pkey),
        p_pre,
        std::iter::once(record),
    );
    if walk_h != Ok(h_post) || walk_p != Ok(p_post) {
        return Err("CHAIN_WALK");
    }
    Ok(())
}

/// What the judgement of one dispatch decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Judged {
    /// Commit the stage; this is the one receipt record.
    Commit(Vec<u8>),
    /// The handler refused: drop the stage.
    Refused(String),
    /// Something unexpected: drop the stage.
    Fault(&'static str),
}

fn judge(id: &Ident, pre: &Images, stage: &Images, run: Run, action: Action, now: i64) -> Judged {
    if run.panicked {
        return Judged::Fault("DISPATCH_PANIC");
    }
    if run.cpi != 0 {
        return Judged::Fault("UNEXPECTED_CPI");
    }
    if run.other_logs != 0 {
        return Judged::Fault("UNEXPECTED_LOG");
    }
    if !run.lamports_ok {
        return Judged::Fault("LAMPORTS_CHANGED");
    }
    match run.result {
        Err(e) => {
            if run.records.is_empty() {
                Judged::Refused(code_of(&e))
            } else {
                Judged::Fault("LOG_ON_REFUSAL")
            }
        }
        Ok(()) => {
            let [record] = run.records.as_slice() else {
                return Judged::Fault("RECORD_COUNT");
            };
            match verify_success(id, pre, stage, action, now, record) {
                Ok(()) => Judged::Commit(record.clone()),
                Err(code) => Judged::Fault(code),
            }
        }
    }
}

// ------------------------------------------------------------ sandbox

/// The result of one economic action.
#[derive(Debug, PartialEq, Eq)]
pub enum ActOutcome {
    /// Committed; the one receipt record.
    Done(Vec<u8>),
    Refused(String),
    Fault(&'static str),
}

pub struct Sandbox {
    images: Images,
    now: i64,
    id: Ident,
}

impl Sandbox {
    /// The recorded harvest pre-state at the initial demo time.
    pub fn new() -> Result<Sandbox, &'static str> {
        Sandbox::from_images(Images::original(), INITIAL_NOW)
    }

    /// A sandbox over other images (the recorded cases in tests).
    pub fn from_images(images: Images, now: i64) -> Result<Sandbox, &'static str> {
        let id = identify(&images)?;
        if bell_at(id.genesis, now).is_none() || now >= id.end_ts {
            return Err("INIT_CLOCK");
        }
        Ok(Sandbox { images, now, id })
    }

    /// Reloads the original bytes and the initial time verbatim.
    pub fn reset(&mut self) -> Result<(), &'static str> {
        *self = Sandbox::new()?;
        Ok(())
    }

    pub fn now(&self) -> i64 {
        self.now
    }

    pub fn images(&self) -> &Images {
        &self.images
    }

    /// Demo time skip. Changes the clock only: no account byte, no
    /// accrual, no completion until the next economic action.
    pub fn advance(&mut self, secs: i64) -> Result<(), &'static str> {
        if !ADVANCE_SECS.contains(&secs) {
            return Err("BAD_SECONDS");
        }
        let next = self.now.checked_add(secs).ok_or("TIME_LIMIT")?;
        if next >= self.id.end_ts {
            return Err("TIME_LIMIT");
        }
        self.now = next;
        Ok(())
    }

    /// The raw dispatch on a copy at an explicit clock (tests: the unset
    /// clock).
    #[cfg(test)]
    pub fn dispatch_on_copy(&self, action: Action, clock: Option<(i64, u64)>) -> (Run, Images) {
        let mut stage = self.images.clone();
        let run = run_dispatch(&self.id, &mut stage, action, clock);
        (run, stage)
    }

    /// One economic action: stage, dispatch, judge, commit (module doc).
    pub fn act(&mut self, action: Action) -> ActOutcome {
        if !action.is_valid() {
            return ActOutcome::Refused("BAD_ACTION".to_string());
        }
        let now = self.now;
        let mut stage = self.images.clone();
        let run = run_dispatch(
            &self.id,
            &mut stage,
            action,
            Some((now, slot_of(&self.id, now))),
        );
        match judge(&self.id, &self.images, &stage, run, action, now) {
            Judged::Commit(record) => {
                self.images = stage;
                ActOutcome::Done(record)
            }
            Judged::Refused(code) => ActOutcome::Refused(code),
            Judged::Fault(code) => ActOutcome::Fault(code),
        }
    }

    #[cfg(test)]
    pub fn judge_for_test(&self, stage: &Images, run: Run, action: Action) -> Judged {
        judge(&self.id, &self.images, stage, run, action, self.now)
    }

    #[cfg(test)]
    pub fn images_mut(&mut self) -> &mut Images {
        &mut self.images
    }
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use permutation_frontier::layout::player::{accrual as AC, queue_item as QI};
    use permutation_frontier::FrontierError;

    const HARVEST: Action = Action::Harvest;
    const BUILD0: Action = Action::Build { item: 0 };

    fn done(o: ActOutcome) -> Vec<u8> {
        match o {
            ActOutcome::Done(r) => r,
            other => panic!("expected Done, got {other:?}"),
        }
    }

    fn stores(h: &[u8]) -> Vec<i64> {
        (0..H::STORES_N)
            .map(|r| Ro(h).i64(H::store(r) + AC::VALUE).unwrap())
            .collect()
    }

    fn slots(h: &[u8]) -> Vec<Vec<u8>> {
        (0..H::QUEUE_N)
            .map(|i| h[H::queue(i)..H::queue(i) + QI::SIZE].to_vec())
            .collect()
    }

    /// The five recorded cases: name, files, as `include_bytes!`.
    struct Case {
        name: &'static str,
        pre: Images,
        post: Images,
        record: &'static [u8],
    }

    macro_rules! case {
        ($n:literal) => {
            Case {
                name: $n,
                pre: Images {
                    season: fixture!($n, "season.bin").to_vec(),
                    citizen: fixture!($n, "citizen_pre.bin").to_vec(),
                    holding: fixture!($n, "holding_pre.bin").to_vec(),
                    province: fixture!($n, "province_pre.bin").to_vec(),
                },
                post: Images {
                    season: fixture!($n, "season.bin").to_vec(),
                    citizen: fixture!($n, "citizen_post.bin").to_vec(),
                    holding: fixture!($n, "holding_post.bin").to_vec(),
                    province: fixture!($n, "province_post.bin").to_vec(),
                },
                record: fixture!($n, "record.bin"),
            }
        };
    }

    fn cases() -> Vec<Case> {
        vec![
            case!("harvest"),
            case!("building"),
            case!("wall"),
            case!("tier"),
            case!("train"),
        ]
    }

    #[test]
    fn playable_starts_at_the_harvest_prestate_and_initial_clock() {
        let sb = Sandbox::new().unwrap();
        let harvest = &cases()[0];
        assert_eq!(
            sb.images(),
            &harvest.pre,
            "the playable start is harvest/pre"
        );
        assert_eq!(sb.now(), INITIAL_NOW);
        assert_eq!(bell_at(sb.id.genesis, sb.now()), Some(INITIAL_BELL));
        let rec = WideRecord::decode(harvest.record).unwrap();
        assert_eq!(rec.receipt().unwrap().now_ts, INITIAL_NOW);
        assert_ne!(
            sb.images().holding,
            cases()[1].pre.holding,
            "not the building case's pre-state"
        );
        assert_eq!(permutation_frontier::PROGRAM_VERSION, FIXTURE_VERSION);
    }

    #[test]
    fn golden_all_five_recorded_cases_replay_byte_for_byte() {
        for c in cases() {
            let rec = WideRecord::decode(c.record).unwrap();
            let receipt = rec.receipt().unwrap();
            let mut sb = Sandbox::from_images(c.pre.clone(), receipt.now_ts).unwrap();
            let record = done(sb.act(receipt.action));
            assert_eq!(record, c.record, "{}: the receipt record", c.name);
            assert_eq!(sb.images().citizen, c.post.citizen, "{}: citizen", c.name);
            assert_eq!(sb.images().holding, c.post.holding, "{}: holding", c.name);
            assert_eq!(
                sb.images().province,
                c.post.province,
                "{}: province",
                c.name
            );
            assert_eq!(sb.images().season, c.post.season, "{}: season", c.name);
        }
        // the table is the recorded one
        let want = [
            Action::Harvest,
            Action::Build { item: 0 },
            Action::Build { item: 6 },
            Action::Build { item: 7 },
            Action::Train { unit: 0, n: 10 },
        ];
        for (c, a) in cases().iter().zip(want) {
            let rec = WideRecord::decode(c.record).unwrap();
            assert_eq!(rec.receipt().unwrap().action, a, "{}", c.name);
        }
    }

    #[test]
    fn repeated_sequence_never_restocks() {
        let mut sb = Sandbox::new().unwrap();
        done(sb.act(HARVEST)); // settles the production since the fixture's last touch
        let mut prev = stores(&sb.images().holding);
        // no time passes between these: nothing may add to any store
        for action in [
            BUILD0,
            Action::Train { unit: 0, n: 10 },
            Action::Train { unit: 3, n: 5 },
        ] {
            done(sb.act(action));
            let now_stores = stores(&sb.images().holding);
            for (r, (a, b)) in prev.iter().zip(&now_stores).enumerate() {
                assert!(
                    b <= a,
                    "{action:?}: store {r} went up ({a} -> {b}): a restock"
                );
            }
            assert!(
                prev.iter().zip(&now_stores).any(|(a, b)| b < a),
                "{action:?} paid nothing"
            );
            prev = now_stores;
        }
    }

    #[test]
    fn build_queues_until_advance_and_a_touch() {
        let mut sb = Sandbox::new().unwrap();
        done(sb.act(HARVEST));
        let before = slots(&sb.images().holding);
        done(sb.act(BUILD0));
        let queued = slots(&sb.images().holding);
        let changed: Vec<usize> = (0..H::QUEUE_N)
            .filter(|i| before[*i] != queued[*i])
            .collect();
        assert_eq!(changed.len(), 1, "exactly one item queued");
        let i = changed[0];
        let done_at =
            i64::from_le_bytes(queued[i][QI::DONE_AT..QI::DONE_AT + 8].try_into().unwrap());
        assert!(done_at > sb.now(), "it completes later");
        // time alone completes nothing
        let held = sb.images().clone();
        let mut guard = 0;
        while sb.now() < done_at {
            sb.advance(86_400).unwrap();
            assert_eq!(sb.images(), &held, "an advance changed an account byte");
            guard += 1;
            assert!(guard < 60, "the item never matures within the bound");
        }
        // the next economic action settles it
        done(sb.act(HARVEST));
        assert_ne!(
            slots(&sb.images().holding)[i],
            queued[i],
            "the item completed on the touch"
        );
    }

    #[test]
    fn train_credits_the_reserve_at_once() {
        let mut sb = Sandbox::new().unwrap();
        let at = H::reserve(0);
        let r0 = Ro(&sb.images().holding).u32(at).unwrap();
        done(sb.act(Action::Train { unit: 0, n: 10 }));
        assert_eq!(Ro(&sb.images().holding).u32(at).unwrap(), r0 + 10);
    }

    #[test]
    fn insufficient_funds_is_a_refusal_that_changes_nothing() {
        let mut sb = Sandbox::new().unwrap();
        done(sb.act(HARVEST)); // production settled up to now
        for r in 0..H::STORES_N {
            let at = H::store(r) + AC::VALUE;
            sb.images_mut().holding[at..at + 8].copy_from_slice(&0i64.to_le_bytes());
        }
        let before = sb.images().clone();
        let out = sb.act(BUILD0);
        assert_eq!(
            out,
            ActOutcome::Refused(format!("E{}", FrontierError::Insufficient.code()))
        );
        assert_eq!(sb.images(), &before, "a refusal committed something");
        assert!(collected().records.is_empty(), "a refusal left a log");
    }

    #[test]
    fn invalid_actions_are_refused_before_any_dispatch() {
        let mut sb = Sandbox::new().unwrap();
        let before = sb.images().clone();
        for a in [
            Action::Build { item: 9 },
            Action::Train { unit: 7, n: 1 },
            Action::Train { unit: 0, n: 0 },
        ] {
            assert_eq!(
                sb.act(a),
                ActOutcome::Refused("BAD_ACTION".to_string()),
                "{a:?}"
            );
        }
        assert_eq!(sb.images(), &before);
    }

    #[test]
    fn an_unset_clock_fails_closed() {
        let sb = Sandbox::new().unwrap();
        let (run, stage) = sb.dispatch_on_copy(HARVEST, None);
        assert!(!run.panicked);
        assert_eq!(
            run.result,
            Err(Error::Program(ProgramError::UnsupportedSysvar))
        );
        assert!(run.records.is_empty());
        assert_eq!(&stage, sb.images(), "the refusal wrote");
        // and the clock is unset again after a normal action
        let mut sb = Sandbox::new().unwrap();
        done(sb.act(HARVEST));
        let (run, _) = sb.dispatch_on_copy(HARVEST, None);
        assert_eq!(
            run.result,
            Err(Error::Program(ProgramError::UnsupportedSysvar))
        );
    }

    #[test]
    fn advance_accepts_only_the_three_skips_and_stays_inside_the_season() {
        let mut sb = Sandbox::new().unwrap();
        for bad in [0, 1, 599, 601, 7_200, 86_401, -600, i64::MAX] {
            assert_eq!(sb.advance(bad), Err("BAD_SECONDS"), "{bad}");
        }
        assert_eq!(sb.now(), INITIAL_NOW);
        for ok in ADVANCE_SECS {
            let t = sb.now();
            sb.advance(ok).unwrap();
            assert_eq!(sb.now(), t + ok);
        }
        // a season that ends right after the next bell: the skip is refused
        let mut im = Images::original();
        im.season[S::END_BELL..S::END_BELL + 4].copy_from_slice(&(INITIAL_BELL + 2).to_le_bytes());
        let mut short = Sandbox::from_images(im, INITIAL_NOW).unwrap();
        assert_eq!(short.advance(3_600), Err("TIME_LIMIT"));
        assert_eq!(short.now(), INITIAL_NOW);
        short.advance(600).unwrap();
    }

    #[test]
    fn reset_restores_the_original_bytes_and_time() {
        let mut sb = Sandbox::new().unwrap();
        done(sb.act(HARVEST));
        done(sb.act(Action::Train { unit: 0, n: 10 }));
        sb.advance(3_600).unwrap();
        assert_ne!(sb.images(), &Images::original());
        sb.reset().unwrap();
        assert_eq!(sb.images(), &Images::original());
        assert_eq!(sb.now(), INITIAL_NOW);
    }

    fn judged(sb: &Sandbox, action: Action, edit: impl FnOnce(&mut Run)) -> Judged {
        let (mut run, stage) =
            sb.dispatch_on_copy(action, Some((sb.now(), slot_of(&sb.id, sb.now()))));
        edit(&mut run);
        sb.judge_for_test(&stage, run, action)
    }

    #[test]
    fn unexpected_effects_are_faults_that_commit_nothing() {
        let sb = Sandbox::new().unwrap();
        assert!(matches!(judged(&sb, HARVEST, |_| {}), Judged::Commit(_)));
        assert_eq!(
            judged(&sb, HARVEST, |r| r.cpi = 1),
            Judged::Fault("UNEXPECTED_CPI")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| r.other_logs = 1),
            Judged::Fault("UNEXPECTED_LOG")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| r.lamports_ok = false),
            Judged::Fault("LAMPORTS_CHANGED")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| r.panicked = true),
            Judged::Fault("DISPATCH_PANIC")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| r.records.clear()),
            Judged::Fault("RECORD_COUNT")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| {
                let extra = r.records[0].clone();
                r.records.push(extra);
            }),
            Judged::Fault("RECORD_COUNT")
        );
        assert_eq!(
            judged(&sb, HARVEST, |r| {
                r.result = Err(Error::Frontier(FrontierError::BadData));
            }),
            Judged::Fault("LOG_ON_REFUSAL")
        );
        // a record whose bytes were tampered with is not a valid receipt
        let tampered = judged(&sb, HARVEST, |r| {
            let n = r.records[0].len();
            r.records[0][n - 40] ^= 1;
        });
        assert!(matches!(tampered, Judged::Fault(_)), "{tampered:?}");
        // and a stage the handler did not produce is not the receipt's output
        let (run, mut stage) =
            sb.dispatch_on_copy(HARVEST, Some((sb.now(), slot_of(&sb.id, sb.now()))));
        stage.holding[H::TIER] ^= 1;
        assert!(matches!(
            sb.judge_for_test(&stage, run, HARVEST),
            Judged::Fault(_)
        ));
        // none of the above committed anything
        assert_eq!(sb.images(), &Images::original());
    }

    #[test]
    fn only_non_mirror_actions_leave_the_province_byte_identical() {
        let mut sb = Sandbox::new().unwrap();
        let p0 = sb.images().province.clone();
        done(sb.act(HARVEST));
        done(sb.act(Action::Train { unit: 0, n: 1 }));
        assert_eq!(sb.images().province, p0);
        sb.advance(86_400).unwrap();
        done(sb.act(Action::Build { item: 6 }));
        assert_ne!(sb.images().province, p0, "walls write the site mirror");
    }
}
