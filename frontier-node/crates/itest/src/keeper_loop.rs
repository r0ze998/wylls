//! **Opt-in local-play keeper loop** (`localnet-expedition-play --keeper
//! public-quicknet`): keeps the runner's home Province resident on the
//! natural 1x clock with real instructions only (`local_keeper`):
//!
//! - every tick: read the home's `resolved_next`, the current bell and the
//!   anchors already on the chain (no duplicate PostAnchor);
//! - fetch the missing rounds T(b) of ended bells from the public drand API,
//!   verified against the pinned Quicknet key, cached in memory, at most
//!   `MAX_ROUNDS` per tick, with exponential back-off on failure; the chain
//!   lock is never held over the network or a wait;
//! - PostAnchor each, then FastForward as far as the anchors whose reveal
//!   windows have closed prove;
//! - with a watched Holding (the Pilot's): once a pending transit's arrival
//!   bell has ended, anchor that bell in EVERY region (its destination is
//!   sealed until the reveal) with PostAnchorMulti batches; present anchors
//!   are skipped (`local_keeper` destination anchors);
//! - every transaction is submitted to the node and LANDS ON ITS OWN TICKER
//!   (no block is produced here, the clock is never changed); its result is
//!   read back. A program refusal (e.g. NotQuiet: an arrival or combat is
//!   pending) stops the keeper safely and is reported as it is.
//!
//! The fee payer is a fresh in-memory key funded by the disposable faucet;
//! no key is read, stored or printed, and nothing is sent anywhere but this
//! node. No account is written directly.
use std::collections::HashMap;
use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::time::{Duration, Instant};

use fclient::addr::Addresses;
use fclient::clock::SeasonClock;
use fclient::{Address, Instruction, Keypair, Signer};
use localnet::server::{lock, Shared};
use serde_json::{json, Value};

use crate::expedition_play::{PROGRAM, SEASON_ID};
use crate::local_keeper::{self as lk, RoundProvenance, MAX_FAST_FORWARD_BELLS, MAX_ROUNDS};

pub const SCHEMA: &str = "frontier-local-play-keeper-v1";
/// Real seconds between ticks.
pub const TICK: Duration = Duration::from_secs(10);
/// How the loop waits between ticks.
/// - `Natural`: every [`TICK`], as always. Natural play uses only this.
/// - `Demo` (TEST-ONLY capture demo on a compressed clock): after a tick in which a transaction landed, the next tick
///   comes after `short`, at most `burst` times in a row. A tick that landed nothing waits the full [`TICK`], and so
///   does the one after a burst. No rule, clock or turn length changes: only how soon the next fresh read and the next
///   single step come while work is landing. Unknown and Stopped stay terminal (each driver's own rule); nothing is
///   resent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    Natural,
    Demo { short: Duration, burst: u32 },
}
/// The capture demo's pace: 1 s while work lands, at most 8 in a row (then the full tick).
pub const DEMO_PACE: Pace = Pace::Demo { short: Duration::from_secs(1), burst: 8 };

/// TEST-ONLY capture demo: how many steps in a row one driver may take in one pass while each of them LANDS (each its
/// own fresh read, its own simulation and its own awaited receipt — exactly the step the next pass would take, minus the
/// sleep between passes). A Wait, a refusal, an Unknown or a stop ends the run at once; nothing is ever sent in parallel
/// and nothing is resent. A contested province needs GatherClash → PostSeed → ResolveFromInputs every turn, one step each:
/// at one step per pass and ~2 s per pass that alone used most of a ×60 turn (10 s), and the lag grew. Natural play: 1.
pub const DEMO_STEPS_PER_PASS: u32 = 4;
/// Steps per driver per pass for `pace` (pure): the demo's bounded run, natural play's single step.
pub fn steps_per_pass(pace: Pace) -> u32 {
    match pace { Pace::Demo { .. } => DEMO_STEPS_PER_PASS, Pace::Natural => 1 }
}

/// The wait after a tick (pure): `landed` says whether that tick landed a transaction; `run` counts the short waits in
/// a row and is reset by every full one.
pub fn next_wait(pace: Pace, landed: bool, run: &mut u32) -> Duration {
    match pace {
        Pace::Demo { short, burst } if landed && *run < burst => {
            *run += 1;
            short
        }
        _ => {
            *run = 0;
            TICK
        }
    }
}

/// How long a submitted transaction may take to land on the node's ticker.
pub const LAND_TIMEOUT: Duration = Duration::from_secs(30);
const PAYER_LAMPORTS: u64 = 50_000_000_000;
/// The fixture world's home province; a world whose home comes from a real PlaceHome passes its own
/// (`Keeper::new_at`, `Pilot::new_at`, `run_at`).
pub const HOME: (i16, i16) = (128, 0);

/// Where rounds come from (the public drand API in service; tests may inject).
pub type RoundSource = Box<dyn Fn(SeasonClock, Range<u32>) -> Pin<Box<dyn Future<Output = Result<Vec<RoundProvenance>, String>> + Send>> + Send + Sync>;

/// The public drand API source of `local_keeper::fetch_rounds`.
pub fn public_quicknet() -> RoundSource {
    Box::new(|clock, bells| Box::pin(async move { lk::fetch_rounds(&clock, bells).await }))
}

/// What the keeper reports (public facts only).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Status {
    pub running: bool,
    pub resolved_next: Option<u32>,
    pub bell: Option<u32>,
    pub resident: Option<bool>,
    pub anchors_posted: u32,
    /// Of `anchors_posted`, the destination anchors of arrival bells.
    pub dest_anchors_posted: u32,
    pub fast_forwards: u32,
    pub rounds_cached: usize,
    pub last_action: Option<String>,
    pub last_error: Option<String>,
    pub stopped: Option<String>,
    /// A submitted transaction whose outcome is unknown (never resent).
    pub unknown_signature: Option<String>,
    /// Why FastForward is waiting (e.g. a not-quiet bell), if it is.
    pub blocked: Option<String>,
    /// The origin driver's last step while FastForward waits (public facts).
    pub origin_step: Option<String>,
    /// The destination driver's last step (public facts); a Stopped/Unknown
    /// here ends that driver only (never resent).
    pub destination_step: Option<String>,
    /// The resident-bells driver's last step (public facts): the quiet bells
    /// of the destination a settled resident of the watched Holding stands in;
    /// a Stopped/Unknown here ends that driver only (never resent).
    pub resident_step: Option<String>,
    /// A second village of the same loop (TEST-ONLY contest pair): its number; `None` for the first (its line is unchanged).
    pub village: Option<u8>,
}
impl Status {
    pub fn json(&self) -> Value {
        json!({"schema": SCHEMA, "running": self.running, "resolved_next": self.resolved_next, "bell": self.bell, "resident": self.resident,
            "anchors_posted": self.anchors_posted, "dest_anchors_posted": self.dest_anchors_posted, "fast_forwards": self.fast_forwards, "rounds_cached": self.rounds_cached,
            "last_action": self.last_action, "last_error": self.last_error, "stopped": self.stopped, "unknown_signature": self.unknown_signature, "blocked": self.blocked, "origin_step": self.origin_step, "destination_step": self.destination_step, "resident_step": self.resident_step})
        .as_object().cloned().map(|mut m| { if let Some(n) = self.village { m.insert("village".into(), json!(n)); } Value::Object(m) }).unwrap_or(Value::Null)
    }
}

pub struct Keeper {
    a: Addresses,
    payer: Keypair,
    source: RoundSource,
    cache: HashMap<u32, RoundProvenance>,
    failures: u32,
    backoff_until: Option<Instant>,
    stop: tokio::sync::watch::Receiver<bool>,
    /// The Holding whose pending arrivals get destination anchors (the Pilot's).
    watch: Option<Address>,
    /// The home province FastForward and the anchors follow ([`HOME`] unless built with `new_at`).
    home: (i16, i16),
    /// How long a submitted transaction may take to land (LAND_TIMEOUT in service).
    pub land_timeout: Duration,
    pub status: Status,
}

/// The most rounds the cache keeps (processed bells are pruned first).
pub const MAX_CACHE: usize = 2 * MAX_ROUNDS;

/// Drops rounds of bells the home has already resolved past, then the
/// lowest bells beyond [`MAX_CACHE`].
pub fn prune_cache(cache: &mut HashMap<u32, RoundProvenance>, resolved_next: u32) {
    cache.retain(|b, _| *b >= resolved_next);
    while cache.len() > MAX_CACHE {
        let lowest = *cache.keys().min().expect("non-empty");
        cache.remove(&lowest);
    }
}

/// Resolves only once the stop flag is actually `true` (a dropped sender
/// never stops the keeper, and never makes a wait spin).
pub async fn stopped(rx: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            if *rx.borrow() {
                return;
            }
            std::future::pending::<()>().await;
        }
    }
}

/// The outcome of one transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sent {
    /// Landed without error.
    Landed(String),
    /// Refused before landing, or landed with the program's error.
    Failed(String),
    /// Submitted, but not seen landed (timeout or stop): never resent.
    Unknown { signature: String, why: String },
}

/// One transaction: built and submitted under a short lock, then awaited
/// (lock released, cancellation-aware) until the node's ticker lands it.
pub(crate) async fn submit_and_wait(state: &Shared, payer: &Keypair, ix: Instruction, what: &str, timeout: Duration, stop: &mut tokio::sync::watch::Receiver<bool>) -> Sent {
    let sig = {
        let mut c = lock(state);
        // a stop that arrived while waiting for the lock: nothing is sent
        if *stop.borrow() {
            return Sent::Failed(format!("{what}: stopped by request before sending"));
        }
        let (blockhash, _) = c.latest_blockhash();
        let t = match fclient::tx::build(&[ix], &lk::budget(), &[payer], &blockhash) {
            Ok(t) => t,
            Err(e) => return Sent::Failed(format!("{what}: {e}")),
        };
        match c.submit(&fclient::tx::wire(&t)) {
            Ok(s) => s,
            Err(e) => return Sent::Failed(format!("{what} refused before landing: {e}")),
        }
    };
    let deadline = Instant::now() + timeout;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            _ = stopped(stop) => {}
        }
        {
            let c = lock(state);
            if let Some(l) = c.transaction(&sig) {
                if let Some(err) = &l.err {
                    let tail: Vec<_> = l.logs.iter().rev().take(6).rev().cloned().collect();
                    return Sent::Failed(format!("{what} failed: {err} (code {:?}) {tail:?}", l.code));
                }
                return Sent::Landed(sig.to_string());
            }
            if c.is_dropped(&sig) {
                return Sent::Failed(format!("{what} was dropped (signature {sig})"));
            }
        }
        if *stop.borrow() {
            return Sent::Unknown { signature: sig.to_string(), why: format!("{what}: stopped while waiting; outcome unknown") };
        }
        if Instant::now() >= deadline {
            return Sent::Unknown { signature: sig.to_string(), why: format!("{what} did not land within {timeout:?}; outcome unknown, not resent") };
        }
    }
}

