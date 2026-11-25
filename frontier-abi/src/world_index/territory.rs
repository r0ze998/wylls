//! **Player territory on wide land** (owner decisions 2026-11-24 12:09 JST,
//! t506s1577: T-1 … T-8; design note `docs/design/expansion/02-player-territory.md`).
//!
//! | decision | here |
//! |---|---|
//! | T-1 the unit is **one tile** | [`TerritoryProvince`]: one owner per tile of a wide province (61), by Citizen tag |
//! | T-2 reach also from teammates' villages, anywhere; exclaves OK | [`ReachSource`]: the first home, a wide province that is the nation's land (`reach::is_nation_land`: a nation-mate's or own village, a won keep), or a province where the claimer already owns a tile |
//! | T-3 instant claim in ore, cost rises with holdings, 1 per turn, first tx wins | [`judge_claim`] over [`TerritoryParams`] (`permutation_rules::frontier::territory`), the summary's per-bell counter; the tile's owner field is the race |
//! | T-4 upkeep in food from the home village, 990 milli-food/h per tile + 480 milli-food/h per tile per province of distance beyond 3 (the decided 2 food/h per province + 1 food/h per province of distance ÷ 61 tiles, ×30 by Q-CUF-1 (b); [`TERRITORY_V1`]) | [`TerritoryPlayer::upkeep_per_hour`] (count × flat + Σ distance excess × per_distance), [`settle_upkeep`] charging the home holding |
//! | T-5 unpaid: claims stop; after 24 turns the farthest land returns, one step per turn | [`settle_upkeep`] takes what the home holds on a short turn and marks `unpaid_since` (Q-LP17-1 (b), r0ze 2026-11-25 21:22); [`may_decay`] + the distance histogram name the farthest bucket |
//! | T-7 others' land only by conquest | a claim of an owned tile is `Owned`; only [`transfer_tile`] (conquest) moves a tile between players |
//!
//! **Numbers are config.** The rule a world plays is one byte, the
//! [`TerritoryRule`] candidate stored in each wide province's trailer at
//! opening (copied from the Season's experimental rules configuration,
//! `rules::KeepHolderRule::territory`). [`TerritoryRule::V1`]'s numbers
//! ([`TERRITORY_V1`]) are **decided** (owner answers 2026-11-24 13:15 JST to
//! inbox `2026-11-24-1225-territory-impl-questions.md`, TQ-1 … TQ-8); a later
//! change is a new candidate byte (one exception: Q-LP17-1 (b) changed V1).
//!
//! **Records.** Both are new with-seed accounts under provisional tags; no
//! existing layout changes.
//!
//! | record | bytes | address | holds |
//! |---|---|---|---|
//! | [`TerritoryProvince`] | 672 | `wn ‖ hash(sort key)` | the 61 tile owners (Citizen tags, 0 = nobody), each owned tile's distance in provinces to its owner's nearest village when claimed, the count |
//! | [`TerritoryPlayer`] | 320 | `wu ‖ hash(citizen)` | the per-player summary upkeep needs without reading every tile: tile count, Σ distance excess, a 64-bucket distance histogram (the farthest bucket for decay), the upkeep clock and its sub-unit remainder, unpaid-since, the per-bell claim counter, the last decay bell |
//!
//! Pure; the program (`proc::wide_territory`) is the only writer.

use super::coord::{WideCoord, SORT_KEY_LEN};
use super::key::WorldId;
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{
    rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u16, wr_u32, wr_u64, wr_u8,
};
use permutation_rules::fixed::Milli;
use permutation_rules::frontier::geometry::PROVINCE_TILES;
use permutation_rules::frontier::territory::{
    self as kt, ClaimCheck, ClaimCost, ClaimRefusal, DecayOrder, Nearest, ReachRule, TargetOwner,
    TerritoryParams, UnpaidRule, UpkeepCurve, SRC_HOME, SRC_NATION_LAND, SRC_OWN,
};
use permutation_rules::hash::sha256;

/// Version of the territory record family. Bump on any stored meaning change.
pub const TERRITORY_FAMILY_VERSION: u16 = 1;
/// Seed tag of a territory province record (**provisional**).
pub const PROVINCE_TAG: [u8; 2] = *b"wn";
/// Seed tag of a territory player summary (**provisional**).
pub const PLAYER_TAG: [u8; 2] = *b"wu";
pub const PROVINCE_SEED_DOMAIN: &[u8] = b"PSF-WIDE-TERRITORY-PROVINCE-v1";
pub const PLAYER_SEED_DOMAIN: &[u8] = b"PSF-WIDE-TERRITORY-PLAYER-v1";
/// Distance buckets of the summary's histogram; a distance ≥ 63 provinces
/// shares the last bucket.
pub const HIST_BUCKETS: usize = 64;
/// "No bell" in the summary's bell fields.
pub const NO_BELL: u32 = u32::MAX;
/// Seconds per upkeep hour.
const HOUR: i128 = 3_600;
/// One turn (bell): `prologue::bell_at` is ⌊(t − genesis) / 600⌋.
const TURN_SECS: i128 = 600;

// ------------------------------------------------------------ the rule

/// The territory rule a world plays (set with keep-holder byte 18 = 4,
/// copied into every wide province's trailer byte `RSV_53`). Byte 0 = no
/// territory: every territory instruction refuses `NotImplemented` and
/// wide villages keep #206's rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TerritoryRule {
    /// The 12:09 decisions with the decided (13:15) numbers of [`TERRITORY_V1`].
    V1 = 1,
}

impl TerritoryRule {
    pub const fn from_byte(b: u8) -> Option<Option<TerritoryRule>> {
        match b {
            0 => Some(None),
            1 => Some(Some(TerritoryRule::V1)),
            _ => None,
        }
    }

    pub const fn to_byte(self) -> u8 {
        self as u8
    }

    pub const fn params(self) -> &'static TerritoryV1 {
        match self {
            TerritoryRule::V1 => &TERRITORY_V1,
        }
    }
}

/// One rule's numbers: the kernel's [`TerritoryParams`] plus which
/// resource pays what. Units: claim cost in whole resource units, upkeep in
/// milli-units per hour per tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerritoryV1 {
    pub kernel: TerritoryParams,
    /// The resource a claim burns (index into the holding's stores).
    pub cost_resource: u8,
    /// The resource upkeep takes from the home village.
    pub upkeep_resource: u8,
}

