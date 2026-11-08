//! A store opened while another process holds a lock on the same new file
//! (workstream 04, 2026-11-08; workstream 03 reproduced the cold start: two
//! `runexec act register` on one new database, "database is locked" in 6 of
//! 80). SQLite answers `PRAGMA journal_mode=WAL` SQLITE_BUSY at once, without
//! the busy handler, while a lock is held on a file not yet in WAL mode.
//! Here a second connection holds a write lock on a fresh file for 300 ms:
//! `Store::open` must wait for it, as every other statement waits, and open.
//!
//! Keyless: SQLite files in a temporary directory only; no key, no signer.
use std::time::{Duration, Instant};

use runexec::store::Store;
use rusqlite::Connection;

fn fresh(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ws04-cold-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("runs.db")
}

/// The cold start: another connection created the file and holds its write
/// lock (rollback mode, as a brand-new file is) for 300 ms.
#[test]
fn a_store_opened_while_another_holds_the_new_files_lock_waits_and_opens() {
    let path = fresh("held");
    let other = Connection::open(&path).unwrap();
    other
        .execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS t(x);")
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        other.execute_batch("COMMIT;").unwrap();
        other
    });
    let t0 = Instant::now();
    let opened = Store::open(&path);
    let waited = t0.elapsed();
    drop(release.join().unwrap());
    assert!(opened.is_ok(), "{:?}", opened.err());
    assert!(
        waited >= Duration::from_millis(250),
        "it waited for the lock ({waited:?})"
    );
    let mode: String = Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

/// A lock held past the busy budget is still an error, as before (it is not
/// retried forever).
#[test]
fn a_store_whose_lock_is_never_released_still_fails() {
    let path = fresh("stuck");
    let other = Connection::open(&path).unwrap();
    other
        .execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS t(x);")
        .unwrap();
    // (the budget is 10 s: kept short here by holding the lock across it)
    let t0 = Instant::now();
    let opened = Store::open(&path);
    assert!(opened.is_err());
    assert!(
        t0.elapsed() >= Duration::from_secs(9),
        "it waited the budget"
    );
    drop(other);
}
