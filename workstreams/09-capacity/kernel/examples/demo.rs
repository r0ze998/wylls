//! The demo of workstream 09 (README §3): owner A lends part of a
//! workshop's capacity to B; B ships materials, reserves, deposits; the
//! lent copies convert them over real time while A is away; B claims and
//! ships the arms home. Then a second user C competes for the same
//! capacity.
//!
//!   cargo run --example demo
//!
//! Real: both Holdings (`permutation_rules` `Holding`), the workshop's
//! numbers, the caravan walk. Kernel: the capacity operations. Mock: the
//! custody (⑩).

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, MockCustody};
use wylls_capacity::ledger::{Op, Outcome, Phase, World};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::plan::plan;
use wylls_capacity::policy::Policies;
use wylls_capacity::recipe::{ARMS_RECIPE, RECIPE_ARMS};
use wylls_capacity::testkit::*;

fn name(a: Actor) -> &'static str {
    match a {
        A => "A",
        B => "B",
        C => "C",
        _ => "crank",
    }
}

fn u(m: i64) -> String {
    if m % MILLI == 0 {
        format!("{}", m / MILLI)
    } else {
        format!("{:.3}", m as f64 / MILLI as f64)
    }
}

fn hm(t: i64) -> String {
    let d = t - T0;
    format!("T0+{}h{:02}m", d / HOUR, (d % HOUR) / 60)
}

struct Demo {
    w: World<MockCustody>,
    signers: Vec<(i64, Actor, String)>,
}

impl Demo {
    fn go(&mut self, now: i64, who: Actor, op: Op) -> Outcome {
        let label = format!("{op:?}")
            .split([' ', '{'])
            .next()
            .unwrap()
            .to_string();
        let r = self.w.apply(now, who, &op);
        match &r {
            Ok(Outcome::Applied(ev)) => {
                println!(
                    "  {} {:<5} {:<12} ok, {} event(s)",
                    hm(now),
                    name(who),
                    label,
                    ev.len()
                );
                for e in ev {
                    println!("      · {e:?}");
                }
            }
            Ok(Outcome::AlreadyApplied) => {
                println!(
                    "  {} {:<5} {:<12} already applied (no change)",
                    hm(now),
                    name(who),
                    label
                )
            }
            Err(e) => println!("  {} {:<5} {:<12} refused: {e}", hm(now), name(who), label),
        }
        self.signers.push((now, who, label));
        r.unwrap_or(Outcome::AlreadyApplied)
    }

    fn places(&self, title: &str, job: JobId, extra: &[Place]) {
        println!("  [{title}] where things are, and whose:");
        let mut list = vec![
            Place::Hopper(job),
            Place::Output(job),
            Place::Holding(SITE_A),
        ];
        list.extend_from_slice(extra);
        for p in list {
            for r in [Resource::Ore, Resource::Wood, ARMS] {
                let (o, a) = self.w.custody.balance(p, r);
                if a > 0 {
                    println!(
                        "      {:<24} {:<5} {:>8}  owner {}",
                        format!("{p:?}").chars().take(24).collect::<String>(),
                        format!("{r:?}"),
                        u(a),
                        o.map_or("-", name)
                    );
                }
            }
        }
        let c = &self.w.custody;
        println!(
            "      consumed ore {} wood {} / produced arms {} / custody check {:?}",
            u(c.consumed[Resource::Ore as usize]),
            u(c.consumed[Resource::Wood as usize]),
            u(c.produced[ARMS as usize]),
            c.check()
        );
    }
}

fn a_line(w: &World<MockCustody>, now: i64) {
    let f = &w.facilities[&SITE_A];
    let stock = f.holding.stock_at(now);
    println!(
        "  A's facility: {} workshops, {} lent; A's own arms rate {}/h; A's arms stock {}",
        f.workshops(),
        f.lent,
        u(f.own_arms_rate()),
        u(stock[ARMS as usize])
    );
}

