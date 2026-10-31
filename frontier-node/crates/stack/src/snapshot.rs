//! `frontier-stack snapshot`: a local world's on-chain state as JSON, for
//! comparing a continuous world before and after a test boundary bell and
//! after `down` / `resume` (continuous world, migration candidate).
//!
//! ```text
//! frontier-stack snapshot --run-id ID [--out FILE]
//! ```
//!
//! Every account the game program owns (`getProgramAccounts` on the run's
//! own 127.0.0.1 localnet): its kind (the 8-byte magic), size, lamports,
//! chained-event sequence and the sha256 of its bytes; totals per kind; the
//! Citizens (wallet, faction, holdings) and Holdings (owner, place, state,
//! tier, stores, escrow) decoded with fclient; the Season's continuity and
//! the chain clock. The keeper's journal is not read here (sqlite; see
//! `scripts/keeper-journal-counts.py`). Local worlds only.

use std::collections::BTreeMap;

use fclient::decode::{Citizen, Holding, Season};
use fclient::Address;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chain::Chain;
use crate::run::RunDir;

/// The run's chain and program (read only from the run directory).
fn world(rd: &RunDir) -> Result<(Chain, Address, u64), String> {
    let state = rd.load_state()?;
    let port = state["ports"]["localnet"]
        .as_u64()
        .ok_or("state.json names no localnet port")?;
    let program: Address = state["program"]
        .as_str()
        .ok_or("state.json names no program")?
        .parse()
        .map_err(|_| "invalid saved program")?;
    let season = state["season_id"].as_u64().ok_or("missing season id")?;
    Ok((
        Chain::new(&format!("http://127.0.0.1:{port}"), program),
        program,
        season,
    ))
}

/// The magic as text (`PSF1HOLD`), or hex when it is not printable.
pub fn kind_of(d: &[u8]) -> String {
    let m = &d[..d.len().min(8)];
    if m.iter().all(|c| c.is_ascii_graphic()) {
        String::from_utf8_lossy(m).into_owned()
    } else {
        hex::encode(m)
    }
}

/// One account's line of the snapshot.
pub fn account_json(key: &str, lamports: u64, d: &[u8]) -> Value {
    let seq = fclient::decode::chained_header(d).map(|h| h.event_seq);
    json!({
        "key": key, "kind": kind_of(d), "len": d.len(), "lamports": lamports,
        "event_seq": seq, "sha256": hex::encode(Sha256::digest(d)),
    })
}

fn holding_json(key: &str, h: &Holding) -> Value {
    json!({
        "key": key, "owner": h.owner_citizen.to_string(), "p": h.p, "q": h.q, "site": h.site,
        "gen": h.gen, "state": h.state, "faction": h.faction, "order": h.order, "tier": h.tier,
        "stores": h.stores.iter().map(|a| json!([a.value, a.rate, a.cap, a.t0])).collect::<Vec<_>>(),
        "reserve": h.reserve, "walls": h.walls, "escrow": h.escrow, "pool_owed": h.pool_owed,
        "transits": h.transit.iter().filter(|t| t.state != 0).count(),
    })
}

fn citizen_json(key: &str, c: &Citizen) -> Value {
    json!({
        "key": key, "wallet": c.wallet.to_string(), "faction": c.faction,
        "holdings_n": c.holdings_n, "join_bell": c.join_bell, "works": c.works,
        "explores": c.explores, "arrivals": c.arrivals, "ticket_escrow": c.ticket_escrow,
    })
}

/// The snapshot of the run's world.
pub async fn snapshot(rd: &RunDir) -> Result<Value, String> {
    let (chain, program, season_id) = world(rd)?;
    let st = chain.status().await?;
    let v = chain
        .call(
            "getProgramAccounts",
            json!([program.to_string(), {"encoding": "base64"}]),
        )
        .await?;
    let list = v.as_array().cloned().unwrap_or_default();
    let mut accounts = vec![];
    let mut kinds: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut holdings = vec![];
    let mut citizens = vec![];
    let mut season: Option<Season> = None;
    let mut lamports_total = 0u64;
    for a in &list {
        let key = a["pubkey"].as_str().unwrap_or_default().to_string();
        let lamports = a["account"]["lamports"].as_u64().unwrap_or(0);
        let data = a["account"]["data"][0]
            .as_str()
            .and_then(|s| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(s).ok()
            })
            .unwrap_or_default();
        let kind = kind_of(&data);
        let e = kinds.entry(kind.clone()).or_default();
        e.0 += 1;
        e.1 += lamports;
        lamports_total += lamports;
        if let Ok(h) = Holding::decode(&data) {
            holdings.push(holding_json(&key, &h));
        } else if let Ok(c) = Citizen::decode(&data) {
            citizens.push(citizen_json(&key, &c));
        } else if let Ok(s) = Season::decode(&data) {
            if s.h.season_id == season_id {
                season = Some(s);
            }
        }
        accounts.push(account_json(&key, lamports, &data));
    }
    accounts.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    holdings.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    citizens.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
    let bell = season
        .as_ref()
        .and_then(|s| frontier_abi::prologue::bell_at(s.genesis_ts, st.now));
    Ok(json!({
        "v": 1,
        "season": season_id.to_string(),
        "slot": st.slot, "now": st.now, "paused": st.paused, "bell": bell,
        "continuous": season.as_ref().map(|s| s.continuous()),
        "status": season.as_ref().map(|s| s.effective_status(st.now)),
        "end_bell": season.as_ref().map(|s| s.end_bell),
        "accounts_n": accounts.len(),
        "lamports_total": lamports_total,
        "kinds": kinds.iter().map(|(k, (n, l))| (k.clone(), json!({"n": n, "lamports": l})))
            .collect::<serde_json::Map<_, _>>(),
        "citizens": citizens,
        "holdings": holdings,
        "accounts": accounts,
    }))
}

/// `frontier-stack snapshot`: prints (or writes `out`) the snapshot.
/// Exit 0, or 2 when the world cannot be read.
pub async fn run(rd: &RunDir, out: Option<&str>) -> i32 {
    match snapshot(rd).await {
        Ok(v) => {
            let s = serde_json::to_string_pretty(&v).unwrap_or_default();
            match out {
                Some(p) => {
                    if let Err(e) = std::fs::write(p, s) {
                        eprintln!("frontier-stack snapshot: {p}: {e}");
                        return 2;
                    }
                }
                None => println!("{s}"),
            }
            0
        }
        Err(e) => {
            eprintln!("frontier-stack snapshot: {e}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_lines() {
        assert_eq!(kind_of(b"PSF1HOLDrest"), "PSF1HOLD");
        assert_eq!(kind_of(&[0, 1, 2]), "000102");
        let v = account_json("k", 5, b"PSF1HOLD");
        assert_eq!(v["kind"], "PSF1HOLD");
        assert_eq!(v["lamports"], 5);
        assert_eq!(v["len"], 8);
        assert_eq!(v["event_seq"], Value::Null);
    }
}
