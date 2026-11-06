//! A sparse index of the provinces some source has *reported* opened or
//! closed in one world, with bounded cursor pagination over ring windows
//! and a canonical snapshot (experimental; see the module doc of
//! [`super`]).
//!
//! **Trust.** The index is a bookkeeping structure for a reader, keeper or
//! view. Inserting an entry asserts nothing about the chain: it does not
//! authorise opening land, prove that an OpenProvince was final, grant
//! ownership of anything, or issue any asset. The state type is therefore
//! [`ReportedState`] (what a source said, not what the chain proves), an
//! entry carries no owner, and a province the index has never been told
//! about is [`Lookup::Unknown`], never a default.
//!
//! **Shape.** One `BTreeMap` from the 17-byte sort key to a record, for one
//! [`WorldId`]. There is no array over a radius and no allocation
//! proportional to any ring: a world with provinces at ring 2⁶² costs as
//! much as one with the same number at ring 2. A page is served by a
//! `range` walk from the cursor and touches at most `limit + 1` entries.
//!
//! **Revisions.** Every record carries a revision. An insert needs an
//! unknown key and revision [`FIRST_REVISION`]; an update needs a known
//! key and exactly the next revision. Anything else is an error that names
//! the case ([`IndexError`]): a replay (same revision, same content), a
//! conflict (same revision, other content), a stale revision, a gap. The
//! index never picks a winner.
//!
//! **Cursors.** A [`Cursor`] names the world, the window, the last key
//! served and the index *epoch* (the count of successful mutations). A
//! cursor is refused on another world, after any mutation, or if its bytes
//! are not canonical. Resuming after a mutation is a new first page: the
//! caller decides, the index does not guess.

use super::coord::{WideCoord, SORT_KEY_LEN};
use super::key::{ProvinceKey, WorldId, WORLD_ID_LEN};
use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::cmp::Ordering;
use core::ops::Bound;

/// Most entries a page may ask for.
pub const MAX_PAGE: usize = 256;
/// The revision of a first insert.
pub const FIRST_REVISION: u64 = 1;
/// Layout version of the cursor bytes.
pub const CURSOR_VERSION: u8 = 1;
/// Bytes of a cursor: version, world, epoch, lo ring, hi ring, last key, content tag.
pub const CURSOR_LEN: usize = 1 + WORLD_ID_LEN + 8 + 8 + 8 + SORT_KEY_LEN + 32;
/// Magic of a snapshot.
pub const SNAPSHOT_MAGIC: [u8; 8] = *b"PSFWIX01";
/// Bytes of a snapshot header: magic, world, epoch, count.
pub const SNAPSHOT_HEADER_LEN: usize = 8 + WORLD_ID_LEN + 8 + 8;
/// Bytes of a snapshot entry: sort key, revision, state, observed_at.
pub const SNAPSHOT_ENTRY_LEN: usize = SORT_KEY_LEN + 8 + 1 + 8;

/// What the source *reported* about a province. Neither variant is a proof:
/// `Open` means "a source said this province was opened", not that an
/// OpenProvince is final on the chain or that anyone holds anything there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReportedState {
    Open,
    Closed,
}

impl ReportedState {
    const fn to_byte(self) -> u8 {
        match self {
            ReportedState::Open => 1,
            ReportedState::Closed => 2,
        }
    }
    const fn from_byte(b: u8) -> Option<ReportedState> {
        match b {
            1 => Some(ReportedState::Open),
            2 => Some(ReportedState::Closed),
            _ => None,
        }
    }
}

/// One record of the index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexEntry {
    pub key: ProvinceKey,
    /// 1 at insert, +1 per update.
    pub revision: u64,
    pub state: ReportedState,
    /// A caller-supplied ordinal (a bell, a slot, a log position). Stored
    /// and returned as given; the index does not interpret or order by it,
    /// and it is not evidence of finality.
    pub observed_at: u64,
}

/// The result of a lookup. Absent means unknown: the index has no opinion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lookup {
    Unknown,
    Known(IndexEntry),
}

/// Why a snapshot is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotFault {
    Length,
    Magic,
    World,
    /// The header count and the byte length disagree.
    Count,
    /// Entries not in strictly ascending key order (so no duplicates).
    Order,
    /// A non-canonical sort key.
    Key,
    /// A state byte that is neither reported state.
    State,
    /// A revision below [`FIRST_REVISION`].
    Revision,
}

/// Why a cursor is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorFault {
    Length,
    Version,
    World,
    /// `lo > hi`.
    Window,
    /// A non-canonical last key, or one outside the window.
    Key,
}

/// Every refusal of the index, each naming its case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexError {
    /// The entry or key belongs to another world.
    WorldMismatch {
        expected: WorldId,
        got: WorldId,
    },
    /// Insert of a known key.
    DuplicateInsert {
        key: ProvinceKey,
    },
    /// An insert whose revision is not [`FIRST_REVISION`].
    InvalidFirstRevision {
        got: u64,
    },
    /// Update of an unknown key.
    UnknownRecord {
        key: ProvinceKey,
    },
    /// An update below the current revision.
    StaleRevision {
        current: u64,
        got: u64,
    },
    /// An update at the current revision with the same content (a replay).
    DuplicateRevision {
        revision: u64,
    },
    /// An update at the current revision with other content.
    ConflictingRevision {
        revision: u64,
    },
    /// An update that skips revisions.
    RevisionGap {
        expected: u64,
        got: u64,
    },
    /// A page limit of 0 or above [`MAX_PAGE`].
    PageLimit {
        got: usize,
    },
    /// A ring window with `lo > hi`.
    EmptyWindow {
        lo: u64,
        hi: u64,
    },
    /// A cursor of another world.
    CursorWorldMismatch {
        expected: WorldId,
        got: WorldId,
    },
    /// A cursor issued before a mutation.
    StaleCursor {
        cursor_epoch: u64,
        index_epoch: u64,
    },
    CounterExhausted,
    CursorSnapshotMismatch,
    MalformedCursor(CursorFault),
    MalformedSnapshot(SnapshotFault),
}

