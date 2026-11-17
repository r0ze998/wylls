//! One facility, one recipe, one user (contract §2–§4).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, DORMANT_AFTER, HOUR};
use wylls_capacity::custody::{By, Custody, CustodyError, Key, MockCustody};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Harness, Op, Outcome, Phase};
use wylls_capacity::model::{FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::{DormancyPolicy, Policies, RevokePolicy};
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;

const S: i64 = T0 + HOUR;

fn job(f: FacilityId, seq: u32) -> JobId {
    JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq,
    }
}

fn reserve(
    w: &mut Harness<MockCustody>,
    j: JobId,
    units: u32,
    start: i64,
    end: i64,
    max: i64,
) -> Result<Outcome, CapError> {
    let now = w.clock.max(T0 + 10);
    w.apply(
        now,
        B,
        &Op::Reserve {
            job: j,
            units,
            start,
            end,
            max_output: max * MILLI,
        },
    )
}

fn deposit(w: &mut Harness<MockCustody>, j: JobId, ore: i64, wood: i64) {
    arrived(&mut w.custody, B, 77, ore, wood);
    if ore > 0 {
        w.apply(
            T0 + 20,
            B,
            &Op::Deposit {
                job: j,
                deposit: 1,
                resource: Resource::Ore,
                amount: ore * MILLI,
                from: Place::Caravan(77),
            },
        )
        .unwrap();
    }
    if wood > 0 {
        w.apply(
            T0 + 20,
            B,
            &Op::Deposit {
                job: j,
                deposit: 2,
                resource: Resource::Wood,
                amount: wood * MILLI,
                from: Place::Caravan(77),
            },
        )
        .unwrap();
    }
}

fn bal(w: &Harness<MockCustody>, p: Place, r: Resource) -> i64 {
    w.custody.balance(p, r).1
}

#[test]
fn the_whole_path_uses_the_real_rate_and_time() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    // 20 arms on 2 copies: 8 arms/h → 2.5 h.
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    for (t, out) in [
        (S - 1, 0),
        (S, 0),
        (S + HOUR, 8),
        (S + 2 * HOUR, 16),
        (S + 5 * HOUR / 2, 20),
        (S + 3 * HOUR, 20),
    ] {
        assert_eq!(w.job(j).unwrap().out_at(t), out * MILLI, "at {}", t - S);
    }
    assert_eq!(w.job(j).unwrap().end_eff(), S + 5 * HOUR / 2);
    w.apply(S + HOUR, X, &Op::Settle { job: j }).unwrap();
    assert_eq!(bal(&w, Place::Output(j), ARMS), 8 * MILLI);
    assert_eq!(bal(&w, Place::Hopper(j), Resource::Ore), 24 * MILLI);
    assert_eq!(w.job(j).unwrap().phase(S + HOUR), Phase::Running);
    // B takes what is made so far mid-run, then the rest.
    w.apply(
        S + HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    w.apply(
        S + 4 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), ARMS), 20 * MILLI);
    assert_eq!(
        w.job(j).unwrap().phase(S + 4 * HOUR),
        Phase::Completed(S + 5 * HOUR / 2)
    );
    assert_eq!(
        w.apply(
            S + 5 * HOUR,
            B,
            &Op::Claim {
                job: j,
                to: Place::Caravan(78)
            }
        ),
        Ok(Outcome::AlreadyApplied)
    );
    w.custody.check().unwrap();
    assert_eq!(w.custody.consumed[Resource::Ore as usize], 40 * MILLI);
    assert_eq!(w.custody.produced[ARMS as usize], 20 * MILLI);
}

#[test]
fn short_materials_end_the_job_early_and_the_rest_comes_back() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    // Ore for 6 arms, wood for 10: 6 arms in 45 min.
    deposit(&mut w, j, 12, 10);
    let jb = w.job(j).unwrap().clone();
    assert_eq!(jb.limit(), 6 * MILLI);
    assert_eq!(jb.end_eff(), S + 45 * 60);
    w.apply(
        S + 2 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), ARMS), 6 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Wood), 4 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Ore), 0);
    // The copies are free from 45 min on.
    assert_eq!(w.job(j).unwrap().occupies(S + 2 * HOUR), (S, S + 45 * 60));
    w.custody.check().unwrap();
}

#[test]
fn no_materials_end_at_the_start_and_refund_nothing() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 1, 0);
    w.apply(S + 1, X, &Op::Settle { job: j }).unwrap();
    assert_eq!(w.job(j).unwrap().phase(S + 1), Phase::Completed(S));
    w.apply(
        S + 1,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Ore), MILLI);
    w.custody.check().unwrap();
}

