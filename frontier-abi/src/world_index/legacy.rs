//! Lossless read adapter between the legacy identifiers (`ProvinceCoord`,
//! the dense index, the `u64` host id) and the wide, world-scoped ones
//! (experimental; see the module doc of [`super`]).
//!
//! Every conversion here is exact or refused:
//!
//! * any legacy `ProvinceCoord` (an `i32` pair) widens to a [`WideCoord`]
//!   and narrows back to the same pair;
//! * a wide coordinate narrows to a legacy pair only if both fields fit
//!   `i32` ([`LegacyError::BeyondI32`]);
//! * a dense index or a `u64` host id exists only within ring 128
//!   ([`LegacyError::BeyondLegacyDisk`]): past it the adapter refuses, it
//!   never truncates a wide ordinal into the 20-bit field, so no wide
//!   province can alias a legacy one;
//! * a `u64` that no holding can issue (`addr::split_host_id` gives
//!   `None`) is [`LegacyError::InvalidHostId`];
//! * every key and reference is checked against the adapter's world
//!   ([`LegacyError::WorldMismatch`]), because a `u64` host id carries no
//!   world and is meaningful only in the season it was issued in.
//!
//! The adapter reads identifiers. It does not change what a host id means,
//! does not prove that a province, holding or host exists, and does not
//! touch any account.

use super::coord::WideCoord;
use super::key::{KeyError, ProvinceKey, WideHostRef, WorldId};
use crate::addr::{self, AddrCtx};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};

/// A conversion the adapter refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyError {
    WorldMismatch {
        expected: WorldId,
        got: WorldId,
    },
    /// A wide coordinate with a field outside `i32`.
    BeyondI32,
    /// A province outside ring 128: it has no dense index and no host id.
    BeyondLegacyDisk {
        ring: u64,
    },
    /// A `u64` no valid holding issues (`HOST_ID_INVALID`, site ≥ 12 or a
    /// province field at or beyond 49,537).
    InvalidHostId(u64),
}

/// Exact widening of a legacy coordinate (never fails: |i32| ≪ 2⁶²).
pub const fn wide_of(c: ProvinceCoord) -> WideCoord {
    WideCoord::from_i32(c.p, c.q)
}

/// Exact narrowing to a legacy coordinate, if both fields fit `i32`.
pub fn legacy_of(w: WideCoord) -> Result<ProvinceCoord, LegacyError> {
    let p = i32::try_from(w.p()).map_err(|_| LegacyError::BeyondI32)?;
    let q = i32::try_from(w.q()).map_err(|_| LegacyError::BeyondI32)?;
    Ok(ProvinceCoord::new(p, q))
}

/// The legacy identifiers of one world (one legacy season's disk).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyAdapter {
    world: WorldId,
}

impl LegacyAdapter {
    pub const fn new(world: WorldId) -> LegacyAdapter {
        LegacyAdapter { world }
    }

    /// The adapter of a legacy season, with
    /// [`WorldId::derive_legacy_season`] of its public address context.
    pub fn for_season(ctx: &AddrCtx) -> Result<LegacyAdapter, KeyError> {
        Ok(LegacyAdapter {
            world: WorldId::derive_legacy_season(&ctx.season, &ctx.program)?,
        })
    }

    pub const fn world(&self) -> WorldId {
        self.world
    }

    fn check_world(&self, got: WorldId) -> Result<(), LegacyError> {
        if got == self.world {
            Ok(())
        } else {
            Err(LegacyError::WorldMismatch {
                expected: self.world,
                got,
            })
        }
    }

    /// The key of a legacy coordinate in this world (exact for any pair).
    pub fn key_of(&self, c: ProvinceCoord) -> ProvinceKey {
        ProvinceKey::new(self.world, wide_of(c))
    }

    /// The legacy coordinate of a key of this world.
    pub fn coord_of(&self, key: &ProvinceKey) -> Result<ProvinceCoord, LegacyError> {
        self.check_world(key.world())?;
        legacy_of(key.coord())
    }

    /// The legacy dense index (`ProvinceCoord::index`) of a key of this
    /// world within ring 128.
    pub fn dense_index_of(&self, key: &ProvinceKey) -> Result<u32, LegacyError> {
        let c = self.coord_of(key)?;
        let ring = key.coord().ring();
        if ring > R_MAX_HARD as u64 {
            return Err(LegacyError::BeyondLegacyDisk { ring });
        }
        c.checked_index()
            .ok_or(LegacyError::BeyondLegacyDisk { ring })
    }

