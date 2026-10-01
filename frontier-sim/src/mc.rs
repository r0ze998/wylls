//! MC "Contested Ground" (CONQUEST-CONTRACT v1.1) inside the simulator:
//! the rule set selector (`--rules m1|mc|mc-weightmap`, `+bannerdom`,
//! `+keepdom`), the policy and bot-profile selectors, the season
//! parameters of §3.12 (Frontier-7, Frontier-28, MC_TEST) and the conquest
//! kernels the simulator calls.
//!
//! **Kernel mirror (dependency note).** §7 pins `permutation_rules::
//! frontier::{keep, control}` and the siege v3 / holding v3 additions to
//! CQ1-A, which merges before this unit. Until then `cqk` below
//! implements exactly the §3/§7 semantics with the §7 names, so the sim can
//! be measured now; after CQ1-A merges, `cqk::keep` and the control
//! helpers become re-exports of the real kernels (and the `cq_kernel_*`
//! tests compare both). Nothing outside this file names a mirror type.

use permutation_rules::fixed::MilliTroops;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::host::{MAX_HOST_TROOPS, MIN_HOST_TROOPS};
use permutation_rules::frontier::siege::Vigil;
use permutation_rules::frontier::travel::BELL_SECS;

/// Which rules the season plays (`--rules`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rules {
    /// The M1 simulator, unchanged (every M1 digest and gate).
    M1,
    /// §3 exactly: keeps, sieges from the hex, occupation, capture into a
    /// reserved slot, genesis Free Cities, outposts, Dominion as points.
    Mc,
    /// Negative control of `mapmove-gate`: the MC holding contest with the
    /// holding-weight map (no keeps): province colour = the strict
    /// strength-weight controller, occupations counting for the occupier.
    McWeightmap,
}

impl Rules {
    pub fn mc(self) -> bool {
        self != Rules::M1
    }
    pub fn keeps(self) -> bool {
        self == Rules::Mc
    }
    pub fn name(self) -> &'static str {
        match self {
            Rules::M1 => "m1",
            Rules::Mc => "mc",
            Rules::McWeightmap => "mc-weightmap",
        }
    }
}

/// Who decides a faction's attacks (`--policy`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Every session rolls its own attack (the M1 simulator's behaviour).
    Lone,
    /// The faction's hourly campaign plan (§8.6) assigns attacks and
    /// defence; members act on their assignment.
    Campaign,
}

/// How the scripted bots play (`--bot-profile`, §8.7 item 7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotProfile {
    /// `Arch::Bot` of `model.rs`: 24 sessions a day, aggression 0.5, a keep
    /// roll per session (the balance lab's bot row).
    Sim,
    /// The stack's cadence: one decision per bot per planner epoch (one
    /// game hour), and military action only when the campaign plan assigns
    /// it (no lone rolls, no camp raids).
    Cq,
    /// `Cq` plus, per bot and planner epoch, a lone session's attack rolls
    /// with probability `m1_act_p`, calibrated so the 1k / 7-day / 99%-bot
    /// season makes ≈ 0.24 Departs per bot-day (M1-EXIT-NOTES: 1,712
    /// Departs by 1,000 bots in 7 days). The `cq` planner alone makes
    /// fewer (CQ1-B-NOTES), so matching M1 adds unplanned activity.
    M1,
}

impl BotProfile {
    pub fn name(self) -> &'static str {
        match self {
            BotProfile::Sim => "sim",
            BotProfile::Cq => "cq",
            BotProfile::M1 => "m1",
        }
    }
}

/// Epoch-decision probability of `--bot-profile m1`, calibrated so the
/// measured Departs per bot-day of the 1k / 7-day / 99%-bot season is
/// ≈ 0.24 (CQ1-B-NOTES §calibration).
pub const M1_ACT_P: f64 = 0.06;

