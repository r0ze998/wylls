//! A JSON-RPC stand-in for the chain the pass reader (`intake::RpcPasses`)
//! reads (workstream 04, 2026-11-07): `getMultipleAccounts` (base64) over a
//! map of accounts, on 127.0.0.1. The pass of the harness's citizen lives at
//! its real addresses: the Citizen (tag `OWNER`), the link
//! `["nft-citizen-link", season, asset]` and the policy
//! `["nft-resident-policy"]` under the game program, the resident record
//! `["resident", asset]` under the resident program (public addresses
//! computed as PDAs), the asset and the Clock.
//!
//! Keyless: every key is a fixed 32-byte value or a PDA; the asset and the
//! resident record are bytes in workstream 20's layouts; nothing is
//! generated, derived or signed.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;

pub const PROGRAM: [u8; 32] = [0x11; 32];
pub const SEASON: [u8; 32] = [0x22; 32];
pub const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
pub const CORE: [u8; 32] = [0x44; 32];
pub const COLLECTION: [u8; 32] = [0x55; 32];
pub const GUARD: [u8; 32] = [0x66; 32];
pub const ASSET: [u8; 32] = [0x5a; 32];
pub const A: [u8; 32] = [0xa1; 32];
pub const B: [u8; 32] = [0xb2; 32];
pub const SESSION_A: [u8; 32] = [0xc1; 32];
pub const SESSION_B: [u8; 32] = [0xc2; 32];
pub const NOW: i64 = 1_800_000_000;
const CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";

pub type Session = Option<([u8; 32], u32, [u8; 32], i64)>;

pub fn b58(k: &[u8; 32]) -> String {
    Address::new_from_array(*k).to_string()
}

fn pda(seeds: &[&[u8]], program: &[u8; 32]) -> [u8; 32] {
    Address::find_program_address(seeds, &Address::new_from_array(*program))
        .0
        .to_bytes()
}

/// The harness's citizen: its `citizen_tag` (first 8 bytes, LE) is `tag`.
pub fn citizen_of(tag: u64) -> [u8; 32] {
    let mut c = [0x9cu8; 32];
    c[..8].copy_from_slice(&tag.to_le_bytes());
    c
}

pub fn link_key() -> [u8; 32] {
    pda(&[b"nft-citizen-link", &SEASON, &ASSET], &PROGRAM)
}
pub fn policy_key() -> [u8; 32] {
    pda(&[b"nft-resident-policy"], &PROGRAM)
}
pub fn resident_key() -> [u8; 32] {
    pda(&[b"resident", &ASSET], &RESIDENT_PROGRAM)
}

fn guarded_tail(base: usize) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(&GUARD);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

pub fn asset_bytes(owner: &[u8; 32]) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    let base = a.len();
    a.extend_from_slice(&guarded_tail(base));
    a
}

pub fn resident_bytes(generation: u32, session: Session) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    if let Some((key, gen, setter, expiry)) = session {
        r[52..84].copy_from_slice(&key);
        r[84..92].copy_from_slice(&expiry.to_le_bytes());
        r[92..96].copy_from_slice(&gen.to_le_bytes());
        r[96..128].copy_from_slice(&setter);
    }
    r
}

/// The chain: address → (owner, data).
#[derive(Clone, Default)]
pub struct PassNode {
    accounts: Arc<Mutex<HashMap<[u8; 32], ([u8; 32], Vec<u8>)>>>,
    pub url: String,
}

