//! `frontier-operator --preset S1_DEVNET_WIDE_7D` (devnet blocker B3, owner decision B7: the PLAYABLE lane), on
//! loopback only (ports 41450–41459), with TEST keys generated here and funded only on this in-process
//! frontier-localnet. Nothing here contacts devnet, mainnet or drand's public API.
//!
//! - P1 (key-free) the offline plan of the COMMITTED `scripts/devnet/devnet-playable-profile.json` (its placeholders
//!   replaced by fixed addresses) is the committed snapshot: 10 transactions, the last WideSetRules after Seeded;
//! - P2 (key-free) the send gate on the committed profile's devnet URL: `--yes-send` without
//!   `--i-have-r0ze-approval` / `--approved-sha256` is refused before any key is read or any host contacted;
//! - P3 the exact devnet `.so` (the committed fixture `frontier-node/fixtures/verify/devnet-playable-da3dc1aa.so.gz`,
//!   sha256 `da3dc1aa…b9741`, the artefact `scripts/build-frontier-devnet-playable-sbf.sh` builds) deployed in an
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

/// P3's ports (RPC, its WebSocket at +1, drand-replay +2, keeper API +3, herald +5); P4 takes [`P4_PORT_BASE`].
/// `OPERATOR_PLAYABLE_PORT_BASE` / `OPERATOR_RIM_PORT_BASE` move them.
const P3_PORT_BASE: u16 = 41_450;
const P4_PORT_BASE: u16 = 41_560;

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
/// sha256 of the devnet build of the playable lane (reports/devnet-refresh.md, the committed verifier fixture).
const DEVNET_SO_SHA256: &str = "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";
/// The same program's `program_hash` (trailing zeros stripped; reports/devnet-refresh.md, `solana-verify`'s form).
const DEVNET_PROGRAM_HASH: &str =
    "786ef80f132a9d2d18afc5708336a396afba32ff3d4c37ebf6c94425a51352df";
/// The first of the 32 committed real quicknet rounds (`fclient/fixtures/quicknet`): the genesis round.
const GENESIS_ROUND: u64 = 32_551_361;

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

