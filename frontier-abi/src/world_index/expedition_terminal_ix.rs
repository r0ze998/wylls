//! Isolated season-terminal bridge cleanup proposal, never public admission.
//! This returns only the external record's rent. Embedded escrow remains for
//! the existing original CloseHolding rule; no seal outcome is asserted.
use crate::error::FrontierError;
pub const MAGIC: [u8; 4] = [0xff, b'T', b'C', 1];
pub const DRAFT_LEN: usize = 5;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;
/// Exact order: Season readonly; original Holding position writable; owned
/// bridge writable; immutable bridge rent recipient writable. Permissionless.
pub const ACCOUNT_COUNT: usize = 4;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DraftCommand {
    slot: u8,
}
impl DraftCommand {
    pub fn new(slot: u8) -> Result<Self, FrontierError> {
        if slot as usize >= crate::layout::player::holding::TRANSIT_N {
            return Err(FrontierError::BadData);
        }
        Ok(Self { slot })
    }
    pub const fn slot(self) -> u8 {
        self.slot
    }
    pub fn to_bytes(self) -> [u8; DRAFT_LEN] {
        [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], self.slot]
    }
    pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
        if d.len() != DRAFT_LEN || d[..4] != MAGIC {
            return Err(FrontierError::BadData);
        }
        Self::new(d[4])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_wire_is_exact_closed_and_separate_from_settlement() {
        let bytes = DraftCommand::new(2).unwrap().to_bytes();
        assert_eq!(DraftCommand::decode(&bytes).unwrap().slot(), 2);
        assert!(!PUBLIC_DISPATCH_AVAILABLE);
        assert!(crate::tags::Ix::from_tag(bytes[0]).is_none());
        assert!(crate::v2::ix::tag_of(&bytes).is_err());
        assert!(crate::world_index::wide_ix::WideCommand::decode(&bytes).is_err());
        assert!(
            crate::world_index::expedition_settlement_ix::DraftCommand::decode(&bytes).is_err()
        );
        for n in 0..DRAFT_LEN {
            assert!(DraftCommand::decode(&bytes[..n]).is_err());
        }
        let mut long = bytes.to_vec();
        long.push(0);
        assert!(DraftCommand::decode(&long).is_err());
        for i in 0..DRAFT_LEN {
            let mut bad = bytes;
            bad[i] ^= 0x80;
            assert!(DraftCommand::decode(&bad).is_err());
        }
    }
}
