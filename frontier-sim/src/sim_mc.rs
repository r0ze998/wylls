//! The MC rules inside the season loop (`--rules mc`, CONQUEST-CONTRACT
//! v1.1 §3): keeps and the keep contest (§3.2), holding sieges declared
//! from the hex by the lead host (§3.4), occupation with tenure and Respite
//! (§3.5), capture into a slot reserved at the horn with the capture-credit
//! rule (§3.6), genesis Free Cities (§3.7), outposts (§3.8), protection
//! (§3.9), Dominion as points (§3.10) and the season end (§3.11); plus the
//! per-bell control series criterion 10 is computed from (`mapmove.rs`).
//!
//! A child module of `sim`, so it reads the season state directly. Every
//! entry point returns at once under `--rules m1`, which keeps every M1
//! digest unchanged.

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::mc::cqk::{self, KeepEvent, KeepReport, NO_FACTION};
use crate::mc::{vigil_covers, Policy, Rules};
use permutation_rules::frontier::siege::required_bells;

#[cfg(test)]
#[path = "cq_contest_tests.rs"]
mod cq_contest_tests;

/// Why a DeclareSiege was refused (§5.3 names). `NotLead` never fires in
/// the simulator: only the lead host's owner tries to declare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    SeasonOver = 0,
    NotOnHex,
    NotBesiegeable,
    SiegeBusy,
    Immune,
    SiegeCap,
    HoldingsFull,
    Friendly,
    Shielded,
    FrontierProtected,
    Heartland,
    TooLate,
    Insufficient,
}

pub const REFUSALS: usize = 13;
pub const REFUSAL_NAMES: [&str; REFUSALS] = [
    "SeasonOver",
    "NotOnHex",
    "NotBesiegeable",
    "SiegeBusy",
    "Immune",
    "SiegeCap",
    "HoldingsFull",
    "Friendly",
    "Shielded",
    "FrontierProtected",
    "Heartland",
    "TooLate",
    "Insufficient",
];

/// Counters of the MC layer (per season).
#[derive(Clone, Debug, Default)]
pub struct McStats {
    /// Departs (sealed marches) by archetype of the sender.
    pub departs: [u64; 6],
    /// Marches to take a keep (`Keep`, `KeepRally`) by archetype.
    pub keep_marches: [u64; 6],
    /// DeclareSieges that landed, by archetype of the declarer.
    pub declares: [u64; 6],
    pub keep_contests: u64,
    pub keep_broken: u64,
    pub keep_taken: u64,
    /// Keeps taken by archetype of the donor's owner.
    pub keep_taken_by: [u64; 6],
    pub sieges_declared: u64,
    pub sieges_completed: u64,
    pub sieges_failed: u64,
    pub failed_by_defender: u64,
    pub occupations: u64,
    pub liberations: u64,
    pub liberated_no_respite: u64,
    pub expiries: u64,
    pub captures: u64,
    pub fc_captures: u64,
    pub credited: u64,
    pub uncredited: u64,
    pub outposts: u64,
    pub lapsed: u64,
    /// D9: first holdings that changed owner or left slot 1 (must stay 0,
    /// criterion 10i). Measured independently of the capture code
    /// (`Sim::mc_d9_check`, integ-W1): every first holding's founding owner
    /// is recorded, and the holdings found later with another owner or
    /// another order are counted, once each.
    pub d9_transfers: u64,
    /// First holdings released (homes lost), by archetype of the owner.
    pub homes_released: [u64; 6],
    pub refusals: [u64; REFUSALS],
    pub fc_genesis: u64,
    /// Diagnostics (`FRONTIER_SIM_DEBUG=1` prints them): keep campaigns
    /// launched; siege-group province had no legal player holding; had
    /// one but no group; siege groups launched; first-holding sieges
    /// declared; of them failed by a defender; failed with the hex left;
    /// failed after some progress; at those failures the lead host was
    /// destroyed / on its way home (retreated, bounced) / elsewhere.
    /// The occupation objective (PO-1 a): [11] plan fills with a legal
    /// first holding in reach, [12] occupation campaigns added, [13]
    /// occupation groups launched, [14] campaign rally hosts kept on a
    /// target's hex at arrival.
    pub dbg: [u64; 16],
}

/// The control series criterion 10 reads: province control changes by bell
/// (keep model: exact; weight models: sampled at each hour's last bell).
#[derive(Clone, Debug, Default)]
pub struct CtlTrack {
    /// (bell, province index, from, to); `NO_FACTION` = none, 6 = neutral.
    pub events: Vec<(u32, u32, u8, u8)>,
    /// Current sampled control per province (weight models).
    pub sampled: Vec<u8>,
}

/// The MC state of a season.
#[derive(Default)]
pub struct McState {
    pub msieges: BTreeSet<u32>,
    /// Targets whose strike is under way: target → last bell to declare.
    pub pending: BTreeMap<u32, u32>,
    pub keep_resolved: Vec<u32>,
    pub keep_live: BTreeSet<u32>,
    pub occupied: BTreeSet<u32>,
    pub ctl: CtlTrack,
    pub st: McStats,
    pub camps: Vec<Vec<super::campaign::Campaign>>,
    /// D9 audit: each first holding's founding owner, and the holdings
    /// seen with another owner or order (`mc_d9_check`).
    pub first_owner: BTreeMap<u32, u32>,
    pub d9_seen: BTreeSet<u32>,
    /// Herald's Call: one March index per faction (display; tie-breaker).
    pub call: [u32; 6],
    pub rng: Option<Rng>,
}

impl Sim {
    pub(super) fn mc(&self) -> bool {
        self.cfg.rules.mc()
    }

    pub(super) fn mc_rng(&mut self) -> &mut Rng {
        let seed = self.cfg.seed;
        self.mcs
            .rng
            .get_or_insert_with(|| Rng::fork(seed, 0x4D43_5F43_5131))
    }

    /// Lowest free holding slot of 2–3 (no holding of that order, no
    /// reservation), K-25.
    pub(super) fn mc_free_slot23(&self, a: u32) -> Option<u8> {
        let ag = &self.agents[a as usize];
        let occupied: [bool; 3] = core::array::from_fn(|i| {
            ag.holdings
                .iter()
                .any(|&h| self.holds[h as usize].h.order as usize == i + 1)
        });
        let reserved = ag
            .reserved
            .iter()
            .filter(|&&s| (2..=3).contains(&s))
            .fold(0u8, |m, &s| m | 1 << (s - 2));
        // `holding::lowest_free_slot` itself (integ-W1 R2); the simulator
        // settles outpost tickets at once, so no ticket names a slot.
        permutation_rules::frontier::holding::lowest_free_slot(occupied, 0, reserved)
    }

    /// The order a new holding of `a` takes: 1 when it has none, else the
    /// lowest free slot (M1: `holdings + 1`).
    pub(super) fn mc_found_order(&self, a: u32) -> u8 {
        let ag = &self.agents[a as usize];
        if !self.mc() {
            return ag.holdings.len() as u8 + 1;
        }
        if !ag
            .holdings
            .iter()
            .any(|&h| self.holds[h as usize].h.order == 1)
        {
            return 1;
        }
        self.mc_free_slot23(a)
            .unwrap_or(ag.holdings.len() as u8 + 1)
    }

