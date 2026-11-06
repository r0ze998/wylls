//! An NFT resident's Citizen: what marks it in the v2 Citizen layout and how
//! its own records are keyed. **Provisional** (2026-11-06): the offsets inside
//! `RSV_348`, the value of `WALLET` and the record key are proposed to the
//! integrator (workstream 4) and not yet allocated; they live here only, so
//! one change moves them.
//!
//! - `WALLET` is all zero for an NFT Citizen. No signer is the zero key, so
//!   every wallet or Frontier-session check, and every check of the
//!   wallet-derived Citizen address, refuses it: such a Citizen is reachable
//!   only through the resident authority (the live Core owner, the transfer
//!   guard and the resident program's generation, `resident_auth`).
//! - `RESIDENT_ASSET` (32 bytes at 348) names the Core asset, and
//!   `RESIDENT_FLAGS` (1 byte at 380) carries `FLAG_RESIDENT`. Bytes 381..384
//!   stay reserved (zero).
//! - Its records are keyed by the resident id `sha256("PSF-RES" ‖ asset)[0..15]`,
//!   the tag the resident program stores in its own account, instead of the
//!   wallet tag (which would be the same for every NFT Citizen).

use crate::v2::layout::player::citizen as C;
use permutation_rules::frontier::addr::citizen_tag15;
use permutation_rules::hash::sha256;

/// The Core asset of an NFT Citizen (inside `RSV_348`).
pub const RESIDENT_ASSET: usize = 348;
/// Resident flags (inside `RSV_348`).
pub const RESIDENT_FLAGS: usize = 380;
/// Bit 0 of [`RESIDENT_FLAGS`]: this Citizen is an NFT resident's.
pub const FLAG_RESIDENT: u8 = 1;
/// The resident id's domain (the resident program's `TAG15`).
pub const RESIDENT_TAG_DOMAIN: &[u8] = b"PSF-RES";

// The resident fields fill the start of the v2 Citizen's reserved 36 bytes
// and nothing else (checked at compile time).
const _: () = assert!(
    RESIDENT_ASSET == C::RSV_348
        && RESIDENT_ASSET + 32 == RESIDENT_FLAGS
        && RESIDENT_FLAGS < C::RSV_348 + 36
        && C::RSV_348 + 36 == C::SIZE
);

/// The resident id of `asset`: `sha256("PSF-RES" ‖ asset)[0..15]`.
pub fn resident_tag15(asset: &[u8; 32]) -> [u8; 15] {
    let h = sha256(&[RESIDENT_TAG_DOMAIN, asset]);
    let mut t = [0u8; 15];
    t.copy_from_slice(&h[..15]);
    t
}

/// The asset of an NFT Citizen's data, or `None` for a wallet Citizen.
/// A flagged Citizen with a non-zero `WALLET` or a zero asset is not a valid
/// NFT Citizen either (`None`), so callers refuse it.
pub fn resident_asset(citizen: &[u8]) -> Option<[u8; 32]> {
    if citizen.len() < C::SIZE || citizen[RESIDENT_FLAGS] & FLAG_RESIDENT == 0 {
        return None;
    }
    if citizen[C::WALLET..C::WALLET + 32] != [0u8; 32] {
        return None;
    }
    let asset: [u8; 32] = citizen[RESIDENT_ASSET..RESIDENT_ASSET + 32]
        .try_into()
        .ok()?;
    (asset != [0u8; 32]).then_some(asset)
}

/// Whether the data is flagged as an NFT Citizen (valid or not).
pub fn is_flagged(citizen: &[u8]) -> bool {
    citizen
        .get(RESIDENT_FLAGS)
        .is_some_and(|f| f & FLAG_RESIDENT != 0)
}

/// The key of a Citizen's own records: the resident id for an NFT Citizen,
/// the wallet tag otherwise. `None` for a flagged Citizen that is not valid.
pub fn record_tag15(citizen: &[u8]) -> Option<[u8; 15]> {
    if is_flagged(citizen) {
        return resident_asset(citizen).map(|a| resident_tag15(&a));
    }
    let wallet: [u8; 32] = citizen.get(C::WALLET..C::WALLET + 32)?.try_into().ok()?;
    Some(citizen_tag15(&wallet))
}

/// Mark `citizen` (already initialised as a Citizen) as `asset`'s NFT
/// Citizen: `WALLET` zero, the asset, the flag; the rest of `RSV_348` zero.
pub fn mark(citizen: &mut [u8], asset: &[u8; 32]) -> bool {
    if citizen.len() < C::SIZE || *asset == [0u8; 32] {
        return false;
    }
    citizen[C::WALLET..C::WALLET + 32].fill(0);
    citizen[RESIDENT_ASSET..RESIDENT_ASSET + 32].copy_from_slice(asset);
    citizen[RESIDENT_FLAGS] = FLAG_RESIDENT;
    citizen[RESIDENT_FLAGS + 1..C::SIZE].fill(0);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    // Literal bytes only: an asset address and the resident id the REAL
    // resident program stored for it (permutation-nft-resident-spike/svm-core/out,
    // scene "after mint", resident account bytes 1..48). No key generation,
    // derivation, signing, I/O or network.
    const ASSET: &str = "1e0472eeda371c36b8209aa20a7ec299e99fb803f918adafebb81ab58cc08ddc";
    const PROGRAM_TAG15: &str = "9ab72fc6db3606d32bdcdd217ac454";

    fn hex<const N: usize>(s: &str) -> [u8; N] {
        let v: std::vec::Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        v.try_into().unwrap()
    }

    #[test]
    fn resident_tag_matches_the_resident_programs_own() {
        assert_eq!(resident_tag15(&hex::<32>(ASSET)), hex::<15>(PROGRAM_TAG15));
    }

    #[test]
    fn wallet_and_nft_citizens_are_told_apart_and_keyed_apart() {
        let asset = hex::<32>(ASSET);
        // A wallet Citizen: its records keep the wallet tag.
        let mut wallet = vec![0u8; C::SIZE];
        wallet[C::WALLET..C::WALLET + 32].fill(7);
        assert_eq!(resident_asset(&wallet), None);
        assert_eq!(record_tag15(&wallet), Some(citizen_tag15(&[7; 32])));
        // An NFT Citizen: the wallet is cleared, its records use the resident id.
        let mut nft = wallet.clone();
        assert!(mark(&mut nft, &asset));
        assert_eq!(nft[C::WALLET..C::WALLET + 32], [0; 32]);
        assert_eq!(resident_asset(&nft), Some(asset));
        assert_eq!(record_tag15(&nft), Some(hex::<15>(PROGRAM_TAG15)));
        // Two NFT Citizens never share a record key (the wallet tag of zero would).
        let mut other = vec![0u8; C::SIZE];
        let mut asset2 = asset;
        asset2[0] ^= 1;
        assert!(mark(&mut other, &asset2));
        assert_ne!(record_tag15(&other), record_tag15(&nft));
        // A flagged Citizen with a wallet, or with no asset, is no valid NFT Citizen.
        let mut forged = nft.clone();
        forged[C::WALLET] = 1;
        assert_eq!(resident_asset(&forged), None);
        assert_eq!(record_tag15(&forged), None);
        let mut empty = nft.clone();
        empty[RESIDENT_ASSET..RESIDENT_ASSET + 32].fill(0);
        assert_eq!(resident_asset(&empty), None);
        assert!(!mark(&mut vec![0u8; C::SIZE], &[0; 32]));
        assert!(!mark(&mut vec![0u8; C::SIZE - 1], &asset));
    }
}
