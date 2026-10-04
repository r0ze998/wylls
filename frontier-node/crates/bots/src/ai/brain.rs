//! The brain (contract §3.1, §3.6, §4.1–4.3, §4.5 V6): turns an
//! observation into at most 12 code-made candidates, asks the mind, filters
//! the rule autopilot, re-checks what the answer chose (V6) and sends.
//!
//! Everything in this file is deterministic in its inputs: the same
//! observation, marchbook and day state give the same candidates in the same
//! order with the same ids (test `ai_brain.rs`). The brain builds candidates
//! from the public policy functions (`targets`, `plan_march`,
//! `shield_refuses`, `own_hosts`, `muster_room`, `queue_free`, `stores_at`)
//! and its own code; `agents/src/policy.rs` is not edited.
//!
//! Section map: types · hosts and caps · candidates · situation ·
//! autopilot filter and quota floor · V6 · the step.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use fclient::abi::layout::{entry as le, site as ls};
use fclient::decode::{Entry, Holding, Province};
use fclient::ix::HoldingRef;
use frontier_agents::obs::Observation;
use frontier_agents::policy::{
    self, Ctx, DepartPlan, Intent, Route, SealKind, Target, MAX_HOST, MIN_HOST,
};
use frontier_agents::profile::BELLS_PER_DAY;
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::doctrine::DOCTRINES;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Resource, Tier, RESOURCES};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::meview::{self, MeExtra};
use super::mindport::{
    Answer, AutopilotSummary, Candidate, DecideRequest, FollowDepart, MindError, Mode, OwnMarch,
};
use super::ready;
use super::standing::{self, Standing, RESERVE_BELLS};
use super::{AiHook, BookMarch, By, Cached, DayState};
use crate::bot::{Bot, ClockSource, Shared, QUOTA_RESERVE};
use crate::ports::{DirectPort, HeraldPort, RelayPort};

// ------------------------------------------------------------------ constants

/// A request carries at most this many candidates (§4.3).
pub const MAX_CANDIDATES: usize = 12;
/// Economy candidates after the march candidates: two builds, walls, train,
/// muster, explore. The §4.3 table says "next ≤ 4"; a hard cap of 4 would
/// never offer muster or explore while two builds, walls and a train are
/// affordable (the usual state), so the bound is the global 12 with the
/// pinned order (AC3a-NOTES.md, deviations).
pub const MAX_ECONOMY: usize = 6;
/// The autopilot's economy actions (Build, Train, Muster, Explore) are
/// skipped while the quota left is at most this (§3.4 quota floor).
pub const QUOTA_FLOOR: u32 = 16;
/// An answer older than this many game seconds is re-observed (§3.1 step 5);
/// `plan_march` fixes a departure at `now + DEPART_SLACK_SECS`, so a plan
/// older than 30 game-s is never sent.
pub const STALE_SECS: i64 = 30;
/// Model-chosen marches per game day (§4.5 V3 (d)).
pub const MODEL_MARCHES_PER_DAY: usize = 4;
/// Candidates a march kind may offer at most: 2 camps, 1 field stack, 1 raid.
pub const MAX_CAMPS: usize = 2;
pub const CAMP_REWARD: &str = "10 Works (points, no use yet)";
pub const FIGHT_REWARD: &str = "troops lost only; no land can be taken";
/// The `margin` of §3.4 in real seconds (at least).
pub const MARGIN_REAL_SECS: f64 = 3.0;

/// The pinned autopilot filter (§3.6; test `ai_autopilot_no_voluntary_march.rs`
/// checks that every `Intent::name()` is in exactly one list).
///
/// Duties, sent at once (step 2) and never dropped.
pub const KEPT_DUTIES: [&str; 8] = [
    "join",
    "file_ticket",
    "reveal",
    "settle_transit",
    "settle_explore",
    "settle_own_ticket",
    "nudge",
    "harvest",
];
/// The autopilot's economy: kept, but skipped while the quota is at or below
/// [`QUOTA_FLOOR`].
pub const KEPT_ECONOMY: [&str; 4] = ["build", "train", "muster", "explore"];
/// Dropped: the voluntary march of the rule policy and the adversarial
/// personas' intents (an AI has no persona, so the latter never arise).
pub const DROPPED: [&str; 5] = ["depart", "redepart", "prefund", "hold", "spam"];

// ------------------------------------------------------------------ types

/// What a march candidate aims at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchKind {
    Camp,
    Field,
    /// AC3b: another nation's village tile.
    Raid,
    /// AC3b: the nation council's Strike Order (flagged).
    Call,
    /// AC3b: an arrived host back to the own holding tile.
    Recall,
}

impl MarchKind {
    pub fn name(self) -> &'static str {
        match self {
            MarchKind::Camp => "camp",
            MarchKind::Field => "field",
            MarchKind::Raid => "raid",
            MarchKind::Call => "call",
            MarchKind::Recall => "recall",
        }
    }
}

/// What a candidate does when chosen (kept brain-side; never serialised).
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Autopilot,
    Hold {
        hosts: Vec<u64>,
    },
    March {
        host_id: u64,
        at: (i16, i16),
        target: Target,
        kind: MarchKind,
        troops: u32,
    },
    Build {
        item: u8,
    },
    Walls,
    Train {
        unit: u8,
    },
    Muster {
        unit: u8,
    },
    Explore {
        host_id: u64,
    },
}

/// A candidate and what it does.
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub cand: Candidate,
    pub action: Action,
}

impl Offer {
    /// A stable identity of the action across re-observation (candidate ids
    /// can shift between two observations of one bell).
    pub fn identity(&self) -> String {
        match &self.action {
            Action::Autopilot => "autopilot".into(),
            Action::Hold { .. } => "hold".into(),
            Action::March {
                host_id, target, ..
            } => format!("march:{host_id}:{},{},{}", target.p, target.q, target.tile),
            Action::Build { item } => format!("build:{item}"),
            Action::Walls => "walls".into(),
            Action::Train { unit } => format!("train:{unit}"),
            Action::Muster { unit } => format!("muster:{unit}"),
            Action::Explore { host_id } => format!("explore:{host_id}"),
        }
    }
}

/// One own host as the situation lists it (handles `H1..` by (province, id)).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRow {
    pub handle: String,
    pub at: (i16, i16),
    pub e: Entry,
    pub in_transit: bool,
    pub arrive_bell: Option<u32>,
    /// A combat host that can march now.
    pub ready: bool,
}

impl HostRow {
    /// Whole troops (the chain's `Entry.troops` is in milli-troops).
    pub fn troops(&self) -> u32 {
        self.e.troops / MILLI
    }
}

/// Milli-troops per troop: `Entry.troops`, `Transit.dep_mass` and a site
/// mirror's `garrison` are `MilliTroops`; a Holding's `reserve` and a camp's
/// `troops` are whole troops (the real herald serves a 100-troop host as
/// 100000; a camp as 100..400).
pub const MILLI: u32 = 1_000;

/// Everything candidate generation reads.
pub struct Inputs<'a> {
    pub obs: &'a Observation,
    pub h: &'a Holding,
    pub faction: u8,
    pub ds: &'a DayState,
    /// The tips the relay sponsors; the AI pays the highest (contested
    /// reveals land first).
    pub presets: [u64; 3],
    pub autopilot_summary: String,
    pub rows: Vec<HostRow>,
    pub home_troops: u32,
    /// The relay quota left at the start of the step (shown in the
    /// autopilot candidate's facts: the floor holds its economy back).
    pub quota_left: u32,
}

pub fn href(h: &Holding) -> HoldingRef {
    HoldingRef {
        p: h.p,
        q: h.q,
        site: h.site,
    }
}

/// The AI's home: its first holding that is final by rule (the policy's
/// military uses `finals[0]` too).
pub fn home_holding(obs: &Observation) -> Option<&Holding> {
    obs.me
        .holdings
        .iter()
        .map(|(_, h)| h)
        .find(|h| policy::final_by_rule(obs, h))
}

// ------------------------------------------------------------------ names

pub fn unit_name(u: u8) -> String {
    catalog::unit_of(u)
        .map(|t| format!("{t:?}").to_lowercase())
        .unwrap_or_else(|| format!("unit{u}"))
}

pub fn resource_name(r: usize) -> &'static str {
    match Resource::ALL.get(r) {
        Some(Resource::Food) => "food",
        Some(Resource::Wood) => "wood",
        Some(Resource::Stone) => "stone",
        Some(Resource::Ore) => "ore",
        Some(Resource::Horses) => "horses",
        Some(Resource::Gold) => "gold",
        Some(Resource::Science) => "science",
        Some(Resource::Influence) => "influence",
        None => "?",
    }
}

