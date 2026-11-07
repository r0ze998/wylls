//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! versioned identity, provenance and readiness models of **wide land**
//! (provinces past ring 128) for the actual game, and nothing of its
//! economy or nation texture.
//!
//! Status: a draft of 2026-11-07. Every number a deployed reader would have
//! to know (magics, seed tags, the family and layout versions) is
//! **provisional until the integrator (workstream 4) allocates it**; the
//! program reaches these records only behind its own
//! `wide-world-experimental` feature, and no default build, vector, hash
//! input or deployed layout mentions them.
//!
//! | record | bytes | identity | what it is |
//! |---|---|---|---|
//! | [`WideRingSeed`] | 192, short header | world, ring (`u64`) | the beacon round fixed at the request; the seed once a quicknet signature of that round was verified; a count of provinces opened from it |
//! | [`WideProvince`] | 4,864 = the **whole Province v2 layout** (4,736, every v1 and v2 offset identical: terrain, site mirror, roster, cohorts, camp, caravans, structures, conquest block) + a 128-byte wide trailer | world, exact coordinate (the canonical 17-byte sort key) | a **playable province**, not a terrain record: every pure model the program runs over Province bytes (`clash_model`, `conquest_model`, `rest_model`, `encode_terrain`, `terrain_digest`, the mirror and roster codecs) applies to its prefix unchanged. Its prefix `P`, `Q` and `RING` are **always zero**; the trailer is the only identity, so no reader can mistake it for legacy land |
//!
//! **Readiness, not fabrication.** Opening a wide province writes what
//! `OpenProvince` writes: terrain and sites (the kernel's wide terrain over
//! the ring seed), the keep (tile by the kernel, **holder by the nation
//! rule**), the genesis Free City (**a wide rule**: the deployed one hashes
//! `LE32(P) ‖ LE32(Q)`), the initial camp (**a wide rule**, same reason)
//! and the region (**a wide rule**, same reason). The owner has decided
//! that outer nations mix but not the texture, and none of the three wide
//! hash rules exists; so [`WideRules`] carries each as a [`Decision`], and
//! [`WideProvince::open`] refuses [`LandError::NotReady`] naming the
//! undecided ones. The program passes [`WideRules::UNDECIDED`] today and
//! therefore cannot open wide land; the day the rules are decided and
//! allocated, only that input changes. A record whose readiness mask is
//! not complete is refused by [`WideProvince::read`], so a half-opened
//! province can never exist.
//!
//! **Seed provenance.** A wide ring is never a genesis ring: there is no
//! path from the genesis seed to a wide ring seed. [`WideRingSeed::request`]
//! fixes the round with the kernel's own `beacon::ring_seed_round` at the
//! request, exactly as `OpenRing` does for a ring beyond `g`, and
//! [`WideRingSeed::seed_with`] accepts a seed only for that round and only
//! once. The seed bytes are the program's `quick::seed_of(round, sig96)`
//! after `quick::verify`; this module binds the record to the round, the
//! program binds the round to the signature.
//!
//! **Chain.** Ring 129's request needs the legacy RingSeed of ring 128
//! seeded; ring `d ≥ 130`'s needs the wide ring seed of `d − 1` seeded;
//! and a bell must have passed since the previous ring opened: the
//! deployed OpenRing rules continued, stated as data ([`PreviousRing`]) so
//! the program authenticates the previous account and the model decides.
//!
//! Ownership of wide sites is `super::holding`; marches are `super::march`.

use super::coord::{CoordError, WideCoord, SORT_KEY_LEN};
use super::key::{KeyError, WorldId, WORLD_ID_LEN};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{
    rd_arr, rd_i16, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i16, wr_i64, wr_u16, wr_u32,
    wr_u64, wr_u8,
};
use crate::layout::header;
use crate::v2::layout::province::province as PV2;
use permutation_rules::frontier::beacon::{ring_seed_round, BeaconClock};
use permutation_rules::frontier::geometry::{R_MAX_HARD, SITES_PER_PROVINCE};
use permutation_rules::hash::sha256;

/// Version of the wide record family (every record of `land`, `holding`
/// and `march`). A candidate constant: bump it whenever a stored byte
/// changes meaning.
pub const WIDE_LAND_FAMILY_VERSION: u16 = 1;
/// The `layout_version` every wide chained header carries (the deployed
/// headers carry 1 and 2), so a v2 presence check refuses a wide record
/// by version as well as by magic and size.
pub const WIDE_LAYOUT_VERSION: u16 = 3;
/// The first wide ring: one past the legacy disk.
pub const FIRST_WIDE_RING: u64 = R_MAX_HARD as u64 + 1;
/// A byte meaning "no tile" in the prefix fields that take one.
pub const NO_TILE: u8 = 0xFF;

/// Seed tag of a wide ring seed (**provisional**; not a kernel `SeedKind`).
pub const RING_SEED_TAG: [u8; 2] = *b"wr";
/// Seed tag of a wide province (**provisional**; not a kernel `SeedKind`).
pub const PROVINCE_TAG: [u8; 2] = *b"wp";
/// Domain of the hashed raw key of a wide province seed: a 17-byte sort
/// key does not fit the 15 raw bytes of the deployed seed grammar, so the
/// raw key is `sha256(PROVINCE_SEED_DOMAIN ‖ sort key)[..15]`.
pub const PROVINCE_SEED_DOMAIN: &[u8] = b"PSF-WIDE-PROVINCE-SEED-v1";

/// The wide ring seed record (192 B, short header). **Provisional magic.**
pub mod ring_seed {
    crate::layout::fields!(size = 192;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        STATUS @ 18 : "u8" = 1;
        RSV_19 @ 19 : "rsv" = 1;
        RING @ 20 : "u64" = 8;
        OPENED_BELL @ 28 : "u32" = 4;
        T_OPEN @ 32 : "i64" = 8;
        ROUND @ 40 : "u64" = 8;
        SEED @ 48 : "[u8;32]" = 32;
        WORLD @ 80 : "[u8;32]" = 32;
        PROVINCES_CREATED @ 112 : "u64" = 8;
        PAYER @ 120 : "[u8;32]" = 32;
        RSV @ 152 : "rsv" = 40;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWRS1";
    pub const STATUS_REQUESTED: u8 = 1;
    pub const STATUS_SEEDED: u8 = 2;
}

/// The wide province's trailer (128 B at 4,736, after the whole Province
/// v2 layout). **Provisional magic.** The prefix is
/// `crate::v2::layout::province::province` byte for byte.
pub mod province {
    /// Offset of the trailer: the end of the Province v2 layout.
    pub const TRAILER: usize = crate::v2::layout::province::province::SIZE;
    /// The whole record.
    pub const SIZE: usize = TRAILER + 128;
    pub const MAGIC: [u8; 8] = *b"PSFXWPV1";
    pub const STATUS_OPENED: u8 = 1;

