//! test-gaps-8 (tests only) for #299 (fix-loop28, LP28 BREAK-2): `--demo --two` reaches `ready` + `pair_ready` when both
//! players already placed homes of ONE nation (LP28: two Fjordal players, B placed before the fort was chosen). verify-pr299
//! checked it live only (H2 default map, H3 `--random-map`, H5 `--coexist`, H6 defend). A live world needs the SBF program
//! and signing keypairs, so it cannot run in key-free PR CI; this file runs the demo's own fort choice on maps the
//! program's own generator makes, on 6 genesis seeds, key-free and in milliseconds:
//!
//! - the land: `generate_province_in` (map.rs `open_province`'s call; centre-free, as the local natural world's
//!   `local_free(S1_LOCAL_7D)` season), the keep tile `keep::keep_tile` (the kernel's symmetric tile), the holder
//!   `home_nation_in` (else the wedge), `keep::try_open_in` and `is_home_heartland` — the chain's ProvinceView;
//! - the homes: the `--two` pair as the page places it (`home.mjs` planHomes `pair`: one province, the first two sites by
//!   the shared seed — LP28's layout), or a predicted home for an unplaced B (`predict_home`), or every heartland site (H1);
//! - the choice: `run`'s loop (capture_demo.rs, pinned by its own source tests), built from the same public parts —
//!   `foreign_keep_candidates` (the first 12), `check_candidate` for the first player, then `pair_b_nation`,
//!   `province_path` and `route_on` for the second; the first fort both reach is the pair's.
//!
//! Model, not the live map: ring seeds here are sha256("tg8-ring" ‖ genesis seed ‖ ring) (a live world draws ring 4's from
//! a drand round at its opening), and every site is free (the demo's test participants fill some).
// (capture_demo and natural_play are behind the local-play features: built and run by the CI step that names them)
#![cfg(feature = "localnet-expedition-play")]

use frontier_abi::v2::kernel::keep as kkeep;
use itest::capture_demo::{
    check_candidate, foreign_keep_candidates, pair_b_nation, pair_role, predict_home,
    province_path, route_on, ProvinceView, MAX_PATH_PROVINCES,
};
use permutation_rules::frontier::geometry::{home_nation_in, is_home_heartland, ProvinceCoord};
use permutation_rules::frontier::terrain::{generate_province_in, ProvinceTerrain};
use sha2::{Digest, Sha256};

const D: u32 = 4; // the ring the demo opens (LP28 / verify-pr299 H2–H6: forts in ring 4)
const FJORDAL: u8 = 5;

/// A home: province, site, its tile.
type Home = ((i32, i32), u8, u8);

struct World {
    genesis: [u8; 32],
    placement: u8,
    hmr: u8,
    keep: kkeep::KeepParams,
}

