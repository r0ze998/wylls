//! MC "Contested Ground" (CONQUEST-CONTRACT v1.1) inside the simulator:
//! the rule set selector (`--rules m1|mc|mc-weightmap`, `+bannerdom`,
//! `+keepdom`), the policy and bot-profile selectors, the season
//! parameters of §3.12 (Frontier-7, Frontier-28, MC_TEST) and the conquest
//! kernels the simulator calls.
//!
//! **Kernels.** `cqk` below re-exports CQ1-A's `permutation_rules::
//! frontier::{keep, control}` and the siege v3 / terrain v2 / geometry v2
//! additions (§7, §8.7 item 1). CQ1-B measured wave 1 first on a local
//! mirror; the integrator switched it to the real kernels after the CQ1-A
//! merge (CQ1-B dependency request 2, `integ-CQ1-NOTES.md`).

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

/// The §7 kernels the simulator calls: **re-exports of
/// `permutation_rules::frontier::{keep, control, siege v3, terrain v2,
/// geometry v2}`** (CQ1-B dependency request 2, switched by the integrator
/// after the CQ1-A merge; the mirror is gone). The wrappers below only
/// adapt the simulator's argument types (u32 ring parameter, u64 weight
/// vectors, faction-byte member lists, u32 hours) and keep the `Option`
/// forms the simulator matches on.
pub mod cqk {

    use permutation_rules::fixed::MilliTroops;
    use permutation_rules::frontier::control::{self, Banner, Controller, ProvinceControl};
    pub use permutation_rules::frontier::control::{CONTROL_VERSION, SIDES};
    use permutation_rules::frontier::geometry::ProvinceCoord;
    pub use permutation_rules::frontier::keep::{
        advance, lead_host, Keep, KeepError, KeepEvent, KeepParams, KeepReport, KEEP_VERSION,
        NO_FACTION,
    };
    pub use permutation_rules::frontier::siege::OccupationEndKind;
    use permutation_rules::frontier::siege::{self, Vigil};

    /// `geometry::is_heartland_in` with the simulator's u32 ring parameter.
    pub fn is_heartland_in(p: ProvinceCoord, faction: u8, max_ring: u32) -> bool {
        permutation_rules::frontier::geometry::is_heartland_in(
            p,
            faction,
            max_ring.min(u8::MAX as u32) as u8,
        )
    }

    /// `keep::try_open` (None for rings 0–1; `TroopsAboveCap` for a home
    /// guard above the cap).
    pub fn open(
        p: ProvinceCoord,
        wedge: u8,
        heartland_max_ring: u32,
        tile: u8,
        prm: &KeepParams,
        bell: u32,
    ) -> Result<Option<Keep>, KeepError> {
        permutation_rules::frontier::keep::try_open(
            p,
            wedge,
            heartland_max_ring.min(u8::MAX as u32) as u8,
            tile,
            prm,
            bell,
        )
    }

    /// The keep's troops in milli-troops (the clash garrison's unit; the
    /// kernel's `Keep.troops` is whole troops).
    pub fn keep_milli(k: &Keep) -> MilliTroops {
        k.troops.saturating_mul(1_000)
    }

    /// `control::controller` (strict rule) over the simulator's u64
    /// weights: `Some(side)`, or `None` when unsettled or contested.
    pub fn controller(w: &[u64; SIDES]) -> Option<u8> {
        let w32 = w.map(|x| x.min(u32::MAX as u64) as u32);
        match control::controller(&w32) {
            Controller::Side(s) => Some(s),
            Controller::Contested | Controller::Unsettled => None,
        }
    }

    /// `control::march_banner` over the March's opened provinces' control
    /// bytes. With keeps every opened province has a holder (0–5) and this
    /// is exactly the kernel. The holding-weight negative controls
    /// (`--rules m1`, `mc-weightmap`) also have opened provinces without a
    /// controller (`NO_FACTION`); for them "open" means opened, as in the
    /// CQ1-B measurement, so the kernel's banner must also hold more than
    /// half of all members. `None` = contested or no open province.
    pub fn march_banner(members: &[u8]) -> Option<u8> {
        let v: Vec<ProvinceControl> = members.iter().map(|&f| ProvinceControl::Keep(f)).collect();
        match control::march_banner(&v) {
            Banner::Faction(f) => {
                let held = members.iter().filter(|&&m| m == f).count();
                (2 * held > members.len()).then_some(f)
            }
            Banner::Contested | Banner::None => None,
        }
    }

