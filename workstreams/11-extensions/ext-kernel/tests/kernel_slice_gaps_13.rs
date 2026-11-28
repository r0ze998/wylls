//! test-gaps-13 (#317, ⑪(b) first local slice; tests only). What
//! `kernel_slice.rs` and `kernel_slice_random.rs` leave open:
//! the REASON of every refusal (they compare Ok/Err only), every resource
//! (they use three), the exact edges of `pay_cap`, escrow, field bounds and
//! overflow, Holdings that produce, starve and sit at their storage cap,
//! what an op sees of the ops before it, and the kernel's `replay` against
//! the prototype's verifier on one history under the same tampering.
//! Host only, no key, deterministic.

mod common;

use common::{call, evidence, grant, world, AUTHOR_A, BELL, B_CITIZEN, B_HOLDING, B_WALLET, T0};
use permutation_rules::frontier::effects as k;
use permutation_rules::frontier::holding::{Effect, Holding, Resource, RESOURCES};
use wylls_ext_kernel::examples::{self, FULFIL, PLEDGE, W};
use wylls_ext_kernel::exec::{run_entry, Instance};
use wylls_ext_kernel::manifest::{ArgSpec, Cmp, Entry, Field, Manifest, Op, Operand, MAGIC};
use wylls_ext_kernel::verify::{verify, Evidence, Verdict};

fn body_bytes(m: &Manifest) -> Vec<u8> {
    let all = m.encode();
    assert_eq!(all[..4], MAGIC);
    all[4 + 1 + 1 + 2 + 32 + 32 + 1 + m.name.len()..].to_vec()
}

/// One manifest: the fields, the caps and one entry (id 0, args as given).
fn one(fields: &[(i64, i64, i64)], cap: i64, args: &[(i64, i64)], ops: Vec<Op>) -> Manifest {
    let mut m = examples::watch_vow([0x13; 32]);
    m.fields = fields
        .iter()
        .map(|&(min, max, init)| Field { min, max, init })
        .collect();
    m.pay_cap = [cap; RESOURCES];
    m.entries = vec![Entry {
        id: 0,
        args: args
            .iter()
            .map(|&(min, max)| ArgSpec { min, max })
            .collect(),
        ops,
    }];
    m
}

/// The kernel's refusal names and the prototype's are the same words, but
/// for one (D-verify-pr317-6): a state whose field count is not the body's.
fn same_reason(kernel: &str, prototype: &str) -> bool {
    kernel == prototype || (kernel, prototype) == ("StateShape", "FieldBounds")
}

type Ran = Result<(k::Instance, Holding, [i64; RESOURCES], [i64; RESOURCES]), String>;

/// Runs entry 0 on both interpreters from the same state; every output and
/// the reason of a refusal must agree. Returns the kernel's result.
fn both(m: &Manifest, args: &[i64], t: i64, st: &k::Instance, h: &Holding) -> Ran {
    let body = k::Body::decode(&body_bytes(m)).expect("the kernel takes the body");
    m.validate().expect("the prototype takes the manifest");
    let mut pi = Instance::fresh(m);
    pi.seq = st.seq;
    pi.fields = st.fields.clone();
    pi.escrow = st.escrow;
    match (
        run_entry(m, 0, args, t, &pi, h),
        k::run(&body, 0, args, t, st, h),
    ) {
        (Ok(p), Ok(q)) => {
            assert_eq!(p.holding, q.holding);
            assert_eq!(p.holding_delta, q.holding_delta);
            assert_eq!(p.escrow_delta, q.escrow_delta);
            assert_eq!(p.burned, [0; RESOURCES]);
            assert_eq!(
                (p.instance.seq, p.instance.fields, p.instance.escrow),
                (q.instance.seq, q.instance.fields.clone(), q.instance.escrow)
            );
            Ok((q.instance, q.holding, q.holding_delta, q.escrow_delta))
        }
        (Err(p), Err(q)) => {
            let q = format!("{q:?}");
            assert!(
                same_reason(&q, p.name()),
                "kernel {q} vs prototype {}",
                p.name()
            );
            Err(q)
        }
        (p, q) => panic!("prototype {p:?} vs kernel {q:?}"),
    }
}

fn fresh(m: &Manifest) -> k::Instance {
    k::Instance::fresh(&k::Body::decode(&body_bytes(m)).unwrap())
}

fn stocked(each: i64) -> Holding {
    let mut h = Holding::found(T0, 0, 1);
    for r in Resource::ALL {
        h.credit(T0, r, each).unwrap();
    }
    h
}

