//! The owner's sub-unit rest, exactly, into their own live vault in the lot's
//! province (`custody::pay_rest_home`; the owner's approval of 2026-11-17).
//! WRITTEN, NOT RUN: new test runs need the coordinator's own approval first.
//! Every figure is worked by hand from `permutation_rules::frontier::custody`
//! (milli-units). A separate file, so `custody_returns.rs` keeps its audited hash.

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

/// The keeper's vault holding the lot (tile 7).
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

/// The owner's own vault in the same province (tile 9), with `ore` milli
/// already in it and `cap` milli of room in all.
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

/// A lot of 40 units filled with 10, one job fed 3 units and finished with
/// 1.25 unused: 1 unit back, 250 milli gathered; then the owner withdraws all
/// that is held. Leaves held 0, pending 0, rest 250, consumed 2,000 (the
/// gathered rest is still CONSUMED).
fn lot_with_rest(v: &mut K::VaultView) -> K::Lot {
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
    assert_eq!((l.held, l.returns.pending, l.returns.rest, l.consumed), (0, 0, 250, 2_000));
    l
}

#[test]
fn the_owner_takes_the_exact_rest_home_and_the_lot_closes() {
    let mut v = keeper_vault();
    let mut l = lot_with_rest(&mut v);
    let mut h = home(5 * MILLI, 50 * MILLI);
    assert!(!l.empty(BELL));
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut h), Ok(250));
    assert_eq!(h.stores[ORE], 5_250, "exactly 250 milli, not rounded");
    assert_eq!((l.returns.rest, l.consumed, l.out_total), (0, 1_750, 8_250));
    assert!(l.balanced(BELL));
    assert_eq!(l.in_total, l.held + l.out_total + l.consumed + l.forfeited, "10,000 = 0 + 8,250 + 1,750");
    // paid once: nothing below a unit is left
    let (lb, hb) = (l, h);
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut h), Ok(0));
    assert_eq!((l, h), (lb, hb));
    assert!(l.empty(BELL));
    K::close(Some(&mut v), &mut l, Some(&act(OWNER)), BELL).unwrap();
}

#[test]
fn a_full_missing_or_stale_home_keeps_the_rest_and_the_lot_open() {
    let mut v = keeper_vault();
    let mut l = lot_with_rest(&mut v);
    let before = l;
    // full: 49,800 + 250 > 50,000
    let mut full = home(49_800, 50 * MILLI);
    let fb = full;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut full), Err(K::CustodyError::Capacity));
    assert_eq!((l, full), (before, fb));
    // room taken by others' lots counts (CUSTODY_QUOTA): 49,000 + 900 quota + 250 > 50,000
    let mut q = home(49 * MILLI, 50 * MILLI);
    q.quota[ORE] = 900;
    let qb = q;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut q), Err(K::CustodyError::Capacity));
    assert_eq!((l, q), (before, qb));
    // closed (not live)
    let mut gone = home(0, 50 * MILLI);
    gone.live = false;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut gone), Err(K::CustodyError::Forfeited));
    // seized: its owner is now the captor
    let mut seized = home(0, 50 * MILLI);
    seized.owner = STRANGER;
    seized.gen = 2;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut seized), Err(K::CustodyError::NotAuthorized));
    // another province, or the lot's own vault's tile
    let mut far = home(0, 50 * MILLI);
    far.q = -3;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut far), Err(K::CustodyError::Order));
    let mut same_tile = home(0, 50 * MILLI);
    same_tile.tile = 7;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut same_tile), Err(K::CustodyError::Order));
    assert_eq!(l, before, "the rest is held, unchanged");
    assert!(!l.empty(BELL), "and the lot stays open");
}

#[test]
fn only_the_owner_by_wallet_and_only_from_a_usable_tracked_lot() {
    let mut v = keeper_vault();
    let mut l = lot_with_rest(&mut v);
    let before = l;
    let mut h = home(0, 50 * MILLI);
    let hb = h;
    for who in [act(KEEPER), act(GRANTEE), act(STRANGER)] {
        assert_eq!(K::pay_rest_home(&v, &mut l, &who, &mut h), Err(K::CustodyError::NotAuthorized));
    }
    let session = K::Actor { by_session: true, ..act(OWNER) };
    assert_eq!(K::pay_rest_home(&v, &mut l, &session, &mut h), Err(K::CustodyError::WalletRequired));
    // another owner's vault is never a destination
    let mut other = home(0, 50 * MILLI);
    other.owner = STRANGER;
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut other), Err(K::CustodyError::NotAuthorized));
    // the lot's vault seized: not usable (the seizure question)
    let mut sv = v;
    sv.gen = 2;
    assert_eq!(K::pay_rest_home(&sv, &mut l, &act(OWNER), &mut h), Err(K::CustodyError::Forfeited));
    assert_eq!((l, h), (before, hb));
    // an untracked lot (written before design A): State
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d[K::layout::lot::RSV..K::layout::lot::SIZE].fill(0);
    let mut old = K::Lot::decode(&d).unwrap();
    assert_eq!(K::pay_rest_home(&v, &mut old, &act(OWNER), &mut h), Err(K::CustodyError::State));
    assert_eq!(h, hb);
}

#[test]
fn whole_units_stay_in_custody_and_only_the_fraction_goes_home() {
    let mut v = keeper_vault();
    let mut l = lot_with_rest(&mut v);
    // a gathered rest of 1,250 (as if a full lot had kept a whole unit): the
    // unit goes back into the lot, only 250 goes home
    l.returns.rest = 1_250;
    let mut h = home(0, 50 * MILLI);
    assert_eq!(K::pay_rest_home(&v, &mut l, &act(OWNER), &mut h), Ok(250));
    assert_eq!((l.held, l.returns.rest, h.stores[ORE]), (MILLI, 0, 250));
    assert!(l.balanced(BELL));
    // a home that refuses undoes the lot's whole-unit return too (all or nothing)
    let mut m = lot_with_rest(&mut v);
    m.returns.rest = 1_250;
    let mb = m;
    let mut full = home(50 * MILLI, 50 * MILLI);
    assert_eq!(K::pay_rest_home(&v, &mut m, &act(OWNER), &mut full), Err(K::CustodyError::Capacity));
    assert_eq!(m, mb);
}
