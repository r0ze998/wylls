//! ⑩'s one lot table under ⑨'s own bridge10 (06c817cc): a job fed from
//! another owner's lot and a job fed from the user's own lot, side by side
//! in one table; unused ore back un-consumed, the sub-unit rest owed;
//! replays and restarts change nothing. Checked on ⑩'s side at every step:
//! `LotCustody::check` (each lot's law, CONSUMED = taken − returned,
//! returned + owed ≤ taken, conservation with what is owed), M's IN_TOTAL
//! never moving after it was filled, and ⑨'s `Bridge::check`.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity_bridge10::*;
use wylls_custody::{begin_inbound, finish_inbound, open, set_order, OrderSpec, PlaceRef, VaultView, ORDER_USE};
use wylls_custody_adapter_09::{vault_id, LotCustody};

const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const S: i64 = T0 + HOUR;
const HOME: Place = Place::Caravan(78);
const ORE: u8 = Resource::Ore as u8;

fn vault() -> VaultView {
    VaultView { p: 0, q: 0, tile: 6, gen: 1, live: true, owner: V.0, owner_tag: tag_of(V), stores: [0; 8], cap: 5_000 * MILLI, quota: [0; 8], lots: 0 }
}

struct Fx {
    b: Bridge,
    g: GrantId,
    m: LotId,
    order: u32,
}

