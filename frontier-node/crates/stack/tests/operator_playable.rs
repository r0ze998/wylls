//! `frontier-operator --preset S1_DEVNET_WIDE_7D` (devnet blocker B3, owner decision B7: the PLAYABLE lane), on
//! loopback only (ports 41450–41459), with TEST keys generated here and funded only on this in-process
//! frontier-localnet. Nothing here contacts devnet, mainnet or drand's public API.
//!
//! - P1 (key-free) the offline plan of the COMMITTED `scripts/devnet/devnet-playable-profile.json` (its placeholders
//!   replaced by fixed addresses) is the committed snapshot: 10 transactions, the last WideSetRules after Seeded;
//! - P2 (key-free) the send gate on the committed profile's devnet URL: `--yes-send` without
//!   `--i-have-r0ze-approval` / `--approved-sha256` is refused before any key is read or any host contacted;
//! - P3 the exact devnet `.so` (the committed fixture `frontier-node/fixtures/verify/devnet-playable-67a33c92.so.gz`,
//!   sha256 `67a33c92…06b3`, P14 b: no Free City conquest kinds, the artefact `scripts/build-frontier-devnet-playable-sbf.sh` builds) deployed in an
//!   in-process frontier-localnet, then the operator in SEND mode with the flags r0ze would pass on devnet
//!   (`--rpc` pointed at the local node): dry run, a wrong `--approved-sha256` refused, AnnounceSeason, the lead,
//!   CreateSeason + InitBeaconLogs + InitShards × 6, a wait for Seeded; then the REAL `frontier-keeper` (roles
//!   beacon, rings, fold; `feed = "rpc"`, the devnet profile's rings duty) with a local `drand-replay` serving the
//!   32 committed REAL quicknet rounds (the season's `t_create_min` is chosen so its genesis round is one of them)
//!   seeds the season and opens the genesis rings; the operator's WideSetRules lands; a re-run sends nothing; a test
//!   participant Joins and places a first home in the heartland. Every transaction's compute units and lamports are
//!   recorded (`OPERATOR_EVIDENCE_DIR` writes them out).
//!
//! The keeper, drand-replay and herald binaries: `FRONTIER_KEEPER_BIN`, `DRAND_REPLAY_BIN`, else the operator's
//! own target directory (`cargo build -p keeper -p drand-replay` first).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fclient::addr::Addresses;
use fclient::{ix, Address, Keypair, Signer};
use frontier_stack::chain::{Chain, MAX_LOADED_LIMIT};
use frontier_stack::operator;
use serde_json::{json, Value};

#[path = "operator_playable/rim.rs"]
mod rim;
#[path = "operator_playable/watch.rs"]
mod watch;

/// P3's ports (RPC, its WebSocket at +1, drand-replay +2, keeper API +3, herald +5); P4 takes [`P4_PORT_BASE`].
/// `OPERATOR_PLAYABLE_PORT_BASE` / `OPERATOR_RIM_PORT_BASE` move them.
const P3_PORT_BASE: u16 = 41_450;
const P4_PORT_BASE: u16 = 41_560;
/// P5's (`OPERATOR_WIDE_KEEPER_PORT_BASE` moves them).
const P5_PORT_BASE: u16 = 41_590;
/// P6's (devnet gap P8; `OPERATOR_P8_PORT_BASE` moves them).
const P6_PORT_BASE: u16 = 41_650;
/// P7's (`OPERATOR_PAGE_PORT_BASE` moves them): the page path also takes the gateway (+6 operator, +7 public) and the
/// driver's inspection listener (+8).
const P7_PORT_BASE: u16 = 41_700;
/// P8's (`OPERATOR_WAR_PORT_BASE` moves them): the legacy war with a test participant (devnet-page-war).
const P8_PORT_BASE: u16 = 41_950;
/// P9's (`OPERATOR_PAGE_WAR_PORT_BASE` moves them): the legacy war with the page as the participant; as P7 (+6/+7
/// gateway, +8 inspection). Never 41970: the gateway's offline RPC refuses it.
const P9_PORT_BASE: u16 = 41_960;
/// P10's (`OPERATOR_PAGE_HOME_PORT_BASE` moves them): the page's return march home and keeper A's outages; as P9.
const P10_PORT_BASE: u16 = 41_575;
/// P11's (`OPERATOR_EXPEDITION_PORT_BASE` moves them): the rim → wide expedition with a test participant
/// (devnet-expedition-keeper; devnet gaps P10 + P13).
const P11_PORT_BASE: u16 = 41_500;
/// P14's (`OPERATOR_CONQUEST_PORT_BASE` moves them): P11, then a third party's wide Free City conquest
/// (devnet-guard-conquest; devnet gap P14 option a). Not 41650 (P6's default).
const P14_PORT_BASE: u16 = 41_670;
/// P12's (`OPERATOR_PAGE_EXPEDITION_PORT_BASE` moves them): P11 with the page sending the Depart; as P9 (+6/+7
/// gateway, +8 inspection) (devnet-p15-p9).
const P12_PORT_BASE: u16 = 41_520;
/// PFOG's (fog-devnet; `OPERATOR_PAGE_FOG_PORT_BASE` moves them): as P9 (+6/+7 gateway, +8 inspection).
const PFOG_PORT_BASE: u16 = 41_720;
/// PPROV's (devnet-open-province; `OPERATOR_PROVINCES_PORT_BASE` moves them).
const PPROV_PORT_BASE: u16 = 41_540;
/// PPROV: keeper A's `provinces_reach` (the devnet profile's value, the preset's `outpost_range`).
const PPROV_REACH: u16 = 3;
/// PFLOOR's (keeper-rent-floor; `OPERATOR_FLOOR_5080_PORT_BASE` / `OPERATOR_FLOOR_6960_PORT_BASE` move them).
const PFLOOR_5080_PORT_BASE: u16 = 41_510;
const PFLOOR_6960_PORT_BASE: u16 = 41_530;
/// PPOST's (devnet-page-outpost; `OPERATOR_PAGE_OUTPOST_PORT_BASE` moves them): as P7 (+6/+7 gateway, +8 inspection).
const PPOST_PORT_BASE: u16 = 41_610;
/// PV0's (herald-v0v1-decode; `OPERATOR_V0_PORT_BASE` moves them).
const PV0_PORT_BASE: u16 = 41_680;
/// P17's (devnet-p17; `OPERATOR_PAGE_WIDE_ACTS_PORT_BASE` moves them): as P7 (+6/+7 gateway, +8 inspection). Shares
/// P11's default base: set the variable to run both at once.
const P17_PORT_BASE: u16 = 41_500;
/// P18's (devnet-territory-dev; `OPERATOR_PAGE_TERRITORY_PORT_BASE` moves them): as P7 (+6/+7 gateway, +8 inspection),
/// inside the run's brief range 41610–41649.
const P18_PORT_BASE: u16 = 41_620;
/// PWATCH's (world3-verifier-watch; `OPERATOR_WATCH_PORT_BASE` moves them): RPC +0/+1, drand +2, keeper API +3,
/// herald +5, inside the run's brief range 41700–41749 (P7's default base: set the variable to run both at once).
const PWATCH_PORT_BASE: u16 = 41_700;
/// PCAP's (devnet-72bell-pair; `OPERATOR_PAGE_CAPTURE_PORT_BASE` moves them): as P9 (+6/+7 gateway, +8 inspection).
const PCAP_PORT_BASE: u16 = 41_780;
/// PPAIR's (devnet-72bell-pair; `OPERATOR_PAGE_PAIR_PORT_BASE` moves them): as P9.
const PPAIR_PORT_BASE: u16 = 41_790;
/// PLOAD (herald-load-50): ports 41500–41508 (`OPERATOR_LOAD_PORT_BASE`).
const PLOAD_PORT_BASE: u16 = 41_500;
/// PEND's (devnet-end-season; `OPERATOR_END_PORT_BASE` moves them): RPC +0/+1, drand +2, keeper API +3, herald +5.
const PEND_PORT_BASE: u16 = 41_540;
/// PGWF's (fix-gw-highs; `OPERATOR_GW_FLOOD_PORT_BASE` moves them): as P8 plus the gateway (+6 operator, +7 public).
const PGWF_PORT_BASE: u16 = 41_600;

#[derive(Clone, Copy)]
struct Ports {
    rpc: u16,
    drand: u16,
    keeper_api: u16,
    herald: u16,
}

fn ports(env: &str, default: u16) -> Ports {
    let b = std::env::var(env)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default);
    Ports {
        rpc: b,
        drand: b + 2,
        keeper_api: b + 3,
        herald: b + 5,
    }
}
const SOL: u64 = 1_000_000_000;
/// sha256 of the devnet build of the playable lane (P14 b, reports/p14b-drop-conquest.md; the committed verifier fixture).
const DEVNET_SO_SHA256: &str = "67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3";
/// The same program's `program_hash` (trailing zeros stripped; `solana-verify`'s form, printed by the build script).
const DEVNET_PROGRAM_HASH: &str =
    "8dcaef873758b981df191a33f5e38bfb90afbf9ae673d2589641adf9f40174bb";
/// The first of the 32 committed real quicknet rounds (`fclient/fixtures/quicknet`): the genesis round.
const GENESIS_ROUND: u64 = 32_551_361;
/// P8/P9 (devnet-page-war): a later shipped genesis round, so that the arrival bell [`rim::war::ARRIVE_BELL`]'s
/// time-lock round T(21) = genesis + 200 · 23 = 32 556 349 is a REAL quicknet round (the S-TLOCK q4 vector's
/// `prev_round_sig`, as `verify/tests/playable_march.rs`): keeper A then anchors that bell and opens the march's seal
/// from the public round itself, as on devnet.
const WAR_GENESIS_ROUND: u64 = 32_551_749;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

/// Removes a test directory (with its TEST key files) even when a test panics.
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Kills a child process this test started (never anything else) on drop.
struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "frontier-operator-playable-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// P14 (a)'s run (`Mode::Conquest`, devnet-guard-conquest) sends the Free City conquest kinds 12..=18, which the
/// devnet `.so` of P14 (b) refuses `BadData` (`verify/tests/p14b_devnet_no_conquest.rs`). So that run alone keeps
/// the PREVIOUS devnet build, which still carries them (the committed `devnet-playable-da3dc1aa.so.gz`): keeper A's
/// exact reading of the conquest records stays proven as defence in depth. Every other run uses the new `.so`.
const DEVNET_SO_WITH_CONQUEST_SHA256: &str =
    "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";
const DEVNET_PROGRAM_HASH_WITH_CONQUEST: &str =
    "786ef80f132a9d2d18afc5708336a396afba32ff3d4c37ebf6c94425a51352df";

/// (sha256, solana-verify program hash, ELF length as the operator prints it) of the devnet `.so` a run deploys.
fn devnet_build(conquest: bool) -> (&'static str, &'static str, &'static str) {
    if conquest {
        (
            DEVNET_SO_WITH_CONQUEST_SHA256,
            DEVNET_PROGRAM_HASH_WITH_CONQUEST,
            "3,657,488",
        )
    } else {
        (DEVNET_SO_SHA256, DEVNET_PROGRAM_HASH, "3,447,064")
    }
}

/// P18 (devnet-territory-dev): the NEW devnet `.so` a run deploys, from `OPERATOR_TERRITORY_SO` (the build of
/// `scripts/build-frontier-devnet-playable-sbf.sh` on the commit under test; not committed: it changes with main) →
/// (bytes, sha256, solana-verify program hash, the ELF length as the operator prints it). `None` when unset.
fn territory_so() -> Option<(Vec<u8>, &'static str, &'static str, &'static str)> {
    let p = std::env::var("OPERATOR_TERRITORY_SO")
        .ok()
        .filter(|p| !p.is_empty())?;
    let so = std::fs::read(&p).unwrap_or_else(|e| panic!("OPERATOR_TERRITORY_SO {p}: {e}"));
    let sha = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&so));
    // (solana-verify's hash: the ELF with its trailing zero bytes stripped)
    let n = so.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    let ph = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&so[..n]));
    let len = so.len().to_string();
    let mut grouped = String::new();
    for (i, ch) in len.chars().enumerate() {
        if i > 0 && (len.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Some((so, leak(sha), leak(ph), leak(grouped)))
}

/// P18 (devnet-territory-dev): the COMMITTED new-world profile (scripts/devnet/devnet-new-world-profile.json: preset
/// S1_DEVNET_TERRITORY, wide.keepHolder NeutralTerritoryV1) with its program and authority filled, and the operator's
/// season id 1 of this fresh chain (the harness's Addresses; on devnet it is 3). Nothing else changed.
fn territory_profile(dir: &Path, program: &str, authority: &str) -> PathBuf {
    let text =
        std::fs::read_to_string(repo_root().join("scripts/devnet/devnet-new-world-profile.json"))
            .unwrap();
    let mut v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["season"]["preset"], "S1_DEVNET_TERRITORY");
    assert_eq!(v["wide"]["keepHolder"], "NeutralTerritoryV1");
    assert_eq!(
        v["operator"]["seasonId"], 3,
        "the new world is on-chain id 3 (owner NWP-4)"
    );
    v["programId"] = json!(program);
    v["upgradeAuthority"] = json!(authority);
    v["operator"]["seasonId"] = json!(1);
    let p = dir.join("profile.json");
    std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    p
}

