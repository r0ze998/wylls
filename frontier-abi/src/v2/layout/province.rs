//! Province v2 (4,736 B) and its conquest records (MC contract §5.2.1).
//!
//! Bytes `0..4,096` are M1's Province byte for byte (the 232-B reserve at
//! 3,864 included); `tests::v1_prefix_is_m1` checks every field. The
//! 640-B conquest block follows at 4,096.

#![allow(clippy::module_inception)]

use crate::layout::province::province as V1;

/// Province v2 (4,736): `pv‖P,Q`.
pub mod province {
    crate::layout::chained!(b"PSF1PROV", 4_736;
        P @ 64 : "i16" = 2;
        Q @ 66 : "i16" = 2;
        RING @ 68 : "u16" = 2;
        WEDGE @ 70 : "u8" = 1;
        REGION @ 71 : "u8" = 1;
        RESOLVED_NEXT @ 72 : "u32" = 4;
        OPENED_BELL @ 76 : "u32" = 4;
        RELATIONS @ 80 : "u64" = 8;
        LAST_DIGEST @ 88 : "[u8;32]" = 32;
        N_ENTRIES @ 120 : "u8" = 1;
        N_SITES_USED @ 121 : "u8" = 1;
        QUIET_OK @ 122 : "u8" = 1;
        RSV_123 @ 123 : "rsv" = 1;
        ROSTER_EPOCH @ 124 : "u32" = 4;
        TERRAIN @ 128 : "[u8;61]" = 61;
        RESOURCE @ 189 : "[u8;61]" = 61;
        SITES @ 250 : "[u8;12]" = 12;
        SITE_COUNT @ 262 : "u8" = 1;
        RSV_263 @ 263 : "rsv" = 1;
        PASSABLE_MASK @ 264 : "u64" = 8;
        ROUGH_MASK @ 272 : "u64" = 8;
        ROAD_MASK @ 280 : "u64" = 8;
        EXPLORED_MASK @ 288 : "u64" = 8;
        SITE_MIRROR @ 296 : "rec:SiteMirrorV2 x12" = 768;
        ENTRIES @ 1064 : "rec:Entry x56" = 2_688;
        RESOLVE_SUMMARY @ 3752 : "rec:ResolveSummary x1" = 32;
        CAMP @ 3784 : "rec:Camp x1" = 16;
        TICKET_COHORTS @ 3800 : "rec:Cohort x8" = 64;
        RSV @ 3864 : "rsv" = 232;
        CONQUEST @ 4096 : "rec:ConquestRecord x12" = 384;
        KEEP @ 4480 : "rec:Keep x1" = 32;
        SNAP @ 4512 : "rec:Snapshot x6" = 120;
        CAPTURES_BY @ 4632 : "[u16;6]" = 12;
        KEEPS_TAKEN_BY @ 4644 : "[u16;6]" = 12;
        RSV_CQ @ 4656 : "rsv" = 80;
    );
    /// Size of the M1 Province (the prefix every v2 Province keeps).
    pub const V1_SIZE: usize = super::V1::SIZE;
    /// The conquest block `[4,096, 4,736)`.
    pub const CQ_BLOCK: core::ops::Range<usize> = CONQUEST..SIZE;
    /// The records and the keep `[4,096, 4,512)` (the CONQUEST log's
    /// `records digest`, §6).
    pub const RECORDS_AND_KEEP: core::ops::Range<usize> = CONQUEST..SNAP;
    pub const SITES_N: usize = super::V1::SITES_N;
    pub const ENTRIES_N: usize = super::V1::ENTRIES_N;
    /// Snapshot ring length (hours, K-13).
    pub const SNAP_N: usize = 6;
    /// Sides of a snapshot: factions 0–5 and neutral 6.
    pub const SIDES: usize = 7;
    /// Player factions (`captures_by`, `keeps_taken_by`).
    pub const FACTIONS: usize = 6;
    const _: () = assert!(CONQUEST == super::V1::SIZE);
    const _: () = assert!(SITES_N * super::conquest::SIZE == 384);
    const _: () = assert!(SNAP_N * super::snapshot::SIZE == 120);

    /// Offset of `site_mirror[i]`.
    pub const fn site(i: usize) -> usize {
        SITE_MIRROR + i * super::site::SIZE
    }
    /// Offset of `entries[i]`.
    pub const fn entry(i: usize) -> usize {
        ENTRIES + i * crate::layout::province::entry::SIZE
    }
    /// Offset of `conquest[i]`.
    pub const fn record(i: usize) -> usize {
        CONQUEST + i * super::conquest::SIZE
    }
    /// Offset of `snap[slot]`.
    pub const fn snap(slot: usize) -> usize {
        SNAP + slot * super::snapshot::SIZE
    }
    /// Offset of `captures_by[f]`.
    pub const fn captures_by(f: usize) -> usize {
        CAPTURES_BY + 2 * f
    }
    /// Offset of `keeps_taken_by[f]`.
    pub const fn keeps_taken_by(f: usize) -> usize {
        KEEPS_TAKEN_BY + 2 * f
    }
}

