//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **versioned wide event record** and its chain commitment — what the
//! experimental wide handlers log and how the wide accounts' event chains
//! advance. It is a format of its own, not an extension of the deployed
//! PS2 log: a wide record is logged under the prefix [`WIDE_LOG_PREFIX`]
//! (`PSW1`, never `PS2`), its body starts with the version byte
//! [`WIDE_EVENT_VERSION`] (0x82, which the deployed decoders refuse as an
//! unknown version), its kinds are this module's ([`WideKind`], no code of
//! the deployed or any other team's kind space is taken), every key is a
//! **full identity** (the 56-byte host reference or the 50-byte province
//! key, never a `u64` host id or a dense pair), and its chain rule is
//! domain-separated ([`next_head`]). A reader that knows only the deployed
//! format sees nothing it can parse — the wide world stays **unknown /
//! unverifiable** to it, never misread — and a reader of this format can
//! recompute one wide account's `(event_seq, event_head)` from the records
//! that concern **that account** ([`verify_chain`] over a [`WideTarget`]).
//!
//! Body: `version u8 ‖ kind u8 ‖ bell u32 ‖ key ‖ payload ‖ n_links u8 ‖
//! (entity u8 ‖ seq u64 ‖ head [32])*`, every width fixed by the kind
//! ([`WideKind::key_len`], [`WideKind::payload_len`]), the tail **exactly**
//! the kind's link set ([`WideKind::links`]: a missing or an extra link
//! refuses), in ascending entity order. The chain of an entity advances by
//! `seq' = seq + 1`, `head' = sha256(WIDE_CHAIN_DOMAIN ‖ entity ‖ LE64(seq')
//! ‖ head ‖ body_without_tail)`.
//!
//! | kind | key | payload | links |
//! |---|---|---|---|
//! | 1 `Muster` | host ref ‖ standing province key | `unit u8, troops u32 (whole), tile u8, entry u8, alias u64` | Province, Holding |
//! | 2 `Dissolve` | host ref ‖ standing | `pend_bell u32, troops u32 (milli), entry u8` | Province, Holding |
//! | 3 `Resolve` | province key | `input_digest [32], output_digest [32], engagements u32, destroyed u8, bounced u8, settled u8` | Province |
//! | 4 `Return` | host ref ‖ standing | `credited u32 (milli, once), unit u8, entry u8` | Province, Holding |
//! | 5 `Stranded` | host ref ‖ standing | `troops_lost u32 (milli), entry u8` | Province |
//! | 6 `RosterClosed` | province key | `rent_to [32], lamports u64` | none |
//! | 7 `Departed` | host ref ‖ origin (standing) | `transit_slot u8, depart_bell u32, arrive_bell u32, dep_mass u32 (milli), march_stamina u16, tip u64, fee u64, bond u64, seal_root [32]` | Province, Holding |
//! | 8 `TransitSettled` | host ref ‖ destination (the home when the destination is absent) | `transit_slot u8, outcome u8, seal_code u8, troops u32 (milli), tip u64, fee u64, bond u64, home_credited u8, sealed_dest [50]` | Province, Holding |
//! | 9 `DepartureSettled` | host ref ‖ origin | `transit_slot u8, destroyed u8, troops_after u32 (milli), stamina_after u16, ready_bell_off u16, entry u8` | Province, Holding |
//! | 10 `Revealed` | host ref ‖ destination | `transit_slot u8, faction u8, i u8, tile u8, stance u8, retreat_bps u16, dep_mass u32 (milli), displaced u8` | none |
//! | 11 `Gathered` | province key (destination) | `bell u32, start u8, n u8, arrivals_mask u32, n_present u8, no_arrivals u8` | none |
//! | 12 `RecordClosed` | province key (the destination) | `what u8 (2 slot, 3 day, 4 inputs), bell u32, faction u8, i u8, rent_to [32], lamports u64` | none |
//! | 13 `TransitClosed` | host ref ‖ home | `transit_slot u8, rent_to [32], lamports u64` | none |
//! | 14 `ProvinceClosed` | province key | `fund [32], lamports u64` | Province |
//!
//! `RecordClosed` and `TransitClosed` chain nothing: the account closed had
//! no chain and is gone (as `RosterClosed`); a transit close may count one
//! open march fewer on its holding, a counter the holding's chain does not
//! cover. A `ProvinceClosed` is the **terminal record of the province's
//! chain**: the province has a chain (every Muster, Dissolve, Resolve,
//! Return, Stranded, Departed, settle of it advanced the header), and the
//! close writes this record on that header — its link is the final
//! `(seq, head)` — **before** the account is erased, as the deployed
//! `CLOSE` record carries the final chain. A verifier replays the
//! province's chain to this record and no further.
//!
//! A `Revealed` and a `Gathered` chain nothing: the reveal writes an
//! ArrivalSlot and the gather a ClashInputs, records without an event chain
//! (as deployed), and neither writes a province or a holding. A
//! `TransitSettled` is attributed to the destination it was judged
//! against; when a valid seal names a province that was never opened
//! (nothing could be revealed or gathered there), the settlement is
//! attributed to the host's **home** province, where its only effect (the
//! return) lands — and the payload keeps the **sealed destination key**
//! in every case, so the fact of where the march was sealed to is never
//! replaced by the chain target ([`WideRecord::sealed_dest`]). A host that comes
//! home after a settlement is logged by a `Return` keyed by the home
//! province (entry `0xFF` when the troops went into the reserve instead of
//! a muster-pending entry).
//!
//! **Attribution.** A record concerns exactly one province and at most one
//! holding, derived from its full key and never from the packed alias.
//! Every host-keyed record names, beside the 56-byte host reference, the
//! **50-byte key of the province it happened in** (the standing province;
//! for a departure the origin, for a transit settlement the destination):
//! that key, and only that key, is the record's province
//! ([`WideRecord::province_of`]). The host's home province
//! ([`WideRecord::home_of`], `WideHostRef::key`) is a separate fact and is
//! **never** substituted for the standing province: a host event in a
//! province other than its home is attributed where it happened. The
//! record's holding is the host's issuing holding
//! (`WideHostRef::holding_ref`: site and generation, sequence 0), wherever
//! the event happened; a province-keyed record's province is its key and
//! it has no holding. [`verify_chain`] consumes a record only when its
//! attribution is the target: a record of another province or holding,
//! even with a plausible link, is skipped, and a record attributed to the
//! target must carry the target's link.
//!
//! Kinds 7 and 8 are the shape of the march's origin and destination
//! records (the departure's escrow and seal root; the settlement's
//! outcome, seal verdict and payments). The Departed record is the only
//! one a wide Depart logs; the wide march's debit stays refused until its
//! whole settlement path exists (`WIDE-LAND-WRITER.md` §−2.4e).
//!
//! **Versions.** Version 0x82 is the format above: every host-keyed record
//! carries the 106-byte `host ref ‖ standing province key`. Version 0x81
//! was the format of the local-only lifecycle, whose host records carried
//! the 56-byte host reference alone and were attributed to the host's
//! home; its widths differ, so [`WideRecord::decode`] refuses it
//! **explicitly** ([`EventError::RetiredVersion`]), never reinterprets it.
//! A trace saved under 0x81 (the experimental host tests before this
//! change) needs the 0x81 decoder of that revision; no 0x81 record exists
//! on any chain.
//!
//! **The resolve's digests.** [`resolve_input_digest`] commits to the
//! province key, the bell, the bell seed, the **authenticated Season bytes
//! whole** (the status, the ruleset hash, the program version with the
//! wide bit, the clock the seed round comes from, the conquest block the
//! step parameters come from), the province and roster bytes as read and
//! the gathered ClashInputs bytes as read (empty when the bell had none);
//! [`resolve_output_digest`] to the kernel outcome's own digest and the
//! province, roster and ClashInputs bytes the bell left. Both province digests are over
//! the bytes **normalized** by [`normalize_chained`]: the header's
//! `event_seq` and `event_head` zeroed, so the comparison is independent
//! of the record's own link (the chain is committed by the link, not the
//! digest). A verifier replaying the bell hashes the account bytes it
//! read, normalized, and the bytes the model left plus the resolve
//! summary, normalized, before any record of its own.

use super::key::{ProvinceKey, WideHostRef, HOST_REF_LEN, PROVINCE_KEY_LEN};
use crate::bytes::{Cursor, Writer};
use crate::layout::header;
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

