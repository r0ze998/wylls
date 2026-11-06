//! Wire format of the NFT resident instructions (feature `nft-experimental`).
//! Tags allocated by workstream 4 on 2026-11-06 (`workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md`,
//! provisional until integration, where 4 fixes them): the band 0xE0–0xE7.
//!
//! | tag | command | data after the tag |
//! |---|---|---|
//! | 0xE0 | CreateResidentPolicy | core program, resident program, collection, guard authority (4 × 32) |
//! | 0xE1 | JoinResident (create the link and the Citizen: the first login) | generation u32, faction u8 |
//! | 0xE2 | ResidentAct (an NFT Citizen's player instruction) | generation u32, then the inner v2 instruction data (its own tag first, non-empty) |
//! | 0xE3–0xE7 | spare | — |
//!
//! The generation is the resident program's holder generation the actor
//! signs; the program compares it with the resident account in the same
//! invocation, so a signature made before a transfer never passes after it.
use crate::resident_auth::Policy;

pub const CREATE_RESIDENT_POLICY: u8 = 0xE0;
pub const JOIN_RESIDENT: u8 = 0xE1;
pub const RESIDENT_ACT: u8 = 0xE2;

/// Whether `t` is in workstream 20's band (0xE0–0xE7).
pub const fn is_resident_tag(t: u8) -> bool {
    t >= 0xE0 && t <= 0xE7
}

pub enum Command<'a> {
    CreatePolicy(Policy),
    Act { generation: u32, inner: &'a [u8] },
    Join { generation: u32, faction: u8 },
}

/// Exact lengths only. No defaults, trailing fields or unknown commands.
pub fn decode(bytes: &[u8]) -> Option<Command<'_>> {
    match bytes {
        [CREATE_RESIDENT_POLICY, rest @ ..] if rest.len() == 128 => {
            Some(Command::CreatePolicy(Policy {
                core_program: rest[0..32].try_into().ok()?,
                resident_program: rest[32..64].try_into().ok()?,
                collection: rest[64..96].try_into().ok()?,
                guard_authority: rest[96..128].try_into().ok()?,
            }))
        }
        [JOIN_RESIDENT, a, b, c, d, faction] => Some(Command::Join {
            generation: u32::from_le_bytes([*a, *b, *c, *d]),
            faction: *faction,
        }),
        // The inner instruction is a plain v2 instruction, never a resident
        // command or the test-only tag.
        [RESIDENT_ACT, a, b, c, d, inner @ ..]
            if !inner.is_empty() && !is_resident_tag(inner[0]) && inner[0] != 0xff =>
        {
            Some(Command::Act {
                generation: u32::from_le_bytes([*a, *b, *c, *d]),
                inner,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Literal bytes only; no setup, key operations, signing, I/O or network.
    #[test]
    fn the_band_is_free_in_the_v2_table_and_the_policy_is_exact() {
        for t in 0xE0..=0xE7u8 {
            assert!(
                crate::v2::Ix::from_tag(t).is_none(),
                "{t:#x} is a v2 instruction"
            );
            assert!(is_resident_tag(t));
        }
        assert!(!is_resident_tag(0xDF) && !is_resident_tag(0xE8) && !is_resident_tag(0xff));
        let mut p = [0u8; 129];
        p[0] = 0xE0;
        p[1..33].fill(1);
        p[33..65].fill(2);
        p[65..97].fill(3);
        p[97..129].fill(4);
        match decode(&p) {
            Some(Command::CreatePolicy(p)) => {
                assert_eq!(p.core_program, [1; 32]);
                assert_eq!(p.resident_program, [2; 32]);
                assert_eq!(p.collection, [3; 32]);
                assert_eq!(p.guard_authority, [4; 32]);
            }
            _ => panic!("policy must decode"),
        }
        assert!(decode(&p[..128]).is_none());
        assert!(decode(&[0xE3]).is_none(), "a spare tag is no command");
        assert!(
            decode(&[0xff, 0]).is_none(),
            "the test-only tag is no command"
        );
    }

    #[test]
    fn act_carries_the_generation_and_any_inner_instruction_but_not_itself() {
        // Harvest (0x40, no data), Train (0x42, unit and count).
        match decode(&[0xE2, 2, 0, 0, 0, 0x40]) {
            Some(Command::Act { generation, inner }) => {
                assert_eq!(generation, 2);
                assert_eq!(inner, &[0x40]);
            }
            _ => panic!("Act must decode"),
        }
        match decode(&[0xE2, 7, 0, 0, 0, 0x42, 1, 3, 0]) {
            Some(Command::Act { generation, inner }) => {
                assert_eq!(generation, 7);
                assert_eq!(inner, &[0x42, 1, 3, 0]);
            }
            _ => panic!("Act must decode"),
        }
        // No inner instruction, a nested resident command, the test-only tag, a short generation.
        assert!(decode(&[0xE2, 2, 0, 0, 0]).is_none());
        assert!(decode(&[0xE2, 2, 0, 0, 0, 0xE2, 2, 0, 0, 0, 0x40]).is_none());
        assert!(decode(&[0xE2, 2, 0, 0, 0, 0xE1, 1, 0, 0, 0, 5]).is_none());
        assert!(decode(&[0xE2, 2, 0, 0, 0, 0xff]).is_none());
        assert!(decode(&[0xE2, 2, 0, 0]).is_none());
    }

    #[test]
    fn join_carries_the_generation_and_the_faction_exactly() {
        assert!(matches!(
            decode(&[0xE1, 1, 0, 0, 0, 5]),
            Some(Command::Join {
                generation: 1,
                faction: 5
            })
        ));
        assert!(decode(&[0xE1, 1, 0, 0, 0]).is_none());
        assert!(decode(&[0xE1, 1, 0, 0, 0, 5, 0]).is_none());
    }
}
