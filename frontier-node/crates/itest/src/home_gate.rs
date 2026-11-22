//! **TEST-ONLY player homes first** (runner-throughput-2, verify-pr143 BREAK-143-1), on the compressed local clocks
//! (`--demo`, `--wide --speed`) only. Read-only planning; nothing here sends.
//!
//! A resident order (Muster, Garrison, Dissolve, Explore — program `resident_ok`) at bell `b` needs the home province
//! resolved through `b − 2` (`resolved_next + 1 ≥ b`). Turn `b − 2` can be resolved only once its anchor's reveal window
//! has closed (`A + W`, with `A` = when the anchor of `b − 2` landed, which is at the earliest when bell `b − 1` began, and
//! `W` = one turn), so a province is "ready" for at most ONE turn minus (anchor delay + resolve delay). At ×60 a turn is
//! 10 wall seconds: every second the keeper loop is late costs 10 % of the window. Measured on main (24b56844): the
//! person's home was ready 15–29 % of the time and an external resident's 0–3 %, because
//!   - the loop slept a whole 10-s tick (= one ×60 turn) after a pass that landed nothing (`Pace::Demo`);
//!   - one pass cranked the demo's ~60 other provinces one awaited transaction at a time (6–8 s);
//!   - an external resident's village was not in the loop at all (only the first village's world sweep reached it).
//!
//! So, on a compressed clock, every player village's home (the person's, a pair's second, every operator and every
//! external resident's — one rule for all, no village before another) is resolved by ONE same-block batch
//! (`LegacyMarchDriver::homes_batch`): before each pass, between every village's rounds, and whenever one of those homes
//! has a NEW due step (a missing anchor, a closed window, a due seed: [`Key`]) — the world sweep then yields between its
//! own batches. And the loop wakes at the next such deadline instead of after a fixed tick ([`wait_until_next`]).
//!
//! No rule, clock, turn length or parameter changes; the program decides every step as before.
use std::time::Duration;

use fclient::addr::Addresses;
use localnet::server::{lock, Shared};
use localnet::Chain;

use crate::local_keeper as lk;

/// What a home needs next, as far as the keeper loop's urgency is concerned (pure data, read on one lock).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub bell: u32,
    pub resolved_next: u32,
    /// An ended bell from `resolved_next` on has no anchor in the home's region yet (PostAnchor is possible).
    pub anchor_due: bool,
    /// The anchor of `resolved_next` landed and its reveal window has closed (FastForward or the gather is possible).
    pub closable: bool,
    /// ... and its seed round is due while the region's seed of that bell is absent (PostSeed is possible).
    pub seed_due: bool,
}

impl Key {
    /// Whether anything can be sent for this home now.
    pub fn actionable(&self) -> bool {
        self.anchor_due || self.closable
    }
}

/// The key of the home `(p, q)` (`None` when unreadable).
pub fn key_of(c: &Chain, a: &Addresses, home: (i16, i16)) -> Option<Key> {
    let v = lk::view(c, a, home.0, home.1).ok()?;
    let clock = lk::season_clock(c, a).ok()?;
    let rn = v.resolved_next;
    let end = v
        .bell_now
        .min(rn.saturating_add(lk::MAX_FAST_FORWARD_BELLS));
    let anchor_due = !lk::missing_anchors(c, a, v.region, rn..end).is_empty();
    let (mut closable, mut seed_due) = (false, false);
    if rn < v.bell_now {
        if let Ok(Some(at)) = lk::anchor_landed(c, a, rn, v.region) {
            let now = c.unix_timestamp();
            closable = now >= clock.reveal_close(rn, at);
            seed_due = closable
                && c.account(&a.seed_cache(rn, v.region, 0)).is_none()
                && clock.drand.round_time(clock.seed_round(rn, at)) <= now;
        }
    }
    Some(Key {
        bell: v.bell_now,
        resolved_next: rn,
        anchor_due,
        closable,
        seed_due,
    })
}

/// The next chain time (unix seconds) at which one of `homes` gets a new due step: the next bell's start (its anchor),
/// the close of a posted anchor's reveal window, or a seed round coming due. `None` when nothing is readable.
pub fn next_deadline(c: &Chain, a: &Addresses, homes: &[(i16, i16)]) -> Option<i64> {
    let clock = lk::season_clock(c, a).ok()?;
    let now = c.unix_timestamp();
    let mut best: Option<i64> = None;
    let mut take = |t: i64| {
        if t > now {
            best = Some(best.map_or(t, |b: i64| b.min(t)));
        }
    };
    for &(p, q) in homes {
        let Ok(v) = lk::view(c, a, p, q) else {
            continue;
        };
        take(
            clock
                .genesis_ts
                .saturating_add((v.bell_now as i64 + 1) * fclient::abi::BELL_SECS),
        );
        if v.resolved_next < v.bell_now {
            if let Ok(Some(at)) = lk::anchor_landed(c, a, v.resolved_next, v.region) {
                let close = clock.reveal_close(v.resolved_next, at);
                take(close);
                take(
                    clock
                        .drand
                        .round_time(clock.seed_round(v.resolved_next, at)),
                );
            }
        }
    }
    best
}

/// Wall time until chain time `t` at the chain's present scale (a little after, so the slot that passes it has come);
/// `None` while the chain is paused or its scale is not positive.
pub fn wall_until(now: i64, t: i64, scale: f64, paused: bool) -> Option<Duration> {
    if paused || scale.is_nan() || scale <= 0.0 {
        return None;
    }
    let secs = ((t - now).max(0) as f64) / scale;
    Some(Duration::from_secs_f64(secs.min(3_600.0)) + SLACK)
}

