//! Attack behaviour under the MC rules: the lone attacker (each session
//! rolls its own attack, as the balance lab measured) and the faction
//! campaign planner of §8.6 (`--policy campaign`), ported from the
//! off-chain design (§7.1): hourly epochs, deterministic plans per faction
//! from public state only, ≤ ⌈members / 40⌉ campaigns with hysteresis
//! (kept until won, failed twice or illegal), assignment of members within
//! one march ranked by spare troops, one common arrival bell, a defence
//! plan (hosts that can arrive before 25% progress), boldness margins per
//! archetype, the Herald's Call as a tie-breaker, and `--forward` staging.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::*;
use crate::mc::cqk::NO_FACTION;
use crate::mc::{BotProfile, Policy};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    Keep(u32),
    Hold(u32),
}

/// One launch of a campaign: who went, and when they meet.
#[derive(Clone, Debug)]
pub struct Attempt {
    pub muster: u32,
    /// Hosts sent (sealed marches naming `muster`).
    pub hosts: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Campaign {
    pub target: Target,
    pub fails: u8,
    pub attempt: Option<Attempt>,
    /// Bell the campaign was chosen or its last attempt ended: a campaign
    /// nobody can launch for `STALE_BELLS` leaves the plan.
    pub idle_since: u32,
}

/// A defence need of the epoch: the mission, province, tile, the last
/// bell a relief may arrive (25% progress) and the attacker.
#[derive(Clone, Copy, Debug)]
struct Relief {
    mission: Mission,
    pi: u32,
    tile: u8,
    deadline: u32,
    attacker: u8,
}

/// Boldness margin per archetype (§8.6): attack only with this multiple of
/// the estimated defence. `None` = never.
pub fn margin(a: Arch) -> Option<f64> {
    match a {
        Arch::Idle => None,
        Arch::Casual => Some(3.0),
        Arch::Daily => Some(2.0),
        Arch::Skilled => Some(1.5),
        Arch::VerySkilled => Some(1.3),
        Arch::Bot => Some(1.5),
    }
}

/// The group's target strength over the estimated defence.
pub const GROUP_MARGIN: f64 = 1.5;
/// Hosts per campaign wave: a faction's arrival slots per province-bell.
pub const WAVE_HOSTS: usize = 4;
/// Campaigns per faction kept for player holdings when one is legal
/// (`Config::holding_slots` default; `--mc holding_slots=N`).
pub const HOLDING_SLOTS: usize = 1;
/// A campaign with no attempt for this long is dropped (no member can
/// launch it: the slot goes to another target).
pub const STALE_BELLS: u32 = 24;

/// A member that can send: (agent, source, spare troops, earliest
/// arrival); `source` is a holding or, with `staged`, a forward host.
#[derive(Clone, Copy, Debug)]
struct Member {
    agent: u32,
    src: u32,
    staged: bool,
    spare: MilliTroops,
    arrive: u32,
}

impl Sim {
    fn epoch_driven(&self, a: u32) -> bool {
        self.agents[a as usize].arch == Arch::Bot && self.cfg.bot_profile != BotProfile::Sim
    }

    fn per_troop(&self, f: u8) -> f64 {
        permutation_rules::units::stats(self.doctrine[f as usize].k.unit).strength as f64
    }

    fn keep_back(&self, hid: u32) -> MilliTroops {
        troops(garrison_target(self.holds[hid as usize].h.tier) / 4)
    }

    /// Strength of faction `f`'s hosts on a tile.
    fn tile_strength(&self, pi: u32, tile: u8, f: u8, same: bool) -> f64 {
        self.prov(pi)
            .stationed
            .iter()
            .map(|&h| &self.hosts[h as usize])
            .filter(|y| y.tile == tile && y.state != HState::Dead && (y.faction == f) == same)
            .map(|y| host_strength(y.unit, y.troops) as f64)
            .sum()
    }

    /// The relief faction `g` is expected to bring to `pi` (§8.6's
    /// "standing auto-reinforce"): both policies relieve by the standing
    /// order (the 4 largest 25% shares of its March holdings), so the
    /// estimate is the balance lab's `keep_reinforcement`.
    fn mc_relief(&self, pi: u32, g: u8) -> f64 {
        if (g as usize) >= 6 {
            return 0.0;
        }
        self.keep_reinforcement(pi, g)
    }

    /// Estimated defence of a keep (public state): its garrison behind
    /// walls, the holder's hosts on the tile, the holder's relief.
    pub(super) fn mc_keep_def(&self, pi: u32) -> f64 {
        let k = self.prov(pi).mkeep.expect("keep");
        crate::mc::cqk::keep_milli(&k) as f64 * 10.0 * 1.5
            + self.tile_strength(pi, k.tile, k.holder, true)
            + self.mc_relief(pi, k.holder)
    }

    /// Estimated defence of a holding: garrison (×1.5 behind walls), the
    /// owner's hosts on the hex, the owner faction's relief.
    pub(super) fn mc_hold_def(&self, t: u32) -> f64 {
        let (garrison, walls, pi, tile, f, fc) = {
            let x = &self.holds[t as usize];
            (
                x.garrison,
                x.h.walls,
                x.prov,
                x.tile,
                x.faction,
                x.free_city(),
            )
        };
        let mut d = garrison as f64 * 10.0 * if walls > 0 { 1.5 } else { 1.0 };
        d += self.tile_strength(pi, tile, f, true);
        if !fc {
            d += self.mc_relief(pi, f);
        }
        d
    }

    /// Value of taking keep `pi` for `f` (the balance lab's control-aware
    /// rule: ×3 when it tips the March banner, ×1.5 when `f` already holds
    /// keeps there) and the Herald's Call bonus.
    fn mc_keep_value(&self, pi: u32, f: u8, call: bool) -> f64 {
        let pr = self.prov(pi);
        let mut value = 1.2;
        let m = pr.march;
        let (mut own, mut open) = (0u32, 0u32);
        for q in permutation_rules::frontier::geometry::march_members(march_of(pr.coord)) {
            if let Some(qi) = self.prov_at(q) {
                let qq = self.prov(qi);
                if qq.march != m || qq.mkeep.is_none() {
                    continue;
                }
                open += 1;
                if qq.mkeep.is_some_and(|x| x.holder == f) {
                    own += 1;
                }
            }
        }
        if (own + 1) * 2 > open && own * 2 <= open {
            value *= 3.0;
        } else if own > 0 {
            value *= 1.5;
        }
        if call && self.mcs.call[f as usize] == m {
            value *= 2.0;
        }
        value
    }

