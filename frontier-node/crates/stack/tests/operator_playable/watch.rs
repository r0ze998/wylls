//! PWATCH (world3-verifier-watch, item ⑯ "one read-only run on a played devnet world"): the scheduled read-only
//! verifier watch `scripts/devnet/verify-watch.mjs` run end to end against a LOCAL world-3 replica — the committed
//! new-world profile (S1_DEVNET_TERRITORY, keep holder NeutralTerritoryV1), the deployed `.so` (`OPERATOR_TERRITORY_SO`,
//! 245ce1ab… = world 3's program), the operator's setup, keeper A (`feed = "rpc"`, territory role) and a test
//! participant's Join + first home, all TEST keys of this chain. The watch talks to the node only over JSON-RPC, as it
//! would to api.devnet (`frontier-verify pull` → findex archive + finals.json, then the offline judge).
//!
//! 0. As on devnet (worlds 1 and 2 ran on the same program), the program also announces a season 2 first: the watch
//!    archives it but leaves it out of season 1's input (`foreign_season_txs`), else V2/CQ1 FAIL it.
//! 1. Cycle 1 (first pull, from the program's first signature): exit 0, PASS or UNVERIFIABLE (a public-RPC archive has
//!    no post-states), no FAIL finding, every archived transaction is the node's, the request rate ≤ `--max-rps`.
//! 2. Keeper A runs on at ×20 for a while (more bells, more keeper transactions); cycle 2: only the NEW signatures are
//!    fetched (the cursor), the archive grows by exactly the node's new program transactions, exit 0, no FAIL.
//! 3. Cycle 3 while keeper A keeps writing at ×60 (a busy world): the finals' snapshot must still be consistent (the
//!    pull re-reads them when a transaction landed at or before their slot) or the line says RACE — never FAIL.
//! 4. TAMPERS (copies of the data dir, `--judge-only`, no RPC): (a) one byte of one program account's final state
//!    changed; (b) one program account drained by one lamport (a CREDIT is honest: anyone may transfer in); (c) the last successful program transaction dropped from
//!    the watch's input. Each must exit 1 with a FAIL line: the watch catches a chain state its transactions do not
//!    explain.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub struct Ctx<'a> {
    pub state: Arc<Mutex<localnet::Chain>>,
    pub program: fclient::Address,
    pub url: String,
    pub dir: PathBuf,
    pub repo: PathBuf,
    pub verify_bin: PathBuf,
    pub so: PathBuf,
    pub so_sha256: &'a str,
    pub max_rps: f64,
    pub keeper: &'a mut std::process::Child,
}

struct Cycle {
    code: i32,
    line: String,
    state: Value,
    pull: Value,
    seconds: f64,
}

