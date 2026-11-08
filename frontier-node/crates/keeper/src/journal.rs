//! The keeper journal (M1 contract §8.2 "Crash safety"; offchain design §6.7).
//!
//! **The chain is the state**: every duty is idempotent and succeeds once
//! per object, so a restart re-plans from chain reads. The journal keeps the
//! evidence (every version sent: payer, bid, CU limit, slots, outcome) and
//! lets a restart close its books: in-flight attempts are reconciled with
//! `getSignatureStatuses` before anything new is sent, and the engine adopts
//! the ones still valid so they are not duplicated blindly.
//!
//! SQLite in WAL mode with `synchronous = FULL` (the attempts table must
//! survive a power cut). Tables: `attempts`, `plaintexts` (W4-C's reveal
//! cache), `cursor`, `claims` (W4), `payers`, `alerts`, `recovered_finality`, `conquest` (MC
//! §8.2, CQ2-D: horns seen and conquest writes landed). One process per
//! keeper identity: [`lock`] takes an exclusive `flock`-style lock on
//! `<journal>.lock`.

use std::fs::{File, OpenOptions};
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

/// One transaction version as sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub sig: String,
    pub kind: String,
    /// Instruction tag used to interpret a finalized program error. Legacy
    /// attempts have no recorded tag, so their error meaning is unknown.
    pub tag: Option<u8>,
    pub object_key: String,
    /// Identifies the write whose signed variants share one fee cap. Legacy
    /// attempts have no recorded ID and retain conservative key-wide checks.
    pub write_id: Option<String>,
    pub bell: Option<u32>,
    pub region: Option<u8>,
    pub class: String,
    pub payer: String,
    pub bid_milli: u64,
    /// Predicted fee of this signed version. Old rows without it cannot be
    /// safely adopted because the resend cap needs their spend.
    pub fee: u64,
    pub cu_limit: u32,
    pub heap: Option<u32>,
    pub first_valid_slot: u64,
    pub sent_slot: u64,
    /// Last block height at which the signed blockhash is valid. Legacy
    /// attempts have no recorded height; `None` must never imply expiry.
    pub last_valid_block_height: Option<u64>,
    pub landed_slot: Option<u64>,
    /// `sent`, `landed`, `failed`, `expired`, `superseded`.
    pub status: String,
    pub code: Option<u32>,
}

pub struct Journal {
    pub conn: Connection,
    /// Crash injection (tests, offchain design §6.7): panics at a chosen
    /// journal write, as a `kill -9` at that point would stop the process.
    pub crash: Option<CrashAt>,
}

/// Where [`Journal::crash`] fires: the `nth` write at `point`
/// (`"attempt"`, `"status"`, `"recovered-finality"` or `"plaintext"`) whose attempt kind is one of
/// `kinds` (`"*"` = any). The write itself does not happen.
#[derive(Debug)]
pub struct CrashAt {
    pub point: &'static str,
    pub kinds: Vec<&'static str>,
    pub nth: u32,
    pub seen: std::cell::Cell<u32>,
}

impl CrashAt {
    pub fn new(point: &'static str, kinds: &[&'static str], nth: u32) -> CrashAt {
        CrashAt {
            point,
            kinds: kinds.to_vec(),
            nth,
            seen: std::cell::Cell::new(0),
        }
    }
}

/// A journalled `(plaintext, salt)`.
pub type PlainSalt = (Vec<u8>, Vec<u8>);

/// Finality fields read from the current attempt. The slot is nullable until landing.
type AttemptFinalityRow = (
    String,
    String,
    Option<String>,
    String,
    Option<i64>,
    Option<i64>,
);

/// Finality fields read from an already recorded recovery notice.
type RecoveredFinalityRow = (String, String, Option<String>, String, i64, Option<i64>);

/// A journalled owner reveal material (`owner_material`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerRow {
    pub host: u64,
    pub bell: u32,
    pub track: String,
    pub holding: String,
    pub transit_slot: u8,
    pub plain: Vec<u8>,
    pub salt: Vec<u8>,
    pub ct_hash: Vec<u8>,
}

/// The panic message of an injected crash.
pub const INJECTED_CRASH: &str = "injected crash";

fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn nonnegative_u64(r: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = r.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

/// Takes the process lock of a keeper identity (`<path>.lock`).
pub fn lock(journal: &Path) -> Result<File, String> {
    let p = journal.with_extension("lock");
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&p)
        .map_err(|e| format!("{}: {e}", p.display()))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(format!("{} is held by another keeper process", p.display()))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(format!("{}: {e}", p.display())),
    }
}

