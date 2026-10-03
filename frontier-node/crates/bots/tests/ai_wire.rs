//! The golden wire fixture of `POST /v1/decide` and `POST /v1/outcome`
//! (contract §4.1): `permutation-gateway/test/fixtures/ai-decide-v1.json`.
//!
//! **One producer** (this test with `AI_WRITE_VECTORS=1`), **one freshness
//! checker** (the same test without the flag; M1 §3.5). The request is what
//! the real brain posts when it steps the fixture wallet of the agents'
//! herald world; the answer is a model answer written by this test from the
//! request's own candidates; the outcome is what the brain posts back after
//! sending. The Node schema test `citizens-mind-schema.test.mjs` validates
//! the same file. Wall-clock fields are pinned (`deadline_unix_ms`), the
//! relay's signature is a fixed string.

#[path = "ai_common.rs"]
mod common;

use common::*;
use serde_json::{json, Value};

const DEADLINE_PIN: u64 = 1_790_000_000_000;

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/test/fixtures/ai-decide-v1.json")
}

/// Samples of the candidate kinds AC3b adds (the Strike-Order march, a recall,
/// a raid), hand-written in the §4.3 shape so the Node schema covers them.
fn ac3b_samples() -> Value {
    json!([
        {"id": "c3", "kind": "march", "label": "Follow the Strike Order with H1 (420 troops)",
         "facts": {"host": "H1", "host_id": "3377699720527873", "troops": 420, "target_kind": "call",
                   "target": {"p": 2, "q": -3, "tile": 17}, "hexes": 11, "provinces": 2,
                   "earliest_bell": 410, "strike_bell": 413, "enemy_troops": 0, "ratio": "even",
                   "ratio_is": "estimate", "shield": "not applicable", "idle_bells": 4,
                   "reward": "troops lost only; no land can be taken"},
         "params": {"stance": ["hold", "assault", "flank", "brace"], "retreat": [0, 5000, 10000], "timing": ["call"]},
         "flags": {"council": true}, "troops": 420, "entities": ["pq:2,-3", "nation:3"]},
        {"id": "c4", "kind": "recall:H2", "label": "Recall H2 (300 troops) to the village",
         "facts": {"host": "H2", "host_id": "3377699720527874", "troops": 300, "threat_origin": {"p": 4, "q": -1},
                   "threat_mass": 800, "threat_arrive_bell": 409, "destination": "unknown", "home_by_arrival": true},
         "params": {"timing": ["earliest"]}, "flags": {}, "troops": 300, "entities": ["pq:4,-1", "nation:2"]},
        {"id": "c8", "kind": "march", "label": "March H1 (420 troops) to another nation's village, 9 hexes away",
         "facts": {"host": "H1", "host_id": "3377699720527873", "troops": 420, "target_kind": "raid",
                   "target": {"p": 3, "q": 1, "tile": 9}, "hexes": 9, "provinces": 2, "earliest_bell": 409,
                   "enemy_troops": 260, "ratio": "favourable", "ratio_is": "estimate",
                   "shield": "ended", "idle_bells": 2, "reward": "troops lost only; no land can be taken"},
         "params": {"stance": ["hold", "assault", "flank", "brace"], "retreat": [0, 5000, 10000], "timing": ["earliest"]},
         "flags": {}, "troops": 420, "entities": ["pq:3,1", "nation:1"]}
    ])
}

/// Runs the brain on the fixture wallet twice (an autopilot answer, then a
/// model answer) and returns the fixture value.
async fn produce() -> Value {
    // Pass 1: a closed gate (mode autopilot); the request is captured.
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(frontier_agents::fixture::FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let mut request = fm.requests.lock().unwrap()[0].clone();
    request["deadline_unix_ms"] = json!(DEADLINE_PIN);
    let answer_autopilot = autopilot_answer("below_gate");
    // Pass 2: a model answer built from the request's candidates.
    let pick = cand_id(&request, "march")
        .or_else(|| cand_id(&request, "build"))
        .or_else(|| cand_id(&request, "hold"))
        .expect("a candidate");
    let params = if pick.is_empty() {
        json!({})
    } else {
        json!({pick.clone(): {"stance": "assault", "retreat": 5000, "timing": "earliest"}})
    };
    let is_march = request["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == pick && c["kind"] == "march");
    let answer = json!({
        "v": 1, "decision_id": "d-0123456789abcdef", "mode": "model", "reason": "ok",
        "choice": {"ids": [pick], "params": if is_march { params } else { json!({}) }, "mem": []},
        "standing": {"reserved": [], "declined_calls": []},
        "caps": {"march_troops_left": 600, "home_floor": 400},
        "social": {"say": [], "motion": null, "ballot": null},
    });
    let ans2 = answer.clone();
    let fm2 = FakeMind::start(move |_| ans2.clone()).await;
    let r2 = rig(Some(&fm2), &[(frontier_agents::fixture::FINAL, "ai")]);
    let mut bot2 = ai_bot();
    bot2.step(&r2.sh, true).await;
    let outcome = fm2.outcomes.lock().unwrap().last().cloned().expect("an outcome");
    let mut request2 = fm2.requests.lock().unwrap()[0].clone();
    request2["deadline_unix_ms"] = json!(DEADLINE_PIN);
    assert_eq!(request, request2, "the same step posts the same request");
    json!({
        "note": "Golden wire fixture of POST /v1/decide and /v1/outcome (contract v1.2 §4.1, §8.1). Producer: frontier-node/crates/bots/tests/ai_wire.rs (AI_WRITE_VECTORS=1); freshness checker: the same test without the flag; the Node schema test validates it. u64 ids (host_id) are decimal strings; ai.tag is the citizen_tag as 16 hex digits; deadline_unix_ms is pinned; the relay signature is fixed.",
        "v": 1,
        "request": request,
        "answer": answer,
        "answer_autopilot": answer_autopilot,
        "outcome": outcome,
        "outcome_answer": {"ok": true},
        "candidate_samples_ac3b": ac3b_samples(),
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_golden_decide_fixture_is_fresh() {
    let v = produce().await;
    let mut text = serde_json::to_string_pretty(&v).unwrap();
    text.push('\n');
    let p = fixture_path();
    if std::env::var("AI_WRITE_VECTORS").is_ok() {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, &text).unwrap();
    }
    let on_disk = std::fs::read_to_string(&p)
        .expect("fixture missing: AI_WRITE_VECTORS=1 cargo test -p bots --test ai_wire");
    assert!(
        on_disk == text,
        "ai-decide-v1.json is stale: AI_WRITE_VECTORS=1 cargo test -p bots --test ai_wire"
    );
}