    /// A holding was founded at `b`: its shield and tenure (§3.9).
    pub(super) fn mc_on_found(&mut self, hid: u32, b: u32) {
        if !self.mc() {
            return;
        }
        let prm = self.cfg.mc;
        let x = &mut self.holds[hid as usize];
        let now = now_of(b);
        x.mc.held_since_hour = cqk::held_since_hour(b);
        x.mc.shield_until = if x.h.order <= 1 {
            prm.first_shield_until(now)
        } else {
            now + prm.outpost_shield_secs
        };
        if x.h.order <= 1 && x.owner != NONE {
            let owner = x.owner;
            self.mcs.first_owner.insert(hid, owner);
        }
    }

    /// The D9 audit (criterion 10i): a live first holding whose owner is
    /// not its founder, or whose order is no longer 1, is a transfer.
    /// Runs at every day's last bell and at the season end.
    pub(super) fn mc_d9_check(&mut self) {
        for (&hid, &owner) in &self.mcs.first_owner {
            let x = &self.holds[hid as usize];
            if x.alive && (x.owner != owner || x.h.order != 1) {
                self.mcs.d9_seen.insert(hid);
            }
        }
        self.mcs.st.d9_transfers = self.mcs.d9_seen.len() as u64;
    }

    pub(super) fn mc_dormant(&self, x: &Hold, now: i64) -> bool {
        x.free_city() || now - x.h.last_owner_action >= self.cfg.mc.dormant_after_secs
    }

    /// The keep tile: the kernel's `keep::keep_tile_symmetric` (W1-close,
    /// PO-5, CQH1(5): the same tile in all six wedges of a ring; contract
    /// v1.3 §3.1/§3.2) for the province's wedge. A province without one
    /// gets no keep (`NO_KEEP_TILE`, as OpenProvince).
    fn keep_tile(t: &ProvinceTerrain, wedge: u8) -> u8 {
        let bytes: [u8; PROVINCE_TILES] = core::array::from_fn(|i| t.terrain[i] as u8);
        permutation_rules::frontier::keep::keep_tile_symmetric(
            &bytes,
            &t.sites,
            t.site_count,
            wedge,
        )
        .unwrap_or(permutation_rules::frontier::keep::NO_KEEP_TILE)
    }

    /// OpenProvince (§3.2, §3.7): the keep and the genesis Free City.
    pub(super) fn mc_open_province(&mut self, pi: u32, bell: u32) {
        if self.mcs.ctl.sampled.len() < self.provs.len() {
            self.mcs.ctl.sampled = vec![NO_FACTION; self.provs.len()];
        }
        if !self.mc() {
            return;
        }
        let prm = self.cfg.mc;
        let (coord, wedge, ring, n_sites, tile) = {
            let p = self.prov(pi);
            (
                p.coord,
                p.wedge,
                p.ring,
                p.terrain.site_count,
                Self::keep_tile(&p.terrain, p.wedge),
            )
        };
        if self.cfg.rules.keeps() {
            let k = cqk::open(
                coord,
                wedge,
                prm.heartland_max_ring,
                tile,
                &prm.keep_params(),
                bell,
            )
            .expect("keep_home_guard ≤ MAX_HOST_TROOPS (CreateSeason)");
            self.prov_mut(pi).mkeep = k;
            if k.is_some() {
                self.mcs.ctl.sampled[pi as usize] = wedge;
            }
        }
        if prm.free_city_min_ring > 0 && ring >= prm.free_city_min_ring && n_sites > 0 {
            let seed = self.ring_seeds[ring as usize];
            let slot = cqk::free_city_site(&seed, coord, n_sites);
            if self.prov(pi).site_h[slot as usize] != NONE {
                return;
            }
            let now = now_of(bell);
            let tile = self.prov(pi).site_tile(slot as usize);
            let hid = self.holds.len() as u32;
            self.holds.push(Hold {
                owner: NONE,
                faction: NEUTRAL,
                prov: pi,
                tile,
                h: Holding::found(now, bell / BELLS_PER_DAY, 1),
                garrison: troops(prm.free_city_garrison),
                away: 0,
                buildings: [0; 6],
                base_tier: HTier::Hamlet,
                stake: Stake::default(),
                attached: false,
                vigil: Vigil::new(0).expect("vigil"),
                siege: None,
                occupier: None,
                occ_pair: PairHistory::default(),
                posture: Posture::default(),
                alive: true,
                explores: 0,
                report: None,
                mc: HoldMc {
                    genesis_fc: true,
                    ..HoldMc::default()
                },
            });
            self.prov_mut(pi).site_h[slot as usize] = hid;
            self.take_site(pi, slot);
            self.mcs.st.fc_genesis += 1;
        }
    }

    /// ReleaseDormant under MC (R-07, R-14): the site becomes a plain free
    /// site, never a Free City; refused while a record is live (S3).
    /// Returns false when M1's release applies instead.
    pub(super) fn mc_release(&mut self, hid: u32, b: u32) -> bool {
        if !self.mc() {
            return false;
        }
        let busy = {
            let x = &self.holds[hid as usize];
            x.mc.siege.is_some() || x.occupier.is_some()
        };
        if busy {
            let at = (b + HOUR_BELLS) as usize;
            if at < self.events.len() {
                self.events[at].push(Ev::Release(hid));
            }
            return true;
        }
        self.stats.releases += 1;
        let owner = self.holds[hid as usize].owner;
        let arch = self.agents[owner as usize].arch;
        if self.holds[hid as usize].h.order <= 1 {
            self.mcs.st.homes_released[arch.idx()] += 1;
        }
        self.holds[hid as usize].alive = false;
        self.reweigh(hid, b);
        let (pi, tile) = (self.holds[hid as usize].prov, self.holds[hid as usize].tile);
        let slot = self.prov(pi).terrain.sites[..self.prov(pi).site_h.len()]
            .iter()
            .position(|&t| t == tile)
            .expect("site");
        let (ring, wedge) = (self.prov(pi).ring as usize, self.prov(pi).wedge as usize);
        self.prov_mut(pi).site_h[slot] = NONE;
        self.free[ring][wedge].push((pi, slot as u8));
        self.wedge_used[wedge] -= 1;
        self.used_sites -= 1;
        let x = &mut self.holds[hid as usize];
        x.mc = HoldMc::default();
        x.garrison = 0;
        x.away = 0;
        self.agents[owner as usize].holdings.retain(|&h| h != hid);
        true
    }

    // ---------------------------------------------------------- per bell