fn devnet_so_of(conquest: bool) -> Vec<u8> {
    use std::io::Read;
    let (sha, _, _) = devnet_build(conquest);
    let p = repo_root().join(format!(
        "frontier-node/fixtures/verify/devnet-playable-{}.so.gz",
        &sha[..8]
    ));
    let mut out = vec![];
    flate2::read::GzDecoder::new(
        std::fs::File::open(&p).expect("the committed devnet .so fixture"),
    )
    .read_to_end(&mut out)
    .unwrap();
    let h = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&out));
    assert_eq!(h, sha, "the fixture is the expected devnet artefact");
    out
}

fn sibling_bin(env: &str, name: &str) -> PathBuf {
    if let Ok(p) = std::env::var(env) {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let p = Path::new(env!("CARGO_BIN_EXE_frontier-operator"))
        .parent()
        .unwrap()
        .join(name);
    assert!(
        p.exists(),
        "{}: missing; build it first (`cargo build --locked -p keeper -p drand-replay`, same profile) or set {env}",
        p.display()
    );
    p
}

/// A TEST key file in the Solana CLI format, mode 600.
fn write_key(dir: &Path, name: &str, k: &Keypair) -> PathBuf {
    let p = dir.join(name);
    let bytes: Vec<String> = k.to_bytes().iter().map(|b| b.to_string()).collect();
    std::fs::write(&p, format!("[{}]", bytes.join(","))).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    p
}

/// The COMMITTED playable profile with its two placeholders filled (and nothing else changed unless `rpc` is given).
fn playable_profile(dir: &Path, program: &str, authority: &str, rpc: Option<&str>) -> PathBuf {
    let text =
        std::fs::read_to_string(repo_root().join("scripts/devnet/devnet-playable-profile.json"))
            .unwrap();
    let mut v: Value = serde_json::from_str(&text).unwrap();
    // devnet-continuous-1: the devnet world is the continuous preset, season 2 (season 1 was announced 7-day).
    assert_eq!(v["season"]["preset"], "S1_DEVNET_WIDE_CONTINUOUS");
    assert_eq!(v["program"]["programVersion"], "0x4804");
    assert_eq!(
        v["operator"]["seasonId"], 2,
        "the playable profile has its operator block"
    );
    v["programId"] = json!(program);
    v["upgradeAuthority"] = json!(authority);
    if let Some(r) = rpc {
        v["rpcUrl"] = json!(r);
    }
    let p = dir.join("profile.json");
    std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    p
}

/// [`playable_profile`] as the FINITE 7-day world, season 1 (`S1_DEVNET_WIDE_7D`): the loopback seasons below
/// (P3 onwards, PEND's end and clean-up) run a season that can end; only the preset and the id differ from the
/// committed continuous profile (`continuous` changes three bytes, devnet_preset_wide.rs covers it on the .so).
fn finite_playable_profile(
    dir: &Path,
    program: &str,
    authority: &str,
    rpc: Option<&str>,
) -> PathBuf {
    let p = playable_profile(dir, program, authority, rpc);
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    v["season"]["preset"] = json!("S1_DEVNET_WIDE_7D");
    v["operator"]["seasonId"] = json!(1);
    std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    p
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn op(args: Vec<String>) -> Run {
    tokio::task::spawn_blocking(move || {
        let o = Command::new(env!("CARGO_BIN_EXE_frontier-operator"))
            .args(&args)
            .output()
            .expect("frontier-operator");
        Run {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }
    })
    .await
    .unwrap()
}

/// `GET http://127.0.0.1:port{path}` → its JSON body (`None` unless 200 and JSON).
fn http_get(port: u16, path: &str) -> Option<Value> {
    use std::io::{Read, Write};
    let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
    c.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        c,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut b = vec![];
    c.read_to_end(&mut b).ok()?;
    let t = String::from_utf8_lossy(&b);
    let (head, body) = t.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        // (one or more chunks: keep the data lines)
        body.split("\r\n")
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, x)| x)
            .collect::<String>()
    } else {
        body.to_string()
    };
    serde_json::from_str(&body).ok()
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// P1: the offline plan of the committed playable profile. `UPDATE_SNAPSHOTS=1` rewrites it.
#[tokio::test]
async fn p1_offline_plan_of_the_committed_playable_profile() {
    let dir = tmpdir("p1");
    let _c = Cleanup(dir.clone());
    let program = Address::new_from_array([0x11; 32]).to_string();
    let authority = Address::new_from_array([0x22; 32]).to_string();
    let prof = playable_profile(&dir, &program, &authority, None);
    let p = prof.to_str().unwrap();
    let r = op(args(&["--profile", p, "--offline"])).await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    let snap = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots/operator-playable-offline-plan.txt");
    if std::env::var("UPDATE_SNAPSHOTS").is_ok_and(|v| v == "1") {
        std::fs::write(&snap, &r.stdout).unwrap();
    }
    let want = std::fs::read_to_string(&snap).expect("the snapshot (UPDATE_SNAPSHOTS=1 writes it)");
    assert_eq!(r.stdout, want, "the playable offline plan changed");
    assert_eq!(r.stdout.matches("\ntx ").count(), 10);
    assert!(r.stdout.contains("preset S1_DEVNET_WIDE_CONTINUOUS"));
    assert!(r.stdout.contains("season     id 2 "));
    assert!(r
        .stdout
        .contains("lane       playable (program_version 0x4804"));
    assert!(r
        .stdout
        .contains("tx 10 WideSetRules  [after keeper A's ConsumeGenesisSeed"));
    assert!(r.stdout.contains("5080 lamports/byte"));
    // The CreateSeason bytes are the preset's at 0x4804 (the plan prints their sha256).
    let mut sp = frontier_abi::v2::presets::S1_DEVNET_WIDE_CONTINUOUS;
    sp.base.program_version = operator::PLAYABLE_VERSION;
    let sb = operator::lane_bytes(&sp).unwrap();
    assert!(
        r.stdout.contains(&hex::encode(sb.params_hash)),
        "{}",
        r.stdout
    );
    // A chosen t_create_min prints the genesis round it fixes; --preset overrides the profile's.
    let t = align(GENESIS_ROUND);
    let r = op(args(&[
        "--profile",
        p,
        "--offline",
        "--t-create-min",
        &t.to_string(),
    ]))
    .await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(
        r.stdout
            .contains(&format!("genesis    round {GENESIS_ROUND} ")),
        "{}",
        r.stdout
    );
    let r = op(args(&[
        "--profile",
        p,
        "--offline",
        "--preset",
        "S1_LOCAL_7D",
    ]))
    .await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert!(r.stdout.contains("preset S1_LOCAL_7D"));
    assert!(
        !r.stdout.contains("WideSetRules"),
        "an S1 preset has no wide step"
    );
    let r = op(args(&[
        "--profile",
        p,
        "--offline",
        "--preset",
        "MC_LOCAL_7D",
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
}

/// P2: the send gate on the committed profile's devnet URL, before any key or host.
#[tokio::test]
async fn p2_public_send_needs_approval_and_hash_before_anything() {
    let dir = tmpdir("p2");
    let _c = Cleanup(dir.clone());
    let program = Address::new_from_array([0x11; 32]).to_string();
    let authority = Address::new_from_array([0x22; 32]).to_string();
    let prof = playable_profile(&dir, &program, &authority, None);
    let p = prof.to_str().unwrap();
    let missing = dir.join("no-such-key.json");
    let k = missing.to_str().unwrap();
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
    assert!(r.stderr.contains("SEND GATE: CLOSED"), "{}", r.stderr);
    assert!(
        r.stderr.contains("--i-have-r0ze-approval is not given"),
        "{}",
        r.stderr
    );
    assert!(r.stderr.contains("--approved-sha256"), "{}", r.stderr);
    assert!(
        r.stderr.contains("nothing was read or sent"),
        "{}",
        r.stderr
    );
    let r = op(args(&[
        "--profile",
        p,
        "--authority",
        k,
        "--yes-send",
        "--i-have-r0ze-approval",
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(
        !r.stderr.contains("r0ze-approval is not given"),
        "{}",
        r.stderr
    );
    assert!(r.stderr.contains("--approved-sha256"), "{}", r.stderr);
    // With both, the next check is the key file (not found): still nothing contacted.
    let r = op(args(&[
        "--profile",
        p,
        "--authority",
        k,
        "--yes-send",
        "--i-have-r0ze-approval",
        "--approved-sha256",
        DEVNET_SO_SHA256,
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(r.stderr.contains("not found"), "{}", r.stderr);
    // The flags belong to a send; a bad hash is refused as an argument.
    let r = op(args(&["--profile", p, "--i-have-r0ze-approval"])).await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
    let r = op(args(&[
        "--profile",
        p,
        "--yes-send",
        "--authority",
        k,
        "--approved-sha256",
        "abc",
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
}

/// The real quicknet rounds this repository ships with their signatures — `fclient/fixtures/quicknet` (32 rounds) and
/// the S-TLOCK vectors' rounds and previous rounds — each checked against quicknet's public key (no key is generated,
/// derived or used to sign: only public signatures verified).
fn shipped_real_rounds() -> std::collections::BTreeSet<u64> {
    let pk = fclient::beacon::quicknet_info().public_key;
    let mut out = std::collections::BTreeSet::new();
    let mut take = |round: u64, sig_hex: &str| {
        let sig: [u8; 48] = hex::decode(sig_hex).unwrap().try_into().unwrap();
        assert!(
            fclient::beacon::verify(round, &sig, &pk),
            "round {round}: a real quicknet signature"
        );
        out.insert(round);
    };
    let dir = repo_root().join("frontier-node/crates/fclient/fixtures/quicknet");
    for e in std::fs::read_dir(dir).unwrap() {
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(e.unwrap().path()).unwrap()).unwrap();
        take(
            v["round"].as_u64().unwrap(),
            v["signature"].as_str().unwrap(),
        );
    }
    for f in ["q3-vector.json", "q4-vector.json"] {
        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(fclient::seal::fixture_dir().join(f)).unwrap(),
        )
        .unwrap();
        let r = v["round"].as_u64().unwrap();
        take(r, v["sig"].as_str().unwrap());
        take(r - 1, v["prev_round_sig"].as_str().unwrap());
    }
    out
}

/// The arrival bells `b ≥ 2` of a season whose genesis round is `g` (devnet preset clock) with a real time-lock round
/// T(b) among `real`.
fn real_arrival_bells(g: u64, real: &std::collections::BTreeSet<u64>) -> Vec<u32> {
    let sp = &frontier_abi::v2::presets::S1_DEVNET_WIDE_7D;
    let (round, genesis_ts) = operator::genesis_of(sp, align(g));
    assert_eq!(round, g);
    let clock = permutation_rules::frontier::clash::BeaconClock {
        genesis: sp.base.drand_genesis,
        period: sp.base.drand_period as i64,
    };
    (2..=1_008u32)
        .filter(|&b| {
            real.contains(&permutation_rules::frontier::beacon::tlock_round(
                &clock, genesis_ts, b,
            ))
        })
        .collect()
}

/// PKF (devnet-72bell-pair; key-free, in PR CI): why PPAIR's OUT leg is sealed to the TEST beacon key. Offline, the
/// only real quicknet signatures are the shipped ones; a march settles (SettleTransit) only over its arrival bell's
/// anchor signature. For EVERY shipped round as the season's genesis (the operator binds a real one), at most ONE later
/// bell of a whole 7-day season has a real time-lock round — the war genesis's bell 21 (T(21) = 32 556 349) among them.
/// So no offline season can settle two real sealed marches: one leg of an out-and-back pair must be declared.
#[test]
fn pkf_offline_a_season_has_at_most_one_real_arrival_round() {
    let real = shipped_real_rounds();
    assert!(real.len() >= 36, "{real:?}");
    let mut most = 0usize;
    for &g in real.iter().filter(|&&g| g <= 32_553_016) {
        let bells = real_arrival_bells(g, &real);
        most = most.max(bells.len());
        assert!(
            bells.len() <= 1,
            "genesis {g}: real arrival bells {bells:?} (a fully real pair would be possible)"
        );
    }
    assert_eq!(most, 1);
    assert_eq!(
        real_arrival_bells(WAR_GENESIS_ROUND, &real),
        vec![rim::war::ARRIVE_BELL],
        "the war genesis's one real arrival bell"
    );
    // (and one host rests 28 bells between two sealed Departs: a pair can never fit around bell 21 alone)
    assert_eq!(rim::war::PAIR_REST_BELLS, 28);
}

/// `t_create_min` whose genesis round is `round` (svm-tests `Beacons::align`).
fn align(round: u64) -> i64 {
    let p = frontier_abi::v2::presets::S1_DEVNET_WIDE_7D.base;
    let t = permutation_rules::frontier::beacon::round_time(p.drand_genesis, p.drand_period, round)
        - permutation_rules::frontier::beacon::SEED_LEAD_SECS
        - p.seed_margin as i64;
    assert_eq!(
        operator::genesis_of(&frontier_abi::v2::presets::S1_DEVNET_WIDE_7D, t).0,
        round
    );
    t
}

fn total_of(stdout: &str) -> u64 {
    let l = stdout
        .lines()
        .find(|l| l.starts_with("total "))
        .expect("total line");
    l.split(" = ")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap()
        .replace(',', "")
        .parse()
        .unwrap()
}

fn landed_lines(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter(|l| l.starts_with("landed "))
        .map(str::to_string)
        .collect()
}

/// The name of a landed transaction's first program instruction.
fn ix_name(wire: &[u8], program: &Address) -> String {
    // (PV0: legacy, v0 and v1 alike; a program id is always a static key)
    let Ok(t) = fclient::vtx::decode(wire) else {
        return "?".into();
    };
    for i in &t.instructions {
        if t.static_keys.get(i.program_id_index as usize) == Some(program) {
            let tag = i.data.first().copied().unwrap_or(0);
            // (P10: the expedition wrapper's dispatch kind, e.g. `ExpeditionSettleOrigin`)
            if let Ok(c) =
                frontier_abi::world_index::expedition_dispatch_ix::Command::decode(&i.data)
            {
                return format!("Expedition{:?}", c.kind());
            }
            if let Ok(frontier_abi::world_index::wide_ix::WideCommand::Resolve(_)) =
                frontier_abi::world_index::wide_ix::WideCommand::decode(&i.data)
            {
                return "WideResolve".into();
            }
            return match tag {
                0xD6..=0xDF => format!("wide 0x{tag:02x}"),
                _ => frontier_abi::v2::Ix::from_tag(tag)
                    .map(|x| x.name().to_string())
                    .unwrap_or(format!("0x{tag:02x}")),
            };
        }
    }
    "?".into()
}

/// P3: the season of the playable lane on the exact devnet `.so`, set up by the operator in send mode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p3_operator_starts_a_playable_season_on_the_devnet_so_offline() {
    playable_season(
        ports("OPERATOR_PLAYABLE_PORT_BASE", P3_PORT_BASE),
        Mode::Setup,
    )
    .await;
}

/// PV0 (herald-v0v1-decode): P3 with the test participant's wallet sending VERSIONED transactions, as wallets and
/// bots may on devnet (B5 measured v0 and v1 there): its Join as a **v1** transaction (SIMD-0385, its compute
/// budget in the config mask) and its PlaceHome as a **v0** transaction through the wallet's OWN address lookup
/// table, created, extended and used by `@solana/web3.js` 1.99 (`tests/operator_playable/v0_wallet.mjs`) — every
/// account of the PlaceHome but the wallet itself (Season, Citizen, Province, Holding, …) is a looked-up address.
/// The herald in its devnet mode (`--source rpc --cluster devnet`, findex `Enriched`: no post-state from the
/// node) must show the home from `meta.loadedAddresses` with no `badRecords` alarm. Needs `node` and the gateway's
/// npm packages (`npm ci` in permutation-gateway); without them it is skipped unless `PSF_REQUIRE_WEB3=1`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pv0_a_wallets_v0_and_v1_transactions_reach_the_herald_on_the_devnet_so_offline() {
    let gw = repo_root().join("permutation-gateway");
    if !gw
        .join("node_modules/@solana/web3.js/package.json")
        .exists()
    {
        assert!(
            std::env::var("PSF_REQUIRE_WEB3").ok().as_deref() != Some("1"),
            "pv0: permutation-gateway/node_modules missing (npm ci)"
        );
        eprintln!("pv0: skipped (npm ci in permutation-gateway: needs @solana/web3.js)");
        return;
    }
    playable_season(
        ports("OPERATOR_V0_PORT_BASE", PV0_PORT_BASE),
        Mode::Versioned,
    )
    .await;
}

/// PLOAD (herald-load-50): P7's devnet stack held open for a load test of the herald and the gateway (50–100
/// players). TEST/local only, `OPERATOR_LOAD_HOLD=1` (skipped otherwise): writes `$OPERATOR_LOAD_DIR/stack.json`
/// (ports, program, TEST wallet seeds) and runs until `$OPERATOR_LOAD_DIR/stop` exists ([`rim::load`]).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pload_the_devnet_stack_held_open_for_a_load_test_offline() {
    if std::env::var("OPERATOR_LOAD_HOLD").ok().as_deref() != Some("1") {
        eprintln!("pload: skipped (set OPERATOR_LOAD_HOLD=1 and OPERATOR_LOAD_DIR)");
        return;
    }
    playable_season(
        ports("OPERATOR_LOAD_PORT_BASE", PLOAD_PORT_BASE),
        Mode::Load,
    )
    .await;
}

/// P4 (owner Q-W1, 2026-11-20): P3, then a FIRST VILLAGE ON THE RIM and a wide claim from it, on the devnet `.so`
/// with the keeper roles a devnet season would run (module doc of [`rim`]).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p4_a_rim_first_village_and_a_wide_claim_on_the_devnet_so_offline() {
    playable_season(ports("OPERATOR_RIM_PORT_BASE", P4_PORT_BASE), Mode::Rim).await;
}

/// P5 (devnet runbook gaps P6 + P7): P4 with keeper A's new duties: its rings duty opens the wide rings 129–131
/// (`wide_rings` 3, `wide_per_wedge` 6) and its `wide-tickets` role settles and finalizes the wide claim; no wide
/// ring, settle or finalize instruction is sent by the test. Needs keeper A built with `--features playable-lane`
/// (`cargo build --locked -p keeper --features playable-lane -p drand-replay -p herald`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p5_keeper_a_opens_the_wide_rings_and_settles_the_wide_claim_offline() {
    playable_season(
        ports("OPERATOR_WIDE_KEEPER_PORT_BASE", P5_PORT_BASE),
        Mode::KeeperWide,
    )
    .await;
}

/// P6 (devnet gap P8): P5, then the wide village ACTS after its claim is final — WideEconomy Harvest, Build, walls
/// (the province mirror), Train, WideGarrison, WideMuster: each logs a `PSW1` record, which latched keeper A's feed
/// guard for good before P8 — and keeper A keeps every duty: its `tickets` role settles a new rim ticket, its
/// `wide-tickets` role settles and finalizes a slot-3 wide claim, after a restart (which re-reads the whole feed,
/// the PSW1 records included) its rings duty requests ring 132's seed (`wide_rings` 4), and its `fold` role folds
/// every bell of a window of [`rim::P8_BELLS`] bells. The verifier's VWL judges the wide economy segment and the
/// slot-3 claim segment. Same build as P5.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p6_keeper_a_keeps_every_duty_after_the_wide_village_acts_offline() {
    playable_season(
        ports("OPERATOR_P8_PORT_BASE", P6_PORT_BASE),
        Mode::AfterWide,
    )
    .await;
}

/// P7 (devnet gap P1, B7 client side): P5's world, and the WEB PAGE as the participant — served by the herald in its
/// devnet mode, sending through the gateway's devnet play routes (wallet-signed, wallet-paid), the way a devnet page
/// would against an https RPC. Needs `node`, the gateway's npm packages and `permutation-gateway/screens`'
/// playwright-core with its Chromium, and the herald built with `--features wide-world-experimental,expedition-records-experimental`
/// (as play-local builds it); runs only when `DEVNET_PAGE_DRIVER=1` (skipped otherwise: CI has no browser).
/// `OPERATOR_EVIDENCE_DIR` keeps the stills (`p7-page/`) and the summary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p7_the_page_plays_a_rim_village_and_a_wide_claim_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("p7: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(ports("OPERATOR_PAGE_PORT_BASE", P7_PORT_BASE), Mode::Page).await;
}

/// P8 (devnet-page-war): a LEGACY WAR on the devnet `.so`, offline, with keeper A configured as the devnet profile
/// now says (its play roles: `reveal`, `settle-departure`, `gather`, `resolve`, `skip`, `settle`, `close`,
/// `claims`). A test participant founds its rim village (as P4), musters 400 and sends ONE sealed Depart onto the
/// contestable keep of a neighbouring rim province, arriving at bell 21 whose time-lock round is a real one; keeper A
/// anchors that bell, opens the seal from the public round, reveals, gathers, resolves the clash, settles the
/// transit, holds the keep's bells, and settles the host's return. The test sends no keeper instruction; it declares
/// the anchors and seeds of the bells no shipped round covers ([`rim::war`]). Same build as P5.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p8_keeper_a_plays_a_legacy_war_on_the_devnet_so_offline() {
    playable_season(ports("OPERATOR_WAR_PORT_BASE", P8_PORT_BASE), Mode::War).await;
}

/// PGWF (fix-gw-highs; security audit H-1, H-2): the offline attack replay. P8's legacy war on the devnet `.so` with
/// keeper A on its default `feed = "rpc"` pacer (150 ms; the runbook's 250 ms cannot follow this test's clock) and the gateway behind the herald's `/gw` (as on devnet,
/// `--public-proxy xff`). From the Depart on, `gw_flood.mjs` floods `/gw/f/reveal` with forged reveals and
/// `/gw/f/nudge` with bell 4294967295 for a grid of provinces, first from ONE client address, then from a fresh one
/// per request. Keeper A must still anchor, reveal, gather, resolve and settle the march (each step's wall time is
/// recorded), the owner's genuine material posted through `/gw/f/reveal` mid-flood must be accepted, and the keep's
/// SkipQuiet count must stay P8's. `OPERATOR_GW_FLOOD=0`: the same run with the sampler only (the baseline).
/// Opt-in (`OPERATOR_GW_FLOOD_RUN=1`): about 30 minutes, ports 41600+ (`OPERATOR_GW_FLOOD_PORT_BASE`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pgwf_keeper_a_keeps_its_cadence_under_a_gw_flood_offline() {
    if std::env::var("OPERATOR_GW_FLOOD_RUN").ok().as_deref() != Some("1") {
        eprintln!("pgwf: skipped (opt-in: OPERATOR_GW_FLOOD_RUN=1)");
        return;
    }
    playable_season(
        ports("OPERATOR_GW_FLOOD_PORT_BASE", PGWF_PORT_BASE),
        Mode::Flood,
    )
    .await;
}

/// P11 (devnet-expedition-keeper; devnet runbook gaps P10 + P13): a RIM → WIDE EXPEDITION on the devnet `.so`,
/// offline. Keeper A as the devnet profile now says: P8's play roles, the wide ring 129 (`wide_rings`), and the new
/// **`expeditions`** role. A test participant founds its rim village (as P4/P8), musters 400 and sends ONE
/// ExpeditionDepart (the 0x4804 wrapper, 「境界への道を準備」 in the page) into a ring-129 province, sealed to the real
/// round T(21); keeper A sends every later step (the origin bell's gather and resolve, SettleOrigin, THE anchor of
/// bell 21 from the real round, the wide ExpeditionReveal opened from that public round, the destination's catch-up
/// Resolves, ExpeditionGather, the arrival's Resolve, SettleMember). The host STAYS on ring 129; keeper A's feed guard
/// never latches and it keeps every duty afterwards; the verifier judges the whole season ([`rim::expedition`]).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p11_keeper_a_drives_a_rim_to_wide_expedition_on_the_devnet_so_offline() {
    playable_season(
        ports("OPERATOR_EXPEDITION_PORT_BASE", P11_PORT_BASE),
        Mode::Expedition,
    )
    .await;
}

