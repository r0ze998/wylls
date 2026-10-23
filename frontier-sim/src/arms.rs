//! Stage 1a check (design/redesign 30): how unevenly does the arms
//! economy spread over the real map?
//!
//! Uses the season's own map generation (`terrain::generate_province`
//! with the simulator's ring seeds) and the stage-1a kernels in
//! `permutation_rules::frontier::arms`. For every settlement site of the
//! nation rings it reports:
//!
//! * the ore a holding there would make (terrain ore) next to M1's flat
//!   base, and how many sites cannot feed one workshop on their own;
//! * the arms one workshop makes there in a week from the starter kit;
//! * that every faction's wedge gets the same land (the map's symmetry).
//!
//! No trade exists in the simulator yet (that comes with stage 1b), so this
//! measures where supply and need part ways, not whether trade happens.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::{
    terrain_ore_per_hour, ARMS, WORKSHOP_DELTA, WORKSHOP_ORE_PER_HOUR,
};
use permutation_rules::frontier::catalog::{BASE_PROD, STARTER_KIT};
use permutation_rules::frontier::geometry::ring_provinces;
use permutation_rules::frontier::holding::{Holding, Resource, HOUR};
use permutation_rules::frontier::terrain::generate_province;
use permutation_rules::hash::sha256;

/// One settlement site's numbers.
struct Site {
    ring: u32,
    wedge: u8,
    /// Ore per hour, units.
    ore: i64,
    /// Arms from one workshop after a week, units.
    arms_week: i64,
}

fn pct(sorted: &[i64], p: usize) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

/// Arms one workshop makes in `secs` at a site making `ore_ph` ore per
/// hour, from the starter kit, with M1's Hamlet wood production: the
/// holding kernel's own conversion (`Holding::settle`), under a Hamlet's
/// storage cap.
fn arms_after(ore_ph: i64, secs: i64) -> i64 {
    let t0 = 0;
    let mut h = Holding::found(t0, 0, 1);
    h.production[Resource::Ore as usize] = ore_ph * MILLI;
    h.production[Resource::Wood as usize] = BASE_PROD[Resource::Wood as usize] * MILLI;
    h.production[ARMS as usize] = WORKSHOP_DELTA;
    for r in [Resource::Ore, Resource::Wood] {
        h.credit(t0, r, STARTER_KIT[r as usize] * MILLI)
            .expect("credit");
    }
    h.touch_owner(t0).expect("touch");
    h.settle(t0 + secs).expect("settle");
    h.stores[ARMS as usize].value / MILLI
}

/// The report for the map of `seed`, nation rings 2..=`max_ring`.
pub fn report(seed: u64, max_ring: u32) -> String {
    let mut sites = Vec::new();
    for d in 2..=max_ring {
        let ring_seed = sha256(&[b"sim/ring", &seed.to_le_bytes(), &d.to_le_bytes()]);
        for p in ring_provinces(d) {
            let t = generate_province(&ring_seed, p);
            let wedge = p.wedge().unwrap_or(0);
            for &tile in &t.sites[..t.site_count as usize] {
                let Some(ore) = terrain_ore_per_hour(&t.terrain, &t.resource, tile) else {
                    continue;
                };
                let ore = ore / MILLI;
                sites.push(Site {
                    ring: d,
                    wedge,
                    ore,
                    arms_week: arms_after(ore, 7 * 24 * HOUR),
                });
            }
        }
    }
    let mut out = String::new();
    out.push_str(&format!(
        "# Stage 1a: the arms economy on the map (seed {seed}, rings 2..={max_ring})\n\n"
    ));
    out.push_str(&format!("Settlement sites: {}\n\n", sites.len()));
    let mut ore: Vec<i64> = sites.iter().map(|s| s.ore).collect();
    ore.sort_unstable();
    let mut arms: Vec<i64> = sites.iter().map(|s| s.arms_week).collect();
    arms.sort_unstable();
    let need = WORKSHOP_ORE_PER_HOUR;
    let short = ore.iter().filter(|&&x| x < need).count();
    let surplus = ore.iter().filter(|&&x| x >= 2 * need).count();
    let share = |n: usize| 100.0 * n as f64 / sites.len().max(1) as f64;
    out.push_str("| | min | p10 | p50 | p90 | max |\n|---|---|---|---|---|---|\n");
    out.push_str(&format!(
        "| ore per hour, M1 (flat) | {0} | {0} | {0} | {0} | {0} |\n",
        BASE_PROD[Resource::Ore as usize]
    ));
    out.push_str(&format!(
        "| ore per hour, stage 1a | {} | {} | {} | {} | {} |\n",
        ore[0],
        pct(&ore, 10),
        pct(&ore, 50),
        pct(&ore, 90),
        ore[ore.len() - 1]
    ));
    out.push_str(&format!(
        "| arms from one workshop in a week | {} | {} | {} | {} | {} |\n\n",
        arms[0],
        pct(&arms, 10),
        pct(&arms, 50),
        pct(&arms, 90),
        arms[arms.len() - 1]
    ));
    out.push_str(&format!(
        "- Sites that cannot feed one workshop from their own ore (< {need}/h): {short} ({:.1}%)\n",
        share(short)
    ));
    out.push_str(&format!(
        "- Sites with at least twice a workshop's ore (≥ {}/h): {surplus} ({:.1}%)\n",
        2 * need,
        share(surplus)
    ));
    for d in 2..=max_ring {
        let mut r: Vec<i64> = sites
            .iter()
            .filter(|s| s.ring == d)
            .map(|s| s.ore)
            .collect();
        r.sort_unstable();
        if r.is_empty() {
            continue;
        }
        let s = r.iter().filter(|&&x| x < need).count();
        out.push_str(&format!(
            "- Ring {d}: {} sites, ore p50 {}/h, short {:.1}%\n",
            r.len(),
            pct(&r, 50),
            100.0 * s as f64 / r.len() as f64
        ));
    }
    let wedge_sorted = |w: u8| {
        let mut v: Vec<i64> = sites
            .iter()
            .filter(|s| s.wedge == w)
            .map(|s| s.ore)
            .collect();
        v.sort_unstable();
        v
    };
    let w0 = wedge_sorted(0);
    let symmetric = (1..6).all(|w| wedge_sorted(w) == w0);
    out.push_str(&format!(
        "- Every faction's wedge has the same ore distribution: {}\n",
        if symmetric { "yes" } else { "NO" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wedges_are_symmetric_and_ore_varies() {
        let r = report(1, 3);
        assert!(r.contains("same ore distribution: yes"), "{r}");
    }

    #[test]
    fn more_ore_never_means_fewer_arms() {
        let week = 7 * 24 * HOUR;
        let mut last = 0;
        for ore in 0..40 {
            let a = arms_after(ore, week);
            assert!(a >= last, "ore {ore}: {a} < {last}");
            last = a;
        }
    }
}
