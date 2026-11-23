//! `frontier-operator` end to end, on loopback only (ports 41600–41649),
//! with TEST keys generated here (never funded anywhere but this
//! in-process frontier-localnet):
//!
//! - O1 the offline dry-run plan matches the committed snapshot;
//! - O2 a season set up on an in-process frontier-localnet running the
//!   RELEASE `.so` (the deployable artefact, quicknet preset): dry run
//!   (nothing sent), announce (exit 3 during the lead), re-run during the
//!   lead (nothing sent), a staged run (`--max-txs 3`, a stand-in for a
//!   failure half-way), the resume, and a final re-run (nothing sent); the
//!   lamports spent equal the dry run's total;
//! - O3 refusals: a mainnet-beta genesis (a loopback mock: only
//!   `getGenesisHash` is called), a devnet genesis behind a loopback URL
//!   without the approval flags, loose key-file mode, a symlinked key, a
//!   key that is not the profile's authority, `--yes-send` without a key.
//!
//! The `.so`: `PSF_FRONTIER_RELEASE_SO`, else
//! `permutation-frontier/target/deploy/permutation_frontier.so`, built with
//! `scripts/build-frontier.sh` when missing (a text placeholder is put where
//! cargo-build-sbf would write a program keypair, so no key is generated).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{Address, Keypair, Signer};
use frontier_stack::operator;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// `OPERATOR_TEST_PORT_BASE` moves both (a run confined to another range); default 41600.
fn port_base() -> u16 {
    std::env::var("OPERATOR_TEST_PORT_BASE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(41_600)
}
fn e2e_port() -> u16 {
    port_base()
}
fn mock_port() -> u16 {
    port_base() + 10
}
const SOL: u64 = 1_000_000_000;

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

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "frontier-operator-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn release_so() -> PathBuf {
    if let Ok(p) = std::env::var("PSF_FRONTIER_RELEASE_SO") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let root = repo_root();
    let so = root.join("permutation-frontier/target/deploy/permutation_frontier.so");
    if !so.exists() {
        let deploy = so.parent().unwrap();
        std::fs::create_dir_all(deploy).unwrap();
        let holder = deploy.join("permutation_frontier-keypair.json");
        if !holder.exists() {
            std::fs::write(
                &holder,
                "PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (stack/tests/operator.rs).\n",
            )
            .unwrap();
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let out = Command::new("bash")
            .arg(root.join("scripts/build-frontier.sh"))
            .current_dir(&root)
            .env(
                "PATH",
                format!(
                    "{home}/.local/share/solana/install/active_release/bin:{}",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output()
            .expect("scripts/build-frontier.sh");
        assert!(
            out.status.success(),
            "build-frontier.sh: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let b = std::fs::read(&so).unwrap();
    assert!(
        !b.windows(21).any(|w| w == b"PSF_TEST_BEACON_BUILD"),
        "{}: expected the release build",
        so.display()
    );
    so
}

/// A TEST key file in the Solana CLI format, mode 600.
fn write_key(dir: &Path, name: &str, k: &Keypair) -> PathBuf {
    let p = dir.join(name);
    let bytes: Vec<String> = k.to_bytes().iter().map(|b| b.to_string()).collect();
    std::fs::write(&p, format!("[{}]", bytes.join(","))).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    p
}

fn write_profile(dir: &Path, rpc: &str, program: &str, authority: &str, cluster: &str) -> PathBuf {
    let p = dir.join("profile.json");
    let v = json!({
        "schema": operator::PROFILE_SCHEMA,
        "note": "TEST profile (stack/tests/operator.rs): loopback only, test keys",
        "cluster": cluster,
        "rpcUrl": rpc,
        "allowedRpcHosts": ["api.devnet.solana.com"],
        "refusedRpcHostPatterns": ["mainnet", "api.solana.com", "testnet"],
        "programId": program,
        "upgradeAuthority": authority,
        "rent": {"assume": 6960},
        "season": {"preset": "S1_LOCAL_7D"},
        "operator": {"seasonId": 1, "beacon": "quicknet"}
    });
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

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// O1: the offline plan (no RPC, no key) is the committed snapshot.
/// `UPDATE_SNAPSHOTS=1` rewrites it.
#[tokio::test]
async fn o1_offline_dry_run_plan_matches_the_snapshot() {
    let dir = tmpdir("o1");
    let _cleanup = Cleanup(dir.clone());
    let program = Address::new_from_array([0x11; 32]).to_string();
    let authority = Address::new_from_array([0x22; 32]).to_string();
    let prof = write_profile(
        &dir,
        "https://api.devnet.solana.com",
        &program,
        &authority,
        "devnet",
    );
    let r = op(args(&["--profile", prof.to_str().unwrap(), "--offline"])).await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    let snap =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/operator-offline-plan.txt");
    if std::env::var("UPDATE_SNAPSHOTS").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(snap.parent().unwrap()).unwrap();
        std::fs::write(&snap, &r.stdout).unwrap();
    }
    let want = std::fs::read_to_string(&snap).expect("the snapshot (UPDATE_SNAPSHOTS=1 writes it)");
    assert_eq!(r.stdout, want, "the offline plan changed");
    // Shape: 9 transactions; the cost lines use the profile's rate.
    assert_eq!(r.stdout.matches("\ntx ").count(), 9);
    assert!(r.stdout.contains("6960 lamports/byte"));
    // --offline cannot send.
    let r = op(args(&[
        "--profile",
        prof.to_str().unwrap(),
        "--offline",
        "--yes-send",
        "--authority",
        "/nonexistent",
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED);
}

fn total_of(stdout: &str) -> u64 {
    let l = stdout
        .lines()
        .find(|l| l.starts_with("total "))
        .expect("total line");
    let x = l.split(" = ").nth(1).unwrap();
    x.split(' ')
        .next()
        .unwrap()
        .replace(',', "")
        .parse()
        .unwrap()
}

/// O2: the whole setup on loopback, run after run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn o2_sets_up_a_season_on_a_local_chain_idempotently() {
    let so = std::fs::read(release_so()).unwrap();
    let dir = tmpdir("o2");
    let _cleanup = Cleanup(dir.clone());
    let authority = Keypair::new(); // TEST key, this chain only
    let program = Keypair::new().pubkey(); // an address only
    let mut chain = localnet::Chain::new(localnet::Config::default());
    chain
        .deploy(
            program,
            &so,
            fclient::fees::deploy_max_len(so.len() as u64) as usize,
            Some(authority.pubkey()),
        )
        .unwrap();
    chain.airdrop(&authority.pubkey(), 100 * SOL).unwrap();
    let state = Arc::new(Mutex::new(chain));
    let node = localnet::server::start_with(state.clone(), e2e_port(), e2e_port() + 1)
        .await
        .expect("bind 41600/41601");
    let url = node.url();
    assert!(url.starts_with("http://127.0.0.1:"));
    let key = write_key(&dir, "authority.json", &authority);
    let prof = write_profile(
        &dir,
        &url,
        &program.to_string(),
        &authority.pubkey().to_string(),
        "localnet",
    );
    let p = prof.to_str().unwrap();
    let k = key.to_str().unwrap();
    let a = Addresses::new(program, 1);
    let lock = || state.lock().unwrap_or_else(|e| e.into_inner());
    let balance = || lock().balance(&authority.pubkey());

    // Dry run: the plan, nothing sent.
    let b0 = balance();
    let r = op(args(&["--profile", p, "--authority", k])).await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(r.stdout.contains("DRY RUN: nothing sent"), "{}", r.stdout);
    assert!(
        r.stdout.contains("check      program deployed"),
        "{}",
        r.stdout
    );
    assert_eq!(r.stdout.matches("\ntx ").count(), 9);
    let planned = total_of(&r.stdout);
    assert!(lock().account(&a.season).is_none());
    assert_eq!(balance(), b0);
    assert!(!r.stdout.contains(&format!("{:?}", authority.to_bytes())));

    // Send: AnnounceSeason, then the lead (exit 3).
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    assert_eq!(r.code, operator::EXIT_WAITING, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout.contains("CreateSeason opens at chain clock"),
        "{}",
        r.stdout
    );
    let season = operator::season_view(&lock().account(&a.season).unwrap().data).unwrap();
    assert_eq!(season.status, fclient::abi::status::ANNOUNCED);
    assert_eq!(season.authority, authority.pubkey());
    let t_create_min = season.t_create_min;

    // Again during the lead: nothing sent.
    let b1 = balance();
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    assert_eq!(r.code, operator::EXIT_WAITING, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout.contains("done       AnnounceSeason"),
        "{}",
        r.stdout
    );
    assert_eq!(balance(), b1);

    // A staged run (stands in for a failure half-way: 3 transactions) that
    // sleeps through the lead (--wait) while the test (not the tool) runs
    // the chain clock fast: 8,000 chain seconds per slot.
    let staged = tokio::spawn(op(args(&[
        "--profile",
        p,
        "--authority",
        k,
        "--yes-send",
        "--wait",
        "--max-txs",
        "3",
    ])));
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    lock().set_scale(20_000.0);
    let t0 = std::time::Instant::now();
    while lock().unix_timestamp() < t_create_min {
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "the lead did not pass"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    lock().set_scale(1.0);
    let r = tokio::time::timeout(Duration::from_secs(90), staged)
        .await
        .expect("the --wait run finished")
        .unwrap();
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stderr.contains("waiting for t_create_min"),
        "{}",
        r.stderr
    );
    assert!(r.stdout.contains("stopped    after 3"), "{}", r.stdout);
    assert!(lock().account(&a.join_shard(0, 7)).is_some());
    assert!(lock().account(&a.join_shard(1, 0)).is_none());

    // The resume: the dry run shows the five left; the send finishes.
    let r = op(args(&["--profile", p, "--authority", k])).await;
    assert_eq!(r.code, 0);
    assert!(
        r.stdout
            .contains("done       AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards(0)"),
        "{}",
        r.stdout
    );
    assert_eq!(r.stdout.matches("\ntx ").count(), 5);
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout
            .contains("setup      complete: 5 transaction(s) sent"),
        "{}",
        r.stdout
    );

    // Everything is there; the spend is the dry run's total.
    let season = fclient::decode::Season::decode(&lock().account(&a.season).unwrap().data).unwrap();
    assert_eq!(season.status, fclient::abi::status::CREATED);
    for r in 0..fclient::abi::REGIONS {
        assert!(lock().account(&a.beacon_log(r)).is_some());
    }
    for f in 0..fclient::abi::FACTIONS {
        for s in 0..fclient::abi::SHARDS_PER_FACTION {
            assert!(lock().account(&a.join_shard(f, s)).is_some());
        }
    }
    assert_eq!(b0 - balance(), planned, "spent vs the dry run's total");

    // And once more: nothing to send.
    let b2 = balance();
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    assert_eq!(r.code, 0, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stdout.contains("setup      complete: nothing to send"),
        "{}",
        r.stdout
    );
    assert_eq!(balance(), b2);

    let evidence = std::env::var("OPERATOR_EVIDENCE_DIR").ok();
    if let Some(d) = evidence {
        let _ = std::fs::write(
            Path::new(&d).join("o2-summary.json"),
            serde_json::to_string_pretty(&json!({
                "program": program.to_string(), "season": a.season.to_string(),
                "t_create_min": t_create_min, "planned_lamports": planned,
                "spent_lamports": b0 - b2, "status": season.status,
            }))
            .unwrap(),
        );
    }
    node.stop();
}

/// A loopback JSON-RPC mock that answers `getGenesisHash` with `genesis`
/// and records every method asked.
async fn mock_rpc(
    port: u16,
    genesis: &'static str,
) -> (Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let seen = Arc::new(Mutex::new(vec![]));
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind the mock port");
    let s2 = seen.clone();
    let h = tokio::spawn(async move {
        loop {
            let Ok((mut c, _)) = l.accept().await else {
                return;
            };
            let seen = s2.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut tmp = [0u8; 4096];
                let body = loop {
                    let Ok(n) = c.read(&mut tmp).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    let t = String::from_utf8_lossy(&buf).to_string();
                    if let Some(i) = t.find("\r\n\r\n") {
                        let len = t[..i]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= i + 4 + len {
                            break buf[i + 4..i + 4 + len].to_vec();
                        }
                    }
                };
                let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                let m = v["method"].as_str().unwrap_or("").to_string();
                seen.lock().unwrap().push(m.clone());
                let res = if m == "getGenesisHash" {
                    json!(genesis)
                } else {
                    json!(null)
                };
                let out = json!({"jsonrpc": "2.0", "id": v["id"], "result": res}).to_string();
                let _ = c
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                            out.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    (seen, h)
}

/// O3: the refusals.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn o3_refusals() {
    let dir = tmpdir("o3");
    let _cleanup = Cleanup(dir.clone());
    let authority = Keypair::new(); // TEST key, never funded
    let key = write_key(&dir, "authority.json", &authority);
    let program = Address::new_from_array([0x33; 32]).to_string();
    let url = format!("http://127.0.0.1:{}", mock_port());
    let prof = write_profile(
        &dir,
        &url,
        &program,
        &authority.pubkey().to_string(),
        "localnet",
    );
    let p = prof.to_str().unwrap();
    let k = key.to_str().unwrap();
    let secret = format!("{:?}", &authority.to_bytes()[..8]);
    let mut all = String::new();

    // A mainnet-beta genesis behind a loopback URL: refused after the one call.
    let (seen, h) = mock_rpc(mock_port(), operator::MAINNET_GENESIS).await;
    let r = op(args(&["--profile", p, "--authority", k, "--yes-send"])).await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
    assert!(r.stderr.contains("mainnet-beta: refused"), "{}", r.stderr);
    assert_eq!(*seen.lock().unwrap(), vec!["getGenesisHash".to_string()]);
    // The dry run is refused the same way.
    let r = op(args(&["--profile", p])).await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    h.abort();

    // A devnet genesis behind a loopback URL (a tunnel or proxy to devnet):
    // the public gate applies, so --yes-send alone is refused after the one
    // call, and so is the approval flag without the approved sha256.
    let (seen, h) = mock_rpc(mock_port() + 2, operator::DEVNET_GENESIS).await;
    let url3 = format!("http://127.0.0.1:{}", mock_port() + 2);
    for extra in [vec![], vec!["--i-have-r0ze-approval"]] {
        let mut a = vec![
            "--profile",
            p,
            "--rpc",
            &url3,
            "--authority",
            k,
            "--yes-send",
        ];
        a.extend(extra);
        let r = op(args(&a)).await;
        all.push_str(&r.stdout);
        all.push_str(&r.stderr);
        assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
        assert!(r.stderr.contains("SEND GATE: CLOSED"), "{}", r.stderr);
        assert!(r.stderr.contains("--approved-sha256"), "{}", r.stderr);
    }
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["getGenesisHash".to_string(), "getGenesisHash".to_string()],
        "nothing but the genesis is read"
    );
    h.abort();

    // Loose mode: refused before the key is read or the RPC called.
    let (seen, h) = mock_rpc(mock_port() + 1, operator::MAINNET_GENESIS).await;
    let url2 = format!("http://127.0.0.1:{}", mock_port() + 1);
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let r = op(args(&[
        "--profile",
        p,
        "--cluster-url",
        &url2,
        "--authority",
        k,
        "--yes-send",
    ]))
    .await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(r.stderr.contains("mode 644"), "{}", r.stderr);
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o640)).unwrap();
    let r = op(args(&[
        "--profile",
        p,
        "--cluster-url",
        &url2,
        "--authority",
        k,
    ]))
    .await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(r.stderr.contains("mode 640"), "{}", r.stderr);
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        seen.lock().unwrap().is_empty(),
        "no RPC call before the key checks"
    );
    h.abort();

    // A symlink to the key: refused.
    let link = dir.join("link.json");
    std::os::unix::fs::symlink(&key, &link).unwrap();
    let r = op(args(&[
        "--profile",
        p,
        "--authority",
        link.to_str().unwrap(),
    ]))
    .await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(r.stderr.contains("symlink"), "{}", r.stderr);

    // Not a key file, and a key that is not the profile's authority.
    let junk = dir.join("junk.json");
    std::fs::write(&junk, "[1,2,3]").unwrap();
    std::fs::set_permissions(&junk, std::fs::Permissions::from_mode(0o600)).unwrap();
    let r = op(args(&[
        "--profile",
        p,
        "--authority",
        junk.to_str().unwrap(),
    ]))
    .await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(
        r.stderr.contains("not a Solana CLI key file"),
        "{}",
        r.stderr
    );
    let other = write_key(&dir, "other.json", &Keypair::new());
    let r = op(args(&[
        "--profile",
        p,
        "--authority",
        other.to_str().unwrap(),
    ]))
    .await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(
        r.stderr.contains("is not the profile's upgradeAuthority"),
        "{}",
        r.stderr
    );

    // --yes-send needs a key file.
    let r = op(args(&["--profile", p, "--yes-send"])).await;
    all.push_str(&r.stdout);
    all.push_str(&r.stderr);
    assert_eq!(r.code, operator::EXIT_REFUSED);
    assert!(
        r.stderr.contains("--yes-send needs --authority"),
        "{}",
        r.stderr
    );

    // No secret bytes in any output above (the URL rules for public hosts
    // are unit-tested only: this run contacts nothing but loopback).
    assert!(!all.contains(&secret));
    assert!(!all.contains(&secret[1..secret.len() - 1]));
    let raw: Vec<String> = authority.to_bytes()[..8]
        .iter()
        .map(|b| b.to_string())
        .collect();
    assert!(!all.contains(&raw.join(",")));
}

/// O4 (verify-pr180): `frontier-operator end-season`'s refusals, before anything but the genesis is read: a
/// mainnet-beta genesis (send and dry run), a devnet genesis behind a loopback URL without the full approval
/// (`--yes-send` alone, the approval flag alone, the sha256 alone), a public host in a localnet profile, a public
/// host the profile does not allow. No `sendTransaction` in any of them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn o4_end_season_refusals() {
    let dir = tmpdir("o4");
    let _cleanup = Cleanup(dir.clone());
    let authority = Keypair::new(); // TEST key, never funded
    let key = write_key(&dir, "authority.json", &authority);
    let program = Address::new_from_array([0x34; 32]).to_string();
    let url = format!("http://127.0.0.1:{}", mock_port() + 5);
    let prof = write_profile(
        &dir,
        &url,
        &program,
        &authority.pubkey().to_string(),
        "localnet",
    );
    let p = prof.to_str().unwrap();
    let k = key.to_str().unwrap();
    let sha = "ab".repeat(32);

    // mainnet-beta behind loopback: the send and the dry run refused after the genesis read only.
    let (seen, h) = mock_rpc(mock_port() + 5, operator::MAINNET_GENESIS).await;
    for a in [
        vec!["end-season", "--profile", p, "--authority", k, "--yes-send"],
        vec!["end-season", "--profile", p],
    ] {
        let r = op(args(&a)).await;
        assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
        assert!(r.stderr.contains("mainnet-beta: refused"), "{}", r.stderr);
    }
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["getGenesisHash".to_string(), "getGenesisHash".to_string()]
    );
    h.abort();

    // devnet behind loopback: the public gate applies; every partial approval is refused after the genesis read.
    let (seen, h) = mock_rpc(mock_port() + 6, operator::DEVNET_GENESIS).await;
    let url6 = format!("http://127.0.0.1:{}", mock_port() + 6);
    for extra in [
        vec![],
        vec![operator::APPROVAL_FLAG],
        vec!["--approved-sha256", sha.as_str()],
    ] {
        let mut a = vec![
            "end-season",
            "--profile",
            p,
            "--rpc",
            &url6,
            "--authority",
            k,
            "--yes-send",
        ];
        a.extend(extra);
        let r = op(args(&a)).await;
        assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
        assert!(r.stderr.contains("SEND GATE: CLOSED"), "{}", r.stderr);
        assert!(r.stderr.contains("genesis"), "{}", r.stderr);
    }
    assert_eq!(seen.lock().unwrap().len(), 3);
    assert!(seen.lock().unwrap().iter().all(|m| m == "getGenesisHash"));
    h.abort();

    // Public hosts: a localnet profile allows loopback only; a devnet profile only its allowedRpcHosts. Refused
    // before any request.
    let r = op(args(&[
        "end-season",
        "--profile",
        p,
        "--rpc",
        "https://api.devnet.solana.com",
    ]))
    .await;
    assert_eq!(r.code, operator::EXIT_REFUSED, "{}\n{}", r.stdout, r.stderr);
    assert!(
        r.stderr.contains("allows loopback URLs only"),
        "{}",
        r.stderr
    );
    let dprof = dir.join("devnet");
    std::fs::create_dir_all(&dprof).unwrap();
    let dp = write_profile(
        &dprof,
        "https://api.devnet.solana.com",
        &program,
        &authority.pubkey().to_string(),
        "devnet",
    );
    for u in [
        "https://api.mainnet-beta.solana.com",
        "https://rpc.example.org",
        "http://api.devnet.solana.com",
    ] {
        let r = op(args(&[
            "end-season",
            "--profile",
            dp.to_str().unwrap(),
            "--rpc",
            u,
        ]))
        .await;
        assert_eq!(
            r.code,
            operator::EXIT_REFUSED,
            "{u}: {}\n{}",
            r.stdout,
            r.stderr
        );
    }
}
