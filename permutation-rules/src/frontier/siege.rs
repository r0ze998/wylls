//! Sieges, vigils, protection, auto-reinforce and raids (design §6.3,
//! §6.6, owner decision D9).
//!
//! * A siege is declared publicly (the siege horn) and needs
//!   **36 + walls/50 bells** of progress. Progress rises by 1 per
//!   **resolved** bell in which the declaring faction's own hosts hold the
//!   holding's hex (`BellReport::holds`; a third faction taking the hex
//!   does not advance it) and no defending host is present, **except
//!   during the owner's vigil**: an
//!   8-hour daily window during which progress pauses. So a siege needs at
//!   least 6 hours outside the defender's vigil.
//! * Whether a bell falls in the vigil is decided by the bell's scheduled
//!   start time, never by when it was resolved, and each bell is counted at
//!   most once: siege progress does not depend on keeper lag (design §8.4).
//!   A run of quiet bells (`clash::is_quiet`) is counted at once by
//!   [`Siege::advance_quiet`], with the same result.
//! * Protection: Shield (48 h, 72 h after day 7), Frontier protection (7
//!   days after the Shield, holdings founded after day 2 can be besieged
//!   only by factions with a holding within 2 provinces), heartlands (no
//!   sieges without War or March hostility), Seats never.
//! * Completion occupies a first holding (never transferred) and captures
//!   holdings 2–3 and Free Cities.

/// Version of this kernel, bound into `RULESET_HASH` (`super::KERNEL_VERSIONS`):
/// bump it whenever an honest outcome changes. v2: M1 CL-09 vigil change rule (midnight switch, first new window skipped unless a day after the last old one).
pub const SIEGE_VERSION: u16 = 2;
/// The conquest rules' version (MC §3.4–§3.6, §7): sieges declared from
/// the hex (no start window), Free Cities without a vigil, the bounded
/// `TooLate` check, faction-scoped immunity and Respite, capture credit
/// and the heartland as a season parameter. The v3 API lives beside the v2
/// one ([`SiegeCheckV3`], [`may_besiege_v3`], [`SiegeV3`], …); bound into
/// `ruleset_hash_input_v2` only, [`SIEGE_VERSION`] keeps the M1 value
/// (staged ABI, MC §5.1).
pub const SIEGE_VERSION_V3: u16 = 3;

use super::doctrine::bounds::SIEGE_EXTRA_MAX;
use super::geometry::{is_heartland, is_heartland_in, march_of, valid_faction, ProvinceCoord};
use super::holding::{Holding, MAX_WALLS, RESOURCES};
use crate::fixed::{Bps, Milli, MilliTroops, BPS_ONE};
use alloc::vec;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};

pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 86_400;
pub const SIEGE_BASE_BELLS: u32 = 36;
/// One more bell per this many wall points.
pub const WALL_POINTS_PER_BELL: u32 = 50;
pub const VIGIL_SECS: i64 = 8 * HOUR;
/// The vigil can change once a week, with 24 hours' notice.
pub const VIGIL_CHANGE_INTERVAL: i64 = 7 * DAY;
pub const VIGIL_NOTICE: i64 = 24 * HOUR;
/// A declared siege lapses if its besiegers never hold the hex within this
/// many bells of the horn [design].
pub const SIEGE_START_WINDOW_BELLS: u32 = 72;
/// Laurels a siege stakes (paid to the defender if it fails).
pub const SIEGE_STAKE_LAURELS: u32 = 5;
pub const FRONTIER_PROTECTION_SECS: i64 = 7 * DAY;
/// Holdings founded after this season day get Frontier protection.
pub const FRONTIER_PROTECTION_AFTER_DAY: u32 = 2;
pub const FRONTIER_PROTECTION_RANGE: u32 = 2;
/// Auto-reinforce sends at most this share of a donor's garrison.
pub const AUTO_REINFORCE_MAX_BPS: Bps = 2_500;
/// A raid loots at most this share of each stock …
pub const RAID_MAX_BPS: Bps = 1_000;
/// … at most once per this long per holding.
pub const RAID_INTERVAL: i64 = 6 * HOUR;

/// Most bells of progress a siege can need (CL-02): walls are capped at
/// `holding::MAX_WALLS` and a valid doctrine adds at most
/// `doctrine::bounds::SIEGE_EXTRA_MAX` (24; Wardens of Stone use 12), so
/// `36 + 1,200/50 + 24 = 84` bells (14 hours).
pub const MAX_REQUIRED_BELLS: u32 = required_bells(MAX_WALLS, SIEGE_EXTRA_MAX);

