//! Workstream 09: lending a workshop's processing capacity (feature
//! `capacity-preview`; a preview, not in any ruleset hash yet).
//!
//! Owner A takes workshop copies out of a Holding's own continuous arms
//! production (`Holding::lend_workshops`) and lends them as a **pool**;
//! under A's **grant**, user B reserves copies for a window (a **job**),
//! brings ore and wood, and the lent copies convert them at the workshop's
//! real rate over real time; B claims the arms. A signs only the owner's
//! operations; B's need only B's key; settling, a facility's loss and the
//! retirements are anyone's.
//!
//! This is workstream 09's kernel (`workstreams/09-capacity/kernel`, the
//! reference; its differential test `tests/rules_port.rs` runs both on the
//! same operations) in the program's shape: one **pool account** per
//! facility generation, holding its grants and an **occupancy table** (one
//! row per job: units, window, effective end, budget), and one **job
//! account** per reservation. The capacity checks (`Reserve`, `Reclaim`)
//! read the pool alone; a job's operations read the pool and that job.
//!
//! Goods do not move here. Every operation returns its [`Event`]s, and the
//! caller moves what they say between its places (the job account's own
//! hopper and output, a vault, workstream 10's lots, the facility's
//! stores): [`Event::Deposited`] in, [`Event::Claimed`] /
//! [`Event::Refunded`] out to the user, [`Event::Forfeited`] out to the
//! captor. What a job holds is [`Job::accounts`] (workstream 10's law,
//! `IN = HELD + OUT + CONSUMED + FORFEITED`).
//!
//! **Path independence.** A job's output is a pure function of its fixed
//! terms, its hopper (fixed at the start) and the time: settling at any
//! times credits the same output. **No period.** Nothing here knows a
//! season or a war period; numbers only increase, so a retired record's key
//! is never reused (`Retired`).
//!
//! Undecided and not widened here: a job taking one input from several
//! sources (workstream 09's `MixedSource`, the caller's), which resources
//! lots hold (ore only, workstream 10's), what a seized vault's lots become.

use alloc::vec::Vec;

use super::arms;
use super::holding::{Holding, Resource, DAY, HOUR};
use crate::fixed::MILLI;

/// A player: the Citizen key.
pub type Key = [u8; 32];

/// Jobs one pool holds [proposal, as workstream 09's kernel].
pub const MAX_JOBS: usize = 16;
/// Grants one pool holds.
pub const MAX_GRANTS: usize = 8;
/// Deposits one job takes.
pub const MAX_DEPOSITS: usize = 8;
/// Longest job window.
pub const MAX_WINDOW: i64 = 7 * DAY;

/// Refusals, with workstream 09's stable numbers (the program's error is
/// `109 + code`, workstream 4's provisional band 110–149).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum CapError {
    NotOwner = 1,
    NotUser = 2,
    WrongGeneration = 3,
    FacilityGone = 4,
    NotEnoughWorkshops = 5,
    CapacityExceeded = 6,
    ReclaimBlocked = 7,
    GrantUnitsExceeded = 8,
    GrantOutputExceeded = 9,
    OutsideGrantWindow = 10,
    GrantRevoked = 11,
    BadWindow = 12,
    AlreadyStarted = 13,
    AlreadyFinal = 14,
    UnknownGrant = 15,
    UnknownJob = 16,
    Conflict = 17,
    OwnerAway = 18,
    WrongRecipe = 19,
    WrongResource = 20,
    TooMany = 21,
    Custody = 22,
    Overflow = 23,
    TimeReversed = 24,
    UnknownPool = 25,
    FacilityLive = 26,
    BadPlace = 27,
    Retired = 28,
    GenerationReused = 29,
    NotRetirable = 30,
}

impl CapError {
    pub const fn code(self) -> u16 {
        self as u16
    }
}

pub type R<T> = Result<T, CapError>;

// ------------------------------------------------------------------ recipe

/// The workshop's conversion (`arms`): 2 ore and 1 wood per arm, 4 arms an
/// hour per copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipe {
    pub id: u8,
    pub inputs: [(Resource, i64); 2],
    pub output: Resource,
    /// Output per copy per hour (milli).
    pub rate: i64,
}

pub const RECIPE_ARMS: u8 = 1;

pub const ARMS_RECIPE: Recipe = Recipe {
    id: RECIPE_ARMS,
    inputs: [
        (Resource::Ore, arms::ORE_PER_ARM),
        (Resource::Wood, arms::WOOD_PER_ARM),
    ],
    output: arms::ARMS,
    rate: arms::WORKSHOP_DELTA,
};
const _: () = assert!(ARMS_RECIPE.rate == arms::WORKSHOP_ARMS_PER_HOUR * MILLI);

pub fn recipe(id: u8) -> Option<&'static Recipe> {
    (id == RECIPE_ARMS).then_some(&ARMS_RECIPE)
}

impl Recipe {
    pub fn input_index(&self, r: Resource) -> Option<usize> {
        self.inputs.iter().position(|(x, _)| *x == r)
    }

    /// Output `units` copies make in `secs` (floor, milli).
    pub fn capacity_output(&self, units: u32, secs: i64) -> i64 {
        let v = units as i128 * self.rate as i128 * secs.max(0) as i128 / HOUR as i128;
        v.min(i64::MAX as i128) as i64
    }

    /// Seconds `units` copies need for `out` (ceil).
    pub fn secs_for(&self, units: u32, out: i64) -> i64 {
        if out <= 0 || units == 0 {
            return 0;
        }
        let per = units as i128 * self.rate as i128;
        let n = out as i128 * HOUR as i128;
        ((n + per - 1) / per).min(i64::MAX as i128) as i64
    }

    /// The output a hopper can feed.
    pub fn fed_by(&self, hopper: &[i64; 2]) -> i64 {
        let mut m = i64::MAX;
        for (i, (_, per)) in self.inputs.iter().enumerate() {
            m = m.min(hopper[i].max(0) / per);
        }
        m
    }

    pub fn used_for(&self, out: i64) -> [i64; 2] {
        core::array::from_fn(|i| out * self.inputs[i].1)
    }
}

// ------------------------------------------------------------------ policies

/// What a facility's loss does to the goods its jobs keep there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LossPolicy {
    CaptorTakesAll = 0,
    UserKeepsAll = 1,
    UserKeepsOutput = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DormancyPolicy {
    Unaffected = 0,
    RefuseNewWhenDormant = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RevokePolicy {
    HonorBooked = 0,
    CancelBooked = 1,
}

/// The pool's three policies (workstream 09's provisional choices;
/// switchable per pool, none decided).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policies {
    pub loss: LossPolicy,
    pub dormancy: DormancyPolicy,
    pub revoke: RevokePolicy,
}

impl Policies {
    pub const PROVISIONAL: Policies = Policies {
        loss: LossPolicy::CaptorTakesAll,
        dormancy: DormancyPolicy::Unaffected,
        revoke: RevokePolicy::HonorBooked,
    };

    pub const fn encode(&self) -> [u8; 3] {
        [self.loss as u8, self.dormancy as u8, self.revoke as u8]
    }

    pub const fn decode(b: [u8; 3]) -> Option<Policies> {
        let loss = match b[0] {
            0 => LossPolicy::CaptorTakesAll,
            1 => LossPolicy::UserKeepsAll,
            2 => LossPolicy::UserKeepsOutput,
            _ => return None,
        };
        let dormancy = match b[1] {
            0 => DormancyPolicy::Unaffected,
            1 => DormancyPolicy::RefuseNewWhenDormant,
            _ => return None,
        };
        let revoke = match b[2] {
            0 => RevokePolicy::HonorBooked,
            1 => RevokePolicy::CancelBooked,
            _ => return None,
        };
        Some(Policies {
            loss,
            dormancy,
            revoke,
        })
    }
}

