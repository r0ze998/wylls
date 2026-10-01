//! Season v2 (2,048 B, the conquest block at 896..1,024), JoinShard v2
//! (256 B) and MarchState (256 B, new): MC contract §5.2.4–§5.2.6.

/// Season v2 (2,048): M1's Season with `SeasonParams` v2's conquest block
/// at 896..1,024 (offsets inside it: [`crate::v2::presets::cq_layout`]).
pub mod season {
    crate::layout::chained!(b"PSF1SEAS", 2_048;
        STATUS @ 64 : "u8" = 1;
        BUMP @ 65 : "u8" = 1;
        REGIONS @ 66 : "u8" = 1;
        GENESIS_RING @ 67 : "u8" = 1;
        R_MAX @ 68 : "u16" = 2;
        OFFICE_TERMS_PER_WALLET @ 70 : "u8" = 1;
        POSTURES_ENABLED @ 71 : "u8" = 1;
        AUTHORITY @ 72 : "[u8;32]" = 32;
        RULESET_HASH @ 104 : "[u8;32]" = 32;
        RULES_VERSION @ 136 : "u16" = 2;
        PROGRAM_VERSION @ 138 : "u16" = 2;
        BELL_SECS @ 140 : "u32" = 4;
        GENESIS_TS @ 144 : "i64" = 8;
        CREATED_TS @ 152 : "i64" = 8;
        JOIN_CLOSE_BELL @ 160 : "u32" = 4;
        END_BELL @ 164 : "u32" = 4;
        DRAND_GENESIS @ 168 : "i64" = 8;
        DRAND_PERIOD @ 176 : "u32" = 4;
        NETWORK @ 180 : "u8" = 1;
        RSV_181 @ 181 : "rsv" = 3;
        QUICKNET_PK_HASH @ 184 : "[u8;32]" = 32;
        REVEAL_WINDOW @ 216 : "u32" = 4;
        SEED_MARGIN @ 220 : "u32" = 4;
        WINDOW_NEXT @ 224 : "u32" = 4;
        WINDOW_FROM_BELL @ 228 : "u32" = 4;
        GENESIS_ROUND @ 232 : "u64" = 8;
        GENESIS_SEED @ 240 : "[u8;32]" = 32;
        ARCHIVE_AFTER @ 272 : "u32" = 4;
        MIN_LEAD @ 276 : "u8" = 1;
        MAX_LEAD @ 277 : "u8" = 1;
        TRANSIT_SLOTS @ 278 : "u8" = 1;
        RSV_279 @ 279 : "rsv" = 1;
        MARCH_FEE @ 280 : "u64" = 8;
        SEAL_BOND @ 288 : "u64" = 8;
        MIN_REVEAL_PRIORITY_MILLI @ 296 : "u32" = 4;
        REVEAL_CU_LIMIT @ 300 : "u32" = 4;
        BUCKET_RATE_PER_H @ 304 : "u16" = 2;
        BUCKET_BURST @ 306 : "u16" = 2;
        DEFENCE_CAP_MILLI @ 308 : "u32" = 4;
        LATENESS_SLOTS @ 312 : "u8" = 1;
        RSV_313 @ 313 : "rsv" = 3;
        THETA_EARLY_BPS @ 316 : "u16" = 2;
        THETA_LATE_BPS @ 318 : "u16" = 2;
        THETA_SWITCH_SECS @ 320 : "u32" = 4;
        RESERVE_BPS @ 324 : "u16" = 2;
        EXTRA_FREE_BPS @ 326 : "u16" = 2;
        CLASH_CLOSE_GRACE @ 328 : "u32" = 4;
        CAMP_REGROW_BELLS @ 332 : "u32" = 4;
        PARAMS_HASH @ 336 : "[u8;32]" = 32;
        T_CREATE_MIN @ 368 : "i64" = 8;
        ANNOUNCED_TS @ 376 : "i64" = 8;
        CREATION_BOND @ 384 : "u64" = 8;
        PAYOUT_PARAMS_HASH @ 392 : "[u8;32]" = 32;
        SHADE_AUDITOR @ 424 : "[u8;32]" = 32;
        DORMANT_AFTER_SECS @ 456 : "u32" = 4;
        RELEASE_AFTER_SECS @ 460 : "u32" = 4;
        PFUND_INITIAL @ 464 : "u64" = 8;
        DPOOL_INITIAL @ 472 : "u64" = 8;
        REVEAL_LOADED_LIMIT @ 480 : "u32" = 4;
        JOIN_GATE @ 484 : "[u8;32]" = 32;
        RSV_M2M3 @ 516 : "rsv" = 380;
        CONQUEST_PARAMS @ 896 : "rec:ConquestParams x1" = 128;
        RSV_TAIL @ 1024 : "rsv" = 1024;
    );
    pub use crate::layout::world::season::{
        effective_status, NETWORK_QUICKNET, PDA_PREFIX, STATUS_ABORTED, STATUS_ANNOUNCED,
        STATUS_CLOSED, STATUS_CREATED, STATUS_ENDED, STATUS_RUNNING, STATUS_SEEDED, TOMBSTONE_SIZE,
        WINDOW_NONE,
    };
    /// `program_version` of an MC season (CreateSeason v2 refuses 1).
    pub const PROGRAM_VERSION_V2: u16 = 2;
}

