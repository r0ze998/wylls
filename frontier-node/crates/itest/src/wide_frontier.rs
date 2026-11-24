//! **TEST-ONLY map growth where nations go** in a local wide world (expansion-gameplay-1, owner t491u 2026-11-24:
//! nations should visibly spread across the map; design note `docs/design/expansion/01-reach-from-land.md`).
//!
//! The wide world's setup (`wide_land::grow`) opens a fixed strip of wide land (`PER_WEDGE` provinces in the middle of
//! each wedge on rings 129..129+`WIDE_RINGS`) and, before this duty, nothing ever opened after it: a nation could
//! never found or march anywhere else. On devnet the keeper's province duties open land on demand; play-local runs no
//! keeper crate. This duty is the local stand-in for the wide land: every bell it reads the program's wide provinces,
//! takes the **land some nation has gone to** — a wide province with a village (any site in the holding state) or a
//! keep taken at least once (`keep.changes > 0`, the same "won" the claim's reach witness reads,
//! `frontier_abi::world_index::reach`) — and opens the absent wide provinces within [`FRONTIER_RADIUS`] of it, nearest
//! first, at most [`OPENS_PER_BELL`] a bell and [`OPENS_MAX`] in a world, with the program's own permissionless
//! WideOpenProvince (0xD8: terrain, keep and site mirror are the program's, funded from the wedge's province fund).
//! Only rings whose wide seed the setup consumed can open (`wide_land::WIDE_SEED_RINGS`).
//!
//! The genesis strip itself is not "gone to": land opens only after a village or a capture, so the map grows outward
//! from where play actually happens. A quiet wide province costs the world nothing per bell (the wide crank drives only
//! provinces with hosts, arrivals or marches, `wide_depart`). Nothing is written directly. Every line printed says
//! `test_only: true`.
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::Signer;
use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::world_index::land::{self as wl, WideProvince, WideRingSeed, FIRST_WIDE_RING};
use frontier_abi::world_index::WideCoord;
use localnet::server::{lock, Shared};
use localnet::Chain;
use serde_json::{json, Value};

pub const FRONTIER_SCHEMA: &str = "frontier-localnet-wide-frontier-v1";
/// Absent wide provinces at most this many provinces from a nation's land are opened (one less than the claim's
/// `outpost_range` 3: the frontier moves one village at a time, a claim can still reach the opened edge).
pub const FRONTIER_RADIUS: u128 = 2;
/// Openings sent per bell at most.
pub const OPENS_PER_BELL: usize = 3;
/// Openings per world at most (the wedge funds pay each province's rent).
pub const OPENS_MAX: usize = 300;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

/// Whether the province bytes `d` are land some nation has gone to: a site in the holding state, or a keep taken.
pub fn gone_to(d: &[u8]) -> bool {
    let n = (d.get(PV::SITE_COUNT).copied().unwrap_or(0) as usize).min(PV::SITES_N);
    let village = (0..n).any(|s| d.get(PV::site(s) + SM::STATE) == Some(&SM::STATE_HOLDING));
    let won = frontier_abi::conquest_model::read_keep(d)
        .ok()
        .flatten()
        .is_some_and(|k| k.changes > 0);
    village || won
}

/// Pure: the provinces to open, nearest to `land` first (then by coordinate), each once: absent from `opened`, wide,
/// on a ring at most `max_ring`, within `radius` of some province of `land`.
pub fn frontier_plan(
    land: &[WideCoord],
    opened: &BTreeSet<WideCoord>,
    max_ring: u64,
    radius: u128,
) -> Vec<WideCoord> {
    let r = radius as i64;
    let mut best: BTreeMap<WideCoord, u128> = BTreeMap::new();
    for l in land {
        for dp in -r..=r {
            for dq in -r..=r {
                if (dp + dq).abs() > r {
                    continue;
                }
                let Ok(c) = WideCoord::checked(l.p() + dp, l.q() + dq) else {
                    continue;
                };
                if c.ring() < FIRST_WIDE_RING || c.ring() > max_ring || opened.contains(&c) {
                    continue;
                }
                let d = l.distance(c);
                best.entry(c).and_modify(|b| *b = (*b).min(d)).or_insert(d);
            }
        }
    }
    let mut v: Vec<(u128, WideCoord)> = best.into_iter().map(|(c, d)| (d, c)).collect();
    v.sort();
    v.into_iter().map(|(_, c)| c).collect()
}

/// The program's wide provinces of this season: `(opened, land gone to)`.
fn scan(c: &Chain, a: &Addresses) -> (BTreeSet<WideCoord>, Vec<WideCoord>) {
    let ctx = ctx_of(a);
    let mut opened = BTreeSet::new();
    let mut land = vec![];
    for (k, acc) in c.program_accounts(&a.program) {
        let Ok(p) = WideProvince::read(&acc.data) else {
            continue;
        };
        if p.season_id != a.season_id || k.to_bytes() != wl::province_address(&ctx, p.coord) {
            continue;
        }
        opened.insert(p.coord);
        if gone_to(&acc.data) {
            land.push(p.coord);
        }
    }
    (opened, land)
}

