//! Counting the herald GETs the brain makes itself (contract v1.3 R6, §3.1, §4.3).
//!
//! R6 withdrew the cap of "8 extra GETs per step" and asked for the number to be
//! measured and reported instead: GETs per step per AI. [`Counted`] wraps a
//! [`HeraldPort`] at one call site of the brain and counts every `get` under a
//! counter name `gets:<kind>` of the AI's bot (see [`AiHook::bot_stat`]); the
//! counters travel to the mind (`POST /v1/brain-stats`, [`super::post_stats`])
//! and to `ai-brain.json`.
//!
//! What is counted, and what is not (the report says the same):
//!
//! | counter | where | exact? |
//! |---|---|---|
//! | `gets:me` | `/h/me/{wallet}` read by `meview::fetch` at the start of a session step | yes |
//! | `gets:digest` | the province files `obs_digest` re-reads for `obs_digest` | yes |
//! | `gets:recall_events` | the `/h/events` pages of the threat feed (Recall) | yes |
//! | `gets:recall_owners` | owner province files read for a threat's nation | yes |
//! | `gets:fetch_path` | the path fetch for a Strike-Order follow (`follow_fetch_gets` is the same figure) | yes |
//! | `gets:follow_me` | the cheap `/h/me` read before a follow check | yes |
//! | `gets:reobserve` | `bot.observe` after a model answer or a stale answer: `/h/me` + the province, per-bell and bell files it returned | **lower bound**: a 404 and a cache refresh of `/h/season` or an overview are not seen from here |
//!
//! The first observation of every step (`bot.observe` in `Bot::step`) is the
//! bots' own baseline, the same for a rule bot, and is not counted here.
use std::future::Future;

use crate::ai::AiHook;
use crate::ports::{HeraldPort, PortResult};

/// The counter a `get` is booked under: one name, or one chosen by the path.
#[derive(Clone, Copy)]
enum Key {
    Fixed(&'static str),
    ByPath(fn(&str) -> &'static str),
}

/// A herald whose `get`s are counted as `gets:<kind>` of bot `index`.
pub struct Counted<'a, H> {
    inner: &'a H,
    hook: &'a AiHook,
    index: u32,
    key: Key,
}

impl<'a, H> Counted<'a, H> {
    /// `key` is the full counter name, `gets:<kind>`.
    pub fn new(inner: &'a H, hook: &'a AiHook, index: u32, key: &'static str) -> Counted<'a, H> {
        debug_assert!(key.starts_with("gets:"));
        Counted {
            inner,
            hook,
            index,
            key: Key::Fixed(key),
        }
    }

    /// One call site that reads two kinds of file: `classify` names the counter from the path.
    pub fn by_path(
        inner: &'a H,
        hook: &'a AiHook,
        index: u32,
        classify: fn(&str) -> &'static str,
    ) -> Counted<'a, H> {
        Counted {
            inner,
            hook,
            index,
            key: Key::ByPath(classify),
        }
    }
}

impl<H: HeraldPort> HeraldPort for Counted<'_, H> {
    fn get(&self, path: &str) -> impl Future<Output = PortResult<Option<Vec<u8>>>> + Send {
        let key = match self.key {
            Key::Fixed(k) => k,
            Key::ByPath(f) => f(path),
        };
        self.hook.bot_stat(self.index, key);
        self.inner.get(path)
    }
}

/// The Recall feed reads two kinds of file through one handle: the event pages and
/// the province files of a threat's owner.
pub fn recall_key(path: &str) -> &'static str {
    if path.starts_with("/h/events") {
        "gets:recall_events"
    } else {
        "gets:recall_owners"
    }
}

/// The re-observe's herald reads that can be seen from the result: `/h/me`
/// (always read), and one GET per province, per-bell envelope and bell file
/// the observation holds. A lower bound (see the module table).
pub fn reobserve_gets(o: &frontier_agents::obs::Observation) -> u64 {
    1 + (o.provinces.len() + o.province_bells.len() + o.bells.len()) as u64
}
