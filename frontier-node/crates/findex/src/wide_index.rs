//! Separate opt-in index for frame-attributed PS2, PSW1 and PSWC observations.
//! This never writes the legacy tables or calls their coverage complete.
//! Chain continuity is checked from zero; source coverage, signatures,
//! gameplay validity and capture/account agreement remain unverified.
//! PSWC is retained by its original tag/body, scoped by the public season/program
//! world digest, without any invented Province, Holding, host or chain link.

use frontier_abi::addr::AddrCtx;
use sha2::{Digest, Sha256};
use std::path::Path;

use fclient::{
    ports::TxRecord,
    typed_log::{decode_transaction, decode_transaction_with_resident, TransactionRecords},
};
use frontier_abi::world_index::{
    event::{self, WideEntity, WideKind, WideTarget},
    WorldId,
};
use rusqlite::{params, Connection, OptionalExtension};
use solana_address::Address;

const SCHEMA: i64 = 3;
pub const MAX_PAGE: usize = 256;

fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}
fn seq_i64(n: u64) -> Result<i64, String> {
    i64::try_from(n).map_err(|_| "archive sequence exceeds index capacity".into())
}
fn u64_blob(bytes: Vec<u8>) -> Result<u64, String> {
    Ok(u64::from_be_bytes(
        bytes.try_into().map_err(|_| "invalid stored sequence")?,
    ))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexStatus {
    pub last_seq: u64,
    /// Content stamp of the observed archive prefix, not source verification.
    pub snapshot: [u8; 32],
    /// Only caught up to the local archive, never proof of source coverage.
    pub caught_up: bool,
    pub blocked: Option<String>,
    pub source_coverage: &'static str,
    pub capture_verification: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainState {
    pub seq: u64,
    pub head: [u8; 32],
    pub terminal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedEvent {
    pub event: u64,
    pub archive_seq: u64,
    pub ordinal: u64,
    pub format: String,
    pub body: Vec<u8>,
    /// Canonical full keys; never a dense index or legacy host alias.
    pub province: Option<Vec<u8>>,
    pub holding: Option<Vec<u8>>,
    pub host: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventPage {
    pub events: Vec<ObservedEvent>,
    pub next: u64,
    pub more: bool,
    pub indexed_through: u64,
    pub snapshot: [u8; 32],
    pub source_coverage: &'static str,
}

/// A dedicated cache. Durable blockers cannot be cleared by a later page.
/// Recovery means retaining the archive and explicitly rebuilding a new cache
/// with a reader that understands it; this API never silently resets a block.
pub struct WideIndex {
    conn: Connection,
    program: Address,
    world: WorldId,
    resident_ctx: Option<AddrCtx>,
}

impl WideIndex {
    pub fn open(path: &Path, program: Address, world: WorldId) -> Result<Self, String> {
        Self::open_scoped(path, program, world, None)
    }
    pub fn open_with_resident(
        path: &Path,
        program: Address,
        world: WorldId,
        ctx: AddrCtx,
    ) -> Result<Self, String> {
        if ctx.program != program.to_bytes()
            || WorldId::derive_legacy_season(&ctx.season, &ctx.program)
                .map_err(|e| format!("{e:?}"))?
                != world
        {
            return Err("resident scope mismatch".into());
        }
        Self::open_scoped(path, program, world, Some(ctx))
    }
    fn open_scoped(
        path: &Path,
        program: Address,
        world: WorldId,
        resident_ctx: Option<AddrCtx>,
    ) -> Result<Self, String> {
        let conn = sql(Connection::open(path))?;
        sql(conn.execute_batch(
            "PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS wide_meta (
            id INTEGER PRIMARY KEY CHECK(id=1), schema INTEGER NOT NULL,
            program BLOB NOT NULL, world BLOB NOT NULL,
            last_seq INTEGER NOT NULL, caught_up INTEGER NOT NULL, block TEXT, snapshot BLOB NOT NULL, resident_season BLOB);
          CREATE TABLE IF NOT EXISTS wide_tx (
            seq INTEGER PRIMARY KEY, slot BLOB NOT NULL, signature BLOB UNIQUE NOT NULL,
            rolled_back INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS wide_event (
            ev INTEGER PRIMARY KEY, archive_seq INTEGER NOT NULL REFERENCES wide_tx(seq),
            ordinal INTEGER NOT NULL, format TEXT NOT NULL, body BLOB NOT NULL,
            province BLOB, holding BLOB, host BLOB, UNIQUE(archive_seq,ordinal));
          CREATE TABLE IF NOT EXISTS wide_chain (
            entity INTEGER NOT NULL, full_key BLOB NOT NULL,
            seq BLOB NOT NULL, head BLOB NOT NULL, terminal INTEGER NOT NULL,
            PRIMARY KEY(entity,full_key));
          CREATE TABLE IF NOT EXISTS wide_link (
            archive_seq INTEGER NOT NULL, ordinal INTEGER NOT NULL,
            entity INTEGER NOT NULL, full_key BLOB NOT NULL,
            seq BLOB NOT NULL, head BLOB NOT NULL,
            PRIMARY KEY(archive_seq,ordinal,entity),
            FOREIGN KEY(archive_seq,ordinal) REFERENCES wide_event(archive_seq,ordinal));",
        ))?;
        let meta: Option<(i64, Vec<u8>, Vec<u8>, Option<Vec<u8>>)> = sql(conn
            .query_row(
                "SELECT schema,program,world,resident_season FROM wide_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional())?;
        match meta {
            Some((schema, p, w, season))
                if schema == SCHEMA
                    && p == program.to_bytes()
                    && w == world.as_bytes()
                    && season == resident_ctx.map(|c| c.season.to_vec()) => {}
            Some(_) => return Err("wide index schema/program/world mismatch".into()),
            None => {
                let rows: i64 = sql(conn.query_row("SELECT (SELECT COUNT(*) FROM wide_tx)+(SELECT COUNT(*) FROM wide_event)+(SELECT COUNT(*) FROM wide_chain)+(SELECT COUNT(*) FROM wide_link)", [], |r|r.get(0)))?;
                if rows != 0 {
                    return Err("missing wide index identity".into());
                }
                sql(conn.execute(
                    "INSERT INTO wide_meta VALUES(1,?1,?2,?3,0,0,NULL,zeroblob(32),?4)",
                    params![
                        SCHEMA,
                        program.to_bytes().as_slice(),
                        world.as_bytes().as_slice(),
                        resident_ctx.map(|c| c.season.to_vec())
                    ],
                ))?;
            }
        }
        Ok(Self {
            conn,
            program,
            world,
            resident_ctx,
        })
    }
    pub fn status(&self) -> Result<IndexStatus, String> {
        let (seq, caught_up, block, snapshot): (i64, i64, Option<String>, Vec<u8>) =
            sql(self.conn.query_row(
                "SELECT last_seq,caught_up,block,snapshot FROM wide_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ))?;
        if seq < 0 || !(0..=1).contains(&caught_up) {
            return Err("invalid wide index metadata".into());
        }
        Ok(IndexStatus {
            last_seq: seq as u64,
            snapshot: snapshot.try_into().map_err(|_| "invalid wide snapshot")?,
            caught_up: caught_up == 1,
            blocked: block,
            source_coverage: "unknown",
            capture_verification: "unverified",
        })
    }
    fn available(&self) -> Result<IndexStatus, String> {
        let s = self.status()?;
        if let Some(b) = &s.blocked {
            return Err(format!("wide index blocked: {b}"));
        }
        Ok(s)
    }
    fn readable(&self) -> Result<IndexStatus, String> {
        let s = self.available()?;
        if !s.caught_up {
            return Err("wide index has not caught up to its local archive".into());
        }
        Ok(s)
    }
    pub fn mark_incomplete(&self) -> Result<(), String> {
        sql(self
            .conn
            .execute("UPDATE wide_meta SET caught_up=0 WHERE id=1", []))?;
        Ok(())
    }
    /// Local archive end only. Never labels the source or a capture verified.
    pub fn mark_caught_up(&self, archive_end: u64) -> Result<(), String> {
        if self.available()?.last_seq != archive_end {
            return Err("wide index/archive cursor mismatch".into());
        }
        sql(self
            .conn
            .execute("UPDATE wide_meta SET caught_up=1 WHERE id=1", []))?;
        Ok(())
    }
    /// Whole batch is atomic. A malformed record, gap, replay, wrong world,
    /// chain mismatch or store error latches a durable block after rollback.
    pub fn add(&mut self, records: &[TxRecord]) -> Result<(), String> {
        self.available()?;
        if records.is_empty() {
            return Ok(());
        }
        self.mark_incomplete()?;
        sql(self.conn.execute_batch("BEGIN IMMEDIATE"))?;
        let result = records.iter().try_for_each(|r| self.index_one(r));
        match result {
            Ok(()) => {
                if let Err(e) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    self.latch(&e.to_string())?;
                    return Err(e.to_string());
                }
                Ok(())
            }
            Err(e) => {
                // Failure to roll back or persist a block is also an error.
                sql(self.conn.execute_batch("ROLLBACK"))?;
                self.latch(&e)?;
                Err(e)
            }
        }
    }
    fn latch(&self, reason: &str) -> Result<(), String> {
        sql(self.conn.execute(
            "UPDATE wide_meta SET caught_up=0,block=COALESCE(block,?1) WHERE id=1",
            [reason],
        ))?;
        Ok(())
    }
    fn index_one(&self, tx: &TxRecord) -> Result<(), String> {
        let expected = self
            .status()?
            .last_seq
            .checked_add(1)
            .ok_or("archive sequence overflow")?;
        if tx.seq != expected {
            return Err(format!(
                "archive sequence gap/replay: wanted {expected}, got {}",
                tx.seq
            ));
        }
        let previous_slot: Option<Vec<u8>> = sql(self
            .conn
            .query_row(
                "SELECT slot FROM wide_tx ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(s) = previous_slot {
            if tx.slot < u64_blob(s)? {
                return Err("archive slot regression; rollback/reorg not accepted".into());
            }
        }
        let decoded = match &self.resident_ctx {
            Some(ctx) => decode_transaction_with_resident(tx, &self.program, ctx),
            None => decode_transaction(tx, &self.program),
        }
        .map_err(|e| format!("transaction {}: {e:?}", tx.seq))?;
        let rolled_back = matches!(decoded, TransactionRecords::RolledBack);
        sql(self.conn.execute(
            "INSERT INTO wide_tx(seq,slot,signature,rolled_back) VALUES(?1,?2,?3,?4)",
            params![
                seq_i64(tx.seq)?,
                tx.slot.to_be_bytes().as_slice(),
                tx.signature.as_ref(),
                rolled_back
            ],
        ))?;
        if let TransactionRecords::Committed(records) = decoded {
            for (ordinal, record) in records.iter().enumerate() {
                if let Some(sidecar) = record
                    .sidecar()
                    .map_err(|e| format!("sidecar decode: {e:?}"))?
                {
                    let world =
                        WorldId::derive_legacy_season(&sidecar.season, &self.program.to_bytes())
                            .map_err(|e| format!("sidecar world: {e:?}"))?;
                    if world != self.world {
                        return Err("sidecar belongs to another world".into());
                    }
                }
                let ordinal = i64::try_from(ordinal).map_err(|_| "too many records")?;
                let resident = self
                    .resident_ctx
                    .as_ref()
                    .map(|ctx| record.resident(ctx))
                    .transpose()
                    .map_err(|e| format!("resident decode: {e:?}"))?
                    .flatten();
                let wide = if resident.is_some() {
                    None
                } else {
                    record.wide().map_err(|e| format!("wide decode: {e:?}"))?
                };
                let (province, holding, host) = if let Some(w) = &wide {
                    let p = w.province_of().ok_or("wide province missing")?;
                    if p.world() != self.world {
                        return Err("wide record belongs to another world".into());
                    }
                    (
                        Some(p.to_bytes().to_vec()),
                        w.holding_of().map(|h| h.to_bytes().to_vec()),
                        w.host().map(|h| h.to_bytes().to_vec()),
                    )
                } else if let Some(r) = &resident {
                    if r.identity.standing.world() != self.world {
                        return Err("resident world mismatch".into());
                    }
                    (
                        Some(r.identity.standing.to_bytes().to_vec()),
                        None,
                        Some(r.identity.host.to_bytes().to_vec()),
                    )
                } else {
                    (None, None, None)
                };
                sql(self.conn.execute("INSERT INTO wide_event(archive_seq,ordinal,format,body,province,holding,host) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![seq_i64(tx.seq)?,ordinal,record.format(),record.body(),province,holding,host]))?;
                if let Some(r) = resident {
                    if let Some(link) = r.wide_link {
                        let full_key = r.identity.standing.to_bytes().to_vec();
                        let old = self.chain_raw(WideEntity::Province, &full_key)?.unwrap_or(
                            ChainState {
                                seq: 0,
                                head: [0; 32],
                                terminal: false,
                            },
                        );
                        if old.terminal {
                            return Err("resident chain continues after ProvinceClosed".into());
                        }
                        r.verify_previous(
                            self.resident_ctx.as_ref().ok_or("resident scope missing")?,
                            &[],
                            Some(event::WideLink {
                                entity: WideEntity::Province,
                                seq: old.seq,
                                head: old.head,
                            }),
                        )
                        .map_err(|e| format!("resident chain mismatch: {e:?}"))?;
                        sql(self.conn.execute("INSERT INTO wide_chain(entity,full_key,seq,head,terminal) VALUES(?1,?2,?3,?4,0) ON CONFLICT(entity,full_key) DO UPDATE SET seq=excluded.seq,head=excluded.head",params![link.entity as u8,full_key,link.seq.to_be_bytes().as_slice(),link.head.as_slice()]))?;
                        sql(self.conn.execute(
                            "INSERT INTO wide_link VALUES(?1,?2,?3,?4,?5,?6)",
                            params![
                                seq_i64(tx.seq)?,
                                ordinal,
                                link.entity as u8,
                                full_key,
                                link.seq.to_be_bytes().as_slice(),
                                link.head.as_slice()
                            ],
                        ))?;
                    }
                }
                if let Some(w) = wide {
                    for link in w.links.iter().flatten() {
                        let full_key = match link.entity {
                            WideEntity::Province => w
                                .province_of()
                                .ok_or("province link has no identity")?
                                .to_bytes()
                                .to_vec(),
                            WideEntity::Holding => w
                                .holding_of()
                                .ok_or("holding link has no identity")?
                                .to_bytes()
                                .to_vec(),
                        };
                        let old = self
                            .chain_raw(link.entity, &full_key)?
                            .unwrap_or(ChainState {
                                seq: 0,
                                head: [0; 32],
                                terminal: false,
                            });
                        if old.terminal {
                            return Err("wide chain continues after ProvinceClosed".into());
                        }
                        let expected =
                            event::advance(link.entity, old.seq, &old.head, w.body_without_tail)
                                .ok_or("wide chain overflow")?;
                        if expected != *link {
                            return Err(format!(
                                "wide {:?} chain sequence/head mismatch at transaction {}",
                                link.entity, tx.seq
                            ));
                        }
                        let terminal = w.kind == WideKind::ProvinceClosed
                            && link.entity == WideEntity::Province;
                        sql(self.conn.execute("INSERT INTO wide_chain(entity,full_key,seq,head,terminal) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entity,full_key) DO UPDATE SET seq=excluded.seq,head=excluded.head,terminal=excluded.terminal",params![link.entity as u8,full_key,link.seq.to_be_bytes().as_slice(),link.head.as_slice(),terminal]))?;
                        sql(self.conn.execute(
                            "INSERT INTO wide_link VALUES(?1,?2,?3,?4,?5,?6)",
                            params![
                                seq_i64(tx.seq)?,
                                ordinal,
                                link.entity as u8,
                                full_key,
                                link.seq.to_be_bytes().as_slice(),
                                link.head.as_slice()
                            ],
                        ))?;
                    }
                }
            }
        }
        let mut digest = Sha256::new();
        digest.update(b"PSF-WIDE-OBSERVED-ARCHIVE-v1");
        digest.update(self.status()?.snapshot);
        digest.update(
            serde_json::to_vec(&crate::archive::record_to_json(tx)).map_err(|e| e.to_string())?,
        );
        let stamp: [u8; 32] = digest.finalize().into();
        sql(self.conn.execute(
            "UPDATE wide_meta SET last_seq=?1,snapshot=?2 WHERE id=1",
            params![seq_i64(tx.seq)?, stamp.as_slice()],
        ))?;
        Ok(())
    }
    fn chain_raw(&self, entity: WideEntity, key: &[u8]) -> Result<Option<ChainState>, String> {
        let row: Option<(Vec<u8>, Vec<u8>, i64)> = sql(self
            .conn
            .query_row(
                "SELECT seq,head,terminal FROM wide_chain WHERE entity=?1 AND full_key=?2",
                params![entity as u8, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional())?;
        row.map(|(seq, head, terminal)| {
            if !(0..=1).contains(&terminal) {
                return Err("invalid terminal marker".into());
            }
            Ok(ChainState {
                seq: u64_blob(seq)?,
                head: head.try_into().map_err(|_| "invalid stored chain head")?,
                terminal: terminal == 1,
            })
        })
        .transpose()
    }
    /// Unknown means no observed chained record, never proof of absence.
    pub fn chain(&self, target: WideTarget) -> Result<Option<ChainState>, String> {
        self.readable()?;
        let key = match target {
            WideTarget::Province(p) if p.world() == self.world => p.to_bytes().to_vec(),
            WideTarget::Holding(h) if h.key().world() == self.world => {
                h.holding_ref().to_bytes().to_vec()
            }
            _ => return Err("query belongs to another world".into()),
        };
        self.chain_raw(target.entity(), &key)
    }
    pub fn events(&self, after: u64, limit: usize) -> Result<EventPage, String> {
        let status = self.readable()?;
        if !(1..=MAX_PAGE).contains(&limit) {
            return Err("wide event page limit outside 1..=256".into());
        }
        let mut stmt=sql(self.conn.prepare("SELECT ev,archive_seq,ordinal,format,body,province,holding,host FROM wide_event WHERE ev>?1 ORDER BY ev LIMIT ?2"))?;
        let rows = sql(
            stmt.query_map(params![seq_i64(after)?, (limit + 1) as i64], |r| {
                Ok(ObservedEvent {
                    event: r.get::<_, i64>(0)? as u64,
                    archive_seq: r.get::<_, i64>(1)? as u64,
                    ordinal: r.get::<_, i64>(2)? as u64,
                    format: r.get(3)?,
                    body: r.get(4)?,
                    province: r.get(5)?,
                    holding: r.get(6)?,
                    host: r.get(7)?,
                })
            }),
        )?;
        let mut events = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let more = events.len() > limit;
        events.truncate(limit);
        let next = events.last().map_or(after, |e| e.event);
        Ok(EventPage {
            events,
            next,
            more,
            indexed_through: status.last_seq,
            snapshot: status.snapshot,
            source_coverage: "unknown",
        })
    }
}

/// HTTP/UI consumers open the existing dedicated cache read-only. This never
/// creates a database, repairs metadata, clears a block or advances a cursor.
/// Each event page pins status and rows in one SQLite read transaction.
pub struct WideReader {
    index: WideIndex,
}
impl WideReader {
    pub fn open(path: &Path, program: Address, world: WorldId) -> Result<Self, String> {
        let conn = sql(Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ))?;
        let (schema, p, w): (i64, Vec<u8>, Vec<u8>) = sql(conn.query_row(
            "SELECT schema,program,world FROM wide_meta WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        if schema != SCHEMA || p != program.to_bytes() || w != world.as_bytes() {
            return Err("wide index schema/program/world mismatch".into());
        }
        Ok(Self {
            index: WideIndex {
                conn,
                program,
                world,
                resident_ctx: None,
            },
        })
    }
    pub fn status(&self) -> Result<IndexStatus, String> {
        self.index.status()
    }
    pub fn events(
        &self,
        after: u64,
        limit: usize,
        through: u64,
        snapshot: [u8; 32],
    ) -> Result<EventPage, String> {
        sql(self.index.conn.execute_batch("BEGIN"))?;
        let result = (|| {
            let page = self.index.events(after, limit)?;
            if page.indexed_through != through || page.snapshot != snapshot {
                return Err("WideIndexChanged".into());
            }
            let max: i64 = sql(self.index.conn.query_row(
                "SELECT COALESCE(MAX(ev),0) FROM wide_event",
                [],
                |r| r.get(0),
            ))?;
            if after > max as u64 {
                return Err("BadWideCursor".into());
            }
            Ok(page)
        })();
        match result {
            Ok(page) => {
                sql(self.index.conn.execute_batch("COMMIT"))?;
                Ok(page)
            }
            Err(e) => {
                sql(self.index.conn.execute_batch("ROLLBACK"))?;
                Err(e)
            }
        }
    }
}
