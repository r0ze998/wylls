//! V26's history check (custody seasons): a Lot account's recorded
//! changes, compared pairwise. What every custody step keeps is judged; a
//! change that breaks it is a FAIL at the transaction that recorded it.
//! The season stays not-PASS (no replay of the instructions themselves).

mod common;

use common::*;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;
use verify_core::checks::v26_custody::{lot_transition_findings, lot_transition_unexplained};
use verify_core::codes::*;
use verify_core::{Input, Verdict};

const OWNER: [u8; 32] = [0xB2; 32];
const KEEPER: [u8; 32] = [0x4B; 32];
const GRANTEE: [u8; 32] = [0xC3; 32];
const KEY: [u8; 32] = [0xD1; 32];

fn act(k: [u8; 32]) -> K::Actor {
    K::Actor {
        citizen: k,
        tag: k[0] as u64,
        by_session: false,
    }
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

fn bytes(l: &K::Lot) -> Vec<u8> {
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d
}

/// A lot's states as the kernel writes them: opened, filled, an order,
/// a use, a return of unused goods, a caravan expected and settled.
fn kernel_states() -> Vec<K::Lot> {
    let mut v = view();
    let mut l = K::open(
        &mut v,
        &act(KEEPER),
        (OWNER, 0xB2),
        Resource::Ore as u8,
        40 * MILLI,
        10,
        KEEPER,
    )
    .unwrap();
    let mut out = vec![l];
    K::begin_inbound(&v, &mut l, (0x77, 1), 30 * MILLI).unwrap();
    out.push(l);
    K::finish_inbound(Some(&v), &mut l, (0x77, 1), 30 * MILLI).unwrap();
    out.push(l);
    let spec = K::OrderSpec {
        kind: K::ORDER_USE,
        grantee: GRANTEE,
        qty: 20 * MILLI,
        expires_bell: 500,
        dst: K::PlaceRef::default(),
        purpose: 0x0901,
    };
    K::set_order(&v, &mut l, &act(OWNER), 0, 0, &spec, 20).unwrap();
    out.push(l);
    K::consume(&v, &mut l, &act(GRANTEE), 0, 0, 15 * MILLI, 0x0901, 30).unwrap();
    out.push(l);
    K::return_unused(&v, &mut l, 6 * MILLI).unwrap();
    out.push(l);
    K::spend_ship(
        &v,
        &mut l,
        &act(OWNER),
        K::By::Owner,
        5 * MILLI,
        K::ShipTo::OwnPlace(v.place()),
        40,
    )
    .unwrap();
    out.push(l);
    out
}

/// A custody season whose landed transactions record `states` of one lot,
/// in order (one state per transaction). Returns the input and the
/// transactions' signatures.
fn recorded(states: &[Vec<u8>]) -> (Input, Vec<String>) {
    let mut inp = march();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V4;
    let program = inp.cfg.program;
    let landed: Vec<usize> = inp
        .txs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.err.is_none())
        .map(|(i, _)| i)
        .collect();
    assert!(landed.len() >= states.len());
    let mut sigs = vec![];
    for (d, t) in states.iter().zip(landed) {
        inp.txs[t].post.push((
            fclient::Address::new_from_array(KEY),
            Some(fclient::ports::Account {
                lamports: 1,
                data: d.clone(),
                owner: program,
                executable: false,
            }),
        ));
        sigs.push(inp.txs[t].signature.to_string());
    }
    (inp, sigs)
}

/// V26's own findings, sorted: (code, FAIL?, entity, detail, signature).
/// The fixture (`march`) already FAILs elsewhere (V11: six bad placements),
/// so the report's verdict says nothing about custody; these do.
fn v26(r: &verify_core::Report) -> Vec<(String, bool, String, String, String)> {
    let mut v: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.check == "V26")
        .map(|f| {
            (
                f.code.clone(),
                f.fail(),
                f.entity.clone(),
                f.detail.clone(),
                f.signature.clone(),
            )
        })
        .collect();
    v.sort();
    v
}

/// The verdict custody alone would give (V26's findings only).
fn custody_verdict(r: &verify_core::Report) -> Verdict {
    let f = r.findings.iter().filter(|f| f.check == "V26");
    if f.clone().any(|f| f.fail()) {
        Verdict::Fail
    } else if f.count() > 0 {
        Verdict::Unverifiable
    } else {
        Verdict::Pass
    }
}

