//! Experimental validation of an NFT-bound player authority.
//!
//! This helper does not install a new instruction or create a binding. The
//! caller MUST obtain the immutable binding from the canonical Citizen and
//! the program/collection identities from trusted world configuration, check
//! Citizen ownership and uniqueness at creation, and pass account bytes and
//! signer flags directly from the runtime. It is not a substitute for those
//! checks, nor a claim that the existing player prologue invokes it.

/// Identities from a previously authenticated, immutable Citizen binding.
pub struct Binding {
    pub asset: [u8; 32],
    pub resident: [u8; 32],
}

/// Fixed program and collection identities from trusted world configuration.
pub struct Policy {
    pub core_program: [u8; 32],
    pub resident_program: [u8; 32],
    pub collection: [u8; 32],
    /// The resident program's collection-authority address: the authority of
    /// the asset's Permanent Freeze and Permanent Transfer delegates
    /// (`resident_guard`). The program checks it against `resident_program`
    /// when the policy is created.
    pub guard_authority: [u8; 32],
}

pub struct Account<'a> {
    pub key: [u8; 32],
    pub owner: [u8; 32],
    pub data: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotSigned,
    Asset,
    Resident,
    /// The asset lacks the transfer guard: it could move without the
    /// resident program bumping the generation (`resident_guard`).
    Unguarded,
    StaleGeneration,
    NotCurrentAuthority,
}

impl Refusal {
    /// The program's error for the refusal (⑳'s 170–175, workstream 4's
    /// allocation; provisional until integration).
    pub const fn error(&self) -> crate::v2::error::CqError {
        use crate::v2::error::CqError as E;
        match self {
            Refusal::NotSigned => E::ResidentNotSigned,
            Refusal::Asset => E::ResidentAsset,
            Refusal::Resident => E::ResidentAccount,
            Refusal::Unguarded => E::ResidentUnguarded,
            Refusal::StaleGeneration => E::ResidentStaleGeneration,
            Refusal::NotCurrentAuthority => E::ResidentNotCurrentAuthority,
        }
    }
}

// Check the complete AssetV1 base (name, URI and optional sequence). Plugin
// bytes may follow it; this is not a plugin or transfer-guard verification.
fn valid_asset_tail(data: &[u8]) -> bool {
    let mut pos: usize = 66;
    for _ in 0..2 {
        let Some(length_bytes) = data.get(pos..pos.saturating_add(4)) else {
            return false;
        };
        let len = u32::from_le_bytes(length_bytes.try_into().unwrap()) as usize;
        pos += 4;
        let Some(end) = pos.checked_add(len) else {
            return false;
        };
        let Some(text) = data.get(pos..end) else {
            return false;
        };
        if core::str::from_utf8(text).is_err() {
            return false;
        }
        pos = end;
    }
    match data.get(pos) {
        Some(0) => true,
        Some(1) => data.get(pos + 1..pos + 9).is_some(),
        _ => false,
    }
}