/// The numbers of [`TerritoryRule::V1`] (**decided** 2026-11-24 13:15, TQ-1 … TQ-5):
///
/// - upkeep (T-4, TQ-1 (a); **×30** by Q-CUF-1 (b), owner 2026-11-25
///   12:04, replacing the ×10 of Q-LP15-1 (b) 09:33): 990 milli-food/h per
///   tile (30 × the decided 33 = the owner's 2 food/h per province ÷ 61
///   tiles rounded up; a whole province 60.39 food/h), plus 480
///   milli-food/h per tile per province beyond 3 (30 × the decided 16 = 1
///   food/h per province ÷ 61 rounded down); the same formula and
///   rounding, every number thirty times. The distance is
///   province steps from the tile's province to the owner's nearest OWN
///   village (home included), fixed at the claim (TQ-2);
/// - cost (T-3, TQ-3): 10 ore + 2 % per tile owned;
/// - reach (T-2, TQ-4): within 3 provinces of the home, of a province that
///   is the nation's land (own or teammates' villages, keeps the nation
///   won), or of a province where the claimer owns a tile;
/// - pace: 1 claim per turn (bell); owned tiles never claimable (T-7);
/// - unpaid (T-5, TQ-5): claims blocked at once; after 24 turns one tile per
///   turn returns, the farthest first.
pub const TERRITORY_V1: TerritoryV1 = TerritoryV1 {
    kernel: TerritoryParams {
        upkeep: UpkeepCurve {
            flat: 990,
            per_rank: 0,
            per_distance: 480,
            free_distance: 3,
        },
        cost: ClaimCost {
            base: 10,
            per_owned_bps: 200,
        },
        reach: ReachRule {
            range: 3,
            sources: SRC_HOME | SRC_OWN | SRC_NATION_LAND,
        },
        claims_per_turn: 1,
        claim_owned: false,
        unpaid: UnpaidRule {
            block_claims: true,
            production_bps: 10_000,
            decay_after_bells: Some(24),
            decay_every_bells: 1,
        },
        decay_order: DecayOrder::Farthest,
    },
    cost_resource: 3,   // Ore
    upkeep_resource: 0, // Food
};

// ------------------------------------------------------------ errors

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerritoryError {
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
    /// A stored field outside its range (count, tile, rule byte, histogram).
    Corrupt,
    /// The record belongs to another world, coordinate or Citizen.
    Mismatch,
    /// A tile index past the province.
    BadTile,
    /// The tile is the keep's tile (never a player's: the keep holder's).
    KeepTile,
    Claim(ClaimRefusal),
    /// No territory change applies (decay not due, nothing to transfer).
    NotDue,
    /// The named tile is not in the farthest distance bucket.
    NotFarthest,
    /// The tile is not owned by the expected Citizen.
    NotOwner,
    Overflow,
}

// ------------------------------------------------------------ addresses

pub fn province_seed(coord: WideCoord) -> Seed {
    let h = sha256(&[PROVINCE_SEED_DOMAIN, &coord.sort_key()]);
    Seed::new(PROVINCE_TAG, &h[..15])
}

pub fn province_address(ctx: &AddrCtx, coord: WideCoord) -> [u8; 32] {
    ctx.of(&province_seed(coord))
}

pub fn player_seed(citizen: &[u8; 32]) -> Seed {
    let h = sha256(&[PLAYER_SEED_DOMAIN, citizen]);
    Seed::new(PLAYER_TAG, &h[..15])
}

pub fn player_address(ctx: &AddrCtx, citizen: &[u8; 32]) -> [u8; 32] {
    ctx.of(&player_seed(citizen))
}

// ------------------------------------------------------------ province record

/// The territory province record (672 B). **Provisional magic.**
pub mod territory_province {
    crate::layout::fields!(size = 672;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RULE @ 18 : "u8" = 1;
        OWNED @ 19 : "u8" = 1;
        WORLD @ 20 : "[u8;32]" = 32;
        SORT_KEY @ 52 : "[u8;17]" = 17;
        KEEP_TILE @ 69 : "u8" = 1;
        RSV_70 @ 70 : "rsv" = 2;
        RENT_PAYER @ 72 : "[u8;32]" = 32;
        OWNER @ 104 : "[u64;61]" = 488;
        DIST @ 592 : "[u8;61]" = 61;
        RSV @ 653 : "rsv" = 19;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWTN1";
}

/// The 61 tile owners of one wide province.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerritoryProvince {
    pub season_id: u64,
    pub rule: TerritoryRule,
    pub world: WorldId,
    pub coord: WideCoord,
    /// The keep's tile (`NO_TILE` 0xFF when the province has none).
    pub keep_tile: u8,
    pub rent_payer: [u8; 32],
    /// Citizen tag of each tile's owner; 0 = nobody.
    pub owner: [u64; PROVINCE_TILES],
    /// Each owned tile's distance (provinces, saturating) to its owner's
    /// nearest village at the claim; 0 for an unowned tile.
    pub dist: [u8; PROVINCE_TILES],
}

impl TerritoryProvince {
    pub fn new(
        season_id: u64,
        rule: TerritoryRule,
        world: WorldId,
        coord: WideCoord,
        keep_tile: u8,
        rent_payer: [u8; 32],
    ) -> Self {
        TerritoryProvince {
            season_id,
            rule,
            world,
            coord,
            keep_tile,
            rent_payer,
            owner: [0; PROVINCE_TILES],
            dist: [0; PROVINCE_TILES],
        }
    }

    pub fn owned(&self) -> u8 {
        self.owner.iter().filter(|o| **o != 0).count() as u8
    }

    /// Tiles `tag` owns here.
    pub fn owned_by(&self, tag: u64) -> u32 {
        if tag == 0 {
            return 0;
        }
        self.owner.iter().filter(|o| **o == tag).count() as u32
    }

