//! Two users and the owner on one facility, in random interleavings with
//! retries, restarts and a capture (contract §1 no-double-use, §2 retries).
//!
//! Every step checks: custody conservation (C1, C2); the capacity held at
//! every instant within the lent copies; the facility Holding's lent count
//! equal to the pool's; each job's credited output its closed form at the
//! last settle and within its limit; claims within the credit; custody's
//! hopper and output balances equal to the job's own accounts; produced
//! and consumed totals equal to the jobs' (C3). A world saved and restored
//! at any step continues identically; a replayed operation never changes
//! a total.

use borsh::BorshDeserialize;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, MockCustody};
use wylls_capacity::ledger::{Fin, Harness, Op};
use wylls_capacity::model::{Actor, FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::recipe::ARMS_RECIPE;
use wylls_capacity::testkit::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn check(w: &Harness<MockCustody>, f: FacilityId, now: i64) {
    w.custody.check().unwrap();
    let p = w.pool(f).unwrap();
    if p.lost_at.is_none() {
        assert_eq!(w.facilities[&f.at].lent, p.lent, "holding and pool agree");
        assert!(p.lent <= w.facilities[&f.at].workshops());
        // Capacity at every instant (every interval end is a candidate).
        let ivs: Vec<(i64, i64, u32)> = p
            .jobs
            .iter()
            .map(|j| {
                let (s, e) = j.occupies(now);
                (s, e, j.units)
            })
            .collect();
        for &(t, _, _) in ivs.iter().filter(|(_, e, _)| *e > now) {
            let t = t.max(now);
            let held: u32 = ivs
                .iter()
                .filter(|(s, e, _)| *s <= t && t < *e)
                .map(|x| x.2)
                .sum();
            assert!(held <= p.lent, "held {held} > lent {} at {t}", p.lent);
        }
    }
    // Retired jobs' output is kept in their grants' `spent`.
    let spent: i64 = p.grants.iter().map(|g| g.spent).sum();
    let (mut made, mut used_ore) = (spent, ARMS_RECIPE.used_for(spent)[0]);
    for j in &p.jobs {
        assert!(j.settled <= j.limit());
        assert!(j.claimed <= j.settled, "no double receipt");
        made += j.settled;
        used_ore += ARMS_RECIPE.used_for(j.settled)[0];
        let (_, out) = w.custody.balance(Place::Output(j.id), ARMS);
        let forfeited = p.lost_at.is_some();
        // The job's accounts (workstream 10's law) match custody.
        let a = j.accounts();
        assert!(a.balanced(), "accounts of {:?}: {a:?}", j.id);
        if !forfeited {
            assert_eq!(a.output.held, out);
            assert_eq!(
                a.inputs[0].held,
                w.custody.balance(Place::Hopper(j.id), Resource::Ore).1
            );
            assert_eq!(out, j.settled - j.claimed);
            let rest = if j.refunded { [0, 0] } else { j.rest() };
            assert_eq!(
                w.custody.balance(Place::Hopper(j.id), Resource::Ore).1,
                rest[0]
            );
            assert_eq!(
                w.custody.balance(Place::Hopper(j.id), Resource::Wood).1,
                rest[1]
            );
        }
    }
    assert_eq!(
        w.custody.produced[ARMS as usize], made,
        "C3: produced = credited"
    );
    assert_eq!(
        w.custody.consumed[Resource::Ore as usize],
        used_ore,
        "C3: consumed = recipe × produced"
    );
}

fn scenario(seed: u64, steps: usize, stats: &mut std::collections::BTreeMap<&'static str, u64>) {
    let mut rng = Rng(seed | 1);
    let loss = [
        LossPolicy::CaptorTakesAll,
        LossPolicy::UserKeepsAll,
        LossPolicy::UserKeepsOutput,
    ][seed as usize % 3];
    let (mut w, f) = world(
        4,
        3,
        2,
        Policies {
            loss,
            ..Policies::PROVISIONAL
        },
    );
    let mut now = T0 + 60;
    let mut done: Vec<(Actor, Op)> = Vec::new();
    let mut owner_seq = 1u32;
    let mut caravan = 1000u64;
    let mut captured = false;
    for step in 0..steps {
        now += rng.below(40 * 60) as i64;
        let users = [B, C];
        let ui = rng.below(2) as usize;
        let user = users[ui];
        let grant = GrantId {
            facility: f,
            seq: ui as u32 + 1,
        };
        // Mostly an existing job of this user (an unstarted one for a
        // deposit), sometimes any number (unknown jobs, other users' jobs).
        let mine: Vec<JobId> = w
            .pool(f)
            .map(|p| {
                p.jobs
                    .iter()
                    .filter(|j| j.user == user)
                    .map(|j| j.id)
                    .collect()
            })
            .unwrap_or_default();
        let fresh: Vec<JobId> = w
            .pool(f)
            .map(|p| {
                p.jobs
                    .iter()
                    .filter(|j| j.user == user && j.start > now)
                    .map(|j| j.id)
                    .collect()
            })
            .unwrap_or_default();
        let next_seq = mine.iter().map(|j| j.seq + 1).max().unwrap_or(0);
        let pick = |rng: &mut Rng, from: &[JobId]| -> JobId {
            if from.is_empty() || rng.below(5) == 0 {
                JobId {
                    grant,
                    seq: rng.below(next_seq as u64 + 2) as u32,
                }
            } else {
                from[rng.below(from.len() as u64) as usize]
            }
        };
        let kind = rng.below(11);
        let job = match kind {
            0 | 1 if rng.below(4) != 0 => JobId {
                grant,
                seq: next_seq,
            },
            2 | 3 => pick(&mut rng, &fresh),
            _ => pick(&mut rng, &mine),
        };
        let op = match kind {
            0 | 1 => {
                let start = now + rng.below(6 * HOUR as u64) as i64;
                let len = 600 + rng.below(4 * HOUR as u64) as i64;
                Some(Op::Reserve {
                    job,
                    units: 1 + rng.below(2) as u32,
                    start,
                    end: start + len,
                    max_output: (1 + rng.below(12) as i64) * MILLI,
                })
            }
            2 | 3 => {
                caravan += 1;
                let r = if rng.below(2) == 0 {
                    Resource::Ore
                } else {
                    Resource::Wood
                };
                let a = 1 + rng.below(20) as i64;
                arrived(
                    &mut w.custody,
                    user,
                    caravan,
                    if r == Resource::Ore { a } else { 0 },
                    if r == Resource::Wood { a } else { 0 },
                );
                Some(Op::Deposit {
                    job,
                    deposit: caravan,
                    resource: r,
                    amount: a * MILLI,
                    from: Place::Caravan(caravan),
                })
            }
            4 => Some(Op::Cancel { job }),
            5 if rng.below(3) == 0 => Some(Op::Retire { job }),
            5 | 6 => Some(Op::Settle { job }),
            7 => Some(Op::Claim {
                job,
                to: Place::Caravan(9_000 + ui as u64),
            }),
            8 => {
                let op = if rng.below(2) == 0 {
                    Op::Lend {
                        facility: f,
                        units: 1,
                        seq: owner_seq,
                    }
                } else {
                    Op::Reclaim {
                        facility: f,
                        units: 1,
                        seq: owner_seq,
                    }
                };
                if w.apply(now, A, &op).is_ok() {
                    *stats.entry("owner").or_default() += 1;
                    owner_seq += 1;
                    done.push((A, op));
                }
                None
            }
            9 => {
                // Retry an earlier operation.
                if !done.is_empty() {
                    let (who, op) = done[rng.below(done.len() as u64) as usize].clone();
                    let before = (w.custody.produced, w.custody.consumed, w.custody.imported);
                    let replay_safe = matches!(
                        op,
                        Op::Reserve { .. }
                            | Op::Deposit { .. }
                            | Op::Lend { .. }
                            | Op::Reclaim { .. }
                            | Op::Cancel { .. }
                    );
                    let _ = w.apply(now, who, &op);
                    if replay_safe {
                        assert_eq!(
                            before,
                            (w.custody.produced, w.custody.consumed, w.custody.imported),
                            "replay of {op:?}"
                        );
                    }
                }
                None
            }
            _ => {
                if !captured && step > steps / 2 && rng.below(4) == 0 {
                    w.facilities
                        .get_mut(&SITE_A)
                        .unwrap()
                        .capture(now, X)
                        .unwrap();
                    w.apply(now, X, &Op::FacilityLost { facility: f }).unwrap();
                    captured = true;
                    *stats.entry("capture").or_default() += 1;
                }
                None
            }
        };
        if let Some(op) = op {
            let kind = match op {
                Op::Reserve { .. } => "reserve",
                Op::Deposit { .. } => "deposit",
                Op::Cancel { .. } => "cancel",
                Op::Settle { .. } => "settle",
                Op::Retire { .. } => "retire",
                Op::Claim { .. } => "claim",
                _ => "other",
            };
            match w.apply(now, user, &op) {
                Ok(wylls_capacity::Outcome::Applied(_)) => {
                    *stats.entry(kind).or_default() += 1;
                    done.push((user, op));
                }
                Ok(_) => *stats.entry("already").or_default() += 1,
                Err(e) => {
                    *stats
                        .entry(if e == wylls_capacity::CapError::CapacityExceeded {
                            "capacity-refused"
                        } else {
                            "refused"
                        })
                        .or_default() += 1
                }
            }
        }
        check(&w, f, now);
        // A restart: save, restore, and the restored world is the same.
        if step % 17 == 0 {
            let bytes = borsh::to_vec(&w).unwrap();
            let back = Harness::<MockCustody>::try_from_slice(&bytes).unwrap();
            assert_eq!(back, w);
            w = back;
        }
    }
    // Settle everything far in the future: every output is its closed form.
    let end = now + 30 * 86_400;
    let ids: Vec<JobId> = w.pool(f).unwrap().jobs.iter().map(|j| j.id).collect();
    for id in ids {
        if !captured {
            w.apply(end, X, &Op::Settle { job: id }).unwrap();
            let j = w.job(id).unwrap();
            assert_ne!(j.fin, Fin::Open);
            assert_eq!(j.settled, j.out_at(end));
        }
    }
    check(&w, f, end);
}

#[test]
fn random_interleavings_keep_every_invariant() {
    let mut stats = std::collections::BTreeMap::new();
    for seed in 1..=300u64 {
        scenario(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15), 120, &mut stats);
    }
    eprintln!("applied per kind over 300 scenarios: {stats:?}");
    for (k, min) in [
        ("reserve", 2_000),
        ("deposit", 1_000),
        ("settle", 1_000),
        ("claim", 300),
        ("cancel", 200),
        ("owner", 300),
        ("capture", 50),
        ("capacity-refused", 100),
        ("already", 100),
        ("retire", 50),
    ] {
        assert!(
            stats.get(k).copied().unwrap_or(0) >= min,
            "{k}: {:?} < {min}",
            stats.get(k)
        );
    }
}