pub fn building_name(item: u8) -> &'static str {
    catalog::BUILDINGS
        .get(item as usize)
        .map(|b| resource_name(b.resource as usize))
        .unwrap_or("?")
}

pub fn tier_name(t: u8) -> &'static str {
    match t {
        0 => "hamlet",
        1 => "town",
        2 => "city",
        _ => "stronghold",
    }
}

const STANCES: [&str; 4] = ["hold", "assault", "flank", "brace"];

pub fn stance_code(name: &str) -> Option<u8> {
    STANCES.iter().position(|s| *s == name).map(|i| i as u8)
}

/// The estimate word (§4.3): `own/enemy ≥ 2` favourable, `≥ 1` even, else
/// unfavourable. An empty target is favourable. Always labelled "estimate".
pub fn ratio_word(own: u32, enemy: u32) -> &'static str {
    if enemy == 0 || own as u64 >= 2 * enemy as u64 {
        "favourable"
    } else if own >= enemy {
        "even"
    } else {
        "unfavourable"
    }
}

fn afford(stores: &[i64; RESOURCES], cost: &[i64; RESOURCES]) -> bool {
    stores.iter().zip(cost).all(|(s, c)| s >= c)
}

fn units_of(v: &[i64; RESOURCES]) -> Vec<i64> {
    v.iter().map(|x| x / 1_000).collect()
}

// ------------------------------------------------------------------ hosts and caps

type RowSrc = ((i16, i16), Entry, bool, Option<u32>);

/// The own hosts in view and in transit, with handles `H1..` by (province,
/// host id). A host in transit is listed with its origin province and
/// `arrive_bell` only (its destination is sealed).
pub fn host_rows(obs: &Observation, h: &Holding) -> Vec<HostRow> {
    let bell = obs.bell();
    let mut v: Vec<RowSrc> = vec![];
    for (pq, e) in policy::own_hosts(obs, h) {
        let t = h.transit_of(e.id).map(|(_, t)| t.arrive_bell);
        v.push((pq, e, t.is_some(), t));
    }
    for t in h.transit.iter().filter(|t| (1..=3).contains(&t.state)) {
        if v.iter().any(|x| x.1.id == t.host_id) {
            continue;
        }
        let e = Entry {
            id: t.host_id,
            faction: t.faction,
            unit: t.unit,
            state: le::STATE_ROSTER,
            troops: t.dep_mass,
            stamina_value: t.stamina_after,
            stamina_bell: t.depart_bell,
            ..Entry::default()
        };
        v.push(((t.origin_p, t.origin_q), e, true, Some(t.arrive_bell)));
    }
    v.sort_by_key(|(pq, e, _, _)| (*pq, e.id));
    v.into_iter()
        .enumerate()
        .map(|(i, (at, e, in_transit, arrive_bell))| HostRow {
            handle: format!("H{}", i + 1),
            at,
            ready: !in_transit && ready::can_depart(h, &e, bell),
            e,
            in_transit,
            arrive_bell,
        })
        .collect()
}

/// `home_troops` (§4.2) and the garrison: own combat hosts in the home
/// province (roster, not in transit) + the combat reserve + the garrison of
/// the home site.
pub fn home_troops(obs: &Observation, h: &Holding, rows: &[HostRow]) -> (u32, u32) {
    let at_home: u32 = rows
        .iter()
        .filter(|r| {
            !r.in_transit
                && r.e.unit != ready::SCOUT
                && r.e.state == le::STATE_ROSTER
                && r.at == (h.p, h.q)
        })
        .map(|r| r.troops())
        .sum();
    let reserve: u32 = h.reserve[..6].iter().sum();
    let garrison = obs
        .province(h.p, h.q)
        .and_then(|pv| pv.site_mirror.get(h.site as usize))
        .map_or(0, |m| m.garrison / MILLI);
    (at_home + reserve + garrison, garrison)
}

/// The caps of §4.5 V3 against one decision: `total` troops over `count`
/// chosen marches, `home` = `home_troops` now. Returns the first violated
/// cap. `st` holds the mind's `caps` of the current answer (V6 only).
pub fn caps_violation(
    total: u32,
    count: usize,
    home: u32,
    ds: &DayState,
    st: Option<&Standing>,
) -> Option<&'static str> {
    if (total as u64) * 100 > 60 * home as u64 {
        return Some("V3a");
    }
    // H0 < 200 means "no day cap, no floor" (the first march of day 0 is
    // not blocked); (a) and (d) always apply.
    if ds.h0 >= 200 {
        if (ds.troops_today() as u64 + total as u64) * 100 > 60 * ds.h0 as u64 {
            return Some("V3b");
        }
        if (home as u64).saturating_sub(total as u64) * 100 < 40 * ds.h0 as u64 {
            return Some("V3c");
        }
    }
    if ds.marches.len() + count > MODEL_MARCHES_PER_DAY {
        return Some("V3d");
    }
    if let Some(s) = st {
        if s.march_troops_left.is_some_and(|l| total > l) {
            return Some("caps.march_troops_left");
        }
        if s.home_floor.is_some_and(|f| home.saturating_sub(total) < f) {
            return Some("caps.home_floor");
        }
    }
    None
}

// ------------------------------------------------------------------ candidates

#[allow(clippy::too_many_arguments)]
fn plan_depart(
    obs: &Observation,
    h: &Holding,
    at: (i16, i16),
    host: &Entry,
    t: Target,
    extra: u32,
    stance: u8,
    retreat: u16,
    presets: [u64; 3],
) -> Option<(DepartPlan, usize, usize)> {
    let (path, plain, slot) = policy::plan_march(obs, h, at, host, t, extra, stance, retreat)?;
    if policy::shield_refuses(obs, h, &t, plain.arrive_bell) {
        return None;
    }
    let hexes = path.dirs.len();
    let provinces = path.provinces.len();
    Some((
        DepartPlan {
            h: href(h),
            host_at: at,
            host_id: host.id,
            transit_slot: slot,
            plain,
            tip: presets[2],
            seal: SealKind::Honest,
            route: Route::Relay,
            path_others: path.others((t.p as i32, t.q as i32)),
            why: t.why,
        },
        hexes,
        provinces,
    ))
}

fn pdist(a: (i16, i16), b: (i16, i16)) -> u32 {
    ProvinceCoord::new(a.0 as i32, a.1 as i32).distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
}

/// Live camps in view, nearest first.
fn camp_targets(obs: &Observation, faction: u8, from: (i16, i16)) -> Vec<Target> {
    let mut v: Vec<(u32, Target)> = policy::targets(obs, faction, obs.bell() + 73)
        .into_iter()
        .filter(|t| t.why == "camp")
        .map(|t| (pdist((t.p, t.q), from), t))
        .collect();
    v.sort_by_key(|(d, t)| (*d, t.p, t.q));
    v.into_iter().map(|x| x.1).collect()
}

/// Another nation's open-field stacks (a non-site tile with another
/// nation's hosts), nearest first: (target, visible troops, nation).
fn field_targets(obs: &Observation, faction: u8, from: (i16, i16)) -> Vec<(Target, u32, u8)> {
    let mut v: Vec<(u32, Target, u32, u8)> = vec![];
    for (&(p, q), view) in &obs.provinces {
        let pv: &Province = &view.province;
        let sites: Vec<u8> = pv.sites[..pv.site_count.min(12) as usize].to_vec();
        let mut by_tile: BTreeMap<u8, (u32, u8)> = BTreeMap::new();
        for e in &pv.entries {
            if e.state == le::STATE_ROSTER
                && e.faction < 6
                && e.faction != faction % 6
                && !sites.contains(&e.tile)
                && pv.passable_mask >> e.tile & 1 == 1
            {
                let x = by_tile.entry(e.tile).or_insert((0, e.faction));
                x.0 += e.troops / MILLI;
            }
        }
        for (tile, (troops, nation)) in by_tile {
            v.push((
                pdist((p, q), from),
                Target {
                    p,
                    q,
                    tile,
                    why: "field",
                },
                troops,
                nation,
            ));
        }
    }
    v.sort_by_key(|(d, t, _, _)| (*d, t.p, t.q, t.tile));
    v.into_iter().map(|(_, t, n, f)| (t, n, f)).collect()
}

