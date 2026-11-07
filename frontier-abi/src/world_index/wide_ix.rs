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
//! | 0xDA | WideDepart | `host ref 56, transit_slot u8, arrive_bell u32, tip u64, commit 32, seal 264` | P | **the wide march's departure**: the deployed Depart's checks over the standing province and the issuing holding's province (the deployed shape plus the holding's **four** wide transit positions and the standing `[roster r]`), a standing province of the legacy disk refused (`NotImplemented`: no shared quota, roster or resolution across the boundary), the full-slot proof (no open record of this host in any of the four); then, **gated** `NotImplemented` before any effect until the closed flow passes native review (`proc::wide::DEPART_DEBIT_ENABLED`): the entry's `Spend`, the escrow `tip + fee + bond` into the holding, the 288-byte wide transit record created from the payer at `march::transit_address` (its immutable `rent_to` the payer), `open_transits + 1`; the `WIDE_DEPARTED` record |
//! | 0xEE | WideReveal | `transit_slot u8, target_i u8, plain 136, salt 32, ct_hash 32, beneficiary 32` | **W**, top-level | the deployed Reveal over the wide records (below) |
//! | 0xDB | WideSetRules | `config_version u16, keep_holder u8, free_city u8, camp u8, region u8` | O, top-level | writes the Season's experimental rules configuration once (`world_index::rules`), by the Season's authority |
//! | 0xDC | WideSettleTicket | `k u8` | D | the deployed SettleTicket over the wide ticket: expired, or the beacon seed of the ticket's bell and the province's region, the full-width score, fresh / displace / taken; the provisional wide holding from the record's escrow; the ticket ends and the record stays Settled, retaining the escrow a win did not consume (the deployed escrow retention) |
//! | 0xDD | WideResidentAct | `generation u32, inner (a P instruction of this band)` | P | the band's own `ResidentAct`: runs WideClaimSite or WideDepart for an NFT resident's Citizen with the four proof accounts appended and the signed holder generation; never routes a v2 tag, and `ResidentAct` never routes a draft tag |
//! | 0xDE | WideClose | `what u8` (0 ticket, 1 holding, 2 ArrivalSlot, 3 ArrivalDay, 4 ClashInputs, 5 transit, 6 province) | N | season end (Ended + 72 h, Aborted, the tombstone): a wide ticket record closes as CloseCitizen closes a Citizen: the escrow to its funder (listed exactly when non-zero), the rest whole to its immutable rent payer (pending: the Citizen's marker clears, before CloseCitizen; Settled: before or after CloseCitizen, the Citizen position then absent); a wide holding closes to its rent payer after its `pool_owed` is swept to the DefencePool, the escrow of unsettled marches included, as the deployed CloseHolding does; the march records close under the deployed closes' own case rules (CloseArrivalSlot, CloseArrivalDay, CloseClashInputs) to their immutable rent recipients, a transit record left open at season end to its own (the holding position at its canonical address, counted down when present), and a wide province into the fund of the wedge that opened it as the deployed CloseProvince does (Ended + 72 h or Aborted; never the tombstone, whose CloseSeason closed the funds). After the deadline the closes run in any order, none reading another's account: the deployed expiry rule |
//! | 0xDF | WideFinalize | (none) | N | the deployed lazy provisional → final flip of a wide holding, callable by anyone: `now ≥ final_ts` **and** the ticket's cohort closed on its province (`prologue::finality_due`), else `TooEarly`; `AlreadyDone` once final |
//!
//! Coordinates are the full `i64` pair of a `WideCoord` (never an `i16`
//! or a dense index); rings are `u64`; a host is the 56-byte
//! `WideHostRef`. Every encoding is fixed width, little-endian, exact
//! length.
//!
//! ## The versioned sub-operation envelope (2026-11-07)
//!
//! The band is full, and the bytes around it belong to other workstreams,
//! so the closed host lifecycle (Muster → Resolve → Dissolve → Return, the
//! roster close) is carried **inside three tags of this band whose class
//! it shares**, under an explicit escape, a version and a sub-operation
//! byte: `tag ‖ 0xFF ‖ 0x01 ‖ op ‖ payload`, exact length per op
//! ([`ENVELOPE_ESCAPE`], [`ENVELOPE_VERSION`]). The tags' existing
//! encodings are untouched and still exact: a datum of the tag's legacy
//! length decodes as before and nothing else does; any other length must
//! be a whole envelope of that tag (the escape, the version, a known op,
//! the op's exact length) or it is `BadData`. No datum is ambiguous: a
//! Depart is 366 bytes and its second byte is a host reference version
//! (1), a SettleTicket is 2 bytes, a Close is 2 bytes; every envelope is
//! at least 4 bytes with 0xFF second. [`WideCommand::decode`] is the one
//! parser; the dispatcher routes, checks the class, the top-level rule,
//! the account table and the NFT whitelist by the **decoded command**,
//! never by the tag alone.
//!
//! | tag | class | op | command | data after the head | account table |
//! |---|---|---|---|---|---|
//! | 0xDA | P | 1 | WideMuster | `unit u8, troops u32, tile u8` | [`MUSTER`] |
//! | 0xDA | P | 2 | WideDissolve | `host ref 56` | [`DISSOLVE`] (12: the four transit records) |
//! | 0xDC | D, top-level | 1 | WideResolve | `bell u32, beneficiary 32` | [`RESOLVE`] (9: the arrival evidence and System) |
//! | 0xDC | D | 2 | WideReturn | (none) | [`RETURN`] (9: the four transit records; the holding's own province optional) |
//! | 0xDC | D | 3 | WideSettleDeparture | `host ref 56, transit_slot u8` | [`SETTLE_DEPARTURE`] |
//! | 0xDC | D, top-level | 4 | WideGather | `bell u32, start u8, n u8` | [`GATHER`] |
//! | 0xDC | D | 5 | WideSettleTransit | `transit_slot u8, commit 32, seal 264, beneficiary 32` | [`SETTLE_TRANSIT`] (17 fixed, the owner Citizen optional) |
//! | 0xDE | N | 1 | WideCloseRoster | (none) | [`CLOSE_ROSTER`] (5: the province position at its canonical address, present or already closed) |
//!
//! **The march stages** (ops 3–5 of 0xDC) are the class-D stages of the
//! deployed march (SettleDeparture, GatherClash, SettleTransit) over the
//! wide records: the wide transit record (`march::WideTransit`), the wide
//! ArrivalSlot and ClashInputs (`world_index::arrival`). WideGather's
//! account list carries, after the fixed positions, one `[slot r] [transit
//! w]` pair per position of its cursor (`start..start + n`): the wide world
//! has no ArrivalDay record, so a gather scans the slot addresses it names
//! and "no arrivals" is the state of a fully gathered record with no
//! present position. WideSettleTransit takes an optional `[citizen w]`
//! after the fixed positions, mandatory exactly when the host earns the
//! camp's loot (the deployed rule).
//!
//! ## The class-W carrier: 0xEE WideReveal (2026-11-07)
//!
//! The deployed Reveal is class **W** (window-closing) and no tag of the
//! band is; a Reveal cannot be carried inside a class-D or class-P tag
//! without changing what the keeper's budget escalation sees. The
//! allocation note (`ABI-ALLOCATION-20261106.ja.md` §2.1, revision 3)
//! lists `0xCD–0xCF` and `0xEE–0xEF` as free; `0xEE` is taken here as the
//! **experimental** carrier of WideReveal ([`TAG_REVEAL`]): outside every
//! v2 and M1 tag, every reserved tag and every other workstream's band
//! (pinned by the tests), refused as an unknown instruction by a default
//! build and by the verifier (`new_bands.rs` lists it among the unallocated
//! tags), routed only by the `wide-world-experimental` build. Its data is
//! the deployed Reveal's with the wide 136-byte plaintext in place of the
//! 37-byte one; its account list is the deployed Reveal's shape with the
//! wide records in place of the deployed ones (the wide ArrivalDay
//! included) and the transit record named. Not an allocation: as
//! provisional as the band, and documented as the one tag outside it.

use crate::bytes::{Cursor, Writer};
use crate::error::FrontierError;
use crate::ix::HINTS_LEN;
use crate::layout::AccountKind as K;
use crate::prologue::{Acc, Group, Spec, Wr};
use crate::world_index::key::HOST_REF_LEN;
use crate::world_index::seal::{WIDE_PLAIN_LEN, WIDE_SEAL_LEN};

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
/// The experimental class-W carrier of WideReveal, the one tag outside the
/// band (module doc, "the class-W carrier"): a free tag of the allocation
/// note's revision 3, not an allocation.
pub const TAG_REVEAL: u8 = 0xEE;

