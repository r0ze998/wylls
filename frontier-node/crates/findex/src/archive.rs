//! The append-only transaction archive (offchain design §4.3).
//!
//! Every program transaction the ingest sees — failed ones included — is
//! appended, in feed order, to **segment files** of about 64 MiB. A segment
//! is a sequence of frames `len u32 LE ‖ sha256(payload)[0..8] ‖ payload`,
//! where `payload` is the JSON form of one [`TxRecord`] with the archive's
//! own sequence number. The **manifest** (`manifest.json`, replaced
//! atomically by write-to-temp + rename after every append) lists each
//! segment with its first and last sequence, record count, byte length and,
//! once the segment is sealed, the sha256 of the whole file; it also holds
//! the ingest source's cursor, so the archive and the cursor move together.
//!
//! **Crash safety.** Frames are written and synced before the manifest names
//! them. A crash between the two leaves unnamed bytes at the end of the open
//! segment, and — when the batch rolled — segment files the manifest does
//! not name at all; [`Archive::open`] truncates the first and deletes the
//! second (their transactions are re-ingested, because the manifest's
//! cursor is still before them), and a new segment is always created empty
//! (truncate), so a re-used name never keeps an earlier attempt's frames
//! (integ-W2 review of W2-F). A segment shorter than its manifest entry is
//! corruption and refuses to open.
//!
//! **Segment names (2026-11-17).** This writer names the k-th segment `seg-{k:06}.log` (six digits at least, more
//! past 999999) and only ever appends segments, so a manifest it wrote names segment k exactly so. A manifest that
//! names any segment otherwise (another number, `../`, an absolute path, `./`, a duplicate) is refused when it is
//! read, and [`Archive::open`] also refuses a named segment that is there but is not a regular file (a symbolic link,
//! a directory, …). Both checks come before the open's recovery writes (truncating the open segment, removing unnamed
//! segments, rewriting the manifest), so a refused archive is left exactly as it was. The checks are made once, at
//! open: a file swapped afterwards is not covered.
//!
//! **Hard links (2026-11-17).** The archive writes into two existing files: the open (last, unsealed) segment, which
//! `open` may truncate and every append extends, and a leftover `manifest.json.tmp`, which the next manifest write
//! truncates (`File::create`). A second name for either inode (a hard link) would make those writes change a file
//! outside the archive too, so on Unix [`Archive::open`] refuses either when its link count is not 1, and a leftover
//! `manifest.json.tmp` that is not a regular file. Sealed segments are only read, so a hard link to one is left
//! allowed. Nothing in this repository makes such links (no writer, backup or restore step). On other systems the link
//! count is not read, and this check is not made.
//!
//! **Codec (round 13, TEST-ONLY, a new archive only).** [`Archive::open_with`] with [`Codec::GzipV1`] stores each
//! frame's payload gzip-compressed (the frame's length and sha256 prefix are those of the STORED bytes, so the frame
//! check, the torn-tail truncation and the sealed segments' sha256 work as before) and records `"codec": "gzip-v1"` in
//! the manifest. Every read decodes, bounded by [`crate::codec::FRAME_DECODE_MAX`], before the record and its sequence are
//! checked as before. An archive is never reopened with another codec than it records ([`Archive::open_with`] refuses).
//! [`Archive::open`] is [`Codec::Plain`]: no `codec` key, the same bytes as before.
//!
//! **Group commit (W5-C).** With [`Archive::commit_every`] = 0 (the
//! default) every [`Archive::append`] is durable when it returns: the
//! batch's frames are synced once, then the manifest. With an interval
//! (the herald: 1 s) an append writes its frames and updates the manifest
//! in memory only, and the syncs and the manifest land at most once per
//! interval ([`Archive::commit`]; the herald also commits before each fold
//! checkpoint). The crash rule is unchanged: the durable manifest names
//! only synced frames and holds the cursor before the rest, so a crash
//! loses at most one interval of records, which the source re-delivers.
//! (The first smoke run: one `F_FULLFSYNC` per record — macOS's
//! `sync_data` — held the herald's ingest minutes behind a busy chain.)

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codec::{Codec, FRAME_DECODE_MAX};
use fclient::ports::{Account, TxRecord};
use fclient::rpc::{account_json, parse_account};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Default segment size (offchain design §4.3).
pub const SEGMENT_BYTES: u64 = 64 * 1024 * 1024;
/// Manifest format version.
pub const MANIFEST_VERSION: u64 = 1;
const FRAME_HEAD: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentMeta {
    pub name: String,
    pub first_seq: u64,
    pub last_seq: u64,
    pub records: u64,
    pub bytes: u64,
    /// sha256 of the whole file, once sealed.
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub version: u64,
    pub segment_bytes: u64,
    pub segments: Vec<SegmentMeta>,
    /// Sequence number the next record gets (1 for an empty archive).
    pub next_seq: u64,
    /// The ingest source's cursor after the last appended batch.
    pub cursor: Value,
}

