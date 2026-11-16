//! Design A (the owner's approval of 2026-11-17; a preview, not adopted): a
//! lot that may still receive a return from a workstream 9 job does not
//! close; pending jobs and sub-unit rests are kept on the lot, released once.
//! WRITTEN, NOT RUN (all new test runs were paused when this was written):
//! paper cases until the coordinator lets them run. Every figure is worked by
//! hand from `permutation_rules::frontier::custody` (milli-units).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;

const OWNER: [u8; 32] = [0xB2; 32];
const KEEPER: [u8; 32] = [0x4B; 32];
const GRANTEE: [u8; 32] = [0xC3; 32];
const BELL: u32 = 30;
const PURPOSE: u16 = 0x0901;

fn act(k: [u8; 32]) -> K::Actor {
    K::Actor { citizen: k, tag: k[0] as u64, by_session: false }
}

fn view() -> K::VaultView {
    K::VaultView {
        p: 3,
        q: -2,
        tile: 7,
        gen: 1,
        live: true,
        owner: KEEPER,
        owner_tag: 0x4B,
        stores: [0; 8],
        cap: 100 * MILLI,
        quota: [0; 8],
        lots: 0,
    }
}

/// An opened lot of `quota` units, filled with `fill` units by one caravan.
fn lot(v: &mut K::VaultView, quota: i64, fill: i64) -> K::Lot {
    let mut l = K::open(v, &act(KEEPER), (OWNER, 0xB2), Resource::Ore as u8, quota * MILLI, 10, KEEPER).unwrap();
    K::begin_inbound(v, &mut l, (0x77, 1), fill * MILLI).unwrap();
    K::finish_inbound(Some(&*v), &mut l, (0x77, 1), fill * MILLI).unwrap();
    l
}

/// A use order of `qty` units in `slot`, consumed whole by the grantee, and
/// the job counted (`begin_use`), as DepositToJob does.
fn feed(v: &K::VaultView, l: &mut K::Lot, slot: u8, qty: i64) {
    let spec = K::OrderSpec {
        kind: K::ORDER_USE,
        grantee: GRANTEE,
        qty: qty * MILLI,
        expires_bell: 500,
        dst: K::PlaceRef::default(),
        purpose: PURPOSE,
    };
    let id = K::set_order(v, l, &act(OWNER), slot, l.nonce, &spec, BELL).unwrap();
    K::consume(v, l, &act(GRANTEE), slot, id, qty * MILLI, PURPOSE, BELL).unwrap();
    assert!(K::begin_use(l).unwrap(), "a tracked lot counts the job");
}

fn withdraw(v: &K::VaultView, l: &mut K::Lot, qty: i64) -> Result<(), K::CustodyError> {
    K::spend_ship(v, l, &act(OWNER), K::By::Owner, qty * MILLI, K::ShipTo::OwnPlace(v.place()), BELL)
}

fn bytes(l: &K::Lot) -> Vec<u8> {
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d
}