/// Bells of progress a siege needs: `36 + walls/50`, plus a doctrine's
/// extra bells (e.g. Wardens of Stone in their heartland: +12). Walls are
/// read at most `MAX_WALLS` (CL-02) and the sum saturates, so the result
/// is finite for any input.
pub const fn required_bells(walls: u32, extra: u32) -> u32 {
    let w = if walls < MAX_WALLS { walls } else { MAX_WALLS };
    (SIEGE_BASE_BELLS + w / WALL_POINTS_PER_BELL).saturating_add(extra)
}

/// A holding's vigil: an 8-hour daily window (seconds after UTC midnight
/// it starts). The last three schedules are kept so any unresolved bell is
/// judged by the schedule in force at its scheduled start.
///
/// **Windows and changes (CL-09).** A change takes effect at the first UTC
/// midnight at least [`VIGIL_NOTICE`] after the request. Each 8-hour window
/// belongs to the schedule in force when it **starts**, so a window that
/// began before the change runs to its end. The first window of the new
/// schedule is skipped unless it starts at least one day after the last
/// old window started (integ-W1 review of CL-09). So at least 16 hours stay
/// open after the last old window, no 24-hour span is covered for more than
/// 8 hours, and at bell granularity (600-s bells, the unit a siege counts)
/// no run of covered bell starts is longer than 48 and no 144 consecutive
/// bells hold more than 48 covered ones. The first rule ("skipped if it
/// starts before the last old window has ended") still allowed a 16-hour
/// vigil at bell granularity: 16:00 → 00:01 gave 96 consecutive covered
/// bells, with a one-minute gap that falls between two bell starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Vigil {
    /// `(effective_from_ts, start_secs_of_day)`, oldest first.
    pub schedule: [(i64, u32); 3],
    /// When the last change was requested (`i64::MIN`: never).
    pub last_request: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VigilError {
    /// Changed less than a week ago.
    TooSoon {
        next_ts: i64,
    },
    BadStart,
}

impl Vigil {
    /// Chosen at join (default 00:00–08:00 in the player's time zone).
    pub fn new(start_secs: u32) -> Result<Vigil, VigilError> {
        if start_secs as i64 >= DAY {
            return Err(VigilError::BadStart);
        }
        Ok(Vigil {
            schedule: [(i64::MIN, start_secs); 3],
            last_request: i64::MIN,
        })
    }

    /// Window start (seconds of day) in force at `ts`.
    pub fn start_at(&self, ts: i64) -> u32 {
        self.schedule[self.entry_at(ts)].1
    }

    /// Index of the schedule entry in force at `ts` (entry 0 also covers
    /// every earlier time).
    fn entry_at(&self, ts: i64) -> usize {
        let mut j = 0;
        for (i, (from, _)) in self.schedule.iter().enumerate() {
            if *from <= ts {
                j = i;
            }
        }
        j
    }

    /// Start of the latest window, among entries `0..=j`, that starts at or
    /// before `t` and is not skipped (the type's doc). Recursion depth ≤ 2.
    fn window_start(&self, t: i64, j: usize) -> i64 {
        let (from, start) = self.schedule[j];
        let ws = last_start(t, start);
        if j == 0 || from == i64::MIN {
            return ws;
        }
        if ws < from {
            // No window of entry j yet: the previous entry's last one.
            return self.window_start(t.min(from - 1), j - 1);
        }
        if ws - DAY < from {
            // Entry j's first window: skipped unless it starts a full day
            // after the previous entry's last window started.
            let prev = self.window_start(from - 1, j - 1);
            if ws < prev.saturating_add(DAY) {
                return prev;
            }
        }
        ws
    }

    /// Whether `ts` falls in a vigil window (the type's doc: each window
    /// belongs to the schedule in force at its start).
    pub fn covers(&self, ts: i64) -> bool {
        ts < self.window_start(ts, self.entry_at(ts)) + VIGIL_SECS
    }

    /// Move the window, effective at the first UTC midnight at least 24
    /// hours from `now` (CL-09); at most once a week. Returns when the new
    /// schedule takes effect (always a multiple of 86,400).
    pub fn request_change(&mut self, now: i64, start_secs: u32) -> Result<i64, VigilError> {
        if start_secs as i64 >= DAY {
            return Err(VigilError::BadStart);
        }
        if self.last_request != i64::MIN && now < self.last_request + VIGIL_CHANGE_INTERVAL {
            return Err(VigilError::TooSoon {
                next_ts: self.last_request + VIGIL_CHANGE_INTERVAL,
            });
        }
        let from = change_effective_at(now);
        self.schedule = [self.schedule[1], self.schedule[2], (from, start_secs)];
        self.last_request = now;
        Ok(from)
    }
}