/// ⑨'s world on ⑩'s custody (⑨'s testkit), M's lot of 100 ore (quota 200)
/// with a use order of 80 for B, B's own lot of 30 (quota 60) in the same
/// vault, 100 wood of B's arrived.
fn fx() -> Fx {
    let (w, f) = world_with(LotCustody::new(), 3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    let mut v = vault();
    let bell = b.bell(T0);
    let mut lot = open(&mut v, &actor10(V), (M.0, tag_of(M)), ORE, 200 * MILLI, bell, [0; 32]).unwrap();
    begin_inbound(&v, &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec { kind: ORDER_USE, grantee: B.0, qty: 80 * MILLI, expires_bell: bell + 500, dst: PlaceRef::default(), purpose: PURPOSE_WORKSHOP_ARMS };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &actor10(M), 0, nonce, &spec, bell).unwrap();
    let m = b.add_lot(v, lot);
    // B's own lot in the same vault, in the same table.
    let vid = vault_id(0, 0, 6);
    b.cap.custody.open_lot(vid, V, B, Resource::Ore, 60 * MILLI).unwrap();
    b.cap.custody.try_import(Key { scope: 1 << 40, kind: 100, n: 1 }, Place::Vault(vid), B, Resource::Ore, 30 * MILLI).unwrap();
    b.cap.custody.import(Key { scope: 77, kind: 100, n: 1 }, Place::Caravan(77), B, Resource::Wood, 100 * MILLI).unwrap();
    b.cap.custody.take_notes();
    Fx { b, g: GrantId { facility: f, seq: 1 }, m, order }
}

fn job(x: &mut Fx, seq: u32, start: i64) -> JobId {
    let j = JobId { grant: x.g, seq };
    x.b.apply(start - HOUR, B, &Op::Reserve { job: j, units: 2, start, end: start + 3 * HOUR, max_output: 20 * MILLI }).unwrap();
    j
}

fn wood(x: &mut Fx, j: JobId, n: u64, at: i64) {
    x.b.apply(at, B, &Op::Deposit { job: j, deposit: n, resource: Resource::Wood, amount: 20 * MILLI, from: Place::Caravan(77) }).unwrap();
}

fn ck(x: &Fx, now: i64) {
    x.b.cap.custody.check().unwrap();
    x.b.check(now).unwrap();
    assert_eq!(x.b.lot(x.m).unwrap().in_total, 100 * MILLI, "M's IN_TOTAL never moves on a return");
}

fn own(x: &Fx) -> wylls_custody::Lot {
    x.b.cap.custody.lot(vault_id(0, 0, 6), B, ORE).unwrap()
}

/// The scenario: job 1 from M's lot (40) and job 2 from B's own lot (30),
/// both cancelled part-way, claimed, one of them with a split claim.
fn steps(x: &mut Fx) -> Vec<Box<dyn Fn(&mut Fx) -> Result<Outcome, BridgeError>>> {
    let (o, m) = (x.order, x.m);
    let vid = vault_id(0, 0, 6);
    let j1 = JobId { grant: x.g, seq: 1 };
    let j2 = JobId { grant: x.g, seq: 2 };
    vec![
        Box::new(move |x| x.b.apply(S - HOUR, B, &Op::Reserve { job: j1, units: 1, start: S, end: S + 3 * HOUR, max_output: 20 * MILLI })),
        Box::new(move |x| x.b.apply(S - HOUR, B, &Op::Reserve { job: j2, units: 1, start: S, end: S + 3 * HOUR, max_output: 20 * MILLI })),
        Box::new(move |x| x.b.deposit_from_lot(T0 + 20, B, j1, 1, m, 0, o, 40)),
        Box::new(move |x| x.b.apply(T0 + 20, B, &Op::Deposit { job: j1, deposit: 2, resource: Resource::Wood, amount: 20 * MILLI, from: Place::Caravan(77) })),
        Box::new(move |x| x.b.apply(T0 + 20, B, &Op::Deposit { job: j2, deposit: 1, resource: Resource::Ore, amount: 30 * MILLI, from: Place::Vault(vid) })),
        Box::new(move |x| x.b.apply(T0 + 20, B, &Op::Deposit { job: j2, deposit: 2, resource: Resource::Wood, amount: 15 * MILLI, from: Place::Caravan(77) })),
        Box::new(move |x| x.b.apply(S + 1_200, X, &Op::Settle { job: j1 })),
        Box::new(move |x| x.b.apply(S + 1_700, B, &Op::Cancel { job: j1 })),
        Box::new(move |x| x.b.apply(S + 1_700, B, &Op::Cancel { job: j2 })),
        Box::new(move |x| x.b.apply(S + 1_800, B, &Op::Claim { job: j1, to: HOME })),
        Box::new(move |x| {
            x.b.apply(S + 1_800, B, &Op::ClaimSplit { job: j2, output_to: HOME, refund_to: [Place::Vault(vid), HOME], remainder_to: HOME })
        }),
    ]
}

#[test]
fn returns_and_rests_on_the_one_table() {
    let mut x = fx();
    let all = steps(&mut x);
    for s in &all {
        s(&mut x).unwrap();
        ck(&x, S + 2_000);
    }
    // M's lot: what job 1 did not use is back un-consumed in whole units,
    // the rest owed; nothing counted twice.
    let l = x.b.lot(x.m).unwrap();
    let (back, owed) = (x.b.returned(x.m), x.b.owed(x.m));
    assert!(back > 0 && back % MILLI == 0 && (0..MILLI).contains(&owed), "{back} {owed}");
    assert_eq!(l.consumed, 40 * MILLI - back);
    assert_eq!(l.held, 60 * MILLI + back);
    // B's own lot: its whole units back through the return room it kept.
    let b = own(&x);
    assert_eq!(b.consumed, 0);
    assert!(b.held > 0 && b.held % MILLI == 0 && b.held <= 30 * MILLI);
    assert!(b.inbound.iter().all(|i| !i.live), "no return room left reserved");
    // The two lots are one table.
    assert_eq!(x.b.cap.custody.lots.len(), 2);
}

#[test]
fn every_step_replayed_changes_nothing() {
    let mut x = fx();
    let all = steps(&mut x);
    for (i, s) in all.iter().enumerate() {
        let first = s(&mut x);
        let before = x.b.save();
        let again = s(&mut x);
        assert!(first.is_ok(), "step {i}: {first:?}");
        assert!(matches!(again, Ok(Outcome::AlreadyApplied)), "step {i} again: {again:?}");
        assert_eq!(x.b.save(), before, "step {i}: a replay moved something");
        ck(&x, S + 2_000);
    }
}

#[test]
fn a_restart_at_every_step_gives_the_same_bytes() {
    let mut a = fx();
    let mut b = fx();
    let all = steps(&mut a);
    for (i, s) in all.iter().enumerate() {
        let ra = s(&mut a);
        b.b = Bridge::load(&b.b.save()).expect("restart");
        let rb = s(&mut b);
        assert_eq!(ra, rb, "step {i}");
        assert_eq!(a.b.save(), b.b.save(), "step {i}");
    }
    ck(&b, S + 2_000);
}

#[test]
fn rests_add_up_and_a_full_lot_is_paid_later() {
    let mut x = fx();
    // Two jobs from M's lot cancelled at the same point: their rests add up.
    for (n, start) in [(1u32, S), (2, S + 4 * HOUR)] {
        let j = job(&mut x, n, start);
        x.b.deposit_from_lot(start - HOUR + 10, B, j, 1, x.m, 0, x.order, 40).unwrap();
        wood(&mut x, j, 2, start - HOUR + 10);
        x.b.apply(start + 1_200, B, &Op::Cancel { job: j }).unwrap();
        // Fill M's lot's room before the second return: it stays owed.
        if n == 2 {
            let vid = vault_id(0, 0, 6);
            let room = 200 * MILLI - x.b.lot(x.m).unwrap().held;
            x.b.cap.custody.begin_inbound(vid, M, Resource::Ore, (5, 1), room).unwrap();
        }
        let owed_before = x.b.owed(x.m);
        x.b.apply(start + 1_300, B, &Op::Claim { job: j, to: HOME }).unwrap();
        ck(&x, start + 1_300);
        if n == 2 {
            assert!(x.b.owed(x.m) > owed_before + 30 * MILLI, "a full lot keeps all of it owed");
        }
    }
    let owed = x.b.owed(x.m);
    // The keeper raises the quota: the whole units owed are paid, the rest
    // (under one unit) waits.
    let vid = vault_id(0, 0, 6);
    x.b.cap.custody.set_quota(vid, V, M, Resource::Ore, 300 * MILLI).unwrap();
    x.b.pay_owed(x.m).unwrap();
    assert_eq!(x.b.owed(x.m), owed % MILLI);
    ck(&x, S + 6 * HOUR);
}

#[test]
fn random_runs_on_one_table_never_count_twice() {
    let seeds: u64 = std::env::var("BRIDGE_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
    let (mut fed, mut back, mut restarts, mut replays) = (0u64, 0u64, 0u64, 0u64);
    for seed in 0..seeds {
        let mut g = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rnd = |n: u64| {
            g ^= g << 13;
            g ^= g >> 7;
            g ^= g << 17;
            g % n
        };
        let mut x = fx();
        let vid = vault_id(0, 0, 6);
        let mut now = T0 + 20;
        let mut jobs: Vec<JobId> = vec![];
        let mut last: Option<(JobId, u64, u32)> = None;
        for _ in 0..80 {
            now += rnd(900) as i64;
            if jobs.is_empty() || rnd(6) == 0 {
                let j = JobId { grant: x.g, seq: jobs.len() as u32 + 1 };
                let start = now + 60 + rnd(3 * 3600) as i64;
                if x.b.apply(now, B, &Op::Reserve { job: j, units: 1, start, end: start + HOUR, max_output: (1 + rnd(6) as i64) * MILLI }).is_ok() {
                    jobs.push(j);
                }
                continue;
            }
            let j = jobs[rnd(jobs.len() as u64) as usize];
            let r = match rnd(9) {
                0 | 1 => {
                    let (d, u) = (1 + rnd(4), 1 + rnd(10) as u32);
                    last = Some((j, d, u));
                    let r = x.b.deposit_from_lot(now, B, j, d, x.m, 0, x.order, u);
                    if matches!(r, Ok(Outcome::Applied(_))) {
                        fed += 1;
                    }
                    r.map(|_| ())
                }
                2 => match last {
                    Some((lj, d, u)) => {
                        replays += 1;
                        let before = x.b.save();
                        let r = x.b.deposit_from_lot(now, B, lj, d, x.m, 0, x.order, u);
                        if r == Ok(Outcome::AlreadyApplied) {
                            assert_eq!(x.b.save(), before, "seed {seed}: a replayed deposit moved something");
                        }
                        r.map(|_| ())
                    }
                    None => Ok(()),
                },
                3 => x.b.apply(now, B, &Op::Deposit { job: j, deposit: 5 + rnd(3), resource: Resource::Ore, amount: (1 + rnd(5) as i64) * MILLI, from: Place::Vault(vid) }).map(|_| ()),
                4 => x.b.apply(now, B, &Op::Deposit { job: j, deposit: 8 + rnd(3), resource: Resource::Wood, amount: (1 + rnd(5) as i64) * MILLI, from: Place::Caravan(77) }).map(|_| ()),
                5 => x.b.apply(now, X, &Op::Settle { job: j }).map(|_| ()),
                6 => x.b.apply(now, B, &Op::Cancel { job: j }).map(|_| ()),
                7 => {
                    let r0 = x.b.returned(x.m);
                    let op = if rnd(2) == 0 {
                        Op::Claim { job: j, to: HOME }
                    } else {
                        Op::ClaimSplit { job: j, output_to: HOME, refund_to: [Place::Vault(vid), HOME], remainder_to: HOME }
                    };
                    let r = x.b.apply(now, B, &op);
                    if x.b.returned(x.m) > r0 {
                        back += 1;
                    }
                    // The same claim again moves nothing.
                    let before = x.b.save();
                    if r.is_ok() {
                        let again = x.b.apply(now, B, &op);
                        assert!(matches!(again, Ok(Outcome::AlreadyApplied) | Err(_)), "seed {seed}");
                        assert_eq!(x.b.save(), before, "seed {seed}: a replayed claim moved something");
                    }
                    r.map(|_| ())
                }
                _ => {
                    restarts += 1;
                    x.b = Bridge::load(&x.b.save()).expect("restart");
                    Ok(())
                }
            };
            let _ = r;
            ck(&x, now);
            let l = x.b.lot(x.m).unwrap();
            assert!(l.consumed >= 0 && x.b.returned(x.m) + x.b.owed(x.m) <= 80 * MILLI, "seed {seed}");
        }
    }
    println!("seeds {seeds}: lot deposits {fed}, claims returning ore {back}, deposit replays {replays}, restarts {restarts}");
    assert!(fed >= seeds && back >= seeds / 4 && restarts >= seeds);
}
