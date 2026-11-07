//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **versioned wide event record** and its chain commitment — what the
//! experimental wide handlers log and how the wide accounts' event chains
//! advance. It is a format of its own, not an extension of the deployed
//! PS2 log: a wide record is logged under the prefix [`WIDE_LOG_PREFIX`]
//! (`PSW1`, never `PS2`), its body starts with the version byte
//! [`WIDE_EVENT_VERSION`] (0x81, which the deployed decoders refuse as an
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
//! | 1 `Muster` | host ref | `unit u8, troops u32 (whole), tile u8, entry u8, alias u64` | Province, Holding |
//! | 2 `Dissolve` | host ref | `pend_bell u32, troops u32 (milli), entry u8` | Province, Holding |
//! | 3 `Resolve` | province key | `input_digest [32], output_digest [32], engagements u32, destroyed u8, bounced u8, settled u8` | Province |
//! | 4 `Return` | host ref | `credited u32 (milli, once), unit u8, entry u8` | Province, Holding |
//! | 5 `Stranded` | host ref | `troops_lost u32 (milli), entry u8` | Province |
//! | 6 `RosterClosed` | province key | `rent_to [32], lamports u64` | none |
//!
//! **Attribution.** A record concerns exactly one province and at most one
//! holding, derived from its full key and never from the packed alias: a
//! host-keyed record's province is the host's **home** province
//! (`WideHostRef::key`; the closed path is local, a host stands in its
//! home province) and its holding is the host's issuing holding
//! (`WideHostRef::holding_ref`: site and generation, sequence 0); a
//! province-keyed record's province is its key. [`verify_chain`] consumes
//! a record only when its attribution is the target: a record of another
//! province or holding, even with a plausible link, is skipped, and a
//! record attributed to the target must carry the target's link.
//!
//! **The resolve's digests.** [`resolve_input_digest`] commits to the
//! province key, the bell, the bell seed, the **authenticated Season bytes
//! whole** (the status, the ruleset hash, the program version with the
//! wide bit, the clock the seed round comes from, the conquest block the
//! step parameters come from) and the province and roster bytes as read;
//! [`resolve_output_digest`] to the kernel outcome's own digest and the
//! province and roster bytes the bell left. Both province digests are over
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
/// version (the deployed decoders refuse it as `Version(0x81)`).
pub const WIDE_EVENT_VERSION: u8 = 0x81;
/// Domain of [`next_head`].
pub const WIDE_CHAIN_DOMAIN: &[u8] = b"PSF-WIDE-CHAIN-v1";
/// Domain of [`resolve_input_digest`].
pub const RESOLVE_INPUT_DOMAIN: &[u8] = b"PSF-WIDE-RESOLVE-INPUT-v2";
/// Domain of [`resolve_output_digest`].
pub const RESOLVE_OUTPUT_DOMAIN: &[u8] = b"PSF-WIDE-RESOLVE-OUTPUT-v2";
/// `version ‖ kind ‖ bell`.
pub const HEAD_LEN: usize = 6;
/// `entity ‖ seq ‖ head`.
pub const LINK_LEN: usize = 1 + 8 + 32;
/// Entities one record may chain.
pub const MAX_LINKS: usize = 2;
/// The longest body (a Resolve chaining the province).
pub const MAX_BODY: usize = HEAD_LEN + PROVINCE_KEY_LEN + 71 + 1 + MAX_LINKS * LINK_LEN;

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
}

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
            _ => None,
        }
    }

    /// The key: a host reference or a province key.
    pub const fn key_len(self) -> usize {
        match self {
            WideKind::Muster | WideKind::Dissolve | WideKind::Return | WideKind::Stranded => {
                HOST_REF_LEN
            }
            WideKind::Resolve | WideKind::RosterClosed => PROVINCE_KEY_LEN,
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
        }
    }

    /// The exact link set of the kind, in tail order (module doc).
    pub const fn links(self) -> &'static [WideEntity] {
        match self {
            WideKind::Muster | WideKind::Dissolve | WideKind::Return => PROVINCE_AND_HOLDING,
            WideKind::Resolve | WideKind::Stranded => PROVINCE_ONLY,
            WideKind::RosterClosed => NO_LINKS,
        }
    }

    /// A host-keyed kind (the key is a host reference).
    pub const fn host_keyed(self) -> bool {
        self.key_len() == HOST_REF_LEN
    }

    pub const fn name(self) -> &'static str {
        match self {
            WideKind::Muster => "WIDE_MUSTER",
            WideKind::Dissolve => "WIDE_DISSOLVE",
            WideKind::Resolve => "WIDE_RESOLVE",
            WideKind::Return => "WIDE_RETURN",
            WideKind::Stranded => "WIDE_STRANDED",
            WideKind::RosterClosed => "WIDE_ROSTER_CLOSED",
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
            WideHostRef::from_bytes(key).map_err(|_| EventError::Key)?;
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
            WideHostRef::from_bytes(self.key).ok()
        } else {
            None
        }
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
    /// of a province-keyed record, the **home** province of a host-keyed
    /// one. Never derived from the alias.
    pub fn province_of(&self) -> Option<ProvinceKey> {
        match self.host() {
            Some(h) => Some(h.key()),
            None => self.province(),
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
/// before))`: everything the bell model read, under the Season that
/// authenticated it (module doc).
pub fn resolve_input_digest(
    province: ProvinceKey,
    bell: u32,
    seed: &[u8; 32],
    season: &[u8],
    province_before: &[u8],
    roster_before: &[u8],
) -> [u8; 32] {
    sha256(&[
        RESOLVE_INPUT_DOMAIN,
        &province.to_bytes(),
        &bell.to_le_bytes(),
        seed,
        &sha256(&[season]),
        &sha256(&[&normalize_chained(province_before)]),
        &sha256(&[roster_before]),
    ])
}

/// `sha256(domain ‖ clash digest ‖ sha256(normalized province bytes after)
/// ‖ sha256(roster bytes after))`: the kernel's outcome and the bytes it
/// left, before the record's own link (module doc).
pub fn resolve_output_digest(
    clash_digest: &[u8; 32],
    province_after: &[u8],
    roster_after: &[u8],
) -> [u8; 32] {
    sha256(&[
        RESOLVE_OUTPUT_DOMAIN,
        clash_digest,
        &sha256(&[&normalize_chained(province_after)]),
        &sha256(&[roster_after]),
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
            &host().to_bytes(),
            &muster_payload(0, 300, 17, 0, 0x8000_0000_0000_0001),
        );
        let s = c.record(
            WideKind::Stranded,
            2,
            &host().to_bytes(),
            &stranded_payload(300_000, 0),
        );
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
        let body = c.record(WideKind::Muster, 4, &host().to_bytes(), &payload);
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
        assert_eq!(body[0], 0x81);
        assert_eq!(body[1], 1);
        assert_eq!(body.len(), HEAD_LEN + HOST_REF_LEN + 15 + 1 + 2 * LINK_LEN);
        let r = WideRecord::decode(&body).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Muster, 4));
        assert_eq!(r.host(), Some(host()));
        assert_eq!(r.province(), None, "a host key is no province key");
        assert_eq!(
            r.province_of(),
            Some(key()),
            "attributed to the home province"
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
        assert_eq!(
            crate::log::decode(&body).err(),
            Some(crate::log::LogError::Version(0x81))
        );
        assert_eq!(
            crate::v2::log::decode(&body).err(),
            Some(crate::log::LogError::Version(0x81))
        );
        assert_ne!(&WIDE_LOG_PREFIX[..], &crate::log::PREFIX[..]);
        // strictness: a wrong version, kind, key, width, tail or trailing byte
        let mut x = body.clone();
        x[0] = 1;
        assert_eq!(WideRecord::decode(&x), Err(EventError::Version(1)));
        let mut x = body.clone();
        x[1] = 7;
        assert_eq!(WideRecord::decode(&x), Err(EventError::UnknownKind(7)));
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
        let tail = HEAD_LEN + HOST_REF_LEN + 15;
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
        let hk = host().to_bytes();
        let mut buf = [0u8; 128];
        assert!(write_body(WideKind::Muster, 1, &hk, &[0; 14], &mut buf).is_none());
        assert!(write_body(WideKind::Resolve, 1, &hk, &[0; 71], &mut buf).is_none());
        for k in [
            WideKind::Muster,
            WideKind::Dissolve,
            WideKind::Resolve,
            WideKind::Return,
            WideKind::Stranded,
            WideKind::RosterClosed,
        ] {
            assert_eq!(WideKind::from_u8(k as u8), Some(k));
            assert!(k.name().starts_with("WIDE_"));
            assert!(
                HEAD_LEN + k.key_len() + k.payload_len() + 1 + MAX_LINKS * LINK_LEN <= MAX_BODY
            );
        }
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

    /// The tail is exactly the kind's link set: a missing, an extra or a
    /// wrong link refuses, at encoding and at decoding.
    #[test]
    fn link_sets_are_exact_per_kind() {
        let hk = host().to_bytes();
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
        // the accepted sets
        assert!(encode(WideKind::Muster, 1, &hk, &mp, &[p, h]).is_some());
        assert!(encode(WideKind::Dissolve, 1, &hk, &dp, &[p, h]).is_some());
        assert!(encode(WideKind::Return, 1, &hk, &retp, &[p, h]).is_some());
        assert!(encode(WideKind::Resolve, 1, &pk, &rp, &[p]).is_some());
        assert!(encode(WideKind::Stranded, 1, &hk, &sp, &[p]).is_some());
        assert!(encode(WideKind::RosterClosed, 1, &pk, &cp, &[]).is_some());
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
            &host().to_bytes(),
            &muster_payload(0, 300, 17, 0, 1),
        );
        let seed = [0x5a; 32];
        let season = [0x11u8; 64];
        let input = resolve_input_digest(key(), 4, &seed, &season, &[1, 2, 3], &[4, 5]);
        let output = resolve_output_digest(&[9; 32], &[1, 2, 4], &[4, 5]);
        assert_ne!(input, output);
        assert_ne!(
            input,
            resolve_input_digest(key(), 5, &seed, &season, &[1, 2, 3], &[4, 5]),
            "the bell is in the input"
        );
        assert_ne!(
            input,
            resolve_input_digest(key(), 4, &seed, &[0x12; 64], &[1, 2, 3], &[4, 5]),
            "the Season bytes are in the input"
        );
        assert_ne!(
            output,
            resolve_output_digest(&[9; 32], &[1, 2, 3], &[4, 5]),
            "the bytes after are in the output"
        );
        // the normalization: the header's chain fields do not enter either
        let mut pd = alloc::vec![7u8; header::EVENT_HEAD + 40];
        let base = resolve_output_digest(&[9; 32], &pd, &[]);
        pd[header::EVENT_SEQ] = 1;
        pd[header::EVENT_HEAD + 3] = 1;
        assert_eq!(resolve_output_digest(&[9; 32], &pd, &[]), base);
        assert_eq!(
            resolve_input_digest(key(), 4, &seed, &season, &pd, &[]),
            resolve_input_digest(key(), 4, &seed, &season, &normalize_chained(&pd), &[])
        );
        pd[header::EVENT_HEAD + 40 - 1] = 1;
        assert_ne!(
            resolve_output_digest(&[9; 32], &pd, &[]),
            base,
            "a body byte"
        );
        let rp = resolve_payload(&input, &output, 0, 0, 0, true);
        let resolve = c.record(WideKind::Resolve, 4, &key().to_bytes(), &rp);
        let dissolve = c.record(
            WideKind::Dissolve,
            5,
            &host().to_bytes(),
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
        let m_a = ca.record(WideKind::Muster, 2, &ha.to_bytes(), &mp);
        let m_b = cb.record(WideKind::Muster, 2, &hb.to_bytes(), &mp);
        // a second holding of province A: it shares A's province chain
        ca2.province = ca.province;
        let m_a2 = ca2.record(WideKind::Muster, 2, &ha2.to_bytes(), &mp);
        ca.province = ca2.province;
        let d_a = ca.record(
            WideKind::Dissolve,
            3,
            &ha.to_bytes(),
            &dissolve_payload(3, 300_000, 0),
        );
        let d_b = cb.record(
            WideKind::Dissolve,
            3,
            &hb.to_bytes(),
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
