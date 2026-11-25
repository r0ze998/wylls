//! (test-gaps-territory) Land upkeep under Q-LP17-1 (b) (r0ze 2026-11-25 21:22, #243): property tests over
//! [`settle_upkeep`] / [`may_decay`] / [`apply_decay`], and the **shared vectors**
//! `frontier-abi/vectors/territory-upkeep-b.txt` that the program (`proc::wide_territory` `settle_into`) and the
//! verifier (`checks::vwl_wide_territory` `settle_into`) replay through their own home-holding paths.
//!
//! verify-pr243 checked these invariants with scratch tests that were never committed
//! (`evidence/verify-pr243/zz_verify_pr243_scratch.rs`); they are kept here so CI runs them.
//!
//! Rewrite the vectors after a deliberate rule change (a new rule byte, never a reinterpretation):
//! `TERRITORY_UPKEEP_B_WRITE=1 cargo test -p frontier-abi --features world-index-experimental --lib upkeep_b_tests`.
use super::*;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write as _;

const VECTORS: &str = include_str!("../../vectors/territory-upkeep-b.txt");
const GRACE: u32 = 24;

fn world() -> WorldId {
    WorldId::new([7u8; 32]).unwrap()
}

fn player(tag: u64) -> TerritoryPlayer {
    TerritoryPlayer::new(
        9,
        TerritoryRule::V1,
        world(),
        [tag as u8; 32],
        tag,
        1,
        1_000,
        [1; 32],
    )
}

/// A deterministic generator (no dependency): the same numbers on every machine.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// What `settle_upkeep` must charge, from the rule's own definition (not from the code under test).
fn owed_and_turn(pl: &TerritoryPlayer, now_ts: i64) -> (i128, i128) {
    let rate = pl.upkeep_per_hour().unwrap() as i128;
    let dt = (now_ts as i128 - pl.paid_to as i128).max(0);
    (
        (rate * dt + pl.remainder as i128) / 3_600,
        (rate * 600 + 3_599) / 3_600,
    )
}

/// Invariants of (b) over random settles: never more than owed, never more than the store, never negative;
/// a short settle takes exactly min(owed, store) and stays unpaid; a full one (owed, plus one turn's reserve while
/// unpaid) pays and clears; `unpaid_since` never moves while unpaid (the 24-turn countdown is monotonic); the clock
/// never goes back; the remainder stays below one hour.
#[test]
fn random_settles_keep_the_b_invariants() {
    let mut r = Lcg(0x7e57_243b);
    for case in 0..1_500u64 {
        let mut pl = player(3);
        for i in 0..r.below(90) {
            pl.add_tile((i % 7) as u8).unwrap();
        }
        let mut ts = 1_000i64;
        let mut store: i128 = r.below(60_000) as i128;
        let food_h: i128 = r.below(120_000) as i128;
        let mut left_before: Option<i64> = None;
        for bell in 1..160u32 {
            // dt 0 (two settles in one second), 1 s, part of a turn, a turn, several turns, an hour; sometimes a
            // timestamp behind the clock (a settle replayed late must not move it back)
            let dt = [0i64, 1, 300, 600, 600, 600, 1_200, 3_600, -30][r.below(9) as usize];
            ts += dt;
            if dt > 0 {
                store += food_h * dt as i128 / 3_600;
            }
            if r.below(13) == 0 {
                store = -(r.below(100) as i128);
            }
            if r.below(17) == 0 {
                store = 0;
            }
            let (owed, turn) = owed_and_turn(&pl, ts);
            let before = pl.unpaid_since;
            let paid_to_before = pl.paid_to;
            let s = settle_upkeep(&mut pl, ts, bell, store as Milli).unwrap();
            let c = s.charge as i128;
            let at = || alloc::format!("case {case} bell {bell}");
            assert!(c >= 0, "never negative ({})", at());
            assert!(c <= owed, "never more than owed ({})", at());
            assert!(c <= store.max(0), "never more than the store ({})", at());
            let need = if before.is_some() {
                owed.max(turn)
            } else {
                owed
            };
            assert_eq!(
                s.paid,
                need <= store.max(0),
                "paid iff the store covers the need ({})",
                at()
            );
            if s.paid {
                assert_eq!(c, owed, "a paying settle takes the whole period ({})", at());
                assert_eq!(pl.unpaid_since, None, "a full settle clears ({})", at());
            } else {
                assert_eq!(
                    c,
                    owed.min(store.max(0)),
                    "a short settle takes what is there ({})",
                    at()
                );
                assert_eq!(
                    pl.unpaid_since,
                    Some(before.unwrap_or(bell)),
                    "partial pays keep the first unpaid bell ({})",
                    at()
                );
            }
            // the countdown shown to the player (`since + 24 − bell`) only goes down while unpaid
            if let Some(since) = pl.unpaid_since {
                let left = since as i64 + GRACE as i64 - bell as i64;
                if before.is_some() {
                    assert!(
                        left <= left_before.unwrap(),
                        "countdown never goes back up ({})",
                        at()
                    );
                }
                left_before = Some(left);
            } else {
                left_before = None;
            }
            assert_eq!(
                pl.paid_to,
                paid_to_before.max(ts),
                "the clock never goes back ({})",
                at()
            );
            assert!(pl.remainder < 3_600, "remainder below one hour ({})", at());
            store -= c; // exactly the charge leaves the store
            assert!(
                store >= -100,
                "the store is never driven below what it was ({})",
                at()
            );
        }
    }
}