/// P14 (devnet-guard-conquest; devnet gap P14, option a: the program unchanged): P11's season and expedition, then a
/// THIRD PARTY sends the Free City conquest kinds the PREVIOUS devnet `.so` (`da3dc1aa…`; P14 (b)'s `67a33c92…`
/// refuses them, see [`devnet_build`]) keeps open through the version-2 wrapper —
/// DeclareSiege (12, the host's own wallet), ResolveWithConquest (13) every bell, SettleSiege (15), a second
/// DeclareSiege as a RESERVATION, SettleReservation (18), and after the Season's end CloseCaptureEscrow (17) and
/// CloseConquest (16) — while keeper A runs every role. Keeper A's feed guard reads every conquest record exactly
/// (`feedguard.rs` P14) and never latches; the verifier judges the whole season ([`rim::conquest`]).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p14_a_third_partys_free_city_conquest_never_latches_keeper_a_offline() {
    playable_season(
        ports("OPERATOR_CONQUEST_PORT_BASE", P14_PORT_BASE),
        Mode::Conquest,
    )
    .await;
}

/// P12 (devnet-p15-p9; devnet gaps P15 + P9): P11 with the WEB PAGE sending the ExpeditionDepart — its boundary
/// card 「境界への道を準備」 on a devnet wide season: the route check, the transaction preview, the connected wallet's
/// signature, the gateway's `/gw/f/devnet-play/expedition/submit`; its sealed reveal half kept in the encrypted book
/// across a reload. Keeper A drives every later step (STAYS); then P9's wide village musters on later bells (keeper
/// A's `wide-resolve` role); the verifier judges the whole season. `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p12_the_page_sends_a_rim_to_wide_expedition_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("p12: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_EXPEDITION_PORT_BASE", P12_PORT_BASE),
        Mode::PageExpedition,
    )
    .await;
}