#[allow(clippy::too_many_arguments)]
fn march_candidate(
    inp: &Inputs,
    row: &HostRow,
    t: Target,
    kind: MarchKind,
    plan: &DepartPlan,
    hexes: usize,
    provinces: usize,
    enemy: u32,
    nation: Option<u8>,
) -> Offer {
    let obs = inp.obs;
    let bell = obs.bell();
    let troops = row.troops();
    let idle = ready::departable_from(inp.h, &row.e).map_or(0, |b| bell.saturating_sub(b));
    let reward = if kind == MarchKind::Camp {
        CAMP_REWARD
    } else {
        FIGHT_REWARD
    };
    let mut entities = vec![format!("pq:{},{}", t.p, t.q)];
    if let Some(n) = nation {
        entities.push(format!("nation:{n}"));
    }
    let what = match kind {
        MarchKind::Camp => "a barbarian camp",
        MarchKind::Field => "another nation's army in the open field",
        MarchKind::Raid => "another nation's village",
        MarchKind::Call => "the Strike Order's target",
        MarchKind::Recall => "home",
    };
    let facts = json!({
        "host": row.handle,
        "host_id": row.e.id.to_string(),
        "troops": troops,
        "target_kind": kind.name(),
        "target": {"p": t.p, "q": t.q, "tile": t.tile},
        "hexes": hexes,
        "provinces": provinces,
        "earliest_bell": plan.plain.arrive_bell,
        "enemy_troops": enemy,
        "ratio": ratio_word(troops, enemy),
        "ratio_is": "estimate",
        "shield": "not applicable",
        "idle_bells": idle,
        "reward": reward,
    });
    let mut params = BTreeMap::new();
    params.insert(
        "stance".to_string(),
        STANCES.iter().map(|s| json!(s)).collect::<Vec<_>>(),
    );
    params.insert(
        "retreat".to_string(),
        vec![json!(0), json!(5000), json!(10000)],
    );
    params.insert("timing".to_string(), vec![json!("earliest")]);
    Offer {
        cand: Candidate {
            id: String::new(),
            kind: "march".into(),
            label: format!(
                "March {} ({} troops) to {what}, {hexes} hexes away; earliest arrival at bell {}",
                row.handle, troops, plan.plain.arrive_bell
            ),
            facts,
            params,
            council: kind == MarchKind::Call,
            troops: Some(troops),
            entities,
        },
        action: Action::March {
            host_id: row.e.id,
            at: row.at,
            target: t,
            kind,
            troops,
        },
    }
}

/// The march candidates (§4.3): the largest ready host that passes the caps
/// V3(a)–(c) goes to the nearest 2 camps and the nearest open-field stack;
/// `raid::offer` adds a raid (AC3b). None when no host may march.
fn march_offers(inp: &Inputs) -> (Vec<Offer>, Option<&'static str>) {
    let obs = inp.obs;
    let mut ready_rows: Vec<&HostRow> = inp
        .rows
        .iter()
        .filter(|r| r.ready && r.e.unit != ready::SCOUT)
        .collect();
    ready_rows.sort_by_key(|r| (std::cmp::Reverse(r.e.troops), r.e.id));
    if ready_rows.is_empty() {
        return (vec![], None);
    }
    let Some(row) = ready_rows
        .iter()
        .find(|r| caps_violation(r.troops(), 1, inp.home_troops, inp.ds, None).is_none())
    else {
        return (vec![], Some("cap: no host may march"));
    };
    let (stance, retreat) = (default_stance(inp.faction), 0u16);
    let mut out = vec![];
    let mut camps = 0;
    for t in camp_targets(obs, inp.faction, row.at) {
        if camps == MAX_CAMPS {
            break;
        }
        let Some((plan, hexes, provs)) = plan_depart(
            obs,
            inp.h,
            row.at,
            &row.e,
            t,
            0,
            stance,
            retreat,
            inp.presets,
        ) else {
            continue;
        };
        let enemy = obs.province(t.p, t.q).map_or(0, |pv| pv.camp.troops);
        out.push(march_candidate(
            inp,
            row,
            t,
            MarchKind::Camp,
            &plan,
            hexes,
            provs,
            enemy,
            None,
        ));
        camps += 1;
    }
    for (t, enemy, nation) in field_targets(obs, inp.faction, row.at) {
        let Some((plan, hexes, provs)) = plan_depart(
            obs,
            inp.h,
            row.at,
            &row.e,
            t,
            0,
            stance,
            retreat,
            inp.presets,
        ) else {
            continue;
        };
        out.push(march_candidate(
            inp,
            row,
            t,
            MarchKind::Field,
            &plan,
            hexes,
            provs,
            enemy,
            Some(nation),
        ));
        break;
    }
    (out, None)
}

/// The doctrine's drilled stance, else Hold (a deterministic default for a
/// plan whose `stance` param is absent).
pub fn default_stance(faction: u8) -> u8 {
    DOCTRINES[(faction % 6) as usize]
        .drill
        .map_or(0, |(s, _)| s as u8)
}

/// Largest affordable multiple of 100 troops of `unit` (0 when not even 100).
fn max_train(stores: &[i64; RESOURCES], unit: u8) -> u32 {
    let mut k = 0u32;
    while k < 300 {
        match catalog::train(unit, 100 * (k + 1)) {
            Some(c) if afford(stores, &c) => k += 1,
            _ => break,
        }
    }
    k * 100
}

/// `share`% of `total`, rounded down to 100, at least 100 (and at most 30,000).
pub fn share_of(total: u32, share: u32) -> u32 {
    ((total as u64 * share as u64 / 100) as u32 / 100 * 100).clamp(MIN_HOST, MAX_HOST)
}

fn economy_offers(inp: &Inputs) -> Vec<Offer> {
    let obs = inp.obs;
    let h = inp.h;
    let now = obs.now;
    let bell = obs.bell();
    let doctrine = &DOCTRINES[(h.faction % 6) as usize];
    let stores = policy::stores_at(h, now);
    let mut out = vec![];
    let shares = || vec![json!(25), json!(50), json!(75)];
    if policy::queue_free(h, now) {
        // The 2 cheapest affordable buildings, distinct.
        let mut b: Vec<(i64, u8, [i64; RESOURCES])> = vec![];
        for item in 0..catalog::BUILDINGS.len() as u8 {
            let n = policy::copies(h, item, now) + 1;
            let Some((cost, _, secs)) = catalog::building(item, n, doctrine) else {
                continue;
            };
            if afford(&stores, &cost) {
                b.push((cost.iter().sum(), item, cost));
                let _ = secs;
            }
        }
        b.sort_by_key(|x| (x.0, x.1));
        for (_, item, cost) in b.into_iter().take(2) {
            let n = policy::copies(h, item, now) + 1;
            let secs = catalog::building(item, n, doctrine).map_or(0, |x| x.2);
            let after: [i64; RESOURCES] = core::array::from_fn(|i| stores[i] - cost[i]);
            let name = building_name(item);
            out.push(Offer {
                cand: Candidate {
                    id: String::new(),
                    kind: format!("build:{name}"),
                    label: format!("Build a {name} producer (copy {n})"),
                    facts: json!({
                        "item": name,
                        "copy": n,
                        "cost": units_of(&cost),
                        "stores_after": units_of(&after),
                        "build_minutes": secs / 60,
                    }),
                    params: BTreeMap::new(),
                    council: false,
                    troops: None,
                    entities: vec![],
                },
                action: Action::Build { item },
            });
        }
        if let Some((cost, _, secs)) = catalog::building(catalog::ITEM_WALLS, 1, doctrine) {
            if afford(&stores, &cost) {
                let after: [i64; RESOURCES] = core::array::from_fn(|i| stores[i] - cost[i]);
                out.push(Offer {
                    cand: Candidate {
                        id: String::new(),
                        kind: "walls".into(),
                        label: "Build walls around the village".into(),
                        facts: json!({
                            "cost": units_of(&cost),
                            "stores_after": units_of(&after),
                            "walls_now": h.walls,
                            "adds": catalog::WALL_STEP,
                            "build_minutes": secs / 60,
                        }),
                        params: BTreeMap::new(),
                        council: false,
                        troops: None,
                        entities: vec![],
                    },
                    action: Action::Walls,
                });
            }
        }
    }
    let unit = doctrine.unit as u8;
    let affordable_troops = max_train(&stores, unit);
    if affordable_troops >= MIN_HOST {
        let mut params = BTreeMap::new();
        params.insert("share".to_string(), shares());
        out.push(Offer {
            cand: Candidate {
                id: String::new(),
                kind: format!("train:{}", unit_name(unit)),
                label: format!("Train {} troops into the reserve", unit_name(unit)),
                facts: json!({
                    "unit": unit_name(unit),
                    "max_troops": affordable_troops,
                    "reserve_now": h.reserve[unit as usize],
                }),
                params,
                council: false,
                troops: None,
                entities: vec![],
            },
            action: Action::Train { unit },
        });
    }
    let reserve = h.reserve[unit as usize];
    let room = obs
        .province(h.p, h.q)
        .map_or(0, |pv| policy::muster_room(pv, h.faction));
    if reserve >= MIN_HOST && room > 0 {
        let mut params = BTreeMap::new();
        params.insert("share".to_string(), shares());
        out.push(Offer {
            cand: Candidate {
                id: String::new(),
                kind: format!("muster:{}", unit_name(unit)),
                label: format!(
                    "Muster {} troops from the reserve into a new army",
                    unit_name(unit)
                ),
                facts: json!({
                    "unit": unit_name(unit),
                    "reserve": reserve,
                    "room": room,
                }),
                params,
                council: false,
                troops: None,
                entities: vec![],
            },
            action: Action::Muster { unit },
        });
    }
    if h.explore.state == 0 {
        if let Some(r) = inp
            .rows
            .iter()
            .find(|r| !r.in_transit && ready::ready_host(h, &r.e, bell, true))
        {
            if explore_tiles(obs, r, 2).is_some() {
                out.push(Offer {
                    cand: Candidate {
                        id: String::new(),
                        kind: format!("explore:{}", r.handle),
                        label: format!("Send scout {} to explore the tiles next to it", r.handle),
                        facts: json!({"host": r.handle, "host_id": r.e.id.to_string()}),
                        params: BTreeMap::new(),
                        council: false,
                        troops: None,
                        entities: vec![],
                    },
                    action: Action::Explore { host_id: r.e.id },
                });
            }
        }
    }
    out.truncate(MAX_ECONOMY);
    out
}

