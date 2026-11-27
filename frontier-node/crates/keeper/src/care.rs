//! fix-keeper-care: payer care on its own cadence.
//!
//! Before this, care ran once per tick, at its start, and a tick can last
//! far longer than the payers' money: on 11-27 keeper A's first tick re-read
//! the program's history for ≈ 107 min, its backlog spent the 32 delay
//! payers down to their rent-exempt reserve while the funders held 10.8 SOL,
//! and nothing topped them up until the tick ended. This module runs care
//! *beside* the tick's long chain reads (the feed pull):
//!
//! - while a care transfer is unresolved, every [`CARE_SIDE_POLL_EVERY`] it
//!   reads the status of the care signatures alone ([`Engine::poll_kind`]),
//!   so the port's capped history search proves a dropped one never-landed
//!   within a few reads, whatever else is unresolved;
//! - otherwise, every [`CARE_SIDE_REFRESH_EVERY`], it re-reads the payer
//!   balances and, when a payer is below its pool's floor, plans the same
//!   top-ups the tick's care would (`Payers::care_plan`) and sends them.
//!
//! RPC budget: at rest one Clock read and one balance read
//! (`getMultipleAccounts`, ≤ 2 calls for 186 addresses) per minute, i.e.
//! ≤ 0.5 calls per 10 s; while care is in flight one status read (plus at
//! most one history search, gated by the port) per 20 s. The step never
//! runs inside a send: it is awaited to completion before the tick goes on
//! (see [`CareCtx::during`]).

use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

use fclient::ports::ChainPort;

use crate::engine::{BuildCtx, Engine, Outcome, StepReport, WriteSpec, PAYER_CARE_KIND};
use crate::journal::Journal;
use crate::pools::{PayerKey, Payers};
use fclient::abi::Class;

/// Least time between two care-only status reads while a care transfer is
/// unresolved (matches the port's history gate, `fclient::rpc::HISTORY_EVERY`).
pub const CARE_SIDE_POLL_EVERY: Duration = Duration::from_secs(20);
/// Least time between two side balance reads while no care is in flight.
pub const CARE_SIDE_REFRESH_EVERY: Duration = Duration::from_secs(60);
/// A chain read shorter than this never gets a care step beside it.
pub const CARE_SIDE_WAKE: Duration = Duration::from_secs(5);

/// The side cadence's state (kept by the keeper across ticks).
#[derive(Default)]
pub struct CareSide {
    last_poll: Option<Instant>,
    last_refresh: Option<Instant>,
    /// Care outcomes seen by side polls, handed to the next tick's outcomes.
    pub outcomes: Vec<(String, Outcome)>,
    /// Side steps run / side care passes that planned top-ups / transfers sent.
    pub steps: u64,
    pub passes: u64,
    pub sent: u64,
    /// The last side error (a failed Clock or balance read).
    pub last_error: Option<String>,
}

/// The care-relevant parts of the keeper, borrowed apart from the feed and
/// index state a long read holds.
pub struct CareCtx<'a, P: ChainPort, K: PayerKey = solana_keypair::Keypair> {
    pub port: &'a P,
    pub engine: &'a mut Engine,
    pub payers: &'a mut Payers<K>,
    pub journal: Option<&'a Journal>,
    pub care_last: &'a mut Option<(u64, i64, usize)>,
    /// Old `expired` care rows need reconciliation first (no care at all).
    pub legacy: bool,
    pub side: &'a mut CareSide,
    /// The tick's slot (journal and outcome slots of a side poll).
    pub tick_slot: u64,
}

/// Plans the top-ups and sweeps of `payers` as class N writes (keys
/// `care:<from>:<to>:<slot>`); returns how many.
pub fn plan_care<K: PayerKey>(payers: &Payers<K>, engine: &mut Engine, slot: u64) -> usize {
    let plan = payers.care_plan();
    let n = plan.len();
    for tr in plan {
        let ix = tr.instruction();
        engine.ensure(
            WriteSpec {
                key: format!("care:{}:{}:{slot}", tr.from, tr.to),
                kind: PAYER_CARE_KIND,
                tag: 0,
                class: Class::N,
                bell: None,
                region: None,
                build: std::sync::Arc::new(move |_: &BuildCtx| vec![ix.clone()]),
                deadline_slot: None,
                not_before_slot: 0,
                fixed_payer: Some(tr.from),
            },
            slot,
        );
    }
    n
}

impl CareSide {
    /// The tick just ran care: the side waits a whole interval from now.
    pub fn note_tick_care(&mut self) {
        self.last_refresh = Some(Instant::now());
    }
}

impl<P: ChainPort, K: PayerKey> CareCtx<'_, P, K> {
    /// Awaits `fut` (a long chain read) and, while it runs, a care step
    /// every [`CARE_SIDE_WAKE`]. Both are polled together; a care step that
    /// started is always finished (never dropped inside a send) before the
    /// read's result is returned.
    pub async fn during<F: Future>(&mut self, fut: F) -> F::Output {
        let mut fut = std::pin::pin!(fut);
        loop {
            tokio::select! {
                biased;
                r = &mut fut => return r,
                _ = tokio::time::sleep(CARE_SIDE_WAKE) => {}
            }
            let mut out = None;
            {
                let step = self.step();
                let mut step = std::pin::pin!(step);
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut step => break,
                        r = &mut fut, if out.is_none() => out = Some(r),
                    }
                }
            }
            if let Some(r) = out {
                return r;
            }
        }
    }

    /// One side care step (see the module docs); a no-op when nothing is due.
    pub async fn step(&mut self) {
        if self.legacy {
            return;
        }
        let now = Instant::now();
        let due = |last: Option<Instant>, every: Duration| {
            last.is_none_or(|t| now.duration_since(t) >= every)
        };
        if self.engine.care_unresolved() {
            if !due(self.side.last_poll, CARE_SIDE_POLL_EVERY) {
                return;
            }
            self.side.steps += 1;
            self.side.last_poll = Some(now);
            let r: StepReport = self
                .engine
                .poll_kind(self.port, self.journal, self.tick_slot, PAYER_CARE_KIND)
                .await;
            self.side.outcomes.extend(r.outcomes);
            if self.engine.care_unresolved() {
                return;
            }
            // Settled: plan from fresh balances at once.
            self.side.last_refresh = None;
        }
        if !due(self.side.last_refresh, CARE_SIDE_REFRESH_EVERY) {
            return;
        }
        self.side.steps += 1;
        self.side.last_refresh = Some(now);
        let clock = match self.port.clock().await {
            Ok(c) => c,
            Err(e) => {
                self.side.last_error = Some(format!("clock: {e}"));
                return;
            }
        };
        // The slot never goes back behind the tick's (keys and sent slots).
        let slot = clock.slot.max(self.tick_slot);
        if let Err(e) = self
            .payers
            .refresh_at_least(
                self.port,
                slot,
                self.engine.care_settled_slot().unwrap_or(0),
            )
            .await
        {
            self.side.last_error = Some(format!("balances: {e}"));
            return;
        }
        self.side.last_error = None;
        let planned = plan_care(self.payers, self.engine, slot);
        if planned == 0 {
            return;
        }
        *self.care_last = Some((slot, clock.unix_timestamp, planned));
        self.side.passes += 1;
        let mut r = StepReport::default();
        self.engine
            .send_kinds(
                self.port,
                self.payers,
                self.journal,
                slot,
                &mut r,
                Some(&[PAYER_CARE_KIND]),
            )
            .await;
        self.side.sent += r.sent as u64;
    }
}
