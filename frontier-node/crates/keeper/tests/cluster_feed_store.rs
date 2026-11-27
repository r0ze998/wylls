//! keeper-feed-persist: the `feed = "rpc"` log persisted in a feed store
//! (`clusterfeed` module note) against a loopback mock of a public RPC:
//! ports 41850–41855 (this run's range).
//!
//!   S1 a restart with a stored feed reads only the new tail (getTransaction
//!      per NEW transaction only) and serves the SAME records, numbered the
//!      same, from cursor 0
//!   S2 nothing restored is served before the first poll after the restart
//!      succeeded (a 429 then: Unavailable, never the stored page)
//!   S3 a forged tip (a signature the node does not hold) is a detected gap:
//!      the store is moved aside and the whole history is read again, 1..N
//!   S4 a pruned tip (the node lost the stored last signature) likewise
//!   S5 a store that does not check (another program, a damaged segment) is
//!      moved aside at open: a full read
//!   S6 a store write that fails serves nothing and loses nothing: the batch
//!      is pulled again once the store is writable
//!   S7 `keeper.toml` `feed_store`: default beside the journal, a directory,
//!      "off", refused with feed = "localnet"

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use fclient::ports::{ChainPort, Cursor, PortError, Signature, TxRecord};
use fclient::rpc::RpcPort;
use findex::RpcPoll;
use keeper_core::clusterfeed::{ClusterPort, FeedPacing, StoreOpened};
use keeper_core::config::{FeedStoreConf, KeeperConfig};
use serde_json::{json, Value};
use solana_address::Address;

#[derive(Default)]
struct Chain {
    /// (signature, slot), oldest first.
    sigs: Vec<(String, u64)>,
    throttle: bool,
    calls: usize,
    /// `getTransaction` calls (the restart cost this store removes).
    gets: usize,
}

fn sig(i: u8) -> String {
    Signature::from([i; 64]).to_string()
}

fn answer(c: &mut Chain, q: &Value) -> (u16, Value) {
    c.calls += 1;
    if c.throttle {
        return (429, json!({}));
    }
    let id = q["id"].clone();
    let p = &q["params"];
    let result = match q["method"].as_str().unwrap() {
        "getSignaturesForAddress" => {
            let cfg = &p[1];
            let limit = cfg["limit"].as_u64().unwrap_or(1000) as usize;
            let newest_first: Vec<_> = c.sigs.iter().rev().collect();
            let start = match cfg["before"].as_str() {
                Some(b) => newest_first
                    .iter()
                    .position(|(s, _)| s == b)
                    .map_or(newest_first.len(), |i| i + 1),
                None => 0,
            };
            let mut out = vec![];
            for (s, slot) in &newest_first[start..] {
                if cfg["until"].as_str() == Some(s.as_str()) || out.len() == limit {
                    break;
                }
                out.push(json!({"signature": s, "slot": slot, "err": null, "blockTime": 1_700_000_000 + *slot as i64}));
            }
            json!(out)
        }
        "getTransaction" => {
            c.gets += 1;
            let s = p[0].as_str().unwrap();
            match c.sigs.iter().find(|(x, _)| x == s) {
                None => Value::Null,
                Some((_, slot)) => json!({
                    "slot": slot,
                    "blockTime": 1_700_000_000 + *slot as i64,
                    "transaction": [base64::engine::general_purpose::STANDARD.encode([*slot as u8; 8]), "base64"],
                    "meta": {"err": null, "logMessages": ["Program log: x"], "computeUnitsConsumed": 100, "fee": 5000},
                }),
            }
        }
        "frontier_feed" => {
            return (
                200,
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}),
            )
        }
        m => panic!("unexpected {m}"),
    };
    (200, json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn mock(port: u16) -> Arc<Mutex<Chain>> {
    let l = TcpListener::bind(("127.0.0.1", port))
        .unwrap_or_else(|e| panic!("127.0.0.1:{port} must be free: {e}"));
    let chain = Arc::new(Mutex::new(Chain::default()));
    let c2 = chain.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { break };
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            if r.read_line(&mut line).is_err() {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            let q: Value = serde_json::from_slice(&body).unwrap();
            let (status, v) = answer(&mut c2.lock().unwrap(), &q);
            let out = v.to_string();
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                )
                .as_bytes(),
            );
        }
    });
    chain
}