/// JoinShard v2 (256): `js‖faction,shard`.
pub mod join_shard {
    crate::layout::chained!(b"PSF1JSHD", 256;
        FACTION @ 64 : "u8" = 1;
        SHARD @ 65 : "u8" = 1;
        RSV_66 @ 66 : "rsv" = 2;
        MEMBERS @ 68 : "u32" = 4;
        HOLDINGS @ 72 : "u32" = 4;
        FINAL_HOLDINGS @ 76 : "u32" = 4;
        HOLDINGS_BY_WEDGE @ 80 : "[u32;6]" = 24;
        RELEASED @ 104 : "u32" = 4;
        EXTRA_HOLDINGS @ 108 : "u32" = 4;
        CAPTURED_IN @ 112 : "u32" = 4;
        CAPTURED_OUT @ 116 : "u32" = 4;
        RAZED @ 120 : "u32" = 4;
        OUTPOSTS @ 124 : "u32" = 4;
        RSV @ 128 : "rsv" = 128;
    );
    pub use crate::layout::world::join_shard::{FACTIONS, SHARDS_PER_FACTION};
}

/// MarchState (256, new): `mc‖m i32, n i32`, chained, entity kind 8,
/// magic `PSF1MRCH` (§5.2.6).
pub mod march_state {
    crate::layout::chained!(b"PSF1MRCH", 256;
        M @ 64 : "i32" = 4;
        N @ 68 : "i32" = 4;
        NEXT_HOUR @ 72 : "u32" = 4;
        CONTROLLER @ 76 : "u8" = 1;
        CONTESTED @ 77 : "u8" = 1;
        RSV_78 @ 78 : "rsv" = 2;
        LAST_FLIP_HOUR @ 80 : "u32" = 4;
        LOST_HOURS @ 84 : "u32" = 4;
        WEIGHT @ 88 : "[u32;7]" = 28;
        DOMINION_BELLS @ 116 : "[u32;6]" = 24;
        CONTROL_HOURS @ 140 : "[u32;6]" = 24;
        CAPTURES @ 164 : "[u16;6]" = 12;
        RENT_TO @ 176 : "[u8;32]" = 32;
        RSV @ 208 : "rsv" = 48;
    );
    /// `controller` of a contested or open March.
    pub const CONTROLLER_NONE: u8 = 0xFF;
    /// `controller` value of the neutral side.
    pub const CONTROLLER_NEUTRAL: u8 = 6;
    /// Offset of `weight[side]`.
    pub const fn weight(side: usize) -> usize {
        WEIGHT + 4 * side
    }
    /// Offset of `dominion_bells[f]`.
    pub const fn dominion_bells(f: usize) -> usize {
        DOMINION_BELLS + 4 * f
    }
    /// Offset of `control_hours[f]`.
    pub const fn control_hours(f: usize) -> usize {
        CONTROL_HOURS + 4 * f
    }
    /// Offset of `captures[f]`.
    pub const fn captures(f: usize) -> usize {
        CAPTURES + 2 * f
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::world as v1;

    #[test]
    fn season_and_shard_keep_m1_fields() {
        for f in v1::season::FIELDS {
            if f.name == "RSV_M2M3" {
                continue;
            }
            let g = season::FIELDS.iter().find(|g| g.name == f.name).unwrap();
            assert_eq!((g.off, g.len, g.ty), (f.off, f.len, f.ty), "{}", f.name);
        }
        for f in v1::join_shard::FIELDS {
            if f.name == "RSV" {
                continue;
            }
            let g = join_shard::FIELDS
                .iter()
                .find(|g| g.name == f.name)
                .unwrap();
            assert_eq!((g.off, g.len, g.ty), (f.off, f.len, f.ty), "{}", f.name);
        }
        assert_eq!(season::CONQUEST_PARAMS, 896);
        assert_eq!(season::RSV_TAIL, 1_024);
        assert_eq!(join_shard::EXTRA_HOLDINGS, 108);
        assert_eq!(join_shard::OUTPOSTS, 124);
    }

    #[test]
    fn march_state_is_the_contract_table() {
        use march_state as M;
        assert_eq!(M::SIZE, 256);
        assert_eq!(M::NEXT_HOUR, 72);
        assert_eq!(M::CONTROLLER, 76);
        assert_eq!(M::LAST_FLIP_HOUR, 80);
        assert_eq!(M::LOST_HOURS, 84);
        assert_eq!(M::WEIGHT, 88);
        assert_eq!(M::DOMINION_BELLS, 116);
        assert_eq!(M::CONTROL_HOURS, 140);
        assert_eq!(M::CAPTURES, 164);
        assert_eq!(M::RENT_TO, 176);
        assert_eq!(M::RSV, 208);
        assert_eq!(&M::MAGIC, b"PSF1MRCH");
    }
}
