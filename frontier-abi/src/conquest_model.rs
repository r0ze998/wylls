//! The conquest step of one province-bell as a pure function of the
//! Province v2 bytes (MC contract §5.7, §3.2–§3.6, §3.10): the records,
//! the keep, the hourly snapshot, the CONQUEST log payload, the control
//! weights and the March fold.
//!
//! **One copy** (as `clash_model`, M1 W4-A D8): the program
//! (ResolveFromInputs and SkipQuiet, CQ2-B), the herald (CQ2-E), the
//! verifier (CQ3-A), itest and the WASM client call these functions, so
//! the map, the report and the verifier cannot disagree.
//!
//! **Calling order inside bell b** (§5.7):
//!
//! ```text
//! resolve:  build_v2 → kernel clash → apply_v2 → report_from_outcome
//!           → settle_bell(b) → step(b, report) → finish_bell
//! skip:     report_quiet(b) → settle_bell(b) → step(b, report) → finish_bell
//! ```
//!
//! `report_quiet` reads the roster as the clash of b would (before the
//! bell's settle). In a quiet bell every resident stays on its tile, so
//! the two reports are equal and resolve ≡ skip byte for byte (G11).
//! `step` returns `roster_changed` when the keep donor's entry moved: the
//! caller passes it to `finish_bell` (roster epoch, entry count).
//!
//! Inside `step` (each part reads what the previous one left):
//!
//! 1. records with `kind ≠ 0` and `b > record.bell`, by site index:
//!    siege → `SiegeV3::advance` (failure, completion, the capture flip of
//!    the site mirror, capture credit), occupation → liberation or expiry
//!    (Respite per §3.5), capture due → unchanged;
//! 3. the keep → `keep::advance` with the donor handoff;
//! 4. at `b mod 6 == 0` the hour snapshot;
//! 5. the caller emits CONQUEST when [`StepOut::emits`].
//!
//! The rules come from the kernels through [`crate::v2::kernel`]
//! (temporary bridge, R1 of the CQ1-C notes). Interpretations the
//! contract leaves open are named D-n in `docs/frontier/conquest/
//! CQ1-C-NOTES.md`.

use crate::bytes::{rd_arr, rd_i16, rd_u16, rd_u32, rd_u64, rd_u8};
use crate::bytes::{wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use crate::clash_model::{BuiltV2, ModelError, CAMP_SITE};
use crate::v2::kernel::control::{self, Controller};
use crate::v2::kernel::keep::{self as kkeep, Keep, KeepEvent, KeepReport};
use crate::v2::kernel::siege3;
use crate::v2::layout::province::{
    conquest as CR, keep as KP, province as P, site as SM, snapshot as SN,
};
use crate::v2::layout::world::march_state as MS;
use crate::v2::log::{event, ConquestPayload, Event, CONQUEST_EVENTS_MAX};
use crate::v2::presets::ConquestParams;
use permutation_rules::frontier::clash::{ClashOutcome, NEUTRAL};
use permutation_rules::frontier::doctrine::of_faction;
use permutation_rules::frontier::geometry::PROVINCE_TILES;
use permutation_rules::frontier::laurel::Tier;
use permutation_rules::frontier::siege::{BellReport as KReport, SiegeStatus};
use permutation_rules::hash::sha256;

pub use crate::clash_model::R;

const BAD: ModelError = ModelError::BadAccount;

/// `Kernel` (15) sub-codes of the conquest area.
pub mod sub {
    /// `keep::KeepError` (a keep garrison above `MAX_HOST_TROOPS`).
    pub const KEEP: u64 = 0x34;
    /// A record the step cannot interpret (unknown kind, a record on a
    /// site whose state cannot carry it: S2).
    pub const RECORD: u64 = 0x35;
}

const fn kernel(s: u64) -> ModelError {
    ModelError::Kernel(s)
}

/// Bells per hour (snapshots, folds).
pub const HOUR_BELLS: u32 = 6;

// ------------------------------------------------------------ records

/// A conquest record (§5.2.1), decoded as stored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Record {
    pub kind: u8,
    /// Kind 0: `barred_faction`; 1: attacker; 2: occupier; 3: captor.
    pub faction: u8,
    pub flags: u8,
    /// Kind 0: `owed_gen`.
    pub progress: u8,
    /// Kind 0: the slot owed back.
    pub required: u8,
    pub target: u8,
    pub vigil_start: u16,
    pub vigil_next: u16,
    pub vigil_from_day: u16,
    /// Kind 0: `immune_until_bell`; 1: declared; 2: start; 3: completion.
    pub bell: u32,
    pub actor: u64,
    pub src: u64,
}

impl Record {
    /// The all-zero record (S1).
    pub const ZERO: Record = Record {
        kind: 0,
        faction: 0,
        flags: 0,
        progress: 0,
        required: 0,
        target: 0,
        vigil_start: 0,
        vigil_next: 0,
        vigil_from_day: 0,
        bell: 0,
        actor: 0,
        src: 0,
    };

    pub fn read(pd: &[u8], site: usize) -> R<Record> {
        let o = P::record(site);
        let d = pd.get(o..o + CR::SIZE).ok_or(BAD)?;
        Ok(Record {
            kind: d[CR::KIND],
            faction: d[CR::FACTION],
            flags: d[CR::FLAGS],
            progress: d[CR::PROGRESS],
            required: d[CR::REQUIRED],
            target: d[CR::TARGET],
            vigil_start: rd_u16(d, CR::VIGIL_START_MIN).ok_or(BAD)?,
            vigil_next: rd_u16(d, CR::VIGIL_NEXT_MIN).ok_or(BAD)?,
            vigil_from_day: rd_u16(d, CR::VIGIL_FROM_DAY).ok_or(BAD)?,
            bell: rd_u32(d, CR::BELL).ok_or(BAD)?,
            actor: rd_u64(d, CR::ACTOR).ok_or(BAD)?,
            src: rd_u64(d, CR::SRC).ok_or(BAD)?,
        })
    }

