//! **Kernel bridge (temporary): the CQ1-A kernels `frontier-abi` v2 calls,
//! as pinned in MC contract §7, until CQ1-A merges.**
//!
//! CQ1-A (`permutation-rules::frontier::{keep, control, siege v3, camp v2,
//! geometry v2}`) and CQ1-C are built in parallel in wave 1; the integrator
//! merges CQ1-A first. So that this unit compiles, runs its tests and
//! publishes vectors on its own branch, every call `conquest_model` and
//! `clash_model`'s v2 functions make into the new kernels goes through
//! this one module, written to the §7 signatures and the §3 rules:
//!
//! | module here | becomes after the CQ1-A merge |
//! |---|---|
//! | [`keep`] | `pub use permutation_rules::frontier::keep;` |
//! | [`control`] | `pub use permutation_rules::frontier::control;` |
//! | [`siege3`] | the siege v3 functions of `permutation_rules::frontier::siege` |
//! | [`camp2::place_v2`] | `permutation_rules::frontier::camp::place_v2` |
//! | [`is_heartland_in`] | `permutation_rules::frontier::geometry::is_heartland_in` |
//! | [`ruleset_hash_v2`] | `permutation_rules::frontier::ruleset_hash_v2` |
//!
//! The switch is dependency request R1 of `CQ1-C-NOTES.md`. Nothing
//! outside this file names a stand-in, so the switch is local: where a
//! CQ1-A signature differs from §7 the adapter goes here. After it, the
//! stand-in bodies are deleted (no second copy of a rule survives the
//! merge, M1 §3.3), `RULESET_HASH_V2` and the vectors are regenerated
//! once, and `conquest_model`'s tests run against the real kernels.
//!
//! Every stand-in follows the contract text; where the text leaves a
//! choice the choice is named in the item's doc and in the notes (D-1…).

use permutation_rules::fixed::MilliTroops;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::hash::sha256;

/// `RULES_VERSION_FRONTIER` of the MC kernels (§3.13: 10 → 11).
pub const RULES_VERSION_FRONTIER_V2: u16 = 11;
/// `clash::MAX_GARRISONS_WITH_KEEP` (K-21, v1.1): 12 sites + the keep,
/// used by `validate` and the keep path only; `MAX_GARRISONS` stays 12.
pub const MAX_GARRISONS_WITH_KEEP: usize = 13;
/// Any 288 consecutive bells hold ≥ 96 bells outside a vigil snapshot
/// with at most one pending change (R-08; `cq_vigil_window_bound` is
/// CQ1-A's proof test).
pub const VIGIL_WINDOW_BOUND: u32 = 288;
/// Bells outside the vigil any [`VIGIL_WINDOW_BOUND`] bells guarantee.
pub const VIGIL_WINDOW_MIN_OPEN: u32 = 96;

/// `geometry::is_heartland_in(p, f, max_ring)` (GEOMETRY_VERSION 2):
/// rings `2..=max_ring` of `f`'s own wedge; `is_heartland(p, f)` equals
/// `is_heartland_in(p, f, 3)`.
pub fn is_heartland_in(p: ProvinceCoord, faction: u8, heartland_max_ring: u8) -> bool {
    let r = p.ring();
    r >= 2 && r <= heartland_max_ring as u32 && p.wedge() == Some(faction)
}

