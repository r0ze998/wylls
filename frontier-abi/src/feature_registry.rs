//! The single allocation registry of the experimental features (workstream
//! 4, `ABI-ALLOCATION-20261106.ja.md` **rev 8**, 2026-11-20; **provisional**,
//! local builds only): instruction tags, program error codes, PS2 record
//! kinds, v2 `AccountKind` numbers and program-version bits of ② rights
//! (`rights-experimental`), ⑨ capacity (`capacity-preview`), ⑩ custody
//! (`custody-preview`), ⑳ NFT residents, ⑪ extensions (reserved), the wide
//! land / expedition lane and the land preview, in one table per number
//! space. The tests below check that the bands are pairwise disjoint and
//! that every number the code really uses lies in its owner's band, so a
//! new number that collides fails here before it reaches a build.
//!
//! Compiled only for tests and under `feature-coexist` (the combined local
//! build, `permutation-frontier` feature `coexist-experimental`): no default,
//! S1 or devnet build sees this module.
//!
//! **Program versions.** A version is a base (low byte: 3 MC, 4 S1, 5 S1
//! with custody, i.e. `RULESET_HASH_V4`) OR'ed with one bit per feature
//! ([`VERSION_BITS`]). A build carries exactly the bits of the features it
//! routes, and CreateSeason accepts only the build's own exact version, so
//! Seasons of different builds never mix:
//!
//! | build | version |
//! |---|---|
//! | S1 (devnet S1, the plain release) | `0x0004` |
//! | playable lane (localnet land / devnet playable) | `0x4804` |
//! | ② + ⑨ + ⑩ host (`coexist-experimental`) | [`COEXIST_S1_VERSION`] `0x3005` |
//! | ② + ⑨ + ⑩ on the playable lane (`localnet-coexist-sbf`) | [`COEXIST_LANE_VERSION`] `0x7805` |
//!
//! ⑩'s custody kernel is in the ruleset hash (`RULESET_HASH_V4`, rules
//! version 13), so every build with custody has base 5; ② and ⑨ change no
//! kernel that the hash commits to.

/// The owner of a band.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// The base program (M1, MC, S1 and map growth).
    Base,
    /// ⑩ custody (`custody-preview`).
    Custody,
    /// The land preview (`land-preview`).
    Land,
    /// ② rights (`rights-experimental`).
    Rights,
    /// The wide land draft band and its class-W carrier
    /// (`wide-world-experimental`; the expedition wrapper's class tags
    /// 0xDA/0xDC/0xDE are in it).
    Wide,
    /// The expedition revision (`expedition-dispatch-experimental`).
    Expedition,
    /// ⑳ NFT residents (`nft-experimental`).
    Nft,
    /// ⑪ extensions (reserved; not in the code).
    Ext,
    /// ⑨ capacity (`capacity-preview`).
    Capacity,
    /// Never allocated (tests of "an unknown tag" and the like).
    Test,
    /// Free: allocated to nobody.
    Free,
}

/// An inclusive band of one number space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Band {
    pub owner: Owner,
    pub first: u32,
    pub last: u32,
}

const fn b(owner: Owner, first: u32, last: u32) -> Band {
    Band { owner, first, last }
}

impl Band {
    pub const fn contains(&self, v: u32) -> bool {
        v >= self.first && v <= self.last
    }
}

/// Instruction tags (u8) of the feature bands. The base program's tags
/// (M1's, 0xA0–0xBE, 0xC0 FastForward, 0xC1 ExtendFrontier) are the v2
/// table (`v2::tags::Ix::ALL`) and lie outside every band here except
/// custody's (its 11 tags are rows of that table, routed only by a custody
/// build).
pub const TAG_BANDS: &[Band] = &[
    b(Owner::Custody, 0xC2, 0xCC),
    b(Owner::Land, 0xCD, 0xCF),
    b(Owner::Rights, 0xD0, 0xD5),
    b(Owner::Wide, 0xD6, 0xDF),
    b(Owner::Nft, 0xE0, 0xE7),
    b(Owner::Ext, 0xE8, 0xED),
    b(Owner::Wide, 0xEE, 0xEE),
    b(Owner::Free, 0xEF, 0xEF),
    b(Owner::Capacity, 0xF0, 0xFD),
    b(Owner::Test, 0xFE, 0xFF),
];