/// T-5 decay order: with the land unpaid, tiles return one a turn from `since + 24`, always from the farthest
/// occupied distance; a nearer tile is refused `NotFarthest` while a farther one is owned.
#[test]
fn random_territories_release_farthest_first_one_a_turn() {
    let mut r = Lcg(0xdeca7);
    for case in 0..300u64 {
        let mut provs: Vec<TerritoryProvince> = (0..3)
            .map(|i| {
                TerritoryProvince::new(
                    9,
                    TerritoryRule::V1,
                    world(),
                    WideCoord::checked(130 + i, 0).unwrap(),
                    30,
                    [2 + i as u8; 32],
                )
            })
            .collect();
        let mut pl = player(8);
        let n = 1 + r.below(40);
        let mut placed = 0;
        while placed < n {
            let pi = r.below(3) as usize;
            let t = r.below(PROVINCE_TILES as u64) as u8;
            if t == provs[pi].keep_tile || provs[pi].owner[t as usize] != 0 {
                continue;
            }
            let dist = r.below(12) as u8;
            apply_claim(&mut provs[pi], &mut pl, t, ClaimOk { cost: 0, dist }, 0).unwrap();
            placed += 1;
        }
        let since = 5 + r.below(20) as u32;
        pl.unpaid_since = Some(since);
        let mut released: Vec<(u32, u8)> = Vec::new();
        for bell in since..since + GRACE + n as u32 + 5 {
            if !may_decay(&pl, bell) {
                assert!(
                    bell < since + GRACE || pl.tiles == 0,
                    "case {case}: decay due at bell {bell}"
                );
                continue;
            }
            assert!(bell >= since + GRACE, "case {case}: never before the grace");
            let far = pl.farthest_bucket().unwrap();
            // any owned tile nearer than the farthest is refused
            let near = provs.iter().enumerate().find_map(|(pi, p)| {
                (0..PROVINCE_TILES)
                    .find(|&i| p.owner[i] == pl.citizen_tag && (p.dist[i] as usize) < far)
                    .map(|i| (pi, i as u8))
            });
            if let Some((pi, t)) = near {
                let mut p2 = provs[pi].clone();
                let mut pl2 = pl.clone();
                assert_eq!(
                    apply_decay(&mut p2, &mut pl2, t, bell),
                    Err(TerritoryError::NotFarthest),
                    "case {case}"
                );
            }
            let (pi, t) = provs
                .iter()
                .enumerate()
                .find_map(|(pi, p)| {
                    (0..PROVINCE_TILES)
                        .find(|&i| p.owner[i] == pl.citizen_tag && p.dist[i] as usize == far)
                        .map(|i| (pi, i as u8))
                })
                .unwrap();
            let d = provs[pi].dist[t as usize];
            apply_decay(&mut provs[pi], &mut pl, t, bell).unwrap();
            // one per turn
            assert!(
                !may_decay(&pl, bell),
                "case {case}: a second decay in bell {bell}"
            );
            released.push((bell, d));
        }
        assert_eq!(pl.tiles, 0, "case {case}: all released while unpaid");
        assert_eq!(released.len() as u64, n);
        assert_eq!(
            released[0].0,
            since + GRACE,
            "case {case}: first at since + 24"
        );
        for w in released.windows(2) {
            assert_eq!(w[1].0, w[0].0 + 1, "case {case}: one a turn, no gap");
            assert!(w[1].1 <= w[0].1, "case {case}: farthest first");
        }
    }
}

