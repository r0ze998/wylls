//! B5 (owner-approved, read-only): our client code against the REAL public
//! devnet RPC. Ignored, and it also returns at once unless
//! `WYLLS_B5_DEVNET_READONLY=1`: CI never touches a network.
//!
//! ```text
//! WYLLS_B5_DEVNET_READONLY=1 WYLLS_B5_OUT=/tmp/b5 \
//!   cargo test -p stack --test devnet_readonly_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Read methods only (each call goes through [`Probe::call`], which refuses
//! anything else); no key, no signature, no send. One shared pacer at 250 ms
//! (4 req/s) with the https client's 429 retries; a hard cap of
//! [`MAX_CALLS`] requests per test. Every answer's latency and error shape is
//! written to `$WYLLS_B5_OUT/<test>.json`.
//!
//!   L1 fclient https: getVersion, getGenesisHash (devnet, and the operator's
//!      genesis gate classifies it), accounts, the read-only allow-listed
//!      transport, a bounded `before` pagination of a busy program and a
//!      fixed window read two ways, getTransaction of legacy / v0 / v1
//!      transactions, getBlock (recent, old, below the first available)
//!   L2 the keeper's `feed = "rpc"` ClusterPort on a program that is not
//!      ours: clock, the Season account (absent), the whole feed, then at
//!      the head; no send is ever made

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fclient::ports::{ChainPort, Cursor};
use fclient::rpc::{Pacer, RpcClient};
use fclient::Address;
use serde_json::{json, Value};

const MAX_CALLS: u64 = 400;
const READS: &[&str] = &[
    "getVersion",
    "getGenesisHash",
    "getSlot",
    "getAccountInfo",
    "getMultipleAccounts",
    "getSignaturesForAddress",
    "getTransaction",
    "getBlock",
    "getFirstAvailableBlock",
    "minimumLedgerSlot",
];

/// A busy public devnet program (about 1,000 transactions per 600 slots on
/// 2026-11-21) and a dormant one with a whole history of 33.
const BUSY: &str = "TroLg8TEhJbB633xDmaePigrjD34BYWyk49NpNoct8G";
const DORMANT: &str = "SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE";
/// A version-1 transaction (slot 523,600,000).
const V1_SIG: &str =
    "4t9MfiyECe35pAzgAupvqBYJ9dYXciYyUKNU9heES1AxFPNhSfXGrt2w75nxpL2ggJqS9ihSK6RcSq6NBkDkYb2x";

fn enabled() -> bool {
    std::env::var("WYLLS_B5_DEVNET_READONLY").is_ok_and(|v| v == "1")
}

fn url() -> String {
    std::env::var("WYLLS_B5_RPC").unwrap_or_else(|_| "https://api.devnet.solana.com".into())
}

struct Probe {
    rpc: RpcClient,
    pacer: Arc<Pacer>,
    log: Vec<Value>,
}

impl Probe {
    fn new(url: &str) -> Probe {
        let pacer = Pacer::new(Duration::from_millis(250), Duration::from_secs(30));
        Probe {
            rpc: RpcClient::new(url).with_pacer(pacer.clone()),
            pacer,
            log: vec![],
        }
    }

    fn calls(&self) -> u64 {
        self.pacer.calls.load(Ordering::Relaxed)
    }

    async fn call(&mut self, what: &str, method: &str, params: Value) -> Result<Value, String> {
        assert!(READS.contains(&method), "{method} is not a read");
        assert!(self.calls() < MAX_CALLS, "request cap {MAX_CALLS} reached");
        let (c0, t0) = (self.pacer.calls.load(Ordering::Relaxed), Instant::now());
        let thr0 = self.pacer.throttles.load(Ordering::Relaxed);
        let r = self.rpc.call(method, params).await;
        let entry = json!({
            "what": what, "method": method, "ms": t0.elapsed().as_millis() as u64,
            "requests": self.calls() - c0,
            "throttled": self.pacer.throttles.load(Ordering::Relaxed) - thr0,
            "error": r.as_ref().err().map(|e| format!("{e:?}")),
        });
        eprintln!("{entry}");
        self.log.push(entry);
        r.map_err(|e| format!("{e:?}"))
    }

