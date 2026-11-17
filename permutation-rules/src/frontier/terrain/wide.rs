//! **Experimental, opt-in** (`--features wide-terrain-experimental`): the
//! province terrain kernel of [`super`] over wide `i64` province
//! coordinates, |P|, |Q| ≤ 2⁶² (the bound of `frontier-abi`'s
//! `world_index::WideCoord`).
//!
//! Two paths, chosen by the province's ring alone ([`terrain_path`]):
//!
//! * **The legacy disk, ring ≤ 128 ([`TerrainPath::Legacy`]):**
//!   [`generate_province_wide`] *is* [`super::generate_province`] on the
//!   exact `i32` pair (a coordinate of ring ≤ 128 has |P|, |Q| ≤ 128).
//!   Every byte of existing terrain, resources and sites is kept by
//!   construction, not by re-derivation.
//! * **Past the disk, ring ≥ 129 ([`TerrainPath::WideV1`]):** the legacy
//!   kernel's own shaping — `shape_province` (gates forced passable, every
//!   gate and site carved to the centre, greedy site scoring at least 2
//!   apart) and `turn_canonical` (the wedge rotation) are the parent's
//!   private functions, with the same cell sizes, thresholds, octave weights
//!   and resource chances — over a **versioned candidate noise path**:
//!   a lattice value is `sha256(len ‖ WIDE_NOISE_DOMAIN ‖ base ‖ salt ‖ x ‖
//!   y)` with `x`, `y` the full 16 little-endian bytes of the `i128` lattice
//!   coordinates; the resource roll hashes the full `i128` tile
//!   coordinates; there is no period, no `i32` tile key, no coordinate
//!   modulo and no fall-back to the origin. Every centre, tile and noise
//!   coordinate is computed in `i128`.
//!
//! Six-fold symmetry is kept past the disk exactly as inside it: a province
//! in wedge `k` is its wedge-0 canonical copy turned by `k`, so the six
//! wedges of a ring still offer the same land. (Whether a *mixed-nation*
//! placement over symmetric terrain is fair for every ring is an owner
//! decision; see `docs/frontier/map-growth/WIDE-GENERATION.md`.)
//!
//! What this is **not**. It is not wired into `OpenProvince`, the keeper,
//! the verifier or any ruleset hash ([`WIDE_TERRAIN_VERSION`] is a
//! candidate constant, not a `KERNEL_VERSIONS` entry, and
//! `TERRAIN_VERSION` is unchanged). It chooses no ring seed: the caller
//! supplies the proof-bound ring seed exactly as for `generate_province`,
//! and past ring 128 no such seed exists yet (`addr::ring_seed` is
//! `u16`-keyed and the RingSeed account is deployed ABI). It has no wide
//! Free City rule (`free_city_site` hashes `LE32(P) ‖ LE32(Q)`; a wide
//! variant is a separate versioned decision). It generates no land: a
//! result is bytes a verifier could re-derive, not an opened province.

use super::{classify, shape_province, turn_canonical, ProvinceTerrain, CELL_COARSE, CELL_FINE};
use crate::frontier::geometry::{tile_offset, ProvinceCoord, R_MAX_HARD};
use crate::hash::sha256;
use crate::hex::Hex;
use crate::map::{Terrain, TileResource};
use crate::rng::{rand, Seed};
use alloc::vec::Vec;

/// Version of the candidate wide path (`WideV1`). A candidate constant:
/// not in `KERNEL_VERSIONS`, bound by no ruleset hash. Bump it whenever an
/// honest outcome past ring 128 changes.
pub const WIDE_TERRAIN_VERSION: u16 = 1;
/// Domain of a wide lattice value (length-prefixed in the hash input).
pub const WIDE_NOISE_DOMAIN: &[u8] = b"PSF-WIDE-TERRAIN-v1/noise";
/// `rng::rand` domain of the per-ring-seed noise base every wide lattice
/// value binds. Distinct from the legacy `"frontier/terrain"`.
pub const WIDE_BASE_DOMAIN: &[u8] = b"frontier/terrain/wide-v1";
/// `rng::rand` domain of the wide resource roll (full `i128` tile
/// coordinates as the id). Distinct from the legacy `"frontier/feat"`.
pub const WIDE_FEATURE_DOMAIN: &[u8] = b"frontier/feat/wide-v1";
/// Largest |P| and |Q| accepted: 2⁶², the bound of `world_index::WideCoord`
/// (pinned here because `permutation-rules` cannot depend on
/// `frontier-abi`).
pub const WIDE_BOUND: i64 = 1 << 62;
/// Outermost ring of the legacy disk: inside it the legacy kernel's bytes.
pub const LEGACY_DISK_RING: u128 = R_MAX_HARD as u128;

