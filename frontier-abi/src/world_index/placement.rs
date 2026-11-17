//! Candidate mixed-nation first-home placement over wide coordinates
//! (experimental; see the module doc of [`super`]).
//!
//! The owner has decided that outer lands mix nations rather than form six
//! wedges. This module is the pure **candidate** rule for that decision,
//! built on the deployed `geometry::home_nation` dispersed rule
//! (`PLACEMENT_DISPERSED`) and extended from the heartland to every ring:
//!
//! * ring 0, the Concord: neutral (`None`), as under every placement;
//! * ring 1, the Six Seats: the wedge, so seat `k` stays nation `k`'s;
//! * ring `r ≥ 2`: the province's position `i` in ring order (`wedge · r +
//!   position in the wedge`, the walk round the ring that
//!   `geometry::ring_provinces` takes) plus the ring's offset `o_r`, mod 6.
//!   Each nation takes exactly `r` of the `6r` provinces, six positions
//!   apart; neighbours on the ring differ; every wedge holds `min(r, 6)`
//!   nations.
//!
//! The offset is the legacy one wherever the legacy one is defined, and a
//! versioned one past it ([`ring_offset_domain`]):
//!
//! * ring ≤ 65,535 ([`RingOffsetDomain::LegacyU16`]):
//!   `u64(sha256(PLACEMENT_DOMAIN ‖ seed ‖ le16(r))[..8]) mod 6`, bit for
//!   bit the offset of `geometry::home_nation`, so inside a season's
//!   heartland the candidate equals the deployed dispersed rule;
//! * ring > 65,535 ([`RingOffsetDomain::WideU64`]):
//!   `u64(sha256(MIXED_PLACEMENT_DOMAIN_WIDE ‖ seed ‖ le64(r))[..8]) mod 6`.
//!   The ring is never narrowed to `u16`.
//!
//! Ring and position arithmetic is `u128` (ring ≤ 2⁶³, position < ring).
//!
//! What this is **not**: not a Season parameter (no new `placement` value;
//! `PLACEMENT_WEDGE` and `PLACEMENT_DISPERSED` keep their meaning), not
//! wired into any legacy season, keep, heartland or ownership rule, and not
//! a relabelling of existing ownership: outside the heartland the deployed
//! rule stays the wedge, and this function is not called by it. The
//! texture is **evenly interleaved individual provinces** (no two ring
//! neighbours share a nation); clustered nation patches would be a
//! different rule and another owner decision. The `genesis_seed` is the
//! caller's; nothing here selects or derives a seed.

use super::coord::WideCoord;
use permutation_rules::frontier::geometry::{FACTIONS, PLACEMENT_DOMAIN};
use permutation_rules::hash::sha256;

/// Version of the candidate rule. Not a Season parameter, not a ruleset
/// hash input.
pub const MIXED_PLACEMENT_VERSION: u16 = 1;
/// Domain of the per-ring offset past the legacy `u16` ring domain.
pub const MIXED_PLACEMENT_DOMAIN_WIDE: &[u8] = b"PSF-PLACEMENT-WIDE-v1";
/// Largest ring whose offset is the legacy `PLACEMENT_DOMAIN ‖ le16(ring)`
/// one: the `u16` ring domain of `geometry::home_nation`.
pub const LEGACY_OFFSET_MAX_RING: u64 = u16::MAX as u64;

/// Which hash input gives a ring's offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RingOffsetDomain {
    /// `PLACEMENT_DOMAIN ‖ seed ‖ le16(ring)`: the deployed dispersed rule's.
    LegacyU16,
    /// `MIXED_PLACEMENT_DOMAIN_WIDE ‖ seed ‖ le64(ring)`.
    WideU64,
}

/// The offset domain of `ring`: legacy wherever the ring fits `u16`.
pub const fn ring_offset_domain(ring: u64) -> RingOffsetDomain {
    if ring <= LEGACY_OFFSET_MAX_RING {
        RingOffsetDomain::LegacyU16
    } else {
        RingOffsetDomain::WideU64
    }
}

/// The per-ring offset `o_r` in `0..6`. The domain is chosen by whether the
/// ring fits `u16` (an exact narrowing, never a truncation).
pub fn ring_offset(ring: u64, genesis_seed: &[u8; 32]) -> u8 {
    let h = match u16::try_from(ring) {
        Ok(r16) => sha256(&[PLACEMENT_DOMAIN, genesis_seed, &r16.to_le_bytes()]),
        Err(_) => sha256(&[
            MIXED_PLACEMENT_DOMAIN_WIDE,
            genesis_seed,
            &ring.to_le_bytes(),
        ]),
    };
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    (u64::from_le_bytes(b) % FACTIONS as u64) as u8
}

