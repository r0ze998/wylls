//! The AI citizens' brain hook (AI-CITIZENS-CONTRACT v1.2, unit AC3a).
//!
//! `frontier-bots --brain URL --ai-slots FILE` runs the slots with
//! `kind:"ai"` as AI citizens: each bot observes as today, sends its duties
//! at once, turns its economy and military choices into at most 12
//! code-made candidates and asks the keyless mind (`frontier-citizens`,
//! Node) which to take. Anything late, invalid or refused runs the rule
//! autopilot, **filtered**: economy and duties stay, and a voluntary march
//! is never started (so every voluntary AI march is a model choice or a
//! council Strike Order, §3.6). Rule bots and the seat behave byte for byte
//! as before.
//!
//! | module | what |
//! |---|---|
//! | [`brain`] | candidates (§4.3), the autopilot filter (§3.6), the quota floor, V6 (§4.5), the step (§3.1) |
//! | [`mindport`] | wire types and the loopback HTTP client of `/v1/decide`, `/v1/outcome` (§4.1, §8.1) |
//! | [`standing`] | standing orders (§3.6) |
//! | [`ready`] | private copy of `ready_host`/`can_depart` (§4.3) |
//! | [`meview`] | own hosts, transits and seals from `/h/me` (§1.3 C2) |
//! | [`aislots`] | `ai-slots.json`, the AI roster, `--export-seat-key` (§2.3) |
//! | [`aisign`] | the signed social record bytes, the Rust mirror of `aisocial.mjs` (§6.1) |
//! | [`fetch`] | the path fetch for a target beyond the observation (§4.3, §6.6) |
//! | [`follow`] | following the Call, the flagged Strike-Order candidate, the social posts (§6.6, §4.3) |
//! | [`raid`], [`recall`] | the `raid` and `recall:<handle>` candidates (§4.3) |
//!
//! The follow seams ([`follow_intents`], [`follow_wake`], [`follow_next_wake`])
//! are the entry points `brain.rs` and the `fleet.rs` hook call; their
//! bodies are in `follow.rs` (AC3b).
//!
//! Nothing here claims the model "wants" or "intends" anything: the brain
//! offers code-made candidates and executes what a validated answer chose.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use frontier_agents::obs::Observation;
use frontier_agents::policy::Intent;
use serde_json::{json, Value};

use crate::bot::{Bot, Shared};
use crate::fleet::Fleet;
use crate::ports::{DirectPort, HeraldPort, RelayPort};
use crate::report::Outcome;

pub mod aisign;
pub mod aislots;
pub mod brain;
pub mod fetch;
pub mod follow;
pub mod meview;
pub mod mindport;
pub mod raid;
pub mod ready;
pub mod recall;
pub mod standing;

use aislots::AiSlots;
use mindport::{ActionOutcome, MindPort};
use standing::Standing;

/// Who chose a march (the record's `by`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    Model,
    Autopilot,
}

/// One own march the brain sent, with the destination it keeps private
/// until the arrival bell has ended (§4.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookMarch {
    pub host_id: u64,
    pub troops_at_depart: u32,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub dest: (i16, i16, u8),
    pub by: By,
    /// `strike_order` for a Strike-Order follow.
    pub via: Option<&'static str>,
}

/// The caps of §4.5 V3 for one game day: `h0` = `home_troops` at the first
/// step of the day, and the model-chosen marches sent today (bell, troops).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DayState {
    pub day: u32,
    pub h0: u32,
    pub marches: Vec<(u32, u32)>,
}

impl DayState {
    /// A day state whose first step saw `h0` home troops and no march yet.
    pub fn fresh(day: u32, h0: u32) -> DayState {
        DayState {
            day,
            h0,
            marches: vec![],
        }
    }

    pub fn troops_today(&self) -> u32 {
        self.marches.iter().map(|m| m.1).sum()
    }
}

/// A decision the mind already answered for a bell (idempotent per
/// `(index, bell)`, §3.1) and what of it has been sent.
#[derive(Clone, Debug)]
pub struct Cached {
    pub bell: u32,
    pub answer: mindport::Answer,
    /// The offers of the request the answer belongs to. Candidate ids are positional (`c1..cN`) and can shift between
    /// two observations of one bell, so a same-bell repeat resolves the cached ids against THESE offers, never against
    /// offers recomputed from the newer observation (V6 then checks the chosen action on the fresh one).
    pub offers: Vec<brain::Offer>,
    /// Identities of candidate actions and autopilot intents sent OK this bell.
    pub done: BTreeSet<String>,
}

