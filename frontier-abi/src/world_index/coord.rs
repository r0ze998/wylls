//! Wide axial province coordinates (experimental; see the module doc of
//! [`super`]).
//!
//! A [`WideCoord`] is a (P, Q) pair of `i64` on the same province lattice
//! as the legacy `i32` pair `permutation_rules::frontier::geometry::
//! ProvinceCoord`: ring = hex distance from the Concord, wedge = sextant,
//! `rotate` = the same 60° turn. It is bounded to |P|, |Q| ≤ [`WIDE_BOUND`]
//! (2⁶²) at construction, so that a ring fits `u64`, a neighbour step or a
//! rotation can only leave the bound (never wrap), and every intermediate
//! of this module, all computed in `i128`, is far from overflow.
//!
//! There is **no dense index**. A coordinate's canonical sort key
//! ([`WideCoord::sort_key`]) is 17 bytes, `ring (u64 BE) ‖ wedge (u8) ‖
//! position in the wedge (u64 BE)`, and byte order of sort keys is ring
//! order: the order the legacy `ProvinceCoord::index` gives within ring
//! 128 (`super::legacy` pins this for all 49,537 legacy provinces) and the
//! same rule past it. The key is lossless (`from_sort_key` refuses any
//! bytes that are not the canonical encoding of a coordinate in bounds).

use core::cmp::Ordering;
use permutation_rules::hex::DIRECTIONS;

/// Largest |P| and |Q| of a [`WideCoord`]: 2⁶². The ring of any coordinate
/// in bounds is at most 2⁶³ (`u64`), and a single lattice step from any
/// coordinate in bounds fits `i64`.
pub const WIDE_BOUND: i64 = 1 << 62;
/// Bytes of a canonical sort key: `ring ‖ wedge ‖ position`.
pub const SORT_KEY_LEN: usize = 17;
/// Sextants of the province grid.
pub const WEDGES: u8 = 6;

/// A coordinate or a key the module refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordError {
    /// |P| or |Q| above [`WIDE_BOUND`], or an operation whose result would
    /// be.
    OutOfBounds,
    /// Bytes or a ring position that are not the canonical encoding of any
    /// coordinate (wedge ≥ 6, position ≥ ring, a nonzero wedge or position
    /// for ring 0).
    NonCanonical,
}

/// A province coordinate on the wide lattice. Equal coordinates are equal
/// pairs; the order is ring order ([`WideCoord::ring_position`]), never
/// the raw (P, Q) order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct WideCoord {
    p: i64,
    q: i64,
}

/// Where a coordinate sits in ring order: its ring, its wedge (sextant,
/// 0 for the Concord) and its position along the wedge (`0..ring`, 0 for
/// the Concord). The derived order (ring, wedge, position) is the sort-key
/// byte order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RingPosition {
    pub ring: u64,
    pub wedge: u8,
    pub pos: u64,
}

impl WideCoord {
    /// The Concord, ring 0.
    pub const CONCORD: WideCoord = WideCoord { p: 0, q: 0 };

    /// The only public constructor: `(p, q)` if both lie within
    /// ±[`WIDE_BOUND`].
    pub fn checked(p: i64, q: i64) -> Result<WideCoord, CoordError> {
        let bound = -WIDE_BOUND..=WIDE_BOUND;
        if bound.contains(&p) && bound.contains(&q) {
            Ok(WideCoord { p, q })
        } else {
            Err(CoordError::OutOfBounds)
        }
    }

    /// Any `i32` pair is in bounds (|i32| < 2³¹ ≪ 2⁶²): the lossless
    /// widening the legacy adapter uses.
    pub(super) const fn from_i32(p: i32, q: i32) -> WideCoord {
        WideCoord {
            p: p as i64,
            q: q as i64,
        }
    }

    pub const fn p(self) -> i64 {
        self.p
    }

    pub const fn q(self) -> i64 {
        self.q
    }

    pub fn is_concord(self) -> bool {
        self == Self::CONCORD
    }

    /// Hex distance from the Concord, at most 2⁶³.
    pub fn ring(self) -> u64 {
        ring_i128(self.p as i128, self.q as i128) as u64
    }

    /// Sextant of a coordinate outside the Concord (`None` for the
    /// Concord), the legacy `ProvinceCoord::wedge`.
    pub fn wedge(self) -> Option<u8> {
        if self.is_concord() {
            None
        } else {
            Some(self.ring_position().wedge)
        }
    }

