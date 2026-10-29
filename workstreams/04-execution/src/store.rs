//! The run store: SQLite in WAL mode with `synchronous = FULL`, the
//! keeper journal's settings (`frontier-node/crates/keeper/src/journal.rs`).
//!
//! Several executor processes may share one store. Each run is worked by
//! the holder of its **lease** (`lease_owner`, `lease_until`), and every
//! write is a compare-and-swap on `(version, lease_owner, lease_epoch)`:
//! a writer whose lease was taken over, or whose snapshot is stale, writes
//! nothing and re-reads. `transitions` has `UNIQUE(run_id, version)`, the
//! audit trail that no version was written twice.
//!
//! An attempt is journalled (`intent`, with its signed request) **before**
//! it is sent, in the same transaction as the state it enters; a crash
//! after that point leaves a durable record a restart resolves by lookup.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::model::{allowed, Detail, Res, RunSpec, RunState, ZERO};
use crate::ports::{EventRec, Prepared, Raid, Settle};

fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRow {
    pub spec: RunSpec,
    pub state: RunState,
    pub detail: Detail,
    pub version: i64,
    pub cancel_requested: bool,
    pub held: Option<String>,
    pub lease_owner: Option<String>,
    pub lease_epoch: i64,
    pub next_check: u64,
}

