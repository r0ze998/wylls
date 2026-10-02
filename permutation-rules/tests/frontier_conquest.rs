//! The conquest rules' kernels (MC contract §3, §7; unit CQ1-A): `keep`,
//! `control`, `siege` v3, `holding` v3, `geometry` v2, `terrain` v2,
//! `camp` v2, `clash` v4 and the v2 ruleset hash.
//!
//! Vector files (`permutation-rules/vectors/`), produced here:
//! - `keep-vectors-v1.json` (keep tiles, Free City sites, scripted keep
//!   contests bell by bell, a quiet run);
//! - `control-vectors-v1.json` (controller, banners, site weights,
//!   lasting changes, banner changes, Herald's Call).
//!
//! `cq_vectors_are_fresh` rebuilds both and fails if a committed copy
//! differs; `PSF_WRITE_VECTORS=1 cargo test --test frontier_conquest`
//! rewrites them. Randomness is a seeded splitmix64 (no proptest).

use permutation_rules::fixed::{MilliTroops, BPS_ONE};
use permutation_rules::frontier::camp;
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::clash::{
    frontier_ruleset, resolve_clash, resolve_clash_ref, ClashError, ClashInput, Fighter, Garrison,
    Occupancy, Relations, MAX_ARRIVALS, MAX_GARRISONS, MAX_GARRISONS_WITH_KEEP, NEUTRAL,
};
use permutation_rules::frontier::control::{
    self, banner_changes, controller, herald_call, herald_call_detail, lasting_changes,
    march_banner, province_control, site_weight_centi, Banner, BannerChange, Change, ControlMap,
    Controller, MapProvince, ProvinceControl, SIDES,
};
use permutation_rules::frontier::doctrine::{self, DOCTRINES};
use permutation_rules::frontier::geometry::{
    is_heartland, is_heartland_in, march_of, ring_provinces, tile_index, tile_offset,
    ProvinceCoord, PROVINCE_TILES,
};
use permutation_rules::frontier::holding::{
    self, capture_effects, lowest_free_slot, may_found_outpost, Holding, LifecycleParams,
    OutpostCheck, OutpostRefusal, Tier as HTier,
};
use permutation_rules::frontier::host::{
    MAX_HOST_TROOPS, MIN_HOST_TROOPS, PROVINCE_HOST_CAP, STAMINA_CAP,
};
use permutation_rules::frontier::keep::{
    self, advance, advance_quiet, garrison, keep_tile, keep_tile_symmetric, lead_host, open,
    try_open, Keep, KeepError, KeepEvent, KeepParams, KeepReport, MAX_KEEP_TROOPS, NO_FACTION,
};
use permutation_rules::frontier::laurel::{strength_weight, Tier};
use permutation_rules::frontier::siege::{
    self, bells_outside_vigil, broken_by_defender, can_complete_before,
    can_complete_before_counted, capture_credited, earliest_completion_bell, held_since_hour_from,
    immunity_bars, may_besiege_v3, occupation_ends, BellReport, HoldingKind, OccupationEndKind,
    Relation, SiegeCheckV3, SiegeRefusal, SiegeStatus, SiegeV3, Vigil, BARRED_ALL, BARRED_NONE,
    VIGIL_WINDOW_BOUND, VIGIL_WINDOW_MIN_OUTSIDE,
};
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::{free_city_site, generate_province, ProvinceTerrain};
use permutation_rules::frontier::{
    self as fr, ruleset_hash, ruleset_hash_input, ruleset_hash_input_v2, ruleset_hash_v2,
    KERNEL_CONSTANTS_V2, KERNEL_VERSIONS, KERNEL_VERSIONS_V2,
};
use permutation_rules::hash::sha256;
use permutation_rules::hex::Hex;
use permutation_rules::map::Terrain;
use permutation_rules::units::UnitType;
use std::fmt::Write as _;
use std::path::PathBuf;

// ------------------------------------------------------------ helpers

/// splitmix64.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors")
}

fn check_fresh(name: &str, produced: &str) {
    let path = vectors_dir().join(name);
    if std::env::var("PSF_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::create_dir_all(vectors_dir()).unwrap();
        std::fs::write(&path, produced).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("{name}: {e}; run PSF_WRITE_VECTORS=1 cargo test --test frontier_conquest")
    });
    assert!(
        committed == produced,
        "{name} is stale: rerun with PSF_WRITE_VECTORS=1 and review the diff"
    );
}

fn terrain_bytes(t: &ProvinceTerrain) -> [u8; 61] {
    core::array::from_fn(|i| t.terrain[i] as u8)
}

/// Whether tile `to` is reachable from `from` over passable tiles of the
/// province.
fn reachable(t: &ProvinceTerrain, from: u8, to: u8) -> bool {
    let mut seen = [false; PROVINCE_TILES];
    let mut stack = vec![from];
    seen[from as usize] = true;
    while let Some(x) = stack.pop() {
        if x == to {
            return true;
        }
        for n in tile_offset(x).unwrap().neighbors() {
            if let Some(j) = tile_index(n) {
                if !seen[j as usize] && t.passable(j) {
                    seen[j as usize] = true;
                    stack.push(j);
                }
            }
        }
    }
    false
}

const GENESIS: i64 = 1_790_471_775;
const M1_RULESET_HASH: &str = "72c6b5835ded6418ed98b0c00b2ae45ce4c4b082d9614447dbce2c9d2e654bd9";
/// `RULESET_HASH_V2` (MC §3.13). Pinned here and in `frontier-abi`
/// (CQ1-C); a change to any conquest kernel version, table or bound moves
/// it on purpose. Re-pinned once by the Wave-1 close (W1C-A, CQH1, CQH3:
/// keep 2, catalog 2, doctrine 2 and the MC tables); Gate CQ1's first pin
/// was `1607f62f…2a5a`.
const V2_RULESET_HASH: &str = "b6dd0f3f260d9ef3e9a71c5010b56c42693578f4d8c394623d56deb9fed98274";

// ------------------------------------------------------------ ruleset hash (§3.13, §5.1)

#[test]
fn cq_m1_ruleset_hash_unchanged_and_v2_pinned() {
    // Staged ABI (MC §5.1, R-16): the M1 hash does not move in Wave 1.
    assert_eq!(
        hex(&ruleset_hash()),
        M1_RULESET_HASH,
        "M1 RULESET_HASH moved"
    );
    assert_eq!(fr::RULES_VERSION_FRONTIER, 10);
    assert_eq!(fr::RULES_VERSION_FRONTIER_V2, 11);
    let v1 = ruleset_hash_input();
    let v2 = ruleset_hash_input_v2();
    assert!(v2.starts_with(b"PSF-RULESET-v2"));
    assert_eq!(ruleset_hash_v2(), sha256(&[&v2]));
    assert_eq!(ruleset_hash_input_v2(), v2, "deterministic");
    assert_ne!(ruleset_hash_v2(), ruleset_hash());
    // v2 = M1 with the v2 head, then the conquest constants, then (the
    // Wave-1 close) the MC tables: K2's train-cost table and the Knight
    // bound.
    let k: Vec<u8> = KERNEL_CONSTANTS_V2
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    let mut tables = fr::RULESET_V2_TABLES_TAG.to_vec();
    catalog::write_tables_v2(&mut tables);
    doctrine::write_bounds_v2(&mut tables);
    assert!(v2.ends_with(&tables));
    assert!(v2[..v2.len() - tables.len()].ends_with(&k));
    // the train table: 6 7 6 12 14 16 10, the refused line: the Knight
    let train: Vec<u8> = catalog::TRAIN_PROD_COST_V2
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    assert!(tables.windows(train.len()).any(|w| w == train));
    assert_eq!(*tables.last().unwrap(), UnitType::Knight as u8);
    let m1_tail = &v1[v1.len() - 40 * 8..];
    assert!(v2.windows(m1_tail.len()).any(|w| w == m1_tail));
    // The bumps of §3.13.
    let ver = |n: &str| KERNEL_VERSIONS_V2.iter().find(|x| x.0 == n).unwrap().1;
    let ver1 = |n: &str| KERNEL_VERSIONS.iter().find(|x| x.0 == n).unwrap().1;
    for (n, a, b) in [
        ("frontier", 10, 11),
        ("siege", 2, 3),
        ("holding", 2, 3),
        ("clash", 3, 4),
        ("camp", 1, 2),
        ("terrain", 1, 2),
        ("geometry", 1, 2),
        // Wave-1 close (CQH1, CQH3): K2's train table, the Knight bound
        ("catalog", 1, 2),
        ("doctrine", 1, 2),
    ] {
        assert_eq!((ver1(n), ver(n)), (a, b), "{n}");
    }
    // keep 2: the symmetric keep tile (PO-5); control unchanged
    assert_eq!(ver("keep"), 2);
    assert_eq!(ver("control"), 1);
    for (n, v) in KERNEL_VERSIONS {
        if ![
            "frontier", "siege", "holding", "clash", "camp", "terrain", "geometry", "catalog",
            "doctrine",
        ]
        .contains(&n)
        {
            assert_eq!(ver(n), v, "{n} unchanged");
        }
    }
    let h = hex(&ruleset_hash_v2());
    println!("RULESET_HASH_V2 = {h}");
    assert_eq!(h, V2_RULESET_HASH, "RULESET_HASH_V2 changed");
}

// ------------------------------------------------------------ geometry v2

#[test]
fn cq_heartland_in_matches_m1_at_3_and_follows_the_parameter() {
    for d in 0..10 {
        for p in ring_provinces(d) {
            for f in 0..6 {
                assert_eq!(is_heartland(p, f), is_heartland_in(p, f, 3), "{p:?} {f}");
                assert_eq!(
                    is_heartland_in(p, f, 2),
                    d == 2 && p.wedge() == Some(f),
                    "{p:?} {f}"
                );
                assert_eq!(
                    is_heartland_in(p, f, 6),
                    (2..=6).contains(&d) && p.wedge() == Some(f)
                );
            }
        }
    }
}

// ------------------------------------------------------------ terrain v2, camp v2, keep tile

