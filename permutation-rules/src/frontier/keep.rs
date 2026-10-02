//! Keeps: the faction map of the conquest rules (MC contract §3.2, K-01,
//! K-19, K-21; owner decision OD-1).
//!
//! Every province of ring ≥ 2 has one **keep**: a fort on a fixed non-site
//! tile ([`keep_tile_symmetric`], v1.3: the same tile in all six wedges of
//! a ring; PO-5, CQH1(5)), held by a faction and owned by no wallet. The
//! map colour of a province is its keep's holder
//! (`control::province_control`).
//!
//! * **Opening** ([`open`]): held by the province's wedge faction with
//!   `home_guard` troops; flagged `heartland_safe` inside its holder's
//!   heartland, where progress never counts in MC.
//! * **The contest** ([`advance`], inside every resolved or quiet bell b),
//!   from the clash's `GarrisonResult` of the keep (or the quiet model):
//!   1. heartland-safe, or `b < consolidated_until_bell`: nothing counts
//!      (a contender is cleared without an event);
//!   2. a defender on the hex, or no hostile faction holding it: a running
//!      contest is **broken**;
//!   3. two or more hostile factions hold it: the contest **pauses** (M3
//!      only: under Rivalry the clash keeps one hostile-free set per hex,
//!      so this never happens in MC; reported once, on entering the pause);
//!   4. one hostile faction f holds it: progress + 1 if f is the
//!      contender, else f becomes the contender with progress 1 (the
//!      keep's public horn, `KEEP_CONTEST`);
//!   5. progress ≥ `required` (`keep_bells`, 72): the keep is **taken**.
//!      The **donor** is f's lead host on the tile ([`lead_host`]: most
//!      troops, then the lowest host id); `⌊troops × garrison_bps /
//!      10,000⌋` of it (in whole troops) becomes the keep's garrison and the
//!      donor goes home with the rest; a rest below `MIN_HOST_TROOPS` joins
//!      the keep too and the donor's entry is removed. Then
//!      `consolidated_until_bell = b + 1 + consolidate_bells`, `gen + 1`.
//! * **Cap (R-01):** the keep's troops are ≤ `MAX_HOST_TROOPS` in every
//!   reachable state (a donor is ≤ 30,000 troops, so the garrison is ≤
//!   30,000 at any `garrison_bps ≤ 10,000`); [`try_open`], [`garrison`] and
//!   [`advance`] check it and refuse with [`KeepError::TroopsAboveCap`]
//!   instead of building a garrison `clash::validate` would refuse.
//! * **A keep pays nothing** and its garrison never regrows.
//!
//! **Units:** the keep's troops are **whole troops** (the Province's keep
//! record, MC §5.2.1); hosts and clash garrisons are `MilliTroops`. The
//! clash garrison of a keep has `troops × 1,000`; [`troops_after_clash`]
//! floors a clash result back to whole troops (as the camp does).

/// Version of this kernel, bound into `ruleset_hash_input_v2`
/// (`super::KERNEL_VERSIONS_V2`): bump it whenever an honest outcome
/// changes. v1: the keep (CQ1-A). v2 (Wave-1 close, PO-5, CQH1(5)): the
/// keep tile is [`keep_tile_symmetric`] (the same tile in every wedge of a
/// ring), no longer [`keep_tile`]'s scan of the province's own indices.
pub const KEEP_VERSION: u16 = 2;

use super::clash::Garrison;
use super::geometry::{is_heartland_in, tile_index, tile_offset, ProvinceCoord, PROVINCE_TILES};
use super::host::{MAX_HOST_TROOPS, MIN_HOST_TROOPS};
use super::stance::{Posture, Stance};
use crate::fixed::{MilliTroops, MILLI};
use borsh::{BorshDeserialize, BorshSerialize};

/// "No faction" in `contender` and `last_taken_from`.
pub const NO_FACTION: u8 = 0xFF;
/// `tile` of a province without a keep (rings 0–1).
pub const NO_KEEP_TILE: u8 = 0xFF;
/// The keep's clash garrison id base: `KEEP_ID_BASE − gen` (MC §3.2; camps
/// use `u64::MAX − gen`, so the two never meet below 65,536 generations).
pub const KEEP_ID_BASE: u64 = u64::MAX - 0x1_0000;
/// Largest keep garrison, whole troops (`MAX_HOST_TROOPS`, R-01).
pub const MAX_KEEP_TROOPS: u32 = MAX_HOST_TROOPS / MILLI as u32;
/// Basis points of 1.
const BPS: u64 = 10_000;

