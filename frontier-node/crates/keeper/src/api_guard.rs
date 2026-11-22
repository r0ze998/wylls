//! Admission of externally-triggered work (fix-gw-highs; security audit H-1, H-2).
//!
//! `/v1/reveal` and `/v1/nudge` are reached by anyone on the internet
//! through the herald's `/gw` and the gateway. Before this module a forged
//! reveal cost keeper A two or three paced JSON-RPC calls (the Clock and
//! two `getMultipleAccounts`) on the ONE pacer every duty shares, and a
//! nudge for bell `u32::MAX` made the skip role send a SkipQuiet every bell
//! for the rest of the season. Three layers now stand in front of them:
//!
//! 1. **Zero-RPC admission** ([`Admission`]): the play duty publishes, after
//!    each feed pull, the current bell, the provinces its index knows and
//!    the seal roots of every live DEPART it indexed. A reveal whose
//!    `sha256(commit(plain, salt) ‖ ct_hash)` is not one of those roots (or
//!    whose host / arrival bell differ from the DEPART's) is refused before
//!    any chain read: forging a root needs a sha256 preimage. A nudge past
//!    `now + NUDGE_AHEAD_BELLS` or for a province the index does not know is
//!    refused the same way.
//! 2. **A separate budget for external RPC** ([`ExternalBudget`],
//!    [`BudgetedGate`]): the reveal gate's chain reads take tokens of their
//!    own bucket (by default a fifth of the pacer's rate, at most one check
//!    in flight); empty, the check is not made. The calls still queue on the
//!    shared pacer (one endpoint, one per-IP limit), so external work can
//!    take at most that share of it and never starves tickets, rings,
//!    wide-resolve, expeditions, provinces or sweeps.
//! 3. **Counters and a rate-limited log** of every refusal ([`count`]),
//!    published in `/v1/status` (`api`) and `/metrics`.
//!
//! The play duty also clamps a taken nudge to `now + 1` and lets it expire
//! after [`NUDGE_TTL_BELLS`] (`play.rs`), so even a nudge that slipped past
//! the API (an older keeper's queue, a journal replay) cannot hold a
//! province for the season.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::reveal_accept::{Accepted, Refusal, RevealGate, RevealReq};

/// A nudge may name at most this many bells past the current one (the page
/// sends the province's `resolvedNext` or the current bell; one more covers
/// a clock read a moment behind the browser's).
pub const NUDGE_AHEAD_BELLS: u32 = 2;
/// A taken nudge holds its province at most this many bells (the longest
/// SkipQuiet batch it splits), then the skip role batches as usual.
pub const NUDGE_TTL_BELLS: u32 = 24;
/// Provinces newly nudged per bell at most (play duty; one taken nudge
/// per province per bell).
pub const NUDGE_PER_BELL_MAX: usize = 64;
/// Nudges queued between two ticks at most (one per province is kept).
pub const NUDGE_QUEUE_MAX: usize = 1_024;
/// Reveal material queued between two ticks at most.
pub const REVEAL_QUEUE_MAX: usize = 1_024;
/// JSON-RPC calls one reveal check makes (the Clock and two
/// `getMultipleAccounts`; `reveal_accept::check`).
pub const CALLS_PER_REVEAL_CHECK: f64 = 3.0;
/// The external budget's share of the pacer's rate by default.
pub const EXTERNAL_SHARE: f64 = 0.2;
/// The external budget's burst (two reveal checks).
pub const EXTERNAL_BURST: f64 = 6.0;
/// The external budget's rate when the RPC is unpaced (loopback localnet).
pub const UNPACED_EXTERNAL_PER_SEC: f64 = 30.0;
/// At most one summary line of refusals per this long on stderr.
const LOG_EVERY: Duration = Duration::from_secs(10);

/// What the API may admit without a chain read, as of the last feed pull
/// (published by the play duty).
#[derive(Clone, Debug, Default)]
pub struct Admission {
    /// The play index read the feed to its tip at its last pull (only then
    /// is an unknown seal root or province a refusal).
    pub ready: bool,
    /// The current bell at the last tick's clock.
    pub now_bell: Option<u32>,
    /// Seal root → `(host, arrival bell)` of every indexed DEPART whose
    /// transit is not settled.
    pub seals: Arc<HashMap<[u8; 32], (u64, u32)>>,
    /// Provinces the index knows (`PROVINCE_OPEN` seen).
    pub provinces: Arc<BTreeSet<(i16, i16)>>,
}