// ------------------------------------------------------------ shared vectors

/// One vector: a summary of `n0` tiles at distance `d0` and `n1` at `d1`, its clock, remainder and unpaid bell,
/// settled at `now_ts` / `now_bell` against `avail` milli-food.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UpkeepVector {
    n0: u32,
    d0: u8,
    n1: u32,
    d1: u8,
    paid_to: i64,
    remainder: u64,
    since: Option<u32>,
    now_ts: i64,
    now_bell: u32,
    avail: Milli,
}

fn vector_player(v: &UpkeepVector) -> TerritoryPlayer {
    let mut pl = player(3);
    for _ in 0..v.n0 {
        pl.add_tile(v.d0).unwrap();
    }
    for _ in 0..v.n1 {
        pl.add_tile(v.d1).unwrap();
    }
    pl.paid_to = v.paid_to;
    pl.remainder = v.remainder;
    pl.unpaid_since = v.since;
    pl
}

fn vector_cases() -> Vec<UpkeepVector> {
    let v = |n0, d0, n1, d1, paid_to, remainder, since, now_ts, now_bell, avail| UpkeepVector {
        n0,
        d0,
        n1,
        d1,
        paid_to,
        remainder,
        since,
        now_ts,
        now_bell,
        avail,
    };
    // 10 tiles near home: 9,900 milli/h; 1,650 a turn
    let mut out = alloc::vec![
        v(10, 0, 0, 0, 1_000, 0, None, 1_600, 1, 0), // empty store: nothing taken, unpaid since 1
        v(10, 0, 0, 0, 1_000, 0, None, 1_600, 1, 1_650), // exactly owed while paid: paid
        v(10, 0, 0, 0, 1_000, 0, None, 1_600, 1, 1_649), // one milli short: takes 1,649, unpaid
        v(10, 0, 0, 0, 1_000, 0, Some(3), 1_600, 9, 1_650), // exactly one turn while unpaid: paid, cleared
        v(10, 0, 0, 0, 1_000, 0, Some(3), 1_300, 9, 1_000), // unpaid, owes 825 but < the turn reserve: takes 825
        v(10, 0, 0, 0, 1_000, 0, Some(3), 1_000, 9, 0), // same second, nothing owed, empty: still unpaid
        v(10, 0, 0, 0, 1_000, 0, Some(3), 1_000, 9, 1_650), // same second, reserve there: paid
        v(10, 0, 0, 0, 1_000, 0, None, 1_600, 1, -5),   // a negative store reads as empty
        v(0, 0, 0, 0, 1_000, 0, Some(3), 5_000, 10, 0), // no tiles: paid, cleared
        v(10, 0, 0, 0, 2_000, 0, None, 1_600, 1, 0),    // a late timestamp: owes 0, clock stays
        v(73, 1, 0, 0, 1_000, 0, None, 1_600, 1, 5_000), // loop-play17: a short turn takes the 5,000
        v(73, 1, 0, 0, 1_600, 0, Some(1), 2_200, 2, 6_666), // the next turn's food alone does not clear it
        v(30, 2, 31, 9, 1_000, 1_234, None, 4_600, 6, 1_000_000), // far tiles + a carried remainder, paid
        v(30, 2, 31, 9, 1_000, 1_234, Some(2), 4_600, 6, 50_000), // the same, short while unpaid
        v(61, 3, 61, 63, 1_000, 3_599, None, 8_200, 12, 10_000_000), // the last histogram bucket
    ];
    let mut r = Lcg(0x005e_c70b);
    for _ in 0..185 {
        let n0 = r.below(80) as u32;
        let n1 = r.below(30) as u32;
        let paid_to = 1_000 + r.below(100_000) as i64;
        let now_ts =
            paid_to + [0i64, 1, 59, 300, 600, 1_200, 3_600, 7_777, -40][r.below(9) as usize];
        let bell = (now_ts.max(0) / 600) as u32;
        let since = if r.below(2) == 0 {
            None
        } else {
            Some(bell.saturating_sub(r.below(40) as u32))
        };
        let avail = match r.below(5) {
            0 => 0,
            1 => -(r.below(50) as Milli),
            2 => r.below(2_000) as Milli,
            3 => r.below(200_000) as Milli,
            _ => r.below(5_000_000) as Milli,
        };
        out.push(v(
            n0,
            r.below(4) as u8,
            n1,
            r.below(64) as u8,
            paid_to,
            r.below(3_600),
            since,
            now_ts,
            bell,
            avail,
        ));
    }
    out
}