/// A fresh in-memory fee payer funded by the node's disposable faucet. The
/// stop flag is checked after the lock is taken (nothing funded when set)
/// and while the airdrop lands.
pub(crate) async fn fund_fresh(state: &Shared, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<Keypair, String> {
    let payer = Keypair::new();
    {
        let mut c = lock(state);
        if *stop.borrow() {
            return Err("stopped before funding".into());
        }
        c.airdrop(&payer.pubkey(), PAYER_LAMPORTS)?;
    }
    let deadline = Instant::now() + LAND_TIMEOUT;
    while lock(state).balance(&payer.pubkey()) == 0 {
        if *stop.borrow() {
            return Err("stopped while funding".into());
        }
        if Instant::now() >= deadline {
            return Err("a fee payer was not funded".into());
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            _ = stopped(stop) => {}
        }
    }
    Ok(payer)
}

impl Keeper {
    /// A keeper with a fresh fee payer funded by the node's disposable faucet
    /// (the airdrop lands on the node's own ticker). Nothing is done when
    /// `stop` is already set.
    pub async fn new(state: &Shared, source: RoundSource, stop: tokio::sync::watch::Receiver<bool>) -> Result<Keeper, String> {
        Keeper::new_at(state, source, HOME, stop).await
    }

    /// As [`Keeper::new`], for the home province `home` (the province of the player's real PlaceHome).
    pub async fn new_at(state: &Shared, source: RoundSource, home: (i16, i16), mut stop: tokio::sync::watch::Receiver<bool>) -> Result<Keeper, String> {
        if *stop.borrow() {
            return Err("stopped before start".into());
        }
        let payer = fund_fresh(state, &mut stop).await?;
        Ok(Keeper { a: Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID), payer, source, cache: HashMap::new(),
            failures: 0, backoff_until: None, stop, watch: None, home, land_timeout: LAND_TIMEOUT, status: Status { running: true, ..Status::default() } })
    }

    /// Watch `holding`'s transits for destination anchors.
    pub fn watch_holding(&mut self, holding: Address) {
        self.watch = Some(holding);
    }

    fn note_fetch_failure(&mut self, e: String) {
        self.failures += 1;
        let secs = (2u64 << self.failures.min(6)).min(120);
        self.backoff_until = Some(Instant::now() + Duration::from_secs(secs));
        self.status.last_error = Some(format!("{e} (retry in {secs}s)"));
    }

    /// Anchors every region at each ended arrival bell of `holding`'s pending
    /// transits: one verified round per bell (cached, back-off shared with
    /// the home's fetches), PostAnchorMulti per batch of still-absent
    /// regions (re-read before each send). False once the keeper stopped.
    async fn anchor_destinations(&mut self, state: &Shared, clock: SeasonClock, holding: Address) -> bool {
        let plan = {
            let c = lock(state);
            lk::view(&c, &self.a, self.home.0, self.home.1).and_then(|v| {
                let bells = lk::pending_arrival_bells(&c, &self.a, &holding)?;
                let mut due = vec![];
                for b in bells.into_iter().filter(|b| *b < v.bell_now) {
                    if !lk::missing_region_masks(&c, &self.a, b)?.is_empty() {
                        due.push(b);
                    }
                }
                Ok((v.resolved_next, due))
            })
        };
        let (resolved_next, bells) = match plan {
            Ok(x) => x,
            Err(e) => { self.halt(format!("destination anchors: {e}")); return false; }
        };
        for b in bells {
            if self.stopping() {
                return false;
            }
            if !self.cache.contains_key(&b) {
                if self.backoff_until.is_some_and(|t| Instant::now() < t) {
                    return true;
                }
                let fetched = tokio::select! {
                    r = (self.source)(clock, b..b + 1) => r,
                    _ = stopped(&mut self.stop) => { self.stopping(); return false; }
                };
                match fetched {
                    Ok(rounds) => {
                        self.failures = 0;
                        self.backoff_until = None;
                        for r in rounds {
                            if r.bell == b && r.round == clock.tlock_round(b) {
                                self.cache.insert(b, r);
                            }
                        }
                    }
                    Err(e) => { self.note_fetch_failure(e); return true; }
                }
            }
            // taken before the prune: an arrival bell the home has already
            // resolved past is pruned like any processed bell, but this
            // round is still used now
            let r = self.cache.get(&b).cloned();
            prune_cache(&mut self.cache, resolved_next);
            self.status.rounds_cached = self.cache.len();
            let Some(r) = r else { continue };
            let masks = lk::missing_region_masks(&lock(state), &self.a, b);
            let masks = match masks {
                Ok(m) => m,
                Err(e) => { self.halt(format!("destination anchors: {e}")); return false; }
            };
            for mask in masks {
                if self.stopping() {
                    return false;
                }
                // only the regions still absent now (identity-checked re-read)
                let mask = match lk::still_absent(&lock(state), &self.a, b, mask) {
                    Ok(m) => m,
                    Err(e) => { self.halt(format!("destination anchors: {e}")); return false; }
                };
                if mask == 0 {
                    continue;
                }
                let ix = match lk::post_anchor_multi_ix(&self.a, &self.payer.pubkey(), mask, &r) {
                    Ok(ix) => ix,
                    Err(e) => { self.halt(e); return false; }
                };
                let what = format!("PostAnchorMulti(bell {b}, regions {mask:#06x})");
                let sent = submit_and_wait(state, &self.payer, ix, &what, self.land_timeout, &mut self.stop).await;
                let Some(sig) = self.record(sent) else { return false };
                self.status.anchors_posted += mask.count_ones();
                self.status.dest_anchors_posted += mask.count_ones();
                self.status.last_action = Some(format!("{what} round {} {sig}", r.round));
            }
        }
        true
    }

    pub(crate) fn halt(&mut self, why: String) {
        self.status.running = false;
        self.status.stopped = Some(why);
    }
    fn stopping(&mut self) -> bool {
        if *self.stop.borrow() && self.status.running {
            self.halt("stopped by request".into());
        }
        !self.status.running
    }
    /// A sent transaction's outcome; false when the keeper must stop.
    fn record(&mut self, sent: Sent) -> Option<String> {
        match sent {
            Sent::Landed(sig) => Some(sig),
            Sent::Failed(e) => { self.halt(e); None }
            Sent::Unknown { signature, why } => {
                self.status.unknown_signature = Some(signature);
                self.halt(why);
                None
            }
        }
    }
    fn observe(&mut self, state: &Shared) -> Option<lk::HomeView> {
        let v = lk::view(&lock(state), &self.a, self.home.0, self.home.1).ok()?;
        self.status.resolved_next = Some(v.resolved_next);
        self.status.bell = Some(v.bell_now);
        self.status.resident = Some(frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now));
        Some(v)
    }

    /// One pass. Returns false once the keeper has stopped.
    pub async fn tick(&mut self, state: &Shared) -> bool {
        if self.stopping() {
            return false;
        }
        // 1. read (short lock)
        let read = {
            let c = lock(state);
            lk::view(&c, &self.a, self.home.0, self.home.1).and_then(|v| {
                let clock = lk::season_clock(&c, &self.a)?;
                let end = v.bell_now.min(v.resolved_next.saturating_add(MAX_FAST_FORWARD_BELLS));
                Ok((v, clock, lk::missing_anchors(&c, &self.a, v.region, v.resolved_next..end)))
            })
        };
        let (v, clock, missing) = match read {
            Ok(x) => x,
            Err(e) => { self.halt(format!("cannot read the home: {e}")); return false; }
        };
        self.observe(state);
        prune_cache(&mut self.cache, v.resolved_next);
        // 2. fetch missing rounds (no lock held), bounded, cached, back-off, cancellable
        let need: Vec<u32> = missing.iter().copied().filter(|b| !self.cache.contains_key(b)).take(MAX_ROUNDS).collect();
        if !need.is_empty() && self.backoff_until.is_none_or(|t| Instant::now() >= t) {
            for b in need {
                if self.stopping() {
                    return false;
                }
                let fetched = tokio::select! {
                    r = (self.source)(clock, b..b + 1) => r,
                    _ = stopped(&mut self.stop) => { self.stopping(); return false; }
                };
                match fetched {
                    Ok(rounds) => {
                        self.failures = 0;
                        self.backoff_until = None;
                        for r in rounds {
                            if r.bell == b && r.round == clock.tlock_round(b) {
                                self.cache.insert(b, r);
                            }
                        }
                    }
                    Err(e) => {
                        self.failures += 1;
                        let secs = (2u64 << self.failures.min(6)).min(120);
                        self.backoff_until = Some(Instant::now() + Duration::from_secs(secs));
                        self.status.last_error = Some(format!("{e} (retry in {secs}s)"));
                        break;
                    }
                }
            }
            prune_cache(&mut self.cache, v.resolved_next);
            self.status.rounds_cached = self.cache.len();
        }
        // 3. post the anchors that are still missing (re-read per anchor)
        for b in missing {
            let Some(r) = self.cache.get(&b).cloned() else { continue };
            if self.stopping() {
                return false;
            }
            if lock(state).account(&self.a.anchor(b, v.region)).is_some() {
                continue;
            }
            let ix = match lk::post_anchor_ix(&self.a, &self.payer.pubkey(), v.region, &r) {
                Ok(ix) => ix,
                Err(e) => { self.halt(e); return false; }
            };
            let sent = submit_and_wait(state, &self.payer, ix, &format!("PostAnchor(bell {b})"), self.land_timeout, &mut self.stop).await;
            let Some(sig) = self.record(sent) else { return false };
            self.status.anchors_posted += 1;
            self.status.last_action = Some(format!("PostAnchor bell {b} round {} {sig}", r.round));
        }
        // 3b. the destination anchors of the watched holding's ended arrivals
        if let Some(holding) = self.watch {
            if !self.anchor_destinations(state, clock, holding).await {
                return false;
            }
        }
        // 4. FastForward as far as closed reveal windows prove
        let plan = {
            let c = lock(state);
            lk::view(&c, &self.a, self.home.0, self.home.1).and_then(|v| {
                let limit = v.resolved_next.saturating_add(MAX_FAST_FORWARD_BELLS).min(v.bell_now);
                Ok((v, lk::closed_through(&c, &self.a, v.region, v.resolved_next, limit)?))
            })
        };
        match plan {
            Ok((v, to)) if to > v.resolved_next => {
                if self.stopping() {
                    return false;
                }
                let ix = match lk::fast_forward_ix(&self.a, &self.payer.pubkey(), self.home.0, self.home.1, &v, to) {
                    Ok(ix) => ix,
                    Err(e) => { self.halt(e); return false; }
                };
                // A bell that is not quiet (a departure's origin clash, an arrival) is
                // not FastForward's: simulated first, it is reported and waited on
                // (the origin driver resolves it); nothing is sent. Other
                // simulation refusals stop the keeper.
                let sim = lk::simulate_ix(&lock(state), &self.payer, &ix);
                match sim {
                    Ok(r) if r.err.is_none() => { self.status.blocked = None; }
                    Ok(r) if r.code == Some(lk::NOT_QUIET) => {
                        self.status.blocked = Some(format!("bell {} is not quiet (a pending origin clash or arrival): FastForward waits", v.resolved_next));
                        self.observe(state);
                        return true;
                    }
                    Ok(r) => { self.halt(format!("FastForward(to {to}) simulation: {:?} (code {:?})", r.err, r.code)); return false; }
                    Err(e) => { self.halt(e); return false; }
                }
                // the batch is bounded by MAX_FAST_FORWARD_BELLS; its real encoding must fit the packet
                match lk::encoded_len(std::slice::from_ref(&ix), &self.payer) {
                    Ok(n) if n <= lk::PACKET_BYTES => {}
                    Ok(n) => { self.halt(format!("FastForward to {to} encodes to {n} bytes > {}", lk::PACKET_BYTES)); return false; }
                    Err(e) => { self.halt(e); return false; }
                }
                let sent = submit_and_wait(state, &self.payer, ix, &format!("FastForward(to {to})"), self.land_timeout, &mut self.stop).await;
                // (NotQuiet: an arrival or combat is pending; reported, nothing hidden)
                let Some(sig) = self.record(sent) else { return false };
                self.status.fast_forwards += 1;
                // the program may prove less than requested (e.g. an arrival): read what it did
                let landed = self.observe(state).map(|x| x.resolved_next);
                self.status.last_action = Some(match landed {
                    Some(rn) if rn == to => format!("FastForward {} -> {rn} {sig}", v.resolved_next),
                    Some(rn) => format!("FastForward requested {} -> {to}, landed resolved_next = {rn} (partial) {sig}", v.resolved_next),
                    None => format!("FastForward requested {} -> {to} {sig}; resolved_next unreadable", v.resolved_next),
                });
            }
            Ok(_) => {}
            Err(e) => { self.halt(e); return false; }
        }
        self.observe(state);
        true
    }
}

