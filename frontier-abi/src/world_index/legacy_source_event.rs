//! Experimental, unfinalized PS2 kind 145: a legacy Holding's contribution
//! to a wide conquest operation. No emitter or reader is enabled by this codec.
//!
//! Body: PS2 version/kind/bell (6), bridge version/direction/reserved (4),
//! full source host (56), original Holding address (32), conquest receipt (100),
//! exactly one ordinary PS2 Holding tail (42). The 198-byte hashed portion is
//! an explicit provisional exception to PS2's soft 128-byte body limit. The
//! 240-byte complete record fits the existing wide observer maximum.
//! PS2's ABI decoders impose exact per-kind widths, not a 128-byte hard cap.
//! The current program's `events::MAX_RECORD` is 800, but its v2 width table
//! ends at 134 and cannot emit this kind. The fclient PS2 and typed readers
//! reject 145 before payload parsing. Future integration must add an explicit
//! bounded bridge emitter (at least BODY_LEN bytes), authenticated chain write,
//! reader dispatch, merged history verification and buffer/coverage tests before
//! emission. A PSW1 size check alone does not establish that integration is safe.
//!
//! This is NOT a PSW1 record: use PS2's existing hash and entity 5, continuing
//! the source's existing sequence/head without resetting or replacing it.
//! Old strict PS2 readers must reject kind 145. Future readers must merge
//! ordinary PS2 and these records into ONE source chain before checking coverage.
//! The receipt must equal its target operation receipt byte for byte. FAILED
//! settlements have no source credit and cannot use this format. Decoding,
//! chaining and pairing prove neither authorization, authenticated provenance,
//! source issuance/generation, target identity within the committed snapshots,
//! completeness, economic effects nor conservation. Runtime/replay must prove
//! those separately, including same-transaction pairing and the source named by
//! the target's authenticated manifest. No public/runtime gate is opened here.

use super::event::{self, conquest, WideKind, WideRecord};
use super::expedition::{AccountFamily, AccountResolver};
use super::WideHostRef;
use crate::log::{self, EntityKind, Link};

