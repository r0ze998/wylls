//! T5: 09's bridge and 10's `connect` (workstream 10's own connection of
//! 09's kernel to its lots, `wylls_custody_adapter_09::connect`) on the
//! same one lot table.
//!
//! 10's differential test (`adapter-09/diff-bridge10`) compares its
//! `connect` with 09's bridge at 992f4ba5, which still had its own lot
//! table. Since 06c817cc both run on 10's `LotCustody`, so the whole state
//! can be compared: the same steps from the same state, and after each the
//! same outcome and an equal harness (09's facilities, ledger, events and
//! clock, and 10's custody: every lot's account bytes, vaults, uses, owed
//! and returned totals).
//!
//! 10's `connect` has `Hold` and `ToUser` only; the comparison runs under
//! both. What only one side does is pinned in
//! `the_two_connections_differ_only_where_listed`, so a change on either
//! side shows here. Nothing here decides an open question.

use borsh::BorshDeserialize;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;
use wylls_capacity_bridge10 as nine;
use wylls_custody::{
    begin_inbound, finish_inbound, open, set_order, CustodyError, OrderSpec, PlaceRef, VaultView,
    ORDER_USE,
};
use wylls_custody_adapter_09::connect::{self as ten, ConnError, Connected};
use wylls_custody_adapter_09::{vault_id, LotCustody, Refusal};

const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const S: i64 = T0 + HOUR;

/// The same start for both: A's facility, B's grant, B's wood, and M's lot
/// of 100 ore in V's vault at (p, q) with a use order of 80 for B.
fn start(p: i16, q: i16) -> (nine::Bridge, nine::LotId, u32, GrantId) {
    let (w, f) = world_with(LotCustody::new(), 3, 2, 2, Policies::PROVISIONAL);
    let mut b = nine::Bridge::new(w, T0);
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
            200 * MILLI,
        )
        .unwrap();
    let bell = b.bell(T0);
    let mut v = VaultView {
        p,
        q,
        tile: 6,
        gen: 1,
        live: true,
        owner: V.0,
        owner_tag: nine::tag_of(V),
        stores: [0; 8],
        cap: 5_000 * MILLI,
        quota: [0; 8],
        lots: 0,
    };
    let mut lot = open(
        &mut v,
        &nine::actor10(V),
        (M.0, nine::tag_of(M)),
        Resource::Ore as u8,
        200 * MILLI,
        bell,
        [0; 32],
    )
    .unwrap();
    begin_inbound(&v, &mut lot, (nine::tag_of(M), 1), 100 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut lot, (nine::tag_of(M), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B.0,
        qty: 80 * MILLI,
        expires_bell: bell + 30,
        dst: PlaceRef::default(),
        purpose: nine::PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &nine::actor10(M), 0, nonce, &spec, bell).unwrap();
    let id = b.add_lot(v, lot);
    (
        b,
        id,
        order,
        GrantId {
            facility: f,
            seq: 1,
        },
    )
}

fn pair(hold: bool) -> (nine::Bridge, Connected, nine::LotId, u32, GrantId) {
    let (mut b, id, order, g) = start(SITE_A.p, SITE_A.q);
    let mut c = Connected::new(b.cap.clone(), T0);
    if hold {
        b.release = nine::Release::Hold;
        c.release = ten::Release::Hold;
    } else {
        b.release = nine::Release::ToUser;
        c.release = ten::Release::ToUser;
    }
    (b, c, id, order, g)
}

#[derive(Debug, PartialEq, Eq)]
enum R {
    Applied(usize),
    Already,
    Cap(CapError),
    Lot(CustodyError),
    Conflict,
    Held,
    Other(String),
}

fn from_nine(r: Result<Outcome, nine::BridgeError>) -> R {
    match r {
        Ok(Outcome::Applied(e)) => R::Applied(e.len()),
        Ok(Outcome::AlreadyApplied) => R::Already,
        Err(nine::BridgeError::Capacity(e)) => R::Cap(e),
        Err(nine::BridgeError::Custody(e)) => R::Lot(e),
        Err(nine::BridgeError::Conflict) => R::Conflict,
        Err(nine::BridgeError::OwnershipUndecided) => R::Held,
        Err(e) => R::Other(format!("{e:?}")),
    }
}

fn from_ten(r: Result<Outcome, ConnError>) -> R {
    match r {
        Ok(Outcome::Applied(e)) => R::Applied(e.len()),
        Ok(Outcome::AlreadyApplied) => R::Already,
        Err(ConnError::Capacity(e)) => R::Cap(e),
        Err(ConnError::Custody(Refusal::Lot(e))) => R::Lot(e),
        // 09's bridge reports 09's own refusal inside 10's release step as
        // a conflict (the deposit id is not usable).
        Err(ConnError::Custody(Refusal::Nine(_))) | Err(ConnError::Conflict) => R::Conflict,
        Err(ConnError::OwnershipUndecided) => R::Held,
        Err(e) => R::Other(format!("{e:?}")),
    }
}

