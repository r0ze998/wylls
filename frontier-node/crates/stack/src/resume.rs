//! Restart a persisted human CQ world without recreating its chain, keys or season.
use crate::{
    chain::Chain,
    procs::{Proc, Spec},
    run::{self, RunDir},
    up,
};
use fclient::{addr::Addresses, decode::Season, ports::Account, Address, Keypair, Signer};
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

/// The small set of on-chain values a saved run must match before its
/// keeper, relay or herald is restarted. The program bytes and keeper
/// journals need separate checks; this is only an identity preflight.
#[derive(Clone, Copy)]
struct ChainSeasonStamp {
    season_id: u64,
    authority: Address,
    program_version: u16,
    params_hash: [u8; 32],
    genesis_ts: i64,
    join_close_bell: u32,
    end_bell: u32,
    continuous_flag: u8,
}

impl ChainSeasonStamp {
    fn from_season(s: &Season) -> Result<Self, String> {
        let cq = s
            .conquest
            .as_ref()
            .ok_or("persisted Season has no conquest parameters")?;
        Ok(Self {
            season_id: s.h.season_id,
            authority: s.authority,
            program_version: s.program_version,
            params_hash: s.params_hash,
            genesis_ts: s.genesis_ts,
            join_close_bell: s.join_close_bell,
            end_bell: s.end_bell,
            continuous_flag: cq.continuous,
        })
    }
}

fn saved_u64(v: &Value, field: &str) -> Result<u64, String> {
    v.as_u64()
        .ok_or_else(|| format!("missing or invalid saved {field}; refusing resume"))
}

fn saved_i64(v: &Value, field: &str) -> Result<i64, String> {
    v.as_i64()
        .ok_or_else(|| format!("missing or invalid saved {field}; refusing resume"))
}

fn read_saved_continuous(v: &Value, field: &str, chain_continuous: bool) -> Result<bool, String> {
    match v {
        Value::Bool(value) => Ok(*value),
        // The field did not exist in finite-world run files before this
        // candidate. The verified finite on-chain mode supplies its value.
        Value::Null if !chain_continuous => Ok(false),
        Value::Null => Err(format!("missing saved {field} for continuous world")),
        _ => Err(format!("invalid saved {field}")),
    }
}

/// Read-only comparison. Missing old finite-mode bits are inferred only
/// after the real Season proves finite; other missing identity data refuse.
fn check_saved_chain(
    state: &Value,
    chain: ChainSeasonStamp,
    expected_id: u64,
    expected_authority: Address,
) -> Result<(), String> {
    use frontier_abi::v2::presets::PROGRAM_VERSION_V2;
    if chain.season_id != expected_id
        || chain.authority != expected_authority
        || chain.program_version < PROGRAM_VERSION_V2
    {
        return Err("persisted Season identity or authority mismatch".into());
    }
    if chain.continuous_flag > 1 {
        return Err("invalid on-chain continuous flag".into());
    }
    let chain_continuous = chain.continuous_flag == 1;
    if chain_continuous != (chain.end_bell == u32::MAX && chain.join_close_bell == u32::MAX) {
        return Err("on-chain continuous flag and end/join limits disagree".into());
    }
    if !chain_continuous && (chain.join_close_bell >= chain.end_bell || chain.end_bell > 4_032) {
        return Err("on-chain finite end/join limits are invalid".into());
    }
    let saved_continuous = read_saved_continuous(
        &state["config"]["continuous"],
        "continuous mode",
        chain_continuous,
    )?;
    let saved_season_continuous = read_saved_continuous(
        &state["season"]["continuous"],
        "Season continuous flag",
        chain_continuous,
    )?;
    if saved_continuous != chain_continuous || saved_season_continuous != chain_continuous {
        return Err("saved and on-chain continuous modes disagree".into());
    }
    let saved_hash = state["season"]["params_hash"]
        .as_str()
        .ok_or("missing saved Season params hash; refusing resume")?;
    let saved_hash: [u8; 32] = hex::decode(saved_hash)
        .map_err(|_| "invalid saved Season params hash")?
        .try_into()
        .map_err(|_| "invalid saved Season params hash length")?;
    if saved_hash != chain.params_hash {
        return Err("saved and on-chain Season params hashes disagree".into());
    }
    if saved_u64(&state["season"]["program_version"], "program version")?
        != u64::from(chain.program_version)
        || saved_i64(&state["season"]["genesis_ts"], "genesis time")? != chain.genesis_ts
        || saved_i64(&state["play"]["genesis_ts"], "play genesis time")? != chain.genesis_ts
        || saved_u64(&state["season"]["join_close_bell"], "join deadline")?
            != u64::from(chain.join_close_bell)
        || saved_u64(&state["season"]["end_bell"], "end bell")? != u64::from(chain.end_bell)
    {
        return Err("saved and on-chain Season parameters disagree".into());
    }
    Ok(())
}

