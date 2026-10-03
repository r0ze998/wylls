//! The conquest layer (`frontier-bots --conquest`, MC contract v1.3 §8.6,
//! unit CQ2-F).
//!
//! **One planner epoch per game hour, shared by the fleet.** Every bot of a
//! faction computes the same plan from the same immutable herald files
//! (`frontier_agents::campaign`); the fleet is one process, so [`Conquest`]
//! computes it once per epoch and the bots read it (the result is a pure
//! function of the files, so a bot that computed it alone would get the
//! same plan: `cq_plan_identical_across_32_bots_with_shuffled_observations`).
//! The inputs are the herald's files of the epoch's last bell
//! (`/h/province/{P},{Q}/{bell}`, `/h/me/{wallet}` of every fleet wallet,
//! `/h/call/{day}.json`, the Season's `ConquestParams`); a bot reads no
//! chain account and no file the herald does not serve to anyone.
//!
//! **What a bot does with the plan** (§8.6 behaviours): a dispatch becomes a
//! march [`Order`] (Muster, then a sealed Depart through the relay); the
//! lead host's owner sounds the horn (`DeclareSiege`, relay-sponsored); a
//! victim retires its previous-generation hosts (`RetireHost`); daily
//! players and up file outposts at the front (`FileOutpost`). Each is
//! checked locally first (`cqbehave::declare_check` and friends) and the
//! horn is re-checked against the target's latest record at send time.
//!
//! **The personas** ([`CqPersona`], each ≤ 1% of the bots, `--conquest`):
//! a persona bot is no campaign member; it takes its persona's action
//! ([`cqpersona::act`]) once per epoch and the report compares the code it
//! got with the one §8.6 expects.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::addr::Addresses;
use fclient::ix::HoldingRef;
use fclient::{Address, Signer};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as S2};
use frontier_abi::v2::presets::ConquestParams;
use frontier_agents::campaign::{self as cp, Board, EpochPlan, Mission, Target, World};
use frontier_agents::cqbehave::{self, CqIntent, SiteStates};
use frontier_agents::cqobs::{
    call_of_json, conquest_events, entry_index, params_of, site_states, world_from_herald,
    FleetMarch, FleetWallet, HeraldEpoch, WorldIds, FOREIGN_AGENT,
};
use frontier_agents::cqorder::{self, Order, Step};
use frontier_agents::cqpersona::{self, CqPersona, Expect};
use frontier_agents::keys;
use frontier_agents::obs::{b64, Observation};
use frontier_agents::policy::Intent;
use frontier_agents::profile::{AgentSpec, BELLS_PER_DAY};
use frontier_agents::rng::Rng;
use serde_json::Value;

use crate::bot::{Bot, Shared};
use crate::cqtx;
use crate::ports::{DirectPort, HeraldPort, RelayPort};
use crate::report::{CampaignRow, CqOutcome};

/// Planner epochs are game hours.
pub const HOUR_BELLS: u32 = cp::HOUR_BELLS;
/// Game seconds into an epoch hour before a bot reads it: the epoch's last
/// bell has resolved (resident actions need `b − 2`; the herald's per-bell
/// files appear when the bell completes).
pub const EPOCH_OFFSET_SECS: i64 = 90;

/// Layer settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CqConfig {
    /// Bots per conquest persona (≤ max(1, bots / 100): each ≤ 1%).
    pub personas_per: u32,
}

impl Default for CqConfig {
    fn default() -> Self {
        CqConfig { personas_per: 1 }
    }
}

/// What one bot remembers for the layer.
#[derive(Default)]
pub struct CqMem {
    pub persona: Option<CqPersona>,
    /// Open march orders.
    pub orders: Vec<Order>,
    /// Holdings this wallet has held (P, Q, site, gen): a lost one is a
    /// capture's victim record (Retire).
    pub held: BTreeSet<(i16, i16, u8)>,
    /// The epoch bell this bot last decided for.
    pub last_epoch: Option<u32>,
    /// Hosts retired already (RetireHost is idempotent on chain; the bot
    /// sends it once).
    pub retired: BTreeSet<u64>,
}

