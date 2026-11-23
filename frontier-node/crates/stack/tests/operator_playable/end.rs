//! PEND (devnet-end-season, D-dress-6): P5's season — the rim opened by keeper A, a rim village, keeper A's wide
//! ring 129 and a settled wide village — run to its END on the devnet `.so` with `frontier-operator end-season`, the
//! command r0ze would run on devnet (`--rpc` pointed at the local node, the devnet flags):
//!
//! 1. before the end bell: the dry run plans EndSeason "waits for" the end; a send is refused (exit 3, nothing sent);
//! 2. at the end bell: EndSeason lands (the authority pays its fee only), a re-run waits for `end + 72 h`;
//! 3. keeper A and the herald after Ended: keeper A's refused writes are counted, the herald says Ended;
//! 4. at `end + 72 h`: every CloseProvince / wide province close and CloseSeason parts land; every recipient's
//!    lamports from the operator's transactions equal the plan's refunds to the lamport; a re-run sends nothing;
//! 5. keeper A and the herald after the tombstone;
//! 6. the verifier re-executes the whole season's archive, the closes included.

use super::*;
use frontier_stack::chain::Chain;
use frontier_stack::operator;

/// What PEND needs from the outer test (the operator's files and the keeper's API).
pub struct End {
    pub profile: std::path::PathBuf,
    pub key: std::path::PathBuf,
    pub url: String,
    pub authority: Address,
    pub so_sha256: &'static str,
    pub keeper_api: u16,
    pub token: String,
    pub record: std::path::PathBuf,
}

fn s(p: &std::path::Path) -> String {
    p.to_str().unwrap().to_string()
}

/// The keeper API's `/v1/status` (bearer token), `Null` when it does not answer.
fn keeper_status(port: u16, token: &str) -> Value {
    use std::io::{Read, Write};
    let Ok(mut c) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return Value::Null;
    };
    let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!(
        "GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if c.write_all(req.as_bytes()).is_err() {
        return Value::Null;
    }
    let mut b = String::new();
    let _ = c.read_to_string(&mut b);
    b.split("\r\n\r\n")
        .nth(1)
        .and_then(|x| serde_json::from_str(x.trim()).ok())
        .unwrap_or(Value::Null)
}

/// The program transactions after `since` by payer kind: `(ok, failed)` per instruction name, the authority's
/// excluded.
fn traffic_since(r: &Run<'_>, since: u64, authority: &Address) -> (Value, usize, usize) {
    let mut by: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
    let (mut ok, mut bad) = (0, 0);
    for l in r.lock().feed(0, usize::MAX, Some(&r.c.program)) {
        if l.slot <= since {
            continue;
        }
        let payer = fclient::vtx::decode(&l.wire)
            .ok()
            .and_then(|t| t.fee_payer());
        if payer == Some(*authority) {
            continue;
        }
        let e = by
            .entry(super::super::ix_name(&l.wire, &r.c.program))
            .or_default();
        if l.err.is_none() {
            e.0 += 1;
            ok += 1;
        } else {
            e.1 += 1;
            bad += 1;
        }
    }
    (
        json!(by
            .iter()
            .map(|(k, (o, f))| (k.clone(), json!({"ok": o, "failed": f})))
            .collect::<serde_json::Map<_, _>>()),
        ok,
        bad,
    )
}

/// Every account's lamport change in the authority's transactions after `since`, from the transactions' own
/// pre/post balances (exact whatever keeper A sends meanwhile).
fn operator_deltas(
    r: &Run<'_>,
    since: u64,
    authority: &Address,
) -> std::collections::BTreeMap<Address, i128> {
    let mut m = std::collections::BTreeMap::new();
    for l in r.lock().feed(0, usize::MAX, Some(&r.c.program)) {
        if l.slot <= since || l.err.is_some() {
            continue;
        }
        let payer = fclient::vtx::decode(&l.wire)
            .ok()
            .and_then(|t| t.fee_payer());
        if payer != Some(*authority) {
            continue;
        }
        for (i, k) in l.keys.iter().enumerate() {
            let d = l.post_balances[i] as i128 - l.pre_balances[i] as i128;
            if d != 0 {
                *m.entry(*k).or_default() += d;
            }
        }
    }
    m
}

