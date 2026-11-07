//! World namespaces, world-scoped province keys and versioned host
//! references (experimental; see the module doc of [`super`]).
//!
//! * A [`WorldId`] is an immutable 32-byte namespace. The module never
//!   invents one: a caller supplies it, or derives the namespace of a
//!   legacy season from its public Season PDA and program id
//!   ([`WorldId::derive_legacy_season`], a plain sha256 of public bytes).
//!   The all-zero id is reserved and refused everywhere, so a zeroed
//!   buffer can never pass for a world.
//! * A [`ProvinceKey`] is `(world, coordinate)`; its 50-byte canonical form
//!   is `version ‖ world ‖ sort key`, lossless both ways, and byte order
//!   equals the type's order (world, then ring order).
//! * A [`WideHostRef`] is a **new, versioned** reference to a host:
//!   `(province key, site, gen, seq)`, 56 bytes. It is not a `u64` and it
//!   does not reinterpret one: the legacy `host_id` keeps its meaning for
//!   the current ABI, and `super::legacy` converts between the two only
//!   where that is lossless.
//!
//! Nothing here is an account address, a record key of a deployed layout,
//! or an input of any ruleset hash.

use super::coord::{CoordError, WideCoord, SORT_KEY_LEN};
use permutation_rules::frontier::geometry::SITES_PER_PROVINCE;
use permutation_rules::hash::sha256;

/// Bytes of a world namespace.
pub const WORLD_ID_LEN: usize = 32;
/// Domain of [`WorldId::derive_legacy_season`].
pub const WORLD_DOMAIN_LEGACY_SEASON: &[u8] = b"PSF-WORLD-v1/legacy-season";
/// Layout version of the province key bytes.
pub const PROVINCE_KEY_VERSION: u8 = 1;
/// Bytes of a province key: version, world, sort key.
pub const PROVINCE_KEY_LEN: usize = 1 + WORLD_ID_LEN + SORT_KEY_LEN;
/// Layout version of the host reference bytes.
pub const HOST_REF_VERSION: u8 = 1;
/// Bytes of a host reference: version, world, sort key, site, gen, seq.
pub const HOST_REF_LEN: usize = 1 + WORLD_ID_LEN + SORT_KEY_LEN + 1 + 1 + 4;

/// A key or reference the module refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The all-zero world id.
    ReservedWorld,
    Length {
        expected: usize,
        got: usize,
    },
    Version {
        expected: u8,
        got: u8,
    },
    Coord(CoordError),
    /// A site at or above 12.
    Site(u8),
}

impl From<CoordError> for KeyError {
    fn from(e: CoordError) -> Self {
        KeyError::Coord(e)
    }
}

/// An immutable world namespace.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WorldId([u8; WORLD_ID_LEN]);

impl core::fmt::Debug for WorldId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "WorldId(")?;
        for b in &self.0[..4] {
            write!(f, "{b:02x}")?;
        }
        write!(f, "…)")
    }
}

impl WorldId {
    /// The reserved id no world may have.
    pub const RESERVED: [u8; WORLD_ID_LEN] = [0; WORLD_ID_LEN];

    /// A caller-supplied namespace; refuses [`WorldId::RESERVED`].
    pub fn new(bytes: [u8; WORLD_ID_LEN]) -> Result<WorldId, KeyError> {
        if bytes == Self::RESERVED {
            Err(KeyError::ReservedWorld)
        } else {
            Ok(WorldId(bytes))
        }
    }

    /// The namespace of a legacy season's one disk:
    /// `sha256(WORLD_DOMAIN_LEGACY_SEASON ‖ season_pda ‖ program)`. Public
    /// inputs only; no key is derived or needed. (The digest is nonzero
    /// with overwhelming probability; the reserved check still runs, and
    /// the impossible zero digest is reported, not patched.)
    pub fn derive_legacy_season(
        season_pda: &[u8; 32],
        program: &[u8; 32],
    ) -> Result<WorldId, KeyError> {
        WorldId::new(sha256(&[WORLD_DOMAIN_LEGACY_SEASON, season_pda, program]))
    }

    pub const fn as_bytes(&self) -> &[u8; WORLD_ID_LEN] {
        &self.0
    }
}

