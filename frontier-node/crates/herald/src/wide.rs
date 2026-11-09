//! The recorded wide world (experimental, read-only; cargo feature
//! `wide-world-experimental`, which turns on `frontier-abi`'s
//! `world-index-experimental`): the Provinces the fold has **captured**,
//! presented as world-scoped wide coordinates, in bounded pages. Legacy
//! accounts use the lossless adapter; authenticated experimental wide
//! Province/Holding accounts use their full trailer identity.
//!
//! | path | answer | cache |
//! |---|---|---|
//! | `/h/world/wide` | the manifest: world namespace, snapshot identity, counts | `max-age=5` |
//! | `/h/world/wide/page?limit=&after=` | one page of recorded Provinces in ring order | `max-age=5` |
//!
//! **What it is.** The same captured Province accounts `/h/world/ring/{d}`
//! lists, plus captured experimental wide Province accounts, keyed by
//! `(world, P, Q)` with P and Q as decimal strings
//! (lossless in any JSON reader; a browser must not pass them through
//! `Number`). The world is `WorldId::derive_legacy_season(season PDA,
//! program)`: public bytes only, so a page can recompute it.
//!
//! **What it is not.** Not a proof of completeness (a Province the fold
//! never captured is *unknown*: neither closed nor open), not new land
//! (every entry is backed by a capture, never generated terrain), and not
//! a trust root. Wide entries include raw capture bytes and an explicit
//! `captured-unverified` label; PSW1 event replay is not implemented here.
//!
//! **Cost.** The index is kept beside `Fold::provinces` and moves only when
//! a legacy Province is first captured or closed (`Fold::index_account` /
//! `unindex_account`): a Province's bytes changing every bell does not
//! touch it, so a cursor outlives ordinary polling. Wide account changes
//! also revise their province entry so its holdings and displayed capture
//! stay in the same snapshot. A page is a bounded
//! `range` walk (at most `limit + 1` entries) plus one map lookup per
//! entry; the snapshot stamp is folded per mutation, never recomputed over
//! the index. A restart rebuilds the index from the checkpointed captures
//! in account order, which gives another stamp: a page reader starts over.
//!
//! Without the feature the routes answer `503 WideWorldUnavailable`
//! (`server.rs`), never a dense fallback.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::{
    Cursor, IndexEntry, IndexError, LegacyAdapter, Lookup, OpenedProvinceIndex, Page, ProvinceKey,
    ReportedState, WideCoord, Window, WorldId, FIRST_REVISION, MAX_PAGE,
};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};

