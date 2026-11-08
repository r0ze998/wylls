//! The pass of a Citizen read from the chain over JSON-RPC (workstream 04,
//! 2026-11-07): the [`Passes`] the intake uses outside the simulated world.
//!
//! From the Citizen's address, in three reads:
//! 1. the Citizen (the game program's account): its resident asset
//!    (`resident_citizen::resident_asset`); a Citizen without one is not a
//!    pass's (`Ok(None)`);
//! 2. the link `["nft-citizen-link", season, asset]` and the policy
//!    `["nft-resident-policy"]` under the game program (public addresses
//!    computed as PDAs; no keypair); no link in this Season: `Ok(None)`;
//! 3. the asset, the resident record `["resident", asset]` under the
//!    policy's resident program (it must be the link's), and the Clock, in
//!    **one** `getMultipleAccounts`, so the owner, the generation, the
//!    session and the time are of one context slot: a transfer cannot land
//!    between the owner read and the generation read.
//!
//! Every account is read at `confirmed` (a transfer is refused as soon as
//! the cluster confirms it). The endpoint is plain HTTP (a local node or a
//! loopback proxy); no key is involved anywhere.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::str::FromStr;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;

use crate::intake::{PassAccount, PassView, Passes};

/// The Clock sysvar's address.
const CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";

pub struct RpcPasses {
    /// `host:port` of a plain-HTTP JSON-RPC endpoint.
    pub endpoint: String,
    pub program: [u8; 32],
    pub season: [u8; 32],
}

impl RpcPasses {
    /// `url` is `http://host:port` (no TLS).
    pub fn new(url: &str, program: [u8; 32], season: [u8; 32]) -> Result<RpcPasses, String> {
        let endpoint = url
            .strip_prefix("http://")
            .ok_or("the pass reader takes an http:// endpoint (a local node or a loopback proxy)")?
            .trim_end_matches('/')
            .to_string();
        Ok(RpcPasses {
            endpoint,
            program,
            season,
        })
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body =
            json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let mut s = TcpStream::connect(&self.endpoint).map_err(|e| format!("rpc: {e}"))?;
        s.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let req = format!(
            "POST / HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.endpoint,
            body.len()
        );
        s.write_all(req.as_bytes())
            .map_err(|e| format!("rpc: {e}"))?;
        let mut raw = String::new();
        s.read_to_string(&mut raw)
            .map_err(|e| format!("rpc: {e}"))?;
        let (head, rest) = raw.split_once("\r\n\r\n").ok_or("rpc: no HTTP body")?;
        let text = if head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            crate::gateway::dechunk(rest)?
        } else {
            rest.to_string()
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("rpc: {e}"))?;
        if let Some(e) = v.get("error") {
            return Err(format!("rpc {method}: {e}"));
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| format!("rpc {method}: no result"))
    }

    /// `getMultipleAccounts` at `confirmed`: each account (`None`: absent).
    fn accounts(&self, keys: &[Address]) -> Result<Vec<Option<PassAccount>>, String> {
        let r = self.call(
            "getMultipleAccounts",
            json!([keys.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
                   {"encoding": "base64", "commitment": "confirmed"}]),
        )?;
        let vals = r
            .get("value")
            .and_then(Value::as_array)
            .ok_or("rpc getMultipleAccounts: no value")?;
        if vals.len() != keys.len() {
            return Err("rpc getMultipleAccounts: wrong number of accounts".into());
        }
        keys.iter()
            .zip(vals)
            .map(|(k, v)| {
                if v.is_null() {
                    return Ok(None);
                }
                let owner = v
                    .get("owner")
                    .and_then(Value::as_str)
                    .and_then(|s| Address::from_str(s).ok())
                    .ok_or("rpc account: owner")?;
                let b64 = v
                    .get("data")
                    .and_then(|d| d.get(0))
                    .and_then(Value::as_str)
                    .ok_or("rpc account: data")?;
                let data = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| format!("rpc account data: {e}"))?;
                Ok(Some(PassAccount {
                    key: k.to_bytes(),
                    owner: owner.to_bytes(),
                    data,
                }))
            })
            .collect()
    }
}

fn pda(seeds: &[&[u8]], program: &[u8; 32]) -> Address {
    Address::find_program_address(seeds, &Address::new_from_array(*program)).0
}

impl Passes for RpcPasses {
    fn pass_of(&self, citizen: &[u8; 32]) -> Result<Option<PassView>, String> {
        let program = Address::new_from_array(self.program);
        // 1. The Citizen: the game program's, with a resident asset.
        let got = self.accounts(&[Address::new_from_array(*citizen)])?;
        let Some(c) = got.into_iter().next().flatten() else {
            return Ok(None);
        };
        if c.owner != program.to_bytes() {
            return Err("the citizen is not the game program's account".into());
        }
        let Some(asset) = frontier_abi::resident_citizen::resident_asset(&c.data) else {
            return Ok(None);
        };
        // 2. The link of this Season and the policy (PDAs).
        let link_key = pda(&[b"nft-citizen-link", &self.season, &asset], &self.program);
        let policy_key = pda(&[b"nft-resident-policy"], &self.program);
        let got = self.accounts(&[link_key, policy_key])?;
        let (Some(link), Some(policy)) = (got[0].clone(), got[1].clone()) else {
            return Ok(None);
        };
        let p = frontier_abi::resident_policy::read(&policy.data)
            .ok_or("the policy does not decode")?;
        let resident_key = pda(&[b"resident", &asset], &p.resident_program);
        let record = frontier_abi::resident_binding::read(&link.data)
            .ok_or("the pass link does not decode")?;
        if record.resident != resident_key.to_bytes() || record.asset != asset {
            return Err("the pass link names another asset or resident account".into());
        }
        // 3. The asset, the resident record and the Clock, of one context slot.
        let clock = Address::from_str(CLOCK).map_err(|e| e.to_string())?;
        let got = self.accounts(&[Address::new_from_array(asset), resident_key, clock])?;
        let asset_acct = got[0].clone().ok_or("the pass's asset is absent")?;
        let resident = got[1]
            .clone()
            .ok_or("the pass's resident record is absent")?;
        let clock = got[2].clone().ok_or("the Clock is absent")?;
        let now = clock
            .data
            .get(32..40)
            .map(|b| i64::from_le_bytes(b.try_into().expect("8 bytes")))
            .ok_or("the Clock does not decode")?;
        Ok(Some(PassView {
            program: self.program,
            link,
            policy,
            asset: asset_acct,
            resident,
            now,
        }))
    }
}

/// An address in base58 (as the gateway and the RPC write them).
pub fn address(s: &str) -> Result<[u8; 32], String> {
    Address::from_str(s)
        .map(|a| a.to_bytes())
        .map_err(|e| format!("{s}: not an address ({e})"))
}
