//! Stage 1b check (design/redesign 30, `S1-1B-CONTRACT.md` §7): on the
//! real map, does the arms economy give holdings a reason to trade, and
//! what does a caravan cost?
//!
//! The simulator's players move on an abstract graph, not hexes, so it
//! does not play caravans agent by agent (the bots do, stage 1f). This
//! report measures the *structure* the agents will face, with the program's
//! own kernels on the season's own map (`terrain::generate_province` under
//! the simulator's ring seeds, the Province masks as `OpenProvince` writes
//! them):
//!
//! * **Dependence.** A holding that runs `workshops` workshops needs
//!   `workshops × WORKSHOP_ORE_PER_HOUR` ore; its terrain ore
//!   (`arms::terrain_ore_per_hour`) is short or in surplus.
//! * **Reach.** For each short holding, the fastest supplier of its own
//!   faction's wedge with a surplus, by `caravan::fastest_path` and
//!   `caravan::walk` (32 steps and 4 provinces at most): reachable or not,
//!   the trip's minutes and its exposure (the bell starts it stands on,
//!   `caravan::schedule`: each one a clash it can be raided in).
//! * **Exchange.** Suppliers' surpluses matched greedily to the nearest
//!   short holdings (fastest trips first): the share of the shortfall a
//!   caravan network could cover and the arms per week it adds.
//!
//! Domestic trade only (a faction's own wedge): sends to another player
//! need the wallet and cross-faction caravans meet the clash; the report
//! is the lower bound of the incentive, not of the danger.

use std::collections::BTreeMap;

use permutation_rules::fixed::{BPS_ONE, MILLI};
use permutation_rules::frontier::arms::{terrain_ore_per_hour, ORE_PER_ARM, WORKSHOP_ORE_PER_HOUR};
use permutation_rules::frontier::caravan::{self as kc, Land};
use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord};
use permutation_rules::frontier::terrain::generate_province;
use permutation_rules::hash::sha256;

/// Suppliers tried per short holding (the nearest by hex distance).
const CANDIDATES: usize = 6;

struct Site {
    pc: ProvinceCoord,
    tile: u8,
    wedge: u8,
    /// Ore per hour, units.
    ore: i64,
}

/// One short holding's best supplier: its index, the trip's seconds and
/// exposure (bell starts on the road).
struct Trip {
    supplier: usize,
    secs: u32,
    exposure: u32,
}

fn pct(sorted: &[u32], p: usize) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

/// The map of `seed`, nation rings 2..=`max_ring`: its sites and lands.
fn map(seed: u64, max_ring: u32) -> (Vec<Site>, BTreeMap<(i32, i32), Land>) {
    let mut sites = Vec::new();
    let mut lands = BTreeMap::new();
    for d in 2..=max_ring {
        let ring_seed = sha256(&[b"sim/ring", &seed.to_le_bytes(), &d.to_le_bytes()]);
        for pc in ring_provinces(d) {
            let t = generate_province(&ring_seed, pc);
            let (mut passable, mut rough) = (0u64, 0u64);
            for (i, tr) in t.terrain.iter().enumerate() {
                if tr.is_passable() {
                    passable |= 1 << i;
                }
                if tr.info().defense_bps < BPS_ONE {
                    rough |= 1 << i;
                }
            }
            lands.insert(
                (pc.p, pc.q),
                Land {
                    at: pc,
                    passable,
                    rough,
                    road: 0,
                },
            );
            for &tile in &t.sites[..t.site_count as usize] {
                let Some(ore) = terrain_ore_per_hour(&t.terrain, &t.resource, tile) else {
                    continue;
                };
                sites.push(Site {
                    pc,
                    tile,
                    wedge: pc.wedge().unwrap_or(0),
                    ore: ore / MILLI,
                });
            }
        }
    }
    (sites, lands)
}

/// The fastest walk from `a` to `b` over the lands around them, its
/// seconds (doctrine ×1.0) and its exposure for a departure 5 minutes into
/// a bell.
fn trip(a: &Site, b: &Site, lands: &BTreeMap<(i32, i32), Land>) -> Option<(u32, u32)> {
    let near: Vec<Land> = lands
        .values()
        .filter(|l| l.at.distance(a.pc) <= 2 || l.at.distance(b.pc) <= 2)
        .copied()
        .collect();
    let (dirs, order) = kc::fastest_path((a.pc, a.tile), (b.pc, b.tile), &near)?;
    if dirs.is_empty() {
        return Some((0, 0));
    }
    let ls: Vec<Land> = order
        .iter()
        .map(|pc| {
            *near
                .iter()
                .find(|l| l.at == *pc)
                .expect("a land of the path")
        })
        .collect();
    let walked = kc::walk(
        (a.pc, a.tile),
        &kc::pack(&dirs)?,
        dirs.len() as u8,
        &ls,
        BPS_ONE,
    )
    .ok()?;
    let genesis = 0i64;
    let runs = kc::schedule(genesis, 300, (a.pc, a.tile), &walked).ok()?;
    let exposure = runs.iter().map(|r| r.tiles.len() as u32).sum();
    Some((kc::travel_secs(&walked), exposure))
}

