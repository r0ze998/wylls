//! Closed failure draft, not a member/camp version or allocated instruction.
//! Only destroyed resolved members with an absent canonical slot are supported
//! by its private runtime consumer. All economic/proof checks happen there.
use super::{expedition_settlement_ix as member, seal::WIDE_SEAL_LEN};
use crate::error::FrontierError;
pub const MAGIC: [u8; 4] = [0xff, b'F', b'S', 1];
pub const DRAFT_LEN: usize = 301;
pub const ACCOUNT_COUNT: usize = 14;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;
/// Same explicit current-generation role order as the member table, not its
/// wire or receipt contract. PREV_HOME and retained-slot claims are unsupported.
pub const ACCOUNT_LAYOUT: member::AccountLayout = member::AccountLayout::Current;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DraftCommand(member::DraftCommand);
impl DraftCommand {
    pub fn new(
        slot: u8,
        commit: [u8; 32],
        seal: [u8; WIDE_SEAL_LEN],
    ) -> Result<Self, FrontierError> {
        Ok(Self(member::DraftCommand::new(slot, commit, seal)?))
    }
    pub fn slot(&self) -> u8 {
        self.0.slot()
    }
    pub fn commit(&self) -> &[u8; 32] {
        self.0.commit()
    }
    pub fn seal(&self) -> &[u8; WIDE_SEAL_LEN] {
        self.0.seal()
    }
    pub fn to_bytes(&self) -> [u8; DRAFT_LEN] {
        let mut b = [0; DRAFT_LEN];
        b[..4].copy_from_slice(&MAGIC);
        b[4] = self.slot();
        b[5..37].copy_from_slice(self.commit());
        b[37..].copy_from_slice(self.seal());
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self, FrontierError> {
        if b.len() != DRAFT_LEN || b[..4] != MAGIC {
            return Err(FrontierError::BadData);
        }
        Self::new(
            b[4],
            b[5..37].try_into().unwrap(),
            b[37..].try_into().unwrap(),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_wire_is_closed_exact_and_disjoint() {
        let d = DraftCommand::new(2, [1; 32], [0; WIDE_SEAL_LEN]).unwrap();
        let b = d.to_bytes();
        assert_eq!(DraftCommand::decode(&b), Ok(d));
        assert!(!PUBLIC_DISPATCH_AVAILABLE);
        assert!(crate::tags::Ix::from_tag(b[0]).is_none());
        assert!(crate::v2::ix::tag_of(&b).is_err());
        assert!(super::super::wide_ix::WideCommand::decode(&b).is_err());
        assert!(member::DraftCommand::decode(&b).is_err());
        assert!(member::camp_v2::DraftCommand::decode(&b).is_err());
        assert!(DraftCommand::decode(&d.0.to_bytes()).is_err());
        for i in 0..5 {
            let mut corrupt = b;
            corrupt[i] ^= 0xff;
            assert!(DraftCommand::decode(&corrupt).is_err());
        }
        assert!(DraftCommand::decode(&b[..300]).is_err());
        let mut long = b.to_vec();
        long.push(0);
        assert!(DraftCommand::decode(&long).is_err());
    }
}