/// One planner epoch as the fleet reads it.
pub struct EpochState {
    /// The epoch bell (a multiple of [`HOUR_BELLS`]); the files are the
    /// previous bell's.
    pub bell: u32,
    pub world: World,
    pub ids: WorldIds,
    pub states: SiteStates,
    /// The board after the epoch's planning (campaigns, strikes pending).
    pub board: Board,
    pub plan: EpochPlan,
    /// Province v2 accounts of the epoch, by (P, Q).
    pub provinces: BTreeMap<(i16, i16), Vec<u8>>,
}

#[derive(Default)]
struct Inner {
    last: Option<Arc<EpochState>>,
    board: Board,
    /// The last bell a read was tried and failed (not retried within it).
    failed_bell: Option<u32>,
    params: Option<frontier_agents::campaign::Params>,
    /// Chain host id → its mission (the marchbook of conquest marches).
    missions: BTreeMap<u64, Mission>,
    marches: Vec<FleetMarch>,
    /// The planner's stable host ids (chain host id → id) and the first id
    /// never given: a campaign's attempt keeps naming its hosts across
    /// epochs.
    stable: BTreeMap<u64, u32>,
    next_host: u32,
    events_day_read: BTreeMap<u32, u32>,
}

/// The fleet's conquest hub (`Shared::conquest`).
pub struct Conquest {
    pub cfg: CqConfig,
    seed: u64,
    specs: Vec<AgentSpec>,
    personas: BTreeMap<u32, CqPersona>,
    st: tokio::sync::Mutex<Inner>,
}

impl Conquest {
    /// The layer for a roster: the personas are dealt to bots with no M1
    /// persona, deterministically in the seed.
    pub fn new(seed: u64, roster: &[AgentSpec], cfg: CqConfig) -> Conquest {
        let cap = (roster.len() / 100).max(1) as u32;
        let per = cfg.personas_per.min(cap);
        let dealt = cqpersona::assign(seed, roster.len(), &|i| roster[i].persona.is_some(), per);
        let personas = dealt
            .into_iter()
            .map(|(i, p)| (roster[i].index, p))
            .collect();
        Conquest {
            cfg: CqConfig { personas_per: per },
            seed,
            specs: roster.to_vec(),
            personas,
            st: tokio::sync::Mutex::new(Inner::default()),
        }
    }

    pub fn persona_of(&self, index: u32) -> Option<CqPersona> {
        self.personas.get(&index).copied()
    }

    pub fn personas(&self) -> &BTreeMap<u32, CqPersona> {
        &self.personas
    }

    /// The report's starting state: enabled, who got which persona, how
    /// many bots join on each day.
    pub fn seed_report(&self, r: &mut crate::report::CqReport) {
        r.enabled = true;
        for p in self.personas.values() {
            *r.personas_assigned.entry(p.name()).or_default() += 1;
        }
        for s in &self.specs {
            *r.join_days.entry(s.join_day).or_default() += 1;
        }
    }

    /// The wallet of a World agent id (a fleet bot), if it is one.
    fn wallet_of(&self, agent: u32) -> Option<Address> {
        (agent < FOREIGN_AGENT && self.specs.iter().any(|s| s.index == agent))
            .then(|| keys::wallet(self.seed, agent).pubkey())
    }

    /// A conquest march the fleet sent (the planner sees its mission and
    /// its transit): `m.host_id` is the chain host id, `planned` the id the
    /// plan gave the host it meant (NONE: none). The chain host takes the
    /// planned id when it has none yet; when it has another (the bot sent a
    /// host it already had), the campaigns' attempts are renamed to it.
    pub async fn note_march(&self, m: FleetMarch, planned: u32) {
        let mut st = self.st.lock().await;
        let id = match st.stable.get(&m.host_id) {
            Some(&i) => i,
            None => {
                let i = if planned != cp::NONE {
                    planned
                } else {
                    st.next_host += 1;
                    st.next_host - 1
                };
                st.stable.insert(m.host_id, i);
                i
            }
        };
        if planned != cp::NONE && planned != id {
            for cs in st.board.camps.iter_mut() {
                for c in cs.iter_mut() {
                    if let Some(a) = c.attempt.as_mut() {
                        for h in a.hosts.iter_mut().filter(|h| **h == planned) {
                            *h = id;
                        }
                    }
                }
            }
        }
        st.missions.insert(m.host_id, m.mission);
        st.marches.retain(|x| x.host_id != m.host_id);
        st.marches.push(m);
    }

