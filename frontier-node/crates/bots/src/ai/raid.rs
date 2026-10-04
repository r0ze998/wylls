//! The `raid` candidate (contract §4.3; unit AC3b): another nation's village
//! tile that `policy::shield_refuses` allows **at the arrival bell**, which
//! checks the target's shield and the sender's own. A march at it costs
//! troops only (D9: no village can be captured, no loot, no Works); the
//! candidate carries the fixed reward text and nothing else.
//!
//! The host is the one the camp and field marches use: the largest ready
//! combat host that passes the V3(a)-(c) caps (`brain::march_host`). The
//! target is the nearest village (province distance from the host, then
//! `(p, q, tile)`) for which a plan exists, so a village whose shield has
//! not ended by the earliest arrival bell is never offered; early in a run
//! (the real shield is 288 bells after founding) the march candidates are
//! camps and field stacks only (§0.5, §9.5).
//!
//! `shield` in the facts is `"ended"` for every offered raid: the target's
//! shield ended by the arrival bell and so did the sender's.

use frontier_agents::obs::Observation;
use frontier_agents::policy::{self, Target};
use permutation_rules::frontier::geometry::ProvinceCoord;
use serde_json::json;

use fclient::abi::layout::{entry as le, site as ls};

use super::brain::{
    default_stance, march_candidate, march_host, plan_depart, Inputs, MarchKind, Offer, MILLI,
};

/// The troops a bot can see at `t` and the nation that holds it: a camp's
/// troops; for a village the garrison plus the other nations' hosts on the
/// tile; for an open tile those hosts. `faction` is the bot's own (its hosts
/// are not an enemy).
pub fn visible_troops(obs: &Observation, t: &Target, faction: u8) -> (u32, Option<u8>) {
    let Some(pv) = obs.province(t.p, t.q) else {
        return (0, None);
    };
    if t.why == "camp" {
        return (pv.camp.troops, None);
    }
    let mut troops = 0u32;
    let mut nation = None;
    let n = (pv.site_count as usize).min(pv.sites.len());
    if let Some(k) = (0..n).find(|&k| pv.sites[k] == t.tile) {
        let m = &pv.site_mirror[k];
        if m.state == ls::STATE_HOLDING {
            troops += m.garrison / MILLI;
            nation = Some(m.faction);
        }
    }
    for e in &pv.entries {
        if e.state == le::STATE_ROSTER && e.tile == t.tile && e.faction < 6 && e.faction != faction
        {
            troops += e.troops / MILLI;
            nation.get_or_insert(e.faction);
        }
    }
    (troops, nation)
}

fn pdist(a: (i16, i16), b: (i16, i16)) -> u32 {
    ProvinceCoord::new(a.0 as i32, a.1 as i32).distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
}

/// Another nation's village tiles in view, nearest first.
fn raid_targets(obs: &Observation, faction: u8, from: (i16, i16)) -> Vec<Target> {
    let mut v: Vec<(u32, Target)> = policy::targets(obs, faction, obs.bell() + 73)
        .into_iter()
        .filter(|t| t.why == "war")
        .map(|t| (pdist((t.p, t.q), from), t))
        .collect();
    v.sort_by_key(|(d, t)| (*d, t.p, t.q, t.tile));
    v.into_iter().map(|x| x.1).collect()
}

/// At most one raid candidate (§4.3: "nearest raid target"), or none.
pub fn offer(inp: &Inputs) -> Vec<Offer> {
    let Ok(row) = march_host(inp) else {
        return vec![];
    };
    let obs = inp.obs;
    for t in raid_targets(obs, inp.faction, row.at) {
        // `plan_depart` plans the path and applies `shield_refuses` at the
        // planned arrival bell (the target's shield and the sender's own).
        let Some((plan, hexes, provinces)) = plan_depart(
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
        let (enemy, nation) = visible_troops(obs, &t, inp.faction);
        let mut o = march_candidate(
            inp,
            row,
            t,
            MarchKind::Raid,
            &plan,
            hexes,
            provinces,
            enemy,
            nation,
        );
        o.cand.facts["shield"] = json!("ended");
        return vec![o];
    }
    vec![]
}