fn account(k: u8) -> String {
    format!("account:{}", fclient::Address::new_from_array([k; 32]))
}

/// The UNVERIFIABLE trace V26 gives a Lot in a transaction's post-state.
fn unverified_after(sig: &str) -> (String, bool, String, String, String) {
    (
        CUSTODY_UNVERIFIED.to_string(),
        false,
        account(0xD1),
        "a Lot account after it: custody is not verified (V26 does not replay the caravans' routes or the records yet)".to_string(),
        sig.to_string(),
    )
}

fn history_fails(r: &verify_core::Report) -> Vec<(String, String)> {
    r.findings
        .iter()
        .filter(|f| f.check == "V26" && f.code == CUSTODY_HISTORY_BROKEN)
        .map(|f| (f.signature.clone(), f.detail.clone()))
        .collect()
}

#[test]
fn the_kernels_own_history_never_fails_and_a_return_stays_unverifiable() {
    let states: Vec<Vec<u8>> = kernel_states().iter().map(bytes).collect();
    for w in states.windows(2) {
        assert!(
            lot_transition_findings(&w[0], &w[1]).is_empty(),
            "{:?}",
            lot_transition_findings(&w[0], &w[1])
        );
    }
    let (inp, sigs) = recorded(&states);
    let r = verify_core::verify(&inp);
    assert!(r.checks_run.contains(&"V26:custody-history"));
    // One trace per recorded state, no FAIL, and one UNVERIFIABLE note:
    // the return of unused goods (state 5) lowers CONSUMED, which no record
    // shows yet; custody UNVERIFIABLE.
    let mut want: Vec<_> = sigs.iter().map(|s| unverified_after(s)).collect();
    want.push((
        CUSTODY_HISTORY_UNEXPLAINED.to_string(),
        false,
        account(0xD1),
        format!(
            "CONSUMED fell by {}: a return of unused goods, which no record shows yet",
            6 * MILLI
        ),
        sigs[5].clone(),
    ));
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
}

#[test]
fn a_change_no_custody_step_makes_fails_at_its_transaction() {
    let s = kernel_states();
    let base = s[4]; // after the use: an order set, goods consumed
    type Forge = fn(&mut K::Lot);
    let cases: [(&str, Forge); 8] = [
        ("IN_TOTAL went down", |l| {
            l.in_total -= MILLI;
            l.held -= MILLI;
        }),
        ("OUT_TOTAL went down", |l| {
            l.out_total -= MILLI;
            l.held += MILLI;
        }),
        ("NONCE went down", |l| l.nonce = 0),
        ("the owner changed", |l| l.owner = [0xEE; 32]),
        ("the vault generation changed", |l| l.vault_gen = 2),
        ("a forfeited lot reopened", |l| l.state = K::LOT_OPEN),
        ("an order changed its grantee", |l| {
            l.orders[0].grantee = [0x77; 32]
        }),
        ("an order grew", |l| {
            l.orders[0].qty_left += MILLI;
        }),
    ];
    for (name, forge) in cases {
        let mut prev = base;
        if name == "a forfeited lot reopened" {
            prev.state = K::LOT_FORFEITED;
        }
        let mut cur = base;
        forge(&mut cur);
        let (inp, sigs) = recorded(&[bytes(&prev), bytes(&cur)]);
        let r = verify_core::verify(&inp);
        let f = history_fails(&r);
        assert!(
            f.iter().any(|(sig, _)| *sig == sigs[1]),
            "{name}: {}",
            show(&r)
        );
        assert!(r.fails_with(CUSTODY_HISTORY_BROKEN), "{name}");
    }
}

#[test]
fn an_expected_caravan_keeps_its_quantity() {
    let s = kernel_states();
    let prev = s[1]; // a caravan expected
    let mut cur = prev;
    cur.inbound[0].qty += MILLI;
    assert!(!lot_transition_findings(&bytes(&prev), &bytes(&cur)).is_empty());
}