    /// The wide reference of a legacy host id of this world.
    pub fn host_ref(&self, host_id: u64) -> Result<WideHostRef, LegacyError> {
        let Some(h) = addr::split_host_id(host_id) else {
            return Err(LegacyError::InvalidHostId(host_id));
        };
        WideHostRef::new(self.key_of(h.province), h.site, h.gen, h.seq)
            .map_err(|_| LegacyError::InvalidHostId(host_id))
    }

    /// The legacy host id of a wide reference of this world within ring
    /// 128; refused past it (no truncation into the 20-bit field).
    pub fn host_id(&self, r: &WideHostRef) -> Result<u64, LegacyError> {
        let c = self.coord_of(&r.key())?;
        let ring = r.key().coord().ring();
        if ring > R_MAX_HARD as u64 {
            return Err(LegacyError::BeyondLegacyDisk { ring });
        }
        addr::host_id(c.p, c.q, r.site(), r.gen(), r.seq())
            .ok_or(LegacyError::BeyondLegacyDisk { ring })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WIDE_BOUND;
    use permutation_rules::frontier::addr::HOST_ID_INVALID;
    use permutation_rules::frontier::geometry::{provinces_within, ring_provinces};

    fn adapter(b: u8) -> LegacyAdapter {
        LegacyAdapter::new(WorldId::new([b; 32]).unwrap())
    }

    #[test]
    fn every_legacy_province_round_trips_with_its_dense_index() {
        let a = adapter(1);
        let n = provinces_within(R_MAX_HARD as u32);
        let mut prev: Option<ProvinceKey> = None;
        for i in 0..n {
            let c = ProvinceCoord::from_index(i);
            let k = a.key_of(c);
            assert_eq!(a.coord_of(&k), Ok(c));
            assert_eq!(a.dense_index_of(&k), Ok(i));
            assert_eq!(k.coord().ordinal(), i as u128);
            if let Some(p) = prev {
                assert!(p < k, "dense order is key order at {i}");
            }
            prev = Some(k);
        }
    }

    #[test]
    fn host_ids_round_trip_for_every_site_and_refuse_invalid_ones() {
        let a = adapter(1);
        let coords = [
            ProvinceCoord::new(0, 0),
            ProvinceCoord::new(1, 0),
            ProvinceCoord::new(-5, 3),
            ProvinceCoord::new(128, 0),
            ProvinceCoord::new(-128, 128),
            ProvinceCoord::new(0, -128),
            ProvinceCoord::new(64, -128),
        ];
        for c in coords {
            for site in 0..12u8 {
                for (gen, seq) in [(0u8, 0u32), (255, u32::MAX), (7, 12_345)] {
                    let id = addr::host_id(c.p, c.q, site, gen, seq).unwrap();
                    let r = a.host_ref(id).unwrap();
                    assert_eq!(r.key(), a.key_of(c));
                    assert_eq!((r.site(), r.gen(), r.seq()), (site, gen, seq));
                    assert_eq!(a.host_id(&r), Ok(id));
                    assert_eq!(
                        a.host_id(&r.holding_ref()),
                        Ok(addr::holding_key_of_host(id))
                    );
                }
            }
        }
        // what no holding issues
        assert_eq!(
            a.host_ref(HOST_ID_INVALID),
            Err(LegacyError::InvalidHostId(HOST_ID_INVALID))
        );
        let site12 = 12u64 << 40;
        assert_eq!(a.host_ref(site12), Err(LegacyError::InvalidHostId(site12)));
        let beyond = (provinces_within(128) as u64) << 44;
        assert_eq!(a.host_ref(beyond), Err(LegacyError::InvalidHostId(beyond)));
        let top20 = ((1u64 << 20) - 1) << 44;
        assert_eq!(a.host_ref(top20), Err(LegacyError::InvalidHostId(top20)));
    }

    #[test]
    fn past_ring_128_there_is_no_dense_index_and_no_host_id() {
        let a = adapter(1);
        let far = [
            (129, 0),
            (0, -129),
            (-65, -64),
            (591, 0),
            (592, 0),
            (i32::MAX, 0),
            (i32::MIN, i32::MAX),
        ];
        for (p, q) in far {
            let c = ProvinceCoord::new(p, q);
            let k = a.key_of(c);
            let ring = k.coord().ring();
            assert!(ring > 128);
            assert_eq!(a.coord_of(&k), Ok(c), "the coordinate itself is exact");
            assert_eq!(
                a.dense_index_of(&k),
                Err(LegacyError::BeyondLegacyDisk { ring })
            );
            let r = WideHostRef::new(k, 3, 1, 1).unwrap();
            assert_eq!(a.host_id(&r), Err(LegacyError::BeyondLegacyDisk { ring }));
            assert_eq!(addr::host_id(p, q, 3, 1, 1), None, "legacy codec agrees");
        }
        // No aliasing: a wide key past the disk never equals a legacy key
        // (ring is the first key field), and a reference past the 20-bit
        // field never produces any u64.
        let far = ProvinceKey::new(a.world(), WideCoord::checked(1 << 40, 0).unwrap());
        for i in [0u32, 1, 49_536] {
            assert_ne!(far, a.key_of(ProvinceCoord::from_index(i)));
        }
        assert_eq!(
            a.host_id(&WideHostRef::new(far, 0, 0, 0).unwrap()),
            Err(LegacyError::BeyondI32)
        );
    }

    #[test]
    fn wide_coordinates_outside_i32_are_refused_exactly() {
        let a = adapter(1);
        let (p, q) = (i32::MAX as i64, i32::MIN as i64);
        let edge = WideCoord::checked(p, q).unwrap();
        assert_eq!(legacy_of(edge), Ok(ProvinceCoord::new(i32::MAX, i32::MIN)));
        assert_eq!(wide_of(ProvinceCoord::new(i32::MAX, i32::MIN)), edge);
        for w in [
            WideCoord::checked(i32::MAX as i64 + 1, 0).unwrap(),
            WideCoord::checked(0, i32::MIN as i64 - 1).unwrap(),
            WideCoord::checked(WIDE_BOUND, WIDE_BOUND).unwrap(),
        ] {
            assert_eq!(legacy_of(w), Err(LegacyError::BeyondI32));
            let k = ProvinceKey::new(a.world(), w);
            assert_eq!(a.coord_of(&k), Err(LegacyError::BeyondI32));
            assert_eq!(a.dense_index_of(&k), Err(LegacyError::BeyondI32));
            let r = WideHostRef::new(k, 0, 0, 0).unwrap();
            assert_eq!(a.host_id(&r), Err(LegacyError::BeyondI32));
        }
        // every legacy coordinate of the small rings widens and narrows exactly
        for d in 0..6 {
            for c in ring_provinces(d) {
                assert_eq!(legacy_of(wide_of(c)), Ok(c));
            }
        }
    }

    #[test]
    fn cross_world_keys_and_references_are_refused() {
        let (a, b) = (adapter(1), adapter(2));
        let c = ProvinceCoord::new(3, -1);
        let ka = a.key_of(c);
        let kb = b.key_of(c);
        assert_ne!(ka, kb);
        let mismatch = Err(LegacyError::WorldMismatch {
            expected: b.world(),
            got: a.world(),
        });
        assert_eq!(b.coord_of(&ka), mismatch);
        assert_eq!(b.dense_index_of(&ka).err(), mismatch.err());
        let id = addr::host_id(3, -1, 2, 0, 1).unwrap();
        let ra = a.host_ref(id).unwrap();
        assert_eq!(b.host_id(&ra).err(), mismatch.err());
        assert_eq!(a.host_id(&ra), Ok(id));
        assert_eq!(b.host_id(&b.host_ref(id).unwrap()), Ok(id));
    }

    #[test]
    fn the_season_adapter_is_a_pure_function_of_public_addresses() {
        let ctx = AddrCtx {
            season: [7; 32],
            program: [9; 32],
        };
        let a = LegacyAdapter::for_season(&ctx).unwrap();
        assert_eq!(
            a.world(),
            WorldId::derive_legacy_season(&[7; 32], &[9; 32]).unwrap()
        );
        let other = AddrCtx {
            season: [8; 32],
            program: [9; 32],
        };
        assert_ne!(a, LegacyAdapter::for_season(&other).unwrap());
    }
}
