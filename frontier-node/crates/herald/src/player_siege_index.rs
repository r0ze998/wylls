//! Complete history with a derived, active-only participant lookup.
use super::{SiegeEnd, SiegeHistory};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Deref;

type Key = (i16, i16, u8, u32);

/// Read-only map access is retained. Mutations must maintain the participant
/// index; deliberately no DerefMut or public mutable history references.
#[derive(Clone, Debug, Default)]
pub struct SiegeHistories {
    rows: BTreeMap<Key, SiegeHistory>,
    active: BTreeMap<u64, BTreeSet<Key>>,
    active_count: usize,
}

impl Deref for SiegeHistories {
    type Target = BTreeMap<Key, SiegeHistory>;
    fn deref(&self) -> &Self::Target {
        &self.rows
    }
}

impl SiegeHistories {
    fn unindex(&mut self, key: Key, owner: Option<u64>, attacker: u64) {
        for tag in owner.into_iter().chain(std::iter::once(attacker)) {
            if let Some(keys) = self.active.get_mut(&tag) {
                keys.remove(&key);
                if keys.is_empty() {
                    self.active.remove(&tag);
                }
            }
        }
    }

    pub fn insert(&mut self, key: Key, row: SiegeHistory) -> Option<SiegeHistory> {
        let old = self.rows.remove(&key);
        if let Some(old) = &old {
            self.unindex(key, old.owner, old.attacker);
            if old.end.is_none() {
                self.active_count -= 1;
            }
        }
        if row.end.is_none() {
            self.active_count += 1;
            for tag in row.owner.into_iter().chain(std::iter::once(row.attacker)) {
                self.active.entry(tag).or_default().insert(key);
            }
        }
        self.rows.insert(key, row);
        old
    }

    // Only conquest's progress/follow-up paths may mutate existing histories.
    pub(super) fn get_mut(&mut self, key: &Key) -> Option<&mut SiegeHistory> {
        self.rows.get_mut(key)
    }

    pub(super) fn end(&mut self, key: Key, end: SiegeEnd) {
        let Some(row) = self.rows.get_mut(&key) else {
            return;
        };
        if row.end.is_some() {
            return;
        }
        row.end = Some(end);
        let (owner, attacker) = (row.owner, row.attacker);
        self.active_count -= 1;
        self.unindex(key, owner, attacker);
    }

    pub(super) fn active_count(&self) -> usize {
        self.active_count
    }

    pub(super) fn active_for(&self, tag: u64) -> impl Iterator<Item = &SiegeHistory> {
        self.active.get(&tag).into_iter().flatten().map(|key| {
            #[cfg(test)]
            ROW_VISITS.with(|n| n.set(n.get() + 1));
            &self.rows[key]
        })
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static ROW_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
