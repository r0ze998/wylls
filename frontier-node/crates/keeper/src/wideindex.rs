//! **Read-only observation** of the wide world (feature
//! `wide-world-experimental`): a bounded model of what the captured `PSW1`
//! records (version 0x82, `frontier_abi::world_index::event`) say about one
//! [`WorldId`] — the provinces they touched, the holdings and hosts by
//! **full reference** (never a `u64` alias: the `Muster` payload's alias is
//! not read), each host's transit slot, reveal and settlement, the arrival
//! slots, days and inputs by exact identity, and the closes — and what a
//! keeper would have to **read** before it could plan anything there.
//!
//! What this is not. It is not a duty and it authorizes nothing: the
//! keeper's own feed guard ([`crate::feedguard`]) still stops both legacy
//! indexes before the first `PSW1` record, the production debit gate stays
//! closed, and every answer here carries `automatic_writes: false` and
//! `source_complete: false` — the model never knows that the history it
//! was given is the whole history. A caller may record the **feed horizon**
//! it observed ([`WideDiscovery::observe_horizon`]); that is an observation
//! about the feed, not a completeness claim, and it changes no answer's
//! authority. An observation with nothing seen is "none observed in the
//! applied history", never "none exist": the arrival evidence stays the
//! chain's ArrivalDay account, which the read plan asks for.
//!
//! Inputs are **already authenticated** bodies: a caller hands over one
//! successful transaction's `PSW1` bodies with the source sequence and a
//! provenance [`Scope`] ([`WideBatch`]), or a whole feed `TxRecord` through
//! the frame-checked adapter ([`observe_tx`], `fclient::typed_log`), which
//! never turns a rolled-back transaction or a failed CPI subtree into a wide
//! event. The model verifies no event chain (the typed reader's job), reads
//! no account, sends nothing, and emits no instruction: its plans are
//! read-account requirements ([`ReadRequirement`]) only.
//!
//! **Bounded and atomic.** Every cap ([`Limits`]) is checked before a batch
//! changes anything: the input (bodies per batch, bytes) up front, and the
//! state (every map, the anomalies, the superseded marches per host) on a
//! staged copy before it replaces the model. A cap exceeded refuses the
//! batch and **blocks** the model: nothing is evicted to make room, no
//! identity or cursor history is dropped silently. **Monotonic.** Batches
//! apply in strictly increasing source sequence. A batch at or below the
//! cursor is matched against a bounded fingerprint window: the identical
//! batch is an idempotent no-op (`replay`), a different batch at a known
//! sequence **blocks** (the source contradicts itself), and a sequence the
//! window no longer holds **blocks** too (its content cannot be judged). A
//! body of another version, a malformed body, or a key of another world
//! than the scope's blocks as well. There is no reset.
//!
//! **Terminal evidence is kept.** A record attributed to a closed province,
//! a reveal into a closed slot, a gather into closed inputs or a second
//! close of the same account never overwrites the close: the first close
//! stays, the later activity is counted on the account (`after_close`) and
//! recorded as an [`Anomaly`]. A close whose reveal or gather is not in the
//! applied history still creates the account's entry with its exact
//! identity and rent facts, and the plan asks to read it.
//!
//! **No inference from omitted fields.** A `Departed` carries the seal root,
//! not the commitment or the seal; a `Revealed` carries the slot facts and
//! the bell it was logged at, not the arrival bell (taken from the host's
//! `Departed` of the same transit slot when present, else the slot is not
//! indexed); a `TransitSettled` carries the verdict and payments, not the
//! account bytes. [`WideDiscovery::settlement_inputs`] lists, per host, what
//! a future keeper settlement would still have to obtain and from where.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::event::{EventError, WideKind, WideRecord, MAX_BODY};
use frontier_abi::world_index::{
    arrival as wa, holding as wh, land as wl, march as wm, roster as wro, ProvinceKey, WideHostRef,
    WorldId,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

// ------------------------------------------------------------ inputs

/// The provenance a caller asserts for every batch it supplies: the program
/// whose invocation frame logged the bodies, the Season PDA their accounts
/// hang off, the one world the model is scoped to, and how the bodies were
/// authenticated (free text, recorded verbatim in the coverage).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub program: Address,
    pub season: Address,
    pub world: WorldId,
    pub source: String,
}

/// One successful transaction's `PSW1` bodies, in log order, as the caller
/// authenticated them (the bodies after the `PSW1` prefix, each starting
/// with the version byte).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideBatch {
    /// The source sequence (the feed's transaction sequence).
    pub seq: u64,
    pub slot: u64,
    pub signature: String,
    pub bodies: Vec<Vec<u8>>,
}

/// The caps (module doc). Every cap is enforced before a batch changes the
/// model; exceeding one refuses the batch and blocks the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_bodies_per_batch: usize,
    pub max_body_bytes: usize,
    pub max_batch_bytes: usize,
    pub max_provinces: usize,
    pub max_holdings: usize,
    pub max_hosts: usize,
    pub max_slots: usize,
    pub max_days: usize,
    pub max_inputs: usize,
    pub max_anomalies: usize,
    /// Aggregate entries in province record/bell/host maps, holding host
    /// sets and day bell sets. No nested identity is silently evicted.
    pub max_nested_entries: usize,
    pub max_superseded_per_host: usize,
    /// The replay fingerprint window (the oldest fingerprints beyond it are
    /// forgotten; a replay of a forgotten sequence blocks).
    pub max_fingerprints: usize,
}

impl Default for Limits {
    /// Conservative defaults: a season's worth of a small world, not a
    /// public feed's.
    fn default() -> Self {
        Limits {
            max_bodies_per_batch: 64,
            max_body_bytes: MAX_BODY,
            max_batch_bytes: 64 * MAX_BODY,
            max_provinces: 4_096,
            max_holdings: 16_384,
            max_hosts: 65_536,
            max_slots: 65_536,
            max_days: 16_384,
            max_inputs: 16_384,
            max_anomalies: 4_096,
            max_nested_entries: 262_144,
            max_superseded_per_host: 8,
            max_fingerprints: 4_096,
        }
    }
}

// ------------------------------------------------------------ refusals

/// Why a batch was not applied. Nothing of a refused batch is applied. The
/// variants marked *blocks* leave the model blocked for good.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The model is blocked since `since_seq` (sticky).
    Blocked { since_seq: u64, reason: String },
    /// No body.
    Empty { seq: u64 },
    /// Zero is the feed start cursor, never a transaction (*blocks*).
    InvalidSequence { seq: u64 },
    /// `seq` is at or below the cursor and differs from the batch recorded
    /// there (*blocks*: the source contradicts itself).
    ReplayConflict { seq: u64 },
    /// `seq` is at or below the cursor and no fingerprint is held for it
    /// (*blocks*: its content cannot be judged).
    ReplayUnknown { seq: u64, cursor: u64 },
    /// An input or state cap (*blocks*): `what` would need `needed` against
    /// the cap `limit`.
    Limit {
        seq: u64,
        what: &'static str,
        limit: usize,
        needed: usize,
    },
    /// A key of body `body` names another world than the scope's (*blocks*).
    WrongWorld {
        seq: u64,
        body: usize,
        found: [u8; 32],
    },
    /// Body `body` is of another version (*blocks*).
    Version {
        seq: u64,
        body: usize,
        error: EventError,
    },
    /// Body `body` does not decode under version 0x82 (*blocks*).
    Malformed {
        seq: u64,
        body: usize,
        error: EventError,
    },
    /// A horizon below the cursor (nothing recorded).
    HorizonBehind { through_seq: u64, cursor: u64 },
}

/// The first blocking refusal, kept for good.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocker {
    pub seq: u64,
    pub slot: u64,
    pub signature: String,
    pub body: Option<usize>,
    pub reason: String,
}