/// Per-bot brain state (a field of `Bot`, set by the `// AI hook` block).
#[derive(Clone, Debug, Default)]
pub struct BotAi {
    /// This bot is an AI citizen (slot `kind:"ai"`): the brain runs.
    pub on: bool,
    pub standing: Standing,
    pub cache: Option<Cached>,
    pub book: Vec<BookMarch>,
    pub day: Option<DayState>,
    /// Hosts that were ready at the previous step (W-READY detection).
    pub prev_ready: BTreeSet<u64>,
    /// Following the Call (AC3b, `follow.rs`).
    pub follow: follow::BotFollow,
}

/// Per-AI milestones for the run report (AC3a step 0 (d), contract §9.5 (c)):
/// the bell of the AI's first step with a final village, and the bells at
/// which its first and its second distinct combat host were departable.
#[derive(Clone, Debug, Default)]
pub struct Timeline {
    pub first_final_bell: Option<u32>,
    pub first_ready_bell: Option<u32>,
    pub second_ready_bell: Option<u32>,
    pub first_model_march_bell: Option<u32>,
    pub ready_hosts: BTreeSet<u64>,
}

/// Process-wide brain state (a field of `Shared`).
pub struct AiHook {
    pub mind: Option<MindPort>,
    pub slots: AiSlots,
    pub follow_council: bool,
    /// Process-wide follow state: the social service address, the council
    /// cache, the path fetch cache, the threat feed (AC3b).
    pub follow: follow::FollowShared,
    /// Wall budget of a mind call on a fixed clock (unit tests): a game
    /// clock derives the budget from the bell's deadline (§3.5).
    pub fixed_call_budget: Duration,
    stats: Mutex<BTreeMap<String, u64>>,
    outcomes: Mutex<BTreeMap<u32, Vec<ActionOutcome>>>,
    timeline: Mutex<BTreeMap<u32, Timeline>>,
}

impl AiHook {
    pub fn new(slots: AiSlots, mind: Option<MindPort>, follow_council: bool) -> AiHook {
        AiHook {
            mind,
            slots,
            follow_council,
            follow: follow::FollowShared::default(),
            fixed_call_budget: Duration::from_secs(5),
            stats: Mutex::new(BTreeMap::new()),
            outcomes: Mutex::new(BTreeMap::new()),
            timeline: Mutex::new(BTreeMap::new()),
        }
    }

    /// Records a step with a final village: its bell and the combat hosts
    /// that can depart now.
    pub fn note_step(&self, index: u32, bell: u32, ready_hosts: &[u64]) {
        let mut t = self.timeline.lock().expect("timeline");
        let e = t.entry(index).or_default();
        e.first_final_bell.get_or_insert(bell);
        for h in ready_hosts {
            if e.ready_hosts.insert(*h) {
                match e.ready_hosts.len() {
                    1 => e.first_ready_bell = Some(bell),
                    2 => e.second_ready_bell = Some(bell),
                    _ => {}
                }
            }
        }
    }

    pub fn note_model_march(&self, index: u32, bell: u32) {
        let mut t = self.timeline.lock().expect("timeline");
        t.entry(index)
            .or_default()
            .first_model_march_bell
            .get_or_insert(bell);
    }

    pub fn timeline_of(&self, index: u32) -> Option<Timeline> {
        self.timeline.lock().expect("timeline").get(&index).cloned()
    }

    pub fn stat(&self, key: &str) {
        self.stat_n(key, 1);
    }

    pub fn stat_n(&self, key: &str, n: u64) {
        *self
            .stats
            .lock()
            .expect("stats")
            .entry(key.to_string())
            .or_default() += n;
    }

    pub fn stat_of(&self, key: &str) -> u64 {
        self.stats
            .lock()
            .expect("stats")
            .get(key)
            .copied()
            .unwrap_or(0)
    }

