//! 09's jobs on workstream 10's custody (`LotCustody`): a user's own lot
//! feeds a job and takes its unused ore back in whole units, the job's
//! accounts agree with 10's notes, a job may mix its own lot with another
//! owner's lot, and 10's refusal reaches the caller.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, CustodyError, Key};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Accounts, Op, Outcome, Refusal};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;
use wylls_capacity_bridge10::*;
use wylls_custody::{
    begin_inbound, finish_inbound, open, set_order, OrderSpec, PlaceRef, VaultView, ORDER_USE,
};
use wylls_custody_adapter_09::{LotCustody, Note};

const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const S: i64 = T0 + HOUR;
/// B's own lot: vault 7 of keeper V, in the facility's province.
const VAULT: u64 = 7;
const LOT: Place = Place::Vault(VAULT);

fn caravan(cu: &mut LotCustody, user: Actor, id: u64, r: Resource, units: i64) {
    cu.import(
        Key {
            scope: id,
            kind: 100,
            n: r as u64,
        },
        Place::Caravan(id),
        user,
        r,
        units * MILLI,
    )
    .unwrap();
}

/// A's facility (3 copies, 2 lent); B's lot of 100 ore in V's vault 7;
/// B's job: 2 copies, 20 arms over [S, S + 3 h).
fn setup(release: Release) -> (Bridge, JobId) {
    let mut cu = LotCustody::new();
    cu.add_vault(VAULT, 0, 0, 5, V, 5_000 * MILLI);
    cu.open_lot(VAULT, V, B, Resource::Ore, 200 * MILLI)
        .unwrap();
    cu.import(
        Key {
            scope: 1,
            kind: 100,
            n: 0,
        },
        LOT,
        B,
        Resource::Ore,
        100 * MILLI,
    )
    .unwrap();
    let (w, f) = world_with(cu, 3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    b.release = release;
    let job = JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq: 1,
    };
    b.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    caravan(&mut b.cap.custody, B, 77, Resource::Wood, 20);
    b.cap.custody.take_notes();
    (b, job)
}

fn deposit(
    b: &mut Bridge,
    job: JobId,
    n: u64,
    r: Resource,
    units: i64,
    from: Place,
) -> Result<Outcome, BridgeError> {
    b.apply(
        T0 + 20,
        B,
        &Op::Deposit {
            job,
            deposit: n,
            resource: r,
            amount: units * MILLI,
            from,
        },
    )
}

fn lot_held(b: &Bridge) -> i64 {
    b.cap
        .custody
        .lot(VAULT, B, Resource::Ore as u8)
        .unwrap()
        .held
}

fn receipt(ev: &[Event], j: JobId) -> Accounts {
    ev.iter()
        .find_map(|e| match e {
            Event::Receipt { job, accounts, .. } if *job == j => Some(*accounts),
            _ => None,
        })
        .expect("receipt")
}

#[test]
fn own_lot_ore_comes_back_in_whole_units_and_the_rest_elsewhere() {
    let (mut b, j) = setup(Release::Hold);
    deposit(&mut b, j, 1, Resource::Ore, 40, LOT).unwrap();
    deposit(&mut b, j, 2, Resource::Wood, 20, Place::Caravan(77)).unwrap();
    assert_eq!(lot_held(&b), 60 * MILLI);
    assert_eq!(
        b.cap.custody.return_room(VAULT, B, Resource::Ore),
        40 * MILLI,
        "room kept for the return"
    );
    // Stopped at 2,666 milli arms: 34.668 ore unused.
    b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    // A job of B's own goods is not held (no other owner's lot fed it).
    let claim = Op::ClaimSplit {
        job: j,
        output_to: Place::Caravan(78),
        refund_to: [LOT, Place::Caravan(78)],
        remainder_to: Place::Caravan(78),
    };
    b.apply(S + 1_300, B, &claim).unwrap();
    assert_eq!(lot_held(&b), 94 * MILLI, "34 whole units back into the lot");
    assert_eq!(
        b.cap.custody.balance(Place::Caravan(78), Resource::Ore).1,
        668
    );
    assert_eq!(b.cap.custody.balance(Place::Caravan(78), ARMS).1, 2_666);
    assert_eq!(
        b.cap.custody.return_room(VAULT, B, Resource::Ore),
        0,
        "the reservation ended once"
    );
    let notes = b.cap.custody.take_notes();
    assert!(
        notes.iter().any(
            |n| matches!(n, Note::Returned { qty, covered, released, .. }
        if *qty == 34 * MILLI && *covered == 34 * MILLI && *released == 6 * MILLI)
        ),
        "{notes:?}"
    );
    b.check(S + 1_300).unwrap();
}

