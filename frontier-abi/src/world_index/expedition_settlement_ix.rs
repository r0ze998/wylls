//! Isolated proposal for resolved original-to-wide member settlement.
//!
//! This unallocated envelope is not recognized by WideCommand, v2 or
//! ResidentAct. Its private consumer must reopen the committed seal against
//! the canonical anchor and authenticate the original stored transport in the
//! same call. Bytes, account roles and a decoded draft prove none of that.
use super::seal::WIDE_SEAL_LEN;
use super::wide_ix::{ENVELOPE_ESCAPE, ENVELOPE_VERSION, TAG_SETTLE_TICKET};
use crate::error::FrontierError;
use crate::prologue::{Acc, Group, Spec, Wr};

/// Separate camp schema, not an operation in the member/v1 envelope.
#[path = "expedition_camp_settlement_ix.rs"]
pub mod camp_v2;

pub const SETTLE_MEMBER_OP: u8 = 13;
pub const PAYLOAD_LEN: usize = 1 + 32 + WIDE_SEAL_LEN;
pub const DRAFT_LEN: usize = 4 + PAYLOAD_LEN;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;
const _: () = assert!(DRAFT_LEN == 301);

const fn spec(name: &'static str, signer: bool, wr: Wr) -> Spec {
    Spec {
        name,
        acc: Acc::Any,
        signer,
        wr,
    }
}
/// Exactly the existing private consumer's minimum flags. Read roles may
/// carry elevated runtime flags, as before; signatures are still unverified.
pub const SETTLE_MEMBER: &[Group] = &[
    Group {
        specs: &[
            spec("season", false, Wr::R),
            spec("holding", false, Wr::W),
            spec("external", false, Wr::W),
            spec("home", false, Wr::W),
            spec("destination", false, Wr::W),
            spec("inputs", false, Wr::W),
            spec("slot", false, Wr::W),
            spec("external_rent_to", false, Wr::W),
        ],
        min: 1,
        max: 1,
    },
    Group {
        specs: &[spec("previous_home", false, Wr::W)],
        min: 0,
        max: 1,
    },
    Group {
        specs: &[
            spec("anchor_or_archive", false, Wr::R),
            spec("payer", true, Wr::W),
            spec("slot_beneficiary", false, Wr::W),
            spec("resolver", false, Wr::W),
            spec("holding_rent_payer", false, Wr::W),
            spec("settle_beneficiary", false, Wr::W),
        ],
        min: 1,
        max: 1,
    },
];

/// The optional historical Holding is selected only by the exact account
/// count, never by a wire field or caller-supplied split offset. Whether that
/// Holding is required is authenticated from current account history later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountLayout {
    Current,
    Previous,
}
impl AccountLayout {
    pub fn from_count(count: usize) -> Result<Self, FrontierError> {
        match count {
            14 => Ok(Self::Current),
            15 => Ok(Self::Previous),
            _ => Err(FrontierError::TooManyAccounts),
        }
    }
    pub const fn base(self) -> usize {
        match self {
            Self::Current => 8,
            Self::Previous => 9,
        }
    }
    pub const fn count(self) -> usize {
        self.base() + 6
    }
    pub const fn counts(self) -> [u8; 3] {
        [
            1,
            match self {
                Self::Current => 0,
                Self::Previous => 1,
            },
            1,
        ]
    }
    pub fn spec(self, index: usize) -> Option<&'static Spec> {
        if index < 8 {
            return SETTLE_MEMBER[0].specs.get(index);
        }
        if self == Self::Previous && index == 8 {
            return SETTLE_MEMBER[1].specs.first();
        }
        SETTLE_MEMBER[2].specs.get(index.checked_sub(self.base())?)
    }
    /// Public-key portion of the existing runtime alias policy. Storage
    /// identity, ownership and effective flags still need runtime checks.
    pub fn roles_may_alias(self, i: usize, j: usize) -> bool {
        if i >= self.count() || j >= self.count() {
            return false;
        }
        if i == j {
            return true;
        }
        let structural = |n| n < 7 || (self == Self::Previous && n == 8) || n == self.base();
        let exclusive = |n| matches!(n, 0 | 2 | 6) || n == self.base();
        !(structural(i) && structural(j) || exclusive(i) || exclusive(j))
    }
}

