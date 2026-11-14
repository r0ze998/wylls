//! The herald's output directory (contract §8.4 fold rules).
//!
//! Every file is written **atomically**: bytes to a temporary file in the
//! same directory, then `rename` over the target (readers never see a
//! partial file). A precompressed `.gz` sibling is written after the file
//! (the plain file is the commit point; a missing `.gz` is re-created the
//! next time the same bytes are written). `flate2` was approved for these
//! siblings on 2026-09-28 (DECISIONS J2; restored by W4-F from W3-D's code);
//! `.br` siblings are not written in M1.
//!
//! **Durability is batched** ([`Out::new`]): writes are not synced one by
//! one (an `fsync` is ≈ 10 ms on this Mac's APFS — F_FULLFSYNC — so a bell
//! of a few hundred files would stall the fold); the written paths are
//! remembered and [`sync_paths`] syncs them, and their directories, before
//! the fold's checkpoint is saved. A crash can therefore only lose or tear
//! files written after the last checkpoint, and the restart re-folds
//! exactly those records and rewrites them. [`Out::synced`] syncs every
//! write instead. gzip output is deterministic (mtime 0,
//! no name, fixed level), so the same archive gives byte-identical files,
//! siblings included (determinism test).
//!
//! Writing the same bytes again is a no-op ([`Written::Same`]): a restart
//! that re-folds records after its checkpoint rewrites nothing. Writing
//! different bytes over a file is [`Written::Changed`]; for a per-bell
//! (immutable) file that is an alarm the fold counts.
//!
//! **Compact output** ([`Out::compact`], opt-in, for new test worlds whose
//! whole data directory is held to an output budget; 2026-11-14): only the
//! deterministic `.gz` is kept, and it is the commit point (written the same
//! way: temp + rename). Every file of every bell is still written; its bytes
//! are the gzip of exactly what the default output would hold (the same
//! bytes as the default `.gz` sibling). [`Out::read`] and the same-bytes check
//! decompress; [`Out::serve`] sends the `.gz` to a client that accepts gzip and
//! the decompressed bytes to one that does not. A compact writer never mixes
//! with a plain file: meeting one is an error, nothing is written. The default
//! (`compact: false`) output is unchanged, byte for byte.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;
use flate2::{Compression, GzBuilder};

/// What a write did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    New,
    Same,
    Changed,
}

/// The output root (`<data>/files`); relative paths use `/`.
#[derive(Clone, Debug)]
pub struct Out {
    pub root: PathBuf,
    /// Write `.gz` siblings (on by default).
    pub gz: bool,
    /// Paths written since the last [`Out::take_dirty`] (batched
    /// durability); `None` = every write is synced.
    pub dirty: Option<Arc<Mutex<BTreeSet<PathBuf>>>>,
    /// Compact output: the `.gz` alone (see the module notes). Off by default.
    pub compact: bool,
}

/// The largest file a compact read decompresses (a guard against a damaged or
/// hostile `.gz`; the herald's largest per-bell files are a few hundred KiB).
pub const GUNZIP_MAX: u64 = 64 * 1024 * 1024;

/// The bytes of a gzip member, or an error (damaged, or larger than
/// [`GUNZIP_MAX`]).
pub fn gunzip(b: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(b.len().saturating_mul(4));
    GzDecoder::new(b)
        .take(GUNZIP_MAX + 1)
        .read_to_end(&mut out)?;
    if out.len() as u64 > GUNZIP_MAX {
        return Err(io::Error::other("gunzip: larger than GUNZIP_MAX"));
    }
    Ok(out)
}

/// gzip level of the siblings (fixed: part of the byte-identical output).
pub const GZ_LEVEL: u32 = 6;

/// Deterministic gzip of `b`.
pub fn gzip(b: &[u8]) -> Vec<u8> {
    let mut e = GzBuilder::new().mtime(0).write(
        Vec::with_capacity(b.len() / 2 + 64),
        Compression::new(GZ_LEVEL),
    );
    // Writing to a Vec cannot fail.
    let _ = e.write_all(b);
    e.finish().unwrap_or_default()
}

/// `path` written atomically (temp + fsync + rename + directory sync).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_via_temp(path, bytes, true)
}