    /// Before the bell's clashes: the DeclareSieges of the hosts that hold
    /// a target's hex (they land in bell `b`; progress counts from b + 1).
    pub(super) fn mc_before_resolve(&mut self, b: u32) {
        if !self.mc() || self.mcs.pending.is_empty() {
            return;
        }
        let pend: Vec<(u32, u32)> = self.mcs.pending.iter().map(|(&t, &d)| (t, d)).collect();
        for (t, deadline) in pend {
            match self.mc_try_declare(t, b) {
                None => {
                    if b > deadline {
                        self.mcs.pending.remove(&t);
                        self.mc_recall(t, b, |m| {
                            matches!(m, Mission::Siege(_) | Mission::Rally(_))
                        });
                    }
                }
                Some(Ok(())) => {
                    self.mcs.pending.remove(&t);
                }
                Some(Err(r)) => {
                    self.mcs.st.refusals[r as usize] += 1;
                    self.mcs.pending.remove(&t);
                    self.mc_recall(t, b, |m| matches!(m, Mission::Siege(_) | Mission::Rally(_)));
                }
            }
        }
    }

    /// Send home this target's hosts whose mission matches.
    fn mc_recall(&mut self, t: u32, b: u32, f: impl Fn(Mission) -> bool) {
        let pi = self.holds[t as usize].prov;
        let hs: Vec<u32> = self
            .prov(pi)
            .stationed
            .iter()
            .copied()
            .filter(|&h| {
                let m = self.hosts[h as usize].mission;
                f(m) && matches!(m, Mission::Siege(x) | Mission::Rally(x) | Mission::Defend(x) | Mission::Occupy(x) if x == t)
            })
            .collect();
        for h in hs {
            self.unstation(pi, h);
            self.send_home(h, b);
        }
    }

    /// The lead host on a site tile (§3.1): the resident non-civilian host
    /// with the most troops, then the lowest host id, among the hosts not
    /// of the site's faction (`from_bell ≤ b`).
    fn mc_lead_on(&self, pi: u32, tile: u8, not_faction: u8, b: u32) -> Option<u32> {
        let cands: Vec<(u8, u64, u32)> = self
            .prov(pi)
            .stationed
            .iter()
            .enumerate()
            .filter_map(|(i, &h)| {
                let x = &self.hosts[h as usize];
                let resident = matches!(x.state, HState::Stationed { from } if from <= b);
                (resident && x.tile == tile && x.faction != not_faction && x.faction < 6)
                    .then_some((i.min(254) as u8, h as u64, x.troops.max(1)))
            })
            .collect();
        cqk::lead_host(&cands).map(|i| self.prov(pi).stationed[i as usize])
    }

    /// DeclareSiege's checks (§3.4) for the lead host's owner on `t`'s
    /// hex. `None`: nobody is resident there yet.
    fn mc_try_declare(&mut self, t: u32, b: u32) -> Option<Result<(), Refusal>> {
        let (pi, tile, tf) = {
            let x = &self.holds[t as usize];
            (x.prov, x.tile, x.faction)
        };
        let lead = self.mc_lead_on(pi, tile, tf, b)?;
        Some(self.mc_declare(t, lead, b))
    }

    /// Whether faction `f` has a first holding within 2 provinces of `pi`
    /// (Frontier protection's "nearby", first holdings only).
    pub(super) fn mc_first_nearby(&self, f: u8, pi: u32) -> bool {
        let c = self.prov(pi).coord;
        self.provinces_near(c, 2).into_iter().any(|q| {
            self.prov(q).site_h.iter().any(|&h| {
                h != NONE && {
                    let y = &self.holds[h as usize];
                    y.alive && y.faction == f && !y.free_city() && y.h.order == 1
                }
            })
        })
    }

    /// `siege::may_besiege_v3` (§3.4 step 8) for faction `f` on `t`: the
    /// kernel itself (integ-W1 R2, review CQ1-B), relation Rivalry and no
    /// March flags, genesis at 0 (the simulator's clock). "Nearby" (first
    /// holdings of `f` within 2 provinces) is computed only when the
    /// kernel's answer depends on it.
    pub(super) fn mc_may_besiege(&self, t: u32, f: u8, b: u32) -> Result<(), Refusal> {
        use permutation_rules::frontier::siege::{may_besiege_v3, SiegeCheckV3};
        let x = &self.holds[t as usize];
        if !x.alive {
            return Err(Refusal::NotBesiegeable);
        }
        let now = now_of(b);
        let prm = &self.cfg.mc;
        let mut c = SiegeCheckV3 {
            province: self.prov(x.prov).coord,
            kind: x.kind(),
            owner_faction: x.faction,
            attacker_faction: f,
            relation: Relation::Rivalry,
            march_hostility: false,
            march_truce: false,
            founded_ts: x.h.founded_ts,
            shield_until: x.mc.shield_until,
            dormant: self.mc_dormant(x, now),
            attacker_nearby: false,
            now,
            heartland_max_ring: prm.heartland_max_ring.min(u8::MAX as u32) as u8,
            frontier_protect_secs: prm.frontier_protect_secs,
            frontier_protect_after_secs: prm.frontier_protect_after_secs,
            genesis_ts: 0,
        };
        let mut r = may_besiege_v3(&c);
        if r == Err(SiegeRefusal::FrontierProtected) && self.mc_first_nearby(f, x.prov) {
            c.attacker_nearby = true;
            r = may_besiege_v3(&c);
        }
        r.map_err(|e| match e {
            SiegeRefusal::Friendly => Refusal::Friendly,
            SiegeRefusal::Shielded => Refusal::Shielded,
            SiegeRefusal::FrontierProtected => Refusal::FrontierProtected,
            SiegeRefusal::Heartland => Refusal::Heartland,
            _ => Refusal::NotBesiegeable,
        })
    }

    /// The record checks of §3.4 step 5 for faction `f`.
    pub(super) fn mc_record_free(&self, t: u32, f: u8, b: u32) -> Result<(), Refusal> {
        let x = &self.holds[t as usize];
        if x.mc.siege.is_some() || x.occupier.is_some() {
            return Err(Refusal::SiegeBusy);
        }
        if x.mc.immune_until > b && (x.mc.barred == ALL_FACTIONS || x.mc.barred == f) {
            return Err(Refusal::Immune);
        }
        Ok(())
    }

    /// Whether a siege on `t` declared at bell `from − 1` could still
    /// complete before the season ends (§3.4 step 9, `TooLate`), with the
    /// walls and vigil of now. The campaign planner checks it at plan
    /// time, with the muster bell, so an honest strike is never refused at
    /// the horn for lack of time (integ-W1, review CQ1-B; a CQ2-F port
    /// requirement).
    pub(super) fn mc_can_finish(&self, t: u32, from: u32, b: u32) -> bool {
        let x = &self.holds[t as usize];
        let walls = x.h.walls_at(now_of(b)).unwrap_or(x.h.walls);
        let vigil = if x.free_city() { None } else { Some(x.vigil) };
        cqk::can_complete_before(
            required_bells(walls, 0),
            vigil.as_ref(),
            from,
            self.end_bell,
        )
    }

