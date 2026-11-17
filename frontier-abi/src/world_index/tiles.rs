//! Exact tile geometry of the wide province lattice, and a bounded route
//! verifier over reported land (experimental; see the module doc of
//! [`super`]).
//!
//! **Geometry.** The legacy world is one lattice of radius-4 hexagonal
//! provinces of 61 tiles: province (P, Q) is centred at tile
//! `(9P + 4Q, −4P + 5Q)` (`geometry::cell_centre` with n = 4), and its
//! tiles are that centre plus the 61 offsets of `geometry::tile_offset`,
//! numbered by `geometry::tile_index`. This module is the **same lattice**
//! with (P, Q) the `i64` pair of a [`WideCoord`] (|P|, |Q| ≤ 2⁶²). A tile
//! coordinate is then up to 13·2⁶² + 4 in magnitude, past `i64` and far
//! past the 2⁵³ a JS `Number` carries exactly, so every tile coordinate is
//! an `i128`, every intermediate is computed in `i128`, nothing is narrowed
//! without a check, and no floating point touches a coordinate.
//!
//! A [`WideTile`] is accepted only if its province lies within
//! [`WIDE_BOUND`]; a tile past the last province is refused
//! ([`TileError::OutOfWorld`]), never wrapped. Every accepted tile is the
//! tile of exactly one province at exactly one local index, its
//! [`TileAddress`], and the two forms round-trip. Within ring 128 the
//! geometry is the legacy geometry tile for tile (`geometry::locate`,
//! `ProvinceCoord::tile`), which the tests pin for every tile of every
//! province of the legacy disk.
//!
//! **Routes.** [`verify_route`] checks a submitted sequence of tiles the
//! way `travel::path_cost` does (each step adjacent to the last, at most
//! `max_steps` steps over at most `max_provinces` distinct provinces
//! entered), with the bounds stated by the caller and capped at the legacy
//! constants (32 and 4), and in addition requires every province the route
//! stands on to be **reported open** by a caller-supplied
//! [`ProvinceSource`]. An unknown, closed or other-world province refuses
//! the route. The verifier attaches no terrain, cost, time or stamina, and
//! it moves nothing: it is a prerequisite a future dispatcher could call,
//! not a dispatcher, not a march, and not evidence that any land exists.

use super::coord::{WideCoord, WIDE_BOUND};
use super::index::{IndexError, Lookup, ReportedState};
use super::key::{ProvinceKey, WorldId};
use alloc::vec::Vec;
use permutation_rules::frontier::geometry::{
    tile_index, tile_offset, PROVINCE_RADIUS, PROVINCE_TILES,
};
use permutation_rules::frontier::travel::{MAX_PATH_PROVINCES, MAX_PATH_STEPS};
use permutation_rules::hex::{Hex, DIRECTIONS};

/// Coefficients of a province centre's `q`: `9P + 4Q`.
pub const CENTRE_Q: (i128, i128) = (9, 4);
/// Coefficients of a province centre's `r`: `−4P + 5Q`.
pub const CENTRE_R: (i128, i128) = (-4, 5);
/// Determinant of the lattice, `9·5 − 4·(−4)`: the 61 tiles of a province.
const LATTICE_DET: i128 = 61;
/// Largest |q| and |r| of any tile of any province within [`WIDE_BOUND`]:
/// `13·2⁶² + 4`. A coordinate past it is refused before any arithmetic.
pub const TILE_COORD_BOUND: i128 = 13 * (WIDE_BOUND as i128) + PROVINCE_RADIUS as i128;

// The lattice this module hard-codes is the legacy one, pinned at compile
// time; a step index of a route fits `u8` as in `travel::TravelError`.
const _: () = assert!(PROVINCE_RADIUS == 4);
const _: () = assert!(PROVINCE_TILES == 61);
const _: () = assert!(LATTICE_DET == 3 * 4 * 5 + 1);
const _: () = assert!(CENTRE_Q.0 == 2 * 4 + 1 && CENTRE_Q.1 == 4);
const _: () = assert!(CENTRE_R.0 == -4 && CENTRE_R.1 == 4 + 1);
const _: () = assert!(CENTRE_Q.0 * CENTRE_R.1 - CENTRE_Q.1 * CENTRE_R.0 == LATTICE_DET);
const _: () = assert!(MAX_PATH_STEPS <= u8::MAX as usize);

/// A tile or address the module refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileError {
    /// A coordinate past [`TILE_COORD_BOUND`], or a tile whose province
    /// would lie past [`WIDE_BOUND`]. The world has an edge; nothing wraps.
    OutOfWorld,
    /// A local tile index at or above 61.
    LocalIndex(u8),
    /// Two tiles of different worlds compared.
    WorldMismatch { expected: WorldId, got: WorldId },
}

/// Centre of province (P, Q) in `i128`: no `i64` pair overflows.
const fn centre_i128(p: i128, q: i128) -> (i128, i128) {
    (
        CENTRE_Q.0 * p + CENTRE_Q.1 * q,
        CENTRE_R.0 * p + CENTRE_R.1 * q,
    )
}

/// `(|dq| + |dr| + |dq + dr|) / 2` in `i128`.
const fn hex_distance_i128(dq: i128, dr: i128) -> u128 {
    (dq.unsigned_abs() + dr.unsigned_abs() + (dq + dr).unsigned_abs()) / 2
}

/// The province of a tile within the box: `geometry::cell_of` for n = 4 in
/// `i128`. `(p0, q0)` are the floored real coordinates of the tile in the
/// lattice basis (inverse matrix `(5, −4; 4, 9) / 61`); the cell is the
/// nearest of the 3 × 3 lattice points around them, unique because
/// radius-4 hexagons tile the plane (a tile is within 4 of exactly one
/// centre). Every intermediate is below 2⁷¹ for a coordinate within
/// [`TILE_COORD_BOUND`].
fn cell_of_i128(q: i128, r: i128) -> (i128, i128) {
    let p0 = (5 * q - 4 * r).div_euclid(LATTICE_DET);
    let q0 = (4 * q + 9 * r).div_euclid(LATTICE_DET);
    let mut best = (u128::MAX, (p0, q0));
    for dp in -1..=1 {
        for dq in -1..=1 {
            let (pp, qq) = (p0 + dp, q0 + dq);
            let (cq, cr) = centre_i128(pp, qq);
            let d = hex_distance_i128(q - cq, r - cr);
            if d < best.0 {
                best = (d, (pp, qq));
            }
        }
    }
    best.1
}

