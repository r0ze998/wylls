//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! per-bell clash records of a wide destination, keyed by the full
//! province key and naming every arrival by its full host reference.
//!
//! The deployed records (`layout::clash`) are `ArrivalSlot` (160 B, `ar ‖
//! P, Q, bell, faction, i`, a `u64` host id and a `u64` citizen tag) and
//! `ClashInputs` (1,280 B, `ci ‖ P, Q, bell`, 24 × 40-byte arrival records
//! with `u64` host ids). No wide province has an `i16` pair or a dense
//! host id, so the wide records carry the 50-byte destination key, the
//! 56-byte host reference and the 32-byte Citizen key instead, with the
//! same per-arrival facts (unit, stance, tile, retreat, mass, doctrine
//! multiplier, evidence, beneficiary, rent payer), the same quota (4 per
//! faction, 24 positions), the same flags and the same fate codes. They
//! are the inputs a wide gather builds a `WideClashInput` from and the
//! outputs a wide resolve writes fates into; their addresses are with-seed
//! addresses under provisional tags (`wa`, `wi`), never a deployed kind.
//!
//! **Invariants every reader and writer enforces.** A record's host is a
//! strict [`WideHostRef`] (the camp and the keep are tagged combat
//! identities, `march::WideCombatant`, and never arrive) of the **same
//! world** as the destination; every typed field is in range (faction
//! below 6, slot below 4, a known unit and stance, a tile below 61, a
//! retreat ratio at most `RETREAT_MAX_BPS`, a known fate code); the
//! ClashInputs header is read and checked (magic, version, reserved bytes,
//! a decodable destination key) before any position of it is read or
//! written. A host's reference keeps its **home** province: an arrival's
//! host is normally of another province than the destination.
//!
//! **The beacon binds the bell, not the region** (see `world_index::seal`):
//! these records name the destination; the anchor a wide gather or resolve
//! reads must be THE anchor of the destination's region and bell at its
//! canonical address, with the combat seed `S(A)` taken from it.
//!
//! **No handler writes or reads them yet.** The wide reveal, gather,
//! resolve and settle that would are not implemented (`WIDE-LAND-WRITER.md`
//! §−2.4); the records are the versioned layouts those stages must share.
//! The rent of a wide record (288 and 3,008 bytes against 160 and 1,280)
//! is an explicit, experimental storage cost and no deployed fee changes.

use super::key::{KeyError, ProvinceKey, WideHostRef, WorldId, HOST_REF_LEN};
use super::land::WIDE_LAND_FAMILY_VERSION;
use super::march::{WideCombatant, WideFighter};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use crate::entry::unit_from_u8;
use permutation_rules::frontier::clash::{Fate, FACTION_ARRIVAL_SLOTS, RETREAT_MAX_BPS};
use permutation_rules::frontier::geometry::PROVINCE_TILES;
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::hash::sha256;

/// Seed tag of a wide ArrivalSlot (**provisional**; not a kernel `SeedKind`).
pub const ARRIVAL_SLOT_TAG: [u8; 2] = *b"wa";
pub const ARRIVAL_SLOT_SEED_DOMAIN: &[u8] = b"PSF-WIDE-ARRIVAL-SLOT-SEED-v1";
/// Seed tag of a wide ClashInputs (**provisional**).
pub const CLASH_INPUTS_TAG: [u8; 2] = *b"wi";
pub const CLASH_INPUTS_SEED_DOMAIN: &[u8] = b"PSF-WIDE-CLASH-INPUTS-SEED-v1";

/// The wide ArrivalSlot (288 B). **Provisional magic.**
pub mod wide_arrival_slot {
    crate::layout::fields!(size = 288;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        FLAGS @ 18 : "u8" = 1;
        FACTION @ 19 : "u8" = 1;
        I @ 20 : "u8" = 1;
        UNIT @ 21 : "u8" = 1;
        STANCE @ 22 : "u8" = 1;
        TILE @ 23 : "u8" = 1;
        RETREAT_BPS @ 24 : "u16" = 2;
        DEALT_BPS @ 26 : "u16" = 2;
        TRANSIT_SLOT @ 28 : "u8" = 1;
        RSV_29 @ 29 : "rsv" = 3;
        BELL @ 32 : "u32" = 4;
        RSV_36 @ 36 : "rsv" = 4;
        WORLD @ 40 : "[u8;32]" = 32;
        SORT_KEY @ 72 : "[u8;17]" = 17;
        RSV_89 @ 89 : "rsv" = 7;
        HOST @ 96 : "[u8;56]" = 56;
        CITIZEN @ 152 : "[u8;32]" = 32;
        DEP_MASS @ 184 : "u32" = 4;
        RSV_188 @ 188 : "rsv" = 4;
        BENEFICIARY @ 192 : "[u8;32]" = 32;
        RENT_TO @ 224 : "[u8;32]" = 32;
        EV_SLOT @ 256 : "u64" = 8;
        EV_PRICE @ 264 : "u64" = 8;
        EV_LIMIT @ 272 : "u32" = 4;
        EV_LOADED @ 276 : "u32" = 4;
        CLAIMED @ 280 : "u8" = 1;
        RSV @ 281 : "rsv" = 7;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWASL";
    /// Settled but kept open for a defence claim (the deployed meaning).
    pub const FLAG_SETTLED: u8 = 1;
    /// The reveal that wrote this slot also created the day record.
    pub const FLAG_CREATED_DAY: u8 = 2;
    /// Every flag a slot may carry.
    pub const FLAGS_MASK: u8 = FLAG_SETTLED | FLAG_CREATED_DAY;
    pub const RETREAT_NEVER: u16 = 0;
    /// Transit slots a holding has (the deployed `TRANSIT_N`); a slot's
    /// `transit_slot` is below it.
    pub const TRANSIT_SLOTS: u8 = 4;
}

/// The wide ArrivalDay (144 B): one bit per bell of a game day of a wide
/// destination, set by the reveal that wrote the day's first slot of that
/// bell. **The arrival evidence a resolve and a gather authenticate**: at
/// its canonical address ([`arrival_day_address`]) the record is absent
/// exactly when no reveal of that day reached the province, as the
/// deployed `ArrivalDay`; a set bit means arrivals exist for the bell and
/// a resolve of that bell must take the fully gathered ClashInputs. The
/// absence of a *ClashInputs* alone is never read as "no arrivals".
/// **Provisional magic.** No event chain.
pub mod wide_arrival_day {
    crate::layout::fields!(size = 144;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        RSV_18 @ 18 : "rsv" = 6;
        DAY @ 24 : "u32" = 4;
        RSV_28 @ 28 : "rsv" = 4;
        WORLD @ 32 : "[u8;32]" = 32;
        SORT_KEY @ 64 : "[u8;17]" = 17;
        RSV_81 @ 81 : "rsv" = 7;
        BITS @ 88 : "[u8;18]" = 18;
        RSV_106 @ 106 : "rsv" = 6;
        RENT_TO @ 112 : "[u8;32]" = 32;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWADY";
    /// Bells per game day (the deployed `BELLS_PER_DAY`).
    pub const BELLS: u32 = crate::layout::clash::BELLS_PER_DAY;

    /// `(byte offset, mask)` of bell `b`'s bit.
    pub const fn bit(b: u32) -> (usize, u8) {
        let i = (b % BELLS) as usize;
        (BITS + i / 8, 1u8 << (i % 8))
    }
}

/// Seed tag of a wide ArrivalDay (**provisional**).
pub const ARRIVAL_DAY_TAG: [u8; 2] = *b"wd";
pub const ARRIVAL_DAY_SEED_DOMAIN: &[u8] = b"PSF-WIDE-ARRIVAL-DAY-SEED-v1";

/// The day of a bell (the deployed `addr::day_of`).
pub const fn day_of(bell: u32) -> u32 {
    bell / wide_arrival_day::BELLS
}

/// `wd ‖ hex(sha256(domain ‖ dest key ‖ LE32(day))[..15])`.
pub fn arrival_day_seed(dest: ProvinceKey, day: u32) -> Seed {
    let h = sha256(&[
        ARRIVAL_DAY_SEED_DOMAIN,
        &dest.to_bytes(),
        &day.to_le_bytes(),
    ]);
    Seed::new(ARRIVAL_DAY_TAG, &h[..15])
}

/// `with_seed(season, wd ‖ hash(dest, day), program)`.
pub fn arrival_day_address(ctx: &AddrCtx, dest: ProvinceKey, day: u32) -> [u8; 32] {
    ctx.of(&arrival_day_seed(dest, day))
}

/// A wide ArrivalDay, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideArrivalDay {
    pub season_id: u64,
    pub dest: ProvinceKey,
    pub day: u32,
    pub bits: [u8; 18],
    /// The fee payer of the reveal that created it (immutable).
    pub rent_to: [u8; 32],
}

impl WideArrivalDay {
    /// A fresh day record with no bell set.
    pub const fn new(season_id: u64, dest: ProvinceKey, day: u32, rent_to: [u8; 32]) -> Self {
        WideArrivalDay {
            season_id,
            dest,
            day,
            bits: [0; 18],
            rent_to,
        }
    }

