//! Experimental, feature-gated NFT registration wire format. This tag is not
//! an allocated production ABI; it must be reconciled with the integration ABI.
use crate::resident_auth::Policy;

pub const EXPERIMENTAL_TAG: u8 = 0xff;

pub enum Command {
    CreatePolicy(Policy),
    Register { generation: u32 },
    Harvest { generation: u32 },
}

/// Exact lengths only. No defaults, trailing fields or unknown commands.
pub fn decode(bytes: &[u8]) -> Option<Command> {
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
        [EXPERIMENTAL_TAG, 2, a, b, c, d] => Some(Command::Harvest {
            generation: u32::from_le_bytes([*a, *b, *c, *d]),
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
        assert!(decode(&[0xff, 2]).is_none());
        assert!(matches!(
            decode(&[0xff, 2, 4, 3, 2, 1]),
            Some(Command::Harvest {
                generation: 0x01020304
            })
        ));
        assert!(decode(&[0xff, 2, 4, 3, 2, 1, 0]).is_none());
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
}