/// Stand-in `RULESET_HASH_V2` input: `sha256("PSF-RULESET-v2-STANDIN" ‖
/// RULESET_HASH ‖ the §3.13 version table ‖ the §3.14 constants)`. CQ1-A's
/// `ruleset_hash_input_v2()` replaces it (R1).
pub fn ruleset_hash_v2() -> [u8; 32] {
    let mut v = [0u8; 9 * 3 + 6 * 8];
    let versions: [(u8, u16); 9] = [
        (0, RULES_VERSION_FRONTIER_V2),
        (1, 3), // siege
        (2, 3), // holding
        (3, 4), // clash
        (4, 2), // camp
        (5, 2), // terrain
        (6, 2), // geometry
        (7, keep::KEEP_VERSION),
        (8, control::CONTROL_VERSION),
    ];
    for (i, (id, ver)) in versions.iter().enumerate() {
        v[3 * i] = *id;
        v[3 * i + 1..3 * i + 3].copy_from_slice(&ver.to_le_bytes());
    }
    let consts: [u64; 6] = [
        MAX_GARRISONS_WITH_KEEP as u64,
        keep::KEEP_GARRISON_ID_BASE,
        control::SIDES as u64,
        control::SNAPSHOT_DIVISOR,
        VIGIL_WINDOW_BOUND as u64,
        control::LASTING_MIN_BELLS as u64,
    ];
    for (i, c) in consts.iter().enumerate() {
        v[27 + 8 * i..35 + 8 * i].copy_from_slice(&c.to_le_bytes());
    }
    sha256(&[b"PSF-RULESET-v2-STANDIN", &crate::presets::RULESET_HASH, &v])
}

/// The keep kernel (KEEP_VERSION 1, §3.2, §7).
pub mod keep {
    use super::*;
    use permutation_rules::frontier::clash::Garrison;
    use permutation_rules::frontier::host::{MAX_HOST_TROOPS, MIN_HOST_TROOPS};
    use permutation_rules::frontier::stance::{Posture, Stance};
    use permutation_rules::frontier::terrain::ProvinceTerrain;

