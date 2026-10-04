//! Following the Call (contract §6.6; unit AC3b): rule bots with
//! `--follow-council` and the AI citizens' autopilot (user-facing: the
//! Strike Order; "Call" in code, §0.4).
//!
//! At a bell `b ∈ [follow_from, S − 1]` a bot of the nation reads the sealed
//! Call (a signed member read, `GET /f/ai/council/call`, once per Call and
//! bot, cached) and, if one of its hosts is on `invited`, fetches the path
//! provinces beyond its observation (`fetch.rs`), plans with
//! `policy::plan_march` to the Call's target with `extra = S − earliest − 1`
//! (so the arrival bell is exactly S), requires `!shield_refuses`, and sends
//! that Depart. **A bot follows a Call at most once.** There is no lottery.
//!
//! - **AI citizens** follow inside their per-bell step (`prepare` before the
//!   step's candidates, `intents` for the autopilot A', `offer` for the
//!   flagged candidate, §4.3). The autopilot's Call march is `by: autopilot,
//!   via: strike_order` and never counts as a model march (G12); it is
//!   dropped for a reserved host or a declined period (§3.6). When the model
//!   chooses the flagged candidate the march is `by: model`.
//! - The presenter's **seat** never follows (it is a human seat, §9.2).
//! - **Script bots** step by their archetype's pacing, so almost none would
//!   step inside the six-bell window: with `--follow-council`, [`follow_wake`]
//!   gives every bot a **follow-only micro-step** once in each bell
//!   (90-150 game seconds in): the cached council state of the nation (one
//!   public GET per nation and bell for the whole process), one signed member
//!   read per Call, and, only for a bot with an invited host, an observation,
//!   the path fetch and the Depart. Nothing else is run. Counters in
//!   `ai-brain.json` say how many script bots and AIs actually stepped in a
//!   window (`follow_window_*`); no present-host count is credited to a bot
//!   that did not.
//!
//! The Call's public state is `GET /f/ai/council?faction=` (no secrets); the
//! member read is the only place the sealed target is read. The sealed
//! target is never written to a log line or a request to the mind other than
//! as a planned target of the bell (the mind adds it to its sealed set, §4.1).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Duration;

use fclient::decode::Holding;
use fclient::Signer;
use frontier_agents::obs::{MeView, Observation, ProvinceView, SeasonView};
use frontier_agents::policy::{self, DepartPlan, Intent, Route, SealKind, Target};
use frontier_agents::rng::Rng;
use serde_json::{json, Value};

use super::aisign;
use super::brain::{self, HostRow, Inputs, MarchKind, Offer};
use super::fetch::{self, PathCache};
use super::mindport::{id_of, Answer};
use super::raid::visible_troops;
use super::ready;
use super::recall::{self, ThreatFeed};
use super::AiHook;
use crate::bot::{Bot, Shared};
use crate::ports::{DirectPort, HeraldPort, RelayPort};

/// The social service as the brain reaches it (`serve.mjs` forwards `/f/ai/*`
/// to the social API, §8.2). Loopback only.
pub const DEFAULT_SOCIAL: &str = "127.0.0.1:41902";
/// A read of the council or of a member's Call.
pub const READ_TIMEOUT: Duration = Duration::from_secs(3);
/// Seconds into a bell (game time) before a micro-step runs: the province
/// has usually resolved bell − 2 by then (§3.1).
pub const MICRO_OFFSET: i64 = 90;
/// A bot gives up reading a Call that keeps failing after this many bells.
pub const MAX_READ_TRIES: u8 = 6;

// ------------------------------------------------------------------ the social port

/// Loopback HTTP to the social service (no auth: the service checks the
/// signatures).
#[derive(Clone, Debug)]
pub struct SocialPort {
    addr: String,
}

impl SocialPort {
    /// `host:port` with a loopback host.
    pub fn new(addr: &str) -> Result<SocialPort, String> {
        let (host, port) = addr.rsplit_once(':').ok_or("social: host:port")?;
        if !matches!(host, "127.0.0.1" | "localhost") || port.parse::<u16>().is_err() {
            return Err("social: a loopback host:port".into());
        }
        Ok(SocialPort { addr: addr.into() })
    }

    pub fn addr(&self) -> &str {
        &self.addr
    }

