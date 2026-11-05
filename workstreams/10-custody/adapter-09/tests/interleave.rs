//! Random interleavings of ⑨'s operations over the adapter, with duplicate
//! notifications, restarts, arrivals, caravans contending for lot room, a
//! facility loss and a vault seizure. After every step every invariant
//! holds; the custody notifications reconcile with ⑨'s events; at the end
//! everything is handed out and retired, and nothing is left reserved.

mod common;

use std::collections::BTreeMap;

use common::*;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::testkit::{B, C, SITE_A, SITE_B, SITE_C, T0, X};
use wylls_capacity::CapError;
use wylls_custody_adapter_09::{Note, Why, RETURN_TAG};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }
}

#[derive(Default)]
struct Tally {
    reserved: u64,
    returned: u64,
    released_emptied: u64,
    released_forgotten: u64,
    dups: u64,
    restarts: u64,
    refused: u64,
    applied: u64,
    contended: u64,
}

type Open = BTreeMap<(JobId, u64, Actor, u8), i64>;

/// Folds the notes into the open reservations, checking each ends once.
fn fold(
    open: &mut Open,
    notes: Vec<Note>,
    t: &mut Tally,
    cons: &mut BTreeMap<(JobId, u8), i64>,
    prod: &mut BTreeMap<JobId, i64>,
    back: &mut BTreeMap<JobId, i64>,
) {
    for n in notes {
        match n {
            Note::Reserved {
                job,
                vault,
                owner,
                r,
                qty,
            } => {
                *open.entry((job, vault, owner, r)).or_default() += qty;
                t.reserved += 1;
            }
            Note::Returned {
                job,
                vault,
                owner,
                r,
                qty,
                covered,
                released,
            } => {
                match open.remove(&(job, vault, owner, r)) {
                    Some(o) => assert_eq!(o, covered + released, "return of {job:?}"),
                    None => assert_eq!(
                        (covered, released),
                        (0, 0),
                        "return of {job:?} without a reservation"
                    ),
                }
                *back.entry(job).or_default() += qty;
                t.returned += 1;
            }
            Note::Released {
                job,
                vault,
                owner,
                r,
                qty,
                why,
            } => {
                let o = open
                    .remove(&(job, vault, owner, r))
                    .expect("a release ends a live reservation");
                assert_eq!(o, qty, "release of {job:?}");
                match why {
                    Why::Emptied => t.released_emptied += 1,
                    Why::Forgotten => t.released_forgotten += 1,
                }
            }
            Note::Consumed { job, r, qty } => *cons.entry((job, r)).or_default() += qty,
            Note::Produced { job, qty, .. } => *prod.entry(job).or_default() += qty,
            Note::Stranded { scope } => panic!("job scope {scope} forgotten with goods"),
            Note::Used { .. } => panic!("no use orders in this run"),
        }
    }
}

fn home(who: Actor) -> (u64, Place) {
    if who == B {
        (77, Place::Holding(SITE_B))
    } else {
        (79, Place::Holding(SITE_C))
    }
}