/// The nation whose first homes province `c` would take under the
/// candidate mixed rule: `None` for the Concord, the wedge on ring 1,
/// `(i + o_r) mod 6` on every ring `r ≥ 2` with `i` the position in ring
/// order. Pure; the same seed gives the same map.
pub fn mixed_home_nation(c: WideCoord, genesis_seed: &[u8; 32]) -> Option<u8> {
    let rp = c.ring_position();
    if rp.ring == 0 {
        return None;
    }
    if rp.ring == 1 {
        return Some(rp.wedge);
    }
    let i = rp.wedge as u128 * rp.ring as u128 + rp.pos as u128;
    let o = ring_offset(rp.ring, genesis_seed) as u128;
    Some(((i + o) % FACTIONS as u128) as u8)
}

/// Alternative candidate for new outer land only: each six-fold terrain
/// orbit gives exactly one rotated copy to each nation. This avoids the
/// cyclic rule's resource bias on rings sharing a factor with six.
///
/// Deliberately refuses the deployed disk: existing land must not be
/// relabelled. This is a comparison candidate, not an active Season rule.
pub fn orbit_balanced_outer_nation(c: WideCoord, genesis_seed: &[u8; 32]) -> Option<u8> {
    let rp = c.ring_position();
    if rp.ring <= 128 {
        return None;
    }
    let offset = ring_offset(rp.ring, genesis_seed) as u128;
    Some(((rp.wedge as u128 + rp.pos as u128 + offset) % FACTIONS as u128) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::RingPosition;
    use crate::world_index::legacy::wide_of;
    use alloc::vec::Vec;
    use permutation_rules::frontier::geometry::{
        home_nation, ring_provinces, seat_of, PLACEMENT_DISPERSED, PLACEMENT_WEDGE, R_MAX_HARD,
    };

    fn at(ring: u64, wedge: u8, pos: u64) -> WideCoord {
        WideCoord::from_ring_position(RingPosition { ring, wedge, pos }).unwrap()
    }

    /// The `6·ring` provinces of a ring in ring order (the legacy
    /// `ring_provinces` walk, valid past ring 128 too).
    fn ring_coords(ring: u64) -> Vec<WideCoord> {
        (0..6 * ring)
            .map(|i| at(ring, (i / ring) as u8, i % ring))
            .collect()
    }

    /// Inside every configurable heartland (rings 2..=hmr, hmr 2..=6) the
    /// candidate equals the deployed dispersed rule for 16 seeds, and up
    /// to the rim of the legacy disk it equals the same formula (the
    /// deployed function with the ring as its own heartland bound). The
    /// pinned heartland vector of `geometry` holds unchanged.
    #[test]
    fn inside_the_heartland_the_candidate_is_the_deployed_dispersed_rule() {
        for s in 0..16u8 {
            let seed = [s; 32];
            for hmr in 2..=6u8 {
                for d in 2..=hmr as u32 {
                    for p in ring_provinces(d) {
                        assert_eq!(
                            mixed_home_nation(wide_of(p), &seed),
                            home_nation(p, PLACEMENT_DISPERSED, hmr, &seed),
                            "seed {s} hmr {hmr} {p:?}"
                        );
                    }
                }
            }
            for d in [7u32, 17, 64, 127, 128] {
                for p in ring_provinces(d) {
                    assert_eq!(
                        mixed_home_nation(wide_of(p), &seed),
                        home_nation(p, PLACEMENT_DISPERSED, d as u8, &seed),
                        "seed {s} ring {d} {p:?}"
                    );
                }
            }
        }
        assert_eq!(R_MAX_HARD, 128);
        let seed = [1u8; 32];
        let got: Vec<u8> = ring_provinces(2)
            .into_iter()
            .chain(ring_provinces(3))
            .map(|p| mixed_home_nation(wide_of(p), &seed).unwrap())
            .collect();
        assert_eq!(
            got,
            [
                4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, // ring 2
                5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, // ring 3
            ]
        );
    }

    #[test]
    fn the_concord_is_neutral_and_the_six_seats_keep_their_wedges() {
        for s in 0..8u8 {
            let seed = [s; 32];
            assert_eq!(mixed_home_nation(WideCoord::CONCORD, &seed), None);
            for f in 0..6u8 {
                let seat = seat_of(f);
                assert_eq!(seat.ring(), 1);
                assert_eq!(mixed_home_nation(wide_of(seat), &seed), Some(f));
                assert_eq!(mixed_home_nation(wide_of(seat), &seed), seat.wedge());
                assert_eq!(home_nation(seat, PLACEMENT_WEDGE, 3, &seed), Some(f));
                assert_eq!(home_nation(seat, PLACEMENT_DISPERSED, 3, &seed), Some(f));
            }
        }
    }

    /// Rings 2–6, 17, 128, 129, 130 and 300: each nation takes exactly
    /// `ring` of the `6·ring` provinces; ring order is a walk (consecutive
    /// provinces, and the wrap, are neighbours) along which the nation
    /// changes at every step; every wedge holds `min(ring, 6) ≥ 2` nations.
    #[test]
    fn outer_rings_are_balanced_and_every_wedge_mixes_nations() {
        let seed = [0x77u8; 32];
        for ring in [2u64, 3, 4, 5, 6, 17, 128, 129, 130, 300] {
            let coords = ring_coords(ring);
            let n: Vec<u8> = coords
                .iter()
                .map(|c| mixed_home_nation(*c, &seed).unwrap())
                .collect();
            for f in 0..6u8 {
                assert_eq!(
                    n.iter().filter(|x| **x == f).count() as u64,
                    ring,
                    "ring {ring} nation {f}"
                );
            }
            for i in 0..n.len() {
                let j = (i + 1) % n.len();
                assert_ne!(n[i], n[j], "ring {ring} step {i}");
                assert_eq!(coords[i].distance(coords[j]), 1, "ring {ring} step {i}");
            }
            let r = ring as usize;
            for k in 0..6usize {
                let mut w: Vec<u8> = n[k * r..(k + 1) * r].to_vec();
                w.sort();
                w.dedup();
                assert_eq!(w.len() as u64, ring.min(6), "ring {ring} wedge {k}");
                assert!(w.len() >= 2, "ring {ring} wedge {k} is one nation's");
            }
        }
    }

    /// The same seed gives the same ring; the offset is the whole
    /// difference between seeds, and the seeds do differ.
    #[test]
    fn reproducible_and_the_seed_turns_the_ring() {
        let coords = ring_coords(4);
        let a: Vec<Option<u8>> = coords
            .iter()
            .map(|c| mixed_home_nation(*c, &[1; 32]))
            .collect();
        let b: Vec<Option<u8>> = coords
            .iter()
            .map(|c| mixed_home_nation(*c, &[1; 32]))
            .collect();
        assert_eq!(a, b);
        let mut offsets: Vec<u8> = (0u8..32).map(|s| ring_offset(4, &[s; 32])).collect();
        offsets.sort();
        offsets.dedup();
        assert!(offsets.len() >= 2, "32 seeds give one offset");
        for s in 0..32u8 {
            let seed = [s; 32];
            let o = ring_offset(4, &seed) as u64;
            for (i, c) in coords.iter().enumerate() {
                assert_eq!(
                    mixed_home_nation(*c, &seed),
                    Some(((i as u64 + o) % 6) as u8)
                );
            }
        }
    }

    /// Past the `u16` ring domain and past 2⁵³, up to ring 2⁶³ (the corner
    /// (2⁶², 2⁶²)): the offset is the legacy hash bit for bit where the
    /// ring fits `u16` and the wide-domain hash past it; the nation at
    /// sampled positions of every wedge is the formula in `u128`; the walk
    /// across a wedge boundary still changes nation; within one wedge any
    /// 60 consecutive provinces take each nation 10 times.
    #[test]
    fn rings_past_u16_and_past_2_53_use_the_wide_domain_without_overflow() {
        let seed = [0x5Au8; 32];
        assert_eq!(ring_offset_domain(2), RingOffsetDomain::LegacyU16);
        assert_eq!(ring_offset_domain(65_535), RingOffsetDomain::LegacyU16);
        assert_eq!(ring_offset_domain(65_536), RingOffsetDomain::WideU64);
        assert_eq!(ring_offset_domain(1 << 63), RingOffsetDomain::WideU64);
        assert_eq!(ring_offset_domain(u64::MAX), RingOffsetDomain::WideU64);
        let first8 = |h: [u8; 32]| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&h[..8]);
            (u64::from_le_bytes(b) % 6) as u8
        };
        for r in [2u16, 3, 128, 129, 1_000, 65_535] {
            let legacy = first8(sha256(&[PLACEMENT_DOMAIN, &seed, &r.to_le_bytes()]));
            assert_eq!(ring_offset(r as u64, &seed), legacy, "ring {r}");
        }
        for r in [65_536u64, 65_537, 1 << 20, (1 << 53) + 5, 1 << 62, 1 << 63] {
            let wide = first8(sha256(&[
                MIXED_PLACEMENT_DOMAIN_WIDE,
                &seed,
                &r.to_le_bytes(),
            ]));
            assert_eq!(ring_offset(r, &seed), wide, "ring {r}");
        }
        for ring in [65_535u64, 65_536, (1 << 53) + 5, 1 << 62, 1 << 63] {
            let o = ring_offset(ring, &seed) as u128;
            for wedge in 0..6u8 {
                for pos in [0u64, 1, 2, ring / 2, ring - 2, ring - 1] {
                    // ring 2⁶³ has positions past the bound (its wedge-0
                    // start is (2⁶³, 0)); those are refused, not wrapped
                    let Ok(c) = WideCoord::from_ring_position(RingPosition { ring, wedge, pos })
                    else {
                        assert_eq!(ring, 1 << 63);
                        continue;
                    };
                    let want = ((wedge as u128 * ring as u128 + pos as u128 + o) % 6) as u8;
                    assert_eq!(
                        mixed_home_nation(c, &seed),
                        Some(want),
                        "ring {ring} wedge {wedge} pos {pos}"
                    );
                }
                let last = WideCoord::from_ring_position(RingPosition {
                    ring,
                    wedge,
                    pos: ring - 1,
                });
                let next = WideCoord::from_ring_position(RingPosition {
                    ring,
                    wedge: (wedge + 1) % 6,
                    pos: 0,
                });
                if let (Ok(a), Ok(b)) = (last, next) {
                    assert_eq!(a.distance(b), 1);
                    assert_ne!(mixed_home_nation(a, &seed), mixed_home_nation(b, &seed));
                }
            }
        }
        let corner = WideCoord::checked(1 << 62, 1 << 62).unwrap();
        assert_eq!(corner.ring(), 1 << 63);
        assert!(mixed_home_nation(corner, &seed).is_some());
        let ring = (1u64 << 53) + 5;
        let n: Vec<u8> = (0..60u64)
            .map(|pos| mixed_home_nation(at(ring, 2, pos), &seed).unwrap())
            .collect();
        for f in 0..6u8 {
            assert_eq!(n.iter().filter(|x| **x == f).count(), 10);
        }
    }

    /// Pinned constants; and the deployed rule outside the heartland is
    /// still the wedge while the candidate is not, so nothing deployed has
    /// been relabelled.
    #[test]
    fn candidate_constants_are_pinned_and_the_deployed_rule_is_untouched() {
        assert_eq!(MIXED_PLACEMENT_VERSION, 1);
        assert_eq!(FACTIONS, 6);
        assert_eq!(PLACEMENT_DOMAIN, b"PSF-PLACEMENT-v1");
        assert_eq!(MIXED_PLACEMENT_DOMAIN_WIDE, b"PSF-PLACEMENT-WIDE-v1");
        assert_eq!(LEGACY_OFFSET_MAX_RING, 65_535);
        assert_eq!(PLACEMENT_WEDGE, 0);
        assert_eq!(PLACEMENT_DISPERSED, 1);
        let seed = [1u8; 32];
        let mut differs = 0;
        for p in ring_provinces(7) {
            assert_eq!(home_nation(p, PLACEMENT_DISPERSED, 3, &seed), p.wedge());
            assert_eq!(home_nation(p, PLACEMENT_WEDGE, 6, &seed), p.wedge());
            if mixed_home_nation(wide_of(p), &seed) != p.wedge() {
                differs += 1;
            }
        }
        // Ring 7, wedge k, position j: nation (7k + j + o) ≡ (k + j + o) mod 6
        // equals the wedge k iff (j + o) ≡ 0 mod 6, so 1 or 2 of the 7
        // provinces of every wedge keep their wedge's nation and 30 or 36
        // of 42 do not.
        let o = ring_offset(7, &seed) as usize;
        let same_per_wedge = (0..7usize).filter(|j| (j + o) % 6 == 0).count();
        assert!((1..=2).contains(&same_per_wedge));
        assert_eq!(differs, 42 - 6 * same_per_wedge);
    }
    #[test]
    fn orbit_candidate_gives_each_nation_every_canonical_terrain_once() {
        let seed = [0x39; 32];
        for ring in [129, 130, 132, 300, 65_536, (1u64 << 53) + 6] {
            for pos in [0, 1, 5, ring / 2, ring - 1] {
                let mut nations = [0; 6];
                for wedge in 0..6 {
                    let f = orbit_balanced_outer_nation(at(ring, wedge, pos), &seed).unwrap();
                    nations[f as usize] += 1;
                }
                assert_eq!(nations, [1; 6], "ring {ring}, canonical position {pos}");
            }
        }
        for ring in [129, 130, 132, 300] {
            let mut counts = [0u64; 6];
            for wedge in 0..6 {
                let mut represented = [false; 6];
                for pos in 0..ring {
                    let f = orbit_balanced_outer_nation(at(ring, wedge, pos), &seed).unwrap();
                    counts[f as usize] += 1;
                    represented[f as usize] = true;
                }
                assert_eq!(represented, [true; 6]);
            }
            assert_eq!(counts, [ring; 6]);
        }
        for p in ring_provinces(128) {
            assert_eq!(orbit_balanced_outer_nation(wide_of(p), &seed), None);
        }
        assert_eq!(orbit_balanced_outer_nation(WideCoord::CONCORD, &seed), None);
    }
}