fn write_via_temp(path: &Path, bytes: &[u8], sync: bool) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?
        .to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp"));
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        if sync {
            f.sync_all()?;
        }
    }
    fs::rename(&tmp, path)?;
    if sync {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Syncs files (those still present) and then their directories.
pub fn sync_paths(paths: &[PathBuf]) -> io::Result<usize> {
    let mut dirs = BTreeSet::new();
    let mut n = 0;
    for p in paths {
        match File::open(p) {
            Ok(f) => {
                f.sync_all()?;
                n += 1;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if let Some(d) = p.parent() {
            dirs.insert(d.to_path_buf());
        }
    }
    for d in dirs {
        if let Ok(f) = File::open(&d) {
            let _ = f.sync_all();
        }
    }
    Ok(n)
}

impl Out {
    /// Batched durability ([`Out::take_dirty`] + [`sync_paths`]).
    pub fn new(root: impl Into<PathBuf>) -> Out {
        Out {
            root: root.into(),
            gz: true,
            dirty: Some(Arc::new(Mutex::new(BTreeSet::new()))),
            compact: false,
        }
    }

    /// Every write synced.
    pub fn synced(root: impl Into<PathBuf>) -> Out {
        Out {
            root: root.into(),
            gz: true,
            dirty: None,
            compact: false,
        }
    }

    /// The same writer with compact output (the `.gz` alone). For a NEW output
    /// root only: a compact writer refuses a path where a plain file exists.
    pub fn compact(mut self) -> Out {
        self.compact = true;
        self.gz = true;
        self
    }

    /// The paths written since the last call.
    pub fn take_dirty(&self) -> Vec<PathBuf> {
        match &self.dirty {
            Some(d) => std::mem::take(&mut *d.lock().unwrap_or_else(|e| e.into_inner()))
                .into_iter()
                .collect(),
            None => vec![],
        }
    }

    fn put(&self, p: &Path, bytes: &[u8]) -> io::Result<()> {
        write_via_temp(p, bytes, self.dirty.is_none())?;
        if let Some(d) = &self.dirty {
            d.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(p.to_path_buf());
        }
        Ok(())
    }

    /// The absolute path of a relative one (no `..`, no absolute paths).
    pub fn path(&self, rel: &str) -> Option<PathBuf> {
        let ok = !rel.is_empty()
            && !rel.starts_with('/')
            && rel
                .split('/')
                .all(|s| !s.is_empty() && s != "." && s != ".." && !s.starts_with('.'));
        ok.then(|| self.root.join(rel))
    }

    /// Writes `bytes` at `rel` (and its `.gz` sibling; compact: the `.gz` alone).
    pub fn write(&self, rel: &str, bytes: &[u8]) -> io::Result<Written> {
        let p = self
            .path(rel)
            .ok_or_else(|| io::Error::other(format!("bad path {rel}")))?;
        let gzp = gz_path(&p);
        if self.compact {
            return self.write_compact(&p, &gzp, bytes);
        }
        let old = match fs::read(&p) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if old.as_deref() == Some(bytes) {
            if self.gz && !gzp.exists() {
                self.put(&gzp, &gzip(bytes))?;
            }
            // Durability after a crash (wave-3 review, W3-D): the bytes may
            // sit only in the page cache from before the crash; a batched
            // writer syncs them with the next checkpoint too.
            if let Some(d) = &self.dirty {
                d.lock().unwrap_or_else(|e| e.into_inner()).insert(p);
            }
            return Ok(Written::Same);
        }
        // A stale sibling must never be served with new bytes.
        if gzp.exists() {
            fs::remove_file(&gzp)?;
        }
        self.put(&p, bytes)?;
        if self.gz {
            self.put(&gzp, &gzip(bytes))?;
        }
        Ok(if old.is_some() {
            Written::Changed
        } else {
            Written::New
        })
    }

    /// Compact write: the `.gz` is the commit point (temp + rename). Same bytes
    /// (the stored member decompresses to `bytes`): a no-op as in the default
    /// output. A member that does not decompress (a file torn by a crash
    /// before the checkpoint) is rewritten, as a differing plain file would be.
    fn write_compact(&self, p: &Path, gzp: &Path, bytes: &[u8]) -> io::Result<Written> {
        if p.exists() {
            return Err(io::Error::other(format!(
                "compact output met a plain file: {}",
                p.display()
            )));
        }
        let old = match fs::read(gzp) {
            Ok(b) => Some(gunzip(&b).ok()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if let Some(Some(o)) = &old {
            if o.as_slice() == bytes {
                if let Some(d) = &self.dirty {
                    d.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(gzp.to_path_buf());
                }
                return Ok(Written::Same);
            }
        }
        self.put(gzp, &gzip(bytes))?;
        Ok(if old.is_some() {
            Written::Changed
        } else {
            Written::New
        })
    }

    /// Whether `rel` is a file of the output (default: the plain file; compact: its `.gz`).
    pub fn exists(&self, rel: &str) -> bool {
        self.path(rel).is_some_and(|p| {
            if self.compact {
                gz_path(&p).is_file()
            } else {
                p.is_file()
            }
        })
    }

    /// Reads a file (`None` if absent or the path is not allowed; compact: the
    /// decompressed `.gz`, `None` if it does not decompress).
    pub fn read(&self, rel: &str) -> Option<Vec<u8>> {
        let p = self.path(rel)?;
        if self.compact {
            return gunzip(&fs::read(gz_path(&p)).ok()?).ok();
        }
        fs::read(p).ok()
    }

    /// What the server sends for `rel`: `(bytes, gzip)` (`gzip`: the bytes are
    /// a gzip member, sent with `Content-Encoding: gzip`), or `None` if the file
    /// is absent or the path is not allowed. Default output: as before (the
    /// plain file must exist; its `.gz` sibling to a gzip client when present).
    /// Compact output: the `.gz` to a gzip client; decompressed to any other
    /// client; `None` when it does not decompress (never damaged bytes).
    pub fn serve(&self, rel: &str, accepts_gzip: bool) -> Option<(Vec<u8>, bool)> {
        let p = self.path(rel)?;
        let gz = gz_path(&p);
        if self.compact {
            if !gz.is_file() {
                return None;
            }
            let member = fs::read(&gz).ok()?;
            let plain = gunzip(&member).ok()?;
            return Some(if accepts_gzip {
                (member, true)
            } else {
                (plain, false)
            });
        }
        if !p.is_file() {
            return None;
        }
        Some(if accepts_gzip && gz.is_file() {
            (fs::read(&gz).ok()?, true)
        } else {
            (fs::read(&p).ok()?, false)
        })
    }

    /// Every file under the root (relative paths, sorted), for the
    /// determinism tests.
    pub fn list(&self) -> io::Result<Vec<String>> {
        let mut out = vec![];
        walk(&self.root, &self.root, &mut out)?;
        out.sort();
        Ok(out)
    }
}

/// The output mode a data directory was started with, kept beside `files/`
/// (`<data>/output-mode`) so that a world is never reopened in the other mode.
pub const OUTPUT_MODE_FILE: &str = "output-mode";
/// The content of [`OUTPUT_MODE_FILE`] for compact output.
pub const OUTPUT_COMPACT_V1: &[u8] = b"compact-v1\n";
/// The content of [`OUTPUT_MODE_FILE`] for compact output whose findex store is also gzip-compressed (round 14,
/// TEST-ONLY, a new world only: findex `Codec::GzipV1`).
pub const OUTPUT_COMPACT_V2: &[u8] = b"compact-v2\n";

/// Checks (and on a compact world's first start records) the output mode of
/// `data` before any file is written:
/// - compact, first start (no mode file): `data` must be new — nothing in it
///   but, at most, an empty `files` (no checkpoint, no findex store, no other
///   world's output) — and the mode file is written atomically;
/// - compact, mode file `compact-v1`: a restart of the same world;
/// - default, mode file present: refused (a compact world would serve 404s);
/// - default, no mode file: as before.
pub fn output_mode(data: &Path, files: &Path, compact: bool) -> Result<(), String> {
    output_mode_word(data, files, compact.then_some(OUTPUT_COMPACT_V1))
}

/// [`output_mode`] for any output word (`None`: the default; `Some(OUTPUT_COMPACT_V1 | OUTPUT_COMPACT_V2)`): a data
/// directory is reopened only with the word it records, never with another one or without it, and a first start with a
/// word needs a new data directory (as compact-v1).
pub fn output_mode_word(data: &Path, files: &Path, want: Option<&'static [u8]>) -> Result<(), String> {
    let known = |b: &[u8]| b == OUTPUT_COMPACT_V1 || b == OUTPUT_COMPACT_V2;
    let name = |b: &[u8]| String::from_utf8_lossy(b).trim_end().to_string();
    if let Some(w) = want {
        if !known(w) {
            return Err(format!("--output {}: not an output word", name(w)));
        }
    }
    let mode = data.join(OUTPUT_MODE_FILE);
    let held = match fs::read(&mode) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", mode.display())),
    };
    match (held, want) {
        (None, None) => Ok(()),
        (Some(b), Some(w)) if b == w => Ok(()),
        (Some(b), None) if known(&b) => Err(format!(
            "this data directory holds compact output (--output {}); it cannot be reopened without it",
            name(&b)
        )),
        (Some(b), Some(w)) if known(&b) => Err(format!(
            "this data directory holds compact output (--output {}); it cannot be reopened as --output {}",
            name(&b),
            name(w)
        )),
        (Some(_), _) => Err(format!("{}: an unknown output mode", mode.display())),
        (None, Some(w)) => {
            // A first compact start needs a NEW data directory: nothing in it but, at most, an empty `files/`.
            // Any other entry (a checkpoint, the findex archive or index, another world's output) is refused
            // before anything is written: the runner re-folds only after its checkpoint, so converting an old
            // store would lose the history before it (independent review P1, 2026-11-14).
            let entries = match fs::read_dir(data) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => vec![],
                Err(e) => return Err(format!("{}: {e}", data.display())),
                Ok(it) => it
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("{}: {e}", data.display()))?,
            };
            for e in entries {
                let p = e.path();
                let empty_files_dir = p == files
                    && match fs::read_dir(&p) {
                        Ok(mut it) => it.next().is_none(),
                        Err(_) => false,
                    };
                if !empty_files_dir {
                    return Err(format!(
                        "--output {} needs a new data directory: {} already exists",
                        name(w),
                        p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                    ));
                }
            }
            atomic_write(&mode, w).map_err(|e| format!("{}: {e}", mode.display()))
        }
    }
}

/// `x.json` → `x.json.gz`.
pub fn gz_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".gz");
    PathBuf::from(s)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> io::Result<()> {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for e in rd {
        let e = e?;
        let p = e.path();
        if e.file_type()?.is_dir() {
            walk(root, &p, out)?;
        } else if let Ok(r) = p.strip_prefix(root) {
            out.push(r.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "herald-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_atomically_with_a_deterministic_gz_sibling() {
        let d = tmp("files");
        let o = Out::synced(&d);
        assert!(o.take_dirty().is_empty());
        assert_eq!(o.write("h/a/1.json", b"{\"x\":1}").unwrap(), Written::New);
        assert_eq!(o.write("h/a/1.json", b"{\"x\":1}").unwrap(), Written::Same);
        let gz1 = fs::read(d.join("h/a/1.json.gz")).unwrap();
        assert_eq!(gz1, gzip(b"{\"x\":1}"), "deterministic");
        // A missing sibling is re-created on a same-bytes write.
        fs::remove_file(d.join("h/a/1.json.gz")).unwrap();
        assert_eq!(o.write("h/a/1.json", b"{\"x\":1}").unwrap(), Written::Same);
        assert!(d.join("h/a/1.json.gz").exists());
        assert_eq!(
            o.write("h/a/1.json", b"{\"x\":2}").unwrap(),
            Written::Changed
        );
        assert_eq!(o.read("h/a/1.json").unwrap(), b"{\"x\":2}");
        assert_eq!(
            o.list().unwrap(),
            vec!["h/a/1.json".to_string(), "h/a/1.json.gz".into()]
        );
        for bad in ["", "/etc/x", "h/../x", "h/.hidden", "h//x"] {
            assert!(o.path(bad).is_none(), "{bad}");
        }
        // Batched durability remembers what it wrote.
        let b = Out::new(&d);
        b.write("h/b/2.bin", &[1, 2, 3]).unwrap();
        let dirty = b.take_dirty();
        assert_eq!(dirty.len(), 2, "file and sibling");
        assert_eq!(sync_paths(&dirty).unwrap(), 2);
        assert!(b.take_dirty().is_empty());
        // A re-fold that finds the same bytes (after a crash) syncs them
        // with the next checkpoint as well.
        assert_eq!(b.write("h/b/2.bin", &[1, 2, 3]).unwrap(), Written::Same);
        assert_eq!(b.take_dirty().len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    /// A few bells of per-bell files and an overwritten `latest`, as a fold writes them.
    fn history(o: &Out) -> Vec<(String, Vec<u8>)> {
        let mut all = vec![];
        for bell in 0..40u32 {
            for (p, q) in [(-2i16, 4i16), (0, 0), (1, -1)] {
                let rel = format!("h/province/{p},{q}/{bell}.json");
                let body = format!(
                    "{{\"p\":{p},\"q\":{q},\"bell\":{bell},\"pad\":\"{}\"}}",
                    "x".repeat(200 + bell as usize)
                )
                .into_bytes();
                assert_eq!(o.write(&rel, &body).unwrap(), Written::New, "{rel}");
                all.push((rel, body));
            }
            let latest = format!("{{\"bell\":{bell}}}").into_bytes();
            o.write("h/province/0,0/latest.json", &latest).unwrap();
        }
        all.push((
            "h/province/0,0/latest.json".into(),
            b"{\"bell\":39}".to_vec(),
        ));
        all
    }

    #[test]
    fn default_output_is_unchanged_and_serves_as_before() {
        let d = tmp("default-serve");
        let o = Out::synced(&d);
        assert!(!o.compact, "off unless asked for");
        let all = history(&o);
        let list = o.list().unwrap();
        // every file and its sibling, nothing else
        assert_eq!(list.len(), all.len() * 2);
        for (rel, body) in &all {
            assert_eq!(
                fs::read(d.join(rel)).unwrap(),
                *body,
                "{rel}: the plain file is the bytes"
            );
            assert_eq!(
                fs::read(d.join(format!("{rel}.gz"))).unwrap(),
                gzip(body),
                "{rel}: the sibling"
            );
            assert_eq!(o.read(rel).unwrap(), *body);
            // the server's two answers, as file_answer gave them before this change
            assert_eq!(
                o.serve(rel, true).unwrap(),
                (gzip(body), true),
                "{rel}: gzip client"
            );
            assert_eq!(
                o.serve(rel, false).unwrap(),
                (body.clone(), false),
                "{rel}: plain client"
            );
        }
        // a plain file without its sibling is served plain to both
        fs::remove_file(d.join("h/province/0,0/3.json.gz")).unwrap();
        assert_eq!(o.serve("h/province/0,0/3.json", true).unwrap().1, false);
        assert!(o.serve("h/province/0,0/999.json", true).is_none(), "absent");
        assert!(o.serve("h/../x", true).is_none(), "not allowed");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn compact_output_keeps_every_file_as_the_default_sibling_only() {
        let (dd, dc) = (tmp("golden-default"), tmp("golden-compact"));
        let (od, oc) = (Out::synced(&dd), Out::synced(&dc).compact());
        let all = history(&od);
        assert_eq!(history(&oc), all, "the same history written");
        let (ld, lc) = (od.list().unwrap(), oc.list().unwrap());
        // the compact root holds exactly the default root's .gz files, byte for byte (the golden)
        let gz_only: Vec<String> = ld.iter().filter(|r| r.ends_with(".gz")).cloned().collect();
        assert_eq!(lc, gz_only);
        for r in &lc {
            assert_eq!(
                fs::read(dc.join(r)).unwrap(),
                fs::read(dd.join(r)).unwrap(),
                "{r}"
            );
        }
        // every file of every bell reads back to the default's plain bytes
        for (rel, body) in &all {
            assert!(!dc.join(rel).exists(), "{rel}: no plain file");
            assert_eq!(oc.read(rel).unwrap(), *body, "{rel}");
            assert_eq!(oc.read(rel), od.read(rel));
        }
        // fewer bytes on disk for the same history
        let size = |d: &Path, l: &[String]| {
            l.iter()
                .map(|r| fs::metadata(d.join(r)).unwrap().len())
                .sum::<u64>()
        };
        assert!(size(&dc, &lc) < size(&dd, &ld));
        let _ = (fs::remove_dir_all(&dd), fs::remove_dir_all(&dc));
    }

    #[test]
    fn compact_serves_by_accept_encoding_and_never_damaged_bytes() {
        let d = tmp("compact-serve");
        let o = Out::synced(&d).compact();
        let body = b"{\"turn\":12,\"x\":[1,2,3]}".to_vec();
        o.write("h/clash/-2,4/15.json", &body).unwrap();
        // a client that accepts gzip gets the stored member; any other client the plain bytes
        assert_eq!(
            o.serve("h/clash/-2,4/15.json", true).unwrap(),
            (gzip(&body), true)
        );
        assert_eq!(
            o.serve("h/clash/-2,4/15.json", false).unwrap(),
            (body.clone(), false)
        );
        assert!(o.serve("h/clash/-2,4/16.json", true).is_none(), "absent");
        assert!(o.serve("h/.x", false).is_none(), "not allowed");
        // a torn member (a crash before the checkpoint): not served, not read
        fs::write(d.join("h/clash/-2,4/15.json.gz"), &gzip(&body)[..10]).unwrap();
        assert!(o.serve("h/clash/-2,4/15.json", true).is_none());
        assert!(o.serve("h/clash/-2,4/15.json", false).is_none());
        assert!(o.read("h/clash/-2,4/15.json").is_none());
        // the re-fold rewrites it, as it rewrites a torn plain file
        assert_eq!(
            o.write("h/clash/-2,4/15.json", &body).unwrap(),
            Written::Changed
        );
        assert_eq!(o.read("h/clash/-2,4/15.json").unwrap(), body);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn compact_same_changed_dirty_and_atomic_commit() {
        let d = tmp("compact-commit");
        let o = Out::new(&d).compact();
        assert_eq!(
            o.write("h/bell/7.json", b"{\"a\":1}").unwrap(),
            Written::New
        );
        assert_eq!(
            o.take_dirty(),
            vec![d.join("h/bell/7.json.gz")],
            "the .gz is the one file written"
        );
        assert_eq!(
            o.write("h/bell/7.json", b"{\"a\":1}").unwrap(),
            Written::Same
        );
        assert_eq!(
            o.take_dirty().len(),
            1,
            "a same-bytes re-fold still syncs it at the checkpoint"
        );
        assert_eq!(
            o.write("h/bell/7.json", b"{\"a\":2}").unwrap(),
            Written::Changed
        );
        assert_eq!(o.read("h/bell/7.json").unwrap(), b"{\"a\":2}");
        // the commit is temp + rename: no temporary file is left, the name is never seen half-written
        assert_eq!(o.list().unwrap(), vec!["h/bell/7.json.gz".to_string()]);
        // a temporary file left by a crash is not a file of the output (never served, never read)
        fs::write(d.join("h/bell/.8.json.gz.tmp"), b"partial").unwrap();
        assert!(o.serve("h/bell/8.json", true).is_none());
        assert!(o.read("h/bell/8.json").is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn compact_never_mixes_with_a_plain_file() {
        let d = tmp("compact-mixed");
        Out::synced(&d)
            .write("h/keep/1.json", b"{\"old\":true}")
            .unwrap();
        let before = Out::synced(&d).list().unwrap();
        let o = Out::synced(&d).compact();
        let e = o.write("h/keep/1.json", b"{\"new\":true}").unwrap_err();
        assert!(e.to_string().contains("plain file"), "{e}");
        assert_eq!(
            Out::synced(&d).list().unwrap(),
            before,
            "nothing written, nothing removed"
        );
        assert_eq!(
            fs::read(d.join("h/keep/1.json")).unwrap(),
            b"{\"old\":true}"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn gunzip_refuses_damage_and_bounds_its_output() {
        assert_eq!(gunzip(&gzip(b"abc")).unwrap(), b"abc");
        assert!(gunzip(b"not gzip").is_err());
        // a member larger than the bound is refused (zeros compress to almost nothing)
        let big = gzip(&vec![0u8; (GUNZIP_MAX + 1) as usize]);
        assert!(big.len() < 1024 * 1024);
        assert!(gunzip(&big).is_err());
    }

    #[test]
    fn exists_follows_the_mode() {
        let (dd, dc) = (tmp("exists-default"), tmp("exists-compact"));
        let (od, oc) = (Out::synced(&dd), Out::synced(&dc).compact());
        od.write("h/control/3.bin", &[1, 2]).unwrap();
        oc.write("h/control/3.bin", &[1, 2]).unwrap();
        assert!(od.exists("h/control/3.bin") && oc.exists("h/control/3.bin"));
        assert!(!od.exists("h/control/4.bin") && !oc.exists("h/control/4.bin"));
        assert!(!od.exists("h/../x") && !oc.exists("h/.x"));
        // a default reader sees no file in a compact root (and must never be used on one: output_mode)
        assert!(!Out::synced(&dc).exists("h/control/3.bin"));
        let _ = (fs::remove_dir_all(&dd), fs::remove_dir_all(&dc));
    }

    #[test]
    fn output_mode_refuses_an_old_store_whose_files_are_missing_or_empty() {
        // review P1: an old world's checkpoint and findex store with files/ missing or emptied must not become a
        // compact world (the runner would re-fold only after the checkpoint and lose the history before it)
        for files_state in ["missing", "empty"] {
            let d = tmp(&format!("mode-old-store-{files_state}"));
            fs::create_dir_all(d.join("findex/archive")).unwrap();
            fs::write(d.join("findex/archive/seg-000001.log"), b"x").unwrap();
            fs::write(d.join("herald.ckpt"), b"ckpt").unwrap();
            if files_state == "empty" {
                fs::create_dir_all(d.join("files")).unwrap();
            }
            let e = output_mode(&d, &d.join("files"), true).unwrap_err();
            assert!(e.contains("new data directory"), "{files_state}: {e}");
            assert!(
                !d.join(OUTPUT_MODE_FILE).exists(),
                "{files_state}: no mode recorded"
            );
            assert_eq!(
                fs::read(d.join("herald.ckpt")).unwrap(),
                b"ckpt",
                "{files_state}: nothing changed"
            );
            // the same directory in default mode: as before
            assert!(output_mode(&d, &d.join("files"), false).is_ok());
            let _ = fs::remove_dir_all(&d);
        }
        // a checkpoint alone, or a findex store alone, is refused too
        for only in ["herald.ckpt", "findex"] {
            let d = tmp("mode-only");
            fs::create_dir_all(&d).unwrap();
            if only == "findex" {
                fs::create_dir_all(d.join("findex")).unwrap();
            } else {
                fs::write(d.join(only), b"x").unwrap();
            }
            assert!(output_mode(&d, &d.join("files"), true).is_err(), "{only}");
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn output_mode_compact_only_in_a_new_data_directory() {
        // compact, first start: an empty or absent files/ is accepted and the mode recorded
        let d = tmp("mode-new");
        assert!(output_mode(&d, &d.join("files"), true).is_ok());
        assert_eq!(
            fs::read(d.join(OUTPUT_MODE_FILE)).unwrap(),
            OUTPUT_COMPACT_V1
        );
        // the same world restarted in compact mode: fine, even with output written
        Out::synced(d.join("files"))
            .compact()
            .write("h/bell/1.json", b"{}")
            .unwrap();
        assert!(output_mode(&d, &d.join("files"), true).is_ok());
        // reopened without compact: refused, nothing changed
        let e = output_mode(&d, &d.join("files"), false).unwrap_err();
        assert!(e.contains("compact output"), "{e}");
        assert_eq!(
            fs::read(d.join(OUTPUT_MODE_FILE)).unwrap(),
            OUTPUT_COMPACT_V1
        );
        // compact over another world's output: refused, no mode file written
        let old = tmp("mode-old");
        Out::synced(old.join("files"))
            .write("h/bell/1.json", b"{}")
            .unwrap();
        let e = output_mode(&old, &old.join("files"), true).unwrap_err();
        assert!(e.contains("new data directory"), "{e}");
        assert!(!old.join(OUTPUT_MODE_FILE).exists());
        // default, no mode file: as before (an existing world keeps working)
        assert!(output_mode(&old, &old.join("files"), false).is_ok());
        // an unknown mode file is refused in both modes
        fs::write(old.join(OUTPUT_MODE_FILE), b"something-else\n").unwrap();
        assert!(output_mode(&old, &old.join("files"), false).is_err());
        assert!(output_mode(&old, &old.join("files"), true).is_err());
        // an empty files/ directory counts as new
        let e2 = tmp("mode-empty");
        fs::create_dir_all(e2.join("files")).unwrap();
        assert!(output_mode(&e2, &e2.join("files"), true).is_ok());
        let _ = (
            fs::remove_dir_all(&d),
            fs::remove_dir_all(&old),
            fs::remove_dir_all(&e2),
        );
    }
}
