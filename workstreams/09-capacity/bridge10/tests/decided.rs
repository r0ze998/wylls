//! The owner's decisions of 2026-11-06 for jobs fed from another owner's
//! lot (`Release::Decided`, the default): the products are the user's, the
//! ore left unused goes back into its lot (whole units at once, the
//! sub-unit rest owed until it makes whole units), a lot is used directly
//! only from the facility's province, and a captor takes what is at the
//! facility (09's loss rule, unchanged).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity_bridge10::*;
use wylls_custody::{
    begin_inbound, finish_inbound, open, set_order, OrderSpec, PlaceRef, VaultView, ORDER_USE,
};
use wylls_custody_adapter_09::LotCustody;

const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const S: i64 = T0 + HOUR;
const HOME: Place = Place::Caravan(78);

/// M's lot of 100 ore (quota 200) in V's vault at (p, q, tile 6), with a
/// use order of 80 for B.
fn m_lot(b: &mut Bridge, p: i16, q: i16) -> (LotId, u32) {
    let bell = b.bell(T0);
    let mut v = VaultView {
        p,
        q,
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
        qty: 80 * MILLI,
        expires_bell: bell + 500,
        dst: PlaceRef::default(),
        purpose: PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &actor10(M), 0, nonce, &spec, bell).unwrap();
    let id = LotId::of(&lot);
    b.vaults.insert((v.p, v.q, v.tile), v);
    b.lots.insert(id, lot);
    (id, order)
}

/// A's facility, B's grant; B's wood (caravan 77); job `seq`: 2 copies,
/// 20 arms over [start, start + 3 h).
fn setup() -> (Bridge, GrantId) {
    let (w, f) = world_with(LotCustody::new(), 3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    assert_eq!(
        b.release,
        Release::Decided,
        "the decided rule is the default"
    );
    b.cap
        .custody
        .import(
            Key {
                scope: 77,
                kind: 100,
                n: 1,
            },
            Place::Caravan(77),
            B,
            Resource::Wood,
            100 * MILLI,
        )
        .unwrap();
    (
        b,
        GrantId {
            facility: f,
            seq: 1,
        },
    )
}

fn job(b: &mut Bridge, g: GrantId, seq: u32, start: i64) -> JobId {
    let j = JobId { grant: g, seq };
    b.apply(
        start - HOUR,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start,
            end: start + 3 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    j
}

fn wood(b: &mut Bridge, j: JobId, n: u64, at: i64) {
    b.apply(
        at,
        B,
        &Op::Deposit {
            job: j,
            deposit: n,
            resource: Resource::Wood,
            amount: 20 * MILLI,
            from: Place::Caravan(77),
        },
    )
    .unwrap();
}

#[test]
fn products_go_to_the_user_and_unused_ore_back_to_the_lot() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 0, 0);
    let j = job(&mut b, g, 1, S);
    b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40)
        .unwrap();
    wood(&mut b, j, 2, T0 + 20);
    // Stopped at 2,666 milli arms: 34.668 ore and 17.334 wood unused.
    b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    b.apply(S + 1_300, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    // B: the arms and B's own wood (whole and rest).
    assert_eq!(b.cap.custody.balance(HOME, ARMS), (Some(B), 2_666));
    assert_eq!(b.cap.custody.balance(HOME, Resource::Wood).1, 17_334);
    assert_eq!(
        b.cap.custody.balance(HOME, Resource::Ore).1,
        0,
        "no ore to B"
    );
    // M's lot: 34 whole units back; 0.668 owed.
    let l = b.lots[&lot];
    assert_eq!((l.held, l.consumed), (94 * MILLI, 40 * MILLI));
    assert_eq!(b.returned[&lot], 34 * MILLI);
    assert_eq!(b.owed[&lot], 668);
    assert!(
        l.inbound.iter().all(|i| !i.live),
        "no reservation left behind"
    );
    b.check(S + 1_300).unwrap();
    // A resent claim moves nothing.
    assert_eq!(
        b.apply(S + 1_400, B, &Op::Claim { job: j, to: HOME }),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(b.lots[&lot], l);
}

#[test]
fn rests_owed_to_a_lot_add_up_to_whole_units() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 0, 0);
    for (n, start) in [(1u32, S), (2, S + 4 * HOUR)] {
        let j = job(&mut b, g, n, start);
        b.deposit_from_lot(start - HOUR + 10, B, j, 1, lot, 0, order, 40)
            .unwrap();
        wood(&mut b, j, 2, start - HOUR + 10);
        b.apply(start + 1_200, B, &Op::Cancel { job: j }).unwrap();
        b.apply(start + 1_300, B, &Op::Claim { job: j, to: HOME })
            .unwrap();
    }
    // 2 × 34.668 = 69.336: 69 whole units back, 0.336 owed.
    assert_eq!(b.returned[&lot], 69 * MILLI);
    assert_eq!(b.owed[&lot], 336);
    assert_eq!(b.lots[&lot].held, (100 - 80 + 69) * MILLI);
    b.check(S + 6 * HOUR).unwrap();
}