#[test]
fn cancel_before_the_start_returns_everything() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    w.apply(T0 + 30, B, &Op::Cancel { job: j }).unwrap();
    assert_eq!(
        w.apply(T0 + 31, B, &Op::Cancel { job: j }),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(w.job(j).unwrap().occupies(T0 + 31), (S, S));
    w.apply(
        S + HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Ore), 40 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Wood), 20 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), ARMS), 0);
    w.custody.check().unwrap();
}

#[test]
fn cancel_mid_run_keeps_what_was_made_and_frees_the_rest() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    w.apply(S + HOUR, B, &Op::Cancel { job: j }).unwrap();
    // Time going on adds nothing.
    assert_eq!(w.job(j).unwrap().out_at(S + 3 * HOUR), 8 * MILLI);
    w.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), ARMS), 8 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Ore), 24 * MILLI);
    assert_eq!(bal(&w, Place::Caravan(78), Resource::Wood), 12 * MILLI);
    assert_eq!(
        w.apply(S + 3 * HOUR, B, &Op::Cancel { job: j }),
        Ok(Outcome::AlreadyApplied)
    );
    w.custody.check().unwrap();
}

#[test]
fn a_finished_job_cannot_be_cancelled_and_late_deposits_are_refused() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    arrived(&mut w.custody, B, 79, 10, 0);
    let late = Op::Deposit {
        job: j,
        deposit: 9,
        resource: Resource::Ore,
        amount: 10 * MILLI,
        from: Place::Caravan(79),
    };
    assert_eq!(w.apply(S, B, &late), Err(CapError::AlreadyStarted));
    assert_eq!(
        w.apply(S + 3 * HOUR, B, &Op::Cancel { job: j }),
        Err(CapError::AlreadyFinal)
    );
    let wrong = Op::Deposit {
        job: j,
        deposit: 8,
        resource: Resource::Food,
        amount: MILLI,
        from: Place::Caravan(79),
    };
    assert_eq!(
        w.apply(S + 3 * HOUR, B, &wrong),
        Err(CapError::WrongResource)
    );
}

#[test]
fn the_grant_bounds_window_units_output_and_user() {
    let (mut w, f) = world(4, 4, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    assert_eq!(
        reserve(&mut w, j, 3, S, S + HOUR, 5),
        Err(CapError::GrantUnitsExceeded)
    );
    assert_eq!(
        reserve(&mut w, j, 1, S, S + 7 * 86_400 + 1, 5),
        Err(CapError::BadWindow),
        "too long"
    );
    let until = T0 + GRANT_DAYS * 86_400;
    assert_eq!(
        reserve(&mut w, j, 1, until - HOUR, until + 1, 5),
        Err(CapError::OutsideGrantWindow)
    );
    assert_eq!(
        reserve(&mut w, j, 1, T0, S, 5),
        Err(CapError::BadWindow),
        "start in the past"
    );
    assert_eq!(reserve(&mut w, j, 1, S, S, 5), Err(CapError::BadWindow));
    assert_eq!(
        reserve(&mut w, j, 1, S, S + HOUR, 101),
        Err(CapError::GrantOutputExceeded)
    );
    let other = Op::Reserve {
        job: j,
        units: 1,
        start: S,
        end: S + HOUR,
        max_output: MILLI,
    };
    assert_eq!(w.apply(T0 + 10, C, &other), Err(CapError::NotUser));
    assert_eq!(w.apply(T0 + 10, A, &other), Err(CapError::NotUser));
    // The output budget counts open jobs at their max, final ones at what
    // they made.
    reserve(&mut w, j, 1, S, S + HOUR, 60).unwrap();
    assert_eq!(
        reserve(&mut w, job(f, 2), 1, S, S + HOUR, 41),
        Err(CapError::GrantOutputExceeded)
    );
    w.apply(T0 + 11, B, &Op::Cancel { job: j }).unwrap();
    reserve(&mut w, job(f, 2), 1, S, S + HOUR, 100).unwrap();
}

#[test]
fn expiry_stops_new_reservations() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let end = T0 + GRANT_DAYS * 86_400;
    let op = Op::Reserve {
        job: job(f, 1),
        units: 1,
        start: end - 10,
        end,
        max_output: MILLI,
    };
    assert_eq!(
        w.apply(end - 5, B, &op),
        Err(CapError::BadWindow),
        "starts before now"
    );
    let op = Op::Reserve {
        job: job(f, 1),
        units: 1,
        start: end,
        end: end + 10,
        max_output: MILLI,
    };
    assert_eq!(w.apply(end, B, &op), Err(CapError::OutsideGrantWindow));
}

