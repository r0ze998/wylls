//! ABI v2 account layouts (MC contract §5.2), beside the frozen v1 ones.
//!
//! **Staged (v1.1, R-16):** nothing in [`crate::layout`] moves. v2 adds:
//!
//! | account | change |
//! |---|---|
//! | Province | 4,096 → **4,736 B**: the 640-B conquest block at 4,096; site mirror reserved bytes named |
//! | Holding | 1,248..1,280 reserve: capture fields |
//! | Citizen | 145, 150, 187 reserve: siege counter, siege day, `slots` |
//! | JoinShard | 108..128: conquest counters |
//! | Season | 896..1,024: the `SeasonParams` v2 conquest block |
//! | MarchState | **new** (kind 18, entity kind 8, `mc‖m,n`, 256 B) |
//!
//! Every v2 chained header writes `layout_version = 2` ([`LAYOUT_VERSION_V2`]);
//! readers dispatch on it (R-22). Magics are M1's (an M1 Province and an
//! MC Province differ by `layout_version` and size, never by magic).
//! **Frozen after Gate CQ1** (§11): changes by amendment only.

pub mod player;
pub mod province;
pub mod world;

use crate::layout::{world as v1w, Field};

/// `layout_version` of every v2 chained header.
pub const LAYOUT_VERSION_V2: u16 = 2;

/// The 18 program account kinds of ABI v2: M1's 17 (same codes) and
/// MarchState (18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum AccountKind {
    Season = 1,
    Frontier = 2,
    RingSeed = 3,
    ProvinceFund = 4,
    JoinShard = 5,
    BeaconLog = 6,
    DefencePool = 7,
    Citizen = 8,
    Holding = 9,
    Province = 10,
    ArrivalSlot = 11,
    ArrivalDay = 12,
    ClashInputs = 13,
    BellAnchor = 14,
    SeedCache = 15,
    AnchorArchive = 16,
    DefenceClaim = 17,
    MarchState = 18,
}

impl AccountKind {
    pub const ALL: [AccountKind; 18] = {
        use AccountKind::*;
        [
            Season,
            Frontier,
            RingSeed,
            ProvinceFund,
            JoinShard,
            BeaconLog,
            DefencePool,
            Citizen,
            Holding,
            Province,
            ArrivalSlot,
            ArrivalDay,
            ClashInputs,
            BellAnchor,
            SeedCache,
            AnchorArchive,
            DefenceClaim,
            MarchState,
        ]
    };

    pub fn from_u8(v: u8) -> Option<AccountKind> {
        Self::ALL.iter().copied().find(|k| *k as u8 == v)
    }

    /// The M1 kind of the same code (`None` for MarchState).
    pub fn to_v1(self) -> Option<crate::layout::AccountKind> {
        crate::layout::AccountKind::from_u8(self as u8)
    }

    /// The v2 kind of an M1 kind (same code).
    pub fn of_v1(k: crate::layout::AccountKind) -> AccountKind {
        // Every M1 code is a v2 code (`tests::codes_extend_m1`).
        Self::from_u8(k as u8).unwrap_or(AccountKind::Season)
    }

    pub const fn size(self) -> usize {
        use AccountKind::*;
        match self {
            Province => province::province::SIZE,
            MarchState => world::march_state::SIZE,
            Citizen => player::citizen::SIZE,
            Holding => player::holding::SIZE,
            JoinShard => world::join_shard::SIZE,
            Season => world::season::SIZE,
            Frontier => v1w::frontier::SIZE,
            RingSeed => v1w::ring_seed::SIZE,
            ProvinceFund => v1w::province_fund::SIZE,
            BeaconLog => v1w::beacon_log::SIZE,
            DefencePool => v1w::defence_pool::SIZE,
            ArrivalSlot => crate::layout::clash::arrival_slot::SIZE,
            ArrivalDay => crate::layout::clash::arrival_day::SIZE,
            ClashInputs => crate::layout::clash::clash_inputs::SIZE,
            BellAnchor => crate::layout::beacon::bell_anchor::SIZE,
            SeedCache => crate::layout::beacon::seed_cache::SIZE,
            AnchorArchive => crate::layout::beacon::anchor_archive::SIZE,
            DefenceClaim => crate::layout::beacon::defence_claim::SIZE,
        }
    }

    pub const fn magic(self) -> [u8; 8] {
        match self {
            AccountKind::MarchState => world::march_state::MAGIC,
            // Same code, same magic as M1 (`tests::magics_are_m1s`).
            k => v1_kind(k).magic(),
        }
    }

    pub const fn chained(self) -> bool {
        use AccountKind::*;
        matches!(
            self,
            Season | Frontier | JoinShard | Citizen | Holding | Province | ClashInputs | MarchState
        )
    }