/// The keeper with the origin driver: each tick is the keeper's, then the
/// origin driver takes ONE step (`origin_driver`: it resolves a not-quiet
/// departure bell FastForward waits on, then settles the departure's origin;
/// with nothing to do it sends nothing). A driver `Unknown` (with its signature) or `Stopped`
/// stops the whole loop for good.
pub struct Pilot {
    pub keeper: Keeper,
    pub origin: Option<crate::origin_driver::OriginDriver>,
    pub destination: Option<crate::destination_driver::DestinationDriver>,
    /// The resident's quiet destination bells (after its arrival settled).
    pub resident: Option<crate::resident_bells::ResidentBells>,
    /// A LEGACY village's ordinary march (legacy_march: settle the departure, reveal, the destination's bells,
    /// SettleTransit); it takes the wide destination driver's place for such a village and reports in its field.
    pub legacy: Option<crate::legacy_march::LegacyMarchDriver>,
    /// Whether the last tick landed a transaction (the keeper's anchors or FastForward, or any driver's step).
    pub landed: bool,
    /// Further villages served by THIS loop (TEST-ONLY contest pair: a second player's village in the same world). Each
    /// has its own keeper for its own home (anchors of its region, its home's quiet turns) and its own drivers with the
    /// world sweep off; the first village's world sweep skips their provinces, so no two drivers race on one province.
    /// A village's Unknown or Stopped ends that village only (never resent).
    pub others: Vec<Village>,
    /// Steps per driver per pass ([`steps_per_pass`]): 1 (natural play, every caller of `Pilot::new*`); the TEST-ONLY
    /// demo pace sets [`DEMO_STEPS_PER_PASS`] in [`run_paced_with`], for every village of the loop.
    pub per_step: u32,
}

/// Which status field a step's line goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field { Keeper, Destination, Resident, Origin }
/// One step's outcome, as the sequencer needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out { Landed, Quiet, Unknown { signature: String, why: String }, Stopped(String) }
/// One step's report: its field, its outcome, its line (the driver's own `Debug` of its step).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report { pub field: Field, pub out: Out, pub text: String }

/// One step of a keeper loop pass (the keeper's own tick, or one driver's step): at most one transaction per call.
pub trait TickStep: Send {
    fn run<'a>(&'a mut self, state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>>;
    /// An ended driver is skipped (it answers its terminal step forever and sends nothing).
    fn done(&self) -> bool { false }
}

/// What a pass ran: every report in order, whether anything landed, and why it stopped early (if it did).
#[derive(Debug, Default)]
pub struct RunOut { pub reports: Vec<Report>, pub landed: bool, pub stopped: Option<Report> }

/// Runs the steps of one pass in order. One village (`pair` false): exactly the loop's old rules — the keeper not alive
/// ends the pass; the origin step's Unknown or Stopped ends it; another driver's Unknown or Stopped ends only that driver
/// (it is reported, never resent) and the next step runs. A contest pair (`pair` true): the same, and ANY Unknown ends
/// the pass before the next step is called, so no later step of any village can send what might duplicate it.
pub async fn run_steps(state: &Shared, steps: &mut [&mut dyn TickStep], pair: bool) -> RunOut {
    run_steps_bounded(state, steps, pair, 1).await
}

/// [`run_steps`], where each DRIVER (never the keeper) may take up to `per_step` steps in a row while each one lands
/// ([`DEMO_STEPS_PER_PASS`]; 1 is exactly `run_steps`). Each step is called only after the previous one's receipt; the
/// first that does not land (a wait, a refusal, an unknown outcome, a stop) ends that driver's run, and then the same
/// rules as `run_steps` decide whether the pass goes on (a pair: any Unknown ends it before anything else is called).
pub async fn run_steps_bounded(state: &Shared, steps: &mut [&mut dyn TickStep], pair: bool, per_step: u32) -> RunOut {
    let mut out = RunOut::default();
    for s in steps.iter_mut() {
        if s.done() { continue; }
        let mut r = s.run(state).await;
        out.landed |= r.out == Out::Landed;
        out.reports.push(r.clone());
        let mut taken = 1u32;
        while r.field != Field::Keeper && r.out == Out::Landed && taken < per_step.max(1) && !s.done() {
            r = s.run(state).await;
            taken += 1;
            out.landed |= r.out == Out::Landed;
            out.reports.push(r.clone());
        }
        let end = match (&r.field, &r.out) {
            (Field::Keeper, Out::Unknown { .. } | Out::Stopped(_)) => true,
            (Field::Origin, Out::Unknown { .. } | Out::Stopped(_)) => true,
            (_, Out::Unknown { .. }) => pair,
            _ => false,
        };
        if end { out.stopped = Some(r); break; }
    }
    out
}

macro_rules! driver_step {
    ($t:ty, $field:expr, $map:expr) => {
        impl TickStep for $t {
            fn run<'a>(&'a mut self, state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>> {
                Box::pin(async move { let st = self.step(state).await; let text = format!("{st:?}"); Report { field: $field, out: $map(st), text } })
            }
            fn done(&self) -> bool { self.terminal().is_some() }
        }
    };
}
fn origin_out(st: crate::origin_driver::Step) -> Out {
    use crate::origin_driver::Step as S;
    match st { S::Landed(..) => Out::Landed, S::Unknown { signature, why } => Out::Unknown { signature, why }, S::Stopped(e) => Out::Stopped(e), _ => Out::Quiet }
}
driver_step!(crate::legacy_march::LegacyMarchDriver, Field::Destination, origin_out);
driver_step!(crate::destination_driver::DestinationDriver, Field::Destination, |st: crate::destination_driver::Step| {
    use crate::destination_driver::Step as S;
    match st { S::Landed(..) => Out::Landed, S::Unknown { signature, why } => Out::Unknown { signature, why }, S::Stopped(e) => Out::Stopped(e), _ => Out::Quiet }
});
driver_step!(crate::resident_bells::ResidentBells, Field::Resident, |st: crate::resident_bells::Step| {
    use crate::resident_bells::Step as S;
    match st { S::Landed(..) => Out::Landed, S::Unknown { signature, why } => Out::Unknown { signature, why }, S::Stopped(e) => Out::Stopped(e), _ => Out::Quiet }
});
impl TickStep for crate::origin_driver::OriginDriver {
    fn run<'a>(&'a mut self, state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>> {
        Box::pin(async move { let st = self.step(state).await; let text = format!("{st:?}"); Report { field: Field::Origin, out: origin_out(st), text } })
    }
}
impl TickStep for Keeper {
    fn run<'a>(&'a mut self, state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>> {
        Box::pin(async move {
            let before = (self.status.anchors_posted, self.status.fast_forwards);
            let alive = self.tick(state).await;
            let out = if !alive {
                match (&self.status.unknown_signature, &self.status.stopped) {
                    (Some(sig), why) => Out::Unknown { signature: sig.clone(), why: why.clone().unwrap_or_default() },
                    (None, why) => Out::Stopped(why.clone().unwrap_or_else(|| "stopped".into())),
                }
            } else if (self.status.anchors_posted, self.status.fast_forwards) != before { Out::Landed } else { Out::Quiet };
            Report { field: Field::Keeper, out, text: String::new() }
        })
    }
}

/// Writes one pass's reports into the keeper's status (its fields, the unknown signature; the origin's end halts it).
fn apply(keeper: &mut Keeper, r: &RunOut) {
    for rep in &r.reports {
        match rep.field {
            Field::Keeper => {}
            Field::Destination => keeper.status.destination_step = Some(rep.text.clone()),
            Field::Resident => keeper.status.resident_step = Some(rep.text.clone()),
            Field::Origin => keeper.status.origin_step = Some(rep.text.clone()),
        }
        if rep.field != Field::Keeper {
            if let Out::Unknown { signature, .. } = &rep.out { keeper.status.unknown_signature = Some(signature.clone()); }
        }
    }
    if let Some(stop) = &r.stopped {
        if stop.field == Field::Origin {
            let why = match &stop.out { Out::Unknown { why, .. } => why.clone(), Out::Stopped(e) => e.clone(), _ => String::new() };
            keeper.halt(format!("origin: {why}"));
        }
    }
}

/// One village of a keeper loop, as the loop's outer order sees it (the real first village and [`Village`]; a test's mock).
pub trait PassVillage: Send {
    /// One pass of its steps through [`run_steps`].
    fn pass<'a>(&'a mut self, state: &'a Shared, pair: bool) -> Pin<Box<dyn Future<Output = RunOut> + Send + 'a>>;
    /// Writes a pass into its status (the signature of an unknown outcome; the origin's end halts it).
    fn record(&mut self, r: &RunOut);
    fn status(&self) -> &Status;
    fn halt(&mut self, why: String);
    fn ended(&self) -> bool;
    fn end(&mut self);
}

/// The keeper loop's outer order, shared by the real [`Pilot`] and the tests: `(alive, landed)`. One village: its pass and
/// the old rules. A contest pair: the pair rule ([`pair_must_halt`]) before the first village's pass and before and after
/// every other village's; any unknown outcome halts every village and returns at once, so no village's step runs after
/// it — in this pass or the next.
pub async fn orchestrate(state: &Shared, first: &mut dyn PassVillage, others: &mut [&mut dyn PassVillage]) -> (bool, bool) {
    let pair = !others.is_empty();
    fn must(first: &dyn PassVillage, others: &[&mut dyn PassVillage]) -> bool {
        let st: Vec<&Status> = others.iter().map(|v| v.status()).collect();
        pair_must_halt(first.status(), &st)
    }
    fn halt_all(first: &mut dyn PassVillage, others: &mut [&mut dyn PassVillage]) {
        let why = "an unknown outcome in a shared-world step: the whole pair loop stops (never resent)".to_string();
        if first.status().stopped.is_none() { first.halt(why.clone()); }
        for v in others.iter_mut() { if v.status().stopped.is_none() { v.halt(why.clone()); } v.end(); }
    }
    if pair && must(first, others) { halt_all(first, others); return (false, false); }
    let r = first.pass(state, pair).await;
    first.record(&r);
    let mut landed = r.landed;
    if let Some(stop) = &r.stopped {
        if pair { halt_all(first, others); }
        if stop.field == Field::Keeper || stop.field == Field::Origin || pair { return (false, landed); }
    }
    for i in 0..others.len() {
        if must(first, others) { halt_all(first, others); return (false, landed); }
        if others[i].ended() { continue; }
        let r = others[i].pass(state, true).await;
        others[i].record(&r);
        landed |= r.landed;
        if r.stopped.is_some() { others[i].end(); }
    }
    if pair && must(first, others) { halt_all(first, others); return (false, landed); }
    (true, landed)
}