    /// Whether `bell` (of this day) has arrivals.
    pub fn has(&self, bell: u32) -> bool {
        let (at, mask) = wide_arrival_day::bit(bell);
        day_of(bell) == self.day && self.bits[at - wide_arrival_day::BITS] & mask != 0
    }

    /// Sets `bell`'s bit; `false` when `bell` is not of this day.
    pub fn set(&mut self, bell: u32) -> bool {
        if day_of(bell) != self.day {
            return false;
        }
        let (at, mask) = wide_arrival_day::bit(bell);
        self.bits[at - wide_arrival_day::BITS] |= mask;
        true
    }

    /// Decodes exactly `wide_arrival_day::SIZE` bytes.
    pub fn read(d: &[u8]) -> Result<WideArrivalDay, ArrivalError> {
        use wide_arrival_day as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = ArrivalError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(ArrivalError::Magic);
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(ArrivalError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        for (o, n) in [
            (L::RSV_18, 6usize),
            (L::RSV_28, 4),
            (L::RSV_81, 7),
            (L::RSV_106, 6),
        ] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(ArrivalError::Reserved);
            }
        }
        Ok(WideArrivalDay {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            dest: province_key_at(d, L::WORLD, L::SORT_KEY)?,
            day: rd_u32(d, L::DAY).ok_or(t)?,
            bits: rd_arr(d, L::BITS).ok_or(t)?,
            rent_to: rd_arr(d, L::RENT_TO).ok_or(t)?,
        })
    }