/// The keep parameters of a season (SeasonParams v2, MC §3.12).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct KeepParams {
    /// `keep_bells`: held bells to take a keep (1..=255).
    pub bells: u8,
    /// `keep_consolidate_bells`: bells after a capture in which nothing
    /// counts (≤ 4,320).
    pub consolidate_bells: u32,
    /// `keep_home_guard`: whole troops at opening (≤ `MAX_KEEP_TROOPS`).
    pub home_guard: u32,
    /// `keep_garrison_bps`: the donor's share left as garrison (≤ 10,000).
    pub garrison_bps: u16,
}

impl KeepParams {
    /// Frontier-7 and Frontier-28 (MC §3.12): 72 bells, 288 bells of
    /// consolidation, a 100-troop home guard, 50% of the donor.
    pub const DEFAULT: KeepParams = KeepParams {
        bells: 72,
        consolidate_bells: 288,
        home_guard: 100,
        garrison_bps: 5_000,
    };
    /// `MC_TEST` (§3.12, itests and smokes only): 24 bells, 48 bells of
    /// consolidation.
    pub const MC_TEST: KeepParams = KeepParams {
        bells: 24,
        consolidate_bells: 48,
        home_guard: 100,
        garrison_bps: 5_000,
    };
}

/// A province's keep (the 32-byte record of MC §5.2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Keep {
    pub tile: u8,
    /// Holding faction (0–5).
    pub holder: u8,
    /// The hostile faction counting progress ([`NO_FACTION`] none).
    pub contender: u8,
    pub progress: u8,
    /// `keep_bells` at opening.
    pub required: u8,
    /// In its holder's heartland: never contested in MC.
    pub heartland_safe: bool,
    /// M3 only (a multi-faction hold); never set in MC.
    pub paused: bool,
    /// Times taken.
    pub changes: u16,
    /// Garrison, whole troops (≤ `MAX_KEEP_TROOPS`).
    pub troops: u32,
    /// First bell of the current holder.
    pub since_bell: u32,
    /// Nothing counts before this bell.
    pub consolidated_until_bell: u32,
    /// First counted bell of the running contest.
    pub contest_from_bell: u32,
    /// Garrison generation (+1 per capture).
    pub gen: u32,
    /// The holder before the last capture ([`NO_FACTION`] never taken).
    pub last_taken_from: u8,
}

/// What the clash (or the quiet model) reports about the keep's hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeepReport {
    /// Bit f: faction f, hostile to the holder, holds the hex with a
    /// non-civilian host of its own (`GarrisonResult::holders`). The
    /// holder's own bit is ignored.
    pub holders: u8,
    /// A non-civilian host of the holder (or a non-hostile faction) stands
    /// on the hex.
    pub defender_present: bool,
}

impl KeepReport {
    /// The quiet model (MC §5.7): from the per-tile faction mask of
    /// non-civilian residents, `holders = mask & !bit(holder)` and
    /// `defender_present = mask & bit(holder) ≠ 0`.
    pub const fn from_mask(mask: u8, holder: u8) -> KeepReport {
        let own = if holder < 8 { 1u8 << holder } else { 0 };
        KeepReport {
            holders: mask & !own,
            defender_present: mask & own != 0,
        }
    }
}

