//! ReturnUnused: ore a use order let out and the user did not use comes
//! back into its lot as un-consumed, not as a new arrival (no double
//! count of the same goods as used and as received).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::Resource;
use wylls_custody::lot::*;

const KEEPER: [u8; 32] = [0x4B; 32];
const M: [u8; 32] = [0x4D; 32];
const B: [u8; 32] = [0xB2; 32];
const ORE: u8 = Resource::Ore as u8;

fn act(k: [u8; 32]) -> Actor {
    Actor {
        citizen: k,
        tag: k[0] as u64,
        by_session: false,
    }
}

fn vault() -> VaultView {
    VaultView {
        p: 0,
        q: 0,
        tile: 5,
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

/// M's lot (quota 50) holding 40, a use order of 30 for B, 20 consumed.
fn used() -> (VaultView, Lot, u32) {
    let mut v = vault();
    let mut l = open(&mut v, &act(KEEPER), (M, 0x4D), ORE, 50 * MILLI, 0, KEEPER).unwrap();
    begin_inbound(&v, &mut l, (7, 1), 40 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut l, (7, 1), 40 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B,
        qty: 30 * MILLI,
        expires_bell: 100,
        dst: PlaceRef::default(),
        purpose: 0x0901,
    };
    let id = set_order(&v, &mut l, &act(M), 0, 0, &spec, 1).unwrap();
    consume(&v, &mut l, &act(B), 0, id, 20 * MILLI, 0x0901, 2).unwrap();
    (v, l, id)
}

#[test]
fn a_return_un_consumes_and_does_not_count_the_goods_in_again() {
    let (v, mut l, _) = used();
    let before = l;
    return_unused(&v, &mut l, 7 * MILLI).unwrap();
    assert_eq!(l.held, before.held + 7 * MILLI);
    assert_eq!(l.consumed, before.consumed - 7 * MILLI);
    assert_eq!(l.in_total, before.in_total, "IN_TOTAL does not move");
    assert_eq!(l.out_total, before.out_total);
    assert!(l.balanced(3));
    // The order is not restored: the use happened, only less of it.
    assert_eq!(l.orders[0].qty_left, before.orders[0].qty_left);
    // The rest of what was consumed can come back too, and no more.
    return_unused(&v, &mut l, 13 * MILLI).unwrap();
    assert_eq!(
        (l.consumed, l.held, l.in_total),
        (0, 40 * MILLI, 40 * MILLI)
    );
    assert_eq!(
        return_unused(&v, &mut l, MILLI),
        Err(CustodyError::Quantity)
    );
}

#[test]
fn a_return_is_whole_units_within_what_was_used_and_the_lots_room() {
    let (v, l0, _) = used();
    for (q, want) in [
        (0, CustodyError::Quantity),
        (1_500, CustodyError::Quantity),
        (21 * MILLI, CustodyError::Quantity),
    ] {
        let mut l = l0;
        assert_eq!(return_unused(&v, &mut l, q), Err(want), "{q}");
        assert_eq!(l, l0);
    }
    // Room: quota 50, held 20; a caravan expected with 25 leaves room 5.
    let mut l = l0;
    begin_inbound(&v, &mut l, (8, 1), 25 * MILLI).unwrap();
    let before = l;
    assert_eq!(
        return_unused(&v, &mut l, 6 * MILLI),
        Err(CustodyError::Capacity)
    );
    assert_eq!(l, before);
    return_unused(&v, &mut l, 5 * MILLI).unwrap();
    assert!(l.balanced(3));
}

#[test]
fn a_frozen_lot_takes_nothing_back() {
    let (mut v, l0, _) = used();
    v.gen = 2;
    v.owner = [0xEE; 32];
    let mut l = l0;
    assert_eq!(
        return_unused(&v, &mut l, MILLI),
        Err(CustodyError::Forfeited)
    );
    assert_eq!(l, l0);
}