    /// `GET path` → (status, JSON body or null).
    pub async fn get(&self, path: &str, timeout: Duration) -> Result<(u16, Value), String> {
        let url = format!("http://{}{path}", self.addr);
        let r = tokio::time::timeout(timeout, fclient::http::get(&url))
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(|e| e.to_string())?;
        Ok((
            r.status,
            serde_json::from_slice(&r.body).unwrap_or(Value::Null),
        ))
    }

    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(u16, Value), String> {
        let url = format!("http://{}{path}", self.addr);
        let r = tokio::time::timeout(timeout, fclient::http::post_json(&url, body))
            .await
            .map_err(|_| "timeout".to_string())?
            .map_err(|e| e.to_string())?;
        Ok((
            r.status,
            serde_json::from_slice(&r.body).unwrap_or(Value::Null),
        ))
    }
}

// ------------------------------------------------------------------ the Call

/// What `GET /f/ai/council?faction=` says about an **adopted, sealed** Call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CouncilPub {
    pub period: u32,
    pub follow_from: u32,
    pub strike_bell: u32,
}

/// The public council file of a nation: `Some` only for an adopted Call
/// whose sealed target the watcher has fixed.
pub fn council_from(v: &Value) -> Option<CouncilPub> {
    if v.get("adopted")?.as_bool() != Some(true) || v.get("sealed")?.as_bool() != Some(true) {
        return None;
    }
    let n = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .map(|x| x.min(u32::MAX as u64) as u32)
    };
    Some(CouncilPub {
        period: n("period")?,
        follow_from: n("follow_from")?,
        strike_bell: n("strike_bell")?,
    })
}

/// A sealed Call as a member reads it (§8.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallInfo {
    pub faction: u8,
    pub period: u32,
    pub option: u8,
    /// `strike`, `camp` or `raid`.
    pub kind: String,
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    pub strike_bell: u32,
    pub follow_from: u32,
    /// Host ids, in the council's order.
    pub invited: Vec<u64>,
}

impl CallInfo {
    pub fn from_json(v: &Value, faction: u8) -> Option<CallInfo> {
        let n = |k: &str| v.get(k).and_then(Value::as_i64);
        let info = CallInfo {
            faction,
            period: u32::try_from(n("period")?).ok()?,
            option: u8::try_from(n("option")?).ok()?,
            kind: v.get("kind")?.as_str()?.to_string(),
            p: i16::try_from(n("p")?).ok()?,
            q: i16::try_from(n("q")?).ok()?,
            tile: u8::try_from(n("tile")?).ok()?,
            strike_bell: u32::try_from(n("strike_bell")?).ok()?,
            follow_from: u32::try_from(n("follow_from")?).ok()?,
            invited: v
                .get("invited")?
                .as_array()?
                .iter()
                .filter_map(id_of)
                .collect(),
        };
        info.why()?;
        Some(info)
    }

    /// The march target kind (`field` for a strike, `camp`, `war` for a raid).
    pub fn why(&self) -> Option<&'static str> {
        match self.kind.as_str() {
            "strike" => Some("field"),
            "camp" => Some("camp"),
            "raid" => Some("war"),
            _ => None,
        }
    }

    pub fn target(&self) -> Option<Target> {
        Some(Target {
            p: self.p,
            q: self.q,
            tile: self.tile,
            why: self.why()?,
        })
    }

    /// `follow_from <= bell < S`.
    pub fn live_at(&self, bell: u32) -> bool {
        self.follow_from <= bell && bell < self.strike_bell
    }

    pub fn what(&self) -> &'static str {
        match self.kind.as_str() {
            "strike" => "another nation's army in the open field",
            "camp" => "a barbarian camp",
            _ => "another nation's village",
        }
    }
}

/// What a bot knows of one Call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallState {
    /// Read: the bot is a member and holds the Call.
    Member(CallInfo),
    /// Nothing more to do this period (not a member, not invited, no
    /// session, too many failed reads); the reason is for the report.
    Done(String),
}

/// The far provinces fetched for one Call at one bell.
#[derive(Clone, Debug)]
pub struct FarCache {
    pub period: u32,
    pub bell: u32,
    pub provinces: BTreeMap<(i16, i16), ProvinceView>,
}

/// Seed and `L(reveal)` for planning without a `Shared` (the sync seams).
#[derive(Clone, Copy, Debug)]
pub struct Env {
    pub seed: u64,
    pub reveal_loaded_limit: u32,
}

/// Per-bot follow state (a field of `BotAi`).
#[derive(Clone, Debug, Default)]
pub struct BotFollow {
    pub calls: BTreeMap<u32, CallState>,
    /// Periods this bot sent its Call march in (at most once each).
    pub followed: BTreeSet<u32>,
    pub far: Option<FarCache>,
    /// Periods whose window this bot stepped in (counted once).
    pub window_counted: BTreeSet<u32>,
    pub read_tries: BTreeMap<u32, u8>,
    /// The bell of the last micro-step (one per bell).
    pub micro_bell: Option<u32>,
    /// Game time of the next follow check (read by `next_wake`).
    pub next_check: Option<i64>,
    /// Decisions whose social items were posted already.
    pub posted: BTreeSet<String>,
    pub env: Option<Env>,
}

