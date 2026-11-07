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
        CUSTODY_QUOTA @ 232 : "[i64;8]" = 64;
        CUSTODY_LOTS @ 296 : "u16" = 2;
        RSV @ 298 : "rsv" = 214;
    );
    pub const STATE_NONE: u8 = 0;
    pub const STATE_LIVE: u8 = 1;
    /// Offset of `custody_quota[r]` (workstream 10: room committed to lots;
    /// `STORES[r] + CUSTODY_QUOTA[r] ≤ CAP`).
    pub const fn custody_quota(r: usize) -> usize {
        CUSTODY_QUOTA + 8 * r
    }
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
        CUSTODY @ 296 : "u8" = 1;
        CUSTODY_RESOURCE @ 297 : "u8" = 1;
        RSV_298 @ 298 : "rsv" = 6;
        CUSTODY_OWNER_TAG @ 304 : "u64" = 8;
        TAKEN_BY_TAG @ 312 : "u64" = 8;
    );
    pub const STATE_NONE: u8 = 0;
    pub const STATE_MOVING: u8 = 1;
    /// `CUSTODY` (workstream 10): an ordinary caravan.
    pub const CUSTODY_NONE: u8 = 0;
    /// The cargo is `CUSTODY_OWNER_TAG`'s, bound for its lot at `DST`.
    pub const CUSTODY_LOT: u8 = 1;
    /// A custody caravan taken by a raider (J2): the raider's, its lot's
    /// inbound ref a `Raided` loss at ReconcileLot.
    pub const CUSTODY_TAKEN: u8 = 2;
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

/// Lot (576 B): `cl‖P,Q,tile,gen,owner_tag,resource` (workstream 10:
/// custody; `workstreams/10-custody/02-contract.ja.md` §2.1). The goods of
/// one owner, of one resource, kept in another's vault of one generation;
/// never part of the vault's `STORES`. The offsets are the custody
/// kernel's (`permutation_rules::frontier::custody::layout::lot`).
pub mod lot {
    crate::layout::chained!(b"PSF1CLOT", 576;
        P @ 64 : "i16" = 2;
        Q @ 66 : "i16" = 2;
        TILE @ 68 : "u8" = 1;
        VAULT_GEN @ 69 : "u8" = 1;
        RESOURCE @ 70 : "u8" = 1;
        STATE @ 71 : "u8" = 1;
        OWNER_CITIZEN @ 72 : "[u8;32]" = 32;
        OWNER_TAG @ 104 : "u64" = 8;
        CUSTODIAN_TAG @ 112 : "u64" = 8;
        QUOTA @ 120 : "i64" = 8;
        HELD @ 128 : "i64" = 8;
        IN_TOTAL @ 136 : "i64" = 8;
        OUT_TOTAL @ 144 : "i64" = 8;
        CONSUMED @ 152 : "i64" = 8;
        FORFEITED @ 160 : "i64" = 8;
        NONCE @ 168 : "u32" = 4;
        OPENED_BELL @ 172 : "u32" = 4;
        ORDERS @ 176 : "rec:LotOrder x4" = 256;
        INBOUND @ 432 : "rec:LotInbound x4" = 96;
        RENT_TO @ 528 : "[u8;32]" = 32;
        RSV @ 560 : "rsv" = 16;
    );
    pub use permutation_rules::frontier::custody::{LOT_FORFEITED, LOT_NONE, LOT_OPEN};
}

/// A lot's order slot (64 B).
pub mod lot_order {
    crate::layout::fields!(size = 64;
        KIND @ 0 : "u8" = 1;
        RSV_1 @ 1 : "rsv" = 1;
        PURPOSE @ 2 : "u16" = 2;
        ID @ 4 : "u32" = 4;
        EXPIRES_BELL @ 8 : "u32" = 4;
        DST @ 12 : "[u8;8]" = 8;
        GRANTEE @ 20 : "[u8;32]" = 32;
        RSV_52 @ 52 : "rsv" = 4;
        QTY_LEFT @ 56 : "i64" = 8;
    );
}

