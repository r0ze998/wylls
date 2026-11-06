//! Experimental, feature-gated wire format of the NFT resident instructions.
//! **Provisional**: the tag `0xff` and the sub-codes below are not allocated
//! production ABI; workstream 4 allocates the real tags (proposed
//! 2026-11-06: three v2 tags in a free band, not 0xC1).
//!
//! | sub-code | command | data after `0xff, code` |
//! |---|---|---|
//! | 0 | CreatePolicy | core program, resident program, collection, guard authority (4 × 32) |
//! | 1 | Register (the link only, before the Citizen) | generation u32 |
//! | 2 | Act (an NFT Citizen's player instruction) | generation u32, then the inner v2 instruction data (its own tag first, non-empty) |
//! | 3 | Join (create the link and the Citizen: first login) | generation u32, faction u8 |
//!
//! The generation is the resident program's holder generation the actor
//! signs; the program compares it with the resident account in the same
//! invocation, so a signature made before a transfer never passes after it.
use crate::resident_auth::Policy;

pub const EXPERIMENTAL_TAG: u8 = 0xff;

pub enum Command<'a> {
    CreatePolicy(Policy),
    Register { generation: u32 },
    Act { generation: u32, inner: &'a [u8] },
    Join { generation: u32, faction: u8 },
}

/// Exact lengths only. No defaults, trailing fields or unknown commands.
pub fn decode(bytes: &[u8]) -> Option<Command<'_>> {
    match bytes {
        [EXPERIMENTAL_TAG, 0, rest @ ..] if rest.len() == 128 => {
            Some(Command::CreatePolicy(Policy {
                core_program: rest[0..32].try_into().ok()?,
                resident_program: rest[32..64].try_into().ok()?,
                collection: rest[64..96].try_into().ok()?,
                guard_authority: rest[96..128].try_into().ok()?,
            }))
        }
        [EXPERIMENTAL_TAG, 1, a, b, c, d] => Some(Command::Register {
            generation: u32::from_le_bytes([*a, *b, *c, *d]),
        }),
        // The inner instruction is never another resident command.
        [EXPERIMENTAL_TAG, 2, a, b, c, d, inner @ ..]
            if !inner.is_empty() && inner[0] != EXPERIMENTAL_TAG =>
        {
            Some(Command::Act {
                generation: u32::from_le_bytes([*a, *b, *c, *d]),
                inner,
            })
        }
        [EXPERIMENTAL_TAG, 3, a, b, c, d, faction] => Some(Command::Join {
            generation: u32::from_le_bytes([*a, *b, *c, *d]),
            faction: *faction,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Literal bytes only; no setup, key operations, signing, I/O or network.
    #[test]
    fn strict_registration_wire_rejects_truncation_and_extensions() {
        assert!(crate::v2::Ix::from_tag(EXPERIMENTAL_TAG).is_none());
        assert!(matches!(
            decode(&[0xff, 1, 4, 3, 2, 1]),
            Some(Command::Register {
                generation: 0x01020304
            })
        ));
        assert!(decode(&[0xff, 1, 4, 3, 2]).is_none());
        assert!(decode(&[0xff, 1, 4, 3, 2, 1, 0]).is_none());
        let mut p = [0u8; 130];
        p[0] = 0xff;
        p[1] = 0;
        p[2..34].fill(1);
        p[34..66].fill(2);
        p[66..98].fill(3);
        p[98..130].fill(4);
        match decode(&p) {
            Some(Command::CreatePolicy(p)) => {
                assert_eq!(p.core_program, [1; 32]);
                assert_eq!(p.resident_program, [2; 32]);
                assert_eq!(p.collection, [3; 32]);
                assert_eq!(p.guard_authority, [4; 32]);
            }
            _ => panic!("policy must decode"),
        }
        assert!(decode(&p[..129]).is_none());
        assert!(
            decode(&p[..98]).is_none(),
            "the v1 length is no longer a policy"
        );
    }

    #[test]
    fn act_carries_the_generation_and_any_inner_instruction_but_not_itself() {
        // Harvest (0x40, no data), Train (0x42, unit and count).
        match decode(&[0xff, 2, 2, 0, 0, 0, 0x40]) {
            Some(Command::Act { generation, inner }) => {
                assert_eq!(generation, 2);
                assert_eq!(inner, &[0x40]);
            }
            _ => panic!("Act must decode"),
        }
        match decode(&[0xff, 2, 7, 0, 0, 0, 0x42, 1, 3, 0]) {
            Some(Command::Act { generation, inner }) => {
                assert_eq!(generation, 7);
                assert_eq!(inner, &[0x42, 1, 3, 0]);
            }
            _ => panic!("Act must decode"),
        }
        // No inner instruction, a nested resident command, a short generation.
        assert!(decode(&[0xff, 2, 2, 0, 0, 0]).is_none());
        assert!(decode(&[0xff, 2, 2, 0, 0, 0, 0xff, 2, 0, 0, 0, 0, 0x40]).is_none());
        assert!(decode(&[0xff, 2, 2, 0, 0]).is_none());
    }

    #[test]
    fn join_carries_the_generation_and_the_faction_exactly() {
        assert!(matches!(
            decode(&[0xff, 3, 1, 0, 0, 0, 5]),
            Some(Command::Join {
                generation: 1,
                faction: 5
            })
        ));
        assert!(decode(&[0xff, 3, 1, 0, 0, 0]).is_none());
        assert!(decode(&[0xff, 3, 1, 0, 0, 0, 5, 0]).is_none());
        assert!(decode(&[0xff, 4, 1, 0, 0, 0, 5]).is_none());
    }
}
