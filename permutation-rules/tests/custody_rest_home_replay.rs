//! `custody::replay_rest_home`: a pure check of one rest-home step against the
//! kernel (Lane C, 2026-11-17; not wired to any verifier, no record kind).
//! WRITTEN, NOT RUN: new test runs need the coordinator's own approval.
//! A separate file, so the audited `custody_returns.rs` and
//! `custody_rest_home.rs` keep their hashes. Every figure is worked by hand
//! from `permutation_rules::frontier::custody` (milli-units).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;

const OWNER: [u8; 32] = [0xB2; 32];
const KEEPER: [u8; 32] = [0x4B; 32];
const GRANTEE: [u8; 32] = [0xC3; 32];
const STRANGER: [u8; 32] = [0xE5; 32];
const BELL: u32 = 30;
const ORE: usize = Resource::Ore as usize;

fn act(k: [u8; 32]) -> K::Actor {
    K::Actor { citizen: k, tag: k[0] as u64, by_session: false }
}

fn keeper_vault() -> K::VaultView {
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

fn home(ore: i64, cap: i64) -> K::VaultView {
    let mut stores = [0; 8];
    stores[ORE] = ore;
    K::VaultView {
        p: 3,
        q: -2,
        tile: 9,
        gen: 1,
        live: true,
        owner: OWNER,
        owner_tag: 0xB2,
        stores,
        cap,
        quota: [0; 8],
        lots: 0,
    }
}

/// An opened lot of 40 units filled with 10, one job fed 3 units, 1 unit
/// back, 250 milli gathered, then everything held withdrawn: held 0, rest
/// 250, consumed 2,000. `rest` then sets the gathered rest by hand, keeping
/// the books balanced (CONSUMED and IN_TOTAL move with it).
fn lot_with_rest(v: &mut K::VaultView, rest: i64) -> K::Lot {
    let mut l = K::open(v, &act(KEEPER), (OWNER, 0xB2), Resource::Ore as u8, 40 * MILLI, 10, KEEPER).unwrap();
    K::begin_inbound(v, &mut l, (0x77, 1), 10 * MILLI).unwrap();
    K::finish_inbound(Some(&*v), &mut l, (0x77, 1), 10 * MILLI).unwrap();
    let spec = K::OrderSpec {
        kind: K::ORDER_USE,
        grantee: GRANTEE,
        qty: 3 * MILLI,
        expires_bell: 500,
        dst: K::PlaceRef::default(),
        purpose: 0x0901,
    };
    let nonce = l.nonce;
    let id = K::set_order(v, &mut l, &act(OWNER), 0, nonce, &spec, BELL).unwrap();
    K::consume(v, &mut l, &act(GRANTEE), 0, id, 3 * MILLI, 0x0901, BELL).unwrap();
    assert!(K::begin_use(&mut l).unwrap());
    K::return_unused(v, &mut l, MILLI).unwrap();
    K::end_use(v, &mut l, 250).unwrap();
    K::spend_ship(v, &mut l, &act(OWNER), K::By::Owner, 8 * MILLI, K::ShipTo::OwnPlace(v.place()), BELL).unwrap();
    let extra = rest - l.returns.rest;
    l.returns.rest = rest;
    l.consumed += extra;
    l.in_total += extra;
    assert!(l.balanced(BELL));
    l
}

/// The after-states the program would write: the kernel on copies.
fn step(v: &K::VaultView, l: &K::Lot, h: &K::VaultView) -> (i64, K::Lot, K::VaultView) {
    let (mut l2, mut h2) = (*l, *h);
    let paid = K::pay_rest_home(v, &mut l2, &act(OWNER), &mut h2).unwrap();
    (paid, l2, h2)
}

#[test]
fn a_true_step_matches_fraction_whole_and_both() {
    let mut v = keeper_vault();
    let h = home(5 * MILLI, 50 * MILLI);
    // 250: nothing whole, 250 home
    let l = lot_with_rest(&mut v, 250);
    let (_, la, ha) = step(&v, &l, &h);
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, 0, 250, &la, &ha), Ok(K::RestHomeReplay::Match));
    // 1,250: 1,000 back into the lot, 250 home
    let l = lot_with_rest(&mut v, 1_250);
    let (_, la, ha) = step(&v, &l, &h);
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, MILLI, 250, &la, &ha), Ok(K::RestHomeReplay::Match));
    // 2,000: whole > 0 with paid = 0; the lot changes, home does not
    let l = lot_with_rest(&mut v, 2 * MILLI);
    let (paid, la, ha) = step(&v, &l, &h);
    assert_eq!(paid, 0);
    assert_ne!(la, l, "the lot changed with nothing paid home");
    assert_eq!(ha, h, "home unchanged");
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, 2 * MILLI, 0, &la, &ha), Ok(K::RestHomeReplay::Match));
}

#[test]
fn tampered_amounts_get_the_kernels_amounts_back() {
    let mut v = keeper_vault();
    let h = home(0, 50 * MILLI);
    let l = lot_with_rest(&mut v, 1_250);
    let (_, la, ha) = step(&v, &l, &h);
    let truth = Ok(K::RestHomeReplay::Amounts { whole: MILLI, paid: 250 });
    for (w, p) in [(0, 250), (MILLI, 249), (MILLI, 251), (2 * MILLI, 250), (0, 0), (MILLI, 0)] {
        assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, w, p, &la, &ha), truth, "claimed ({w}, {p})");
    }
}