/// A coordinate the kernel refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideTerrainError {
    /// |P| or |Q| above [`WIDE_BOUND`]. Refused, never wrapped or clamped.
    OutOfBounds,
}

/// Which path a coordinate takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainPath {
    /// Ring ≤ 128: [`super::generate_province`] on the exact `i32` pair.
    Legacy,
    /// Ring ≥ 129: the candidate full-coordinate path, version
    /// [`WIDE_TERRAIN_VERSION`].
    WideV1,
}

/// The path of province `(p, q)`, or [`WideTerrainError::OutOfBounds`].
pub fn terrain_path(p: i64, q: i64) -> Result<TerrainPath, WideTerrainError> {
    let bound = -WIDE_BOUND..=WIDE_BOUND;
    if !bound.contains(&p) || !bound.contains(&q) {
        return Err(WideTerrainError::OutOfBounds);
    }
    if ring_i128(p as i128, q as i128) <= LEGACY_DISK_RING {
        Ok(TerrainPath::Legacy)
    } else {
        Ok(TerrainPath::WideV1)
    }
}

/// The land of province `(p, q)` from the seed of its ring: byte-identical
/// to [`super::generate_province`] for every coordinate of ring ≤ 128, the
/// `WideV1` path past it. `ring_seed` is the caller's proof-bound ring seed;
/// this function neither selects nor derives one. Pure.
pub fn generate_province_wide(
    ring_seed: &Seed,
    p: i64,
    q: i64,
) -> Result<ProvinceTerrain, WideTerrainError> {
    match terrain_path(p, q)? {
        TerrainPath::Legacy => {
            // Ring ≤ 128 ⇒ |p|, |q| ≤ 128, so both fit `i32`. The narrowing
            // is checked all the same: a failure is a refusal, never a
            // truncation.
            let lp = i32::try_from(p).map_err(|_| WideTerrainError::OutOfBounds)?;
            let lq = i32::try_from(q).map_err(|_| WideTerrainError::OutOfBounds)?;
            Ok(super::generate_province(
                ring_seed,
                ProvinceCoord::new(lp, lq),
            ))
        }
        TerrainPath::WideV1 => Ok(generate_wide_v1(ring_seed, p as i128, q as i128)),
    }
}

// ------------------------------------------------------------ geometry

/// `(|p| + |q| + |p + q|) / 2`: the legacy ring rule in `i128`.
const fn ring_i128(p: i128, q: i128) -> u128 {
    (p.unsigned_abs() + q.unsigned_abs() + (p + q).unsigned_abs()) / 2
}

/// Centre tile of province `(p, q)`: `geometry::cell_centre` for radius 4,
/// `(9P + 4Q, −4P + 5Q)`, in `i128` (no `i64` pair overflows).
const fn centre_i128(p: i128, q: i128) -> (i128, i128) {
    (9 * p + 4 * q, -4 * p + 5 * q)
}

/// Wedge `k` and canonical wedge-0 copy of a province outside the Concord:
/// the legacy `Hex::sextant` / `Hex::turned` rule in `i128`, the first of
/// six turns back by 60° (`(a, b) → (a + b, −a)`) that lands in
/// `{a > 0, b ≥ 0}`. The copy has the same ring, so |a|, |b| ≤ 2⁶³.
fn canonical_copy(p: i128, q: i128) -> (u8, i128, i128) {
    let (mut a, mut b) = (p, q);
    for k in 0..6u8 {
        if a > 0 && b >= 0 {
            return (k, a, b);
        }
        (a, b) = (a + b, -a);
    }
    // The six sets partition the nonzero lattice, and the Concord (ring 0)
    // never reaches the wide path.
    debug_assert!(false, "a nonzero province lies in one of six wedges");
    (0, p, q)
}

// ----------------------------------------------------------------- noise