fn refused(r: Ran, why: &str) {
    assert_eq!(r.map(|_| ()), Err(String::from(why)));
}

const A0: Operand = Operand::Arg(0);
const ANY: (i64, i64) = (i64::MIN, i64::MAX);

#[test]
fn every_resource_locks_and_releases_only_itself() {
    assert_eq!(Resource::ALL.len(), RESOURCES);
    for r in 0..RESOURCES {
        let lock = one(&[], 9_000, &[ANY], vec![Op::Pay(r as u8, A0)]);
        let release = one(&[], 9_000, &[ANY], vec![Op::Refund(r as u8, A0)]);
        let h0 = stocked(10_000);
        let (st, h, dh, de) = both(&lock, &[7_000], T0, &fresh(&lock), &h0).unwrap();
        let only =
            |v: i64| core::array::from_fn::<i64, RESOURCES, _>(|i| if i == r { v } else { 0 });
        assert_eq!(
            (dh, de, st.escrow),
            (only(-7_000), only(7_000), only(7_000))
        );
        let (st2, h2, dh, de) = both(&release, &[7_000], T0, &st, &h).unwrap();
        assert_eq!(
            (dh, de, st2.escrow),
            (only(7_000), only(-7_000), [0; RESOURCES])
        );
        assert_eq!(h2, h0, "lock then release at one time is the same Holding");
        assert_eq!((st.seq, st2.seq), (1, 2));
        // The escrow of one resource never pays out another.
        let other = one(
            &[],
            9_000,
            &[ANY],
            vec![Op::Refund(((r + 1) % RESOURCES) as u8, A0)],
        );
        refused(both(&other, &[1], T0, &st, &h), "EscrowInsufficient");
    }
    // One past the last resource is no resource, for either op or operand.
    for op in [
        Op::Pay(RESOURCES as u8, A0),
        Op::Refund(RESOURCES as u8, A0),
        Op::Pay(W, Operand::Escrow(RESOURCES as u8)),
    ] {
        let m = one(&[], 9_000, &[ANY], vec![op]);
        assert_eq!(
            k::Body::decode(&body_bytes(&m)),
            Err(k::EffectError::BadReference)
        );
        assert_eq!(m.validate().unwrap_err().name(), "BadReference");
    }
}

#[test]
fn the_edges_of_lock_and_release() {
    let h = stocked(10_000);
    let lock = one(&[], 6_000, &[ANY], vec![Op::Pay(W, A0)]);
    let st = fresh(&lock);
    // pay_cap: exactly the cap passes, one milli more does not.
    assert!(both(&lock, &[6_000], T0, &st, &h).is_ok());
    refused(both(&lock, &[6_001], T0, &st, &h), "PayCap");
    // The cap is per call over all Locks of a resource; a Release between
    // them gives none of it back; another resource has its own.
    let c = |v| Operand::Const(v);
    let m = one(
        &[],
        6_000,
        &[],
        vec![Op::Pay(W, c(3_000)), Op::Pay(W, c(3_000))],
    );
    assert!(both(&m, &[], T0, &st, &h).is_ok());
    let m = one(
        &[],
        6_000,
        &[],
        vec![Op::Pay(W, c(3_000)), Op::Pay(W, c(3_001))],
    );
    refused(both(&m, &[], T0, &st, &h), "PayCap");
    let m = one(
        &[],
        6_000,
        &[],
        vec![
            Op::Pay(W, c(6_000)),
            Op::Refund(W, c(6_000)),
            Op::Pay(W, c(1)),
        ],
    );
    refused(both(&m, &[], T0, &st, &h), "PayCap");
    let m = one(
        &[],
        6_000,
        &[],
        vec![Op::Pay(0, c(6_000)), Op::Pay(1, c(6_000))],
    );
    assert!(both(&m, &[], T0, &st, &h).is_ok());
    // ... and a new call has the whole cap again.
    let (st1, h1, ..) = both(&lock, &[4_000], T0, &st, &h).unwrap();
    assert!(both(&lock, &[6_000], T0, &st1, &h1).is_ok());
    // The stock: all of it passes, one milli more does not.
    let wide = one(&[], i64::MAX, &[ANY], vec![Op::Pay(W, A0)]);
    assert!(both(&wide, &[10_000], T0, &st, &h).is_ok());
    refused(both(&wide, &[10_001], T0, &st, &h), "Insufficient");
    // The escrow: all of it passes, one milli more does not.
    let release = one(&[], 6_000, &[ANY], vec![Op::Refund(W, A0)]);
    assert!(both(&release, &[4_000], T0, &st1, &h1).is_ok());
    refused(
        both(&release, &[4_001], T0, &st1, &h1),
        "EscrowInsufficient",
    );
    // Zero moves nothing and still counts as a call; negative is refused on
    // both sides (no Lock that mints, no Release that takes).
    for m in [&lock, &release] {
        let (st2, h2, dh, de) = both(m, &[0], T0, &st1, &h1).unwrap();
        assert_eq!(
            (dh, de, st2.seq),
            ([0; RESOURCES], [0; RESOURCES], st1.seq + 1)
        );
        assert_eq!((st2.escrow, h2), (st1.escrow, h1.clone()));
        refused(both(m, &[-1], T0, &st1, &h1), "NegativeAmount");
        refused(both(m, &[i64::MIN], T0, &st1, &h1), "NegativeAmount");
    }
    // Sums that do not fit an i64.
    let twice = one(
        &[],
        i64::MAX,
        &[ANY],
        vec![Op::Pay(W, c(1)), Op::Pay(W, A0)],
    );
    refused(both(&twice, &[i64::MAX], T0, &st, &h), "Overflow");
    let mut full = st.clone();
    full.escrow[W as usize] = i64::MAX;
    refused(both(&wide, &[1], T0, &full, &h), "Overflow");
    let mut last = st.clone();
    last.seq = u64::MAX;
    refused(both(&lock, &[1], T0, &last, &h), "Overflow");
    // A state that is not this body's shape.
    let mut shape = st.clone();
    shape.fields.push(0);
    refused(both(&lock, &[1], T0, &shape, &h), "StateShape");
    // Time before the Holding's last settle.
    refused(both(&lock, &[1], T0 - 1, &st, &h), "TimeReversed");
}

