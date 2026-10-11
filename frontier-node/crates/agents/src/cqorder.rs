//! A conquest march order (MC contract v1.3 §8.6; unit CQ2-F): what the
//! faction plan asks of one wallet ([`crate::campaign::Dispatch`]) and what
//! the bot does with it at each wake-up until it has left.
//!
//! A plan's dispatch is "send `troops` from `src` to `(P, Q)`'s `tile`,
//! arriving no earlier than the campaign's muster bell". On chain that is
//! two transactions with a bell between them: a **Muster** of the troops
//! out of the home holding's reserve (the host exists once the bell
//! passes), then a sealed **Depart**. [`step`] is the pure rule: from the
//! bot's [`Observation`] and its [`Order`] it says which of the two to
//! send now, or to wait, or to give the order up. The runner
//! (`frontier-bots`) turns the answer into transactions.

use fclient::decode::Entry;
use fclient::ix::HoldingRef;

use crate::campaign::Mission;
use crate::obs::Observation;
use crate::policy::{
    can_depart, first_plan, host_of, href, muster_room, own_hosts, pick_retreat, pick_stance,
    pick_tip, DepartPlan, Intent, Route, SealKind, Target, MAX_HOST, MIN_HOST, SCOUT,
};
use crate::profile::AgentSpec;
use crate::rng::Rng;

/// Bells an order stays open (the muster bell is at most a few bells off;
/// a fresh plan replaces a stale order).
pub const ORDER_TTL_BELLS: u32 = 18;
/// Bells after a Muster before another is tried for the same order (the
/// host appears when the Muster's bell passes).
pub const MUSTER_WAIT_BELLS: u32 = 3;

/// One march a wallet owes its faction's plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    /// The wallet's own holding the host leaves from (P, Q, site).
    pub src: (i16, i16, u8),
    /// Troops the plan sends (whole troops).
    pub troops: u32,
    pub to: (i16, i16),
    pub tile: u8,
    /// The campaign's common arrival bell (0: as early as possible).
    pub arrive_min: u32,
    /// The hold rule's `retreat_bps` (an occupation strike), if any.
    pub retreat: Option<u16>,
    /// Report name (`CqIntent::name`).
    pub why: &'static str,
    /// The mission the planner knows the host by, and the id it planned for
    /// the host (a persona's order: `NONE`).
    pub mission: Mission,
    pub planned: u32,
    /// The bell the order was taken.
    pub issued: u32,
    /// The bell of the Muster sent for it, if any.
    pub mustered: Option<u32>,
}