/// `WideClose(what)`: the pending wide ticket's record.
pub const CLOSE_WHAT_TICKET: u8 = 0;
/// `WideClose(what)`: a wide holding.
pub const CLOSE_WHAT_HOLDING: u8 = 1;
/// `WideClose(what)`: a wide ArrivalSlot (the deployed CloseArrivalSlot).
pub const CLOSE_WHAT_SLOT: u8 = 2;
/// `WideClose(what)`: a wide ArrivalDay (the deployed CloseArrivalDay).
pub const CLOSE_WHAT_DAY: u8 = 3;
/// `WideClose(what)`: a wide ClashInputs (the deployed CloseClashInputs).
pub const CLOSE_WHAT_INPUTS: u8 = 4;
/// `WideClose(what)`: a wide transit record left open at season end (the
/// deployed Holding's transit slots die with the Holding; the wide record
/// is its own account and closes to its own rent recipient).
pub const CLOSE_WHAT_TRANSIT: u8 = 5;
/// `WideClose(what)`: a wide province (the deployed CloseProvince: whole
/// into the fund of the wedge that opened it, `provinces_opened − 1`).
pub const CLOSE_WHAT_PROVINCE: u8 = 6;
/// The highest `what` a WideClose carries.
pub const CLOSE_WHAT_MAX: u8 = CLOSE_WHAT_PROVINCE;

/// Whether `t` is a tag the experimental build routes: the draft band or
/// the class-W carrier.
pub const fn is_draft_tag(t: u8) -> bool {
    (t >= DRAFT_TAG_FIRST && t <= DRAFT_TAG_LAST) || t == TAG_REVEAL
}

/// The eleven draft instructions.
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
    Reveal = TAG_REVEAL,
}

impl WideIx {
    pub const ALL: [WideIx; 11] = [
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
        WideIx::Reveal,
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
            TAG_REVEAL => Some(WideIx::Reveal),
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
            WideIx::Reveal => "WideReveal",
        }
    }

    /// Refuses CPI, as the deployed ConsumeRingSeed, OpenProvince and
    /// Reveal do (and the authority's configuration write).
    pub const fn top_level_only(self) -> bool {
        matches!(
            self,
            WideIx::ConsumeRingSeed | WideIx::OpenProvince | WideIx::SetRules | WideIx::Reveal
        )
    }

    /// The keeper class the deployed counterpart has (the configuration
    /// write is the operator's; the reveal is window-closing).
    pub const fn class(self) -> crate::tags::Class {
        match self {
            WideIx::RequestRingSeed
            | WideIx::ConsumeRingSeed
            | WideIx::OpenProvince
            | WideIx::SettleTicket => crate::tags::Class::D,
            WideIx::ClaimSite | WideIx::Depart | WideIx::ResidentAct => crate::tags::Class::P,
            WideIx::SetRules => crate::tags::Class::O,
            WideIx::Close | WideIx::Finalize => crate::tags::Class::N,
            WideIx::Reveal => crate::tags::Class::W,
        }
    }

    /// The instructions WideResidentAct may run for an NFT resident's
    /// Citizen: the band's own player instructions and nothing of the ABI
    /// v2 (which `ResidentAct` routes, and which never routes a draft tag).
    pub const ACT_RUNS: [WideIx; 2] = [WideIx::ClaimSite, WideIx::Depart];

    pub const fn act_runs(self) -> bool {
        matches!(self, WideIx::ClaimSite | WideIx::Depart)
    }

    /// Whether the handler of this instruction can write today. Every one
    /// can (WideOpenProvince only under an explicit rules configuration;
    /// WideDepart since the march stages exist); kept for the tests that
    /// pin the gated set.
    pub const fn writes_today(self) -> bool {
        true
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
    /// The **wide** seal (`world_index::seal`, 264 bytes: the deployed IBE
    /// block and the 136-byte wide body), whose root the transit record
    /// stores and WideReveal and WideSettleTransit check.
    pub seal: [u8; WIDE_SEAL_LEN],
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
    pub const LEN: usize = 1 + HOST_REF_LEN + 1 + 4 + 8 + 32 + WIDE_SEAL_LEN;

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

    /// `BadData` for a `what` above [`CLOSE_WHAT_MAX`].
    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        let what = c.u8().ok_or(FrontierError::BadData)?;
        if what > CLOSE_WHAT_MAX {
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

// ------------------------------------------------------------ the envelope

/// The second byte of an envelope datum (module doc).
pub const ENVELOPE_ESCAPE: u8 = 0xFF;
/// The third byte: the envelope's version. A later layout is a new version.
pub const ENVELOPE_VERSION: u8 = 1;
/// `tag ‖ escape ‖ version ‖ op`.
pub const ENVELOPE_HEAD: usize = 4;

pub const OP_MUSTER: u8 = 1;
pub const OP_DISSOLVE: u8 = 2;
pub const OP_RESOLVE: u8 = 1;
pub const OP_RETURN: u8 = 2;
/// 0xDC op 3: the origin side of a march after its departure bell (the
/// deployed SettleDeparture, class D).
pub const OP_SETTLE_DEPARTURE: u8 = 3;
/// 0xDC op 4: the destination's gather of revealed arrivals into the wide
/// ClashInputs (the deployed GatherClash, class D, top-level).
pub const OP_GATHER: u8 = 4;
/// 0xDC op 5: the destination side of a march after its arrival bell (the
/// deployed SettleTransit, class D).
pub const OP_SETTLE_TRANSIT: u8 = 5;
pub const OP_CLOSE_ROSTER: u8 = 1;

/// 0xDC op 3: `host ref 56, transit_slot u8`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleDeparture {
    pub host: [u8; HOST_REF_LEN],
    pub transit_slot: u8,
}

/// 0xDC op 4: `bell u32, start u8, n u8` (the deployed GatherClash's
/// cursor; the holdings bitmap and the beneficiary are the deployed
/// list's and are not carried until the handler exists).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gather {
    pub bell: u32,
    pub start: u8,
    pub n: u8,
}

/// 0xDC op 5: the deployed SettleTransit's data over the **wide** seal
/// (`transit_slot u8, commit 32, seal 264, beneficiary 32`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleTransit {
    pub transit_slot: u8,
    pub commit: [u8; 32],
    pub seal: [u8; WIDE_SEAL_LEN],
    pub beneficiary: [u8; 32],
}

impl SettleDeparture {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const OP: u8 = OP_SETTLE_DEPARTURE;
    pub const LEN: usize = ENVELOPE_HEAD + HOST_REF_LEN + 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        Writer::new(&mut b[ENVELOPE_HEAD..])
            .bytes(&self.host)
            .u8(self.transit_slot);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(SettleDeparture {
            host: c.arr().ok_or(bad)?,
            transit_slot: c.u8().ok_or(bad)?,
        })
    }
}

impl Gather {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const OP: u8 = OP_GATHER;
    pub const LEN: usize = ENVELOPE_HEAD + 4 + 1 + 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        Writer::new(&mut b[ENVELOPE_HEAD..])
            .u32(self.bell)
            .u8(self.start)
            .u8(self.n);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(Gather {
            bell: c.u32().ok_or(bad)?,
            start: c.u8().ok_or(bad)?,
            n: c.u8().ok_or(bad)?,
        })
    }
}

impl SettleTransit {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const OP: u8 = OP_SETTLE_TRANSIT;
    pub const LEN: usize = ENVELOPE_HEAD + 1 + 32 + WIDE_SEAL_LEN + 32;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        Writer::new(&mut b[ENVELOPE_HEAD..])
            .u8(self.transit_slot)
            .bytes(&self.commit)
            .bytes(&self.seal)
            .bytes(&self.beneficiary);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(SettleTransit {
            transit_slot: c.u8().ok_or(bad)?,
            commit: c.arr().ok_or(bad)?,
            seal: c.arr().ok_or(bad)?,
            beneficiary: c.arr().ok_or(bad)?,
        })
    }
}

/// 0xDA op 1: the deployed Muster's data (`unit u8, troops u32, tile
/// u8`); the holding is the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Muster {
    pub unit: u8,
    pub troops: u32,
    pub tile: u8,
}

/// 0xDA op 2: the deployed Dissolve's data with the `u64` host id replaced
/// by the 56-byte wide host reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dissolve {
    pub host: [u8; HOST_REF_LEN],
}

/// 0xDC op 1: the deployed ResolveFromInputs' data (`bell u32,
/// beneficiary 32`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolve {
    pub bell: u32,
    pub beneficiary: [u8; 32],
}

/// 0xDC op 2: no data (the deployed SettleDeparture's return form names
/// the holding by account).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Return;

/// 0xDE op 1: no data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseRoster;

/// An envelope datum of `tag` and `op` with exactly `len` bytes:
/// the cursor over its payload.
fn envelope<'a>(d: &'a [u8], tag: u8, op: u8, len: usize) -> Result<Cursor<'a>, FrontierError> {
    if d.len() != len
        || d.len() < ENVELOPE_HEAD
        || d[0] != tag
        || d[1] != ENVELOPE_ESCAPE
        || d[2] != ENVELOPE_VERSION
        || d[3] != op
    {
        return Err(FrontierError::BadData);
    }
    Ok(Cursor::new(&d[ENVELOPE_HEAD..]))
}