/// What one bell did to a keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepEvent {
    None,
    /// A new contender (event `KEEP_CONTEST`, progress 1).
    Contest(u8),
    /// A running contest broken (event `KEEP_BROKEN`).
    Broken,
    /// M3 only: a multi-faction hold paused the contest (code 10, reserved).
    Paused,
    /// Taken at this bell (event `KEEP_TAKEN`). `donor` is the donor's
    /// entry index (`0xFF` if no capturer was given); `garrison` whole
    /// troops; `donor_removed` when its rest joined the keep.
    Taken {
        from: u8,
        to: u8,
        garrison: u32,
        donor: u8,
        donor_removed: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepError {
    /// A keep or capturer above `MAX_HOST_TROOPS` (R-01).
    TroopsAboveCap,
}

/// Whether terrain byte `t` (`map::Terrain as u8`, the Province's
/// `terrain[61]`) is passable: Grassland 0 … Hills 3; Mountain 4, Water 5
/// and any invalid byte are not.
const fn passable(t: u8) -> bool {
    t <= 3
}

/// The scan in the province's **own** tile indices: the lowest-index
/// passable tile that is not one of the first `site_count` sites. `None`
/// when no tile qualifies (never for a generated province: every gate and
/// site path is passable and at most 12 of 61 tiles are sites).
///
/// **Not the MC keep tile in wedges 1–5** (v1.3, PO-5, CQH1(5)): it is
/// the keep tile of wedge 0, and [`keep_tile_symmetric`] applies it to the
/// canonical (wedge-0) copy of a province. Contract v1.2 pinned this scan
/// as the rule; it put the keep in the same *world* direction in every
/// province, so its place relative to the wedge differed between wedges
/// (CQ1-A finding 1). Kept because the symmetric rule is defined through
/// it and the v1.2 vectors carry it.
///
/// Reachability (DESIGN §3.2's carve) is checked by
/// `cq_keep_tile_is_the_lowest_passable_non_site_and_reachable`.
pub fn keep_tile(terrain: &[u8; 61], sites: &[u8], site_count: u8) -> Option<u8> {
    let n = (site_count as usize).min(sites.len());
    let sites = &sites[..n];
    (0..PROVINCE_TILES as u8).find(|&i| passable(terrain[i as usize]) && !sites.contains(&i))
}

/// **The keep tile of the conquest rules** (MC §3.1/§3.2, v1.3; PO-5,
/// CQH1(5); KEEP_VERSION 2): [`keep_tile`]'s scan over the **canonical**
/// (wedge-0) copy's tile indices, turned into wedge `wedge`, so all six
/// wedges of a ring get their keep on the same tile, as they get the same
/// terrain and sites (DESIGN §3.2). Equal to [`keep_tile`] in wedge 0.
/// `wedge` is the province's wedge (`ProvinceCoord::wedge`, 0..6; taken
/// mod 6). `None` when no tile qualifies (never for a generated province).
///
/// OpenProvince (CQ2-A), the simulator, the herald and the verifier place
/// the keep here. `cq_keep_tile_symmetric_is_the_rule_in_every_wedge`
/// checks it passable, off every site, reachable from the centre and from
/// every site, and the canonical tile turned into every wedge.
pub fn keep_tile_symmetric(
    terrain: &[u8; 61],
    sites: &[u8],
    site_count: u8,
    wedge: u8,
) -> Option<u8> {
    let n = (site_count as usize).min(sites.len());
    let sites = &sites[..n];
    let k = wedge % 6;
    (0..PROVINCE_TILES as u8)
        .filter_map(|c| tile_offset(c).and_then(|o| tile_index(o.rotate_by(k))))
        .find(|&i| passable(terrain[i as usize]) && !sites.contains(&i))
}

/// The keep a province gets at opening (OpenProvince, MC §3.2), or `None`
/// for rings 0–1, a missing tile ([`NO_KEEP_TILE`]) or a home guard above
/// the cap (CreateSeason refuses such a guard; [`try_open`] tells the two
/// apart). Held by `wedge` with `home_guard` troops, `heartland_safe` in
/// rings `2..=heartland_max_ring` of its own wedge.
pub fn open(
    p: ProvinceCoord,
    wedge: u8,
    heartland_max_ring: u8,
    tile: u8,
    prm: &KeepParams,
    bell: u32,
) -> Option<Keep> {
    try_open(p, wedge, heartland_max_ring, tile, prm, bell).ok()?
}

/// [`open`] with the cap refusal: `Err(TroopsAboveCap)` when `home_guard >
/// MAX_KEEP_TROOPS`, `Ok(None)` for rings 0–1 or no tile.
pub fn try_open(
    p: ProvinceCoord,
    wedge: u8,
    heartland_max_ring: u8,
    tile: u8,
    prm: &KeepParams,
    bell: u32,
) -> Result<Option<Keep>, KeepError> {
    if prm.home_guard > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    if p.ring() < 2 || tile as usize >= PROVINCE_TILES {
        return Ok(None);
    }
    Ok(Some(Keep {
        tile,
        holder: wedge,
        contender: NO_FACTION,
        progress: 0,
        required: prm.bells,
        heartland_safe: is_heartland_in(p, wedge, heartland_max_ring),
        paused: false,
        changes: 0,
        troops: prm.home_guard,
        since_bell: bell,
        consolidated_until_bell: 0,
        contest_from_bell: 0,
        gen: 0,
        last_taken_from: NO_FACTION,
    }))
}

/// The keep's clash garrison id: `u64::MAX − 0x1_0000 − gen`.
pub const fn garrison_id(gen: u32) -> u64 {
    KEEP_ID_BASE - gen as u64
}

/// The keep as the province's 13th clash garrison (K-21): id
/// [`garrison_id`], faction = holder, walls on, posture Hold, `troops ×
/// 1,000` milli-troops.
pub fn garrison(k: &Keep) -> Result<Garrison, KeepError> {
    if k.troops > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    Ok(Garrison {
        id: garrison_id(k.gen),
        faction: k.holder,
        tile: k.tile,
        troops: k.troops * MILLI as u32,
        walls: true,
        posture: Posture::Stance(Stance::Hold),
    })
}

/// Whole troops of a keep after a clash that left it `milli` milli-troops
/// (floored, as the camp's).
pub const fn troops_after_clash(milli: MilliTroops) -> u32 {
    milli / MILLI as u32
}

/// The lead host among `cands` = (entry index, host id, troops): the most
/// troops, then the lowest host id (MC §3.1, K-19, K-24). Shared by the
/// keep's donor and DeclareSiege's lead-host check; the caller passes the
/// qualifying hosts only (non-civilian, resident, of the right faction, on
/// the tile, no pending op). Returns the winner's entry index.
pub fn lead_host(cands: &[(u8, u64, u32)]) -> Option<u8> {
    lead_pos(cands).map(|i| cands[i].0)
}

fn lead_pos(cands: &[(u8, u64, u32)]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, c) in cands.iter().enumerate() {
        match best {
            None => best = Some(i),
            Some(b) => {
                let x = &cands[b];
                if c.2 > x.2 || (c.2 == x.2 && c.1 < x.1) {
                    best = Some(i);
                }
            }
        }
    }
    best
}

