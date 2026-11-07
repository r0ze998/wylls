//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! explicit, versioned **experimental rules configuration** of a wide
//! world, and the **candidate** rule functions it selects.
//!
//! An opening of wide land needs four rule outcomes the deployed kernels
//! cannot give past ring 128 (`super::land::readiness`): the nation that
//! holds the keep, the genesis Free City site, the initial camp and the
//! beacon region (the deployed three hash `LE32(P) ‖ LE32(Q)`). None of
//! them is an approved product rule. This module lets a **host-only
//! experimental build** exercise *candidates* for them under one explicit
//! record, [`WideRulesConfig`], written once per Season by the Season's
//! authority (`WideSetRules`, `wide_ix`):
//!
//! | rule | byte 0 | candidates |
//! |---|---|---|
//! | keep holder | unset (refused) | 1 [`KeepHolderRule::MixedInterleaved`] (`placement::mixed_home_nation`), 2 [`KeepHolderRule::OrbitBalanced`] (`placement::orbit_balanced_outer_nation`) |
//! | Free City | unset (refused) | 1 [`FreeCityRule::NoFreeCity`], 2 [`FreeCityRule::CanonicalHashV1`] ([`wide_free_city_site`]) |
//! | camp | unset (refused) | 1 [`CampRule::NoCamp`], 2 [`CampRule::SortKeyDrawV1`] ([`wide_initial_camp`]) |
//! | region | unset (refused) | 1 [`RegionRule::SortKeyHashV1`] ([`wide_region`]) |
//!
//! **Unset refuses.** A zeroed account is not a configuration: every rule
//! byte 0 is "unset" and [`WideRulesConfig::read`] refuses it, as it
//! refuses any byte outside the table, so an opening without an explicit
//! configuration is exactly as closed as before this module existed
//! (`WideRules::UNDECIDED`, `NotImplemented`). A configuration decides
//! every rule or none: [`WideRulesConfig::new`] refuses a partial one.
//!
//! **Candidates, not decisions.** The owner confirmed that outer nations
//! mix; which mixing, whether wide land has Free Cities and camps, and the
//! region hash are open. Each candidate here is a versioned, pinned pure
//! function so a world opened under one can be re-derived bit for bit and
//! compared; selecting one in a configuration is an experiment, not a
//! product decision, and nothing here is a Season parameter or a ruleset
//! hash input. The record's `config_version` names the table above; a
//! later table is a new version, never a reinterpretation.
//!
//! **Reuse.** [`wide_initial_camp`] is the deployed camp kernel's draw
//! (`camp::camp_tile_ok`, `camp::below`, the same troop range, the keep
//! tile excluded as `camp::place_v2`) over the canonical 17-byte sort key
//! instead of `LE32(P) ‖ LE32(Q)`, and [`wide_daily_camp`] is the same
//! kernel's daily check (`initial = false`: no camp without a holding, a ½
//! spawn gate) over the same id, for a wide resolve that must not read the
//! deployed `coord_of` (zero in a wide record); [`wide_free_city_site`] is the deployed
//! `terrain::free_city_site` shape (a hash over the **canonical wedge-0
//! copy**, so the six wedges of a ring agree, `mod site_count`) over the
//! copy's `(ring, position)`; [`wide_keep_open`] is `keep::try_open`
//! without the `ProvinceCoord` (a wide province is never heartland-safe),
//! pinned equal to it where both exist.

use super::coord::WideCoord;
use super::key::{KeyError, WorldId};
use super::land::{self, CampDecision, Decision, WideRules, FIRST_WIDE_RING};
use super::placement::{mixed_home_nation, orbit_balanced_outer_nation};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_u16, rd_u64, rd_u8, wr_arr, wr_u16, wr_u64, wr_u8};
use permutation_rules::frontier::camp::{
    below, camp_tile_ok, Camp, CAMP_TROOPS_MIN, CAMP_TROOPS_SPREAD,
};
use permutation_rules::frontier::geometry::{PROVINCE_TILES, REGIONS};
use permutation_rules::frontier::keep::{Keep, KeepError, KeepParams, MAX_KEEP_TROOPS, NO_FACTION};
use permutation_rules::frontier::terrain::ProvinceTerrain;
use permutation_rules::hash::sha256;
use permutation_rules::rng::rand;

/// Version of the candidate table above. A candidate constant; a changed
/// table is a new version.
pub const WIDE_RULES_CONFIG_VERSION: u16 = 1;
/// Seed tag of the configuration record (**provisional**; not a kernel
/// `SeedKind`).
pub const RULES_CONFIG_TAG: [u8; 2] = *b"wc";
/// Domain of [`wide_free_city_site`]. Distinct from the deployed
/// `PSF-FREE-CITY`.
pub const FREE_CITY_DOMAIN_WIDE: &[u8] = b"PSF-FREE-CITY-WIDE-v1";
/// Domain of [`wide_region`]. Distinct from the deployed `frontier/region`.
pub const REGION_DOMAIN_WIDE: &[u8] = b"frontier/region/wide-v1";
/// `rng::rand` domains of [`wide_initial_camp`] and [`wide_daily_camp`].
/// Distinct from the deployed `frontier/camp/tile`, `frontier/camp/troops`
/// and `frontier/camp/spawn`.
pub const CAMP_TILE_DOMAIN_WIDE: &[u8] = b"frontier/camp/tile/wide-v1";
pub const CAMP_TROOPS_DOMAIN_WIDE: &[u8] = b"frontier/camp/troops/wide-v1";
pub const CAMP_SPAWN_DOMAIN_WIDE: &[u8] = b"frontier/camp/spawn/wide-v1";

