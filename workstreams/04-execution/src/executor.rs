//! The executor: one tick reads the feed, then advances each due run it can
//! lease by at most one external action.
//!
//! **How a resource change is held to once** (no "exactly once" over the
//! network is claimed):
//! 1. *Identity.* Each external step has a request key fixed before its
//!    first attempt: `fac:<run_id>` for the facility use, the caravan
//!    `(owner_tag, seq)` for SendCaravan (the program refuses a seq other
//!    than `Citizen.CARAVANS`).
//! 2. *Write-ahead.* The signed attempt (its wire bytes) is journalled
//!    (`intent`) in the same transaction as the state that sends it, before
//!    the send.
//! 3. *Canonical confirmation.* A step is confirmed only by a canonical
//!    read naming *our* signature (the facility record by key; our
//!    signature landed; a `CaravanSent` with our signature), and its content
//!    (places, resources, amounts) is checked against the spec. Never by the
//!    send's answer, never by `(owner, seq)` alone.
//! 4. *Refusal of duplicates.* A second attempt with the same key is
//!    refused by the canonical side (`AlreadyDone`, seq mismatch); a new
//!    attempt is only signed once every earlier one is decided: landed, or
//!    past its validity and absent from the full status history.
//! 5. *Fencing of the store.* Every write is a compare-and-swap on the run's
//!    version and the lease epoch, so a stale executor writes nothing and
//!    signs nothing new.
//!
//! **What the store cannot fence** (`docs/STATE-MACHINE.ja.md`, 取消の限界):
//! bytes already signed. A paused executor that wakes after a lease
//! hand-over or a cancel can still send them, and the chain, which never
//! sees this store, accepts them until their blockhash expires. So a cancel
//! completes only once every signed attempt is past `valid_until` and
//! decided, and reports what landed before (`CancelPhase`).

use crate::model::*;
use crate::ports::*;
use crate::store::{AttemptRow, Change, Op, Receipt, ResKind, RunRow, Step, Store};

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
    /// Slots past a caravan's arrival without a settlement before the run
    /// is held SettlementOverdue (about two 600-s bells at 400-ms slots).
    pub settle_grace: u64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            lease: 8,
            poll: 2,
            max_runs_per_tick: 64,
            deadline_margin: 0,
            settle_grace: 3_000,
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
    pub reconciled: usize,
}

