//! Multi-turn PLANS of a resident's own local orders (2026-11-22,
//! reports/playable-2-3-4-13.md §2 step 3): workstream 04's store as the
//! executor of a plan that a workstream 13 resident runs in its OWN process
//! on a local-play TEST world. The resident signs and sends; this module
//! decides, durably, what may be signed next and what a step's fate is.
//!
//! A plan is an ordered list of steps, each one of the six orders a
//! person's page has in local play (Join, PlaceHome, Harvest, Build, Train,
//! Muster). Caravan orders are refused: they are not on the local act relay
//! and their place in a plan is owner question Q4.
//!
//! The same five rules as the caravan runs (README.ja.md 中心となる考え方),
//! for one-transaction steps:
//!
//! 1. **identity** — a step is `(plan_id, idx)`; its attempts are counted and
//!    capped (`maxAttempts`), and a plan id with another spec is a Conflict.
//! 2. **intent first** — `intend` is written before anything is signed;
//!    `signed` records the signature BEFORE the one submit. A caller whose
//!    `signed` is refused must not submit (the fence below).
//! 3. **canonical settle** — `landed` / `failed` are accepted only for the
//!    signature that was recorded, from the caller's read of the chain by
//!    that signature. An answer of the relay alone never advances the plan.
//! 4. **no second attempt while one may land** — a step whose signature is
//!    recorded (`signed`, `unknown`) blocks every other step of the owner
//!    until it is settled; `not-sent` (nothing reached the chain) reopens
//!    it; `expired-unknown` (no landing seen within the blockhash life) is
//!    final and STOPS the plan: the next plan is made from what the chain
//!    then shows, never by sending the step again.
//! 5. **fence** — every write carries `(holder, epoch)`; a new holder's
//!    claim raises the epoch, so a stopped process that wakes up can neither
//!    record a signature nor settle (exit 6 `Fenced`). Its unsigned intents
//!    become `not-sent` on the claim: nothing of them can have left.
//!
//! One action per turn (the world's rule, owner Q16-2) is kept here too,
//! across all plans of the owner in one world: a step is not intended in a
//! turn already used by another step that got further than `not-sent`
//! (a Join is not counted, as the relay's `--resident-turns` does not).
//! A chain refusal (`failed`, `refused`) stops the plan: replanning is the
//! resident's, from a fresh observation, as a new plan that `replaces` it.

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::Store;