    pub const KEEP_VERSION: u16 = 1;
    /// Keep garrison ids are `KEEP_GARRISON_ID_BASE − gen` (§3.14).
    pub const KEEP_GARRISON_ID_BASE: u64 = u64::MAX - 0x1_0000;
    /// No faction (contender, last holder).
    pub const NONE: u8 = 0xFF;
    const MILLI: u32 = permutation_rules::fixed::MILLI as u32;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct KeepParams {
        pub bells: u8,
        pub consolidate_bells: u32,
        pub home_guard: u32,
        pub garrison_bps: u16,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Keep {
        pub tile: u8,
        pub holder: u8,
        pub contender: u8,
        pub progress: u8,
        pub required: u8,
        pub heartland_safe: bool,
        pub paused: bool,
        pub changes: u16,
        /// Whole troops.
        pub troops: u32,
        pub since_bell: u32,
        pub consolidated_until_bell: u32,
        pub contest_from_bell: u32,
        pub gen: u32,
        pub last_taken_from: u8,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct KeepReport {
        /// Bit f: faction f, hostile to the holder, holds the keep's hex.
        pub holders: u8,
        /// A non-civilian host of the holder stands on the hex.
        pub defender_present: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum KeepEvent {
        None,
        Contest(u8),
        Broken,
        /// M3 only (two hostile factions hold the hex; unreachable under
        /// Rivalry, R-09).
        Paused,
        Taken {
            from: u8,
            to: u8,
            /// The new garrison, whole troops.
            garrison: u32,
            /// Index into `capturers` of the donor (`NONE` without one).
            donor: u8,
            donor_removed: bool,
        },
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum KeepError {
        TroopsAboveCap,
    }

    /// The lowest-index passable tile that is not a site tile.
    pub fn keep_tile(terrain: &ProvinceTerrain, sites: &[u8], site_count: u8) -> Option<u8> {
        let used = &sites[..(site_count as usize).min(sites.len())];
        (0..permutation_rules::frontier::geometry::PROVINCE_TILES as u8)
            .find(|t| terrain.passable(*t) && !used.contains(t))
    }

    /// The keep of a new ring ≥ 2 province, held by its wedge with the home
    /// guard; `None` for rings 0–1 (§3.2 Opening).
    pub fn open(
        p: ProvinceCoord,
        wedge: u8,
        heartland_max_ring: u8,
        tile: u8,
        prm: &KeepParams,
        bell: u32,
    ) -> Option<Keep> {
        if p.ring() < 2 || prm.home_guard > MAX_HOST_TROOPS / MILLI {
            return None;
        }
        Some(Keep {
            tile,
            holder: wedge,
            contender: NONE,
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
            last_taken_from: NONE,
        })
    }

    /// The keep's clash garrison: id `KEEP_GARRISON_ID_BASE − gen`, the
    /// holder's, walls on, Hold.
    pub fn garrison(k: &Keep) -> Result<Garrison, KeepError> {
        let troops = k
            .troops
            .checked_mul(MILLI)
            .filter(|t| *t <= MAX_HOST_TROOPS)
            .ok_or(KeepError::TroopsAboveCap)?;
        Ok(Garrison {
            id: KEEP_GARRISON_ID_BASE - k.gen as u64,
            faction: k.holder,
            tile: k.tile,
            troops: troops as MilliTroops,
            walls: true,
            posture: Posture::Stance(Stance::Hold),
        })
    }

    /// The lead host: most troops, then the lowest host id; the entry index.
    pub fn lead_host(cands: &[(u8, u64, u32)]) -> Option<u8> {
        cands
            .iter()
            .copied()
            .reduce(|a, b| {
                if b.2 > a.2 || (b.2 == a.2 && b.1 < a.1) {
                    b
                } else {
                    a
                }
            })
            .map(|c| c.0)
    }

    /// One counted bell `b` of the keep (§3.2 steps 1–5). `capturers`:
    /// (entry index, host id, MilliTroops) of the contender's non-civilian
    /// residents on the tile after the clash; on Taken the donor's troops
    /// are reduced in place (to 0 when it joins the keep entirely).
    pub fn advance(
        k: &mut Keep,
        b: u32,
        r: KeepReport,
        prm: &KeepParams,
        capturers: &mut [(u8, u64, u32)],
    ) -> Result<KeepEvent, KeepError> {
        // 1. heartland or consolidation: nothing counts.
        if k.heartland_safe || b < k.consolidated_until_bell {
            k.contender = NONE;
            k.progress = 0;
            return Ok(KeepEvent::None);
        }
        // 2. a defender, or nobody hostile: a running contest breaks.
        if r.defender_present || r.holders == 0 {
            if k.contender != NONE {
                k.contender = NONE;
                k.progress = 0;
                return Ok(KeepEvent::Broken);
            }
            return Ok(KeepEvent::None);
        }
        // 3. M3 only: two hostile factions pause the contest.
        if r.holders.count_ones() > 1 {
            k.paused = true;
            return Ok(KeepEvent::Paused);
        }
        k.paused = false;
        // 4. exactly one hostile faction f.
        let f = r.holders.trailing_zeros() as u8;
        let mut ev = KeepEvent::None;
        if k.contender == f {
            k.progress = k.progress.saturating_add(1);
        } else {
            k.contender = f;
            k.progress = 1;
            k.contest_from_bell = b;
            ev = KeepEvent::Contest(f);
        }
        // 5. taken.
        if k.progress < k.required.max(1) {
            return Ok(ev);
        }
        let donor = lead_host(capturers);
        let (mut troops, mut removed) = (0u32, false);
        if let Some(d) = donor {
            let c = capturers
                .iter_mut()
                .find(|c| c.0 == d)
                .ok_or(KeepError::TroopsAboveCap)?;
            let give = (c.2 as u64 * prm.garrison_bps as u64 / 10_000) as u32;
            let rest = c.2 - give;
            if rest < MIN_HOST_TROOPS {
                troops = c.2 / MILLI;
                c.2 = 0;
                removed = true;
            } else {
                troops = give / MILLI;
                c.2 = rest;
            }
        }
        if troops > MAX_HOST_TROOPS / MILLI {
            return Err(KeepError::TroopsAboveCap);
        }
        let from = k.holder;
        k.holder = f;
        k.troops = troops;
        k.consolidated_until_bell = b.saturating_add(1).saturating_add(prm.consolidate_bells);
        k.gen = k.gen.wrapping_add(1);
        k.changes = k.changes.saturating_add(1);
        k.since_bell = b.saturating_add(1);
        k.last_taken_from = from;
        k.contender = NONE;
        k.progress = 0;
        Ok(KeepEvent::Taken {
            from,
            to: f,
            garrison: troops,
            donor: donor.unwrap_or(NONE),
            donor_removed: removed,
        })
    }
}

/// The control kernel (CONTROL_VERSION 1, §3.3, §3.10, §7), the parts
/// the ABI uses.
pub mod control {
    use permutation_rules::fixed::MilliTroops;
    use permutation_rules::frontier::laurel::Tier;

    pub const CONTROL_VERSION: u16 = 1;
    /// Sides: factions 0–5 and neutral 6.
    pub const SIDES: usize = 7;
    /// The neutral side.
    pub const NEUTRAL: u8 = 6;
    /// Snapshot unit: centi-strength-weight (`strength_weight / 10,000`).
    pub const SNAPSHOT_DIVISOR: u64 = 10_000;
    /// A lasting change of criterion 10 holds ≥ 6 bells (§3.14).
    pub const LASTING_MIN_BELLS: u32 = 6;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Controller {
        /// No weight at all.
        Unsettled,
        Side(u8),
        Contested,
    }

    /// `floor(laurel::strength_weight(tier, garrison, order0) / 10,000)`;
    /// `order0` is the 0-based holding order (`order − 1`; a Free City 0).
    pub fn site_weight_centi(tier: Tier, garrison: MilliTroops, order0: u8) -> u16 {
        let w = permutation_rules::frontier::laurel::strength_weight(tier, garrison, order0);
        (w / SNAPSHOT_DIVISOR).min(u16::MAX as u64) as u16
    }

    /// The strict rule: the side with `2·w ≥ Σw` and strictly more than
    /// every other side; otherwise contested; no weight at all: unsettled.
    pub fn controller(w: &[u32; SIDES]) -> Controller {
        let total: u64 = w.iter().map(|x| *x as u64).sum();
        if total == 0 {
            return Controller::Unsettled;
        }
        for (s, x) in w.iter().enumerate() {
            let x = *x as u64;
            let ahead = w.iter().enumerate().all(|(t, y)| t == s || x > *y as u64);
            if 2 * x >= total && ahead {
                return Controller::Side(s as u8);
            }
        }
        Controller::Contested
    }
}

/// Siege v3 (SIEGE_VERSION 3, §3.4–§3.6, §7), beside the v2 kernel.
pub mod siege3 {
    use permutation_rules::frontier::siege::{BellReport, Siege, SiegeStatus, Vigil};

    /// One counted bell of a siege declared from the hex (v3: `held` from
    /// the horn, no start window, an optional vigil for a Free City).
    pub fn advance(
        s: &mut Siege,
        b: u32,
        start: i64,
        r: BellReport,
        vigil: Option<&Vigil>,
    ) -> SiegeStatus {
        if s.status != SiegeStatus::Active {
            return s.status;
        }
        s.last_bell = b;
        if !r.holds(s.attacker_faction) {
            s.status = SiegeStatus::Failed;
            return s.status;
        }
        s.held = true;
        if r.defender_present || vigil.is_some_and(|v| v.covers(start)) {
            return s.status;
        }
        s.progress = s.progress.saturating_add(1);
        if s.progress >= s.required {
            s.status = SiegeStatus::Completed;
        }
        s.status
    }

    /// Whether `required` counted bells fit in `[from, end_bell)` (R-08,
    /// bounded): `true` at once when ≥ 288 bells remain, else a forward
    /// scan that stops at `required` counted bells (≤ 287 `covers` calls).
    pub fn can_complete_before(
        required: u8,
        vigil: Option<&Vigil>,
        from: u32,
        end_bell: u32,
        genesis: i64,
    ) -> bool {
        let left = end_bell.saturating_sub(from);
        if left >= super::VIGIL_WINDOW_BOUND && required as u32 <= super::VIGIL_WINDOW_MIN_OPEN {
            return true;
        }
        let mut got = 0u32;
        for b in from..end_bell.min(from.saturating_add(super::VIGIL_WINDOW_BOUND - 1)) {
            if !vigil.is_some_and(|v| v.covers(genesis + b as i64 * 600)) {
                got += 1;
                if got >= required as u32 {
                    return true;
                }
            }
        }
        required == 0
    }

    /// Off chain only (herald, wasm, bots): the bell at which `required`
    /// counted bells from `from` complete, if the besiegers hold the hex
    /// and no defender comes (bounded by `required` + 3 days of bells).
    pub fn earliest_completion_bell(
        required: u8,
        vigil: Option<&Vigil>,
        from: u32,
        genesis: i64,
    ) -> u32 {
        let mut got = 0u32;
        let mut b = from;
        let limit = from.saturating_add(required as u32 + 3 * 144);
        while b < limit {
            if !vigil.is_some_and(|v| v.covers(genesis + b as i64 * 600)) {
                got += 1;
                if got >= required as u32 {
                    return b;
                }
            }
            b += 1;
        }
        b
    }

    /// The failing bell was broken by the defender: a defender stood on
    /// the hex (under Rivalry the owner's side holds it exactly then).
    pub fn broken_by_defender(r: BellReport) -> bool {
        r.defender_present
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum OccupationEndKind {
        Liberated,
        Expired,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct OccupationEnd {
        pub kind: OccupationEndKind,
        /// Respite granted (expiry, or the owner's faction liberated it).
        pub respite: bool,
    }

    /// v1.1 (R-05): liberation when the occupier's faction does not hold
    /// the hex (Respite only if the owner's faction does), expiry at tenure.
    pub fn occupation_ends(
        holds_occupier: bool,
        owner_holds: bool,
        b: u32,
        start: u32,
        tenure: u32,
    ) -> Option<OccupationEnd> {
        if !holds_occupier {
            return Some(OccupationEnd {
                kind: OccupationEndKind::Liberated,
                respite: owner_holds,
            });
        }
        if b >= start.saturating_add(tenure) {
            return Some(OccupationEnd {
                kind: OccupationEndKind::Expired,
                respite: true,
            });
        }
        None
    }

    /// v1.1 (K-26): a capture at completion bell `b` is credited when the
    /// victim held the site ≥ `min_bells` (`b + 1 − 6 × held_since_hour`);
    /// a genesis Free City always.
    pub fn capture_credited(
        b: u32,
        held_since_hour: u16,
        min_bells: u32,
        genesis_free_city: bool,
    ) -> bool {
        genesis_free_city
            || (b as u64 + 1).saturating_sub(6 * held_since_hour as u64) >= min_bells as u64
    }

    /// The owner's vigil as snapshotted at the horn (§5.2.1 record bytes
    /// 6..12): the start in force, the next start and the UTC day it takes
    /// effect (0: no change pending).
    pub fn vigil_of_snapshot(start_min: u16, next_min: u16, from_day: u16) -> Vigil {
        let s = start_min as u32 * 60;
        let mut v = Vigil {
            schedule: [(i64::MIN, s); 3],
            last_request: i64::MIN,
        };
        if from_day != 0 {
            v.schedule[2] = (from_day as i64 * 86_400, next_min as u32 * 60);
        }
        v
    }
}

/// Camp v2 (CAMP_VERSION 2): never on the keep tile.
pub mod camp2 {
    use permutation_rules::frontier::camp::{self, Camp};
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::terrain::ProvinceTerrain;

    /// Stand-in: M1's `place`, refusing a draw on the keep tile (no camp
    /// that day). CQ1-A's `place_v2` may instead draw among the other
    /// tiles (notes D-2); only the bridge changes.
    pub fn place_v2(
        ring_seed: &[u8; 32],
        p: ProvinceCoord,
        terrain: &ProvinceTerrain,
        day: u32,
        has_holding: bool,
        initial: bool,
        keep_tile: Option<u8>,
    ) -> Option<Camp> {
        camp::place(ring_seed, p, terrain, day, has_holding, initial)
            .filter(|c| Some(c.tile) != keep_tile)
    }
}

#[cfg(test)]
mod tests {
    use super::keep::*;
    use super::*;
    use permutation_rules::frontier::host::MIN_HOST_TROOPS;

    fn k0() -> Keep {
        Keep {
            tile: 3,
            holder: 2,
            contender: NONE,
            progress: 0,
            required: 3,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: 100,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: NONE,
        }
    }
    const PRM: KeepParams = KeepParams {
        bells: 3,
        consolidate_bells: 10,
        home_guard: 100,
        garrison_bps: 5_000,
    };

    #[test]
    fn cq_keep_contest_breaks_and_takes() {
        let mut k = k0();
        let hold = |f: u8| KeepReport {
            holders: 1 << f,
            defender_present: false,
        };
        assert_eq!(
            advance(&mut k, 10, hold(4), &PRM, &mut []),
            Ok(KeepEvent::Contest(4))
        );
        let none = KeepReport {
            holders: 0,
            defender_present: false,
        };
        assert_eq!(
            advance(&mut k, 11, none, &PRM, &mut []),
            Ok(KeepEvent::Broken)
        );
        assert_eq!(k.contender, NONE);
        let mut caps = [(7u8, 50u64, 20_000_000u32), (9, 40, 20_000_000)];
        for b in 12..14 {
            advance(&mut k, b, hold(4), &PRM, &mut caps).unwrap();
        }
        let ev = advance(&mut k, 14, hold(4), &PRM, &mut caps).unwrap();
        // the donor is the lower id of the two largest
        assert_eq!(
            ev,
            KeepEvent::Taken {
                from: 2,
                to: 4,
                garrison: 10_000,
                donor: 9,
                donor_removed: false
            }
        );
        assert_eq!(caps[1].2, 10_000_000);
        assert_eq!((k.holder, k.gen, k.changes, k.troops), (4, 1, 1, 10_000));
        assert_eq!(k.consolidated_until_bell, 25);
        // consolidation: nothing counts
        assert_eq!(
            advance(&mut k, 20, hold(2), &PRM, &mut []),
            Ok(KeepEvent::None)
        );
        assert_eq!(k.contender, NONE);
    }

    #[test]
    fn cq_keep_small_donor_joins_entirely() {
        let mut k = k0();
        k.required = 1;
        let mut caps = [(1u8, 5u64, MIN_HOST_TROOPS + 50_000)];
        let r = KeepReport {
            holders: 1 << 1,
            defender_present: false,
        };
        let ev = advance(&mut k, 1, r, &PRM, &mut caps).unwrap();
        assert!(matches!(
            ev,
            KeepEvent::Taken {
                donor_removed: true,
                garrison: 150,
                ..
            }
        ));
        assert_eq!(caps[0].2, 0);
    }

    /// R-01: every handoff stays ≤ MAX_HOST_TROOPS (six 30,000-troop
    /// capturers; one donor pays).
    #[test]
    fn cq_keep_handoff_is_capped() {
        let mut k = k0();
        k.required = 1;
        let mut caps = [(0u8, 0u64, 30_000_000u32); 6];
        for (i, c) in caps.iter_mut().enumerate() {
            c.0 = i as u8;
            c.1 = 100 - i as u64;
        }
        let r = KeepReport {
            holders: 1 << 5,
            defender_present: false,
        };
        let ev = advance(&mut k, 1, r, &PRM, &mut caps).unwrap();
        assert!(matches!(
            ev,
            KeepEvent::Taken {
                garrison: 15_000,
                donor: 5,
                ..
            }
        ));
        assert!(garrison(&k).is_ok());
        k.troops = 30_001;
        assert_eq!(garrison(&k), Err(KeepError::TroopsAboveCap));
    }

    #[test]
    fn cq_controller_is_strict() {
        use control::{controller, Controller};
        assert_eq!(controller(&[0; 7]), Controller::Unsettled);
        assert_eq!(controller(&[5, 5, 0, 0, 0, 0, 0]), Controller::Contested);
        assert_eq!(controller(&[6, 4, 2, 0, 0, 0, 0]), Controller::Side(0));
        assert_eq!(controller(&[5, 4, 2, 0, 0, 0, 0]), Controller::Contested);
        assert_eq!(controller(&[0, 0, 0, 0, 0, 0, 9]), Controller::Side(6));
    }

    #[test]
    fn cq_siege_v3_and_bounds() {
        use permutation_rules::frontier::siege::{BellReport, Siege, SiegeStatus};
        let mut s = Siege::declare(3, 10, 0, 0);
        s.required = 2;
        let hold = BellReport {
            holders: 1 << 3,
            defender_present: false,
        };
        assert_eq!(
            siege3::advance(&mut s, 11, 0, hold, None),
            SiegeStatus::Active
        );
        assert_eq!(
            siege3::advance(&mut s, 12, 0, hold, None),
            SiegeStatus::Completed
        );
        let mut s = Siege::declare(3, 10, 0, 0);
        let gone = BellReport {
            holders: 0,
            defender_present: true,
        };
        assert_eq!(
            siege3::advance(&mut s, 11, 0, gone, None),
            SiegeStatus::Failed
        );
        assert!(siege3::broken_by_defender(gone));
        let v = siege3::vigil_of_snapshot(0, 0, 0);
        assert!(siege3::can_complete_before(60, Some(&v), 0, 400, 0));
        assert!(!siege3::can_complete_before(60, Some(&v), 0, 60, 0));
        assert!(siege3::can_complete_before(36, None, 0, 36, 0));
        assert!(!siege3::can_complete_before(37, None, 0, 36, 0));
        // vigil 00:00–08:00: bells 0..48 covered, 48.. open
        assert_eq!(siege3::earliest_completion_bell(1, Some(&v), 0, 0), 48);
        assert!(siege3::capture_credited(143, 0, 144, false));
        assert!(!siege3::capture_credited(142, 0, 144, false));
        assert!(siege3::capture_credited(0, 9, 144, true));
        use siege3::{occupation_ends, OccupationEndKind as K};
        assert_eq!(occupation_ends(true, false, 10, 0, 72), None);
        let e = occupation_ends(false, false, 10, 0, 72).unwrap();
        assert_eq!((e.kind, e.respite), (K::Liberated, false));
        let e = occupation_ends(false, true, 10, 0, 72).unwrap();
        assert_eq!((e.kind, e.respite), (K::Liberated, true));
        let e = occupation_ends(true, false, 72, 0, 72).unwrap();
        assert_eq!((e.kind, e.respite), (K::Expired, true));
    }

    #[test]
    fn cq_heartland_param() {
        let p = ProvinceCoord::new(3, 0);
        let f = p.wedge().unwrap();
        assert!(is_heartland_in(p, f, 3));
        assert!(!is_heartland_in(p, f, 2));
        assert_eq!(
            is_heartland_in(p, f, 3),
            permutation_rules::frontier::geometry::is_heartland(p, f)
        );
        assert!(!is_heartland_in(ProvinceCoord::new(1, 0), 0, 3));
    }
}
