//! `frontier-herald` (M1 contract §8.4): ingest → fold → files, and the
//! origin serving `/h/*`, `WS /h/ws`, `/frontier/*` and `/gw/*`.
//!
//! ```text
//! frontier-herald --data DIR --program B58 --season ID --rpc http://127.0.0.1:41010
//!     [--listen 127.0.0.1:41040] [--source localnet|rpc] [--cluster localnet]
//!     (--source rpc requires --cluster: the herald cannot tell which chain an RPC serves)
//!     [--origin SIG] [--witness URL]   (rpc source: history coverage checks)
//!     [--rpc-min-gap-ms 150]  (rpc source: least time between two calls to --rpc; 0 = unpaced)
//!     [--web DIR] [--relay 127.0.0.1:41033] [--test-key | --drand-info FILE]
//!     [--checkpoint-slots 150] [--poll-ms 200] [--quotas JSON]
//!     [--clock-ms N]  (how often the Clock (live slot) is read, beside the pulls; default = --poll-ms)
//!     [--pull-max 50]  (rpc source: the most transactions one pull fetches; the rest follow in
//!      the next pulls, each chunk archived, folded and published on its own)
//!     [--wide-index PATH]  (feature wide-index-read-experimental, read-only)
//!     [--public-host NAME[,NAME…]]  (B13: the names the TLS proxy serves;
//!      every request's Host, and a WS Origin, must name loopback or one of them)
//!     [--chat-dir DIR [--chat-admin-token-file FILE]]  (nation chat `/h/chat/*`, src/chat.rs; off
//!      without it. DIR holds the messages and reports and is never served; FILE the operator's token)
//! --source read-only requires a matching herald.ckpt and --wide-index; no RPC/ingest/write.
//! frontier-herald --fixture conquest --data DIR --listen 127.0.0.1:PORT [--web DIR]
//! ```
//! `--fixture conquest` (MC contract §8.4, CQ2-E) folds the synthetic
//! conquest mini-season (`herald_fold::cqfixture`) into `DIR` and serves it
//! read-only (no ingest, no chain); CQ3-E's recorded mini-season replaces
//! the synthetic one. `--listen` is required in this mode: the fixture's
//! well-known port (41900) is assigned at Gate CQ3 and is held by another
//! service until then (use a port in 41400–41599).
//! The listen port must be 41000–41999 (or 0) and never a reserved port
//! (§10.3). Stop with Ctrl-C: the fold is checkpointed on the way out.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use fclient::rpc::RpcPort;
use findex::{Enriched, LocalnetFeed, RpcPoll};
use herald_fold::runner::{self, Ingest, IngestCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use solana_address::Address;
use tokio::sync::{broadcast, watch};

/// `--public-host a.example,b.example` → the herald's host policy (B13).
fn hosts(a: &HashMap<String, String>) -> Result<herald_fold::server::HostPolicy, String> {
    let names: Vec<&str> = a
        .get("public-host")
        .map(|v| v.split(',').collect())
        .unwrap_or_default();
    herald_fold::server::HostPolicy::with_public(&names)
}

/// `--chat-dir DIR [--chat-admin-token-file FILE]` → the nation chat, or none (src/chat.rs).
fn chat_of(a: &HashMap<String, String>) -> Result<Option<Arc<herald_fold::chat::Chat>>, String> {
    let Some(dir) = a.get("chat-dir") else {
        if a.contains_key("chat-admin-token-file") {
            return Err("--chat-admin-token-file needs --chat-dir".into());
        }
        return Ok(None);
    };
    let token = match a.get("chat-admin-token-file") {
        Some(p) => Some(
            std::fs::read_to_string(p)
                .map_err(|e| format!("--chat-admin-token-file {p}: {e}"))?
                .trim()
                .to_string(),
        ),
        None => None,
    };
    let c = herald_fold::chat::Chat::open(PathBuf::from(dir), token)?;
    eprintln!("frontier-herald: nation chat on (/h/chat/*), store {dir}");
    Ok(Some(Arc::new(c)))
}

fn args() -> Result<HashMap<String, String>, String> {
    let mut m = HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let k = a
            .strip_prefix("--")
            .ok_or(format!("unexpected argument {a}"))?
            .to_string();
        if k == "test-key" {
            m.insert(k, "1".into());
            continue;
        }
        let v = it.next().ok_or(format!("--{k} needs a value"))?;
        m.insert(k, v);
    }
    Ok(m)
}