/// Program error codes (`FrontierError` + `CqError`, one space).
pub const ERROR_BANDS: &[Band] = &[
    b(Owner::Base, 1, 94),
    b(Owner::Free, 95, 98),
    b(Owner::Base, 99, 99),
    b(Owner::Custody, 100, 104),
    b(Owner::Free, 105, 109),
    // the kernel's refusals 1–30 at `109 + code` (110–139); 140–149 spare
    b(Owner::Capacity, 110, 149),
    b(Owner::Ext, 150, 169),
    b(Owner::Nft, 170, 179),
    b(Owner::Free, 180, 199),
    b(Owner::Rights, 200, 219),
];

/// PS2 record kinds (u8; the v1 and v2 tables are one space).
///
/// **rev 8:** ⑨'s 20 record kinds get **150–169** (rev 3 reserved 120–129,
/// ten slots, which do not hold them); 120–129 return to the free pool.
/// Allocated only: the capacity build emits no PS2 record yet.
pub const RECORD_KIND_BANDS: &[Band] = &[
    b(Owner::Base, 0, 104),
    b(Owner::Custody, 105, 113),
    b(Owner::Rights, 114, 119),
    b(Owner::Free, 120, 129),
    b(Owner::Nft, 130, 134),
    b(Owner::Ext, 135, 144),
    // 145 the legacy source receipt, 146–149 the expedition records
    b(Owner::Expedition, 145, 149),
    b(Owner::Capacity, 150, 169),
    b(Owner::Free, 170, 255),
];

/// ⑨'s record kinds (rev 8), first and last.
pub const CAPACITY_RECORD_KIND_FIRST: u8 = 150;
pub const CAPACITY_RECORD_KIND_LAST: u8 = 169;

/// v2 `AccountKind` numbers (u8).
pub const ACCOUNT_KIND_BANDS: &[Band] = &[
    b(Owner::Base, 1, 22),
    b(Owner::Custody, 23, 23),  // Lot, seed `cl`, PSF1CLOT
    b(Owner::Rights, 24, 24),   // Grant, seed `gr`, PSF2GRNT
    b(Owner::Capacity, 25, 26), // CapacityPool `cp` PSF1CPOL, CapacityJob `cj` PSF1CJOB
    b(Owner::Ext, 27, 30),
    b(Owner::Nft, 31, 32),
];

/// One program-version bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VersionBit {
    pub owner: Owner,
    pub bit: u16,
    /// Whether a build sets it today (the land bit is reserved only:
    /// ABI-ALLOCATION rev 7 keeps the land preview on 0x4804).
    pub applied: bool,
}

pub const VERSION_BITS: &[VersionBit] = &[
    VersionBit {
        owner: Owner::Nft,
        bit: 0x8000,
        applied: true,
    },
    VersionBit {
        owner: Owner::Wide,
        bit: 0x4000,
        applied: true,
    },
    VersionBit {
        owner: Owner::Rights,
        bit: 0x2000,
        applied: true,
    },
    VersionBit {
        owner: Owner::Capacity,
        bit: 0x1000,
        applied: true,
    },
    VersionBit {
        owner: Owner::Expedition,
        bit: 0x0800,
        applied: true,
    },
    VersionBit {
        owner: Owner::Land,
        bit: 0x0400,
        applied: false,
    },
];

/// The base of a program version (its low byte).
pub const BASE_MASK: u16 = 0x00ff;
/// Base: S1.
pub const BASE_S1: u16 = 4;
/// Base: S1 with custody (`RULESET_HASH_V4`, rules version 13).
pub const BASE_CUSTODY: u16 = 5;