    fn mc_declare(&mut self, t: u32, lead: u32, b: u32) -> Result<(), Refusal> {
        let prm = self.cfg.mc;
        if b >= self.end_bell {
            return Err(Refusal::SeasonOver);
        }
        let (a, src, f) = {
            let h = &self.hosts[lead as usize];
            (h.owner, h.home, h.faction)
        };
        // 2. The source holding (the lead host's home) is the declarer's.
        let s = &self.holds[src as usize];
        if !s.alive || s.owner != a {
            return Err(Refusal::NotOnHex);
        }
        // 3. A holding or a Free City.
        let x = &self.holds[t as usize];
        if !x.alive {
            return Err(Refusal::NotBesiegeable);
        }
        let capture = x.free_city() || x.h.order >= 2;
        // 5. The record.
        self.mc_record_free(t, f, b)?;
        // 6. The daily cap.
        let day = b / BELLS_PER_DAY;
        let ag = &self.agents[a as usize];
        let today = if ag.declares.0 == day {
            ag.declares.1
        } else {
            0
        };
        if today >= prm.sieges_per_day {
            return Err(Refusal::SiegeCap);
        }
        // 7. A free slot for a capture target.
        let slot = if capture {
            match self.mc_free_slot23(a) {
                Some(s) => s,
                None => return Err(Refusal::HoldingsFull),
            }
        } else {
            0
        };
        // 8. may_besiege v3; the declarer's own first holding unshielded.
        self.mc_may_besiege(t, f, b)?;
        if !self.holds[t as usize].free_city() {
            let now = now_of(b);
            let own_shielded = self.agents[a as usize].holdings.iter().any(|&h| {
                let y = &self.holds[h as usize];
                y.h.order == 1 && now < y.mc.shield_until && !self.mc_dormant(y, now)
            });
            if own_shielded {
                return Err(Refusal::Shielded);
            }
        }
        // 9. Required bells and the season end.
        let x = &self.holds[t as usize];
        let walls = x.h.walls_at(now_of(b)).unwrap_or(x.h.walls);
        let required = required_bells(walls, 0);
        let vigil = if x.free_city() { None } else { Some(x.vigil) };
        if !cqk::can_complete_before(required, vigil.as_ref(), b + 1, self.end_bell) {
            return Err(Refusal::TooLate);
        }
        // 10. The stake, 500 Gold from the source holding.
        let mut c = [0 as Milli; RESOURCES];
        c[Resource::Gold as usize] = prm.siege_stake_gold * MILLI;
        if self.holds[src as usize].h.pay(now_of(b), &c).is_err() {
            return Err(Refusal::Insufficient);
        }
        // Effects.
        if slot != 0 {
            self.agents[a as usize].reserved.push(slot);
        }
        let ag = &mut self.agents[a as usize];
        ag.declares = (day, today + 1);
        let arch = ag.arch;
        self.mcs.st.declares[arch.idx()] += 1;
        self.mcs.st.sieges_declared += 1;
        if !capture {
            self.mcs.st.dbg[4] += 1;
        }
        self.stats.sieges_declared += 1;
        self.holds[t as usize].mc.siege = Some(McSiege {
            attacker_faction: f,
            declarer: a,
            src,
            lead_host: lead,
            required,
            progress: 0,
            declared: b,
            vigil,
            slot,
        });
        self.mcs.msieges.insert(t);
        self.mc_siege_alert(t, f, b);
        Ok(())
    }

    /// The horn: the standing order (auto-reinforce as client/bot
    /// automation, §3.9) of a lone faction's holdings in the March.
    fn mc_siege_alert(&mut self, t: u32, attacker: u8, b: u32) {
        let (tp, tt, tf) = {
            let x = &self.holds[t as usize];
            (x.prov, x.tile, x.faction)
        };
        if tf == NEUTRAL || self.cfg.policy[tf as usize] != Policy::Lone {
            return;
        }
        let m = self.prov(tp).march;
        let c = self.prov(tp).coord;
        let mut donors: Vec<Donor> = Vec::new();
        for q in self.provinces_near(c, MAX_MARCH_DIST) {
            if self.prov(q).march != m {
                continue;
            }
            for &h in &self.prov(q).site_h {
                if h == NONE || h == t {
                    continue;
                }
                let y = &self.holds[h as usize];
                if y.alive
                    && y.faction == tf
                    && !y.free_city()
                    && self.agents[y.owner as usize].arch != Arch::Idle
                {
                    donors.push(Donor {
                        id: h as u64,
                        province: self.prov(y.prov).coord,
                        faction: y.faction,
                        garrison: y.garrison,
                        order_bps: 2_500,
                    });
                }
            }
        }
        donors.sort_by_key(|d| d.id);
        let mut out = auto_reinforce(t as u64, c, tf, &donors);
        out.sort_by_key(|x| (std::cmp::Reverse(x.1), x.0));
        self.mc_send_relief(out, tp, tt, Mission::Defend(t), attacker, b);
    }

    /// Send ≤ 4 relief hosts (the faction's arrival slots per bell).
    fn mc_send_relief(
        &mut self,
        out: Vec<(u64, MilliTroops)>,
        pi: u32,
        tile: u8,
        mission: Mission,
        attacker: u8,
        b: u32,
    ) {
        let mut sent = 0;
        for (id, n) in out {
            if sent == 4 || n < MIN_HOST_TROOPS {
                break;
            }
            let owner = self.holds[id as usize].owner;
            let prof = self.profiles[self.agents[owner as usize].arch.idx()];
            if self
                .send(
                    owner,
                    id as u32,
                    n,
                    pi,
                    tile,
                    mission,
                    b,
                    &prof,
                    Some(attacker),
                )
                .is_some()
            {
                sent += 1;
            }
        }
    }

    /// After the bell's clashes: keep contests, holding sieges and
    /// occupations count bell `b`.
    pub(super) fn mc_after_clashes(&mut self, b: u32) {
        if !self.mc() {
            return;
        }
        if self.cfg.rules.keeps() {
            let mut ks: BTreeSet<u32> = self.mcs.keep_live.clone();
            ks.extend(self.mcs.keep_resolved.drain(..));
            for pi in ks {
                self.mc_keep_bell(pi, b);
            }
        }
        let ss: Vec<u32> = self.mcs.msieges.iter().copied().collect();
        for t in ss {
            self.mc_siege_bell(t, b);
        }
        let os: Vec<u32> = self.mcs.occupied.iter().copied().collect();
        for t in os {
            self.mc_occupation_bell(t, b);
        }
        if b % BELLS_PER_DAY == BELLS_PER_DAY - 1 {
            self.mc_d9_check();
        }
    }

    // ---------------------------------------------------------- keeps

