//! The registry's minimal fields (contract §3). Workstream 06 owns
//! publication, adoption and versions; this is only what the core and the
//! verifier must be able to read from it.
//!
//! **Not a second registry of 06's definitions.** It holds only 11's own
//! `WXM1` manifests, which 06's format cannot carry today (an unknown field
//! is refused, and their ops are 06's case D), and their *execution* status
//! (Active / Paused / Revoked), which 06 asked to keep apart from its
//! publication status. 06's definitions are read, never copied, through
//! `workstreams/11-extensions/creation-bridge`. If 06 comes to hold 11
//! manifests, `publish` and `supersedes` here give way to 06's and this
//! keeps the execution status alone (a pending decision, not adopted).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::error::ExtError;
use crate::exec::Key;
use crate::manifest::{Manifest, ManifestId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    Paused,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub manifest_id: ManifestId,
    pub bytes: Vec<u8>,
    pub manifest: Manifest,
    pub author: Key,
    pub supersedes: Option<ManifestId>,
    /// Every status with the time it took effect, oldest first.
    pub history: Vec<(i64, Status)>,
}

impl Registration {
    pub fn status(&self) -> Status {
        self.history.last().map(|x| x.1).unwrap_or(Status::Revoked)
    }
}

/// The status of a registration at `ts`, from its history (what a verifier
/// reads; a change at `ts` itself applies from `ts`).
pub fn status_at(history: &[(i64, Status)], ts: i64) -> Option<Status> {
    history.iter().rev().find(|(t, _)| *t <= ts).map(|x| x.1)
}

#[derive(Clone, Debug, Default)]
pub struct Registry {
    pub entries: BTreeMap<ManifestId, Registration>,
    /// The operator's emergency stop key (may pause or revoke anything).
    pub operator: Key,
}

impl Registry {
    pub fn new(operator: Key) -> Registry {
        Registry {
            entries: BTreeMap::new(),
            operator,
        }
    }

    /// Publication: the bytes decode, pass the static check, and the signer
    /// is the manifest's author. An update is a new id naming the old one;
    /// the old registration is not touched.
    pub fn publish(
        &mut self,
        signer: &Key,
        bytes: &[u8],
        supersedes: Option<ManifestId>,
        now_ts: i64,
    ) -> Result<ManifestId, ExtError> {
        let m = Manifest::decode(bytes)?;
        m.validate()?;
        if &m.author != signer {
            return Err(ExtError::NotSigned);
        }
        let id = crate::manifest::id_of(bytes);
        if self.entries.contains_key(&id) {
            return Err(ExtError::AlreadyRegistered);
        }
        if let Some(old) = supersedes {
            let o = self.entries.get(&old).ok_or(ExtError::NotRegistered)?;
            if &o.author != signer {
                return Err(ExtError::NotAuthor);
            }
        }
        self.entries.insert(
            id,
            Registration {
                manifest_id: id,
                bytes: bytes.to_vec(),
                author: m.author,
                manifest: m,
                supersedes,
                history: alloc::vec![(now_ts, Status::Active)],
            },
        );
        Ok(id)
    }

    pub fn set_status(
        &mut self,
        signer: &Key,
        id: &ManifestId,
        to: Status,
        now_ts: i64,
    ) -> Result<(), ExtError> {
        let operator = self.operator;
        let r = self.entries.get_mut(id).ok_or(ExtError::NotRegistered)?;
        if signer != &r.author && signer != &operator {
            return Err(ExtError::NotAuthor);
        }
        // Revocation is final.
        if r.status() == Status::Revoked {
            return Err(ExtError::Revoked);
        }
        if r.history.last().is_some_and(|(t, _)| now_ts < *t) {
            return Err(ExtError::TimeReversed);
        }
        r.history.push((now_ts, to));
        Ok(())
    }

    pub fn get(&self, id: &ManifestId) -> Option<&Registration> {
        self.entries.get(id)
    }
}
