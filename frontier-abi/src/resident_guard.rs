//! The transfer guard of a resident asset, read from the Core asset bytes.
//!
//! A resident can change hands only through the resident program's
//! `TransferResident`, which moves the asset, bumps the holder generation and
//! clears the session in one instruction. That holds only while the asset
//! carries two permanent plugins whose authority is the resident program's
//! collection-authority address: a Permanent Freeze Delegate that is frozen
//! (a plain Core transfer is refused) and a Permanent Transfer Delegate (the
//! resident program can still move it). Without them the asset could move by a
//! plain Core transfer, the generation would not change, and an earlier
//! holder's signed actions would stand again after a buy-back.
//!
//! This reads the Core layout as the mainnet Core program writes it (checked
//! against asset bytes the real binary produced, `permutation-nft-resident-spike/svm-core/out`):
//! `AssetV1` base, then `PluginHeaderV1 {key = 3, registry_offset: u64}`, the
//! plugin data, and `PluginRegistryV1 {key = 4, entries: Vec<{plugin_type: u8,
//! authority, offset: u64}>, external: Vec<..>}`. `authority` is
//! `None = 0 | Owner = 1 | UpdateAuthority = 2 | Address(32 bytes) = 3`.
//! Other plugins (an owner may add its own delegates) do not matter here.

/// Core `PluginType` / `Plugin` discriminants used here.
pub const PERMANENT_FREEZE_DELEGATE: u8 = 5;
pub const PERMANENT_TRANSFER_DELEGATE: u8 = 7;
const KEY_ASSET_V1: u8 = 1;
const KEY_PLUGIN_HEADER_V1: u8 = 3;
const KEY_PLUGIN_REGISTRY_V1: u8 = 4;
const AUTHORITY_ADDRESS: u8 = 3;
/// A registry longer than this is not one the resident program wrote.
const MAX_ENTRIES: u32 = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum GuardRefusal {
    /// The bytes are not a complete `AssetV1` base.
    NotAsset,
    /// No plugin header or registry where Core puts them, or a malformed one.
    NoRegistry,
    /// No Permanent Freeze Delegate of `guard`, or it is not frozen.
    NotFrozen,
    /// No Permanent Transfer Delegate of `guard`.
    NoTransferDelegate,
}

