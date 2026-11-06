//! Experimental immutable NFT authentication policy record.
//!
//! This byte codec does not establish program ownership, canonical address or
//! initialization authority. The calling program must check all three.

use crate::resident_auth::Policy;

/// Version 2 adds the guard authority (v1 had none and is not read).
pub const MAGIC: [u8; 8] = *b"PSFNP002";
pub const LEN: usize = 136;

/// Refuse unknown versions, non-exact lengths and unset identities.
pub fn read(data: &[u8]) -> Option<Policy> {
    if data.len() != LEN || data[..8] != MAGIC {
        return None;
    }
    let core_program: [u8; 32] = data[8..40].try_into().ok()?;
    let resident_program: [u8; 32] = data[40..72].try_into().ok()?;
    let collection: [u8; 32] = data[72..104].try_into().ok()?;
    let guard_authority: [u8; 32] = data[104..136].try_into().ok()?;
    if core_program == [0; 32]
        || resident_program == [0; 32]
        || collection == [0; 32]
        || guard_authority == [0; 32]
    {
        return None;
    }
    Some(Policy {
        core_program,
        resident_program,
        collection,
        guard_authority,
    })
}

/// A proposed write-once encoder, not an authorization or creation path.
/// The runtime must validate canonical address, owner, signer and authority.
pub fn write_once(data: &mut [u8], policy: &Policy) -> bool {
    if data.len() != LEN
        || data.iter().any(|&b| b != 0)
        || policy.core_program == [0; 32]
        || policy.resident_program == [0; 32]
        || policy.collection == [0; 32]
        || policy.guard_authority == [0; 32]
    {
        return false;
    }
    data[..8].copy_from_slice(&MAGIC);
    data[8..40].copy_from_slice(&policy.core_program);
    data[40..72].copy_from_slice(&policy.resident_program);
    data[72..104].copy_from_slice(&policy.collection);
    data[104..136].copy_from_slice(&policy.guard_authority);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // Literal arrays only: no setup, key generation/derivation, signing, IO or network.
    #[test]
    fn policy_record_rejects_empty_corrupt_or_replaced_configuration() {
        let p = Policy {
            core_program: [1; 32],
            resident_program: [2; 32],
            collection: [3; 32],
            guard_authority: [4; 32],
        };
        let mut data = [0u8; LEN];
        assert!(read(&data).is_none());
        let empty = Policy {
            core_program: [0; 32],
            ..p
        };
        assert!(!write_once(&mut data, &empty));
        let unguarded = Policy {
            guard_authority: [0; 32],
            ..p
        };
        assert!(!write_once(&mut data, &unguarded));
        let p = Policy {
            core_program: [1; 32],
            resident_program: [2; 32],
            collection: [3; 32],
            guard_authority: [4; 32],
        };
        assert!(write_once(&mut data, &p));
        let decoded = read(&data).unwrap();
        assert_eq!(decoded.core_program, p.core_program);
        assert_eq!(decoded.resident_program, p.resident_program);
        assert_eq!(decoded.collection, p.collection);
        assert_eq!(decoded.guard_authority, p.guard_authority);
        let original = data;
        assert!(!write_once(&mut data, &p));
        assert_eq!(data, original);
        assert!(read(&data[..LEN - 1]).is_none());
        data[7] ^= 1;
        assert!(read(&data).is_none());
        data = original;
        data[72..104].fill(0);
        assert!(read(&data).is_none());
        data = original;
        data[104..136].fill(0);
        assert!(read(&data).is_none());
    }
}
