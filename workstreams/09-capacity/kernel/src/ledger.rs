//! The capacity state machine (contract §2–§4): pools, grants and jobs,
//! the operations on them, and a job's output in closed form.
//!
//! [`Harness`] stands where the program would: the facility Holdings
//! (the core's accounts), the capacity [`Ledger`] (the proposed accounts,
//! patch 0002) and a [`Custody`] (⑩'s). It is a test harness, not a
//! world or period of its own (those belong to ④ and ⑧): it has no start,
//! no end and no period. [`Harness::apply`] runs one operation
//! atomically: on an error nothing changes, like a failed transaction.
//!
//! **A world that does not end.** Records are retired once settled
//! (`Retire`, `RetireGrant`, `RetirePool`), so a facility's tables stay
//! bounded however long it lends; grant and job numbers only increase, so
//! a retired record's key is never reused (`Retired`); each job carries a
//! uid that is never reused and scopes its custody keys.
//!
//! **Path independence.** A job's output is a pure function of its fixed
//! terms (units, window, max output), its hopper (fixed at the start:
//! deposits after it are refused) and the time, so settling at any times
//! in any order credits the same output (`Settle` moves only the
//! difference to what it credited before). Capacity checks read the jobs'
//! occupied intervals as a pure function of `now`.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, DAY};

use crate::custody::{By, Custody, CustodyError, Key};
use crate::error::CapError;
use crate::event::Event;
use crate::facility::Facility;
use crate::model::{Actor, FacilityId, GrantId, JobId, Place, Site};
use crate::policy::{DormancyPolicy, LossPolicy, Policies, RevokePolicy};
use crate::recipe::{recipe, Recipe, RecipeId};

/// Jobs one pool holds (a fixed table on chain) [proposal].
pub const MAX_JOBS: usize = 16;
/// Grants one pool holds [proposal].
pub const MAX_GRANTS: usize = 8;
/// Deposits one job takes [proposal].
pub const MAX_DEPOSITS: usize = 8;
/// Longest job window [proposal].
pub const MAX_WINDOW: i64 = 7 * DAY;

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Fin {
    Open,
    Completed(i64),
    Cancelled(i64),
    Lost(i64),
}

/// A job's phase at a time (contract §3; `Booked` and `Running` are
/// derived, never stored).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Booked,
    Running,
    Completed(i64),
    Cancelled(i64),
    Lost(i64),
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Grant {
    pub id: GrantId,
    pub user: Actor,
    pub recipe: RecipeId,
    pub max_units: u32,
    pub max_output: i64,
    pub from: i64,
    pub until: i64,
    pub revoked_at: Option<i64>,
    /// Output of this grant's retired jobs (it still counts against
    /// `max_output`).
    pub spent: i64,
    /// The highest job number reserved under this grant.
    pub last_job_seq: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Job {
    pub id: JobId,
    /// Never reused: scopes the job's custody keys.
    pub uid: u64,
    pub user: Actor,
    pub recipe: RecipeId,
    pub units: u32,
    pub start: i64,
    pub end: i64,
    pub max_output: i64,
    /// Materials deposited, per recipe input (milli).
    pub hopper: [i64; 2],
    /// (deposit id, input index, amount, from).
    pub deposits: Vec<(u64, u8, i64, Place)>,
    pub fin: Fin,
    /// Output credited to custody so far.
    pub settled: i64,
    pub started_logged: bool,
    /// Output handed to the user (or forfeited) so far.
    pub claimed: i64,
    /// The rest of the hopper was handed out.
    pub refunded: bool,
    /// Inputs handed back to the user (per recipe input, milli).
    pub returned: [i64; 2],
    /// Inputs and output a facility loss moved to a captor (milli).
    pub forfeited_in: [i64; 2],
    pub forfeited_out: i64,
}

/// One resource of a job as an account, in workstream 10's terms
/// (`Lot`: `IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED`). For an
/// input, `in_total` is what was deposited and `consumed` what the recipe
/// used; for the output, `in_total` is what was made and `consumed` is 0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Account {
    pub in_total: i64,
    pub held: i64,
    pub out_total: i64,
    pub consumed: i64,
    pub forfeited: i64,
}

impl Account {
    /// The balance law and its bounds.
    pub fn balanced(&self) -> bool {
        self.held >= 0
            && self.out_total >= 0
            && self.consumed >= 0
            && self.forfeited >= 0
            && self.in_total == self.held + self.out_total + self.consumed + self.forfeited
    }
}

/// A job's accounts: its two inputs and its output (the record of its
/// processing; logged as [`Event::Receipt`] when the job is retired).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Accounts {
    pub inputs: [Account; 2],
    pub output: Account,
}

impl Accounts {
    pub fn balanced(&self) -> bool {
        self.inputs.iter().all(Account::balanced) && self.output.balanced()
    }
}