    pub fn write(&self, pd: &mut [u8], site: usize) -> R<()> {
        let o = P::record(site);
        let d = pd.get_mut(o..o + CR::SIZE).ok_or(BAD)?;
        d[CR::KIND] = self.kind;
        d[CR::FACTION] = self.faction;
        d[CR::FLAGS] = self.flags;
        d[CR::PROGRESS] = self.progress;
        d[CR::REQUIRED] = self.required;
        d[CR::TARGET] = self.target;
        let ok = wr_u16(d, CR::VIGIL_START_MIN, self.vigil_start)
            & wr_u16(d, CR::VIGIL_NEXT_MIN, self.vigil_next)
            & wr_u16(d, CR::VIGIL_FROM_DAY, self.vigil_from_day)
            & wr_u32(d, CR::BELL, self.bell)
            & wr_u64(d, CR::ACTOR, self.actor)
            & wr_u64(d, CR::SRC, self.src);
        if ok {
            Ok(())
        } else {
            Err(BAD)
        }
    }

    /// A siege or an occupation (counted every bell).
    pub const fn active(&self) -> bool {
        self.kind == CR::KIND_SIEGE || self.kind == CR::KIND_OCCUPATION
    }

    /// A record owing a stake or a slot: kind 0 (stake to the holding or
    /// `src`, a slot), or an occupation whose stake to `src` is not settled
    /// yet (D-9 revised, integ-W1: owed from the completion bell). S3:
    /// ReleaseDormant refuses; SettleSiege applies.
    pub const fn owes(&self) -> bool {
        (self.kind == CR::KIND_NONE || self.kind == CR::KIND_OCCUPATION)
            && self.flags & CR::OWED_MASK != 0
    }

    /// Whether the record's immunity bars `faction` at bell `now`
    /// (DeclareSiege step 5; §3.4–§3.6).
    pub const fn bars(&self, faction: u8, now: u32) -> bool {
        self.kind == CR::KIND_NONE
            && permutation_rules::frontier::siege::immunity_bars(
                self.faction,
                self.bell,
                faction,
                now,
            )
    }
}

/// The twelve records of a Province.
pub fn decode_records(pd: &[u8]) -> R<[Record; P::SITES_N]> {
    let mut out = [Record::ZERO; P::SITES_N];
    for (s, r) in out.iter_mut().enumerate() {
        *r = Record::read(pd, s)?;
    }
    Ok(out)
}

// ------------------------------------------------------------ the keep

/// The keep record (`None` when `tile == 0xFF`: rings 0–1).
pub fn read_keep(pd: &[u8]) -> R<Option<Keep>> {
    let o = P::KEEP;
    let d = pd.get(o..o + KP::SIZE).ok_or(BAD)?;
    if d[KP::TILE] == KP::NO_TILE {
        return Ok(None);
    }
    Ok(Some(Keep {
        tile: d[KP::TILE],
        holder: d[KP::HOLDER],
        contender: d[KP::CONTENDER],
        progress: d[KP::PROGRESS],
        required: d[KP::REQUIRED],
        heartland_safe: d[KP::FLAGS] & KP::FLAG_HEARTLAND_SAFE != 0,
        paused: d[KP::FLAGS] & KP::FLAG_PAUSED_M3 != 0,
        changes: rd_u16(d, KP::CHANGES).ok_or(BAD)?,
        troops: rd_u32(d, KP::TROOPS).ok_or(BAD)?,
        since_bell: rd_u32(d, KP::SINCE_BELL).ok_or(BAD)?,
        consolidated_until_bell: rd_u32(d, KP::CONSOLIDATED_UNTIL_BELL).ok_or(BAD)?,
        contest_from_bell: rd_u32(d, KP::CONTEST_FROM_BELL).ok_or(BAD)?,
        gen: rd_u32(d, KP::GEN).ok_or(BAD)?,
        last_taken_from: d[KP::LAST_TAKEN_FROM],
    }))
}

/// Writes the keep record.
pub fn write_keep(pd: &mut [u8], k: &Keep) -> R<()> {
    let o = P::KEEP;
    let d = pd.get_mut(o..o + KP::SIZE).ok_or(BAD)?;
    d[KP::TILE] = k.tile;
    d[KP::HOLDER] = k.holder;
    d[KP::CONTENDER] = k.contender;
    d[KP::PROGRESS] = k.progress;
    d[KP::REQUIRED] = k.required;
    d[KP::FLAGS] = ((k.heartland_safe as u8) * KP::FLAG_HEARTLAND_SAFE)
        | ((k.paused as u8) * KP::FLAG_PAUSED_M3);
    d[KP::LAST_TAKEN_FROM] = k.last_taken_from;
    let ok = wr_u16(d, KP::CHANGES, k.changes)
        & wr_u32(d, KP::TROOPS, k.troops)
        & wr_u32(d, KP::SINCE_BELL, k.since_bell)
        & wr_u32(d, KP::CONSOLIDATED_UNTIL_BELL, k.consolidated_until_bell)
        & wr_u32(d, KP::CONTEST_FROM_BELL, k.contest_from_bell)
        & wr_u32(d, KP::GEN, k.gen);
    if ok {
        Ok(())
    } else {
        Err(BAD)
    }
}