fn devnet_so() -> Vec<u8> {
    use std::io::Read;
    let p = repo_root().join("frontier-node/fixtures/verify/devnet-playable-da3dc1aa.so.gz");
    let mut out = vec![];
    flate2::read::GzDecoder::new(
        std::fs::File::open(&p).expect("the committed devnet .so fixture"),
    )
    .read_to_end(&mut out)
    .unwrap();
    let h = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&out));
    assert_eq!(
        h, DEVNET_SO_SHA256,
        "the fixture is the approved devnet artefact"
    );
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
    assert_eq!(v["season"]["preset"], "S1_DEVNET_WIDE_7D");
    assert_eq!(v["program"]["programVersion"], "0x4804");
    assert!(
        v["operator"]["seasonId"].is_u64(),
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
    assert!(r.stdout.contains("preset S1_DEVNET_WIDE_7D"));
    assert!(r
        .stdout
        .contains("lane       playable (program_version 0x4804"));
    assert!(r
        .stdout
        .contains("tx 10 WideSetRules  [after keeper A's ConsumeGenesisSeed"));
    assert!(r.stdout.contains("5080 lamports/byte"));
    // The CreateSeason bytes are the preset's at 0x4804 (the plan prints their sha256).
    let mut sp = frontier_abi::v2::presets::S1_DEVNET_WIDE_7D;
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
    let Ok(t) = fclient::tx::from_wire(wire) else {
        return "?".into();
    };
    let m = &t.message;
    for i in &m.instructions {
        if m.account_keys.get(i.program_id_index as usize) == Some(program) {
            let tag = i.data.first().copied().unwrap_or(0);
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
    playable_season(ports("OPERATOR_PLAYABLE_PORT_BASE", P3_PORT_BASE), false).await;
}

/// P4 (owner Q-W1, 2026-11-20): P3, then a FIRST VILLAGE ON THE RIM and a wide claim from it, on the devnet `.so`
/// with the keeper roles a devnet season would run (module doc of [`rim`]).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p4_a_rim_first_village_and_a_wide_claim_on_the_devnet_so_offline() {
    playable_season(ports("OPERATOR_RIM_PORT_BASE", P4_PORT_BASE), true).await;
}

async fn playable_season(pt: Ports, rim_run: bool) {
    use fclient::abi::status as st;
    let tag = if rim_run { "p4" } else { "p3" };
    let so = devnet_so();
    let keeper_bin = sibling_bin("FRONTIER_KEEPER_BIN", "frontier-keeper");
    let drand_bin = sibling_bin("DRAND_REPLAY_BIN", "drand-replay");
    let dir = tmpdir(tag);
    let _c = Cleanup(dir.clone());
    let authority = Keypair::new(); // TEST key, this chain only
    let program = Keypair::new().pubkey(); // an address only
    let t_create_min = align(GENESIS_ROUND);
    let chain0 = localnet::Chain::new(localnet::Config {
        g0: t_create_min - 86_400 - 900,
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
    let prof = playable_profile(
        &dir,
        &program.to_string(),
        &authority.pubkey().to_string(),
        None,
    );
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
            DEVNET_SO_SHA256,
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
    assert!(r.stdout.contains(&format!("program    sha256 {DEVNET_SO_SHA256} (3,657,488 B ELF; solana-verify program hash {DEVNET_PROGRAM_HASH}); markers PSF_DEVNET_PLAYABLE_BUILD")), "{}", r.stdout);
    assert!(
        r.stdout
            .contains(&format!("genesis    round {GENESIS_ROUND} ")),
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
    let i = wrong.iter().position(|x| x == DEVNET_SO_SHA256).unwrap();
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
    assert_eq!(s.genesis_round, GENESIS_ROUND);

    // keeper A (the real binary; the devnet profile's rings duty; feed = "rpc", as on devnet) and a local
    // drand-replay serving the committed real quicknet rounds (gated by this chain's clock).
    let fixtures = repo_root().join("frontier-node/crates/fclient/fixtures");
    let drand = Kill(
        Command::new(&drand_bin)
            .args([
                "serve",
                "--port",
                &pt.drand.to_string(),
                "--archive",
                fixtures.join("quicknet").to_str().unwrap(),
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
        roles = if rim_run {
            "\"beacon\", \"rings\", \"fold\", \"tickets\""
        } else {
            "\"beacon\", \"rings\", \"fold\""
        },
        rim = if rim_run {
            format!("rim_per_wedge = {}\n", rim::PER_WEDGE)
        } else {
            String::new()
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
        GENESIS_ROUND,
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
    assert_eq!(
        operator::wide::rules_of(&rules.data),
        Some(operator::wide::ours())
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
    let sig = c
        .send_op_with(
            &[ix::join(&a, w, w, nation, &w, now + 3_600, None)],
            &[&player],
            Duration::from_secs(60),
            MAX_LOADED_LIMIT,
        )
        .await
        .expect("Join");
    let join = operator::landed(&c, "Join", &sig.to_string()).await;
    let cd = lock().account(&a.citizen(&w)).expect("the Citizen").data;
    use frontier_abi::v2::layout::player::citizen as C;
    assert_ne!(cd[C::FLAGS] & C::FLAG_JOINED, 0);
    let (f, sh) = (cd[C::FACTION], cd[C::JOIN_SHARD]);
    assert_eq!(f, nation);
    let sig = c
        .send_op_with(
            &[ix::place_home(
                &a,
                &ix::Player {
                    actor: w,
                    payer: w,
                    wallet: w,
                },
                ix::Site { p: hp, q: hq, site },
                f,
                sh,
            )],
            &[&player],
            Duration::from_secs(60),
            MAX_LOADED_LIMIT,
        )
        .await
        .expect("PlaceHome");
    let place = operator::landed(&c, "PlaceHome", &sig.to_string()).await;
    let holding = lock()
        .account(&a.holding(hp as i32, hq as i32, site))
        .expect("the first home's Holding");
    assert_eq!(holding.owner, program);

    // The herald (the devnet mode: `--source rpc --cluster devnet`) folds the season and shows the home.
    let herald_bin = sibling_bin("FRONTIER_HERALD_BIN", "frontier-herald");
    let hdir = dir.join("herald");
    let mut herald = Kill(
        Command::new(&herald_bin)
            .args([
                "--data",
                hdir.to_str().unwrap(),
                "--program",
                &program.to_string(),
                "--season",
                "1",
                "--rpc",
                &url,
                "--source",
                "rpc",
                "--cluster",
                "devnet",
                "--rpc-min-gap-ms",
                "0",
                "--listen",
                &format!("127.0.0.1:{}", pt.herald),
            ])
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
    // P4: the rim first village and the wide claim (keeper and herald still running).
    let rim_summary = if rim_run {
        Some(
            rim::run(rim::Ctx {
                state: state.clone(),
                a: a.clone(),
                program,
                herald: pt.herald,
                dir: dir.clone(),
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
        let t = fclient::tx::from_wire(&l.wire).ok();
        let payer = t
            .as_ref()
            .and_then(|t| t.message.account_keys.first().copied());
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
        "so_sha256": DEVNET_SO_SHA256, "program": program.to_string(), "season": a.season.to_string(),
        "t_create_min": t_create_min, "genesis_round": GENESIS_ROUND, "planned_lamports": planned,
        "operator_records": records, "join": join.json(), "place_home": place.json(),
        "home": {"p": hp, "q": hq, "site": site, "nation": nation},
        "herald_season": season_view, "herald_me_holdings": me["holdings"].as_array().map(|h| h.len()),
        "rings_opened": rings_opened(), "status": status(), "rim": rim_summary,
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
        for f in ["keeper.log", "drand-replay.log", "herald.log"] {
            let _ = std::fs::copy(dir.join(f), d.join(format!("{tag}-{f}")));
        }
        let _ = std::fs::copy(
            dir.join("keeper-a/keeper.toml"),
            d.join(format!("{tag}-keeper.toml")),
        );
    }
    node.stop();
}
