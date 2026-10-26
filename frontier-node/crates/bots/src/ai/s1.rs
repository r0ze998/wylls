//! The S1 candidates (redesign stage 1, plan 30 §1f): what an AI can do
//! with the caravans of an S1 season (program_version 4).
//!
//! - `ambush`: march the march host onto a tile of another nation's
//!   caravan road, arriving before the caravan stands there. A host that
//!   waits on the tile raids the caravan when it comes (1c: residents
//!   ambush; the caravan is a 0-troop garrison whose escort is whoever of
//!   its faction stands there).
//! - `escort`: the same onto the bot's own caravan's road, so the caravan
//!   has an escort when it passes.
//! - `caravan`: send a full store's surplus from the home holding to
//!   another of the bot's holdings that has room, along the fastest road
//!   (`caravan::fastest_path`, the walk every client agrees on).
//!
//! The roads come from the Provinces' caravan slots (`CaravanSlot::tiles`,
//! the tile the caravan stands on at each bell's start), which the
//! observation already holds. At most one march (ambush first) and one
//! caravan are offered. Nothing here runs outside an S1 season.

use fclient::decode::Holding;
use fclient::ix::v2::{PlaceRef, SendCaravanArgs};
use frontier_agents::obs::Observation;
use frontier_agents::policy::{self, Target};
use frontier_agents::rules::Rules;
use permutation_rules::frontier::caravan::{
    caravan_id, fastest_path, pack, Land, CARAVAN_FEE, RAID_NONE,
};
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::RESOURCES;
use serde_json::json;

use super::brain::{
    default_stance, href, march_candidate, march_host, plan_depart, resource_name, Action, Inputs,
    MarchKind, Offer,
};
use super::mindport::Candidate;
use fclient::abi::layout::entry as le;

/// A store this full (of its cap) sends its surplus.
pub const FULL_PERMILLE: i64 = 800;
/// The surplus is what is over this share of the cap; the receiver takes
/// it while it is under the same share.
pub const KEEP_PERMILLE: i64 = 500;
/// The most a caravan carries of one resource (whole units).
pub const MAX_CARGO: i64 = 1_000;
/// Resources a caravan carries: food, wood, stone, ore, arms, gold (science
/// and influence are not goods).
const GOODS: usize = 6;

/// Whether the observed season plays the S1 rules.
pub fn s1(obs: &Observation) -> bool {
    Rules::of_obs(obs) == Rules::S1
}

fn pdist(a: (i16, i16), b: (i16, i16)) -> u32 {
    ProvinceCoord::new(a.0 as i32, a.1 as i32).distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
}

/// The bot's citizen tag (0 without a Citizen).
fn own_tag(obs: &Observation) -> u64 {
    obs.me.citizen.as_ref().map_or(0, |(_, c)| c.citizen_tag)
}

/// Whether a caravan slot id is one of `tag`'s caravans (`caravan_id`
/// keeps the tag's low 47 bits and the sequence's low 16).
fn is_own(id: u64, tag: u64) -> bool {
    id == caravan_id(tag, id as u32 & 0xFFFF)
}

/// The last bell after `now` at which a caravan of the wanted side stands
/// on `t` (not raided), with its faction: another nation's for an ambush,
/// the bot's own for an escort.
pub fn caravan_on(
    obs: &Observation,
    t: &Target,
    faction: u8,
    kind: MarchKind,
) -> Option<(u32, u8)> {
    let pv = obs.province(t.p, t.q)?;
    let cq = pv.cq.as_ref()?;
    let now = obs.bell();
    let tag = own_tag(obs);
    cq.caravans
        .iter()
        .filter(|s| s.id != 0 && s.raid_off == RAID_NONE)
        .filter(|s| match kind {
            MarchKind::Ambush => s.faction != faction % 6 && !is_own(s.id, tag),
            MarchKind::Escort => is_own(s.id, tag),
            _ => false,
        })
        .flat_map(|s| {
            (0..s.n.min(8)).map(move |k| (s.first_bell + k as u32, s.tiles[k as usize], s.faction))
        })
        .filter(|&(b, tile, _)| b > now && tile == t.tile)
        .map(|(b, _, f)| (b, f))
        .max()
}