/// P9 (devnet-page-war): P8 with the WEB PAGE as the participant (as P7: the herald's `--web`, the gateway's devnet
/// play routes, a Wallet Standard TEST wallet): it musters, composes and seals the march, its wallet signs the Depart
/// (`/gw/f/devnet-play/march/submit`), its encrypted march book survives a reload, it hands the reveal material to
/// keeper A (`/gw/f/reveal`), and it shows the clash and the return. `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p9_the_page_plays_a_legacy_war_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("p9: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_WAR_PORT_BASE", P9_PORT_BASE),
        Mode::PageWar,
    )
    .await;
}

/// PCAP (devnet-72bell-pair; devnet STILL OPEN "72-bell keep capture never seen on devnet timing"): P9's page war —
/// the page musters, seals ONE Depart onto a neighbour's keep (its card, its wallet, its time-lock to the real T(21)) —
/// with keeper A running the devnet profile's roles and rings duty (`provinces_reach` #138; the live Rent sysvar #147),
/// then the keep HELD through all 72 bells at the devnet preset's real 600-s bells (the chain clock ×40,
/// `OPERATOR_PCAP_HOLD_SCALE`; window `OPERATOR_PCAP_AFTER_BELLS`, default 110): the capture on chain, the herald's
/// keep history and `keep_taken` day event, the page's guide 「…が州 P,Q を奪いました」; keeper A's lag measured per bell;
/// the verifier judges the whole season. `DEVNET_PAGE_DRIVER=1` only (as P7). Ports 41780+.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pcap_the_page_takes_a_keep_after_72_held_bells_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("pcap: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_CAPTURE_PORT_BASE", PCAP_PORT_BASE),
        Mode::PageCapture,
    )
    .await;
}

/// PPAIR (devnet-72bell-pair; devnet STILL OPEN "out-and-back march pair"): one host's march OUT to the neighbouring
/// province and back HOME in one season on the devnet page path, both legs settled by keeper A (the profile's roles):
/// OUT is the page's own march card (its wallet, its time-lock to the REAL T(21), which keeper A anchors and opens);
/// HOME, once the host may leave again (a sealed Depart costs 74 stamina: ~28 bells' rest), is the same wallet's Depart
/// sealed to the TEST beacon key over a declared TEST-signed anchor, revealed by the wallet — offline only T(21) is a
/// real arrival round (`rim::war::PAIR_REST_BELLS`). The host ends on its village's tile; the herald's records agree;
/// the verifier judges the whole season. `DEVNET_PAGE_DRIVER=1` only (as P7). Ports 41790+.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ppair_an_out_and_back_march_pair_from_the_devnet_page_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("ppair: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_PAIR_PORT_BASE", PPAIR_PORT_BASE),
        Mode::PagePair,
    )
    .await;
}

/// P10 (devnet-page-war-2): P9's page, its RETURN march — a Depart to its own village's tile (「村へ戻す」), arriving at
/// bell 21 on the real round — and keeper A stopped twice: (a) at the Depart bell, so the page's read of the home province
/// lags for minutes: the card's 出発 waits (one press) and sends ONCE when the read catches up; (b) across T(21)'s
/// publication, with drand-replay serving the rounds WITHOUT T(21) when keeper A comes back: the page's self-reveal backup
/// (`/gw/f/reveal` → keeper A's `/v1/reveal`) is refused while keeper A is down (KeeperUnavailable), asked again, and
/// accepted; then T(21) is served again, keeper A anchors the bell, the Reveal lands inside the window, and the march
/// settles home (SettleTransit over keeper A's REAL anchor). `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p10_the_page_marches_home_through_keeper_outages_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("p10: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_HOME_PORT_BASE", P10_PORT_BASE),
        Mode::PageWarHome,
    )
    .await;
}

/// PFOG (fog-devnet; owner t387u: the local test world's fog of war, now on the DEVNET page path): P9's page war with
/// two more players of OTHER nations looking through the devnet page (`operator_playable/war_fog.rs`,
/// `page_fog_driver.mjs`): B, of the nation holding the keep A marches on, and C, of a third nation far away. Their Join
/// and rim tickets are sent with TEST keys; they send nothing else. At the start, after A's Depart, after SettleTransit
/// (A's host on the keep) and at the end, every page's own vision, its fogged records beside the herald's raw ones, the
/// chronicle, the clash report gate, the keep lists and the full-map links are checked against the owner's fog rules:
/// each sees only its own vision; A's march appears to B only once it enters B's vision; never-seen provinces are blank
/// (map and 全体図); the keep's clash is hidden from C. Ports 41720+ (`OPERATOR_PAGE_FOG_PORT_BASE`).
/// `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pfog_two_players_see_only_their_own_vision_on_the_devnet_page_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("pfog: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_FOG_PORT_BASE", PFOG_PORT_BASE),
        Mode::PageWarFog,
    )
    .await;
}

/// PPROV (devnet-open-province, D-devnet-rim-homes-2): on the lazy devnet map nothing opened the provinces of rings
/// 4..=127, so no nation could found a second village (FileOutpost: ring > 3, within 3 of the home, its Province
/// present). keeper A configured as the devnet profile now says (rings duty `provinces_reach` 3) opens the provinces
/// within reach of every settled province; the participant's FileOutpost, refused before, lands and keeper A's
/// `tickets` role settles it (`operator_playable/provinces.rs`). Ports 41540+.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pprov_keeper_a_opens_the_provinces_a_nation_grows_into_offline() {
    playable_season(
        ports("OPERATOR_PROVINCES_PORT_BASE", PPROV_PORT_BASE),
        Mode::Provinces,
    )
    .await;
}

/// PFLOOR (keeper-rent-floor, D-verify-pr144-1): PPROV's world on a localnet at the 5,080 rent rate; every wedge fund
/// declared to its floor + 2½ provinces; keeper A opens exactly 2 a wedge (where wanted) and stops at the floor
/// (`operator_playable/provinces.rs` `floor_flow`). Ports 41510+.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pfloor_5080_keeper_a_stops_opening_at_the_fund_floor_offline() {
    playable_season(
        ports("OPERATOR_FLOOR_5080_PORT_BASE", PFLOOR_5080_PORT_BASE),
        Mode::Floor(5_080),
    )
    .await;
}

/// PFLOOR at 6,960 lamports/byte (the pre-SIMD-0194 rate): the floor and every rent keeper A compares are the
/// cluster's, so the same 2-a-wedge stop holds (the fixed-5,080 floor would have opened every wanted province).
/// Ports 41530+.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pfloor_6960_keeper_a_stops_opening_at_the_fund_floor_offline() {
    playable_season(
        ports("OPERATOR_FLOOR_6960_PORT_BASE", PFLOOR_6960_PORT_BASE),
        Mode::Floor(6_960),
    )
    .await;
}

/// PPOST (devnet-page-outpost): P4's rim world with the WEB PAGE as the participant, founding its SECOND village by
/// FileOutpost from the village screen's card (wallet-signed, wallet-paid, two presses: the SOL preview, then the send
/// through `/gw/f/devnet-play/act/submit`); the card first says the absent neighbours are not opened yet, the test opens
/// them (declared ring seeds + REAL OpenProvince by a TEST payer, as #138's keeper duty would); keeper A's `tickets`
/// role settles (`operator_playable/outpost_page.rs`). Ports 41610+. `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ppost_the_page_founds_a_second_village_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("ppost: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_OUTPOST_PORT_BASE", PPOST_PORT_BASE),
        Mode::PageOutpost,
    )
    .await;
}

/// P17 (devnet-p17; devnet gap P17): P7's page — Join, the rim FileTicket, Harvest, the wide claim, keeper A settling
/// and finalizing its wide village — and then that WIDE village's own acts from the page's card 「この遠方の村への命令」:
/// Harvest, Build (a building, the walls), Train and Muster, each two presses (the SOL preview, then ONE wallet-signed
/// send through `/gw/f/devnet-play/act/submit`) and its result read back; a refused muster (empty reserve) in JA and
/// EN first (`operator_playable/wide_acts_page.rs`). `DEVNET_PAGE_DRIVER=1` only (as P7).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p17_the_page_sends_its_wide_villages_own_acts_on_the_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        eprintln!("p17: skipped (set DEVNET_PAGE_DRIVER=1: needs node and headless Chromium)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_WIDE_ACTS_PORT_BASE", P17_PORT_BASE),
        Mode::PageWideActs,
    )
    .await;
}

/// P18 (devnet-territory-dev; owner NWP-2: territory playable on devnet before world 3): the NEW devnet `.so`
/// (`OPERATOR_TERRITORY_SO`, built from the commit under test) set up by the operator from the committed new-world
/// profile (S1_DEVNET_TERRITORY, WideSetRules keep holder NeutralTerritoryV1), keeper A with the devnet profile's
/// roles plus `territory`, the herald and the gateway in their devnet modes, and the WEB PAGE as the participant: its
/// rim village, the wide village on its OWN tile (tile preview → signed claim → village), one more tile from the card
/// (the preview names ore + SOL; the wallet pays exactly that), keeper A's upkeep settles, a declared keep capture by
/// another nation → keeper A's conquest transfer (the village tile stays), a declared starved first home → unpaid → the
/// page refuses a claim (JA/EN) → after 24 bells keeper A's decay, farthest first, one a bell
/// (`operator_playable/territory_page.rs`). `DEVNET_PAGE_DRIVER=1` and `OPERATOR_TERRITORY_SO` only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p18_the_page_plays_player_territory_on_the_new_devnet_so_offline() {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") || territory_so().is_none()
    {
        eprintln!("p18: skipped (set DEVNET_PAGE_DRIVER=1 and OPERATOR_TERRITORY_SO=<the new devnet .so>)");
        return;
    }
    playable_season(
        ports("OPERATOR_PAGE_TERRITORY_PORT_BASE", P18_PORT_BASE),
        Mode::PageTerritory,
    )
    .await;
}

/// PWATCH (world3-verifier-watch, item ⑯): the read-only verifier watch `scripts/devnet/verify-watch.mjs` over a LOCAL
/// world-3 replica: the committed new-world profile and the deployed `.so` (`OPERATOR_TERRITORY_SO`, 245ce1ab…), the
/// operator's setup, keeper A with the territory role, a test participant's Join + first home (TEST keys only); three
/// watch cycles over JSON-RPC (first pull, incremental pull, a busy world) judged PASS/UNVERIFIABLE with no FAIL, then
/// three tampers that must FAIL (`operator_playable/watch.rs`). `OPERATOR_WATCH=1` and `OPERATOR_TERRITORY_SO` only;
/// `FRONTIER_VERIFY_BIN` (default: this profile's frontier-verify, built with `verify/playable-lane` and the `pull`
/// subcommand), `OPERATOR_WATCH_MAX_RPS` (default 1, the watch's default).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pwatch_the_verifier_watch_judges_a_world3_replica_offline() {
    if std::env::var("OPERATOR_WATCH").ok().as_deref() != Some("1") || territory_so().is_none() {
        eprintln!(
            "pwatch: skipped (set OPERATOR_WATCH=1 and OPERATOR_TERRITORY_SO=<the devnet .so>)"
        );
        return;
    }
    playable_season(
        ports("OPERATOR_WATCH_PORT_BASE", PWATCH_PORT_BASE),
        Mode::Watch,
    )
    .await;
}

