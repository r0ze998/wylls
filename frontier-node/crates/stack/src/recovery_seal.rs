//! A one-use, clean-down inventory of the local run's persisted state.
//!
//! The caller must stop every writer, confirm that all of them exited, and
//! save the final `state.json` before calling `seal_clean_down`.
//! A seal catches a missing or substituted *part* of that stopped file set.
//! It cannot detect a complete rollback of the files together with the seal,
//! nor a send that was lost before any durable record existed. In particular,
//! it is not permission to resume a continuous world or a fleet of bots.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::run::{self, RunDir};

const SEAL_FILE: &str = "recovery-seal.json";
const CONSUMED_FILE: &str = "recovery-seal.consumed";
const VERSION: u64 = 1;
const TREES: [&str; 7] = [
    "keys", "localnet", "keeper-a", "keeper-b", "relay", "herald", "bots",
];

pub fn has_seal(rd: &RunDir) -> bool {
    rd.path(SEAL_FILE).is_file()
}

fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn ordinary_file(path: &Path) -> Result<(), String> {
    let kind = fs::symlink_metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .file_type();
    if !kind.is_file() {
        return Err(format!(
            "{} is not a regular file; refusing recovery",
            path.display()
        ));
    }
    Ok(())
}

fn stamp(path: &Path, sync: bool) -> Result<Value, String> {
    ordinary_file(path)?;
    let mut f = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if sync {
        f.sync_all()
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let mut h = Sha256::new();
    let mut len = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        len = len
            .checked_add(n as u64)
            .ok_or("recovery file is too large")?;
    }
    Ok(json!({ "length": len, "sha256": hex::encode(h.finalize()) }))
}

fn visit(
    root: &Path,
    rel: &Path,
    sync: bool,
    files: &mut BTreeMap<String, Value>,
) -> Result<(), String> {
    let path = root.join(rel);
    let kind = fs::symlink_metadata(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .file_type();
    if kind.is_file() {
        let name = rel
            .to_str()
            .ok_or("non-UTF8 recovery file name")?
            .replace('\\', "/");
        files.insert(name, stamp(&path, sync)?);
    } else if kind.is_dir() {
        let children = fs::read_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        for child in children {
            let child = child.map_err(|e| e.to_string())?;
            visit(root, &rel.join(child.file_name()), sync, files)?;
        }
        if sync {
            sync_dir(&path)?;
        }
    } else {
        return Err(format!(
            "{} is not a regular recovery file; refusing recovery",
            path.display()
        ));
    }
    Ok(())
}

fn inventory(rd: &RunDir, sync: bool) -> Result<BTreeMap<String, Value>, String> {
    for required in [
        "state.json",
        "localnet/ledger.wal",
        "keeper-a/keeper.journal.sqlite",
        "relay/relay-state.json",
    ] {
        ordinary_file(&rd.path(required))?;
    }
    let mut files = BTreeMap::new();
    visit(&rd.root, Path::new("state.json"), sync, &mut files)?;
    for name in ["program.so", "prize.so"] {
        if rd.path(name).exists() {
            visit(&rd.root, Path::new(name), sync, &mut files)?;
        }
    }
    for tree in TREES {
        if rd.path(tree).exists() {
            visit(&rd.root, Path::new(tree), sync, &mut files)?;
        }
    }
    Ok(files)
}

fn checkpoint(path: &Path) -> Result<(), String> {
    ordinary_file(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mode: String = db
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if mode != "wal" {
        return Err(format!(
            "{} is not a WAL journal; refusing seal",
            path.display()
        ));
    }
    let (busy, logged, copied): (i64, i64, i64) = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| format!("{} checkpoint: {e}", path.display()))?;
    if busy != 0 || logged != copied {
        return Err(format!(
            "{} checkpoint is incomplete; refusing seal",
            path.display()
        ));
    }
    let integrity: String = db
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(|e| format!("{} integrity: {e}", path.display()))?;
    if integrity != "ok" {
        return Err(format!("{} failed SQLite integrity check", path.display()));
    }
    drop(db);
    Ok(())
}

fn run_id(rd: &RunDir) -> Result<&str, String> {
    rd.root
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid run id".into())
}

/// Seal an already stopped and saved run. A caller must confirm that all
/// writers exited and propagate final state-save errors before invoking this.
/// The seal itself does not prove that every service exited gracefully.
pub fn seal_clean_down(rd: &RunDir, state: &Value) -> Result<(), String> {
    if state["phase"] != "down" || rd.load_state()? != *state {
        return Err("run is not at the saved clean-down state; refusing seal".into());
    }
    if rd.path(SEAL_FILE).exists() {
        return Err("an earlier clean-down seal exists; refusing to replace it".into());
    }
    if rd.path(CONSUMED_FILE).exists() {
        return Err("an incomplete prior seal consumption exists; refusing seal".into());
    }
    checkpoint(&rd.path("keeper-a/keeper.journal.sqlite"))?;
    if state["components"]["keeper-b"]["spec"].is_object() {
        checkpoint(&rd.path("keeper-b/keeper.journal.sqlite"))?;
    }
    let files = inventory(rd, true)?;
    sync_dir(&rd.root)?;
    let manifest = json!({ "version": VERSION, "run_id": run_id(rd)?, "files": files });
    let data = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let temp = rd.path(&format!(
        ".recovery-seal-{}-{}.tmp",
        std::process::id(),
        run::wall_ms()
    ));
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("{}: {e}", temp.display()))?;
        f.write_all(&data)
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("{}: {e}", temp.display()))?;
    }
    fs::rename(&temp, rd.path(SEAL_FILE)).map_err(|e| e.to_string())?;
    sync_dir(&rd.root)
}

