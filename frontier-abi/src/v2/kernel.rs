//! **Kernel bridge: the CQ1-A kernels `frontier-abi` v2 calls (MC §7).**
//!
//! Wave 1 built CQ1-A (`permutation-rules::frontier::{keep, control,
//! siege v3, camp v2, geometry v2}`) and CQ1-C in parallel, so CQ1-C wrote
//! its calls against stand-ins in this module. The integrator switched it
//! to the real kernels after the CQ1-A merge (CQ1-C request R1,
//! `integ-CQ1-NOTES.md`): every rule below is `permutation-rules`'; no
//! second copy of a rule survives (M1 §3.3). What remains here is only
//! naming and argument adaptation where CQ1-A's types differ from the
//! names `conquest_model` and `clash_model` use:
//!
//! | name here | kernel item |
//! |---|---|
//! | [`keep`] | `permutation_rules::frontier::keep` (+ `keep_tile`: the MC keep tile `keep_tile_symmetric` over a `ProvinceTerrain` and its wedge, `NONE`, `KEEP_GARRISON_ID_BASE`) |
//! | [`catalog2`] | the MC train-cost table of `permutation_rules::frontier::catalog` (`train_v2`, K2) |
//! | [`doctrine2`] | `permutation_rules::frontier::doctrine::validate_table_v2` (the Knight bound) |
//! | [`control`] | `permutation_rules::frontier::control` (+ `site_weight_centi` with the 0-based order, `NEUTRAL`, `SNAPSHOT_DIVISOR`) |
//! | [`siege3`] | `siege::SiegeV3::advance` and the v3 functions of `permutation_rules::frontier::siege` (+ `vigil_of_snapshot`, the record decoder) |
//! | [`camp2::place_v2`] | `permutation_rules::frontier::camp::place_v2` |
//! | [`is_heartland_in`] | `permutation_rules::frontier::geometry::is_heartland_in` |
//! | [`ruleset_hash_v2`] | `permutation_rules::frontier::ruleset_hash_v2` |

pub use permutation_rules::frontier::clash::MAX_GARRISONS_WITH_KEEP;
pub use permutation_rules::frontier::geometry::is_heartland_in;
pub use permutation_rules::frontier::ruleset_hash_v2;
pub use permutation_rules::frontier::siege::{
    VIGIL_WINDOW_BOUND, VIGIL_WINDOW_MIN_OUTSIDE as VIGIL_WINDOW_MIN_OPEN,
};
pub use permutation_rules::frontier::RULES_VERSION_FRONTIER_V2;

/// The keep kernel (KEEP_VERSION 2, §3.2, §7).
pub mod keep {
    pub use permutation_rules::frontier::keep::*;
    use permutation_rules::frontier::terrain::ProvinceTerrain;

    /// Keep garrison ids are `KEEP_GARRISON_ID_BASE − gen` (§3.14).
    pub const KEEP_GARRISON_ID_BASE: u64 = KEEP_ID_BASE;
    /// No faction (contender, last holder).
    pub const NONE: u8 = NO_FACTION;

    /// The MC keep tile of a province in wedge `wedge` (v1.3, PO-5,
    /// CQH1(5)): [`permutation_rules::frontier::keep::keep_tile_symmetric`]
    /// over a generated province's terrain (the kernel reads the
    /// Province's `terrain[61]` bytes, `map::Terrain as u8`), so every
    /// wedge of a ring keeps on the same tile. The kernel's own
    /// `keep_tile` (the v1.2 scan, wedge 0's tile) is not re-exported
    /// under this name.
    pub fn keep_tile(
        terrain: &ProvinceTerrain,
        sites: &[u8],
        site_count: u8,
        wedge: u8,
    ) -> Option<u8> {
        let bytes = terrain.terrain.map(|t| t as u8);
        permutation_rules::frontier::keep::keep_tile_symmetric(&bytes, sites, site_count, wedge)
    }
}

/// The MC train-cost table (CATALOG_VERSION_V2 2; K2: PO-2, CQH1(2)):
/// Train under the v2 rules pays `train_v2` (the Horseman line without
/// its ore/gold variant surcharge; every other unit, the Knight included,
/// as in M1). M1's `catalog::train` is unchanged.
pub mod catalog2 {
    pub use permutation_rules::frontier::catalog::{
        train_prod_cost_v2, train_v2, variant_surcharge_v2, CATALOG_VERSION_V2, TRAIN_PROD_COST_V2,
    };
}