impl World {
    fn new(seed: u64) -> World {
        let cq = itest::natural_play::params().cq;
        assert_eq!(
            cq.centre,
            frontier_abi::v2::presets::CENTRE_FREE,
            "the local natural world is centre-free"
        );
        let genesis: [u8; 32] = Sha256::digest(format!("tg8-genesis|{seed}")).into();
        World {
            genesis,
            placement: cq.placement,
            hmr: cq.heartland_max_ring,
            keep: cq.keep_params(),
        }
    }
    fn terrain(&self, pc: (i32, i32)) -> ProvinceTerrain {
        let c = ProvinceCoord::new(pc.0, pc.1);
        let mut h = Sha256::new();
        h.update(b"tg8-ring");
        h.update(self.genesis);
        h.update((c.ring() as u16).to_le_bytes());
        generate_province_in(&h.finalize().into(), c, true)
    }
    fn nation(&self, pc: (i32, i32)) -> Option<u8> {
        let c = ProvinceCoord::new(pc.0, pc.1);
        home_nation_in(c, self.placement, self.hmr, &self.genesis, true).or(c.wedge())
    }
    /// The demo's shortlist rule (`run`'s `holder_of`).
    fn holder_of(&self, pc: (i32, i32)) -> Option<u8> {
        let c = ProvinceCoord::new(pc.0, pc.1);
        permutation_rules::frontier::geometry::home_nation(
            c,
            self.placement,
            self.hmr,
            &self.genesis,
        )
        .or(c.wedge())
    }
    /// What OpenProvince records (map.rs: keep wedge = fund wedge in a centre-free season, holder by placement).
    fn view(&self, pc: (i32, i32)) -> Option<ProvinceView> {
        let c = ProvinceCoord::new(pc.0, pc.1);
        if c.ring() > D {
            return None;
        }
        let t = self.terrain(pc);
        let passable = (0..61)
            .filter(|i| t.terrain[*i].is_passable())
            .fold(0u64, |m, i| m | 1 << i);
        let w = fund_wedge(c);
        let tile = kkeep::keep_tile(&t, &t.sites, t.site_count, w).unwrap_or(kkeep::NO_KEEP_TILE);
        let holder = self.nation(pc).unwrap_or(w);
        let keep = kkeep::try_open_in(c, holder, self.hmr, tile, &self.keep, 0, true)
            .ok()
            .flatten()
            .map(|k| {
                (
                    k.holder,
                    k.tile,
                    is_home_heartland(c, holder, self.placement, self.hmr, &self.genesis),
                )
            });
        Some(ProvinceView { passable, keep })
    }
    /// The nation's first-home provinces (heartland rings 2..=hmr) and their sites, as the page plans them.
    fn heartland(&self, nation: u8) -> Vec<((i32, i32), Vec<u8>)> {
        let r = self.hmr as i32;
        let mut out = vec![];
        for p in -r..=r {
            for q in -r..=r {
                let c = ProvinceCoord::new(p, q);
                if (2..=r as u32).contains(&c.ring()) && self.nation((p, q)) == Some(nation) {
                    let t = self.terrain((p, q));
                    out.push(((p, q), (0..t.site_count).collect()));
                }
            }
        }
        out
    }
    /// The `--two` pair's homes as the page places them (`home.mjs` planHomes with `pair`, verify-pr130): one shared seed,
    /// provinces innermost ring first then by `hash32("{seed}|{p},{q}")`, the first with two free sites; its sites by
    /// `hash32("{seed}|{p},{q},{site}")`, the first role the first, the second role the next — one province (LP28).
    fn pair_homes(&self, nation: u8, seed: &str) -> (Home, Home) {
        use frontier_bots::home::hash32;
        let mut provs: Vec<((i32, i32), Vec<u8>)> = self
            .heartland(nation)
            .into_iter()
            .filter(|(_, s)| s.len() >= 2)
            .collect();
        provs.sort_by_key(|((p, q), _)| {
            (
                ProvinceCoord::new(*p, *q).ring(),
                hash32(&format!("{seed}|{p},{q}")),
            )
        });
        let ((p, q), mut sites) = provs
            .into_iter()
            .next()
            .expect("a province with two free sites");
        sites.sort_by_key(|s| hash32(&format!("{seed}|{p},{q},{s}")));
        let t = self.terrain((p, q));
        (
            ((p, q), sites[0], t.sites[sites[0] as usize]),
            ((p, q), sites[1], t.sites[sites[1] as usize]),
        )
    }
    fn home(&self, nation: u8, wallet: &str) -> Home {
        let (pc, site) =
            predict_home(&self.heartland(nation), &format!("{wallet}|0")).expect("a free site");
        (pc, site, self.terrain(pc).sites[site as usize])
    }
}

/// map.rs `fund_wedge`: the province's wedge, (0,0) wedge 0.
fn fund_wedge(c: ProvinceCoord) -> u8 {
    c.wedge().unwrap_or(0)
}

#[derive(Debug)]
struct Pair {
    target: (i32, i32),
    holder: u8,
    b_nation: u8,
    a_steps: usize,
    b_steps: usize,
}

