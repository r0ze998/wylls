//! Stage 1a of the redesign: the arms economy (design/redesign 18, 30).
//!
//! Additive. Nothing here is bound into `ruleset_hash_input` or
//! `ruleset_hash_input_v2`, and no M1 or MC table changes, so every
//! running season, golden vector and verifier replay is untouched. The
//! program adopts these rules in a later step, with a new ruleset version
//! and a new season (redesign 30, J5).
//!
//! * **Arms** take the Horses store slot ([`ARMS`] = `Resource::Horses`,
//!   index 4): Horses has no production, cost or effect in Frontier, and is
//!   movable (not `pledge_only`), so no layout changes.
//! * **Workshop:** converts ore and wood into arms at a fixed rate while
//!   both inputs last ([`plan_conversion`]). When an input runs dry the
//!   workshop keeps running at the rate its input production allows. The
//!   switch time is fixed when the plan is made, so settling stays path
//!   independent, as for every other scheduled rate change.
//! * **Strong units** (Pikeman, Crossbowman, Knight; redesign 30, J3) also
//!   cost arms to train ([`train_v3`]).
//! * **Sieges** consume arms when declared ([`SIEGE_ARMS`]).
//! * **Ore from terrain:** the ore a holding makes depends on the hills,
//!   mountains and iron around it, within its own province
//!   ([`terrain_ore_per_hour`]; redesign 30, H3).
//!
//! Every number marked [phase 6] is a placeholder until the economy
//! phase measures it.

use crate::fixed::{Milli, MILLI};
use crate::hex::Hex;
use crate::map::{Terrain, TileResource};

use crate::frontier::catalog::{train_v2, Cost};
use crate::frontier::geometry::{tile_index, tile_offset, PROVINCE_TILES};
use crate::frontier::holding::{Accrual, Resource, HOUR, RESOURCES};

/// Kernel version of this module (for a future ruleset hash input).
pub const ARMS_VERSION: u16 = 1;

/// The store slot arms use: the Horses slot (index 4).
pub const ARMS: Resource = Resource::Horses;

// ====================================================================
// Workshop
// ====================================================================

/// Per workshop copy, per hour (units) [phase 6]: ore and wood in, arms out.
pub const WORKSHOP_ORE_PER_HOUR: i64 = 8;
pub const WORKSHOP_WOOD_PER_HOUR: i64 = 4;
pub const WORKSHOP_ARMS_PER_HOUR: i64 = 4;
/// Base cost (units) of the first workshop copy [phase 6]; later copies
/// follow `holding::duplicate_cost` like every building.
pub const WORKSHOP_COST: [i64; RESOURCES] = [60, 120, 80, 40, 0, 0, 0, 0];

/// Hourly net rates (milli-units per hour) of the three stores a workshop
/// touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flow {
    pub ore: i64,
    pub wood: i64,
    pub arms: i64,
}

/// A workshop's schedule from the moment it is planned: [`Flow`] `full`
/// until `switch_after` seconds have passed (if ever), then `limited`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConversionPlan {
    pub full: Flow,
    /// Seconds after the plan's start when an input runs dry; `None` if the
    /// inputs never run dry at the full rate.
    pub switch_after: Option<i64>,
    pub limited: Flow,
}

/// Seconds until `value` (milli) reaches 0 at a net rate `net` (milli per
/// hour, negative), rounded down so the value never goes below 0.
fn secs_to_empty(value: Milli, net: i64) -> i64 {
    debug_assert!(net < 0);
    let v = value.max(0) as i128;
    let secs = v * HOUR as i128 / (-(net as i128));
    secs.min(i64::MAX as i128) as i64
}