/// Marks a Province without a keep (rings 0–1): `tile = 0xFF`, the rest
/// zero, `contender` and `last_taken_from` none.
pub fn write_no_keep(pd: &mut [u8]) -> R<()> {
    let o = P::KEEP;
    let d = pd.get_mut(o..o + KP::SIZE).ok_or(BAD)?;
    d.fill(0);
    d[KP::TILE] = KP::NO_TILE;
    d[KP::CONTENDER] = KP::NONE;
    d[KP::LAST_TAKEN_FROM] = KP::NONE;
    Ok(())
}

/// The map colour of a Province (§3.3): its keep's holder; `None` for a
/// Province without a keep (rings 0–1: the Concord is neutral, a Seat
/// shows its seat faction, `control::province_control`).
pub fn map_faction(pd: &[u8]) -> R<Option<u8>> {
    Ok(read_keep(pd)?.map(|k| k.holder))
}

// ------------------------------------------------------------ reports

/// What the clash (or the quiet model) of one bell says about one hex.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteReport {
    /// Bit f: faction f, hostile to the owner (the holder for the keep),
    /// holds the hex with a host of its own.
    pub holders: u8,
    /// A non-civilian host of the owner's faction stands on the hex.
    pub defender_present: bool,
}

/// The report of one bell: every site's hex and the keep's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BellReport {
    pub sites: [SiteReport; P::SITES_N],
    pub keep: SiteReport,
}

/// The resolve's report, read from the kernel's garrison results by
/// garrison id (§5.7).
pub fn report_from_outcome(b: &BuiltV2, out: &ClashOutcome) -> R<BellReport> {
    let mut rep = BellReport::default();
    for (g, &s) in b.base.garrisons.iter().zip(&b.base.gar_site) {
        if s == CAMP_SITE {
            continue;
        }
        let gr = out.garrisons.iter().find(|x| x.id == g.id).ok_or(BAD)?;
        *rep.sites.get_mut(s as usize).ok_or(BAD)? = SiteReport {
            holders: gr.holders,
            defender_present: gr.defender_present,
        };
    }
    if let Some(k) = &b.keep {
        let gr = out.garrisons.iter().find(|x| x.id == k.id).ok_or(BAD)?;
        rep.keep = SiteReport {
            holders: gr.holders,
            defender_present: gr.defender_present,
        };
    }
    Ok(rep)
}

const fn side_bit(f: u8) -> u8 {
    if f < 8 {
        1 << f
    } else {
        0
    }
}

/// The skip's report: the quiet model's tile masks (§5.7). Call it before
/// `settle_bell(b)`.
pub fn report_quiet(pd: &[u8], b: u32) -> R<BellReport> {
    let mask = crate::clash_model::tile_masks(pd, b)?;
    report_from_masks(pd, &mask)
}

/// [`report_quiet`] from a tile mask the caller already holds: SkipQuiet's
/// per-transaction cache (§5.7: the mask is rebuilt only after a change of
/// the roster, CQ2-B). `mask` must be `tile_masks(pd, b)` of the current
/// roster; the site states and the keep's holder are read here every bell.
pub fn report_from_masks(pd: &[u8], mask: &[u8; PROVINCE_TILES]) -> R<BellReport> {
    let mut rep = BellReport::default();
    let n = (rd_u8(pd, P::SITE_COUNT).ok_or(BAD)? as usize).min(P::SITES_N);
    let sites: [u8; P::SITES_N] = rd_arr(pd, P::SITES).ok_or(BAD)?;
    for (s, r) in rep.sites.iter_mut().enumerate().take(n) {
        let o = P::site(s);
        let st = rd_u8(pd, o + SM::STATE).ok_or(BAD)?;
        let owner = match st {
            SM::STATE_HOLDING => rd_u8(pd, o + SM::FACTION).ok_or(BAD)?,
            SM::STATE_FREE_CITY => NEUTRAL,
            _ => continue,
        };
        let m = *mask.get(sites[s] as usize).ok_or(BAD)?;
        *r = SiteReport {
            holders: m & !side_bit(owner),
            defender_present: m & side_bit(owner) != 0,
        };
    }
    if let Some(k) = read_keep(pd)? {
        let m = *mask.get(k.tile as usize).ok_or(BAD)?;
        rep.keep = SiteReport {
            holders: m & !side_bit(k.holder),
            defender_present: m & side_bit(k.holder) != 0,
        };
    }
    Ok(rep)
}

// ------------------------------------------------------------ the step

/// The season values the step reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepParams {
    pub genesis_ts: i64,
    pub end_bell: u32,
    pub cq: ConquestParams,
}

impl StepParams {
    /// From a Season v2 account.
    pub fn of_season(season: &[u8]) -> Option<StepParams> {
        use crate::v2::layout::world::season as S;
        Some(StepParams {
            genesis_ts: crate::bytes::rd_i64(season, S::GENESIS_TS)?,
            end_bell: rd_u32(season, S::END_BELL)?,
            cq: ConquestParams::of_season(season)?,
        })
    }
}

/// A keep taken in this bell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeepTaken {
    pub from: u8,
    pub to: u8,
    /// The new garrison, whole troops.
    pub garrison: u32,
    /// The donor's host id (0 without a donor).
    pub donor_host_id: u64,
    /// The donor joined the keep entirely (its entry was removed).
    pub donor_removed: bool,
    /// MilliTroops the donor takes home (0 when removed).
    pub donor_rest: u32,
}