/// When a vigil change requested at `now` takes effect: the first UTC
/// midnight at or after `now + VIGIL_NOTICE` (CL-09).
pub const fn change_effective_at(now: i64) -> i64 {
    let t = now + VIGIL_NOTICE;
    let r = t.rem_euclid(DAY);
    if r == 0 {
        t
    } else {
        t - r + DAY
    }
}

/// The latest `ws ≤ t` with `ws ≡ start (mod DAY)`.
const fn last_start(t: i64, start: u32) -> i64 {
    let ws = t - t.rem_euclid(DAY) + start as i64;
    if ws <= t {
        ws
    } else {
        ws - DAY
    }
}

/// What kind of holding is attacked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum HoldingKind {
    /// A citizen's first holding: occupied, never taken.
    First,
    /// A citizen's second or third holding: capturable.
    Other,
    /// Neutral: released holdings and barbarian towns; always attackable.
    FreeCity,
    /// A faction Seat (ring 1): never capturable.
    Seat,
}

/// Diplomatic state of the attacker's faction toward the owner's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Relation {
    Rivalry,
    War,
    Peace,
    Nap,
    Alliance,
}

/// Everything `may_besiege` needs, read from the target Holding, its
/// Province, FactionState and the attacker's Citizen.
#[derive(Clone, Copy, Debug)]
pub struct SiegeCheck {
    pub province: ProvinceCoord,
    pub kind: HoldingKind,
    pub owner_faction: u8,
    pub attacker_faction: u8,
    pub relation: Relation,
    /// A March hostility in force between the two factions at this March
    /// (counts as War for heartland rules, design §4.2).
    pub march_hostility: bool,
    /// A March truce of the owner's March toward the attacker's faction.
    pub march_truce: bool,
    pub founded_ts: i64,
    pub founded_day: u32,
    pub shield_until: i64,
    pub dormant: bool,
    /// The attacker's faction has a holding within 2 provinces.
    pub attacker_nearby: bool,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiegeRefusal {
    /// A faction id outside `0..=5` (the owner may also be `NEUTRAL` for a
    /// Free City); CL-06.
    BadFaction,
    Seat,
    Friendly,
    Shielded,
    FrontierProtected,
    Heartland,
    Truce,
}

/// Whether the attacker may declare a siege now.
pub fn may_besiege(c: &SiegeCheck) -> Result<(), SiegeRefusal> {
    if !valid_faction(c.attacker_faction, false)
        || !valid_faction(c.owner_faction, c.kind == HoldingKind::FreeCity)
    {
        return Err(SiegeRefusal::BadFaction);
    }
    if c.kind == HoldingKind::Seat || c.province.is_seat() {
        return Err(SiegeRefusal::Seat);
    }
    if c.kind == HoldingKind::FreeCity {
        return Ok(());
    }
    if c.owner_faction == c.attacker_faction
        || matches!(
            c.relation,
            Relation::Peace | Relation::Nap | Relation::Alliance
        )
    {
        return Err(SiegeRefusal::Friendly);
    }
    if c.now < c.shield_until && !c.dormant {
        return Err(SiegeRefusal::Shielded);
    }
    if c.founded_day > FRONTIER_PROTECTION_AFTER_DAY
        && c.now < c.shield_until + FRONTIER_PROTECTION_SECS
        && !c.attacker_nearby
    {
        return Err(SiegeRefusal::FrontierProtected);
    }
    if c.march_truce {
        return Err(SiegeRefusal::Truce);
    }
    let war = c.relation == Relation::War || c.march_hostility;
    if is_heartland(c.province, c.owner_faction) && !war {
        return Err(SiegeRefusal::Heartland);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum SiegeStatus {
    Active,
    /// Progress reached the requirement: occupy or capture.
    Completed,
    /// The besiegers lost the hex (or never took it): the stake goes to
    /// the defender.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Siege {
    pub attacker_faction: u8,
    pub declared_bell: u32,
    /// Last resolved bell counted (each bell once, in order).
    pub last_bell: u32,
    pub progress: u32,
    pub required: u32,
    /// The besiegers have held the hex at some counted bell.
    pub held: bool,
    pub status: SiegeStatus,
}

/// What the clash of one bell reported about the besieged hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BellReport {
    /// Bit f set: faction f (hostile to the owner) holds the holding's hex
    /// with a host of its own after the clash (`GarrisonResult::holders`).
    pub holders: u8,
    /// A host of the owner (or an ally) stands on the hex.
    pub defender_present: bool,
}

impl BellReport {
    /// Whether `faction` holds the hex (only the siege's declarer counts:
    /// a third faction taking the hex does not advance another's siege).
    /// Only a valid faction id (`geometry::valid_faction`, CL-06) can.
    pub const fn holds(&self, faction: u8) -> bool {
        valid_faction(faction, true) && self.holders & (1 << faction) != 0
    }
}

/// Bells in `[b0, b1)` whose scheduled start falls outside `vigil`
/// (bell b starts at `genesis_ts + 600 b`). O(1) in the length of the
/// range: a day is exactly 144 bells, so whole days are counted once per
/// schedule segment and only the remainder bell by bell (≤ 2 × 144 checks
/// per segment, ≤ 10 segments).
pub fn bells_outside_vigil(vigil: &Vigil, genesis_ts: i64, b0: u32, b1: u32) -> u32 {
    const BELL: i64 = 600;
    const PER_DAY: u32 = (DAY / BELL) as u32;
    let start = |b: u32| genesis_ts + b as i64 * BELL;
    if b1 <= b0 {
        return 0;
    }
    // Segment boundaries: the first bell starting at or after each change,
    // and one and two days later. Coverage is periodic between them: the
    // two days after a change hold the last old window's tail and the new
    // schedule's first (possibly skipped) window, which can start late in
    // the first day and run into the second, so each is counted on its own
    // (CL-09).
    let mut cuts: Vec<u32> = vec![b0];
    for (from, _) in vigil.schedule {
        if from == i64::MIN {
            continue;
        }
        for t in [from, from.saturating_add(DAY), from.saturating_add(2 * DAY)] {
            let k = if t <= genesis_ts {
                0
            } else {
                ((t - genesis_ts + BELL - 1) / BELL).min(u32::MAX as i64) as u32
            };
            if k > b0 && k < b1 {
                cuts.push(k);
            }
        }
    }
    cuts.push(b1);
    cuts.sort_unstable();
    cuts.dedup();
    let mut total = 0u32;
    for w in cuts.windows(2) {
        let (s0, s1) = (w[0], w[1]);
        let n = s1 - s0;
        let days = n / PER_DAY;
        let mut per_day = 0;
        if days > 0 {
            for b in s0..s0 + PER_DAY {
                per_day += !vigil.covers(start(b)) as u32;
            }
        }
        let mut tail = 0;
        for b in s0 + days * PER_DAY..s1 {
            tail += !vigil.covers(start(b)) as u32;
        }
        total += days * per_day + tail;
    }
    total
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiegeError {
    /// Bells must be counted in order: this one is not `last_bell + 1`.
    OutOfOrder {
        expected: u32,
    },
    NotActive,
}

impl Siege {
    /// The horn at bell `b`: counting starts with the next bell.
    pub const fn declare(attacker_faction: u8, b: u32, walls: u32, extra: u32) -> Siege {
        Siege {
            attacker_faction,
            declared_bell: b,
            last_bell: b,
            progress: 0,
            required: required_bells(walls, extra),
            held: false,
            status: SiegeStatus::Active,
        }
    }

    /// Count resolved bell `b` (scheduled start `bell_start_ts`). Returns
    /// the status after it.
    pub fn advance(
        &mut self,
        b: u32,
        bell_start_ts: i64,
        report: BellReport,
        vigil: &Vigil,
    ) -> Result<SiegeStatus, SiegeError> {
        if self.status != SiegeStatus::Active {
            return Err(SiegeError::NotActive);
        }
        if b != self.last_bell + 1 {
            return Err(SiegeError::OutOfOrder {
                expected: self.last_bell + 1,
            });
        }
        self.last_bell = b;
        if !report.holds(self.attacker_faction) {
            // Before the besiegers first hold the hex the siege waits for
            // them (up to the start window); after, losing it fails it.
            if self.held || b > self.declared_bell + SIEGE_START_WINDOW_BELLS {
                self.status = SiegeStatus::Failed;
            }
            return Ok(self.status);
        }
        self.held = true;
        if report.defender_present || vigil.covers(bell_start_ts) {
            return Ok(self.status);
        }
        self.progress += 1;
        if self.progress >= self.required {
            self.status = SiegeStatus::Completed;
        }
        Ok(self.status)
    }

    /// Count the quiet bells `last_bell + 1 ..= to_bell` at once
    /// (`clash::is_quiet`: nothing changed, so every one of them reports
    /// `report`, the last resolved bell's report). Gives exactly the state
    /// of calling [`Siege::advance`] for each, in O(1) of the run's length.
    pub fn advance_quiet(
        &mut self,
        to_bell: u32,
        genesis_ts: i64,
        report: BellReport,
        vigil: &Vigil,
    ) -> Result<SiegeStatus, SiegeError> {
        if self.status != SiegeStatus::Active {
            return Err(SiegeError::NotActive);
        }
        let b0 = self.last_bell + 1;
        if to_bell < b0 {
            return Err(SiegeError::OutOfOrder { expected: b0 });
        }
        if !report.holds(self.attacker_faction) {
            let deadline = self.declared_bell + SIEGE_START_WINDOW_BELLS + 1;
            let fail_at = if self.held { b0 } else { deadline.max(b0) };
            if fail_at <= to_bell {
                self.last_bell = fail_at;
                self.status = SiegeStatus::Failed;
            } else {
                self.last_bell = to_bell;
            }
            return Ok(self.status);
        }
        self.held = true;
        if report.defender_present {
            self.last_bell = to_bell;
            return Ok(self.status);
        }
        let need = self.required.saturating_sub(self.progress);
        let got = bells_outside_vigil(vigil, genesis_ts, b0, to_bell + 1);
        if got < need {
            self.progress += got;
            self.last_bell = to_bell;
            return Ok(self.status);
        }
        // The bell that completes it: the smallest e with `need` counted
        // bells in [b0, e] (binary search over the O(1) count).
        let (mut lo, mut hi) = (b0, to_bell);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if bells_outside_vigil(vigil, genesis_ts, b0, mid + 1) >= need {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        self.progress = self.required;
        self.last_bell = lo;
        self.status = SiegeStatus::Completed;
        Ok(self.status)
    }
}

/// What a completed siege does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    /// First holding: the occupier takes 50% of its laurel emission share
    /// and 20% of its production as tribute while it keeps a host in the
    /// province; the owner can Liberate by winning a clash there.
    Occupy,
    /// Holdings 2–3 and Free Cities change hands.
    Capture,
}

pub const OCCUPY_LAUREL_BPS: Bps = 5_000;
pub const OCCUPY_TRIBUTE_BPS: Bps = 2_000;

pub const fn completion(kind: HoldingKind) -> Option<Completion> {
    match kind {
        HoldingKind::First => Some(Completion::Occupy),
        HoldingKind::Other | HoldingKind::FreeCity => Some(Completion::Capture),
        HoldingKind::Seat => None,
    }
}

/// A friendly holding with a standing auto-reinforce order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Donor {
    pub id: u64,
    pub province: ProvinceCoord,
    pub faction: u8,
    pub garrison: MilliTroops,
    /// Share of its garrison the order sends (capped at 25%).
    pub order_bps: Bps,
}

/// Auto-reinforce (design §6.3): donors of the same faction in the same
/// March as the besieged holding each send `garrison × min(order, 25%)`.
/// Returns `(donor id, troops sent)` sorted by donor id; the transfers take
/// effect at the next bell like any garrison change.
pub fn auto_reinforce(
    target_id: u64,
    target: ProvinceCoord,
    faction: u8,
    donors: &[Donor],
) -> Vec<(u64, MilliTroops)> {
    let m = march_of(target);
    let mut out: Vec<(u64, MilliTroops)> = donors
        .iter()
        .filter(|d| d.id != target_id && d.faction == faction && march_of(d.province) == m)
        .map(|d| {
            let bps = d.order_bps.min(AUTO_REINFORCE_MAX_BPS);
            (
                d.id,
                (d.garrison as u64 * bps as u64 / BPS_ONE as u64) as MilliTroops,
            )
        })
        .filter(|(_, t)| *t > 0)
        .collect();
    out.sort();
    out.dedup_by_key(|x| x.0);
    out
}

/// Raid loot: at most 10% of each stock, at most once per 6 hours per
/// holding (`last_raid` is the previous raid's time). Settles the holding
/// to `now` and takes the loot; returns what was taken.
pub fn raid(holding: &mut Holding, last_raid: Option<i64>, now: i64) -> Option<[Milli; RESOURCES]> {
    if last_raid.is_some_and(|t| now < t + RAID_INTERVAL) {
        return None;
    }
    let stock = holding.stock_at(now);
    let loot: [Milli; RESOURCES] =
        core::array::from_fn(|r| stock[r].max(0) * RAID_MAX_BPS as i64 / BPS_ONE as i64);
    holding.pay(now, &loot).ok()?;
    Some(loot)
}

// ====================================================================
// Siege v3: the conquest rules (MC contract §3.4–§3.6, §7)
// ====================================================================

/// Bells per day (a bell is 600 s).
const BELLS_PER_DAY: u32 = 144;
const BELL_SECS: i64 = 600;

/// Any [`VIGIL_WINDOW_BOUND`] consecutive bells hold at least
/// [`VIGIL_WINDOW_MIN_OUTSIDE`] bells whose start lies outside a vigil
/// schedule (MC §3.4 step 9, R-08). CL-09 bounds the covered bells of any
/// 144 consecutive bells by 48 (`Vigil`'s doc), so 288 bells hold at most
/// 96 covered and at least 192 outside; the contract pins the weaker 96,
/// which is ≥ every `required` a siege can need (`MAX_REQUIRED_BELLS` 84).
/// `cq_vigil_window_bound` checks it over random schedules with pending
/// changes.
pub const VIGIL_WINDOW_BOUND: u32 = 288;
/// See [`VIGIL_WINDOW_BOUND`].
pub const VIGIL_WINDOW_MIN_OUTSIDE: u32 = 96;

/// `barred_faction` of a post-capture immunity: every faction (MC §5.2.1).
pub const BARRED_ALL: u8 = 0xFE;
/// `barred_faction` of a record with no immunity.
pub const BARRED_NONE: u8 = 0xFF;

/// Whether bell `b`'s scheduled start lies inside `vigil` (a Free City,
/// `None`, has no vigil).
fn covered(vigil: Option<&Vigil>, genesis_ts: i64, b: u32) -> bool {
    match vigil {
        Some(v) => v.covers(genesis_ts + b as i64 * BELL_SECS),
        None => false,
    }
}

/// `may_besiege` input for the conquest rules (MC §3.4 step 8). The M1
/// fields of [`SiegeCheck`] except `founded_day`, which the season
/// parameters replace: Frontier protection applies to a holding founded
/// more than `frontier_protect_after_secs` after `genesis_ts`, for
/// `frontier_protect_secs` after its shield ends (M1: day > 2, 7 days).
#[derive(Clone, Copy, Debug)]
pub struct SiegeCheckV3 {
    pub province: ProvinceCoord,
    pub kind: HoldingKind,
    pub owner_faction: u8,
    pub attacker_faction: u8,
    /// MC: always `Rivalry` (§3.9); M3 plugs in here.
    pub relation: Relation,
    /// MC: always `false`.
    pub march_hostility: bool,
    /// MC: always `false`.
    pub march_truce: bool,
    pub founded_ts: i64,
    /// End of the target's shield (`shield_secs` or `outpost_shield_secs`
    /// after founding, per the season's `LifecycleParams`).
    pub shield_until: i64,
    pub dormant: bool,
    /// The attacker's faction has a **first** holding within 2 provinces
    /// (the caller proves it with a named Province, MC §3.4 step 8).
    pub attacker_nearby: bool,
    pub now: i64,
    pub heartland_max_ring: u8,
    pub frontier_protect_secs: i64,
    pub frontier_protect_after_secs: i64,
    pub genesis_ts: i64,
}

/// Whether the attacker may declare a siege now under the conquest rules:
/// [`may_besiege`]'s order (faction ids, Seat, Free City accepted, same
/// faction or peace, shield unless dormant, Frontier protection, truce,
/// heartland unless at war) with the season's protection timers and
/// `heartland_max_ring`.
pub fn may_besiege_v3(c: &SiegeCheckV3) -> Result<(), SiegeRefusal> {
    if !valid_faction(c.attacker_faction, false)
        || !valid_faction(c.owner_faction, c.kind == HoldingKind::FreeCity)
    {
        return Err(SiegeRefusal::BadFaction);
    }
    if c.kind == HoldingKind::Seat || c.province.is_seat() || c.province.is_concord() {
        return Err(SiegeRefusal::Seat);
    }
    if c.kind == HoldingKind::FreeCity {
        return Ok(());
    }
    if c.owner_faction == c.attacker_faction
        || matches!(
            c.relation,
            Relation::Peace | Relation::Nap | Relation::Alliance
        )
    {
        return Err(SiegeRefusal::Friendly);
    }
    if c.now < c.shield_until && !c.dormant {
        return Err(SiegeRefusal::Shielded);
    }
    let late = c.founded_ts.saturating_sub(c.genesis_ts) > c.frontier_protect_after_secs;
    if late && c.now < c.shield_until.saturating_add(c.frontier_protect_secs) && !c.attacker_nearby
    {
        return Err(SiegeRefusal::FrontierProtected);
    }
    if c.march_truce {
        return Err(SiegeRefusal::Truce);
    }
    let war = c.relation == Relation::War || c.march_hostility;
    if is_heartland_in(c.province, c.owner_faction, c.heartland_max_ring) && !war {
        return Err(SiegeRefusal::Heartland);
    }
    Ok(())
}

/// A conquest-rules siege (MC §3.4), the state its 32-byte record holds.
/// Declared from the hex by its lead host, so the besiegers hold the hex
/// from the horn: there is no start window, and the first counted bell at
/// which the attacker faction does not hold the hex fails it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SiegeV3 {
    pub attacker_faction: u8,
    pub declared_bell: u32,
    pub progress: u8,
    /// `required_bells(walls at bell_start(declared), 0)` (≤ 60 in MC).
    pub required: u8,
    pub status: SiegeStatus,
}

impl SiegeV3 {
    /// The horn at bell `b` (counting starts with `b + 1`). `required` is
    /// `required_bells(walls, extra)` saturated to `u8`.
    pub fn declare(attacker_faction: u8, b: u32, walls: u32, extra: u32) -> SiegeV3 {
        SiegeV3 {
            attacker_faction,
            declared_bell: b,
            progress: 0,
            required: required_bells(walls, extra).min(u8::MAX as u32) as u8,
            status: SiegeStatus::Active,
        }
    }