/// The MC doctrine bound (DOCTRINE_VERSION_V2 2; PO-2, CQH1(2)): no
/// doctrine fields the Knight line under the v2 rules.
pub mod doctrine2 {
    pub use permutation_rules::frontier::doctrine::bounds::REFUSED_LINES_V2;
    pub use permutation_rules::frontier::doctrine::{
        validate_table_v2, DoctrineError, DOCTRINE_VERSION_V2,
    };
}

/// The control kernel (CONTROL_VERSION 1, §3.3, §3.10, §7).
pub mod control {
    use permutation_rules::fixed::MilliTroops;
    pub use permutation_rules::frontier::control::*;
    use permutation_rules::frontier::laurel::Tier;

    /// The neutral side.
    pub const NEUTRAL: u8 = NEUTRAL_SIDE;
    /// Snapshot unit: centi-strength-weight (`strength_weight / 10,000`).
    pub const SNAPSHOT_DIVISOR: u64 = SNAPSHOT_UNIT;

    /// The kernel's `site_weight_centi` with the **0-based** holding order
    /// `order0` (`order − 1`; a Free City 0), as the site mirror stores it.
    pub fn site_weight_centi(tier: Tier, garrison: MilliTroops, order0: u8) -> u16 {
        permutation_rules::frontier::control::site_weight_centi(
            tier,
            garrison,
            order0.saturating_add(1),
        )
    }
}

/// Siege v3 (SIEGE_VERSION 3, §3.4–§3.6, §7), beside the v2 kernel.
pub mod siege3 {
    use permutation_rules::frontier::siege::Vigil;
    pub use permutation_rules::frontier::siege::{
        broken_by_defender, can_complete_before, capture_credited, earliest_completion_bell,
        occupation_ends, OccupationEnd, OccupationEndKind, SiegeV3,
    };

    /// The owner's vigil as snapshotted at the horn (§5.2.1 record bytes
    /// 6..12): the start in force, the next start and the UTC day it takes
    /// effect (0: no change pending). A record decoder, not a rule.
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
    pub use permutation_rules::frontier::camp::place_v2;
}

#[cfg(test)]
mod tests {
    use super::keep::*;
    use super::*;
    use permutation_rules::frontier::geometry::ProvinceCoord;
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
        use permutation_rules::frontier::siege::{BellReport, SiegeStatus, SiegeV3};
        let mut s = SiegeV3::declare(3, 10, 0, 0);
        s.required = 2;
        let hold = BellReport {
            holders: 1 << 3,
            defender_present: false,
        };
        assert_eq!(s.advance(11, 0, hold, None), SiegeStatus::Active);
        assert_eq!(s.advance(12, 0, hold, None), SiegeStatus::Completed);
        let mut s = SiegeV3::declare(3, 10, 0, 0);
        let gone = BellReport {
            holders: 0,
            defender_present: true,
        };
        assert_eq!(s.advance(11, 0, gone, None), SiegeStatus::Failed);
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

    /// K2 and the Knight bound through the bridge.
    #[test]
    fn cq_train_v2_and_the_knight_bound() {
        use permutation_rules::frontier::catalog::train;
        use permutation_rules::frontier::doctrine::DOCTRINES;
        use permutation_rules::units::UnitType;
        let horse = UnitType::Horseman as u8;
        assert_eq!(catalog2::train_v2(horse, 500), train(0, 500));
        assert_ne!(catalog2::train_v2(horse, 500), train(horse, 500));
        for u in [0u8, 1, 3, 4, 5, 6] {
            assert_eq!(catalog2::train_v2(u, 500), train(u, 500), "unit {u}");
        }
        assert_eq!(doctrine2::validate_table_v2(&DOCTRINES), Ok(()));
        let mut t = DOCTRINES;
        t[1].unit = UnitType::Knight;
        assert_eq!(
            doctrine2::validate_table_v2(&t),
            Err(doctrine2::DoctrineError::RefusedLine)
        );
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
