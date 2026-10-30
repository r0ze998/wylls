//! Facility loss: capture and release, under each loss policy (contract §4).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, MockCustody};
use wylls_capacity::ledger::{Op, Outcome, Phase, World};
use wylls_capacity::model::{FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;

const S: i64 = T0 + HOUR;

/// B's job 1: 2 copies, 20 arms over [S, S + 3 h), fully fed.
fn running(loss: LossPolicy) -> (World<MockCustody>, FacilityId, JobId) {
    let (mut w, f) = world(
        3,
        2,
        2,
        Policies {
            loss,
            ..Policies::PROVISIONAL
        },
    );
    let j = JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq: 1,
    };
    w.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    arrived(&mut w.custody, B, 77, 40, 20);
    for (n, r, a) in [(1, Resource::Ore, 40), (2, Resource::Wood, 20)] {
        w.apply(
            T0 + 20,
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
    (w, f, j)
}

fn at(
    w: &World<MockCustody>,
    p: Place,
    r: Resource,
) -> (Option<wylls_capacity::model::Actor>, i64) {
    w.custody.balance(p, r)
}

#[test]
fn a_capture_mid_run_stops_the_job_and_the_captor_takes_what_is_there() {
    let (mut w, f, j) = running(LossPolicy::CaptorTakesAll);
    w.apply(S + HOUR, X, &Op::Settle { job: j }).unwrap();
    let cap = S + HOUR + 30 * 60;
    w.facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    // The core's capture ended A's lending with the generation.
    assert_eq!(w.facilities[&SITE_A].lent, 0);
    // Until the loss is recorded nothing touches the old generation.
    let claim = Op::Claim {
        job: j,
        to: Place::Caravan(78),
    };
    assert_eq!(w.apply(cap + 1, B, &claim), Err(CapError::WrongGeneration));
    assert_eq!(
        w.apply(cap + 1, X, &Op::Settle { job: j }),
        Err(CapError::WrongGeneration)
    );
    w.apply(cap + 2, B, &Op::FacilityLost { facility: f })
        .unwrap();
    assert_eq!(
        w.apply(cap + 3, X, &Op::FacilityLost { facility: f }),
        Ok(Outcome::AlreadyApplied)
    );
    let job = w.job(j).unwrap();
    assert_eq!(job.phase(cap + 3), Phase::Lost(cap));
    // 1.5 h at 8 arms/h: 12 arms, using 24 ore and 12 wood.
    assert_eq!(job.settled, 12 * MILLI);
    let home = Place::Holding(SITE_A);
    assert_eq!(at(&w, home, ARMS), (Some(X), 12 * MILLI));
    assert_eq!(at(&w, home, Resource::Ore), (Some(X), 16 * MILLI));
    assert_eq!(at(&w, home, Resource::Wood), (Some(X), 8 * MILLI));
    assert_eq!(w.apply(cap + 4, B, &claim), Ok(Outcome::AlreadyApplied));
    w.custody.check().unwrap();
    // The new owner opens a new generation's pool; the old one is gone.
    let g2 = w.facilities[&SITE_A].id();
    assert_eq!(g2.gen, f.gen + 1);
    assert_eq!(
        w.apply(
            cap + 5,
            A,
            &Op::OpenPool {
                facility: g2,
                policies: Policies::PROVISIONAL
            }
        ),
        Err(CapError::NotOwner)
    );
    w.apply(
        cap + 5,
        X,
        &Op::OpenPool {
            facility: g2,
            policies: Policies::PROVISIONAL,
        },
    )
    .unwrap();
    assert_eq!(
        w.apply(
            cap + 6,
            A,
            &Op::Lend {
                facility: f,
                units: 1,
                seq: 1
            }
        ),
        Err(CapError::FacilityGone)
    );
}

#[test]
fn users_can_keep_everything_or_only_the_output() {
    for (loss, user_output, user_rest) in [
        (LossPolicy::UserKeepsAll, true, true),
        (LossPolicy::UserKeepsOutput, true, false),
    ] {
        let (mut w, f, j) = running(loss);
        let cap = S + HOUR;
        w.facilities
            .get_mut(&SITE_A)
            .unwrap()
            .capture(cap, X)
            .unwrap();
        w.apply(cap, X, &Op::FacilityLost { facility: f }).unwrap();
        w.apply(
            cap + 1,
            B,
            &Op::Claim {
                job: j,
                to: Place::Caravan(78),
            },
        )
        .unwrap();
        let back = Place::Caravan(78);
        assert_eq!(
            at(&w, back, ARMS).1,
            if user_output { 8 * MILLI } else { 0 },
            "{loss:?}"
        );
        assert_eq!(
            at(&w, back, Resource::Ore).1,
            if user_rest { 24 * MILLI } else { 0 },
            "{loss:?}"
        );
        let home = Place::Holding(SITE_A);
        assert_eq!(
            at(&w, home, Resource::Ore).1,
            if user_rest { 0 } else { 24 * MILLI },
            "{loss:?}"
        );
        w.custody.check().unwrap();
    }
}

#[test]
fn a_capture_before_the_start_takes_the_whole_hopper_under_the_default() {
    let (mut w, f, j) = running(LossPolicy::CaptorTakesAll);
    let cap = S - 60;
    w.facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    w.apply(cap, X, &Op::FacilityLost { facility: f }).unwrap();
    assert_eq!(w.job(j).unwrap().settled, 0);
    assert_eq!(
        at(&w, Place::Holding(SITE_A), Resource::Ore),
        (Some(X), 40 * MILLI)
    );
    assert_eq!(at(&w, Place::Hopper(j), Resource::Ore).1, 0);
    w.custody.check().unwrap();
}

#[test]
fn a_capture_after_the_job_ended_takes_the_unclaimed_output() {
    let (mut w, f, j) = running(LossPolicy::CaptorTakesAll);
    let cap = S + 4 * HOUR;
    w.facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    w.apply(cap, X, &Op::FacilityLost { facility: f }).unwrap();
    assert_eq!(
        w.job(j).unwrap().phase(cap),
        Phase::Completed(S + 5 * HOUR / 2)
    );
    assert_eq!(at(&w, Place::Holding(SITE_A), ARMS), (Some(X), 20 * MILLI));
    w.custody.check().unwrap();
}

#[test]
fn claimed_goods_are_safe_from_a_later_capture() {
    let (mut w, f, j) = running(LossPolicy::CaptorTakesAll);
    w.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    let cap = S + 4 * HOUR;
    w.facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    w.apply(cap, X, &Op::FacilityLost { facility: f }).unwrap();
    assert_eq!(at(&w, Place::Caravan(78), ARMS), (Some(B), 20 * MILLI));
    assert_eq!(at(&w, Place::Holding(SITE_A), ARMS).1, 0);
}

#[test]
fn a_release_has_no_captor_so_the_user_keeps_everything() {
    let (mut w, f, j) = running(LossPolicy::CaptorTakesAll);
    let rel = S + HOUR;
    w.facilities.get_mut(&SITE_A).unwrap().release(rel).unwrap();
    w.apply(rel, X, &Op::FacilityLost { facility: f }).unwrap();
    w.apply(
        rel + 1,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(at(&w, Place::Caravan(78), ARMS).1, 8 * MILLI);
    assert_eq!(at(&w, Place::Caravan(78), Resource::Ore).1, 24 * MILLI);
    w.custody.check().unwrap();
}

#[test]
fn a_live_facility_cannot_be_declared_lost() {
    let (mut w, f, _) = running(LossPolicy::CaptorTakesAll);
    assert_eq!(
        w.apply(S, X, &Op::FacilityLost { facility: f }),
        Err(CapError::FacilityLive)
    );
}