/// A tile named by its province and its local index (`0..61`, the
/// `geometry::tile_offset` order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TileAddress {
    key: ProvinceKey,
    local: u8,
}

impl TileAddress {
    /// `local` must be below 61 ([`TileError::LocalIndex`]).
    pub fn new(key: ProvinceKey, local: u8) -> Result<TileAddress, TileError> {
        if tile_offset(local).is_none() {
            return Err(TileError::LocalIndex(local));
        }
        Ok(TileAddress { key, local })
    }

    pub const fn key(&self) -> ProvinceKey {
        self.key
    }

    pub const fn world(&self) -> WorldId {
        self.key.world()
    }

    pub const fn local(&self) -> u8 {
        self.local
    }
}

/// A tile of one world by global axial coordinates, with its province and
/// local index resolved at construction (so neither can disagree with the
/// coordinates). Equal tiles are equal (world, q, r).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct WideTile {
    world: WorldId,
    q: i128,
    r: i128,
    province: WideCoord,
    local: u8,
}

impl WideTile {
    /// The tile at `(q, r)` of `world`, if its province lies within
    /// [`WIDE_BOUND`]; [`TileError::OutOfWorld`] otherwise.
    pub fn checked(world: WorldId, q: i128, r: i128) -> Result<WideTile, TileError> {
        let bound = -TILE_COORD_BOUND..=TILE_COORD_BOUND;
        if !bound.contains(&q) || !bound.contains(&r) {
            return Err(TileError::OutOfWorld);
        }
        let (p, pq) = cell_of_i128(q, r);
        let p = i64::try_from(p).map_err(|_| TileError::OutOfWorld)?;
        let pq = i64::try_from(pq).map_err(|_| TileError::OutOfWorld)?;
        let province = WideCoord::checked(p, pq).map_err(|_| TileError::OutOfWorld)?;
        let (cq, cr) = centre_i128(p as i128, pq as i128);
        // The offset is within radius 4 by the tiling argument of
        // `cell_of_i128`; it is narrowed with a check all the same, and a
        // failure is a refusal, never a panic.
        let oq = i32::try_from(q - cq).map_err(|_| TileError::OutOfWorld)?;
        let or = i32::try_from(r - cr).map_err(|_| TileError::OutOfWorld)?;
        let local = tile_index(Hex::new(oq, or)).ok_or(TileError::OutOfWorld)?;
        Ok(WideTile {
            world,
            q,
            r,
            province,
            local,
        })
    }

    /// The tile at an address: the province centre plus the legacy offset
    /// of the local index. Exact, and always within the world.
    pub fn of(addr: TileAddress) -> WideTile {
        let c = addr.key.coord();
        let (cq, cr) = centre_i128(c.p() as i128, c.q() as i128);
        // `TileAddress::new` checked the index; a `None` here is impossible
        // and would be the centre, not a panic.
        let o = tile_offset(addr.local).unwrap_or(Hex::ORIGIN);
        WideTile {
            world: addr.key.world(),
            q: cq + o.q as i128,
            r: cr + o.r as i128,
            province: c,
            local: addr.local,
        }
    }

    /// Exact widening of a legacy tile (any `i32` pair is within the
    /// world; the legacy `check_hex` box, |q|, |r| ≤ 2¹⁶, is the legacy
    /// entry condition and is not applied here).
    pub fn from_legacy(world: WorldId, h: Hex) -> Result<WideTile, TileError> {
        WideTile::checked(world, h.q as i128, h.r as i128)
    }

    /// The legacy tile, if both coordinates fit `i32` (lossless; `None`
    /// past it, never a truncation). A legacy entry point still applies its
    /// own `check_hex`.
    pub fn legacy_hex(&self) -> Option<Hex> {
        let q = i32::try_from(self.q).ok()?;
        let r = i32::try_from(self.r).ok()?;
        Some(Hex::new(q, r))
    }

    pub const fn world(&self) -> WorldId {
        self.world
    }

    pub const fn q(&self) -> i128 {
        self.q
    }

    pub const fn r(&self) -> i128 {
        self.r
    }

    /// The province this tile belongs to, in this world.
    pub const fn province(&self) -> ProvinceKey {
        ProvinceKey::new(self.world, self.province)
    }

    pub const fn province_coord(&self) -> WideCoord {
        self.province
    }

    /// Index of this tile in its province (`0..61`).
    pub const fn local(&self) -> u8 {
        self.local
    }

    pub const fn address(&self) -> TileAddress {
        TileAddress {
            key: ProvinceKey::new(self.world, self.province),
            local: self.local,
        }
    }

    fn check_world(&self, other: &WideTile) -> Result<(), TileError> {
        if self.world == other.world {
            Ok(())
        } else {
            Err(TileError::WorldMismatch {
                expected: self.world,
                got: other.world,
            })
        }
    }

    /// Hex distance between two tiles of the same world (at most 2⁶⁷);
    /// tiles of different worlds have no distance.
    pub fn distance(&self, other: &WideTile) -> Result<u128, TileError> {
        self.check_world(other)?;
        Ok(hex_distance_i128(self.q - other.q, self.r - other.r))
    }

    /// Whether `other` is one of this tile's six neighbours (same world,
    /// distance 1).
    pub fn is_adjacent(&self, other: &WideTile) -> Result<bool, TileError> {
        Ok(self.distance(other)? == 1)
    }

    /// The six neighbours in `hex::DIRECTIONS` order; `None` where the
    /// step leaves the world (no wrap).
    pub fn neighbors(&self) -> [Option<WideTile>; 6] {
        DIRECTIONS.map(|(dq, dr)| {
            WideTile::checked(self.world, self.q + dq as i128, self.r + dr as i128).ok()
        })
    }
}

