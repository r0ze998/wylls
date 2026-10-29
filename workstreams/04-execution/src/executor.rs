//! The executor: one tick reads the feed, then advances each due run it can
//! lease by at most one external action.
//!
//! **How a resource change is held to once** (no "exactly once" over the
//! network is claimed):
//! 1. *Identity.* Each external step has a request key fixed before its
//!    first attempt: `fac:<run_id>` for the facility use, the caravan
//!    `(owner_tag, seq)` for SendCaravan (the program refuses a seq other
//!    than `Citizen.CARAVANS`).
//! 2. *Write-ahead.* The signed attempt is journalled (`intent`) in the same
//!    transaction as the state that sends it, before the send.
//! 3. *Canonical confirmation.* A step is confirmed only by a canonical
//!    read (the facility record by key; our signature landed, or the
//!    caravan account / entity history), never by the send's answer.
//! 4. *Refusal of duplicates.* A second attempt with the same key is
//!    refused by the canonical side (`AlreadyDone`, seq mismatch); a new
//!    attempt is only signed once every earlier one is decided (landed, or
//!    past its validity and absent).
//! 5. *Fencing.* Every write is a compare-and-swap on the run's version and
//!    the lease epoch, so a paused or stale executor writes nothing — and
//!    sends nothing, since sending follows a successful write.

use crate::model::*;
use crate::ports::*;
use crate::store::{Change, Op, Receipt, ResKind, RunRow, Step, Store};