// ------------------------------------------------------------------ records

/// A facility: a Holding's site and its generation (`Holding.GEN`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FacilityId {
    pub p: i16,
    pub q: i16,
    pub site: u8,
    pub gen: u8,
}

/// The facility as the caller reads it from its Holding: its current
/// generation and owner, whether that generation number was used before (a
/// wrapped u8), and how the pool's generation ended, if it did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facility {
    pub gen: u8,
    pub owner: Key,
    /// The current generation number met an earlier, ended one.
    pub reused: bool,
    /// The pool's generation ended at this time, taken by this captor (or
    /// released, `None`).
    pub end: Option<(i64, Option<Key>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub seq: u32,
    pub user: Key,
    pub recipe: u8,
    pub max_units: u32,
    pub max_output: i64,
    pub from: i64,
    pub until: i64,
    pub revoked_at: Option<i64>,
    /// Output of this grant's retired jobs (still counted in `max_output`).
    pub spent: i64,
    pub last_job_seq: Option<u32>,
}

/// The pool's row for one job: what the capacity checks need.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Occ {
    pub grant: u32,
    pub job: u32,
    pub units: u32,
    pub start: i64,
    pub end: i64,
    /// The job's effective end as of its last write ([`Job::end_eff`]).
    pub end_eff: i64,
    pub open: bool,
    /// What it holds of its grant's output budget: its max output while
    /// open, what it made once final.
    pub budget: i64,
}

impl Occ {
    /// The interval it holds capacity, as known at `now` (until it starts
    /// its hopper may grow: the whole window).
    pub fn occupies(&self, now: i64) -> (i64, i64) {
        let end = if !self.open || now >= self.start {
            self.end_eff
        } else {
            self.end
        };
        (self.start, end.max(self.start))
    }
}

/// The owner's last Lend or Reclaim (for its replay).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnerOp {
    pub lend: bool,
    pub units: u32,
    pub seq: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    pub facility: FacilityId,
    pub owner: Key,
    pub policies: Policies,
    pub lent: u32,
    pub owner_seq: u32,
    pub last_owner_op: Option<OwnerOp>,
    pub grants: Vec<Grant>,
    pub occ: Vec<Occ>,
    pub lost_at: Option<i64>,
    pub captor: Option<Key>,
    pub last_grant_seq: Option<u32>,
    /// The next job uid (never reused: it scopes a job's custody keys).
    pub next_uid: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fin {
    Open,
    Completed(i64),
    Cancelled(i64),
    Lost(i64),
}

/// One deposit: its id, the recipe input, the amount, and where it came
/// from (the caller's tag of the source place).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deposit {
    pub id: u64,
    pub input: u8,
    pub amount: i64,
    pub src: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub grant: u32,
    pub seq: u32,
    pub uid: u64,
    pub user: Key,
    pub recipe: u8,
    pub units: u32,
    pub start: i64,
    pub end: i64,
    pub max_output: i64,
    pub hopper: [i64; 2],
    pub deposits: Vec<Deposit>,
    pub fin: Fin,
    pub settled: i64,
    pub started_logged: bool,
    pub claimed: i64,
    pub refunded: bool,
    pub returned: [i64; 2],
    pub forfeited_in: [i64; 2],
    pub forfeited_out: i64,
}

/// One resource of a job as an account (workstream 10's law).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub in_total: i64,
    pub held: i64,
    pub out_total: i64,
    pub consumed: i64,
    pub forfeited: i64,
}

impl Account {
    pub fn balanced(&self) -> bool {
        self.held >= 0
            && self.out_total >= 0
            && self.consumed >= 0
            && self.forfeited >= 0
            && self.in_total == self.held + self.out_total + self.consumed + self.forfeited
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Accounts {
    pub inputs: [Account; 2],
    pub output: Account,
}

impl Job {
    pub fn recipe(&self) -> &'static Recipe {
        recipe(self.recipe).unwrap_or(&ARMS_RECIPE)
    }

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

    /// Output made by `t` (a pure function).
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

    /// What the hopper still holds.
    pub fn rest(&self) -> [i64; 2] {
        let used = self.recipe().used_for(self.settled);
        [self.hopper[0] - used[0], self.hopper[1] - used[1]]
    }

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

    fn row(&self) -> Occ {
        Occ {
            grant: self.grant,
            job: self.seq,
            units: self.units,
            start: self.start,
            end: self.end,
            end_eff: self.end_eff(),
            open: self.fin == Fin::Open,
            budget: if self.fin == Fin::Open {
                self.max_output
            } else {
                self.settled
            },
        }
    }
}

// ------------------------------------------------------------------ events

/// What an operation did; the caller logs them and moves the goods they
/// name. `job` is `(grant seq, job seq)` in the pool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    PoolOpened {
        owner: Key,
    },
    Lent {
        units: u32,
        lent: u32,
        at: i64,
    },
    Reclaimed {
        units: u32,
        lent: u32,
        at: i64,
    },
    Granted {
        grant: u32,
        user: Key,
    },
    Revoked {
        grant: u32,
        at: i64,
        cancelled: u32,
    },
    Reserved {
        job: (u32, u32),
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
    },
    /// `amount` of the job's input `resource` came in from `src`.
    Deposited {
        job: (u32, u32),
        deposit: u64,
        resource: Resource,
        amount: i64,
    },
    Started {
        job: (u32, u32),
        at: i64,
    },
    /// `out` more made, `used` of the inputs consumed (within the job).
    Settled {
        job: (u32, u32),
        out: i64,
        used: [i64; 2],
        total: i64,
    },
    Completed {
        job: (u32, u32),
        at: i64,
        out: i64,
    },
    Cancelled {
        job: (u32, u32),
        at: i64,
        out: i64,
    },
    Lost {
        job: (u32, u32),
        at: i64,
        out: i64,
    },
    /// `output` and `refund` leave the job for the user (to the claim's
    /// destination; split: see [`Event::Refunded`]).
    Claimed {
        job: (u32, u32),
        output: i64,
        refund: [i64; 2],
    },
    /// A split claim's refund: whole units to each input's place, the
    /// sub-unit rest to the remainder's place.
    Refunded {
        job: (u32, u32),
        whole: [i64; 2],
        remainder: [i64; 2],
    },
    /// `output` and `refund` leave the job for `owner` (the captor), into
    /// the facility's stores.
    Forfeited {
        job: (u32, u32),
        output: i64,
        refund: [i64; 2],
        owner: Key,
    },
    FacilityLost {
        at: i64,
        captor: Option<Key>,
    },
    Retired {
        job: (u32, u32),
        uid: u64,
        output: i64,
    },
    Receipt {
        job: (u32, u32),
        uid: u64,
        accounts: Accounts,
    },
    GrantRetired {
        grant: u32,
    },
    PoolRetired,
}

/// An operation's outcome: applied (with its events) or applied before
/// (nothing changed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Done {
    Applied(Vec<Event>),
    Already,
}

// ------------------------------------------------------------------ pool

impl Pool {
    fn peak(&self, now: i64, from: i64, to: i64, keep: impl Fn(&Occ) -> bool) -> u32 {
        let mut edges: Vec<(i64, i64)> = Vec::new();
        for o in self.occ.iter().filter(|o| keep(o)) {
            let (s, e) = o.occupies(now);
            let (s, e) = (s.max(from), e.min(to));
            if s < e {
                edges.push((s, o.units as i64));
                edges.push((e, -(o.units as i64)));
            }
        }
        edges.sort();
        let (mut cur, mut peak) = (0i64, 0i64);
        for (_, d) in edges {
            cur += d;
            peak = peak.max(cur);
        }
        peak as u32
    }

