//! `frontier-verify pull` (world3-verifier-watch): the READ-ONLY archive
//! step of a scheduled verifier watch over a public RPC.
//!
//! ```text
//! frontier-verify pull --program ID --season N --rpc URL --data DIR
//!                      [--origin SIG] [--rpc-min-gap-ms N] [--page N]
//!                      [--settle-tries N] [--no-finals]
//! ```
//!
//! The judge is then OFFLINE: `frontier-verify --fixture DIR/input.json.gz
//! --program-so SO --ruleset HEX` (0 RPC calls).
//!
//! One run (resumable, no keys, reads only):
//!
//! 1. opens (or creates) the findex store `DIR/findex` (archive in
//!    `DIR/findex/archive`, the format `frontier-verify --archive` reads)
//!    and resumes the archived `RpcPoll` cursor: only signatures after the
//!    last archived one are listed and fetched (`getSignaturesForAddress` +
//!    `getTransaction`, finalized; lookup tables snapshotted at first use,
//!    as the herald's archive);
//! 2. reads the final states of every account the archive wrote plus every
//!    program account of the season (`getProgramAccounts`, season id at
//!    offset 8) at finalized commitment, the Rent sysvar and the lookup
//!    tables;
//! 3. lists the signatures after the archive's last one once more: when
//!    one landed at or before the slot the finals were read at, the finals
//!    hold a transaction the archive does not, so the archive is pulled
//!    again and the finals re-read (`--settle-tries`, default 3). A
//!    signature only AFTER that slot does not touch the finals and is left
//!    for the next run. The summary says whether the pair is `consistent`;
//!    an inconsistent pair must not be judged as a mismatch;
//! 4. reads each NEW transaction's pre/post balances once (a second
//!    finalized `getTransaction`, kept in `DIR/balances.jsonl`) and the
//!    upgrade authority: without them VG (the genesis replay of an archive
//!    without post-states, `genesis::applies`) does not run and the season
//!    cannot be judged from a public RPC (the CLI's `--rpc --balances`, made
//!    incremental here);
//! 5. reads the deployed program's hash (ProgramData), and writes the whole
//!    input — the archive's transactions and history (RpcPoll coverage), the
//!    finals, the balances, rent, lookup tables and the archive's table
//!    snapshots — as the fixture `DIR/input.json.gz` (`Input::save`; it keeps
//!    where its transactions came from: never `as_given`).
//!
//! Every call goes through ONE pacer per endpoint
//! ([`verify_core::input::rpc_client`]): `--rpc-min-gap-ms` apart (default
//! 500, at most 2 requests a second), HTTP 429/503 retried after the
//! server's `Retry-After` with back-off. Prints one JSON summary line on
//! stdout; exit 0 done, 2 the run could not complete (nothing judged).

use std::collections::BTreeMap;
use std::path::PathBuf;

use fclient::ports::{Account, Signature, TxRecord};
use serde_json::{json, Value};
use solana_address::Address;
use verify_core::input;

/// Pulls while signatures stay held back (a transaction not retrievable yet).
const HELD_WAITS: u32 = 10;

struct Args {
    ruleset: [u8; 32],
    program: Address,
    season: u64,
    rpc: String,
    data: PathBuf,
    origin: Option<Signature>,
    page: usize,
    settle_tries: u32,
    finals: bool,
}

fn fail(msg: &str) -> ! {
    println!("{}", json!({"ok": false, "error": msg}));
    eprintln!("frontier-verify pull: {msg}");
    std::process::exit(verify_core::EXIT_UNVERIFIABLE);
}

