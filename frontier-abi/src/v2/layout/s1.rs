//! S1 (redesign stage 1) accounts: the Vault (kind 19) and the Caravan
//! (kind 20) of stage 1b (`docs/frontier/stage1b/S1-1B-CONTRACT.md` §1).
//! Both are chained v2 accounts (`layout_version` 2).

/// Vault (512 B): `va‖P,Q,tile`.
pub mod vault {
    crate::layout::chained!(b"PSF1VALT", 512;
        P @ 64 : "i16" = 2;
        Q @ 66 : "i16" = 2;
        TILE @ 68 : "u8" = 1;
        STATE @ 69 : "u8" = 1;
        FACTION @ 70 : "u8" = 1;
        GEN @ 71 : "u8" = 1;
        OWNER_CITIZEN @ 72 : "[u8;32]" = 32;
        OWNER_TAG @ 104 : "u64" = 8;
        BUILT_TS @ 112 : "i64" = 8;
        STORES @ 120 : "[i64;8]" = 64;
        CAP @ 184 : "i64" = 8;
        SENT @ 192 : "u32" = 4;
        SEIZED_BELL @ 196 : "u32" = 4;
        RENT_TO @ 200 : "[u8;32]" = 32;
        RSV @ 232 : "rsv" = 280;
    );
    pub const STATE_NONE: u8 = 0;
    pub const STATE_LIVE: u8 = 1;
    /// Offset of `stores[r]`.
    pub const fn store(r: usize) -> usize {
        STORES + 8 * r
    }
}

/// A caravan's origin or destination (16 B).
pub mod place {
    crate::layout::fields!(size = 16;
        KIND @ 0 : "u8" = 1;
        P @ 1 : "i16" = 2;
        Q @ 3 : "i16" = 2;
        SITE_OR_TILE @ 5 : "u8" = 1;
        GEN @ 6 : "u8" = 1;
        TILE @ 7 : "u8" = 1;
        RSV_8 @ 8 : "rsv" = 8;
    );
    pub const KIND_HOLDING: u8 = 1;
    pub const KIND_VAULT: u8 = 2;
}

/// Caravan (320 B): `cv‖owner_tag,seq`.
pub mod caravan {
    crate::layout::chained!(b"PSF1CRVN", 320;
        OWNER_CITIZEN @ 64 : "[u8;32]" = 32;
        OWNER_TAG @ 96 : "u64" = 8;
        SEQ @ 104 : "u32" = 4;
        FACTION @ 108 : "u8" = 1;
        STATE @ 109 : "u8" = 1;
        STEPS @ 110 : "u8" = 1;
        N_PROV @ 111 : "u8" = 1;
        SRC @ 112 : "rec:Place x1" = 16;
        DST @ 128 : "rec:Place x1" = 16;
        PATH @ 144 : "[u8;12]" = 12;
        PROVINCES @ 156 : "[i16;8]" = 16;
        DEPART_TS @ 172 : "i64" = 8;
        ARRIVE_TS @ 180 : "i64" = 8;
        LAST_BELL @ 188 : "u32" = 4;
        CARGO @ 192 : "[i64;8]" = 64;
        FEE @ 256 : "u64" = 8;
        RENT_TO @ 264 : "[u8;32]" = 32;
        RSV @ 296 : "rsv" = 24;
    );
    pub const STATE_NONE: u8 = 0;
    pub const STATE_MOVING: u8 = 1;
    pub const STATE_DELIVERED: u8 = 2;
    pub const STATE_LOST: u8 = 3;
    /// Offset of `cargo[r]`.
    pub const fn cargo(r: usize) -> usize {
        CARGO + 8 * r
    }
    /// Offset of province `i`'s (P, Q).
    pub const fn province(i: usize) -> usize {
        PROVINCES + 4 * i
    }
}
