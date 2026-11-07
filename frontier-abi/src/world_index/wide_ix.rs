//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **draft** wire envelope of the wide land write path: five instruction
//! encodings in a provisional tag band, their account lists, and the
//! program-version bit an experimental wide build carries.
//!
//! **Provisional, unallocated, unreachable by default.** The integrator
//! (workstream 4, `ABI-ALLOCATION-20261106.ja.md`) allocates instruction
//! tags; the band below, `0xD6..=0xDA`, is taken from the free range
//! `0xD6–0xDF` of that note's revision 3 and is **not** an allocation. It
//! is deliberately outside every v2 tag, every reserved tag, workstream 2's
//! `0xD0–0xD5`, workstream 20's `0xE0–0xE7`, workstream 11's `0xE8–0xED`
//! and workstream 9's `0xF0–0xFD` (pinned by the tests). A default build
//! of the program never dispatches these bytes (`v2::ix::tag_of` refuses
//! them as unknown); only a program built with `wide-world-experimental`
//! routes them, and such a build carries [`WIDE_EXPERIMENTAL_VERSION_BIT`]
//! in its `PROGRAM_VERSION`, so its Seasons never mix with production
//! Seasons (the same staging the NFT work used with `0x8000`).
//!
//! | tag | command | data after the tag | class | today |
//! |---|---|---|---|---|
//! | 0xD6 | WideRequestRingSeed | `ring u64` | D | writes (payer rent) |
//! | 0xD7 | WideConsumeRingSeed | `ring u64, round u64, sig48, hints` | D, top-level | writes (verified seed) |
//! | 0xD8 | WideOpenProvince | `p i64, q i64` | D, top-level | validates, refuses `NotImplemented` (rules undecided) |
//! | 0xD9 | WideClaimSite | `p i64, q i64, site u8, slot u8` | P | validates, refuses `NotImplemented` (claim rule undecided) |
//! | 0xDA | WideDepart | `host ref 56, transit_slot u8, arrive_bell u32, tip u64, commit 32, seal 165` | P | validates, refuses `NotImplemented` (host identity unallocated) |
//!
//! Coordinates are the full `i64` pair of a `WideCoord` (never an `i16`
//! or a dense index); rings are `u64`; a host is the 56-byte
//! `WideHostRef`. Every encoding is fixed width, little-endian, exact
//! length.

use crate::bytes::{Cursor, Writer};
use crate::error::FrontierError;
use crate::ix::{HINTS_LEN, SEAL_LEN};
use crate::layout::AccountKind as K;
use crate::prologue::{Acc, Group, Spec, Wr};
use crate::world_index::key::HOST_REF_LEN;

/// The bit an experimental wide build sets in its `PROGRAM_VERSION`
/// (`0x4000 | PROGRAM_VERSION_S1`). Disjoint from the NFT build's `0x8000`;
/// both bits together name a build with both features. Provisional.
pub const WIDE_EXPERIMENTAL_VERSION_BIT: u16 = 0x4000;

/// The draft band, inclusive.
pub const DRAFT_TAG_FIRST: u8 = 0xD6;
pub const DRAFT_TAG_LAST: u8 = 0xDA;

pub const TAG_REQUEST_RING_SEED: u8 = 0xD6;
pub const TAG_CONSUME_RING_SEED: u8 = 0xD7;
pub const TAG_OPEN_PROVINCE: u8 = 0xD8;
pub const TAG_CLAIM_SITE: u8 = 0xD9;
pub const TAG_DEPART: u8 = 0xDA;

/// Whether `t` is in the draft band.
pub const fn is_draft_tag(t: u8) -> bool {
    t >= DRAFT_TAG_FIRST && t <= DRAFT_TAG_LAST
}

/// The five draft instructions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum WideIx {
    RequestRingSeed = TAG_REQUEST_RING_SEED,
    ConsumeRingSeed = TAG_CONSUME_RING_SEED,
    OpenProvince = TAG_OPEN_PROVINCE,
    ClaimSite = TAG_CLAIM_SITE,
    Depart = TAG_DEPART,
}