#[test]
fn require_set_and_add_at_their_edges() {
    let h = stocked(0);
    let cmps = [Cmp::Eq, Cmp::Ne, Cmp::Lt, Cmp::Le, Cmp::Gt, Cmp::Ge];
    for (i, c) in cmps.into_iter().enumerate() {
        let m = one(
            &[],
            0,
            &[ANY, ANY],
            vec![Op::Require(c, A0, Operand::Arg(1))],
        );
        for (a, b, want) in [
            (4, 5, [false, true, true, true, false, false]),
            (5, 5, [true, false, false, true, false, true]),
            (6, 5, [false, true, false, false, true, true]),
            (i64::MIN, i64::MAX, [false, true, true, true, false, false]),
        ] {
            let r = both(&m, &[a, b], T0, &fresh(&m), &h);
            if want[i] {
                assert!(r.is_ok(), "{c:?} {a} {b}");
            } else {
                refused(r, "RequireFailed");
            }
        }
    }
    for op in [Op::Set(0, A0), Op::Add(0, A0)] {
        let m = one(&[(-5, 10, 0)], 0, &[ANY], vec![op]);
        for (v, ok) in [(-5, true), (10, true), (-6, false), (11, false)] {
            let r = both(&m, &[v], T0, &fresh(&m), &h);
            if ok {
                assert_eq!(r.unwrap().0.fields, [v]);
            } else {
                refused(r, "FieldBounds");
            }
        }
    }
    let m = one(&[(i64::MIN, i64::MAX, 1)], 0, &[ANY], vec![Op::Add(0, A0)]);
    assert_eq!(
        both(&m, &[i64::MAX - 1], T0, &fresh(&m), &h)
            .unwrap()
            .0
            .fields,
        [i64::MAX]
    );
    refused(both(&m, &[i64::MAX], T0, &fresh(&m), &h), "Overflow");
    // The bell is floored, also before the epoch's zero.
    let m = one(
        &[(i64::MIN, i64::MAX, 0)],
        0,
        &[],
        vec![Op::Set(0, Operand::NowBell)],
    );
    for (t, bell) in [
        (0, 0),
        (BELL - 1, 0),
        (BELL, 1),
        (-1, -1),
        (-BELL, -1),
        (-BELL - 1, -2),
    ] {
        let h = Holding::found(-10 * BELL, 0, 1);
        assert_eq!(
            both(&m, &[], t, &fresh(&m), &h).unwrap().0.fields,
            [bell],
            "t {t}"
        );
    }
}