    pub const FAMILY_VERSION: usize = TRAILER;
    pub const STATUS: usize = TRAILER + 2;
    pub const READINESS: usize = TRAILER + 3;
    pub const WORLD: usize = TRAILER + 4;
    pub const SORT_KEY: usize = TRAILER + 36;
    pub const RSV_53: usize = TRAILER + 53;
    pub const SEED_ROUND: usize = TRAILER + 56;
    pub const RING_SEED: usize = TRAILER + 64;
    pub const FUNDED_LAMPORTS: usize = TRAILER + 96;
    pub const RSV: usize = TRAILER + 104;
    pub const RSV_LEN: usize = 24;

    const _: () = {
        assert!(TRAILER == 4_736);
        assert!(SIZE == 4_864);
        assert!(WORLD + 32 == SORT_KEY);
        assert!(SORT_KEY + 17 == RSV_53);
        assert!(RSV_53 + 3 == SEED_ROUND);
        assert!(SEED_ROUND + 8 == RING_SEED);
        assert!(RING_SEED + 32 == FUNDED_LAMPORTS);
        assert!(FUNDED_LAMPORTS + 8 == RSV);
        assert!(RSV + RSV_LEN == SIZE);
        // CPI allocation limit (the Province v2 test pins the same bound).
        assert!(SIZE <= 10_240);
    };
}

/// Why a record or a transition is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LandError {
    Length {
        expected: usize,
        got: usize,
    },
    Magic,
    /// A header `layout_version` or a trailer family version that is not
    /// the wide one.
    Version {
        expected: u16,
        got: u16,
    },
    /// A reserved byte is not zero.
    Reserved,
    Status(u8),
    World(KeyError),
    Coord(CoordError),
    /// A ring inside the legacy disk: that land is `OpenProvince`'s.
    NotWide {
        ring: u64,
    },
    /// The previous ring named is not `ring − 1`.
    ChainBroken {
        previous: u64,
        ring: u64,
    },
    /// The previous ring's seed is not seeded yet.
    PreviousUnseeded,
    /// Less than a bell since the previous ring opened.
    TooEarly {
        now_bell: u32,
        earliest: u32,
    },
    AlreadySeeded,
    NotSeeded,
    WrongRound {
        expected: u64,
        got: u64,
    },
    /// An all-zero seed is the "not yet seeded" marker, never a seed.
    ZeroSeed,
    /// The ring seed named is not the land's ring's (also a stored ring
    /// disagreeing with the stored coordinate).
    RingMismatch {
        seed: u64,
        land: u64,
    },
    /// A stored wedge disagreeing with the stored coordinate.
    WedgeMismatch {
        stored: u8,
        coord: u8,
    },
    WorldMismatch,
    SeasonMismatch,
    /// The prefix `P`, `Q` or `RING` of a wide province is not zero: the
    /// record is claiming a legacy identity.
    LegacyIdentityInPrefix,
    /// A rule the opening needs is undecided; the bits name them
    /// ([`readiness`]).
    NotReady {
        missing: u8,
    },
    Overflow,
}

impl From<KeyError> for LandError {
    fn from(e: KeyError) -> Self {
        LandError::World(e)
    }
}

impl From<CoordError> for LandError {
    fn from(e: CoordError) -> Self {
        LandError::Coord(e)
    }
}

// ------------------------------------------------------------ addresses

/// `wr ‖ hex(le64(ring))` (18 bytes). Provisional tag.
pub fn ring_seed_seed(ring: u64) -> Seed {
    Seed::new(RING_SEED_TAG, &ring.to_le_bytes())
}

/// `wp ‖ hex(sha256(PROVINCE_SEED_DOMAIN ‖ sort key)[..15])` (32 bytes).
/// Provisional tag. The sort key is canonical, so equal coordinates give
/// equal seeds and distinct coordinates distinct raw keys (up to a 120-bit
/// collision, which no honest or dishonest caller can produce).
pub fn province_seed(coord: WideCoord) -> Seed {
    let h = sha256(&[PROVINCE_SEED_DOMAIN, &coord.sort_key()]);
    Seed::new(PROVINCE_TAG, &h[..15])
}

/// `with_seed(season, wr‖ring, program)`.
pub fn ring_seed_address(ctx: &AddrCtx, ring: u64) -> [u8; 32] {
    ctx.of(&ring_seed_seed(ring))
}

/// `with_seed(season, wp‖hash(coord), program)`.
pub fn province_address(ctx: &AddrCtx, coord: WideCoord) -> [u8; 32] {
    ctx.of(&province_seed(coord))
}

/// The lamports every wedge fund must hold above its own rent before ring
/// `ring` may be requested: `ring × province_rent`, the deployed OpenRing
/// rule (`d × rent(Province)`) with the wide province's rent. `None` on
/// overflow.
pub const fn ring_rent(ring: u64, province_rent: u64) -> Option<u64> {
    ring.checked_mul(province_rent)
}

// ------------------------------------------------------------ ring seed

/// The two states of a wide ring seed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedStatus {
    /// Created at the request; the round is fixed, the seed is not known.
    Requested,
    /// A quicknet signature of the round was verified; the seed is fixed.
    Seeded,
}

impl SeedStatus {
    const fn to_byte(self) -> u8 {
        match self {
            SeedStatus::Requested => ring_seed::STATUS_REQUESTED,
            SeedStatus::Seeded => ring_seed::STATUS_SEEDED,
        }
    }
    const fn from_byte(b: u8) -> Option<SeedStatus> {
        match b {
            ring_seed::STATUS_REQUESTED => Some(SeedStatus::Requested),
            ring_seed::STATUS_SEEDED => Some(SeedStatus::Seeded),
            _ => None,
        }
    }
}

/// What the program authenticated about the previous ring's seed: the
/// legacy RingSeed of ring 128 for a request of ring 129, the wide ring
/// seed of `ring − 1` otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviousRing {
    pub ring: u64,
    pub seeded: bool,
    pub opened_bell: u32,
}

/// A wide ring seed, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideRingSeed {
    pub season_id: u64,
    pub world: WorldId,
    pub ring: u64,
    pub status: SeedStatus,
    pub opened_bell: u32,
    pub t_open: i64,
    /// The quicknet round the seed is bound to, fixed at the request.
    pub round: u64,
    /// All zero until seeded.
    pub seed: [u8; 32],
    pub provinces_created: u64,
    pub payer: [u8; 32],
}

pub(super) fn zero(d: &[u8], off: usize, n: usize) -> Result<(), LandError> {
    match d.get(off..off + n) {
        Some(s) if s.iter().all(|b| *b == 0) => Ok(()),
        _ => Err(LandError::Reserved),
    }
}

pub(super) fn truncated(expected: usize) -> LandError {
    LandError::Length { expected, got: 0 }
}

