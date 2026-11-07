//! The recorded wide world (experimental, read-only; cargo feature
//! `wide-world-experimental`, which turns on `frontier-abi`'s
//! `world-index-experimental`): the Provinces the fold has **captured**,
//! presented through the lossless legacy adapter as world-scoped wide
//! coordinates, in bounded pages.
//!
//! | path | answer | cache |
//! |---|---|---|
//! | `/h/world/wide` | the manifest: world namespace, snapshot identity, counts | `max-age=5` |
//! | `/h/world/wide/page?limit=&after=` | one page of recorded Provinces in ring order | `max-age=5` |
//!
//! **What it is.** The same captured Province accounts `/h/world/ring/{d}`
//! lists, keyed by `(world, P, Q)` with P and Q as decimal strings
//! (lossless in any JSON reader; a browser must not pass them through
//! `Number`). The world is `WorldId::derive_legacy_season(season PDA,
//! program)`: public bytes only, so a page can recompute it.
//!
//! **What it is not.** Not a proof of completeness (a Province the fold
//! never captured is *unknown*: neither closed nor open), not new land
//! (every entry is a captured legacy record within ring `R_MAX_HARD`;
//! nothing past the season's map is invented), and not a trust root (the
//! raw bytes stay at `/h/province/{P},{Q}/latest`).
//!
//! **Cost.** The index is kept beside `Fold::provinces` and moves only when
//! a Province is first captured or closed (`Fold::index_account` /
//! `unindex_account`): a Province's bytes changing every bell does not
//! touch it, so a cursor outlives ordinary polling. A page is a bounded
//! `range` walk (at most `limit + 1` entries) plus one map lookup per
//! entry; the snapshot stamp is folded per mutation, never recomputed over
//! the index. A restart rebuilds the index from the checkpointed captures
//! in account order, which gives another stamp: a page reader starts over.
//!
//! Without the feature the routes answer `503 WideWorldUnavailable`
//! (`server.rs`), never a dense fallback.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::{
    Cursor, IndexEntry, IndexError, LegacyAdapter, Lookup, OpenedProvinceIndex, Page, ProvinceKey,
    ReportedState, WideCoord, Window, WorldId, FIRST_REVISION, MAX_PAGE,
};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};

use crate::fold::Fold;

/// Entries per page when the query names none.
pub const DEFAULT_LIMIT: usize = 64;
/// Domain of the snapshot stamp.
pub const STAMP_DOMAIN: &[u8] = b"PSF-WIDE-STAMP-v1";
/// The manifest's `worldDomain` (how `world` was derived).
pub const WORLD_DOMAIN: &str = "PSF-WORLD-v1/legacy-season";

/// The fold's wide index: what the fold captured, as the world index holds it.
pub struct WideIndex {
    adapter: LegacyAdapter,
    index: OpenedProvinceIndex,
    /// Folded over every successful mutation (the snapshot identity beside
    /// the epoch); never recomputed over the index.
    stamp: [u8; 32],
    /// Reports the index refused (counted and shown, never patched).
    refused: u64,
}

impl WideIndex {
    /// The index of the season `ctx` names (`None` only if the derived
    /// namespace were the reserved zero id).
    pub fn for_ctx(ctx: &AddrCtx) -> Option<WideIndex> {
        let adapter = LegacyAdapter::for_season(ctx).ok()?;
        Some(WideIndex {
            adapter,
            index: OpenedProvinceIndex::new(adapter.world()),
            stamp: [0; 32],
            refused: 0,
        })
    }

    pub fn world(&self) -> WorldId {
        self.adapter.world()
    }

    pub fn epoch(&self) -> u64 {
        self.index.epoch()
    }

