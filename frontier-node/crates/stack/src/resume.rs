//! Restart a persisted human CQ world without recreating its chain, keys or season.
use crate::{
    chain::Chain,
    procs::{Proc, Spec},
    run::{self, RunDir},
    up,
};
use fclient::{addr::Addresses, Address, Keypair};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const ORDER: [&str; 6] = [
    "localnet",
    "drand-replay",
    "keeper-a",
    "keeper-b",
    "relay",
    "herald",
];
fn string(v: &Value, k: &str) -> Result<String, String> {
    v[k].as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("missing saved {k}"))
}
fn specs(rd: &RunDir, state: &Value) -> Result<BTreeMap<String, Spec>, String> {
    if state["config"]["conquest"] != true || state["config"]["bots"].as_u64() != Some(0) {
        return Err("resume is for persisted human CQ worlds with bots=0".into());
    }
    if !up::live_components(state).is_empty() {
        return Err("world still has running components; stop it with down before resume".into());
    }
    if state["play"]["genesis_ts"].as_i64().is_none() || !rd.path("localnet/ledger.wal").is_file() {
        return Err("world setup was not completed or its ledger is missing".into());
    }
    let program = string(&state["so"], "path")?;
    let bytes = std::fs::read(&program).map_err(|e| format!("saved program: {e}"))?;
    if hex::encode(Sha256::digest(&bytes)) != string(&state["so"], "sha256")? {
        return Err("saved program hash changed; refusing to resume with another program".into());
    }
    for value in state["ports"]
        .as_object()
        .ok_or("missing saved ports")?
        .values()
    {
        if let Some(port) = value.as_u64() {
            crate::ports::check(port as u16)?;
        }
    }
    let mut out = BTreeMap::new();
    for name in ORDER {
        let v = &state["components"][name]["spec"];
        if v.is_null() && name == "keeper-b" {
            continue;
        }
        let mut spec = Spec {
            name: name.into(),
            program: PathBuf::from(string(v, "program")?),
            args: v["args"]
                .as_array()
                .ok_or("missing saved arguments")?
                .iter()
                .map(|x| {
                    x.as_str()
                        .map(str::to_owned)
                        .ok_or("invalid saved argument".to_string())
                })
                .collect::<Result<_, _>>()?,
            env: vec![],
            cwd: PathBuf::from(string(v, "cwd")?),
            log: PathBuf::from(string(v, "log")?),
            finishes: false,
        };
        if !spec.program.is_file() {
            return Err(format!("{} is missing", spec.program.display()));
        }
        if name != "relay" {
            run::check_native_binary(rd, &spec.program)?;
        }
        if name == "relay" {
            let token = std::fs::read_to_string(rd.path("relay/operator.token"))
                .map_err(|e| e.to_string())?;
            spec.env
                .push(("FRONTIER_OPERATOR_TOKEN".into(), token.trim().into()));
        }
        if name == "localnet" && !spec.args.iter().any(|x| x == "--start-paused") {
            spec.args.push("--start-paused".into());
        }
        out.insert(name.into(), spec);
    }
    Ok(out)
}
fn save(rd: &RunDir, state: &mut Value, procs: &BTreeMap<String, Proc>, phase: &str) {
    for (name, p) in procs {
        state["components"][name] = json!({"pid": p.pid,"start_stamp":p.start_stamp,"starts":p.starts,"done":p.done,"last_exit":p.last_exit,"spec":p.spec.to_json()});
    }
    state["phase"] = json!(phase);
    state["supervisor_pid"] = json!(std::process::id());
    state["supervisor_start_stamp"] = json!(crate::procs::start_stamp(std::process::id()));
    state["supervisor_command"] = json!(crate::procs::command_of(std::process::id()));
    state["updated_wall_ms"] = json!(run::wall_ms());
    let _ = rd.save_state(state);
}
async fn run(
    rd: &RunDir,
    state: &mut Value,
    procs: &mut BTreeMap<String, Proc>,
    saved: BTreeMap<String, Spec>,
    start_paused: bool,
) -> Result<(), String> {
    let program: Address = string(state, "program")?
        .parse()
        .map_err(|_| "invalid saved program")?;
    let season = state["season_id"].as_u64().ok_or("missing season id")?;
    let rpc = format!(
        "http://127.0.0.1:{}",
        state["ports"]["localnet"]
            .as_u64()
            .ok_or("missing RPC port")?
    );
    let chain = Chain::new(&rpc, program);
    let addrs = Addresses::new(program, season);
    // Read only: a missing authority key must never be silently replaced.
    let seed = std::fs::read_to_string(rd.path("keys/operator.seed")).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = hex::decode(seed.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid authority seed")?;
    let authority = Keypair::new_from_array(seed);
    for name in ORDER {
        let Some(spec) = saved.get(name) else {
            continue;
        };
        let mut p = Proc::new(spec.clone());
        p.start()?;
        procs.insert(name.into(), p);
        save(rd, state, procs, "resuming");
        if name == "localnet" {
            chain.wait_healthy(Duration::from_secs(180)).await?;
        }
    }
    let s = chain
        .season(&addrs)
        .await?
        .ok_or("persisted season is missing")?;
    // A conquest season: MC (3) or S1 (4).
    if s.program_version < frontier_abi::v2::presets::PROGRAM_VERSION_V2 || s.h.season_id != season
    {
        return Err("persisted season identity mismatch".into());
    }
    if !start_paused {
        chain.resume().await?;
    }
    save(rd, state, procs, "running");
    rd.event(
        None,
        "resume",
        json!({"season":season,"program":program.to_string()}),
    );
    eprintln!(
        "frontier-stack: resumed persisted season {season}; player state and game clock preserved"
    );
    let mut ended = s.status >= 4;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        for name in ORDER {
            let Some(p) = procs.get_mut(name) else {
                continue;
            };
            if p.poll_exit().is_some() {
                p.start()?;
                if name == "localnet" {
                    chain.wait_healthy(Duration::from_secs(180)).await?;
                    if !start_paused {
                        chain.resume().await?;
                    }
                }
            }
        }
        if !ended {
            let clock = chain.status().await?;
            let now = clock.now;
            if !clock.paused && now >= s.genesis_ts + s.end_bell as i64 * s.bell_secs as i64 {
                let result = up::end_season_until_done(&rpc, program, &addrs, &authority).await;
                ended = result["ok"] == true;
                rd.event(Some(now), "end-season", result);
            }
        }
        save(rd, state, procs, "running");
    }
}

