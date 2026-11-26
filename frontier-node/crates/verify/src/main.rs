//! `frontier-verify` (M1 contract §8.5): verifies a season and writes
//! `report.json` and `report.md`. Exit 0 PASS, 1 FAIL, 2 cannot verify.
//!
//! ```text
//! frontier-verify [tamper] --fixture FILE [options]
//! frontier-verify [tamper] --program ID --season N --archive DIR (--finals FILE | --rpc URL) [options]
//! frontier-verify [tamper] --program ID --season N --rpc URL [--localnet] [options]
//! frontier-verify pull --program ID --season N --rpc URL --data DIR [--rpc-min-gap-ms N (default 1000)]
//!                      [--settle-tries N] [--skip-no-program-ix] [--ruleset HEX]
//!                      (read-only: archive the new transactions, write DIR/finals.json; src/pull.rs)
//!
//! options: --test-key | --quicknet-pk HEX   the pinned drand key (default: quicknet)
//!          --ruleset HEX                    expected ruleset hash (default: this build's)
//!          --program-hash HEX               expected .so sha256 (V2)
//!          --program-so FILE                the pinned .so (or .so.gz), for VX and VG (playable lane)
//!          --lamports-per-byte N            the cluster's rent rate, when no Rent sysvar was read: VX and
//!                                           VG re-execute under it (`declared` in the report). With --rpc
//!                                           the sysvar is read with the final states (`chain`); a finals
//!                                           file or fixture may carry it (`rent`). A declared rate that
//!                                           disagrees with the chain's is refused. Neither: 5,080 is
//!                                           ASSUMED and the report says so
//!                                           v0 transactions' lookup tables are read with the final
//!                                           states (--rpc) or taken from a finals file's / fixture's
//!                                           `lookup_tables`; VT checks every archived
//!                                           `loadedAddresses` against them (verifier-v0v1); a table
//!                                           closed since is checked against the archive's snapshot of
//!                                           it (findex, first use) or, with --rpc, its own create /
//!                                           extend transactions (verifier-alt-archive)
//!          --balances                       with --rpc: also read each transaction's pre/post
//!                                           balances and the upgrade authority (VG: an archive
//!                                           without post-states re-executed from genesis)
//!          --out DIR                        report directory (default: verify-report)
//!          --json                           print the JSON report instead of the Markdown
//!          --save FILE                      also write the input read as a fixture (.gz: gzip)
//!          --origin SIG                     public RPC: findex's origin anchor (G1)
//!          --witness URL                    public RPC, repeatable: a second, independent RPC; its
//!                                           signature list feeds findex's G3, and VS compares every
//!                                           transaction, block, account and final with it. Only VG's
//!                                           exact end state AND every witness agreeing lift ⑲'s
//!                                           `unproven` (⑰ Q-P1 = (a)+(b), witness.rs);
//!                                           every witness agreeing with VG FAILing is
//!                                           FAIL, never PASS (⑰ Q-P2, history.rs)
//!          --rpc-min-gap-ms N               least time between two calls to one RPC endpoint
//!                                           (default: 250 for https://, none for loopback); given,
//!                                           it also paces a loopback proxy and retries its 429s
//!          --resident-program ID            the NFT resident program, for V28: its feed from
//!                                           --resident-archive DIR (its findex archive) or
//!                                           from --rpc URL --localnet (same node, one ledger order);
//!                                           an RPC history is never PASS (history.rs)
//!          --jobs N                         tamper: classes judged at a time (default: cores, ≤ 8)
//!          --fallback-fixtures DIR          tamper: judge a class the run cannot express on the
//!                                           committed fixtures in DIR instead (labelled)
//!          --strict                         tamper: any such fallback exits 2
//! ```
//!
//! `tamper` (W5-D) runs T1–T22 and the extra checks of the checks over the
//! run instead ([`verify_core::tamper::run_suite`]) and writes `tamper.json`
//! and `tamper.md`: exit 0 every required class FAILS with its code, 1 a
//! class was missed, 2 the run itself does not PASS or a class could not
//! be built on it.
//!
//! A fixture file carries its own configuration; the options override it
//! (the tamper classes T10 and T11 are a wrong key and a wrong ruleset).