    pub fn stamp(&self) -> [u8; 32] {
        self.stamp
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    pub fn refused(&self) -> u64 {
        self.refused
    }

    pub fn key(&self, p: i16, q: i16) -> ProvinceKey {
        self.adapter.key_of(ProvinceCoord::new(p as i32, q as i32))
    }

    /// The record of `(p, q)`, or `Unknown`.
    pub fn lookup(&self, p: i16, q: i16) -> Lookup {
        self.index
            .lookup(&self.key(p, q))
            .unwrap_or(Lookup::Unknown)
    }

    /// A Province capture: reported open from `opened_bell` (a stable
    /// ordinal, so a re-capture of the same Province is a no-op).
    pub fn observe_open(&mut self, p: i16, q: i16, opened_bell: u32) {
        self.report(p, q, ReportedState::Open, opened_bell as u64);
    }

    /// A Province account closed at slot `at`.
    pub fn observe_closed(&mut self, p: i16, q: i16, at: u64) {
        self.report(p, q, ReportedState::Closed, at);
    }

    fn report(&mut self, p: i16, q: i16, state: ReportedState, observed_at: u64) {
        let key = self.key(p, q);
        let (fresh, next) = match self.index.lookup(&key) {
            Ok(Lookup::Unknown) => (
                true,
                IndexEntry {
                    key,
                    revision: FIRST_REVISION,
                    state,
                    observed_at,
                },
            ),
            Ok(Lookup::Known(e)) if e.state == state && e.observed_at == observed_at => return,
            Ok(Lookup::Known(e)) => (
                false,
                IndexEntry {
                    key,
                    revision: e.revision.saturating_add(1),
                    state,
                    observed_at,
                },
            ),
            Err(_) => {
                self.refused += 1;
                return;
            }
        };
        let r = if fresh {
            self.index.insert(next)
        } else {
            self.index.update(next)
        };
        match r {
            Ok(()) => self.restamp(&next),
            Err(_) => self.refused += 1,
        }
    }

    fn restamp(&mut self, e: &IndexEntry) {
        let mut h = Sha256::new();
        h.update(STAMP_DOMAIN);
        h.update(self.stamp);
        h.update(e.key.to_bytes());
        h.update(e.revision.to_le_bytes());
        h.update([state_byte(e.state)]);
        h.update(e.observed_at.to_le_bytes());
        self.stamp = h.finalize().into();
    }

    pub fn first_page(&self, limit: usize) -> Result<Page, IndexError> {
        self.index.first_page(Window::all(), limit)
    }

    pub fn next_page(&self, cursor: &Cursor, limit: usize) -> Result<Page, IndexError> {
        self.index.next_page(cursor, limit)
    }
}

fn state_byte(s: ReportedState) -> u8 {
    match s {
        ReportedState::Open => 1,
        ReportedState::Closed => 2,
    }
}

fn state_text(s: ReportedState) -> &'static str {
    match s {
        ReportedState::Open => "open",
        ReportedState::Closed => "closed",
    }
}

/// Why an answer is refused (each with its HTTP status and `code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideFault {
    /// The Season is not captured yet (or the index could not be derived).
    NoSeasonYet,
    /// `limit` is not 1..=256.
    BadLimit,
    /// `after` is not the hex of a cursor of this world's layout.
    BadCursor,
    /// A cursor of another world.
    WorldMismatch,
    /// A cursor of an earlier snapshot (the index moved since).
    StaleSnapshot,
}

impl WideFault {
    pub fn code(self) -> &'static str {
        match self {
            WideFault::NoSeasonYet => "NoSeasonYet",
            WideFault::BadLimit => "BadLimit",
            WideFault::BadCursor => "BadCursor",
            WideFault::WorldMismatch => "WorldMismatch",
            WideFault::StaleSnapshot => "StaleSnapshot",
        }
    }

    pub fn status(self) -> u16 {
        match self {
            WideFault::NoSeasonYet => 503,
            WideFault::BadLimit | WideFault::BadCursor => 400,
            WideFault::WorldMismatch | WideFault::StaleSnapshot => 409,
        }
    }
}

/// A wide coordinate as the answers carry it: decimal strings (never a JSON
/// number, which a browser would read as a double).
pub fn coord_json(c: WideCoord) -> Value {
    let rp = c.ring_position();
    json!({
        "p": c.p().to_string(),
        "q": c.q().to_string(),
        "ring": rp.ring.to_string(),
        "wedge": rp.wedge,
        "pos": rp.pos.to_string(),
    })
}

/// The cursor as the answers carry it (hex of its canonical bytes).
pub fn cursor_text(c: &Cursor) -> String {
    hex::encode(c.to_bytes())
}

fn parse_cursor(s: &str) -> Result<Cursor, WideFault> {
    if s.len() != frontier_abi::world_index::index::CURSOR_LEN * 2 {
        return Err(WideFault::BadCursor);
    }
    let bytes = hex::decode(s).map_err(|_| WideFault::BadCursor)?;
    Cursor::from_bytes(&bytes).map_err(|_| WideFault::BadCursor)
}

fn wide_of(f: &Fold) -> Result<&WideIndex, WideFault> {
    f.season.as_ref().ok_or(WideFault::NoSeasonYet)?;
    f.wide.as_ref().ok_or(WideFault::NoSeasonYet)
}

fn snapshot_json(f: &Fold, w: &WideIndex) -> Value {
    json!({
        "epoch": w.epoch().to_string(),
        "stamp": hex::encode(w.stamp()),
        "foldedThrough": f.st.folded_through.to_string(),
        "lastSlot": f.st.last_slot.to_string(),
    })
}