fn head(b: &mut [u8], tag: u8, op: u8) {
    b[0] = tag;
    b[1] = ENVELOPE_ESCAPE;
    b[2] = ENVELOPE_VERSION;
    b[3] = op;
}

impl Muster {
    pub const IX: WideIx = WideIx::Depart;
    pub const OP: u8 = OP_MUSTER;
    pub const LEN: usize = ENVELOPE_HEAD + 1 + 4 + 1;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        Writer::new(&mut b[ENVELOPE_HEAD..])
            .u8(self.unit)
            .u32(self.troops)
            .u8(self.tile);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(Muster {
            unit: c.u8().ok_or(bad)?,
            troops: c.u32().ok_or(bad)?,
            tile: c.u8().ok_or(bad)?,
        })
    }
}

impl Dissolve {
    pub const IX: WideIx = WideIx::Depart;
    pub const OP: u8 = OP_DISSOLVE;
    pub const LEN: usize = ENVELOPE_HEAD + HOST_REF_LEN;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        b[ENVELOPE_HEAD..].copy_from_slice(&self.host);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(Dissolve {
            host: c.arr().ok_or(FrontierError::BadData)?,
        })
    }
}

impl Resolve {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const OP: u8 = OP_RESOLVE;
    pub const LEN: usize = ENVELOPE_HEAD + 4 + 32;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        Writer::new(&mut b[ENVELOPE_HEAD..])
            .u32(self.bell)
            .bytes(&self.beneficiary);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(Resolve {
            bell: c.u32().ok_or(bad)?,
            beneficiary: c.arr().ok_or(bad)?,
        })
    }
}

impl Return {
    pub const IX: WideIx = WideIx::SettleTicket;
    pub const OP: u8 = OP_RETURN;
    pub const LEN: usize = ENVELOPE_HEAD;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(Return)
    }
}

impl CloseRoster {
    pub const IX: WideIx = WideIx::Close;
    pub const OP: u8 = OP_CLOSE_ROSTER;
    pub const LEN: usize = ENVELOPE_HEAD;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        head(&mut b, Self::IX.tag(), Self::OP);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        envelope(d, Self::IX.tag(), Self::OP, Self::LEN)?;
        Ok(CloseRoster)
    }
}

/// Every command of the band, fully decoded: the ten legacy-shaped
/// instructions and the five envelope sub-operations. The one parser the
/// dispatcher runs ([`WideCommand::decode`]); class, top-level rule,
/// account table and the act's whitelist are read off the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideCommand<'a> {
    RequestRingSeed(RequestRingSeed),
    ConsumeRingSeed(ConsumeRingSeed),
    OpenProvince(OpenProvince),
    ClaimSite(ClaimSite),
    Depart(Depart),
    SetRules(SetRules),
    SettleTicket(SettleTicket),
    ResidentAct(ResidentAct<'a>),
    Close(Close),
    Finalize(Finalize),
    Muster(Muster),
    Dissolve(Dissolve),
    Resolve(Resolve),
    Return(Return),
    CloseRoster(CloseRoster),
    SettleDeparture(SettleDeparture),
    Gather(Gather),
    SettleTransit(SettleTransit),
    Reveal(Reveal),
}

impl<'a> WideCommand<'a> {
    /// The command of `data`: the tag's legacy encoding when `data` has
    /// its exact length, else a whole envelope of that tag (`BadData` for
    /// anything else: an unknown tag, a wrong length, a wrong escape,
    /// version or op).
    pub fn decode(d: &'a [u8]) -> Result<WideCommand<'a>, FrontierError> {
        let bad = FrontierError::BadData;
        let ix = tag_of(d)?;
        if ix == WideIx::ResidentAct {
            return ResidentAct::decode(d).map(WideCommand::ResidentAct);
        }
        if Some(d.len()) == data_len(ix) {
            return Ok(match ix {
                WideIx::RequestRingSeed => {
                    WideCommand::RequestRingSeed(RequestRingSeed::decode(d)?)
                }
                WideIx::ConsumeRingSeed => {
                    WideCommand::ConsumeRingSeed(ConsumeRingSeed::decode(d)?)
                }
                WideIx::OpenProvince => WideCommand::OpenProvince(OpenProvince::decode(d)?),
                WideIx::ClaimSite => WideCommand::ClaimSite(ClaimSite::decode(d)?),
                WideIx::Depart => WideCommand::Depart(Depart::decode(d)?),
                WideIx::SetRules => WideCommand::SetRules(SetRules::decode(d)?),
                WideIx::SettleTicket => WideCommand::SettleTicket(SettleTicket::decode(d)?),
                WideIx::Close => WideCommand::Close(Close::decode(d)?),
                WideIx::Finalize => WideCommand::Finalize(Finalize::decode(d)?),
                WideIx::Reveal => WideCommand::Reveal(Reveal::decode(d)?),
                WideIx::ResidentAct => return Err(bad),
            });
        }
        if d.len() < ENVELOPE_HEAD || d[1] != ENVELOPE_ESCAPE || d[2] != ENVELOPE_VERSION {
            return Err(bad);
        }
        match (ix, d[3]) {
            (WideIx::Depart, OP_MUSTER) => Muster::decode(d).map(WideCommand::Muster),
            (WideIx::Depart, OP_DISSOLVE) => Dissolve::decode(d).map(WideCommand::Dissolve),
            (WideIx::SettleTicket, OP_RESOLVE) => Resolve::decode(d).map(WideCommand::Resolve),
            (WideIx::SettleTicket, OP_RETURN) => Return::decode(d).map(WideCommand::Return),
            (WideIx::SettleTicket, OP_SETTLE_DEPARTURE) => {
                SettleDeparture::decode(d).map(WideCommand::SettleDeparture)
            }
            (WideIx::SettleTicket, OP_GATHER) => Gather::decode(d).map(WideCommand::Gather),
            (WideIx::SettleTicket, OP_SETTLE_TRANSIT) => {
                SettleTransit::decode(d).map(WideCommand::SettleTransit)
            }
            (WideIx::Close, OP_CLOSE_ROSTER) => {
                CloseRoster::decode(d).map(WideCommand::CloseRoster)
            }
            _ => Err(bad),
        }
    }

    /// The tag the command is carried under.
    pub const fn ix(&self) -> WideIx {
        match self {
            WideCommand::RequestRingSeed(_) => WideIx::RequestRingSeed,
            WideCommand::ConsumeRingSeed(_) => WideIx::ConsumeRingSeed,
            WideCommand::OpenProvince(_) => WideIx::OpenProvince,
            WideCommand::ClaimSite(_) => WideIx::ClaimSite,
            WideCommand::Depart(_) | WideCommand::Muster(_) | WideCommand::Dissolve(_) => {
                WideIx::Depart
            }
            WideCommand::SetRules(_) => WideIx::SetRules,
            WideCommand::SettleTicket(_)
            | WideCommand::Resolve(_)
            | WideCommand::Return(_)
            | WideCommand::SettleDeparture(_)
            | WideCommand::Gather(_)
            | WideCommand::SettleTransit(_) => WideIx::SettleTicket,
            WideCommand::ResidentAct(_) => WideIx::ResidentAct,
            WideCommand::Close(_) | WideCommand::CloseRoster(_) => WideIx::Close,
            WideCommand::Finalize(_) => WideIx::Finalize,
            WideCommand::Reveal(_) => WideIx::Reveal,
        }
    }

    pub const fn name(&self) -> &'static str {
        match self {
            WideCommand::Muster(_) => "WideMuster",
            WideCommand::Dissolve(_) => "WideDissolve",
            WideCommand::Resolve(_) => "WideResolve",
            WideCommand::Return(_) => "WideReturn",
            WideCommand::CloseRoster(_) => "WideCloseRoster",
            WideCommand::SettleDeparture(_) => "WideSettleDeparture",
            WideCommand::Gather(_) => "WideGather",
            WideCommand::SettleTransit(_) => "WideSettleTransit",
            _ => self.ix().name(),
        }
    }

    /// The class of the command: every sub-operation shares its tag's.
    pub const fn class(&self) -> crate::tags::Class {
        self.ix().class()
    }

    /// Refuses CPI: the tag's rule, WideResolve and WideGather (the
    /// deployed resolves and gathers are top-level).
    pub const fn top_level_only(&self) -> bool {
        matches!(self, WideCommand::Resolve(_) | WideCommand::Gather(_))
            || self.ix().top_level_only()
    }

    /// A stage of the march after the departure (module doc, "the march
    /// stages" and "the class-W carrier"): the three class-D envelope
    /// operations and the class-W reveal.
    pub const fn march_stage(&self) -> bool {
        matches!(
            self,
            WideCommand::SettleDeparture(_)
                | WideCommand::Gather(_)
                | WideCommand::SettleTransit(_)
                | WideCommand::Reveal(_)
        )
    }

