//! **Read-only, opt-in** (feature `wide-world-experimental`): planning of
//! the two permissionless wide settlements the keeper could one day send —
//! WideSettleDeparture (0xDC op 3) and WideReturn (0xDC op 2) — as
//! **unsigned** instructions built from current account reads, with the
//! dispatcher's own account tables and refusals replayed over the decoded
//! state. Nothing here signs, simulates, sends or queues; the keeper's
//! engine never sees these instructions, the production debit gate stays
//! closed, and the legacy PSW1 feed guard is untouched.
//!
//! **Source of truth.** `permutation-frontier/src/proc/wide.rs`:
//! `settle_departure` (the exact six accounts `[payer s,w] [season r]
//! [origin_province w] [holding w] [roster w] [transit w]`) and
//! `settle_return` (`[payer s,w] [season r] [province w] [roster w]
//! [holding w] [transit r] ×4` and the optional `[holding_province r]`).
//! Each planner reproduces the handler's preconditions in the handler's
//! order and stops at the first one that fails, naming it ([`Block`]).
//! What the handler decides at execution it decides again then; a plan is
//! a prediction from a read, never a guarantee.
//!
//! **Permissionless means permissionless.** Neither planner compares the
//! holding's *current* generation or owner with the host's historical
//! reference: SettleDeparture settles the march the transit record names
//! whoever holds the holding now, and Return credits the holding record
//! when it is live at the reference's generation and **strands** the hosts
//! otherwise (a transferred Citizen, a re-founded site, an absent holding).
//! A plan says which.
//!
//! **Reads are not a context.** `ChainPort::accounts(keys, min_slot)`
//! promises a context slot at or after `min_slot` and nothing about which
//! slot, and the Clock is a separate call. A [`Candidate`] therefore
//! carries the requested lower bound and the separately observed clock and
//! marks itself `coherent: false`; it is not evidence the instruction would
//! succeed, only that the handler's refusals did not fire on these bytes.
//! A Season stored `Seeded` is promoted to `Running` by the handler's rule
//! (`now ≥ genesis_ts`) against that observed clock only, and the candidate
//! says so (`status_promoted_by_clock`).
//!
//! **The deployment is pinned, not guessed.** `settle_season` requires the
//! Season's exact `program_version` and ruleset hash. The caller pins both
//! in the [`Scope`] ([`Deployment`]); without a pin every plan blocks.
//!
//! **Stored values and chains.** A destroyed departure (kernel troops below
//! 500) stores zero troops and zero stamina; the facts say what the record
//! would hold, and the `ready_bell_off` the handler saturates. The event
//! chains of the province and the holding must have room for the records
//! the settle logs (one each for a settle; one per picked entry on the
//! province and one per credited entry on the holding for a return).
//!
//! **Boundaries.** A standing province that is not a wide province of this
//! world (a legacy Province at the position, another world's key) blocks;
//! the mixed legacy/wide movement stays refused as the program refuses it.
//! A return of hosts standing in a province other than their holding's own
//! needs the tenth account (the holding's own province, where the capture
//! lock is read); the planner adds it exactly then.

use std::collections::BTreeMap;

use fclient::abi::status;
use fclient::decode::{is_absent, Season};
use fclient::ports::{Account, ChainPort, ClockSysvar};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::{rd_u32, rd_u64, rd_u8};
use frontier_abi::entry::{find_entry, read_entry, EntryOp};
use frontier_abi::layout::header;
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::province::province as PV;
use frontier_abi::prologue::{Group, Wr};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::prologue::capture_locked;
use frontier_abi::world_index::wide_ix::{self as wix, Return, SettleDeparture};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, resolve as wres, roster as wro, wide_host_alias,
    MarchState, ProvinceKey, WideHolding, WideHostRef, WideProvince, WideRoster, WideTransit,
    WorldId,
};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::host::DESTROYED_BELOW;
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

use crate::wideindex::{Presence, WideDiscovery};

/// The deployed program the caller **pins**: the exact `program_version`
/// the Season must carry and the exact ruleset hash (`settle_season`
/// requires both; the keeper crate cannot read them off the program, so it
/// does not guess them). Without a pin the planners block
/// ([`Block::DeploymentUnpinned`]) rather than accept any version with the
/// wide bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deployment {
    pub program_version: u16,
    pub ruleset_hash: [u8; 32],
}

/// The program, Season and pinned deployment a plan is made under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub program: Address,
    pub season: Address,
    pub deployment: Option<Deployment>,
}