impl WideIx {
    pub const ALL: [WideIx; 5] = [
        WideIx::RequestRingSeed,
        WideIx::ConsumeRingSeed,
        WideIx::OpenProvince,
        WideIx::ClaimSite,
        WideIx::Depart,
    ];

    pub const fn tag(self) -> u8 {
        self as u8
    }

    pub const fn from_tag(t: u8) -> Option<WideIx> {
        match t {
            TAG_REQUEST_RING_SEED => Some(WideIx::RequestRingSeed),
            TAG_CONSUME_RING_SEED => Some(WideIx::ConsumeRingSeed),
            TAG_OPEN_PROVINCE => Some(WideIx::OpenProvince),
            TAG_CLAIM_SITE => Some(WideIx::ClaimSite),
            TAG_DEPART => Some(WideIx::Depart),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            WideIx::RequestRingSeed => "WideRequestRingSeed",
            WideIx::ConsumeRingSeed => "WideConsumeRingSeed",
            WideIx::OpenProvince => "WideOpenProvince",
            WideIx::ClaimSite => "WideClaimSite",
            WideIx::Depart => "WideDepart",
        }
    }

    /// Refuses CPI, as the deployed ConsumeRingSeed and OpenProvince do.
    pub const fn top_level_only(self) -> bool {
        matches!(self, WideIx::ConsumeRingSeed | WideIx::OpenProvince)
    }

    /// The keeper class the deployed counterpart has.
    pub const fn class(self) -> crate::tags::Class {
        match self {
            WideIx::RequestRingSeed | WideIx::ConsumeRingSeed | WideIx::OpenProvince => {
                crate::tags::Class::D
            }
            WideIx::ClaimSite | WideIx::Depart => crate::tags::Class::P,
        }
    }

    /// Whether the handler of this instruction writes anything today, or
    /// validates and refuses `NotImplemented` at its readiness gate.
    pub const fn writes_today(self) -> bool {
        matches!(self, WideIx::RequestRingSeed | WideIx::ConsumeRingSeed)
    }
}

/// The draft instruction of `data` (`BadData` for any other tag).
pub fn tag_of(data: &[u8]) -> Result<WideIx, FrontierError> {
    data.first()
        .and_then(|t| WideIx::from_tag(*t))
        .ok_or(FrontierError::BadData)
}

// ------------------------------------------------------------ data

/// 0xD6: `ring u64`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestRingSeed {
    pub ring: u64,
}

/// 0xD7: `ring u64, round u64, sig48, hints` (the hinted quicknet
/// verification of the deployed ConsumeRingSeed, `ix::ConsumeRingSeed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsumeRingSeed {
    pub ring: u64,
    pub round: u64,
    pub sig48: [u8; 48],
    pub hints: [u8; HINTS_LEN],
}

/// 0xD8: `p i64, q i64`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenProvince {
    pub p: i64,
    pub q: i64,
}

/// 0xD9: `p i64, q i64, site u8, slot u8` (the Citizen slot, 2 or 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimSite {
    pub p: i64,
    pub q: i64,
    pub site: u8,
    pub slot: u8,
}

/// 0xDA: the legacy Depart's data with the `u64` host id replaced by the
/// 56-byte wide host reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Depart {
    pub host: [u8; HOST_REF_LEN],
    pub transit_slot: u8,
    pub arrive_bell: u32,
    pub tip: u64,
    pub commit: [u8; 32],
    pub seal: [u8; SEAL_LEN],
}

fn exact<'a>(d: &'a [u8], tag: u8, len: usize) -> Result<Cursor<'a>, FrontierError> {
    if d.len() != len || d.first() != Some(&tag) {
        return Err(FrontierError::BadData);
    }
    Ok(Cursor::new(&d[1..]))
}

impl RequestRingSeed {
    pub const IX: WideIx = WideIx::RequestRingSeed;
    pub const LEN: usize = 1 + 8;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b).u8(Self::IX.tag()).u64(self.ring);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(RequestRingSeed {
            ring: c.u64().ok_or(FrontierError::BadData)?,
        })
    }
}