    pub fn read(d: &[u8]) -> Result<TerritoryProvince, TerritoryError> {
        use territory_province as L;
        if d.len() != L::SIZE {
            return Err(TerritoryError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let c = TerritoryError::Corrupt;
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(c)? != L::MAGIC {
            return Err(TerritoryError::Magic);
        }
        let v = rd_u16(d, L::FAMILY_VERSION).ok_or(c)?;
        if v != TERRITORY_FAMILY_VERSION {
            return Err(TerritoryError::Version {
                expected: TERRITORY_FAMILY_VERSION,
                got: v,
            });
        }
        let rule = TerritoryRule::from_byte(rd_u8(d, L::RULE).ok_or(c)?)
            .flatten()
            .ok_or(c)?;
        if d[L::RSV_70..L::RSV_70 + 2].iter().any(|b| *b != 0)
            || d[L::RSV..L::SIZE].iter().any(|b| *b != 0)
        {
            return Err(TerritoryError::Reserved);
        }
        let key: [u8; SORT_KEY_LEN] = rd_arr(d, L::SORT_KEY).ok_or(c)?;
        let coord = WideCoord::from_sort_key(&key).map_err(|_| c)?;
        let mut owner = [0u64; PROVINCE_TILES];
        let mut dist = [0u8; PROVINCE_TILES];
        for i in 0..PROVINCE_TILES {
            owner[i] = rd_u64(d, L::OWNER + 8 * i).ok_or(c)?;
            dist[i] = rd_u8(d, L::DIST + i).ok_or(c)?;
            if owner[i] == 0 && dist[i] != 0 {
                return Err(c);
            }
        }
        let keep_tile = rd_u8(d, L::KEEP_TILE).ok_or(c)?;
        if (keep_tile as usize) < PROVINCE_TILES && owner[keep_tile as usize] != 0 {
            return Err(c);
        }
        let rec = TerritoryProvince {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(c)?,
            rule,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(c)?).map_err(|_| c)?,
            coord,
            keep_tile,
            rent_payer: rd_arr(d, L::RENT_PAYER).ok_or(c)?,
            owner,
            dist,
        };
        if rd_u8(d, L::OWNED).ok_or(c)? != rec.owned() {
            return Err(c);
        }
        Ok(rec)
    }

    pub fn write(&self, d: &mut [u8]) -> Result<(), TerritoryError> {
        use territory_province as L;
        if d.len() != L::SIZE {
            return Err(TerritoryError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let mut ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, TERRITORY_FAMILY_VERSION)
            & wr_u8(d, L::RULE, self.rule.to_byte())
            & wr_u8(d, L::OWNED, self.owned())
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.coord.sort_key())
            & wr_u8(d, L::KEEP_TILE, self.keep_tile)
            & wr_arr(d, L::RSV_70, &[0u8; 2])
            & wr_arr(d, L::RENT_PAYER, &self.rent_payer);
        for i in 0..PROVINCE_TILES {
            ok &= wr_u64(d, L::OWNER + 8 * i, self.owner[i]) & wr_u8(d, L::DIST + i, self.dist[i]);
        }
        d[L::RSV..L::SIZE].fill(0);
        if ok {
            Ok(())
        } else {
            Err(TerritoryError::Corrupt)
        }
    }
}

// ------------------------------------------------------------ player summary

/// The territory player summary (320 B). **Provisional magic.**
pub mod territory_player {
    crate::layout::fields!(size = 320;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RULE @ 18 : "u8" = 1;
        UNPAID @ 19 : "u8" = 1;
        WORLD @ 20 : "[u8;32]" = 32;
        CITIZEN @ 52 : "[u8;32]" = 32;
        CITIZEN_TAG @ 84 : "u64" = 8;
        TILES @ 92 : "u32" = 4;
        EXCESS_SUM @ 96 : "u64" = 8;
        PAID_TO @ 104 : "i64" = 8;
        REMAINDER @ 112 : "u64" = 8;
        UNPAID_SINCE @ 120 : "u32" = 4;
        LAST_CLAIM_BELL @ 124 : "u32" = 4;
        CLAIMS_IN_BELL @ 128 : "u8" = 1;
        FACTION @ 129 : "u8" = 1;
        RSV_130 @ 130 : "rsv" = 2;
        LAST_DECAY_BELL @ 132 : "u32" = 4;
        RELEASED @ 136 : "u32" = 4;
        CLAIMED @ 140 : "u32" = 4;
        RENT_PAYER @ 144 : "[u8;32]" = 32;
        HIST @ 176 : "[u16;64]" = 128;
        RSV @ 304 : "rsv" = 16;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWTU1";
}

/// What upkeep and decay need of one player's territory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerritoryPlayer {
    pub season_id: u64,
    pub rule: TerritoryRule,
    pub world: WorldId,
    pub citizen: [u8; 32],
    pub citizen_tag: u64,
    /// The Citizen's nation (fixed at join): who counts as a teammate (T-8).
    pub faction: u8,
    pub tiles: u32,
    /// Σ over owned tiles of `max(0, dist − free_distance)`.
    pub excess_sum: u64,
    /// Upkeep is settled up to this second.
    pub paid_to: i64,
    /// Milli-unit·seconds owed below one milli-unit (carried, so settling
    /// often never makes upkeep cheaper).
    pub remainder: u64,
    /// The bell upkeep first went unpaid; `None` = paid.
    pub unpaid_since: Option<u32>,
    pub last_claim_bell: u32,
    pub claims_in_bell: u8,
    pub last_decay_bell: u32,
    /// Tiles lost to decay or conquest, ever.
    pub released: u32,
    /// Tiles claimed, ever.
    pub claimed: u32,
    pub rent_payer: [u8; 32],
    /// Owned tiles per distance bucket (`min(dist, 63)`).
    pub hist: [u16; HIST_BUCKETS],
}

impl TerritoryPlayer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        season_id: u64,
        rule: TerritoryRule,
        world: WorldId,
        citizen: [u8; 32],
        citizen_tag: u64,
        faction: u8,
        now_ts: i64,
        rent_payer: [u8; 32],
    ) -> Self {
        TerritoryPlayer {
            season_id,
            rule,
            world,
            citizen,
            citizen_tag,
            faction,
            tiles: 0,
            excess_sum: 0,
            paid_to: now_ts,
            remainder: 0,
            unpaid_since: None,
            last_claim_bell: NO_BELL,
            claims_in_bell: 0,
            last_decay_bell: NO_BELL,
            released: 0,
            claimed: 0,
            rent_payer,
            hist: [0; HIST_BUCKETS],
        }
    }

    /// Upkeep per hour (milli-units) of the territory as it stands:
    /// `tiles × flat + per_rank × tiles(tiles−1)/2 + per_distance × Σ excess`
    /// (the kernel's `upkeep_per_hour` over the same tiles; pinned by test).
    pub fn upkeep_per_hour(&self) -> Option<Milli> {
        let c = &self.rule.params().kernel.upkeep;
        let n = self.tiles as i128;
        let v = c.flat as i128 * n
            + c.per_rank as i128 * (n * (n - 1).max(0) / 2)
            + c.per_distance as i128 * self.excess_sum as i128;
        (0..=kt::MAX_TERRITORY_UPKEEP_PER_HOUR as i128)
            .contains(&v)
            .then_some(v as Milli)
    }

    /// The farthest occupied distance bucket.
    pub fn farthest_bucket(&self) -> Option<usize> {
        (0..HIST_BUCKETS).rev().find(|b| self.hist[*b] > 0)
    }

    fn excess(&self, dist: u8) -> u64 {
        (dist as u32).saturating_sub(self.rule.params().kernel.upkeep.free_distance) as u64
    }

    /// Counts one more tile at `dist`.
    pub fn add_tile(&mut self, dist: u8) -> Result<(), TerritoryError> {
        let b = (dist as usize).min(HIST_BUCKETS - 1);
        self.hist[b] = self.hist[b]
            .checked_add(1)
            .ok_or(TerritoryError::Overflow)?;
        self.tiles = self.tiles.checked_add(1).ok_or(TerritoryError::Overflow)?;
        self.excess_sum = self
            .excess_sum
            .checked_add(self.excess(dist))
            .ok_or(TerritoryError::Overflow)?;
        Ok(())
    }

    /// Counts one tile at `dist` less.
    pub fn remove_tile(&mut self, dist: u8) -> Result<(), TerritoryError> {
        let b = (dist as usize).min(HIST_BUCKETS - 1);
        self.hist[b] = self.hist[b].checked_sub(1).ok_or(TerritoryError::Corrupt)?;
        self.tiles = self.tiles.checked_sub(1).ok_or(TerritoryError::Corrupt)?;
        self.excess_sum = self
            .excess_sum
            .checked_sub(self.excess(dist))
            .ok_or(TerritoryError::Corrupt)?;
        Ok(())
    }

    pub fn read(d: &[u8]) -> Result<TerritoryPlayer, TerritoryError> {
        use territory_player as L;
        if d.len() != L::SIZE {
            return Err(TerritoryError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let c = TerritoryError::Corrupt;
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(c)? != L::MAGIC {
            return Err(TerritoryError::Magic);
        }
        let v = rd_u16(d, L::FAMILY_VERSION).ok_or(c)?;
        if v != TERRITORY_FAMILY_VERSION {
            return Err(TerritoryError::Version {
                expected: TERRITORY_FAMILY_VERSION,
                got: v,
            });
        }
        let rule = TerritoryRule::from_byte(rd_u8(d, L::RULE).ok_or(c)?)
            .flatten()
            .ok_or(c)?;
        if d[L::RSV_130..L::RSV_130 + 2].iter().any(|b| *b != 0)
            || d[L::RSV..L::SIZE].iter().any(|b| *b != 0)
        {
            return Err(TerritoryError::Reserved);
        }
        let unpaid = match rd_u8(d, L::UNPAID).ok_or(c)? {
            0 => None,
            1 => Some(rd_u32(d, L::UNPAID_SINCE).ok_or(c)?),
            _ => return Err(c),
        };
        let mut hist = [0u16; HIST_BUCKETS];
        let mut sum = 0u32;
        for (i, h) in hist.iter_mut().enumerate() {
            *h = rd_u16(d, L::HIST + 2 * i).ok_or(c)?;
            sum += *h as u32;
        }
        let rec = TerritoryPlayer {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(c)?,
            rule,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(c)?).map_err(|_| c)?,
            citizen: rd_arr(d, L::CITIZEN).ok_or(c)?,
            citizen_tag: rd_u64(d, L::CITIZEN_TAG).ok_or(c)?,
            faction: rd_u8(d, L::FACTION).ok_or(c)?,
            tiles: rd_u32(d, L::TILES).ok_or(c)?,
            excess_sum: rd_u64(d, L::EXCESS_SUM).ok_or(c)?,
            paid_to: rd_i64(d, L::PAID_TO).ok_or(c)?,
            remainder: rd_u64(d, L::REMAINDER).ok_or(c)?,
            unpaid_since: unpaid,
            last_claim_bell: rd_u32(d, L::LAST_CLAIM_BELL).ok_or(c)?,
            claims_in_bell: rd_u8(d, L::CLAIMS_IN_BELL).ok_or(c)?,
            last_decay_bell: rd_u32(d, L::LAST_DECAY_BELL).ok_or(c)?,
            released: rd_u32(d, L::RELEASED).ok_or(c)?,
            claimed: rd_u32(d, L::CLAIMED).ok_or(c)?,
            rent_payer: rd_arr(d, L::RENT_PAYER).ok_or(c)?,
            hist,
        };
        if sum != rec.tiles || rec.citizen_tag == 0 || rec.remainder >= HOUR as u64 {
            return Err(c);
        }
        Ok(rec)
    }

    pub fn write(&self, d: &mut [u8]) -> Result<(), TerritoryError> {
        use territory_player as L;
        if d.len() != L::SIZE {
            return Err(TerritoryError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let mut ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, TERRITORY_FAMILY_VERSION)
            & wr_u8(d, L::RULE, self.rule.to_byte())
            & wr_u8(d, L::UNPAID, self.unpaid_since.is_some() as u8)
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::CITIZEN, &self.citizen)
            & wr_u64(d, L::CITIZEN_TAG, self.citizen_tag)
            & wr_u32(d, L::TILES, self.tiles)
            & wr_u64(d, L::EXCESS_SUM, self.excess_sum)
            & wr_i64(d, L::PAID_TO, self.paid_to)
            & wr_u64(d, L::REMAINDER, self.remainder)
            & wr_u32(d, L::UNPAID_SINCE, self.unpaid_since.unwrap_or(0))
            & wr_u32(d, L::LAST_CLAIM_BELL, self.last_claim_bell)
            & wr_u8(d, L::CLAIMS_IN_BELL, self.claims_in_bell)
            & wr_u8(d, L::FACTION, self.faction)
            & wr_arr(d, L::RSV_130, &[0u8; 2])
            & wr_u32(d, L::LAST_DECAY_BELL, self.last_decay_bell)
            & wr_u32(d, L::RELEASED, self.released)
            & wr_u32(d, L::CLAIMED, self.claimed)
            & wr_arr(d, L::RENT_PAYER, &self.rent_payer);
        for (i, h) in self.hist.iter().enumerate() {
            ok &= wr_u16(d, L::HIST + 2 * i, *h);
        }
        d[L::RSV..L::SIZE].fill(0);
        if ok {
            Ok(())
        } else {
            Err(TerritoryError::Corrupt)
        }
    }
}