    pub const fn fields(self) -> &'static [Field] {
        use AccountKind::*;
        match self {
            Province => province::province::FIELDS,
            MarchState => world::march_state::FIELDS,
            Citizen => player::citizen::FIELDS,
            Holding => player::holding::FIELDS,
            JoinShard => world::join_shard::FIELDS,
            Season => world::season::FIELDS,
            k => v1_kind(k).fields(),
        }
    }

    pub const fn rent(self) -> u64 {
        crate::layout::rent(self.size())
    }

    pub const fn name(self) -> &'static str {
        match self {
            AccountKind::MarchState => "MarchState",
            k => v1_kind(k).name(),
        }
    }

    /// Whether v2 changed the kind's layout (size or named reserve).
    pub const fn changed_in_v2(self) -> bool {
        use AccountKind::*;
        matches!(
            self,
            Province | MarchState | Citizen | Holding | JoinShard | Season
        )
    }

    /// Which kind the 8-byte magic names.
    pub fn from_magic(m: &[u8; 8]) -> Option<AccountKind> {
        Self::ALL.iter().copied().find(|k| &k.magic() == m)
    }
}

/// The M1 kind of a code shared with v2 (callers handle MarchState first;
/// the modulus only keeps the index in range for it).
const fn v1_kind(k: AccountKind) -> crate::layout::AccountKind {
    crate::layout::AccountKind::ALL[(k as usize - 1) % crate::layout::AccountKind::ALL.len()]
}

/// The sub-records nested in v2 layouts that v1 does not have (the
/// v1 ones are [`crate::layout::RECORDS`]).
pub const RECORDS: &[(&str, usize, &[Field])] = &[
    ("SiteMirrorV2", province::site::SIZE, province::site::FIELDS),
    (
        "ConquestRecord",
        province::conquest::SIZE,
        province::conquest::FIELDS,
    ),
    ("Keep", province::keep::SIZE, province::keep::FIELDS),
    (
        "Snapshot",
        province::snapshot::SIZE,
        province::snapshot::FIELDS,
    ),
    (
        "ConquestParams",
        crate::v2::presets::cq_layout::SIZE,
        crate::v2::presets::cq_layout::FIELDS,
    ),
];

/// The `layout_version` of a chained account (`None` if short).
pub fn layout_version(d: &[u8]) -> Option<u16> {
    crate::bytes::rd_u16(d, crate::layout::header::LAYOUT_VERSION)
}

/// Writes a fresh v2 header: chained H with `layout_version = 2` (seq 0,
/// zero head), or the short header SH.
pub fn write_header(d: &mut [u8], kind: AccountKind, season_id: u64) -> bool {
    use crate::bytes::{wr_arr, wr_u16, wr_u64};
    use crate::layout::header;
    let mut ok = wr_arr(d, 0, &kind.magic());
    ok &= wr_u64(d, 8, season_id);
    if kind.chained() {
        ok &= wr_u16(d, header::LAYOUT_VERSION, LAYOUT_VERSION_V2);
        ok &= wr_arr(d, 18, &[0u8; 6]);
        ok &= wr_u64(d, header::EVENT_SEQ, 0);
        ok &= wr_arr(d, header::EVENT_HEAD, &[0u8; 32]);
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiles(name: &str, size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{name}.{} starts at {} not {at}", f.name, f.off);
            assert!(f.len > 0, "{name}.{} is empty", f.name);
            at += f.len;
        }
        assert_eq!(at, size, "{name} fields end at {at}, size {size}");
    }

    #[test]
    fn layouts_tile_exactly() {
        for k in AccountKind::ALL {
            tiles(k.name(), k.size(), k.fields());
        }
        for (name, size, fields) in RECORDS {
            tiles(name, *size, fields);
        }
    }

    #[test]
    fn codes_extend_m1() {
        for k in crate::layout::AccountKind::ALL {
            let v = AccountKind::of_v1(k);
            assert_eq!(v as u8, k as u8);
            assert_eq!(v.to_v1(), Some(k));
            assert_eq!(v.magic(), k.magic(), "magics are M1's");
            assert_eq!(v.name(), k.name());
            assert_eq!(v.chained(), k.chained());
            if !v.changed_in_v2() {
                assert_eq!(v.fields(), k.fields());
            }
            if v != AccountKind::Province {
                assert_eq!(v.size(), k.size(), "{}", k.name());
            }
        }
        assert_eq!(AccountKind::MarchState.to_v1(), None);
        assert_eq!(
            AccountKind::from_magic(b"PSF1MRCH"),
            Some(AccountKind::MarchState)
        );
    }

    /// §5.2.1 and §5.2.6 rents (refundable).
    #[test]
    fn rents_are_the_contract_table() {
        assert_eq!(AccountKind::Province.rent(), 24_709_120);
        assert_eq!(
            AccountKind::Province.rent() - crate::layout::AccountKind::Province.rent(),
            3_251_200
        );
        assert_eq!(AccountKind::MarchState.rent(), 1_950_720);
        assert!(
            AccountKind::Province.size() <= 10_240,
            "CPI allocation limit"
        );
    }

    #[test]
    fn header_is_version_2() {
        let mut d = [0u8; 256];
        assert!(write_header(&mut d, AccountKind::MarchState, 7));
        assert_eq!(layout_version(&d), Some(2));
        assert_eq!(&d[..8], b"PSF1MRCH");
    }
}