fn watch(c: &Ctx, data: &Path, extra: &[&str]) -> Cycle {
    let t0 = Instant::now();
    let mut cmd = Command::new("node");
    cmd.arg(c.repo.join("scripts/devnet/verify-watch.mjs"))
        .args(["--program", &c.program.to_string(), "--season", "1"])
        .args(["--data", data.to_str().unwrap()])
        .args(["--verify-bin", c.verify_bin.to_str().unwrap()])
        .args(["--program-so", c.so.to_str().unwrap()])
        .args(["--pinned-sha256", c.so_sha256])
        .args(["--max-rps", &c.max_rps.to_string()]);
    if !extra.contains(&"--judge-only") {
        cmd.args(["--rpc", &c.url, "--once"]);
    }
    let out = cmd.args(extra).output().expect("node verify-watch.mjs");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let line = stdout.lines().last().unwrap_or_default().to_string();
    let state: Value = std::fs::read_to_string(data.join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let pull: Value = std::fs::read_to_string(data.join("last-pull.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    eprintln!("pwatch: {line}");
    if out.status.code().is_none() || !stderr.trim().is_empty() && line.is_empty() {
        eprintln!("pwatch stderr: {stderr}");
    }
    Cycle {
        code: out.status.code().unwrap_or(-1),
        line,
        state,
        pull,
        seconds: t0.elapsed().as_secs_f64(),
    }
}

/// The node's program transactions (successful and failed), in ledger order.
fn node_sigs(c: &Ctx) -> Vec<String> {
    c.state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .feed(0, 1_000_000, Some(&c.program))
        .into_iter()
        .filter_map(|l| {
            fclient::vtx::decode(&l.wire)
                .ok()
                .and_then(|t| t.signatures.first().map(|s| s.to_string()))
        })
        .collect()
}

fn archived_sigs(data: &Path) -> Vec<String> {
    let (txs, _) = verify_core::input::read_archive(&data.join("findex/archive"))
        .expect("the watch's archive");
    txs.into_iter().map(|r| r.signature.to_string()).collect()
}

fn copy_dir(from: &Path, to: &Path) {
    let st = Command::new("cp")
        .args(["-R", from.to_str().unwrap(), to.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(st.success());
    let _ = std::fs::remove_file(to.join("watch.lock"));
}

/// `OPERATOR_EVIDENCE_DIR`: a copy of the data dir after each cycle (kept even when a later assertion fails).
fn keep(data: &Path, tag: &str) {
    if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
        let to = Path::new(&d).join(format!("pwatch-{tag}"));
        let _ = std::fs::remove_dir_all(&to);
        copy_dir(data, &to);
    }
}

fn run_fast(c: &Ctx, scale: f64, secs: u64) {
    c.state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_scale(scale);
    std::thread::sleep(Duration::from_secs(secs));
}

fn assert_judged_ok(tag: &str, cy: &Cycle) {
    assert_eq!(cy.code, 0, "{tag}: {}", cy.line);
    let level = cy.state["level"].as_str().unwrap_or_default();
    assert!(
        matches!(level, "PASS" | "UNVERIFIABLE"),
        "{tag}: a judged cycle, not {level}: {}",
        cy.line
    );
    assert!(
        cy.line.contains(" fail=0 "),
        "{tag}: no FAIL finding: {}",
        cy.line
    );
}

pub async fn run(c: Ctx<'_>) -> Value {
    let data = c.dir.join("watch-data");
    let mut out = json!({});

    // 1. The first cycle.
    let c1 = tokio::task::block_in_place(|| watch(&c, &data, &[]));
    keep(&data, "cycle1");
    assert_judged_ok("cycle 1", &c1);
    let a1 = archived_sigs(&data);
    let n1 = node_sigs(&c);
    assert!(!a1.is_empty(), "cycle 1 archived nothing: {}", c1.line);
    assert_eq!(
        a1,
        n1[..a1.len()].to_vec(),
        "cycle 1: the archive is the node's program transactions, in order"
    );
    let req1 = c1.pull["requests"].as_f64().unwrap();
    let rate1 = req1 / c1.pull["seconds"].as_f64().unwrap().max(0.001);
    assert!(
        rate1 <= c.max_rps * 1.05 + 0.5,
        "cycle 1: {rate1:.2} requests/s > --max-rps {}",
        c.max_rps
    );
    assert_eq!(c1.pull["finals"]["consistent"], json!(true), "{}", c1.line);
    // the foreign season-2 AnnounceSeason stays in the archive, out of season 1's input (and nothing else does)
    assert_eq!(
        c1.pull["foreign_season_txs"]["count"],
        json!(1),
        "{}",
        c1.pull
    );
    assert_eq!(
        c1.pull["foreign_season_txs"]["accounts_left_out"],
        json!(1),
        "season 2's Season: {}",
        c1.pull
    );
    out["cycle1"] =
        json!({"line": c1.line, "pull": c1.pull, "rate_rps": rate1, "seconds": c1.seconds});

    // 2. More bells, then the second cycle: only the new signatures.
    tokio::task::block_in_place(|| run_fast(&c, 20.0, 45));
    tokio::task::block_in_place(|| run_fast(&c, 1.0, 3));
    let c2 = tokio::task::block_in_place(|| watch(&c, &data, &[]));
    keep(&data, "cycle2");
    assert_judged_ok("cycle 2", &c2);
    assert_eq!(
        c2.pull["foreign_season_txs"]["count"],
        json!(1),
        "{}",
        c2.pull
    );
    let a2 = archived_sigs(&data);
    let n2 = node_sigs(&c);
    assert!(
        a2.len() > a1.len(),
        "cycle 2 archived nothing new: {}",
        c2.line
    );
    assert_eq!(a2[..a1.len()], a1[..], "cycle 2 kept cycle 1's records");
    assert_eq!(a2, n2[..a2.len()].to_vec(), "cycle 2: the node's order");
    let new2 = (a2.len() - a1.len()) as f64;
    assert_eq!(c2.pull["archived"].as_f64(), Some(new2), "{}", c2.line);
    assert_eq!(c2.pull["seq_before"].as_u64(), Some(a1.len() as u64));
    let req2 = c2.pull["requests"].as_f64().unwrap();
    // incremental: two getTransaction per new transaction (the record, its balances) plus a bounded number of listing / finals / hash reads
    let accounts = c2.pull["finals"]["accounts"].as_f64().unwrap();
    let bound = 2.0 * new2 + 4.0 + (2.0 + (accounts / 100.0).ceil()) * 3.0 + 4.0;
    assert!(
        req2 <= bound,
        "cycle 2: {req2} requests for {new2} new transactions (bound {bound})"
    );
    out["cycle2"] =
        json!({"line": c2.line, "pull": c2.pull, "requests_bound": bound, "seconds": c2.seconds});

    // 3. A busy world: keeper A keeps writing at ×60 during the cycle (10 s of lead first).
    c.state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_scale(60.0);
    tokio::task::block_in_place(|| std::thread::sleep(Duration::from_secs(10)));
    let c3 = tokio::task::block_in_place(|| watch(&c, &data, &[]));
    keep(&data, "cycle3");
    c.state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_scale(1.0);
    assert_eq!(c3.code, 0, "cycle 3: {}", c3.line);
    let level3 = c3.state["level"].as_str().unwrap_or_default().to_string();
    assert!(
        matches!(level3.as_str(), "PASS" | "UNVERIFIABLE" | "RACE"),
        "cycle 3: {}",
        c3.line
    );
    out["cycle3_busy"] = json!({"line": c3.line, "pull": c3.pull, "seconds": c3.seconds});
    assert!(
        c.keeper.try_wait().ok().flatten().is_none(),
        "keeper A stayed up"
    );

    // 4. Tampers on copies of the data dir (judge only, no RPC): the watch's own fixture changed as a lying RPC (or a
    //    program bug) would leave it.
    let base =
        verify_core::input::Input::load(&data.join("input.json.gz")).expect("the watch's input");
    let program_key = c.program.to_bytes();
    let (key, _) = base
        .finals
        .iter()
        .rfind(|(_, a)| {
            a.as_ref()
                .is_some_and(|a| a.owner.to_bytes() == program_key && a.data.len() > 200)
        })
        .expect("a program account with data in the finals");
    let key = *key;
    let drop_at = base
        .txs
        .iter()
        .rposition(|t| {
            t.err.is_none()
                && base.chain.balances.contains_key(&t.signature.to_string())
                && t.logs.iter().any(|l| l.contains(&c.program.to_string()))
        })
        .expect("a successful program transaction");
    let mut tampers = vec![];
    for name in ["finals-data-byte", "finals-lamports", "drop-tx"] {
        let t = c.dir.join(format!("watch-tamper-{name}"));
        copy_dir(&data, &t);
        let mut inp = base.clone();
        let what = match name {
            "finals-data-byte" => {
                let a = inp.finals.get_mut(&key).unwrap().as_mut().unwrap();
                let i = a.data.len() - 9;
                a.data[i] ^= 0x01;
                fclient::Address::new_from_array(key).to_string()
            }
            "finals-lamports" => {
                let a = inp.finals.get_mut(&key).unwrap().as_mut().unwrap();
                // a drain: anyone may CREDIT any account (a System transfer in is honest and VG
                // accepts it — verified: +1 lamport judges UNVERIFIABLE, no FAIL), nobody but the program can debit it
                a.lamports -= 1;
                fclient::Address::new_from_array(key).to_string()
            }
            _ => {
                let gone = inp.txs.remove(drop_at);
                gone.signature.to_string()
            }
        };
        inp.save(&t.join("input.json.gz")).unwrap();
        let cy = tokio::task::block_in_place(|| watch(&c, &t, &["--judge-only"]));
        keep(&t, &format!("tamper-{name}"));
        assert_eq!(cy.code, 1, "tamper {name} must FAIL: {}", cy.line);
        assert_eq!(cy.state["level"], json!("FAIL"), "{}", cy.line);
        tampers.push(json!({"tamper": name, "what": what, "line": cy.line}));
    }
    out["tampers"] = json!(tampers);
    out["watch_log"] = json!(std::fs::read_to_string(data.join("watch.log")).unwrap_or_default());
    out
}