/// Why the admission refuses a reveal before any chain read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealCheck {
    /// The material opens a live, indexed DEPART's seal root.
    Indexed,
    /// No indexed DEPART has this root; `ready` says whether that is final.
    Unknown { ready: bool },
    /// A DEPART has this root but another host or arrival bell.
    Mismatch,
}

impl Admission {
    /// The zero-RPC seal check of `req` (§5.11 step 3 against the index).
    pub fn seal(&self, req: &RevealReq) -> SealCheck {
        let p = fclient::seal::unpack(&req.plain);
        let commit = fclient::seal::commit(&req.plain, &req.salt);
        let root = fclient::seal::seal_root(&commit, &req.ct_hash);
        match self.seals.get(&root) {
            Some(&(host, arrive)) if host == p.host_id && arrive == p.arrive_bell => {
                SealCheck::Indexed
            }
            Some(_) => SealCheck::Mismatch,
            None => SealCheck::Unknown { ready: self.ready },
        }
    }
}

/// A token bucket of JSON-RPC calls for externally-triggered work, with at
/// most one check in flight.
#[derive(Debug)]
pub struct ExternalBudget {
    pub per_sec: f64,
    pub burst: f64,
    state: Mutex<(f64, Instant, bool)>,
}

impl ExternalBudget {
    pub fn new(per_sec: f64, burst: f64) -> ExternalBudget {
        let burst = burst.max(CALLS_PER_REVEAL_CHECK);
        ExternalBudget {
            per_sec: per_sec.max(0.0),
            burst,
            state: Mutex::new((burst, Instant::now(), false)),
        }
    }

    /// The budget `keeper.toml` asks for: `api_rpc_gap_ms` if set, else
    /// [`EXTERNAL_SHARE`] of the pacer's rate (`rpc_min_gap_ms`), else
    /// [`UNPACED_EXTERNAL_PER_SEC`].
    pub fn for_config(cfg: &crate::config::KeeperConfig) -> ExternalBudget {
        let per_sec = match cfg.api_rpc_gap_ms {
            Some(0) => f64::INFINITY,
            Some(ms) => 1000.0 / ms as f64,
            None => {
                let gap = cfg.rpc_min_gap();
                if gap.is_zero() {
                    UNPACED_EXTERNAL_PER_SEC
                } else {
                    EXTERNAL_SHARE / gap.as_secs_f64()
                }
            }
        };
        ExternalBudget::new(per_sec, EXTERNAL_BURST)
    }

    /// Takes `calls` tokens and the in-flight place, or `false`.
    pub fn try_begin(&self, calls: f64) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let refill = now.duration_since(st.1).as_secs_f64() * self.per_sec;
        st.0 = (st.0 + refill).min(self.burst);
        st.1 = now;
        if st.2 || st.0 < calls {
            return false;
        }
        st.0 -= calls;
        st.2 = true;
        true
    }

    /// Gives the in-flight place back.
    pub fn end(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).2 = false;
    }
}

/// The `KeeperBusy` refusal of an empty external budget (`503`: the
/// gateway answers it as `KeeperUnavailable`, which the page asks again
/// 60 s later, `marchbook.mjs` UNREACHED).
pub fn busy() -> Refusal {
    Refusal {
        http: 503,
        code: "KeeperBusy",
        detail:
            "the keeper's budget for externally-triggered chain reads is spent; ask again later"
                .into(),
    }
}

/// A [`RevealGate`] whose chain reads take [`ExternalBudget`] tokens first.
pub struct BudgetedGate {
    pub inner: Arc<dyn RevealGate>,
    pub budget: Arc<ExternalBudget>,
}

impl RevealGate for BudgetedGate {
    fn check<'a>(
        &'a self,
        req: &'a RevealReq,
    ) -> Pin<Box<dyn Future<Output = Result<Accepted, Refusal>> + Send + 'a>> {
        Box::pin(async move {
            if !self.budget.try_begin(CALLS_PER_REVEAL_CHECK) {
                return Err(busy());
            }
            struct End<'b>(&'b ExternalBudget);
            impl Drop for End<'_> {
                fn drop(&mut self) {
                    self.0.end();
                }
            }
            let _end = End(&self.budget);
            self.inner.check(req).await
        })
    }
}

