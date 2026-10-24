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
