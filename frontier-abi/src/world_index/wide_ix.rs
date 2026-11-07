//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **draft** wire envelope of the wide land write path: ten instruction
//! encodings in a provisional tag band, their account lists, and the
//! program-version bit an experimental wide build carries.
//!
//! **Provisional, unallocated, unreachable by default.** The integrator
//! (workstream 4, `ABI-ALLOCATION-20261106.ja.md`) allocates instruction
//! tags; the band below, `0xD6..=0xDF`, is the whole free range
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
//! | 0xD8 | WideOpenProvince | `p i64, q i64` | D, top-level | writes the full province under an explicit rules configuration; refuses `NotImplemented` without one |
//! | 0xD9 | WideClaimSite | `p i64, q i64, site u8, slot u8` | P | **files the wide outpost ticket** under the deployed FileOutpost's prerequisites: the settler cost from the anchor, the cohort on the wide province, the Citizen marker, the record holding the wide holding's rent (`world_index::ticket`) |
//! | 0xDA | WideDepart | `host ref 56, transit_slot u8, arrive_bell u32, tip u64, commit 32, seal 165` | P | validates (the deployed Depart's checks), refuses `NotImplemented` (host identity unallocated) |
//! | 0xDB | WideSetRules | `config_version u16, keep_holder u8, free_city u8, camp u8, region u8` | O, top-level | writes the Season's experimental rules configuration once (`world_index::rules`), by the Season's authority |
//! | 0xDC | WideSettleTicket | `k u8` | D | the deployed SettleTicket over the wide ticket: expired, or the beacon seed of the ticket's bell and the province's region, the full-width score, fresh / displace / taken; the provisional wide holding from the record's escrow; the ticket ends and the record stays Settled, retaining the escrow a win did not consume (the deployed escrow retention) |
//! | 0xDD | WideResidentAct | `generation u32, inner (a P instruction of this band)` | P | the band's own `ResidentAct`: runs WideClaimSite or WideDepart for an NFT resident's Citizen with the four proof accounts appended and the signed holder generation; never routes a v2 tag, and `ResidentAct` never routes a draft tag |
//! | 0xDE | WideClose | `what u8` (0 ticket, 1 holding) | N | season end (Ended + 72 h, Aborted, the tombstone): a wide ticket record closes as CloseCitizen closes a Citizen: the escrow to its funder (listed exactly when non-zero), the rest whole to its immutable rent payer (pending: the Citizen's marker clears, before CloseCitizen; Settled: before or after CloseCitizen, the Citizen position then absent); a wide holding closes to its rent payer after its `pool_owed` is swept to the DefencePool (the deployed CloseHolding cannot close a 1,344-byte record) |
//! | 0xDF | WideFinalize | (none) | N | the deployed lazy provisional → final flip of a wide holding, callable by anyone: `now ≥ final_ts` **and** the ticket's cohort closed on its province (`prologue::finality_due`), else `TooEarly`; `AlreadyDone` once final |
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
pub const DRAFT_TAG_LAST: u8 = 0xDF;

pub const TAG_REQUEST_RING_SEED: u8 = 0xD6;
pub const TAG_CONSUME_RING_SEED: u8 = 0xD7;
pub const TAG_OPEN_PROVINCE: u8 = 0xD8;
pub const TAG_CLAIM_SITE: u8 = 0xD9;
pub const TAG_DEPART: u8 = 0xDA;
pub const TAG_SET_RULES: u8 = 0xDB;
pub const TAG_SETTLE_TICKET: u8 = 0xDC;
pub const TAG_RESIDENT_ACT: u8 = 0xDD;
pub const TAG_CLOSE: u8 = 0xDE;
pub const TAG_FINALIZE: u8 = 0xDF;

/// `WideClose(what)`: the pending wide ticket's record.
pub const CLOSE_WHAT_TICKET: u8 = 0;
/// `WideClose(what)`: a wide holding.
pub const CLOSE_WHAT_HOLDING: u8 = 1;

/// Whether `t` is in the draft band.
pub const fn is_draft_tag(t: u8) -> bool {
    t >= DRAFT_TAG_FIRST && t <= DRAFT_TAG_LAST
}

