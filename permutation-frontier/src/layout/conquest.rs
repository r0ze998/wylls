//! ABI v2 land and player layouts (MC contract §5.2.1–§5.2.5): the
//! Province v2 (4,736 B) with its conquest block, the v2 site mirror, the
//! conquest record, the keep and the hourly snapshot; the Citizen, Holding
//! and JoinShard reserve fields; Season v2 and its conquest parameters.
//! Offsets: `frontier_abi::v2::layout` (frozen after Gate CQ1); nothing
//! here restates a number.
//!
//! Bytes `0..4,096` of a v2 Province are M1's, so every v1 offset of
//! [`super::province`] and [`super::site`] reads a v2 Province unchanged;
//! the names below add the conquest block and the mirror's v2 fields.

pub use frontier_abi::v2::layout::player::{citizen as citizen2, holding as holding2};
pub use frontier_abi::v2::layout::province::{
    conquest as record, keep, province as province2, site as site2, snapshot,
};
pub use frontier_abi::v2::layout::world::{join_shard as join_shard2, season as season2};
pub use frontier_abi::v2::layout::{
    layout_version, write_header as write_header_v2, AccountKind as AccountKindV2,
    LAYOUT_VERSION_V2,
};
pub use frontier_abi::v2::presets::{
    cq_layout as cq_params, ConquestParams, CONQUEST_PARAMS_LEN, SEASON_CQ_OFFSET,
};

use super::Ro;
use crate::error::BAD_ACCOUNT;
use crate::R;

/// The conquest block of a Season v2 (§5.2.5), decoded (`BadAccount` if
/// short or a reserved byte is set).
pub fn season_cq(season: &[u8]) -> R<ConquestParams> {
    ConquestParams::of_season(season).ok_or(BAD_ACCOUNT)
}

/// The season's holding lifecycle timers (MC §3.9, §3.12) as the holding
/// kernel's `LifecycleParams`.
pub fn lifecycle(cq: &ConquestParams) -> permutation_rules::frontier::holding::LifecycleParams {
    permutation_rules::frontier::holding::LifecycleParams {
        shield_secs: cq.shield_secs as i64,
        shield_late_secs: cq.shield_late_secs as i64,
        shield_late_after_secs: cq.shield_late_after_secs as i64,
        dormant_after_secs: cq.dormant_after_secs as i64,
        release_after_secs: cq.release_after_secs as i64,
        outpost_shield_secs: cq.outpost_shield_secs as i64,
    }
}

/// One conquest record (§5.2.1), as stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub kind: u8,
    pub faction: u8,
    pub flags: u8,
    pub progress: u8,
    pub required: u8,
    pub target: u8,
    pub bell: u32,
    pub actor: u64,
    pub src: u64,
}

impl Record {
    /// Record `site` of a v2 Province.
    pub fn read(province: &[u8], site: usize) -> R<Record> {
        let o = province2::record(site);
        let r = Ro(province);
        Ok(Record {
            kind: r.u8(o + record::KIND)?,
            faction: r.u8(o + record::FACTION)?,
            flags: r.u8(o + record::FLAGS)?,
            progress: r.u8(o + record::PROGRESS)?,
            required: r.u8(o + record::REQUIRED)?,
            target: r.u8(o + record::TARGET)?,
            bell: r.u32(o + record::BELL)?,
            actor: r.u64(o + record::ACTOR)?,
            src: r.u64(o + record::SRC)?,
        })
    }

    /// Every byte of record `site` is zero (§3.15 S1).
    pub fn is_zero(province: &[u8], site: usize) -> R<bool> {
        let o = province2::record(site);
        Ok(Ro(province).slice(o, record::SIZE)?.iter().all(|b| *b == 0))
    }

    /// A live record (kind 1–3) or a kind-0 record that still owes a stake
    /// or a slot (flags bits 1, 2, 5): §3.15 S3's refusal set.
    pub const fn live(&self) -> bool {
        self.kind != record::KIND_NONE
    }

    /// Kind 0 with something owed.
    pub const fn owes(&self) -> bool {
        self.flags & record::OWED_MASK != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_read_at_the_v2_offsets() {
        let mut p = alloc::vec![0u8; province2::SIZE];
        let o = province2::record(7);
        p[o + record::KIND] = record::KIND_SIEGE;
        p[o + record::FLAGS] = record::FLAG_SLOT_OWED;
        p[o + record::BELL..o + record::BELL + 4].copy_from_slice(&9u32.to_le_bytes());
        p[o + record::SRC..o + record::SRC + 8].copy_from_slice(&5u64.to_le_bytes());
        let r = Record::read(&p, 7).unwrap();
        assert_eq!((r.kind, r.bell, r.src), (1, 9, 5));
        assert!(r.live() && r.owes());
        assert!(!Record::is_zero(&p, 7).unwrap());
        assert!(Record::is_zero(&p, 6).unwrap());
        assert!(Record::read(&p[..4_200], 11).is_err());
        assert_eq!(province2::SIZE, 4_736);
    }

    #[test]
    fn lifecycle_is_the_preset_timers() {
        use frontier_abi::v2::presets::{FRONTIER_28, FRONTIER_7};
        use permutation_rules::frontier::holding::LifecycleParams as L;
        assert_eq!(lifecycle(&FRONTIER_7), L::FRONTIER_7);
        assert_eq!(lifecycle(&FRONTIER_28), L::FRONTIER_28);
    }
}