/// A province of one world.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProvinceKey {
    world: WorldId,
    coord: WideCoord,
}

impl ProvinceKey {
    pub const fn new(world: WorldId, coord: WideCoord) -> ProvinceKey {
        ProvinceKey { world, coord }
    }

    pub const fn world(&self) -> WorldId {
        self.world
    }

    pub const fn coord(&self) -> WideCoord {
        self.coord
    }

    /// `PROVINCE_KEY_VERSION ‖ world ‖ sort key`.
    pub fn to_bytes(&self) -> [u8; PROVINCE_KEY_LEN] {
        let mut out = [0u8; PROVINCE_KEY_LEN];
        out[0] = PROVINCE_KEY_VERSION;
        out[1..1 + WORLD_ID_LEN].copy_from_slice(&self.world.0);
        out[1 + WORLD_ID_LEN..].copy_from_slice(&self.coord.sort_key());
        out
    }

    /// Inverse of [`ProvinceKey::to_bytes`]: exact length, this version,
    /// a non-reserved world and a canonical sort key, else an error.
    pub fn from_bytes(bytes: &[u8]) -> Result<ProvinceKey, KeyError> {
        if bytes.len() != PROVINCE_KEY_LEN {
            return Err(KeyError::Length {
                expected: PROVINCE_KEY_LEN,
                got: bytes.len(),
            });
        }
        if bytes[0] != PROVINCE_KEY_VERSION {
            return Err(KeyError::Version {
                expected: PROVINCE_KEY_VERSION,
                got: bytes[0],
            });
        }
        let mut w = [0u8; WORLD_ID_LEN];
        w.copy_from_slice(&bytes[1..1 + WORLD_ID_LEN]);
        let mut k = [0u8; SORT_KEY_LEN];
        k.copy_from_slice(&bytes[1 + WORLD_ID_LEN..]);
        Ok(ProvinceKey {
            world: WorldId::new(w)?,
            coord: WideCoord::from_sort_key(&k)?,
        })
    }
}

/// A versioned reference to a host of a province of a world: the four
/// legacy host-id fields with the province named by key instead of by
/// dense index. The legacy `u64` is neither embedded nor implied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WideHostRef {
    key: ProvinceKey,
    site: u8,
    gen: u8,
    seq: u32,
}

impl WideHostRef {
    /// `site` must be below 12 (`SITES_PER_PROVINCE`), as for a host id.
    pub const fn new(
        key: ProvinceKey,
        site: u8,
        gen: u8,
        seq: u32,
    ) -> Result<WideHostRef, KeyError> {
        if site as usize >= SITES_PER_PROVINCE {
            return Err(KeyError::Site(site));
        }
        Ok(WideHostRef {
            key,
            site,
            gen,
            seq,
        })
    }

    pub const fn key(&self) -> ProvinceKey {
        self.key
    }
    pub const fn site(&self) -> u8 {
        self.site
    }
    pub const fn gen(&self) -> u8 {
        self.gen
    }
    pub const fn seq(&self) -> u32 {
        self.seq
    }

    /// The reference of the holding (and site generation) that issued this
    /// host: the same with `seq` cleared, as `addr::holding_key_of_host`.
    pub const fn holding_ref(&self) -> WideHostRef {
        WideHostRef {
            key: self.key,
            site: self.site,
            gen: self.gen,
            seq: 0,
        }
    }

    /// `HOST_REF_VERSION ‖ world ‖ sort key ‖ site ‖ gen ‖ seq (LE)`.
    pub fn to_bytes(&self) -> [u8; HOST_REF_LEN] {
        let mut out = [0u8; HOST_REF_LEN];
        out[0] = HOST_REF_VERSION;
        out[1..1 + WORLD_ID_LEN].copy_from_slice(&self.key.world.0);
        let s = 1 + WORLD_ID_LEN;
        out[s..s + SORT_KEY_LEN].copy_from_slice(&self.key.coord.sort_key());
        let s = s + SORT_KEY_LEN;
        out[s] = self.site;
        out[s + 1] = self.gen;
        out[s + 2..].copy_from_slice(&self.seq.to_le_bytes());
        out
    }

