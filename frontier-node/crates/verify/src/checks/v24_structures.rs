//! V24 (S1 stages 1d and 1e, `docs/frontier/stage1d/S1-1D-CONTRACT.md`
//! §5.1, `docs/frontier/stage1e/S1-1E-CONTRACT.md` §7), listed as
//! `V24:structures`: every landed structure instruction and every march's
//! tower wear and palisade re-judged from the states before its
//! transaction and the states it left, through the structure kernel
//! (`permutation_rules::frontier::structure`):
//!
//! - **BuildStructure:** the kind, the tile (a vault's rule), the kind's
//!   counter below `max_of(kind)` and moved by one, the first empty entry
//!   of the Province's list (and, a fort, the first empty fort record)
//!   written with the Structure (place, owner, faction, generation 1,
//!   notify, entry, kind).
//! - **SeizeStructure:** the captor's roster host on the tile since a
//!   resolved bell, no host of the owner's holdings there, a fort fallen,
//!   the new owner, faction and generation in the Structure, its entry and
//!   its fort record, the counters.
//! - **CloseStructure:** the owner's, the entry (and fort record) cleared,
//!   the Structure closed, the counter.
//! - **FortGarrison** (1e): the owner's live fort in the holding's
//!   Province, the Province resolved through the last bell, a due pending
//!   part folded, the new troops pending from the next bell, at most
//!   `FORT_MAX_TROOPS`, the Spearmen reserve debited by them; nothing else
//!   in the fort block changed. (The clash's fort write-back is V7's, the
//!   shared clash model's replay.)
//! - **Reveal:** under the Season's stances before it and the march's
//!   expelled flag, a march whose path enters a stopping palisade's tile is
//!   never revealed, and an S1 slot's `WORN_BPS` is `wear_bps` of the
//!   seconds the revealed path walks in a stopping tower's coverage over
//!   the path Provinces' lists before the Reveal (`march_watch`; J4: the
//!   walk ends at the destination).
//! - **GatherClash:** a position's record carries the transit's troops
//!   worn by its slot's `WORN_BPS` at the first stamp (and the transit is
//!   written so), the transit's troops as they are at a re-stamp.
//!
//! The caravans' wear and palisades are V23's (their send and take, with
//! [`Walker`]). A Holding BuildStructure writes is V7's (an owner touch that
//! pays the kind's cost).
//!
//! Codes: `StructureMismatch`, `TowerWearMismatch`. Tamper classes T52–T54
//! (`crate::tamper`).