impl WideRingSeed {
    /// The request of ring `ring` of `world`, given the authenticated
    /// previous ring: `ring ≥ 129`, `previous.ring + 1 == ring`, the
    /// previous seeded, a bell since it opened; the round is
    /// `beacon::ring_seed_round(clock, t_open, margin)`, the deployed rule.
    /// No genesis path exists.
    #[allow(clippy::too_many_arguments)]
    pub fn request(
        world: WorldId,
        season_id: u64,
        ring: u64,
        previous: PreviousRing,
        now_bell: u32,
        t_open: i64,
        clock: &BeaconClock,
        margin: u32,
        payer: [u8; 32],
    ) -> Result<WideRingSeed, LandError> {
        if ring < FIRST_WIDE_RING {
            return Err(LandError::NotWide { ring });
        }
        if previous.ring.checked_add(1) != Some(ring) {
            return Err(LandError::ChainBroken {
                previous: previous.ring,
                ring,
            });
        }
        if !previous.seeded {
            return Err(LandError::PreviousUnseeded);
        }
        let earliest = previous.opened_bell.saturating_add(1);
        if now_bell < earliest {
            return Err(LandError::TooEarly { now_bell, earliest });
        }
        Ok(WideRingSeed {
            season_id,
            world,
            ring,
            status: SeedStatus::Requested,
            opened_bell: now_bell,
            t_open,
            round: ring_seed_round(clock, t_open, margin),
            seed: [0u8; 32],
            provinces_created: 0,
            payer,
        })
    }

    /// The seeded record: `Requested`, the round the record was bound to,
    /// a nonzero seed (the program's `quick::seed_of` of the verified
    /// signature of that round).
    pub fn seed_with(self, round: u64, seed: [u8; 32]) -> Result<WideRingSeed, LandError> {
        if self.status == SeedStatus::Seeded {
            return Err(LandError::AlreadySeeded);
        }
        if round != self.round {
            return Err(LandError::WrongRound {
                expected: self.round,
                got: round,
            });
        }
        if seed == [0u8; 32] {
            return Err(LandError::ZeroSeed);
        }
        Ok(WideRingSeed {
            status: SeedStatus::Seeded,
            seed,
            ..self
        })
    }

    /// The seed terrain is generated from, once seeded.
    pub fn terrain_seed(&self) -> Option<&[u8; 32]> {
        match self.status {
            SeedStatus::Seeded => Some(&self.seed),
            SeedStatus::Requested => None,
        }
    }

    /// The record after one more province opened from it.
    pub fn with_province_created(self) -> Result<WideRingSeed, LandError> {
        Ok(WideRingSeed {
            provinces_created: self
                .provinces_created
                .checked_add(1)
                .ok_or(LandError::Overflow)?,
            ..self
        })
    }

    /// Decodes exactly `ring_seed::SIZE` bytes: the magic, this family
    /// version, a known status, a non-reserved world, zero reserved bytes.
    pub fn read(d: &[u8]) -> Result<WideRingSeed, LandError> {
        use ring_seed as L;
        if d.len() != L::SIZE {
            return Err(LandError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = truncated(L::SIZE);
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(LandError::Magic);
        }
        let version = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if version != WIDE_LAND_FAMILY_VERSION {
            return Err(LandError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: version,
            });
        }
        let sb = rd_u8(d, L::STATUS).ok_or(t)?;
        let status = SeedStatus::from_byte(sb).ok_or(LandError::Status(sb))?;
        zero(d, L::RSV_19, 1)?;
        zero(d, L::RSV, 40)?;
        let seed: [u8; 32] = rd_arr(d, L::SEED).ok_or(t)?;
        // A seeded record carries a seed; a requested one does not.
        match status {
            SeedStatus::Seeded if seed == [0u8; 32] => return Err(LandError::ZeroSeed),
            SeedStatus::Requested if seed != [0u8; 32] => return Err(LandError::Reserved),
            _ => {}
        }
        Ok(WideRingSeed {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?,
            ring: rd_u64(d, L::RING).ok_or(t)?,
            status,
            opened_bell: rd_u32(d, L::OPENED_BELL).ok_or(t)?,
            t_open: rd_i64(d, L::T_OPEN).ok_or(t)?,
            round: rd_u64(d, L::ROUND).ok_or(t)?,
            seed,
            provinces_created: rd_u64(d, L::PROVINCES_CREATED).ok_or(t)?,
            payer: rd_arr(d, L::PAYER).ok_or(t)?,
        })
    }

    /// Writes every byte of the record into exactly `ring_seed::SIZE`
    /// bytes (reserved ranges zeroed).
    pub fn write(&self, d: &mut [u8]) -> Result<(), LandError> {
        use ring_seed as L;
        if d.len() != L::SIZE {
            return Err(LandError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::STATUS, self.status.to_byte())
            & wr_u8(d, L::RSV_19, 0)
            & wr_u64(d, L::RING, self.ring)
            & wr_u32(d, L::OPENED_BELL, self.opened_bell)
            & wr_i64(d, L::T_OPEN, self.t_open)
            & wr_u64(d, L::ROUND, self.round)
            & wr_arr(d, L::SEED, &self.seed)
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_u64(d, L::PROVINCES_CREATED, self.provinces_created)
            & wr_arr(d, L::PAYER, &self.payer)
            & wr_arr(d, L::RSV, &[0u8; 40]);
        if ok {
            Ok(())
        } else {
            Err(truncated(L::SIZE))
        }
    }
}

// ------------------------------------------------------------ readiness

/// A rule's state: decided (with the value the rule gives this province)
/// or not yet decided by the owner and allocated by the integrator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision<T> {
    Undecided,
    Decided(T),
}

impl<T: Copy> Decision<T> {
    pub const fn is_decided(&self) -> bool {
        matches!(self, Decision::Decided(_))
    }
    pub fn value(&self) -> Option<T> {
        match self {
            Decision::Decided(v) => Some(*v),
            Decision::Undecided => None,
        }
    }
}

/// The bits of the readiness mask, one per rule family a wide opening
/// needs beyond the kernels that already exist (terrain, sites, keep
/// tile, masks). Each is a separate owner decision plus an allocation.
pub mod readiness {
    /// The nation that holds the keep of a wide province (the placement
    /// texture past the heartland: the owner confirmed mixing, not which
    /// mixing; `placement::mixed_home_nation` and
    /// `placement::orbit_balanced_outer_nation` are the two candidates).
    pub const KEEP_HOLDER: u8 = 1;
    /// The genesis Free City site of a wide province (the deployed
    /// `terrain::free_city_site` hashes `LE32(P) ‖ LE32(Q)`).
    pub const FREE_CITY: u8 = 2;
    /// The initial camp of a wide province (the deployed `camp::place_v2`
    /// draws over `le32(P) ‖ le32(Q)`).
    pub const CAMP: u8 = 4;
    /// The beacon region of a wide province (the deployed
    /// `geometry::region_of` hashes `P ‖ Q` as `i32`).
    pub const REGION: u8 = 8;
    /// Every bit an opening needs.
    pub const REQUIRED: u8 = KEEP_HOLDER | FREE_CITY | CAMP | REGION;
}

/// A camp as the opening writes it (whole troops, as `camp::Camp`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CampDecision {
    pub tile: u8,
    pub troops: u32,
}

/// The rule outcomes an opening needs for one province. The program
/// passes [`WideRules::UNDECIDED`] until the rules exist; a test may pass
/// decided values to exercise the record codec, never a build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideRules {
    /// The nation holding the keep (`0..6`).
    pub keep_holder: Decision<u8>,
    /// The Free City site index, or `None` for a province without one.
    pub free_city_site: Decision<Option<u8>>,
    /// The initial camp, or `None` for none.
    pub camp: Decision<Option<CampDecision>>,
    /// The beacon region (`0..16`).
    pub region: Decision<u8>,
}