// ------------------------------------------------------------ upkeep

/// What one settle of upkeep did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpkeepSettle {
    /// Milli-units of the upkeep resource to take from the home village
    /// (when unpaid: what the store holds, at most the owed amount —
    /// Q-LP17-1 (b)).
    pub charge: Milli,
    /// The settle could pay.
    pub paid: bool,
}

/// Settles upkeep from `paid_to` to `now_ts` against `available`
/// milli-units of the upkeep resource in the home village (settled to
/// now). When the store covers the owed amount (with the carried
/// remainder) — and, while unpaid, one turn's upkeep too — it is charged
/// and upkeep is paid. Otherwise **what the store holds is taken** (at most
/// the owed amount), the rest of the period is forgiven (TQ-11 / VQ-5: no
/// debt), and upkeep stays unpaid since the first bell it fell short (T-5).
/// The clock always moves to `now_ts`.
///
/// **Q-LP17-1 option (b)**, decided by r0ze 2026-11-25 21:22 (shipped before world 3
/// as devnet upgrade #3): before it the shortfall turn took
/// nothing, so the next turn's production alone (one turn of a village's
/// food) paid a whole turn again and cleared `unpaid_since`; a territory
/// whose upkeep was up to ~23× its village's food never stayed unpaid for
/// the 24-turn grace and never decayed (loop-play17: 73 tiles at 1.8× the
/// food, released 0 in 120 turns). Taking the store on a short turn leaves
/// the next turn only that turn's production, so the counter keeps running
/// while upkeep exceeds the food and the land shrinks to what the food
/// supports.
pub fn settle_upkeep(
    pl: &mut TerritoryPlayer,
    now_ts: i64,
    now_bell: u32,
    available: Milli,
) -> Result<UpkeepSettle, TerritoryError> {
    let rate = pl.upkeep_per_hour().ok_or(TerritoryError::Overflow)? as i128;
    let dt = (now_ts as i128 - pl.paid_to as i128).max(0);
    let owed_ms = rate
        .checked_mul(dt)
        .and_then(|v| v.checked_add(pl.remainder as i128))
        .ok_or(TerritoryError::Overflow)?;
    let charge = owed_ms / HOUR;
    let rem = (owed_ms % HOUR) as u64;
    let charge = Milli::try_from(charge).map_err(|_| TerritoryError::Overflow)?;
    pl.paid_to = pl.paid_to.max(now_ts);
    // While unpaid, the store must hold at least one turn's upkeep (a bell,
    // 600 s, at the current rate) besides covering this period before the
    // player counts as paying again. Without it a second settle in the same
    // second (nothing owed: charge 0) cleared `unpaid_since` from an empty
    // store, so settle + claim in one transaction claimed while unpaid and
    // two settles every < 24 bells kept the land from ever decaying
    // (verify-pr206-209). The missed food stays forgiven (TQ-11 default).
    let need = if pl.unpaid_since.is_some() {
        let turn = rate
            .checked_mul(TURN_SECS)
            .map(|v| (v + HOUR - 1) / HOUR)
            .ok_or(TerritoryError::Overflow)?;
        let turn = Milli::try_from(turn).map_err(|_| TerritoryError::Overflow)?;
        charge.max(turn)
    } else {
        charge
    };
    if need <= available.max(0) {
        pl.remainder = rem;
        pl.unpaid_since = None;
        Ok(UpkeepSettle { charge, paid: true })
    } else {
        // Q-LP17-1 (b): take what is there (never more than is owed). The
        // sub-unit remainder is kept only when the whole period was taken
        // (still unpaid then only for the one-turn reserve).
        let have = available.max(0);
        let take = charge.min(have);
        pl.remainder = if take == charge { rem } else { 0 };
        if pl.unpaid_since.is_none() {
            pl.unpaid_since = Some(now_bell);
        }
        Ok(UpkeepSettle {
            charge: take,
            paid: false,
        })
    }
}