fn parse(mut a: impl Iterator<Item = String>) -> Args {
    let (mut program, mut season, mut rpc, mut data, mut origin) = (None, None, None, None, None);
    let (mut page, mut settle_tries, mut finals, mut gap) = (1_000usize, 3u32, true, 500u64);
    // The ruleset hash the fixture's config names (the judge's --ruleset overrides it): S1's v3, which world 3's
    // Season carries (expedition_dispatch_ix: "S1's RULESET_HASH_V3, 12").
    let mut ruleset = frontier_abi::v2::presets::RULESET_HASH_V3;
    while let Some(x) = a.next() {
        let mut val = || {
            a.next()
                .unwrap_or_else(|| fail(&format!("{x} needs a value")))
        };
        match x.as_str() {
            "--program" => program = Some(val().parse().unwrap_or_else(|_| fail("bad --program"))),
            "--season" => season = Some(val().parse().unwrap_or_else(|_| fail("bad --season"))),
            "--rpc" => rpc = Some(val()),
            "--data" => data = Some(PathBuf::from(val())),
            "--origin" => origin = Some(val().parse().unwrap_or_else(|_| fail("bad --origin"))),
            "--page" => {
                page = val()
                    .parse()
                    .ok()
                    .filter(|n| (1..=1_000).contains(n))
                    .unwrap_or_else(|| fail("bad --page (1..=1000)"))
            }
            "--settle-tries" => {
                settle_tries = val()
                    .parse()
                    .ok()
                    .filter(|n| *n >= 1)
                    .unwrap_or_else(|| fail("bad --settle-tries"))
            }
            "--rpc-min-gap-ms" => {
                gap = val()
                    .parse()
                    .unwrap_or_else(|_| fail("bad --rpc-min-gap-ms"))
            }
            "--no-finals" => finals = false,
            "--ruleset" => ruleset = input::hex_arr(&val()).unwrap_or_else(|e| fail(&e)),
            other => fail(&format!("unknown argument {other}")),
        }
    }
    // One pacer per endpoint for the whole run (loopback included).
    input::set_rpc_min_gap_ms(gap);
    Args {
        ruleset,
        program: program.unwrap_or_else(|| fail("--program is required")),
        season: season.unwrap_or_else(|| fail("--season is required")),
        rpc: rpc.unwrap_or_else(|| fail("--rpc is required")),
        data: data.unwrap_or_else(|| fail("--data is required")),
        origin,
        page,
        settle_tries,
        finals,
    }
}

/// Pulls until caught up (or until a held-back tail stays held back).
async fn catch_up(fx: &mut findex::Findex, src: &mut findex::RpcPoll) -> Result<usize, String> {
    let mut n = 0;
    let mut waits = 0;
    loop {
        let got = fx.ingest(src).await.map_err(|e| format!("{e:?}"))?;
        if got.is_empty() {
            if src.held_back() == 0 || waits >= HELD_WAITS {
                break;
            }
            waits += 1;
            tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
            continue;
        }
        n += got.len();
    }
    fx.commit().map_err(|e| format!("{e:?}"))?;
    Ok(n)
}

/// The final states of `keys`, finalized, each chunk at or after `min_slot`;
/// returns them with the HIGHEST context slot any chunk was read at.
async fn read_finals(
    rpc: &fclient::rpc::RpcClient,
    keys: &[Address],
    min_slot: u64,
) -> Result<(BTreeMap<[u8; 32], Option<Account>>, u64), String> {
    let mut m = BTreeMap::new();
    let mut top = min_slot;
    for chunk in keys.chunks(100) {
        let ks: Vec<String> = chunk.iter().map(|k| k.to_string()).collect();
        let mut cfg = json!({"encoding": "base64", "commitment": "finalized"});
        if min_slot > 0 {
            cfg["minContextSlot"] = json!(min_slot);
        }
        let v = rpc
            .call("getMultipleAccounts", json!([ks, cfg]))
            .await
            .map_err(|e| e.to_string())?;
        let slot = v
            .pointer("/context/slot")
            .and_then(Value::as_u64)
            .ok_or("getMultipleAccounts: no context slot")?;
        top = top.max(slot);
        let arr = v
            .get("value")
            .and_then(Value::as_array)
            .ok_or("getMultipleAccounts: value")?;
        if arr.len() != chunk.len() {
            return Err(format!(
                "getMultipleAccounts: {} values for {} keys",
                arr.len(),
                chunk.len()
            ));
        }
        for (k, a) in chunk.iter().zip(arr) {
            m.insert(
                k.to_bytes(),
                fclient::rpc::parse_account(a).map_err(|e| e.to_string())?,
            );
        }
    }
    Ok((m, top))
}