#[test]
fn settling_often_or_never_ends_the_same() {
    // The same reservations and deposits, one world settled every few
    // minutes by a crank, the other only at the claims.
    for seed in 1..=50u64 {
        let mut rng = Rng(seed.wrapping_mul(7919));
        let mk = || world(4, 4, 4, Policies::PROVISIONAL);
        let (mut a, f) = mk();
        let (mut b, _) = mk();
        let mut ops = Vec::new();
        for n in 0..6u32 {
            let job = JobId {
                grant: GrantId {
                    facility: f,
                    seq: 1 + n % 2,
                },
                seq: n,
            };
            let start = T0 + HOUR + rng.below(3 * HOUR as u64) as i64;
            ops.push((
                job,
                start,
                start + 600 + rng.below(3 * HOUR as u64) as i64,
                1 + rng.below(2) as u32,
                rng.below(20) as i64,
                rng.below(20) as i64,
            ));
        }
        for w in [&mut a, &mut b] {
            for (i, &(job, start, end, units, ore, wood)) in ops.iter().enumerate() {
                let user = if job.grant.seq == 1 { B } else { C };
                let _ = w.apply(
                    T0 + 10,
                    user,
                    &Op::Reserve {
                        job,
                        units,
                        start,
                        end,
                        max_output: 8 * MILLI,
                    },
                );
                arrived(&mut w.custody, user, 500 + i as u64, ore, wood);
                for (k, r, amt) in [(0, Resource::Ore, ore), (1, Resource::Wood, wood)] {
                    if amt > 0 {
                        let _ = w.apply(
                            T0 + 20,
                            user,
                            &Op::Deposit {
                                job,
                                deposit: k,
                                resource: r,
                                amount: amt * MILLI,
                                from: Place::Caravan(500 + i as u64),
                            },
                        );
                    }
                }
            }
        }
        let mut t = T0 + 30;
        while t < T0 + 8 * HOUR {
            t += 1 + rng.below(900) as i64;
            for &(job, ..) in &ops {
                let _ = a.apply(t, X, &Op::Settle { job });
            }
        }
        let end = T0 + 9 * HOUR;
        for w in [&mut a, &mut b] {
            for &(job, ..) in &ops {
                let user = if job.grant.seq == 1 { B } else { C };
                let _ = w.apply(
                    end,
                    user,
                    &Op::Claim {
                        job,
                        to: Place::Caravan(9_000),
                    },
                );
            }
        }
        assert_eq!(a.custody.lots, b.custody.lots, "seed {seed}");
        assert_eq!(a.custody.produced, b.custody.produced);
        let sa: Vec<_> = a
            .pool(f)
            .unwrap()
            .jobs
            .iter()
            .map(|j| (j.id, j.settled, j.fin))
            .collect();
        let sb: Vec<_> = b
            .pool(f)
            .unwrap()
            .jobs
            .iter()
            .map(|j| (j.id, j.settled, j.fin))
            .collect();
        assert_eq!(sa, sb);
    }
}