/// What one applied batch touched (`replay`: an identical batch at a known
/// sequence, applied as a no-op).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub seq: u64,
    pub records: usize,
    pub replay: bool,
    pub provinces: BTreeSet<ProvinceKey>,
    pub hosts: BTreeSet<WideHostRef>,
}

// ------------------------------------------------------------ state

/// A close observed: who the account went to and how much.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseInfo {
    pub rent_to: [u8; 32],
    pub lamports: u64,
    pub seq: u64,
}

/// What the records say about one province of the world.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProvinceState {
    /// The last source sequence of a record attributed here.
    pub last_seq: u64,
    /// Records attributed here, by kind.
    pub records: BTreeMap<u8, u32>,
    /// Bells whose `Resolve` record was seen here.
    pub resolved_bells: BTreeSet<u32>,
    /// Bells whose `Gathered` record was seen here.
    pub gathered_bells: BTreeSet<u32>,
    /// Hosts that mustered, returned or were stranded here, or whose
    /// departure or settlement was attributed here.
    pub hosts: BTreeSet<WideHostRef>,
    pub roster_closed: Option<CloseInfo>,
    /// `ProvinceClosed`: the fund it went into and the lamports. Never
    /// overwritten.
    pub closed: Option<CloseInfo>,
    /// Records attributed here after `closed` (preserved ambiguity).
    pub after_close: u32,
}

/// What the records say about one holding (by its reference: site and
/// generation, sequence 0).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HoldingState {
    pub last_seq: u64,
    /// Hosts this holding issued, by full reference.
    pub hosts: BTreeSet<WideHostRef>,
}

/// Where a host stands, as far as its records say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// No muster, return or dissolve of this host was seen.
    Unknown,
    Mustered {
        bell: u32,
        entry: u8,
    },
    Dissolving {
        pend_bell: u32,
        entry: u8,
    },
    Returned {
        credited_milli: u32,
        entry: u8,
    },
    Stranded {
        troops_lost_milli: u32,
        entry: u8,
    },
}

/// A departure as its `Departed` record announced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Departure {
    pub seq: u64,
    pub origin: ProvinceKey,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub dep_mass_milli: u32,
    pub march_stamina: u16,
    pub tip: u64,
    pub fee: u64,
    pub bond: u64,
    pub seal_root: [u8; 32],
}

/// A `DepartureSettled` record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepartureSettled {
    pub seq: u64,
    pub destroyed: u8,
    pub troops_after_milli: u32,
    pub stamina_after: u16,
    pub ready_bell_off: u16,
    pub entry: u8,
}

/// A `Revealed` record: the slot the host holds at its destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reveal {
    pub seq: u64,
    pub dest: ProvinceKey,
    /// The slot's arrival bell — **not** in the record (its own bell is
    /// the bell it was logged at): taken from the host's `Departed` record
    /// of the same transit slot when that is in the applied history,
    /// `None` otherwise (then the slot is not indexed; an [`Anomaly`]).
    pub arrive_bell: Option<u32>,
    pub faction: u8,
    pub i: u8,
    pub tile: u8,
    pub stance: u8,
    pub retreat_bps: u16,
    pub dep_mass_milli: u32,
    /// The reveal displaced a previous occupant of the slot (which one, the
    /// record does not say).
    pub displaced: bool,
    /// The bell the record was logged at (not the arrival bell).
    pub logged_bell: u32,
}

/// A `TransitSettled` record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub seq: u64,
    /// The province the settlement was attributed to (the destination, or
    /// the home when the sealed destination was never opened).
    pub judged_at: ProvinceKey,
    /// The destination the seal named (kept whatever `judged_at` is).
    pub sealed_dest: ProvinceKey,
    pub outcome: u8,
    pub seal_code: u8,
    pub troops_milli: u32,
    pub tip: u64,
    pub fee: u64,
    pub bond: u64,
    pub home_credited: bool,
    pub logged_bell: u32,
}

/// One host's march, by its transit slot, as far as the records say. A
/// stage seen without its departure leaves `departure` empty and an
/// [`Anomaly`] (the history before it is not in the applied batches).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Transit {
    pub slot: u8,
    pub departure: Option<Departure>,
    pub departure_settled: Option<DepartureSettled>,
    pub reveal: Option<Reveal>,
    pub settled: Option<Settlement>,
    /// `TransitClosed`: the record left open at season end, closed. Never
    /// overwritten.
    pub closed: Option<CloseInfo>,
    /// Stages seen after `settled` or `closed` (preserved ambiguity).
    pub after_close: u32,
}

impl Transit {
    /// Neither settled nor closed: the record is (as far as the records
    /// say) still an account.
    pub fn open(&self) -> bool {
        self.settled.is_none() && self.closed.is_none()
    }
}

/// What the records say about one host (by full reference).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostState {
    pub last_seq: u64,
    /// The province the host's last record happened in.
    pub standing: ProvinceKey,
    pub presence: Presence,
    /// The host's march, if any record of one was seen (the latest slot).
    pub transit: Option<Transit>,
    /// Marches whose records were superseded by a later departure (capped
    /// by `Limits::max_superseded_per_host`).
    pub superseded: Vec<Transit>,
}

/// A wide ArrivalSlot by its exact identity `(destination, arrival bell,
/// faction, index)`: its reveal when one is in the applied history, its
/// close when one was observed (a close alone still creates the entry).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SlotState {
    pub host: Option<WideHostRef>,
    pub transit_slot: Option<u8>,
    pub reveal: Option<Reveal>,
    /// `RecordClosed` (what 2). Never overwritten.
    pub closed: Option<CloseInfo>,
    /// Reveals or closes seen after `closed` (preserved ambiguity).
    pub after_close: u32,
}

/// A wide ArrivalDay by `(destination, day)`: the bells of its day that
/// reveals or gathers named, its close when observed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DayState {
    pub bells_seen: BTreeSet<u32>,
    /// `RecordClosed` (what 3). Never overwritten.
    pub closed: Option<CloseInfo>,
    pub after_close: u32,
}

/// A wide ClashInputs as its `Gathered` records left it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputsState {
    pub last_seq: u64,
    pub gathers: u32,
    pub arrivals_mask: u32,
    pub n_present: u8,
    pub no_arrivals: bool,
    /// `RecordClosed` (what 4). Never overwritten.
    pub closed: Option<CloseInfo>,
    pub after_close: u32,
}

/// A record that does not fit what was seen before it. Never a refusal
/// (the chain is authoritative); the state keeps the earlier terminal
/// evidence and the anomaly says where the applied history is not the
/// whole story.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anomaly {
    pub seq: u64,
    pub host: Option<WideHostRef>,
    pub province: Option<ProvinceKey>,
    pub what: &'static str,
}

/// The feed horizon a caller observed (an empty page at `through_seq`, on
/// `source`'s authority). An observation about the feed the caller read;
/// **not** a claim that the history is complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Horizon {
    pub through_seq: u64,
    pub source: String,
}

/// How much of the history the model has, and how little it claims.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    pub world: [u8; 32],
    pub source: String,
    pub batches: u64,
    pub records: u64,
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
    pub horizon: Option<Horizon>,
    pub blocked: Option<Blocker>,
    pub anomalies: usize,
    pub fingerprints: usize,
    /// Always `false`: the model cannot know the source is complete.
    pub source_complete: bool,
    /// Always `false`: the model authorizes nothing.
    pub automatic_writes: bool,
}

/// An answer about what the applied history shows. `seen` is what was
/// observed; it is never authoritative about what exists: `source_complete`
/// is always `false`, and `blocked` says the history stopped being
/// trustworthy at the model's blocker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation<T> {
    pub seen: T,
    pub observed_through: Option<u64>,
    pub horizon: Option<u64>,
    pub source_complete: bool,
    pub blocked: bool,
}

// ------------------------------------------------------------ plans