impl Job {
    fn recipe(&self) -> &'static Recipe {
        recipe(self.recipe).expect("checked at Reserve")
    }

    /// The end of conversion before any shortfall: the window's end, or
    /// the cancel or loss time (clamped to the window).
    fn stop_at(&self) -> i64 {
        match self.fin {
            Fin::Cancelled(c) | Fin::Lost(c) => c.clamp(self.start, self.end),
            _ => self.end,
        }
    }

    /// The most the job makes: its max output, its hopper, its window.
    pub fn limit(&self) -> i64 {
        let r = self.recipe();
        self.max_output
            .min(r.fed_by(&self.hopper))
            .min(r.capacity_output(self.units, self.end - self.start))
    }

    /// Output made by `t` (milli), a pure function (module note).
    pub fn out_at(&self, t: i64) -> i64 {
        let until = t.min(self.stop_at());
        if until <= self.start {
            return 0;
        }
        self.limit().min(
            self.recipe()
                .capacity_output(self.units, until - self.start),
        )
    }

    /// When conversion ends: the limit reached, or the stop.
    pub fn end_eff(&self) -> i64 {
        let full = self.start + self.recipe().secs_for(self.units, self.limit());
        full.min(self.stop_at())
    }

    /// The interval the job holds capacity, as known at `now`: until it
    /// starts its hopper may still grow, so the whole window.
    pub fn occupies(&self, now: i64) -> (i64, i64) {
        let end = if self.fin != Fin::Open || now >= self.start {
            self.end_eff()
        } else {
            self.end
        };
        (self.start, end.max(self.start))
    }

    pub fn phase(&self, now: i64) -> Phase {
        match self.fin {
            Fin::Completed(t) => Phase::Completed(t),
            Fin::Cancelled(t) => Phase::Cancelled(t),
            Fin::Lost(t) => Phase::Lost(t),
            Fin::Open if now < self.start => Phase::Booked,
            Fin::Open if now >= self.end_eff() => Phase::Completed(self.end_eff()),
            Fin::Open => Phase::Running,
        }
    }

    /// What the hopper still holds once the job is final.
    pub fn rest(&self) -> [i64; 2] {
        let used = self.recipe().used_for(self.settled);
        [self.hopper[0] - used[0], self.hopper[1] - used[1]]
    }

    /// The job as accounts (what its hopper and output places hold, and
    /// where the rest went), as of its last settlement.
    pub fn accounts(&self) -> Accounts {
        let used = self.recipe().used_for(self.settled);
        let inputs = core::array::from_fn(|i| Account {
            in_total: self.hopper[i],
            held: self.hopper[i] - used[i] - self.returned[i] - self.forfeited_in[i],
            out_total: self.returned[i],
            consumed: used[i],
            forfeited: self.forfeited_in[i],
        });
        let output = Account {
            in_total: self.settled,
            held: self.settled - self.claimed,
            out_total: self.claimed - self.forfeited_out,
            consumed: 0,
            forfeited: self.forfeited_out,
        };
        Accounts { inputs, output }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Pool {
    pub facility: FacilityId,
    pub owner: Actor,
    pub policies: Policies,
    pub lent: u32,
    /// Optimistic sequence of the owner's Lend and Reclaim, and the last.
    pub owner_seq: u32,
    pub last_owner_op: Option<Op>,
    pub grants: Vec<Grant>,
    pub jobs: Vec<Job>,
    /// The facility was lost at this time (the pool is closed).
    pub lost_at: Option<i64>,
    pub captor: Option<Actor>,
    /// The highest grant number this pool issued.
    pub last_grant_seq: Option<u32>,
}

impl Pool {
    /// The most units held at any one time in `[from, to)` by the jobs
    /// `keep` selects (a sweep over the intervals' ends).
    fn peak(&self, now: i64, from: i64, to: i64, keep: impl Fn(&Job) -> bool) -> u32 {
        let mut edges: Vec<(i64, i64)> = Vec::new();
        for j in self.jobs.iter().filter(|j| keep(j)) {
            let (s, e) = j.occupies(now);
            let (s, e) = (s.max(from), e.min(to));
            if s < e {
                edges.push((s, j.units as i64));
                edges.push((e, -(j.units as i64)));
            }
        }
        // Ends before starts at the same time: [s, e) intervals.
        edges.sort();
        let (mut cur, mut peak) = (0i64, 0i64);
        for (_, d) in edges {
            cur += d;
            peak = peak.max(cur);
        }
        peak as u32
    }

    fn grant(&self, id: GrantId) -> Result<&Grant, CapError> {
        match self.grants.iter().find(|g| g.id == id) {
            Some(g) => Ok(g),
            None if self.last_grant_seq.is_some_and(|l| id.seq <= l) => Err(CapError::Retired),
            None => Err(CapError::UnknownGrant),
        }
    }

    /// The job, or why not: a number at or below the grant's highest
    /// belongs to a retired job (or to a retired grant).
    fn job(&self, id: JobId) -> Result<&Job, CapError> {
        if let Some(j) = self.jobs.iter().find(|j| j.id == id) {
            return Ok(j);
        }
        let g = self.grant(id.grant)?;
        if g.last_job_seq.is_some_and(|l| id.seq <= l) {
            Err(CapError::Retired)
        } else {
            Err(CapError::UnknownJob)
        }
    }

    fn job_mut(&mut self, id: JobId) -> Result<&mut Job, CapError> {
        self.job(id)?;
        Ok(self.jobs.iter_mut().find(|j| j.id == id).expect("found"))
    }

    /// Output a grant's jobs hold of its budget: the final ones what they
    /// made, the open ones their max output.
    fn grant_output(&self, id: GrantId) -> i64 {
        let spent = self
            .grants
            .iter()
            .find(|g| g.id == id)
            .map_or(0, |g| g.spent);
        self.jobs
            .iter()
            .filter(|j| j.id.grant == id)
            .map(|j| {
                if j.fin == Fin::Open {
                    j.max_output
                } else {
                    j.settled
                }
            })
            .fold(spent, i64::saturating_add)
    }
}

/// The operations (contract §2).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Op {
    OpenPool {
        facility: FacilityId,
        policies: Policies,
    },
    Lend {
        facility: FacilityId,
        units: u32,
        seq: u32,
    },
    Reclaim {
        facility: FacilityId,
        units: u32,
        seq: u32,
    },
    Grant {
        grant: GrantId,
        user: Actor,
        recipe: RecipeId,
        max_units: u32,
        max_output: i64,
        from: i64,
        until: i64,
    },
    Revoke {
        grant: GrantId,
    },
    Reserve {
        job: JobId,
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
    },
    Deposit {
        job: JobId,
        deposit: u64,
        resource: Resource,
        amount: i64,
        from: Place,
    },
    Cancel {
        job: JobId,
    },
    Settle {
        job: JobId,
    },
    Claim {
        job: JobId,
        to: Place,
    },
    /// A claim to separate places: the output to `output_to`, each unused
    /// input's whole units to its own `refund_to` (in recipe input order:
    /// ore, wood), the sub-unit rest (under 1,000 milli) of both to
    /// `remainder_to`. For refunds into places that take whole units of one
    /// resource only (workstream 10's lots; its requests R3, R4).
    ClaimSplit {
        job: JobId,
        output_to: Place,
        refund_to: [Place; 2],
        remainder_to: Place,
    },
    FacilityLost {
        facility: FacilityId,
    },
    /// Close a finished, fully handed-out job's record.
    Retire {
        job: JobId,
    },
    /// Close a revoked or expired grant with no job left.
    RetireGrant {
        grant: GrantId,
    },
    /// Close a lost generation's pool with no job left.
    RetirePool {
        facility: FacilityId,
    },
}

