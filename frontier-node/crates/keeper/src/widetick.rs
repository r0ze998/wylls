//! **Read-only, opt-in** (feature `wide-world-experimental`): the bounded
//! per-tick review of wide candidates for the keeper's status.
//!
//! The keeper's read-only wide observer ([`crate::wideindex`]) names the
//! departures it has seen open and the dissolves it has seen pending.
//! Enabled by `Keeper::enable_wide_review` (which needs the observer and a
//! pinned deployment), this step takes at most [`CANDIDATES_PER_TICK`] of
//! those hints per tick — a **hard** cap, whatever the public
//! `candidates_per_tick` is set to — not re-reviewed within
//! [`REFRESH_SLOTS`] slots, in a round-robin over the model's order whose
//! cursor advances by the positions inspected. Each hint is planned through
//! the ordinary `ChainPort` reads at the tick's slot as the lower bound
//! ([`crate::wideduty::settle_departure_via`] /
//! [`crate::wideduty::return_via`]: a lower bound and a separate clock,
//! never coherent), reviewed against the engine's public state with the
//! fee review bound to those reads
//! ([`crate::widereview::review_candidate`]), and recorded for
//! `/v1/status`. Nothing is enqueued, signed, simulated or sent;
//! `Engine::ensure` is not reachable from here; the legacy PSW1 feed guard
//! still stops game writes as before (this step runs whether or not it has
//! fired, before the keeper publishes its status, and only reads).
//!
//! **What this covers and what it does not.** Settle and Return hints over
//! non-coherent reads. **Not** Reveal (it needs a departure proof, an
//! opening and a public beacon the tick path does not hold) and **not** the
//! same-response snapshot: the keeper is generic over `ChainPort`, the
//! snapshot is an additive capability ([`crate::widesnapshot::SnapshotPort`])
//! the JSON-RPC port implements and others do not, and requiring it here
//! would change the keeper's bound for every port. The snapshot planners
//! are **not connected to the runtime**; an orchestrator calls them.
//!
//! **Bounds.** ≤ `CANDIDATES_PER_TICK` plans per tick, each ≤ 3 account
//! read rounds plus one clock read; the review ledger keeps at most
//! [`MAX_LEDGER`] entries (oldest dropped). The status carries addresses
//! and hex identities only — no key material, no account bytes.

use std::collections::BTreeMap;

use fclient::ports::ChainPort;
use serde_json::{json, Value};
use solana_address::Address;

use crate::engine::Engine;
use crate::wideduty::{self, Deployment, Reads, Scope};
use crate::wideindex::WideDiscovery;
use crate::widereview::{review_candidate, EngineView};

/// Plans per tick: a hard cap.
pub const CANDIDATES_PER_TICK: usize = 2;
/// Slots before a hint is reviewed again.
pub const REFRESH_SLOTS: u64 = 64;
/// Review ledger entries kept.
pub const MAX_LEDGER: usize = 256;

/// The state of the per-tick review.
pub struct WideReview {
    pub deployment: Deployment,
    /// Plans per tick; clamped to [`CANDIDATES_PER_TICK`] at every step.
    pub candidates_per_tick: usize,
    /// Hint id → (slot reviewed, summary).
    ledger: BTreeMap<String, (u64, Value)>,
    cursor: usize,
    pub ticks: u64,
    pub plans: u64,
    pub candidates: u64,
    pub blocked: u64,
    pub read_errors: u64,
}

impl WideReview {
    pub fn new(deployment: Deployment) -> WideReview {
        WideReview {
            deployment,
            candidates_per_tick: CANDIDATES_PER_TICK,
            ledger: BTreeMap::new(),
            cursor: 0,
            ticks: 0,
            plans: 0,
            candidates: 0,
            blocked: 0,
            read_errors: 0,
        }
    }

    /// The effective cap: never above the hard constant.
    pub fn cap(&self) -> usize {
        self.candidates_per_tick.min(CANDIDATES_PER_TICK)
    }

    /// The hints the model offers, as `(id, Hint)`, settles first.
    fn hints(model: &WideDiscovery) -> Vec<(String, Hint)> {
        let mut v: Vec<(String, Hint)> = wideduty::settle_candidates(model)
            .into_iter()
            .map(|(h, s)| {
                (
                    format!("settle:{}:{s}", hex::encode(h.to_bytes())),
                    Hint::Settle(h, s),
                )
            })
            .collect();
        v.extend(
            wideduty::return_candidates(model)
                .into_iter()
                .map(|(p, h)| {
                    (
                        format!(
                            "return:{}:{}",
                            hex::encode(p.to_bytes()),
                            hex::encode(h.to_bytes())
                        ),
                        Hint::Return(p, h),
                    )
                }),
        );
        v
    }