/// Site mirror v2 (64): M1's mirror with three reserved ranges given a
/// meaning (§5.2.1).
pub mod site {
    crate::layout::fields!(size = 64;
        STATE @ 0 : "u8" = 1;
        FACTION @ 1 : "u8" = 1;
        ORDER @ 2 : "u8" = 1;
        TIER @ 3 : "u8" = 1;
        GEN @ 4 : "u8" = 1;
        TIER_NEXT @ 5 : "u8" = 1;
        HELD_SINCE_HOUR @ 6 : "u16" = 2;
        GARRISON @ 8 : "u32" = 4;
        PEND0_BELL @ 12 : "u32" = 4;
        PEND0_DELTA @ 16 : "i64" = 8;
        PEND1_BELL @ 24 : "u32" = 4;
        TIER_NEXT_BELL @ 28 : "u32" = 4;
        PEND1_DELTA @ 32 : "i64" = 8;
        WALLS_COMMITTED @ 40 : "u32" = 4;
        WALL_ITEM0_BELL @ 44 : "u32" = 4;
        WALL_ITEM0_DELTA @ 48 : "u32" = 4;
        WALL_ITEM1_BELL @ 52 : "u32" = 4;
        WALL_ITEM1_DELTA @ 56 : "u32" = 4;
        SHIELD_UNTIL_BELL @ 60 : "u32" = 4;
    );
    pub use crate::layout::province::site::{
        NO_BELL, STATE_FREE, STATE_HOLDING, STATE_RELEASED_FREE, STATE_RESERVED, STATE_UNUSED_CAMP,
    };
    /// v2: a genesis Free City (faction NEUTRAL, never expires, §3.7).
    pub const STATE_FREE_CITY: u8 = 5;
    /// `tier_next` when no tier-up is pending (a tier-up's new tier is
    /// always above Hamlet = 0).
    pub const NO_TIER_NEXT: u8 = 0;
}

/// Conquest record (32), a tagged union on `kind` (§5.2.1).
pub mod conquest {
    crate::layout::fields!(size = 32;
        KIND @ 0 : "u8" = 1;
        FACTION @ 1 : "u8" = 1;
        FLAGS @ 2 : "u8" = 1;
        PROGRESS @ 3 : "u8" = 1;
        REQUIRED @ 4 : "u8" = 1;
        TARGET @ 5 : "u8" = 1;
        VIGIL_START_MIN @ 6 : "u16" = 2;
        VIGIL_NEXT_MIN @ 8 : "u16" = 2;
        VIGIL_FROM_DAY @ 10 : "u16" = 2;
        BELL @ 12 : "u32" = 4;
        ACTOR @ 16 : "u64" = 8;
        SRC @ 24 : "u64" = 8;
    );
    pub const KIND_NONE: u8 = 0;
    pub const KIND_SIEGE: u8 = 1;
    pub const KIND_OCCUPATION: u8 = 2;
    pub const KIND_CAPTURE_DUE: u8 = 3;

    /// Kind 0 `faction`: the immunity bars every faction (post-capture).
    pub const BARRED_ALL: u8 = 0xFE;
    /// Kind 0 `faction`: the immunity bars nobody.
    pub const BARRED_NONE: u8 = 0xFF;

    /// Kind 1 flag: the besiegers held the hex (always set: declared from
    /// the hex, K-04).
    pub const FLAG_HELD: u8 = 1 << 0;
    /// Kind 0 flag: the stake is owed to the site's Holding at `owed_gen`
    /// (`progress`).
    pub const FLAG_STAKE_TO_HOLDING: u8 = 1 << 1;
    /// Kind 0 flag: the stake is owed to `src` (season end).
    pub const FLAG_STAKE_TO_SRC: u8 = 1 << 2;
    /// Kind 1 flag: a neutral target (Free City: no vigil).
    pub const FLAG_NEUTRAL: u8 = 1 << 3;
    /// Kind 3 flag: the capture is credited (K-26).
    pub const FLAG_CREDITED: u8 = 1 << 4;
    /// Kind 0 flag: the reserved slot `required` is owed back to `actor`.
    pub const FLAG_SLOT_OWED: u8 = 1 << 5;
    /// Kind 0 flags that owe something (SettleSiege's work; S3).
    pub const OWED_MASK: u8 = FLAG_STAKE_TO_HOLDING | FLAG_STAKE_TO_SRC | FLAG_SLOT_OWED;

    /// `target` low nibble: a first holding (order 1).
    pub const TARGET_FIRST: u8 = 1;
    /// `target` low nibble: a holding of order 2–3.
    pub const TARGET_OTHER: u8 = 2;
    /// `target` low nibble: a genesis Free City.
    pub const TARGET_FREE_CITY: u8 = 3;