/// The localnet records a LoaderV3 Program as tag 2 + its derived
/// ProgramData address, and ProgramData as a 45-byte header followed by
/// the exact deployed ELF and zero padding to max_len. Refuse any unknown
/// layout or nonzero padding instead of guessing the executable length.
fn check_loader_program(
    program: Address,
    pd_address: Address,
    expected_authority: Address,
    program_account: &Account,
    pd_account: &Account,
    saved_so: &[u8],
) -> Result<(), String> {
    let bad = || "saved .so and on-chain LoaderV3 ProgramData disagree".to_string();
    let loader = fclient::addr::address(fclient::abi::LOADER_V3);
    let expected_pd = fclient::addr::programdata(&program);
    if pd_address != expected_pd
        || program_account.owner != loader
        || !program_account.executable
        || program_account.data.len() != 36
        || program_account.data[..4] != [2, 0, 0, 0]
        || program_account.data[4..36] != expected_pd.as_ref()[..]
        || pd_account.owner != loader
        || pd_account.executable
        || pd_account.data.len() < 45
        || pd_account.data[..4] != [3, 0, 0, 0]
        || saved_so.get(..6) != Some(b"\x7fELF\x02\x01".as_slice())
    {
        return Err(bad());
    }
    if pd_account.data[12] != 1 || pd_account.data[13..45] != expected_authority.as_ref()[..] {
        return Err(bad());
    }
    let end = 45usize.checked_add(saved_so.len()).ok_or_else(bad)?;
    if pd_account.data.get(45..end) != Some(saved_so)
        || !pd_account.data[end..].iter().all(|b| *b == 0)
    {
        return Err(bad());
    }
    Ok(())
}

