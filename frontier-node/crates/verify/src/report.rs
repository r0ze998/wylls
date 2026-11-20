//! V10 — the report: `report.json` (the §8.5 schema, plus `checks_run`
//! and `provenance`) and `report.md` (the same, for people).

use serde_json::{json, Value};

use crate::{Finding, Report, Severity};

fn sev(s: Severity) -> &'static str {
    match s {
        Severity::Fail => "fail",
        Severity::Warn => "warn",
        Severity::Unverifiable => "unverifiable",
    }
}

fn finding_json(f: &Finding) -> Value {
    json!({
        "code": f.code, "severity": sev(f.severity), "check": f.check, "entity": f.entity,
        "bell": f.bell, "signature": f.signature, "detail": f.detail,
    })
}

pub fn json(r: &Report) -> Value {
    let c = &r.counts;
    let l = &r.liveness;
    let mut out = json!({
        "verdict": r.verdict.name(),
        "season": r.season.to_string(),
        "program": r.program,
        "slot_range": [r.slot_range.0, r.slot_range.1],
        "entities": r.entities,
        "bells": r.bells,
        "counts": {"tx": c.tx, "failed_tx": c.failed_tx, "seals": c.seals, "reveals": c.reveals,
            "bad_seals": c.bad_seals, "clashes": c.clashes, "skips": c.skips, "tickets": c.tickets,
            "explores": c.explores},
        "findings": r.findings.iter().map(finding_json).collect::<Vec<_>>(),
        "liveness": {
            "valid_unrevealed": l.valid_unrevealed.iter().map(|(h, b, sigs)| json!({"host_id": h.to_string(), "arrive_bell": b, "attempts": sigs})).collect::<Vec<_>>(),
            "unrevealed_by_rule": l.unrevealed_by_rule.iter().map(|x| json!({"host_id": x.host.to_string(), "arrive_bell": x.arrive, "outcome": x.outcome, "reason": x.reason, "failed_attempts": x.failed_attempts})).collect::<Vec<_>>(),
            "unrevealed_by_reason": crate::checks::v5_seals::reason::ALL.iter().map(|&k| (k.to_string(), json!(l.unrevealed_by_rule.iter().filter(|x| x.reason == k).count()))).collect::<serde_json::Map<_, _>>(),
            "reveals_near_close": l.reveals_near_close,
            "max_anchor_delay_s": l.max_anchor_delay_s,
            "contested_bells": l.contested_bells.iter().map(|(p, q, b)| json!([p, q, b])).collect::<Vec<_>>(),
        },
        "checks_run": r.checks_run,
        "provenance": r.provenance,
        "history": r.history,
        "mutated_build": crate::mutated(),
    });
    if r.checks_run.iter().any(|c| c.starts_with("CQ")) && !r.checks_run.contains(&"V5") {
        out["liveness"] = Value::Null;
    }
    out
}