/// The report for the map of `seed`, rings 2..=`max_ring`, holdings
/// running `workshops` workshops each.
pub fn report(seed: u64, max_ring: u32, workshops: i64) -> String {
    let (sites, lands) = map(seed, max_ring);
    let need = workshops * WORKSHOP_ORE_PER_HOUR;
    let short: Vec<usize> = (0..sites.len()).filter(|&i| sites[i].ore < need).collect();
    let rich: Vec<usize> = (0..sites.len()).filter(|&i| sites[i].ore > need).collect();
    // Each short holding's fastest reachable supplier of its wedge.
    let mut trips: Vec<(usize, Trip)> = Vec::new();
    let mut unreachable = 0usize;
    for &j in &short {
        let s = &sites[j];
        let mut cands: Vec<usize> = rich
            .iter()
            .copied()
            .filter(|&i| sites[i].wedge == s.wedge)
            .collect();
        let hex = |i: usize| {
            let h = sites[i].pc.tile(sites[i].tile).expect("tile");
            h.distance(s.pc.tile(s.tile).expect("tile"))
        };
        cands.sort_by_key(|&i| (hex(i), i));
        let best = cands
            .iter()
            .take(CANDIDATES)
            .filter_map(|&i| {
                trip(&sites[i], s, &lands).map(|(secs, exposure)| Trip {
                    supplier: i,
                    secs,
                    exposure,
                })
            })
            .min_by_key(|t| (t.secs, t.supplier));
        match best {
            Some(t) => trips.push((j, t)),
            None => unreachable += 1,
        }
    }
    // Greedy exchange: the fastest trips first, each supplier's surplus
    // shared until it runs out.
    let mut left: BTreeMap<usize, i64> = rich.iter().map(|&i| (i, sites[i].ore - need)).collect();
    let mut order: Vec<&(usize, Trip)> = trips.iter().collect();
    order.sort_by_key(|(j, t)| (t.secs, *j));
    let (mut covered, mut shortfall) = (0i64, 0i64);
    let mut fully = 0usize;
    for &j in &short {
        shortfall += need - sites[j].ore;
    }
    for (j, t) in order {
        let want = need - sites[*j].ore;
        let have = left.get_mut(&t.supplier).expect("a supplier");
        let got = want.min(*have);
        *have -= got;
        covered += got;
        if got == want {
            fully += 1;
        }
    }
    let mut mins: Vec<u32> = trips.iter().map(|(_, t)| t.secs / 60).collect();
    mins.sort_unstable();
    let mut exp: Vec<u32> = trips.iter().map(|(_, t)| t.exposure).collect();
    exp.sort_unstable();
    let share = |n: usize, of: usize| 100.0 * n as f64 / of.max(1) as f64;
    let week = 7 * 24;
    let mut out = String::new();
    out.push_str(&format!(
        "# Stage 1b: trade on the map (seed {seed}, rings 2..={max_ring}, {workshops} workshops a holding)\n\n"
    ));
    out.push_str(&format!(
        "Settlement sites: {}; a holding needs {need} ore/h for {workshops} workshops.\n\n",
        sites.len()
    ));
    out.push_str(&format!(
        "- **Dependence:** {} short of ore ({:.1}%), {} with a surplus ({:.1}%).\n",
        short.len(),
        share(short.len(), sites.len()),
        rich.len(),
        share(rich.len(), sites.len())
    ));
    out.push_str(&format!(
        "- **Reach:** {} of the short holdings have a supplier of their wedge within a caravan's walk ({:.1}%); {unreachable} have none within 32 steps and 4 provinces.\n",
        trips.len(),
        share(trips.len(), short.len()),
    ));
    out.push_str(&format!(
        "- **The trip:** p50 {} min, p90 {} min; exposure p50 {} bell starts, p90 {} (each a clash it can be raided in).\n",
        pct(&mins, 50),
        pct(&mins, 90),
        pct(&exp, 50),
        pct(&exp, 90)
    ));
    out.push_str(&format!(
        "- **Exchange:** the surpluses cover {:.1}% of the shortfall ({} of {} ore/h); {} short holdings ({:.1}%) fully supplied.\n",
        100.0 * covered as f64 / shortfall.max(1) as f64,
        covered,
        shortfall,
        fully,
        share(fully, short.len())
    ));
    out.push_str(&format!(
        "- **Arms:** trade adds {} arms a week over the map ({} per short holding on average).\n",
        covered / ORE_PER_ARM * week,
        if short.is_empty() {
            0
        } else {
            covered / ORE_PER_ARM * week / short.len() as i64
        }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The report runs on a small map and every trip it counts is a walk
    /// the program accepts (`trip` validates with `walk`).
    #[test]
    fn trade_report_runs() {
        let r = report(1, 2, 2);
        assert!(r.contains("Dependence"), "{r}");
        assert!(r.contains("Exchange"), "{r}");
    }

    /// A supplier and a holding in the same province, a few tiles apart: a
    /// short trip with some exposure.
    #[test]
    fn a_trip_in_one_province() {
        let (sites, lands) = map(1, 2);
        let (a, b) = sites
            .iter()
            .enumerate()
            .find_map(|(i, a)| {
                sites
                    .iter()
                    .skip(i + 1)
                    .find(|b| b.pc == a.pc)
                    .map(|b| (a, b))
            })
            .expect("two sites in one province");
        if let Some((secs, _)) = trip(a, b, &lands) {
            assert!(secs > 0);
        }
    }
}