/// Opaque existing public commitment/ciphertext, not proof or an effect plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DraftCommand {
    slot: u8,
    commit: [u8; 32],
    seal: [u8; WIDE_SEAL_LEN],
}
impl DraftCommand {
    pub fn new(
        slot: u8,
        commit: [u8; 32],
        seal: [u8; WIDE_SEAL_LEN],
    ) -> Result<Self, FrontierError> {
        if slot as usize >= crate::layout::player::holding::TRANSIT_N {
            return Err(FrontierError::BadData);
        }
        Ok(Self { slot, commit, seal })
    }
    pub const fn slot(&self) -> u8 {
        self.slot
    }
    pub const fn commit(&self) -> &[u8; 32] {
        &self.commit
    }
    pub const fn seal(&self) -> &[u8; WIDE_SEAL_LEN] {
        &self.seal
    }
    pub const fn public_dispatch_available(&self) -> bool {
        PUBLIC_DISPATCH_AVAILABLE
    }
    pub const fn class(&self) -> crate::tags::Class {
        crate::tags::Class::D
    }
    pub fn to_bytes(&self) -> [u8; DRAFT_LEN] {
        let mut out = [0; DRAFT_LEN];
        out[..4].copy_from_slice(&[
            TAG_SETTLE_TICKET,
            ENVELOPE_ESCAPE,
            ENVELOPE_VERSION,
            SETTLE_MEMBER_OP,
        ]);
        out[4] = self.slot;
        out[5..37].copy_from_slice(&self.commit);
        out[37..].copy_from_slice(&self.seal);
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, FrontierError> {
        if bytes.len() != DRAFT_LEN
            || bytes[..4]
                != [
                    TAG_SETTLE_TICKET,
                    ENVELOPE_ESCAPE,
                    ENVELOPE_VERSION,
                    SETTLE_MEMBER_OP,
                ]
        {
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
    use alloc::vec::Vec;
    #[test]
    fn closed_member_wire_is_exact_opaque_and_not_publicly_admitted() {
        let command = DraftCommand::new(2, [17; 32], [29; WIDE_SEAL_LEN]).unwrap();
        let bytes = command.to_bytes();
        assert_eq!(&bytes[..5], &[0xDC, 0xFF, 1, 13, 2]);
        assert_eq!(DraftCommand::decode(&bytes).unwrap(), command);
        assert!(!command.public_dispatch_available());
        assert!(super::super::wide_ix::WideCommand::decode(&bytes).is_err());
        assert!(crate::v2::ix::tag_of(&bytes).is_err());
        let mut wrapped = [0; DRAFT_LEN + 5];
        let n = super::super::wide_ix::ResidentAct {
            generation: 1,
            inner: &bytes,
        }
        .encode_into(&mut wrapped)
        .unwrap();
        assert!(super::super::wide_ix::ResidentAct::decode(&wrapped[..n]).is_err());
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
        // Ciphertext and commitment shape alone must not claim validity.
        assert!(DraftCommand::new(0, [0; 32], [0; WIDE_SEAL_LEN]).is_ok());
        let mut receipt_body = Vec::new();
        receipt_body.push(command.slot());
        receipt_body.extend_from_slice(command.commit());
        receipt_body.extend_from_slice(command.seal());
        assert_eq!(&bytes[4..], receipt_body.as_slice());
    }
    #[test]
    fn closed_member_roles_pin_existing_fourteen_and_fifteen_positions() {
        for n in 0..32 {
            let Ok(layout) = AccountLayout::from_count(n) else {
                assert!(!matches!(n, 14 | 15));
                continue;
            };
            assert_eq!(layout.count(), n);
            let mut specs = [spec("", false, Wr::R); 15];
            assert_eq!(
                crate::prologue::resolve_in(SETTLE_MEMBER, &layout.counts(), &mut specs),
                Some(n)
            );
            for (i, s) in specs[..n].iter().enumerate() {
                assert_eq!(layout.spec(i), Some(s));
                assert_eq!(s.signer, i == layout.base() + 1);
                assert_eq!(s.wr == Wr::W, i != 0 && i != layout.base());
            }
            assert!(layout.spec(n).is_none());
            assert!(!layout.roles_may_alias(1, 3));
            assert!(!layout.roles_may_alias(2, 7));
            assert!(!layout.roles_may_alias(6, 7));
            assert!(!layout.roles_may_alias(layout.base(), 7));
            assert!(layout.roles_may_alias(1, 7));
            assert!(layout.roles_may_alias(7, layout.base() + 1));
            for i in 0..n {
                for j in 0..n {
                    let structural = |k| k < 7 || (n == 15 && k == 8) || k == layout.base();
                    let exclusive = |k| matches!(k, 0 | 2 | 6) || k == layout.base();
                    let expected =
                        i == j || !(structural(i) && structural(j) || exclusive(i) || exclusive(j));
                    assert_eq!(layout.roles_may_alias(i, j), expected);
                    assert_eq!(layout.roles_may_alias(i, j), layout.roles_may_alias(j, i));
                }
            }
            assert!(!layout.roles_may_alias(n, 0));
            if n == 15 {
                assert_eq!(layout.spec(8).unwrap().name, "previous_home");
            }
        }
    }
}