/// Who may send an operation. ④ maps the classes onto the program's
/// (player, keeper); a boundary between war periods must not refuse any
/// of them (contract §10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// The facility's owner, by wallet.
    Owner,
    /// The grant's user.
    User,
    /// Anyone (no signature beyond the fee payer's).
    Anyone,
}

impl Op {
    pub fn class(&self) -> Class {
        match self {
            Op::OpenPool { .. }
            | Op::Lend { .. }
            | Op::Reclaim { .. }
            | Op::Grant { .. }
            | Op::Revoke { .. } => Class::Owner,
            Op::Reserve { .. }
            | Op::Deposit { .. }
            | Op::Cancel { .. }
            | Op::Claim { .. }
            | Op::ClaimSplit { .. } => Class::User,
            Op::Settle { .. }
            | Op::FacilityLost { .. }
            | Op::Retire { .. }
            | Op::RetireGrant { .. }
            | Op::RetirePool { .. } => Class::Anyone,
        }
    }
}

/// Why an operation failed inside the kernel: its own reason, or the
/// custody's (which [`Refusal`] keeps for the caller).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fail {
    Cap(CapError),
    Custody(CustodyError),
}

impl From<CapError> for Fail {
    fn from(e: CapError) -> Fail {
        Fail::Cap(e)
    }
}

/// A refused operation: the kernel's code (what [`Harness::apply`]
/// returns; `Custody` when custody refused) and custody's own reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: CapError,
    pub custody: Option<CustodyError>,
}

impl From<CapError> for Refusal {
    fn from(code: CapError) -> Refusal {
        Refusal {
            code,
            custody: None,
        }
    }
}

impl From<Fail> for Refusal {
    fn from(f: Fail) -> Refusal {
        match f {
            Fail::Cap(code) => Refusal {
                code,
                custody: None,
            },
            Fail::Custody(e) => Refusal {
                code: CapError::Custody,
                custody: Some(e),
            },
        }
    }
}

/// What an operation did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Applied(Vec<Event>),
    /// The same operation was applied before; nothing changed.
    AlreadyApplied,
}

/// The capacity accounts (proposal 0002): one pool per facility
/// generation.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Ledger {
    pub pools: BTreeMap<FacilityId, Pool>,
    /// The next job uid (never reused).
    pub next_uid: u64,
}

/// The harness: facilities (core), ledger (proposal), custody (⑩).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Harness<C> {
    pub facilities: BTreeMap<Site, Facility>,
    pub ledger: Ledger,
    pub custody: C,
    /// The clock of the last applied operation (transactions land in
    /// clock order).
    pub clock: i64,
    pub events: Vec<(i64, Event)>,
}

fn key(scope: u64, kind: u8, n: u64) -> Key {
    Key { scope, kind, n }
}

const K_DEPOSIT: u8 = 1;
const K_USE: u8 = 2;
const K_MAKE: u8 = 3;
const K_CLAIM_OUT: u8 = 4;
const K_REFUND: u8 = 5;
const K_LOSS_OUT: u8 = 6;
const K_LOSS_IN: u8 = 7;