/// What the player's page shows (`end_page.mjs`, headless Chromium; `DEVNET_PAGE_DRIVER=1` only, else `Null`).
fn page_probe(r: &Run<'_>, tag: &str) -> Value {
    if std::env::var("DEVNET_PAGE_DRIVER").ok().as_deref() != Some("1") {
        return Value::Null;
    }
    let out = std::env::var("OPERATOR_EVIDENCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| r.c.dir.clone())
        .join("pend-page");
    let o = std::process::Command::new("node")
        .arg(
            super::super::repo_root()
                .join("frontier-node/crates/stack/tests/operator_playable/end_page.mjs"),
        )
        .args([
            "--herald",
            &r.c.herald.to_string(),
            "--out",
            out.to_str().unwrap(),
            "--tag",
            tag,
        ])
        .output()
        .expect("node end_page.mjs");
    let line = String::from_utf8_lossy(&o.stdout)
        .lines()
        .last()
        .unwrap_or("")
        .to_string();
    serde_json::from_str(&line).unwrap_or_else(|_| {
        json!({"error": String::from_utf8_lossy(&o.stderr).chars().take(600).collect::<String>()})
    })
}

/// `frontier-operator` with the chain running at its real speed (its sends must land), paused again after.
async fn run_op(r: &Run<'_>, args: Vec<String>) -> super::super::Run {
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let out = super::super::op(args).await;
    r.lock().set_paused(true);
    out
}

/// Lets keeper A run at the chain's real speed for `secs` wall seconds.
async fn idle(r: &Run<'_>, secs: u64) {
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    tokio::time::sleep(Duration::from_secs(secs)).await;
    r.lock().set_paused(true);
}

pub(super) async fn flow(r: &mut Run<'_>, e: &End) -> Value {
    use fclient::abi::status as st;
    let a = r.c.a.clone();
    let base = vec![
        "end-season".to_string(),
        "--profile".into(),
        s(&e.profile),
        "--rpc".into(),
        e.url.clone(),
        "--authority".into(),
        s(&e.key),
    ];
    let send_args = || {
        let mut v = base.clone();
        v.extend(
            [
                "--yes-send",
                "--i-have-r0ze-approval",
                "--approved-sha256",
                e.so_sha256,
                "--record",
                e.record.to_str().unwrap(),
            ]
            .map(String::from),
        );
        v
    };
    let bal = |r: &Run<'_>| r.lock().balance(&e.authority);
    let status = |r: &Run<'_>| {
        let d = r.data(&a.season).unwrap();
        (d.len(), d[frontier_abi::layout::world::season::STATUS])
    };
    let chain = Chain::public(&e.url, r.c.program);
    let sd = fclient::decode::Season::decode(&r.season()).unwrap();
    let end_ts = sd.genesis_ts + sd.end_bell as i64 * 600;
    let close_at = end_ts + 72 * 3_600;
    r.lock().set_paused(true);

    // 1. Before the end bell.
    let b0 = bal(r);
    let dry_before = run_op(r, base.clone()).await;
    assert_eq!(
        dry_before.code, 0,
        "{}\n{}",
        dry_before.stdout, dry_before.stderr
    );
    assert!(
        dry_before.stdout.contains("\ntx EndSeason"),
        "{}",
        dry_before.stdout
    );
    assert!(
        dry_before.stdout.contains("waits for chain clock"),
        "{}",
        dry_before.stdout
    );
    assert!(
        dry_before.stdout.contains("DRY RUN: nothing sent"),
        "{}",
        dry_before.stdout
    );
    let early = run_op(r, send_args()).await;
    assert_eq!(
        early.code,
        operator::EXIT_WAITING,
        "{}\n{}",
        early.stdout,
        early.stderr
    );
    assert!(
        early
            .stdout
            .contains("end-season waiting: EndSeason is not due before"),
        "{}",
        early.stdout
    );
    assert_eq!(bal(r), b0, "nothing sent before the end bell");
    assert_eq!(status(r).1, st::SEEDED);
    // A wrong --approved-sha256: refused.
    let mut wrong = send_args();
    let i = wrong.iter().position(|x| x == e.so_sha256).unwrap();
    wrong[i] = "11".repeat(32);
    let wr = run_op(r, wrong).await;
    assert_eq!(
        wr.code,
        operator::EXIT_REFUSED,
        "{}\n{}",
        wr.stdout,
        wr.stderr
    );
    assert!(
        wr.stderr.contains("is not the deployed program's sha256"),
        "{}",
        wr.stderr
    );

    // 2. The end bell: the clock jumps to it (the season's 1,008 bells; keeper A keeps running).
    let since_end_jump = r.lock().slot();
    r.advance_exact(end_ts + 5);
    idle(r, 8).await;
    let herald_at_end = super::super::http_get(r.c.herald, "/h/season").unwrap_or(Value::Null);
    let page_at_end = page_probe(r, "1-end-bell-before-endseason");
    let dry_end = run_op(r, base.clone()).await;
    assert_eq!(dry_end.code, 0, "{}\n{}", dry_end.stdout, dry_end.stderr);
    let (ended_tx, b_before_end) = {
        let b1 = bal(r);
        let rr = run_op(r, send_args()).await;
        (rr, b1)
    };
    // (exit 3: EndSeason landed, the closes wait for end + 72 h)
    assert_eq!(
        ended_tx.code,
        operator::EXIT_WAITING,
        "{}\n{}",
        ended_tx.stdout,
        ended_tx.stderr
    );
    let landed_end = super::super::landed_lines(&ended_tx.stdout);
    assert_eq!(landed_end.len(), 1, "{}", ended_tx.stdout);
    assert!(
        landed_end[0].starts_with("landed     EndSeason"),
        "{}",
        landed_end[0]
    );
    assert_eq!(
        b_before_end - bal(r),
        operator::FEE_PER_SIGNATURE,
        "EndSeason costs its fee only"
    );
    assert_eq!(status(r), (2048, st::ENDED));
    assert!(
        ended_tx.stdout.contains("is not due before"),
        "{}",
        ended_tx.stdout
    );
    let again = run_op(r, send_args()).await;
    assert_eq!(
        again.code,
        operator::EXIT_WAITING,
        "{}\n{}",
        again.stdout,
        again.stderr
    );
    assert!(
        super::super::landed_lines(&again.stdout).is_empty(),
        "{}",
        again.stdout
    );

    // 3. keeper A and the herald after Ended.
    let since_ended = r.lock().slot();
    idle(r, 20).await;
    let (keeper_after_ended, _, keeper_failed_after_ended) =
        traffic_since(r, since_ended, &e.authority);
    let herald_ended = super::super::http_get(r.c.herald, "/h/season").unwrap_or(Value::Null);
    let page_ended = page_probe(r, "2-ended");
    let keeper_status_ended = keeper_status(e.keeper_api, &e.token);

    // 4. end + 72 h: the closes.
    r.advance_exact(close_at + 5);
    idle(r, 3).await;
    let obs = frontier_stack::operator_end::observe(&chain, &a)
        .await
        .unwrap();
    let plan = frontier_stack::operator_end::plan(&obs, &a, e.authority);
    let totals = frontier_stack::operator_end::totals(&plan, &a, e.authority);
    let plan_json = frontier_stack::operator_end::plan_json(&obs, &a, &plan, e.authority);
    assert!(plan.iter().all(|s| s.blocked.is_none()), "{plan_json:#}");
    assert!(
        !obs.provinces.is_empty() && !obs.wide_provinces.is_empty(),
        "{plan_json:#}"
    );
    let dry_close = run_op(r, base.clone()).await;
    assert_eq!(
        dry_close.code, 0,
        "{}\n{}",
        dry_close.stdout, dry_close.stderr
    );
    assert!(
        dry_close
            .stdout
            .contains("SEND GATE: CLOSED\n  - --yes-send is not given"),
        "{}",
        dry_close.stdout
    );
    let since_close = r.lock().slot();
    let b2 = bal(r);
    let closes = run_op(r, send_args()).await;
    assert_eq!(closes.code, 0, "{}\n{}", closes.stdout, closes.stderr);
    assert!(
        closes.stdout.contains("end-season complete:"),
        "{}",
        closes.stdout
    );
    let landed_closes = super::super::landed_lines(&closes.stdout);
    assert_eq!(landed_closes.len() as u64, totals.txs, "{}", closes.stdout);
    let net = bal(r) as i128 - b2 as i128;
    assert_eq!(
        net,
        totals.authority_net(),
        "the authority's balance change is the plan's net"
    );
    let deltas = operator_deltas(r, since_close, &e.authority);
    assert_eq!(
        deltas.get(&e.authority).copied().unwrap_or(0),
        totals.authority_net()
    );
    for (to, l) in &totals.to_others {
        assert_eq!(
            deltas.get(to).copied().unwrap_or(0),
            *l as i128,
            "refund to {to} vs the plan"
        );
    }
    assert_eq!(status(r), (128, st::CLOSED), "the Season is the tombstone");
    for (k, _, _, _) in obs.provinces.iter().chain(&obs.wide_provinces) {
        assert!(r.lock().account(k).is_none(), "province {k} closed");
    }
    for k in a.province_funds() {
        assert!(r.lock().account(&k).is_none(), "fund {k} closed");
    }
    let rerun = run_op(r, send_args()).await;
    assert_eq!(rerun.code, 0, "{}\n{}", rerun.stdout, rerun.stderr);
    assert!(
        rerun
            .stdout
            .contains("end-season complete: nothing to send"),
        "{}",
        rerun.stdout
    );
    let cus: Vec<Value> = closes
        .stdout
        .lines()
        .filter(|l| l.starts_with("landed "))
        .map(|l| json!(l))
        .collect();

    // 5. keeper A and the herald after the tombstone.
    let since_tomb = r.lock().slot();
    idle(r, 20).await;
    let (keeper_after_tomb, keeper_ok_after_tomb, keeper_failed_after_tomb) =
        traffic_since(r, since_tomb, &e.authority);
    let herald_closed = super::super::http_get(r.c.herald, "/h/season").unwrap_or(Value::Null);
    let page_closed = page_probe(r, "3-closed");
    let herald_status = super::super::http_get(r.c.herald, "/h/status").unwrap_or(Value::Null);
    let keeper_status_closed = keeper_status(e.keeper_api, &e.token);
    let keeper_alive = r.c.keeper.try_wait().ok().flatten().is_none();
    let klog = std::fs::read_to_string(r.c.dir.join("keeper.log")).unwrap_or_default();
    let keeper_closed_line = klog
        .lines()
        .rev()
        .find(|l| l.contains("season-closed") || l.contains("season-ended"))
        .map(String::from);

    // 6. The verifier over the whole archive, the end and the closes included.
    let verifier = r.judge_season("pend");
    let _ = since_end_jump;
    json!({
        "pend": "P5's season run to its end with frontier-operator end-season on the devnet .so",
        "end_ts": end_ts, "close_at": close_at, "end_bell": sd.end_bell,
        "dry_run_before_end": dry_before.stdout, "send_before_end": early.stdout,
        "herald_season_at_end_bell": herald_at_end,
        "dry_run_at_end": dry_end.stdout, "end_season_send": ended_tx.stdout,
        "keeper_after_ended": {"traffic": keeper_after_ended, "failed": keeper_failed_after_ended, "status": keeper_status_ended},
        "herald_season_ended": herald_ended,
        "plan": plan_json, "dry_run_closes": dry_close.stdout, "closes_send": closes.stdout, "landed": cus,
        "authority_net": net.to_string(),
        "operator_deltas": deltas.iter().map(|(k, v)| (k.to_string(), json!(v.to_string()))).collect::<serde_json::Map<_, _>>(),
        "rerun": rerun.stdout,
        "keeper_after_tombstone": {"traffic": keeper_after_tomb, "ok": keeper_ok_after_tomb, "failed": keeper_failed_after_tomb,
            "alive": keeper_alive, "status": keeper_status_closed, "log_line": keeper_closed_line},
        "herald_season_closed": herald_closed, "herald_status_closed": herald_status,
        "page": {"at_end_bell": page_at_end, "ended": page_ended, "closed": page_closed},
        "verifier": verifier,
    })
}
