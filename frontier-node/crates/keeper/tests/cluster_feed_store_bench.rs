//! keeper-feed-persist: restart cost of the `feed = "rpc"` keeper feed,
//! before (no store: the whole history again) vs after (a feed store: the
//! new tail only), against the local chain node's JSON-RPC
//! (`frontier-localnet`'s server, in process, on 127.0.0.1:41856) with a
//! few hundred transactions of one address standing in for the program
//! (the feed's cost is one `getTransaction` per transaction whatever it
//! holds). `#[ignore]`: a measurement, run by hand:
//!
//! ```text
//! KFP_TXS=400 KFP_GAP_MS=150 cargo test -p keeper --test cluster_feed_store_bench -- --ignored --nocapture
//! ```
//!
//! `KFP_GAP_MS` is the keeper's pacer gap (`rpc_min_gap_ms`; 150 is the
//! `feed = "rpc"` default). Also times loading a synthetic store of
//! `KFP_SYNTH` records of a devnet-like size (0 = skip).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use fclient::ports::{ChainPort, Cursor, TxRecord};
use fclient::rpc::{Pacer, RpcClient, RpcPort};
use fclient::{tx, Address, Keypair, Signer};
use findex::RpcPoll;
use keeper_core::clusterfeed::{ClusterPort, FeedPacing, StoreOpened};
use localnet::{server, Config, InProcess};

