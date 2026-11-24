//! Calibration table for owner question T-4 (territory upkeep curve):
//! how many cells a player can keep at a given spare income under each
//! candidate curve. The curves are **candidates to compare**, not choices.
//!
//! `cargo run -p permutation-rules --features std,territory-preview --example territory_calibrate`

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::catalog::{tier_bonus_pct, BASE_PROD, BUILDINGS};
use permutation_rules::frontier::holding::Tier;
use permutation_rules::frontier::territory::{natural_size, UpkeepCurve};

fn main() {
    let food = |t: Tier| BASE_PROD[0] * (100 + tier_bonus_pct(t)) / 100;
    println!(
        "Base food/h: Hamlet {}, Town {}, City {}, Stronghold {}; a farm +{}/h",
        food(Tier::Hamlet),
        food(Tier::Town),
        food(Tier::City),
        food(Tier::Stronghold),
        BUILDINGS[0].per_hour
    );
    let curves: [(&str, UpkeepCurve); 4] = [
        (
            "(a) flat 2",
            UpkeepCurve {
                flat: 2 * MILLI,
                per_rank: 0,
                per_distance: 0,
                free_distance: 0,
            },
        ),
        (
            "(b) 1 + 0.5/rank",
            UpkeepCurve {
                flat: MILLI,
                per_rank: MILLI / 2,
                per_distance: 0,
                free_distance: 0,
            },
        ),
        (
            "(c) 2 + 1/dist>3",
            UpkeepCurve {
                flat: 2 * MILLI,
                per_rank: 0,
                per_distance: MILLI,
                free_distance: 3,
            },
        ),
        (
            "(d) 1 + 0.5/rank + 1/dist>3",
            UpkeepCurve {
                flat: MILLI,
                per_rank: MILLI / 2,
                per_distance: MILLI,
                free_distance: 3,
            },
        ),
    ];
    let incomes = [20i64, 40, 80, 160];
    let dists = [2u32, 5, 8];
    print!("| curve | dist |");
    for i in incomes {
        print!(" {i} food/h |");
    }
    println!();
    print!("|---|---|");
    for _ in incomes {
        print!("---|");
    }
    println!();
    for (name, c) in curves {
        for d in dists {
            print!("| {name} | {d} |");
            for i in incomes {
                match natural_size(&c, i * MILLI, d) {
                    Some(n) => print!(" {n} |"),
                    None => print!(" ∞ |"),
                }
            }
            println!();
        }
    }
}