    /// Ring, wedge and position along the wedge, the legacy dense rule
    /// (`ProvinceCoord::index`) computed in `i128`: the wedge `k` is the
    /// first of six turns back by 60° that lands in `{q > 0, r ≥ 0}`, and
    /// the position is the `r` there.
    pub fn ring_position(self) -> RingPosition {
        let ring = self.ring();
        if ring == 0 {
            return RingPosition {
                ring: 0,
                wedge: 0,
                pos: 0,
            };
        }
        let (mut a, mut b) = (self.p as i128, self.q as i128);
        for wedge in 0..WEDGES {
            if a > 0 && b >= 0 {
                return RingPosition {
                    ring,
                    wedge,
                    pos: b as u64,
                };
            }
            // turn back by 60°: (q, r) → (q + r, −q)
            let (na, nb) = (a + b, -a);
            a = na;
            b = nb;
        }
        // The six sets {q > 0, r ≥ 0} turned by k × 60° partition the
        // nonzero lattice, so one of the six turns above always returns.
        debug_assert!(false, "a nonzero hex lies in one of six sextants");
        RingPosition {
            ring,
            wedge: 0,
            pos: 0,
        }
    }

    /// Inverse of [`WideCoord::ring_position`]: the coordinate at `rp`, or
    /// `NonCanonical` if no coordinate has that position, or `OutOfBounds`
    /// if it lies past [`WIDE_BOUND`].
    pub fn from_ring_position(rp: RingPosition) -> Result<WideCoord, CoordError> {
        let RingPosition { ring, wedge, pos } = rp;
        if wedge >= WEDGES {
            return Err(CoordError::NonCanonical);
        }
        if ring == 0 {
            return if wedge == 0 && pos == 0 {
                Ok(Self::CONCORD)
            } else {
                Err(CoordError::NonCanonical)
            };
        }
        if pos >= ring {
            return Err(CoordError::NonCanonical);
        }
        // the canonical copy in wedge 0: (ring − pos, pos), turned k times
        let (mut a, mut b) = ((ring - pos) as i128, pos as i128);
        for _ in 0..wedge {
            let (na, nb) = (-b, a + b);
            a = na;
            b = nb;
        }
        let p = i64::try_from(a).map_err(|_| CoordError::OutOfBounds)?;
        let q = i64::try_from(b).map_err(|_| CoordError::OutOfBounds)?;
        let c = WideCoord::checked(p, q)?;
        // canonical by construction; pinned rather than assumed
        if c.ring_position() != rp {
            return Err(CoordError::NonCanonical);
        }
        Ok(c)
    }

    /// The canonical 17-byte key `ring (BE) ‖ wedge ‖ position (BE)`.
    pub fn sort_key(self) -> [u8; SORT_KEY_LEN] {
        let rp = self.ring_position();
        let mut k = [0u8; SORT_KEY_LEN];
        k[..8].copy_from_slice(&rp.ring.to_be_bytes());
        k[8] = rp.wedge;
        k[9..].copy_from_slice(&rp.pos.to_be_bytes());
        k
    }

    /// Inverse of [`WideCoord::sort_key`]; refuses non-canonical bytes.
    pub fn from_sort_key(key: &[u8; SORT_KEY_LEN]) -> Result<WideCoord, CoordError> {
        let mut ring = [0u8; 8];
        ring.copy_from_slice(&key[..8]);
        let mut pos = [0u8; 8];
        pos.copy_from_slice(&key[9..]);
        Self::from_ring_position(RingPosition {
            ring: u64::from_be_bytes(ring),
            wedge: key[8],
            pos: u64::from_be_bytes(pos),
        })
    }

    /// The coordinate's ordinal in ring order, `1 + 3d(d − 1) + k·d + pos`
    /// as `u128`. Equal to the legacy dense index within ring 128. It is
    /// **not an identifier**: nothing packs it into a host id or an
    /// account key, and past ring 128 it exceeds every legacy field (the
    /// legacy adapter refuses rather than truncates).
    pub fn ordinal(self) -> u128 {
        let rp = self.ring_position();
        if rp.ring == 0 {
            return 0;
        }
        let d = rp.ring as u128;
        provinces_within_u128(d - 1) + rp.wedge as u128 * d + rp.pos as u128
    }