/// Verify all sealed files, then consume the seal durably before any process
/// starts. A crash after this returns must not reuse the same clean stop.
pub fn verify_and_consume(rd: &RunDir, state: &Value) -> Result<(), String> {
    if state["phase"] != "down" || rd.load_state()? != *state {
        return Err("run is not at the saved clean-down state; refusing resume".into());
    }
    let path = rd.path(SEAL_FILE);
    ordinary_file(&path)?;
    let manifest: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|_| "invalid clean-down seal; refusing resume")?;
    if manifest["version"].as_u64() != Some(VERSION)
        || manifest["run_id"].as_str() != Some(run_id(rd)?)
        || manifest["files"] != json!(inventory(rd, false)?)
    {
        return Err("clean-down file set changed; refusing resume".into());
    }
    let consumed = rd.path(CONSUMED_FILE);
    if consumed.exists() {
        return Err("prior seal consumption is incomplete; refusing resume".into());
    }
    fs::rename(&path, &consumed).map_err(|e| format!("cannot consume seal: {e}"))?;
    sync_dir(&rd.root)?;
    fs::remove_file(&consumed).map_err(|e| format!("cannot remove consumed seal: {e}"))?;
    sync_dir(&rd.root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> (RunDir, Value) {
        let root = std::env::temp_dir().join(format!(
            "seal-{}-{}-{}",
            std::process::id(),
            run::wall_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("localnet")).unwrap();
        fs::create_dir_all(root.join("keeper-a")).unwrap();
        fs::create_dir_all(root.join("relay")).unwrap();
        fs::write(root.join("localnet/ledger.wal"), b"framed local ledger").unwrap();
        fs::write(
            root.join("relay/relay-state.json"),
            b"{\"quota\":{},\"invitesUsed\":{}}",
        )
        .unwrap();
        let db = Connection::open(root.join("keeper-a/keeper.journal.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE attempts(sig TEXT); INSERT INTO attempts VALUES ('sent');")
            .unwrap();
        drop(db);
        let rd = RunDir { root };
        let state =
            json!({"phase":"down", "components":{"keeper-a":{"spec":{}}, "relay":{"spec":{}}}});
        rd.save_state(&state).unwrap();
        (rd, state)
    }

    #[test]
    fn clean_down_seal_is_one_use_and_rejects_missing_or_changed_files() {
        let (rd, state) = fixture();
        assert!(
            verify_and_consume(&rd, &state).is_err(),
            "no seal cannot authorize resume"
        );
        seal_clean_down(&rd, &state).unwrap();
        assert!(
            seal_clean_down(&rd, &state).is_err(),
            "seal cannot be refreshed"
        );
        let state_path = rd.state_path();
        let original = fs::read(&state_path).unwrap();
        fs::write(&state_path, b"{\"phase\":\"older\"}").unwrap();
        assert!(verify_and_consume(&rd, &state).is_err());
        fs::write(&state_path, original).unwrap();
        let relay = rd.path("relay/relay-state.json");
        let original = fs::read(&relay).unwrap();
        fs::write(&relay, b"{\"quota\":{},\"invitesUsed\":{},\"old\":true}").unwrap();
        assert!(
            verify_and_consume(&rd, &state).is_err(),
            "older same-run relay state must fail against seal"
        );
        fs::write(&relay, original).unwrap();
        assert!(verify_and_consume(&rd, &state).is_ok());
        assert!(
            verify_and_consume(&rd, &state).is_err(),
            "consumed seal cannot be reused"
        );
        fs::remove_dir_all(rd.root).unwrap();
    }

    #[test]
    fn seal_checkpoints_keeper_and_rejects_a_lost_or_older_database() {
        let (rd, state) = fixture();
        seal_clean_down(&rd, &state).unwrap();
        let db_path = rd.path("keeper-a/keeper.journal.sqlite");
        let db = Connection::open(&db_path).unwrap();
        let sent: String = db
            .query_row("SELECT sig FROM attempts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            sent, "sent",
            "the recorded attempt remains readable after seal"
        );
        drop(db);
        let original = fs::read(&db_path).unwrap();
        fs::write(&db_path, b"older database").unwrap();
        assert!(verify_and_consume(&rd, &state).is_err());
        fs::write(&db_path, original).unwrap();
        let wal = PathBuf::from(format!("{}-wal", db_path.display()));
        fs::write(&wal, b"unexpected WAL").unwrap();
        assert!(
            verify_and_consume(&rd, &state).is_err(),
            "a changed WAL presence must fail"
        );
        fs::remove_file(&wal).unwrap();
        assert!(verify_and_consume(&rd, &state).is_ok());
        fs::remove_dir_all(rd.root).unwrap();
    }
}