/// Planar noise coordinates (1/1024 lattice units) of a tile for a cell of
/// `cell` tiles: the legacy `plane` (`x = q + r/2`, `y = r·√3/2`, √3/2 ≈
/// 887/1024, truncating division) in `i128`.
const fn plane_i128(q: i128, r: i128, cell: i128) -> (i128, i128) {
    ((2 * q + r) * 512 / cell, r * 887 / cell)
}

/// `3t² − 2t³` in 1/1024 units: the legacy `mapgen::smooth` formula (that
/// function is private to `mapgen`), in `i128`.
const fn smooth_i128(t: i128) -> i128 {
    t * t * (3 * 1024 - 2 * t) / (1024 * 1024)
}

/// A lattice value in 0..1024 from the full coordinate bytes:
/// `sha256(len ‖ WIDE_NOISE_DOMAIN ‖ LE64(base) ‖ LE64(salt) ‖ LE128(x) ‖
/// LE128(y))[..8]` as LE `u64`, top 10 bits. All four fields are fixed
/// width, so the input is unambiguous.
fn lattice_wide(base: u64, salt: u64, x: i128, y: i128) -> i64 {
    let h = sha256(&[
        &[WIDE_NOISE_DOMAIN.len() as u8],
        WIDE_NOISE_DOMAIN,
        &base.to_le_bytes(),
        &salt.to_le_bytes(),
        &x.to_le_bytes(),
        &y.to_le_bytes(),
    ]);
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    (u64::from_le_bytes(b) >> 54) as i64
}

/// The lattice of one province under one base, memoised: the 61 tiles
/// share a handful of lattice cells per octave, and each value is a
/// sha256. Pure memoisation: a hit and a miss give the same value.
struct Lattice {
    base: u64,
    memo: Vec<(u64, i128, i128, i64)>,
}

impl Lattice {
    fn new(base: u64) -> Lattice {
        Lattice {
            base,
            memo: Vec::new(),
        }
    }

    fn value(&mut self, salt: u64, x: i128, y: i128) -> i128 {
        if let Some(e) = self
            .memo
            .iter()
            .find(|e| e.0 == salt && e.1 == x && e.2 == y)
        {
            return e.3 as i128;
        }
        let v = lattice_wide(self.base, salt, x, y);
        self.memo.push((salt, x, y, v));
        v as i128
    }
}

/// Value noise in 0..1024 at (`px`, `py`) in 1/1024 lattice units: the
/// legacy `mapgen::noise` interpolation over the wide lattice, with **no
/// period** (the rows are `y0` and `y0 + 1` themselves; the legacy kernel
/// passes a 2⁴⁰-cell period that no legacy coordinate reaches).
fn noise_wide(lat: &mut Lattice, salt: u64, px: i128, py: i128) -> i128 {
    let (x0, fx) = (px.div_euclid(1024), smooth_i128(px.rem_euclid(1024)));
    let (y0, fy) = (py.div_euclid(1024), smooth_i128(py.rem_euclid(1024)));
    let top = lat.value(salt, x0, y0) * (1024 - fx) + lat.value(salt, x0 + 1, y0) * fx;
    let bottom = lat.value(salt, x0, y0 + 1) * (1024 - fx) + lat.value(salt, x0 + 1, y0 + 1) * fx;
    (top * (1024 - fy) + bottom * fy) / (1024 * 1024)
}

/// A noise value (0..1024 by construction: lattice values below 1024,
/// weights that sum to 1024², integer division) as the `i64` the legacy
/// `classify` takes. This narrows a bounded value, never a coordinate.
fn value_i64(v: i128) -> i64 {
    debug_assert!((0..1024).contains(&v), "noise value out of range");
    v as i64
}

