//! ⑪(b) first local slice, randomized (verify-pr317): random manifests over
//! the slice's ops (Require/Set/Add/Pay=Lock/Refund=Release, every operand
//! kind, every resource) and random call sequences. The rules kernel's
//! `frontier::effects` and this prototype's interpreter must agree on
//! publication, on every call's result and on every output; Holding +
//! escrow must be conserved per resource; every recorded history must
//! replay to PASS; and a history with any single field of any step changed
//! must never PASS. Deterministic (fixed seeds, xorshift), no dependency.

use permutation_rules::frontier::effects as k;
use permutation_rules::frontier::holding::{Holding, Resource, RESOURCES};
use permutation_rules::frontier::travel::BELL_SECS;
use wylls_ext_kernel::examples;
use wylls_ext_kernel::exec::{run_entry, Instance};
use wylls_ext_kernel::manifest::{ArgSpec, Cmp, Entry, Field, Manifest, Op, Operand, MAGIC};

const T0: i64 = 1_800_000_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
}

fn operand(r: &mut Rng, nargs: usize, nfields: usize) -> Operand {
    loop {
        match r.below(5) {
            0 => {
                return Operand::Const(match r.below(4) {
                    0 => 0,
                    1 => r.range(-3, 3),
                    2 => r.range(0, 30_000),
                    _ => r.range(-5_000, 5_000),
                })
            }
            1 if nargs > 0 => return Operand::Arg(r.below(nargs as u64) as u8),
            2 if nfields > 0 => return Operand::Field(r.below(nfields as u64) as u8),
            3 => return Operand::NowBell,
            4 => return Operand::Escrow(r.below(RESOURCES as u64) as u8),
            _ => {}
        }
    }
}

/// Resources the random manifests touch: a few, so locks and releases meet.
const RES: [u8; 3] = [Resource::Wood as u8, 1, 2];

fn manifest(r: &mut Rng) -> Manifest {
    let mut m = examples::watch_vow([0x5a; 32]);
    m.name = String::from("random");
    let nfields = r.range(0, 4) as usize;
    m.fields = (0..nfields)
        .map(|_| {
            let min = r.range(-10, 0) * 1_000;
            let max = r.range(1, 40) * 1_000;
            Field {
                min,
                max,
                init: r.range(min, max),
            }
        })
        .collect();
    let mut pay_cap = [0i64; RESOURCES];
    for &res in &RES {
        if r.below(3) != 0 {
            pay_cap[res as usize] = r.range(1, 30) * 1_000;
        }
    }
    m.pay_cap = pay_cap;
    let ne = r.range(1, 3) as usize;
    m.entries = (0..ne)
        .map(|i| {
            let nargs = r.range(0, 2) as usize;
            let args = (0..nargs)
                .map(|_| {
                    let min = r.range(-2, 5) * 1_000;
                    ArgSpec {
                        min,
                        max: min + r.range(0, 20) * 1_000,
                    }
                })
                .collect();
            let nops = r.range(1, 6) as usize;
            let ops = (0..nops)
                .map(|_| {
                    let res = RES[r.below(3) as usize];
                    let x = operand(r, nargs, nfields);
                    match r.below(6) {
                        0 => Op::Require(
                            [Cmp::Eq, Cmp::Ne, Cmp::Lt, Cmp::Le, Cmp::Gt, Cmp::Ge]
                                [r.below(6) as usize],
                            x,
                            operand(r, nargs, nfields),
                        ),
                        1 if nfields > 0 => Op::Set(r.below(nfields as u64) as u8, x),
                        2 if nfields > 0 => Op::Add(r.below(nfields as u64) as u8, x),
                        3 | 4 => Op::Pay(res, x),
                        _ => Op::Refund(res, x),
                    }
                })
                .collect();
            Entry {
                id: (i as u8) * 2 + r.below(2) as u8,
                args,
                ops,
            }
        })
        .collect();
    m
}

fn body_bytes(m: &Manifest) -> Vec<u8> {
    let all = m.encode();
    assert_eq!(all[..4], MAGIC);
    let header = 4 + 1 + 1 + 2 + 32 + 32 + 1 + m.name.len();
    all[header..].to_vec()
}

fn holding(r: &mut Rng) -> Holding {
    let mut h = Holding::found(T0, 0, 1);
    for &res in &RES {
        h.credit(T0, Resource::ALL[res as usize], r.range(0, 40) * 1_000)
            .unwrap();
    }
    h
}