#[test]
fn a_split_claim_sends_the_users_goods_where_asked_and_the_ore_to_its_lot() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 0, 0);
    let j = job(&mut b, g, 1, S);
    b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40)
        .unwrap();
    wood(&mut b, j, 2, T0 + 20);
    b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    let (arms_to, wood_to, rest_to) = (Place::Caravan(81), Place::Caravan(82), Place::Caravan(83));
    // The ore place asked for is not used: the ore is M's and goes home.
    let op = Op::ClaimSplit {
        job: j,
        output_to: arms_to,
        refund_to: [Place::Caravan(84), wood_to],
        remainder_to: rest_to,
    };
    b.apply(S + 1_300, B, &op).unwrap();
    assert_eq!(b.cap.custody.balance(arms_to, ARMS).1, 2_666);
    assert_eq!(b.cap.custody.balance(wood_to, Resource::Wood).1, 17 * MILLI);
    assert_eq!(b.cap.custody.balance(rest_to, Resource::Wood).1, 334);
    assert_eq!(
        b.cap.custody.balance(Place::Caravan(84), Resource::Ore).1,
        0
    );
    assert_eq!(b.returned[&lot], 34 * MILLI);
    b.check(S + 1_300).unwrap();
}

#[test]
fn a_lot_outside_the_facilitys_province_is_too_far() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 1, -1);
    let j = job(&mut b, g, 1, S);
    let before = b.lots[&lot];
    assert_eq!(
        b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40),
        Err(BridgeError::TooFar)
    );
    assert_eq!(b.lots[&lot], before);
    assert_eq!(b.cap.job(j).unwrap().hopper, [0, 0]);
}

#[test]
fn a_captor_takes_what_is_at_the_facility_and_nothing_returns() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 0, 0);
    let j = job(&mut b, g, 1, S);
    b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40)
        .unwrap();
    wood(&mut b, j, 2, T0 + 20);
    let cap = S + HOUR;
    b.cap
        .facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    b.apply(
        cap,
        X,
        &Op::FacilityLost {
            facility: g.facility,
        },
    )
    .unwrap();
    // The captor holds the arms made and the unused ore (M's) and wood (B's).
    assert_eq!(
        b.cap.custody.balance(Place::Holding(SITE_A), ARMS),
        (Some(X), 8 * MILLI)
    );
    assert_eq!(
        b.cap.custody.balance(Place::Holding(SITE_A), Resource::Ore),
        (Some(X), 24 * MILLI)
    );
    // Nothing goes back to M, nothing is owed, and B has nothing to claim.
    assert_eq!(
        b.apply(cap + 1, B, &Op::Claim { job: j, to: HOME }),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(b.lots[&lot].held, 60 * MILLI, "100 less the 40 taken");
    assert!(b.returned.is_empty() && b.owed.values().all(|x| *x == 0));
    b.check(cap + 1).unwrap();
}

#[test]
fn a_frozen_lot_keeps_its_ore_owed_until_it_can_take_it() {
    let (mut b, g) = setup();
    let (lot, order) = m_lot(&mut b, 0, 0);
    let j = job(&mut b, g, 1, S);
    b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40)
        .unwrap();
    wood(&mut b, j, 2, T0 + 20);
    b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    // M's vault is seized: the lot is frozen (10 refuses every move).
    b.vaults.get_mut(&(0, 0, 6)).unwrap().gen = 2;
    let held = b.lots[&lot].held;
    b.apply(S + 1_300, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(
        b.cap.custody.balance(HOME, ARMS).1,
        2_666,
        "the user's products still go out"
    );
    assert_eq!(b.lots[&lot].held, held);
    assert_eq!(b.owed[&lot], 34_668, "all of it owed, nothing lost");
    b.check(S + 1_300).unwrap();
}

#[test]
fn a_restart_between_claim_steps_changes_nothing() {
    let run = |restart: bool| {
        let (mut b, g) = setup();
        let (lot, order) = m_lot(&mut b, 0, 0);
        let j = job(&mut b, g, 1, S);
        b.deposit_from_lot(T0 + 20, B, j, 1, lot, 0, order, 40)
            .unwrap();
        wood(&mut b, j, 2, T0 + 20);
        b.apply(S + HOUR, X, &Op::Settle { job: j }).unwrap();
        if restart {
            b = Bridge::load(&b.save()).unwrap();
        }
        b.apply(S + HOUR + 60, B, &Op::Cancel { job: j }).unwrap();
        if restart {
            b = Bridge::load(&b.save()).unwrap();
        }
        b.apply(S + HOUR + 120, B, &Op::Claim { job: j, to: HOME })
            .unwrap();
        b
    };
    let (once, again) = (run(false), run(true));
    assert_eq!(once, again);
    once.check(S + HOUR + 120).unwrap();
}