    /// A session's military step under MC: lone rolls or the campaign
    /// plan; epoch-driven bots act only at the planner epoch.
    pub(super) fn mc_military(&mut self, a: u32, b: u32, p: &Profile, mut budget: i64) {
        // `--bot-profile m1`: the plan's decisions plus, with probability
        // `m1_act_p` per epoch, one lone session's rolls (M1's stack bots
        // made ≈ 0.24 Departs per bot-day without a planner).
        let m1_extra = self.cfg.bot_profile == BotProfile::M1
            && self.agents[a as usize].arch == Arch::Bot
            && {
                let q = self.cfg.m1_act_p;
                self.mc_rng().chance(q)
            };
        if self.epoch_driven(a) && !m1_extra {
            return;
        }
        let f = self.agents[a as usize].faction as usize;
        let policy = if m1_extra {
            Policy::Lone
        } else {
            self.cfg.policy[f]
        };
        match policy {
            Policy::Lone => {
                if budget > 2 && self.rng.chance(p.aggression) {
                    budget -= self.mc_war_lone(a, b, p);
                }
                if self.cfg.rules.keeps()
                    && budget > 2
                    && self
                        .rng
                        .chance((p.aggression * self.cfg.cq.keep_aggr).min(1.0))
                {
                    budget -= self.mc_keep_war(a, b, p);
                }
            }
            Policy::Campaign => {
                if budget > 2 {
                    budget -= self.mc_campaign_session(a, b, p);
                }
            }
        }
        if budget > 2 && self.rng.chance(p.aggression) {
            budget -= self.camp_raid(a, b, p);
        }
        if budget > 2 && !self.relics.is_empty() && self.rng.chance(p.aggression) {
            self.relic_move(a, b, p);
        }
    }

    // ------------------------------------------------------ lone attacks

    /// Faction-mates' hosts answering a rally near `tp` (the balance lab's
    /// rule: ≤ `cq.rally` helpers, half the spare garrison each).
    fn mc_rally(
        &mut self,
        a: u32,
        f: u8,
        tp: u32,
        mut got: f64,
        need: f64,
    ) -> Vec<(u32, u32, MilliTroops)> {
        let mut helpers = Vec::new();
        if got >= need || self.cfg.cq.rally == 0 {
            return helpers;
        }
        let tpc = self.prov(tp).coord;
        let mut cands: Vec<(MilliTroops, u32, u32)> = Vec::new();
        for pi in self.provinces_near(tpc, MAX_MARCH_DIST) {
            for &h in &self.prov(pi).site_h {
                if h == NONE {
                    continue;
                }
                let y = &self.holds[h as usize];
                if !y.alive || y.free_city() || y.faction != f || y.owner == a {
                    continue;
                }
                if y.mc.siege.is_some() || y.occupier.is_some() {
                    continue;
                }
                let arch = self.agents[y.owner as usize].arch;
                if arch == Arch::Idle || self.epoch_driven(y.owner) {
                    continue;
                }
                let give = y.garrison.saturating_sub(self.keep_back(h)) / 2;
                if give >= MIN_HOST_TROOPS {
                    cands.push((give, h, y.owner));
                }
            }
        }
        cands.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
        let mut seen: Vec<u32> = vec![a];
        for (give, h, o) in cands {
            if helpers.len() as u32 >= self.cfg.cq.rally || got >= need {
                break;
            }
            if seen.contains(&o) {
                continue;
            }
            let pa = self.profiles[self.agents[o as usize].arch.idx()].aggression;
            if !self.rng.chance(pa.max(0.25)) {
                continue;
            }
            seen.push(o);
            helpers.push((h, o, give));
            got += give as f64;
        }
        if got < need {
            helpers.clear();
        }
        helpers
    }