impl BotFollow {
    /// The Call this bot holds whose window is open at `bell`.
    pub fn live(&self, bell: u32) -> Option<&CallInfo> {
        self.calls.values().find_map(|c| match c {
            CallState::Member(i) if i.live_at(bell) => Some(i),
            _ => None,
        })
    }
}

/// Process-wide follow state (a field of `AiHook`).
pub struct FollowShared {
    pub social: SocialPort,
    /// faction → (bell read, its adopted sealed Call).
    councils: Mutex<BTreeMap<u8, (u32, Option<CouncilPub>)>>,
    pub paths: PathCache,
    pub threats: ThreatFeed,
}

impl Default for FollowShared {
    fn default() -> Self {
        FollowShared {
            social: SocialPort::new(DEFAULT_SOCIAL).expect("default social address"),
            councils: Mutex::new(BTreeMap::new()),
            paths: PathCache::new(),
            threats: ThreatFeed::new(),
        }
    }
}

impl AiHook {
    /// The nation's adopted, sealed Call as the public council file shows
    /// it, read at most once per bell for the whole process.
    pub async fn council_pub(&self, faction: u8, bell: u32) -> Option<CouncilPub> {
        if let Some((b, v)) = self.follow.councils.lock().expect("councils").get(&faction) {
            if *b == bell {
                return v.clone();
            }
        }
        let r = self
            .follow
            .social
            .get(&format!("/f/ai/council?faction={faction}"), READ_TIMEOUT)
            .await;
        let v = match r {
            Ok((200, j)) => council_from(&j),
            Ok(_) => None,
            Err(_) => {
                self.stat("follow_social_down");
                None
            }
        };
        self.follow
            .councils
            .lock()
            .expect("councils")
            .insert(faction, (bell, v.clone()));
        v
    }
}

// ------------------------------------------------------------------ the member read

enum ReadErr {
    /// Never again for this period (the refusal code).
    Done(String),
    /// Try again at a later bell.
    Retry(String),
}

/// A signed member read of the sealed Call (§6.1 call read, §8.2).
async fn read_call(
    hook: &AiHook,
    bot: &Bot,
    season_id: u64,
    faction: u8,
    period: u32,
    unix: i64,
) -> Result<CallInfo, ReadErr> {
    let wallet = bot.wallet.pubkey().to_bytes();
    let (r, signed) = aisign::sign_callread(season_id, faction, period, unix, wallet, &bot.session)
        .map_err(|e| ReadErr::Done(e.code.to_string()))?;
    let path = format!("/f/ai/council/call?{}", aisign::callread_query(&r, &signed));
    hook.stat("follow_calls_read");
    match hook.follow.social.get(&path, READ_TIMEOUT).await {
        Ok((200, j)) => CallInfo::from_json(&j, faction)
            .filter(|i| i.period == period)
            .ok_or_else(|| ReadErr::Done("BadCall".into())),
        Ok((status, j)) => {
            let code = j
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("Refused")
                .to_string();
            if status >= 500 || matches!(code.as_str(), "WindowClosed" | "RateLimited") {
                Err(ReadErr::Retry(code))
            } else {
                Err(ReadErr::Done(code))
            }
        }
        Err(e) => Err(ReadErr::Retry(e)),
    }
}

/// The bot's Call for `c.period`: stored, or read now (once per Call; a
/// transient failure is retried at later bells, [`MAX_READ_TRIES`] times).
async fn ensure_call(
    hook: &AiHook,
    bot: &mut Bot,
    season_id: u64,
    faction: u8,
    c: &CouncilPub,
    now: i64,
) -> Option<CallInfo> {
    match bot.ai.follow.calls.get(&c.period) {
        Some(CallState::Member(i)) => return Some(i.clone()),
        Some(CallState::Done(_)) => return None,
        None => {}
    }
    match read_call(hook, bot, season_id, faction, c.period, now).await {
        Ok(info) => {
            bot.ai
                .follow
                .calls
                .insert(c.period, CallState::Member(info.clone()));
            Some(info)
        }
        Err(ReadErr::Done(code)) => {
            hook.stat(&format!("follow_read_refused:{code}"));
            bot.ai.follow.calls.insert(c.period, CallState::Done(code));
            None
        }
        Err(ReadErr::Retry(code)) => {
            hook.stat(&format!("follow_read_retry:{code}"));
            let tries = bot.ai.follow.read_tries.entry(c.period).or_default();
            *tries += 1;
            if *tries >= MAX_READ_TRIES {
                bot.ai
                    .follow
                    .calls
                    .insert(c.period, CallState::Done(format!("gave up ({code})")));
            }
            None
        }
    }
}