/// What one bell's step did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepOut {
    pub events: [Event; CONQUEST_EVENTS_MAX],
    pub n: u8,
    pub keep_taken: Option<KeepTaken>,
    /// The hour snapshot written at `b = 6h`.
    pub snapshot: Option<[u16; P::SIDES]>,
    /// A siege, an occupation or a keep contest is running after the bell.
    pub active: bool,
    /// The donor's entry changed: `finish_bell(b, changed)`.
    pub roster_changed: bool,
    /// An input of the next bell's quiet test changed (a keep changed
    /// hands, a site mirror flipped at a capture, the donor left): a
    /// SkipQuiet recomputes its quiet test (CQ2-B).
    pub quiet_inputs_changed: bool,
    /// The Province changed.
    pub changed: bool,
}

impl StepOut {
    const EMPTY: StepOut = StepOut {
        events: [Event {
            site: 0,
            code: 0,
            faction: 0,
            progress: 0,
        }; CONQUEST_EVENTS_MAX],
        n: 0,
        keep_taken: None,
        snapshot: None,
        active: false,
        roster_changed: false,
        quiet_inputs_changed: false,
        changed: false,
    };

    /// The bell's CONQUEST record is emitted (§5.7 step 5).
    pub const fn emits(&self) -> bool {
        self.n > 0 || self.active || self.snapshot.is_some()
    }

    pub fn events(&self) -> &[Event] {
        &self.events[..self.n as usize]
    }

    fn push(&mut self, site: u8, code: u8, faction: u8, progress: u8) {
        if (self.n as usize) < CONQUEST_EVENTS_MAX {
            self.events[self.n as usize] = Event {
                site,
                code,
                faction,
                progress,
            };
            self.n += 1;
        }
    }
}

fn mrd8(pd: &[u8], s: usize, f: usize) -> R<u8> {
    rd_u8(pd, P::site(s) + f).ok_or(BAD)
}
fn mrd16(pd: &[u8], s: usize, f: usize) -> R<u16> {
    rd_u16(pd, P::site(s) + f).ok_or(BAD)
}
fn mrd32(pd: &[u8], s: usize, f: usize) -> R<u32> {
    rd_u32(pd, P::site(s) + f).ok_or(BAD)
}
fn put(ok: bool) -> R<()> {
    if ok {
        Ok(())
    } else {
        Err(BAD)
    }
}

/// The step of bell `b` (module note): records, keep, snapshot.
pub fn step(pd: &mut [u8], b: u32, rep: &BellReport, prm: &StepParams) -> R<StepOut> {
    if pd.len() < P::SIZE {
        return Err(BAD);
    }
    let mut out = StepOut::EMPTY;
    // 1. records, by site index
    for s in 0..P::SITES_N {
        let r = Record::read(pd, s)?;
        if r.kind == CR::KIND_NONE || b <= r.bell {
            continue;
        }
        match r.kind {
            CR::KIND_SIEGE => step_siege(pd, s, r, b, rep.sites[s], prm, &mut out)?,
            CR::KIND_OCCUPATION => step_occupation(pd, s, r, b, rep.sites[s], prm, &mut out)?,
            CR::KIND_CAPTURE_DUE => {}
            _ => return Err(kernel(sub::RECORD)),
        }
    }
    // 3. the keep
    if let Some(before) = read_keep(pd)? {
        let mut k = before;
        let kr = KeepReport {
            holders: rep.keep.holders,
            defender_present: rep.keep.defender_present,
        };
        let contender = (kr.holders.count_ones() == 1).then(|| kr.holders.trailing_zeros() as u8);
        let (mut caps, n) = match contender {
            Some(f) => crate::v2::entry::candidates(pd, k.tile, f, b.saturating_add(1)),
            None => ([(0, 0, 0); crate::v2::entry::MAX_CANDIDATES], 0),
        };
        let caps = &mut caps[..n];
        let ev = kkeep::advance(&mut k, b, kr, &prm.cq.keep_params(), caps)
            .map_err(|_| kernel(sub::KEEP))?;
        match ev {
            KeepEvent::None | KeepEvent::Paused => {}
            KeepEvent::Contest(f) => out.push(event::KEEP_SITE, event::KEEP_CONTEST, f, k.progress),
            KeepEvent::Broken => out.push(
                event::KEEP_SITE,
                event::KEEP_BROKEN,
                before.contender,
                before.progress,
            ),
            KeepEvent::Taken {
                from,
                to,
                garrison,
                donor,
                donor_removed,
            } => {
                let mut taken = KeepTaken {
                    from,
                    to,
                    garrison,
                    donor_host_id: 0,
                    donor_removed,
                    donor_rest: 0,
                };
                if let Some(c) = caps.iter().find(|c| c.0 == donor) {
                    taken.donor_host_id = c.1;
                    taken.donor_rest = c.2;
                    donor_handoff(pd, c.0 as usize, c.2, donor_removed, b)?;
                    out.roster_changed = true;
                }
                let o = P::keeps_taken_by(to as usize);
                if (to as usize) < P::FACTIONS {
                    let v = rd_u16(pd, o).ok_or(BAD)?.saturating_add(1);
                    put(wr_u16(pd, o, v))?;
                }
                out.push(event::KEEP_SITE, event::KEEP_TAKEN, to, from);
                out.keep_taken = Some(taken);
                out.quiet_inputs_changed = true;
            }
        }
        if k != before {
            write_keep(pd, &k)?;
            out.changed = true;
        }
    }
    // 4. the hour snapshot
    if b % HOUR_BELLS == 0 {
        let w = control_weights(pd, b)?;
        let mut w16 = [0u16; P::SIDES];
        for (d, x) in w16.iter_mut().zip(w) {
            *d = x.min(u16::MAX as u32) as u16;
        }
        let h = b / HOUR_BELLS;
        let o = P::snap((h as usize) % P::SNAP_N);
        put(wr_u32(pd, o + SN::HOUR, h))?;
        for (i, x) in w16.iter().enumerate() {
            put(wr_u16(pd, o + SN::WEIGHT + 2 * i, *x))?;
        }
        out.snapshot = Some(w16);
        out.changed = true;
    }
    out.active = active_count(pd)? > 0;
    Ok(out)
}