/// Named stop points for crash tests (the process stops there: no write
/// after it happens).
#[derive(Clone, Debug, Default)]
pub struct CrashPlan {
    pub points: Vec<(&'static str, u32)>,
    seen: std::collections::BTreeMap<&'static str, u32>,
}

impl CrashPlan {
    /// Stop at the `nth` time `point` is reached.
    pub fn at(point: &'static str, nth: u32) -> CrashPlan {
        CrashPlan {
            points: vec![(point, nth)],
            seen: Default::default(),
        }
    }
}

/// The crash points, in the order a run meets them.
pub const CRASH_POINTS: [&str; 6] = [
    "facility.before_send",
    "facility.after_send",
    "facility.after_confirm",
    "ship.before_send",
    "ship.after_send",
    "ship.after_confirm",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Halt {
    /// An injected crash.
    Crashed(&'static str),
    /// The store failed (the tick stops; nothing half-written).
    Store(String),
}

impl From<String> for Halt {
    fn from(e: String) -> Halt {
        Halt::Store(e)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Lease length in slots.
    pub lease: u64,
    /// Slots between two looks at a waiting run.
    pub poll: u64,
    pub max_runs_per_tick: usize,
    /// Slots of margin before the deadline: no attempt is signed closer.
    pub deadline_margin: u64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            lease: 8,
            poll: 2,
            max_runs_per_tick: 64,
            deadline_margin: 0,
        }
    }
}

#[derive(Debug, Default)]
pub struct TickReport {
    pub slot: u64,
    pub events_new: usize,
    pub events_dup: usize,
    pub gap: bool,
    pub stepped: usize,
    pub stale: usize,
    pub sends: usize,
}

pub struct Executor<C: Chain, R: Rights> {
    pub id: String,
    pub store: Store,
    pub chain: C,
    pub rights: R,
    pub params: Params,
    pub crash: Option<CrashPlan>,
}

/// What a step decided: a state change, or nothing (wait).
#[allow(clippy::large_enum_variant)] // one per step, never stored
enum Next {
    Go(Change),
    Wait(u64),
    /// The step wrote its own transitions (a send): `false` = stale.
    Done(bool),
}

fn change(to: RunState, d: Detail, next: u64, reason: impl Into<String>) -> Change {
    Change {
        to,
        detail: d,
        next_check: next,
        reason: reason.into(),
        ops: vec![],
        unless_cancelled: false,
        sole_owner_send: false,
        hold: None,
    }
}

impl<C: Chain, R: Rights> Executor<C, R> {
    pub fn new(id: &str, store: Store, chain: C, rights: R) -> Self {
        Executor {
            id: id.to_string(),
            store,
            chain,
            rights,
            params: Params::default(),
            crash: None,
        }
    }

    fn crash_at(&mut self, point: &'static str) -> Result<(), Halt> {
        let Some(c) = &mut self.crash else {
            return Ok(());
        };
        let n = c.seen.entry(point).or_default();
        *n += 1;
        if c.points.iter().any(|(p, k)| *p == point && *k == *n) {
            return Err(Halt::Crashed(point));
        }
        Ok(())
    }

    /// Accepts a run (validated first: no step outside the allow-list can
    /// be expressed, and an empty cargo is refused).
    pub fn accept(&self, spec: &RunSpec) -> Result<crate::store::Accept, String> {
        if res_is_zero(&spec.ship.cargo) {
            return Err("empty cargo".into());
        }
        if spec.ship.dst.slot_key() == spec.stock.slot_key() {
            return Err("a send's two places never share a tile".into());
        }
        if spec.budget.max_attempts == 0 || spec.budget.max_attempts > 16 {
            return Err("max_attempts must be 1..=16".into());
        }
        let now = self.chain.slot().map_err(|e| format!("{e:?}"))?;
        self.store.accept(spec, now)
    }

    /// One pass: the feed, then the due runs.
    pub fn tick(&mut self) -> Result<TickReport, Halt> {
        let mut rep = TickReport::default();
        let now = match self.chain.slot() {
            Ok(s) => s,
            // Nothing can be decided without the canonical side.
            Err(_) => return Ok(rep),
        };
        rep.slot = now;
        self.ingest(now, &mut rep)?;
        for id in self.store.due(now, self.params.max_runs_per_tick)? {
            if !self.store.claim(&id, &self.id, now, self.params.lease)? {
                continue;
            }
            let Some(row) = self.store.load(&id)? else {
                continue;
            };
            if row.lease_owner.as_deref() != Some(&self.id) {
                continue;
            }
            rep.stepped += 1;
            match self.step(&row, now, &mut rep)? {
                true => {}
                false => rep.stale += 1,
            }
        }
        Ok(rep)
    }

    /// Reads the feed: each record once (by id), in any order, waking the
    /// runs it names. Records are hints and evidence; states change only
    /// from canonical reads in `step`.
    fn ingest(&mut self, now: u64, rep: &mut TickReport) -> Result<(), Halt> {
        let after = self.store.cursor("events")?;
        let Ok(page) = self.chain.events(after, 256) else {
            return Ok(());
        };
        if page.gap {
            rep.gap = true;
            self.store.alert(
                now,
                None,
                "history_gap",
                &format!("feed has nothing after {after}; reconciling every open run"),
            )?;
            self.store.wake_all(now)?;
        }
        for rec in &page.events {
            if self.store.record_event(rec, now)? {
                rep.events_new += 1;
                let subject = match (&rec.event, rec.event.caravan()) {
                    (_, Some(k)) => Some(k.text()),
                    (Event::FacilityUsed(f), None) => Some(f.key.clone()),
                    _ => None,
                };
                match subject {
                    Some(s) => {
                        self.store.wake_subject(&s, now)?;
                    }
                    // A seizure may change any run's destination.
                    None => {
                        self.store.wake_all(now)?;
                    }
                }
            } else {
                rep.events_dup += 1;
            }
        }
        self.store.set_cursor("events", page.next)?;
        Ok(())
    }

    /// Loads a run and steps it (operator tools, tests).
    pub fn step_id(&mut self, id: &str) -> Result<bool, Halt> {
        let now = self
            .chain
            .slot()
            .map_err(|e| Halt::Store(format!("{e:?}")))?;
        if !self.store.claim(id, &self.id, now, self.params.lease)? {
            return Ok(false);
        }
        let row = self
            .store
            .load(id)?
            .ok_or_else(|| Halt::Store("no such run".into()))?;
        self.step(&row, now, &mut TickReport::default())
    }

    /// Steps a run from the snapshot `row`. `Ok(false)`: the snapshot was
    /// stale or the lease was lost; nothing was written or sent.
    pub fn step(&mut self, row: &RunRow, now: u64, rep: &mut TickReport) -> Result<bool, Halt> {
        if row.state.terminal() || row.held.is_some() {
            return Ok(true);
        }
        let next = match self.decide(row, now, rep) {
            Ok(n) => n,
            Err(Fault::Halt(h)) => return Err(h),
            Err(Fault::Stale) => return Ok(false),
            Err(Fault::Port(e)) => {
                let mut d = row.detail.clone();
                d.port_errors += 1;
                let mut c = change(
                    row.state,
                    d.clone(),
                    now + self.params.poll,
                    format!("port: {e:?}"),
                );
                if d.port_errors >= row.spec.budget.max_port_errors {
                    c.hold = Some(format!("{:?}", Reason::PortUnavailable));
                    self.store
                        .alert(now, Some(row.id()), "held", "port unavailable")?;
                }
                return Ok(self.store.transition(row, &self.id, now, &c)?);
            }
        };
        match next {
            Next::Done(ok) => Ok(ok),
            Next::Wait(at) => {
                if at != row.next_check || row.detail.port_errors != 0 {
                    let mut d = row.detail.clone();
                    d.port_errors = 0;
                    let c = change(row.state, d, at, "wait");
                    return Ok(self.store.transition(row, &self.id, now, &c)?);
                }
                Ok(true)
            }
            Next::Go(mut c) => {
                if c.to.terminal() {
                    c.ops.push(Op::ReleaseAll);
                }
                if c.hold.is_some() {
                    self.store.alert(
                        now,
                        Some(row.id()),
                        "held",
                        c.hold.as_deref().unwrap_or(""),
                    )?;
                }
                c.detail.port_errors = 0;
                if c.to != row.state {
                    c.detail.unresolved = 0;
                }
                Ok(self.store.transition(row, &self.id, now, &c)?)
            }
        }
    }

    fn fail(&self, row: &RunRow, now: u64, why: Reason, to: RunState) -> Next {
        let mut d = row.detail.clone();
        d.reason = Some(why.clone());
        Next::Go(change(to, d, now, format!("{why:?}")))
    }

    /// Cannot tell yet (a lagging node, a missing history): look again a
    /// bounded number of times, then hold for an operator.
    fn indeterminate(&self, row: &RunRow, now: u64) -> Next {
        let mut d = row.detail.clone();
        d.unresolved += 1;
        if d.unresolved >= row.spec.budget.max_port_errors {
            let mut c = change(row.state, d, now, "hold: Indeterminate");
            c.hold = Some(format!("{:?}", Reason::Indeterminate));
            return Next::Go(c);
        }
        Next::Go(change(
            row.state,
            d,
            now + self.params.poll,
            "indeterminate; look again",
        ))
    }

    /// Cancel or deadline, for states with nothing in flight.
    fn stop_if_due(&self, row: &RunRow, now: u64) -> Option<Next> {
        if row.cancel_requested {
            let mut d = row.detail.clone();
            d.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: format!("cancelled in {}", row.state.name()),
            });
            return Some(Next::Go(change(
                RunState::Cancelled,
                d,
                now,
                "cancel requested",
            )));
        }
        if now + self.params.deadline_margin >= row.spec.deadline_slot {
            let mut d = row.detail.clone();
            d.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: format!("deadline passed in {}", row.state.name()),
            });
            return Some(Next::Go(change(RunState::Expired, d, now, "deadline")));
        }
        None
    }

    fn decide(&mut self, row: &RunRow, now: u64, rep: &mut TickReport) -> Result<Next, Fault> {
        use RunState::*;
        match row.state {
            Accepted => self.on_accepted(row, now),
            Reserved => self.on_reserved(row, now, rep),
            FacilityRequested | FacilitySubmitted => self.on_facility_in_flight(row, now),
            FacilityConfirmed => self.on_facility_confirmed(row, now, rep),
            ShipRequested | ShipSubmitted => self.on_ship_in_flight(row, now),
            InTransit => self.on_in_transit(row, now),
            Arrived => self.on_arrived(row, now),
            Fulfilled | Partial | Failed | Cancelled | Expired => Ok(Next::Wait(u64::MAX)),
        }
    }

    // ----- Accepted → Reserved -------------------------------------------

    /// The inputs available to this run at `stock` now: canonical stores
    /// minus what other open runs reserved there.
    fn free_stock(
        &self,
        row: &RunRow,
        place: &PlaceRef,
    ) -> Result<Option<(PlaceView, Res)>, Fault> {
        let Some(v) = self.chain.place(place)? else {
            return Ok(None);
        };
        let other = self
            .store
            .reserved_by_others(ResKind::Stock, &place.slot_key(), row.id())?;
        let free = res_sub(&v.stores, &other);
        Ok(Some((v, free)))
    }

    fn rights_free(&self, row: &RunRow) -> Result<Result<(), Reason>, Fault> {
        let s = &row.spec;
        let other = self.store.reserved_by_others(
            ResKind::Rights,
            &format!("{}:{:?}", s.owner, s.facility),
            row.id(),
        )?[0];
        Ok(
            match self.rights.check(s.owner, &s.facility, s.rights_units)? {
                RightsVerdict::Allowed { remaining, .. } if remaining >= s.rights_units + other => {
                    Ok(())
                }
                RightsVerdict::Allowed { .. } | RightsVerdict::Insufficient { .. } => {
                    Err(Reason::RightsInsufficient)
                }
                RightsVerdict::Expired | RightsVerdict::None => Err(Reason::RightsExpired),
            },
        )
    }

    fn inbound_lost(&self, row: &RunRow) -> Result<bool, Fault> {
        let Some(k) = row.spec.inbound else {
            return Ok(false);
        };
        let key = k.text();
        if let Some((_, r)) = self.store.raid_seen(&key)? {
            if r.choice == frontier_abi::v2::log::raid_choice::TAKE {
                return Ok(true);
            }
        }
        if let Some((_, s)) = self.store.settle_seen(&key)? {
            let ours = s.dst.slot_key() == row.spec.stock.slot_key();
            let none = s
                .credited
                .map_or(res_is_zero(&s.cargo), |c| res_is_zero(&c));
            return Ok(
                s.outcome != frontier_abi::v2::log::caravan_outcome::DELIVERED || !ours || none,
            );
        }
        Ok(false)
    }

    fn on_accepted(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        if let Some(n) = self.stop_if_due(row, now) {
            return Ok(n);
        }
        let s = &row.spec;
        let Some((v, free)) = self.free_stock(row, &s.stock)? else {
            return Ok(self.fail(row, now, Reason::InputShort, RunState::Failed));
        };
        if !v.live || v.owner != s.owner {
            return Ok(self.fail(row, now, Reason::InputShort, RunState::Failed));
        }
        if !res_ge(&free, &s.inputs) {
            // The materials have not arrived (or are spoken for): wait,
            // unless the caravan bringing them is known lost.
            if self.inbound_lost(row)? {
                return Ok(self.fail(row, now, Reason::InputLost, RunState::Failed));
            }
            return Ok(Next::Wait(now + self.params.poll));
        }
        if let Err(why) = self.rights_free(row)? {
            return Ok(self.fail(row, now, why, RunState::Failed));
        }
        let mut c = change(
            RunState::Reserved,
            row.detail.clone(),
            now,
            "inputs and right reserved",
        );
        c.ops = vec![
            Op::Reserve {
                kind: ResKind::Stock,
                place: s.stock.slot_key(),
                amount: s.inputs,
            },
            Op::Reserve {
                kind: ResKind::Rights,
                place: format!("{}:{:?}", s.owner, s.facility),
                amount: {
                    let mut a = ZERO;
                    a[0] = s.rights_units;
                    a
                },
            },
        ];
        Ok(Next::Go(c))
    }

    // ----- Reserved → FacilityRequested (send) ---------------------------

    fn budget_left(&self, row: &RunRow, attempts: u32, fee: u64) -> Option<Reason> {
        if attempts >= row.spec.budget.max_attempts {
            return Some(Reason::AttemptsExhausted);
        }
        if row.detail.fee_committed.saturating_add(fee) > row.spec.budget.max_fee {
            return Some(Reason::BudgetExhausted);
        }
        None
    }

    fn on_reserved(&mut self, row: &RunRow, now: u64, rep: &mut TickReport) -> Result<Next, Fault> {
        if let Some(n) = self.stop_if_due(row, now) {
            return Ok(n);
        }
        let s = row.spec.clone();
        // Just before the send: the canonical stock and right, again.
        if let Err(why) = self.rights_free(row)? {
            return Ok(self.fail(row, now, why, RunState::Failed));
        }
        let fac = self.chain.place(&s.facility.place)?;
        if !fac.is_some_and(|f| f.live && f.gen == s.facility.place.gen) {
            return Ok(self.fail(row, now, Reason::FacilityGone, RunState::Failed));
        }
        let Some((_, free)) = self.free_stock(row, &s.stock)? else {
            return Ok(self.fail(row, now, Reason::InputShort, RunState::Failed));
        };
        if !res_ge(&free, &s.inputs) {
            let mut c = change(
                RunState::Accepted,
                row.detail.clone(),
                now + self.params.poll,
                "stock short at send",
            );
            c.ops.push(Op::ReleaseAll);
            return Ok(Next::Go(c));
        }
        let req = Request::UseFacility {
            key: s.facility_key(),
            holder: s.owner,
            facility: s.facility,
            stock: s.stock,
            inputs: s.inputs,
            outputs: s.outputs,
            rights_units: s.rights_units,
        };
        let prepared = self.chain.prepare(&req, row.detail.fac_attempts)?;
        if let Some(why) = self.budget_left(row, row.detail.fac_attempts, prepared.fee) {
            return Ok(self.fail(row, now, why, RunState::Failed));
        }
        let mut d = row.detail.clone();
        d.fac_attempts += 1;
        d.fee_committed += prepared.fee;
        let mut c = change(
            RunState::FacilityRequested,
            d,
            now + 1,
            "facility request signed",
        );
        c.unless_cancelled = true;
        c.ops.push(Op::AttemptIntent {
            step: Step::Facility,
            prepared: prepared.clone(),
        });
        // Durable first: if this write fails (stale, cancelled), nothing
        // is sent.
        if !self.store.transition(row, &self.id, now, &c)? {
            return Err(Fault::Stale);
        }
        self.crash_at("facility.before_send")?;
        let row = self.store.load(row.id())?.ok_or("vanished")?;
        self.send_and_record(&row, Step::Facility, &prepared, now, rep)
    }

    /// Sends a journalled attempt and records the answer. The answer is
    /// never taken as the outcome: `Accepted` moves to *Submitted*, a
    /// preflight refusal is checked against the canonical side next.
    fn send_and_record(
        &mut self,
        row: &RunRow,
        step: Step,
        p: &Prepared,
        now: u64,
        rep: &mut TickReport,
    ) -> Result<Next, Fault> {
        rep.sends += 1;
        let res = self.chain.send(p);
        self.crash_at(match step {
            Step::Facility => "facility.after_send",
            Step::Ship => "ship.after_send",
        })?;
        let (submitted, req_state) = match step {
            Step::Facility => (RunState::FacilitySubmitted, RunState::FacilityRequested),
            Step::Ship => (RunState::ShipSubmitted, RunState::ShipRequested),
        };
        let (to, status, reason) = match &res {
            SendResult::Accepted => (
                submitted,
                "sent",
                "accepted by the execution path".to_string(),
            ),
            SendResult::Unknown(e) => (req_state, "unknown", format!("no answer: {e}")),
            SendResult::Rejected(r) => (req_state, "rejected", format!("preflight: {r:?}")),
        };
        let mut c = change(to, row.detail.clone(), now + 1, reason);
        c.ops.push(Op::AttemptStatus {
            sig: p.sig.clone(),
            status,
        });
        if let SendResult::Rejected(r) = &res {
            // A preflight refusal costs nothing: give the fee back.
            c.detail.fee_committed = c.detail.fee_committed.saturating_sub(p.fee);
            if let Some(Next::Go(mut f)) = self.definitive_reject(row, step, r, now) {
                f.ops.extend(c.ops);
                f.detail.fee_committed = c.detail.fee_committed;
                if f.to.terminal() {
                    f.ops.push(Op::ReleaseAll);
                }
                c = f;
            } else {
                // AlreadyDone / SeqMismatch / Expired: the canonical lookup decides.
                c.next_check = now;
            }
        }
        Ok(Next::Done(self.store.transition(row, &self.id, now, &c)?))
    }

    /// A refusal that ends the run (the canonical state says no).
    fn definitive_reject(&self, row: &RunRow, step: Step, r: &Reject, now: u64) -> Option<Next> {
        let why = match (step, r) {
            (_, Reject::AlreadyDone | Reject::SeqMismatch | Reject::Expired) => return None,
            (_, Reject::RightsExpired) => Reason::RightsExpired,
            (_, Reject::RightsInsufficient) => Reason::RightsInsufficient,
            (_, Reject::FacilityGone) => Reason::FacilityGone,
            (Step::Facility, Reject::Insufficient) => Reason::InputShort,
            (Step::Ship, Reject::Insufficient) => Reason::OutputShort,
            (_, Reject::DestinationChanged) => Reason::DestinationChanged,
            (_, Reject::WalletRequired) => {
                // Back to FacilityConfirmed so the owner's seq is free for
                // their other runs; a person signs (or cancels) this one.
                let mut d = row.detail.clone();
                d.ship_seq = None;
                let mut c = change(RunState::FacilityConfirmed, d, now, "hold: WalletRequired");
                c.hold = Some(format!("{:?}", Reason::WalletRequired));
                return Some(Next::Go(c));
            }
            (_, Reject::Other(e)) => Reason::FacilityRejected(e.clone()),
        };
        // A refusal while in flight could only be this attempt's: earlier
        // ones are decided before a new one is signed.
        Some(self.fail(row, now, why, RunState::Failed))
    }

    // ----- Facility in flight → Confirmed / Reserved / … ----------------

    fn on_facility_in_flight(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        // 1. The canonical record by key decides, whatever the answers said.
        if let Some(u) = self.chain.facility_use(&s.facility_key())? {
            self.crash_at("facility.after_confirm")?;
            let atts = self.store.attempts(row.id(), Step::Facility)?;
            let mut d = row.detail.clone();
            // Only the landed attempt was charged; the others never landed.
            let unlanded = undecided_fees(&atts, &u.sig);
            d.fee_committed = d.fee_committed.saturating_sub(unlanded);
            let mut c = change(
                RunState::FacilityConfirmed,
                d,
                now,
                "facility use read on the canonical side",
            );
            c.ops.push(Op::ReleaseAll);
            for a in &atts {
                if is_undecided(a) {
                    c.ops.push(Op::AttemptStatus {
                        sig: a.prepared.sig.clone(),
                        status: if a.prepared.sig == u.sig {
                            "landed"
                        } else {
                            "expired"
                        },
                    });
                }
            }
            c.ops.push(Op::Reserve {
                kind: ResKind::Stock,
                place: s.stock.slot_key(),
                amount: s.ship.cargo,
            });
            c.ops.push(Op::Receipt(Receipt {
                run_id: row.id().to_string(),
                kind: "facility_used".into(),
                subject: u.key.clone(),
                source: format!("sig:{}", u.sig),
                slot: u.slot,
                body: serde_json::to_value(&u).unwrap_or_default(),
            }));
            return Ok(Next::Go(c));
        }
        // 2. Not there: every attempt must be decided before anything else.
        match self.undecided(row, Step::Facility, now)? {
            Undecided::Waiting(at) => Ok(Next::Wait(at)),
            Undecided::Failed(r) => {
                Ok(self
                    .definitive_reject(row, Step::Facility, &r, now)
                    .unwrap_or_else(|| {
                        // AlreadyDone without a record: the read raced the write.
                        Next::Wait(now + 1)
                    }))
            }
            Undecided::Indeterminate => Ok(self.indeterminate(row, now)),
            Undecided::NoneCanLand(ops, refund) => {
                if let Some(Next::Go(mut c)) = self.stop_if_due(row, now) {
                    c.ops.extend(ops);
                    c.detail.fee_committed = c.detail.fee_committed.saturating_sub(refund);
                    return Ok(Next::Go(c));
                }
                // Back to Reserved: the next attempt passes fresh checks.
                let mut d = row.detail.clone();
                d.fee_committed = d.fee_committed.saturating_sub(refund);
                let mut c = change(RunState::Reserved, d, now, "no attempt can land; retry");
                c.ops = ops;
                Ok(Next::Go(c))
            }
        }
    }

    /// The journalled attempts of a step that are not yet known decided.
    /// Re-broadcasts an attempt whose send never happened (a crash after
    /// its intent): the same signature can take effect only once.
    fn undecided(&mut self, row: &RunRow, step: Step, now: u64) -> Result<Undecided, Fault> {
        let atts = self.store.attempts(row.id(), step)?;
        let mut ops = vec![];
        let mut refund = 0u64;
        let mut wait: Option<u64> = None;
        for a in atts.iter().filter(|a| is_undecided(a)) {
            match self.chain.status(&a.prepared.sig, a.prepared.valid_until)? {
                SigStatus::Landed { .. } => {
                    // Landed but no canonical record found by the caller:
                    // the caller's lookup is the authority; look again soon.
                    wait = Some(now + 1);
                }
                SigStatus::Failed { reject, .. } => {
                    ops.push(Op::AttemptStatus {
                        sig: a.prepared.sig.clone(),
                        status: "failed",
                    });
                    if !matches!(reject, Reject::AlreadyDone | Reject::SeqMismatch) {
                        return Ok(Undecided::Failed(reject));
                    }
                }
                SigStatus::Pending => {
                    if a.status != "sent" {
                        // Journalled but maybe never sent (a crash), or sent
                        // without an answer: the same bytes again. One
                        // signature takes effect at most once.
                        let _ = self.chain.send(&a.prepared);
                    }
                    wait = Some(
                        wait.map_or(a.prepared.valid_until + 1, |w| {
                            w.min(a.prepared.valid_until + 1)
                        })
                        .min(now + self.params.poll),
                    );
                }
                SigStatus::Absent => {
                    refund += a.prepared.fee;
                    ops.push(Op::AttemptStatus {
                        sig: a.prepared.sig.clone(),
                        status: "expired",
                    })
                }
                SigStatus::Unavailable => return Ok(Undecided::Indeterminate),
            }
        }
        Ok(match wait {
            Some(at) => Undecided::Waiting(at.max(now + 1)),
            None => Undecided::NoneCanLand(ops, refund),
        })
    }

    // ----- FacilityConfirmed → ShipRequested (send) ----------------------

    fn on_facility_confirmed(
        &mut self,
        row: &RunRow,
        now: u64,
        rep: &mut TickReport,
    ) -> Result<Next, Fault> {
        let s = row.spec.clone();
        if let Some(Next::Go(mut c)) = self.stop_if_due(row, now) {
            c.detail.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: "outputs stay at stock".into(),
            });
            return Ok(Next::Go(c));
        }
        // Just before the send: the destination's generation and the
        // outputs at stock, from the canonical side (the facility receipt
        // says they were made, not that they are still there).
        match self.chain.place(&s.ship.dst)? {
            Some(v) if v.live && v.gen == s.ship.dst.gen => {}
            _ => return Ok(self.fail(row, now, Reason::DestinationChanged, RunState::Failed)),
        }
        let Some((v, free)) = self.free_stock(row, &s.stock)? else {
            return Ok(self.fail(row, now, Reason::OutputShort, RunState::Failed));
        };
        if !res_ge(&v.stores, &s.ship.cargo) {
            return Ok(self.fail(row, now, Reason::OutputShort, RunState::Failed));
        }
        if !res_ge(&free, &s.ship.cargo) {
            // Spoken for by another run whose own send may already have
            // debited the stock: wait for it to be decided (bounded by the
            // deadline), never fail on the overlap.
            return Ok(Next::Wait(now + self.params.poll));
        }
        // One send in flight per owner: two runs pinning the same seq would
        // only refuse each other (and spend attempts).
        if self.store.owner_send_in_flight(s.owner, row.id())? {
            return Ok(Next::Wait(now + 1));
        }
        // Pin the seq from the canonical counter.
        let seq = self.chain.caravan_seq(s.owner)?;
        let req = Request::SendCaravan {
            owner: s.owner,
            seq,
            src: s.stock,
            dst: s.ship.dst,
            cargo: s.ship.cargo,
        };
        debug_assert!(crate::policy::instruction_of(&req).is_some_and(crate::policy::automatable));
        let prepared = self.chain.prepare(&req, row.detail.ship_attempts)?;
        if let Some(why) = self.budget_left(row, row.detail.ship_attempts, prepared.fee) {
            return Ok(self.fail(row, now, why, RunState::Failed));
        }
        let mut d = row.detail.clone();
        d.ship_attempts += 1;
        d.fee_committed += prepared.fee;
        d.ship_seq = Some(seq);
        let mut c = change(
            RunState::ShipRequested,
            d,
            now + 1,
            format!("SendCaravan signed, seq {seq} pinned"),
        );
        c.unless_cancelled = true;
        c.sole_owner_send = true;
        c.ops.push(Op::AttemptIntent {
            step: Step::Ship,
            prepared: prepared.clone(),
        });
        if !self.store.transition(row, &self.id, now, &c)? {
            return Err(Fault::Stale);
        }
        self.crash_at("ship.before_send")?;
        let row = self.store.load(row.id())?.ok_or("vanished")?;
        self.send_and_record(&row, Step::Ship, &prepared, now, rep)
    }

    // ----- Ship in flight → InTransit / FacilityConfirmed / … ------------

    fn on_ship_in_flight(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        let seq = row.detail.ship_seq.ok_or("ship in flight without a seq")?;
        let key = CaravanKey {
            owner: s.owner,
            seq,
        };
        let atts = self.store.attempts(row.id(), Step::Ship)?;
        let current: Vec<_> = atts
            .iter()
            .filter(|a| a.request_key == key.text())
            .collect();
        // 1. One of our signatures for this seq landed: the send is ours.
        let mut history_missing = false;
        let mut landed_sig = None;
        let mut landed_slot = now;
        for a in &current {
            match self.chain.status(&a.prepared.sig, a.prepared.valid_until)? {
                SigStatus::Landed { slot } => {
                    landed_sig = Some(a.prepared.sig.clone());
                    landed_slot = slot;
                }
                SigStatus::Unavailable => history_missing = true,
                _ => {}
            }
        }
        // 2. Without statuses, the entity history names the signature.
        if landed_sig.is_none() && history_missing {
            match self.chain.caravan_history(key)? {
                Some(h) => {
                    landed_sig = h.iter().find_map(|r| match &r.event {
                        Event::CaravanSent { sig, .. }
                            if current.iter().any(|a| &a.prepared.sig == sig) =>
                        {
                            Some(sig.clone())
                        }
                        _ => None,
                    });

                    let other = h.iter().any(|r| {
                        matches!(&r.event, Event::CaravanSent { sig, .. }
                            if !current.iter().any(|a| &a.prepared.sig == sig))
                    });
                    if landed_sig.is_none() && other {
                        // The seq made another sender's caravan: none of
                        // ours can take effect any more (fees stay counted:
                        // one may still land, failed).
                        let ops = current
                            .iter()
                            .filter(|a| is_undecided(a))
                            .map(|a| Op::AttemptStatus {
                                sig: a.prepared.sig.clone(),
                                status: "superseded",
                            })
                            .collect();
                        return Ok(self.repin(row, now, ops, 0, seq, true));
                    }
                }
                None => return Ok(self.indeterminate(row, now)),
            }
        }
        if let Some(sig) = landed_sig {
            self.crash_at("ship.after_confirm")?;
            let view = self.chain.caravan(key)?;
            let mut d = row.detail.clone();
            let unlanded = undecided_fees(&atts, &sig);
            d.fee_committed = d.fee_committed.saturating_sub(unlanded);
            d.sent_cargo = view.as_ref().map(|v| v.cargo).or(d.sent_cargo);
            let mut c = change(
                RunState::InTransit,
                d,
                now,
                format!("caravan {} is ours (sig landed)", key.text()),
            );
            c.ops.push(Op::ReleaseAll);
            for a in &atts {
                if is_undecided(a) {
                    c.ops.push(Op::AttemptStatus {
                        sig: a.prepared.sig.clone(),
                        status: if a.prepared.sig == sig {
                            "landed"
                        } else {
                            "expired"
                        },
                    });
                }
            }
            c.ops.push(Op::Receipt(Receipt {
                run_id: row.id().to_string(),
                kind: "caravan_sent".into(),
                subject: key.text(),
                source: format!("sig:{sig}"),
                slot: landed_slot,
                body: serde_json::json!({ "seq": seq, "cargo": view.map(|v| v.cargo) }),
            }));
            return Ok(Next::Go(c));
        }
        if history_missing {
            return Ok(self.indeterminate(row, now));
        }
        // 3. Not ours (yet): decide every attempt before a new seq is pinned.
        match self.undecided(row, Step::Ship, now)? {
            Undecided::Waiting(at) => Ok(Next::Wait(at)),
            Undecided::Indeterminate => Ok(self.indeterminate(row, now)),
            Undecided::Failed(r) => Ok(self
                .definitive_reject(row, Step::Ship, &r, now)
                .unwrap_or(Next::Wait(now + 1))),
            Undecided::NoneCanLand(ops, refund) => {
                let taken = self.chain.caravan_seq(s.owner)? > seq;
                Ok(self.repin(row, now, ops, refund, seq, taken))
            }
        }
    }

    /// No send of the pinned seq can take effect: stop (cancel, deadline)
    /// or go back to FacilityConfirmed, where fresh checks pin a new seq.
    fn repin(
        &self,
        row: &RunRow,
        now: u64,
        ops: Vec<Op>,
        refund: u64,
        seq: u32,
        taken: bool,
    ) -> Next {
        if let Some(Next::Go(mut c)) = self.stop_if_due(row, now) {
            c.ops.extend(ops);
            c.detail.fee_committed = c.detail.fee_committed.saturating_sub(refund);
            c.detail.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: "outputs stay at stock".into(),
            });
            return Next::Go(c);
        }
        let mut d = row.detail.clone();
        d.ship_seq = None;
        d.fee_committed = d.fee_committed.saturating_sub(refund);
        let mut c = change(
            RunState::FacilityConfirmed,
            d,
            now,
            if taken {
                format!("seq {seq} was taken by another send; re-pin")
            } else {
                "no attempt can land; retry".to_string()
            },
        );
        c.ops = ops;
        c.ops.push(Op::Reserve {
            kind: ResKind::Stock,
            place: row.spec.stock.slot_key(),
            amount: row.spec.ship.cargo,
        });
        Next::Go(c)
    }

    // ----- InTransit → Arrived / Failed ----------------------------------

    fn on_in_transit(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        let key = CaravanKey {
            owner: s.owner,
            seq: row.detail.ship_seq.ok_or("in transit without a seq")?,
        };
        let raid = self.raid_record(key)?;
        match self.chain.caravan(key)? {
            Some(v) if v.owner_now == s.owner => {
                // Moving and ours (a burn leaves it moving, empty).
                let mut d = row.detail.clone();
                if let Some((src, r)) = raid.filter(|_| d.raid.is_none()) {
                    d.raid = Some(r.clone());
                    let mut c = change(
                        RunState::InTransit,
                        d,
                        v.arrive_slot.max(now + 1),
                        "raid seen (burn)",
                    );
                    c.ops.push(Op::Receipt(raid_receipt(row, &r, &src)));
                    return Ok(Next::Go(c));
                }
                Ok(Next::Wait(
                    v.arrive_slot.max(now + 1).min(now + 4 * self.params.poll),
                ))
            }
            Some(_) => {
                // Taken: the caravan is the raider's now (J2).
                let mut d = row.detail.clone();
                d.reason = Some(Reason::Raided);
                d.outcome = Some(Outcome {
                    delivered: ZERO,
                    credit_unverified: false,
                    note: "taken by a raider".into(),
                });
                let mut c = change(RunState::Failed, d.clone(), now, "caravan taken");
                if let Some((src, r)) = raid {
                    c.ops.push(Op::Receipt(raid_receipt(row, &r, &src)));
                    c.detail.raid = Some(r);
                }
                Ok(Next::Go(c))
            }
            None => {
                // Closed: settled. The settle record says how.
                match self.settle_record(key)? {
                    Some((src, st)) => {
                        let mut d = row.detail.clone();
                        d.settle = Some(st.clone());
                        if let Some((_, r)) = raid {
                            d.raid = Some(r);
                        }
                        let mut c = change(RunState::Arrived, d, now, "settlement read");
                        c.ops.push(Op::Receipt(Receipt {
                            run_id: row.id().to_string(),
                            kind: "caravan_settled".into(),
                            subject: key.text(),
                            source: src,
                            slot: st.slot,
                            body: serde_json::to_value(&st).unwrap_or_default(),
                        }));
                        Ok(Next::Go(c))
                    }
                    None => Ok(self.indeterminate(row, now)),
                }
            }
        }
    }

    fn raid_record(&self, key: CaravanKey) -> Result<Option<(String, Raid)>, Fault> {
        if let Some((id, r)) = self.store.raid_seen(&key.text())? {
            return Ok(Some((format!("event:{id}"), r)));
        }
        Ok(None)
    }

    /// The settlement from the feed, else from the entity history.
    fn settle_record(&self, key: CaravanKey) -> Result<Option<(String, Settle)>, Fault> {
        if let Some((id, s)) = self.store.settle_seen(&key.text())? {
            return Ok(Some((format!("event:{id}"), s)));
        }
        let Some(h) = self.chain.caravan_history(key)? else {
            return Ok(None);
        };
        Ok(h.into_iter().find_map(|r| match r.event {
            Event::CaravanSettled(s) => Some((format!("history:{}", r.id), s)),
            _ => None,
        }))
    }

    // ----- Arrived → Fulfilled / Partial / Failed ------------------------

    fn on_arrived(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        let st = row
            .detail
            .settle
            .clone()
            .ok_or("arrived without a settlement")?;
        let mut d = row.detail.clone();
        let to_us = st.dst == s.ship.dst;
        if !to_us {
            // A take we did not see: it settled at the raider's.
            d.reason = Some(Reason::Raided);
            d.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: "settled at another destination (taken)".into(),
            });
            return Ok(Next::Go(change(
                RunState::Failed,
                d,
                now,
                "settled elsewhere",
            )));
        }
        if st.outcome != frontier_abi::v2::log::caravan_outcome::DELIVERED {
            d.reason = Some(Reason::DestinationChanged);
            d.outcome = Some(Outcome {
                delivered: ZERO,
                credit_unverified: false,
                note: "destination gone or of another generation at arrival: cargo lost".into(),
            });
            return Ok(Next::Go(change(
                RunState::Failed,
                d,
                now,
                "lost at arrival",
            )));
        }
        let (delivered, unverified) = match st.credited {
            Some(c) => (c, false),
            None => {
                // Today's record: the cargo, not what was kept. A vault at
                // capacity may have dropped some; say so instead of claiming.
                let clipped = match self.chain.place(&s.ship.dst)? {
                    Some(v) => v.cap.is_some_and(|cap| {
                        st.cargo
                            .iter()
                            .zip(v.stores.iter())
                            .any(|(c, h)| *c > 0 && *h >= cap)
                    }),
                    None => true,
                };
                (st.cargo, clipped)
            }
        };
        let note;
        let to = if res_is_zero(&delivered) {
            d.reason = Some(Reason::LostInTransit);
            note = "nothing delivered (burned)".to_string();
            RunState::Failed
        } else if res_ge(&delivered, &s.ship.cargo) && !unverified {
            note = "delivered in full".into();
            RunState::Fulfilled
        } else {
            note = if unverified {
                "delivered; the destination may have dropped some at capacity (unverified)".into()
            } else {
                "delivered less than asked (wear, capacity)".into()
            };
            RunState::Partial
        };
        d.outcome = Some(Outcome {
            delivered,
            credit_unverified: unverified,
            note: note.clone(),
        });
        Ok(Next::Go(change(to, d, now, note)))
    }
}