    /// Siege v3 `capture_credited` (K-26).
    pub fn capture_credited(
        b: u32,
        held_since_hour: u32,
        min_bells: u32,
        genesis_free_city: bool,
    ) -> bool {
        siege::capture_credited(
            b,
            held_since_hour.min(u16::MAX as u32) as u16,
            min_bells,
            genesis_free_city,
        )
    }

    /// `held_since_hour` written at a change of owner effective at bell `b1`
    /// (`siege::held_since_hour_from`).
    pub fn held_since_hour(b1: u32) -> u32 {
        siege::held_since_hour_from(b1) as u32
    }

    /// Siege v3 `occupation_ends` (R-05) as `(kind, respite)`.
    pub fn occupation_ends(
        holds_occupier: bool,
        owner_holds: bool,
        b: u32,
        start: u32,
        tenure: u32,
    ) -> Option<(OccupationEndKind, bool)> {
        siege::occupation_ends(holds_occupier, owner_holds, b, start, tenure)
            .map(|e| (e.kind, e.respite))
    }

    /// Siege v3 `can_complete_before` (R-08), genesis at 0 (the
    /// simulator's clock).
    pub fn can_complete_before(
        required: u32,
        vigil: Option<&Vigil>,
        from: u32,
        end_bell: u32,
    ) -> bool {
        siege::can_complete_before(required.min(u8::MAX as u32) as u8, vigil, from, end_bell, 0)
    }

    /// Terrain v2 `free_city_site`.
    pub fn free_city_site(ring_seed: &[u8; 32], p: ProvinceCoord, site_count: u8) -> u8 {
        permutation_rules::frontier::terrain::free_city_site(ring_seed, p, site_count)
    }
}

/// Bell-start test of a vigil (genesis at 0).
pub fn vigil_covers(v: &Vigil, b: u32) -> bool {
    v.covers(b as i64 * BELL_SECS)
}

#[cfg(test)]
mod tests {
    //! The simulator's view of the CQ1-A kernels (units: `Keep.troops`
    //! whole troops, capturers in milli-troops), so a unit change in the
    //! adapters cannot pass unnoticed. Rule coverage is CQ1-A's
    //! (`permutation-rules/tests/frontier_conquest.rs`).
    use super::cqk::*;
    use super::*;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::host::MAX_HOST_TROOPS;

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
        assert_eq!(keep_milli(&k), prm().home_guard * 1_000);
        let r = KeepReport {
            holders: 1 << 2,
            defender_present: false,
        };
        let mut caps = [(0u8, 10u64, 1_000_000u32), (1u8, 4u64, 3_000_000u32)];
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
                garrison: 1_500,
                donor: 1,
                donor_removed: false
            }
        );
        assert_eq!(caps[1].2, 1_500_000);
        assert_eq!(k.holder, 2);
        assert_eq!(keep_milli(&k), 1_500_000);
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
        let mut caps = [(0u8, 1u64, 500_000u32)];
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
        let mut caps = [(4u8, 9u64, 150_000u32)];
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
                garrison: 150,
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
        let mut caps: Vec<(u8, u64, u32)> = (0..6)
            .map(|i| (i, 100 - i as u64, MAX_HOST_TROOPS))
            .collect();
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
                assert_eq!(garrison, 15_000);
                assert_eq!(donor, 5); // lowest host id among equals
            }
            e => panic!("{e:?}"),
        }
        assert!(keep_milli(&k) <= MAX_HOST_TROOPS);
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
        assert!(is_heartland_in(p, w, 3) && !is_heartland_in(p, w, 1));
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
        // Weight-map controls: an opened province without a controller
        // still counts as open.
        assert_eq!(march_banner(&[1, NO_FACTION]), None);
        assert_eq!(march_banner(&[1, 1, NO_FACTION]), Some(1));
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
        // CQ1-A: tenure wins when both fall on one bell.
        assert_eq!(
            occupation_ends(false, false, 77, 5, 72),
            Some((OccupationEndKind::Expired, true))
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