    fn mc_keep_bell(&mut self, pi: u32, b: u32) {
        let Some(mut k) = self.prov(pi).mkeep else {
            return;
        };
        let (holders, def) = match self.prov(pi).mkreport {
            Some((rb, h, d)) if rb == b => (h & 0x3F, d),
            _ => (0, false),
        };
        let f = if holders.count_ones() == 1 {
            holders.trailing_zeros() as u8
        } else {
            NO_FACTION
        };
        let stationed = self.prov(pi).stationed.clone();
        let mut caps: Vec<(u8, u64, u32)> = stationed
            .iter()
            .enumerate()
            .filter_map(|(i, &h)| {
                let x = &self.hosts[h as usize];
                (matches!(x.state, HState::Stationed { .. }) && x.tile == k.tile && x.faction == f)
                    .then_some((i.min(254) as u8, h as u64, x.troops.max(1)))
            })
            .collect();
        let prm = self.cfg.mc.keep_params();
        // The balance lab's day-end counters (`conquest::Track`), so the
        // `conquest` sweep prints out/cand.md's columns for MC too.
        let (since0, last0) = (k.since_bell, k.last_taken_from);
        let ev = cqk::advance(
            &mut k,
            b,
            KeepReport {
                holders,
                defender_present: def,
            },
            &prm,
            &mut caps,
        )
        .expect("keep troops ≤ MAX_HOST_TROOPS (R-01)");
        match ev {
            KeepEvent::Contest(att) => {
                self.mcs.st.keep_contests += 1;
                self.cq.keep_sieges += 1;
                self.mcs.keep_live.insert(pi);
                self.prov_mut(pi).mkeep = Some(k);
                self.mc_keep_alert(pi, att, b);
                return;
            }
            KeepEvent::Broken => {
                self.mcs.st.keep_broken += 1;
                self.cq.keep_failed += 1;
                self.mcs.keep_live.remove(&pi);
                let hs: Vec<u32> = stationed
                    .iter()
                    .copied()
                    .filter(|&h| {
                        let x = &self.hosts[h as usize];
                        x.mission == Mission::KeepDefend(pi) && x.state != HState::Dead
                    })
                    .collect();
                for h in hs {
                    self.unstation(pi, h);
                    self.send_home(h, b);
                }
            }
            KeepEvent::Taken {
                from,
                to,
                garrison,
                donor,
                donor_removed,
            } => {
                self.mcs.keep_live.remove(&pi);
                self.mcs.st.keep_taken += 1;
                {
                    let t = &mut self.cq;
                    t.keep_captures += 1;
                    t.kcap_by[to as usize] += 1;
                    t.klost_by[(from as usize).min(6)] += 1;
                    let tenure = b.saturating_sub(since0);
                    t.tenure[match tenure {
                        0..=35 => 0,
                        36..=143 => 1,
                        144..=431 => 2,
                        432..=1007 => 3,
                        _ => 4,
                    }] += 1;
                    if last0 == to && tenure < 432 {
                        t.flicker += 1;
                    }
                }
                self.mcs.ctl.events.push((b, pi, from, to));
                self.mcs.ctl.sampled[pi as usize] = to;
                let mut takers: Vec<u32> = Vec::new();
                for c in &caps {
                    let o = self.hosts[c.1 as usize].owner;
                    if !takers.contains(&o) {
                        takers.push(o);
                    }
                }
                for &o in &takers {
                    self.agents[o as usize].keeps_taken += 1;
                }
                if donor != u8::MAX {
                    let h = stationed[donor as usize];
                    let (owner, home, ht) = {
                        let x = &self.hosts[h as usize];
                        (x.owner, x.home, x.troops)
                    };
                    let arch = self.agents[owner as usize].arch;
                    self.mcs.st.keep_taken_by[arch.idx()] += 1;
                    self.prov_mut(pi).keep_captor = owner;
                    if donor_removed {
                        // The kernel put the whole host into the keep.
                        self.hosts[h as usize].troops = 0;
                        self.hosts[h as usize].state = HState::Dead;
                        self.unstation(pi, h);
                        let y = &mut self.holds[home as usize];
                        y.away = y.away.saturating_sub(ht);
                    } else {
                        let g = (garrison as MilliTroops * MILLI as MilliTroops).min(ht);
                        self.hosts[h as usize].troops = ht - g;
                        let y = &mut self.holds[home as usize];
                        y.away = y.away.saturating_sub(g);
                        self.unstation(pi, h);
                        self.send_home(h, b);
                    }
                    self.refresh_upkeep(home, b);
                }
                // The other hosts on the tile: home, except one forward base
                // (CQ1-B's choice, deviation D-8); with `--keep-stay` they
                // stay as the keep's defence (K-19 "other hosts stay").
                let mut rest: Vec<u32> = self
                    .prov(pi)
                    .stationed
                    .iter()
                    .copied()
                    .filter(|&h| {
                        let x = &self.hosts[h as usize];
                        x.tile == k.tile && x.faction == to && x.state != HState::Dead
                    })
                    .collect();
                rest.sort_by_key(|&h| (std::cmp::Reverse(self.hosts[h as usize].troops), h));
                let stage = self.cfg.forward && self.cfg.policy[to as usize] == Policy::Campaign;
                for (i, h) in rest.into_iter().enumerate() {
                    if stage && i == 0 {
                        self.hosts[h as usize].mission = Mission::Stage(pi);
                    } else if self.cfg.keep_stay {
                        self.hosts[h as usize].mission = Mission::KeepDefend(pi);
                    } else {
                        self.unstation(pi, h);
                        self.send_home(h, b);
                    }
                }
            }
            KeepEvent::None | KeepEvent::Paused => {
                if k.contender == NO_FACTION {
                    self.mcs.keep_live.remove(&pi);
                } else {
                    self.mcs.keep_live.insert(pi);
                }
            }
        }
        self.prov_mut(pi).mkeep = Some(k);
    }

    /// KEEP_CONTEST is public: a lone holder's standing order (the 4
    /// largest 25% shares of its holdings in the keep's March, ≤ 2
    /// provinces away, as the balance lab's keep defence).
    fn mc_keep_alert(&mut self, pi: u32, attacker: u8, b: u32) {
        let Some(k) = self.prov(pi).mkeep else { return };
        let hf = k.holder;
        if (hf as usize) >= 6 || self.cfg.policy[hf as usize] != Policy::Lone {
            return;
        }
        let m = self.prov(pi).march;
        let c = self.prov(pi).coord;
        let mut donors: Vec<(MilliTroops, u32)> = Vec::new();
        for q in self.provinces_near(c, 2) {
            if self.prov(q).march != m {
                continue;
            }
            for &h in &self.prov(q).site_h {
                if h == NONE {
                    continue;
                }
                let y = &self.holds[h as usize];
                if y.alive
                    && y.faction == hf
                    && !y.free_city()
                    && y.mc.siege.is_none()
                    && self.agents[y.owner as usize].arch != Arch::Idle
                {
                    donors.push((y.garrison / 4, h));
                }
            }
        }
        donors.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
        let out: Vec<(u64, MilliTroops)> = donors.into_iter().map(|(g, h)| (h as u64, g)).collect();
        self.mc_send_relief(out, pi, k.tile, Mission::KeepDefend(pi), attacker, b);
    }

    // ---------------------------------------------------------- sieges