pub const KIND: u8 = 145;
pub const BRIDGE_VERSION: u8 = 1;
pub const BODY_WITHOUT_TAIL_LEN: usize = 198;
pub const BODY_LEN: usize = BODY_WITHOUT_TAIL_LEN + 1 + log::LINK_LEN;
pub const PREFIX: &[u8; 3] = log::PREFIX;
const _: () = assert!(BODY_LEN <= super::event::MAX_BODY);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Direction {
    Debit = 1,
    Credit = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Shape,
    Identity,
    Receipt,
    Chain,
    Pair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceReceipt {
    pub direction: Direction,
    pub bell: u32,
    pub source: WideHostRef,
    pub source_address: [u8; 32],
    pub receipt: conquest::Receipt,
}

impl SourceReceipt {
    pub fn validate(&self, resolver: &AccountResolver) -> Result<(), Error> {
        if resolver
            .family(self.source.key())
            .map_err(|_| Error::Identity)?
            != AccountFamily::Legacy
            || resolver
                .holding_address(&self.source)
                .map_err(|_| Error::Identity)?
                != self.source_address
        {
            return Err(Error::Identity);
        }
        conquest::Receipt::decode(&self.receipt.encode()).map_err(|_| Error::Receipt)?;
        let valid = match self.direction {
            Direction::Debit => self.receipt.action == conquest::DECLARE,
            Direction::Credit => matches!(self.receipt.action, conquest::LAPSE | conquest::CAPTURE),
        };
        if !valid {
            return Err(Error::Receipt);
        }
        Ok(())
    }

    fn body(&self, resolver: &AccountResolver) -> Result<[u8; BODY_WITHOUT_TAIL_LEN], Error> {
        self.validate(resolver)?;
        let mut out = [0; BODY_WITHOUT_TAIL_LEN];
        out[0] = log::VERSION;
        out[1] = KIND;
        out[2..6].copy_from_slice(&self.bell.to_le_bytes());
        out[6] = BRIDGE_VERSION;
        out[7] = self.direction as u8;
        out[10..66].copy_from_slice(&self.source.to_bytes());
        out[66..98].copy_from_slice(&self.source_address);
        out[98..198].copy_from_slice(&self.receipt.encode());
        Ok(out)
    }

    /// Pure preparation only. The caller must authenticate the original source
    /// header, commit effects atomically, and emit under the PS2 channel.
    pub fn prepare(
        &self,
        resolver: &AccountResolver,
        previous_seq: u64,
        previous_head: &[u8; 32],
    ) -> Result<([u8; BODY_LEN], Link), Error> {
        let body = self.body(resolver)?;
        let link = log::advance(EntityKind::Holding, previous_seq, previous_head, &body)
            .ok_or(Error::Chain)?;
        let mut out = [0; BODY_LEN];
        out[..198].copy_from_slice(&body);
        out[198] = 1;
        out[199] = EntityKind::Holding as u8;
        out[200..208].copy_from_slice(&link.seq.to_le_bytes());
        out[208..240].copy_from_slice(&link.head);
        Ok((out, link))
    }

    /// Structural pairing, not provenance: target identity/source membership
    /// must additionally be verified against authenticated operation inputs.
    pub fn pair_target(
        &self,
        resolver: &AccountResolver,
        target: &WideRecord<'_>,
    ) -> Result<(), Error> {
        self.validate(resolver)?;
        // WideRecord fields are public. Reconstruct and decode to reject a
        // caller-mutated kind/key/payload/tail or a mismatching hashed body.
        // This is structural validation, not authentication of these links.
        let links: alloc::vec::Vec<_> = target.links.iter().flatten().copied().collect();
        let encoded = event::encode(target.kind, target.bell, target.key, target.payload, &links)
            .ok_or(Error::Pair)?;
        if WideRecord::decode(&encoded).map_err(|_| Error::Pair)? != *target {
            return Err(Error::Pair);
        }
        let expected = match (self.direction, self.receipt.action) {
            (Direction::Debit, conquest::DECLARE) => WideKind::ConquestDeclared,
            (Direction::Credit, conquest::LAPSE) => WideKind::ConquestSettled,
            (Direction::Credit, conquest::CAPTURE) => WideKind::ConquestCaptured,
            _ => return Err(Error::Pair),
        };
        let key = target.province_of().ok_or(Error::Pair)?;
        if target.kind != expected
            || target.bell != self.bell
            || resolver.family(key).map_err(|_| Error::Pair)? != AccountFamily::Wide
            || target.payload != self.receipt.encode()
        {
            return Err(Error::Pair);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub source: SourceReceipt,
    pub link: Link,
}
impl Record {
    pub fn decode(resolver: &AccountResolver, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != BODY_LEN
            || bytes[0] != log::VERSION
            || bytes[1] != KIND
            || bytes[6] != BRIDGE_VERSION
            || bytes[8..10] != [0, 0]
            || bytes[198] != 1
            || bytes[199] != EntityKind::Holding as u8
        {
            return Err(Error::Shape);
        }
        let direction = match bytes[7] {
            1 => Direction::Debit,
            2 => Direction::Credit,
            _ => return Err(Error::Shape),
        };
        let source = SourceReceipt {
            direction,
            bell: u32::from_le_bytes(bytes[2..6].try_into().unwrap()),
            source: WideHostRef::from_bytes(&bytes[10..66]).map_err(|_| Error::Identity)?,
            source_address: bytes[66..98].try_into().unwrap(),
            receipt: conquest::Receipt::decode(&bytes[98..198]).map_err(|_| Error::Receipt)?,
        };
        source.validate(resolver)?;
        let link = Link {
            entity: EntityKind::Holding,
            seq: u64::from_le_bytes(bytes[200..208].try_into().unwrap()),
            head: bytes[208..240].try_into().unwrap(),
        };
        if link.seq == 0 {
            return Err(Error::Chain);
        }
        Ok(Self { source, link })
    }

    /// The prior header must be obtained from this exact source's verified
    /// combined legacy history, never a fresh bridge-only cursor.
    pub fn verify_previous(
        &self,
        resolver: &AccountResolver,
        previous_seq: u64,
        previous_head: &[u8; 32],
    ) -> Result<(), Error> {
        let (_, expected) = self.source.prepare(resolver, previous_seq, previous_head)?;
        if self.link != expected {
            return Err(Error::Chain);
        }
        Ok(())
    }
}
