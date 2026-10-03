//! Conquest behaviours (MC contract v1.3 §8.6; unit CQ2-F): what one bot
//! does with its faction's plan, and the checks it runs locally before it
//! sends (§8.6: "`may_besiege` and the lead-host rank run locally on the
//! freshest state the bot has, re-checked at send time").
//!
//! | behaviour | here |
//! |---|---|
//! | take the keep, besiege, defend / relieve, occupy and hold (assault and siege groups, the defence plan, the hold rule) | the plan's [`Dispatch`]es → [`CqIntent::March`] |
//! | besiege: the lead host's owner sounds the horn | [`horns`] → [`CqIntent::DeclareSiege`] after [`declare_check`] |
//! | rally stay (A-26) | [`crate::campaign::rally_stays`] (the bot keeps the host on the hex) |
//! | retire | [`retirements`] → [`CqIntent::RetireHost`] (only the victim, K-27) |
//! | expand | [`expand`] → [`CqIntent::FileOutpost`] (the simulator's `mc_expand`, `holding::may_found_outpost`) |
//! | K2 affordability | [`train_cost`] (`catalog::train_v2` in an MC season) |
//!
//! [`declare_check`] is DeclareSiege's §3.4 checks 1–10 in their order on
//! a [`World`]; the conquest personas ([`crate::cqpersona`]) predict their
//! refusal codes with it.

use std::collections::BTreeMap;

use frontier_abi::error::FrontierError;
use frontier_abi::v2::error::{Code, CqError};
use permutation_rules::fixed::{Bps, Milli, MilliTroops, MILLI};
use permutation_rules::frontier::catalog::{self, Cost, SETTLER_COST};
use permutation_rules::frontier::holding::{
    duplicate_cost, may_found_outpost, OutpostCheck, OutpostRefusal, Tier, RESOURCES,
};
use permutation_rules::frontier::keep::lead_host;
use permutation_rules::frontier::laurel::{strength_weight, Tier as LTier};
use permutation_rules::units::UnitType;

use crate::campaign::{Board, Dispatch, HostState, Mission, Refusal, Target, World, NONE};
use crate::profile::Arch;
use crate::rng::Rng;

/// One conquest action a bot wants done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CqIntent {
    /// A sealed march of `troops` mustered from `src`'s garrison to
    /// `(P, Q)`'s `tile`, arriving no earlier than `arrive_min` (the
    /// campaign's muster bell; 0 = as early as possible), with the hold
    /// rule's retreat order when set.
    March {
        src: u32,
        troops: MilliTroops,
        to: (i16, i16),
        tile: u8,
        arrive_min: u32,
        retreat: Option<Bps>,
        mission: Mission,
    },
    /// 0xA0 from the hex: `host` (World id) is the lead host on the
    /// target `site` (P, Q, site).
    DeclareSiege {
        src: u32,
        host: u32,
        site: (i16, i16, u8),
        /// A faction first holding within 2 provinces (Frontier
        /// protection's proof), when one exists.
        nearby: Option<u32>,
    },
    /// 0xA3: up to 3 sites; `anchor` pays the settler cost.
    FileOutpost {
        anchor: u32,
        sites: Vec<(i16, i16, u8)>,
    },
    /// 0xA6 by the victim: its previous-generation host on a hex.
    RetireHost { host: u32 },
}

impl CqIntent {
    pub fn name(&self) -> &'static str {
        match self {
            CqIntent::March { mission, .. } => match mission {
                Mission::Keep(_) | Mission::KeepRally(_) => "keep_march",
                Mission::KeepDefend(_) | Mission::Defend(_) => "defend",
                Mission::Siege(_) => "siege_march",
                Mission::Rally(_) => "rally",
                _ => "march",
            },
            CqIntent::DeclareSiege { .. } => "declare_siege",
            CqIntent::FileOutpost { .. } => "file_outpost",
            CqIntent::RetireHost { .. } => "retire_host",
        }
    }
}

/// Site states of the raw mirror the [`World`] does not carry (a Seat's
/// reserved sites): `(P, Q, site) → state`.
pub type SiteStates = BTreeMap<(i16, i16, u8), u8>;