/// PEND (devnet-end-season, D-dress-6): P5's season (keeper A's rim, a rim village, keeper A's wide ring 129 and a
/// settled wide village), then its END with `frontier-operator end-season` as r0ze would run it on devnet: refused
/// before the end bell, EndSeason at it, every CloseProvince / wide province close and CloseSeason part after
/// `end + 72 h` with the refunds equal to the plan to the lamport, a re-run that sends nothing; keeper A and the
/// herald after Ended and after the tombstone; the verifier over the whole archive (`operator_playable/end.rs`).
/// Ports 41540+ (`OPERATOR_END_PORT_BASE`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend_the_operator_ends_and_closes_a_season_on_the_devnet_so_offline() {
    playable_season(ports("OPERATOR_END_PORT_BASE", PEND_PORT_BASE), Mode::End).await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// PEND (devnet-end-season): P5, then the season's end and clean-up.
    End,
    /// P3: the season's setup only.
    Setup,
    /// P4: the rim first village and the wide claim (the test sends the wide ring, settle and finalize).
    Rim,
    /// P5: P4 with keeper A's wide rings (P6) and `wide-tickets` role (P7).
    KeeperWide,
    /// P6: P5, then the wide village's own actions (PSW1 records) and keeper A's duties after them (gap P8).
    AfterWide,
    /// P7 (devnet gap P1): P5 with the web page as the participant.
    Page,
    /// P17 (devnet-p17): P7, then the page's wide village's own acts.
    PageWideActs,
    /// P18 (devnet-territory-dev): P7 on the NEW `.so` in a territory world, keeper A's `territory` role.
    PageTerritory,
    /// PWATCH (world3-verifier-watch): P3 in P18's territory world, then the read-only verifier watch.
    Watch,
    /// P8 (devnet-page-war): the rim world of P4, keeper A with the play roles, and a legacy war (muster, sealed
    /// Depart onto a keep, reveal, clash, capture, return) by a test participant.
    War,
    /// P9 (devnet-page-war): P8 with the web page as the participant.
    PageWar,
    /// P10 (devnet-page-war-2): the page's return march home, through two keeper A outages.
    PageWarHome,
    /// PFOG (fog-devnet): P9 with two observer players of other nations on the devnet page, under the fog of war.
    PageWarFog,
    /// PCAP (devnet-72bell-pair): P9 held through the 72 bells to the capture, keeper A as the devnet profile.
    PageCapture,
    /// PPAIR (devnet-72bell-pair): an out-and-back march pair from the devnet page path.
    PagePair,
    /// P11 (devnet-expedition-keeper): the rim world, keeper A with the play roles, the wide ring 129 and the
    /// `expeditions` role, and a rim → wide expedition by a test participant. (devnet-p15-p9: then P9's wide
    /// village musters on later bells, keeper A's `wide-resolve` role.)
    Expedition,
    /// P12 (devnet-p15-p9, gap P15): P11 with the WEB PAGE sending the ExpeditionDepart (its boundary card, the
    /// wallet signs, `/gw/f/devnet-play/expedition/submit`).
    PageExpedition,
    /// PPROV (devnet-open-province): keeper A's provinces on demand and a second village into one of them.
    Provinces,
    /// PPOST (devnet-page-outpost): P4's rim world with the WEB PAGE founding its second village (FileOutpost).
    PageOutpost,
    /// PFLOOR (keeper-rent-floor): PPROV's world at this rent rate; opens stop at the fund floor.
    Floor(u64),
    /// P14 (devnet-guard-conquest): P11, then a third party's wide Free City conquest.
    Conquest,
    /// PLOAD (herald-load-50): P7's devnet stack (herald `--web`, gateway `--devnet-play`, keeper A) held open for an
    /// external load generator; the test only makes TEST wallets and keeps the bells moving ([`rim::load`]).
    Load,
    /// PV0 (herald-v0v1-decode): P3 with the participant's Join as v1 and PlaceHome as v0 through its own table.
    Versioned,
    /// PGWF (fix-gw-highs): P8 (keeper A on its default 150 ms pacer), the gateway behind the herald's `/gw`,
    /// and a flood of forged reveals and far-future nudges from one and many addresses ([`rim::war::Flood`]).
    Flood,
}

