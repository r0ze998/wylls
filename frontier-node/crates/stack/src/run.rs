//! A run's directory and its state file.
//!
//! Everything of a run lives under `frontier-node/.local/frontier/<run-id>/`
//! (offchain design §11.4; git-ignored, W5-B request R2): `state.json`
//! (config, ports, program, keys' public halves, pids, phase, times),
//! `events.jsonl` (the supervisor's log: phases, chaos kills and restarts,
//! adversary holds, crashes), `logs/<component>.log`, and one directory per
//! component (`localnet/` WAL and snapshots, `herald/`, `keeper-a/`,
//! `keeper-b/`, `relay/`, `bots/`), then `verify/`, `tamper/`, `load/` and
//! `report.{json,md}`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The repository root: `PSF_REPO`, else the first ancestor of the working
/// directory, then of this executable, that holds `frontier-node/Cargo.toml`.
pub fn repo_root() -> Result<PathBuf, String> {
    if let Ok(r) = std::env::var("PSF_REPO") {
        if !r.is_empty() {
            return Ok(PathBuf::from(r));
        }
    }
    let mut starts = vec![];
    if let Ok(d) = std::env::current_dir() {
        starts.push(d);
    }
    if let Ok(e) = std::env::current_exe() {
        starts.push(e);
    }
    for s in starts {
        let mut d: Option<&Path> = Some(&s);
        while let Some(x) = d {
            if x.join("frontier-node/Cargo.toml").is_file() {
                return Ok(x.to_path_buf());
            }
            d = x.parent();
        }
    }
    Err("cannot find the repository root (set PSF_REPO)".into())
}

/// `p` if absolute, else `root/p`.
pub fn resolve(root: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

/// The directory of the stack's sibling binaries (`frontier-localnet`, …):
/// `FRONTIER_BIN`, else this executable's directory.
pub fn bin_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("FRONTIER_BIN") {
        if !d.is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    let e = std::env::current_exe().map_err(|e| e.to_string())?;
    e.parent()
        .map(Path::to_path_buf)
        .ok_or("no executable directory".into())
}

pub struct RunLock(std::fs::File);
impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[derive(Clone, Debug)]
pub struct RunDir {
    pub root: PathBuf,
}

impl RunDir {
    /// One supervisor per run, including its startup window. OS locks release
    /// after a crash; the lock file is outside the replaceable run directory.
    pub fn lock(&self) -> Result<RunLock, String> {
        let parent = self.root.parent().ok_or("run has no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let name = self
            .root
            .file_name()
            .ok_or("run has no name")?
            .to_string_lossy();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(parent.join(format!(".{name}.lock")))
            .map_err(|e| e.to_string())?;
        f.try_lock()
            .map_err(|e| format!("run already has a supervisor: {e}"))?;
        Ok(RunLock(f))
    }
    pub fn new(runs: &Path, run_id: &str) -> RunDir {
        RunDir {
            root: runs.join(run_id),
        }
    }
    /// The default runs directory.
    pub fn default_runs(repo: &Path) -> PathBuf {
        repo.join("frontier-node/.local/frontier")
    }
    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
    pub fn state_path(&self) -> PathBuf {
        self.path("state.json")
    }
    pub fn log(&self, component: &str) -> PathBuf {
        self.path(&format!("logs/{component}.log"))
    }
    pub fn has_persistent_world(&self) -> bool {
        self.path("localnet/ledger.wal").exists()
            || self.path("program.so").exists()
            || self
                .load_state()
                .is_ok_and(|s| s["config"]["conquest"] == true)
    }
    pub fn exists(&self) -> bool {
        self.state_path().is_file()
    }
    pub fn create(&self) -> Result<(), String> {
        for d in [
            "", "logs", "keys", "localnet", "herald", "keeper-a", "keeper-b", "relay", "bots",
            "metrics",
        ] {
            std::fs::create_dir_all(self.path(d))
                .map_err(|e| format!("{}: {e}", self.path(d).display()))?;
        }
        Ok(())
    }
    pub fn load_state(&self) -> Result<Value, String> {
        let p = self.state_path();
        let t = std::fs::read_to_string(&p)
            .map_err(|e| format!("{}: {e} (no such run?)", p.display()))?;
        serde_json::from_str(&t).map_err(|e| format!("{}: {e}", p.display()))
    }
    /// Writes `state.json` atomically.
    pub fn save_state(&self, v: &Value) -> Result<(), String> {
        write_atomic(
            &self.state_path(),
            serde_json::to_string_pretty(v)
                .unwrap_or_default()
                .as_bytes(),
        )
    }
    /// Appends one event (`{"t": wall ms, "game": unix, "event": ..}`).
    pub fn event(&self, game: Option<i64>, kind: &str, detail: Value) {
        let line = json!({"wall_ms": wall_ms(), "game": game, "event": kind, "detail": detail});
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path("events.jsonl"))
        {
            let _ = writeln!(f, "{line}");
        }
    }
    pub fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
}

pub fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("{}: {e}", p.display()))
}