fn call(r: &mut Rng, m: &Manifest) -> (u8, Vec<i64>) {
    let e = &m.entries[r.below(m.entries.len() as u64) as usize];
    // Mostly in range, sometimes one off the edge or an unknown entry.
    let id = if r.below(20) == 0 { 7 } else { e.id };
    let mut args: Vec<i64> = e.args.iter().map(|a| r.range(a.min, a.max)).collect();
    if !args.is_empty() && r.below(15) == 0 {
        args[0] = e.args[0].max + 1;
    }
    (id, args)
}

#[test]
fn random_manifests_agree_conserve_and_replay() {
    let (mut valid, mut invalid, mut ok, mut err, mut forged) = (0, 0, 0, 0, 0);
    for seed in 1..=3_000u64 {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15 ^ (seed * 0x1000_0001));
        let m = manifest(&mut r);
        let bytes = body_bytes(&m);
        let kd = k::Body::decode(&bytes);
        match (m.validate(), &kd) {
            (Ok(()), Ok(_)) => valid += 1,
            (Err(_), Err(_)) => {
                invalid += 1;
                continue;
            }
            (p, q) => panic!("seed {seed}: publication prototype {p:?} vs kernel {q:?}"),
        }
        let body = kd.unwrap();
        assert_eq!(body.encode(), bytes, "seed {seed}");
        let id = k::id_of(&bytes);
        let h0 = holding(&mut r);
        let i0 = k::Instance::fresh(&body);
        let (mut pi, mut ph) = (Instance::fresh(&m), h0.clone());
        let (mut ki, mut kh) = (i0.clone(), h0.clone());
        let mut steps = Vec::new();
        let mut t = T0;
        for _ in 0..12 {
            t += r.range(0, 3) * BELL_SECS + r.range(0, BELL_SECS - 1);
            let (entry, args) = call(&mut r, &m);
            let p = run_entry(&m, entry, &args, t, &pi, &ph);
            let q = k::run(&body, entry, &args, t, &ki, &kh);
            match (p, q) {
                (Ok(p), Ok(q)) => {
                    assert_eq!(p.holding, q.holding, "seed {seed}");
                    assert_eq!(p.holding_delta, q.holding_delta, "seed {seed}");
                    assert_eq!(p.escrow_delta, q.escrow_delta, "seed {seed}");
                    assert_eq!(p.burned, [0; RESOURCES], "seed {seed}: no Burn");
                    assert_eq!(p.instance.fields, q.instance.fields, "seed {seed}");
                    assert_eq!(p.instance.escrow, q.instance.escrow, "seed {seed}");
                    assert_eq!(p.instance.seq, q.instance.seq, "seed {seed}");
                    steps.push(k::Step::of(entry, &args, t, ki.seq, &q, &id));
                    (pi, ph, ki, kh) = (p.instance, p.holding, q.instance, q.holding);
                    ok += 1;
                }
                (Err(_), Err(_)) => err += 1,
                (p, q) => panic!("seed {seed}: prototype {p:?} vs kernel {q:?}"),
            }
            // Conservation per resource: what the Holding lost is in escrow.
            let (now, base) = (kh.stock_at(t), h0.stock_at(t));
            for res in 0..RESOURCES {
                assert_eq!(
                    now[res] + ki.escrow[res],
                    base[res],
                    "seed {seed} res {res}"
                );
            }
        }
        let finals = Some((&ki, &kh));
        assert_eq!(
            k::replay(Some(&bytes), &id, (&i0, &h0), &steps, finals),
            k::Verdict::Pass,
            "seed {seed}"
        );
        // One changed field in one step: never PASS.
        if !steps.is_empty() {
            let i = r.below(steps.len() as u64) as usize;
            let mut bad = steps.clone();
            let s = &mut bad[i];
            match r.below(6) {
                0 => s.holding_delta[RES[r.below(3) as usize] as usize] += 1,
                1 => s.escrow_delta[RES[r.below(3) as usize] as usize] -= 1,
                2 => s.seq += 1,
                3 => s.post_state[r.below(32) as usize] ^= 1,
                4 => s.entry ^= 1,
                _ => s.now_ts -= BELL_SECS * 1_000,
            }
            let v = k::replay(Some(&bytes), &id, (&i0, &h0), &bad, finals);
            assert!(matches!(v, k::Verdict::Fail(..)), "seed {seed}: {v:?}");
            forged += 1;
        }
    }
    assert!(valid > 1_000 && invalid > 100, "{valid} {invalid}");
    assert!(
        ok > 2_000 && err > 5_000 && forged > 500,
        "{ok} {err} {forged}"
    );
    eprintln!("valid {valid} invalid {invalid} ok {ok} err {err} forged {forged}");
}