fn program() -> Address {
    Address::new_from_array([3; 32])
}

fn port(url: &str) -> ClusterPort {
    ClusterPort::polled(
        RpcPort::new(url, program()),
        RpcPoll::new(url, program()),
        FeedPacing {
            poll: Duration::from_millis(200),
            max_backoff: Duration::from_millis(800),
        },
    )
}

fn stored(url: &str, dir: &Path, prog: Address) -> (ClusterPort, StoreOpened) {
    let mut p = port(url);
    let o = p.persist_feed(dir, prog).unwrap();
    (p, o)
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("keeper-feed-persist-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn asides(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.to_string_lossy().contains(".discarded-"))
        .collect()
}

/// Every record from cursor 0 (pages of the feed, polling at the head).
async fn read_all(p: &ClusterPort) -> Result<Vec<TxRecord>, PortError> {
    let mut out: Vec<TxRecord> = vec![];
    loop {
        let page = p.feed(Cursor(out.len() as u64)).await?;
        if page.is_empty() {
            return Ok(out);
        }
        out.extend(page);
    }
}

fn push(chain: &Arc<Mutex<Chain>>, from: u8, to: u8) {
    let mut c = chain.lock().unwrap();
    for i in from..=to {
        c.sigs.push((sig(i), 100 + i as u64));
    }
}

#[tokio::test]
async fn s1_s2_restart_reads_only_the_new_tail_and_serves_nothing_unchecked() {
    let chain = mock(41850);
    push(&chain, 1, 40);
    let url = "http://127.0.0.1:41850";
    let root = scratch("s1");
    let dir = root.join("keeper.journal.sqlite.feed");
    let (p, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Empty);
    let first = read_all(&p).await.unwrap();
    assert_eq!(first.len(), 40);
    assert_eq!(chain.lock().unwrap().gets, 40);
    drop(p);
    // S1: a restart; 3 new transactions meanwhile.
    push(&chain, 41, 43);
    chain.lock().unwrap().gets = 0;
    let (p, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Restored(40));
    let again = read_all(&p).await.unwrap();
    assert_eq!(
        chain.lock().unwrap().gets,
        3,
        "one getTransaction per NEW transaction"
    );
    assert_eq!(again.len(), 43);
    assert_eq!(
        &again[..40],
        &first[..],
        "the same records, numbered the same"
    );
    assert_eq!(
        again.iter().map(|r| r.seq).collect::<Vec<_>>(),
        (1..=43).collect::<Vec<u64>>()
    );
    assert_eq!(again[42].signature.to_string(), sig(43));
    drop(p);
    // A restart with nothing new: no getTransaction at all.
    chain.lock().unwrap().gets = 0;
    let (p, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Restored(43));
    assert_eq!(read_all(&p).await.unwrap(), again);
    assert_eq!(chain.lock().unwrap().gets, 0);
    drop(p);
    // S2: the first poll after a restart fails: nothing restored is served.
    chain.lock().unwrap().throttle = true;
    let (p, _) = stored(url, &dir, program());
    let e = p.feed(Cursor(0)).await.unwrap_err();
    assert!(matches!(e, PortError::Http(429)), "{e:?}");
    let e = p.feed(Cursor(0)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("43 restored records wait")),
        "{e:?}"
    );
    assert!(p.feed.as_ref().unwrap().lock().await.unproven());
    chain.lock().unwrap().throttle = false;
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(read_all(&p).await.unwrap(), again);
    assert!(!p.feed.as_ref().unwrap().lock().await.unproven());
    assert!(asides(&root).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn s3_a_forged_tip_is_a_gap_and_falls_back_to_a_full_read() {
    let chain = mock(41851);
    push(&chain, 1, 10);
    let url = "http://127.0.0.1:41851";
    let root = scratch("s3");
    let dir = root.join("feed");
    let (p, _) = stored(url, &dir, program());
    assert_eq!(read_all(&p).await.unwrap().len(), 10);
    drop(p);
    // Forge: the node's history is another one (none of the stored
    // signatures), e.g. a store copied from another cluster.
    {
        let mut c = chain.lock().unwrap();
        c.sigs = (0..12u8).map(|i| (sig(200 + i), 500 + i as u64)).collect();
        c.gets = 0;
    }
    let (p, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Restored(10));
    let e = p.feed(Cursor(0)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("do not continue on the node") && m.contains("history gap")),
        "{e:?}"
    );
    assert_eq!(
        chain.lock().unwrap().gets,
        0,
        "nothing fetched for a gapped batch"
    );
    assert_eq!(asides(&root).len(), 1, "moved aside, not deleted");
    let all = read_all(&p).await.unwrap();
    assert_eq!(all.len(), 12);
    assert_eq!(all[0].signature.to_string(), sig(200));
    assert_eq!(
        all.iter().map(|r| r.seq).collect::<Vec<_>>(),
        (1..=12).collect::<Vec<u64>>()
    );
    drop(p);
    // The fresh store restores the new history.
    let (_, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Restored(12));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn s4_a_pruned_tip_is_a_gap() {
    let chain = mock(41852);
    push(&chain, 1, 8);
    let url = "http://127.0.0.1:41852";
    let root = scratch("s4");
    let dir = root.join("feed");
    let (p, _) = stored(url, &dir, program());
    assert_eq!(read_all(&p).await.unwrap().len(), 8);
    drop(p);
    // The node no longer holds the stored last signature (8); 9 is new.
    {
        let mut c = chain.lock().unwrap();
        c.sigs.retain(|(s, _)| *s != sig(8));
        c.sigs.push((sig(9), 109));
    }
    let (p, _) = stored(url, &dir, program());
    let e = p.feed(Cursor(0)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("history gap")),
        "{e:?}"
    );
    let all = read_all(&p).await.unwrap();
    assert_eq!(
        all.iter()
            .map(|r| r.signature.to_string())
            .collect::<Vec<_>>(),
        (1..=7u8).chain([9]).map(sig).collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn s5_a_store_that_does_not_check_is_moved_aside_at_open() {
    let chain = mock(41853);
    push(&chain, 1, 6);
    let url = "http://127.0.0.1:41853";
    let root = scratch("s5");
    let dir = root.join("feed");
    let (p, _) = stored(url, &dir, program());
    assert_eq!(read_all(&p).await.unwrap().len(), 6);
    drop(p);
    // Another program's keeper.toml over the same store.
    let other = Address::new_from_array([9; 32]);
    let (_, o) = stored(url, &dir, other);
    match o {
        StoreOpened::Discarded(why, aside) => {
            assert!(why.contains("of program"), "{why}");
            assert!(aside.exists());
        }
        o => panic!("{o:?}"),
    }
    // A damaged segment (shorter than its manifest entry).
    let (p, o) = stored(url, &dir, program());
    assert_eq!(
        o,
        StoreOpened::Empty,
        "the fresh store of the other program is empty"
    );
    assert_eq!(read_all(&p).await.unwrap().len(), 6);
    drop(p);
    let seg = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.to_string_lossy().ends_with(".log"))
        .unwrap();
    let len = std::fs::metadata(&seg).unwrap().len();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&seg)
        .unwrap()
        .set_len(len - 5)
        .unwrap();
    let (p, o) = stored(url, &dir, program());
    assert!(
        matches!(o, StoreOpened::Discarded(ref w, _) if w.contains("cannot open")),
        "{o:?}"
    );
    assert_eq!(read_all(&p).await.unwrap().len(), 6, "a full read");
    // A flipped byte inside a frame (same length): the frame check.
    drop(p);
    let mut b = std::fs::read(&seg).unwrap();
    let mid = b.len() / 2;
    b[mid] ^= 0x55;
    std::fs::write(&seg, b).unwrap();
    let (_, o) = stored(url, &dir, program());
    assert!(matches!(o, StoreOpened::Discarded(..)), "{o:?}");
    assert_eq!(asides(&root).len(), 3);
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[tokio::test]
async fn s6_a_failed_store_write_serves_nothing_and_loses_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let chain = mock(41854);
    push(&chain, 1, 4);
    let url = "http://127.0.0.1:41854";
    let root = scratch("s6");
    let dir = root.join("feed");
    let (p, _) = stored(url, &dir, program());
    assert_eq!(read_all(&p).await.unwrap().len(), 4);
    push(&chain, 5, 6);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    for f in std::fs::read_dir(&dir).unwrap() {
        let f = f.unwrap().path();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o400)).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(220)).await;
    let e = p.feed(Cursor(4)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("feed store could not be written")),
        "{e:?}"
    );
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    for f in std::fs::read_dir(&dir).unwrap() {
        let f = f.unwrap().path();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(820)).await;
    let page = p.feed(Cursor(4)).await.unwrap();
    assert_eq!(
        page.iter()
            .map(|r| (r.seq, r.signature.to_string()))
            .collect::<Vec<_>>(),
        vec![(5, sig(5)), (6, sig(6))]
    );
    drop(p);
    let (p, o) = stored(url, &dir, program());
    assert_eq!(o, StoreOpened::Restored(6));
    assert_eq!(read_all(&p).await.unwrap().len(), 6);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s7_keeper_toml_feed_store() {
    let base = |extra: &str| {
        format!(
            "program = \"{}\"\nseason = 1\nbeneficiary = \"{}\"\n{extra}",
            program(),
            Address::new_from_array([4; 32])
        )
    };
    let j = Path::new("/k/keeper.journal.sqlite");
    let rpc = "rpc = [\"https://api.devnet.solana.com\"]\nfeed = \"rpc\"\n";
    let c = KeeperConfig::from_toml(&base(rpc)).unwrap();
    assert_eq!(c.feed_store, FeedStoreConf::BesideJournal);
    assert_eq!(
        c.feed_store_dir(j),
        Some(PathBuf::from("/k/keeper.journal.sqlite.feed"))
    );
    let c = KeeperConfig::from_toml(&base(&format!("{rpc}feed_store = \"/s/feed\""))).unwrap();
    assert_eq!(c.feed_store_dir(j), Some(PathBuf::from("/s/feed")));
    let c = KeeperConfig::from_toml(&base(&format!("{rpc}feed_store = \"off\""))).unwrap();
    assert_eq!(c.feed_store_dir(j), None);
    // feed = "localnet": the local node keeps the ledger; nothing to store.
    let c = KeeperConfig::from_toml(&base("rpc = [\"http://127.0.0.1:41010\"]")).unwrap();
    assert_eq!(c.feed_store_dir(j), None);
    let e = KeeperConfig::from_toml(&base("feed_store = \"/s/feed\"")).unwrap_err();
    assert!(e.contains("needs feed"), "{e}");
    let e = KeeperConfig::from_toml(&base(&format!("{rpc}feed_store = \"\""))).unwrap_err();
    assert!(e.contains("directory or"), "{e}");
}

/// A localnet port has no polled feed: `persist_feed` is a no-op.
#[test]
fn s7_localnet_port_has_nothing_to_persist() {
    let mut p = ClusterPort {
        port: RpcPort::localnet("http://127.0.0.1:41855", program()),
        feed: None,
    };
    let root = scratch("s7");
    assert_eq!(
        p.persist_feed(&root.join("f"), program()).unwrap(),
        StoreOpened::Empty
    );
    assert!(!root.join("f").exists());
    let _ = std::fs::remove_dir_all(&root);
    let _: Option<Value> = Some(json!(null));
    let _ = Signature::default();
}