/// After a deadline, the wait for the slot that carries the chain past it (a block every 400 ms).
pub const SLACK: Duration = Duration::from_millis(50);
/// The least wait between passes on a deadline wake (never a busy loop).
pub const MIN_WAIT: Duration = Duration::from_millis(50);

/// The wait before the next pass (pure): the pace's own wait, shortened to the next home deadline when there is one.
pub fn wait_until_next(pace_wait: Duration, deadline: Option<Duration>) -> Duration {
    match deadline {
        Some(d) => pace_wait.min(d).max(MIN_WAIT),
        None => pace_wait,
    }
}

/// The player homes of one keeper loop and what each needed when its batch last ran ([`Key`]).
#[derive(Debug, Default)]
pub struct HomeGate {
    pub homes: Vec<(i16, i16)>,
    last: Vec<Option<Key>>,
}

impl HomeGate {
    pub fn new() -> HomeGate {
        HomeGate::default()
    }

    /// The homes to serve (the person's first only in the list's order; the batch itself serves them in ONE block, so
    /// no home is before another). A changed list forgets what was seen.
    pub fn set_homes(&mut self, homes: Vec<(i16, i16)>) {
        if homes != self.homes {
            self.last = vec![None; homes.len()];
            self.homes = homes;
        }
    }

    /// Whether a home has a due step it did not have when the batch last ran (pure over `keys`).
    pub fn due_with(&self, keys: &[Option<Key>]) -> bool {
        keys.iter().enumerate().any(|(i, k)| {
            k.is_some_and(|k| k.actionable()) && self.last.get(i).copied().flatten() != *k
        })
    }

    /// The keys of every home now (one lock).
    pub fn keys(&self, state: &Shared, a: &Addresses) -> Vec<Option<Key>> {
        let c = lock(state);
        self.homes.iter().map(|h| key_of(&c, a, *h)).collect()
    }

    pub fn due(&self, state: &Shared, a: &Addresses) -> bool {
        !self.homes.is_empty() && self.due_with(&self.keys(state, a))
    }

    /// Notes what every home needs after its batch ran.
    pub fn served(&mut self, state: &Shared, a: &Addresses) {
        self.last = self.keys(state, a);
    }

    /// The wall wait until the next home deadline ([`next_deadline`], [`wall_until`]).
    pub fn wall_to_deadline(&self, state: &Shared, a: &Addresses) -> Option<Duration> {
        let c = lock(state);
        let t = next_deadline(&c, a, &self.homes)?;
        wall_until(c.unix_timestamp(), t, c.scale(), c.paused())
    }
}

/// A shared gate: the keeper loop updates it, the world sweep asks it between its batches (`LegacyMarchDriver::preempt`).
pub type SharedGate = std::sync::Arc<std::sync::Mutex<HomeGate>>;

/// Whether the shared gate has a home with a new due step (false when the gate is poisoned: never blocks the sweep).
pub fn gate_due(gate: &SharedGate, state: &Shared, a: &Addresses) -> bool {
    gate.lock().map(|g| g.due(state, a)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(bell: u32, rn: u32, anchor_due: bool, closable: bool, seed_due: bool) -> Key {
        Key {
            bell,
            resolved_next: rn,
            anchor_due,
            closable,
            seed_due,
        }
    }

    #[test]
    fn a_home_is_due_only_for_a_new_actionable_step() {
        let mut g = HomeGate::new();
        g.set_homes(vec![(1, 2), (3, 4)]);
        let idle = k(10, 9, false, false, false);
        let anchor = k(11, 9, true, false, false);
        // never served: due as soon as one home can act, never for idle homes
        assert!(!g.due_with(&[Some(idle), Some(idle)]));
        assert!(g.due_with(&[Some(idle), Some(anchor)]));
        assert!(!g.due_with(&[None, None]));
        // served in that state: the same step is not due again (no loop on a step that waits on something else)
        g.last = vec![Some(idle), Some(anchor)];
        assert!(!g.due_with(&[Some(idle), Some(anchor)]));
        // the window closed / the seed came due: a new step, due again
        assert!(g.due_with(&[Some(idle), Some(k(11, 9, false, true, false))]));
        assert!(g.due_with(&[Some(idle), Some(k(11, 9, false, true, true))]));
        // a new list forgets what was seen
        g.set_homes(vec![(1, 2)]);
        assert!(g.due_with(&[Some(anchor)]));
    }

    #[test]
    fn the_wait_is_the_pace_shortened_to_the_next_deadline_and_never_zero() {
        let s = Duration::from_secs;
        assert_eq!(wait_until_next(s(10), None), s(10));
        assert_eq!(wait_until_next(s(10), Some(s(3))), s(3));
        assert_eq!(wait_until_next(s(1), Some(s(3))), s(1));
        assert_eq!(wait_until_next(s(1), Some(Duration::ZERO)), MIN_WAIT);
        // chain seconds → wall at the chain's scale, plus the slot slack; nothing while paused
        assert_eq!(wall_until(100, 700, 60.0, false), Some(s(10) + SLACK));
        assert_eq!(wall_until(100, 50, 60.0, false), Some(SLACK));
        assert_eq!(wall_until(100, 700, 60.0, true), None);
        assert_eq!(wall_until(100, 700, 0.0, false), None);
        assert_eq!(wall_until(0, 600, 15.0, false), Some(s(40) + SLACK));
    }
}