#[test]
fn a_lot_waiting_for_a_return_does_not_close_and_closes_once_every_return_is_in() {
    let mut v = view();
    let mut l = lot(&mut v, 40, 30);
    feed(&v, &mut l, 0, 10); // job A
    feed(&v, &mut l, 1, 2); // job B
    assert_eq!((l.held, l.consumed, l.returns.pending), (18 * MILLI, 12 * MILLI, 2));
    withdraw(&v, &mut l, 18).unwrap();
    // held 0, both orders spent (freed), nothing inbound: empty before design A
    assert_eq!(l.held, 0);
    assert!(!l.empty(BELL), "two jobs may still give ore back");
    let before = l;
    assert_eq!(K::close(Some(&mut v), &mut l, Some(&act(OWNER)), BELL), Err(K::CustodyError::NotEmpty));
    assert_eq!(l, before, "refused: unchanged");
    assert_eq!(K::close(Some(&mut v), &mut l, Some(&act(KEEPER)), BELL), Err(K::CustodyError::NotEmpty), "nor by the keeper");

    // job A ends with 4.5 unused: whole 4 back, the rest 500 gathered, A released once
    K::return_unused(&v, &mut l, 4 * MILLI).unwrap();
    assert_eq!(K::end_use(&v, &mut l, 500), Ok(0));
    assert_eq!((l.held, l.consumed, l.returns.pending, l.returns.rest), (4 * MILLI, 8 * MILLI, 1, 500));
    // job B ends with 0.5 unused: the rests make a whole unit, paid back
    assert_eq!(K::end_use(&v, &mut l, 500), Ok(MILLI));
    assert_eq!((l.held, l.consumed, l.returns.pending, l.returns.rest), (5 * MILLI, 7 * MILLI, 0, 0));
    assert!(l.balanced(BELL));
    assert_eq!(l.in_total, l.held + l.out_total + l.consumed + l.forfeited, "30 = 5 + 18 + 7");
    withdraw(&v, &mut l, 5).unwrap();
    assert!(l.empty(BELL));
    K::close(Some(&mut v), &mut l, Some(&act(OWNER)), BELL).unwrap();
    assert_eq!(l.state, K::LOT_NONE);
}

#[test]
fn a_rest_below_a_unit_keeps_the_lot_open_never_rounded() {
    let mut v = view();
    let mut l = lot(&mut v, 40, 10);
    feed(&v, &mut l, 0, 3);
    K::return_unused(&v, &mut l, MILLI).unwrap();
    K::end_use(&v, &mut l, 250).unwrap();
    withdraw(&v, &mut l, 8).unwrap();
    assert_eq!((l.held, l.returns.pending, l.returns.rest), (0, 0, 250));
    assert!(!l.empty(BELL), "250 milli are still the owner's");
    assert_eq!(K::close(Some(&mut v), &mut l, Some(&act(OWNER)), BELL), Err(K::CustodyError::NotEmpty));
    assert_eq!(l.returns.rest, 250, "not dropped, not rounded");
}

#[test]
fn released_once_refusals_change_nothing() {
    let mut v = view();
    let mut l = lot(&mut v, 40, 10);
    feed(&v, &mut l, 0, 2);
    let before = l;
    for bad in [-1, MILLI, MILLI + 1, i64::MAX] {
        assert_eq!(K::end_use(&v, &mut l, bad), Err(K::CustodyError::Quantity), "rest {bad}");
        assert_eq!(l, before);
    }
    K::end_use(&v, &mut l, 0).unwrap();
    let once = l;
    assert_eq!(K::end_use(&v, &mut l, 0), Err(K::CustodyError::State), "a second release");
    assert_eq!(l, once);
    // a rest above what the lot has consumed
    let mut m = lot(&mut v, 40, 10);
    feed(&v, &mut m, 0, 1);
    K::return_unused(&v, &mut m, MILLI).unwrap(); // consumed 0
    let b = m;
    assert_eq!(K::end_use(&v, &mut m, 1), Err(K::CustodyError::Quantity));
    assert_eq!(m, b);
}

#[test]
fn a_full_lot_keeps_the_rest_until_the_owner_makes_room() {
    let mut v = view();
    let mut l = lot(&mut v, 10, 10);
    feed(&v, &mut l, 0, 1);
    feed(&v, &mut l, 1, 1);
    K::begin_inbound(&v, &mut l, (0x77, 2), 2 * MILLI).unwrap();
    K::finish_inbound(Some(&v), &mut l, (0x77, 2), 2 * MILLI).unwrap();
    assert_eq!(l.held, 10 * MILLI, "full");
    assert_eq!(K::end_use(&v, &mut l, 600), Ok(0));
    assert_eq!(K::end_use(&v, &mut l, 600), Ok(0), "1200 gathered, no room for the unit");
    assert_eq!((l.returns.pending, l.returns.rest), (0, 1_200));
    assert_eq!(K::pay_rest(&v, &mut l), Ok(0));
    // the owner's withdrawal makes room: the unit comes back in the same step
    withdraw(&v, &mut l, 1).unwrap();
    assert_eq!((l.held, l.returns.rest, l.consumed), (10 * MILLI, 200, MILLI));
    assert!(l.balanced(BELL));
}