pub struct Executor<C: Chain, R: Rights> {
    pub id: String,
    pub store: Store,
    pub chain: C,
    pub rights: R,
    pub params: Params,
    pub crash: Option<CrashPlan>,
    /// Test hook, called at named points between a check and the write it
    /// guards (`ship.before_pin`), to interleave another executor there.
    pub hook: Option<Box<dyn FnMut(&'static str)>>,
    /// The store is bound to the chain port's world (checked once).
    world_ok: bool,
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

fn status_op(sig: &str, status: &'static str, fee: Option<u64>) -> Op {
    Op::AttemptStatus {
        sig: sig.to_string(),
        status,
        fee,
    }
}

/// Journalled and not yet known landed, failed, superseded or expired. A
/// preflight refusal (`rejected`) is included: the same signed bytes can
/// still land elsewhere until their validity ends.
fn is_undecided(a: &AttemptRow) -> bool {
    matches!(
        a.status.as_str(),
        "intent" | "sent" | "unknown" | "rejected"
    )
}

/// What the attempts of a step came to.
enum Undecided {
    /// Something may still land: look again at this slot.
    Waiting { at: u64, until: u64 },
    /// Every attempt is decided and none took effect. `ops` record that;
    /// `reject` is the last definitive refusal among landed failures.
    Decided {
        ops: Vec<Op>,
        reject: Option<Reject>,
    },
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

/// The reason a refusal ends a step with (`None`: the lookup decides).
fn reason_of(step: Step, r: &Reject) -> Option<Reason> {
    Some(match (step, r) {
        (_, Reject::AlreadyDone | Reject::SeqMismatch | Reject::Expired) => return None,
        (_, Reject::RightsExpired) => Reason::RightsExpired,
        (_, Reject::RightsInsufficient) => Reason::RightsInsufficient,
        (_, Reject::FacilityGone) => Reason::FacilityGone,
        (Step::Facility, Reject::Insufficient) => Reason::InputShort,
        (Step::Ship, Reject::Insufficient) => Reason::OutputShort,
        (_, Reject::DestinationChanged) => Reason::DestinationChanged,
        (_, Reject::WalletRequired) => Reason::WalletRequired,
        (_, Reject::Other(e)) => Reason::FacilityRejected(e.clone()),
        (_, Reject::Refused(code)) => Reason::GatewayRefused(code.clone()),
        (_, Reject::WorldClosed) => Reason::WorldClosed,
    })
}

/// The content of a send as the canonical side recorded it.
#[derive(Clone)]
struct Sent {
    /// The signature that made it (empty when read from the account).
    sig: String,
    src: PlaceRef,
    dst: PlaceRef,
    cargo: Res,
    source: String,
}

/// What acceptance checks of a spec before anything is stored: an empty
/// cargo is refused, a send's two places differ, a cargo-only run carries
/// no making parts, and the attempt budget is bounded. One function for
/// [`Executor::accept`] and the `runexec run accept` command, so a spec the
/// command takes is exactly one the executor takes (same digest, no
/// conflict when the executor later sees it).
pub fn validate_spec(spec: &RunSpec) -> Result<(), String> {
    if res_is_zero(&spec.ship.cargo) {
        return Err("empty cargo".into());
    }
    if spec.ship.dst.slot_key() == spec.stock.slot_key() {
        return Err("a send's two places never share a tile".into());
    }
    if spec.cargo_only()
        && (!res_is_zero(&spec.inputs) || !res_is_zero(&spec.outputs) || spec.rights_units != 0)
    {
        return Err("a cargo-only run has no inputs, outputs or right units".into());
    }
    if spec.budget.max_attempts == 0 || spec.budget.max_attempts > 16 {
        return Err("max_attempts must be 1..=16".into());
    }
    Ok(())
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
            hook: None,
            world_ok: false,
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
        validate_spec(spec)?;
        let now = self.chain.slot().map_err(|e| format!("{e:?}"))?;
        self.store.accept(spec, now)
    }

    /// A run asked for by `req` (workstream 04, 2026-11-07): admitted only
    /// when `req` is the current holder of the pass behind the run's
    /// citizen, or its live session, at the generation it signed for
    /// ([`crate::intake::accept_checked`], workstream 20's definition).
    /// Checked before anything is stored, also for a repeated `run_id`: a
    /// previous owner or a previous owner's session cannot add a run, nor
    /// learn whether one exists. The check is kept on a new run. A run
    /// accepted before a transfer runs to its end (the owner's decision,
    /// 2026-11-07).
    pub fn accept_as(
        &self,
        spec: &RunSpec,
        req: &crate::intake::Requester,
        passes: &impl crate::intake::Passes,
    ) -> Result<crate::store::Accept, String> {
        let now = self.chain.slot().map_err(|e| format!("{e:?}"))?;
        crate::intake::accept_checked(&self.store, spec, req, passes, now)
    }

    /// One pass: the feed, the due runs, then fee reconciliation.
    pub fn tick(&mut self) -> Result<TickReport, Halt> {
        let mut rep = TickReport::default();
        let now = match self.chain.slot() {
            Ok(s) => s,
            // Nothing can be decided without the canonical side.
            Err(_) => return Ok(rep),
        };
        rep.slot = now;
        // A store holds the runs of one world: never apply them to another.
        if !self.world_ok {
            if let Some(w) = self.chain.world() {
                match self.store.bind_world(&w) {
                    Ok(()) => self.world_ok = true,
                    Err(e) => {
                        let _ = self.store.alert(now, None, "world_mismatch", &e);
                        return Ok(rep);
                    }
                }
            } else {
                self.world_ok = true;
            }
        }
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
            if !self.step(&row, now, &mut rep)? {
                rep.stale += 1;
            }
        }
        rep.reconciled = self.reconcile_fees(now)?;
        Ok(rep)
    }

    /// Settles the fee of attempts no run waits on any more (superseded,
    /// or landed without a reported fee), once past their validity.
    fn reconcile_fees(&mut self, now: u64) -> Result<usize, Halt> {
        let mut n = 0;
        for a in self.store.attempts_to_reconcile(now, 16)? {
            let Ok(st) = self.chain.status(&a.prepared.sig, a.prepared.valid_until) else {
                break;
            };
            let (status, fee) = match st {
                SigStatus::Absent => ("expired", None),
                SigStatus::Landed { fee: Some(f), .. } => ("landed", Some(f)),
                SigStatus::Failed { fee: Some(f), .. } => ("failed", Some(f)),
                _ => continue,
            };
            self.store.settle_attempt(&a.prepared.sig, status, fee)?;
            n += 1;
        }
        Ok(n)
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
                if let Some(h) = &c.hold {
                    self.store.alert(now, Some(row.id()), "held", h)?;
                }
                c.detail.port_errors = 0;
                if c.to != row.state {
                    c.detail.unresolved = 0;
                }
                Ok(self.store.transition(row, &self.id, now, &c)?)
            }
        }
    }

    /// The canonical effects recorded for this run so far (receipts).
    fn effects(&self, row: &RunRow) -> Result<Vec<String>, Fault> {
        Ok(self
            .store
            .receipts(row.id())?
            .into_iter()
            .map(|r| format!("{} {}", r.kind, r.subject))
            .collect())
    }

    fn fail(&self, row: &RunRow, now: u64, why: Reason) -> Result<Next, Fault> {
        let mut d = row.detail.clone();
        d.reason = Some(why.clone());
        d.pending = None;
        if d.outcome.is_none() {
            d.outcome = Some(Outcome::stopped(self.effects(row)?, format!("{why:?}")));
        }
        Ok(Next::Go(change(
            RunState::Failed,
            d,
            now,
            format!("{why:?}"),
        )))
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

    fn hold(&self, row: &RunRow, now: u64, why: Reason) -> Next {
        let mut c = change(row.state, row.detail.clone(), now, format!("hold: {why:?}"));
        c.hold = Some(format!("{why:?}"));
        Next::Go(c)
    }

    fn deadline_passed(&self, row: &RunRow, now: u64) -> bool {
        now + self.params.deadline_margin >= row.spec.deadline_slot
    }

    /// Cancel or deadline, for a run with nothing that can still land.
    fn stop_if_due(&self, row: &RunRow, now: u64) -> Result<Option<Change>, Fault> {
        let effects = self.effects(row)?;
        let note = |what: &str| {
            if effects.is_empty() {
                format!("{what} in {}: nothing took effect", row.state.name())
            } else {
                format!(
                    "{what} in {} after: {}",
                    row.state.name(),
                    effects.join(", ")
                )
            }
        };
        let mut d = row.detail.clone();
        if row.cancel_requested {
            d.outcome = Some(Outcome::stopped(effects.clone(), note("cancelled")));
            d.cancel = Some(CancelPhase::Completed {
                effects: effects.clone(),
            });
            return Ok(Some(change(
                RunState::Cancelled,
                d,
                now,
                "cancel completed",
            )));
        }
        if self.deadline_passed(row, now) {
            d.outcome = Some(Outcome::stopped(effects.clone(), note("deadline passed")));
            return Ok(Some(change(RunState::Expired, d, now, "deadline")));
        }
        Ok(None)
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
            Fulfilled | Partial | DeliveredUnverified | Failed | Cancelled | Expired => {
                Ok(Next::Wait(u64::MAX))
            }
        }
    }

    // ----- Accepted → Reserved -------------------------------------------

    /// The goods available to this run at `place` now: canonical stores
    /// minus what other open runs of this store reserved there.
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
        let (Some(facility), Some(place)) = (s.facility, s.rights_place()) else {
            // A cargo-only run uses no right.
            return Ok(Ok(()));
        };
        let other = self
            .store
            .reserved_by_others(ResKind::Rights, &place, row.id())?[0];
        Ok(
            match self.rights.check(s.owner, &facility, s.rights_units)? {
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
        use frontier_abi::v2::log::{caravan_outcome, raid_choice};
        let key = k.text();
        let raided = |choice: u8| -> Result<bool, Fault> {
            Ok(self
                .store
                .raids_seen(&key)?
                .iter()
                .any(|(_, r)| r.key == k && r.choice == choice))
        };
        if raided(raid_choice::TAKE)? {
            return Ok(true);
        }
        if let Some((_, s)) = self.store.settle_seen(&key)? {
            // Lost only on evidence: the settle record's LOST, or a burn
            // record. A zero logged cargo (less than a unit each) or another
            // destination without a take record is not proof; the run keeps
            // waiting on the canonical stock until its deadline.
            return Ok(s.outcome != caravan_outcome::DELIVERED
                || (res_is_zero(&s.cargo) && raided(raid_choice::BURN)?));
        }
        Ok(false)
    }

    fn on_accepted(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        if let Some(c) = self.stop_if_due(row, now)? {
            return Ok(Next::Go(c));
        }
        let s = &row.spec;
        let Some((v, free)) = self.free_stock(row, &s.stock)? else {
            return self.fail(row, now, Reason::InputShort);
        };
        if !v.live || v.owner != s.owner {
            return self.fail(row, now, Reason::InputShort);
        }
        // A cargo-only run needs its cargo at stock; a making run its inputs.
        let need = if s.cargo_only() {
            s.ship.cargo
        } else {
            s.inputs
        };
        if !res_ge(&free, &need) {
            // The materials have not arrived (or are spoken for): wait,
            // unless the caravan bringing them is known lost.
            if self.inbound_lost(row)? {
                return self.fail(row, now, Reason::InputLost);
            }
            return Ok(Next::Wait(now + self.params.poll));
        }
        if s.cargo_only() {
            // No facility step: the cargo is reserved and the run goes to
            // the send, as a making run does once its facility use is read.
            let mut c = change(
                RunState::FacilityConfirmed,
                row.detail.clone(),
                now,
                "cargo only: cargo reserved, no facility step",
            );
            c.ops = vec![Op::Reserve {
                kind: ResKind::Stock,
                place: s.stock.slot_key(),
                amount: s.ship.cargo,
            }];
            return Ok(Next::Go(c));
        }
        if let Err(why) = self.rights_free(row)? {
            return self.fail(row, now, why);
        }
        let mut c = change(
            RunState::Reserved,
            row.detail.clone(),
            now,
            "inputs and right reserved",
        );
        let mut units = ZERO;
        units[0] = s.rights_units;
        c.ops = vec![
            Op::Reserve {
                kind: ResKind::Stock,
                place: s.stock.slot_key(),
                amount: s.inputs,
            },
            Op::Reserve {
                kind: ResKind::Rights,
                place: s.rights_place().unwrap_or_default(),
                amount: units,
            },
        ];
        Ok(Next::Go(c))
    }

    // ----- Reserved → FacilityRequested (send) ---------------------------

    /// Attempts and fees left: the budget counts every fee not known to be
    /// free (reserved, charged and unconfirmed; `FeeBook::exposure`).
    fn budget_left(&self, row: &RunRow, attempts: u32, fee: u64) -> Result<Option<Reason>, Fault> {
        if attempts >= row.spec.budget.max_attempts {
            return Ok(Some(Reason::AttemptsExhausted));
        }
        let book = self.store.fees(row.id())?;
        if book.exposure().saturating_add(fee) > row.spec.budget.max_fee {
            return Ok(Some(Reason::BudgetExhausted));
        }
        Ok(None)
    }

    fn on_reserved(&mut self, row: &RunRow, now: u64, rep: &mut TickReport) -> Result<Next, Fault> {
        if let Some(c) = self.stop_if_due(row, now)? {
            return Ok(Next::Go(c));
        }
        let s = row.spec.clone();
        // Just before signing: the canonical stock and right, again.
        if let Err(why) = self.rights_free(row)? {
            return self.fail(row, now, why);
        }
        let Some(facility) = s.facility else {
            // Never reached: a cargo-only run leaves Accepted for the send.
            return self.fail(row, now, Reason::FacilityGone);
        };
        let fac = self.chain.place(&facility.place)?;
        if !fac.is_some_and(|f| f.live && f.gen == facility.place.gen) {
            return self.fail(row, now, Reason::FacilityGone);
        }
        let Some((_, free)) = self.free_stock(row, &s.stock)? else {
            return self.fail(row, now, Reason::InputShort);
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
            facility,
            stock: s.stock,
            inputs: s.inputs,
            outputs: s.outputs,
            rights_units: s.rights_units,
        };
        let prepared = self.chain.prepare(&req, row.detail.fac_attempts)?;
        if let Some(why) = self.budget_left(row, row.detail.fac_attempts, prepared.fee)? {
            return self.fail(row, now, why);
        }
        let mut d = row.detail.clone();
        d.fac_attempts += 1;
        d.pending = None;
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
        // is sent. If it succeeds, the bytes exist and may be sent by this
        // process at any later time (see the module note).
        if !self.store.transition(row, &self.id, now, &c)? {
            return Err(Fault::Stale);
        }
        self.crash_at("facility.before_send")?;
        let row = self.store.load(row.id())?.ok_or("vanished")?;
        self.send_and_record(&row, Step::Facility, &prepared, now, rep)
    }

    /// Sends a journalled attempt and records the answer. The answer is
    /// never taken as the outcome: `Accepted` moves to *Submitted*; a
    /// preflight refusal is recorded and, when it is definitive, ends the
    /// step only after the attempt can no longer land (`pending`).
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
        let (submitted, requested) = match step {
            Step::Facility => (RunState::FacilitySubmitted, RunState::FacilityRequested),
            Step::Ship => (RunState::ShipSubmitted, RunState::ShipRequested),
        };
        let mut c = match &res {
            SendResult::Accepted => change(
                submitted,
                row.detail.clone(),
                now + 1,
                "accepted by the execution path",
            ),
            SendResult::Unknown(e) => change(
                requested,
                row.detail.clone(),
                now + 1,
                format!("no answer: {e}"),
            ),
            SendResult::Rejected(r) => {
                let mut d = row.detail.clone();
                let next = match reason_of(step, r) {
                    // Refused before signing: no bytes exist; decided now.
                    Some(why) if matches!(r, Reject::Refused(_)) => {
                        d.pending = Some(why);
                        now
                    }
                    Some(why) => {
                        d.pending = Some(why);
                        // Decided only once these bytes are past validity.
                        p.valid_until.saturating_add(1)
                    }
                    // AlreadyDone / SeqMismatch / Expired: the lookup decides.
                    None => now,
                };
                change(requested, d, next, format!("preflight: {r:?}"))
            }
        };
        c.ops.push(status_op(
            &p.sig,
            match res {
                SendResult::Accepted => "sent",
                SendResult::Unknown(_) => "unknown",
                SendResult::Rejected(_) => "rejected",
            },
            None,
        ));
        Ok(Next::Done(self.store.transition(row, &self.id, now, &c)?))
    }

    /// Decides the journalled attempts of a step that are still open.
    /// Re-broadcasts an attempt whose send may never have happened (a
    /// crash after its intent, a timeout) — the same signature takes effect
    /// at most once — but never once a cancel is requested or the deadline
    /// passed: those wait for the bytes to expire instead.
    fn undecided(&mut self, row: &RunRow, step: Step, now: u64) -> Result<Undecided, Fault> {
        let atts = self.store.attempts(row.id(), step)?;
        let push = !row.cancel_requested && !self.deadline_passed(row, now);
        let mut ops = vec![];
        let mut reject = None;
        let mut wait: Option<u64> = None;
        let mut until = 0;
        for a in atts.iter().filter(|a| is_undecided(a)) {
            until = until.max(a.prepared.valid_until);
            match self.chain.status(&a.prepared.sig, a.prepared.valid_until)? {
                SigStatus::Landed { .. } => {
                    // Landed but the caller found no canonical record yet
                    // (a lagging read): look again soon.
                    wait = Some(now + 1);
                }
                SigStatus::Failed { reject: r, fee, .. } => {
                    ops.push(status_op(&a.prepared.sig, "failed", fee));
                    if !matches!(r, Reject::AlreadyDone | Reject::SeqMismatch) {
                        reject = Some(r);
                    }
                }
                SigStatus::Pending => {
                    if push && matches!(a.status.as_str(), "intent" | "unknown") {
                        let _ = self.chain.send(&a.prepared);
                    }
                    let at = a
                        .prepared
                        .valid_until
                        .saturating_add(1)
                        .min(now + self.params.poll);
                    wait = Some(wait.map_or(at, |w| w.min(at)));
                }
                SigStatus::Absent => ops.push(status_op(&a.prepared.sig, "expired", None)),
                SigStatus::Unavailable => return Ok(Undecided::Indeterminate),
            }
        }
        Ok(match wait {
            Some(at) => Undecided::Waiting {
                at: at.max(now + 1),
                until,
            },
            None => Undecided::Decided { ops, reject },
        })
    }

    /// While something signed may still land: record that a cancel waits
    /// on it (once), else just wait.
    fn wait_in_flight(&self, row: &RunRow, at: u64, until: u64) -> Next {
        if row.cancel_requested
            && !matches!(row.detail.cancel, Some(CancelPhase::AwaitingSigned { .. }))
        {
            let mut d = row.detail.clone();
            d.cancel = Some(CancelPhase::AwaitingSigned { until });
            return Next::Go(change(
                row.state,
                d,
                at,
                format!("cancel waits for signed requests (valid until {until})"),
            ));
        }
        Next::Wait(at)
    }

    /// Fee and status ops for the attempts of a step once one landed.
    fn settle_attempts(&self, atts: &[AttemptRow], landed: &str) -> Result<Vec<Op>, Fault> {
        let mut ops = vec![];
        for a in atts
            .iter()
            .filter(|a| is_undecided(a) || a.prepared.sig == landed)
        {
            let st = self.chain.status(&a.prepared.sig, a.prepared.valid_until)?;
            ops.push(match (a.prepared.sig == landed, st) {
                (true, SigStatus::Landed { fee, .. }) => status_op(landed, "landed", fee),
                (true, _) => status_op(landed, "landed", None),
                (false, SigStatus::Absent) => status_op(&a.prepared.sig, "expired", None),
                (false, SigStatus::Failed { fee, .. }) => status_op(&a.prepared.sig, "failed", fee),
                // It can no longer take effect (the key is used) but may
                // still land failed: its fee stays unconfirmed until the
                // reconciliation reads it.
                (false, _) => status_op(&a.prepared.sig, "superseded", None),
            });
        }
        Ok(ops)
    }

    // ----- Facility in flight → Confirmed / Reserved / … ----------------

    fn on_facility_in_flight(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        // 1. The canonical record by key decides, whatever the answers said.
        if let Some(u) = self.chain.facility_use(&s.facility_key())? {
            let atts = self.store.attempts(row.id(), Step::Facility)?;
            if !atts.iter().any(|a| a.prepared.sig == u.sig) {
                return Ok(self.hold(
                    row,
                    now,
                    Reason::Inconsistent(format!("{} used by a signature not ours", u.key)),
                ));
            }
            if u.consumed != s.inputs || u.produced != s.outputs || u.rights_units != s.rights_units
            {
                return Ok(self.hold(
                    row,
                    now,
                    Reason::Inconsistent(format!("{} content differs from the spec", u.key)),
                ));
            }
            self.crash_at("facility.after_confirm")?;
            let mut d = row.detail.clone();
            d.pending = None;
            let mut c = change(
                RunState::FacilityConfirmed,
                d,
                now,
                "facility use read on the canonical side",
            );
            c.ops.push(Op::ReleaseAll);
            c.ops.extend(self.settle_attempts(&atts, &u.sig)?);
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
            Undecided::Waiting { at, until } => Ok(self.wait_in_flight(row, at, until)),
            Undecided::Indeterminate => Ok(self.indeterminate(row, now)),
            Undecided::Decided { ops, reject } => {
                // Nothing signed can land any more, and nothing did.
                if let Some(mut c) = self.stop_if_due(row, now)? {
                    c.ops.extend(ops);
                    return Ok(Next::Go(c));
                }
                let why = reject
                    .and_then(|r| reason_of(Step::Facility, &r))
                    .or(row.detail.pending.clone());
                if why == Some(Reason::WorldClosed) {
                    // Not a failure: nothing was used; the reservations stay
                    // and a person resumes once the world takes actions.
                    let mut d = row.detail.clone();
                    d.pending = None;
                    let mut c = change(RunState::Reserved, d, now, "hold: WorldClosed");
                    c.hold = Some(format!("{:?}", Reason::WorldClosed));
                    c.ops = ops;
                    return Ok(Next::Go(c));
                }
                if let Some(why) = why {
                    let Next::Go(mut c) = self.fail(row, now, why)? else {
                        unreachable!()
                    };
                    c.ops.extend(ops);
                    return Ok(Next::Go(c));
                }
                // Back to Reserved: the next attempt passes fresh checks.
                let mut c = change(
                    RunState::Reserved,
                    row.detail.clone(),
                    now,
                    "no attempt can land; retry",
                );
                c.ops = ops;
                Ok(Next::Go(c))
            }
        }
    }

    // ----- FacilityConfirmed → ShipRequested (send) ----------------------

    fn on_facility_confirmed(
        &mut self,
        row: &RunRow,
        now: u64,
        rep: &mut TickReport,
    ) -> Result<Next, Fault> {
        let s = row.spec.clone();
        if let Some(c) = self.stop_if_due(row, now)? {
            return Ok(Next::Go(c));
        }
        // Just before signing: the destination's generation and the
        // outputs at stock, from the canonical side (the facility receipt
        // says they were made, not that they are still there).
        match self.chain.place(&s.ship.dst)? {
            Some(v) if v.live && v.gen == s.ship.dst.gen => {}
            _ => return self.fail(row, now, Reason::DestinationChanged),
        }
        let Some((v, free)) = self.free_stock(row, &s.stock)? else {
            return self.fail(row, now, Reason::OutputShort);
        };
        if !res_ge(&v.stores, &s.ship.cargo) {
            return self.fail(row, now, Reason::OutputShort);
        }
        if !res_ge(&free, &s.ship.cargo) {
            // Spoken for by another run whose own send may already have
            // debited the stock: wait for it to be decided.
            return Ok(Next::Wait(now + self.params.poll));
        }
        // One send in flight per owner *in this store*. Sends by other
        // routes (by hand, another service, another store) are not
        // serialised by this: they are detected by the seq check and the
        // content check of `on_ship_in_flight`.
        if self.store.owner_send_in_flight(s.owner, row.id())? {
            return Ok(Next::Wait(now + 1));
        }
        // Another executor of this store may pass the same check now; the
        // compare-and-swap below (`sole_owner_send`) decides between them.
        if let Some(h) = &mut self.hook {
            h("ship.before_pin");
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
        if let Some(why) = self.budget_left(row, row.detail.ship_attempts, prepared.fee)? {
            return self.fail(row, now, why);
        }
        let mut d = row.detail.clone();
        d.ship_attempts += 1;
        d.ship_seq = Some(seq);
        d.pending = None;
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

    /// The `CaravanSent` records of a caravan key: from the feed this store
    /// read, then from the entity history (`None`: history unavailable).
    fn sent_records(&self, key: CaravanKey) -> Result<Option<Vec<Sent>>, Fault> {
        let mut out: Vec<Sent> = vec![];
        let mut push = |source: String, ev: &Event| {
            if let Event::CaravanSent {
                sig,
                src: a,
                dst,
                cargo,
                key: k,
                ..
            } = ev
            {
                if *k == key && !out.iter().any(|x| &x.sig == sig) {
                    out.push(Sent {
                        sig: sig.clone(),
                        src: *a,
                        dst: *dst,
                        cargo: *cargo,
                        source,
                    });
                }
            }
        };
        for r in self.store.events_of(&key.text(), "caravan_sent")? {
            push(format!("event:{}", r.id), &r.event);
        }
        match self.chain.caravan_history(key)? {
            Some(h) => {
                for r in &h {
                    push(format!("history:{}", r.id), &r.event);
                }
                Ok(Some(out))
            }
            None if out.is_empty() => Ok(None),
            None => Ok(Some(out)),
        }
    }

    /// The content of our landed send, for the check against the spec:
    /// its `CaravanSent` record, else the caravan account while it is still
    /// ours and unraided (`None`: not readable now).
    fn sent_content(
        &self,
        row: &RunRow,
        key: CaravanKey,
        sig: &str,
    ) -> Result<Option<Sent>, Fault> {
        if let Some(recs) = self.sent_records(key)? {
            if let Some(found) = recs.into_iter().find(|r| r.sig == sig) {
                return Ok(Some(found));
            }
        }
        Ok(self
            .chain
            .caravan(key)?
            .filter(|v| v.owner_now == row.spec.owner)
            .map(|v| Sent {
                sig: String::new(),
                src: v.src,
                dst: v.dst,
                cargo: v.cargo,
                source: format!("account:{}", key.text()),
            }))
    }

    fn on_ship_in_flight(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        let seq = row.detail.ship_seq.ok_or("ship in flight without a seq")?;
        let key = CaravanKey {
            owner: s.owner,
            seq,
        };
        let atts = self.store.attempts(row.id(), Step::Ship)?;
        let current: Vec<&AttemptRow> = atts
            .iter()
            .filter(|a| a.request_key == key.text())
            .collect();
        // Each attempt's handle and the chain signature it stands for (the
        // same string when this process signs; the gateway's once it said).
        let chain_sigs: Vec<(&AttemptRow, Option<String>)> = current
            .iter()
            .map(|a| (*a, self.chain.chain_sig(&a.prepared.sig)))
            .collect();
        let all_known = chain_sigs.iter().all(|(_, c)| c.is_some());
        let ours = |sig: &str| chain_sigs.iter().any(|(_, c)| c.as_deref() == Some(sig));
        // 1. Positive evidence that the send is ours: one of our attempts
        //    landed (status), or a CaravanSent names its chain signature.
        //    `landed` = (attempt handle, chain signature, slot).
        let mut landed: Option<(String, String, u64)> = None;
        let mut status_missing = false;
        for (a, c) in &chain_sigs {
            match self.chain.status(&a.prepared.sig, a.prepared.valid_until)? {
                SigStatus::Landed { slot, .. } => {
                    let Some(c) = c.clone() else {
                        // Landed, but the port cannot name the signature.
                        return Ok(self.indeterminate(row, now));
                    };
                    landed = Some((a.prepared.sig.clone(), c, slot));
                }
                SigStatus::Unavailable => status_missing = true,
                _ => {}
            }
        }
        let records = self.sent_records(key)?;
        if landed.is_none() {
            if let Some(recs) = &records {
                if let Some(r) = recs.iter().find(|r| ours(&r.sig)) {
                    let handle = chain_sigs
                        .iter()
                        .find(|(_, c)| c.as_deref() == Some(r.sig.as_str()))
                        .map(|(a, _)| a.prepared.sig.clone())
                        .unwrap_or_else(|| r.sig.clone());
                    landed = Some((handle, r.sig.clone(), now));
                }
            }
        }
        if let Some((handle, sig, slot)) = landed {
            // 2. The content must be ours too: places, resources, amounts.
            let Some(sent) = self.sent_content(row, key, &sig)? else {
                return Ok(self.indeterminate(row, now));
            };
            let cargo_ok = sent
                .cargo
                .iter()
                .zip(s.ship.cargo.iter())
                .all(|(got, want)| got <= want && (*want > 0 || *got == 0));
            if sent.src != s.stock || sent.dst != s.ship.dst || !cargo_ok {
                return Ok(self.hold(
                    row,
                    now,
                    Reason::Inconsistent(format!(
                        "{} landed with our signature but its content differs ({})",
                        key.text(),
                        sent.source
                    )),
                ));
            }
            self.crash_at("ship.after_confirm")?;
            let mut d = row.detail.clone();
            d.sent_cargo = Some(sent.cargo);
            d.pending = None;
            let mut c = change(
                RunState::InTransit,
                d,
                now,
                format!("caravan {} is ours (signature and content)", key.text()),
            );
            c.ops.push(Op::ReleaseAll);
            c.ops.extend(self.settle_attempts(&atts, &handle)?);
            c.ops.push(Op::Receipt(Receipt {
                run_id: row.id().to_string(),
                kind: "caravan_sent".into(),
                subject: key.text(),
                source: format!("sig:{sig}"),
                slot,
                body: serde_json::json!({ "seq": seq, "cargo": sent.cargo, "content_from": sent.source }),
            }));
            return Ok(Next::Go(c));
        }
        // 3. Positive evidence that another sender used this seq: a
        //    CaravanSent for it with a signature not ours. Ours can then
        //    never take effect (the program refuses the seq); they may still
        //    land failed, so their fees stay unconfirmed. Only when every
        //    attempt's chain signature is known: an attempt a gateway has not
        //    named yet could be the very record.
        if let Some(recs) = &records {
            if let Some(other) = recs.iter().find(|r| all_known && !ours(&r.sig)) {
                let ops = current
                    .iter()
                    .filter(|a| is_undecided(a))
                    .map(|a| status_op(&a.prepared.sig, "superseded", None))
                    .collect();
                return self.after_ship_decided(row, now, ops, None, Some(other.source.clone()));
            }
        }
        if status_missing && records.is_none() {
            // `(owner, seq)` alone proves nothing: never success, never a
            // re-send on it.
            return Ok(self.indeterminate(row, now));
        }
        // 4. Not ours (yet): every attempt must be decided.
        match self.undecided(row, Step::Ship, now)? {
            Undecided::Waiting { at, until } => Ok(self.wait_in_flight(row, at, until)),
            Undecided::Indeterminate => Ok(self.indeterminate(row, now)),
            Undecided::Decided { ops, reject } => {
                self.after_ship_decided(row, now, ops, reject, None)
            }
        }
    }

    /// No send of the pinned seq can take effect: stop (cancel, deadline,
    /// a definitive refusal), hold (wallet), or go back to
    /// FacilityConfirmed where fresh checks pin a new seq.
    fn after_ship_decided(
        &self,
        row: &RunRow,
        now: u64,
        ops: Vec<Op>,
        reject: Option<Reject>,
        taken_by: Option<String>,
    ) -> Result<Next, Fault> {
        if let Some(mut c) = self.stop_if_due(row, now)? {
            c.ops.extend(ops);
            return Ok(Next::Go(c));
        }
        let why = reject
            .and_then(|r| reason_of(Step::Ship, &r))
            .or(row.detail.pending.clone());
        let mut d = row.detail.clone();
        d.ship_seq = None;
        d.pending = None;
        let reserve = Op::Reserve {
            kind: ResKind::Stock,
            place: row.spec.stock.slot_key(),
            amount: row.spec.ship.cargo,
        };
        match why {
            Some(
                why @ (Reason::WalletRequired | Reason::GatewayRefused(_) | Reason::WorldClosed),
            ) => {
                // Back to FacilityConfirmed so the owner's seq is free for
                // their other runs; a person signs, changes the agent's
                // policy or mode, or cancels this one.
                let mut c = change(
                    RunState::FacilityConfirmed,
                    d,
                    now,
                    format!("hold: {why:?}"),
                );
                c.hold = Some(format!("{why:?}"));
                c.ops = ops;
                c.ops.push(reserve);
                Ok(Next::Go(c))
            }
            Some(why) => {
                let Next::Go(mut c) = self.fail(row, now, why)? else {
                    unreachable!()
                };
                c.detail.ship_seq = None;
                c.ops.extend(ops);
                Ok(Next::Go(c))
            }
            None => {
                let mut c = change(
                    RunState::FacilityConfirmed,
                    d,
                    now,
                    match taken_by {
                        Some(src) => format!(
                            "seq {} was used by another send ({src}); re-pin after fresh checks",
                            row.detail.ship_seq.unwrap_or_default()
                        ),
                        None => "no attempt can land; retry".to_string(),
                    },
                );
                c.ops = ops;
                c.ops.push(reserve);
                Ok(Next::Go(c))
            }
        }
    }

    // ----- InTransit → Arrived / Failed ----------------------------------

    fn on_in_transit(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        if row.cancel_requested && row.detail.cancel.is_none() {
            let mut d = row.detail.clone();
            d.cancel = Some(CancelPhase::Ineffective {
                at: row.state.name().into(),
            });
            return Ok(Next::Go(change(
                row.state,
                d,
                now,
                "cancel too late: the caravan is on the road (no recall)",
            )));
        }
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
                // Long past its arrival and still on the road: settlement may
                // be impossible (today's program never resolves bells at or
                // after end_bell, so such a caravan stays CaravanEarly) or the
                // keeper is behind. Hold; conclude nothing about the cargo.
                if now > v.arrive_slot.saturating_add(self.params.settle_grace) {
                    return Ok(self.hold(row, now, Reason::SettlementOverdue));
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
                    delivered: Some(ZERO),
                    verification: Verification::KnownZero,
                    cargo_logged: None,
                    effects: self.effects(row)?,
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

    /// A raid record of `choice` for this very caravan (same owner tag and
    /// seq): from the feed, else from the caravan's entity history. The
    /// only evidence of a take or a burn at settlement; a zero cargo or
    /// another destination alone is not.
    fn raid_evidence(&self, key: CaravanKey, choice: u8) -> Result<Option<(String, Raid)>, Fault> {
        let matching = |r: &Raid| r.key == key && r.choice == choice;
        if let Some((id, r)) = self
            .store
            .raids_seen(&key.text())?
            .into_iter()
            .find(|(_, r)| matching(r))
        {
            return Ok(Some((format!("event:{id}"), r)));
        }
        let Some(h) = self.chain.caravan_history(key)? else {
            return Ok(None);
        };
        Ok(h.into_iter().find_map(|r| match r.event {
            Event::CaravanRaided(x) if matching(&x) => Some((format!("history:{}", r.id), x)),
            _ => None,
        }))
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

    // ----- Arrived → Fulfilled / Partial / DeliveredUnverified / Failed --

    /// Judges the arrival from the settle record and the rules only. The
    /// destination's balance is never read for it: other deposits and
    /// withdrawals interleave, so a difference proves nothing about this
    /// caravan.
    fn on_arrived(&mut self, row: &RunRow, now: u64) -> Result<Next, Fault> {
        let s = &row.spec;
        let st = row
            .detail
            .settle
            .clone()
            .ok_or("arrived without a settlement")?;
        let mut d = row.detail.clone();
        let effects = self.effects(row)?;
        let zero = |why: Reason, note: &str, d: &mut Detail| {
            d.reason = Some(why);
            d.outcome = Some(Outcome {
                delivered: Some(ZERO),
                verification: Verification::KnownZero,
                cargo_logged: Some(st.cargo),
                effects: effects.clone(),
                note: note.into(),
            });
        };
        use frontier_abi::v2::log::raid_choice;
        if st.dst != s.ship.dst {
            // Only a raid's take rewrites a caravan's destination. Without a
            // take record for this caravan the cause is unconfirmed: wait
            // for the record (the feed may be late), then hold. Nobody is
            // named or blamed, and no amount is stated.
            if let Some((src, r)) = self.raid_evidence(st.key, raid_choice::TAKE)? {
                zero(
                    Reason::Raided,
                    "taken in a raid (CARAVAN_RAIDED TAKE for this caravan): settled at the raider's place",
                    &mut d,
                );
                let mut c = change(RunState::Failed, d, now, "taken (raid record)");
                if row.detail.raid.as_ref() != Some(&r) {
                    c.ops.push(Op::Receipt(raid_receipt(row, &r, &src)));
                    c.detail.raid = Some(r);
                }
                return Ok(Next::Go(c));
            }
            d.unresolved += 1;
            if d.unresolved >= s.budget.max_port_errors {
                d.reason = Some(Reason::DestinationMismatch);
                let mut c = change(
                    RunState::Arrived,
                    d,
                    now,
                    "hold: settled at another destination, no raid record (cause unconfirmed)",
                );
                c.hold = Some(format!("{:?}", Reason::DestinationMismatch));
                return Ok(Next::Go(c));
            }
            return Ok(Next::Go(change(
                RunState::Arrived,
                d,
                now + self.params.poll,
                "settled at another destination; looking for a raid record",
            )));
        }
        if st.outcome != frontier_abi::v2::log::caravan_outcome::DELIVERED {
            zero(
                Reason::DestinationChanged,
                "destination gone or of another generation at arrival: cargo lost",
                &mut d,
            );
            return Ok(Next::Go(change(
                RunState::Failed,
                d,
                now,
                "lost at arrival",
            )));
        }
        // A zero logged cargo is "less than one unit each", not zero: only a
        // burn record for this caravan proves nothing was left to deliver.
        if res_is_zero(&st.cargo) {
            if let Some((src, r)) = self.raid_evidence(st.key, raid_choice::BURN)? {
                zero(
                    Reason::LostInTransit,
                    "burned in a raid (CARAVAN_RAIDED BURN for this caravan)",
                    &mut d,
                );
                let mut c = change(RunState::Failed, d, now, "burned (raid record)");
                if row.detail.raid.as_ref() != Some(&r) {
                    c.ops.push(Op::Receipt(raid_receipt(row, &r, &src)));
                    c.detail.raid = Some(r);
                }
                return Ok(Next::Go(c));
            }
        }
        let (delivered, verification) = match st.credited {
            Some(c) => (Some(c), Verification::Recorded),
            None if s.ship.dst.kind == frontier_abi::v2::layout::s1::place::KIND_HOLDING => {
                (Some(st.cargo), Verification::RuleDerived)
            }
            None => (None, Verification::Unverifiable),
        };
        let (to, note) = match delivered {
            None => (
                RunState::DeliveredUnverified,
                "delivered; the amount kept cannot be verified (vault record without credited)",
            ),
            // The verified amount is a lower bound in whole units: the kept
            // amount is in [bound, bound + 1) per resource. Against this
            // run's whole request that decides both ways; a goal summing
            // several runs is ①'s to judge (fractions add up).
            Some(c) if res_ge(&c, &s.ship.cargo) => {
                (RunState::Fulfilled, "delivered in full (lower bound ≥ request)")
            }
            Some(_) => (
                RunState::Partial,
                "delivered; below this run's request (lower bound < request); fractions may count toward a summed goal",
            ),
        };
        d.outcome = Some(Outcome {
            delivered,
            verification,
            cargo_logged: Some(st.cargo),
            effects,
            note: note.into(),
        });
        Ok(Next::Go(change(to, d, now, note)))
    }
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