    /// Count bell `b` (scheduled start `start`; the caller counts each bell
    /// after `declared_bell` once, in order). `vigil` is the schedule
    /// snapshotted at the horn, `None` for a Free City.
    ///
    /// * the attacker faction does not hold the hex → **Failed**;
    /// * else a defender on the hex or a bell inside the vigil → no change;
    /// * else progress + 1, **Completed** at `required`.
    pub fn advance(
        &mut self,
        b: u32,
        start: i64,
        r: BellReport,
        vigil: Option<&Vigil>,
    ) -> SiegeStatus {
        let _ = b;
        if self.status != SiegeStatus::Active {
            return self.status;
        }
        if !r.holds(self.attacker_faction) {
            self.status = SiegeStatus::Failed;
            return self.status;
        }
        if r.defender_present || vigil.is_some_and(|v| v.covers(start)) {
            return self.status;
        }
        self.progress = self.progress.saturating_add(1);
        if self.progress >= self.required {
            self.status = SiegeStatus::Completed;
        }
        self.status
    }

    /// Count the quiet bells `b0 ..= b1` at once (every one reports `r`).
    /// Returns the status and the last bell counted: the bell that failed
    /// or completed the siege, else `b1`. Equal to calling
    /// [`SiegeV3::advance`] for each bell (`cq_siege_v3_quiet_equals_bells`).
    pub fn advance_quiet(
        &mut self,
        b0: u32,
        b1: u32,
        genesis_ts: i64,
        r: BellReport,
        vigil: Option<&Vigil>,
    ) -> (SiegeStatus, u32) {
        if self.status != SiegeStatus::Active || b1 < b0 {
            return (self.status, b1);
        }
        if !r.holds(self.attacker_faction) {
            self.status = SiegeStatus::Failed;
            return (self.status, b0);
        }
        if r.defender_present {
            return (self.status, b1);
        }
        let need = (self.required.saturating_sub(self.progress)) as u32;
        let count = |e: u32| -> u32 {
            match vigil {
                Some(v) => bells_outside_vigil(v, genesis_ts, b0, e),
                None => e - b0,
            }
        };
        let got = count(b1 + 1);
        if got < need {
            self.progress = self.progress.saturating_add(got.min(255) as u8);
            return (self.status, b1);
        }
        // The smallest e with `need` counted bells in [b0, e].
        let (mut lo, mut hi) = (b0, b1);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if count(mid + 1) >= need {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        self.progress = self.required;
        self.status = SiegeStatus::Completed;
        (self.status, lo)
    }
}

/// Whether a siege needing `required` bells, counted from bell `from`, can
/// complete before `end_bell` (MC §3.4 step 9, `TooLate`): at least
/// `required` bells of `[from, end_bell)` start outside `vigil` (`None`: a
/// Free City, every bell counts).
///
/// **Bounded (R-08):** true at once when `end_bell − from ≥
/// VIGIL_WINDOW_BOUND` and `required ≤ VIGIL_WINDOW_MIN_OUTSIDE`; otherwise
/// a forward scan that stops when `required` bells are counted or the range
/// ends: at most 287 `covers()` calls whatever the horizon or schedule.
pub fn can_complete_before(
    required: u8,
    vigil: Option<&Vigil>,
    from: u32,
    end_bell: u32,
    genesis: i64,
) -> bool {
    let mut calls = 0;
    can_complete_before_counted(required, vigil, from, end_bell, genesis, &mut calls)
}

/// [`can_complete_before`] that adds its `covers()` calls to `calls` (the
/// test hook of `cq_covers_bound`).
pub fn can_complete_before_counted(
    required: u8,
    vigil: Option<&Vigil>,
    from: u32,
    end_bell: u32,
    genesis: i64,
    calls: &mut u32,
) -> bool {
    let need = required as u32;
    let range = end_bell.saturating_sub(from);
    if need == 0 {
        return true;
    }
    if range < need {
        return false;
    }
    let Some(v) = vigil else {
        return true;
    };
    if range >= VIGIL_WINDOW_BOUND && need <= VIGIL_WINDOW_MIN_OUTSIDE {
        return true;
    }
    if range >= VIGIL_WINDOW_BOUND {
        // `required` above the pinned bound (never in MC: ≤ 84): the
        // closed-form count, O(schedule segments).
        return bells_outside_vigil(v, genesis, from, end_bell) >= need;
    }
    let mut got = 0u32;
    let mut b = from;
    while b < end_bell {
        *calls += 1;
        if !v.covers(genesis + b as i64 * BELL_SECS) {
            got += 1;
            if got >= need {
                return true;
            }
        }
        b += 1;
    }
    false
}

/// The earliest bell at which a siege needing `required` bells, counted
/// from bell `from`, can complete: the smallest `e` with `required` bells
/// of `[from, e]` outside `vigil` (MC §3.4: the ETA the herald, the web and
/// the bots show; **off chain only**). A forward scan bounded by
/// `required` plus the vigil bells of 3 days. `from − 1` when `required`
/// is 0.
pub fn earliest_completion_bell(
    required: u8,
    vigil: Option<&Vigil>,
    from: u32,
    genesis: i64,
) -> u32 {
    let need = required as u32;
    if need == 0 {
        return from.saturating_sub(1);
    }
    let limit = from.saturating_add(need + 3 * BELLS_PER_DAY);
    let mut got = 0u32;
    let mut b = from;
    while b < limit {
        if !covered(vigil, genesis, b) {
            got += 1;
            if got == need {
                return b;
            }
        }
        b += 1;
    }
    // Unreachable for a CL-09 schedule (≤ 48 covered bells in any 144).
    limit
}

/// Whether a failed siege was broken by the defender's side (MC §3.4
/// failure, K-06 / program F1): the failing bell had a defender present.
/// "The owner's side held the hex" (`defender_present && holders == 0`)
/// is a case of it. A garrison alone does not count: it also stands after
/// a deserted siege, which must give no immunity and burn the stake.
pub const fn broken_by_defender(r: BellReport) -> bool {
    r.defender_present
}

/// Whether a record's immunity bars `attacker` at `now_bell` (MC §3.4
/// step 5, K-06): `barred_faction` is the attacker or [`BARRED_ALL`] and
/// `now_bell < immune_until_bell`.
pub const fn immunity_bars(
    barred_faction: u8,
    immune_until_bell: u32,
    attacker: u8,
    now_bell: u32,
) -> bool {
    (barred_faction == attacker || barred_faction == BARRED_ALL) && now_bell < immune_until_bell
}

/// How an occupation ended (MC §3.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum OccupationEndKind {
    /// The occupier's faction no longer holds the hex (event `LIBERATED`).
    Liberated,
    /// Tenure reached (event `OCCUPATION_EXPIRED`).
    Expired,
}

/// The end of an occupation and whether it grants Respite (against the
/// occupier's faction only).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct OccupationEnd {
    pub kind: OccupationEndKind,
    pub respite: bool,
}