/// A lot's inbound caravan ref (24 B).
pub mod lot_inbound {
    crate::layout::fields!(size = 24;
        CARAVAN_TAG @ 0 : "u64" = 8;
        SEQ @ 8 : "u32" = 4;
        LIVE @ 12 : "u8" = 1;
        RSV_13 @ 13 : "rsv" = 3;
        QTY @ 16 : "i64" = 8;
    );
}

#[cfg(test)]
mod custody_tests {
    use permutation_rules::frontier::custody::layout as k;

    /// The ABI's offsets are the kernel's.
    #[test]
    fn custody_offsets_are_the_kernels() {
        use super::{caravan as cv, lot, lot_inbound as li, lot_order as lo, vault as va};
        assert_eq!(lot::MAGIC, k::lot::MAGIC);
        assert_eq!(lot::SIZE, k::lot::SIZE);
        let pairs = [
            (lot::P, k::lot::P),
            (lot::Q, k::lot::Q),
            (lot::TILE, k::lot::TILE),
            (lot::VAULT_GEN, k::lot::VAULT_GEN),
            (lot::RESOURCE, k::lot::RESOURCE),
            (lot::STATE, k::lot::STATE),
            (lot::OWNER_CITIZEN, k::lot::OWNER_CITIZEN),
            (lot::OWNER_TAG, k::lot::OWNER_TAG),
            (lot::CUSTODIAN_TAG, k::lot::CUSTODIAN_TAG),
            (lot::QUOTA, k::lot::QUOTA),
            (lot::HELD, k::lot::HELD),
            (lot::IN_TOTAL, k::lot::IN_TOTAL),
            (lot::OUT_TOTAL, k::lot::OUT_TOTAL),
            (lot::CONSUMED, k::lot::CONSUMED),
            (lot::FORFEITED, k::lot::FORFEITED),
            (lot::NONCE, k::lot::NONCE),
            (lot::OPENED_BELL, k::lot::OPENED_BELL),
            (lot::ORDERS, k::lot::ORDERS),
            (lot::INBOUND, k::lot::INBOUND),
            (lot::RENT_TO, k::lot::RENT_TO),
            (lot::RSV, k::lot::RSV),
            (lo::SIZE, k::lot::ORDER_SIZE),
            (lo::KIND, k::lot::order::KIND),
            (lo::PURPOSE, k::lot::order::PURPOSE),
            (lo::ID, k::lot::order::ID),
            (lo::EXPIRES_BELL, k::lot::order::EXPIRES_BELL),
            (lo::DST, k::lot::order::DST),
            (lo::GRANTEE, k::lot::order::GRANTEE),
            (lo::QTY_LEFT, k::lot::order::QTY_LEFT),
            (li::SIZE, k::lot::INBOUND_SIZE),
            (li::CARAVAN_TAG, k::lot::inbound::CARAVAN_TAG),
            (li::SEQ, k::lot::inbound::SEQ),
            (li::LIVE, k::lot::inbound::LIVE),
            (li::QTY, k::lot::inbound::QTY),
            (va::CUSTODY_QUOTA, k::vault_custody::CUSTODY_QUOTA),
            (va::CUSTODY_LOTS, k::vault_custody::CUSTODY_LOTS),
            (cv::CUSTODY, k::caravan_custody::CUSTODY),
            (cv::CUSTODY_RESOURCE, k::caravan_custody::CUSTODY_RESOURCE),
            (cv::CUSTODY_OWNER_TAG, k::caravan_custody::CUSTODY_OWNER_TAG),
            (cv::TAKEN_BY_TAG, k::caravan_custody::TAKEN_BY_TAG),
            (
                cv::CUSTODY_LOT as usize,
                k::caravan_custody::CUSTODY_LOT as usize,
            ),
            (
                cv::CUSTODY_TAKEN as usize,
                k::caravan_custody::CUSTODY_TAKEN as usize,
            ),
        ];
        for (i, (a, b)) in pairs.iter().enumerate() {
            assert_eq!(a, b, "pair {i}");
        }
    }
}