/// Finalized signatures after `last` (newest first) down to and including
/// slot `floor`: is there one at or before `slot`? Pages only while the
/// page is full and its oldest is still above `slot`.
async fn landed_through(
    rpc: &fclient::rpc::RpcClient,
    program: &Address,
    last: Option<&Signature>,
    slot: u64,
    page: usize,
) -> Result<(bool, usize), String> {
    let mut before: Option<Signature> = None;
    let mut listed = 0;
    loop {
        let p = rpc
            .get_finalized_signatures_for_address(program, before.as_ref(), last, page)
            .await
            .map_err(|e| e.to_string())?;
        listed += p.len();
        if p.iter().any(|s| s.slot <= slot) {
            return Ok((true, listed));
        }
        match p.last() {
            Some(o) if p.len() >= page => before = Some(o.signature),
            _ => return Ok((false, listed)),
        }
    }
}

/// `DIR/balances.jsonl`: one `{"sig", "pre", "post"}` per line (a torn last
/// line is skipped: its transaction's balances are read again).
fn read_balances(p: &std::path::Path) -> BTreeMap<String, input::Balances> {
    let mut m = BTreeMap::new();
    for l in std::fs::read_to_string(p).unwrap_or_default().lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else {
            continue;
        };
        let nums = |k: &str| -> Option<Vec<u64>> {
            v.get(k)?.as_array()?.iter().map(Value::as_u64).collect()
        };
        if let (Some(sig), Some(pre), Some(post)) = (
            v.get("sig").and_then(Value::as_str),
            nums("pre"),
            nums("post"),
        ) {
            m.insert(sig.to_string(), input::Balances { pre, post });
        }
    }
    m
}

/// Season ids whose Season PDA marks a transaction as another season's even after that Season was closed (an aborted
/// world): devnet's ids are 1, 2, 3; 0..=63 covers any the operator tool would give.
const FOREIGN_SEASON_IDS: u64 = 64;

/// `txs` split into this season's and the signatures of OTHER seasons' transactions: a transaction is another
/// season's when one of its keys is another season's Season PDA (ids 0..64), or when it wrote a program-owned
/// account whose common header (season id at offset 8, as `input::program_accounts` filters) names another season.
/// Those accounts leave `finals` too (their count is returned): this season's input holds neither their
/// transactions nor their states. Leaving a transaction out never hides a mismatch of this season: VG still replays
/// the rest against this season's final states, so an account of this season it wrote would no longer be explained
/// (FAIL).
fn split_foreign(
    txs: Vec<TxRecord>,
    finals: &mut BTreeMap<[u8; 32], Option<Account>>,
    program: &Address,
    season: u64,
) -> (Vec<TxRecord>, Vec<String>, usize) {
    let mut other: std::collections::HashSet<[u8; 32]> = (0..FOREIGN_SEASON_IDS)
        .filter(|id| *id != season)
        .map(|id| fclient::addr::season_pda(program, id).0.to_bytes())
        .collect();
    for (k, a) in finals.iter() {
        if let Some(a) = a {
            if a.owner == *program
                && a.data.len() >= 16
                && u64::from_le_bytes(a.data[8..16].try_into().unwrap()) != season
            {
                other.insert(*k);
            }
        }
    }
    let mut keep = vec![];
    let mut foreign = vec![];
    for t in txs {
        let named = match verify_core::vmsg::Msg::of(&t) {
            Ok(m) => m.keys.iter().any(|k| other.contains(&k.to_bytes())),
            Err(_) => false,
        };
        if named {
            foreign.push(t.signature.to_string());
        } else {
            keep.push(t);
        }
    }
    let before = finals.len();
    finals.retain(|k, _| !other.contains(k));
    (keep, foreign, before - finals.len())
}

