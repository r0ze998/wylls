//! Closed camp-settlement proposal. This is not an allocated instruction.
//! The leading 0xff is unknown to current instruction parsers; the full magic
//! and schema version must match this private consumer. No v1 operation number
//! or envelope version is repurposed. Authentication still happens at runtime.
use super::{spec, AccountLayout as MemberLayout, DraftCommand as MemberCommand};
use crate::{
    error::FrontierError,
    prologue::{Spec, Wr},
    world_index::seal::WIDE_SEAL_LEN,
};

pub const VERSION: u8 = 2;
pub const MAGIC: [u8; 4] = [0xff, b'C', b'S', VERSION];
pub const DRAFT_LEN: usize = super::DRAFT_LEN;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;
const CITIZEN: Spec = spec("original_citizen", false, Wr::W);

/// The v1 roles in their unchanged order, then one distinct writable Citizen.
/// Exact count determines PREV_HOME; no caller supplies a split offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountLayout(MemberLayout);
impl AccountLayout {
    pub fn from_count(count: usize) -> Result<Self, FrontierError> {
        Ok(Self(MemberLayout::from_count(
            count.checked_sub(1).ok_or(FrontierError::TooManyAccounts)?,
        )?))
    }
    pub const fn base(self) -> usize {
        self.0.base()
    }
    pub const fn count(self) -> usize {
        self.0.count() + 1
    }
    pub const fn citizen(self) -> usize {
        self.0.count()
    }
    pub fn spec(self, index: usize) -> Option<&'static Spec> {
        if index == self.citizen() {
            Some(&CITIZEN)
        } else {
            self.0.spec(index)
        }
    }
    pub fn roles_may_alias(self, i: usize, j: usize) -> bool {
        if i >= self.count() || j >= self.count() {
            return false;
        }
        if i == j {
            return true;
        }
        i != self.citizen() && j != self.citizen() && self.0.roles_may_alias(i, j)
    }
}

/// Opaque public commitment/ciphertext only. No outcome, loot or owner claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DraftCommand(MemberCommand);
impl DraftCommand {
    pub fn new(
        slot: u8,
        commit: [u8; 32],
        seal: [u8; WIDE_SEAL_LEN],
    ) -> Result<Self, FrontierError> {
        Ok(Self(MemberCommand::new(slot, commit, seal)?))
    }
    pub const fn slot(&self) -> u8 {
        self.0.slot()
    }
    pub const fn commit(&self) -> &[u8; 32] {
        self.0.commit()
    }
    pub const fn seal(&self) -> &[u8; WIDE_SEAL_LEN] {
        self.0.seal()
    }
    pub const fn public_dispatch_available(&self) -> bool {
        PUBLIC_DISPATCH_AVAILABLE
    }
    pub const fn class(&self) -> crate::tags::Class {
        crate::tags::Class::D
    }
    pub fn to_bytes(&self) -> [u8; DRAFT_LEN] {
        let mut out = [0; DRAFT_LEN];
        out[..4].copy_from_slice(&MAGIC);
        out[4] = self.slot();
        out[5..37].copy_from_slice(self.commit());
        out[37..].copy_from_slice(self.seal());
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, FrontierError> {
        if bytes.len() != DRAFT_LEN || bytes[..4] != MAGIC {
            return Err(FrontierError::BadData);
        }
        Self::new(
            bytes[4],
            bytes[5..37].try_into().unwrap(),
            bytes[37..].try_into().unwrap(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn camp_schema_is_exact_and_disjoint_from_all_existing_instruction_parsers() {
        let command = DraftCommand::new(2, [17; 32], [29; WIDE_SEAL_LEN]).unwrap();
        let bytes = command.to_bytes();
        assert_eq!(&bytes[..5], &[0xff, b'C', b'S', 2, 2]);
        assert_eq!(DraftCommand::decode(&bytes).unwrap(), command);
        assert!(!command.public_dispatch_available());
        assert!(crate::tags::Ix::from_tag(bytes[0]).is_none());
        assert!(crate::v2::ix::tag_of(&bytes).is_err());
        assert!(crate::world_index::wide_ix::WideCommand::decode(&bytes).is_err());
        assert!(MemberCommand::decode(&bytes).is_err());
        let member = MemberCommand::new(2, [17; 32], [29; WIDE_SEAL_LEN])
            .unwrap()
            .to_bytes();
        assert!(DraftCommand::decode(&member).is_err());
        assert_eq!(&bytes[4..], &member[4..]);
        let mut wrapped = [0; DRAFT_LEN + 5];
        let n = crate::world_index::wide_ix::ResidentAct {
            generation: 1,
            inner: &bytes,
        }
        .encode_into(&mut wrapped)
        .unwrap();
        assert!(crate::world_index::wide_ix::ResidentAct::decode(&wrapped[..n]).is_err());
        for n in 0..DRAFT_LEN {
            assert!(DraftCommand::decode(&bytes[..n]).is_err());
        }
        let mut long = bytes.to_vec();
        long.push(0);
        assert!(DraftCommand::decode(&long).is_err());
        for i in 0..5 {
            let mut bad = bytes;
            bad[i] = if i == 4 { 4 } else { bad[i] ^ 1 };
            assert!(DraftCommand::decode(&bad).is_err());
        }
    }
    #[test]
    fn camp_roles_require_distinct_citizen_for_exact_fifteen_or_sixteen_accounts() {
        for n in 0..32 {
            let Ok(layout) = AccountLayout::from_count(n) else {
                assert!(!matches!(n, 15 | 16));
                continue;
            };
            assert_eq!(layout.count(), n);
            assert_eq!(layout.citizen(), n - 1);
            assert_eq!(layout.base(), n - 7);
            for i in 0..n {
                let s = layout.spec(i).unwrap();
                assert_eq!(s.signer, i == layout.base() + 1);
                assert_eq!(s.wr == Wr::W, i != 0 && i != layout.base());
                for j in 0..n {
                    let expected =
                        i == j || (i < n - 1 && j < n - 1 && layout.0.roles_may_alias(i, j));
                    assert_eq!(layout.roles_may_alias(i, j), expected);
                }
            }
            assert_eq!(layout.spec(n - 1).unwrap().name, "original_citizen");
            assert!(layout.spec(n).is_none());
            assert!(!layout.roles_may_alias(n, 0));
        }
    }
}
