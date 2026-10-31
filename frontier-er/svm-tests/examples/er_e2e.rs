//! Local end-to-end driver: the board program on a local base validator and
//! a local MagicBlock ER (`mb-test-validator` + `ephemeral-validator`
//! 1.1.1), through their JSON-RPC. **Local results only**; nothing here
//! talks to a public network.
//!
//! ```text
//! er_e2e <base url> <er url> <keypair file> <step>
//!   steps: setup | roundtrip | open | close | status | base-write
//! ```
//!
//! The keypair file is a throwaway local key (created if absent). Every
//! step prints one JSON line per observation and ends with the reconciler's
//! decision (`frontier_er::guard::decide`) on what the two RPCs report.

use std::io::{Read, Write as _};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use base64::Engine;
use frontier_er::board::{self, Write, PAYLOAD_LEN};
use frontier_er::guard::{BaseObs, ErObs, Guard, Policy, RecordObs};
use frontier_er::sim::{Owner, Requester};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const WORLD: u64 = 7;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn erb() -> Address {
    "GURgmxeLRJ1swjHDtQhQdTjguNB6EZDmxSdGM3GC6Hrt"
        .parse()
        .unwrap()
}
fn dlp() -> Address {
    "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        .parse()
        .unwrap()
}
fn magic_program() -> Address {
    "Magic11111111111111111111111111111111111111"
        .parse()
        .unwrap()
}
fn magic_context() -> Address {
    "MagicContext1111111111111111111111111111111"
        .parse()
        .unwrap()
}
const SYSTEM: Address = Address::new_from_array([0; 32]);

fn pda(seeds: &[&[u8]], p: &Address) -> Address {
    Address::find_program_address(seeds, p).0
}
fn board_addr() -> Address {
    pda(&[b"wylls-er-board", &WORLD.to_le_bytes()], &erb())
}