    fn save(&self, name: &str, facts: Value) {
        let Ok(dir) = std::env::var("WYLLS_B5_OUT") else {
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        let v = json!({"url": fclient::https::redact(&self.rpc.url), "requests": self.calls(),
            "throttled": self.pacer.throttles.load(Ordering::Relaxed), "facts": facts, "calls": self.log});
        std::fs::write(
            format!("{dir}/{name}.json"),
            serde_json::to_string_pretty(&v).unwrap(),
        )
        .unwrap();
    }
}

fn sigs(v: &Value) -> Vec<(String, u64)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["signature"].as_str().unwrap().to_string(),
                r["slot"].as_u64().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
#[ignore = "B5: reads the public devnet RPC; needs WYLLS_B5_DEVNET_READONLY=1"]
async fn l1_fclient_https_reads_against_devnet() {
    if !enabled() {
        return;
    }
    let mut p = Probe::new(&url());
    let mut facts = json!({});

    // Version and cluster: the operator's genesis gate on the real answer.
    let v = p.call("version", "getVersion", json!([])).await.unwrap();
    facts["version"] = v.clone();
    let g = p
        .call("genesis", "getGenesisHash", json!([]))
        .await
        .unwrap();
    let g = g.as_str().unwrap().to_string();
    assert_eq!(g, stack_operator::DEVNET_GENESIS, "not devnet");
    use stack_operator::{check_genesis, Endpoint};
    assert!(check_genesis(&g, Endpoint::Public).is_ok());
    assert!(check_genesis(&g, Endpoint::Loopback).is_ok());
    assert!(check_genesis(stack_operator::MAINNET_GENESIS, Endpoint::Public).is_err());
    facts["genesis"] = json!(g);

    // Accounts through the ChainPort (Clock), getMultipleAccounts and the
    // separate allow-listed read-only transport.
    let mut port = fclient::rpc::RpcPort::new(url(), Address::default());
    port.rpc = RpcClient::new(url()).with_pacer(p.pacer.clone());
    let clock = port.clock().await.expect("Clock sysvar");
    facts["clock"] = json!({"slot": clock.slot, "unix": clock.unix_timestamp});
    let keys: Vec<Address> = [
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        DORMANT,
        "Bxw1vD5vrBnS7PynLjKY2iWV4R3aE1g2ZbtkrSj3WhJn",
    ]
    .iter()
    .map(|k| k.parse().unwrap())
    .collect();
    let got = port.rpc.get_finalized_multiple_accounts(&keys, 0).await;
    let got = got.expect("getMultipleAccounts");
    facts["accounts"] = json!(got
        .iter()
        .map(|a| a.as_ref().map(|a| json!({"owner": a.owner.to_string(), "executable": a.executable, "len": a.data.len()})))
        .collect::<Vec<_>>());
    assert!(got[0].as_ref().is_some_and(|a| a.executable));
    assert!(got[3].is_none(), "an unused address reads as absent");
    let t0 = Instant::now();
    let ro = fclient::readonly_https_rpc::call(&url(), "getSlot", json!([]), 4096).await;
    facts["readonly_transport_getSlot"] = json!({"ok": ro.is_ok(), "ms": t0.elapsed().as_millis() as u64, "err": ro.as_ref().err().map(|e| format!("{e:?}"))});
    assert!(ro.is_ok(), "{ro:?}");
    assert!(fclient::readonly_https_rpc::request_bytes("sendTransaction", json!([])).is_err());
    assert!(fclient::readonly_https_rpc::request_bytes("requestAirdrop", json!([])).is_err());
    assert!(
        fclient::readonly_https_rpc::request_bytes("getSignaturesForAddress", json!([])).is_err(),
        "the read-only transport's allow-list is narrower than the RPC client's"
    );

    // Bounded pagination of a busy program: 6 pages of 1,000 with `before`.
    let mut all: Vec<(String, u64)> = vec![];
    let mut before: Option<String> = None;
    let mut pages = vec![];
    for i in 0..6 {
        let mut cfg = json!({"limit": 1000, "commitment": "finalized"});
        if let Some(b) = &before {
            cfg["before"] = json!(b);
        }
        let page = p
            .call(
                &format!("page {i}"),
                "getSignaturesForAddress",
                json!([BUSY, cfg]),
            )
            .await
            .unwrap();
        let page = sigs(&page);
        pages.push(page.len());
        before = page.last().map(|s| s.0.clone());
        all.extend(page);
    }
    let unique: std::collections::BTreeSet<_> = all.iter().map(|s| &s.0).collect();
    assert_eq!(unique.len(), all.len(), "a signature twice across pages");
    assert!(all.windows(2).all(|w| w[0].1 >= w[1].1), "slots go up");
    facts["busy_pages"] = json!({"sizes": pages, "first_slot": all.first().map(|s| s.1), "last_slot": all.last().map(|s| s.1)});
    // A fixed window (before = the 1,500th, until = the 4,500th) read with
    // pages of 1,000 and of 250 gives the same list (finalized: it cannot
    // change).
    let (b, u) = (all[1499].0.clone(), all[4499].0.clone());
    let want: Vec<_> = all[1500..4499].iter().map(|s| s.0.clone()).collect();
    for limit in [1000u64, 250] {
        let mut got: Vec<String> = vec![];
        let mut before = b.clone();
        loop {
            let page = p
                .call(
                    &format!("window limit {limit}"),
                    "getSignaturesForAddress",
                    json!([BUSY, {"limit": limit, "commitment": "finalized", "before": before, "until": u}]),
                )
                .await
                .unwrap();
            let page = sigs(&page);
            let n = page.len() as u64;
            if let Some(l) = page.last() {
                before = l.0.clone();
            }
            got.extend(page.into_iter().map(|s| s.0));
            if n < limit {
                break;
            }
        }
        assert_eq!(got, want, "window with limit {limit}");
    }
    facts["window"] = json!({"len": want.len(), "agree_1000_250": true});

    // getTransaction: legacy, v0 and v1 through fclient (version 1 asked).
    let mut by_version = serde_json::Map::new();
    let probe_sigs: Vec<String> = all
        .iter()
        .step_by(997)
        .take(6)
        .map(|s| s.0.clone())
        .collect();
    for s in probe_sigs.iter().map(String::as_str).chain([V1_SIG]) {
        let sig: fclient::ports::Signature = s.parse().unwrap();
        let raw = p
            .call(
                "tx (raw, version 1)",
                "getTransaction",
                json!([s, {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]),
            )
            .await
            .unwrap();
        let version = raw["version"].to_string();
        let rec = fclient::rpc::parse_transaction(&sig, &raw).expect("parses");
        let legacy = fclient::tx::from_wire(&rec.tx).is_ok();
        by_version.entry(version.clone()).or_insert_with(
            || json!({"legacy_decodes": legacy, "first_byte": rec.tx.first().copied()}),
        );
    }
    // The same v1 transaction with version 0 asked: the error shape.
    let e = p
        .call(
            "v1 with version 0",
            "getTransaction",
            json!([V1_SIG, {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 0}]),
        )
        .await
        .unwrap_err();
    assert!(e.contains("-32015"), "{e}");
    let via_client = port
        .rpc
        .get_finalized_transaction(&V1_SIG.parse().unwrap())
        .await
        .expect("fclient reads a v1 transaction");
    assert!(via_client.is_some());
    facts["tx_versions"] = Value::Object(by_version);
    facts["v1_with_version_0"] = json!(e);
    let missing = p
        .call(
            "an unknown signature",
            "getTransaction",
            json!([fclient::ports::Signature::from([7u8; 64]).to_string(), {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]),
        )
        .await
        .unwrap();
    assert!(missing.is_null());

    // getBlock (signatures): recent, old (long-term storage), below the
    // first available, and the error shapes.
    let first = p
        .call("first available", "getFirstAvailableBlock", json!([]))
        .await
        .unwrap();
    let min_ledger = p
        .call("minimum ledger slot", "minimumLedgerSlot", json!([]))
        .await
        .unwrap();
    facts["first_available_block"] = first.clone();
    facts["minimum_ledger_slot"] = min_ledger;
    let recent = all[10].1;
    let mut blocks = serde_json::Map::new();
    for (what, slot) in [
        ("recent", recent),
        ("old", 273_210_398u64),
        (
            "below first available",
            first.as_u64().unwrap().saturating_sub(1_000),
        ),
    ] {
        let r = p
            .call(
                &format!("block {what}"),
                "getBlock",
                json!([slot, {"encoding": "json", "transactionDetails": "signatures", "rewards": false,
                    "commitment": "finalized", "maxSupportedTransactionVersion": 1}]),
            )
            .await;
        blocks.insert(
            what.into(),
            match r {
                Ok(v) => json!({"slot": slot, "signatures": v["signatures"].as_array().map(|a| a.len()), "parentSlot": v["parentSlot"]}),
                Err(e) => json!({"slot": slot, "error": e}),
            },
        );
    }
    facts["blocks"] = Value::Object(blocks);
    eprintln!(
        "L1: {} requests, {} answered 429/503",
        p.calls(),
        p.pacer.throttles.load(Ordering::Relaxed)
    );
    p.save("l1-fclient", facts);
}

#[tokio::test]
#[ignore = "B5: reads the public devnet RPC; needs WYLLS_B5_DEVNET_READONLY=1"]
async fn l2_keeper_cluster_feed_on_a_foreign_program_never_sends() {
    if !enabled() {
        return;
    }
    let toml = format!(
        "program = \"{DORMANT}\"\nseason = 1\nrpc = [\"{}\"]\ndrand = [\"http://127.0.0.1:41459\"]\nbeneficiary = \"{DORMANT}\"\nfeed = \"rpc\"\nfeed_poll_ms = 2000\n",
        url()
    );
    let cfg = keeper_core::config::KeeperConfig::from_toml(&toml).expect("keeper.toml");
    cfg.check_feed().expect("feed = rpc over https is accepted");
    let pacer = keeper_core::clusterfeed::pacer(&cfg);
    let pacer_ref = pacer.clone().expect("feed = rpc is paced");
    let port = keeper_core::clusterfeed::ClusterPort::from_config(&cfg, &url(), &pacer).unwrap();
    let mut facts = json!({"rpc_min_gap_ms": cfg.rpc_min_gap().as_millis() as u64});
    let t0 = Instant::now();
    let clock = port.clock().await.expect("clock");
    let a = fclient::addr::Addresses::new(cfg.program, cfg.season_id);
    let season = port
        .accounts(&[a.season], clock.slot)
        .await
        .expect("accounts");
    assert!(season[0].is_none(), "this program has no WYLLS season");
    facts["season_account"] = json!(null);
    // The whole feed of the program, numbered 1..N, then the head.
    let mut cur = 0u64;
    let mut pulls = 0;
    let head = loop {
        pulls += 1;
        assert!(pulls < 20, "the feed did not reach its head");
        match port.feed(Cursor(cur)).await {
            Ok(page) if page.is_empty() => break Ok(cur),
            Ok(page) => {
                for (i, r) in page.iter().enumerate() {
                    assert_eq!(r.seq, cur + 1 + i as u64);
                }
                cur = page.last().unwrap().seq;
            }
            Err(e) => break Err(format!("{e:?}")),
        }
    };
    let records = cur;
    let decodable = {
        let polled = port.feed.as_ref().unwrap().lock().await;
        polled.len()
    };
    facts["feed"] = json!({"records": records, "head": head, "polled_log": decodable,
        "ms": t0.elapsed().as_millis() as u64});
    // At the head within feed_poll_ms: an empty page (or Unavailable), and
    // no RPC call.
    let c0 = pacer_ref.calls.load(Ordering::Relaxed);
    let again = port.feed(Cursor(cur)).await;
    facts["at_head"] = json!({"result": format!("{again:?}"),
        "requests": pacer_ref.calls.load(Ordering::Relaxed) - c0});
    let total = pacer_ref.calls.load(Ordering::Relaxed);
    facts["requests"] = json!(total);
    facts["throttled"] = json!(pacer_ref.throttles.load(Ordering::Relaxed));
    assert!(total < MAX_CALLS);
    eprintln!("L2: {facts}");
    if let Ok(dir) = std::env::var("WYLLS_B5_OUT") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            format!("{dir}/l2-keeper-feed.json"),
            serde_json::to_string_pretty(&facts).unwrap(),
        )
        .unwrap();
    }
}

/// The operator's genesis gate (`frontier_stack::operator`).
mod stack_operator {
    pub use frontier_stack::operator::{check_genesis, Endpoint, DEVNET_GENESIS, MAINNET_GENESIS};
}
