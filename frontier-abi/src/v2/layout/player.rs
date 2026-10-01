//! Citizen v2 (384 B) and Holding v2 (1,280 B): M1's sizes, reserved bytes
//! given a meaning (MC contract §5.2.2, §5.2.3).

/// Citizen v2 (384): `ct‖tag15(wallet)`.
pub mod citizen {
    crate::layout::chained!(b"PSF1CITZ", 384;
        WALLET @ 64 : "[u8;32]" = 32;
        SESSION @ 96 : "[u8;32]" = 32;
        SESSION_EXPIRY @ 128 : "i64" = 8;
        FACTION @ 136 : "u8" = 1;
        FLAGS @ 137 : "u8" = 1;
        HOLDINGS_N @ 138 : "u8" = 1;
        EXPLORES_FLOOR_LEFT @ 139 : "u8" = 1;
        JOIN_BELL @ 140 : "u32" = 4;
        JOIN_SHARD @ 144 : "u8" = 1;
        SIEGES_TODAY @ 145 : "u8" = 1;
        VIGIL_START_MIN @ 146 : "u16" = 2;
        VIGIL_NEXT_MIN @ 148 : "u16" = 2;
        SIEGE_DAY @ 150 : "u16" = 2;
        VIGIL_FROM_TS @ 152 : "i64" = 8;
        BUCKET_MILLI @ 160 : "u32" = 4;
        BUCKET_T @ 164 : "u32" = 4;
        HOLDING @ 168 : "rec:HoldingRef x3" = 18;
        OFFICE_TERMS_USED @ 186 : "u8" = 1;
        SLOTS @ 187 : "u8" = 1;
        TICKET_BELL @ 188 : "u32" = 4;
        TICKET_SITES @ 192 : "rec:TicketSite x3" = 15;
        TICKET_NEXT @ 207 : "u8" = 1;
        CITIZEN_TAG @ 208 : "u64" = 8;
        LAST_ACTION_TS @ 216 : "i64" = 8;
        WORKS @ 224 : "u64" = 8;
        EXPLORES @ 232 : "u32" = 4;
        ARRIVALS @ 236 : "u32" = 4;
        RENT_PAYER @ 240 : "[u8;32]" = 32;
        TICKET_ESCROW @ 272 : "u64" = 8;
        TICKET_FUNDER @ 280 : "[u8;32]" = 32;
        RSV @ 312 : "rsv" = 72;
    );
    pub use crate::layout::player::citizen::{
        EXPLORES_FLOOR, FLAG_FIRST_HOLDING_FINAL, FLAG_JOINED, FLAG_PROVISIONAL, FLAG_REFUGEE,
        MAX_HOLDINGS, MAX_SESSION_SECS, MAX_TICKET_SITES, NO_TICKET, TAG_DOMAIN,
    };

    /// `slots` bits 0–1: the open ticket's slot (0 none, 1 first holding,
    /// 2 or 3 an outpost).
    pub const SLOTS_TICKET_MASK: u8 = 0b11;
    /// `slots` bit 2: slot 2 reserved by a capture siege (K-25).
    pub const SLOTS_RESERVED_2: u8 = 1 << 2;
    /// `slots` bit 3: slot 3 reserved by a capture siege (K-25).
    pub const SLOTS_RESERVED_3: u8 = 1 << 3;
    /// An empty `holding[i]` entry has `gen = 0xFF` (v1.1: the list is
    /// indexed by slot, entry i is slot i + 1).
    pub const EMPTY_GEN: u8 = 0xFF;

    /// The `slots` bit reserving `slot` (2 or 3; 0 for any other).
    pub const fn reserved_bit(slot: u8) -> u8 {
        match slot {
            2 => SLOTS_RESERVED_2,
            3 => SLOTS_RESERVED_3,
            _ => 0,
        }
    }

    /// Offset of `holding[slot − 1]` (slot 1–3).
    pub const fn holding_of_slot(slot: u8) -> usize {
        HOLDING + (slot as usize).saturating_sub(1) * crate::layout::player::holding_ref::SIZE
    }

    /// The lowest free slot among 2–3 (§3.1: no holding, no open ticket
    /// on it and no capture reservation), from the Citizen's `slots` byte
    /// and the generation byte of `holding[1]` and `holding[2]`.
    pub const fn lowest_free_slot(slots: u8, gen_slot2: u8, gen_slot3: u8) -> Option<u8> {
        let ticket = slots & SLOTS_TICKET_MASK;
        if gen_slot2 == EMPTY_GEN && ticket != 2 && slots & SLOTS_RESERVED_2 == 0 {
            Some(2)
        } else if gen_slot3 == EMPTY_GEN && ticket != 3 && slots & SLOTS_RESERVED_3 == 0 {
            Some(3)
        } else {
            None
        }
    }
}

