//! The program's rules (`permutation_rules::frontier::capacity`, feature
//! `capacity-preview`) against this kernel: the same operations from the
//! same start, and after every one the same outcome (applied, applied
//! before, or the same refusal), the same events, the same pool and jobs,
//! and the same Holding.
//!
//! The rules keep the pool's grants and an occupancy table in one account
//! and each job in its own; the kernel keeps whole jobs in the pool. The
//! caller's part of the program (which job accounts an operation reads,
//! what "no account" means) is `Port` below, as the program's handlers do
//! it. Goods are not compared: the rules move none (their events say what
//! the program moves); the kernel's custody here is funded so that no move
//! fails.
//!
//! Needs `core-patch-0001` (the Holding lends its own copies, as the
//! rules' `Holding::lend_workshops` does).
#![cfg(feature = "core-patch-0001")]

use std::collections::BTreeMap;

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::capacity as cap;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::event::Event;
use wylls_capacity::facility::Facility;
use wylls_capacity::ledger::{Fin, Harness, Job, Op, Outcome, Pool};
use wylls_capacity::model::{Actor, FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::{DormancyPolicy, LossPolicy, Policies, RevokePolicy};
use wylls_capacity::testkit::{self, A, B, C, SITE_A, T0, X};
use wylls_capacity::CapError;

type Kernel = Harness<wylls_capacity::custody::MockCustody>;

fn policies(p: Policies) -> cap::Policies {
    cap::Policies {
        loss: match p.loss {
            LossPolicy::CaptorTakesAll => cap::LossPolicy::CaptorTakesAll,
            LossPolicy::UserKeepsAll => cap::LossPolicy::UserKeepsAll,
            LossPolicy::UserKeepsOutput => cap::LossPolicy::UserKeepsOutput,
        },
        dormancy: match p.dormancy {
            DormancyPolicy::Unaffected => cap::DormancyPolicy::Unaffected,
            DormancyPolicy::RefuseNewWhenDormant => cap::DormancyPolicy::RefuseNewWhenDormant,
        },
        revoke: match p.revoke {
            RevokePolicy::HonorBooked => cap::RevokePolicy::HonorBooked,
            RevokePolicy::CancelBooked => cap::RevokePolicy::CancelBooked,
        },
    }
}

fn fid(f: FacilityId) -> cap::FacilityId {
    cap::FacilityId {
        p: f.at.p,
        q: f.at.q,
        site: f.at.site,
        gen: f.gen,
    }
}

/// The source tag the program would give a place.
fn src(p: Place) -> u64 {
    match p {
        Place::Caravan(x) => x,
        Place::Vault(x) => x ^ 1 << 62,
        Place::Holding(_) => 1 << 61,
        Place::Hopper(_) | Place::Output(_) => 1 << 60,
    }
}

/// The program's side: the pool account, the job accounts and the
/// facility's Holding (with the loss records the core keeps).
#[derive(Clone)]
struct Port {
    pool: Option<cap::Pool>,
    jobs: BTreeMap<(u32, u32), cap::Job>,
    fac: Facility,
}

impl Port {
    fn view(&self, gen: u8) -> cap::Facility {
        cap::Facility {
            gen: self.fac.gen,
            owner: self.fac.owner.0,
            reused: self.fac.ended.iter().any(|(g, _, _)| *g == self.fac.gen),
            end: self.fac.end_of(gen).map(|(t, c)| (t, c.map(|c| c.0))),
        }
    }

    /// Run `op` as the program's handler would; on a refusal nothing
    /// changes (a failed transaction).
    fn apply(&mut self, now: i64, signer: Actor, op: &Op) -> cap::R<cap::Done> {
        let saved = self.clone();
        let r = self.run(now, signer, op);
        if r.is_err() || r == Ok(cap::Done::Already) {
            *self = saved;
        }
        r
    }

    fn run(&mut self, now: i64, signer: Actor, op: &Op) -> cap::R<cap::Done> {
        let s = signer.0;
        if let Op::OpenPool {
            facility,
            policies: pol,
        } = *op
        {
            let f = self.view(facility.gen);
            let (new, done) =
                cap::open_pool(self.pool.as_ref(), &f, &s, fid(facility), policies(pol))?;
            if let Some(p) = new {
                self.pool = Some(p);
            }
            return Ok(done);
        }
        let Some(mut p) = self.pool.clone() else {
            return Err(cap::CapError::UnknownPool);
        };
        let f = self.view(p.facility.gen);
        let job_key = |j: JobId| (j.grant.seq, j.seq);
        let r = match *op {
            Op::OpenPool { .. } => unreachable!(),
            Op::Lend { units, seq, .. } => {
                cap::lend(&mut p, &mut self.fac.holding, &f, now, &s, true, units, seq)
            }
            Op::Reclaim { units, seq, .. } => cap::lend(
                &mut p,
                &mut self.fac.holding,
                &f,
                now,
                &s,
                false,
                units,
                seq,
            ),
            Op::Grant {
                grant,
                user,
                recipe,
                max_units,
                max_output,
                from,
                until,
            } => cap::grant(
                &mut p,
                &f,
                now,
                &s,
                cap::Grant {
                    seq: grant.seq,
                    user: user.0,
                    recipe: recipe.0,
                    max_units,
                    max_output,
                    from,
                    until,
                    revoked_at: None,
                    spent: 0,
                    last_job_seq: None,
                },
            ),
            Op::Revoke { grant } => {
                // The accounts the handler takes: the grant's booked jobs.
                let keys: Vec<(u32, u32)> = if p.policies.revoke == cap::RevokePolicy::CancelBooked
                {
                    p.occ
                        .iter()
                        .filter(|o| o.grant == grant.seq && o.open && now < o.start)
                        .map(|o| (o.grant, o.job))
                        .collect()
                } else {
                    Vec::new()
                };
                let mut taken: Vec<cap::Job> = keys.iter().map(|k| self.jobs[k].clone()).collect();
                let mut refs: Vec<&mut cap::Job> = taken.iter_mut().collect();
                let r = cap::revoke(&mut p, &f, now, &s, grant.seq, &mut refs);
                for j in taken {
                    self.jobs.insert((j.grant, j.seq), j);
                }
                r
            }
            Op::Reserve {
                job,
                units,
                start,
                end,
                max_output,
            } => {
                let k = job_key(job);
                let dormant = self.fac.holding.is_dormant(now);
                let (new, done) = cap::reserve(
                    &mut p,
                    &f,
                    dormant,
                    self.jobs.get(&k),
                    now,
                    &s,
                    k.0,
                    k.1,
                    units,
                    start,
                    end,
                    max_output,
                )?;
                if let Some(j) = new {
                    self.jobs.insert(k, j);
                }
                Ok(done)
            }
            Op::Deposit {
                job,
                deposit,
                resource,
                amount,
                from,
            } => {
                let k = job_key(job);
                cap::deposit(
                    &mut p,
                    &f,
                    self.jobs.get_mut(&k),
                    k,
                    now,
                    &s,
                    deposit,
                    resource,
                    amount,
                    src(from),
                )
            }
            Op::Settle { job } => {
                let k = job_key(job);
                cap::settle(&mut p, &f, self.jobs.get_mut(&k), k, now)
            }
            Op::Cancel { job } => {
                let k = job_key(job);
                cap::cancel(&mut p, &f, self.jobs.get_mut(&k), k, now, &s)
            }
            Op::Claim { job, to } => {
                let k = job_key(job);
                cap::claim(
                    &mut p,
                    &f,
                    self.jobs.get_mut(&k),
                    k,
                    now,
                    &s,
                    false,
                    to.kernel_only(),
                )
            }
            Op::ClaimSplit {
                job,
                output_to,
                refund_to,
                remainder_to,
            } => {
                let k = job_key(job);
                let bad = [output_to, refund_to[0], refund_to[1], remainder_to]
                    .iter()
                    .any(|t| t.kernel_only());
                cap::claim(&mut p, &f, self.jobs.get_mut(&k), k, now, &s, true, bad)
            }
            Op::FacilityLost { .. } => {
                let keys: Vec<(u32, u32)> = p.occ.iter().map(|o| (o.grant, o.job)).collect();
                let mut taken: Vec<cap::Job> = keys.iter().map(|k| self.jobs[k].clone()).collect();
                let mut refs: Vec<&mut cap::Job> = taken.iter_mut().collect();
                let r = cap::lose(&mut p, &f, &mut refs);
                for j in taken {
                    self.jobs.insert((j.grant, j.seq), j);
                }
                r
            }
            Op::Retire { job } => {
                let k = job_key(job);
                let r = cap::retire(&mut p, self.jobs.get(&k), k);
                if let Ok(cap::Done::Applied(_)) = r {
                    // The handler closes the job's account.
                    self.jobs.remove(&k);
                }
                r
            }
            Op::RetireGrant { grant } => cap::retire_grant(&mut p, now, grant.seq),
            Op::RetirePool { .. } => {
                let r = cap::retire_pool(&p);
                if let Ok(cap::Done::Applied(_)) = r {
                    self.pool = None;
                    return r;
                }
                r
            }
        };
        if r.is_ok() {
            self.pool = Some(p);
        }
        r
    }
}

/// The kernel's events in the rules' terms (the pool implied, places the
/// program's to fill in).
fn events(ev: &[Event]) -> Vec<cap::Event> {
    let k = |j: JobId| (j.grant.seq, j.seq);
    ev.iter()
        .map(|e| match e.clone() {
            Event::PoolOpened { owner, .. } => cap::Event::PoolOpened { owner: owner.0 },
            Event::Lent {
                units, lent, at, ..
            } => cap::Event::Lent { units, lent, at },
            Event::Reclaimed {
                units, lent, at, ..
            } => cap::Event::Reclaimed { units, lent, at },
            Event::Granted { grant, user } => cap::Event::Granted {
                grant: grant.seq,
                user: user.0,
            },
            Event::Revoked {
                grant,
                at,
                cancelled,
            } => cap::Event::Revoked {
                grant: grant.seq,
                at,
                cancelled,
            },
            Event::Reserved {
                job,
                units,
                start,
                end,
                max_output,
            } => cap::Event::Reserved {
                job: k(job),
                units,
                start,
                end,
                max_output,
            },
            Event::Deposited {
                job,
                deposit,
                resource,
                amount,
            } => cap::Event::Deposited {
                job: k(job),
                deposit,
                resource,
                amount,
            },
            Event::Started { job, at } => cap::Event::Started { job: k(job), at },
            Event::Settled {
                job,
                out,
                used,
                total,
            } => cap::Event::Settled {
                job: k(job),
                out,
                used,
                total,
            },
            Event::Completed { job, at, out } => cap::Event::Completed {
                job: k(job),
                at,
                out,
            },
            Event::Cancelled { job, at, out } => cap::Event::Cancelled {
                job: k(job),
                at,
                out,
            },
            Event::Lost { job, at, out } => cap::Event::Lost {
                job: k(job),
                at,
                out,
            },
            Event::Claimed {
                job,
                output,
                refund,
                ..
            } => cap::Event::Claimed {
                job: k(job),
                output,
                refund,
            },
            Event::Refunded {
                job,
                whole,
                remainder,
                ..
            } => cap::Event::Refunded {
                job: k(job),
                whole,
                remainder,
            },
            Event::Forfeited {
                job,
                output,
                refund,
                owner,
                ..
            } => cap::Event::Forfeited {
                job: k(job),
                output,
                refund,
                owner: owner.0,
            },
            Event::FacilityLost { at, captor, .. } => cap::Event::FacilityLost {
                at,
                captor: captor.map(|c| c.0),
            },
            Event::Retired { job, uid, output } => cap::Event::Retired {
                job: k(job),
                uid,
                output,
            },
            Event::Receipt { job, uid, accounts } => cap::Event::Receipt {
                job: k(job),
                uid,
                accounts: cap::Accounts {
                    inputs: accounts.inputs.map(|a| cap::Account {
                        in_total: a.in_total,
                        held: a.held,
                        out_total: a.out_total,
                        consumed: a.consumed,
                        forfeited: a.forfeited,
                    }),
                    output: cap::Account {
                        in_total: accounts.output.in_total,
                        held: accounts.output.held,
                        out_total: accounts.output.out_total,
                        consumed: accounts.output.consumed,
                        forfeited: accounts.output.forfeited,
                    },
                },
            },
            Event::GrantRetired { grant } => cap::Event::GrantRetired { grant: grant.seq },
            Event::PoolRetired { .. } => cap::Event::PoolRetired,
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum Res {
    Applied(Vec<cap::Event>),
    Already,
    Refused(u16),
}

fn from_kernel(r: Result<Outcome, CapError>) -> Res {
    match r {
        Ok(Outcome::Applied(ev)) => Res::Applied(events(&ev)),
        Ok(Outcome::AlreadyApplied) => Res::Already,
        Err(e) => Res::Refused(e.code()),
    }
}

fn from_port(r: cap::R<cap::Done>) -> Res {
    match r {
        Ok(cap::Done::Applied(ev)) => Res::Applied(ev),
        Ok(cap::Done::Already) => Res::Already,
        Err(e) => Res::Refused(e.code()),
    }
}

fn fin(f: Fin) -> cap::Fin {
    match f {
        Fin::Open => cap::Fin::Open,
        Fin::Completed(t) => cap::Fin::Completed(t),
        Fin::Cancelled(t) => cap::Fin::Cancelled(t),
        Fin::Lost(t) => cap::Fin::Lost(t),
    }
}

fn job(j: &Job) -> cap::Job {
    cap::Job {
        grant: j.id.grant.seq,
        seq: j.id.seq,
        uid: j.uid,
        user: j.user.0,
        recipe: j.recipe.0,
        units: j.units,
        start: j.start,
        end: j.end,
        max_output: j.max_output,
        hopper: j.hopper,
        deposits: j
            .deposits
            .iter()
            .map(|d| cap::Deposit {
                id: d.0,
                input: d.1,
                amount: d.2,
                src: src(d.3),
            })
            .collect(),
        fin: fin(j.fin),
        settled: j.settled,
        started_logged: j.started_logged,
        claimed: j.claimed,
        refunded: j.refunded,
        returned: j.returned,
        forfeited_in: j.forfeited_in,
        forfeited_out: j.forfeited_out,
    }
}

/// The kernel's pool as the rules keep it (the jobs' rows from the jobs).
fn pool(p: &Pool, next_uid: u64) -> cap::Pool {
    cap::Pool {
        facility: fid(p.facility),
        owner: p.owner.0,
        policies: policies(p.policies),
        lent: p.lent,
        owner_seq: p.owner_seq,
        last_owner_op: p.last_owner_op.as_ref().map(|o| match *o {
            Op::Lend { units, seq, .. } => cap::OwnerOp {
                lend: true,
                units,
                seq,
            },
            Op::Reclaim { units, seq, .. } => cap::OwnerOp {
                lend: false,
                units,
                seq,
            },
            _ => unreachable!("only the owner's lend and reclaim"),
        }),
        grants: p
            .grants
            .iter()
            .map(|g| cap::Grant {
                seq: g.id.seq,
                user: g.user.0,
                recipe: g.recipe.0,
                max_units: g.max_units,
                max_output: g.max_output,
                from: g.from,
                until: g.until,
                revoked_at: g.revoked_at,
                spent: g.spent,
                last_job_seq: g.last_job_seq,
            })
            .collect(),
        occ: p
            .jobs
            .iter()
            .map(|j| {
                let r = job(j);
                cap::Occ {
                    grant: r.grant,
                    job: r.seq,
                    units: r.units,
                    start: r.start,
                    end: r.end,
                    end_eff: r.end_eff(),
                    open: r.fin == cap::Fin::Open,
                    budget: if r.fin == cap::Fin::Open {
                        r.max_output
                    } else {
                        r.settled
                    },
                }
            })
            .collect(),
        lost_at: p.lost_at,
        captor: p.captor.map(|c| c.0),
        last_grant_seq: p.last_grant_seq,
        next_uid,
    }
}

fn same(k: &Kernel, port: &Port, f: FacilityId, ctx: &str) {
    match (k.pool(f), &port.pool) {
        (None, None) => {}
        (Some(kp), Some(pp)) => {
            assert_eq!(&pool(kp, k.ledger.next_uid), pp, "{ctx}: pool");
            let kj: BTreeMap<(u32, u32), cap::Job> = kp
                .jobs
                .iter()
                .map(|j| ((j.id.grant.seq, j.id.seq), job(j)))
                .collect();
            assert_eq!(kj, port.jobs, "{ctx}: jobs");
            // The encoded accounts read back the same.
            let mut d = vec![0u8; cap::layout::pool::SIZE];
            pp.encode(&mut d).unwrap();
            assert_eq!(
                cap::Pool::decode(&d).as_ref(),
                Some(pp),
                "{ctx}: pool bytes"
            );
            for j in port.jobs.values() {
                let mut d = vec![0u8; cap::layout::job::SIZE];
                j.encode(&mut d).unwrap();
                assert_eq!(cap::Job::decode(&d).as_ref(), Some(j), "{ctx}: job bytes");
            }
        }
        (a, b) => panic!("{ctx}: pool {:?} vs {:?}", a.is_some(), b.is_some()),
    }
    assert_eq!(
        k.facilities[&SITE_A].holding, port.fac.holding,
        "{ctx}: holding"
    );
}

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n.max(1)
    }
}

fn fund(k: &mut Kernel, user: Actor, id: u64) {
    for (n, r) in [(0, Resource::Ore), (1, Resource::Wood)] {
        k.custody
            .import(
                Key {
                    scope: id,
                    kind: 100,
                    n,
                },
                Place::Caravan(id),
                user,
                r,
                1_000_000 * MILLI,
            )
            .unwrap();
    }
}

const ALL_POLICIES: [Policies; 4] = [
    Policies::PROVISIONAL,
    Policies {
        loss: LossPolicy::UserKeepsAll,
        dormancy: DormancyPolicy::RefuseNewWhenDormant,
        revoke: RevokePolicy::CancelBooked,
    },
    Policies {
        loss: LossPolicy::UserKeepsOutput,
        dormancy: DormancyPolicy::Unaffected,
        revoke: RevokePolicy::CancelBooked,
    },
    Policies {
        loss: LossPolicy::CaptorTakesAll,
        dormancy: DormancyPolicy::RefuseNewWhenDormant,
        revoke: RevokePolicy::HonorBooked,
    },
];

#[test]
fn the_rules_agree_with_the_kernel_step_by_step() {
    let seeds: u64 = std::env::var("PORT_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let mut kinds = [0u64; 16];
    let mut applied = [0u64; 16];
    let mut refused = BTreeMap::<u16, u64>::new();
    for seed in 1..=seeds {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let pol = ALL_POLICIES[(seed % 4) as usize];
        let mut k: Kernel = Harness::new(Default::default());
        k.add_facility(testkit::facility(3 + rng.below(3) as u32));
        let f = k.facilities[&SITE_A].id();
        let mut port = Port {
            pool: None,
            jobs: BTreeMap::new(),
            fac: k.facilities[&SITE_A].clone(),
        };
        fund(&mut k, B, 77);
        fund(&mut k, C, 78);
        let mut now = T0;
        let mut owner_seq = 0u32;
        let mut next_grant = 1u32;
        let mut jobs: Vec<JobId> = Vec::new();
        let mut captured = false;
        let user_of = |g: u32| if g % 2 == 1 { B } else { C };
        for step in 0..120 {
            now += rng.below(1_800) as i64;
            let kind = match rng.below(16) as usize {
                _ if step == 0 => 0,
                // A loss or the pool's end is rarer, so runs reach the middle.
                12 | 15 if rng.below(5) != 0 => 7 + rng.below(3) as usize,
                0 if rng.below(3) != 0 => 5,
                k => k,
            };
            kinds[kind] += 1;
            let g = 1 + rng.below(next_grant as u64) as u32;
            let gid = GrantId {
                facility: f,
                seq: g,
            };
            let pick = |rng: &mut Rng, jobs: &Vec<JobId>| {
                if jobs.is_empty() || rng.below(10) == 0 {
                    JobId {
                        grant: gid,
                        seq: 1 + rng.below(4) as u32,
                    }
                } else {
                    jobs[rng.below(jobs.len() as u64) as usize]
                }
            };
            let (signer, op) = match kind {
                0 => (
                    if rng.below(8) == 0 { B } else { A },
                    Op::OpenPool {
                        facility: f,
                        policies: if rng.below(10) == 0 {
                            ALL_POLICIES[((seed + 1) % 4) as usize]
                        } else {
                            pol
                        },
                    },
                ),
                1 | 2 => {
                    // Lend or reclaim, sometimes a replay or a stale seq.
                    let seq = match rng.below(6) {
                        0 => owner_seq.saturating_sub(1),
                        1 => owner_seq + 1,
                        _ => owner_seq,
                    };
                    let units = rng.below(4) as u32;
                    let op = if kind == 1 {
                        Op::Lend {
                            facility: f,
                            units,
                            seq,
                        }
                    } else {
                        Op::Reclaim {
                            facility: f,
                            units,
                            seq,
                        }
                    };
                    (if rng.below(12) == 0 { B } else { A }, op)
                }
                3 => {
                    let seq = if rng.below(4) == 0 { g } else { next_grant };
                    let from = now - 600 + rng.below(3_600) as i64;
                    (
                        if rng.below(12) == 0 { C } else { A },
                        Op::Grant {
                            grant: GrantId { facility: f, seq },
                            user: user_of(seq),
                            recipe: wylls_capacity::recipe::RecipeId(
                                1 + (rng.below(15) == 0) as u8,
                            ),
                            max_units: 1 + rng.below(3) as u32,
                            max_output: (5 + rng.below(60) as i64) * MILLI,
                            from,
                            until: from + (6 + rng.below(40) as i64) * HOUR,
                        },
                    )
                }
                4 => (A, Op::Revoke { grant: gid }),
                5 | 6 => {
                    let seq = 1 + rng.below(5) as u32;
                    let start = now + 60 + rng.below(4 * HOUR as u64) as i64;
                    (
                        user_of(g),
                        Op::Reserve {
                            job: JobId { grant: gid, seq },
                            units: 1 + rng.below(2) as u32,
                            start,
                            end: start + (1 + rng.below(4) as i64) * HOUR,
                            max_output: (1 + rng.below(16) as i64) * MILLI,
                        },
                    )
                }
                7 | 8 => {
                    let j = pick(&mut rng, &jobs);
                    let user = user_of(j.grant.seq);
                    (
                        if rng.below(15) == 0 { A } else { user },
                        Op::Deposit {
                            job: j,
                            deposit: 1 + rng.below(4),
                            resource: [Resource::Ore, Resource::Wood, Resource::Food]
                                [rng.below(3) as usize],
                            amount: (rng.below(30) as i64) * MILLI / 2,
                            from: Place::Caravan(if user == B { 77 } else { 78 }),
                        },
                    )
                }
                9 => (
                    X,
                    Op::Settle {
                        job: pick(&mut rng, &jobs),
                    },
                ),
                10 => {
                    let j = pick(&mut rng, &jobs);
                    (user_of(j.grant.seq), Op::Cancel { job: j })
                }
                11 => {
                    // The user's own places (a place holds one owner's goods).
                    let j = pick(&mut rng, &jobs);
                    let base = if user_of(j.grant.seq) == B { 90 } else { 190 };
                    let to = match rng.below(12) {
                        0 => Place::Hopper(j),
                        _ => Place::Caravan(base),
                    };
                    let op = if rng.below(2) == 0 {
                        Op::Claim { job: j, to }
                    } else {
                        Op::ClaimSplit {
                            job: j,
                            output_to: to,
                            refund_to: [Place::Caravan(base + 1), Place::Caravan(base + 2)],
                            remainder_to: Place::Caravan(base + 3),
                        }
                    };
                    (user_of(j.grant.seq), op)
                }
                12 => {
                    // The facility is captured (the core's), or the loss is
                    // recorded.
                    if !captured && rng.below(3) == 0 {
                        k.facilities
                            .get_mut(&SITE_A)
                            .unwrap()
                            .capture(now, X)
                            .unwrap();
                        // The program's Holding knows what it lent.
                        port.fac.lent = port.fac.holding.lent_workshops;
                        port.fac.capture(now, X).unwrap();
                        captured = true;
                        continue;
                    }
                    (X, Op::FacilityLost { facility: f })
                }
                13 => (
                    X,
                    Op::Retire {
                        job: pick(&mut rng, &jobs),
                    },
                ),
                14 => (X, Op::RetireGrant { grant: gid }),
                _ => (X, Op::RetirePool { facility: f }),
            };
            let ctx = format!("seed {seed} step {step} {op:?}");
            let rk = from_kernel(k.apply(now, signer, &op));
            let rp = from_port(port.apply(now, signer, &op));
            assert_eq!(rk, rp, "{ctx}: outcome");
            match &rk {
                Res::Applied(_) => {
                    applied[kind] += 1;
                    match op {
                        Op::Lend { .. } | Op::Reclaim { .. } => owner_seq += 1,
                        Op::Grant { grant, .. } if grant.seq == next_grant => next_grant += 1,
                        Op::Reserve { job, .. } => jobs.push(job),
                        _ => {}
                    }
                }
                Res::Refused(c) => *refused.entry(*c).or_default() += 1,
                Res::Already => {}
            }
            same(&k, &port, f, &ctx);
        }
    }
    println!(
        "rules port: ops by kind {kinds:?}; applied {applied:?}; refusals by code {refused:?}"
    );
    // Every kind of operation applied, and most refusals seen.
    assert!(applied.iter().all(|n| *n > 0), "{applied:?}");
    assert!(refused.len() >= 20, "{refused:?}");
}
