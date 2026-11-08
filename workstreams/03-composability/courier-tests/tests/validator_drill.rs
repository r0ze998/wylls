//! Workstream 03 validator drill: SIMD-0186 loaded-data accounting of a
//! **CPI** on the installed `solana-test-validator 3.1.9`.
//!
//! **Execution:** `[LOCAL VALIDATOR: solana-test-validator 3.1.9]`, run by
//! `../drill/cpi-loaded-drill.sh` (ignored otherwise). The Frontier program
//! itself cannot be deployed there (3.1.9 has no BLS12-381 syscalls, the
//! core's own drill note), so a padded probe of the Frontier `.so`'s size
//! stands in for it; the courier is the hostile test build (its op 3
//! invokes `a[0]` with the rest of the accounts).
//!
//! The question: when the courier calls a big program by CPI, does the
//! big program's ProgramData count toward the transaction's loaded-data
//! limit, as it does for a top-level call? The LiteSVM harness
//! (`Chain::loaded_size`) counts ProgramData only for top-level programs.
//! Each composition's smallest passing limit is searched, the probe's
//! no-op at top level being the control. The RPC client is the core
//! drill's (`permutation-frontier/svm-tests/tests/drill.rs`).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

struct Rpc {
    host: String,
    id: u64,
}

impl Rpc {
    fn new(url: &str) -> Rpc {
        let host = url
            .strip_prefix("http://")
            .expect("http:// URL")
            .trim_end_matches('/')
            .to_string();
        Rpc { host, id: 0 }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let body = json!({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params})
            .to_string();
        let mut s = TcpStream::connect(&self.host).expect("connect to the drill validator");
        s.set_read_timeout(Some(Duration::from_secs(30))).ok();
        write!(
            s,
            "POST / HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.host,
            body.len(),
            body
        )
        .expect("write");
        let mut buf = vec![];
        s.read_to_end(&mut buf).expect("read");
        let text = String::from_utf8_lossy(&buf);
        let (head, rest) = text.split_once("\r\n\r\n").expect("http response");
        let body = if head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            let mut out = String::new();
            let mut r = rest;
            loop {
                let (len, tail) = r.split_once("\r\n").expect("chunk");
                let n = usize::from_str_radix(len.trim(), 16).expect("chunk len");
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
        let v: Value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{e}: {body}"));
        if let Some(e) = v.get("error") {
            panic!("{method}: {e}");
        }
        v["result"].clone()
    }

    fn blockhash(&mut self) -> Hash {
        let r = self.call("getLatestBlockhash", json!([{"commitment": "processed"}]));
        r["value"]["blockhash"]
            .as_str()
            .expect("hash")
            .parse()
            .expect("base58")
    }

    /// Data length of an account (None if absent).
    fn data_len(&mut self, k: &Address) -> Option<usize> {
        let r = self.call(
            "getAccountInfo",
            json!([k.to_string(), {"encoding": "base64", "commitment": "confirmed"}]),
        );
        let v = &r["value"];
        if v.is_null() {
            return None;
        }
        let d = v["data"][0].as_str().expect("base64");
        Some(
            base64::engine::general_purpose::STANDARD
                .decode(d)
                .expect("b64")
                .len(),
        )
    }

    /// Sends without preflight and waits for confirmation: the error (None on success) and the fee.
    fn send(&mut self, t: &Transaction) -> (Option<Value>, u64) {
        let wire = bincode::serialize(t).expect("wire");
        let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
        let sig = self.call(
            "sendTransaction",
            json!([b64, {"encoding": "base64", "skipPreflight": true, "maxRetries": 5}]),
        );
        let sig = sig.as_str().expect("signature").to_string();
        let start = Instant::now();
        loop {
            let st = self.call(
                "getSignatureStatuses",
                json!([[sig], {"searchTransactionHistory": true}]),
            );
            let s = &st["value"][0];
            if !s.is_null()
                && s["confirmationStatus"]
                    .as_str()
                    .is_some_and(|c| c != "processed")
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "{sig} not confirmed"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
        let tx = self.call(
            "getTransaction",
            json!([sig, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}]),
        );
        let meta = &tx["meta"];
        let err = if meta["err"].is_null() {
            None
        } else {
            Some(meta["err"].clone())
        };
        (err, meta["fee"].as_u64().unwrap_or(0))
    }
}

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} unset: run drill/cpi-loaded-drill.sh"))
}

fn read_keypair(path: &str) -> Keypair {
    let v: Vec<u8> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("keypair file")).expect("json");
    Keypair::try_from(v.as_slice()).expect("64-byte keypair")
}