use crate::fold::{Capture, Fold};
use fclient::ports::{Account, TxRecord};
use frontier_abi::world_index::{holding, land};

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
    provinces: BTreeMap<WideCoord, [u8; 32]>,
    holdings: BTreeMap<(WideCoord, u8), [u8; 32]>,
    // Derived from authenticated capture bytes only, not ownership authority.
    inventory: BTreeMap<([u8; 32], u8), BTreeSet<[u8; 32]>>,
    inventory_of: BTreeMap<[u8; 32], ([u8; 32], u8)>,
    #[cfg(test)]
    inventory_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    inventory_serializations: std::sync::atomic::AtomicUsize,
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
            provinces: BTreeMap::new(),
            holdings: BTreeMap::new(),
            inventory: BTreeMap::new(),
            inventory_of: BTreeMap::new(),
            #[cfg(test)]
            inventory_reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            inventory_serializations: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn remove_inventory(&mut self, key: &[u8; 32]) {
        if let Some(binding) = self.inventory_of.remove(key) {
            if let Some(keys) = self.inventory.get_mut(&binding) {
                keys.remove(key);
                if keys.is_empty() {
                    self.inventory.remove(&binding);
                }
            }
        }
    }

    fn index_inventory(&mut self, key: [u8; 32], h: &holding::WideHolding) {
        let binding = (h.owner_citizen, h.slot);
        if self.inventory_of.get(&key) == Some(&binding) {
            return;
        }
        self.remove_inventory(&key);
        self.inventory.entry(binding).or_default().insert(key);
        self.inventory_of.insert(key, binding);
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
        self.report_key(key, state, observed_at, false);
    }

    fn report_key(
        &mut self,
        key: ProvinceKey,
        state: ReportedState,
        observed_at: u64,
        force: bool,
    ) {
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
            Ok(Lookup::Known(e)) if !force && e.state == state && e.observed_at == observed_at => {
                return
            }
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
        "wide": { "provinces": w.provinces.len(), "holdings": w.holdings.len(), "verification": "captured-unverified" },
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
    v["wide"] = captured_json(f, w, e.key.coord());
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

// Wide records never pass through the legacy P/Q prefix (both are zero).
// Only owner, season, world and the canonical public address authenticate a capture;
// this is not a replay or a proof of its event chain.
fn is_wide(d: &[u8]) -> bool {
    d.get(..8)
        .is_some_and(|m| m == land::province::MAGIC || m == holding::wide_holding::MAGIC)
}

#[derive(Clone, Copy)]
enum CapturedWide {
    Province(land::WideProvince),
    Holding(holding::WideHolding),
}
fn authenticate(f: &Fold, key: &[u8; 32], d: &[u8]) -> Option<CapturedWide> {
    let world = f.wide.as_ref()?.world();
    if let Ok(p) = land::WideProvince::read(d) {
        return (p.season_id == f.cfg.season_id
            && p.world == world
            && land::province_address(&f.ctx, p.coord) == *key)
            .then_some(CapturedWide::Province(p));
    }
    let h = holding::WideHolding::read(d).ok()?;
    (h.season_id == f.cfg.season_id
        && h.world == world
        && holding::holding_address(&f.ctx, h.coord, h.site) == *key)
        .then_some(CapturedWide::Holding(h))
}

/// Rebuild the derived wide index from persisted, previously authenticated captures.
pub(crate) fn index_capture(f: &mut Fold, key: &[u8; 32], d: &[u8]) -> bool {
    if !is_wide(d) {
        return false;
    }
    let captured = authenticate(f, key, d);
    let at = f.st.accounts.get(key).map_or(f.st.last_slot, |c| c.slot);
    let Some(w) = f.wide.as_mut() else {
        return true;
    };
    match captured {
        Some(CapturedWide::Province(p)) => {
            w.provinces.insert(p.coord, *key);
            w.report_key(
                ProvinceKey::new(p.world, p.coord),
                ReportedState::Open,
                at,
                true,
            );
        }
        Some(CapturedWide::Holding(h)) => {
            w.holdings.insert((h.coord, h.site), *key);
            w.index_inventory(*key, &h);
            if w.provinces.contains_key(&h.coord) {
                w.report_key(
                    ProvinceKey::new(h.world, h.coord),
                    ReportedState::Open,
                    at,
                    true,
                );
            }
        }
        None => w.refused += 1,
    }
    true
}

/// Intercepts actual wide post-state and explicit closes before legacy dispatch.
/// Malformed, wrong-owner or unsupported replacements never masquerade as closes.
pub(crate) fn capture_post(
    f: &mut Fold,
    key: &[u8; 32],
    account: Option<&Account>,
    tx: &TxRecord,
) -> bool {
    let old = f.st.accounts.get(key).cloned();
    let old_wide = old.as_ref().is_some_and(|c| is_wide(&c.data));
    if !old_wide && !account.is_some_and(|a| is_wide(&a.data)) {
        return false;
    }
    if let Some(a) = account {
        if a.owner != f.cfg.program || authenticate(f, key, &a.data).is_none() {
            if let Some(w) = f.wide.as_mut() {
                w.refused += 1;
            }
            return true;
        }
        if old.as_ref().is_some_and(|c| c.data == a.data) {
            return true;
        }
        f.st.accounts.insert(
            *key,
            Capture {
                slot: tx.slot,
                tx: tx.seq,
                data: a.data.clone(),
            },
        );
        index_capture(f, key, &a.data);
    } else if let Some(c) = old {
        let captured = authenticate(f, key, &c.data);
        if let Some(w) = f.wide.as_mut() {
            match captured {
                Some(CapturedWide::Province(p)) => {
                    w.provinces.remove(&p.coord);
                    w.report_key(
                        ProvinceKey::new(p.world, p.coord),
                        ReportedState::Closed,
                        tx.slot,
                        true,
                    );
                }
                Some(CapturedWide::Holding(h)) => {
                    w.holdings.remove(&(h.coord, h.site));
                    w.remove_inventory(key);
                    if w.provinces.contains_key(&h.coord) {
                        w.report_key(
                            ProvinceKey::new(h.world, h.coord),
                            ReportedState::Open,
                            tx.slot,
                            true,
                        );
                    }
                }
                None => w.refused += 1,
            }
        }
        f.st.accounts.remove(key);
    }
    true
}

fn capture_json(f: &Fold, key: &[u8; 32]) -> Value {
    let Some(c) = f.account(key) else {
        return Value::Null;
    };
    json!({ "address": Address::new_from_array(*key).to_string(),
        "slot": c.slot.to_string(), "archiveSequence": c.tx.to_string(),
        "postState": post_state_text(f),
        "verification": "captured-unverified",
        "bytes_b64": base64::engine::general_purpose::STANDARD.encode(&c.data) })
}

fn post_state_text(f: &Fold) -> &'static str {
    if f.cfg.exact_post {
        "transaction"
    } else {
        "at-or-after-transaction"
    }
}