impl PassNode {
    /// A node serving the pass of citizen `tag`, owned by `owner` at
    /// `generation` with `session`.
    pub fn start(tag: u64, owner: [u8; 32], generation: u32, session: Session) -> PassNode {
        let mut n = PassNode::default();
        let citizen = citizen_of(tag);
        {
            use frontier_abi::v2::layout::player::citizen as C;
            let mut cd = vec![0u8; C::SIZE];
            assert!(frontier_abi::resident_citizen::mark(&mut cd, &ASSET));
            let mut link = vec![0u8; frontier_abi::resident_binding::LEN];
            assert!(frontier_abi::resident_binding::write_once(
                &mut link,
                &frontier_abi::resident_binding::Record {
                    asset: ASSET,
                    resident: resident_key(),
                    citizen,
                }
            ));
            let mut policy = vec![0u8; frontier_abi::resident_policy::LEN];
            assert!(frontier_abi::resident_policy::write_once(
                &mut policy,
                &frontier_abi::resident_auth::Policy {
                    core_program: CORE,
                    resident_program: RESIDENT_PROGRAM,
                    collection: COLLECTION,
                    guard_authority: GUARD,
                }
            ));
            let mut clock = vec![0u8; 40];
            clock[32..40].copy_from_slice(&NOW.to_le_bytes());
            let mut m = n.accounts.lock().unwrap();
            m.insert(citizen, (PROGRAM, cd));
            m.insert(link_key(), (PROGRAM, link));
            m.insert(policy_key(), (PROGRAM, policy));
            m.insert(ASSET, (CORE, asset_bytes(&owner)));
            m.insert(
                resident_key(),
                (RESIDENT_PROGRAM, resident_bytes(generation, session)),
            );
            let sysvar = Address::from_str_const(CLOCK).to_bytes();
            m.insert(sysvar, ([0x06; 32], clock));
        }
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        n.url = format!("http://{}", l.local_addr().unwrap());
        let accounts = n.accounts.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let accounts = accounts.clone();
                std::thread::spawn(move || serve(&mut s, &accounts));
            }
        });
        n
    }

    /// The resident program's TransferResident: the asset's owner and the
    /// resident record (generation, session) as it leaves them.
    pub fn transfer(&self, to: [u8; 32], generation: u32, session: Session) {
        let mut m = self.accounts.lock().unwrap();
        m.get_mut(&ASSET).unwrap().1 = asset_bytes(&to);
        m.get_mut(&resident_key()).unwrap().1 = resident_bytes(generation, session);
    }

    pub fn edit(&self, key: [u8; 32], f: impl FnOnce(&mut ([u8; 32], Vec<u8>))) {
        f(self.accounts.lock().unwrap().get_mut(&key).unwrap());
    }

    pub fn remove(&self, key: [u8; 32]) {
        self.accounts.lock().unwrap().remove(&key);
    }
}

fn serve(s: &mut std::net::TcpStream, accounts: &Mutex<HashMap<[u8; 32], ([u8; 32], Vec<u8>)>>) {
    let mut buf = vec![];
    let mut chunk = [0u8; 4096];
    let body = loop {
        let Ok(k) = s.read(&mut chunk) else { return };
        if k == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..k]);
        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
        let len = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if buf.len() >= end + 4 + len {
            break buf[end + 4..end + 4 + len].to_vec();
        }
    };
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let result = match req.get("method").and_then(Value::as_str) {
        Some("getMultipleAccounts") => {
            let m = accounts.lock().unwrap();
            let keys = req["params"][0].as_array().cloned().unwrap_or_default();
            let vals: Vec<Value> = keys
                .iter()
                .map(|k| {
                    let k: Address = k.as_str().unwrap_or("").parse().unwrap_or_default();
                    match m.get(&k.to_bytes()) {
                        None => Value::Null,
                        Some((owner, data)) => json!({
                            "lamports": 1, "owner": b58(owner), "executable": false, "rentEpoch": 0,
                            "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"],
                        }),
                    }
                })
                .collect();
            json!({"context": {"slot": 7}, "value": vals})
        }
        _ => Value::Null,
    };
    let out = json!({"jsonrpc": "2.0", "id": req.get("id").cloned().unwrap_or(json!(1)), "result": result}).to_string();
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
        out.len()
    );
    let _ = s.write_all(resp.as_bytes());
}

/// The requester file the gateway hands over (`run accept --requester`).
pub fn requester_json(actor: &[u8; 32], generation: u32, citizen: &[u8; 32]) -> String {
    json!({"actor": b58(actor), "generation": generation, "citizen": b58(citizen),
           "authenticatedBy": "test: the gateway's credential layer (stand-in)"})
    .to_string()
}