fn opt(x: Option<u32>) -> i64 {
    x.map_or(-1, i64::from)
}

fn render_vectors() -> String {
    let mut s = String::new();
    s.push_str(
        "# Land upkeep, Q-LP17-1 (b) (#243): frontier-abi world_index::territory::settle_upkeep, TerritoryRule::V1.\n\
         # Written by frontier-abi territory::upkeep_b_tests (TERRITORY_UPKEEP_B_WRITE=1); replayed by the program\n\
         # (permutation-frontier proc::wide_territory settle_into) and the verifier (verify checks::vwl_wide_territory\n\
         # settle_into) through their home-holding paths. One case a line, whitespace-separated integers:\n\
         # n0 d0 n1 d1 paid_to remainder since now_ts now_bell avail | charge paid since_after remainder_after paid_to_after\n\
         # (n0 tiles at distance d0 and n1 at d1; since -1 = paid; avail = the home's food in milli-units settled to now_ts;\n\
         # paid 1/0; charge = milli-food taken from the home)\n",
    );
    for v in vector_cases() {
        let mut pl = vector_player(&v);
        let st = settle_upkeep(&mut pl, v.now_ts, v.now_bell, v.avail).unwrap();
        writeln!(
            s,
            "{} {} {} {} {} {} {} {} {} {} | {} {} {} {} {}",
            v.n0,
            v.d0,
            v.n1,
            v.d1,
            v.paid_to,
            v.remainder,
            opt(v.since),
            v.now_ts,
            v.now_bell,
            v.avail,
            st.charge,
            st.paid as u8,
            opt(pl.unpaid_since),
            pl.remainder,
            pl.paid_to
        )
        .unwrap();
    }
    s
}

/// The checked-in vectors are what the shared function answers today; each one also satisfies the (b) rules read
/// straight from the decision (so a regenerated file cannot silently carry a broken rule).
#[test]
fn the_shared_vectors_are_current_and_obey_the_rule() {
    let want = render_vectors();
    if std::env::var_os("TERRITORY_UPKEEP_B_WRITE").is_some() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/vectors/territory-upkeep-b.txt"
        );
        std::fs::write(path, &want).unwrap();
        return;
    }
    assert_eq!(
        VECTORS, want,
        "frontier-abi/vectors/territory-upkeep-b.txt is stale (TERRITORY_UPKEEP_B_WRITE=1 rewrites it after a deliberate change)"
    );
    let cases = vector_cases();
    assert_eq!(cases.len(), 200);
    let (mut short, mut full, mut kept) = (0, 0, 0);
    for v in &cases {
        let pl0 = vector_player(v);
        let (owed, turn) = owed_and_turn(&pl0, v.now_ts);
        let mut pl = pl0.clone();
        let s = settle_upkeep(&mut pl, v.now_ts, v.now_bell, v.avail).unwrap();
        let have = (v.avail as i128).max(0);
        let need = if v.since.is_some() {
            owed.max(turn)
        } else {
            owed
        };
        assert_eq!(s.paid, need <= have, "{v:?}");
        assert!((0..=owed.min(have)).contains(&(s.charge as i128)), "{v:?}");
        if s.paid {
            full += 1;
            assert_eq!((s.charge as i128, pl.unpaid_since), (owed, None), "{v:?}");
        } else {
            short += 1;
            assert_eq!(s.charge as i128, owed.min(have), "{v:?}");
            assert_eq!(
                pl.unpaid_since,
                Some(v.since.unwrap_or(v.now_bell)),
                "{v:?}"
            );
            kept += v.since.is_some() as u32;
        }
    }
    // the set exercises both branches and the "already unpaid" path
    assert!(
        short >= 40 && full >= 40 && kept >= 20,
        "short {short} full {full} kept {kept}"
    );
}
