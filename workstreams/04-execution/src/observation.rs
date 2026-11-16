//! Read-only, UNPROVEN observations of S1 settlement/raid rows in a findex DB.
//! This does NOT implement Chain, produce executor receipts, admit finality,
//! or write any DB. A findex row does not bind its world or prove its source.
//! All decoded rows remain held. See docs/READ-OBSERVATION-20261116.md.
use std::path::Path;
use frontier_abi::v2::log::{self, AnyKind, CqKind};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use crate::model::{CaravanKey, PlaceRef, Res};
use crate::ports::{Raid, Settle};

pub const MAX_ROWS: usize = 256;
const MAX_BODY: usize = 4096;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ObservedEvent { CaravanSettled(Settle), CaravanRaided(Raid) }

#[derive(Debug, Serialize)]
pub struct Observation {
    pub event_cursor: u64,
    pub archive_sequence: u64,
    /// Ordinal in the extracted PS2 bodies, NOT instruction or log index.
    pub ps2_ordinal: u64,
    pub signature: String,
    pub transaction_slot: u64,
    pub body_sha256: String,
    /// A diagnostic local row locator. NEVER a chain event ID.
    pub local_locator: String,
    pub event: ObservedEvent,
    pub held: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct ObservationPage {
    pub format: &'static str,
    pub basis: &'static str,
    pub world: Option<String>,
    pub finality: Option<String>,
    pub complete: Option<bool>,
    pub observations: Vec<Observation>,
    /// Last selected row, not a claim that all kinds were processed.
    pub next_local_cursor: u64,
    pub held: Vec<&'static str>,
}

/// A bounded page in ONE read transaction. Refuses unknown/blocked/typed indexes.
/// `after` is only an in-index locator: callers must NOT persist it as a safe
/// cross-rebuild resume cursor. This first slice has no admitted restart cursor.
/// No schema creation/migration, network, key, RPC, executor or send path.
pub fn read_observations(path: &Path, after: u64, limit: usize) -> Result<ObservationPage, String> {
    if limit == 0 || limit > MAX_ROWS || after > i64::MAX as u64 {
        return Err("observation bounds".into());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "observation store unavailable".to_string())?;
    db.execute_batch("BEGIN").map_err(|_| "observation snapshot unavailable".to_string())?;
    // Dropping this read-only connection rolls back the read transaction.
    let marker = |key: &str| -> Result<Option<i64>, String> {
        db.query_row("SELECT v FROM meta WHERE k=?1", [key], |r| r.get(0)).optional()
            .map_err(|_| "observation metadata unreadable".to_string())
    };
    if marker("schema")? != Some(2) || marker("strict_ps2_v2_reject_psw1")? != Some(1)
        || marker("strict_ps2_blocked")? != Some(0) || marker("expedition_records_v1")?.is_some() {
        return Err("observation index schema/mode/coverage not supported".into());
    }
    let mut statement = db.prepare(
        "SELECT e.ev,e.seq,r.idx,t.slot,t.sig,r.kind,CASE WHEN length(r.body)<=4096 THEN r.body ELSE NULL END,t.err FROM event e
         JOIN record r ON r.seq=e.seq AND r.idx=e.idx JOIN tx t ON t.seq=e.seq
         WHERE e.ev>?1 AND r.kind IN (92,93) ORDER BY e.ev LIMIT ?2")
        .map_err(|_| "observation query unavailable".to_string())?;
    let mut rows = statement.query(rusqlite::params![after as i64, limit as i64])
        .map_err(|_| "observation query failed".to_string())?;
    let mut observations = Vec::new();
    let mut previous = after;
    while let Some(row) = rows.next().map_err(|_| "observation row unreadable".to_string())? {
        let n = |i| -> Result<u64, String> {
            let v: i64 = row.get(i).map_err(|_| "observation integer unreadable".to_string())?;
            u64::try_from(v).map_err(|_| "negative observation integer".to_string())
        };
        let cursor = n(0)?;
        let seq = n(1)?;
        let ordinal = n(2)?;
        let slot = n(3)?;
        let signature: String = row.get(4).map_err(|_| "observation signature unreadable".to_string())?;
        let kind = n(5)?;
        let body: Vec<u8> = row.get(6).map_err(|_| "observation body unreadable".to_string())?;
        let err: Option<String> = row.get(7).map_err(|_| "observation transaction status unreadable".to_string())?;
        if cursor <= previous || seq == 0 || signature.is_empty() || signature.len() > 128 || err.is_some() || body.len() > MAX_BODY {
            return Err("observation row inconsistent or outside bounds".into());
        }
        let event = decode_observation(&body, kind, slot)?;
        observations.push(Observation {
            event_cursor: cursor, archive_sequence: seq, ps2_ordinal: ordinal,
            signature, transaction_slot: slot,
            body_sha256: hex::encode(Sha256::digest(&body)),
            local_locator: format!("findex-row:{seq}:{ordinal}"), event,
            held: vec!["world_binding_unproven", "finality_unproven", "transaction_record_identity_unproven", "committed_frame_unproven"],
        });
        previous = cursor;
    }
    Ok(ObservationPage { format: "ws04-observation/0", basis: "unproven", world: None,
        finality: None, complete: None, observations, next_local_cursor: previous,
        held: vec!["not_executor_receipts", "source_provenance_unproven", "resume_cursor_not_admitted"] })
}

/// Reuse the actual ABI decoder and named fields, not hand-coded PS2 offsets.
/// The DB kind must agree with the body. Slot belongs to the transaction, never
/// a timestamp. No current inventory or credited amount is inferred.
pub fn decode_observation(body: &[u8], expected_kind: u64, slot: u64) -> Result<ObservedEvent, String> {
    if body.len() > MAX_BODY { return Err("observation body too large".into()); }
    let rec = log::decode(body).map_err(|_| "invalid PS2 observation".to_string())?;
    if u64::from(rec.kind.code()) != expected_kind { return Err("observation kind mismatch".into()); }
    let field = |name: &str, payload: bool| -> Result<&[u8], String> {
        let (offset, width) = log::field(rec.kind, name, payload).ok_or("observation field absent")?;
        (if payload { rec.payload } else { rec.key }).get(offset..offset+width).ok_or("observation field short".into())
    };
    let number = |name: &str, payload: bool, width: usize| -> Result<u64, String> {
        let b = field(name, payload)?;
        if b.len() != width || width > 8 { return Err("observation integer width".into()); }
        let mut v = [0u8; 8]; v[..width].copy_from_slice(b); Ok(u64::from_le_bytes(v))
    };
    let amounts = |name: &str| -> Result<Res, String> {
        let b = field(name, true)?;
        if b.len() != 32 { return Err("observation cargo width".into()); }
        Ok(core::array::from_fn(|i| u64::from(u32::from_le_bytes([b[i*4],b[i*4+1],b[i*4+2],b[i*4+3]]))))
    };
    let key = CaravanKey { owner: number("owner_tag", false, 8)?, seq: number("seq", false, 4)? as u32 };
    match rec.kind {
        AnyKind::Cq(CqKind::CARAVAN_SETTLED) => {
            let outcome = number("outcome", true, 1)? as u8;
            if outcome > log::caravan_outcome::LOST { return Err("unknown settlement outcome".into()); }
            let p = field("dst", true)?;
            if p.len() != log::log_place::LEN || !matches!(p[0], 1 | 2) { return Err("unsupported settlement place".into()); }
            let dst = PlaceRef { kind:p[0], p:i16::from_le_bytes([p[1],p[2]]), q:i16::from_le_bytes([p[3],p[4]]), at:p[5], gen:p[6] };
            Ok(ObservedEvent::CaravanSettled(Settle { key, outcome, dst, cargo: amounts("cargo")?, credited: None, slot }))
        }
        AnyKind::Cq(CqKind::CARAVAN_RAIDED) => {
            let choice = number("choice", true, 1)? as u8;
            if choice != log::raid_choice::TAKE && choice != log::raid_choice::BURN { return Err("unknown raid choice".into()); }
            Ok(ObservedEvent::CaravanRaided(Raid { key, choice, raider: number("raider_tag", true, 8)?, taken: amounts("taken")?, slot }))
        }
        _ => Err("unsupported observation kind".into()),
    }
}