/// The Province's active work: sieges and occupations (D-15: a
/// capture-due record waits and does not count) plus one for a running
/// keep contest. Reads the kind bytes and the keep's tile and contender
/// only (SkipQuiet's per-record term and prefix commit, §5.4).
pub fn active_count(pd: &[u8]) -> R<u32> {
    let mut n = 0u32;
    for s in 0..P::SITES_N {
        let k = *pd.get(P::record(s) + CR::KIND).ok_or(BAD)?;
        if k == CR::KIND_SIEGE || k == CR::KIND_OCCUPATION {
            n += 1;
        }
    }
    let kp = pd.get(P::KEEP..P::KEEP + KP::SIZE).ok_or(BAD)?;
    if kp[KP::TILE] != KP::NO_TILE && kp[KP::CONTENDER] != KP::NONE {
        n += 1;
    }
    Ok(n)
}

/// The donor's entry after a keep is taken: home with the rest (a
/// retire-style Leave settled at once, so the return settle credits it),
/// or removed when the rest joined the keep.
fn donor_handoff(pd: &mut [u8], i: usize, rest: u32, removed: bool, b: u32) -> R<()> {
    use crate::layout::province::entry as E;
    let o = P::entry(i);
    let e = pd.get_mut(o..o + E::SIZE).ok_or(BAD)?;
    if removed {
        e.fill(0);
        return Ok(());
    }
    e[E::TROOPS..E::TROOPS + 4].copy_from_slice(&rest.to_le_bytes());
    e[E::PEND_OP] = E::OP_LEAVE;
    e[E::OP_A] = crate::v2::entry::RETIRE_OP_A;
    e[E::PEND_BELL..E::PEND_BELL + 4].copy_from_slice(&b.to_le_bytes());
    e[E::STATE] = E::STATE_DEPARTED;
    Ok(())
}

fn step_siege(
    pd: &mut [u8],
    s: usize,
    r: Record,
    b: u32,
    sr: SiteReport,
    prm: &StepParams,
    out: &mut StepOut,
) -> R<()> {
    let state = mrd8(pd, s, SM::STATE)?;
    if state != SM::STATE_HOLDING && state != SM::STATE_FREE_CITY {
        return Err(kernel(sub::RECORD));
    }
    let neutral = r.flags & CR::FLAG_NEUTRAL != 0;
    let vigil = (!neutral)
        .then(|| siege3::vigil_of_snapshot(r.vigil_start, r.vigil_next, r.vigil_from_day));
    let mut sg = siege3::SiegeV3 {
        attacker_faction: r.faction,
        declared_bell: r.bell,
        progress: r.progress,
        required: r.required,
        status: SiegeStatus::Active,
    };
    let br = KReport {
        holders: sr.holders,
        defender_present: sr.defender_present,
    };
    let start = prm.genesis_ts.saturating_add(b as i64 * 600);
    let slot = CR::target_slot(r.target);
    match sg.advance(b, start, br, vigil.as_ref()) {
        SiegeStatus::Active => {
            let p = sg.progress;
            if p != r.progress {
                let mut n = r;
                n.progress = p;
                n.write(pd, s)?;
                out.changed = true;
            }
        }
        SiegeStatus::Failed => {
            let holding = CR::target_kind(r.target) != CR::TARGET_FREE_CITY;
            let broken = siege3::broken_by_defender(br);
            let mut n = Record {
                faction: CR::BARRED_NONE,
                ..Record::ZERO
            };
            if holding && broken {
                n.faction = r.faction;
                n.flags |= CR::FLAG_STAKE_TO_HOLDING;
                n.progress = mrd8(pd, s, SM::GEN)?;
                n.bell = b
                    .saturating_add(1)
                    .saturating_add(prm.cq.immunity_bells as u32);
            }
            if slot != 0 {
                n.flags |= CR::FLAG_SLOT_OWED;
                n.required = slot;
                n.actor = r.actor;
            }
            n.write(pd, s)?;
            out.changed = true;
            let code = event::SIEGE_FAILED | if broken { event::DETAIL } else { 0 };
            out.push(s as u8, code, r.faction, r.progress);
        }
        SiegeStatus::Completed => {
            if CR::target_kind(r.target) == CR::TARGET_FIRST {
                // §3.5: occupation; ownership never changes (D9). The
                // stake is owed back to `src` from this bell (D-9 revised,
                // integ-W1): SettleSiege may pay it while the occupation
                // runs, and an occupation still running at `end_bell`
                // keeps it owed, so it is never lost.
                let n = Record {
                    kind: CR::KIND_OCCUPATION,
                    faction: r.faction,
                    flags: CR::FLAG_STAKE_TO_SRC,
                    target: r.target,
                    bell: b,
                    actor: r.actor,
                    src: r.src,
                    ..Record::ZERO
                };
                n.write(pd, s)?;
                out.changed = true;
                out.push(s as u8, event::OCCUPIED, r.faction, r.required);
            } else {
                let credited = capture_flip(pd, s, r.faction, slot, b, prm)?;
                out.quiet_inputs_changed = true;
                let n = Record {
                    kind: CR::KIND_CAPTURE_DUE,
                    faction: r.faction,
                    flags: if credited { CR::FLAG_CREDITED } else { 0 },
                    target: r.target,
                    bell: b,
                    actor: r.actor,
                    src: r.src,
                    ..Record::ZERO
                };
                n.write(pd, s)?;
                out.changed = true;
                let code = event::CAPTURE_DUE | if credited { event::DETAIL } else { 0 };
                out.push(s as u8, code, r.faction, r.required);
            }
        }
    }
    Ok(())
}