/// One captured wide holding as `/h/me` lists it: the full identity the
/// record's own bytes carry (world, exact coordinate, ring, site,
/// generation, inventory slot, season, owner Citizen, host identity version,
/// open transits) beside its capture. A reader recomputes every field from
/// `capture.bytes_b64` and refuses a disagreement; nothing here is a
/// projection of the economy or a claim that the record is current.
fn wide_holding_json(f: &Fold, key: &[u8; 32], h: &holding::WideHolding) -> Value {
    json!({
        "world": hex::encode(h.world.as_bytes()),
        "p": h.coord.p().to_string(),
        "q": h.coord.q().to_string(),
        "ring": h.coord.ring().to_string(),
        "site": h.site,
        "generation": h.gen,
        "inventorySlot": h.slot,
        "season": h.season_id.to_string(),
        "ownerCitizen": Address::new_from_array(h.owner_citizen).to_string(),
        "hostIdentity": h.host_identity,
        "openTransits": h.open_transits,
        "capture": capture_json(f, key),
    })
}

/// The identity envelope of a viewer's wide inventory (`/h/me`
/// `wideContext`): what every `wideHoldings` entry is checked against by a
/// reader (world, season, Citizen, the fold's latest folded slot) and the
/// binding of each of the three inventory slots as the captured Citizen
/// bytes say it (`empty`, `legacy`, `wide`, or `malformed` for a ref no
/// writer may act on). `Null` while no wide index exists or the Citizen is
/// not captured: an absent envelope is "unavailable", never an empty
/// inventory and never a slot shown as free.
pub fn context_for_citizen(f: &Fold, citizen: &[u8; 32]) -> Value {
    let (Some(c), Some(w)) = (f.account(citizen), f.wide.as_ref()) else {
        return Value::Null;
    };
    let inventory: Vec<Value> = (1..=3u8)
        .map(|slot| {
            let binding = match holding::binding_of(&c.data, slot) {
                Ok(holding::SlotBinding::Empty) => "empty",
                Ok(holding::SlotBinding::Legacy(_)) => "legacy",
                Ok(holding::SlotBinding::Wide) => "wide",
                Err(_) => "malformed",
            };
            json!({ "inventorySlot": slot, "binding": binding })
        })
        .collect();
    json!({
        "v": 1,
        "readOnly": true,
        "executable": false,
        "verification": "captured-unverified",
        "world": hex::encode(w.world().as_bytes()),
        "worldDomain": WORLD_DOMAIN,
        "season": f.cfg.season_id.to_string(),
        "citizen": Address::new_from_array(*citizen).to_string(),
        "latestSlot": f.st.last_slot.to_string(),
        "foldedThrough": f.st.folded_through.to_string(),
        "postState": post_state_text(f),
        "inventory": inventory,
    })
}