    /// Counters for the run report (written beside the bots report by the
    /// `main.rs` hook): steps, answers by mode, fallbacks by reason,
    /// re-observes, V6 drops by reason, quota-floor skips and starved bells.
    pub fn stats_json(&self) -> Value {
        let s = self.stats.lock().expect("stats");
        json!({
            "v": 1,
            "ai_bots": self.slots.ai_count(),
            "mind": self.mind.is_some(),
            "follow_council": self.follow_council,
            "counters": s.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
            "timeline": self.timeline.lock().expect("timeline").iter().map(|(i, t)| (i.to_string(), json!({
                "first_final_bell": t.first_final_bell,
                "first_ready_bell": t.first_ready_bell,
                "second_ready_bell": t.second_ready_bell,
                "first_model_march_bell": t.first_model_march_bell,
            }))).collect::<serde_json::Map<_, _>>(),
        })
    }

    /// The outcome sink (`Shared::outcome_sink`): every action a bot sends
    /// is kept for the step's `POST /v1/outcome`.
    pub fn push_outcome(&self, o: &Outcome) {
        if !self.slots.is_ai(o.bot) {
            return;
        }
        self.outcomes
            .lock()
            .expect("outcomes")
            .entry(o.bot)
            .or_default()
            .push(ActionOutcome {
                intent: o.action.to_string(),
                sig: o.signature.clone(),
                ok: o.ok,
                code: o.code.clone(),
            });
    }

    pub fn outcomes_len(&self, index: u32) -> usize {
        self.outcomes
            .lock()
            .expect("outcomes")
            .get(&index)
            .map_or(0, Vec::len)
    }

    pub fn outcomes_since(&self, index: u32, from: usize) -> Vec<ActionOutcome> {
        self.outcomes
            .lock()
            .expect("outcomes")
            .get(&index)
            .map(|v| v[from.min(v.len())..].to_vec())
            .unwrap_or_default()
    }

    pub fn take_outcomes(&self, index: u32) -> Vec<ActionOutcome> {
        self.outcomes
            .lock()
            .expect("outcomes")
            .remove(&index)
            .unwrap_or_default()
    }
}

/// What `Shared::outcome_sink` holds.
pub type OutcomeSink = std::sync::Arc<dyn Fn(&Outcome) + Send + Sync>;

/// Installs the hook into a `Shared` (sets `ai` and the outcome sink).
pub fn install<H, R, D>(mut sh: Shared<H, R, D>, hook: AiHook) -> Shared<H, R, D> {
    let hook = std::sync::Arc::new(hook);
    let sink = hook.clone();
    sh.outcome_sink = Some(std::sync::Arc::new(move |o: &Outcome| sink.push_outcome(o)));
    sh.ai = Some(hook);
    sh
}

/// Marks the AI bots of a fleet (slot `kind:"ai"`); the seat and every
/// script bot stay rule bots.
pub fn mark_bots<H, R, D>(fleet: &mut Fleet<H, R, D>)
where
    H: HeraldPort + 'static,
    R: RelayPort + 'static,
    D: DirectPort + 'static,
{
    if let Some(h) = fleet.shared.ai.clone() {
        for b in &mut fleet.bots {
            b.ai.on = h.slots.is_ai(b.spec.index);
        }
    }
}

/// The Strike-Order follow intents of this bot at this step (§6.6;
/// `via: strike_order`): `follow::intents` (AC3b). Called by `step_ai` for the
/// autopilot's A'.
pub fn follow_intents(bot: &Bot, obs: &Observation) -> Vec<Intent> {
    follow::intents(bot, obs)
}

/// The follow-only micro-step of a script bot in every bell of a live Call's
/// window (§6.6): `follow::follow_wake` (AC3b). Called by the `fleet.rs` hook
/// for every bot at every pass of its loop; it does nothing for an AI bot or
/// without `--follow-council`.
pub async fn follow_wake<H, R, D>(sh: &Shared<H, R, D>, bot: &mut Bot, now: i64)
where
    H: HeraldPort,
    R: RelayPort,
    D: DirectPort,
{
    follow::follow_wake(sh, bot, now).await
}

/// The next wake of a bot, earlier than `wake` while a follow check is due
/// (§6.6): `follow::next_wake` (AC3b).
pub fn follow_next_wake(bot: &Bot, now: i64, wake: i64) -> i64 {
    follow::next_wake(bot, now, wake)
}