/// The `sol_log_data` prefix of a wide record. Distinct from the deployed
/// `PS2`.
pub const WIDE_LOG_PREFIX: &[u8; 4] = b"PSW1";
/// The body's version byte. The high bit keeps it out of every deployed
/// version (the deployed decoders refuse it as `Version(0x82)`).
pub const WIDE_EVENT_VERSION: u8 = 0x82;
/// The retired version of the local-only lifecycle (56-byte host keys,
/// home attribution). Refused explicitly by [`WideRecord::decode`]
/// (module doc, versions); never written again.
pub const WIDE_EVENT_VERSION_RETIRED: u8 = 0x81;
/// Domain of [`next_head`].
pub const WIDE_CHAIN_DOMAIN: &[u8] = b"PSF-WIDE-CHAIN-v1";
/// Domain of [`resolve_input_digest`].
pub const RESOLVE_INPUT_DOMAIN: &[u8] = b"PSF-WIDE-RESOLVE-INPUT-v3";
/// Domain of [`resolve_output_digest`].
pub const RESOLVE_OUTPUT_DOMAIN: &[u8] = b"PSF-WIDE-RESOLVE-OUTPUT-v3";
/// `version ‖ kind ‖ bell`.
pub const HEAD_LEN: usize = 6;
/// `entity ‖ seq ‖ head`.
pub const LINK_LEN: usize = 1 + 8 + 32;
/// Entities one record may chain.
pub const MAX_LINKS: usize = 2;
/// The key of a host-keyed record: the host reference, then the key of
/// the province the event happened in.
pub const HOST_KEY_LEN: usize = HOST_REF_LEN + PROVINCE_KEY_LEN;
/// The Departed payload width (`WideKind::payload_len`, the builder
/// [`departed_payload`]).
pub const DEPARTED_PAYLOAD_LEN: usize = 1 + 4 + 4 + 4 + 2 + 8 + 8 + 8 + 32;
/// The TransitSettled payload width ([`transit_settled_payload`]): the
/// settlement facts and the **sealed destination key** (the province the
/// seal named, whether or not it exists; the record's key names the
/// chained province, which is the home when the destination is absent).
pub const TRANSIT_SETTLED_PAYLOAD_LEN: usize = 1 + 1 + 1 + 4 + 8 + 8 + 8 + 1 + PROVINCE_KEY_LEN;
/// The longest body (a TransitSettled: a host key and its 82 payload
/// bytes, two links).
pub const MAX_BODY: usize =
    HEAD_LEN + HOST_KEY_LEN + TRANSIT_SETTLED_PAYLOAD_LEN + 1 + MAX_LINKS * LINK_LEN;
const _: () = assert!(TRANSIT_SETTLED_PAYLOAD_LEN > DEPARTED_PAYLOAD_LEN);

/// The key of a host-keyed record: `host ref ‖ standing province key`
/// (module doc, attribution).
pub fn host_key(host: &WideHostRef, standing: ProvinceKey) -> [u8; HOST_KEY_LEN] {
    let mut k = [0u8; HOST_KEY_LEN];
    k[..HOST_REF_LEN].copy_from_slice(&host.to_bytes());
    k[HOST_REF_LEN..].copy_from_slice(&standing.to_bytes());
    k
}

/// The chained wide accounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum WideEntity {
    Province = 1,
    Holding = 2,
}

impl WideEntity {
    pub const fn from_u8(v: u8) -> Option<WideEntity> {
        match v {
            1 => Some(WideEntity::Province),
            2 => Some(WideEntity::Holding),
            _ => None,
        }
    }
}

/// One wide account, by full identity: the province of a key, or the
/// holding of a holding reference (site and generation, sequence 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideTarget {
    Province(ProvinceKey),
    Holding(WideHostRef),
}

impl WideTarget {
    pub const fn entity(&self) -> WideEntity {
        match self {
            WideTarget::Province(_) => WideEntity::Province,
            WideTarget::Holding(_) => WideEntity::Holding,
        }
    }
}

/// The record kinds (module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum WideKind {
    Muster = 1,
    Dissolve = 2,
    Resolve = 3,
    Return = 4,
    Stranded = 5,
    RosterClosed = 6,
    Departed = 7,
    TransitSettled = 8,
    DepartureSettled = 9,
    Revealed = 10,
    Gathered = 11,
    RecordClosed = 12,
    TransitClosed = 13,
    ProvinceClosed = 14,
}

/// Every kind, in code order.
pub const ALL_KINDS: [WideKind; 14] = [
    WideKind::Muster,
    WideKind::Dissolve,
    WideKind::Resolve,
    WideKind::Return,
    WideKind::Stranded,
    WideKind::RosterClosed,
    WideKind::Departed,
    WideKind::TransitSettled,
    WideKind::DepartureSettled,
    WideKind::Revealed,
    WideKind::Gathered,
    WideKind::RecordClosed,
    WideKind::TransitClosed,
    WideKind::ProvinceClosed,
];

/// The `Return.entry` of a host whose troops went into the holding's
/// reserve rather than a muster-pending entry (a settlement's home re-entry
/// when the home province has no room or no roster).
pub const RETURN_TO_RESERVE: u8 = 0xFF;

const PROVINCE_AND_HOLDING: &[WideEntity] = &[WideEntity::Province, WideEntity::Holding];
const PROVINCE_ONLY: &[WideEntity] = &[WideEntity::Province];
const NO_LINKS: &[WideEntity] = &[];

impl WideKind {
    pub const fn from_u8(v: u8) -> Option<WideKind> {
        match v {
            1 => Some(WideKind::Muster),
            2 => Some(WideKind::Dissolve),
            3 => Some(WideKind::Resolve),
            4 => Some(WideKind::Return),
            5 => Some(WideKind::Stranded),
            6 => Some(WideKind::RosterClosed),
            7 => Some(WideKind::Departed),
            8 => Some(WideKind::TransitSettled),
            9 => Some(WideKind::DepartureSettled),
            10 => Some(WideKind::Revealed),
            11 => Some(WideKind::Gathered),
            12 => Some(WideKind::RecordClosed),
            13 => Some(WideKind::TransitClosed),
            14 => Some(WideKind::ProvinceClosed),
            _ => None,
        }
    }

    /// The key: a host key (reference and standing province) or a province
    /// key.
    pub const fn key_len(self) -> usize {
        if self.host_keyed() {
            HOST_KEY_LEN
        } else {
            PROVINCE_KEY_LEN
        }
    }

    pub const fn payload_len(self) -> usize {
        match self {
            WideKind::Muster => 1 + 4 + 1 + 1 + 8,
            WideKind::Dissolve => 4 + 4 + 1,
            WideKind::Resolve => 32 + 32 + 4 + 1 + 1 + 1,
            WideKind::Return => 4 + 1 + 1,
            WideKind::Stranded => 4 + 1,
            WideKind::RosterClosed => 32 + 8,
            WideKind::Departed => DEPARTED_PAYLOAD_LEN,
            WideKind::TransitSettled => TRANSIT_SETTLED_PAYLOAD_LEN,
            WideKind::DepartureSettled => 1 + 1 + 4 + 2 + 2 + 1,
            WideKind::Revealed => 1 + 1 + 1 + 1 + 1 + 2 + 4 + 1,
            WideKind::Gathered => 4 + 1 + 1 + 4 + 1 + 1,
            WideKind::RecordClosed => 1 + 4 + 1 + 1 + 32 + 8,
            WideKind::TransitClosed => 1 + 32 + 8,
            WideKind::ProvinceClosed => 32 + 8,
        }
    }

    /// The exact link set of the kind, in tail order (module doc).
    pub const fn links(self) -> &'static [WideEntity] {
        match self {
            WideKind::Muster
            | WideKind::Dissolve
            | WideKind::Return
            | WideKind::Departed
            | WideKind::TransitSettled
            | WideKind::DepartureSettled => PROVINCE_AND_HOLDING,
            WideKind::Resolve | WideKind::Stranded | WideKind::ProvinceClosed => PROVINCE_ONLY,
            WideKind::RosterClosed
            | WideKind::Revealed
            | WideKind::Gathered
            | WideKind::RecordClosed
            | WideKind::TransitClosed => NO_LINKS,
        }
    }

    /// A host-keyed kind (the key is a host reference and a standing
    /// province key).
    pub const fn host_keyed(self) -> bool {
        !matches!(
            self,
            WideKind::Resolve
                | WideKind::RosterClosed
                | WideKind::Gathered
                | WideKind::RecordClosed
                | WideKind::ProvinceClosed
        )
    }

    pub const fn name(self) -> &'static str {
        match self {
            WideKind::Muster => "WIDE_MUSTER",
            WideKind::Dissolve => "WIDE_DISSOLVE",
            WideKind::Resolve => "WIDE_RESOLVE",
            WideKind::Return => "WIDE_RETURN",
            WideKind::Stranded => "WIDE_STRANDED",
            WideKind::RosterClosed => "WIDE_ROSTER_CLOSED",
            WideKind::Departed => "WIDE_DEPARTED",
            WideKind::TransitSettled => "WIDE_TRANSIT_SETTLED",
            WideKind::DepartureSettled => "WIDE_DEPARTURE_SETTLED",
            WideKind::Revealed => "WIDE_REVEALED",
            WideKind::Gathered => "WIDE_GATHERED",
            WideKind::RecordClosed => "WIDE_RECORD_CLOSED",
            WideKind::TransitClosed => "WIDE_TRANSIT_CLOSED",
            WideKind::ProvinceClosed => "WIDE_PROVINCE_CLOSED",
        }
    }
}

/// One tail link: the entity's chain after this record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideLink {
    pub entity: WideEntity,
    pub seq: u64,
    pub head: [u8; 32],
}

/// Why a body is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventError {
    Short,
    Version(u8),
    /// The retired 0x81 body (module doc, versions): a different key
    /// layout, refused by name rather than reinterpreted.
    RetiredVersion(u8),
    UnknownKind(u8),
    UnknownEntity(u8),
    /// More than [`MAX_LINKS`] links, a repeated entity or a descending
    /// order.
    Tail,
    /// The tail is not exactly the kind's link set.
    Links,
    /// Bytes after the tail.
    Trailing,
    /// A key that is not a canonical reference or key.
    Key,
    /// A chain that does not recompute at this record (`seq` the chain's
    /// sequence before it).
    Chain {
        entity: WideEntity,
        seq: u64,
    },
}

/// The chain of an entity after a record: `seq' = seq + 1`, `head' =
/// sha256(domain ‖ entity ‖ LE64(seq') ‖ head ‖ body_without_tail)`.
pub fn next_head(
    entity: WideEntity,
    seq_next: u64,
    prev_head: &[u8; 32],
    body_without_tail: &[u8],
) -> [u8; 32] {
    sha256(&[
        WIDE_CHAIN_DOMAIN,
        &[entity as u8],
        &seq_next.to_le_bytes(),
        prev_head,
        body_without_tail,
    ])
}