fn cq(e: CqError) -> Code {
    Code::Cq(e)
}
fn m1(e: FrontierError) -> Code {
    Code::V1(e)
}

/// The Train cost of `n` troops of `unit` (K2, §3.16): `train_v2` in an
/// MC season, M1's `train` otherwise.
pub fn train_cost(mc: bool, unit: u8, n: u32) -> Option<Cost> {
    if mc {
        catalog::train_v2(unit, n)
    } else {
        catalog::train(unit, n)
    }
}

/// Whether a Season account is an MC season (program version 2).
pub fn is_mc_season(program_version: u16) -> bool {
    program_version >= frontier_abi::v2::presets::PROGRAM_VERSION_V2
}

/// The lead host on a site tile (§3.1): the resident non-civilian host
/// with the most troops, then the lowest id, among hosts not of
/// `not_faction` (the site's own faction).
pub fn lead_on(w: &World, pi: u32, tile: u8, not_faction: u8, b: u32) -> Option<u32> {
    let p = w.provs.get(&pi)?;
    let cands: Vec<(u8, u64, u32)> = p
        .stationed
        .iter()
        .enumerate()
        .filter_map(|(i, &h)| {
            let x = w.hosts.get(&h)?;
            let resident = matches!(x.state, HostState::Stationed { from } if from <= b);
            (resident
                && x.tile == tile
                && x.faction != not_faction
                && x.faction < 6
                && !x.unit.is_civilian())
            .then_some((i.min(254) as u8, h as u64, x.troops.max(1)))
        })
        .collect();
    lead_host(&cands).map(|i| p.stationed[i as usize])
}

/// DeclareSiege's checks (§3.4 steps 1–10, in order) for `agent` sounding
/// the horn on holding `target` with its host `host` from source holding
/// `src` at bell `b`. `site` is the target's raw site key (for a target
/// that is not a holding: a Seat's reserved site, a free site).
pub fn declare_check(
    w: &World,
    states: &SiteStates,
    agent: u32,
    src: u32,
    host: u32,
    site: (i16, i16, u8),
    b: u32,
) -> Result<(), Code> {
    // 1. The season is running.
    if b >= w.end_bell {
        return Err(m1(FrontierError::WrongStatus));
    }
    // 3. The target is a holding (state 1) or a Free City (state 5).
    let Some(t) = w.holds.iter().find_map(|(&id, x)| {
        let pc = w.prov(x.prov).coord;
        ((pc.p as i16, pc.q as i16) == (site.0, site.1)
            && w.prov(x.prov).sites.get(site.2 as usize) == Some(&id))
        .then_some(id)
    }) else {
        return Err(match states.get(&site) {
            Some(&frontier_abi::v2::layout::province::site::STATE_RESERVED) => {
                m1(FrontierError::ReservedSite)
            }
            _ => cq(CqError::NotBesiegeable),
        });
    };
    let x = w.hold(t);
    // 4. A resident non-civilian host of the declarer's holding on the
    // target's tile; the hex's lead host.
    let ag = w.agent(agent);
    let ok_host = w.hosts.get(&host).is_some_and(|h| {
        h.home == src
            && h.owner == agent
            && h.faction == ag.faction
            && h.prov == x.prov
            && h.tile == x.tile
            && !h.unit.is_civilian()
            && matches!(h.state, HostState::Stationed { from } if from <= b)
    });
    if !ok_host {
        return Err(cq(CqError::NotOnHex));
    }
    if lead_on(w, x.prov, x.tile, x.faction, b) != Some(host) {
        return Err(cq(CqError::NotLead));
    }
    // 5. The record.
    match w.record_free(t, ag.faction, b) {
        Err(Refusal::Immune) => return Err(cq(CqError::Immune)),
        Err(_) => return Err(cq(CqError::SiegeBusy)),
        Ok(()) => {}
    }
    // 6. Today's declarations.
    if ag.declares.0 == b / permutation_rules::frontier::travel::BELLS_PER_DAY
        && ag.declares.1 >= w.params.sieges_per_day
    {
        return Err(cq(CqError::SiegeCap));
    }
    // 7. A capture target needs a free slot.
    let capture = x.free_city() || x.order >= 2;
    if capture && w.free_slot23(agent).is_none() {
        return Err(cq(CqError::HoldingsFull));
    }
    // 8. may_besiege v3 (a Free City skips it).
    if !x.free_city() {
        if let Err(r) = w.may_besiege(t, ag.faction, b) {
            return Err(match r {
                Refusal::Friendly => cq(CqError::Friendly),
                Refusal::Shielded => m1(FrontierError::Shielded),
                Refusal::FrontierProtected => cq(CqError::FrontierProtected),
                Refusal::Heartland => cq(CqError::Heartland),
                _ => cq(CqError::NotBesiegeable),
            });
        }
    }
    // 9. TooLate.
    let fits = if x.free_city() {
        w.end_bell.saturating_sub(b + 1)
            >= permutation_rules::frontier::siege::required_bells(x.walls_now, 0)
    } else {
        w.can_finish(t, b + 1, b)
    };
    if !fits {
        return Err(cq(CqError::TooLate));
    }
    // 10. The stake.
    if w.hold(src).stock[permutation_rules::frontier::holding::Resource::Gold as usize]
        < w.params.siege_stake_gold * MILLI
    {
        return Err(m1(FrontierError::Insufficient));
    }
    Ok(())
}

