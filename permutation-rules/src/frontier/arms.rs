//! Stage 1 (S1) of the redesign: the arms economy (design/redesign 18,
//! 30 §2 1a). Bound into the S1 ruleset hash (`super::ruleset_hash_input_v3`,
//! `KERNEL_VERSIONS_V3` entry `arms`); the M1 and MC hashes, tables and
//! outcomes are unchanged.
//!
//! * **Arms** take the Horses store slot ([`ARMS`] = `Resource::Horses`,
//!   index 4): Horses has no production, cost or effect in M1 or MC, and is
//!   movable (not `pledge_only`), so no layout changes.
//! * **Workshop** (build item [`ITEM_WORKSHOP`]): each copy adds
//!   [`WORKSHOP_ARMS_PER_HOUR`] to the holding's arms production. The
//!   holding converts ore and wood into arms in proportion to that
//!   production while both inputs last (`Holding::settle`, the conversion
//!   rule in `holding.rs`): [`ORE_PER_ARM`] ore and [`WOOD_PER_ARM`] wood per
//!   arm. When an input runs dry the workshops run at the share its
//!   production sustains ([`plan_conversion`]).
//! * **Strong units** (Pikeman, Crossbowman, Knight; redesign 30, J3) also
//!   cost arms to train ([`train_v3`]).
//! * **Sieges** consume arms when declared ([`SIEGE_ARMS`]; stage 1e).
//! * **Ore from terrain:** a holding's base ore depends on the hills,
//!   mountains and iron around it, within its own province
//!   ([`terrain_ore_per_hour`]; redesign 30, §1-4), stored with the holding
//!   at founding and scaled by the tier bonus like every base production
//!   ([`base_production`]).
//!
//! Every number marked [phase 6] is a placeholder until the economy
//! phase measures it.

use crate::fixed::MILLI;
use crate::hex::Hex;
use crate::map::{Terrain, TileResource};

use crate::frontier::catalog::{self, train_v2, Cost};
use crate::frontier::doctrine::Doctrine;
use crate::frontier::geometry::{tile_index, tile_offset, PROVINCE_TILES};
use crate::frontier::holding::{Effect, Resource, Tier, RESOURCES};

/// Kernel version of this module (`KERNEL_VERSIONS_V3`).
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
/// Inputs per arm: the per-hour figures above in lowest terms. The holding
/// derives its workshops' input use from its arms production with these.
pub const ORE_PER_ARM: i64 = WORKSHOP_ORE_PER_HOUR / WORKSHOP_ARMS_PER_HOUR;
pub const WOOD_PER_ARM: i64 = WORKSHOP_WOOD_PER_HOUR / WORKSHOP_ARMS_PER_HOUR;
const _: () = assert!(
    ORE_PER_ARM * WORKSHOP_ARMS_PER_HOUR == WORKSHOP_ORE_PER_HOUR
        && WOOD_PER_ARM * WORKSHOP_ARMS_PER_HOUR == WORKSHOP_WOOD_PER_HOUR
);
/// Build item id of the workshop under the S1 rules. Items 0..=6 are the
/// M1 catalog's, 7 is the program's tier-up (`catalog::ITEM_COUNT`).
pub const ITEM_WORKSHOP: u8 = 8;
/// Base cost (units) of the first workshop copy [phase 6]; later copies
/// follow `holding::duplicate_cost` like every building.
pub const WORKSHOP_COST: [i64; RESOURCES] = [60, 120, 80, 40, 0, 0, 0, 0];

/// The arms production (milli-units per hour) one workshop copy adds.
pub const WORKSHOP_DELTA: i64 = WORKSHOP_ARMS_PER_HOUR * MILLI;

/// What build item `item` costs as the holding's `n`-th copy under the S1
/// rules, its effect and its build seconds: [`ITEM_WORKSHOP`] is
/// `duplicate_cost(WORKSHOP_COST, n)`, `Effect::Production { Arms,
/// WORKSHOP_DELTA }`, `catalog::build_secs(n)`; every other item is
/// `catalog::building`. `None` for an unknown item or `n` outside
/// `1..=catalog::MAX_COPIES`.
pub fn building(item: u8, n: u32, d: &Doctrine) -> Option<(Cost, Effect, u32)> {
    if item != ITEM_WORKSHOP {
        return catalog::building(item, n, d);
    }
    if n == 0 || n > catalog::MAX_COPIES {
        return None;
    }
    let mut c = [0; RESOURCES];
    for (r, v) in c.iter_mut().enumerate() {
        let base = WORKSHOP_COST[r];
        *v = if base == 0 {
            0
        } else {
            let units = crate::frontier::holding::duplicate_cost(base as u64, n)?;
            i64::try_from(units).ok()?.checked_mul(MILLI)?
        };
    }
    let secs = u32::try_from(catalog::build_secs(n)).ok()?;
    Some((
        c,
        Effect::Production {
            resource: ARMS,
            delta: WORKSHOP_DELTA,
        },
        secs,
    ))
}

