//! The adapters: the canonical side and execution path (workstream ③) and
//! the rights check (workstream ②). The executor sees nothing else.
//!
//! **Contract status.** Neither ② nor ③ has delivered a contract to this
//! workstream. These traits are this workstream's *proposal*
//! (`docs/CONTRACTS.ja.md`), implemented here only by the simulated world
//! (`sim`, marked MOCK). What the current chain already provides is noted
//! per method; nothing here fixes ②'s or ③'s design.

use serde::{Deserialize, Serialize};

use crate::model::{CaravanKey, FacilityRef, PlaceRef, Res};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PortError {
    /// The read or send could not be made (RPC down, timeout).
    Unavailable(String),
}

pub type PortResult<T> = Result<T, PortError>;

/// A canonical read of a place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceView {
    pub live: bool,
    pub gen: u8,
    /// `citizen_tag` of the owner.
    pub owner: u64,
    pub stores: Res,
    /// Capacity per resource (vaults), `None` for none.
    pub cap: Option<u64>,
}

/// A canonical read of a caravan account (`cv` ‖ owner_tag ‖ seq). Closed at
/// settlement: absence after a landed send means settled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaravanView {
    /// The current owner's tag (a take makes it the raider's; the seed
    /// keeps the original `owner_tag`).
    pub owner_now: u64,
    pub src: PlaceRef,
    pub dst: PlaceRef,
    pub cargo: Res,
    pub arrive_slot: u64,
    pub raid_open: bool,
}

/// The canonical record of one facility use, found by its request key
/// (proposal to ③: today's chain has no facility instruction).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FacilityUse {
    pub key: String,
    pub sig: String,
    pub slot: u64,
    pub consumed: Res,
    pub produced: Res,
    pub rights_units: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settle {
    pub key: CaravanKey,
    /// `frontier_abi::v2::log::caravan_outcome`.
    pub outcome: u8,
    pub dst: PlaceRef,
    /// The caravan's cargo as logged.
    pub cargo: Res,
    /// What the destination actually kept (proposal: today's log has no
    /// such field; a vault at `CAP` silently drops the excess).
    pub credited: Option<Res>,
    pub slot: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raid {
    pub key: CaravanKey,
    /// `frontier_abi::v2::log::raid_choice` TAKE / BURN.
    pub choice: u8,
    pub raider: u64,
    pub taken: Res,
    pub slot: u64,
}

/// A feed record (the keeper's CqEvent, narrowed to what runs need).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    FacilityUsed(FacilityUse),
    CaravanSent {
        key: CaravanKey,
        sig: String,
        src: PlaceRef,
        dst: PlaceRef,
        cargo: Res,
        arrive_slot: u64,
    },
    CaravanSettled(Settle),
    CaravanRaided(Raid),
    /// A seizure: the place's generation moved.
    PlaceSeized {
        place: PlaceRef,
        new_gen: u8,
        slot: u64,
    },
}

impl Event {
    pub fn kind(&self) -> &'static str {
        match self {
            Event::FacilityUsed(_) => "facility_used",
            Event::CaravanSent { .. } => "caravan_sent",
            Event::CaravanSettled(_) => "caravan_settled",
            Event::CaravanRaided(_) => "caravan_raided",
            Event::PlaceSeized { .. } => "place_seized",
        }
    }
    /// The caravan this record is about.
    pub fn caravan(&self) -> Option<CaravanKey> {
        match self {
            Event::CaravanSent { key, .. } => Some(*key),
            Event::CaravanSettled(s) => Some(s.key),
            Event::CaravanRaided(r) => Some(r.key),
            _ => None,
        }
    }
}

/// One record with its identity: `id` is unique per record (signature ‖
/// instruction ‖ log index on the chain); `pos` orders the feed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRec {
    pub id: String,
    pub pos: u64,
    pub event: Event,
}

#[derive(Clone, Debug, Default)]
pub struct EventPage {
    pub events: Vec<EventRec>,
    /// The feed no longer holds records after the cursor asked for: some
    /// history is missing and every open run must be reconciled.
    pub gap: bool,
    /// The cursor to ask from next.
    pub next: u64,
}

/// A request a run sends. Only these two shapes exist: the executor cannot
/// express a march, a raid or a seizure (`policy`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Request {
    UseFacility {
        key: String,
        holder: u64,
        facility: FacilityRef,
        stock: PlaceRef,
        inputs: Res,
        outputs: Res,
        rights_units: u64,
    },
    /// 0xB1 SendCaravan: `seq` must equal `Citizen.CARAVANS` or the program
    /// refuses the send (`proc/caravan.rs`), so the pair (owner, seq) is the
    /// request's identity on today's chain.
    SendCaravan {
        owner: u64,
        seq: u32,
        src: PlaceRef,
        dst: PlaceRef,
        cargo: Res,
    },
}