/// RetireHost's check during the season (K-27): only the victim (the
/// captured holding's previous owner) may retire its host, else `NotLead`.
pub fn retire_check(actor: u32, victim: u32, b: u32, end_bell: u32) -> Result<(), Code> {
    if b < end_bell && actor != victim {
        return Err(cq(CqError::NotLead));
    }
    Ok(())
}

/// The outpost rule's weights of province `pi` for faction `f` (strength
/// weight, as the simulator and the program read it).
pub fn outpost_weights(w: &World, pi: u32, f: u8) -> (u64, u64) {
    let (mut mine, mut tot) = (0u64, 0u64);
    for &g in &w.prov(pi).sites {
        if g == NONE {
            continue;
        }
        let y = w.hold(g);
        if !y.alive {
            continue;
        }
        let lt = match y.tier {
            Tier::Hamlet => LTier::Hamlet,
            Tier::Town => LTier::Town,
            Tier::City => LTier::City,
            Tier::Stronghold => LTier::Stronghold,
        };
        let wt = strength_weight(lt, y.garrison, y.order.saturating_sub(1));
        tot += wt;
        if y.faction == f {
            mine += wt;
        }
    }
    (mine, tot)
}

/// FileOutpost's §3.8 checks for `agent` filing in province `pi` (the
/// kernel's `may_found_outpost`; the land gate is the program's).
pub fn outpost_check(w: &World, agent: u32, pi: u32, b: u32) -> Result<(), Code> {
    let base = outpost_base(w, agent, b);
    let ag = w.agent(agent);
    let pc = w.prov(pi).coord;
    let range = ag
        .holdings
        .iter()
        .map(|&h| w.prov(w.hold(h).prov).coord.distance(pc))
        .min()
        .unwrap_or(u32::MAX);
    let (mine, tot) = outpost_weights(w, pi, ag.faction);
    let chk = OutpostCheck {
        target_ring: pc.ring(),
        range,
        faction_weight: mine,
        province_weight: tot,
        ..base
    };
    may_found_outpost(&chk).map_err(|e| match e {
        OutpostRefusal::HoldingsFull => cq(CqError::HoldingsFull),
        _ => cq(CqError::OutpostRule),
    })
}