/// `GET /h/world/wide`: the manifest.
pub fn manifest_json(f: &Fold) -> Result<Value, WideFault> {
    let w = wide_of(f)?;
    Ok(json!({
        "v": 1,
        "experimental": true,
        "readOnly": true,
        // every entry is a captured record; absence is unknown, not open and not closed
        "completeness": "captured",
        "world": hex::encode(w.world().as_bytes()),
        "worldDomain": WORLD_DOMAIN,
        "season": f.cfg.season_id.to_string(),
        "program": f.cfg.program.to_string(),
        "seasonAddress": Address::new_from_array(f.season_address()).to_string(),
        "snapshot": snapshot_json(f, w),
        "recorded": w.len(),
        "refused": w.refused(),
        "legacy": {
            "rMax": crate::world::r_max(f),
            "rMaxHard": R_MAX_HARD,
            "ringsOpened": crate::world::rings_opened(f),
            "provinces": f.provinces.len(),
        },
        "page": {
            "path": "/h/world/wide/page",
            "max": MAX_PAGE,
            "default": DEFAULT_LIMIT,
        },
        "coords": "P,Q as decimal strings: axial coordinates on the province lattice (as /h/world ids.province); ring = hex distance from (0,0); |P|,|Q| ≤ 2^62",
    }))
}

/// The legacy identity of an entry: its captured `ProvMeta` and capture
/// slot (null for a closed Province or one past the legacy disk).
fn legacy_json(f: &Fold, w: &WideIndex, e: &IndexEntry) -> Value {
    let Ok(c) = w.adapter.coord_of(&e.key) else {
        return Value::Null;
    };
    let (Ok(p), Ok(q)) = (i16::try_from(c.p), i16::try_from(c.q)) else {
        return Value::Null;
    };
    let Some(m) = f.provinces.get(&(p, q)) else {
        return Value::Null;
    };
    json!({
        "p": p,
        "q": q,
        "index": w.adapter.dense_index_of(&e.key).ok(),
        "ring": m.ring,
        "region": m.region,
        "openedBell": m.first,
        "slot": f.account(&m.addr).map(|c| c.slot),
        "address": Address::new_from_array(m.addr).to_string(),
    })
}

fn entry_json(f: &Fold, w: &WideIndex, e: &IndexEntry) -> Value {
    let mut v = coord_json(e.key.coord());
    v["state"] = json!(state_text(e.state));
    v["revision"] = json!(e.revision.to_string());
    v["observedAt"] = json!(e.observed_at.to_string());
    v["legacy"] = legacy_json(f, w, e);
    v
}