// ------------------------------------------------------------------ side inputs of one step

/// A live Call of the bot's nation, as the candidate generator needs it.
#[derive(Clone, Debug)]
pub struct CallCtx {
    pub info: CallInfo,
    /// Path provinces beyond the observation (never merged into it).
    pub far: BTreeMap<(i16, i16), ProvinceView>,
    /// This bot sent its Call march already.
    pub followed: bool,
}

/// What the AC3b offers need beyond the observation (§4.3): the live Call
/// (a flagged candidate, the Strike-Order follow) and the live threats near
/// home (recall). `Side::default()` offers neither.
#[derive(Clone, Debug, Default)]
pub struct Side {
    pub call: Option<CallCtx>,
    pub threats: Vec<recall::Threat>,
}

/// A Call march planned to arrive exactly at the strike bell.
#[derive(Clone, Debug)]
pub struct CallPlan {
    pub plan: DepartPlan,
    pub hexes: usize,
    pub provinces: usize,
    /// The earliest arrival bell without waiting (`extra = 0`).
    pub earliest: u32,
}

/// Plans `row`'s march to the Call's target over `obs` plus the fetched
/// `far` provinces (§6.6): `extra = S − earliest − 1` so that the arrival is
/// S, `!shield_refuses` at S. `Err` says why not.
#[allow(clippy::too_many_arguments)]
pub fn plan_call(
    obs: &Observation,
    h: &Holding,
    row: &HostRow,
    info: &CallInfo,
    far: &BTreeMap<(i16, i16), ProvinceView>,
    stance: u8,
    retreat: u16,
    tip: u64,
) -> Result<CallPlan, &'static str> {
    let t = info.target().ok_or("unknown target kind")?;
    let aug = fetch::augment(obs, far);
    let s = info.strike_bell;
    let (_, first, _) = policy::plan_march(&aug, h, row.at, &row.e, t, 0, stance, retreat)
        .ok_or("no path or no transit slot")?;
    // `plan_march` names `earliest + 1` for `extra = 0`; the Call needs S.
    let earliest = first.arrive_bell;
    if earliest > s {
        return Err("cannot arrive by the strike bell");
    }
    let (path, plain, slot) =
        policy::plan_march(&aug, h, row.at, &row.e, t, s - earliest, stance, retreat)
            .ok_or("no path or no transit slot")?;
    if plain.arrive_bell != s {
        return Err("arrival bell clipped");
    }
    if policy::shield_refuses(&aug, h, &t, plain.arrive_bell) {
        return Err("shield");
    }
    Ok(CallPlan {
        plan: DepartPlan {
            h: brain::href(h),
            host_at: row.at,
            host_id: row.e.id,
            transit_slot: slot,
            plain,
            tip,
            seal: SealKind::Honest,
            route: Route::Relay,
            path_others: path.others((t.p as i32, t.q as i32)),
            why: "call",
        },
        hexes: path.dirs.len(),
        provinces: path.provinces.len(),
        earliest,
    })
}

/// The bot's own ready combat hosts that are on the Call's invited list, in
/// the council's order.
fn invited_ready<'a>(rows: &'a [HostRow], info: &CallInfo) -> Vec<&'a HostRow> {
    info.invited
        .iter()
        .filter_map(|id| {
            rows.iter()
                .find(|r| r.e.id == *id && r.ready && r.e.unit != ready::SCOUT)
        })
        .collect()
}