impl RunRow {
    pub fn id(&self) -> &str {
        &self.spec.run_id
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Step {
    Facility,
    Ship,
}

impl Step {
    fn name(self) -> &'static str {
        match self {
            Step::Facility => "facility",
            Step::Ship => "ship",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRow {
    pub id: i64,
    pub run_id: String,
    pub step: String,
    pub request_key: String,
    pub prepared: Prepared,
    /// `intent`, `sent`, `unknown`, `rejected`, `landed`, `failed`, `expired`.
    pub status: String,
    pub epoch: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResKind {
    /// Goods at a place.
    Stock,
    /// Units of a use right (`amount[0]`).
    Rights,
}

impl ResKind {
    fn name(self) -> &'static str {
        match self {
            ResKind::Stock => "stock",
            ResKind::Rights => "rights",
        }
    }
}

/// A side effect committed with a transition, in the same transaction.
#[derive(Clone, Debug)]
pub enum Op {
    Reserve {
        kind: ResKind,
        place: String,
        amount: Res,
    },
    ReleaseAll,
    AttemptIntent {
        step: Step,
        prepared: Prepared,
    },
    AttemptStatus {
        sig: String,
        status: &'static str,
    },
    Receipt(Receipt),
}

/// Evidence of something that happened. **Not** a proof that the goods it
/// names are still there: the next step reads the canonical stock again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub run_id: String,
    /// `facility_used`, `caravan_sent`, `caravan_raided`, `caravan_settled`.
    pub kind: String,
    /// The request key or caravan key it answers.
    pub subject: String,
    /// Where it was read: `sig:<sig>`, `event:<id>`, `history:<id>`,
    /// `account:<key>@<slot>`.
    pub source: String,
    pub slot: u64,
    pub body: serde_json::Value,
}

impl Receipt {
    pub fn id(&self) -> String {
        use sha2::Digest;
        let h = sha2::Sha256::digest(
            format!(
                "{}|{}|{}|{}",
                self.run_id, self.kind, self.subject, self.source
            )
            .as_bytes(),
        );
        hex::encode(&h[..16])
    }
}

pub struct Change {
    pub to: RunState,
    pub detail: Detail,
    pub next_check: u64,
    pub reason: String,
    pub ops: Vec<Op>,
    /// Refuse the write if a cancel was requested (the step about to send).
    pub unless_cancelled: bool,
    /// Refuse the write if another run of the same owner has a send in
    /// flight: the owner's caravan seq is pinned by one run at a time.
    pub sole_owner_send: bool,
    pub hold: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Accept {
    Created,
    /// Same run id, same spec: the earlier acceptance stands.
    Existing(RunState),
    /// Same run id, another spec: refused.
    Conflict,
}

pub struct Store {
    pub conn: Connection,
}

/// `RUN_COLS` as read: spec, state, detail, version, cancel, held, lease
/// owner, lease epoch, next check.
type RunCols = (
    String,
    String,
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    i64,
    i64,
);

/// An alert: slot, run, kind, detail.
pub type Alert = (u64, Option<String>, String, String);

const RUN_COLS: &str = "spec, state, detail, version, cancel_requested, held_reason, lease_owner, lease_epoch, next_check";

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let conn = sql(Connection::open(path))?;
        sql(conn.busy_timeout(std::time::Duration::from_secs(10)))?;
        sql(conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, spec TEXT NOT NULL, spec_digest TEXT NOT NULL,
                 state TEXT NOT NULL, detail TEXT NOT NULL, version INTEGER NOT NULL,
                 cancel_requested INTEGER NOT NULL DEFAULT 0, held_reason TEXT,
                 lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, lease_epoch INTEGER NOT NULL DEFAULT 0,
                 next_check INTEGER NOT NULL, created_slot INTEGER NOT NULL, updated_slot INTEGER NOT NULL,
                 ship_key TEXT, inbound_key TEXT, fac_key TEXT NOT NULL, owner INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner, state);
             CREATE INDEX IF NOT EXISTS runs_due ON runs(state, next_check);
             CREATE INDEX IF NOT EXISTS runs_ship ON runs(ship_key);
             CREATE INDEX IF NOT EXISTS runs_inbound ON runs(inbound_key);
             CREATE INDEX IF NOT EXISTS runs_fac ON runs(fac_key);
             CREATE TABLE IF NOT EXISTS transitions(run_id TEXT NOT NULL, version INTEGER NOT NULL,
                 from_state TEXT NOT NULL, to_state TEXT NOT NULL, slot INTEGER NOT NULL, executor TEXT NOT NULL,
                 reason TEXT NOT NULL, UNIQUE(run_id, version));
             CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
                 step TEXT NOT NULL, request_key TEXT NOT NULL, sig TEXT NOT NULL UNIQUE, prepared TEXT NOT NULL,
                 status TEXT NOT NULL, epoch INTEGER NOT NULL, slot INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id, step);
             CREATE TABLE IF NOT EXISTS reservations(run_id TEXT NOT NULL, kind TEXT NOT NULL, place TEXT NOT NULL,
                 amount TEXT NOT NULL, PRIMARY KEY(run_id, kind, place));
             CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, pos INTEGER NOT NULL, kind TEXT NOT NULL,
                 subject TEXT, body TEXT NOT NULL, seen_slot INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS events_subject ON events(subject, kind);
             CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL,
                 subject TEXT NOT NULL, source TEXT NOT NULL, slot INTEGER NOT NULL, body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS cursor(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL,
                 run_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL);",
        ))?;
        Ok(Store { conn })
    }

    /// Accepts a run, idempotently by `run_id`.
    pub fn accept(&self, spec: &RunSpec, now: u64) -> Result<Accept, String> {
        let digest = spec.digest();
        let got: Option<(String, String)> = sql(self
            .conn
            .query_row(
                "SELECT spec_digest, state FROM runs WHERE run_id = ?1",
                params![spec.run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?;
        if let Some((d, s)) = got {
            return Ok(if d == digest {
                Accept::Existing(RunState::parse(&s).ok_or("bad state")?)
            } else {
                Accept::Conflict
            });
        }
        let n = sql(self.conn.execute(
            "INSERT OR IGNORE INTO runs(run_id, spec, spec_digest, state, detail, version, next_check, created_slot,
                 updated_slot, inbound_key, fac_key, owner)
             VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?6, ?6, ?7, ?8, ?9)",
            params![
                spec.run_id,
                serde_json::to_string(spec).map_err(|e| e.to_string())?,
                digest,
                RunState::Accepted.name(),
                serde_json::to_string(&Detail::default()).map_err(|e| e.to_string())?,
                now as i64,
                spec.inbound.map(|k| k.text()),
                spec.facility_key(),
                spec.owner as i64
            ],
        ))?;
        if n == 0 {
            // Lost a race with an identical insert.
            return self.accept(spec, now);
        }
        Ok(Accept::Created)
    }

    fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunCols> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
        ))
    }

    pub fn load(&self, run_id: &str) -> Result<Option<RunRow>, String> {
        let got = sql(self
            .conn
            .query_row(
                &format!("SELECT {RUN_COLS} FROM runs WHERE run_id = ?1"),
                params![run_id],
                Self::row,
            )
            .optional())?;
        let Some((spec, state, detail, version, cancel, held, lease_owner, epoch, next)) = got
        else {
            return Ok(None);
        };
        Ok(Some(RunRow {
            spec: serde_json::from_str(&spec).map_err(|e| e.to_string())?,
            state: RunState::parse(&state).ok_or("bad state")?,
            detail: serde_json::from_str(&detail).map_err(|e| e.to_string())?,
            version,
            cancel_requested: cancel != 0,
            held,
            lease_owner,
            lease_epoch: epoch,
            next_check: next as u64,
        }))
    }

    /// Runs an executor should look at: open, not held, due.
    pub fn due(&self, now: u64, limit: usize) -> Result<Vec<String>, String> {
        let terminal: Vec<String> = RunState::ALL
            .iter()
            .filter(|s| s.terminal())
            .map(|s| format!("'{}'", s.name()))
            .collect();
        let mut st = sql(self.conn.prepare(&format!(
            "SELECT run_id FROM runs WHERE state NOT IN ({}) AND held_reason IS NULL
             AND (next_check <= ?1 OR cancel_requested = 1) ORDER BY next_check, run_id LIMIT ?2",
            terminal.join(",")
        )))?;
        let rows = sql(st.query_map(params![now as i64, limit as i64], |r| r.get(0)))?;
        sql(rows.collect())
    }

    /// Takes (or extends) the lease of a run. A take-over from another
    /// owner (or after expiry) bumps the epoch, fencing the old holder.
    pub fn claim(&self, run_id: &str, me: &str, now: u64, lease: u64) -> Result<bool, String> {
        let n = sql(self.conn.execute(
            "UPDATE runs SET
                 lease_epoch = CASE WHEN lease_owner = ?2 AND lease_until >= ?3 THEN lease_epoch ELSE lease_epoch + 1 END,
                 lease_owner = ?2, lease_until = ?4
             WHERE run_id = ?1 AND (lease_owner IS NULL OR lease_owner = ?2 OR lease_until < ?3)",
            params![run_id, me, now as i64, (now + lease) as i64],
        ))?;
        Ok(n == 1)
    }

    /// Gives a lease back (a clean stop).
    pub fn release_lease(&self, run_id: &str, me: &str) -> Result<(), String> {
        sql(self.conn.execute(
            "UPDATE runs SET lease_owner = NULL, lease_until = 0 WHERE run_id = ?1 AND lease_owner = ?2",
            params![run_id, me],
        ))
        .map(|_| ())
    }

    /// Applies a change if `row` is still current and `me` still holds the
    /// lease at the row's epoch. `Ok(false)`: stale; nothing was written.
    pub fn transition(&self, row: &RunRow, me: &str, now: u64, c: &Change) -> Result<bool, String> {
        if !allowed(row.state, c.to) {
            return Err(format!(
                "transition {} → {} is not in the table ({})",
                row.state.name(),
                c.to.name(),
                row.id()
            ));
        }
        let tx = sql(rusqlite::Transaction::new_unchecked(
            &self.conn,
            TransactionBehavior::Immediate,
        ))?;
        let ship_key = c.detail.ship_seq.map(|s| {
            crate::model::CaravanKey {
                owner: row.spec.owner,
                seq: s,
            }
            .text()
        });
        let n = sql(tx.execute(
            &format!(
                "UPDATE runs SET state = ?1, detail = ?2, version = version + 1, next_check = ?3, updated_slot = ?4,
                     ship_key = ?5, held_reason = COALESCE(?6, held_reason)
                 WHERE run_id = ?7 AND version = ?8 AND lease_owner = ?9 AND lease_epoch = ?10{}{}",
                if c.unless_cancelled { " AND cancel_requested = 0" } else { "" },
                if c.sole_owner_send {
                    " AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.owner = runs.owner AND o.run_id <> runs.run_id
                       AND o.state IN ('ShipRequested', 'ShipSubmitted'))"
                } else {
                    ""
                }
            ),
            params![
                c.to.name(),
                serde_json::to_string(&c.detail).map_err(|e| e.to_string())?,
                c.next_check as i64,
                now as i64,
                ship_key,
                c.hold,
                row.id(),
                row.version,
                me,
                row.lease_epoch
            ],
        ))?;
        if n == 0 {
            return Ok(false);
        }
        sql(tx.execute(
            "INSERT INTO transitions(run_id, version, from_state, to_state, slot, executor, reason)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id(),
                row.version + 1,
                row.state.name(),
                c.to.name(),
                now as i64,
                me,
                c.reason
            ],
        ))?;
        for op in &c.ops {
            match op {
                Op::Reserve {
                    kind,
                    place,
                    amount,
                } => {
                    sql(tx.execute(
                        "INSERT OR REPLACE INTO reservations(run_id, kind, place, amount) VALUES(?1, ?2, ?3, ?4)",
                        params![
                            row.id(),
                            kind.name(),
                            place,
                            serde_json::to_string(amount).map_err(|e| e.to_string())?
                        ],
                    ))?;
                }
                Op::ReleaseAll => {
                    sql(tx.execute(
                        "DELETE FROM reservations WHERE run_id = ?1",
                        params![row.id()],
                    ))?;
                }
                Op::AttemptIntent { step, prepared } => {
                    sql(tx.execute(
                        "INSERT INTO attempts(run_id, step, request_key, sig, prepared, status, epoch, slot)
                         VALUES(?1, ?2, ?3, ?4, ?5, 'intent', ?6, ?7)",
                        params![
                            row.id(),
                            step.name(),
                            prepared.request.key(),
                            prepared.sig,
                            serde_json::to_string(prepared).map_err(|e| e.to_string())?,
                            row.lease_epoch,
                            now as i64
                        ],
                    ))?;
                }
                Op::AttemptStatus { sig, status } => {
                    sql(tx.execute(
                        "UPDATE attempts SET status = ?2 WHERE sig = ?1 AND run_id = ?3",
                        params![sig, status, row.id()],
                    ))?;
                }
                Op::Receipt(r) => {
                    sql(tx.execute(
                        "INSERT OR IGNORE INTO receipts(id, run_id, kind, subject, source, slot, body)
                         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![r.id(), r.run_id, r.kind, r.subject, r.source, r.slot as i64, r.body.to_string()],
                    ))?;
                }
            }
        }
        sql(tx.commit())?;
        Ok(true)
    }

    /// Goods (or right units) reserved by other open runs at `place`.
    pub fn reserved_by_others(
        &self,
        kind: ResKind,
        place: &str,
        run_id: &str,
    ) -> Result<Res, String> {
        let mut st = sql(self.conn.prepare(
            "SELECT amount FROM reservations WHERE kind = ?1 AND place = ?2 AND run_id <> ?3",
        ))?;
        let rows = sql(st.query_map(params![kind.name(), place, run_id], |r| {
            r.get::<_, String>(0)
        }))?;
        let mut out = ZERO;
        for a in rows {
            let a: Res = serde_json::from_str(&sql(a)?).map_err(|e| e.to_string())?;
            out = crate::model::res_add(&out, &a);
        }
        Ok(out)
    }

    /// Another run of `owner` has a SendCaravan in flight.
    pub fn owner_send_in_flight(&self, owner: u64, run_id: &str) -> Result<bool, String> {
        sql(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE owner = ?1 AND run_id <> ?2
                 AND state IN ('ShipRequested', 'ShipSubmitted'))",
            params![owner as i64, run_id],
            |r| r.get::<_, bool>(0),
        ))
    }

    pub fn reservations_of(&self, run_id: &str) -> Result<usize, String> {
        sql(self.conn.query_row(
            "SELECT COUNT(*) FROM reservations WHERE run_id = ?1",
            params![run_id],
            |r| r.get::<_, i64>(0),
        ))
        .map(|n| n as usize)
    }

    pub fn attempts(&self, run_id: &str, step: Step) -> Result<Vec<AttemptRow>, String> {
        let mut st = sql(self.conn.prepare(
            "SELECT id, run_id, step, request_key, prepared, status, epoch FROM attempts
             WHERE run_id = ?1 AND step = ?2 ORDER BY id",
        ))?;
        let rows = sql(st.query_map(params![run_id, step.name()], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
            ))
        }))?;
        let mut out = vec![];
        for x in rows {
            let (id, run_id, step, request_key, prepared, status, epoch) = sql(x)?;
            out.push(AttemptRow {
                id,
                run_id,
                step,
                request_key,
                prepared: serde_json::from_str(&prepared).map_err(|e| e.to_string())?,
                status,
                epoch,
            });
        }
        Ok(out)
    }

    /// Records a feed record once (by id). `true`: new.
    pub fn record_event(&self, rec: &EventRec, now: u64) -> Result<bool, String> {
        let subject = match (&rec.event, rec.event.caravan()) {
            (_, Some(k)) => Some(k.text()),
            (crate::ports::Event::FacilityUsed(f), None) => Some(f.key.clone()),
            _ => None,
        };
        let n = sql(self.conn.execute(
            "INSERT OR IGNORE INTO events(id, pos, kind, subject, body, seen_slot) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                rec.id,
                rec.pos as i64,
                rec.event.kind(),
                subject,
                serde_json::to_string(rec).map_err(|e| e.to_string())?,
                now as i64
            ],
        ))?;
        Ok(n == 1)
    }

    fn events_of(&self, subject: &str, kind: &str) -> Result<Vec<EventRec>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT body FROM events WHERE subject = ?1 AND kind = ?2 ORDER BY pos"))?;
        let rows = sql(st.query_map(params![subject, kind], |r| r.get::<_, String>(0)))?;
        let mut out = vec![];
        for b in rows {
            out.push(serde_json::from_str(&sql(b)?).map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn settle_seen(&self, key: &str) -> Result<Option<(String, Settle)>, String> {
        Ok(self
            .events_of(key, "caravan_settled")?
            .into_iter()
            .find_map(|r| match r.event {
                crate::ports::Event::CaravanSettled(s) => Some((r.id, s)),
                _ => None,
            }))
    }

    pub fn raid_seen(&self, key: &str) -> Result<Option<(String, Raid)>, String> {
        Ok(self
            .events_of(key, "caravan_raided")?
            .into_iter()
            .find_map(|r| match r.event {
                crate::ports::Event::CaravanRaided(x) => Some((r.id, x)),
                _ => None,
            }))
    }

    /// Open runs waiting on a caravan (ship or inbound): woken by its records.
    pub fn wake_subject(&self, subject: &str, now: u64) -> Result<usize, String> {
        sql(self.conn.execute(
            "UPDATE runs SET next_check = MIN(next_check, ?2)
             WHERE ship_key = ?1 OR inbound_key = ?1 OR fac_key = ?1",
            params![subject, now as i64],
        ))
    }

    /// Every open run is looked at now (history gap, operator request).
    pub fn wake_all(&self, now: u64) -> Result<usize, String> {
        sql(self.conn.execute(
            "UPDATE runs SET next_check = MIN(next_check, ?1)",
            params![now as i64],
        ))
    }

    pub fn cursor(&self, name: &str) -> Result<u64, String> {
        Ok(sql(self
            .conn
            .query_row(
                "SELECT value FROM cursor WHERE name = ?1",
                params![name],
                |r| r.get::<_, i64>(0),
            )
            .optional())?
        .unwrap_or(0) as u64)
    }

    pub fn set_cursor(&self, name: &str, v: u64) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO cursor(name, value) VALUES(?1, ?2) ON CONFLICT(name) DO UPDATE SET value = MAX(value, ?2)",
            params![name, v as i64],
        ))
        .map(|_| ())
    }

    /// An operator's (or a client's) cancel: a flag the executor honours
    /// before its next send. The version bump makes any write prepared on
    /// an older snapshot fail its compare-and-swap.
    pub fn request_cancel(&self, run_id: &str) -> Result<Option<RunState>, String> {
        sql(self.conn.execute(
            "UPDATE runs SET cancel_requested = 1, version = version + 1, next_check = 0 WHERE run_id = ?1
             AND cancel_requested = 0",
            params![run_id],
        ))?;
        Ok(self.load(run_id)?.map(|r| r.state))
    }

    /// An operator resumes a held run (clears the hold and the error count).
    pub fn resume(&self, run_id: &str) -> Result<bool, String> {
        let Some(mut r) = self.load(run_id)? else {
            return Ok(false);
        };
        r.detail.port_errors = 0;
        let n = sql(self.conn.execute(
            "UPDATE runs SET held_reason = NULL, detail = ?2, version = version + 1, next_check = 0
             WHERE run_id = ?1 AND held_reason IS NOT NULL",
            params![
                run_id,
                serde_json::to_string(&r.detail).map_err(|e| e.to_string())?
            ],
        ))?;
        Ok(n == 1)
    }

    pub fn alert(
        &self,
        slot: u64,
        run_id: Option<&str>,
        kind: &str,
        detail: &str,
    ) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO alerts(slot, run_id, kind, detail) VALUES(?1, ?2, ?3, ?4)",
            params![slot as i64, run_id, kind, detail],
        ))
        .map(|_| ())
    }

    pub fn alerts(&self) -> Result<Vec<Alert>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT slot, run_id, kind, detail FROM alerts ORDER BY id"))?;
        let rows = sql(st.query_map([], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get(1)?, r.get(2)?, r.get(3)?))
        }))?;
        sql(rows.collect())
    }

    pub fn receipts(&self, run_id: &str) -> Result<Vec<Receipt>, String> {
        let mut st = sql(self.conn.prepare(
            "SELECT run_id, kind, subject, source, slot, body FROM receipts WHERE run_id = ?1 ORDER BY slot, kind",
        ))?;
        let rows = sql(st.query_map(params![run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        }))?;
        let mut out = vec![];
        for x in rows {
            let (run_id, kind, subject, source, slot, body) = sql(x)?;
            out.push(Receipt {
                run_id,
                kind,
                subject,
                source,
                slot: slot as u64,
                body: serde_json::from_str(&body).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    /// `(from, to, executor, reason)` of a run, in version order.
    pub fn history(&self, run_id: &str) -> Result<Vec<(String, String, String, String)>, String> {
        let mut st = sql(self.conn.prepare(
            "SELECT from_state, to_state, executor, reason FROM transitions WHERE run_id = ?1 ORDER BY version",
        ))?;
        let rows = sql(st.query_map(params![run_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        }))?;
        sql(rows.collect())
    }

    pub fn run_ids(&self) -> Result<Vec<String>, String> {
        let mut st = sql(self.conn.prepare("SELECT run_id FROM runs ORDER BY run_id"))?;
        let rows = sql(st.query_map([], |r| r.get(0)))?;
        sql(rows.collect())
    }

    /// The monitoring block (`docs/RUNBOOK.ja.md`).
    pub fn status(&self, now: u64) -> Result<serde_json::Value, String> {
        let mut by_state = serde_json::Map::new();
        let mut st = sql(self
            .conn
            .prepare("SELECT state, COUNT(*) FROM runs GROUP BY state ORDER BY state"))?;
        let rows = sql(st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))))?;
        for x in rows {
            let (s, n) = sql(x)?;
            by_state.insert(s, n.into());
        }
        let held: Vec<(String, String)> = {
            let mut st = sql(self.conn.prepare(
                "SELECT run_id, held_reason FROM runs WHERE held_reason IS NOT NULL ORDER BY run_id",
            ))?;
            let rows = sql(st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))))?;
            sql(rows.collect())?
        };
        let in_flight: i64 = sql(self.conn.query_row(
            "SELECT COUNT(*) FROM attempts WHERE status IN ('intent', 'sent', 'unknown')",
            [],
            |r| r.get(0),
        ))?;
        let oldest_open: Option<i64> = sql(self.conn.query_row(
            "SELECT MIN(created_slot) FROM runs WHERE state IN ('Accepted','Reserved','FacilityRequested',
                 'FacilitySubmitted','FacilityConfirmed','ShipRequested','ShipSubmitted','InTransit','Arrived')",
            [],
            |r| r.get(0),
        ))?;
        let alerts: i64 = sql(self
            .conn
            .query_row("SELECT COUNT(*) FROM alerts", [], |r| r.get(0)))?;
        Ok(serde_json::json!({
            "slot": now,
            "byState": by_state,
            "held": held,
            "attemptsUndecided": in_flight,
            "oldestOpenAgeSlots": oldest_open.map(|s| now.saturating_sub(s as u64)),
            "alerts": alerts,
            "eventCursor": self.cursor("events")?,
        }))
    }
}