/// Season parameters (SeasonParams v2, §3.12) the simulator reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct McParams {
    pub preset: &'static str,
    pub heartland_max_ring: u32,
    pub keep_bells: u8,
    pub keep_consolidate_bells: u32,
    pub keep_home_guard: u32,
    pub keep_garrison_bps: u16,
    pub sieges_per_day: u32,
    pub siege_stake_gold: i64,
    pub immunity_bells: u32,
    pub occupation_tenure_bells: u32,
    pub respite_bells: u32,
    /// 0 = no genesis Free Cities.
    pub free_city_min_ring: u32,
    pub free_city_garrison: i64,
    pub capture_credit_min_bells: u32,
    pub shield_secs: i64,
    pub shield_late_secs: i64,
    pub shield_late_after_secs: i64,
    pub outpost_shield_secs: i64,
    pub frontier_protect_secs: i64,
    pub frontier_protect_after_secs: i64,
    pub dormant_after_secs: i64,
    pub release_after_secs: i64,
    pub dominion_per_hour: u64,
    pub dominion_per_capture: u64,
    pub outpost_range: u32,
    /// Minimum tier of the first holding to file an outpost (0 Hamlet, 1 Town).
    pub outpost_tier_min: u8,
    pub outpost_share_bps: u32,
    pub outpost_close_bells: u32,
}

impl McParams {
    /// `MC_LOCAL_7D` (Frontier-7: the exit, nightlies, demo).
    pub const FRONTIER_7: McParams = McParams {
        preset: "MC_LOCAL_7D",
        heartland_max_ring: 3,
        keep_bells: 72,
        keep_consolidate_bells: 288,
        keep_home_guard: 100,
        keep_garrison_bps: 5_000,
        sieges_per_day: 2,
        siege_stake_gold: 500,
        immunity_bells: 36,
        occupation_tenure_bells: 72,
        respite_bells: 72,
        free_city_min_ring: 4,
        free_city_garrison: 300,
        capture_credit_min_bells: 144,
        shield_secs: 86_400,
        shield_late_secs: 86_400,
        shield_late_after_secs: 172_800,
        outpost_shield_secs: 7_200,
        frontier_protect_secs: 129_600,
        frontier_protect_after_secs: 43_200,
        dormant_after_secs: 259_200,
        release_after_secs: 604_800,
        dominion_per_hour: 6,
        dominion_per_capture: 36,
        outpost_range: 3,
        outpost_tier_min: 1,
        outpost_share_bps: 5_000,
        outpost_close_bells: 24,
    };
    /// `MC_SEASON_28` (Frontier-28).
    pub const FRONTIER_28: McParams = McParams {
        preset: "MC_SEASON_28",
        occupation_tenure_bells: 288,
        respite_bells: 288,
        capture_credit_min_bells: 288,
        shield_secs: 172_800,
        shield_late_secs: 259_200,
        shield_late_after_secs: 604_800,
        frontier_protect_secs: 604_800,
        frontier_protect_after_secs: 172_800,
        dormant_after_secs: 432_000,
        release_after_secs: 864_000,
        ..McParams::FRONTIER_7
    };
    /// `MC_TEST` (R-18): itests and smokes only.
    pub const TEST: McParams = McParams {
        preset: "MC_TEST",
        heartland_max_ring: 2,
        free_city_min_ring: 3,
        shield_secs: 7_200,
        shield_late_secs: 7_200,
        outpost_tier_min: 0,
        keep_bells: 24,
        keep_consolidate_bells: 48,
        occupation_tenure_bells: 24,
        respite_bells: 24,
        immunity_bells: 12,
        capture_credit_min_bells: 36,
        frontier_protect_secs: 0,
        ..McParams::FRONTIER_7
    };

    /// The preset a season of `days` days runs by default: Frontier-7 for
    /// seasons up to 7 days, Frontier-28 otherwise.
    pub fn for_days(days: u32) -> McParams {
        if days <= 7 {
            McParams::FRONTIER_7
        } else {
            McParams::FRONTIER_28
        }
    }