async fn playable_season(pt: Ports, mode: Mode) {
    use fclient::abi::status as st;
    let rim_run = !matches!(mode, Mode::Setup | Mode::Versioned | Mode::Watch);
    // (P18 / PWATCH: the new world's profile and the NEW .so)
    let territory_world = matches!(mode, Mode::PageTerritory | Mode::Watch);
    let tag = match mode {
        Mode::Setup => "p3",
        Mode::Rim => "p4",
        Mode::KeeperWide => "p5",
        Mode::End => "pend",
        Mode::AfterWide => "p6",
        Mode::Page => "p7",
        Mode::PageWideActs => "p17",
        Mode::PageTerritory => "p18",
        Mode::Watch => "pwatch",
        Mode::War => "p8",
        Mode::Flood => "pgwf",
        Mode::PageWar => "p9",
        Mode::PageWarHome => "p10",
        Mode::PageWarFog => "pfog",
        Mode::PageCapture => "pcap",
        Mode::PagePair => "ppair",
        Mode::Expedition => "p11",
        Mode::PageExpedition => "p12",
        Mode::Provinces => "pprov",
        Mode::Floor(_) => "pfloor",
        Mode::PageOutpost => "ppost",
        Mode::Conquest => "p14",
        Mode::Versioned => "pv0",
        Mode::Load => "pload",
    };
    let war = matches!(
        mode,
        Mode::War
            | Mode::PageWar
            | Mode::PageWarHome
            | Mode::PageWarFog
            | Mode::PageCapture
            | Mode::PagePair
            | Mode::Flood
    );
    let page_mode = matches!(
        mode,
        Mode::Page
            | Mode::PageWideActs
            | Mode::PageTerritory
            | Mode::PageWar
            | Mode::PageWarHome
            | Mode::PageWarFog
            | Mode::PageCapture
            | Mode::PagePair
            | Mode::PageExpedition
            | Mode::PageOutpost
            | Mode::Load
    );
    let expedition = matches!(
        mode,
        Mode::Expedition | Mode::PageExpedition | Mode::Conquest
    );
    // (P11, P12 and P14 too: T(21) is the expedition's arrival round)
    let genesis_round = if war || expedition {
        WAR_GENESIS_ROUND
    } else {
        GENESIS_ROUND
    };
    // (P18: the NEW .so of the commit under test)
    let (so, so_sha256, so_program_hash, so_elf_len) = if territory_world {
        territory_so().expect("OPERATOR_TERRITORY_SO")
    } else {
        let (a, b, c) = devnet_build(mode == Mode::Conquest);
        (devnet_so_of(mode == Mode::Conquest), a, b, c)
    };
    let keeper_bin = sibling_bin("FRONTIER_KEEPER_BIN", "frontier-keeper");
    let drand_bin = sibling_bin("DRAND_REPLAY_BIN", "drand-replay");
    let dir = tmpdir(tag);
    let _c = Cleanup(dir.clone());
    let authority = Keypair::new(); // TEST key, this chain only
    let program = Keypair::new().pubkey(); // an address only
    let t_create_min = align(genesis_round);
    let chain0 = localnet::Chain::new(localnet::Config {
        g0: t_create_min - 86_400 - 900,
        // (PFLOOR: the cluster's rent rate under test)
        // (rent-live-rest: `OPERATOR_LAMPORTS_PER_BYTE` sets it for any other mode, e.g. PPOST at 6,960)
        lamports_per_byte: match mode {
            Mode::Floor(rate) => rate,
            _ => std::env::var("OPERATOR_LAMPORTS_PER_BYTE")
                .ok()
                .map(|v| v.parse().expect("OPERATOR_LAMPORTS_PER_BYTE: a rate"))
                .unwrap_or(localnet::chain::LAMPORTS_PER_BYTE),
        },
        ..localnet::Config::default()
    });
    let mut chain0 = chain0;
    chain0
        .deploy(
            program,
            &so,
            fclient::fees::deploy_max_len(so.len() as u64) as usize,
            Some(authority.pubkey()),
        )
        .unwrap();
    chain0.airdrop(&authority.pubkey(), 200 * SOL).unwrap();
    let state = Arc::new(Mutex::new(chain0));
    let node = localnet::server::start_with(state.clone(), pt.rpc, pt.rpc + 1)
        .await
        .expect("bind the RPC ports");
    let url = node.url();
    let key = write_key(&dir, "authority.json", &authority);
    let prof = if territory_world {
        territory_profile(&dir, &program.to_string(), &authority.pubkey().to_string())
    } else {
        finite_playable_profile(
            &dir,
            &program.to_string(),
            &authority.pubkey().to_string(),
            None,
        )
    };
    let record = dir.join("operator-record.jsonl");
    let (p, k, rec) = (
        prof.to_str().unwrap(),
        key.to_str().unwrap(),
        record.to_str().unwrap(),
    );
    let a = Addresses::new(program, 1);
    let lock = || state.lock().unwrap_or_else(|e| e.into_inner());
    let balance = || lock().balance(&authority.pubkey());
    let t = t_create_min.to_string();
    // The command r0ze would run on devnet, with --rpc pointed at the local node.
    let send = |extra: &[&str]| {
        let mut v = args(&[
            "--profile",
            p,
            "--rpc",
            &url,
            "--authority",
            k,
            "--t-create-min",
            &t,
            "--yes-send",
            "--i-have-r0ze-approval",
            "--approved-sha256",
            so_sha256,
            "--record",
            rec,
        ]);
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    };

    // Dry run: the plan, the program's sha256 and marker, nothing sent.
    let b0 = balance();
    let r = op(args(&[
        "--profile",
        p,
        "--rpc",
        &url,
        "--authority",
        k,
        "--t-create-min",
        &t,
    ]))
    .await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert_eq!(r.stdout.matches("\ntx ").count(), 10, "{}", r.stdout);
    assert!(r.stdout.contains(&format!("program    sha256 {so_sha256} ({so_elf_len} B ELF; solana-verify program hash {so_program_hash}); markers PSF_DEVNET_PLAYABLE_BUILD")), "{}", r.stdout);
    assert!(
        r.stdout
            .contains(&format!("genesis    round {genesis_round} ")),
        "{}",
        r.stdout
    );
    assert!(
        r.stdout
            .contains("SEND GATE: CLOSED\n  - --yes-send is not given"),
        "{}",
        r.stdout
    );
    assert!(r.stdout.contains("DRY RUN: nothing sent"), "{}", r.stdout);
    let planned = total_of(&r.stdout);
    std::fs::write(dir.join("dry-run.txt"), &r.stdout).unwrap();
    let dry_run = r.stdout.clone();
    assert!(lock().account(&a.season).is_none());
    assert_eq!(balance(), b0);

    // A wrong --approved-sha256: refused, nothing sent.
    let mut wrong = send(&[]);
    let i = wrong.iter().position(|x| x == so_sha256).unwrap();
    wrong[i] = "00".repeat(32);
    let r = op(wrong).await;
    assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stderr.contains("is not the deployed program's sha256"),
        "{}",
        r.stderr
    );
    assert!(lock().account(&a.season).is_none());

    // Send: AnnounceSeason, then the lead (exit 3).
    let r = op(send(&[])).await;
    assert_eq!(r.code, operator::EXIT_WAITING, "{}\n{}", r.stdout, r.stderr);
    assert!(r.stdout.contains("SEND GATE: OPEN"), "{}", r.stdout);
    let mut landed = landed_lines(&r.stdout);
    assert_eq!(landed.len(), 1, "{}", r.stdout);
    assert!(
        landed[0].starts_with("landed     AnnounceSeason"),
        "{}",
        landed[0]
    );
    let season = operator::season_view(&lock().account(&a.season).unwrap().data).unwrap();
    assert_eq!(
        (season.status, season.t_create_min),
        (st::ANNOUNCED, t_create_min)
    );

    // The lead, run fast by the test (not the tool): to t_create_min.
    // (a slot is 0.4 s × scale game seconds; a new scale applies from the next slot: 3 slots of margin, then 100 s
    //  slots to `t`, so the clock passes `t` by at most ~100 s)
    let run_clock_to = |t: i64, fast: f64| {
        let t0 = Instant::now();
        lock().set_scale(fast);
        while lock().unix_timestamp() < t - (3.0 * 0.4 * fast) as i64 - 300 {
            assert!(
                t0.elapsed() < Duration::from_secs(120),
                "the clock did not reach {t}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        lock().set_scale(250.0);
        while lock().unix_timestamp() < t {
            assert!(
                t0.elapsed() < Duration::from_secs(180),
                "the clock did not reach {t}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        lock().set_scale(1.0);
    };
    tokio::task::block_in_place(|| run_clock_to(t_create_min, 2_000.0));

    // Again: CreateSeason, InitBeaconLogs, InitShards × 6; WideSetRules waits for Seeded (exit 3).
    let r = op(send(&[])).await;
    assert_eq!(r.code, operator::EXIT_WAITING, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout
            .contains("WideSetRules needs the season Seeded (now Created)"),
        "{}",
        r.stdout
    );
    let l = landed_lines(&r.stdout);
    assert_eq!(l.len(), 8, "{}", r.stdout);
    landed.extend(l);
    let s = fclient::decode::Season::decode(&lock().account(&a.season).unwrap().data).unwrap();
    assert_eq!(s.status, st::CREATED);
    assert_eq!(s.program_version, operator::PLAYABLE_VERSION);
    assert_eq!(s.genesis_round, genesis_round);

    // keeper A (the real binary; the devnet profile's rings duty; feed = "rpc", as on devnet) and a local
    // drand-replay serving the committed real quicknet rounds (gated by this chain's clock).
    let fixtures = repo_root().join("frontier-node/crates/fclient/fixtures");
    // (P8/P9: the shipped rounds plus T(ARRIVE_BELL), the real round of the S-TLOCK q4 vector, in a copy of the archive)
    let drand_archive = if war || expedition {
        let d = dir.join("quicknet-archive");
        std::fs::create_dir_all(&d).unwrap();
        for e in std::fs::read_dir(fixtures.join("quicknet")).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), d.join(e.file_name())).unwrap();
        }
        let (round, sig) = rim::war::arrive_round();
        std::fs::write(
            d.join(format!("{round}.json")),
            json!({"round": round, "signature": hex::encode(sig)}).to_string(),
        )
        .unwrap();
        d
    } else {
        fixtures.join("quicknet")
    };
    // (P10: the same rounds WITHOUT T(ARRIVE_BELL), served while keeper A comes back from its outage at T(21))
    let drand_withheld = if mode == Mode::PageWarHome {
        let d = dir.join("quicknet-archive-withheld");
        std::fs::create_dir_all(&d).unwrap();
        for e in std::fs::read_dir(fixtures.join("quicknet")).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), d.join(e.file_name())).unwrap();
        }
        Some(d)
    } else {
        None
    };
    let drand_args = |archive: &Path| -> Vec<String> {
        vec![
            "serve".into(),
            "--port".into(),
            pt.drand.to_string(),
            "--archive".into(),
            archive.to_str().unwrap().into(),
            "--info".into(),
            fixtures.join("quicknet-info.json").to_str().unwrap().into(),
            "--clock".into(),
            format!("chain:{url}"),
        ]
    };
    let mut drand = Kill(
        Command::new(&drand_bin)
            .args([
                "serve",
                "--port",
                &pt.drand.to_string(),
                "--archive",
                drand_archive.to_str().unwrap(),
                "--info",
                fixtures.join("quicknet-info.json").to_str().unwrap(),
                "--clock",
                &format!("chain:{url}"),
            ])
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("drand-replay.log")).unwrap())
            .spawn()
            .expect("drand-replay"),
    );
    let kdir = dir.join("keeper-a");
    std::fs::create_dir_all(&kdir).unwrap();
    let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(11)); // TEST seed
    std::fs::write(kdir.join("keeper.seed"), hex::encode(seed)).unwrap();
    std::fs::set_permissions(
        kdir.join("keeper.seed"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let beneficiary = Keypair::new().pubkey();
    let toml = format!(
        "program = \"{program}\"\nseason = 1\nrpc = [\"{url}\"]\ndrand = [\"http://127.0.0.1:{dp}\"]\n\
         roles = [{roles}]\nreveal_pool = 150\ndelay_pool = 32\nfunders = 4\n\
         beneficiary = \"{beneficiary}\"\napi = \"127.0.0.1:{kp}\"\n\
         token_file = \"{d}/keeper.token\"\nmaster_seed_file = \"{d}/keeper.seed\"\njournal = \"{d}/keeper.journal.sqlite\"\n\
         feed = \"rpc\"\nextend = true\nextend_max_ring = 128\nlazy_provinces = true\n{rim}",
        d = kdir.display(),
        dp = pt.drand,
        kp = pt.keeper_api,
        // (P4: the devnet profile's keeper A with Q-W1's duties: the `tickets` role settles a rim FileTicket on
        //  the bell's seed, and `rim_per_wedge` opens the rim's provinces)
        // (P5: the profile's keeper A with P6/P7: `wide-tickets`, and the rings duty's wide rings)
        roles = match mode {
            Mode::Setup | Mode::Versioned => "\"beacon\", \"rings\", \"fold\"",
            Mode::Rim | Mode::Provinces | Mode::Floor(_) | Mode::PageOutpost => "\"beacon\", \"rings\", \"fold\", \"tickets\"",
            Mode::KeeperWide | Mode::AfterWide | Mode::Page | Mode::PageWideActs => {
                "\"beacon\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\""
            }
            // (P18: P17's keeper A and the `territory` role, as scripts/devnet/devnet-new-world-profile.json lists it)
            Mode::PageTerritory => {
                "\"beacon\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\", \"territory\""
            }
            // (PWATCH: the rim world's duties and `territory`: traffic for the watch, no wide rings to steer)
            Mode::Watch => "\"beacon\", \"rings\", \"fold\", \"tickets\", \"territory\"",
            // (PEND: P5's roles and the legacy war's `close`/`claims`, so keeper A's own closes meet the season's end)
            Mode::End => {
                "\"beacon\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\", \"close\", \"claims\""
            }
            // (P8/P9: the devnet profile's keeper A with the play roles of the S1 playtest's keeper A)
            Mode::War | Mode::PageWar | Mode::PageWarHome | Mode::PageWarFog | Mode::Flood => {
                "\"beacon\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\", \"reveal\", \"settle-departure\", \"gather\", \"resolve\", \"skip\", \"settle\", \"close\", \"claims\""
            }
            // (PCAP / PPAIR, devnet-72bell-pair: keeper A exactly as scripts/devnet/devnet-playable-profile.json's
            //  services.keeperA.roles)
            // (PLOAD: the devnet profile's keeper A roles too, so the herald folds a devnet season's keeper traffic)
            Mode::PageCapture | Mode::PagePair | Mode::Load => {
                "\"beacon\", \"archive\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\", \"reveal\", \"settle-departure\", \"gather\", \"resolve\", \"skip\", \"settle\", \"close\", \"claims\", \"expeditions\", \"wide-resolve\""
            }
            // (P11 / P14: the devnet profile's keeper A with P8's play roles and the `expeditions` role, P13)
            // (P12/P13 devnet-p15-p9: and the `wide-resolve` role, P9; P14 rides on P11)
            Mode::Expedition | Mode::PageExpedition | Mode::Conquest => {
                "\"beacon\", \"rings\", \"fold\", \"tickets\", \"wide-tickets\", \"reveal\", \"settle-departure\", \"gather\", \"resolve\", \"skip\", \"settle\", \"close\", \"claims\", \"expeditions\", \"wide-resolve\""
            }
        },
        rim = match mode {
            Mode::Setup | Mode::Versioned => String::new(),
            Mode::Rim | Mode::War | Mode::PageWar | Mode::PageWarHome | Mode::PageWarFog | Mode::PageOutpost | Mode::Watch => format!("rim_per_wedge = {}\n", rim::PER_WEDGE),
            // (PGWF: P8's keeper A as it is, `feed = "rpc"` with its default 150 ms pacer, the ONE pacer every duty shares;
            //  the runbook's 250 ms is too slow for this test's ×10–×40 clock even without a flood, fix-gw-highs report)
            Mode::Flood => format!("rim_per_wedge = {}\n", rim::PER_WEDGE),
            // (PPROV: the profile's rim and provinces on demand, `provinces_reach` = the preset's outpost_range)
            Mode::Provinces | Mode::Floor(_) => format!(
                "rim_per_wedge = {}\nprovinces_reach = {PPROV_REACH}\nprovinces_scan_slots = 10\n",
                rim::PER_WEDGE
            ),
            Mode::KeeperWide | Mode::AfterWide | Mode::Page | Mode::PageWideActs | Mode::PageTerritory | Mode::Load | Mode::End => format!(
                "rim_per_wedge = {n}\nwide_rings = {w}\nwide_per_wedge = {n}\nwide_scan_slots = 5\n",
                n = rim::PER_WEDGE,
                w = rim::WIDE_RINGS
            ),
            // (PCAP / PPAIR: the profile's ringsDuty — rim_per_wedge 6, provinces_reach 3 (#138) — with this test's
            //  scan cadence. NOT its wide_rings 3: offline a wide ring's seed can only bind a SHIPPED round, which P5
            //  steers the clock to (rim.rs); P5/P11 prove that duty, and a legacy war never touches the wide land)
            Mode::PageCapture | Mode::PagePair => format!(
                "rim_per_wedge = {}\nprovinces_reach = {PPROV_REACH}\nprovinces_scan_slots = 10\n",
                rim::PER_WEDGE
            ),
            // (P11 / P12 / P14: ring 129 only, the expedition's destination ring)
            Mode::Expedition | Mode::PageExpedition | Mode::Conquest => format!(
                "rim_per_wedge = {n}\nwide_rings = 1\nwide_per_wedge = {n}\nwide_scan_slots = 5\n",
                n = rim::PER_WEDGE
            ),
        },
    );
    std::fs::write(kdir.join("keeper.toml"), &toml).unwrap();
    std::fs::write(kdir.join("keeper.token"), "test-token-operator-playable\n").unwrap(); // TEST API token
    std::fs::set_permissions(
        kdir.join("keeper.token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    // Its payers (the devnet listing, `--print-addresses`), funded on this chain only.
    let out = Command::new(&keeper_bin)
        .args([
            "--config",
            kdir.join("keeper.toml").to_str().unwrap(),
            "--print-addresses",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let listing = String::from_utf8_lossy(&out.stdout).to_string();
    let mut funded = 0;
    for w in listing.split(|c: char| !c.is_ascii_alphanumeric()) {
        if let Ok(x) = w.parse::<Address>() {
            if w.len() >= 32 && x != program && x != beneficiary {
                lock().airdrop(&x, 2 * SOL).unwrap();
                funded += 1;
            }
        }
    }
    assert!(
        funded >= 150 + 32 + 4,
        "keeper payers ({funded}): {listing}"
    );
    let mut keeper = Kill(
        Command::new(&keeper_bin)
            .args(["--config", kdir.join("keeper.toml").to_str().unwrap()])
            .env("FRONTIER_KEEPER_TICK_LOG", "1")
            .stdout(std::fs::File::create(dir.join("keeper.out.log")).unwrap())
            .stderr(std::fs::File::create(dir.join("keeper.log")).unwrap())
            .spawn()
            .expect("frontier-keeper"),
    );
    // The genesis round is published at round_time; genesis 600 s later. Run the chain clock past genesis.
    let rt = permutation_rules::frontier::beacon::round_time(
        s.drand_genesis,
        s.drand_period,
        genesis_round,
    );
    tokio::task::block_in_place(|| run_clock_to(s.genesis_ts + 30, 100.0));
    lock().set_scale(20.0);
    let t0 = Instant::now();
    let rings_opened = || {
        lock()
            .account(&a.frontier())
            .map(|x| {
                let o = frontier_abi::layout::world::frontier::RINGS_OPENED;
                u16::from_le_bytes([x.data[o], x.data[o + 1]])
            })
            .unwrap_or(0)
    };
    let genesis_ring = s.genesis_ring as u16;
    let status = || {
        operator::season_view(&lock().account(&a.season).unwrap().data)
            .unwrap()
            .status
    };
    while !(matches!(status(), st::SEEDED | st::RUNNING) && rings_opened() > genesis_ring) {
        let exited = keeper.0.try_wait().ok().flatten();
        if t0.elapsed() > Duration::from_secs(240) || exited.is_some() {
            let log = std::fs::read_to_string(dir.join("keeper.log")).unwrap_or_default();
            let dlog = std::fs::read_to_string(dir.join("drand-replay.log")).unwrap_or_default();
            let fails: Vec<String> = lock()
                .feed(0, 100_000, Some(&program))
                .into_iter()
                .filter(|l| l.err.is_some())
                .map(|l| {
                    format!(
                        "{} {:?} {:?}",
                        ix_name(&l.wire, &program),
                        l.err,
                        l.logs.iter().rev().take(3).collect::<Vec<_>>()
                    )
                })
                .collect();
            eprintln!(
                "drand-replay log:\n{dlog}\nfailed program txs ({}):\n{}\nchain clock {}",
                fails.len(),
                fails
                    .iter()
                    .take(10)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n"),
                lock().unix_timestamp()
            );
            let tail: Vec<_> = log.lines().rev().take(40).collect();
            panic!(
                "keeper A did not seed the season and open the genesis rings (status {}, rings {}; round time {rt}; exited {exited:?}):\n{}",
                status(),
                rings_opened(),
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    lock().set_scale(1.0);

    // The operator's WideSetRules (Seeded/Running), then nothing left.
    let r = op(send(&[])).await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout
            .contains("done       AnnounceSeason, CreateSeason, InitBeaconLogs"),
        "{}",
        r.stdout
    );
    assert!(
        r.stdout
            .contains("setup      complete: 1 transaction(s) sent"),
        "{}",
        r.stdout
    );
    let l = landed_lines(&r.stdout);
    assert_eq!(l.len(), 1);
    assert!(l[0].starts_with("landed     WideSetRules"), "{}", l[0]);
    landed.extend(l);
    let rc = frontier_stack::operator::wide::rules_config(&a);
    let rules = lock().account(&rc).expect("the RulesConfig");
    assert_eq!(rules.owner, program);
    // (P18: the new world's keep holder, NeutralTerritoryV1 = 4, from the committed profile)
    assert_eq!(
        operator::wide::rules_of(&rules.data),
        Some(if territory_world {
            operator::wide::ours_for(Some(4))
        } else {
            operator::wide::ours()
        })
    );
    let b_after = balance();
    let r = op(send(&[])).await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout.contains("setup      complete: nothing to send"),
        "{}",
        r.stdout
    );
    assert!(r.stdout.contains("WideSetRules"), "{}", r.stdout);
    assert_eq!(balance(), b_after);
    // The operator spent the dry run's total (rent + bond + funds + fees).
    assert_eq!(b0 - b_after, planned, "spent vs the dry run's total");

    // A test participant (its own TEST key) joins and places a first home in an opened heartland province.
    let sd = lock().account(&a.season).unwrap().data;
    let cq = frontier_abi::v2::presets::ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let mut home = None;
    'find: for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let c = permutation_rules::frontier::geometry::ProvinceCoord::new(pp, qq);
                if c.ring() as i32 != ring {
                    continue;
                }
                let Some(n) = permutation_rules::frontier::geometry::home_nation(
                    c,
                    cq.placement,
                    cq.heartland_max_ring,
                    &gseed,
                ) else {
                    continue;
                };
                if let Some(pd) = lock().account(&a.province(pp, qq)) {
                    use frontier_abi::v2::layout::province::{province as PV, site as SM};
                    let d = pd.data;
                    if let Some(site) = (0..d[PV::SITE_COUNT] as usize)
                        .find(|i| d[PV::site(*i) + SM::STATE] == SM::STATE_FREE)
                    {
                        home = Some((pp as i16, qq as i16, n, site as u8));
                        break 'find;
                    }
                }
            }
        }
    }
    let (hp, hq, nation, site) = home.expect("an opened heartland province with a free site");
    let player = Keypair::new(); // TEST key
    let w = player.pubkey();
    lock().airdrop(&w, SOL).unwrap();
    let c = Chain::public(&url, program);
    let now = lock().unix_timestamp();
    let versioned = mode == Mode::Versioned;
    let join_ix = ix::join(&a, w, w, nation, &w, now + 3_600, None);
    let sig = if versioned {
        Ok(send_v1(&c, &join_ix, &player).await)
    } else {
        c.send_op_with(
            &[join_ix],
            &[&player],
            Duration::from_secs(60),
            MAX_LOADED_LIMIT,
        )
        .await
    }
    .expect("Join");
    let join = operator::landed(&c, "Join", &sig.to_string()).await;
    let cd = lock().account(&a.citizen(&w)).expect("the Citizen").data;
    use frontier_abi::v2::layout::player::citizen as C;
    assert_ne!(cd[C::FLAGS] & C::FLAG_JOINED, 0);
    let (f, sh) = (cd[C::FACTION], cd[C::JOIN_SHARD]);
    assert_eq!(f, nation);
    let place_ix = ix::place_home(
        &a,
        &ix::Player {
            actor: w,
            payer: w,
            wallet: w,
        },
        ix::Site { p: hp, q: hq, site },
        f,
        sh,
    );
    let mut wallet_v0 = Value::Null;
    let sig = if versioned {
        let (sig, out) = send_v0_by_wallet(&url, &dir, &place_ix, &player);
        wallet_v0 = out;
        Ok(sig)
    } else {
        c.send_op_with(
            &[place_ix],
            &[&player],
            Duration::from_secs(60),
            MAX_LOADED_LIMIT,
        )
        .await
    }
    .expect("PlaceHome");
    let place = operator::landed(&c, "PlaceHome", &sig.to_string()).await;
    let holding = lock()
        .account(&a.holding(hp as i32, hq as i32, site))
        .expect("the first home's Holding");
    assert_eq!(holding.owner, program);

    // The herald (the devnet mode: `--source rpc --cluster devnet`) folds the season and shows the home.
    let herald_bin = sibling_bin("FRONTIER_HERALD_BIN", "frontier-herald");
    // (fix-devnet-join-wait, TEST-ONLY: the herald as devnet runs it — behind an RPC that shows transactions late
    //  (a delaying proxy in front of this node: `OPERATOR_HERALD_RPC_URL`, loopback only), with the runbook's gap
    //  (`OPERATOR_HERALD_RPC_GAP_MS`) and poll (`OPERATOR_HERALD_POLL_MS`). Unset: as before, the node itself, gap 0.
    //  PLOAD (herald-load-50) sets the same two for its counting proxy and the runbook's 250 ms.)
    let herald_rpc = std::env::var("OPERATOR_HERALD_RPC_URL")
        .ok()
        .filter(|u| u.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| url.clone());
    let herald_gap = std::env::var("OPERATOR_HERALD_RPC_GAP_MS")
        .ok()
        .filter(|v| v.parse::<u64>().is_ok())
        .unwrap_or_else(|| "0".into());
    let herald_poll: Vec<String> = std::env::var("OPERATOR_HERALD_POLL_MS")
        .ok()
        .filter(|v| v.parse::<u64>().is_ok())
        .map(|v| vec!["--poll-ms".into(), v])
        .unwrap_or_default();
    let hdir = dir.join("herald");
    // (P7: the herald also serves the page, `--web`, and proxies `/gw/*` to the gateway's public listener)
    let (gw_op, gw_pub) = (pt.rpc + 6, pt.rpc + 7);
    let web_args: Vec<String> = if mode == Mode::Flood {
        // (PGWF: `/gw/*` only, no page)
        vec!["--relay".into(), format!("127.0.0.1:{gw_pub}")]
    } else if page_mode {
        vec![
            "--web".into(),
            // (fix-devnet-join-wait, TEST-ONLY: `OPERATOR_HERALD_WEB_DIR` serves another copy of the web tree — e.g.
            //  origin/main's, for a before/after run; unset: this checkout's)
            std::env::var("OPERATOR_HERALD_WEB_DIR")
                .ok()
                .filter(|d| Path::new(d).join("frontier/index.html").is_file())
                .unwrap_or_else(|| {
                    repo_root()
                        .join("permutation-server/web")
                        .to_str()
                        .unwrap()
                        .into()
                }),
            "--relay".into(),
            format!("127.0.0.1:{gw_pub}"),
        ]
    } else if mode == Mode::End {
        // (PEND: the page too, without the gateway — a player's view of the season's end, `end_page.mjs`)
        vec![
            "--web".into(),
            repo_root()
                .join("permutation-server/web")
                .to_str()
                .unwrap()
                .into(),
        ]
    } else {
        vec![]
    };
    let mut herald = Kill(
        Command::new(&herald_bin)
            .args(&web_args)
            .args([
                "--data",
                hdir.to_str().unwrap(),
                "--program",
                &program.to_string(),
                "--season",
                "1",
                "--rpc",
                &herald_rpc,
                "--source",
                "rpc",
                "--cluster",
                "devnet",
                "--rpc-min-gap-ms",
                &herald_gap,
                "--listen",
                &format!("127.0.0.1:{}", pt.herald),
            ])
            .args(&herald_poll)
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("herald.log")).unwrap())
            .spawn()
            .expect("frontier-herald"),
    );
    let t0 = Instant::now();
    let (season_view, me) = loop {
        let s = http_get(pt.herald, "/h/season");
        let m = http_get(pt.herald, &format!("/h/me/{w}"));
        if let (Some(s), Some(m)) = (s, m) {
            if m["holdings"].as_array().is_some_and(|h| !h.is_empty()) {
                break (s, m);
            }
        }
        if t0.elapsed() > Duration::from_secs(120) || herald.0.try_wait().ok().flatten().is_some() {
            panic!(
                "the herald did not show the home: {}",
                std::fs::read_to_string(dir.join("herald.log")).unwrap_or_default()
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert_eq!(season_view["cluster"], "devnet");
    assert_eq!(season_view["programId"], program.to_string());
    if versioned {
        // PV0: the cluster's word on both, then the herald's: the home shown above came from the v0
        // transaction's looked-up writable addresses, and nothing is an alarm.
        let tx_of = |sig: &str, max: u64| {
            let (c, sig) = (&c, sig.to_string());
            async move {
                c.call(
                    "getTransaction",
                    json!([sig, {"encoding": "base64", "maxSupportedTransactionVersion": max}]),
                )
                .await
                .unwrap()
            }
        };
        let jt = tx_of(&join.signature, 1).await;
        assert_eq!(jt["version"], json!(1), "the Join is a v1 transaction");
        let pt0 = tx_of(&place.signature, 0).await;
        assert_eq!(
            pt0["version"],
            json!(0),
            "the PlaceHome is a v0 transaction"
        );
        let la = fclient::vtx::loaded_from_meta(&pt0["meta"]).unwrap();
        let (citizen_at, holding_at) = (a.citizen(&w), a.holding(hp as i32, hq as i32, site));
        assert!(
            la.writable.contains(&holding_at) && la.writable.contains(&citizen_at),
            "the Holding and the Citizen are looked-up writable addresses: {la:?}"
        );
        let st = http_get(pt.herald, "/h/status").expect("/h/status");
        assert_eq!(st["alarms"]["badRecords"], json!(0), "{st}");
        let holdings = me["holdings"].as_array().unwrap();
        assert!(
            holdings
                .iter()
                .any(|h| h.to_string().contains(&holding_at.to_string())),
            "the herald shows THIS home: {holdings:?}"
        );
        wallet_v0["loaded"] = fclient::vtx::loaded_json(&la);
        wallet_v0["herald_status_alarms"] = st["alarms"].clone();
    }
    // P7: the gateway with its devnet play routes (`--devnet-play`), over THIS chain's RPC in its offline TEST form
    // (`--devnet-play-offline-rpc`: loopback 41000-41999 only; a real devnet gateway names an https RPC). Its relay pool
    // seed and invite secret are made fresh in this test's directory (TEST secrets; the devnet play routes sign nothing).
    let _gateway = if page_mode || mode == Mode::Flood {
        let gdir = dir.join("gateway");
        std::fs::create_dir_all(&gdir).unwrap();
        let sd = lock().account(&a.season).unwrap().data;
        let rh = hex::encode(&sd[frontier_abi::layout::world::season::RULESET_HASH..][..32]);
        let (prog_s, herald_s, keeper_s) = (
            program.to_string(),
            format!("http://127.0.0.1:{}", pt.herald),
            format!("http://127.0.0.1:{}", pt.keeper_api),
        );
        let (op_s, pub_s) = (gw_op.to_string(), gw_pub.to_string());
        // (the keeper link's TEST token: the page's self-reveal goes `/gw/f/reveal` → keeper A's `/v1/reveal`)
        let keeper_tok = kdir.join("keeper.token").to_str().unwrap().to_string();
        let g = Kill(
            Command::new("node")
                // (PGWF: `OPERATOR_GATEWAY_DIR` runs another gateway tree, e.g. origin/main's for the "before" numbers)
                .arg(
                    std::env::var("OPERATOR_GATEWAY_DIR")
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| repo_root().join("permutation-gateway"))
                        .join("src/frontier/server.mjs"),
                )
                // (PGWF / PLOAD: behind a TLS proxy that sets X-Forwarded-For, fix-gw-highs M-2; an older gateway ignores it)
                .args(if matches!(mode, Mode::Flood | Mode::Load) {
                    vec!["--public-proxy", "xff"]
                } else {
                    vec![]
                })
                .args([
                    "--cluster",
                    "devnet",
                    "--rpc",
                    // (PLOAD: through a counting proxy, as the herald's)
                    &std::env::var("OPERATOR_GATEWAY_RPC_URL").unwrap_or_else(|_| url.clone()),
                    "--program",
                    &prog_s,
                    "--season",
                    "1",
                    "--port",
                    &op_s,
                    "--public-port",
                    &pub_s,
                    "--herald",
                    &herald_s,
                    "--keeper",
                    &keeper_s,
                    "--keeper-token-file",
                    &keeper_tok,
                    "--dev",
                    "--pool-size",
                    "1",
                    "--master-seed-file",
                    gdir.join("relay-master.seed").to_str().unwrap(),
                    "--invite-secret-file",
                    gdir.join("invite.secret").to_str().unwrap(),
                    "--state-file",
                    gdir.join("relay-state.json").to_str().unwrap(),
                    "--devnet-play",
                    "--devnet-play-offline-rpc",
                    "--devnet-play-ruleset-hash",
                    &rh,
                ])
                .env(
                    "FRONTIER_OPERATOR_TOKEN",
                    "test-token-operator-playable-gateway",
                )
                .stdout(std::fs::File::create(dir.join("gateway.log")).unwrap())
                .stderr(std::fs::File::create(dir.join("gateway.err.log")).unwrap())
                .spawn()
                .expect("node (the gateway)"),
        );
        let t0 = Instant::now();
        while std::net::TcpStream::connect(("127.0.0.1", gw_pub)).is_err() {
            assert!(
                t0.elapsed() < Duration::from_secs(60),
                "the gateway did not listen: {}",
                std::fs::read_to_string(dir.join("gateway.err.log")).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Some(g)
    } else {
        None
    };
    let page = page_mode.then(|| rim::Page {
        herald: pt.herald,
        inspect: pt.rpc + 8,
        driver: repo_root().join(if mode == Mode::PageOutpost {
            rim::outpost_page::DRIVER
        } else if expedition {
            "frontier-node/crates/stack/tests/operator_playable/page_expedition_driver.mjs"
        } else if war {
            "frontier-node/crates/stack/tests/operator_playable/page_war_driver.mjs"
        } else {
            "frontier-node/crates/stack/tests/operator_playable/page_driver.mjs"
        }),
        out: std::env::var("OPERATOR_EVIDENCE_DIR")
            .map(|d| Path::new(&d).join(format!("{tag}-page")))
            .unwrap_or_else(|_| dir.join("page-out")),
        fog: mode == Mode::PageWarFog,
        outpost: mode == Mode::PageOutpost,
        wide_acts: mode == Mode::PageWideActs,
        territory: (mode == Mode::PageTerritory).then(|| rim::territory_page::Input {
            keeper_api: pt.keeper_api,
            token: "test-token-operator-playable".into(),
        }),
        capture: mode == Mode::PageCapture,
        pair: mode == Mode::PagePair,
        load: mode == Mode::Load,
    });
    // P4: the rim first village and the wide claim (keeper and herald still running).
    let rim_summary = if rim_run {
        Some(
            rim::run(rim::Ctx {
                keeper_wide: matches!(
                    mode,
                    Mode::KeeperWide
                        | Mode::End
                        | Mode::AfterWide
                        | Mode::Page
                        | Mode::PageWideActs
                        | Mode::PageTerritory
                        | Mode::Load
                        | Mode::Expedition
                        | Mode::PageExpedition
                        | Mode::Conquest
                ),
                wide_rings: if expedition { 1 } else { rim::WIDE_RINGS },
                expedition,
                conquest: mode == Mode::Conquest,
                so_sha256,
                page: page.clone(),
                provinces: matches!(mode, Mode::Provinces | Mode::Floor(_)).then(|| {
                    rim::provinces::Input {
                        player: player.insecure_clone(),
                        home: (hp as i32, hq as i32, site),
                        reach: PPROV_REACH as u32,
                        floor: match mode {
                            Mode::Floor(rate) => Some(rim::provinces::Floor {
                                rate,
                                keeper_api: pt.keeper_api,
                                token: "test-token-operator-playable".into(),
                                keeper_toml: kdir.join("keeper.toml"),
                            }),
                            _ => None,
                        },
                    }
                }),
                war: (war || expedition).then(|| rim::War {
                    keeper_api: pt.keeper_api,
                    token: "test-token-operator-playable".into(),
                    flood: (mode == Mode::Flood).then(|| rim::war::Flood {
                        herald: pt.herald,
                        keeper_api: pt.keeper_api,
                        gw_op,
                        script: repo_root().join(
                            "frontier-node/crates/stack/tests/operator_playable/gw_flood.mjs",
                        ),
                        out: std::env::var("OPERATOR_EVIDENCE_DIR")
                            .map(PathBuf::from)
                            .unwrap_or_else(|_| dir.clone()),
                        off: std::env::var("OPERATOR_GW_FLOOD").ok().as_deref() == Some("0"),
                    }),
                    outage: (mode == Mode::PageWarHome).then(|| rim::war::Outage {
                        keeper_bin: keeper_bin.clone(),
                        keeper_config: kdir.join("keeper.toml"),
                        drand_bin: drand_bin.clone(),
                        drand_full: drand_args(&drand_archive),
                        drand_withheld: drand_args(drand_withheld.as_ref().unwrap()),
                        drand_port: pt.drand,
                    }),
                }),
                after_wide: (mode == Mode::AfterWide).then(|| rim::Restart {
                    bin: keeper_bin.clone(),
                    config: kdir.join("keeper.toml"),
                    api: pt.keeper_api,
                    token: "test-token-operator-playable".into(),
                }),
                p11_restarts: (expedition
                    && std::env::var("OPERATOR_P11_RESTARTS").ok().as_deref() == Some("1"))
                .then(|| rim::Restart {
                    bin: keeper_bin.clone(),
                    config: kdir.join("keeper.toml"),
                    api: pt.keeper_api,
                    token: "test-token-operator-playable".into(),
                }),
                end: (mode == Mode::End).then(|| rim::end::End {
                    profile: prof.clone(),
                    key: key.clone(),
                    url: url.clone(),
                    authority: authority.pubkey(),
                    so_sha256,
                    keeper_api: pt.keeper_api,
                    token: "test-token-operator-playable".into(),
                    record: dir.join("operator-end-record.jsonl"),
                }),
                state: state.clone(),
                a: a.clone(),
                program,
                herald: pt.herald,
                dir: dir.clone(),
                keeper: &mut keeper.0,
                drand: &mut drand.0,
            })
            .await,
        )
    } else {
        None
    };
    // PWATCH: devnet's program also carries other seasons' transactions (world 2's AnnounceSeason / AbortSeason, world
    // 1's abort): the same program announces a season 2 here (the operator, its own record), so the watch's archive of
    // every program signature holds a foreign season's transaction too.
    let foreign_season = if mode == Mode::Watch {
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&prof).unwrap()).unwrap();
        v["operator"]["seasonId"] = json!(2);
        let p2 = dir.join("profile-season2.json");
        std::fs::write(&p2, serde_json::to_string_pretty(&v).unwrap()).unwrap();
        let t2 = (lock().unix_timestamp() + 2 * 86_400 + 3_600).to_string();
        let rec2 = dir.join("operator-record-season2.jsonl");
        let r = op(args(&[
            "--profile",
            p2.to_str().unwrap(),
            "--rpc",
            &url,
            "--authority",
            k,
            "--t-create-min",
            &t2,
            "--yes-send",
            "--i-have-r0ze-approval",
            "--approved-sha256",
            so_sha256,
            "--record",
            rec2.to_str().unwrap(),
        ]))
        .await;
        assert_eq!(r.code, operator::EXIT_WAITING, "{}\n{}", r.stdout, r.stderr);
        let l = landed_lines(&r.stdout);
        assert!(
            l.iter().any(|x| x.starts_with("landed     AnnounceSeason")),
            "{}",
            r.stdout
        );
        Some(l)
    } else {
        None
    };
    // PWATCH: the read-only verifier watch over this world (keeper A still running).
    let watch_summary = if mode == Mode::Watch {
        Some(
            watch::run(watch::Ctx {
                state: state.clone(),
                program,
                url: url.clone(),
                dir: dir.clone(),
                repo: repo_root(),
                verify_bin: sibling_bin("FRONTIER_VERIFY_BIN", "frontier-verify"),
                so: PathBuf::from(std::env::var("OPERATOR_TERRITORY_SO").unwrap()),
                so_sha256,
                max_rps: std::env::var("OPERATOR_WATCH_MAX_RPS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1.0),
                keeper: &mut keeper.0,
            })
            .await,
        )
    } else {
        None
    };
    drop(herald);

    // Every program transaction on this chain: name, payer, CU, fee, lamports (the keeper's included).
    drop(keeper);
    drop(drand);
    let mut all = vec![];
    for l in lock().feed(0, 100_000, Some(&program)) {
        // (PV0: the fee payer of a legacy, v0 or v1 wire)
        let payer = fclient::vtx::decode(&l.wire)
            .ok()
            .and_then(|t| t.fee_payer());
        all.push(json!({
            "slot": l.slot, "tx": ix_name(&l.wire, &program), "ok": l.err.is_none(), "err": l.err,
            "payer": if payer == Some(authority.pubkey()) { "operator (authority)".to_string() }
                     else if payer == Some(w) { "test participant".to_string() } else { "keeper A".to_string() },
            "compute_units": l.units, "fee": l.fee,
            "lamports_from_payer": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b)),
        }));
    }
    let failed: Vec<_> = all.iter().filter(|x| x["ok"] == false).collect();
    let keeper_ok = all
        .iter()
        .filter(|x| x["payer"] == "keeper A" && x["ok"] == true)
        .count();
    assert!(keeper_ok > 0, "keeper A landed nothing: {all:?}");
    let records: Vec<Value> = std::fs::read_to_string(&record)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(records.len(), 10, "one record per operator transaction");
    for r in &records {
        assert!(r["compute_units"].as_u64().unwrap() > 0, "{r}");
        assert!(r["lamports_from_authority"].as_u64().unwrap() > 0, "{r}");
    }
    assert_eq!(
        records
            .iter()
            .map(|r| r["lamports_from_authority"].as_u64().unwrap())
            .sum::<u64>(),
        planned,
        "the recorded lamports are the plan's total"
    );
    let summary = json!({
        "so_sha256": so_sha256, "program": program.to_string(), "season": a.season.to_string(),
        "t_create_min": t_create_min, "genesis_round": genesis_round, "planned_lamports": planned,
        "operator_records": records, "join": join.json(), "place_home": place.json(), "wallet_v0": wallet_v0,
        "home": {"p": hp, "q": hq, "site": site, "nation": nation},
        "herald_season": season_view, "herald_me_holdings": me["holdings"].as_array().map(|h| h.len()),
        "rings_opened": rings_opened(), "status": status(), "rim": rim_summary, "watch": watch_summary, "foreign_season": foreign_season,
        "program_transactions": all, "failed_transactions": failed.len(),
    });
    if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
        let d = Path::new(&d);
        std::fs::write(
            d.join(format!("{tag}-summary.json")),
            serde_json::to_string_pretty(&summary).unwrap(),
        )
        .unwrap();
        std::fs::write(d.join(format!("{tag}-dry-run.txt")), &dry_run).unwrap();
        for f in [
            "keeper.log",
            "keeper-restarted.log",
            "drand-replay.log",
            "herald.log",
        ] {
            let _ = std::fs::copy(dir.join(f), d.join(format!("{tag}-{f}")));
        }
        let _ = std::fs::copy(
            dir.join("keeper-a/keeper.toml"),
            d.join(format!("{tag}-keeper.toml")),
        );
    }
    node.stop();
}

/// PV0: one v1 transaction (SIMD-0385; its compute budget in the config mask, as the devnet send would state it)
/// of `ix` signed by `signer`, sent with preflight to the node; waits until it lands without error.
async fn send_v1(
    c: &Chain,
    ix: &fclient::Instruction,
    signer: &Keypair,
) -> fclient::ports::Signature {
    use solana_message::{v1, VersionedMessage};
    let bh: String = c
        .call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))
        .await
        .unwrap()["value"]["blockhash"]
        .as_str()
        .unwrap()
        .to_string();
    let m = v1::Message::try_compile_with_config(
        &signer.pubkey(),
        std::slice::from_ref(ix),
        bh.parse().unwrap(),
        v1::TransactionConfig {
            compute_unit_limit: Some(1_400_000),
            loaded_accounts_data_size_limit: Some(MAX_LOADED_LIMIT),
            ..v1::TransactionConfig::empty()
        },
    )
    .expect("a v1 message");
    let t =
        fclient::vtx::VersionedTransaction::try_new(VersionedMessage::V1(m), &[signer]).unwrap();
    let wire = fclient::vtx::wire(&t).unwrap();
    assert_eq!(wire[0], 0x81);
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&wire);
    let sig: fclient::ports::Signature = c
        .call("sendTransaction", json!([b64, {"encoding": "base64"}]))
        .await
        .unwrap_or_else(|e| panic!("v1 send: {e}"))
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let t0 = Instant::now();
    loop {
        let st = c
            .call("getSignatureStatuses", json!([[sig.to_string()]]))
            .await
            .unwrap();
        if !st["value"][0].is_null() {
            assert!(
                st["value"][0]["err"].is_null(),
                "the v1 transaction failed: {st}"
            );
            return sig;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "the v1 transaction did not land"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// PV0: `ix` (behind the compute-budget prefix every send of this harness carries) as a v0 transaction through
/// the wallet's own lookup table holding every account of `ix` but the wallet: `v0_wallet.mjs` (web3.js) creates
/// and extends the table, reads it back, compiles, signs with `signer` (a TEST key) and sends.
fn send_v0_by_wallet(
    url: &str,
    dir: &Path,
    ix: &fclient::Instruction,
    signer: &Keypair,
) -> (fclient::ports::Signature, Value) {
    use base64::Engine;
    let budget = fclient::tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: MAX_LOADED_LIMIT,
        heap: None,
    };
    let mut ixs = budget.instructions();
    ixs.push(ix.clone());
    let mut lookup: Vec<String> = vec![];
    for m in &ix.accounts {
        let k = m.pubkey.to_string();
        if m.pubkey != signer.pubkey() && !lookup.contains(&k) {
            lookup.push(k);
        }
    }
    let req = json!({
        "secret": signer.to_bytes().to_vec(),
        "instructions": ixs.iter().map(|i| json!({
            "programId": i.program_id.to_string(),
            "keys": i.accounts.iter().map(|m| json!({"pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable})).collect::<Vec<_>>(),
            "data": base64::engine::general_purpose::STANDARD.encode(&i.data),
        })).collect::<Vec<_>>(),
        "lookup": lookup,
    });
    let rp = dir.join("v0-wallet-request.json"); // (holds a TEST key; the test's own temp directory)
    std::fs::write(&rp, req.to_string()).unwrap();
    let gw = repo_root().join("permutation-gateway");
    let out = Command::new("node")
        .arg(repo_root().join("frontier-node/crates/stack/tests/operator_playable/v0_wallet.mjs"))
        .args([url, rp.to_str().unwrap(), gw.to_str().unwrap()])
        .output()
        .expect("node v0_wallet.mjs");
    let _ = std::fs::remove_file(&rp);
    let (so, se) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(out.status.success(), "v0 wallet:\n{so}\n{se}");
    let v: Value = serde_json::from_str(so.lines().last().unwrap()).unwrap();
    assert!(v["lookups"]["writable"].as_u64().unwrap() > 0, "{v}");
    (v["signature"].as_str().unwrap().parse().unwrap(), v)
}