/// `run`'s fort choice for a pair (B's home `b`, placed with nation `b_placed`, or not placed: `None`, then predicted for
/// the fort's nation). `Err` lists every refusal, as the not-ready line does.
fn choose(
    w: &World,
    a: Home,
    a_nation: u8,
    b_wallet: &str,
    b_placed: Option<(Home, u8)>,
) -> Result<Pair, Vec<String>> {
    let start = (a.0, a.2);
    let cands = foreign_keep_candidates(a.0, D, a_nation, |t| w.holder_of(t));
    let view = |pc: (i32, i32)| w.view(pc);
    let mut refused = vec![];
    for (path, target) in cands.iter().take(12) {
        let route = match check_candidate(path, *target, start, a_nation, view) {
            Ok(r) => r,
            Err(e) => {
                refused.push(e);
                continue;
            }
        };
        let Some((holder, keep_tile, _)) = view(*target).and_then(|v| v.keep) else {
            refused.push("second player: the fort has no keep".into());
            continue;
        };
        let (bh, b_nation) = match b_placed {
            Some((h, n)) => (h, pair_b_nation(Some(n), holder)),
            None => (w.home(holder, b_wallet), pair_b_nation(None, holder)),
        };
        let broute = province_path(bh.0, *target, D)
            .ok_or_else(|| format!("no province path from {:?} to {target:?}", bh.0))
            .and_then(|bp| {
                assert!(bp.len() < MAX_PATH_PROVINCES);
                route_on(&bp, *target, keep_tile, (bh.0, bh.2), view)
            });
        match broute {
            Ok(b) => {
                return Ok(Pair {
                    target: *target,
                    holder,
                    b_nation,
                    a_steps: route.len(),
                    b_steps: b.len(),
                })
            }
            Err(e) => refused.push(format!("second player: {e}")),
        }
    }
    Err(refused)
}

const SEEDS: [u64; 6] = [1, 2, 3, 30943232, 21484126, 1757165082];

#[test]
fn lp28_layout_two_players_of_one_nation_get_a_fort_both_reach_on_every_seed() {
    // A and B both Fjordal, B's home placed (the page's own choice for wallet "B") before the fort is chosen
    let mut ready = 0;
    let mut lines = vec![];
    for seed in SEEDS {
        let w = World::new(seed);
        let (a, b) = w.pair_homes(FJORDAL, "pair-wallet|0");
        assert_eq!(a.0, b.0, "one province");
        assert_ne!(a.1, b.1, "two sites");
        match choose(&w, a, FJORDAL, "B", Some((b, FJORDAL))) {
            Ok(p) => {
                ready += 1;
                assert_eq!(ProvinceCoord::new(p.target.0, p.target.1).ring(), D);
                assert_ne!(p.holder, FJORDAL, "another nation's fort");
                assert_eq!(
                    p.b_nation, FJORDAL,
                    "B keeps its own nation (pair_b_nation)"
                );
                assert_eq!(
                    pair_role(p.b_nation, p.holder),
                    "attack",
                    "both players contest it"
                );
                assert!(
                    p.a_steps >= 1 && p.a_steps <= 32 && p.b_steps >= 1 && p.b_steps <= 32,
                    "{p:?}"
                );
                lines.push(format!(
                    "seed {seed}: A {:?} B {:?} -> fort {:?} held by {} ({} / {} steps)",
                    a.0, b.0, p.target, p.holder, p.a_steps, p.b_steps
                ));
            }
            Err(why) => lines.push(format!(
                "seed {seed}: A {:?} B {:?} not ready: {why:?}",
                a.0, b.0
            )),
        }
    }
    println!("{}", lines.join("\n"));
    assert_eq!(
        ready,
        SEEDS.len(),
        "pair ready on every seed\n{}",
        lines.join("\n")
    );
    // and a pair of any one nation, placed as the page places a pair: ready on every seed (36 / 36)
    for nation in 0..6u8 {
        let n = SEEDS
            .iter()
            .filter(|seed| {
                let w = World::new(**seed);
                let (a, b) = w.pair_homes(nation, "pair-wallet|0");
                choose(&w, a, nation, "B", Some((b, nation)))
                    .is_ok_and(|p| pair_role(p.b_nation, p.holder) == "attack")
            })
            .count();
        println!(
            "nation {nation}: same-nation pair ready on {n}/{} seeds",
            SEEDS.len()
        );
        assert_eq!(n, SEEDS.len(), "nation {nation}: {n}");
    }
}

#[test]
fn before_299_the_same_layout_was_never_ready() {
    // (verify-pr299 M1) the pre-#299 rule refused a placed second player whose nation was not the fort's — and every
    // shortlisted fort is another nation's than the first player's, so two players of one nation never got one
    for seed in SEEDS {
        let w = World::new(seed);
        let a = w.home(FJORDAL, "A");
        let cands = foreign_keep_candidates(a.0, D, FJORDAL, |t| w.holder_of(t));
        assert!(!cands.is_empty(), "seed {seed}: a shortlist");
        for (_, t) in cands.iter().take(12) {
            let holder = w.holder_of(*t).unwrap();
            assert_ne!(holder, FJORDAL);
            assert_ne!(
                pair_b_nation(Some(FJORDAL), holder),
                holder,
                "the old rule (B must play the fort's nation) refuses it"
            );
            assert_eq!(
                pair_b_nation(Some(FJORDAL), holder),
                FJORDAL,
                "the new rule keeps B's nation: never refused for it"
            );
        }
    }
}