/// The site mirror at a capture's completion bell (§3.6, K-23): the
/// captor's from `b + 1`. Returns whether the capture is credited (K-26).
fn capture_flip(
    pd: &mut [u8],
    s: usize,
    captor: u8,
    slot: u8,
    b: u32,
    prm: &StepParams,
) -> R<bool> {
    let o = P::site(s);
    let was_free_city = mrd8(pd, s, SM::STATE)? == SM::STATE_FREE_CITY;
    let held_since = mrd16(pd, s, SM::HELD_SINCE_HOUR)?;
    let credited = siege3::capture_credited(
        b,
        held_since,
        prm.cq.capture_credit_min_bells,
        was_free_city,
    );
    let gen = mrd8(pd, s, SM::GEN)?.wrapping_add(1);
    let walls = mrd32(pd, s, SM::WALLS_COMMITTED)?;
    let keeps_walls = of_faction(captor).is_some_and(|d| d.keeps_walls_on_capture);
    let order = if slot != 0 {
        slot
    } else {
        mrd8(pd, s, SM::ORDER)?
    };
    let hour = permutation_rules::frontier::siege::held_since_hour_from(b.saturating_add(1));
    put(wr_u8(pd, o + SM::STATE, SM::STATE_HOLDING)
        & wr_u8(pd, o + SM::FACTION, captor)
        & wr_u8(pd, o + SM::ORDER, order)
        & wr_u8(pd, o + SM::GEN, gen)
        & wr_u16(pd, o + SM::HELD_SINCE_HOUR, hour)
        & wr_u32(pd, o + SM::GARRISON, 0)
        & wr_u32(pd, o + SM::PEND0_BELL, SM::NO_BELL)
        & wr_arr(pd, o + SM::PEND0_DELTA, &[0; 8])
        & wr_u32(pd, o + SM::PEND1_BELL, SM::NO_BELL)
        & wr_arr(pd, o + SM::PEND1_DELTA, &[0; 8])
        & wr_u32(
            pd,
            o + SM::WALLS_COMMITTED,
            if keeps_walls { walls } else { walls / 2 },
        )
        & wr_u32(pd, o + SM::SHIELD_UNTIL_BELL, 0))?;
    if was_free_city {
        put(wr_u8(pd, o + SM::TIER_NEXT, SM::NO_TIER_NEXT) & wr_u32(pd, o + SM::TIER_NEXT_BELL, 0))?;
    }
    if credited && (captor as usize) < P::FACTIONS {
        let c = P::captures_by(captor as usize);
        let v = rd_u16(pd, c).ok_or(BAD)?.saturating_add(1);
        put(wr_u16(pd, c, v))?;
    }
    Ok(credited)
}

fn step_occupation(
    pd: &mut [u8],
    s: usize,
    r: Record,
    b: u32,
    sr: SiteReport,
    prm: &StepParams,
    out: &mut StepOut,
) -> R<()> {
    if mrd8(pd, s, SM::STATE)? != SM::STATE_HOLDING {
        return Err(kernel(sub::RECORD));
    }
    let occ = r.faction;
    let holds = sr.holders & side_bit(occ) != 0;
    let Some(end) = siege3::occupation_ends(
        holds,
        sr.defender_present,
        b,
        r.bell,
        prm.cq.occupation_tenure_bells as u32,
    ) else {
        return Ok(());
    };
    // D-9 revised (integ-W1): the stake was owed to `src` from the
    // completion bell; a stake SettleSiege has not paid yet stays owed.
    let mut n = Record {
        faction: CR::BARRED_NONE,
        flags: r.flags & CR::FLAG_STAKE_TO_SRC,
        src: r.src,
        ..Record::ZERO
    };
    if end.respite {
        // §3.5 as written: `immune_until_bell = end + respite_bells`
        // (D-12 withdrawn, integ-W1; the simulator's rule).
        n.faction = occ;
        n.bell = b.saturating_add(prm.cq.respite_bells as u32);
    }
    n.write(pd, s)?;
    out.changed = true;
    let code = match end.kind {
        siege3::OccupationEndKind::Liberated => {
            event::LIBERATED | if end.respite { 0 } else { event::DETAIL }
        }
        siege3::OccupationEndKind::Expired => event::OCCUPATION_EXPIRED,
    };
    out.push(s as u8, code, occ, 0);
    Ok(())
}

// ------------------------------------------------------------ control

/// A stored tier byte as the laurel kernel's tier.
pub fn tier_of(v: u8) -> R<Tier> {
    control::tier_from_u8(v).ok_or(BAD)
}