/// The tiles a scout would explore (adjacent, not yet explored), at most
/// `take` of them; `None` when there are none.
fn explore_tiles(obs: &Observation, r: &HostRow, take: usize) -> Option<Vec<u8>> {
    let pv = obs.province(r.at.0, r.at.1)?;
    let tiles: Vec<u8> = frontier_agents::path::adjacent_tiles(r.e.tile)
        .into_iter()
        .filter(|&t| pv.explored_mask >> t & 1 == 0)
        .take(take)
        .collect();
    (!tiles.is_empty()).then_some(tiles)
}

/// The candidate list (§4.3), in the pinned order, truncated to 12, with
/// ids `c1..`. Deterministic in `inp`.
pub fn candidates(inp: &Inputs) -> Vec<Offer> {
    let mut out: Vec<Offer> = vec![];
    let ready_combat: Vec<&HostRow> = inp
        .rows
        .iter()
        .filter(|r| r.ready && r.e.unit != ready::SCOUT)
        .collect();
    out.push(Offer {
        cand: Candidate {
            id: String::new(),
            kind: "autopilot".into(),
            label: "Routine: economy and duties only, no march".into(),
            facts: json!({
                "routine": "economy and duties only, no march",
                "summary": inp.autopilot_summary,
                "quota_left": inp.quota_left,
                "economy_held_by_quota": inp.quota_left <= QUOTA_FLOOR,
            }),
            params: BTreeMap::new(),
            council: false,
            troops: None,
            entities: vec![],
        },
        action: Action::Autopilot,
    });
    let (marches, cap_note) = march_offers(inp);
    let mut hold_facts = json!({
        "duties": "duties only; keep armies home",
        "keeps_home": ready_combat.iter().map(|r| r.handle.clone()).collect::<Vec<_>>(),
    });
    if let Some(n) = cap_note {
        hold_facts["cap"] = json!(n);
    }
    out.push(Offer {
        cand: Candidate {
            id: String::new(),
            kind: "hold".into(),
            label: "Hold: duties only, keep the armies home".into(),
            facts: hold_facts,
            params: BTreeMap::new(),
            council: false,
            troops: None,
            entities: vec![],
        },
        action: Action::Hold {
            hosts: ready_combat.iter().map(|r| r.e.id).collect(),
        },
    });
    // AC3b: the Strike-Order march (flagged) goes here, then recall.
    out.extend(super::recall::offer(inp));
    out.extend(marches);
    out.extend(super::raid::offer(inp));
    out.extend(economy_offers(inp));
    out.truncate(MAX_CANDIDATES);
    for (i, o) in out.iter_mut().enumerate() {
        o.cand.id = format!("c{}", i + 1);
    }
    out
}

// ------------------------------------------------------------------ situation

fn queue_json(h: &Holding, now: i64) -> Value {
    let slots = [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold]
        .get(h.tier as usize)
        .map_or(2, |t| t.queue_slots());
    let items: Vec<Value> = h
        .queue
        .iter()
        .filter(|q| q.kind != 0 && q.done_at > now)
        .map(|q| {
            let what = match q.kind {
                1 => format!("build {}", resource_name(q.arg as usize)),
                2 => "upkeep".to_string(),
                3 => "tier up".to_string(),
                4 => "walls".to_string(),
                k => format!("item {k}"),
            };
            json!({"what": what, "done_in_min": ((q.done_at - now) / 60).max(0)})
        })
        .collect();
    json!({"busy": items.len(), "slots": slots, "items": items})
}

fn host_json(r: &HostRow, h: &Holding, bell: u32) -> Value {
    let combat = r.e.unit != ready::SCOUT;
    let mut o = Map::new();
    o.insert("handle".into(), json!(r.handle));
    o.insert("host_id".into(), json!(r.e.id.to_string()));
    o.insert("unit".into(), json!(unit_name(r.e.unit)));
    o.insert("troops".into(), json!(r.troops()));
    o.insert("at".into(), json!({"p": r.at.0, "q": r.at.1}));
    o.insert("stamina".into(), json!(ready::stamina_at(&r.e, bell)));
    o.insert("ready".into(), json!(r.ready));
    if combat && !r.ready {
        if let Some(w) = ready::why_not(h, &r.e, bell) {
            o.insert("why_not".into(), json!(w));
        }
    }
    if r.ready {
        let idle = ready::departable_from(h, &r.e).map_or(0, |b| bell.saturating_sub(b));
        o.insert("idle_bells".into(), json!(idle));
    }
    o.insert("in_transit".into(), json!(r.in_transit));
    if let Some(a) = r.arrive_bell {
        o.insert("arrive_bell".into(), json!(a));
    }
    Value::Object(o)
}

/// The situation of §4.2 (numbers with units, filled by code). `my_clashes`
/// is `[]`: the files `observe` reads carry no loss figures; the mind adds
/// the clash facts from its feed (AC3a-NOTES.md, deviations).
pub fn situation(inp: &Inputs, quota: (u32, u32)) -> Value {
    let obs = inp.obs;
    let h = inp.h;
    let now = obs.now;
    let bell = obs.bell();
    let doctrine = &DOCTRINES[(h.faction % 6) as usize];
    let stores = policy::stores_at(h, now);
    let shield_bell = if h.shield_until > now {
        obs.season.bell_at(h.shield_until)
    } else {
        0
    };
    let garrison = home_troops(obs, h, &inp.rows).1;
    let room = obs
        .province(h.p, h.q)
        .map_or(0, |pv| policy::muster_room(pv, h.faction));
    let mut neighbourhood = vec![];
    for (&(p, q), view) in obs.provinces.iter().take(12) {
        let pv = &view.province;
        let mut holdings: BTreeMap<String, u32> = BTreeMap::new();
        for s in 0..pv.site_count.min(12) as usize {
            let m = &pv.site_mirror[s];
            if m.state == ls::STATE_HOLDING {
                *holdings.entry(m.faction.to_string()).or_default() += 1;
            }
        }
        let mut hosts: BTreeMap<u8, (u32, u32)> = BTreeMap::new();
        for e in pv.entries.iter().filter(|e| e.state == le::STATE_ROSTER) {
            let x = hosts.entry(e.faction).or_default();
            x.0 += 1;
            x.1 += e.troops / MILLI;
        }
        let mut o = Map::new();
        o.insert("p".into(), json!(p));
        o.insert("q".into(), json!(q));
        o.insert("d".into(), json!(pdist((p, q), (h.p, h.q))));
        if pv.camp.state != 0 {
            o.insert("camp_troops".into(), json!(pv.camp.troops));
        }
        o.insert("holdings".into(), json!(holdings));
        o.insert(
            "hosts".into(),
            Value::Array(
                hosts
                    .into_iter()
                    .map(|(n, (c, t))| json!({"nation": n, "n": c, "troops": t}))
                    .collect(),
            ),
        );
        neighbourhood.push(Value::Object(o));
    }
    let bucket_left = obs
        .me
        .citizen
        .as_ref()
        .map_or(0, |(_, c)| c.bucket_milli / 1_000);
    json!({
        "bell": bell,
        "day": bell / BELLS_PER_DAY,
        "bell_in_day": bell % BELLS_PER_DAY,
        "secs_left": obs.season.genesis_ts + obs.season.end_bell() as i64 * 600 - now,
        "end_bell": obs.season.end_bell(),
        "me": {
            "faction": h.faction,
            "doctrine": doctrine.name,
            "home": {
                "p": h.p, "q": h.q, "site": h.site, "tier": tier_name(h.tier),
                "final": true, "shield_until_bell": shield_bell, "walls": h.walls,
            },
            "stores": units_of(&stores),
            "rates_per_hour": units_of(&h.production),
            "queue": queue_json(h, now),
            "reserve": h.reserve[..7].to_vec(),
            "garrison": garrison,
            "home_troops": inp.home_troops,
            "home_troops_day_start": inp.ds.h0,
            "hosts": inp.rows.iter().map(|r| host_json(r, h, bell)).collect::<Vec<_>>(),
            "explore": if h.explore.state == 0 { "idle" } else { "pending" },
            "muster_room": room,
            "quota": {"bucket_left": bucket_left, "relay_left": quota.1},
        },
        "neighbourhood": neighbourhood,
        "my_clashes": [],
    })
}