/// An inclusive ring window `lo..=hi`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Window {
    lo: u64,
    hi: u64,
}

impl Window {
    pub const fn rings(lo: u64, hi: u64) -> Result<Window, IndexError> {
        if lo > hi {
            return Err(IndexError::EmptyWindow { lo, hi });
        }
        Ok(Window { lo, hi })
    }
    pub const fn ring(d: u64) -> Window {
        Window { lo: d, hi: d }
    }
    /// Every ring.
    pub const fn all() -> Window {
        Window {
            lo: 0,
            hi: u64::MAX,
        }
    }
    pub const fn lo(&self) -> u64 {
        self.lo
    }
    pub const fn hi(&self) -> u64 {
        self.hi
    }
    fn contains_key(&self, key: &[u8; SORT_KEY_LEN]) -> bool {
        let mut r = [0u8; 8];
        r.copy_from_slice(&key[..8]);
        (self.lo..=self.hi).contains(&u64::from_be_bytes(r))
    }
}

/// The first sort key of ring `d` (wedge 0, position 0).
fn ring_start(d: u64) -> [u8; SORT_KEY_LEN] {
    let mut k = [0u8; SORT_KEY_LEN];
    k[..8].copy_from_slice(&d.to_be_bytes());
    k
}

/// A position in a paginated walk of one window of one world at one
/// epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    world: WorldId,
    epoch: u64,
    window: Window,
    after: [u8; SORT_KEY_LEN],
    content_tag: [u8; 32],
}

impl Cursor {
    pub const fn world(&self) -> WorldId {
        self.world
    }
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }
    pub const fn window(&self) -> Window {
        self.window
    }
    /// The last coordinate served (the next page starts after it).
    pub fn after(&self) -> Result<WideCoord, IndexError> {
        WideCoord::from_sort_key(&self.after)
            .map_err(|_| IndexError::MalformedCursor(CursorFault::Key))
    }

    /// `CURSOR_VERSION ‖ world ‖ epoch (LE) ‖ lo (LE) ‖ hi (LE) ‖ last key ‖ content tag`.
    pub fn to_bytes(&self) -> [u8; CURSOR_LEN] {
        let mut out = [0u8; CURSOR_LEN];
        out[0] = CURSOR_VERSION;
        let mut s = 1;
        out[s..s + WORLD_ID_LEN].copy_from_slice(self.world.as_bytes());
        s += WORLD_ID_LEN;
        out[s..s + 8].copy_from_slice(&self.epoch.to_le_bytes());
        s += 8;
        out[s..s + 8].copy_from_slice(&self.window.lo.to_le_bytes());
        s += 8;
        out[s..s + 8].copy_from_slice(&self.window.hi.to_le_bytes());
        s += 8;
        out[s..s + SORT_KEY_LEN].copy_from_slice(&self.after);
        out[s + SORT_KEY_LEN..].copy_from_slice(&self.content_tag);
        out
    }

    /// Inverse of [`Cursor::to_bytes`]: exact length, this version, a
    /// non-reserved world, `lo ≤ hi`, and a canonical last key inside the
    /// window, else [`IndexError::MalformedCursor`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Cursor, IndexError> {
        use CursorFault as F;
        use IndexError::MalformedCursor as E;
        if bytes.len() != CURSOR_LEN {
            return Err(E(F::Length));
        }
        if bytes[0] != CURSOR_VERSION {
            return Err(E(F::Version));
        }
        let mut s = 1;
        let mut w = [0u8; WORLD_ID_LEN];
        w.copy_from_slice(&bytes[s..s + WORLD_ID_LEN]);
        let world = WorldId::new(w).map_err(|_| E(F::World))?;
        s += WORLD_ID_LEN;
        let epoch = le64(&bytes[s..s + 8]);
        s += 8;
        let lo = le64(&bytes[s..s + 8]);
        s += 8;
        let hi = le64(&bytes[s..s + 8]);
        s += 8;
        let window = Window::rings(lo, hi).map_err(|_| E(F::Window))?;
        let mut after = [0u8; SORT_KEY_LEN];
        after.copy_from_slice(&bytes[s..s + SORT_KEY_LEN]);
        let mut content_tag = [0; 32];
        content_tag.copy_from_slice(&bytes[s + SORT_KEY_LEN..]);
        WideCoord::from_sort_key(&after).map_err(|_| E(F::Key))?;
        if !window.contains_key(&after) {
            return Err(E(F::Key));
        }
        Ok(Cursor {
            world,
            epoch,
            window,
            after,
            content_tag,
        })
    }
}

fn le64(b: &[u8]) -> u64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(b);
    u64::from_le_bytes(x)
}

/// One page of a walk: at most `limit` entries in ring order, and the
/// cursor of the next page if any entry of the window remains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub entries: Vec<IndexEntry>,
    pub next: Option<Cursor>,
}

/// A record as kept: the coordinate is stored beside its sort key so no
/// page or lookup ever re-derives it from bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stored {
    coord: WideCoord,
    revision: u64,
    state: ReportedState,
    observed_at: u64,
}

/// The opened-province index of one world.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedProvinceIndex {
    world: WorldId,
    epoch: u64,
    entries: BTreeMap<[u8; SORT_KEY_LEN], Stored>,
    content_tag: [u8; 32],
}