// ------------------------------------------------------------ claims

/// Where the claimer's reach is measured from (T-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReachSource {
    /// The claimer's first home (heartland), its coordinate.
    Home(WideCoord),
    /// A wide province that is the claimer's nation's land.
    NationLand(WideCoord),
    /// A wide province where the claimer owns a tile.
    Own(WideCoord),
}

/// Everything a tile claim is judged on.
#[derive(Clone, Copy, Debug)]
pub struct TileClaim<'a> {
    pub province: &'a TerritoryProvince,
    pub tile: u8,
    pub claimer: &'a TerritoryPlayer,
    pub home: WideCoord,
    pub witness: Option<ReachSource>,
    /// Distance (provinces) from the target to the claimer's nearest
    /// village the caller authenticated (TQ-2: fixed at the claim).
    pub village_distance: u128,
    pub now_bell: u32,
    /// The claim resource the home village holds (whole units).
    pub balance: u64,
}

/// The judged claim: the ore to burn and the tile's stored distance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimOk {
    pub cost: u64,
    pub dist: u8,
}

/// The kernel's judgement over one tile (upkeep already settled into
/// `claimer.unpaid_since`).
pub fn judge_claim(c: &TileClaim<'_>) -> Result<ClaimOk, TerritoryError> {
    let prm = &c.claimer.rule.params().kernel;
    if c.tile as usize >= PROVINCE_TILES {
        return Err(TerritoryError::BadTile);
    }
    if c.tile == c.province.keep_tile {
        return Err(TerritoryError::KeepTile);
    }
    let target = c.province.coord;
    let o = c.province.owner[c.tile as usize];
    let owner = if o == 0 {
        TargetOwner::Nobody
    } else if o == c.claimer.citizen_tag {
        TargetOwner::Claimer
    } else {
        TargetOwner::Other
    };
    let d = |x: WideCoord| u32::try_from(x.distance(target)).unwrap_or(u32::MAX);
    let mut nearest = Nearest {
        home: Some(d(c.home)),
        ..Nearest::default()
    };
    match c.witness {
        None => {}
        Some(ReachSource::Home(h)) => nearest.home = Some(d(h)),
        Some(ReachSource::NationLand(w)) => nearest.nation_land = Some(d(w)),
        Some(ReachSource::Own(w)) => nearest.own = Some(d(w)),
    }
    let turn = if c.claimer.last_claim_bell == c.now_bell {
        c.claimer.claims_in_bell
    } else {
        0
    };
    let cost = kt::may_claim(
        prm,
        &ClaimCheck {
            open: true,
            owner,
            nearest,
            owned: c.claimer.tiles,
            claims_this_turn: turn,
            upkeep_unpaid: c.claimer.unpaid_since.is_some(),
            balance: c.balance,
        },
    )
    .map_err(TerritoryError::Claim)?;
    Ok(ClaimOk {
        cost,
        dist: u8::try_from(c.village_distance).unwrap_or(u8::MAX),
    })
}

/// Applies a judged claim to both records.
pub fn apply_claim(
    prov: &mut TerritoryProvince,
    pl: &mut TerritoryPlayer,
    tile: u8,
    ok: ClaimOk,
    now_bell: u32,
) -> Result<(), TerritoryError> {
    let i = tile as usize;
    if i >= PROVINCE_TILES || prov.owner[i] != 0 {
        return Err(TerritoryError::Claim(ClaimRefusal::Owned));
    }
    pl.add_tile(ok.dist)?;
    prov.owner[i] = pl.citizen_tag;
    prov.dist[i] = ok.dist;
    if pl.last_claim_bell == now_bell {
        pl.claims_in_bell = pl.claims_in_bell.saturating_add(1);
    } else {
        pl.last_claim_bell = now_bell;
        pl.claims_in_bell = 1;
    }
    pl.claimed = pl.claimed.saturating_add(1);
    Ok(())
}

// ------------------------------------------------------------ villages (T-6)

/// Tiles: two sites of one province this close or closer are **neighbours**
/// (the terrain places sites ≥ 2 apart, so a site 2–3 tiles away has no site
/// between). TQ-6 (b), owner 2026-11-24 13:15: "at least one free site
/// between villages" — a village may not stand on a site with a village on
/// a neighbouring site. (The radius is this run's reading of "between";
/// sites of another province are not counted: report territory-impl.)
pub const SITE_NEIGHBOUR_TILES: u32 = 3;

/// Whether founding a village on `site` breaks TQ-6 (b): `sites` lists the
/// province's sites as `(tile, has a village)`.
pub fn site_crowded(site: u8, sites: &[(u8, bool)]) -> bool {
    use permutation_rules::frontier::geometry::tile_offset;
    let Some(&(t, _)) = sites.get(site as usize) else {
        return true;
    };
    let Some(a) = tile_offset(t) else { return true };
    sites.iter().enumerate().any(|(j, (u, held))| {
        j != site as usize
            && *held
            && tile_offset(*u).is_some_and(|b| a.distance(b) <= SITE_NEIGHBOUR_TILES)
    })
}

// ------------------------------------------------------------ decay

/// Whether one tile may return to unowned at `now_bell` (T-5): upkeep
/// unpaid for the grace, and no decay yet this bell (one step per turn).
pub fn may_decay(pl: &TerritoryPlayer, now_bell: u32) -> bool {
    let prm = &pl.rule.params().kernel.unpaid;
    let eff = kt::unpaid_effect(prm, pl.unpaid_since, now_bell);
    let every = prm.decay_every_bells.max(1);
    eff.cells_released > 0
        && pl.tiles > 0
        && (pl.last_decay_bell == NO_BELL || now_bell >= pl.last_decay_bell.saturating_add(every))
}

/// Releases `tile` of `prov` from `pl` by decay: it must be `pl`'s and in
/// its farthest bucket (ties: any tile of that bucket).
pub fn apply_decay(
    prov: &mut TerritoryProvince,
    pl: &mut TerritoryPlayer,
    tile: u8,
    now_bell: u32,
) -> Result<(), TerritoryError> {
    if !may_decay(pl, now_bell) {
        return Err(TerritoryError::NotDue);
    }
    let i = tile as usize;
    if i >= PROVINCE_TILES {
        return Err(TerritoryError::BadTile);
    }
    if prov.owner[i] != pl.citizen_tag {
        return Err(TerritoryError::NotOwner);
    }
    let b = (prov.dist[i] as usize).min(HIST_BUCKETS - 1);
    if pl.farthest_bucket() != Some(b) {
        return Err(TerritoryError::NotFarthest);
    }
    pl.remove_tile(prov.dist[i])?;
    prov.owner[i] = 0;
    prov.dist[i] = 0;
    pl.last_decay_bell = now_bell;
    pl.released = pl.released.saturating_add(1);
    Ok(())
}

// ------------------------------------------------------------ conquest

