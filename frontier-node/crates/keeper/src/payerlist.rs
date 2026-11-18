//! Payer address listing (devnet-readiness B4, runbook G5): the public keys
//! an operator funds before a devnet season, derived offline from the key
//! files the keeper and the relay are configured with. **Public keys only**:
//! nothing secret is returned or printed, and nothing touches the network.
//!
//! `frontier-keeper --config keeper.toml --print-addresses` lists the
//! keeper's reveal pool, delay pool, funders and (with
//! `beneficiary_key_file`) the ClaimDefence key, exactly as
//! [`crate::pools::Payers::new`] derives them for that config.
//! `frontier-keeper --print-relay-addresses <relay-master.seed>
//! [--relay-pool-size N]` lists the relay's pool (`pool_id = "relay"`, the
//! same I-49 derivation as `permutation-gateway/src/frontier/payers.mjs`).
//!
//! One line per key: `<role>\t<index>\t<base58 pubkey>`.

use solana_address::Address;
use solana_signer::Signer;

use fclient::payers::{self, RELAY_POOL};

use crate::config::KeeperConfig;
use crate::pools::Payers;

/// One listed key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    pub role: &'static str,
    pub index: u32,
    pub address: Address,
}

impl std::fmt::Display for Listed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}\t{}\t{}", self.role, self.index, self.address)
    }
}

/// The relay's default pool size (its `--pool-size`, at least 150 unless
/// `--dev`).
pub const RELAY_POOL_DEFAULT: usize = 150;

/// The keeper's payers and funders for `cfg` from `master`, plus the claim
/// key's public key when given.
pub fn keeper(
    master: &[u8; 32],
    cfg: &KeeperConfig,
    claim: Option<&[u8; 32]>,
) -> Result<Vec<Listed>, String> {
    let p = Payers::new(master, cfg).map_err(|e| format!("payer pools: {e:?}"))?;
    let mut out = vec![];
    let mut push = |role, v: Vec<Address>| {
        for (i, a) in v.into_iter().enumerate() {
            out.push(Listed {
                role,
                index: i as u32,
                address: a,
            });
        }
    };
    push("reveal", p.reveal.addresses());
    push("delay", p.delay.addresses());
    push(
        "funder",
        p.funders.keys.iter().map(|k| k.pubkey()).collect(),
    );
    if let Some(seed) = claim {
        push(
            "claim",
            vec![fclient::Keypair::new_from_array(*seed).pubkey()],
        );
    }
    Ok(out)
}

/// The relay's seed file text as the relay reads it (`secretFile`: exactly
/// 64 lowercase hex characters, surrounding whitespace ignored).
pub fn relay_seed(text: &str) -> Result<[u8; 32], String> {
    let t = text.trim();
    if t.len() != 64
        || !t
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("not 32 bytes of lowercase hex (the relay's seed format)".into());
    }
    let mut seed = [0u8; 32];
    hex::decode_to_slice(t, &mut seed).map_err(|e| e.to_string())?;
    Ok(seed)
}

/// The relay pool's `n` public keys.
pub fn relay(seed: &[u8; 32], n: usize) -> Vec<Listed> {
    (0..n as u32)
        .map(|i| Listed {
            role: "relay",
            index: i,
            address: payers::derive(seed, RELAY_POOL, i).pubkey(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeper_listing_matches_the_pools_and_has_no_secret() {
        let m = [7u8; 32];
        let cfg = KeeperConfig::new(
            Address::new_from_array([1; 32]),
            1,
            Address::new_from_array([2; 32]),
        );
        let claim = [9u8; 32];
        let l = keeper(&m, &cfg, Some(&claim)).unwrap();
        let count = |r| l.iter().filter(|x| x.role == r).count();
        assert_eq!(count("reveal"), cfg.reveal_pool);
        assert_eq!(count("delay"), cfg.delay_pool);
        assert_eq!(count("funder"), cfg.funders);
        assert_eq!(count("claim"), 1);
        let p = Payers::new(&m, &cfg).unwrap();
        assert_eq!(l[0].address, p.reveal.keys[0].pubkey());
        assert_eq!(
            l.iter().find(|x| x.role == "funder").unwrap().address,
            p.funders.keys[0].pubkey()
        );
        // No line carries the seed, a payer's secret or the claim secret.
        let text: String = l.iter().map(|x| format!("{x}\n")).collect();
        for secret in [
            hex::encode(m),
            hex::encode(claim),
            hex::encode(p.reveal.keys[0].secret_bytes()),
            hex::encode(p.reveal.keys[0].to_bytes()),
            p.reveal.keys[0].to_base58_string(),
        ] {
            assert!(!text.contains(&secret));
        }
        assert!(text.lines().all(|x| x.split('\t').count() == 3));
    }

    #[test]
    fn small_pools_need_dev_like_the_keeper() {
        let mut cfg = KeeperConfig::new(
            Address::new_from_array([1; 32]),
            1,
            Address::new_from_array([2; 32]),
        );
        cfg.reveal_pool = 3;
        assert!(keeper(&[1; 32], &cfg, None).is_err());
        cfg.dev = true;
        assert_eq!(
            keeper(&[1; 32], &cfg, None)
                .unwrap()
                .iter()
                .filter(|x| x.role == "reveal")
                .count(),
            3
        );
    }

    #[test]
    fn relay_listing_is_the_i49_relay_pool() {
        let text = format!("{}\n", "ab".repeat(32));
        let seed = relay_seed(&text).unwrap();
        assert_eq!(seed, [0xab; 32]);
        let l = relay(&seed, RELAY_POOL_DEFAULT);
        assert_eq!(l.len(), 150);
        assert_eq!(l[5].address, payers::derive(&seed, "relay", 5).pubkey());
        for bad in [
            "AB".repeat(32),
            "ab".repeat(31),
            "zz".repeat(32),
            String::new(),
        ] {
            assert!(relay_seed(&bad).is_err(), "{bad}");
        }
    }
}