/// Check a signed action against the bound asset and resident on the same
/// runtime invocation. `expected_generation` MUST be signed instruction data,
/// not a value copied from the resident by the caller after signing.
/// `session_allowed` is false for operations that require the owner directly.
#[allow(clippy::too_many_arguments)]
pub fn authorize(
    binding: &Binding,
    policy: &Policy,
    asset: &Account<'_>,
    resident: &Account<'_>,
    actor: &[u8; 32],
    actor_signed: bool,
    expected_generation: u32,
    now: i64,
    session_allowed: bool,
) -> Result<(), Refusal> {
    if !actor_signed {
        return Err(Refusal::NotSigned);
    }
    // Core AssetV1: discriminator, owner, Collection discriminator/address.
    let a = asset.data;
    if asset.key != binding.asset
        || asset.owner != policy.core_program
        || a.len() < 66
        || a[0] != 1
        || a[33] != 2
        || a[34..66] != policy.collection
        || !valid_asset_tail(a)
    {
        return Err(Refusal::Asset);
    }
    // Only a guarded asset makes the generation follow every change of
    // holder; without the guard a buy-back would bring old signatures back.
    if crate::resident_guard::check(a, &policy.guard_authority).is_err() {
        return Err(Refusal::Unguarded);
    }
    // The binding stores the exact resident account. Its program-owned fixed
    // layout stores this asset again, preventing cross-resident substitution.
    let r = resident.data;
    if resident.key != binding.resident
        || resident.owner != policy.resident_program
        || r.len() != 133
        || r[0] != 0xc2
        || r[1..33] != binding.asset
    {
        return Err(Refusal::Resident);
    }
    let generation = u32::from_le_bytes(r[48..52].try_into().unwrap());
    if generation != expected_generation {
        return Err(Refusal::StaleGeneration);
    }
    let owner = &a[1..33];
    if actor == owner {
        return Ok(());
    }
    let session_generation = u32::from_le_bytes(r[92..96].try_into().unwrap());
    let session_expiry = i64::from_le_bytes(r[84..92].try_into().unwrap());
    if session_allowed
        && r[52..84] != [0; 32]
        && actor == &r[52..84]
        && r[96..128] == *owner
        && session_generation == generation
        && now < session_expiry
    {
        return Ok(());
    }
    Err(Refusal::NotCurrentAuthority)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;
    use std::vec::Vec;

    /// `PluginHeaderV1` + data + `PluginRegistryV1` for a frozen Permanent
    /// Freeze Delegate and a Permanent Transfer Delegate of `guard`, after an
    /// AssetV1 base ending at `base`.
    fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
        let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
        let mut t = vec![3u8];
        t.extend_from_slice(&(registry_at as u64).to_le_bytes());
        t.extend_from_slice(&[5, 1, 7]);
        t.push(4);
        t.extend_from_slice(&2u32.to_le_bytes());
        for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
            t.extend_from_slice(&[kind, 3]);
            t.extend_from_slice(guard);
            t.extend_from_slice(&(at as u64).to_le_bytes());
        }
        t.extend_from_slice(&0u32.to_le_bytes());
        t
    }

    // Fixed bytes only: no key creation, derivation, signatures, I/O or setup.
    #[test]
    fn refusals_map_to_the_six_allocated_codes() {
        let all = [
            Refusal::NotSigned,
            Refusal::Asset,
            Refusal::Resident,
            Refusal::Unguarded,
            Refusal::StaleGeneration,
            Refusal::NotCurrentAuthority,
        ];
        for (r, code) in all.iter().zip(170u32..) {
            assert_eq!(r.error().code(), code, "{r:?}");
        }
    }

    #[test]
    fn owner_session_transfer_and_substitution_checks() {
        let binding = Binding {
            asset: [1; 32],
            resident: [2; 32],
        };
        let policy = Policy {
            core_program: [3; 32],
            resident_program: [4; 32],
            collection: [5; 32],
            guard_authority: [10; 32],
        };
        let a = [6; 32];
        let b = [7; 32];
        let session = [8; 32];
        let mut asset_data = vec![0u8; 75];
        asset_data[0] = 1;
        asset_data[1..33].copy_from_slice(&a);
        asset_data[33] = 2;
        asset_data[34..66].copy_from_slice(&policy.collection);
        let bare = asset_data.clone();
        // The two permanent delegates of the guard authority, laid out as the
        // real Core binary writes them (resident_guard's tests read real bytes).
        asset_data.extend_from_slice(&guarded_tail(75, &policy.guard_authority));
        let mut resident_data = [0u8; 133];
        resident_data[0] = 0xc2;
        resident_data[1..33].copy_from_slice(&binding.asset);
        resident_data[52..84].copy_from_slice(&session);
        resident_data[84..92].copy_from_slice(&100i64.to_le_bytes());
        resident_data[96..128].copy_from_slice(&a);
        let check = |asset_data: &[u8],
                     resident_data: &[u8],
                     actor: &[u8; 32],
                     signed,
                     gen,
                     now,
                     session_ok| {
            authorize(
                &binding,
                &policy,
                &Account {
                    key: binding.asset,
                    owner: policy.core_program,
                    data: asset_data,
                },
                &Account {
                    key: binding.resident,
                    owner: policy.resident_program,
                    data: resident_data,
                },
                actor,
                signed,
                gen,
                now,
                session_ok,
            )
        };
        assert_eq!(
            check(&asset_data, &resident_data, &a, true, 0, 99, true),
            Ok(())
        );
        assert_eq!(
            authorize(
                &binding,
                &policy,
                &Account {
                    key: [99; 32],
                    owner: policy.core_program,
                    data: &asset_data
                },
                &Account {
                    key: binding.resident,
                    owner: policy.resident_program,
                    data: &resident_data
                },
                &a,
                true,
                0,
                99,
                true
            ),
            Err(Refusal::Asset)
        );
        assert_eq!(
            authorize(
                &binding,
                &policy,
                &Account {
                    key: binding.asset,
                    owner: policy.core_program,
                    data: &asset_data
                },
                &Account {
                    key: binding.resident,
                    owner: [99; 32],
                    data: &resident_data
                },
                &a,
                true,
                0,
                99,
                true
            ),
            Err(Refusal::Resident)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &a, false, 0, 99, true),
            Err(Refusal::NotSigned)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &session, true, 0, 99, true),
            Ok(())
        );
        assert_eq!(
            check(&asset_data, &resident_data, &session, true, 0, 100, true),
            Err(Refusal::NotCurrentAuthority)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &session, true, 0, 99, false),
            Err(Refusal::NotCurrentAuthority)
        );
        asset_data[1..33].copy_from_slice(&b);
        resident_data[48..52].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(
            check(&asset_data, &resident_data, &a, true, 1, 99, true),
            Err(Refusal::NotCurrentAuthority)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &session, true, 1, 99, true),
            Err(Refusal::NotCurrentAuthority)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &b, true, 0, 99, true),
            Err(Refusal::StaleGeneration)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &b, true, 1, 99, true),
            Ok(())
        );
        asset_data[1..33].copy_from_slice(&a);
        resident_data[48..52].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(
            check(&asset_data, &resident_data, &a, true, 0, 99, true),
            Err(Refusal::StaleGeneration)
        );
        assert_eq!(
            check(&asset_data, &resident_data, &session, true, 2, 99, true),
            Err(Refusal::NotCurrentAuthority)
        );
        // A complete AssetV1 base without the guard plugins: refused, the
        // generation would not follow a plain Core transfer of it.
        assert_eq!(
            check(&bare, &resident_data, &a, true, 2, 99, true),
            Err(Refusal::Unguarded)
        );
        let mut other_guard = asset_data.clone();
        other_guard[75 + 9 + 3 + 5 + 2] ^= 1;
        assert_eq!(
            check(&other_guard, &resident_data, &a, true, 2, 99, true),
            Err(Refusal::Unguarded)
        );
        assert_eq!(
            check(&asset_data[..74], &resident_data, &a, true, 2, 99, true),
            Err(Refusal::Asset)
        );
        resident_data[1] ^= 1;
        assert_eq!(
            check(&asset_data, &resident_data, &a, true, 2, 99, true),
            Err(Refusal::Resident)
        );
        asset_data[34] ^= 1;
        assert_eq!(
            check(&asset_data, &resident_data, &a, true, 2, 99, true),
            Err(Refusal::Asset)
        );
    }
}