    /// Inverse of [`WideHostRef::to_bytes`] with the same refusals as
    /// [`ProvinceKey::from_bytes`], plus the site bound.
    pub fn from_bytes(bytes: &[u8]) -> Result<WideHostRef, KeyError> {
        if bytes.len() != HOST_REF_LEN {
            return Err(KeyError::Length {
                expected: HOST_REF_LEN,
                got: bytes.len(),
            });
        }
        if bytes[0] != HOST_REF_VERSION {
            return Err(KeyError::Version {
                expected: HOST_REF_VERSION,
                got: bytes[0],
            });
        }
        let mut w = [0u8; WORLD_ID_LEN];
        w.copy_from_slice(&bytes[1..1 + WORLD_ID_LEN]);
        let s = 1 + WORLD_ID_LEN;
        let mut k = [0u8; SORT_KEY_LEN];
        k.copy_from_slice(&bytes[s..s + SORT_KEY_LEN]);
        let s = s + SORT_KEY_LEN;
        let mut seq = [0u8; 4];
        seq.copy_from_slice(&bytes[s + 2..]);
        let key = ProvinceKey {
            world: WorldId::new(w)?,
            coord: WideCoord::from_sort_key(&k)?,
        };
        WideHostRef::new(key, bytes[s], bytes[s + 1], u32::from_le_bytes(seq))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WIDE_BOUND;
    use std::vec::Vec;

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    #[test]
    fn the_zero_world_is_reserved_and_derivation_is_deterministic() {
        assert_eq!(WorldId::new([0; 32]), Err(KeyError::ReservedWorld));
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(WorldId::new(one).is_ok());
        let a = WorldId::derive_legacy_season(&[1; 32], &[2; 32]).unwrap();
        let b = WorldId::derive_legacy_season(&[1; 32], &[2; 32]).unwrap();
        assert_eq!(a, b);
        let other_program = WorldId::derive_legacy_season(&[1; 32], &[3; 32]).unwrap();
        let other_season = WorldId::derive_legacy_season(&[2; 32], &[2; 32]).unwrap();
        assert_ne!(a, other_program);
        assert_ne!(a, other_season);
        assert_ne!(*a.as_bytes(), WorldId::RESERVED);
        // the domain is bound: the plain hash of the inputs is another value
        assert_ne!(*a.as_bytes(), sha256(&[&[1u8; 32], &[2u8; 32]]));
        assert_eq!(
            *a.as_bytes(),
            sha256(&[WORLD_DOMAIN_LEGACY_SEASON, &[1u8; 32], &[2u8; 32]])
        );
        assert_eq!(std::format!("{:?}", world(0xab)), "WorldId(abababab…)");
    }

    #[test]
    fn province_keys_round_trip_and_refuse_bad_bytes() {
        let coords = [
            c(0, 0),
            c(1, 0),
            c(-3, 7),
            c(128, 0),
            c(129, 0),
            c(-(1 << 40), 1 << 40),
            c(WIDE_BOUND, WIDE_BOUND),
            c(-WIDE_BOUND, -WIDE_BOUND),
        ];
        for w in [world(1), world(2)] {
            for co in coords {
                let k = ProvinceKey::new(w, co);
                let b = k.to_bytes();
                assert_eq!(b.len(), 50);
                assert_eq!(ProvinceKey::from_bytes(&b), Ok(k));
                assert_eq!(k.world(), w);
                assert_eq!(k.coord(), co);
            }
        }
        let k = ProvinceKey::new(world(1), c(2, -1));
        let b = k.to_bytes();
        assert_eq!(
            ProvinceKey::from_bytes(&b[..49]),
            Err(KeyError::Length {
                expected: 50,
                got: 49,
            })
        );
        let mut long = b.to_vec();
        long.push(0);
        assert_eq!(
            ProvinceKey::from_bytes(&long),
            Err(KeyError::Length {
                expected: 50,
                got: 51,
            })
        );
        let mut v = b;
        v[0] = 2;
        assert_eq!(
            ProvinceKey::from_bytes(&v),
            Err(KeyError::Version {
                expected: 1,
                got: 2,
            })
        );
        let mut z = b;
        z[1..33].fill(0);
        assert_eq!(ProvinceKey::from_bytes(&z), Err(KeyError::ReservedWorld));
        let mut nc = b;
        nc[33 + 8] = 7; // wedge 7
        assert_eq!(
            ProvinceKey::from_bytes(&nc),
            Err(KeyError::Coord(CoordError::NonCanonical))
        );
        let mut oob = b;
        oob[33..41].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(
            ProvinceKey::from_bytes(&oob),
            Err(KeyError::Coord(CoordError::OutOfBounds))
        );
    }

    #[test]
    fn key_order_is_world_then_ring_order_and_equals_byte_order() {
        let coords = [
            c(0, 0),
            c(3, -3),
            c(-1, 0),
            c(1 << 50, 0),
            c(2, 0),
            c(0, -2),
        ];
        let mut keys: Vec<ProvinceKey> = Vec::new();
        for w in [world(9), world(1), world(5)] {
            for co in coords {
                keys.push(ProvinceKey::new(w, co));
            }
        }
        let mut by_ord = keys.clone();
        by_ord.sort();
        let mut by_bytes = keys;
        by_bytes.sort_by_key(|k| k.to_bytes());
        assert_eq!(by_ord, by_bytes);
        assert!(by_ord.windows(2).all(|w| w[0] < w[1]));
        // world is the major key: every key of world 1 precedes world 5
        let first_w5 = by_ord.iter().position(|k| k.world() == world(5)).unwrap();
        assert!(by_ord[..first_w5].iter().all(|k| k.world() == world(1)));
        // same coordinate, different worlds: different keys
        assert_ne!(
            ProvinceKey::new(world(1), c(4, 4)),
            ProvinceKey::new(world(2), c(4, 4))
        );
        assert_ne!(
            ProvinceKey::new(world(1), c(4, 4)).to_bytes(),
            ProvinceKey::new(world(2), c(4, 4)).to_bytes()
        );
    }

    #[test]
    fn host_refs_round_trip_and_bound_the_site() {
        let k = ProvinceKey::new(world(3), c(-129, 300));
        for (site, gen, seq) in [(0u8, 0u8, 0u32), (11, 255, u32::MAX), (5, 7, 12_345)] {
            let h = WideHostRef::new(k, site, gen, seq).unwrap();
            let b = h.to_bytes();
            assert_eq!(b.len(), 56);
            assert_eq!(WideHostRef::from_bytes(&b), Ok(h));
            assert_eq!(h.key(), k);
            assert_eq!((h.site(), h.gen(), h.seq()), (site, gen, seq));
            assert_eq!(h.holding_ref(), WideHostRef::new(k, site, gen, 0).unwrap());
            assert_eq!(h.holding_ref().holding_ref(), h.holding_ref());
        }
        assert_eq!(WideHostRef::new(k, 12, 0, 0), Err(KeyError::Site(12)));
        assert_eq!(WideHostRef::new(k, 255, 0, 0), Err(KeyError::Site(255)));
        let mut b = WideHostRef::new(k, 1, 2, 3).unwrap().to_bytes();
        b[50] = 12;
        assert_eq!(WideHostRef::from_bytes(&b), Err(KeyError::Site(12)));
        let b = WideHostRef::new(k, 1, 2, 3).unwrap().to_bytes();
        assert_eq!(
            WideHostRef::from_bytes(&b[..55]),
            Err(KeyError::Length {
                expected: 56,
                got: 55,
            })
        );
        let mut v = b;
        v[0] = 0;
        assert_eq!(
            WideHostRef::from_bytes(&v),
            Err(KeyError::Version {
                expected: 1,
                got: 0,
            })
        );
        let mut z = b;
        z[1..33].fill(0);
        assert_eq!(WideHostRef::from_bytes(&z), Err(KeyError::ReservedWorld));
        // the reference orders by key, then site, gen, seq
        let a = WideHostRef::new(k, 1, 0, 9).unwrap();
        let b2 = WideHostRef::new(k, 2, 0, 0).unwrap();
        assert!(a < b2);
        let concord = ProvinceKey::new(world(3), c(0, 0));
        let other = WideHostRef::new(concord, 11, 255, u32::MAX).unwrap();
        assert!(other < a, "ring 0 precedes ring 300 whatever the site");
    }
}