    /// A lone session's holding siege under MC: strike the hex; the lead
    /// host's owner declares from it on arrival (§3.4).
    pub(super) fn mc_war_lone(&mut self, a: u32, b: u32, p: &Profile) -> i64 {
        let now = now_of(b);
        let (faction, hs) = {
            let ag = &self.agents[a as usize];
            (ag.faction, ag.holdings.clone())
        };
        let Some(&src) = hs.iter().max_by_key(|&&h| self.holds[h as usize].garrison) else {
            return 0;
        };
        let avail = self.holds[src as usize]
            .garrison
            .saturating_sub(self.keep_back(src));
        if avail < 2 * MIN_HOST_TROOPS {
            return 0;
        }
        if self.holds[src as usize].h.stock_at(now)[Resource::Gold as usize]
            < self.cfg.mc.siege_stake_gold * MILLI
        {
            return 0;
        }
        let day = b / BELLS_PER_DAY;
        let ag = &self.agents[a as usize];
        if ag.declares.0 == day && ag.declares.1 >= self.cfg.mc.sieges_per_day {
            return 0;
        }
        let slot = self.mc_free_slot23(a);
        let per_troop = self.per_troop(faction);
        let centre = self.prov(self.holds[src as usize].prov).coord;
        let mut cands: Vec<(f64, u32)> = Vec::new();
        for pi in self.provinces_near(centre, self.cfg.cq.radius) {
            for &t in &self.prov(pi).site_h {
                if t == NONE || self.mcs.pending.contains_key(&t) {
                    continue;
                }
                let x = &self.holds[t as usize];
                if !x.alive || x.faction == faction {
                    continue;
                }
                let capture = x.free_city() || x.h.order >= 2;
                if capture && slot.is_none() {
                    continue;
                }
                if self.mc_record_free(t, faction, b).is_err()
                    || self.mc_may_besiege(t, faction, b).is_err()
                {
                    continue;
                }
                let mut value = if !capture {
                    if self.mc_dormant(x, now) {
                        continue;
                    }
                    1.0
                } else {
                    1.5
                };
                if self.cfg.cq.target_control {
                    let m = self.prov(pi).march as usize;
                    if let (Some(&c), Some(ws)) = (self.cq_ctrl.get(m), self.cq_w.get(m)) {
                        let tot: u64 = ws.iter().sum();
                        let mine = ws[faction as usize];
                        let tw = x.stake.weight;
                        value *= if c == faction as u32 {
                            0.5
                        } else if (mine + tw) * 2 >= tot {
                            3.0
                        } else {
                            1.5
                        };
                    }
                }
                cands.push((value, t));
            }
        }
        if cands.is_empty() {
            return 0;
        }
        let mut best: Option<(f64, u32, f64)> = None;
        for (v, t) in cands {
            let def = self.perceived_defence(t, p.q).max(1.0);
            let score = v / def;
            if best.is_none_or(|x| score > x.0) {
                best = Some((score, t, def));
            }
        }
        let Some((_, t, mut def)) = best else {
            return 0;
        };
        def += p.q * self.expected_reinforcement(t);
        let need = def * (3.0 + (1.0 - p.q)) / per_troop;
        let tp = self.holds[t as usize].prov;
        let helpers = self.mc_rally(a, faction, tp, avail as f64, need);
        if (avail as f64) < need && helpers.is_empty() {
            return 0;
        }
        let n = ((need * 1.2).min(avail as f64) as MilliTroops).max(MIN_HOST_TROOPS.min(avail));
        let tt = self.holds[t as usize].tile;
        let Some(host) = self.send(a, src, n, tp, tt, Mission::Siege(t), b, p, None) else {
            return 0;
        };
        let mut last = self.host_arrival(host);
        for (h, o, give) in helpers {
            let prof = self.profiles[self.agents[o as usize].arch.idx()];
            if let Some(x) = self.send(o, h, give, tp, tt, Mission::Rally(t), b, &prof, None) {
                last = last.max(self.host_arrival(x));
            }
        }
        self.mcs.pending.insert(t, last + 6);
        2
    }

    fn host_arrival(&self, h: u32) -> u32 {
        match self.hosts[h as usize].state {
            HState::Marching { arrive } => arrive,
            _ => 0,
        }
    }

    /// A lone session's keep attack under MC (the lab's `keep_war` on the
    /// §3.2 keep: no declaration, the contest starts on arrival).
    pub(super) fn mc_keep_war(&mut self, a: u32, b: u32, p: &Profile) -> i64 {
        let (faction, hs) = {
            let ag = &self.agents[a as usize];
            (ag.faction, ag.holdings.clone())
        };
        let per_troop = self.per_troop(faction);
        let Some(&src) = hs.iter().max_by_key(|&&h| self.holds[h as usize].garrison) else {
            return 0;
        };
        let avail = self.holds[src as usize]
            .garrison
            .saturating_sub(self.keep_back(src));
        if avail < 2 * MIN_HOST_TROOPS {
            return 0;
        }
        let centre = self.prov(self.holds[src as usize].prov).coord;
        let mut best: Option<(f64, u32, f64)> = None;
        for pi in self.provinces_near(centre, self.cfg.cq.radius) {
            let Some(k) = self.prov(pi).mkeep else {
                continue;
            };
            if k.holder == faction || k.heartland_safe || k.contender == faction {
                continue;
            }
            if b + 6 < k.consolidated_until_bell {
                continue;
            }
            let value = if self.cfg.cq.target_control {
                self.mc_keep_value(pi, faction, false)
            } else {
                1.2
            };
            let mut def = crate::mc::cqk::keep_milli(&k) as f64 * 10.0 * 1.5
                + self.tile_strength(pi, k.tile, k.holder, true);
            def += p.q * self.keep_reinforcement(pi, k.holder);
            let def = (def * self.rng.lognormal(0.6 * (1.0 - p.q) + 0.05)).max(1.0);
            let score = value / def;
            if best.is_none_or(|x| score > x.0) {
                best = Some((score, pi, def));
            }
        }
        let Some((_, pi, def)) = best else { return 0 };
        let need = def * (2.0 + (1.0 - p.q)) / per_troop;
        let helpers = self.mc_rally(a, faction, pi, avail as f64, need);
        if (avail as f64) < need && helpers.is_empty() {
            return 1;
        }
        let k = self.prov(pi).mkeep.expect("keep");
        let n = ((need * 1.2).min(avail as f64) as MilliTroops).max(MIN_HOST_TROOPS.min(avail));
        if self
            .send(
                a,
                src,
                n,
                pi,
                k.tile,
                Mission::Keep(pi),
                b,
                p,
                Some(k.holder),
            )
            .is_none()
        {
            return 1;
        }
        for (h, o, give) in helpers {
            let prof = self.profiles[self.agents[o as usize].arch.idx()];
            let _ = self.send(
                o,
                h,
                give,
                pi,
                k.tile,
                Mission::KeepRally(pi),
                b,
                &prof,
                Some(k.holder),
            );
        }
        2
    }

    // ------------------------------------------------------ campaigns