/// `GET /h/world/wide/page?limit={1..=256}&after={cursor hex}`: one page in
/// ring order, bounded by `limit`.
pub fn page_json(f: &Fold, after: Option<&str>, limit: Option<usize>) -> Result<Value, WideFault> {
    let w = wide_of(f)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    if limit == 0 || limit > MAX_PAGE {
        return Err(WideFault::BadLimit);
    }
    let page = match after {
        None => w.first_page(limit),
        Some(s) => w.next_page(&parse_cursor(s)?, limit),
    }
    .map_err(|e| match e {
        IndexError::CursorWorldMismatch { .. } => WideFault::WorldMismatch,
        IndexError::StaleCursor { .. } | IndexError::CursorSnapshotMismatch => {
            WideFault::StaleSnapshot
        }
        IndexError::PageLimit { .. } => WideFault::BadLimit,
        _ => WideFault::BadCursor,
    })?;
    Ok(json!({
        "v": 1,
        "world": hex::encode(w.world().as_bytes()),
        "snapshot": { "epoch": w.epoch().to_string(), "stamp": hex::encode(w.stamp()) },
        "after": after,
        "limit": limit,
        "entries": page.entries.iter().map(|e| entry_json(f, w, e)).collect::<Vec<_>>(),
        "next": page.next.as_ref().map(cursor_text),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::world_index::WIDE_BOUND;

    fn ctx(b: u8) -> AddrCtx {
        AddrCtx {
            season: [b; 32],
            program: [0x5E; 32],
        }
    }

    fn coords(p: &Page) -> Vec<(i64, i64)> {
        p.entries
            .iter()
            .map(|e| (e.key.coord().p(), e.key.coord().q()))
            .collect()
    }

    #[test]
    fn the_world_is_the_public_season_namespace() {
        let w = WideIndex::for_ctx(&ctx(3)).unwrap();
        assert_eq!(
            w.world(),
            WorldId::derive_legacy_season(&[3; 32], &[0x5E; 32]).unwrap()
        );
        assert_ne!(w.world(), WideIndex::for_ctx(&ctx(4)).unwrap().world());
        assert!(w.is_empty());
        assert_eq!(w.epoch(), 0);
        assert_eq!(w.stamp(), [0; 32]);
    }

    #[test]
    fn a_recapture_moves_nothing_and_a_close_is_a_revision() {
        let mut w = WideIndex::for_ctx(&ctx(1)).unwrap();
        w.observe_open(2, 0, 0);
        let (e1, s1) = (w.epoch(), w.stamp());
        assert_eq!(e1, 1);
        assert_ne!(s1, [0; 32]);
        // the Province's bytes change every bell: the same report is a no-op
        w.observe_open(2, 0, 0);
        w.observe_open(2, 0, 0);
        assert_eq!((w.epoch(), w.stamp()), (e1, s1));
        assert_eq!(w.refused(), 0);
        // closed is revision 2, reopened revision 3; each a new stamp
        w.observe_closed(2, 0, 77);
        let Lookup::Known(c) = w.lookup(2, 0) else {
            panic!("known")
        };
        assert_eq!(
            (c.revision, c.state, c.observed_at),
            (2, ReportedState::Closed, 77)
        );
        assert_eq!(w.epoch(), 2);
        assert_ne!(w.stamp(), s1);
        w.observe_open(2, 0, 5);
        let Lookup::Known(o) = w.lookup(2, 0) else {
            panic!("known")
        };
        assert_eq!(
            (o.revision, o.state, o.observed_at),
            (3, ReportedState::Open, 5)
        );
        // a neighbour never reported stays unknown (not closed)
        assert_eq!(w.lookup(3, 0), Lookup::Unknown);
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn pages_are_ring_ordered_bounded_and_cursors_die_with_a_mutation() {
        let mut w = WideIndex::for_ctx(&ctx(1)).unwrap();
        for (p, q) in [(3, 0), (0, 2), (1, 1), (2, 0), (0, 0)] {
            w.observe_open(p, q, 0);
        }
        let p1 = w.first_page(2).unwrap();
        assert_eq!(coords(&p1), [(0, 0), (2, 0)]);
        let c1 = p1.next.expect("a cursor after a full page");
        let p2 = w.next_page(&c1, 2).unwrap();
        assert_eq!(coords(&p2), [(1, 1), (0, 2)]);
        let p3 = w.next_page(&p2.next.unwrap(), 2).unwrap();
        assert_eq!(coords(&p3), [(3, 0)]);
        assert!(p3.next.is_none());
        // the cursor's hex round-trips
        let back = parse_cursor(&cursor_text(&c1)).unwrap();
        assert_eq!(back, c1);
        assert_eq!(parse_cursor("zz"), Err(WideFault::BadCursor));
        assert_eq!(parse_cursor(""), Err(WideFault::BadCursor));
        // a new capture: the old cursor is refused
        w.observe_open(4, 0, 9);
        assert!(matches!(
            w.next_page(&c1, 2),
            Err(IndexError::StaleCursor { .. })
        ));
        // a cursor of another season's world is refused by name
        let mut other = WideIndex::for_ctx(&ctx(2)).unwrap();
        other.observe_open(0, 0, 0);
        other.observe_open(2, 0, 0);
        let oc = other.first_page(1).unwrap().next.unwrap();
        assert!(matches!(
            w.next_page(&oc, 1),
            Err(IndexError::CursorWorldMismatch { .. })
        ));
        for bad in [0usize, MAX_PAGE + 1] {
            assert!(matches!(
                w.first_page(bad),
                Err(IndexError::PageLimit { .. })
            ));
        }
    }

    #[test]
    fn coordinates_are_decimal_strings_beyond_any_double() {
        let far = WideCoord::checked(WIDE_BOUND, -1).unwrap();
        let v = coord_json(far);
        assert_eq!(v["p"], json!("4611686018427387904"));
        assert_eq!(v["q"], json!("-1"));
        // the ring of (2^62, −1) is 2^62: |p| + |q| + |p + q| = 2^62 + 1 + 2^62 − 1
        assert_eq!(v["ring"], json!("4611686018427387904"));
        assert!(v["p"].is_string() && v["ring"].is_string() && v["pos"].is_string());
        let near = WideCoord::checked((1i64 << 53) + 1, 0).unwrap();
        assert_eq!(coord_json(near)["p"], json!("9007199254740993"));
        // a legacy coordinate keeps its exact pair and position
        let two = coord_json(WideCoord::checked(1, 1).unwrap());
        assert_eq!(two["ring"], json!("2"));
        assert_eq!(two["wedge"], json!(0));
        assert_eq!(two["pos"], json!("1"));
        let text = serde_json::to_string(&coord_json(far)).unwrap();
        assert!(text.contains("\"p\":\"4611686018427387904\""));
    }

    #[test]
    fn faults_carry_their_status_and_code() {
        assert_eq!(WideFault::NoSeasonYet.status(), 503);
        assert_eq!(WideFault::BadLimit.status(), 400);
        assert_eq!(WideFault::BadCursor.status(), 400);
        assert_eq!(WideFault::WorldMismatch.status(), 409);
        assert_eq!(WideFault::StaleSnapshot.status(), 409);
        assert_eq!(WideFault::StaleSnapshot.code(), "StaleSnapshot");
    }
}