/// What a route's source says about a province. The verifier asks once per
/// distinct province the route stands on, and accepts only
/// [`Lookup::Known`] with [`ReportedState::Open`]. Any closure
/// `Fn(&ProvinceKey) -> Result<Lookup, IndexError>` is a source; an
/// [`super::index::OpenedProvinceIndex`] is one as `|k| index.lookup(k)`,
/// which refuses a key of another world by itself.
pub trait ProvinceSource {
    fn reported(&self, key: &ProvinceKey) -> Result<Lookup, IndexError>;
}

impl<F> ProvinceSource for F
where
    F: Fn(&ProvinceKey) -> Result<Lookup, IndexError>,
{
    fn reported(&self, key: &ProvinceKey) -> Result<Lookup, IndexError> {
        self(key)
    }
}

/// Limits a caller states for one route. Neither may be 0 or exceed the
/// legacy `travel` constants (32 steps, 4 provinces): the verifier caps,
/// it does not define, how far a march goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteBounds {
    max_steps: usize,
    max_provinces: usize,
}

impl RouteBounds {
    /// The legacy limits themselves: 32 steps, 4 provinces.
    pub const LEGACY: RouteBounds = RouteBounds {
        max_steps: MAX_PATH_STEPS,
        max_provinces: MAX_PATH_PROVINCES,
    };

    /// `1..=32` steps and `1..=4` provinces, else [`RouteError::Bounds`].
    pub const fn new(max_steps: usize, max_provinces: usize) -> Result<RouteBounds, RouteError> {
        if max_steps == 0
            || max_steps > MAX_PATH_STEPS
            || max_provinces == 0
            || max_provinces > MAX_PATH_PROVINCES
        {
            return Err(RouteError::Bounds {
                max_steps,
                max_provinces,
            });
        }
        Ok(RouteBounds {
            max_steps,
            max_provinces,
        })
    }

    pub const fn max_steps(&self) -> usize {
        self.max_steps
    }

    pub const fn max_provinces(&self) -> usize {
        self.max_provinces
    }
}

/// Why a route is refused, each case named. `step` is the 0-based index
/// of the offending step, as in `travel::TravelError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteError {
    EmptyRoute,
    /// Bounds of 0 or above the legacy constants.
    Bounds {
        max_steps: usize,
        max_provinces: usize,
    },
    TooLong {
        steps: usize,
        max_steps: usize,
    },
    /// The start or a step is a tile of another world.
    WorldMismatch {
        expected: WorldId,
        got: WorldId,
    },
    /// A step not adjacent to the previous tile.
    NotAdjacent {
        step: u8,
    },
    /// A step entering one more distinct province than allowed.
    TooManyProvinces {
        step: u8,
        max_provinces: usize,
    },
    /// A province the source has never reported: unknown land is not land.
    UnknownProvince {
        key: ProvinceKey,
    },
    /// A province the source reported closed.
    ClosedProvince {
        key: ProvinceKey,
    },
    /// The source returned an entry for a different province or world.
    SourceKeyMismatch {
        expected: ProvinceKey,
        got: ProvinceKey,
    },
    /// The source refused the question (a key of another world, …).
    Source(IndexError),
}

/// A route the verifier accepted: adjacent steps within the bounds over
/// provinces every one of which the source reported open. It carries no
/// cost and grants nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedRoute {
    pub world: WorldId,
    pub start: TileAddress,
    pub end: TileAddress,
    pub steps: usize,
    /// Distinct provinces the steps enter, in first-entered order (the
    /// legacy `PathCost::provinces` rule: the start's province is listed
    /// only if a step enters it).
    pub provinces: Vec<ProvinceKey>,
}

fn require_open<S: ProvinceSource>(source: &S, key: &ProvinceKey) -> Result<(), RouteError> {
    match source.reported(key).map_err(RouteError::Source)? {
        Lookup::Unknown => Err(RouteError::UnknownProvince { key: *key }),
        Lookup::Known(e) if e.key != *key => Err(RouteError::SourceKeyMismatch {
            expected: *key,
            got: e.key,
        }),
        Lookup::Known(e) => match e.state {
            ReportedState::Open => Ok(()),
            ReportedState::Closed => Err(RouteError::ClosedProvince { key: *key }),
        },
    }
}

fn route_world(expected: WorldId, tile: &WideTile) -> Result<(), RouteError> {
    if tile.world() == expected {
        Ok(())
    } else {
        Err(RouteError::WorldMismatch {
            expected,
            got: tile.world(),
        })
    }
}

