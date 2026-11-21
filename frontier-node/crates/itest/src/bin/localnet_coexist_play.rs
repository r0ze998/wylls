//! TEST-ONLY local node of the ②+⑨+⑩ coexist lane (`scripts/play-local.sh --coexist`; workstream 4's allocation
//! rev 8): the REAL coexist SBF artefact (version 0x7805, `RULESET_HASH_V4`) in the in-process LiteSVM chain, the
//! world and the first flow of `itest::coexist_play` (a StockSwap, a capacity loan and a custody lot, every fixture
//! named there), then serves JSON-RPC and WebSocket on 127.0.0.1 until Ctrl-C (or SIGTERM), then stops. Prints one
//! public JSON line (the metadata) when ready. No page, relay, herald or keeper yet (no UI for the three features);
//! no key is read or stored, nothing secret is printed, memory only.
//!
//!   localnet-coexist-play --artifact <abs .so> --artifact-sha256 <hex> --rpc-port <41000-41999> \
//!     --ws-port <41000-41999> [--no-demo]
use std::sync::{Arc, Mutex};

use fclient::Signer;
use frontier_abi::feature_registry as fr;
use itest::coexist_play as cp;
use serde_json::json;
use sha2::{Digest, Sha256};

fn port(v: &str) -> Result<u16, String> {
    let p: u16 = v.parse().map_err(|_| format!("bad port {v}"))?;
    if !(41_000..=41_999).contains(&p) || p == itest::expedition_play::REFUSED_PORT {
        return Err(format!(
            "port {p} is outside 41000-41999 (or the usual stack's {})",
            itest::expedition_play::REFUSED_PORT
        ));
    }
    Ok(p)
}

fn main() {
    let result = (|| -> Result<(), String> {
        let mut args = std::env::args().skip(1);
        let (mut artifact, mut sha, mut rpc, mut ws, mut demo) = (None, None, None, None, true);
        while let Some(a) = args.next() {
            let mut val = || args.next().ok_or(format!("{a} needs a value"));
            match a.as_str() {
                "--artifact" => artifact = Some(val()?),
                "--artifact-sha256" => sha = Some(val()?),
                "--rpc-port" => rpc = Some(port(&val()?)?),
                "--ws-port" => ws = Some(port(&val()?)?),
                "--no-demo" => demo = false,
                other => return Err(format!("unknown argument {other}")),
            }
        }
        let artifact = artifact.ok_or("--artifact is required")?;
        if !std::path::Path::new(&artifact).is_absolute() {
            return Err("--artifact must be an absolute path".into());
        }
        let sha = sha.ok_or("--artifact-sha256 is required")?;
        let (rpc, ws) = (
            rpc.ok_or("--rpc-port is required")?,
            ws.ok_or("--ws-port is required")?,
        );
        if rpc == ws {
            return Err("--rpc-port and --ws-port must differ".into());
        }
        let bytes = std::fs::read(&artifact).map_err(|e| format!("read {artifact}: {e}"))?;
        if hex::encode(Sha256::digest(&bytes)) != sha {
            return Err("the artefact is not the one named by --artifact-sha256".into());
        }
        let problems = cp::artifact_problems(&bytes);
        if !problems.is_empty() {
            return Err(format!(
                "not the coexist lane artefact: {}",
                problems.join(", ")
            ));
        }
        let mut w = cp::world(&bytes, fr::COEXIST_LANE_VERSION, true);
        let d = if demo { Some(cp::demo(&mut w)) } else { None };
        let steps: Vec<_> =
            w.cu.iter()
                .map(|(s, u)| json!({"step": s, "cu": u}))
                .collect();
        let (season, program, home) = (w.a.season, w.a.program, w.home);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(async move {
            let state = Arc::new(Mutex::new(w.c));
            let running = localnet::server::start_with_policy(state, rpc, ws, localnet::server::Policy::MEMORY_ONLY.with_control_from_env()).await?;
            let meta = json!({
                "schema": "frontier-localnet-coexist-play-v1",
                "rpc_url": running.url(),
                "ws_url": running.ws_url(),
                "listen": "127.0.0.1 only",
                "program": program.to_string(),
                "program_version": format!("0x{:04x}", fr::COEXIST_LANE_VERSION),
                "ruleset": "RULESET_HASH_V4 (custody), rules version 13",
                "artifact": {"path": artifact, "sha256": sha, "bytes": bytes.len(),
                    "markers": cp::MARKERS.iter().map(|m| String::from_utf8_lossy(m).to_string()).collect::<Vec<_>>()},
                "season": season.to_string(),
                "home_province": [home.0, home.1],
                "features": {"rights": "0xD0-0xD5", "custody": "0xC2-0xCC", "capacity": "0xF0-0xFD", "registry": "frontier_abi::feature_registry (ABI-ALLOCATION rev 8)"},
                "demo": d.as_ref().map(|d| json!({
                    "player_a": d.a.pubkey().to_string(), "player_b": d.b.pubkey().to_string(),
                    "facility": d.facility.to_string(), "vault": d.vault.to_string(), "pool": d.pool.to_string(),
                    "grant": d.grant.to_string(), "lot": d.lot.to_string(), "vault_arms_milli": d.arms,
                    "steps": steps,
                })),
                "fixtures": "see itest::coexist_play (Base Season 0x7805 / RULESET_HASH_V4, seeded ring 2, workshop and store top-ups, the vault's ore and wood)",
                "services_not_started": ["page", "relay", "herald", "keeper", "beacon"],
                "persistence": "memory only",
            });
            println!("{meta}");
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
            tokio::select! {
                r = tokio::signal::ctrl_c() => r.map_err(|e| e.to_string())?,
                _ = term.recv() => {}
            }
            running.stop();
            eprintln!("localnet-coexist-play: stopped");
            Ok::<(), String>(())
        })
    })();
    if let Err(e) = result {
        eprintln!("localnet-coexist-play: {e}");
        std::process::exit(2);
    }
}