pub fn markdown(r: &Report) -> String {
    let mut s = String::new();
    if let Some(m) = crate::mutated() {
        s.push_str(&format!(
            "> **MUTATED BUILD ({m}): a check is disabled; this is not a verification.**\n\n"
        ));
    }
    s.push_str(&format!(
        "# Frontier verifier report: **{}**\n\n",
        r.verdict.name()
    ));
    s.push_str(&format!(
        "- Season {} of program `{}`, slots {}–{}, {} bells, {} program accounts\n",
        r.season, r.program, r.slot_range.0, r.slot_range.1, r.bells, r.entities
    ));
    if !r.provenance.is_empty() {
        s.push_str(&format!("- Input: {}\n", r.provenance));
    }
    if let Some(h) = &r.history {
        s.push_str(&format!(
            "- History: source {}, basis {}{}{}\n",
            h["source"].as_str().unwrap_or("?"),
            h["basis"].as_str().unwrap_or("?"),
            h["state"]
                .as_str()
                .map(|x| format!(", coverage {x}"))
                .unwrap_or_default(),
            if h["complete"] == serde_json::json!(false) {
                " — not shown to be the whole history"
            } else {
                " — dataset-only verdict, not a whole-chain claim"
            }
        ));
    }
    if let Some(w) = r.history.as_ref().and_then(|h| h.get("witness")) {
        s.push_str(&format!(
            "- Witness (VS, ⑰ Q-P1 (b)): {} source(s) {}; {}: {} transactions, {} blocks, {} program accounts compared; (a) VG exact end state: {}\n",
            w["sources"].as_array().map_or(0, |a| a.len()),
            w["sources"],
            if w["agrees"] == serde_json::json!(true) {
                "every item agrees".to_string()
            } else {
                format!("{} disagreement(s) or unread item(s)", w["findings"])
            },
            w["transactions"],
            w["blocks"],
            w["programAccounts"],
            w["vgExact"]
        ));
        if r.history.as_ref().and_then(|h| h["basis"].as_str()) == Some("witnessed") {
            s.push_str(&format!(
                "- Trust that remains: {}\n",
                w["residual"].as_str().unwrap_or("")
            ));
        }
    }
    if let Some(b) = r
        .history
        .as_ref()
        .and_then(|h| h["failBasis"].as_array())
        .filter(|b| !b.is_empty())
    {
        let h = r.history.as_ref().unwrap();
        let why: Vec<String> = b
            .iter()
            .filter_map(|x| x.as_str())
            .map(|x| match x {
                "self_contained" => format!(
                    "{} FAIL finding(s) decided inside fetched transactions (self-contained, ⑪)",
                    h["selfContainedFails"]
                ),
                "vg_witnessed" => format!(
                    "VG's {} FAIL finding(s) (the pinned program re-executed from the Season's creation) over a history every witness served identically (VS; ⑰ Q-P2 — agreement lifts for FAIL only, never for PASS)",
                    h["vgFails"]
                ),
                o => o.to_string(),
            })
            .collect();
        s.push_str(&format!(
            "- FAIL rests on (history not shown whole): {}\n",
            why.join("; and ")
        ));
    }
    s.push_str(&format!("- Checks run: {}\n", r.checks_run.join(", ")));
    let c = &r.counts;
    s.push_str(&format!(
        "- Transactions {} ({} failed); seals {}, reveals {}, bad seals {}, clashes {}, skips {}, tickets {}, explores {}\n",
        c.tx, c.failed_tx, c.seals, c.reveals, c.bad_seals, c.clashes, c.skips, c.tickets, c.explores
    ));
    if r.checks_run.iter().any(|c| c.starts_with("CQ")) && !r.checks_run.contains(&"V5") {
        s.push_str("- Liveness, seal cryptography and full combat/economy replay: not assessed by this CQ audit.\n\n");
    } else {
        let l = &r.liveness;
        s.push_str(&format!(
        "- Liveness: {} valid seals unrevealed and routed ({} more unrevealed by rule: {}), {} reveals near the close, largest anchor delay {:.1} s, {} contested province-bells\n\n",
        l.valid_unrevealed.len(),
        l.unrevealed_by_rule.len(),
        crate::checks::v5_seals::reason::ALL
            .iter()
            .map(|&k| format!("{k} {}", l.unrevealed_by_rule.iter().filter(|x| x.reason == k).count()))
            .collect::<Vec<_>>()
            .join(", "),
        l.reveals_near_close,
        l.max_anchor_delay_s,
        l.contested_bells.len()
    ));
    }
    if r.findings.is_empty() {
        s.push_str("No findings.\n");
        return s;
    }
    s.push_str("| Severity | Check | Code | Entity | Bell | Detail |\n|---|---|---|---|---|---|\n");
    for f in &r.findings {
        s.push_str(&format!(
            "| {} | {} | `{}` | {} | {} | {} |\n",
            sev(f.severity),
            f.check,
            f.code,
            f.entity,
            f.bell,
            f.detail.replace('|', "\\|")
        ));
    }
    s
}