fn outpost_base(w: &World, agent: u32, b: u32) -> OutpostCheck {
    let ag = w.agent(agent);
    let first = ag.holdings.iter().copied().find(|&h| w.hold(h).order == 1);
    OutpostCheck {
        slot: w.free_slot23(agent),
        first_final: first.is_some(),
        first_tier: first.map_or(Tier::Hamlet, |h| w.hold(h).tier),
        tier_min: Tier::Town,
        slot2_final: ag.holdings.iter().any(|&h| w.hold(h).order == 2),
        target_ring: w.params.heartland_max_ring as u32 + 1,
        heartland_max_ring: w.params.heartland_max_ring,
        range: 0,
        outpost_range: 3,
        faction_weight: 0,
        province_weight: 0,
        outpost_share_bps: 5_000,
        // The land gate is the Frontier's folded count, which the program
        // checks; the bot does not refuse itself on it.
        free_sites: 1,
        open_sites: 1,
        now_bell: b,
        end_bell: w.end_bell,
        outpost_close_bells: 24,
    }
}

/// Expand (§8.6; the simulator's `mc_expand`): daily players and up file
/// an outpost at the nearest front province where the faction holds < 50%
/// (an empty province qualifies), when the first holding is a Town, a slot
/// is free, the settler cost is in the first holding's stores and the
/// profile's quality roll passes.
pub fn expand(
    w: &World,
    states: &SiteStates,
    agent: u32,
    q: f64,
    rng: &mut Rng,
) -> Option<CqIntent> {
    let b = w.bell;
    let ag = w.agent(agent);
    if !matches!(
        ag.arch,
        Some(Arch::Daily | Arch::Skilled | Arch::VerySkilled | Arch::Bot)
    ) || ag.holdings.is_empty()
    {
        return None;
    }
    let base = outpost_base(w, agent, b);
    if may_found_outpost(&base).is_err() || !rng.chance(q) {
        return None;
    }
    let first = ag
        .holdings
        .iter()
        .copied()
        .find(|&h| w.hold(h).order == 1)?;
    let n = ag.holdings.len() as u32 + 1;
    // The kernel doctrines carry no settler-cost bias (the simulator's
    // `settler_cost_bps` is 1.0 outside the draft set).
    let c: [Milli; RESOURCES] = core::array::from_fn(|r| {
        duplicate_cost(SETTLER_COST[r] as u64, n - 1).unwrap_or(u64::MAX / 4) as i64 * MILLI
    });
    let stock = w.hold(first).stock;
    if (0..RESOURCES).any(|r| stock[r] < c[r]) {
        return None;
    }
    let centre = w.prov(w.hold(first).prov).coord;
    let mut best: Option<(u32, u32, u8)> = None;
    let mut seen = std::collections::BTreeSet::new();
    for &h in &ag.holdings {
        let hc = w.prov(w.hold(h).prov).coord;
        for pi in w.provinces_near(hc, 3) {
            if !seen.insert(pi) {
                continue;
            }
            let pc = w.prov(pi).coord;
            let key = |s: u8| (pc.p as i16, pc.q as i16, s);
            let Some(site) = (0..w.prov(pi).sites.len() as u8).find(|&s| {
                w.prov(pi).sites[s as usize] == NONE
                    && states.get(&key(s)).is_none_or(|&st| {
                        st == frontier_abi::v2::layout::province::site::STATE_FREE
                    })
            }) else {
                continue;
            };
            if outpost_check(w, agent, pi, b).is_err() {
                continue;
            }
            let score = centre.distance(pc);
            if best.is_none_or(|x| (score, pi) < (x.0, x.1)) {
                best = Some((score, pi, site));
            }
        }
    }
    let (_, pi, site) = best?;
    let pc = w.prov(pi).coord;
    Some(CqIntent::FileOutpost {
        anchor: first,
        sites: vec![(pc.p as i16, pc.q as i16, site)],
    })
}

/// The plan's dispatches of `agent` as marches.
pub fn marches(plan: &[Dispatch], agent: u32, w: &World) -> Vec<CqIntent> {
    plan.iter()
        .filter(|d| d.agent == agent)
        .map(|d| {
            let pc = w.prov(d.prov).coord;
            CqIntent::March {
                src: d.src,
                troops: d.troops,
                to: (pc.p as i16, pc.q as i16),
                tile: d.tile,
                arrive_min: d.arrive,
                retreat: d.retreat,
                mission: d.mission,
            }
        })
        .collect()
}