impl WideRules {
    /// Nothing decided: what the program knows today.
    pub const UNDECIDED: WideRules = WideRules {
        keep_holder: Decision::Undecided,
        free_city_site: Decision::Undecided,
        camp: Decision::Undecided,
        region: Decision::Undecided,
    };

    /// The bits of the decided rules.
    pub const fn readiness(&self) -> u8 {
        let mut m = 0u8;
        if self.keep_holder.is_decided() {
            m |= readiness::KEEP_HOLDER;
        }
        if self.free_city_site.is_decided() {
            m |= readiness::FREE_CITY;
        }
        if self.camp.is_decided() {
            m |= readiness::CAMP;
        }
        if self.region.is_decided() {
            m |= readiness::REGION;
        }
        m
    }

    /// The bits still undecided.
    pub const fn missing(&self) -> u8 {
        readiness::REQUIRED & !self.readiness()
    }
}

// ------------------------------------------------------------ province

/// A wide province's identity and provenance, decoded from its trailer and
/// the identity fields of its prefix. The game state in the prefix
/// (terrain, mirror, roster, cohorts, camp, conquest block) is read and
/// written by the program through the Province v2 offsets, exactly as for
/// a legacy province.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideProvince {
    pub season_id: u64,
    pub world: WorldId,
    pub coord: WideCoord,
    /// Geometric sextant of the coordinate (the funding wedge), never a
    /// nation.
    pub wedge: u8,
    /// The region the decided rule gave (prefix `REGION`).
    pub region: u8,
    pub opened_bell: u32,
    /// The decided rules' bits; always [`readiness::REQUIRED`] in a
    /// readable record.
    pub readiness: u8,
    /// The ring seed's round this province's terrain was made from.
    pub seed_round: u64,
    /// The ring seed itself (public once consumed).
    pub ring_seed: [u8; 32],
    /// Lamports moved from the wedge fund into this account.
    pub funded_lamports: u64,
}

/// What a decided opening writes besides the identity: the values of the
/// four rules, for the program to pass to the deployed writers (the keep
/// kernel, the mirror, the camp fields).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opening {
    pub province: WideProvince,
    pub keep_holder: u8,
    pub free_city_site: Option<u8>,
    pub camp: Option<CampDecision>,
}

impl WideProvince {
    /// The opening of `coord` from `seed` under `rules`: `coord` past the
    /// legacy disk; `seed` of the same world and ring and seeded; every
    /// rule decided (else [`LandError::NotReady`] naming the missing
    /// bits, before anything else is computed).
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        world: WorldId,
        season_id: u64,
        coord: WideCoord,
        seed: &WideRingSeed,
        rules: &WideRules,
        now_bell: u32,
        funded_lamports: u64,
    ) -> Result<Opening, LandError> {
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(LandError::NotWide { ring });
        }
        if seed.season_id != season_id {
            return Err(LandError::SeasonMismatch);
        }
        if seed.world != world {
            return Err(LandError::WorldMismatch);
        }
        if seed.ring != ring {
            return Err(LandError::RingMismatch {
                seed: seed.ring,
                land: ring,
            });
        }
        let ring_seed = *seed.terrain_seed().ok_or(LandError::NotSeeded)?;
        let missing = rules.missing();
        if missing != 0 {
            return Err(LandError::NotReady { missing });
        }
        let (Some(keep_holder), Some(free_city_site), Some(camp), Some(region)) = (
            rules.keep_holder.value(),
            rules.free_city_site.value(),
            rules.camp.value(),
            rules.region.value(),
        ) else {
            return Err(LandError::NotReady {
                missing: rules.missing(),
            });
        };
        if keep_holder as usize >= permutation_rules::frontier::geometry::FACTIONS as usize
            || region >= permutation_rules::frontier::geometry::REGIONS
            || free_city_site.is_some_and(|s| s as usize >= SITES_PER_PROVINCE)
        {
            return Err(LandError::Status(keep_holder));
        }
        if camp.is_some_and(|c| {
            c.tile as usize >= permutation_rules::frontier::geometry::PROVINCE_TILES
        }) {
            return Err(LandError::Status(0xFF));
        }
        // Ring ≥ 129 is never the Concord, so the wedge exists.
        let wedge = coord.wedge().ok_or(LandError::NotWide { ring })?;
        Ok(Opening {
            province: WideProvince {
                season_id,
                world,
                coord,
                wedge,
                region,
                opened_bell: now_bell,
                readiness: readiness::REQUIRED,
                seed_round: seed.round,
                ring_seed,
                funded_lamports,
            },
            keep_holder,
            free_city_site,
            camp,
        })
    }

    pub fn ring(&self) -> u64 {
        self.coord.ring()
    }

    /// Decodes the identity of exactly `province::SIZE` bytes: the wide
    /// magic and layout version in the chained header, this family
    /// version, status opened, a complete readiness mask, a non-reserved
    /// world, a canonical coordinate past the disk, prefix `P`, `Q`,
    /// `RING` zero, the prefix wedge equal to the coordinate's, zero
    /// reserved trailer bytes. The game state in the prefix is not
    /// interpreted here.
    pub fn read(d: &[u8]) -> Result<WideProvince, LandError> {
        use province as L;
        if d.len() != L::SIZE {
            return Err(LandError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = truncated(L::SIZE);
        if rd_arr::<8>(d, header::MAGIC).ok_or(t)? != L::MAGIC {
            return Err(LandError::Magic);
        }
        let lv = rd_u16(d, header::LAYOUT_VERSION).ok_or(t)?;
        if lv != WIDE_LAYOUT_VERSION {
            return Err(LandError::Version {
                expected: WIDE_LAYOUT_VERSION,
                got: lv,
            });
        }
        let version = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if version != WIDE_LAND_FAMILY_VERSION {
            return Err(LandError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: version,
            });
        }
        let sb = rd_u8(d, L::STATUS).ok_or(t)?;
        if sb != L::STATUS_OPENED {
            return Err(LandError::Status(sb));
        }
        let ready = rd_u8(d, L::READINESS).ok_or(t)?;
        if ready != readiness::REQUIRED {
            return Err(LandError::NotReady {
                missing: readiness::REQUIRED & !ready,
            });
        }
        zero(d, L::RSV_53, 3)?;
        zero(d, L::RSV, L::RSV_LEN)?;
        if rd_i16(d, PV2::P).ok_or(t)? != 0
            || rd_i16(d, PV2::Q).ok_or(t)? != 0
            || rd_u16(d, PV2::RING).ok_or(t)? != 0
        {
            return Err(LandError::LegacyIdentityInPrefix);
        }
        let key: [u8; SORT_KEY_LEN] = rd_arr(d, L::SORT_KEY).ok_or(t)?;
        let coord = WideCoord::from_sort_key(&key)?;
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(LandError::NotWide { ring });
        }
        let wedge = rd_u8(d, PV2::WEDGE).ok_or(t)?;
        let coord_wedge = coord.wedge().ok_or(LandError::NotWide { ring })?;
        if coord_wedge != wedge {
            return Err(LandError::WedgeMismatch {
                stored: wedge,
                coord: coord_wedge,
            });
        }
        let ring_seed: [u8; 32] = rd_arr(d, L::RING_SEED).ok_or(t)?;
        if ring_seed == [0u8; 32] {
            return Err(LandError::ZeroSeed);
        }
        Ok(WideProvince {
            season_id: rd_u64(d, header::SEASON_ID).ok_or(t)?,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?,
            coord,
            wedge,
            region: rd_u8(d, PV2::REGION).ok_or(t)?,
            opened_bell: rd_u32(d, PV2::OPENED_BELL).ok_or(t)?,
            readiness: ready,
            seed_round: rd_u64(d, L::SEED_ROUND).ok_or(t)?,
            ring_seed,
            funded_lamports: rd_u64(d, L::FUNDED_LAMPORTS).ok_or(t)?,
        })
    }

    /// Writes the identity: the chained header (wide magic, season,
    /// `layout_version` 3, a fresh chain), the prefix identity fields
    /// (`P`, `Q`, `RING` zero, `WEDGE`, `REGION`, `OPENED_BELL`) and the
    /// trailer. Every other prefix byte is the program's, written through
    /// the Province v2 offsets by the same code that writes a legacy
    /// province.
    pub fn write_identity(&self, d: &mut [u8]) -> Result<(), LandError> {
        use province as L;
        if d.len() != L::SIZE {
            return Err(LandError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        if self.readiness != readiness::REQUIRED {
            return Err(LandError::NotReady {
                missing: readiness::REQUIRED & !self.readiness,
            });
        }
        let ok = wr_arr(d, header::MAGIC, &L::MAGIC)
            & wr_u64(d, header::SEASON_ID, self.season_id)
            & wr_u16(d, header::LAYOUT_VERSION, WIDE_LAYOUT_VERSION)
            & wr_arr(d, header::LAYOUT_VERSION + 2, &[0u8; 6])
            & wr_u64(d, header::EVENT_SEQ, 0)
            & wr_arr(d, header::EVENT_HEAD, &[0u8; 32])
            & wr_i16(d, PV2::P, 0)
            & wr_i16(d, PV2::Q, 0)
            & wr_u16(d, PV2::RING, 0)
            & wr_u8(d, PV2::WEDGE, self.wedge)
            & wr_u8(d, PV2::REGION, self.region)
            & wr_u32(d, PV2::OPENED_BELL, self.opened_bell)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::STATUS, L::STATUS_OPENED)
            & wr_u8(d, L::READINESS, self.readiness)
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.coord.sort_key())
            & wr_arr(d, L::RSV_53, &[0u8; 3])
            & wr_u64(d, L::SEED_ROUND, self.seed_round)
            & wr_arr(d, L::RING_SEED, &self.ring_seed)
            & wr_u64(d, L::FUNDED_LAMPORTS, self.funded_lamports)
            & wr_arr(d, L::RSV, &[0u8; L::RSV_LEN]);
        if ok {
            Ok(())
        } else {
            Err(truncated(L::SIZE))
        }
    }
}