    pub fn grant(&self, seq: u32) -> R<&Grant> {
        match self.grants.iter().find(|g| g.seq == seq) {
            Some(g) => Ok(g),
            None if self.last_grant_seq.is_some_and(|l| seq <= l) => Err(CapError::Retired),
            None => Err(CapError::UnknownGrant),
        }
    }

    fn grant_mut(&mut self, seq: u32) -> R<&mut Grant> {
        self.grant(seq)?;
        Ok(self
            .grants
            .iter_mut()
            .find(|g| g.seq == seq)
            .expect("found"))
    }

    /// Why job `(grant, seq)` has no account: a number at or below the
    /// grant's highest belongs to a retired job (or grant).
    pub fn missing_job(&self, grant: u32, seq: u32) -> CapError {
        match self.grant(grant) {
            Err(e) => e,
            Ok(g) if g.last_job_seq.is_some_and(|l| seq <= l) => CapError::Retired,
            Ok(_) => CapError::UnknownJob,
        }
    }

    fn row(&self, job: &Job) -> R<usize> {
        self.occ
            .iter()
            .position(|o| (o.grant, o.job) == (job.grant, job.seq))
            .ok_or(CapError::UnknownJob)
    }

    /// Writes the job's row (after any change to the job).
    fn put(&mut self, job: &Job) -> R<()> {
        let i = self.row(job)?;
        self.occ[i] = job.row();
        Ok(())
    }

    fn grant_output(&self, seq: u32) -> i64 {
        let spent = self
            .grants
            .iter()
            .find(|g| g.seq == seq)
            .map_or(0, |g| g.spent);
        self.occ
            .iter()
            .filter(|o| o.grant == seq)
            .fold(spent, |a, o| a.saturating_add(o.budget))
    }
}

fn live(f: &Facility, gen: u8) -> R<()> {
    if f.gen != gen {
        return Err(CapError::WrongGeneration);
    }
    if f.reused {
        return Err(CapError::GenerationReused);
    }
    Ok(())
}

fn pool_live(p: &Pool, f: &Facility) -> R<()> {
    if p.lost_at.is_some() {
        return Err(CapError::FacilityGone);
    }
    live(f, p.facility.gen)
}

/// The job is the pool's (its row exists and names it).
fn check_job(p: &Pool, j: &Job) -> R<()> {
    p.row(j).map(|_| ())
}

/// The job's account for `(grant, seq)`, or why there is none.
fn need<'a>(p: &Pool, j: Option<&'a mut Job>, grant: u32, seq: u32) -> R<&'a mut Job> {
    match j {
        Some(j) if (j.grant, j.seq) == (grant, seq) => {
            check_job(p, j)?;
            Ok(j)
        }
        Some(_) => Err(CapError::UnknownJob),
        None => Err(p.missing_job(grant, seq)),
    }
}

// ------------------------------------------------------------------ operations

/// OpenCapacityPool: the facility's owner opens its pool for generation
/// `id.gen` (`existing`: the pool account already there, if any).
pub fn open_pool(
    existing: Option<&Pool>,
    f: &Facility,
    signer: &Key,
    id: FacilityId,
    policies: Policies,
) -> R<(Option<Pool>, Done)> {
    if let Some(p) = existing {
        if p.lost_at.is_some() {
            return Err(CapError::GenerationReused);
        }
        live(f, id.gen)?;
        return if p.owner == *signer && p.policies == policies {
            Ok((None, Done::Already))
        } else {
            Err(CapError::Conflict)
        };
    }
    live(f, id.gen)?;
    if f.owner != *signer {
        return Err(CapError::NotOwner);
    }
    let pool = Pool {
        facility: id,
        owner: *signer,
        policies,
        lent: 0,
        owner_seq: 0,
        last_owner_op: None,
        grants: Vec::new(),
        occ: Vec::new(),
        lost_at: None,
        captor: None,
        last_grant_seq: None,
        next_uid: 0,
    };
    Ok((
        Some(pool),
        Done::Applied(alloc::vec![Event::PoolOpened { owner: *signer }]),
    ))
}

/// LendCapacity (`lend`) or ReclaimCapacity: the owner moves `units`
/// workshop copies between the Holding's own production and the pool.
#[allow(clippy::too_many_arguments)]
pub fn lend(
    p: &mut Pool,
    h: &mut Holding,
    f: &Facility,
    now: i64,
    signer: &Key,
    lend: bool,
    units: u32,
    seq: u32,
) -> R<Done> {
    pool_live(p, f)?;
    if p.owner != *signer {
        return Err(CapError::NotOwner);
    }
    let op = OwnerOp { lend, units, seq };
    if seq != p.owner_seq {
        return if seq.checked_add(1) == Some(p.owner_seq) && p.last_owner_op == Some(op) {
            Ok(Done::Already)
        } else {
            Err(CapError::Conflict)
        };
    }
    if units == 0 {
        return Err(CapError::BadWindow);
    }
    let lent = if lend {
        p.lent.checked_add(units).ok_or(CapError::Overflow)?
    } else {
        let left = p.lent.checked_sub(units).ok_or(CapError::ReclaimBlocked)?;
        if p.peak(now, now, i64::MAX, |_| true) > left {
            return Err(CapError::ReclaimBlocked);
        }
        left
    };
    h.touch_owner(now).map_err(|_| CapError::TimeReversed)?;
    if lend {
        h.lend_workshops(now, units)
            .map_err(|_| CapError::NotEnoughWorkshops)?;
    } else {
        h.reclaim_workshops(now, units)
            .map_err(|_| CapError::ReclaimBlocked)?;
    }
    p.lent = lent;
    p.owner_seq = p.owner_seq.checked_add(1).ok_or(CapError::Overflow)?;
    p.last_owner_op = Some(op);
    Ok(Done::Applied(alloc::vec![if lend {
        Event::Lent {
            units,
            lent,
            at: now,
        }
    } else {
        Event::Reclaimed {
            units,
            lent,
            at: now,
        }
    }]))
}

/// GrantCapacity.
pub fn grant(p: &mut Pool, f: &Facility, now: i64, signer: &Key, g: Grant) -> R<Done> {
    pool_live(p, f)?;
    if p.owner != *signer {
        return Err(CapError::NotOwner);
    }
    let g = Grant {
        revoked_at: None,
        spent: 0,
        last_job_seq: None,
        ..g
    };
    if let Some(old) = p.grants.iter().find(|x| x.seq == g.seq) {
        let terms = Grant {
            revoked_at: None,
            spent: 0,
            last_job_seq: None,
            ..*old
        };
        return if terms == g {
            Ok(Done::Already)
        } else {
            Err(CapError::Conflict)
        };
    }
    if recipe(g.recipe).is_none() {
        return Err(CapError::WrongRecipe);
    }
    if g.max_units == 0 || g.max_output <= 0 || g.from >= g.until || g.until <= now {
        return Err(CapError::BadWindow);
    }
    if p.last_grant_seq.is_some_and(|l| g.seq <= l) {
        return Err(CapError::Retired);
    }
    if p.grants.len() >= MAX_GRANTS {
        return Err(CapError::TooMany);
    }
    p.grants.push(g);
    p.last_grant_seq = Some(g.seq);
    Ok(Done::Applied(alloc::vec![Event::Granted {
        grant: g.seq,
        user: g.user
    }]))
}