#[test]
fn an_op_sees_the_ops_before_it_and_a_late_refusal_undoes_them() {
    let h = stocked(10_000);
    let f = &[(0, 100_000, 0), (0, 100_000, 0)];
    let ops = vec![
        Op::Set(0, Operand::Escrow(W)), // 0 before the Lock
        Op::Pay(W, A0),
        Op::Set(1, Operand::Escrow(W)), // the amount after it
        Op::Add(1, Operand::Field(1)),  // twice it
        Op::Refund(W, Operand::Field(0)),
        Op::Require(Cmp::Eq, Operand::Field(1), Operand::Const(6_000)),
    ];
    let m = one(f, 9_000, &[ANY], ops);
    let (st, _, dh, _) = both(&m, &[3_000], T0, &fresh(&m), &h).unwrap();
    assert_eq!(
        (st.fields, st.escrow[W as usize], dh[W as usize]),
        (vec![0, 6_000], 3_000, -3_000)
    );
    // The last op refuses: the caller's state and Holding are as they were.
    let (st0, h0) = (fresh(&m), h.clone());
    refused(both(&m, &[4_000], T0, &st0, &h0), "RequireFailed");
    assert_eq!((st0, h0), (fresh(&m), h));
}

/// Holdings that do things by themselves: production below and at the
/// storage cap, upkeep that starves, a queue that finishes between calls,
/// dormancy. The effect's delta is the effect's alone.
#[test]
fn holdings_that_produce_starve_and_fill_agree_too() {
    let lock = one(&[], 400_000, &[ANY], vec![Op::Pay(W, A0)]);
    let release = one(&[], 400_000, &[], vec![Op::Refund(W, Operand::Escrow(W))]);
    let cap = Holding::found(T0, 0, 1).stores[W as usize].cap;
    let mut seen_over_cap = false;
    for (start, per_hour, upkeep) in [
        (5_000, 7_200, 0),
        (cap, 36_000, 0),
        (cap - 1, 36_000, 0),
        (9_000, 0, 5_400),
        (5_000, 3_601, 1_201),
    ] {
        let mut h = Holding::found(T0, 0, 1);
        h.credit(T0, Resource::Wood, start).unwrap();
        h.credit(T0, Resource::Food, 2_000).unwrap();
        h.enqueue(
            T0,
            0,
            Effect::Production {
                resource: Resource::Wood,
                delta: per_hour,
            },
        )
        .unwrap();
        h.enqueue(
            T0,
            3 * BELL,
            Effect::Production {
                resource: Resource::Stone,
                delta: 1_800,
            },
        )
        .unwrap();
        h.set_upkeep(T0, Resource::Wood, upkeep).unwrap();
        h.set_upkeep(T0, Resource::Food, 4_000).unwrap();
        let mut st = fresh(&lock);
        let mut t = T0;
        for step in 0..8 {
            t += [
                1,
                BELL - 1,
                BELL + 7,
                5 * BELL,
                13,
                40 * BELL,
                900 * BELL,
                3,
            ][step];
            let untouched = h.stock_at(t);
            let (m, args): (&Manifest, &[i64]) = if step % 2 == 0 {
                (&lock, &[2_500])
            } else {
                (&release, &[])
            };
            match both(m, args, t, &st, &h) {
                Ok((st2, h2, dh, de)) => {
                    for r in 0..RESOURCES {
                        assert_eq!(dh[r], -de[r], "what left the Holding is in escrow");
                        assert_eq!(
                            h2.stock_at(t)[r],
                            untouched[r] + dh[r],
                            "the delta is the effect's, not production's"
                        );
                        assert_eq!(h2.stores[r].t0, t, "settled to the call");
                    }
                    seen_over_cap |= h2.stock_at(t)[W as usize] > cap;
                    (st, h) = (st2, h2);
                }
                Err(why) => assert_eq!(why, "Insufficient"),
            }
        }
    }
    // plan §: "a Release onto a full store is kept, not lost"
    assert!(seen_over_cap, "a Release onto a full store was reached");
}

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
    fn pick(&mut self, v: &[i64]) -> i64 {
        v[self.below(v.len() as u64) as usize]
    }
}