/// `keep_tile`: the scan in the province's own indices (the keep tile of
/// wedge 0; the v1.2 rule, superseded in the other wedges by PO-5).
#[test]
fn cq_keep_tile_is_the_lowest_passable_non_site_and_reachable() {
    let centre = tile_index(Hex::new(0, 0)).unwrap();
    let mut n = 0;
    for s in 0..24u8 {
        let seed = [s; 32];
        for d in 2..8 {
            for p in ring_provinces(d) {
                let t = generate_province(&seed, p);
                let tb = terrain_bytes(&t);
                let k = keep_tile(&tb, &t.sites, t.site_count).expect("a keep tile");
                assert!(t.passable(k) && !t.is_site(k));
                assert!((0..k).all(|i| !t.passable(i) || t.is_site(i)), "lowest");
                assert!(reachable(&t, centre, k), "reachable {p:?}");
                for g in 0..t.site_count {
                    assert!(reachable(&t, t.sites[g as usize], k));
                }
                n += 1;
            }
        }
    }
    assert_eq!(n, 24 * (12 + 18 + 24 + 30 + 36 + 42));
    // Edge cases: no passable non-site tile; sites beyond site_count ignored.
    let water = [5u8; 61];
    assert_eq!(keep_tile(&water, &[], 0), None);
    let mut one = [5u8; 61];
    one[7] = 0;
    one[9] = 3;
    assert_eq!(keep_tile(&one, &[7, 9], 1), Some(9));
    assert_eq!(keep_tile(&one, &[7, 9], 2), None);
    assert_eq!(keep_tile(&one, &[7], 12), Some(9), "site_count clamps");
}

/// The MC keep tile (v1.3, PO-5, CQH1(5), KEEP_VERSION 2):
/// `keep_tile_symmetric` is passable, off every site, reachable from the
/// centre and every site, equal to `keep_tile` in wedge 0, and the
/// canonical copy's tile turned into the wedge, so all six wedges of a
/// ring keep on the same tile. Compares the wedges as CQ1-A's test did.
#[test]
fn cq_keep_tile_symmetric_is_the_rule_in_every_wedge() {
    let centre = tile_index(Hex::new(0, 0)).unwrap();
    let (mut n, mut differs) = (0u32, 0u32);
    for s in 0..24u8 {
        let seed = [s; 32];
        for d in 2..8 {
            for p in ring_provinces(d) {
                let t = generate_province(&seed, p);
                let tb = terrain_bytes(&t);
                let w = p.wedge().unwrap();
                let ks = keep_tile_symmetric(&tb, &t.sites, t.site_count, w).unwrap();
                assert!(t.passable(ks) && !t.is_site(ks), "{p:?}");
                assert!(reachable(&t, centre, ks), "reachable {p:?}");
                for g in 0..t.site_count {
                    assert!(reachable(&t, t.sites[g as usize], ks), "{p:?} site {g}");
                }
                // the canonical (wedge-0) copy's keep tile, turned into w
                let c = generate_province(&seed, p.turned(w));
                let kc = keep_tile(&terrain_bytes(&c), &c.sites, c.site_count).unwrap();
                assert_eq!(
                    ks,
                    tile_index(tile_offset(kc).unwrap().rotate_by(w)).unwrap(),
                    "same tile in every wedge"
                );
                assert_eq!(
                    keep_tile_symmetric(&terrain_bytes(&c), &c.sites, c.site_count, 0),
                    Some(kc)
                );
                let k = keep_tile(&tb, &t.sites, t.site_count).unwrap();
                if w == 0 {
                    assert_eq!(ks, k);
                }
                differs += (ks != k) as u32;
                // the wedge is taken mod 6
                assert_eq!(
                    keep_tile_symmetric(&tb, &t.sites, t.site_count, w + 6),
                    Some(ks)
                );
                n += 1;
            }
        }
    }
    assert_eq!(n, 24 * (12 + 18 + 24 + 30 + 36 + 42));
    // CQ1-A finding 1: the v1.2 scan put the keep elsewhere in most
    // provinces outside wedge 0.
    assert!(differs > n / 2, "{differs} of {n}");
    let water = [5u8; 61];
    assert_eq!(keep_tile_symmetric(&water, &[], 0, 3), None);
}

#[test]
fn cq_free_city_site_is_the_same_canonical_site_in_every_wedge() {
    for s in 0..16u8 {
        let seed = [s ^ 0x5A; 32];
        for d in 2..9 {
            for p in ring_provinces(d) {
                let t = generate_province(&seed, p);
                let i = free_city_site(&seed, p, t.site_count);
                assert!(i < t.site_count);
                let w = p.wedge().unwrap();
                let c = p.turned(w);
                assert_eq!(free_city_site(&seed, c, t.site_count), i, "canonical");
                // The site tile is the canonical one turned into the wedge.
                let tc = generate_province(&seed, c);
                let site_c = tc.sites[i as usize];
                assert_eq!(
                    t.sites[i as usize],
                    tile_index(tile_offset(site_c).unwrap().rotate_by(w)).unwrap()
                );
                let k = keep_tile_symmetric(&terrain_bytes(&t), &t.sites, t.site_count, w).unwrap();
                assert_ne!(t.sites[i as usize], k, "never on the keep");
            }
        }
    }
    assert_eq!(
        free_city_site(&[0; 32], ProvinceCoord::new(4, 0), 0),
        u8::MAX
    );
}

#[test]
fn cq_camp_v2_never_on_the_keep_and_is_m1_without_one() {
    let mut moved = 0u32;
    for s in 0..6u8 {
        let seed = [s.wrapping_mul(31); 32];
        for d in 2..6 {
            for p in ring_provinces(d) {
                let t = generate_province(&seed, p);
                let k = keep_tile_symmetric(
                    &terrain_bytes(&t),
                    &t.sites,
                    t.site_count,
                    p.wedge().unwrap(),
                );
                for day in 0..12u32 {
                    for (has, init) in [(true, false), (false, true), (false, false)] {
                        let m1 = camp::place(&seed, p, &t, day, has, init);
                        assert_eq!(camp::place_v2(&seed, p, &t, day, has, init, None), m1);
                        let v2 = camp::place_v2(&seed, p, &t, day, has, init, k);
                        assert_eq!(m1.is_some(), v2.is_some(), "same spawn draw");
                        if let Some(c) = v2 {
                            assert_ne!(Some(c.tile), k);
                            assert!(camp::camp_tile_ok(&t, c.tile));
                            assert_eq!(c.troops, m1.unwrap().troops);
                            moved += (Some(c.tile) != m1.map(|x| x.tile)) as u32;
                        }
                    }
                }
            }
        }
    }
    assert!(moved > 0, "the keep tile changes some camp draws");
}

// ------------------------------------------------------------ clash v4 (K-21)

const P: ProvinceCoord = ProvinceCoord { p: 3, q: 1 };

fn flat() -> ProvinceTerrain {
    let mut t = generate_province(&[7u8; 32], P);
    t.terrain = [Terrain::Plains; PROVINCE_TILES];
    t
}

fn fighter(id: u64, faction: u8, troops: MilliTroops, tile: u8, arrival: bool) -> Fighter {
    Fighter {
        id,
        faction,
        unit: UnitType::Spearman,
        troops,
        stamina: STAMINA_CAP,
        tile,
        posture: if arrival {
            Posture::Stance(Stance::Assault)
        } else {
            Posture::default()
        },
        retreat_bps: None,
        dealt_bps: BPS_ONE,
    }
}

fn site_garrison(i: u8, faction: u8, tile: u8, troops: MilliTroops) -> Garrison {
    Garrison {
        id: 1_000 + i as u64,
        faction,
        tile,
        troops,
        walls: true,
        posture: Posture::default(),
    }
}

fn run(
    t: &ProvinceTerrain,
    res: &[Fighter],
    gar: &[Garrison],
    arr: &[Fighter],
    bell: u32,
) -> (
    Result<permutation_rules::frontier::clash::ClashOutcome, ClashError>,
    Result<permutation_rules::frontier::clash::ClashOutcome, ClashError>,
) {
    let inp = ClashInput {
        province: P,
        bell,
        seed: sha256(&[b"cq-clash", &bell.to_le_bytes()]),
        terrain: t,
        residents: res,
        garrisons: gar,
        arrivals: arr,
        relations: Relations::ALL_HOSTILE,
        occupancy: Occupancy::EMPTY,
    };
    let r = frontier_ruleset();
    (resolve_clash(&r, &inp), resolve_clash_ref(&r, &inp))
}

#[test]
fn cq_clash_takes_the_keep_as_a_13th_garrison_at_full_fill() {
    assert_eq!(MAX_GARRISONS, 12, "M1 constant unchanged");
    assert_eq!(MAX_GARRISONS_WITH_KEEP, 13);
    let t = flat();
    let mut rng = Rng(0xC1A5);
    for case in 0..40u32 {
        // 12 site garrisons on 12 tiles, the keep on a 13th.
        let mut gar: Vec<Garrison> = (0..12u8)
            .map(|i| {
                let f = if rng.chance(30) {
                    NEUTRAL
                } else {
                    rng.below(6) as u8
                };
                site_garrison(i, f, i * 4, (rng.below(30_000) as u32 + 1) * 1000)
            })
            .collect();
        let k = Keep {
            tile: 50,
            holder: rng.below(6) as u8,
            contender: NO_FACTION,
            progress: 0,
            required: 72,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: rng.below(MAX_KEEP_TROOPS as u64 + 1) as u32,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: case,
            last_taken_from: NO_FACTION,
        };
        gar.push(garrison(&k).unwrap());
        // 48 residents and 24 arrivals around the keep and the sites: 85
        // units in one clash.
        let tiles = [50u8, 0, 4, 8, 49, 51, 44, 45];
        let res: Vec<Fighter> = (0..PROVINCE_HOST_CAP as u64)
            .map(|i| {
                fighter(
                    10 + i,
                    (i % 6) as u8,
                    (rng.below(29_900) as u32 + 100) * 1000,
                    tiles[rng.below(tiles.len() as u64) as usize],
                    false,
                )
            })
            .collect();
        let arr: Vec<Fighter> = (0..MAX_ARRIVALS as u64)
            .map(|i| {
                fighter(
                    500 + i,
                    (i % 6) as u8,
                    (rng.below(29_900) as u32 + 100) * 1000,
                    tiles[rng.below(tiles.len() as u64) as usize],
                    true,
                )
            })
            .collect();
        let (a, b) = run(&t, &res, &gar, &arr, 100 + case);
        let a = a.expect("13 garrisons accepted");
        let b = b.expect("reference accepts them too");
        assert_eq!(
            a.digest(),
            b.digest(),
            "Phase A body = reference with the keep"
        );
        assert!(a.garrisons.iter().any(|g| g.id == keep::garrison_id(case)));
        // A 14th garrison is refused.
        let mut more = gar.clone();
        more.push(site_garrison(99, 1, 60, 1000));
        assert_eq!(
            run(&t, &res, &more, &arr, 7).0,
            Err(ClashError::TooManyGarrisons)
        );
    }
}

