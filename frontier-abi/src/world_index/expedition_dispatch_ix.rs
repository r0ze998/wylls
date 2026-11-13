//! Explicit host-only expedition execution revision. Not a deployed ABI.
//! Existing class-matching tags carry [tag, 0xff, 2, kind] followed by an
//! exact existing inner command. Legacy/v1 parsers continue to reject this
//! envelope; only expedition-dispatch-experimental may route it. Its Season
//! must have the separate exact PROGRAM_VERSION below. No auth/proof override.
//!
//! With `conquest-dispatch-experimental` (host and the isolated localnet
//! conquest lane only) kinds 12–17 carry the six EXISTING Free City
//! lifecycle commands, each under its own class tag and exact codec:
//! DeclareSiege (0xDA), ResolveWithConquest and SettleCapture (0xDC),
//! SettleSiege, CloseConquest and CloseCaptureEscrow (0xDE). Without the
//! feature they are `BadData`, exactly as before. No new inner command,
//! operation number, outcome, gate or rule.
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
    #[cfg(feature = "conquest-dispatch-experimental")]
    DeclareSiege = 12,
    #[cfg(feature = "conquest-dispatch-experimental")]
    ResolveWithConquest = 13,
    #[cfg(feature = "conquest-dispatch-experimental")]
    SettleCapture = 14,
    #[cfg(feature = "conquest-dispatch-experimental")]
    SettleSiege = 15,
    #[cfg(feature = "conquest-dispatch-experimental")]
    CloseConquest = 16,
    #[cfg(feature = "conquest-dispatch-experimental")]
    CloseCaptureEscrow = 17,
    /// The full return of a not-applied siege reservation
    /// (`wide::SettleReservation`, not an existing command).
    #[cfg(feature = "conquest-dispatch-experimental")]
    SettleReservation = 18,
}
impl Kind {
    pub const fn tag(self) -> u8 {
        match self {
            Self::Depart | Self::Dissolve => wide::TAG_DEPART,
            Self::Reveal => wide::TAG_REVEAL,
            Self::CloseTerminal => wide::TAG_CLOSE,
            // each conquest kind carries its inner command's own class tag
            #[cfg(feature = "conquest-dispatch-experimental")]
            Self::DeclareSiege => wide::TAG_DEPART,
            #[cfg(feature = "conquest-dispatch-experimental")]
            Self::SettleSiege
            | Self::CloseConquest
            | Self::CloseCaptureEscrow
            | Self::SettleReservation => wide::TAG_CLOSE,
            _ => wide::TAG_SETTLE_TICKET,
        }
    }
    /// The Season's position in the inner command's account table.
    pub const fn season_index(self) -> usize {
        match self {
            Self::Depart | Self::Dissolve => 2,
            Self::SettleOrigin | Self::Reveal | Self::Gather | Self::Return => 1,
            #[cfg(feature = "conquest-dispatch-experimental")]
            Self::DeclareSiege => 2,
            #[cfg(feature = "conquest-dispatch-experimental")]
            Self::ResolveWithConquest
            | Self::SettleCapture
            | Self::SettleSiege
            | Self::CloseConquest
            | Self::CloseCaptureEscrow
            | Self::SettleReservation => 1,
            _ => 0,
        }
    }
    /// The conquest kind carrying an exact existing conquest command
    /// (`None` for every other command).
    #[cfg(feature = "conquest-dispatch-experimental")]
    pub fn of_conquest(inner: &[u8]) -> Option<Self> {
        Some(match wide::WideCommand::decode(inner).ok()? {
            wide::WideCommand::DeclareSiege(_) => Self::DeclareSiege,
            wide::WideCommand::ResolveWithConquest(_) => Self::ResolveWithConquest,
            wide::WideCommand::SettleCapture(_) => Self::SettleCapture,
            wide::WideCommand::SettleSiege(_) => Self::SettleSiege,
            wide::WideCommand::CloseConquest(_) => Self::CloseConquest,
            wide::WideCommand::CloseCaptureEscrow(_) => Self::CloseCaptureEscrow,
            _ => return None,
        })
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
            #[cfg(feature = "conquest-dispatch-experimental")]
            12 => Self::DeclareSiege,
            #[cfg(feature = "conquest-dispatch-experimental")]
            13 => Self::ResolveWithConquest,
            #[cfg(feature = "conquest-dispatch-experimental")]
            14 => Self::SettleCapture,
            #[cfg(feature = "conquest-dispatch-experimental")]
            15 => Self::SettleSiege,
            #[cfg(feature = "conquest-dispatch-experimental")]
            16 => Self::CloseConquest,
            #[cfg(feature = "conquest-dispatch-experimental")]
            17 => Self::CloseCaptureEscrow,
            #[cfg(feature = "conquest-dispatch-experimental")]
            18 => Self::SettleReservation,
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
        // the exact existing codecs (envelope, op, version, length)
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::DeclareSiege => {
            wide::DeclareSiege::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::ResolveWithConquest => {
            wide::ResolveWithConquest::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::SettleCapture => {
            wide::SettleCapture::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::SettleSiege => {
            wide::SettleSiege::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::CloseConquest => {
            wide::CloseConquest::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::CloseCaptureEscrow => {
            wide::CloseCaptureEscrow::decode(d)?;
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        Kind::SettleReservation => {
            wide::SettleReservation::decode(d)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod conquest_kind_tests {
    use super::*;
    use alloc::vec;

    /// One valid inner command per conquest kind (public test values).
    fn inners() -> [(u8, Vec<u8>); 6] {
        [
            (12, wide::DeclareSiege { site: 1, entry: 2 }.to_bytes().to_vec()),
            (13, wide::ResolveWithConquest { bell: 20, beneficiary: [7; 32] }.to_bytes().to_vec()),
            (14, wide::SettleCapture { site: 1 }.to_bytes().to_vec()),
            (15, wide::SettleSiege { site: 1 }.to_bytes().to_vec()),
            (16, wide::CloseConquest { p: 129, q: 0 }.to_bytes().to_vec()),
            (17, wide::CloseCaptureEscrow.to_bytes().to_vec()),
        ]
    }
    fn outer(kind: u8, inner: &[u8]) -> Vec<u8> {
        let mut d = vec![inner[0], wide::ENVELOPE_ESCAPE, VERSION, kind];
        d.extend_from_slice(inner);
        d
    }

    /// Collision check: no wrapper of kinds 12–17 is itself a valid legacy or
    /// wide command, so the deployed parser's priority cannot reroute it.
    #[test]
    fn conquest_wrappers_are_never_existing_commands() {
        for (k, inner) in inners() {
            assert!(wide::WideCommand::decode(&outer(k, &inner)).is_err(), "kind {k}");
        }
    }

    #[cfg(not(feature = "conquest-dispatch-experimental"))]
    #[test]
    fn without_the_feature_kinds_12_to_17_stay_refused() {
        for (k, inner) in inners() {
            assert_eq!(Command::decode(&outer(k, &inner)).err(), Some(FrontierError::BadData), "kind {k}");
        }
    }

    #[cfg(feature = "conquest-dispatch-experimental")]
    #[test]
    fn conquest_kinds_carry_exact_existing_commands_under_their_own_class_tags() {
        use crate::prologue::position_in;
        let all = [Kind::DeclareSiege, Kind::ResolveWithConquest, Kind::SettleCapture, Kind::SettleSiege, Kind::CloseConquest, Kind::CloseCaptureEscrow];
        for ((k, inner), kind) in inners().into_iter().zip(all) {
            assert_eq!(kind as u8, k);
            // the outer tag is the inner command's own class tag
            assert_eq!(kind.tag(), inner[0], "kind {k} tag");
            let cmd = wide::WideCommand::decode(&inner).unwrap();
            assert_eq!(cmd.ix().tag(), kind.tag(), "kind {k} carrier");
            // the Season position is the inner table's (fewest accounts)
            let g = cmd.accounts();
            let n = crate::prologue::bounds_in(g).0;
            assert_eq!(position_in(g, n, "season", 0), Some(kind.season_index()), "kind {k} season");
            // exact round trip, and the inner command maps back to its kind
            let wire = encode(kind, &inner).unwrap();
            assert_eq!(wire, outer(k, &inner));
            let c = Command::decode(&wire).unwrap();
            assert_eq!((c.kind(), c.inner()), (kind, &inner[..]));
            assert_eq!(Kind::of_conquest(&inner), Some(kind));
            // truncated, extended, wrong version or wrong tag: refused
            assert!(Command::decode(&wire[..wire.len() - 1]).is_err());
            let mut ext = wire.clone();
            ext.push(0);
            assert!(Command::decode(&ext).is_err());
            let mut v = wire.clone();
            v[2] = 1;
            assert!(Command::decode(&v).is_err());
            let mut t = wire.clone();
            t[0] ^= 0x01;
            assert!(Command::decode(&t).is_err());
        }
        // another conquest command under a kind is refused (exact codec per kind)
        let siege = wide::SettleSiege { site: 1 }.to_bytes();
        assert!(encode(Kind::SettleCapture, &siege).is_err());
        assert!(encode(Kind::CloseConquest, &siege).is_err());
        // non-conquest commands have no conquest kind; 19.. stay refused
        assert_eq!(Kind::of_conquest(&wide::Return.to_bytes()), None);
        for k in 19..=255u8 {
            assert!(Kind::from_byte(k).is_err());
        }
    }

    /// Kind 18 carries a NEW codec that no existing parser accepts (neither
    /// the inner nor the wrapper), under the Close class tag.
    #[cfg(feature = "conquest-dispatch-experimental")]
    #[test]
    fn settle_reservation_kind_is_new_and_exact() {
        use crate::prologue::position_in;
        let inner = wide::SettleReservation { seq: 7 }.to_bytes();
        assert!(wide::WideCommand::decode(&inner).is_err());
        assert!(wide::WideCommand::decode(&outer(18, &inner)).is_err());
        assert_eq!(Kind::of_conquest(&inner), None);
        let wire = encode(Kind::SettleReservation, &inner).unwrap();
        assert_eq!(wire, outer(18, &inner));
        let c = Command::decode(&wire).unwrap();
        assert_eq!((c.kind(), c.inner()), (Kind::SettleReservation, &inner[..]));
        assert_eq!(wide::SettleReservation::decode(c.inner()).unwrap().seq, 7);
        let n = crate::prologue::bounds_in(wide::SETTLE_RESERVATION).0;
        assert_eq!(
            position_in(wide::SETTLE_RESERVATION, n, "season", 0),
            Some(Kind::SettleReservation.season_index())
        );
        assert!(Command::decode(&wire[..wire.len() - 1]).is_err());
        let mut ext = wire.clone();
        ext.push(0);
        assert!(Command::decode(&ext).is_err());
        assert!(encode(Kind::SettleReservation, &wide::SettleSiege { site: 1 }.to_bytes()).is_err());
        assert!(encode(Kind::SettleSiege, &inner).is_err());
    }
}
