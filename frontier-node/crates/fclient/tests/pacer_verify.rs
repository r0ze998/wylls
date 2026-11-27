//! verify-pr292: independent checks of the per-method `Pacer`
//! (rpc-pacer-per-method) through its public API only, with a fake
//! transport (no sockets):
//!
//!   V1 mixed 429 storms on several methods + 503s, 8 concurrent callers:
//!      every two turns ≥ min_gap apart, and any window W holds
//!      ≤ ⌊W / min_gap⌋ + 1 turns (total rate ≤ 1 / min_gap)
//!   V2 getTransaction answered 429 forever: no getAccountInfo turn waits
//!      anywhere near the 500 ms penalty
//!   V3 a 503 holds back every method (penalty, jitter ≤ 25 %)
//!   V4 per method: doubling from 500 ms, cap, Retry-After floor (capped),
//!      jitter ≤ 25 % of the penalty, reset by the method's own 200 only
//!   V5 PacerScope::Process vs a copy of the pre-PR pacer, serial caller
//!      (herald / verifier shape): the same waits within jitter
//!   V6 PacerScope::Process, concurrent callers (keeper shape): a 429 holds
//!      back every method immediately (the old pacer queued the penalty
//!      behind the turns already waiting; documented difference)
//!   V7 throttle log: one line per method per minute (`--nocapture`)
//!   V8 `Pacer::new` reads FCLIENT_PACER_SCOPE (`process` only)
use fclient::rpc::{Pacer, PacerScope};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

const MS: fn(u64) -> Duration = Duration::from_millis;

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap()
}

type Log = Arc<Mutex<Vec<(String, Instant, u16)>>>;

/// One call through the pacer as `RpcClient::call` does it.
async fn call(p: &Pacer, log: &Log, method: &str, status: u16, retry_after: Option<Duration>) {
    p.turn_for(method).await;
    log.lock()
        .unwrap()
        .push((method.to_string(), Instant::now(), status));
    match status {
        429 => p.throttled_method(method, retry_after).await,
        503 => p.throttled_for(retry_after).await,
        200 => p.ok_for(method).await,
        _ => {}
    }
}

fn sorted(log: &Log) -> Vec<(String, Instant, u16)> {
    let mut v = log.lock().unwrap().clone();
    v.sort_by_key(|s| s.1);
    v
}

fn assert_rate(v: &[(String, Instant, u16)], gap: Duration) {
    for w in v.windows(2) {
        assert!(
            w[1].1 - w[0].1 >= gap,
            "{} → {} only {:?} apart",
            w[0].0,
            w[1].0,
            w[1].1 - w[0].1
        );
    }
    // Sliding windows of 10 and 37 gaps.
    for k in [10u32, 37] {
        let win = gap * k;
        for (i, a) in v.iter().enumerate() {
            let n = v[i..].iter().take_while(|b| b.1 - a.1 < win).count();
            assert!(n as u32 <= k, "{n} turns in {win:?}");
        }
    }
}

#[test]
fn v1_total_rate_cap_under_mixed_storms() {
    rt().block_on(async {
        let gap = MS(12);
        let p = Pacer::with_scope(gap, MS(600), PacerScope::Method);
        let log: Log = Default::default();
        let methods = [
            "getTransaction",
            "getSignaturesForAddress",
            "getAccountInfo",
            "getMultipleAccounts",
            "sendTransaction",
            "getSignatureStatuses",
            "getLatestBlockhash",
            "getSlot",
        ];
        let n = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let t0 = Instant::now();
        let tasks: Vec<_> = methods
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let (p, log, n, m) = (p.clone(), log.clone(), n.clone(), m.to_string());
                tokio::spawn(async move {
                    for j in 0..25u64 {
                        let k = n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        // Storms: getTransaction 2 of 3, getSignaturesForAddress
                        // 1 of 2, getMultipleAccounts 1 of 5 (with Retry-After),
                        // a 503 every 70th call overall.
                        let (status, ra) = if k % 70 == 69 {
                            (503, None)
                        } else if (i == 0 && j % 3 != 2) || (i == 1 && j % 2 == 0) {
                            (429, None)
                        } else if i == 3 && j % 5 == 0 {
                            (429, Some(MS(700)))
                        } else {
                            (200, None)
                        };
                        call(&p, &log, &m, status, ra).await;
                    }
                })
            })
            .collect();
        for t in tasks {
            t.await.unwrap();
        }
        let v = sorted(&log);
        assert_eq!(v.len(), 200);
        assert_rate(&v, gap);
        let total: u64 = p.methods().iter().map(|s| s.calls).sum();
        assert_eq!(total, 200);
        let throttled = v.iter().filter(|s| s.2 == 429).count();
        assert!(throttled > 20, "{throttled}");
        eprintln!(
            "v1: 200 turns in {:?} ({} × 429, {} × 503)",
            t0.elapsed(),
            throttled,
            v.iter().filter(|s| s.2 == 503).count()
        );
    });
}