/// The most Leave entries one WideReturn settles
/// (`permutation_frontier::proc::clash::RETURN_MAX`, a program constant
/// the keeper crate cannot import; mirrored here for the prediction only —
/// the program applies its own).
pub const RETURN_MAX: usize = 3;

/// Never `true` in this module: no plan is signed, simulated, sent or
/// queued.
pub const AUTOMATIC_SEND: bool = false;

// ------------------------------------------------------------ reads

/// The accounts a planner was given, by address, with the lower bound they
/// were requested at and the clock observed **separately** (if at all).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reads {
    pub min_slot: u64,
    pub clock: Option<ClockSysvar>,
    /// `None` = the chain said absent; a missing key = not read yet.
    pub accounts: BTreeMap<Address, Option<Account>>,
}

impl Reads {
    pub fn new(min_slot: u64) -> Reads {
        Reads {
            min_slot,
            ..Reads::default()
        }
    }
}

/// A planner's answer: more reads needed (the addresses, canonical, that
/// the next step depends on), or a decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step<T> {
    Need(Vec<Address>),
    Done(Result<T, Block>),
}

/// Why no candidate exists: the handler's refusal the read state would
/// hit, or a read the planner could not get. Nothing in here is "retry
/// later" advice; the caller reads again and plans again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    /// The port failed or returned the wrong shape.
    Read(String),
    /// The read loop did not converge (a planner kept asking).
    ReadLoop,
    /// The Season at the scope address is not usable (named).
    Season(&'static str),
    /// A stored status the settles refuse (`Running` or `Ended` pass).
    SeasonStatus(u8),
    /// Stored `Seeded` and no clock was observed: the effective status
    /// (`Running` once `now ≥ genesis_ts`) cannot be judged.
    SeasonDependsOnClock,
    /// Stored `Seeded` and the separately observed clock is before the
    /// genesis timestamp: not yet Running by that observation.
    SeasonNotStarted { genesis_ts: i64, observed: i64 },
    /// No deployment pinned in the scope: the exact program version and
    /// ruleset hash the handler requires are unknown to the planner.
    DeploymentUnpinned,
    /// The Season's `program_version` is not the pinned one.
    ProgramVersion { expected: u16, got: u16 },
    /// The Season's ruleset hash is not the pinned one.
    RulesetHash,
    /// The event chain of the named account cannot take the records the
    /// settle would log (`seq + n` overflows: the handler's `Overflow`).
    ChainOverflow(&'static str),
    /// A key is not of this Season's one world (the handler's `BadAddress`).
    World,
    /// The transit slot is not below `TRANSIT_N`.
    BadSlot(u8),
    /// A required account is absent (named).
    Absent(&'static str),
    /// An account at a canonical address is not owned by the program.
    ForeignOwner(&'static str),
    /// An account's bytes do not decode as the record expected there.
    Unreadable(&'static str),
    /// A record of another season, or not at its canonical address.
    NotCanonical(&'static str),
    /// No transit record at the slot (`TransitState`: no march).
    NoMarch,
    /// The transit record names another host.
    TransitOtherHost,
    /// The departure settled already (`AlreadyDone`).
    AlreadySettled(MarchState),
    /// The record is in a state the settle refuses (`TransitState`).
    TransitState(MarchState),
    /// The holding's own province capture-locks it (`CapturePending`).
    CapturePending,
    /// The origin has not resolved past the departure bell (`TooEarly`).
    TooEarly {
        resolved_next: u32,
        depart_bell: u32,
    },
    /// The province entry table and the roster disagree (`BadAccount`).
    RosterUnpaired,
    /// No entry carries the host's alias (`NotResident`).
    NotResident,
    /// The entry is not in the departed state (`NotResident`).
    EntryState(u8),
    /// The entry carries the alias but the roster does not vouch for it.
    EntryUnpaired,
    /// An entry does not decode.
    BadEntry,
    /// The kernel refuses the post-clash values (`Host::march_values`).
    MarchValues(String),
    /// Return: the standing province has no roster (`AlreadyDone`).
    NoRoster,
    /// Return: every returnable host has an open march (`HostInTransit`).
    HostInTransit,
    /// Return: no departed Leave entry names this holding (`AlreadyDone`).
    NothingToReturn,
    /// Return: a credit would overflow the reserve (`Overflow`).
    ReserveOverflow { unit: u8 },
}

// ------------------------------------------------------------ candidates

/// What a SettleDeparture plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleFacts {
    pub host: WideHostRef,
    pub transit_slot: u8,
    pub origin: ProvinceKey,
    pub depart_bell: u32,
    pub resolved_next: u32,
    pub entry_index: usize,
    /// The kernel's post-clash values (`Host::march_values`).
    pub kernel_troops_milli: u32,
    pub kernel_stamina: u16,
    /// `kernel_troops < DESTROYED_BELOW` (the handler's `destroyed`).
    pub predicted_destroyed: bool,
    /// What the handler stores in the record: the kernel values, or
    /// **zero troops and zero stamina** when destroyed.
    pub troops_after_milli: u32,
    pub stamina_after: u16,
    /// `entry.ready_bell − depart_bell`, saturating at 0 and at `u16::MAX`.
    pub ready_bell_off: u16,
    /// The holding's own province is the origin (the capture lock was
    /// read there); otherwise no lock applies to this settle.
    pub origin_is_home: bool,
}

/// One entry a WideReturn would free.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnPick {
    pub entry_index: usize,
    pub host: WideHostRef,
    /// Credited to the holding's reserve (live at the reference's
    /// generation) or stranded (lost).
    pub credited: bool,
    pub unit: u8,
    pub whole_troops: u32,
}

/// What a Return plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnFacts {
    pub standing: ProvinceKey,
    /// The holding by reference (site and generation of the caller's
    /// reference; the generation is **not** required to match the record).
    pub holding: WideHostRef,
    pub holding_present: bool,
    /// `Some(gen)` when the holding record is live (provisional or final)
    /// at its stored generation; the credit test is `live == Some(ref gen)`.
    pub live_gen: Option<u8>,
    /// The hosts return into a province other than the holding's own: the
    /// tenth account (the holding's own province) is in the instruction.
    pub foreign: bool,
    pub picks: Vec<ReturnPick>,
    pub skipped_in_transit: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Duty {
    SettleDeparture(SettleFacts),
    Return(ReturnFacts),
}

/// A validated, **unsigned** instruction and the facts it rests on.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub duty: Duty,
    pub instruction: Instruction,
    pub payer: Address,
    /// The lower bound the reads were requested at (not their context slot).
    pub min_slot: u64,
    /// The clock, observed by a separate call, if the driver made one.
    pub observed_clock: Option<ClockSysvar>,
    /// Always `false`: reads and clock are not one context.
    pub coherent: bool,
    /// The Season was stored `Seeded` and judged `Running` only by the
    /// separately observed clock (`now ≥ genesis_ts`): the handler's
    /// `effective_status`, applied to an observation that is not coherent
    /// with the account reads.
    pub status_promoted_by_clock: bool,
    /// Always `false`.
    pub signed: bool,
    /// Always [`AUTOMATIC_SEND`] (`false`).
    pub automatic_send: bool,
}

impl Candidate {
    /// An operator-facing summary (no account bytes, no key material).
    pub fn describe(&self) -> Value {
        let (kind, facts) = match &self.duty {
            Duty::SettleDeparture(f) => (
                "WideSettleDeparture",
                json!({
                    "host": hex::encode(f.host.to_bytes()),
                    "transit_slot": f.transit_slot,
                    "origin": hex::encode(f.origin.to_bytes()),
                    "depart_bell": f.depart_bell,
                    "resolved_next": f.resolved_next,
                    "entry": f.entry_index,
                    "kernel_troops_milli": f.kernel_troops_milli,
                    "kernel_stamina": f.kernel_stamina,
                    "predicted_destroyed": f.predicted_destroyed,
                    "troops_after_milli": f.troops_after_milli,
                    "stamina_after": f.stamina_after,
                    "ready_bell_off": f.ready_bell_off,
                    "origin_is_home": f.origin_is_home,
                }),
            ),
            Duty::Return(f) => (
                "WideReturn",
                json!({
                    "standing": hex::encode(f.standing.to_bytes()),
                    "holding": hex::encode(f.holding.to_bytes()),
                    "holding_present": f.holding_present,
                    "live_gen": f.live_gen,
                    "foreign": f.foreign,
                    "picks": f.picks.iter().map(|p| json!({
                        "entry": p.entry_index,
                        "host": hex::encode(p.host.to_bytes()),
                        "credited": p.credited,
                        "unit": p.unit,
                        "whole_troops": p.whole_troops,
                    })).collect::<Vec<_>>(),
                    "skipped_in_transit": f.skipped_in_transit,
                }),
            ),
        };
        json!({
            "kind": kind,
            "facts": facts,
            "accounts": self.instruction.accounts.len(),
            "data_len": self.instruction.data.len(),
            "payer": self.payer.to_string(),
            "min_slot": self.min_slot,
            "observed_clock_slot": self.observed_clock.map(|c| c.slot),
            "coherent": self.coherent,
            "status_promoted_by_clock": self.status_promoted_by_clock,
            "signed": self.signed,
            "automatic_send": self.automatic_send,
        })
    }
}

// ------------------------------------------------------------ helpers

fn ctx_of(scope: &Scope) -> AddrCtx {
    AddrCtx {
        season: scope.season.to_bytes(),
        program: scope.program.to_bytes(),
    }
}

fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}

/// The addresses among `want` that `reads` does not hold yet.
fn missing(reads: &Reads, want: &[Address]) -> Vec<Address> {
    want.iter()
        .filter(|a| !reads.accounts.contains_key(a))
        .copied()
        .collect()
}

macro_rules! need {
    ($reads:expr, $want:expr) => {{
        let m = missing($reads, &$want);
        if !m.is_empty() {
            return Step::Need(m);
        }
    }};
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(b) => return Step::Done(Err(b)),
        }
    };
}