/// Wide slots stay distinct from legacy holdings. A missing capture is explicit,
/// never a synthetic holding at (0,0) or a silently empty inventory slot.
/// The derived owner/slot index seeks each slot without traversing the world:
/// at most two captured records per slot are decoded to establish ambiguity.
/// Only a unique match is serialized; the capture remains unverified.
pub fn holdings_for_citizen(f: &Fold, citizen: &[u8; 32]) -> Value {
    let Some(c) = f.account(citizen) else {
        return json!([]);
    };
    let Some(w) = f.wide.as_ref() else {
        return json!([]);
    };
    let mut out = vec![];
    for slot in 2..=3 {
        if holding::binding_of(&c.data, slot) != Ok(holding::SlotBinding::Wide) {
            continue;
        }
        // Seek only this captured owner/slot. At most two valid candidates
        // establish ambiguity; do not serialize candidates we will discard.
        let mut matches = w
            .inventory
            .get(&(*citizen, slot))
            .into_iter()
            .flatten()
            .filter_map(|key| {
                #[cfg(test)]
                w.inventory_reads
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let h = holding::WideHolding::read(&f.account(key)?.data).ok()?;
                (h.owner_citizen == *citizen && h.slot == slot).then_some((key, h))
            });
        let first = matches.next();
        let ambiguous = first.is_some() && matches.next().is_some();
        let (status, value) = match first {
            None => ("not-captured", Value::Null),
            Some(_) if ambiguous => ("ambiguous", Value::Null),
            Some((key, h)) => {
                #[cfg(test)]
                w.inventory_serializations
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                ("captured-unverified", wide_holding_json(f, key, &h))
            }
        };
        out.push(json!({ "inventorySlot": slot, "status": status, "holding": value }));
    }
    json!(out)
}

fn captured_json(f: &Fold, w: &WideIndex, coord: WideCoord) -> Value {
    let Some(key) = w.provinces.get(&coord) else {
        return Value::Null;
    };
    let Some(c) = f.account(key) else {
        return Value::Null;
    };
    let Ok(p) = land::WideProvince::read(&c.data) else {
        return Value::Null;
    };
    use frontier_abi::v2::layout::province::{keep as K, province as P};
    let holdings: Vec<Value> = w.holdings.range((coord, 0)..=(coord, 11)).filter_map(|(_, addr)| {
        let h = holding::WideHolding::read(&f.account(addr)?.data).ok()?;
        Some(json!({ "world": hex::encode(h.world.as_bytes()), "p": h.coord.p().to_string(),
            "q": h.coord.q().to_string(), "site": h.site, "generation": h.gen,
            "inventorySlot": h.slot, "ownerCitizen": Address::new_from_array(h.owner_citizen).to_string(),
            "capture": capture_json(f, addr) }))
    }).collect();
    json!({ "world": hex::encode(p.world.as_bytes()), "p": p.coord.p().to_string(),
        "q": p.coord.q().to_string(), "openedBell": p.opened_bell,
        "region": p.region, "keepHolder": c.data[P::KEEP + K::HOLDER],
        "capture": capture_json(f, key), "holdings": holdings })
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

#[cfg(test)]
#[path = "wide_inventory_index.rs"]
mod wide_inventory_index;