/// A one-line description of the autopilot's economy (§4.1 `autopilot.summary`).
pub fn describe(intents: &[Intent]) -> String {
    let mut parts: Vec<String> = vec![];
    for it in intents {
        match it {
            Intent::Build { item, walls, .. } => parts.push(if *walls {
                "build walls".to_string()
            } else {
                format!("build {}", building_name(*item))
            }),
            Intent::Train { unit, n, .. } => parts.push(format!("train {n} {}", unit_name(*unit))),
            Intent::Muster { unit, troops, .. } => {
                parts.push(format!("muster {troops} {}", unit_name(*unit)))
            }
            Intent::Explore { .. } => parts.push("explore".to_string()),
            _ => {}
        }
    }
    if parts.is_empty() {
        "nothing to do (economy and duties only)".to_string()
    } else {
        format!("{} (economy and duties only)", parts.join("; "))
    }
}

// ------------------------------------------------------------------ autopilot filter

/// Splits the rule policy's intents into duties D (sent at once) and the
/// rest (§3.1 step 2).
pub fn split_duties(a: Vec<Intent>) -> (Vec<Intent>, Vec<Intent>) {
    a.into_iter().partition(|i| KEPT_DUTIES.contains(&i.name()))
}

/// The autopilot filter (§3.6): from the non-duty part of the rule policy's
/// intents keep the economy (Build, Train, Muster, Explore; **skipped while
/// `quota_left ≤ QUOTA_FLOOR`**, §3.4), drop every voluntary march and the
/// persona-only intents, and add the Strike-Order follow marches (already
/// filtered by the standing orders). Pure; the lists are [`KEPT_ECONOMY`]
/// and [`DROPPED`].
pub fn autopilot_filter(rest: Vec<Intent>, follow: Vec<Intent>, quota_left: u32) -> Vec<Intent> {
    autopilot_filter_counted(rest, follow, quota_left).0
}

/// [`autopilot_filter`] and the number of economy intents the quota floor
/// held back (the report's quota-starved count).
pub fn autopilot_filter_counted(
    rest: Vec<Intent>,
    follow: Vec<Intent>,
    quota_left: u32,
) -> (Vec<Intent>, usize) {
    let mut skipped = 0;
    let mut out: Vec<Intent> = vec![];
    for i in rest {
        if !KEPT_ECONOMY.contains(&i.name()) {
            continue;
        }
        if quota_left > QUOTA_FLOOR {
            out.push(i);
        } else {
            skipped += 1;
        }
    }
    out.extend(
        follow
            .into_iter()
            .filter(|i| matches!(i, Intent::Depart(_))),
    );
    (out, skipped)
}

fn sponsored(it: &Intent) -> bool {
    match it {
        Intent::Depart(d) => d.route == Route::Relay,
        Intent::Reveal { .. }
        | Intent::Prefund { .. }
        | Intent::SettleOwnTicket { .. }
        | Intent::Hold { .. }
        | Intent::Nudge { .. } => false,
        _ => true,
    }
}

// ------------------------------------------------------------------ V6

/// Why a chosen intent was dropped (counted by reason).
pub type V6Reason = &'static str;

/// The parameters of one chosen candidate from the answer.
#[derive(Clone, Debug, Default)]
pub struct ChosenParams {
    pub stance: Option<u8>,
    pub retreat: Option<u16>,
    pub share: Option<u32>,
}

impl ChosenParams {
    pub fn from_json(v: Option<&Value>) -> ChosenParams {
        let Some(v) = v else {
            return ChosenParams::default();
        };
        ChosenParams {
            stance: v
                .get("stance")
                .and_then(Value::as_str)
                .and_then(stance_code),
            retreat: v
                .get("retreat")
                .and_then(Value::as_u64)
                .map(|x| x.min(u16::MAX as u64) as u16),
            share: v
                .get("share")
                .and_then(Value::as_u64)
                .map(|x| x.min(100) as u32),
        }
    }
}

/// What a decision has already chosen (for the caps and the one action per
/// host rule).
#[derive(Default)]
pub struct Taken {
    pub hosts: BTreeSet<u64>,
    pub march_troops: u32,
    pub marches: usize,
    /// Build items (buildings and walls) already chosen in this decision.
    pub builds: usize,
    /// What the chosen builds and trains cost together (milli-units).
    pub spent: [i64; RESOURCES],
}

/// Free build-queue slots at `now` (`policy::queue_free` counts running items).
pub fn queue_free_slots(h: &Holding, now: i64) -> usize {
    let slots = [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold]
        .get(h.tier as usize)
        .map_or(2, |t| t.queue_slots());
    let busy = h
        .queue
        .iter()
        .filter(|q| q.kind != 0 && q.done_at > now)
        .count();
    slots.saturating_sub(busy)
}