#[test]
fn a_plain_claim_into_the_lot_is_refused_whole() {
    // 10's lots take whole units only and no arms: the one-place claim of
    // fractional ore and arms into the lot is refused, nothing moves.
    let (mut b, j) = setup(Release::Hold);
    deposit(&mut b, j, 1, Resource::Ore, 40, LOT).unwrap();
    deposit(&mut b, j, 2, Resource::Wood, 20, Place::Caravan(77)).unwrap();
    b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    let before = b.clone();
    let r = b
        .cap
        .apply_detailed(S + 1_300, B, &Op::Claim { job: j, to: LOT });
    assert!(
        matches!(
            r,
            Err(Refusal {
                code: CapError::Custody,
                custody: Some(_)
            })
        ),
        "{r:?}"
    );
    assert_eq!(b, before);
}

#[test]
fn the_receipt_agrees_with_10s_notes() {
    let (mut b, j) = setup(Release::Hold);
    deposit(&mut b, j, 1, Resource::Ore, 40, LOT).unwrap();
    deposit(&mut b, j, 2, Resource::Wood, 20, Place::Caravan(77)).unwrap();
    for t in [S + 999, S + 5_001, S + 3 * HOUR] {
        b.apply(t, X, &Op::Settle { job: j }).unwrap();
    }
    b.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    let Outcome::Applied(ev) = b.apply(S + 3 * HOUR, X, &Op::Retire { job: j }).unwrap() else {
        panic!()
    };
    let a = receipt(&ev, j);
    assert!(a.balanced());
    let notes = b.cap.custody.take_notes();
    let sum = |f: &dyn Fn(&Note) -> Option<i64>| notes.iter().filter_map(f).sum::<i64>();
    let consumed_ore = sum(&|n| match n {
        Note::Consumed { job, r, qty } if *job == j && *r == Resource::Ore as u8 => Some(*qty),
        _ => None,
    });
    let produced = sum(&|n| match n {
        Note::Produced { job, qty, .. } if *job == j => Some(*qty),
        _ => None,
    });
    let reserved = sum(&|n| match n {
        Note::Reserved { job, qty, .. } if *job == j => Some(*qty),
        _ => None,
    });
    assert_eq!(consumed_ore, a.inputs[0].consumed);
    assert_eq!(produced, a.output.in_total);
    assert_eq!(reserved, 40 * MILLI);
    // Used up: the return room was released (emptied), never left behind.
    assert_eq!(b.cap.custody.return_room(VAULT, B, Resource::Ore), 0);
    b.check(S + 3 * HOUR).unwrap();
}

/// M's lot of 100 ore in V's vault on tile 6 of the facility's province, with a use order
/// of 60 for B (the bridge's path for another owner's goods).
fn add_m_lot(b: &mut Bridge) -> (LotId, u32) {
    let bell = b.bell(T0);
    let mut v = VaultView {
        p: 0,
        q: 0,
        tile: 6,
        gen: 1,
        live: true,
        owner: V.0,
        owner_tag: tag_of(V),
        stores: [0; 8],
        cap: 5_000 * MILLI,
        quota: [0; 8],
        lots: 0,
    };
    let mut lot = open(
        &mut v,
        &actor10(V),
        (M.0, tag_of(M)),
        Resource::Ore as u8,
        200 * MILLI,
        bell,
        [0; 32],
    )
    .unwrap();
    begin_inbound(&v, &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B.0,
        qty: 60 * MILLI,
        expires_bell: bell + 500,
        dst: PlaceRef::default(),
        purpose: PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &actor10(M), 0, nonce, &spec, bell).unwrap();
    let id = b.add_lot(v, lot);
    (id, order)
}

