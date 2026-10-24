//! S2 (redesign stage 2) accounts: the ticket Issue (kind 23) and Lot
//! (kind 24) of stage 2a (`docs/frontier/stage2/S2-2A-CONTRACT.md` §2).
//! Both are chained v2 accounts (`layout_version` 2).

/// Issue (256 B): `ti‖issuer_tag,seq`.
pub mod issue {
    crate::layout::chained!(b"PSF1ISSU", 256;
        KIND @ 64 : "u8" = 1;
        STATE @ 65 : "u8" = 1;
        SRC_KIND @ 66 : "u8" = 1;
        SRC_GEN @ 67 : "u8" = 1;
        P @ 68 : "i16" = 2;
        Q @ 70 : "i16" = 2;
        AT @ 72 : "u8" = 1;
        RESOURCE @ 73 : "u8" = 1;
        RSV_74 @ 74 : "rsv" = 2;
        SEQ @ 76 : "u32" = 4;
        ISSUER_CITIZEN @ 80 : "[u8;32]" = 32;
        ISSUER_TAG @ 112 : "u64" = 8;
        SUPPLY @ 120 : "u64" = 8;
        PER_UNIT @ 128 : "u64" = 8;
        UNTIL_DAY @ 136 : "u32" = 4;
        CREATED_BELL @ 140 : "u32" = 4;
        // The source's stamp when issued (a vault's BUILT_TS, a holding's
        // FOUNDED_TS): a source rebuilt at the same place and generation is
        // another source (its tickets stay void).
        SRC_STAMP @ 144 : "i64" = 8;
        PERIOD @ 152 : "rsv" = 40;
        RENT_TO @ 192 : "[u8;32]" = 32;
        RSV @ 224 : "rsv" = 32;
    );
    pub use permutation_rules::frontier::ticket::{
        KIND_DELIVERY, KIND_RECEIPT, KIND_SHARE, KIND_USE, SRC_HOLDING, SRC_VAULT, STATE_CLOSED,
        STATE_LIVE,
    };
}

/// Lot (192 B): `tl‖seed_tag,seq` (`SEED_TAG` the first holder's tag;
/// a whole-lot gift rewrites `HOLDER_*` and keeps the address).
pub mod lot {
    crate::layout::chained!(b"PSF1TLOT", 192;
        ISSUER_TAG @ 64 : "u64" = 8;
        ISSUE_SEQ @ 72 : "u32" = 4;
        KIND @ 76 : "u8" = 1;
        SRC_GEN @ 77 : "u8" = 1;
        STATE @ 78 : "u8" = 1;
        RSV_79 @ 79 : "rsv" = 1;
        HOLDER_CITIZEN @ 80 : "[u8;32]" = 32;
        HOLDER_TAG @ 112 : "u64" = 8;
        SEED_TAG @ 120 : "u64" = 8;
        SEQ @ 128 : "u32" = 4;
        DAY @ 132 : "u32" = 4;
        AMOUNT @ 136 : "u64" = 8;
        DAY_AMOUNT @ 144 : "u64" = 8;
        ESCROW @ 152 : "u64" = 8;
        RENT_TO @ 160 : "[u8;32]" = 32;
    );
    pub use permutation_rules::frontier::ticket::{STATE_CLOSED, STATE_LIVE};
}

/// Escrow (272 B): `te‖maker_tag,seq` (2e, `S2-2E-CONTRACT.md` §2.1). Two
/// sides of 80 B: the maker's at 80, the taker's at 160 ([`side`]).
pub mod escrow {
    crate::layout::chained!(b"PSF1ESCR", 272;
        STATE @ 64 : "u8" = 1;
        RSV_65 @ 65 : "rsv" = 3;
        SEQ @ 68 : "u32" = 4;
        DEADLINE_BELL @ 72 : "u32" = 4;
        OPENED_BELL @ 76 : "u32" = 4;
        MAKER_CITIZEN @ 80 : "[u8;32]" = 32;
        MAKER_TAG @ 112 : "u64" = 8;
        MAKER_KIND @ 120 : "u8" = 1;
        MAKER_STATE @ 121 : "u8" = 1;
        MAKER_RESOURCE @ 122 : "u8" = 1;
        MAKER_GEN @ 123 : "u8" = 1;
        MAKER_P @ 124 : "i16" = 2;
        MAKER_Q @ 126 : "i16" = 2;
        MAKER_TILE @ 128 : "u8" = 1;
        RSV_129 @ 129 : "rsv" = 7;
        MAKER_AMOUNT @ 136 : "u64" = 8;
        MAKER_LOT_TAG @ 144 : "u64" = 8;
        MAKER_LOT_SEQ @ 152 : "u32" = 4;
        MAKER_STAMP @ 156 : "u32" = 4;
        TAKER_CITIZEN @ 160 : "[u8;32]" = 32;
        TAKER_TAG @ 192 : "u64" = 8;
        TAKER_KIND @ 200 : "u8" = 1;
        TAKER_STATE @ 201 : "u8" = 1;
        TAKER_RESOURCE @ 202 : "u8" = 1;
        TAKER_GEN @ 203 : "u8" = 1;
        TAKER_P @ 204 : "i16" = 2;
        TAKER_Q @ 206 : "i16" = 2;
        TAKER_TILE @ 208 : "u8" = 1;
        RSV_209 @ 209 : "rsv" = 7;
        TAKER_AMOUNT @ 216 : "u64" = 8;
        TAKER_LOT_TAG @ 224 : "u64" = 8;
        TAKER_LOT_SEQ @ 232 : "u32" = 4;
        TAKER_STAMP @ 236 : "u32" = 4;
        RENT_TO @ 240 : "[u8;32]" = 32;
    );
    pub const STATE_OPEN: u8 = 1;
    pub const STATE_SETTLED: u8 = 2;
    /// An item's kind.
    pub const ITEM_GOODS: u8 = 1;
    pub const ITEM_LOT: u8 = 2;
    /// A side's state.
    pub const SIDE_PROMISED: u8 = 0;
    pub const SIDE_IN: u8 = 1;
    pub const SIDE_OWED: u8 = 2;
    pub const SIDE_DONE: u8 = 3;
    /// Offsets inside a side (from [`side`]).
    pub mod side {
        pub const CITIZEN: usize = 0;
        pub const TAG: usize = 32;
        pub const KIND: usize = 40;
        pub const STATE: usize = 41;
        pub const RESOURCE: usize = 42;
        pub const GEN: usize = 43;
        pub const P: usize = 44;
        pub const Q: usize = 46;
        pub const TILE: usize = 48;
        pub const AMOUNT: usize = 56;
        pub const LOT_TAG: usize = 64;
        pub const LOT_SEQ: usize = 72;
        /// A goods side's vault stamp: the low 32 bits of its `BUILT_TS`
        /// (a vault closed and built again is another vault).
        pub const STAMP: usize = 76;
        pub const SIZE: usize = 80;
    }
    /// The start of side `i` (0 the maker's, 1 the taker's).
    pub const fn side(i: usize) -> usize {
        MAKER_CITIZEN + i * side::SIZE
    }
}