/// The command-line options of the AI hook (`--brain`, `--brain-token-file`,
/// `--ai-slots`, `--follow-council`, `--export-seat-key`, contract §8.4).
/// Without them the binary behaves as before.
#[derive(Clone, Debug, Default)]
pub struct AiOpts {
    pub brain: Option<String>,
    pub token_file: Option<PathBuf>,
    pub slots: Option<PathBuf>,
    pub follow_council: bool,
    pub export_seat_key: Option<PathBuf>,
}

/// The mind API lives in the AI's port window (§1.1): 41901–41999, never 41900.
pub fn mind_port_allowed(addr: &str) -> bool {
    addr.rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .is_some_and(|p| (41901..=41999).contains(&p))
}

impl AiOpts {
    /// Argument checks (usage errors).
    pub fn check(&self) -> Result<(), String> {
        if let Some(u) = &self.brain {
            let addr = mindport::parse_mind_url(u)
                .ok_or("--brain: a loopback http://127.0.0.1:PORT URL")?;
            if !mind_port_allowed(&addr) {
                return Err("--brain: the mind's port must be in 41901-41999".into());
            }
            if self.slots.is_none() {
                return Err("--brain needs --ai-slots".into());
            }
            if self.token_file.is_none() {
                return Err("--brain needs --brain-token-file".into());
            }
        }
        if self.token_file.is_some() && self.brain.is_none() {
            return Err("--brain-token-file needs --brain".into());
        }
        if self.export_seat_key.is_some() && self.slots.is_none() {
            return Err("--export-seat-key needs --ai-slots".into());
        }
        Ok(())
    }
}

/// Wires the hook into a fleet's `Shared` and roster (the `main.rs` hook):
/// with `--ai-slots` the roster becomes the slots (AI `Skilled`, seat
/// `Idle`), the mind port and token are read, the seat key is exported;
/// `--follow-council` alone installs an empty hook (AC3b). Without any AI
/// option `sh` and `roster` are returned unchanged.
pub fn setup<H, R, D>(
    sh: Shared<H, R, D>,
    roster: &mut Vec<frontier_agents::AgentSpec>,
    o: &AiOpts,
    seed: u64,
) -> Result<Shared<H, R, D>, String> {
    o.check()?;
    let Some(path) = &o.slots else {
        if o.follow_council {
            let slots = AiSlots {
                seed,
                first_index: aislots::FIRST_INDEX,
                slots: vec![],
            };
            return Ok(install(sh, AiHook::new(slots, None, true)));
        }
        return Ok(sh);
    };
    let slots = AiSlots::load(path)?;
    if slots.seed != seed {
        return Err(format!(
            "--ai-slots: seed {} is not --seed {seed} (the wallets derive from the seed)",
            slots.seed
        ));
    }
    let mind = match (&o.brain, &o.token_file) {
        (Some(u), Some(f)) => {
            let addr = mindport::parse_mind_url(u).ok_or("--brain: not a loopback URL")?;
            let token = std::fs::read_to_string(f)
                .map_err(|e| format!("{}: {e}", f.display()))?
                .trim()
                .to_string();
            if token.is_empty() {
                return Err(format!("{}: empty token", f.display()));
            }
            Some(MindPort::new(addr, token))
        }
        _ => None,
    };
    if let (Some(f), Some(seat)) = (&o.export_seat_key, slots.seat()) {
        aislots::write_seat_key(f, seed, seat.index)?;
    }
    *roster = slots.specs();
    Ok(install(sh, AiHook::new(slots, mind, o.follow_council)))
}

/// Writes the brain's counters beside the bots report (`ai-brain.json`), or
/// to stderr without a report path (the `main.rs` hook, at the end of a run).
pub fn write_stats<H, R, D>(sh: &Shared<H, R, D>, report: &Option<PathBuf>) {
    let Some(h) = &sh.ai else {
        return;
    };
    if h.slots.ai_count() == 0 && !h.follow_council {
        return;
    }
    let v = h.stats_json();
    match report.as_ref().and_then(|p| p.parent()) {
        Some(dir) => {
            let f = dir.join("ai-brain.json");
            let body = serde_json::to_vec_pretty(&v).unwrap_or_default();
            if std::fs::write(&f, body).is_err() {
                eprintln!("frontier-bots: cannot write {}", f.display());
            }
        }
        None => eprintln!("frontier-bots: ai {v}"),
    }
}