    fn mc_siege_bell(&mut self, t: u32, b: u32) {
        let Some(mut rec) = self.holds[t as usize].mc.siege else {
            self.mcs.msieges.remove(&t);
            return;
        };
        if rec.declared >= b {
            return;
        }
        let r = match self.holds[t as usize].report {
            Some((rb, r)) if rb == b => r,
            _ => BellReport {
                holders: 0,
                defender_present: false,
            },
        };
        if !r.holds(rec.attacker_faction) {
            self.mc_siege_failed(t, b, rec, r.defender_present);
            return;
        }
        let counts = !r.defender_present && rec.vigil.is_none_or(|v| !vigil_covers(&v, b));
        if counts {
            rec.progress += 1;
        }
        if rec.progress >= rec.required {
            self.holds[t as usize].mc.siege = None;
            self.mcs.msieges.remove(&t);
            self.mc_siege_completed(t, b, rec);
        } else {
            self.holds[t as usize].mc.siege = Some(rec);
        }
    }

    fn mc_stake_back(&mut self, src: u32, b: u32) {
        let x = &mut self.holds[src as usize];
        if x.alive {
            let _ = x.h.credit(
                now_of(b),
                Resource::Gold,
                self.cfg.mc.siege_stake_gold * MILLI,
            );
        }
    }

    fn mc_release_slot(&mut self, a: u32, slot: u8) {
        if slot == 0 {
            return;
        }
        let v = &mut self.agents[a as usize].reserved;
        if let Some(i) = v.iter().position(|&s| s == slot) {
            v.swap_remove(i);
        }
    }

    fn mc_siege_failed(&mut self, t: u32, b: u32, rec: McSiege, broken: bool) {
        self.holds[t as usize].mc.siege = None;
        self.mcs.msieges.remove(&t);
        self.mcs.st.sieges_failed += 1;
        self.stats.sieges_failed += 1;
        let fc = self.holds[t as usize].free_city();
        if !fc && self.holds[t as usize].h.order <= 1 {
            self.mcs.st.dbg[if broken { 5 } else { 6 }] += 1;
            if rec.progress > 0 {
                self.mcs.st.dbg[7] += 1;
            }
            self.mcs.st.dbg[match self.hosts[rec.lead_host as usize].state {
                HState::Dead => 8,
                HState::Returning => 9,
                _ => 10,
            }] += 1;
        }
        if broken && !fc {
            // Stake owed to the target at its generation; immunity against
            // the besieging faction only (K-06, R-05).
            self.mcs.st.failed_by_defender += 1;
            self.mc_stake_back(t, b);
            let x = &mut self.holds[t as usize];
            x.mc.immune_until = b + 1 + self.cfg.mc.immunity_bells;
            x.mc.barred = rec.attacker_faction;
        }
        self.mc_release_slot(rec.declarer, rec.slot);
        self.mc_recall(t, b, |m| {
            matches!(
                m,
                Mission::Siege(_) | Mission::Rally(_) | Mission::Defend(_)
            )
        });
        self.holds[t as usize].posture = Posture::default();
    }

    fn mc_siege_completed(&mut self, t: u32, b: u32, rec: McSiege) {
        self.mcs.st.sieges_completed += 1;
        self.stats.sieges_completed += 1;
        let first = {
            let x = &self.holds[t as usize];
            !x.free_city() && x.h.order <= 1
        };
        self.mc_recall(t, b, |m| matches!(m, Mission::Defend(_)));
        self.holds[t as usize].posture = Posture::default();
        if first {
            // Occupation (D9 kept): ownership never changes.
            self.mc_stake_back(rec.src, b);
            self.mc_release_slot(rec.declarer, rec.slot);
            let pi = self.holds[t as usize].prov;
            let tile = self.holds[t as usize].tile;
            let occ_host = if matches!(
                self.hosts[rec.lead_host as usize].state,
                HState::Stationed { .. }
            ) && self.hosts[rec.lead_host as usize].tile == tile
            {
                Some(rec.lead_host)
            } else {
                self.mc_lead_on(pi, tile, self.holds[t as usize].faction, b + 1)
            };
            let Some(h) = occ_host else { return };
            self.hosts[h as usize].mission = Mission::Occupy(t);
            let x = &mut self.holds[t as usize];
            x.occupier = Some((rec.declarer, h));
            x.mc.occ_start = b;
            x.mc.occ_faction = rec.attacker_faction;
            self.mcs.occupied.insert(t);
            self.mcs.st.occupations += 1;
            self.stats.occupations += 1;
            self.mc_recall(t, b, |m| matches!(m, Mission::Rally(_) | Mission::Siege(_)));
            self.reweigh(t, b);
        } else {
            self.mc_capture(t, b, rec);
        }
    }

    /// Capture at the completion bell (§3.6, K-25, K-26): the flip and the
    /// settle's bookkeeping in one step (the sim settles at once).
    fn mc_capture(&mut self, t: u32, b: u32, rec: McSiege) {
        let prm = self.cfg.mc;
        let now = now_of(b);
        let (pi, tile, victim, genesis) = {
            let x = &self.holds[t as usize];
            (x.prov, x.tile, x.owner, x.mc.genesis_fc)
        };
        let credited = cqk::capture_credited(
            b,
            self.holds[t as usize].mc.held_since_hour,
            prm.capture_credit_min_bells,
            genesis,
        );
        // Final credit to the victim, then the flip.
        self.holds[t as usize].alive = false;
        self.reweigh(t, b);
        let was_free = victim == NONE;
        if !was_free {
            self.mcs.st.captures += 1;
            self.stats.captures += 1;
            self.agents[victim as usize].holdings.retain(|&h| h != t);
        } else {
            self.mcs.st.fc_captures += 1;
            self.stats.free_city_captures += 1;
        }
        let captor = rec.declarer;
        if credited {
            self.mcs.st.credited += 1;
            self.agents[captor as usize].facts[0] += prm.dominion_per_capture * 1_000;
        } else {
            self.mcs.st.uncredited += 1;
        }
        // The captor garrisons its lead host if it stands on the hex; the
        // rally goes home.
        let lead = rec.lead_host;
        let ht = if matches!(self.hosts[lead as usize].state, HState::Stationed { .. })
            && self.hosts[lead as usize].tile == tile
            && self.hosts[lead as usize].owner == captor
        {
            let ht = self.hosts[lead as usize].troops;
            self.unstation(pi, lead);
            let home = self.hosts[lead as usize].home;
            self.hosts[lead as usize].state = HState::Dead;
            let y = &mut self.holds[home as usize];
            y.away = y.away.saturating_sub(ht);
            self.refresh_upkeep(home, b);
            ht
        } else {
            0
        };
        self.mc_recall(t, b, |m| matches!(m, Mission::Rally(_) | Mission::Siege(_)));
        let faction = self.agents[captor as usize].faction;
        // `holding::capture_effects` itself (integ-W1 R2): walls halved
        // unless the captor's doctrine keeps them. The simulator then
        // garrisons the lead host at once (the captor's next Garrison).
        let fx = permutation_rules::frontier::holding::capture_effects(
            &self.holds[t as usize].h,
            self.doctrine[faction as usize].k,
        );
        {
            let x = &mut self.holds[t as usize];
            x.owner = captor;
            x.faction = faction;
            x.h.order = rec.slot.max(2);
            x.h.last_owner_action = now;
            x.garrison = ht;
            x.away = 0;
            x.alive = true;
            x.occupier = None;
            x.vigil =
                Vigil::new(self.agents[captor as usize].tz * BELL_SECS as u32).expect("vigil");
            x.h.walls = fx.walls;
            x.mc = HoldMc {
                immune_until: b + 1 + prm.immunity_bells,
                barred: ALL_FACTIONS,
                held_since_hour: cqk::held_since_hour(b + 1),
                ..HoldMc::default()
            };
        }
        if was_free {
            let base = self.base_prod(faction, HTier::Hamlet);
            let x = &mut self.holds[t as usize];
            x.h.production = base;
            x.base_tier = HTier::Hamlet;
        } else if !credited {
            let x = &mut self.holds[t as usize];
            let st = x.h.stock_at(now);
            let _ = x.h.pay(now, &st);
        }
        self.mc_release_slot(captor, rec.slot);
        self.agents[captor as usize].holdings.push(t);
        self.mc_stake_back(rec.src, b);
        self.apply_tier_bonus(t, b);
        self.refresh_upkeep(t, b);
        self.reweigh(t, b);
        self.schedule_dormancy(t, b);
    }