/// What to do with an order now.
#[derive(Clone, Debug)]
pub enum Step {
    /// A Muster of `troops` of `unit` from the holding (the Depart follows
    /// at a later wake-up).
    Muster(Intent),
    /// The sealed march.
    Depart(Box<DepartPlan>),
    /// Nothing yet (a host is not ready, the Muster is pending).
    Wait,
    /// The order cannot be carried out any more.
    Drop(&'static str),
}

/// A host of the order's holding that stands at home and can march (not a
/// Scout), the one whose size is nearest the plan's.
fn pick_host(
    obs: &Observation,
    h: &fclient::decode::Holding,
    o: &Order,
    taken: &dyn Fn(u64) -> bool,
) -> Option<((i16, i16), Entry)> {
    let bell = obs.bell();
    own_hosts(obs, h)
        .into_iter()
        .filter(|((p, q), e)| {
            (*p, *q) == (h.p, h.q)
                && e.unit != SCOUT
                && can_depart(h, e, bell)
                && host_of(h, e.id)
                && e.troops >= MIN_HOST * 1_000
                && !taken(e.id)
        })
        .min_by_key(|(_, e)| (e.troops.abs_diff(o.troops.saturating_mul(1_000)), e.id))
}

/// The rule (see the module note). `taken(host)`: the bot has already
/// sent this host on a march that has not settled.
pub fn step(
    obs: &Observation,
    spec: &AgentSpec,
    seed: u64,
    reveal_loaded_limit: u32,
    o: &Order,
    taken: &dyn Fn(u64) -> bool,
) -> Step {
    let bell = obs.bell();
    let end = obs.season.end_bell();
    if bell >= end.saturating_sub(1) || bell > o.issued + ORDER_TTL_BELLS {
        return Step::Drop("stale");
    }
    let Some((_, h)) = obs
        .me
        .holdings
        .iter()
        .find(|(_, h)| (h.p, h.q, h.site) == o.src)
    else {
        return Step::Drop("no_holding");
    };
    let faction = h.faction;
    let hr: HoldingRef = href(h);
    // 1. A host that can leave: depart it.
    if let Some((at, host)) = pick_host(obs, h, o, taken) {
        let mut rng = Rng::fork(seed, 0xC0DE_0000 ^ (spec.index as u64) << 32 | bell as u64);
        let prof = spec.profile();
        let stance = pick_stance(faction, prof.q, &mut rng);
        let retreat = o.retreat.unwrap_or_else(|| pick_retreat(prof.q, &mut rng));
        let t = Target {
            p: o.to.0,
            q: o.to.1,
            tile: o.tile,
            why: o.why,
        };
        // The earliest arrival first, then pushed to the common bell.
        let Some((_, (_, p0, _))) = first_plan(obs, h, at, &host, [t], 0, stance, retreat) else {
            return Step::Drop("no_path");
        };
        let extra = o.arrive_min.saturating_sub(p0.arrive_bell);
        let Some((_, (path, plain, slot))) =
            first_plan(obs, h, at, &host, [t], extra, stance, retreat)
        else {
            return Step::Drop("no_path");
        };
        let presets = obs.season.tip_presets(reveal_loaded_limit);
        let tip = pick_tip(presets, spec.persona, prof.q, &mut rng);
        return Step::Depart(Box::new(DepartPlan {
            h: hr,
            host_at: at,
            host_id: host.id,
            transit_slot: slot,
            plain,
            tip,
            seal: SealKind::Honest,
            route: Route::Relay,
            path_others: path.others((o.to.0 as i32, o.to.1 as i32)),
            why: o.why,
        }));
    }
    // 2. No host: a Muster out of the reserve, once.
    if o.mustered.is_some_and(|m| bell < m + MUSTER_WAIT_BELLS) {
        return Step::Wait;
    }
    let own_pv = obs.province(h.p, h.q);
    let room = own_pv.map(|p| muster_room(p, faction)).unwrap_or(0);
    if room == 0 {
        return Step::Wait;
    }
    // The unit with the most in reserve (a Scout never marches to war).
    let (unit, avail) = (0..h.reserve.len() as u8)
        .filter(|&u| u != SCOUT)
        .map(|u| (u, h.reserve[u as usize]))
        .max_by_key(|&(u, n)| (n, std::cmp::Reverse(u)))
        .unwrap_or((0, 0));
    let want = o.troops.max(MIN_HOST);
    let troops = avail.min(want).min(MAX_HOST) / 100 * 100;
    if troops < MIN_HOST {
        return Step::Wait;
    }
    Step::Muster(Intent::Muster {
        h: hr,
        unit,
        troops,
        tile: h.tile,
    })
}

/// Adds `new` to the open orders: the same strike is one order.
pub fn dedupe(orders: &mut Vec<Order>, new: Order) {
    // The same strike (target, tile, mission) is one order: a replan keeps
    // the older order's bell and Muster.
    if let Some(x) = orders
        .iter_mut()
        .find(|x| x.to == new.to && x.tile == new.tile && x.why == new.why && x.src == new.src)
    {
        x.troops = new.troops;
        x.arrive_min = new.arrive_min;
        x.retreat = new.retreat;
        return;
    }
    orders.push(new);
}