/// Minimal HTTP/1.1 JSON-RPC (local plain http only).
fn rpc(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let hostport = url.trim_start_matches("http://").trim_end_matches('/');
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
    let mut s = TcpStream::connect(hostport).map_err(|e| format!("connect {hostport}: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(20))).ok();
    write!(
        s,
        "POST / HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, rest) = text.split_once("\r\n\r\n").ok_or("no body")?;
    let json_text = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut r = rest;
        loop {
            let (n, tail) = r.split_once("\r\n").ok_or("chunk")?;
            let n = usize::from_str_radix(n.trim(), 16).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.push_str(&tail[..n]);
            r = &tail[n + 2..];
        }
        out
    } else {
        rest.to_string()
    };
    let v: Value = serde_json::from_str(&json_text).map_err(|e| format!("{e}: {json_text}"))?;
    if let Some(e) = v.get("error") {
        return Err(e.to_string());
    }
    Ok(v["result"].clone())
}

struct Acct {
    owner: Address,
    data: Vec<u8>,
}

fn account(url: &str, k: &Address) -> Result<Option<Acct>, String> {
    let v = rpc(
        url,
        "getAccountInfo",
        json!([k.to_string(), {"encoding": "base64", "commitment": "confirmed"}]),
    )?;
    let a = &v["value"];
    if a.is_null() {
        return Ok(None);
    }
    Ok(Some(Acct {
        owner: a["owner"]
            .as_str()
            .unwrap_or_default()
            .parse()
            .map_err(|_| "owner")?,
        data: B64
            .decode(a["data"][0].as_str().unwrap_or_default())
            .map_err(|e| e.to_string())?,
    }))
}

fn send(url: &str, ixs: &[Instruction], signers: &[&Keypair]) -> Result<String, String> {
    let bh = rpc(
        url,
        "getLatestBlockhash",
        json!([{"commitment": "confirmed"}]),
    )?;
    let bh: solana_hash::Hash = bh["value"]["blockhash"]
        .as_str()
        .ok_or("blockhash")?
        .parse()
        .map_err(|_| "hash")?;
    let msg = Message::new(ixs, Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    let wire = bincode::serialize(&tx).map_err(|e| e.to_string())?;
    let sig = rpc(
        url,
        "sendTransaction",
        json!([B64.encode(wire), {"encoding": "base64", "skipPreflight": false, "preflightCommitment": "confirmed"}]),
    )?;
    let sig = sig.as_str().ok_or("sig")?.to_string();
    let t0 = Instant::now();
    loop {
        let st = rpc(
            url,
            "getSignatureStatuses",
            json!([[sig], {"searchTransactionHistory": true}]),
        )?;
        let s = &st["value"][0];
        if !s.is_null() {
            if !s["err"].is_null() {
                return Err(format!("{sig} failed: {}", s["err"]));
            }
            let c = s["confirmationStatus"].as_str().unwrap_or("");
            if c == "confirmed" || c == "finalized" {
                return Ok(sig);
            }
        }
        if t0.elapsed() > Duration::from_secs(60) {
            return Err(format!("{sig}: no confirmation in 60 s"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn ix(disc: u64, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = disc.to_le_bytes().to_vec();
    data.extend_from_slice(&WORLD.to_le_bytes());
    data.extend_from_slice(args);
    Instruction {
        program_id: erb(),
        accounts,
        data,
    }
}

fn write_ix(who: &Address, w: &Write) -> Instruction {
    let mut a = w.expect_seq.to_le_bytes().to_vec();
    a.extend_from_slice(&w.expect_head);
    a.extend_from_slice(&w.req_id);
    a.extend_from_slice(&w.payload);
    a.extend_from_slice(&w.bell.to_le_bytes());
    ix(
        1,
        &a,
        vec![
            AccountMeta::new(*who, true),
            AccountMeta::new(board_addr(), false),
        ],
    )
}

/// A write built on the board `copy` holds now.
fn mk_write(copy: &[u8]) -> Write {
    let (seq, _) = board::header(copy).expect("a board");
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[..8].copy_from_slice(&seq.to_le_bytes());
    Write::on(&board_addr().to_bytes(), copy, payload, seq as u32).expect("a board")
}

/// The board bytes `url` serves.
fn copy_at(url: &str) -> Result<Vec<u8>, String> {
    Ok(account(url, &board_addr())?.ok_or("no board")?.data)
}

fn header_of(url: &str) -> Result<Option<(Address, u64)>, String> {
    Ok(account(url, &board_addr())?.and_then(|a| board::header(&a.data).map(|h| (a.owner, h.0))))
}

fn wait<F: Fn() -> Result<bool, String>>(what: &str, secs: u64, f: F) -> Result<u128, String> {
    let t0 = Instant::now();
    loop {
        if f()? {
            return Ok(t0.elapsed().as_millis());
        }
        if t0.elapsed() > Duration::from_secs(secs) {
            return Err(format!("timeout waiting for {what}"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// One observation of both sides and the reconciler's decision. The ER
/// high-water mark is kept in `<key>.high` across runs (as a keeper keeps
/// it with its journal).
fn observe(base: &str, er: &str, validator: &Address, key: &str) -> Result<Value, String> {
    let b = board_addr();
    let ba = account(base, &b)?;
    let rec = account(base, &pda(&[b"delegation", b.as_ref()], &dlp()))?;
    let meta = account(base, &pda(&[b"delegation-metadata", b.as_ref()], &dlp()))?;
    let pending = account(base, &pda(&[b"commit-state-record", b.as_ref()], &dlp()))?.is_some();
    let slot = rpc(base, "getSlot", json!([{"commitment": "finalized"}]))?
        .as_u64()
        .unwrap_or(0);
    let owner = match &ba {
        None => Owner::System,
        Some(a) if a.owner == erb() => Owner::Program,
        Some(a) if a.owner == dlp() => Owner::Dlp,
        Some(_) => Owner::System,
    };
    let record = rec
        .as_ref()
        .filter(|r| r.data.len() >= 40)
        .map(|r| RecordObs {
            validator: r.data[8..40].try_into().unwrap(),
            requester: match meta.as_ref().and_then(|m| m.data.get(16).copied()) {
                Some(1) => Requester::Validator,
                Some(2) => Requester::Owner,
                _ => Requester::None,
            },
            request_expires: None,
            pending_commit: pending,
        });
    let bo = BaseObs {
        // These reads are `confirmed` on a single local validator; a
        // deployment reads `finalized` (see RECOVERY.ja.md).
        finalized: true,
        slot,
        owner,
        header: ba.as_ref().and_then(|a| board::header(&a.data)),
        rolled_back_at: ba.as_ref().and_then(|a| board::rolled_back_at(&a.data)),
        record,
    };
    let ea = account(er, &b);
    let ident = rpc(er, "getIdentity", json!([]));
    let eo = ErObs {
        endpoint: "er",
        reachable: ea.is_ok() && ident.is_ok(),
        identity: ident
            .ok()
            .and_then(|v| {
                v["identity"]
                    .as_str()
                    .and_then(|s| s.parse::<Address>().ok())
            })
            .map(|a| a.to_bytes())
            .unwrap_or([0; 32]),
        slot: 0,
        header: ea
            .as_ref()
            .ok()
            .and_then(|a| a.as_ref())
            .filter(|a| a.owner == erb())
            .and_then(|a| board::header(&a.data)),
        // The ER's own view (`getDelegationStatus`), not inferred from the
        // base: right after a delegation the ER may not know of it yet.
        writable: ea
            .as_ref()
            .ok()
            .and_then(|a| a.as_ref())
            .is_some_and(|a| a.owner == erb())
            && rpc(er, "getDelegationStatus", json!([b.to_string()]))
                .map(|v| v["isDelegated"] == json!(true))
                .unwrap_or(false),
    };
    let p = Policy {
        validator: validator.to_bytes(),
        retiring: None,
        escape_after_slots: 750,
        last_good_slot: slot,
    };
    let hw = format!("{key}.high");
    let mut g = Guard {
        policy: p,
        er_high: std::fs::read_to_string(&hw)
            .ok()
            .and_then(|x| x.trim().parse().ok()),
    };
    let d = g.decide(&bo, std::slice::from_ref(&eo));
    match g.er_high {
        Some(h) => std::fs::write(&hw, h.to_string()).map_err(|e| e.to_string())?,
        None => {
            let _ = std::fs::remove_file(&hw);
        }
    }
    Ok(json!({
        "base": {"owner": format!("{owner:?}"), "seq": bo.header.map(|h| h.0), "record": bo.record.is_some(), "pending_commit": pending},
        "er": {"reachable": eo.reachable, "seq": eo.header.map(|h| h.0)},
        "decision": format!("{d:?}"),
    }))
}

fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let [_, base, er, key, step] = &a[..] else {
        return Err("usage: er_e2e <base url> <er url> <keypair file> <step>".into());
    };
    let auth = match std::fs::read(key) {
        Ok(b) => Keypair::try_from(&b[..]).map_err(|e| e.to_string())?,
        Err(_) => {
            let k = Keypair::new();
            std::fs::write(key, k.to_bytes()).map_err(|e| e.to_string())?;
            k
        }
    };
    let b = board_addr();
    // The trusted validator: the ER's identity, or (ER unreachable) the one
    // the base's delegation record names.
    let validator: Address = match rpc(er, "getIdentity", json!([])) {
        Ok(v) => v["identity"]
            .as_str()
            .ok_or("identity")?
            .parse()
            .map_err(|_| "id")?,
        Err(_) => account(base, &pda(&[b"delegation", b.as_ref()], &dlp()))?
            .and_then(|r| {
                r.data
                    .get(8..40)
                    .map(|k| Address::new_from_array(k.try_into().unwrap()))
            })
            .ok_or("ER unreachable and no delegation record")?,
    };
    let me = auth.pubkey();
    let log = |k: &str, v: Value| println!("{}", json!({"step": k, "v": v}));

    let delegate = |base: &str| {
        send(
            base,
            &[ix(
                2,
                &[],
                vec![
                    AccountMeta::new(me, true),
                    AccountMeta::new_readonly(SYSTEM, false),
                    AccountMeta::new(b, false),
                    AccountMeta::new_readonly(erb(), false),
                    AccountMeta::new(pda(&[b"buffer", b.as_ref()], &erb()), false),
                    AccountMeta::new(pda(&[b"delegation", b.as_ref()], &dlp()), false),
                    AccountMeta::new(pda(&[b"delegation-metadata", b.as_ref()], &dlp()), false),
                    AccountMeta::new_readonly(dlp(), false),
                    AccountMeta::new_readonly(validator, false),
                ],
            )],
            &[&auth],
        )
    };
    let commit = |er: &str, undelegate: bool| {
        send(
            er,
            &[ix(
                if undelegate { 4 } else { 3 },
                &[],
                vec![
                    AccountMeta::new(me, true),
                    AccountMeta::new(b, false),
                    AccountMeta::new_readonly(magic_program(), false),
                    AccountMeta::new(magic_context(), false),
                ],
            )],
            &[&auth],
        )
    };
    // Builds on the copy `url` serves now, sends, returns (ms, write).
    let timed_write = |url: &str| -> Result<(u128, Write), String> {
        let wr = mk_write(&copy_at(url)?);
        let t0 = Instant::now();
        send(url, &[write_ix(&me, &wr)], &[&auth])?;
        Ok((t0.elapsed().as_millis(), wr))
    };

    match step.as_str() {
        "setup" => {
            rpc(
                base,
                "requestAirdrop",
                json!([me.to_string(), 100_000_000_000u64]),
            )?;
            wait("airdrop", 60, || {
                Ok(rpc(base, "getBalance", json!([me.to_string()]))?["value"]
                    .as_u64()
                    .unwrap_or(0)
                    > 0)
            })?;
            send(
                base,
                &[ix(
                    0,
                    &[],
                    vec![
                        AccountMeta::new(me, true),
                        AccountMeta::new(b, false),
                        AccountMeta::new_readonly(SYSTEM, false),
                    ],
                )],
                &[&auth],
            )?;
            let (ms, _) = timed_write(base)?;
            log(
                "setup",
                json!({"board": b.to_string(), "authority": me.to_string(), "validator": validator.to_string(), "base_write_ms": ms}),
            );
        }
        "roundtrip" => {
            let (_, s0) = header_of(base)?.ok_or("no board")?;
            delegate(base)?;
            let t = wait("ER sees the delegation", 60, || {
                Ok(
                    rpc(er, "getDelegationStatus", json!([b.to_string()]))?["isDelegated"]
                        == json!(true),
                )
            })?;
            log(
                "delegated",
                json!({"er_sees_delegation_ms": t, "obs": observe(base, er, &validator, key)?}),
            );
            // Base writes are refused while delegated.
            let refused =
                send(base, &[write_ix(&me, &mk_write(&copy_at(base)?))], &[&auth]).is_err();
            log("base_write_while_delegated_refused", json!(refused));
            let mut ms = vec![];
            let mut last = None;
            for _ in 0..5 {
                let (t, wr) = timed_write(er)?;
                ms.push(t);
                last = Some(wr);
            }
            log(
                "er_writes",
                json!({"ms": ms, "obs": observe(base, er, &validator, key)?}),
            );
            // The last request again, same blockhash window (signature
            // dedupe), then under a fresh blockhash (the board's CAS).
            let last = last.ok_or("no write")?;
            let dup = send(er, &[write_ix(&me, &last)], &[&auth]);
            std::thread::sleep(Duration::from_millis(1_500));
            let dup2 = send(er, &[write_ix(&me, &last)], &[&auth]);
            log(
                "er_duplicate",
                json!({"same_window": dup.err(), "fresh_blockhash": dup2.err()}),
            );
            commit(er, false)?;
            let t = wait("commit on base", 120, || {
                Ok(header_of(base)?.is_some_and(|(_, s)| s == s0 + 5))
            })?;
            log(
                "committed",
                json!({"ms_to_base": t, "obs": observe(base, er, &validator, key)?}),
            );
            ms.clear();
            for _ in 5..8 {
                ms.push(timed_write(er)?.0);
            }
            commit(er, true)?;
            let late = send(er, &[write_ix(&me, &mk_write(&copy_at(er)?))], &[&auth]);
            log("er_write_after_undelegate_scheduled", json!(late.err()));
            let t = wait("undelegation", 180, || {
                Ok(header_of(base)?.is_some_and(|(o, s)| o == erb() && s == s0 + 8))
            })?;
            log(
                "home",
                json!({"ms_to_base": t, "obs": observe(base, er, &validator, key)?}),
            );
            let (ms_base, _) = timed_write(base)?;
            log(
                "base_resumes",
                json!({"base_write_ms": ms_base, "obs": observe(base, er, &validator, key)?}),
            );
        }
        "open" | "er-writes" => {
            if step == "open" {
                delegate(base)?;
                // The ER learns of a delegation by its own subscription: a
                // write sent before that is refused ("cannot be written").
                let t = wait("ER sees the delegation", 60, || {
                    Ok(
                        rpc(er, "getDelegationStatus", json!([b.to_string()]))?["isDelegated"]
                            == json!(true),
                    )
                })?;
                log("er_sees_delegation_ms", json!(t));
            }
            let mut last = None;
            for _ in 0..3 {
                last = Some(timed_write(er)?.1);
            }
            std::thread::sleep(Duration::from_millis(1_500));
            let dup = send(er, &[write_ix(&me, &last.ok_or("no write")?)], &[&auth]);
            log("er_duplicate_fresh_blockhash", json!(dup.err()));
            // A writer that builds on the base's committed copy while the
            // live one is on the ER: refused, not merged.
            let stale = send(er, &[write_ix(&me, &mk_write(&copy_at(base)?))], &[&auth]);
            log("er_write_built_on_base_copy", json!(stale.err()));
            log("open", observe(base, er, &validator, key)?);
        }
        "close" => {
            let (_, s_er) = header_of(er)?.ok_or("no ER copy")?;
            commit(er, true)?;
            let t = wait("undelegation", 180, || {
                Ok(header_of(base)?.is_some_and(|(o, s)| o == erb() && s == s_er))
            })?;
            log(
                "close",
                json!({"ms_to_base": t, "seq": s_er, "obs": observe(base, er, &validator, key)?}),
            );
        }
        "status" => log("status", observe(base, er, &validator, key)?),
        "base-write" => {
            log(
                "base_write",
                json!(send(base, &[write_ix(&me, &mk_write(&copy_at(base)?))], &[&auth]).err()),
            );
        }
        _ => return Err(format!("unknown step {step}")),
    }
    Ok(())
}