    fn mc_occupation_bell(&mut self, t: u32, b: u32) {
        let (start, of, occ) = {
            let x = &self.holds[t as usize];
            (x.mc.occ_start, x.mc.occ_faction, x.occupier)
        };
        let Some((_, _host)) = occ else {
            self.mcs.occupied.remove(&t);
            return;
        };
        if start >= b {
            return;
        }
        let r = match self.holds[t as usize].report {
            Some((rb, r)) if rb == b => r,
            _ => BellReport {
                holders: 0,
                defender_present: false,
            },
        };
        let end = cqk::occupation_ends(
            r.holds(of),
            r.defender_present,
            b,
            start,
            self.cfg.mc.occupation_tenure_bells,
        );
        let Some((kind, respite)) = end else { return };
        match kind {
            cqk::OccupationEndKind::Liberated => {
                self.mcs.st.liberations += 1;
                self.stats.liberations += 1;
                if !respite {
                    self.mcs.st.liberated_no_respite += 1;
                }
            }
            cqk::OccupationEndKind::Expired => self.mcs.st.expiries += 1,
        }
        self.mcs.occupied.remove(&t);
        let x = &mut self.holds[t as usize];
        x.occupier = None;
        if respite {
            x.mc.immune_until = x.mc.immune_until.max(b + self.cfg.mc.respite_bells);
            x.mc.barred = of;
        }
        self.mc_recall(t, b, |m| matches!(m, Mission::Occupy(_)));
        self.reweigh(t, b);
    }

    // ---------------------------------------------------------- outposts

