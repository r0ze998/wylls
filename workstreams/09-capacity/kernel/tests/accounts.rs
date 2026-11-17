//! A job as accounts in workstream 10's terms, the split claim (whole
//! units to one place, the sub-unit rest to another) and the custody's own
//! refusal reason (workstream 10's requests R3, R4, R5).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, CustodyError};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Account, Harness, Op, Outcome, Refusal};
use wylls_capacity::model::{GrantId, JobId, Place};
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;

const S: i64 = T0 + HOUR;

/// B's job: 2 copies, 20 arms over [S, S + 3 h), fed 40 ore and 20 wood.
fn fed(policies: Policies) -> (Harness<wylls_capacity::custody::MockCustody>, JobId) {
    let (mut w, f) = world(3, 2, 2, policies);
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
    (w, j)
}

fn acct(in_total: i64, held: i64, out_total: i64, consumed: i64, forfeited: i64) -> Account {
    Account {
        in_total,
        held,
        out_total,
        consumed,
        forfeited,
    }
}

#[test]
fn a_job_balances_like_a_lot_at_every_step() {
    let (mut w, j) = fed(Policies::PROVISIONAL);
    let a = w.job(j).unwrap().accounts();
    assert_eq!(a.inputs[0], acct(40 * MILLI, 40 * MILLI, 0, 0, 0));
    // A third of an hour in: 8/3 arms (rounded down), its ore and wood used.
    let t = S + 1_200;
    w.apply(t, X, &Op::Settle { job: j }).unwrap();
    let out = w.job(j).unwrap().settled;
    assert_eq!(out, 2_666);
    let a = w.job(j).unwrap().accounts();
    assert!(a.balanced());
    assert_eq!(
        a.inputs[0],
        acct(40 * MILLI, 40 * MILLI - 2 * out, 0, 2 * out, 0)
    );
    assert_eq!(a.output, acct(out, out, 0, 0, 0));
    // Each account's held is what custody holds in the job's places.
    assert_eq!(
        a.inputs[0].held,
        w.custody.balance(Place::Hopper(j), Resource::Ore).1
    );
    assert_eq!(a.output.held, w.custody.balance(Place::Output(j), ARMS).1);
}

#[test]
fn a_split_claim_sends_whole_units_and_the_rest_apart() {
    let (mut w, j) = fed(Policies::PROVISIONAL);
    // Cancelled at 2,666 milli arms: 34.668 ore and 17.334 wood are left.
    w.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    let (lot, home, cart) = (Place::Vault(9), Place::Caravan(78), Place::Caravan(79));
    let op = Op::ClaimSplit {
        job: j,
        output_to: home,
        refund_to: [lot, home],
        remainder_to: cart,
    };
    let Outcome::Applied(ev) = w.apply(S + 1_300, B, &op).unwrap() else {
        panic!()
    };
    assert!(ev.contains(&Event::Refunded {
        job: j,
        whole: [34 * MILLI, 17 * MILLI],
        remainder: [668, 334],
        refund_to: [lot, home],
        remainder_to: cart,
    }));
    assert_eq!(w.custody.balance(lot, Resource::Ore).1, 34 * MILLI);
    assert_eq!(
        w.custody.balance(lot, Resource::Wood).1,
        0,
        "wood to its own place"
    );
    assert_eq!(w.custody.balance(home, Resource::Wood).1, 17 * MILLI);
    assert_eq!(w.custody.balance(cart, Resource::Ore).1, 668);
    assert_eq!(w.custody.balance(home, ARMS).1, 2_666);
    assert_eq!(
        w.custody.balance(home, Resource::Ore).1,
        0,
        "no refund to the output's place"
    );
    // Replayed: nothing moves twice.
    assert_eq!(w.apply(S + 1_400, B, &op), Ok(Outcome::AlreadyApplied));
    let a = w.job(j).unwrap().accounts();
    assert!(a.balanced());
    assert_eq!(a.inputs[0], acct(40 * MILLI, 0, 34_668, 5_332, 0));
    assert_eq!(a.output, acct(2_666, 0, 2_666, 0, 0));
    w.custody.check().unwrap();
}

