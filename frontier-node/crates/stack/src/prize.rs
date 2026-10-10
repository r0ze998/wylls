//! The test-asset prize pool of a stack run (`--prize-so`): the keys the
//! relay holds (the season's join gate, the test mint's authority), the
//! permutation-prize program next to the game on the localnet, a 6-decimal
//! test mint and the season's pool. Local test tokens only.
//!
//! Layouts and tags here are permutation-prize's (its `tag` and `pool`
//! modules); the JS side is `permutation-gateway/client/src/frontier/prize.mjs`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chain::Chain;
use crate::config::StackConfig;
use crate::run::{self, RunDir};

pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// Decimals of the test mint.
pub const DECIMALS: u8 = 6;
const SYSTEM: Address = Address::new_from_array([0; 32]);
const MINT_SIZE: u64 = 82;

/// The contribution rules the pool is bound to (`params_hash` of InitPool
/// is the sha256 of this file): PROVISIONAL, undecided by the owner.
pub const PARAMS_FILE: &str = "permutation-gateway/src/frontier/prize-params.json";

pub struct Prize {
    pub so: PathBuf,
    pub so_len: usize,
    pub program: Address,
    pub gate: Keypair,
    pub faucet: Keypair,
    pub mint: Keypair,
    pub pool: Address,
    pub vault: Address,
    pub gate_file: PathBuf,
    pub faucet_file: PathBuf,
    pub params_hash: [u8; 32],
}

/// Invites the operator mints for its own members of a gated season (the
/// stack's script bots; the AI fleet of citizens/bin/ai-citizens-run.sh):
/// they join through `POST /f/join` without paying, have no Entry and can
/// never claim. Files of one token per line, mode 0600; never logged.
pub const BOT_INVITES: &str = "bots/invites.txt";
pub const FLEET_INVITES: &str = "relay/fleet-invites.txt";
/// Invites written for the AI fleet (its citizens, the seat, retries).
pub const FLEET_INVITE_COUNT: usize = 64;

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hmac_sha256(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for (i, k) in key.iter().enumerate() {
        ipad[i] ^= k;
        opad[i] ^= k;
    }
    let mut inner: Vec<&[u8]> = vec![&ipad];
    inner.extend_from_slice(parts);
    let d = sha256(&inner);
    sha256(&[&opad, &d])
}

fn base64url(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= c.len() {
                out.push(A[(n >> shift) as usize & 63] as char);
            }
        }
    }
    out
}

/// The relay's invite of `nonce` (permutation-gateway `invites.mjs`):
/// `base64url(nonce ‖ HMAC-SHA256(secret, "PSF-INVITE-v1" ‖ le64(season) ‖ nonce)[..16])`.
pub fn invite(secret: &[u8; 32], season_id: u64, nonce: &[u8; 12]) -> String {
    let mac = hmac_sha256(secret, &[b"PSF-INVITE-v1", &season_id.to_le_bytes(), nonce]);
    base64url(&[&nonce[..], &mac[..16]].concat())
}