/// The configuration record (96 B, short header). **Provisional magic.**
pub mod rules_config {
    crate::layout::fields!(size = 96;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        CONFIG_VERSION @ 16 : "u16" = 2;
        KEEP_HOLDER @ 18 : "u8" = 1;
        FREE_CITY @ 19 : "u8" = 1;
        CAMP @ 20 : "u8" = 1;
        REGION @ 21 : "u8" = 1;
        RSV_22 @ 22 : "rsv" = 2;
        WORLD @ 24 : "[u8;32]" = 32;
        AUTHORITY @ 56 : "[u8;32]" = 32;
        RSV @ 88 : "rsv" = 8;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWRC1";
}

/// Why a configuration or a decision is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RulesError {
    Length {
        expected: usize,
        got: usize,
    },
    Magic,
    Version {
        expected: u16,
        got: u16,
    },
    Reserved,
    /// A rule byte 0: no configuration was made for it.
    Unset(&'static str),
    /// A rule byte outside the candidate table.
    Unknown {
        rule: &'static str,
        byte: u8,
    },
    World(KeyError),
    /// A coordinate inside the legacy disk: no wide rule applies.
    NotWide {
        ring: u64,
    },
    SeasonMismatch,
    WorldMismatch,
}

impl From<KeyError> for RulesError {
    fn from(e: KeyError) -> Self {
        RulesError::World(e)
    }
}

// ------------------------------------------------------------ candidates

/// Who holds the keep of a wide province.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum KeepHolderRule {
    /// `placement::mixed_home_nation`: evenly interleaved single provinces.
    MixedInterleaved = 1,
    /// `placement::orbit_balanced_outer_nation`: each terrain orbit gives
    /// one copy to each nation.
    OrbitBalanced = 2,
}

/// Whether and where a wide province gets a genesis Free City.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FreeCityRule {
    /// Wide land has no genesis Free City.
    NoFreeCity = 1,
    /// [`wide_free_city_site`], when the season has Free Cities at all.
    CanonicalHashV1 = 2,
}

/// Whether and where a wide province gets its initial camp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CampRule {
    /// Wide land has no initial camp.
    NoCamp = 1,
    /// [`wide_initial_camp`].
    SortKeyDrawV1 = 2,
}

/// The beacon region of a wide province.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RegionRule {
    /// [`wide_region`].
    SortKeyHashV1 = 1,
}

macro_rules! rule_bytes {
    ($t:ident, $name:literal, [$($v:ident),*]) => {
        impl $t {
            pub const NAME: &'static str = $name;
            pub const fn to_byte(self) -> u8 {
                self as u8
            }
            /// The candidate of `b`: `Unset` for 0, `Unknown` outside the
            /// table.
            pub const fn from_byte(b: u8) -> Result<$t, RulesError> {
                $( if b == $t::$v as u8 { return Ok($t::$v); } )*
                if b == 0 {
                    Err(RulesError::Unset($name))
                } else {
                    Err(RulesError::Unknown { rule: $name, byte: b })
                }
            }
        }
    };
}

rule_bytes!(
    KeepHolderRule,
    "keep_holder",
    [MixedInterleaved, OrbitBalanced]
);
rule_bytes!(FreeCityRule, "free_city", [NoFreeCity, CanonicalHashV1]);
rule_bytes!(CampRule, "camp", [NoCamp, SortKeyDrawV1]);
rule_bytes!(RegionRule, "region", [SortKeyHashV1]);

/// The four rule bytes as an instruction carries them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleBytes {
    pub keep_holder: u8,
    pub free_city: u8,
    pub camp: u8,
    pub region: u8,
}

/// The genesis Free City site of a wide province (candidate
/// `CanonicalHashV1`): `LE64(sha256(FREE_CITY_DOMAIN_WIDE ‖ ring_seed ‖
/// LE64(ring) ‖ LE64(pos))[..8]) mod site_count` over the canonical
/// wedge-0 copy `(ring, pos)` of the coordinate, so every wedge of a ring
/// gets its Free City on the same site (the wide terrain keeps the
/// canonical site order in every wedge, as the legacy terrain does).
/// `0xFF` without a site.
pub fn wide_free_city_site(ring_seed: &[u8; 32], coord: WideCoord, site_count: u8) -> u8 {
    if site_count == 0 {
        return u8::MAX;
    }
    let rp = coord.ring_position();
    let h = sha256(&[
        FREE_CITY_DOMAIN_WIDE,
        ring_seed,
        &rp.ring.to_le_bytes(),
        &rp.pos.to_le_bytes(),
    ]);
    let mut w = [0u8; 8];
    w.copy_from_slice(&h[..8]);
    (u64::from_le_bytes(w) % site_count as u64) as u8
}