/// The Pilot's first village, borrowed field by field for one pass.
struct FirstVillage<'p> {
    keeper: &'p mut Keeper,
    destination: &'p mut Option<crate::destination_driver::DestinationDriver>,
    legacy: &'p mut Option<crate::legacy_march::LegacyMarchDriver>,
    resident: &'p mut Option<crate::resident_bells::ResidentBells>,
    origin: &'p mut Option<crate::origin_driver::OriginDriver>,
    per_step: u32,
}
fn village_steps<'s>(keeper: &'s mut Keeper, destination: &'s mut Option<crate::destination_driver::DestinationDriver>, legacy: &'s mut Option<crate::legacy_march::LegacyMarchDriver>, resident: &'s mut Option<crate::resident_bells::ResidentBells>, origin: &'s mut Option<crate::origin_driver::OriginDriver>) -> Vec<&'s mut dyn TickStep> {
    let mut steps: Vec<&mut dyn TickStep> = vec![keeper as &mut dyn TickStep];
    if let Some(d) = destination.as_mut() { steps.push(d); }
    if let Some(d) = legacy.as_mut() { steps.push(d); }
    if let Some(d) = resident.as_mut() { steps.push(d); }
    if let Some(d) = origin.as_mut() { steps.push(d); }
    steps
}
impl PassVillage for FirstVillage<'_> {
    fn pass<'a>(&'a mut self, state: &'a Shared, pair: bool) -> Pin<Box<dyn Future<Output = RunOut> + Send + 'a>> {
        Box::pin(async move { let per = self.per_step; let mut steps = village_steps(self.keeper, self.destination, self.legacy, self.resident, self.origin); run_steps_bounded(state, &mut steps, pair, per).await })
    }
    fn record(&mut self, r: &RunOut) { apply(self.keeper, r); }
    fn status(&self) -> &Status { &self.keeper.status }
    fn halt(&mut self, why: String) { self.keeper.halt(why); }
    fn ended(&self) -> bool { false }
    fn end(&mut self) {}
}
impl PassVillage for Village {
    fn pass<'a>(&'a mut self, state: &'a Shared, pair: bool) -> Pin<Box<dyn Future<Output = RunOut> + Send + 'a>> {
        Box::pin(async move { let Village { keeper, destination, legacy, resident, origin, per_step, .. } = self; let per = *per_step; let mut steps = village_steps(keeper, destination, legacy, resident, origin); run_steps_bounded(state, &mut steps, pair, per).await })
    }
    fn record(&mut self, r: &RunOut) { apply(&mut self.keeper, r); }
    fn status(&self) -> &Status { &self.keeper.status }
    fn halt(&mut self, why: String) { self.keeper.halt(why); }
    fn ended(&self) -> bool { self.ended }
    fn end(&mut self) { self.ended = true; }
}

/// The contest pair's stop rule (pure): with more than one village in a loop, ANY unknown outcome — the first village's
/// keeper or drivers, or another village's — halts the whole loop. Every keeper-side transaction touches shared world state
/// (anchors of a region, a province's turn, its seed and resolve), so after one unknown no other village may send a
/// step that could duplicate it. A refusal before sending (nothing sent) ends only its own village.
pub fn pair_must_halt(first: &Status, others: &[&Status]) -> bool {
    !others.is_empty() && (first.unknown_signature.is_some() || others.iter().any(|s| s.unknown_signature.is_some()))
}

/// One more village of a [`Pilot`] (see `Pilot.others`).
pub struct Village {
    pub home: (i32, i32),
    pub keeper: Keeper,
    pub origin: Option<crate::origin_driver::OriginDriver>,
    pub destination: Option<crate::destination_driver::DestinationDriver>,
    pub resident: Option<crate::resident_bells::ResidentBells>,
    pub legacy: Option<crate::legacy_march::LegacyMarchDriver>,
    /// Ended (its keeper or origin driver stopped, or an unknown outcome): it is reported and never ticked again.
    pub ended: bool,
    /// Steps per driver per pass ([`steps_per_pass`]; the Pilot's).
    pub per_step: u32,
}

type Drivers = (Option<crate::origin_driver::OriginDriver>, Option<crate::destination_driver::DestinationDriver>, Option<crate::resident_bells::ResidentBells>, Option<crate::legacy_march::LegacyMarchDriver>);

/// The drivers of one village (its Holding `h`, home `home`): each with its own funded fee payer. `world_crank`: whether
/// its legacy march driver also sweeps the world's other provinces (only the first village's does).
async fn village_drivers(state: &Shared, keeper: &Keeper, h: Address, home: (i16, i16), world_crank: bool, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<Drivers, String> {
    let payer = fund_fresh(state, stop).await?;
    let dest_payer = fund_fresh(state, stop).await?;
    let resident_payer = fund_fresh(state, stop).await?;
    // (a legacy village — its Holding decodes as one, program-owned — marches the ordinary way: the
    //  legacy march driver instead of the wide destination driver; a wide holding is as before)
    let legacy_ref = crate::legacy_march::legacy_village(&lock(state), &keeper.a, &h);
    let (destination, legacy) = match legacy_ref {
        Some(href) => {
            let mut d = crate::legacy_march::LegacyMarchDriver::new(href, dest_payer, stop.clone());
            d.world_crank = world_crank;
            (None, Some(d))
        }
        None => (Some(crate::destination_driver::DestinationDriver::new(h, dest_payer, stop.clone())), None),
    };
    Ok((Some(crate::origin_driver::OriginDriver::new_at(h, home, payer, stop.clone())), destination,
        Some(crate::resident_bells::ResidentBells::new(h, resident_payer, stop.clone())), legacy))
}

impl Village {
    /// The provinces this village resolves itself: its home and where its hosts stand.
    fn provinces(&self) -> Vec<(i32, i32)> {
        std::iter::once(self.home).chain(self.legacy.iter().flat_map(|l| l.stands.iter().map(|s| s.0))).collect()
    }
}

impl Pilot {
    /// `holding`: the player's Holding (the origin driver needs it); `None`
    /// runs the keeper alone.
    pub async fn new(state: &Shared, source: RoundSource, holding: Option<Address>, stop: tokio::sync::watch::Receiver<bool>) -> Result<Pilot, String> {
        Pilot::new_at(state, source, holding, HOME, stop).await
    }

    /// As [`Pilot::new`], for the home province `home`: the keeper and the origin driver both follow it.
    pub async fn new_at(state: &Shared, source: RoundSource, holding: Option<Address>, home: (i16, i16), mut stop: tokio::sync::watch::Receiver<bool>) -> Result<Pilot, String> {
        let mut keeper = Keeper::new_at(state, source, home, stop.clone()).await?;
        if let Some(h) = holding {
            keeper.watch_holding(h);
        }
        let (origin, destination, resident, legacy) = match holding {
            Some(h) => village_drivers(state, &keeper, h, home, true, &mut stop).await?,
            None => (None, None, None, None),
        };
        Ok(Pilot { keeper, origin, destination, resident, legacy, landed: false, others: vec![], per_step: 1 })
    }

    /// TEST-ONLY contest pair: serve one more village (Holding `holding`, home `home`) in this loop, with its own keeper
    /// for its home (fresh round source) and its own drivers, world sweep off. Its status lines carry `village: n`.
    pub async fn add_village(&mut self, state: &Shared, source: RoundSource, holding: Address, home: (i16, i16), mut stop: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
        let mut keeper = Keeper::new_at(state, source, home, stop.clone()).await?;
        keeper.watch_holding(holding);
        keeper.status.village = Some(self.others.len() as u8 + 2);
        let (origin, destination, resident, legacy) = village_drivers(state, &keeper, holding, home, false, &mut stop).await?;
        self.others.push(Village { home: (home.0 as i32, home.1 as i32), keeper, origin, destination, resident, legacy, ended: false, per_step: self.per_step });
        Ok(())
    }

    /// One pass; false once stopped: [`orchestrate`] over the first village and the others (the old order and rules for
    /// one village; the pair rule for two).
    pub async fn tick(&mut self, state: &Shared) -> bool {
        self.landed = false;
        // the first village's world sweep never cranks a province another village resolves itself
        if let Some(l) = self.legacy.as_mut() {
            l.world_skip = self.others.iter().filter(|v| !v.ended).flat_map(|v| v.provinces()).collect();
        }
        let Pilot { keeper, destination, legacy, resident, origin, others, per_step, .. } = self;
        let mut first = FirstVillage { keeper, destination, legacy, resident, origin, per_step: *per_step };
        let mut rest: Vec<&mut dyn PassVillage> = others.iter_mut().map(|v| v as &mut dyn PassVillage).collect();
        let (alive, landed) = orchestrate(state, &mut first, &mut rest).await;
        self.landed = landed;
        alive
    }
}

/// Ticks every [`TICK`] until stopped (safely, on a refusal) or `stop` is set;
/// `report` gets the status whenever it changes. With `holding`, the origin
/// driver resolves a departure's origin bell when FastForward waits on it.
pub async fn run(state: Shared, source: RoundSource, holding: Option<Address>, stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Status)) {
    run_at(state, source, holding, HOME, stop, report).await
}

/// As [`run`], for the home province `home` (a world whose home came from a real PlaceHome).
pub async fn run_at(state: Shared, source: RoundSource, holding: Option<Address>, home: (i16, i16), stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Status)) {
    run_paced(state, source, holding, home, Pace::Natural, stop, report).await
}

/// As [`run_at`], waiting between ticks as `pace` says ([`Pace`]; natural play passes `Pace::Natural`).
pub async fn run_paced(state: Shared, source: RoundSource, holding: Option<Address>, home: (i16, i16), pace: Pace, stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Status)) {
    run_paced_with(state, source, holding, home, pace, stop, report, None).await
}

/// A village to add to a running loop (TEST-ONLY contest pair): its round source, Holding and home province.
pub type MoreVillage = (RoundSource, Address, (i16, i16));