/// The ten draft instructions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum WideIx {
    RequestRingSeed = TAG_REQUEST_RING_SEED,
    ConsumeRingSeed = TAG_CONSUME_RING_SEED,
    OpenProvince = TAG_OPEN_PROVINCE,
    ClaimSite = TAG_CLAIM_SITE,
    Depart = TAG_DEPART,
    SetRules = TAG_SET_RULES,
    SettleTicket = TAG_SETTLE_TICKET,
    ResidentAct = TAG_RESIDENT_ACT,
    Close = TAG_CLOSE,
    Finalize = TAG_FINALIZE,
}

impl WideIx {
    pub const ALL: [WideIx; 10] = [
        WideIx::RequestRingSeed,
        WideIx::ConsumeRingSeed,
        WideIx::OpenProvince,
        WideIx::ClaimSite,
        WideIx::Depart,
        WideIx::SetRules,
        WideIx::SettleTicket,
        WideIx::ResidentAct,
        WideIx::Close,
        WideIx::Finalize,
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
            TAG_SET_RULES => Some(WideIx::SetRules),
            TAG_SETTLE_TICKET => Some(WideIx::SettleTicket),
            TAG_RESIDENT_ACT => Some(WideIx::ResidentAct),
            TAG_CLOSE => Some(WideIx::Close),
            TAG_FINALIZE => Some(WideIx::Finalize),
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
            WideIx::SetRules => "WideSetRules",
            WideIx::SettleTicket => "WideSettleTicket",
            WideIx::ResidentAct => "WideResidentAct",
            WideIx::Close => "WideClose",
            WideIx::Finalize => "WideFinalize",
        }
    }

    /// Refuses CPI, as the deployed ConsumeRingSeed and OpenProvince do
    /// (and the authority's configuration write).
    pub const fn top_level_only(self) -> bool {
        matches!(
            self,
            WideIx::ConsumeRingSeed | WideIx::OpenProvince | WideIx::SetRules
        )
    }

    /// The keeper class the deployed counterpart has (the configuration
    /// write is the operator's).
    pub const fn class(self) -> crate::tags::Class {
        match self {
            WideIx::RequestRingSeed
            | WideIx::ConsumeRingSeed
            | WideIx::OpenProvince
            | WideIx::SettleTicket => crate::tags::Class::D,
            WideIx::ClaimSite | WideIx::Depart | WideIx::ResidentAct => crate::tags::Class::P,
            WideIx::SetRules => crate::tags::Class::O,
            WideIx::Close | WideIx::Finalize => crate::tags::Class::N,
        }
    }

    /// The instructions WideResidentAct may run for an NFT resident's
    /// Citizen: the band's own player instructions and nothing of the ABI
    /// v2 (which `ResidentAct` routes, and which never routes a draft tag).
    pub const ACT_RUNS: [WideIx; 2] = [WideIx::ClaimSite, WideIx::Depart];

    pub const fn act_runs(self) -> bool {
        matches!(self, WideIx::ClaimSite | WideIx::Depart)
    }

    /// Whether the handler of this instruction can write today
    /// (WideOpenProvince only under an explicit rules configuration), or
    /// validates and refuses `NotImplemented` at its readiness gate
    /// (WideDepart: no wider host identity).
    pub const fn writes_today(self) -> bool {
        !matches!(self, WideIx::Depart)
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

/// 0xDB: `config_version u16` (must be `rules::WIDE_RULES_CONFIG_VERSION`)
/// and the four candidate bytes of `rules::RuleBytes` (0 is unset and
/// refused).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetRules {
    pub config_version: u16,
    pub keep_holder: u8,
    pub free_city: u8,
    pub camp: u8,
    pub region: u8,
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

/// 0xDC: `k u8` (the deployed SettleTicket's cursor; a wide ticket has one
/// site, so only `k = 0` settles).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleTicket {
    pub k: u8,
}

impl SettleTicket {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const LEN: usize = 2;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        [Self::IX.tag(), self.k]
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(SettleTicket {
            k: c.u8().ok_or(FrontierError::BadData)?,
        })
    }
}

/// 0xDE: `what u8` ([`CLOSE_WHAT_TICKET`] or [`CLOSE_WHAT_HOLDING`]; the
/// account list follows it: [`CLOSE_TICKET`] or [`CLOSE_HOLDING`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Close {
    pub what: u8,
}

