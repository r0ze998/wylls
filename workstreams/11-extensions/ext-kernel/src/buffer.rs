//! Chunked publication (02-comparison §4): a manifest larger than one
//! transaction is written in pieces into a buffer the author opened with
//! the id it must end as, then registered by `finalize` only after every
//! byte is present and the bytes hash to that id.
//!
//! - Order does not matter (each write names its offset).
//! - A repeated piece with the same bytes is accepted and changes nothing;
//!   a piece that would change a byte already written is refused whole.
//! - Nothing is registered, so nothing can run, before `finalize`: a call
//!   naming the id meets `NotRegistered`.

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;

use crate::error::ExtError;
use crate::exec::Key;
use crate::manifest::{id_of, ManifestId, MAX_BYTES};
use crate::registry::Registry;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buffer {
    pub author: Key,
    pub expected_id: ManifestId,
    pub data: Vec<u8>,
    pub written: Vec<bool>,
}

impl Buffer {
    pub fn missing(&self) -> usize {
        self.written.iter().filter(|w| !**w).count()
    }
}

/// Open buffers by (author, the id the bytes must hash to).
#[derive(Clone, Debug, Default)]
pub struct Buffers {
    pub open: BTreeMap<(Key, ManifestId), Buffer>,
}

impl Buffers {
    pub fn open(
        &mut self,
        reg: &Registry,
        signer: &Key,
        expected_id: ManifestId,
        len: usize,
    ) -> Result<(), ExtError> {
        if len == 0 || len > MAX_BYTES {
            return Err(ExtError::TooLarge);
        }
        if reg.get(&expected_id).is_some() {
            return Err(ExtError::AlreadyRegistered);
        }
        let k = (*signer, expected_id);
        if self.open.contains_key(&k) {
            return Err(ExtError::BufferExists);
        }
        self.open.insert(
            k,
            Buffer {
                author: *signer,
                expected_id,
                data: vec![0; len],
                written: vec![false; len],
            },
        );
        Ok(())
    }

    /// One piece. All or nothing: a piece out of bounds, empty, or changing
    /// a byte already written leaves the buffer as it was.
    pub fn write(
        &mut self,
        signer: &Key,
        expected_id: ManifestId,
        offset: usize,
        bytes: &[u8],
    ) -> Result<(), ExtError> {
        let b = self
            .open
            .get_mut(&(*signer, expected_id))
            .ok_or(ExtError::NoBuffer)?;
        let end = offset
            .checked_add(bytes.len())
            .ok_or(ExtError::OutOfBounds)?;
        if bytes.is_empty() || end > b.data.len() {
            return Err(ExtError::OutOfBounds);
        }
        let range = offset..end;
        if b.written[range.clone()]
            .iter()
            .zip(&b.data[range.clone()])
            .zip(bytes)
            .any(|((w, old), new)| *w && old != new)
        {
            return Err(ExtError::ChunkConflict);
        }
        b.data[range.clone()].copy_from_slice(bytes);
        b.written[range].iter_mut().for_each(|w| *w = true);
        Ok(())
    }

    /// Register the bytes if every one is present and they hash to the id
    /// the buffer was opened for; then the usual publication check
    /// (`Registry::publish`). The buffer closes only on success.
    pub fn finalize(
        &mut self,
        reg: &mut Registry,
        signer: &Key,
        expected_id: ManifestId,
        supersedes: Option<ManifestId>,
        now_ts: i64,
    ) -> Result<ManifestId, ExtError> {
        let k = (*signer, expected_id);
        let b = self.open.get(&k).ok_or(ExtError::NoBuffer)?;
        if b.missing() > 0 {
            return Err(ExtError::Incomplete);
        }
        if id_of(&b.data) != expected_id {
            return Err(ExtError::HashMismatch);
        }
        let id = reg.publish(signer, &b.data, supersedes, now_ts)?;
        self.open.remove(&k);
        Ok(id)
    }

    /// The author gives up a buffer (e.g. a wrong piece that can no longer
    /// be overwritten).
    pub fn abandon(&mut self, signer: &Key, expected_id: ManifestId) -> Result<(), ExtError> {
        self.open
            .remove(&(*signer, expected_id))
            .map(|_| ())
            .ok_or(ExtError::NoBuffer)
    }
}