/// Advances one entity's chain by this record (`None` on a sequence
/// overflow).
pub fn advance(
    entity: WideEntity,
    seq: u64,
    head: &[u8; 32],
    body_without_tail: &[u8],
) -> Option<WideLink> {
    let seq = seq.checked_add(1)?;
    Some(WideLink {
        entity,
        seq,
        head: next_head(entity, seq, head, body_without_tail),
    })
}

/// `version ‖ kind ‖ bell ‖ key ‖ payload` into `out`; `None` when a width
/// is wrong or `out` is short. Returns the length.
pub fn write_body(
    kind: WideKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    out: &mut [u8],
) -> Option<usize> {
    if key.len() != kind.key_len() || payload.len() != kind.payload_len() {
        return None;
    }
    let mut w = Writer::new(out);
    w.u8(WIDE_EVENT_VERSION)
        .u8(kind as u8)
        .u32(bell)
        .bytes(key)
        .bytes(payload);
    w.finish()
}

/// Appends the tail at `at` (`None` when `links` is not exactly `kind`'s
/// link set in order, or the buffer is short). Returns the whole length.
pub fn write_tail(kind: WideKind, links: &[WideLink], out: &mut [u8], at: usize) -> Option<usize> {
    let want = kind.links();
    if links.len() != want.len() || links.iter().zip(want).any(|(l, w)| l.entity != *w) {
        return None;
    }
    let mut w = Writer::new(out.get_mut(at..)?);
    w.u8(links.len() as u8);
    for l in links {
        w.u8(l.entity as u8).u64(l.seq).bytes(&l.head);
    }
    Some(at + w.finish()?)
}

/// A decoded record (borrowing the body).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideRecord<'a> {
    pub kind: WideKind,
    pub bell: u32,
    pub key: &'a [u8],
    pub payload: &'a [u8],
    /// `version ‖ kind ‖ bell ‖ key ‖ payload`: what the chain hashes.
    pub body_without_tail: &'a [u8],
    pub links: [Option<WideLink>; MAX_LINKS],
}