    /// Writes every byte of the record (reserved ranges zeroed).
    pub fn write(&self, d: &mut [u8]) -> Result<(), ArrivalError> {
        use wide_arrival_day as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_arr(d, L::RSV_18, &[0u8; 6])
            & wr_u32(d, L::DAY, self.day)
            & wr_arr(d, L::RSV_28, &[0u8; 4])
            & wr_arr(d, L::WORLD, self.dest.world().as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.dest.coord().sort_key())
            & wr_arr(d, L::RSV_81, &[0u8; 7])
            & wr_arr(d, L::BITS, &self.bits)
            & wr_arr(d, L::RSV_106, &[0u8; 6])
            & wr_arr(d, L::RENT_TO, &self.rent_to);
        if ok {
            Ok(())
        } else {
            Err(ArrivalError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

/// The wide ClashInputs (3,008 B): the deployed header facts, then 24
/// positions of 112 bytes. **Provisional magic.** No event chain.
pub mod wide_clash_inputs {
    crate::layout::fields!(size = 3_008;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        FLAGS @ 18 : "u8" = 1;
        N_PRESENT @ 19 : "u8" = 1;
        RSV_20 @ 20 : "rsv" = 4;
        BELL @ 24 : "u32" = 4;
        ARRIVALS_MASK @ 28 : "u32" = 4;
        CAMP_MASK @ 32 : "u32" = 4;
        SETTLED_MASK @ 36 : "u32" = 4;
        POSTURE_MASK @ 40 : "u64" = 8;
        WORLD @ 48 : "[u8;32]" = 32;
        SORT_KEY @ 80 : "[u8;17]" = 17;
        RSV_97 @ 97 : "rsv" = 7;
        RESOLVER @ 104 : "[u8;32]" = 32;
        EV_SLOT @ 136 : "u64" = 8;
        EV_PRICE @ 144 : "u64" = 8;
        EV_LIMIT @ 152 : "u32" = 4;
        RESOLVED_TS @ 156 : "u32" = 4;
        RENT_TO @ 160 : "[u8;32]" = 32;
        POSTURES @ 192 : "[u16;60]" = 120;
        RSV_312 @ 312 : "rsv" = 8;
        ARRIVALS @ 320 : "rec:WideArrival x24" = 2_688;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWCLI";
    pub const FLAG_NO_ARRIVALS: u8 = 1;
    pub const FLAG_RESOLVED: u8 = 2;
    pub const FLAGS_MASK: u8 = FLAG_NO_ARRIVALS | FLAG_RESOLVED;
    /// 24 positions: 6 factions × 4 slots, as deployed.
    pub const POSITIONS: usize = 24;
    pub const ALL_GATHERED: u32 = 0x00FF_FFFF;

    /// Offset of `arrivals[k]`.
    pub const fn arrival(k: usize) -> usize {
        ARRIVALS + k * super::wide_arrival::SIZE
    }
    /// Position of slot `(faction, i)`, as deployed.
    pub const fn position(faction: u8, i: u8) -> usize {
        faction as usize * 4 + i as usize
    }
}

/// One arrival record (112 B) in `wide_clash_inputs.arrivals[24]`: the
/// deployed 40-byte record with the full host reference and the Citizen
/// key in place of the two `u64`s.
pub mod wide_arrival {
    crate::layout::fields!(size = 112;
        HOST @ 0 : "[u8;56]" = 56;
        CITIZEN @ 56 : "[u8;32]" = 32;
        DEP_MASS @ 88 : "u32" = 4;
        TROOPS @ 92 : "u32" = 4;
        STAMINA @ 96 : "u16" = 2;
        RETREAT @ 98 : "u16" = 2;
        DEALT @ 100 : "u16" = 2;
        FACTION @ 102 : "u8" = 1;
        UNIT @ 103 : "u8" = 1;
        TILE @ 104 : "u8" = 1;
        STANCE @ 105 : "u8" = 1;
        PRESENT @ 106 : "u8" = 1;
        FATE @ 107 : "u8" = 1;
        TROOPS_AFTER @ 108 : "u32" = 4;
    );
    /// The deployed fate codes.
    pub const FATE_NONE: u8 = 0;
    pub const FATE_STAYS: u8 = 1;
    pub const FATE_WITHDREW: u8 = 2;
    pub const FATE_BOUNCED: u8 = 3;
    pub const FATE_RETREATED: u8 = 4;
    pub const FATE_DESTROYED: u8 = 5;
}

const _: () = assert!(
    wide_clash_inputs::ARRIVALS + wide_clash_inputs::POSITIONS * wide_arrival::SIZE
        == wide_clash_inputs::SIZE
);
const _: () = assert!(wide_clash_inputs::POSITIONS == 6 * FACTION_ARRIVAL_SLOTS);

/// Why a record is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArrivalError {
    /// Non-canonical boolean byte.
    Boolean(u8),
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
    Key(KeyError),
    /// The host is of another world than the destination.
    World,
    /// A faction at or above 6, or a slot index at or above 4.
    FactionOrSlot {
        faction: u8,
        i: u8,
    },
    Unit(u8),
    Stance(u8),
    Tile(u8),
    /// A retreat ratio above `RETREAT_MAX_BPS`.
    Retreat(u16),
    /// A flag bit no record carries.
    Flags(u8),
    Fate(u8),
    /// A position at or above 24.
    Position(usize),
    /// The ClashInputs' `n_present` above 24.
    Present(u8),
    /// A slot's `transit_slot` at or above 4.
    TransitSlot(u8),
}

impl From<KeyError> for ArrivalError {
    fn from(e: KeyError) -> Self {
        ArrivalError::Key(e)
    }
}

// ------------------------------------------------------------ addresses

/// `wa ‖ hex(sha256(domain ‖ dest key ‖ LE32(bell) ‖ faction ‖ i)[..15])`.
pub fn arrival_slot_seed(dest: ProvinceKey, bell: u32, faction: u8, i: u8) -> Seed {
    let h = sha256(&[
        ARRIVAL_SLOT_SEED_DOMAIN,
        &dest.to_bytes(),
        &bell.to_le_bytes(),
        &[faction, i],
    ]);
    Seed::new(ARRIVAL_SLOT_TAG, &h[..15])
}

/// `with_seed(season, wa ‖ hash(dest, bell, faction, i), program)`.
pub fn arrival_slot_address(
    ctx: &AddrCtx,
    dest: ProvinceKey,
    bell: u32,
    faction: u8,
    i: u8,
) -> [u8; 32] {
    ctx.of(&arrival_slot_seed(dest, bell, faction, i))
}

/// `wi ‖ hex(sha256(domain ‖ dest key ‖ LE32(bell))[..15])`.
pub fn clash_inputs_seed(dest: ProvinceKey, bell: u32) -> Seed {
    let h = sha256(&[
        CLASH_INPUTS_SEED_DOMAIN,
        &dest.to_bytes(),
        &bell.to_le_bytes(),
    ]);
    Seed::new(CLASH_INPUTS_TAG, &h[..15])
}

/// `with_seed(season, wi ‖ hash(dest, bell), program)`.
pub fn clash_inputs_address(ctx: &AddrCtx, dest: ProvinceKey, bell: u32) -> [u8; 32] {
    ctx.of(&clash_inputs_seed(dest, bell))
}

// ------------------------------------------------------------ typed bytes

/// The deployed stance byte of a committed posture (0 Hold, 1 Assault, 2
/// Flank, 3 Brace).
pub const fn stance_byte(s: Stance) -> u8 {
    match s {
        Stance::Hold => 0,
        Stance::Assault => 1,
        Stance::Flank => 2,
        Stance::Brace => 3,
    }
}

/// The posture of a stance byte; `None` above 3.
pub const fn posture_of_byte(b: u8) -> Option<Posture> {
    match b {
        0 => Some(Posture::Stance(Stance::Hold)),
        1 => Some(Posture::Stance(Stance::Assault)),
        2 => Some(Posture::Stance(Stance::Flank)),
        3 => Some(Posture::Stance(Stance::Brace)),
        _ => None,
    }
}

/// The deployed fate code of a kernel fate.
pub const fn fate_byte(f: Fate) -> u8 {
    match f {
        Fate::Stays { .. } => wide_arrival::FATE_STAYS,
        Fate::Withdrew { .. } => wide_arrival::FATE_WITHDREW,
        Fate::Bounced => wide_arrival::FATE_BOUNCED,
        Fate::Retreated => wide_arrival::FATE_RETREATED,
        Fate::Destroyed => wide_arrival::FATE_DESTROYED,
    }
}

/// The per-arrival facts both records carry, checked once for both.
fn check_facts(unit: u8, stance: u8, tile: u8, retreat_bps: u16) -> Result<(), ArrivalError> {
    if unit_from_u8(unit).is_none() {
        return Err(ArrivalError::Unit(unit));
    }
    if posture_of_byte(stance).is_none() {
        return Err(ArrivalError::Stance(stance));
    }
    if tile as usize >= PROVINCE_TILES {
        return Err(ArrivalError::Tile(tile));
    }
    if retreat_bps > RETREAT_MAX_BPS {
        return Err(ArrivalError::Retreat(retreat_bps));
    }
    Ok(())
}

/// A province key stored as `world ‖ sort key` at two offsets.
fn province_key_at(d: &[u8], world: usize, sort_key: usize) -> Result<ProvinceKey, ArrivalError> {
    let t = ArrivalError::Length {
        expected: 0,
        got: 0,
    };
    let w = WorldId::new(rd_arr(d, world).ok_or(t)?)?;
    let k: [u8; super::coord::SORT_KEY_LEN] = rd_arr(d, sort_key).ok_or(t)?;
    let c = super::coord::WideCoord::from_sort_key(&k).map_err(KeyError::Coord)?;
    Ok(ProvinceKey::new(w, c))
}

/// A host reference stored at `off`, of `world` (`World` otherwise).
fn host_at(d: &[u8], off: usize, world: WorldId) -> Result<WideHostRef, ArrivalError> {
    let s = d.get(off..off + HOST_REF_LEN).ok_or(ArrivalError::Length {
        expected: off + HOST_REF_LEN,
        got: d.len(),
    })?;
    let h = WideHostRef::from_bytes(s)?;
    if h.key().world() != world {
        return Err(ArrivalError::World);
    }
    Ok(h)
}

// ------------------------------------------------------------ the slot

/// A wide ArrivalSlot, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideArrivalSlot {
    pub season_id: u64,
    pub dest: ProvinceKey,
    pub bell: u32,
    pub faction: u8,
    pub i: u8,
    /// The transit slot of the host's holding whose wide transit record
    /// this arrival is (`march::transit_address(holding, transit_slot)`):
    /// the gather and the settle read **that** record and no other.
    pub transit_slot: u8,
    /// The arriving host, of the destination's world (its reference keeps
    /// its home province).
    pub host: WideHostRef,
    pub citizen: [u8; 32],
    pub unit: u8,
    pub stance: u8,
    pub tile: u8,
    pub retreat_bps: u16,
    pub dealt_bps: u16,
    pub dep_mass: u32,
    pub flags: u8,
    pub beneficiary: [u8; 32],
    pub rent_to: [u8; 32],
    pub ev_slot: u64,
    pub ev_price: u64,
    pub ev_limit: u32,
    pub ev_loaded: u32,
    pub claimed: bool,
}

impl WideArrivalSlot {
    /// Every typed field in range and the host of the destination's world.
    fn check(&self) -> Result<(), ArrivalError> {
        if self.faction >= 6 || self.i as usize >= FACTION_ARRIVAL_SLOTS {
            return Err(ArrivalError::FactionOrSlot {
                faction: self.faction,
                i: self.i,
            });
        }
        if self.host.key().world() != self.dest.world() {
            return Err(ArrivalError::World);
        }
        if self.flags & !wide_arrival_slot::FLAGS_MASK != 0 {
            return Err(ArrivalError::Flags(self.flags));
        }
        if self.transit_slot >= wide_arrival_slot::TRANSIT_SLOTS {
            return Err(ArrivalError::TransitSlot(self.transit_slot));
        }
        check_facts(self.unit, self.stance, self.tile, self.retreat_bps)
    }

    /// Decodes exactly `wide_arrival_slot::SIZE` bytes.
    pub fn read(d: &[u8]) -> Result<WideArrivalSlot, ArrivalError> {
        use wide_arrival_slot as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = ArrivalError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(ArrivalError::Magic);
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(ArrivalError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        for (o, n) in [
            (L::RSV_29, 3usize),
            (L::RSV_36, 4),
            (L::RSV_89, 7),
            (L::RSV_188, 4),
            (L::RSV, 7),
        ] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(ArrivalError::Reserved);
            }
        }
        let dest = province_key_at(d, L::WORLD, L::SORT_KEY)?;
        let host = host_at(d, L::HOST, dest.world())?;
        let s = WideArrivalSlot {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            dest,
            bell: rd_u32(d, L::BELL).ok_or(t)?,
            faction: rd_u8(d, L::FACTION).ok_or(t)?,
            i: rd_u8(d, L::I).ok_or(t)?,
            transit_slot: rd_u8(d, L::TRANSIT_SLOT).ok_or(t)?,
            host,
            citizen: rd_arr(d, L::CITIZEN).ok_or(t)?,
            unit: rd_u8(d, L::UNIT).ok_or(t)?,
            stance: rd_u8(d, L::STANCE).ok_or(t)?,
            tile: rd_u8(d, L::TILE).ok_or(t)?,
            retreat_bps: rd_u16(d, L::RETREAT_BPS).ok_or(t)?,
            dealt_bps: rd_u16(d, L::DEALT_BPS).ok_or(t)?,
            dep_mass: rd_u32(d, L::DEP_MASS).ok_or(t)?,
            flags: rd_u8(d, L::FLAGS).ok_or(t)?,
            beneficiary: rd_arr(d, L::BENEFICIARY).ok_or(t)?,
            rent_to: rd_arr(d, L::RENT_TO).ok_or(t)?,
            ev_slot: rd_u64(d, L::EV_SLOT).ok_or(t)?,
            ev_price: rd_u64(d, L::EV_PRICE).ok_or(t)?,
            ev_limit: rd_u32(d, L::EV_LIMIT).ok_or(t)?,
            ev_loaded: rd_u32(d, L::EV_LOADED).ok_or(t)?,
            claimed: canonical_bool(rd_u8(d, L::CLAIMED).ok_or(t)?)?,
        };
        s.check()?;
        Ok(s)
    }

    /// Writes every byte of the record (reserved ranges zeroed) after the
    /// same checks `read` makes.
    pub fn write(&self, d: &mut [u8]) -> Result<(), ArrivalError> {
        use wide_arrival_slot as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        self.check()?;
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::FLAGS, self.flags)
            & wr_u8(d, L::FACTION, self.faction)
            & wr_u8(d, L::I, self.i)
            & wr_u8(d, L::UNIT, self.unit)
            & wr_u8(d, L::STANCE, self.stance)
            & wr_u8(d, L::TILE, self.tile)
            & wr_u16(d, L::RETREAT_BPS, self.retreat_bps)
            & wr_u16(d, L::DEALT_BPS, self.dealt_bps)
            & wr_u8(d, L::TRANSIT_SLOT, self.transit_slot)
            & wr_arr(d, L::RSV_29, &[0u8; 3])
            & wr_u32(d, L::BELL, self.bell)
            & wr_arr(d, L::RSV_36, &[0u8; 4])
            & wr_arr(d, L::WORLD, self.dest.world().as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.dest.coord().sort_key())
            & wr_arr(d, L::RSV_89, &[0u8; 7])
            & wr_arr(d, L::HOST, &self.host.to_bytes())
            & wr_arr(d, L::CITIZEN, &self.citizen)
            & wr_u32(d, L::DEP_MASS, self.dep_mass)
            & wr_arr(d, L::RSV_188, &[0u8; 4])
            & wr_arr(d, L::BENEFICIARY, &self.beneficiary)
            & wr_arr(d, L::RENT_TO, &self.rent_to)
            & wr_u64(d, L::EV_SLOT, self.ev_slot)
            & wr_u64(d, L::EV_PRICE, self.ev_price)
            & wr_u32(d, L::EV_LIMIT, self.ev_limit)
            & wr_u32(d, L::EV_LOADED, self.ev_loaded)
            & wr_u8(d, L::CLAIMED, self.claimed as u8)
            & wr_arr(d, L::RSV, &[0u8; 7]);
        if ok {
            Ok(())
        } else {
            Err(ArrivalError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

// ------------------------------------------------------------ the inputs header

/// A wide ClashInputs' header, decoded (the positions are read and written
/// through [`WideArrival`], which checks this header first).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideClashInputsHdr {
    pub season_id: u64,
    pub dest: ProvinceKey,
    pub bell: u32,
    pub flags: u8,
    pub n_present: u8,
    pub arrivals_mask: u32,
    pub camp_mask: u32,
    pub settled_mask: u32,
    pub posture_mask: u64,
    pub resolver: [u8; 32],
    pub ev_slot: u64,
    pub ev_price: u64,
    pub ev_limit: u32,
    pub resolved_ts: u32,
    pub rent_to: [u8; 32],
}

impl WideClashInputsHdr {
    /// A fresh header for `(dest, bell)`: no arrivals gathered, nothing
    /// resolved, the rent payer `rent_to`.
    pub const fn new(season_id: u64, dest: ProvinceKey, bell: u32, rent_to: [u8; 32]) -> Self {
        WideClashInputsHdr {
            season_id,
            dest,
            bell,
            flags: 0,
            n_present: 0,
            arrivals_mask: 0,
            camp_mask: 0,
            settled_mask: 0,
            posture_mask: 0,
            resolver: [0; 32],
            ev_slot: 0,
            ev_price: 0,
            ev_limit: 0,
            resolved_ts: 0,
            rent_to,
        }
    }

    fn check(&self) -> Result<(), ArrivalError> {
        if self.flags & !wide_clash_inputs::FLAGS_MASK != 0 {
            return Err(ArrivalError::Flags(self.flags));
        }
        if self.n_present as usize > wide_clash_inputs::POSITIONS {
            return Err(ArrivalError::Present(self.n_present));
        }
        if self.arrivals_mask & !wide_clash_inputs::ALL_GATHERED != 0
            || self.camp_mask & !wide_clash_inputs::ALL_GATHERED != 0
            || self.settled_mask & !wide_clash_inputs::ALL_GATHERED != 0
        {
            return Err(ArrivalError::Position(wide_clash_inputs::POSITIONS));
        }
        Ok(())
    }

    /// Decodes the header of exactly `wide_clash_inputs::SIZE` bytes.
    pub fn read(d: &[u8]) -> Result<WideClashInputsHdr, ArrivalError> {
        use wide_clash_inputs as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = ArrivalError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(ArrivalError::Magic);
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(ArrivalError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        for (o, n) in [(L::RSV_20, 4usize), (L::RSV_97, 7), (L::RSV_312, 8)] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(ArrivalError::Reserved);
            }
        }
        let h = WideClashInputsHdr {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            dest: province_key_at(d, L::WORLD, L::SORT_KEY)?,
            bell: rd_u32(d, L::BELL).ok_or(t)?,
            flags: rd_u8(d, L::FLAGS).ok_or(t)?,
            n_present: rd_u8(d, L::N_PRESENT).ok_or(t)?,
            arrivals_mask: rd_u32(d, L::ARRIVALS_MASK).ok_or(t)?,
            camp_mask: rd_u32(d, L::CAMP_MASK).ok_or(t)?,
            settled_mask: rd_u32(d, L::SETTLED_MASK).ok_or(t)?,
            posture_mask: rd_u64(d, L::POSTURE_MASK).ok_or(t)?,
            resolver: rd_arr(d, L::RESOLVER).ok_or(t)?,
            ev_slot: rd_u64(d, L::EV_SLOT).ok_or(t)?,
            ev_price: rd_u64(d, L::EV_PRICE).ok_or(t)?,
            ev_limit: rd_u32(d, L::EV_LIMIT).ok_or(t)?,
            resolved_ts: rd_u32(d, L::RESOLVED_TS).ok_or(t)?,
            rent_to: rd_arr(d, L::RENT_TO).ok_or(t)?,
        };
        h.check()?;
        Ok(h)
    }

    /// Writes the header fields (the postures and the positions are
    /// untouched) after the same checks `read` makes.
    pub fn write(&self, d: &mut [u8]) -> Result<(), ArrivalError> {
        use wide_clash_inputs as L;
        if d.len() != L::SIZE {
            return Err(ArrivalError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        self.check()?;
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::FLAGS, self.flags)
            & wr_u8(d, L::N_PRESENT, self.n_present)
            & wr_arr(d, L::RSV_20, &[0u8; 4])
            & wr_u32(d, L::BELL, self.bell)
            & wr_u32(d, L::ARRIVALS_MASK, self.arrivals_mask)
            & wr_u32(d, L::CAMP_MASK, self.camp_mask)
            & wr_u32(d, L::SETTLED_MASK, self.settled_mask)
            & wr_u64(d, L::POSTURE_MASK, self.posture_mask)
            & wr_arr(d, L::WORLD, self.dest.world().as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.dest.coord().sort_key())
            & wr_arr(d, L::RSV_97, &[0u8; 7])
            & wr_arr(d, L::RESOLVER, &self.resolver)
            & wr_u64(d, L::EV_SLOT, self.ev_slot)
            & wr_u64(d, L::EV_PRICE, self.ev_price)
            & wr_u32(d, L::EV_LIMIT, self.ev_limit)
            & wr_u32(d, L::RESOLVED_TS, self.resolved_ts)
            & wr_arr(d, L::RENT_TO, &self.rent_to)
            & wr_arr(d, L::RSV_312, &[0u8; 8]);
        if ok {
            Ok(())
        } else {
            Err(ArrivalError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

// ------------------------------------------------------------ the arrival record

/// One position of a wide ClashInputs, decoded: what a gather copies from
/// the slot and what a resolve writes back (`fate`, `troops_after`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideArrival {
    /// The arriving host, of the destination's world.
    pub host: WideHostRef,
    pub citizen: [u8; 32],
    pub dep_mass: u32,
    pub troops: u32,
    pub stamina: u16,
    pub retreat_bps: u16,
    pub dealt_bps: u16,
    pub faction: u8,
    pub unit: u8,
    pub tile: u8,
    pub stance: u8,
    pub present: bool,
    pub fate: u8,
    pub troops_after: u32,
}

fn canonical_bool(byte: u8) -> Result<bool, ArrivalError> {
    match byte {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(ArrivalError::Boolean(other)),
    }
}

impl WideArrival {
    fn check(&self, dest_world: WorldId) -> Result<(), ArrivalError> {
        if self.host.key().world() != dest_world {
            return Err(ArrivalError::World);
        }
        if self.faction >= 6 {
            return Err(ArrivalError::FactionOrSlot {
                faction: self.faction,
                i: 0,
            });
        }
        if self.fate > wide_arrival::FATE_DESTROYED {
            return Err(ArrivalError::Fate(self.fate));
        }
        check_facts(self.unit, self.stance, self.tile, self.retreat_bps)
    }

    /// Position `k` of a wide ClashInputs' bytes, after the header is read
    /// and checked; an absent position (all zero) is `Ok(None)`.
    pub fn read_at(inputs: &[u8], k: usize) -> Result<Option<WideArrival>, ArrivalError> {
        use wide_arrival as A;
        let hdr = WideClashInputsHdr::read(inputs)?;
        if k >= wide_clash_inputs::POSITIONS {
            return Err(ArrivalError::Position(k));
        }
        let o = wide_clash_inputs::arrival(k);
        let d = &inputs[o..o + A::SIZE];
        if d.iter().all(|b| *b == 0) {
            return Ok(None);
        }
        let t = ArrivalError::Length {
            expected: A::SIZE,
            got: 0,
        };
        let a = WideArrival {
            host: host_at(d, A::HOST, hdr.dest.world())?,
            citizen: rd_arr(d, A::CITIZEN).ok_or(t)?,
            dep_mass: rd_u32(d, A::DEP_MASS).ok_or(t)?,
            troops: rd_u32(d, A::TROOPS).ok_or(t)?,
            stamina: rd_u16(d, A::STAMINA).ok_or(t)?,
            retreat_bps: rd_u16(d, A::RETREAT).ok_or(t)?,
            dealt_bps: rd_u16(d, A::DEALT).ok_or(t)?,
            faction: rd_u8(d, A::FACTION).ok_or(t)?,
            unit: rd_u8(d, A::UNIT).ok_or(t)?,
            tile: rd_u8(d, A::TILE).ok_or(t)?,
            stance: rd_u8(d, A::STANCE).ok_or(t)?,
            present: canonical_bool(rd_u8(d, A::PRESENT).ok_or(t)?)?,
            fate: rd_u8(d, A::FATE).ok_or(t)?,
            troops_after: rd_u32(d, A::TROOPS_AFTER).ok_or(t)?,
        };
        a.check(hdr.dest.world())?;
        if a.faction as usize != k / 4 {
            return Err(ArrivalError::Position(k));
        }
        Ok(Some(a))
    }

    /// Writes this record at position `k` of a wide ClashInputs' bytes,
    /// after the header is read and checked and this record's facts are.
    pub fn write_at(&self, inputs: &mut [u8], k: usize) -> Result<(), ArrivalError> {
        use wide_arrival as A;
        let hdr = WideClashInputsHdr::read(inputs)?;
        if k >= wide_clash_inputs::POSITIONS {
            return Err(ArrivalError::Position(k));
        }
        self.check(hdr.dest.world())?;
        if self.faction as usize != k / 4 {
            return Err(ArrivalError::Position(k));
        }
        let o = wide_clash_inputs::arrival(k);
        let d = &mut inputs[o..o + A::SIZE];
        let ok = wr_arr(d, A::HOST, &self.host.to_bytes())
            & wr_arr(d, A::CITIZEN, &self.citizen)
            & wr_u32(d, A::DEP_MASS, self.dep_mass)
            & wr_u32(d, A::TROOPS, self.troops)
            & wr_u16(d, A::STAMINA, self.stamina)
            & wr_u16(d, A::RETREAT, self.retreat_bps)
            & wr_u16(d, A::DEALT, self.dealt_bps)
            & wr_u8(d, A::FACTION, self.faction)
            & wr_u8(d, A::UNIT, self.unit)
            & wr_u8(d, A::TILE, self.tile)
            & wr_u8(d, A::STANCE, self.stance)
            & wr_u8(d, A::PRESENT, self.present as u8)
            & wr_u8(d, A::FATE, self.fate)
            & wr_u32(d, A::TROOPS_AFTER, self.troops_after);
        if ok {
            Ok(())
        } else {
            Err(ArrivalError::Length {
                expected: A::SIZE,
                got: 0,
            })
        }
    }

    /// The kernel's fighter this arrival is, as the deployed gather builds
    /// one from a 40-byte record: the host behind the `Host` tag, the
    /// committed stance as its posture, the retreat ratio `Some` unless
    /// `RETREAT_NEVER`.
    pub fn to_fighter(&self) -> Result<WideFighter, ArrivalError> {
        let unit = unit_from_u8(self.unit).ok_or(ArrivalError::Unit(self.unit))?;
        let posture = posture_of_byte(self.stance).ok_or(ArrivalError::Stance(self.stance))?;
        if self.retreat_bps > RETREAT_MAX_BPS {
            return Err(ArrivalError::Retreat(self.retreat_bps));
        }
        Ok(WideFighter {
            id: WideCombatant::Host(self.host),
            faction: self.faction,
            unit,
            troops: self.troops,
            stamina: self.stamina,
            tile: self.tile,
            posture,
            retreat_bps: (self.retreat_bps != wide_arrival_slot::RETREAT_NEVER)
                .then_some(self.retreat_bps as permutation_rules::fixed::Bps),
            dealt_bps: self.dealt_bps as permutation_rules::fixed::Bps,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Field;
    use crate::world_index::coord::WideCoord;
    use permutation_rules::units::UnitType;

    fn tiles(size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{} at {} not {at}", f.name, f.off);
            at += f.len;
        }
        assert_eq!(at, size);
    }

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn key(p: i64, q: i64) -> ProvinceKey {
        ProvinceKey::new(world(0x77), WideCoord::checked(p, q).unwrap())
    }

    /// The host arrives at (130, -1) from its home (129, 0): its reference
    /// keeps the home province.
    fn host() -> WideHostRef {
        WideHostRef::new(key(129, 0), 3, 1, 7).unwrap()
    }

    fn alien() -> WideHostRef {
        WideHostRef::new(
            ProvinceKey::new(world(0x78), WideCoord::checked(129, 0).unwrap()),
            3,
            1,
            7,
        )
        .unwrap()
    }

    fn slot() -> WideArrivalSlot {
        WideArrivalSlot {
            season_id: 11,
            dest: key(130, -1),
            bell: 40,
            faction: 2,
            i: 1,
            transit_slot: 2,
            host: host(),
            citizen: [0xc1; 32],
            unit: UnitType::Knight as u8,
            stance: stance_byte(Stance::Assault),
            tile: 30,
            retreat_bps: 0,
            dealt_bps: 10_000,
            dep_mass: 12_000_000,
            flags: 0,
            beneficiary: [0xb1; 32],
            rent_to: [0xd4; 32],
            ev_slot: 5_000,
            ev_price: 7,
            ev_limit: 26_000,
            ev_loaded: 1 << 20,
            claimed: false,
        }
    }

    fn hdr() -> WideClashInputsHdr {
        WideClashInputsHdr::new(11, key(130, -1), 40, [0xd4; 32])
    }

    fn inputs() -> std::vec::Vec<u8> {
        let mut d = std::vec![0u8; wide_clash_inputs::SIZE];
        hdr().write(&mut d).unwrap();
        d
    }

    fn record() -> WideArrival {
        let s = slot();
        WideArrival {
            host: s.host,
            citizen: s.citizen,
            dep_mass: s.dep_mass,
            troops: 11_500_000,
            stamina: 60,
            retreat_bps: 2_500,
            dealt_bps: s.dealt_bps,
            faction: s.faction,
            unit: s.unit,
            tile: s.tile,
            stance: s.stance,
            present: true,
            fate: wide_arrival::FATE_NONE,
            troops_after: 0,
        }
    }

    #[test]
    fn layouts_tile_and_the_tags_are_provisional() {
        tiles(wide_arrival_slot::SIZE, wide_arrival_slot::FIELDS);
        tiles(wide_clash_inputs::SIZE, wide_clash_inputs::FIELDS);
        tiles(wide_arrival::SIZE, wide_arrival::FIELDS);
        tiles(wide_arrival_day::SIZE, wide_arrival_day::FIELDS);
        assert_eq!(wide_arrival_slot::SIZE, 288);
        assert_eq!(wide_clash_inputs::SIZE, 3_008);
        assert_eq!(wide_arrival::SIZE, 112);
        assert_eq!(wide_arrival_day::SIZE, 144);
        assert_eq!(wide_arrival_slot::TRANSIT_SLOT, 28);
        assert_eq!(wide_arrival_day::BELLS, 144);
        assert_eq!(wide_arrival_day::bit(0), (wide_arrival_day::BITS, 1));
        assert_eq!(
            wide_arrival_day::bit(143),
            (wide_arrival_day::BITS + 17, 0x80)
        );
        assert_eq!(wide_arrival_day::bit(144), (wide_arrival_day::BITS, 1));
        assert_eq!(day_of(143), 0);
        assert_eq!(day_of(144), 1);
        assert_eq!(&wide_arrival_day::MAGIC[..4], b"PSFX");
        assert_eq!(
            crate::layout::AccountKind::from_magic(&wide_arrival_day::MAGIC),
            None
        );
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&ARRIVAL_DAY_TAG),
            None
        );
        assert_eq!(
            wide_clash_inputs::arrival(23) + wide_arrival::SIZE,
            wide_clash_inputs::SIZE
        );
        assert_eq!(wide_clash_inputs::position(5, 3), 23);
        for (m, tag) in [
            (wide_arrival_slot::MAGIC, ARRIVAL_SLOT_TAG),
            (wide_clash_inputs::MAGIC, CLASH_INPUTS_TAG),
        ] {
            assert_eq!(&m[..4], b"PSFX");
            assert_eq!(crate::layout::AccountKind::from_magic(&m), None);
            assert_eq!(
                permutation_rules::frontier::addr::SeedKind::from_tag(&tag),
                None
            );
        }
        // the deployed fate codes, verbatim
        assert_eq!(
            fate_byte(Fate::Stays { tile: 1 }),
            crate::layout::clash::arrival::FATE_STAYS
        );
        assert_eq!(
            fate_byte(Fate::Destroyed),
            crate::layout::clash::arrival::FATE_DESTROYED
        );
        for s in [Stance::Hold, Stance::Assault, Stance::Flank, Stance::Brace] {
            assert_eq!(posture_of_byte(stance_byte(s)), Some(Posture::Stance(s)));
        }
        assert_eq!(posture_of_byte(4), None);
    }

    #[test]
    fn addresses_are_one_per_destination_bell_and_slot() {
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        let a = arrival_slot_address(&ctx, key(130, -1), 40, 2, 1);
        assert_eq!(a, arrival_slot_address(&ctx, key(130, -1), 40, 2, 1));
        assert_ne!(a, arrival_slot_address(&ctx, key(130, -1), 40, 2, 2));
        assert_ne!(a, arrival_slot_address(&ctx, key(130, -1), 40, 3, 1));
        assert_ne!(a, arrival_slot_address(&ctx, key(130, -1), 41, 2, 1));
        assert_ne!(a, arrival_slot_address(&ctx, key(130, 0), 40, 2, 1));
        let far = ProvinceKey::new(
            world(0x77),
            WideCoord::checked((1i64 << 32) + 130, -(1i64 << 32) - 1).unwrap(),
        );
        assert_ne!(a, arrival_slot_address(&ctx, far, 40, 2, 1), "full width");
        let c = clash_inputs_address(&ctx, key(130, -1), 40);
        assert_ne!(c, clash_inputs_address(&ctx, key(130, -1), 41));
        assert_ne!(c, a);
        assert_ne!(c, ctx.clash_inputs(130, -1, 40), "not a deployed address");
        assert_ne!(a, ctx.arrival_slot(130, -1, 40, 2, 1));
    }

    /// The slot round-trips; every header, identity and typed field fault
    /// is refused on read, and the same faults on write.
    #[test]
    fn slot_round_trips_and_refuses_every_fault_on_read_and_write() {
        let s = slot();
        assert_ne!(s.host.key(), s.dest, "an onward arrival: home kept");
        let mut d = [0u8; wide_arrival_slot::SIZE];
        s.write(&mut d).unwrap();
        assert_eq!(WideArrivalSlot::read(&d), Ok(s));
        assert_eq!(
            WideArrivalSlot::read(&d[..100]),
            Err(ArrivalError::Length {
                expected: 288,
                got: 100
            })
        );
        let mut x = d;
        x[0] ^= 1;
        assert_eq!(WideArrivalSlot::read(&x), Err(ArrivalError::Magic));
        let mut x = d;
        x[wide_arrival_slot::FAMILY_VERSION] = 9;
        assert!(matches!(
            WideArrivalSlot::read(&x),
            Err(ArrivalError::Version { got: 9, .. })
        ));
        // the transit slot is bound to the record: a slot at or above 4 is
        // refused on read and on write
        let mut x = d;
        x[wide_arrival_slot::TRANSIT_SLOT] = 4;
        assert_eq!(WideArrivalSlot::read(&x), Err(ArrivalError::TransitSlot(4)));
        assert_eq!(
            WideArrivalSlot {
                transit_slot: 4,
                ..s
            }
            .write(&mut [0u8; wide_arrival_slot::SIZE]),
            Err(ArrivalError::TransitSlot(4))
        );
        for off in [
            wide_arrival_slot::RSV_29,
            wide_arrival_slot::RSV_36 + 3,
            wide_arrival_slot::RSV_89,
            wide_arrival_slot::RSV_188,
            wide_arrival_slot::RSV + 6,
        ] {
            let mut x = d;
            x[off] = 1;
            assert_eq!(
                WideArrivalSlot::read(&x),
                Err(ArrivalError::Reserved),
                "{off}"
            );
        }
        let mut x = d;
        x[wide_arrival_slot::WORLD..wide_arrival_slot::WORLD + 32].fill(0);
        assert_eq!(
            WideArrivalSlot::read(&x),
            Err(ArrivalError::Key(KeyError::ReservedWorld))
        );
        // the host of another world than the destination
        let mut x = d;
        x[wide_arrival_slot::HOST..wide_arrival_slot::HOST + HOST_REF_LEN]
            .copy_from_slice(&alien().to_bytes());
        assert_eq!(WideArrivalSlot::read(&x), Err(ArrivalError::World));
        // a host site at or above 12 never decodes
        let mut x = d;
        x[wide_arrival_slot::HOST + 50] = 12;
        assert_eq!(
            WideArrivalSlot::read(&x),
            Err(ArrivalError::Key(KeyError::Site(12)))
        );
        // typed fields, each on read and on write
        let faults: [(fn(&mut WideArrivalSlot), ArrivalError); 8] = [
            (
                |s| s.faction = 6,
                ArrivalError::FactionOrSlot { faction: 6, i: 1 },
            ),
            (
                |s| s.i = 4,
                ArrivalError::FactionOrSlot { faction: 2, i: 4 },
            ),
            (|s| s.unit = 200, ArrivalError::Unit(200)),
            (|s| s.stance = 4, ArrivalError::Stance(4)),
            (|s| s.tile = 61, ArrivalError::Tile(61)),
            (|s| s.retreat_bps = 60_001, ArrivalError::Retreat(60_001)),
            (|s| s.flags = 4, ArrivalError::Flags(4)),
            (|s| s.host = alien(), ArrivalError::World),
        ];
        for (f, want) in faults {
            let mut bad = s;
            f(&mut bad);
            let mut y = [0u8; wide_arrival_slot::SIZE];
            assert_eq!(bad.write(&mut y), Err(want), "{want:?} on write");
            assert!(y.iter().all(|b| *b == 0), "{want:?}: nothing written");
            // the same bytes forged behind the writer are refused on read
            let mut z = d;
            match want {
                ArrivalError::FactionOrSlot { faction: 6, .. } => z[wide_arrival_slot::FACTION] = 6,
                ArrivalError::FactionOrSlot { .. } => z[wide_arrival_slot::I] = 4,
                ArrivalError::Unit(_) => z[wide_arrival_slot::UNIT] = 200,
                ArrivalError::Stance(_) => z[wide_arrival_slot::STANCE] = 4,
                ArrivalError::Tile(_) => z[wide_arrival_slot::TILE] = 61,
                ArrivalError::Retreat(_) => z
                    [wide_arrival_slot::RETREAT_BPS..wide_arrival_slot::RETREAT_BPS + 2]
                    .copy_from_slice(&60_001u16.to_le_bytes()),
                ArrivalError::Flags(_) => z[wide_arrival_slot::FLAGS] = 4,
                _ => z[wide_arrival_slot::HOST..wide_arrival_slot::HOST + HOST_REF_LEN]
                    .copy_from_slice(&alien().to_bytes()),
            }
            assert_eq!(WideArrivalSlot::read(&z), Err(want), "{want:?} on read");
        }
        let flagged = WideArrivalSlot {
            flags: wide_arrival_slot::FLAG_SETTLED | wide_arrival_slot::FLAG_CREATED_DAY,
            retreat_bps: 60_000,
            ..s
        };
        let mut y = [0u8; wide_arrival_slot::SIZE];
        flagged.write(&mut y).unwrap();
        assert_eq!(WideArrivalSlot::read(&y), Ok(flagged));
    }

    /// The day record round-trips, sets and reads bells of its day only,
    /// refuses its faults, and is one per destination and day.
    #[test]
    fn arrival_day_round_trips_and_binds_its_day() {
        let mut day = WideArrivalDay::new(11, key(130, -1), 0, [0xd4; 32]);
        assert!(!day.has(40));
        assert!(day.set(40));
        assert!(day.has(40));
        assert!(!day.has(41));
        assert!(!day.set(144), "another day");
        assert!(!day.has(144));
        assert!(day.set(143));
        assert_eq!(day.bits[5], 1, "bell 40: byte 5, bit 0");
        assert_eq!(day.bits[17], 0x80, "bell 143: byte 17, bit 7");
        let mut d = [0u8; wide_arrival_day::SIZE];
        day.write(&mut d).unwrap();
        assert_eq!(WideArrivalDay::read(&d), Ok(day));
        assert_eq!(
            WideArrivalDay::read(&d[..100]),
            Err(ArrivalError::Length {
                expected: 144,
                got: 100
            })
        );
        let mut x = d;
        x[0] ^= 1;
        assert_eq!(WideArrivalDay::read(&x), Err(ArrivalError::Magic));
        let mut x = d;
        x[wide_arrival_day::FAMILY_VERSION] = 9;
        assert!(matches!(
            WideArrivalDay::read(&x),
            Err(ArrivalError::Version { got: 9, .. })
        ));
        for off in [
            wide_arrival_day::RSV_18,
            wide_arrival_day::RSV_28 + 3,
            wide_arrival_day::RSV_81,
            wide_arrival_day::RSV_106 + 5,
        ] {
            let mut x = d;
            x[off] = 1;
            assert_eq!(
                WideArrivalDay::read(&x),
                Err(ArrivalError::Reserved),
                "{off}"
            );
        }
        let mut x = d;
        x[wide_arrival_day::WORLD..wide_arrival_day::WORLD + 32].fill(0);
        assert_eq!(
            WideArrivalDay::read(&x),
            Err(ArrivalError::Key(KeyError::ReservedWorld))
        );
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        let a = arrival_day_address(&ctx, key(130, -1), 0);
        assert_eq!(a, arrival_day_address(&ctx, key(130, -1), 0));
        assert_ne!(a, arrival_day_address(&ctx, key(130, -1), 1));
        assert_ne!(a, arrival_day_address(&ctx, key(130, 0), 0));
        assert_ne!(a, ctx.arrival_day(130, -1, 0), "not a deployed address");
        assert_ne!(a, arrival_slot_address(&ctx, key(130, -1), 0, 0, 0));
        assert_ne!(a, clash_inputs_address(&ctx, key(130, -1), 0));
    }

    /// The inputs header round-trips and refuses its faults; a record
    /// cannot be read or written through a bad header.
    #[test]
    fn faction_position_and_boolean_bytes_are_canonical() {
        let a = record();
        let mut d = inputs();
        let before = d.clone();
        assert_eq!(a.write_at(&mut d, 0), Err(ArrivalError::Position(0)));
        assert_eq!(d, before);
        a.write_at(&mut d, 9).unwrap();
        let src = wide_clash_inputs::arrival(9);
        let dest = wide_clash_inputs::arrival(0);
        d.copy_within(src..src + wide_arrival::SIZE, dest);
        assert_eq!(WideArrival::read_at(&d, 0), Err(ArrivalError::Position(0)));
        d[src + wide_arrival::PRESENT] = 2;
        assert_eq!(WideArrival::read_at(&d, 9), Err(ArrivalError::Boolean(2)));
        let mut slot_bytes = [0u8; wide_arrival_slot::SIZE];
        slot().write(&mut slot_bytes).unwrap();
        slot_bytes[wide_arrival_slot::CLAIMED] = 2;
        assert_eq!(
            WideArrivalSlot::read(&slot_bytes),
            Err(ArrivalError::Boolean(2))
        );
    }

    #[test]
    fn inputs_header_is_checked_before_any_position() {
        let d = inputs();
        assert_eq!(WideClashInputsHdr::read(&d), Ok(hdr()));
        assert_eq!(
            WideClashInputsHdr::read(&d[..100]),
            Err(ArrivalError::Length {
                expected: 3_008,
                got: 100
            })
        );
        let a = record();
        let mut x = d.clone();
        x[0] ^= 1;
        assert_eq!(WideClashInputsHdr::read(&x), Err(ArrivalError::Magic));
        assert_eq!(WideArrival::read_at(&x, 0), Err(ArrivalError::Magic));
        assert_eq!(a.write_at(&mut x, 0), Err(ArrivalError::Magic));
        let mut x = d.clone();
        x[wide_clash_inputs::FAMILY_VERSION] = 9;
        assert!(matches!(
            WideClashInputsHdr::read(&x),
            Err(ArrivalError::Version { got: 9, .. })
        ));
        for off in [
            wide_clash_inputs::RSV_20,
            wide_clash_inputs::RSV_97 + 6,
            wide_clash_inputs::RSV_312 + 7,
        ] {
            let mut x = d.clone();
            x[off] = 1;
            assert_eq!(WideClashInputsHdr::read(&x), Err(ArrivalError::Reserved));
            assert_eq!(WideArrival::read_at(&x, 0), Err(ArrivalError::Reserved));
        }
        let mut x = d.clone();
        x[wide_clash_inputs::WORLD..wide_clash_inputs::WORLD + 32].fill(0);
        assert_eq!(
            WideClashInputsHdr::read(&x),
            Err(ArrivalError::Key(KeyError::ReservedWorld))
        );
        let mut x = d.clone();
        x[wide_clash_inputs::FLAGS] = 4;
        assert_eq!(WideClashInputsHdr::read(&x), Err(ArrivalError::Flags(4)));
        let mut x = d.clone();
        x[wide_clash_inputs::N_PRESENT] = 25;
        assert_eq!(WideClashInputsHdr::read(&x), Err(ArrivalError::Present(25)));
        let mut x = d.clone();
        x[wide_clash_inputs::ARRIVALS_MASK + 3] = 0x01;
        assert_eq!(
            WideClashInputsHdr::read(&x),
            Err(ArrivalError::Position(24))
        );
        // a written header with every field set reads back
        let full = WideClashInputsHdr {
            flags: wide_clash_inputs::FLAG_RESOLVED,
            n_present: 24,
            arrivals_mask: wide_clash_inputs::ALL_GATHERED,
            camp_mask: 1,
            settled_mask: 3,
            posture_mask: 0xdead_beef,
            resolver: [0x55; 32],
            ev_slot: 9,
            ev_price: 8,
            ev_limit: 7,
            resolved_ts: 6,
            ..hdr()
        };
        let mut y = d.clone();
        full.write(&mut y).unwrap();
        assert_eq!(WideClashInputsHdr::read(&y), Ok(full));
        let bad = WideClashInputsHdr {
            n_present: 25,
            ..hdr()
        };
        assert_eq!(bad.write(&mut y), Err(ArrivalError::Present(25)));
    }

    #[test]
    fn arrival_records_round_trip_in_the_inputs_and_become_kernel_fighters() {
        let a = record();
        let mut d = inputs();
        assert_eq!(WideArrival::read_at(&d, 9), Ok(None));
        a.write_at(&mut d, 9).unwrap();
        assert_eq!(WideArrival::read_at(&d, 9), Ok(Some(a)));
        assert_eq!(WideArrival::read_at(&d, 8), Ok(None));
        assert_eq!(
            WideArrival::read_at(&d, 24),
            Err(ArrivalError::Position(24))
        );
        assert_eq!(a.write_at(&mut d, 24), Err(ArrivalError::Position(24)));
        let f = a.to_fighter().unwrap();
        assert_eq!(f.id, WideCombatant::Host(a.host));
        assert!(!f.id.is_synthetic());
        assert_eq!(
            (f.faction, f.unit, f.troops, f.stamina, f.tile),
            (2, UnitType::Knight, 11_500_000, 60, 30)
        );
        assert_eq!(f.posture, Posture::Stance(Stance::Assault));
        assert_eq!(f.retreat_bps, Some(2_500));
        assert_eq!(f.dealt_bps, 10_000);
        let never = WideArrival {
            retreat_bps: wide_arrival_slot::RETREAT_NEVER,
            ..a
        };
        assert_eq!(never.to_fighter().unwrap().retreat_bps, None);
        // a resolve writes the fate back
        let settled = WideArrival {
            fate: fate_byte(Fate::Withdrew { tile: 31 }),
            troops_after: 9_000_000,
            ..a
        };
        settled.write_at(&mut d, 9).unwrap();
        assert_eq!(WideArrival::read_at(&d, 9), Ok(Some(settled)));
        // every typed fault, on write and forged on read
        let o = wide_clash_inputs::arrival(9);
        let faults: [(fn(&mut WideArrival), ArrivalError, usize, u8); 7] = [
            (|r| r.fate = 6, ArrivalError::Fate(6), wide_arrival::FATE, 6),
            (
                |r| r.unit = 200,
                ArrivalError::Unit(200),
                wide_arrival::UNIT,
                200,
            ),
            (
                |r| r.stance = 4,
                ArrivalError::Stance(4),
                wide_arrival::STANCE,
                4,
            ),
            (
                |r| r.tile = 61,
                ArrivalError::Tile(61),
                wide_arrival::TILE,
                61,
            ),
            (
                |r| r.faction = 6,
                ArrivalError::FactionOrSlot { faction: 6, i: 0 },
                wide_arrival::FACTION,
                6,
            ),
            (
                |r| r.retreat_bps = 60_001,
                ArrivalError::Retreat(60_001),
                wide_arrival::RETREAT + 1,
                0xea,
            ),
            (
                |r| r.host = alien(),
                ArrivalError::World,
                wide_arrival::HOST + 1,
                0x78,
            ),
        ];
        for (f, want, off, byte) in faults {
            let mut bad = settled;
            f(&mut bad);
            let before = d.clone();
            assert_eq!(bad.write_at(&mut d, 9), Err(want), "{want:?} on write");
            assert_eq!(d, before, "{want:?}: nothing written");
            let mut z = d.clone();
            match want {
                ArrivalError::World => z
                    [o + wide_arrival::HOST..o + wide_arrival::HOST + HOST_REF_LEN]
                    .copy_from_slice(&alien().to_bytes()),
                ArrivalError::Retreat(v) => z
                    [o + wide_arrival::RETREAT..o + wide_arrival::RETREAT + 2]
                    .copy_from_slice(&v.to_le_bytes()),
                _ => z[o + off] = byte,
            }
            assert_eq!(WideArrival::read_at(&z, 9), Err(want), "{want:?} on read");
        }
        // a forged retreat of 60,001 (0xea61) is refused by the fighter too
        let too_far = WideArrival {
            retreat_bps: 60_001,
            ..a
        };
        assert_eq!(too_far.to_fighter(), Err(ArrivalError::Retreat(60_001)));
    }
}