/// The flagged Strike-Order march candidate (§4.3: right after `hold`,
/// member only, `flags.council`): the largest invited ready combat host that
/// passes the V3(a)-(c) caps and can arrive at S. `params.timing` is
/// `["call"]`; the facts keep the key set of the pinned wire sample
/// (`ai-decide-v1.json` `candidate_samples_ac3b`), the label says what the
/// target is.
pub fn offer(inp: &Inputs, side: &Side) -> Vec<Offer> {
    let Some(ctx) = &side.call else {
        return vec![];
    };
    let obs = inp.obs;
    let bell = obs.bell();
    if ctx.followed || !ctx.info.live_at(bell) {
        return vec![];
    }
    let mut rows = invited_ready(&inp.rows, &ctx.info);
    rows.sort_by_key(|r| (std::cmp::Reverse(r.e.troops), r.e.id));
    for row in rows {
        if brain::caps_violation(row.troops(), 1, inp.home_troops, inp.ds, None).is_some() {
            continue;
        }
        let Ok(cp) = plan_call(
            obs,
            inp.h,
            row,
            &ctx.info,
            &ctx.far,
            brain::default_stance(inp.faction),
            0,
            inp.presets[2],
        ) else {
            continue;
        };
        let Some(t) = ctx.info.target() else {
            continue;
        };
        // What the bot can see at the target (the fetched provinces count).
        let aug = fetch::augment(obs, &ctx.far);
        let (enemy, nation) = visible_troops(&aug, &t, inp.faction);
        let mut o = brain::march_candidate(
            inp,
            row,
            t,
            MarchKind::Call,
            &cp.plan,
            cp.hexes,
            cp.provinces,
            enemy,
            nation,
        );
        o.cand.facts["earliest_bell"] = json!(cp.earliest);
        o.cand.facts["strike_bell"] = json!(ctx.info.strike_bell);
        o.cand.facts["reward"] = json!(if ctx.info.kind == "camp" {
            brain::CAMP_REWARD
        } else {
            brain::FIGHT_REWARD
        });
        o.cand.facts["shield"] = json!(if ctx.info.kind == "raid" {
            "ended"
        } else {
            "not applicable"
        });
        o.cand
            .params
            .insert("timing".to_string(), vec![json!("call")]);
        o.cand.label = format!(
            "Follow the Strike Order with {} ({} troops) to {}, {} hexes away; arrival at the strike bell {}",
            row.handle,
            row.troops(),
            ctx.info.what(),
            cp.hexes,
            ctx.info.strike_bell
        );
        return vec![o];
    }
    vec![]
}

/// The Strike-Order follow march of this bot for this observation (the
/// autopilot's A' and a script bot's micro-step): the first invited ready
/// combat host of any of its villages, planned over the far provinces the
/// last [`prepare`] or micro-step fetched for this bell. Empty when the Call
/// is not live, was followed, or was declined (§3.6), or no plan exists. The
/// caller applies the reserved-host filter (`standing::filter_follow`).
pub fn intents(bot: &Bot, obs: &Observation) -> Vec<Intent> {
    let f = &bot.ai.follow;
    let (Some(env), bell) = (f.env, obs.bell()) else {
        return vec![];
    };
    let Some(info) = f.live(bell) else {
        return vec![];
    };
    if f.followed.contains(&info.period) || bot.ai.standing.call_declined(info.period) {
        return vec![];
    }
    let far = match &f.far {
        Some(x) if x.period == info.period && x.bell == bell => &x.provinces,
        _ => return vec![],
    };
    let presets = obs.season.tip_presets(env.reveal_loaded_limit);
    let q = bot.spec.profile().q;
    let mut rng = Rng::fork(
        env.seed,
        ((bot.spec.index as u64) << 32 | bell as u64) ^ 0xCA11_0DE5,
    );
    for (_, h) in &obs.me.holdings {
        if !policy::final_by_rule(obs, h) {
            continue;
        }
        let rows = brain::host_rows(obs, h);
        for row in invited_ready(&rows, info) {
            let stance = policy::pick_stance(h.faction, q, &mut rng);
            let retreat = policy::pick_retreat(q, &mut rng);
            let tip = if bot.ai.on {
                presets[2]
            } else {
                policy::pick_tip(presets, bot.spec.persona, q, &mut rng)
            };
            if let Ok(cp) = plan_call(obs, h, row, info, far, stance, retreat, tip) {
                return vec![Intent::Depart(Box::new(cp.plan))];
            }
        }
    }
    vec![]
}

/// A march with `why == "call"` landed: the Call is followed (once). Returns
/// the `via` of the marchbook entry.
pub fn note_sent(
    bot: &mut Bot,
    hook: &AiHook,
    why: &str,
    dest: (i16, i16, u8),
    bell: u32,
    script: bool,
) -> Option<&'static str> {
    if why != "call" {
        return None;
    }
    let period = bot.ai.follow.calls.values().find_map(|c| match c {
        CallState::Member(i) if (i.p, i.q, i.tile) == dest && i.live_at(bell) => Some(i.period),
        _ => None,
    });
    if let Some(p) = period {
        bot.ai.follow.followed.insert(p);
    }
    hook.stat(if script {
        "follow_sent_script"
    } else {
        "follow_sent_ai"
    });
    Some("strike_order")
}

// ------------------------------------------------------------------ fetching for a plan