#[test]
fn a_split_claim_refuses_a_job_place_as_any_destination() {
    let (mut w, j) = fed(Policies::PROVISIONAL);
    w.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    let ok = Place::Caravan(78);
    for bad in [Place::Hopper(j), Place::Output(j)] {
        for op in [
            Op::ClaimSplit {
                job: j,
                output_to: bad,
                refund_to: [ok, ok],
                remainder_to: ok,
            },
            Op::ClaimSplit {
                job: j,
                output_to: ok,
                refund_to: [bad, ok],
                remainder_to: ok,
            },
            Op::ClaimSplit {
                job: j,
                output_to: ok,
                refund_to: [ok, bad],
                remainder_to: ok,
            },
            Op::ClaimSplit {
                job: j,
                output_to: ok,
                refund_to: [ok, ok],
                remainder_to: bad,
            },
        ] {
            assert_eq!(w.apply(S + 1_300, B, &op), Err(CapError::BadPlace));
        }
    }
}

#[test]
fn a_loss_is_recorded_as_forfeited() {
    let (mut w, j) = fed(Policies {
        loss: LossPolicy::CaptorTakesAll,
        ..Policies::PROVISIONAL
    });
    let cap = S + HOUR;
    w.facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    let f = j.grant.facility;
    w.apply(cap, X, &Op::FacilityLost { facility: f }).unwrap();
    let a = w.job(j).unwrap().accounts();
    assert!(a.balanced());
    assert_eq!(a.inputs[0], acct(40 * MILLI, 0, 0, 16 * MILLI, 24 * MILLI));
    assert_eq!(a.output, acct(8 * MILLI, 0, 0, 0, 8 * MILLI));
}

#[test]
fn retiring_logs_the_receipt() {
    let (mut w, j) = fed(Policies::PROVISIONAL);
    w.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    let Outcome::Applied(ev) = w.apply(S + 3 * HOUR, X, &Op::Retire { job: j }).unwrap() else {
        panic!()
    };
    let receipt = ev
        .iter()
        .find_map(|e| match e {
            Event::Receipt { job, accounts, .. } if *job == j => Some(*accounts),
            _ => None,
        })
        .expect("a receipt");
    assert!(receipt.balanced());
    assert_eq!(receipt.inputs[0], acct(40 * MILLI, 0, 0, 40 * MILLI, 0));
    assert_eq!(receipt.inputs[1], acct(20 * MILLI, 0, 0, 20 * MILLI, 0));
    assert_eq!(receipt.output, acct(20 * MILLI, 0, 20 * MILLI, 0, 0));
}

#[test]
fn the_custodys_own_reason_reaches_the_caller() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
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
            units: 1,
            start: S,
            end: S + HOUR,
            max_output: MILLI,
        },
    )
    .unwrap();
    // B's caravan 77 holds nothing.
    let op = Op::Deposit {
        job: j,
        deposit: 1,
        resource: Resource::Ore,
        amount: MILLI,
        from: Place::Caravan(77),
    };
    let before = w.clone();
    assert_eq!(
        w.apply_detailed(T0 + 20, B, &op),
        Err(Refusal {
            code: CapError::Custody,
            custody: Some(CustodyError::Insufficient)
        })
    );
    assert_eq!(w.apply(T0 + 20, B, &op), Err(CapError::Custody));
    assert_eq!(w, before, "nothing changed");
    // A kernel refusal carries no custody reason.
    let late = Op::Reserve {
        job: JobId {
            grant: j.grant,
            seq: 2,
        },
        units: 9,
        start: S,
        end: S + HOUR,
        max_output: MILLI,
    };
    assert_eq!(
        w.apply_detailed(T0 + 20, B, &late),
        Err(Refusal {
            code: CapError::GrantUnitsExceeded,
            custody: None
        })
    );
}