#[test]
fn v2_get_transaction_429_does_not_delay_get_account_info() {
    rt().block_on(async {
        let gap = MS(10);
        let p = Pacer::with_scope(gap, MS(30_000), PacerScope::Method);
        let log: Log = Default::default();
        let (p2, l2) = (p.clone(), log.clone());
        let storm = tokio::spawn(async move {
            for _ in 0..4 {
                call(&p2, &l2, "getTransaction", 429, Some(MS(1000))).await;
            }
        });
        let mut worst = Duration::ZERO;
        for _ in 0..60 {
            let t = Instant::now();
            call(&p, &log, "getAccountInfo", 200, None).await;
            worst = worst.max(t.elapsed());
        }
        // Each wait ≤ two gaps (one of getTransaction's turns may be
        // ahead) plus scheduling slack; far below the ≥ 1 s penalty.
        assert!(worst < MS(300), "worst getAccountInfo wait {worst:?}");
        assert!(p.penalty_of("getTransaction") >= MS(1000));
        assert!(p.penalty_of("getAccountInfo").is_zero());
        storm.abort();
        let v = sorted(&log);
        assert_rate(&v, gap);
        eprintln!("v2: worst getAccountInfo wait {worst:?}");
    });
}

#[test]
fn v3_503_holds_back_every_method() {
    rt().block_on(async {
        let p = Pacer::with_scope(MS(5), MS(30_000), PacerScope::Method);
        let log: Log = Default::default();
        call(&p, &log, "getSlot", 503, None).await;
        for m in ["getAccountInfo", "getTransaction", "sendTransaction"] {
            let t = Instant::now();
            call(&p, &log, m, 200, None).await;
            // First one waits the 500 ms (+≤125 ms jitter); after it the
            // 200 has reset the every-method penalty but `until` is past.
            if m == "getAccountInfo" {
                let w = t.elapsed();
                assert!(w >= MS(495) && w <= MS(900), "{m} waited {w:?}");
            }
        }
        assert!(p.penalty().await.is_zero(), "a 200 resets the 503 penalty");
        // Two 503s in a row double for everyone.
        call(&p, &log, "getSlot", 503, None).await;
        call(&p, &log, "getSlot", 503, None).await;
        assert_eq!(p.penalty_of("getAccountInfo"), MS(1000));
        assert_eq!(p.penalty_of("neverSeen"), MS(1000));
    });
}

#[test]
fn v4_cap_jitter_reset_per_method() {
    rt().block_on(async {
        let p = Pacer::with_scope(MS(1), MS(2_000), PacerScope::Method);
        let log: Log = Default::default();
        // Measured hold of a penalty = the wait of the next turn of that method.
        let mut pens = vec![];
        let mut holds = vec![];
        for _ in 0..4 {
            call(&p, &log, "getTransaction", 429, None).await;
            let pen = p.penalty_of("getTransaction");
            pens.push(pen);
            let t = Instant::now();
            p.turn_for("getTransaction").await;
            let h = t.elapsed();
            assert!(
                h + MS(2) >= pen && h <= pen + pen / 4 + MS(150),
                "{h:?} vs {pen:?}"
            );
            holds.push(h);
        }
        assert_eq!(pens, vec![MS(500), MS(1000), MS(2000), MS(2000)]);
        // Another method's 200 does not reset it; its own does.
        call(&p, &log, "getAccountInfo", 200, None).await;
        assert_eq!(p.penalty_of("getTransaction"), MS(2000));
        p.ok_for("getTransaction").await;
        assert!(p.penalty_of("getTransaction").is_zero());
        // Retry-After floor, and capped.
        p.throttled_method("getBlockTime", Some(MS(1500))).await;
        assert_eq!(p.penalty_of("getBlockTime"), MS(1500));
        p.throttled_method("getEpochInfo", Some(MS(9000))).await;
        assert_eq!(p.penalty_of("getEpochInfo"), MS(2000));
        let st = p.methods();
        let gt = st.iter().find(|s| s.method == "getTransaction").unwrap();
        assert_eq!(gt.throttles, 4);
        // Jitter is not always zero (≥ 1 of 4 holds noticeably above its penalty
        // is likely but not certain; only report it).
        eprintln!("v4 holds {holds:?} for penalties {pens:?}");
    });
}