#[test]
fn a_closed_lot_opened_again_is_a_new_lot() {
    let mut v = view();
    let mut l = K::open(
        &mut v,
        &act(KEEPER),
        (OWNER, 0xB2),
        Resource::Ore as u8,
        40 * MILLI,
        10,
        KEEPER,
    )
    .unwrap();
    K::begin_inbound(&v, &mut l, (1, 1), 5 * MILLI).unwrap();
    K::finish_inbound(Some(&v), &mut l, (1, 1), 5 * MILLI).unwrap();
    K::spend_ship(
        &v,
        &mut l,
        &act(OWNER),
        K::By::Owner,
        5 * MILLI,
        K::ShipTo::OwnPlace(v.place()),
        11,
    )
    .unwrap();
    K::close(Some(&mut v), &mut l, Some(&act(OWNER)), 12).unwrap();
    let fresh = K::open(
        &mut v,
        &act(KEEPER),
        (OWNER, 0xB2),
        Resource::Ore as u8,
        40 * MILLI,
        13,
        KEEPER,
    )
    .unwrap();
    assert!(lot_transition_findings(&bytes(&l), &bytes(&fresh)).is_empty());
}

/// Random kernel runs, every consecutive pair of states: never a finding
/// (the check must not fail what the program writes).
#[test]
fn random_kernel_histories_never_fail() {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let mut pairs = 0u64;
    for _ in 0..300 {
        let mut v = view();
        let mut l = K::open(
            &mut v,
            &act(KEEPER),
            (OWNER, 0xB2),
            Resource::Ore as u8,
            40 * MILLI,
            0,
            KEEPER,
        )
        .unwrap();
        let (mut bell, mut seq) = (1u32, 1u32);
        for _ in 0..60 {
            let prev = bytes(&l);
            bell += rnd(30) as u32;
            let q = (1 + rnd(8) as i64) * MILLI;
            let _ = match rnd(8) {
                0 => {
                    seq += 1;
                    K::begin_inbound(&v, &mut l, (0x70, seq), q)
                }
                1 => match l
                    .inbound
                    .iter()
                    .find(|i| i.live)
                    .map(|i| (i.caravan_tag, i.seq, i.qty))
                {
                    Some((t, s, sent)) => K::finish_inbound(
                        Some(&v),
                        &mut l,
                        (t, s),
                        sent - (rnd(2) as i64 * MILLI).min(sent),
                    )
                    .map(|_| ()),
                    None => Ok(()),
                },
                2 => {
                    let spec = K::OrderSpec {
                        kind: K::ORDER_USE,
                        grantee: GRANTEE,
                        qty: q,
                        expires_bell: bell + 1 + rnd(200) as u32,
                        dst: K::PlaceRef::default(),
                        purpose: 0,
                    };
                    let n = l.nonce;
                    K::set_order(&v, &mut l, &act(OWNER), rnd(4) as u8, n, &spec, bell).map(|_| ())
                }
                3 => {
                    let s = rnd(4) as u8;
                    let o = l.orders[s as usize];
                    K::consume(
                        &v,
                        &mut l,
                        &act(GRANTEE),
                        s,
                        o.id,
                        q.min(o.qty_left.max(MILLI)),
                        0,
                        bell,
                    )
                }
                4 => K::return_unused(&v, &mut l, q),
                5 => {
                    let s = rnd(4) as u8;
                    let o = l.orders[s as usize];
                    K::revoke_order(&mut l, &act(OWNER), s, o.id, bell).map(|_| ())
                }
                6 => K::spend_ship(
                    &v,
                    &mut l,
                    &act(OWNER),
                    K::By::Owner,
                    q,
                    K::ShipTo::OwnPlace(v.place()),
                    bell,
                ),
                _ => match l
                    .inbound
                    .iter()
                    .find(|i| i.live)
                    .map(|i| (i.caravan_tag, i.seq))
                {
                    Some(c) => K::drop_inbound(&mut l, c, K::CaravanSeen::Absent).map(|_| ()),
                    None => Ok(()),
                },
            };
            let cur = bytes(&l);
            assert!(
                lot_transition_findings(&prev, &cur).is_empty(),
                "{:?}",
                lot_transition_findings(&prev, &cur)
            );
            pairs += 1;
        }
        // A seizure and the proposed forfeiture at the end, then a close.
        let prev = bytes(&l);
        let mut s = v;
        s.gen = 2;
        s.owner = [0xEE; 32];
        if K::forfeit(&mut s, &mut l).is_ok() {
            assert!(lot_transition_findings(&prev, &bytes(&l)).is_empty());
        }
    }
    assert!(pairs >= 18_000);
}