/// Plan `copies` workshops working from now on.
///
/// `ore`, `wood`: the stores' values now (milli). `ore_prod`, `wood_prod`:
/// what the holding makes per hour of each without the workshops (milli
/// per hour, ≥ 0).
///
/// * **full:** ore and wood fall by the workshops' use, arms rise by their
///   output.
/// * **switch_after:** if an input's net rate is negative, the seconds until
///   the first input reaches 0 (rounded down).
/// * **limited:** after the switch the workshops run at the share of full
///   speed the scarcer input's production allows (`prod / use`, in basis
///   points, rounded down), so neither input goes below 0.
///
/// The caller applies `full` from the start, then `limited` at the switch
/// time. It re-plans only at a scheduled event (a finished build, a new
/// workshop), never at a touch, which keeps settling path independent.
pub fn plan_conversion(
    copies: u32,
    ore: Milli,
    wood: Milli,
    ore_prod: i64,
    wood_prod: i64,
) -> ConversionPlan {
    let k = copies as i64;
    let ore_use = WORKSHOP_ORE_PER_HOUR * MILLI * k;
    let wood_use = WORKSHOP_WOOD_PER_HOUR * MILLI * k;
    let arms_out = WORKSHOP_ARMS_PER_HOUR * MILLI * k;
    let full = Flow {
        ore: ore_prod - ore_use,
        wood: wood_prod - wood_use,
        arms: arms_out,
    };
    if k == 0 || (full.ore >= 0 && full.wood >= 0) {
        return ConversionPlan {
            full,
            switch_after: None,
            limited: full,
        };
    }
    let mut switch = i64::MAX;
    if full.ore < 0 {
        switch = switch.min(secs_to_empty(ore, full.ore));
    }
    if full.wood < 0 {
        switch = switch.min(secs_to_empty(wood, full.wood));
    }
    // Share of full speed each input's production sustains, basis points.
    let share = |prod: i64, used: i64| -> i64 {
        if used == 0 {
            10_000
        } else {
            (prod.max(0) as i128 * 10_000 / used as i128).min(10_000) as i64
        }
    };
    let s = share(ore_prod, ore_use).min(share(wood_prod, wood_use));
    let limited = Flow {
        ore: ore_prod - ore_use * s / 10_000,
        wood: wood_prod - wood_use * s / 10_000,
        arms: arms_out * s / 10_000,
    };
    ConversionPlan {
        full,
        switch_after: Some(switch),
        limited,
    }
}

/// Settle the three stores of a converting holding to `t`, following
/// `plan` made at `start`: the full rates until the switch, the limited
/// ones after. The stores must carry the full rates when this is first
/// called (`set_rate` at `start`). Settling at any sequence of times ≤ `t`
/// gives the same values as settling once at `t`.
pub fn settle_conversion(
    ore: &mut Accrual,
    wood: &mut Accrual,
    arms: &mut Accrual,
    plan: &ConversionPlan,
    start: i64,
    t: i64,
) {
    if let Some(after) = plan.switch_after {
        let at = start.saturating_add(after);
        if t > at && arms.rate == plan.full.arms && plan.full != plan.limited {
            ore.set_rate(at, plan.limited.ore);
            wood.set_rate(at, plan.limited.wood);
            arms.set_rate(at, plan.limited.arms);
        }
    }
    ore.settle(t);
    wood.settle(t);
    arms.settle(t);
}

// ====================================================================
// Training and sieges
// ====================================================================

/// Arms per 100 troops, by unit id 0..=6 (`catalog::unit_of`) [phase 6]:
/// only the strong units (Pikeman, Crossbowman, Knight; J3) need arms.
/// The values are the best of the J3 search in `frontier-sim` (doctrine
/// table A Pikeman, C Crossbowman, F Knight; `docs/frontier/stage1a/
/// J3-NOTES.md`): five doctrines within ±0.28% of mean index at the gate's
/// size, B Tide still −0.67%, so the gate (±0.2%) is not yet met.
pub const TRAIN_ARMS_PER_100: [i64; 7] = [0, 0, 0, 50, 70, 40, 0];

/// Training `n` troops of `unit` under the stage-1a rules: the conquest
/// rules' cost ([`train_v2`]) plus `TRAIN_ARMS_PER_100[unit] × ⌈n / 100⌉`
/// arms. `None` where `train_v2` refuses, or on overflow.
pub fn train_v3(unit: u8, n: u32) -> Option<Cost> {
    let mut c = train_v2(unit, n)?;
    let per = *TRAIN_ARMS_PER_100.get(unit as usize)?;
    let k = n.div_ceil(100) as i64;
    c[ARMS as usize] = k.checked_mul(per)?.checked_mul(MILLI)?;
    Some(c)
}

/// Arms consumed when a siege is declared (units) [phase 6].
pub const SIEGE_ARMS: i64 = 50;

/// The siege's arms as a cost (milli).
pub fn siege_cost() -> Cost {
    let mut c = [0; RESOURCES];
    c[ARMS as usize] = SIEGE_ARMS * MILLI;
    c
}

// ====================================================================
// Ore from terrain
// ====================================================================

