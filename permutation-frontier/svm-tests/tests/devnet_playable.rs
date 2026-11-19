//! The DEVNET build of the playable lane (`devnet-playable-sbf`, owner decision B7, 2026-11-18;
//! `scripts/build-frontier-devnet-playable-sbf.sh`), executed as a real SBF artefact in LiteSVM, deployed through
//! LoaderV3 at the harness's ordinary program id (`PSF_PROGRAM_ID`, else the fixed test id), which is NOT the
//! localnet lane's `[0x45; 32]`:
//!
//! - it runs a version-0x4804 season's real lifecycle there: AnnounceSeason, CreateSeason, InitBeaconLogs, six
//!   InitShards and ConsumeGenesisSeed with the real quicknet genesis round (BLS-verified by the syscalls), so the
//!   devnet build is id-agnostic and accepts exactly the lane's version;
//! - it refuses a version-4 (S1) season (it is not the S1 program);
//! - the localnet land lane's artefact, deployed at the same id, refuses every instruction (`BadAddress`): only the
//!   devnet build can run under a devnet program id;
//! - the bytes carry `PSF_DEVNET_PLAYABLE_BUILD` and neither localnet marker.
//!
//! Inputs: `PSF_SO_DEVNET_PLAYABLE` (else `permutation-frontier/target/deploy-devnet-playable-sbf/`) and
//! `PSF_SO_LOCALNET_LAND` (else `permutation-frontier/target/deploy-localnet-land-sbf/`); `run.sh` builds both.
//! No key file: the harness's keypairs are derived test keys in memory.

use permutation_frontier_svm_tests::chain::{
    assert_code, assert_refused, contains, expect_lands, program_id, repo_root, Build, Chain,
};
use permutation_frontier_svm_tests::world::{params_for, World};
use permutation_frontier_svm_tests::FrontierError as E;

const LANE_VERSION: u16 = 0x4804;

fn so(var: &str, dir: &str) -> Vec<u8> {
    let path = std::env::var(var)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            repo_root().join(format!(
                "permutation-frontier/target/{dir}/permutation_frontier.so"
            ))
        });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (set {var}, or build it: scripts/build-frontier-devnet-playable-sbf.sh / \
             scripts/build-frontier-localnet-land-sbf.sh; run.sh does both)",
            path.display()
        )
    })
}
fn devnet_so() -> Vec<u8> {
    so("PSF_SO_DEVNET_PLAYABLE", "deploy-devnet-playable-sbf")
}
fn land_so() -> Vec<u8> {
    so("PSF_SO_LOCALNET_LAND", "deploy-localnet-land-sbf")
}

/// The S1 preset at the lane's version (what the natural local world creates, `itest` natural_play.rs).
fn lane_world(c: &mut Chain, id: u64, version: u16) -> World {
    let mut p = params_for(c);
    p.program_version = version;
    World::with_params(c, id, p)
}

#[test]
fn devnet_playable_artefact_carries_only_its_own_marker() {
    let so = devnet_so();
    assert!(contains(&so, b"PSF_DEVNET_PLAYABLE_BUILD"));
    for m in [
        &b"PSF_LOCALNET_EXPEDITION_SBF_BUILD"[..],
        b"PSF_LOCALNET_CONQUEST_SBF_BUILD",
        // (TEST-only localnet wide -> wide march gate, `localnet-wide-depart`: never in the devnet build)
        b"PSF_LOCALNET_WIDE_DEPART_BUILD",
        b"PSF_TEST_BEACON_BUILD",
        b"PSF_ORACLE_BUILD",
        b"PSF_TRACE_BUILD",
        b"PSF_RIGHTS_EXPERIMENTAL_BUILD",
        b"PSF_CUSTODY_PREVIEW_BUILD",
    ] {
        assert!(!contains(&so, m), "{}", String::from_utf8_lossy(m));
    }
    assert_ne!(
        program_id().to_bytes(),
        [0x45; 32],
        "the harness id is not the localnet lane's"
    );
}

#[test]
fn devnet_playable_runs_a_lane_season_lifecycle_at_an_ordinary_program_id() {
    let so = devnet_so();
    // Build::Release: the real quicknet key and fixtures (the devnet build has no test beacon).
    let mut c = Chain::with_program(Build::Release, &so, program_id());
    let w = lane_world(&mut c, 7, LANE_VERSION);
    expect_lands(w.announce(&mut c), "AnnounceSeason (0x4804)");
    expect_lands(w.create(&mut c), "CreateSeason (0x4804)");
    expect_lands(w.init_logs(&mut c), "InitBeaconLogs");
    for f in 0..6 {
        expect_lands(w.init_shards(&mut c, f), "InitShards");
    }
    expect_lands(
        w.consume_genesis(&mut c),
        "ConsumeGenesisSeed (real quicknet round)",
    );
}

#[test]
fn devnet_playable_refuses_an_s1_season() {
    let so = devnet_so();
    let mut c = Chain::with_program(Build::Release, &so, program_id());
    let w = lane_world(&mut c, 8, frontier_abi::v2::presets::PROGRAM_VERSION_S1);
    // AnnounceSeason commits to the parameters' hash only; CreateSeason checks the version.
    expect_lands(w.announce(&mut c), "AnnounceSeason");
    assert_refused(
        w.create(&mut c),
        "CreateSeason of a version-4 season on the 0x4804 build",
    );
}

#[test]
fn the_localnet_land_artefact_refuses_everything_at_the_same_id() {
    let so = land_so();
    assert!(contains(&so, b"PSF_LOCALNET_EXPEDITION_SBF_BUILD"));
    assert!(!contains(&so, b"PSF_DEVNET_PLAYABLE_BUILD"));
    let mut c = Chain::with_program(Build::Release, &so, program_id());
    let w = lane_world(&mut c, 9, LANE_VERSION);
    assert_code(w.announce(&mut c), E::BadAddress);
}