/// Terrain and resource of the tile at global `(q, r)`: the legacy
/// `tile_at_base` with the wide noise (same octave weights `3:1`, same
/// cells, same `classify`) and the wide resource roll (same `% 16` and the
/// same terrain-to-resource table, the id being the full `i128` pair).
fn tile_at_wide(
    seed: &Seed,
    lat: &mut Lattice,
    q: i128,
    r: i128,
) -> (Terrain, Option<TileResource>) {
    let mut at = |salt: u64, cell: i64| {
        let (x, y) = plane_i128(q, r, cell as i128);
        noise_wide(lat, salt, x, y)
    };
    let e = (3 * at(1, CELL_COARSE) + at(2, CELL_FINE)) / 4;
    let m = (3 * at(3, CELL_COARSE) + at(4, CELL_FINE)) / 4;
    let t = classify(value_i64(e), value_i64(m));
    let mut key = [0u8; 32];
    key[..16].copy_from_slice(&q.to_le_bytes());
    key[16..].copy_from_slice(&r.to_le_bytes());
    let roll = rand(seed, WIDE_FEATURE_DOMAIN, &key) % 16;
    let res = match (roll, t) {
        (0, Terrain::Grassland | Terrain::Plains) => Some(TileResource::Wheat),
        (1, Terrain::Hills | Terrain::Forest) => Some(TileResource::Iron),
        (2, Terrain::Plains | Terrain::Grassland) => Some(TileResource::Horses),
        _ => None,
    };
    (t, res)
}