/// A wide account a keeper would have to read, by identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum WideAccount {
    Province(ProvinceKey),
    Roster(ProvinceKey),
    /// By the holding's reference (site, generation, sequence 0).
    Holding(WideHostRef),
    /// The holding's transit record of a slot.
    Transit(WideHostRef, u8),
    ArrivalSlot(ProvinceKey, u32, u8, u8),
    ArrivalDay(ProvinceKey, u32),
    ClashInputs(ProvinceKey, u32),
}

/// A read requirement: the account, its canonical address under the
/// scope's Season and program (public PDA arithmetic), and why. Never an
/// instruction, never a signer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadRequirement {
    pub account: WideAccount,
    pub address: Address,
    pub why: &'static str,
}

/// What a future keeper settlement of a host's march has from the records,
/// and what it would still have to obtain. The model never plans a
/// settlement; this is the gap list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementInputs {
    pub host: WideHostRef,
    pub transit_slot: u8,
    pub have: Vec<&'static str>,
    pub missing: Vec<&'static str>,
}

// ------------------------------------------------------------ parsing

/// One record of the scope's world, parsed from its fields and nothing
/// else.
#[derive(Clone, Debug)]
enum Ev {
    Muster {
        host: WideHostRef,
        standing: ProvinceKey,
        bell: u32,
        entry: u8,
    },
    Dissolve {
        host: WideHostRef,
        standing: ProvinceKey,
        pend_bell: u32,
        entry: u8,
    },
    Resolve {
        province: ProvinceKey,
        bell: u32,
    },
    Return {
        host: WideHostRef,
        standing: ProvinceKey,
        credited: u32,
        entry: u8,
    },
    Stranded {
        host: WideHostRef,
        standing: ProvinceKey,
        troops_lost: u32,
        entry: u8,
    },
    RosterClosed {
        province: ProvinceKey,
        close: CloseInfo,
    },
    Departed {
        host: WideHostRef,
        slot: u8,
        departure: Departure,
    },
    TransitSettled {
        host: WideHostRef,
        slot: u8,
        settlement: Settlement,
    },
    DepartureSettled {
        host: WideHostRef,
        origin: ProvinceKey,
        slot: u8,
        settled: DepartureSettled,
    },
    Revealed {
        host: WideHostRef,
        slot: u8,
        reveal: Reveal,
    },
    Gathered {
        dest: ProvinceKey,
        bell: u32,
        arrivals_mask: u32,
        n_present: u8,
        no_arrivals: bool,
    },
    RecordClosed {
        dest: ProvinceKey,
        what: u8,
        bell: u32,
        faction: u8,
        i: u8,
        close: CloseInfo,
    },
    TransitClosed {
        host: WideHostRef,
        home: ProvinceKey,
        slot: u8,
        close: CloseInfo,
    },
    ProvinceClosed {
        province: ProvinceKey,
        close: CloseInfo,
    },
}

fn u16_at(p: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(p.get(o..o + 2)?.try_into().ok()?))
}
fn u32_at(p: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(p.get(o..o + 4)?.try_into().ok()?))
}
fn u64_at(p: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(p.get(o..o + 8)?.try_into().ok()?))
}
fn arr32_at(p: &[u8], o: usize) -> Option<[u8; 32]> {
    p.get(o..o + 32)?.try_into().ok()
}
fn u8_at(p: &[u8], o: usize) -> Option<u8> {
    p.get(o).copied()
}

/// Parses one decoded record into an event of the world `world`, or the
/// reason it is refused: another world (`Err(Some(found))`) or a payload
/// the kind's width does not explain (`Err(None)`, impossible after
/// `decode` but never assumed).
fn parse(r: &WideRecord<'_>, seq: u64, world: WorldId) -> Result<Ev, Option<[u8; 32]>> {
    let p = r.payload;
    let same = |k: ProvinceKey| -> Result<ProvinceKey, Option<[u8; 32]>> {
        if k.world() == world {
            Ok(k)
        } else {
            Err(Some(*k.world().as_bytes()))
        }
    };
    let host_and_standing = || -> Result<(WideHostRef, ProvinceKey), Option<[u8; 32]>> {
        let h = r.host().ok_or(None)?;
        same(h.key())?;
        let s = same(r.standing().ok_or(None)?)?;
        Ok((h, s))
    };
    let province = || -> Result<ProvinceKey, Option<[u8; 32]>> { same(r.province().ok_or(None)?) };
    let close_at = |o: usize| -> Option<CloseInfo> {
        Some(CloseInfo {
            rent_to: arr32_at(p, o)?,
            lamports: u64_at(p, o + 32)?,
            seq,
        })
    };
    Ok(match r.kind {
        WideKind::Muster => {
            let (host, standing) = host_and_standing()?;
            // `alias u64` at offset 7 is deliberately not read.
            Ev::Muster {
                host,
                standing,
                bell: r.bell,
                entry: u8_at(p, 6).ok_or(None)?,
            }
        }
        WideKind::Dissolve => {
            let (host, standing) = host_and_standing()?;
            Ev::Dissolve {
                host,
                standing,
                pend_bell: u32_at(p, 0).ok_or(None)?,
                entry: u8_at(p, 8).ok_or(None)?,
            }
        }
        WideKind::Resolve => Ev::Resolve {
            province: province()?,
            bell: r.bell,
        },
        WideKind::Return => {
            let (host, standing) = host_and_standing()?;
            Ev::Return {
                host,
                standing,
                credited: u32_at(p, 0).ok_or(None)?,
                entry: u8_at(p, 5).ok_or(None)?,
            }
        }
        WideKind::Stranded => {
            let (host, standing) = host_and_standing()?;
            Ev::Stranded {
                host,
                standing,
                troops_lost: u32_at(p, 0).ok_or(None)?,
                entry: u8_at(p, 4).ok_or(None)?,
            }
        }
        WideKind::RosterClosed => Ev::RosterClosed {
            province: province()?,
            close: close_at(0).ok_or(None)?,
        },
        WideKind::Departed => {
            let (host, origin) = host_and_standing()?;
            Ev::Departed {
                host,
                slot: u8_at(p, 0).ok_or(None)?,
                departure: Departure {
                    seq,
                    origin,
                    depart_bell: u32_at(p, 1).ok_or(None)?,
                    arrive_bell: u32_at(p, 5).ok_or(None)?,
                    dep_mass_milli: u32_at(p, 9).ok_or(None)?,
                    march_stamina: u16_at(p, 13).ok_or(None)?,
                    tip: u64_at(p, 15).ok_or(None)?,
                    fee: u64_at(p, 23).ok_or(None)?,
                    bond: u64_at(p, 31).ok_or(None)?,
                    seal_root: arr32_at(p, 39).ok_or(None)?,
                },
            }
        }
        WideKind::TransitSettled => {
            let (host, judged_at) = host_and_standing()?;
            let sealed_dest = same(r.sealed_dest().ok_or(None)?)?;
            Ev::TransitSettled {
                host,
                slot: u8_at(p, 0).ok_or(None)?,
                settlement: Settlement {
                    seq,
                    judged_at,
                    sealed_dest,
                    outcome: u8_at(p, 1).ok_or(None)?,
                    seal_code: u8_at(p, 2).ok_or(None)?,
                    troops_milli: u32_at(p, 3).ok_or(None)?,
                    tip: u64_at(p, 7).ok_or(None)?,
                    fee: u64_at(p, 15).ok_or(None)?,
                    bond: u64_at(p, 23).ok_or(None)?,
                    home_credited: u8_at(p, 31).ok_or(None)? != 0,
                    logged_bell: r.bell,
                },
            }
        }
        WideKind::DepartureSettled => {
            let (host, origin) = host_and_standing()?;
            Ev::DepartureSettled {
                host,
                origin,
                slot: u8_at(p, 0).ok_or(None)?,
                settled: DepartureSettled {
                    seq,
                    destroyed: u8_at(p, 1).ok_or(None)?,
                    troops_after_milli: u32_at(p, 2).ok_or(None)?,
                    stamina_after: u16_at(p, 6).ok_or(None)?,
                    ready_bell_off: u16_at(p, 8).ok_or(None)?,
                    entry: u8_at(p, 10).ok_or(None)?,
                },
            }
        }
        WideKind::Revealed => {
            let (host, dest) = host_and_standing()?;
            Ev::Revealed {
                host,
                slot: u8_at(p, 0).ok_or(None)?,
                reveal: Reveal {
                    seq,
                    dest,
                    arrive_bell: None,
                    faction: u8_at(p, 1).ok_or(None)?,
                    i: u8_at(p, 2).ok_or(None)?,
                    tile: u8_at(p, 3).ok_or(None)?,
                    stance: u8_at(p, 4).ok_or(None)?,
                    retreat_bps: u16_at(p, 5).ok_or(None)?,
                    dep_mass_milli: u32_at(p, 7).ok_or(None)?,
                    displaced: u8_at(p, 11).ok_or(None)? != 0,
                    logged_bell: r.bell,
                },
            }
        }
        WideKind::Gathered => Ev::Gathered {
            dest: province()?,
            bell: u32_at(p, 0).ok_or(None)?,
            arrivals_mask: u32_at(p, 6).ok_or(None)?,
            n_present: u8_at(p, 10).ok_or(None)?,
            no_arrivals: u8_at(p, 11).ok_or(None)? != 0,
        },
        WideKind::RecordClosed => Ev::RecordClosed {
            dest: province()?,
            what: u8_at(p, 0).ok_or(None)?,
            bell: u32_at(p, 1).ok_or(None)?,
            faction: u8_at(p, 5).ok_or(None)?,
            i: u8_at(p, 6).ok_or(None)?,
            close: close_at(7).ok_or(None)?,
        },
        WideKind::TransitClosed => {
            let (host, home) = host_and_standing()?;
            Ev::TransitClosed {
                host,
                home,
                slot: u8_at(p, 0).ok_or(None)?,
                close: close_at(1).ok_or(None)?,
            }
        }
        WideKind::ProvinceClosed => Ev::ProvinceClosed {
            province: province()?,
            close: close_at(0).ok_or(None)?,
        },
    })
}