/// The outermost wide ring whose seed is consumed (seeded), from 129 upward; `None` before 129 is.
fn max_seeded_ring(c: &Chain, a: &Addresses) -> Option<u64> {
    let ctx = ctx_of(a);
    let mut last = None;
    for ring in FIRST_WIDE_RING..FIRST_WIDE_RING + 64 {
        let k = fclient::Address::new_from_array(wl::ring_seed_address(&ctx, ring));
        let seeded = c
            .account(&k)
            .filter(|acc| acc.owner == a.program)
            .and_then(|acc| WideRingSeed::read(&acc.data).ok())
            .is_some_and(|s| s.terrain_seed().is_some());
        if !seeded {
            break;
        }
        last = Some(ring);
    }
    last
}

/// The duty (module doc), until `stop`. Prints one JSON line per opening sent and one per bell it planned any.
pub async fn run(
    state: Shared,
    a: Addresses,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    let payer = crate::keeper_loop::fund_fresh(&state, &mut stop).await?;
    out(
        json!({"schema": FRONTIER_SCHEMA, "wide_frontier_step": "duty", "test_only": true,
        "radius": FRONTIER_RADIUS as u64, "per_bell": OPENS_PER_BELL, "max": OPENS_MAX}),
    );
    let mut last_bell = None;
    let mut sent = 0usize;
    let mut refused: BTreeSet<WideCoord> = BTreeSet::new();
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let (bell, plan, max_ring) = {
            let c = lock(&state);
            let clock = crate::local_keeper::season_clock(&c, &a)?;
            let bell = clock.bell_at(c.unix_timestamp()).unwrap_or(0);
            if last_bell == Some(bell) || sent >= OPENS_MAX {
                (bell, vec![], 0)
            } else {
                let max_ring = max_seeded_ring(&c, &a).unwrap_or(0);
                let (opened, land) = scan(&c, &a);
                let plan: Vec<WideCoord> = frontier_plan(&land, &opened, max_ring, FRONTIER_RADIUS)
                    .into_iter()
                    .filter(|c| !refused.contains(c))
                    .take(OPENS_PER_BELL.min(OPENS_MAX - sent))
                    .collect();
                (bell, plan, max_ring)
            }
        };
        if last_bell != Some(bell) {
            last_bell = Some(bell);
            if !plan.is_empty() {
                out(
                    json!({"schema": FRONTIER_SCHEMA, "wide_frontier_step": "plan", "test_only": true, "bell": bell,
                    "max_ring": max_ring, "open": plan.iter().map(|c| json!({"p": c.p().to_string(), "q": c.q().to_string()})).collect::<Vec<_>>()}),
                );
            }
            for coord in plan {
                let what = format!("WideOpenProvince({}, {})", coord.p(), coord.q());
                let ix = crate::wide_land::open_ix(&a, payer.pubkey(), coord)?;
                match crate::keeper_loop::submit_and_wait(
                    &state,
                    &payer,
                    ix,
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await
                {
                    crate::keeper_loop::Sent::Landed(sig) => {
                        sent += 1;
                        out(
                            json!({"schema": FRONTIER_SCHEMA, "wide_frontier_step": "opened", "test_only": true,
                            "p": coord.p().to_string(), "q": coord.q().to_string(), "ring": coord.ring() as u64,
                            "bell": bell, "signature": sig, "total": sent}),
                        );
                    }
                    other => {
                        refused.insert(coord);
                        out(
                            json!({"schema": FRONTIER_SCHEMA, "wide_frontier_step": "failed", "test_only": true,
                            "what": what, "why": format!("{other:?}"), "bell": bell}),
                        );
                    }
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
            _ = stop.changed() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    #[test]
    fn nothing_opens_until_a_nation_goes_somewhere() {
        let opened: BTreeSet<WideCoord> = [c(129, 0), c(130, 0)].into();
        assert!(frontier_plan(&[], &opened, 134, 2).is_empty());
    }

    #[test]
    fn the_plan_is_the_absent_land_near_the_nation_nearest_first() {
        let land = c(130, -10);
        let opened: BTreeSet<WideCoord> = [land, c(131, -10)].into();
        let plan = frontier_plan(&[land], &opened, 134, 2);
        assert!(
            !plan.contains(&land) && !plan.contains(&c(131, -10)),
            "opened ones are not reopened"
        );
        assert!(plan
            .iter()
            .all(|x| x.ring() >= FIRST_WIDE_RING && land.distance(*x) <= 2));
        let ds: Vec<u128> = plan.iter().map(|x| land.distance(*x)).collect();
        assert!(ds.windows(2).all(|w| w[0] <= w[1]), "nearest first: {ds:?}");
        assert_eq!(
            ds.iter().filter(|d| **d == 1).count(),
            5,
            "six neighbours, one opened"
        );
        let disk: Vec<_> = plan.iter().filter(|x| x.ring() < FIRST_WIDE_RING).collect();
        assert!(disk.is_empty(), "never the disk");
    }

    #[test]
    fn unseeded_rings_never_open() {
        let land = c(131, -5);
        let plan = frontier_plan(&[land], &BTreeSet::new(), 131, 2);
        assert!(plan.iter().all(|x| x.ring() <= 131));
        assert!(plan.iter().any(|x| x.ring() == 131 && *x != land) || plan.contains(&land));
    }

    #[test]
    fn two_lands_share_their_frontier_once() {
        let (a, b) = (c(130, -10), c(130, -8));
        let plan = frontier_plan(&[a, b], &BTreeSet::new(), 134, 2);
        let set: BTreeSet<_> = plan.iter().copied().collect();
        assert_eq!(set.len(), plan.len(), "each province once");
        assert!(set.contains(&c(130, -9)));
    }
}