pub const PLAN_SCHEMA: &str = "p04-plan/0.1";
pub const PLAN_VIEW: &str = "p04-plan-view/0.1";
/// The six orders of a local-play page (flocalplay-act.mjs LOCAL_ACT_NAMES' first six).
pub const LOCAL_ORDERS: [&str; 6] = ["Join", "PlaceHome", "Harvest", "Build", "Train", "Muster"];
pub const MAX_STEPS: usize = 64;
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
/// Step states. `pending` and `not-sent` may be intended; `signed` and
/// `unknown` are open (a signature exists, the fate is not known yet).
pub const STEP_STATES: [&str; 9] = [
    "pending", "intended", "signed", "unknown", "landed", "failed", "refused", "not-sent", "expired-unknown",
];
pub const OPEN: [&str; 2] = ["signed", "unknown"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanErr {
    pub exit: u8,
    pub code: &'static str,
    pub message: String,
}

fn err(exit: u8, code: &'static str, m: impl Into<String>) -> PlanErr {
    PlanErr { exit, code, message: m.into() }
}
pub fn bad(m: impl Into<String>) -> PlanErr {
    err(2, "BadRequest", m)
}
fn refused(code: &'static str, m: impl Into<String>) -> PlanErr {
    err(7, code, m)
}
fn store_err(e: impl ToString) -> PlanErr {
    err(1, "StoreError", e.to_string())
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, PlanErr> {
    r.map_err(store_err)
}

/// Creates the tables (idempotent).
pub fn init(store: &Store) -> Result<(), PlanErr> {
    sql(store.conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plans(plan_id TEXT PRIMARY KEY, owner TEXT NOT NULL, world TEXT NOT NULL,
             spec TEXT NOT NULL, spec_digest TEXT NOT NULL, state TEXT NOT NULL, stop_reason TEXT,
             cursor INTEGER NOT NULL, version INTEGER NOT NULL, max_attempts INTEGER NOT NULL, replaces TEXT,
             lease_holder TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease_epoch INTEGER NOT NULL DEFAULT 0,
             created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS plans_owner ON plans(owner, world, state);
         CREATE TABLE IF NOT EXISTS plan_steps(plan_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL,
             fields TEXT NOT NULL, expect TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
             signature TEXT UNIQUE, bell INTEGER, booked_bell INTEGER, code TEXT, updated_ms INTEGER NOT NULL,
             PRIMARY KEY(plan_id, idx));
         CREATE TABLE IF NOT EXISTS plan_log(plan_id TEXT NOT NULL, version INTEGER NOT NULL, at_ms INTEGER NOT NULL,
             step INTEGER, from_state TEXT, to_state TEXT NOT NULL, holder TEXT, why TEXT NOT NULL,
             UNIQUE(plan_id, version));",
    ))
}

/// One write transaction (BEGIN IMMEDIATE: one writer at a time across processes).
fn tx<T>(store: &Store, f: impl FnOnce() -> Result<T, PlanErr>) -> Result<T, PlanErr> {
    init(store)?;
    sql(store.conn.execute_batch("BEGIN IMMEDIATE"))?;
    match f() {
        Ok(v) => {
            sql(store.conn.execute_batch("COMMIT"))?;
            Ok(v)
        }
        Err(e) => {
            let _ = store.conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[derive(Debug, Clone)]
struct PlanRow {
    owner: String,
    world: String,
    state: String,
    cursor: i64,
    version: i64,
    max_attempts: i64,
    lease_holder: Option<String>,
    lease_until: i64,
    lease_epoch: i64,
    steps: i64,
}

fn load(store: &Store, plan: &str) -> Result<Option<PlanRow>, PlanErr> {
    sql(store
        .conn
        .query_row(
            "SELECT owner, world, state, cursor, version, max_attempts, lease_holder, lease_until, lease_epoch,
                    (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = p.plan_id)
             FROM plans p WHERE plan_id = ?1",
            params![plan],
            |r| {
                Ok(PlanRow {
                    owner: r.get(0)?,
                    world: r.get(1)?,
                    state: r.get(2)?,
                    cursor: r.get(3)?,
                    version: r.get(4)?,
                    max_attempts: r.get(5)?,
                    lease_holder: r.get(6)?,
                    lease_until: r.get(7)?,
                    lease_epoch: r.get(8)?,
                    steps: r.get(9)?,
                })
            },
        )
        .optional())
}

fn must(store: &Store, plan: &str) -> Result<PlanRow, PlanErr> {
    load(store, plan)?.ok_or_else(|| err(3, "NoRecord", format!("no plan {plan}")))
}

fn log(store: &Store, plan: &str, p: &PlanRow, now: i64, step: Option<i64>, from: Option<&str>, to: &str, holder: Option<&str>, why: &str) -> Result<i64, PlanErr> {
    let v = p.version + 1;
    sql(store.conn.execute(
        "INSERT INTO plan_log(plan_id, version, at_ms, step, from_state, to_state, holder, why) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![plan, v, now, step, from, to, holder, why],
    ))?;
    sql(store.conn.execute("UPDATE plans SET version = ?2, updated_ms = ?3 WHERE plan_id = ?1", params![plan, v, now]))?;
    Ok(v)
}

fn digest(v: &Value) -> String {
    hex::encode(Sha256::digest(v.to_string().as_bytes()))
}

fn short_text(v: &Value, k: &str, max: usize) -> Result<String, PlanErr> {
    match v.get(k).and_then(Value::as_str) {
        Some(s) if !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic()) => Ok(s.to_string()),
        _ => Err(bad(format!("{k}: a printable ASCII text of 1..={max} bytes"))),
    }
}

/// Checks a spec; → (plan id, owner, world, replaces, max attempts, steps).
#[allow(clippy::type_complexity)]
fn check_spec(spec: &Value) -> Result<(String, String, String, Option<String>, u32, Vec<Value>), PlanErr> {
    let o = spec.as_object().ok_or_else(|| bad("the spec is a JSON object"))?;
    for k in o.keys() {
        if !["schema", "planId", "owner", "world", "replaces", "maxAttempts", "steps", "goal", "note"].contains(&k.as_str()) {
            return Err(bad(format!("unknown member {k}")));
        }
    }
    if spec.get("schema").and_then(Value::as_str) != Some(PLAN_SCHEMA) {
        return Err(bad(format!("schema must be {PLAN_SCHEMA}")));
    }
    let id = short_text(spec, "planId", 96)?;
    let owner = short_text(spec, "owner", 64)?;
    let world = short_text(spec, "world", 128)?;
    let replaces = match spec.get("replaces") {
        None | Some(Value::Null) => None,
        Some(_) => Some(short_text(spec, "replaces", 96)?),
    };
    let max = match spec.get("maxAttempts") {
        None => DEFAULT_MAX_ATTEMPTS,
        Some(v) => match v.as_u64() {
            Some(n @ 1..=10) => n as u32,
            _ => return Err(bad("maxAttempts: 1..=10")),
        },
    };
    let steps = spec.get("steps").and_then(Value::as_array).ok_or_else(|| bad("steps: an array"))?;
    if steps.is_empty() || steps.len() > MAX_STEPS {
        return Err(bad(format!("steps: 1..={MAX_STEPS}")));
    }
    for (i, s) in steps.iter().enumerate() {
        let so = s.as_object().ok_or_else(|| bad(format!("steps[{i}] is an object")))?;
        for k in so.keys() {
            if !["name", "fields", "expect", "note"].contains(&k.as_str()) {
                return Err(bad(format!("steps[{i}]: unknown member {k}")));
            }
        }
        let name = s.get("name").and_then(Value::as_str).unwrap_or("");
        if name.contains("Caravan") {
            return Err(err(2, "NotLocalOrder", format!("steps[{i}]: {name} is not a local order (caravans in plans are owner question Q4)")));
        }
        if !LOCAL_ORDERS.contains(&name) {
            return Err(err(2, "NotLocalOrder", format!("steps[{i}]: name must be one of {}", LOCAL_ORDERS.join(", "))));
        }
        if !s.get("fields").is_some_and(Value::is_object) {
            return Err(bad(format!("steps[{i}].fields is an object")));
        }
        if s.get("expect").is_some_and(|e| !e.is_object()) {
            return Err(bad(format!("steps[{i}].expect is an object")));
        }
    }
    Ok((id, owner, world, replaces, max, steps.clone()))
}

/// Stores a plan. The same id with the same spec answers the stored plan
/// (`replayed: true`, nothing written); another spec is exit 4 Conflict. An
/// owner has at most one active plan per world (exit 7 `ActivePlan`); a plan
/// that `replaces` another needs that one stopped or done, of the same owner.
pub fn accept(store: &Store, spec: &Value, now: i64) -> Result<Value, PlanErr> {
    let (id, owner, world, replaces, max, steps) = check_spec(spec)?;
    let d = digest(spec);
    let replayed = tx(store, || {
        if let Some(old) = sql(store
            .conn
            .query_row("SELECT spec_digest FROM plans WHERE plan_id = ?1", params![id], |r| r.get::<_, String>(0))
            .optional())?
        {
            return if old == d { Ok(true) } else { Err(err(4, "Conflict", format!("plan {id} is stored with another spec"))) };
        }
        let active: Option<String> = sql(store
            .conn
            .query_row(
                "SELECT plan_id FROM plans WHERE owner = ?1 AND world = ?2 AND state = 'active'",
                params![owner, world],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(a) = active {
            return Err(refused("ActivePlan", format!("plan {a} of this owner is still active in this world: stop it first")));
        }
        if let Some(r) = &replaces {
            let p = must(store, r)?;
            if p.owner != owner || p.world != world {
                return Err(bad(format!("replaces {r}: another owner or world")));
            }
        }
        sql(store.conn.execute(
            "INSERT INTO plans(plan_id, owner, world, spec, spec_digest, state, cursor, version, max_attempts, replaces, created_ms, updated_ms)
             VALUES (?1,?2,?3,?4,?5,'active',0,0,?6,?7,?8,?8)",
            params![id, owner, world, spec.to_string(), d, max, replaces, now],
        ))?;
        for (i, s) in steps.iter().enumerate() {
            sql(store.conn.execute(
                "INSERT INTO plan_steps(plan_id, idx, name, fields, expect, state, updated_ms) VALUES (?1,?2,?3,?4,?5,'pending',?6)",
                params![
                    id,
                    i as i64,
                    s["name"].as_str().unwrap(),
                    s["fields"].to_string(),
                    s.get("expect").cloned().unwrap_or(json!({})).to_string(),
                    now
                ],
            ))?;
        }
        let p = must(store, &id)?;
        log(store, &id, &p, now, None, None, "active", None, &format!("accepted {} step(s)", steps.len()))?;
        Ok(false)
    })?;
    let mut v = view(store, &id)?;
    v["replayed"] = json!(replayed);
    Ok(v)
}

/// Claims (or renews) the plan's lease. A new holder may claim only a free
/// or expired lease; it raises the epoch and turns the plan's unsigned
/// intents into `not-sent`. → `{granted, holder, epoch, until, resetIntents}`.
pub fn claim(store: &Store, plan: &str, holder: &str, lease_ms: i64, now: i64) -> Result<Value, PlanErr> {
    if holder.is_empty() || holder.len() > 96 || !(1_000..=600_000).contains(&lease_ms) {
        return Err(bad("--holder (1..=96 bytes) and --lease-ms 1000..=600000"));
    }
    tx(store, || {
        let p = must(store, plan)?;
        let mine = p.lease_holder.as_deref() == Some(holder);
        if !mine && p.lease_holder.is_some() && p.lease_until > now {
            return Ok(json!({ "granted": false, "holder": p.lease_holder, "epoch": p.lease_epoch, "until": p.lease_until }));
        }
        let epoch = if mine { p.lease_epoch } else { p.lease_epoch + 1 };
        let until = now + lease_ms;
        sql(store.conn.execute(
            "UPDATE plans SET lease_holder = ?2, lease_until = ?3, lease_epoch = ?4 WHERE plan_id = ?1",
            params![plan, holder, until, epoch],
        ))?;
        let mut reset = 0;
        if !mine {
            reset = sql(store.conn.execute(
                "UPDATE plan_steps SET state = 'not-sent', code = 'NewHolder', updated_ms = ?2
                 WHERE plan_id = ?1 AND state = 'intended' AND signature IS NULL",
                params![plan, now],
            ))?;
            let p = must(store, plan)?;
            log(store, plan, &p, now, None, None, &p.state, Some(holder), &format!("claimed at epoch {epoch}; {reset} unsigned intent(s) → not-sent"))?;
        }
        Ok(json!({ "granted": true, "holder": holder, "epoch": epoch, "until": until, "resetIntents": reset }))
    })
}

fn fence(p: &PlanRow, holder: &str, epoch: i64, now: i64) -> Result<(), PlanErr> {
    if p.lease_holder.as_deref() != Some(holder) || p.lease_epoch != epoch {
        return Err(err(6, "Fenced", format!("the plan is held by {:?} at epoch {}: this holder must not sign, send or settle", p.lease_holder, p.lease_epoch)));
    }
    if p.lease_until <= now {
        return Err(err(6, "Fenced", "this holder's lease ran out: claim it again first"));
    }
    Ok(())
}

fn step_state(store: &Store, plan: &str, idx: i64) -> Result<(String, String, i64, Option<String>), PlanErr> {
    sql(store
        .conn
        .query_row(
            "SELECT state, name, attempts, signature FROM plan_steps WHERE plan_id = ?1 AND idx = ?2",
            params![plan, idx],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional())?
    .ok_or_else(|| bad(format!("plan {plan} has no step {idx}")))
}

/// Open steps (a recorded signature, fate unknown) of the owner in the world, across plans.
fn open_of(store: &Store, owner: &str, world: &str) -> Result<Vec<(String, i64, String)>, PlanErr> {
    let mut st = sql(store.conn.prepare(
        "SELECT s.plan_id, s.idx, s.state FROM plan_steps s JOIN plans p ON p.plan_id = s.plan_id
         WHERE p.owner = ?1 AND p.world = ?2 AND s.state IN ('signed','unknown','intended') ORDER BY s.plan_id, s.idx",
    ))?;
    let rows = sql(st.query_map(params![owner, world], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(store_err)
}

/// Writes the intent for step `idx` in turn `bell`, before anything is signed.
pub fn intend(store: &Store, plan: &str, holder: &str, epoch: i64, idx: i64, bell: i64, now: i64) -> Result<Value, PlanErr> {
    if bell < 0 {
        return Err(bad("--bell >= 0"));
    }
    tx(store, || {
        let p = must(store, plan)?;
        fence(&p, holder, epoch, now)?;
        if p.state != "active" {
            return Err(refused("Stopped", format!("plan {plan} is {}", p.state)));
        }
        if idx != p.cursor {
            return Err(refused("NotDue", format!("step {idx} is not due: the plan is at step {}", p.cursor)));
        }
        let (state, name, attempts, _) = step_state(store, plan, idx)?;
        if !["pending", "not-sent"].contains(&state.as_str()) {
            return Err(refused("NotDue", format!("step {idx} is {state}")));
        }
        if let Some((op, oi, os)) = open_of(store, &p.owner, &p.world)?.into_iter().next() {
            return Err(refused("OpenStep", format!("step {oi} of plan {op} is {os}: nothing new until it is settled")));
        }
        if attempts >= p.max_attempts {
            sql(store.conn.execute("UPDATE plans SET state = 'stopped', stop_reason = ?2 WHERE plan_id = ?1", params![plan, format!("attempts: step {idx} never reached the chain in {attempts} attempt(s)")]))?;
            let p2 = must(store, plan)?;
            log(store, plan, &p2, now, Some(idx), Some(&state), "stopped", Some(holder), "attempts exhausted")?;
            // (committed: the stop is kept, and the caller still hears the refusal)
            return Ok(Some(refused("Exhausted", format!("step {idx}: {attempts} attempt(s) used; the plan is stopped"))));
        }
        if name != "Join" {
            let used: Option<(String, i64)> = sql(store
                .conn
                .query_row(
                    "SELECT s.plan_id, s.idx FROM plan_steps s JOIN plans p ON p.plan_id = s.plan_id
                     WHERE p.owner = ?1 AND p.world = ?2 AND s.name != 'Join'
                       AND s.state IN ('signed','unknown','landed','failed','refused','expired-unknown')
                       AND (s.bell = ?3 OR s.booked_bell >= ?3) LIMIT 1",
                    params![p.owner, p.world, bell],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            if let Some((up, ui)) = used {
                return Err(refused("TurnUsed", format!("turn {bell} is used by step {ui} of plan {up} (one action per turn)")));
            }
        }
        sql(store.conn.execute(
            "UPDATE plan_steps SET state = 'intended', attempts = attempts + 1, bell = ?3, code = NULL, updated_ms = ?4 WHERE plan_id = ?1 AND idx = ?2",
            params![plan, idx, bell, now],
        ))?;
        log(store, plan, &p, now, Some(idx), Some(&state), "intended", Some(holder), &format!("{name} in turn {bell}, attempt {}", attempts + 1))?;
        Ok(None)
    })?
    .map_or(Ok(()), Err)?;
    step_view(store, plan, idx)
}

fn sig_ok(s: &str) -> bool {
    (32..=96).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Records the signature of the intended step, BEFORE the one submit. A
/// caller that gets an error here must not submit the transaction.
pub fn signed(store: &Store, plan: &str, holder: &str, epoch: i64, idx: i64, sig: &str, now: i64) -> Result<Value, PlanErr> {
    if !sig_ok(sig) {
        return Err(bad("--signature: base58"));
    }
    tx(store, || {
        let p = must(store, plan)?;
        fence(&p, holder, epoch, now)?;
        let (state, _, _, _) = step_state(store, plan, idx)?;
        if state != "intended" {
            return Err(refused("NotIntended", format!("step {idx} is {state}: a signature is recorded only for the intended step")));
        }
        store
            .conn
            .execute(
                "UPDATE plan_steps SET state = 'signed', signature = ?3, updated_ms = ?4 WHERE plan_id = ?1 AND idx = ?2",
                params![plan, idx, sig, now],
            )
            .map_err(|e| if e.to_string().contains("UNIQUE") { err(4, "Conflict", "this signature is recorded for another step") } else { store_err(e) })?;
        log(store, plan, &p, now, Some(idx), Some("intended"), "signed", Some(holder), &format!("signature {sig}"))?;
        Ok(())
    })?;
    step_view(store, plan, idx)
}

/// Settles a step from the caller's reading. `landed` advances the plan
/// (done after the last step); `failed` / `refused` / `expired-unknown`
/// stop it (`stop_reason`); `not-sent` reopens the step; `unknown` keeps it
/// open. `landed` and `failed` need the recorded signature.
#[allow(clippy::too_many_arguments)]
pub fn settle(
    store: &Store,
    plan: &str,
    holder: &str,
    epoch: i64,
    idx: i64,
    outcome: &str,
    sig: Option<&str>,
    code: Option<&str>,
    booked_bell: Option<i64>,
    now: i64,
) -> Result<Value, PlanErr> {
    if !["landed", "failed", "refused", "not-sent", "unknown", "expired-unknown"].contains(&outcome) {
        return Err(bad("--outcome landed|failed|refused|not-sent|unknown|expired-unknown"));
    }
    if code.is_some_and(|c| c.is_empty() || c.len() > 64 || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'(' || b == b')')) {
        return Err(bad("--code: 1..=64 of [A-Za-z0-9_()]"));
    }
    tx(store, || {
        let p = must(store, plan)?;
        fence(&p, holder, epoch, now)?;
        let (state, name, _, recorded) = step_state(store, plan, idx)?;
        let allowed: &[&str] = match outcome {
            "landed" | "failed" | "expired-unknown" => &["signed", "unknown"],
            "unknown" => &["signed", "unknown"],
            "refused" => &["signed", "unknown", "intended"],
            _ => &["intended", "signed"],
        };
        if !allowed.contains(&state.as_str()) {
            return Err(refused("BadSettle", format!("step {idx} is {state}: it cannot become {outcome}")));
        }
        if ["landed", "failed"].contains(&outcome) && (recorded.is_none() || recorded.as_deref() != sig) {
            return Err(refused("BadSettle", format!("{outcome} needs the recorded signature of step {idx}")));
        }
        let keep_sig = outcome != "not-sent";
        sql(store.conn.execute(
            "UPDATE plan_steps SET state = ?3, code = ?4, booked_bell = COALESCE(?5, booked_bell), updated_ms = ?6,
                 signature = CASE WHEN ?7 THEN signature ELSE NULL END
             WHERE plan_id = ?1 AND idx = ?2",
            params![plan, idx, outcome, code, booked_bell, now, keep_sig],
        ))?;
        let v = log(store, plan, &p, now, Some(idx), Some(&state), outcome, Some(holder), &format!("{name}: {outcome}{}", code.map(|c| format!(" ({c})")).unwrap_or_default()))?;
        let p = PlanRow { version: v, ..p };
        match outcome {
            "landed" => {
                let next = idx + 1;
                let done = next >= p.steps;
                sql(store.conn.execute(
                    "UPDATE plans SET cursor = ?2, state = CASE WHEN ?3 THEN 'done' ELSE state END WHERE plan_id = ?1",
                    params![plan, next, done],
                ))?;
                if done {
                    log(store, plan, &p, now, None, Some("active"), "done", Some(holder), "every step landed")?;
                }
            }
            "failed" | "refused" | "expired-unknown" => {
                let why = match outcome {
                    "expired-unknown" => format!("outcome-unknown: step {idx} ({name}) was not seen landing within its blockhash life; replan from what the chain shows"),
                    _ => format!("chain-refused: step {idx} ({name}) {outcome}{}", code.map(|c| format!(" {c}")).unwrap_or_default()),
                };
                sql(store.conn.execute("UPDATE plans SET state = 'stopped', stop_reason = ?2 WHERE plan_id = ?1", params![plan, why]))?;
                log(store, plan, &p, now, None, Some("active"), "stopped", Some(holder), &why)?;
            }
            _ => {}
        }
        Ok(())
    })?;
    step_view(store, plan, idx)
}

/// Stops an active plan (the resident replans: state changed, a step is
/// held for good). Refused while a step is open (exit 7 `OpenStep`): it may
/// still land, and the next plan must see it. An unsigned intent becomes
/// `not-sent` (nothing left).
pub fn stop(store: &Store, plan: &str, holder: &str, epoch: i64, why: &str, now: i64) -> Result<Value, PlanErr> {
    if why.is_empty() || why.len() > 400 {
        return Err(bad("--why: 1..=400 bytes"));
    }
    tx(store, || {
        let p = must(store, plan)?;
        fence(&p, holder, epoch, now)?;
        if p.state != "active" {
            return Err(refused("Stopped", format!("plan {plan} is {}", p.state)));
        }
        let open: i64 = sql(store.conn.query_row(
            "SELECT COUNT(*) FROM plan_steps WHERE plan_id = ?1 AND state IN ('signed','unknown')",
            params![plan],
            |r| r.get(0),
        ))?;
        if open > 0 {
            return Err(refused("OpenStep", "a step's signature is recorded and its fate unknown: settle it first"));
        }
        sql(store.conn.execute("UPDATE plan_steps SET state = 'not-sent', code = 'Stopped' WHERE plan_id = ?1 AND state = 'intended'", params![plan]))?;
        sql(store.conn.execute("UPDATE plans SET state = 'stopped', stop_reason = ?2 WHERE plan_id = ?1", params![plan, format!("replan: {why}")]))?;
        log(store, plan, &p, now, None, Some("active"), "stopped", Some(holder), why)?;
        Ok(())
    })?;
    view(store, plan)
}

fn step_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let fields: String = r.get(2)?;
    let expect: String = r.get(3)?;
    Ok(json!({
        "idx": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
        "fields": serde_json::from_str::<Value>(&fields).unwrap_or(Value::Null),
        "expect": serde_json::from_str::<Value>(&expect).unwrap_or(Value::Null),
        "state": r.get::<_, String>(4)?, "attempts": r.get::<_, i64>(5)?, "signature": r.get::<_, Option<String>>(6)?,
        "bell": r.get::<_, Option<i64>>(7)?, "bookedBell": r.get::<_, Option<i64>>(8)?, "code": r.get::<_, Option<String>>(9)?,
        "updatedMs": r.get::<_, i64>(10)?,
    }))
}
const STEP_COLS: &str = "idx, name, fields, expect, state, attempts, signature, bell, booked_bell, code, updated_ms";

pub fn step_view(store: &Store, plan: &str, idx: i64) -> Result<Value, PlanErr> {
    let s = sql(store.conn.query_row(
        &format!("SELECT {STEP_COLS} FROM plan_steps WHERE plan_id = ?1 AND idx = ?2"),
        params![plan, idx],
        step_json,
    ))?;
    let p = must(store, plan)?;
    Ok(json!({ "view": PLAN_VIEW, "planId": plan, "planState": p.state, "cursor": p.cursor, "epoch": p.lease_epoch, "step": s }))
}

/// The whole plan: state, cursor, lease, steps, transitions.
pub fn view(store: &Store, plan: &str) -> Result<Value, PlanErr> {
    init(store)?;
    let (spec, state, stop_reason, cursor, version, replaces, holder, until, epoch, max): (String, String, Option<String>, i64, i64, Option<String>, Option<String>, i64, i64, i64) = sql(store
        .conn
        .query_row(
            "SELECT spec, state, stop_reason, cursor, version, replaces, lease_holder, lease_until, lease_epoch, max_attempts FROM plans WHERE plan_id = ?1",
            params![plan],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        )
        .optional())?
    .ok_or_else(|| err(3, "NoRecord", format!("no plan {plan}")))?;
    let spec: Value = serde_json::from_str(&spec).map_err(store_err)?;
    let mut st = sql(store.conn.prepare(&format!("SELECT {STEP_COLS} FROM plan_steps WHERE plan_id = ?1 ORDER BY idx")))?;
    let steps = sql(st.query_map(params![plan], step_json))?.collect::<rusqlite::Result<Vec<_>>>().map_err(store_err)?;
    let mut lt = sql(store.conn.prepare("SELECT version, at_ms, step, from_state, to_state, holder, why FROM plan_log WHERE plan_id = ?1 ORDER BY version"))?;
    let logs = sql(lt.query_map(params![plan], |r| {
        Ok(json!({ "version": r.get::<_, i64>(0)?, "atMs": r.get::<_, i64>(1)?, "step": r.get::<_, Option<i64>>(2)?, "from": r.get::<_, Option<String>>(3)?,
                   "to": r.get::<_, String>(4)?, "holder": r.get::<_, Option<String>>(5)?, "why": r.get::<_, String>(6)? }))
    }))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(store_err)?;
    let landed = steps.iter().filter(|s| s["state"] == "landed").count();
    Ok(json!({
        "view": PLAN_VIEW, "planId": plan, "owner": spec["owner"], "world": spec["world"], "goal": spec.get("goal").cloned().unwrap_or(Value::Null),
        "state": state, "stopReason": stop_reason, "cursor": cursor, "version": version, "replaces": replaces, "maxAttempts": max,
        "lease": { "holder": holder, "until": until, "epoch": epoch }, "landed": landed, "steps": steps, "transitions": logs,
    }))
}

/// The owner's active plan in the world (or the last one stopped or done:
/// `latest`), and every open step of the owner there, across plans.
pub fn current(store: &Store, owner: &str, world: &str) -> Result<Value, PlanErr> {
    init(store)?;
    let active: Option<String> = sql(store
        .conn
        .query_row("SELECT plan_id FROM plans WHERE owner = ?1 AND world = ?2 AND state = 'active'", params![owner, world], |r| r.get(0))
        .optional())?;
    let latest: Option<String> = sql(store
        .conn
        .query_row(
            "SELECT plan_id FROM plans WHERE owner = ?1 AND world = ?2 ORDER BY created_ms DESC, rowid DESC LIMIT 1",
            params![owner, world],
            |r| r.get(0),
        )
        .optional())?;
    let mut st = sql(store.conn.prepare(&format!(
        "SELECT s.plan_id, {} FROM plan_steps s JOIN plans p ON p.plan_id = s.plan_id
         WHERE p.owner = ?1 AND p.world = ?2 AND s.state IN ('signed','unknown') ORDER BY s.plan_id, s.idx",
        STEP_COLS.split(", ").map(|c| format!("s.{c}")).collect::<Vec<_>>().join(", ")
    )))?;
    let open = sql(st.query_map(params![owner, world], |r| {
        let plan: String = r.get(0)?;
        let fields: String = r.get(3)?;
        Ok(json!({ "planId": plan, "idx": r.get::<_, i64>(1)?, "name": r.get::<_, String>(2)?, "fields": serde_json::from_str::<Value>(&fields).unwrap_or(Value::Null),
                   "state": r.get::<_, String>(5)?, "signature": r.get::<_, Option<String>>(7)?, "bell": r.get::<_, Option<i64>>(8)?,
                   "updatedMs": r.get::<_, i64>(11)? }))
    }))?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(store_err)?;
    let plans: i64 = sql(store.conn.query_row("SELECT COUNT(*) FROM plans WHERE owner = ?1 AND world = ?2", params![owner, world], |r| r.get(0)))?;
    Ok(json!({
        "view": PLAN_VIEW, "owner": owner, "world": world, "plans": plans,
        "active": match &active { Some(a) => view(store, a)?, None => Value::Null },
        "latest": match (&active, &latest) { (None, Some(l)) => view(store, l)?, _ => Value::Null },
        "open": open,
    }))
}