/// A read account at `a`: `None` when absent (System-owned, no data),
/// `Some` when present and program-owned (`ForeignOwner` otherwise).
fn presence<'a>(
    reads: &'a Reads,
    a: &Address,
    program: &Address,
    what: &'static str,
) -> Result<Option<&'a Account>, Block> {
    match reads.accounts.get(a) {
        None => Err(Block::Read(format!("{what} not read"))),
        Some(None) => Ok(None),
        Some(Some(acc)) => {
            if is_absent(&acc.owner, &acc.data) {
                return Ok(None);
            }
            if acc.owner != *program {
                return Err(Block::ForeignOwner(what));
            }
            Ok(Some(acc))
        }
    }
}

/// The Season of a settlement (`settle_season`): present, program-owned,
/// decodable, at the PDA of its stored id and bump; its effective status
/// `Running` or `Ended` — stored `Seeded` is promoted to `Running` exactly as
/// the handler's `effective_status` does, but only against the
/// **separately observed** clock (`SeasonDependsOnClock` without one,
/// `SeasonNotStarted` before genesis); the **pinned** exact program version
/// (which must also carry the wide bit) and ruleset hash. Returns the
/// Season and whether the status came from the clock.
fn season_of(scope: &Scope, reads: &Reads) -> Result<(Season, bool), Block> {
    let acc =
        presence(reads, &scope.season, &scope.program, "season")?.ok_or(Block::Absent("season"))?;
    let s = Season::decode(&acc.data).map_err(|_| Block::Unreadable("season"))?;
    let (pda, bump) = fclient::addr::season_pda(&scope.program, s.h.season_id);
    if pda != scope.season || bump != s.bump {
        return Err(Block::NotCanonical("season"));
    }
    let promoted = match s.status {
        status::RUNNING | status::ENDED => false,
        status::SEEDED => match reads.clock {
            None => return Err(Block::SeasonDependsOnClock),
            Some(c) if c.unix_timestamp >= s.genesis_ts => true,
            Some(c) => {
                return Err(Block::SeasonNotStarted {
                    genesis_ts: s.genesis_ts,
                    observed: c.unix_timestamp,
                })
            }
        },
        other => return Err(Block::SeasonStatus(other)),
    };
    let Some(dep) = scope.deployment else {
        return Err(Block::DeploymentUnpinned);
    };
    if s.program_version != dep.program_version {
        return Err(Block::ProgramVersion {
            expected: dep.program_version,
            got: s.program_version,
        });
    }
    if s.program_version & wix::WIDE_EXPERIMENTAL_VERSION_BIT == 0 {
        return Err(Block::Season(
            "pinned version is not a wide build (version bit clear)",
        ));
    }
    if s.ruleset_hash != dep.ruleset_hash {
        return Err(Block::RulesetHash);
    }
    Ok((s, promoted))
}

