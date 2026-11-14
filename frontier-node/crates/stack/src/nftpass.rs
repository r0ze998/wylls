//! The NFT pass of a local test world (`--nft-pass`): the Frontier NFT lane
//! (`localnet-nft-sbf`, program id `[0x4E; 32]`, Seasons at `S1 | 0x8000`)
//! with Metaplex Core and the resident program on the same localnet, the
//! pass's setup (collection, config, a TEST sale, the Frontier resident
//! policy) and the mint page attached to the same RPC.
//!
//! Local test values only: the sale's price and supply are the setup
//! script's TEST values, never product terms; the resident program's id is
//! the spike's test id. The setup and the mint page are Node
//! (`permutation-nft-resident-spike/src/nft-world-setup.mjs`,
//! `src/mint-demo.mjs --rpc`); this module builds their command lines and
//! the localnet's `--program` arguments, and checks the binaries.
//! Record: docs/integration/CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md.

use std::path::{Path, PathBuf};

use fclient::Address;
use sha2::{Digest, Sha256};

use crate::procs::Spec;
use crate::run::{self, RunDir};

/// The Frontier NFT lane's only program id (`permutation_frontier::LOCALNET_NFT_PROGRAM_ID`).
pub const LOCALNET_NFT_PROGRAM_ID: [u8; 32] = [0x4E; 32];
/// The lane's Season version: S1 | 0x8000 (`permutation_frontier::PROGRAM_VERSION`
/// with `localnet-nft-sbf`). CreateSeason takes exactly this; the generic range
/// check sees it as S1 ([`crate::setup::range_view`], as the program's own).
pub const LANE_PROGRAM_VERSION: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1 | 0x8000;
/// The lane's build marker (`scripts/build-frontier-localnet-nft-sbf.sh`).
pub const LANE_MARKER: &[u8] = b"PSF_LOCALNET_NFT_SBF_BUILD";
/// Metaplex Core (mainnet id) and the ELF the spike verified (ENV-RECORD #4).
pub const CORE_PROGRAM: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
pub const CORE_SO_SHA256: &str = "515541c84caa71a2f142c603fc1e2372196825003e66126d1e824dd9213ea056";
/// The resident program's local test id: `sha256("wylls-resident-program id (test)")`.
pub const RESIDENT_ID_LABEL: &[u8] = b"wylls-resident-program id (test)";
pub const CORE_SO: &str = "permutation-nft-resident-spike/.local/programs/mpl_core.so";
pub const RESIDENT_SO: &str =
    "permutation-nft-resident-spike/program/target/deploy/wylls_resident_program.so";
pub const RESIDENT_RECORD: &str = "permutation-nft-resident-spike/program/BUILD-RECORD.json";
pub const SETUP_SCRIPT: &str = "permutation-nft-resident-spike/src/nft-world-setup.mjs";
pub const MINT_SCRIPT: &str = "permutation-nft-resident-spike/src/mint-demo.mjs";
/// The mint page's port: the localnet's + 80 (base + 90; no other stack offset uses it).
pub const MINT_PORT_FROM_LOCALNET: u16 = 80;

pub fn frontier_program() -> Address {
    Address::new_from_array(LOCALNET_NFT_PROGRAM_ID)
}

pub fn resident_program() -> Address {
    Address::new_from_array(Sha256::digest(RESIDENT_ID_LABEL).into())
}

