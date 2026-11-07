//! The verifier and where its transactions came from (`history`, ⑲): a
//! history that no source showed to be complete (public RPC in any coverage
//! state, `cross_checked` included; an archive whose source is unknown or
//! whose cursor predates coverage) is never PASS, and FAIL only on a FAIL
//! decided inside fetched transactions (⑪'s list: V0 but its lengths, V27,
//! ⑳'s V9 joins). Default settings (no origin anchor, no witness), a
//! witness behind or down, a gap, and a resume from an older cursor are
//! each checked, on the verdict rule alone and through the verifier's body
//! over committed recorded fixtures with ranges cut out. `report.json`
//! carries the meaning for its readers (`history.complete` is never `true`).
//!
//! No keypair is generated, derived (fixed seed included) or used to sign:
//! the JSON-RPC node is a stand-in over a plain socket, signatures are fixed
//! byte patterns, the fixtures are read from disk, and the one edited
//! transaction keeps its recorded signature. The checks compute PDA and
//! seed addresses (allowed, 2026-11-06).

use std::sync::{Arc, Mutex};

use fclient::ports::{Signature, TxRecord};
use findex::ingest::reason;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use verify_core::codes::HISTORY_UNPROVEN;
use verify_core::history::{apply, History, Source};
use verify_core::input::{self, Config, Input};
use verify_core::{Counts, Finding, Liveness, Report, Severity, Verdict};

// ------------------------------------------------------------ stand-in node

/// A node: its whole history, signatures oldest first with their slots.
#[derive(Clone, Default)]
struct Node {
    txs: Arc<Mutex<Vec<(String, u64)>>>,
}

fn answer(n: &Node, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let all = n.txs.lock().unwrap().clone();
    let result = match req.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "frontier_feed" => json!([]),
        "getTransaction" => {
            let sig = p.get(0).and_then(|x| x.as_str()).unwrap_or("");
            match all.iter().find(|(s, _)| s == sig) {
                None => Value::Null,
                Some((_, slot)) => json!({"slot": slot, "blockTime": 7,
                    "transaction": ["AQID", "base64"],
                    "meta": {"err": null, "fee": 5000, "logMessages": [], "computeUnitsConsumed": 9}}),
            }
        }
        "getSignaturesForAddress" => {
            let cfg = p.get(1).cloned().unwrap_or(json!({}));
            let limit = cfg.get("limit").and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let mut newest: Vec<&(String, u64)> = all.iter().rev().collect();
            if let Some(b) = cfg.get("before").and_then(|x| x.as_str()) {
                let i = newest
                    .iter()
                    .position(|(s, _)| s == b)
                    .map_or(newest.len(), |i| i + 1);
                newest = newest.split_off(i);
            }
            if let Some(u) = cfg.get("until").and_then(|x| x.as_str()) {
                if let Some(i) = newest.iter().position(|(s, _)| s == u) {
                    newest.truncate(i);
                }
            }
            json!(newest
                .iter()
                .take(limit)
                .map(|(s, slot)| json!({"signature": s, "slot": slot, "err": null, "blockTime": 0}))
                .collect::<Vec<_>>())
        }
        _ => Value::Null,
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// One HTTP/1.1 exchange per connection (`Connection: close`).
async fn serve_one(n: Node, mut s: tokio::net::TcpStream) {
    let mut buf = vec![];
    let mut chunk = [0u8; 4096];
    let body = loop {
        let Ok(k) = s.read(&mut chunk).await else {
            return;
        };
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
    let out = answer(&n, &req).to_string();
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
        out.len()
    );
    let _ = s.write_all(resp.as_bytes()).await;
    let _ = s.shutdown().await;
}

async fn node(slots: &[u8]) -> (Node, String) {
    let n = Node::default();
    put(&n, slots);
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    let m = n.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(serve_one(m.clone(), s));
        }
    });
    (n, format!("http://{addr}"))
}

fn put(n: &Node, slots: &[u8]) {
    let mut t = n.txs.lock().unwrap();
    t.clear();
    t.extend(slots.iter().map(|&i| (sig(i).to_string(), i as u64)));
}