    /// One bounded step at tick `slot` (the planners' lower bound). Returns
    /// the number of plans made (each a bounded number of reads).
    pub async fn step<P: ChainPort>(
        &mut self,
        port: &P,
        engine: &Engine,
        model: &WideDiscovery,
        program: Address,
        season: Address,
        slot: u64,
    ) -> u64 {
        self.ticks += 1;
        let hints = Self::hints(model);
        if hints.is_empty() {
            return 0;
        }
        let scope = Scope {
            program,
            season,
            deployment: Some(self.deployment),
        };
        // No payer is drawn on this path: the unsigned candidate names a
        // zero address where the fee payer would sign.
        let payer = Address::default();
        let cap = self.cap();
        let n = hints.len();
        let mut made = 0usize;
        let mut inspected = 0usize;
        for k in 0..n {
            if made >= cap {
                break;
            }
            inspected = k + 1;
            let (id, hint) = &hints[(self.cursor + k) % n];
            if self
                .ledger
                .get(id)
                .is_some_and(|(s, _)| slot < s.saturating_add(REFRESH_SLOTS))
            {
                continue;
            }
            made += 1;
            self.plans += 1;
            // The tick's slot is the lower bound of every read.
            let planned = match hint {
                Hint::Settle(h, s) => {
                    wideduty::settle_departure_via(port, &scope, payer, *h, *s, slot).await
                }
                Hint::Return(p, h) => wideduty::return_via(port, &scope, payer, *p, *h, slot).await,
            };
            let summary = match planned {
                Ok(c) => {
                    self.candidates += 1;
                    // Ordinary reads: no snapshot can verify, so the fee
                    // review declares the requirement unknown; the review
                    // keeps `NoCoherentSnapshot`.
                    let view = EngineView::of(engine, &crate::widereview::Subject::of_duty(&c));
                    let a = review_candidate(&c, &Reads::new(slot), &view);
                    json!({
                        "hint": id,
                        "slot": slot,
                        "outcome": "candidate",
                        "candidate": c.describe(),
                        "assessment": a.describe(),
                    })
                }
                Err(b) => {
                    self.blocked += 1;
                    if matches!(b, wideduty::Block::Read(_)) {
                        self.read_errors += 1;
                    }
                    json!({
                        "hint": id,
                        "slot": slot,
                        "outcome": "blocked",
                        "block": format!("{b:?}"),
                    })
                }
            };
            self.ledger.insert(id.clone(), (slot, summary));
        }
        // Advance by the positions inspected, so skipped hints are not
        // revisited first next tick.
        self.cursor = (self.cursor + inspected) % n.max(1);
        while self.ledger.len() > MAX_LEDGER {
            let oldest = self
                .ledger
                .iter()
                .min_by_key(|(_, (s, _))| *s)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.ledger.remove(&k);
                }
                None => break,
            }
        }
        made as u64
    }

    /// The status entry: counts, bounds and the most recent summaries.
    pub fn status(&self) -> Value {
        let mut recent: Vec<(&u64, &Value)> = self.ledger.values().map(|(s, v)| (s, v)).collect();
        recent.sort_by(|a, b| b.0.cmp(a.0));
        json!({
            "mode": "review-only",
            "automatic_writes": false,
            "enqueued": 0,
            "signed": false,
            "covers": "settle and return hints over ordinary reads; not reveal; not the same-response snapshot",
            "deployment": {
                "program_version": self.deployment.program_version,
                "ruleset_hash": hex::encode(self.deployment.ruleset_hash),
            },
            "candidates_per_tick": self.cap(),
            "hard_cap": CANDIDATES_PER_TICK,
            "refresh_slots": REFRESH_SLOTS,
            "ticks": self.ticks,
            "plans": self.plans,
            "candidates": self.candidates,
            "blocked": self.blocked,
            "read_errors": self.read_errors,
            "ledger": self.ledger.len(),
            "cursor": self.cursor,
            "snapshot": "unsupported on the tick path: ChainPort reads, coherent false; the snapshot planners are not runtime-connected",
            "recent": recent.into_iter().take(8).map(|(_, v)| v.clone()).collect::<Vec<_>>(),
        })
    }
}

#[derive(Clone, Copy, Debug)]
enum Hint {
    Settle(frontier_abi::world_index::WideHostRef, u8),
    Return(
        frontier_abi::world_index::ProvinceKey,
        frontier_abi::world_index::WideHostRef,
    ),
}