    /// `target` byte: low nibble the kind of target, high nibble the
    /// reserved slot (2 or 3; 0 for a first holding).
    pub const fn target(kind: u8, slot: u8) -> u8 {
        (kind & 0x0F) | (slot << 4)
    }
    /// The target kind of a `target` byte.
    pub const fn target_kind(t: u8) -> u8 {
        t & 0x0F
    }
    /// The reserved slot of a `target` byte (0 none).
    pub const fn target_slot(t: u8) -> u8 {
        t >> 4
    }
}

/// The keep (32), one per Province (§5.2.1). `tile == 0xFF`: no keep
/// (rings 0–1).
pub mod keep {
    crate::layout::fields!(size = 32;
        TILE @ 0 : "u8" = 1;
        HOLDER @ 1 : "u8" = 1;
        CONTENDER @ 2 : "u8" = 1;
        PROGRESS @ 3 : "u8" = 1;
        REQUIRED @ 4 : "u8" = 1;
        FLAGS @ 5 : "u8" = 1;
        CHANGES @ 6 : "u16" = 2;
        TROOPS @ 8 : "u32" = 4;
        SINCE_BELL @ 12 : "u32" = 4;
        CONSOLIDATED_UNTIL_BELL @ 16 : "u32" = 4;
        CONTEST_FROM_BELL @ 20 : "u32" = 4;
        GEN @ 24 : "u32" = 4;
        LAST_TAKEN_FROM @ 28 : "u8" = 1;
        RSV_29 @ 29 : "rsv" = 3;
    );
    /// `tile` of a Province with no keep (rings 0–1).
    pub const NO_TILE: u8 = 0xFF;
    /// `contender` / `last_taken_from` when none.
    pub const NONE: u8 = 0xFF;
    /// `flags` bit 0: the keep lies in its holder's heartland (never
    /// contested in MC).
    pub const FLAG_HEARTLAND_SAFE: u8 = 1 << 0;
    /// `flags` bit 1: reserved for M3 (paused by a multi-faction hold;
    /// never set under Rivalry, R-09).
    pub const FLAG_PAUSED_M3: u8 = 1 << 1;
}

/// Hourly control snapshot (20) in `Province.snap[6]`, ring slot
/// `hour mod 6` (§3.10).
pub mod snapshot {
    crate::layout::fields!(size = 20;
        HOUR @ 0 : "u32" = 4;
        WEIGHT @ 4 : "[u16;7]" = 14;
        RSV_18 @ 18 : "rsv" = 2;
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bytes 0..4,096 are M1's Province field for field (only the site
    /// mirror record's name changes).
    #[test]
    fn v1_prefix_is_m1() {
        let v1 = V1::FIELDS;
        let v2 = &province::FIELDS[..v1.len()];
        for (a, b) in v1.iter().zip(v2) {
            assert_eq!((a.name, a.off, a.len), (b.name, b.off, b.len));
            if a.name != "SITE_MIRROR" {
                assert_eq!(a.ty, b.ty, "{}", a.name);
            }
        }
        assert_eq!(province::FIELDS[v1.len()].off, 4_096);
        assert_eq!(province::SIZE, 4_736);
    }

    /// The v2 site mirror keeps every M1 field at its M1 offset.
    #[test]
    fn site_mirror_keeps_m1_offsets() {
        use crate::layout::province::site as S1;
        for f in S1::FIELDS {
            if f.ty == "rsv" {
                continue;
            }
            let g = site::FIELDS
                .iter()
                .find(|g| g.name == f.name)
                .unwrap_or_else(|| panic!("{} missing in v2", f.name));
            assert_eq!((g.off, g.len, g.ty), (f.off, f.len, f.ty), "{}", f.name);
        }
        assert_eq!(site::TIER_NEXT, 5);
        assert_eq!(site::HELD_SINCE_HOUR, 6);
        assert_eq!(site::TIER_NEXT_BELL, 28);
    }

    #[test]
    fn conquest_block_offsets_are_the_contract_table() {
        assert_eq!(province::CONQUEST, 4_096);
        assert_eq!(province::KEEP, 4_480);
        assert_eq!(province::SNAP, 4_512);
        assert_eq!(province::CAPTURES_BY, 4_632);
        assert_eq!(province::KEEPS_TAKEN_BY, 4_644);
        assert_eq!(province::RSV_CQ, 4_656);
        assert_eq!(province::record(11), 4_096 + 11 * 32);
        assert_eq!(province::snap(5), 4_512 + 5 * 20);
        assert_eq!(conquest::BELL, 12);
        assert_eq!(conquest::ACTOR, 16);
        assert_eq!(conquest::SRC, 24);
        assert_eq!(keep::TROOPS, 8);
        assert_eq!(keep::GEN, 24);
        assert_eq!(keep::LAST_TAKEN_FROM, 28);
        assert_eq!(conquest::target(conquest::TARGET_OTHER, 3), 0x32);
        assert_eq!(conquest::target_slot(0x32), 3);
        assert_eq!(conquest::target_kind(0x32), 2);
    }
}
