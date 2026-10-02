//! **SHIM until unit W1C-A (kernels, `frontier/cq-w1c-kernels`) merges.**
//!
//! K2 (W1-close, PO-2, CQH1(2)): under MC, cavalry unit lines pay no ore
//! or gold variant surcharge. On chain this is an MC-only train cost (the
//! v2 table of `catalog::train`), not a Depart change. Unit W1C-A owns that
//! table in `permutation-rules`; until it merges, [`train_v2`] stands in
//! for it with the semantics the decision sheet states, so the simulator
//! already plays K2 *through a train-cost table* and only the call site
//! changes when the kernel lands. Delete this file then and call the
//! kernel's function in [`march_surcharge_mc`] (the only caller).
//!
//! The stand-in follows W1C-A's table as its worktree shows it while this
//! unit was written (`catalog::train_v2(unit: u8, n: u32) ->
//! Option<Cost>`, `TRAIN_PROD_COST_V2 = [6, 7, 6, 12, 14, 16, 10]`): the
//! **Horseman line** at a Spearman's ore and gold, every other line (the
//! Knight included: no MC doctrine may field it, `validate_table_v2`'s
//! Knight bound) at its M1 cost. The merge replaces [`train_v2`] by
//! `permutation_rules::frontier::catalog::train_v2` (same signature); this
//! file's two tests then move to the kernel's call site or go with it.
//!
//! The P1 package measurement ran `--e3 all=0` (no surcharge for any line):
//! identical for the Season-1 doctrines (only B and F field cavalry, both
//! the Horseman line); it differs only in the doctrine gate's Knight
//! negative control (see W1C-B-sim-NOTES §3).

use permutation_rules::fixed::Milli;
use permutation_rules::frontier::catalog::{self, Cost};
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use permutation_rules::units::UnitType;

/// Stand-in for W1C-A's MC train-cost table: [`catalog::train`] with the
/// Horseman line at the Spearman's ore and gold (K2). `None` as
/// `catalog::train` (n = 0, an unknown unit, overflow).
pub fn train_v2(unit: u8, n: u32) -> Option<Cost> {
    catalog::unit_of(unit)?;
    let line = if unit == UnitType::Horseman as u8 {
        UnitType::Spearman as u8
    } else {
        unit
    };
    catalog::train(line, n)
}

/// The simulator's per-march variant surcharge of a host of `k` hundred
/// troops of `unit` under MC: the ore and gold the MC train-cost table
/// charges `unit` above a Spearman for `k × 100` troops (the simulator
/// models M1's surcharge per march; `catalog::train` folds the same
/// amount into the purchase, see its doc). With the v1 table this is the
/// M1 per-march formula exactly (`cq_k2_surcharge_is_the_train_table`).
pub fn march_surcharge_mc(unit: UnitType, k: i64) -> [Milli; RESOURCES] {
    surcharge_from(train_v2, unit, k)
}

/// `table(unit) − table(Spearman)` in ore and gold, for `k × 100` troops.
pub fn surcharge_from(
    table: fn(u8, u32) -> Option<Cost>,
    unit: UnitType,
    k: i64,
) -> [Milli; RESOURCES] {
    let mut c = [0; RESOURCES];
    if k <= 0 {
        return c;
    }
    let n = (k * 100).min(u32::MAX as i64) as u32;
    let (Some(mine), Some(base)) = (table(unit as u8, n), table(UnitType::Spearman as u8, n))
    else {
        return c;
    };
    for r in [Resource::Ore as usize, Resource::Gold as usize] {
        c[r] = (mine[r] - base[r]).max(0);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TROOP_COST_PER_100;
    use permutation_rules::fixed::MILLI;
    use permutation_rules::frontier::doctrine::DOCTRINES;
    use permutation_rules::units::stats;

    /// The M1 per-march surcharge of `sim.rs` (`send_at`).
    fn m1_formula(unit: UnitType, k: i64) -> [Milli; RESOURCES] {
        let extra = stats(unit).prod_cost as i64 - 6;
        let mut c = [0; RESOURCES];
        if extra > 0 {
            c[Resource::Ore as usize] = k * TROOP_COST_PER_100[1] * extra / 6 * MILLI;
            c[Resource::Gold as usize] = k * TROOP_COST_PER_100[2] * extra / 6 * MILLI;
        }
        c
    }

    #[test]
    fn cq_k2_surcharge_is_the_train_table() {
        // With the v1 table the table difference is the M1 per-march
        // surcharge for every unit line and host size the sim sends.
        for u in [
            UnitType::Spearman,
            UnitType::Archer,
            UnitType::Horseman,
            UnitType::Pikeman,
            UnitType::Crossbowman,
            UnitType::Knight,
        ] {
            for k in 0..=300 {
                assert_eq!(
                    surcharge_from(catalog::train, u, k),
                    m1_formula(u, k),
                    "{u:?} k={k}"
                );
            }
        }
    }

    #[test]
    fn cq_k2_cavalry_pays_no_surcharge_under_mc() {
        for k in [1, 5, 40, 300] {
            assert_eq!(march_surcharge_mc(UnitType::Horseman, k), [0; RESOURCES]);
            assert_eq!(
                train_v2(UnitType::Horseman as u8, (k * 100) as u32),
                catalog::train(UnitType::Spearman as u8, (k * 100) as u32)
            );
        }
        // Every other line keeps its table cost (the Knight too).
        for u in [
            UnitType::Spearman,
            UnitType::Archer,
            UnitType::Pikeman,
            UnitType::Crossbowman,
            UnitType::Knight,
            UnitType::Scout,
        ] {
            assert_eq!(train_v2(u as u8, 500), catalog::train(u as u8, 500));
        }
        assert!(march_surcharge_mc(UnitType::Knight, 5)[Resource::Ore as usize] > 0);
        assert_eq!(train_v2(7, 100), None);
        // No Season-1 doctrine pays a surcharge under MC.
        for d in &DOCTRINES {
            assert_eq!(march_surcharge_mc(d.unit, 50), [0; RESOURCES], "{}", d.name);
        }
    }
}