    /// The epoch of `bell` (computed once, shared); `None` when its files
    /// are not there yet (tried again at the next bell).
    pub async fn epoch<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &self,
        sh: &Shared<H, R, D>,
        bell: u32,
    ) -> Option<Arc<EpochState>> {
        let e_bell = bell - bell % HOUR_BELLS;
        let mut st = self.st.lock().await;
        if let Some(l) = &st.last {
            if l.bell == e_bell {
                return Some(l.clone());
            }
        }
        if st.failed_bell == Some(bell) {
            return None;
        }
        match self.build(sh, &mut st, e_bell).await {
            Ok(es) => {
                let es = Arc::new(es);
                st.last = Some(es.clone());
                Some(es)
            }
            Err(e) => {
                st.failed_bell = Some(bell);
                let mut r = sh.report.lock().expect("report");
                r.cq.epochs_unready += 1;
                r.error(&format!("conquest epoch: {e}"));
                None
            }
        }
    }

    async fn get_json<H: HeraldPort>(h: &H, path: &str) -> Option<Value> {
        match h.get(path).await {
            Ok(Some(b)) => serde_json::from_slice(&b).ok(),
            _ => None,
        }
    }

    async fn build<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &self,
        sh: &Shared<H, R, D>,
        st: &mut Inner,
        e_bell: u32,
    ) -> Result<EpochState, String> {
        let season = sh.season().await?;
        let end_bell = season.end_bell();
        if e_bell >= end_bell {
            return Err("after the season".into());
        }
        // The Season's ConquestParams (once): an MC season always has the
        // block, at the version this planner reads; anything else is not a
        // season to guess about.
        if st.params.is_none() {
            let raw = Self::get_json(&sh.herald, "/h/season").await;
            let cq = raw
                .as_ref()
                .and_then(|v| v.get("bytes_b64"))
                .and_then(|b| b.as_str())
                .and_then(|s| b64(s).ok())
                .and_then(|b| ConquestParams::of_season(&b))
                .filter(|c| c.conquest_version == frontier_abi::v2::presets::CONQUEST_VERSION)
                .ok_or("the Season has no ConquestParams block at this version")?;
            st.params = Some(params_of(&cq));
            sh.report.lock().expect("report").cq.sieges_per_day = cq.sieges_per_day as u32;
        }
        let prev = e_bell.saturating_sub(1);
        // Opened provinces from the overviews; their v2 accounts at the
        // epoch's last bell (the `latest` file when that bell's is not
        // served yet; counted).
        let mut coords: BTreeSet<(i16, i16)> = BTreeSet::new();
        for d in 0..season.rings_opened().max(3) {
            if let Some(o) = sh.overview(d).await {
                coords.extend(o.provinces.iter().filter(|r| r.opened).map(|r| (r.p, r.q)));
            }
        }
        if coords.is_empty() {
            return Err("no opened provinces".into());
        }
        let mut provinces = BTreeMap::new();
        let mut fallbacks = 0u64;
        for (p, q) in coords {
            let mut v = Self::get_json(&sh.herald, &format!("/h/province/{p},{q}/{prev}")).await;
            if v.is_none() {
                v = Self::get_json(&sh.herald, &format!("/h/province/{p},{q}/latest")).await;
                fallbacks += v.is_some() as u64;
            }
            let Some(bytes) = v
                .as_ref()
                .and_then(|v| v.get("bytes"))
                .and_then(|b| b.as_str())
                .and_then(|s| b64(s).ok())
            else {
                continue;
            };
            if bytes.len() == P2::SIZE {
                provinces.insert((p, q), bytes);
            }
        }
        if provinces.is_empty() {
            return Err("no Province v2 accounts".into());
        }
        // The fleet's wallets (joined by the epoch).
        let mut wallets = vec![];
        for s in self.specs.iter().filter(|s| s.join_bell <= e_bell) {
            let w = keys::wallet(self.seed, s.index).pubkey();
            let Some(v) = Self::get_json(&sh.herald, &format!("/h/me/{w}")).await else {
                continue;
            };
            let citizen = v
                .get("citizen")
                .filter(|c| !c.is_null())
                .and_then(|c| c.get("bytes_b64"))
                .and_then(|b| b.as_str())
                .and_then(|s| b64(s).ok());
            let holdings = v
                .get("holdings")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter()
                        .filter_map(|h| h.get("bytes_b64").and_then(|b| b.as_str()))
                        .filter_map(|s| b64(s).ok())
                        .collect()
                })
                .unwrap_or_default();
            wallets.push(FleetWallet {
                agent: s.index,
                arch: s.arch,
                faction: s.faction,
                citizen,
                holdings,
            });
        }
        let day = e_bell / BELLS_PER_DAY;
        let call = match Self::get_json(&sh.herald, &format!("/h/call/{day}.json")).await {
            Some(v) => call_of_json(&v).ok(),
            None => None,
        };
        st.marches.retain(|m| m.arrive >= e_bell);
        let epoch = HeraldEpoch {
            bell: e_bell,
            end_bell,
            genesis_ts: season.genesis_ts,
            params: st.params,
            provinces: provinces.clone(),
            wallets,
            missions: st.missions.clone(),
            marches: st.marches.clone(),
            call,
            host_ids: st.stable.clone(),
            next_host: st.next_host,
        };
        let (mut world, ids) = world_from_herald(&epoch).map_err(|e| e.to_string())?;
        st.stable
            .extend(ids.host_of_chain.iter().map(|(c, i)| (*c, *i)));
        // Persona bots and every M1 persona are no campaign members.
        for s in &self.specs {
            if s.persona.is_some() || self.personas.contains_key(&s.index) {
                if let Some(a) = world.agents.get_mut(&s.index) {
                    a.arch = None;
                }
            }
        }
        let states = site_states(&provinces);
        let factions = [true; 6];
        let (board, plan, after) = cp::plan_all(self.seed, &factions, &world, &st.board);
        st.next_host = after.next_host.max(world.next_host);
        st.board = board.clone();
        self.account(sh, st, &world, &board, &plan, day).await;
        {
            let mut r = sh.report.lock().expect("report");
            r.cq.epochs += 1;
            r.cq.latest_fallbacks += (fallbacks > 0) as u64;
        }
        Ok(EpochState {
            bell: e_bell,
            world,
            ids,
            states,
            board,
            plan,
            provinces,
        })
    }

    /// The report's rows of an epoch: its campaigns and the herald's
    /// conquest events of the day (each event once).
    async fn account<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &self,
        sh: &Shared<H, R, D>,
        st: &mut Inner,
        w: &World,
        board: &Board,
        plan: &EpochPlan,
        day: u32,
    ) {
        let mut sent: BTreeMap<u8, u32> = BTreeMap::new();
        for d in &plan.dispatches {
            *sent.entry(d.faction).or_default() += 1;
        }
        let mut rows = vec![];
        for (f, cs) in board.camps.iter().enumerate() {
            for c in cs {
                let (kind, pi, site) = match c.target {
                    Target::Keep(pi) => ("keep", pi, None),
                    Target::Hold(t) => {
                        let h = w.hold(t);
                        let s = w.prov(h.prov).sites.iter().position(|&x| x == t);
                        ("hold", h.prov, s.map(|s| s as u8))
                    }
                };
                let pc = w.prov(pi).coord;
                rows.push(CampaignRow {
                    faction: f as u8,
                    kind,
                    p: pc.p as i16,
                    q: pc.q as i16,
                    site,
                    first_bell: w.bell,
                    last_bell: w.bell,
                    epochs: 1,
                    fails: c.fails,
                    hosts_sent: sent.get(&(f as u8)).copied().unwrap_or(0),
                });
            }
        }
        // The events of this day and the previous one (an epoch at a day
        // start still reads yesterday's last hours).
        let mut events = vec![];
        for d in [day.saturating_sub(1), day] {
            if st.events_day_read.get(&d) == Some(&w.bell) {
                continue;
            }
            if let Some(v) = Self::get_json(&sh.herald, &format!("/h/conquest/{d}.json")).await {
                events.extend(conquest_events(&v));
                st.events_day_read.insert(d, w.bell);
            }
        }
        let mut r = sh.report.lock().expect("report");
        for row in rows {
            r.cq.campaign(row);
        }
        for ev in events {
            if r.cq.seen.insert(ev.seq) {
                *r.cq.events.entry(ev.kind.clone()).or_default() += 1;
                if ev.kind == "keep_taken" {
                    r.cq.day(ev.bell / BELLS_PER_DAY).keep_captures += 1;
                }
            }
        }
    }

    /// What `agent` (the bot's roster index) does at this epoch: a
    /// persona's action, else the honest behaviours.
    pub fn decide(
        &self,
        es: &EpochState,
        agent: u32,
        q: f64,
        captured_homes: &[u32],
        open: &[Mission],
    ) -> Vec<(CqIntent, Option<Expect>)> {
        let w = &es.world;
        if !w.agents.contains_key(&agent) {
            return vec![];
        }
        if let Some(p) = self.persona_of(agent) {
            return cqpersona::act(p, w, &es.states, &es.board, agent)
                .into_iter()
                .map(|(it, ex)| (it, Some(ex)))
                .collect();
        }
        let mut rng = Rng::fork(
            self.seed,
            0xC9E0_0000 ^ (agent as u64) << 32 | es.bell as u64,
        );
        cqbehave::decide(
            w,
            &es.board,
            &es.plan.dispatches,
            &es.states,
            agent,
            q,
            captured_homes,
            open,
            &mut rng,
        )
        .into_iter()
        .map(|it| (it, None))
        .collect()
    }
}