/// The beacon region of a wide province (candidate `SortKeyHashV1`):
/// `sha256(REGION_DOMAIN_WIDE ‖ sort key)[0] mod 16`.
pub fn wide_region(coord: WideCoord) -> u8 {
    sha256(&[REGION_DOMAIN_WIDE, &coord.sort_key()])[0] % REGIONS
}

/// The initial camp of a wide province (candidate `SortKeyDrawV1`): the
/// deployed camp kernel's candidate list (passable, not a site, not the
/// centre, not the keep tile) and troop range, drawn with `rng::rand(seed,
/// domain, sort key ‖ LE32(day) ‖ 1)` instead of the `LE32(P) ‖ LE32(Q)`
/// id. `None` without an allowed tile.
pub fn wide_initial_camp(
    ring_seed: &[u8; 32],
    coord: WideCoord,
    terrain: &ProvinceTerrain,
    day: u32,
    keep_tile: Option<u8>,
) -> Option<Camp> {
    wide_camp_draw(ring_seed, coord, terrain, day, keep_tile, true)
}

/// The day's camp check of a wide province (the deployed
/// `camp::place_v2(.., has_holding, initial = false, keep_tile)`, condition
/// for condition): no camp without a holding; one spawns with probability
/// ½ (`below(draw, 2) == 0` under [`CAMP_SPAWN_DOMAIN_WIDE`]); the tile and
/// the troops are the same draws as [`wide_initial_camp`] with the id's
/// last byte 0 (`initial = false`), so a day's spawn and a day's initial
/// camp are distinct draws as deployed. The caller runs it once per day
/// (`Camp::next_check_day`) and never on the deployed `coord_of` `(P, Q)`,
/// which is zero in a wide record.
pub fn wide_daily_camp(
    ring_seed: &[u8; 32],
    coord: WideCoord,
    terrain: &ProvinceTerrain,
    day: u32,
    has_holding: bool,
    keep_tile: Option<u8>,
) -> Option<Camp> {
    if !has_holding {
        return None;
    }
    let id = wide_camp_id(coord, day, false);
    if below(rand(ring_seed, CAMP_SPAWN_DOMAIN_WIDE, &id), 2) != 0 {
        return None;
    }
    wide_camp_draw(ring_seed, coord, terrain, day, keep_tile, false)
}

/// `sort key ‖ LE32(day) ‖ initial`: the wide copy of the deployed camp
/// draw id `LE32(P) ‖ LE32(Q) ‖ LE32(day) ‖ initial`.
fn wide_camp_id(coord: WideCoord, day: u32, initial: bool) -> [u8; 22] {
    let mut id = [0u8; 22];
    id[..17].copy_from_slice(&coord.sort_key());
    id[17..21].copy_from_slice(&day.to_le_bytes());
    id[21] = initial as u8;
    id
}

/// The candidate list and the two draws shared by the initial and the
/// daily camp (the deployed `place_inner` after its spawn gate).
fn wide_camp_draw(
    ring_seed: &[u8; 32],
    coord: WideCoord,
    terrain: &ProvinceTerrain,
    day: u32,
    keep_tile: Option<u8>,
    initial: bool,
) -> Option<Camp> {
    let mut cands = [0u8; PROVINCE_TILES];
    let mut n = 0usize;
    for t in 1..PROVINCE_TILES as u8 {
        if camp_tile_ok(terrain, t) && keep_tile != Some(t) {
            cands[n] = t;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    let id = wide_camp_id(coord, day, initial);
    let k = below(rand(ring_seed, CAMP_TILE_DOMAIN_WIDE, &id), n as u64) as usize;
    let troops = CAMP_TROOPS_MIN
        + below(
            rand(ring_seed, CAMP_TROOPS_DOMAIN_WIDE, &id),
            CAMP_TROOPS_SPREAD as u64 + 1,
        ) as u32;
    Some(Camp {
        tile: cands[k],
        troops,
    })
}

/// The keep of a wide province at opening: `keep::try_open` without the
/// `ProvinceCoord` (every wide ring is ≥ 129 ≥ 2, and no wide province is
/// in a heartland, so `heartland_safe` is false). `Err(TroopsAboveCap)`
/// for a home guard above the cap, `Ok(None)` without a tile.
pub fn wide_keep_open(
    holder: u8,
    tile: u8,
    prm: &KeepParams,
    bell: u32,
) -> Result<Option<Keep>, KeepError> {
    if prm.home_guard > MAX_KEEP_TROOPS {
        return Err(KeepError::TroopsAboveCap);
    }
    if tile as usize >= PROVINCE_TILES {
        return Ok(None);
    }
    Ok(Some(Keep {
        tile,
        holder,
        contender: NO_FACTION,
        progress: 0,
        required: prm.bells,
        heartland_safe: false,
        paused: false,
        changes: 0,
        troops: prm.home_guard,
        since_bell: bell,
        consolidated_until_bell: 0,
        contest_from_bell: 0,
        gen: 0,
        last_taken_from: NO_FACTION,
    }))
}

// ------------------------------------------------------------ the record

/// `wc ‖ hex(0)`: one configuration per Season. Provisional tag.
pub fn rules_config_seed() -> Seed {
    Seed::new(RULES_CONFIG_TAG, &[0u8])
}

/// `with_seed(season, wc00, program)`.
pub fn rules_config_address(ctx: &AddrCtx) -> [u8; 32] {
    ctx.of(&rules_config_seed())
}

/// The experimental rules configuration of one Season's wide world.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideRulesConfig {
    pub season_id: u64,
    pub world: WorldId,
    pub config_version: u16,
    pub keep_holder: KeepHolderRule,
    pub free_city: FreeCityRule,
    pub camp: CampRule,
    pub region: RegionRule,
    /// Who wrote it (the Season's authority).
    pub authority: [u8; 32],
}

/// What one opening gives the configuration to decide from.
#[derive(Clone, Copy, Debug)]
pub struct OpeningInput<'a> {
    pub coord: WideCoord,
    pub genesis_seed: &'a [u8; 32],
    pub ring_seed: &'a [u8; 32],
    pub terrain: &'a ProvinceTerrain,
    pub day: u32,
    /// The keep tile the kernel chose (`None` when it chose none).
    pub keep_tile: Option<u8>,
    /// The season has genesis Free Cities (`free_city_min_ring ≠ 0`).
    pub free_cities: bool,
}