#[test]
fn malformed_claims_are_refused_before_anything() {
    let mut v = keeper_vault();
    let h = home(0, 50 * MILLI);
    let l = lot_with_rest(&mut v, 250);
    let (_, la, ha) = step(&v, &l, &h);
    for (w, p) in [
        (-MILLI, 250),
        (i64::MIN, 250),
        (1_500, 0),
        (MILLI + 1, 0),
        (0, -1),
        (0, MILLI),
        (0, i64::MAX),
        (i64::MAX, 0),
    ] {
        assert_eq!(
            K::replay_rest_home(&v, &l, &act(OWNER), &h, w, p, &la, &ha),
            Err(K::CustodyError::Quantity),
            "claimed ({w}, {p})"
        );
    }
}

#[test]
fn tampered_after_states_are_found() {
    let mut v = keeper_vault();
    let h = home(0, 50 * MILLI);
    let l = lot_with_rest(&mut v, 1_250);
    let (_, la, ha) = step(&v, &l, &h);
    let mut bad_lot = la;
    bad_lot.held += 1;
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, MILLI, 250, &bad_lot, &ha), Ok(K::RestHomeReplay::State));
    let mut bad_rest = la;
    bad_rest.returns.rest = 1;
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, MILLI, 250, &bad_rest, &ha), Ok(K::RestHomeReplay::State));
    let mut bad_home = ha;
    bad_home.stores[ORE] += 1;
    assert_eq!(K::replay_rest_home(&v, &l, &act(OWNER), &h, MILLI, 250, &la, &bad_home), Ok(K::RestHomeReplay::State));
}

#[test]
fn a_step_the_kernel_refuses_is_returned_as_that_refusal() {
    let mut v = keeper_vault();
    let l = lot_with_rest(&mut v, 250);
    let h = home(0, 50 * MILLI);
    let (_, la, ha) = step(&v, &l, &h);
    let r = |v: &K::VaultView, l: &K::Lot, who: &K::Actor, h: &K::VaultView| {
        K::replay_rest_home(v, l, who, h, 0, 250, &la, &ha)
    };
    // another actor, a session key
    assert_eq!(r(&v, &l, &act(STRANGER), &h), Err(K::CustodyError::NotAuthorized));
    assert_eq!(r(&v, &l, &act(KEEPER), &h), Err(K::CustodyError::NotAuthorized));
    let session = K::Actor { by_session: true, ..act(OWNER) };
    assert_eq!(r(&v, &l, &session, &h), Err(K::CustodyError::WalletRequired));
    // another owner's vault, another province, the lot's tile, closed, full
    let mut other = h;
    other.owner = STRANGER;
    assert_eq!(r(&v, &l, &act(OWNER), &other), Err(K::CustodyError::NotAuthorized));
    let mut far = h;
    far.q = -3;
    assert_eq!(r(&v, &l, &act(OWNER), &far), Err(K::CustodyError::Order));
    let mut same_tile = h;
    same_tile.tile = 7;
    assert_eq!(r(&v, &l, &act(OWNER), &same_tile), Err(K::CustodyError::Order));
    let mut closed = h;
    closed.live = false;
    assert_eq!(r(&v, &l, &act(OWNER), &closed), Err(K::CustodyError::Forfeited));
    let full = home(50 * MILLI, 50 * MILLI);
    assert_eq!(r(&v, &l, &act(OWNER), &full), Err(K::CustodyError::Capacity));
    // the lot's vault seized
    let mut seized = v;
    seized.gen = 2;
    assert_eq!(r(&seized, &l, &act(OWNER), &h), Err(K::CustodyError::Forfeited));
    // a lot written before design A (untracked)
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d[K::layout::lot::RSV..K::layout::lot::SIZE].fill(0);
    let old = K::Lot::decode(&d).unwrap();
    assert_eq!(r(&v, &old, &act(OWNER), &h), Err(K::CustodyError::State));
}

#[test]
fn a_repeated_step_matches_only_as_a_no_op() {
    let mut v = keeper_vault();
    let h = home(0, 50 * MILLI);
    let l = lot_with_rest(&mut v, 250);
    let (_, la, ha) = step(&v, &l, &h);
    // replayed on the after-states: the kernel pays 0 and changes nothing
    assert_eq!(K::replay_rest_home(&v, &la, &act(OWNER), &ha, 0, 0, &la, &ha), Ok(K::RestHomeReplay::Match));
    // a second payment claimed is refused with the kernel's amounts
    assert_eq!(
        K::replay_rest_home(&v, &la, &act(OWNER), &ha, 0, 250, &la, &ha),
        Ok(K::RestHomeReplay::Amounts { whole: 0, paid: 0 })
    );
}

#[test]
fn nothing_given_to_the_check_changes() {
    let mut v = keeper_vault();
    let h = home(0, 50 * MILLI);
    let l = lot_with_rest(&mut v, 1_250);
    let (_, la, ha) = step(&v, &l, &h);
    let snapshot = (v, l, h, la, ha);
    let _ = K::replay_rest_home(&v, &l, &act(OWNER), &h, MILLI, 250, &la, &ha);
    let _ = K::replay_rest_home(&v, &l, &act(OWNER), &h, -1, 0, &la, &ha);
    let _ = K::replay_rest_home(&v, &l, &act(STRANGER), &h, MILLI, 250, &la, &ha);
    assert_eq!((v, l, h, la, ha), snapshot);
}