/// Counters of the API's admissions and refusals (`/v1/status` `api`,
/// `/metrics` `keeper_api_total{event}`), and when the last summary was
/// logged.
#[derive(Debug, Default)]
pub struct ApiCounters {
    pub events: BTreeMap<String, u64>,
    pub logged: Option<Instant>,
    pub logged_events: BTreeMap<String, u64>,
}

/// Counts `event`; a refusal (`refused == true`) may log one summary line
/// (at most every [`LOG_EVERY`]) with the counts since the last line.
pub fn count(c: &mut ApiCounters, event: &str, refused: bool) {
    *c.events.entry(event.to_string()).or_insert(0) += 1;
    if !refused {
        return;
    }
    let now = Instant::now();
    if c.logged.is_some_and(|t| now.duration_since(t) < LOG_EVERY) {
        return;
    }
    let delta: Vec<String> = c
        .events
        .iter()
        .filter(|(k, _)| k.contains("refused") || k.contains("busy"))
        .filter_map(|(k, v)| {
            let d = v - c.logged_events.get(k).copied().unwrap_or(0);
            (d > 0).then(|| format!("{k}={d}"))
        })
        .collect();
    eprintln!(
        "frontier-keeper: api refusals since last line: {}",
        delta.join(" ")
    );
    c.logged = Some(now);
    c.logged_events = c.events.clone();
}

/// The counters as `/v1/status` lists them.
pub fn status(c: &ApiCounters) -> serde_json::Value {
    serde_json::json!(c.events)
}

/// The counters in Prometheus text.
pub fn metrics(c: &ApiCounters) -> String {
    let mut m = String::new();
    if !c.events.is_empty() {
        m.push_str("# TYPE keeper_api_total counter\n");
    }
    for (k, v) in &c.events {
        m.push_str(&format!("keeper_api_total{{event=\"{k}\"}} {v}\n"));
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_refuses_when_spent_and_while_a_check_is_in_flight() {
        let b = ExternalBudget::new(0.0, 6.0);
        assert!(b.try_begin(3.0));
        assert!(!b.try_begin(3.0), "one check in flight at most");
        b.end();
        assert!(b.try_begin(3.0));
        b.end();
        assert!(!b.try_begin(3.0), "no refill at rate 0: the burst is spent");
    }

    #[test]
    fn budget_refills_at_its_rate() {
        let b = ExternalBudget::new(1000.0, 3.0);
        assert!(b.try_begin(3.0));
        b.end();
        std::thread::sleep(Duration::from_millis(10));
        assert!(b.try_begin(3.0));
    }

    #[test]
    fn default_budget_is_a_fifth_of_the_pacer() {
        let mut cfg = crate::config::KeeperConfig::new(
            solana_address::Address::new_from_array([1; 32]),
            1,
            solana_address::Address::new_from_array([2; 32]),
        );
        cfg.rpc_min_gap_ms = Some(250);
        let b = ExternalBudget::for_config(&cfg);
        assert!((b.per_sec - 0.8).abs() < 1e-9, "{}", b.per_sec);
        cfg.api_rpc_gap_ms = Some(2000);
        assert!((ExternalBudget::for_config(&cfg).per_sec - 0.5).abs() < 1e-9);
        cfg.api_rpc_gap_ms = None;
        cfg.rpc_min_gap_ms = Some(0);
        assert_eq!(
            ExternalBudget::for_config(&cfg).per_sec,
            UNPACED_EXTERNAL_PER_SEC
        );
    }

    #[test]
    fn counters_publish_in_status_and_metrics() {
        let mut c = ApiCounters::default();
        count(&mut c, "reveal_refused_unindexed", true);
        count(&mut c, "reveal_refused_unindexed", true);
        count(&mut c, "reveal_accepted", false);
        assert_eq!(status(&c)["reveal_refused_unindexed"], 2);
        assert!(metrics(&c).contains("keeper_api_total{event=\"reveal_accepted\"} 1"));
    }
}