impl WideRulesConfig {
    /// A configuration from the four bytes: every rule a known candidate
    /// (`Unset`, `Unknown` otherwise), version [`WIDE_RULES_CONFIG_VERSION`].
    pub fn new(
        season_id: u64,
        world: WorldId,
        authority: [u8; 32],
        bytes: RuleBytes,
    ) -> Result<WideRulesConfig, RulesError> {
        Ok(WideRulesConfig {
            season_id,
            world,
            config_version: WIDE_RULES_CONFIG_VERSION,
            keep_holder: KeepHolderRule::from_byte(bytes.keep_holder)?,
            free_city: FreeCityRule::from_byte(bytes.free_city)?,
            camp: CampRule::from_byte(bytes.camp)?,
            region: RegionRule::from_byte(bytes.region)?,
            authority,
        })
    }

    /// The four bytes.
    pub const fn bytes(&self) -> RuleBytes {
        RuleBytes {
            keep_holder: self.keep_holder.to_byte(),
            free_city: self.free_city.to_byte(),
            camp: self.camp.to_byte(),
            region: self.region.to_byte(),
        }
    }

    /// The decided rules of one opening under this configuration: a
    /// coordinate past the disk (`NotWide` otherwise); every rule decided
    /// by its candidate.
    pub fn decide(&self, input: &OpeningInput<'_>) -> Result<WideRules, RulesError> {
        let coord = input.coord;
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(RulesError::NotWide { ring });
        }
        let keep_holder = match self.keep_holder {
            KeepHolderRule::MixedInterleaved => mixed_home_nation(coord, input.genesis_seed),
            KeepHolderRule::OrbitBalanced => orbit_balanced_outer_nation(coord, input.genesis_seed),
        }
        .ok_or(RulesError::NotWide { ring })?;
        let site_count = input.terrain.site_count;
        let free_city_site = match self.free_city {
            FreeCityRule::NoFreeCity => None,
            FreeCityRule::CanonicalHashV1 if input.free_cities && site_count > 0 => {
                Some(wide_free_city_site(input.ring_seed, coord, site_count))
            }
            FreeCityRule::CanonicalHashV1 => None,
        };
        let camp = match self.camp {
            CampRule::NoCamp => None,
            CampRule::SortKeyDrawV1 => wide_initial_camp(
                input.ring_seed,
                coord,
                input.terrain,
                input.day,
                input.keep_tile,
            )
            .map(|c| CampDecision {
                tile: c.tile,
                troops: c.troops,
            }),
        };
        let region = match self.region {
            RegionRule::SortKeyHashV1 => wide_region(coord),
        };
        Ok(WideRules {
            keep_holder: Decision::Decided(keep_holder),
            free_city_site: Decision::Decided(free_city_site),
            camp: Decision::Decided(camp),
            region: Decision::Decided(region),
        })
    }

    /// Decodes exactly `rules_config::SIZE` bytes: the magic, this version,
    /// four known candidates, a non-reserved world, zero reserved bytes.
    pub fn read(d: &[u8]) -> Result<WideRulesConfig, RulesError> {
        use rules_config as L;
        if d.len() != L::SIZE {
            return Err(RulesError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = RulesError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(RulesError::Magic);
        }
        let version = rd_u16(d, L::CONFIG_VERSION).ok_or(t)?;
        if version != WIDE_RULES_CONFIG_VERSION {
            return Err(RulesError::Version {
                expected: WIDE_RULES_CONFIG_VERSION,
                got: version,
            });
        }
        land::zero(d, L::RSV_22, 2).map_err(|_| RulesError::Reserved)?;
        land::zero(d, L::RSV, 8).map_err(|_| RulesError::Reserved)?;
        Ok(WideRulesConfig {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?,
            config_version: version,
            keep_holder: KeepHolderRule::from_byte(rd_u8(d, L::KEEP_HOLDER).ok_or(t)?)?,
            free_city: FreeCityRule::from_byte(rd_u8(d, L::FREE_CITY).ok_or(t)?)?,
            camp: CampRule::from_byte(rd_u8(d, L::CAMP).ok_or(t)?)?,
            region: RegionRule::from_byte(rd_u8(d, L::REGION).ok_or(t)?)?,
            authority: rd_arr(d, L::AUTHORITY).ok_or(t)?,
        })
    }

    /// Writes every byte of the record (reserved ranges zeroed).
    pub fn write(&self, d: &mut [u8]) -> Result<(), RulesError> {
        use rules_config as L;
        if d.len() != L::SIZE {
            return Err(RulesError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::CONFIG_VERSION, self.config_version)
            & wr_u8(d, L::KEEP_HOLDER, self.keep_holder.to_byte())
            & wr_u8(d, L::FREE_CITY, self.free_city.to_byte())
            & wr_u8(d, L::CAMP, self.camp.to_byte())
            & wr_u8(d, L::REGION, self.region.to_byte())
            & wr_arr(d, L::RSV_22, &[0u8; 2])
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::AUTHORITY, &self.authority)
            & wr_arr(d, L::RSV, &[0u8; 8]);
        if ok {
            Ok(())
        } else {
            Err(RulesError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Field;
    use crate::world_index::coord::RingPosition;
    use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord, FACTIONS};
    use permutation_rules::frontier::keep::try_open;
    use permutation_rules::frontier::terrain::generate_province;
    use std::vec::Vec;

    const SEED: [u8; 32] = [0x44; 32];
    const GENESIS: [u8; 32] = [0x5e; 32];
    const AUTH: [u8; 32] = [0xaa; 32];

    fn world() -> WorldId {
        WorldId::new([0x77; 32]).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    fn at(ring: u64, wedge: u8, pos: u64) -> WideCoord {
        WideCoord::from_ring_position(RingPosition { ring, wedge, pos }).unwrap()
    }

    fn all() -> WideRulesConfig {
        WideRulesConfig::new(
            11,
            world(),
            AUTH,
            RuleBytes {
                keep_holder: 1,
                free_city: 2,
                camp: 2,
                region: 1,
            },
        )
        .unwrap()
    }

    /// A terrain to decide over: the legacy kernel's bytes of a legacy
    /// coordinate stand in for the wide terrain (the candidates read only
    /// the `ProvinceTerrain`, never the coordinate it came from).
    fn terrain() -> ProvinceTerrain {
        generate_province(&SEED, ProvinceCoord::new(7, 2))
    }

    fn tiles(name: &str, size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{name}.{} starts at {} not {at}", f.name, f.off);
            at += f.len;
        }
        assert_eq!(at, size);
    }

    /// The layout tiles, the magic is new and experimental, the seed tag
    /// is unallocated, the address is one per season.
    #[test]
    fn layout_tag_and_address_are_provisional_and_pinned() {
        tiles("WideRulesConfig", rules_config::SIZE, rules_config::FIELDS);
        assert_eq!(rules_config::SIZE, 96);
        assert_eq!(&rules_config::MAGIC[..4], b"PSFX");
        assert_eq!(
            crate::layout::AccountKind::from_magic(&rules_config::MAGIC),
            None
        );
        assert_eq!(
            crate::v2::layout::AccountKind::from_magic(&rules_config::MAGIC),
            None
        );
        assert_ne!(rules_config::MAGIC, land::ring_seed::MAGIC);
        assert_ne!(rules_config::MAGIC, land::province::MAGIC);
        assert_eq!(WIDE_RULES_CONFIG_VERSION, 1);
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&RULES_CONFIG_TAG),
            None
        );
        assert_eq!(rules_config_seed().as_bytes(), b"wc00");
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        assert_eq!(rules_config_address(&ctx), rules_config_address(&ctx));
        assert_ne!(
            rules_config_address(&ctx),
            land::ring_seed_address(&ctx, 129)
        );
        assert_ne!(rules_config_address(&ctx), ctx.frontier());
        let other = AddrCtx {
            season: [5; 32],
            program: [4; 32],
        };
        assert_ne!(rules_config_address(&ctx), rules_config_address(&other));
    }

    /// Every rule byte must be a candidate: 0 is unset, anything outside
    /// the table is unknown, and a partial configuration is refused whole.
    #[test]
    fn unset_or_unknown_bytes_are_refused_and_nothing_is_a_default() {
        let ok = all();
        assert_eq!(
            ok.bytes(),
            RuleBytes {
                keep_holder: 1,
                free_city: 2,
                camp: 2,
                region: 1
            }
        );
        let base = ok.bytes();
        for (name, set) in [
            (
                "keep_holder",
                (|b: &mut RuleBytes, v| b.keep_holder = v) as fn(&mut RuleBytes, u8),
            ),
            ("free_city", |b, v| b.free_city = v),
            ("camp", |b, v| b.camp = v),
            ("region", |b, v| b.region = v),
        ] {
            let mut b = base;
            set(&mut b, 0);
            assert_eq!(
                WideRulesConfig::new(11, world(), AUTH, b),
                Err(RulesError::Unset(name)),
                "{name} unset"
            );
            let mut b = base;
            set(&mut b, 0xFF);
            assert_eq!(
                WideRulesConfig::new(11, world(), AUTH, b),
                Err(RulesError::Unknown {
                    rule: name,
                    byte: 0xFF
                }),
                "{name} unknown"
            );
        }
        // the table, byte for byte
        assert_eq!(
            KeepHolderRule::from_byte(1),
            Ok(KeepHolderRule::MixedInterleaved)
        );
        assert_eq!(
            KeepHolderRule::from_byte(2),
            Ok(KeepHolderRule::OrbitBalanced)
        );
        assert_eq!(
            KeepHolderRule::from_byte(3),
            Err(RulesError::Unknown {
                rule: "keep_holder",
                byte: 3
            })
        );
        assert_eq!(FreeCityRule::from_byte(1), Ok(FreeCityRule::NoFreeCity));
        assert_eq!(
            FreeCityRule::from_byte(2),
            Ok(FreeCityRule::CanonicalHashV1)
        );
        assert_eq!(CampRule::from_byte(1), Ok(CampRule::NoCamp));
        assert_eq!(CampRule::from_byte(2), Ok(CampRule::SortKeyDrawV1));
        assert_eq!(RegionRule::from_byte(1), Ok(RegionRule::SortKeyHashV1));
        assert_eq!(
            RegionRule::from_byte(2),
            Err(RulesError::Unknown {
                rule: "region",
                byte: 2
            })
        );
        // a zeroed account is no configuration
        let zero = [0u8; rules_config::SIZE];
        assert_eq!(WideRulesConfig::read(&zero), Err(RulesError::Magic));
        let mut d = zero;
        d[..8].copy_from_slice(&rules_config::MAGIC);
        d[rules_config::CONFIG_VERSION] = 1;
        assert!(matches!(
            WideRulesConfig::read(&d),
            Err(RulesError::World(_))
        ));
        d[rules_config::WORLD..rules_config::WORLD + 32].copy_from_slice(world().as_bytes());
        assert_eq!(
            WideRulesConfig::read(&d),
            Err(RulesError::Unset("keep_holder"))
        );
    }

    #[test]
    fn record_round_trips_and_refuses_bad_bytes() {
        let cfg = all();
        let mut d = [0u8; rules_config::SIZE];
        cfg.write(&mut d).unwrap();
        assert_eq!(WideRulesConfig::read(&d), Ok(cfg));
        assert_eq!(
            WideRulesConfig::read(&d[..95]),
            Err(RulesError::Length {
                expected: 96,
                got: 95
            })
        );
        assert_eq!(
            cfg.write(&mut [0u8; 97]),
            Err(RulesError::Length {
                expected: 96,
                got: 97
            })
        );
        let mut x = d;
        x[2] ^= 1;
        assert_eq!(WideRulesConfig::read(&x), Err(RulesError::Magic));
        let mut x = d;
        x[rules_config::CONFIG_VERSION] = 2;
        assert_eq!(
            WideRulesConfig::read(&x),
            Err(RulesError::Version {
                expected: 1,
                got: 2
            })
        );
        for off in [
            rules_config::RSV_22,
            rules_config::RSV_22 + 1,
            rules_config::RSV + 7,
        ] {
            let mut x = d;
            x[off] = 1;
            assert_eq!(
                WideRulesConfig::read(&x),
                Err(RulesError::Reserved),
                "{off}"
            );
        }
        let mut x = d;
        x[rules_config::WORLD..rules_config::WORLD + 32].fill(0);
        assert_eq!(
            WideRulesConfig::read(&x),
            Err(RulesError::World(KeyError::ReservedWorld))
        );
        let mut x = d;
        x[rules_config::CAMP] = 0;
        assert_eq!(WideRulesConfig::read(&x), Err(RulesError::Unset("camp")));
        let mut x = d;
        x[rules_config::FREE_CITY] = 9;
        assert_eq!(
            WideRulesConfig::read(&x),
            Err(RulesError::Unknown {
                rule: "free_city",
                byte: 9
            })
        );
        assert_eq!(
            &d[rules_config::AUTHORITY..rules_config::AUTHORITY + 32],
            &AUTH
        );
    }

    /// Under a full configuration every rule is decided, in range, and
    /// equal to its candidate function; inside the disk nothing is decided.
    #[test]
    fn a_full_configuration_decides_every_rule_from_its_candidate() {
        let t = terrain();
        let cfg = all();
        let input = |coord: WideCoord| OpeningInput {
            coord,
            genesis_seed: &GENESIS,
            ring_seed: &SEED,
            terrain: &t,
            day: 3,
            keep_tile: Some(5),
            free_cities: true,
        };
        for coord in [c(129, 0), c(-129, 129), c(1 << 40, 3), c(1 << 62, 1 << 62)] {
            let r = cfg.decide(&input(coord)).unwrap();
            assert_eq!(r.missing(), 0);
            assert_eq!(
                r.keep_holder,
                Decision::Decided(mixed_home_nation(coord, &GENESIS).unwrap())
            );
            assert_eq!(
                r.free_city_site,
                Decision::Decided(Some(wide_free_city_site(&SEED, coord, t.site_count)))
            );
            let camp = wide_initial_camp(&SEED, coord, &t, 3, Some(5)).unwrap();
            assert_eq!(
                r.camp,
                Decision::Decided(Some(CampDecision {
                    tile: camp.tile,
                    troops: camp.troops
                }))
            );
            assert_eq!(r.region, Decision::Decided(wide_region(coord)));
            // the record model accepts the decision
            let seed = land::WideRingSeed::request(
                world(),
                11,
                coord.ring(),
                land::PreviousRing {
                    ring: coord.ring() - 1,
                    seeded: true,
                    opened_bell: 0,
                },
                1,
                1_800_000_600,
                &permutation_rules::frontier::clash::QUICKNET,
                60,
                [1; 32],
            )
            .unwrap();
            let seeded = seed.seed_with(seed.round, SEED).unwrap();
            assert!(land::WideProvince::open(world(), 11, coord, &seeded, &r, 1, 0).is_ok());
        }
        // the other candidates
        let mut orbit = cfg;
        orbit.keep_holder = KeepHolderRule::OrbitBalanced;
        orbit.free_city = FreeCityRule::NoFreeCity;
        orbit.camp = CampRule::NoCamp;
        let r = orbit.decide(&input(c(129, 0))).unwrap();
        assert_eq!(
            r.keep_holder,
            Decision::Decided(orbit_balanced_outer_nation(c(129, 0), &GENESIS).unwrap())
        );
        assert_eq!(r.free_city_site, Decision::Decided(None));
        assert_eq!(r.camp, Decision::Decided(None));
        // a season without Free Cities gets none on wide land either
        let mut no_fc = input(c(129, 0));
        no_fc.free_cities = false;
        assert_eq!(
            cfg.decide(&no_fc).unwrap().free_city_site,
            Decision::Decided(None)
        );
        // inside the disk no wide rule applies
        for p in ring_provinces(128).into_iter().chain(ring_provinces(0)) {
            let w = c(p.p as i64, p.q as i64);
            assert_eq!(
                cfg.decide(&input(w)),
                Err(RulesError::NotWide {
                    ring: p.ring() as u64
                })
            );
        }
    }

    /// The Free City candidate: a site index below the count, the same on
    /// the six wedges of a ring (the canonical copy), different seeds and
    /// rings differ somewhere, no site gives 0xFF.
    #[test]
    fn free_city_candidate_is_canonical_in_range_and_seed_bound() {
        for ring in [129u64, 130, 300, (1 << 53) + 5] {
            for pos in [0u64, 1, ring / 2, ring - 1] {
                let want = wide_free_city_site(&SEED, at(ring, 0, pos), 7);
                assert!(want < 7);
                for wedge in 1..6u8 {
                    assert_eq!(
                        wide_free_city_site(&SEED, at(ring, wedge, pos), 7),
                        want,
                        "ring {ring} wedge {wedge} pos {pos}"
                    );
                }
            }
        }
        assert_eq!(wide_free_city_site(&SEED, c(129, 0), 0), 0xFF);
        let a: Vec<u8> = (0..129u64)
            .map(|pos| wide_free_city_site(&SEED, at(129, 0, pos), 12))
            .collect();
        let b: Vec<u8> = (0..129u64)
            .map(|pos| wide_free_city_site(&[0x45; 32], at(129, 0, pos), 12))
            .collect();
        assert_ne!(a, b, "bound to the ring seed");
        let mut distinct = a.clone();
        distinct.sort();
        distinct.dedup();
        assert!(distinct.len() > 1, "not a constant");
    }

    /// The region candidate is in `0..16` and not constant; the camp
    /// candidate stands on an allowed tile that is not the keep's, within
    /// the kernel's troop range, deterministic, and absent without a tile.
    #[test]
    fn region_and_camp_candidates_are_in_range_and_deterministic() {
        let mut regions = [false; 16];
        for pos in 0..129u64 {
            let r = wide_region(at(129, 0, pos));
            assert!(r < REGIONS);
            regions[r as usize] = true;
        }
        assert!(
            regions.iter().filter(|x| **x).count() >= 8,
            "a spread of regions"
        );
        let t = terrain();
        for coord in [c(129, 0), c(0, -129), c(1 << 40, -(1 << 41))] {
            for keep in [None, Some(1u8), Some(60)] {
                let camp = wide_initial_camp(&SEED, coord, &t, 0, keep).unwrap();
                assert!(camp_tile_ok(&t, camp.tile), "{coord:?}");
                assert_ne!(Some(camp.tile), keep);
                assert!(!t.is_site(camp.tile));
                assert!(
                    (CAMP_TROOPS_MIN..=CAMP_TROOPS_MIN + CAMP_TROOPS_SPREAD).contains(&camp.troops)
                );
                assert_eq!(wide_initial_camp(&SEED, coord, &t, 0, keep), Some(camp));
            }
        }
        // the day and the seed enter the draw (equality on one day is
        // possible by chance; over 32 days it is not)
        let day0 = wide_initial_camp(&SEED, c(129, 0), &t, 0, None);
        assert!((1..32u32).any(|d| wide_initial_camp(&SEED, c(129, 0), &t, d, None) != day0));
        assert!((0..32u8).any(|s| wide_initial_camp(&[s; 32], c(129, 0), &t, 0, None) != day0));
        // no allowed tile: a terrain that is all water but the centre
        let mut water = t.clone();
        for i in 1..PROVINCE_TILES {
            water.terrain[i] = permutation_rules::map::Terrain::Water;
        }
        assert_eq!(wide_initial_camp(&SEED, c(129, 0), &water, 0, None), None);
    }

    /// The daily check keeps the deployed `place_v2(.., initial = false)`
    /// conditions: nothing without a holding, a ½ spawn gate, the keep tile
    /// excluded, the deployed troop range, and a draw distinct from the
    /// day's initial camp.
    #[test]
    fn wide_daily_camp_keeps_the_deployed_spawn_conditions() {
        let t = generate_province(&SEED, ProvinceCoord::new(129, 0));
        let coord = c(129, 0);
        // without a holding there is never a camp, whatever the draw
        for day in 0..64u32 {
            assert_eq!(wide_daily_camp(&SEED, coord, &t, day, false, None), None);
        }
        // with one, some days spawn and some do not; a spawn is a valid camp
        let mut spawned = 0u32;
        for day in 0..64u32 {
            let keep = Some(5u8);
            let r = wide_daily_camp(&SEED, coord, &t, day, true, keep);
            // deterministic
            assert_eq!(wide_daily_camp(&SEED, coord, &t, day, true, keep), r);
            if let Some(camp) = r {
                spawned += 1;
                assert!(camp_tile_ok(&t, camp.tile), "{day}");
                assert_ne!(Some(camp.tile), keep);
                assert!(
                    (CAMP_TROOPS_MIN..=CAMP_TROOPS_MIN + CAMP_TROOPS_SPREAD).contains(&camp.troops)
                );
                // the spawn draw's gate is the deployed one over the wide id
                let id = wide_camp_id(coord, day, false);
                assert_eq!(below(rand(&SEED, CAMP_SPAWN_DOMAIN_WIDE, &id), 2), 0);
            } else {
                let id = wide_camp_id(coord, day, false);
                assert_eq!(below(rand(&SEED, CAMP_SPAWN_DOMAIN_WIDE, &id), 2), 1);
            }
        }
        assert!(spawned > 0 && spawned < 64, "{spawned}");
        // the day's spawn is not the day's initial camp (the id's last byte
        // differs); over 64 days the two draws disagree somewhere
        assert!((0..64u32).any(|d| {
            matches!(
                (
                    wide_daily_camp(&SEED, coord, &t, d, true, None),
                    wide_initial_camp(&SEED, coord, &t, d, None),
                ),
                (Some(a), Some(b)) if a != b
            )
        }));
        // the initial draw is unchanged by the shared body
        assert_eq!(wide_initial_camp(&SEED, coord, &t, 3, Some(5)), {
            let id = wide_camp_id(coord, 3, true);
            assert_eq!(id[21], 1);
            let mut cands = Vec::new();
            for tile in 1..PROVINCE_TILES as u8 {
                if camp_tile_ok(&t, tile) && tile != 5 {
                    cands.push(tile);
                }
            }
            let k = below(rand(&SEED, CAMP_TILE_DOMAIN_WIDE, &id), cands.len() as u64) as usize;
            Some(Camp {
                tile: cands[k],
                troops: CAMP_TROOPS_MIN
                    + below(
                        rand(&SEED, CAMP_TROOPS_DOMAIN_WIDE, &id),
                        CAMP_TROOPS_SPREAD as u64 + 1,
                    ) as u32,
            })
        });
        // no allowed tile: no spawn even when the gate opens
        let mut water = t.clone();
        for i in 1..PROVINCE_TILES {
            water.terrain[i] = permutation_rules::map::Terrain::Water;
        }
        for day in 0..64u32 {
            assert_eq!(wide_daily_camp(&SEED, coord, &water, day, true, None), None);
        }
    }

    /// The wide keep opening is the kernel's `try_open` wherever both
    /// exist (a ring outside the heartland), field for field, and refuses
    /// the same cap.
    #[test]
    fn wide_keep_open_is_try_open_outside_the_heartland() {
        let prm = KeepParams::DEFAULT;
        for holder in 0..FACTIONS {
            for tile in [0u8, 5, 60] {
                let legacy = try_open(ProvinceCoord::new(7, 0), holder, 3, tile, &prm, 9).unwrap();
                assert_eq!(
                    wide_keep_open(holder, tile, &prm, 9),
                    Ok(legacy),
                    "{holder} {tile}"
                );
                assert!(!legacy.unwrap().heartland_safe);
            }
        }
        assert_eq!(wide_keep_open(0, 61, &prm, 9), Ok(None));
        assert_eq!(wide_keep_open(0, 0xFF, &prm, 9), Ok(None));
        let mut big = prm;
        big.home_guard = MAX_KEEP_TROOPS + 1;
        assert_eq!(
            wide_keep_open(0, 5, &big, 9),
            Err(KeepError::TroopsAboveCap)
        );
        assert_eq!(
            try_open(ProvinceCoord::new(7, 0), 0, 3, 5, &big, 9),
            Err(KeepError::TroopsAboveCap)
        );
    }
}