impl<C: Custody + Clone> Harness<C> {
    pub fn new(custody: C) -> Harness<C> {
        Harness {
            facilities: BTreeMap::new(),
            ledger: Ledger::default(),
            custody,
            clock: i64::MIN,
            events: Vec::new(),
        }
    }

    pub fn add_facility(&mut self, f: Facility) {
        self.facilities.insert(f.at, f);
    }

    pub fn pool(&self, f: FacilityId) -> Option<&Pool> {
        self.ledger.pools.get(&f)
    }

    pub fn job(&self, id: JobId) -> Option<&Job> {
        self.pool(id.grant.facility)?
            .jobs
            .iter()
            .find(|j| j.id == id)
    }

    /// Apply `op` signed by `signer` at `now`, atomically.
    pub fn apply(&mut self, now: i64, signer: Actor, op: &Op) -> Result<Outcome, CapError> {
        self.apply_detailed(now, signer, op).map_err(|r| r.code)
    }

    /// [`Self::apply`], keeping the custody's own reason when custody
    /// refused (⑩'s request R5: "no room", "frozen" and "not whole units"
    /// are told apart).
    pub fn apply_detailed(&mut self, now: i64, signer: Actor, op: &Op) -> Result<Outcome, Refusal> {
        if now < self.clock {
            return Err(CapError::TimeReversed.into());
        }
        let saved = self.clone();
        let mut ev = Vec::new();
        match self.run(now, signer, op, &mut ev) {
            Ok(true) => {
                self.clock = now;
                self.events.extend(ev.iter().cloned().map(|e| (now, e)));
                Ok(Outcome::Applied(ev))
            }
            Ok(false) => {
                *self = saved;
                self.clock = now;
                Ok(Outcome::AlreadyApplied)
            }
            Err(e) => {
                *self = saved;
                Err(e.into())
            }
        }
    }

    /// The live facility of a pool, or why not.
    fn live(&self, f: FacilityId) -> Result<&Facility, CapError> {
        let fac = self.facilities.get(&f.at).ok_or(CapError::UnknownPool)?;
        if fac.gen != f.gen {
            return Err(CapError::WrongGeneration);
        }
        // The core's u8 generation can wrap. A matching old loss record
        // means the same FacilityId no longer identifies one incarnation.
        // Refuse live operations until the core supplies a non-reused id;
        // loss, claim and retirement still use the old pool's records.
        if fac.ended.iter().any(|(gen, _, _)| *gen == f.gen) {
            return Err(CapError::GenerationReused);
        }
        Ok(fac)
    }

    fn pool_live(&self, f: FacilityId) -> Result<&Pool, CapError> {
        let p = self.ledger.pools.get(&f).ok_or(CapError::UnknownPool)?;
        if p.lost_at.is_some() {
            return Err(CapError::FacilityGone);
        }
        self.live(f)?;
        Ok(p)
    }

    fn pool_mut(&mut self, f: FacilityId) -> &mut Pool {
        self.ledger.pools.get_mut(&f).expect("checked")
    }

