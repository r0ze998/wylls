//! Agent acts as runs (workstreams 03 and 05): one game action an agent sent
//! through the agent wallet's gateway (an MCP client's call, workstream 05's
//! autopilot) registered under workstream 04's run id, with one receipt that
//! says the same things in the same words as the caravan runs:
//!
//! | field | from |
//! |---|---|
//! | `run4Id` | here: `act-` + the first 16 hex of sha256(agent id ‖ 0 ‖ idempotency key); the same act always gets the same id |
//! | `state` | the gateway's fate read (`GET /f/agent/fate`): `not-sent`, `landed`, `failed`, `expired`, `pending`, `unknown` (result unknown), `unqueryable` (could not ask) |
//! | `signature`, `lastValidBlockHeight`, `slotFloor`, `signedAt` | fixed by the gateway when the bytes left |
//! | `commitment` | the confirmation status the node reported (`processed`, `confirmed`, `finalized`) |
//! | `final` | `landed`, `failed`, `expired` and `not-sent` never change once recorded |
//! | `cancel` | the gateway signs and sends in one step: before an answer `NotSupported` (④ cannot stop it), after a send `Irrevocable` until `lastValidBlockHeight` |
//!
//! The registry keeps the last reading of each act durably, so a restart
//! answers from it and an unreadable gateway never erases what was known: a
//! failed read is recorded as `unqueryable` beside the last known facts, and
//! a final state is never replaced (a contradicting reading is kept as
//! `conflict`, for the operator, not applied).
//!
//! Workstream 05's RunReceipt port (`p05-port/0.1`, branch 45cba41e) names
//! the fields it needs from 04 (`run4Id`, `acts[].signedAt`,
//! `cancel.until`); [`receipt`] gives them under those names.

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::Store;

/// How long a key's result is kept: the registry never deletes a row, so
/// `retentionBells` is `null` (indefinite). Workstream 13's contract
/// (`08-retention-contract.ja.md` R1/R2) asks for at least 144 bells after
/// the result is final, declared; indefinite meets it. The gateway's own
/// memory of a key is shorter (its history keeps the latest 500 entries per
/// agent), which is why the registry keeps its own copy.
pub const RETENTION_BELLS: Option<u64> = None;

/// The states that never change once recorded.
pub const FINAL: [&str; 4] = ["landed", "failed", "expired", "not-sent"];

/// Reads one act's fate from the gateway (`GET /f/agent/fate?id=&key=`).
/// `Err`: the read itself failed.
pub trait FateReader {
    fn fate(&self, agent_id: &str, key: &str) -> Result<Value, String>;
}

/// One registered act.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActRow {
    pub run4_id: String,
    pub agent_id: String,
    pub key: String,
    pub source: String,
    /// The caller's own run id (workstream 05's `runId`), if it gave one.
    pub ext_run: Option<String>,
    pub registered_slot: u64,
    pub state: String,
    /// The last reading, as the gateway gave it.
    pub facts: Value,
}

fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

/// The act's run id: stable for (agent, key).
pub fn run4_id(agent_id: &str, key: &str) -> String {
    let mut h = Sha256::new();
    h.update(agent_id.as_bytes());
    h.update([0u8]);
    h.update(key.as_bytes());
    format!("act-{}", &hex::encode(h.finalize())[..16])
}

/// Creates the table (idempotent).
pub fn init(store: &Store) -> Result<(), String> {
    sql(store.conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS act_runs(run4_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
             idem_key TEXT NOT NULL, source TEXT NOT NULL, ext_run TEXT, registered_slot INTEGER NOT NULL,
             state TEXT NOT NULL, facts TEXT NOT NULL, UNIQUE(agent_id, idem_key));",
    ))
}

/// Registers an act (idempotent: the same agent, key, source and caller run
/// give the same row; a different source or caller run under the same key
/// is refused, never merged).
pub fn register(
    store: &Store,
    agent_id: &str,
    key: &str,
    source: &str,
    ext_run: Option<&str>,
    slot: u64,
) -> Result<String, String> {
    init(store)?;
    if agent_id.is_empty() || key.is_empty() || source.is_empty() {
        return Err("agent id, idempotency key and source are required".into());
    }
    let id = run4_id(agent_id, key);
    if let Some(r) = get(store, &id)? {
        if r.source != source || r.ext_run.as_deref() != ext_run {
            return Err(format!(
                "{id} is registered for source {} run {:?}, not {source} {ext_run:?}",
                r.source, r.ext_run
            ));
        }
        return Ok(id);
    }
    sql(store.conn.execute(
        "INSERT INTO act_runs(run4_id, agent_id, idem_key, source, ext_run, registered_slot, state, facts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'registered', '{}')",
        params![id, agent_id, key, source, ext_run, slot as i64],
    ))?;
    Ok(id)
}