/// Workshop copies a holding has built: its arms production over
/// [`WORKSHOP_DELTA`] (no base production makes arms, `catalog::BASE_PROD`).
pub fn workshops_built(production: &[i64; RESOURCES]) -> i64 {
    production[ARMS as usize].max(0) / WORKSHOP_DELTA
}

/// A holding's base production at tier `t` from its stored terrain ore:
/// [`base_production`] when `terrain_ore > 0` (an S1 holding; its terrain
/// ore is at least [`ORE_BASE_PER_HOUR`]), else the M1 and MC base
/// (`catalog::base_production`; their `TERRAIN_ORE` bytes are reserved
/// zeros). For readers that serve every rules version (verifier, agents).
pub fn holding_base_production(t: Tier, terrain_ore: i64) -> [i64; RESOURCES] {
    if terrain_ore > 0 {
        base_production(t, terrain_ore)
    } else {
        catalog::base_production(t)
    }
}

/// Base production per hour of a holding at tier `t` under the S1 rules,
/// milli-units: `catalog::base_production(t)` with the ore entry replaced
/// by the holding's terrain ore (`terrain_ore`, milli per hour, stored at
/// founding) under the same tier bonus.
pub fn base_production(t: Tier, terrain_ore: i64) -> [i64; RESOURCES] {
    let mut b = catalog::base_production(t);
    b[Resource::Ore as usize] = terrain_ore.max(0) * (100 + catalog::tier_bonus_pct(t)) / 100;
    b
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
    ore_around(tile, |i| {
        let t = match terrain[i] {
            Terrain::Hills => ORE_PER_HILLS,
            Terrain::Mountain => ORE_PER_MOUNTAIN,
            _ => 0,
        };
        t + if resource[i] == Some(TileResource::Iron) {
            ORE_PER_IRON
        } else {
            0
        }
    })
}

/// [`terrain_ore_per_hour`] over a Province's stored terrain block: the
/// terrain byte is `Terrain as u8` (declaration order), the resource byte
/// 0 for none, else `1 + TileResource as u8` (the program's pinned
/// encoding, `proc/map.rs::encode_terrain`). Unknown bytes add nothing.
pub fn terrain_ore_per_hour_bytes(
    terrain: &[u8; PROVINCE_TILES],
    resource: &[u8; PROVINCE_TILES],
    tile: u8,
) -> Option<i64> {
    const HILLS: u8 = Terrain::Hills as u8;
    const MOUNTAIN: u8 = Terrain::Mountain as u8;
    const IRON: u8 = 1 + TileResource::Iron as u8;
    ore_around(tile, |i| {
        let t = match terrain[i] {
            HILLS => ORE_PER_HILLS,
            MOUNTAIN => ORE_PER_MOUNTAIN,
            _ => 0,
        };
        t + if resource[i] == IRON { ORE_PER_IRON } else { 0 }
    })
}

fn ore_around(tile: u8, ore_of: impl Fn(usize) -> i64) -> Option<i64> {
    let at = tile_offset(tile)?;
    let mut extra = 0i64;
    for q in -(ORE_RADIUS as i32)..=(ORE_RADIUS as i32) {
        for r in -(ORE_RADIUS as i32)..=(ORE_RADIUS as i32) {
            let o = Hex::new(at.q + q, at.r + r);
            if o == at || o.distance(at) > ORE_RADIUS {
                continue;
            }
            let Some(i) = tile_index(o) else { continue };
            extra += ore_of(i as usize);
        }
    }
    Some((ORE_BASE_PER_HOUR + extra.min(ORE_TERRAIN_MAX)) * MILLI)
}

// ====================================================================
// Tables for the S1 ruleset hash
// ====================================================================