impl Close {
    pub const IX: WideIx = WideIx::Close;
    pub const LEN: usize = 2;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        [Self::IX.tag(), self.what]
    }

    /// `BadData` for a `what` outside the two.
    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        let what = c.u8().ok_or(FrontierError::BadData)?;
        if what != CLOSE_WHAT_TICKET && what != CLOSE_WHAT_HOLDING {
            return Err(FrontierError::BadData);
        }
        Ok(Close { what })
    }
}

/// 0xDF: no data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finalize;

impl Finalize {
    pub const IX: WideIx = WideIx::Finalize;
    pub const LEN: usize = 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        [Self::IX.tag()]
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(Finalize)
    }
}

/// 0xDD: `generation u32 ‖ inner`, the inner a whole draft instruction
/// whose tag is in [`WideIx::ACT_RUNS`] (the shape of the deployed
/// `ResidentAct`, `resident_wire::Command::Act`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResidentAct<'a> {
    pub generation: u32,
    pub inner: &'a [u8],
}

impl<'a> ResidentAct<'a> {
    pub const IX: WideIx = WideIx::ResidentAct;
    /// The tag and the generation.
    pub const HEAD: usize = 1 + 4;

    /// `0xDD ‖ LE32(generation) ‖ inner` into `out` (`None` if short).
    pub fn encode_into(&self, out: &mut [u8]) -> Option<usize> {
        let n = Self::HEAD + self.inner.len();
        if out.len() < n {
            return None;
        }
        out[0] = Self::IX.tag();
        out[1..5].copy_from_slice(&self.generation.to_le_bytes());
        out[5..n].copy_from_slice(self.inner);
        Some(n)
    }

    /// Decodes the head and checks the inner tag is one the act runs
    /// (`BadData` otherwise; the inner instruction decodes itself).
    pub fn decode(d: &'a [u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if d.len() <= Self::HEAD || d[0] != Self::IX.tag() {
            return Err(bad);
        }
        let inner = &d[Self::HEAD..];
        if !tag_of(inner)?.act_runs() {
            return Err(bad);
        }
        Ok(ResidentAct {
            generation: u32::from_le_bytes([d[1], d[2], d[3], d[4]]),
            inner,
        })
    }
}

impl SetRules {
    pub const IX: WideIx = WideIx::SetRules;
    pub const LEN: usize = 1 + 2 + 4;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .u16(self.config_version)
            .u8(self.keep_holder)
            .u8(self.free_city)
            .u8(self.camp)
            .u8(self.region);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(SetRules {
            config_version: c.u16().ok_or(bad)?,
            keep_holder: c.u8().ok_or(bad)?,
            free_city: c.u8().ok_or(bad)?,
            camp: c.u8().ok_or(bad)?,
            region: c.u8().ok_or(bad)?,
        })
    }
}