    /// A player command (class P, the player prologue): what the band's act
    /// may run for an NFT resident's Citizen. The act itself is not one.
    pub const fn is_player(&self) -> bool {
        matches!(
            self,
            WideCommand::ClaimSite(_)
                | WideCommand::Depart(_)
                | WideCommand::Muster(_)
                | WideCommand::Dissolve(_)
        )
    }

    /// The account table of the command (WideClose's ticket shape for
    /// `what = 0`; the handler checks [`CLOSE_HOLDING`] for `what = 1`).
    pub const fn accounts(&self) -> &'static [Group] {
        match self {
            WideCommand::Muster(_) => MUSTER,
            WideCommand::Dissolve(_) => DISSOLVE,
            WideCommand::Resolve(_) => RESOLVE,
            WideCommand::Return(_) => RETURN,
            WideCommand::CloseRoster(_) => CLOSE_ROSTER,
            WideCommand::SettleDeparture(_) => SETTLE_DEPARTURE,
            WideCommand::Gather(_) => GATHER,
            WideCommand::SettleTransit(_) => SETTLE_TRANSIT,
            WideCommand::Reveal(_) => REVEAL,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_HOLDING => CLOSE_HOLDING,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_SLOT => CLOSE_SLOT,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_DAY => CLOSE_DAY,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_INPUTS => CLOSE_INPUTS,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_TRANSIT => CLOSE_TRANSIT,
            WideCommand::Close(c) if c.what == CLOSE_WHAT_PROVINCE => CLOSE_PROVINCE,
            _ => accounts_of(self.ix()),
        }
    }
}

/// 0xDD: `generation u32 ‖ inner`, the inner a whole player command of
/// this band ([`WideCommand::is_player`]: WideClaimSite, WideDepart,
/// WideMuster, WideDissolve; the shape of the deployed `ResidentAct`,
/// `resident_wire::Command::Act`).
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

    /// Decodes the head and checks the inner is a whole player command of
    /// the band (`BadData` otherwise: a v2 tag, a non-player tag, a
    /// non-player sub-operation, a malformed inner, the act itself).
    pub fn decode(d: &'a [u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if d.len() <= Self::HEAD || d[0] != Self::IX.tag() {
            return Err(bad);
        }
        let inner = &d[Self::HEAD..];
        if !tag_of(inner)?.act_runs() || !WideCommand::decode(inner)?.is_player() {
            return Err(bad);
        }
        Ok(ResidentAct {
            generation: u32::from_le_bytes([d[1], d[2], d[3], d[4]]),
            inner,
        })
    }

    /// The decoded inner command (a player one, by construction).
    pub fn command(&self) -> Result<WideCommand<'a>, FrontierError> {
        WideCommand::decode(self.inner)
    }
}

/// 0xEE WideReveal: the deployed Reveal's data over the wide plaintext:
/// `transit_slot u8, target_i u8, plain 136, salt 32, ct_hash 32,
/// beneficiary 32` (the keeper submits the plaintext and the salt; the
/// program checks `seal_root(commit(plain, salt), ct_hash)` against the
/// transit record and never decrypts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reveal {
    pub transit_slot: u8,
    pub target_i: u8,
    pub plain: [u8; WIDE_PLAIN_LEN],
    pub salt: [u8; 32],
    pub ct_hash: [u8; 32],
    pub beneficiary: [u8; 32],
}

impl Reveal {
    pub const IX: WideIx = WideIx::Reveal;
    pub const LEN: usize = 1 + 1 + 1 + WIDE_PLAIN_LEN + 32 + 32 + 32;

    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0u8; Self::LEN];
        Writer::new(&mut b)
            .u8(Self::IX.tag())
            .u8(self.transit_slot)
            .u8(self.target_i)
            .bytes(&self.plain)
            .bytes(&self.salt)
            .bytes(&self.ct_hash)
            .bytes(&self.beneficiary);
        b
    }

    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        let mut c = exact(d, Self::IX.tag(), Self::LEN)?;
        Ok(Reveal {
            transit_slot: c.u8().ok_or(bad)?,
            target_i: c.u8().ok_or(bad)?,
            plain: c.arr().ok_or(bad)?,
            salt: c.arr().ok_or(bad)?,
            ct_hash: c.arr().ok_or(bad)?,
            beneficiary: c.arr().ok_or(bad)?,
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
        WideIx::Reveal => Some(Reveal::LEN),
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

/// WideClose(2): the deployed CloseArrivalSlot's `[any s] [season r] [slot
/// w] [rent_to w] ([anchor r])` over a wide ArrivalSlot. The slot names its
/// own destination, bell, faction and index (no data beyond `what`).
pub const CLOSE_SLOT: &[Group] = &[
    one(&[
        s("any", Acc::Wallet, true, Wr::R),
        s("season", Acc::Any, false, Wr::R),
        s("slot", WIDE, false, Wr::W),
        s("rent_to", Acc::Wallet, false, Wr::W),
    ]),
    opt(&[s("anchor", Acc::Any, false, Wr::R)]),
];

/// WideClose(3): the deployed CloseArrivalDay's `[any s] [season r]
/// [province r] [day w] [rent_to w]` over a wide ArrivalDay.
pub const CLOSE_DAY: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("province", WIDE, false, Wr::R),
    s("day", WIDE, false, Wr::W),
    s("rent_to", Acc::Wallet, false, Wr::W),
])];

/// WideClose(4): the deployed CloseClashInputs' `[any s] [season r]
/// [province r] [inputs w] [rent_to w]` over a wide ClashInputs.
pub const CLOSE_INPUTS: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("province", WIDE, false, Wr::R),
    s("inputs", WIDE, false, Wr::W),
    s("rent_to", Acc::Wallet, false, Wr::W),
])];

/// WideClose(5): `[any s] [season r] [transit w] [rent_to w] [holding
/// w]`: a wide transit record left open at season end closes whole to its
/// immutable rent recipient; the holding position is always the canonical
/// address of the host's holding — present there, it counts one open
/// transit fewer; absent there, it closed first and nothing is counted.
pub const CLOSE_TRANSIT: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("transit", WIDE, false, Wr::W),
    s("rent_to", Acc::Wallet, false, Wr::W),
    s("holding", WIDE, false, Wr::W),
])];

/// WideClose(6): the deployed CloseProvince's `[any s] [season r]
/// [province w] [pfund w]` over a wide province: whole into the fund of
/// the wedge that opened it.
pub const CLOSE_PROVINCE: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("province", WIDE, false, Wr::W),
    s("pfund", Acc::Kind(K::ProvinceFund), false, Wr::W),
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
/// `[holding w] [province w] [system] [holding_province r]`, the deployed
/// shape: `province` is the province the host **stands in** (its roster),
/// `holding_province` the issuing holding's own province (the same account
/// when the host never left home). Both wide positions are the handler's
/// to authenticate; a deployed Province in the standing position is the
/// legacy/wide boundary and is refused before any debit.
pub const DEPART: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("system", Acc::System, false, Wr::R),
    s("holding_province", WIDE, false, Wr::R),
    s("transit", WIDE, false, Wr::Either),
    s("transit", WIDE, false, Wr::Either),
    s("transit", WIDE, false, Wr::Either),
    s("transit", WIDE, false, Wr::Either),
    s("roster", WIDE, false, Wr::R),
])];

/// The position of the holding's first wide transit record in [`DEPART`]
/// (the four follow in slot order; exactly the departing slot is writable).
pub const DEPART_TRANSIT0: usize = 8;

/// WideMuster: the deployed player prologue, then the deployed Muster's
/// `[holding w] [province w]` (the holding's own wide province), then
/// `[roster w]` (the province's roster side table, created from the payer
/// at the first muster, its rent recipient the payer) and `[system]`.
pub const MUSTER: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("roster", WIDE, false, Wr::W),
    s("system", Acc::System, false, Wr::R),
])];