impl OpenedProvinceIndex {
    /// An empty index of `world` at epoch 0.
    pub fn new(world: WorldId) -> OpenedProvinceIndex {
        OpenedProvinceIndex {
            world,
            epoch: 0,
            entries: BTreeMap::new(),
            content_tag: [0; 32],
        }
    }

    pub const fn world(&self) -> WorldId {
        self.world
    }

    /// Successful mutations so far (the cursor's validity stamp).
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn check_world(&self, got: WorldId) -> Result<(), IndexError> {
        if got == self.world {
            Ok(())
        } else {
            Err(IndexError::WorldMismatch {
                expected: self.world,
                got,
            })
        }
    }

    fn entry(&self, s: &Stored) -> IndexEntry {
        IndexEntry {
            key: ProvinceKey::new(self.world, s.coord),
            revision: s.revision,
            state: s.state,
            observed_at: s.observed_at,
        }
    }

    /// The record of `key`, or [`Lookup::Unknown`]; a key of another world
    /// is an error, not unknown.
    pub fn lookup(&self, key: &ProvinceKey) -> Result<Lookup, IndexError> {
        self.check_world(key.world())?;
        let k = key.coord().sort_key();
        Ok(match self.entries.get(&k) {
            None => Lookup::Unknown,
            Some(s) => Lookup::Known(self.entry(s)),
        })
    }

    /// Records an unknown province at [`FIRST_REVISION`].
    pub fn insert(&mut self, e: IndexEntry) -> Result<(), IndexError> {
        self.check_world(e.key.world())?;
        if e.revision != FIRST_REVISION {
            return Err(IndexError::InvalidFirstRevision { got: e.revision });
        }
        let k = e.key.coord().sort_key();
        if self.entries.contains_key(&k) {
            return Err(IndexError::DuplicateInsert { key: e.key });
        }
        let next_epoch = self
            .epoch
            .checked_add(1)
            .ok_or(IndexError::CounterExhausted)?;
        let new_tag = entry_tag(&e);
        self.entries.insert(
            k,
            Stored {
                coord: e.key.coord(),
                revision: e.revision,
                state: e.state,
                observed_at: e.observed_at,
            },
        );
        xor_tag(&mut self.content_tag, &new_tag);
        self.epoch = next_epoch;
        Ok(())
    }

    /// Advances a known province to exactly the next revision.
    pub fn update(&mut self, e: IndexEntry) -> Result<(), IndexError> {
        self.check_world(e.key.world())?;
        let k = e.key.coord().sort_key();
        let Some(cur) = self.entries.get(&k).copied() else {
            return Err(IndexError::UnknownRecord { key: e.key });
        };
        let same = e.state == cur.state && e.observed_at == cur.observed_at;
        let expected = cur
            .revision
            .checked_add(1)
            .ok_or(IndexError::CounterExhausted)?;
        let check: Result<(), IndexError> = match e.revision.cmp(&cur.revision) {
            Ordering::Less => Err(IndexError::StaleRevision {
                current: cur.revision,
                got: e.revision,
            }),
            Ordering::Equal if same => Err(IndexError::DuplicateRevision {
                revision: e.revision,
            }),
            Ordering::Equal => Err(IndexError::ConflictingRevision {
                revision: e.revision,
            }),
            Ordering::Greater if e.revision != expected => Err(IndexError::RevisionGap {
                expected,
                got: e.revision,
            }),
            Ordering::Greater => Ok(()),
        };
        check?;
        let next_epoch = self
            .epoch
            .checked_add(1)
            .ok_or(IndexError::CounterExhausted)?;
        let old_tag = entry_tag(&self.entry(&cur));
        let new_tag = entry_tag(&e);
        self.entries.insert(
            k,
            Stored {
                coord: cur.coord,
                revision: e.revision,
                state: e.state,
                observed_at: e.observed_at,
            },
        );
        xor_tag(&mut self.content_tag, &old_tag);
        xor_tag(&mut self.content_tag, &new_tag);
        self.epoch = next_epoch;
        Ok(())
    }

    /// The first page of `window`: up to `limit` (1..=[`MAX_PAGE`]) entries
    /// in ring order from the window's first ring.
    pub fn first_page(&self, window: Window, limit: usize) -> Result<Page, IndexError> {
        self.page(window, None, limit)
    }

    /// The page after `cursor`, which must be of this world and this epoch.
    pub fn next_page(&self, cursor: &Cursor, limit: usize) -> Result<Page, IndexError> {
        if cursor.world != self.world {
            return Err(IndexError::CursorWorldMismatch {
                expected: self.world,
                got: cursor.world,
            });
        }
        if cursor.epoch != self.epoch {
            return Err(IndexError::StaleCursor {
                cursor_epoch: cursor.epoch,
                index_epoch: self.epoch,
            });
        }
        if cursor.content_tag != self.content_tag {
            return Err(IndexError::CursorSnapshotMismatch);
        }
        if WideCoord::from_sort_key(&cursor.after).is_err()
            || !cursor.window.contains_key(&cursor.after)
        {
            return Err(IndexError::MalformedCursor(CursorFault::Key));
        }
        self.page(cursor.window, Some(cursor.after), limit)
    }