/// A 32-byte secret in `p` (hex, mode 0600), created from the OS CSPRNG
/// the first time.
pub fn secret(p: &Path) -> Result<[u8; 32], String> {
    if let Ok(t) = std::fs::read_to_string(p) {
        let b = hex::decode(t.trim()).map_err(|_| format!("{}: not hex", p.display()))?;
        return b
            .try_into()
            .map_err(|_| format!("{}: not 32 bytes", p.display()));
    }
    let mut s = [0u8; 32];
    getrandom(&mut s)?;
    write_secret(p, &hex::encode(s))?;
    Ok(s)
}

/// A random token (hex) in `p` (mode 0600), created the first time.
pub fn token(p: &Path) -> Result<String, String> {
    if let Ok(t) = std::fs::read_to_string(p) {
        return Ok(t.trim().to_string());
    }
    let mut s = [0u8; 24];
    getrandom(&mut s)?;
    let t = hex::encode(s);
    write_secret(p, &t)?;
    Ok(t)
}

fn write_secret(p: &Path, text: &str) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    f.write_all(text.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| e.to_string())
}

/// OS randomness (`/dev/urandom`; no new crate).
pub fn getrandom(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|e| format!("/dev/urandom: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psf-stack-{name}-{}", wall_ms()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn state_events_and_secrets() {
        let d = tmp("run");
        let r = RunDir::new(&d, "t1");
        r.create().unwrap();
        r.save_state(&json!({"phase": "setup"})).unwrap();
        assert_eq!(r.load_state().unwrap()["phase"], "setup");
        r.event(Some(5), "phase", json!("running"));
        r.event(None, "kill", json!({"component": "herald"}));
        assert_eq!(r.events().len(), 2);
        let s = secret(&r.path("keys/a.seed")).unwrap();
        assert_eq!(secret(&r.path("keys/a.seed")).unwrap(), s, "stable");
        let t = token(&r.path("keys/t")).unwrap();
        assert_eq!(t.len(), 48);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(r.path("keys/a.seed"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(m & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// World-local service copies keep WAL replay stable after a later development build.
pub fn pin_native_binaries(rd: &RunDir, source: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let dest = rd.path("bin");
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut manifest = serde_json::Map::new();
    for name in [
        "frontier-localnet",
        "drand-replay",
        "frontier-keeper",
        "frontier-herald",
        "frontier-bots",
        "frontier-viewers",
    ] {
        let target = dest.join(name);
        std::fs::copy(source.join(name), &target).map_err(|e| format!("pin {name}: {e}"))?;
        let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
        manifest.insert(name.into(), json!(hex::encode(Sha256::digest(bytes))));
    }
    write_atomic(
        &rd.path("native-binaries.json"),
        &serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
    Ok(dest)
}

pub fn check_native_binary(rd: &RunDir, path: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(rd.path("native-binaries.json"))
            .map_err(|e| format!("native binary manifest: {e}"))?,
    )
    .map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid native binary name")?;
    let expected = manifest[name]
        .as_str()
        .ok_or("native binary is not pinned")?;
    let actual = hex::encode(Sha256::digest(
        std::fs::read(path).map_err(|e| e.to_string())?,
    ));
    if expected != actual {
        return Err(format!(
            "saved native binary {name} changed; refusing unsafe WAL replay"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    #[test]
    fn supervisor_lock_is_exclusive_and_released() {
        let root = std::env::temp_dir().join(format!(
            "frontier-lock-{}-{}",
            std::process::id(),
            wall_ms()
        ));
        let rd = RunDir::new(&root, "world");
        let first = rd.lock().unwrap();
        assert!(rd.lock().is_err());
        drop(first);
        assert!(rd.lock().is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_or_corrupt_metadata_never_makes_a_saved_ledger_disposable() {
        let root = std::env::temp_dir().join(format!(
            "frontier-preserve-{}-{}",
            std::process::id(),
            wall_ms()
        ));
        let rd = RunDir::new(&root, "world");
        rd.create().unwrap();
        std::fs::write(rd.path("localnet/ledger.wal"), b"saved world").unwrap();
        assert!(rd.has_persistent_world());
        std::fs::write(rd.state_path(), b"{corrupt").unwrap();
        assert!(rd.has_persistent_world());
        rd.save_state(&json!({"config":{"conquest":false}}))
            .unwrap();
        assert!(rd.has_persistent_world());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_binary_hash_detects_changes() {
        let root =
            std::env::temp_dir().join(format!("frontier-pin-{}-{}", std::process::id(), wall_ms()));
        std::fs::create_dir_all(root.join("source")).unwrap();
        for name in [
            "frontier-localnet",
            "drand-replay",
            "frontier-keeper",
            "frontier-herald",
            "frontier-bots",
            "frontier-viewers",
        ] {
            std::fs::write(root.join("source").join(name), b"original").unwrap();
        }
        let rd = RunDir::new(&root, "world");
        let bin = pin_native_binaries(&rd, &root.join("source")).unwrap();
        let path = bin.join("frontier-localnet");
        check_native_binary(&rd, &path).unwrap();
        std::fs::write(&path, b"changed").unwrap();
        assert!(check_native_binary(&rd, &path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