/// The event-chain headroom of a chained account: `seq + n` must not
/// overflow (`event::advance` → the handler's `Overflow`).
fn chain_headroom(d: &[u8], n: u64, what: &'static str) -> Result<(), Block> {
    let seq = rd_u64(d, header::EVENT_SEQ).ok_or(Block::Unreadable(what))?;
    seq.checked_add(n)
        .map(|_| ())
        .ok_or(Block::ChainOverflow(what))
}

/// A wide province of this season and world at `a`, canonical; `None`
/// when absent.
fn province_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    ctx: &AddrCtx,
    a: &Address,
    season_id: u64,
    world: WorldId,
    what: &'static str,
) -> Result<Option<(WideProvince, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, what)? else {
        return Ok(None);
    };
    let p = WideProvince::read(&acc.data).map_err(|_| Block::Unreadable(what))?;
    if p.season_id != season_id {
        return Err(Block::NotCanonical(what));
    }
    if p.world != world {
        return Err(Block::World);
    }
    if wl::province_address(ctx, p.coord) != a.to_bytes() {
        return Err(Block::NotCanonical(what));
    }
    Ok(Some((p, acc.data.as_slice())))
}

fn holding_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    ctx: &AddrCtx,
    a: &Address,
    season_id: u64,
    world: WorldId,
) -> Result<Option<(WideHolding, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "holding")? else {
        return Ok(None);
    };
    let h = WideHolding::read(&acc.data).map_err(|_| Block::Unreadable("holding"))?;
    if h.season_id != season_id {
        return Err(Block::NotCanonical("holding"));
    }
    if h.world != world {
        return Err(Block::World);
    }
    if wh::holding_address(ctx, h.coord, h.site) != a.to_bytes() {
        return Err(Block::NotCanonical("holding"));
    }
    Ok(Some((h, acc.data.as_slice())))
}