/// RevokeCapacity. Under `CancelBooked`, `booked` must be every job of the
/// grant still open and not started at `now`, in the pool's order.
pub fn revoke(
    p: &mut Pool,
    f: &Facility,
    now: i64,
    signer: &Key,
    seq: u32,
    booked: &mut [&mut Job],
) -> R<Done> {
    pool_live(p, f)?;
    if p.owner != *signer {
        return Err(CapError::NotOwner);
    }
    if p.grant(seq)?.revoked_at.is_some() {
        return Ok(Done::Already);
    }
    let cancel = p.policies.revoke == RevokePolicy::CancelBooked;
    let want: Vec<(u32, u32)> = if cancel {
        p.occ
            .iter()
            .filter(|o| o.grant == seq && o.open && now < o.start)
            .map(|o| (o.grant, o.job))
            .collect()
    } else {
        Vec::new()
    };
    let given: Vec<(u32, u32)> = booked.iter().map(|j| (j.grant, j.seq)).collect();
    if want != given {
        return Err(CapError::UnknownJob);
    }
    p.grant_mut(seq)?.revoked_at = Some(now);
    let mut ev = Vec::new();
    let mut n = 0;
    for j in booked.iter_mut() {
        j.fin = Fin::Cancelled(now);
        p.put(j)?;
        n += 1;
        ev.push(Event::Cancelled {
            job: (j.grant, j.seq),
            at: now,
            out: 0,
        });
    }
    ev.push(Event::Revoked {
        grant: seq,
        at: now,
        cancelled: n,
    });
    Ok(Done::Applied(ev))
}