/// The control weights of bell `b` (§3.10), centi-strength-weight per
/// side: every holding (its occupier's while occupied, dormant included)
/// and every Free City (neutral). D-10: a provisional holding counts (the
/// Province carries no finality bit).
pub fn control_weights(pd: &[u8], b: u32) -> R<[u32; P::SIDES]> {
    let mut w = [0u32; P::SIDES];
    let n = (rd_u8(pd, P::SITE_COUNT).ok_or(BAD)? as usize).min(P::SITES_N);
    for s in 0..n {
        let st = mrd8(pd, s, SM::STATE)?;
        let (side, order0) = match st {
            SM::STATE_HOLDING => {
                let r = Record::read(pd, s)?;
                let side = if r.kind == CR::KIND_OCCUPATION {
                    r.faction
                } else {
                    mrd8(pd, s, SM::FACTION)?
                };
                (side, mrd8(pd, s, SM::ORDER)?.saturating_sub(1))
            }
            SM::STATE_FREE_CITY => (NEUTRAL, 0),
            _ => continue,
        };
        let mut tier = mrd8(pd, s, SM::TIER)?;
        let next = mrd8(pd, s, SM::TIER_NEXT)?;
        if st == SM::STATE_HOLDING
            && next != SM::NO_TIER_NEXT
            && mrd32(pd, s, SM::TIER_NEXT_BELL)? <= b
        {
            tier = next;
        }
        let garrison = mrd32(pd, s, SM::GARRISON)?;
        let x = control::site_weight_centi(tier_of(tier)?, garrison, order0);
        let d = w.get_mut(side as usize).ok_or(BAD)?;
        *d = d.saturating_add(x as u32);
    }
    Ok(w)
}

/// The Dominion lead of a weight vector (§3.10's strict rule; never a map
/// colour, R-15).
pub fn dominion_lead(w: &[u32; P::SIDES]) -> Controller {
    control::controller(w)
}

/// Snapshot ring slot `slot`: `(hour, weight)`.
pub fn snapshot(pd: &[u8], slot: usize) -> R<(u32, [u16; P::SIDES])> {
    let o = P::snap(slot % P::SNAP_N);
    let hour = rd_u32(pd, o + SN::HOUR).ok_or(BAD)?;
    let mut w = [0u16; P::SIDES];
    for (i, x) in w.iter_mut().enumerate() {
        *x = rd_u16(pd, o + SN::WEIGHT + 2 * i).ok_or(BAD)?;
    }
    Ok((hour, w))
}

/// The weights of hour `h`, if the ring slot `h mod 6` still holds them.
pub fn snapshot_slot(pd: &[u8], h: u32) -> R<Option<[u16; P::SIDES]>> {
    let (hour, w) = snapshot(pd, h as usize)?;
    Ok((hour == h).then_some(w))
}

/// The CONQUEST payload of bell `b`'s step (§6 kind 82).
pub fn conquest_payload(pd: &[u8], out: &StepOut) -> R<ConquestPayload> {
    let digest = sha256(&[pd.get(P::RECORDS_AND_KEEP).ok_or(BAD)?]);
    let k = read_keep(pd)?;
    Ok(ConquestPayload {
        events: out.events,
        n: out.n,
        records_digest: digest,
        keep_holder: k.map_or(KP::NONE, |k| k.holder),
        keep_contender: k.map_or(KP::NONE, |k| k.contender),
        keep_progress: k.map_or(0, |k| k.progress),
        keep_troops: k.map_or(0, |k| k.troops),
        donor_host_id: out.keep_taken.map_or(0, |t| t.donor_host_id),
        snapshot: out.snapshot,
    })
}

// ------------------------------------------------------------ the fold

/// Why FoldMarch cannot fold an hour (§5.5 0xA5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldError {
    /// A member resolved only through `≤ 6h` (lag only waits: code 77).
    TooEarly,
    /// `hour != next_hour` (code 76).
    OutOfOrder,
    Model(ModelError),
}

impl From<ModelError> for FoldError {
    fn from(e: ModelError) -> Self {
        FoldError::Model(e)
    }
}

/// One member's hour-h sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sample {
    /// Absent, or opened after bell 6h: weight 0.
    Zero,
    Weight([u16; P::SIDES]),
    /// The ring slot moved past h: the hour is lost.
    Lost,
}

/// The sample of one member Province for hour `h` (§5.5 0xA5 table).
pub fn member_sample(member: Option<&[u8]>, h: u32) -> Result<Sample, FoldError> {
    let Some(pd) = member else {
        return Ok(Sample::Zero);
    };
    let bell = h.checked_mul(HOUR_BELLS).ok_or(FoldError::Model(BAD))?;
    if rd_u32(pd, P::OPENED_BELL).ok_or(BAD)? > bell {
        return Ok(Sample::Zero);
    }
    if rd_u32(pd, P::RESOLVED_NEXT).ok_or(BAD)? <= bell {
        return Err(FoldError::TooEarly);
    }
    let (hour, w) = snapshot(pd, h as usize)?;
    Ok(if hour == h {
        Sample::Weight(w)
    } else {
        Sample::Lost
    })
}

/// One folded March-hour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HourFold {
    pub hour: u32,
    pub weight: [u32; P::SIDES],
    pub controller: Controller,
    pub lost: bool,
    /// Σ members' `captures_by` (credited captures only).
    pub captures: [u16; P::FACTIONS],
}