/// V6 (§4.5) for one chosen action against the **fresh** observation: the
/// march is planned again (same host, target and timing) and must still be
/// allowed (`shield_refuses` false, the host ready, the target still there),
/// a build, train or muster must still be affordable and have room, the
/// caps are recomputed, and a host takes at most one action. Returns the
/// intent and, for a march, its troops.
pub fn replan(
    action: &Action,
    p: &ChosenParams,
    inp: &Inputs,
    taken: &mut Taken,
    st: &Standing,
) -> Result<(Intent, Option<u32>), V6Reason> {
    let obs = inp.obs;
    let h = inp.h;
    let now = obs.now;
    let bell = obs.bell();
    let doctrine = &DOCTRINES[(h.faction % 6) as usize];
    let mut stores = policy::stores_at(h, now);
    for (s, c) in stores.iter_mut().zip(taken.spent.iter()) {
        *s -= c;
    }
    match action {
        Action::Autopilot | Action::Hold { .. } => Err("not an action"),
        Action::March {
            host_id,
            target,
            kind,
            ..
        } => {
            let row = inp
                .rows
                .iter()
                .find(|r| r.e.id == *host_id)
                .ok_or("host gone")?;
            if !row.ready {
                return Err("host not ready");
            }
            if taken.hosts.contains(host_id) {
                return Err("host already used");
            }
            // The target must still be there.
            match kind {
                MarchKind::Camp => {
                    let live = obs.province(target.p, target.q).is_some_and(|pv| {
                        pv.camp.state != 0
                            && pv.camp.tile == target.tile
                            && pv.passable_mask >> pv.camp.tile & 1 == 1
                    });
                    if !live {
                        return Err("target gone");
                    }
                }
                MarchKind::Field => {
                    let there = obs.province(target.p, target.q).is_some_and(|pv| {
                        pv.entries.iter().any(|e| {
                            e.state == le::STATE_ROSTER
                                && e.tile == target.tile
                                && e.faction < 6
                                && e.faction != h.faction % 6
                        })
                    });
                    if !there {
                        return Err("target gone");
                    }
                }
                _ => {}
            }
            let troops = row.troops();
            if let Some(v) = caps_violation(
                taken.march_troops + troops,
                taken.marches + 1,
                inp.home_troops,
                inp.ds,
                Some(st),
            ) {
                return Err(v);
            }
            let stance = p.stance.unwrap_or_else(|| default_stance(inp.faction));
            let (plan, _, _) = plan_depart(
                obs,
                h,
                row.at,
                &row.e,
                *target,
                0,
                stance,
                p.retreat.unwrap_or(0),
                inp.presets,
            )
            .ok_or("no plan or shield")?;
            taken.hosts.insert(*host_id);
            taken.march_troops += troops;
            taken.marches += 1;
            Ok((Intent::Depart(Box::new(plan)), Some(troops)))
        }
        Action::Build { item } => {
            if taken.builds >= queue_free_slots(h, now) {
                return Err("queue full");
            }
            let n = policy::copies(h, *item, now) + 1;
            let (cost, _, _) = catalog::building(*item, n, doctrine).ok_or("not priced")?;
            if !afford(&stores, &cost) {
                return Err("not affordable");
            }
            taken.builds += 1;
            for (s, c) in taken.spent.iter_mut().zip(cost.iter()) {
                *s += c;
            }
            Ok((
                Intent::Build {
                    h: href(h),
                    item: *item,
                    walls: false,
                },
                None,
            ))
        }
        Action::Walls => {
            if taken.builds >= queue_free_slots(h, now) {
                return Err("queue full");
            }
            let (cost, _, _) =
                catalog::building(catalog::ITEM_WALLS, 1, doctrine).ok_or("not priced")?;
            if !afford(&stores, &cost) {
                return Err("not affordable");
            }
            taken.builds += 1;
            for (s, c) in taken.spent.iter_mut().zip(cost.iter()) {
                *s += c;
            }
            Ok((
                Intent::Build {
                    h: href(h),
                    item: catalog::ITEM_WALLS,
                    walls: true,
                },
                None,
            ))
        }
        Action::Train { unit } => {
            let k = max_train(&stores, *unit);
            if k < MIN_HOST {
                return Err("not affordable");
            }
            let n = share_of(k, p.share.unwrap_or(50)).min(k);
            if let Some(cost) = catalog::train(*unit, n) {
                for (s, c) in taken.spent.iter_mut().zip(cost.iter()) {
                    *s += c;
                }
            }
            Ok((
                Intent::Train {
                    h: href(h),
                    unit: *unit,
                    n,
                },
                None,
            ))
        }
        Action::Muster { unit } => {
            let reserve = h.reserve[*unit as usize];
            if reserve < MIN_HOST {
                return Err("no reserve");
            }
            let room = obs
                .province(h.p, h.q)
                .map_or(0, |pv| policy::muster_room(pv, h.faction));
            if room == 0 {
                return Err("no room");
            }
            let troops = share_of(reserve, p.share.unwrap_or(50)).min(reserve / 100 * 100);
            Ok((
                Intent::Muster {
                    h: href(h),
                    unit: *unit,
                    troops,
                    tile: h.tile,
                },
                None,
            ))
        }
        Action::Explore { host_id } => {
            if h.explore.state != 0 {
                return Err("explore pending");
            }
            let row = inp
                .rows
                .iter()
                .find(|r| r.e.id == *host_id)
                .ok_or("host gone")?;
            if row.in_transit || !ready::ready_host(h, &row.e, bell, true) {
                return Err("host not ready");
            }
            if taken.hosts.contains(host_id) {
                return Err("host already used");
            }
            let tiles = explore_tiles(obs, row, 1 + (inp.faction < 6) as usize)
                .ok_or("nothing to explore")?;
            taken.hosts.insert(*host_id);
            Ok((
                Intent::Explore {
                    h: href(h),
                    at: row.at,
                    host_id: *host_id,
                    tiles,
                },
                None,
            ))
        }
    }
}

/// The residency gate for what the brain itself sends (§3.1): `Muster`,
/// `Explore` and `Depart` whose province is behind are replaced by a nudge
/// of it (`policy::residency_gate`); a walls Build needs its province too.
/// Returns whether the gate added a nudge.
pub fn gate(obs: &Observation, out: &mut Vec<Intent>) -> bool {
    let bell = obs.bell();
    let nudges = |v: &Vec<Intent>| {
        v.iter()
            .filter(|i| matches!(i, Intent::Nudge { .. }))
            .count()
    };
    let before = nudges(out);
    let mut walls_nudge: Option<(i16, i16)> = None;
    out.retain(|it| {
        if let Intent::Build { h, walls: true, .. } = it {
            let ok = obs
                .province(h.p, h.q)
                .is_none_or(|pv| fclient::play::resident_ok(pv.resolved_next, bell));
            if !ok {
                walls_nudge = Some((h.p, h.q));
            }
            return ok;
        }
        true
    });
    policy::residency_gate(obs, out);
    if let Some(province) = walls_nudge {
        if !out
            .iter()
            .any(|i| matches!(i, Intent::Nudge { province: p } if *p == province))
        {
            out.push(Intent::Nudge { province });
        }
    }
    nudges(out) > before
}

// ------------------------------------------------------------------ the step

/// `standing::RESERVE_BELLS`, re-exported for the tests.
pub const RESERVE_BELLS_FOR_TEST: u32 = RESERVE_BELLS;

/// A key that identifies an intent across the passes of one bell (the
/// "sent already" set). Nudges are never remembered: a repeat may need one.
fn intent_key(it: &Intent) -> Option<String> {
    use std::hash::{Hash, Hasher};
    if matches!(it, Intent::Nudge { .. }) {
        return None;
    }
    let mut s = std::collections::hash_map::DefaultHasher::new();
    format!("{it:?}").hash(&mut s);
    Some(format!("ap:{}:{:x}", it.name(), s.finish()))
}

/// What a pass of sending did.
#[derive(Default)]
struct Sent {
    n: usize,
    floor_skips: usize,
}

/// Sends intents with the relay-quota rules of the rule bots (`Bot::step`):
/// nothing sponsored at 0 left; the economy, which is not a Depart,
/// SettleTransit or Join, keeps `QUOTA_RESERVE`; the **autopilot's**
/// Build/Train/Muster/Explore additionally keep `QUOTA_FLOOR` (`floor`).
/// A Depart that landed goes into the marchbook. `done` collects the keys
/// of what was sent OK, so a same-bell repeat does not send it twice.
#[allow(clippy::too_many_arguments)]
async fn send_intents<H: HeraldPort, R: RelayPort, D: DirectPort>(
    bot: &mut Bot,
    sh: &Shared<H, R, D>,
    hook: &AiHook,
    obs: &Observation,
    intents: Vec<Intent>,
    floor: bool,
    by: By,
    troops_of: &BTreeMap<u64, u32>,
    done: &mut BTreeSet<String>,
) -> Sent {
    let mut sent = Sent::default();
    let bell = obs.bell();
    for it in intents {
        let key = intent_key(&it);
        if key.as_ref().is_some_and(|k| done.contains(k)) {
            continue;
        }
        let q = bot.ai_quota_left(obs);
        let sp = sponsored(&it);
        if q == 0 && sp {
            continue;
        }
        if sp
            && !matches!(
                it,
                Intent::Depart(_) | Intent::SettleTransit { .. } | Intent::Join { .. }
            )
            && q <= QUOTA_RESERVE
        {
            continue;
        }
        if floor && KEPT_ECONOMY.contains(&it.name()) && q <= QUOTA_FLOOR {
            sent.floor_skips += 1;
            continue;
        }
        let depart = match &it {
            Intent::Depart(p) => Some((
                p.host_id,
                p.plain.dest_p,
                p.plain.dest_q,
                p.plain.dest_tile,
                p.plain.arrive_bell,
            )),
            _ => None,
        };
        let from = hook.outcomes_len(bot.spec.index);
        sent.n += bot.act(sh, obs, it).await;
        let ok = hook
            .outcomes_since(bot.spec.index, from)
            .iter()
            .all(|o| o.ok);
        if let (true, Some(k)) = (ok, key) {
            done.insert(k);
        }
        if let Some((host, p, q, tile, arrive)) = depart {
            if bot.mem.march((host, bell)).is_some_and(|m| m.sent) {
                let troops = troops_of.get(&host).copied().unwrap_or(0);
                bot.ai.book.push(BookMarch {
                    host_id: host,
                    troops_at_depart: troops,
                    depart_bell: bell,
                    arrive_bell: arrive,
                    dest: (p, q, tile),
                    by,
                    via: None,
                });
                if by == By::Model {
                    if let Some(ds) = bot.ai.day.as_mut() {
                        ds.marches.push((bell, troops));
                    }
                    hook.stat("model_marches_sent");
                    hook.note_model_march(bot.spec.index, bell);
                }
            }
        }
    }
    sent
}

