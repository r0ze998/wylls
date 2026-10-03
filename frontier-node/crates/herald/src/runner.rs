//! The ingest loop: findex (archive, then index) → fold → files and WS
//! diffs → checkpoint (offchain design §8.2–§8.3).
//!
//! Data directory layout:
//!
//! | path | what |
//! |---|---|
//! | `findex/archive/`, `findex/index.sqlite` | the transaction archive and its index (`findex`) |
//! | `files/h/…` | the fold's files, served under `/h/` |
//! | `herald.ckpt` | the fold checkpoint |
//!
//! **Restart.** [`Ingest::open`] opens findex (the index catches up from
//! the archive), loads the checkpoint (a checkpoint ahead of the archive
//! is discarded), and folds the archived records after it, streaming one
//! segment at a time; then the source resumes from the archived cursor.
//! Rewrites of files the crashed run had already written are byte-identical
//! no-ops.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use solana_address::Address;
use tokio::sync::{broadcast, watch};

use findex::{Findex, Source};

use crate::checkpoint;
use crate::clash::ClashBuilder;
use crate::files::Out;
use crate::fold::{Diff, Fold, FoldCfg};

#[derive(Clone)]
pub struct IngestCfg {
    pub data: PathBuf,
    pub program: Address,
    pub season_id: u64,
    pub builder: Arc<dyn ClashBuilder>,
    /// See [`FoldCfg::exact_post`] (false for `--source rpc`).
    pub exact_post: bool,
    /// Checkpoint when the folded slot has advanced this far (≈ 1 min of
    /// 400-ms slots by default).
    pub checkpoint_slots: u64,
    pub segment_bytes: u64,
    /// The findex archive's group-commit interval (W5-C: its per-batch
    /// `F_FULLFSYNC`s held the ingest behind a busy chain); every fold
    /// checkpoint commits first, so a checkpoint never covers records the
    /// archive could lose.
    pub archive_commit: Duration,
    /// Test hook: a pause inside every checkpoint save (integ-W6t review:
    /// proves the ingest does not wait for the save). Zero in service.
    pub checkpoint_pause: Duration,
}

impl IngestCfg {
    pub fn new(data: impl Into<PathBuf>, program: Address, season_id: u64) -> IngestCfg {
        IngestCfg {
            data: data.into(),
            program,
            season_id,
            builder: Arc::new(crate::clash::Provisional),
            exact_post: true,
            checkpoint_slots: 150,
            segment_bytes: findex::archive::SEGMENT_BYTES,
            archive_commit: Duration::from_secs(1),
            checkpoint_pause: Duration::ZERO,
        }
    }
    pub fn findex_dir(&self) -> PathBuf {
        self.data.join("findex")
    }
    pub fn files_dir(&self) -> PathBuf {
        self.data.join("files")
    }
    pub fn checkpoint_path(&self) -> PathBuf {
        self.data.join("herald.ckpt")
    }
    pub fn index_path(&self) -> PathBuf {
        self.findex_dir().join("index.sqlite")
    }
}

pub struct Ingest {
    pub cfg: IngestCfg,
    pub findex: Findex,
    pub fold: Arc<RwLock<Fold>>,
    pub diffs: broadcast::Sender<Arc<Diff>>,
    last_ckpt_slot: u64,
    /// The checkpoint saving in the background (integ-W6t review: the
    /// awaited save every 150 slots held the fold 20–25 s three times in
    /// R5, `Ingest::step`).
    ckpt: Option<tokio::task::JoinHandle<Result<(), String>>>,
}

/// A checkpoint's content: the fold state, the conquest section (MC) and
/// the files it covers.
type Snap = (crate::fold::State, Option<Vec<u8>>, Vec<PathBuf>);

/// Unix milliseconds now (the ingest stamp of the WS diffs).
pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn send(diffs: &broadcast::Sender<Arc<Diff>>, fold: &mut Fold, t_ms: u64) {
    for mut d in fold.take_diffs() {
        d.t_ms = t_ms;
        // No receiver is not an error (no socket open yet).
        let _ = diffs.send(Arc::new(d));
    }
}