/// Random bodies over ALL resources: the two sides refuse for the same
/// reason, at publication and at the call, and every reason is reached.
#[test]
fn random_bodies_are_refused_for_the_same_reason() {
    let mut seen = std::collections::BTreeMap::<String, u32>::new();
    for seed in 1..=4_000u64 {
        let mut r = Rng(0xd1b5_4a32_d192_ed03 ^ (seed * 0x2000_0003));
        let nf = r.below(3) as usize;
        let na = r.below(3) as usize;
        let fields: Vec<_> = (0..nf)
            .map(|_| {
                (
                    r.pick(&[-9_000, 0, i64::MIN]),
                    r.pick(&[0, 9_000, i64::MAX]),
                    0,
                )
            })
            .collect();
        let args: Vec<_> = (0..na)
            .map(|_| {
                (
                    r.pick(&[-2_000, 0, i64::MIN]),
                    r.pick(&[0, 8_000, i64::MAX]),
                )
            })
            .collect();
        // (one past the end now and then: BadReference on both sides)
        let operand = |r: &mut Rng| match r.below(5) {
            0 => Operand::Const(r.pick(&[0, 1, -1, 3_000, 12_000, i64::MAX, i64::MIN])),
            1 => Operand::Arg(r.below(na as u64 + 1 + u64::from(na == 0)).min(na as u64) as u8),
            2 => Operand::Field(r.below(nf as u64 + 1) as u8),
            3 => Operand::NowBell,
            _ => Operand::Escrow(r.below(RESOURCES as u64 + 1) as u8),
        };
        let ops = (0..1 + r.below(4))
            .map(|_| {
                let x = operand(&mut r);
                let res = r.below(RESOURCES as u64) as u8;
                match r.below(7) {
                    0 => Op::Require(
                        [Cmp::Eq, Cmp::Ne, Cmp::Lt, Cmp::Le, Cmp::Gt, Cmp::Ge][r.below(6) as usize],
                        x,
                        operand(&mut r),
                    ),
                    1 => Op::Set(r.below(nf as u64 + 1) as u8, x),
                    2 => Op::Add(r.below(nf as u64 + 1) as u8, x),
                    3 | 4 => Op::Pay(res, x),
                    _ => Op::Refund(res, x),
                }
            })
            .collect();
        let m = one(&fields, r.pick(&[0, 5_000, 5_000, i64::MAX]), &args, ops);
        match (m.validate(), k::Body::decode(&body_bytes(&m))) {
            (Ok(()), Ok(_)) => {}
            (Err(p), Err(q)) => {
                let q = format!("{q:?}");
                assert!(
                    same_reason(&q, p.name()),
                    "seed {seed}: kernel {q} vs prototype {}",
                    p.name()
                );
                *seen.entry(q).or_default() += 1;
                continue;
            }
            (p, q) => panic!("seed {seed}: prototype {p:?} vs kernel {q:?}"),
        }
        let mut st = fresh(&m);
        for e in &mut st.escrow {
            *e = r.pick(&[0, 4_000, i64::MAX]);
        }
        st.seq = r.below(40).checked_sub(1).unwrap_or(u64::MAX);
        let mut h = stocked(10_000);
        let mut t = T0;
        for _ in 0..6 {
            t += r.pick(&[0, 1, BELL, -1]);
            let mut a: Vec<i64> = args
                .iter()
                .map(|&(lo, hi)| r.pick(&[lo, hi, 0, 2_000]))
                .collect();
            if r.below(25) == 0 {
                a.push(0);
            }
            match both(&m, &a, t, &st, &h) {
                Ok((st2, h2, ..)) => {
                    *seen.entry("Ok".into()).or_default() += 1;
                    (st, h) = (st2, h2);
                }
                Err(q) => *seen.entry(q).or_default() += 1,
            }
        }
    }
    for why in [
        "Ok",
        "BadReference",
        "BadBounds",
        "ArgCount",
        "ArgBounds",
        "RequireFailed",
        "FieldBounds",
        "NegativeAmount",
        "PayCap",
        "Insufficient",
        "EscrowInsufficient",
        "TimeReversed",
        "Overflow",
    ] {
        assert!(
            seen.get(why).copied().unwrap_or(0) >= 20,
            "{why} hardly reached: {seen:?}"
        );
    }
}

// ------------------------------------------------------------ replay vs the prototype's verifier

#[derive(Clone)]
struct Archive {
    bytes: Option<Vec<u8>>,
    id: k::BodyId,
    start: (k::Instance, Holding),
    steps: Vec<k::Step>,
    finals: Option<(k::Instance, Holding)>,
}

impl Archive {
    fn replay(&self) -> k::Verdict {
        k::replay(
            self.bytes.as_deref(),
            &self.id,
            (&self.start.0, &self.start.1),
            &self.steps,
            self.finals.as_ref().map(|(i, h)| (i, h)),
        )
    }
}