/// Data length with the tag of each fixed-width draft instruction
/// (`None` for the variable-width WideResidentAct).
pub const fn data_len(ix: WideIx) -> Option<usize> {
    match ix {
        WideIx::RequestRingSeed => Some(RequestRingSeed::LEN),
        WideIx::ConsumeRingSeed => Some(ConsumeRingSeed::LEN),
        WideIx::OpenProvince => Some(OpenProvince::LEN),
        WideIx::ClaimSite => Some(ClaimSite::LEN),
        WideIx::Depart => Some(Depart::LEN),
        WideIx::SetRules => Some(SetRules::LEN),
        WideIx::SettleTicket => Some(SettleTicket::LEN),
        WideIx::ResidentAct => None,
        WideIx::Close => Some(Close::LEN),
        WideIx::Finalize => Some(Finalize::LEN),
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

const fn opt(specs: &'static [Spec]) -> Group {
    Group {
        specs,
        min: 0,
        max: 1,
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
/// [rules_config r] [system]`: the deployed OpenProvince list with wide
/// positions and the Season's experimental rules configuration (absent:
/// the opening refuses `NotImplemented`).
pub const OPEN_PROVINCE: &[Group] = &[one(&[
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("wide_ringseed", WIDE, false, Wr::W),
    s("pfund", Acc::Kind(K::ProvinceFund), false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("rules_config", WIDE, false, Wr::R),
    s("system", Acc::System, false, Wr::R),
])];

/// The deployed player prologue `[actor s] [payer s,w] [season r]
/// [citizen w]`, then the deployed FileOutpost's positions over wide land:
/// `[frontier r]` (the folded land gate), `[province w]` (the wide
/// province whose cohort takes the ticket), `[wide_ticket w]` (the record
/// to create, holding the wide Holding's rent), `[anchor_holding w]
/// [anchor_province r]` (the final first home that pays the settler cost
/// and bounds the range, with its canonical province), `[previous_holding
/// w] [previous_province r]` (the slot-2 holding and its province for a
/// slot-3 claim, legacy or wide, the lazy finality flip applied to a wide
/// one; the anchor pair again for a slot-2 claim), `[system]`.
pub const CLAIM_SITE: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("frontier", Acc::Kind(K::Frontier), false, Wr::R),
    s("province", WIDE, false, Wr::W),
    s("wide_ticket", WIDE, false, Wr::W),
    s("anchor_holding", Acc::Kind(K::Holding), false, Wr::W),
    s("anchor_province", Acc::Kind(K::Province), false, Wr::R),
    s("previous_holding", WIDE, false, Wr::W),
    s("previous_province", WIDE, false, Wr::R),
    s("system", Acc::System, false, Wr::R),
])];

/// The deployed SettleTicket's shape over the wide ticket: `[payer s,w]
/// [season r] [citizen w] [wide_ticket w] [holding w] [province w]
/// [joinshard w] [seedcache|archive r] [anchor|archive r]`, then the
/// displaced trio `[displaced_rent_payer w] [displaced_citizen w]
/// [displaced_joinshard w]` exactly when the settle displaces, then
/// `[system]`. No funder: as deployed, a settle pays nothing to the
/// funder; the record retains its escrow.
pub const SETTLE_TICKET: &[Group] = &[
    one(&[
        s("payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
        s("wide_ticket", WIDE, false, Wr::W),
        s("holding", WIDE, false, Wr::W),
        s("province", WIDE, false, Wr::W),
        s("joinshard", Acc::Kind(K::JoinShard), false, Wr::W),
        s("seed", Acc::Any, false, Wr::R),
        s("anchor", Acc::Any, false, Wr::R),
    ]),
    opt(&[
        s("displaced_rent_payer", Acc::Wallet, false, Wr::W),
        s("displaced_citizen", Acc::Kind(K::Citizen), false, Wr::W),
        s("displaced_joinshard", Acc::Kind(K::JoinShard), false, Wr::W),
    ]),
    one(&[s("system", Acc::System, false, Wr::R)]),
];

/// WideClose(0): `[any s] [season r] [citizen w] [wide_ticket w]
/// [rent_payer w] [funder w]?`: the season-end close of a wide ticket
/// record, pending or Settled, in CloseCitizen's shape: the record's
/// immutable rent payer receives the record's rent and any excess, and the
/// funder, listed **exactly when the escrow is non-zero**
/// (`TooManyAccounts` otherwise, as CloseCitizen), receives the escrow. The
/// Season position is `Any`: the Closed tombstone is not a Season-kind
/// account. The Citizen position is `Any`: a Settled record outlives its
/// Citizen's close, and the position then holds the absent account at the
/// Citizen's address.
pub const CLOSE_TICKET: &[Group] = &[
    one(&[
        s("any", Acc::Wallet, true, Wr::R),
        s("season", Acc::Any, false, Wr::R),
        s("citizen", Acc::Any, false, Wr::W),
        s("wide_ticket", WIDE, false, Wr::W),
        s("rent_payer", Acc::Wallet, false, Wr::W),
    ]),
    opt(&[s("funder", Acc::Wallet, false, Wr::W)]),
];

/// WideClose(1): `[any s] [season r] [holding w] [rent_payer w] [dpool w]`:
/// the deployed CloseHolding's shape over a wide holding (on the tombstone
/// position 4 is the Season's authority, as deployed).
pub const CLOSE_HOLDING: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("holding", WIDE, false, Wr::W),
    s("rent_payer", Acc::Wallet, false, Wr::W),
    s("dpool", Acc::Any, false, Wr::W),
])];

/// `[any s] [season r] [holding w] [province r]`: the permissionless
/// finality flip of a wide holding.
pub const FINALIZE: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("holding", WIDE, false, Wr::W),
    s("province", WIDE, false, Wr::R),
])];