/// Combines the seven members' hour-h samples (in `march_members` order;
/// `None` = absent at its canonical address).
pub fn fold(members: &[Option<&[u8]>; 7], h: u32) -> Result<HourFold, FoldError> {
    let mut weight = [0u32; P::SIDES];
    let mut captures = [0u16; P::FACTIONS];
    let mut lost = false;
    for m in members {
        match member_sample(*m, h)? {
            Sample::Zero => {}
            Sample::Lost => lost = true,
            Sample::Weight(w) => {
                for (d, x) in weight.iter_mut().zip(w) {
                    *d = d.saturating_add(x as u32);
                }
            }
        }
        if let Some(pd) = m {
            for (f, c) in captures.iter_mut().enumerate() {
                let v = rd_u16(pd, P::captures_by(f)).ok_or(BAD)?;
                *c = c.saturating_add(v);
            }
        }
    }
    Ok(HourFold {
        hour: h,
        weight,
        controller: control::controller(&weight),
        lost,
        captures,
    })
}

/// The MarchState's first hour: `⌈min opened_bell over present members / 6⌉`
/// (`None` when no member is present).
pub fn first_hour(members: &[Option<&[u8]>; 7]) -> R<Option<u32>> {
    let mut lo: Option<u32> = None;
    for pd in members.iter().flatten() {
        let ob = rd_u32(pd, P::OPENED_BELL).ok_or(BAD)?;
        lo = Some(lo.map_or(ob, |x| x.min(ob)));
    }
    Ok(lo.map(|b| b.div_ceil(HOUR_BELLS)))
}

/// What one folded hour wrote (MARCH_FOLD's payload, §6 kind 85).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FoldLog {
    pub weight: [u32; P::SIDES],
    pub controller: u8,
    pub contested: u8,
    /// The faction credited (0xFF none).
    pub credit: u8,
    pub lost: u8,
    pub captures: [u16; P::FACTIONS],
}

impl FoldLog {
    /// MARCH_FOLD's 44-B payload.
    pub fn to_bytes(&self) -> [u8; 44] {
        let mut d = [0u8; 44];
        let mut w = crate::bytes::Writer::new(&mut d);
        for x in self.weight {
            w.u32(x);
        }
        w.u8(self.controller)
            .u8(self.contested)
            .u8(self.credit)
            .u8(self.lost);
        for c in self.captures {
            w.u16(c);
        }
        d
    }
}

/// Applies one folded hour to the MarchState (§3.10, §5.2.6): the hour
/// must be `next_hour`; a lost hour credits nobody.
pub fn apply_fold(
    march: &mut [u8],
    hf: &HourFold,
    dominion_per_hour: u16,
) -> Result<FoldLog, FoldError> {
    let next = rd_u32(march, MS::NEXT_HOUR).ok_or(BAD)?;
    if next != hf.hour {
        return Err(FoldError::OutOfOrder);
    }
    let mut log = FoldLog {
        weight: hf.weight,
        controller: MS::CONTROLLER_NONE,
        contested: 0,
        credit: MS::CONTROLLER_NONE,
        lost: hf.lost as u8,
        captures: hf.captures,
    };
    if hf.lost {
        let v = rd_u32(march, MS::LOST_HOURS).ok_or(BAD)?.saturating_add(1);
        put(wr_u32(march, MS::LOST_HOURS, v))?;
        log.controller = rd_u8(march, MS::CONTROLLER).ok_or(BAD)?;
        log.contested = rd_u8(march, MS::CONTESTED).ok_or(BAD)?;
    } else {
        let (ctrl, contested) = match hf.controller {
            Controller::Side(s) => (s, 0),
            Controller::Contested => (MS::CONTROLLER_NONE, 1),
            Controller::Unsettled => (MS::CONTROLLER_NONE, 0),
        };
        if ctrl != rd_u8(march, MS::CONTROLLER).ok_or(BAD)? {
            put(wr_u32(march, MS::LAST_FLIP_HOUR, hf.hour))?;
        }
        put(wr_u8(march, MS::CONTROLLER, ctrl) & wr_u8(march, MS::CONTESTED, contested))?;
        for (i, x) in hf.weight.iter().enumerate() {
            put(wr_u32(march, MS::weight(i), *x))?;
        }
        if (ctrl as usize) < P::FACTIONS {
            let f = ctrl as usize;
            let d = rd_u32(march, MS::dominion_bells(f))
                .ok_or(BAD)?
                .saturating_add(dominion_per_hour as u32);
            let c = rd_u32(march, MS::control_hours(f))
                .ok_or(BAD)?
                .saturating_add(1);
            put(wr_u32(march, MS::dominion_bells(f), d) & wr_u32(march, MS::control_hours(f), c))?;
            log.credit = ctrl;
        }
        log.controller = ctrl;
        log.contested = contested;
    }
    for (f, c) in hf.captures.iter().enumerate() {
        put(wr_u16(march, MS::captures(f), *c))?;
    }
    put(wr_u32(march, MS::NEXT_HOUR, next.saturating_add(1)))?;
    Ok(log)
}

/// Faction Dominion points of one MarchState (§3.10): `dominion_bells[f] +
/// dominion_per_capture × captures[f]`.
pub fn march_dominion(march: &[u8], dominion_per_capture: u16) -> R<[u64; P::FACTIONS]> {
    let mut out = [0u64; P::FACTIONS];
    for (f, o) in out.iter_mut().enumerate() {
        let d = rd_u32(march, MS::dominion_bells(f)).ok_or(BAD)? as u64;
        let c = rd_u16(march, MS::captures(f)).ok_or(BAD)? as u64;
        *o = d + dominion_per_capture as u64 * c;
    }
    Ok(out)
}

/// `(P, Q)` of a v2 Province.
pub fn coord(pd: &[u8]) -> R<(i32, i32)> {
    Ok((
        rd_i16(pd, P::P).ok_or(BAD)? as i32,
        rd_i16(pd, P::Q).ok_or(BAD)? as i32,
    ))
}