// ------------------------------------------------ the pacer before #292

struct OldPacer {
    min_gap: Duration,
    max_penalty: Duration,
    st: tokio::sync::Mutex<(Option<Instant>, Duration)>,
}

impl OldPacer {
    fn new(min_gap: Duration, max_penalty: Duration) -> Arc<OldPacer> {
        Arc::new(OldPacer {
            min_gap,
            max_penalty,
            st: tokio::sync::Mutex::new((None, Duration::ZERO)),
        })
    }
    async fn turn(&self) {
        let mut st = self.st.lock().await;
        let now = Instant::now();
        if let Some(n) = st.0.filter(|n| *n > now) {
            tokio::time::sleep_until(n).await;
        }
        st.0 = Some(Instant::now() + self.min_gap);
    }
    async fn throttled_for(&self, ra: Option<Duration>) {
        let mut st = self.st.lock().await;
        st.1 = (st.1 * 2)
            .max(MS(500))
            .max(ra.unwrap_or_default())
            .min(self.max_penalty);
        // Jitter left out: the comparison allows the new pacer's ≤ 25 %.
        let until = Instant::now() + st.1;
        st.0 = Some(st.0.map_or(until, |n| n.max(until)));
    }
    async fn ok(&self) {
        self.st.lock().await.1 = Duration::ZERO;
    }
}

/// (method, status, Retry-After ms) of a serial caller.
const SCRIPT: &[(&str, u16, u64)] = &[
    ("getSignaturesForAddress", 200, 0),
    ("getTransaction", 429, 0),
    ("getAccountInfo", 200, 0),
    ("getTransaction", 429, 0),
    ("getTransaction", 429, 0),
    ("getMultipleAccounts", 200, 0),
    ("getTransaction", 503, 0),
    ("getAccountInfo", 429, 800),
    ("getTransaction", 200, 0),
    ("getAccountInfo", 200, 0),
    ("getTransaction", 429, 0),
    ("getTransaction", 429, 0),
    ("getSlot", 200, 0),
];

#[test]
fn v5_process_scope_matches_the_old_pacer_for_a_serial_caller() {
    rt().block_on(async {
        let gap = MS(20);
        let max = MS(1500);
        let old = OldPacer::new(gap, max);
        let mut old_w = vec![];
        for (_, s, ra) in SCRIPT {
            let t = Instant::now();
            old.turn().await;
            old_w.push(t.elapsed());
            let ra = (*ra > 0).then(|| MS(*ra));
            match s {
                429 | 503 => old.throttled_for(ra).await,
                _ => old.ok().await,
            }
        }
        let new = Pacer::with_scope(gap, max, PacerScope::Process);
        let log: Log = Default::default();
        let mut new_w = vec![];
        let mut pens = vec![];
        for (m, s, ra) in SCRIPT {
            let t = Instant::now();
            new.turn_for(m).await;
            new_w.push(t.elapsed());
            let ra = (*ra > 0).then(|| MS(*ra));
            log.lock()
                .unwrap()
                .push((m.to_string(), Instant::now(), *s));
            match s {
                429 => new.throttled_method(m, ra).await,
                503 => new.throttled_for(ra).await,
                _ => new.ok_for(m).await,
            }
            pens.push(new.penalty().await);
        }
        for (i, (o, n)) in old_w.iter().zip(&new_w).enumerate() {
            // new = old + jitter (≤ 25 % of that wait) ± scheduling.
            assert!(
                *n + MS(80) >= *o && *n <= *o + *o / 4 + MS(80),
                "step {i} {:?}: old {o:?} new {n:?}",
                SCRIPT[i]
            );
        }
        eprintln!("v5 old {old_w:?}\n   new {new_w:?}\n   penalties {pens:?}");
        // The same script under the new default: other methods do not wait.
        let def = Pacer::with_scope(gap, max, PacerScope::Method);
        let mut def_w = vec![];
        for (m, s, ra) in SCRIPT {
            let t = Instant::now();
            def.turn_for(m).await;
            def_w.push(t.elapsed());
            let ra = (*ra > 0).then(|| MS(*ra));
            match s {
                429 => def.throttled_method(m, ra).await,
                503 => def.throttled_for(ra).await,
                _ => def.ok_for(m).await,
            }
        }
        // Step 2 (getAccountInfo after getTransaction's 429): old waits ≥ 500 ms,
        // the default only the gap.
        assert!(
            old_w[2] >= MS(495) && def_w[2] < MS(250),
            "{:?} {:?}",
            old_w[2],
            def_w[2]
        );
        eprintln!("v5 default {def_w:?}");
    });
}