fn u32_at(d: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        d.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn u64_at(d: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        d.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}

/// Where the `AssetV1` base ends: key, owner, update authority, name, uri,
/// optional seq. `None` if the bytes are not a complete base.
pub fn asset_base_end(d: &[u8]) -> Option<usize> {
    if *d.first()? != KEY_ASSET_V1 {
        return None;
    }
    let mut pos = 33usize;
    pos = match *d.get(pos)? {
        0 => pos + 1,
        1 | 2 => pos + 33,
        _ => return None,
    };
    for _ in 0..2 {
        let len = u32_at(d, pos)? as usize;
        let start = pos.checked_add(4)?;
        let end = start.checked_add(len)?;
        core::str::from_utf8(d.get(start..end)?).ok()?;
        pos = end;
    }
    match *d.get(pos)? {
        0 => Some(pos + 1),
        1 => {
            d.get(pos + 1..pos + 9)?;
            Some(pos + 9)
        }
        _ => None,
    }
}

/// Whether the asset carries the transfer guard of `guard` (the resident
/// program's collection-authority address).
pub fn check(d: &[u8], guard: &[u8; 32]) -> Result<(), GuardRefusal> {
    let base = asset_base_end(d).ok_or(GuardRefusal::NotAsset)?;
    if d.get(base) != Some(&KEY_PLUGIN_HEADER_V1) {
        return Err(GuardRefusal::NoRegistry);
    }
    let reg = u64_at(d, base + 1).ok_or(GuardRefusal::NoRegistry)? as usize;
    // The plugin data lies between the header and the registry.
    if reg < base + 9 || d.get(reg) != Some(&KEY_PLUGIN_REGISTRY_V1) {
        return Err(GuardRefusal::NoRegistry);
    }
    let n = u32_at(d, reg + 1).ok_or(GuardRefusal::NoRegistry)?;
    if n > MAX_ENTRIES {
        return Err(GuardRefusal::NoRegistry);
    }
    let (mut frozen, mut transfer) = (false, false);
    let mut pos = reg + 5;
    for _ in 0..n {
        let kind = *d.get(pos).ok_or(GuardRefusal::NoRegistry)?;
        let auth = *d.get(pos + 1).ok_or(GuardRefusal::NoRegistry)?;
        let (address, next) = if auth == AUTHORITY_ADDRESS {
            (
                d.get(pos + 2..pos + 34).ok_or(GuardRefusal::NoRegistry)?,
                pos + 34,
            )
        } else if auth <= 2 {
            (&[][..], pos + 2)
        } else {
            return Err(GuardRefusal::NoRegistry);
        };
        let offset = u64_at(d, next).ok_or(GuardRefusal::NoRegistry)? as usize;
        // Plugin data sits after the header and before the registry, and
        // starts with the plugin's own discriminant.
        if offset < base + 9 || offset >= reg || d.get(offset) != Some(&kind) {
            return Err(GuardRefusal::NoRegistry);
        }
        if address == guard {
            match kind {
                PERMANENT_FREEZE_DELEGATE => frozen |= d.get(offset + 1) == Some(&1),
                PERMANENT_TRANSFER_DELEGATE => transfer = true,
                _ => {}
            }
        }
        pos = next + 8;
    }
    // The external plugin registry follows (a vector); it must be readable.
    u32_at(d, pos).ok_or(GuardRefusal::NoRegistry)?;
    if !frozen {
        return Err(GuardRefusal::NotFrozen);
    }
    if !transfer {
        return Err(GuardRefusal::NoTransferDelegate);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    // Literal bytes only: Core asset accounts as the REAL mainnet Core binary
    // wrote them in LiteSVM (permutation-nft-resident-spike/svm-core/out, scenes
    // "after mint", "after A→B→A", "after transfer A→B"), copied here as hex.
    // No key generation, derivation, signing, I/O or network.
    const AFTER_MINT: &str = "014ba27e2e62fd09992353b8f32bf082fee8d847842732a01be2628c6119fee2a202b5701a7a3fd625ec5669c5c0c1fa8f48e19af3ec7c30dff9cb32fbe7c3dbdf5f1500000057796c6c73205265736964656e74202874657374292000000068747470733a2f2f77796c6c732e746573742f7265736964656e742e6a736f6e00038c00000000000000050107040200000005034e89c94c1b73f28cc7d77616c6ba0a931890869ff4b1a797ea59eb02132c29e5890000000000000007034e89c94c1b73f28cc7d77616c6ba0a931890869ff4b1a797ea59eb02132c29e58b0000000000000000000000";
    const AFTER_TRANSFER: &str = "01fd67622ec80ebda532eaf5c14b7c5a383fe61f7e54480426e78372786f31c2e202b5701a7a3fd625ec5669c5c0c1fa8f48e19af3ec7c30dff9cb32fbe7c3dbdf5f1500000057796c6c73205265736964656e74202874657374292000000068747470733a2f2f77796c6c732e746573742f7265736964656e742e6a736f6e00038c00000000000000050107040200000005034e89c94c1b73f28cc7d77616c6ba0a931890869ff4b1a797ea59eb02132c29e5890000000000000007034e89c94c1b73f28cc7d77616c6ba0a931890869ff4b1a797ea59eb02132c29e58b0000000000000000000000";
    /// The collection-authority address of that run's resident program, as
    /// the registry above records it.
    const GUARD: &str = "4e89c94c1b73f28cc7d77616c6ba0a931890869ff4b1a797ea59eb02132c29e5";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    fn guard() -> [u8; 32] {
        hex(GUARD).try_into().unwrap()
    }

    #[test]
    fn real_core_bytes_carry_the_guard_before_and_after_a_transfer() {
        for s in [AFTER_MINT, AFTER_TRANSFER] {
            let d = hex(s);
            assert_eq!(d.len(), 233);
            assert_eq!(asset_base_end(&d), Some(128));
            assert_eq!(check(&d, &guard()), Ok(()));
        }
        // Another authority's guard is not this program's guard.
        let mut other = guard();
        other[0] ^= 1;
        assert_eq!(
            check(&hex(AFTER_MINT), &other),
            Err(GuardRefusal::NotFrozen)
        );
    }

    #[test]
    fn a_thawed_missing_or_malformed_guard_is_refused() {
        let d = hex(AFTER_MINT);
        // frozen = false (byte 138, the Permanent Freeze Delegate's `frozen`).
        let mut thawed = d.clone();
        assert_eq!(thawed[137..139], [5, 1]);
        thawed[138] = 0;
        assert_eq!(check(&thawed, &guard()), Err(GuardRefusal::NotFrozen));
        // The registry lists only the freeze delegate (count 2 → 1).
        let mut one = d.clone();
        one[141..145].copy_from_slice(&1u32.to_le_bytes());
        // ...then the external-registry length must follow the first entry.
        one.truncate(145 + 42);
        one.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(check(&one, &guard()), Err(GuardRefusal::NoTransferDelegate));
        // No plugins at all: a bare AssetV1 base.
        assert_eq!(check(&d[..128], &guard()), Err(GuardRefusal::NoRegistry));
        // A registry offset that points elsewhere, a truncated registry, a wrong discriminant at an entry's offset.
        let mut moved = d.clone();
        moved[129] = 0x8d;
        assert_eq!(check(&moved, &guard()), Err(GuardRefusal::NoRegistry));
        assert_eq!(check(&d[..200], &guard()), Err(GuardRefusal::NoRegistry));
        let mut wrong = d.clone();
        wrong[139] = 1;
        assert_eq!(check(&wrong, &guard()), Err(GuardRefusal::NoRegistry));
        // Not an AssetV1 at all.
        let mut not_asset = d.clone();
        not_asset[0] = 5;
        assert_eq!(check(&not_asset, &guard()), Err(GuardRefusal::NotAsset));
    }
}
