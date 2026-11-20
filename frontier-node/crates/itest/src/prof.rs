//! **Runner throughput measurement** (TEST-ONLY local play, runner-throughput): process-wide counters of where a keeper
//! pass spends its wall time — transactions awaited until the node's ticker lands them, simulations (run under the
//! node's lock), public drand fetches (and the verified-round cache that answers most of them) — and the per-phase split
//! of one pass. Read by the keeper loop's slow-pass line and its once-a-minute world line on stderr. Measurement only:
//! nothing here decides, sends or changes anything.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// A count and the total microseconds of one kind of work.
pub struct Counter {
    n: AtomicU64,
    us: AtomicU64,
}
impl Counter {
    pub const fn new() -> Counter {
        Counter {
            n: AtomicU64::new(0),
            us: AtomicU64::new(0),
        }
    }
    pub fn add(&self, since: Instant) {
        self.n.fetch_add(1, Ordering::Relaxed);
        self.us
            .fetch_add(since.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
    pub fn hit(&self) {
        self.n.fetch_add(1, Ordering::Relaxed);
    }
    pub fn get(&self) -> (u64, u64) {
        (
            self.n.load(Ordering::Relaxed),
            self.us.load(Ordering::Relaxed),
        )
    }
}
impl Default for Counter {
    fn default() -> Self {
        Counter::new()
    }
}

/// Transactions: submit → seen landed (or failed) on the node's ticker.
pub static LAND: Counter = Counter::new();
/// Transactions that shared their wait with others (`keeper_loop::submit_many`): one count per transaction.
pub static LAND_BATCHED: Counter = Counter::new();
/// Simulations through `local_keeper::simulate_ix` (under the node's lock).
pub static SIM: Counter = Counter::new();
/// Public drand fetches that went to the network (one per round asked).
pub static DRAND: Counter = Counter::new();
/// Rounds answered by the process-wide verified-round cache (no network).
pub static DRAND_CACHED: Counter = Counter::new();

/// The counters as one JSON object (`n` and total ms of each).
pub fn snapshot() -> [(u64, u64); 5] {
    [
        LAND.get(),
        LAND_BATCHED.get(),
        SIM.get(),
        DRAND.get(),
        DRAND_CACHED.get(),
    ]
}
/// The difference of two snapshots as JSON (`{"land":[n, ms], …}`).
pub fn delta_json(a: &[(u64, u64); 5], b: &[(u64, u64); 5]) -> serde_json::Value {
    let names = ["land", "land_batched", "sim", "drand", "drand_cached"];
    let mut m = serde_json::Map::new();
    for i in 0..5 {
        let n = b[i].0.saturating_sub(a[i].0);
        let ms = b[i].1.saturating_sub(a[i].1) / 1000;
        m.insert(names[i].into(), serde_json::json!([n, ms]));
    }
    serde_json::Value::Object(m)
}

/// The phases of the current pass (`(label, ms)` in order), drained by the keeper loop's slow-pass line.
pub static PHASES: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());
pub fn phase(label: impl Into<String>, since: Instant) {
    if let Ok(mut p) = PHASES.lock() {
        if p.len() < 256 {
            p.push((label.into(), since.elapsed().as_millis() as u64));
        }
    }
}
pub fn take_phases() -> Vec<(String, u64)> {
    PHASES
        .lock()
        .map(|mut p| std::mem::take(&mut *p))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_add_and_deltas_are_per_kind() {
        let a = snapshot();
        SIM.add(Instant::now());
        DRAND_CACHED.hit();
        let b = snapshot();
        let d = delta_json(&a, &b);
        assert!(d["sim"][0].as_u64().unwrap() >= 1);
        assert!(d["drand_cached"][0].as_u64().unwrap() >= 1);
        phase("x", Instant::now());
        assert!(take_phases().iter().any(|(l, _)| l == "x"));
    }
}