/// Road tiles to wait on, nearest first: each caravan's last stand in each
/// Province (the most time to get there), on a passable tile that is not a
/// village's site (a caravan there is sheltered, not raided).
fn road_targets(
    obs: &Observation,
    faction: u8,
    kind: MarchKind,
    from: (i16, i16),
) -> Vec<(Target, u32, u8)> {
    let tag = own_tag(obs);
    let now = obs.bell();
    let mut v = vec![];
    for (&(p, q), view) in &obs.provinces {
        let pv = &view.province;
        let Some(cq) = pv.cq.as_ref() else { continue };
        let sites = &pv.sites[..(pv.site_count as usize).min(12)];
        for s in &cq.caravans {
            if s.id == 0 || s.raid_off != RAID_NONE || s.n == 0 {
                continue;
            }
            let side = match kind {
                MarchKind::Ambush => s.faction != faction % 6 && !is_own(s.id, tag),
                MarchKind::Escort => is_own(s.id, tag),
                _ => false,
            };
            let k = s.n.min(8) as usize - 1;
            let (bell, tile) = (s.first_bell + k as u32, s.tiles[k]);
            if !side || bell <= now || sites.contains(&tile) || pv.passable_mask >> tile & 1 == 0 {
                continue;
            }
            v.push((
                pdist((p, q), from),
                Target {
                    p,
                    q,
                    tile,
                    why: kind.name(),
                },
                bell,
                s.faction,
            ));
        }
    }
    v.sort_by_key(|(d, t, b, _)| (*d, *b, t.p, t.q, t.tile));
    v.into_iter().map(|(_, t, b, f)| (t, b, f)).collect()
}

/// Other nations' troops on a tile (an escort the ambush would meet).
fn guards(obs: &Observation, t: &Target, faction: u8) -> u32 {
    obs.province(t.p, t.q).map_or(0, |pv| {
        pv.entries
            .iter()
            .filter(|e| {
                e.state == le::STATE_ROSTER
                    && e.tile == t.tile
                    && e.faction < 6
                    && e.faction != faction % 6
            })
            .map(|e| e.troops / super::brain::MILLI)
            .sum()
    })
}

/// At most one march at a caravan road: an ambush, else an escort.
fn road_offer(inp: &Inputs) -> Option<Offer> {
    let row = march_host(inp).ok()?;
    let obs = inp.obs;
    for kind in [MarchKind::Ambush, MarchKind::Escort] {
        for (t, by, nation) in road_targets(obs, inp.faction, kind, row.at) {
            let Some((plan, hexes, provs)) = plan_depart(
                obs,
                inp.h,
                row.at,
                &row.e,
                t,
                0,
                default_stance(inp.faction),
                0,
                inp.presets,
            ) else {
                continue;
            };
            if plan.plain.arrive_bell > by {
                continue;
            }
            let enemy = if kind == MarchKind::Ambush {
                guards(obs, &t, inp.faction)
            } else {
                0
            };
            let mut o =
                march_candidate(inp, row, t, kind, &plan, hexes, provs, enemy, Some(nation));
            o.cand.facts["caravan_bell"] = json!(by);
            o.cand.facts["waits_bells"] = json!(by - plan.plain.arrive_bell);
            return Some(o);
        }
    }
    None
}

/// The lands of the observed Provinces, for `fastest_path`.
pub fn lands(obs: &Observation) -> Vec<Land> {
    obs.provinces
        .values()
        .map(|v| Land {
            at: ProvinceCoord::new(v.province.p as i32, v.province.q as i32),
            passable: v.province.passable_mask,
            rough: v.province.rough_mask,
            road: v.province.road_mask,
        })
        .collect()
}