/// Besiege (§8.6): every host of `agent` resident on an enemy holding's
/// hex that is the hex's lead host sounds the horn when the target is a
/// campaign target or a strike of its faction is pending there, and the
/// local checks pass.
pub fn horns(w: &World, board: &Board, states: &SiteStates, agent: u32) -> Vec<CqIntent> {
    let b = w.bell;
    let f = w.agent(agent).faction;
    let mut out = vec![];
    let wanted = |t: u32| {
        board.pending.contains_key(&t)
            || board.camps[f as usize % 6]
                .iter()
                .any(|c| c.target == Target::Hold(t))
    };
    for (&hid, h) in &w.hosts {
        if h.owner != agent || !matches!(h.state, HostState::Stationed { .. }) {
            continue;
        }
        let p = w.prov(h.prov);
        for (s, &t) in p.sites.iter().enumerate() {
            if t == NONE || w.hold(t).tile != h.tile || w.hold(t).faction == f || !wanted(t) {
                continue;
            }
            let site = (p.coord.p as i16, p.coord.q as i16, s as u8);
            if declare_check(w, states, agent, h.home, hid, site, b).is_ok() {
                let nearby = first_nearby_hold(w, f, h.prov);
                out.push(CqIntent::DeclareSiege {
                    src: h.home,
                    host: hid,
                    site,
                    nearby,
                });
            }
        }
    }
    out
}

/// A first holding of faction `f` within 2 provinces of `pi` (Frontier
/// protection's named proof).
pub fn first_nearby_hold(w: &World, f: u8, pi: u32) -> Option<u32> {
    let c = w.prov(pi).coord;
    w.provinces_near(c, 2).into_iter().find_map(|q| {
        w.prov(q).sites.iter().copied().find(|&h| {
            h != NONE && {
                let y = w.hold(h);
                y.alive && y.faction == f && !y.free_city() && y.order == 1
            }
        })
    })
}

/// Retire (§8.6, K-27): the victim's hosts whose home is a captured
/// holding (the host's generation is not the site's) and that are not
/// defending (no hostile host on their tile).
pub fn retirements(w: &World, agent: u32, captured_homes: &[u32]) -> Vec<CqIntent> {
    let mut out = vec![];
    for (&hid, h) in &w.hosts {
        if !captured_homes.contains(&h.home) || !matches!(h.state, HostState::Stationed { .. }) {
            continue;
        }
        let defending = w.prov(h.prov).stationed.iter().any(|&o| {
            w.hosts
                .get(&o)
                .is_some_and(|x| x.tile == h.tile && x.faction != h.faction && x.faction < 6)
        });
        let _ = agent;
        if !defending {
            out.push(CqIntent::RetireHost { host: hid });
        }
    }
    out
}

/// Everything one bot does with its faction's plan at an epoch (the
/// conquest layer of a decision; the M1 economy runs beside it).
#[allow(clippy::too_many_arguments)]
pub fn decide(
    w: &World,
    board: &Board,
    plan: &[Dispatch],
    states: &SiteStates,
    agent: u32,
    q: f64,
    captured_homes: &[u32],
    rng: &mut Rng,
) -> Vec<CqIntent> {
    let mut out = horns(w, board, states, agent);
    out.extend(marches(plan, agent, w));
    out.extend(retirements(w, agent, captured_homes));
    if let Some(x) = expand(w, states, agent, q, rng) {
        out.push(x);
    }
    out
}

/// A unit's civilian class (a Scout never counts, §3.1).
pub fn civilian(u: UnitType) -> bool {
    u.is_civilian()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_train_cost_dispatches_on_the_season() {
        let h = UnitType::Horseman as u8;
        assert_eq!(train_cost(true, h, 100), catalog::train_v2(h, 100));
        assert_eq!(train_cost(false, h, 100), catalog::train(h, 100));
        assert_ne!(catalog::train_v2(h, 100), catalog::train(h, 100));
        assert!(is_mc_season(2) && !is_mc_season(1));
    }
}