#[test]
fn revocation_honours_booked_jobs_by_default() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    let revoke = Op::Revoke { grant: j.grant };
    assert_eq!(w.apply(T0 + 30, B, &revoke), Err(CapError::NotOwner));
    w.apply(T0 + 30, A, &revoke).unwrap();
    assert_eq!(w.apply(T0 + 31, A, &revoke), Ok(Outcome::AlreadyApplied));
    assert_eq!(
        reserve(&mut w, job(f, 2), 1, S, S + HOUR, 1),
        Err(CapError::GrantRevoked)
    );
    w.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Caravan(78), ARMS), 20 * MILLI);
}

#[test]
fn revocation_can_cancel_booked_jobs_but_never_a_running_one() {
    let p = Policies {
        revoke: RevokePolicy::CancelBooked,
        ..Policies::PROVISIONAL
    };
    let (mut w, f) = world(3, 3, 3, p);
    let running = job(f, 1);
    let booked = job(f, 2);
    reserve(&mut w, running, 1, S, S + 3 * HOUR, 10).unwrap();
    reserve(&mut w, booked, 1, S + 2 * HOUR, S + 3 * HOUR, 4).unwrap();
    deposit(&mut w, running, 20, 10);
    w.apply(
        S + HOUR,
        A,
        &Op::Revoke {
            grant: booked.grant,
        },
    )
    .unwrap();
    assert_eq!(
        w.job(booked).unwrap().phase(S + HOUR),
        Phase::Cancelled(S + HOUR)
    );
    assert_eq!(w.job(running).unwrap().phase(S + HOUR), Phase::Running);
    assert_eq!(w.job(running).unwrap().out_at(S + 3 * HOUR), 10 * MILLI);
}

#[test]
fn the_owner_away_changes_nothing_by_default() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let away = T0 + DORMANT_AFTER + HOUR;
    assert!(w.facilities[&SITE_A].dormant(away));
    let op = Op::Reserve {
        job: job(f, 1),
        units: 2,
        start: away + 60,
        end: away + HOUR,
        max_output: MILLI,
    };
    w.apply(away, B, &op).unwrap();
}

#[test]
fn the_owner_away_can_refuse_new_reservations() {
    let p = Policies {
        dormancy: DormancyPolicy::RefuseNewWhenDormant,
        ..Policies::PROVISIONAL
    };
    let (mut w, f) = world(3, 2, 2, p);
    let away = T0 + DORMANT_AFTER + HOUR;
    let op = Op::Reserve {
        job: job(f, 1),
        units: 2,
        start: away + 60,
        end: away + HOUR,
        max_output: MILLI,
    };
    assert_eq!(w.apply(away, B, &op), Err(CapError::OwnerAway));
    reserve(&mut w, job(f, 2), 2, S, S + HOUR, 1).unwrap();
}

#[test]
fn every_retry_is_idempotent_and_a_changed_retry_conflicts() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    assert_eq!(
        reserve(&mut w, j, 2, S, S + 3 * HOUR, 20),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(
        reserve(&mut w, j, 1, S, S + 3 * HOUR, 20),
        Err(CapError::Conflict)
    );
    deposit(&mut w, j, 40, 20);
    let d = Op::Deposit {
        job: j,
        deposit: 1,
        resource: Resource::Ore,
        amount: 40 * MILLI,
        from: Place::Caravan(77),
    };
    assert_eq!(w.apply(T0 + 25, B, &d), Ok(Outcome::AlreadyApplied));
    let d2 = Op::Deposit {
        job: j,
        deposit: 1,
        resource: Resource::Ore,
        amount: 41 * MILLI,
        from: Place::Caravan(77),
    };
    assert_eq!(w.apply(T0 + 25, B, &d2), Err(CapError::Conflict));
    assert_eq!(w.job(j).unwrap().hopper, [40 * MILLI, 20 * MILLI]);
    // The owner's optimistic sequence: a replayed Lend is a no-op, a stale
    // one conflicts.
    let lend = Op::Lend {
        facility: f,
        units: 2,
        seq: 0,
    };
    assert_eq!(w.apply(T0 + 26, A, &lend), Ok(Outcome::AlreadyApplied));
    let pool_before = w.pool(f).unwrap().clone();
    assert_eq!(
        w.apply(
            T0 + 26,
            A,
            &Op::Lend {
                facility: f,
                units: 1,
                seq: 0
            }
        ),
        Err(CapError::Conflict)
    );
    assert_eq!(*w.pool(f).unwrap(), pool_before);
    let grant = Op::Grant {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        user: B,
        recipe: wylls_capacity::recipe::RECIPE_ARMS,
        max_units: 2,
        max_output: 100 * MILLI,
        from: T0,
        until: T0 + GRANT_DAYS * 86_400,
    };
    assert_eq!(w.apply(T0 + 27, A, &grant), Ok(Outcome::AlreadyApplied));
    // Many settles at many times give one output.
    for t in (S..S + 4 * HOUR).step_by(997) {
        w.apply(t, X, &Op::Settle { job: j }).unwrap();
        w.apply(t, X, &Op::Settle { job: j }).unwrap();
    }
    assert_eq!(w.custody.produced[ARMS as usize], 20 * MILLI);
    w.custody.check().unwrap();
}