#[test]
fn order_bookkeeping_that_no_step_makes_fails() {
    let s = kernel_states();
    let prev = s[4]; // after the use: order id 0 set, NONCE 1
    type Forge = fn(&mut K::Lot);
    let cases: [(&str, Forge); 3] = [
        ("a new order with an id from before", |l| {
            l.orders[1] = l.orders[0];
            l.orders[1].id = 0;
            l.orders[1].qty_left = MILLI;
            l.nonce += 1;
        }),
        ("two new orders, NONCE moved by one", |l| {
            let o = K::Order {
                kind: K::ORDER_USE,
                id: 1,
                qty_left: MILLI,
                grantee: GRANTEE,
                expires_bell: 500,
                ..Default::default()
            };
            l.orders[1] = o;
            l.orders[2] = K::Order { id: 2, ..o };
            l.nonce += 1;
        }),
        ("goods used that no order gave", |l| {
            l.consumed += 2 * MILLI;
            l.held -= 2 * MILLI;
        }),
    ];
    for (name, forge) in cases {
        let mut cur = prev;
        forge(&mut cur);
        assert!(
            !lot_transition_findings(&bytes(&prev), &bytes(&cur)).is_empty(),
            "{name}"
        );
        let (inp, sigs) = recorded(&[bytes(&prev), bytes(&cur)]);
        let r = verify_core::verify(&inp);
        assert!(
            history_fails(&r).iter().any(|(sig, _)| *sig == sigs[1]),
            "{name}: {}",
            show(&r)
        );
    }
}

#[test]
fn goods_in_without_a_caravan_to_explain_them_are_unverifiable_not_fail() {
    let s = kernel_states();
    let prev = s[6];
    let mut cur = prev;
    cur.in_total += 3 * MILLI;
    cur.held += 3 * MILLI;
    assert!(lot_transition_findings(&bytes(&prev), &bytes(&cur)).is_empty());
    assert_eq!(
        lot_transition_unexplained(&bytes(&prev), &bytes(&cur)).len(),
        1
    );
    let (inp, sigs) = recorded(&[bytes(&prev), bytes(&cur)]);
    let r = verify_core::verify(&inp);
    // The two traces and one unexplained change, at the transaction that
    // recorded it, with its amounts; no FAIL; custody UNVERIFIABLE.
    let mut want = vec![
        unverified_after(&sigs[0]),
        unverified_after(&sigs[1]),
        (
            CUSTODY_HISTORY_UNEXPLAINED.to_string(),
            false,
            account(0xD1),
            format!(
                "IN_TOTAL grew by {}; the caravans settled since could deliver 0",
                3 * MILLI
            ),
            sigs[1].clone(),
        ),
    ];
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
}