/// Moves every tile `from` owns in `prov` to `to` (T-8: a captured keep
/// transfers its province), except the tiles in `village_tiles`: a tile
/// with a village on it stays with its village (TQ-7: the village's tile
/// moves with the village; capturing a keep does not take villages;
/// verify-pr206-209). The captor's distance for each moved tile is
/// `to_dist`. Returns the number moved; `NotDue` when `from` owns none
/// here outside its villages.
pub fn transfer_tiles(
    prov: &mut TerritoryProvince,
    from: &mut TerritoryPlayer,
    to: &mut TerritoryPlayer,
    to_dist: u8,
    village_tiles: &[u8],
) -> Result<u32, TerritoryError> {
    if from.citizen_tag == to.citizen_tag {
        return Err(TerritoryError::Mismatch);
    }
    let mut n = 0u32;
    for i in 0..PROVINCE_TILES {
        if prov.owner[i] == from.citizen_tag && !village_tiles.contains(&(i as u8)) {
            from.remove_tile(prov.dist[i])?;
            to.add_tile(to_dist)?;
            prov.owner[i] = to.citizen_tag;
            prov.dist[i] = to_dist;
            n += 1;
        }
    }
    if n == 0 {
        return Err(TerritoryError::NotDue);
    }
    from.released = from.released.saturating_add(n);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::key::WorldId;
    use alloc::vec::Vec;

    fn world() -> WorldId {
        WorldId::new([7u8; 32]).unwrap()
    }

    fn coord(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    fn player(tag: u64) -> TerritoryPlayer {
        TerritoryPlayer::new(
            9,
            TerritoryRule::V1,
            world(),
            [tag as u8; 32],
            tag,
            1,
            1_000,
            [1; 32],
        )
    }

    fn prov() -> TerritoryProvince {
        TerritoryProvince::new(9, TerritoryRule::V1, world(), coord(130, 0), 30, [2; 32])
    }

    fn claim<'a>(
        p: &'a TerritoryProvince,
        pl: &'a TerritoryPlayer,
        tile: u8,
        witness: Option<ReachSource>,
        bell: u32,
    ) -> TileClaim<'a> {
        TileClaim {
            province: p,
            tile,
            claimer: pl,
            home: coord(128, 0),
            witness,
            village_distance: 2,
            now_bell: bell,
            balance: 1_000,
        }
    }

    #[test]
    fn records_round_trip_and_refuse_corruption() {
        let mut p = prov();
        let mut pl = player(77);
        let ok = judge_claim(&claim(&p, &pl, 5, None, 10)).unwrap();
        apply_claim(&mut p, &mut pl, 5, ok, 10).unwrap();
        let mut d = alloc::vec![0u8; territory_province::SIZE];
        p.write(&mut d).unwrap();
        assert_eq!(TerritoryProvince::read(&d).unwrap(), p);
        let mut e = alloc::vec![0u8; territory_player::SIZE];
        pl.write(&mut e).unwrap();
        assert_eq!(TerritoryPlayer::read(&e).unwrap(), pl);
        // the count byte must match the owners
        let mut x = d.clone();
        x[territory_province::OWNED] = 2;
        assert_eq!(TerritoryProvince::read(&x), Err(TerritoryError::Corrupt));
        // a reserved byte
        let mut x = d.clone();
        x[territory_province::RSV] = 1;
        assert_eq!(TerritoryProvince::read(&x), Err(TerritoryError::Reserved));
        // the histogram must sum to the tiles
        let mut y = e.clone();
        y[territory_player::TILES] = 2;
        assert_eq!(TerritoryPlayer::read(&y), Err(TerritoryError::Corrupt));
        // an unknown rule byte
        let mut y = e.clone();
        y[territory_player::RULE] = 9;
        assert_eq!(TerritoryPlayer::read(&y), Err(TerritoryError::Corrupt));
        // addresses differ by tag and key
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        assert_ne!(
            province_address(&ctx, coord(130, 0)),
            province_address(&ctx, coord(131, 0))
        );
        assert_ne!(
            player_address(&ctx, &[1; 32]),
            province_address(&ctx, coord(130, 0))
        );
    }

    #[test]
    fn v1_upkeep_is_the_owner_numbers_per_tile() {
        // 61 tiles near home: 61 × 990 = 60,390 milli-food/h ≈ 60 food/h per
        // province (Q-CUF-1 (b): ×30 the decided 61 × 33 = 2,013).
        let mut pl = player(1);
        for _ in 0..61 {
            pl.add_tile(2).unwrap();
        }
        assert_eq!(pl.upkeep_per_hour(), Some(60_390));
        // the same 61 tiles 5 provinces away: + 61 × 480 × 2 = 58,560 (≈ 2 × 30 food/h).
        let mut far = player(2);
        for _ in 0..61 {
            far.add_tile(5).unwrap();
        }
        assert_eq!(far.upkeep_per_hour(), Some(60_390 + 58_560));
        // equal to the kernel's per-cell sum over the same distances
        let dists: Vec<u32> = (0..61).map(|_| 5).collect();
        assert_eq!(
            kt::upkeep_per_hour(&TERRITORY_V1.kernel.upkeep, &dists),
            far.upkeep_per_hour()
        );
    }

    #[test]
    fn claim_refusals_follow_the_decisions() {
        let mut p = prov();
        let mut pl = player(5);
        // keep tile
        assert_eq!(
            judge_claim(&claim(&p, &pl, 30, None, 1)),
            Err(TerritoryError::KeepTile)
        );
        // out of reach of the home (130 vs home 128 is 2: fine) — move home far
        let mut far = claim(&p, &pl, 1, None, 1);
        far.home = coord(120, 0);
        assert_eq!(
            judge_claim(&far),
            Err(TerritoryError::Claim(ClaimRefusal::Range))
        );
        // a teammate village (nation land) far from home gives reach (T-2)
        far.witness = Some(ReachSource::NationLand(coord(131, 0)));
        assert!(judge_claim(&far).is_ok());
        // first claim OK, cost 10
        let ok = judge_claim(&claim(&p, &pl, 1, None, 1)).unwrap();
        assert_eq!(ok, ClaimOk { cost: 10, dist: 2 });
        apply_claim(&mut p, &mut pl, 1, ok, 1).unwrap();
        // same bell again: TurnLimit (1 per turn)
        assert_eq!(
            judge_claim(&claim(&p, &pl, 2, None, 1)),
            Err(TerritoryError::Claim(ClaimRefusal::TurnLimit))
        );
        // already yours
        assert_eq!(
            judge_claim(&claim(&p, &pl, 1, None, 2)),
            Err(TerritoryError::Claim(ClaimRefusal::AlreadyYours))
        );
        // next bell: cost rises 2 % per tile owned (10 + 10 × 1 × 2 % = 10.2 → 10)
        let ok2 = judge_claim(&claim(&p, &pl, 2, None, 2)).unwrap();
        assert_eq!(ok2.cost, 10);
        // another player cannot claim an owned tile (T-7): first tx wins
        let other = player(6);
        assert_eq!(
            judge_claim(&claim(&p, &other, 1, None, 2)),
            Err(TerritoryError::Claim(ClaimRefusal::Owned))
        );
        // unpaid upkeep blocks claims (T-5)
        let mut late = pl.clone();
        late.unpaid_since = Some(1);
        assert_eq!(
            judge_claim(&claim(&p, &late, 3, None, 3)),
            Err(TerritoryError::Claim(ClaimRefusal::UpkeepUnpaid))
        );
        // not enough ore
        let mut poor = claim(&p, &pl, 3, None, 3);
        poor.balance = 9;
        assert_eq!(
            judge_claim(&poor),
            Err(TerritoryError::Claim(ClaimRefusal::Insufficient))
        );
        // cost after 100 tiles: 10 + 10 × 100 × 2 % = 30
        let mut big = pl.clone();
        for _ in 0..99 {
            big.add_tile(2).unwrap();
        }
        assert_eq!(big.tiles, 100);
        assert_eq!(judge_claim(&claim(&p, &big, 3, None, 9)).unwrap().cost, 30);
    }

    #[test]
    fn upkeep_settles_exactly_and_takes_what_is_there_when_short() {
        let mut pl = player(3);
        // one tile: 990 milli/h (Q-CUF-1 ×30; ×1 thirty tiles made 990)
        pl.add_tile(0).unwrap();
        // 990 milli/h; 100 s → 27.5 milli, remainder carried
        let s = settle_upkeep(&mut pl, 1_100, 1, 1_000_000).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 27,
                paid: true
            }
        );
        // settling every 100 s for an hour totals exactly 990
        let mut total = s.charge;
        for k in 2..=36 {
            total += settle_upkeep(&mut pl, 1_000 + 100 * k, 1, 1_000_000)
                .unwrap()
                .charge;
        }
        assert_eq!(total, 990);
        // short of food: what the store holds is taken (Q-LP17-1 (b)),
        // unpaid since this bell
        let s = settle_upkeep(&mut pl, 1_000 + 3_600 * 2, 7, 10).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 10,
                paid: false
            }
        );
        assert_eq!(pl.unpaid_since, Some(7));
        // still short later: since stays the first bell
        settle_upkeep(&mut pl, 1_000 + 3_600 * 3, 9, 0).unwrap();
        assert_eq!(pl.unpaid_since, Some(7));
        // a second settle in the same second owes nothing, but an empty
        // store does not make the player paying again (verify-pr206-209)
        let s = settle_upkeep(&mut pl, 1_000 + 3_600 * 3, 9, 0).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 0,
                paid: false
            }
        );
        assert_eq!(pl.unpaid_since, Some(7));
        // nor does a store below one turn's upkeep (990 milli/h → 165 a turn)
        let s = settle_upkeep(&mut pl, 1_000 + 3_600 * 3 + 1, 9, 164).unwrap();
        assert!(!s.paid);
        assert_eq!(pl.unpaid_since, Some(7));
        let s = settle_upkeep(&mut pl, 1_000 + 3_600 * 3 + 1, 9, 165).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 0,
                paid: true
            }
        );
        assert_eq!(pl.unpaid_since, None);
        pl.unpaid_since = Some(7);
        pl.paid_to = 1_000 + 3_600 * 3;
        // paid again clears it
        let s = settle_upkeep(&mut pl, 1_000 + 3_600 * 4, 12, 1_000_000).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 990,
                paid: true
            }
        );
        assert_eq!(pl.unpaid_since, None);
    }

    #[test]
    fn a_short_turn_takes_the_store_and_the_next_turn_alone_does_not_clear_it() {
        // Q-LP17-1 (b). 73 tiles: 72,270 milli-food/h, 12,045 a turn.
        let mut pl = player(5);
        for _ in 0..73 {
            pl.add_tile(1).unwrap();
        }
        // a turn short: the 5,000 in store are taken, unpaid since bell 1
        let s = settle_upkeep(&mut pl, 1_600, 1, 5_000).unwrap();
        assert_eq!(
            s,
            UpkeepSettle {
                charge: 5_000,
                paid: false
            }
        );
        assert_eq!((pl.unpaid_since, pl.remainder), (Some(1), 0));
        // the next turn the store holds only that turn's food (40 food/h →
        // 6,666): taken, still unpaid since bell 1 (before: nothing taken,
        // and 6,666 + the earlier 5,000 ≥ one turn cleared it)
        let s = settle_upkeep(&mut pl, 2_200, 2, 6_666).unwrap();
        assert_eq!((s.charge, s.paid, pl.unpaid_since), (6_666, false, Some(1)));
        // a negative store reads as empty: nothing taken
        let s = settle_upkeep(&mut pl, 2_800, 3, -5).unwrap();
        assert_eq!((s.charge, s.paid), (0, false));
        // a whole turn paid ends it
        let s = settle_upkeep(&mut pl, 3_400, 4, 1_000_000).unwrap();
        assert_eq!((s.charge, s.paid, pl.unpaid_since), (12_045, true, None));
        // never more than is owed: owed 0 in the same second, reserve short
        pl.unpaid_since = Some(4);
        let s = settle_upkeep(&mut pl, 3_400, 4, 7_000).unwrap();
        assert_eq!((s.charge, s.paid), (0, false));
    }

    /// The loop-play17 case end to end in the pure kernel: a village making
    /// 40 food/h (the starting village) holding 73 tiles near home (upkeep
    /// 72.27 food/h, 1.8× its food), settled once a turn (the keeper's
    /// default `territory_settle_bells` 1) with a decay attempt after each
    /// settle. Under the old all-or-nothing settle the territory flipped
    /// unpaid → paid every other turn and released nothing (loop-play17:
    /// released 0 in 120 turns). Under Q-LP17-1 (b) it stays unpaid from the
    /// first short turn, tiles return one a turn from 24 turns later, and the
    /// land settles at what the food supports: 40 tiles (39.6 food/h).
    #[test]
    fn seventy_three_tiles_at_1_8x_food_release_after_24_unpaid_turns() {
        const FOOD_PER_HOUR: i128 = 40_000; // milli
        let mut provs = [
            TerritoryProvince::new(9, TerritoryRule::V1, world(), coord(130, 0), 30, [2; 32]),
            TerritoryProvince::new(9, TerritoryRule::V1, world(), coord(131, 0), 30, [3; 32]),
        ];
        let mut pl = player(6);
        let mut n = 0;
        'fill: for p in provs.iter_mut() {
            for t in 0..PROVINCE_TILES as u8 {
                if n == 73 {
                    break 'fill;
                }
                if t == p.keep_tile {
                    continue;
                }
                // distances 0..=3: no excess, the flat 990 a tile
                let ok = ClaimOk {
                    cost: 0,
                    dist: (n % 4) as u8,
                };
                apply_claim(p, &mut pl, t, ok, 0).unwrap();
                n += 1;
            }
        }
        assert_eq!(pl.tiles, 73);
        assert_eq!(pl.upkeep_per_hour(), Some(72_270));
        // the store: 510 food at the start (loop-play17's barn), the
        // village's food accrued exactly, minus every charge
        let start: i128 = 510_000;
        let mut charged: i128 = 0;
        let mut first_unpaid = None;
        let mut releases = Vec::new();
        let mut paid_again = Vec::new();
        for bell in 1..=200u32 {
            let ts = 1_000 + 600 * bell as i64;
            let made = FOOD_PER_HOUR * (ts as i128 - 1_000) / HOUR;
            let store = start + made - charged;
            let s = settle_upkeep(&mut pl, ts, bell, store as Milli).unwrap();
            assert!(
                s.charge as i128 <= store.max(0),
                "never more than the store"
            );
            charged += s.charge as i128;
            if first_unpaid.is_none() && pl.unpaid_since.is_some() {
                first_unpaid = Some(bell);
            }
            if first_unpaid.is_some() && pl.unpaid_since.is_none() {
                paid_again.push(bell);
            }
            if may_decay(&pl, bell) {
                let b = pl.farthest_bucket().unwrap() as u8;
                let (pi, t) = provs
                    .iter()
                    .enumerate()
                    .find_map(|(pi, p)| {
                        (0..PROVINCE_TILES)
                            .find(|&i| p.owner[i] == pl.citizen_tag && p.dist[i] == b)
                            .map(|i| (pi, i as u8))
                    })
                    .unwrap();
                apply_decay(&mut provs[pi], &mut pl, t, bell).unwrap();
                releases.push(bell);
            }
        }
        let since = first_unpaid.expect("73 tiles at 1.8x food go unpaid");
        // the 510 food carry it a while: 510 / (72.27 − 40) h ≈ 15.8 h = 94 turns
        assert_eq!(since, 95);
        // the first tile returns 24 turns after it went unpaid, then one a
        // turn, every turn, until the food carries the rest
        assert_eq!(releases.first(), Some(&(since + 24)));
        for w in releases.windows(2) {
            assert_eq!(w[1], w[0] + 1, "one tile a turn, no gap");
        }
        assert_eq!(pl.tiles, 40, "settles at what 40 food/h supports");
        assert_eq!(pl.released, 33);
        assert_eq!(releases.len(), 33);
        assert_eq!(pl.unpaid_since, None, "paid again once it fits");
        // no flip-flop: from the first short turn it stays unpaid until the
        // last tile it cannot carry is gone, then stays paid
        let last = *releases.last().unwrap();
        assert_eq!(paid_again.first(), Some(&(last + 1)));
        assert_eq!(paid_again.len() as u32, 200 - last);
        // the farthest first: every tile left is at distance ≤ the last released
        assert!(pl.upkeep_per_hour().unwrap() <= 40_000);
    }

    #[test]
    fn decay_takes_the_farthest_one_tile_per_turn_after_24() {
        let mut p = prov();
        let mut pl = player(4);
        for (t, d) in [(1u8, 2u8), (2, 9), (3, 9), (4, 1)] {
            let ok = ClaimOk { cost: 0, dist: d };
            apply_claim(&mut p, &mut pl, t, ok, t as u32).unwrap();
        }
        pl.unpaid_since = Some(100);
        assert!(!may_decay(&pl, 123));
        assert_eq!(
            apply_decay(&mut p, &mut pl, 2, 123),
            Err(TerritoryError::NotDue)
        );
        assert!(may_decay(&pl, 124));
        // not the farthest
        assert_eq!(
            apply_decay(&mut p, &mut pl, 1, 124),
            Err(TerritoryError::NotFarthest)
        );
        apply_decay(&mut p, &mut pl, 2, 124).unwrap();
        assert_eq!(p.owner[2], 0);
        // one per turn
        assert_eq!(
            apply_decay(&mut p, &mut pl, 3, 124),
            Err(TerritoryError::NotDue)
        );
        apply_decay(&mut p, &mut pl, 3, 125).unwrap();
        // now the farthest is distance 2
        assert_eq!(
            apply_decay(&mut p, &mut pl, 4, 126),
            Err(TerritoryError::NotFarthest)
        );
        apply_decay(&mut p, &mut pl, 1, 126).unwrap();
        assert_eq!(pl.tiles, 1);
        assert_eq!(pl.released, 3);
        // paid: no decay
        pl.unpaid_since = None;
        assert!(!may_decay(&pl, 200));
    }

    #[test]
    fn conquest_moves_only_the_losers_tiles() {
        let mut p = prov();
        let mut a = player(10);
        let mut b = player(11);
        let mut c = player(12);
        for t in [1u8, 2, 3] {
            apply_claim(&mut p, &mut a, t, ClaimOk { cost: 0, dist: 6 }, t as u32).unwrap();
        }
        apply_claim(&mut p, &mut c, 9, ClaimOk { cost: 0, dist: 1 }, 1).unwrap();
        apply_claim(&mut p, &mut a, 4, ClaimOk { cost: 0, dist: 6 }, 4).unwrap();
        // tile 4 carries a village of `a`: it stays with the village
        assert_eq!(transfer_tiles(&mut p, &mut a, &mut b, 0, &[4, 9]), Ok(3));
        assert_eq!(p.owned_by(11), 3);
        assert_eq!(p.owned_by(12), 1);
        assert_eq!(p.owned_by(10), 1);
        assert_eq!((a.tiles, b.tiles, b.excess_sum), (1, 3, 0));
        assert_eq!(
            transfer_tiles(&mut p, &mut a, &mut b, 0, &[4]),
            Err(TerritoryError::NotDue)
        );
        let mut b2 = b.clone();
        assert_eq!(
            transfer_tiles(&mut p, &mut b, &mut b2, 0, &[]),
            Err(TerritoryError::Mismatch)
        );
    }

    /// Parity pins with the page's copy (`permutation-server/web/frontier/flocalplay-territory.mjs`, checked by
    /// `permutation-gateway/test/web-frontier-territory-claim.test.mjs` against the same literals).
    #[test]
    fn seeds_and_wire_are_pinned_for_the_page_copy() {
        assert_eq!(
            province_seed(coord(130, 0)).as_bytes(),
            b"wna7ca105a668a517c0fbe0bb3149f25"
        );
        assert_eq!(
            player_seed(&[1u8; 32]).as_bytes(),
            b"wuca297c5a8f581acf1f8ebc6fda812b"
        );
        let x = crate::world_index::wide_ix::ClaimTile {
            p: 130,
            q: -2,
            tile: 17,
            witness: 2,
            village: 0,
        };
        let mut want = alloc::vec![0xDAu8, 0xFF, 0x01, 0x07];
        want.extend_from_slice(&130i64.to_le_bytes());
        want.extend_from_slice(&(-2i64).to_le_bytes());
        want.extend_from_slice(&[17, 2, 0]);
        assert_eq!(x.to_bytes().to_vec(), want);
        assert_eq!(
            crate::world_index::wide_ix::WideCommand::decode(&want).map(|c| c.name()),
            Ok("WideClaimTile")
        );
        // the page's V1 helpers: cost at 100 tiles, one tile at distance 8
        assert_eq!(kt::claim_cost(&TERRITORY_V1.kernel.cost, 100), Some(30));
        assert_eq!(
            kt::cell_upkeep(&TERRITORY_V1.kernel.upkeep, 0, 8),
            Some(3_390)
        );
    }

    /// TQ-6 (b): a held site within 3 tiles crowds a new village; a farther
    /// one or a free one does not.
    #[test]
    fn a_village_needs_a_free_site_between() {
        use permutation_rules::frontier::geometry::{tile_index, tile_offset};
        let at = |q: i32, r: i32| tile_index(permutation_rules::hex::Hex::new(q, r)).unwrap();
        let (a, near, far) = (at(0, 0), at(2, 0), at(4, -1));
        assert_eq!(
            tile_offset(a).unwrap().distance(tile_offset(near).unwrap()),
            2
        );
        assert!(tile_offset(a).unwrap().distance(tile_offset(far).unwrap()) > 3);
        assert!(site_crowded(0, &[(a, false), (near, true)]));
        assert!(!site_crowded(0, &[(a, false), (near, false), (far, true)]));
        assert!(site_crowded(5, &[(a, false)]), "no such site");
    }
}