#[test]
fn the_owner_cannot_take_from_a_hopper_or_an_output() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    w.apply(S + HOUR, X, &Op::Settle { job: j }).unwrap();
    let k = Key {
        scope: 1,
        kind: 200,
        n: 0,
    };
    for (from, r) in [(Place::Hopper(j), Resource::Ore), (Place::Output(j), ARMS)] {
        for by in [By::Actor(A), By::Actor(B)] {
            assert_eq!(
                w.custody
                    .transfer(k, by, from, Place::Holding(SITE_A), r, MILLI, A),
                Err(CustodyError::Forbidden)
            );
        }
    }
    assert_eq!(
        w.custody
            .export(k, By::Actor(A), Place::Output(j), ARMS, MILLI),
        Err(CustodyError::Forbidden)
    );
    // A deposit spends only the signer's own goods.
    arrived(&mut w.custody, C, 90, 10, 0);
    let later = job(f, 2);
    w.apply(
        S + HOUR,
        B,
        &Op::Reserve {
            job: later,
            units: 1,
            start: S + 9 * HOUR,
            end: S + 10 * HOUR,
            max_output: MILLI,
        },
    )
    .unwrap();
    let steal = Op::Deposit {
        job: later,
        deposit: 5,
        resource: Resource::Ore,
        amount: MILLI,
        from: Place::Caravan(90),
    };
    assert_eq!(w.apply(S + HOUR, B, &steal), Err(CapError::Custody));
    assert_eq!(
        w.custody.balance(Place::Caravan(90), Resource::Ore).1,
        10 * MILLI
    );
}

#[test]
fn times_never_go_back_and_an_error_changes_nothing() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let before = w.clone();
    assert_eq!(
        reserve(&mut w, job(f, 1), 3, S, S + HOUR, 1),
        Err(CapError::GrantUnitsExceeded)
    );
    assert_eq!(w, before);
    w.apply(T0 + 100, X, &Op::Settle { job: job(f, 9) })
        .unwrap_err();
    assert_eq!(w.clock, T0, "a refused operation does not move the clock");
    w.apply(
        T0 + 100,
        B,
        &Op::Reserve {
            job: job(f, 1),
            units: 1,
            start: S,
            end: S + HOUR,
            max_output: MILLI,
        },
    )
    .unwrap();
    assert_eq!(
        w.apply(T0 + 50, B, &Op::Cancel { job: job(f, 1) }),
        Err(CapError::TimeReversed)
    );
}

#[test]
fn events_tell_the_whole_story() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let j = job(f, 1);
    reserve(&mut w, j, 2, S, S + 3 * HOUR, 20).unwrap();
    deposit(&mut w, j, 40, 20);
    w.apply(
        S + 4 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    let kinds: Vec<&'static str> = w
        .events
        .iter()
        .map(|(_, e)| match e {
            Event::PoolOpened { .. } => "open",
            Event::Lent { .. } => "lent",
            Event::Granted { .. } => "grant",
            Event::Reserved { .. } => "reserve",
            Event::Deposited { .. } => "deposit",
            Event::Started { .. } => "start",
            Event::Settled { .. } => "settle",
            Event::Completed { .. } => "complete",
            Event::Claimed { .. } => "claim",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "open", "lent", "grant", "grant", "reserve", "deposit", "deposit", "start", "settle",
            "complete", "claim"
        ]
    );
}

#[test]
fn claims_go_only_to_a_players_place() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let (j1, j2) = (job(f, 1), job(f, 2));
    reserve(&mut w, j1, 1, S, S + HOUR, 4).unwrap();
    reserve(&mut w, j2, 1, S + HOUR, S + 2 * HOUR, 4).unwrap();
    deposit(&mut w, j1, 8, 4);
    for to in [Place::Hopper(j2), Place::Output(j2), Place::Output(j1)] {
        assert_eq!(
            w.apply(S + HOUR, B, &Op::Claim { job: j1, to }),
            Err(CapError::BadPlace)
        );
    }
    w.apply(
        S + HOUR,
        B,
        &Op::Claim {
            job: j1,
            to: Place::Vault(5),
        },
    )
    .unwrap();
    assert_eq!(bal(&w, Place::Vault(5), ARMS), 4 * MILLI);
}