/// WideDissolve: the deployed player prologue, then the deployed
/// Dissolve's `[holding w] [province w] [holding_province r]` with the
/// standing province's `[roster r]` before the issuing holding's province,
/// then the holding's four wide transit records (read-only): the deployed
/// `host_in_transit` check (its step 6) over the records that live outside
/// the Holding — a host with an open march cannot dissolve.
pub const DISSOLVE: &[Group] = &[one(&[
    s("actor", Acc::Wallet, true, Wr::R),
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("citizen", Acc::Kind(K::Citizen), false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("province", WIDE, false, Wr::W),
    s("roster", WIDE, false, Wr::R),
    s("holding_province", WIDE, false, Wr::R),
    s("transit", WIDE, false, Wr::R),
    s("transit", WIDE, false, Wr::R),
    s("transit", WIDE, false, Wr::R),
    s("transit", WIDE, false, Wr::R),
])];

/// The position of the holding's first wide transit record in
/// [`DISSOLVE`] (the four follow in slot order).
pub const DISSOLVE_TRANSIT0: usize = 8;

/// WideResolve: the deployed keeper prologue `[fee_payer s,w] [season r]`,
/// `[province w] [roster w]`, the deployed `[seedcache|archive r]
/// [anchor|archive r]` of the province's stored region, and
/// `[clash_inputs r|w]`: the wide ClashInputs position of this province
/// and bell, absent (the bell resolves over the residents alone) or
/// present, fully gathered and writable (the resolve writes the arrivals'
/// fates into it, as the deployed ResolveFromInputs does); then
/// `[arrivalday r]`: the wide ArrivalDay of the bell's day at its
/// canonical address, the **arrival evidence** (a set bit demands the
/// gathered record; the absence of the ClashInputs alone proves nothing),
/// and `[system]` (the roster may be created when an arrival stays in a
/// province that has none yet).
pub const RESOLVE: &[Group] = &[one(&[
    s("fee_payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("province", WIDE, false, Wr::W),
    s("roster", WIDE, false, Wr::W),
    s("seed", Acc::Any, false, Wr::R),
    s("anchor", Acc::Any, false, Wr::R),
    s("clash_inputs", Acc::Any, false, Wr::Either),
    s("arrivalday", Acc::Any, false, Wr::R),
    s("system", Acc::System, false, Wr::R),
])];

/// WideReturn: the deployed return settle's `[payer s] [season] [province
/// w] [holding w]` with the province's `[roster w]` between them; the
/// holding may be absent (its hosts are then stranded, as deployed); then
/// the holding's four wide transit records (read-only: a departed host
/// whose march is still open is **not** returned, its entry waits for the
/// settlement); then the optional `[holding_province r]`: the holding's
/// **own** province, required when the hosts return from a province other
/// than it (the deployed `check_source_province`: the capture lock is read
/// there).
pub const RETURN: &[Group] = &[
    one(&[
        s("payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("province", WIDE, false, Wr::W),
        s("roster", WIDE, false, Wr::W),
        s("holding", WIDE, false, Wr::W),
        s("transit", WIDE, false, Wr::R),
        s("transit", WIDE, false, Wr::R),
        s("transit", WIDE, false, Wr::R),
        s("transit", WIDE, false, Wr::R),
    ]),
    opt(&[s("holding_province", WIDE, false, Wr::R)]),
];

/// The position of the holding's first wide transit record in [`RETURN`].
pub const RETURN_TRANSIT0: usize = 5;

/// WideSettleDeparture: the deployed SettleDeparture's `[payer s] [season
/// r] [origin_province w] [holding w]` with the origin's `[roster w]` and
/// the wide `[transit w]` record (`march::transit_address`).
pub const SETTLE_DEPARTURE: &[Group] = &[one(&[
    s("payer", Acc::Wallet, true, Wr::W),
    s("season", Acc::Kind(K::Season), false, Wr::R),
    s("origin_province", WIDE, false, Wr::W),
    s("holding", WIDE, false, Wr::W),
    s("roster", WIDE, false, Wr::W),
    s("transit", WIDE, false, Wr::W),
])];

/// Positions of a gather or a final set: 6 factions × 4 slots.
pub const GATHER_POSITIONS: u8 = 24;

/// WideGather: the deployed GatherClash's `[fee_payer s,w] [season r]
/// [province r] [anchor|archive r] [inputs w] [arrivalday r] [ix_sysvar r]
/// [system]` over the wide records, then one `[slot r] [transit w]` pair
/// per position of the cursor (`n` pairs; the slot is the wide ArrivalSlot
/// of position `start + j`, absent or present; the transit is the present
/// slot's host's wide transit record at the slot's bound address, any
/// account for an absent slot). The wide ArrivalDay is the arrival
/// evidence, as deployed: its bit clear, the record is complete with no
/// arrivals and no slot is read.
pub const GATHER: &[Group] = &[
    one(&[
        s("fee_payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("province", WIDE, false, Wr::R),
        s("anchor", Acc::Any, false, Wr::R),
        s("inputs", WIDE, false, Wr::W),
        s("arrivalday", Acc::Any, false, Wr::R),
        s("ix_sysvar", Acc::IxSysvar, false, Wr::R),
        s("system", Acc::System, false, Wr::R),
    ]),
    Group {
        specs: &[
            s("slot", Acc::Any, false, Wr::R),
            // Writable when the position's slot is present and its record
            // is stamped (the handler checks); any account, read-only, for
            // an absent slot.
            s("transit", Acc::Any, false, Wr::Either),
        ],
        min: 0,
        max: GATHER_POSITIONS,
    },
];

/// WideReveal (0xEE): the deployed Reveal's shape over the wide records:
/// `[fee_payer s,w] [season r] [holding r] [transit r] [anchor r] [archive
/// r] [beaconlog r] [inputs r] [dest_province r] [arrivalday r|w] [slot × 4
/// (exactly `target_i` writable)] [ix_sysvar r] [system]`, then the path
/// provinces the walk enters other than the destination, in first-entered
/// order (0–3, read-only). The wide ArrivalDay of the arrival bell's day
/// is created from the fee payer when absent and its bell bit set (the
/// deployed `NeedArrivalDay` rule). The transit record replaces the
/// deployed Holding's transit slot; the holding is read for its owner and
/// shield.
pub const REVEAL: &[Group] = &[
    one(&[
        s("fee_payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("holding", WIDE, false, Wr::R),
        s("transit", WIDE, false, Wr::R),
        s("anchor", Acc::Any, false, Wr::R),
        s("archive", Acc::Any, false, Wr::R),
        s("beaconlog", Acc::Any, false, Wr::R),
        s("inputs", Acc::Any, false, Wr::R),
        s("dest_province", WIDE, false, Wr::R),
        s("arrivalday", Acc::Any, false, Wr::Either),
        s("slot", Acc::Any, false, Wr::Either),
        s("slot", Acc::Any, false, Wr::Either),
        s("slot", Acc::Any, false, Wr::Either),
        s("slot", Acc::Any, false, Wr::Either),
        s("ix_sysvar", Acc::IxSysvar, false, Wr::R),
        s("system", Acc::System, false, Wr::R),
    ]),
    Group {
        specs: &[s("path_province", WIDE, false, Wr::R)],
        min: 0,
        max: 3,
    },
];

/// The fixed positions of [`REVEAL`] before the path provinces.
pub const REVEAL_FIXED: usize = 16;
/// The position of the wide ArrivalDay in [`REVEAL`].
pub const REVEAL_DAY: usize = 9;
/// The position of the first of the four slots in [`REVEAL`].
pub const REVEAL_SLOT0: usize = 10;

/// WideSettleTransit: the deployed SettleTransit's shape over the wide
/// records: `[payer s,w] [season r] [holding w] [dest_province w] [inputs
/// w] [slot w] [home_province w] [anchor|archive r] [slot_beneficiary w]
/// [resolver w] [holding_rent_payer w] [settle_beneficiary w] [transit w]
/// [home_roster w] [system] [dest_roster w] [transit_rent_to w]`, then the
/// optional `[citizen w]` (the holding's owner Citizen, mandatory exactly
/// when the host earns the camp's loot, as deployed). The two positions the
/// deployed list lacks: the destination's roster side table (a bad seal's
/// `Forfeit` pairs the entry with its reference) and the transit record's
/// immutable rent recipient (the record closes whole to it).
pub const SETTLE_TRANSIT: &[Group] = &[
    one(&[
        s("payer", Acc::Wallet, true, Wr::W),
        s("season", Acc::Kind(K::Season), false, Wr::R),
        s("holding", WIDE, false, Wr::W),
        s("dest_province", WIDE, false, Wr::W),
        s("inputs", WIDE, false, Wr::W),
        s("slot", WIDE, false, Wr::W),
        s("home_province", WIDE, false, Wr::W),
        s("anchor", Acc::Any, false, Wr::R),
        s("slot_beneficiary", Acc::Wallet, false, Wr::W),
        s("resolver", Acc::Wallet, false, Wr::W),
        s("holding_rent_payer", Acc::Wallet, false, Wr::W),
        s("settle_beneficiary", Acc::Wallet, false, Wr::W),
        s("transit", WIDE, false, Wr::W),
        s("home_roster", WIDE, false, Wr::W),
        s("system", Acc::System, false, Wr::R),
        s("dest_roster", WIDE, false, Wr::W),
        s("transit_rent_to", Acc::Wallet, false, Wr::W),
    ]),
    opt(&[s("citizen", Acc::Kind(K::Citizen), false, Wr::W)]),
];

/// The fixed positions of [`SETTLE_TRANSIT`] before the optional Citizen.
pub const SETTLE_TRANSIT_FIXED: usize = 17;

/// WideCloseRoster: `[any s] [season r] [roster w] [rent_to w] [province
/// r]`: the season-end close of a roster side table, whole to its
/// immutable rent recipient, at the deadline whatever its entries' states
/// (the deployed CloseProvince's rule over the entry table). The province
/// position is the canonical address of the province the table pairs
/// with: present, it must be that province; absent, it closed first.
pub const CLOSE_ROSTER: &[Group] = &[one(&[
    s("any", Acc::Wallet, true, Wr::R),
    s("season", Acc::Any, false, Wr::R),
    s("roster", WIDE, false, Wr::W),
    s("rent_to", Acc::Wallet, false, Wr::W),
    s("province", WIDE, false, Wr::R),
])];

/// The account list of a draft instruction (WideClose's is its ticket
/// shape; the handler checks [`CLOSE_HOLDING`] for `what = 1`). The
/// envelope's commands have their own ([`WideCommand::accounts`]).
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
        WideIx::Reveal => REVEAL,
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
        // the class-W carrier: one free tag outside the band, verified free
        // the same way (the allocation note lists 0xEE–0xEF free)
        assert_eq!(TAG_REVEAL, 0xEE);
        assert!(is_draft_tag(TAG_REVEAL));
        assert!(!(DRAFT_TAG_FIRST..=DRAFT_TAG_LAST).contains(&TAG_REVEAL));
        assert!(crate::v2::Ix::from_tag(TAG_REVEAL).is_none());
        assert!(crate::tags::Ix::from_tag(TAG_REVEAL).is_none());
        assert!(!crate::v2::tags::is_reserved(TAG_REVEAL));
        assert!(!crate::resident_wire::is_resident_tag(TAG_REVEAL));
        assert!(!(0xE8..=0xED).contains(&TAG_REVEAL) && !(0xF0..=0xFD).contains(&TAG_REVEAL));
        assert_eq!(
            crate::v2::ix::tag_of(&[TAG_REVEAL]),
            Err(FrontierError::BadData)
        );
        assert_eq!(WideIx::from_tag(TAG_REVEAL), Some(WideIx::Reveal));
        assert_eq!(WideIx::Reveal.class(), crate::tags::Class::W);
        assert!(WideIx::Reveal.top_level_only());
        assert!(!WideIx::Reveal.act_runs());
        for t in [0xD5u8, 0xC1, 0xE0, 0xE2, 0xEF, 0xFE, 0xFF, 0x00] {
            assert!(!is_draft_tag(t));
            assert_eq!(tag_of(&[t]), Err(FrontierError::BadData));
        }
        assert_eq!(WideIx::ALL.len(), 11);
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
        // nothing is gated at a readiness gate any more: the march stages
        // exist, so the departure writes; the opening writes only under an
        // explicit configuration
        let gated: Vec<WideIx> = WideIx::ALL
            .iter()
            .copied()
            .filter(|i| !i.writes_today())
            .collect();
        assert_eq!(gated, []);
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
            seal: [9; WIDE_SEAL_LEN],
        };
        let b = d.to_bytes();
        assert_eq!(b.len(), 366);
        assert_eq!(
            b.len(),
            crate::ix::Depart::LEN + HOST_REF_LEN - 8 + WIDE_SEAL_LEN - crate::ix::SEAL_LEN,
            "a 56-byte host for a u64, the 264-byte wide seal for the 165-byte one"
        );
        assert_eq!(b[0], 0xDA);
        assert_eq!(Depart::decode(&b), Ok(d));
        assert_eq!(Depart::decode(&b[..365]), Err(FrontierError::BadData));
        assert_eq!(Depart::decode(&b[..267]), Err(FrontierError::BadData));
        // the class-W carrier: the deployed Reveal's data with the wide
        // plaintext (136 for 37)
        let rv = Reveal {
            transit_slot: 1,
            target_i: 2,
            plain: [3; WIDE_PLAIN_LEN],
            salt: [4; 32],
            ct_hash: [5; 32],
            beneficiary: [6; 32],
        };
        let b = rv.to_bytes();
        assert_eq!(b.len(), 235);
        assert_eq!(b.len(), crate::ix::Reveal::LEN + WIDE_PLAIN_LEN - 37);
        assert_eq!(b[0], 0xEE);
        assert_eq!(Reveal::decode(&b), Ok(rv));
        assert_eq!(Reveal::decode(&b[..234]), Err(FrontierError::BadData));
        assert_eq!(WideCommand::decode(&b), Ok(WideCommand::Reveal(rv)));
        let rc = WideCommand::decode(&b).unwrap();
        assert_eq!(rc.class(), crate::tags::Class::W);
        assert!(rc.top_level_only() && rc.march_stage() && !rc.is_player());
        assert_eq!(rc.name(), "WideReveal");
        assert_eq!(bounds_in(rc.accounts()), (16, 19));
        assert_eq!(
            WideCommand::decode(&[0xEE, 0xFF, 1, 1]),
            Err(FrontierError::BadData),
            "no envelope under the carrier"
        );
        assert_eq!(tag_of(&b), Ok(WideIx::Reveal));
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
        for what in 2..=6u8 {
            assert_eq!(Close::decode(&[0xDE, what]), Ok(Close { what }));
        }
        assert_eq!(CLOSE_WHAT_MAX, 6);
        assert_eq!(Close::decode(&[0xDE, 7]), Err(FrontierError::BadData));
        assert_eq!(Close::decode(&[0xDE, 0xFF]), Err(FrontierError::BadData));
        assert_eq!(Close::decode(&[0xDE]), Err(FrontierError::BadData));
        // the season-end closes of the march records: the deployed shapes
        assert_eq!(bounds_in(CLOSE_SLOT), (4, 5));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseArrivalSlot),
            (4, 5)
        );
        assert_eq!(bounds_in(CLOSE_DAY), (5, 5));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseArrivalDay),
            (5, 5)
        );
        assert_eq!(bounds_in(CLOSE_INPUTS), (5, 5));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseClashInputs),
            (5, 5)
        );
        assert_eq!(
            bounds_in(CLOSE_TRANSIT),
            (5, 5),
            "the holding position is fixed: no optional existence"
        );
        assert_eq!(bounds_in(CLOSE_PROVINCE), (4, 4));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::CloseProvince),
            (4, 4)
        );
        assert_eq!(position_in(CLOSE_SLOT, 5, "anchor", 0), Some(4));
        assert_eq!(position_in(CLOSE_DAY, 5, "day", 0), Some(3));
        assert_eq!(position_in(CLOSE_INPUTS, 5, "inputs", 0), Some(3));
        assert_eq!(position_in(CLOSE_TRANSIT, 5, "holding", 0), Some(4));
        assert_eq!(position_in(CLOSE_PROVINCE, 4, "pfund", 0), Some(3));
        assert_eq!(
            CLOSE_PROVINCE[0].specs[3].acc,
            Acc::Kind(K::ProvinceFund),
            "the fund is the deployed kind"
        );
        for (what, table) in [
            (CLOSE_WHAT_SLOT, CLOSE_SLOT),
            (CLOSE_WHAT_DAY, CLOSE_DAY),
            (CLOSE_WHAT_INPUTS, CLOSE_INPUTS),
            (CLOSE_WHAT_TRANSIT, CLOSE_TRANSIT),
            (CLOSE_WHAT_PROVINCE, CLOSE_PROVINCE),
        ] {
            let bytes = [0xDE, what];
            let c = WideCommand::decode(&bytes).unwrap();
            assert_eq!(c, WideCommand::Close(Close { what }));
            assert_eq!(c.accounts().len(), table.len());
            assert_eq!(c.class(), crate::tags::Class::N);
            assert!(!c.is_player() && !c.march_stage());
        }
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
            } else if ix == WideIx::Reveal {
                assert_eq!((lo, hi), (16, 19), "0–3 path provinces, as deployed");
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
        assert_eq!(bounds_in(DEPART), (13, 13));
        assert_eq!(
            crate::v2::prologue::count_bounds(crate::v2::Ix::Depart),
            (8, 8),
            "the wide Depart is the deployed Depart's shape plus the four transit records and the roster"
        );
        assert_eq!(bounds_in(REVEAL), (16, 19));
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::Reveal),
            (15, 18),
            "the wide Reveal is the deployed Reveal's shape plus the transit record"
        );
        assert_eq!(position_in(REVEAL, 16, "transit", 0), Some(3));
        assert_eq!(position_in(REVEAL, 16, "arrivalday", 0), Some(REVEAL_DAY));
        assert_eq!(position_in(REVEAL, 16, "slot", 0), Some(REVEAL_SLOT0));
        assert_eq!(position_in(REVEAL, 16, "slot", 3), Some(REVEAL_SLOT0 + 3));
        assert_eq!(position_in(REVEAL, 16, "ix_sysvar", 0), Some(14));
        assert_eq!(position_in(REVEAL, 16, "system", 0), Some(REVEAL_FIXED - 1));
        assert_eq!(position_in(REVEAL, 19, "path_province", 2), Some(18));
        assert_eq!(REVEAL[0].specs.len(), REVEAL_FIXED);
        assert_eq!(REVEAL[0].specs[14].acc, Acc::IxSysvar);
        assert_eq!(REVEAL[0].specs[REVEAL_DAY].wr, Wr::Either);
        for i in 0..4 {
            assert_eq!(REVEAL[0].specs[REVEAL_SLOT0 + i].wr, Wr::Either);
        }
        assert_eq!(bounds_in(RETURN), (9, 10));
        assert_eq!(bounds_in(DISSOLVE), (12, 12));
        assert_eq!(bounds_in(CLOSE_ROSTER), (5, 5));
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
        assert_eq!(position_in(DEPART, 13, "province", 0), Some(5));
        assert_eq!(position_in(DEPART, 13, "holding_province", 0), Some(7));
        assert_eq!(position_in(DEPART, 13, "transit", 0), Some(DEPART_TRANSIT0));
        assert_eq!(
            position_in(DEPART, 13, "transit", 3),
            Some(DEPART_TRANSIT0 + 3)
        );
        assert_eq!(position_in(DEPART, 13, "roster", 0), Some(12));
        for i in 0..4 {
            assert_eq!(DEPART[0].specs[DEPART_TRANSIT0 + i].wr, Wr::Either);
        }
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
                        | "holding_province"
                        | "transit"
                        | "roster"
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

    /// The envelope: every legacy encoding still decodes at its exact
    /// length and nothing else does; every sub-operation decodes at its
    /// exact length under its tag, escape, version and op, and nothing
    /// else; the class is the tag's; the act's whitelist is by decoded
    /// command; the tables resolve.
    #[test]
    fn envelope_extensions_are_exact_and_class_preserving() {
        use crate::tags::Class;
        // the legacy forms, through the one parser
        let depart = Depart {
            host: [0x11; HOST_REF_LEN],
            transit_slot: 2,
            arrive_bell: 777,
            tip: 14_441,
            commit: [7; 32],
            seal: [9; WIDE_SEAL_LEN],
        };
        assert_eq!(
            WideCommand::decode(&depart.to_bytes()),
            Ok(WideCommand::Depart(depart))
        );
        assert_eq!(depart.to_bytes()[1], 0x11, "a host reference version byte");
        assert_eq!(
            WideCommand::decode(&[0xDC, 0]),
            Ok(WideCommand::SettleTicket(SettleTicket { k: 0 }))
        );
        assert_eq!(
            WideCommand::decode(&[0xDC, 0xFF]),
            Ok(WideCommand::SettleTicket(SettleTicket { k: 0xFF })),
            "the legacy length is the legacy form, whatever the byte"
        );
        assert_eq!(
            WideCommand::decode(&[0xDE, 1]),
            Ok(WideCommand::Close(Close { what: 1 }))
        );
        assert_eq!(
            WideCommand::decode(&[0xDE, 2]),
            Ok(WideCommand::Close(Close { what: 2 }))
        );
        assert_eq!(
            WideCommand::decode(&[0xDE, 6]),
            Ok(WideCommand::Close(Close { what: 6 }))
        );
        assert_eq!(WideCommand::decode(&[0xDE, 7]), Err(FrontierError::BadData));
        assert_eq!(
            WideCommand::decode(&[0xDE, 0xFF]),
            Err(FrontierError::BadData)
        );
        assert_eq!(
            WideCommand::decode(&[0xDF]),
            Ok(WideCommand::Finalize(Finalize))
        );
        assert_eq!(
            WideCommand::decode(&[0xDF, 0xFF, 1, 1]),
            Err(FrontierError::BadData)
        );
        assert_eq!(
            WideCommand::decode(&[0xC1, 0xFF, 1, 1]),
            Err(FrontierError::BadData)
        );
        // the sub-operations
        let m = Muster {
            unit: 3,
            troops: 1_200,
            tile: 17,
        };
        let b = m.to_bytes();
        assert_eq!(b.len(), 10);
        assert_eq!(&b[..4], &[0xDA, 0xFF, 1, 1]);
        assert_eq!(Muster::decode(&b), Ok(m));
        assert_eq!(WideCommand::decode(&b), Ok(WideCommand::Muster(m)));
        assert_eq!(Depart::decode(&b), Err(FrontierError::BadData));
        let d = Dissolve {
            host: [0x22; HOST_REF_LEN],
        };
        let b = d.to_bytes();
        assert_eq!(b.len(), 60);
        assert_eq!(&b[..4], &[0xDA, 0xFF, 1, 2]);
        assert_eq!(WideCommand::decode(&b), Ok(WideCommand::Dissolve(d)));
        let r = Resolve {
            bell: 9,
            beneficiary: [0x33; 32],
        };
        let b = r.to_bytes();
        assert_eq!(b.len(), 40);
        assert_eq!(&b[..4], &[0xDC, 0xFF, 1, 1]);
        assert_eq!(WideCommand::decode(&b), Ok(WideCommand::Resolve(r)));
        assert_eq!(Return.to_bytes(), [0xDC, 0xFF, 1, 2]);
        assert_eq!(
            WideCommand::decode(&[0xDC, 0xFF, 1, 2]),
            Ok(WideCommand::Return(Return))
        );
        assert_eq!(CloseRoster.to_bytes(), [0xDE, 0xFF, 1, 1]);
        assert_eq!(
            WideCommand::decode(&[0xDE, 0xFF, 1, 1]),
            Ok(WideCommand::CloseRoster(CloseRoster))
        );
        // nothing malformed decodes: a wrong length, escape, version, op, or
        // an op under another tag
        for bad in [
            &[0xDA, 0xFF, 1, 1, 0, 0, 0, 0, 0][..],
            &[0xDA, 0xFF, 1, 1, 0, 0, 0, 0, 0, 0, 0],
            &[0xDA, 0xFE, 1, 1, 0, 0, 0, 0, 0, 0],
            &[0xDA, 0xFF, 2, 1, 0, 0, 0, 0, 0, 0],
            &[0xDA, 0xFF, 1, 3, 0, 0, 0, 0, 0, 0],
            &[0xDA, 0xFF, 1, 0, 0, 0, 0, 0, 0, 0],
            &[0xDC, 0xFF, 1, 3],
            &[0xDC, 0xFF, 1, 2, 0],
            &[0xDC, 0xFF, 1],
            &[0xDE, 0xFF, 1, 2],
            &[0xDE, 0xFF, 1, 1, 0],
            &[0xDE, 0xFF, 0, 1],
            &[0xD9, 0xFF, 1, 1],
            &[0xDB, 0xFF, 1, 1],
        ] {
            assert_eq!(
                WideCommand::decode(bad),
                Err(FrontierError::BadData),
                "{bad:?}"
            );
        }
        // class, top level, names, tables (the decoded commands borrow their
        // bytes: bound first)
        let (mb, db, rb, retb, crb) = (
            m.to_bytes(),
            d.to_bytes(),
            r.to_bytes(),
            Return.to_bytes(),
            CloseRoster.to_bytes(),
        );
        let m = WideCommand::decode(&mb).unwrap();
        let d = WideCommand::decode(&db).unwrap();
        let r = WideCommand::decode(&rb).unwrap();
        let ret = WideCommand::decode(&retb).unwrap();
        let cr = WideCommand::decode(&crb).unwrap();
        assert_eq!((m.class(), d.class()), (Class::P, Class::P));
        assert_eq!((r.class(), ret.class()), (Class::D, Class::D));
        assert_eq!(cr.class(), Class::N);
        assert!(r.top_level_only(), "the resolve is top-level, as deployed");
        assert!(!ret.top_level_only() && !m.top_level_only() && !cr.top_level_only());
        assert!(m.is_player() && d.is_player());
        assert!(!r.is_player() && !ret.is_player() && !cr.is_player());
        let dep = depart.to_bytes();
        assert!(WideCommand::decode(&dep).unwrap().is_player());
        assert_eq!(m.name(), "WideMuster");
        assert_eq!(cr.name(), "WideCloseRoster");
        assert_eq!(WideCommand::decode(&[0xDF]).unwrap().name(), "WideFinalize");
        assert_eq!(bounds_in(m.accounts()), (8, 8));
        assert_eq!(bounds_in(d.accounts()), (12, 12));
        assert_eq!(bounds_in(r.accounts()), (9, 9));
        assert_eq!(bounds_in(ret.accounts()), (9, 10));
        assert_eq!(bounds_in(cr.accounts()), (5, 5));
        assert_eq!(
            crate::v2::prologue::count_bounds(crate::v2::Ix::Muster),
            (6, 6),
            "the wide Muster is the deployed shape plus the roster and System"
        );
        assert_eq!(
            crate::v2::prologue::count_bounds(crate::v2::Ix::Dissolve),
            (7, 7),
            "the wide Dissolve is the deployed shape plus the roster and the four transit records"
        );
        assert_eq!(position_in(MUSTER, 8, "roster", 0), Some(6));
        assert_eq!(position_in(DISSOLVE, 12, "holding_province", 0), Some(7));
        assert_eq!(
            position_in(DISSOLVE, 12, "transit", 0),
            Some(DISSOLVE_TRANSIT0)
        );
        assert_eq!(
            position_in(DISSOLVE, 12, "transit", 3),
            Some(DISSOLVE_TRANSIT0 + 3)
        );
        assert_eq!(position_in(RESOLVE, 9, "clash_inputs", 0), Some(6));
        assert_eq!(position_in(RESOLVE, 9, "arrivalday", 0), Some(7));
        assert_eq!(position_in(RESOLVE, 9, "system", 0), Some(8));
        assert_eq!(RESOLVE[0].specs[6].wr, Wr::Either);
        assert_eq!(position_in(RETURN, 9, "holding", 0), Some(4));
        assert_eq!(position_in(RETURN, 9, "transit", 0), Some(RETURN_TRANSIT0));
        assert_eq!(
            position_in(RETURN, 9, "transit", 3),
            Some(RETURN_TRANSIT0 + 3)
        );
        assert_eq!(position_in(RETURN, 10, "holding_province", 0), Some(9));
        assert_eq!(position_in(CLOSE_ROSTER, 5, "rent_to", 0), Some(3));
        assert_eq!(position_in(CLOSE_ROSTER, 5, "province", 0), Some(4));
        for g in [MUSTER, DISSOLVE] {
            for (sp, want) in g[0].specs.iter().zip(PLAYER_PROLOGUE) {
                assert_eq!(
                    (sp.name, sp.signer, sp.wr),
                    (want.name, want.signer, want.wr)
                );
            }
        }
        assert!(RESOLVE[0].specs[0].signer && RESOLVE[0].specs[0].wr == Wr::W);
        assert_eq!(
            WideCommand::decode(&[0xDE, 1]).unwrap().accounts().len(),
            CLOSE_HOLDING.len()
        );
        // the act runs the decoded player commands only
        let inner = Muster {
            unit: 0,
            troops: 300,
            tile: 5,
        }
        .to_bytes();
        let mut buf = [0u8; 80];
        let n = ResidentAct {
            generation: 2,
            inner: &inner,
        }
        .encode_into(&mut buf)
        .unwrap();
        let act = ResidentAct::decode(&buf[..n]).unwrap();
        let want = Muster::decode(&inner).unwrap();
        assert_eq!(act.command(), Ok(WideCommand::Muster(want)));
        assert!(matches!(
            WideCommand::decode(&buf[..n]),
            Ok(WideCommand::ResidentAct(_))
        ));
        for not_player in [Resolve::LEN, Return::LEN] {
            let inner: Vec<u8> = if not_player == Resolve::LEN {
                Resolve {
                    bell: 1,
                    beneficiary: [0; 32],
                }
                .to_bytes()
                .to_vec()
            } else {
                Return.to_bytes().to_vec()
            };
            let n = ResidentAct {
                generation: 2,
                inner: &inner,
            }
            .encode_into(&mut buf)
            .unwrap();
            assert_eq!(ResidentAct::decode(&buf[..n]), Err(FrontierError::BadData));
        }
        let inner = CloseRoster.to_bytes();
        let n = ResidentAct {
            generation: 2,
            inner: &inner,
        }
        .encode_into(&mut buf)
        .unwrap();
        assert_eq!(ResidentAct::decode(&buf[..n]), Err(FrontierError::BadData));
        // a malformed inner of a player tag is refused too
        let n = ResidentAct {
            generation: 2,
            inner: &[0xDA, 0xFF, 1, 1, 0],
        }
        .encode_into(&mut buf)
        .unwrap();
        assert_eq!(ResidentAct::decode(&buf[..n]), Err(FrontierError::BadData));
    }

    /// The march stages: exact encodings under the class-D settle tag,
    /// distinct ops and lengths, top-level where the deployed stage is,
    /// never a player command, their tables named.
    #[test]
    fn march_stage_envelopes_preserve_class_and_collide_with_nothing() {
        use crate::tags::Class;
        let sd = SettleDeparture {
            host: [0x11; HOST_REF_LEN],
            transit_slot: 2,
        };
        let g = Gather {
            bell: 40,
            start: 0,
            n: 24,
        };
        let st = SettleTransit {
            transit_slot: 2,
            commit: [7; 32],
            seal: [0x80; WIDE_SEAL_LEN],
            beneficiary: [9; 32],
        };
        let (sdb, gb, stb) = (sd.to_bytes(), g.to_bytes(), st.to_bytes());
        assert_eq!((sdb.len(), gb.len(), stb.len()), (61, 10, 333));
        assert_eq!(&sdb[..4], &[0xDC, 0xFF, 1, 3]);
        assert_eq!(&gb[..4], &[0xDC, 0xFF, 1, 4]);
        assert_eq!(&stb[..4], &[0xDC, 0xFF, 1, 5]);
        assert_eq!(
            WideCommand::decode(&sdb),
            Ok(WideCommand::SettleDeparture(sd))
        );
        assert_eq!(WideCommand::decode(&gb), Ok(WideCommand::Gather(g)));
        assert_eq!(
            WideCommand::decode(&stb),
            Ok(WideCommand::SettleTransit(st))
        );
        // no length of this tag is shared by two commands
        let lens = [
            SettleTicket::LEN,
            Resolve::LEN,
            Return::LEN,
            SettleDeparture::LEN,
            Gather::LEN,
            SettleTransit::LEN,
        ];
        for (i, a) in lens.iter().enumerate() {
            for b in &lens[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_ne!(SettleTransit::LEN, Depart::LEN, "the legacy-shaped Depart");
        // a wrong op, length or tag refuses
        assert_eq!(WideCommand::decode(&sdb[..60]), Err(FrontierError::BadData));
        let mut x = gb;
        x[3] = 6;
        assert_eq!(WideCommand::decode(&x), Err(FrontierError::BadData));
        let mut x = stb;
        x[0] = 0xDA;
        assert_eq!(WideCommand::decode(&x), Err(FrontierError::BadData));
        // class D, the gather top-level, none a player command
        let (sdc, gc, stc) = (
            WideCommand::decode(&sdb).unwrap(),
            WideCommand::decode(&gb).unwrap(),
            WideCommand::decode(&stb).unwrap(),
        );
        for c in [sdc, gc, stc] {
            assert_eq!(c.class(), Class::D);
            assert!(!c.is_player());
            assert!(c.march_stage());
            assert_eq!(c.ix(), WideIx::SettleTicket);
        }
        assert!(gc.top_level_only());
        assert!(!sdc.top_level_only() && !stc.top_level_only());
        assert!(!WideCommand::decode(&Return.to_bytes())
            .unwrap()
            .march_stage());
        assert_eq!(sdc.name(), "WideSettleDeparture");
        assert_eq!(gc.name(), "WideGather");
        assert_eq!(stc.name(), "WideSettleTransit");
        assert_eq!(bounds_in(sdc.accounts()), (6, 6));
        assert_eq!(
            bounds_in(gc.accounts()),
            (8, 8 + 2 * GATHER_POSITIONS as usize),
            "a slot and a transit per position of the cursor"
        );
        assert_eq!(
            bounds_in(stc.accounts()),
            (SETTLE_TRANSIT_FIXED, SETTLE_TRANSIT_FIXED + 1),
            "the owner Citizen for the camp's loot is optional"
        );
        assert_eq!(position_in(SETTLE_DEPARTURE, 6, "transit", 0), Some(5));
        assert_eq!(position_in(GATHER, 8, "inputs", 0), Some(4));
        assert_eq!(position_in(GATHER, 8, "arrivalday", 0), Some(5));
        assert_eq!(position_in(GATHER, 8, "ix_sysvar", 0), Some(6));
        assert_eq!(position_in(GATHER, 12, "slot", 1), Some(10));
        assert_eq!(position_in(GATHER, 12, "transit", 1), Some(11));
        assert_eq!(GATHER[1].specs.len(), 2);
        assert_eq!(
            GATHER[1].specs[1].wr,
            Wr::Either,
            "an absent slot's transit position is any read-only account"
        );
        assert_eq!(position_in(SETTLE_TRANSIT, 17, "home_roster", 0), Some(13));
        assert_eq!(position_in(SETTLE_TRANSIT, 17, "dest_roster", 0), Some(15));
        assert_eq!(
            position_in(SETTLE_TRANSIT, 17, "transit_rent_to", 0),
            Some(16)
        );
        assert_eq!(position_in(SETTLE_TRANSIT, 18, "citizen", 0), Some(17));
        assert_eq!(SETTLE_TRANSIT[0].specs.len(), SETTLE_TRANSIT_FIXED);
        assert_eq!(SETTLE_TRANSIT[1].specs[0].acc, Acc::Kind(K::Citizen));
        // the deployed shapes these mirror
        assert_eq!(
            crate::prologue::count_bounds(crate::tags::Ix::SettleTransit).0,
            13,
            "the wide settle adds the transit record and the home roster"
        );
        // the act never runs a march stage
        let mut buf = [0u8; 400];
        for inner in [&sdb[..], &gb[..], &stb[..]] {
            let n = ResidentAct {
                generation: 1,
                inner,
            }
            .encode_into(&mut buf)
            .unwrap();
            assert_eq!(ResidentAct::decode(&buf[..n]), Err(FrontierError::BadData));
        }
    }
}