impl Ingest {
    /// Opens the store, restores the fold and catches it up with the archive.
    pub fn open(cfg: IngestCfg, diffs: broadcast::Sender<Arc<Diff>>) -> Result<Ingest, String> {
        std::fs::create_dir_all(&cfg.data).map_err(|e| e.to_string())?;
        let findex = Findex::open(
            &cfg.findex_dir(),
            cfg.program,
            Some(cfg.season_id),
            cfg.segment_bytes,
        )
        .map_err(|e| e.to_string())?;
        let mut findex = findex;
        findex.archive.commit_every = cfg.archive_commit;
        let fcfg = FoldCfg {
            program: cfg.program,
            season_id: cfg.season_id,
            builder: cfg.builder.clone(),
            exact_post: cfg.exact_post,
        };
        let out = Out::new(cfg.files_dir());
        let st = checkpoint::load_full(
            &cfg.checkpoint_path(),
            &cfg.program.to_bytes(),
            cfg.season_id,
        )
        .filter(|s| s.0.folded_through <= findex.archive.last_seq());
        let mut fold = match st {
            Some((st, cq)) => {
                let mut f = Fold::with_state(fcfg, out.clone(), st);
                // MC (CQ2-E): the conquest state; a damaged section refolds
                // from the start (the files' rewrites are no-ops).
                match cq.map(|c| {
                    serde_json::from_slice(&c)
                        .ok()
                        .and_then(|v| crate::conquest::Cq::from_json(&v))
                }) {
                    Some(Some(c)) => f.cq = c,
                    Some(None) => f = Fold::new(f.cfg.clone(), out),
                    None => {}
                }
                f
            }
            None => Fold::new(fcfg, out),
        };
        let from = fold.st.folded_through;
        findex
            .archive
            .for_each_after(from, |r| {
                fold.apply(&r);
                // Catch-up diffs go nowhere: no socket is open yet.
                fold.diffs.clear();
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        let last = fold.st.last_slot;
        let mut ing = Ingest {
            cfg,
            findex,
            fold: Arc::new(RwLock::new(fold)),
            diffs,
            last_ckpt_slot: last,
            ckpt: None,
        };
        ing.checkpoint()?;
        Ok(ing)
    }

    /// The state to save and the files it covers (taken together, under
    /// the lock), after the archive's pending group commit: the checkpoint
    /// never covers a record the archive could still lose.
    fn snapshot(&mut self) -> Result<Snap, String> {
        self.findex.commit().map_err(|e| e.to_string())?;
        let f = self.fold.read().map_err(|_| "fold lock poisoned")?;
        // MC (CQ2-E): the conquest state rides along (none for M1).
        let cq =
            f.cq.on
                .then(|| serde_json::to_vec(&f.cq.to_json()).unwrap_or_default());
        Ok((f.st.clone(), cq, f.out.take_dirty()))
    }

    fn save(cfg: &IngestCfg, snap: &Snap) -> Result<(), String> {
        let (st, cq, dirty) = snap;
        if !cfg.checkpoint_pause.is_zero() {
            std::thread::sleep(cfg.checkpoint_pause);
        }
        // Files first: the checkpoint may only cover durable files.
        crate::files::sync_paths(dirty).map_err(|e| e.to_string())?;
        checkpoint::save_full(
            &cfg.checkpoint_path(),
            &cfg.program.to_bytes(),
            cfg.season_id,
            st,
            cq.as_deref(),
        )
        .map_err(|e| e.to_string())
    }

    /// Syncs the files written since the last checkpoint, then saves the
    /// fold's state (blocking; use [`Ingest::checkpoint_async`] on a
    /// runtime worker).
    pub fn checkpoint(&mut self) -> Result<(), String> {
        let snap = self.snapshot()?;
        Self::save(&self.cfg, &snap)
    }

    /// [`Ingest::checkpoint`] off the runtime's workers (the syncs take
    /// ≈ 10 ms per file on APFS), without holding the fold lock.
    pub async fn checkpoint_async(&mut self) -> Result<(), String> {
        self.checkpoint_settled().await;
        let snap = self.snapshot()?;
        let cfg = self.cfg.clone();
        tokio::task::spawn_blocking(move || Self::save(&cfg, &snap))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Waits for the background checkpoint, if one is saving.
    pub async fn checkpoint_settled(&mut self) {
        if let Some(h) = self.ckpt.take() {
            if let Ok(Err(e)) = h.await {
                eprintln!("herald: checkpoint: {e}");
            }
        }
    }

    /// Whether a background checkpoint is still saving.
    pub fn checkpoint_in_flight(&self) -> bool {
        self.ckpt.as_ref().is_some_and(|h| !h.is_finished())
    }

    /// Starts a checkpoint on a blocking worker and returns at once
    /// (integ-W6t review); `false` while the previous one still saves (the
    /// next step tries again). The state and its dirty files are taken
    /// together under the lock, as before; the fold goes on meanwhile.
    fn checkpoint_background(&mut self) -> Result<bool, String> {
        if self.checkpoint_in_flight() {
            return Ok(false);
        }
        if let Some(h) = self.ckpt.take() {
            // Finished: a failed save was already reported by the worker.
            drop(h);
        }
        let snap = self.snapshot()?;
        let cfg = self.cfg.clone();
        self.ckpt = Some(tokio::task::spawn_blocking(move || {
            let r = Self::save(&cfg, &snap);
            if let Err(e) = &r {
                eprintln!("herald: checkpoint: {e}");
            }
            r
        }));
        Ok(true)
    }

    /// One pull of `src`: archive, index, fold, publish; returns the number
    /// of transactions folded.
    pub async fn step<S: Source>(&mut self, src: &mut S) -> Result<usize, String> {
        // The stamp is taken before the pull, so `t` covers the pull, the
        // archive's sync, the index, the fold and the fan-out.
        let t_ms = unix_ms();
        let got = self.findex.ingest(src).await.map_err(|e| e.to_string())?;
        if got.is_empty() {
            return Ok(0);
        }
        let slot = {
            let mut f = self.fold.write().map_err(|_| "fold lock poisoned")?;
            for r in &got {
                f.apply(r);
            }
            send(&self.diffs, &mut f, t_ms);
            f.st.last_slot
        };
        if slot
            >= self
                .last_ckpt_slot
                .saturating_add(self.cfg.checkpoint_slots)
            && self.checkpoint_background()?
        {
            self.last_ckpt_slot = slot;
        }
        Ok(got.len())
    }

    /// Records the chain's latest slot and Clock for the live views.
    pub fn observe_clock(&self, slot: u64, unix: i64) {
        if let Ok(mut f) = self.fold.write() {
            f.live = Some((slot, unix));
        }
    }
}

/// Runs the loop until `stop` turns true: pull, fold, publish; sleep `poll`
/// when nothing new arrived; checkpoint on the way out.
pub async fn run<S: Source, P: fclient::ports::ChainPort>(
    mut ing: Ingest,
    mut src: S,
    clock: Option<P>,
    poll: Duration,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    ing.findex.resume(&mut src);
    loop {
        if *stop.borrow() {
            break;
        }
        let n = match ing.step(&mut src).await {
            Ok(n) => n,
            Err(e) => {
                eprintln!("herald: ingest: {e}");
                0
            }
        };
        if let Some(c) = &clock {
            if let Ok(ck) = c.clock().await {
                ing.observe_clock(ck.slot, ck.unix_timestamp);
            }
        }
        if n == 0 {
            tokio::select! {
                _ = tokio::time::sleep(poll) => {}
                _ = stop.changed() => {}
            }
        }
    }
    ing.checkpoint_async().await
}

/// Whether a data directory holds a herald store.
pub fn has_store(data: &Path) -> bool {
    data.join("findex").exists()
}