fn real_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The wall budget of a mind call and the deadline it is sent with (§3.4,
/// §3.5): the bell's end minus `margin = max(3 s real, 60 game-s ÷ scale)`.
/// A fixed clock (tests) uses `AiHook::fixed_call_budget`.
fn call_budget<H, R, D>(sh: &Shared<H, R, D>, hook: &AiHook, obs: &Observation) -> (Duration, u64) {
    match &sh.clock {
        ClockSource::Fixed(_) => (
            hook.fixed_call_budget,
            real_ms() + hook.fixed_call_budget.as_millis() as u64,
        ),
        ClockSource::Game(_) => {
            let scale = sh.clock.scale().max(1.0);
            let margin_game = (MARGIN_REAL_SECS * scale).max(60.0) as i64;
            let end = fclient::clock::bell_end(obs.season.genesis_ts, obs.bell());
            let wall = sh.clock.wall_until(end - margin_game);
            (wall, real_ms() + wall.as_millis() as u64)
        }
    }
}

/// `obs_digest` (§4.1): sha256 of the sorted `(path, sha256)` list of the
/// herald files the brain read for this decision: `/h/me/<wallet>` and every
/// `/h/province/<p>,<q>/latest` of the observation, re-read by the brain
/// itself (`observe` keeps no per-bot raw bytes). A file that changed
/// between the two reads digests differently from what `observe` saw.
pub async fn obs_digest<H: HeraldPort>(
    herald: &H,
    wallet: &str,
    me_raw: &[u8],
    obs: &Observation,
) -> String {
    let mut lines: Vec<(String, String)> = vec![];
    if !me_raw.is_empty() {
        lines.push((
            format!("/h/me/{wallet}"),
            hex::encode(Sha256::digest(me_raw)),
        ));
    }
    for &(p, q) in obs.provinces.keys() {
        let path = format!("/h/province/{p},{q}/latest");
        if let Ok(Some(b)) = herald.get(&path).await {
            lines.push((path, hex::encode(Sha256::digest(&b))));
        }
    }
    lines.sort();
    let mut h = Sha256::new();
    for (p, d) in &lines {
        h.update(p.as_bytes());
        h.update(b" ");
        h.update(d.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

fn own_marches(bot: &Bot, bell: u32, me: &MeExtra) -> Vec<OwnMarch> {
    bot.ai
        .book
        .iter()
        .map(|m| {
            let public = bot
                .mem
                .march((m.host_id, m.depart_bell))
                .is_some_and(|x| x.revealed || x.settled);
            OwnMarch {
                host_id: m.host_id,
                troops_at_depart: m.troops_at_depart,
                depart_bell: m.depart_bell,
                arrive_bell: m.arrive_bell,
                opened: meview::opened_of(m.host_id, m.arrive_bell, m.dest, bell, public, me),
            }
        })
        .collect()
}

/// The marchbook keeps a march for a day after its arrival.
const BOOK_KEEP_BELLS: u32 = BELLS_PER_DAY;

/// The Citizen's `citizen_tag` as the wire's 16 hex digits.
pub fn tag_hex(obs: &Observation) -> String {
    obs.me.citizen.as_ref().map_or_else(
        || "0".repeat(16),
        |(_, c)| format!("{:016x}", c.citizen_tag),
    )
}

/// One step of an AI bot (§3.1), entered from the `bot.rs` hook after
/// `policy::decide` produced `a`:
///
/// 1. send the duties D at once; stop there without a session or a home;
/// 2. build the candidates and ask the mind (a same-bell repeat reuses the
///    cached answer: no call, no new record);
/// 3. apply the autopilot filter → A'; a model answer, or one older than 30
///    game-s, is re-observed (so **every** model answer is);
/// 4. V6 on the chosen intents against the fresh observation; send; report
///    the outcome.
///
/// Anything late, invalid or refused runs A'. Returns the actions sent.
pub async fn step_ai<H: HeraldPort, R: RelayPort, D: DirectPort>(
    bot: &mut Bot,
    sh: &Shared<H, R, D>,
    obs: Observation,
    a: Vec<Intent>,
    session: bool,
) -> usize {
    use fclient::Signer;
    let hook = sh.ai.clone().expect("ai hook installed");
    let index = bot.spec.index;
    hook.stat("steps");
    bot.ai_spent_reset();
    let _ = hook.take_outcomes(index);
    let t_start = obs.now;
    let bell0 = obs.bell();
    bot.ai.standing.expire(bell0);
    let mut done: BTreeSet<String> = match &bot.ai.cache {
        Some(c) if c.bell == bell0 => c.done.clone(),
        _ => BTreeSet::new(),
    };
    let wallet_key = bot.wallet.pubkey();
    let wallet = wallet_key.to_string();
    let (d, rest) = split_duties(a);
    let troops_of: BTreeMap<u64, u32> = home_holding(&obs)
        .map(|h| {
            host_rows(&obs, h)
                .into_iter()
                .map(|r| (r.e.id, r.troops()))
                .collect()
        })
        .unwrap_or_default();
    let mut sent = send_intents(
        bot,
        sh,
        &hook,
        &obs,
        d,
        false,
        By::Autopilot,
        &troops_of,
        &mut done,
    )
    .await
    .n;
    // The ending of every path: remember what was sent this bell, count the step.
    let end_step = |bot: &mut Bot, sent: usize, done: BTreeSet<String>| -> usize {
        if let Some(c) = bot.ai.cache.as_mut() {
            if c.bell == bell0 {
                c.done = done;
            }
        }
        sh.report.lock().expect("report").steps += 1;
        sent
    };
    let Some(h) = home_holding(&obs) else {
        return end_step(bot, sent, done);
    };
    if !session {
        return end_step(bot, sent, done);
    }
    let faction = h.faction;
    bot.ai
        .book
        .retain(|m| m.arrive_bell + BOOK_KEEP_BELLS > bell0);
    let rows = host_rows(&obs, h);
    hook.note_step(
        index,
        bell0,
        &rows
            .iter()
            .filter(|r| r.ready)
            .map(|r| r.e.id)
            .collect::<Vec<_>>(),
    );
    let (home, _) = home_troops(&obs, h, &rows);
    let day = bell0 / BELLS_PER_DAY;
    if bot.ai.day.as_ref().is_none_or(|d| d.day != day) {
        bot.ai.day = Some(DayState {
            day,
            h0: home,
            marches: vec![],
        });
    }
    let ds = bot.ai.day.clone().expect("day state");
    let (me_extra, me_raw) = match meview::fetch(&sh.herald, &wallet).await {
        Ok(x) => x,
        Err(_) => {
            hook.stat("me_read_failed");
            (MeExtra::default(), vec![])
        }
    };
    let follow = standing::filter_follow(
        super::follow_intents(bot, &obs),
        &bot.ai.standing,
        bell0,
        None,
    );
    let quota_now = bot.ai_quota_left(&obs);
    let inp = Inputs {
        obs: &obs,
        h,
        faction,
        ds: &ds,
        presets: obs.season.tip_presets(sh.cfg.reveal_loaded_limit()),
        autopilot_summary: describe(&autopilot_filter(rest.clone(), vec![], quota_now)),
        rows: rows.clone(),
        home_troops: home,
        quota_left: quota_now,
    };
    let offers = candidates(&inp);
    let ready_now: BTreeSet<u64> = rows.iter().filter(|r| r.ready).map(|r| r.e.id).collect();
    let in_flight: BTreeSet<u64> = bot.ai.book.iter().map(|m| m.host_id).collect();
    let mut wake_hints = vec![];
    if ready_now
        .iter()
        .any(|id| !bot.ai.prev_ready.contains(id) && !in_flight.contains(id))
    {
        wake_hints.push("W-READY".to_string());
    }
    if offers
        .iter()
        .any(|o| matches!(o.action, Action::Build { .. }))
    {
        wake_hints.push("W-QUEUE".to_string());
    }
    bot.ai.prev_ready = ready_now;
    let quota = (
        obs.me
            .citizen
            .as_ref()
            .map_or(0, |(_, c)| c.bucket_milli / 1_000),
        obs.me.quota_left.unwrap_or(40),
    );
    let answer: Option<Answer> = match bot.ai.cache.as_ref().filter(|c| c.bell == bell0) {
        Some(c) => {
            hook.stat("answers_reused");
            Some(c.answer.clone())
        }
        None => match &hook.mind {
            None => {
                hook.stat("no_mind");
                None
            }
            Some(mind) => {
                let (budget, deadline_ms) = call_budget(sh, &hook, &obs);
                let req = DecideRequest {
                    ai: super::mindport::AiRef {
                        index,
                        wallet: wallet.clone(),
                        tag: tag_hex(&obs),
                    },
                    bell: bell0,
                    now_game: obs.now,
                    scale: sh.clock.scale(),
                    deadline_unix_ms: deadline_ms,
                    wake_hints,
                    obs_digest: obs_digest(&sh.herald, &wallet, &me_raw, &obs).await,
                    situation: situation(&inp, quota),
                    candidates: offers.iter().map(|o| o.cand.clone()).collect(),
                    own_marches: own_marches(bot, bell0, &me_extra),
                    autopilot: AutopilotSummary {
                        summary: inp.autopilot_summary.clone(),
                        has_military: rows.iter().any(|r| r.e.unit != ready::SCOUT),
                        departs: follow
                            .iter()
                            .filter_map(|i| match i {
                                Intent::Depart(p) => Some(FollowDepart {
                                    host_id: p.host_id,
                                    p: p.plain.dest_p,
                                    q: p.plain.dest_q,
                                    tile: p.plain.dest_tile,
                                    arrive_bell: p.plain.arrive_bell,
                                }),
                                _ => None,
                            })
                            .collect(),
                    },
                };
                match mind.decide(&req, budget).await {
                    Ok(ans) => {
                        hook.stat(match ans.mode {
                            Mode::Model => "answers_model",
                            Mode::Autopilot => "answers_autopilot",
                        });
                        bot.ai.cache = Some(Cached {
                            bell: bell0,
                            answer: ans.clone(),
                            done: done.clone(),
                        });
                        Some(ans)
                    }
                    Err(e) => {
                        hook.stat(match e {
                            MindError::NoTime => "fallback_no_time",
                            MindError::Transport(_) => "fallback_mind_down",
                            MindError::Status(..) => "fallback_mind_status",
                            MindError::Bad(_) => "fallback_mind_bad_answer",
                        });
                        None
                    }
                }
            }
        },
    };
    if let Some(ans) = &answer {
        for r in &ans.standing.reserved {
            bot.ai.standing.reserve(r.host_id, r.until_bell);
        }
        for p in &ans.standing.declined_calls {
            if !bot.ai.standing.declined_calls.contains(p) {
                bot.ai.standing.declined_calls.push(*p);
            }
        }
    }
    let model = answer.as_ref().is_some_and(|a| a.mode == Mode::Model);
    let aged = sh.clock.now().is_some_and(|n| n - t_start > STALE_SECS);
    // §3.1 step 5: re-observe and recompute A (and A') before V6 and
    // sending. A model answer always is re-observed (30 game-s are 3 s real
    // at 10×); so is any answer that took longer than 30 game-s.
    let mut fresh: Option<Observation> = None;
    if model || aged {
        hook.stat("reobserved");
        match bot.observe(sh).await {
            Ok(o2) => {
                bot.reconcile(sh, &o2);
                fresh = Some(o2);
            }
            Err(_) => {
                hook.stat("reobserve_failed");
                bot.nudged = false;
                return end_step(bot, sent, done);
            }
        }
    }
    let obs2: &Observation = fresh.as_ref().unwrap_or(&obs);
    let Some(h2) = home_holding(obs2) else {
        return end_step(bot, sent, done);
    };
    let rows2 = host_rows(obs2, h2);
    let (home2, _) = home_troops(obs2, h2, &rows2);
    let ds2 = bot.ai.day.clone().expect("day state");
    let troops2: BTreeMap<u64, u32> = rows2.iter().map(|r| (r.e.id, r.troops())).collect();
    let inp2 = Inputs {
        obs: obs2,
        h: h2,
        faction,
        ds: &ds2,
        presets: obs2.season.tip_presets(sh.cfg.reveal_loaded_limit()),
        autopilot_summary: String::new(),
        rows: rows2,
        home_troops: home2,
        quota_left: bot.ai_quota_left(obs2),
    };
    // A' on the observation the brain sends from.
    let floor_held = std::sync::atomic::AtomicUsize::new(0);
    let autopilot_now = |bot: &Bot| -> Vec<Intent> {
        if fresh.is_none() {
            let (a, n) = autopilot_filter_counted(rest.clone(), follow.clone(), quota_now);
            floor_held.store(n, std::sync::atomic::Ordering::Relaxed);
            return a;
        }
        let cx = Ctx {
            spec: &bot.spec,
            seed: sh.cfg.seed,
            wallet: wallet_key,
            mem: &bot.mem,
            reveal_loaded_limit: sh.cfg.reveal_loaded_limit(),
            direct: sh.direct.is_some(),
            session,
        };
        let (_, rest2) = split_duties(policy::decide(obs2, &cx));
        let follow2 = standing::filter_follow(
            super::follow_intents(bot, obs2),
            &bot.ai.standing,
            bell0,
            None,
        );
        let (a, n) = autopilot_filter_counted(rest2, follow2, bot.ai_quota_left(obs2));
        floor_held.store(n, std::sync::atomic::Ordering::Relaxed);
        a
    };
    let mut floor = true;
    let mut by = By::Autopilot;
    let mut own_gate_nudge = false;
    let mut chosen_keys: Vec<String> = vec![];
    let to_send: Vec<Intent> = if model {
        let ans = answer.as_ref().expect("model answer");
        let mut taken = Taken::default();
        let mut chosen: Vec<Intent> = vec![];
        let (mut wants_autopilot, mut hold, mut already_sent) = (false, false, 0usize);
        for id in &ans.ids {
            let Some(o) = offers.iter().find(|o| o.cand.id == *id) else {
                continue;
            };
            match &o.action {
                Action::Autopilot => wants_autopilot = true,
                Action::Hold { hosts } => {
                    hold = true;
                    for hst in hosts {
                        bot.ai.standing.reserve(*hst, bell0 + RESERVE_BELLS);
                    }
                }
                act => {
                    if done.contains(&o.identity()) {
                        already_sent += 1;
                        continue;
                    }
                    let p = ChosenParams::from_json(ans.params.get(id));
                    match replan(act, &p, &inp2, &mut taken, &ans.standing) {
                        Ok((it, _)) => {
                            chosen_keys.push(o.identity());
                            chosen.push(it);
                        }
                        Err(reason) => {
                            hook.stat("v6_dropped");
                            hook.stat(&format!("v6_dropped:{reason}"));
                        }
                    }
                }
            }
        }
        if wants_autopilot {
            autopilot_now(bot)
        } else if !chosen.is_empty() {
            floor = false;
            by = By::Model;
            own_gate_nudge = gate(obs2, &mut chosen);
            chosen
        } else if hold || already_sent > 0 {
            vec![]
        } else {
            hook.stat("v6_all_refused");
            autopilot_now(bot)
        }
    } else {
        autopilot_now(bot)
    };
    let to_send = if floor {
        let mut g = to_send;
        gate(obs2, &mut g);
        g
    } else {
        to_send
    };
    let first = hook.outcomes_len(index);
    let s = send_intents(
        bot, sh, &hook, obs2, to_send, floor, by, &troops2, &mut done,
    )
    .await;
    sent += s.n;
    let skipped = s.floor_skips + floor_held.load(std::sync::atomic::Ordering::Relaxed);
    if skipped > 0 {
        hook.stat_n("quota_floor_skips", skipped as u64);
        hook.stat("quota_starved_bells");
    }
    // A chosen action that landed is not sent again on a same-bell repeat.
    let landed = hook.outcomes_since(index, first);
    if by == By::Model && !landed.is_empty() && landed.iter().all(|o| o.ok) {
        done.extend(chosen_keys);
    }
    // A nudge on the brain's own behalf (a chosen action waiting for its
    // province) re-runs the step later in the bell; the rule policy's do not.
    bot.nudged = bot.nudged && own_gate_nudge;
    if let (Some(ans), Some(mind)) = (&answer, &hook.mind) {
        let actions = hook.take_outcomes(index);
        let own = own_marches(bot, obs2.bell(), &me_extra);
        let body = super::mindport::outcome_json(&ans.decision_id, &actions, &own);
        if mind.outcome(&body, Duration::from_secs(3)).await.is_err() {
            hook.stat("outcome_post_failed");
        }
    }
    end_step(bot, sent, done)
}