/// The fingerprint of a batch's content at its sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    slot: u64,
    signature: String,
    digest: [u8; 32],
}

fn fingerprint(batch: &WideBatch) -> Fingerprint {
    let mut h = Sha256::new();
    for b in &batch.bodies {
        h.update((b.len() as u64).to_le_bytes());
        h.update(b);
    }
    Fingerprint {
        slot: batch.slot,
        signature: batch.signature.clone(),
        digest: h.finalize().into(),
    }
}

// ------------------------------------------------------------ the model

/// The discovery model of one world (module doc).
#[derive(Clone)]
pub struct WideDiscovery {
    scope: Scope,
    ctx: AddrCtx,
    limits: Limits,
    cursor: Option<u64>,
    first_seq: Option<u64>,
    batches: u64,
    records: u64,
    blocked: Option<Blocker>,
    horizon: Option<Horizon>,
    fingerprints: BTreeMap<u64, Fingerprint>,
    pub provinces: BTreeMap<ProvinceKey, ProvinceState>,
    pub holdings: BTreeMap<WideHostRef, HoldingState>,
    pub hosts: BTreeMap<WideHostRef, HostState>,
    /// `(destination, arrival bell, faction, i)` → the slot.
    pub slots: BTreeMap<(ProvinceKey, u32, u8, u8), SlotState>,
    /// `(destination, day)` → the ArrivalDay.
    pub days: BTreeMap<(ProvinceKey, u32), DayState>,
    /// `(destination, bell)` → the gathered record.
    pub inputs: BTreeMap<(ProvinceKey, u32), InputsState>,
    pub anomalies: Vec<Anomaly>,
}