/// Whether an occupation that started at bell `start` ends at bell `b`
/// (MC §3.5, R-05):
///
/// * `b ≥ start + tenure` → **Expired**, with Respite (tenure takes
///   precedence when both hold at one bell);
/// * else the occupier's faction does not hold the hex
///   (`!holds_occupier`) → **Liberated**, with Respite only when the
///   owner's faction holds the hex (`owner_holds`); an occupier that walks
///   away, or a third faction taking the hex, gives none (`no_respite`);
/// * else `None` (it continues).
pub fn occupation_ends(
    holds_occupier: bool,
    owner_holds: bool,
    b: u32,
    start: u32,
    tenure: u32,
) -> Option<OccupationEnd> {
    if b >= start.saturating_add(tenure) {
        return Some(OccupationEnd {
            kind: OccupationEndKind::Expired,
            respite: true,
        });
    }
    if !holds_occupier {
        return Some(OccupationEnd {
            kind: OccupationEndKind::Liberated,
            respite: owner_holds,
        });
    }
    None
}

/// Whether a capture completed at bell `b` is credited (MC §3.6, K-26):
/// the victim held the site at least `min_bells`, counted from the hour it
/// began to hold it (`b + 1 − 6 × held_since_hour ≥ min_bells`). A genesis
/// Free City is always credited.
pub fn capture_credited(
    b: u32,
    held_since_hour: u16,
    min_bells: u32,
    genesis_free_city: bool,
) -> bool {
    if genesis_free_city {
        return true;
    }
    let since = 6u64 * held_since_hour as u64;
    let next = b as u64 + 1;
    next.saturating_sub(since) >= min_bells as u64
}

/// `held_since_hour` of a site taken over at bell `b + 1` (MC §3.6:
/// `⌈(b + 1) / 6⌉`).
pub const fn held_since_hour_from(next_bell: u32) -> u16 {
    let h = next_bell.div_ceil(6);
    if h > u16::MAX as u32 {
        u16::MAX
    } else {
        h as u16
    }
}