fn run(seed: u64, steps: usize, t: &mut Tally) {
    let mut g = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let loss = g.pick(&[
        LossPolicy::CaptorTakesAll,
        LossPolicy::UserKeepsAll,
        LossPolicy::UserKeepsOutput,
    ]);
    let (mut w, f) = world(Policies {
        loss,
        ..Policies::PROVISIONAL
    });
    let mut jobs: Vec<(Actor, JobId)> = Vec::new();
    let mut next = [1u32, 1u32];
    let mut open = Open::new();
    let (mut cons, mut prod, mut back) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
    let mut now = T0 + 10;
    let mut arrivals = 100;
    let mut lost = false;
    let mut seized = false;
    for _ in 0..steps {
        now += g.below(240) as i64;
        let who = g.pick(&[B, C]);
        let (cv, hold) = home(who);
        let mine: Vec<JobId> = jobs
            .iter()
            .filter(|(a, _)| *a == who)
            .map(|(_, j)| *j)
            .collect();
        let fresh = mine.is_empty() || g.below(6) == 0;
        let j = if fresh {
            let i = (who == C) as usize;
            let j = job(f, 1 + i as u32, next[i]);
            next[i] += 1;
            jobs.push((who, j));
            j
        } else {
            g.pick(&mine)
        };
        // Mostly what the job's phase calls for; a quarter anything at all.
        let phase = w
            .job(j)
            .map(|x| (x.fin == wylls_capacity::ledger::Fin::Open, now < x.start));
        let wild = g.below(4) == 0;
        let roll = match (wild, phase) {
            (true, _) => g.below(100),
            (false, None) => 0,
            (false, Some((true, true))) => g.pick(&[12, 12, 12, 12, 51, 80, 87]),
            (false, Some((true, false))) => g.pick(&[36, 36, 57, 51]),
            (false, Some((false, _))) => g.pick(&[57, 57, 73]),
        };
        let op = match roll {
            0..=11 => {
                let start = now + 60 + g.below(2 * 3600) as i64;
                Op::Reserve {
                    job: j,
                    units: 1,
                    start,
                    end: start + (1 + g.below(3) as i64) * HOUR,
                    max_output: u(1 + g.below(6) as i64),
                }
            }
            12..=35 => {
                let r = g.pick(&[Resource::Ore, Resource::Ore, Resource::Wood]);
                let from = if r == Resource::Ore {
                    g.pick(&[
                        Place::Vault(V),
                        Place::Vault(V),
                        Place::Vault(V),
                        Place::Vault(FAR),
                        Place::Caravan(cv),
                    ])
                } else {
                    Place::Caravan(cv)
                };
                let amount = if g.below(5) == 0 {
                    1 + g.below(5_000) as i64
                } else {
                    u(1 + g.below(8) as i64)
                };
                Op::Deposit {
                    job: j,
                    deposit: 1 + g.below(4),
                    resource: r,
                    amount,
                    from,
                }
            }
            36..=50 => Op::Settle { job: j },
            51..=56 => Op::Cancel { job: j },
            57..=72 => Op::Claim {
                job: j,
                to: g.pick(&[Place::Vault(V), Place::Vault(V), Place::Caravan(cv), hold]),
            },
            73..=79 => Op::Retire { job: j },
            80..=86 => {
                // Goods arrive: into the user's caravan, or into their lot.
                arrivals += 1;
                let r = g.pick(&[Resource::Ore, Resource::Wood]);
                let at = if r == Resource::Ore && g.below(2) == 0 {
                    Place::Vault(V)
                } else {
                    Place::Caravan(cv)
                };
                let _ =
                    w.custody
                        .try_import(arrival(arrivals), at, who, r, u(1 + g.below(12) as i64));
                w.custody.check().unwrap();
                continue;
            }
            87..=89 => {
                // A custody caravan of ⑩ on its way to the lot contends for room.
                let qty = u(1 + g.below(10) as i64);
                if w.custody
                    .begin_inbound(V, who, Resource::Ore, (1_000 + arrivals, 0), qty)
                    .is_ok()
                {
                    t.contended += 1;
                }
                arrivals += 1;
                w.custody.check().unwrap();
                continue;
            }
            90..=93 => {
                w = restart(&w);
                t.restarts += 1;
                continue;
            }
            94 if !lost && g.below(6) == 0 => {
                if w.facilities
                    .get_mut(&SITE_A)
                    .unwrap()
                    .capture(now, X)
                    .is_ok()
                {
                    lost = true;
                }
                Op::FacilityLost { facility: f }
            }
            95 if !seized && g.below(10) == 0 => {
                w.custody.seize_vault(V, X).unwrap();
                seized = true;
                w.custody.check().unwrap();
                continue;
            }
            _ => Op::Settle { job: j },
        };
        let first = ap(&mut w, now, who, &op);
        match &first {
            Ok(Outcome::Applied(_)) => t.applied += 1,
            Err(_) => t.refused += 1,
            _ => {}
        }
        // The same notification again, sometimes after a restart.
        if g.below(3) == 0 {
            if g.below(2) == 0 {
                w = restart(&w);
                t.restarts += 1;
            }
            let custody = bytes(&w.custody);
            let second = ap(&mut w, now, who, &op);
            if matches!(first, Ok(Outcome::Applied(_))) {
                assert!(
                    matches!(second, Ok(Outcome::AlreadyApplied) | Err(CapError::Retired)),
                    "seed {seed}: {op:?} twice: {second:?}"
                );
                assert_eq!(
                    bytes(&w.custody),
                    custody,
                    "seed {seed}: {op:?} replay moved custody"
                );
            }
            t.dups += 1;
        }
        let notes = w.custody.take_notes();
        fold(&mut open, notes, t, &mut cons, &mut prod, &mut back);
    }
    // Drain: far in the future, settle, hand out, retire every job.
    now += 30 * 24 * 3600;
    for (who, j) in &jobs {
        let (cv, _) = home(*who);
        // A job reserved but never started is cancelled first.
        let _ = ap(&mut w, now, *who, &Op::Cancel { job: *j });
        let _ = ap(&mut w, now, X, &Op::Settle { job: *j });
        let _ = ap(
            &mut w,
            now,
            *who,
            &Op::Claim {
                job: *j,
                to: Place::Caravan(cv + 1),
            },
        );
        let r = ap(&mut w, now, *who, &Op::Retire { job: *j });
        assert!(
            matches!(
                r,
                Ok(_) | Err(CapError::UnknownJob) | Err(CapError::Retired)
            ),
            "seed {seed}: {j:?} not retirable after the drain: {r:?}"
        );
    }
    let notes = w.custody.take_notes();
    fold(&mut open, notes, t, &mut cons, &mut prod, &mut back);
    // Nothing reserved, nothing remembered of the jobs.
    assert!(open.is_empty(), "seed {seed}: reservations left {open:?}");
    assert!(
        w.custody.returns.is_empty() && w.custody.jobs.is_empty(),
        "seed {seed}"
    );
    for d in w.custody.lots.values() {
        let l = wylls_custody::lot::Lot::decode(d).unwrap();
        assert!(
            l.inbound
                .iter()
                .all(|i| !i.live || i.caravan_tag & RETURN_TAG == 0),
            "seed {seed}: a return slot left"
        );
    }
    assert!(
        w.custody.keys.keys().all(|k| k.scope >= 1 << 40),
        "seed {seed}: job keys left"
    );
    // Reconcile with ⑨'s own events: what custody used and made is what
    // ⑨ settled, and what came back into lots is what ⑨ refunded there.
    let mut used: BTreeMap<(JobId, u8), i64> = BTreeMap::new();
    let mut made: BTreeMap<JobId, i64> = BTreeMap::new();
    let mut refunded: BTreeMap<JobId, i64> = BTreeMap::new();
    for (_, e) in &w.events {
        match e {
            Event::Settled {
                job, out, used: us, ..
            } => {
                for (i, r) in [Resource::Ore, Resource::Wood].into_iter().enumerate() {
                    if us[i] > 0 {
                        *used.entry((*job, r as u8)).or_default() += us[i];
                    }
                }
                *made.entry(*job).or_default() += out;
            }
            Event::Claimed {
                job,
                refund,
                to: Place::Vault(_),
                ..
            } if refund[0] > 0 => {
                *refunded.entry(*job).or_default() += refund[0];
            }
            _ => {}
        }
    }
    assert_eq!(cons, used, "seed {seed}: custody used != ⑨ settled");
    assert_eq!(prod, made, "seed {seed}: custody made != ⑨ settled");
    assert_eq!(
        back, refunded,
        "seed {seed}: returned into lots != ⑨ refunds there"
    );
    w.custody.check().unwrap();
}

#[test]
fn random_interleavings_keep_every_reservation_exact() {
    let seeds: u64 = std::env::var("ADAPTER_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    let mut t = Tally::default();
    for seed in 0..seeds {
        run(seed, 300, &mut t);
    }
    println!(
        "seeds {seeds}: applied {} refused {} dups {} restarts {} reserved {} returned {} released(emptied) {} released(forgotten) {} contended {}",
        t.applied, t.refused, t.dups, t.restarts, t.reserved, t.returned, t.released_emptied, t.released_forgotten, t.contended
    );
    // Every path ran, and none of ⑨'s retirements had to release a
    // reservation (each ended earlier, with its goods).
    assert!(
        t.reserved >= 3 * seeds && t.returned >= seeds && t.released_emptied >= 2 * seeds,
        "coverage too thin"
    );
    assert!(t.dups >= seeds * 50 && t.restarts >= seeds * 20 && t.contended >= seeds);
    assert_eq!(t.released_forgotten, 0);
}