/// Whether the observation is an MC season (program version 2).
pub fn is_mc(obs: &Observation) -> bool {
    obs.season
        .season
        .as_ref()
        .is_some_and(|s| cqbehave::is_mc_season(s.program_version))
}

/// The mission's report name for a march intent.
fn why_of(it: &CqIntent) -> &'static str {
    it.name()
}

impl Bot {
    /// The conquest layer of one step (called by [`Bot::step`] when the
    /// fleet runs `--conquest`): a new epoch's decisions once per epoch
    /// hour, then the open march orders every wake-up.
    pub(crate) async fn cq_layer<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
    ) -> usize {
        let Some(cq) = &sh.conquest else {
            return 0;
        };
        if !is_mc(obs) || obs.me.holdings.is_empty() {
            return 0;
        }
        let bell = obs.bell();
        if bell >= obs.season.end_bell() {
            return 0;
        }
        // Holdings held and lost (a capture's victim).
        let now_held: BTreeSet<(i16, i16, u8)> = obs
            .me
            .holdings
            .iter()
            .map(|(_, h)| (h.p, h.q, h.site))
            .collect();
        let lost: Vec<(i16, i16, u8)> = self.cq.held.difference(&now_held).copied().collect();
        self.cq.held.extend(now_held);
        let mut sent = 0;
        let e_bell = bell - bell % HOUR_BELLS;
        let wake_ok = obs.now
            >= obs.season.genesis_ts
                + e_bell as i64 * obs.season.bell_secs as i64
                + EPOCH_OFFSET_SECS.min(obs.season.bell_secs as i64 * 2);
        if self.cq.last_epoch != Some(e_bell) && wake_ok {
            if let Some(es) = cq.epoch(sh, bell).await {
                self.cq.last_epoch = Some(es.bell);
                sent += self.cq_decide(sh, obs, cq, &es, &lost).await;
            }
        }
        sent += self.cq_orders(sh, obs).await;
        sent
    }

    async fn cq_decide<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
        cq: &Conquest,
        es: &EpochState,
        lost: &[(i16, i16, u8)],
    ) -> usize {
        let agent = self.spec.index;
        let captured_homes: Vec<u32> = lost
            .iter()
            .map(|&(p, q, s)| {
                frontier_agents::cqobs::hold_id(
                    permutation_rules::frontier::geometry::ProvinceCoord::new(p as i32, q as i32),
                    s,
                )
            })
            .collect();
        let q = self.spec.profile().q;
        let open: Vec<Mission> = self.cq.orders.iter().map(|o| o.mission).collect();
        let intents = cq.decide(es, agent, q, &captured_homes, &open);
        let mut sent = 0;
        for (it, expect) in intents {
            match it {
                CqIntent::March {
                    src,
                    troops,
                    to,
                    tile,
                    arrive_min,
                    retreat,
                    mission,
                    host: planned,
                } => {
                    let Some(&(sp, sq, ss)) = es.ids.holds.get(&src) else {
                        continue;
                    };
                    let order = Order {
                        src: (sp, sq, ss),
                        troops: troops / 1_000,
                        to,
                        tile,
                        arrive_min,
                        retreat: retreat.map(|r| r.min(u16::MAX as u32) as u16),
                        why: why_of(&it),
                        mission,
                        planned,
                        issued: obs.bell(),
                        mustered: None,
                    };
                    cqorder::dedupe(&mut self.cq.orders, order);
                }
                CqIntent::DeclareSiege {
                    src,
                    host,
                    site,
                    nearby,
                } => {
                    sent += self
                        .cq_declare(sh, obs, cq, es, src, host, site, nearby, expect)
                        .await;
                }
                CqIntent::FileOutpost { anchor, ref sites } => {
                    sent += self.cq_outpost(sh, obs, es, anchor, sites, expect).await;
                }
                CqIntent::RetireHost { host } => {
                    sent += self.cq_retire(sh, obs, es, host, expect).await;
                }
            }
        }
        sent
    }

    fn cq_record<H, R, D>(
        &self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
        action: &'static str,
        ok: bool,
        code: Option<String>,
    ) {
        let mut r = sh.report.lock().expect("report");
        r.cq.record(CqOutcome {
            bot: self.spec.index,
            persona: self.cq.persona,
            action,
            ok,
            code,
            bell: obs.bell(),
        });
    }

    /// Sponsored sends cost quota like every other action; a persona that
    /// spams ignores it (the point).
    fn cq_quota_ok(&self, obs: &Observation) -> bool {
        self.cq.persona == Some(CqPersona::SiegeSpammer)
            || self.quota_left(obs) > crate::bot::QUOTA_RESERVE
    }

    #[allow(clippy::too_many_arguments)]
    async fn cq_declare<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
        cq: &Conquest,
        es: &EpochState,
        src: u32,
        host: u32,
        site: (i16, i16, u8),
        nearby: Option<u32>,
        _expect: Option<Expect>,
    ) -> usize {
        let w = &es.world;
        if !self.cq_quota_ok(obs) {
            sh.report.lock().expect("report").cq.skip("quota");
            return 0;
        }
        let (Some(&(sp, sq, ss)), Some(&chain)) = (es.ids.holds.get(&src), es.ids.hosts.get(&host))
        else {
            return 0;
        };
        // The host's roster index in the target's Province. A persona that
        // declares without a host on the hex (`siege_offhex`) names entry 0:
        // the program's refusal (`NotOnHex`) is what it tests.
        let entry = match es
            .provinces
            .get(&(site.0, site.1))
            .and_then(|pd| entry_index(pd, chain))
        {
            Some(e) => e,
            None if self.cq.persona.is_some() => 0,
            None => {
                sh.report.lock().expect("report").cq.skip("host_not_on_hex");
                return 0;
            }
        };
        // The target's owner Citizen (a Free City has none; an owner the
        // fleet does not run cannot be named from the herald's files).
        let tid = frontier_agents::cqobs::hold_id(
            permutation_rules::frontier::geometry::ProvinceCoord::new(site.0 as i32, site.1 as i32),
            site.2,
        );
        let owner = match w.holds.get(&tid) {
            Some(x) if x.free_city() => None,
            Some(x) => match cq.wallet_of(x.owner) {
                Some(a) => Some(a),
                None => {
                    sh.report.lock().expect("report").cq.skip("owner_unknown");
                    return 0;
                }
            },
            None => return 0,
        };
        // Re-checked at send time: the target's record in the latest file.
        if self.cq.persona.is_none() {
            if let Some(why) = stale_target(&sh.herald, site).await {
                sh.report.lock().expect("report").cq.skip(why);
                return 0;
            }
        }
        let a = Addresses::new(obs.season.program, obs.season.season_id);
        let near = nearby.and_then(|n| es.ids.holds.get(&n).copied());
        let src_ref = HoldingRef {
            p: sp,
            q: sq,
            site: ss,
        };
        let r = self
            .sponsored(sh, "declare_siege", None, |p| {
                cqtx::declare_siege(&a, p, src_ref, site, entry, owner.as_ref(), near)
            })
            .await;
        self.cq_record(sh, obs, "declare_siege", r.ok(), r.code());
        if r.ok() {
            let day = obs.bell() / BELLS_PER_DAY;
            sh.report.lock().expect("report").cq.day(day).declares += 1;
        }
        1
    }

    async fn cq_outpost<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
        es: &EpochState,
        anchor: u32,
        sites: &[(i16, i16, u8)],
        _expect: Option<Expect>,
    ) -> usize {
        if !self.cq_quota_ok(obs) {
            sh.report.lock().expect("report").cq.skip("quota");
            return 0;
        }
        let Some(&(ap, aq, asite)) = es.ids.holds.get(&anchor) else {
            return 0;
        };
        let Some((_, h)) = obs
            .me
            .holdings
            .iter()
            .find(|(_, h)| (h.p, h.q, h.site) == (ap, aq, asite))
        else {
            return 0;
        };
        let gen = h.gen;
        let a = Addresses::new(obs.season.program, obs.season.season_id);
        let hr = HoldingRef {
            p: ap,
            q: aq,
            site: asite,
        };
        let sites = sites.to_vec();
        let mut built = true;
        let r = self
            .sponsored(sh, "file_outpost", None, |p| {
                cqtx::file_outpost(&a, p, &sites, hr, gen).unwrap_or_else(|| {
                    built = false;
                    fclient::Instruction {
                        program_id: a.program,
                        accounts: vec![],
                        data: vec![],
                    }
                })
            })
            .await;
        if !built {
            return 0;
        }
        self.cq_record(sh, obs, "file_outpost", r.ok(), r.code());
        1
    }

    async fn cq_retire<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
        es: &EpochState,
        host: u32,
        _expect: Option<Expect>,
    ) -> usize {
        if !self.cq_quota_ok(obs) {
            sh.report.lock().expect("report").cq.skip("quota");
            return 0;
        }
        let (Some(&chain), Some(x)) = (es.ids.hosts.get(&host), es.world.hosts.get(&host)) else {
            return 0;
        };
        if self.cq.retired.contains(&chain) {
            return 0;
        }
        let pc = es.world.prov(x.prov).coord;
        let pq = (pc.p as i16, pc.q as i16);
        let Some(entry) = es.provinces.get(&pq).and_then(|pd| entry_index(pd, chain)) else {
            return 0;
        };
        // The captured holding is the host's home site; `home` is one of
        // the retiring wallet's own holdings (the host's return).
        let Some(hk) = frontier_abi::addr::split_host_id(chain) else {
            return 0;
        };
        let captured = HoldingRef {
            p: hk.province.p as i16,
            q: hk.province.q as i16,
            site: hk.site,
        };
        let Some((_, own)) = obs.me.holdings.first() else {
            return 0;
        };
        let home = HoldingRef {
            p: own.p,
            q: own.q,
            site: own.site,
        };
        let a = Addresses::new(obs.season.program, obs.season.season_id);
        let r = self
            .sponsored(sh, "retire_host", None, |p| {
                cqtx::retire_host(&a, p, pq, entry, captured, home)
            })
            .await;
        if r.ok() {
            self.cq.retired.insert(chain);
        }
        self.cq_record(sh, obs, "retire_host", r.ok(), r.code());
        1
    }

    /// Open march orders: Muster, then the sealed Depart (§8.6 Take the
    /// keep, Besiege, Defend, Occupy, Liberate, Capture). A conquest march
    /// is told to the fleet so the next epoch's planner sees its mission.
    async fn cq_orders<H: HeraldPort, R: RelayPort, D: DirectPort>(
        &mut self,
        sh: &Shared<H, R, D>,
        obs: &Observation,
    ) -> usize {
        let mut sent = 0;
        let orders = std::mem::take(&mut self.cq.orders);
        let mut keep = vec![];
        for mut o in orders {
            let taken: BTreeSet<u64> = self
                .mem
                .marches
                .iter()
                .filter(|m| !m.settled)
                .map(|m| m.key.0)
                .collect();
            let st = cqorder::step(
                obs,
                &self.spec,
                sh.cfg.seed,
                sh.cfg.reveal_loaded_limit(),
                &o,
                &|id| taken.contains(&id),
            );
            match st {
                Step::Drop(why) => {
                    sh.report.lock().expect("report").cq.skip(match why {
                        "stale" => "order_stale",
                        "no_holding" => "order_no_holding",
                        _ => "order_no_path",
                    });
                }
                Step::Wait => keep.push(o),
                Step::Muster(it) => {
                    let mut v = vec![it];
                    frontier_agents::policy::residency_gate(obs, &mut v);
                    let muster = matches!(v.first(), Some(Intent::Muster { .. }));
                    for i in v {
                        sent += self.act(sh, obs, i).await;
                    }
                    if muster {
                        o.mustered = Some(obs.bell());
                    }
                    keep.push(o);
                }
                Step::Depart(plan) => {
                    let host_at = plan.host_at;
                    let mut v = vec![Intent::Depart(plan.clone())];
                    frontier_agents::policy::residency_gate(obs, &mut v);
                    if !matches!(v.first(), Some(Intent::Depart(_))) {
                        for i in v {
                            sent += self.act(sh, obs, i).await;
                        }
                        keep.push(o);
                        continue;
                    }
                    let (arrive, host_id) = (plan.plain.arrive_bell, plan.host_id);
                    let (dest, tile) = (plan.dest(), plan.plain.dest_tile);
                    // The unit and troops the host carries, from the roster.
                    let (unit, troops) = obs
                        .me
                        .holdings
                        .iter()
                        .flat_map(|(_, h)| frontier_agents::policy::own_hosts(obs, h))
                        .find(|(_, e)| e.id == host_id)
                        .map_or((0, 0), |(_, e)| (e.unit, e.troops));
                    sent += self.act(sh, obs, Intent::Depart(plan)).await;
                    let went = self
                        .mem
                        .marches
                        .iter()
                        .any(|m| m.key.0 == host_id && m.sent && !m.settled);
                    if went {
                        let day = obs.bell() / BELLS_PER_DAY;
                        {
                            let mut r = sh.report.lock().expect("report");
                            if o.why == "keep_march" {
                                r.cq.day(day).keep_marches += 1;
                            }
                        }
                        if let Some(c) = &sh.conquest {
                            c.note_march(
                                FleetMarch {
                                    host_id,
                                    dest: (dest.0 as i16, dest.1 as i16),
                                    tile,
                                    arrive,
                                    troops,
                                    unit,
                                    mission: o.mission,
                                },
                                o.planned,
                            )
                            .await;
                        }
                    } else {
                        keep.push(o);
                    }
                    let _ = host_at;
                }
            }
        }
        self.cq.orders = keep;
        sent
    }
}

/// Whether the latest file shows the target no longer besiegeable (a
/// record that is not free, or a site that is not a holding or Free City):
/// `Some(why)`. `None` when it still is, or the file is not there.
async fn stale_target<H: HeraldPort>(h: &H, site: (i16, i16, u8)) -> Option<&'static str> {
    let v = Conquest::get_json(h, &format!("/h/province/{},{}/latest", site.0, site.1)).await?;
    let pd = b64(v.get("bytes")?.as_str()?).ok()?;
    if pd.len() != P2::SIZE {
        return None;
    }
    let st = pd[P2::site(site.2 as usize) + S2::STATE];
    if st != S2::STATE_HOLDING && st != S2::STATE_FREE_CITY {
        return Some("stale_not_holding");
    }
    let rec = frontier_abi::conquest_model::Record::read(&pd, site.2 as usize).ok()?;
    (rec.kind != CR::KIND_NONE).then_some("stale_record")
}