/// WideResidentAct has no table of its own: its accounts are the inner
/// instruction's list followed by the four read-only proof accounts
/// `[policy, link, asset, resident]`, as the deployed `ResidentAct`.
pub const RESIDENT_ACT: &[Group] = &[];

/// `[authority s,w] [season r] [rules_config w] [system]`: the Season's
/// authority writes the configuration once.
pub const SET_RULES: &[Group] = &[one(&[
    s("authority", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("rules_config", WIDE, false, Wr::W),
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

/// The account list of a draft instruction (WideClose's is its ticket
/// shape; the handler checks [`CLOSE_HOLDING`] for `what = 1`).
pub const fn accounts_of(ix: WideIx) -> &'static [Group] {
    match ix {
        WideIx::RequestRingSeed => REQUEST_RING_SEED,
        WideIx::ConsumeRingSeed => CONSUME_RING_SEED,
        WideIx::OpenProvince => OPEN_PROVINCE,
        WideIx::ClaimSite => CLAIM_SITE,
        WideIx::Depart => DEPART,
        WideIx::SetRules => SET_RULES,
        WideIx::SettleTicket => SETTLE_TICKET,
        WideIx::ResidentAct => RESIDENT_ACT,
        WideIx::Close => CLOSE_TICKET,
        WideIx::Finalize => FINALIZE,
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
        for t in [0xD5u8, 0xC1, 0xE0, 0xE2, 0xFE, 0xFF, 0x00] {
            assert!(!is_draft_tag(t));
            assert_eq!(tag_of(&[t]), Err(FrontierError::BadData));
        }
        assert_eq!(WideIx::ALL.len(), 10);
        // the band's act runs its own two player instructions and nothing
        // of the ABI v2; the deployed act's list has no draft tag
        assert_eq!(WideIx::ACT_RUNS, [WideIx::ClaimSite, WideIx::Depart]);
        for ix in WideIx::ALL {
            assert_eq!(ix.act_runs(), WideIx::ACT_RUNS.contains(&ix));
            assert!(crate::v2::Ix::from_tag(ix.tag()).is_none());
            assert!(!crate::resident_wire::ACT_RUNS
                .iter()
                .any(|v| v.tag() == ix.tag()));
        }
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
        assert!(WideIx::SetRules.top_level_only());
        assert!(!WideIx::RequestRingSeed.top_level_only());
        assert!(!WideIx::ClaimSite.top_level_only());
        assert!(!WideIx::Depart.top_level_only());
        // the march handler alone refuses at its readiness gate (the wider
        // host identity); the opening writes only under an explicit
        // configuration
        let gated: Vec<WideIx> = WideIx::ALL
            .iter()
            .copied()
            .filter(|i| !i.writes_today())
            .collect();
        assert_eq!(gated, [WideIx::Depart]);
        assert_eq!(WideIx::SetRules.class(), crate::tags::Class::O);
        assert_eq!(WideIx::ClaimSite.class(), crate::tags::Class::P);
        assert_eq!(WideIx::ResidentAct.class(), crate::tags::Class::P);
        assert_eq!(WideIx::OpenProvince.class(), crate::tags::Class::D);
        assert_eq!(WideIx::SettleTicket.class(), crate::tags::Class::D);
        assert_eq!(WideIx::Close.class(), crate::tags::Class::N);
        assert_eq!(WideIx::Finalize.class(), crate::tags::Class::N);
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
        let r = SetRules {
            config_version: 1,
            keep_holder: 1,
            free_city: 2,
            camp: 2,
            region: 1,
        };
        let b = r.to_bytes();
        assert_eq!(b.len(), 7);
        assert_eq!(b, [0xDB, 1, 0, 1, 2, 2, 1]);
        assert_eq!(SetRules::decode(&b), Ok(r));
        assert_eq!(SetRules::decode(&b[..6]), Err(FrontierError::BadData));
        assert_eq!(tag_of(&b), Ok(WideIx::SetRules));
        let st = SettleTicket { k: 0 };
        assert_eq!(st.to_bytes(), [0xDC, 0]);
        assert_eq!(SettleTicket::decode(&[0xDC, 0]), Ok(st));
        assert_eq!(SettleTicket::decode(&[0xDC]), Err(FrontierError::BadData));
        assert_eq!(Close { what: 0 }.to_bytes(), [0xDE, 0]);
        assert_eq!(Close::decode(&[0xDE, 0]), Ok(Close { what: 0 }));
        assert_eq!(Close::decode(&[0xDE, 1]), Ok(Close { what: 1 }));
        assert_eq!(Close::decode(&[0xDE, 2]), Err(FrontierError::BadData));
        assert_eq!(Close::decode(&[0xDE]), Err(FrontierError::BadData));
        assert_eq!(Finalize.to_bytes(), [0xDF]);
        assert_eq!(Finalize::decode(&[0xDF]), Ok(Finalize));
        assert_eq!(Finalize::decode(&[0xDF, 0]), Err(FrontierError::BadData));
        // the act: a generation and a whole inner instruction of the band's
        // player list; a v2 tag, a non-player draft tag or an empty inner
        // are refused
        let inner = ClaimSite {
            p: 129,
            q: 0,
            site: 1,
            slot: 2,
        }
        .to_bytes();
        let mut buf = [0u8; 64];
        let n = ResidentAct {
            generation: 7,
            inner: &inner,
        }
        .encode_into(&mut buf)
        .unwrap();
        assert_eq!(n, 5 + ClaimSite::LEN);
        assert_eq!(&buf[..5], &[0xDD, 7, 0, 0, 0]);
        let act = ResidentAct::decode(&buf[..n]).unwrap();
        assert_eq!(act.generation, 7);
        assert_eq!(ClaimSite::decode(act.inner).unwrap().p, 129);
        assert_eq!(tag_of(&buf[..n]), Ok(WideIx::ResidentAct));
        assert_eq!(ResidentAct::decode(&buf[..5]), Err(FrontierError::BadData));
        let mut v2 = buf;
        v2[5] = crate::v2::Ix::Harvest.tag();
        assert_eq!(ResidentAct::decode(&v2[..n]), Err(FrontierError::BadData));
        let mut not_player = buf;
        not_player[5] = TAG_OPEN_PROVINCE;
        assert_eq!(
            ResidentAct::decode(&not_player[..n]),
            Err(FrontierError::BadData)
        );
        let mut nested = buf;
        nested[5] = TAG_RESIDENT_ACT;
        assert_eq!(
            ResidentAct::decode(&nested[..n]),
            Err(FrontierError::BadData)
        );
        assert!(ResidentAct {
            generation: 0,
            inner: &inner
        }
        .encode_into(&mut [0u8; 8])
        .is_none());
        for ix in WideIx::ALL {
            match data_len(ix) {
                Some(n) => assert!(n >= 1),
                None => assert_eq!(ix, WideIx::ResidentAct),
            }
        }
    }

    /// Every table resolves, names every position, bounds the count, and
    /// keeps the deployed counterparts' shapes plus the wide positions.
    #[test]
    fn account_tables_are_consistent_and_named() {
        for ix in WideIx::ALL {
            let groups = accounts_of(ix);
            if ix == WideIx::ResidentAct {
                assert!(groups.is_empty(), "the act takes the inner's list");
                continue;
            }
            assert!(!groups.is_empty(), "{}", ix.name());
            let (lo, hi) = bounds_in(groups);
            if ix == WideIx::SettleTicket {
                assert_eq!((lo, hi), (10, 13), "the displaced trio is optional");
            } else if ix == WideIx::Close {
                assert_eq!((lo, hi), (5, 6), "the escrow funder is optional");
            } else {
                assert_eq!(lo, hi, "{}: every other draft list is fixed", ix.name());
            }
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
        assert_eq!(bounds_in(OPEN_PROVINCE), (7, 7));
        assert_eq!(bounds_in(CLAIM_SITE), (12, 12));
        assert_eq!(bounds_in(DEPART), (7, 7));
        assert_eq!(bounds_in(SET_RULES), (4, 4));
        assert_eq!(bounds_in(SETTLE_TICKET), (10, 13));
        assert_eq!(bounds_in(CLOSE_TICKET), (5, 6));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseCitizen),
            (4, 5),
            "the wide ticket close is CloseCitizen's shape plus the record"
        );
        assert_eq!(bounds_in(CLOSE_HOLDING), (5, 5));
        assert_eq!(bounds_in(FINALIZE), (4, 4));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseHolding),
            (5, 5),
            "the wide holding close keeps CloseHolding's shape"
        );
        // the deployed SettleTicket is 9..=14 (its other provinces and the
        // displaced trio); the wide one has one site and a record, and as
        // deployed names no funder (a settle pays the funder nothing)
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::SettleTicket),
            (9, 14)
        );
        // the claim keeps FileOutpost's shape beyond the prologue: the
        // Frontier, the anchor pair and the previous pair
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::OpenProvince).0 + 1,
            bounds_in(OPEN_PROVINCE).0,
            "one position wider: the rules configuration"
        );
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
        assert_eq!(position_in(OPEN_PROVINCE, 7, "province", 0), Some(4));
        assert_eq!(position_in(OPEN_PROVINCE, 7, "rules_config", 0), Some(5));
        assert_eq!(position_in(CLAIM_SITE, 12, "frontier", 0), Some(4));
        assert_eq!(position_in(CLAIM_SITE, 12, "wide_ticket", 0), Some(6));
        assert_eq!(position_in(CLAIM_SITE, 12, "anchor_holding", 0), Some(7));
        assert_eq!(
            position_in(CLAIM_SITE, 12, "previous_province", 0),
            Some(10)
        );
        assert_eq!(position_in(SETTLE_TICKET, 10, "funder", 0), None);
        assert_eq!(position_in(SETTLE_TICKET, 10, "anchor", 0), Some(8));
        assert_eq!(position_in(SETTLE_TICKET, 10, "system", 0), Some(9));
        assert_eq!(
            position_in(SETTLE_TICKET, 13, "displaced_citizen", 0),
            Some(10)
        );
        assert_eq!(position_in(SETTLE_TICKET, 13, "system", 0), Some(12));
        assert_eq!(position_in(CLOSE_TICKET, 5, "wide_ticket", 0), Some(3));
        assert_eq!(position_in(CLOSE_TICKET, 5, "rent_payer", 0), Some(4));
        assert_eq!(position_in(CLOSE_TICKET, 5, "funder", 0), None);
        assert_eq!(position_in(CLOSE_TICKET, 6, "funder", 0), Some(5));
        assert_eq!(
            CLOSE_TICKET[0].specs[2].acc,
            Acc::Any,
            "a Settled record closes after its Citizen: the position may be absent"
        );
        assert_eq!(position_in(CLOSE_HOLDING, 5, "dpool", 0), Some(4));
        assert_eq!(position_in(FINALIZE, 4, "province", 0), Some(3));
        assert_eq!(position_in(DEPART, 7, "province", 0), Some(5));
        assert_eq!(position_in(SET_RULES, 4, "rules_config", 0), Some(2));
        // wide positions are the handler's to authenticate; the legacy
        // positions of the claim keep their deployed kinds
        for g in REQUEST_RING_SEED
            .iter()
            .chain(OPEN_PROVINCE)
            .chain(CLAIM_SITE)
            .chain(DEPART)
            .chain(SET_RULES)
            .chain(SETTLE_TICKET)
            .chain(CLOSE_TICKET)
            .chain(CLOSE_HOLDING)
            .chain(FINALIZE)
        {
            for sp in g.specs {
                if matches!(
                    sp.name,
                    "previous"
                        | "wide_ringseed"
                        | "province"
                        | "holding"
                        | "rules_config"
                        | "previous_holding"
                        | "previous_province"
                        | "wide_ticket"
                ) {
                    assert_eq!(sp.acc, Acc::Any, "{}", sp.name);
                }
            }
        }
        assert_eq!(CLAIM_SITE[0].specs[7].acc, Acc::Kind(K::Holding));
        assert_eq!(CLAIM_SITE[0].specs[8].acc, Acc::Kind(K::Province));
        assert_eq!(
            CLAIM_SITE[0].specs[9].wr,
            Wr::W,
            "the slot-2 holding may flip final"
        );
        assert_eq!(SETTLE_TICKET[0].specs[6].acc, Acc::Kind(K::JoinShard));
        assert_eq!(SETTLE_TICKET[1].specs[1].acc, Acc::Kind(K::Citizen));
        assert!(SET_RULES[0].specs[0].signer && SET_RULES[0].specs[0].wr == Wr::W);
    }
}
