//! A world that does not end (contract §10): processing and capacity
//! reservations carry on across a war-period boundary, through restarts,
//! and over a long run without the state growing.
//!
//! The boundary here is a fixed test instant, not a period rule: ⑨ defines
//! no period (④ and ⑧ own that). [`CoreEndGate`] models the rule the core
//! has today (`frontier_abi::prologue::PlayerStart::finish`: every player
//! instruction is refused once `bell(now) ≥ end_bell`) to show what it
//! would do to capacity jobs; the kernel itself has no such gate.

use borsh::BorshDeserialize;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, DAY, HOUR};
use wylls_capacity::custody::{By, Custody, Key, MockCustody};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Class, Fin, Harness, Op, Outcome};
use wylls_capacity::model::{Actor, FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::recipe::RECIPE_ARMS;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;

/// The fixed test boundary: two hours after the fixtures' start.
const BOUNDARY: i64 = T0 + 2 * HOUR;

/// A model of today's core: owner and user operations refused at or after
/// the end; anyone's (keeper-class) ones still run.
struct CoreEndGate(i64);

impl CoreEndGate {
    fn allows(&self, now: i64, op: &Op) -> bool {
        op.class() == Class::Anyone || now < self.0
    }
}

/// One step of the boundary script: (time, signer, operation).
fn script(f: FacilityId) -> (Vec<(i64, Actor, Op)>, JobId) {
    let g = GrantId {
        facility: f,
        seq: 1,
    };
    let j = JobId { grant: g, seq: 1 };
    let start = BOUNDARY + HOUR; // the materials arrive after the boundary
    let ops = vec![
        // Before the boundary: reserve a job that runs across it.
        (
            T0 + 600,
            B,
            Op::Reserve {
                job: j,
                units: 2,
                start,
                end: start + 3 * HOUR,
                max_output: 20 * MILLI,
            },
        ),
        // After the boundary: the caravan has arrived, B deposits.
        (
            BOUNDARY + 1_800,
            B,
            Op::Deposit {
                job: j,
                deposit: 1,
                resource: Resource::Ore,
                amount: 40 * MILLI,
                from: Place::Caravan(77),
            },
        ),
        (
            BOUNDARY + 1_800,
            B,
            Op::Deposit {
                job: j,
                deposit: 2,
                resource: Resource::Wood,
                amount: 20 * MILLI,
                from: Place::Caravan(77),
            },
        ),
        (start + HOUR, X, Op::Settle { job: j }),
        (start + 4 * HOUR, X, Op::Settle { job: j }),
        (
            start + 4 * HOUR,
            B,
            Op::Claim {
                job: j,
                to: Place::Caravan(78),
            },
        ),
        (start + 4 * HOUR + 1, X, Op::Retire { job: j }),
    ];
    (ops, j)
}

/// B's caravan leaves before the boundary and is in transit across it.
fn setup() -> (Harness<MockCustody>, FacilityId) {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    arrived(&mut w.custody, B, 77, 40, 20);
    (w, f)
}

fn run(
    w: &mut Harness<MockCustody>,
    ops: &[(i64, Actor, Op)],
    gate: Option<&CoreEndGate>,
    restart_at: &[i64],
) -> Vec<Result<Outcome, CapError>> {
    let mut out = Vec::new();
    for (t, who, op) in ops {
        if restart_at.iter().any(|r| r == t) {
            let bytes = borsh::to_vec(&*w).unwrap();
            *w = Harness::try_from_slice(&bytes).unwrap();
        }
        if gate.is_some_and(|g| !g.allows(*t, op)) {
            out.push(Err(CapError::FacilityGone)); // stands for the core's WrongStatus
            continue;
        }
        out.push(w.apply(*t, *who, op));
    }
    out
}

fn settled_events(w: &Harness<MockCustody>) -> (usize, i64) {
    let mut n = 0;
    let mut total = 0;
    for (_, e) in &w.events {
        if let Event::Settled { out, .. } = e {
            n += 1;
            total += out;
        }
    }
    (n, total)
}

#[test]
fn a_job_runs_across_the_boundary_as_if_there_were_none() {
    let (mut w, f) = setup();
    let (ops, j) = script(f);
    let res = run(&mut w, &ops, None, &[]);
    assert!(
        res.iter().all(|r| matches!(r, Ok(Outcome::Applied(_)))),
        "{res:?}"
    );
    // Owner, quantity, count and cost after the boundary.
    assert_eq!(
        w.custody.balance(Place::Caravan(78), ARMS),
        (Some(B), 20 * MILLI)
    );
    assert_eq!(w.custody.consumed[Resource::Ore as usize], 40 * MILLI);
    assert_eq!(w.custody.consumed[Resource::Wood as usize], 20 * MILLI);
    assert_eq!(w.custody.produced[ARMS as usize], 20 * MILLI);
    assert_eq!(settled_events(&w), (2, 20 * MILLI));
    w.custody.check().unwrap();
    // Retired: the record is gone, its output counted in the grant.
    assert!(w.job(j).is_none());
    assert_eq!(
        w.apply(T0 + 30 * HOUR, X, &Op::Retire { job: j }),
        Ok(Outcome::AlreadyApplied)
    );
}

#[test]
fn restarts_before_at_and_after_the_boundary_change_nothing() {
    let (ops, _) = script(setup().1);
    let (mut once, _) = setup();
    run(&mut once, &ops, None, &[]);
    let times: Vec<i64> = ops.iter().map(|o| o.0).collect();
    for restart in [vec![times[0]], vec![times[1]], times.clone()] {
        let (mut w, _) = setup();
        run(&mut w, &ops, None, &restart);
        assert_eq!(w, once, "restart at {restart:?}");
    }
    // Replaying the whole script after the run (a keeper that restarted
    // and resent everything) moves nothing and makes nothing.
    let mut replay = once.clone();
    let before = (
        replay.custody.lots.clone(),
        replay.custody.produced,
        replay.custody.consumed,
    );
    let late = ops.last().unwrap().0 + 10;
    for (_, who, op) in &ops {
        let r = replay.apply(late, *who, op);
        assert!(
            matches!(r, Ok(Outcome::AlreadyApplied) | Err(CapError::Retired)),
            "{op:?}: {r:?}"
        );
    }
    assert_eq!(
        before,
        (
            replay.custody.lots,
            replay.custody.produced,
            replay.custody.consumed
        )
    );
}

#[test]
fn todays_core_end_rule_would_strand_the_users_goods() {
    // The dependency this workstream reports (README §9, R1): under the
    // core's end rule B's deposit and claim are refused after the boundary;
    // the materials stay in B's caravan and the arms would never be made
    // or handed out. The kernel's own run (above) does not depend on it.
    let (mut w, f) = setup();
    let (ops, _) = script(f);
    let res = run(&mut w, &ops, Some(&CoreEndGate(BOUNDARY)), &[]);
    assert!(
        matches!(res[0], Ok(Outcome::Applied(_))),
        "reserved before the end"
    );
    assert!(res[1].is_err() && res[2].is_err(), "deposits refused");
    assert!(res[5].is_err(), "claim refused");
    assert_eq!(
        w.custody.balance(Place::Caravan(77), Resource::Ore).1,
        40 * MILLI
    );
    assert_eq!(w.custody.produced[ARMS as usize], 0);
}

#[test]
fn grant_expiry_is_not_the_worlds_end() {
    // A grant ends; the facility, the pool and the lent copies go on, and a
    // new grant to the same user serves new jobs.
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let g1 = GrantId {
        facility: f,
        seq: 1,
    };
    let until = T0 + GRANT_DAYS * DAY;
    assert_eq!(
        w.apply(until, X, &Op::RetireGrant { grant: g1 }),
        Ok(Outcome::Applied(vec![Event::GrantRetired { grant: g1 }]))
    );
    let g3 = GrantId {
        facility: f,
        seq: 3,
    };
    w.apply(
        until + 1,
        A,
        &Op::Grant {
            grant: g3,
            user: B,
            recipe: RECIPE_ARMS,
            max_units: 2,
            max_output: 10 * MILLI,
            from: until,
            until: until + 30 * DAY,
        },
    )
    .unwrap();
    // The retired grant's number cannot be issued again.
    let again = Op::Grant {
        grant: g1,
        user: C,
        recipe: RECIPE_ARMS,
        max_units: 1,
        max_output: MILLI,
        from: until,
        until: until + DAY,
    };
    assert_eq!(w.apply(until + 2, A, &again), Err(CapError::Retired));
    let j = JobId { grant: g3, seq: 1 };
    w.apply(
        until + 3,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: until + HOUR,
            end: until + 2 * HOUR,
            max_output: 8 * MILLI,
        },
    )
    .unwrap();
    assert_eq!(w.pool(f).unwrap().lent, 2);
    assert_eq!(w.facilities[&SITE_A].lent, 2);
}