fn roster_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    a: &Address,
    season_id: u64,
    province: ProvinceKey,
) -> Result<Option<(WideRoster, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "roster")? else {
        return Ok(None);
    };
    let r = WideRoster::read(&acc.data).map_err(|_| Block::Unreadable("roster"))?;
    if r.season_id != season_id || r.province != province {
        return Err(Block::NotCanonical("roster"));
    }
    Ok(Some((r, acc.data.as_slice())))
}

fn transit_at(reads: &Reads, scope: &Scope, a: &Address) -> Result<Option<WideTransit>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "transit")? else {
        return Ok(None);
    };
    WideTransit::from_bytes(&acc.data)
        .map(Some)
        .map_err(|_| Block::Unreadable("transit"))
}

/// The handler's `capture_lock_of`: a live holding (provisional or final)
/// whose site mirror in `pd` shows a completed, unsettled capture is
/// locked.
fn capture_lock_of(pd: &[u8], hd: &[u8]) -> Result<(), Block> {
    let state = rd_u8(hd, H::STATE).ok_or(Block::Unreadable("holding"))?;
    if matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL) {
        let site = rd_u8(hd, H::SITE).ok_or(Block::Unreadable("holding"))?;
        let gen = rd_u8(hd, H::GEN).ok_or(Block::Unreadable("holding"))?;
        match capture_locked(pd, site, gen) {
            Some(false) => {}
            Some(true) => return Err(Block::CapturePending),
            None => return Err(Block::Unreadable("province")),
        }
    }
    Ok(())
}

