//! Explicit host-only expedition execution revision. Not a deployed ABI.
//! Existing class-matching tags carry [tag, 0xff, 2, kind] followed by an
//! exact existing inner command. Legacy/v1 parsers continue to reject this
//! envelope; only expedition-dispatch-experimental may route it. Its Season
//! must have the separate exact PROGRAM_VERSION below. No auth/proof override.
use super::{
    expedition_failure_ix as failure, expedition_forfeit_ix as forfeit,
    expedition_resident_ix as resident, expedition_retained_failure_ix as retained_failure,
    expedition_settlement_ix as settlement, expedition_terminal_ix as terminal, wide_ix as wide,
    WideHostRef,
};
use crate::error::FrontierError;
use alloc::vec::Vec;

pub const VERSION: u8 = 2;
/// Provisional host-only revision bit, separate from 0x1000/2000/4000/8000.
pub const VERSION_BIT: u16 = 0x0800;
pub const PROGRAM_VERSION: u16 =
    crate::v2::presets::PROGRAM_VERSION_S1 | wide::WIDE_EXPERIMENTAL_VERSION_BIT | VERSION_BIT;
pub const HEADER_LEN: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Depart = 0,
    SettleOrigin = 1,
    Reveal = 2,
    Gather = 3,
    Dissolve = 4,
    Return = 5,
    SettleMember = 6,
    SettleCamp = 7,
    SettleFailure = 8,
    SettleForfeit = 9,
    CloseTerminal = 10,
    SettleRetainedFailure = 11,
}
impl Kind {
    pub const fn tag(self) -> u8 {
        match self {
            Self::Depart | Self::Dissolve => wide::TAG_DEPART,
            Self::Reveal => wide::TAG_REVEAL,
            Self::CloseTerminal => wide::TAG_CLOSE,
            _ => wide::TAG_SETTLE_TICKET,
        }
    }
    pub const fn season_index(self) -> usize {
        match self {
            Self::Depart | Self::Dissolve => 2,
            Self::SettleOrigin | Self::Reveal | Self::Gather | Self::Return => 1,
            _ => 0,
        }
    }
    fn from_byte(byte: u8) -> Result<Self, FrontierError> {
        Ok(match byte {
            0 => Self::Depart,
            1 => Self::SettleOrigin,
            2 => Self::Reveal,
            3 => Self::Gather,
            4 => Self::Dissolve,
            5 => Self::Return,
            6 => Self::SettleMember,
            7 => Self::SettleCamp,
            8 => Self::SettleFailure,
            9 => Self::SettleForfeit,
            10 => Self::CloseTerminal,
            11 => Self::SettleRetainedFailure,
            _ => return Err(FrontierError::BadData),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Command<'a> {
    kind: Kind,
    inner: &'a [u8],
}
impl<'a> Command<'a> {
    pub const fn kind(&self) -> Kind {
        self.kind
    }
    pub const fn inner(&self) -> &'a [u8] {
        self.inner
    }
    pub fn decode(data: &'a [u8]) -> Result<Self, FrontierError> {
        if data.len() < HEADER_LEN || data[1] != wide::ENVELOPE_ESCAPE || data[2] != VERSION {
            return Err(FrontierError::BadData);
        }
        let kind = Kind::from_byte(data[3])?;
        if data[0] != kind.tag() {
            return Err(FrontierError::BadData);
        }
        let inner = &data[HEADER_LEN..];
        validate(kind, inner)?;
        Ok(Self { kind, inner })
    }
}

/// Explicitly encode the experimental execution revision. This supplies no
/// accounts or authorization and cannot admit either the inner or outer bytes.
pub fn encode(kind: Kind, inner: &[u8]) -> Result<Vec<u8>, FrontierError> {
    validate(kind, inner)?;
    let mut out = Vec::with_capacity(HEADER_LEN + inner.len());
    out.extend_from_slice(&[kind.tag(), wide::ENVELOPE_ESCAPE, VERSION, kind as u8]);
    out.extend_from_slice(inner);
    Ok(out)
}

fn validate(kind: Kind, d: &[u8]) -> Result<(), FrontierError> {
    match kind {
        Kind::Depart => {
            wide::ExpeditionDepart::decode(d)?;
        }
        Kind::SettleOrigin => {
            wide::ExpeditionSettleOrigin::decode(d)?;
        }
        Kind::Reveal => {
            wide::ExpeditionReveal::decode(d)?;
        }
        Kind::Gather => {
            wide::ExpeditionGather::decode(d)?;
        }
        Kind::Dissolve | Kind::Return => {
            let op = if kind == Kind::Dissolve {
                resident::DISSOLVE_OP
            } else {
                resident::RETURN_OP
            };
            if d.len() != resident::DRAFT_LEN
                || d[..4]
                    != [
                        kind.tag(),
                        wide::ENVELOPE_ESCAPE,
                        wide::ENVELOPE_VERSION,
                        op,
                    ]
            {
                return Err(FrontierError::BadData);
            }
            WideHostRef::from_bytes(&d[4..]).map_err(|_| FrontierError::BadData)?;
            // Runtime derives context from the actual program/Season before
            // resident::DraftCommand::decode and original-family authentication.
        }
        Kind::SettleMember => {
            settlement::DraftCommand::decode(d)?;
        }
        Kind::SettleCamp => {
            settlement::camp_v2::DraftCommand::decode(d)?;
        }
        Kind::SettleFailure => {
            failure::DraftCommand::decode(d)?;
        }
        Kind::SettleForfeit => {
            forfeit::DraftCommand::decode(d)?;
        }
        Kind::CloseTerminal => {
            terminal::DraftCommand::decode(d)?;
        }
        Kind::SettleRetainedFailure => {
            retained_failure::DraftCommand::decode(d)?;
        }
    }
    Ok(())
}