pub async fn resume(rd: &RunDir, start_paused: bool) -> i32 {
    let _lock = match rd.lock() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    let mut state = match rd.load_state() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    let saved = match specs(rd, &state) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    let mut procs = BTreeMap::new();
    let result = tokio::select! { r = run(rd,&mut state,&mut procs,saved,start_paused) => r, _ = tokio::signal::ctrl_c() => Ok(()) };
    for name in ORDER.into_iter().rev() {
        if let Some(p) = procs.get_mut(name) {
            p.stop(Duration::from_secs(10));
        }
    }
    if let Err(e) = &result {
        eprintln!("frontier-stack: resume failed: {e}");
        state["error"] = json!(e);
    }
    save(
        rd,
        &mut state,
        &procs,
        if result.is_ok() {
            "interrupted"
        } else {
            "failed"
        },
    );
    if result.is_ok() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_refuses_nonhuman_and_incomplete_worlds() {
        let rd = RunDir::new(std::path::Path::new("/definitely/no/world"), "test");
        assert!(specs(&rd, &json!({"config":{"conquest":false,"bots":0}}))
            .unwrap_err()
            .contains("human"));
        assert!(specs(&rd, &json!({"config":{"conquest":true,"bots":0}}))
            .unwrap_err()
            .contains("setup"));
    }
}