/// Account metas from an ABI table and the keys in table order. The
/// optional groups are filled as far as the keys go.
fn metas(table: &[Group], keys: &[Address]) -> Vec<AccountMeta> {
    let specs: Vec<_> = table.iter().flat_map(|g| g.specs.iter()).collect();
    keys.iter()
        .zip(specs)
        .map(|(k, s)| AccountMeta {
            pubkey: *k,
            is_signer: s.signer,
            is_writable: matches!(s.wr, Wr::W),
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn candidate(
    scope: &Scope,
    reads: &Reads,
    payer: Address,
    duty: Duty,
    table: &[Group],
    keys: &[Address],
    data: Vec<u8>,
    status_promoted_by_clock: bool,
) -> Candidate {
    Candidate {
        duty,
        instruction: Instruction {
            program_id: scope.program,
            accounts: metas(table, keys),
            data,
        },
        payer,
        min_slot: reads.min_slot,
        observed_clock: reads.clock,
        coherent: false,
        status_promoted_by_clock,
        signed: false,
        automatic_send: AUTOMATIC_SEND,
    }
}

// ------------------------------------------------------------ SettleDeparture

/// Plans WideSettleDeparture for `host`'s march in `transit_slot` from the
/// reads, in the handler's order. Asks for the Season, the holding and the
/// transit record first; then the origin province and its roster.
pub fn plan_settle_departure(
    scope: &Scope,
    payer: Address,
    host: WideHostRef,
    transit_slot: u8,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if host.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    if transit_slot as usize >= H::TRANSIT_N {
        return Step::Done(Err(Block::BadSlot(transit_slot)));
    }
    let holding_key = wh::holding_address(&ctx, host.key().coord(), host.site());
    let holding_addr = addr(holding_key);
    let transit_addr = addr(wm::transit_address(&ctx, &holding_key, transit_slot));
    need!(reads, [scope.season, holding_addr, transit_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    // 1. the holding and its transit record.
    let (h, hd) = tri!(
        tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world))
            .ok_or(Block::Absent("holding"))
    );
    let t = tri!(tri!(transit_at(reads, scope, &transit_addr)).ok_or(Block::NoMarch));
    if t.host != host {
        return Step::Done(Err(Block::TransitOtherHost));
    }
    match t.state {
        MarchState::Departed => {}
        MarchState::Settled | MarchState::DestroyedAtOrigin => {
            return Step::Done(Err(Block::AlreadySettled(t.state)))
        }
        other => return Step::Done(Err(Block::TransitState(other))),
    }
    // 2. the origin province the record names, its roster, the entry.
    let okey = t.origin.key();
    if okey.world() != world {
        return Step::Done(Err(Block::World));
    }
    let origin_addr = addr(wl::province_address(&ctx, okey.coord()));
    let roster_addr = addr(wro::roster_address(&ctx, okey));
    need!(reads, [origin_addr, roster_addr]);
    let (oprov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &origin_addr,
        sid,
        world,
        "origin_province"
    ))
    .ok_or(Block::Absent("origin_province")));
    if oprov.coord != okey.coord() {
        return Step::Done(Err(Block::NotCanonical("origin_province")));
    }
    let origin_is_home = okey.coord() == h.coord;
    if origin_is_home {
        tri!(capture_lock_of(pd, hd));
    }
    let rn = tri!(rd_u32(pd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("origin_province")));
    if rn <= t.depart_bell {
        return Step::Done(Err(Block::TooEarly {
            resolved_next: rn,
            depart_bell: t.depart_bell,
        }));
    }
    let (roster, rd) =
        tri!(tri!(roster_at(reads, scope, &roster_addr, sid, okey)).ok_or(Block::Absent("roster")));
    let live = tri!(wres::live_ids(pd).map_err(|_| Block::RosterUnpaired));
    tri!(roster
        .validate_paired(rd, &live)
        .map_err(|_| Block::RosterUnpaired));
    let alias = wide_host_alias(&host);
    let i = tri!(find_entry(pd, alias).ok_or(Block::NotResident));
    let e = tri!(read_entry(pd, i).map_err(|_| Block::BadEntry));
    if !roster.entry_matches(rd, i, e.id, &host) {
        return Step::Done(Err(Block::EntryUnpaired));
    }
    if e.state != E::STATE_DEPARTED {
        return Step::Done(Err(Block::EntryState(e.state)));
    }
    let kh = tri!(e.to_host().map_err(|_| Block::BadEntry));
    let (troops, stamina) = tri!(kh
        .march_values(t.depart_bell, rn)
        .map_err(|er| Block::MarchValues(format!("{er:?}"))));
    // The handler's values: destroyed → zero troops and zero stamina stored.
    let predicted_destroyed = troops < DESTROYED_BELOW;
    let (troops_after, stamina_after) = if predicted_destroyed {
        (0, 0)
    } else {
        (troops, stamina)
    };
    let ready_bell_off = e
        .ready_bell
        .saturating_sub(t.depart_bell)
        .min(u16::MAX as u32) as u16;
    // The DepartureSettled record chains the origin and the holding once each.
    tri!(chain_headroom(pd, 1, "origin_province"));
    tri!(chain_headroom(hd, 1, "holding"));
    let facts = SettleFacts {
        host,
        transit_slot,
        origin: okey,
        depart_bell: t.depart_bell,
        resolved_next: rn,
        entry_index: i,
        kernel_troops_milli: troops,
        kernel_stamina: stamina,
        predicted_destroyed,
        troops_after_milli: troops_after,
        stamina_after,
        ready_bell_off,
        origin_is_home,
    };
    let keys = [
        payer,
        scope.season,
        origin_addr,
        holding_addr,
        roster_addr,
        transit_addr,
    ];
    let data = SettleDeparture {
        host: host.to_bytes(),
        transit_slot,
    }
    .to_bytes()
    .to_vec();
    Step::Done(Ok(candidate(
        scope,
        reads,
        payer,
        Duty::SettleDeparture(facts),
        wix::SETTLE_DEPARTURE,
        &keys,
        data,
        promoted,
    )))
}

// ------------------------------------------------------------ Return

/// Plans WideReturn of the departed Leave entries of `holding` (a holding
/// reference: coordinate and site; its generation is the reference's and
/// decides the credit, not the record's validity) standing in `standing`.
/// Asks for the Season, the province, its roster, the holding and the four
/// transit records; then, for a holding in another province, its own
/// province.
pub fn plan_return(
    scope: &Scope,
    payer: Address,
    standing: ProvinceKey,
    holding: WideHostRef,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if standing.world() != world || holding.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    let province_addr = addr(wl::province_address(&ctx, standing.coord()));
    let roster_addr = addr(wro::roster_address(&ctx, standing));
    let holding_key = wh::holding_address(&ctx, holding.key().coord(), holding.site());
    let holding_addr = addr(holding_key);
    let transit_addrs: [Address; H::TRANSIT_N] =
        std::array::from_fn(|s| addr(wm::transit_address(&ctx, &holding_key, s as u8)));
    let mut want = vec![scope.season, province_addr, roster_addr, holding_addr];
    want.extend_from_slice(&transit_addrs);
    need!(reads, want);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let (prov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &province_addr,
        sid,
        world,
        "province"
    ))
    .ok_or(Block::Absent("province")));
    if prov.coord != standing.coord() {
        return Step::Done(Err(Block::NotCanonical("province")));
    }
    let (roster, rd) =
        tri!(tri!(roster_at(reads, scope, &roster_addr, sid, standing)).ok_or(Block::NoRoster));
    let live_ids = tri!(wres::live_ids(pd).map_err(|_| Block::RosterUnpaired));
    tri!(roster
        .validate_paired(rd, &live_ids)
        .map_err(|_| Block::RosterUnpaired));
    // The holding: present (its live generation) or absent (its hosts
    // strand). The capture lock is read in the holding's **own** province.
    let held = tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world));
    let mut foreign = false;
    let mut own_addr: Option<Address> = None;
    let live = match &held {
        Some((h, hd)) => {
            if h.coord == standing.coord() {
                tri!(capture_lock_of(pd, hd));
            } else {
                let oa = addr(wl::province_address(&ctx, h.coord));
                need!(reads, [oa]);
                let (op, opd) = tri!(tri!(province_at(
                    reads,
                    scope,
                    &ctx,
                    &oa,
                    sid,
                    world,
                    "holding_province"
                ))
                .ok_or(Block::Absent("holding_province")));
                if op.coord != h.coord {
                    return Step::Done(Err(Block::NotCanonical("holding_province")));
                }
                tri!(capture_lock_of(opd, hd));
                foreign = true;
                own_addr = Some(oa);
            }
            let state = tri!(rd_u8(hd, H::STATE).ok_or(Block::Unreadable("holding")));
            matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL).then_some(h.gen)
        }
        None => None,
    };
    // The holding's four wide transit records, each absent or readable.
    let mut open: [Option<WideTransit>; H::TRANSIT_N] = [None; H::TRANSIT_N];
    for (s, a) in transit_addrs.iter().enumerate() {
        open[s] = tri!(transit_at(reads, scope, a));
    }
    // Selection, in entry order, by full identity.
    let mut picks: Vec<ReturnPick> = Vec::new();
    let mut skipped_in_transit = 0usize;
    for i in 0..PV::ENTRIES_N {
        let e = tri!(read_entry(pd, i).map_err(|_| Block::BadEntry));
        if e.state != E::STATE_DEPARTED || !matches!(e.op, EntryOp::Leave) {
            continue;
        }
        let r = tri!(
            tri!(roster.ref_at(rd, i).map_err(|_| Block::RosterUnpaired))
                .ok_or(Block::RosterUnpaired)
        );
        if wide_host_alias(&r) != e.id {
            return Step::Done(Err(Block::RosterUnpaired));
        }
        let mine = r.key().world() == world
            && wh::holding_address(&ctx, r.key().coord(), r.site()) == holding_key;
        if !mine {
            continue;
        }
        if open.iter().flatten().any(|t| t.host == r) {
            skipped_in_transit += 1;
            continue;
        }
        let credited = live == Some(r.gen());
        picks.push(ReturnPick {
            entry_index: i,
            host: r,
            credited,
            unit: e.unit,
            whole_troops: e.troops / MILLI as u32,
        });
        if picks.len() == RETURN_MAX {
            break;
        }
    }
    if picks.is_empty() {
        return Step::Done(Err(if skipped_in_transit > 0 {
            Block::HostInTransit
        } else {
            Block::NothingToReturn
        }));
    }
    // The reserve credit must fit (the handler's checked add).
    let credited = picks.iter().filter(|p| p.credited).count() as u64;
    if live.is_some() {
        let hd = held
            .as_ref()
            .map(|(_, d)| *d)
            .expect("live implies present");
        let mut reserve = [0u32; H::RESERVE_N];
        for (u, v) in reserve.iter_mut().enumerate() {
            *v = tri!(rd_u32(hd, H::reserve(u)).ok_or(Block::Unreadable("holding")));
        }
        for p in picks.iter().filter(|p| p.credited) {
            let slot = tri!(reserve.get_mut(p.unit as usize).ok_or(Block::BadEntry));
            *slot = tri!(slot
                .checked_add(p.whole_troops)
                .ok_or(Block::ReserveOverflow { unit: p.unit }));
        }
    }
    // The event chains: one record per picked entry on the province
    // (`Return` or `Stranded`), and the `Return` records also chain the
    // holding — one per credited entry.
    tri!(chain_headroom(pd, picks.len() as u64, "province"));
    if credited > 0 {
        let hd = held
            .as_ref()
            .map(|(_, d)| *d)
            .expect("credited implies present");
        tri!(chain_headroom(hd, credited, "holding"));
    }
    let facts = ReturnFacts {
        standing,
        holding: holding.holding_ref(),
        holding_present: held.is_some(),
        live_gen: live,
        foreign,
        picks,
        skipped_in_transit,
    };
    let mut keys = vec![
        payer,
        scope.season,
        province_addr,
        roster_addr,
        holding_addr,
    ];
    keys.extend_from_slice(&transit_addrs);
    if let Some(oa) = own_addr {
        keys.push(oa);
    }
    Step::Done(Ok(candidate(
        scope,
        reads,
        payer,
        Duty::Return(facts),
        wix::RETURN,
        &keys,
        Return.to_bytes().to_vec(),
        promoted,
    )))
}