impl WideDiscovery {
    /// An empty model of `scope`'s world under `limits`, blocked by
    /// nothing, complete about nothing.
    pub fn new(scope: Scope, limits: Limits) -> WideDiscovery {
        let ctx = AddrCtx {
            season: scope.season.to_bytes(),
            program: scope.program.to_bytes(),
        };
        WideDiscovery {
            scope,
            ctx,
            limits,
            cursor: None,
            first_seq: None,
            batches: 0,
            records: 0,
            blocked: None,
            horizon: None,
            fingerprints: BTreeMap::new(),
            provinces: BTreeMap::new(),
            holdings: BTreeMap::new(),
            hosts: BTreeMap::new(),
            slots: BTreeMap::new(),
            days: BTreeMap::new(),
            inputs: BTreeMap::new(),
            anomalies: Vec::new(),
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// The last applied source sequence.
    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }

    pub fn blocked(&self) -> Option<&Blocker> {
        self.blocked.as_ref()
    }

    pub fn coverage(&self) -> Coverage {
        Coverage {
            world: *self.scope.world.as_bytes(),
            source: self.scope.source.clone(),
            batches: self.batches,
            records: self.records,
            first_seq: self.first_seq,
            last_seq: self.cursor,
            horizon: self.horizon.clone(),
            blocked: self.blocked.clone(),
            anomalies: self.anomalies.len(),
            fingerprints: self.fingerprints.len(),
            source_complete: false,
            automatic_writes: false,
        }
    }

    /// Records the feed horizon the caller observed (module doc): an
    /// observation, not a completeness claim; it authorizes nothing and
    /// changes no answer's authority. Refused below the cursor.
    pub fn observe_horizon(&mut self, through_seq: u64, source: &str) -> Result<(), Refusal> {
        if let Some(c) = self.cursor {
            if through_seq < c {
                return Err(Refusal::HorizonBehind {
                    through_seq,
                    cursor: c,
                });
            }
        }
        self.horizon = Some(Horizon {
            through_seq,
            source: source.to_owned(),
        });
        Ok(())
    }

    /// Blocks the model from `seq` on for a reason found outside it (the
    /// adapter's frame decoding). Sticky; the first blocker stays.
    pub fn block_external(&mut self, seq: u64, slot: u64, signature: &str, reason: String) {
        if self.blocked.is_none() {
            self.blocked = Some(Blocker {
                seq,
                slot,
                signature: signature.to_owned(),
                body: None,
                reason,
            });
        }
    }

    fn block(&mut self, batch: &WideBatch, body: Option<usize>, reason: String) {
        if self.blocked.is_none() {
            self.blocked = Some(Blocker {
                seq: batch.seq,
                slot: batch.slot,
                signature: batch.signature.clone(),
                body,
                reason,
            });
        }
    }

    fn refuse_blocked(&self) -> Option<Refusal> {
        self.blocked.as_ref().map(|b| Refusal::Blocked {
            since_seq: b.seq,
            reason: b.reason.clone(),
        })
    }

    /// Applies one batch (module doc): the caps first, the sequence against
    /// the fingerprint window, every body decoded and parsed, then the
    /// state on a staged copy checked against the state caps before it
    /// replaces the model. `Err` applies nothing; the blocking refusals
    /// also block the model.
    pub fn apply(&mut self, batch: &WideBatch) -> Result<Applied, Refusal> {
        if let Some(r) = self.refuse_blocked() {
            return Err(r);
        }
        if batch.seq == 0 {
            self.block(batch, None, "zero is not a transaction sequence".into());
            return Err(Refusal::InvalidSequence { seq: 0 });
        }
        if batch.bodies.is_empty() {
            return Err(Refusal::Empty { seq: batch.seq });
        }
        // 1. the input caps.
        let caps = [
            (
                "bodies per batch",
                self.limits.max_bodies_per_batch,
                batch.bodies.len(),
            ),
            (
                "bytes of one body",
                self.limits.max_body_bytes,
                batch.bodies.iter().map(Vec::len).max().unwrap_or(0),
            ),
            (
                "bytes of the batch",
                self.limits.max_batch_bytes,
                batch.bodies.iter().map(Vec::len).sum(),
            ),
        ];
        for (what, limit, needed) in caps {
            if needed > limit {
                self.block(
                    batch,
                    None,
                    format!("{what}: {needed} over the cap {limit}"),
                );
                return Err(Refusal::Limit {
                    seq: batch.seq,
                    what,
                    limit,
                    needed,
                });
            }
        }
        // 2. the sequence.
        let fp = fingerprint(batch);
        if let Some(c) = self.cursor {
            if batch.seq <= c {
                return match self.fingerprints.get(&batch.seq) {
                    Some(known) if *known == fp => Ok(Applied {
                        seq: batch.seq,
                        replay: true,
                        ..Applied::default()
                    }),
                    Some(_) => {
                        self.block(
                            batch,
                            None,
                            "a different batch at an already applied sequence".into(),
                        );
                        Err(Refusal::ReplayConflict { seq: batch.seq })
                    }
                    None => {
                        self.block(
                            batch,
                            None,
                            "a replay of a sequence whose content is no longer held".into(),
                        );
                        Err(Refusal::ReplayUnknown {
                            seq: batch.seq,
                            cursor: c,
                        })
                    }
                };
            }
        }
        // 3. every body, before any state changes.
        let mut events = Vec::with_capacity(batch.bodies.len());
        for (i, body) in batch.bodies.iter().enumerate() {
            let r = match WideRecord::decode(body) {
                Ok(r) => r,
                Err(e @ (EventError::Version(_) | EventError::RetiredVersion(_))) => {
                    self.block(batch, Some(i), format!("unsupported PSW1 version: {e:?}"));
                    return Err(Refusal::Version {
                        seq: batch.seq,
                        body: i,
                        error: e,
                    });
                }
                Err(e) => {
                    self.block(batch, Some(i), format!("malformed PSW1 body: {e:?}"));
                    return Err(Refusal::Malformed {
                        seq: batch.seq,
                        body: i,
                        error: e,
                    });
                }
            };
            match parse(&r, batch.seq, self.scope.world) {
                Ok(ev) => events.push(ev),
                Err(Some(found)) => {
                    self.block(batch, Some(i), "a key of another world".into());
                    return Err(Refusal::WrongWorld {
                        seq: batch.seq,
                        body: i,
                        found,
                    });
                }
                Err(None) => {
                    self.block(batch, Some(i), "payload shorter than its kind".into());
                    return Err(Refusal::Malformed {
                        seq: batch.seq,
                        body: i,
                        error: EventError::Short,
                    });
                }
            }
        }
        // 4. the state, staged.
        let mut staged = self.clone();
        let mut applied = Applied {
            seq: batch.seq,
            records: events.len(),
            ..Applied::default()
        };
        for ev in events {
            staged.step(batch.seq, ev, &mut applied);
        }
        let superseded_max = staged
            .hosts
            .values()
            .map(|h| h.superseded.len())
            .max()
            .unwrap_or(0);
        // Every nested collection is covered, including the otherwise
        // unbounded resolve bells and historical host/province associations.
        let nested_entries = staged
            .provinces
            .values()
            .map(|p| {
                p.records.len() + p.resolved_bells.len() + p.gathered_bells.len() + p.hosts.len()
            })
            .chain(staged.holdings.values().map(|h| h.hosts.len()))
            .chain(staged.days.values().map(|d| d.bells_seen.len()))
            .fold(0usize, usize::saturating_add);
        let state_caps = [
            (
                "provinces",
                self.limits.max_provinces,
                staged.provinces.len(),
            ),
            ("holdings", self.limits.max_holdings, staged.holdings.len()),
            ("hosts", self.limits.max_hosts, staged.hosts.len()),
            ("slots", self.limits.max_slots, staged.slots.len()),
            ("days", self.limits.max_days, staged.days.len()),
            ("inputs", self.limits.max_inputs, staged.inputs.len()),
            (
                "anomalies",
                self.limits.max_anomalies,
                staged.anomalies.len(),
            ),
            (
                "nested entries",
                self.limits.max_nested_entries,
                nested_entries,
            ),
            (
                "superseded marches of one host",
                self.limits.max_superseded_per_host,
                superseded_max,
            ),
        ];
        for (what, limit, needed) in state_caps {
            if needed > limit {
                self.block(
                    batch,
                    None,
                    format!("{what}: {needed} over the cap {limit}"),
                );
                return Err(Refusal::Limit {
                    seq: batch.seq,
                    what,
                    limit,
                    needed,
                });
            }
        }
        // 5. commit.
        staged.cursor = Some(batch.seq);
        staged.first_seq.get_or_insert(batch.seq);
        staged.batches += 1;
        staged.records += applied.records as u64;
        staged.fingerprints.insert(batch.seq, fp);
        while staged.fingerprints.len() > self.limits.max_fingerprints {
            staged.fingerprints.pop_first();
        }
        *self = staged;
        Ok(applied)
    }

    fn note(
        &mut self,
        seq: u64,
        host: Option<WideHostRef>,
        province: Option<ProvinceKey>,
        what: &'static str,
    ) {
        self.anomalies.push(Anomaly {
            seq,
            host,
            province,
            what,
        });
    }

    fn touch(&mut self, province: ProvinceKey, seq: u64, kind: WideKind, applied: &mut Applied) {
        let p = self.provinces.entry(province).or_default();
        p.last_seq = seq;
        *p.records.entry(kind as u8).or_insert(0) += 1;
        let closed_before = p.closed.is_some() && kind != WideKind::ProvinceClosed;
        if closed_before {
            p.after_close = p.after_close.saturating_add(1);
        }
        applied.provinces.insert(province);
        if closed_before {
            self.note(
                seq,
                None,
                Some(province),
                "a record attributed to a province after its close (the close is kept)",
            );
        }
    }

    fn host_mut(
        &mut self,
        host: WideHostRef,
        standing: ProvinceKey,
        seq: u64,
        applied: &mut Applied,
    ) -> &mut HostState {
        applied.hosts.insert(host);
        let h = self.holdings.entry(host.holding_ref()).or_default();
        h.last_seq = seq;
        h.hosts.insert(host);
        self.provinces
            .entry(standing)
            .or_default()
            .hosts
            .insert(host);
        let s = self.hosts.entry(host).or_insert(HostState {
            last_seq: seq,
            standing,
            presence: Presence::Unknown,
            transit: None,
            superseded: Vec::new(),
        });
        s.last_seq = seq;
        s.standing = standing;
        s
    }

    /// The host's transit of `slot`, created as a shell (with an anomaly)
    /// when no departure of that slot was seen; a stage after the march's
    /// settlement or close is counted on it and noted.
    fn transit_mut(
        &mut self,
        host: WideHostRef,
        standing: ProvinceKey,
        slot: u8,
        seq: u64,
        what: &'static str,
        applied: &mut Applied,
    ) -> &mut Transit {
        let current = self.hosts.get(&host).and_then(|h| h.transit.as_ref());
        let known = current.is_some_and(|t| t.slot == slot && t.departure.is_some());
        let terminal = current.is_some_and(|t| t.slot == slot && !t.open());
        if !known {
            self.note(seq, Some(host), Some(standing), what);
        }
        if terminal {
            self.note(
                seq,
                Some(host),
                Some(standing),
                "a stage of a march after its settlement or close (the terminal record is kept)",
            );
        }
        let s = self.host_mut(host, standing, seq, applied);
        let same_slot = s.transit.as_ref().is_some_and(|t| t.slot == slot);
        if !same_slot {
            if let Some(old) = s.transit.take() {
                s.superseded.push(old);
            }
            s.transit = Some(Transit {
                slot,
                ..Transit::default()
            });
        }
        let t = s.transit.as_mut().expect("set above");
        if terminal {
            t.after_close = t.after_close.saturating_add(1);
        }
        t
    }

    fn touch_day(&mut self, dest: ProvinceKey, bell: u32, seq: u64, host: Option<WideHostRef>) {
        let day = self.days.entry((dest, wa::day_of(bell))).or_default();
        if day.closed.is_some() {
            day.after_close = day.after_close.saturating_add(1);
            self.note(
                seq,
                host,
                Some(dest),
                "a reveal or gather into a closed day (the close is kept)",
            );
        } else {
            day.bells_seen.insert(bell);
        }
    }

    fn step(&mut self, seq: u64, ev: Ev, applied: &mut Applied) {
        match ev {
            Ev::Muster {
                host,
                standing,
                bell,
                entry,
            } => {
                self.touch(standing, seq, WideKind::Muster, applied);
                self.host_mut(host, standing, seq, applied).presence =
                    Presence::Mustered { bell, entry };
            }
            Ev::Dissolve {
                host,
                standing,
                pend_bell,
                entry,
            } => {
                self.touch(standing, seq, WideKind::Dissolve, applied);
                self.host_mut(host, standing, seq, applied).presence =
                    Presence::Dissolving { pend_bell, entry };
            }
            Ev::Resolve { province, bell } => {
                self.touch(province, seq, WideKind::Resolve, applied);
                self.provinces
                    .entry(province)
                    .or_default()
                    .resolved_bells
                    .insert(bell);
            }
            Ev::Return {
                host,
                standing,
                credited,
                entry,
            } => {
                self.touch(standing, seq, WideKind::Return, applied);
                self.host_mut(host, standing, seq, applied).presence = Presence::Returned {
                    credited_milli: credited,
                    entry,
                };
            }
            Ev::Stranded {
                host,
                standing,
                troops_lost,
                entry,
            } => {
                self.touch(standing, seq, WideKind::Stranded, applied);
                self.host_mut(host, standing, seq, applied).presence = Presence::Stranded {
                    troops_lost_milli: troops_lost,
                    entry,
                };
            }
            Ev::RosterClosed { province, close } => {
                self.touch(province, seq, WideKind::RosterClosed, applied);
                let p = self.provinces.entry(province).or_default();
                if p.roster_closed.is_some() {
                    self.note(
                        seq,
                        None,
                        Some(province),
                        "a second roster close (the first is kept)",
                    );
                } else {
                    p.roster_closed = Some(close);
                }
            }
            Ev::Departed {
                host,
                slot,
                departure,
            } => {
                let origin = departure.origin;
                self.touch(origin, seq, WideKind::Departed, applied);
                let open_before = self
                    .hosts
                    .get(&host)
                    .and_then(|h| h.transit.as_ref())
                    .is_some_and(Transit::open);
                if open_before {
                    self.note(
                        seq,
                        Some(host),
                        Some(origin),
                        "a departure while the host's previous march is open in the applied history",
                    );
                }
                let s = self.host_mut(host, origin, seq, applied);
                if let Some(old) = s.transit.take() {
                    s.superseded.push(old);
                }
                s.transit = Some(Transit {
                    slot,
                    departure: Some(departure),
                    ..Transit::default()
                });
            }
            Ev::DepartureSettled {
                host,
                origin,
                slot,
                settled,
            } => {
                self.touch(origin, seq, WideKind::DepartureSettled, applied);
                let t = self.transit_mut(
                    host,
                    origin,
                    slot,
                    seq,
                    "a departure settled without its departure in the applied history",
                    applied,
                );
                // A stage of a march already settled or closed is counted
                // and noted by `transit_mut`, never applied over the
                // terminal record.
                if t.open() && t.departure_settled.is_none() {
                    t.departure_settled = Some(settled);
                }
            }
            Ev::Revealed {
                host,
                slot,
                mut reveal,
            } => {
                let dest = reveal.dest;
                self.touch(dest, seq, WideKind::Revealed, applied);
                // The slot's arrival bell is the march's, carried by the
                // Departed record of the same transit slot and by nothing
                // in the Revealed record itself.
                reveal.arrive_bell = self
                    .hosts
                    .get(&host)
                    .and_then(|h| h.transit.as_ref())
                    .filter(|t| t.slot == slot)
                    .and_then(|t| t.departure.as_ref())
                    .map(|d| d.arrive_bell);
                let t = self.transit_mut(
                    host,
                    dest,
                    slot,
                    seq,
                    "a reveal without its departure in the applied history",
                    applied,
                );
                if t.open() && t.reveal.is_none() {
                    t.reveal = Some(reveal);
                }
                match reveal.arrive_bell {
                    Some(arrive) => {
                        let k = (dest, arrive, reveal.faction, reveal.i);
                        let s = self.slots.entry(k).or_default();
                        if s.closed.is_some() {
                            s.after_close = s.after_close.saturating_add(1);
                            self.note(
                                seq,
                                Some(host),
                                Some(dest),
                                "a reveal into a closed slot (the close is kept)",
                            );
                        } else {
                            s.host = Some(host);
                            s.transit_slot = Some(slot);
                            s.reveal = Some(reveal);
                        }
                        self.touch_day(dest, arrive, seq, Some(host));
                    }
                    None => self.note(
                        seq,
                        Some(host),
                        Some(dest),
                        "a reveal whose arrival bell is not in the applied history: the slot is not indexed",
                    ),
                }
            }
            Ev::Gathered {
                dest,
                bell,
                arrivals_mask,
                n_present,
                no_arrivals,
            } => {
                self.touch(dest, seq, WideKind::Gathered, applied);
                self.provinces
                    .entry(dest)
                    .or_default()
                    .gathered_bells
                    .insert(bell);
                self.touch_day(dest, bell, seq, None);
                let g = self.inputs.entry((dest, bell)).or_default();
                g.last_seq = seq;
                if g.closed.is_some() {
                    g.after_close = g.after_close.saturating_add(1);
                    self.note(
                        seq,
                        None,
                        Some(dest),
                        "a gather into closed inputs (the close is kept)",
                    );
                } else {
                    g.gathers += 1;
                    g.arrivals_mask = arrivals_mask;
                    g.n_present = n_present;
                    g.no_arrivals = no_arrivals;
                }
            }
            Ev::TransitSettled {
                host,
                slot,
                settlement,
            } => {
                let at = settlement.judged_at;
                self.touch(at, seq, WideKind::TransitSettled, applied);
                let t = self.transit_mut(
                    host,
                    at,
                    slot,
                    seq,
                    "a settlement without its departure in the applied history",
                    applied,
                );
                if t.settled.is_none() && t.closed.is_none() {
                    t.settled = Some(settlement);
                }
            }
            Ev::RecordClosed {
                dest,
                what,
                bell,
                faction,
                i,
                close,
            } => {
                self.touch(dest, seq, WideKind::RecordClosed, applied);
                match what {
                    2 => {
                        let s = self.slots.entry((dest, bell, faction, i)).or_default();
                        if s.closed.is_some() {
                            s.after_close = s.after_close.saturating_add(1);
                            self.note(
                                seq,
                                None,
                                Some(dest),
                                "a second slot close (the first is kept)",
                            );
                        } else {
                            s.closed = Some(close);
                            if s.reveal.is_none() {
                                self.note(
                                    seq,
                                    None,
                                    Some(dest),
                                    "a slot close without its reveal in the applied history (the slot is indexed by the close)",
                                );
                            }
                        }
                    }
                    3 => {
                        let d = self.days.entry((dest, wa::day_of(bell))).or_default();
                        if d.closed.is_some() {
                            d.after_close = d.after_close.saturating_add(1);
                            self.note(
                                seq,
                                None,
                                Some(dest),
                                "a second day close (the first is kept)",
                            );
                        } else {
                            let empty = d.bells_seen.is_empty();
                            d.closed = Some(close);
                            if empty {
                                self.note(
                                    seq,
                                    None,
                                    Some(dest),
                                    "a day close without a reveal or gather of its day in the applied history (the day is indexed by the close)",
                                );
                            }
                        }
                    }
                    4 => {
                        let g = self.inputs.entry((dest, bell)).or_default();
                        if g.closed.is_some() {
                            g.after_close = g.after_close.saturating_add(1);
                            self.note(
                                seq,
                                None,
                                Some(dest),
                                "a second inputs close (the first is kept)",
                            );
                        } else {
                            let empty = g.gathers == 0;
                            g.last_seq = seq;
                            g.closed = Some(close);
                            if empty {
                                self.note(
                                    seq,
                                    None,
                                    Some(dest),
                                    "an inputs close without its gather in the applied history (the inputs are indexed by the close)",
                                );
                            }
                        }
                    }
                    _ => self.note(seq, None, Some(dest), "a record close of an unknown kind"),
                }
            }
            Ev::TransitClosed {
                host,
                home,
                slot,
                close,
            } => {
                self.touch(home, seq, WideKind::TransitClosed, applied);
                let t = self.transit_mut(
                    host,
                    home,
                    slot,
                    seq,
                    "a transit close without its departure in the applied history",
                    applied,
                );
                if t.closed.is_none() && t.settled.is_none() {
                    t.closed = Some(close);
                }
            }
            Ev::ProvinceClosed { province, close } => {
                self.touch(province, seq, WideKind::ProvinceClosed, applied);
                let p = self.provinces.entry(province).or_default();
                if p.closed.is_some() {
                    p.after_close = p.after_close.saturating_add(1);
                    self.note(
                        seq,
                        None,
                        Some(province),
                        "a second province close (the first is kept)",
                    );
                } else {
                    p.closed = Some(close);
                }
            }
        }
    }

    // ------------------------------------------------------------ queries

    fn observation<T>(&self, seen: T) -> Observation<T> {
        Observation {
            seen,
            observed_through: self.cursor,
            horizon: self.horizon.as_ref().map(|h| h.through_seq),
            source_complete: false,
            blocked: self.blocked.is_some(),
        }
    }

    /// The slots of `(dest, arrival bell)` the applied history shows
    /// (reveals, and closes without a reveal). Never authoritative: an
    /// empty `seen` is "none observed", and the ArrivalDay account is the
    /// chain's evidence ([`Self::read_plan`] asks for it).
    pub fn reveals_at(&self, dest: ProvinceKey, arrive: u32) -> Observation<Vec<&SlotState>> {
        self.observation(
            self.slots
                .range((dest, arrive, 0, 0)..=(dest, arrive, u8::MAX, u8::MAX))
                .map(|(_, s)| s)
                .collect(),
        )
    }

    /// The marches of `holding`'s hosts that are neither settled nor
    /// closed in the applied history.
    pub fn open_transits(&self, holding: WideHostRef) -> Observation<Vec<(WideHostRef, &Transit)>> {
        let seen = self
            .holdings
            .get(&holding.holding_ref())
            .map(|h| {
                h.hosts
                    .iter()
                    .filter_map(|host| {
                        let t = self.hosts.get(host)?.transit.as_ref()?;
                        t.open().then_some((*host, t))
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.observation(seen)
    }

    /// The accounts a keeper would read before planning anything in this
    /// world, by canonical address under the scope's Season and program
    /// (public PDA arithmetic), deduplicated and in address order. Read
    /// requirements only: nothing here is an instruction or a signer.
    pub fn read_plan(&self) -> Vec<ReadRequirement> {
        let mut out: BTreeMap<[u8; 32], ReadRequirement> = BTreeMap::new();
        let mut want = |account: WideAccount, address: [u8; 32], why: &'static str| {
            out.entry(address).or_insert(ReadRequirement {
                account,
                address: Address::new_from_array(address),
                why,
            });
        };
        for (k, p) in &self.provinces {
            want(
                WideAccount::Province(*k),
                wl::province_address(&self.ctx, k.coord()),
                if p.closed.is_some() {
                    "a close was observed: confirm the account is gone"
                } else {
                    "a record was attributed here: the province's state is the account's"
                },
            );
            if !p.hosts.is_empty() || p.roster_closed.is_some() {
                want(
                    WideAccount::Roster(*k),
                    wro::roster_address(&self.ctx, *k),
                    "hosts stood here: the entries pair with the roster side table",
                );
            }
        }
        for h in self.holdings.keys() {
            want(
                WideAccount::Holding(*h),
                wh::holding_address(&self.ctx, h.key().coord(), h.site()),
                "a host of this holding was named: its escrow and counters are the account's",
            );
        }
        for (host, s) in &self.hosts {
            let holding = host.holding_ref();
            let hkey = wh::holding_address(&self.ctx, holding.key().coord(), holding.site());
            if let Some(t) = &s.transit {
                want(
                    WideAccount::Transit(holding, t.slot),
                    wm::transit_address(&self.ctx, &hkey, t.slot),
                    if t.open() {
                        "an open march: its state is the record's"
                    } else {
                        "a settled or closed march: confirm the record is gone"
                    },
                );
            }
        }
        for ((dest, bell, faction, i), s) in &self.slots {
            want(
                WideAccount::ArrivalSlot(*dest, *bell, *faction, *i),
                wa::arrival_slot_address(&self.ctx, *dest, *bell, *faction, *i),
                if s.closed.is_some() {
                    "a slot close was observed: confirm the account is gone"
                } else {
                    "a reveal into this slot: the slot's state is the account's"
                },
            );
        }
        for ((dest, day), d) in &self.days {
            want(
                WideAccount::ArrivalDay(*dest, *day),
                wa::arrival_day_address(&self.ctx, *dest, *day),
                if d.closed.is_some() {
                    "a day close was observed: confirm the account is gone"
                } else {
                    "the arrival evidence of the day is the account, not the records"
                },
            );
        }
        for ((dest, bell), g) in &self.inputs {
            want(
                WideAccount::ClashInputs(*dest, *bell),
                wa::clash_inputs_address(&self.ctx, *dest, *bell),
                if g.closed.is_some() {
                    "an inputs close was observed: confirm the account is gone"
                } else {
                    "a gather was observed: the positions and the fates are the account's"
                },
            );
        }
        out.into_values().collect()
    }

    /// What the records give a future settlement of `host`'s march, and
    /// what they cannot (module doc). `None` when no march of the host was
    /// seen.
    pub fn settlement_inputs(&self, host: WideHostRef) -> Option<SettlementInputs> {
        let t = self.hosts.get(&host)?.transit.as_ref()?;
        let mut have = vec![
            "the host's full reference and its holding's",
            "the transit slot",
        ];
        let mut missing = Vec::new();
        match &t.departure {
            Some(_) => have.extend([
                "the origin province key",
                "the departure and arrival bells",
                "the departed mass, stamina, tip, fee and bond",
                "the seal root (sha256(commit ‖ sha256(seal)))",
            ]),
            None => {
                missing.push("the Departed record (the history before the first applied batch)")
            }
        }
        match &t.reveal {
            Some(_) => have.extend([
                "the destination province key",
                "the arrival slot (faction, index) and tile",
            ]),
            None => missing.push(
                "the destination: no Revealed record (a sealed destination is inside the seal; the record keeps only its root)",
            ),
        }
        if t.departure_settled.is_some() {
            have.push("the departure settled (troops and stamina after the origin's resolve)");
        } else {
            missing.push("the DepartureSettled record, or a read of the transit record's state");
        }
        missing.extend([
            "the commitment (32 B): in no wide record; the Depart instruction's data or the owner's request",
            "the sealed body (264 B, IBE block and ciphertext): in no wide record; the Depart instruction's data",
            "THE anchor's round-T(arrive) signature: a read of the BellAnchor or its archive entry",
            "the gathered and resolved ClashInputs of the arrival bell: a read of the account",
            "the destination's resolved bells and roster, the holding's escrow and rent payer: reads",
        ]);
        Some(SettlementInputs {
            host,
            transit_slot: t.slot,
            have,
            missing,
        })
    }
}

// ------------------------------------------------------------ the adapter

/// What one feed transaction is to the wide observer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxObservation {
    /// Committed, attributed to the program, no `PSW1` body.
    Legacy,
    /// The transaction failed: every logged effect rolled back; **never** a
    /// wide event.
    RolledBack,
    /// Committed `PSW1` bodies attributed to the program, frame-checked
    /// (failed CPI subtrees removed), as a batch at the feed sequence.
    Wide(WideBatch),
}

/// Frame-checked decoding of one feed transaction (`fclient::typed_log`,
/// the reader's own checks of the runtime log structure: invocation depth,
/// matching exits, rolled-back subtrees, record tags and bodies). `Err` is
/// a log structure the reader refuses; the observer blocks on it.
pub fn observe_tx(
    tx: &fclient::ports::TxRecord,
    program: &Address,
) -> Result<TxObservation, fclient::typed_log::DecodeError> {
    use fclient::typed_log::{decode_transaction, ProgramRecord, TransactionRecords};
    match decode_transaction(tx, program)? {
        TransactionRecords::RolledBack => Ok(TxObservation::RolledBack),
        TransactionRecords::Committed(records) => {
            let bodies: Vec<Vec<u8>> = records
                .into_iter()
                .filter_map(|r| match r {
                    ProgramRecord::Psw1 { body } => Some(body),
                    ProgramRecord::Ps2 { .. } => None,
                })
                .collect();
            if bodies.is_empty() {
                Ok(TxObservation::Legacy)
            } else {
                Ok(TxObservation::Wide(WideBatch {
                    seq: tx.seq,
                    slot: tx.slot,
                    signature: tx.signature.to_string(),
                    bodies,
                }))
            }
        }
    }
}

/// The keeper's read-only wide observer: the model plus the counts of what
/// the feed pages it was shown contained. It is fed the **same pages** the
/// legacy discovery pulls, before the legacy guard ingests them; it does
/// not pull, send, sign, or authorize. On a restart it starts empty and is
/// shown the pages again from the legacy cursor's replay. While the legacy
/// indexes are blocked no page is pulled, so the observer sees nothing
/// new either (`source_complete` is `false` for that reason among others).
pub struct WideObserver {
    pub model: WideDiscovery,
    pub rolled_back_txs: u64,
    pub legacy_txs: u64,
    pub wide_txs: u64,
    pub replayed_txs: u64,
    pub decode_failures: u64,
    pub last_seq_seen: Option<u64>,
    /// Pages whose sequences did not continue the previous one.
    pub gaps: u64,
    /// Exact whole-transaction fingerprints, including legacy and rollbacks.
    observations: BTreeMap<u64, [u8; 32]>,
}

impl WideObserver {
    pub fn new(scope: Scope, limits: Limits) -> WideObserver {
        WideObserver {
            model: WideDiscovery::new(scope, limits),
            rolled_back_txs: 0,
            legacy_txs: 0,
            wide_txs: 0,
            replayed_txs: 0,
            decode_failures: 0,
            last_seq_seen: None,
            gaps: 0,
            observations: BTreeMap::new(),
        }
    }

    /// Observes a strictly ordered feed page. Exact known overlap is a
    /// no-op; conflicting or forgotten overlap, zero sequences and invalid
    /// page order block permanently. Gaps are recorded, never completeness.
    pub fn observe_page(&mut self, page: &[fclient::ports::TxRecord], program: &Address) -> usize {
        if self.model.blocked().is_some() {
            return 0;
        }
        if program != &self.model.scope.program {
            self.model.block_external(
                page.first().map_or(0, |t| t.seq),
                page.first().map_or(0, |t| t.slot),
                &page
                    .first()
                    .map_or_else(String::new, |t| t.signature.to_string()),
                "the observer program differs from its scope".into(),
            );
            return 0;
        }
        // Validate page order before applying any of it. Ordered overlap
        // across pages is permitted, but a feed page cannot go backwards.
        let mut previous = None;
        for tx in page {
            if tx.seq == 0 || previous.is_some_and(|seq| tx.seq <= seq) {
                self.model.block_external(
                    tx.seq,
                    tx.slot,
                    &tx.signature.to_string(),
                    "invalid feed sequence or page order".into(),
                );
                return 0;
            }
            previous = Some(tx.seq);
        }
        let mut applied = 0;
        for tx in page {
            // Debug for this concrete, fully owned TxRecord is deterministic
            // and escaped/field-delimited, covering every field (not merely
            // decoded bodies). It is an in-memory window, never persisted.
            let fp: [u8; 32] = Sha256::digest(format!("{tx:?}").as_bytes()).into();
            if self.last_seq_seen.is_some_and(|l| tx.seq <= l) {
                if self.observations.get(&tx.seq) == Some(&fp) {
                    continue; // An exact replay mutates no state or counters.
                }
                let reason = if self.observations.contains_key(&tx.seq) {
                    "conflicting transaction replay"
                } else {
                    "unknown transaction replay outside the fingerprint window"
                };
                self.model.block_external(
                    tx.seq,
                    tx.slot,
                    &tx.signature.to_string(),
                    reason.into(),
                );
                break;
            }
            if self
                .last_seq_seen
                .is_some_and(|l| l.checked_add(1) != Some(tx.seq))
            {
                self.gaps += 1;
            }
            match observe_tx(tx, program) {
                Ok(TxObservation::Legacy) => self.legacy_txs += 1,
                Ok(TxObservation::RolledBack) => self.rolled_back_txs += 1,
                Ok(TxObservation::Wide(batch)) => match self.model.apply(&batch) {
                    Ok(a) if a.replay => self.replayed_txs += 1,
                    Ok(_) => {
                        self.wide_txs += 1;
                        applied += 1;
                    }
                    Err(_) => {}
                },
                Err(e) => {
                    self.decode_failures += 1;
                    self.model.block_external(
                        tx.seq,
                        tx.slot,
                        &tx.signature.to_string(),
                        format!("the reader refused the log structure: {e:?}"),
                    );
                }
            }
            if self.model.blocked().is_some() {
                break;
            }
            self.last_seq_seen = Some(tx.seq);
            self.observations.insert(tx.seq, fp);
            while self.observations.len() > self.model.limits.max_fingerprints {
                self.observations.pop_first();
            }
        }
        applied
    }

    /// The status JSON: observation counts and the blocker; always
    /// `automatic_writes: false` and `source_complete: false`.
    pub fn status(&self) -> Value {
        let c = self.model.coverage();
        json!({
            "mode": "read-only observation",
            "automatic_writes": false,
            "source_complete": false,
            "world": hex::encode(c.world),
            "source": c.source,
            "cursor": c.last_seq,
            "first_seq": c.first_seq,
            "last_seq_seen": self.last_seq_seen,
            "horizon": c.horizon.as_ref().map(|h| json!({"through_seq": h.through_seq, "source": h.source})),
            "batches": c.batches,
            "records": c.records,
            "wide_txs": self.wide_txs,
            "legacy_txs": self.legacy_txs,
            "rolled_back_txs": self.rolled_back_txs,
            "replayed_txs": self.replayed_txs,
            "decode_failures": self.decode_failures,
            "gaps": self.gaps,
            "provinces": self.model.provinces.len(),
            "holdings": self.model.holdings.len(),
            "hosts": self.model.hosts.len(),
            "slots": self.model.slots.len(),
            "days": self.model.days.len(),
            "inputs": self.model.inputs.len(),
            "anomalies": c.anomalies,
            "blocker": c.blocked.as_ref().map(|b| json!({
                "seq": b.seq, "slot": b.slot, "signature": b.signature, "body": b.body, "reason": b.reason,
            })),
        })
    }
}