    fn page(
        &self,
        window: Window,
        after: Option<[u8; SORT_KEY_LEN]>,
        limit: usize,
    ) -> Result<Page, IndexError> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(IndexError::PageLimit { got: limit });
        }
        let start = match after {
            Some(a) => Bound::Excluded(a),
            None => Bound::Included(ring_start(window.lo)),
        };
        let end = match window.hi.checked_add(1) {
            Some(next) => Bound::Excluded(ring_start(next)),
            None => Bound::Unbounded,
        };
        let mut entries = Vec::with_capacity(limit);
        let mut next = None;
        let mut last = None;
        for (k, s) in self.entries.range::<[u8; SORT_KEY_LEN], _>((start, end)) {
            if entries.len() == limit {
                // a (limit + 1)-th entry exists: hand back where to resume
                next = last.map(|after| Cursor {
                    world: self.world,
                    epoch: self.epoch,
                    window,
                    after,
                    content_tag: self.content_tag,
                });
                break;
            }
            entries.push(self.entry(s));
            last = Some(*k);
        }
        Ok(Page { entries, next })
    }

    /// The canonical bytes of the whole index: header (magic, world, epoch,
    /// count), then every entry in key order. Two indexes with the same
    /// world, epoch and records give the same bytes.
    pub fn snapshot(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(SNAPSHOT_HEADER_LEN + self.entries.len() * SNAPSHOT_ENTRY_LEN);
        out.extend_from_slice(&SNAPSHOT_MAGIC);
        out.extend_from_slice(self.world.as_bytes());
        out.extend_from_slice(&self.epoch.to_le_bytes());
        out.extend_from_slice(&(self.entries.len() as u64).to_le_bytes());
        for (k, s) in &self.entries {
            out.extend_from_slice(k);
            out.extend_from_slice(&s.revision.to_le_bytes());
            out.push(s.state.to_byte());
            out.extend_from_slice(&s.observed_at.to_le_bytes());
        }
        out
    }

    /// Inverse of [`OpenedProvinceIndex::snapshot`]. Refuses a wrong magic,
    /// a reserved world, a count that disagrees with the length, trailing
    /// bytes, any non-canonical key, keys out of order or repeated, an
    /// unknown state byte and a revision below [`FIRST_REVISION`].
    pub fn restore(bytes: &[u8]) -> Result<OpenedProvinceIndex, IndexError> {
        use IndexError::MalformedSnapshot as E;
        use SnapshotFault as F;
        if bytes.len() < SNAPSHOT_HEADER_LEN {
            return Err(E(F::Length));
        }
        if bytes[..8] != SNAPSHOT_MAGIC {
            return Err(E(F::Magic));
        }
        let mut w = [0u8; WORLD_ID_LEN];
        w.copy_from_slice(&bytes[8..8 + WORLD_ID_LEN]);
        let world = WorldId::new(w).map_err(|_| E(F::World))?;
        let s = 8 + WORLD_ID_LEN;
        let epoch = le64(&bytes[s..s + 8]);
        let count = le64(&bytes[s + 8..s + 16]);
        let body = &bytes[SNAPSHOT_HEADER_LEN..];
        if body.len() % SNAPSHOT_ENTRY_LEN != 0 {
            return Err(E(F::Length));
        }
        if count != (body.len() / SNAPSHOT_ENTRY_LEN) as u64 {
            return Err(E(F::Count));
        }
        let mut entries = BTreeMap::new();
        let mut prev: Option<[u8; SORT_KEY_LEN]> = None;
        for e in body.chunks_exact(SNAPSHOT_ENTRY_LEN) {
            let mut k = [0u8; SORT_KEY_LEN];
            k.copy_from_slice(&e[..SORT_KEY_LEN]);
            let coord = WideCoord::from_sort_key(&k).map_err(|_| E(F::Key))?;
            if prev.is_some_and(|p| p >= k) {
                return Err(E(F::Order));
            }
            let revision = le64(&e[SORT_KEY_LEN..SORT_KEY_LEN + 8]);
            if revision < FIRST_REVISION {
                return Err(E(F::Revision));
            }
            let state_byte = e[SORT_KEY_LEN + 8];
            let state = ReportedState::from_byte(state_byte).ok_or(E(F::State))?;
            let observed_at = le64(&e[SORT_KEY_LEN + 9..]);
            entries.insert(
                k,
                Stored {
                    coord,
                    revision,
                    state,
                    observed_at,
                },
            );
            prev = Some(k);
        }
        let mut index = OpenedProvinceIndex {
            world,
            epoch,
            entries,
            content_tag: [0; 32],
        };
        for stored in index.entries.values() {
            let tag = entry_tag(&index.entry(stored));
            xor_tag(&mut index.content_tag, &tag);
        }
        Ok(index)
    }
}