// Every wide world id is 32 bytes, as the key module says.
const _: () = assert!(WORLD_ID_LEN == 32);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Field;
    use crate::world_index::coord::RingPosition;
    use permutation_rules::frontier::clash::QUICKNET;
    use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord};
    use std::vec::Vec;

    const WORLD_BYTES: [u8; 32] = [0x77; 32];
    const PAYER: [u8; 32] = [0xd4; 32];
    const T_OPEN: i64 = 1_800_000_600;

    fn world() -> WorldId {
        WorldId::new(WORLD_BYTES).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    fn prev128() -> PreviousRing {
        PreviousRing {
            ring: 128,
            seeded: true,
            opened_bell: 0,
        }
    }

    fn requested(ring: u64) -> WideRingSeed {
        let prev = PreviousRing {
            ring: ring - 1,
            seeded: true,
            opened_bell: 0,
        };
        WideRingSeed::request(world(), 11, ring, prev, 1, T_OPEN, &QUICKNET, 60, PAYER).unwrap()
    }

    fn seeded(ring: u64) -> WideRingSeed {
        let r = requested(ring);
        r.seed_with(r.round, [9u8; 32]).unwrap()
    }

    /// Decided values for the codec tests only (a model exercise; no build
    /// passes them).
    fn decided() -> WideRules {
        WideRules {
            keep_holder: Decision::Decided(3),
            free_city_site: Decision::Decided(Some(2)),
            camp: Decision::Decided(Some(CampDecision {
                tile: 17,
                troops: 250,
            })),
            region: Decision::Decided(9),
        }
    }

    fn tiles(name: &str, size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{name}.{} starts at {} not {at}", f.name, f.off);
            assert!(f.len > 0, "{name}.{} is empty", f.name);
            at += f.len;
        }
        assert_eq!(at, size, "{name} fields end at {at}, size {size}");
    }

    /// The ring seed layout tiles; the province is the whole v2 layout plus
    /// a trailer; the magics are new and marked experimental; the versions
    /// and the first wide ring are pinned.
    #[test]
    fn layouts_are_the_v2_province_plus_a_trailer_and_the_magics_are_new() {
        tiles("WideRingSeed", ring_seed::SIZE, ring_seed::FIELDS);
        assert_eq!(province::TRAILER, PV2::SIZE);
        assert_eq!(province::SIZE, PV2::SIZE + 128);
        assert_eq!(province::SIZE, 4_864);
        for m in [ring_seed::MAGIC, province::MAGIC] {
            assert_eq!(&m[..4], b"PSFX", "experimental magics are marked");
            assert_eq!(crate::layout::AccountKind::from_magic(&m), None);
            assert_eq!(crate::v2::layout::AccountKind::from_magic(&m), None);
        }
        assert_ne!(ring_seed::MAGIC, province::MAGIC);
        assert_eq!(WIDE_LAND_FAMILY_VERSION, 1);
        assert_eq!(WIDE_LAYOUT_VERSION, 3);
        assert_ne!(WIDE_LAYOUT_VERSION, crate::ABI_VERSION);
        assert_ne!(WIDE_LAYOUT_VERSION, crate::v2::layout::LAYOUT_VERSION_V2);
        assert_eq!(FIRST_WIDE_RING, 129);
        assert_eq!(R_MAX_HARD, 128);
        assert_eq!(readiness::REQUIRED, 0b1111);
        assert_eq!(WideRules::UNDECIDED.readiness(), 0);
        assert_eq!(WideRules::UNDECIDED.missing(), readiness::REQUIRED);
        assert_eq!(decided().missing(), 0);
    }

    /// The draft seed tags are outside the kernel's seed grammar table and
    /// outside the integrator's allocation of 2026-11-06; the seeds have
    /// the fixed lengths of the grammar and parse back; equal coordinates
    /// give equal addresses, distinct ones distinct addresses, and no wide
    /// address is a legacy Province's or RingSeed's.
    #[test]
    fn draft_seeds_are_unallocated_fixed_length_and_never_a_legacy_address() {
        use permutation_rules::frontier::addr::SeedKind;
        let allocated: [[u8; 2]; 8] = [
            *b"cl", *b"gr", *b"cp", *b"cj", *b"xr", *b"xg", *b"xi", *b"xb",
        ];
        for t in [RING_SEED_TAG, PROVINCE_TAG] {
            assert_eq!(SeedKind::from_tag(&t), None, "{t:?} is a kernel seed kind");
            assert!(
                !allocated.contains(&t),
                "{t:?} is allocated to another workstream"
            );
            assert!(t[0].is_ascii_lowercase() && t[1].is_ascii_lowercase());
        }
        let s = ring_seed_seed(129);
        assert_eq!(s.len(), 18);
        assert_eq!(s.as_bytes(), b"wr8100000000000000");
        let (tag, raw, n) = Seed::parse(s.as_bytes()).unwrap();
        assert_eq!((tag, n), (RING_SEED_TAG, 8));
        assert_eq!(u64::from_le_bytes(raw[..8].try_into().unwrap()), 129);
        let l = province_seed(c(129, 0));
        assert_eq!(l.len(), 32, "15 raw bytes: the grammar's maximum");
        let h = sha256(&[PROVINCE_SEED_DOMAIN, &c(129, 0).sort_key()]);
        let (tag, raw, n) = Seed::parse(l.as_bytes()).unwrap();
        assert_eq!((tag, n), (PROVINCE_TAG, 15));
        assert_eq!(&raw[..15], &h[..15]);
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        assert_eq!(
            province_address(&ctx, c(129, 0)),
            province_address(&ctx, c(129, 0))
        );
        let far = [
            c(129, 0),
            c(0, -129),
            c(-129, 129),
            c(1 << 40, 3),
            c((1 << 53) + 1, -7),
            c(1 << 62, 1 << 62),
            c(-(1 << 62), -(1 << 62)),
        ];
        let mut addrs: Vec<[u8; 32]> = far.iter().map(|w| province_address(&ctx, *w)).collect();
        addrs.sort();
        addrs.dedup();
        assert_eq!(
            addrs.len(),
            far.len(),
            "distinct coordinates, distinct addresses"
        );
        for w in far {
            if let (Ok(p), Ok(q)) = (i32::try_from(w.p()), i32::try_from(w.q())) {
                assert_ne!(province_address(&ctx, w), ctx.province(p, q));
            }
        }
        for d in [0u32, 1, 2, 128] {
            for p in ring_provinces(d) {
                let w = c(p.p as i64, p.q as i64);
                assert_ne!(province_address(&ctx, w), ctx.province(p.p, p.q));
            }
        }
        assert_ne!(ring_seed_address(&ctx, 129), ctx.ring_seed(129));
        assert_ne!(ring_seed_address(&ctx, 129), ring_seed_address(&ctx, 130));
        let other = AddrCtx {
            season: [5; 32],
            program: [4; 32],
        };
        assert_ne!(ring_seed_address(&ctx, 129), ring_seed_address(&other, 129));
        assert_eq!(ring_rent(129, 3_251_200), Some(129 * 3_251_200));
        assert_eq!(ring_rent(u64::MAX, 2), None);
    }

    /// The request continues the deployed OpenRing rules: never inside the
    /// disk, one ring at a time after a seeded previous ring, a bell after
    /// it opened; the round is the kernel's `ring_seed_round`; there is no
    /// genesis path (every request is `Requested` with a zero seed).
    #[test]
    fn request_continues_the_deployed_ring_rules_and_binds_the_beacon_round() {
        for ring in [0u64, 1, 64, 127, 128] {
            let prev = PreviousRing {
                ring: ring.saturating_sub(1),
                seeded: true,
                opened_bell: 0,
            };
            assert_eq!(
                WideRingSeed::request(world(), 11, ring, prev, 5, T_OPEN, &QUICKNET, 60, PAYER),
                Err(LandError::NotWide { ring })
            );
        }
        let ok =
            WideRingSeed::request(world(), 11, 129, prev128(), 1, T_OPEN, &QUICKNET, 60, PAYER)
                .unwrap();
        assert_eq!(ok.status, SeedStatus::Requested);
        assert_eq!(ok.seed, [0u8; 32]);
        assert_eq!(ok.round, ring_seed_round(&QUICKNET, T_OPEN, 60));
        assert_eq!(
            (ok.ring, ok.opened_bell, ok.t_open, ok.provinces_created),
            (129, 1, T_OPEN, 0)
        );
        assert_eq!(ok.payer, PAYER);
        assert_eq!(ok.terrain_seed(), None);
        let later = WideRingSeed::request(
            world(),
            11,
            129,
            prev128(),
            1,
            T_OPEN + 3_000,
            &QUICKNET,
            60,
            PAYER,
        )
        .unwrap();
        assert!(later.round > ok.round, "the round moves with the time");
        let wider = WideRingSeed::request(
            world(),
            11,
            129,
            prev128(),
            1,
            T_OPEN,
            &QUICKNET,
            6_000,
            PAYER,
        )
        .unwrap();
        assert!(wider.round > ok.round, "and with the margin");
        assert_eq!(
            WideRingSeed::request(world(), 11, 130, prev128(), 1, T_OPEN, &QUICKNET, 60, PAYER),
            Err(LandError::ChainBroken {
                previous: 128,
                ring: 130
            })
        );
        let p129 = PreviousRing {
            ring: 129,
            seeded: true,
            opened_bell: 7,
        };
        assert_eq!(
            WideRingSeed::request(world(), 11, 129, p129, 9, T_OPEN, &QUICKNET, 60, PAYER),
            Err(LandError::ChainBroken {
                previous: 129,
                ring: 129
            })
        );
        assert_eq!(
            WideRingSeed::request(
                world(),
                11,
                130,
                PreviousRing {
                    seeded: false,
                    ..p129
                },
                9,
                T_OPEN,
                &QUICKNET,
                60,
                PAYER
            ),
            Err(LandError::PreviousUnseeded)
        );
        assert_eq!(
            WideRingSeed::request(world(), 11, 130, p129, 7, T_OPEN, &QUICKNET, 60, PAYER),
            Err(LandError::TooEarly {
                now_bell: 7,
                earliest: 8
            })
        );
        assert!(
            WideRingSeed::request(world(), 11, 130, p129, 8, T_OPEN, &QUICKNET, 60, PAYER).is_ok()
        );
        let top = PreviousRing {
            ring: u64::MAX,
            seeded: true,
            opened_bell: 0,
        };
        assert_eq!(
            WideRingSeed::request(world(), 11, 0, top, 1, T_OPEN, &QUICKNET, 60, PAYER),
            Err(LandError::NotWide { ring: 0 })
        );
        let near_top = PreviousRing {
            ring: u64::MAX - 1,
            seeded: true,
            opened_bell: u32::MAX,
        };
        assert_eq!(
            WideRingSeed::request(
                world(),
                11,
                u64::MAX,
                near_top,
                u32::MAX,
                T_OPEN,
                &QUICKNET,
                60,
                PAYER
            )
            .map(|r| r.ring),
            Ok(u64::MAX),
            "saturating bell arithmetic, no wrap"
        );
    }

    /// Seeding is bound to the request's round, once, with a nonzero seed.
    #[test]
    fn seeding_binds_the_round_and_happens_once() {
        let r = requested(129);
        let seed = [0x5a; 32];
        assert_eq!(
            r.seed_with(r.round + 1, seed),
            Err(LandError::WrongRound {
                expected: r.round,
                got: r.round + 1
            })
        );
        assert_eq!(r.seed_with(r.round, [0u8; 32]), Err(LandError::ZeroSeed));
        let s = r.seed_with(r.round, seed).unwrap();
        assert_eq!(s.status, SeedStatus::Seeded);
        assert_eq!(s.terrain_seed(), Some(&seed));
        assert_eq!(s.round, r.round);
        assert_eq!(s.seed_with(r.round, seed), Err(LandError::AlreadySeeded));
        assert_eq!(
            s.seed_with(r.round, [1u8; 32]),
            Err(LandError::AlreadySeeded)
        );
        let counted = s.with_province_created().unwrap();
        assert_eq!(counted.provinces_created, 1);
        let mut full = counted;
        full.provinces_created = u64::MAX;
        assert_eq!(full.with_province_created(), Err(LandError::Overflow));
    }

    #[test]
    fn ring_seed_record_round_trips_and_refuses_bad_bytes() {
        let r = requested(129);
        let mut d = std::vec![0u8; ring_seed::SIZE];
        r.write(&mut d).unwrap();
        assert_eq!(WideRingSeed::read(&d), Ok(r));
        assert_eq!(&d[..8], &ring_seed::MAGIC);
        let s = r.seed_with(r.round, [9u8; 32]).unwrap();
        s.write(&mut d).unwrap();
        assert_eq!(WideRingSeed::read(&d), Ok(s));
        assert_eq!(
            WideRingSeed::read(&d[..191]),
            Err(LandError::Length {
                expected: 192,
                got: 191
            })
        );
        let mut long = d.clone();
        long.push(0);
        assert_eq!(
            WideRingSeed::read(&long),
            Err(LandError::Length {
                expected: 192,
                got: 193
            })
        );
        assert_eq!(
            s.write(&mut long),
            Err(LandError::Length {
                expected: 192,
                got: 193
            })
        );
        let mut x = d.clone();
        x[0] ^= 1;
        assert_eq!(WideRingSeed::read(&x), Err(LandError::Magic));
        let mut x = d.clone();
        x[ring_seed::FAMILY_VERSION] = 2;
        assert_eq!(
            WideRingSeed::read(&x),
            Err(LandError::Version {
                expected: 1,
                got: 2
            })
        );
        for bad in [0u8, 3, 255] {
            let mut x = d.clone();
            x[ring_seed::STATUS] = bad;
            assert_eq!(WideRingSeed::read(&x), Err(LandError::Status(bad)));
        }
        let mut x = d.clone();
        x[ring_seed::RSV_19] = 1;
        assert_eq!(WideRingSeed::read(&x), Err(LandError::Reserved));
        let mut x = d.clone();
        x[ring_seed::RSV + 39] = 1;
        assert_eq!(WideRingSeed::read(&x), Err(LandError::Reserved));
        let mut x = d.clone();
        x[ring_seed::WORLD..ring_seed::WORLD + 32].fill(0);
        assert_eq!(
            WideRingSeed::read(&x),
            Err(LandError::World(KeyError::ReservedWorld))
        );
        let mut x = d.clone();
        x[ring_seed::SEED..ring_seed::SEED + 32].fill(0);
        assert_eq!(WideRingSeed::read(&x), Err(LandError::ZeroSeed));
        let mut x = d.clone();
        x[ring_seed::STATUS] = ring_seed::STATUS_REQUESTED;
        assert_eq!(WideRingSeed::read(&x), Err(LandError::Reserved));
    }

    /// With every rule undecided (what the program knows), no province can
    /// be opened, and the refusal names every missing rule; with one rule
    /// decided the refusal names the others; the seed, ring and world are
    /// checked before the rules so a caller learns the cheapest refusal
    /// first.
    #[test]
    fn opening_is_not_ready_while_any_rule_is_undecided() {
        let s = seeded(129);
        assert_eq!(
            WideProvince::open(world(), 11, c(129, 0), &s, &WideRules::UNDECIDED, 1, 1),
            Err(LandError::NotReady {
                missing: readiness::REQUIRED
            })
        );
        let mut one = WideRules::UNDECIDED;
        one.region = Decision::Decided(3);
        assert_eq!(
            WideProvince::open(world(), 11, c(129, 0), &s, &one, 1, 1),
            Err(LandError::NotReady {
                missing: readiness::KEEP_HOLDER | readiness::FREE_CITY | readiness::CAMP
            })
        );
        let mut three = decided();
        three.camp = Decision::Undecided;
        assert_eq!(
            WideProvince::open(world(), 11, c(129, 0), &s, &three, 1, 1),
            Err(LandError::NotReady {
                missing: readiness::CAMP
            })
        );
        // identity refusals come first, whatever the rules
        for rules in [WideRules::UNDECIDED, decided()] {
            for p in ring_provinces(128).into_iter().chain(ring_provinces(0)) {
                let w = c(p.p as i64, p.q as i64);
                assert_eq!(
                    WideProvince::open(world(), 11, w, &s, &rules, 1, 1),
                    Err(LandError::NotWide {
                        ring: p.ring() as u64
                    })
                );
            }
            assert_eq!(
                WideProvince::open(world(), 11, c(129, 0), &requested(129), &rules, 1, 1),
                Err(LandError::NotSeeded)
            );
            assert_eq!(
                WideProvince::open(world(), 11, c(130, 0), &s, &rules, 1, 1),
                Err(LandError::RingMismatch {
                    seed: 129,
                    land: 130
                })
            );
            let other = WorldId::new([0x78; 32]).unwrap();
            assert_eq!(
                WideProvince::open(other, 11, c(129, 0), &s, &rules, 1, 1),
                Err(LandError::WorldMismatch)
            );
        }
        // decided values out of range are refused
        let mut bad = decided();
        bad.keep_holder = Decision::Decided(6);
        assert!(WideProvince::open(world(), 11, c(129, 0), &s, &bad, 1, 1).is_err());
        let mut bad = decided();
        bad.region = Decision::Decided(16);
        assert!(WideProvince::open(world(), 11, c(129, 0), &s, &bad, 1, 1).is_err());
        let mut bad = decided();
        bad.free_city_site = Decision::Decided(Some(12));
        assert!(WideProvince::open(world(), 11, c(129, 0), &s, &bad, 1, 1).is_err());
    }

    /// Under decided rules (a model exercise) the record round-trips with
    /// its exact identity, leaves every game-state byte of the prefix to
    /// the program, carries zero legacy identity, and is refused in every
    /// malformed or half-ready form.
    #[test]
    fn province_record_round_trips_over_the_v2_prefix_and_refuses_bad_bytes() {
        let s = seeded(129);
        let o = WideProvince::open(world(), 11, c(129, 0), &s, &decided(), 3, 24_709_120).unwrap();
        assert_eq!((o.keep_holder, o.free_city_site), (3, Some(2)));
        assert_eq!(
            o.camp,
            Some(CampDecision {
                tile: 17,
                troops: 250
            })
        );
        let p = o.province;
        assert_eq!(
            (p.wedge, p.region, p.readiness),
            (0, 9, readiness::REQUIRED)
        );
        assert_eq!(p.ring(), 129);
        assert_eq!(p.ring_seed, [9u8; 32]);
        assert_eq!(p.seed_round, s.round);
        let mut d = std::vec![0u8; province::SIZE];
        // the program's game state, written through the v2 offsets first
        for (i, b) in d[PV2::TERRAIN..PV2::SIZE].iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        let state: Vec<u8> = d[PV2::TERRAIN..PV2::SIZE].to_vec();
        p.write_identity(&mut d).unwrap();
        assert_eq!(
            &d[PV2::TERRAIN..PV2::SIZE],
            &state[..],
            "the game state is untouched"
        );
        assert_eq!(&d[..8], &province::MAGIC);
        assert_eq!(rd_u16(&d, header::LAYOUT_VERSION), Some(3));
        assert_eq!(rd_u64(&d, header::EVENT_SEQ), Some(0));
        assert_eq!(rd_i16(&d, PV2::P), Some(0));
        assert_eq!(rd_i16(&d, PV2::Q), Some(0));
        assert_eq!(rd_u16(&d, PV2::RING), Some(0));
        assert_eq!(rd_u8(&d, PV2::WEDGE), Some(0));
        assert_eq!(rd_u8(&d, PV2::REGION), Some(9));
        assert_eq!(WideProvince::read(&d), Ok(p));
        // a legacy v2 presence check refuses it three ways: size, magic, version
        assert_ne!(d.len(), PV2::SIZE);
        assert_ne!(&d[..8], &PV2::MAGIC);
        assert_ne!(
            crate::v2::layout::layout_version(&d),
            Some(crate::v2::layout::LAYOUT_VERSION_V2)
        );
        // far coordinates, both signs, round-trip exactly
        for w in [c(-129, 129), c(1 << 40, -(1 << 41)), c(1 << 62, 1 << 62)] {
            let seed = seeded(w.ring());
            let far = WideProvince::open(world(), 11, w, &seed, &decided(), 3, 1)
                .unwrap()
                .province;
            assert_eq!(far.wedge, w.wedge().unwrap());
            let mut d = std::vec![0u8; province::SIZE];
            far.write_identity(&mut d).unwrap();
            let back = WideProvince::read(&d).unwrap();
            assert_eq!(back.coord, w);
            assert_eq!((back.coord.p(), back.coord.q()), (w.p(), w.q()));
        }
        // refusals
        assert_eq!(
            WideProvince::read(&d[..PV2::SIZE]),
            Err(LandError::Length {
                expected: province::SIZE,
                got: PV2::SIZE
            })
        );
        let mut x = d.clone();
        x[3] ^= 1;
        assert_eq!(WideProvince::read(&x), Err(LandError::Magic));
        let mut x = d.clone();
        x[header::LAYOUT_VERSION] = 2;
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::Version {
                expected: 3,
                got: 2
            })
        );
        let mut x = d.clone();
        x[province::FAMILY_VERSION] = 0;
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::Version {
                expected: 1,
                got: 0
            })
        );
        let mut x = d.clone();
        x[province::STATUS] = 2;
        assert_eq!(WideProvince::read(&x), Err(LandError::Status(2)));
        // a half-ready record can never be read back
        let mut x = d.clone();
        x[province::READINESS] = readiness::REQUIRED & !readiness::FREE_CITY;
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::NotReady {
                missing: readiness::FREE_CITY
            })
        );
        let mut half = p;
        half.readiness = 0;
        assert_eq!(
            half.write_identity(&mut d.clone()),
            Err(LandError::NotReady {
                missing: readiness::REQUIRED
            })
        );
        for off in [
            province::RSV_53 + 2,
            province::RSV,
            province::RSV + province::RSV_LEN - 1,
        ] {
            let mut x = d.clone();
            x[off] = 1;
            assert_eq!(
                WideProvince::read(&x),
                Err(LandError::Reserved),
                "offset {off}"
            );
        }
        let mut x = d.clone();
        x[province::WORLD..province::WORLD + 32].fill(0);
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::World(KeyError::ReservedWorld))
        );
        // a legacy identity written into the prefix is refused
        for off in [PV2::P, PV2::Q + 1, PV2::RING] {
            let mut x = d.clone();
            x[off] = 1;
            assert_eq!(
                WideProvince::read(&x),
                Err(LandError::LegacyIdentityInPrefix)
            );
        }
        let mut x = d.clone();
        x[province::SORT_KEY..province::SORT_KEY + SORT_KEY_LEN]
            .copy_from_slice(&c(128, 0).sort_key());
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::NotWide { ring: 128 })
        );
        let mut x = d.clone();
        x[province::SORT_KEY + 8] = 6;
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::Coord(CoordError::NonCanonical))
        );
        let mut x = d.clone();
        x[PV2::WEDGE] = 1;
        assert_eq!(
            WideProvince::read(&x),
            Err(LandError::WedgeMismatch {
                stored: 1,
                coord: 0
            })
        );
        let mut x = d.clone();
        x[province::RING_SEED..province::RING_SEED + 32].fill(0);
        assert_eq!(WideProvince::read(&x), Err(LandError::ZeroSeed));
    }

    /// Every province of ring 129 would open from the one ring seed, each
    /// in its own geometric wedge, which the legacy sextant rule agrees on
    /// (the legacy `ring_provinces` stops at ring 128; the wide coordinate's
    /// ring order continues it).
    #[test]
    fn ring_129_opens_from_one_seed_wedge_by_wedge() {
        let s = seeded(129);
        let mut wedges = [0u32; 6];
        for pos in 0..6 * 129u64 {
            let w = WideCoord::from_ring_position(RingPosition {
                ring: 129,
                wedge: (pos / 129) as u8,
                pos: pos % 129,
            })
            .unwrap();
            let p = WideProvince::open(world(), 11, w, &s, &decided(), 1, 1)
                .unwrap()
                .province;
            wedges[p.wedge as usize] += 1;
            assert_eq!(p.wedge as u64, pos / 129);
            assert_eq!(
                Some(p.wedge),
                ProvinceCoord::new(w.p() as i32, w.q() as i32).wedge()
            );
        }
        assert_eq!(wedges, [129; 6]);
    }
    #[test]
    fn native_review_binds_the_seed_to_the_same_season() {
        let seed = seeded(129);
        assert!(matches!(
            WideProvince::open(
                world(),
                seed.season_id + 1,
                c(129, 0),
                &seed,
                &decided(),
                1,
                0
            ),
            Err(LandError::SeasonMismatch)
        ));
    }
}