fn specs(rd: &RunDir, state: &Value) -> Result<BTreeMap<String, Spec>, String> {
    if state["config"]["continuous"] == true {
        return Err("resume of continuous worlds is not supported until saved bots and the chain flag are verified".into());
    }
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
    let mut checked_season = None;
    for name in ORDER {
        let Some(spec) = saved.get(name) else {
            continue;
        };
        let mut p = Proc::new(spec.clone());
        p.start()?;
        procs.insert(name.into(), p);
        if name == "localnet" {
            chain.wait_healthy(Duration::from_secs(180)).await?;
            // Only localnet is running. Check its actual owner, address and
            // saved identity before starting any keeper or public service.
            let account = chain
                .accounts(&[addrs.season])
                .await?
                .into_iter()
                .next()
                .flatten()
                .ok_or("persisted Season is missing")?;
            if account.owner != program {
                return Err("persisted Season owner mismatch".into());
            }
            let season_account = Season::decode(&account.data)
                .map_err(|e| format!("persisted Season cannot be decoded: {e:?}"))?;
            let stamp = ChainSeasonStamp::from_season(&season_account)?;
            check_saved_chain(state, stamp, season, authority.pubkey())?;
            let saved_so = std::fs::read(string(&state["so"], "path")?)
                .map_err(|e| format!("saved program: {e}"))?;
            if hex::encode(Sha256::digest(&saved_so)) != string(&state["so"], "sha256")? {
                return Err("saved program changed before ProgramData check".into());
            }
            let pd_address = fclient::addr::programdata(&program);
            let mut deployed = chain.accounts(&[program, pd_address]).await?.into_iter();
            let program_account = deployed
                .next()
                .flatten()
                .ok_or("deployed program account is missing")?;
            let pd_account = deployed
                .next()
                .flatten()
                .ok_or("deployed ProgramData account is missing")?;
            check_loader_program(
                program,
                pd_address,
                authority.pubkey(),
                &program_account,
                &pd_account,
                &saved_so,
            )?;
            checked_season = Some(season_account);
        }
        save(rd, state, procs, "resuming");
    }
    let s = checked_season.ok_or("persisted Season was not checked before resume")?;
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
    fn loader_program_preflight_checks_exact_elf_and_zero_padding() {
        let program = Address::new_from_array([7; 32]);
        let pd_address = fclient::addr::programdata(&program);
        let authority = Address::new_from_array([5; 32]);
        let loader = fclient::addr::address(fclient::abi::LOADER_V3);
        let so = [b"\x7fELF\x02\x01".as_slice(), &[4; 58]].concat();
        let mut program_data = vec![0; 36];
        program_data[..4].copy_from_slice(&2u32.to_le_bytes());
        program_data[4..36].copy_from_slice(pd_address.as_ref());
        let program_account = Account {
            lamports: 1,
            data: program_data,
            owner: loader,
            executable: true,
        };
        let mut pd_data = vec![0; 45 + so.len() + 16];
        pd_data[..4].copy_from_slice(&3u32.to_le_bytes());
        pd_data[4..12].copy_from_slice(&42u64.to_le_bytes());
        pd_data[12] = 1;
        pd_data[13..45].copy_from_slice(authority.as_ref());
        pd_data[45..45 + so.len()].copy_from_slice(&so);
        let pd_account = Account {
            lamports: 1,
            data: pd_data,
            owner: loader,
            executable: false,
        };
        let check = |pa: &Account, pd: &Account| {
            check_loader_program(program, pd_address, authority, pa, pd, &so)
        };
        assert!(check(&program_account, &pd_account).is_ok());

        let mut wrong = program_account.clone();
        wrong.data[4] ^= 1;
        assert!(check(&wrong, &pd_account).is_err());
        let mut wrong = program_account.clone();
        wrong.executable = false;
        assert!(check(&wrong, &pd_account).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[0] = 9;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[45] ^= 1;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[45 + so.len()] = 1;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[12] = 2;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[12] = 0;
        wrong.data[13..45].fill(0);
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[13] ^= 1;
        assert!(check(&program_account, &wrong).is_err());
        assert!(check_loader_program(
            program,
            Address::new_from_array([8; 32]),
            authority,
            &program_account,
            &pd_account,
            &so
        )
        .is_err());
    }

    #[test]
    fn saved_season_preflight_refuses_mode_identity_and_old_state_mismatch() {
        let authority = Address::new_from_array([3; 32]);
        let finite = ChainSeasonStamp {
            season_id: 7,
            authority,
            program_version: 4,
            params_hash: [9; 32],
            genesis_ts: 100,
            join_close_bell: 10,
            end_bell: 20,
            continuous_flag: 0,
        };
        let mut saved = json!({
            "config": {"continuous": false},
            "season": {
                "continuous": false,
                "params_hash": hex::encode(finite.params_hash),
                "program_version": 4,
                "genesis_ts": 100,
                "join_close_bell": 10,
                "end_bell": 20
            },
            "play": {"genesis_ts": 100}
        });
        assert!(check_saved_chain(&saved, finite, 7, authority).is_ok());
        assert!(check_saved_chain(&saved, finite, 8, authority).is_err());
        assert!(check_saved_chain(&saved, finite, 7, Address::new_from_array([4; 32])).is_err());

        saved["season"]["params_hash"] = json!(hex::encode([8; 32]));
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["season"]["params_hash"] = json!(hex::encode(finite.params_hash));
        saved["season"]["end_bell"] = json!(21);
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["season"]["end_bell"] = json!(20);
        saved["season"]
            .as_object_mut()
            .unwrap()
            .remove("params_hash");
        assert!(check_saved_chain(&saved, finite, 7, authority)
            .unwrap_err()
            .contains("missing saved Season params hash"));

        saved["season"]["params_hash"] = json!(hex::encode(finite.params_hash));
        // Old finite run files had neither boolean; verified finite chain
        // parameters make that omission safe to interpret as false.
        saved["config"]
            .as_object_mut()
            .unwrap()
            .remove("continuous");
        saved["season"]
            .as_object_mut()
            .unwrap()
            .remove("continuous");
        assert!(check_saved_chain(&saved, finite, 7, authority).is_ok());
        saved["config"]["continuous"] = json!(true);
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["config"]["continuous"] = json!(false);
        let continuous = ChainSeasonStamp {
            join_close_bell: u32::MAX,
            end_bell: u32::MAX,
            continuous_flag: 1,
            ..finite
        };
        assert!(check_saved_chain(&saved, continuous, 7, authority).is_err());
        saved["config"]["continuous"] = json!(true);
        saved["season"]["continuous"] = json!(true);
        saved["season"]["join_close_bell"] = json!(u32::MAX);
        saved["season"]["end_bell"] = json!(u32::MAX);
        assert!(check_saved_chain(&saved, continuous, 7, authority).is_ok());
        assert!(check_saved_chain(
            &saved,
            ChainSeasonStamp {
                continuous_flag: 0,
                ..continuous
            },
            7,
            authority
        )
        .is_err());
        assert!(check_saved_chain(
            &saved,
            ChainSeasonStamp {
                continuous_flag: 0,
                end_bell: 20,
                join_close_bell: 20,
                ..finite
            },
            7,
            authority
        )
        .is_err());
    }

    #[test]
    fn resume_refuses_nonhuman_and_incomplete_worlds() {
        let rd = RunDir::new(std::path::Path::new("/definitely/no/world"), "test");
        assert!(specs(
            &rd,
            &json!({"config":{"continuous":true,"conquest":true,"bots":0}})
        )
        .unwrap_err()
        .contains("continuous"));
        assert!(specs(&rd, &json!({"config":{"conquest":false,"bots":0}}))
            .unwrap_err()
            .contains("human"));
        assert!(specs(&rd, &json!({"config":{"conquest":true,"bots":0}}))
            .unwrap_err()
            .contains("setup"));
    }
}