pub fn get(store: &Store, run4_id: &str) -> Result<Option<ActRow>, String> {
    init(store)?;
    let row = sql(store
        .conn
        .query_row(
            "SELECT run4_id, agent_id, idem_key, source, ext_run, registered_slot, state, facts FROM act_runs WHERE run4_id = ?1",
            params![run4_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional())?;
    Ok(row.map(
        |(run4_id, agent_id, key, source, ext_run, slot, state, facts)| ActRow {
            run4_id,
            agent_id,
            key,
            source,
            ext_run,
            registered_slot: slot as u64,
            state,
            facts: serde_json::from_str(&facts).unwrap_or(Value::Null),
        },
    ))
}

/// The acts registered for a caller's run (workstream 05's `runId`).
pub fn by_ext_run(store: &Store, ext_run: &str) -> Result<Vec<ActRow>, String> {
    init(store)?;
    let mut st = sql(store.conn.prepare(
        "SELECT run4_id FROM act_runs WHERE ext_run = ?1 ORDER BY registered_slot, run4_id",
    ))?;
    let ids: Vec<String> = sql(st.query_map(params![ext_run], |r| r.get(0)))?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter()
        .filter_map(|i| get(store, i).transpose())
        .collect()
}

fn save(store: &Store, id: &str, state: &str, facts: &Value) -> Result<(), String> {
    sql(store.conn.execute(
        "UPDATE act_runs SET state = ?2, facts = ?3 WHERE run4_id = ?1",
        params![id, state, facts.to_string()],
    ))
    .map(|_| ())
}

/// Reads the act's fate once and records it (see the module doc for what is
/// never overwritten). Returns the receipt.
pub fn refresh(store: &Store, reader: &dyn FateReader, id: &str) -> Result<Value, String> {
    let row = get(store, id)?.ok_or_else(|| format!("no act {id}"))?;
    let was_final = FINAL.contains(&row.state.as_str());
    match reader.fate(&row.agent_id, &row.key) {
        Err(e) => {
            if !was_final {
                let mut f = row.facts.clone();
                if !f.is_object() {
                    f = json!({});
                }
                f["lastReadError"] = json!(e);
                save(store, id, "unqueryable", &f)?;
            }
        }
        Ok(v) => {
            let state = v["state"].as_str().unwrap_or("unqueryable").to_string();
            if was_final {
                if state != row.state && state != "unqueryable" {
                    let mut f = row.facts.clone();
                    f["conflict"] = json!({ "state": state, "why": v["why"] });
                    save(store, id, &row.state, &f)?;
                }
            } else {
                // Keep facts already known (the signature) when a later read
                // lacks them (an unretained record).
                let mut f = v.clone();
                for k in ["signature", "lastValidBlockHeight", "slotFloor", "signedAt"] {
                    if f[k].is_null() && !row.facts[k].is_null() {
                        f[k] = row.facts[k].clone();
                    }
                }
                save(store, id, &state, &f)?;
            }
        }
    }
    receipt(store, id)
}

/// The receipt of one act, in workstream 05's field names where they exist.
pub fn receipt(store: &Store, id: &str) -> Result<Value, String> {
    let r = get(store, id)?.ok_or_else(|| format!("no act {id}"))?;
    let f = &r.facts;
    let fin = FINAL.contains(&r.state.as_str());
    let sent = r.state != "not-sent" && (f["sent"] == json!(true) || f["signature"].is_string());
    let cancel = if r.state == "not-sent" {
        json!({ "stage": "before-sign", "result": "NotSent", "until": null })
    } else if sent {
        json!({ "stage": "sent", "result": "Irrevocable",
                "until": { "lastValidBlockHeight": f["lastValidBlockHeight"] },
                "phase": if fin { "Completed" } else { "AwaitingSigned" } })
    } else {
        json!({ "stage": "signed-unsent", "result": "NotSupported",
                "why": "the gateway signs and sends in one step; 04 cannot stop a request it has handed over" })
    };
    Ok(json!({
        "receiptVersion": "p04-acts/0.1",
        "run4Id": r.run4_id,
        "runId": r.ext_run,
        "agentId": r.agent_id,
        "idempotencyKey": r.key,
        "source": r.source,
        "registeredSlot": r.registered_slot,
        "state": r.state,
        "final": fin,
        "signature": f["signature"],
        "signedAt": f["signedAt"],
        "lastValidBlockHeight": f["lastValidBlockHeight"],
        "slotFloor": f["slotFloor"],
        "commitment": f["commitment"],
        "why": f["why"],
        "lastReadError": f["lastReadError"],
        "conflict": f["conflict"],
        "cancellable": false,
        "cancel": cancel,
        "retention": { "retentionBells": RETENTION_BELLS, "deleted": false },
    }))
}

/// The gateway's fate read over loopback HTTP: `GET {prefix}id=…&key=…`
/// (the gateway: `/f/agent/fate?`; the test bridge, one agent: `/fate?`).
pub struct HttpFateReader {
    pub port: u16,
    pub gateway_path: bool,
}

impl FateReader for HttpFateReader {
    fn fate(&self, agent_id: &str, key: &str) -> Result<Value, String> {
        let enc = |s: &str| -> String {
            s.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect()
        };
        let path = if self.gateway_path {
            format!("/f/agent/fate?id={}&key={}", enc(agent_id), enc(key))
        } else {
            format!("/fate?key={}", enc(key))
        };
        let (code, v) = crate::gateway::http_get(self.port, &path)?;
        if code != 200 || !v["state"].is_string() {
            return Err(format!("fate read answered {code}"));
        }
        Ok(v)
    }
}