    /// Hex distance between two coordinates, at most 2⁶⁴ (so `u128`).
    pub fn distance(self, other: WideCoord) -> u128 {
        let dp = self.p as i128 - other.p as i128;
        let dq = self.q as i128 - other.q as i128;
        (dp.unsigned_abs() + dq.unsigned_abs() + (dp + dq).unsigned_abs()) / 2
    }

    /// The six neighbours in `hex::DIRECTIONS` order; `None` where the step
    /// leaves [`WIDE_BOUND`] (no wrap).
    pub fn neighbors(self) -> [Option<WideCoord>; 6] {
        DIRECTIONS.map(|(dp, dq)| self.step(dp as i64, dq as i64))
    }

    /// One lattice step of at most one unit per axis; `None` past the bound.
    fn step(self, dp: i64, dq: i64) -> Option<WideCoord> {
        WideCoord::checked(self.p + dp, self.q + dq).ok()
    }

    /// Turned by 60° about the Concord, the legacy `rotate`: `(p, q) →
    /// (−q, p + q)`; `OutOfBounds` if the turn leaves the bound.
    pub fn rotate(self) -> Result<WideCoord, CoordError> {
        let p = -(self.q as i128);
        let q = self.p as i128 + self.q as i128;
        let p = i64::try_from(p).map_err(|_| CoordError::OutOfBounds)?;
        let q = i64::try_from(q).map_err(|_| CoordError::OutOfBounds)?;
        WideCoord::checked(p, q)
    }
}