#[test]
fn a_seized_lot_keeps_its_count() {
    let mut v = view();
    let mut l = lot(&mut v, 40, 10);
    feed(&v, &mut l, 0, 2);
    let mut seized = v;
    seized.gen = 2;
    let before = l;
    assert_eq!(K::end_use(&seized, &mut l, 0), Err(K::CustodyError::Forfeited));
    assert_eq!(K::pay_rest(&seized, &mut l), Err(K::CustodyError::Forfeited));
    assert_eq!(l, before, "the count and the rest stay (a seizure's effect is undecided)");
    K::forfeit(&mut seized, &mut l).unwrap();
    assert_eq!(l.returns.pending, 1);
    assert!(!l.empty(BELL), "a forfeited lot with a pending return does not close");
    assert_eq!(K::close(None, &mut l, None, BELL), Err(K::CustodyError::NotEmpty));
}

#[test]
fn a_lot_written_before_is_untracked_and_never_closes() {
    let mut v = view();
    let l = lot(&mut v, 40, 10);
    let mut d = bytes(&l);
    d[K::layout::lot::RSV..K::layout::lot::SIZE].fill(0); // as written before design A
    let mut old = K::Lot::decode(&d).unwrap();
    assert!(!old.returns.tracked);
    assert_eq!((old.returns.pending, old.returns.rest), (0, 0));
    withdraw(&v, &mut old, 10).unwrap();
    assert!(!old.empty(BELL), "zero bytes are not \"no pending returns\": unknown");
    assert_eq!(K::close(Some(&mut v), &mut old, Some(&act(OWNER)), BELL), Err(K::CustodyError::NotEmpty));
    assert_eq!(K::begin_use(&mut old), Ok(false), "cannot count a job");
    assert_eq!(K::end_use(&v, &mut old, 0), Err(K::CustodyError::State));
    assert_eq!(K::pay_rest(&v, &mut old), Err(K::CustodyError::State));
    // written again, it stays untracked (never upgraded by a write)
    let again = bytes(&old);
    assert!(again[K::layout::lot::RSV..K::layout::lot::SIZE].iter().all(|b| *b == 0));
    assert!(!K::Lot::decode(&again).unwrap().returns.tracked);
}

#[test]
fn unknown_reserved_bytes_are_not_a_lot_and_a_bad_record_is_not_written() {
    let mut v = view();
    let l = lot(&mut v, 40, 10);
    let mut d = bytes(&l);
    d[K::layout::lot::RSV] ^= 0xFF; // neither the tag nor all zero
    assert_eq!(K::Lot::decode(&d), None);
    // an untracked lot with returns cannot be encoded, and `d` is not touched
    let mut bad = l;
    bad.returns = K::Returns { tracked: false, pending: 1, rest: 0 };
    let mut out = vec![0xAAu8; K::layout::lot::SIZE];
    assert_eq!(bad.encode(&mut out), None);
    assert!(out.iter().all(|b| *b == 0xAA), "refused before any byte is written");
    // a tracked lot round-trips with its record
    let mut t = l;
    t.returns = K::Returns { tracked: true, pending: 3, rest: 999 };
    t.consumed = 5 * MILLI;
    assert_eq!(K::Lot::decode(&bytes(&t)), Some(t));
}

#[test]
fn a_failing_rest_payout_leaves_the_send_undone() {
    // A gathered rest above CONSUMED cannot come from the kernel; a corrupt
    // record would make the payout refuse (Quantity), and the owner's send
    // must then leave the lot exactly as it was (no half-spent lot).
    let mut v = view();
    let mut l = lot(&mut v, 40, 10);
    l.returns.rest = 2 * MILLI; // consumed is 0
    let before = l;
    assert_eq!(withdraw(&v, &mut l, 3), Err(K::CustodyError::Quantity));
    assert_eq!(l, before);
}