impl Manifest {
    fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "segment_bytes": self.segment_bytes,
            "next_seq": self.next_seq,
            "cursor": self.cursor,
            "segments": self.segments.iter().map(|s| json!({
                "name": s.name, "first_seq": s.first_seq, "last_seq": s.last_seq,
                "records": s.records, "bytes": s.bytes, "sha256": s.sha256,
            })).collect::<Vec<_>>(),
        })
    }

    fn from_json(v: &Value) -> Result<Manifest, String> {
        let u = |x: &Value, k: &str| {
            x.get(k)
                .and_then(|y| y.as_u64())
                .ok_or(format!("manifest: {k}"))
        };
        let version = u(v, "version")?;
        if version != MANIFEST_VERSION {
            return Err(format!("manifest version {version}"));
        }
        let mut segments = vec![];
        for (i, s) in v
            .get("segments")
            .and_then(|x| x.as_array())
            .ok_or("manifest: segments")?
            .iter()
            .enumerate()
        {
            // The name the writer gives segment i + 1 (module note): anything else is refused, never joined to a path.
            let name = s.get("name").and_then(|x| x.as_str()).ok_or("manifest: name")?;
            let want = segment_name(i as u64 + 1);
            if name != want {
                let shown: String = name.chars().take(80).collect();
                return Err(format!(
                    "manifest: segment {} is named {shown:?}, not {want}: refused, nothing opened or changed",
                    i + 1
                ));
            }
            segments.push(SegmentMeta {
                name: s
                    .get("name")
                    .and_then(|x| x.as_str())
                    .ok_or("manifest: name")?
                    .into(),
                first_seq: u(s, "first_seq")?,
                last_seq: u(s, "last_seq")?,
                records: u(s, "records")?,
                bytes: u(s, "bytes")?,
                sha256: s.get("sha256").and_then(|x| x.as_str()).map(String::from),
            });
        }
        Ok(Manifest {
            version,
            segment_bytes: u(v, "segment_bytes")?,
            segments,
            next_seq: u(v, "next_seq")?,
            cursor: v.get("cursor").cloned().unwrap_or(Value::Null),
        })
    }
}

/// How many names a file has beyond the one it was reached by, when more than none: `Some(n)`. On Unix from the link
/// count; on other systems the count is not read, and `None` is returned (no check is made: module note).
#[cfg(unix)]
fn other_names(m: &fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    (m.nlink() > 1).then(|| m.nlink() - 1)
}
#[cfg(not(unix))]
fn other_names(_: &fs::Metadata) -> Option<u64> {
    None
}

/// The file name of the `k`-th segment (1-based), as this writer has always named it.
fn segment_name(k: u64) -> String {
    format!("seg-{k:06}.log")
}

/// The JSON payload of one archived transaction.
pub fn record_to_json(r: &TxRecord) -> Value {
    json!({
        "seq": r.seq, "slot": r.slot, "signature": r.signature.to_string(), "block_time": r.block_time,
        "tx": B64.encode(&r.tx), "logs": r.logs, "err": r.err, "code": r.code, "units": r.units, "fee": r.fee,
        "post": r.post.iter().map(|(k, a)| json!([k.to_string(), a.as_ref().map(account_json)])).collect::<Vec<_>>(),
    })
}