impl ConsumeRingSeed {
    pub const IX: WideIx = WideIx::ConsumeRingSeed;
    pub const LEN: usize = 1 + 8 + 8 + 48 + HINTS_LEN;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .u64(self.ring)
            .u64(self.round)
            .bytes(&self.sig48)
            .bytes(&self.hints);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(ConsumeRingSeed {
            ring: c.u64().ok_or(bad)?,
            round: c.u64().ok_or(bad)?,
            sig48: c.arr().ok_or(bad)?,
            hints: c.arr().ok_or(bad)?,
        })
    }
}

impl OpenProvince {
    pub const IX: WideIx = WideIx::OpenProvince;
    pub const LEN: usize = 1 + 8 + 8;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .i64(self.p)
            .i64(self.q);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(OpenProvince {
            p: c.i64().ok_or(bad)?,
            q: c.i64().ok_or(bad)?,
        })
    }
}

impl ClaimSite {
    pub const IX: WideIx = WideIx::ClaimSite;
    pub const LEN: usize = 1 + 8 + 8 + 1 + 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .i64(self.p)
            .i64(self.q)
            .u8(self.site)
            .u8(self.slot);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(ClaimSite {
            p: c.i64().ok_or(bad)?,
            q: c.i64().ok_or(bad)?,
            site: c.u8().ok_or(bad)?,
            slot: c.u8().ok_or(bad)?,
        })
    }
}

impl Depart {
    pub const IX: WideIx = WideIx::Depart;
    pub const LEN: usize = 1 + HOST_REF_LEN + 1 + 4 + 8 + 32 + SEAL_LEN;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .bytes(&self.host)
            .u8(self.transit_slot)
            .u32(self.arrive_bell)
            .u64(self.tip)
            .bytes(&self.commit)
            .bytes(&self.seal);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(Depart {
            host: c.arr().ok_or(bad)?,
            transit_slot: c.u8().ok_or(bad)?,
            arrive_bell: c.u32().ok_or(bad)?,
            tip: c.u64().ok_or(bad)?,
            commit: c.arr().ok_or(bad)?,
            seal: c.arr().ok_or(bad)?,
        })
    }
}

/// Data length with the tag of each draft instruction.
pub const fn data_len(ix: WideIx) -> usize {
    match ix {
        WideIx::RequestRingSeed => RequestRingSeed::LEN,
        WideIx::ConsumeRingSeed => ConsumeRingSeed::LEN,
        WideIx::OpenProvince => OpenProvince::LEN,
        WideIx::ClaimSite => ClaimSite::LEN,
        WideIx::Depart => Depart::LEN,
    }
}

// ------------------------------------------------------------ account lists

const fn s(name: &'static str, acc: Acc, signer: bool, wr: Wr) -> Spec {
    Spec {
        name,
        acc,
        signer,
        wr,
    }
}

const fn one(specs: &'static [Spec]) -> Group {
    Group {
        specs,
        min: 1,
        max: 1,
    }
}

const fn rep(specs: &'static [Spec], n: u8) -> Group {
    Group {
        specs,
        min: n,
        max: n,
    }
}

/// A position holding a wide record (no `AccountKind` exists for it yet):
/// the flag check treats it as any account, and the handler authenticates
/// owner, size, magic, season and address itself, and refuses a writable
/// flag on a read-only wide position.
const WIDE: Acc = Acc::Any;

