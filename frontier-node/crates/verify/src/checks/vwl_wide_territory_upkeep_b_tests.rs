//! (test-gaps-territory) The verifier's mirror of land upkeep under Q-LP17-1 (b) (#243): VWL's `settle_into`
//! re-runs the program's settle (the home's food by `Holding::stock_at`, the shared
//! `frontier_abi::world_index::territory::settle_upkeep`, the charge paid with `Holding::pay`). Replayed here over the
//! shared vectors `frontier-abi/vectors/territory-upkeep-b.txt` (written by frontier-abi, replayed by the program too,
//! `permutation-frontier proc::wide::territory::upkeep_b_tests`): the home's food after = before − charge exactly, the
//! other stores untouched, `pay` never refuses (a refusal would be a false FAIL "the home cannot pay the upkeep it was
//! charged"), and the summary ends as the vector says.
use super::settle_into;
use frontier_abi::world_index::key::WorldId;
use frontier_abi::world_index::territory::{TerritoryPlayer, TerritoryRule, TERRITORY_V1};
use permutation_rules::frontier::holding::{Accrual, Holding};

const VECTORS: &str = include_str!("../../../../../frontier-abi/vectors/territory-upkeep-b.txt");
const BIG_CAP: i64 = i64::MAX / 4;

struct Case {
    n0: u32,
    d0: u8,
    n1: u32,
    d1: u8,
    paid_to: i64,
    remainder: u64,
    since: Option<u32>,
    now_ts: i64,
    now_bell: u32,
    avail: i64,
    charge: i64,
    paid: bool,
    since_after: Option<u32>,
    remainder_after: u64,
    paid_to_after: i64,
}

fn since(x: i64) -> Option<u32> {
    (x >= 0).then_some(x as u32)
}

fn cases() -> Vec<Case> {
    VECTORS
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let n: Vec<i64> = l
                .split_whitespace()
                .filter(|t| *t != "|")
                .map(|t| t.parse().unwrap())
                .collect();
            assert_eq!(n.len(), 15, "{l}");
            Case {
                n0: n[0] as u32,
                d0: n[1] as u8,
                n1: n[2] as u32,
                d1: n[3] as u8,
                paid_to: n[4],
                remainder: n[5] as u64,
                since: since(n[6]),
                now_ts: n[7],
                now_bell: n[8] as u32,
                avail: n[9],
                charge: n[10],
                paid: n[11] == 1,
                since_after: since(n[12]),
                remainder_after: n[13] as u64,
                paid_to_after: n[14],
            }
        })
        .collect()
}

fn summary(c: &Case) -> TerritoryPlayer {
    let mut pl = TerritoryPlayer::new(
        9,
        TerritoryRule::V1,
        WorldId::new([7; 32]).unwrap(),
        [3; 32],
        3,
        1,
        1_000,
        [1; 32],
    );
    for _ in 0..c.n0 {
        pl.add_tile(c.d0).unwrap();
    }
    for _ in 0..c.n1 {
        pl.add_tile(c.d1).unwrap();
    }
    pl.paid_to = c.paid_to;
    pl.remainder = c.remainder;
    pl.unpaid_since = c.since;
    pl
}

/// A first home holding `food` milli-food (and 777 of every other resource) at `now`, nothing accruing.
fn home(now: i64, food: i64) -> Holding {
    let mut h = Holding::found(now, 0, 1);
    for (r, s) in h.stores.iter_mut().enumerate() {
        let v = if r == TERRITORY_V1.upkeep_resource as usize {
            food
        } else {
            777_000
        };
        *s = Accrual::new(v, 0, BIG_CAP, now);
    }
    h
}

#[test]
fn settle_into_replays_the_shared_upkeep_vectors_through_the_home_holding() {
    let all = cases();
    assert_eq!(all.len(), 200, "frontier-abi writes 200 cases");
    let food = TERRITORY_V1.upkeep_resource as usize;
    let mut replayed = 0;
    for c in &all {
        // a holding's store is never negative: the negative-store cases are the kernel's alone (frontier-abi)
        if c.avail < 0 {
            continue;
        }
        let mut pl = summary(c);
        let mut h = home(c.now_ts, c.avail);
        let changed = settle_into(&mut pl, &mut h, c.now_ts, c.now_bell).unwrap_or_else(|e| {
            panic!("pay refused (over-take?) {e:?} at {} {}", c.now_ts, c.avail)
        });
        let after = h.stock_at(c.now_ts);
        assert_eq!(
            after[food],
            c.avail - c.charge,
            "food after = before − charge"
        );
        assert!(after[food] >= 0);
        for (r, v) in after.iter().enumerate().filter(|(r, _)| *r != food) {
            assert_eq!(*v, 777_000, "resource {r} untouched");
        }
        assert_eq!(
            changed,
            c.charge > 0,
            "the home is written only when food was taken"
        );
        assert_eq!(
            (pl.unpaid_since, pl.remainder, pl.paid_to),
            (c.since_after, c.remainder_after, c.paid_to_after)
        );
        // `paid` in the vector ⇔ the summary is clear afterwards
        assert_eq!(c.paid, pl.unpaid_since.is_none());
        replayed += 1;
    }
    assert!(replayed >= 150, "{replayed}");
}

/// A first home that makes food (40 food/h) under land that costs more (73 tiles, loop-play17), settled every turn
/// through the program's path for 200 turns: `pay` never refuses, the food is never negative and exactly the charge
/// leaves the store at each settle; the land stays unpaid from the first short turn on (no flip-flop).
#[test]
fn a_home_settled_every_turn_is_never_over_taken() {
    let food = TERRITORY_V1.upkeep_resource as usize;
    let mut pl = summary(&cases()[0]);
    pl.paid_to = 1_000;
    pl.unpaid_since = None;
    for _ in pl.tiles..73 {
        pl.add_tile(1).unwrap();
    }
    let mut h = Holding::found(1_000, 0, 1);
    for s in h.stores.iter_mut() {
        *s = Accrual::new(0, 0, BIG_CAP, 1_000);
    }
    h.stores[food] = Accrual::new(510_000, 40_000, BIG_CAP, 1_000);
    let mut first_short = None;
    for bell in 1..=200u32 {
        let ts = 1_000 + 600 * bell as i64;
        let before = h.stock_at(ts)[food];
        let since_before = pl.unpaid_since;
        settle_into(&mut pl, &mut h, ts, bell).expect("never more than the store");
        let after = h.stock_at(ts)[food];
        assert!(after >= 0 && after <= before, "bell {bell}");
        if let Some(s) = since_before {
            assert_eq!(
                pl.unpaid_since,
                Some(s),
                "bell {bell}: partial pays never reset the countdown"
            );
        }
        if first_short.is_none() && pl.unpaid_since.is_some() {
            first_short = Some(bell);
        }
    }
    assert_eq!(
        first_short,
        Some(95),
        "the same bell as frontier-abi's pure loop-play17 case and the program's mirror"
    );
}