fn sig(i: u8) -> Signature {
    Signature::from([i; 64])
}

fn program() -> Address {
    Address::new_from_array([1; 32])
}

fn dead_url() -> String {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let a = l.local_addr().unwrap();
    drop(l);
    format!("http://{a}")
}

fn tmp(name: &str) -> std::path::PathBuf {
    // Tests run in parallel and several build the same named archives.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let k = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("verify-history-{name}-{}-{k}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

// ------------------------------------------------------------ helpers

/// A report as the checks would leave it (no check runs here).
fn report(verdict: Verdict, findings: Vec<Finding>) -> Report {
    Report {
        verdict,
        season: 1,
        program: program().to_string(),
        slot_range: (0, 0),
        entities: 0,
        bells: 0,
        counts: Counts::default(),
        findings,
        liveness: Liveness::default(),
        checks_run: vec!["V1"],
        provenance: String::new(),
        history: None,
    }
}

fn fail(code: &str) -> Finding {
    Finding {
        code: code.into(),
        severity: Severity::Fail,
        check: "V1",
        entity: "e".into(),
        bell: 0,
        signature: String::new(),
        detail: String::new(),
    }
}

fn reasons(h: &History) -> Vec<String> {
    h.coverage.as_ref().unwrap()["unverifiable"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["reason"].as_str().unwrap().to_string())
        .collect()
}

fn fail_in(check: &'static str, entity: &str, code: &str) -> Finding {
    Finding {
        check,
        entity: entity.into(),
        ..fail(code)
    }
}

fn unproven_verdicts(h: &History) {
    // A FAIL decided inside a fetched transaction stays FAIL (⑪'s list).
    for own in [
        fail_in("V0", "tx#3", "UnknownInstruction"),
        fail_in("V27", "resident 4", "ResidentJoinMismatch"),
        fail_in("V9", "RESIDENT_JOINED", "NonCanonicalAddress"),
    ] {
        let r = apply(
            h,
            report(Verdict::Fail, vec![own.clone(), fail("HeadMismatch")]),
        );
        assert_eq!(r.verdict, Verdict::Fail, "{own:?}");
        assert_eq!(r.json()["history"]["selfContainedFails"], 1);
        assert_eq!(r.json()["history"]["otherFails"], 1);
    }
    for (v, f) in [
        (Verdict::Pass, vec![]),
        (Verdict::Fail, vec![fail("HeadMismatch")]),
        (
            Verdict::Fail,
            vec![fail_in("V9", "season", "NonCanonicalAddress")],
        ),
        (Verdict::Fail, vec![fail_in("V0", "tx#3", "Undecodable")]),
    ] {
        let r = apply(h, report(v, f.clone()));
        assert_eq!(r.verdict, Verdict::Unverifiable, "{h:?} from {v:?} {f:?}");
        assert!(r
            .findings
            .iter()
            .any(|x| x.code == HISTORY_UNPROVEN && x.severity == Severity::Unverifiable));
        assert_eq!(
            r.findings.iter().filter(|x| x.fail()).count(),
            f.len(),
            "FAIL findings stay listed"
        );
        let j = r.json();
        assert_eq!(j["verdict"], "UNVERIFIABLE");
        assert_eq!(j["history"]["basis"], "unproven");
        assert_eq!(j["history"]["complete"], false);
        assert!(r.markdown().contains("not shown to be the whole history"));
    }
}

// ------------------------------------------------------------ the rule

/// Every coverage state, `cross_checked` included, is unproven: never PASS,
/// FAIL only on a self-contained FAIL; the finding says why and that
/// cross-checking is not a proof of completeness or finality.
#[test]
fn every_rpc_coverage_state_is_unproven() {
    for state in ["gap", "not_fetched", "unverifiable", "cross_checked"] {
        let h = History::rpc(
            json!({"state": state, "unverifiable": [], "gap": null}),
            "rpc test",
        );
        assert!(h.unproven(), "{state}");
        unproven_verdicts(&h);
    }
    let h = History::rpc(json!({"state": "cross_checked", "unverifiable": []}), "");
    let f = h.finding().unwrap();
    assert!(
        f.detail.contains("not proof of completeness or finality"),
        "{}",
        f.detail
    );
}

/// The local ledger's feed and a fixture's own (absent) history keep the
/// verdict the checks gave; their report does not claim completeness
/// (`complete: null`), and nothing ever says `true`.
#[test]
fn a_ledger_feed_or_a_fixture_keeps_the_verdict_without_claiming_completeness() {
    for h in [History::default(), History::ledger_feed("local")] {
        for v in [Verdict::Pass, Verdict::Fail, Verdict::Unverifiable] {
            let r = apply(&h, report(v, vec![]));
            assert_eq!(r.verdict, v);
            assert!(r.findings.is_empty());
            assert_eq!(r.json()["history"]["complete"], Value::Null);
        }
    }
    assert_eq!(History::default().basis(), "as_given");
    assert_eq!(History::ledger_feed("x").basis(), "ledger_feed");
}

/// A fixture keeps where its transactions came from: saved from RPC it
/// stays unproven; a recorded `fixture` source, an RPC history without its
/// coverage or an unknown source is unproven (never `as_given`); only an
/// absent field is the file's own claim.
#[test]
fn a_saved_fixture_cannot_launder_an_rpc_history() {
    let cov = json!({"state": "cross_checked", "unverifiable": [], "gap": null});
    let mut inp = Input {
        cfg: Config {
            program: program(),
            season_id: 1,
            quicknet_pk: [0; 96],
            ruleset_hash: [0; 32],
            program_hash: None,
        },
        txs: vec![],
        finals: Default::default(),
        final_slot: 0,
        program_hashes: vec![],
        provenance: String::new(),
        scenarios: vec![],
        history: History::rpc(cov.clone(), "rpc x"),
        resident_feed: None,
    };
    let back = Input::from_json(&inp.to_json()).unwrap();
    assert_eq!(back.history.source, Source::Rpc);
    assert_eq!(back.history.coverage, Some(cov));
    assert!(back.history.unproven());
    inp.history = History::default();
    let v = inp.to_json();
    assert!(v.get("history").is_none());
    assert_eq!(Input::from_json(&v).unwrap().history.basis(), "as_given");
    for bad in [
        json!({"source": "fixture"}),
        json!({"source": "rpc"}),
        json!({"source": "elsewhere"}),
        json!("not an object"),
    ] {
        let h = History::from_json(Some(&bad));
        assert!(h.unproven(), "{bad}");
    }
}

// ------------------------------------------------------------ over RPC

/// Default settings (no origin anchor, no witness): the history is fetched,
/// its range and the reasons are kept, and it is unproven.
#[tokio::test]
async fn default_settings_fetch_an_unproven_history() {
    let (_n, url) = node(&[3, 4, 5]).await;
    let (txs, h) = input::fetch_txs(&url, &program(), false, None, None)
        .await
        .unwrap();
    assert_eq!(
        txs.iter().map(|t| t.slot).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert_eq!(h.source, Source::Rpc);
    assert_eq!(h.state(), Some("unverifiable"));
    let r = reasons(&h);
    assert!(
        r.contains(&reason::FIRST_PULL_UNANCHORED.to_string()),
        "{r:?}"
    );
    assert!(r.contains(&reason::NO_WITNESS.to_string()), "{r:?}");
    assert_eq!(
        h.coverage.as_ref().unwrap()["range"],
        json!({"firstSlot": 3, "lastSlot": 5})
    );
    unproven_verdicts(&h);
}

/// Origin anchor and an agreeing witness: `cross_checked`, still unproven.
#[tokio::test]
async fn cross_checked_is_still_not_a_complete_history() {
    let (_n, url) = node(&[1, 2, 3]).await;
    let (_w, wurl) = node(&[1, 2, 3]).await;
    let (txs, h) = input::fetch_txs(&url, &program(), false, Some(sig(1)), Some(&wurl))
        .await
        .unwrap();
    assert_eq!(txs.len(), 3);
    assert_eq!(h.state(), Some("cross_checked"));
    unproven_verdicts(&h);
}

/// A gap the checks see (the witness holds a range the node skipped, or
/// the node misses the origin): nothing is verified over it.
#[tokio::test]
async fn a_detected_gap_is_not_verified_over() {
    let (_n, url) = node(&[1, 2, 5, 6]).await;
    let (_w, wurl) = node(&[1, 2, 3, 4, 5, 6]).await;
    let e = input::fetch_txs(&url, &program(), false, None, Some(&wurl))
        .await
        .unwrap_err();
    assert!(e.contains("history gap"), "{e}");
    let (_p, purl) = node(&[3, 4]).await;
    let e = input::fetch_txs(&purl, &program(), false, Some(sig(1)), None)
        .await
        .unwrap_err();
    assert!(e.contains("history gap") && e.contains("origin"), "{e}");
}

/// A witness that cannot be read: fetched, but marked, and unproven.
#[tokio::test]
async fn a_witness_down_leaves_the_history_unproven() {
    let (_n, url) = node(&[1, 2]).await;
    let (txs, h) = input::fetch_txs(&url, &program(), false, Some(sig(1)), Some(&dead_url()))
        .await
        .unwrap();
    assert_eq!(txs.len(), 2);
    assert_eq!(reasons(&h), vec![reason::WITNESS_UNAVAILABLE.to_string()]);
    unproven_verdicts(&h);
}

/// A witness behind the node: the fetch does not stop at the first empty
/// pull (the signatures it holds back are not "the end"); the tail is
/// fetched after RpcPoll's bound, marked unchecked.
#[tokio::test]
async fn a_witness_behind_does_not_end_the_history_early() {
    let (_n, url) = node(&[1, 2, 3, 4]).await;
    let (_w, wurl) = node(&[1, 2]).await;
    let (txs, h) = input::fetch_txs(&url, &program(), false, Some(sig(1)), Some(&wurl))
        .await
        .unwrap();
    assert_eq!(
        txs.iter().map(|t| t.slot).collect::<Vec<_>>(),
        vec![1, 2, 3, 4],
        "the held-back tail is fetched, not dropped"
    );
    assert_eq!(h.state(), Some("unverifiable"));
    assert_eq!(reasons(&h), vec![reason::WITNESS_LACKS.to_string()]);
    assert_eq!(h.coverage.as_ref().unwrap()["heldBack"], 0);
    unproven_verdicts(&h);
}

// ------------------------------------------------------------ archives

fn rec(i: u8) -> TxRecord {
    TxRecord {
        seq: 0,
        slot: i as u64,
        signature: sig(i),
        block_time: 0,
        tx: vec![1, 2, 3],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn archive_with(name: &str, cursor: Value, n: u8) -> std::path::PathBuf {
    let d = tmp(name);
    let mut a = findex::archive::Archive::open(&d, findex::archive::SEGMENT_BYTES).unwrap();
    if n > 0 {
        let recs: Vec<_> = (1..=n).map(rec).collect();
        a.append(&recs, cursor).unwrap();
    }
    a.commit().unwrap();
    d
}

/// Archives: an RpcPoll cursor gives its coverage; an older RpcPoll cursor
/// (before coverage was recorded) resumes as unproven with that reason; a
/// cursor that says nothing about its source is unproven; so is a local
/// feed's archive without its ledger numbers (`tests/ledger_history.rs`
/// has the whole one).
#[test]
fn archives_report_where_their_records_came_from() {
    // Written by RpcPoll before coverage: no `rpc_coverage`.
    let old = json!({"rpc_last": sig(2).to_string(), "rpc_last_slot": 2,
                     "rpc_last_slot_sigs": [sig(2).to_string()]});
    let d = archive_with("old", old, 2);
    let (txs, h) = input::read_archive(&d).unwrap();
    assert_eq!(txs.len(), 2);
    assert_eq!(h.source, Source::Rpc);
    assert_eq!(reasons(&h), vec![reason::BEFORE_COVERAGE.to_string()]);
    unproven_verdicts(&h);

    // Unreadable / foreign cursor with records.
    let d = archive_with("foreign", json!({"something": 1}), 2);
    let (_, h) = input::read_archive(&d).unwrap();
    assert_eq!(h.source, Source::Unknown);
    unproven_verdicts(&h);

    // A refused RpcPoll cursor is a gap.
    let d = archive_with("refused", json!({"rpc_refused": "history gap: x"}), 1);
    let (_, h) = input::read_archive(&d).unwrap();
    assert_eq!(h.state(), Some("gap"));
    unproven_verdicts(&h);

    // The local node's ordered feed, archived without the ledger numbers,
    // start or ledger (`findex::ledger`, 2026-11-07): not shown whole.
    let d = archive_with("feed", json!({"feed_after": 9}), 2);
    let (_, h) = input::read_archive(&d).unwrap();
    assert!(h.unproven(), "{h:?}");

    // An empty archive: nothing fetched, which is not an empty history.
    let d = archive_with("empty", Value::Null, 0);
    let (txs, h) = input::read_archive(&d).unwrap();
    assert!(txs.is_empty());
    assert_eq!(h.state(), Some("not_fetched"));
    unproven_verdicts(&h);
}

/// An archive RpcPoll wrote with coverage reports it as recorded, without
/// the reading side's settings.
#[tokio::test]
async fn an_rpc_archive_keeps_its_coverage() {
    let (_n, url) = node(&[1, 2]).await;
    let d = tmp("rpc");
    {
        let mut f = findex::Findex::open(&d, program(), None, 1 << 20).unwrap();
        let mut p = findex::RpcPoll::new(url, program()).with_origin(sig(1));
        assert_eq!(f.ingest(&mut p).await.unwrap().len(), 2);
        f.commit().unwrap();
    }
    let (txs, h) = input::read_archive(&d.join("archive")).unwrap();
    assert_eq!(txs.len(), 2);
    let c = h.coverage.as_ref().unwrap();
    assert_eq!(c["state"], "unverifiable");
    assert_eq!(c["range"], json!({"firstSlot": 1, "lastSlot": 2}));
    assert_eq!(
        c["origin"],
        Value::Null,
        "the reader's settings are not reported"
    );
    assert_eq!(reasons(&h), vec![reason::NO_WITNESS.to_string()]);
    unproven_verdicts(&h);
}

// ------------------------------------------------------------ the verifier's body
//
// `verify_core::verify` over committed recorded fixtures (loaded from disk:
// no keypair is made, derived or used to sign here; the checks compute PDA
// and seed addresses, which is allowed). Each history comes from a real
// RpcPoll run against the stand-in node or a real archive cursor, then
// stands for the fixture's transactions.

fn load(name: &str) -> Input {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/verify")
        .join(name);
    Input::load(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn show(r: &Report) -> String {
    r.findings
        .iter()
        .map(|f| format!("{:?} {} {} {}", f.severity, f.check, f.code, f.entity))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Histories produced by RpcPoll and archives in the situations to check.
async fn histories() -> Vec<(&'static str, History)> {
    let mut out = vec![];
    let (_n, url) = node(&[1, 2, 3]).await;
    out.push((
        "default settings",
        input::fetch_txs(&url, &program(), false, None, None)
            .await
            .unwrap()
            .1,
    ));
    let (_w, wurl) = node(&[1, 2, 3]).await;
    out.push((
        "cross_checked",
        input::fetch_txs(&url, &program(), false, Some(sig(1)), Some(&wurl))
            .await
            .unwrap()
            .1,
    ));
    out.push((
        "witness down",
        input::fetch_txs(&url, &program(), false, Some(sig(1)), Some(&dead_url()))
            .await
            .unwrap()
            .1,
    ));
    let (_p, purl) = node(&[1, 2, 3, 4]).await;
    let (_l, lurl) = node(&[1, 2]).await;
    out.push((
        "witness behind",
        input::fetch_txs(&purl, &program(), false, Some(sig(1)), Some(&lurl))
            .await
            .unwrap()
            .1,
    ));
    let old = json!({"rpc_last": sig(2).to_string(), "rpc_last_slot": 2,
                     "rpc_last_slot_sigs": [sig(2).to_string()]});
    out.push((
        "older cursor",
        input::read_archive(&archive_with("body-old", old, 2))
            .unwrap()
            .1,
    ));
    out.push((
        "unknown archive",
        input::read_archive(&archive_with("body-unknown", json!({"x": 1}), 2))
            .unwrap()
            .1,
    ));
    out
}

/// Dataset verdicts stay visible (including the old synthetic placement
/// failure); RPC or unknown history never PASSes, `cross_checked` included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_verifier_never_passes_an_unproven_history() {
    let hs = histories().await;
    // The current dispersed-placement integration rejects the old
    // synthetic march tickets. Keep that known failure visible: it must
    // not invalidate the history boundary test or be silently made PASS.
    // The recorded land fixture remains the positive PASS control.
    for (name, expected) in [
        ("land-program.json", Verdict::Pass),
        ("march-synth.json", Verdict::Fail),
    ] {
        let inp = load(name);
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, expected, "{name} as given:\n{}", show(&r));
        if name == "march-synth.json" {
            let failures: Vec<_> = r.findings.iter().filter(|f| f.fail()).collect();
            assert_eq!(failures.len(), 6, "unexpected legacy fixture failure count");
            assert!(failures
                .iter()
                .all(|f| f.check == "V11" && f.code == "TicketPlacementMismatch"));
        }
        assert_eq!(r.json()["history"]["basis"], "as_given");
        let mut feed = inp.clone();
        feed.history = History::ledger_feed("local");
        assert_eq!(verify_core::verify(&feed).verdict, expected, "{name}");
        for (what, h) in &hs {
            let mut i = inp.clone();
            i.history = h.clone();
            let r = verify_core::verify(&i);
            assert_eq!(
                r.verdict,
                Verdict::Unverifiable,
                "{name}, {what}:\n{}",
                show(&r)
            );
            let j = r.json();
            assert_eq!(j["history"]["complete"], false, "{name}, {what}");
            assert_eq!(j["history"]["selfContainedFails"], 0);
            assert!(r.codes().contains(&HISTORY_UNPROVEN), "{name}, {what}");
        }
    }
}

/// History with a range missing (mixed into a recorded season: the start,
/// a stretch in the middle, the tail). As given, the checks see a broken
/// season and FAIL; with an unproven history that FAIL can be the missing
/// range, so the verdict is UNVERIFIABLE with the FAILs still listed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_range_is_not_reported_as_a_forgery_of_an_unproven_history() {
    let hs = histories().await;
    let full = load("land-program.json");
    let n = full.txs.len();
    assert!(n > 12, "a season to cut");
    for (cut, range) in [
        ("start", 0..3),
        ("middle", n / 2..n / 2 + 3),
        ("tail", n - 3..n),
    ] {
        let mut inp = full.clone();
        inp.txs.drain(range);
        let as_given = verify_core::verify(&inp);
        assert_ne!(
            as_given.verdict,
            Verdict::Pass,
            "{cut}: the cut is visible:\n{}",
            show(&as_given)
        );
        for (what, h) in &hs {
            let mut i = inp.clone();
            i.history = h.clone();
            let r = verify_core::verify(&i);
            let own = r
                .findings
                .iter()
                .filter(|f| verify_core::history::self_contained(f))
                .count();
            let expect = if own > 0 {
                Verdict::Fail
            } else {
                Verdict::Unverifiable
            };
            assert_eq!(r.verdict, expect, "{cut}, {what}:\n{}", show(&r));
            assert_eq!(
                own,
                0,
                "{cut}, {what}: a cut leaves no self-contained FAIL:\n{}",
                show(&r)
            );
            assert_eq!(
                r.findings.iter().filter(|f| f.fail()).count(),
                as_given.findings.iter().filter(|f| f.fail()).count(),
                "{cut}, {what}: the FAIL findings stay listed"
            );
            assert_eq!(r.json()["history"]["complete"], false);
        }
    }
}

/// A FAIL decided inside one fetched transaction stays FAIL over an
/// unproven history: a successful program instruction's tag rewritten to
/// one no ABI allocates (the recorded wire bytes edited, nothing re-signed:
/// the verifier reads the message, the signature is left as recorded).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_self_contained_fail_still_fails_over_an_unproven_history() {
    let hs = histories().await;
    let mut inp = load("land-program.json");
    let program = inp.cfg.program;
    let i = inp
        .txs
        .iter()
        .rposition(|t| {
            t.err.is_none()
                && fclient::tx::from_wire(&t.tx).is_ok_and(|x| {
                    x.message.instructions.iter().any(|ci| {
                        x.message.account_keys[ci.program_id_index as usize] == program
                            && !ci.data.is_empty()
                    })
                })
        })
        .expect("a successful program call");
    let mut t = fclient::tx::from_wire(&inp.txs[i].tx).unwrap();
    for ci in t.message.instructions.iter_mut() {
        if t.message.account_keys[ci.program_id_index as usize] == program && !ci.data.is_empty() {
            ci.data[0] = 0xFF;
            break;
        }
    }
    inp.txs[i].tx = fclient::tx::wire(&t);
    for (what, h) in &hs {
        let mut x = inp.clone();
        x.history = h.clone();
        let r = verify_core::verify(&x);
        assert!(
            r.findings
                .iter()
                .any(|f| f.fail() && f.check == "V0" && f.code == "UnknownInstruction"),
            "{what}:\n{}",
            show(&r)
        );
        assert_eq!(r.verdict, Verdict::Fail, "{what}:\n{}", show(&r));
        assert!(r.json()["history"]["selfContainedFails"].as_u64().unwrap() >= 1);
        assert_eq!(r.json()["history"]["complete"], false);
    }
}

/// These checks use only literal JSON and report values, never a keypair.
#[test]
fn malformed_feed_cursors_and_empty_archives_never_gain_dataset_trust() {
    for cursor in [
        json!({"feed_after": null}),
        json!({"feed_after": "9"}),
        json!({"feed_after": -1}),
        json!({"feed_after": 1.5}),
    ] {
        let h = History::of_archive(&cursor, true, "literal cursor");
        assert!(h.unproven());
        unproven_verdicts(&h);
    }
    let h = History::of_archive(&json!({"feed_after": 9}), false, "empty");
    assert!(h.unproven());
    assert_eq!(h.state(), Some("not_fetched"));
    // A local feed's cursor alone does not show the ledger numbers of the
    // records (`input::read_archive` checks them, `findex::ledger`).
    assert!(History::of_archive(&json!({"feed_after": 9}), true, "observed").unproven());
}

#[test]
fn dataset_scope_is_explicit_and_conflicting_feed_coverage_is_unproven() {
    for h in [History::default(), History::ledger_feed("local")] {
        assert_eq!(h.report()["scope"], "dataset_only");
        assert_eq!(h.report()["complete"], Value::Null);
    }
    for state in ["gap", "unverifiable", "cross_checked", "not_fetched"] {
        let h = History::from_json(Some(&json!({
            "source": "ledger_feed", "coverage": {"state": state}, "detail": "contradiction"
        })));
        assert!(h.unproven());
        unproven_verdicts(&h);
        assert_eq!(h.report()["scope"], "observed_transactions");
    }
}

#[tokio::test]
async fn empty_local_feed_is_an_observation_not_a_complete_season() {
    let (_n, url) = node(&[]).await;
    let (txs, h) = input::fetch_txs(&url, &program(), true, None, None)
        .await
        .unwrap();
    assert!(txs.is_empty());
    assert!(h.unproven());
    unproven_verdicts(&h);
}