/// `[payer s,w] [season r] [frontier r] [previous r] [wide_ringseed w]
/// [pfund × 6 r] [system]`: the deployed OpenRing list with the previous
/// ring's seed (the legacy RingSeed of ring 128 for ring 129, else the wide
/// seed of `ring − 1`) added and the RingSeed position a wide one.
pub const REQUEST_RING_SEED: &[Group] = &[
    one(&[
        s("payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("frontier", Acc::Kind(K::Frontier), false, Wr::R),
        s("previous", WIDE, false, Wr::R),
        s("wide_ringseed", WIDE, false, Wr::W),
    ]),
    rep(&[s("pfund", Acc::Kind(K::ProvinceFund), false, Wr::R)], 6),
    one(&[s("system", Acc::System, false, Wr::R)]),
];

/// `[fee_payer s,w] [season r] [wide_ringseed w]`: the deployed
/// ConsumeRingSeed list.
pub const CONSUME_RING_SEED: &[Group] = &[one(&[
    s("fee_payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("wide_ringseed", WIDE, false, Wr::W),
])];

/// `[payer s,w] [season r] [wide_ringseed w] [pfund w] [province w]
/// [system]`: the deployed OpenProvince list with wide positions.
pub const OPEN_PROVINCE: &[Group] = &[one(&[
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("wide_ringseed", WIDE, false, Wr::W),
    s("pfund", Acc::Kind(K::ProvinceFund), false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("system", Acc::System, false, Wr::R),
])];

/// The deployed player prologue `[actor s] [payer s,w] [season r]
/// [citizen w]` then `[province w] [holding w] [system]`: the wide province
/// (its site mirror takes the claim) and the wide holding to create.
pub const CLAIM_SITE: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("system", Acc::System, false, Wr::R),
])];

/// The deployed Depart list with wide positions: the player prologue then
/// `[holding w] [province w] [system]`.
pub const DEPART: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("system", Acc::System, false, Wr::R),
])];