/// Count bell `b` of the keep's contest (MC §3.2 steps 1–5; the module
/// doc). `capturers` = (entry index, host id, **milli-troops**) of the
/// contender's non-civilian residents on the tile after the clash; on
/// `Taken` the donor's troops are reduced in place (to 0 when its entry is
/// removed). The caller counts each bell once, in order.
pub fn advance(
    k: &mut Keep,
    b: u32,
    r: KeepReport,
    prm: &KeepParams,
    capturers: &mut [(u8, u64, u32)],
) -> Result<KeepEvent, KeepError> {
    if k.troops > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    // 1. Heartland-safe or consolidating: nothing counts.
    if k.heartland_safe || b < k.consolidated_until_bell {
        clear(k);
        return Ok(KeepEvent::None);
    }
    let hostile = r.holders & 0x3F & !own_bit(k.holder);
    // 2. A defender, or nobody hostile: a running contest is broken.
    if r.defender_present || hostile == 0 {
        if k.contender != NO_FACTION {
            clear(k);
            return Ok(KeepEvent::Broken);
        }
        k.paused = false;
        return Ok(KeepEvent::None);
    }
    // 3. M3 only: two or more hostile factions pause the contest.
    if hostile.count_ones() >= 2 {
        if k.paused {
            return Ok(KeepEvent::None);
        }
        k.paused = true;
        return Ok(KeepEvent::Paused);
    }
    k.paused = false;
    // 4. One hostile faction.
    let f = hostile.trailing_zeros() as u8;
    let mut ev = KeepEvent::None;
    if k.contender == f {
        k.progress = k.progress.saturating_add(1);
    } else {
        k.contender = f;
        k.progress = 1;
        k.contest_from_bell = b;
        ev = KeepEvent::Contest(f);
    }
    // 5. Taken.
    if k.progress >= k.required {
        return take(k, b, f, prm, capturers);
    }
    Ok(ev)
}

const fn own_bit(f: u8) -> u8 {
    if f < 8 {
        1 << f
    } else {
        0
    }
}

fn clear(k: &mut Keep) {
    k.contender = NO_FACTION;
    k.progress = 0;
    k.paused = false;
}