/// Checks `steps` from `start` in `world`: every tile of `world`, every
/// step adjacent to the previous tile, at most `bounds.max_steps` steps,
/// at most `bounds.max_provinces` distinct provinces entered, and the
/// start's province and every entered province reported open by `source`.
/// The checks run in the order of `travel::path_cost` (length, then step
/// by step: adjacency, then the province count), with the source asked
/// once per distinct province. Nothing is priced, timed or moved.
pub fn verify_route<S: ProvinceSource>(
    world: WorldId,
    start: &WideTile,
    steps: &[WideTile],
    bounds: RouteBounds,
    source: &S,
) -> Result<VerifiedRoute, RouteError> {
    if steps.is_empty() {
        return Err(RouteError::EmptyRoute);
    }
    if steps.len() > bounds.max_steps {
        return Err(RouteError::TooLong {
            steps: steps.len(),
            max_steps: bounds.max_steps,
        });
    }
    route_world(world, start)?;
    let start_key = start.province();
    require_open(source, &start_key)?;
    let mut open: Vec<ProvinceKey> = Vec::with_capacity(bounds.max_provinces + 1);
    open.push(start_key);
    let mut provinces: Vec<ProvinceKey> = Vec::with_capacity(bounds.max_provinces);
    let mut prev = *start;
    for (i, s) in steps.iter().enumerate() {
        let step = u8::try_from(i).unwrap_or(u8::MAX);
        route_world(world, s)?;
        let adjacent = prev.is_adjacent(s).map_err(|e| match e {
            TileError::WorldMismatch { expected, got } => {
                RouteError::WorldMismatch { expected, got }
            }
            // `is_adjacent` fails only on a world mismatch, refused above.
            TileError::OutOfWorld | TileError::LocalIndex(_) => RouteError::NotAdjacent { step },
        })?;
        if !adjacent {
            return Err(RouteError::NotAdjacent { step });
        }
        let key = s.province();
        if !provinces.contains(&key) {
            if provinces.len() == bounds.max_provinces {
                return Err(RouteError::TooManyProvinces {
                    step,
                    max_provinces: bounds.max_provinces,
                });
            }
            if !open.contains(&key) {
                require_open(source, &key)?;
                open.push(key);
            }
            provinces.push(key);
        }
        prev = *s;
    }
    Ok(VerifiedRoute {
        world,
        start: start.address(),
        end: prev.address(),
        steps: steps.len(),
        provinces,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::index::{IndexEntry, OpenedProvinceIndex, FIRST_REVISION};
    use crate::world_index::legacy::{legacy_of, wide_of, LegacyAdapter, LegacyError};
    use core::cell::Cell;
    use permutation_rules::frontier::geometry::{
        cell_centre, check_hex, locate, province_of, provinces_within, ring_provinces,
        ProvinceCoord, COORD_BOUND, R_MAX_HARD,
    };
    use permutation_rules::frontier::travel::{path_cost, Step, TravelError};
    use permutation_rules::map::Terrain;
    use permutation_rules::units::UnitType;
    use std::collections::BTreeSet;
    use std::vec::Vec;

    const B: i64 = WIDE_BOUND;

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn key(w: WorldId, p: i64, q: i64) -> ProvinceKey {
        ProvinceKey::new(w, WideCoord::checked(p, q).unwrap())
    }

    fn tile(w: WorldId, q: i128, r: i128) -> WideTile {
        WideTile::checked(w, q, r).unwrap()
    }

    fn at(k: ProvinceKey, local: u8) -> WideTile {
        WideTile::of(TileAddress::new(k, local).unwrap())
    }

    /// An index of `w` with `open` reported open and `closed` reported closed.
    fn reported(w: WorldId, open: &[ProvinceKey], closed: &[ProvinceKey]) -> OpenedProvinceIndex {
        let mut idx = OpenedProvinceIndex::new(w);
        for (i, k) in open.iter().enumerate() {
            idx.insert(IndexEntry {
                key: *k,
                revision: FIRST_REVISION,
                state: ReportedState::Open,
                observed_at: i as u64,
            })
            .unwrap();
        }
        for (i, k) in closed.iter().enumerate() {
            idx.insert(IndexEntry {
                key: *k,
                revision: FIRST_REVISION,
                state: ReportedState::Closed,
                observed_at: 1000 + i as u64,
            })
            .unwrap();
        }
        idx
    }

    /// The tiles `(1, 0) ..= (n, 0)`: a straight walk east from the Concord
    /// centre, which leaves the Concord at step 5 and crosses one province
    /// boundary every few steps.
    fn east(w: WorldId, n: i128) -> Vec<WideTile> {
        (1..=n).map(|q| tile(w, q, 0)).collect()
    }

    fn legacy_steps(tiles: &[WideTile]) -> Vec<Step> {
        tiles
            .iter()
            .map(|t| Step {
                hex: t.legacy_hex().unwrap(),
                terrain: Terrain::Plains,
                road: false,
            })
            .collect()
    }

    #[test]
    fn lattice_constants_are_the_legacy_ones() {
        for p in -40..=40i32 {
            for q in -40..=40i32 {
                let legacy = cell_centre(Hex::new(p, q), PROVINCE_RADIUS);
                assert_eq!(
                    centre_i128(p as i128, q as i128),
                    (legacy.q as i128, legacy.r as i128)
                );
            }
        }
        assert_eq!(centre_i128(1, 0), (9, -4));
        assert_eq!(centre_i128(0, 1), (4, 5));
        assert_eq!(TILE_COORD_BOUND, 13 * (1i128 << 62) + 4);
        assert_eq!(MAX_PATH_STEPS, 32);
        assert_eq!(MAX_PATH_PROVINCES, 4);
        assert_eq!(RouteBounds::LEGACY, RouteBounds::new(32, 4).unwrap());
        assert_eq!(R_MAX_HARD, 128);
        assert_eq!(COORD_BOUND, 1 << 16);
    }

    /// Every tile of every province of the legacy disk (49,537 × 61): the
    /// wide tile is the legacy tile, locates to the same province and local
    /// index both ways, and the legacy `locate` agrees.
    #[test]
    fn every_tile_of_the_legacy_disk_keeps_its_geometry() {
        let w = world(1);
        let a = LegacyAdapter::new(w);
        let n = provinces_within(R_MAX_HARD as u32);
        for i in 0..n {
            let lp = ProvinceCoord::from_index(i);
            let k = a.key_of(lp);
            for local in 0..PROVINCE_TILES as u8 {
                let h = lp.tile(local).unwrap();
                let addr = TileAddress::new(k, local).unwrap();
                let t = WideTile::of(addr);
                assert_eq!(
                    (t.q(), t.r()),
                    (h.q as i128, h.r as i128),
                    "{lp:?} tile {local}"
                );
                assert_eq!(t.address(), addr);
                assert_eq!(t.province(), k);
                assert_eq!(t.local(), local);
                let back = WideTile::checked(w, h.q as i128, h.r as i128).unwrap();
                assert_eq!(back, t, "{lp:?} tile {local}");
                assert_eq!(t.legacy_hex(), Some(h));
                assert_eq!(WideTile::from_legacy(w, h), Ok(t));
                assert_eq!(locate(h), (lp, local), "{lp:?} tile {local}");
            }
        }
    }

    /// Neighbour steps and distances equal the legacy ones on a lattice of
    /// sample tiles in a box well past ring 128 (|q|, |r| ≤ 1,800 holds
    /// every tile of ring ≤ 138), and the province of any tile is the
    /// legacy `province_of`.
    #[test]
    fn tiles_in_a_box_locate_and_step_like_the_legacy_grid() {
        let w = world(1);
        let a = LegacyAdapter::new(w);
        let far_hex = Hex::new(2, -3);
        let far = tile(w, 2, -3);
        for q in (-1800..=1800i32).step_by(13) {
            for r in (-1800..=1800i32).step_by(11) {
                let h = Hex::new(q, r);
                let t = tile(w, q as i128, r as i128);
                let (lp, li) = locate(h);
                assert_eq!(lp, province_of(h));
                assert_eq!(t.province(), a.key_of(lp), "{h:?}");
                assert_eq!(t.local(), li, "{h:?}");
                for (wn, ln) in t.neighbors().into_iter().zip(h.neighbors()) {
                    let wn = wn.unwrap();
                    assert_eq!(wn.legacy_hex(), Some(ln));
                    assert_eq!(t.distance(&wn), Ok(1));
                    assert_eq!(t.is_adjacent(&wn), Ok(true));
                    assert_eq!(wn.distance(&t), Ok(h.distance(ln) as u128));
                }
                assert_eq!(t.distance(&far), Ok(h.distance(far_hex) as u128));
            }
        }
    }

    /// Ring 129, the first ring the legacy disk has no identity for: every
    /// tile round-trips, every crossing from a ring-128 tile lands where
    /// the legacy `locate` says, every ring-129 province is reached by some
    /// crossing, and the adapter refuses a dense index there.
    #[test]
    fn ring_129_crossings_locate_exactly_on_both_sides() {
        let w = world(1);
        let a = LegacyAdapter::new(w);
        let beyond = Err(LegacyError::BeyondLegacyDisk { ring: 129 });
        for pos in 0..6 * 129u64 {
            let c = WideCoord::from_ring_position(super::super::coord::RingPosition {
                ring: 129,
                wedge: (pos / 129) as u8,
                pos: pos % 129,
            })
            .unwrap();
            let lp = legacy_of(c).unwrap();
            let k = a.key_of(lp);
            assert_eq!(a.dense_index_of(&k), beyond);
            for local in 0..PROVINCE_TILES as u8 {
                let t = at(k, local);
                let h = t.legacy_hex().unwrap();
                assert_eq!(locate(h), (lp, local));
                assert_eq!(WideTile::checked(w, t.q(), t.r()), Ok(t));
                assert_eq!(lp.tile(local), Some(h));
            }
        }
        let mut touched: BTreeSet<ProvinceKey> = BTreeSet::new();
        let mut crossings = 0u32;
        for lp in ring_provinces(128) {
            let k = a.key_of(lp);
            for local in 0..PROVINCE_TILES as u8 {
                let t = at(k, local);
                for n in t.neighbors().into_iter().flatten() {
                    let pk = n.province();
                    let ring = pk.coord().ring();
                    assert!((127..=129).contains(&ring), "{pk:?}");
                    if ring != 129 {
                        continue;
                    }
                    crossings += 1;
                    touched.insert(pk);
                    assert_eq!(t.distance(&n), Ok(1));
                    let (lq, li) = locate(n.legacy_hex().unwrap());
                    assert_eq!(lq.ring(), 129);
                    assert_eq!((wide_of(lq), li), (pk.coord(), n.local()));
                    assert_eq!(a.coord_of(&pk), Ok(lq));
                    assert_eq!(a.dense_index_of(&pk), beyond);
                    assert!(n.neighbors().into_iter().flatten().any(|b| b == t));
                }
            }
        }
        assert!(crossings > 0);
        assert_eq!(
            touched.len(),
            6 * 129,
            "every ring-129 province is crossed into"
        );
    }

    /// Past 2⁵³ a JS `Number` (or any `f64`) cannot hold a tile coordinate;
    /// the `i128` geometry is exact there and has no legacy narrowing.
    #[test]
    fn coordinates_past_2_53_stay_exact() {
        let w = world(1);
        let big = 1i64 << 53;
        for (p, q) in [
            (big + 1, -3),
            (-big - 7, big),
            (big, big),
            (1 << 54, -(1 << 55)),
        ] {
            let k = key(w, p, q);
            assert_eq!(legacy_of(k.coord()), Err(LegacyError::BeyondI32));
            let mut inexact_in_f64 = 0;
            for local in 0..PROVINCE_TILES as u8 {
                let t = at(k, local);
                assert_eq!(
                    WideTile::checked(w, t.q(), t.r()),
                    Ok(t),
                    "{k:?} tile {local}"
                );
                assert_eq!(t.address(), TileAddress::new(k, local).unwrap());
                assert_eq!(t.legacy_hex(), None);
                if (t.q() as f64) as i128 != t.q() || (t.r() as f64) as i128 != t.r() {
                    inexact_in_f64 += 1;
                }
                for n in t.neighbors().into_iter().flatten() {
                    assert_eq!(t.distance(&n), Ok(1));
                    assert_eq!(WideTile::checked(w, n.q(), n.r()), Ok(n));
                    assert!(n.province().coord().distance(k.coord()) <= 1);
                }
            }
            assert!(inexact_in_f64 > 0, "{k:?}: an f64 would round these tiles");
        }
        // the centre of (2⁵³ + 1, −3) is 9·2⁵³ − 3, which no f64 holds
        let c = at(key(w, big + 1, -3), 30);
        assert_eq!(tile_offset(30), Some(Hex::ORIGIN));
        assert_eq!(
            (c.q(), c.r()),
            (9 * (big as i128) - 3, -4 * (big as i128) - 19)
        );
        assert_ne!((c.q() as f64) as i128, c.q());
    }

    /// The four corners and two edges of the province bound: every tile
    /// round-trips, the last tile sits exactly at `TILE_COORD_BOUND`, and a
    /// step past the last province is `None`, never a wrapped tile.
    #[test]
    fn far_bound_corner_tiles_round_trip_and_refuse_to_leave_the_world() {
        let w = world(1);
        for (p, q) in [
            (B, B),
            (-B, -B),
            (B, -B),
            (-B, B),
            (B, 0),
            (0, -B),
            (B - 1, B),
        ] {
            let k = key(w, p, q);
            for local in 0..PROVINCE_TILES as u8 {
                let t = at(k, local);
                assert!(t.q().abs() <= TILE_COORD_BOUND && t.r().abs() <= TILE_COORD_BOUND);
                assert_eq!(
                    WideTile::checked(w, t.q(), t.r()),
                    Ok(t),
                    "{k:?} tile {local}"
                );
                assert_eq!(t.province(), k);
                assert_eq!(t.legacy_hex(), None);
                for n in t.neighbors().into_iter().flatten() {
                    assert_eq!(t.distance(&n), Ok(1));
                    assert!(n.neighbors().into_iter().flatten().any(|b| b == t));
                }
            }
        }
        // (B, B) is centred at (13B, B); its tile at offset (4, 0) is the
        // farthest tile of the world in q
        let corner = key(w, B, B);
        let east = at(corner, tile_index(Hex::new(4, 0)).unwrap());
        assert_eq!((east.q(), east.r()), (TILE_COORD_BOUND, B as i128));
        assert_eq!(tile(w, TILE_COORD_BOUND, B as i128), east);
        // DIRECTIONS: (1,0) (1,-1) (0,-1) (-1,0) (-1,1) (0,1); the first two
        // land in province (B + 1, B), the last in (B, B + 1): no such land
        let n = east.neighbors();
        assert!(n[0].is_none() && n[1].is_none() && n[5].is_none());
        assert_eq!(n[2], Some(tile(w, TILE_COORD_BOUND, B as i128 - 1)));
        assert_eq!(n[3], Some(tile(w, TILE_COORD_BOUND - 1, B as i128)));
        assert_eq!(n[4], Some(tile(w, TILE_COORD_BOUND - 1, B as i128 + 1)));
        for (q, r) in [
            (TILE_COORD_BOUND + 1, B as i128),
            (TILE_COORD_BOUND, B as i128 + 1),
            (TILE_COORD_BOUND + 1, 0),
            (0, TILE_COORD_BOUND + 1),
            (-TILE_COORD_BOUND - 1, 0),
            (i128::MAX, 0),
            (0, i128::MIN),
            (i128::MIN, i128::MIN),
            (i128::MAX, i128::MAX),
            // inside the box, but the nearest province is past the bound
            (TILE_COORD_BOUND, 0),
            (TILE_COORD_BOUND - 100, TILE_COORD_BOUND - 100),
        ] {
            assert_eq!(
                WideTile::checked(w, q, r),
                Err(TileError::OutOfWorld),
                "({q}, {r})"
            );
        }
        // the mirror corner
        let west = at(key(w, -B, -B), tile_index(Hex::new(-4, 0)).unwrap());
        assert_eq!((west.q(), west.r()), (-TILE_COORD_BOUND, -(B as i128)));
        assert!(west.neighbors()[3].is_none());
        // dq = 2·(13B + 4), dr = 2B: (dq + dr + (dq + dr)) / 2 = dq + dr
        let apart = 2 * (TILE_COORD_BOUND as u128) + 2 * (B as u128);
        assert_eq!(west.distance(&east), Ok(apart));
    }

    #[test]
    fn malformed_local_indices_are_refused() {
        let w = world(1);
        for k in [key(w, 0, 0), key(w, 128, 0), key(w, 129, 0), key(w, B, B)] {
            for bad in [61u8, 62, 100, 255] {
                assert_eq!(TileAddress::new(k, bad), Err(TileError::LocalIndex(bad)));
            }
            for local in 0..61u8 {
                let addr = TileAddress::new(k, local).unwrap();
                assert_eq!((addr.key(), addr.world(), addr.local()), (k, w, local));
            }
        }
    }

    /// The legacy narrowing is exact for any `i32` pair and only that; the
    /// legacy entry box (`check_hex`, 2¹⁶) is narrower than the world.
    #[test]
    fn legacy_hex_narrows_only_what_fits_i32() {
        let w = world(1);
        let edge = tile(w, COORD_BOUND as i128, -(COORD_BOUND as i128));
        assert_eq!(edge.legacy_hex(), Some(Hex::new(COORD_BOUND, -COORD_BOUND)));
        assert!(check_hex(edge.legacy_hex().unwrap()).is_ok());
        let past = tile(w, COORD_BOUND as i128 + 1, 0);
        assert_eq!(past.legacy_hex(), Some(Hex::new(COORD_BOUND + 1, 0)));
        assert!(check_hex(past.legacy_hex().unwrap()).is_err());
        for h in [
            Hex::new(i32::MAX, i32::MIN),
            Hex::new(i32::MIN, i32::MIN),
            Hex::new(i32::MAX, i32::MAX),
        ] {
            let t = WideTile::from_legacy(w, h).unwrap();
            assert_eq!(t.legacy_hex(), Some(h));
            assert_eq!(t.province(), ProvinceKey::new(w, wide_of(province_of(h))));
        }
        assert_eq!(tile(w, i32::MAX as i128 + 1, 0).legacy_hex(), None);
        assert_eq!(tile(w, 0, i32::MIN as i128 - 1).legacy_hex(), None);
    }

    #[test]
    fn worlds_do_not_mix() {
        let (a, b) = (world(1), world(2));
        let ta = tile(a, 5, -2);
        let tb = tile(b, 5, -2);
        assert_ne!(ta, tb);
        assert_eq!((ta.q(), ta.r()), (tb.q(), tb.r()));
        assert_eq!(ta.address().local(), tb.address().local());
        assert_ne!(ta.address(), tb.address());
        assert_eq!(
            ta.distance(&tb),
            Err(TileError::WorldMismatch {
                expected: a,
                got: b,
            })
        );
        assert_eq!(
            ta.is_adjacent(&tile(b, 6, -2)),
            Err(TileError::WorldMismatch {
                expected: a,
                got: b,
            })
        );
        assert_eq!(
            tb.distance(&ta),
            Err(TileError::WorldMismatch {
                expected: b,
                got: a,
            })
        );
        assert!(ta.neighbors().into_iter().flatten().all(|n| n.world() == a));
        assert_eq!(WideTile::of(tb.address()), tb);
    }

    #[test]
    fn route_bounds_are_explicit_and_capped_at_the_legacy_limits() {
        let fields = |b: RouteBounds| (b.max_steps(), b.max_provinces());
        assert_eq!(RouteBounds::new(32, 4).map(fields), Ok((32, 4)));
        assert_eq!(RouteBounds::new(1, 1).map(fields), Ok((1, 1)));
        assert_eq!(RouteBounds::new(7, 2).map(fields), Ok((7, 2)));
        let bad = [
            (33, 4),
            (32, 5),
            (0, 4),
            (32, 0),
            (usize::MAX, 1),
            (1, usize::MAX),
            (0, 0),
        ];
        for (s, p) in bad {
            assert_eq!(
                RouteBounds::new(s, p),
                Err(RouteError::Bounds {
                    max_steps: s,
                    max_provinces: p,
                })
            );
        }
    }

    /// The straight walk east is the legacy `path_cost` walk: the same
    /// provinces in the same order, the same refusal at the fifth province
    /// and the same length limit, with no cost attached.
    #[test]
    fn a_bounded_route_over_reported_open_land_matches_the_legacy_path_check() {
        let w = world(1);
        let a = LegacyAdapter::new(w);
        let start = tile(w, 0, 0);
        assert_eq!(start.province(), key(w, 0, 0));
        // the provinces the first 32 tiles east pass through, by legacy
        let all = east(w, 32);
        let open: Vec<ProvinceKey> = {
            let mut v: Vec<ProvinceKey> = Vec::new();
            for t in &all {
                if !v.contains(&t.province()) {
                    v.push(t.province());
                }
            }
            v
        };
        assert_eq!(
            open,
            [
                key(w, 0, 0),
                key(w, 1, 0),
                key(w, 1, 1),
                key(w, 2, 1),
                key(w, 2, 2),
                key(w, 3, 2),
            ]
        );
        let idx = reported(w, &open, &[]);
        let src = |k: &ProvinceKey| idx.lookup(k);

        let steps = east(w, 23);
        let v = verify_route(w, &start, &steps, RouteBounds::LEGACY, &src).unwrap();
        assert_eq!(v.world, w);
        assert_eq!(v.start, start.address());
        assert_eq!(v.end, steps[22].address());
        assert_eq!(v.steps, 23);
        assert_eq!(v.provinces, open[..4]);
        let legacy = path_cost(Hex::ORIGIN, &legacy_steps(&steps), UnitType::Spearman).unwrap();
        assert_eq!(legacy.hexes, 23);
        let keys: Vec<ProvinceKey> = legacy.provinces.iter().map(|p| a.key_of(*p)).collect();
        assert_eq!(keys, v.provinces);

        // the 24th tile enters a fifth province: refused at step 23, as legacy
        let steps = east(w, 24);
        assert_eq!(
            verify_route(w, &start, &steps, RouteBounds::LEGACY, &src),
            Err(RouteError::TooManyProvinces {
                step: 23,
                max_provinces: 4,
            })
        );
        assert_eq!(
            path_cost(Hex::ORIGIN, &legacy_steps(&steps), UnitType::Spearman),
            Err(TravelError::TooManyProvinces)
        );
        // 33 steps: too long before anything else is looked at
        let steps = east(w, 33);
        assert_eq!(
            verify_route(w, &start, &steps, RouteBounds::LEGACY, &src),
            Err(RouteError::TooLong {
                steps: 33,
                max_steps: 32,
            })
        );
        assert_eq!(
            path_cost(Hex::ORIGIN, &legacy_steps(&steps), UnitType::Spearman),
            Err(TravelError::TooLong)
        );
        // tighter explicit bounds bind
        let steps = east(w, 11);
        assert_eq!(
            verify_route(w, &start, &steps, RouteBounds::new(10, 4).unwrap(), &src),
            Err(RouteError::TooLong {
                steps: 11,
                max_steps: 10,
            })
        );
        assert_eq!(
            verify_route(w, &start, &steps, RouteBounds::new(11, 2).unwrap(), &src),
            Err(RouteError::TooManyProvinces {
                step: 9,
                max_provinces: 2,
            })
        );
        let three = RouteBounds::new(11, 3).unwrap();
        assert!(verify_route(w, &start, &steps, three, &src).is_ok());
        // a skipped tile is not adjacent, as legacy
        let mut skip = east(w, 6);
        skip.remove(2);
        assert_eq!(
            verify_route(w, &start, &skip, RouteBounds::LEGACY, &src),
            Err(RouteError::NotAdjacent { step: 2 })
        );
        assert_eq!(
            path_cost(Hex::ORIGIN, &legacy_steps(&skip), UnitType::Spearman),
            Err(TravelError::NotAdjacent(2))
        );
        // standing still is not a step
        let still = [start, tile(w, 1, 0)];
        assert_eq!(
            verify_route(w, &start, &still, RouteBounds::LEGACY, &src),
            Err(RouteError::NotAdjacent { step: 0 })
        );
        assert_eq!(
            verify_route(w, &start, &[], RouteBounds::LEGACY, &src),
            Err(RouteError::EmptyRoute)
        );
        assert_eq!(
            path_cost(Hex::ORIGIN, &[], UnitType::Spearman),
            Err(TravelError::EmptyPath)
        );
        // a walk that stays inside the start's province enters no new one
        let inside = [tile(w, 1, 0), tile(w, 1, -1), tile(w, 0, -1)];
        let one = RouteBounds::new(3, 1).unwrap();
        let v = verify_route(w, &start, &inside, one, &src).unwrap();
        assert_eq!(v.provinces, [key(w, 0, 0)]);
    }

    /// Land the source has not reported open is not land: unknown, closed,
    /// another world's index, and tiles of another world each refuse the
    /// route by name, and the source is asked once per distinct province.
    #[test]
    fn no_fake_land_unknown_closed_and_other_world_provinces_refuse_the_route() {
        let w = world(1);
        let start = tile(w, 0, 0);
        let steps = east(w, 5); // (5, 0) is the first tile of province (1, 0)
        assert_eq!(steps[4].province(), key(w, 1, 0));
        let concord = key(w, 0, 0);
        let east1 = key(w, 1, 0);

        let bounds = RouteBounds::LEGACY;

        let only_concord = reported(w, &[concord], &[]);
        let src = |k: &ProvinceKey| only_concord.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, bounds, &src),
            Err(RouteError::UnknownProvince { key: east1 })
        );
        let closed = reported(w, &[concord], &[east1]);
        let src = |k: &ProvinceKey| closed.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, bounds, &src),
            Err(RouteError::ClosedProvince { key: east1 })
        );
        let nothing = reported(w, &[], &[]);
        let src = |k: &ProvinceKey| nothing.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, bounds, &src),
            Err(RouteError::UnknownProvince { key: concord })
        );
        let start_closed = reported(w, &[east1], &[concord]);
        let src = |k: &ProvinceKey| start_closed.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, bounds, &src),
            Err(RouteError::ClosedProvince { key: concord })
        );
        // the other world's index knows the same coordinates: its own
        // world check refuses, and the route reports the source's refusal
        let other = world(2);
        let other_idx = reported(other, &[key(other, 0, 0), key(other, 1, 0)], &[]);
        let src = |k: &ProvinceKey| other_idx.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, bounds, &src),
            Err(RouteError::Source(IndexError::WorldMismatch {
                expected: other,
                got: w,
            }))
        );
        // tiles of another world in the route
        let both = reported(w, &[concord, east1], &[]);
        let src = |k: &ProvinceKey| both.lookup(k);
        let mismatch = Err(RouteError::WorldMismatch {
            expected: w,
            got: other,
        });
        let other_start = tile(other, 0, 0);
        assert_eq!(
            verify_route(w, &other_start, &steps, bounds, &src),
            mismatch
        );
        let mut mixed = steps.clone();
        mixed[3] = tile(other, 4, 0);
        assert_eq!(verify_route(w, &start, &mixed, bounds, &src), mismatch);
        assert_eq!(
            verify_route(other, &start, &steps, RouteBounds::LEGACY, &src),
            Err(RouteError::WorldMismatch {
                expected: other,
                got: w,
            })
        );
        // the good route, and the source asked exactly twice (two provinces)
        let calls = Cell::new(0u32);
        let counting = |k: &ProvinceKey| {
            calls.set(calls.get() + 1);
            both.lookup(k)
        };
        let v = verify_route(w, &start, &steps, bounds, &counting).unwrap();
        assert_eq!(v.provinces, [concord, east1]);
        assert_eq!(calls.get(), 2);
        // a refusal never reaches the source past the failing check
        calls.set(0);
        let long = east(w, 33);
        assert!(verify_route(w, &start, &long, bounds, &counting).is_err());
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn a_source_cannot_substitute_another_open_province() {
        let w = world(1);
        let start = tile(w, 0, 0);
        let steps = east(w, 1);
        for wrong in [key(w, 129, 0), key(world(2), 0, 0)] {
            let source = |_: &ProvinceKey| {
                Ok(Lookup::Known(IndexEntry {
                    key: wrong,
                    revision: FIRST_REVISION,
                    state: ReportedState::Open,
                    observed_at: 1,
                }))
            };
            assert_eq!(
                verify_route(w, &start, &steps, RouteBounds::LEGACY, &source),
                Err(RouteError::SourceKeyMismatch {
                    expected: start.province(),
                    got: wrong
                })
            );
        }
    }

    /// The same check past the legacy disk and at the far edge: a crossing
    /// into ring 129 needs ring 129 reported open, a walk inside the corner
    /// province passes, and no route can name a tile outside the world.
    #[test]
    fn routes_at_ring_129_and_at_the_far_corner_are_the_same_check() {
        let w = world(1);
        let a = LegacyAdapter::new(w);
        let rim = a.key_of(ProvinceCoord::new(128, 0));
        let beyond = a.key_of(ProvinceCoord::new(129, 0));
        assert_eq!(beyond.coord().ring(), 129);
        let start = at(rim, tile_index(Hex::new(4, 0)).unwrap());
        assert_eq!((start.q(), start.r()), (1156, -512));
        let steps = [tile(w, 1157, -512), tile(w, 1158, -512)];
        assert_eq!(steps[0].province(), beyond);
        assert_eq!(steps[0].local(), tile_index(Hex::new(-4, 4)).unwrap());
        assert_eq!(steps[1].province(), beyond);
        let legacy = path_cost(
            start.legacy_hex().unwrap(),
            &legacy_steps(&steps),
            UnitType::Spearman,
        )
        .unwrap();
        assert_eq!(legacy.provinces, [ProvinceCoord::new(129, 0)]);

        let both = reported(w, &[rim, beyond], &[]);
        let src = |k: &ProvinceKey| both.lookup(k);
        let v = verify_route(w, &start, &steps, RouteBounds::LEGACY, &src).unwrap();
        assert_eq!(v.provinces, [beyond]);
        assert_eq!(v.end.key(), beyond);
        let rim_only = reported(w, &[rim], &[]);
        let src = |k: &ProvinceKey| rim_only.lookup(k);
        assert_eq!(
            verify_route(w, &start, &steps, RouteBounds::LEGACY, &src),
            Err(RouteError::UnknownProvince { key: beyond })
        );

        // the corner province (B, B): its row r = B from offset −4 to +4
        let corner = key(w, B, B);
        let bq = 13 * (B as i128);
        let br = B as i128;
        let row: Vec<WideTile> = (-4..=4i128).map(|dq| tile(w, bq + dq, br)).collect();
        assert!(row.iter().all(|t| t.province() == corner));
        let open = reported(w, &[corner], &[]);
        let src = |k: &ProvinceKey| open.lookup(k);
        let eight = RouteBounds::new(8, 1).unwrap();
        let v = verify_route(w, &row[0], &row[1..], eight, &src).unwrap();
        assert_eq!(v.steps, 8);
        assert_eq!(v.provinces, [corner]);
        assert_eq!(v.end, row[8].address());
        // one more step east does not exist as a tile at all
        assert_eq!(WideTile::checked(w, bq + 5, br), Err(TileError::OutOfWorld));
        // a route may turn back inside the province, but a jump is not a step
        let mut pretend = row[1..].to_vec();
        pretend.push(tile(w, bq + 3, br + 1)); // adjacent, still (B, B)
        pretend.push(tile(w, bq, br)); // the centre: four tiles away
        let ten = RouteBounds::new(10, 1).unwrap();
        assert_eq!(
            verify_route(w, &row[0], &pretend, ten, &src),
            Err(RouteError::NotAdjacent { step: 9 })
        );
    }
}