impl Request {
    pub fn key(&self) -> String {
        match self {
            Request::UseFacility { key, .. } => key.clone(),
            Request::SendCaravan { owner, seq, .. } => CaravanKey {
                owner: *owner,
                seq: *seq,
            }
            .text(),
        }
    }
}

/// A signed request: its signature is fixed before it is sent, so the
/// journal can record it first and a re-broadcast of the same bytes can
/// never take effect twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prepared {
    pub sig: String,
    pub request: Request,
    /// The signed wire bytes. Journalled before the send, so a restart
    /// re-broadcasts exactly these (same signature) and never re-signs.
    pub wire: Vec<u8>,
    /// The last slot the request may land in (blockhash validity).
    pub valid_until: u64,
    /// Worst-case fee if it lands.
    pub fee: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Reject {
    /// The request key was already used (facility) — confirm by lookup.
    AlreadyDone,
    /// SendCaravan's seq is not `Citizen.CARAVANS` (today: `BadData`) —
    /// ours landed earlier, or another send took the seq.
    SeqMismatch,
    Insufficient,
    RightsExpired,
    RightsInsufficient,
    DestinationChanged,
    FacilityGone,
    WalletRequired,
    /// The blockhash is no longer valid: it can never land.
    Expired,
    Other(String),
    /// Refused before anything was signed (an agent gateway's policy,
    /// stop or limit refusal): no bytes exist, so it can never land.
    Refused(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendResult {
    Accepted,
    /// Refused before landing (preflight): it did not and will not land.
    Rejected(Reject),
    /// No usable answer: it may or may not land.
    Unknown(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SigStatus {
    /// Landed and took effect; `fee` as the transaction's meta reports it
    /// (`None`: not known).
    Landed { slot: u64, fee: Option<u64> },
    /// Landed and failed (fee charged, no effect).
    Failed {
        slot: u64,
        fee: Option<u64>,
        reject: Reject,
    },
    /// Not seen yet and still within its validity.
    Pending,
    /// It did not land and never will. Only when the history searched
    /// covers the whole window the signature could land in (its
    /// blockhash's slot to `valid_until`), is known to have no gap there,
    /// and is finalized past `valid_until` (`docs/HANDOFF.ja.md` §3). An
    /// adapter that cannot guarantee all three answers `Unavailable`:
    /// absence from a pruned cache or a failed query proves nothing — not
    /// a failure, not an unbilled attempt, not leave to re-sign.
    Absent,
    /// The status history is not available (pruned, RPC without history).
    Unavailable,
}

/// The canonical side and the execution path (③).
pub trait Chain {
    fn slot(&self) -> PortResult<u64>;
    fn place(&self, p: &PlaceRef) -> PortResult<Option<PlaceView>>;
    /// `Citizen.CARAVANS` of the owner: the next caravan's seq.
    fn caravan_seq(&self, owner: u64) -> PortResult<u32>;
    fn caravan(&self, key: CaravanKey) -> PortResult<Option<CaravanView>>;
    /// The canonical record of a facility request key.
    fn facility_use(&self, key: &str) -> PortResult<Option<FacilityUse>>;
    /// The entity history of a caravan (findex's per-entity index);
    /// `Ok(None)`: not available.
    fn caravan_history(&self, key: CaravanKey) -> PortResult<Option<Vec<EventRec>>>;
    fn events(&self, after: u64, limit: usize) -> PortResult<EventPage>;
    /// Signs a request (attempt `n` gets its own blockhash and signature).
    fn prepare(&self, req: &Request, n: u32) -> PortResult<Prepared>;
    fn send(&self, p: &Prepared) -> SendResult;
    fn status(&self, sig: &str, valid_until: u64) -> PortResult<SigStatus>;
    /// The chain signature an attempt's handle stands for. A port that signs
    /// before sending returns the handle itself; a port that sends through a
    /// gateway which signs (the agent wallet) returns the signature the
    /// gateway reported, once known (`None`: not known yet).
    fn chain_sig(&self, handle: &str) -> Option<String> {
        Some(handle.to_string())
    }
}

/// The rights check (②): the right's remaining units at the moment of the
/// read. Advisory; the facility use re-checks atomically.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RightsVerdict {
    Allowed {
        remaining: u64,
        expires_slot: u64,
    },
    Expired,
    Insufficient {
        remaining: u64,
    },
    /// No right (revoked or never granted).
    None,
}

pub trait Rights {
    fn check(&self, holder: u64, facility: &FacilityRef, units: u64) -> PortResult<RightsVerdict>;
}
