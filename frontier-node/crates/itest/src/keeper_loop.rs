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
}
impl Status {
    pub fn json(&self) -> Value {
        json!({"schema": SCHEMA, "running": self.running, "resolved_next": self.resolved_next, "bell": self.bell, "resident": self.resident,
            "anchors_posted": self.anchors_posted, "dest_anchors_posted": self.dest_anchors_posted, "fast_forwards": self.fast_forwards, "rounds_cached": self.rounds_cached,
            "last_action": self.last_action, "last_error": self.last_error, "stopped": self.stopped, "unknown_signature": self.unknown_signature, "blocked": self.blocked, "origin_step": self.origin_step, "destination_step": self.destination_step, "resident_step": self.resident_step})
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
            Some(h) => {
                let payer = fund_fresh(state, &mut stop).await?;
                let dest_payer = fund_fresh(state, &mut stop).await?;
                let resident_payer = fund_fresh(state, &mut stop).await?;
                // (a legacy village — its Holding decodes as one, program-owned — marches the ordinary way: the
                //  legacy march driver instead of the wide destination driver; a wide holding is as before)
                let legacy_ref = crate::legacy_march::legacy_village(&lock(state), &keeper.a, &h);
                let (destination, legacy) = match legacy_ref {
                    Some(href) => (None, Some(crate::legacy_march::LegacyMarchDriver::new(href, dest_payer, stop.clone()))),
                    None => (Some(crate::destination_driver::DestinationDriver::new(h, dest_payer, stop.clone())), None),
                };
                (Some(crate::origin_driver::OriginDriver::new_at(h, home, payer, stop.clone())), destination,
                    Some(crate::resident_bells::ResidentBells::new(h, resident_payer, stop)), legacy)
            }
            None => (None, None, None, None),
        };
        Ok(Pilot { keeper, origin, destination, resident, legacy, landed: false })
    }

    /// One pass; false once stopped.
    pub async fn tick(&mut self, state: &Shared) -> bool {
        self.landed = false;
        let before = (self.keeper.status.anchors_posted, self.keeper.status.fast_forwards);
        let alive = self.keeper.tick(state).await;
        self.landed = (self.keeper.status.anchors_posted, self.keeper.status.fast_forwards) != before;
        if !alive {
            return false;
        }
        // every tick (not only while FastForward waits): a departure's
        // SettleOrigin falls due AFTER its bell is resolved and quiet again.
        // The driver sends at most one transaction and nothing when there is
        // nothing to do (Quiet / Wait).
        // the destination driver: at most one transaction per tick; its own
        // stop or unknown outcome ends it alone (reported, never resent)
        if let Some(d) = self.destination.as_mut() {
            if d.terminal().is_none() {
                let step = d.step(state).await;
                self.landed |= matches!(step, crate::destination_driver::Step::Landed(..));
                if let crate::destination_driver::Step::Unknown { signature, .. } = &step {
                    self.keeper.status.unknown_signature = Some(signature.clone());
                }
                self.keeper.status.destination_step = Some(format!("{step:?}"));
            }
        }
        // the legacy march driver (a legacy village only): as the destination driver, one step, reported in its field
        if let Some(d) = self.legacy.as_mut() {
            if d.terminal().is_none() {
                let step = d.step(state).await;
                self.landed |= matches!(step, crate::origin_driver::Step::Landed(..));
                if let crate::origin_driver::Step::Unknown { signature, .. } = &step {
                    self.keeper.status.unknown_signature = Some(signature.clone());
                }
                self.keeper.status.destination_step = Some(format!("{step:?}"));
            }
        }
        // the resident's quiet destination bells: acts only once no transit
        // record of the holding exists (resident_bells module doc), so it never
        // races the origin or destination driver; its stop ends it alone
        if let Some(r) = self.resident.as_mut() {
            if r.terminal().is_none() {
                let step = r.step(state).await;
                self.landed |= matches!(step, crate::resident_bells::Step::Landed(..));
                if let crate::resident_bells::Step::Unknown { signature, .. } = &step {
                    self.keeper.status.unknown_signature = Some(signature.clone());
                }
                self.keeper.status.resident_step = Some(format!("{step:?}"));
            }
        }
        let Some(origin) = self.origin.as_mut() else { return true };
        use crate::origin_driver::Step;
        let step = origin.step(state).await;
        self.landed |= matches!(step, Step::Landed(..));
        self.keeper.status.origin_step = Some(format!("{step:?}"));
        match step {
            Step::Unknown { signature, why } => {
                self.keeper.status.unknown_signature = Some(signature);
                self.keeper.halt(format!("origin: {why}"));
                false
            }
            Step::Stopped(e) => {
                self.keeper.halt(format!("origin: {e}"));
                false
            }
            _ => true,
        }
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
pub async fn run_paced(state: Shared, source: RoundSource, holding: Option<Address>, home: (i16, i16), pace: Pace, mut stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Status)) {
    let mut run = 0u32;
    let mut p = match Pilot::new_at(&state, source, holding, home, stop.clone()).await {
        Ok(p) => p,
        Err(e) => {
            report(&Status { stopped: Some(e), ..Status::default() });
            return;
        }
    };
    let mut last = Status::default();
    loop {
        let alive = p.tick(&state).await;
        if p.keeper.status != last {
            report(&p.keeper.status);
            last = p.keeper.status.clone();
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