// ------------------------------------------------------------ the read driver

/// Reads at least `min_slot` through the port and plans; the Clock is read
/// once, separately, and recorded as observed (never as coherent). Calls
/// only `clock` and `accounts`; never `simulate` or `send`.
async fn drive<P, F>(port: &P, min_slot: u64, mut plan: F) -> Result<Candidate, Block>
where
    P: ChainPort,
    F: FnMut(&Reads) -> Step<Candidate>,
{
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    for _ in 0..4 {
        match plan(&reads) {
            Step::Done(r) => return r,
            Step::Need(addrs) => {
                let got = port
                    .accounts(&addrs, min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                if got.len() != addrs.len() {
                    return Err(Block::Read("account count differs from the request".into()));
                }
                for (a, acc) in addrs.iter().zip(got) {
                    reads.accounts.insert(*a, acc);
                }
            }
        }
    }
    Err(Block::ReadLoop)
}

/// [`plan_settle_departure`] over live reads.
pub async fn settle_departure_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    host: WideHostRef,
    transit_slot: u8,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| {
        plan_settle_departure(scope, payer, host, transit_slot, r)
    })
    .await
}

/// [`plan_return`] over live reads.
pub async fn return_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    standing: ProvinceKey,
    holding: WideHostRef,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| {
        plan_return(scope, payer, standing, holding, r)
    })
    .await
}

// ------------------------------------------------------------ the observer tie

/// From the read-only discovery model: the `(host, transit slot)` pairs
/// whose `Departed` was seen and whose `DepartureSettled` was not, with
/// the march still open. A hint of what to **read**, not a duty: the plan
/// decides from the chain.
pub fn settle_candidates(d: &WideDiscovery) -> Vec<(WideHostRef, u8)> {
    d.hosts
        .iter()
        .filter_map(|(h, st)| {
            let t = st.transit.as_ref()?;
            (t.departure.is_some() && t.departure_settled.is_none() && t.open())
                .then_some((*h, t.slot))
        })
        .collect()
}

/// From the model: `(standing province, holding reference)` pairs with a
/// host whose last presence record was a Dissolve (a Leave pending), the
/// shape [`plan_return`] takes. Deduplicated; a hint only.
pub fn return_candidates(d: &WideDiscovery) -> Vec<(ProvinceKey, WideHostRef)> {
    let mut out: Vec<(ProvinceKey, WideHostRef)> = d
        .hosts
        .iter()
        .filter_map(|(h, st)| {
            matches!(st.presence, Presence::Dissolving { .. })
                .then_some((st.standing, h.holding_ref()))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}