fn tx(ix: Instruction, limit: u32, payer: &Keypair, bh: Hash) -> Transaction {
    let lim = fclient::tx::set_loaded_accounts_data_size_limit(limit);
    let msg = Message::new_with_blockhash(&[lim, ix], Some(&payer.pubkey()), &bh);
    let mut t = Transaction::new_unsigned(msg);
    t.sign(&[payer], bh);
    t
}

fn is_loaded_exceeded(e: &Option<Value>) -> bool {
    e.as_ref()
        .is_some_and(|v| v.to_string().contains("MaxLoadedAccountsDataSizeExceeded"))
}

/// The smallest limit under which `make` loads (whatever it does then),
/// by bisection on [1 KiB, 64 MiB]; also the outcome at that limit.
fn min_limit(
    rpc: &mut Rpc,
    payer: &Keypair,
    make: &dyn Fn() -> Instruction,
) -> (u32, Option<Value>) {
    let run = |rpc: &mut Rpc, l: u32| {
        let bh = rpc.blockhash();
        rpc.send(&tx(make(), l, payer, bh)).0
    };
    let (mut lo, mut hi) = (1_024u32, 64 * 1_024 * 1_024u32);
    assert!(is_loaded_exceeded(&run(rpc, lo)), "fails at {lo}");
    assert!(!is_loaded_exceeded(&run(rpc, hi)), "loads at {hi}");
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if is_loaded_exceeded(&run(rpc, mid)) {
            lo = mid
        } else {
            hi = mid
        }
    }
    let out = run(rpc, hi);
    (hi, out)
}

#[test]
#[ignore = "needs the drill validator: drill/cpi-loaded-drill.sh"]
fn drill_cpi_target_programdata_counts() {
    let mut rpc = Rpc::new(&env("COURIER_DRILL_RPC"));
    let big: Address = env("COURIER_DRILL_BIG").parse().expect("base58");
    let courier: Address = env("COURIER_DRILL_COURIER").parse().expect("base58");
    let payer = read_keypair(&env("COURIER_DRILL_KEYPAIR"));
    let big_pd = fclient::addr::programdata(&big);
    let courier_pd = fclient::addr::programdata(&courier);
    let big_pd_len = rpc.data_len(&big_pd).expect("big ProgramData") as u32;
    let courier_pd_len = rpc.data_len(&courier_pd).expect("courier ProgramData") as u32;
    println!("drill: big ProgramData {big_pd_len} B, courier ProgramData {courier_pd_len} B");
    let pk = payer.pubkey();
    // (a) control: the big program's no-op at top level.
    let (a, ea) = min_limit(&mut rpc, &payer, &|| Instruction {
        program_id: big,
        accounts: vec![],
        data: vec![2, 0, 0],
    });
    println!("drill: (a) top-level big no-op: min limit {a} B, outcome {ea:?}");
    assert!(ea.is_none(), "the control lands");
    // (b) the courier calls the big program's no-op by CPI.
    let (b, eb) = min_limit(&mut rpc, &payer, &|| Instruction {
        program_id: courier,
        accounts: vec![
            AccountMeta::new_readonly(big, false),
            AccountMeta::new(pk, true),
        ],
        data: vec![0xEE, 1, 3, 2, 0, 0],
    });
    println!("drill: (b) courier -> CPI -> big no-op: min limit {b} B, outcome {eb:?}");
    assert!(eb.is_none(), "the CPI lands on the validator");
    // (c) the courier lists the big program but does not invoke it (it
    // refuses: not the Frontier id it was built for).
    let (c, ec) = min_limit(&mut rpc, &payer, &|| Instruction {
        program_id: courier,
        accounts: vec![AccountMeta::new_readonly(big, false)],
        data: vec![0, 1],
    });
    println!("drill: (c) courier listing big, no CPI: min limit {c} B, outcome {ec:?}");
    let counted = b > courier_pd_len + big_pd_len;
    println!(
        "drill: RESULT the CPI target's ProgramData {} counted (b = {b} vs courier ProgramData + big ProgramData = {})",
        if counted { "IS" } else { "is NOT" },
        courier_pd_len + big_pd_len
    );
    if let Ok(out) = std::env::var("COURIER_DRILL_OUT") {
        std::fs::write(out, format!(
            "{{\"big_programdata\":{big_pd_len},\"courier_programdata\":{courier_pd_len},\"a_top_level\":{a},\"b_courier_cpi\":{b},\"c_courier_listing\":{c},\"cpi_target_programdata_counted\":{counted}}}\n"
        )).unwrap();
    }
}