    /// Herald's Call (display only; the plan's tie-breaker): per faction,
    /// the March with the most contestable enemy keeps adjacent to the
    /// faction's controlled provinces (lowest March index on ties).
    pub(super) fn mc_herald_call(&mut self, b: u32) {
        let mut call = [NONE; 6];
        for (f, slot) in call.iter_mut().enumerate() {
            let f = f as u8;
            let mut count: BTreeMap<u32, u32> = BTreeMap::new();
            let mut seen: BTreeSet<u32> = BTreeSet::new();
            for p in self.provs.iter().flatten() {
                if p.mkeep.is_none_or(|k| k.holder != f) {
                    continue;
                }
                for q in self.provinces_near(p.coord, 1) {
                    let Some(k) = self.prov(q).mkeep else {
                        continue;
                    };
                    if k.holder == f
                        || k.heartland_safe
                        || k.consolidated_until_bell > b
                        || !seen.insert(q)
                    {
                        continue;
                    }
                    *count.entry(self.prov(q).march).or_insert(0) += 1;
                }
            }
            if let Some((&m, _)) = count.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))) {
                *slot = m;
            }
        }
        self.mcs.call = call;
    }

    /// The hourly planner epoch (§8.6) for every campaign faction.
    pub(super) fn mc_campaign_epoch(&mut self, b: u32) {
        if !self.mc() || !self.cfg.policy.contains(&Policy::Campaign) || b % HOUR_BELLS != 0 {
            return;
        }
        if self.mcs.camps.len() < 6 {
            self.mcs.camps = vec![Vec::new(); 6];
        }
        if b % BELLS_PER_DAY == 0 && self.cfg.rules.keeps() {
            self.mc_herald_call(b);
        }
        // Members per faction and each faction's holdings by province.
        let mut members = [0u32; 6];
        for ag in &self.agents {
            if ag.state == JoinState::Settled {
                members[ag.faction as usize] += 1;
            }
        }
        let mut by_prov: Vec<HashMap<u32, Vec<u32>>> = vec![HashMap::new(); 6];
        for (i, x) in self.holds.iter().enumerate() {
            if x.alive && !x.free_city() && self.agents[x.owner as usize].arch != Arch::Idle {
                by_prov[x.faction as usize]
                    .entry(x.prov)
                    .or_default()
                    .push(i as u32);
            }
        }
        let mut staged: Vec<Vec<u32>> = vec![Vec::new(); 6];
        if self.cfg.forward {
            for (i, h) in self.hosts.iter().enumerate() {
                if matches!(h.mission, Mission::Stage(_))
                    && matches!(h.state, HState::Stationed { .. })
                {
                    staged[h.faction as usize].push(i as u32);
                }
            }
        }
        let mut decided: BTreeSet<u32> = BTreeSet::new();
        for f in 0..6u8 {
            if self.cfg.policy[f as usize] != Policy::Campaign {
                continue;
            }
            self.mc_campaign_update(f, b);
            let k = members[f as usize].div_ceil(40) as usize;
            self.mc_campaign_fill(f, b, k, &by_prov[f as usize], &staged[f as usize]);
            self.mc_defence_plan(f, b, &by_prov[f as usize], &mut decided);
            self.mc_campaign_launch(
                f,
                b,
                &by_prov[f as usize],
                &staged[f as usize],
                &mut decided,
            );
        }
    }

    fn mc_target_ours(&self, t: Target, f: u8) -> bool {
        match t {
            Target::Keep(pi) => self.prov(pi).mkeep.is_some_and(|k| k.holder == f),
            Target::Hold(t) => {
                let x = &self.holds[t as usize];
                (x.alive && x.faction == f) || (x.occupier.is_some() && x.mc.occ_faction == f)
            }
        }
    }

    fn mc_target_legal(&self, t: Target, f: u8, b: u32) -> bool {
        match t {
            Target::Keep(pi) => self.prov(pi).mkeep.is_some_and(|k| {
                !k.heartland_safe && k.holder != f && k.consolidated_until_bell <= b + 12
            }),
            Target::Hold(t) => {
                let x = &self.holds[t as usize];
                x.alive
                    && x.faction != f
                    && x.mc.siege.is_none_or(|s| s.attacker_faction == f)
                    && (x.mc.siege.is_some() || self.mc_record_free(t, f, b).is_ok())
                    && self.mc_may_besiege(t, f, b).is_ok()
                    && (x.mc.siege.is_some() || self.mc_can_finish(t, b + 1, b))
            }
        }
    }

    fn host_live(&self, h: u32) -> bool {
        matches!(
            self.hosts[h as usize].state,
            HState::Marching { .. } | HState::Stationed { .. }
        )
    }

    /// Won, failed (twice) or illegal campaigns leave the plan.
    fn mc_campaign_update(&mut self, f: u8, b: u32) {
        let mut camps = std::mem::take(&mut self.mcs.camps[f as usize]);
        camps.retain_mut(|c| {
            if self.mc_target_ours(c.target, f) {
                return false;
            }
            if let Some(at) = &c.attempt {
                let live = at.hosts.iter().any(|&h| self.host_live(h));
                if !live {
                    if !at.hosts.is_empty() {
                        c.fails += 1;
                    }
                    c.attempt = None;
                    c.idle_since = b;
                }
            }
            if c.fails >= 2 || (c.attempt.is_none() && b >= c.idle_since + STALE_BELLS) {
                return false;
            }
            c.attempt.is_some() || self.mc_target_legal(c.target, f, b)
        });
        self.mcs.camps[f as usize] = camps;
    }

    /// Fill the plan up to `k` campaigns with the best new targets.
    fn mc_campaign_fill(
        &mut self,
        f: u8,
        b: u32,
        k: usize,
        by_prov: &HashMap<u32, Vec<u32>>,
        staged: &[u32],
    ) {
        let have = self.mcs.camps[f as usize].len();
        if have >= k {
            return;
        }
        let taken: BTreeSet<Target> = self.mcs.camps[f as usize]
            .iter()
            .map(|c| c.target)
            .collect();
        let mut cands: Vec<(f64, Target)> = Vec::new();
        let mut provs: Vec<u32> = by_prov.keys().copied().collect();
        provs.sort_unstable();
        if self.cfg.rules.keeps() {
            // Keeps adjacent to the faction's controlled provinces or
            // holdings; with --forward, within 2 of a staged keep.
            let mut base: BTreeSet<u32> = provs.iter().copied().collect();
            for (i, p) in self.provs.iter().enumerate() {
                if p.as_ref()
                    .is_some_and(|p| p.mkeep.is_some_and(|k| k.holder == f))
                {
                    base.insert(i as u32);
                }
            }
            let mut front: BTreeSet<u32> = BTreeSet::new();
            for &q in &base {
                for r in self.provinces_near(self.prov(q).coord, 1) {
                    front.insert(r);
                }
            }
            for &h in staged {
                let sp = self.hosts[h as usize].prov;
                for r in self.provinces_near(self.prov(sp).coord, 2) {
                    front.insert(r);
                }
            }
            for pi in front {
                let t = Target::Keep(pi);
                if taken.contains(&t) || !self.mc_target_legal(t, f, b) {
                    continue;
                }
                let reach = self
                    .provinces_near(self.prov(pi).coord, MAX_MARCH_DIST)
                    .iter()
                    .any(|q| by_prov.contains_key(q))
                    || staged.iter().any(|&h| {
                        self.prov(self.hosts[h as usize].prov)
                            .coord
                            .distance(self.prov(pi).coord)
                            <= 2
                    });
                if !reach {
                    continue;
                }
                let v = self.mc_keep_value(pi, f, true);
                cands.push((v / self.mc_keep_def(pi).max(1.0), t));
            }
        }
        // Holdings 2–3, first holdings (occupation) and Free Cities within
        // two provinces of the faction's holdings.
        let now = now_of(b);
        let mut front: BTreeSet<u32> = BTreeSet::new();
        for &q in &provs {
            for r in self.provinces_near(self.prov(q).coord, 2) {
                front.insert(r);
            }
        }
        for pi in front {
            let sites = self.prov(pi).site_h.clone();
            for &t in &sites {
                if t == NONE {
                    continue;
                }
                let tg = Target::Hold(t);
                let x = &self.holds[t as usize];
                if taken.contains(&tg)
                    || !x.alive
                    || x.faction == f
                    || self.mcs.pending.contains_key(&t)
                {
                    continue;
                }
                let capture = x.free_city() || x.h.order >= 2;
                if !capture && self.mc_dormant(x, now) {
                    continue;
                }
                if !self.mc_target_legal(tg, f, b) || x.mc.siege.is_some() {
                    continue;
                }
                let v = if capture { 1.5 } else { 1.0 };
                let call =
                    self.cfg.rules.keeps() && self.mcs.call[f as usize] == self.prov(pi).march;
                let v = if call { v * 2.0 } else { v };
                cands.push((v / self.mc_hold_def(t).max(1.0), tg));
            }
        }
        cands.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        // `holding_slots` of the plan go to player holdings (first
        // holdings to occupy, holdings 2–3 to capture) when one is legal
        // and in reach: by value ÷ defence alone a player holding never
        // outranks a keep or a Free City, and the holding contest
        // (criterion 10h) would not be played.
        let player =
            |s: &Sim, t: &Target| matches!(t, Target::Hold(h) if !s.holds[*h as usize].free_city());
        let have_player = self.mcs.camps[f as usize]
            .iter()
            .filter(|c| player(self, &c.target))
            .count();
        let mut pick: Vec<Target> = Vec::new();
        let slots = self.cfg.holding_slots;
        if have_player < slots {
            pick.extend(
                cands
                    .iter()
                    .filter(|c| player(self, &c.1))
                    .take(slots - have_player)
                    .map(|c| c.1),
            );
        }
        for (_, t) in &cands {
            if pick.len() >= k - have {
                break;
            }
            if !pick.contains(t) {
                pick.push(*t);
            }
        }
        pick.truncate(k - have);
        for t in pick {
            self.mcs.camps[f as usize].push(Campaign {
                target: t,
                fails: 0,
                attempt: None,
                idle_since: b,
            });
        }
    }

    /// Members of `f` within one march of `tp` with spare troops, ranked
    /// by spare troops (then holding id); staged hosts within 2 with
    /// `--forward`.
    fn mc_members_near(
        &self,
        f: u8,
        tp: u32,
        b: u32,
        by_prov: &HashMap<u32, Vec<u32>>,
        staged: &[u32],
        decided: &BTreeSet<u32>,
    ) -> Vec<Member> {
        let mut out: Vec<Member> = Vec::new();
        let tc = self.prov(tp).coord;
        for q in self.provinces_near(tc, MAX_MARCH_DIST) {
            let Some(hs) = by_prov.get(&q) else { continue };
            for &h in hs {
                let y = &self.holds[h as usize];
                if y.mc.siege.is_some() || y.occupier.is_some() {
                    continue;
                }
                if decided.contains(&y.owner) {
                    continue;
                }
                let spare = y.garrison.saturating_sub(self.keep_back(h));
                if spare < MIN_HOST_TROOPS {
                    continue;
                }
                let Some((arrive, _)) = self.travel(f, q, tp, b) else {
                    continue;
                };
                out.push(Member {
                    agent: y.owner,
                    src: h,
                    staged: false,
                    spare,
                    arrive,
                });
            }
        }
        for &h in staged {
            let x = &self.hosts[h as usize];
            if decided.contains(&x.owner) || x.prov == tp {
                continue;
            }
            if self.prov(x.prov).coord.distance(tc) > 2 {
                continue;
            }
            let Some((arrive, _)) = self.travel(f, x.prov, tp, b) else {
                continue;
            };
            out.push(Member {
                agent: x.owner,
                src: h,
                staged: true,
                spare: x.troops,
                arrive,
            });
        }
        out.sort_by(|a, b| {
            b.spare
                .cmp(&a.spare)
                .then(a.src.cmp(&b.src))
                .then(a.staged.cmp(&b.staged))
        });
        out
    }

    /// Whether `a` can sound the horn on `t` (gold, daily cap, slot).
    fn mc_can_declare(&self, a: u32, src: u32, t: u32, b: u32) -> bool {
        let x = &self.holds[t as usize];
        let capture = x.free_city() || x.h.order >= 2;
        if capture && self.mc_free_slot23(a).is_none() {
            return false;
        }
        let ag = &self.agents[a as usize];
        if ag.declares.0 == b / BELLS_PER_DAY && ag.declares.1 >= self.cfg.mc.sieges_per_day {
            return false;
        }
        self.holds[src as usize].h.stock_at(now_of(b))[Resource::Gold as usize]
            >= self.cfg.mc.siege_stake_gold * MILLI
    }

    /// An epoch decision of `a` is taken (keep campaigns also need the
    /// keep-interest roll).
    fn mc_heeds_epoch(&mut self, a: u32, keep: bool) -> bool {
        let _ = a;
        let k = self.cfg.cq.keep_aggr;
        !keep || k >= 1.0 || self.mc_rng().chance(k)
    }

    /// Launch (or top up) each campaign without a live attempt.
    fn mc_campaign_launch(
        &mut self,
        f: u8,
        b: u32,
        by_prov: &HashMap<u32, Vec<u32>>,
        staged: &[u32],
        decided: &mut BTreeSet<u32>,
    ) {
        let n = self.mcs.camps[f as usize].len();
        for ci in 0..n {
            let c = self.mcs.camps[f as usize][ci].clone();
            if c.attempt.is_some() || !self.mc_target_legal(c.target, f, b) {
                continue;
            }
            let (tp, def) = match c.target {
                Target::Keep(pi) => (pi, self.mc_keep_def(pi)),
                Target::Hold(t) => (self.holds[t as usize].prov, self.mc_hold_def(t)),
            };
            // Epoch-driven bots launch at the epoch; session-driven
            // members join from the board (`mc_campaign_session`).
            let mut ms = self.mc_members_near(f, tp, b, by_prov, staged, decided);
            ms.retain(|m| self.epoch_driven(m.agent));
            if ms.is_empty() {
                continue;
            }
            let Some(group) = self.mc_form_group(f, c.target, def, b, &ms) else {
                continue;
            };
            let muster = self.mc_muster(&group, b);
            if let Target::Hold(t) = c.target {
                // TooLate at plan time: the horn sounds at the muster bell.
                if self.holds[t as usize].mc.siege.is_none()
                    && !self.mc_can_finish(t, muster + 1, b)
                {
                    continue;
                }
            }
            let mut at = Attempt {
                muster,
                hosts: Vec::new(),
            };
            self.mc_launch_group(f, b, c.target, &group, muster, &mut at, decided);
            // A keep campaign's siege group (§7.1 of the off-chain design):
            // the weakest legal enemy player holding of the province (Free
            // Cities are campaigns of their own), from the members left,
            // one bell after the assault.
            if let Target::Keep(_) = c.target {
                let used: Vec<u32> = group.iter().map(|m| m.agent).collect();
                let rest: Vec<Member> = ms
                    .iter()
                    .copied()
                    .filter(|m| !used.contains(&m.agent))
                    .collect();
                let sites = self.prov(tp).site_h.clone();
                let mut best: Option<(f64, u32)> = None;
                for t in sites {
                    if t == NONE || self.mcs.pending.contains_key(&t) {
                        continue;
                    }
                    let x = &self.holds[t as usize];
                    if !x.alive || x.faction == f || x.mc.siege.is_some() || x.free_city() {
                        continue;
                    }
                    if !self.mc_target_legal(Target::Hold(t), f, b) {
                        continue;
                    }
                    let d = self.mc_hold_def(t);
                    if best.is_none_or(|x| d < x.0) {
                        best = Some((d, t));
                    }
                }
                self.mcs.st.dbg[0] += 1;
                if best.is_none() {
                    self.mcs.st.dbg[1] += 1;
                }
                if let Some((d, t)) = best {
                    let g2 = self.mc_form_group(f, Target::Hold(t), d, b, &rest);
                    self.mcs.st.dbg[if g2.is_some() { 3 } else { 2 }] += 1;
                    // TooLate at plan time for the siege group's horn.
                    let g2 = g2.filter(|g2| {
                        let m2 = muster.max(self.mc_muster(g2, b)) + 1;
                        self.mc_can_finish(t, m2.min(self.end_bell - 1) + 1, b)
                    });
                    if let Some(g2) = g2 {
                        let m2 = muster.max(self.mc_muster(&g2, b)) + 1;
                        self.mc_launch_group(
                            f,
                            b,
                            Target::Hold(t),
                            &g2,
                            m2.min(self.end_bell - 1),
                            &mut at,
                            decided,
                        );
                    }
                }
            }
            if at.hosts.is_empty() {
                continue;
            }
            self.mcs.camps[f as usize][ci].attempt = Some(at);
        }
    }

    /// The group for a target: ≤ 4 members by spare troops until 1.2 ×
    /// the wanted strength (1.5 × the estimated defence); a holding's
    /// leader can declare and the helpers stay smaller; each member needs
    /// the group at its boldness margin.
    fn mc_form_group(
        &self,
        f: u8,
        target: Target,
        def: f64,
        b: u32,
        ms: &[Member],
    ) -> Option<Vec<Member>> {
        let per = self.per_troop(f);
        let want = def.max(1.0) * GROUP_MARGIN / per; // milli-troops
        let mut ms: Vec<Member> = ms.to_vec();
        if let Target::Hold(t) = target {
            let li = ms
                .iter()
                .position(|m| !m.staged && self.mc_can_declare(m.agent, m.src, t, b))?;
            let l = ms.remove(li);
            ms.insert(0, l);
        }
        let mut group: Vec<Member> = Vec::new();
        let mut got = 0.0;
        for m in ms {
            if group.len() >= WAVE_HOSTS || got >= want * 1.2 {
                break;
            }
            if group.iter().any(|g| g.agent == m.agent) {
                continue;
            }
            let mut m = m;
            if let (Target::Hold(_), Some(l)) = (target, group.first()) {
                m.spare = m.spare.min(l.spare.saturating_sub(MILLI as MilliTroops));
                if m.spare < MIN_HOST_TROOPS {
                    continue;
                }
            }
            got += m.spare as f64;
            group.push(m);
        }
        let strength = got * per;
        let lead = group.first().map(|m| m.agent);
        group.retain(|m| {
            margin(self.agents[m.agent as usize].arch).is_some_and(|x| strength >= x * def)
        });
        let got: f64 = group.iter().map(|m| m.spare as f64).sum();
        if got < want || group.is_empty() {
            return None;
        }
        if matches!(target, Target::Hold(_)) && group.first().map(|m| m.agent) != lead {
            return None;
        }
        Some(group)
    }

    /// The common arrival bell (`≥ max(earliest arrival) + 1`, ≤
    /// `end_bell − 1`).
    fn mc_muster(&self, group: &[Member], b: u32) -> u32 {
        let latest = group.iter().map(|m| m.arrive).max().unwrap_or(b);
        (latest + 1).min(self.end_bell - 1)
    }

    #[allow(clippy::too_many_arguments)]
    fn mc_launch_group(
        &mut self,
        f: u8,
        b: u32,
        target: Target,
        group: &[Member],
        muster: u32,
        at: &mut Attempt,
        decided: &mut BTreeSet<u32>,
    ) {
        let (tp, tile, mission, rally, keep) = match target {
            Target::Keep(pi) => (
                pi,
                self.prov(pi).mkeep.expect("keep").tile,
                Mission::Keep(pi),
                Mission::KeepRally(pi),
                true,
            ),
            Target::Hold(t) => {
                let x = &self.holds[t as usize];
                (x.prov, x.tile, Mission::Siege(t), Mission::Rally(t), false)
            }
        };
        let before = at.hosts.len();
        for (i, m) in group.iter().enumerate() {
            let ms = if i == 0 { mission } else { rally };
            if self.epoch_driven(m.agent) {
                decided.insert(m.agent);
                if !self.mc_heeds_epoch(m.agent, keep) {
                    continue;
                }
                if let Some(h) = self.mc_dispatch(m, tp, tile, ms, b, muster, f) {
                    at.hosts.push(h);
                }
            }
        }
        if let Target::Hold(t) = target {
            if at.hosts.len() > before {
                let last = at.hosts[before..]
                    .iter()
                    .map(|&h| self.host_arrival(h))
                    .max()
                    .unwrap_or(b);
                let e = self.mcs.pending.entry(t).or_insert(0);
                *e = (*e).max(last + 6);
            }
        }
    }

    /// Send one member's host (from its holding, or redeploy a staged
    /// host) to arrive at `muster` (or as early as it can).
    #[allow(clippy::too_many_arguments)]
    fn mc_dispatch(
        &mut self,
        m: &Member,
        tp: u32,
        tile: u8,
        mission: Mission,
        b: u32,
        muster: u32,
        f: u8,
    ) -> Option<u32> {
        let against = match mission {
            Mission::Keep(pi) | Mission::KeepRally(pi) => self.prov(pi).mkeep.map(|k| k.holder),
            _ => None,
        };
        let _ = f;
        if m.staged {
            return self
                .mc_redeploy(m.src, tp, tile, mission, b, muster)
                .then_some(m.src);
        }
        let prof = self.profiles[self.agents[m.agent as usize].arch.idx()];
        self.send_at(
            m.agent, m.src, m.spare, tp, tile, mission, b, &prof, against, muster,
        )
    }

    /// `--forward`: a staged host marches on from its keep (M1's Depart
    /// names the host's own Province, §3.2).
    pub(super) fn mc_redeploy(
        &mut self,
        h: u32,
        to: u32,
        tile: u8,
        mission: Mission,
        b: u32,
        arrive_min: u32,
    ) -> bool {
        let (faction, from, owner) = {
            let x = &self.hosts[h as usize];
            (x.faction, x.prov, x.owner)
        };
        let Some((arrive, cost)) = self.travel(faction, from, to, b) else {
            return false;
        };
        let arrive = arrive.max(arrive_min).min(self.end_bell + 300);
        if self.hosts[h as usize].stamina.spend(b, cost).is_err() {
            return false;
        }
        self.unstation(from, h);
        let x = &mut self.hosts[h as usize];
        x.state = HState::Marching { arrive };
        x.prov = to;
        x.tile = tile;
        x.mission = mission;
        x.back_bells = x.back_bells.max(arrive - b);
        self.arrivals[arrive as usize].push(h);
        self.mc_note_depart(owner, mission);
        true
    }

    /// The defence plan of an epoch: own keeps under contest and own
    /// holdings under siege get relief that can arrive before 25%
    /// progress, when the relief reaches the members' margin over the
    /// attackers on the hex.
    fn mc_defence_plan(
        &mut self,
        f: u8,
        b: u32,
        by_prov: &HashMap<u32, Vec<u32>>,
        decided: &mut BTreeSet<u32>,
    ) {
        let mut needs: Vec<Relief> = Vec::new();
        for &pi in &self.mcs.keep_live {
            let Some(k) = self.prov(pi).mkeep else {
                continue;
            };
            if k.holder != f || k.contender == NO_FACTION {
                continue;
            }
            let quarter = (k.required as u32).div_ceil(4);
            needs.push(Relief {
                mission: Mission::KeepDefend(pi),
                pi,
                tile: k.tile,
                deadline: k.contest_from_bell + quarter,
                attacker: k.contender,
            });
        }
        for &t in &self.mcs.msieges {
            let x = &self.holds[t as usize];
            let Some(s) = x.mc.siege else { continue };
            if x.faction != f || x.free_city() {
                continue;
            }
            needs.push(Relief {
                mission: Mission::Defend(t),
                pi: x.prov,
                tile: x.tile,
                deadline: s.declared + s.required.div_ceil(4),
                attacker: s.attacker_faction,
            });
        }
        for r in needs {
            if b >= r.deadline {
                continue;
            }
            // Relief already under way.
            let going = self
                .hosts
                .iter()
                .filter(|h| {
                    h.mission == r.mission
                        && h.faction == f
                        && matches!(h.state, HState::Marching { .. } | HState::Stationed { .. })
                })
                .count();
            if going >= WAVE_HOSTS {
                continue;
            }
            // The standing order (§8.6 "Defend / relieve": holdings in the
            // threatened March, 25% for skilled and up; automation, so it
            // needs no session): the 4 largest shares that arrive before
            // 25% progress.
            let m = self.prov(r.pi).march;
            let mut cands: Vec<(MilliTroops, u32, u32)> = Vec::new();
            for q in self.provinces_near(self.prov(r.pi).coord, MAX_MARCH_DIST) {
                if self.prov(q).march != m {
                    continue;
                }
                let Some(hs) = by_prov.get(&q) else { continue };
                for &h in hs {
                    let y = &self.holds[h as usize];
                    if y.mc.siege.is_some() || y.occupier.is_some() || decided.contains(&y.owner) {
                        continue;
                    }
                    if !matches!(
                        self.agents[y.owner as usize].arch,
                        Arch::Skilled | Arch::VerySkilled | Arch::Bot
                    ) {
                        continue;
                    }
                    let n = y.garrison / 4;
                    if n < MIN_HOST_TROOPS {
                        continue;
                    }
                    if self
                        .travel(f, q, r.pi, b)
                        .is_none_or(|(a, _)| a > r.deadline)
                    {
                        continue;
                    }
                    cands.push((n, h, y.owner));
                }
            }
            cands.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
            let mut sent = going;
            let mut seen: Vec<u32> = Vec::new();
            for (n, h, o) in cands {
                if sent >= WAVE_HOSTS {
                    break;
                }
                if seen.contains(&o) {
                    continue;
                }
                seen.push(o);
                if self.epoch_driven(o) {
                    decided.insert(o);
                    if !self.mc_heeds_epoch(o, false) {
                        continue;
                    }
                }
                let prof = self.profiles[self.agents[o as usize].arch.idx()];
                if self
                    .send(o, h, n, r.pi, r.tile, r.mission, b, &prof, Some(r.attacker))
                    .is_some()
                {
                    sent += 1;
                }
            }
        }
    }

    /// A session-driven member (a human, or a `sim`-profile bot) reads its
    /// faction's plan as a public board when it is online: it joins the
    /// first campaign in reach that still needs strength (at the attempt's
    /// muster bell, or as early as it can), or starts one, when the group
    /// would meet its boldness margin and it heeds the plan (its
    /// aggression; × keep interest for a keep).
    pub(super) fn mc_campaign_session(&mut self, a: u32, b: u32, p: &Profile) -> i64 {
        let f = self.agents[a as usize].faction;
        if self.mcs.camps.len() < 6 || self.mcs.camps[f as usize].is_empty() {
            return 0;
        }
        let Some(mg) = margin(self.agents[a as usize].arch) else {
            return 0;
        };
        let hs = self.agents[a as usize].holdings.clone();
        let Some(&src) = hs.iter().max_by_key(|&&h| {
            let y = &self.holds[h as usize];
            (
                y.garrison.saturating_sub(self.keep_back(h)),
                std::cmp::Reverse(h),
            )
        }) else {
            return 0;
        };
        let spare = self.holds[src as usize]
            .garrison
            .saturating_sub(self.keep_back(src));
        if spare < MIN_HOST_TROOPS || self.holds[src as usize].mc.siege.is_some() {
            return 0;
        }
        let per = self.per_troop(f);
        let sp = self.holds[src as usize].prov;
        let n = self.mcs.camps[f as usize].len();
        for ci in 0..n {
            let c = self.mcs.camps[f as usize][ci].clone();
            if !self.mc_target_legal(c.target, f, b) {
                continue;
            }
            let (tp, tile, keep) = match c.target {
                Target::Keep(pi) => (pi, self.prov(pi).mkeep.expect("keep").tile, true),
                Target::Hold(t) => (
                    self.holds[t as usize].prov,
                    self.holds[t as usize].tile,
                    false,
                ),
            };
            let Some((arrive, _)) = self.travel(f, sp, tp, b) else {
                continue;
            };
            let def = match c.target {
                Target::Keep(pi) => self.mc_keep_def(pi),
                Target::Hold(t) => self.mc_hold_def(t),
            };
            let want = def.max(1.0) * GROUP_MARGIN / per;
            let live: Vec<u32> = c
                .attempt
                .as_ref()
                .map(|at| {
                    at.hosts
                        .iter()
                        .copied()
                        .filter(|&h| self.host_live(h))
                        .collect()
                })
                .unwrap_or_default();
            let sent: f64 = live
                .iter()
                .map(|&h| self.hosts[h as usize].troops as f64)
                .sum();
            if sent >= want * 1.2 {
                continue;
            }
            if (sent + spare as f64) * per < mg * def {
                continue;
            }
            let lead_troops = live.iter().map(|&h| self.hosts[h as usize].troops).max();
            if let Target::Hold(t) = c.target {
                if lead_troops.is_none() && !self.mc_can_declare(a, src, t, b) {
                    continue;
                }
                // TooLate at plan time: a new lead sounds the horn on arrival.
                if lead_troops.is_none()
                    && self.holds[t as usize].mc.siege.is_none()
                    && !self.mc_can_finish(t, arrive.max(b) + 1, b)
                {
                    continue;
                }
            }
            let heed = p.aggression * if keep { self.cfg.cq.keep_aggr } else { 1.0 };
            if !self.rng.chance(heed.min(1.0)) {
                continue;
            }
            let mut n_troops = (((want * 1.2 - sent).max(0.0)) as MilliTroops)
                .max(MIN_HOST_TROOPS)
                .min(spare);
            if let (Target::Hold(_), Some(l)) = (c.target, lead_troops) {
                n_troops = n_troops.min(l.saturating_sub(MILLI as MilliTroops));
                if n_troops < MIN_HOST_TROOPS {
                    continue;
                }
            }
            let (mission, rally) = match c.target {
                Target::Keep(pi) => (Mission::Keep(pi), Mission::KeepRally(pi)),
                Target::Hold(t) => (Mission::Siege(t), Mission::Rally(t)),
            };
            let ms = if live.is_empty() { mission } else { rally };
            let muster = c.attempt.as_ref().map_or(0, |at| at.muster);
            let m = Member {
                agent: a,
                src,
                staged: false,
                spare: n_troops,
                arrive: 0,
            };
            let Some(h) =
                self.mc_dispatch(&m, tp, tile, ms, b, if b < muster { muster } else { 0 }, f)
            else {
                continue;
            };
            let arrive = self.host_arrival(h);
            if let Target::Hold(t) = c.target {
                let e = self.mcs.pending.entry(t).or_insert(0);
                *e = (*e).max(arrive + 6);
            }
            let slot = &mut self.mcs.camps[f as usize][ci].attempt;
            match slot {
                Some(at) => at.hosts.push(h),
                None => {
                    *slot = Some(Attempt {
                        muster: arrive,
                        hosts: vec![h],
                    })
                }
            }
            return 2;
        }
        0
    }
}