use std::path::PathBuf;

use verify_core::input::{self, hex_arr, Config, Input};

// world3-verifier-watch: `frontier-verify pull`, the read-only archive step of
// a scheduled watch (scripts/devnet/verify-watch.mjs).
mod pull;

fn usage(msg: &str) -> ! {
    eprintln!("frontier-verify: {msg}\n");
    eprintln!(
        "{}",
        include_str!("main.rs")
            .lines()
            .skip(4)
            .take_while(|l| !l.starts_with("//! ```"))
            .map(|l| {
                l.strip_prefix("//! ")
                    .or_else(|| l.strip_prefix("//!"))
                    .unwrap_or(l)
            })
            .collect::<Vec<_>>()
            .join("\n")
    );
    std::process::exit(verify_core::EXIT_UNVERIFIABLE);
}

fn main() {
    // A `mutate-*` build has a check disabled (the checks of the checks):
    // it never passes for the verifier (wave-5 review of W5-D).
    if let Some(m) = verify_core::mutated() {
        eprintln!("frontier-verify: MUTATED BUILD ({m}): a check is disabled; this binary is not a verifier");
        if std::env::var(verify_core::ALLOW_MUTATED_ENV).as_deref() != Ok("1") {
            eprintln!(
                "frontier-verify: refusing to run (rebuild without --features {m}, or set {}=1 for the checks of the checks)",
                verify_core::ALLOW_MUTATED_ENV
            );
            std::process::exit(verify_core::EXIT_UNVERIFIABLE);
        }
    }
    let mut a = std::env::args().skip(1).peekable();
    if a.peek().is_some_and(|x| x == "pull") {
        a.next();
        pull::main(a);
    }
    let tamper = a.peek().is_some_and(|x| x == "tamper");
    if tamper {
        a.next();
    }
    let mut save: Option<PathBuf> = None;
    let mut jobs: usize = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    let mut fixture: Option<PathBuf> = None;
    let mut archive: Option<PathBuf> = None;
    let mut finals: Option<PathBuf> = None;
    let mut rpc: Option<String> = None;
    let mut localnet = false;
    let mut origin: Option<fclient::ports::Signature> = None;
    let mut witnesses: Vec<String> = vec![];
    let mut resident_program: Option<String> = None;
    let mut resident_archive: Option<PathBuf> = None;
    let mut program: Option<String> = None;
    let mut season: Option<u64> = None;
    let mut pk: Option<[u8; 96]> = None;
    let mut ruleset: Option<[u8; 32]> = None;
    let mut program_hash: Option<[u8; 32]> = None;
    let mut program_so: Option<PathBuf> = None;
    let mut lamports_per_byte: Option<u64> = None;
    let mut out = PathBuf::from("verify-report");
    let mut json = false;
    let mut fallback: Option<PathBuf> = None;
    let mut strict = false;
    let mut balances = false;
    while let Some(x) = a.next() {
        let mut val = || {
            a.next()
                .unwrap_or_else(|| usage(&format!("{x} needs a value")))
        };
        match x.as_str() {
            "--fixture" => fixture = Some(val().into()),
            "--archive" => archive = Some(val().into()),
            "--finals" => finals = Some(val().into()),
            "--rpc" => rpc = Some(val()),
            "--localnet" => localnet = true,
            "--origin" => origin = Some(val().parse().unwrap_or_else(|_| usage("bad --origin"))),
            "--witness" => witnesses.push(val()),
            "--rpc-min-gap-ms" => verify_core::input::set_rpc_min_gap_ms(
                val()
                    .parse()
                    .unwrap_or_else(|_| usage("bad --rpc-min-gap-ms")),
            ),
            "--resident-program" => resident_program = Some(val()),
            "--resident-archive" => resident_archive = Some(val().into()),
            "--program" => program = Some(val()),
            "--season" => season = Some(val().parse().unwrap_or_else(|_| usage("bad --season"))),
            "--test-key" => pk = Some(fclient::beacon::TestKey::new().pk96),
            "--quicknet-pk" => pk = Some(hex_arr(&val()).unwrap_or_else(|e| usage(&e))),
            "--ruleset" => ruleset = Some(hex_arr(&val()).unwrap_or_else(|e| usage(&e))),
            "--program-hash" => program_hash = Some(hex_arr(&val()).unwrap_or_else(|e| usage(&e))),
            "--program-so" => program_so = Some(val().into()),
            "--lamports-per-byte" => {
                lamports_per_byte = Some(
                    val()
                        .parse()
                        .ok()
                        .filter(|&n| n > 0)
                        .unwrap_or_else(|| usage("bad --lamports-per-byte")),
                )
            }
            "--balances" => balances = true,
            "--out" => out = val().into(),
            "--json" => json = true,
            "--save" => save = Some(val().into()),
            "--jobs" => jobs = val().parse().unwrap_or_else(|_| usage("bad --jobs")),
            "--fallback-fixtures" => fallback = Some(val().into()),
            "--strict" => strict = true,
            "-h" | "--help" => usage("help"),
            other => usage(&format!("unknown argument {other}")),
        }
    }
    let quicknet = || hex_arr::<96>(fclient::beacon::QUICKNET_PK).expect("pinned quicknet key");
    let from_fixture = fixture.is_some();
    let mut inp = if let Some(f) = fixture {
        Input::load(&f).unwrap_or_else(|e| usage(&e))
    } else {
        let program = program
            .unwrap_or_else(|| usage("--program is required"))
            .parse()
            .unwrap_or_else(|_| usage("bad --program"));
        let season_id = season.unwrap_or_else(|| usage("--season is required"));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (txs, history) = match (&archive, &rpc) {
            (Some(d), u) => {
                let (txs, h) = input::read_archive(d).unwrap_or_else(|e| usage(&e));
                // With a node, the archive is checked against its ledger now
                // (a rewind under the same runId); alone, its history says
                // that cannot be seen (`input::ARCHIVE_ONLY`).
                let h = match u {
                    Some(u) => rt
                        .block_on(input::confirm_archive(d, u, h))
                        .unwrap_or_else(|e| usage(&e)),
                    None => h,
                };
                (txs, h)
            }
            (None, Some(u)) => rt
                .block_on(input::fetch_txs(
                    u,
                    &program,
                    localnet,
                    origin,
                    witnesses.first().map(String::as_str),
                ))
                .unwrap_or_else(|e| usage(&e)),
            (None, None) => usage("--archive or --rpc is required"),
        };
        // (rent-live-rest: the Rent sysvar a finals file recorded beside its states)
        let mut finals_rent: Option<input::RentRead> = None;
        // (verifier-v0v1: the lookup tables a finals file recorded beside its states)
        let mut finals_tables: Option<input::LookupTables> = None;
        // (verifier-alt-archive: a finals file's lookup table snapshots)
        let mut finals_snaps: Vec<fclient::alt::Snapshot> = vec![];
        let (finals, final_slot) = match (&finals, &rpc) {
            (Some(f), _) => {
                let s = std::fs::read_to_string(f).unwrap_or_else(|e| usage(&e.to_string()));
                let v: serde_json::Value =
                    serde_json::from_str(&s).unwrap_or_else(|e| usage(&e.to_string()));
                finals_rent = match v.get("rent") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(r) => Some(input::RentRead::from_json(r).unwrap_or_else(|e| usage(&e))),
                };
                finals_snaps = input::snapshots_from_json(v.get("lookup_snapshots"))
                    .unwrap_or_else(|e| usage(&e));
                finals_tables = match v.get("lookup_tables") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(t) => {
                        Some(input::LookupTables::from_json(t).unwrap_or_else(|e| usage(&e)))
                    }
                };
                (
                    input::finals_from_json(v.get("finals").unwrap_or(&v))
                        .unwrap_or_else(|e| usage(&e)),
                    v.get("final_slot").and_then(|x| x.as_u64()).unwrap_or(0),
                )
            }
            (None, Some(u)) => {
                // Every program account of the season, not only those the
                // archive's transactions wrote (integ-W4 review).
                let mut keys = input::written_keys(&txs);
                match rt.block_on(input::program_accounts(u, &program, season_id)) {
                    Ok(v) => {
                        for k in v {
                            if !keys.contains(&k) {
                                keys.push(k);
                            }
                        }
                    }
                    Err(e) => eprintln!(
                        "frontier-verify: getProgramAccounts failed ({e}): only the archive's written accounts are read"
                    ),
                }
                rt.block_on(input::fetch_finals(u, &keys))
                    .unwrap_or_else(|e| usage(&e))
            }
            (None, None) => usage("--finals or --rpc is required with --archive"),
        };
        // V2's `.so` hash from the ProgramData account (integ-W4 review).
        let program_hashes = match &rpc {
            Some(u) => match rt.block_on(input::program_hash(u, &program)) {
                Ok((slot, h)) => vec![(slot, h)],
                Err(e) => {
                    eprintln!("frontier-verify: the deployed .so hash: {e}");
                    vec![]
                }
            },
            None => vec![],
        };
        // ⑳ V28: the resident program's feed, from the same local node, read
        // after the Frontier transactions (one ledger order). Only a local
        // node's feed gives that order; elsewhere V28's holder stays
        // UNVERIFIABLE.
        let resident_feed = match (&resident_program, &resident_archive, &rpc, localnet) {
            (None, None, _, _) => None,
            // The resident program's findex archive (⑲'s per-program
            // archive): one ledger with the Frontier input when both carry
            // `ledger <runId>`; the policy account from --rpc when given.
            (Some(r), Some(d), _, _) => {
                let rp = r
                    .parse()
                    .unwrap_or_else(|_| usage("bad --resident-program"));
                let policy = fclient::addr::resident_policy(&program);
                let policies = match &rpc {
                    Some(u) => rt
                        .block_on(input::fetch_finals(u, &[policy]))
                        .map(|(m, _)| m.into_iter().filter_map(|(k, a)| Some((k, a?))).collect())
                        .unwrap_or_default(),
                    None => Default::default(),
                };
                let mut f = verify_core::resident_feed::ResidentFeed::from_archive(d, rp, policies)
                    .unwrap_or_else(|e| usage(&e));
                // ⑲: checked against the node's ledger when one is given.
                if let Some(u) = &rpc {
                    f.history = rt
                        .block_on(input::confirm_archive(d, u, f.history))
                        .unwrap_or_else(|e| usage(&e));
                }
                Some(f)
            }
            (Some(r), None, Some(u), true) => {
                let rp = r
                    .parse()
                    .unwrap_or_else(|_| usage("bad --resident-program"));
                let policy = fclient::addr::resident_policy(&program);
                Some(
                    rt.block_on(verify_core::resident_feed::fetch(u, &rp, &policy, &txs))
                        .unwrap_or_else(|e| usage(&e)),
                )
            }
            _ => usage("--resident-program needs --resident-archive DIR, or --rpc URL --localnet"),
        };
        // ⑲: everything is read; a history read through the ledger point the
        // node is still at was read at the final states' point. Otherwise
        // `point_in_time_unverified` stays (never PASS).
        let mut history = history;
        let mut resident_feed = resident_feed;
        if let Some(u) = &rpc {
            rt.block_on(input::seal_point_in_time(u, &mut history));
            if let Some(f) = resident_feed.as_mut() {
                rt.block_on(input::seal_point_in_time(u, &mut f.history));
            }
        }
        // VG's witness: each transaction's pre/post balances and the
        // upgrade authority, read from the same RPC (`--balances`).
        let chain = match (&rpc, balances) {
            (Some(u), true) => rt
                .block_on(input::fetch_chain(u, &program, &txs))
                .unwrap_or_else(|e| usage(&e)),
            (None, true) => usage("--balances needs --rpc"),
            _ => Default::default(),
        };
        // rent-live-rest: the cluster's Rent sysvar for VX's / VG's
        // re-execution — the finals file's, else read over RPC at the final
        // states' slot. Unread: said here and in the report (5,080 assumed).
        let mut chain = chain;
        chain.rent = match (finals_rent, &rpc) {
            (Some(r), _) => Some(r),
            (None, Some(u)) => match rt.block_on(input::fetch_rent(u, final_slot)) {
                Ok(r) => Some(r),
                Err(e) => {
                    eprintln!("frontier-verify: the cluster's Rent sysvar: {e}");
                    None
                }
            },
            (None, None) => None,
        };
        // verifier-v0v1: VT's lookup tables (every table a v0 transaction
        // names), read with the final states at their slot; a finals file's
        // own. Unread: VT says UNVERIFIABLE for their lookups (never PASS).
        let table_keys = input::lookup_table_keys(&txs);
        chain.lookup_tables = match (finals_tables, &rpc) {
            (Some(t), _) => Some(t),
            _ if table_keys.is_empty() => None,
            (None, Some(u)) => {
                match rt.block_on(input::fetch_lookup_tables(u, &table_keys, final_slot)) {
                    Ok(t) => Some(t),
                    Err(e) => {
                        eprintln!("frontier-verify: the lookup tables: {e}");
                        None
                    }
                }
            }
            (None, None) => None,
        };
        // verifier-alt-archive (F2): the archive's snapshots of each lookup
        // table (taken at its first use), a finals file's, and — for a table
        // closed at the pinned read — its own create / extend transactions
        // read from the RPC. VT consults them only where the pinned read
        // settles nothing.
        let mut snaps = finals_snaps;
        if let Some(d) = &archive {
            snaps.extend(input::archive_lookup_snapshots(d).unwrap_or_else(|e| usage(&e)));
        }
        if let (Some(u), Some(t)) = (&rpc, &chain.lookup_tables) {
            snaps.extend(rt.block_on(input::fetch_closed_table_histories(u, t)));
        }
        chain.lookup_snapshots = snaps;
        // ⑰ Q-P1 (b): the second source(s), read after everything else
        // (VS, witness.rs). Not for a local node's ledger feed (its history
        // has its own rule).
        match (&rpc, witnesses.is_empty(), localnet) {
            (_, true, _) => {}
            (Some(u), false, false) => {
                let keys: Vec<solana_address::Address> = finals
                    .keys()
                    .map(|k| solana_address::Address::new_from_array(*k))
                    .collect();
                let c = rt.block_on(verify_core::witness::cross_check(
                    u,
                    &witnesses,
                    &program,
                    season_id,
                    &txs,
                    &keys,
                    final_slot,
                    &verify_core::witness::TableAsk::of(&txs, &chain.lookup_snapshots),
                ));
                for w in &c.witnesses {
                    eprintln!(
                        "frontier-verify: witness {}: {} signatures listed, {} transactions served, {} blocks, {} final states, {} read errors",
                        w.url,
                        w.signatures.as_ref().map_or(0, |s| s.len()),
                        w.txs.values().filter(|t| t.is_some()).count(),
                        w.blocks.values().filter(|b| b.is_some()).count(),
                        w.finals.len(),
                        w.errors.len()
                    );
                }
                chain.cross = Some(c);
            }
            (None, false, _) => usage("--witness needs --rpc (the primary)"),
            (Some(_), false, true) => {
                usage("--witness is for a public-RPC history, not --localnet's ledger feed")
            }
        }
        Input {
            cfg: Config {
                program,
                season_id,
                quicknet_pk: quicknet(),
                ruleset_hash: frontier_abi::presets::RULESET_HASH,
                program_hash: None,
            },
            txs,
            finals,
            final_slot,
            program_hashes,
            provenance: archive
                .map(|d| format!("archive {}", d.display()))
                .unwrap_or_else(|| format!("rpc {}", rpc.clone().unwrap_or_default())),
            scenarios: vec![],
            history,
            resident_feed,
            program_so: None,
            declared: vec![],
            chain,
        }
    };
    // A fixture carries its own trust roots; say so when the operator did
    // not pin them (integ-W4 review, W4-D minor).
    if from_fixture && pk.is_none() {
        eprintln!("frontier-verify: warning: the drand key is the fixture's own (pass --test-key or --quicknet-pk to pin it)");
    }
    if from_fixture && ruleset.is_none() {
        eprintln!("frontier-verify: warning: the ruleset hash is the fixture's own (pass --ruleset to pin it)");
    }
    if let Some(k) = pk {
        inp.cfg.quicknet_pk = k;
    }
    if let Some(h) = ruleset {
        inp.cfg.ruleset_hash = h;
    }
    if program_hash.is_some() {
        inp.cfg.program_hash = program_hash;
    }
    // rent-live-rest: a declared rate fills in an unread one; one that
    // disagrees with the chain's is refused (never two rates for one season).
    if let Some(n) = lamports_per_byte {
        match inp.chain.rent.as_ref().filter(|r| !r.declared) {
            Some(r) if r.lamports_per_byte() != Some(n) => usage(&format!(
                "--lamports-per-byte {n} disagrees with the cluster's Rent sysvar ({:?} lamports per byte)",
                r.lamports_per_byte()
            )),
            Some(_) => {}
            None => inp.chain.rent = Some(input::RentRead::declared(n)),
        }
    }
    if let Some(p) = &program_so {
        let (r, basis) = verify_core::rent::rent_of(&inp);
        eprintln!(
            "frontier-verify: VX/VG re-execute at {} lamports per byte ({})",
            verify_core::rent::rent_per_byte(&r)
                .map_or("a non-whole rate".to_string(), |n| n.to_string()),
            match basis {
                verify_core::rent::RentBasis::Assumed =>
                    "ASSUMED: no Rent sysvar was read; pass --rpc or --lamports-per-byte",
                b => b.name(),
            }
        );
        let raw = std::fs::read(p).unwrap_or_else(|e| usage(&format!("{}: {e}", p.display())));
        let so = if raw.starts_with(&[0x1f, 0x8b]) {
            use std::io::Read;
            let mut out = vec![];
            flate2::read::GzDecoder::new(&raw[..])
                .read_to_end(&mut out)
                .unwrap_or_else(|e| usage(&format!("{}: {e}", p.display())));
            out
        } else {
            raw
        };
        inp.program_so = Some(std::sync::Arc::new(so));
    }
    for (u, n, busy) in verify_core::input::rpc_calls() {
        eprintln!("frontier-verify: {u}: {n} RPC requests ({busy} answered 429/503)");
    }
    if let Some(p) = &save {
        if let Err(e) = inp.save(p) {
            eprintln!(
                "frontier-verify: cannot save the input to {}: {e}",
                p.display()
            );
            std::process::exit(verify_core::EXIT_UNVERIFIABLE);
        }
        eprintln!(
            "frontier-verify: saved the input ({} transactions) to {}",
            inp.txs.len(),
            p.display()
        );
    }
    if tamper {
        let rep = match &fallback {
            Some(dir) => {
                let fx = verify_core::tamper::committed_fixtures(dir).unwrap_or_else(|e| usage(&e));
                verify_core::tamper::run_suite_with_fixtures(&inp, &fx, jobs)
            }
            None => verify_core::tamper::run_suite(&inp, jobs),
        };
        let j = serde_json::to_string_pretty(&rep.json()).unwrap_or_default();
        if let Err(e) = std::fs::create_dir_all(&out)
            .and_then(|_| std::fs::write(out.join("tamper.json"), &j))
            .and_then(|_| std::fs::write(out.join("tamper.md"), rep.markdown()))
        {
            eprintln!(
                "frontier-verify: cannot write the tamper report to {}: {e}",
                out.display()
            );
            std::process::exit(verify_core::EXIT_UNVERIFIABLE);
        }
        if json {
            println!("{j}");
        } else {
            print!("{}", rep.markdown());
        }
        std::process::exit(if strict {
            rep.exit_code_strict()
        } else {
            rep.exit_code()
        });
    }
    let r = verify_core::verify(&inp);
    if let Err(e) = std::fs::create_dir_all(&out)
        .and_then(|_| {
            std::fs::write(
                out.join("report.json"),
                serde_json::to_string_pretty(&r.json()).unwrap_or_default(),
            )
        })
        .and_then(|_| std::fs::write(out.join("report.md"), r.markdown()))
    {
        eprintln!(
            "frontier-verify: cannot write the report to {}: {e}",
            out.display()
        );
        // A report that cannot be written is not a verification (integ-W4
        // review, W4-D minor).
        std::process::exit(verify_core::EXIT_UNVERIFIABLE);
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&r.json()).unwrap_or_default()
        );
    } else {
        print!("{}", r.markdown());
    }
    std::process::exit(verify_core::exit_code(r.verdict));
}