use frontier_abi::ix as aix;
use frontier_abi::layout::clash::{arrival as AR, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::layout::player::{holding as H, transit as T};
use frontier_abi::layout::province::{entry as EN, province as PV};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{fort_record as FR, structure_entry as TE};
use frontier_abi::v2::layout::s1::{arrival as S1A, structure as TW};
use frontier_abi::v2::layout::world::season as S2;
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::structure::{
    self as ks, march_watch, wear, wear_bps, Stances, StructureEntry, Walked, Watch, WatchedLand,
    KIND_FORT, KIND_PALISADE, KIND_TOWER,
};

use super::v23_caravans::{States, TxStates, Wrong};
use super::Ctx;
use crate::codes::{STRUCTURE_MISMATCH, TOWER_WEAR_MISMATCH};
use crate::world::{le, Key};

const V: &str = "V24";

fn tower_wrong(s: impl Into<String>) -> Wrong {
    (STRUCTURE_MISMATCH, s.into())
}
fn wear_wrong(s: impl Into<String>) -> Wrong {
    (TOWER_WEAR_MISMATCH, s.into())
}

fn at<const N: usize>(d: &[u8], o: usize) -> Option<[u8; N]> {
    d.get(o..o + N)?.try_into().ok()
}
fn u16_of(d: &[u8], o: usize) -> Option<u16> {
    at::<2>(d, o).map(u16::from_le_bytes)
}
fn i16_of(d: &[u8], o: usize) -> Option<i16> {
    at::<2>(d, o).map(i16::from_le_bytes)
}
fn u32_of(d: &[u8], o: usize) -> Option<u32> {
    at::<4>(d, o).map(u32::from_le_bytes)
}
fn u64_of(d: &[u8], o: usize) -> Option<u64> {
    at::<8>(d, o).map(u64::from_le_bytes)
}

fn entry_of(pd: &[u8], i: usize) -> Option<StructureEntry> {
    StructureEntry::decode(pd.get(TE::at(i)..TE::at(i) + TE::SIZE)?)
}

/// The Season's stance table (all WAR when short or zero).
pub fn stances(sd: Option<&[u8]>) -> Stances {
    sd.and_then(|d| d.get(S2::STANCES..S2::STANCES + ks::NATIONS * ks::NATIONS))
        .and_then(ks::stances_of)
        .unwrap_or([ks::STANCE_WAR; ks::NATIONS * ks::NATIONS])
}

/// Who walks, for what the structures do to it (S1 1e): the Season's
/// stances, its faction and whether it is expelled from its nation.
#[derive(Clone, Copy, Debug)]
pub struct Walker {
    pub stances: Stances,
    pub faction: u8,
    pub expelled: bool,
}

impl Walker {
    /// A Citizen's walk: the stances of the Season before and the
    /// Citizen's `EXPELLED_SINCE` before.
    pub fn of(s: &dyn States, season: &Key, citizen: &Key, faction: u8) -> Walker {
        let expelled = s
            .before(citizen)
            .and_then(|d| at::<8>(&d, C2::EXPELLED_SINCE))
            .is_some_and(|b| i64::from_le_bytes(b) != 0);
        Walker {
            stances: stances(s.before(season).as_deref()),
            faction,
            expelled,
        }
    }

    /// What it meets in a Province (`structure::watch` over its list).
    pub fn watch(&self, pd: &[u8]) -> Watch {
        pd.get(TE::BLOCK).map_or(Watch::default(), |l| {
            ks::watch(l, &self.stances, self.faction, self.expelled)
        })
    }
}

/// The Citizen's counter of `kind`.
fn counter(kind: u8) -> Option<usize> {
    match kind {
        KIND_TOWER => Some(C2::TOWERS),
        KIND_PALISADE => Some(C2::PALISADES),
        KIND_FORT => Some(C2::FORTS),
        _ => None,
    }
}

/// A fort's record: `(tile, faction, gen, state, troops, pend_bell, pend)`.
fn fort_rec(pd: &[u8], i: usize) -> Option<(u8, u8, u8, u8, u32, u32, u16)> {
    let o = FR::at(i);
    Some((
        *pd.get(o + FR::TILE)?,
        *pd.get(o + FR::FACTION)?,
        *pd.get(o + FR::GEN)?,
        *pd.get(o + FR::STATE)?,
        u32_of(pd, o + FR::TROOPS)?,
        u32_of(pd, o + FR::PEND_BELL)?,
        u16_of(pd, o + FR::PEND)?,
    ))
}

/// The live fort record of `tile`.
fn fort_index(pd: &[u8], tile: u8) -> Option<usize> {
    (0..FR::N).find(|&i| fort_rec(pd, i).is_some_and(|f| f.3 == FR::STATE_LIVE && f.0 == tile))
}

// ------------------------------------------------------------ BuildStructure

/// BuildStructure (accounts: 3 citizen, 6 province, 7 structure).
pub fn judge_build_structure(ix: &crate::world::Ix, s: &dyn States, now: i64) -> Result<(), Wrong> {
    let x = ix2::BuildStructure::decode(&ix.data).map_err(|_| tower_wrong("does not decode"))?;
    let (Some(citizen), Some(province), Some(tower)) = (ix.key(3), ix.key(6), ix.key(7)) else {
        return Err(tower_wrong("the accounts are missing"));
    };
    let pd = s
        .before(&province)
        .ok_or_else(|| tower_wrong("no Province before"))?;
    let pa = s
        .after(&province)
        .ok_or_else(|| tower_wrong("no Province after"))?;
    let cb = s
        .before(&citizen)
        .ok_or_else(|| tower_wrong("no Citizen before"))?;
    let ca = s
        .after(&citizen)
        .ok_or_else(|| tower_wrong("no Citizen after"))?;
    let tile = x.tile;
    let pass = u64_of(&pd, PV::PASSABLE_MASK).ok_or_else(|| tower_wrong("short Province"))?;
    let n = (pd[PV::SITE_COUNT] as usize).min(PV::SITES_N);
    let site_tile = pd[PV::SITES..PV::SITES + n].contains(&tile);
    let keep = frontier_abi::conquest_model::read_keep(&pd)
        .map_err(|e| tower_wrong(format!("keep: {e:?}")))?
        .map(|k| k.tile);
    let camp = {
        use frontier_abi::layout::province::camp as CP;
        pd[PV::CAMP + CP::STATE] == CP::STATE_PRESENT && pd[PV::CAMP + CP::TILE] == tile
    };
    if tile as usize >= 61 || pass & (1u64 << tile) == 0 || site_tile || keep == Some(tile) || camp
    {
        return Err(tower_wrong(format!(
            "a tower on tile {tile}, which the rules refuse"
        )));
    }
    if x.notify > TW::NOTIFY_FACTION {
        return Err(tower_wrong("a notify setting the rules refuse"));
    }
    let count = counter(x.kind).ok_or_else(|| tower_wrong("a kind the rules refuse"))?;
    let (tb, ta) = (cb[count], ca[count]);
    if tb >= ks::max_of(x.kind) || ta != tb + 1 {
        return Err(tower_wrong(format!(
            "the kind {}'s counter went {tb} → {ta}",
            x.kind
        )));
    }
    let free = (0..TE::N)
        .find(|&i| entry_of(&pd, i).is_some_and(|e| !e.live()))
        .ok_or_else(|| tower_wrong("a structure built in a full list"))?;
    let faction = cb[C2::FACTION];
    let want_entry = StructureEntry {
        kind: x.kind,
        tile,
        faction,
        gen: 1,
    };
    // A fort: the first empty fort record, written; the others unchanged.
    let fort = if x.kind == KIND_FORT {
        let i = (0..FR::N)
            .find(|&i| fort_rec(&pd, i).is_some_and(|f| f.3 == FR::STATE_NONE))
            .ok_or_else(|| tower_wrong("a fort built in a full fort block"))?;
        Some(i)
    } else {
        None
    };
    for i in 0..FR::N {
        let want = if fort == Some(i) {
            Some((tile, faction, 1, FR::STATE_LIVE, 0, u32::MAX, 0))
        } else {
            fort_rec(&pd, i)
        };
        if fort_rec(&pa, i) != want {
            return Err(tower_wrong(format!(
                "the fort record {i} is not the rules' after the build"
            )));
        }
    }
    for i in 0..TE::N {
        let (b, a) = (entry_of(&pd, i), entry_of(&pa, i));
        let ok = if i == free {
            a == Some(want_entry)
        } else {
            a == b
        };
        if !ok {
            return Err(tower_wrong(format!(
                "the tower list's entry {i} is not the rules' after the build"
            )));
        }
    }
    let td = s
        .after(&tower)
        .ok_or_else(|| tower_wrong("no Tower after"))?;
    let want = |ok: bool, what: &str| -> Result<(), Wrong> {
        if ok {
            Ok(())
        } else {
            Err(tower_wrong(format!("the Tower's {what} is not the rules'")))
        }
    };
    want(td.len() == TW::SIZE && td[..8] == TW::MAGIC, "account")?;
    want(td[TW::STATE] == TW::STATE_LIVE && td[TW::GEN] == 1, "state")?;
    want(
        i16_of(&td, TW::P) == i16_of(&pd, PV::P)
            && i16_of(&td, TW::Q) == i16_of(&pd, PV::Q)
            && td[TW::TILE] == tile,
        "place",
    )?;
    want(at::<32>(&td, TW::OWNER_CITIZEN) == Some(citizen), "owner")?;
    want(td[TW::FACTION] == faction, "faction")?;
    want(
        u64_of(&td, TW::OWNER_TAG) == u64_of(&cb, C2::CITIZEN_TAG),
        "owner tag",
    )?;
    want(td[TW::NOTIFY] == x.notify, "notify")?;
    want(td[TW::ENTRY] as usize == free, "entry")?;
    want(td[TW::KIND] == x.kind, "kind")?;
    want(
        at::<8>(&td, TW::BUILT_TS).map(i64::from_le_bytes) == Some(now),
        "build time",
    )?;
    Ok(())
}

// ------------------------------------------------------------ SeizeStructure

/// SeizeStructure (accounts: 3 captor citizen, 4 tower, 5 province, 6
/// host_holding, 7 owner_citizen).
pub fn judge_seize_structure(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = ix2::SeizeStructure::decode(&ix.data).map_err(|_| tower_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 8 {
        return Err(tower_wrong("the accounts are missing"));
    }
    let (captor, tower, province, hk, owner) = (keys[3], keys[4], keys[5], keys[6], keys[7]);
    let tb = s
        .before(&tower)
        .ok_or_else(|| tower_wrong("no Tower before"))?;
    if tb.len() != TW::SIZE || tb[TW::STATE] != TW::STATE_LIVE {
        return Err(tower_wrong("the tower is not live"));
    }
    let town = at::<32>(&tb, TW::OWNER_CITIZEN).ok_or_else(|| tower_wrong("short Tower"))?;
    if town != owner || town == captor {
        return Err(tower_wrong("the seizure's owner or captor is wrong"));
    }
    let tile = tb[TW::TILE];
    let entry = tb[TW::ENTRY] as usize;
    let kind = tb[TW::KIND];
    let count = counter(kind).ok_or_else(|| tower_wrong("a structure of no kind"))?;
    let pd = s
        .before(&province)
        .ok_or_else(|| tower_wrong("no Province before"))?;
    // A fort must have fallen (no troops, the pending ones included).
    let fort = if kind == KIND_FORT {
        let i = fort_index(&pd, tile).ok_or_else(|| tower_wrong("a fort without its record"))?;
        let f = fort_rec(&pd, i).ok_or_else(|| tower_wrong("short Province"))?;
        if f.4 != 0 || f.6 != 0 {
            return Err(tower_wrong("a manned fort seized"));
        }
        Some(i)
    } else {
        None
    };
    let od = s
        .before(&owner)
        .ok_or_else(|| tower_wrong("no owner Citizen before"))?;
    let rn = u32_of(&pd, PV::RESOLVED_NEXT).ok_or_else(|| tower_wrong("short Province"))?;
    let owner_holdings: Vec<u64> = (1..=3u8)
        .filter_map(|slot| {
            let o = C2::holding_of_slot(slot);
            let (p, q) = (i16_of(&od, o)?, i16_of(&od, o + 2)?);
            let (site, gen) = (*od.get(o + 4)?, *od.get(o + 5)?);
            (gen != C2::EMPTY_GEN)
                .then(|| frontier_abi::addr::host_id(p as i32, q as i32, site, gen, 0))
                .flatten()
        })
        .collect();
    let part = |id: u64| id & !0xFFFF_FFFF;
    let mut captor_host = None;
    for i in 0..PV::ENTRIES_N {
        let o = PV::entry(i);
        let e = pd
            .get(o..o + EN::SIZE)
            .ok_or_else(|| tower_wrong("short Province"))?;
        if e[EN::STATE] != EN::STATE_ROSTER || e[EN::TILE] != tile {
            continue;
        }
        let id = le(&e[EN::ID..EN::ID + 8]);
        if owner_holdings.contains(&part(id)) {
            return Err(tower_wrong("seized while a host of the owner stands on it"));
        }
        if i == x.entry as usize && le(&e[EN::FROM_BELL..EN::FROM_BELL + 4]) as u32 <= rn {
            captor_host = Some(id);
        }
    }
    let host = captor_host.ok_or_else(|| tower_wrong("seized without the captor's host on it"))?;
    let hd = s
        .before(&hk)
        .ok_or_else(|| tower_wrong("no host Holding before"))?;
    let parts = frontier_abi::addr::split_host_id(host).ok_or_else(|| tower_wrong("host id"))?;
    if hd.get(H2::GEN) != Some(&parts.gen) || at::<32>(&hd, H2::OWNER_CITIZEN) != Some(captor) {
        return Err(tower_wrong("the standing host is not the captor's"));
    }
    let cb = s
        .before(&captor)
        .ok_or_else(|| tower_wrong("no captor Citizen before"))?;
    if cb[count] >= ks::max_of(kind) {
        return Err(tower_wrong("a captor over the kind's limit"));
    }
    let faction = cb[C2::FACTION];
    let gen = tb[TW::GEN].wrapping_add(1);
    let ta = s
        .after(&tower)
        .ok_or_else(|| tower_wrong("no Tower after"))?;
    if at::<32>(&ta, TW::OWNER_CITIZEN) != Some(captor)
        || ta[TW::GEN] != gen
        || ta[TW::FACTION] != faction
    {
        return Err(tower_wrong(
            "the seized tower's owner, faction or generation",
        ));
    }
    let pa = s
        .after(&province)
        .ok_or_else(|| tower_wrong("no Province after"))?;
    let want = StructureEntry {
        kind,
        tile,
        faction,
        gen,
    };
    if entry_of(&pa, entry) != Some(want) {
        return Err(tower_wrong(
            "the seized structure's entry does not follow it",
        ));
    }
    if let Some(i) = fort {
        let f = fort_rec(&pa, i);
        if f.map(|f| (f.1, f.2)) != Some((faction, gen)) {
            return Err(tower_wrong("the seized fort's record does not follow it"));
        }
    }
    let (ca, oa) = (s.after(&captor), s.after(&owner));
    let moved = |b: &[u8], a: Option<Vec<u8>>, d: i16| {
        a.is_some_and(|a| a[count] as i16 == b[count] as i16 + d)
    };
    if !moved(&cb, ca, 1) || !moved(&od, oa, -1) {
        return Err(tower_wrong("the tower counters did not move"));
    }
    Ok(())
}

// ------------------------------------------------------------ CloseStructure

/// CloseStructure (accounts: 3 citizen, 4 structure, 5 province).
pub fn judge_close_structure(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let (Some(citizen), Some(tower), Some(province)) = (ix.key(3), ix.key(4), ix.key(5)) else {
        return Err(tower_wrong("the accounts are missing"));
    };
    let tb = s
        .before(&tower)
        .ok_or_else(|| tower_wrong("no Tower before"))?;
    if at::<32>(&tb, TW::OWNER_CITIZEN) != Some(citizen) {
        return Err(tower_wrong("closed by another than its owner"));
    }
    if s.after(&tower).is_some() {
        return Err(tower_wrong("the tower is not closed"));
    }
    let pa = s
        .after(&province)
        .ok_or_else(|| tower_wrong("no Province after"))?;
    let entry = tb[TW::ENTRY] as usize;
    if entry_of(&pa, entry).is_none_or(|e| e.live()) {
        return Err(tower_wrong(
            "the closed structure's entry is left in the list",
        ));
    }
    let kind = tb[TW::KIND];
    if kind == KIND_FORT && fort_index(&pa, tb[TW::TILE]).is_some() {
        return Err(tower_wrong("the closed fort's record is left"));
    }
    let count = counter(kind).ok_or_else(|| tower_wrong("a structure of no kind"))?;
    let (cb, ca) = (s.before(&citizen), s.after(&citizen));
    match (cb, ca) {
        (Some(b), Some(a)) if a[count] == b[count].saturating_sub(1) => Ok(()),
        _ => Err(tower_wrong("the kind's counter did not move")),
    }
}

// ------------------------------------------------------------ Reveal

/// A Reveal's slot wear (accounts: 2 holding, 7 destination, 9.. the
/// slots, 13.. the path Provinces before the sysvar and the system
/// program).
pub fn judge_reveal_wear(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = aix::Reveal::decode(&ix.data).map_err(|_| wear_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 15 || x.target_i >= 4 {
        return Err(wear_wrong("a Reveal without its accounts"));
    }
    let hd = s
        .before(&keys[2])
        .ok_or_else(|| wear_wrong("no Holding before"))?;
    let o = H::transit(x.transit_slot as usize);
    let tr = hd
        .get(o..o + T::SIZE)
        .ok_or_else(|| wear_wrong("no transit"))?;
    let who = Walker {
        stances: stances(s.before(&keys[1]).as_deref()),
        faction: tr[T::FACTION],
        expelled: hd.get(H::FLAGS).is_some_and(|f| f & H2::FLAG_EXPELLED != 0),
    };
    let cav = frontier_abi::entry::unit_from_u8(tr[T::UNIT])
        .is_some_and(permutation_rules::frontier::travel::is_cavalry);
    let origin = (
        ProvinceCoord::new(
            i16_of(tr, T::ORIGIN_P).unwrap_or(0) as i32,
            i16_of(tr, T::ORIGIN_Q).unwrap_or(0) as i32,
        ),
        tr[T::ORIGIN_TILE],
    );
    let plain = fclient::seal::unpack(&x.plain);
    let mut lands = vec![];
    for k in std::iter::once(&keys[7]).chain(&keys[13..keys.len() - 2]) {
        let pd = s
            .before(k)
            .ok_or_else(|| wear_wrong("no path Province before"))?;
        let (p, q) = (
            i16_of(&pd, PV::P).unwrap_or(0) as i32,
            i16_of(&pd, PV::Q).unwrap_or(0) as i32,
        );
        lands.push(WatchedLand {
            at: ProvinceCoord::new(p, q),
            rough: u64_of(&pd, PV::ROUGH_MASK).unwrap_or(0),
            road: u64_of(&pd, PV::ROAD_MASK).unwrap_or(0),
            watch: who.watch(&pd),
        });
    }
    let secs = match march_watch(origin, &plain.path, plain.path_len, &lands, cav)
        .ok_or_else(|| wear_wrong("the revealed walk leaves its Provinces"))?
    {
        Walked::Secs(secs) => secs,
        Walked::Blocked => {
            return Err(tower_wrong(
                "a march revealed through a palisade that stops it",
            ))
        }
    };
    let want = wear_bps(secs);
    let slot = keys[9 + x.target_i as usize];
    let sd = s
        .after(&slot)
        .ok_or_else(|| wear_wrong("no ArrivalSlot after"))?;
    let got = u16_of(&sd, S1A::WORN_BPS).ok_or_else(|| wear_wrong("short ArrivalSlot"))?;
    if got != want {
        return Err(wear_wrong(format!(
            "the slot's tower wear is {got} bps, the kernel's {want} ({secs} s in range)"
        )));
    }
    Ok(())
}

// ------------------------------------------------------------ GatherClash

/// A GatherClash's worn records and transits (accounts: 2 province, 5
/// inputs, 8.. the `n` slots, then the Holdings of the bitmap's positions).
pub fn judge_gather_wear(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = aix::GatherClash::decode(&ix.data).map_err(|_| wear_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    let n = x.n as usize;
    if keys.len() < 8 + n {
        return Err(wear_wrong("a GatherClash without its accounts"));
    }
    let pd = s
        .before(&keys[2])
        .ok_or_else(|| wear_wrong("no Province before"))?;
    let (pp, pq) = (
        i16_of(&pd, PV::P).unwrap_or(0),
        i16_of(&pd, PV::Q).unwrap_or(0),
    );
    let ci = s
        .after(&keys[5])
        .ok_or_else(|| wear_wrong("no ClashInputs after"))?;
    let mut h = 8 + n;
    for i in 0..n {
        let k = x.start as usize + i;
        if x.holdings_bitmap & (1 << k) == 0 {
            continue;
        }
        let hk = *keys.get(h).ok_or_else(|| wear_wrong("a Holding missing"))?;
        h += 1;
        let Some(sd) = s.before(&keys[8 + i]) else {
            continue;
        };
        let (Some(host), Some(worn)) = (u64_of(&sd, AS::HOST_ID), u16_of(&sd, S1A::WORN_BPS))
        else {
            continue;
        };
        let (Some(hb), Some(ha)) = (s.before(&hk), s.after(&hk)) else {
            continue;
        };
        let live = matches!(hb.get(H::STATE), Some(&st) if st == H::STATE_PROVISIONAL || st == H::STATE_FINAL);
        // The host's generation, or a captured Holding's previous one (the
        // program's `gathers_gen`).
        let gen = frontier_abi::addr::split_host_id(host).map(|p| p.gen);
        let gathers = gen == hb.get(H::GEN).copied()
            || (hb
                .get(H2::CAPTURE_FLAGS)
                .is_some_and(|f| f & H2::CAPTURE_FLAG_CAPTURED != 0)
                && gen == hb.get(H2::PREV_GEN).copied());
        if !live || !gathers {
            continue;
        }
        for t in 0..H::TRANSIT_N {
            let o = H::transit(t);
            let Some(tr) = hb.get(o..o + T::SIZE) else {
                break;
            };
            if tr[T::STATE] != T::STATE_SETTLED
                || u64_of(tr, T::HOST_ID) != Some(host)
                || u32_of(tr, T::ARRIVE_BELL) != Some(x.bell)
            {
                continue;
            }
            let same = tr[T::FLAGS] & T::FLAG_GATHERED != 0
                && i16_of(tr, T::DEST_P) == Some(pp)
                && i16_of(tr, T::DEST_Q) == Some(pq);
            let troops = u32_of(tr, T::TROOPS_AFTER).unwrap_or(0);
            let want = if same {
                troops
            } else {
                wear(troops as u64, worn) as u32
            };
            let rec = CI::ARRIVALS + k * AR::SIZE;
            let got = u32_of(&ci, rec + AR::TROOPS);
            let ta = u32_of(&ha, o + T::TROOPS_AFTER);
            if got != Some(want) || ta != Some(want) {
                return Err(wear_wrong(format!(
                    "position {k}: record {got:?} and transit {ta:?} troops, the wear gives {want}"
                )));
            }
            break;
        }
    }
    Ok(())
}

// ------------------------------------------------------------ FortGarrison

/// FortGarrison (accounts: 3 citizen, 4 holding, 5 province, 6 structure).
pub fn judge_fort_garrison(ix: &crate::world::Ix, s: &dyn States, bell: u32) -> Result<(), Wrong> {
    let x = ix2::FortGarrison::decode(&ix.data).map_err(|_| tower_wrong("does not decode"))?;
    let (Some(citizen), Some(holding), Some(province), Some(structure)) =
        (ix.key(3), ix.key(4), ix.key(5), ix.key(6))
    else {
        return Err(tower_wrong("the accounts are missing"));
    };
    let get = |k: &Key, after: bool, what: &str| {
        if after { s.after(k) } else { s.before(k) }
            .ok_or_else(|| tower_wrong(format!("no {what}")))
    };
    let td = get(&structure, false, "Structure")?;
    let (pd, pa) = (
        get(&province, false, "Province before")?,
        get(&province, true, "Province after")?,
    );
    let (hb, ha) = (
        get(&holding, false, "Holding before")?,
        get(&holding, true, "Holding after")?,
    );
    if td[TW::KIND] != KIND_FORT
        || td[TW::STATE] != TW::STATE_LIVE
        || at::<32>(&td, TW::OWNER_CITIZEN) != Some(citizen)
        || at::<32>(&hb, H2::OWNER_CITIZEN) != Some(citizen)
        || i16_of(&td, TW::P) != i16_of(&pd, PV::P)
        || i16_of(&td, TW::Q) != i16_of(&pd, PV::Q)
        || i16_of(&hb, H2::P) != i16_of(&pd, PV::P)
        || i16_of(&hb, H2::Q) != i16_of(&pd, PV::Q)
    {
        return Err(tower_wrong("a garrison into a fort the rules refuse"));
    }
    let rn = u32_of(&pd, PV::RESOLVED_NEXT).ok_or_else(|| tower_wrong("short Province"))?;
    if !frontier_abi::prologue::resident_ok(rn, bell) {
        return Err(tower_wrong(
            "a fort garrisoned before the Province resolved",
        ));
    }
    let i = fort_index(&pd, td[TW::TILE]).ok_or_else(|| tower_wrong("no fort record"))?;
    let (tile, faction, gen, state, mut troops, pend_bell, mut pend) =
        fort_rec(&pd, i).ok_or_else(|| tower_wrong("short Province"))?;
    if pend > 0 && pend_bell <= bell {
        troops += pend as u32 * 1_000;
        pend = 0;
    }
    let pend = pend as u32 + x.troops;
    if x.troops == 0 || troops / 1_000 + pend > ks::FORT_MAX_TROOPS {
        return Err(tower_wrong("a fort garrisoned past its cap"));
    }
    for j in 0..FR::N {
        let want = if j == i {
            Some((tile, faction, gen, state, troops, bell + 1, pend as u16))
        } else {
            fort_rec(&pd, j)
        };
        if fort_rec(&pa, j) != want {
            return Err(tower_wrong(format!(
                "the fort record {j} is not the garrison's"
            )));
        }
    }
    let o = H2::reserve(0);
    let (rb, ra) = (u32_of(&hb, o), u32_of(&ha, o));
    if rb.and_then(|b| b.checked_sub(x.troops)) != ra {
        return Err(tower_wrong("the Spearmen reserve did not pay the garrison"));
    }
    Ok(())
}

// ------------------------------------------------------------ the check

pub fn run(cx: &mut Ctx) {
    if !cx.s1 {
        return;
    }
    let w = cx.w;
    if !w.has_post {
        let any = w.txs.iter().any(|tx| {
            tx.ok
                && tx.ixs.iter().any(|i| {
                    i.tag().is_some_and(|x| {
                        [
                            V2Ix::BuildStructure,
                            V2Ix::SeizeStructure,
                            V2Ix::CloseStructure,
                            V2Ix::FortGarrison,
                        ]
                        .iter()
                        .any(|t| t.tag() == x)
                    })
                })
        });
        if any {
            cx.missing(
                V,
                "towers",
                0,
                None,
                "no post-states: the tower instructions cannot be re-judged",
            );
        }
        return;
    }
    let genesis_ts = cx.f.genesis_ts;
    let mut found: Vec<(usize, u32, &'static str, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate().filter(|(_, tx)| tx.ok) {
        let bell = frontier_abi::prologue::bell_at(genesis_ts, tx.time).unwrap_or(0);
        let st = TxStates { w, tx, t };
        for ix in &tx.ixs {
            let Some(tag) = ix.tag() else { continue };
            let r = match V2Ix::from_tag(tag) {
                Some(V2Ix::BuildStructure) => judge_build_structure(ix, &st, tx.time),
                Some(V2Ix::SeizeStructure) => judge_seize_structure(ix, &st),
                Some(V2Ix::CloseStructure) => judge_close_structure(ix, &st),
                Some(V2Ix::FortGarrison) => judge_fort_garrison(ix, &st, bell),
                Some(V2Ix::Reveal) => judge_reveal_wear(ix, &st),
                Some(V2Ix::GatherClash) => judge_gather_wear(ix, &st),
                _ => continue,
            };
            if let Err((code, detail)) = r {
                found.push((t, bell, code, detail));
            }
        }
    }
    for (t, bell, code, detail) in found {
        cx.fail(V, code, "towers", bell, Some(t), detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mock {
        before: HashMap<Key, Vec<u8>>,
        after: HashMap<Key, Option<Vec<u8>>>,
    }

    impl States for Mock {
        fn before(&self, k: &Key) -> Option<Vec<u8>> {
            self.before.get(k).cloned()
        }
        fn after(&self, k: &Key) -> Option<Vec<u8>> {
            match self.after.get(k) {
                Some(v) => v.clone(),
                None => self.before(k),
            }
        }
    }

    fn k(n: u8) -> Key {
        [n; 32]
    }

    /// A gather that wears the record and the transit by the slot's
    /// `WORN_BPS` passes; one that skips the wear (T53's shape) fails, and
    /// so does one that wears a transit already stamped here.
    #[test]
    fn gather_wears_once() {
        let (province, inputs, slot, holding) = (k(2), k(5), k(8), k(9));
        let mut pd = vec![0u8; frontier_abi::v2::layout::province::province::SIZE];
        pd[PV::P..PV::P + 2].copy_from_slice(&3i16.to_le_bytes());
        let mut sd = vec![0u8; AS::SIZE];
        sd[AS::HOST_ID..AS::HOST_ID + 8].copy_from_slice(&77u64.to_le_bytes());
        sd[S1A::WORN_BPS..S1A::WORN_BPS + 2].copy_from_slice(&1_000u16.to_le_bytes());
        let mut hb = vec![0u8; H::SIZE];
        hb[H::STATE] = H::STATE_FINAL;
        let o = H::transit(0);
        hb[o + T::STATE] = T::STATE_SETTLED;
        hb[o + T::HOST_ID..o + T::HOST_ID + 8].copy_from_slice(&77u64.to_le_bytes());
        hb[o + T::ARRIVE_BELL..o + T::ARRIVE_BELL + 4].copy_from_slice(&40u32.to_le_bytes());
        hb[o + T::TROOPS_AFTER..o + T::TROOPS_AFTER + 4].copy_from_slice(&500_000u32.to_le_bytes());
        let worn = |hb: &[u8], v: u32| {
            let mut ha = hb.to_vec();
            ha[o + T::TROOPS_AFTER..o + T::TROOPS_AFTER + 4].copy_from_slice(&v.to_le_bytes());
            ha[o + T::FLAGS] |= T::FLAG_GATHERED;
            ha[o + T::DEST_P..o + T::DEST_P + 2].copy_from_slice(&3i16.to_le_bytes());
            ha
        };
        let ci = |v: u32| {
            let mut c = vec![0u8; CI::SIZE];
            let r = CI::ARRIVALS;
            c[r + AR::TROOPS..r + AR::TROOPS + 4].copy_from_slice(&v.to_le_bytes());
            c
        };
        let data = aix::GatherClash {
            bell: 40,
            start: 0,
            n: 1,
            holdings_bitmap: 1,
            beneficiary: [0; 32],
        }
        .to_bytes()
        .to_vec();
        let ix = crate::world::Ix {
            index: 0,
            data,
            accounts: [
                k(0),
                k(1),
                province,
                k(3),
                k(4),
                inputs,
                k(6),
                k(7),
                slot,
                holding,
            ]
            .iter()
            .map(|x| (*x, true))
            .collect(),
        };
        let mut m = Mock {
            before: HashMap::from([(province, pd), (slot, sd), (holding, hb.clone())]),
            after: HashMap::from([
                (inputs, Some(ci(450_000))),
                (holding, Some(worn(&hb, 450_000))),
            ]),
        };
        assert_eq!(judge_gather_wear(&ix, &m), Ok(()));
        // skipped the wear
        m.after.insert(inputs, Some(ci(500_000)));
        m.after.insert(holding, Some(worn(&hb, 500_000)));
        assert_eq!(
            judge_gather_wear(&ix, &m).unwrap_err().0,
            TOWER_WEAR_MISMATCH
        );
        // a re-stamp keeps the transit's troops
        let stamped = worn(&hb, 450_000);
        m.before.insert(holding, stamped.clone());
        m.after.insert(holding, Some(stamped.clone()));
        m.after.insert(inputs, Some(ci(450_000)));
        assert_eq!(judge_gather_wear(&ix, &m), Ok(()));
        m.after.insert(holding, Some(worn(&stamped, 405_000)));
        m.after.insert(inputs, Some(ci(405_000)));
        assert_eq!(
            judge_gather_wear(&ix, &m).unwrap_err().0,
            TOWER_WEAR_MISMATCH
        );
    }
}