pub fn record_from_json(v: &Value) -> Result<TxRecord, String> {
    let d = |m: &str| format!("record: {m}");
    let post = v
        .get("post")
        .and_then(|x| x.as_array())
        .ok_or(d("post"))?
        .iter()
        .map(|p| {
            let k = p
                .get(0)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok())
                .ok_or(d("post key"))?;
            let a: Option<Account> =
                parse_account(p.get(1).unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
            Ok((k, a))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(TxRecord {
        seq: v.get("seq").and_then(|x| x.as_u64()).ok_or(d("seq"))?,
        slot: v.get("slot").and_then(|x| x.as_u64()).ok_or(d("slot"))?,
        signature: v
            .get("signature")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or(d("signature"))?,
        block_time: v.get("block_time").and_then(|x| x.as_i64()).unwrap_or(0),
        tx: B64
            .decode(v.get("tx").and_then(|x| x.as_str()).ok_or(d("tx"))?)
            .map_err(|e| e.to_string())?,
        logs: v
            .get("logs")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        err: v.get("err").and_then(|x| x.as_str()).map(String::from),
        code: v.get("code").and_then(|x| x.as_u64()).map(|c| c as u32),
        units: v.get("units").and_then(|x| x.as_u64()).unwrap_or(0),
        fee: v.get("fee").and_then(|x| x.as_u64()).unwrap_or(0),
        post,
    })
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(FRAME_HEAD + payload.len());
    f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    f.extend_from_slice(&Sha256::digest(payload)[..8]);
    f.extend_from_slice(payload);
    f
}

/// Reads the frames of a segment up to `limit` bytes; stops at the first
/// incomplete or corrupt frame and reports how many bytes were good.
fn read_frames(path: &Path, limit: u64) -> io::Result<(Vec<Vec<u8>>, u64)> {
    let mut r = BufReader::new(File::open(path)?.take(limit));
    let mut out = vec![];
    let mut good = 0u64;
    loop {
        let mut head = [0u8; FRAME_HEAD];
        if r.read_exact(&mut head).is_err() {
            break;
        }
        let len = u32::from_le_bytes(head[..4].try_into().expect("4")) as usize;
        let mut p = vec![0u8; len];
        if r.read_exact(&mut p).is_err() || Sha256::digest(&p)[..8] != head[4..12] {
            break;
        }
        good += (FRAME_HEAD + len) as u64;
        out.push(p);
    }
    Ok((out, good))
}

fn file_sha256(path: &Path) -> io::Result<String> {
    let mut h = Sha256::new();
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn io_err(m: impl std::fmt::Display) -> io::Error {
    io::Error::other(m.to_string())
}

/// The archive directory.
pub struct Archive {
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// Group-commit interval (module note); `ZERO`: every append commits.
    pub commit_every: std::time::Duration,
    last_commit: std::time::Instant,
    /// The open segment's handle while it holds frames not synced yet.
    unsynced: Option<File>,
    /// The in-memory manifest differs from the durable one.
    dirty: bool,
    /// How frame payloads are stored (module note); recorded in the manifest unless the default.
    codec: Codec,
    /// The most one frame's payload may decode to (with a codec, enforced on write and on read).
    frame_max: usize,
}

impl Archive {
    /// Opens (or creates) the archive in `dir`; segments roll at `segment_bytes`.
    pub fn open(dir: &Path, segment_bytes: u64) -> io::Result<Archive> {
        Archive::open_with(dir, segment_bytes, Codec::Plain)
    }

    /// [`Archive::open`] with a frame codec (module note). A new archive records it; an existing one must record the
    /// same codec, or nothing is opened (never a mixed archive).
    pub fn open_with(dir: &Path, segment_bytes: u64, codec: Codec) -> io::Result<Archive> {
        fs::create_dir_all(dir)?;
        let mp = dir.join("manifest.json");
        let manifest = if mp.exists() {
            let v: Value = serde_json::from_slice(&fs::read(&mp)?).map_err(io_err)?;
            let recorded = match v.get("codec") {
                None => Codec::Plain,
                Some(Value::String(w)) => Codec::from_word(Some(w)).map_err(io_err)?,
                Some(_) => return Err(io_err("manifest: codec")),
            };
            if recorded != codec {
                return Err(io_err(format!(
                    "the archive records codec {:?}, it was opened with {:?}: a store is never reopened in another codec",
                    recorded.word().unwrap_or("plain"),
                    codec.word().unwrap_or("plain")
                )));
            }
            Manifest::from_json(&v).map_err(io_err)?
        } else {
            Manifest {
                version: MANIFEST_VERSION,
                segment_bytes: segment_bytes.max(1),
                segments: vec![],
                next_seq: 1,
                cursor: Value::Null,
            }
        };
        // Before any recovery write: every named segment that is there must be a regular file, not a symbolic link
        // or anything else (module note: segment names). A missing one is left to the rules below, as before.
        for s in &manifest.segments {
            match fs::symlink_metadata(dir.join(&s.name)) {
                Ok(m) if m.file_type().is_file() => {}
                Ok(_) => {
                    return Err(io_err(format!(
                        "segment {} is not a regular file (a symbolic link, a directory, …): refused, nothing changed",
                        s.name
                    )))
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        // The two existing files the archive writes into: the open segment and a leftover temporary manifest (module
        // note: hard links). Each must have no other name.
        let mut written: Vec<PathBuf> = vec![dir.join("manifest.json.tmp")];
        if let Some(last) = manifest.segments.last() {
            if last.sha256.is_none() {
                written.push(dir.join(&last.name));
            }
        }
        for p in &written {
            match fs::symlink_metadata(p) {
                Ok(m) if !m.file_type().is_file() => {
                    return Err(io_err(format!(
                        "{} is not a regular file: refused, nothing changed",
                        p.display()
                    )))
                }
                Ok(m) => {
                    if let Some(n) = other_names(&m) {
                        return Err(io_err(format!(
                            "{} has {n} other name(s) (a hard link): the archive would write through them; refused, nothing changed",
                            p.display()
                        )));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        // Recover the open segment: drop bytes the manifest does not name.
        if let Some(last) = manifest.segments.last() {
            if last.sha256.is_none() {
                let p = dir.join(&last.name);
                let len = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if len < last.bytes {
                    return Err(io_err(format!(
                        "segment {} is {len} B, the manifest names {} B",
                        last.name, last.bytes
                    )));
                }
                if len > last.bytes {
                    OpenOptions::new()
                        .write(true)
                        .open(&p)?
                        .set_len(last.bytes)?;
                }
            }
        }
        // Segment files of a batch that rolled and crashed before its
        // manifest: not named, so not ours; their records are re-ingested.
        for e in fs::read_dir(dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("seg-")
                && name.ends_with(".log")
                && !manifest.segments.iter().any(|s| s.name == name)
            {
                fs::remove_file(e.path())?;
            }
        }
        let a = Archive {
            dir: dir.into(),
            manifest,
            commit_every: std::time::Duration::ZERO,
            last_commit: std::time::Instant::now(),
            unsynced: None,
            dirty: false,
            codec,
            frame_max: FRAME_DECODE_MAX,
        };
        a.write_manifest()?;
        Ok(a)
    }

    fn write_manifest(&self) -> io::Result<()> {
        let tmp = self.dir.join("manifest.json.tmp");
        let mut f = File::create(&tmp)?;
        let mut m = self.manifest.to_json();
        if let Some(w) = self.codec.word() {
            m["codec"] = json!(w);
        }
        f.write_all(&serde_json::to_vec_pretty(&m).map_err(io_err)?)?;
        f.sync_all()?;
        fs::rename(&tmp, self.dir.join("manifest.json"))?;
        if let Ok(d) = File::open(&self.dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    /// The ingest cursor stored with the last batch.
    pub fn cursor(&self) -> &Value {
        &self.manifest.cursor
    }

    /// The last sequence number appended (0 = empty).
    pub fn last_seq(&self) -> u64 {
        self.manifest.next_seq - 1
    }

    /// Appends `recs` in order (renumbering them with the archive's
    /// sequence), then records `cursor`; returns the renumbered records.
    /// Durable on return when a commit is due (module note: group commit);
    /// the frames of one segment are written through one handle and synced
    /// once, before the segment is sealed or a manifest names them.
    pub fn append(&mut self, recs: &[TxRecord], cursor: Value) -> io::Result<Vec<TxRecord>> {
        self.append_inner(recs, cursor, false)
    }

    /// [`Archive::append`] for an ordered feed whose `seq` is the node's
    /// ledger number (`LocalnetFeed`): each frame also keeps that number as
    /// `feed_seq` ([`Archive::for_each_after_feed`]), since the archive
    /// renumbers `seq` with its own sequence.
    pub fn append_feed(&mut self, recs: &[TxRecord], cursor: Value) -> io::Result<Vec<TxRecord>> {
        self.append_inner(recs, cursor, true)
    }

    fn append_inner(
        &mut self,
        recs: &[TxRecord],
        cursor: Value,
        keep_feed_seq: bool,
    ) -> io::Result<Vec<TxRecord>> {
        let mut out = Vec::with_capacity(recs.len());
        // (round 13 review: every frame of the batch is built and checked BEFORE any is written. With a codec, a record
        //  whose JSON is longer than a frame may decode to is refused and nothing of the batch is written — never a record
        //  this archive could not read back. The default is unchanged: no limit, the same bytes.)
        let mut staged = Vec::with_capacity(recs.len());
        for (i, r) in recs.iter().enumerate() {
            let mut r = r.clone();
            let feed_seq = r.seq;
            r.seq = self.manifest.next_seq + i as u64;
            let mut v = record_to_json(&r);
            if keep_feed_seq {
                v["feed_seq"] = json!(feed_seq);
            }
            let raw = serde_json::to_vec(&v).map_err(io_err)?;
            if self.codec != Codec::Plain && raw.len() > self.frame_max {
                return Err(io_err(format!(
                    "record {} is {} B as JSON, over the {} B a {} frame may decode to: refused, nothing of this batch written",
                    r.seq,
                    raw.len(),
                    self.frame_max,
                    self.codec.word().unwrap_or("plain")
                )));
            }
            staged.push((r, self.codec.encode(&raw)));
        }
        for (r, payload) in staged {
            let fr = frame(&payload);
            let roll = match self.manifest.segments.last() {
                None => true,
                Some(s) => {
                    s.sha256.is_some()
                        || (s.records > 0
                            && s.bytes + fr.len() as u64 > self.manifest.segment_bytes)
                }
            };
            if roll {
                // The frames written so far reach the disk before the
                // segment is hashed and sealed.
                if let Some(f) = self.unsynced.take() {
                    f.sync_data()?;
                }
                self.seal_open()?;
                let n = self.manifest.segments.len() + 1;
                self.manifest.segments.push(SegmentMeta {
                    name: segment_name(n as u64),
                    first_seq: r.seq,
                    last_seq: r.seq - 1,
                    records: 0,
                    bytes: 0,
                    sha256: None,
                });
                // Created empty: never append behind an earlier attempt's
                // unnamed frames under the same name.
                let s = self.manifest.segments.last().expect("new segment");
                File::create(self.dir.join(&s.name))?.sync_all()?;
            }
            let s = self.manifest.segments.last_mut().expect("open segment");
            if self.unsynced.is_none() {
                let p = self.dir.join(&s.name);
                self.unsynced = Some(OpenOptions::new().create(true).append(true).open(&p)?);
            }
            if let Some(f) = self.unsynced.as_mut() {
                f.write_all(&fr)?;
            }
            s.bytes += fr.len() as u64;
            s.records += 1;
            s.last_seq = r.seq;
            self.manifest.next_seq += 1;
            out.push(r);
        }
        self.manifest.cursor = cursor;
        self.dirty = true;
        if self.last_commit.elapsed() >= self.commit_every {
            self.commit()?;
        }
        Ok(out)
    }

    /// Makes every append so far durable: the open segment's frames are
    /// synced, then the manifest (with the cursor) replaces the old one.
    pub fn commit(&mut self) -> io::Result<()> {
        if let Some(f) = self.unsynced.take() {
            f.sync_data()?;
        }
        if self.dirty {
            self.write_manifest()?;
            self.dirty = false;
        }
        self.last_commit = std::time::Instant::now();
        Ok(())
    }

    /// Appends not yet durable (group commit pending).
    pub fn uncommitted(&self) -> bool {
        self.dirty
    }

    /// Seals the open segment (records its sha256).
    fn seal_open(&mut self) -> io::Result<()> {
        if let Some(s) = self.manifest.segments.last_mut() {
            if s.sha256.is_none() {
                s.sha256 = Some(file_sha256(&self.dir.join(&s.name))?);
            }
        }
        Ok(())
    }

    /// Every record with `seq > after` and its `feed_seq`, in order.
    pub fn read_after_feed(&self, after: u64) -> io::Result<Vec<(TxRecord, Option<u64>)>> {
        let mut out = vec![];
        self.for_each_after_feed(after, |r, f| {
            out.push((r, f));
            Ok(())
        })?;
        Ok(out)
    }

    /// Every record with `seq > after`, in order.
    pub fn read_after(&self, after: u64) -> io::Result<Vec<TxRecord>> {
        let mut out = vec![];
        self.for_each_after(after, |r| {
            out.push(r);
            Ok(())
        })?;
        Ok(out)
    }

    /// Streams every record with `seq > after`, in order, one segment in
    /// memory at a time (a season's archive does not fit in memory as
    /// records; the herald's catch-up reads it this way). Returns the
    /// number of records given to `f`; an error of `f` stops the walk.
    ///
    /// A segment that does not read back as its manifest entry says (bytes,
    /// record count, contiguous sequence from `first_seq`) is an error
    /// naming it: a damaged or rewritten part of the archive must never read
    /// as a shorter one (the herald's fold and the index would be short
    /// with no sign of it). Sealing, compaction or checkpoints added later
    /// keep this: a reader gets every record of its range or an error.
    ///
    /// This checks what the archive holds against its own manifest, nothing
    /// more. Passing it does not make the history complete: transactions the
    /// archive never received (a first pull, a missing or older cursor, a
    /// range a node lacks in the middle) leave no damaged segment, so the
    /// walk succeeds without them.
    pub fn for_each_after(
        &self,
        after: u64,
        mut f: impl FnMut(TxRecord) -> io::Result<()>,
    ) -> io::Result<u64> {
        self.for_each_after_feed(after, |r, _| f(r))
    }

    /// [`Archive::for_each_after`] with each record's `feed_seq` (the
    /// node's ledger number, kept by [`Archive::append_feed`]; `None` for a
    /// record appended without it, e.g. archived before it was kept).
    pub fn for_each_after_feed(
        &self,
        after: u64,
        mut f: impl FnMut(TxRecord, Option<u64>) -> io::Result<()>,
    ) -> io::Result<u64> {
        let mut n = 0;
        for s in &self.manifest.segments {
            if s.records == 0 || s.last_seq <= after {
                continue;
            }
            let (frames, good) = read_frames(&self.dir.join(&s.name), s.bytes)?;
            if good != s.bytes || frames.len() as u64 != s.records {
                return Err(io_err(format!(
                    "{}: {good} of {} B and {} of {} records readable: the archive is damaged",
                    s.name,
                    s.bytes,
                    frames.len(),
                    s.records
                )));
            }
            for (expect, p) in (s.first_seq..).zip(frames) {
                let p = self.codec.decode(&p, self.frame_max).map_err(|e| io_err(format!("{}: {e}", s.name)))?;
                let v: Value = serde_json::from_slice(&p).map_err(io_err)?;
                let r = record_from_json(&v).map_err(io_err)?;
                if r.seq != expect {
                    return Err(io_err(format!(
                        "{}: seq {}, expected {expect}: the archive is damaged",
                        s.name, r.seq
                    )));
                }
                if r.seq > after {
                    f(r, v.get("feed_seq").and_then(|x| x.as_u64()))?;
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    /// Checks every segment against the manifest: sealed segments by their
    /// sha256, the open one frame by frame; sequence numbers contiguous.
    pub fn verify(&self) -> Result<u64, String> {
        let mut expect = 1u64;
        for s in &self.manifest.segments {
            let p = self.dir.join(&s.name);
            let len = fs::metadata(&p)
                .map_err(|e| format!("{}: {e}", s.name))?
                .len();
            if len != s.bytes {
                return Err(format!("{}: {len} B, manifest {} B", s.name, s.bytes));
            }
            if let Some(h) = &s.sha256 {
                let got = file_sha256(&p).map_err(|e| e.to_string())?;
                if &got != h {
                    return Err(format!("{}: sha256 {got}, manifest {h}", s.name));
                }
            }
            let (frames, good) = read_frames(&p, s.bytes).map_err(|e| e.to_string())?;
            if good != s.bytes || frames.len() as u64 != s.records {
                return Err(format!("{}: corrupt frame after {good} B", s.name));
            }
            for f in frames {
                let f = self.codec.decode(&f, self.frame_max).map_err(|e| format!("{}: {e}", s.name))?;
                let v: Value = serde_json::from_slice(&f).map_err(|e| e.to_string())?;
                let seq = v.get("seq").and_then(|x| x.as_u64()).unwrap_or(0);
                if seq != expect {
                    return Err(format!("{}: seq {seq}, expected {expect}", s.name));
                }
                expect += 1;
            }
        }
        if expect != self.manifest.next_seq {
            return Err(format!(
                "manifest next_seq {}, records end at {}",
                self.manifest.next_seq,
                expect - 1
            ));
        }
        Ok(expect - 1)
    }

    /// The codec this archive stores frames with.
    pub fn codec(&self) -> Codec {
        self.codec
    }

    /// Byte size of the open segment on disk (tests).
    pub fn open_segment_len(&self) -> io::Result<u64> {
        match self.manifest.segments.last() {
            None => Ok(0),
            Some(s) => {
                let mut f = File::open(self.dir.join(&s.name))?;
                f.seek(SeekFrom::End(0))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_address::Address;

    pub(crate) fn rec(i: u64) -> TxRecord {
        TxRecord {
            seq: 900 + i,
            slot: 10 + i,
            signature: fclient::ports::Signature::from([i as u8; 64]),
            block_time: 1_800_000_000 + i as i64,
            tx: vec![i as u8; 40],
            logs: vec![format!("Program log: {i}")],
            err: i
                .is_multiple_of(3)
                .then(|| "InstructionError(0, Custom(52))".into()),
            code: i.is_multiple_of(3).then_some(52),
            units: 1_000 * i,
            fee: 5_000,
            post: vec![(
                Address::new_from_array([i as u8; 32]),
                Some(Account {
                    lamports: i,
                    data: vec![1, 2, i as u8],
                    owner: Address::new_from_array([9; 32]),
                    executable: false,
                }),
            )],
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "findex-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&d);
        d
    }

    // (2026-11-17, WRITTEN ONLY: not run) Segment names: a manifest naming a segment otherwise than the writer does,
    // or a named segment that is not a regular file, is refused before anything is changed.

    /// A root these tests created themselves (`create_dir`: never an existing one); only its owner removes it, also
    /// when an assertion unwinds.
    struct SegnameRoot(PathBuf);
    impl Drop for SegnameRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn segname_root(name: &str) -> SegnameRoot {
        let d = std::env::temp_dir().join(format!(
            "findex-segname-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        if let Err(e) = fs::create_dir(&d) {
            panic!("the test root must be new; {} was not created ({e}) and is left as it is", d.display());
        }
        SegnameRoot(d)
    }
    /// Every entry of `dir` (not followed): name, kind, length, and the bytes of regular files.
    fn snapshot(dir: &Path) -> Vec<(String, &'static str, u64, Vec<u8>)> {
        let mut out = vec![];
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let m = fs::symlink_metadata(e.path()).unwrap();
            let t = m.file_type();
            let kind = if t.is_symlink() { "link" } else if t.is_dir() { "dir" } else if t.is_file() { "file" } else { "other" };
            let bytes = if t.is_file() { fs::read(e.path()).unwrap() } else { vec![] };
            out.push((e.file_name().to_string_lossy().into_owned(), kind, m.len(), bytes));
        }
        out.sort();
        out
    }
    /// An archive with one open (unsealed) segment, inside `root`, and a 4 KiB file beside it that a wrong path
    /// would reach. Returns (archive dir, outside file, its bytes).
    fn one_segment(root: &Path) -> (PathBuf, PathBuf, Vec<u8>) {
        let d = root.join("archive");
        let mut a = Archive::open(&d, 600_000).unwrap();
        a.append(&[rec(1), rec(2)], json!({"after": 2})).unwrap();
        drop(a);
        let outside = root.join("outside.txt");
        let bytes = vec![7u8; 4096];
        fs::write(&outside, &bytes).unwrap();
        (d, outside, bytes)
    }
    fn set_names(d: &Path, names: &[&str]) {
        let mp = d.join("manifest.json");
        let mut m: Value = serde_json::from_slice(&fs::read(&mp).unwrap()).unwrap();
        let segs = m["segments"].as_array_mut().unwrap();
        if names.len() > segs.len() {
            let extra = segs[0].clone();
            segs.push(extra); // a second entry, for the duplicate case
        }
        for (s, n) in segs.iter_mut().zip(names) {
            s["name"] = json!(n);
        }
        fs::write(&mp, serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    }

    #[test]
    fn the_writers_own_names_still_open_and_large_numbers_keep_their_digits() {
        assert_eq!(segment_name(1), "seg-000001.log");
        assert_eq!(segment_name(999_999), "seg-999999.log");
        assert_eq!(segment_name(1_000_000), "seg-1000000.log", "six digits at least, not at most");
        let root = segname_root("ok");
        let d = root.0.join("archive");
        let mut a = Archive::open(&d, 600).unwrap();
        let recs: Vec<TxRecord> = (1..=9).map(rec).collect();
        a.append(&recs, json!({"after": 9})).unwrap();
        let names: Vec<String> = a.manifest.segments.iter().map(|s| s.name.clone()).collect();
        assert!(names.len() >= 3, "600-B segments roll");
        drop(a);
        let b = Archive::open(&d, 600).unwrap();
        assert_eq!(b.manifest.segments.iter().map(|s| s.name.clone()).collect::<Vec<_>>(), names);
        assert_eq!(b.verify(), Ok(9));
    }

    #[test]
    fn a_name_the_writer_never_gives_is_refused_and_nothing_inside_or_outside_changes() {
        let root = segname_root("names");
        let (d, outside, bytes) = one_segment(&root.0);
        let abs = outside.to_string_lossy().into_owned();
        for names in [
            vec!["../outside.txt"],
            vec![abs.as_str()],
            vec!["./seg-000001.log"],
            vec!["seg-1.log"],
            vec!["seg-000002.log"],
            vec!["seg-000001.log", "seg-000001.log"],
            vec!["SEG-000001.LOG"],
        ] {
            let before_manifest = fs::read(d.join("manifest.json")).unwrap();
            set_names(&d, &names);
            let before = snapshot(&d);
            let e = Archive::open(&d, 600_000).err().unwrap_or_else(|| panic!("{names:?} was opened"));
            assert!(e.to_string().contains("refused"), "{names:?}: {e}");
            assert_eq!(snapshot(&d), before, "{names:?}: nothing in the archive changed (no truncation, removal or manifest write)");
            assert_eq!(fs::read(&outside).unwrap(), bytes, "{names:?}: the file outside is untouched");
            fs::write(d.join("manifest.json"), &before_manifest).unwrap(); // the test's own fixture, restored for the next case
        }
        // and the archive itself is still as the writer left it
        assert_eq!(Archive::open(&d, 600_000).unwrap().verify(), Ok(2));
    }

    #[cfg(unix)]
    #[test]
    fn a_named_segment_that_is_a_link_or_a_directory_is_refused_and_nothing_is_written_through_it() {
        let root = segname_root("links");
        let (d, outside, bytes) = one_segment(&root.0);
        let seg = d.join("seg-000001.log");
        let kept = fs::read(&seg).unwrap();
        // the open segment replaced by a link to the bigger file outside: a recovery would truncate through it
        fs::remove_file(&seg).unwrap();
        std::os::unix::fs::symlink(&outside, &seg).unwrap();
        let before = snapshot(&d);
        let e = Archive::open(&d, 600_000).err().expect("a linked segment was opened");
        assert!(e.to_string().contains("not a regular file"), "{e}");
        assert_eq!(snapshot(&d), before);
        assert_eq!(fs::read(&outside).unwrap(), bytes, "nothing truncated through the link");
        // a directory in its place
        fs::remove_file(&seg).unwrap();
        fs::create_dir(&seg).unwrap();
        let before = snapshot(&d);
        assert!(Archive::open(&d, 600_000).err().unwrap().to_string().contains("not a regular file"));
        assert_eq!(snapshot(&d), before);
        // the real segment back: it opens again
        fs::remove_dir(&seg).unwrap();
        fs::write(&seg, &kept).unwrap();
        assert_eq!(Archive::open(&d, 600_000).unwrap().verify(), Ok(2));
    }

    // (2026-11-17, WRITTEN ONLY: not run) Hard links to the files the archive writes into.
    #[cfg(unix)]
    #[test]
    fn a_hard_linked_open_segment_is_refused_and_neither_name_changes() {
        let root = segname_root("hardlink-open");
        let (d, _outside, _) = one_segment(&root.0);
        let seg = d.join("seg-000001.log");
        let other = root.0.join("other-name.log"); // a second name for the open segment's inode, outside the archive
        fs::hard_link(&seg, &other).unwrap();
        // longer than the manifest names, so a recovery would truncate it (through both names)
        let mut f = OpenOptions::new().append(true).open(&seg).unwrap();
        f.write_all(b"unnamed tail").unwrap();
        drop(f);
        let (before, other_bytes) = (snapshot(&d), fs::read(&other).unwrap());
        let e = Archive::open(&d, 600_000).err().expect("a hard-linked open segment was opened");
        assert!(e.to_string().contains("hard link"), "{e}");
        assert_eq!(snapshot(&d), before, "nothing in the archive changed");
        assert_eq!(fs::read(&other).unwrap(), other_bytes, "nothing written through the other name");
        // the other name removed (the test's own fixture): the archive opens, and recovers its tail as before
        fs::remove_file(&other).unwrap();
        let b = Archive::open(&d, 600_000).unwrap();
        assert_eq!(b.verify(), Ok(2));
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_link_to_a_sealed_segment_is_allowed_and_never_written() {
        let root = segname_root("hardlink-sealed");
        let d = root.0.join("archive");
        let mut a = Archive::open(&d, 600).unwrap();
        let recs: Vec<TxRecord> = (1..=12).map(rec).collect();
        a.append(&recs[..9], json!({"after": 9})).unwrap();
        assert!(a.manifest.segments[0].sha256.is_some(), "the first segment is sealed");
        drop(a);
        let other = root.0.join("sealed-copy.log");
        fs::hard_link(d.join("seg-000001.log"), &other).unwrap();
        let kept = fs::read(&other).unwrap();
        let mut b = Archive::open(&d, 600).unwrap();
        b.append(&recs[9..], json!({"after": 12})).unwrap();
        assert_eq!(b.verify(), Ok(12));
        assert_eq!(fs::read(&other).unwrap(), kept, "a sealed segment is only read");
    }

    #[cfg(unix)]
    #[test]
    fn a_leftover_temporary_manifest_with_another_name_or_a_link_is_refused() {
        let root = segname_root("tmp-manifest");
        let (d, outside, bytes) = one_segment(&root.0);
        let tmp = d.join("manifest.json.tmp");
        // a hard link: the next manifest write would truncate the file outside
        fs::hard_link(&outside, &tmp).unwrap();
        let before = snapshot(&d);
        assert!(Archive::open(&d, 600_000).err().expect("opened").to_string().contains("hard link"));
        assert_eq!(snapshot(&d), before);
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        // a symbolic link: the same, refused as not a regular file
        fs::remove_file(&tmp).unwrap();
        std::os::unix::fs::symlink(&outside, &tmp).unwrap();
        let before = snapshot(&d);
        assert!(Archive::open(&d, 600_000).err().expect("opened").to_string().contains("not a regular file"));
        assert_eq!(snapshot(&d), before);
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        // an ordinary leftover (a crash before the rename) still opens, as before
        fs::remove_file(&tmp).unwrap();
        fs::write(&tmp, b"{ partial").unwrap();
        assert_eq!(Archive::open(&d, 600_000).unwrap().verify(), Ok(2));
    }

    #[cfg(unix)]
    #[test]
    fn a_sealed_segment_that_is_a_link_is_refused_too() {
        let root = segname_root("sealed");
        let d = root.0.join("archive");
        let mut a = Archive::open(&d, 600).unwrap();
        let recs: Vec<TxRecord> = (1..=9).map(rec).collect();
        a.append(&recs, json!({"after": 9})).unwrap();
        assert!(a.manifest.segments[0].sha256.is_some(), "the first segment is sealed");
        drop(a);
        let outside = root.0.join("outside.txt");
        let first = d.join("seg-000001.log");
        fs::rename(&first, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &first).unwrap();
        let bytes = fs::read(&outside).unwrap();
        let before = snapshot(&d);
        assert!(Archive::open(&d, 600).err().unwrap().to_string().contains("not a regular file"));
        assert_eq!(snapshot(&d), before);
        assert_eq!(fs::read(&outside).unwrap(), bytes);
    }


    #[test]
    fn appends_rolls_seals_and_verifies() {
        let d = tmp("roll");
        let mut a = Archive::open(&d, 600).unwrap();
        let recs: Vec<TxRecord> = (1..=9).map(rec).collect();
        let got = a.append(&recs[..4], json!({"after": 4})).unwrap();
        assert_eq!(
            got.iter().map(|r| r.seq).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        a.append(&recs[4..], json!({"after": 9})).unwrap();
        assert!(a.manifest.segments.len() >= 3, "600-B segments roll");
        assert!(a.manifest.segments[..a.manifest.segments.len() - 1]
            .iter()
            .all(|s| s.sha256.is_some()));
        assert_eq!(a.verify(), Ok(9));
        let back = a.read_after(0).unwrap();
        assert_eq!(back.len(), 9);
        for (i, r) in back.iter().enumerate() {
            let mut want = recs[i].clone();
            want.seq = i as u64 + 1;
            assert_eq!(r, &want);
        }
        assert_eq!(a.read_after(7).unwrap().len(), 2);
        // Reopen: the same manifest and cursor.
        let b = Archive::open(&d, 600).unwrap();
        assert_eq!(b.manifest, a.manifest);
        assert_eq!(b.cursor(), &json!({"after": 9}));
        let _ = fs::remove_dir_all(&d);
    }

    /// Group commit (W5-C): appends inside the interval are readable at
    /// once but not durable; a crash (no commit) reopens at the last
    /// committed manifest and cursor, dropping the uncommitted frames and
    /// rolled segments, and a commit makes everything durable.
    #[test]
    fn group_commit_is_durable_only_at_commits() {
        let d = tmp("group");
        let mut a = Archive::open(&d, 600).unwrap();
        a.commit_every = std::time::Duration::from_secs(3_600);
        let recs: Vec<TxRecord> = (1..=12).map(rec).collect();
        a.append(&recs[..3], json!({"after": 3})).unwrap();
        a.commit().unwrap();
        assert!(!a.uncommitted());
        a.append(&recs[3..9], json!({"after": 9})).unwrap();
        assert!(a.uncommitted());
        assert_eq!(
            a.read_after(0).unwrap().len(),
            9,
            "readable before the commit"
        );
        // Crash: dropped without a commit.
        drop(a);
        let mut b = Archive::open(&d, 600).unwrap();
        assert_eq!(b.last_seq(), 3);
        assert_eq!(b.cursor(), &json!({"after": 3}));
        assert_eq!(b.verify(), Ok(3));
        b.commit_every = std::time::Duration::from_secs(3_600);
        b.append(&recs[3..12], json!({"after": 12})).unwrap();
        b.commit().unwrap();
        drop(b);
        let c = Archive::open(&d, 600).unwrap();
        assert_eq!(c.verify(), Ok(12));
        assert_eq!(c.cursor(), &json!({"after": 12}));
        let _ = fs::remove_dir_all(&d);
    }

    /// A crash after a batch rolled into a new segment but before the
    /// manifest was written: the manifest names neither the new segment nor
    /// the old segment's new bytes. Reopening drops both, and later appends
    /// (which re-use the new segment's name) verify and read back.
    #[test]
    fn a_crash_across_a_segment_roll_reopens_clean() {
        let d = tmp("rollcrash");
        let mut a = Archive::open(&d, 600).unwrap();
        let recs: Vec<TxRecord> = (1..=12).map(rec).collect();
        a.append(&recs[..3], json!({"after": 3})).unwrap();
        let before = fs::read(d.join("manifest.json")).unwrap();
        let segs_before = a.manifest.segments.len();
        a.append(&recs[3..9], json!({"after": 9})).unwrap();
        assert!(a.manifest.segments.len() > segs_before, "the batch rolled");
        // Crash: the manifest of the rolled batch never reached disk.
        fs::write(d.join("manifest.json"), &before).unwrap();
        drop(a);
        let mut b = Archive::open(&d, 600).unwrap();
        assert_eq!(b.verify(), Ok(3));
        assert_eq!(b.cursor(), &json!({"after": 3}));
        assert_eq!(b.read_after(0).unwrap().len(), 3);
        // The source re-sends 4..=12: they land under the same names.
        b.append(&recs[3..], json!({"after": 12})).unwrap();
        assert_eq!(b.verify(), Ok(12));
        let back = b.read_after(0).unwrap();
        assert_eq!(
            back.iter().map(|r| r.seq).collect::<Vec<_>>(),
            (1..=12).collect::<Vec<_>>()
        );
        assert_eq!(Archive::open(&d, 600).unwrap().verify(), Ok(12));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn with_a_codec_a_record_it_could_not_read_back_is_refused_before_anything_is_written() {
        let d = tmp("frame-limit");
        let mut a = Archive::open_with(&d, 600_000, Codec::GzipV1).unwrap();
        a.append(&[rec(1)], json!(1)).unwrap();
        a.commit().unwrap();
        let (seq, len, m) = (a.manifest.next_seq, a.open_segment_len().unwrap(), fs::read(d.join("manifest.json")).unwrap());
        // the limit just under the second record's JSON: the batch is refused, the record before it in the batch too
        let big = { let mut r = rec(3); r.post[0].1.as_mut().unwrap().data = vec![7; 4096]; r };
        a.frame_max = serde_json::to_vec(&record_to_json(&TxRecord { seq: seq + 1, ..big.clone() })).unwrap().len() - 1;
        let e = a.append(&[rec(2), big.clone()], json!(2)).unwrap_err().to_string();
        assert!(e.contains("refused, nothing of this batch written"), "{e}");
        assert_eq!(a.manifest.next_seq, seq, "no sequence taken");
        assert_eq!(a.open_segment_len().unwrap(), len, "no byte written");
        a.commit().unwrap();
        assert_eq!(fs::read(d.join("manifest.json")).unwrap(), m, "the manifest is as it was");
        // the archive goes on: a record within the limit is appended and every record reads back
        a.append(&[rec(2)], json!(3)).unwrap();
        a.commit().unwrap();
        assert_eq!(a.read_after(0).unwrap().len(), 2);
        assert_eq!(a.verify().unwrap(), 2);
        // the default has no such limit: the same record is stored as before
        let p = tmp("frame-limit-plain");
        let mut b = Archive::open(&p, 600_000).unwrap();
        b.frame_max = 10;
        b.append(&[big], json!(1)).unwrap();
        assert_eq!(b.read_after(0).unwrap().len(), 1);
        let _ = fs::remove_dir_all(d);
        let _ = fs::remove_dir_all(p);
    }

    #[test]
    fn a_torn_tail_is_truncated_and_tampering_is_caught() {
        let d = tmp("torn");
        let mut a = Archive::open(&d, SEGMENT_BYTES).unwrap();
        a.append(&[rec(1), rec(2)], json!(2)).unwrap();
        let seg = d.join(&a.manifest.segments[0].name);
        let named = a.manifest.segments[0].bytes;
        // A crash after writing a frame but before the manifest named it.
        OpenOptions::new()
            .append(true)
            .open(&seg)
            .unwrap()
            .write_all(&frame(b"{\"half\":"))
            .unwrap();
        let b = Archive::open(&d, SEGMENT_BYTES).unwrap();
        assert_eq!(fs::metadata(&seg).unwrap().len(), named, "truncated");
        assert_eq!(b.verify(), Ok(2));
        // A flipped byte inside a frame is caught.
        let mut bytes = fs::read(&seg).unwrap();
        let n = bytes.len();
        bytes[n - 5] ^= 1;
        fs::write(&seg, &bytes).unwrap();
        assert!(b.verify().is_err());
        // A segment shorter than the manifest refuses to open.
        fs::write(&seg, &bytes[..10]).unwrap();
        assert!(Archive::open(&d, SEGMENT_BYTES).is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