fn last_record(a: &findex::Archive) -> Option<TxRecord> {
    let n = a.last_seq();
    if n == 0 {
        return None;
    }
    a.read_after(n - 1).ok()?.into_iter().last()
}

pub fn main(a: impl Iterator<Item = String>) -> ! {
    let args = parse(a);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let out = rt.block_on(run(&args)).unwrap_or_else(|e| fail(&e));
    println!("{out}");
    std::process::exit(0);
}

async fn run(args: &Args) -> Result<Value, String> {
    let t0 = std::time::Instant::now();
    let store = args.data.join("findex");
    let mut fx = findex::Findex::open(
        &store,
        args.program,
        Some(args.season),
        findex::archive::SEGMENT_BYTES,
    )
    .map_err(|e| format!("{}: {e:?}", store.display()))?;
    let before_seq = fx.archive.last_seq();
    let mut src = findex::RpcPoll::new(args.rpc.clone(), args.program);
    src.rpc = input::rpc_client(&args.rpc);
    src.page = args.page;
    if let Some(o) = args.origin {
        src = src.with_origin(o);
    }
    fx.resume(&mut src);
    let rpc = input::rpc_client(&args.rpc);
    let mut archived = catch_up(&mut fx, &mut src).await?;
    let mut summary = json!({
        "ok": true,
        "archive": store.join("archive").display().to_string(),
    });
    if args.finals {
        let mut tries = 0;
        let settled = loop {
            tries += 1;
            let txs = fx.archive.read_after(0).map_err(|e| e.to_string())?;
            let last = last_record(&fx.archive);
            let last_slot = last.as_ref().map_or(0, |r| r.slot);
            let mut keys = input::written_keys(&txs);
            for k in input::program_accounts(&args.rpc, &args.program, args.season).await? {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
            let (finals, slot) = read_finals(&rpc, &keys, last_slot).await?;
            let (late, _) = landed_through(
                &rpc,
                &args.program,
                last.as_ref().map(|r| &r.signature),
                slot,
                args.page,
            )
            .await?;
            if !late || tries >= args.settle_tries {
                break (!late, slot, finals, late, txs);
            }
            // A transaction landed at or before the finals' slot: archive it
            // and read the finals again.
            archived += catch_up(&mut fx, &mut src).await?;
        };
        let (consistent, final_slot, finals, late, txs) = settled;
        // The Rent sysvar and the lookup tables at the finals' point.
        let rent = input::fetch_rent(&args.rpc, final_slot).await.ok();
        let tkeys = input::lookup_table_keys(&txs);
        let tables = if tkeys.is_empty() {
            None
        } else {
            input::fetch_lookup_tables(&args.rpc, &tkeys, final_slot)
                .await
                .ok()
        };
        // Each transaction's balances, once (cached by signature).
        let cache = args.data.join("balances.jsonl");
        let mut balances = read_balances(&cache);
        let mut fetched = 0;
        let mut unserved = 0;
        {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&cache)
                .map_err(|e| format!("{}: {e}", cache.display()))?;
            for t in &txs {
                let sig = t.signature.to_string();
                if balances.contains_key(&sig) {
                    continue;
                }
                match rpc
                    .get_transaction_balances(&t.signature, "finalized")
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Some((pre, post)) => {
                        writeln!(f, "{}", json!({"sig": sig, "pre": pre, "post": post}))
                            .map_err(|e| e.to_string())?;
                        balances.insert(sig, input::Balances { pre, post });
                        fetched += 1;
                    }
                    None => unserved += 1,
                }
            }
            f.sync_data().map_err(|e| e.to_string())?;
        }
        let upgrade_authority = input::upgrade_authority(&args.rpc, &args.program).await?;
        let program_hashes = match input::program_hash(&args.rpc, &args.program).await {
            Ok((slot, h)) => {
                summary["program_hash"] = json!({"deploy_slot": slot, "sha256": hex::encode(h)});
                vec![(slot, h)]
            }
            Err(e) => {
                summary["program_hash"] = json!({"error": e});
                vec![]
            }
        };
        let archive_dir = store.join("archive");
        let (_, history) = input::read_archive(&archive_dir)?;
        // Another season's transactions (the same program runs every season: devnet's worlds 1 and 2, a later
        // world) stay in the archive but not in this season's input: the verifier judges one season and FAILs a
        // foreign AnnounceSeason (V2 AnnounceMismatch, CQ1 chains; world3-verifier-watch dry run).
        let mut finals = finals;
        let (txs, foreign, foreign_accounts) =
            split_foreign(txs, &mut finals, &args.program, args.season);
        let n_accounts = finals.len();
        summary["foreign_season_txs"] = json!({
            "count": foreign.len(),
            "accounts_left_out": foreign_accounts,
            "signatures": foreign.iter().take(50).collect::<Vec<_>>(),
        });
        let inp = input::Input {
            cfg: input::Config {
                program: args.program,
                season_id: args.season,
                quicknet_pk: input::hex_arr(fclient::beacon::QUICKNET_PK)?,
                ruleset_hash: args.ruleset,
                program_hash: None,
            },
            txs,
            finals,
            final_slot,
            program_hashes,
            provenance: format!(
                "verify-watch pull: findex RpcPoll archive {} + finals at slot {final_slot} over {}; {} transaction(s) of other seasons left out (verify-watch foreign_season_txs)",
                archive_dir.display(),
                fclient::https::redact(&args.rpc),
                foreign.len()
            ),
            scenarios: vec![],
            history,
            resident_feed: None,
            program_so: None,
            declared: vec![],
            chain: input::ChainWitness {
                balances,
                upgrade_authority,
                cross: None,
                rent,
                lookup_tables: tables,
                lookup_snapshots: input::archive_lookup_snapshots(&archive_dir)?,
            },
        };
        let p = args.data.join("input.json.gz");
        let tmp = args.data.join("input.tmp.json.gz");
        inp.save(&tmp)?;
        std::fs::rename(&tmp, &p).map_err(|e| format!("{}: {e}", p.display()))?;
        summary["input"] = json!(p.display().to_string());
        summary["finals"] = json!({
            "final_slot": final_slot,
            "accounts": n_accounts,
            "consistent": consistent,
            "late_signature_at_or_before_final_slot": late,
            "tries": tries,
        });
        summary["balances"] =
            json!({"fetched": fetched, "unserved": unserved, "cached": inp.chain.balances.len()});
        summary["ruleset"] = json!(hex::encode(args.ruleset));
    } else {
        match input::program_hash(&args.rpc, &args.program).await {
            Ok((slot, h)) => {
                summary["program_hash"] = json!({"deploy_slot": slot, "sha256": hex::encode(h)})
            }
            Err(e) => summary["program_hash"] = json!({"error": e}),
        }
    }
    let last = last_record(&fx.archive);
    let (calls, throttled) = input::rpc_calls()
        .iter()
        .fold((0, 0), |(c, t), (_, n, b)| (c + n, t + b));
    summary["archived"] = json!(archived);
    summary["seq_before"] = json!(before_seq);
    summary["seq"] = json!(fx.archive.last_seq());
    summary["last_slot"] = json!(last.as_ref().map(|r| r.slot));
    summary["last_signature"] = json!(last.as_ref().map(|r| r.signature.to_string()));
    summary["held_back"] = json!(src.held_back());
    summary["coverage"] = src.coverage();
    summary["requests"] = json!(calls);
    summary["throttled"] = json!(throttled);
    summary["seconds"] = json!(t0.elapsed().as_secs_f64());
    Ok(summary)
}