/// `--fixture conquest`: fold the synthetic conquest season, then serve it.
async fn fixture_conquest(a: &HashMap<String, String>) -> Result<(), String> {
    let data = PathBuf::from(a.get("data").ok_or("--data is required")?);
    let listen = a
        .get("listen")
        .cloned()
        .ok_or("--listen is required with --fixture (41400-41599 until Gate CQ3 assigns 41900)")?;
    let port: u16 = listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .ok_or("--listen: host:port")?;
    if !herald_fold::port_allowed(port) {
        return Err(format!(
            "--listen port {port}: services use 41000-41999 and never a reserved port"
        ));
    }
    let host_policy = hosts(a)?;
    use herald_fold::cqfixture;
    let txs = cqfixture::mini_season();
    let cfg = IngestCfg::new(&data, cqfixture::program(), cqfixture::SEASON_ID);
    let (diffs, _) = broadcast::channel(4_096);
    let mut ing = Ingest::open(cfg.clone(), diffs.clone())?;
    let mut src = cqfixture::VecSource {
        txs,
        pos: 0,
        batch: 500,
    };
    ing.findex.resume(&mut src);
    while ing.step(&mut src).await? > 0 {}
    ing.checkpoint()?;
    let mut app = App::new(
        ing.fold.clone(),
        herald_fold::files::Out::new(cfg.files_dir()),
        SeasonStatic {
            cluster: "fixture".into(),
            drand: fclient::beacon::TestKey::new().info(),
            quotas: serde_json::json!({"perDay": 40, "burst": 60}),
        },
        diffs,
    );
    app.web = a.get("web").map(PathBuf::from);
    app.index = Some(cfg.index_path());
    app.hosts = host_policy;
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .map_err(|e| format!("{listen}: {e}"))?;
    eprintln!(
        "frontier-herald: --fixture conquest (season {}) on http://{}",
        cqfixture::SEASON_ID,
        listener.local_addr().map_err(|e| e.to_string())?
    );
    tokio::select! {
        r = server::serve(listener, Arc::new(app)) => r.map_err(|e| e.to_string()),
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}

/// The cluster `/h/season` names (2026-11-17). Clients act on it: the web
/// client turns on the localnet clock, the localnet sample world and the dev
/// wallet, and picks the wallet's chain, from `cluster == "localnet"`
/// (permutation-server/web/frontier app.mjs `FS.chain.setAccelerated`,
/// `FS.sample`; controller.mjs `enableDevWallet`, `wallet.chainOf`). The
/// localnet source reads `frontier-localnet` (its `frontier_*` methods), so
/// its default "localnet" is what it reads. `--source rpc` reads any
/// Solana RPC, and the herald cannot tell which chain that is: without
/// `--cluster` it said "localnet" for a public chain. It is now required
/// there (blank refused); the public playtest runbook already passes it
/// (docs/frontier/m1/PLAYTEST-RUNBOOK.md, `--cluster devnet`). Every other
/// source keeps its value exactly as before.
fn season_cluster(source: Option<&str>, cluster: Option<&str>) -> Result<String, String> {
    if source == Some("rpc") {
        return match cluster {
            Some(c) if !c.trim().is_empty() => Ok(c.to_string()),
            _ => Err(
                "--source rpc requires --cluster NAME (the cluster /h/season names; \
                      the herald cannot tell which chain an RPC serves)"
                    .into(),
            ),
        };
    }
    Ok(cluster
        .map(str::to_string)
        .unwrap_or_else(|| "localnet".into()))
}

async fn main_inner() -> Result<(), String> {
    let a = args()?;
    #[cfg(not(feature = "wide-index-read-experimental"))]
    if a.contains_key("wide-index") || a.get("source").is_some_and(|s| s == "read-only") {
        return Err("--wide-index / read-only require feature wide-index-read-experimental".into());
    }
    #[cfg(not(feature = "local-play-bootstrap"))]
    if a.contains_key("local-play-metadata") {
        return Err("--local-play-metadata requires feature local-play-bootstrap".into());
    }
    match a.get("fixture").map(String::as_str) {
        Some("conquest") => return fixture_conquest(&a).await,
        Some(x) => return Err(format!("--fixture {x}: only `conquest`")),
        None => {}
    }
    let need = |k: &str| a.get(k).cloned().ok_or(format!("--{k} is required"));
    let data = PathBuf::from(need("data")?);
    let program: Address = need("program")?
        .parse()
        .map_err(|_| "--program: not base58")?;
    let season: u64 = need("season")?
        .parse()
        .map_err(|_| "--season: not a number")?;
    let read_only = a.get("source").is_some_and(|s| s == "read-only");
    if read_only && !a.contains_key("wide-index") {
        return Err("--source read-only requires --wide-index PATH".into());
    }
    // Before anything is opened or bound: the cluster /h/season will name.
    let cluster = season_cluster(
        a.get("source").map(String::as_str),
        a.get("cluster").map(String::as_str),
    )?;
    let rpc = if read_only {
        String::new()
    } else {
        need("rpc")?
    };
    let host_policy = hosts(&a)?;
    let listen = a.get("listen").cloned().unwrap_or("127.0.0.1:41040".into());
    let port: u16 = listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .ok_or("--listen: host:port")?;
    if !herald_fold::port_allowed(port) {
        return Err(format!(
            "--listen port {port}: M1 services use 41000-41999 and never a reserved port"
        ));
    }
    let drand = if a.contains_key("test-key") {
        fclient::beacon::TestKey::new().info()
    } else if let Some(p) = a.get("drand-info") {
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        fclient::beacon::parse_info_json(&v).ok_or("--drand-info: not a drand info JSON")?
    } else {
        fclient::beacon::quicknet_info()
    };
    let quotas = match a.get("quotas") {
        Some(q) => serde_json::from_str(q).map_err(|e| format!("--quotas: {e}"))?,
        None => serde_json::json!({"perDay": 40, "burst": 60}),
    };
    let mut cfg = IngestCfg::new(&data, program, season);
    cfg.exact_post = a.get("source").map(String::as_str).unwrap_or("localnet") == "localnet";
    if let Some(n) = a.get("checkpoint-slots") {
        cfg.checkpoint_slots = n.parse().map_err(|_| "--checkpoint-slots")?;
    }
    // (`--output compact-v1`: a NEW world's data directory keeps only the `.gz` of each output file; files.rs, runner.rs.
    //  `--output compact-v2` (TEST-ONLY): the same, and its findex store gzip-compressed — findex::codec)
    match a.get("output").map(String::as_str) {
        None => {}
        Some("compact-v1") if !read_only => cfg.compact_output = true,
        Some("compact-v2") if !read_only => {
            cfg.compact_output = true;
            cfg.store_codec = findex::codec::Codec::GzipV1;
        }
        Some(x) => {
            return Err(format!(
                "--output {x}: only `compact-v1` or `compact-v2`, and not with --source read-only"
            ))
        }
    }
    let poll = Duration::from_millis(
        a.get("poll-ms")
            .map(|v| v.parse().unwrap_or(200))
            .unwrap_or(200),
    );
    // herald-pull-chunk: the Clock on its own timer (default: as often as an idle poll, as before).
    let clock_every = match a.get("clock-ms") {
        Some(v) => Duration::from_millis(
            v.parse::<u64>()
                .ok()
                .filter(|&n| n > 0)
                .ok_or("--clock-ms: a number > 0")?,
        ),
        None => poll,
    };
    // Opt-in local-play bootstrap: checked before the data directory is
    // created or any archive opened (a new/empty directory, the localnet
    // source, a loopback RPC, the runner's own program/season/RPC).
    #[cfg(feature = "local-play-bootstrap")]
    let local_play = match a.get("local-play-metadata") {
        None => None,
        Some(path) => {
            use herald_fold::local_play;
            if read_only || a.get("source").map(String::as_str).unwrap_or("localnet") != "localnet"
            {
                return Err("--local-play-metadata needs --source localnet".into());
            }
            local_play::loopback_rpc(&rpc)?;
            local_play::loopback_listen(&listen)?;
            local_play::fresh_data_dir(&data)?;
            let text =
                std::fs::read_to_string(path).map_err(|e| format!("--local-play-metadata: {e}"))?;
            let e = local_play::expected(&text, &program, season, &rpc)?;
            let snap = local_play::read(&rpc, &e).await?;
            local_play::check(&e, &snap)?;
            Some((e, snap))
        }
    };
    let (diffs, _) = broadcast::channel(4_096);
    let ing = if read_only {
        None
    } else {
        Some(Ingest::open(cfg.clone(), diffs.clone())?)
    };
    #[cfg(feature = "local-play-bootstrap")]
    let local_play_status = match (&local_play, &ing) {
        (Some((e, snap)), Some(ing)) => {
            let mut f = ing.fold.write().map_err(|_| "fold lock poisoned")?;
            Some(herald_fold::local_play::seed(&mut f, e, snap)?)
        }
        _ => None,
    };
    let fold = match &ing {
        Some(ing) => ing.fold.clone(),
        None => {
            #[cfg(feature = "wide-index-read-experimental")]
            {
                herald_fold::wide_read::load_read_only_fold(&cfg)?
            }
            #[cfg(not(feature = "wide-index-read-experimental"))]
            {
                return Err("read-only feature unavailable".into());
            }
        }
    };
    let mut app = App::new(
        fold,
        cfg.out(),
        SeasonStatic {
            cluster,
            drand,
            quotas,
        },
        diffs,
    );
    app.web = a.get("web").map(PathBuf::from);
    #[cfg(feature = "local-play-bootstrap")]
    {
        app.local_play = local_play_status;
    }
    app.relay = if read_only {
        None
    } else {
        a.get("relay").cloned()
    };
    app.index = (!read_only).then(|| cfg.index_path());
    app.wide_index = a.get("wide-index").map(PathBuf::from);
    eprintln!(
        "frontier-herald: Host allow-list {}",
        host_policy.names().join(", ")
    );
    app.hosts = host_policy;
    app.chat = chat_of(&a)?;
    if let Some(c) = app.chat.clone() {
        // (messages and reports are dropped 7 days after they were posted, also while nobody asks)
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(600));
            loop {
                t.tick().await;
                c.prune_and_save();
            }
        });
    }
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .map_err(|e| format!("{listen}: {e}"))?;
    eprintln!(
        "frontier-herald: {} season {season} on http://{}",
        program,
        listener.local_addr().map_err(|e| e.to_string())?
    );
    if read_only {
        return tokio::select! {
            r = server::serve(listener, Arc::new(app)) => r.map_err(|e| e.to_string()),
            _ = tokio::signal::ctrl_c() => Ok(()),
        };
    }
    let ing = ing.ok_or("missing ingest")?;
    let srv = tokio::spawn(server::serve(listener, Arc::new(app)));
    let (stop_tx, stop) = watch::channel(false);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop_tx.send(true);
    });
    let res = match a.get("source").map(String::as_str).unwrap_or("localnet") {
        "localnet" => {
            // The ledger's id (`frontier_status.runId`): an archive of another
            // ledger is refused instead of resumed (findex `LocalnetFeed`).
            // (verifier-alt-archive: each lookup table's first use archived
            // with a snapshot of the table, read from the same node.)
            let mut feed = LocalnetFeed::new(RpcPort::localnet(rpc.clone(), program))
                .with_program(program)
                .with_table_reads(fclient::rpc::RpcClient::new(rpc.clone()));
            if let Ok(v) = fclient::rpc::RpcClient::new(rpc.clone())
                .call("frontier_status", serde_json::json!([]))
                .await
            {
                if let Some(id) = v.get("runId").and_then(|x| x.as_str()) {
                    feed = feed.with_ledger(id);
                }
                // The ledger size now: a later check sees a ledger that shrank.
                if let Some(b) = v.get("ledgerBytes").and_then(|x| x.as_u64()) {
                    feed = feed.with_ledger_bytes(b);
                }
            }
            let clock = RpcPort::localnet(rpc.clone(), program);
            runner::run_with(ing, feed, Some(clock), poll, clock_every, stop).await
        }
        "rpc" => {
            // G1/G3 checks (findex `RpcPoll::coverage`): without them the
            // archived range is reported unverifiable, not complete.
            // One pacer for every call to `--rpc` (the public devnet RPC is
            // rate-limited per IP; HTTP 429/503 backs all off): 150 ms
            // unless `--rpc-min-gap-ms` says otherwise (0: unpaced).
            let gap: u64 = match a.get("rpc-min-gap-ms") {
                Some(v) => v.parse().map_err(|_| "--rpc-min-gap-ms: a number")?,
                None => 150,
            };
            let pacer = (gap > 0).then(|| {
                fclient::rpc::Pacer::new(Duration::from_millis(gap), Duration::from_secs(30))
            });
            let paced = |url: &str| {
                let c = fclient::rpc::RpcClient::new(url);
                match &pacer {
                    Some(p) => c.with_pacer(p.clone()),
                    None => c,
                }
            };
            // herald-pull-chunk: one pull fetches at most this many transactions (default 50).
            let pull_max: usize = match a.get("pull-max") {
                Some(v) => v
                    .parse()
                    .ok()
                    .filter(|&n| n > 0)
                    .ok_or("--pull-max: a number > 0")?,
                None => DEFAULT_PULL_MAX,
            };
            let mut rpc_poll = RpcPoll::new(rpc.clone(), program).with_max_batch(pull_max);
            rpc_poll.rpc = paced(&rpc);
            if let Some(o) = a.get("origin") {
                rpc_poll = rpc_poll.with_origin(
                    o.parse()
                        .map_err(|_| format!("--origin {o}: a signature"))?,
                );
            }
            if let Some(w) = a.get("witness") {
                // Another endpoint: its own pacer (its own limit), as the
                // keeper's `feed_witness`; an https one retries its 429s.
                let c = fclient::rpc::RpcClient::new(w.clone());
                rpc_poll.witness = Some(if gap > 0 {
                    c.with_pacer(fclient::rpc::Pacer::new(
                        Duration::from_millis(gap),
                        Duration::from_secs(30),
                    ))
                } else {
                    c
                });
            }
            let mut src = Enriched::new(rpc_poll, rpc.clone(), program);
            src.rpc = paced(&rpc);
            let mut port = RpcPort::new(rpc.clone(), program);
            port.rpc = paced(&rpc);
            runner::run_with(ing, src, Some(port), poll, clock_every, stop).await
        }
        s => Err(format!("--source {s}: localnet or rpc")),
    };
    srv.abort();
    res
}