fn take(
    k: &mut Keep,
    b: u32,
    f: u8,
    prm: &KeepParams,
    capturers: &mut [(u8, u64, u32)],
) -> Result<KeepEvent, KeepError> {
    if capturers.iter().any(|c| c.2 > MAX_HOST_TROOPS) {
        return Err(KeepError::TroopsAboveCap);
    }
    let bps = (prm.garrison_bps as u64).min(BPS);
    let (garrison, donor, donor_removed) = match lead_pos(capturers) {
        None => (0u32, 0xFFu8, false),
        Some(i) => {
            let t = capturers[i].2 as u64;
            let whole = t * bps / BPS / MILLI as u64;
            let mut rest = t - whole * MILLI as u64;
            let mut g = whole;
            let removed = rest < MIN_HOST_TROOPS as u64;
            if removed {
                g += rest / MILLI as u64;
                rest = 0;
            }
            capturers[i].2 = rest as u32;
            (g as u32, capturers[i].0, removed)
        }
    };
    if garrison > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    let from = k.holder;
    k.holder = f;
    k.troops = garrison;
    k.consolidated_until_bell = b.saturating_add(1).saturating_add(prm.consolidate_bells);
    k.gen = k.gen.wrapping_add(1);
    k.changes = k.changes.saturating_add(1);
    k.since_bell = b.saturating_add(1);
    k.last_taken_from = from;
    clear(k);
    Ok(KeepEvent::Taken {
        from,
        to: f,
        garrison,
        donor,
        donor_removed,
    })
}

/// The events of a quiet run, from [`advance_quiet`].
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct QuietRun {
    /// `(bell, event)` for every bell whose event is not `None`, in order.
    pub events: alloc::vec::Vec<(u32, KeepEvent)>,
    /// The last bell counted: `b1`, or the bell the keep was taken at (a
    /// take hands the donor a Leave, so the roster changes and the run
    /// ends there).
    pub through: u32,
}

/// The keep's contest over the quiet bells `b0 ..= b1` in closed form
/// (MC §3.2 / §5.7), with the residents' per-tile faction mask `mask`
/// constant over the run (`KeepReport::from_mask` against the current
/// holder). Equal to calling [`advance`] for each bell up to `through`
/// (`cq_keep_quiet_equals_bells`), in O(1) of the run's length.
pub fn advance_quiet(
    k: &mut Keep,
    b0: u32,
    b1: u32,
    mask: u8,
    prm: &KeepParams,
    capturers: &mut [(u8, u64, u32)],
) -> Result<QuietRun, KeepError> {
    let mut run = QuietRun {
        events: alloc::vec::Vec::new(),
        through: b1,
    };
    if b1 < b0 {
        return Ok(run);
    }
    if k.troops > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    let mut cur = b0;
    // At most: consolidation, then one contest phase (a take ends the run).
    for _ in 0..4 {
        if cur > b1 {
            break;
        }
        if k.heartland_safe {
            clear(k);
            break;
        }
        if cur < k.consolidated_until_bell {
            clear(k);
            if k.consolidated_until_bell > b1 {
                break;
            }
            cur = k.consolidated_until_bell;
            continue;
        }
        let r = KeepReport::from_mask(mask, k.holder);
        let hostile = r.holders & 0x3F;
        if r.defender_present || hostile == 0 {
            // One bell decides; the rest change nothing.
            let ev = advance(k, cur, r, prm, capturers)?;
            if ev != KeepEvent::None {
                run.events.push((cur, ev));
            }
            break;
        }
        if hostile.count_ones() >= 2 {
            let ev = advance(k, cur, r, prm, capturers)?;
            if ev != KeepEvent::None {
                run.events.push((cur, ev));
            }
            break;
        }
        // One hostile faction: the first bell may start a contest; then
        // progress rises by one a bell until `required`.
        let ev = advance(k, cur, r, prm, capturers)?;
        if ev != KeepEvent::None {
            run.events.push((cur, ev));
        }
        if matches!(ev, KeepEvent::Taken { .. }) {
            run.through = cur;
            return Ok(run);
        }
        let need = k.required.saturating_sub(k.progress) as u32;
        let left = b1 - cur;
        if need > left {
            k.progress = k.progress.saturating_add(left as u8);
            break;
        }
        // Bell `cur + need` takes it.
        let t = cur + need;
        k.progress = k.required.saturating_sub(1);
        let ev = advance(k, t, r, prm, capturers)?;
        run.events.push((t, ev));
        run.through = t;
        return Ok(run);
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lead_host_prefers_troops_then_low_id() {
        assert_eq!(lead_host(&[]), None);
        assert_eq!(lead_host(&[(3, 9, 5), (1, 7, 5), (2, 8, 4)]), Some(1));
        assert_eq!(lead_host(&[(3, 9, 6), (1, 7, 5)]), Some(3));
    }
}