/// Holding v2 (1,280): `ho‖P,Q,site`.
pub mod holding {
    crate::layout::chained!(b"PSF1HOLD", 1_280;
        P @ 64 : "i16" = 2;
        Q @ 66 : "i16" = 2;
        SITE @ 68 : "u8" = 1;
        GEN @ 69 : "u8" = 1;
        TILE @ 70 : "u8" = 1;
        STATE @ 71 : "u8" = 1;
        OWNER_CITIZEN @ 72 : "[u8;32]" = 32;
        TICKET_SCORE @ 104 : "u64" = 8;
        FACTION @ 112 : "u8" = 1;
        ORDER @ 113 : "u8" = 1;
        TIER @ 114 : "u8" = 1;
        FLAGS @ 115 : "u8" = 1;
        TICKET_BELL @ 116 : "u32" = 4;
        FOUNDED_TS @ 120 : "i64" = 8;
        FOUNDED_DAY @ 128 : "u32" = 4;
        HOST_SEQ @ 132 : "u32" = 4;
        LAST_OWNER_ACTION @ 136 : "i64" = 8;
        SHIELD_UNTIL @ 144 : "i64" = 8;
        STORES @ 152 : "rec:Accrual x8" = 320;
        PRODUCTION @ 472 : "[i64;8]" = 64;
        UPKEEP @ 536 : "[i64;8]" = 64;
        QUEUE @ 600 : "rec:QueueItem x4" = 96;
        WALLS @ 696 : "u32" = 4;
        RSV_700 @ 700 : "rsv" = 4;
        WALLS_COMMITTED_BEFORE @ 704 : "i64" = 8;
        FOOD_SHORTFALL @ 712 : "i64" = 8;
        RESERVE @ 720 : "[u32;8]" = 32;
        DELEGATE @ 752 : "[u8;32]" = 32;
        TRANSIT @ 784 : "rec:Transit x4" = 384;
        EXPLORE @ 1168 : "rec:ExploreRecord x1" = 24;
        ESCROW @ 1192 : "u64" = 8;
        RENT_PAYER @ 1200 : "[u8;32]" = 32;
        FINAL_TS @ 1232 : "i64" = 8;
        POOL_OWED @ 1240 : "u64" = 8;
        PREV_OWNER_TAG @ 1248 : "u64" = 8;
        PREV_GEN @ 1256 : "u8" = 1;
        CAPTURE_FLAGS @ 1257 : "u8" = 1;
        RSV_1258 @ 1258 : "rsv" = 2;
        CAPTURED_BELL @ 1260 : "u32" = 4;
        PREV_HOME @ 1264 : "u64" = 8;
        RSV_1272 @ 1272 : "rsv" = 8;
    );
    pub use crate::layout::player::holding::{
        queue, reserve, store, transit, FLAG_DORMANT_CACHE, QUEUE_N, RESERVE_N, STATE_FINAL,
        STATE_NONE, STATE_PROVISIONAL, STATE_RELEASED, STORES_N, TRANSIT_N,
    };
    /// `capture_flags` bit 0: the Holding was captured (v1.1: no raze value).
    pub const CAPTURE_FLAG_CAPTURED: u8 = 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::player as v1;

    fn same_except(v1f: &[crate::layout::Field], v2f: &[crate::layout::Field], changed: &[&str]) {
        for f in v1f {
            if changed.contains(&f.name) {
                continue;
            }
            let g = v2f
                .iter()
                .find(|g| g.name == f.name)
                .unwrap_or_else(|| panic!("{} missing", f.name));
            assert_eq!((g.off, g.len, g.ty), (f.off, f.len, f.ty), "{}", f.name);
        }
    }

    #[test]
    fn v2_keeps_every_m1_field() {
        same_except(
            v1::citizen::FIELDS,
            citizen::FIELDS,
            &["RSV_145", "RSV_150", "RSV_187"],
        );
        same_except(v1::holding::FIELDS, holding::FIELDS, &["RSV"]);
        assert_eq!(citizen::SIEGES_TODAY, 145);
        assert_eq!(citizen::SIEGE_DAY, 150);
        assert_eq!(citizen::SLOTS, 187);
        assert_eq!(holding::PREV_OWNER_TAG, 1_248);
        assert_eq!(holding::PREV_GEN, 1_256);
        assert_eq!(holding::CAPTURE_FLAGS, 1_257);
        assert_eq!(holding::CAPTURED_BELL, 1_260);
        assert_eq!(holding::PREV_HOME, 1_264);
    }

    #[test]
    fn slots_follow_k25() {
        use citizen::*;
        const E: u8 = EMPTY_GEN;
        assert_eq!(lowest_free_slot(0, E, E), Some(2));
        assert_eq!(lowest_free_slot(SLOTS_RESERVED_2, E, E), Some(3));
        assert_eq!(lowest_free_slot(2, E, E), Some(3), "a ticket on slot 2");
        assert_eq!(lowest_free_slot(0, 1, E), Some(3));
        assert_eq!(lowest_free_slot(SLOTS_RESERVED_3, 1, E), None);
        assert_eq!(lowest_free_slot(3 | SLOTS_RESERVED_2, E, E), None);
        assert_eq!(holding_of_slot(1), HOLDING);
        assert_eq!(holding_of_slot(3), HOLDING + 12);
        assert_eq!(reserved_bit(1), 0);
    }
}