    pub fn parse(s: &str) -> McParams {
        match s {
            "mc-local-7d" | "MC_LOCAL_7D" | "frontier-7" => McParams::FRONTIER_7,
            "mc-season-28" | "MC_SEASON_28" | "frontier-28" => McParams::FRONTIER_28,
            "mc-test" | "MC_TEST" => McParams::TEST,
            x => panic!("--preset {x}"),
        }
    }

    /// `--mc key=value,…`: exploration overrides of the preset (the
    /// tuning knobs of Gate CQ1's failure rule and the planner's holding
    /// slots). Not used by any gated line.
    pub fn apply(&mut self, spec: &str, holding_slots: &mut usize) {
        for kv in spec.split(',').filter(|x| !x.is_empty()) {
            let (k, v) = kv.split_once('=').expect("--mc key=value");
            let n = |v: &str| v.parse::<i64>().expect("--mc value");
            match k {
                "keep_home_guard" => self.keep_home_guard = n(v) as u32,
                "keep_consolidate_bells" => self.keep_consolidate_bells = n(v) as u32,
                "keep_bells" => self.keep_bells = n(v) as u8,
                "keep_garrison_bps" => self.keep_garrison_bps = n(v) as u16,
                "free_city_min_ring" => self.free_city_min_ring = n(v) as u32,
                "heartland_max_ring" => self.heartland_max_ring = n(v) as u32,
                "occupation_tenure_bells" => self.occupation_tenure_bells = n(v) as u32,
                "sieges_per_day" => self.sieges_per_day = n(v) as u32,
                "holding_slots" => *holding_slots = n(v) as usize,
                x => panic!("--mc {x}"),
            }
        }
        self.preset = if spec.is_empty() {
            self.preset
        } else {
            "custom"
        };
    }

    pub fn keep_params(&self) -> cqk::KeepParams {
        cqk::KeepParams {
            bells: self.keep_bells,
            consolidate_bells: self.keep_consolidate_bells,
            home_guard: self.keep_home_guard,
            garrison_bps: self.keep_garrison_bps,
        }
    }

    /// Shield end of a first holding founded at `founded_ts` (genesis 0).
    pub fn first_shield_until(&self, founded_ts: i64) -> i64 {
        let s = if founded_ts >= self.shield_late_after_secs {
            self.shield_late_secs
        } else {
            self.shield_secs
        };
        founded_ts + s
    }
}

/// The conquest kernels of §7, mirrored (see the module doc).
pub mod cqk {
    use super::*;

    pub const KEEP_VERSION: u16 = 1;
    pub const CONTROL_VERSION: u16 = 1;
    /// Faction id of "no faction" in control series and keep fields.
    pub const NO_FACTION: u8 = 255;
    /// Control sides: factions 0–5 and neutral 6.
    pub const SIDES: usize = 7;
    /// Any 288 consecutive bells hold ≥ 96 bells outside one vigil
    /// snapshot with at most one pending change (§3.4 step 9, R-08).
    pub const VIGIL_WINDOW_BOUND: u32 = 288;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct KeepParams {
        pub bells: u8,
        pub consolidate_bells: u32,
        pub home_guard: u32,
        pub garrison_bps: u16,
    }

    /// §7 `keep::Keep` (troops in milli-troops here, as every sim garrison).
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
        pub troops: MilliTroops,
        pub since_bell: u32,
        pub consolidated_until_bell: u32,
        pub contest_from_bell: u32,
        pub gen: u32,
        pub last_taken_from: u8,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct KeepReport {
        pub holders: u8,
        pub defender_present: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum KeepEvent {
        None,
        Contest(u8),
        Broken,
        /// M3 only (unreachable under Rivalry: one hostile-free set per hex).
        Paused,
        Taken {
            from: u8,
            to: u8,
            garrison: MilliTroops,
            donor: u8,
            donor_removed: bool,
        },
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum KeepError {
        TroopsAboveCap,
    }

    /// Heartland with the season's ring parameter (geometry v2
    /// `is_heartland_in`): rings 2..=`max_ring` of the faction's wedge.
    pub fn is_heartland_in(p: ProvinceCoord, faction: u8, max_ring: u32) -> bool {
        let r = p.ring();
        r >= 2 && r <= max_ring && p.wedge() == Some(faction)
    }

    /// `keep::open`: None for rings 0–1; held by the wedge faction with
    /// the home guard, heartland-safe in its holder's heartland.
    pub fn open(
        p: ProvinceCoord,
        wedge: u8,
        heartland_max_ring: u32,
        tile: u8,
        prm: &KeepParams,
        bell: u32,
    ) -> Result<Option<Keep>, KeepError> {
        if p.ring() < 2 {
            return Ok(None);
        }
        let troops = prm.home_guard as MilliTroops * 1_000;
        if troops > MAX_HOST_TROOPS {
            return Err(KeepError::TroopsAboveCap);
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
            troops,
            since_bell: bell,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: NO_FACTION,
        }))
    }