#[test]
fn retirement_keeps_budgets_and_refuses_stale_keys() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let g = GrantId {
        facility: f,
        seq: 1,
    };
    let j1 = JobId { grant: g, seq: 1 };
    let start = T0 + HOUR;
    w.apply(
        T0 + 1,
        B,
        &Op::Reserve {
            job: j1,
            units: 2,
            start,
            end: start + 10 * HOUR,
            max_output: 60 * MILLI,
        },
    )
    .unwrap();
    arrived(&mut w.custody, B, 77, 120, 60);
    for (n, r, a) in [(1, Resource::Ore, 120), (2, Resource::Wood, 60)] {
        w.apply(
            T0 + 2,
            B,
            &Op::Deposit {
                job: j1,
                deposit: n,
                resource: r,
                amount: a * MILLI,
                from: Place::Caravan(77),
            },
        )
        .unwrap();
    }
    assert_eq!(
        w.apply(start + HOUR, X, &Op::Retire { job: j1 }),
        Err(CapError::NotRetirable),
        "still running"
    );
    w.apply(start + 9 * HOUR, X, &Op::Settle { job: j1 })
        .unwrap();
    assert_eq!(
        w.apply(start + 9 * HOUR, X, &Op::Retire { job: j1 }),
        Err(CapError::NotRetirable),
        "not handed out"
    );
    w.apply(
        start + 9 * HOUR,
        B,
        &Op::Claim {
            job: j1,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    w.apply(start + 9 * HOUR, X, &Op::Retire { job: j1 })
        .unwrap();
    // The 60 made still count against the grant's 100.
    let j2 = JobId { grant: g, seq: 2 };
    let big = Op::Reserve {
        job: j2,
        units: 1,
        start: start + 10 * HOUR,
        end: start + 30 * HOUR,
        max_output: 41 * MILLI,
    };
    assert_eq!(
        w.apply(start + 9 * HOUR, B, &big),
        Err(CapError::GrantOutputExceeded)
    );
    // Every operation on the retired job is refused before custody.
    for op in [
        Op::Reserve {
            job: j1,
            units: 2,
            start: start + 10 * HOUR,
            end: start + 11 * HOUR,
            max_output: MILLI,
        },
        Op::Deposit {
            job: j1,
            deposit: 1,
            resource: Resource::Ore,
            amount: 120 * MILLI,
            from: Place::Caravan(77),
        },
        Op::Cancel { job: j1 },
        Op::Claim {
            job: j1,
            to: Place::Caravan(78),
        },
    ] {
        assert_eq!(
            w.apply(start + 9 * HOUR, B, &op),
            Err(CapError::Retired),
            "{op:?}"
        );
    }
    assert_eq!(
        w.apply(start + 9 * HOUR, X, &Op::Settle { job: j1 }),
        Err(CapError::Retired)
    );
    // Its custody keys were forgotten (the store stays bounded).
    assert!(w.custody.keys.keys().all(|k| k.scope != 0));
    w.custody.check().unwrap();
}

#[test]
fn a_wrapped_generation_waits_for_the_old_records() {
    // 256 captures bring the u8 generation back to the same number.
    let p = Policies {
        loss: LossPolicy::UserKeepsAll,
        ..Policies::PROVISIONAL
    };
    let (mut w, f) = world(3, 2, 2, p);
    let j = JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq: 1,
    };
    w.apply(
        T0 + 1,
        B,
        &Op::Reserve {
            job: j,
            units: 1,
            start: T0 + HOUR,
            end: T0 + 2 * HOUR,
            max_output: MILLI,
        },
    )
    .unwrap();
    arrived(&mut w.custody, B, 77, 2, 1);
    w.apply(
        T0 + 2,
        B,
        &Op::Deposit {
            job: j,
            deposit: 1,
            resource: Resource::Ore,
            amount: 2 * MILLI,
            from: Place::Caravan(77),
        },
    )
    .unwrap();
    let mut t = T0 + 3;
    for i in 0..256u32 {
        let captor = if i % 2 == 0 { X } else { A };
        w.facilities
            .get_mut(&SITE_A)
            .unwrap()
            .capture(t, captor)
            .unwrap();
        t += 60;
    }
    let fac = w.facilities[&SITE_A].clone();
    assert_eq!(fac.gen, f.gen, "the u8 generation wrapped");
    w.apply(t, X, &Op::FacilityLost { facility: f }).unwrap();
    let open = Op::OpenPool {
        facility: f,
        policies: Policies::PROVISIONAL,
    };
    assert_eq!(
        w.apply(t, fac.owner, &open),
        Err(CapError::GenerationReused)
    );
    // B claims what it kept, the records retire, the number is free again.
    w.apply(
        t + 1,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(
        w.custody.balance(Place::Caravan(78), Resource::Ore).1,
        2 * MILLI
    );
    w.apply(t + 2, X, &Op::Retire { job: j }).unwrap();
    w.apply(t + 3, X, &Op::RetirePool { facility: f }).unwrap();
    w.apply(t + 4, fac.owner, &open).unwrap();
    // The new pool starts empty; the old grant's number is a new grant.
    assert!(w.pool(f).unwrap().grants.is_empty());
    w.custody.check().unwrap();
}

#[test]
fn large_times_settle_without_overflow() {
    // Year ~3000: the closed forms and the capacity sweep stay exact.
    let far = 32_503_680_000i64;
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let g = GrantId {
        facility: f,
        seq: 9,
    };
    w.apply(
        far,
        A,
        &Op::Grant {
            grant: g,
            user: B,
            recipe: RECIPE_ARMS,
            max_units: 2,
            max_output: 100 * MILLI,
            from: far,
            until: far + 30 * DAY,
        },
    )
    .unwrap();
    let j = JobId { grant: g, seq: 1 };
    w.apply(
        far,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: far + HOUR,
            end: far + 4 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    arrived(&mut w.custody, B, 77, 40, 20);
    for (n, r, a) in [(1, Resource::Ore, 40), (2, Resource::Wood, 20)] {
        w.apply(
            far + 1,
            B,
            &Op::Deposit {
                job: j,
                deposit: n,
                resource: r,
                amount: a * MILLI,
                from: Place::Caravan(77),
            },
        )
        .unwrap();
    }
    w.apply(
        far + 5 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(w.custody.balance(Place::Caravan(78), ARMS).1, 20 * MILLI);
    // The owner's Holding settled across ~970 years of lending.
    let h = &w.facilities[&SITE_A].holding;
    assert_eq!(
        h.stores[ARMS as usize].rate,
        permutation_rules::frontier::arms::WORKSHOP_DELTA
    );
    assert!(h.stores[ARMS as usize].value <= h.stores[ARMS as usize].cap);
}

#[test]
fn a_long_run_keeps_the_state_bounded() {
    // 20,000 jobs over ~27 years on one facility, two users, grants that
    // expire every 90 days and are renewed. The state must not grow.
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let mut t = T0 + 60;
    let mut grant_seq = 2u32;
    let mut grants = [
        GrantId {
            facility: f,
            seq: 1,
        },
        GrantId {
            facility: f,
            seq: 2,
        },
    ];
    let mut job_seq = [0u32; 2];
    // The fixtures' small grants are revoked; the loop issues its own.
    for g in grants {
        w.apply(t, A, &Op::Revoke { grant: g }).unwrap();
    }
    let mut until = t;
    let mut sizes = Vec::new();
    let mut made = 0i64;
    for n in 0..20_000u64 {
        let u = (n % 2) as usize;
        let user = [B, C][u];
        // Renew the grants before they lapse; retire the old ones.
        if t + 2 * HOUR >= until {
            let new_until = t + 90 * DAY;
            for (k, who) in [B, C].into_iter().enumerate() {
                let old = grants[k];
                w.apply(until, X, &Op::RetireGrant { grant: old }).unwrap();
                grant_seq += 1;
                grants[k] = GrantId {
                    facility: f,
                    seq: grant_seq,
                };
                w.apply(
                    until,
                    A,
                    &Op::Grant {
                        grant: grants[k],
                        user: who,
                        recipe: RECIPE_ARMS,
                        max_units: 2,
                        max_output: 1_000_000 * MILLI,
                        from: until,
                        until: new_until,
                    },
                )
                .unwrap();
                job_seq[k] = 0;
            }
            t = t.max(until);
            until = new_until;
        }
        job_seq[u] += 1;
        let j = JobId {
            grant: grants[u],
            seq: job_seq[u],
        };
        let start = t + 60;
        w.apply(
            t,
            user,
            &Op::Reserve {
                job: j,
                units: 1,
                start,
                end: start + HOUR,
                max_output: 4 * MILLI,
            },
        )
        .unwrap();
        let cv = 1_000_000 + n;
        arrived(&mut w.custody, user, cv, 8, 4);
        w.apply(
            t,
            user,
            &Op::Deposit {
                job: j,
                deposit: 1,
                resource: Resource::Ore,
                amount: 8 * MILLI,
                from: Place::Caravan(cv),
            },
        )
        .unwrap();
        w.apply(
            t,
            user,
            &Op::Deposit {
                job: j,
                deposit: 2,
                resource: Resource::Wood,
                amount: 4 * MILLI,
                from: Place::Caravan(cv),
            },
        )
        .unwrap();
        let done = start + HOUR;
        let home = Place::Caravan(2_000_000 + n);
        w.apply(done, user, &Op::Claim { job: j, to: home })
            .unwrap();
        w.apply(done, X, &Op::Retire { job: j }).unwrap();
        // The goods go home (out of custody), as a caravan's arrival would.
        let k = Key {
            scope: 3_000_000 + n,
            kind: 0,
            n: 0,
        };
        w.custody
            .export(k, By::Actor(user), home, ARMS, 4 * MILLI)
            .unwrap();
        w.custody.forget(3_000_000 + n);
        w.custody.forget(cv);
        made += 4 * MILLI;
        t = done + 11 * HOUR;
        // The harness's event log is a log, kept off-chain (README §9).
        w.events.clear();
        w.custody.log.clear();
        if n % 2_000 == 1_999 {
            sizes.push(borsh::to_vec(&w).unwrap().len());
        }
    }
    let p = w.pool(f).unwrap();
    assert!(p.jobs.is_empty() && p.grants.len() == 2);
    assert_eq!(w.custody.produced[ARMS as usize], made);
    assert_eq!(w.custody.exported[ARMS as usize], made);
    w.custody.check().unwrap();
    assert!(t > T0 + 25 * 365 * DAY, "simulated {} days", (t - T0) / DAY);
    // Bounded: the last snapshot is no bigger than the first plus the
    // facility's capture record (none here) and the holding's fixed size.
    eprintln!(
        "long run: {} jobs over {} days, {} grants issued, state sizes (bytes) {sizes:?}",
        w.ledger.next_uid,
        (t - T0) / DAY,
        grant_seq
    );
    let (first, last) = (sizes[0], *sizes.last().unwrap());
    assert!(last <= first + 64, "state grew: {sizes:?}");
    assert!(
        w.custody.keys.len() < 64,
        "custody keys {}",
        w.custody.keys.len()
    );
    assert!(w.ledger.next_uid == 20_000);
    let lots = w.custody.lots.len();
    assert!(lots < 8, "lots {lots}");
    let open_fin = w
        .pool(f)
        .unwrap()
        .jobs
        .iter()
        .filter(|j| j.fin == Fin::Open)
        .count();
    assert_eq!(open_fin, 0);
}