/// Ore every holding makes per hour regardless of terrain (units)
/// [phase 6]. Lower than the M1 base (15), so plains holdings make little.
pub const ORE_BASE_PER_HOUR: i64 = 4;
/// Extra ore per hour from each tile within [`ORE_RADIUS`] (units)
/// [phase 6].
pub const ORE_PER_HILLS: i64 = 2;
pub const ORE_PER_MOUNTAIN: i64 = 3;
pub const ORE_PER_IRON: i64 = 4;
/// Tiles counted around the holding, in its own province only (H3).
pub const ORE_RADIUS: u32 = 2;
/// Upper bound of the terrain part (units per hour) [phase 6].
pub const ORE_TERRAIN_MAX: i64 = 30;

/// Ore per hour (milli) a holding on tile `tile` makes from terrain:
/// [`ORE_BASE_PER_HOUR`] plus, for every other tile of the same province
/// within [`ORE_RADIUS`], [`ORE_PER_HILLS`] or [`ORE_PER_MOUNTAIN`] by
/// terrain and [`ORE_PER_IRON`] for an iron resource, the terrain part
/// capped at [`ORE_TERRAIN_MAX`]. `None` for a tile index outside the
/// province. Computed once and stored with the holding (the base it adds
/// to is recomputed at tier-up, capture and found; redesign 30, §1-4).
pub fn terrain_ore_per_hour(
    terrain: &[Terrain; PROVINCE_TILES],
    resource: &[Option<TileResource>; PROVINCE_TILES],
    tile: u8,
) -> Option<i64> {
    let at = tile_offset(tile)?;
    let mut extra = 0i64;
    for q in -(ORE_RADIUS as i32)..=(ORE_RADIUS as i32) {
        for r in -(ORE_RADIUS as i32)..=(ORE_RADIUS as i32) {
            let o = Hex::new(at.q + q, at.r + r);
            if o == at || o.distance(at) > ORE_RADIUS {
                continue;
            }
            let Some(i) = tile_index(o) else { continue };
            let i = i as usize;
            extra += match terrain[i] {
                Terrain::Hills => ORE_PER_HILLS,
                Terrain::Mountain => ORE_PER_MOUNTAIN,
                _ => 0,
            };
            if resource[i] == Some(TileResource::Iron) {
                extra += ORE_PER_IRON;
            }
        }
    }
    Some((ORE_BASE_PER_HOUR + extra.min(ORE_TERRAIN_MAX)) * MILLI)
}

// ====================================================================
// Tables for a future ruleset hash
// ====================================================================

