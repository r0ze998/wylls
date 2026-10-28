//! `frontier-stack land`: the land of a local world, read and grown by hand
//! (map growth verification, `docs/frontier/map-growth/`).
//!
//! ```text
//! frontier-stack land --run-id ID [--do status]
//! frontier-stack land --run-id ID --do open-ring
//! frontier-stack land --run-id ID --do open-province --at P,Q
//! ```
//!
//! - **status** prints, as JSON, the season's `r_max` and genesis ring, the
//!   Frontier's `rings_opened` and folded counters, and for every ring up to
//!   `rings_opened` its RingSeed state and how many of its `6d` Provinces
//!   are on chain; then why the next ring waits (the keeper's own check,
//!   `fclient::land::ring_open_check`).
//! - **open-ring** sends OpenRing(`rings_opened`) and **open-province**
//!   OpenProvince(P, Q), paid by the world's operator key. They are the
//!   program's own permissionless instructions (any payer may send them):
//!   nothing is bypassed, and a refusal (`Capacity`, `TooEarly`,
//!   `SeedNotReady`, `AlreadyDone`, `BadData` …) is printed as the program
//!   gave it. The keeper's `rings` duty sends the same writes on its own.
//!
//! Local worlds only: the command takes no RPC address; it talks to the
//! run's own `127.0.0.1` port from `state.json`.

use std::time::Duration;

use fclient::addr::Addresses;
use fclient::decode::{Frontier, RingSeed};
use fclient::{ix, Address, Keypair, Signer};
use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord};
use serde_json::{json, Value};

use crate::chain::Chain;
use crate::run::RunDir;

/// What `land` was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LandOp {
    Status,
    OpenRing,
    OpenProvince(i16, i16),
}

/// `--do` and `--at` as given.
pub fn parse_op(what: Option<&str>, at: Option<&str>) -> Result<LandOp, String> {
    match what.unwrap_or("status") {
        "status" => Ok(LandOp::Status),
        "open-ring" => Ok(LandOp::OpenRing),
        "open-province" => {
            let at = at.ok_or("--do open-province needs --at P,Q")?;
            let (p, q) = at.split_once(',').ok_or("--at is P,Q")?;
            let p = p
                .trim()
                .parse::<i16>()
                .map_err(|_| "--at: P is not an i16")?;
            let q = q
                .trim()
                .parse::<i16>()
                .map_err(|_| "--at: Q is not an i16")?;
            Ok(LandOp::OpenProvince(p, q))
        }
        other => Err(format!("--do {other}: status, open-ring or open-province")),
    }
}