/// R-01: every keep the kernel can build from a handoff validates in a
/// clash with 12 site or Free City garrisons at the cap.
#[test]
fn cq_keep_states_validate() {
    let t = flat();
    let mut rng = Rng(0x0001_0001);
    let mut cases = 0;
    for guard in [0u32, 100, 300, 15_000, MAX_KEEP_TROOPS] {
        for bps in [0u16, 2_500, 5_000, 9_999, 10_000] {
            for shape in 0..6 {
                let prm = KeepParams {
                    bells: 1,
                    consolidate_bells: 0,
                    home_guard: guard,
                    garrison_bps: bps,
                };
                let mut k = open(ProvinceCoord::new(5, 0), 0, 3, 50, &prm, 0).unwrap();
                assert!(garrison(&k).is_ok());
                // Up to six capturers at the cap, or remainders near MIN.
                let n = 1 + rng.below(6) as usize;
                let mut caps: Vec<(u8, u64, u32)> = (0..n)
                    .map(|i| {
                        let t = match shape {
                            0 => MAX_HOST_TROOPS,
                            1 => MIN_HOST_TROOPS,
                            2 => MIN_HOST_TROOPS * 2 - 1,
                            3 => 1,
                            _ => rng.below(MAX_HOST_TROOPS as u64 + 1) as u32,
                        };
                        (i as u8, 77 + i as u64, t)
                    })
                    .collect();
                let ev = advance(
                    &mut k,
                    5,
                    KeepReport {
                        holders: 1 << 3,
                        defender_present: false,
                    },
                    &prm,
                    &mut caps,
                )
                .unwrap();
                assert!(matches!(ev, KeepEvent::Taken { to: 3, .. }), "{ev:?}");
                assert!(k.troops <= MAX_KEEP_TROOPS);
                let kg = garrison(&k).unwrap();
                let mut gar: Vec<Garrison> = (0..12u8)
                    .map(|i| site_garrison(i, NEUTRAL, i * 4, MAX_HOST_TROOPS))
                    .collect();
                gar.push(kg);
                // The capturers stay on the tile (the donor's rest too).
                let res: Vec<Fighter> = caps
                    .iter()
                    .filter(|c| c.2 > 0)
                    .map(|c| fighter(c.1, 3, c.2, 50, false))
                    .collect();
                let attackers: Vec<Fighter> = (0..6u64)
                    .map(|i| fighter(900 + i, 1, MAX_HOST_TROOPS, 50, true))
                    .collect();
                let (a, b) = run(&t, &res, &gar, &attackers, 6);
                assert!(a.is_ok() && b.is_ok(), "{a:?}");
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 150);
    // A keep above the cap is refused before it reaches a clash.
    let mut k = open(ProvinceCoord::new(5, 0), 0, 3, 50, &KeepParams::DEFAULT, 0).unwrap();
    k.troops = MAX_KEEP_TROOPS + 1;
    assert_eq!(garrison(&k), Err(KeepError::TroopsAboveCap));
    let r = KeepReport {
        holders: 2,
        defender_present: false,
    };
    assert_eq!(
        advance(&mut k, 1, r, &KeepParams::DEFAULT, &mut []),
        Err(KeepError::TroopsAboveCap)
    );
    let big = KeepParams {
        home_guard: MAX_KEEP_TROOPS + 1,
        ..KeepParams::DEFAULT
    };
    assert_eq!(
        try_open(ProvinceCoord::new(5, 0), 0, 3, 50, &big, 0),
        Err(KeepError::TroopsAboveCap)
    );
    assert_eq!(open(ProvinceCoord::new(5, 0), 0, 3, 50, &big, 0), None);
}

// ------------------------------------------------------------ keep kernel (§3.2)

fn hostile(f: u8) -> KeepReport {
    KeepReport {
        holders: 1 << f,
        defender_present: false,
    }
}

const QUIET: KeepReport = KeepReport {
    holders: 0,
    defender_present: false,
};

fn new_keep(p: ProvinceCoord, wedge: u8, prm: &KeepParams) -> Keep {
    open(p, wedge, 3, 20, prm, 144).unwrap()
}

#[test]
fn cq_keep_opens_in_rings_two_and_up_with_the_heartland_flag() {
    let prm = KeepParams::DEFAULT;
    assert_eq!(open(ProvinceCoord::CONCORD, 0, 3, 5, &prm, 0), None);
    for p in ring_provinces(1) {
        assert_eq!(open(p, p.wedge().unwrap(), 3, 5, &prm, 0), None);
    }
    for d in 2..7 {
        for p in ring_provinces(d) {
            let w = p.wedge().unwrap();
            let k = open(p, w, 3, 5, &prm, 288).unwrap();
            assert_eq!(k.holder, w);
            assert_eq!(k.troops, 100);
            assert_eq!(k.required, 72);
            assert_eq!(k.heartland_safe, d <= 3);
            assert_eq!(k.since_bell, 288);
            assert_eq!((k.contender, k.last_taken_from), (NO_FACTION, NO_FACTION));
            assert_eq!(open(p, w, 2, 5, &prm, 0).unwrap().heartland_safe, d == 2);
            assert_eq!(open(p, w, 3, keep::NO_KEEP_TILE, &prm, 0), None);
        }
    }
    let g = garrison(&new_keep(ProvinceCoord::new(5, 0), 0, &prm)).unwrap();
    assert_eq!(g.id, u64::MAX - 0x1_0000);
    assert_eq!(
        (g.faction, g.tile, g.troops, g.walls),
        (0, 20, 100_000, true)
    );
    assert_eq!(g.posture, Posture::Stance(Stance::Hold));
}

#[test]
fn cq_keep_is_taken_at_its_72nd_held_bell() {
    let prm = KeepParams::DEFAULT;
    let mut k = new_keep(ProvinceCoord::new(5, 0), 0, &prm);
    let b0 = 1_000;
    let mut caps = [(4u8, 900u64, 8_000_000u32)];
    assert_eq!(
        advance(&mut k, b0, hostile(2), &prm, &mut caps),
        Ok(KeepEvent::Contest(2))
    );
    assert_eq!((k.contender, k.progress, k.contest_from_bell), (2, 1, b0));
    for b in b0 + 1..b0 + 71 {
        assert_eq!(
            advance(&mut k, b, hostile(2), &prm, &mut caps),
            Ok(KeepEvent::None)
        );
    }
    assert_eq!(k.progress, 71, "not taken after 71 bells (T34)");
    let ev = advance(&mut k, b0 + 71, hostile(2), &prm, &mut caps).unwrap();
    assert_eq!(
        ev,
        KeepEvent::Taken {
            from: 0,
            to: 2,
            garrison: 4_000,
            donor: 4,
            donor_removed: false
        }
    );
    assert_eq!(caps[0].2, 4_000_000, "the donor goes home with the rest");
    assert_eq!(k.holder, 2);
    assert_eq!(k.troops, 4_000);
    assert_eq!(k.gen, 1);
    assert_eq!(k.changes, 1);
    assert_eq!(k.since_bell, b0 + 72);
    assert_eq!(k.consolidated_until_bell, b0 + 72 + 288);
    assert_eq!(k.last_taken_from, 0);
    assert_eq!((k.contender, k.progress), (NO_FACTION, 0));
    // Consolidation: nothing counts until `consolidated_until_bell`.
    for b in b0 + 72..b0 + 360 {
        assert_eq!(
            advance(&mut k, b, hostile(0), &prm, &mut caps),
            Ok(KeepEvent::None)
        );
        assert_eq!(k.contender, NO_FACTION);
    }
    assert_eq!(
        advance(&mut k, b0 + 360, hostile(0), &prm, &mut caps),
        Ok(KeepEvent::Contest(0))
    );
}

#[test]
fn cq_keep_contest_broken_by_a_defender_and_restarted_by_another_faction() {
    let prm = KeepParams::DEFAULT;
    let mut k = new_keep(ProvinceCoord::new(5, 0), 0, &prm);
    for b in 10..40 {
        advance(&mut k, b, hostile(1), &prm, &mut []).unwrap();
    }
    assert_eq!((k.contender, k.progress), (1, 30));
    // A defender arrives: broken.
    let def = KeepReport {
        holders: 1 << 1,
        defender_present: true,
    };
    assert_eq!(
        advance(&mut k, 40, def, &prm, &mut []),
        Ok(KeepEvent::Broken)
    );
    assert_eq!((k.contender, k.progress), (NO_FACTION, 0));
    assert_eq!(advance(&mut k, 41, def, &prm, &mut []), Ok(KeepEvent::None));
    // Another faction the next bell: a new contest from 1.
    assert_eq!(
        advance(&mut k, 42, hostile(4), &prm, &mut []),
        Ok(KeepEvent::Contest(4))
    );
    assert_eq!(k.progress, 1);
    // The hex emptied: broken again.
    assert_eq!(
        advance(&mut k, 43, QUIET, &prm, &mut []),
        Ok(KeepEvent::Broken)
    );
    // A switch of contender restarts at 1.
    advance(&mut k, 44, hostile(4), &prm, &mut []).unwrap();
    advance(&mut k, 45, hostile(4), &prm, &mut []).unwrap();
    assert_eq!(
        advance(&mut k, 46, hostile(5), &prm, &mut []),
        Ok(KeepEvent::Contest(5))
    );
    assert_eq!((k.contender, k.progress, k.contest_from_bell), (5, 1, 46));
    // The holder's own bit in `holders` is ignored.
    let own = KeepReport {
        holders: 1,
        defender_present: false,
    };
    assert_eq!(
        advance(&mut k, 47, own, &prm, &mut []),
        Ok(KeepEvent::Broken)
    );
}

#[test]
fn cq_keep_in_a_heartland_never_counts_and_m3_pause_is_reported_once() {
    let prm = KeepParams::DEFAULT;
    let mut k = new_keep(ProvinceCoord::new(2, 0), 0, &prm);
    assert!(k.heartland_safe);
    for b in 0..500 {
        assert_eq!(
            advance(&mut k, b, hostile(3), &prm, &mut []),
            Ok(KeepEvent::None)
        );
        assert_eq!((k.contender, k.progress, k.holder), (NO_FACTION, 0, 0));
    }
    // Two hostile factions on one hex cannot happen under Rivalry; the
    // kernel keeps the M3 rule: pause, keep progress, report on entry.
    let mut k = new_keep(ProvinceCoord::new(5, 0), 0, &prm);
    for b in 0..10 {
        advance(&mut k, b, hostile(1), &prm, &mut []).unwrap();
    }
    let two = KeepReport {
        holders: 0b110,
        defender_present: false,
    };
    assert_eq!(
        advance(&mut k, 10, two, &prm, &mut []),
        Ok(KeepEvent::Paused)
    );
    assert_eq!(advance(&mut k, 11, two, &prm, &mut []), Ok(KeepEvent::None));
    assert!(k.paused);
    assert_eq!((k.contender, k.progress), (1, 10));
    assert_eq!(
        advance(&mut k, 12, hostile(1), &prm, &mut []),
        Ok(KeepEvent::None)
    );
    assert_eq!((k.progress, k.paused), (11, false));
}

#[test]
fn cq_keep_donor_handoff_follows_the_simulator() {
    let prm = KeepParams::DEFAULT;
    let take = |caps: &mut [(u8, u64, u32)], prm: &KeepParams| {
        let mut k = new_keep(ProvinceCoord::new(6, 0), 0, prm);
        k.troops = 0; // a keep with an empty garrison still needs its bells
        let p1 = KeepParams { bells: 1, ..*prm };
        let mut k1 = Keep { required: 1, ..k };
        let ev = advance(&mut k1, 9, hostile(2), &p1, caps).unwrap();
        (k1, ev)
    };
    // Six 30,000-troop capturers: the donor alone pays (most troops, then
    // the lowest host id).
    let mut six: Vec<(u8, u64, u32)> = (0..6)
        .map(|i| (10 + i as u8, 500 - i as u64, MAX_HOST_TROOPS))
        .collect();
    let (k, ev) = take(&mut six, &prm);
    assert_eq!(
        ev,
        KeepEvent::Taken {
            from: 0,
            to: 2,
            garrison: 15_000,
            donor: 15,
            donor_removed: false
        }
    );
    assert_eq!(k.troops, 15_000);
    assert_eq!(six[5].2, 15_000_000);
    assert!(
        six[..5].iter().all(|c| c.2 == MAX_HOST_TROOPS),
        "others stay"
    );
    // A rest below MIN_HOST_TROOPS joins the keep; the donor is removed.
    let mut small = [(3u8, 1u64, 150_000u32), (4, 2, 149_999)];
    let (k, ev) = take(&mut small, &prm);
    assert_eq!(
        ev,
        KeepEvent::Taken {
            from: 0,
            to: 2,
            garrison: 150,
            donor: 3,
            donor_removed: true
        }
    );
    assert_eq!((k.troops, small[0].2, small[1].2), (150, 0, 149_999));
    // Exactly MIN_HOST_TROOPS left: the donor goes home.
    let mut edge = [(0u8, 1u64, 200_000u32)];
    let (k, ev) = take(&mut edge, &prm);
    assert!(matches!(
        ev,
        KeepEvent::Taken {
            garrison: 100,
            donor_removed: false,
            ..
        }
    ));
    assert_eq!((k.troops, edge[0].2), (100, 100_000));
    // Sub-troop rounding: the keep floors, the donor keeps the fraction.
    let mut frac = [(0u8, 1u64, 1_234_567u32)];
    let (k, _) = take(&mut frac, &prm);
    assert_eq!((k.troops, frac[0].2), (617, 1_234_567 - 617_000));
    // 100%: the whole donor joins.
    let all = KeepParams {
        garrison_bps: 10_000,
        ..prm
    };
    let mut one = [(7u8, 1u64, MAX_HOST_TROOPS)];
    let (k, ev) = take(&mut one, &all);
    assert!(matches!(
        ev,
        KeepEvent::Taken {
            garrison: 30_000,
            donor: 7,
            donor_removed: true,
            ..
        }
    ));
    assert_eq!(k.troops, MAX_KEEP_TROOPS);
    // No capturer given (never in an honest input): an empty keep.
    let (k, ev) = take(&mut [], &prm);
    assert!(matches!(
        ev,
        KeepEvent::Taken {
            garrison: 0,
            donor: 0xFF,
            ..
        }
    ));
    assert_eq!(k.troops, 0);
    // A capturer above the cap is refused.
    let mut bad = [(0u8, 1u64, MAX_HOST_TROOPS + 1)];
    let mut k = Keep {
        required: 1,
        ..new_keep(ProvinceCoord::new(6, 0), 0, &prm)
    };
    assert_eq!(
        advance(&mut k, 3, hostile(1), &prm, &mut bad),
        Err(KeepError::TroopsAboveCap)
    );
    // lead_host is the same rule.
    assert_eq!(lead_host(&[(1, 9, 5), (2, 3, 5), (3, 1, 4)]), Some(2));
    assert_eq!(lead_host(&[]), None);
}

fn random_keep(rng: &mut Rng) -> Keep {
    let holder = rng.below(6) as u8;
    let contender = if rng.chance(40) {
        let c = rng.below(6) as u8;
        if c == holder {
            NO_FACTION
        } else {
            c
        }
    } else {
        NO_FACTION
    };
    let required = 1 + rng.below(80) as u8;
    Keep {
        tile: 20,
        holder,
        contender,
        progress: if contender == NO_FACTION {
            0
        } else {
            rng.below(required as u64) as u8
        },
        required,
        heartland_safe: rng.chance(10),
        paused: false,
        changes: rng.below(5) as u16,
        troops: rng.below(2_000) as u32,
        since_bell: 0,
        consolidated_until_bell: if rng.chance(30) {
            rng.below(400) as u32
        } else {
            0
        },
        contest_from_bell: 0,
        gen: rng.below(4) as u32,
        last_taken_from: NO_FACTION,
    }
}

/// The closed form over a quiet run equals the bell-by-bell contest.
#[test]
fn cq_keep_quiet_equals_bells() {
    let mut rng = Rng(0x4B45_4550);
    let mut takes = 0;
    for _ in 0..20_000 {
        let k0 = random_keep(&mut rng);
        let prm = KeepParams {
            bells: k0.required,
            consolidate_bells: rng.below(300) as u32,
            home_guard: 100,
            garrison_bps: rng.below(10_001) as u16,
        };
        let mask = match rng.below(5) {
            0 => 0,
            1 => 1 << k0.holder,
            2 => (1 << rng.below(6)) as u8,
            3 => ((1 << rng.below(6)) | (1 << rng.below(6))) as u8,
            _ => rng.below(64) as u8,
        };
        let b0 = rng.below(300) as u32;
        let b1 = b0 + rng.below(400) as u32;
        let caps0: Vec<(u8, u64, u32)> = (0..rng.below(4))
            .map(|i| {
                (
                    i as u8,
                    rng.below(9),
                    rng.below(MAX_HOST_TROOPS as u64) as u32,
                )
            })
            .collect();
        // Bell by bell.
        let (mut k1, mut c1) = (k0, caps0.clone());
        let mut ev1 = Vec::new();
        let mut through = b1;
        for b in b0..=b1 {
            let r = KeepReport::from_mask(mask, k1.holder);
            let e = advance(&mut k1, b, r, &prm, &mut c1).unwrap();
            if e != KeepEvent::None {
                ev1.push((b, e));
            }
            if matches!(e, KeepEvent::Taken { .. }) {
                through = b;
                takes += 1;
                break;
            }
        }
        // Closed form.
        let (mut k2, mut c2) = (k0, caps0.clone());
        let q = advance_quiet(&mut k2, b0, b1, mask, &prm, &mut c2).unwrap();
        assert_eq!(q.through, through, "{k0:?} {mask:b} {b0}..{b1}");
        assert_eq!(q.events, ev1, "{k0:?} {mask:b} {b0}..{b1}");
        assert_eq!(k2, k1, "{k0:?} {mask:b} {b0}..{b1}");
        assert_eq!(c2, c1);
    }
    assert!(takes > 1_000, "{takes}");
}

// ------------------------------------------------------------ control (§3.3, §3.10)

#[test]
fn cq_controller_is_the_strict_majority_rule() {
    let mut rng = Rng(7);
    for _ in 0..50_000 {
        let w: [u32; SIDES] = core::array::from_fn(|_| match rng.below(4) {
            0 => 0,
            1 => rng.below(4) as u32,
            _ => rng.below(3_600) as u32,
        });
        let total: u64 = w.iter().map(|&x| x as u64).sum();
        let want = if total == 0 {
            Controller::Unsettled
        } else {
            let winners: Vec<usize> = (0..SIDES)
                .filter(|&s| 2 * w[s] as u64 >= total && (0..SIDES).all(|t| t == s || w[t] < w[s]))
                .collect();
            match winners[..] {
                [s] => Controller::Side(s as u8),
                [] => Controller::Contested,
                _ => unreachable!(),
            }
        };
        assert_eq!(controller(&w), want, "{w:?}");
    }
    // Exact ties are contested; exactly half and strictly ahead wins.
    assert_eq!(controller(&[3, 3, 0, 0, 0, 0, 0]), Controller::Contested);
    assert_eq!(controller(&[3, 2, 1, 0, 0, 0, 0]), Controller::Side(0));
    assert_eq!(controller(&[0, 0, 0, 0, 0, 0, 1]), Controller::Side(6));
}

#[test]
fn cq_site_weight_centi_is_the_strength_weight_in_snapshot_units() {
    for tier in [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold] {
        for g in [0u32, 1, 999_999, 1_000_000, 2_000_000, MAX_HOST_TROOPS] {
            for order in 0..=4u8 {
                let w = site_weight_centi(tier, g, order);
                let want = strength_weight(tier, g, order.saturating_sub(1)) / 10_000;
                assert_eq!(w as u64, want);
                assert!((25..=300).contains(&w));
            }
        }
    }
    // A full province fits u16 per side (§3.14: ≤ 3,600).
    assert_eq!(site_weight_centi(Tier::Stronghold, MAX_HOST_TROOPS, 1), 300);
    assert!(12 * 300 <= u16::MAX as u32);
    assert_eq!(
        site_weight_centi(Tier::Hamlet, 300_000, 1),
        115,
        "a Free City"
    );
    assert_eq!(control::tier_from_u8(2), Some(Tier::City));
    assert_eq!(control::tier_from_u8(4), None);
}

#[test]
fn cq_province_control_and_march_banner() {
    let k = |h: u8| keep::Keep {
        holder: h,
        ..open(ProvinceCoord::new(5, 0), 0, 3, 3, &KeepParams::DEFAULT, 0).unwrap()
    };
    assert_eq!(province_control(None, 0, None), ProvinceControl::Neutral);
    assert_eq!(province_control(None, 1, Some(4)), ProvinceControl::Seat(4));
    assert_eq!(province_control(None, 1, None), ProvinceControl::Unopened);
    assert_eq!(
        province_control(Some(&k(3)), 5, None),
        ProvinceControl::Keep(3)
    );
    assert_eq!(province_control(None, 5, None), ProvinceControl::Unopened);
    assert_eq!(ProvinceControl::Keep(3).code(), 3);
    assert_eq!(ProvinceControl::Seat(2).code(), 2);
    assert_eq!(ProvinceControl::Neutral.code(), 6);
    assert_eq!(ProvinceControl::Unopened.code(), 7);
    use ProvinceControl::*;
    let u = Unopened;
    assert_eq!(march_banner(&[u; 7]), Banner::None);
    assert_eq!(
        march_banner(&[Seat(1), Neutral, u, u, u, u, u]),
        Banner::None
    );
    assert_eq!(
        march_banner(&[Keep(1), u, u, u, u, u, u]),
        Banner::Faction(1)
    );
    assert_eq!(
        march_banner(&[Keep(1), Keep(2), u, u, u, u, u]),
        Banner::Contested
    );
    assert_eq!(
        march_banner(&[Keep(1), Keep(2), Keep(1), Seat(2), Seat(2), u, u]),
        Banner::Faction(1),
        "Seats never count"
    );
    assert_eq!(
        march_banner(&[Keep(1), Keep(1), Keep(1), Keep(2), Keep(2), Keep(3), u]),
        Banner::Contested,
        "3 of 6 is not more than half"
    );
    assert_eq!(
        march_banner(&[
            Keep(1),
            Keep(1),
            Keep(1),
            Keep(1),
            Keep(2),
            Keep(2),
            Keep(3)
        ]),
        Banner::Faction(1)
    );
    assert_eq!(Banner::Contested.code(), 7);
    assert_eq!(Banner::None.code(), 7);
    assert_eq!(Banner::Faction(5).code(), 5);
}

/// The criterion-10 cases, shared with the vectors (and through them with
/// the web's `controlChanges` and the stack report).
/// (name, series, min_bells, expected changes).
type LastingCase = (&'static str, Vec<(u32, [u8; 3])>, u32, Vec<Change>);

fn lasting_cases() -> Vec<LastingCase> {
    let ch = |province, bell, from, to| Change {
        province,
        bell,
        from,
        to,
    };
    let series = |rows: &[(u32, [u8; 3])]| rows.to_vec();
    vec![
        (
            "a change that stays 6 bells counts",
            series(&[
                (10, [0, 1, 2]),
                (11, [3, 1, 2]),
                (12, [3, 1, 2]),
                (13, [3, 1, 2]),
                (14, [3, 1, 2]),
                (15, [3, 1, 2]),
                (16, [3, 1, 2]),
            ]),
            6,
            vec![ch(0, 11, 0, 3)],
        ),
        (
            "flicker does not count; the last change holds to the end",
            series(&[
                (10, [0, 1, 2]),
                (11, [3, 1, 2]),
                (12, [0, 1, 2]),
                (13, [3, 1, 2]),
                (14, [0, 1, 2]),
                (15, [3, 1, 2]),
                (16, [3, 1, 2]),
            ]),
            6,
            vec![ch(0, 15, 0, 3)],
        ),
        (
            "neutral and unopened are not factions",
            series(&[
                (0, [7, 6, 2]),
                (1, [4, 1, 6]),
                (2, [4, 1, 6]),
                (3, [4, 1, 6]),
                (4, [4, 1, 6]),
                (5, [4, 1, 6]),
                (6, [4, 1, 6]),
                (7, [4, 1, 6]),
            ]),
            6,
            vec![],
        ),
        (
            "a change near the end counts to the end",
            series(&[
                (100, [0, 1, 2]),
                (101, [0, 1, 2]),
                (102, [0, 5, 2]),
                (103, [0, 5, 2]),
            ]),
            6,
            vec![ch(1, 102, 1, 5)],
        ),
        (
            "gaps: only entries inside the window are compared",
            series(&[
                (10, [0, 1, 2]),
                (20, [1, 1, 2]),
                (25, [2, 1, 2]),
                (26, [2, 1, 2]),
            ]),
            6,
            vec![ch(0, 25, 1, 2)],
        ),
        (
            "two provinces in one bell, sorted by province",
            series(&[(0, [0, 1, 2]), (1, [5, 1, 4]), (2, [5, 1, 4])]),
            2,
            vec![ch(0, 1, 0, 5), ch(2, 1, 2, 4)],
        ),
    ]
}

#[test]
fn cq_lasting_changes_on_hand_built_series() {
    for (name, s, min, want) in lasting_cases() {
        assert_eq!(lasting_changes(&s, min), want, "{name}");
        // The dynamic form gives the same.
        let dynamic: Vec<(u32, Vec<u8>)> = s.iter().map(|(b, m)| (*b, m.to_vec())).collect();
        assert_eq!(lasting_changes(&dynamic, min), want, "{name} (Vec)");
    }
    assert!(lasting_changes::<[u8; 3]>(&[], 6).is_empty());
}

#[test]
fn cq_banner_changes_pass_through_contested_intervals() {
    use Banner::*;
    let s = [
        (0, None),
        (1, Faction(2)),
        (2, Contested),
        (3, Contested),
        (4, Faction(2)),
        (5, Contested),
        (6, Faction(3)),
        (7, None),
        (8, Faction(1)),
    ];
    assert_eq!(
        banner_changes(&s),
        vec![
            BannerChange {
                bell: 6,
                from: 2,
                to: 3
            },
            BannerChange {
                bell: 8,
                from: 3,
                to: 1
            }
        ]
    );
}

fn call_map() -> ControlMap {
    // Faction 0 holds ring-4 provinces of wedge 0; faction 1 holds the
    // ring-4 provinces of wedge 1 (contestable); faction 5 holds one.
    let mut provinces = Vec::new();
    for p in ring_provinces(4) {
        let w = p.wedge().unwrap();
        let f = w;
        provinces.push(MapProvince {
            coord: p,
            control: ProvinceControl::Keep(if p == ProvinceCoord::new(-4, 0).rotate_by(0) {
                5
            } else {
                f
            }),
            contestable: true,
        });
    }
    ControlMap {
        provinces,
        // The faction that lost (−4, 0) to faction 5 rallies to it.
        recently_lost: vec![(
            ProvinceCoord::new(-4, 0).wedge().unwrap(),
            march_of(ProvinceCoord::new(-4, 0)),
        )],
    }
}

#[test]
fn cq_herald_call_is_deterministic_and_rallies_the_smallest() {
    let map = call_map();
    let seed = [3u8; 32];
    let a = herald_call_detail(&map, &seed);
    assert_eq!(a, herald_call_detail(&map, &seed));
    assert_eq!(herald_call(&map, &seed), a.map(|c| c.map(|c| c.march)));
    // The faction with the fewest provinces rallies to its lost March.
    let counts: Vec<usize> = (0..6u8)
        .map(|f| {
            map.provinces
                .iter()
                .filter(|p| p.control.faction() == Some(f))
                .count()
        })
        .collect();
    let fewest = (0..6u8).min_by_key(|&f| (counts[f as usize], f)).unwrap();
    assert_eq!(fewest, ProvinceCoord::new(-4, 0).wedge().unwrap());
    assert_eq!(
        a[fewest as usize],
        Some(control::Call {
            march: march_of(ProvinceCoord::new(-4, 0)),
            rally: true
        })
    );
    let mut m2 = map.clone();
    let lost = march_of(ProvinceCoord::new(0, 4));
    m2.recently_lost = vec![(fewest, lost)];
    let b = herald_call_detail(&m2, &seed);
    assert_eq!(b[fewest as usize].unwrap().march, lost);
    assert!(b[fewest as usize].unwrap().rally);
    // Every ordinary call names a March with an enemy contestable keep
    // within 2 provinces of the faction's land.
    for f in 0..6u8 {
        if let Some(c) = a[f as usize] {
            if c.rally {
                continue;
            }
            assert!(map.provinces.iter().any(|p| march_of(p.coord) == c.march
                && matches!(p.control, ProvinceControl::Keep(g) if g != f)));
        }
    }
    // Nothing contestable: no ordinary call.
    let mut m3 = map.clone();
    for p in &mut m3.provinces {
        p.contestable = false;
    }
    m3.recently_lost.clear();
    assert_eq!(herald_call(&m3, &seed), [None; 6]);
}

// ------------------------------------------------------------ siege v3 (§3.4–§3.6)

fn check_v3() -> SiegeCheckV3 {
    SiegeCheckV3 {
        province: ProvinceCoord::new(5, 0),
        kind: HoldingKind::Other,
        owner_faction: 0,
        attacker_faction: 1,
        relation: Relation::Rivalry,
        march_hostility: false,
        march_truce: false,
        founded_ts: GENESIS + 3_600,
        shield_until: GENESIS + 3_600 + 7_200,
        dormant: false,
        attacker_nearby: false,
        now: GENESIS + 86_400,
        heartland_max_ring: 3,
        frontier_protect_secs: 129_600,
        frontier_protect_after_secs: 43_200,
        genesis_ts: GENESIS,
    }
}

#[test]
fn cq_may_besiege_v3_uses_the_season_parameters() {
    let c = check_v3();
    assert_eq!(may_besiege_v3(&c), Ok(()));
    let with = |f: &dyn Fn(&mut SiegeCheckV3)| {
        let mut x = check_v3();
        f(&mut x);
        may_besiege_v3(&x)
    };
    assert_eq!(
        with(&|x| x.attacker_faction = 0),
        Err(SiegeRefusal::Friendly)
    );
    assert_eq!(
        with(&|x| x.attacker_faction = 7),
        Err(SiegeRefusal::BadFaction)
    );
    assert_eq!(
        with(&|x| x.province = ProvinceCoord::new(1, 0)),
        Err(SiegeRefusal::Seat)
    );
    assert_eq!(
        with(&|x| x.now = x.shield_until - 1),
        Err(SiegeRefusal::Shielded)
    );
    assert_eq!(
        with(&|x| {
            x.now = x.shield_until - 1;
            x.dormant = true
        }),
        Ok(())
    );
    // Heartland as a parameter: ring 3 of the owner's wedge.
    let r3 = |x: &mut SiegeCheckV3| x.province = ProvinceCoord::new(3, 0);
    assert_eq!(with(&r3), Err(SiegeRefusal::Heartland));
    assert_eq!(
        with(&|x| {
            r3(x);
            x.heartland_max_ring = 2
        }),
        Ok(())
    );
    assert_eq!(
        with(&|x| {
            r3(x);
            x.relation = Relation::War
        }),
        Ok(()),
        "M3 lever kept"
    );
    // Frontier protection: founded after 12 h, for 36 h after the shield,
    // only for a faction with a first holding nearby.
    let late = |x: &mut SiegeCheckV3| {
        x.founded_ts = GENESIS + 43_201;
        x.shield_until = x.founded_ts + 86_400;
        x.now = x.shield_until + 129_599;
    };
    assert_eq!(with(&late), Err(SiegeRefusal::FrontierProtected));
    assert_eq!(
        with(&|x| {
            late(x);
            x.attacker_nearby = true
        }),
        Ok(())
    );
    assert_eq!(
        with(&|x| {
            late(x);
            x.now += 1
        }),
        Ok(())
    );
    assert_eq!(
        with(&|x| {
            late(x);
            x.founded_ts = GENESIS + 43_200
        }),
        Ok(()),
        "founded at exactly 12 h is not late"
    );
    assert_eq!(
        with(&|x| {
            late(x);
            x.frontier_protect_secs = 0
        }),
        Ok(()),
        "MC_TEST: no Frontier protection"
    );
    // A Free City skips every protection.
    assert_eq!(
        with(&|x| {
            x.kind = HoldingKind::FreeCity;
            x.owner_faction = NEUTRAL;
            x.province = ProvinceCoord::new(2, 0);
            x.now = 0
        }),
        Ok(())
    );
}

fn report(holders: u8, defender: bool) -> BellReport {
    BellReport {
        holders,
        defender_present: defender,
    }
}

#[test]
fn cq_siege_v3_is_declared_from_the_hex_and_fails_at_the_first_unheld_bell() {
    // No start window: the first counted bell without the hex fails it.
    let mut s = SiegeV3::declare(2, 100, 0, 0);
    assert_eq!(s.required, 36);
    assert_eq!(
        s.advance(101, GENESIS, report(0, false), None),
        SiegeStatus::Failed
    );
    assert_eq!(
        s.advance(102, GENESIS, report(4, false), None),
        SiegeStatus::Failed
    );
    // A Free City has no vigil: 36 held bells complete it.
    let mut s = SiegeV3::declare(2, 100, 0, 0);
    for b in 101..136 {
        assert_eq!(s.advance(b, 0, report(4, false), None), SiegeStatus::Active);
    }
    assert_eq!(
        s.advance(136, 0, report(4, false), None),
        SiegeStatus::Completed
    );
    // A defender pauses; a third faction holding the hex fails it.
    let mut s = SiegeV3::declare(1, 0, 600, 0);
    assert_eq!(s.required, 48);
    assert_eq!(s.advance(1, 0, report(2, true), None), SiegeStatus::Active);
    assert_eq!(s.progress, 0);
    assert_eq!(s.advance(2, 0, report(8, false), None), SiegeStatus::Failed);
    // The vigil pauses progress, never fails it.
    let v = Vigil::new(0).unwrap();
    let mut s = SiegeV3::declare(1, 0, 0, 0);
    let start = |b: u32| GENESIS + 600 * b as i64;
    let mut paused = 0;
    let mut b = 1;
    while s.status == SiegeStatus::Active {
        let before = s.progress;
        s.advance(b, start(b), report(2, false), Some(&v));
        paused += (s.progress == before && s.status == SiegeStatus::Active) as u32;
        b += 1;
    }
    assert_eq!(s.status, SiegeStatus::Completed);
    assert_eq!(b - 1 - paused, 36);
    assert_eq!(b - 1, earliest_completion_bell(36, Some(&v), 1, GENESIS));
    // Settled sieges do not move.
    assert_eq!(
        s.advance(b, start(b), report(0, false), Some(&v)),
        SiegeStatus::Completed
    );
}

fn random_vigil(rng: &mut Rng, around: i64) -> Vigil {
    let mut v = Vigil::new(rng.below(86_400) as u32).unwrap();
    for _ in 0..rng.below(3) {
        let at = around + rng.below(4 * 86_400) as i64 - 2 * 86_400;
        let _ = v.request_change(at, rng.below(86_400) as u32);
    }
    v
}

#[test]
fn cq_siege_v3_quiet_equals_bells() {
    let mut rng = Rng(0x5133);
    for _ in 0..4_000 {
        let required = 36 + rng.below(25) as u8;
        let mut s0 = SiegeV3::declare(1, 0, 0, 0);
        s0.required = required;
        s0.progress = rng.below(required as u64) as u8;
        let b0 = 1 + rng.below(2_000) as u32;
        let b1 = b0 + rng.below(500) as u32;
        let vigil = if rng.chance(25) {
            None
        } else {
            Some(random_vigil(&mut rng, GENESIS + 600 * b0 as i64))
        };
        let r = match rng.below(4) {
            0 => report(0, false),
            1 => report(2, true),
            2 => report(4, false),
            _ => report(2, false),
        };
        let mut s1 = s0;
        let mut end = b1;
        for b in b0..=b1 {
            let st = s1.advance(b, GENESIS + 600 * b as i64, r, vigil.as_ref());
            if st != SiegeStatus::Active {
                end = b;
                break;
            }
        }
        let mut s2 = s0;
        let (st, e) = s2.advance_quiet(b0, b1, GENESIS, r, vigil.as_ref());
        assert_eq!((st, e), (s1.status, end));
        assert_eq!(s2, s1);
    }
}

/// R-08: any 288 consecutive bells hold ≥ 96 bells outside a vigil with
/// pending changes (the O(1) path of `can_complete_before`).
#[test]
fn cq_vigil_window_bound() {
    let mut rng = Rng(0x0288);
    let mut min_seen = u32::MAX;
    for _ in 0..600 {
        let base = rng.below(20_000) as u32;
        let v = random_vigil(&mut rng, GENESIS + 600 * base as i64 + 86_400);
        for _ in 0..20 {
            let b0 = base + rng.below(1_500) as u32;
            let outside = (b0..b0 + VIGIL_WINDOW_BOUND)
                .filter(|&b| !v.covers(GENESIS + 600 * b as i64))
                .count() as u32;
            min_seen = min_seen.min(outside);
            assert!(outside >= VIGIL_WINDOW_MIN_OUTSIDE, "{outside} {v:?} {b0}");
            assert_eq!(outside, bells_outside_vigil(&v, GENESIS, b0, b0 + 288));
        }
    }
    println!("min bells outside a vigil in 288: {min_seen}");
    assert!(min_seen >= 192, "CL-09: ≤ 48 covered in any 144");
}

/// R-08: `can_complete_before` is exact and makes ≤ 287 `covers()` calls.
#[test]
fn cq_covers_bound() {
    let mut rng = Rng(0xC0DE);
    let mut max_calls = 0;
    for _ in 0..20_000 {
        let from = rng.below(30_000) as u32;
        let range = match rng.below(3) {
            0 => rng.below(288),
            1 => 280 + rng.below(16),
            _ => rng.below(5_000),
        } as u32;
        let end = from + range;
        let required = if rng.chance(90) {
            36 + rng.below(49) as u8
        } else {
            rng.below(256) as u8
        };
        let v = random_vigil(&mut rng, GENESIS + 600 * from as i64);
        let vigil = if rng.chance(10) { None } else { Some(&v) };
        let mut calls = 0;
        let got = can_complete_before_counted(required, vigil, from, end, GENESIS, &mut calls);
        assert!(calls <= 287, "{calls}");
        max_calls = max_calls.max(calls);
        let brute = (from..end)
            .filter(|&b| vigil.is_none_or(|v| !v.covers(GENESIS + 600 * b as i64)))
            .count() as u32
            >= required as u32;
        assert_eq!(got, brute, "{required} {from}..{end}");
        assert_eq!(
            can_complete_before(required, vigil, from, end, GENESIS),
            got
        );
        // The earliest completion bell agrees with the brute force.
        if required > 0 {
            let e = earliest_completion_bell(required, vigil, from, GENESIS);
            let n = (from..=e)
                .filter(|&b| vigil.is_none_or(|v| !v.covers(GENESIS + 600 * b as i64)))
                .count() as u32;
            assert_eq!(n, required as u32);
            assert!(vigil.is_none_or(|v| !v.covers(GENESIS + 600 * e as i64)));
            assert_eq!(e < end, got);
        }
    }
    assert!(max_calls >= 200, "the scan path ran ({max_calls})");
    assert_eq!(earliest_completion_bell(0, None, 10, GENESIS), 9);
}

#[test]
fn cq_occupation_respite_immunity_and_credit() {
    use OccupationEndKind::*;
    // Tenure precedes liberation at the same bell.
    let e = occupation_ends(false, false, 172, 100, 72).unwrap();
    assert_eq!((e.kind, e.respite), (Expired, true));
    assert_eq!(occupation_ends(true, false, 171, 100, 72), None);
    let e = occupation_ends(false, true, 150, 100, 72).unwrap();
    assert_eq!(
        (e.kind, e.respite),
        (Liberated, true),
        "owner's own liberation"
    );
    let e = occupation_ends(false, false, 150, 100, 72).unwrap();
    assert_eq!(
        (e.kind, e.respite),
        (Liberated, false),
        "walked away: no Respite"
    );
    // Immunity bars only the recorded faction, or all after a capture.
    assert!(immunity_bars(2, 50, 2, 49));
    assert!(!immunity_bars(2, 50, 2, 50));
    assert!(!immunity_bars(2, 50, 3, 10));
    assert!(immunity_bars(BARRED_ALL, 50, 3, 10));
    assert!(!immunity_bars(BARRED_NONE, 50, 3, 10));
    // Broken by the defender only with a defender present.
    assert!(broken_by_defender(report(0, true)));
    assert!(broken_by_defender(report(4, true)));
    assert!(!broken_by_defender(report(0, false)), "a deserted siege");
    assert!(!broken_by_defender(report(8, false)), "a third faction");
    // Capture credit (K-26): b + 1 − 6·held_since_hour ≥ min.
    assert!(capture_credited(143, 0, 144, false));
    assert!(!capture_credited(142, 0, 144, false));
    assert!(capture_credited(149, 1, 144, false));
    assert!(!capture_credited(148, 1, 144, false));
    assert!(
        !capture_credited(0, 400, 1, false),
        "held from a later hour"
    );
    assert!(capture_credited(0, 400, 288, true), "a genesis Free City");
    assert_eq!(held_since_hour_from(0), 0);
    assert_eq!(held_since_hour_from(1), 1);
    assert_eq!(held_since_hour_from(6), 1);
    assert_eq!(held_since_hour_from(7), 2);
    assert_eq!(held_since_hour_from(u32::MAX), u16::MAX);
    assert_eq!(siege::SIEGE_VERSION, 2, "M1 value kept");
    assert_eq!(siege::SIEGE_VERSION_V3, 3);
}

// ------------------------------------------------------------ holding v3 (§3.6, §3.8, §3.12)

fn outpost() -> OutpostCheck {
    OutpostCheck {
        slot: Some(2),
        first_final: true,
        first_tier: HTier::Town,
        tier_min: HTier::Town,
        slot2_final: false,
        target_ring: 4,
        heartland_max_ring: 3,
        range: 3,
        outpost_range: 3,
        faction_weight: 49,
        province_weight: 100,
        outpost_share_bps: 5_000,
        free_sites: 20,
        open_sites: 100,
        now_bell: 983,
        end_bell: 1_008,
        outpost_close_bells: 24,
    }
}

#[test]
fn cq_outpost_rules_in_order() {
    use OutpostRefusal::*;
    assert_eq!(may_found_outpost(&outpost()), Ok(()));
    let with = |f: &dyn Fn(&mut OutpostCheck)| {
        let mut c = outpost();
        f(&mut c);
        may_found_outpost(&c)
    };
    assert_eq!(with(&|c| c.slot = None), Err(HoldingsFull));
    assert_eq!(with(&|c| c.slot = Some(1)), Err(HoldingsFull));
    assert_eq!(with(&|c| c.first_final = false), Err(Prerequisite));
    assert_eq!(with(&|c| c.first_tier = HTier::Hamlet), Err(Prerequisite));
    assert_eq!(
        with(&|c| {
            c.first_tier = HTier::Hamlet;
            c.tier_min = HTier::Hamlet
        }),
        Ok(()),
        "MC_TEST"
    );
    assert_eq!(with(&|c| c.slot = Some(3)), Err(Prerequisite));
    assert_eq!(
        with(&|c| {
            c.slot = Some(3);
            c.slot2_final = true
        }),
        Ok(())
    );
    assert_eq!(with(&|c| c.target_ring = 3), Err(Ring));
    assert_eq!(with(&|c| c.range = 4), Err(Range));
    assert_eq!(with(&|c| c.faction_weight = 50), Err(Share));
    assert_eq!(
        with(&|c| {
            c.faction_weight = 0;
            c.province_weight = 0
        }),
        Ok(()),
        "an empty province qualifies"
    );
    assert_eq!(with(&|c| c.free_sites = 19), Err(LandGate));
    assert_eq!(with(&|c| c.now_bell = 984), Err(Close));
    // Order: count before everything.
    assert_eq!(
        with(&|c| {
            c.slot = None;
            c.target_ring = 2;
            c.now_bell = 2_000
        }),
        Err(HoldingsFull)
    );
}

#[test]
fn cq_slots_capture_effects_and_lifecycle() {
    assert_eq!(lowest_free_slot([true, false, false], 0, 0), Some(2));
    assert_eq!(lowest_free_slot([true, true, false], 0, 0), Some(3));
    assert_eq!(lowest_free_slot([true, false, false], 2, 0), Some(3));
    assert_eq!(lowest_free_slot([true, false, false], 0, 0b01), Some(3));
    assert_eq!(lowest_free_slot([true, false, false], 0, 0b11), None);
    assert_eq!(lowest_free_slot([true, false, true], 2, 0), None);
    assert_eq!(lowest_free_slot([true, true, true], 0, 0), None);
    // Captures: walls halved, kept by Iron; garrison and reserve lost.
    let mut h = Holding::found(GENESIS, 0, 2);
    h.walls = 601;
    h.tier = HTier::City;
    let iron = DOCTRINES
        .iter()
        .find(|d| d.keeps_walls_on_capture)
        .copied()
        .unwrap();
    let e = capture_effects(&h, doctrine::NEUTRAL);
    assert_eq!(
        (e.walls, e.garrison, e.reserve, e.tier),
        (300, 0, 0, HTier::City)
    );
    assert!(e.queue_kept);
    assert_eq!(e.shield_until, 0);
    assert_eq!(capture_effects(&h, iron).walls, 601);
    h.walls = 99_999;
    assert_eq!(capture_effects(&h, iron).walls, holding::MAX_WALLS);
    // Lifecycle timers.
    let f7 = LifecycleParams::FRONTIER_7;
    assert_eq!(f7.shield_secs_for(1, GENESIS, GENESIS), 86_400);
    assert_eq!(f7.shield_secs_for(2, GENESIS, GENESIS), 7_200);
    let f28 = LifecycleParams::FRONTIER_28;
    assert_eq!(f28.shield_secs_for(1, GENESIS + 604_799, GENESIS), 172_800);
    assert_eq!(f28.shield_secs_for(1, GENESIS + 604_800, GENESIS), 259_200);
    assert!(!f7.is_dormant(GENESIS, GENESIS + 259_199));
    assert!(f7.is_dormant(GENESIS, GENESIS + 259_200));
    assert!(
        !f7.is_released(1, GENESIS, GENESIS + 604_799),
        "no release in 7 days"
    );
    assert!(f7.is_released(1, GENESIS, GENESIS + 604_800));
    assert!(
        !f28.is_released(2, GENESIS, GENESIS + 10_000_000),
        "first holdings only"
    );
    assert_eq!(holding::HOLDING_VERSION, 2);
    assert_eq!(holding::HOLDING_VERSION_V3, 3);
}

// ------------------------------------------------------------ vectors

fn keep_json(k: &Keep) -> String {
    format!(
        "{{\"tile\": {}, \"holder\": {}, \"contender\": {}, \"progress\": {}, \"required\": {}, \"heartland_safe\": {}, \"paused\": {}, \"changes\": {}, \"troops\": {}, \"since_bell\": {}, \"consolidated_until_bell\": {}, \"contest_from_bell\": {}, \"gen\": {}, \"last_taken_from\": {}}}",
        k.tile,
        k.holder,
        k.contender,
        k.progress,
        k.required,
        k.heartland_safe,
        k.paused,
        k.changes,
        k.troops,
        k.since_bell,
        k.consolidated_until_bell,
        k.contest_from_bell,
        k.gen,
        k.last_taken_from
    )
}

fn event_json(e: &KeepEvent) -> String {
    match e {
        KeepEvent::None => "{\"kind\": \"none\"}".into(),
        KeepEvent::Contest(f) => format!("{{\"kind\": \"contest\", \"faction\": {f}}}"),
        KeepEvent::Broken => "{\"kind\": \"broken\"}".into(),
        KeepEvent::Paused => "{\"kind\": \"paused\"}".into(),
        KeepEvent::Taken {
            from,
            to,
            garrison,
            donor,
            donor_removed,
        } => format!(
            "{{\"kind\": \"taken\", \"from\": {from}, \"to\": {to}, \"garrison\": {garrison}, \"donor\": {donor}, \"donor_removed\": {donor_removed}}}"
        ),
    }
}

type Step = (u32, KeepReport, Vec<(u8, u64, u32)>);

/// Scripted keep contests: (name, province, wedge, params, steps).
fn keep_scenarios() -> Vec<(&'static str, ProvinceCoord, KeepParams, Vec<Step>)> {
    let h = |f: u8| KeepReport {
        holders: 1 << f,
        defender_present: false,
    };
    let caps = |v: &[(u8, u64, u32)]| v.to_vec();
    let short = KeepParams {
        bells: 4,
        consolidate_bells: 3,
        home_guard: 100,
        garrison_bps: 5_000,
    };
    let mut out = Vec::new();
    // 1. Taken at the 4th held bell, consolidation, then a new contest.
    let mut s: Vec<Step> = (10..14)
        .map(|b| (b, h(2), caps(&[(3, 70, 9_000_000)])))
        .collect();
    for b in 14..18 {
        s.push((b, h(0), vec![]));
    }
    s.push((18, h(0), vec![]));
    out.push((
        "taken then consolidated",
        ProvinceCoord::new(5, 0),
        short,
        s,
    ));
    // 2. Broken by a defender, restarted by another faction.
    let mut s: Vec<Step> = (0..3).map(|b| (b, h(1), vec![])).collect();
    s.push((
        3,
        KeepReport {
            holders: 2,
            defender_present: true,
        },
        vec![],
    ));
    s.push((4, h(4), vec![]));
    s.push((
        5,
        KeepReport {
            holders: 0,
            defender_present: false,
        },
        vec![],
    ));
    out.push(("broken and restarted", ProvinceCoord::new(5, 0), short, s));
    // 3. Heartland-safe.
    let s: Vec<Step> = (0..6).map(|b| (b, h(3), vec![])).collect();
    out.push(("heartland never counts", ProvinceCoord::new(3, 0), short, s));
    // 4. Six capturers at the cap, empty garrison: the donor alone pays.
    let six: Vec<(u8, u64, u32)> = (0..6)
        .map(|i| (i, 100 - i as u64, MAX_HOST_TROOPS))
        .collect();
    let s: Vec<Step> = (0..4).map(|b| (b, h(5), six.clone())).collect();
    out.push((
        "six capturers at the cap",
        ProvinceCoord::new(6, 1),
        short,
        s,
    ));
    // 5. A remainder below MIN_HOST_TROOPS joins the keep.
    let s: Vec<Step> = (0..4)
        .map(|b| (b, h(4), caps(&[(9, 1, 190_000), (8, 2, 50_000)])))
        .collect();
    out.push(("remainder joins", ProvinceCoord::new(-6, 6), short, s));
    // 6. Default parameters: taken at the 72nd bell.
    let s: Vec<Step> = (200..272)
        .map(|b| (b, h(1), caps(&[(0, 5, 4_321_000)])))
        .collect();
    out.push((
        "default 72 bells",
        ProvinceCoord::new(4, 0),
        KeepParams::DEFAULT,
        s,
    ));
    out
}

fn keep_vectors() -> String {
    let mut s = String::new();
    s.push_str("{\n  \"version\": 1,\n");
    s.push_str("  \"note\": \"MC contract 3.1/3.2 v1.3 (PO-5): the keep tile is keep::keep_tile_symmetric (terrain bytes = map::Terrain as u8, sites, site_count, wedge); keep::keep_tile is the v1.2 scan (the keep tile of wedge 0), terrain::free_city_site (site index), keep::open + keep::advance bell by bell (capturers = [entry, host id, milli-troops], reduced in place on a take), keep::advance_quiet over a quiet run (mask of non-civilian factions on the keep tile). Producer and freshness: permutation-rules/tests/frontier_conquest.rs.\",\n");
    // Keep tiles and Free City sites.
    s.push_str("  \"tiles\": [\n");
    let mut rows = Vec::new();
    for (seed_b, p) in [
        (1u8, ProvinceCoord::new(2, 0)),
        (1, ProvinceCoord::new(-2, 4)),
        (2, ProvinceCoord::new(4, 0)),
        (2, ProvinceCoord::new(0, -4)),
        (3, ProvinceCoord::new(5, 2)),
        (4, ProvinceCoord::new(-7, 3)),
        (9, ProvinceCoord::new(3, 6)),
        (9, ProvinceCoord::new(-9, 9)),
    ] {
        let seed = [seed_b; 32];
        let t = generate_province(&seed, p);
        let tb = terrain_bytes(&t);
        let w = p.wedge().unwrap();
        rows.push(format!(
            "    {{\"ring_seed\": \"{}\", \"p\": {}, \"q\": {}, \"wedge\": {}, \"terrain\": \"{}\", \"sites\": \"{}\", \"site_count\": {}, \"keep_tile\": {}, \"keep_tile_symmetric\": {}, \"free_city_site\": {}}}",
            hex(&seed),
            p.p,
            p.q,
            w,
            hex(&tb),
            hex(&t.sites),
            t.site_count,
            keep_tile(&tb, &t.sites, t.site_count).unwrap(),
            keep_tile_symmetric(&tb, &t.sites, t.site_count, w).unwrap(),
            free_city_site(&seed, p, t.site_count)
        ));
    }
    s.push_str(&rows.join(",\n"));
    s.push_str("\n  ],\n  \"scenarios\": [\n");
    let mut sc = Vec::new();
    for (name, p, prm, steps) in keep_scenarios() {
        let w = p.wedge().unwrap();
        let mut k = open(p, w, 3, 20, &prm, 0).unwrap();
        let mut line = format!(
            "    {{\"name\": \"{name}\", \"p\": {}, \"q\": {}, \"wedge\": {w}, \"heartland_max_ring\": 3, \"tile\": 20, \"open_bell\": 0, \"params\": {{\"bells\": {}, \"consolidate_bells\": {}, \"home_guard\": {}, \"garrison_bps\": {}}}, \"open\": {},\n     \"bells\": [\n",
            p.p,
            p.q,
            prm.bells,
            prm.consolidate_bells,
            prm.home_guard,
            prm.garrison_bps,
            keep_json(&k)
        );
        let mut bl = Vec::new();
        for (b, r, mut caps) in steps {
            let caps_in = caps.clone();
            let ev = advance(&mut k, b, r, &prm, &mut caps).unwrap();
            let fmt = |v: &[(u8, u64, u32)]| {
                v.iter()
                    .map(|c| format!("[{}, {}, {}]", c.0, c.1, c.2))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            bl.push(format!(
                "      {{\"bell\": {b}, \"holders\": {}, \"defender_present\": {}, \"capturers\": [{}], \"event\": {}, \"capturers_after\": [{}], \"keep\": {}}}",
                r.holders,
                r.defender_present,
                fmt(&caps_in),
                event_json(&ev),
                fmt(&caps),
                keep_json(&k)
            ));
        }
        line.push_str(&bl.join(",\n"));
        line.push_str("\n     ]}");
        sc.push(line);
    }
    s.push_str(&sc.join(",\n"));
    // One quiet run.
    let prm = KeepParams::DEFAULT;
    let mut k = open(ProvinceCoord::new(5, 0), 0, 3, 20, &prm, 0).unwrap();
    let k0 = k;
    let mut caps = vec![(2u8, 11u64, 6_000_000u32), (5, 9, 6_000_000)];
    let q = advance_quiet(&mut k, 300, 500, 1 << 4, &prm, &mut caps).unwrap();
    let evs: Vec<String> = q
        .events
        .iter()
        .map(|(b, e)| format!("{{\"bell\": {b}, \"event\": {}}}", event_json(e)))
        .collect();
    let _ = write!(
        s,
        "\n  ],\n  \"quiet\": {{\"keep\": {}, \"params\": {{\"bells\": 72, \"consolidate_bells\": 288, \"home_guard\": 100, \"garrison_bps\": 5000}}, \"b0\": 300, \"b1\": 500, \"mask\": 16, \"capturers\": [[2, 11, 6000000], [5, 9, 6000000]], \"through\": {}, \"events\": [{}], \"keep_after\": {}, \"capturers_after\": [{}]}}\n}}\n",
        keep_json(&k0),
        q.through,
        evs.join(", "),
        keep_json(&k),
        caps.iter()
            .map(|c| format!("[{}, {}, {}]", c.0, c.1, c.2))
            .collect::<Vec<_>>()
            .join(", ")
    );
    s
}

fn control_vectors() -> String {
    let mut s = String::new();
    s.push_str("{\n  \"version\": 1,\n");
    s.push_str("  \"note\": \"MC contract 3.3, 3.10, 13.4: control::controller (weights per side 0-5, 6 neutral; Unsettled | Side | Contested), control::march_banner (PSFCT1 codes: 0-5 keep holder, 6 neutral, 7 unopened; seats as {seat: f}), control::site_weight_centi (tier 0-3, garrison milli-troops, order 1-based), control::lasting_changes (series of [bell, codes per province], min_bells), control::banner_changes, control::herald_call. Producer and freshness: permutation-rules/tests/frontier_conquest.rs.\",\n");
    // Controller.
    let mut rng = Rng(0xC0_47_01);
    let mut ws: Vec<[u32; SIDES]> = vec![
        [0; SIDES],
        [5, 5, 0, 0, 0, 0, 0],
        [5, 4, 1, 0, 0, 0, 0],
        [4, 3, 2, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 3],
        [1, 0, 0, 0, 0, 0, 1],
        [300, 0, 0, 0, 0, 0, 300],
        [3_600, 1, 1, 1, 1, 1, 3_594],
    ];
    for _ in 0..24 {
        ws.push(core::array::from_fn(|_| {
            if rng.chance(50) {
                0
            } else {
                rng.below(400) as u32
            }
        }));
    }
    let rows: Vec<String> = ws
        .iter()
        .map(|w| {
            let c = match controller(w) {
                Controller::Unsettled => "\"unsettled\"".to_string(),
                Controller::Contested => "\"contested\"".to_string(),
                Controller::Side(x) => format!("{x}"),
            };
            format!(
                "    {{\"weights\": [{}], \"controller\": {c}}}",
                w.iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect();
    s.push_str("  \"controller\": [\n");
    s.push_str(&rows.join(",\n"));
    // Banners.
    use ProvinceControl::*;
    let banners: Vec<Vec<ProvinceControl>> = vec![
        vec![Unopened; 7],
        vec![
            Seat(1),
            Neutral,
            Unopened,
            Unopened,
            Unopened,
            Unopened,
            Unopened,
        ],
        vec![
            Keep(1),
            Unopened,
            Unopened,
            Unopened,
            Unopened,
            Unopened,
            Unopened,
        ],
        vec![
            Keep(1),
            Keep(2),
            Unopened,
            Unopened,
            Unopened,
            Unopened,
            Unopened,
        ],
        vec![
            Keep(1),
            Keep(2),
            Keep(1),
            Seat(2),
            Seat(2),
            Unopened,
            Unopened,
        ],
        vec![
            Keep(1),
            Keep(1),
            Keep(1),
            Keep(2),
            Keep(2),
            Keep(3),
            Unopened,
        ],
        vec![
            Keep(1),
            Keep(1),
            Keep(1),
            Keep(1),
            Keep(2),
            Keep(2),
            Keep(3),
        ],
        vec![
            Keep(0),
            Keep(0),
            Keep(5),
            Keep(5),
            Keep(5),
            Keep(0),
            Keep(5),
        ],
    ];
    let pc = |m: &ProvinceControl| match m {
        Keep(f) => format!("{f}"),
        Seat(f) => format!("{{\"seat\": {f}}}"),
        Neutral => "6".into(),
        Unopened => "7".into(),
    };
    let rows: Vec<String> = banners
        .iter()
        .map(|ms| {
            let b = match march_banner(ms) {
                Banner::None => "\"none\"".to_string(),
                Banner::Contested => "\"contested\"".to_string(),
                Banner::Faction(f) => format!("{f}"),
            };
            format!(
                "    {{\"members\": [{}], \"banner\": {b}}}",
                ms.iter().map(pc).collect::<Vec<_>>().join(", ")
            )
        })
        .collect();
    s.push_str("\n  ],\n  \"march_banner\": [\n");
    s.push_str(&rows.join(",\n"));
    // Site weights.
    let mut rows = Vec::new();
    for (ti, tier) in [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold]
        .iter()
        .enumerate()
    {
        for g in [0u32, 300_000, 1_000_000, 30_000_000] {
            for order in 1..=3u8 {
                rows.push(format!(
                    "    {{\"tier\": {ti}, \"garrison\": {g}, \"order\": {order}, \"centi\": {}}}",
                    site_weight_centi(*tier, g, order)
                ));
            }
        }
    }
    s.push_str("\n  ],\n  \"site_weight_centi\": [\n");
    s.push_str(&rows.join(",\n"));
    // Lasting changes.
    let rows: Vec<String> = lasting_cases()
        .into_iter()
        .map(|(name, series, min, _)| {
            let got = lasting_changes(&series, min);
            format!(
                "    {{\"name\": \"{name}\", \"min_bells\": {min}, \"series\": [{}], \"changes\": [{}]}}",
                series
                    .iter()
                    .map(|(b, m)| format!("[{b}, [{}, {}, {}]]", m[0], m[1], m[2]))
                    .collect::<Vec<_>>()
                    .join(", "),
                got.iter()
                    .map(|c| format!(
                        "{{\"province\": {}, \"bell\": {}, \"from\": {}, \"to\": {}}}",
                        c.province, c.bell, c.from, c.to
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect();
    s.push_str("\n  ],\n  \"lasting_changes\": [\n");
    s.push_str(&rows.join(",\n"));
    // Banner changes.
    let bs = [
        (0, Banner::None),
        (1, Banner::Faction(2)),
        (2, Banner::Contested),
        (4, Banner::Faction(2)),
        (6, Banner::Faction(3)),
        (7, Banner::None),
        (8, Banner::Faction(1)),
    ];
    let bcode = |b: &Banner| match b {
        Banner::None => "\"none\"".to_string(),
        Banner::Contested => "\"contested\"".to_string(),
        Banner::Faction(f) => format!("{f}"),
    };
    let _ = write!(
        s,
        "\n  ],\n  \"banner_changes\": {{\"series\": [{}], \"changes\": [{}]}},\n",
        bs.iter()
            .map(|(b, x)| format!("[{b}, {}]", bcode(x)))
            .collect::<Vec<_>>()
            .join(", "),
        banner_changes(&bs)
            .iter()
            .map(|c| format!(
                "{{\"bell\": {}, \"from\": {}, \"to\": {}}}",
                c.bell, c.from, c.to
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    // Herald's Call.
    let map = call_map();
    let seed = [3u8; 32];
    let calls = herald_call_detail(&map, &seed);
    let _ = write!(
        s,
        "  \"herald_call\": {{\"day_seed\": \"{}\", \"provinces\": [{}], \"recently_lost\": [{}], \"calls\": [{}]}}\n}}\n",
        hex(&seed),
        map.provinces
            .iter()
            .map(|p| format!(
                "[{}, {}, {}, {}]",
                p.coord.p,
                p.coord.q,
                pc(&p.control),
                p.contestable
            ))
            .collect::<Vec<_>>()
            .join(", "),
        map.recently_lost
            .iter()
            .map(|(f, m)| format!("[{f}, {}, {}]", m.m, m.n))
            .collect::<Vec<_>>()
            .join(", "),
        calls
            .iter()
            .map(|c| match c {
                None => "null".to_string(),
                Some(c) => format!(
                    "{{\"m\": {}, \"n\": {}, \"rally\": {}}}",
                    c.march.m, c.march.n, c.rally
                ),
            })
            .collect::<Vec<_>>()
            .join(", ")
    );
    s
}

#[test]
fn cq_vectors_are_fresh() {
    check_fresh("keep-vectors-v1.json", &keep_vectors());
    check_fresh("control-vectors-v1.json", &control_vectors());
}