/// B pledges, fulfils and pledges again, on the prototype's host and on the
/// kernel; each side's own evidence of the same three calls.
fn same_history() -> (Evidence, Archive) {
    let mut m = examples::watch_vow(AUTHOR_A);
    for e in &mut m.entries {
        e.ops.retain(|op| !matches!(op, Op::Emit(_)));
    }
    let t = T0 + 10 * BELL;
    let mut host = world();
    let id = host
        .registry
        .publish(&AUTHOR_A, &m.encode(), None, t)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 20_000))
        .unwrap();
    let before = host.clone();
    let bytes = body_bytes(&m);
    let body = k::Body::decode(&bytes).unwrap();
    let kid = k::id_of(&bytes);
    let start = (
        k::Instance::fresh(&body),
        before.holdings[&B_HOLDING].holding.clone(),
    );
    let (mut st, mut h) = start.clone();
    let mut steps = Vec::new();
    for (seq, (entry, args, at)) in [
        (PLEDGE, &[6_000, 4][..], t),
        (FULFIL, &[][..], t + 4 * BELL),
        (PLEDGE, &[2_000, 1][..], t + 5 * BELL),
    ]
    .into_iter()
    .enumerate()
    {
        let receipt = host.call(&call(id, entry, args, seq as u64, at)).unwrap();
        let o = k::run(&body, entry, args, at, &st, &h).unwrap();
        assert_eq!(
            (receipt.holding_delta, receipt.escrow_delta),
            (o.holding_delta, o.escrow_delta)
        );
        steps.push(k::Step::of(entry, args, at, seq as u64, &o, &kid));
        (st, h) = (o.instance, o.holding);
    }
    assert_eq!(
        h, host.holdings[&B_HOLDING].holding,
        "the same Holding after"
    );
    let ev = evidence(&before, &host);
    let archive = Archive {
        bytes: Some(bytes),
        id: kid,
        start,
        steps,
        finals: Some((st, h)),
    };
    assert_eq!(
        (verify(&ev), archive.replay()),
        (Verdict::Pass, k::Verdict::Pass)
    );
    (ev, archive)
}

fn class(p: &Verdict) -> &'static str {
    match p {
        Verdict::Pass => "PASS",
        Verdict::Fail(_) => "FAIL",
        Verdict::Unverifiable(_) => "UNVERIFIABLE",
    }
}
fn kclass(q: &k::Verdict) -> &'static str {
    match q {
        k::Verdict::Pass => "PASS",
        k::Verdict::Fail(..) => "FAIL",
        k::Verdict::Unverifiable(_) => "UNVERIFIABLE",
    }
}

type Tamper = fn(&mut Evidence, &mut Archive);

