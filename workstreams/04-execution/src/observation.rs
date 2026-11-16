//! Read-only, UNPROVEN observations of S1 settlement/raid rows in a findex DB.
//! This does NOT implement Chain, produce executor receipts, admit finality,
//! or write any DB. A findex row does not bind its world or prove its source.
//! All decoded rows remain held. See docs/READ-OBSERVATION-20261116.md.
//!
//! (2026-11-17, integration branch claude/ws04-store-dir-observation-20261117) [`read_store_observations`] reads the
//! same page from a findex STORE DIRECTORY (`index.sqlite` + `archive/manifest.json`, findex lib.rs `Findex`) and adds,
//! as diagnostics only, what the archive manifest's `observed` epochs (findex archive.rs, a99b961f) say of each row's
//! producer. It never opens the store as findex does (no `Findex::open`, no `Archive::open`: those write and recover)
//! and makes no write or recovery of its own; SQLite itself may still create the index's WAL side files (`-shm`), so
//! "no file changes" is NOT guaranteed. It lifts no hold: the two files are read separately (not one snapshot), a directory is not proof
//! that they belong together, and an epoch is a producer's kind and settings, not evidence of world, finality,
//! identity or authenticity. See docs/STORE-DIR-OBSERVATION-20261117.md.
use std::io::Read;
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
    /// Only from [`read_store_observations`]: the archive epoch that covers `archive_sequence`, or why none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_epoch: Option<EpochView>,
}

/// One `observed` epoch of a findex archive manifest, as written there (findex archive.rs `ObservedSource`): the
/// producer's kind and settings. `program_configured` is the program it was given, `commitment_requested` what it
/// asked for. Neither is checked here, and no endpoint is named.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ArchiveEpoch {
    pub from_seq: u64,
    pub source: String,
    pub program_configured: Option<String>,
    pub commitment_requested: Option<String>,
}

/// The epoch for one row, or `epoch: null` with why: `before_first_epoch`, `past_manifest_end` (the index is ahead of
/// the durable manifest), `manifest_changed_during_read`.
#[derive(Debug, Serialize)]
pub struct EpochView {
    pub epoch: Option<ArchiveEpoch>,
    pub why: &'static str,
    /// Always `same_directory_not_proof_of_same_archive`: the row and the epoch were read from one directory, which
    /// does not prove that this index row was built from this archive.
    pub pairing: &'static str,
}

/// What [`read_store_observations`] knows of the pairing of the two files. Not proof that they belong together.
#[derive(Debug, Serialize)]
pub struct StorePairing {
    /// Both were opened under the one directory the caller named (`index.sqlite`, `archive/manifest.json`).
    pub same_directory: bool,
    /// `MAX(tx.seq)` inside the page's own read transaction (0: empty).
    pub index_last_seq: u64,
    /// The manifest's `next_seq`, read before and after the index.
    pub manifest_next_seq_before: u64,
    pub manifest_next_seq_after: u64,
    /// The two manifest reads were byte-for-byte equal.
    pub manifest_stable: bool,
    /// `index_matches_manifest`, `index_ahead_of_manifest`, `index_behind_manifest`, `manifest_changed_during_read`.
    pub generation: &'static str,
    pub limits: Vec<&'static str>,
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
    /// Only from [`read_store_observations`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store: Option<StorePairing>,
}

/// A bounded page in ONE read transaction. Refuses unknown/blocked/typed indexes.
/// `after` is only an in-index locator: callers must NOT persist it as a safe
/// cross-rebuild resume cursor. This first slice has no admitted restart cursor.
/// No schema creation/migration, network, key, RPC, executor or send path.
pub fn read_observations(path: &Path, after: u64, limit: usize) -> Result<ObservationPage, String> {
    read_observations_with_last(path, after, limit, false).map(|(page, _)| page)
}