/// Journalled but not yet known landed, failed or expired.
fn is_undecided(a: &crate::store::AttemptRow) -> bool {
    matches!(a.status.as_str(), "intent" | "sent" | "unknown")
}

/// The fees of undecided attempts other than `landed`: they can no longer
/// land once one attempt of the same key has (the key refuses a second).
fn undecided_fees(atts: &[crate::store::AttemptRow], landed: &str) -> u64 {
    atts.iter()
        .filter(|a| is_undecided(a) && a.prepared.sig != landed)
        .map(|a| a.prepared.fee)
        .sum()
}

fn raid_receipt(row: &RunRow, r: &Raid, source: &str) -> Receipt {
    Receipt {
        run_id: row.id().to_string(),
        kind: "caravan_raided".into(),
        subject: r.key.text(),
        source: source.to_string(),
        slot: r.slot,
        body: serde_json::to_value(r).unwrap_or_default(),
    }
}

enum Undecided {
    /// Something may still land: look again at this slot.
    Waiting(u64),
    /// An attempt landed failed with a definitive refusal.
    Failed(Reject),
    /// Every attempt is decided and none took effect (ops record that;
    /// the fee of those that can never land is given back).
    NoneCanLand(Vec<Op>, u64),
    /// No status history: cannot tell.
    Indeterminate,
}

enum Fault {
    Halt(Halt),
    Stale,
    Port(PortError),
}

impl From<PortError> for Fault {
    fn from(e: PortError) -> Fault {
        Fault::Port(e)
    }
}
impl From<String> for Fault {
    fn from(e: String) -> Fault {
        Fault::Halt(Halt::Store(e))
    }
}
impl From<&str> for Fault {
    fn from(e: &str) -> Fault {
        Fault::Halt(Halt::Store(e.to_string()))
    }
}
impl From<Halt> for Fault {
    fn from(h: Halt) -> Fault {
        Fault::Halt(h)
    }
}