fn main() {
    let mut w = World::new(MockCustody::default());
    w.add_facility(facility(3));
    let mut d = Demo {
        w,
        signers: Vec::new(),
    };
    let mut b_home = holding(0, 300, 300);
    let fac = d.w.facilities[&SITE_A].id();
    let grant = GrantId {
        facility: fac,
        seq: 1,
    };

    println!("== Phase 1: one facility, one recipe, one user ==");
    println!("Recipe (permutation_rules arms): {:?}", ARMS_RECIPE);
    let travel = caravan_secs(SITE_B, SITE_A);
    println!("Caravan B→A (caravan::walk, open land): {} s", travel);
    a_line(&d.w, T0);

    println!("\n-- A signs three times, then is away --");
    let t = T0 + 60;
    d.go(
        t,
        A,
        Op::OpenPool {
            facility: fac,
            policies: Policies::PROVISIONAL,
        },
    );
    d.go(
        t,
        A,
        Op::Lend {
            facility: fac,
            units: 2,
            seq: 0,
        },
    );
    a_line(&d.w, t);
    d.go(
        t,
        A,
        Op::Grant {
            grant,
            user: B,
            recipe: RECIPE_ARMS,
            max_units: 2,
            max_output: 40 * MILLI,
            from: t,
            until: t + 2 * 86_400,
        },
    );
    let a_last = t;

    println!("\n-- B ships materials and reserves --");
    let want = 30 * MILLI;
    let depart = T0 + 10 * 60;
    let pl = plan(&ARMS_RECIPE, 2, want, depart, travel);
    println!("  plan: {:?}", pl);
    let caravan = 0xB0_01;
    ship_out(
        &mut d.w.custody,
        &mut b_home,
        depart,
        B,
        caravan,
        &[
            (Resource::Ore, pl.inputs[0]),
            (Resource::Wood, pl.inputs[1]),
        ],
    );
    println!("  {} B     caravan {caravan:#x} leaves B's village with ore {} wood {} (B's Holding paid them)", hm(depart), u(pl.inputs[0]), u(pl.inputs[1]));
    let job = JobId { grant, seq: 1 };
    let reserve = Op::Reserve {
        job,
        units: 2,
        start: pl.start,
        end: pl.end,
        max_output: want,
    };
    d.go(depart, B, reserve.clone());
    println!("  (B's wallet retries the same Reserve)");
    d.go(depart + 5, B, reserve);

    println!("\n-- the caravan arrives; B deposits --");
    let arrive = pl.start - 1;
    d.go(
        arrive,
        B,
        Op::Deposit {
            job,
            deposit: 1,
            resource: Resource::Ore,
            amount: pl.inputs[0],
            from: Place::Caravan(caravan),
        },
    );
    d.go(
        arrive,
        B,
        Op::Deposit {
            job,
            deposit: 2,
            resource: Resource::Wood,
            amount: pl.inputs[1],
            from: Place::Caravan(caravan),
        },
    );
    d.go(
        arrive,
        B,
        Op::Deposit {
            job,
            deposit: 2,
            resource: Resource::Wood,
            amount: pl.inputs[1],
            from: Place::Caravan(caravan),
        },
    );
    d.places("before start", job, &[Place::Caravan(caravan)]);

    println!("\n-- time passes; anyone may settle (A is away) --");
    let mid = pl.start + pl.run_secs / 2;
    d.go(mid, X, Op::Settle { job });
    d.go(mid, X, Op::Settle { job });
    println!(
        "  phase at {}: {:?}",
        hm(mid),
        d.w.job(job).unwrap().phase(mid)
    );
    d.places("mid-run", job, &[]);
    a_line(&d.w, mid);
    let after = pl.end + 60;
    d.go(after, X, Op::Settle { job });
    println!(
        "  phase at {}: {:?}",
        hm(after),
        d.w.job(job).unwrap().phase(after)
    );

    println!("\n-- B claims into a return caravan; it arrives home --");
    let back = 0xB0_02;
    d.go(
        after,
        B,
        Op::Claim {
            job,
            to: Place::Caravan(back),
        },
    );
    d.go(
        after + 1,
        B,
        Op::Claim {
            job,
            to: Place::Caravan(back),
        },
    );
    d.places("claimed", job, &[Place::Caravan(back)]);
    let home_at = after + caravan_secs(SITE_A, SITE_B);
    let before_arms = b_home.stock_at(home_at)[ARMS as usize];
    ship_in(&mut d.w.custody, &mut b_home, home_at, B, back);
    let got = b_home.stock_at(home_at)[ARMS as usize] - before_arms;
    println!("  {} B's village receives {} arms", hm(home_at), u(got));
    assert_eq!(got, want);

    // No double use: during B's run, A's own conversion and B's job
    // together use at most the facility's 3 copies, and A made exactly the
    // lent copies' capacity less than without lending.
    let span = (pl.start, pl.end);
    let arms_in = |h: &permutation_rules::frontier::holding::Holding, t0: i64, t1: i64| {
        let (mut x, mut y) = (h.clone(), h.clone());
        x.settle(t0).unwrap();
        y.settle(t1).unwrap();
        y.stores[ARMS as usize].value - x.stores[ARMS as usize].value
    };
    let a_made = arms_in(&d.w.facilities[&SITE_A].holding, span.0, span.1);
    let a_alone = arms_in(&facility(3).holding, span.0, span.1);
    let cap = ARMS_RECIPE.capacity_output(3, span.1 - span.0);
    println!(
        "\n  During B's run ({} s): A's own arms {} + B's arms {} = {} ≤ 3 copies' capacity {}",
        span.1 - span.0,
        u(a_made),
        u(want),
        u(a_made + want),
        u(cap)
    );
    println!(
        "  Without lending A would have made {}; the difference {} is the 2 lent copies' capacity {}",
        u(a_alone),
        u(a_alone - a_made),
        u(ARMS_RECIPE.capacity_output(2, span.1 - span.0))
    );
    assert!(a_made + want <= cap);
    assert_eq!(
        a_alone - a_made,
        ARMS_RECIPE.capacity_output(2, span.1 - span.0)
    );
    let a_signed_after: Vec<_> = d
        .signers
        .iter()
        .filter(|(t, a, _)| *a == A && *t > a_last)
        .collect();
    println!("  A's signatures after the grant: {}", a_signed_after.len());
    assert!(a_signed_after.is_empty());

    println!("\n== Phase 2: two users compete for the same lent capacity ==");
    let t2 = after + 120;
    let gc = GrantId {
        facility: fac,
        seq: 2,
    };
    d.go(
        t2,
        A,
        Op::Grant {
            grant: gc,
            user: C,
            recipe: RECIPE_ARMS,
            max_units: 2,
            max_output: 40 * MILLI,
            from: t2,
            until: t2 + 2 * 86_400,
        },
    );
    let s = t2 + HOUR;
    let jb = JobId { grant, seq: 2 };
    let jc = JobId { grant: gc, seq: 1 };
    let jc2 = JobId { grant: gc, seq: 2 };
    d.go(
        t2,
        B,
        Op::Reserve {
            job: jb,
            units: 1,
            start: s,
            end: s + 2 * HOUR,
            max_output: 8 * MILLI,
        },
    );
    println!("  (C asks for 2 copies while B holds 1 of the 2 lent)");
    d.go(
        t2,
        C,
        Op::Reserve {
            job: jc,
            units: 2,
            start: s + HOUR,
            end: s + 3 * HOUR,
            max_output: 10 * MILLI,
        },
    );
    d.go(
        t2,
        C,
        Op::Reserve {
            job: jc,
            units: 1,
            start: s + HOUR,
            end: s + 3 * HOUR,
            max_output: 8 * MILLI,
        },
    );
    println!("  (C wants a second copy for the same hours: B's booking still holds it)");
    let c_more = Op::Reserve {
        job: jc2,
        units: 1,
        start: s + HOUR,
        end: s + 3 * HOUR,
        max_output: 8 * MILLI,
    };
    d.go(t2, C, c_more.clone());
    println!("  (A tries to take a copy back while both are booked)");
    d.go(
        t2 + 1,
        A,
        Op::Reclaim {
            facility: fac,
            units: 1,
            seq: 1,
        },
    );
    println!("  (B never brought materials for its job 2: at its start it ends at once and frees its copy)");
    d.go(s + 1, X, Op::Settle { job: jb });
    println!(
        "  phase of B's job 2: {:?}",
        d.w.job(jb).map(|j| j.phase(s + 1))
    );
    assert!(matches!(
        d.w.job(jb).unwrap().phase(s + 1),
        Phase::Completed(_)
    ));
    d.go(s + 2, C, c_more);
    let occ = |t: i64| -> u32 {
        d.w.pool(fac)
            .unwrap()
            .jobs
            .iter()
            .filter(|j| {
                let (a, b) = j.occupies(s + 2);
                a <= t && t < b
            })
            .map(|j| j.units)
            .sum()
    };
    for h in 0..5 {
        let t = s + h * HOUR + 1;
        println!(
            "  occupied at {}: {} of {} lent",
            hm(t),
            occ(t),
            d.w.pool(fac).unwrap().lent
        );
        assert!(occ(t) <= d.w.pool(fac).unwrap().lent);
    }

    println!("\nFinal custody check: {:?}", d.w.custody.check());
    d.w.custody.check().unwrap();
}