#[test]
fn v6_process_scope_concurrent_penalty_is_immediate() {
    rt().block_on(async {
        let gap = MS(30);
        let p = Pacer::with_scope(gap, MS(5_000), PacerScope::Process);
        let log: Log = Default::default();
        // Prime: one turn so the next ones queue on the gap.
        call(&p, &log, "getSlot", 200, None).await;
        let mut ts = vec![];
        for m in ["getAccountInfo", "getMultipleAccounts", "getSignatureStatuses"] {
            let (p, log) = (p.clone(), log.clone());
            ts.push(tokio::spawn(async move {
                for _ in 0..3 {
                    call(&p, &log, m, 200, None).await;
                }
            }));
        }
        tokio::time::sleep(MS(5)).await;
        // A 429 arrives while three callers wait for their turns.
        let at = Instant::now();
        p.throttled_method("getTransaction", None).await;
        for t in ts {
            t.await.unwrap();
        }
        let v = sorted(&log);
        let early: Vec<_> = v
            .iter()
            .filter(|s| s.1 > at && s.1 - at < MS(495))
            .map(|s| s.0.clone())
            .collect();
        // The new Process scope lets at most a turn already past its gap
        // through (none here: they were all sleeping on the gap).
        assert!(early.len() <= 1, "went during the penalty: {early:?}");
        // The old pacer under the same timing.
        let old = OldPacer::new(gap, MS(5_000));
        let olog: Log = Default::default();
        old.turn().await;
        let mut ts = vec![];
        for m in ["getAccountInfo", "getMultipleAccounts", "getSignatureStatuses"] {
            let (o, l) = (old.clone(), olog.clone());
            ts.push(tokio::spawn(async move {
                for _ in 0..3 {
                    o.turn().await;
                    l.lock().unwrap().push((m.to_string(), Instant::now(), 200));
                    o.ok().await;
                }
            }));
        }
        tokio::time::sleep(MS(5)).await;
        let at = Instant::now();
        old.throttled_for(None).await;
        let queued = Instant::now() - at;
        for t in ts {
            t.await.unwrap();
        }
        let ov = sorted(&olog);
        let oearly = ov
            .iter()
            .filter(|s| s.1 > at && s.1 - at < MS(495))
            .count();
        eprintln!(
            "v6 new: {} turns inside the 500 ms penalty; old: {oearly} (its throttle call itself queued {queued:?})",
            early.len()
        );
    });
}

/// The throttle log: run with `--nocapture` and count the lines
/// (`fclient rpc: … throttled (429)`): 2 methods × 300 throttles in ~1 s
/// → exactly 2 lines.
#[test]
fn v7_throttle_log_lines() {
    rt().block_on(async {
        let p = Pacer::with_scope(MS(1), MS(10), PacerScope::Method);
        for _ in 0..300 {
            p.throttled_method("getTransaction", None).await;
            p.throttled_method("getSignaturesForAddress", None).await;
        }
        let st = p.methods();
        assert!(st.iter().all(|s| s.throttles == 300 || s.method == "*"));
    });
}

/// V8 `Pacer::new` (what herald / keeper / verify call) reads
/// `FCLIENT_PACER_SCOPE` (run once with `FCLIENT_PACER_SCOPE=process`; only
/// the exact word `process` selects the old scope).
#[test]
fn v8_pacer_new_reads_the_env_scope() {
    let p = Pacer::new(MS(1), MS(10));
    let want = match std::env::var("FCLIENT_PACER_SCOPE").as_deref() {
        Ok("process") => PacerScope::Process,
        _ => PacerScope::Method,
    };
    assert_eq!(p.scope, want);
    eprintln!("v8 scope {:?}", p.scope);
}