/// Several kernel steps between two recorded states (a transaction with
/// many instructions, or states not recorded): the FAIL rules must still
/// never fire on what the program writes.
#[test]
fn composed_kernel_steps_never_fail() {
    let mut x: u64 = 0x2545_F491_4F6C_DD1D;
    let mut rnd = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let (mut windows, mut unexplained) = (0u64, 0u64);
    for _ in 0..300 {
        let mut v = view();
        let mut l = K::open(
            &mut v,
            &act(KEEPER),
            (OWNER, 0xB2),
            Resource::Ore as u8,
            40 * MILLI,
            0,
            KEEPER,
        )
        .unwrap();
        let (mut bell, mut seq) = (1u32, 1u32);
        for _ in 0..30 {
            let prev = bytes(&l);
            for _ in 0..1 + rnd(4) {
                bell += rnd(30) as u32;
                let q = (1 + rnd(8) as i64) * MILLI;
                let _ = match rnd(8) {
                    0 => {
                        seq += 1;
                        K::begin_inbound(&v, &mut l, (0x70, seq), q)
                    }
                    1 => match l
                        .inbound
                        .iter()
                        .find(|i| i.live)
                        .map(|i| (i.caravan_tag, i.seq, i.qty))
                    {
                        Some((t, s, sent)) => K::finish_inbound(
                            Some(&v),
                            &mut l,
                            (t, s),
                            sent - (rnd(2) as i64 * MILLI).min(sent),
                        )
                        .map(|_| ()),
                        None => Ok(()),
                    },
                    2 => {
                        let spec = K::OrderSpec {
                            kind: if rnd(3) == 0 {
                                K::ORDER_SHIP
                            } else {
                                K::ORDER_USE
                            },
                            grantee: GRANTEE,
                            qty: q,
                            expires_bell: bell + 1 + rnd(200) as u32,
                            dst: K::PlaceRef::vault(9, 9, 1, 1),
                            purpose: 0,
                        };
                        let n = l.nonce;
                        K::set_order(&v, &mut l, &act(OWNER), rnd(4) as u8, n, &spec, bell)
                            .map(|_| ())
                    }
                    3 => {
                        let s = rnd(4) as u8;
                        let o = l.orders[s as usize];
                        K::consume(
                            &v,
                            &mut l,
                            &act(GRANTEE),
                            s,
                            o.id,
                            q.min(o.qty_left.max(MILLI)),
                            0,
                            bell,
                        )
                    }
                    4 => K::return_unused(&v, &mut l, q),
                    5 => {
                        let s = rnd(4) as u8;
                        let o = l.orders[s as usize];
                        K::revoke_order(&mut l, &act(OWNER), s, o.id, bell).map(|_| ())
                    }
                    6 => {
                        let s = rnd(4) as u8;
                        let o = l.orders[s as usize];
                        K::spend_ship(
                            &v,
                            &mut l,
                            &act(GRANTEE),
                            K::By::Order { slot: s, id: o.id },
                            q.min(o.qty_left.max(MILLI)),
                            K::ShipTo::Lot(o.dst),
                            bell,
                        )
                    }
                    _ => K::spend_ship(
                        &v,
                        &mut l,
                        &act(OWNER),
                        K::By::Owner,
                        q,
                        K::ShipTo::OwnPlace(v.place()),
                        bell,
                    ),
                };
            }
            let cur = bytes(&l);
            assert!(
                lot_transition_findings(&prev, &cur).is_empty(),
                "{:?}",
                lot_transition_findings(&prev, &cur)
            );
            unexplained += !lot_transition_unexplained(&prev, &cur).is_empty() as u64;
            windows += 1;
        }
    }
    println!(
        "composed windows {windows}, unexplained (begun and settled inside one) {unexplained}"
    );
    assert!(windows >= 9_000);
}

/// A lowered CONSUMED (a return of unused goods: workstream 9's workshop
/// claim through the kernel's `return_unused`) has no record kind yet, so
/// it is never judged good: UNVERIFIABLE at the transaction that shows it,
/// alone or after a use, never a FAIL and never a PASS.
#[test]
fn a_lowered_consumed_total_is_unverifiable_never_a_pass() {
    let s = kernel_states();
    let (used, returned) = (s[4], s[5]);
    assert!(returned.consumed < used.consumed);
    assert_eq!(
        lot_transition_unexplained(&bytes(&used), &bytes(&returned)),
        vec![format!(
            "CONSUMED fell by {}: a return of unused goods, which no record shows yet",
            used.consumed - returned.consumed
        )]
    );
    assert!(lot_transition_findings(&bytes(&used), &bytes(&returned)).is_empty());
    let (inp, sigs) = recorded(&[bytes(&used), bytes(&returned)]);
    let r = verify_core::verify(&inp);
    let notes: Vec<_> = v26(&r)
        .into_iter()
        .filter(|f| f.0 == CUSTODY_HISTORY_UNEXPLAINED)
        .collect();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(!notes[0].1);
    assert_eq!(notes[0].4, sigs[1]);
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
    // The same lot without the return: no note.
    let (inp, _) = recorded(&[bytes(&used), bytes(&used)]);
    let r = verify_core::verify(&inp);
    assert!(v26(&r).iter().all(|f| f.0 != CUSTODY_HISTORY_UNEXPLAINED));
}
