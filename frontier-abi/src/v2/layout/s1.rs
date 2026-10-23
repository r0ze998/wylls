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

/// Structure (256 B): `tw‖P,Q,tile` (S1: a tower, 1d; a palisade or a
/// fort, 1e; `S1-1E-CONTRACT.md` §2.1).
pub mod structure {
    crate::layout::chained!(b"PSF1STRC", 256;
        P @ 64 : "i16" = 2;
        Q @ 66 : "i16" = 2;
        TILE @ 68 : "u8" = 1;
        STATE @ 69 : "u8" = 1;
        FACTION @ 70 : "u8" = 1;
        GEN @ 71 : "u8" = 1;
        OWNER_CITIZEN @ 72 : "[u8;32]" = 32;
        OWNER_TAG @ 104 : "u64" = 8;
        BUILT_TS @ 112 : "i64" = 8;
        SEIZED_BELL @ 120 : "u32" = 4;
        NOTIFY @ 124 : "u8" = 1;
        ENTRY @ 125 : "u8" = 1;
        KIND @ 126 : "u8" = 1;
        RSV_127 @ 127 : "rsv" = 1;
        RENT_TO @ 128 : "[u8;32]" = 32;
        RSV @ 160 : "rsv" = 96;
    );
    pub const STATE_NONE: u8 = 0;
    pub const STATE_LIVE: u8 = 1;
    /// `NOTIFY`: the herald tells the owner.
    pub const NOTIFY_OWNER: u8 = 0;
    /// `NOTIFY`: the herald tells the owner's faction.
    pub const NOTIFY_FACTION: u8 = 1;
    pub use permutation_rules::frontier::structure::{KIND_FORT, KIND_PALISADE, KIND_TOWER};
}

/// Nation (384 B): `na‖faction` (S1 1e; `S1-1E-CONTRACT.md` §3.1): a
/// faction's proposals (stances, expulsions, readmissions). Created at its
/// first Propose.
pub mod nation {
    crate::layout::chained!(b"PSF1NATN", 384;
        FACTION @ 64 : "u8" = 1;
        RSV_65 @ 65 : "rsv" = 3;
        NEXT_ID @ 68 : "u32" = 4;
        PROPOSALS @ 72 : "rec:Proposal x4" = 256;
        RSV @ 328 : "rsv" = 56;
    );
    /// Proposal slots.
    pub const N: usize = permutation_rules::frontier::nation::PROPOSALS;
    /// Offset of proposal slot `i`.
    pub const fn at(i: usize) -> usize {
        PROPOSALS + super::proposal::SIZE * i
    }
    const _: () = assert!(super::proposal::SIZE * N == 256);
}

/// One proposal of a Nation (64 B; `nation::Proposal`).
pub mod proposal {
    crate::layout::fields!(size = 64;
        ID @ 0 : "u32" = 4;
        STATE @ 4 : "u8" = 1;
        KIND @ 5 : "u8" = 1;
        TARGET_FACTION @ 6 : "u8" = 1;
        VALUE @ 7 : "u8" = 1;
        OPEN_BELL @ 8 : "u32" = 4;
        CLOSE_BELL @ 12 : "u32" = 4;
        YES @ 16 : "u16" = 2;
        NO @ 18 : "u16" = 2;
        PROPOSER_TAG @ 20 : "u64" = 8;
        TARGET @ 28 : "[u8;32]" = 32;
        RSV_60 @ 60 : "rsv" = 4;
    );
    pub use permutation_rules::frontier::nation::{
        KIND_EXPEL, KIND_READMIT, KIND_STANCE, STATE_FAILED, STATE_NONE, STATE_OPEN, STATE_PASSED,
    };
    const _: () = assert!(SIZE == permutation_rules::frontier::nation::PROPOSAL_SIZE);
}

/// The S1 reading of an ArrivalSlot (1d): the v1 table keeps the name
/// `RSV_54` (the MC layout tables are unchanged); in an S1 season Reveal
/// writes the march's tower wear there.
pub mod arrival {
    /// The march's tower wear (u16, bps; `structure::wear_bps`).
    pub const WORN_BPS: usize = crate::layout::clash::arrival_slot::RSV_54;
    const _: () = assert!(WORN_BPS == 54);
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