    /// `Ok(false)`: already applied.
    fn run(&mut self, now: i64, signer: Actor, op: &Op, ev: &mut Vec<Event>) -> Result<bool, Fail> {
        match *op {
            Op::OpenPool { facility, policies } => {
                if let Some(p) = self.ledger.pools.get(&facility) {
                    if p.lost_at.is_some() {
                        // A wrapped generation number meets a lost pool
                        // whose records are still open (contract §10).
                        return Err(CapError::GenerationReused.into());
                    }
                    self.live(facility)?;
                    return if p.owner == signer && p.policies == policies {
                        Ok(false)
                    } else {
                        Err(CapError::Conflict.into())
                    };
                }
                let fac = self.live(facility)?;
                if fac.owner != signer {
                    return Err(CapError::NotOwner.into());
                }
                self.ledger.pools.insert(
                    facility,
                    Pool {
                        facility,
                        owner: signer,
                        policies,
                        lent: 0,
                        owner_seq: 0,
                        last_owner_op: None,
                        grants: Vec::new(),
                        jobs: Vec::new(),
                        lost_at: None,
                        captor: None,
                        last_grant_seq: None,
                    },
                );
                ev.push(Event::PoolOpened {
                    facility,
                    owner: signer,
                });
                Ok(true)
            }
            Op::Lend {
                facility,
                units,
                seq,
            }
            | Op::Reclaim {
                facility,
                units,
                seq,
            } => {
                let lend = matches!(op, Op::Lend { .. });
                let p = self.pool_live(facility)?;
                if p.owner != signer {
                    return Err(CapError::NotOwner.into());
                }
                if seq != p.owner_seq {
                    return if seq + 1 == p.owner_seq && p.last_owner_op.as_ref() == Some(op) {
                        Ok(false)
                    } else {
                        Err(CapError::Conflict.into())
                    };
                }
                if units == 0 {
                    return Err(CapError::BadWindow.into());
                }
                let lent = if lend {
                    p.lent.checked_add(units).ok_or(CapError::Overflow)?
                } else {
                    let left = p.lent.checked_sub(units).ok_or(CapError::ReclaimBlocked)?;
                    // Every future instant must still fit.
                    if p.peak(now, now, i64::MAX, |_| true) > left {
                        return Err(CapError::ReclaimBlocked.into());
                    }
                    left
                };
                let fac = self.facilities.get_mut(&facility.at).expect("live");
                fac.touch(now).map_err(|_| CapError::TimeReversed)?;
                if lend {
                    fac.lend(now, units)
                        .map_err(|_| CapError::NotEnoughWorkshops)?;
                } else {
                    fac.reclaim(now, units)
                        .map_err(|_| CapError::ReclaimBlocked)?;
                }
                debug_assert_eq!(fac.lent, lent);
                let p = self.pool_mut(facility);
                p.lent = lent;
                p.owner_seq = p.owner_seq.checked_add(1).ok_or(CapError::Overflow)?;
                p.last_owner_op = Some(op.clone());
                ev.push(if lend {
                    Event::Lent {
                        facility,
                        units,
                        lent,
                        at: now,
                    }
                } else {
                    Event::Reclaimed {
                        facility,
                        units,
                        lent,
                        at: now,
                    }
                });
                Ok(true)
            }
            Op::Grant {
                grant,
                user,
                recipe: rid,
                max_units,
                max_output,
                from,
                until,
            } => {
                let p = self.pool_live(grant.facility)?;
                if p.owner != signer {
                    return Err(CapError::NotOwner.into());
                }
                let g = Grant {
                    id: grant,
                    user,
                    recipe: rid,
                    max_units,
                    max_output,
                    from,
                    until,
                    revoked_at: None,
                    spent: 0,
                    last_job_seq: None,
                };
                if let Some(old) = p.grants.iter().find(|x| x.id == grant) {
                    return if (Grant {
                        revoked_at: None,
                        spent: 0,
                        last_job_seq: None,
                        ..old.clone()
                    }) == g
                    {
                        Ok(false)
                    } else {
                        Err(CapError::Conflict.into())
                    };
                }
                if recipe(rid).is_none() {
                    return Err(CapError::WrongRecipe.into());
                }
                if max_units == 0 || max_output <= 0 || from >= until || until <= now {
                    return Err(CapError::BadWindow.into());
                }
                if p.last_grant_seq.is_some_and(|l| grant.seq <= l) {
                    return Err(CapError::Retired.into());
                }
                if p.grants.len() >= MAX_GRANTS {
                    return Err(CapError::TooMany.into());
                }
                let pm = self.pool_mut(grant.facility);
                pm.grants.push(g);
                pm.last_grant_seq = Some(grant.seq);
                ev.push(Event::Granted { grant, user });
                Ok(true)
            }
            Op::Revoke { grant } => {
                let p = self.pool_live(grant.facility)?;
                if p.owner != signer {
                    return Err(CapError::NotOwner.into());
                }
                if p.grant(grant)?.revoked_at.is_some() {
                    return Ok(false);
                }
                let cancel = p.policies.revoke == RevokePolicy::CancelBooked;
                let p = self.pool_mut(grant.facility);
                p.grants
                    .iter_mut()
                    .find(|g| g.id == grant)
                    .expect("found")
                    .revoked_at = Some(now);
                let mut n = 0;
                if cancel {
                    for j in p.jobs.iter_mut() {
                        if j.id.grant == grant && j.fin == Fin::Open && now < j.start {
                            j.fin = Fin::Cancelled(now);
                            n += 1;
                            ev.push(Event::Cancelled {
                                job: j.id,
                                at: now,
                                out: 0,
                            });
                        }
                    }
                }
                ev.push(Event::Revoked {
                    grant,
                    at: now,
                    cancelled: n,
                });
                Ok(true)
            }
            Op::Reserve {
                job,
                units,
                start,
                end,
                max_output,
            } => self.reserve(now, signer, job, units, start, end, max_output, ev),
            Op::Deposit {
                job,
                deposit,
                resource,
                amount,
                from,
            } => {
                let p = self.pool_live(job.grant.facility)?;
                let j = p.job(job)?;
                if j.user != signer {
                    return Err(CapError::NotUser.into());
                }
                let i = j
                    .recipe()
                    .input_index(resource)
                    .ok_or(CapError::WrongResource)?;
                if let Some(d) = j.deposits.iter().find(|d| d.0 == deposit) {
                    return if *d == (deposit, i as u8, amount, from) {
                        Ok(false)
                    } else {
                        Err(CapError::Conflict.into())
                    };
                }
                if j.fin != Fin::Open {
                    return Err(CapError::AlreadyFinal.into());
                }
                if now >= j.start {
                    return Err(CapError::AlreadyStarted.into());
                }
                if amount <= 0 {
                    return Err(CapError::WrongResource.into());
                }
                if j.deposits.len() >= MAX_DEPOSITS {
                    return Err(CapError::TooMany.into());
                }
                let (user, uid) = (j.user, j.uid);
                self.custody
                    .transfer(
                        key(uid, K_DEPOSIT, deposit),
                        By::Actor(signer),
                        from,
                        Place::Hopper(job),
                        resource,
                        amount,
                        user,
                    )
                    .map_err(Fail::Custody)?;
                let j = self.pool_mut(job.grant.facility).job_mut(job)?;
                j.hopper[i] = j.hopper[i].checked_add(amount).ok_or(CapError::Overflow)?;
                j.deposits.push((deposit, i as u8, amount, from));
                ev.push(Event::Deposited {
                    job,
                    deposit,
                    resource,
                    amount,
                });
                Ok(true)
            }
            Op::Cancel { job } => {
                let p = self.pool_live(job.grant.facility)?;
                let j = p.job(job)?;
                if j.user != signer {
                    return Err(CapError::NotUser.into());
                }
                if matches!(j.fin, Fin::Cancelled(_)) {
                    return Ok(false);
                }
                if j.fin != Fin::Open || now >= j.end_eff() && now >= j.start {
                    return Err(CapError::AlreadyFinal.into());
                }
                self.settle(now, job, ev)?;
                let j = self.pool_mut(job.grant.facility).job_mut(job)?;
                j.fin = Fin::Cancelled(now);
                let out = j.out_at(now);
                debug_assert_eq!(out, j.settled);
                ev.push(Event::Cancelled { job, at: now, out });
                Ok(true)
            }
            Op::Settle { job } => {
                self.pool_live(job.grant.facility)?;
                let before = ev.len();
                self.settle(now, job, ev)?;
                Ok(ev.len() > before)
            }
            Op::Claim { job, to } => self.claim(now, signer, job, [to; 4], false, ev),
            Op::ClaimSplit {
                job,
                output_to,
                refund_to,
                remainder_to,
            } => self.claim(
                now,
                signer,
                job,
                [output_to, refund_to[0], refund_to[1], remainder_to],
                true,
                ev,
            ),
            Op::FacilityLost { facility } => self.lose(facility, ev),
            Op::Retire { job } => {
                let p = self
                    .ledger
                    .pools
                    .get(&job.grant.facility)
                    .ok_or(CapError::UnknownPool)?;
                let j = match p.job(job) {
                    Err(CapError::Retired) => return Ok(false),
                    r => r?.clone(),
                };
                let handed_out = j.claimed == j.settled && (j.refunded || j.rest() == [0, 0]);
                if j.fin == Fin::Open || !handed_out {
                    return Err(CapError::NotRetirable.into());
                }
                let pm = self.pool_mut(job.grant.facility);
                pm.jobs.retain(|x| x.id != job);
                let g = pm
                    .grants
                    .iter_mut()
                    .find(|g| g.id == job.grant)
                    .expect("a job's grant outlives it");
                g.spent = g.spent.checked_add(j.settled).ok_or(CapError::Overflow)?;
                self.custody.forget(j.uid);
                ev.push(Event::Receipt {
                    job,
                    uid: j.uid,
                    accounts: j.accounts(),
                });
                ev.push(Event::Retired {
                    job,
                    uid: j.uid,
                    output: j.settled,
                });
                Ok(true)
            }
            Op::RetireGrant { grant } => {
                let p = self
                    .ledger
                    .pools
                    .get(&grant.facility)
                    .ok_or(CapError::UnknownPool)?;
                let g = match p.grant(grant) {
                    Err(CapError::Retired) => return Ok(false),
                    r => r?,
                };
                let over = g.revoked_at.is_some() || now >= g.until || p.lost_at.is_some();
                if !over || p.jobs.iter().any(|j| j.id.grant == grant) {
                    return Err(CapError::NotRetirable.into());
                }
                self.pool_mut(grant.facility)
                    .grants
                    .retain(|g| g.id != grant);
                ev.push(Event::GrantRetired { grant });
                Ok(true)
            }
            Op::RetirePool { facility } => {
                let p = self
                    .ledger
                    .pools
                    .get(&facility)
                    .ok_or(CapError::UnknownPool)?;
                if p.lost_at.is_none() || !p.jobs.is_empty() {
                    return Err(CapError::NotRetirable.into());
                }
                self.ledger.pools.remove(&facility);
                ev.push(Event::PoolRetired { facility });
                Ok(true)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn reserve(
        &mut self,
        now: i64,
        signer: Actor,
        job: JobId,
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
        ev: &mut Vec<Event>,
    ) -> Result<bool, Fail> {
        let p = self.pool_live(job.grant.facility)?;
        let g = p.grant(job.grant)?;
        if g.user != signer {
            return Err(CapError::NotUser.into());
        }
        if let Some(j) = p.jobs.iter().find(|j| j.id == job) {
            let same = (j.units, j.start, j.end, j.max_output) == (units, start, end, max_output);
            return if same {
                Ok(false)
            } else {
                Err(CapError::Conflict.into())
            };
        }
        if g.last_job_seq.is_some_and(|l| job.seq <= l) {
            return Err(CapError::Retired.into());
        }
        if g.revoked_at.is_some() {
            return Err(CapError::GrantRevoked.into());
        }
        if units == 0 || max_output <= 0 || start >= end || start < now || end - start > MAX_WINDOW
        {
            return Err(CapError::BadWindow.into());
        }
        if start < g.from || end > g.until {
            return Err(CapError::OutsideGrantWindow.into());
        }
        if p.policies.dormancy == DormancyPolicy::RefuseNewWhenDormant
            && self.live(job.grant.facility)?.dormant(now)
        {
            return Err(CapError::OwnerAway.into());
        }
        // A sum past the type's range exceeds every cap.
        let same_grant = p.peak(now, start, end, |j| j.id.grant == job.grant);
        if same_grant
            .checked_add(units)
            .is_none_or(|n| n > g.max_units)
        {
            return Err(CapError::GrantUnitsExceeded.into());
        }
        if p.grant_output(job.grant)
            .checked_add(max_output)
            .is_none_or(|n| n > g.max_output)
        {
            return Err(CapError::GrantOutputExceeded.into());
        }
        if p.peak(now, start, end, |_| true)
            .checked_add(units)
            .is_none_or(|n| n > p.lent)
        {
            return Err(CapError::CapacityExceeded.into());
        }
        if p.jobs.len() >= MAX_JOBS {
            return Err(CapError::TooMany.into());
        }
        let uid = self.ledger.next_uid;
        let j = Job {
            id: job,
            uid,
            user: signer,
            recipe: g.recipe,
            units,
            start,
            end,
            max_output,
            hopper: [0, 0],
            deposits: Vec::new(),
            fin: Fin::Open,
            settled: 0,
            started_logged: false,
            claimed: 0,
            refunded: false,
            returned: [0, 0],
            forfeited_in: [0, 0],
            forfeited_out: 0,
        };
        self.ledger.next_uid = uid.checked_add(1).ok_or(CapError::Overflow)?;
        let pm = self.pool_mut(job.grant.facility);
        pm.jobs.push(j);
        pm.grants
            .iter_mut()
            .find(|g| g.id == job.grant)
            .expect("checked")
            .last_job_seq = Some(job.seq);
        ev.push(Event::Reserved {
            job,
            units,
            start,
            end,
            max_output,
        });
        Ok(true)
    }

    /// Credit the output made by `now` (or by the job's stop) and use its
    /// inputs; finalize a job whose conversion has ended.
    fn settle(&mut self, now: i64, job: JobId, ev: &mut Vec<Event>) -> Result<(), Fail> {
        let p = self
            .ledger
            .pools
            .get(&job.grant.facility)
            .ok_or(CapError::UnknownPool)?;
        let j = p.job(job)?.clone();
        let r = j.recipe();
        if !j.started_logged && now >= j.start {
            ev.push(Event::Started { job, at: j.start });
        }
        let out = j.out_at(now);
        let delta = out - j.settled;
        if delta > 0 {
            let used = r.used_for(delta);
            for (i, (res, _)) in r.inputs.iter().enumerate() {
                self.custody
                    .consume(
                        key(j.uid, K_USE * 16 + i as u8, out as u64),
                        Place::Hopper(job),
                        *res,
                        used[i],
                    )
                    .map_err(Fail::Custody)?;
            }
            self.custody
                .produce(
                    key(j.uid, K_MAKE, out as u64),
                    Place::Output(job),
                    j.user,
                    r.output,
                    delta,
                )
                .map_err(Fail::Custody)?;
            ev.push(Event::Settled {
                job,
                out: delta,
                used,
                total: out,
            });
        }
        let jm = self.pool_mut(job.grant.facility).job_mut(job)?;
        jm.settled = out;
        if now >= jm.start {
            jm.started_logged = true;
        }
        if jm.fin == Fin::Open && now >= jm.start && now >= jm.end_eff() {
            let at = jm.end_eff();
            jm.fin = Fin::Completed(at);
            ev.push(Event::Completed { job, at, out });
        }
        Ok(())
    }

    /// Hand out what a job has made and, once it is final, what it did not
    /// use. `to` is `[output, refund of input 0, refund of input 1,
    /// remainder]`; with `split` each refund goes in whole units to its
    /// place and the sub-unit rest to `to[3]`, without it everything goes to
    /// `to[0]` (the four are equal).
    fn claim(
        &mut self,
        now: i64,
        signer: Actor,
        job: JobId,
        to: [Place; 4],
        split: bool,
        ev: &mut Vec<Event>,
    ) -> Result<bool, Fail> {
        let p = self
            .ledger
            .pools
            .get(&job.grant.facility)
            .ok_or(CapError::UnknownPool)?;
        let lost = p.lost_at.is_some();
        if !lost {
            self.pool_live(job.grant.facility)?;
        }
        let j = p.job(job)?;
        if j.user != signer {
            return Err(CapError::NotUser.into());
        }
        // A job's own places are kept by its books: goods put into another
        // job's hopper or output there would be stranded outside them.
        if to.iter().any(|t| t.kernel_only()) {
            return Err(CapError::BadPlace.into());
        }
        if !lost {
            self.settle(now, job, ev)?;
        }
        let j = self.job(job).expect("found").clone();
        let r = j.recipe();
        let output = j.settled - j.claimed;
        let refund = if j.fin != Fin::Open && !j.refunded {
            j.rest()
        } else {
            [0, 0]
        };
        if output == 0 && refund == [0, 0] {
            return if ev.is_empty() { Ok(false) } else { Ok(true) };
        }
        // Zero amounts are skipped: a key is spent only by a real move.
        if output > 0 {
            self.custody
                .transfer(
                    key(j.uid, K_CLAIM_OUT, j.settled as u64),
                    By::Kernel,
                    Place::Output(job),
                    to[0],
                    r.output,
                    output,
                    j.user,
                )
                .map_err(Fail::Custody)?;
        }
        let (whole, rest) = if split {
            (
                core::array::from_fn(|i| refund[i] / MILLI * MILLI),
                core::array::from_fn(|i| refund[i] % MILLI),
            )
        } else {
            (refund, [0, 0])
        };
        for (i, (res, _)) in r.inputs.iter().enumerate() {
            let place = if split { to[1 + i] } else { to[0] };
            for (n, amount, at) in [(0, whole[i], place), (1, rest[i], to[3])] {
                if amount > 0 {
                    self.custody
                        .transfer(
                            key(j.uid, K_REFUND * 16 + i as u8, n),
                            By::Kernel,
                            Place::Hopper(job),
                            at,
                            *res,
                            amount,
                            j.user,
                        )
                        .map_err(Fail::Custody)?;
                }
            }
        }
        let jm = self.pool_mut(job.grant.facility).job_mut(job)?;
        jm.claimed = jm.settled;
        if jm.fin != Fin::Open {
            jm.refunded = true;
            for (i, x) in refund.iter().enumerate() {
                jm.returned[i] = jm.returned[i].checked_add(*x).ok_or(CapError::Overflow)?;
            }
        }
        ev.push(Event::Claimed {
            job,
            output,
            refund,
            to: to[0],
        });
        if split && refund != [0, 0] {
            ev.push(Event::Refunded {
                job,
                whole,
                remainder: rest,
                refund_to: [to[1], to[2]],
                remainder_to: to[3],
            });
        }
        Ok(true)
    }

    /// The facility's generation ended (capture or release, written by the
    /// core): every job stops at that time, the pool closes, and what the
    /// jobs keep at the facility follows the loss policy.
    fn lose(&mut self, facility: FacilityId, ev: &mut Vec<Event>) -> Result<bool, Fail> {
        let p = self
            .ledger
            .pools
            .get(&facility)
            .ok_or(CapError::UnknownPool)?;
        if p.lost_at.is_some() {
            return Ok(false);
        }
        let fac = self
            .facilities
            .get(&facility.at)
            .ok_or(CapError::UnknownPool)?;
        let (at, captor) = fac.end_of(facility.gen).ok_or(CapError::FacilityLive)?;
        let policy = p.policies.loss;
        let ids: Vec<JobId> = p.jobs.iter().map(|j| j.id).collect();
        ev.push(Event::FacilityLost {
            facility,
            at,
            captor,
        });
        for id in ids {
            let j = self.job(id).expect("listed").clone();
            if j.fin == Fin::Open && at < j.end_eff().max(j.start) {
                // Credit up to the loss, then stop there.
                self.settle(at, id, ev)?;
                let jm = self.pool_mut(facility).job_mut(id)?;
                jm.fin = Fin::Lost(at);
                ev.push(Event::Lost {
                    job: id,
                    at,
                    out: jm.settled,
                });
            } else if j.fin == Fin::Open {
                // It had ended before the loss.
                self.settle(at, id, ev)?;
            }
            let j = self.job(id).expect("listed").clone();
            let output = j.settled - j.claimed;
            let refund = if j.refunded { [0, 0] } else { j.rest() };
            let (out_to, in_to) = match (policy, captor) {
                (_, None) | (LossPolicy::UserKeepsAll, _) => (None, None),
                (LossPolicy::CaptorTakesAll, Some(c)) => (Some(c), Some(c)),
                (LossPolicy::UserKeepsOutput, Some(c)) => (None, Some(c)),
            };
            let r = j.recipe();
            let to = Place::Holding(facility.at);
            if let Some(c) = out_to {
                if output > 0 {
                    self.custody
                        .transfer(
                            key(j.uid, K_LOSS_OUT, 0),
                            By::Kernel,
                            Place::Output(id),
                            to,
                            r.output,
                            output,
                            c,
                        )
                        .map_err(Fail::Custody)?;
                    let jm = self.pool_mut(facility).job_mut(id)?;
                    jm.claimed = j.settled;
                    jm.forfeited_out = jm
                        .forfeited_out
                        .checked_add(output)
                        .ok_or(CapError::Overflow)?;
                }
            }
            if let Some(c) = in_to {
                if refund != [0, 0] {
                    for (i, (res, _)) in r.inputs.iter().enumerate() {
                        if refund[i] > 0 {
                            self.custody
                                .transfer(
                                    key(j.uid, K_LOSS_IN * 16 + i as u8, 0),
                                    By::Kernel,
                                    Place::Hopper(id),
                                    to,
                                    *res,
                                    refund[i],
                                    c,
                                )
                                .map_err(Fail::Custody)?;
                        }
                    }
                    let jm = self.pool_mut(facility).job_mut(id)?;
                    jm.refunded = true;
                    for (i, x) in refund.iter().enumerate() {
                        jm.forfeited_in[i] = jm.forfeited_in[i]
                            .checked_add(*x)
                            .ok_or(CapError::Overflow)?;
                    }
                }
            }
            let fo = if out_to.is_some() { output } else { 0 };
            let fi = if in_to.is_some() { refund } else { [0, 0] };
            if let Some(c) = out_to.or(in_to) {
                if fo > 0 || fi != [0, 0] {
                    ev.push(Event::Forfeited {
                        job: id,
                        output: fo,
                        refund: fi,
                        to,
                        owner: c,
                    });
                }
            }
        }
        let p = self.pool_mut(facility);
        p.lost_at = Some(at);
        p.captor = captor;
        Ok(true)
    }
}