/// The Frontier `.so` of an `--nft-pass` run carries the lane's marker.
pub fn check_lane_so(bytes: &[u8]) -> Result<(), String> {
    if bytes.windows(LANE_MARKER.len()).any(|w| w == LANE_MARKER) {
        Ok(())
    } else {
        Err("--nft-pass runs the Frontier NFT lane (marker PSF_LOCALNET_NFT_SBF_BUILD absent): scripts/build-frontier-localnet-nft-sbf.sh".into())
    }
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// The `soSha256` of the resident program's BUILD-RECORD.json (the build
/// `archive/program-artifact.mjs record` wrote), or None.
pub fn recorded_resident_sha(record: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(record).ok()?;
    v.get("soSha256")?.as_str().map(str::to_string)
}

#[derive(Clone, Debug)]
pub struct NftPass {
    pub core_so: PathBuf,
    pub resident_so: PathBuf,
    pub resident_so_len: usize,
    pub resident: Address,
    pub mint_port: u16,
}

impl NftPass {
    /// The run's NFT pass, or an error naming what is missing: Core's ELF must
    /// be the verified one, the resident program's the recorded build.
    pub fn load(repo: &Path, localnet_port: u16) -> Result<NftPass, String> {
        let core_so = run::resolve(repo, Path::new(CORE_SO));
        let core = std::fs::read(&core_so).map_err(|e| format!("{}: {e}", core_so.display()))?;
        if sha256_hex(&core) != CORE_SO_SHA256 {
            return Err(format!(
                "{}: not the verified Core ELF (sha256 {CORE_SO_SHA256})",
                core_so.display()
            ));
        }
        let resident_so = run::resolve(repo, Path::new(RESIDENT_SO));
        let res =
            std::fs::read(&resident_so).map_err(|e| format!("{}: {e}", resident_so.display()))?;
        let record_path = run::resolve(repo, Path::new(RESIDENT_RECORD));
        let record = std::fs::read_to_string(&record_path)
            .map_err(|e| format!("{}: {e}", record_path.display()))?;
        match recorded_resident_sha(&record) {
            Some(want) if want == sha256_hex(&res) => {}
            _ => {
                return Err(format!(
                    "{}: not the build {} records (node permutation-nft-resident-spike/archive/program-artifact.mjs status)",
                    resident_so.display(),
                    record_path.display()
                ))
            }
        }
        let mint_port = localnet_port
            .checked_add(MINT_PORT_FROM_LOCALNET)
            .ok_or("--nft-pass: no port for the mint page")?;
        crate::ports::check(mint_port)?;
        Ok(NftPass {
            core_so,
            resident_so,
            resident_so_len: res.len(),
            resident: resident_program(),
            mint_port,
        })
    }

    /// The localnet's extra `--program` arguments: Core without an upgrade
    /// authority, the resident program upgradeable by `authority` (its
    /// InitConfig is the upgrade authority's only).
    pub fn deploy_args(&self, authority: &Address) -> Vec<String> {
        vec![
            "--program".into(),
            format!("{CORE_PROGRAM}={}", self.core_so.display()),
            "--program".into(),
            format!(
                "{}={}:{}@{authority}",
                self.resident,
                self.resident_so.display(),
                fclient::fees::deploy_max_len(self.resident_so_len as u64)
            ),
        ]
    }

    /// The setup: one Node process that finishes (collection, config, the
    /// TEST sale, CreateResidentPolicy), signed by the run's operator key
    /// (both programs' upgrade authority), read from its seed file.
    pub fn setup_command(
        &self,
        repo: &Path,
        node: &Path,
        rd: &RunDir,
        rpc: &str,
        frontier: &Address,
    ) -> (PathBuf, Vec<String>) {
        (
            node.to_path_buf(),
            vec![
                run::resolve(repo, Path::new(SETUP_SCRIPT))
                    .display()
                    .to_string(),
                "--rpc".into(),
                rpc.into(),
                "--frontier".into(),
                frontier.to_string(),
                "--resident".into(),
                self.resident.to_string(),
                "--authority-seed-file".into(),
                rd.path("keys/operator.seed").display().to_string(),
                "--test-sale".into(),
            ],
        )
    }

    /// The mint page, attached read-only to the run's RPC.
    pub fn mint_spec(&self, repo: &Path, node: &Path, rd: &RunDir, rpc: &str) -> Spec {
        let script = run::resolve(repo, Path::new(MINT_SCRIPT));
        Spec {
            name: "mint".into(),
            program: node.to_path_buf(),
            args: vec![
                script.display().to_string(),
                "--rpc".into(),
                rpc.into(),
                "--program".into(),
                self.resident.to_string(),
                "--port".into(),
                self.mint_port.to_string(),
            ],
            env: vec![],
            cwd: script
                .ancestors()
                .nth(2)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| repo.to_path_buf()),
            log: rd.log("mint"),
            finishes: false,
        }
    }

    pub fn mint_url(&self) -> String {
        format!("http://127.0.0.1:{}/web/mint.html", self.mint_port)
    }

    /// The relay's extra arguments: the join screen's link to the mint page.
    pub fn relay_args(&self) -> Vec<String> {
        vec!["--mint-url".into(), self.mint_url()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_marker() {
        assert_eq!(frontier_program(), Address::new_from_array([0x4E; 32]));
        assert_eq!(
            resident_program().to_string(),
            "68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5"
        );
        assert!(check_lane_so(b"..PSF_LOCALNET_NFT_SBF_BUILD..").is_ok());
        assert!(check_lane_so(b"PSF_TEST_BEACON_BUILD").is_err());
        assert_eq!(
            recorded_resident_sha(r#"{"soSha256":"abc","soBytes":1}"#).as_deref(),
            Some("abc")
        );
        assert_eq!(recorded_resident_sha("not json"), None);
    }

    #[test]
    fn command_lines() {
        let p = NftPass {
            core_so: "/c.so".into(),
            resident_so: "/r.so".into(),
            resident_so_len: 165_360,
            resident: resident_program(),
            mint_port: 41_090,
        };
        let auth = Address::new_from_array([7; 32]);
        let d = p.deploy_args(&auth);
        assert_eq!(d[0], "--program");
        assert_eq!(d[1], format!("{CORE_PROGRAM}=/c.so"));
        assert!(d[3].starts_with("68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5=/r.so:"));
        assert!(d[3].ends_with(&format!("@{auth}")));
        assert_eq!(
            p.relay_args(),
            vec!["--mint-url", "http://127.0.0.1:41090/web/mint.html"]
        );
    }
}