pub const RIGHTS_BIT: u16 = 0x2000;
pub const CAPACITY_BIT: u16 = 0x1000;
pub const WIDE_BIT: u16 = 0x4000;
pub const EXPEDITION_BIT: u16 = 0x0800;

/// ② + ⑨ + ⑩ on S1 (host builds of `coexist-experimental` without the
/// playable lane).
pub const COEXIST_S1_VERSION: u16 = BASE_CUSTODY | RIGHTS_BIT | CAPACITY_BIT;
/// ② + ⑨ + ⑩ on the playable lane (`localnet-coexist-sbf`: the localnet
/// land lane's 0x4804 with custody's base 5 and the rights and capacity
/// bits).
pub const COEXIST_LANE_VERSION: u16 =
    BASE_CUSTODY | WIDE_BIT | EXPEDITION_BIT | RIGHTS_BIT | CAPACITY_BIT;
const _: () = assert!(COEXIST_S1_VERSION == 0x3005);
const _: () = assert!(COEXIST_LANE_VERSION == 0x7805);

/// Whether `v` is one of the two combined versions.
pub const fn is_coexist_version(v: u16) -> bool {
    v == COEXIST_S1_VERSION || v == COEXIST_LANE_VERSION
}

/// Whether `v` runs the Grant instructions: the rights bit on the S1 base,
/// or on custody's base (a combined build). `v2::rights::runs_grants` (the
/// verifier's reading) still accepts base 4 only.
pub const fn runs_grants(v: u16) -> bool {
    v & RIGHTS_BIT != 0 && matches!(v & BASE_MASK, BASE_S1 | BASE_CUSTODY)
}