impl Journal {
    /// Resume an existing journal without allowing SQLite to create an empty
    /// database or silently rebuild a missing table. The stack also checks
    /// it before starting localnet; this closes the gap before keeper start.
    pub fn open_existing(path: &Path) -> Result<Journal, String> {
        let conn = sql(Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        ))?;
        let integrity: String = sql(conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0)))?;
        if integrity != "ok" {
            return Err("keeper journal failed SQLite integrity check".into());
        }
        for query in [
            "SELECT sig, object_key, status, fee FROM attempts LIMIT 0",
            "SELECT host, bell, plain, salt FROM plaintexts LIMIT 0",
            "SELECT host, bell, ct_hash FROM owner_material LIMIT 0",
            "SELECT name, value FROM cursor LIMIT 0",
            "SELECT slot_key, state FROM claims LIMIT 0",
            "SELECT pool, i, address FROM payers LIMIT 0",
            "SELECT slot, kind FROM alerts LIMIT 0",
            "SELECT slot, event FROM conquest LIMIT 0",
        ] {
            sql(conn.prepare(query))?;
        }
        Self::ensure_expiry_height_column(&conn)?;
        Self::ensure_write_id_column(&conn)?;
        Self::ensure_tag_column(&conn)?;
        Self::ensure_recovered_finality_table(&conn)?;
        Self::ensure_owner_track_table(&conn)?;
        Self::check_known_fees(&conn)?;
        sql(conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"))?;
        let journal = Journal { conn, crash: None };
        journal.in_flight()?;
        Ok(journal)
    }

    fn check_known_fees(conn: &Connection) -> Result<(), String> {
        let invalid: i64 = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts WHERE fee IS NULL OR fee <= 0
             OR typeof(fee) != 'integer' OR typeof(bid_milli) != 'integer'
             OR typeof(first_valid_slot) != 'integer' OR typeof(sent_slot) != 'integer'
             OR (last_valid_block_height IS NOT NULL
                 AND (typeof(last_valid_block_height) != 'integer' OR last_valid_block_height <= 0))
             OR (landed_slot IS NOT NULL AND typeof(landed_slot) != 'integer')
             OR (write_id IS NOT NULL
                 AND (typeof(write_id) != 'text' OR length(trim(write_id)) = 0))
             OR (tag IS NOT NULL
                 AND (typeof(tag) != 'integer' OR tag < 0 OR tag > 255))
             OR bid_milli < 0 OR first_valid_slot < 0 OR sent_slot < 0
             OR landed_slot < 0 LIMIT 1)",
            [],
            |r| r.get(0),
        ))?;
        if invalid != 0 {
            return Err(
                "keeper journal has attempts without fee or invalid fields; refusing unsafe resume"
                    .into(),
            );
        }
        Ok(())
    }

    fn ensure_expiry_height_column(conn: &Connection) -> Result<(), String> {
        let has_height = {
            let mut st = sql(conn.prepare("PRAGMA table_info(attempts)"))?;
            let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
            sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
                .iter()
                .any(|name| name == "last_valid_block_height")
        };
        if !has_height {
            sql(conn.execute(
                "ALTER TABLE attempts ADD COLUMN last_valid_block_height INTEGER",
                [],
            ))?;
        }
        Ok(())
    }

    fn ensure_write_id_column(conn: &Connection) -> Result<(), String> {
        let has_write_id = {
            let mut st = sql(conn.prepare("PRAGMA table_info(attempts)"))?;
            let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
            sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
                .iter()
                .any(|name| name == "write_id")
        };
        if !has_write_id {
            sql(conn.execute("ALTER TABLE attempts ADD COLUMN write_id TEXT", []))?;
        }
        sql(conn.execute(
            "CREATE INDEX IF NOT EXISTS attempts_write_id ON attempts(write_id)",
            [],
        ))?;
        Ok(())
    }

    fn ensure_tag_column(conn: &Connection) -> Result<(), String> {
        let has_tag = {
            let mut st = sql(conn.prepare("PRAGMA table_info(attempts)"))?;
            let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
            sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
                .iter()
                .any(|name| name == "tag")
        };
        if !has_tag {
            sql(conn.execute("ALTER TABLE attempts ADD COLUMN tag INTEGER", []))?;
        }
        Ok(())
    }

    fn ensure_recovered_finality_table(conn: &Connection) -> Result<(), String> {
        sql(conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS recovered_finality(
                sig TEXT PRIMARY KEY, kind TEXT NOT NULL, object_key TEXT NOT NULL,
                write_id TEXT, status TEXT NOT NULL CHECK(status IN ('landed', 'failed', 'done')),
                slot INTEGER NOT NULL CHECK(slot >= 0), code INTEGER,
                alert_id INTEGER NOT NULL UNIQUE);",
        ))?;
        sql(conn.prepare(
            "SELECT sig, kind, object_key, write_id, status, slot, code, alert_id
             FROM recovered_finality LIMIT 0",
        ))?;
        Ok(())
    }

    /// Every owner track ever acknowledged for a march (⑱). `owner_material`
    /// keeps one row per march (`(host, bell)`), and a second `/v1/reveal`
    /// for the same march replaces its `track`: without this table the
    /// track acknowledged first was lost at a restart. Add-only; an older
    /// journal is filled from its `owner_material` rows.
    fn ensure_owner_track_table(conn: &Connection) -> Result<(), String> {
        sql(conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS owner_track(track TEXT PRIMARY KEY,
                 host INTEGER NOT NULL, bell INTEGER NOT NULL);
             INSERT OR IGNORE INTO owner_track(track, host, bell)
                 SELECT track, host, bell FROM owner_material;",
        ))?;
        sql(conn.prepare("SELECT track, host, bell FROM owner_track LIMIT 0"))?;
        Ok(())
    }

    /// Opens (or creates) the journal (`":memory:"` for tests).
    pub fn open(path: &Path) -> Result<Journal, String> {
        let conn = sql(Connection::open(path))?;
        sql(conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS attempts(sig TEXT PRIMARY KEY, kind TEXT NOT NULL, object_key TEXT NOT NULL,
                 bell INTEGER, region INTEGER, class TEXT NOT NULL, payer TEXT NOT NULL, bid_milli INTEGER NOT NULL,
                 cu_limit INTEGER NOT NULL, heap INTEGER, first_valid_slot INTEGER NOT NULL, sent_slot INTEGER NOT NULL,
                 landed_slot INTEGER, status TEXT NOT NULL, code INTEGER, fee INTEGER,
                 last_valid_block_height INTEGER, write_id TEXT, tag INTEGER);
             CREATE INDEX IF NOT EXISTS attempts_status ON attempts(status);
             CREATE INDEX IF NOT EXISTS attempts_object ON attempts(object_key);
             CREATE TABLE IF NOT EXISTS plaintexts(host INTEGER NOT NULL, bell INTEGER NOT NULL, plain BLOB NOT NULL,
                 salt BLOB NOT NULL, PRIMARY KEY(host, bell));
             CREATE TABLE IF NOT EXISTS owner_material(host INTEGER NOT NULL, bell INTEGER NOT NULL, track TEXT NOT NULL,
                 holding TEXT NOT NULL, transit_slot INTEGER NOT NULL, plain BLOB NOT NULL, salt BLOB NOT NULL,
                 ct_hash BLOB NOT NULL, PRIMARY KEY(host, bell));
             CREATE TABLE IF NOT EXISTS cursor(name TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS claims(slot_key TEXT PRIMARY KEY, bell INTEGER NOT NULL, region INTEGER NOT NULL,
                 ev_slot INTEGER, ev_price INTEGER, ev_limit INTEGER, state TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS payers(pool TEXT NOT NULL, i INTEGER NOT NULL, address TEXT NOT NULL,
                 balance_seen INTEGER NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY(pool, i));
             CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL,
                 kind TEXT NOT NULL, detail TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS conquest(id INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL,
                 bell INTEGER, event TEXT NOT NULL, object TEXT NOT NULL, detail TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS conquest_event ON conquest(event);",
        ))?;
        // An older journal has no fee column. Preserve it, but never turn an
        // unknown old fee into zero: resuming such a journal requires a
        // reviewed migration of its in-flight and historical attempts.
        let has_fee = {
            let mut st = sql(conn.prepare("PRAGMA table_info(attempts)"))?;
            let rows = sql(st.query_map([], |r| r.get::<_, String>(1)))?;
            sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
                .iter()
                .any(|name| name == "fee")
        };
        if !has_fee {
            sql(conn.execute("ALTER TABLE attempts ADD COLUMN fee INTEGER", []))?;
        }
        Self::ensure_expiry_height_column(&conn)?;
        Self::ensure_write_id_column(&conn)?;
        Self::ensure_tag_column(&conn)?;
        Self::ensure_recovered_finality_table(&conn)?;
        Self::ensure_owner_track_table(&conn)?;
        Self::check_known_fees(&conn)?;
        Ok(Journal { conn, crash: None })
    }

    fn maybe_crash(&self, point: &str, kind: &str) {
        let Some(c) = &self.crash else { return };
        if c.point != point || !(c.kinds.contains(&"*") || c.kinds.contains(&kind)) {
            return;
        }
        let n = c.seen.get() + 1;
        c.seen.set(n);
        if n == c.nth {
            panic!("{INJECTED_CRASH} at journal {point} #{n} ({kind})");
        }
    }

    pub fn record_attempt(&self, a: &Attempt) -> Result<(), String> {
        self.maybe_crash("attempt", &a.kind);
        if a.write_id.as_ref().is_some_and(|id| id.trim().is_empty()) {
            return Err("write ID must be nonempty".into());
        }
        let fee = i64::try_from(a.fee).map_err(|_| "predicted fee overflows SQLite integer")?;
        let bid = i64::try_from(a.bid_milli).map_err(|_| "bid overflows SQLite integer")?;
        let first_valid_slot = i64::try_from(a.first_valid_slot)
            .map_err(|_| "first valid slot overflows SQLite integer")?;
        let sent_slot =
            i64::try_from(a.sent_slot).map_err(|_| "sent slot overflows SQLite integer")?;
        let landed_slot = a
            .landed_slot
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "landed slot overflows SQLite integer")?;
        let last_valid_block_height = a
            .last_valid_block_height
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "last valid block height overflows SQLite integer")?;
        if last_valid_block_height == Some(0) {
            return Err("last valid block height must be positive".into());
        }
        sql(self.conn.execute(
            "INSERT INTO attempts(sig, kind, object_key, bell, region, class, payer, bid_milli, cu_limit,
                 heap, first_valid_slot, sent_slot, landed_slot, status, code, fee,
                 last_valid_block_height, write_id, tag)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                a.sig,
                a.kind,
                a.object_key,
                a.bell,
                a.region,
                a.class,
                a.payer,
                bid,
                a.cu_limit,
                a.heap,
                first_valid_slot,
                sent_slot,
                landed_slot,
                a.status,
                a.code,
                fee,
                last_valid_block_height,
                a.write_id,
                a.tag
            ],
        ))
        .map(|_| ())
    }

    /// Sets an attempt's outcome.
    pub fn set_status(
        &self,
        sig: &str,
        status: &str,
        landed_slot: Option<u64>,
        code: Option<u32>,
    ) -> Result<(), String> {
        let landed_slot = landed_slot
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "landed slot overflows SQLite integer")?;
        if self.crash.is_some() {
            let kind: Option<String> = self
                .conn
                .query_row(
                    "SELECT kind FROM attempts WHERE sig = ?1",
                    params![sig],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            self.maybe_crash("status", kind.as_deref().unwrap_or(""));
        }
        // A settled row is durable evidence. Do not overwrite it with a
        // different RPC result; an exact repeated observation is harmless.
        // Legacy slot-age "expired" and "superseded" are not chain evidence
        // and can still be corrected by a finalized signature status.
        let updated = sql(self.conn.execute(
            "UPDATE attempts SET status = ?2, landed_slot = ?3, code = ?4
             WHERE sig = ?1 AND (status IN ('sent', 'expired', 'superseded')
                 OR (status = ?2 AND landed_slot IS ?3 AND code IS ?4))",
            params![sig, status, landed_slot, code],
        ))?;
        if updated == 0 {
            return Err(format!(
                "attempt {sig} is missing or has a conflicting settled status"
            ));
        }
        Ok(())
    }

    /// Persist one finalized signature observed during restart. This is an
    /// audit notice, not a duty outcome: no handler is replayed from it.
    /// The attempt transition, notice row, and alert commit together.
    /// Returns false only for the exact same durable observation.
    pub fn record_recovered_finality(
        &self,
        attempt: &Attempt,
        status: &str,
        slot: u64,
        code: Option<u32>,
    ) -> Result<bool, String> {
        if !matches!(status, "landed" | "failed" | "done") {
            return Err(format!("invalid recovered finality status {status}"));
        }
        let slot_i64 = i64::try_from(slot).map_err(|_| "landed slot overflows SQLite integer")?;
        let code_i64 = code.map(i64::from);
        let tx = sql(self.conn.unchecked_transaction())?;
        let row: Option<AttemptFinalityRow> = sql(tx
            .query_row(
                "SELECT kind, object_key, write_id, status, landed_slot, code
                     FROM attempts WHERE sig = ?1",
                params![attempt.sig],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional())?;
        let Some((kind, key, write_id, current_status, current_slot, current_code)) = row else {
            return Err(format!("recovered attempt {} is missing", attempt.sig));
        };
        if kind != attempt.kind || key != attempt.object_key || write_id != attempt.write_id {
            return Err(format!(
                "recovered attempt {} has conflicting identity",
                attempt.sig
            ));
        }
        let notice: Option<RecoveredFinalityRow> = sql(tx
            .query_row(
                "SELECT kind, object_key, write_id, status, slot, code
                     FROM recovered_finality WHERE sig = ?1",
                params![attempt.sig],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional())?;
        if let Some((saved_kind, saved_key, saved_write_id, saved_status, saved_slot, saved_code)) =
            notice
        {
            if (
                saved_kind.as_str(),
                saved_key.as_str(),
                saved_write_id.as_ref(),
                saved_status.as_str(),
                saved_slot,
                saved_code,
            ) != (
                attempt.kind.as_str(),
                attempt.object_key.as_str(),
                attempt.write_id.as_ref(),
                status,
                slot_i64,
                code_i64,
            ) || current_status != status
                || current_slot != Some(slot_i64)
                || current_code != code_i64
            {
                return Err(format!(
                    "recovered attempt {} has conflicting finality",
                    attempt.sig
                ));
            }
            sql(tx.commit())?;
            return Ok(false);
        }
        if current_status != "sent"
            && !(current_status == "expired" && kind == crate::engine::PAYER_CARE_KIND)
        {
            return Err(format!(
                "recovered attempt {} is not in flight",
                attempt.sig
            ));
        }
        let changed = sql(tx.execute(
            "UPDATE attempts SET status = ?2, landed_slot = ?3, code = ?4
             WHERE sig = ?1 AND status = ?5",
            params![attempt.sig, status, slot_i64, code_i64, current_status],
        ))?;
        if changed != 1 {
            return Err(format!(
                "recovered attempt {} changed during reconciliation",
                attempt.sig
            ));
        }
        // A crash here must roll the attempt transition back as well.
        self.maybe_crash("recovered-finality", &attempt.kind);
        let detail = serde_json::json!({
            "sig": attempt.sig,
            "write_id": attempt.write_id,
            "status": status,
            "slot": slot,
            "key": attempt.object_key,
            "code": code,
        })
        .to_string();
        sql(tx.execute(
            "INSERT INTO alerts(slot, kind, detail) VALUES(?1, 'recovered-finality', ?2)",
            params![slot_i64, detail],
        ))?;
        let alert_id = tx.last_insert_rowid();
        sql(tx.execute(
            "INSERT INTO recovered_finality(sig, kind, object_key, write_id, status, slot, code, alert_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![attempt.sig, attempt.kind, attempt.object_key, attempt.write_id, status, slot_i64, code_i64, alert_id],
        ))?;
        sql(tx.commit())?;
        Ok(true)
    }

    fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
        Ok(Attempt {
            sig: r.get(0)?,
            kind: r.get(1)?,
            tag: r
                .get::<_, Option<i64>>(18)?
                .map(|v| {
                    u8::try_from(v).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(18, v))
                })
                .transpose()?,
            object_key: r.get(2)?,
            write_id: r.get(17)?,
            bell: r.get(3)?,
            region: r.get(4)?,
            class: r.get(5)?,
            payer: r.get(6)?,
            bid_milli: nonnegative_u64(r, 7)?,
            cu_limit: r.get(8)?,
            heap: r.get(9)?,
            first_valid_slot: nonnegative_u64(r, 10)?,
            sent_slot: nonnegative_u64(r, 11)?,
            last_valid_block_height: r
                .get::<_, Option<i64>>(16)?
                .map(|v| {
                    u64::try_from(v).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(16, v))
                })
                .transpose()?,
            landed_slot: r
                .get::<_, Option<i64>>(12)?
                .map(|v| {
                    u64::try_from(v).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(12, v))
                })
                .transpose()?,
            status: r.get(13)?,
            code: r.get(14)?,
            fee: nonnegative_u64(r, 15)?,
        })
    }

    const COLS: &'static str =
        "sig, kind, object_key, bell, region, class, payer, bid_milli, cu_limit, heap,
         first_valid_slot, sent_slot, landed_slot, status, code, fee, last_valid_block_height, write_id, tag";

    /// Attempts still marked `sent` (in flight at a crash).
    pub fn in_flight(&self) -> Result<Vec<Attempt>, String> {
        let mut st = sql(self.conn.prepare(&format!(
            "SELECT {} FROM attempts WHERE status = 'sent' ORDER BY sent_slot",
            Self::COLS
        )))?;
        let rows = sql(st.query_map([], Self::row))?;
        sql(rows.collect())
    }

    /// A previous keeper could mark a care transfer "expired" using slot
    /// age alone. That is not evidence that its System transfer did not
    /// land, so a newer keeper must not silently top up the same account.
    pub fn has_expired_attempt(&self, kind: &str) -> Result<bool, String> {
        let found: i64 = sql(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts WHERE kind = ?1 AND status = 'expired')",
            params![kind],
            |r| r.get(0),
        ))?;
        Ok(found != 0)
    }

    /// Legacy slot-age "expiry" rows still need signature reconciliation.
    pub fn expired_attempts_of_kind(&self, kind: &str) -> Result<Vec<Attempt>, String> {
        let mut st = sql(self.conn.prepare(&format!(
            "SELECT {} FROM attempts WHERE kind = ?1 AND status = 'expired' ORDER BY sent_slot",
            Self::COLS
        )))?;
        let rows = sql(st.query_map(params![kind], Self::row))?;
        sql(rows.collect())
    }

    /// Highest finalized success or failure recorded for a kind, including
    /// attempts resolved before a crash. Even a failed transfer pays a fee.
    pub fn latest_settled_slot(&self, kind: &str) -> Result<Option<u64>, String> {
        let slot: Option<i64> = sql(self.conn.query_row(
            "SELECT MAX(landed_slot) FROM attempts WHERE kind = ?1 AND status IN ('landed', 'failed')",
            params![kind],
            |r| r.get(0),
        ))?;
        slot.map(|v| u64::try_from(v).map_err(|_| "negative landed slot".into()))
            .transpose()
    }

    /// Every attempt of an object.
    pub fn attempts_of(&self, object_key: &str) -> Result<Vec<Attempt>, String> {
        let mut st = sql(self.conn.prepare(&format!(
            "SELECT {} FROM attempts WHERE object_key = ?1 ORDER BY sent_slot",
            Self::COLS
        )))?;
        let rows = sql(st.query_map(params![object_key], Self::row))?;
        sql(rows.collect())
    }

    /// A settled sibling means a still-sent attempt cannot be given a new
    /// per-write fee cap after restart. This is deliberately conservative:
    /// the old journal does not identify which attempts shared a write cap.
    pub fn has_settled_attempt_of(&self, object_key: &str) -> Result<bool, String> {
        let found: i64 = sql(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts WHERE object_key = ?1 AND status != 'sent')",
            params![object_key],
            |r| r.get(0),
        ))?;
        Ok(found != 0)
    }

    /// A settled variant in this write keeps its fee reservation on restart.
    /// Old rows have no cohort identity, so they use the conservative object
    /// key scope instead of guessing which prior attempts shared the cap.
    pub fn has_settled_attempt_in_write(&self, attempt: &Attempt) -> Result<bool, String> {
        let Some(write_id) = attempt.write_id.as_deref() else {
            return self.has_settled_attempt_of(&attempt.object_key);
        };
        let found: i64 = sql(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts WHERE write_id = ?1 AND status != 'sent')",
            params![write_id],
            |r| r.get(0),
        ))?;
        Ok(found != 0)
    }

    /// Distinct object keys starting with `prefix`: a range on the
    /// `attempts_object` index, `prefix ≤ key < succ(prefix)` (W6T-2; the
    /// `substr` form scanned the whole table, 4.5 ms a call at 112k
    /// attempts, 18-21 s for the 288 × 16 calls of a restart's first tick).
    /// SQLite compares TEXT bytewise and UTF-8 keeps code-point order, so
    /// the successor is the prefix with its last character incremented.
    pub fn object_keys_with_prefix(&self, prefix: &str) -> Result<Vec<String>, String> {
        let succ = {
            let mut s = prefix.to_string();
            s.pop().and_then(|c| {
                // The next code point (skipping the surrogate gap).
                let n = (c as u32 + 1..=char::MAX as u32).find_map(char::from_u32)?;
                s.push(n);
                Some(s)
            })
        };
        let rows: Vec<String> = match succ {
            Some(end) => {
                let mut st = sql(self.conn.prepare(
                    "SELECT DISTINCT object_key FROM attempts WHERE object_key >= ?1 AND object_key < ?2",
                ))?;
                let rows = sql(st.query_map(params![prefix, end], |r| r.get::<_, String>(0)))?;
                sql(rows.collect())?
            }
            // The empty prefix (every key), or one ending in char::MAX.
            None => {
                let mut st = sql(self
                    .conn
                    .prepare("SELECT DISTINCT object_key FROM attempts WHERE object_key >= ?1"))?;
                let rows = sql(st.query_map(params![prefix], |r| r.get::<_, String>(0)))?;
                let all: Vec<String> = sql(rows.collect())?;
                all.into_iter().filter(|k| k.starts_with(prefix)).collect()
            }
        };
        Ok(rows)
    }

    /// `(status, count)` over all attempts.
    pub fn status_counts(&self) -> Result<Vec<(String, u64)>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT status, COUNT(*) FROM attempts GROUP BY status ORDER BY status"))?;
        let rows = sql(st.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        }))?;
        sql(rows.collect())
    }

    pub fn set_cursor(&self, name: &str, value: &str) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO cursor(name, value) VALUES(?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2",
            params![name, value],
        ))
        .map(|_| ())
    }

    pub fn cursor(&self, name: &str) -> Result<Option<String>, String> {
        sql(self
            .conn
            .query_row(
                "SELECT value FROM cursor WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional())
    }

    pub fn save_plaintext(
        &self,
        host: u64,
        bell: u32,
        plain: &[u8],
        salt: &[u8],
    ) -> Result<(), String> {
        self.maybe_crash("plaintext", "reveal");
        sql(self.conn.execute(
            "INSERT OR REPLACE INTO plaintexts(host, bell, plain, salt) VALUES(?1, ?2, ?3, ?4)",
            params![host as i64, bell, plain, salt],
        ))
        .map(|_| ())
    }

    /// A journalled plaintext and salt (W4-C's reveal cache).
    pub fn plaintext(&self, host: u64, bell: u32) -> Result<Option<PlainSalt>, String> {
        sql(self
            .conn
            .query_row(
                "SELECT plain, salt FROM plaintexts WHERE host = ?1 AND bell = ?2",
                params![host as i64, bell],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())
    }

    /// Owner reveal material accepted by `/v1/reveal` (⑱): it waits for
    /// THE anchor of its arrival, so it must outlive a restart (before, it
    /// became a journalled Reveal attempt at once).
    /// The march's track is also kept in `owner_track` (one transaction):
    /// a track acknowledged earlier for the same march stays known.
    pub fn save_owner_material(&self, m: &OwnerRow) -> Result<(), String> {
        let tx = sql(self.conn.unchecked_transaction())?;
        sql(tx.execute(
            "INSERT OR REPLACE INTO owner_material(host, bell, track, holding, transit_slot, plain, salt, ct_hash)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                m.host as i64,
                m.bell,
                m.track,
                m.holding,
                m.transit_slot,
                m.plain,
                m.salt,
                m.ct_hash
            ],
        ))?;
        sql(tx.execute(
            "INSERT OR IGNORE INTO owner_track(track, host, bell) VALUES(?1, ?2, ?3)",
            params![m.track, m.host as i64, m.bell],
        ))?;
        sql(tx.commit())
    }

    /// Every acknowledged owner track and its march `(track, host, bell)`.
    pub fn owner_tracks(&self) -> Result<Vec<(String, u64, u32)>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT track, host, bell FROM owner_track ORDER BY rowid"))?;
        let rows = sql(st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)? as u64,
                r.get(2)?,
            ))
        }))?;
        rows.map(sql).collect()
    }

    /// Every journalled owner material.
    pub fn owner_materials(&self) -> Result<Vec<OwnerRow>, String> {
        let mut st = sql(self.conn.prepare(
            "SELECT host, bell, track, holding, transit_slot, plain, salt, ct_hash FROM owner_material",
        ))?;
        let rows = sql(st.query_map([], |r| {
            Ok(OwnerRow {
                host: r.get::<_, i64>(0)? as u64,
                bell: r.get(1)?,
                track: r.get(2)?,
                holding: r.get(3)?,
                transit_slot: r.get(4)?,
                plain: r.get(5)?,
                salt: r.get(6)?,
                ct_hash: r.get(7)?,
            })
        }))?;
        rows.map(sql).collect()
    }

    pub fn note_payer(
        &self,
        pool: &str,
        i: u32,
        address: &str,
        balance: u64,
        slot: u64,
    ) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO payers(pool, i, address, balance_seen, slot) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(pool, i) DO UPDATE SET address = ?3, balance_seen = ?4, slot = ?5",
            params![pool, i, address, balance as i64, slot as i64],
        ))
        .map(|_| ())
    }

    /// One conquest row (MC §8.2): a horn the watcher saw (`event` its
    /// name, `object` the province) or a conquest write that landed
    /// (`event` the write kind, `object` its key). Evidence only: queues are
    /// rebuilt from the Provinces and MarchStates after a restart.
    pub fn conquest(
        &self,
        slot: u64,
        bell: Option<u32>,
        event: &str,
        object: &str,
        detail: &str,
    ) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO conquest(slot, bell, event, object, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![slot as i64, bell.map(|b| b as i64), event, object, detail],
        ))?;
        Ok(())
    }

    /// The slot of the last horn row (horn names are upper case, write
    /// kinds lower case); 0 when none.
    pub fn max_horn_slot(&self) -> Result<u64, String> {
        let v: Option<i64> = sql(self.conn.query_row(
            "SELECT MAX(slot) FROM conquest WHERE event = UPPER(event)",
            [],
            |r| r.get(0),
        ))?;
        Ok(v.unwrap_or(0).max(0) as u64)
    }

    /// Conquest rows of `event`: `(slot, bell, object)`.
    pub fn conquest_rows(&self, event: &str) -> Result<Vec<(u64, Option<u32>, String)>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT slot, bell, object FROM conquest WHERE event = ?1 ORDER BY id"))?;
        let rows = sql(st.query_map(params![event], |r| {
            Ok((
                r.get::<_, i64>(0)? as u64,
                r.get::<_, Option<i64>>(1)?.map(|b| b as u32),
                r.get::<_, String>(2)?,
            ))
        }))?;
        let mut v = vec![];
        for x in rows {
            v.push(sql(x)?);
        }
        Ok(v)
    }

    pub fn alert(&self, slot: u64, kind: &str, detail: &str) -> Result<(), String> {
        sql(self.conn.execute(
            "INSERT INTO alerts(slot, kind, detail) VALUES(?1, ?2, ?3)",
            params![slot as i64, kind, detail],
        ))
        .map(|_| ())
    }

    pub fn alerts(&self, kind: &str) -> Result<Vec<(u64, String)>, String> {
        let mut st = sql(self
            .conn
            .prepare("SELECT slot, detail FROM alerts WHERE kind = ?1 ORDER BY id"))?;
        let rows = sql(st.query_map(params![kind], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))
        }))?;
        sql(rows.collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(sig: &str, status: &str) -> Attempt {
        Attempt {
            sig: sig.into(),
            kind: "anchor".into(),
            tag: None,
            object_key: "anchor:5:3".into(),
            write_id: None,
            bell: Some(5),
            region: Some(3),
            class: "D".into(),
            payer: "P".into(),
            bid_milli: 100,
            fee: 5_000,
            cu_limit: 345_000,
            heap: None,
            first_valid_slot: 10,
            sent_slot: 10,
            last_valid_block_height: None,
            landed_slot: None,
            status: status.into(),
            code: None,
        }
    }

    #[test]
    fn attempts_survive_reopen_and_the_lock_is_exclusive() {
        let dir = std::env::temp_dir().join(format!("keeper-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("j.sqlite");
        let l1 = lock(&p).unwrap();
        assert!(lock(&p).is_err(), "a second keeper is refused");
        {
            let j = Journal::open(&p).unwrap();
            j.record_attempt(&a("s1", "sent")).unwrap();
            j.record_attempt(&a("s2", "sent")).unwrap();
            j.set_status("s1", "landed", Some(11), None).unwrap();
            j.set_cursor("ingest", "42").unwrap();
            j.alert(11, "contested", "bell 5 region 3").unwrap();
        }
        let j = Journal::open(&p).unwrap();
        let f = j.in_flight().unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].sig, "s2");
        assert_eq!(j.attempts_of("anchor:5:3").unwrap().len(), 2);
        assert_eq!(j.cursor("ingest").unwrap().as_deref(), Some("42"));
        assert_eq!(
            j.status_counts().unwrap(),
            vec![("landed".into(), 1), ("sent".into(), 1)]
        );
        assert_eq!(j.alerts("contested").unwrap().len(), 1);
        drop(l1);
        assert!(lock(&p).is_ok(), "released with the file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settled_sibling_query_is_scoped_to_object_key() {
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        j.record_attempt(&a("pending", "sent")).unwrap();
        assert!(!j.has_settled_attempt_of("anchor:5:3").unwrap());
        let mut other = a("other", "failed");
        other.object_key = "anchor:5:4".into();
        j.record_attempt(&other).unwrap();
        assert!(!j.has_settled_attempt_of("anchor:5:3").unwrap());
        j.record_attempt(&a("settled", "failed")).unwrap();
        assert!(j.has_settled_attempt_of("anchor:5:3").unwrap());
    }

    #[test]
    fn settled_sibling_query_uses_exact_write_id_for_new_attempts() {
        let j = Journal::open(Path::new(":memory:")).unwrap();
        let mut pending = a("pending", "sent");
        pending.write_id = Some("write-b".into());
        j.record_attempt(&pending).unwrap();

        let mut prior_write = a("prior", "failed");
        prior_write.write_id = Some("write-a".into());
        j.record_attempt(&prior_write).unwrap();
        assert!(!j.has_settled_attempt_in_write(&pending).unwrap());

        let mut sibling = a("sibling", "failed");
        sibling.write_id = pending.write_id.clone();
        j.record_attempt(&sibling).unwrap();
        assert!(j.has_settled_attempt_in_write(&pending).unwrap());
        assert_eq!(j.in_flight().unwrap()[0].write_id, pending.write_id);

        let legacy = a("legacy", "sent");
        assert!(j.has_settled_attempt_in_write(&legacy).unwrap());
        let mut invalid = a("invalid", "sent");
        invalid.write_id = Some("  ".into());
        assert!(j.record_attempt(&invalid).is_err());
    }

    #[test]
    fn tag_roundtrips_and_invalid_sqlite_values_refuse_resume() {
        let j = Journal::open(Path::new(":memory:")).unwrap();
        let mut attempt = a("tagged", "sent");
        attempt.tag = Some(u8::MAX);
        j.record_attempt(&attempt).unwrap();
        assert_eq!(j.in_flight().unwrap()[0].tag, Some(u8::MAX));

        for value in ["-1", "256", "'invalid'"] {
            j.conn
                .execute(&format!("UPDATE attempts SET tag = {value}"), [])
                .unwrap();
            assert!(j.in_flight().is_err());
            assert!(Journal::check_known_fees(&j.conn).is_err());
        }
    }

    #[test]
    fn status_update_requires_an_attempt_and_preserves_settled_evidence() {
        let j = Journal::open(Path::new(":memory:")).unwrap();
        assert!(j.set_status("missing", "landed", Some(11), None).is_err());
        j.record_attempt(&a("sig", "sent")).unwrap();
        j.set_status("sig", "failed", Some(11), Some(7)).unwrap();
        j.set_status("sig", "failed", Some(11), Some(7)).unwrap();
        assert!(j.set_status("sig", "landed", Some(12), None).is_err());
        assert!(j.set_status("sig", "failed", Some(12), Some(7)).is_err());
        assert!(j.set_status("sig", "failed", Some(11), None).is_err());
        let attempt = &j.attempts_of("anchor:5:3").unwrap()[0];
        assert_eq!(attempt.status, "failed");
        assert_eq!(attempt.landed_slot, Some(11));
        assert_eq!(attempt.code, Some(7));

        j.record_attempt(&a("legacy", "expired")).unwrap();
        j.set_status("legacy", "landed", Some(13), None).unwrap();
        assert_eq!(
            j.attempts_of("anchor:5:3")
                .unwrap()
                .into_iter()
                .find(|a| a.sig == "legacy")
                .unwrap()
                .status,
            "landed"
        );
    }

    #[test]
    fn recovered_finality_crash_rolls_back_then_reopens_with_one_notice() {
        let dir = std::env::temp_dir().join(format!(
            "keeper-recovered-finality-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        let mut attempt = a("recovered-sig", "sent");
        attempt.write_id = Some("write-42".into());
        let mut journal = Journal::open(&path).unwrap();
        journal.record_attempt(&attempt).unwrap();
        journal.crash = Some(CrashAt::new("recovered-finality", &["anchor"], 1));
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            journal
                .record_recovered_finality(&attempt, "landed", 19, None)
                .unwrap();
        }));
        assert!(crash.is_err());
        drop(journal);

        let journal = Journal::open_existing(&path).unwrap();
        assert_eq!(journal.in_flight().unwrap().len(), 1);
        assert!(journal.alerts("recovered-finality").unwrap().is_empty());
        let notices: i64 = journal
            .conn
            .query_row("SELECT COUNT(*) FROM recovered_finality", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            notices, 0,
            "a crash after status update rolls the transaction back"
        );

        assert!(journal
            .record_recovered_finality(&attempt, "landed", 19, None)
            .unwrap());
        assert!(!journal
            .record_recovered_finality(&attempt, "landed", 19, None)
            .unwrap());
        for (status, slot, code) in [
            ("failed", 19, Some(7)),
            ("landed", 20, None),
            ("landed", 19, Some(7)),
        ] {
            assert!(journal
                .record_recovered_finality(&attempt, status, slot, code)
                .is_err());
        }
        let mut wrong_write = attempt.clone();
        wrong_write.write_id = Some("write-other".into());
        assert!(journal
            .record_recovered_finality(&wrong_write, "landed", 19, None)
            .is_err());
        let row = &journal.attempts_of(&attempt.object_key).unwrap()[0];
        assert_eq!(
            (row.status.as_str(), row.landed_slot, row.code),
            ("landed", Some(19), None)
        );
        let alerts = journal.alerts("recovered-finality").unwrap();
        assert_eq!(alerts.len(), 1);
        let detail: serde_json::Value = serde_json::from_str(&alerts[0].1).unwrap();
        assert_eq!(detail["sig"], attempt.sig);
        assert_eq!(detail["write_id"], "write-42");
        assert_eq!(detail["status"], "landed");
        assert_eq!(detail["slot"], 19);
        assert_eq!(detail["key"], attempt.object_key);
        let notices: i64 = journal
            .conn
            .query_row("SELECT COUNT(*) FROM recovered_finality", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notices, 1);
        drop(journal);
        let reopened = Journal::open_existing(&path).unwrap();
        assert_eq!(reopened.alerts("recovered-finality").unwrap().len(), 1);
        assert!(!reopened
            .record_recovered_finality(&attempt, "landed", 19, None)
            .unwrap());
        assert_eq!(reopened.alerts("recovered-finality").unwrap().len(), 1);
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recovered_finality_sql_failure_is_atomic_and_legacy_care_can_resolve() {
        let journal = Journal::open(Path::new(":memory:")).unwrap();
        let mut care = a("legacy-care", "expired");
        care.kind = crate::engine::PAYER_CARE_KIND.into();
        care.object_key = "care:old:transfer:1".into();
        journal.record_attempt(&care).unwrap();
        journal
            .conn
            .execute_batch(
                "CREATE TRIGGER abort_recovery BEFORE INSERT ON recovered_finality
                 BEGIN SELECT RAISE(ABORT, 'injected notice failure'); END;",
            )
            .unwrap();
        assert!(journal
            .record_recovered_finality(&care, "failed", 21, Some(7))
            .is_err());
        assert_eq!(
            journal
                .expired_attempts_of_kind(crate::engine::PAYER_CARE_KIND)
                .unwrap()
                .len(),
            1
        );
        assert!(journal.alerts("recovered-finality").unwrap().is_empty());
        journal
            .conn
            .execute_batch("DROP TRIGGER abort_recovery")
            .unwrap();
        assert!(journal
            .record_recovered_finality(&care, "failed", 21, Some(7))
            .unwrap());
        assert!(!journal
            .record_recovered_finality(&care, "failed", 21, Some(7))
            .unwrap());
        assert!(journal
            .expired_attempts_of_kind(crate::engine::PAYER_CARE_KIND)
            .unwrap()
            .is_empty());
        assert_eq!(journal.alerts("recovered-finality").unwrap().len(), 1);

        let ordinary_expired = a("ordinary-expired", "expired");
        journal.record_attempt(&ordinary_expired).unwrap();
        assert!(journal
            .record_recovered_finality(&ordinary_expired, "landed", 22, None)
            .is_err());
    }

    #[test]
    fn old_journal_migrates_expiry_height_without_inventing_evidence() {
        let dir = std::env::temp_dir().join(format!(
            "keeper-expiry-height-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        let journal = Journal::open(&path).unwrap();
        journal.record_attempt(&a("old", "sent")).unwrap();
        drop(journal);

        // Reproduce the previous attempts schema while retaining the other
        // journal tables. The migration must leave this row's height,
        // write identity, and instruction tag unknown.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE attempts_legacy AS SELECT sig, kind, object_key, bell, region, class,
                 payer, bid_milli, cu_limit, heap, first_valid_slot, sent_slot, landed_slot,
                 status, code, fee FROM attempts;
             DROP TABLE attempts;
             DROP TABLE recovered_finality;
             ALTER TABLE attempts_legacy RENAME TO attempts;",
        )
        .unwrap();
        drop(conn);

        let journal = Journal::open_existing(&path).unwrap();
        assert!(journal.alerts("recovered-finality").unwrap().is_empty());
        let old = journal.in_flight().unwrap();
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].last_valid_block_height, None);
        assert_eq!(old[0].write_id, None);
        assert_eq!(old[0].tag, None);
        let mut new = a("new", "sent");
        new.last_valid_block_height = Some(345);
        new.write_id = Some("write-new".into());
        new.tag = Some(37);
        journal.record_attempt(&new).unwrap();
        assert_eq!(
            journal.in_flight().unwrap()[1].last_valid_block_height,
            Some(345)
        );
        assert_eq!(journal.in_flight().unwrap()[1].write_id, new.write_id);
        assert_eq!(journal.in_flight().unwrap()[1].tag, Some(37));
        drop(journal);
        let reopened = Journal::open(&path).unwrap();
        assert_eq!(reopened.in_flight().unwrap()[0].write_id, None);
        assert_eq!(reopened.in_flight().unwrap()[1].write_id, new.write_id);
        assert_eq!(reopened.in_flight().unwrap()[0].tag, None);
        assert_eq!(reopened.in_flight().unwrap()[1].tag, Some(37));
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_old_fee_refuses_reopen_and_duplicate_signature_is_not_replaced() {
        let dir = std::env::temp_dir().join(format!(
            "keeper-journal-fee-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        let j = Journal::open(&path).unwrap();
        j.record_attempt(&a("s1", "sent")).unwrap();
        assert!(j.record_attempt(&a("s1", "sent")).is_err());
        assert_eq!(j.attempts_of("anchor:5:3").unwrap()[0].fee, 5_000);
        j.conn
            .execute("UPDATE attempts SET fee = NULL WHERE sig = 's1'", [])
            .unwrap();
        drop(j);
        assert!(matches!(Journal::open(&path), Err(e) if e.contains("attempts without fee")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn open_existing_never_creates_an_empty_journal() {
        let dir = std::env::temp_dir().join(format!(
            "keeper-existing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        assert!(Journal::open_existing(&path).is_err());
        assert!(!path.exists(), "resume must not create an empty database");
        let j = Journal::open(&path).unwrap();
        j.record_attempt(&a("s1", "sent")).unwrap();
        drop(j);
        let j = Journal::open_existing(&path).unwrap();
        assert_eq!(j.in_flight().unwrap().len(), 1);
        j.conn.execute_batch("DROP TABLE owner_material").unwrap();
        drop(j);
        assert!(
            Journal::open_existing(&path).is_err(),
            "missing schema must refuse"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_attempt_numbers_are_rejected_instead_of_wrapping() {
        let j = Journal::open(Path::new(":memory:")).unwrap();
        j.record_attempt(&a("s1", "sent")).unwrap();
        for field in [
            "bid_milli",
            "first_valid_slot",
            "sent_slot",
            "last_valid_block_height",
            "landed_slot",
            "fee",
        ] {
            j.conn
                .execute(
                    &format!("UPDATE attempts SET {field} = -1 WHERE sig = 's1'"),
                    [],
                )
                .unwrap();
            assert!(
                j.in_flight().is_err(),
                "negative {field} must refuse reading"
            );
            assert!(
                Journal::check_known_fees(&j.conn).is_err(),
                "negative {field} must refuse resume"
            );
            let original = if field == "landed_slot" || field == "last_valid_block_height" {
                "NULL"
            } else if field == "fee" {
                "5000"
            } else if field == "bid_milli" {
                "100"
            } else {
                "10"
            };
            j.conn
                .execute(
                    &format!("UPDATE attempts SET {field} = {original} WHERE sig = 's1'"),
                    [],
                )
                .unwrap();
        }
        assert_eq!(j.in_flight().unwrap().len(), 1);
        let mut too_large = a("s2", "sent");
        too_large.sent_slot = i64::MAX as u64 + 1;
        assert!(j.record_attempt(&too_large).is_err());
        too_large.sent_slot = 10;
        too_large.bid_milli = i64::MAX as u64 + 1;
        assert!(j.record_attempt(&too_large).is_err());
        too_large.bid_milli = 100;
        too_large.last_valid_block_height = Some(0);
        assert!(j.record_attempt(&too_large).is_err());
        too_large.last_valid_block_height = Some(i64::MAX as u64 + 1);
        assert!(j.record_attempt(&too_large).is_err());
        assert!(j
            .set_status("s1", "landed", Some(i64::MAX as u64 + 1), None)
            .is_err());
        assert_eq!(j.in_flight().unwrap().len(), 1);
    }

    #[test]
    fn open_existing_rejects_out_of_range_sqlite_values() {
        let dir = std::env::temp_dir().join(format!(
            "keeper-journal-range-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        let j = Journal::open(&path).unwrap();
        j.record_attempt(&a("s1", "sent")).unwrap();
        j.conn
            .execute("UPDATE attempts SET sent_slot = -1 WHERE sig = 's1'", [])
            .unwrap();
        drop(j);
        assert!(Journal::open_existing(&path).is_err());

        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE attempts SET sent_slot = 10, fee = 9223372036854775808 WHERE sig = 's1'",
            [],
        )
        .unwrap();
        drop(conn);
        assert!(Journal::open_existing(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod prefix_tests {
    use super::*;

    /// Cause C (w6-s7 criterion 3): the prefix query scanned the whole
    /// attempts table (4.5 ms a call at 112k attempts); a restart's first
    /// tick makes 288 × 16 of them (18-21 s, ≈ 50 slots). It is an index
    /// range now: the same keys, and the restart's calls in < 1 s at 100k
    /// rows.
    #[test]
    fn object_keys_with_prefix_matches_scan() {
        let j = Journal::open(Path::new(":memory:")).unwrap();
        j.conn.execute_batch("BEGIN").unwrap();
        let mut n = 0u64;
        let mut add = |key: String, kind: &str| {
            n += 1;
            j.record_attempt(&Attempt {
                sig: format!("s{n}"),
                kind: kind.into(),
                tag: None,
                object_key: key,
                write_id: None,
                bell: None,
                region: None,
                class: "D".into(),
                payer: "P".into(),
                bid_milli: 100,
                fee: 5_000,
                cu_limit: 1,
                heap: None,
                first_valid_slot: 1,
                sent_slot: 1,
                last_valid_block_height: None,
                landed_slot: None,
                status: "landed".into(),
                code: None,
            })
            .unwrap();
        };
        for b in 0..620u32 {
            for r in 0..16u8 {
                for v in 0..8u32 {
                    add(format!("seed:{b}:{r}:{}", (b * 7 + v) % 256), "seed");
                }
                add(format!("anchor:{b}:{r}"), "anchor");
                add(format!("anchor-multi:{b}:{}", r % 3), "anchor-multi");
            }
        }
        for i in 0..400u32 {
            add(
                format!("close:day:{},{}:{}", i % 20, i / 20, i % 7),
                "close",
            );
            add(format!("seed:ü{i}"), "seed");
        }
        j.conn.execute_batch("COMMIT").unwrap();
        let total: i64 = j
            .conn
            .query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))
            .unwrap();
        assert!(total >= 100_000, "{total} rows");
        let scan = |p: &str| -> Vec<String> {
            let mut st = j
                .conn
                .prepare("SELECT DISTINCT object_key FROM attempts WHERE substr(object_key, 1, length(?1)) = ?1")
                .unwrap();
            let mut v: Vec<String> = st
                .query_map(params![p], |r| r.get(0))
                .unwrap()
                .map(|x| x.unwrap())
                .collect();
            v.sort();
            v
        };
        for p in [
            "seed:5:3:",
            "seed:5:",
            "seed:61",
            "seed:619:15:",
            "anchor:",
            "anchor-multi:7:",
            "close:day:3,",
            "seed:ü",
            "seed:ü1",
            "zzz",
            "",
        ] {
            let mut got = j.object_keys_with_prefix(p).unwrap();
            got.sort();
            assert_eq!(got, scan(p), "prefix {p:?}");
        }
        // A restart's first tick: every (bell, region) of the rescan window.
        let t0 = std::time::Instant::now();
        let mut found = 0;
        for b in 300..588u32 {
            for r in 0..16u8 {
                found += j
                    .object_keys_with_prefix(&format!("seed:{b}:{r}:"))
                    .unwrap()
                    .len();
            }
        }
        let dt = t0.elapsed();
        assert!(found > 0);
        assert!(
            dt < std::time::Duration::from_secs(1),
            "288 × 16 prefix queries at {total} rows took {dt:?}"
        );
    }
}