/// [`run_paced`], and (TEST-ONLY contest pair) the villages that arrive on `more` are served by the same loop
/// ([`Pilot::add_village`]); each village's status is reported as its own line (`village: n`). Without `more` it is
/// exactly `run_paced`.
pub async fn run_paced_with(state: Shared, source: RoundSource, holding: Option<Address>, home: (i16, i16), pace: Pace, mut stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Status), mut more: Option<tokio::sync::mpsc::UnboundedReceiver<MoreVillage>>) {
    let mut run = 0u32;
    let mut p = match Pilot::new_at(&state, source, holding, home, stop.clone()).await {
        Ok(p) => p,
        Err(e) => {
            report(&Status { stopped: Some(e), ..Status::default() });
            return;
        }
    };
    p.per_step = steps_per_pass(pace);
    let mut last = Status::default();
    let mut last_others: Vec<Status> = vec![];
    loop {
        if let Some(rx) = more.as_mut() {
            while let Ok((src, h, at)) = rx.try_recv() {
                let n = p.others.len() as u8 + 2;
                if let Err(e) = p.add_village(&state, src, h, at, stop.clone()).await {
                    report(&Status { stopped: Some(format!("village {n}: {e}")), village: Some(n), ..Status::default() });
                }
            }
        }
        let alive = p.tick(&state).await;
        if p.keeper.status != last {
            report(&p.keeper.status);
            last = p.keeper.status.clone();
        }
        for (i, v) in p.others.iter().enumerate() {
            if last_others.get(i) != Some(&v.keeper.status) {
                report(&v.keeper.status);
                if i < last_others.len() { last_others[i] = v.keeper.status.clone(); } else { last_others.push(v.keeper.status.clone()); }
            }
        }
        if !alive {
            return;
        }
        let wait = next_wait(pace, p.landed, &mut run);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = stopped(&mut stop) => {
                p.keeper.stopping();
                report(&p.keeper.status);
                for v in p.others.iter_mut() { v.keeper.stopping(); report(&v.keeper.status); }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The pace (pure): natural ticks every TICK whatever landed; the TEST-ONLY demo goes short only while work lands,
    // at most `burst` in a row, and any tick that landed nothing waits the full TICK.
    #[test]
    fn pace_natural_is_every_tick_and_demo_is_bounded_and_only_while_work_lands() {
        let mut run = 0;
        for landed in [true, true, false, true] {
            assert_eq!(next_wait(Pace::Natural, landed, &mut run), TICK);
            assert_eq!(run, 0);
        }
        let short = Duration::from_secs(1);
        let demo = Pace::Demo { short, burst: 3 };
        let mut run = 0;
        let waits: Vec<Duration> = [true, true, true, true, true, false, true, false, false].iter().map(|&l| next_wait(demo, l, &mut run)).collect();
        assert_eq!(waits, vec![short, short, short, TICK, short, TICK, short, TICK, TICK], "three short, then the full tick; nothing landed: the full tick, and the run starts again");
        // (a zero burst is the natural pace)
        let mut run = 0;
        assert_eq!(next_wait(Pace::Demo { short, burst: 0 }, true, &mut run), TICK);
        assert_eq!(DEMO_PACE, Pace::Demo { short: Duration::from_secs(1), burst: 8 });
        // (the full tick itself is unchanged)
        assert_eq!(TICK, Duration::from_secs(10));
    }

    // The wiring: `run_at` (every caller of natural play) is the natural pace; only the natural runner's demo world asks
    // for the demo pace, and only from the demo option the launcher checked.
    #[test]
    fn pace_wiring_natural_by_default_demo_only_on_a_demo_world() {
        let src = include_str!("keeper_loop.rs");
        assert!(src.contains("    run_paced(state, source, holding, home, Pace::Natural, stop, report).await\n"));
        let bin = include_str!("bin/localnet_natural_play.rs");
        assert!(bin.contains("let pace = if demo.is_some() { itest::keeper_loop::DEMO_PACE } else { itest::keeper_loop::Pace::Natural };"));
        assert_eq!(bin.matches("DEMO_PACE").count(), 1);
        let exp = include_str!("bin/localnet_expedition_play.rs");
        assert!(!exp.contains("DEMO_PACE") && !exp.contains("run_paced"), "the expedition runner keeps the natural pace");
    }
    use crate::expedition_play::{inspect, launch, parse_args, REFUSED_PORT};
    use localnet::server;

    #[test]
    fn keeper_is_an_explicit_opt_in() {
        let base = |extra: &[&str]| {
            let mut v: Vec<String> = ["--artifact", "/tmp/x.so", "--artifact-sha256", &"ab".repeat(32),
                "--player-wallet", &Address::new_from_array([7; 32]).to_string(), "--rpc-port", "41911", "--ws-port", "41912"]
                .map(String::from).to_vec();
            v.extend(extra.iter().map(|s| s.to_string()));
            v
        };
        // (the port checks need free ports; only the keeper flag is examined here)
        let keeper_of = |a: Vec<String>| parse_args(a).map(|o| o.keeper);
        for bad in [&["--keeper"][..], &["--keeper", "test-beacon"], &["--keeper", "public-quicknet", "--keeper", "public-quicknet"], &["public-quicknet", "--keeper"]] {
            assert!(keeper_of(base(bad)).is_err(), "{bad:?}");
        }
        if let Ok(k) = keeper_of(base(&[])) { assert!(!k, "off by default"); }
        if let Ok(k) = keeper_of(base(&["--keeper", "public-quicknet"])) { assert!(k); }
    }

    /// A stop receiver whose sender stays alive and false.
    fn keep_rx() -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        std::mem::forget(tx);
        rx
    }

    fn artifact() -> crate::expedition_play::Artifact {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap()
    }
    fn ports(from: u16) -> (u16, u16) {
        let p = (from..from + 7).find(|p| *p != REFUSED_PORT && server::check_port(*p).is_ok()).unwrap();
        (p, (p + 1..from + 8).find(|x| server::check_port(*x).is_ok()).unwrap())
    }
    /// Test chain only: move the node's clock with its own scale control.
    fn advance(state: &Shared, to_unix: i64) {
        let mut c = lock(state);
        c.set_scale(1000.0);
        while c.unix_timestamp() < to_unix { c.produce_block(); }
        c.set_scale(1.0);
        c.produce_block();
    }

    /// A source answering the right round with ANOTHER round's real
    /// signature: the real program refuses the PostAnchor and the keeper stops
    /// safely, reporting the refusal (no network; real artifact).
    #[test]
    #[ignore]
    fn a_program_refusal_stops_the_keeper_and_is_reported() {
        let art = artifact();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (p, q) = ports(41_950);
            let play = launch(&art, Keypair::new().pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fclient::seal::fixture_dir().join("q4-vector.json")).unwrap()).unwrap();
            let foreign = v["sig"].as_str().unwrap().to_owned();
            let source: RoundSource = Box::new(move |clock, bells| {
                let foreign = foreign.clone();
                Box::pin(async move {
                    Ok(bells.map(|b| RoundProvenance { bell: b, round: clock.tlock_round(b), signature_hex: foreign.clone(),
                        source: "test: another round's signature".into(), verified_against: "nothing (deliberately wrong)" }).collect())
                })
            });
            let mut k = Keeper::new(&state, source, keep_rx()).await.unwrap();
            let g = { let c = lock(&state); lk::season_clock(&c, &k.a).unwrap().genesis_ts };
            let bell = k.status.bell;
            let _ = bell;
            advance(&state, g + 600 * 12 + 5);
            assert!(!k.tick(&state).await, "stopped");
            let why = k.status.stopped.clone().unwrap();
            assert!(why.contains("PostAnchor(bell 10) failed"), "{why}");
            assert_eq!(k.status.anchors_posted, 0);
            assert!(!k.tick(&state).await, "stays stopped");
            play.running.stop();
        });
    }

    /// Real network (public drand) + real artifact: ticks post the anchors of
    /// ended bells once (no duplicates), and after their reveal windows close
    /// a tick fast-forwards the home; it is resident.
    #[test]
    #[ignore]
    fn ticks_keep_the_home_resident_with_public_rounds() {
        assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
        let art = artifact();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (p, q) = ports(41_960);
            let play = launch(&art, Keypair::new().pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let mut k = Keeper::new(&state, public_quicknet(), keep_rx()).await.unwrap();
            let clock = { let c = lock(&state); lk::season_clock(&c, &k.a).unwrap() };
            advance(&state, clock.genesis_ts + 600 * 13 + 5); // bells 10..12 have ended
            assert!(k.tick(&state).await, "{:?}", k.status);
            assert_eq!(k.status.anchors_posted, 3, "{:?}", k.status);
            assert_eq!(k.status.fast_forwards, 0, "windows not closed yet");
            assert!(k.tick(&state).await);
            assert_eq!(k.status.anchors_posted, 3, "no duplicate PostAnchor");
            let closed = { let c = lock(&state); lk::reveal_closed_at(&c, &k.a, lk::view(&c, &k.a, 128, 0).unwrap().region, 10..13).unwrap() };
            advance(&state, closed + 1);
            assert!(k.tick(&state).await, "{:?}", k.status);
            assert_eq!(k.status.fast_forwards, 1, "{:?}", k.status);
            assert_eq!(k.status.resolved_next, Some(13));
            assert_eq!(k.status.resident, Some(true), "{:?}", k.status);
            eprintln!("{}", k.status.json());
            play.running.stop();
        });
    }

    /// Real artifact + public drand: a REAL Depart (arrival bell b0 + 5);
    /// once that bell has ended and its public round exists, ticks of a keeper
    /// watching the holding create the arrival bell's anchor in every region
    /// (PostAnchorMulti batches of at most seven, each landed), every one of
    /// them passing `anchor_landed`'s identity check; the next tick sends no
    /// PostAnchorMulti again. The arrival round is published in REAL time, so
    /// this waits up to about an hour. Ignored without the artifact and
    /// `WYLLS_PUBLIC_DRAND=1`.
    #[test]
    #[ignore]
    fn destination_batches_land_once_and_the_next_tick_repeats_none() {
        assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
        let art = artifact();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (p, q) = ports(41_980);
            let player = Keypair::new();
            let play = launch(&art, player.pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let f = &play.fixture;
            let b0 = crate::origin_driver::real_origin::real_depart(&state, f, &player);
            let arrive = b0 + 5;
            let mut k = Keeper::new(&state, public_quicknet(), keep_rx()).await.unwrap();
            k.watch_holding(f.holding);
            assert_eq!({ let c = lock(&state); lk::pending_arrival_bells(&c, &k.a, &f.holding).unwrap() }, vec![arrive]);
            let clock = { let c = lock(&state); lk::season_clock(&c, &k.a).unwrap() };
            advance(&state, clock.genesis_ts + 600 * (arrive as i64 + 1) + 5); // the arrival bell has ended (chain clock)
            // regions already holding THE anchor of the arrival bell before any tick
            let (pre, home_region) = {
                let c = lock(&state);
                let pre: Vec<u8> = (0..lk::REGIONS).filter(|rg| lk::anchor_landed(&c, &k.a, arrive, *rg).unwrap().is_some()).collect();
                (pre, lk::view(&c, &k.a, 128, 0).unwrap().region)
            };
            let deadline = Instant::now() + Duration::from_secs(70 * 60);
            loop {
                assert!(k.tick(&state).await, "{:?}", k.status);
                let left = { let c = lock(&state); lk::missing_region_masks(&c, &k.a, arrive).unwrap() };
                if left.is_empty() { break; }
                assert!(Instant::now() < deadline, "the arrival round was not served in time: {:?}", k.status);
                tokio::time::sleep(Duration::from_secs(30)).await; // the public round, in real time
            }
            // every region holds THE anchor of the arrival bell (identity-checked)
            {
                let c = lock(&state);
                for rg in 0..lk::REGIONS {
                    assert!(lk::anchor_landed(&c, &k.a, arrive, rg).unwrap().is_some(), "region {rg}");
                }
            }
            // Exact count: the home step runs before the destination step in a
            // tick and covers the arrival bell (no origin driver here, so the
            // not-quiet departure bell keeps resolved_next <= b0 and the bell is
            // inside its FastForward range); it posts the HOME region's anchor
            // by PostAnchor. Every other region absent before the ticks is the
            // destination step's: normally 16 - 1 = 15.
            let v = { let c = lock(&state); lk::view(&c, &k.a, 128, 0).unwrap() };
            assert!(v.resolved_next <= arrive && arrive < v.resolved_next + lk::MAX_FAST_FORWARD_BELLS, "the home step covered the arrival bell: {v:?}");
            let not_dest = pre.iter().copied().chain(std::iter::once(home_region)).collect::<std::collections::BTreeSet<u8>>().len() as u32;
            let posted = k.status.dest_anchors_posted;
            assert_eq!(posted, u32::from(lk::REGIONS) - not_dest, "pre-existing {pre:?}, home region {home_region}: {:?}", k.status);
            if pre.is_empty() {
                assert_eq!(posted, 15);
            }
            // the next tick: no PostAnchorMulti, nothing left pending, and every
            // landed transaction is one the counters account for (the keeper is the
            // only sender here: a home PostAnchor or FastForward of a newly ended bell)
            let (tx0, a0, f0) = (lock(&state).transaction_count(), k.status.anchors_posted, k.status.fast_forwards);
            assert!(k.tick(&state).await, "{:?}", k.status);
            assert_eq!(k.status.dest_anchors_posted, posted, "no PostAnchorMulti repeated");
            assert_eq!(lock(&state).pending(), 0, "nothing left in flight");
            let tx_delta = lock(&state).transaction_count() - tx0;
            assert_eq!(tx_delta, u64::from(k.status.anchors_posted - a0) + u64::from(k.status.fast_forwards - f0), "no unaccounted transaction: {:?}", k.status);
            play.running.stop();
        });
    }

    // ------------------------------------------------ no network, no artifact

    use crate::expedition_play::Base;
    use frontier_abi::v2::layout::{province::province as P, write_header, AccountKind as K2};

    /// A plain in-memory chain (no program, no ticker): the base Season and a
    /// minimal home with resolved_next 10, its clock moved to bell 13.
    fn plain() -> Shared {
        let mut c = localnet::Chain::new(localnet::Config::default());
        c.produce_block();
        let base = Base::new(c.unix_timestamp()).unwrap();
        base.install(&mut c).unwrap();
        let mut pd = vec![0u8; K2::Province.size()];
        assert!(write_header(&mut pd, K2::Province, SEASON_ID));
        pd[P::P..P::P + 2].copy_from_slice(&128i16.to_le_bytes());
        pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&10u32.to_le_bytes());
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        c.set_account(a.province(128, 0), fclient::ports::Account { lamports: 1_000_000, data: pd, owner: a.program, executable: false }).unwrap();
        let target = base.genesis_ts + 600 * 13 + 5;
        c.set_scale(1000.0);
        while c.unix_timestamp() < target { c.produce_block(); }
        c.set_scale(1.0);
        c.produce_block();
        std::sync::Arc::new(std::sync::Mutex::new(c))
    }
    fn fake_source(on_call: impl Fn() + Send + Sync + 'static) -> RoundSource {
        Box::new(move |clock, bells| {
            on_call();
            Box::pin(async move { Ok(bells.map(|b| RoundProvenance { bell: b, round: clock.tlock_round(b), signature_hex: "00".repeat(48),
                source: "test".into(), verified_against: "test" }).collect()) })
        })
    }

    #[test]
    fn the_cache_is_pruned_and_bounded() {
        let r = |b: u32| RoundProvenance { bell: b, round: b as u64, signature_hex: String::new(), source: String::new(), verified_against: "" };
        let mut cache: HashMap<u32, RoundProvenance> = (0..300).map(|b| (b, r(b))).collect();
        prune_cache(&mut cache, 100);
        assert!(cache.keys().all(|b| *b >= 100), "processed bells dropped");
        assert_eq!(cache.len(), MAX_CACHE);
        assert_eq!(*cache.keys().min().unwrap(), 300 - MAX_CACHE as u32, "the lowest go first");
    }

    #[test]
    fn a_stop_before_start_does_nothing() {
        let state = plain();
        let before = lock(&state).transaction_count();
        let (tx, rx) = tokio::sync::watch::channel(true);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(Keeper::new(&state, fake_source(|| panic!("no fetch")), rx));
        assert!(r.is_err());
        assert_eq!(lock(&state).transaction_count(), before, "no airdrop, nothing sent");
        drop(tx);
    }

    #[test]
    fn a_stop_during_a_fetch_sends_nothing() {
        let state = plain();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let tx = std::sync::Arc::new(tx);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let t2 = tx.clone();
            let mut k = Keeper::new(&state, fake_source(move || { let _ = t2.send(true); }), rx).await.unwrap();
            let before = lock(&state).transaction_count();
            assert!(!k.tick(&state).await);
            assert_eq!(k.status.stopped.as_deref(), Some("stopped by request"));
            assert_eq!(k.status.anchors_posted, 0);
            assert_eq!(lock(&state).transaction_count(), before, "no submission after the stop");
        });
    }

    #[test]
    fn a_submission_that_does_not_land_is_unknown_and_never_resent() {
        let state = plain(); // no ticker: nothing ever lands
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut k = Keeper::new(&state, fake_source(|| {}), keep_rx()).await.unwrap();
            k.land_timeout = Duration::from_millis(500);
            assert!(!k.tick(&state).await);
            let sig = k.status.unknown_signature.clone().expect("the signature of the submitted transaction");
            assert!(k.status.stopped.as_deref().unwrap().contains("outcome unknown"), "{:?}", k.status);
            assert!(k.status.json().to_string().contains(&sig));
            let pending = lock(&state).pending();
            assert!(!k.tick(&state).await, "stays stopped");
            assert_eq!(lock(&state).pending(), pending, "never resent");
        });
    }

    /// A valid BellAnchor of (`bell`, `region`) landed at `a_ts`.
    fn put_anchor(state: &Shared, a: &Addresses, bell: u32, region: u8, owner: Address, a_ts: i64) {
        use frontier_abi::layout::beacon::bell_anchor as BA;
        let mut d = vec![0u8; K2::BellAnchor.size()];
        assert!(write_header(&mut d, K2::BellAnchor, SEASON_ID));
        d[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        d[BA::REGION] = region;
        d[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        lock(state).set_account(a.anchor(bell, region), fclient::ports::Account { lamports: 1_000_000, data: d, owner, executable: false }).unwrap();
    }
    /// The plain chain with the home's bells 10..12 anchored (so the home
    /// step sends nothing) and a Departed transit of `holding` arriving at 11.
    fn plain_with_arrival(holding: Address) -> (Shared, Addresses, u8) {
        let state = plain();
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let region = { let c = lock(&state); lk::view(&c, &a, 128, 0).unwrap().region };
        for b in 10..13 {
            put_anchor(&state, &a, b, region, a.program, 1);
        }
        let ctx = frontier_abi::addr::AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() };
        let rec = crate::local_keeper::test_transit_record(&a, 0, 11);
        let at = Address::new_from_array(frontier_abi::world_index::march::transit_address(&ctx, &holding.to_bytes(), 0));
        lock(&state).set_account(at, fclient::ports::Account { lamports: 1_000_000, data: rec, owner: a.program, executable: false }).unwrap();
        (state, a, region)
    }

    #[test]
    fn a_destination_batch_that_does_not_land_is_unknown_and_the_rest_wait() {
        let holding = Address::new_from_array([5; 32]);
        let (state, a, region) = plain_with_arrival(holding);
        // partial: region 0 (and the home's) are already anchored at bell 11
        put_anchor(&state, &a, 11, 0, a.program, 1);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut k = Keeper::new(&state, fake_source(|| {}), keep_rx()).await.unwrap();
            k.watch_holding(holding);
            k.land_timeout = Duration::from_millis(500);
            let before = lock(&state).pending();
            assert!(!k.tick(&state).await, "the unknown outcome stops the keeper");
            let why = k.status.stopped.clone().unwrap();
            // the first batch names the absent regions only, ascending, at most seven
            let absent: Vec<u8> = (0..16u8).filter(|r| *r != 0 && *r != region).collect();
            let first = absent.iter().take(7).fold(0u16, |m, r| m | (1 << r));
            assert!(why.contains(&format!("PostAnchorMulti(bell 11, regions {first:#06x})")) && why.contains("outcome unknown"), "{why}");
            assert!(k.status.unknown_signature.is_some());
            assert_eq!(lock(&state).pending(), before + 1, "one batch sent; the second waits");
            assert_eq!((k.status.anchors_posted, k.status.dest_anchors_posted), (0, 0));
            assert!(!k.tick(&state).await, "stays stopped");
            assert_eq!(lock(&state).pending(), before + 1, "never resent");
        });
    }

    #[test]
    fn a_foreign_account_at_a_destination_anchor_stops_the_keeper() {
        let holding = Address::new_from_array([5; 32]);
        let (state, a, _) = plain_with_arrival(holding);
        put_anchor(&state, &a, 11, 4, Address::new_from_array([9; 32]), 1);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut k = Keeper::new(&state, fake_source(|| panic!("no fetch before the plan is valid")), keep_rx()).await.unwrap();
            k.watch_holding(holding);
            let before = lock(&state).pending();
            assert!(!k.tick(&state).await);
            let why = k.status.stopped.clone().unwrap();
            assert!(why.starts_with("destination anchors:") && why.contains("not that anchor"), "{why}");
            assert_eq!(lock(&state).pending(), before, "nothing sent");
        });
    }

    #[test]
    fn a_fast_forward_batch_fits_the_packet() {
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let payer = Keypair::new();
        let v = lk::HomeView { resolved_next: 10, bell_now: 100, region: 3 };
        let full = lk::fast_forward_ix(&a, &payer.pubkey(), 128, 0, &v, 10 + lk::MAX_FAST_FORWARD_BELLS).unwrap();
        let n = lk::encoded_len(&[full], &payer).unwrap();
        assert!(n <= lk::PACKET_BYTES, "{n} bytes");
        assert!(lk::fast_forward_ix(&a, &payer.pubkey(), 128, 0, &v, 11 + lk::MAX_FAST_FORWARD_BELLS).is_err(), "one more bell is refused");
    }

    /// Real network + artifact: a backlog longer than one batch (20 bells) is
    /// advanced by successive FastForwards until the home is resident.
    #[test]
    #[ignore]
    fn a_long_backlog_is_advanced_in_packet_safe_batches() {
        assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
        let art = artifact();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (p, q) = ports(41_970 + 2);
            let play = launch(&art, Keypair::new().pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let mut k = Keeper::new(&state, public_quicknet(), keep_rx()).await.unwrap();
            let clock = { let c = lock(&state); lk::season_clock(&c, &k.a).unwrap() };
            advance(&state, clock.genesis_ts + 600 * 31 + 5); // bells 10..30 ended: 21 bells
            // each round: a tick anchors up to one batch, the test chain's clock
            // moves until those windows close, the next tick fast-forwards
            for _ in 0..8 {
                assert!(k.tick(&state).await, "{:?}", k.status);
                if k.status.resident == Some(true) && k.status.fast_forwards >= 2 { break; }
                let closed = {
                    let c = lock(&state);
                    let v = lk::view(&c, &k.a, 128, 0).unwrap();
                    let mut end = v.resolved_next;
                    while end < v.resolved_next + lk::MAX_FAST_FORWARD_BELLS && lk::anchor_landed(&c, &k.a, end, v.region).unwrap().is_some() { end += 1; }
                    (end > v.resolved_next).then(|| lk::reveal_closed_at(&c, &k.a, v.region, v.resolved_next..end).unwrap())
                };
                if let Some(t) = closed { advance(&state, t + 1); }
            }
            assert!(k.status.fast_forwards >= 2, "{:?}", k.status);
            assert_eq!(k.status.resident, Some(true), "{:?}", k.status);
            eprintln!("{}", k.status.json());
            play.running.stop();
        });
    }


    /// A stop that arrives while the keeper waits for the chain lock: once
    /// the lock is free, neither the faucet nor a submission happens.
    #[test]
    fn a_stop_while_waiting_for_the_lock_funds_and_sends_nothing() {
        let state = plain();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        // funding
        let (tx, rx) = tokio::sync::watch::channel(false);
        let before = lock(&state).transaction_count();
        let guard = lock(&state);
        let s2 = state.clone();
        let task = rt.spawn(async move { Keeper::new(&s2, fake_source(|| {}), rx).await.map(|_| ()) });
        std::thread::sleep(Duration::from_millis(200)); // the task is now waiting for the lock
        tx.send(true).unwrap();
        drop(guard);
        assert_eq!(rt.block_on(task).unwrap(), Err("stopped before funding".into()));
        assert_eq!(lock(&state).transaction_count(), before, "no airdrop");
        // submission
        let payer = Keypair::new();
        lock(&state).airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let pending = lock(&state).pending();
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let ix = lk::fast_forward_ix(&a, &payer.pubkey(), 128, 0, &lk::HomeView { resolved_next: 10, bell_now: 13, region: 3 }, 11).unwrap();
        let guard = lock(&state);
        let s2 = state.clone();
        let task = rt.spawn(async move { submit_and_wait(&s2, &payer, ix, "FastForward(to 11)", Duration::from_secs(5), &mut rx).await });
        std::thread::sleep(Duration::from_millis(200));
        tx.send(true).unwrap();
        drop(guard);
        let sent = rt.block_on(task).unwrap();
        assert_eq!(sent, Sent::Failed("FastForward(to 11): stopped by request before sending".into()));
        assert_eq!(lock(&state).pending(), pending, "nothing submitted");
    }


    #[test]
    fn a_pilot_stopped_before_start_funds_nothing() {
        let state = plain();
        let before = lock(&state).transaction_count();
        let (tx, rx) = tokio::sync::watch::channel(true);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(Pilot::new(&state, fake_source(|| panic!("no fetch")), Some(Address::new_from_array([3; 32])), rx));
        assert!(r.is_err());
        assert_eq!(lock(&state).transaction_count(), before);
        drop(tx);
    }

    /// Real artifact + public drand: a real signed Depart, then ONLY pilot
    /// ticks (the test chain's clock moved with the node's scale control):
    /// the keeper anchors, waits on the not-quiet departure bell, the origin
    /// driver resolves and settles it, the keeper fast-forwards: resident.
    #[test]
    #[ignore]
    fn a_pilot_carries_a_real_departure_through_its_origin_to_residency() {
        assert_eq!(std::env::var("WYLLS_PUBLIC_DRAND").as_deref(), Ok("1"), "reads the public drand API");
        let art = artifact();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (p, q) = ports(41_910);
            let player = Keypair::new();
            let play = launch(&art, player.pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let b0 = crate::origin_driver::real_origin::real_depart(&state, &play.fixture, &player);
            let mut pilot = Pilot::new(&state, public_quicknet(), Some(play.fixture.holding), keep_rx()).await.unwrap();
            let clock = { let c = lock(&state); lk::season_clock(&c, &pilot.keeper.a).unwrap() };
            advance(&state, clock.genesis_ts + 600 * (b0 as i64 + 1) + 5);
            let mut steps: Vec<String> = vec![];
            let mut saw_blocked = false;
            for _ in 0..40 {
                assert!(pilot.tick(&state).await, "{:?}", pilot.keeper.status);
                saw_blocked |= pilot.keeper.status.blocked.is_some();
                if let Some(s) = pilot.keeper.status.origin_step.clone() {
                    if steps.last() != Some(&s) { steps.push(s); }
                }
                let st = &pilot.keeper.status;
                if st.resident == Some(true) && st.resolved_next.unwrap_or(0) > b0 && st.blocked.is_none() && steps.iter().any(|s| s.contains("SettleOrigin")) {
                    break;
                }
                let now = lock(&state).unix_timestamp();
                advance(&state, now + 120);
            }
            eprintln!("{}", pilot.keeper.status.json());
            assert!(saw_blocked, "FastForward waited on the departure bell");
            for k in ["GatherClash", "PostSeed", "ResolveFromInputs", "SettleOrigin"] {
                assert!(steps.iter().any(|s| s.contains(k)), "{k} in {steps:?}");
            }
            assert_eq!(pilot.keeper.status.resident, Some(true), "{:?}", pilot.keeper.status);
            assert!(pilot.keeper.status.resolved_next.unwrap() > b0);
            play.running.stop();
        });
    }

}