/// Writes `n` fresh invites to `path` (replacing it), nonces drawn from
/// `seed` and `label`.
pub fn write_invites(
    path: &Path,
    secret: &[u8; 32],
    seed: &[u8; 32],
    season_id: u64,
    label: &str,
    n: usize,
) -> Result<(), String> {
    let text: String = (0..n as u64)
        .map(|i| {
            let d = sha256(&[b"invite-nonce", seed, label.as_bytes(), &i.to_le_bytes()]);
            let nonce: [u8; 12] = d[..12].try_into().expect("12 bytes");
            invite(secret, season_id, &nonce) + "\n"
        })
        .collect();
    run::write_atomic(path, text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// A web3.js keypair file (the JSON array of the 64 secret-key bytes).
fn write_keypair_json(p: &Path, k: &Keypair) -> Result<(), String> {
    let bytes: Vec<u8> = k.to_bytes().to_vec();
    run::write_atomic(p, json!(bytes).to_string().as_bytes())
}

impl Prize {
    /// The run's prize keys and addresses (created the first time), or
    /// `None` without `--prize-so`.
    pub fn load_or_create(
        repo: &Path,
        rd: &RunDir,
        cfg: &StackConfig,
        game: &Address,
    ) -> Result<Option<Prize>, String> {
        let Some(so) = &cfg.prize_so else {
            return Ok(None);
        };
        let so = run::resolve(repo, so);
        let bytes = std::fs::read(&so)
            .map_err(|e| format!("{}: {e} (build it with scripts/build-prize.sh)", so.display()))?;
        let pinned = rd.path("prize.so");
        run::write_atomic(&pinned, &bytes)?;
        let kp = |p: &str| run::secret(&rd.path(p)).map(Keypair::new_from_array);
        let program = kp("keys/prize-program.seed")?.pubkey();
        let (gate, faucet, mint) = (
            kp("relay/gate.seed")?,
            kp("relay/faucet.seed")?,
            kp("keys/prize-mint.seed")?,
        );
        let (gate_file, faucet_file) = (rd.path("relay/gate-key.json"), rd.path("relay/faucet-key.json"));
        write_keypair_json(&gate_file, &gate)?;
        write_keypair_json(&faucet_file, &faucet)?;
        // The operator's own members join by invite (never by paying).
        let secret = run::secret(&rd.path("relay/invite.secret"))?;
        let nonces = run::secret(&rd.path("keys/invite-nonces.seed"))?;
        write_invites(&rd.path(BOT_INVITES), &secret, &nonces, cfg.season_id, "bots", (4 * cfg.bots).max(8))?;
        write_invites(&rd.path(FLEET_INVITES), &secret, &nonces, cfg.season_id, "fleet", FLEET_INVITE_COUNT)?;
        let params = std::fs::read(repo.join(PARAMS_FILE)).map_err(|e| format!("{PARAMS_FILE}: {e}"))?;
        let (pool, _) = Address::find_program_address(
            &[b"pool", game.as_ref(), &cfg.season_id.to_le_bytes()],
            &program,
        );
        let (vault, _) = Address::find_program_address(&[b"vault", pool.as_ref()], &program);
        Ok(Some(Prize {
            so: pinned,
            so_len: bytes.len(),
            program,
            gate,
            faucet,
            mint,
            pool,
            vault,
            gate_file,
            faucet_file,
            params_hash: Sha256::digest(&params).into(),
        }))
    }

    /// The localnet's `--program` value.
    pub fn deploy_arg(&self, authority: &Address) -> String {
        format!(
            "{}={}:{}@{authority}",
            self.program,
            self.so.display(),
            fclient::fees::deploy_max_len(self.so_len as u64)
        )
    }

    /// The relay's extra arguments.
    pub fn relay_args(&self) -> Vec<String> {
        vec![
            "--gate-key-file".into(),
            self.gate_file.display().to_string(),
            "--prize-program".into(),
            self.program.to_string(),
            "--prize-mint".into(),
            self.mint.pubkey().to_string(),
            "--faucet-key-file".into(),
            self.faucet_file.display().to_string(),
        ]
    }

    /// After CreateSeason: the test mint (authority: the relay's faucet
    /// key) and the season's pool (operator: the season authority).
    pub async fn setup(
        &self,
        chain: &Chain,
        addrs: &Addresses,
        authority: &Keypair,
        cfg: &StackConfig,
    ) -> Result<Value, String> {
        let land = Duration::from_secs(60);
        let token: Address = TOKEN_PROGRAM.parse().map_err(|_| "token program id")?;
        let auth = authority.pubkey();
        let rent = chain
            .call("getMinimumBalanceForRentExemption", json!([MINT_SIZE]))
            .await?
            .as_u64()
            .ok_or("rent of a mint")?;
        let mut create = 0u32.to_le_bytes().to_vec(); // System CreateAccount
        create.extend_from_slice(&rent.to_le_bytes());
        create.extend_from_slice(&MINT_SIZE.to_le_bytes());
        create.extend_from_slice(token.as_ref());
        let mut init_mint = vec![20u8, DECIMALS]; // SPL Token InitializeMint2
        init_mint.extend_from_slice(self.faucet.pubkey().as_ref());
        init_mint.push(0);
        chain
            .send_op(
                &[
                    Instruction {
                        program_id: SYSTEM,
                        accounts: vec![
                            AccountMeta::new(auth, true),
                            AccountMeta::new(self.mint.pubkey(), true),
                        ],
                        data: create,
                    },
                    Instruction {
                        program_id: token,
                        accounts: vec![AccountMeta::new(self.mint.pubkey(), false)],
                        data: init_mint,
                    },
                ],
                &[authority, &self.mint],
                land,
            )
            .await?;
        let mut d = vec![0u8]; // permutation-prize InitPool
        d.extend_from_slice(&cfg.entry_fee.to_le_bytes());
        d.extend_from_slice(&cfg.prize_ops_bps.to_le_bytes());
        d.extend_from_slice(&cfg.prize_keeps.to_le_bytes());
        d.extend_from_slice(&self.params_hash);
        chain
            .send_op(
                &[Instruction {
                    program_id: self.program,
                    accounts: vec![
                        AccountMeta::new(auth, true),
                        AccountMeta::new(self.pool, false),
                        AccountMeta::new(self.vault, false),
                        AccountMeta::new_readonly(self.mint.pubkey(), false),
                        AccountMeta::new_readonly(addrs.season, false),
                        AccountMeta::new_readonly(addrs.program, false),
                        AccountMeta::new_readonly(token, false),
                        AccountMeta::new_readonly(SYSTEM, false),
                    ],
                    data: d,
                }],
                &[authority],
                land,
            )
            .await?;
        Ok(self.to_json(cfg))
    }

    pub fn to_json(&self, cfg: &StackConfig) -> Value {
        json!({
            "test_assets_only": true,
            "program": self.program.to_string(), "pool": self.pool.to_string(), "vault": self.vault.to_string(),
            "mint": self.mint.pubkey().to_string(), "decimals": DECIMALS,
            "entry_fee": cfg.entry_fee, "ops_bps": cfg.prize_ops_bps, "expected_keeps": cfg.prize_keeps,
            "params_hash": hex::encode(self.params_hash),
            "join_gate": self.gate.pubkey().to_string(), "faucet": self.faucet.pubkey().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay's own token for the same secret, season and nonce
    /// (permutation-gateway `InviteBook`, computed there).
    #[test]
    fn invites_are_the_relays() {
        let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        assert_eq!(invite(&[3u8; 32], 5, &nonce), "AAECAwQFBgcICQoLX-9a9HR-6czBGNgC5ro7tQ");
        assert_ne!(invite(&[3u8; 32], 6, &nonce), invite(&[3u8; 32], 5, &nonce));
        assert_eq!(base64url(b"ab"), "YWI");
        assert_eq!(base64url(b"abc"), "YWJj");
    }
}