fn same(b: &nine::Bridge, c: &Connected, ctx: &str) {
    assert!(b.cap == c.w, "{ctx}: the harness and 10's custody differ");
    let uses: Vec<_> = c.w.custody.uses.keys().copied().collect();
    let links: Vec<_> = b.links.keys().copied().collect();
    assert_eq!(links, uses, "{ctx}: 09's links and 10's uses");
    b.check(b.cap.clock)
        .unwrap_or_else(|e| panic!("{ctx}: bridge {e}"));
    c.w.custody
        .check()
        .unwrap_or_else(|e| panic!("{ctx}: 10's custody {e}"));
}

#[test]
fn the_bridge_and_10s_connect_agree_step_by_step_on_one_lot_table() {
    let seeds: u64 = std::env::var("DIFF_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1_000);
    let mut steps = [0u64; 11];
    let (mut fed, mut held, mut refused, mut frozen) = (0u64, 0u64, 0u64, 0u64);
    for seed in 0..seeds {
        let mut g = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rnd = |n: u64| {
            g ^= g << 13;
            g ^= g >> 7;
            g ^= g << 17;
            g % n.max(1)
        };
        let hold = rnd(4) != 0;
        let (mut b, mut c, lot, order, gr) = pair(hold);
        let vid = vault_id(lot.p, lot.q, lot.tile);
        same(&b, &c, &format!("seed {seed} start"));
        let mut next = 1u32;
        let mut now = T0 + 20;
        let mut last = (1u64, 1u32, JobId { grant: gr, seq: 1 });
        let mut seized = false;
        for step in 0..60 {
            now += rnd(600) as i64;
            let k = rnd(11) as usize;
            steps[k] += 1;
            let job = JobId {
                grant: gr,
                seq: 1 + rnd(next as u64) as u32,
            };
            let (rb, rc) = match k {
                0 => {
                    let st = now + 60 + rnd(2 * HOUR as u64) as i64;
                    let op = Op::Reserve {
                        job: JobId {
                            grant: gr,
                            seq: next,
                        },
                        units: 1 + rnd(2) as u32,
                        start: st,
                        end: st + (1 + rnd(3) as i64) * HOUR,
                        max_output: (1 + rnd(15) as i64) * MILLI,
                    };
                    let r = (
                        from_nine(b.apply(now, B, &op)),
                        from_ten(c.apply(now, B, &op)),
                    );
                    if matches!(r.0, R::Applied(_)) {
                        next += 1;
                    }
                    r
                }
                1 | 2 => {
                    last = (1 + rnd(4), 1 + rnd(15) as u32, job);
                    (
                        from_nine(b.deposit_from_lot(now, B, job, last.0, lot, 0, order, last.1)),
                        from_ten(c.deposit_from_lot(now, B, job, last.0, vid, M, 0, order, last.1)),
                    )
                }
                3 => {
                    let (d, u, j) = last;
                    (
                        from_nine(b.deposit_from_lot(now, B, j, d, lot, 0, order, u)),
                        from_ten(c.deposit_from_lot(now, B, j, d, vid, M, 0, order, u)),
                    )
                }
                4 => {
                    let op = Op::Deposit {
                        job,
                        deposit: 10 + rnd(3),
                        resource: Resource::Wood,
                        amount: (1 + rnd(6) as i64) * MILLI,
                        from: Place::Caravan(77),
                    };
                    (
                        from_nine(b.apply(now, B, &op)),
                        from_ten(c.apply(now, B, &op)),
                    )
                }
                5 | 6 => {
                    let op = Op::Settle { job };
                    (
                        from_nine(b.apply(now, X, &op)),
                        from_ten(c.apply(now, X, &op)),
                    )
                }
                7 => {
                    let op = Op::Cancel { job };
                    (
                        from_nine(b.apply(now, B, &op)),
                        from_ten(c.apply(now, B, &op)),
                    )
                }
                8 => {
                    let op = Op::Claim {
                        job,
                        to: Place::Caravan(78),
                    };
                    (
                        from_nine(b.apply(now, B, &op)),
                        from_ten(c.apply(now, B, &op)),
                    )
                }
                9 => {
                    // 10's S1 seizure of M's vault: the lot is frozen.
                    if !seized && rnd(5) == 0 {
                        b.cap.custody.seize_vault(vid, X).unwrap();
                        c.w.custody.seize_vault(vid, X).unwrap();
                        seized = true;
                    }
                    (R::Already, R::Already)
                }
                _ => {
                    b = nine::Bridge::load(&b.save()).expect("the bridge restarts");
                    c = Connected::try_from_slice(&borsh::to_vec(&c).unwrap()).unwrap();
                    (R::Already, R::Already)
                }
            };
            let ctx = format!("seed {seed} step {step} kind {k}");
            assert_eq!(rb, rc, "{ctx}: outcome");
            match (k, &rb) {
                (1 | 2, R::Applied(_)) => fed += 1,
                (1 | 2, R::Lot(_)) if seized => frozen += 1,
                (8, R::Held) => held += 1,
                (_, R::Cap(_) | R::Lot(_) | R::Conflict) => refused += 1,
                _ => {}
            }
            same(&b, &c, &ctx);
        }
    }
    eprintln!(
        "T5: seeds {seeds}; steps by kind (reserve, lot deposit x2, resend, wood, settle x2, cancel, claim, seize, restart) {steps:?}; lot deposits applied {fed}, claims held {held}, lot deposits refused while frozen {frozen}, refusals {refused}"
    );
    assert!(fed >= seeds / 2 && held >= seeds / 4 && frozen >= seeds / 20 && refused >= seeds);
}

/// Where the two connections answer differently, each on its own fresh
/// pair (both sides start equal). These are the T5 differences; none is
/// decided here.
#[test]
fn the_two_connections_differ_only_where_listed() {
    let reserve = |job| Op::Reserve {
        job,
        units: 2,
        start: S,
        end: S + 3 * HOUR,
        max_output: 20 * MILLI,
    };
    let j = |g| JobId { grant: g, seq: 1 };

    // 1. Own ore into a job fed from a lot (MixedSource): 09 refuses, 10's
    //    connect takes it (the mixed case is undecided; 09 asks first).
    let (mut b, mut c, lot, order, g) = pair(false);
    let vid = vault_id(lot.p, lot.q, lot.tile);
    b.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    c.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    let own_ore = Key {
        scope: 79,
        kind: 100,
        n: 0,
    };
    let at = Place::Caravan(79);
    b.cap
        .custody
        .import(own_ore, at, B, Resource::Ore, 10 * MILLI)
        .unwrap();
    c.w.custody
        .import(own_ore, at, B, Resource::Ore, 10 * MILLI)
        .unwrap();
    b.deposit_from_lot(T0 + 20, B, j(g), 1, lot, 0, order, 10)
        .unwrap();
    c.deposit_from_lot(T0 + 20, B, j(g), 1, vid, M, 0, order, 10)
        .unwrap();
    let own = Op::Deposit {
        job: j(g),
        deposit: 2,
        resource: Resource::Ore,
        amount: 5 * MILLI,
        from: Place::Caravan(79),
    };
    assert_eq!(
        b.apply(T0 + 30, B, &own),
        Err(nine::BridgeError::MixedSource)
    );
    assert!(matches!(c.apply(T0 + 30, B, &own), Ok(Outcome::Applied(_))));

    // 2. A lot outside the facility's province (TooFar, the owner's
    //    decision D6): 09 refuses, 10's connect takes it.
    let (mut b, id, order, g) = start(SITE_A.p + 3, SITE_A.q);
    b.release = nine::Release::ToUser;
    let mut c = Connected::new(b.cap.clone(), T0);
    c.release = ten::Release::ToUser;
    let vid = vault_id(id.p, id.q, id.tile);
    b.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    c.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    assert_eq!(
        b.deposit_from_lot(T0 + 20, B, j(g), 1, id, 0, order, 10),
        Err(nine::BridgeError::TooFar)
    );
    assert!(matches!(
        c.deposit_from_lot(T0 + 20, B, j(g), 1, vid, M, 0, order, 10),
        Ok(Outcome::Applied(_))
    ));

    // 3. The owner's decided claim (D1, D2): 09's default; 10's connect has
    //    no such release (it holds or gives everything to the user).
    let (b, _, _, _) = start(SITE_A.p, SITE_A.q);
    assert_eq!(b.release, nine::Release::Decided);
    assert_eq!(
        Connected::new(b.cap.clone(), T0).release,
        ten::Release::Hold
    );

    // 4. A resend of a deposit by someone else with the same terms: both
    //    refuse and change nothing, with different reasons (09: its
    //    kernel's NotUser, as for its own deposits; 10: a conflict with the
    //    recorded use, whose grantee is B).
    let (mut b, mut c, lot, order, g) = pair(true);
    let vid = vault_id(lot.p, lot.q, lot.tile);
    b.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    c.apply(T0 + 10, B, &reserve(j(g))).unwrap();
    b.deposit_from_lot(T0 + 20, B, j(g), 1, lot, 0, order, 10)
        .unwrap();
    c.deposit_from_lot(T0 + 20, B, j(g), 1, vid, M, 0, order, 10)
        .unwrap();
    let rb = from_nine(b.deposit_from_lot(T0 + 30, C, j(g), 1, lot, 0, order, 10));
    let rc = from_ten(c.deposit_from_lot(T0 + 30, C, j(g), 1, vid, M, 0, order, 10));
    assert_eq!((rb, rc), (R::Cap(CapError::NotUser), R::Conflict));
    same(&b, &c, "after a stranger's resend");
}