/// The owner of `v` in `bands`, if any band holds it.
pub fn owner_of(bands: &[Band], v: u32) -> Option<Owner> {
    bands.iter().find(|b| b.contains(v)).map(|b| b.owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn disjoint_and_sorted(name: &str, bands: &[Band]) {
        for w in bands.windows(2) {
            assert!(w[0].first <= w[0].last, "{name}: {:?}", w[0]);
            assert!(
                w[0].last < w[1].first,
                "{name}: {:?} overlaps {:?}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn bands_are_pairwise_disjoint() {
        disjoint_and_sorted("tags", TAG_BANDS);
        disjoint_and_sorted("errors", ERROR_BANDS);
        disjoint_and_sorted("record kinds", RECORD_KIND_BANDS);
        disjoint_and_sorted("account kinds", ACCOUNT_KIND_BANDS);
        assert!(TAG_BANDS.iter().all(|b| b.last <= 0xff));
        assert!(RECORD_KIND_BANDS.iter().all(|b| b.last <= 0xff));
    }

    #[test]
    fn the_base_table_stays_outside_the_feature_bands() {
        use crate::v2::tags::Ix;
        let custody = [
            Ix::OpenLot,
            Ix::SetLotQuota,
            Ix::DepositLot,
            Ix::SetLotOrder,
            Ix::RevokeLotOrder,
            Ix::ShipLot,
            Ix::SettleCustody,
            Ix::ConsumeLot,
            Ix::ReconcileLot,
            Ix::CloseLot,
            Ix::WithdrawLot,
        ];
        for ix in Ix::ALL {
            let t = *ix as u8 as u32;
            match owner_of(TAG_BANDS, t) {
                None => assert!(!custody.contains(ix), "{ix:?}"),
                Some(Owner::Custody) => assert!(custody.contains(ix), "{ix:?} in custody's band"),
                Some(o) => panic!("base tag {ix:?} ({t:#04x}) in {o:?}'s band"),
            }
        }
        // the eleven custody tags fill their band exactly
        let band = TAG_BANDS
            .iter()
            .find(|b| b.owner == Owner::Custody)
            .unwrap();
        assert_eq!((band.last - band.first + 1) as usize, custody.len());
        for (i, ix) in custody.iter().enumerate() {
            assert_eq!(*ix as u8 as u32, band.first + i as u32);
        }
    }

    #[test]
    fn rights_and_resident_tags_are_their_bands() {
        for t in 0u32..=0xff {
            let o = owner_of(TAG_BANDS, t);
            assert_eq!(
                crate::v2::rights::is_rights_tag(t as u8),
                o == Some(Owner::Rights),
                "{t:#04x}"
            );
            assert_eq!(
                crate::resident_wire::is_resident_tag(t as u8),
                o == Some(Owner::Nft),
                "{t:#04x}"
            );
        }
    }

    #[cfg(feature = "capacity-preview")]
    #[test]
    fn capacity_numbers_are_its_bands() {
        use crate::capacity as c;
        for t in 0u32..=0xff {
            assert_eq!(
                c::is_capacity_tag(t as u8),
                owner_of(TAG_BANDS, t) == Some(Owner::Capacity),
                "{t:#04x}"
            );
        }
        for code in 1..=30u16 {
            assert_eq!(
                owner_of(ERROR_BANDS, c::program_error(code)),
                Some(Owner::Capacity)
            );
        }
        assert_eq!(c::CAPACITY_PREVIEW_VERSION_BIT, CAPACITY_BIT);
    }

    #[cfg(feature = "land-preview")]
    #[test]
    fn land_tags_are_its_band() {
        for t in 0u32..=0xff {
            if crate::land_preview::is_land_tag(t as u8) {
                assert_eq!(owner_of(TAG_BANDS, t), Some(Owner::Land), "{t:#04x}");
            }
        }
    }

    #[cfg(feature = "world-index-experimental")]
    #[test]
    fn wide_and_expedition_numbers_are_their_bands() {
        use crate::world_index as w;
        for t in 0u32..=0xff {
            assert_eq!(
                w::wide_ix::is_draft_tag(t as u8),
                owner_of(TAG_BANDS, t) == Some(Owner::Wide),
                "{t:#04x}"
            );
        }
        for k in [
            w::legacy_source_event::KIND,
            w::expedition_event::KIND,
            w::expedition_producer_event::KIND,
            w::expedition_settlement_event::ORIGINAL_KIND,
            w::expedition_resident_event::ORIGINAL_KIND,
        ] {
            assert_eq!(
                owner_of(RECORD_KIND_BANDS, k as u32),
                Some(Owner::Expedition),
                "kind {k}"
            );
        }
        assert_eq!(w::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT, WIDE_BIT);
        assert_eq!(w::expedition_dispatch_ix::VERSION_BIT, EXPEDITION_BIT);
        assert_eq!(
            COEXIST_LANE_VERSION,
            (w::expedition_dispatch_ix::PROGRAM_VERSION & !BASE_MASK)
                | BASE_CUSTODY
                | RIGHTS_BIT
                | CAPACITY_BIT
        );
    }

    #[test]
    fn every_program_error_is_in_its_owners_band() {
        use crate::v2::error::CqError;
        for e in crate::error::FrontierError::ALL {
            assert_eq!(owner_of(ERROR_BANDS, e.code()), Some(Owner::Base), "{e:?}");
        }
        for e in CqError::ALL {
            let code = e as u32;
            let want = match e {
                CqError::CustodyCapacity
                | CqError::CustodyNoSlot
                | CqError::OrderExpired
                | CqError::LotForfeited
                | CqError::LotNotEmpty => Owner::Custody,
                CqError::ResidentNotSigned
                | CqError::ResidentAsset
                | CqError::ResidentAccount
                | CqError::ResidentUnguarded
                | CqError::ResidentStaleGeneration
                | CqError::ResidentNotCurrentAuthority => Owner::Nft,
                _ => Owner::Base,
            };
            assert_eq!(owner_of(ERROR_BANDS, code), Some(want), "{e:?} {code}");
        }
        for e in crate::v2::rights::RightsError::ALL {
            assert_eq!(
                owner_of(ERROR_BANDS, e as u32),
                Some(Owner::Rights),
                "{e:?}"
            );
        }
    }

    #[test]
    fn every_record_kind_is_in_its_owners_band() {
        use crate::v2::log::{CqKind, CQ_SPECS};
        for s in CQ_SPECS {
            let k = s.kind as u8 as u32;
            let want = if s.name.starts_with("LOT_") {
                Owner::Custody
            } else if s.name.starts_with("GRANT_") || s.name.starts_with("SWAP_") {
                Owner::Rights
            } else if s.kind == CqKind::RESIDENT_JOINED {
                Owner::Nft
            } else {
                Owner::Base
            };
            assert_eq!(owner_of(RECORD_KIND_BANDS, k), Some(want), "{} {k}", s.name);
        }
        for s in crate::log::SPECS {
            assert_eq!(
                owner_of(RECORD_KIND_BANDS, s.kind as u8 as u32),
                Some(Owner::Base),
                "{}",
                s.name
            );
        }
        let cap = RECORD_KIND_BANDS
            .iter()
            .find(|b| b.owner == Owner::Capacity)
            .unwrap();
        assert_eq!(
            (cap.first, cap.last),
            (
                CAPACITY_RECORD_KIND_FIRST as u32,
                CAPACITY_RECORD_KIND_LAST as u32
            )
        );
        assert_eq!(cap.last - cap.first + 1, 20, "⑨ has 20 record kinds");
        // nothing in the code uses ⑨'s band yet
        assert!(CQ_SPECS.iter().all(|s| !cap.contains(s.kind as u8 as u32)));
    }

    #[test]
    fn account_kinds_are_their_bands() {
        use crate::v2::layout::AccountKind as K2;
        for k in K2::ALL {
            let want = if k == K2::Lot {
                Owner::Custody
            } else {
                Owner::Base
            };
            assert_eq!(
                owner_of(ACCOUNT_KIND_BANDS, k as u8 as u32),
                Some(want),
                "{k:?}"
            );
        }
    }

    #[test]
    fn version_bits_are_disjoint_and_name_distinct_builds() {
        let mut seen = 0u16;
        for v in VERSION_BITS {
            assert_eq!(v.bit.count_ones(), 1);
            assert_eq!(v.bit & BASE_MASK, 0, "{v:?} is above the base byte");
            assert_eq!(seen & v.bit, 0, "{v:?} reused");
            seen |= v.bit;
        }
        assert_eq!(
            crate::v2::rights::RIGHTS_EXPERIMENTAL_VERSION_BIT,
            RIGHTS_BIT
        );
        assert_eq!(crate::v2::presets::PROGRAM_VERSION_S1, BASE_S1);
        assert_eq!(crate::v2::presets::PROGRAM_VERSION_CUSTODY, BASE_CUSTODY);
        // every version a build carries today, and the two new ones: all distinct
        let known: Vec<u16> = alloc::vec![
            3,
            4,
            5,
            0x8004,
            0x4004,
            0x2004,
            0x1004,
            0x1005,
            0x4804,
            0xC804,
            COEXIST_S1_VERSION,
            COEXIST_LANE_VERSION,
        ];
        for (i, a) in known.iter().enumerate() {
            for c in &known[i + 1..] {
                assert_ne!(a, c);
            }
        }
        assert!(is_coexist_version(0x3005) && is_coexist_version(0x7805));
        for v in [4, 5, 0x2004, 0x1005, 0x4804, 0xC804, 0x7804, 0x3004] {
            assert!(!is_coexist_version(v), "{v:#06x}");
        }
        assert!(runs_grants(COEXIST_S1_VERSION) && runs_grants(COEXIST_LANE_VERSION));
        assert!(runs_grants(0x2004) && !runs_grants(0x4804) && !runs_grants(0x1005));
    }
}