impl PartialOrd for WideCoord {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for WideCoord {
    /// Ring order: ring, then wedge, then position (sort-key byte order).
    fn cmp(&self, other: &Self) -> Ordering {
        self.ring_position().cmp(&other.ring_position())
    }
}

/// `(|p| + |q| + |p + q|) / 2` in `i128`.
fn ring_i128(p: i128, q: i128) -> u128 {
    (p.unsigned_abs() + q.unsigned_abs() + (p + q).unsigned_abs()) / 2
}

/// Provinces in rings `0..=d`: `1 + 3d(d + 1)`, in `u128` (no overflow
/// for `d ≤ 2⁶³`).
const fn provinces_within_u128(d: u128) -> u128 {
    1 + 3 * d * (d + 1)
}

/// Provinces in ring `d`: 1 for the Concord, else `6d`.
#[cfg(test)]
const fn ring_size_u128(d: u128) -> u128 {
    if d == 0 {
        1
    } else {
        6 * d
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use permutation_rules::frontier::geometry::{
        provinces_within, ring_provinces, ProvinceCoord, R_MAX_HARD,
    };
    use std::vec::Vec;

    const B: i64 = WIDE_BOUND;

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    #[test]
    fn bounds_are_inclusive_and_nothing_wraps() {
        for (p, q) in [(0, 0), (B, B), (-B, -B), (B, -B), (-B, B), (B, 0), (0, -B)] {
            let w = c(p, q);
            assert_eq!((w.p(), w.q()), (p, q));
        }
        for (p, q) in [
            (B + 1, 0),
            (0, B + 1),
            (-B - 1, 0),
            (0, -B - 1),
            (i64::MAX, 0),
            (i64::MIN, 0),
            (i64::MIN, i64::MIN),
            (i64::MAX, i64::MAX),
        ] {
            assert_eq!(WideCoord::checked(p, q), Err(CoordError::OutOfBounds));
        }
    }

    #[test]
    fn rings_at_the_extremes_fit_u64() {
        assert_eq!(c(B, B).ring(), 1u64 << 63);
        assert_eq!(c(-B, -B).ring(), 1u64 << 63);
        assert_eq!(c(B, -B).ring(), B as u64);
        assert_eq!(c(-B, B).ring(), B as u64);
        assert_eq!(c(B, 0).ring(), B as u64);
        assert_eq!(c(0, 0).ring(), 0);
        assert_eq!(c(-1, 0).ring(), 1);
        assert_eq!(c(-7, 3).ring(), 7);
        assert_eq!(c(-7, 10).ring(), 10);
        assert_eq!(c(B, B).distance(c(-B, -B)), 1u128 << 64);
        assert_eq!(c(B, B).distance(c(B, B)), 0);
        assert_eq!(c(3, -5).distance(c(-2, 1)), 6);
    }

    #[test]
    fn negative_and_positive_coordinates_take_the_legacy_ring_positions() {
        // Every legacy province within ring 20: the wide ring position is
        // the legacy (ring, wedge, position-in-wedge) of its dense index.
        for d in 0..=20u32 {
            for (i, lp) in ring_provinces(d).into_iter().enumerate() {
                let w = c(lp.p as i64, lp.q as i64);
                let rp = w.ring_position();
                assert_eq!(rp.ring, d as u64, "{lp:?}");
                if d == 0 {
                    assert_eq!((rp.wedge, rp.pos), (0, 0));
                    assert_eq!(w.wedge(), None);
                } else {
                    assert_eq!(rp.wedge as usize, i / d as usize, "{lp:?}");
                    assert_eq!(rp.pos as usize, i % d as usize, "{lp:?}");
                    assert_eq!(w.wedge(), lp.wedge());
                }
                assert_eq!(WideCoord::from_ring_position(rp), Ok(w));
            }
        }
    }

    #[test]
    fn ring_order_equals_the_legacy_dense_order_for_the_whole_legacy_disk() {
        let n = provinces_within(R_MAX_HARD as u32);
        let mut prev: Option<[u8; SORT_KEY_LEN]> = None;
        for i in 0..n {
            let lp = ProvinceCoord::from_index(i);
            let w = c(lp.p as i64, lp.q as i64);
            assert_eq!(w.ordinal(), i as u128, "{lp:?}");
            let k = w.sort_key();
            if let Some(p) = prev {
                assert!(p < k, "index {i} not after its predecessor");
            }
            assert_eq!(WideCoord::from_sort_key(&k), Ok(w));
            prev = Some(k);
        }
    }

    #[test]
    fn sort_keys_round_trip_at_the_extremes_and_past_every_legacy_limit() {
        let far = [
            c(B, B),
            c(-B, -B),
            c(B, -B),
            c(-B, B),
            c(B, 0),
            c(0, B),
            c(-B, 0),
            c(0, -B),
            c(B - 1, -B + 1),
            c(1 << 40, -(1 << 40)),
            c(129, 0),
            c(0, -129),
            c(591, 0),
            c(592, 0),
            c(-591, 591),
            c(i32::MAX as i64, i32::MIN as i64),
            c(i32::MAX as i64 + 1, 0),
        ];
        for w in far {
            let k = w.sort_key();
            assert_eq!(WideCoord::from_sort_key(&k), Ok(w), "{w:?}");
            assert_eq!(WideCoord::from_ring_position(w.ring_position()), Ok(w));
            assert!(w.ordinal() >= provinces_within_u128(w.ring() as u128 - 1));
            assert!(w.ordinal() < provinces_within_u128(w.ring() as u128));
        }
        // past the legacy limits in ordinal terms
        assert!(c(129, 0).ordinal() >= provinces_within(128) as u128);
        // The 20-bit host field ends inside ring 591: its first province
        // still fits, the first province of ring 592 does not.
        assert!(c(591, 0).ordinal() < 1u128 << 20);
        assert!(c(592, 0).ordinal() >= 1u128 << 20, "20-bit host field");
        assert!(c(1 << 40, 0).ordinal() > u64::MAX as u128);
    }

    #[test]
    fn non_canonical_keys_are_refused() {
        let bad = [
            RingPosition {
                ring: 0,
                wedge: 1,
                pos: 0,
            },
            RingPosition {
                ring: 0,
                wedge: 0,
                pos: 1,
            },
            RingPosition {
                ring: 3,
                wedge: 6,
                pos: 0,
            },
            RingPosition {
                ring: 3,
                wedge: 0,
                pos: 3,
            },
            RingPosition {
                ring: 1,
                wedge: 5,
                pos: 1,
            },
            RingPosition {
                ring: 2,
                wedge: 3,
                pos: 2,
            },
        ];
        for rp in bad {
            assert_eq!(
                WideCoord::from_ring_position(rp),
                Err(CoordError::NonCanonical),
                "{rp:?}"
            );
        }
        // Canonical positions past the bound: ring 2⁶³ at wedge 0, pos 0
        // is (2⁶³, 0), outside i64 and the bound.
        let oob = RingPosition {
            ring: 1u64 << 63,
            wedge: 0,
            pos: 0,
        };
        assert_eq!(
            WideCoord::from_ring_position(oob),
            Err(CoordError::OutOfBounds)
        );
        let oob = RingPosition {
            ring: u64::MAX,
            wedge: 0,
            pos: 0,
        };
        assert_eq!(
            WideCoord::from_ring_position(oob),
            Err(CoordError::OutOfBounds)
        );
        // but ring 2⁶³ at pos 2⁶² is (2⁶², 2⁶²), in bounds
        let edge = RingPosition {
            ring: 1u64 << 63,
            wedge: 0,
            pos: 1u64 << 62,
        };
        assert_eq!(WideCoord::from_ring_position(edge), Ok(c(B, B)));
        // byte form of a non-canonical key
        let mut k = c(5, -2).sort_key();
        k[8] = 6;
        assert_eq!(WideCoord::from_sort_key(&k), Err(CoordError::NonCanonical));
        let mut k = c(5, -2).sort_key();
        k[9..].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(WideCoord::from_sort_key(&k), Err(CoordError::NonCanonical));
    }

    #[test]
    fn order_is_ring_then_wedge_then_position_and_matches_bytes() {
        let mut all: Vec<WideCoord> = Vec::new();
        for d in 0..=6u32 {
            for lp in ring_provinces(d) {
                all.push(c(lp.p as i64, lp.q as i64));
            }
        }
        all.push(c(1 << 40, 0));
        all.push(c(0, 1 << 40));
        all.push(c(B, B));
        all.push(c(-B, 0));
        // seeded shuffle, then sort by Ord and by bytes: the same order
        let mut shuffled = all.clone();
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        for i in (1..shuffled.len()).rev() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let j = (s >> 33) as usize % (i + 1);
            shuffled.swap(i, j);
        }
        let mut by_ord = shuffled.clone();
        by_ord.sort();
        let mut by_bytes = shuffled;
        by_bytes.sort_by_key(|w| w.sort_key());
        assert_eq!(by_ord, by_bytes);
        assert!(by_ord.windows(2).all(|w| w[0] < w[1]), "strict, no ties");
        assert!(by_ord
            .windows(2)
            .all(|w| w[0].ring_position() < w[1].ring_position()));
        // ring is the major key
        assert!(c(-1, 0) < c(2, -2));
        assert!(c(B, -B) < c(B, B));
        assert!(c(0, 0) < c(1, 0));
    }

    #[test]
    fn neighbours_and_rotation_refuse_to_leave_the_bound() {
        let inner = c(-3, 7);
        for n in inner.neighbors() {
            let n = n.unwrap();
            assert_eq!(inner.distance(n), 1);
        }
        // the legacy neighbours in the same order
        let lp = ProvinceCoord::new(-3, 7).neighbors();
        for (w, l) in inner.neighbors().into_iter().zip(lp) {
            let w = w.unwrap();
            assert_eq!((w.p(), w.q()), (l.p as i64, l.q as i64));
        }
        let corner = c(B, B);
        let n = corner.neighbors();
        // DIRECTIONS: (1,0) (1,-1) (0,-1) (-1,0) (-1,1) (0,1)
        assert!(n[0].is_none() && n[1].is_none() && n[5].is_none());
        assert_eq!(n[2], Some(c(B, B - 1)));
        assert_eq!(n[3], Some(c(B - 1, B)));
        assert!(n[4].is_none());
        assert_eq!(c(B, 1).rotate(), Err(CoordError::OutOfBounds));
        assert_eq!(c(B, 0).rotate(), Ok(c(0, B)));
        assert_eq!(c(2, -5).rotate(), Ok(c(5, -3)));
        // six turns are the identity where every turn stays in bounds
        let mut w = c(10, -3);
        for _ in 0..6 {
            w = w.rotate().unwrap();
        }
        assert_eq!(w, c(10, -3));
        // a turn raises the wedge by one, as for the legacy grid
        let w = c(4, 1);
        let turned = w.rotate().unwrap();
        assert_eq!(w.wedge(), Some(0));
        assert_eq!(turned.wedge(), Some(1));
        assert_eq!(turned.ring(), w.ring());
    }

    #[test]
    fn counts_agree_with_the_legacy_formulas() {
        for d in 0..200u32 {
            let legacy = provinces_within(d) as u128;
            assert_eq!(provinces_within_u128(d as u128), legacy);
        }
        assert_eq!(ring_size_u128(0), 1);
        assert_eq!(ring_size_u128(7), 42);
        let top = 1u128 << 63;
        assert_eq!(provinces_within_u128(top), 1 + 3 * top * (top + 1));
    }
}