    /// FileOutpost + SettleTicket (§3.8), settled at once (the cohort
    /// lottery is abstracted, as M1's first-holding tickets are). Every
    /// rule of the filing is `holding::may_found_outpost` itself (integ-W1
    /// R2): first with a target that passes ring, range and share (the
    /// count, prerequisite, land gate and close checks, before the
    /// activity roll), then per candidate province.
    pub(super) fn mc_expand(&mut self, a: u32, b: u32, p: &Profile) -> i64 {
        use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck};
        let prm = self.cfg.mc;
        let (faction, holds) = {
            let ag = &self.agents[a as usize];
            (ag.faction, ag.holdings.clone())
        };
        if holds.is_empty() || b <= self.agents[a as usize].strike_until {
            return 0;
        }
        let first = holds
            .iter()
            .copied()
            .find(|&h| self.holds[h as usize].h.order == 1);
        let base = OutpostCheck {
            slot: self.mc_free_slot23(a),
            first_final: first.is_some(),
            first_tier: first.map_or(HTier::Hamlet, |h| self.holds[h as usize].h.tier),
            tier_min: if prm.outpost_tier_min == 0 {
                HTier::Hamlet
            } else {
                HTier::Town
            },
            slot2_final: holds.iter().any(|&h| self.holds[h as usize].h.order == 2),
            target_ring: prm.heartland_max_ring + 1,
            heartland_max_ring: prm.heartland_max_ring.min(u8::MAX as u32) as u8,
            range: 0,
            outpost_range: prm.outpost_range.min(u8::MAX as u32) as u8,
            faction_weight: 0,
            province_weight: 0,
            outpost_share_bps: prm.outpost_share_bps.min(u16::MAX as u32) as u16,
            free_sites: self.open_sites.saturating_sub(self.used_sites),
            open_sites: self.open_sites,
            now_bell: b,
            end_bell: self.end_bell,
            outpost_close_bells: prm.outpost_close_bells.min(u16::MAX as u32) as u16,
        };
        if may_found_outpost(&base).is_err() || !self.rng.chance(p.q) {
            return 0;
        }
        let Some(first) = first else { return 0 };
        let now = now_of(b);
        let d = self.doctrine[faction as usize];
        let n = holds.len() as u32 + 1;
        let c: [Milli; RESOURCES] = core::array::from_fn(|r| {
            bps_mul(
                duplicate_cost(SETTLER_COST[r] as u64, n - 1).cost() as i64,
                d.settler_cost_bps,
            ) * MILLI
        });
        let stock = self.holds[first as usize].h.stock_at(now);
        if (0..RESOURCES).any(|r| stock[r] < c[r]) {
            return 0;
        }
        let centre = self.prov(self.holds[first as usize].prov).coord;
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        let mut best: Option<(u32, u32, u8)> = None;
        for &h in &holds {
            let hc = self.prov(self.holds[h as usize].prov).coord;
            for pi in self.provinces_near(hc, prm.outpost_range) {
                if !seen.insert(pi) {
                    continue;
                }
                let pr = self.prov(pi);
                let Some(slot_i) = pr.site_h.iter().position(|&x| x == NONE) else {
                    continue;
                };
                // The outpost rule's weights: the faction's and the
                // province's strength weight (an empty province qualifies).
                let (mut mine, mut tot) = (0u64, 0u64);
                for &g in &pr.site_h {
                    if g == NONE {
                        continue;
                    }
                    let y = &self.holds[g as usize];
                    if !y.alive {
                        continue;
                    }
                    let w =
                        strength_weight(ltier(y.h.tier), y.garrison, y.h.order.saturating_sub(1));
                    tot += w;
                    if y.faction == faction {
                        mine += w;
                    }
                }
                let chk = OutpostCheck {
                    target_ring: pr.ring,
                    range: hc.distance(pr.coord),
                    faction_weight: mine,
                    province_weight: tot,
                    ..base
                };
                if may_found_outpost(&chk).is_err() {
                    continue;
                }
                let score = centre.distance(pr.coord);
                if best.is_none_or(|x| (score, pi) < (x.0, x.1)) {
                    best = Some((score, pi, slot_i as u8));
                }
            }
        }
        let Some((_, pi, site)) = best else { return 0 };
        if self.holds[first as usize].h.pay(now, &c).is_err() {
            return 0;
        }
        self.found(a, pi, site, b, 0);
        self.stats.second_holdings += 1;
        self.mcs.st.outposts += 1;
        2
    }

    // ---------------------------------------------------------- Dominion

    /// The hourly snapshot and FoldMarch of §3.10 (points only): strength
    /// weight per side, the strict controller, 6 control-bells an hour;
    /// `bannerdom` and `keepdom` variants.
    pub(super) fn mc_dominion(&mut self, _b: u32) {
        let nm = self.marches.len();
        let prm = self.cfg.mc;
        let mut w = vec![[0u64; cqk::SIDES]; nm];
        let side_of = |x: &Hold| -> usize {
            if x.free_city() {
                6
            } else if x.occupier.is_some() {
                x.mc.occ_faction as usize
            } else {
                x.faction as usize
            }
        };
        let cw = |x: &Hold| {
            strength_weight(ltier(x.h.tier), x.garrison, x.h.order.saturating_sub(1)) / 10_000
        };
        for x in &self.holds {
            if !x.alive {
                continue;
            }
            let m = self.prov(x.prov).march as usize;
            w[m][side_of(x)] += cw(x);
        }
        let ctl: Vec<Option<u8>> = w.iter().map(cqk::controller).collect();
        let banner: Vec<Option<u8>> = if self.cfg.bannerdom > 0 {
            self.mc_banners()
        } else {
            vec![None; nm]
        };
        let mut credit: Vec<(u32, u64)> = Vec::new();
        for x in &self.holds {
            if !x.alive || x.free_city() {
                continue;
            }
            let m = self.prov(x.prov).march as usize;
            let s = side_of(x);
            let who = match x.occupier {
                Some((o, _)) => o,
                None => x.owner,
            };
            let wx = cw(x);
            if ctl[m] == Some(s as u8) && w[m][s] > 0 {
                credit.push((who, prm.dominion_per_hour * 1_000 * wx / w[m][s]));
            }
            if banner[m] == Some(s as u8) && w[m][s] > 0 {
                credit.push((who, self.cfg.bannerdom * 1_000 * wx / w[m][s]));
            }
        }
        if self.cfg.bannerdom > 0 {
            // A banner faction with no holding in the March: its last keep
            // taker there.
            for (m, bf) in banner.iter().enumerate() {
                let Some(f) = *bf else { continue };
                if w[m][f as usize] > 0 {
                    continue;
                }
                let who = self
                    .provs
                    .iter()
                    .flatten()
                    .filter(|p| p.march as usize == m)
                    .filter_map(|p| p.mkeep.filter(|k| k.holder == f).map(|_| p.keep_captor))
                    .find(|&c| c != NONE);
                if let Some(c) = who {
                    credit.push((c, self.cfg.bannerdom * 1_000));
                }
            }
        }
        if self.cfg.keepdom {
            for p in self.provs.iter().flatten() {
                if let Some(k) = p.mkeep {
                    if k.gen > 0 && p.keep_captor != NONE {
                        credit.push((p.keep_captor, 1_000));
                    }
                }
            }
        }
        for (a, c) in credit {
            self.agents[a as usize].facts[0] += c;
        }
    }

    /// March banners from the keep holders (§3.3).
    pub(super) fn mc_banners(&self) -> Vec<Option<u8>> {
        let nm = self.marches.len();
        let mut members: Vec<Vec<u8>> = vec![Vec::new(); nm];
        for p in self.provs.iter().flatten() {
            if let Some(k) = p.mkeep {
                members[p.march as usize].push(k.holder);
            }
        }
        members.iter().map(|v| cqk::march_banner(v)).collect()
    }

    /// Weight-model control series (M1 and `mc-weightmap`), sampled at the
    /// hour's last bell: the strict strength-weight controller per
    /// province; occupations count for the occupier only under MC.
    pub(super) fn mc_sample_control(&mut self, b: u32) {
        if self.cfg.rules.keeps() {
            return;
        }
        let np = self.provs.len();
        if self.mcs.ctl.sampled.len() < np {
            self.mcs.ctl.sampled.resize(np, NO_FACTION);
        }
        let occ = self.mc();
        let mut w = vec![[0u64; cqk::SIDES]; np];
        let mut any = vec![false; np];
        for x in &self.holds {
            if !x.alive {
                continue;
            }
            let s = if x.free_city() {
                6
            } else if occ && x.occupier.is_some() {
                x.mc.occ_faction as usize
            } else {
                x.faction as usize
            };
            w[x.prov as usize][s] +=
                strength_weight(ltier(x.h.tier), x.garrison, x.h.order.saturating_sub(1));
            any[x.prov as usize] = true;
        }
        for i in 0..np {
            if self.provs[i].is_none() {
                continue;
            }
            let c = if any[i] {
                cqk::controller(&w[i]).unwrap_or(NO_FACTION)
            } else {
                NO_FACTION
            };
            let prev = self.mcs.ctl.sampled[i];
            if c != prev {
                self.mcs.ctl.events.push((b, i as u32, prev, c));
                self.mcs.ctl.sampled[i] = c;
            }
        }
    }

    /// The season end (§3.11): open sieges lapse, stakes and slots back.
    pub(super) fn mc_finish(&mut self) {
        if !self.mc() {
            return;
        }
        let b = self.end_bell;
        let ss: Vec<u32> = self.mcs.msieges.iter().copied().collect();
        for t in ss {
            if let Some(rec) = self.holds[t as usize].mc.siege.take() {
                self.mcs.st.lapsed += 1;
                self.mc_stake_back(rec.src, b);
                self.mc_release_slot(rec.declarer, rec.slot);
            }
        }
        self.mcs.msieges.clear();
        self.mc_d9_check();
    }

    /// Count a Depart (and a keep march) by the sender's archetype.
    pub(super) fn mc_note_depart(&mut self, a: u32, mission: Mission) {
        let i = self.agents[a as usize].arch.idx();
        self.mcs.st.departs[i] += 1;
        if matches!(mission, Mission::Keep(_) | Mission::KeepRally(_)) {
            self.mcs.st.keep_marches[i] += 1;
        }
    }

    /// Whether an arriving host on a keep mission has nothing to do.
    pub(super) fn mc_keep_arrival_idle(&self, h: u32) -> bool {
        let x = &self.hosts[h as usize];
        let (Mission::Keep(kp) | Mission::KeepRally(kp) | Mission::KeepDefend(kp)) = x.mission
        else {
            return false;
        };
        let Some(k) = self.provs[kp as usize].as_ref().and_then(|p| p.mkeep) else {
            return true;
        };
        match x.mission {
            Mission::KeepDefend(_) => {
                k.holder != x.faction
                    || (k.contender == NO_FACTION
                        && !self.prov(kp).stationed.iter().any(|&o| {
                            let y = &self.hosts[o as usize];
                            y.tile == k.tile && y.faction != x.faction && y.state != HState::Dead
                        }))
            }
            _ => k.holder == x.faction,
        }
    }

    /// Whether the MC rules use the given Rules variant (tests).
    #[allow(dead_code)]
    pub fn rules(&self) -> Rules {
        self.cfg.rules
    }
}