#[cfg(test)]
mod pair_tests {
    use super::*;
    fn st(unknown: bool) -> Status { Status { unknown_signature: unknown.then(|| "sig".to_string()), ..Status::default() } }
    #[test]
    fn one_village_is_never_stopped_by_the_pair_rule() {
        assert!(!pair_must_halt(&st(true), &[]), "a single village keeps its own rules (unchanged)");
        assert!(!pair_must_halt(&st(false), &[]));
    }
    #[test]
    fn an_unknown_anywhere_in_a_pair_halts_the_whole_loop() {
        assert!(!pair_must_halt(&st(false), &[&st(false)]), "both clean: runs");
        assert!(pair_must_halt(&st(true), &[&st(false)]), "the first village's unknown (e.g. a shared province's Resolve) stops the second too");
        assert!(pair_must_halt(&st(false), &[&st(true)]), "the second village's unknown stops the first");
        assert!(pair_must_halt(&st(false), &[&st(false), &st(true)]));
    }
    // ---- the real sequencer (`run_steps`) with counting steps: what is CALLED (= could send) after an Unknown
    use std::sync::{Arc, Mutex};
    struct Mock { name: &'static str, field: Field, out: Out, log: Arc<Mutex<Vec<&'static str>>> }
    impl TickStep for Mock {
        fn run<'a>(&'a mut self, _state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>> {
            Box::pin(async move { self.log.lock().unwrap().push(self.name); Report { field: self.field, out: self.out.clone(), text: self.name.into() } })
        }
    }
    fn unk() -> Out { Out::Unknown { signature: "sig".into(), why: "not seen".into() } }
    fn state() -> Shared { std::sync::Arc::new(std::sync::Mutex::new(localnet::Chain::new(localnet::Config::default()))) }
    /// One village's steps in the loop's order: keeper, legacy (destination field), resident, origin.
    fn village(tag: &'static [&'static str; 4], outs: [Out; 4], log: &Arc<Mutex<Vec<&'static str>>>) -> Vec<Mock> {
        let f = [Field::Keeper, Field::Destination, Field::Resident, Field::Origin];
        (0..4).map(|i| Mock { name: tag[i], field: f[i], out: outs[i].clone(), log: log.clone() }).collect()
    }
    async fn pass(ms: &mut [Mock], pair: bool) -> RunOut {
        let st = state();
        let mut steps: Vec<&mut dyn TickStep> = ms.iter_mut().map(|m| m as &mut dyn TickStep).collect();
        run_steps(&st, &mut steps, pair).await
    }
    const A: [&str; 4] = ["A keeper", "A legacy", "A resident", "A origin"];
    const B: [&str; 4] = ["B keeper", "B legacy", "B resident", "B origin"];
    #[tokio::test]
    async fn pair_a_legacy_unknown_calls_nothing_after_it_in_a_or_b() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = village(&A, [Out::Quiet, unk(), Out::Landed, Out::Landed], &log);
        let r = pass(&mut a, true).await;
        assert!(matches!(r.stopped.as_ref().map(|s| &s.out), Some(Out::Unknown { .. })));
        assert_eq!(*log.lock().unwrap(), vec!["A keeper", "A legacy"], "A resident and A origin are never called");
        // the Pilot applies the report and the pair rule sees it before B (and before the next keeper)
        let first = Status { unknown_signature: Some("sig".into()), ..Status::default() };
        assert!(pair_must_halt(&first, &[&Status::default()]), "B is not ticked; nor is the next pass's keeper");
    }
    #[tokio::test]
    async fn pair_b_legacy_unknown_calls_nothing_after_it() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = village(&A, [Out::Quiet, Out::Quiet, Out::Quiet, Out::Quiet], &log);
        assert!(pass(&mut a, true).await.stopped.is_none());
        let mut b = village(&B, [Out::Landed, unk(), Out::Landed, Out::Landed], &log);
        let r = pass(&mut b, true).await;
        assert!(r.stopped.is_some());
        assert_eq!(log.lock().unwrap().iter().filter(|n| n.starts_with('B')).copied().collect::<Vec<_>>(), vec!["B keeper", "B legacy"], "B resident and B origin are never called");
        assert!(pair_must_halt(&Status::default(), &[&Status { unknown_signature: Some("sig".into()), ..Status::default() }]), "A's next pass is not run");
    }
    #[tokio::test]
    async fn pair_keeper_unknown_calls_no_driver() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = village(&A, [unk(), Out::Landed, Out::Landed, Out::Landed], &log);
        let r = pass(&mut a, true).await;
        assert_eq!(*log.lock().unwrap(), vec!["A keeper"]);
        assert_eq!(r.stopped.unwrap().field, Field::Keeper);
    }
    // ---- the full loop: the real `orchestrate` over mock villages whose passes are the real `run_steps`
    struct MockVillage { steps: Vec<Mock>, status: Status, ended: bool }
    impl PassVillage for MockVillage {
        fn pass<'a>(&'a mut self, state: &'a Shared, pair: bool) -> Pin<Box<dyn Future<Output = RunOut> + Send + 'a>> {
            Box::pin(async move { let mut steps: Vec<&mut dyn TickStep> = self.steps.iter_mut().map(|m| m as &mut dyn TickStep).collect(); run_steps(state, &mut steps, pair).await })
        }
        fn record(&mut self, r: &RunOut) {
            for rep in &r.reports { if let Out::Unknown { signature, .. } = &rep.out { self.status.unknown_signature = Some(signature.clone()); } }
            if let Some(stop) = &r.stopped { if stop.field == Field::Origin || stop.field == Field::Keeper { self.status.stopped = Some("ended".into()); } }
        }
        fn status(&self) -> &Status { &self.status }
        fn halt(&mut self, why: String) { self.status.stopped = Some(why); }
        fn ended(&self) -> bool { self.ended }
        fn end(&mut self) { self.ended = true; }
    }
    fn mv(tag: &'static [&'static str; 4], outs: [Out; 4], log: &Arc<Mutex<Vec<&'static str>>>) -> MockVillage { MockVillage { steps: village(tag, outs, log), status: Status::default(), ended: false } }
    async fn loop_pass(st: &Shared, a: &mut MockVillage, b: &mut MockVillage) -> bool {
        let mut rest: Vec<&mut dyn PassVillage> = vec![b as &mut dyn PassVillage];
        orchestrate(st, a, &mut rest).await.0
    }
    fn calls(log: &Arc<Mutex<Vec<&'static str>>>, who: char) -> usize { log.lock().unwrap().iter().filter(|n| n.starts_with(who)).count() }
    #[tokio::test]
    async fn full_loop_a_unknown_means_b_is_never_called() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        let mut a = mv(&A, [Out::Quiet, unk(), Out::Quiet, Out::Quiet], &log);
        let mut b = mv(&B, [Out::Quiet, Out::Landed, Out::Landed, Out::Landed], &log);
        assert!(!loop_pass(&st, &mut a, &mut b).await, "the loop stops");
        assert_eq!(calls(&log, 'B'), 0, "B: 0 calls");
        assert_eq!(*log.lock().unwrap(), vec!["A keeper", "A legacy"], "nothing of A after its unknown either");
        assert!(b.ended && b.status.stopped.is_some() && a.status.stopped.is_some(), "both halted");
    }
    #[tokio::test]
    async fn full_loop_b_unknown_means_the_next_pass_runs_no_keeper() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        let mut a = mv(&A, [Out::Quiet, Out::Quiet, Out::Quiet, Out::Quiet], &log);
        let mut b = mv(&B, [Out::Quiet, unk(), Out::Landed, Out::Landed], &log);
        assert!(!loop_pass(&st, &mut a, &mut b).await);
        assert_eq!(calls(&log, 'B'), 2, "B keeper and B legacy only");
        let before = calls(&log, 'A');
        // the next pass (a caller that did not stop): A's keeper is not called again, nor anything else
        assert!(!loop_pass(&st, &mut a, &mut b).await);
        assert_eq!(calls(&log, 'A'), before, "A keeper: +0");
        assert_eq!(calls(&log, 'B'), 2, "B: +0");
    }
    #[tokio::test]
    async fn full_loop_an_unknown_already_known_means_zero_calls() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        let mut a = mv(&A, [Out::Landed, Out::Landed, Out::Landed, Out::Landed], &log);
        let mut b = mv(&B, [Out::Landed, Out::Landed, Out::Landed, Out::Landed], &log);
        a.status.unknown_signature = Some("earlier".into());
        assert!(!loop_pass(&st, &mut a, &mut b).await);
        assert!(log.lock().unwrap().is_empty(), "no step of any village is called");
        let (log2, mut a2) = (Arc::new(Mutex::new(vec![])), mv(&A, [Out::Landed, Out::Landed, Out::Landed, Out::Landed], &Arc::new(Mutex::new(vec![]))));
        let mut b2 = mv(&B, [Out::Landed, Out::Landed, Out::Landed, Out::Landed], &log2);
        b2.status.unknown_signature = Some("earlier".into());
        assert!(!loop_pass(&st, &mut a2, &mut b2).await);
        assert!(log2.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn full_loop_two_clean_villages_both_run_and_one_village_keeps_old_rules() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        let mut a = mv(&A, [Out::Landed, Out::Quiet, Out::Quiet, Out::Quiet], &log);
        let mut b = mv(&B, [Out::Quiet, Out::Quiet, Out::Quiet, Out::Landed], &log);
        let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b as &mut dyn PassVillage];
        assert_eq!(orchestrate(&st, &mut a, &mut rest).await, (true, true));
        assert_eq!(log.lock().unwrap().len(), 8);
        // one village, a destination unknown: the old rule (that driver only; the loop goes on)
        let log1 = Arc::new(Mutex::new(vec![]));
        let mut solo = mv(&A, [Out::Quiet, unk(), Out::Quiet, Out::Quiet], &log1);
        assert_eq!(orchestrate(&st, &mut solo, &mut []).await.0, true);
        assert_eq!(log1.lock().unwrap().len(), 4);
    }
    #[tokio::test]
    async fn one_village_keeps_the_old_rules() {
        // a legacy (destination) Unknown ends that driver only: resident and origin still run, as before
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = village(&A, [Out::Quiet, unk(), Out::Quiet, Out::Quiet], &log);
        let r = pass(&mut a, false).await;
        assert!(r.stopped.is_none()); assert_eq!(log.lock().unwrap().len(), 4);
        // the origin's Unknown or Stopped ends the pass; the keeper's end too
        for out in [unk(), Out::Stopped("refused".into())] {
            let log = Arc::new(Mutex::new(vec![]));
            let mut a = village(&A, [Out::Quiet, Out::Quiet, Out::Quiet, out], &log);
            assert_eq!(pass(&mut a, false).await.stopped.unwrap().field, Field::Origin);
        }
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = village(&A, [Out::Stopped("cannot read".into()), Out::Landed, Out::Landed, Out::Landed], &log);
        assert!(pass(&mut a, false).await.stopped.is_some()); assert_eq!(*log.lock().unwrap(), vec!["A keeper"]);
    }
    #[tokio::test]
    async fn a_refusal_before_sending_ends_only_that_driver_even_in_a_pair() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut b = village(&B, [Out::Quiet, Out::Stopped("simulation refused".into()), Out::Quiet, Out::Quiet], &log);
        let r = pass(&mut b, true).await;
        assert!(r.stopped.is_none(), "nothing was sent by a refusal: the pass goes on"); assert_eq!(log.lock().unwrap().len(), 4);
    }
    #[test]
    fn apply_records_the_signature_and_the_origins_end() {
        // (pure part of the Pilot: a report's Unknown leaves the signature the pair rule reads)
        let r = RunOut { reports: vec![Report { field: Field::Destination, out: unk(), text: "x".into() }], landed: false, stopped: None };
        let mut st = Status::default();
        for rep in &r.reports { if let Out::Unknown { signature, .. } = &rep.out { st.unknown_signature = Some(signature.clone()); } }
        assert_eq!(st.unknown_signature.as_deref(), Some("sig"));
        let src = include_str!("keeper_loop.rs");
        assert!(src.contains("if rep.field != Field::Keeper {\n            if let Out::Unknown { signature, .. } = &rep.out { keeper.status.unknown_signature = Some(signature.clone()); }"));
    }
    #[test]
    fn a_second_villages_status_line_says_which_village_and_the_first_is_unchanged() {
        let first = Status::default().json();
        assert!(first.get("village").is_none(), "the one-village line has no new key");
        let second = Status { village: Some(2), ..Status::default() }.json();
        assert_eq!(second["village"], json!(2));
        assert_eq!(first.as_object().unwrap().len() + 1, second.as_object().unwrap().len());
    }
    // ---- the TEST-ONLY demo's bounded run of steps per driver per pass (round 11, 2026-11-14)
    struct Seq { name: &'static str, field: Field, outs: std::collections::VecDeque<Out>, log: Arc<Mutex<Vec<&'static str>>> }
    impl TickStep for Seq {
        fn run<'a>(&'a mut self, _state: &'a Shared) -> Pin<Box<dyn Future<Output = Report> + Send + 'a>> {
            Box::pin(async move { self.log.lock().unwrap().push(self.name); let out = self.outs.pop_front().unwrap_or(Out::Quiet); Report { field: self.field, out, text: self.name.into() } })
        }
    }
    fn seq_village(tag: &'static [&'static str; 4], outs: [Vec<Out>; 4], log: &Arc<Mutex<Vec<&'static str>>>) -> Vec<Seq> {
        let f = [Field::Keeper, Field::Destination, Field::Resident, Field::Origin];
        outs.into_iter().enumerate().map(|(i, o)| Seq { name: tag[i], field: f[i], outs: o.into(), log: log.clone() }).collect()
    }
    async fn seq_pass(ms: &mut [Seq], pair: bool, per: u32) -> RunOut {
        let st = state();
        let mut steps: Vec<&mut dyn TickStep> = ms.iter_mut().map(|m| m as &mut dyn TickStep).collect();
        run_steps_bounded(&st, &mut steps, pair, per).await
    }
    fn count(log: &Arc<Mutex<Vec<&'static str>>>, name: &str) -> usize { log.lock().unwrap().iter().filter(|n| **n == name).count() }
    #[allow(non_snake_case)] fn L() -> Out { Out::Landed }
    #[test]
    fn the_demo_takes_a_bounded_run_and_natural_play_one_step() {
        assert_eq!(steps_per_pass(Pace::Natural), 1);
        assert_eq!(steps_per_pass(DEMO_PACE), DEMO_STEPS_PER_PASS);
        assert_eq!(DEMO_STEPS_PER_PASS, 4, "Gather → Seed → Resolve of a contested turn, plus one");
        let src = include_str!("keeper_loop.rs");
        assert_eq!(src.matches(concat!("p.per_step = ", "steps_per_pass(pace);")).count(), 1, "set only from the loop's pace");
        assert!(src.contains("Ok(Pilot { keeper, origin, destination, resident, legacy, landed: false, others: vec![], per_step: 1 })"), "every Pilot starts at one step");
        assert!(src.contains("ended: false, per_step: self.per_step });"), "an added village takes the loop's budget");
    }
    #[tokio::test]
    async fn a_driver_runs_while_it_lands_up_to_the_budget_then_the_next_step() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = seq_village(&A, [vec![L()], vec![L(), L(), L(), L(), L(), L()], vec![L()], vec![]], &log);
        let r = seq_pass(&mut a, false, 4).await;
        assert!(r.landed && r.stopped.is_none());
        assert_eq!(count(&log, "A keeper"), 1, "the keeper never runs twice in a pass");
        assert_eq!(count(&log, "A legacy"), 4, "bounded: 4, though it could land more");
        assert_eq!(count(&log, "A resident"), 2, "landed once, then quiet: 2 calls");
        assert_eq!(count(&log, "A origin"), 1);
        assert_eq!(*log.lock().unwrap(), vec!["A keeper", "A legacy", "A legacy", "A legacy", "A legacy", "A resident", "A resident", "A origin"], "in order: never two at once");
    }
    #[tokio::test]
    async fn a_wait_or_a_refusal_ends_the_run_and_one_step_is_the_old_pass() {
        let log = Arc::new(Mutex::new(vec![]));
        let mut a = seq_village(&A, [vec![], vec![L(), Out::Quiet, L()], vec![L(), Out::Stopped("refused".into()), L()], vec![]], &log);
        seq_pass(&mut a, false, 4).await;
        assert_eq!(count(&log, "A legacy"), 2, "landed, then a wait: ends");
        assert_eq!(count(&log, "A resident"), 2, "landed, then a refusal: ends");
        let log1 = Arc::new(Mutex::new(vec![]));
        let mut b = seq_village(&A, [vec![L()], vec![L(), L()], vec![L(), L()], vec![L(), L()]], &log1);
        seq_pass(&mut b, false, 1).await;
        assert_eq!(log1.lock().unwrap().len(), 4, "natural play: one call each, exactly as before");
    }
    #[tokio::test]
    async fn pair_an_unknown_inside_a_run_calls_nothing_after_it() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        struct SeqVillage { steps: Vec<Seq>, status: Status, ended: bool, per: u32 }
        impl PassVillage for SeqVillage {
            fn pass<'a>(&'a mut self, state: &'a Shared, pair: bool) -> Pin<Box<dyn Future<Output = RunOut> + Send + 'a>> {
                Box::pin(async move { let per = self.per; let mut steps: Vec<&mut dyn TickStep> = self.steps.iter_mut().map(|m| m as &mut dyn TickStep).collect(); run_steps_bounded(state, &mut steps, pair, per).await })
            }
            fn record(&mut self, r: &RunOut) { for rep in &r.reports { if let Out::Unknown { signature, .. } = &rep.out { self.status.unknown_signature = Some(signature.clone()); } } }
            fn status(&self) -> &Status { &self.status }
            fn halt(&mut self, why: String) { self.status.stopped = Some(why); }
            fn ended(&self) -> bool { self.ended }
            fn end(&mut self) { self.ended = true; }
        }
        let mut a = SeqVillage { steps: seq_village(&A, [vec![], vec![L(), unk(), L(), L()], vec![L()], vec![L()]], &log), status: Status::default(), ended: false, per: 4 };
        let mut b = SeqVillage { steps: seq_village(&B, [vec![L()], vec![L(), L()], vec![L()], vec![L()]], &log), status: Status::default(), ended: false, per: 4 };
        { let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b as &mut dyn PassVillage]; assert!(!orchestrate(&st, &mut a, &mut rest).await.0, "the whole pair loop stops"); }
        assert_eq!(*log.lock().unwrap(), vec!["A keeper", "A legacy", "A legacy"], "nothing after the unknown: not A's run, not A resident/origin, not B");
        assert!(a.status.stopped.is_some() && b.status.stopped.is_some() && b.ended);
        { let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b as &mut dyn PassVillage]; assert!(!orchestrate(&st, &mut a, &mut rest).await.0); }
        assert_eq!(log.lock().unwrap().len(), 3, "the next pass calls nothing");
        // B's unknown inside its run: the same, and A's next pass is not run
        let (log2, st2) = (Arc::new(Mutex::new(vec![])), state());
        let mut a2 = SeqVillage { steps: seq_village(&A, [vec![], vec![L()], vec![], vec![]], &log2), status: Status::default(), ended: false, per: 4 };
        let mut b2 = SeqVillage { steps: seq_village(&B, [vec![], vec![L(), L(), unk(), L()], vec![L()], vec![L()]], &log2), status: Status::default(), ended: false, per: 4 };
        { let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b2 as &mut dyn PassVillage]; assert!(!orchestrate(&st2, &mut a2, &mut rest).await.0); }
        assert_eq!(count(&log2, "B legacy"), 3); assert_eq!(count(&log2, "B resident") + count(&log2, "B origin"), 0);
        let before = log2.lock().unwrap().len();
        { let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b2 as &mut dyn PassVillage]; assert!(!orchestrate(&st2, &mut a2, &mut rest).await.0); }
        assert_eq!(log2.lock().unwrap().len(), before, "A's next pass: 0 calls");
    }
    #[tokio::test]
    async fn two_villages_each_get_their_run_in_one_pass() {
        let (st, log) = (state(), Arc::new(Mutex::new(vec![])));
        let mut a = mv(&A, [Out::Quiet, Out::Landed, Out::Quiet, Out::Quiet], &log);
        let mut b = mv(&B, [Out::Quiet, Out::Landed, Out::Quiet, Out::Quiet], &log);
        // (the mock villages' passes are the real run_steps — one step each; the bounded run is per driver, so with the
        //  budget both villages' drivers get the same bounded run in the same pass: neither is starved)
        let mut ms_a = seq_village(&A, [vec![], vec![L(); 8], vec![], vec![]], &log);
        let mut ms_b = seq_village(&B, [vec![], vec![L(); 8], vec![], vec![]], &log);
        seq_pass(&mut ms_a, true, 4).await; seq_pass(&mut ms_b, true, 4).await;
        assert_eq!(count(&log, "A legacy"), 4); assert_eq!(count(&log, "B legacy"), 4);
        let mut rest: Vec<&mut dyn PassVillage> = vec![&mut b as &mut dyn PassVillage];
        assert_eq!(orchestrate(&st, &mut a, &mut rest).await, (true, true));
    }
}