/// The account list of a draft instruction.
pub const fn accounts_of(ix: WideIx) -> &'static [Group] {
    match ix {
        WideIx::RequestRingSeed => REQUEST_RING_SEED,
        WideIx::ConsumeRingSeed => CONSUME_RING_SEED,
        WideIx::OpenProvince => OPEN_PROVINCE,
        WideIx::ClaimSite => CLAIM_SITE,
        WideIx::Depart => DEPART,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prologue::{bounds_in, position_in, resolve_in, PLAYER_PROLOGUE};
    use crate::v2::presets::{PROGRAM_VERSION_S1, PROGRAM_VERSION_V2};
    use std::vec::Vec;

    /// The band is free of every tag the v2 program dispatches, every
    /// reserved tag and every other workstream's provisional band of
    /// 2026-11-06; the version bit is disjoint from the NFT build's and
    /// from every production value.
    #[test]
    fn the_draft_band_is_free_and_the_version_bit_is_disjoint() {
        for t in DRAFT_TAG_FIRST..=DRAFT_TAG_LAST {
            assert!(is_draft_tag(t));
            assert!(crate::v2::Ix::from_tag(t).is_none(), "{t:#x} is a v2 tag");
            assert!(
                crate::tags::Ix::from_tag(t).is_none(),
                "{t:#x} is an M1 tag"
            );
            assert!(!crate::v2::tags::is_reserved(t), "{t:#x} is reserved");
            assert!(
                !crate::resident_wire::is_resident_tag(t),
                "{t:#x} is workstream 20's"
            );
            assert!(!(0xD0..=0xD5).contains(&t), "{t:#x} is workstream 2's");
            assert!(!(0xE8..=0xED).contains(&t), "{t:#x} is workstream 11's");
            assert!(!(0xF0..=0xFD).contains(&t), "{t:#x} is workstream 9's");
            assert!(
                !(0xC1..=0xCC).contains(&t),
                "{t:#x} is workstream 8's or 10's"
            );
            assert_eq!(crate::v2::ix::tag_of(&[t]), Err(FrontierError::BadData));
        }
        for t in [0xD5u8, 0xDB, 0xC1, 0xE0, 0xFE, 0xFF, 0x00] {
            assert!(!is_draft_tag(t));
            assert_eq!(tag_of(&[t]), Err(FrontierError::BadData));
        }
        assert_eq!(WideIx::ALL.len(), 5);
        for (i, a) in WideIx::ALL.iter().enumerate() {
            assert_eq!(WideIx::from_tag(a.tag()), Some(*a));
            assert!(is_draft_tag(a.tag()));
            assert!(a.name().starts_with("Wide"));
            for b in &WideIx::ALL[i + 1..] {
                assert_ne!(a.tag(), b.tag());
            }
        }
        assert!(WideIx::ConsumeRingSeed.top_level_only());
        assert!(WideIx::OpenProvince.top_level_only());
        assert!(!WideIx::RequestRingSeed.top_level_only());
        assert!(!WideIx::ClaimSite.top_level_only());
        assert!(!WideIx::Depart.top_level_only());
        // only the seed provenance writes today; the land, claim and march
        // handlers refuse at their readiness gates
        let writers: Vec<WideIx> = WideIx::ALL
            .iter()
            .copied()
            .filter(|i| i.writes_today())
            .collect();
        assert_eq!(writers, [WideIx::RequestRingSeed, WideIx::ConsumeRingSeed]);
        assert_eq!(WIDE_EXPERIMENTAL_VERSION_BIT, 0x4000);
        assert_eq!(
            WIDE_EXPERIMENTAL_VERSION_BIT & 0x8000,
            0,
            "the NFT build's bit"
        );
        for v in [
            PROGRAM_VERSION_V2,
            PROGRAM_VERSION_S1,
            5u16,
            0x8000 | PROGRAM_VERSION_S1,
        ] {
            assert_eq!(v & WIDE_EXPERIMENTAL_VERSION_BIT, 0, "{v:#x}");
        }
        assert_eq!(WIDE_EXPERIMENTAL_VERSION_BIT | PROGRAM_VERSION_S1, 0x4004);
    }

    #[test]
    fn encodings_are_exact_and_round_trip() {
        let r = RequestRingSeed { ring: 129 };
        let b = r.to_bytes();
        assert_eq!(b.len(), 9);
        assert_eq!(b[0], 0xD6);
        assert_eq!(RequestRingSeed::decode(&b), Ok(r));
        assert_eq!(tag_of(&b), Ok(WideIx::RequestRingSeed));
        assert_eq!(
            RequestRingSeed::decode(&b[..8]),
            Err(FrontierError::BadData)
        );
        let mut long = b.to_vec();
        long.push(0);
        assert_eq!(RequestRingSeed::decode(&long), Err(FrontierError::BadData));
        let mut wrong = b;
        wrong[0] = 0xD8;
        assert_eq!(RequestRingSeed::decode(&wrong), Err(FrontierError::BadData));

        let c = ConsumeRingSeed {
            ring: 1 << 40,
            round: 0x0102_0304_0506_0708,
            sig48: [0x80; 48],
            hints: [7; HINTS_LEN],
        };
        let b = c.to_bytes();
        assert_eq!(b.len(), 355);
        assert_eq!(
            b.len(),
            crate::ix::ConsumeRingSeed::LEN + 6,
            "a u64 ring for a u16 one"
        );
        assert_eq!(ConsumeRingSeed::decode(&b), Ok(c));
        assert_eq!(
            ConsumeRingSeed::decode(&b[..354]),
            Err(FrontierError::BadData)
        );

        for (p, q) in [
            (129i64, 0i64),
            (-129, 129),
            (1 << 62, -(1 << 62)),
            (i64::MIN, i64::MAX),
        ] {
            let o = OpenProvince { p, q };
            let b = o.to_bytes();
            assert_eq!(b.len(), 17);
            assert_eq!(b[0], 0xD8);
            assert_eq!(OpenProvince::decode(&b), Ok(o), "the full i64 pair, exact");
            let cl = ClaimSite {
                p,
                q,
                site: 11,
                slot: 3,
            };
            let b = cl.to_bytes();
            assert_eq!(b.len(), 19);
            assert_eq!(b[0], 0xD9);
            assert_eq!(ClaimSite::decode(&b), Ok(cl));
            assert_eq!(
                OpenProvince::decode(&b),
                Err(FrontierError::BadData),
                "tags differ"
            );
        }
        let d = Depart {
            host: [0x11; HOST_REF_LEN],
            transit_slot: 2,
            arrive_bell: 777,
            tip: 14_441,
            commit: [7; 32],
            seal: [9; SEAL_LEN],
        };
        let b = d.to_bytes();
        assert_eq!(b.len(), 267);
        assert_eq!(
            b.len(),
            crate::ix::Depart::LEN + HOST_REF_LEN - 8,
            "a 56-byte host for a u64"
        );
        assert_eq!(b[0], 0xDA);
        assert_eq!(Depart::decode(&b), Ok(d));
        assert_eq!(Depart::decode(&b[..266]), Err(FrontierError::BadData));
        for ix in WideIx::ALL {
            assert!(data_len(ix) >= 1);
        }
    }

    /// Every table resolves, names every position, bounds the count, and
    /// keeps the deployed counterparts' shapes plus the wide positions.
    #[test]
    fn account_tables_are_consistent_and_named() {
        for ix in WideIx::ALL {
            let groups = accounts_of(ix);
            assert!(!groups.is_empty(), "{}", ix.name());
            let (lo, hi) = bounds_in(groups);
            assert_eq!(lo, hi, "{}: every draft list is fixed", ix.name());
            assert!(hi <= 64);
            let counts: Vec<u8> = groups.iter().map(|g| g.max).collect();
            let mut out = [s("", Acc::Wallet, false, Wr::R); 32];
            let n = resolve_in(groups, &counts, &mut out).unwrap();
            assert_eq!(n, hi);
            let mut names: Vec<&str> = out[..n].iter().map(|x| x.name).collect();
            let total = names.len();
            names.dedup();
            // only the six funds repeat a name
            assert!(names.len() >= total.saturating_sub(5), "{}", ix.name());
            assert!(out[0].signer, "{}: the first account signs", ix.name());
        }
        assert_eq!(bounds_in(REQUEST_RING_SEED), (12, 12));
        assert_eq!(bounds_in(CONSUME_RING_SEED), (3, 3));
        assert_eq!(bounds_in(OPEN_PROVINCE), (6, 6));
        assert_eq!(bounds_in(CLAIM_SITE), (7, 7));
        assert_eq!(bounds_in(DEPART), (7, 7));
        // the deployed shapes, one wider where the previous ring is named
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::OpenRing),
            (11, 11)
        );
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::ConsumeRingSeed),
            (3, 3)
        );
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::OpenProvince),
            (6, 6)
        );
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::Depart),
            (7, 7)
        );
        // the player instructions start with the deployed player prologue
        for g in [CLAIM_SITE, DEPART] {
            for (sp, want) in g[0].specs.iter().zip(PLAYER_PROLOGUE) {
                assert_eq!(
                    (sp.name, sp.signer, sp.wr),
                    (want.name, want.signer, want.wr)
                );
            }
            assert_eq!(g[0].specs[2].acc, Acc::Kind(K::Season));
            assert_eq!(g[0].specs[3].acc, Acc::Kind(K::Citizen));
        }
        // named positions, as a builder would look them up
        assert_eq!(position_in(REQUEST_RING_SEED, 12, "previous", 0), Some(3));
        assert_eq!(
            position_in(REQUEST_RING_SEED, 12, "wide_ringseed", 0),
            Some(4)
        );
        assert_eq!(position_in(REQUEST_RING_SEED, 12, "pfund", 5), Some(10));
        assert_eq!(position_in(REQUEST_RING_SEED, 12, "system", 0), Some(11));
        assert_eq!(position_in(OPEN_PROVINCE, 6, "province", 0), Some(4));
        assert_eq!(position_in(CLAIM_SITE, 7, "holding", 0), Some(5));
        assert_eq!(position_in(DEPART, 7, "province", 0), Some(5));
        // wide positions are the handler's to authenticate
        for g in REQUEST_RING_SEED
            .iter()
            .chain(OPEN_PROVINCE)
            .chain(CLAIM_SITE)
            .chain(DEPART)
        {
            for sp in g.specs {
                if matches!(
                    sp.name,
                    "previous" | "wide_ringseed" | "province" | "holding"
                ) {
                    assert_eq!(sp.acc, Acc::Any, "{}", sp.name);
                }
            }
        }
    }
}