fn env(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kfp-bench-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn port(url: &str, program: Address, gap: Duration) -> ClusterPort {
    let mut rpc = RpcPort::new(url, program);
    let mut poll = RpcPoll::new(url, program);
    if !gap.is_zero() {
        let p = Pacer::new(gap, Duration::from_secs(5));
        rpc.rpc = RpcClient::new(url).with_pacer(p.clone());
        poll.rpc = RpcClient::new(url).with_pacer(p);
    }
    ClusterPort::polled(
        rpc,
        poll,
        FeedPacing {
            poll: Duration::from_millis(200),
            max_backoff: Duration::from_secs(5),
        },
    )
}

async fn read_all(p: &ClusterPort) -> Vec<TxRecord> {
    let mut out: Vec<TxRecord> = vec![];
    loop {
        let page = p.feed(Cursor(out.len() as u64)).await.unwrap();
        if page.is_empty() {
            return out;
        }
        out.extend(page);
    }
}

fn dir_bytes(d: &std::path::Path) -> u64 {
    std::fs::read_dir(d)
        .map(|r| {
            r.filter_map(|e| e.ok()?.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

async fn transfers(ip: &InProcess, payer: &Keypair, to: Address, n: u64) {
    let budget = tx::TxBudget {
        cu_limit: 10_000,
        cu_price: 0,
        loaded_limit: 1_048_576,
        heap: None,
    };
    for i in 0..n {
        let (bh, _) = ip.blockhash().await.unwrap();
        let t = tx::build(
            &[tx::transfer(payer.pubkey(), to, 1_000_000 + i)],
            &budget,
            &[payer],
            &bh,
        )
        .unwrap();
        ip.send(&tx::wire(&t)).await.unwrap();
        ip.step(1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "a measurement (keeper-feed-persist report): run by hand"]
async fn restart_time_before_vs_after() {
    let n = env("KFP_TXS", 400);
    let tail = env("KFP_TAIL", 5);
    let gap = Duration::from_millis(env("KFP_GAP_MS", 150));
    let ip = InProcess::new(Config::default(), None);
    let payer = Keypair::new_from_array([61; 32]);
    let program = Address::new_from_array([62; 32]);
    ip.lock().airdrop(&payer.pubkey(), 900_000_000_000).unwrap();
    transfers(&ip, &payer, program, n).await;
    let node = server::start(ip.chain.clone(), 41856).await.unwrap();
    let url = node.url();
    let root = scratch("run");
    let dir = root.join("keeper.journal.sqlite.feed");

    // First start (= today's every start): the whole history.
    let t = Instant::now();
    let mut p = port(&url, program, gap);
    assert_eq!(p.persist_feed(&dir, program).unwrap(), StoreOpened::Empty);
    let first = read_all(&p).await;
    let full = t.elapsed();
    assert_eq!(first.len() as u64, n);
    drop(p);
    // BEFORE: a restart without a store reads it all again.
    transfers(&ip, &payer, program, tail).await;
    let t = Instant::now();
    let p = port(&url, program, gap);
    let before_recs = read_all(&p).await;
    let before = t.elapsed();
    drop(p);
    // AFTER: a restart with the store reads only the tail.
    let t = Instant::now();
    let mut p = port(&url, program, gap);
    let o = p.persist_feed(&dir, program).unwrap();
    let opened = t.elapsed();
    let after_recs = read_all(&p).await;
    let after = t.elapsed();
    assert_eq!(o, StoreOpened::Restored(n as usize));
    assert_eq!(after_recs, before_recs, "the same log either way");
    println!(
        "KFP local node: {n} txs (+{tail} tail), pacer gap {} ms\n  first start (full read):        {:>9.3} s\n  BEFORE restart (no store):      {:>9.3} s  ({} records)\n  AFTER restart (store): open {:.3} s, total {:>9.3} s  ({} records)\n  store size {} B ({:.0} B/record)",
        gap.as_millis(),
        full.as_secs_f64(),
        before.as_secs_f64(),
        before_recs.len(),
        opened.as_secs_f64(),
        after.as_secs_f64(),
        after_recs.len(),
        dir_bytes(&dir),
        dir_bytes(&dir) as f64 / after_recs.len() as f64
    );
    drop(p);
    let _ = std::fs::remove_dir_all(&root);

    // Load time of a large store (synthetic devnet-like records: ~1 KB
    // wire, 25 log lines).
    let synth = env("KFP_SYNTH", 0);
    if synth > 0 {
        let sd = scratch("synth");
        let mut a = findex::Archive::open(&sd, findex::archive::SEGMENT_BYTES).unwrap();
        let logs: Vec<String> = (0..25)
            .map(|i| format!("Program log: PSW1 frontier event line {i:02} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
            .collect();
        let mut last = None;
        for chunk in 0..synth.div_ceil(1000) {
            let recs: Vec<TxRecord> = (0..1000u64.min(synth - chunk * 1000))
                .map(|i| {
                    let k = chunk * 1000 + i;
                    let mut s = [0u8; 64];
                    s[..8].copy_from_slice(&k.to_le_bytes());
                    TxRecord {
                        slot: 1_000 + k,
                        signature: fclient::ports::Signature::from(s),
                        block_time: 1_700_000_000 + k as i64,
                        tx: vec![(k % 251) as u8; 1_000],
                        logs: logs.clone(),
                        units: 120_000,
                        fee: 5_000,
                        ..Default::default()
                    }
                })
                .collect();
            last = recs.last().map(|r| (r.signature, r.slot));
            let (ls, lslot) = last.unwrap();
            let cursor = serde_json::json!({"keeper_feed": 1, "program": program.to_string(), "poll": {
                "rpc_last": ls.to_string(), "rpc_last_slot": lslot, "rpc_last_slot_sigs": [ls.to_string()],
                "rpc_coverage": {"first_slot": 1000, "unverifiable": []}}});
            a.append(&recs, cursor).unwrap();
        }
        let _ = last;
        drop(a);
        let t = Instant::now();
        let (p, o) = keeper_core::clusterfeed::Polled::new(
            RpcPoll::new("http://127.0.0.1:1", program),
            FeedPacing {
                poll: Duration::from_millis(200),
                max_backoff: Duration::from_secs(5),
            },
        )
        .with_store(&sd, program)
        .unwrap();
        let load = t.elapsed();
        assert_eq!(o, StoreOpened::Restored(synth as usize));
        println!(
            "KFP synthetic store: {synth} records, {} B on disk, restored in {:.3} s",
            dir_bytes(&sd),
            load.as_secs_f64()
        );
        drop(p);
        let _ = std::fs::remove_dir_all(&sd);
    }
}