#[test]
fn defend_pair_b_not_placed_takes_the_forts_nation_and_reaches_it_on_at_least_two_seeds() {
    let mut ready = 0;
    for seed in SEEDS {
        let w = World::new(seed);
        let a = w.home(FJORDAL, "A");
        if let Ok(p) = choose(&w, a, FJORDAL, "B", None) {
            ready += 1;
            assert_eq!(p.b_nation, p.holder, "B is suggested the fort's nation");
            assert_eq!(pair_role(p.b_nation, p.holder), "defend");
            assert_eq!(
                w.nation(w.home(p.holder, "B").0),
                Some(p.holder),
                "its predicted home is in that nation's heartland"
            );
        }
    }
    assert!(ready >= 2, "defend pair ready on at least 2 seeds: {ready}");
}

#[test]
fn every_nation_and_every_second_home_of_it_either_gets_a_fort_or_says_why() {
    // the H1 case (B pushed 4+ provinces away): an explicit not-ready with one reason per refused fort, never a silent one;
    // and a pair of ANY one nation (not only Fjordal) is ready on at least 2 seeds
    for nation in 0..6u8 {
        let mut ready_seeds = 0;
        for seed in SEEDS {
            let w = World::new(seed);
            let a = w.home(nation, "A");
            let mut any = false;
            for (pc, sites) in w.heartland(nation) {
                for s in sites {
                    let b = (pc, s, w.terrain(pc).sites[s as usize]);
                    match choose(&w, a, nation, "B", Some((b, nation))) {
                        Ok(p) => {
                            any = true;
                            assert_eq!(pair_role(p.b_nation, p.holder), "attack");
                        }
                        Err(why) => {
                            let n = foreign_keep_candidates(a.0, D, nation, |t| w.holder_of(t))
                                .len()
                                .min(12);
                            assert_eq!(why.len(), n, "one reason per refused fort (nation {nation}, seed {seed}, B {b:?})");
                            assert!(why.iter().all(|s| !s.is_empty()));
                        }
                    }
                }
            }
            if any {
                ready_seeds += 1;
            }
        }
        assert!(
            ready_seeds >= 2,
            "nation {nation}: a same-nation pair ready on {ready_seeds} seeds"
        );
    }
}

// D-test-gaps-8-1 (found here, NOT fixed: tests only; inbox 2026-11-28 test-gaps-8): for a second player not placed yet,
// `b_home_for` predicts its home as `predict_home(.., "{wallet}|0")` (the page's choice for ONE player: the wallet's seed,
// the lowest-hash site). A `--two` pair's page places it otherwise since #130 (verify-pr130, LP6-12): controller.mjs
// `homeSeed` is `"pair:{season}"` for both roles, and home.mjs `planHomes` with `pair: 'second'` takes the SECOND site of
// the first province that has two free sites. So on the defend path the fort is chosen for a home B does not get; the
// runner's `verify_pair` re-check then reads B's real home (`as_predicted: false`, or `pair_not_ready` if that one does
// not reach the fort). It fails closed. Expected to fail until the owner decides (Q-TG8-1); run with `--ignored`.
#[test]
#[ignore = "D-test-gaps-8-1: b_home_for predicts an unplaced pair B with its wallet seed, the page uses the pair seed and the second site (Q-TG8-1)"]
fn an_unplaced_second_players_predicted_home_is_where_the_pairs_page_places_it() {
    let mut differ = vec![];
    for seed in SEEDS {
        let w = World::new(seed);
        for nation in 0..6u8 {
            let runner = predict_home(&w.heartland(nation), "B-wallet|0");
            let (_, page_b) = w.pair_homes(nation, "pair:SEASON|0");
            if runner != Some((page_b.0, page_b.1)) {
                differ.push(format!(
                    "seed {seed} nation {nation}: runner {runner:?}, page {:?}",
                    (page_b.0, page_b.1)
                ));
            }
        }
    }
    assert!(
        differ.is_empty(),
        "{} of 36 differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}