/// Fetches the provinces a plan of `row` to the Call's target needs beyond
/// `obs` (≤ [`fetch::MAX_EXTRA_GETS`] GETs, the hex line first, then the
/// neighbours of the line when the line alone gives no plan) and keeps them
/// for this bell in `bot.ai.follow.far`.
async fn fetch_far<H, R, D>(
    sh: &Shared<H, R, D>,
    hook: &AiHook,
    bot: &mut Bot,
    obs: &Observation,
    h: &Holding,
    row: &HostRow,
    info: &CallInfo,
) -> BTreeMap<(i16, i16), ProvinceView>
where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    let bell = obs.bell();
    let mut far: BTreeMap<(i16, i16), ProvinceView> = BTreeMap::new();
    if let Some(c) = &bot.ai.follow.far {
        if c.period == info.period && c.bell == bell {
            return c.provinces.clone();
        }
    }
    let (Some(t), mut budget) = (info.target(), fetch::MAX_EXTRA_GETS) else {
        return far;
    };
    let from = (row.at, row.e.tile);
    let to = ((t.p, t.q), t.tile);
    for widen in [false, true] {
        match fetch::far_provinces(
            &sh.herald,
            &hook.follow.paths,
            obs,
            from,
            to,
            widen,
            &mut budget,
        )
        .await
        {
            Err(e) => {
                hook.stat(&format!("follow_fetch_{e:?}"));
                break;
            }
            Ok(f) => {
                hook.stat_n("follow_fetch_gets", f.gets as u64);
                far.extend(f.provinces);
            }
        }
        let aug = fetch::augment(obs, &far);
        if policy::plan_march(&aug, h, row.at, &row.e, t, 0, 0, 0).is_some() {
            break;
        }
        if widen {
            hook.stat("follow_fetch_no_path");
        }
    }
    bot.ai.follow.far = Some(FarCache {
        period: info.period,
        bell,
        provinces: far.clone(),
    });
    far
}

fn env_of<H, R, D>(sh: &Shared<H, R, D>) -> Env {
    Env {
        seed: sh.cfg.seed,
        reveal_loaded_limit: sh.cfg.reveal_loaded_limit(),
    }
}

// ------------------------------------------------------------------ the AI step

/// Gathers the side inputs of an AI bot's step (called by `step_ai` after the
/// observation, before the candidates): the live threats near home (recall)
/// and, with `--follow-council`, the live Call of the nation: the signed
/// member read once, the invited check, the path fetch for the first ready
/// invited host.
pub async fn prepare<H, R, D>(sh: &Shared<H, R, D>, bot: &mut Bot, obs: &Observation) -> Side
where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    let mut side = Side::default();
    let Some(hook) = sh.ai.clone() else {
        return side;
    };
    bot.ai.follow.env = Some(env_of(sh));
    let Some(h) = brain::home_holding(obs) else {
        return side;
    };
    // The owners' province files of a few threats: a few GETs of their own,
    // apart from the path fetch's 8 (§4.3).
    let mut budget = recall::MAX_THREATS;
    side.threats = recall::threats_near(
        &hook.follow.threats,
        &sh.herald,
        &hook.follow.paths,
        obs,
        h,
        &mut budget,
    )
    .await;
    if !hook.follow_council {
        return side;
    }
    let bell = obs.bell();
    let Some(c) = hook.council_pub(h.faction, bell).await else {
        return side;
    };
    if bell < c.follow_from || bell >= c.strike_bell {
        return side;
    }
    if bot.ai.follow.window_counted.insert(c.period) {
        hook.stat("follow_window_ai_bots");
    }
    let Some(info) = ensure_call(&hook, bot, obs.season.season_id, h.faction, &c, obs.now).await
    else {
        return side;
    };
    let followed = bot.ai.follow.followed.contains(&info.period);
    let mut far = BTreeMap::new();
    if !followed {
        let rows = brain::host_rows(obs, h);
        match invited_ready(&rows, &info).first() {
            Some(row) => far = fetch_far(sh, &hook, bot, obs, h, row, &info).await,
            None => hook.stat("follow_no_ready_invited_host"),
        }
    }
    side.call = Some(CallCtx {
        info,
        far,
        followed,
    });
    side
}

// ------------------------------------------------------------------ the seams of mod.rs