/// [`read_observations`]; with `want_last`, also `MAX(tx.seq)` in the same read transaction (the store reader only:
/// the plain reader runs no extra query and gains no new way to fail).
fn read_observations_with_last(path: &Path, after: u64, limit: usize, want_last: bool) -> Result<(ObservationPage, u64), String> {
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
            archive_epoch: None,
        });
        previous = cursor;
    }
    let last = if want_last {
        let last: i64 = db.query_row("SELECT COALESCE(MAX(seq), 0) FROM tx", [], |r| r.get(0))
            .map_err(|_| "observation index last sequence unreadable".to_string())?;
        u64::try_from(last).map_err(|_| "negative observation integer".to_string())?
    } else {
        0
    };
    Ok((ObservationPage { format: "ws04-observation/0", basis: "unproven", world: None,
        finality: None, complete: None, observations, next_local_cursor: previous,
        held: vec!["not_executor_receipts", "source_provenance_unproven", "resume_cursor_not_admitted"], store: None }, last))
}

/// The store directory's file names (findex lib.rs: `archive/`, `index.sqlite`).
pub const STORE_INDEX: &str = "index.sqlite";
pub const STORE_MANIFEST: &str = "archive/manifest.json";
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

struct ManifestRead {
    raw: Vec<u8>,
    next_seq: u64,
    epochs: Vec<ArchiveEpoch>,
}

/// The archive manifest, read as a plain file (no recovery, no write), with findex's own rules for `observed`
/// (a99b961f `Manifest::from_json`): version 1; epochs strictly increasing, each `1 <= from_seq < next_seq`; a
/// malformed list refuses the whole read. Other keys (`genesis_hash`, `endpoint`, …) are not read.
fn read_manifest(store: &Path) -> Result<ManifestRead, String> {
    let f = std::fs::File::open(store.join(STORE_MANIFEST)).map_err(|_| "observation manifest unavailable".to_string())?;
    let mut raw = Vec::new();
    f.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut raw).map_err(|_| "observation manifest unreadable".to_string())?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("observation manifest too large".into());
    }
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "observation manifest is not JSON".to_string())?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return Err("observation manifest version not supported".into());
    }
    let next_seq = v.get("next_seq").and_then(|x| x.as_u64()).filter(|n| *n >= 1).ok_or("observation manifest next_seq")?;
    // What findex's own Manifest::from_json requires, so a manifest findex refuses is refused here too.
    v.get("segment_bytes").and_then(|x| x.as_u64()).ok_or("observation manifest segment_bytes")?;
    for seg in v.get("segments").and_then(|x| x.as_array()).ok_or("observation manifest segments")? {
        seg.get("name").and_then(|x| x.as_str()).ok_or("observation manifest segment name")?;
        for k in ["first_seq", "last_seq", "records", "bytes"] {
            seg.get(k).and_then(|x| x.as_u64()).ok_or("observation manifest segment field")?;
        }
    }
    match v.get("codec") {
        None | Some(serde_json::Value::String(_)) => {}
        Some(_) => return Err("observation manifest codec".into()),
    }
    let opt = |e: &serde_json::Value, k: &str| -> Result<Option<String>, String> {
        match e.get(k) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("observation manifest observed {k}")),
        }
    };
    let mut epochs = Vec::new();
    match v.get("observed") {
        None => {}
        Some(serde_json::Value::Array(a)) => {
            let mut prev = 0u64;
            for e in a {
                let from_seq = e.get("from_seq").and_then(|x| x.as_u64()).ok_or("observation manifest observed from_seq")?;
                if from_seq <= prev || from_seq >= next_seq {
                    return Err("observation manifest observed out of order or range".into());
                }
                prev = from_seq;
                epochs.push(ArchiveEpoch {
                    from_seq,
                    source: e.get("source").and_then(|x| x.as_str()).ok_or("observation manifest observed source")?.into(),
                    program_configured: opt(e, "program_configured")?,
                    commitment_requested: opt(e, "commitment_requested")?,
                });
            }
        }
        Some(_) => return Err("observation manifest observed".into()),
    }
    Ok(ManifestRead { raw, next_seq, epochs })
}