/// ReserveCapacity: the grant's user books `units` copies for
/// `[start, end)`. `existing`: the job's account, if it is already there;
/// `dormant`: the facility's owner is away at `now`.
#[allow(clippy::too_many_arguments)]
pub fn reserve(
    p: &mut Pool,
    f: &Facility,
    dormant: bool,
    existing: Option<&Job>,
    now: i64,
    signer: &Key,
    grant: u32,
    seq: u32,
    units: u32,
    start: i64,
    end: i64,
    max_output: i64,
) -> R<(Option<Job>, Done)> {
    pool_live(p, f)?;
    let g = *p.grant(grant)?;
    if g.user != *signer {
        return Err(CapError::NotUser);
    }
    if let Some(j) = existing {
        if (j.grant, j.seq) != (grant, seq) {
            return Err(CapError::UnknownJob);
        }
        let same = (j.units, j.start, j.end, j.max_output) == (units, start, end, max_output);
        return if same {
            Ok((None, Done::Already))
        } else {
            Err(CapError::Conflict)
        };
    }
    if g.last_job_seq.is_some_and(|l| seq <= l) {
        return Err(CapError::Retired);
    }
    if g.revoked_at.is_some() {
        return Err(CapError::GrantRevoked);
    }
    if units == 0 || max_output <= 0 || start >= end || start < now || end - start > MAX_WINDOW {
        return Err(CapError::BadWindow);
    }
    if start < g.from || end > g.until {
        return Err(CapError::OutsideGrantWindow);
    }
    if p.policies.dormancy == DormancyPolicy::RefuseNewWhenDormant && dormant {
        return Err(CapError::OwnerAway);
    }
    // `units` and `max_output` are the instruction's: a sum past the type's
    // range exceeds every cap (this crate is built without overflow checks).
    let same_grant = p.peak(now, start, end, |o| o.grant == grant);
    if same_grant
        .checked_add(units)
        .is_none_or(|n| n > g.max_units)
    {
        return Err(CapError::GrantUnitsExceeded);
    }
    if p.grant_output(grant)
        .checked_add(max_output)
        .is_none_or(|n| n > g.max_output)
    {
        return Err(CapError::GrantOutputExceeded);
    }
    if p.peak(now, start, end, |_| true)
        .checked_add(units)
        .is_none_or(|n| n > p.lent)
    {
        return Err(CapError::CapacityExceeded);
    }
    if p.occ.len() >= MAX_JOBS {
        return Err(CapError::TooMany);
    }
    let uid = p.next_uid;
    let j = Job {
        grant,
        seq,
        uid,
        user: *signer,
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
    p.next_uid = uid.checked_add(1).ok_or(CapError::Overflow)?;
    p.occ.push(j.row());
    p.grant_mut(grant)?.last_job_seq = Some(seq);
    Ok((
        Some(j),
        Done::Applied(alloc::vec![Event::Reserved {
            job: (grant, seq),
            units,
            start,
            end,
            max_output,
        }]),
    ))
}

/// DepositToJob: the job's user brings `amount` of `resource` from the
/// place the caller tags `src` (the caller moves it on `Deposited`).
#[allow(clippy::too_many_arguments)]
pub fn deposit(
    p: &mut Pool,
    f: &Facility,
    j: Option<&mut Job>,
    job: (u32, u32),
    now: i64,
    signer: &Key,
    id: u64,
    resource: Resource,
    amount: i64,
    src: u64,
) -> R<Done> {
    pool_live(p, f)?;
    let j = need(p, j, job.0, job.1)?;
    if j.user != *signer {
        return Err(CapError::NotUser);
    }
    let i = j
        .recipe()
        .input_index(resource)
        .ok_or(CapError::WrongResource)?;
    let d = Deposit {
        id,
        input: i as u8,
        amount,
        src,
    };
    if let Some(old) = j.deposits.iter().find(|x| x.id == id) {
        return if *old == d {
            Ok(Done::Already)
        } else {
            Err(CapError::Conflict)
        };
    }
    if j.fin != Fin::Open {
        return Err(CapError::AlreadyFinal);
    }
    if now >= j.start {
        return Err(CapError::AlreadyStarted);
    }
    if amount <= 0 {
        return Err(CapError::WrongResource);
    }
    if j.deposits.len() >= MAX_DEPOSITS {
        return Err(CapError::TooMany);
    }
    j.hopper[i] = j.hopper[i].checked_add(amount).ok_or(CapError::Overflow)?;
    j.deposits.push(d);
    p.put(j)?;
    Ok(Done::Applied(alloc::vec![Event::Deposited {
        job: (j.grant, j.seq),
        deposit: id,
        resource,
        amount,
    }]))
}

/// Credit the output made by `now` and use its inputs; finalize a job
/// whose conversion has ended.
fn settle_job(p: &mut Pool, j: &mut Job, now: i64, ev: &mut Vec<Event>) -> R<()> {
    let r = *j.recipe();
    let id = (j.grant, j.seq);
    if !j.started_logged && now >= j.start {
        ev.push(Event::Started {
            job: id,
            at: j.start,
        });
    }
    let out = j.out_at(now);
    let delta = out - j.settled;
    if delta > 0 {
        ev.push(Event::Settled {
            job: id,
            out: delta,
            used: r.used_for(delta),
            total: out,
        });
    }
    j.settled = out;
    if now >= j.start {
        j.started_logged = true;
    }
    if j.fin == Fin::Open && now >= j.start && now >= j.end_eff() {
        let at = j.end_eff();
        j.fin = Fin::Completed(at);
        ev.push(Event::Completed { job: id, at, out });
    }
    p.put(j)
}

/// SettleJob (anyone).
pub fn settle(
    p: &mut Pool,
    f: &Facility,
    j: Option<&mut Job>,
    job: (u32, u32),
    now: i64,
) -> R<Done> {
    pool_live(p, f)?;
    let j = need(p, j, job.0, job.1)?;
    let mut ev = Vec::new();
    settle_job(p, j, now, &mut ev)?;
    Ok(if ev.is_empty() {
        Done::Already
    } else {
        Done::Applied(ev)
    })
}

/// CancelJob (the user).
pub fn cancel(
    p: &mut Pool,
    f: &Facility,
    j: Option<&mut Job>,
    job: (u32, u32),
    now: i64,
    signer: &Key,
) -> R<Done> {
    pool_live(p, f)?;
    let j = need(p, j, job.0, job.1)?;
    if j.user != *signer {
        return Err(CapError::NotUser);
    }
    if matches!(j.fin, Fin::Cancelled(_)) {
        return Ok(Done::Already);
    }
    if j.fin != Fin::Open || now >= j.end_eff() && now >= j.start {
        return Err(CapError::AlreadyFinal);
    }
    let mut ev = Vec::new();
    settle_job(p, j, now, &mut ev)?;
    j.fin = Fin::Cancelled(now);
    let out = j.out_at(now);
    p.put(j)?;
    ev.push(Event::Cancelled {
        job: (j.grant, j.seq),
        at: now,
        out,
    });
    Ok(Done::Applied(ev))
}

/// ClaimJob (the user): what the job made and, once final, what it did not
/// use. `split`: the refund's whole units and sub-unit rest separately
/// (workstream 10's lots take whole units). `to_job_place`: a destination
/// is a job's own place (refused, `BadPlace`).
#[allow(clippy::too_many_arguments)]
pub fn claim(
    p: &mut Pool,
    f: &Facility,
    j: Option<&mut Job>,
    job: (u32, u32),
    now: i64,
    signer: &Key,
    split: bool,
    to_job_place: bool,
) -> R<Done> {
    let lost = p.lost_at.is_some();
    if !lost {
        pool_live(p, f)?;
    }
    let j = need(p, j, job.0, job.1)?;
    if j.user != *signer {
        return Err(CapError::NotUser);
    }
    if to_job_place {
        return Err(CapError::BadPlace);
    }
    let mut ev = Vec::new();
    if !lost {
        settle_job(p, j, now, &mut ev)?;
    }
    let output = j.settled - j.claimed;
    let refund = if j.fin != Fin::Open && !j.refunded {
        j.rest()
    } else {
        [0, 0]
    };
    if output == 0 && refund == [0, 0] {
        return Ok(if ev.is_empty() {
            Done::Already
        } else {
            Done::Applied(ev)
        });
    }
    let (whole, rest): ([i64; 2], [i64; 2]) = if split {
        (
            core::array::from_fn(|i| refund[i] / MILLI * MILLI),
            core::array::from_fn(|i| refund[i] % MILLI),
        )
    } else {
        (refund, [0, 0])
    };
    j.claimed = j.settled;
    if j.fin != Fin::Open {
        j.refunded = true;
        for (i, x) in refund.iter().enumerate() {
            j.returned[i] = j.returned[i].checked_add(*x).ok_or(CapError::Overflow)?;
        }
    }
    p.put(j)?;
    let id = (j.grant, j.seq);
    ev.push(Event::Claimed {
        job: id,
        output,
        refund,
    });
    if split && refund != [0, 0] {
        ev.push(Event::Refunded {
            job: id,
            whole,
            remainder: rest,
        });
    }
    Ok(Done::Applied(ev))
}

/// RecordFacilityLoss (anyone): the pool's generation ended (`f.end`);
/// every job stops then, the pool closes, and what the jobs keep follows
/// the loss policy. `jobs` must be every job of the pool, in its order.
pub fn lose(p: &mut Pool, f: &Facility, jobs: &mut [&mut Job]) -> R<Done> {
    if p.lost_at.is_some() {
        return Ok(Done::Already);
    }
    let (at, captor) = f.end.ok_or(CapError::FacilityLive)?;
    let given: Vec<(u32, u32)> = jobs.iter().map(|j| (j.grant, j.seq)).collect();
    let want: Vec<(u32, u32)> = p.occ.iter().map(|o| (o.grant, o.job)).collect();
    if given != want {
        return Err(CapError::UnknownJob);
    }
    let policy = p.policies.loss;
    let mut ev = alloc::vec![Event::FacilityLost { at, captor }];
    for j in jobs.iter_mut() {
        let id = (j.grant, j.seq);
        if j.fin == Fin::Open && at < j.end_eff().max(j.start) {
            settle_job(p, j, at, &mut ev)?;
            j.fin = Fin::Lost(at);
            p.put(j)?;
            ev.push(Event::Lost {
                job: id,
                at,
                out: j.settled,
            });
        } else if j.fin == Fin::Open {
            settle_job(p, j, at, &mut ev)?;
        }
        let output = j.settled - j.claimed;
        let refund = if j.refunded { [0, 0] } else { j.rest() };
        let (out_to, in_to) = match (policy, captor) {
            (_, None) | (LossPolicy::UserKeepsAll, _) => (None, None),
            (LossPolicy::CaptorTakesAll, Some(c)) => (Some(c), Some(c)),
            (LossPolicy::UserKeepsOutput, Some(c)) => (None, Some(c)),
        };
        let mut fo = 0;
        let mut fi = [0, 0];
        if out_to.is_some() && output > 0 {
            j.claimed = j.settled;
            j.forfeited_out = j
                .forfeited_out
                .checked_add(output)
                .ok_or(CapError::Overflow)?;
            fo = output;
        }
        if in_to.is_some() && refund != [0, 0] {
            j.refunded = true;
            for (i, x) in refund.iter().enumerate() {
                j.forfeited_in[i] = j.forfeited_in[i]
                    .checked_add(*x)
                    .ok_or(CapError::Overflow)?;
            }
            fi = refund;
        }
        p.put(j)?;
        if let Some(c) = out_to.or(in_to) {
            if fo > 0 || fi != [0, 0] {
                ev.push(Event::Forfeited {
                    job: id,
                    output: fo,
                    refund: fi,
                    owner: c,
                });
            }
        }
    }
    p.lost_at = Some(at);
    p.captor = captor;
    Ok(Done::Applied(ev))
}

/// RetireJob (anyone): close a final, fully handed-out job's record (the
/// caller closes its account on `Retired`).
pub fn retire(p: &mut Pool, j: Option<&Job>, job: (u32, u32)) -> R<Done> {
    let j = match j {
        Some(j) if (j.grant, j.seq) == job => {
            check_job(p, j)?;
            j
        }
        Some(_) => return Err(CapError::UnknownJob),
        None => {
            return match p.missing_job(job.0, job.1) {
                CapError::Retired => Ok(Done::Already),
                e => Err(e),
            }
        }
    };
    let handed_out = j.claimed == j.settled && (j.refunded || j.rest() == [0, 0]);
    if j.fin == Fin::Open || !handed_out {
        return Err(CapError::NotRetirable);
    }
    let id = (j.grant, j.seq);
    p.occ.retain(|o| (o.grant, o.job) != id);
    let g = p.grant_mut(j.grant)?;
    g.spent = g.spent.checked_add(j.settled).ok_or(CapError::Overflow)?;
    Ok(Done::Applied(alloc::vec![
        Event::Receipt {
            job: id,
            uid: j.uid,
            accounts: j.accounts(),
        },
        Event::Retired {
            job: id,
            uid: j.uid,
            output: j.settled,
        },
    ]))
}

/// RetireGrant (anyone): close a revoked or expired grant with no job left.
pub fn retire_grant(p: &mut Pool, now: i64, seq: u32) -> R<Done> {
    let g = match p.grant(seq) {
        Err(CapError::Retired) => return Ok(Done::Already),
        r => *r?,
    };
    let over = g.revoked_at.is_some() || now >= g.until || p.lost_at.is_some();
    if !over || p.occ.iter().any(|o| o.grant == seq) {
        return Err(CapError::NotRetirable);
    }
    p.grants.retain(|g| g.seq != seq);
    Ok(Done::Applied(alloc::vec![Event::GrantRetired {
        grant: seq
    }]))
}

/// RetirePool (anyone): close a lost generation's pool with no job left
/// (the caller closes its account).
pub fn retire_pool(p: &Pool) -> R<Done> {
    if p.lost_at.is_none() || !p.occ.is_empty() {
        return Err(CapError::NotRetirable);
    }
    Ok(Done::Applied(alloc::vec![Event::PoolRetired]))
}

// ------------------------------------------------------------------ layout

/// The accounts' byte layouts (little endian), with magic and kind as
/// workstream 4's provisional allocation (rev 3): AccountKind 25
/// CapacityPool and 26 CapacityJob, seeds `cp` and `cj`; the magic values
/// are workstream 09's proposal.
pub mod layout {
    use super::*;

    // Within one small account each.
    const _: () = assert!(pool::SIZE < 2_048 && job::SIZE < 512);

    /// `Option<i64>` and `Option<u32>` are a flag byte and the value.
    fn put(d: &mut [u8], o: &mut usize, b: &[u8]) {
        d[*o..*o + b.len()].copy_from_slice(b);
        *o += b.len();
    }

    fn take<'a>(d: &'a [u8], o: &mut usize, n: usize) -> Option<&'a [u8]> {
        let b = d.get(*o..*o + n)?;
        *o += n;
        Some(b)
    }

    fn i64_(d: &[u8], o: &mut usize) -> Option<i64> {
        Some(i64::from_le_bytes(take(d, o, 8)?.try_into().ok()?))
    }

    fn u64_(d: &[u8], o: &mut usize) -> Option<u64> {
        Some(u64::from_le_bytes(take(d, o, 8)?.try_into().ok()?))
    }

    fn u32_(d: &[u8], o: &mut usize) -> Option<u32> {
        Some(u32::from_le_bytes(take(d, o, 4)?.try_into().ok()?))
    }

    fn u8_(d: &[u8], o: &mut usize) -> Option<u8> {
        Some(take(d, o, 1)?[0])
    }

    /// A flag byte: 0 or 1, anything else is not a record of ours.
    fn flag(d: &[u8], o: &mut usize) -> Option<bool> {
        match u8_(d, o)? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }

    fn key(d: &[u8], o: &mut usize) -> Option<Key> {
        take(d, o, 32)?.try_into().ok()
    }

    fn opt_i64(d: &[u8], o: &mut usize) -> Option<Option<i64>> {
        let f = u8_(d, o)?;
        let v = i64_(d, o)?;
        match f {
            0 => Some(None),
            1 => Some(Some(v)),
            _ => None,
        }
    }

    fn opt_u32(d: &[u8], o: &mut usize) -> Option<Option<u32>> {
        let f = u8_(d, o)?;
        let v = u32_(d, o)?;
        match f {
            0 => Some(None),
            1 => Some(Some(v)),
            _ => None,
        }
    }

    fn put_opt_i64(d: &mut [u8], o: &mut usize, v: Option<i64>) {
        put(d, o, &[v.is_some() as u8]);
        put(d, o, &v.unwrap_or(0).to_le_bytes());
    }

    fn put_opt_u32(d: &mut [u8], o: &mut usize, v: Option<u32>) {
        put(d, o, &[v.is_some() as u8]);
        put(d, o, &v.unwrap_or(0).to_le_bytes());
    }

    /// CapacityPool: `cp ‖ P ‖ Q ‖ site ‖ gen`.
    pub mod pool {
        pub const MAGIC: &[u8; 8] = b"PSF1CPOL";
        pub const ACCOUNT_KIND: u8 = 25;
        pub const SEED: &[u8; 2] = b"cp";
        /// Header (magic 8, version 2, kind 1, pad 5) and the record.
        pub const HEADER: usize = 16;
        pub const GRANT: usize = 4 + 32 + 1 + 4 + 8 + 8 + 8 + 9 + 8 + 5;
        pub const OCC: usize = 4 + 4 + 4 + 8 + 8 + 8 + 1 + 8;
        pub const BODY: usize = 2 + 2 + 1 + 1 + 32 + 3 + 4 + 4 + 1 + 1 + 4 + 4 + 9 + 1 + 32 + 5 + 8;
        pub const SIZE: usize =
            HEADER + BODY + 1 + super::MAX_GRANTS * GRANT + 1 + super::MAX_JOBS * OCC;
        pub const VERSION: u16 = 1;
    }

    /// CapacityJob: `cj ‖ pool ‖ grant seq ‖ job seq`.
    pub mod job {
        pub const MAGIC: &[u8; 8] = b"PSF1CJOB";
        pub const ACCOUNT_KIND: u8 = 26;
        pub const SEED: &[u8; 2] = b"cj";
        pub const HEADER: usize = 16;
        pub const DEPOSIT: usize = 8 + 1 + 8 + 8;
        pub const BODY: usize =
            4 + 4 + 8 + 32 + 1 + 4 + 8 + 8 + 8 + 16 + 9 + 8 + 1 + 8 + 1 + 16 + 16 + 8;
        pub const SIZE: usize = HEADER + BODY + 1 + super::MAX_DEPOSITS * DEPOSIT;
        pub const VERSION: u16 = 1;
    }

    fn header(d: &mut [u8], magic: &[u8; 8], version: u16, kind: u8) {
        d[..8].copy_from_slice(magic);
        d[8..10].copy_from_slice(&version.to_le_bytes());
        d[10] = kind;
        d[11..16].fill(0);
    }

    fn check_header(d: &[u8], magic: &[u8; 8], version: u16, kind: u8) -> Option<()> {
        (d.get(..8)? == magic && d.get(8..10)? == version.to_le_bytes() && *d.get(10)? == kind)
            .then_some(())
    }

    fn fin_code(f: Fin) -> (u8, i64) {
        match f {
            Fin::Open => (0, 0),
            Fin::Completed(t) => (1, t),
            Fin::Cancelled(t) => (2, t),
            Fin::Lost(t) => (3, t),
        }
    }

    impl Pool {
        pub fn encode(&self, d: &mut [u8]) -> Option<()> {
            if d.len() < pool::SIZE || self.grants.len() > MAX_GRANTS || self.occ.len() > MAX_JOBS {
                return None;
            }
            d[..pool::SIZE].fill(0);
            header(d, pool::MAGIC, pool::VERSION, pool::ACCOUNT_KIND);
            let mut off = pool::HEADER;
            let o = &mut off;
            let f = self.facility;
            put(d, o, &f.p.to_le_bytes());
            put(d, o, &f.q.to_le_bytes());
            put(d, o, &[f.site, f.gen]);
            put(d, o, &self.owner);
            put(d, o, &self.policies.encode());
            put(d, o, &self.lent.to_le_bytes());
            put(d, o, &self.owner_seq.to_le_bytes());
            let op = self.last_owner_op;
            put(
                d,
                o,
                &[op.is_some() as u8, op.is_some_and(|x| x.lend) as u8],
            );
            put(d, o, &op.map_or(0, |x| x.units).to_le_bytes());
            put(d, o, &op.map_or(0, |x| x.seq).to_le_bytes());
            put_opt_i64(d, o, self.lost_at);
            put(d, o, &[self.captor.is_some() as u8]);
            put(d, o, &self.captor.unwrap_or([0; 32]));
            put_opt_u32(d, o, self.last_grant_seq);
            put(d, o, &self.next_uid.to_le_bytes());
            put(d, o, &[self.grants.len() as u8]);
            for i in 0..MAX_GRANTS {
                let start = *o;
                if let Some(g) = self.grants.get(i) {
                    put(d, o, &g.seq.to_le_bytes());
                    put(d, o, &g.user);
                    put(d, o, &[g.recipe]);
                    put(d, o, &g.max_units.to_le_bytes());
                    put(d, o, &g.max_output.to_le_bytes());
                    put(d, o, &g.from.to_le_bytes());
                    put(d, o, &g.until.to_le_bytes());
                    put_opt_i64(d, o, g.revoked_at);
                    put(d, o, &g.spent.to_le_bytes());
                    put_opt_u32(d, o, g.last_job_seq);
                }
                *o = start + pool::GRANT;
            }
            put(d, o, &[self.occ.len() as u8]);
            for i in 0..MAX_JOBS {
                let start = *o;
                if let Some(r) = self.occ.get(i) {
                    put(d, o, &r.grant.to_le_bytes());
                    put(d, o, &r.job.to_le_bytes());
                    put(d, o, &r.units.to_le_bytes());
                    put(d, o, &r.start.to_le_bytes());
                    put(d, o, &r.end.to_le_bytes());
                    put(d, o, &r.end_eff.to_le_bytes());
                    put(d, o, &[r.open as u8]);
                    put(d, o, &r.budget.to_le_bytes());
                }
                *o = start + pool::OCC;
            }
            debug_assert_eq!(*o, pool::SIZE);
            Some(())
        }

        pub fn decode(d: &[u8]) -> Option<Pool> {
            if d.len() < pool::SIZE {
                return None;
            }
            check_header(d, pool::MAGIC, pool::VERSION, pool::ACCOUNT_KIND)?;
            let mut off = pool::HEADER;
            let o = &mut off;
            let p = i16::from_le_bytes(take(d, o, 2)?.try_into().ok()?);
            let q = i16::from_le_bytes(take(d, o, 2)?.try_into().ok()?);
            let site = u8_(d, o)?;
            let gen = u8_(d, o)?;
            let owner = key(d, o)?;
            let policies = Policies::decode(take(d, o, 3)?.try_into().ok()?)?;
            let lent = u32_(d, o)?;
            let owner_seq = u32_(d, o)?;
            let has = u8_(d, o)?;
            let lend = flag(d, o)?;
            let units = u32_(d, o)?;
            let seq = u32_(d, o)?;
            let last_owner_op = match has {
                0 => None,
                1 => Some(OwnerOp { lend, units, seq }),
                _ => return None,
            };
            let lost_at = opt_i64(d, o)?;
            let has_captor = u8_(d, o)?;
            let c = key(d, o)?;
            let captor = match has_captor {
                0 => None,
                1 => Some(c),
                _ => return None,
            };
            let last_grant_seq = opt_u32(d, o)?;
            let next_uid = u64_(d, o)?;
            let ng = u8_(d, o)? as usize;
            if ng > MAX_GRANTS {
                return None;
            }
            let mut grants = Vec::with_capacity(ng);
            for i in 0..MAX_GRANTS {
                let start = *o;
                if i < ng {
                    grants.push(Grant {
                        seq: u32_(d, o)?,
                        user: key(d, o)?,
                        recipe: {
                            let r = u8_(d, o)?;
                            recipe(r)?;
                            r
                        },
                        max_units: u32_(d, o)?,
                        max_output: i64_(d, o)?,
                        from: i64_(d, o)?,
                        until: i64_(d, o)?,
                        revoked_at: opt_i64(d, o)?,
                        spent: i64_(d, o)?,
                        last_job_seq: opt_u32(d, o)?,
                    });
                }
                *o = start + pool::GRANT;
            }
            let nj = u8_(d, o)? as usize;
            if nj > MAX_JOBS {
                return None;
            }
            let mut occ = Vec::with_capacity(nj);
            for i in 0..MAX_JOBS {
                let start = *o;
                if i < nj {
                    occ.push(Occ {
                        grant: u32_(d, o)?,
                        job: u32_(d, o)?,
                        units: u32_(d, o)?,
                        start: i64_(d, o)?,
                        end: i64_(d, o)?,
                        end_eff: i64_(d, o)?,
                        open: flag(d, o)?,
                        budget: i64_(d, o)?,
                    });
                }
                *o = start + pool::OCC;
            }
            Some(Pool {
                facility: FacilityId { p, q, site, gen },
                owner,
                policies,
                lent,
                owner_seq,
                last_owner_op,
                grants,
                occ,
                lost_at,
                captor,
                last_grant_seq,
                next_uid,
            })
        }
    }

    impl Job {
        pub fn encode(&self, d: &mut [u8]) -> Option<()> {
            if d.len() < job::SIZE || self.deposits.len() > MAX_DEPOSITS {
                return None;
            }
            d[..job::SIZE].fill(0);
            header(d, job::MAGIC, job::VERSION, job::ACCOUNT_KIND);
            let mut off = job::HEADER;
            let o = &mut off;
            put(d, o, &self.grant.to_le_bytes());
            put(d, o, &self.seq.to_le_bytes());
            put(d, o, &self.uid.to_le_bytes());
            put(d, o, &self.user);
            put(d, o, &[self.recipe]);
            put(d, o, &self.units.to_le_bytes());
            put(d, o, &self.start.to_le_bytes());
            put(d, o, &self.end.to_le_bytes());
            put(d, o, &self.max_output.to_le_bytes());
            for x in self.hopper {
                put(d, o, &x.to_le_bytes());
            }
            let (fc, ft) = fin_code(self.fin);
            put(d, o, &[fc]);
            put(d, o, &ft.to_le_bytes());
            put(d, o, &self.settled.to_le_bytes());
            put(d, o, &[self.started_logged as u8]);
            put(d, o, &self.claimed.to_le_bytes());
            put(d, o, &[self.refunded as u8]);
            for x in self.returned {
                put(d, o, &x.to_le_bytes());
            }
            for x in self.forfeited_in {
                put(d, o, &x.to_le_bytes());
            }
            put(d, o, &self.forfeited_out.to_le_bytes());
            put(d, o, &[self.deposits.len() as u8]);
            for x in &self.deposits {
                put(d, o, &x.id.to_le_bytes());
                put(d, o, &[x.input]);
                put(d, o, &x.amount.to_le_bytes());
                put(d, o, &x.src.to_le_bytes());
            }
            Some(())
        }

        pub fn decode(d: &[u8]) -> Option<Job> {
            if d.len() < job::SIZE {
                return None;
            }
            check_header(d, job::MAGIC, job::VERSION, job::ACCOUNT_KIND)?;
            let mut off = job::HEADER;
            let o = &mut off;
            let grant = u32_(d, o)?;
            let seq = u32_(d, o)?;
            let uid = u64_(d, o)?;
            let user = key(d, o)?;
            let recipe_id = u8_(d, o)?;
            recipe(recipe_id)?;
            let units = u32_(d, o)?;
            let start = i64_(d, o)?;
            let end = i64_(d, o)?;
            let max_output = i64_(d, o)?;
            let hopper = [i64_(d, o)?, i64_(d, o)?];
            let fc = u8_(d, o)?;
            let ft = i64_(d, o)?;
            let fin = match fc {
                0 => Fin::Open,
                1 => Fin::Completed(ft),
                2 => Fin::Cancelled(ft),
                3 => Fin::Lost(ft),
                _ => return None,
            };
            let settled = i64_(d, o)?;
            let started_logged = flag(d, o)?;
            let claimed = i64_(d, o)?;
            let refunded = flag(d, o)?;
            let returned = [i64_(d, o)?, i64_(d, o)?];
            let forfeited_in = [i64_(d, o)?, i64_(d, o)?];
            let forfeited_out = i64_(d, o)?;
            let n = u8_(d, o)? as usize;
            if n > MAX_DEPOSITS {
                return None;
            }
            let mut deposits = Vec::with_capacity(n);
            for _ in 0..n {
                deposits.push(Deposit {
                    id: u64_(d, o)?,
                    input: {
                        let i = u8_(d, o)?;
                        (i < 2).then_some(i)?
                    },
                    amount: i64_(d, o)?,
                    src: u64_(d, o)?,
                });
            }
            Some(Job {
                grant,
                seq,
                uid,
                user,
                recipe: recipe_id,
                units,
                start,
                end,
                max_output,
                hopper,
                deposits,
                fin,
                settled,
                started_logged,
                claimed,
                refunded,
                returned,
                forfeited_in,
                forfeited_out,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Key = [0xA1; 32];
    const B: Key = [0xB2; 32];

    fn fac() -> Facility {
        Facility {
            gen: 1,
            owner: A,
            reused: false,
            end: None,
        }
    }

    fn id() -> FacilityId {
        FacilityId {
            p: 0,
            q: 0,
            site: 0,
            gen: 1,
        }
    }

    #[test]
    fn layouts_round_trip_full_tables() {
        let (p, _) = open_pool(None, &fac(), &A, id(), Policies::PROVISIONAL).unwrap();
        let mut p = p.unwrap();
        p.lent = 3;
        p.last_owner_op = Some(OwnerOp {
            lend: true,
            units: 3,
            seq: 0,
        });
        p.lost_at = Some(77);
        p.captor = Some(B);
        for s in 0..MAX_GRANTS as u32 {
            p.grants.push(Grant {
                seq: s,
                user: B,
                recipe: RECIPE_ARMS,
                max_units: 2,
                max_output: 9,
                from: 1,
                until: 2,
                revoked_at: (s % 2 == 0).then_some(5),
                spent: -1,
                last_job_seq: Some(s),
            });
        }
        for s in 0..MAX_JOBS as u32 {
            p.occ.push(Occ {
                grant: s,
                job: s + 1,
                units: 1,
                start: -5,
                end: 6,
                end_eff: 4,
                open: s % 3 == 0,
                budget: i64::MAX,
            });
        }
        let mut d = alloc::vec![0u8; layout::pool::SIZE];
        p.encode(&mut d).unwrap();
        assert_eq!(Pool::decode(&d), Some(p));
        let j = Job {
            grant: 1,
            seq: 2,
            uid: 3,
            user: B,
            recipe: RECIPE_ARMS,
            units: 2,
            start: 10,
            end: 20,
            max_output: 30,
            hopper: [4, 5],
            deposits: (0..MAX_DEPOSITS as u64)
                .map(|i| Deposit {
                    id: i,
                    input: (i % 2) as u8,
                    amount: 7,
                    src: u64::MAX - i,
                })
                .collect(),
            fin: Fin::Lost(15),
            settled: 6,
            started_logged: true,
            claimed: 6,
            refunded: true,
            returned: [1, 2],
            forfeited_in: [3, 4],
            forfeited_out: 5,
        };
        let mut d = alloc::vec![0u8; layout::job::SIZE];
        j.encode(&mut d).unwrap();
        assert_eq!(Job::decode(&d), Some(j));
        // A wrong magic is not a pool.
        d[0] ^= 1;
        assert_eq!(Job::decode(&d), None);
        d[0] ^= 1;
        assert!(Job::decode(&d).is_some());
        // A flag byte that is neither 0 nor 1, a deposit's input past the
        // recipe's two: not a record of ours.
        let hdr = layout::job::HEADER;
        let started = hdr + 4 + 4 + 8 + 32 + 1 + 4 + 8 + 8 + 8 + 16 + 9 + 8;
        let mut bad = d.clone();
        bad[started] = 2;
        assert_eq!(Job::decode(&bad), None);
        let input0 = hdr + layout::job::BODY + 1 + 8;
        let mut bad = d.clone();
        bad[input0] = 2;
        assert_eq!(Job::decode(&bad), None);
        let mut pd = alloc::vec![0u8; layout::pool::SIZE];
        let pool = Pool::decode(&{
            let (p, _) = open_pool(None, &fac(), &A, id(), Policies::PROVISIONAL).unwrap();
            let mut p = p.unwrap();
            p.grants.push(Grant {
                seq: 1,
                user: B,
                recipe: RECIPE_ARMS,
                max_units: 1,
                max_output: 1,
                from: 0,
                until: 1,
                revoked_at: None,
                spent: 0,
                last_job_seq: None,
            });
            p.encode(&mut pd).unwrap();
            pd.clone()
        });
        assert!(pool.is_some());
        // The grant's recipe byte: an unknown recipe is refused.
        let recipe_at = layout::pool::HEADER + layout::pool::BODY + 1 + 4 + 32;
        let mut bad = pd.clone();
        bad[recipe_at] = 9;
        assert_eq!(Pool::decode(&bad), None);
        // The last owner op's lend flag.
        let lend_at = layout::pool::HEADER + 2 + 2 + 1 + 1 + 32 + 3 + 4 + 4 + 1;
        let mut bad = pd.clone();
        bad[lend_at] = 7;
        assert_eq!(Pool::decode(&bad), None);
    }

    #[test]
    fn sizes() {
        assert_eq!(layout::pool::GRANT, 87);
        assert_eq!(layout::pool::OCC, 45);
        assert_eq!(layout::job::DEPOSIT, 25);
        assert_eq!((layout::pool::SIZE, layout::job::SIZE), (1_548, 377));
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    const A: Key = [0xA1; 32];
    const B: Key = [0xB2; 32];
    const T0: i64 = 1_800_000_000;

    fn fac() -> Facility {
        Facility {
            gen: 1,
            owner: A,
            reused: false,
            end: None,
        }
    }

    /// A pool with one copy lent and B's grant of one unit, one job
    /// holding that unit over [T0+60, T0+3660).
    fn pool_with_a_job() -> Pool {
        let id = FacilityId {
            p: 0,
            q: 0,
            site: 0,
            gen: 1,
        };
        let (p, _) = open_pool(None, &fac(), &A, id, Policies::PROVISIONAL).unwrap();
        let mut p = p.unwrap();
        p.lent = 1;
        grant(
            &mut p,
            &fac(),
            T0,
            &A,
            Grant {
                seq: 1,
                user: B,
                recipe: RECIPE_ARMS,
                max_units: 1,
                max_output: 100 * MILLI,
                from: T0,
                until: T0 + 86_400,
                revoked_at: None,
                spent: 0,
                last_job_seq: None,
            },
        )
        .unwrap();
        reserve(
            &mut p,
            &fac(),
            false,
            None,
            T0,
            &B,
            1,
            1,
            1,
            T0 + 60,
            T0 + 3_660,
            MILLI,
        )
        .unwrap();
        p
    }

    /// `units` comes from the instruction: near `u32::MAX` it must be
    /// refused, not wrap past the grant's and the pool's caps.
    #[test]
    fn huge_units_are_refused_not_wrapped() {
        let mut p = pool_with_a_job();
        let before = p.clone();
        for units in [u32::MAX, u32::MAX - 1] {
            let r = reserve(
                &mut p,
                &fac(),
                false,
                None,
                T0,
                &B,
                1,
                2,
                units,
                T0 + 60,
                T0 + 3_660,
                MILLI,
            );
            assert_eq!(r.map(|_| ()), Err(CapError::GrantUnitsExceeded), "{units}");
        }
        assert_eq!(p, before);
        // A second grant with no job and no unit cap of its own: the grant's
        // sum fits, the pool's (the first grant's job plus these) does not.
        grant(
            &mut p,
            &fac(),
            T0,
            &A,
            Grant {
                seq: 2,
                user: B,
                recipe: RECIPE_ARMS,
                max_units: u32::MAX,
                max_output: 100 * MILLI,
                from: T0,
                until: T0 + 86_400,
                revoked_at: None,
                spent: 0,
                last_job_seq: None,
            },
        )
        .unwrap();
        let before = p.clone();
        let r = reserve(
            &mut p,
            &fac(),
            false,
            None,
            T0,
            &B,
            2,
            1,
            u32::MAX,
            T0 + 60,
            T0 + 3_660,
            MILLI,
        );
        assert_eq!(r.map(|_| ()), Err(CapError::CapacityExceeded));
        assert_eq!(p, before);
    }

    /// `max_output` comes from the instruction too: near `i64::MAX` it must
    /// not wrap past the grant's output budget.
    #[test]
    fn huge_max_output_is_refused_not_wrapped() {
        let mut p = pool_with_a_job();
        p.lent = 2;
        p.grants[0].max_units = 2;
        let r = reserve(
            &mut p,
            &fac(),
            false,
            None,
            T0,
            &B,
            1,
            2,
            1,
            T0 + 60,
            T0 + 3_660,
            i64::MAX,
        );
        assert_eq!(r.map(|_| ()), Err(CapError::GrantOutputExceeded));
    }
}