/// What a caravan from `from` to `to` would carry (whole units), or `None`:
/// each good `from` holds over [`FULL_PERMILLE`] of its cap sends what is
/// over [`KEEP_PERMILLE`], as much as `to` takes below that share, at most
/// [`MAX_CARGO`].
pub fn surplus(from: &Holding, to: &Holding, now: i64) -> Option<[u32; RESOURCES]> {
    let (a, b) = (policy::stores_at(from, now), policy::stores_at(to, now));
    let mut cargo = [0u32; RESOURCES];
    for r in 0..GOODS {
        let (cap_a, cap_b) = (from.stores[r].cap, to.stores[r].cap);
        if cap_a <= 0 || a[r] * 1000 < cap_a * FULL_PERMILLE {
            continue;
        }
        let give = a[r] - cap_a * KEEP_PERMILLE / 1000;
        let room = cap_b * KEEP_PERMILLE / 1000 - b[r];
        let units = (give.min(room) / 1000).clamp(0, MAX_CARGO);
        cargo[r] = units as u32;
    }
    cargo.iter().any(|&c| c > 0).then_some(cargo)
}

/// SendCaravan's arguments from the home holding to `to` with `cargo`, or
/// why not.
pub fn caravan_args(
    obs: &Observation,
    h: &Holding,
    to: &Holding,
    cargo: [u32; RESOURCES],
) -> Result<SendCaravanArgs, &'static str> {
    let seq = obs
        .me
        .citizen
        .as_ref()
        .and_then(|(_, c)| c.cq.as_ref())
        .map(|c| c.caravans)
        .ok_or("no citizen")?;
    let pc = |x: &Holding| ProvinceCoord::new(x.p as i32, x.q as i32);
    let (dirs, order) =
        fastest_path((pc(h), h.tile), (pc(to), to.tile), &lands(obs)).ok_or("no road")?;
    if dirs.is_empty() {
        return Err("no road");
    }
    Ok(SendCaravanArgs {
        seq,
        src: PlaceRef::Holding {
            h: href(h),
            gen: h.gen,
        },
        dst: PlaceRef::Holding {
            h: href(to),
            gen: to.gen,
        },
        steps: dirs.len() as u8,
        path: pack(&dirs).ok_or("road too long")?,
        cargo,
        fee: CARAVAN_FEE,
        provinces: order.iter().map(|c| (c.p as i16, c.q as i16)).collect(),
    })
}

/// At most one caravan: the first other live holding (in the me view's
/// order) the home's surplus can reach.
fn caravan_offer(inp: &Inputs) -> Option<Offer> {
    let obs = inp.obs;
    let h = inp.h;
    for (_, to) in &obs.me.holdings {
        if (to.p, to.q, to.site) == (h.p, h.q, h.site) || to.state != h.state {
            continue;
        }
        let Some(cargo) = surplus(h, to, obs.now) else {
            continue;
        };
        let Ok(args) = caravan_args(obs, h, to, cargo) else {
            continue;
        };
        let goods: Vec<String> = (0..GOODS)
            .filter(|&r| cargo[r] > 0)
            .map(|r| format!("{} {}", cargo[r], resource_name(r)))
            .collect();
        let facts = json!({
            "from": {"p": h.p, "q": h.q, "site": h.site},
            "to": {"p": to.p, "q": to.q, "site": to.site},
            "cargo": goods.join(", "),
            "steps": args.steps,
            "provinces": args.provinces.len(),
            "risk": "a caravan can be raided on the road; an escort on its tiles protects it",
        });
        return Some(Offer {
            cand: Candidate {
                id: String::new(),
                kind: "caravan".into(),
                label: format!(
                    "Send a caravan of {} to the village at ({}, {}), {} steps",
                    goods.join(", "),
                    to.p,
                    to.q,
                    args.steps
                ),
                facts,
                params: Default::default(),
                council: false,
                troops: None,
                entities: vec![format!("pq:{},{}", to.p, to.q)],
            },
            action: Action::Caravan {
                to: href(to),
                cargo,
            },
        });
    }
    None
}

/// The S1 candidates of one step (none outside an S1 season).
pub fn offer(inp: &Inputs) -> Vec<Offer> {
    if !s1(inp.obs) {
        return vec![];
    }
    road_offer(inp)
        .into_iter()
        .chain(caravan_offer(inp))
        .collect()
}

/// The holding a chosen caravan goes to, if it is still the bot's.
pub fn holding_of<'a>(obs: &'a Observation, to: &fclient::ix::HoldingRef) -> Option<&'a Holding> {
    obs.me
        .holdings
        .iter()
        .map(|(_, x)| x)
        .find(|x| (x.p, x.q, x.site) == (to.p, to.q, to.site))
}