#[test]
fn replay_and_the_prototypes_verifier_judge_the_same_tampering_alike() {
    use k::{FailCode as F, Missing as M, Verdict as V};
    let (ev0, a0) = same_history();
    let cases: [(&str, Tamper, k::Verdict); 17] = [
        (
            "more came back than the rules give",
            |e, a| {
                e.log[1].1.holding_delta[0] += 1;
                a.steps[1].holding_delta[0] += 1
            },
            V::Fail(1, F::StepMismatch),
        ),
        (
            "the last resource's delta",
            |e, a| {
                e.log[2].1.holding_delta[RESOURCES - 1] -= 1;
                a.steps[2].holding_delta[RESOURCES - 1] -= 1
            },
            V::Fail(2, F::StepMismatch),
        ),
        (
            "less went into escrow",
            |e, a| {
                e.log[0].1.escrow_delta[W as usize] -= 1;
                a.steps[0].escrow_delta[W as usize] -= 1
            },
            V::Fail(0, F::StepMismatch),
        ),
        (
            "another state after",
            |e, a| {
                e.log[2].1.post_state[31] ^= 1;
                a.steps[2].post_state[31] ^= 1
            },
            V::Fail(2, F::StepMismatch),
        ),
        (
            "a sequence number skipped",
            |e, a| {
                e.log[1].0.seq = 2;
                e.log[1].1.seq = 2;
                a.steps[1].seq = 2
            },
            V::Fail(1, F::SeqReplay),
        ),
        (
            "the fulfil before its bell",
            |e, a| {
                let t = e.log[0].0.now_ts + BELL;
                e.log[1].0.now_ts = t;
                e.log[1].1.now_ts = t;
                a.steps[1].now_ts = t
            },
            V::Fail(1, F::RulesRefuse),
        ),
        (
            "another amount",
            |e, a| {
                e.log[0].0.args[0] = 5_000;
                e.log[0].1.args[0] = 5_000;
                a.steps[0].args[0] = 5_000
            },
            V::Fail(0, F::StepMismatch),
        ),
        (
            "an amount over the argument's range",
            |e, a| {
                e.log[0].0.args[0] = 20_001;
                e.log[0].1.args[0] = 20_001;
                a.steps[0].args[0] = 20_001
            },
            V::Fail(0, F::RulesRefuse),
        ),
        (
            "another entry",
            |e, a| {
                e.log[1].0.entry = PLEDGE;
                e.log[1].1.entry = PLEDGE;
                a.steps[1].entry = PLEDGE
            },
            V::Fail(1, F::RulesRefuse),
        ),
        (
            "the first call left out",
            |e, a| {
                e.log.remove(0);
                a.steps.remove(0);
            },
            V::Fail(0, F::SeqReplay),
        ),
        (
            "the last call left out",
            |e, a| {
                e.log.pop();
                a.steps.pop();
            },
            V::Fail(2, F::FinalStateMismatch),
        ),
        (
            "a call recorded twice",
            |e, a| {
                let x = e.log[0].clone();
                e.log.insert(1, x);
                let s = a.steps[0].clone();
                a.steps.insert(1, s)
            },
            V::Fail(1, F::SeqReplay),
        ),
        (
            "two calls swapped",
            |e, a| {
                e.log.swap(1, 2);
                a.steps.swap(1, 2)
            },
            V::Fail(1, F::SeqReplay),
        ),
        (
            "a final Holding with one more wood",
            |e, a| {
                let add = |h: &mut Holding| h.stores[W as usize].value += 1;
                add(&mut e
                    .holdings_after
                    .as_mut()
                    .unwrap()
                    .get_mut(&B_HOLDING)
                    .unwrap()
                    .holding);
                add(&mut a.finals.as_mut().unwrap().1)
            },
            V::Fail(3, F::FinalStateMismatch),
        ),
        (
            "other bytes under the id",
            |e, a| {
                for b in e.manifests.values_mut() {
                    *b.last_mut().unwrap() ^= 1
                }
                *a.bytes.as_mut().unwrap().last_mut().unwrap() ^= 1
            },
            V::Fail(0, F::BodyHashMismatch),
        ),
        (
            "the published bytes are missing",
            |e, a| {
                e.manifests.clear();
                a.bytes = None
            },
            V::Unverifiable(M::NoBody),
        ),
        (
            "the final state is missing",
            |e, a| {
                e.instances_after = None;
                e.holdings_after = None;
                a.finals = None
            },
            V::Unverifiable(M::NoFinalState),
        ),
    ];
    for (what, tamper, want) in cases {
        let (mut e, mut a) = (ev0.clone(), a0.clone());
        tamper(&mut e, &mut a);
        let (p, q) = (verify(&e), a.replay());
        assert_eq!(q, want, "{what}");
        assert_eq!(
            class(&p),
            kclass(&q),
            "{what}: prototype {p:?} vs kernel {q:?}"
        );
    }
}

/// Every field of every step is bound: change any one and the replay names
/// that step (or, for the times a later step depends on, never PASSes).
#[test]
fn every_field_of_every_step_is_bound() {
    let (_, a0) = same_history();
    let n = a0.steps.len();
    for i in 0..n {
        let mut tampered = 0;
        let mut try_one = |f: &dyn Fn(&mut k::Step)| {
            let mut a = a0.clone();
            f(&mut a.steps[i]);
            assert_ne!(a.steps[i], a0.steps[i]);
            match a.replay() {
                k::Verdict::Fail(at, _) => assert_eq!(at, i),
                v => panic!("step {i}: {v:?}"),
            }
            tampered += 1;
        };
        for r in 0..RESOURCES {
            for d in [1, -1, i64::MAX / 2] {
                try_one(&|s| s.holding_delta[r] += d);
                try_one(&|s| s.escrow_delta[r] += d);
            }
        }
        for b in 0..32 {
            try_one(&|s| s.post_state[b] ^= 0x80);
        }
        try_one(&|s| s.seq += 1);
        try_one(&|s| s.seq = s.seq.wrapping_sub(1));
        try_one(&|s| s.entry = 1 - s.entry);
        try_one(&|s| s.entry = 7);
        try_one(&|s| s.args.push(0));
        try_one(&|s| s.now_ts -= 1_000 * BELL);
        for j in 0..a0.steps[i].args.len() {
            try_one(&|s| s.args[j] += 1);
        }
        assert!(tampered >= 6 * RESOURCES + 38);
    }
    // The start is bound too: another Holding or state before.
    let mut a = a0.clone();
    a.start.1.stores[W as usize].value -= 1;
    assert_eq!(
        a.replay(),
        k::Verdict::Fail(n, k::FailCode::FinalStateMismatch)
    );
    let mut a = a0.clone();
    a.start.0.escrow[W as usize] += 1;
    assert_eq!(a.replay(), k::Verdict::Fail(0, k::FailCode::StepMismatch));
    let mut a = a0.clone();
    a.finals.as_mut().unwrap().0.seq += 1;
    assert_eq!(
        a.replay(),
        k::Verdict::Fail(n, k::FailCode::FinalStateMismatch)
    );
}