    /// `keep::lead_host`: the entry with the most troops, then the lowest
    /// host id (shared by the keep donor and DeclareSiege's lead check).
    pub fn lead_host(cands: &[(u8, u64, u32)]) -> Option<u8> {
        cands
            .iter()
            .max_by(|a, b| a.2.cmp(&b.2).then(b.1.cmp(&a.1)))
            .map(|c| c.0)
    }

    /// `keep::advance` (§3.2 steps 1–5). `capturers` = (entry index, host
    /// id, troops in milli-troops as u32 is too small for 30k troops, so
    /// the sim passes troops / 1,000) of the contender's non-civilian
    /// residents on the keep tile after the clash; on Taken the donor's
    /// troops are reduced in place (to the remainder, or 0 when removed).
    pub fn advance(
        k: &mut Keep,
        b: u32,
        r: KeepReport,
        prm: &KeepParams,
        capturers: &mut [(u8, u64, u32)],
    ) -> Result<KeepEvent, KeepError> {
        if k.troops > MAX_HOST_TROOPS {
            return Err(KeepError::TroopsAboveCap);
        }
        // 1. Heartland or consolidation: nothing counts.
        if k.heartland_safe || b < k.consolidated_until_bell {
            k.contender = NO_FACTION;
            k.progress = 0;
            return Ok(KeepEvent::None);
        }
        // 2. A defender, or nobody hostile: a running contest breaks.
        if r.defender_present || r.holders == 0 {
            let running = k.contender != NO_FACTION;
            k.contender = NO_FACTION;
            k.progress = 0;
            return Ok(if running {
                KeepEvent::Broken
            } else {
                KeepEvent::None
            });
        }
        // 3. Two or more hostile factions: M3 only.
        if r.holders.count_ones() > 1 {
            k.paused = true;
            return Ok(KeepEvent::Paused);
        }
        k.paused = false;
        let f = r.holders.trailing_zeros() as u8;
        let mut ev = KeepEvent::None;
        // 4. Count.
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
            let from = k.holder;
            let Some(di) = lead_host(capturers) else {
                // No resident of the contender (cannot happen when it holds
                // the hex); the keep is taken with an empty garrison.
                take(k, b, f, 0, prm);
                return Ok(KeepEvent::Taken {
                    from,
                    to: f,
                    garrison: 0,
                    donor: u8::MAX,
                    donor_removed: false,
                });
            };
            let pos = capturers
                .iter()
                .position(|c| c.0 == di)
                .expect("lead in list");
            let donor_troops = capturers[pos].2 as u64 * 1_000;
            let mut gar = donor_troops * prm.garrison_bps as u64 / 10_000;
            let rest = donor_troops - gar;
            let removed = rest < MIN_HOST_TROOPS as u64;
            if removed {
                gar += rest;
                capturers[pos].2 = 0;
            } else {
                capturers[pos].2 = (rest / 1_000) as u32;
            }
            if gar > MAX_HOST_TROOPS as u64 {
                return Err(KeepError::TroopsAboveCap);
            }
            take(k, b, f, gar as MilliTroops, prm);
            return Ok(KeepEvent::Taken {
                from,
                to: f,
                garrison: gar as MilliTroops,
                donor: di,
                donor_removed: removed,
            });
        }
        Ok(ev)
    }

    fn take(k: &mut Keep, b: u32, f: u8, troops: MilliTroops, prm: &KeepParams) {
        k.last_taken_from = k.holder;
        k.holder = f;
        k.troops = troops;
        k.consolidated_until_bell = b + 1 + prm.consolidate_bells;
        k.gen += 1;
        k.changes = k.changes.saturating_add(1);
        k.since_bell = b + 1;
        k.contender = NO_FACTION;
        k.progress = 0;
    }

    /// `control::controller` (strict rule): the side with `2·w ≥ Σw` and
    /// strictly more than every other side; `None` = unsettled (Σ = 0) or
    /// contested.
    pub fn controller(w: &[u64; SIDES]) -> Option<u8> {
        let tot: u64 = w.iter().sum();
        if tot == 0 {
            return None;
        }
        let (best, &bw) = w
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(&a.0)))
            .expect("sides");
        if 2 * bw < tot || w.iter().enumerate().any(|(i, &x)| i != best && x >= bw) {
            return None;
        }
        Some(best as u8)
    }

    /// `control::march_banner` over the March's open provinces' control
    /// (keep holders): f when `2 × held_by(f) > open`; `None` = contested
    /// or no open keep. Entries `NO_FACTION` count as open, held by none.
    pub fn march_banner(members: &[u8]) -> Option<u8> {
        let open = members.len() as u32;
        if open == 0 {
            return None;
        }
        let mut by = [0u32; 8];
        for &m in members {
            if (m as usize) < 6 {
                by[m as usize] += 1;
            }
        }
        (0..6).find(|&f| 2 * by[f] > open).map(|f| f as u8)
    }

    /// Siege v3 `capture_credited` (K-26): the victim held the holding at
    /// least `min_bells` before the flip at `b + 1`; a genesis Free City
    /// is always credited.
    pub fn capture_credited(
        b: u32,
        held_since_hour: u32,
        min_bells: u32,
        genesis_free_city: bool,
    ) -> bool {
        genesis_free_city || (b + 1).saturating_sub(6 * held_since_hour) >= min_bells
    }

    /// `held_since_hour` written at a change of owner effective at bell `b1`.
    pub fn held_since_hour(b1: u32) -> u32 {
        b1.div_ceil(6)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum OccupationEndKind {
        Liberated,
        Expired,
    }

    /// Siege v3 `occupation_ends` (R-05): Respite only on expiry or when
    /// the owner's faction holds the hex.
    pub fn occupation_ends(
        holds_occupier: bool,
        owner_holds: bool,
        b: u32,
        start: u32,
        tenure: u32,
    ) -> Option<(OccupationEndKind, bool)> {
        if !holds_occupier {
            return Some((OccupationEndKind::Liberated, owner_holds));
        }
        if b >= start + tenure {
            return Some((OccupationEndKind::Expired, true));
        }
        None
    }

    /// Siege v3 `can_complete_before` (R-08): true at once when
    /// `end_bell − from ≥ 288`; otherwise a forward scan from `from` that
    /// stops at `required` counted bells (≤ 287 `covers()` calls). A Free
    /// City (no vigil) needs `end_bell − from ≥ required`.
    pub fn can_complete_before(
        required: u32,
        vigil: Option<&Vigil>,
        from: u32,
        end_bell: u32,
    ) -> bool {
        let Some(v) = vigil else {
            return end_bell.saturating_sub(from) >= required;
        };
        if end_bell.saturating_sub(from) >= VIGIL_WINDOW_BOUND {
            return true;
        }
        let mut got = 0;
        for b in from..end_bell {
            if !v.covers(b as i64 * BELL_SECS) {
                got += 1;
                if got >= required {
                    return true;
                }
            }
        }
        false
    }

    /// Terrain v2 `free_city_site` mirror: a canonical site index from the
    /// ring seed and the province rotated into wedge 0, so every wedge gets
    /// the same site (CQ1-A's kernel replaces it; the choice only places
    /// one Free City per province).
    pub fn free_city_site(ring_seed: &[u8; 32], p: ProvinceCoord, site_count: u8) -> u8 {
        let w = p.wedge().unwrap_or(0);
        let c = p.rotate_by((6 - w) % 6);
        let h = permutation_rules::hash::sha256(&[
            b"frontier/free-city",
            ring_seed,
            &c.p.to_le_bytes(),
            &c.q.to_le_bytes(),
        ]);
        h[0] % site_count.max(1)
    }
}