const PAIRING: &str = "same_directory_not_proof_of_same_archive";

/// The directory and `archive/` must be directories, `index.sqlite` and the manifest regular files, none a symbolic
/// link (not followed: `symlink_metadata`). A FIFO, a device or a socket there could block an open with no end, so
/// they are refused before anything is opened. Checked before each open; a path swapped in between is a stated limit.
fn check_store_paths(store: &Path) -> Result<(), String> {
    for (p, dir) in [(store.to_path_buf(), true), (store.join("archive"), true), (store.join(STORE_INDEX), false), (store.join(STORE_MANIFEST), false)] {
        let m = std::fs::symlink_metadata(&p).map_err(|_| "observation store path unavailable".to_string())?;
        let t = m.file_type();
        if t.is_symlink() {
            return Err("observation store path is a symbolic link: refused".into());
        }
        if (dir && !t.is_dir()) || (!dir && !t.is_file()) {
            return Err("observation store path is not a directory or regular file as expected: refused".into());
        }
    }
    Ok(())
}

/// [`read_observations`] over a findex store directory, with each row's archive epoch as a diagnostic.
/// Order: the manifest, then the index page (one read transaction), then the manifest again. The epochs are used
/// only when the two manifest reads are equal; a row at or past the manifest's `next_seq` gets `epoch: null`.
/// Refused: a symbolic link at the directory, `index.sqlite`, `archive/` or the manifest (checked before opening;
/// a link swapped in between is a limit, stated in `limits`). Every hold is kept, and two are added to the page.
pub fn read_store_observations(store: &Path, after: u64, limit: usize) -> Result<ObservationPage, String> {
    check_store_paths(store)?;
    let before = read_manifest(store)?;
    let (mut page, index_last_seq) = read_observations_with_last(&store.join(STORE_INDEX), after, limit, true)?;
    check_store_paths(store)?;
    let after_read = read_manifest(store)?;
    let stable = before.raw == after_read.raw;
    let generation = if !stable {
        "manifest_changed_during_read"
    } else if index_last_seq >= before.next_seq {
        "index_ahead_of_manifest"
    } else if index_last_seq + 1 < before.next_seq {
        "index_behind_manifest"
    } else {
        "index_matches_manifest"
    };
    for o in page.observations.iter_mut() {
        let seq = o.archive_sequence;
        o.archive_epoch = Some(if !stable {
            EpochView { epoch: None, why: "manifest_changed_during_read", pairing: PAIRING }
        } else if seq >= before.next_seq {
            EpochView { epoch: None, why: "past_manifest_end", pairing: PAIRING }
        } else {
            match before.epochs.iter().rev().find(|e| e.from_seq <= seq) {
                Some(e) => EpochView { epoch: Some(e.clone()), why: "covered_by_epoch", pairing: PAIRING },
                None => EpochView { epoch: None, why: "before_first_epoch", pairing: PAIRING },
            }
        });
    }
    page.held.push("store_pairing_is_not_a_snapshot_or_proof");
    page.held.push("archive_epoch_is_producer_setting_not_evidence");
    page.store = Some(StorePairing {
        same_directory: true,
        index_last_seq,
        manifest_next_seq_before: before.next_seq,
        manifest_next_seq_after: after_read.next_seq,
        manifest_stable: stable,
        generation,
        limits: vec![
            "two files read one after the other: not one snapshot",
            "one directory named by the caller: not proof the index was built from this archive",
            "symbolic links and non-regular files refused only at the time of each check, and only as the last part of each path",
            "no application write or recovery; SQLite may still create the index's WAL side files (-shm): no file change is not guaranteed",
            "an epoch names no endpoint and proves no finality, world or authenticity",
        ],
    });
    Ok(page)
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