/// The run's chain, addresses and operator key (read only from the run directory).
fn world(rd: &RunDir) -> Result<(Chain, Addresses, Keypair), String> {
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
    let seed = std::fs::read_to_string(rd.path("keys/operator.seed")).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = hex::decode(seed.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid operator seed")?;
    let chain = Chain::new(&format!("http://127.0.0.1:{port}"), program);
    Ok((
        chain,
        Addresses::new(program, season),
        Keypair::new_from_array(seed),
    ))
}

/// The land of the world as JSON (`status`).
pub async fn status_json(chain: &Chain, a: &Addresses) -> Result<Value, String> {
    let st = chain.status().await?;
    let season = chain.season(a).await?.ok_or("no Season account yet")?;
    let fr = chain
        .accounts(&[a.frontier()])
        .await?
        .into_iter()
        .next()
        .flatten()
        .and_then(|x| Frontier::decode(&x.data).ok())
        .ok_or("no Frontier account yet")?;
    let mut rings = vec![];
    for d in 0..fr.rings_opened {
        let rs = chain
            .accounts(&[a.ring_seed(d)])
            .await?
            .into_iter()
            .next()
            .flatten()
            .and_then(|x| RingSeed::decode(&x.data).ok());
        let coords = ring_provinces(d as u32);
        let keys: Vec<Address> = coords.iter().map(|c| a.province(c.p, c.q)).collect();
        let present = chain
            .accounts(&keys)
            .await?
            .iter()
            .filter(|x| {
                x.as_ref()
                    .is_some_and(|x| x.owner == a.program && !x.data.is_empty())
            })
            .count();
        rings.push(json!({
            "d": d,
            "seed": match rs.as_ref().map(|r| r.status) {
                Some(2) => "seeded",
                Some(1) => "requested",
                Some(_) => "unknown",
                None => "absent",
            },
            "provinces": present,
            "size": coords.len(),
        }));
    }
    let funds = chain.accounts(&a.province_funds()).await?;
    let lam: [u64; 6] = core::array::from_fn(|w| funds[w].as_ref().map_or(0, |x| x.lamports));
    let next = if fr.rings_opened <= season.genesis_ring as u16 {
        Value::from("genesis")
    } else {
        match fclient::land::ring_open_check(&season, &fr, &lam, st.now) {
            Ok(()) => Value::from("ready"),
            Err(w) => Value::from(format!("{w:?}")),
        }
    };
    Ok(json!({
        "rMax": season.r_max,
        "genesisRing": season.genesis_ring,
        "thetaBps": fclient::land::theta_bps(&season, st.now),
        "ringsOpened": fr.rings_opened,
        "provincesOpened": fr.provinces_opened,
        "foldBell": fr.fold_bell,
        "wedgeOpen": fr.wedge_open,
        "wedgeOccupied": fr.wedge_occupied,
        "rings": rings,
        "nextRing": next,
    }))
}

/// `frontier-stack land`: prints the land, or sends one land write and prints
/// the land after it. Exit 0 when the write landed (or for `status`), 1 when
/// the program refused it, 2 when the world cannot be read.
pub async fn land(rd: &RunDir, op: LandOp) -> i32 {
    let (chain, a, payer) = match world(rd) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("frontier-stack land: {e}");
            return 2;
        }
    };
    let sent = match op {
        LandOp::Status => Ok(()),
        LandOp::OpenRing => match status_json(&chain, &a).await {
            Ok(s) => {
                let d = s["ringsOpened"].as_u64().unwrap_or(0) as u16;
                println!("OpenRing({d})");
                let i = ix::open_ring(&a, payer.pubkey(), d);
                chain
                    .send_op(&[i], &[&payer], Duration::from_secs(30))
                    .await
            }
            Err(e) => Err(e),
        },
        LandOp::OpenProvince(p, q) => {
            let ring = ProvinceCoord::new(p as i32, q as i32).ring();
            println!("OpenProvince({p},{q}) (ring {ring})");
            let i = ix::open_province(&a, payer.pubkey(), p, q);
            chain
                .send_op(&[i], &[&payer], Duration::from_secs(30))
                .await
        }
    };
    let code = match &sent {
        Ok(()) => 0,
        Err(e) => {
            // The program's refusal, as it gave it (first line and the program's own log lines).
            for l in e
                .lines()
                .filter(|l| !l.contains("invoke [") && !l.contains("consumed"))
            {
                println!("{l}");
            }
            1
        }
    };
    match status_json(&chain, &a).await {
        Ok(s) => println!("{}", serde_json::to_string_pretty(&s).unwrap_or_default()),
        Err(e) => {
            eprintln!("frontier-stack land: {e}");
            return 2;
        }
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn land_ops_parse() {
        assert_eq!(parse_op(None, None), Ok(LandOp::Status));
        assert_eq!(parse_op(Some("open-ring"), None), Ok(LandOp::OpenRing));
        assert_eq!(
            parse_op(Some("open-province"), Some("5,-2")),
            Ok(LandOp::OpenProvince(5, -2))
        );
        assert!(parse_op(Some("open-province"), None).is_err());
        assert!(parse_op(Some("open-province"), Some("5")).is_err());
        assert!(parse_op(Some("open-province"), Some("40000,0")).is_err());
        assert!(parse_op(Some("grow"), None).is_err());
    }
}