// Content fingerprint for accidental cursor/snapshot mixing, not authentication
// or a proof of completeness. Maintained in O(1) per mutation, O(n) on restore;
// pagination never hashes or scans the whole index.
fn entry_tag(e: &IndexEntry) -> [u8; 32] {
    permutation_rules::hash::sha256(&[
        b"PSFWIX-entry-v1",
        &e.key.to_bytes(),
        &e.revision.to_le_bytes(),
        &[e.state.to_byte()],
        &e.observed_at.to_le_bytes(),
    ])
}
fn xor_tag(out: &mut [u8; 32], tag: &[u8; 32]) {
    for (a, b) in out.iter_mut().zip(tag) {
        *a ^= b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WIDE_BOUND;
    use permutation_rules::frontier::geometry::ring_provinces;

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    fn open(w: WorldId, co: WideCoord, revision: u64, at: u64) -> IndexEntry {
        IndexEntry {
            key: ProvinceKey::new(w, co),
            revision,
            state: ReportedState::Open,
            observed_at: at,
        }
    }

    fn closed(w: WorldId, co: WideCoord, revision: u64, at: u64) -> IndexEntry {
        IndexEntry {
            state: ReportedState::Closed,
            ..open(w, co, revision, at)
        }
    }

    /// The sample world: every province of rings 0..=12 (469), two at ring
    /// 2⁴⁰ and two at the bound, in a seeded shuffle.
    fn sample() -> Vec<WideCoord> {
        let mut v: Vec<WideCoord> = Vec::new();
        for d in 0..=12u32 {
            for lp in ring_provinces(d) {
                v.push(c(lp.p as i64, lp.q as i64));
            }
        }
        v.push(c(1 << 40, 0));
        v.push(c(0, 1 << 40));
        v.push(c(WIDE_BOUND, WIDE_BOUND));
        v.push(c(-WIDE_BOUND, 0));
        let mut s = 0x2545_F491_4F6C_DD1Du64;
        for i in (1..v.len()).rev() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            v.swap(i, (s >> 33) as usize % (i + 1));
        }
        v
    }

    fn filled(w: WorldId) -> (OpenedProvinceIndex, Vec<WideCoord>) {
        let mut idx = OpenedProvinceIndex::new(w);
        let s = sample();
        for (i, co) in s.iter().enumerate() {
            idx.insert(open(w, *co, 1, i as u64)).unwrap();
        }
        (idx, s)
    }

    fn walk(idx: &OpenedProvinceIndex, window: Window, limit: usize) -> Vec<IndexEntry> {
        let mut out = Vec::new();
        let mut page = idx.first_page(window, limit).unwrap();
        loop {
            assert!(page.entries.len() <= limit);
            assert!(!page.entries.is_empty() || page.next.is_none());
            out.extend(page.entries.iter().copied());
            match page.next {
                None => return out,
                Some(cur) => {
                    assert_eq!(cur.after().unwrap(), out.last().unwrap().key.coord());
                    assert_eq!(page.entries.len(), limit, "a cursor only after a full page");
                    page = idx.next_page(&cur, limit).unwrap();
                }
            }
        }
    }

    #[test]
    fn unknown_stays_unknown_and_insert_is_once() {
        let w = world(1);
        let mut idx = OpenedProvinceIndex::new(w);
        let k = ProvinceKey::new(w, c(5, -2));
        assert_eq!(idx.lookup(&k), Ok(Lookup::Unknown));
        assert!(idx.is_empty());
        assert_eq!(idx.epoch(), 0);
        idx.insert(open(w, c(5, -2), 1, 77)).unwrap();
        assert_eq!(idx.lookup(&k), Ok(Lookup::Known(open(w, c(5, -2), 1, 77))));
        assert_eq!(idx.epoch(), 1);
        assert_eq!(
            idx.insert(open(w, c(5, -2), 1, 78)),
            Err(IndexError::DuplicateInsert { key: k })
        );
        assert_eq!(
            idx.insert(open(w, c(5, -2), 2, 78)),
            Err(IndexError::InvalidFirstRevision { got: 2 })
        );
        assert_eq!(
            idx.insert(open(w, c(6, -2), 0, 0)),
            Err(IndexError::InvalidFirstRevision { got: 0 })
        );
        assert_eq!(
            idx.insert(open(w, c(6, -2), 2, 0)),
            Err(IndexError::InvalidFirstRevision { got: 2 })
        );
        // a neighbour the index was never told about stays unknown
        assert_eq!(
            idx.lookup(&ProvinceKey::new(w, c(6, -2))),
            Ok(Lookup::Unknown)
        );
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.epoch(), 1, "refusals do not move the epoch");
    }

    #[test]
    fn revisions_advance_by_one_and_every_other_case_is_named() {
        let w = world(1);
        let mut idx = OpenedProvinceIndex::new(w);
        let co = c(-4, 1);
        let k = ProvinceKey::new(w, co);
        assert_eq!(
            idx.update(open(w, co, 2, 0)),
            Err(IndexError::UnknownRecord { key: k })
        );
        idx.insert(open(w, co, 1, 10)).unwrap();
        assert_eq!(
            idx.update(open(w, co, 1, 10)),
            Err(IndexError::DuplicateRevision { revision: 1 })
        );
        assert_eq!(
            idx.update(open(w, co, 1, 11)),
            Err(IndexError::ConflictingRevision { revision: 1 })
        );
        assert_eq!(
            idx.update(closed(w, co, 1, 10)),
            Err(IndexError::ConflictingRevision { revision: 1 })
        );
        assert_eq!(
            idx.update(open(w, co, 0, 10)),
            Err(IndexError::StaleRevision { current: 1, got: 0 })
        );
        assert_eq!(
            idx.update(open(w, co, 3, 10)),
            Err(IndexError::RevisionGap {
                expected: 2,
                got: 3,
            })
        );
        assert_eq!(
            idx.update(open(w, co, u64::MAX, 10)),
            Err(IndexError::RevisionGap {
                expected: 2,
                got: u64::MAX,
            })
        );
        assert_eq!(idx.epoch(), 1);
        idx.update(closed(w, co, 2, 20)).unwrap();
        assert_eq!(idx.epoch(), 2);
        assert_eq!(idx.lookup(&k), Ok(Lookup::Known(closed(w, co, 2, 20))));
        assert_eq!(
            idx.update(open(w, co, 1, 10)),
            Err(IndexError::StaleRevision { current: 2, got: 1 })
        );
        assert_eq!(
            idx.update(closed(w, co, 2, 20)),
            Err(IndexError::DuplicateRevision { revision: 2 })
        );
        idx.update(open(w, co, 3, 30)).unwrap();
        assert_eq!(idx.lookup(&k), Ok(Lookup::Known(open(w, co, 3, 30))));
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn closed_is_known_and_distinct_from_unknown() {
        let w = world(1);
        let mut idx = OpenedProvinceIndex::new(w);
        idx.insert(closed(w, c(2, 2), 1, 5)).unwrap();
        assert_eq!(
            idx.lookup(&ProvinceKey::new(w, c(2, 2))),
            Ok(Lookup::Known(closed(w, c(2, 2), 1, 5)))
        );
        assert_eq!(
            idx.lookup(&ProvinceKey::new(w, c(2, 3))),
            Ok(Lookup::Unknown)
        );
        // a closed province is still listed: the walk reports what was said
        let got = walk(&idx, Window::all(), 4);
        assert_eq!(got, [closed(w, c(2, 2), 1, 5)]);
        assert_ne!(Lookup::Unknown, Lookup::Known(closed(w, c(2, 2), 1, 5)));
    }

    #[test]
    fn cursor_refuses_an_equal_epoch_fork_and_restores_identical_snapshot() {
        let w = world(1);
        let mut a = OpenedProvinceIndex::new(w);
        a.insert(open(w, c(0, 0), 1, 0)).unwrap();
        a.insert(open(w, c(1, 0), 1, 0)).unwrap();
        let cursor = a.first_page(Window::all(), 1).unwrap().next.unwrap();
        let mut b = OpenedProvinceIndex::new(w);
        b.insert(open(w, c(0, 0), 1, 0)).unwrap();
        b.insert(open(w, c(2, 0), 1, 0)).unwrap();
        assert_eq!(a.epoch(), b.epoch());
        assert_eq!(
            b.next_page(&cursor, 1),
            Err(IndexError::CursorSnapshotMismatch)
        );
        let restored = OpenedProvinceIndex::restore(&a.snapshot()).unwrap();
        assert_eq!(restored.next_page(&cursor, 1), a.next_page(&cursor, 1));
    }

    #[test]
    fn exhausted_counters_never_wrap_or_partially_mutate() {
        let w = world(1);
        let mut a = OpenedProvinceIndex::new(w);
        a.insert(open(w, c(0, 0), 1, 0)).unwrap();
        a.epoch = u64::MAX;
        let mut a = OpenedProvinceIndex::restore(&a.snapshot()).unwrap();
        let before = a.snapshot();
        assert_eq!(
            a.insert(open(w, c(1, 0), 1, 0)),
            Err(IndexError::CounterExhausted)
        );
        assert_eq!(
            a.update(open(w, c(0, 0), 2, 1)),
            Err(IndexError::CounterExhausted)
        );
        assert_eq!(a.snapshot(), before);
        a.epoch = 1;
        a.entries.get_mut(&c(0, 0).sort_key()).unwrap().revision = u64::MAX;
        let mut a = OpenedProvinceIndex::restore(&a.snapshot()).unwrap();
        let before = a.snapshot();
        assert_eq!(
            a.update(open(w, c(0, 0), u64::MAX, 1)),
            Err(IndexError::CounterExhausted)
        );
        assert_eq!(a.snapshot(), before);
    }

    #[test]
    fn other_worlds_are_refused_everywhere() {
        let (a, b) = (world(1), world(2));
        let mut idx = OpenedProvinceIndex::new(a);
        let mismatch = Err(IndexError::WorldMismatch {
            expected: a,
            got: b,
        });
        assert_eq!(idx.insert(open(b, c(1, 0), 1, 0)), mismatch);
        assert_eq!(idx.update(open(b, c(1, 0), 2, 0)), mismatch);
        assert_eq!(
            idx.lookup(&ProvinceKey::new(b, c(1, 0))).err(),
            mismatch.err()
        );
        idx.insert(open(a, c(1, 0), 1, 0)).unwrap();
        assert_eq!(
            idx.lookup(&ProvinceKey::new(b, c(1, 0))).err(),
            mismatch.err()
        );
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.epoch(), 1);
        // a cursor of the other world
        let (other, _) = filled(b);
        let cur = other.first_page(Window::all(), 1).unwrap().next.unwrap();
        assert_eq!(
            idx.next_page(&cur, 1),
            Err(IndexError::CursorWorldMismatch {
                expected: a,
                got: b,
            })
        );
    }

    #[test]
    fn pages_are_bounded_ordered_and_complete_whatever_the_insertion_order() {
        let w = world(3);
        let (idx, s) = filled(w);
        assert_eq!(idx.len(), s.len());
        let mut expect: Vec<WideCoord> = s.clone();
        expect.sort();
        for limit in [1usize, 2, 7, 64, 256] {
            let got = walk(&idx, Window::all(), limit);
            let coords: Vec<WideCoord> = got.iter().map(|e| e.key.coord()).collect();
            assert_eq!(coords, expect, "limit {limit}");
            assert!(got.iter().all(|e| e.key.world() == w && e.revision == 1));
            // observed_at is returned as given (the insertion position)
            for e in &got {
                let i = s.iter().position(|x| *x == e.key.coord()).unwrap();
                assert_eq!(e.observed_at, i as u64);
            }
        }
        // a second index with another insertion order walks identically
        let mut rev = OpenedProvinceIndex::new(w);
        for (i, co) in s.iter().enumerate().rev() {
            rev.insert(open(w, *co, 1, i as u64)).unwrap();
        }
        assert_eq!(walk(&rev, Window::all(), 5), walk(&idx, Window::all(), 5));
        assert_eq!(rev.snapshot(), idx.snapshot());
        // limits
        for bad in [0usize, MAX_PAGE + 1, usize::MAX] {
            assert_eq!(
                idx.first_page(Window::all(), bad),
                Err(IndexError::PageLimit { got: bad })
            );
        }
        let cur = idx.first_page(Window::all(), 3).unwrap().next.unwrap();
        assert_eq!(
            idx.next_page(&cur, 0),
            Err(IndexError::PageLimit { got: 0 })
        );
    }

    #[test]
    fn ring_windows_select_without_enumerating_the_disk() {
        let w = world(3);
        let (idx, _) = filled(w);
        // rings 3..=5: exactly 18 + 24 + 30 entries, in ring order
        let got = walk(&idx, Window::rings(3, 5).unwrap(), 10);
        assert_eq!(got.len(), 72);
        assert!(got.iter().all(|e| (3..=5).contains(&e.key.coord().ring())));
        assert!(got.windows(2).all(|p| p[0].key < p[1].key));
        // a single ring
        let got = walk(&idx, Window::ring(0), 1);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].key.coord(), WideCoord::CONCORD);
        let got = walk(&idx, Window::ring(12), 256);
        assert_eq!(got.len(), 72);
        // an empty ring in the middle of nowhere: an empty page, no cursor
        let nowhere = Window::rings(13, 1 << 39).unwrap();
        let page = idx.first_page(nowhere, 5).unwrap();
        assert!(page.entries.is_empty() && page.next.is_none());
        // the far entries, each found by its own window
        let got = walk(&idx, Window::ring(1 << 40), 1);
        assert_eq!(
            got.iter().map(|e| e.key.coord()).collect::<Vec<_>>(),
            [c(1 << 40, 0), c(0, 1 << 40)]
        );
        let got = walk(&idx, Window::rings(1 << 41, u64::MAX).unwrap(), 2);
        assert_eq!(
            got.iter().map(|e| e.key.coord()).collect::<Vec<_>>(),
            [c(-WIDE_BOUND, 0), c(WIDE_BOUND, WIDE_BOUND)]
        );
        // the window whose upper bound is the last ring is not an error
        let got = walk(&idx, Window::rings(1 << 63, u64::MAX).unwrap(), 2);
        assert_eq!(got.len(), 1);
        assert_eq!(
            Window::rings(5, 4),
            Err(IndexError::EmptyWindow { lo: 5, hi: 4 })
        );
        assert_eq!(Window::all().lo(), 0);
        assert_eq!(Window::all().hi(), u64::MAX);
    }

    #[test]
    fn a_cursor_dies_with_the_first_mutation() {
        let w = world(4);
        let (mut idx, _) = filled(w);
        let page = idx.first_page(Window::all(), 10).unwrap();
        let cur = page.next.unwrap();
        assert_eq!(cur.epoch(), idx.epoch());
        assert_eq!(cur.world(), w);
        assert_eq!(cur.window(), Window::all());
        // still valid while nothing changes
        let again = idx.next_page(&cur, 10).unwrap();
        assert_eq!(again, idx.next_page(&cur, 10).unwrap());
        // a refused mutation does not invalidate it
        assert!(idx.insert(open(w, c(0, 0), 1, 0)).is_err());
        assert!(idx.next_page(&cur, 10).is_ok());
        // a successful one does
        let e0 = idx.epoch();
        idx.update(closed(w, c(0, 0), 2, 1)).unwrap();
        assert_eq!(
            idx.next_page(&cur, 10),
            Err(IndexError::StaleCursor {
                cursor_epoch: e0,
                index_epoch: e0 + 1,
            })
        );
        // and a fresh first page sees the change
        let fresh = idx.first_page(Window::ring(0), 1).unwrap();
        assert_eq!(fresh.entries[0].state, ReportedState::Closed);
        assert_eq!(fresh.entries[0].revision, 2);
    }

    #[test]
    fn cursor_bytes_round_trip_and_malformed_ones_are_refused() {
        let w = world(4);
        let (idx, _) = filled(w);
        let cur = idx
            .first_page(Window::rings(2, 9).unwrap(), 4)
            .unwrap()
            .next
            .unwrap();
        let b = cur.to_bytes();
        assert_eq!(b.len(), CURSOR_LEN);
        assert_eq!(Cursor::from_bytes(&b), Ok(cur));
        let back = Cursor::from_bytes(&b).unwrap();
        assert_eq!(idx.next_page(&back, 4), idx.next_page(&cur, 4));
        use CursorFault as F;
        use IndexError::MalformedCursor as E;
        assert_eq!(Cursor::from_bytes(&b[..CURSOR_LEN - 1]), Err(E(F::Length)));
        let mut long = b.to_vec();
        long.push(0);
        assert_eq!(Cursor::from_bytes(&long), Err(E(F::Length)));
        let mut v = b;
        v[0] = 9;
        assert_eq!(Cursor::from_bytes(&v), Err(E(F::Version)));
        let mut z = b;
        z[1..33].fill(0);
        assert_eq!(Cursor::from_bytes(&z), Err(E(F::World)));
        // lo > hi
        let mut win = b;
        win[41..49].copy_from_slice(&10u64.to_le_bytes()); // lo = 10 > hi = 9
        assert_eq!(Cursor::from_bytes(&win), Err(E(F::Window)));
        // a non-canonical last key (wedge 6)
        let mut nc = b;
        nc[57 + 8] = 6;
        assert_eq!(Cursor::from_bytes(&nc), Err(E(F::Key)));
        // a canonical last key outside the window (ring 1 < lo 2)
        let mut out = b;
        out[57..57 + SORT_KEY_LEN].copy_from_slice(&c(1, 0).sort_key());
        assert_eq!(Cursor::from_bytes(&out), Err(E(F::Key)));
        // a cursor stamped with another epoch, bytes otherwise valid
        let mut ep = b;
        ep[33..41].copy_from_slice(&(idx.epoch() + 1).to_le_bytes());
        let stale = Cursor::from_bytes(&ep).unwrap();
        assert_eq!(
            idx.next_page(&stale, 4),
            Err(IndexError::StaleCursor {
                cursor_epoch: idx.epoch() + 1,
                index_epoch: idx.epoch(),
            })
        );
        // a cursor of another world, bytes valid
        let mut ow = b;
        ow[1..33].copy_from_slice(world(5).as_bytes());
        let other = Cursor::from_bytes(&ow).unwrap();
        assert_eq!(
            idx.next_page(&other, 4),
            Err(IndexError::CursorWorldMismatch {
                expected: w,
                got: world(5),
            })
        );
    }

    #[test]
    fn snapshots_restore_exactly_and_refuse_tampering() {
        let w = world(6);
        let (mut idx, _) = filled(w);
        idx.update(closed(w, c(3, 0), 2, 999)).unwrap();
        let bytes = idx.snapshot();
        assert_eq!(
            bytes.len(),
            SNAPSHOT_HEADER_LEN + idx.len() * SNAPSHOT_ENTRY_LEN
        );
        let back = OpenedProvinceIndex::restore(&bytes).unwrap();
        assert_eq!(back, idx);
        assert_eq!(back.world(), w);
        assert_eq!(back.epoch(), idx.epoch());
        assert_eq!(back.len(), idx.len());
        assert_eq!(back.snapshot(), bytes, "re-snapshot is the identity");
        assert_eq!(walk(&back, Window::all(), 9), walk(&idx, Window::all(), 9));
        assert_eq!(
            back.lookup(&ProvinceKey::new(w, c(3, 0))),
            Ok(Lookup::Known(closed(w, c(3, 0), 2, 999)))
        );
        // a cursor issued before the snapshot resumes on the restored copy
        let cur = idx.first_page(Window::all(), 8).unwrap().next.unwrap();
        assert_eq!(back.next_page(&cur, 8), idx.next_page(&cur, 8));
        // the empty index
        let empty = OpenedProvinceIndex::new(w);
        let eb = empty.snapshot();
        assert_eq!(eb.len(), SNAPSHOT_HEADER_LEN);
        assert_eq!(OpenedProvinceIndex::restore(&eb), Ok(empty));

        use IndexError::MalformedSnapshot as E;
        use SnapshotFault as F;
        let h = SNAPSHOT_HEADER_LEN;
        let n = SNAPSHOT_ENTRY_LEN;
        let hdr = &bytes[..h - 1];
        assert_eq!(OpenedProvinceIndex::restore(hdr), Err(E(F::Length)));
        let ent = &bytes[..h + n - 1];
        assert_eq!(OpenedProvinceIndex::restore(ent), Err(E(F::Length)));
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(OpenedProvinceIndex::restore(&trailing), Err(E(F::Length)));
        let mut magic = bytes.clone();
        magic[0] ^= 1;
        assert_eq!(OpenedProvinceIndex::restore(&magic), Err(E(F::Magic)));
        let mut zero = bytes.clone();
        zero[8..40].fill(0);
        assert_eq!(OpenedProvinceIndex::restore(&zero), Err(E(F::World)));
        // one entry fewer than the count says
        let one_fewer = &bytes[..bytes.len() - n];
        assert_eq!(OpenedProvinceIndex::restore(one_fewer), Err(E(F::Count)));
        let mut count = bytes.clone();
        count[48..56].copy_from_slice(&0u64.to_le_bytes());
        assert_eq!(OpenedProvinceIndex::restore(&count), Err(E(F::Count)));
        // two entries swapped
        let mut swapped = bytes.clone();
        let (a, b) = (h, h + n);
        let first: Vec<u8> = swapped[a..a + n].to_vec();
        let second: Vec<u8> = swapped[b..b + n].to_vec();
        swapped[a..a + n].copy_from_slice(&second);
        swapped[b..b + n].copy_from_slice(&first);
        assert_eq!(OpenedProvinceIndex::restore(&swapped), Err(E(F::Order)));
        // an entry repeated
        let mut dup = bytes.clone();
        dup[b..b + n].copy_from_slice(&first);
        assert_eq!(OpenedProvinceIndex::restore(&dup), Err(E(F::Order)));
        // a non-canonical key (wedge 6 on the second entry, ring 1)
        let mut nc = bytes.clone();
        nc[b + 8] = 6;
        assert_eq!(OpenedProvinceIndex::restore(&nc), Err(E(F::Key)));
        // state byte 0 (a zeroed buffer) and 3
        for s in [0u8, 3, 255] {
            let mut st = bytes.clone();
            st[a + SORT_KEY_LEN + 8] = s;
            assert_eq!(OpenedProvinceIndex::restore(&st), Err(E(F::State)), "{s}");
        }
        // revision 0
        let mut rev = bytes.clone();
        rev[a + SORT_KEY_LEN..a + SORT_KEY_LEN + 8].copy_from_slice(&0u64.to_le_bytes());
        assert_eq!(OpenedProvinceIndex::restore(&rev), Err(E(F::Revision)));
        // a restored index keeps refusing like the original
        let back = OpenedProvinceIndex::restore(&bytes).unwrap();
        assert_eq!(
            back.lookup(&ProvinceKey::new(world(7), c(0, 0))),
            Err(IndexError::WorldMismatch {
                expected: w,
                got: world(7),
            })
        );
    }

    #[test]
    fn page_entries_keep_their_world_and_canonical_keys() {
        let w = world(8);
        let (idx, _) = filled(w);
        for e in walk(&idx, Window::all(), 50) {
            let b = e.key.to_bytes();
            assert_eq!(ProvinceKey::from_bytes(&b), Ok(e.key));
            assert_eq!(e.key.world(), w);
        }
    }
}