/// A recorded time moved by one second, inside its bell, with every other
/// field as it was. The prototype's receipts are chained (each names the
/// one before by hash, the last is in the final state), so its verifier
/// FAILs wherever it is.
fn shifted(i: usize) -> (Verdict, k::Verdict) {
    let (mut e, mut a) = same_history();
    e.log[i].0.now_ts += 1;
    e.log[i].1.now_ts += 1;
    a.steps[i].now_ts += 1;
    (verify(&e), a.replay())
}

#[test]
fn a_shifted_time_fails_the_prototypes_verifier_and_the_kernels_last_step() {
    for i in 0..3 {
        assert_eq!(class(&shifted(i).0), "FAIL", "step {i}");
    }
    // the last call's time is the final Holding's settle time
    assert_eq!(
        shifted(2).1,
        k::Verdict::Fail(3, k::FailCode::FinalStateMismatch)
    );
}

/// REAL GAP, not fixed here (Q-TG13-4, reports/test-gaps-13.md): the
/// kernel's `Step` has no link to the step before and `state_hash` leaves
/// the time out, so `replay` gives PASS where the prototype FAILs.
/// Run with `--ignored`; make it a plain test once it passes.
#[test]
#[ignore = "Q-TG13-4: replay PASSes a step whose recorded time was changed"]
fn a_shifted_time_fails_the_kernels_replay_in_every_step() {
    for i in 0..3 {
        assert_eq!(kclass(&shifted(i).1), "FAIL", "step {i}");
    }
}

/// A step's `post_state` is the state's own hash, and the hash tells apart
/// a change of any one part: seq, each field, each resource's escrow.
#[test]
fn the_post_state_binds_every_part_of_the_state() {
    let m = one(&[(0, 9, 3), (0, 9, 3)], 9_000, &[ANY], vec![Op::Pay(W, A0)]);
    let bytes = body_bytes(&m);
    let (body, id) = (k::Body::decode(&bytes).unwrap(), k::id_of(&bytes));
    let base = fresh(&m);
    let mut states = vec![base.clone()];
    for r in 0..RESOURCES {
        let mut st = base.clone();
        st.escrow[r] = 1;
        states.push(st);
    }
    for f in 0..2 {
        let mut st = base.clone();
        st.fields[f] = 4;
        states.push(st);
    }
    states.push(k::Instance { seq: 1, ..base });
    let mut seen = std::collections::BTreeSet::new();
    for st in &states {
        let o = k::run(&body, 0, &[5], T0, st, &stocked(10)).unwrap();
        let step = k::Step::of(0, &[5], T0, st.seq, &o, &id);
        assert_eq!(step.post_state, o.instance.state_hash(&id));
        assert!(seen.insert(step.post_state), "two states, one hash");
        assert!(
            seen.insert(o.instance.state_hash(&[7; 32])),
            "the body is bound"
        );
    }
}

/// The two hashes a verifier archives, computed outside this code (Python
/// hashlib over the bytes the doc comments name).
#[test]
fn body_id_and_state_hash_known_answers() {
    let m = one(&[(0, 9, 3)], 5, &[(1, 2)], vec![Op::Pay(W, A0)]);
    let bytes = body_bytes(&m);
    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(hex(&bytes), BODY_HEX);
    let id = k::id_of(&bytes);
    assert_eq!(hex(&id), BODY_ID);
    let mut st = fresh(&m);
    st.seq = 0x0102;
    st.escrow[W as usize] = 4;
    assert_eq!(hex(&st.state_hash(&id)), STATE_HASH);
}
const BODY_HEX: &str = "01000000000000000009000000000000000300000000000000030000000500000000000000050000000000000005000000000000000500000000000000050000000000000005000000000000000500000000000000050000000000000001000101000000000000000200000000000000010401010000000000000000";
const BODY_ID: &str = "98a5045a3c6b4265ea5f04eb3f3ecb51e6a4b239e6784965f1c8a8b02ef21318";
const STATE_HASH: &str = "58047b712a8bc176fc2c8b164f9d91439713f0eb9f271f6588e47041fe9a9827";