/// `--pull-max` default (herald-pull-chunk): ≈ 1–3 min of devnet's shared
/// getTransaction budget per chunk.
const DEFAULT_PULL_MAX: usize = 50;

#[tokio::main]
async fn main() {
    if let Err(e) = main_inner().await {
        eprintln!("frontier-herald: {e}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod season_cluster_tests {
    //! WRITTEN, NOT RUN (2026-11-17, under an execution pause): not compiled
    //! or run. Run it only with its own approval. Pure: no key, no file, no
    //! network, no process.
    //!   C1 --source rpc without --cluster, or with a blank one: refused
    //!   C2 --source rpc --cluster devnet (or localnet, as given): that name
    //!   C3 the localnet source (default or explicit) and read-only: as
    //!      before ("localnet" unless --cluster names another)
    use super::season_cluster;

    #[test]
    fn c1_rpc_needs_a_cluster() {
        for c in [None, Some(""), Some("  ")] {
            let e = season_cluster(Some("rpc"), c).expect_err("refused");
            assert!(e.contains("--source rpc requires --cluster"), "{e}");
        }
    }

    #[test]
    fn c2_rpc_takes_the_named_cluster() {
        assert_eq!(
            season_cluster(Some("rpc"), Some("devnet")),
            Ok("devnet".to_string())
        );
        assert_eq!(
            season_cluster(Some("rpc"), Some("localnet")),
            Ok("localnet".to_string())
        );
    }

    #[test]
    fn c3_other_sources_unchanged() {
        for s in [None, Some("localnet"), Some("read-only")] {
            assert_eq!(season_cluster(s, None), Ok("localnet".to_string()));
            assert_eq!(season_cluster(s, Some("devnet")), Ok("devnet".to_string()));
        }
        assert_eq!(
            season_cluster(None, Some("")),
            Ok(String::new()),
            "as before: given as is"
        );
    }
}
