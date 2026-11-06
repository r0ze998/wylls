//! `runexec`: the operator's tool over a run store, and a demo against the
//! simulated world (MOCK). There is no adapter to the real chain yet: the
//! executor loop runs only against `sim` (`README.ja.md`, 実チェーン: 未実行).
//!
//! ```text
//! runexec demo   --db <path> [--scenario happy|lost-response|crash|raid]
//! runexec status --db <path> [--slot <n>]
//! runexec show   --db <path> --run <id>
//! runexec cancel --db <path> --run <id>
//! runexec resume --db <path> --run <id>
//!
//! # Agent acts (workstreams 03, 05, 13): machine-readable, one JSON line on stdout
//! runexec act register --db <path> --agent <id> --key <idempotencyKey> --source ai|mcp|browser|resident [--run <callerRunId>] [--slot <n>]
//! runexec act status   --db <path> (--run4 <id> | --agent <id> --key <key>) [--gateway <loopback port> [--bridge]]
//! runexec act list     --db <path> --run <callerRunId>
//! ```
//!
//! `act` exit codes: 0 ok; 2 bad request; 3 no record (never registered);
//! 4 conflict (the key is registered for another source or caller run);
//! 1 store error. On failure stdout is `{"error": code, "message": …}`.
//! `status` with `--gateway` reads the agent wallet's
//! `GET /f/agent/fate` on 127.0.0.1 (`--bridge`: the test bridge's `/fate`)
//! once and records it; without it, answers from the store. It never sends.
//!
//! ```text
//! # Runs (workstream 06's cargo-only delivery, 13's execution port): one JSON line on stdout
//! runexec run accept --db <path> --spec <file.json | -> [--slot <n>]
//! runexec run view   --db <path> --run <id>
//! ```
//!
//! `run accept` reads one `RunSpec` (`model.rs`; `-`: stdin), checks it as
//! the executor's `accept` does, and stores it under its `run_id`:
//! `accept` is `Created`, or `Existing` (`replayed: true`) for the same spec
//! again, which writes nothing. The same id with another spec is exit 4
//! `Conflict`. A malformed spec or option is refused before the store is
//! opened. Accepting **stores a request**: nothing is signed or sent, and
//! `sent` / `settled` in the answer are false until the executor confirms a
//! send or a settlement canonically. `run view` prints the persisted run
//! (state, held reason, cancel phase, spec, detail, outcome, fees,
//! transitions, attempts, receipts), all read in one snapshot. It only
//! reads: the store is opened read-only, never created, and no schema
//! statement runs. Exit 3 `NoRecord` only when an opened run store holds
//! no run of that id; exit 5 `StoreUnavailable` when there is no store at
//! the path or it cannot be reached; exit 1 `StoreError` when a present
//! store cannot be read or is not a run store. Neither 5 nor 1 says
//! anything about the run: a caller must not take them for "never
//! accepted" or "not sent" (no resend on them). `--spec` is read with a
//! bound of 1 MiB. Exit codes 0–4 as `act`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use runexec::executor::{CrashPlan, Executor};
use runexec::model::*;
use runexec::sim::{SendFault, Sim, SimWorld};
use runexec::store::{Accept, Store};
use runexec::view::run_view;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// One `act` failure: (exit code, machine code, message).
type ActErr = (u8, &'static str, String);

fn act(args: &[String], db: &Path) -> Result<serde_json::Value, ActErr> {
    use runexec::acts;
    let bad = |m: &str| (2u8, "BadRequest", m.to_string());
    let store = Store::open(db).map_err(|e| (1, "StoreError", e))?;
    let need = |n: &str| arg(args, n).ok_or_else(|| bad(&format!("{n} is required")));
    match args.get(2).map(String::as_str) {
        Some("register") => {
            let agent = need("--agent")?;
            let key = need("--key")?;
            let source = need("--source")?;
            let run = arg(args, "--run");
            let slot = arg(args, "--slot")
                .and_then(|x| x.parse().ok())
                .unwrap_or(0);
            if !acts::SOURCES.contains(&source.as_str()) {
                return Err(bad(&format!(
                    "--source must be one of {}",
                    acts::SOURCES.join(", ")
                )));
            }
            let id = acts::register(&store, &agent, &key, &source, run.as_deref(), slot).map_err(
                |e| {
                    if e.contains("is registered for") {
                        (4, "Conflict", e)
                    } else {
                        bad(&e)
                    }
                },
            )?;
            acts::receipt(&store, &id).map_err(|e| (1, "StoreError", e))
        }
        Some("status") => {
            let id = match arg(args, "--run4") {
                Some(i) => i,
                None => acts::run4_id(&need("--agent")?, &need("--key")?),
            };
            if acts::get(&store, &id)
                .map_err(|e| (1, "StoreError", e))?
                .is_none()
            {
                return Err((3, "NoRecord", format!("no act {id} is registered")));
            }
            match arg(args, "--gateway") {
                Some(p) => {
                    let port: u16 = p
                        .parse()
                        .map_err(|_| bad("--gateway is a loopback port number"))?;
                    let reader = acts::HttpFateReader {
                        port,
                        gateway_path: !args.iter().any(|a| a == "--bridge"),
                    };
                    acts::refresh(&store, &reader, &id).map_err(|e| (1, "StoreError", e))
                }
                None => acts::receipt(&store, &id).map_err(|e| (1, "StoreError", e)),
            }
        }
        Some("list") => {
            let run = need("--run")?;
            let rows = acts::by_ext_run(&store, &run).map_err(|e| (1, "StoreError", e))?;
            let out: Result<Vec<_>, _> = rows
                .iter()
                .map(|r| acts::receipt(&store, &r.run4_id))
                .collect();
            out.map(|v| serde_json::json!({ "runId": run, "acts": v }))
                .map_err(|e| (1, "StoreError", e))
        }
        _ => Err(bad("act register | status | list")),
    }
}

/// The most a `--spec` may be, in bytes (file or stdin), read with a
/// bound so an oversized or endless input is refused before anything is
/// kept in memory beyond this. A `RunSpec` is a few hundred bytes.
const MAX_SPEC_BYTES: usize = 1 << 20;

/// Reads at most [`MAX_SPEC_BYTES`] from `r` (one byte more, to tell
/// "too large" from "exactly the limit"); refuses larger input and
/// input that is not UTF-8.
fn read_bounded(r: impl std::io::Read, what: &str) -> Result<String, String> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(4096);
    r.take(MAX_SPEC_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read --spec {what}: {e}"))?;
    if buf.len() > MAX_SPEC_BYTES {
        return Err(format!(
            "--spec {what} is larger than {MAX_SPEC_BYTES} bytes (1 MiB)"
        ));
    }
    String::from_utf8(buf).map_err(|e| format!("--spec {what} is not UTF-8: {e}"))
}

/// The `run` subcommand's options, read strictly: every token after the
/// verb is one of `allowed`, followed by one value, given at most once.
/// Nothing is read or written before this passes.
fn run_opts(args: &[String], allowed: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let mut i = 3;
    while i < args.len() {
        let k = &args[i];
        if !allowed.contains(&k.as_str()) {
            return Err(format!(
                "unknown option {k}; the options are {}",
                allowed.join(", ")
            ));
        }
        let Some(v) = args.get(i + 1) else {
            return Err(format!("{k} needs a value"));
        };
        if out.insert(k.clone(), v.clone()).is_some() {
            return Err(format!("{k} is given twice"));
        }
        i += 2;
    }
    Ok(out)
}

/// The spec fields that are omitted from its JSON when absent
/// (`skip_serializing_if` in `model.rs`), so an explicit `null` for them is
/// the same spec. Only these may be null and missing from the round trip.
const OMITTED_WHEN_ABSENT: [&str; 1] = ["facility"];

/// The first key of `input` the spec has no field for, as a path (`ship.dst.x`).
/// A misspelt `facility` would otherwise silently make a cargo-only run.
/// A `null` is allowed only for [`OMITTED_WHEN_ABSENT`]; any other member
/// the round trip does not have, null or not, at any depth, is unknown.
fn unknown_key(input: &serde_json::Value, canon: &serde_json::Value, path: &str) -> Option<String> {
    let (Some(i), Some(c)) = (input.as_object(), canon.as_object()) else {
        return None;
    };
    for (k, v) in i {
        let p = if path.is_empty() {
            k.clone()
        } else {
            format!("{path}.{k}")
        };
        match c.get(k) {
            None if v.is_null() && OMITTED_WHEN_ABSENT.contains(&p.as_str()) => {}
            None => return Some(p),
            Some(cv) => {
                if let Some(x) = unknown_key(v, cv, &p) {
                    return Some(x);
                }
            }
        }
    }
    None
}

/// The first member name given twice in one JSON object, as a path.
/// serde_json keeps the last of two members with one name, so
/// `{"run_id": "a", …, "run_id": "b"}` would otherwise be accepted as run
/// `b`. `text` is already known to be well-formed JSON; names are compared
/// decoded (a name written with a JSON escape is the same name).
fn duplicate_member(text: &str) -> Option<String> {
    enum Frame {
        Object {
            seen: std::collections::BTreeSet<String>,
            key: Option<String>,
            expect_key: bool,
        },
        Array(usize),
    }
    let path = |stack: &[Frame], last: &str| -> String {
        let mut parts: Vec<String> = stack
            .iter()
            .filter_map(|f| match f {
                Frame::Object { key, .. } => key.clone(),
                Frame::Array(n) => Some(format!("[{n}]")),
            })
            .collect();
        parts.push(last.to_string());
        parts.join(".")
    };
    let b = text.as_bytes();
    let mut stack: Vec<Frame> = vec![];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => stack.push(Frame::Object {
                seen: Default::default(),
                key: None,
                expect_key: true,
            }),
            b'[' => stack.push(Frame::Array(0)),
            b'}' | b']' => {
                stack.pop();
            }
            b',' => match stack.last_mut() {
                Some(Frame::Object { expect_key, .. }) => *expect_key = true,
                Some(Frame::Array(n)) => *n += 1,
                None => {}
            },
            b'"' => {
                let start = i;
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                let raw = &text[start..(i + 1).min(b.len())];
                let is_key = matches!(
                    stack.last(),
                    Some(Frame::Object {
                        expect_key: true,
                        ..
                    })
                );
                if is_key {
                    let name: String =
                        serde_json::from_str(raw).unwrap_or_else(|_| raw.to_string());
                    let parents = stack.len() - 1;
                    let p = path(&stack[..parents], &name);
                    if let Some(Frame::Object {
                        seen,
                        key,
                        expect_key,
                    }) = stack.last_mut()
                    {
                        if !seen.insert(name.clone()) {
                            return Some(p);
                        }
                        *key = Some(name);
                        *expect_key = false;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Reads and checks a `RunSpec` from a file (`-`: stdin). Every refusal is a
/// bad request; the store is not touched here.
fn read_spec(path: &str) -> Result<RunSpec, String> {
    let text = if path == "-" {
        read_bounded(std::io::stdin().lock(), "from stdin")?
    } else {
        let f = std::fs::File::open(path).map_err(|e| format!("cannot read --spec {path}: {e}"))?;
        read_bounded(f, path)?
    };
    let input: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("--spec is not JSON: {e}"))?;
    if !input.is_object() {
        return Err("--spec must be a JSON object (a RunSpec)".into());
    }
    if let Some(k) = duplicate_member(&text) {
        return Err(format!("--spec gives the member {k} twice"));
    }
    let spec: RunSpec = serde_json::from_value(input.clone())
        .map_err(|e| format!("--spec is not a RunSpec: {e}"))?;
    let canon = serde_json::to_value(&spec).map_err(|e| e.to_string())?;
    if let Some(k) = unknown_key(&input, &canon, "") {
        return Err(format!("--spec has a field no RunSpec has: {k}"));
    }
    if spec.run_id.is_empty() || spec.run_id.len() > 128 {
        return Err("run_id (the idempotency key) must be 1..=128 bytes".into());
    }
    runexec::executor::validate_spec(&spec)?;
    Ok(spec)
}

fn run(args: &[String]) -> Result<serde_json::Value, ActErr> {
    let bad = |m: String| (2u8, "BadRequest", m);
    let store_err = |m: String| (1u8, "StoreError", m);
    let verb = args.get(2).map(String::as_str);
    let allowed: &[&str] = match verb {
        Some("accept") => &["--db", "--spec", "--slot"][..],
        Some("view") => &["--db", "--run"][..],
        _ => return Err(bad("run accept | view".into())),
    };
    let opts = run_opts(args, allowed).map_err(bad)?;
    let need = |n: &str| {
        opts.get(n)
            .cloned()
            .ok_or_else(|| bad(format!("{n} is required")))
    };
    let db = PathBuf::from(need("--db")?);
    match verb {
        Some("accept") => {
            // The store keeps slots in SQLite integers (i64): a larger
            // value would be stored as another number.
            let slot: u64 = match opts.get("--slot") {
                None => 0,
                Some(s) => s
                    .parse()
                    .ok()
                    .filter(|n| *n <= i64::MAX as u64)
                    .ok_or_else(|| bad(format!("--slot is a slot number 0..={}", i64::MAX)))?,
            };
            // Everything that can be wrong with the input is found before
            // the store is opened or written.
            let spec = read_spec(&need("--spec")?).map_err(bad)?;
            let store = Store::open(&db).map_err(store_err)?;
            let (accept, replayed) = match store.accept(&spec, slot).map_err(store_err)? {
                Accept::Created => ("Created", false),
                Accept::Existing(_) => ("Existing", true),
                Accept::Conflict => {
                    let stored = store
                        .load(&spec.run_id)
                        .map_err(store_err)?
                        .map(|r| r.spec.digest())
                        .unwrap_or_default();
                    return Err((
                        4,
                        "Conflict",
                        format!(
                            "run {} is accepted with another spec (stored digest {stored}, this spec {}); another spec needs another run_id",
                            spec.run_id,
                            spec.digest()
                        ),
                    ));
                }
            };
            let mut v = run_view(&store, &spec.run_id)
                .map_err(store_err)?
                .ok_or_else(|| store_err(format!("run {} was not recorded", spec.run_id)))?;
            v["accept"] = serde_json::json!(accept);
            v["replayed"] = serde_json::json!(replayed);
            Ok(v)
        }
        Some("view") => {
            let id = need("--run")?;
            // Reading only: no store is created, no schema statement runs.
            // A store that cannot be reached is no answer about the run: a
            // deleted, unmounted or wrongly named store does not show that
            // nothing was accepted (and maybe sent) there. `NoRecord` is
            // said only by a run store that was opened and read.
            match std::fs::metadata(&db) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err((
                        5,
                        "StoreUnavailable",
                        format!(
                            "there is no store at {}: nothing is known about run {id} (not evidence that it was never accepted or sent)",
                            db.display()
                        ),
                    ));
                }
                Err(e) => return Err((
                    5,
                    "StoreUnavailable",
                    format!(
                        "the store at {} cannot be reached ({e}): nothing is known about run {id}",
                        db.display()
                    ),
                )),
                Ok(_) => {}
            }
            let store = Store::open_read_only(&db).map_err(store_err)?;
            run_view(&store, &id).map_err(store_err)?.ok_or_else(|| {
                (
                    3,
                    "NoRecord",
                    format!("no run {id} is accepted in the store at {}", db.display()),
                )
            })
        }
        _ => unreachable!("verb checked above"),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("run") {
        return match run(&args) {
            Ok(v) => {
                println!("{v}");
                ExitCode::SUCCESS
            }
            Err((code, name, message)) => {
                println!(
                    "{}",
                    serde_json::json!({ "error": name, "message": message })
                );
                ExitCode::from(code)
            }
        };
    }
    if args.get(1).map(String::as_str) == Some("act") {
        let Some(db) = arg(&args, "--db").map(PathBuf::from) else {
            println!(
                "{}",
                serde_json::json!({ "error": "BadRequest", "message": "--db <path> is required" })
            );
            return ExitCode::from(2);
        };
        return match act(&args, &db) {
            Ok(v) => {
                println!("{v}");
                ExitCode::SUCCESS
            }
            Err((code, name, message)) => {
                println!(
                    "{}",
                    serde_json::json!({ "error": name, "message": message })
                );
                ExitCode::from(code)
            }
        };
    }
    let Some(cmd) = args.get(1).map(String::as_str) else {
        eprintln!("usage: runexec demo|status|show|cancel|resume --db <path> [...] | runexec act … | runexec run accept|view …");
        return ExitCode::from(2);
    };
    let Some(db) = arg(&args, "--db").map(PathBuf::from) else {
        eprintln!("--db <path> is required");
        return ExitCode::from(2);
    };
    let r = match cmd {
        "demo" => demo(&db, arg(&args, "--scenario").as_deref().unwrap_or("happy")),
        "status" => Store::open(&db).and_then(|s| {
            let slot = arg(&args, "--slot")
                .and_then(|x| x.parse().ok())
                .unwrap_or(0);
            println!(
                "{}",
                serde_json::to_string_pretty(&s.status(slot)?).unwrap()
            );
            Ok(())
        }),
        "show" => with_run(&args, &db, show),
        "cancel" => with_run(&args, &db, |s, id| {
            let st = s.request_cancel(id)?.ok_or("no such run")?;
            println!(
                "cancel requested; {id} is {} (a send in flight is decided first; in transit nothing can be recalled)",
                st.name()
            );
            Ok(())
        }),
        "resume" => with_run(&args, &db, |s, id| {
            if s.resume(id)? {
                println!("{id} resumed");
            } else {
                println!("{id} was not held");
            }
            Ok(())
        }),
        _ => Err(format!("unknown command {cmd}")),
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn with_run(
    args: &[String],
    db: &Path,
    f: impl FnOnce(&Store, &str) -> Result<(), String>,
) -> Result<(), String> {
    let id = arg(args, "--run").ok_or("--run <id> is required")?;
    let s = Store::open(db)?;
    f(&s, &id)
}

fn show(s: &Store, id: &str) -> Result<(), String> {
    let r = s.load(id)?.ok_or("no such run")?;
    println!(
        "run {id}: {} (version {}, held {:?}, cancel {})",
        r.state.name(),
        r.version,
        r.held,
        r.cancel_requested
    );
    println!("detail: {}", serde_json::to_string(&r.detail).unwrap());
    // A cancel is shown by phase: stopping new requests, waiting for
    // signed requests, completed (with what landed before), or too late.
    if let Some(c) = r.cancel_phase() {
        println!("cancel: {}", serde_json::to_string(&c).unwrap());
    }
    // Fees by what is known: reserved (may land), charged (reported),
    // unconfirmed (landed or may land failed, fee not reported), released.
    println!("fees: {}", serde_json::to_string(&s.fees(id)?).unwrap());
    let (own, res, back) = ownership(r.state);
    println!("owns: {own}\nreserved: {res}\ngives back: {back}");
    println!("transitions:");
    for (from, to, by, why) in s.history(id)? {
        println!("  {from} → {to}  [{by}] {why}");
    }
    for step in [runexec::store::Step::Facility, runexec::store::Step::Ship] {
        for a in s.attempts(id, step)? {
            println!(
                "attempt {:?} {} {} valid≤{} {}",
                step,
                a.request_key,
                &a.prepared.sig[..12],
                a.prepared.valid_until,
                a.status
            );
        }
    }
    println!("receipts (evidence of past events, not of current stock):");
    for rc in s.receipts(id)? {
        println!(
            "  {} {} @{} from {}",
            rc.kind, rc.subject, rc.slot, rc.source
        );
    }
    Ok(())
}

/// A scripted run against the simulated world. Prints `MOCK` so nobody
/// mistakes it for a chain run.
fn demo(db: &Path, scenario: &str) -> Result<(), String> {
    use frontier_abi::v2::layout::s1::place::{KIND_HOLDING, KIND_VAULT};
    println!("MOCK: simulated canonical world (no chain, no ② rights service)");
    let p = |kind, p, q, at| PlaceRef {
        kind,
        p,
        q,
        at,
        gen: 1,
    };
    let (stock, fac, dst, home) = (
        p(KIND_HOLDING, 0, 0, 1),
        FacilityRef {
            place: p(KIND_HOLDING, 0, 1, 2),
            recipe: 1,
        },
        p(KIND_VAULT, 1, 0, 5),
        p(KIND_HOLDING, 3, 3, 1),
    );
    let one = |i: usize, n: u64| {
        let mut x = ZERO;
        x[i] = n;
        x
    };
    let mut w = SimWorld::new();
    w.add_place(stock, 0x77, one(1, 10), None);
    w.add_place(fac.place, 0x99, ZERO, None);
    w.add_place(dst, 0x77, ZERO, Some(1_000));
    w.add_place(home, 0x55, ZERO, None);
    w.grant(0x77, fac, 5, 10_000);
    match scenario {
        "lost-response" => {
            w.faults.send.push_back(SendFault::LoseResponse);
            w.faults.send.push_back(SendFault::LoseResponse);
        }
        "happy" | "crash" | "raid" => {}
        s => return Err(format!("unknown scenario {s}")),
    }
    let sim = Sim::new(w);
    let open = || -> Result<Executor<Sim, Sim>, String> {
        Ok(Executor::new(
            "demo",
            Store::open(db)?,
            sim.clone(),
            sim.clone(),
        ))
    };
    let mut ex = open()?;
    if scenario == "crash" {
        ex.crash = Some(CrashPlan::at("ship.after_send", 1));
    }
    let spec = RunSpec {
        run_id: format!("demo-{scenario}"),
        owner: 0x77,
        stock,
        inbound: None,
        facility: Some(fac),
        inputs: one(1, 5),
        outputs: one(6, 3),
        rights_units: 1,
        ship: ShipSpec {
            dst,
            cargo: one(6, 3),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    };
    println!("accept: {:?}", ex.accept(&spec)?);
    let id = spec.run_id.clone();
    for _ in 0..120 {
        let row = ex.store.load(&id)?.ok_or("vanished")?;
        if row.state.terminal() || row.held.is_some() {
            break;
        }
        if scenario == "raid" && row.state == RunState::InTransit && row.detail.raid.is_none() {
            let key = CaravanKey {
                owner: 0x77,
                seq: row.detail.ship_seq.unwrap(),
            };
            if sim.with(|w| {
                w.caravans
                    .get(&(key.owner, key.seq))
                    .is_some_and(|c| c.owner_now == 0x77)
            }) {
                sim.with(|w| w.raid(key, true, 0x55, home));
                println!("MOCK: the caravan {} is raided (take)", key.text());
            }
        }
        if let Err(h) = ex.tick() {
            println!("stopped: {h:?}; restarting the executor on the same store");
            ex = open()?;
        }
        sim.with(|w| w.advance(1));
    }
    show(&ex.store, &id)?;
    sim.with(|w| w.audit())?;
    println!("MOCK audit: conservation and once-only effects hold");
    let slot = sim.with(|w| w.slot);
    println!(
        "{}",
        serde_json::to_string_pretty(&ex.store.status(slot)?).unwrap()
    );
    Ok(())
}