impl<'a> WideRecord<'a> {
    /// Decodes exactly one body: the version, a known kind, the kind's
    /// widths, a canonical key, a tail that is exactly the kind's link set
    /// in order, nothing after it.
    pub fn decode(body: &'a [u8]) -> Result<WideRecord<'a>, EventError> {
        let mut c = Cursor::new(body);
        let ver = c.u8().ok_or(EventError::Short)?;
        if ver == WIDE_EVENT_VERSION_RETIRED {
            return Err(EventError::RetiredVersion(ver));
        }
        if ver != WIDE_EVENT_VERSION {
            return Err(EventError::Version(ver));
        }
        let k = c.u8().ok_or(EventError::Short)?;
        let kind = WideKind::from_u8(k).ok_or(EventError::UnknownKind(k))?;
        let bell = c.u32().ok_or(EventError::Short)?;
        let key = c.take(kind.key_len()).ok_or(EventError::Short)?;
        let payload = c.take(kind.payload_len()).ok_or(EventError::Short)?;
        let body_without_tail = &body[..c.pos()];
        if kind.host_keyed() {
            let host =
                WideHostRef::from_bytes(&key[..HOST_REF_LEN]).map_err(|_| EventError::Key)?;
            let standing =
                ProvinceKey::from_bytes(&key[HOST_REF_LEN..]).map_err(|_| EventError::Key)?;
            // One world per record: a host of one world standing in a
            // province of another is no record of either.
            if host.key().world() != standing.world() {
                return Err(EventError::Key);
            }
            // A settlement's sealed destination is a key of the payload:
            // canonical and of the same world, or the record is refused.
            if kind == WideKind::TransitSettled {
                let d = payload
                    .get(TRANSIT_SETTLED_DEST_AT..)
                    .ok_or(EventError::Short)?;
                let dest = ProvinceKey::from_bytes(d).map_err(|_| EventError::Key)?;
                if dest.world() != host.key().world() {
                    return Err(EventError::Key);
                }
            }
        } else {
            ProvinceKey::from_bytes(key).map_err(|_| EventError::Key)?;
        }
        let n = c.u8().ok_or(EventError::Short)?;
        if n as usize > MAX_LINKS {
            return Err(EventError::Tail);
        }
        let mut links = [None; MAX_LINKS];
        let mut last = 0u8;
        for slot in links.iter_mut().take(n as usize) {
            let e = c.u8().ok_or(EventError::Short)?;
            let entity = WideEntity::from_u8(e).ok_or(EventError::UnknownEntity(e))?;
            if e <= last {
                return Err(EventError::Tail);
            }
            last = e;
            let seq = c.u64().ok_or(EventError::Short)?;
            let head = c.arr::<32>().ok_or(EventError::Short)?;
            *slot = Some(WideLink { entity, seq, head });
        }
        if !c.done() {
            return Err(EventError::Trailing);
        }
        let want = kind.links();
        let got = links.iter().flatten().count();
        if got != want.len()
            || links
                .iter()
                .flatten()
                .zip(want)
                .any(|(l, w)| l.entity != *w)
        {
            return Err(EventError::Links);
        }
        Ok(WideRecord {
            kind,
            bell,
            key,
            payload,
            body_without_tail,
            links,
        })
    }

    /// The link of `entity`, if the record chained it.
    pub fn link(&self, entity: WideEntity) -> Option<WideLink> {
        self.links
            .iter()
            .flatten()
            .find(|l| l.entity == entity)
            .copied()
    }

    /// The host of a host-keyed record.
    pub fn host(&self) -> Option<WideHostRef> {
        if self.kind.host_keyed() {
            WideHostRef::from_bytes(self.key.get(..HOST_REF_LEN)?).ok()
        } else {
            None
        }
    }

    /// The standing province of a host-keyed record: where the event
    /// happened (the origin of a departure, the destination of a transit
    /// settlement).
    pub fn standing(&self) -> Option<ProvinceKey> {
        if self.kind.host_keyed() {
            ProvinceKey::from_bytes(self.key.get(HOST_REF_LEN..)?).ok()
        } else {
            None
        }
    }

    /// The host's **home** province of a host-keyed record (the issuing
    /// holding's). A fact about the host, not the record's attribution.
    pub fn home_of(&self) -> Option<ProvinceKey> {
        self.host().map(|h| h.key())
    }

    /// The province key of a province-keyed record.
    pub fn province(&self) -> Option<ProvinceKey> {
        if self.kind.host_keyed() {
            None
        } else {
            ProvinceKey::from_bytes(self.key).ok()
        }
    }

    /// The province the record concerns (module doc, attribution): the key
    /// of a province-keyed record, the **standing** province of a
    /// host-keyed one — never the home province, never the alias.
    pub fn province_of(&self) -> Option<ProvinceKey> {
        if self.kind.host_keyed() {
            self.standing()
        } else {
            self.province()
        }
    }

    /// The holding the record concerns: the host's issuing holding
    /// (`holding_ref`) of a host-keyed record; none otherwise.
    pub fn holding_of(&self) -> Option<WideHostRef> {
        self.host().map(|h| h.holding_ref())
    }

    /// Whether the record is attributed to `target`.
    pub fn concerns(&self, target: WideTarget) -> bool {
        match target {
            WideTarget::Province(k) => self.province_of() == Some(k),
            WideTarget::Holding(h) => self.holding_of() == Some(h.holding_ref()),
        }
    }
}

/// Builds a whole record: the body over `(kind, bell, key, payload)` and
/// the tail over `links` (which the caller computed with [`advance`]
/// against the body without tail, exactly the kind's link set in order).
pub fn encode(
    kind: WideKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    links: &[WideLink],
) -> Option<Vec<u8>> {
    let mut out = alloc::vec![0u8; MAX_BODY];
    let n = write_body(kind, bell, key, payload, &mut out)?;
    let m = write_tail(kind, links, &mut out, n)?;
    out.truncate(m);
    Some(out)
}

/// Recomputes `target`'s chain over `bodies` from `(seq, head)`: a record
/// attributed to the target (`concerns`) and chaining its entity must carry that entity's
/// link and that link must be exactly what [`advance`] gives
/// ([`EventError::Chain`] otherwise); a record of another province or
/// holding is skipped, whatever links it carries. Returns the chain after
/// the last consumed record.
pub fn verify_chain<'a, I: IntoIterator<Item = &'a [u8]>>(
    target: WideTarget,
    start: (u64, [u8; 32]),
    bodies: I,
) -> Result<(u64, [u8; 32]), EventError> {
    let entity = target.entity();
    let (mut seq, mut head) = start;
    for body in bodies {
        let r = WideRecord::decode(body)?;
        if !r.concerns(target) || !r.kind.links().contains(&entity) {
            continue;
        }
        let link = r.link(entity).ok_or(EventError::Chain { entity, seq })?;
        let want = advance(entity, seq, &head, r.body_without_tail)
            .ok_or(EventError::Chain { entity, seq })?;
        if want != link {
            return Err(EventError::Chain { entity, seq });
        }
        seq = link.seq;
        head = link.head;
    }
    Ok((seq, head))
}

/// A chained wide account's bytes with the header's `event_seq` and
/// `event_head` zeroed: the normalization both resolve digests apply to
/// the province (module doc). Bytes too short to hold the header are
/// returned as they are.
pub fn normalize_chained(d: &[u8]) -> Vec<u8> {
    let mut v = d.to_vec();
    if let Some(s) = v.get_mut(header::EVENT_SEQ..header::EVENT_SEQ + 8) {
        s.fill(0);
    }
    if let Some(h) = v.get_mut(header::EVENT_HEAD..header::EVENT_HEAD + 32) {
        h.fill(0);
    }
    v
}

/// `sha256(domain ‖ province key ‖ LE32(bell) ‖ seed ‖ sha256(season
/// bytes) ‖ sha256(normalized province bytes before) ‖ sha256(roster bytes
/// before) ‖ sha256(ClashInputs bytes before, empty when none))`:
/// everything the bell model read, under the Season that authenticated it
/// (module doc).
pub fn resolve_input_digest(
    province: ProvinceKey,
    bell: u32,
    seed: &[u8; 32],
    season: &[u8],
    province_before: &[u8],
    roster_before: &[u8],
    inputs_before: &[u8],
) -> [u8; 32] {
    sha256(&[
        RESOLVE_INPUT_DOMAIN,
        &province.to_bytes(),
        &bell.to_le_bytes(),
        seed,
        &sha256(&[season]),
        &sha256(&[&normalize_chained(province_before)]),
        &sha256(&[roster_before]),
        &sha256(&[inputs_before]),
    ])
}

/// `sha256(domain ‖ clash digest ‖ sha256(normalized province bytes after)
/// ‖ sha256(roster bytes after) ‖ sha256(ClashInputs bytes after, empty
/// when none))`: the kernel's outcome and the bytes it left, before the
/// record's own link (module doc).
pub fn resolve_output_digest(
    clash_digest: &[u8; 32],
    province_after: &[u8],
    roster_after: &[u8],
    inputs_after: &[u8],
) -> [u8; 32] {
    sha256(&[
        RESOLVE_OUTPUT_DOMAIN,
        clash_digest,
        &sha256(&[&normalize_chained(province_after)]),
        &sha256(&[roster_after]),
        &sha256(&[inputs_after]),
    ])
}

// ------------------------------------------------------------ payloads

/// The Muster payload (module doc).
pub fn muster_payload(unit: u8, troops: u32, tile: u8, entry: u8, alias: u64) -> [u8; 15] {
    let mut b = [0u8; 15];
    Writer::new(&mut b)
        .u8(unit)
        .u32(troops)
        .u8(tile)
        .u8(entry)
        .u64(alias);
    b
}

/// The Dissolve payload.
pub fn dissolve_payload(pend_bell: u32, troops: u32, entry: u8) -> [u8; 9] {
    let mut b = [0u8; 9];
    Writer::new(&mut b).u32(pend_bell).u32(troops).u8(entry);
    b
}

/// The Resolve payload.
pub fn resolve_payload(
    input: &[u8; 32],
    output: &[u8; 32],
    engagements: u32,
    destroyed: u8,
    bounced: u8,
    settled: bool,
) -> [u8; 71] {
    let mut b = [0u8; 71];
    Writer::new(&mut b)
        .bytes(input)
        .bytes(output)
        .u32(engagements)
        .u8(destroyed)
        .u8(bounced)
        .u8(settled as u8);
    b
}

/// The Return payload.
pub fn return_payload(credited: u32, unit: u8, entry: u8) -> [u8; 6] {
    let mut b = [0u8; 6];
    Writer::new(&mut b).u32(credited).u8(unit).u8(entry);
    b
}

/// The Stranded payload.
pub fn stranded_payload(troops_lost: u32, entry: u8) -> [u8; 5] {
    let mut b = [0u8; 5];
    Writer::new(&mut b).u32(troops_lost).u8(entry);
    b
}

/// The RosterClosed payload.
pub fn roster_closed_payload(rent_to: &[u8; 32], lamports: u64) -> [u8; 40] {
    let mut b = [0u8; 40];
    Writer::new(&mut b).bytes(rent_to).u64(lamports);
    b
}

/// The ProvinceClosed payload (module doc): the fund the province closed
/// into and the lamports. The record carries the province's **final**
/// chain in its link: it is written on the province's header before the
/// account is erased, as the deployed `CLOSE` record is.
pub fn province_closed_payload(fund: &[u8; 32], lamports: u64) -> [u8; 40] {
    let mut b = [0u8; 40];
    Writer::new(&mut b).bytes(fund).u64(lamports);
    b
}

/// The Departed payload (module doc): the escrow and the seal root a
/// settlement is judged against.
#[allow(clippy::too_many_arguments)]
pub fn departed_payload(
    transit_slot: u8,
    depart_bell: u32,
    arrive_bell: u32,
    dep_mass: u32,
    march_stamina: u16,
    tip: u64,
    fee: u64,
    bond: u64,
    seal_root: &[u8; 32],
) -> [u8; DEPARTED_PAYLOAD_LEN] {
    let mut b = [0u8; DEPARTED_PAYLOAD_LEN];
    Writer::new(&mut b)
        .u8(transit_slot)
        .u32(depart_bell)
        .u32(arrive_bell)
        .u32(dep_mass)
        .u16(march_stamina)
        .u64(tip)
        .u64(fee)
        .u64(bond)
        .bytes(seal_root);
    b
}

/// The DepartureSettled payload (module doc): the origin's post-clash
/// values moved into the transit record and the entry freed.
pub fn departure_settled_payload(
    transit_slot: u8,
    destroyed: bool,
    troops_after: u32,
    stamina_after: u16,
    ready_bell_off: u16,
    entry: u8,
) -> [u8; 11] {
    let mut b = [0u8; 11];
    Writer::new(&mut b)
        .u8(transit_slot)
        .u8(destroyed as u8)
        .u32(troops_after)
        .u16(stamina_after)
        .u16(ready_bell_off)
        .u8(entry);
    b
}

/// The Revealed payload (module doc): the slot the arrival took and the
/// committed facts the slot carries; `displaced` is whether a lower-ranked
/// arrival was written over.
#[allow(clippy::too_many_arguments)]
pub fn revealed_payload(
    transit_slot: u8,
    faction: u8,
    i: u8,
    tile: u8,
    stance: u8,
    retreat_bps: u16,
    dep_mass: u32,
    displaced: bool,
) -> [u8; 12] {
    let mut b = [0u8; 12];
    Writer::new(&mut b)
        .u8(transit_slot)
        .u8(faction)
        .u8(i)
        .u8(tile)
        .u8(stance)
        .u16(retreat_bps)
        .u32(dep_mass)
        .u8(displaced as u8);
    b
}

/// The Gathered payload (module doc): the gather's cursor and the
/// ClashInputs' state after it.
pub fn gathered_payload(
    bell: u32,
    start: u8,
    n: u8,
    arrivals_mask: u32,
    n_present: u8,
    no_arrivals: bool,
) -> [u8; 12] {
    let mut b = [0u8; 12];
    Writer::new(&mut b)
        .u32(bell)
        .u8(start)
        .u8(n)
        .u32(arrivals_mask)
        .u8(n_present)
        .u8(no_arrivals as u8);
    b
}

/// The RecordClosed payload (module doc): which march record closed
/// (`what` of the WideClose), its bell (a day's first bell for a day
/// record), its faction and slot index (zero for a day or an inputs
/// record), the rent recipient and the lamports returned.
pub fn record_closed_payload(
    what: u8,
    bell: u32,
    faction: u8,
    i: u8,
    rent_to: &[u8; 32],
    lamports: u64,
) -> [u8; 47] {
    let mut b = [0u8; 47];
    Writer::new(&mut b)
        .u8(what)
        .u32(bell)
        .u8(faction)
        .u8(i)
        .bytes(rent_to)
        .u64(lamports);
    b
}

/// The TransitClosed payload (module doc): the slot, the rent recipient
/// and the lamports returned.
pub fn transit_closed_payload(transit_slot: u8, rent_to: &[u8; 32], lamports: u64) -> [u8; 41] {
    let mut b = [0u8; 41];
    Writer::new(&mut b)
        .u8(transit_slot)
        .bytes(rent_to)
        .u64(lamports);
    b
}

/// The TransitSettled payload (module doc): the outcome, the seal
/// verdict, the host's troops after, the three payments as paid and the
/// sealed destination key (`sealed_dest`: the province the settlement was
/// judged against, present or not).
#[allow(clippy::too_many_arguments)]
pub fn transit_settled_payload(
    transit_slot: u8,
    outcome: u8,
    seal_code: u8,
    troops: u32,
    tip: u64,
    fee: u64,
    bond: u64,
    home_credited: bool,
    sealed_dest: ProvinceKey,
) -> [u8; TRANSIT_SETTLED_PAYLOAD_LEN] {
    let mut b = [0u8; TRANSIT_SETTLED_PAYLOAD_LEN];
    Writer::new(&mut b)
        .u8(transit_slot)
        .u8(outcome)
        .u8(seal_code)
        .u32(troops)
        .u64(tip)
        .u64(fee)
        .u64(bond)
        .u8(home_credited as u8)
        .bytes(&sealed_dest.to_bytes());
    b
}

/// Offset of `sealed_dest` in a TransitSettled payload.
pub const TRANSIT_SETTLED_DEST_AT: usize = 1 + 1 + 1 + 4 + 8 + 8 + 8 + 1;

impl WideRecord<'_> {
    /// The sealed destination of a `TransitSettled` (`None` for any other
    /// kind): the fact of where the march was sealed to, independent of
    /// the province the record chains. Canonical and of the host's world
    /// by [`WideRecord::decode`], which refuses the record otherwise.
    pub fn sealed_dest(&self) -> Option<ProvinceKey> {
        if self.kind != WideKind::TransitSettled {
            return None;
        }
        ProvinceKey::from_bytes(self.payload.get(TRANSIT_SETTLED_DEST_AT..)?).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WideCoord;
    use crate::world_index::key::WorldId;
    use std::vec;

    fn key_at(p: i64) -> ProvinceKey {
        ProvinceKey::new(
            WorldId::new([0x77; 32]).unwrap(),
            WideCoord::checked(p, 0).unwrap(),
        )
    }

    fn key() -> ProvinceKey {
        key_at(129)
    }

    fn host() -> WideHostRef {
        WideHostRef::new(key(), 3, 1, 7).unwrap()
    }

    /// The host's key standing in its home province.
    fn hk() -> [u8; HOST_KEY_LEN] {
        host_key(&host(), key())
    }

    /// A chain state per entity for building records in tests.
    struct Chains {
        province: (u64, [u8; 32]),
        holding: (u64, [u8; 32]),
    }

    impl Chains {
        fn new() -> Chains {
            Chains {
                province: (0, [0; 32]),
                holding: (0, [0; 32]),
            }
        }

        /// Encodes a record of `kind` with the links its kind requires,
        /// advancing the chains it links.
        fn record(&mut self, kind: WideKind, bell: u32, key: &[u8], payload: &[u8]) -> Vec<u8> {
            let mut bwt = [0u8; MAX_BODY];
            let n = write_body(kind, bell, key, payload, &mut bwt).unwrap();
            let mut links = Vec::new();
            for e in kind.links() {
                let (seq, head) = match e {
                    WideEntity::Province => self.province,
                    WideEntity::Holding => self.holding,
                };
                let l = advance(*e, seq, &head, &bwt[..n]).unwrap();
                match e {
                    WideEntity::Province => self.province = (l.seq, l.head),
                    WideEntity::Holding => self.holding = (l.seq, l.head),
                }
                links.push(l);
            }
            encode(kind, bell, key, payload, &links).unwrap()
        }
    }

    #[test]
    fn related_unchained_receipts_do_not_break_target_chain() {
        let mut c = Chains::new();
        let m = c.record(
            WideKind::Muster,
            1,
            &hk(),
            &muster_payload(0, 300, 17, 0, 0x8000_0000_0000_0001),
        );
        let s = c.record(WideKind::Stranded, 2, &hk(), &stranded_payload(300_000, 0));
        let close = c.record(
            WideKind::RosterClosed,
            3,
            &key().to_bytes(),
            &roster_closed_payload(&[9; 32], 10),
        );
        let bodies = [m.as_slice(), s.as_slice(), close.as_slice()];
        assert_eq!(
            verify_chain(WideTarget::Province(key()), (0, [0; 32]), bodies),
            Ok(c.province)
        );
        assert_eq!(
            verify_chain(WideTarget::Holding(host()), (0, [0; 32]), bodies),
            Ok(c.holding)
        );
    }

    fn muster_record() -> (Vec<u8>, WideLink, WideLink) {
        let mut c = Chains::new();
        let payload = muster_payload(0, 300, 17, 0, 0x8000_0000_0000_0001);
        let body = c.record(WideKind::Muster, 4, &hk(), &payload);
        let r = WideRecord::decode(&body).unwrap();
        (
            body.clone(),
            r.link(WideEntity::Province).unwrap(),
            r.link(WideEntity::Holding).unwrap(),
        )
    }

    #[test]
    fn records_round_trip_strictly_under_their_own_version() {
        let (body, p, h) = muster_record();
        assert_eq!(body[0], 0x82);
        assert_eq!(body[0], WIDE_EVENT_VERSION);
        assert_eq!(body[1], 1);
        assert_eq!(body.len(), HEAD_LEN + HOST_KEY_LEN + 15 + 1 + 2 * LINK_LEN);
        let r = WideRecord::decode(&body).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Muster, 4));
        assert_eq!(r.host(), Some(host()));
        assert_eq!(r.province(), None, "a host key is no province key");
        assert_eq!(r.standing(), Some(key()));
        assert_eq!(r.home_of(), Some(key()));
        assert_eq!(
            r.province_of(),
            Some(key()),
            "attributed to the standing province (here the home)"
        );
        assert_eq!(r.holding_of(), Some(host().holding_ref()));
        assert!(r.concerns(WideTarget::Province(key())));
        assert!(r.concerns(WideTarget::Holding(host().holding_ref())));
        assert!(
            r.concerns(WideTarget::Holding(host())),
            "the holding of any sequence"
        );
        assert!(!r.concerns(WideTarget::Province(key_at(130))));
        assert!(!r.concerns(WideTarget::Holding(
            WideHostRef::new(key(), 3, 2, 0).unwrap()
        )));
        assert!(!r.concerns(WideTarget::Holding(
            WideHostRef::new(key(), 4, 1, 0).unwrap()
        )));
        assert_eq!(r.payload[..5], [0, 44, 1, 0, 0]);
        assert_eq!(r.link(WideEntity::Province), Some(p));
        assert_eq!(r.link(WideEntity::Holding), Some(h));
        assert_eq!(p.seq, 1);
        assert_ne!(p.head, h.head, "the entity is in the hash");
        // the deployed decoders refuse the version byte
        assert_eq!(body[0], 0x82);
        assert_eq!(
            crate::log::decode(&body).err(),
            Some(crate::log::LogError::Version(0x82))
        );
        assert_eq!(
            crate::v2::log::decode(&body).err(),
            Some(crate::log::LogError::Version(0x82))
        );
        assert_ne!(&WIDE_LOG_PREFIX[..], &crate::log::PREFIX[..]);
        // strictness: a wrong version, kind, key, width, tail or trailing byte
        let mut x = body.clone();
        x[0] = 1;
        assert_eq!(WideRecord::decode(&x), Err(EventError::Version(1)));
        // the retired 0x81 layout is refused by name, never reinterpreted
        // (its host key was 56 bytes: this body would otherwise misparse)
        let mut x = body.clone();
        x[0] = WIDE_EVENT_VERSION_RETIRED;
        assert_eq!(
            WideRecord::decode(&x),
            Err(EventError::RetiredVersion(0x81))
        );
        assert_ne!(WIDE_EVENT_VERSION, WIDE_EVENT_VERSION_RETIRED);
        assert!(
            WIDE_EVENT_VERSION & 0x80 != 0,
            "out of the deployed versions"
        );
        let mut x = body.clone();
        x[1] = 15;
        assert_eq!(WideRecord::decode(&x), Err(EventError::UnknownKind(15)));
        let mut x = body.clone();
        x[HEAD_LEN] = 9;
        assert_eq!(WideRecord::decode(&x), Err(EventError::Key));
        assert_eq!(
            WideRecord::decode(&body[..body.len() - 1]),
            Err(EventError::Short)
        );
        let mut x = body.clone();
        x.push(0);
        assert_eq!(WideRecord::decode(&x), Err(EventError::Trailing));
        let tail = HEAD_LEN + HOST_KEY_LEN + 15;
        let mut x = body.clone();
        x[tail] = 3;
        assert_eq!(WideRecord::decode(&x), Err(EventError::Tail));
        let mut x = body.clone();
        x[tail + 1] = 2;
        x[tail + 1 + LINK_LEN] = 1;
        assert_eq!(WideRecord::decode(&x), Err(EventError::Tail));
        let mut x = body.clone();
        x[tail + 1] = 5;
        assert_eq!(WideRecord::decode(&x), Err(EventError::UnknownEntity(5)));
        // widths are the kind's
        let hk = hk();
        let mut buf = [0u8; 128];
        assert!(write_body(WideKind::Muster, 1, &hk, &[0; 14], &mut buf).is_none());
        assert!(write_body(WideKind::Resolve, 1, &hk, &[0; 71], &mut buf).is_none());
        for k in ALL_KINDS {
            assert_eq!(WideKind::from_u8(k as u8), Some(k));
            assert!(k.name().starts_with("WIDE_"));
            assert!(
                HEAD_LEN + k.key_len() + k.payload_len() + 1 + MAX_LINKS * LINK_LEN <= MAX_BODY
            );
            assert_eq!(k.host_keyed(), k.key_len() == HOST_KEY_LEN);
        }
        assert_eq!(WideKind::from_u8(15), None);
        assert_eq!(WideKind::from_u8(0), None);
        // the close kinds: one province-keyed, one host-keyed, neither
        // chained; the province close chained on the province alone
        assert!(!WideKind::RecordClosed.host_keyed());
        assert!(WideKind::TransitClosed.host_keyed());
        assert_eq!(WideKind::RecordClosed.links(), NO_LINKS);
        assert_eq!(WideKind::TransitClosed.links(), NO_LINKS);
        assert!(!WideKind::ProvinceClosed.host_keyed());
        assert_eq!(WideKind::ProvinceClosed.links(), PROVINCE_ONLY);
        assert_eq!(WideKind::ProvinceClosed.payload_len(), 40);
        assert_eq!(WideKind::ProvinceClosed as u8, 14);
        let closed = encode(
            WideKind::RecordClosed,
            9,
            &key().to_bytes(),
            &record_closed_payload(2, 20, 1, 0, &[0xd4; 32], 1_000),
            &[],
        )
        .unwrap();
        let r = WideRecord::decode(&closed).unwrap();
        assert_eq!((r.payload[0], r.payload[5], r.payload[6]), (2, 1, 0));
        assert_eq!(&r.payload[1..5], &20u32.to_le_bytes());
        assert_eq!(&r.payload[7..39], &[0xd4; 32]);
        assert_eq!(&r.payload[39..47], &1_000u64.to_le_bytes());
        assert_eq!(r.province_of(), Some(key()));
        let closed = encode(
            WideKind::TransitClosed,
            9,
            &hk,
            &transit_closed_payload(3, &[0xd4; 32], 1_000),
            &[],
        )
        .unwrap();
        let r = WideRecord::decode(&closed).unwrap();
        assert_eq!(r.payload[0], 3);
        assert_eq!(r.host(), Some(host()));
        assert_eq!(r.links, [None, None]);
        let close = encode(
            WideKind::RosterClosed,
            9,
            &key().to_bytes(),
            &roster_closed_payload(&[0xd4; 32], 1_000),
            &[],
        )
        .unwrap();
        let r = WideRecord::decode(&close).unwrap();
        assert_eq!(r.province(), Some(key()));
        assert_eq!(r.province_of(), Some(key()));
        assert_eq!(r.host(), None);
        assert_eq!(r.holding_of(), None);
        assert_eq!(r.links, [None, None]);
        assert!(!r.concerns(WideTarget::Holding(host())));
    }

    /// A host event names the province it happened in; that province, not
    /// the host's home, is the record's attribution. The march kinds carry
    /// the origin (a departure) and the destination (a settlement) the same
    /// way, and both chain the host's holding.
    #[test]
    fn standing_province_attributes_a_host_event_never_the_home() {
        let (home, standing) = (key_at(129), key_at(130));
        let h = WideHostRef::new(home, 3, 1, 7).unwrap();
        let k = host_key(&h, standing);
        assert_eq!(k.len(), HOST_KEY_LEN);
        assert_eq!(&k[..HOST_REF_LEN], &h.to_bytes());
        assert_eq!(&k[HOST_REF_LEN..], &standing.to_bytes());
        let mut c = Chains::new();
        let body = c.record(WideKind::Dissolve, 9, &k, &dissolve_payload(9, 1_000, 2));
        let r = WideRecord::decode(&body).unwrap();
        assert_eq!(r.host(), Some(h));
        assert_eq!(r.standing(), Some(standing));
        assert_eq!(r.home_of(), Some(home));
        assert_eq!(r.province_of(), Some(standing), "where it happened");
        assert!(r.concerns(WideTarget::Province(standing)));
        assert!(
            !r.concerns(WideTarget::Province(home)),
            "never silently attributed to the home province"
        );
        assert!(r.concerns(WideTarget::Holding(h.holding_ref())));
        let one = [body.as_slice()];
        assert_eq!(
            verify_chain(WideTarget::Province(home), (0, [0; 32]), one),
            Ok((0, [0; 32])),
            "the home's chain ignores a foreign-standing event"
        );
        assert_eq!(
            verify_chain(WideTarget::Province(standing), (0, [0; 32]), one),
            Ok(c.province)
        );
        assert_eq!(
            verify_chain(WideTarget::Holding(h), (0, [0; 32]), one),
            Ok(c.holding)
        );
        // a standing part that is no canonical province key is refused
        let mut bad = body.clone();
        bad[HEAD_LEN + HOST_REF_LEN] = 9;
        assert_eq!(WideRecord::decode(&bad), Err(EventError::Key));
        // the march kinds: the departure in the origin, the settlement in
        // the destination, both over the host's holding
        let mut m = Chains::new();
        let dp = departed_payload(1, 10, 40, 300_000, 32, 14_441, 5_000, 7_000, &[3; 32]);
        let origin = m.record(WideKind::Departed, 10, &host_key(&h, home), &dp);
        let r = WideRecord::decode(&origin).unwrap();
        assert_eq!(r.kind, WideKind::Departed);
        assert_eq!((r.standing(), r.home_of()), (Some(home), Some(home)));
        assert_eq!(r.payload.len(), 71);
        assert_eq!(r.payload[0], 1);
        assert_eq!(&r.payload[1..5], &10u32.to_le_bytes());
        assert_eq!(&r.payload[5..9], &40u32.to_le_bytes());
        assert_eq!(&r.payload[9..13], &300_000u32.to_le_bytes());
        assert_eq!(&r.payload[13..15], &32u16.to_le_bytes());
        assert_eq!(&r.payload[15..23], &14_441u64.to_le_bytes());
        assert_eq!(&r.payload[23..31], &5_000u64.to_le_bytes());
        assert_eq!(&r.payload[31..39], &7_000u64.to_le_bytes());
        assert_eq!(&r.payload[39..71], &[3; 32]);
        assert_eq!(r.sealed_dest(), None, "not a settlement");
        let mut d = Chains::new();
        d.holding = m.holding;
        let tp = transit_settled_payload(1, 7, 0, 150_000, 0, 5_000, 7_000, true, standing);
        let dest = d.record(WideKind::TransitSettled, 40, &host_key(&h, standing), &tp);
        let r = WideRecord::decode(&dest).unwrap();
        assert_eq!(r.kind, WideKind::TransitSettled);
        assert_eq!((r.standing(), r.home_of()), (Some(standing), Some(home)));
        assert_eq!(r.payload.len(), 82);
        assert_eq!((r.payload[1], r.payload[2], r.payload[31]), (7, 0, 1));
        assert_eq!(&r.payload[3..7], &150_000u32.to_le_bytes());
        assert_eq!(&r.payload[32..82], &standing.to_bytes());
        assert_eq!(r.sealed_dest(), Some(standing));
        assert_eq!(dest.len(), MAX_BODY, "the longest body is a TransitSettled");
        // a settlement of a march sealed to a province never opened: the
        // record chains the home (its key), the payload keeps the sealed
        // destination (the fact)
        let never = key_at(131);
        let tp = transit_settled_payload(1, 7, 0, 150_000, 0, 5_000, 7_000, true, never);
        let mut e = Chains::new();
        let away = e.record(WideKind::TransitSettled, 40, &host_key(&h, home), &tp);
        let r = WideRecord::decode(&away).unwrap();
        assert_eq!(r.province_of(), Some(home), "chained at home");
        assert_eq!(r.sealed_dest(), Some(never), "sealed elsewhere: kept");
        assert_ne!(r.sealed_dest(), r.province_of());
        // the sealed destination is a key: a non-canonical byte or a key of
        // another world refuses the whole record at decode
        let at = HEAD_LEN + HOST_KEY_LEN + TRANSIT_SETTLED_DEST_AT;
        let mut bad = away.clone();
        bad[at] = 9;
        assert_eq!(
            WideRecord::decode(&bad),
            Err(EventError::Key),
            "a key version byte"
        );
        let mut bad = away.clone();
        bad[at + 1..at + 1 + 32].fill(0);
        assert_eq!(
            WideRecord::decode(&bad),
            Err(EventError::Key),
            "the reserved world"
        );
        let mut bad = away.clone();
        bad[at..at + PROVINCE_KEY_LEN].copy_from_slice(
            &ProvinceKey::new(
                WorldId::new([0x78; 32]).unwrap(),
                WideCoord::checked(131, 0).unwrap(),
            )
            .to_bytes(),
        );
        assert_eq!(
            WideRecord::decode(&bad),
            Err(EventError::Key),
            "another world"
        );
        let mut bad = away.clone();
        bad[at + 1..at + 1 + 32].copy_from_slice(&[0x78; 32]);
        assert_eq!(
            WideRecord::decode(&bad),
            Err(EventError::Key),
            "the host's coordinate under another world"
        );
        // a host of one world standing in a province of another: refused
        // at decode (one world per record)
        let other_world = ProvinceKey::new(
            WorldId::new([0x78; 32]).unwrap(),
            WideCoord::checked(130, 0).unwrap(),
        );
        let mut mixed = Chains::new();
        let bad = mixed.record(
            WideKind::Dissolve,
            9,
            &host_key(&h, other_world),
            &dissolve_payload(9, 1_000, 2),
        );
        assert_eq!(WideRecord::decode(&bad), Err(EventError::Key));
        assert_eq!(WideKind::Departed.links(), PROVINCE_AND_HOLDING);
        assert_eq!(WideKind::TransitSettled.links(), PROVINCE_AND_HOLDING);
        assert_eq!(WideKind::Departed.name(), "WIDE_DEPARTED");
        assert_eq!(WideKind::TransitSettled.name(), "WIDE_TRANSIT_SETTLED");
        let march = [origin.as_slice(), dest.as_slice()];
        assert_eq!(
            verify_chain(WideTarget::Province(home), (0, [0; 32]), march),
            Ok(m.province),
            "the origin's chain: the departure only"
        );
        assert_eq!(
            verify_chain(WideTarget::Province(standing), (0, [0; 32]), march),
            Ok(d.province),
            "the destination's chain: the settlement only"
        );
        assert_eq!(
            verify_chain(WideTarget::Holding(h), (0, [0; 32]), march),
            Ok(d.holding),
            "the holding's chain: both"
        );
        assert_eq!(d.holding.0, 2);
    }

    /// Every kind's builder produces exactly `payload_len` bytes, and the
    /// longest of them bounds `MAX_BODY` (the regression of the Departed
    /// builder that was 65 bytes against a 71-byte kind).
    #[test]
    fn every_payload_builder_matches_its_kind_width() {
        let widths: [(WideKind, usize); 14] = [
            (WideKind::Muster, muster_payload(0, 1, 1, 0, 0).len()),
            (WideKind::Dissolve, dissolve_payload(1, 1, 0).len()),
            (
                WideKind::Resolve,
                resolve_payload(&[0; 32], &[0; 32], 0, 0, 0, false).len(),
            ),
            (WideKind::Return, return_payload(1, 0, 0).len()),
            (WideKind::Stranded, stranded_payload(1, 0).len()),
            (
                WideKind::RosterClosed,
                roster_closed_payload(&[0; 32], 0).len(),
            ),
            (
                WideKind::Departed,
                departed_payload(0, 1, 2, 3, 4, 5, 6, 7, &[0; 32]).len(),
            ),
            (
                WideKind::TransitSettled,
                transit_settled_payload(0, 1, 2, 3, 4, 5, 6, false, key()).len(),
            ),
            (
                WideKind::DepartureSettled,
                departure_settled_payload(0, false, 1, 2, 3, 4).len(),
            ),
            (
                WideKind::Revealed,
                revealed_payload(0, 1, 2, 3, 4, 5, 6, false).len(),
            ),
            (
                WideKind::Gathered,
                gathered_payload(1, 0, 24, 0, 0, true).len(),
            ),
            (
                WideKind::RecordClosed,
                record_closed_payload(2, 20, 1, 0, &[0; 32], 1).len(),
            ),
            (
                WideKind::TransitClosed,
                transit_closed_payload(0, &[0; 32], 1).len(),
            ),
            (
                WideKind::ProvinceClosed,
                province_closed_payload(&[0; 32], 1).len(),
            ),
        ];
        assert_eq!(widths.len(), ALL_KINDS.len(), "every kind has a builder");
        for (k, built) in widths {
            assert_eq!(built, k.payload_len(), "{}", k.name());
            let mut buf = [0u8; MAX_BODY];
            let key: Vec<u8> = if k.host_keyed() {
                hk().to_vec()
            } else {
                key().to_bytes().to_vec()
            };
            let at = write_body(k, 1, &key, &vec![0u8; built], &mut buf).unwrap();
            assert!(at + 1 + k.links().len() * LINK_LEN <= MAX_BODY);
        }
        assert_eq!(DEPARTED_PAYLOAD_LEN, 71);
        assert_eq!(TRANSIT_SETTLED_PAYLOAD_LEN, 82);
        assert_eq!(TRANSIT_SETTLED_DEST_AT, 32);
        assert_eq!(
            MAX_BODY,
            HEAD_LEN + HOST_KEY_LEN + 82 + 1 + MAX_LINKS * LINK_LEN
        );
        assert_eq!(
            ALL_KINDS
                .iter()
                .map(|k| HEAD_LEN + k.key_len() + k.payload_len() + 1 + k.links().len() * LINK_LEN)
                .max(),
            Some(MAX_BODY),
            "MAX_BODY is reached by the widest kind, no slack and no shortfall"
        );
    }

    /// The tail is exactly the kind's link set: a missing, an extra or a
    /// wrong link refuses, at encoding and at decoding.
    #[test]
    fn link_sets_are_exact_per_kind() {
        let hk = hk();
        let pk = key().to_bytes();
        let p = WideLink {
            entity: WideEntity::Province,
            seq: 1,
            head: [1; 32],
        };
        let h = WideLink {
            entity: WideEntity::Holding,
            seq: 1,
            head: [2; 32],
        };
        let mp = muster_payload(0, 1, 1, 0, 0);
        let dp = dissolve_payload(1, 1, 0);
        let rp = resolve_payload(&[0; 32], &[0; 32], 0, 0, 0, false);
        let retp = return_payload(1, 0, 0);
        let sp = stranded_payload(1, 0);
        let cp = roster_closed_payload(&[0; 32], 0);
        let pcp = province_closed_payload(&[0xf1; 32], 7);
        // the accepted sets
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[p, h]).is_some());
        assert!(encode(WideKind::Dissolve, 1, &hk, &dp, &[p, h]).is_some());
        assert!(encode(WideKind::Return, 1, &hk, &retp, &[p, h]).is_some());
        assert!(encode(WideKind::Resolve, 1, &pk, &rp, &[p]).is_some());
        assert!(encode(WideKind::Stranded, 1, &hk, &sp, &[p]).is_some());
        assert!(encode(WideKind::RosterClosed, 1, &pk, &cp, &[]).is_some());
        // the province close: the province link exactly, round-tripped
        // strictly (the terminal link of the province's chain)
        let closed = encode(WideKind::ProvinceClosed, 9, &pk, &pcp, &[p]).unwrap();
        let r = WideRecord::decode(&closed).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::ProvinceClosed, 9));
        assert_eq!(r.province_of(), Some(key()));
        assert_eq!(&r.payload[..32], &[0xf1; 32]);
        assert_eq!(&r.payload[32..40], &7u64.to_le_bytes());
        assert_eq!(r.links, [Some(p), None]);
        assert_eq!(r.link(WideEntity::Province), Some(p));
        assert!(encode(WideKind::ProvinceClosed, 1, &pk, &pcp, &[]).is_none());
        assert!(encode(WideKind::ProvinceClosed, 1, &pk, &pcp, &[h]).is_none());
        assert!(encode(WideKind::ProvinceClosed, 1, &pk, &pcp, &[p, h]).is_none());
        // every other set refused at encoding
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[p]).is_none());
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[h]).is_none());
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[]).is_none());
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[h, p]).is_none());
        assert!(encode(WideKind::Return, 1, &hk, &retp, &[p]).is_none());
        assert!(encode(WideKind::Resolve, 1, &pk, &rp, &[p, h]).is_none());
        assert!(encode(WideKind::Resolve, 1, &pk, &rp, &[]).is_none());
        assert!(encode(WideKind::Stranded, 1, &hk, &sp, &[p, h]).is_none());
        assert!(encode(WideKind::Stranded, 1, &hk, &sp, &[h]).is_none());
        assert!(encode(WideKind::RosterClosed, 1, &pk, &cp, &[p]).is_none());
        // and at decoding: a Stranded body rewritten with two links, a
        // Muster body with one, a RosterClosed with one
        let mut forged = alloc::vec![0u8; MAX_BODY];
        let n = write_body(WideKind::Stranded, 1, &hk, &sp, &mut forged).unwrap();
        let mut w = Writer::new(&mut forged[n..]);
        w.u8(2);
        for l in [p, h] {
            w.u8(l.entity as u8).u64(l.seq).bytes(&l.head);
        }
        let m = n + w.finish().unwrap();
        assert_eq!(WideRecord::decode(&forged[..m]), Err(EventError::Links));
        let n = write_body(WideKind::Muster, 1, &hk, &mp, &mut forged).unwrap();
        let mut w = Writer::new(&mut forged[n..]);
        w.u8(1).u8(p.entity as u8).u64(p.seq).bytes(&p.head);
        let m = n + w.finish().unwrap();
        assert_eq!(WideRecord::decode(&forged[..m]), Err(EventError::Links));
        let n = write_body(WideKind::Muster, 1, &hk, &mp, &mut forged).unwrap();
        let mut w = Writer::new(&mut forged[n..]);
        w.u8(1).u8(h.entity as u8).u64(h.seq).bytes(&h.head);
        let m = n + w.finish().unwrap();
        assert_eq!(WideRecord::decode(&forged[..m]), Err(EventError::Links));
        let n = write_body(WideKind::RosterClosed, 1, &pk, &cp, &mut forged).unwrap();
        let mut w = Writer::new(&mut forged[n..]);
        w.u8(1).u8(p.entity as u8).u64(p.seq).bytes(&p.head);
        let m = n + w.finish().unwrap();
        assert_eq!(WideRecord::decode(&forged[..m]), Err(EventError::Links));
        assert_eq!(WideKind::Muster.links(), PROVINCE_AND_HOLDING);
        assert_eq!(WideKind::Stranded.links(), PROVINCE_ONLY);
        assert_eq!(WideKind::RosterClosed.links(), NO_LINKS);
    }

    /// A chain over a muster, a resolve and a dissolve recomputes for its
    /// own province and holding; a tampered body, a skipped record or a
    /// forged link does not. The digests bind the Season, the bell, the
    /// seed and the normalized bytes.
    #[test]
    fn chains_recompute_and_refuse_tampering() {
        let mut c = Chains::new();
        let muster = c.record(
            WideKind::Muster,
            4,
            &hk(),
            &muster_payload(0, 300, 17, 0, 1),
        );
        let seed = [0x5a; 32];
        let season = [0x11u8; 64];
        let input = resolve_input_digest(key(), 4, &seed, &season, &[1, 2, 3], &[4, 5], &[]);
        let output = resolve_output_digest(&[9; 32], &[1, 2, 4], &[4, 5], &[]);
        assert_ne!(input, output);
        assert_ne!(
            input,
            resolve_input_digest(key(), 5, &seed, &season, &[1, 2, 3], &[4, 5], &[]),
            "the bell is in the input"
        );
        assert_ne!(
            input,
            resolve_input_digest(key(), 4, &seed, &[0x12; 64], &[1, 2, 3], &[4, 5], &[]),
            "the Season bytes are in the input"
        );
        assert_ne!(
            input,
            resolve_input_digest(key(), 4, &seed, &season, &[1, 2, 3], &[4, 5], &[6]),
            "the gathered arrivals are in the input"
        );
        assert_ne!(
            output,
            resolve_output_digest(&[9; 32], &[1, 2, 3], &[4, 5], &[]),
            "the bytes after are in the output"
        );
        assert_ne!(
            output,
            resolve_output_digest(&[9; 32], &[1, 2, 4], &[4, 5], &[6]),
            "the arrivals' fates are in the output"
        );
        // the normalization: the header's chain fields do not enter either
        let mut pd = alloc::vec![7u8; header::EVENT_HEAD + 40];
        let base = resolve_output_digest(&[9; 32], &pd, &[], &[]);
        pd[header::EVENT_SEQ] = 1;
        pd[header::EVENT_HEAD + 3] = 1;
        assert_eq!(resolve_output_digest(&[9; 32], &pd, &[], &[]), base);
        assert_eq!(
            resolve_input_digest(key(), 4, &seed, &season, &pd, &[], &[]),
            resolve_input_digest(key(), 4, &seed, &season, &normalize_chained(&pd), &[], &[])
        );
        pd[header::EVENT_HEAD + 40 - 1] = 1;
        assert_ne!(
            resolve_output_digest(&[9; 32], &pd, &[], &[]),
            base,
            "a body byte"
        );
        let rp = resolve_payload(&input, &output, 0, 0, 0, true);
        let resolve = c.record(WideKind::Resolve, 4, &key().to_bytes(), &rp);
        let dissolve = c.record(
            WideKind::Dissolve,
            5,
            &hk(),
            &dissolve_payload(5, 300_000, 0),
        );
        let p3 = WideRecord::decode(&dissolve)
            .unwrap()
            .link(WideEntity::Province)
            .unwrap();
        let h2 = WideRecord::decode(&dissolve)
            .unwrap()
            .link(WideEntity::Holding)
            .unwrap();
        let all: Vec<&[u8]> = vec![&muster, &resolve, &dissolve];
        let prov = WideTarget::Province(key());
        let hold = WideTarget::Holding(host().holding_ref());
        assert_eq!(
            verify_chain(prov, (0, [0; 32]), all.iter().copied()),
            Ok((3, p3.head))
        );
        assert_eq!(
            verify_chain(hold, (0, [0; 32]), all.iter().copied()),
            Ok((2, h2.head)),
            "the resolve chains no holding"
        );
        // a skipped record
        let skipped: Vec<&[u8]> = vec![&muster, &dissolve];
        assert_eq!(
            verify_chain(prov, (0, [0; 32]), skipped.iter().copied()),
            Err(EventError::Chain {
                entity: WideEntity::Province,
                seq: 1
            })
        );
        // a tampered payload byte
        let mut bad = resolve.clone();
        bad[HEAD_LEN + PROVINCE_KEY_LEN] ^= 1;
        let tampered: Vec<&[u8]> = vec![&muster, &bad, &dissolve];
        assert_eq!(
            verify_chain(prov, (0, [0; 32]), tampered.iter().copied()),
            Err(EventError::Chain {
                entity: WideEntity::Province,
                seq: 1
            })
        );
        // a forged link head
        let mut forged = resolve.clone();
        let at = forged.len() - 1;
        forged[at] ^= 1;
        let f: Vec<&[u8]> = vec![&muster, &forged];
        assert!(verify_chain(prov, (0, [0; 32]), f.iter().copied()).is_err());
        // a wrong start
        assert!(verify_chain(prov, (1, [0; 32]), all.iter().copied()).is_err());
        // another holding of the same province: nothing of this trace is
        // its, so its chain stays at the start
        let other = WideTarget::Holding(WideHostRef::new(key(), 5, 1, 0).unwrap());
        assert_eq!(
            verify_chain(other, (0, [0; 32]), all.iter().copied()),
            Ok((0, [0; 32]))
        );
        // the province's terminal record: the close chains on the province
        // alone, the replay ends at its link (seq 4), the holding's chain is
        // untouched; a close whose link skips the province's last record
        // is refused; a close replayed twice is refused (nothing chains
        // after the terminal record)
        let closed = c.record(
            WideKind::ProvinceClosed,
            9,
            &key().to_bytes(),
            &province_closed_payload(&[0xf1; 32], 5_000),
        );
        let p4 = WideRecord::decode(&closed)
            .unwrap()
            .link(WideEntity::Province)
            .unwrap();
        assert_eq!((p4.seq, c.province), (4, (4, p4.head)));
        let ended: Vec<&[u8]> = vec![&muster, &resolve, &dissolve, &closed];
        assert_eq!(
            verify_chain(prov, (0, [0; 32]), ended.iter().copied()),
            Ok((4, p4.head))
        );
        assert_eq!(
            verify_chain(hold, (0, [0; 32]), ended.iter().copied()),
            Ok((2, h2.head)),
            "the province close chains no holding"
        );
        let early: Vec<&[u8]> = vec![&muster, &resolve, &closed];
        assert_eq!(
            verify_chain(prov, (0, [0; 32]), early.iter().copied()),
            Err(EventError::Chain {
                entity: WideEntity::Province,
                seq: 2
            }),
            "the close's link binds the dissolve before it"
        );
        let twice: Vec<&[u8]> = vec![&muster, &resolve, &dissolve, &closed, &closed];
        assert!(verify_chain(prov, (0, [0; 32]), twice.iter().copied()).is_err());
    }

    /// Two provinces and two holdings interleaved in one log: each target
    /// consumes only the records attributed to it, by full identity; a
    /// foreign record whose link happens to continue the target's chain is
    /// never accepted, and a record of the target with the other
    /// account's link is refused.
    #[test]
    fn interleaved_accounts_verify_by_full_identity_only() {
        let (ka, kb) = (key_at(129), key_at(130));
        let ha = WideHostRef::new(ka, 3, 1, 0).unwrap();
        let hb = WideHostRef::new(kb, 3, 1, 0).unwrap();
        let ha2 = WideHostRef::new(ka, 4, 1, 0).unwrap();
        let (mut ca, mut cb, mut ca2) = (Chains::new(), Chains::new(), Chains::new());
        // the same bells, the same sequence numbers, the same payloads
        let mp = muster_payload(0, 300, 17, 0, 1);
        let rp = resolve_payload(&[1; 32], &[2; 32], 0, 0, 0, true);
        let r_a1 = ca.record(WideKind::Resolve, 1, &ka.to_bytes(), &rp);
        let r_b1 = cb.record(WideKind::Resolve, 1, &kb.to_bytes(), &rp);
        let m_a = ca.record(WideKind::Muster, 2, &host_key(&ha, ka), &mp);
        let m_b = cb.record(WideKind::Muster, 2, &host_key(&hb, kb), &mp);
        // a second holding of province A: it shares A's province chain
        ca2.province = ca.province;
        let m_a2 = ca2.record(WideKind::Muster, 2, &host_key(&ha2, ka), &mp);
        ca.province = ca2.province;
        let d_a = ca.record(
            WideKind::Dissolve,
            3,
            &host_key(&ha, ka),
            &dissolve_payload(3, 300_000, 0),
        );
        let d_b = cb.record(
            WideKind::Dissolve,
            3,
            &host_key(&hb, kb),
            &dissolve_payload(3, 300_000, 0),
        );
        let log: Vec<&[u8]> = vec![&r_a1, &r_b1, &m_a, &m_b, &m_a2, &d_a, &d_b];
        let zero = (0, [0; 32]);
        assert_eq!(
            verify_chain(WideTarget::Province(ka), zero, log.iter().copied()),
            Ok(ca.province)
        );
        assert_eq!(ca.province.0, 4, "resolve, muster, muster, dissolve");
        assert_eq!(
            verify_chain(WideTarget::Province(kb), zero, log.iter().copied()),
            Ok(cb.province)
        );
        assert_eq!(cb.province.0, 3);
        assert_eq!(
            verify_chain(WideTarget::Holding(ha), zero, log.iter().copied()),
            Ok(ca.holding)
        );
        assert_eq!(ca.holding.0, 2);
        assert_eq!(
            verify_chain(WideTarget::Holding(hb), zero, log.iter().copied()),
            Ok(cb.holding)
        );
        assert_eq!(
            verify_chain(WideTarget::Holding(ha2), zero, log.iter().copied()),
            Ok(ca2.holding)
        );
        assert_eq!(ca2.holding.0, 1);
        // B's records alone never advance A: a log of B only leaves A at zero
        let only_b: Vec<&[u8]> = vec![&r_b1, &m_b, &d_b];
        assert_eq!(
            verify_chain(WideTarget::Province(ka), zero, only_b.iter().copied()),
            Ok(zero)
        );
        assert_eq!(
            verify_chain(WideTarget::Holding(ha), zero, only_b.iter().copied()),
            Ok(zero)
        );
        // a foreign record forged to carry A's exact next link is still
        // skipped (attribution is the key, never the link): A's chain is
        // then broken at the record that follows
        let forged_bwt = {
            let mut b = [0u8; MAX_BODY];
            let n = write_body(WideKind::Resolve, 1, &kb.to_bytes(), &rp, &mut b).unwrap();
            b[..n].to_vec()
        };
        let a_next = advance(WideEntity::Province, 0, &[0; 32], &forged_bwt).unwrap();
        let foreign = encode(WideKind::Resolve, 1, &kb.to_bytes(), &rp, &[a_next]).unwrap();
        let with_foreign: Vec<&[u8]> = vec![&foreign, &m_a];
        assert!(matches!(
            verify_chain(WideTarget::Province(ka), zero, with_foreign.iter().copied()),
            Err(EventError::Chain {
                entity: WideEntity::Province,
                seq: 0
            })
        ));
        // A's own record carrying B's link is refused as A's
        let r_a_with_b_link = {
            let mut b = [0u8; MAX_BODY];
            let n = write_body(WideKind::Resolve, 1, &ka.to_bytes(), &rp, &mut b).unwrap();
            let l = WideRecord::decode(&r_b1)
                .unwrap()
                .link(WideEntity::Province)
                .unwrap();
            let m = write_tail(WideKind::Resolve, &[l], &mut b, n).unwrap();
            b[..m].to_vec()
        };
        let swapped: Vec<&[u8]> = vec![&r_a_with_b_link];
        assert_eq!(
            verify_chain(WideTarget::Province(ka), zero, swapped.iter().copied()),
            Err(EventError::Chain {
                entity: WideEntity::Province,
                seq: 0
            })
        );
    }
}