/// The follow-only micro-step of a script bot (§6.6), called by the
/// `fleet.rs` hook in every loop pass: at most one attempt per bell, 90 s
/// and more into it, only with `--follow-council`, never for an AI bot (it
/// follows in its step).
pub async fn follow_wake<H, R, D>(sh: &Shared<H, R, D>, bot: &mut Bot, now: i64)
where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    let Some(hook) = sh.ai.clone() else {
        return;
    };
    if !hook.follow_council || bot.ai.on {
        return;
    }
    // The presenter's seat never acts by itself: the operator moves it (§9.2).
    if hook.slots.seat().is_some_and(|s| s.index == bot.spec.index) {
        return;
    }
    let Ok(season) = sh.season().await else {
        return;
    };
    let Some(bell) = fclient::clock::bell_at(season.genesis_ts, now) else {
        return;
    };
    if bot.ai.follow.micro_bell == Some(bell) {
        return;
    }
    let due = season.genesis_ts + bell as i64 * 600 + MICRO_OFFSET + (bot.spec.index % 60) as i64;
    if now < due {
        bot.ai.follow.next_check = Some(due);
        return;
    }
    bot.ai.follow.micro_bell = Some(bell);
    bot.ai.follow.next_check = None;
    micro(sh, &hook, bot, &season, now, bell).await;
}

/// The next wake of a bot: earlier than `wake` while a follow check is due.
pub fn next_wake(bot: &Bot, now: i64, wake: i64) -> i64 {
    match bot.ai.follow.next_check {
        Some(t) if t > now && t < wake => t,
        _ => wake,
    }
}

async fn micro<H, R, D>(
    sh: &Shared<H, R, D>,
    hook: &AiHook,
    bot: &mut Bot,
    season: &SeasonView,
    now: i64,
    bell: u32,
) where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    let faction = bot.spec.faction;
    let Some(c) = hook.council_pub(faction, bell).await else {
        return;
    };
    if bell < c.follow_from || bell >= c.strike_bell {
        return;
    }
    // The window is open: this bot steps in it (counted once per Call).
    if bot.ai.follow.window_counted.insert(c.period) {
        hook.stat("follow_window_script_bots");
    }
    // Followed, refused or not invited: nothing more to do for this Call.
    if bot.ai.follow.followed.contains(&c.period)
        || matches!(bot.ai.follow.calls.get(&c.period), Some(CallState::Done(_)))
    {
        bot.ai.follow.next_check = None;
        return;
    }
    // Wake again in the next bell while the window lasts.
    let next_bell_due =
        season.genesis_ts + (bell as i64 + 1) * 600 + MICRO_OFFSET + (bot.spec.index % 60) as i64;
    if bell + 1 < c.strike_bell {
        bot.ai.follow.next_check = Some(next_bell_due);
    }
    let Some(info) = ensure_call(hook, bot, season.season_id, faction, &c, now).await else {
        return;
    };
    // Invited? One cheap read of /h/me before any observation.
    let wallet = bot.wallet.pubkey();
    let me = match sh.herald.get(&format!("/h/me/{wallet}")).await {
        Ok(Some(b)) => serde_json::from_slice::<Value>(&b)
            .ok()
            .and_then(|j| MeView::from_json(&j).ok()),
        _ => None,
    };
    let Some(me) = me else {
        return;
    };
    let mine = info
        .invited
        .iter()
        .any(|id| me.holdings.iter().any(|(_, h)| policy::host_of(h, *id)));
    if !mine {
        hook.stat("follow_not_invited");
        bot.ai
            .follow
            .calls
            .insert(c.period, CallState::Done("not invited".into()));
        bot.ai.follow.next_check = None;
        return;
    }
    let Ok(obs) = bot.observe(sh).await else {
        return;
    };
    bot.ai.follow.env = Some(env_of(sh));
    // The ready invited host and its holding.
    let mut target = None;
    for (_, h) in &obs.me.holdings {
        if !policy::final_by_rule(&obs, h) {
            continue;
        }
        let rows = brain::host_rows(&obs, h);
        if let Some(row) = invited_ready(&rows, &info).first() {
            target = Some((h.clone(), (*row).clone()));
            break;
        }
    }
    let Some((h, row)) = target else {
        hook.stat("follow_no_ready_invited_host");
        return;
    };
    fetch_far(sh, hook, bot, &obs, &h, &row, &info).await;
    let mut v = intents(bot, &obs);
    if v.is_empty() {
        hook.stat("follow_no_plan");
        return;
    }
    policy::residency_gate(&obs, &mut v);
    for it in v {
        let depart = match &it {
            Intent::Depart(p) => Some((
                p.host_id,
                p.plain.dest_p,
                p.plain.dest_q,
                p.plain.dest_tile,
                p.why,
            )),
            _ => None,
        };
        if depart.is_some() && bot.ai_quota_left(&obs) == 0 {
            hook.stat("follow_no_quota");
            continue;
        }
        bot.act(sh, &obs, it).await;
        if let Some((host, p, q, tile, why)) = depart {
            if bot.mem.march((host, bell)).is_some_and(|m| m.sent) {
                note_sent(bot, hook, why, (p, q, tile), bell, true);
            }
        }
    }
}

