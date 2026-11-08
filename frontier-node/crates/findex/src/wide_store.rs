//! Explicit opt-in archive/typed-index path. Not the default Findex and not
//! a replacement for keeper/verifier safety gates. Post-state is preserved
//! in the raw archive only: no account capture is upgraded to verified.

use std::path::{Path, PathBuf};

use fclient::{ports::TxRecord, Address};
use frontier_abi::world_index::WorldId;

use crate::{wide_index::WideIndex, Archive, IngestError, Source, CATCH_UP_BATCH};

pub struct WideFindex {
    pub dir: PathBuf,
    archive: Archive,
    pub index: WideIndex,
    poisoned: bool,
}

impl WideFindex {
    pub fn open(
        dir: &Path,
        program: Address,
        world: WorldId,
        segment_bytes: u64,
    ) -> Result<Self, IngestError> {
        let st = IngestError::Store;
        std::fs::create_dir_all(dir).map_err(|e| st(e.to_string()))?;
        let archive =
            Archive::open(&dir.join("archive"), segment_bytes).map_err(|e| st(e.to_string()))?;
        let mut index =
            WideIndex::open(&dir.join("wide-index.sqlite"), program, world).map_err(st)?;
        let status = index.status().map_err(st)?;
        if let Some(block) = status.blocked {
            return Err(st(format!("wide index blocked: {block}; retain archive and explicitly rebuild with a compatible reader")));
        }
        index.mark_incomplete().map_err(st)?;
        if status.last_seq > archive.last_seq() {
            return Err(st(
                "wide index is ahead of durable archive; refusing rollback/reorg".into(),
            ));
        }
        let mut batch = Vec::new();
        archive
            .for_each_after(status.last_seq, |r| {
                batch.push(r);
                if batch.len() >= CATCH_UP_BATCH {
                    index.add(&batch).map_err(std::io::Error::other)?;
                    batch.clear();
                }
                Ok(())
            })
            .map_err(|e| st(e.to_string()))?;
        index.add(&batch).map_err(st)?;
        index.mark_caught_up(archive.last_seq()).map_err(st)?;
        Ok(Self {
            dir: dir.into(),
            archive,
            index,
            poisoned: false,
        })
    }
    pub fn archive(&self) -> &Archive {
        &self.archive
    }
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }
    pub fn resume<S: Source>(&self, src: &mut S) {
        let cursor = self.archive.cursor();
        if cursor.is_null() && self.archive.last_seq() > 0 {
            src.restore(&serde_json::json!({"cursor_missing_after_seq":self.archive.last_seq()}));
        } else {
            src.restore(cursor);
        }
    }
    pub fn commit(&mut self) -> Result<(), IngestError> {
        if self.poisoned {
            return Err(IngestError::Store(
                "wide store failed; reopen required".into(),
            ));
        }
        self.archive.commit().map_err(|e| {
            self.poisoned = true;
            IngestError::Store(e.to_string())
        })
    }
    pub async fn ingest<S: Source>(&mut self, src: &mut S) -> Result<Vec<TxRecord>, IngestError> {
        if self.poisoned {
            return Err(IngestError::Store(
                "wide store failed; reopen required".into(),
            ));
        }
        let status = self.index.status().map_err(IngestError::Store)?;
        if status.blocked.is_some() || status.last_seq != self.archive.last_seq() {
            self.index.mark_incomplete().map_err(IngestError::Store)?;
            self.poisoned = true;
            return Err(IngestError::Store(
                "wide index blocked or behind archive; no further pull allowed".into(),
            ));
        }
        let got = src.pull().await.map_err(IngestError::Port)?;
        if got.is_empty() {
            return Ok(Vec::new());
        }
        self.index.mark_incomplete().map_err(|e| {
            self.poisoned = true;
            IngestError::Store(e)
        })?;
        let stored = self.archive.append(&got, src.cursor()).map_err(|e| {
            self.poisoned = true;
            IngestError::Store(e.to_string())
        })?;
        self.index.add(&stored).map_err(|e| {
            self.poisoned = true;
            IngestError::Store(e)
        })?;
        self.index
            .mark_caught_up(self.archive.last_seq())
            .map_err(|e| {
                self.poisoned = true;
                IngestError::Store(e)
            })?;
        Ok(stored)
    }
}