/// Canonical little-endian bytes of every table here. Order pinned;
/// append only. Not yet part of any ruleset hash input.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    let i = |out: &mut alloc::vec::Vec<u8>, x: i64| out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&ARMS_VERSION.to_le_bytes());
    out.push(ARMS as u8);
    for x in [
        WORKSHOP_ORE_PER_HOUR,
        WORKSHOP_WOOD_PER_HOUR,
        WORKSHOP_ARMS_PER_HOUR,
    ] {
        i(out, x);
    }
    for x in WORKSHOP_COST {
        i(out, x);
    }
    out.push(TRAIN_ARMS_PER_100.len() as u8);
    for x in TRAIN_ARMS_PER_100 {
        i(out, x);
    }
    i(out, SIEGE_ARMS);
    for x in [
        ORE_BASE_PER_HOUR,
        ORE_PER_HILLS,
        ORE_PER_MOUNTAIN,
        ORE_PER_IRON,
        ORE_TERRAIN_MAX,
    ] {
        i(out, x);
    }
    out.extend_from_slice(&ORE_RADIUS.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn stores(ore: i64, wood: i64, plan: &ConversionPlan) -> (Accrual, Accrual, Accrual) {
        let cap = 1_000_000 * MILLI;
        (
            Accrual::new(ore, plan.full.ore, cap, T0),
            Accrual::new(wood, plan.full.wood, cap, T0),
            Accrual::new(0, plan.full.arms, cap, T0),
        )
    }

    #[test]
    fn arms_use_the_unused_horses_slot() {
        assert_eq!(ARMS as usize, 4);
        assert!(!ARMS.pledge_only());
        assert_eq!(crate::frontier::catalog::BASE_PROD[ARMS as usize], 0);
    }

    #[test]
    fn plenty_of_input_never_switches() {
        let p = plan_conversion(1, 100 * MILLI, 100 * MILLI, 20 * MILLI, 10 * MILLI);
        assert_eq!(p.switch_after, None);
        assert_eq!(p.full, p.limited);
        assert_eq!(p.full.arms, 4 * MILLI);
        assert_eq!(p.full.ore, 12 * MILLI);
    }

    #[test]
    fn ore_runs_dry_then_production_limits_the_workshop() {
        // ore: 16 in stock, makes 2/h, uses 8/h → net −6/h → dry after 16/6 h.
        // wood: plenty. After the switch the workshop runs at 2/8 = 25%.
        let p = plan_conversion(1, 16 * MILLI, 500 * MILLI, 2 * MILLI, 20 * MILLI);
        assert_eq!(p.switch_after, Some(16 * 3_600 / 6));
        assert_eq!(p.limited.arms, MILLI);
        assert_eq!(p.limited.ore, 0);
        assert_eq!(p.limited.wood, 20 * MILLI - MILLI);
    }

    #[test]
    fn inputs_never_go_negative() {
        let p = plan_conversion(3, 7 * MILLI, 9 * MILLI, 0, 0);
        let (mut o, mut w, mut a) = stores(7 * MILLI, 9 * MILLI, &p);
        settle_conversion(&mut o, &mut w, &mut a, &p, T0, T0 + 10 * HOUR);
        assert!(o.value >= 0 && w.value >= 0);
        assert_eq!(p.limited.arms, 0, "no production, no arms after the switch");
    }

    #[test]
    fn settling_is_path_independent() {
        let p = plan_conversion(2, 30 * MILLI, 40 * MILLI, 3 * MILLI, 5 * MILLI);
        let end = T0 + 9 * HOUR + 17;
        let (mut o1, mut w1, mut a1) = stores(30 * MILLI, 40 * MILLI, &p);
        settle_conversion(&mut o1, &mut w1, &mut a1, &p, T0, end);
        let (mut o2, mut w2, mut a2) = stores(30 * MILLI, 40 * MILLI, &p);
        let mut t = T0;
        while t < end {
            t = (t + 1_234).min(end);
            settle_conversion(&mut o2, &mut w2, &mut a2, &p, T0, t);
        }
        assert_eq!((o1, w1, a1), (o2, w2, a2));
    }

    #[test]
    fn strong_units_cost_arms() {
        for u in 0..=6u8 {
            let c = train_v3(u, 250).unwrap();
            let base = train_v2(u, 250).unwrap();
            assert_eq!(c[..4], base[..4]);
            assert_eq!(c[5..], base[5..]);
            assert_eq!(c[ARMS as usize], TRAIN_ARMS_PER_100[u as usize] * 3 * MILLI);
        }
        assert_eq!(train_v3(5, 100).unwrap()[ARMS as usize], 40 * MILLI);
        assert_eq!(train_v3(0, 100).unwrap()[ARMS as usize], 0);
        assert!(train_v3(7, 100).is_none());
        assert!(train_v3(0, 0).is_none());
        assert_eq!(siege_cost()[ARMS as usize], SIEGE_ARMS * MILLI);
    }

    #[test]
    fn hills_and_iron_raise_ore() {
        let plains = [Terrain::Plains; PROVINCE_TILES];
        let none = [None; PROVINCE_TILES];
        let centre = tile_index(Hex::new(0, 0)).unwrap();
        assert_eq!(
            terrain_ore_per_hour(&plains, &none, centre),
            Some(ORE_BASE_PER_HOUR * MILLI)
        );
        let mut hilly = plains;
        let mut iron = none;
        let mut near = 0;
        for i in 0..PROVINCE_TILES as u8 {
            let d = tile_offset(i).unwrap().distance(Hex::new(0, 0));
            if d == 1 {
                hilly[i as usize] = Terrain::Hills;
                near += 1;
            }
            if d == 3 {
                hilly[i as usize] = Terrain::Mountain; // outside the radius
            }
        }
        iron[tile_index(Hex::new(1, 1)).unwrap() as usize] = Some(TileResource::Iron);
        assert_eq!(near, 6);
        assert_eq!(
            terrain_ore_per_hour(&hilly, &iron, centre),
            Some((ORE_BASE_PER_HOUR + 6 * ORE_PER_HILLS + ORE_PER_IRON) * MILLI)
        );
        let all = [Terrain::Mountain; PROVINCE_TILES];
        assert_eq!(
            terrain_ore_per_hour(&all, &none, centre),
            Some((ORE_BASE_PER_HOUR + ORE_TERRAIN_MAX) * MILLI)
        );
        assert_eq!(terrain_ore_per_hour(&plains, &none, 61), None);
    }

    #[test]
    fn tables_are_stable() {
        let mut a = alloc::vec::Vec::new();
        let mut b = alloc::vec::Vec::new();
        write_tables(&mut a);
        write_tables(&mut b);
        assert_eq!(a, b);
        assert_eq!(&a[..2], &ARMS_VERSION.to_le_bytes());
        assert_eq!(a[2], 4);
    }
}