/// Bell-start test of a vigil (genesis at 0).
pub fn vigil_covers(v: &Vigil, b: u32) -> bool {
    v.covers(b as i64 * BELL_SECS)
}

#[cfg(test)]
mod tests {
    use super::cqk::*;
    use super::*;

    fn prm() -> KeepParams {
        McParams::FRONTIER_7.keep_params()
    }

    fn keep() -> Keep {
        open(ProvinceCoord::new(5, 0), 0, 3, 7, &prm(), 0)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn cq_keep_contest_takes_after_72_held_bells() {
        let mut k = keep();
        assert!(!k.heartland_safe);
        let r = KeepReport {
            holders: 1 << 2,
            defender_present: false,
        };
        let mut caps = [(0u8, 10u64, 1_000u32), (1u8, 4u64, 3_000u32)];
        let mut ev = advance(&mut k, 10, r, &prm(), &mut caps).unwrap();
        assert_eq!(ev, KeepEvent::Contest(2));
        for b in 11..10 + 71 {
            ev = advance(&mut k, b, r, &prm(), &mut caps).unwrap();
            assert_eq!(ev, KeepEvent::None);
        }
        ev = advance(&mut k, 81, r, &prm(), &mut caps).unwrap();
        // The donor is the largest host (entry 1, 3,000 troops): 1,500 stay.
        assert_eq!(
            ev,
            KeepEvent::Taken {
                from: 0,
                to: 2,
                garrison: 1_500_000,
                donor: 1,
                donor_removed: false
            }
        );
        assert_eq!(caps[1].2, 1_500);
        assert_eq!(k.holder, 2);
        assert_eq!(k.consolidated_until_bell, 82 + 288);
        // Consolidation: nothing counts.
        ev = advance(
            &mut k,
            100,
            KeepReport {
                holders: 1,
                defender_present: false,
            },
            &prm(),
            &mut caps,
        )
        .unwrap();
        assert_eq!(ev, KeepEvent::None);
        assert_eq!(k.contender, NO_FACTION);
    }

    #[test]
    fn cq_keep_contest_breaks_on_a_defender_or_an_empty_hex() {
        let mut k = keep();
        let r = KeepReport {
            holders: 1 << 3,
            defender_present: false,
        };
        let mut caps = [(0u8, 1u64, 500u32)];
        advance(&mut k, 1, r, &prm(), &mut caps).unwrap();
        advance(&mut k, 2, r, &prm(), &mut caps).unwrap();
        assert_eq!(k.progress, 2);
        let ev = advance(
            &mut k,
            3,
            KeepReport {
                holders: 0,
                defender_present: true,
            },
            &prm(),
            &mut caps,
        )
        .unwrap();
        assert_eq!(ev, KeepEvent::Broken);
        assert_eq!(k.progress, 0);
        let ev = advance(
            &mut k,
            4,
            KeepReport {
                holders: 0,
                defender_present: false,
            },
            &prm(),
            &mut caps,
        )
        .unwrap();
        assert_eq!(ev, KeepEvent::None);
    }

    #[test]
    fn cq_keep_small_remainder_joins_the_keep() {
        let mut k = keep();
        k.required = 1;
        let mut caps = [(4u8, 9u64, 150u32)];
        let ev = advance(
            &mut k,
            5,
            KeepReport {
                holders: 1 << 1,
                defender_present: false,
            },
            &prm(),
            &mut caps,
        )
        .unwrap();
        assert_eq!(
            ev,
            KeepEvent::Taken {
                from: 0,
                to: 1,
                garrison: 150_000,
                donor: 4,
                donor_removed: true
            }
        );
        assert_eq!(caps[0].2, 0);
    }

    #[test]
    fn cq_keep_states_stay_under_the_host_cap() {
        // Six 30,000-troop capturers: the donor leaves 15,000.
        let mut k = keep();
        k.required = 1;
        let mut caps: Vec<(u8, u64, u32)> = (0..6).map(|i| (i, 100 - i as u64, 30_000)).collect();
        let ev = advance(
            &mut k,
            5,
            KeepReport {
                holders: 1 << 1,
                defender_present: false,
            },
            &prm(),
            &mut caps,
        )
        .unwrap();
        match ev {
            KeepEvent::Taken {
                garrison, donor, ..
            } => {
                assert_eq!(garrison, 15_000_000);
                assert_eq!(donor, 5); // lowest host id among equals
            }
            e => panic!("{e:?}"),
        }
        assert!(k.troops <= MAX_HOST_TROOPS);
    }

    #[test]
    fn cq_heartland_keeps_never_count() {
        let p = ProvinceCoord::new(2, 0);
        let w = p.wedge().unwrap();
        let mut k = open(p, w, 3, 1, &prm(), 0).unwrap().unwrap();
        assert!(k.heartland_safe);
        let ev = advance(
            &mut k,
            1,
            KeepReport {
                holders: 1 << ((w + 1) % 6),
                defender_present: false,
            },
            &prm(),
            &mut [],
        )
        .unwrap();
        assert_eq!(ev, KeepEvent::None);
        assert_eq!(k.progress, 0);
        assert!(open(ProvinceCoord::new(1, 0), 0, 3, 1, &prm(), 0)
            .unwrap()
            .is_none());
    }

    #[test]
    fn cq_controller_is_strict() {
        assert_eq!(controller(&[0; 7]), None);
        assert_eq!(controller(&[5, 5, 0, 0, 0, 0, 0]), None); // tie
        assert_eq!(controller(&[5, 4, 0, 0, 0, 0, 1]), Some(0)); // 2·5 ≥ 10
        assert_eq!(controller(&[4, 3, 0, 0, 0, 0, 2]), None); // 8 < 9
        assert_eq!(controller(&[0, 0, 0, 0, 0, 0, 9]), Some(6));
        assert_eq!(march_banner(&[1, 1, 2]), Some(1));
        assert_eq!(march_banner(&[1, 2, 3, 1]), None);
        assert_eq!(march_banner(&[]), None);
    }

    #[test]
    fn cq_capture_credit_and_occupation_end() {
        assert!(capture_credited(200, held_since_hour(50), 144, false));
        assert!(!capture_credited(100, held_since_hour(50), 144, false));
        assert!(capture_credited(1, 0, 144, true));
        assert_eq!(occupation_ends(true, false, 10, 5, 72), None);
        assert_eq!(
            occupation_ends(true, false, 77, 5, 72),
            Some((OccupationEndKind::Expired, true))
        );
        assert_eq!(
            occupation_ends(false, false, 20, 5, 72),
            Some((OccupationEndKind::Liberated, false))
        );
        assert_eq!(
            occupation_ends(false, true, 20, 5, 72),
            Some((OccupationEndKind::Liberated, true))
        );
    }

    #[test]
    fn cq_vigil_window_bound_and_late_horns() {
        let v = Vigil::new(0).unwrap();
        assert!(can_complete_before(60, Some(&v), 0, 288));
        // 100 bells left, 8 h (48 bells) of them in the vigil each day.
        assert!(can_complete_before(36, Some(&v), 900, 1_000));
        assert!(!can_complete_before(60, Some(&v), 960, 1_008));
        assert!(can_complete_before(36, None, 900, 936));
        assert!(!can_complete_before(36, None, 900, 935));
    }
}