/// The `WideV1` path for a province past the disk: the canonical wedge-0
/// copy sampled tile by tile with the wide noise, shaped by the legacy
/// rules, turned back to its wedge.
fn generate_wide_v1(seed: &Seed, p: i128, q: i128) -> ProvinceTerrain {
    let (k, cp, cq) = canonical_copy(p, q);
    let (cx, cy) = centre_i128(cp, cq);
    let mut lat = Lattice::new(rand(seed, WIDE_BASE_DOMAIN, &[]));
    let canon = shape_province(false, |i| {
        let o = tile_offset(i).unwrap_or(Hex::ORIGIN);
        tile_at_wide(seed, &mut lat, cx + o.q as i128, cy + o.r as i128)
    });
    turn_canonical(canon, k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::geometry::{
        cell_centre, provinces_within, ring_provinces, tile_index, tile_turned, PROVINCE_RADIUS,
        PROVINCE_TILES, SITES_PER_PROVINCE,
    };
    use crate::frontier::terrain::{generate_province, GATES, TERRAIN_VERSION, TERRAIN_VERSION_V2};
    use crate::frontier::{KERNEL_VERSIONS, KERNEL_VERSIONS_V2, KERNEL_VERSIONS_V3};

    const B: i64 = WIDE_BOUND;

    fn wide(seed: &Seed, p: i64, q: i64) -> ProvinceTerrain {
        generate_province_wide(seed, p, q).unwrap_or_else(|e| panic!("({p}, {q}): {e:?}"))
    }

    /// Province `pos` of ring `ring` in ring order: wedge `pos / ring`,
    /// canonical copy `(ring − j, j)` turned `wedge` times.
    fn at_ring(ring: i64, pos: i64) -> (i64, i64) {
        let (wedge, j) = (pos / ring, pos % ring);
        let (mut a, mut b) = (ring - j, j);
        for _ in 0..wedge {
            (a, b) = (-b, a + b);
        }
        (a, b)
    }

    /// Tiles in the centre's passable component.
    fn reachable(t: &ProvinceTerrain) -> [bool; PROVINCE_TILES] {
        let mut seen = [false; PROVINCE_TILES];
        let centre = tile_index(Hex::ORIGIN).unwrap();
        if !t.passable(centre) {
            return seen;
        }
        seen[centre as usize] = true;
        let mut stack = alloc::vec![centre];
        while let Some(i) = stack.pop() {
            for n in tile_offset(i).unwrap().neighbors() {
                let Some(j) = tile_index(n) else { continue };
                if !seen[j as usize] && t.passable(j) {
                    seen[j as usize] = true;
                    stack.push(j);
                }
            }
        }
        seen
    }

    /// The invariants every shaped province outside the Concord has: all
    /// 18 gate tiles passable; 1..=12 distinct passable sites at least 2
    /// apart; every gate and site in the centre's passable component.
    fn assert_shaped(t: &ProvinceTerrain, what: &str) {
        let reach = reachable(t);
        for side in GATES {
            for i in side {
                assert!(t.passable(i), "{what}: gate {i} blocked");
                assert!(reach[i as usize], "{what}: gate {i} cut off");
            }
        }
        let n = t.site_count as usize;
        assert!((1..=SITES_PER_PROVINCE).contains(&n), "{what}: {n} sites");
        let sites = &t.sites[..n];
        for (a, sa) in sites.iter().enumerate() {
            assert!(t.passable(*sa), "{what}: site {sa} blocked");
            assert!(reach[*sa as usize], "{what}: site {sa} cut off");
            let oa = tile_offset(*sa).unwrap();
            for sb in &sites[a + 1..] {
                assert!(
                    oa.distance(tile_offset(*sb).unwrap()) >= 2,
                    "{what}: sites {sa} and {sb} too close"
                );
            }
        }
    }

    /// Every coordinate of the legacy disk takes the legacy path and gives
    /// the bytes of `generate_province`: rings 0–10 whole, the rim rings
    /// 127 and 128 whole, and every 97th province of the dense index, for
    /// two seeds.
    #[test]
    fn inside_the_legacy_disk_every_byte_is_generate_province() {
        let mut coords: Vec<ProvinceCoord> = Vec::new();
        for d in 0..=10 {
            coords.extend(ring_provinces(d));
        }
        coords.extend(ring_provinces(127));
        coords.extend(ring_provinces(128));
        let n = provinces_within(R_MAX_HARD as u32);
        coords.extend((0..n).step_by(97).map(ProvinceCoord::from_index));
        for s in [0u8, 0x5A] {
            let seed = [s; 32];
            for p in &coords {
                let (wp, wq) = (p.p as i64, p.q as i64);
                assert_eq!(terrain_path(wp, wq), Ok(TerrainPath::Legacy), "{p:?}");
                assert_eq!(
                    wide(&seed, wp, wq),
                    generate_province(&seed, *p),
                    "seed {s} {p:?}"
                );
            }
        }
    }

    /// Ring 129 is the first ring of the wide path: every one of its 774
    /// provinces is shaped like legacy land, and none of them is the legacy
    /// noise under another name (the legacy function, which accepts any
    /// `i32` pair unchecked, gives different bytes for each).
    #[test]
    fn past_ring_128_the_versioned_wide_path_is_used() {
        let seed = [9u8; 32];
        for pos in 0..6 * 129 {
            let (p, q) = at_ring(129, pos);
            assert_eq!(terrain_path(p, q), Ok(TerrainPath::WideV1), "({p}, {q})");
            let t = wide(&seed, p, q);
            assert_shaped(&t, &alloc::format!("ring 129 ({p}, {q})"));
            let truncating = generate_province(&seed, ProvinceCoord::new(p as i32, q as i32));
            assert_ne!(
                t, truncating,
                "({p}, {q}): the wide path is not legacy noise"
            );
        }
        // the boundary is the ring, whatever the wedge
        for pos in 0..6 * 128 {
            let (p, q) = at_ring(128, pos);
            assert_eq!(terrain_path(p, q), Ok(TerrainPath::Legacy));
        }
        assert_eq!(terrain_path(0, 0), Ok(TerrainPath::Legacy));
        assert_eq!(terrain_path(-128, 128), Ok(TerrainPath::Legacy));
        assert_eq!(terrain_path(-129, 129), Ok(TerrainPath::WideV1));
        assert_eq!(terrain_path(64, -129), Ok(TerrainPath::WideV1));
    }

    /// A province in wedge `k` past the disk is its wedge-0 copy turned by
    /// `k`, tile for tile and site for site: the legacy symmetry rule.
    #[test]
    fn six_fold_symmetry_holds_past_the_disk_as_inside_it() {
        let seed = [3u8; 32];
        for (p, q) in [
            (200i64, 50i64),
            (129, 0),
            (1 << 40, 3),
            ((1 << 53) + 1, 7),
            (1 << 61, 1 << 60),
        ] {
            assert_eq!(
                canonical_copy(p as i128, q as i128).0,
                0,
                "({p}, {q}) in wedge 0"
            );
            let canon = wide(&seed, p, q);
            let (mut a, mut b) = (p, q);
            for k in 1..6u8 {
                (a, b) = (-b, a + b);
                assert_eq!(
                    canonical_copy(a as i128, b as i128),
                    (k, p as i128, q as i128)
                );
                let t = wide(&seed, a, b);
                for i in 0..PROVINCE_TILES as u8 {
                    let c = tile_turned(i, k) as usize;
                    assert_eq!(
                        t.terrain[i as usize], canon.terrain[c],
                        "({a}, {b}) tile {i}"
                    );
                    assert_eq!(
                        t.resource[i as usize], canon.resource[c],
                        "({a}, {b}) tile {i}"
                    );
                }
                assert_eq!(t.site_count, canon.site_count);
                for s in 0..canon.site_count as usize {
                    let o = tile_offset(canon.sites[s]).unwrap();
                    assert_eq!(t.sites[s], tile_index(o.rotate_by(k)).unwrap());
                }
            }
        }
    }

    /// Past `i32`, past 2⁵³ and at the four corners and two edges of the
    /// bound the kernel answers, is reproducible and is shaped like legacy
    /// land; one step past the bound, and the `i64` extremes, are refused.
    #[test]
    fn far_coordinates_are_exact_and_the_bound_is_refused_not_wrapped() {
        let seed = [0x42u8; 32];
        let other = [0x43u8; 32];
        for (p, q) in [
            (B, B),
            (-B, -B),
            (B, -B),
            (-B, B),
            (B, 0),
            (0, -B),
            (i32::MAX as i64 + 1, 0),
            (0, i32::MIN as i64 - 1),
            ((1 << 53) + 1, -3),
            (-(1 << 53) - 7, 1 << 53),
        ] {
            assert_eq!(terrain_path(p, q), Ok(TerrainPath::WideV1), "({p}, {q})");
            let t = wide(&seed, p, q);
            assert_shaped(&t, &alloc::format!("({p}, {q})"));
            assert_eq!(wide(&seed, p, q), t, "({p}, {q}) reproducible");
            assert_ne!(wide(&other, p, q), t, "({p}, {q}) bound to the ring seed");
        }
        for (p, q) in [
            (B + 1, 0),
            (0, -B - 1),
            (-B - 1, B),
            (i64::MAX, 0),
            (i64::MIN, i64::MIN),
            (i64::MAX, i64::MAX),
        ] {
            assert_eq!(terrain_path(p, q), Err(WideTerrainError::OutOfBounds));
            assert_eq!(
                generate_province_wide(&seed, p, q),
                Err(WideTerrainError::OutOfBounds),
                "({p}, {q})"
            );
        }
    }

    /// The wide lattice reads every byte of both coordinates: a shift by
    /// 2³², 2⁶⁴ or 2¹⁰⁰ in either axis, or by the legacy 2⁴⁰-cell period in
    /// `y`, changes the value at almost every point (10-bit values collide
    /// by chance about 1 in 1024); salt and base separate the octaves and
    /// the ring seeds; values are in 0..1024; `smooth` is the legacy curve.
    #[test]
    fn wide_lattice_reads_every_coordinate_byte_and_has_no_period() {
        let base = 0x1234_5678_9ABC_DEF0u64;
        let points: Vec<(i128, i128)> = (0..64i128)
            .map(|i| (i * 7_919 - 1_000, i * 104_729 + 3))
            .collect();
        let differing = |f: &dyn Fn(i128, i128) -> i64, g: &dyn Fn(i128, i128) -> i64| {
            points
                .iter()
                .filter(|(x, y)| f(*x, *y) != g(*x, *y))
                .count()
        };
        let here = |x: i128, y: i128| lattice_wide(base, 1, x, y);
        for (dx, dy) in [
            (1i128 << 32, 0i128),
            (1 << 64, 0),
            (1 << 100, 0),
            (0, 1 << 32),
            (0, 1 << 40),
            (0, 1 << 64),
            (1 << 100, 1 << 100),
            (-(1 << 70), 1 << 90),
        ] {
            let shifted = |x: i128, y: i128| lattice_wide(base, 1, x + dx, y + dy);
            let n = differing(&here, &shifted);
            assert!(n >= 56, "shift ({dx}, {dy}): only {n}/64 differ");
        }
        let salt2 = |x: i128, y: i128| lattice_wide(base, 2, x, y);
        assert!(differing(&here, &salt2) >= 56, "salt");
        let base2 = |x: i128, y: i128| lattice_wide(base + 1, 1, x, y);
        assert!(differing(&here, &base2) >= 56, "base");
        for (x, y) in &points {
            assert!((0..1024).contains(&here(*x, *y)));
        }
        // the noise too, at the tile level: 2⁶⁴ tiles east is other land
        let mut lat = Lattice::new(base);
        let mut n = 0;
        for (x, y) in &points {
            let a = noise_wide(&mut lat, 1, *x, *y);
            let b = noise_wide(&mut lat, 1, x + (1i128 << 64) * 1024, *y);
            assert!((0..1024).contains(&a) && (0..1024).contains(&b));
            if a != b {
                n += 1;
            }
        }
        assert!(n >= 56, "noise: only {n}/64 differ across 2⁶⁴ tiles");
        // memoisation is pure
        assert_eq!(
            noise_wide(&mut lat, 1, 12_345, -6_789),
            noise_wide(&mut Lattice::new(base), 1, 12_345, -6_789)
        );
        // the smoothstep
        assert_eq!(smooth_i128(0), 0);
        assert_eq!(smooth_i128(512), 512);
        assert_eq!(smooth_i128(1024), 1024);
        for t in 1..=1024i128 {
            assert!(smooth_i128(t) >= smooth_i128(t - 1));
        }
    }

    /// The `i128` centre, wedge, canonical copy and ring equal the legacy
    /// geometry wherever both exist, and the canonical copy lies in wedge 0
    /// at the same ring at the far corners.
    #[test]
    fn wide_centre_and_wedge_agree_with_the_legacy_geometry() {
        for p in -40..=40i32 {
            for q in -40..=40i32 {
                let h = Hex::new(p, q);
                let c = cell_centre(h, PROVINCE_RADIUS);
                assert_eq!(
                    centre_i128(p as i128, q as i128),
                    (c.q as i128, c.r as i128),
                    "{h:?}"
                );
                assert_eq!(
                    ring_i128(p as i128, q as i128),
                    ProvinceCoord::new(p, q).ring() as u128
                );
                if h != Hex::ORIGIN {
                    let k = h.sextant();
                    let w = h.turned(k);
                    assert_eq!(
                        canonical_copy(p as i128, q as i128),
                        (k, w.q as i128, w.r as i128),
                        "{h:?}"
                    );
                }
            }
        }
        for (p, q) in [
            (-(B as i128), B as i128),
            (5, -(1i128 << 61)),
            (B as i128, B as i128),
            (-(B as i128), -(B as i128)),
            (-(1i128 << 53) - 7, 1i128 << 53),
        ] {
            let (k, a, b) = canonical_copy(p, q);
            assert!(k < 6 && a > 0 && b >= 0, "({p}, {q})");
            assert_eq!((a + b) as u128, ring_i128(p, q), "({p}, {q})");
        }
        assert_eq!(ring_i128(B as i128, B as i128), 1u128 << 63);
        assert_eq!(
            centre_i128(B as i128, B as i128),
            (13 * (B as i128), B as i128)
        );
    }

    /// The candidate's constants are pinned, separate from the legacy
    /// domains, and absent from every ruleset hash's version list; the
    /// legacy versions are unchanged.
    #[test]
    fn candidate_constants_are_pinned_and_outside_every_ruleset_hash() {
        assert_eq!(WIDE_TERRAIN_VERSION, 1);
        assert_eq!(TERRAIN_VERSION, 1);
        assert_eq!(TERRAIN_VERSION_V2, 2);
        assert_eq!(WIDE_BOUND, 1 << 62);
        assert_eq!(LEGACY_DISK_RING, 128);
        assert_eq!(R_MAX_HARD, 128);
        assert_eq!((CELL_COARSE, CELL_FINE), (7, 3));
        for d in [WIDE_NOISE_DOMAIN, WIDE_BASE_DOMAIN, WIDE_FEATURE_DOMAIN] {
            assert!(d.len() <= u8::MAX as usize);
        }
        assert_ne!(WIDE_BASE_DOMAIN, b"frontier/terrain");
        assert_ne!(WIDE_FEATURE_DOMAIN, b"frontier/feat");
        assert_ne!(WIDE_NOISE_DOMAIN, WIDE_BASE_DOMAIN);
        assert_eq!(KERNEL_VERSIONS.len(), 23);
        assert_eq!(KERNEL_VERSIONS_V2.len(), 25);
        assert_eq!(KERNEL_VERSIONS_V3.len(), 29);
        for list in [
            &KERNEL_VERSIONS[..],
            &KERNEL_VERSIONS_V2[..],
            &KERNEL_VERSIONS_V3[..],
        ] {
            assert_eq!(
                list.iter().filter(|(n, _)| n.contains("terrain")).count(),
                1
            );
            assert!(list.iter().all(|(n, _)| !n.contains("wide")));
        }
    }
}