#[test]
fn a_job_takes_its_ore_from_one_source_only() {
    // Own ore first, then another's lot: refused, nothing consumed.
    let (mut b, j) = setup(Release::Decided);
    let (m_lot, order) = add_m_lot(&mut b);
    deposit(&mut b, j, 1, Resource::Ore, 20, LOT).unwrap();
    let before = b.lot(m_lot).unwrap();
    assert_eq!(
        b.deposit_from_lot(T0 + 20, B, j, 2, m_lot, 0, order, 20),
        Err(BridgeError::MixedSource)
    );
    assert_eq!(b.lot(m_lot).unwrap(), before);
    // Another's lot first, then own ore (from a lot or a caravan): refused.
    let (mut b, j) = setup(Release::Decided);
    let (m_lot, order) = add_m_lot(&mut b);
    b.deposit_from_lot(T0 + 20, B, j, 1, m_lot, 0, order, 20)
        .unwrap();
    assert_eq!(
        deposit(&mut b, j, 2, Resource::Ore, 20, LOT),
        Err(BridgeError::MixedSource)
    );
    caravan(&mut b.cap.custody, B, 90, Resource::Ore, 5);
    assert_eq!(
        deposit(&mut b, j, 3, Resource::Ore, 5, Place::Caravan(90)),
        Err(BridgeError::MixedSource)
    );
    // Wood is the user's own in any case.
    deposit(&mut b, j, 4, Resource::Wood, 20, Place::Caravan(77)).unwrap();
    assert_eq!(b.cap.job(j).unwrap().hopper, [20 * MILLI, 20 * MILLI]);
    b.check(T0 + 20).unwrap();
}

#[test]
fn a_restart_mid_run_on_10s_custody_changes_nothing() {
    let run = |restart: bool| {
        let (mut b, j) = setup(Release::Hold);
        deposit(&mut b, j, 1, Resource::Ore, 40, LOT).unwrap();
        deposit(&mut b, j, 2, Resource::Wood, 20, Place::Caravan(77)).unwrap();
        b.apply(S + HOUR, X, &Op::Settle { job: j }).unwrap();
        if restart {
            b = Bridge::load(&b.save()).unwrap();
        }
        b.apply(S + HOUR + 60, B, &Op::Cancel { job: j }).unwrap();
        let claim = Op::ClaimSplit {
            job: j,
            output_to: Place::Caravan(78),
            refund_to: [LOT, Place::Caravan(79)],
            remainder_to: Place::Caravan(79),
        };
        b.apply(S + HOUR + 120, B, &claim).unwrap();
        // Every operation sent again after the run moves nothing.
        assert_eq!(
            b.apply(S + HOUR + 180, B, &claim),
            Ok(Outcome::AlreadyApplied)
        );
        let again = Op::Deposit {
            job: j,
            deposit: 1,
            resource: Resource::Ore,
            amount: 40 * MILLI,
            from: LOT,
        };
        assert_eq!(
            b.apply(S + HOUR + 180, B, &again),
            Ok(Outcome::AlreadyApplied)
        );
        b
    };
    let (once, again) = (run(false), run(true));
    assert_eq!(once, again);
    once.check(S + HOUR + 180).unwrap();
}

#[test]
fn a_seized_vault_refuses_with_10s_reason() {
    let (mut b, j) = setup(Release::Hold);
    b.cap.custody.seize_vault(VAULT, X).unwrap();
    let before = b.clone();
    let op = Op::Deposit {
        job: j,
        deposit: 1,
        resource: Resource::Ore,
        amount: 10 * MILLI,
        from: LOT,
    };
    let r = b.cap.apply_detailed(T0 + 20, B, &op);
    assert_eq!(
        r,
        Err(Refusal {
            code: CapError::Custody,
            custody: Some(CustodyError::Forbidden)
        })
    );
    assert_eq!(b, before);
}