// ------------------------------------------------------------------ posting the mind's social items

/// Signs and posts what the mind's answer carries for the social layer
/// (§8.1 `social`: `say[]`, `motion`, `ballot`): the brain fills `wallet`,
/// encodes with `aisign.rs`, signs with the **session key** and POSTs to
/// `/f/ai/talk` or `/f/ai/ballot` with `decision_id` and `item`. A decision
/// is posted at most once (a same-bell repeat reuses the cached answer).
/// Refusals are counted by code (`social_refused:<code>`), never retried:
/// the service consumes an `(decision_id, item)` pair once.
pub async fn post_social<H, R, D>(sh: &Shared<H, R, D>, bot: &mut Bot, ans: &Answer)
where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    let Some(hook) = sh.ai.clone() else {
        return;
    };
    let mut items: Vec<(&'static str, Value)> = vec![];
    if let Some(a) = ans.social.get("say").and_then(Value::as_array) {
        items.extend(a.iter().map(|x| ("talk", x.clone())));
    }
    for (k, route) in [("motion", "talk"), ("ballot", "ballot")] {
        if let Some(x) = ans.social.get(k).filter(|x| !x.is_null()) {
            items.push((route, x.clone()));
        }
    }
    if items.is_empty() || !bot.ai.follow.posted.insert(ans.decision_id.clone()) {
        return;
    }
    let wallet = bot.wallet.pubkey().to_bytes();
    for (n, (route, it)) in items.into_iter().enumerate() {
        let item = it
            .get("item")
            .and_then(Value::as_u64)
            .map_or(n as u32, |x| x as u32);
        let bytes = if route == "talk" {
            aisign::talk_from_json(&it, wallet).and_then(|t| aisign::encode_talk(&t))
        } else {
            aisign::ballot_from_json(&it, wallet).and_then(|b| aisign::encode_ballot(&b))
        };
        let signed = bytes.and_then(|b| aisign::sign_record(&b, &bot.session));
        let signed = match signed {
            Ok(s) => s,
            Err(e) => {
                hook.stat(&format!("social_unsignable:{}", e.code));
                continue;
            }
        };
        let body = signed.post_body(Some((&ans.decision_id, item)));
        match hook
            .follow
            .social
            .post(&format!("/f/ai/{route}"), &body, READ_TIMEOUT)
            .await
        {
            Ok((200, _)) => hook.stat(&format!("social_posted:{route}")),
            Ok((_, j)) => {
                let code = j.get("code").and_then(Value::as_str).unwrap_or("Refused");
                hook.stat(&format!("social_refused:{code}"));
            }
            Err(_) => hook.stat("social_post_failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_public_council_file_is_a_call_only_when_adopted_and_sealed() {
        let adopted = json!({"period": 5, "adopted": true, "sealed": true,
                             "follow_from": 126, "strike_bell": 132});
        assert_eq!(
            council_from(&adopted),
            Some(CouncilPub {
                period: 5,
                follow_from: 126,
                strike_bell: 132
            })
        );
        assert!(
            council_from(&json!({"period": 5, "adopted": true, "sealed": false,
                                      "follow_from": 126, "strike_bell": 132}))
            .is_none()
        );
        assert!(council_from(&json!({"period": null, "adopted": false})).is_none());
    }

    #[test]
    fn a_member_read_parses_ids_as_strings_or_numbers() {
        let v = json!({"period": 5, "option": 2, "kind": "camp", "p": 4, "q": -1, "tile": 17,
                       "strike_bell": 132, "follow_from": 126,
                       "invited": ["123149597278209", 77], "nonce": "ab"});
        let i = CallInfo::from_json(&v, 3).unwrap();
        assert_eq!(i.invited, vec![123149597278209, 77]);
        assert_eq!(i.why(), Some("camp"));
        assert!(i.live_at(126) && i.live_at(131) && !i.live_at(132) && !i.live_at(125));
        let mut bad = v.clone();
        bad["kind"] = json!("siege");
        assert!(CallInfo::from_json(&bad, 3).is_none());
    }

    #[test]
    fn the_social_port_is_loopback_only() {
        assert!(SocialPort::new("127.0.0.1:41902").is_ok());
        assert!(SocialPort::new("localhost:8080").is_ok());
        assert!(SocialPort::new("example.com:80").is_err());
        assert!(SocialPort::new("10.0.0.1:41902").is_err());
        assert!(SocialPort::new("127.0.0.1").is_err());
    }
}