/// Canonical little-endian bytes of every table here, for the S1 ruleset
/// hash (`super::ruleset_hash_input_v3`). Order pinned; append only.
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
    out.push(ITEM_WORKSHOP);
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::frontier::doctrine::NEUTRAL;
    use crate::frontier::holding::{Holding, DAY, HOUR};

    const T0: i64 = 1_000_000;

    /// A founded holding with `ore` and `wood` in stock, making `ore_ph` and
    /// `wood_ph` (units per hour) of them and nothing else, and `k`
    /// workshops at work from `T0`.
    fn converting(ore: i64, wood: i64, ore_ph: i64, wood_ph: i64, k: i64) -> Holding {
        let mut h = Holding::found(T0, 0, 1);
        h.production[Resource::Ore as usize] = ore_ph * MILLI;
        h.production[Resource::Wood as usize] = wood_ph * MILLI;
        h.production[ARMS as usize] = k * WORKSHOP_DELTA;
        h.credit(T0, Resource::Ore, ore * MILLI).unwrap();
        h.credit(T0, Resource::Wood, wood * MILLI).unwrap();
        h.touch_owner(T0).unwrap();
        h
    }

    fn stock(h: &Holding, r: Resource) -> i64 {
        h.stores[r as usize].value
    }

    #[test]
    fn arms_use_the_unused_horses_slot() {
        assert_eq!(ARMS as usize, 4);
        assert!(!ARMS.pledge_only());
        assert_eq!(catalog::BASE_PROD[ARMS as usize], 0);
        assert_eq!((ORE_PER_ARM, WOOD_PER_ARM), (2, 1));
    }

    #[test]
    fn plenty_of_input_runs_at_full_speed() {
        // 20 ore and 10 wood an hour feed one workshop (8 + 4) with room.
        let mut h = converting(100, 100, 20, 10, 1);
        h.settle(T0 + 10 * HOUR).unwrap();
        assert_eq!(stock(&h, ARMS), 40 * MILLI);
        assert_eq!(stock(&h, Resource::Ore), (100 + 120) * MILLI);
        assert_eq!(stock(&h, Resource::Wood), (100 + 60) * MILLI);
    }

    #[test]
    fn ore_runs_dry_then_production_limits_the_workshop() {
        // ore: 16 in stock, makes 2/h, uses 8/h → net −6/h → dry after
        // 16/6 h = 9,600 s. Then the workshop runs at 2/8 = 25%: 1 arm/h.
        let mut h = converting(16, 500, 2, 20, 1);
        let dry = T0 + 9_600;
        h.settle(dry + 10 * HOUR).unwrap();
        let before_dry = 4 * 9_600 * MILLI / HOUR;
        assert_eq!(stock(&h, ARMS), before_dry + 10 * MILLI);
        assert!(stock(&h, Resource::Ore) >= 0 && stock(&h, Resource::Ore) < MILLI);
        assert_eq!(h.stores[ARMS as usize].rate, MILLI);
        assert_eq!(h.stores[Resource::Ore as usize].rate, 0);
        assert_eq!(h.stores[Resource::Wood as usize].rate, 20 * MILLI - MILLI);
    }

    #[test]
    fn no_input_production_stops_the_workshop_at_zero() {
        let mut h = converting(7, 9, 0, 0, 3);
        h.settle(T0 + 10 * HOUR).unwrap();
        assert!(stock(&h, Resource::Ore) >= 0 && stock(&h, Resource::Wood) >= 0);
        assert_eq!(h.stores[ARMS as usize].rate, 0, "no inputs, no arms");
        // 7 ore at 2 per arm is the limit: at most 3.5 arms were made.
        assert!(stock(&h, ARMS) <= 3_500);
        assert!(stock(&h, ARMS) >= 3_400);
    }

    #[test]
    fn a_credit_restarts_a_limited_workshop() {
        let mut h = converting(8, 100, 0, 10, 1);
        h.settle(T0 + 2 * HOUR).unwrap();
        assert_eq!(h.stores[ARMS as usize].rate, 0);
        h.credit(T0 + 2 * HOUR, Resource::Ore, 80 * MILLI).unwrap();
        assert_eq!(h.stores[ARMS as usize].rate, 4 * MILLI);
        h.settle(T0 + 12 * HOUR).unwrap();
        // 4 arms from the first 8 ore, then 40 from the 80.
        assert_eq!(stock(&h, ARMS), 44 * MILLI);
    }

    #[test]
    fn settling_is_path_independent() {
        for (ore, wood, oph, wph, k) in [(30, 40, 3, 5, 2), (16, 500, 2, 20, 1), (0, 0, 9, 1, 2)] {
            let end = T0 + 9 * HOUR + 17;
            let mut once = converting(ore, wood, oph, wph, k);
            once.settle(end).unwrap();
            let mut steps = converting(ore, wood, oph, wph, k);
            let mut t = T0;
            while t < end {
                t = (t + 1_234).min(end);
                steps.settle(t).unwrap();
            }
            assert_eq!(once, steps);
        }
    }

    #[test]
    fn dormancy_halves_the_workshop_with_its_inputs() {
        let mut h = converting(100_000, 100_000, 0, 0, 1);
        let dorm = h.dormant_at();
        h.settle(dorm + DAY).unwrap();
        assert_eq!(h.stores[ARMS as usize].rate, 2 * MILLI);
        assert_eq!(h.stores[Resource::Ore as usize].rate, -4 * MILLI);
    }

    #[test]
    fn holdings_without_workshops_settle_as_before() {
        // No arms production: the rates are the plain net rates.
        let mut h = Holding::found(T0, 0, 1);
        h.production = catalog::base_production(Tier::Hamlet);
        h.credit(T0, Resource::Ore, 0).unwrap();
        h.touch_owner(T0).unwrap();
        for r in 0..RESOURCES {
            assert_eq!(h.stores[r].rate, h.production[r] - h.upkeep[r]);
        }
    }

    #[test]
    fn the_workshop_is_build_item_8() {
        let (c, e, secs) = building(ITEM_WORKSHOP, 1, &NEUTRAL).unwrap();
        assert_eq!(c[Resource::Wood as usize], 120 * MILLI);
        assert_eq!(c[ARMS as usize], 0);
        assert_eq!(
            e,
            Effect::Production {
                resource: ARMS,
                delta: WORKSHOP_DELTA
            }
        );
        assert_eq!(secs as i64, catalog::build_secs(1));
        assert!(building(ITEM_WORKSHOP, 0, &NEUTRAL).is_none());
        assert!(building(ITEM_WORKSHOP, catalog::MAX_COPIES + 1, &NEUTRAL).is_none());
        assert_eq!(building(0, 1, &NEUTRAL), catalog::building(0, 1, &NEUTRAL));
        let (c2, _, _) = building(ITEM_WORKSHOP, 2, &NEUTRAL).unwrap();
        assert!(c2[Resource::Wood as usize] > c[Resource::Wood as usize]);
        let mut p = [0; RESOURCES];
        p[ARMS as usize] = 3 * WORKSHOP_DELTA;
        assert_eq!(workshops_built(&p), 3);
    }

    #[test]
    fn base_ore_comes_from_terrain_with_the_tier_bonus() {
        let b = base_production(Tier::Hamlet, 10 * MILLI);
        assert_eq!(b[Resource::Ore as usize], 10 * MILLI);
        assert_eq!(
            b[Resource::Food as usize],
            catalog::base_production(Tier::Hamlet)[0]
        );
        let c = base_production(Tier::City, 10 * MILLI);
        assert_eq!(c[Resource::Ore as usize], 20 * MILLI);
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
    fn the_byte_form_matches() {
        use crate::frontier::geometry::ProvinceCoord;
        use crate::frontier::terrain::generate_province;
        let seed = crate::hash::sha256(&[b"arms-bytes"]);
        for p in [
            ProvinceCoord::new(1, 0),
            ProvinceCoord::new(-2, 1),
            ProvinceCoord::new(0, 3),
        ] {
            let t = generate_province(&seed, p);
            let tb: [u8; PROVINCE_TILES] = core::array::from_fn(|i| t.terrain[i] as u8);
            let rb: [u8; PROVINCE_TILES] =
                core::array::from_fn(|i| t.resource[i].map_or(0, |r| 1 + r as u8));
            for tile in 0..PROVINCE_TILES as u8 {
                assert_eq!(
                    terrain_ore_per_hour(&t.terrain, &t.resource, tile),
                    terrain_ore_per_hour_bytes(&tb, &rb, tile)
                );
            }
        }
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
