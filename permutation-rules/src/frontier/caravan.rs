//! Stage 1b of the redesign: caravans (`docs/frontier/stage1b/S1-1B-CONTRACT.md`).
//!
//! A caravan carries goods along a **public** hex path from a holding or a
//! vault to another. It is a visible object: the province it stands in at
//! the start of each bell records it (a [`CaravanSlot`] in the Province),
//! so a clash of that province and bell sees it on its tile (stage 1c: a
//! 0-troop garrison of its faction; a hostile host that holds the tile
//! raids it). Everything here is a pure function of its inputs; the
//! program, the verifier and the clash model call the same code.
//!
//! * [`walk`]: the path's tiles and the time each step completes, over the
//!   provinces' passable, rough and road masks (the sealed march's walk,
//!   at caravan speed).
//! * [`schedule`]: the tile it stands on at the start of each bell, grouped
//!   into one run per province ([`Run`]).
//! * [`caravan_id`], [`carry`], [`split`]: ids, what a host can carry
//!   away, and the take of a raid.
//!
//! Every number marked [phase 6] is a placeholder.

use alloc::vec::Vec;

use crate::fixed::{Milli, MilliTroops, BPS_ONE};
use crate::hex::{Hex, DIRECTIONS};

use super::geometry::{locate, ProvinceCoord};
use super::holding::RESOURCES;
use super::travel::{
    bell_at, bell_start, FLAT_HEX_SECS, MAX_PATH_PROVINCES, MAX_PATH_STEPS, ROAD_BPS,
    ROUGH_HEX_SECS,
};

/// Kernel version of this module (`KERNEL_VERSIONS_V3` entry `caravan`).
pub const CARAVAN_VERSION: u16 = 1;

/// A caravan's step time relative to a foot host's (bps) [phase 6]:
/// carts are slower than marching troops.
pub const CARAVAN_SLOW_BPS: u32 = 15_000;
/// Caravan slots of a Province (contract §1.4) [proposal].
pub const MAX_CARAVAN_SLOTS: usize = 5;
/// Bells one caravan may stand in one province (a slot's tiles): eight
/// bells (80 minutes) cross any province on a sensible path; a longer stay
/// is split into several sends.
pub const SLOT_TILES: usize = 8;
/// Bytes of a [`CaravanSlot`].
pub const SLOT_SIZE: usize = 36;
/// `RAID_OFF` of a slot: no raid.
pub const RAID_NONE: u8 = 0xFF;
/// `RAID_OFF` of a slot: the raid has been settled.
pub const RAID_SETTLED: u8 = 0xFE;
/// Carrying capacity per troop, milli-units (0.1 unit) [phase 6].
pub const CARRY_MILLI_PER_TROOP: i64 = 100;
/// Bells a raider has to choose take or burn before the default take
/// [phase 6].
pub const RAID_DECIDE_BELLS: u32 = 6;
/// Bells after the raider's window from which DefaultRaid may burn the
/// cargo instead of taking it home, when no walk reaches the raiding
/// holding [phase 6]: a raid never stays open for good, and a keeper has
/// a day to deliver the loot when a path exists.
pub const RAID_BURN_AFTER_BELLS: u32 = 144;
/// Lamports a caravan escrows for its settlement [phase 6].
pub const CARAVAN_FEE: u64 = 50_000;

/// Vaults a citizen may own (contract §1.1) [phase 6].
pub const MAX_VAULTS: u8 = 3;
/// A vault's cost (units) [phase 6], paid from one of the owner's holdings.
pub const VAULT_COST: [i64; RESOURCES] = [0, 200, 200, 0, 0, 50, 0, 0];
/// A vault's capacity per resource (milli-units) [phase 6].
pub const VAULT_CAP: Milli = 5_000 * 1_000;

/// The vault's cost in milli-units.
pub fn vault_cost() -> [Milli; RESOURCES] {
    VAULT_COST.map(|x| x * 1_000)
}

/// Why a path or a schedule is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaravanError {
    /// Empty, longer than `MAX_PATH_STEPS`, through an impassable tile, a
    /// province not supplied (or supplied out of order), or not ending on
    /// the destination.
    Path,
    /// The caravan would stand more than [`SLOT_TILES`] bells in one
    /// province, or come back to a province it left.
    TooSlow,
}

/// The masks of one province the walk reads (the Province's
/// `PASSABLE_MASK`, `ROUGH_MASK`, `ROAD_MASK`: bit = tile index).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Land {
    pub at: ProvinceCoord,
    pub passable: u64,
    pub rough: u64,
    pub road: u64,
}

/// One step of a walk: where it ends, and the seconds from departure when
/// the caravan gets there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub province: ProvinceCoord,
    pub tile: u8,
    pub at_secs: u32,
}

/// The direction of step `i` of a packed path (3 bits each, little-endian
/// across the 12 bytes; `seal`'s packing).
pub fn dir_of(path: &[u8; 12], i: usize) -> u8 {
    let bit = 3 * i;
    let lo = path[bit / 8] as u16;
    let hi = *path.get(bit / 8 + 1).unwrap_or(&0) as u16;
    (((hi << 8 | lo) >> (bit % 8)) & 7) as u8
}

/// Packs directions into a path (the inverse of [`dir_of`]).
pub fn pack(dirs: &[u8]) -> Option<[u8; 12]> {
    if dirs.len() > MAX_PATH_STEPS {
        return None;
    }
    let mut p = [0u8; 12];
    for (i, &d) in dirs.iter().enumerate() {
        if d > 5 {
            return None;
        }
        let bit = 3 * i;
        let v = (d as u16) << (bit % 8);
        p[bit / 8] |= v as u8;
        if bit / 8 + 1 < 12 {
            p[bit / 8 + 1] |= (v >> 8) as u8;
        }
    }
    Some(p)
}

/// The walk of a caravan from `origin` (province, tile) over `steps`
/// packed steps. `lands` are the provinces it crosses in first-entered
/// order, **the origin's first**; every one must be entered, none twice.
/// Step time: `travel::hex_secs` for a foot host (120 s flat, 180 s rough,
/// ×0.5 on a road) × [`CARAVAN_SLOW_BPS`] × `caravan_bps` (the owner's
/// doctrine `caravan_time_bps`), taken over the cumulative base so the
/// rounding never drifts. Returns the steps, the last one the destination.
pub fn walk(
    origin: (ProvinceCoord, u8),
    path: &[u8; 12],
    steps: u8,
    lands: &[Land],
    caravan_bps: u32,
) -> Result<Vec<Step>, CaravanError> {
    let n = steps as usize;
    if n == 0 || n > MAX_PATH_STEPS || lands.is_empty() || lands.len() > MAX_PATH_PROVINCES {
        return Err(CaravanError::Path);
    }
    if lands[0].at != origin.0 {
        return Err(CaravanError::Path);
    }
    let mut hex = origin.0.tile(origin.1).ok_or(CaravanError::Path)?;
    let mut entered = 1usize;
    let mut cur = 0usize;
    let mut base = 0u64;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (dq, dr) = *DIRECTIONS
            .get(dir_of(path, i) as usize)
            .ok_or(CaravanError::Path)?;
        hex = Hex::new(hex.q + dq, hex.r + dr);
        let (pc, tile) = locate(hex);
        if pc != lands[cur].at {
            // A province already left is never re-entered: the next one
            // must be the next supplied.
            if lands[..entered].iter().any(|l| l.at == pc) {
                return Err(CaravanError::Path);
            }
            match lands.get(entered) {
                Some(l) if l.at == pc => {
                    cur = entered;
                    entered += 1;
                }
                _ => return Err(CaravanError::Path),
            }
        }
        let l = &lands[cur];
        let bit = 1u64 << tile;
        if l.passable & bit == 0 {
            return Err(CaravanError::Path);
        }
        let mut s = if l.rough & bit != 0 {
            ROUGH_HEX_SECS
        } else {
            FLAT_HEX_SECS
        } as u64;
        if l.road & bit != 0 {
            s = s * ROAD_BPS as u64 / BPS_ONE as u64;
        }
        base += s;
        let at =
            base * CARAVAN_SLOW_BPS as u64 / BPS_ONE as u64 * caravan_bps as u64 / BPS_ONE as u64;
        out.push(Step {
            province: pc,
            tile,
            at_secs: u32::try_from(at).map_err(|_| CaravanError::Path)?,
        });
    }
    if entered != lands.len() {
        return Err(CaravanError::Path);
    }
    Ok(out)
}

/// A fastest path for [`walk`] from `origin` to `dst` over `lands` (any
/// order; the origin's must be among them): Dijkstra over the passable
/// tiles by the walk's base step time (rough, road), ties broken by the
/// direction order, so every client finds the same path. Returns the
/// directions and the provinces in first-entered order (the origin's
/// first), as [`walk`] takes them; `None` when no path exists within
/// `MAX_PATH_STEPS` steps and `MAX_PATH_PROVINCES` provinces, or the
/// fastest one would re-enter a province. `origin == dst` is the empty
/// path.
pub fn fastest_path(
    origin: (ProvinceCoord, u8),
    dst: (ProvinceCoord, u8),
    lands: &[Land],
) -> Option<(Vec<u8>, Vec<ProvinceCoord>)> {
    use alloc::collections::{BTreeMap, BinaryHeap};
    use core::cmp::Reverse;
    let land = |pc: ProvinceCoord| lands.iter().find(|l| l.at == pc);
    let start = origin.0.tile(origin.1)?;
    let goal = dst.0.tile(dst.1)?;
    land(origin.0)?;
    if start == goal {
        return Some((Vec::new(), alloc::vec![origin.0]));
    }
    type At = (i32, i32);
    /// The best reach of a hex: its cost, its steps, the hex before it and
    /// the direction taken from there.
    type Reach = (u64, usize, At, u8);
    let key = |h: Hex| -> At { (h.q, h.r) };
    let mut best: BTreeMap<At, Reach> = BTreeMap::new();
    let mut heap = BinaryHeap::new();
    best.insert(key(start), (0, 0, key(start), u8::MAX));
    heap.push(Reverse((0u64, 0usize, key(start))));
    while let Some(Reverse((cost, steps, at))) = heap.pop() {
        if best.get(&at).is_some_and(|b| (b.0, b.1) < (cost, steps)) {
            continue;
        }
        if at == key(goal) {
            break;
        }
        if steps == MAX_PATH_STEPS {
            continue;
        }
        for (d, (dq, dr)) in DIRECTIONS.iter().enumerate() {
            let h = Hex::new(at.0 + dq, at.1 + dr);
            let (pc, tile) = locate(h);
            let Some(l) = land(pc) else { continue };
            let bit = 1u64 << tile;
            if l.passable & bit == 0 {
                continue;
            }
            let mut s = if l.rough & bit != 0 {
                ROUGH_HEX_SECS
            } else {
                FLAT_HEX_SECS
            } as u64;
            if l.road & bit != 0 {
                s = s * ROAD_BPS as u64 / BPS_ONE as u64;
            }
            let c = cost + s;
            let better = match best.get(&key(h)) {
                None => true,
                Some(b) => (c, steps + 1) < (b.0, b.1),
            };
            if better {
                best.insert(key(h), (c, steps + 1, at, d as u8));
                heap.push(Reverse((c, steps + 1, key(h))));
            }
        }
    }
    best.get(&key(goal))?;
    let mut dirs = Vec::new();
    let mut at = key(goal);
    while at != key(start) {
        let (_, _, prev, d) = *best.get(&at)?;
        dirs.push(d);
        at = prev;
    }
    dirs.reverse();
    // The provinces in first-entered order; a re-entry is refused.
    let mut order = alloc::vec![origin.0];
    let mut h = start;
    let mut cur = origin.0;
    for &d in &dirs {
        let (dq, dr) = DIRECTIONS[d as usize];
        h = Hex::new(h.q + dq, h.r + dr);
        let (pc, _) = locate(h);
        if pc != cur {
            if order.contains(&pc) {
                return None;
            }
            order.push(pc);
            cur = pc;
        }
    }
    (order.len() <= MAX_PATH_PROVINCES).then_some((dirs, order))
}

/// The caravan's time in transit (seconds): the last step's.
pub fn travel_secs(steps: &[Step]) -> u32 {
    steps.last().map_or(0, |s| s.at_secs)
}

/// One province's share of a schedule: the caravan stands on `tiles[k]`
/// at the start of bell `first_bell + k`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub province: ProvinceCoord,
    pub first_bell: u32,
    pub tiles: Vec<u8>,
}

/// The bells a caravan departing at `depart_ts` stands on a tile, as runs
/// per province in path order. A bell counts when it starts after the
/// departure and before the arrival (`bell_start(b) − depart_ts <
/// travel_secs`); at its start the caravan stands on the tile of the last
/// step completed (the origin before the first). A province crossed between
/// two bell starts has no run. Refused ([`CaravanError::TooSlow`]) when a
/// run would be longer than [`SLOT_TILES`] or a province would have two
/// runs.
pub fn schedule(
    genesis_ts: i64,
    depart_ts: i64,
    origin: (ProvinceCoord, u8),
    steps: &[Step],
) -> Result<Vec<Run>, CaravanError> {
    let total = travel_secs(steps) as i64;
    let mut runs: Vec<Run> = Vec::new();
    let mut b = bell_at(genesis_ts, depart_ts).saturating_add(1);
    let mut k = 0usize;
    loop {
        let t = bell_start(genesis_ts, b) - depart_ts;
        if t <= 0 {
            b += 1;
            continue;
        }
        if t >= total {
            break;
        }
        while k < steps.len() && (steps[k].at_secs as i64) <= t {
            k += 1;
        }
        let (pc, tile) = if k == 0 {
            origin
        } else {
            (steps[k - 1].province, steps[k - 1].tile)
        };
        match runs.last_mut() {
            Some(r) if r.province == pc => {
                if r.tiles.len() >= SLOT_TILES {
                    return Err(CaravanError::TooSlow);
                }
                r.tiles.push(tile);
            }
            _ => {
                if runs.iter().any(|r| r.province == pc) {
                    return Err(CaravanError::TooSlow);
                }
                runs.push(Run {
                    province: pc,
                    first_bell: b,
                    tiles: alloc::vec![tile],
                });
            }
        }
        b += 1;
    }
    Ok(runs)
}

/// The garrison id of a caravan (contract §2.2): bit 63 set (never a host
/// id, never the camp's `u64::MAX − gen`, whose bits below 16 are not all
/// a sequence), the owner's tag's low 47 bits, the sequence's low 16.
pub const fn caravan_id(owner_tag: u64, seq: u32) -> u64 {
    (1 << 63) | ((owner_tag & 0x7FFF_FFFF_FFFF) << 16) | (seq as u64 & 0xFFFF)
}

/// Whether an id is a caravan's.
pub const fn is_caravan_id(id: u64) -> bool {
    id >> 63 == 1 && id != u64::MAX && id >> 16 != 0xFFFF_FFFF_FFFF
}

/// What a host of `troops` can carry away (milli-units, all resources
/// together).
pub fn carry(troops: MilliTroops) -> Milli {
    (troops as i64).saturating_mul(CARRY_MILLI_PER_TROOP) / 1_000
}

/// The take of a raid: `cargo` split into (taken, left). Everything when
/// it fits in `cap`; else each resource in proportion, rounded down, so
/// the taken total never exceeds `cap`.
pub fn split(cargo: &[Milli; RESOURCES], cap: Milli) -> ([Milli; RESOURCES], [Milli; RESOURCES]) {
    let total: i128 = cargo.iter().map(|&x| x.max(0) as i128).sum();
    let cap = cap.max(0) as i128;
    let mut taken = [0; RESOURCES];
    let mut left = [0; RESOURCES];
    for r in 0..RESOURCES {
        let c = cargo[r].max(0) as i128;
        let t = if total <= cap { c } else { c * cap / total };
        taken[r] = t as Milli;
        left[r] = (c - t) as Milli;
    }
    (taken, left)
}

/// A caravan's record in a Province (contract §1.4; 36 bytes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaravanSlot {
    /// [`caravan_id`]; 0 = free.
    pub id: u64,
    pub faction: u8,
    pub n: u8,
    /// [`RAID_NONE`], [`RAID_SETTLED`] or the bell offset of the raid.
    pub raid_off: u8,
    /// The winning arrival's ClashInputs position.
    pub raid_pos: u8,
    pub first_bell: u32,
    pub tiles: [u8; SLOT_TILES],
    /// What the winning host can carry away (whole units; [`carry`] of its
    /// troops after the clash), recorded with the raid so the raid settles
    /// after its ClashInputs closed.
    pub carry: u32,
    /// The winning host's id.
    pub raider: u64,
}

impl CaravanSlot {
    pub fn decode(b: &[u8]) -> Option<CaravanSlot> {
        if b.len() < SLOT_SIZE {
            return None;
        }
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap_or([0; 4]));
        let u64_at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap_or([0; 8]));
        let mut tiles = [0u8; SLOT_TILES];
        tiles.copy_from_slice(&b[16..16 + SLOT_TILES]);
        Some(CaravanSlot {
            id: u64_at(0),
            faction: b[8],
            n: b[9],
            raid_off: b[10],
            raid_pos: b[11],
            first_bell: u32_at(12),
            tiles,
            carry: u32_at(24),
            raider: u64_at(28),
        })
    }

    pub fn encode(&self, b: &mut [u8]) -> Option<()> {
        if b.len() < SLOT_SIZE {
            return None;
        }
        b[0..8].copy_from_slice(&self.id.to_le_bytes());
        b[8] = self.faction;
        b[9] = self.n;
        b[10] = self.raid_off;
        b[11] = self.raid_pos;
        b[12..16].copy_from_slice(&self.first_bell.to_le_bytes());
        b[16..16 + SLOT_TILES].copy_from_slice(&self.tiles);
        b[24..28].copy_from_slice(&self.carry.to_le_bytes());
        b[28..36].copy_from_slice(&self.raider.to_le_bytes());
        Some(())
    }

    /// A slot written by SendCaravan for `run`.
    pub fn of_run(id: u64, faction: u8, run: &Run) -> Option<CaravanSlot> {
        if run.tiles.is_empty() || run.tiles.len() > SLOT_TILES {
            return None;
        }
        let mut tiles = [0u8; SLOT_TILES];
        tiles[..run.tiles.len()].copy_from_slice(&run.tiles);
        Some(CaravanSlot {
            id,
            faction,
            n: run.tiles.len() as u8,
            raid_off: RAID_NONE,
            raid_pos: 0,
            first_bell: run.first_bell,
            tiles,
            carry: 0,
            raider: 0,
        })
    }

    pub const fn is_free(&self) -> bool {
        self.id == 0
    }

    /// The tile the caravan stands on at bell `b`, if it stands here then
    /// and has not been raided before `b` (a raided caravan's goods are the
    /// raider's to settle; it is not raided twice in one province).
    pub fn tile_at(&self, b: u32) -> Option<u8> {
        if self.id == 0 || b < self.first_bell {
            return None;
        }
        let k = b - self.first_bell;
        if k >= self.n as u32 || (self.raid_off != RAID_NONE) {
            return None;
        }
        self.tiles.get(k as usize).copied()
    }

    /// The last bell the caravan stands here.
    pub fn last_bell(&self) -> u32 {
        self.first_bell + self.n.max(1) as u32 - 1
    }

    /// Whether SendCaravan may take this slot over: free, or every bell
    /// resolved (`resolved_next` is the Province's `RESOLVED_NEXT`) and no
    /// raid left to settle.
    pub fn reusable(&self, resolved_next: u32) -> bool {
        self.id == 0
            || (self.first_bell + self.n as u32 <= resolved_next
                && (self.raid_off == RAID_NONE || self.raid_off == RAID_SETTLED))
    }

    /// Whether a raid waits for its settlement.
    pub const fn raid_open(&self) -> bool {
        self.id != 0 && self.raid_off != RAID_NONE && self.raid_off != RAID_SETTLED
    }
}

/// Canonical bytes of the tables here, for the S1 ruleset hash. Order
/// pinned; append only.
pub fn write_tables(out: &mut Vec<u8>) {
    out.extend_from_slice(&CARAVAN_VERSION.to_le_bytes());
    out.extend_from_slice(&CARAVAN_SLOW_BPS.to_le_bytes());
    out.push(MAX_CARAVAN_SLOTS as u8);
    out.push(SLOT_TILES as u8);
    out.extend_from_slice(&CARRY_MILLI_PER_TROOP.to_le_bytes());
    out.extend_from_slice(&RAID_DECIDE_BELLS.to_le_bytes());
    out.extend_from_slice(&RAID_BURN_AFTER_BELLS.to_le_bytes());
    out.extend_from_slice(&CARAVAN_FEE.to_le_bytes());
    out.push(MAX_VAULTS);
    for x in VAULT_COST {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.extend_from_slice(&VAULT_CAP.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::geometry::{tile_index, tile_offset};

    const ALL: u64 = (1u64 << 61) - 1;
    const G: i64 = 1_790_000_000;

    fn plain(at: ProvinceCoord) -> Land {
        Land {
            at,
            passable: ALL,
            rough: 0,
            road: 0,
        }
    }

    fn centre() -> u8 {
        tile_index(Hex::new(0, 0)).unwrap()
    }

    #[test]
    fn packing_round_trips() {
        let dirs = [0u8, 1, 2, 3, 4, 5, 0, 0, 5, 5, 3];
        let p = pack(&dirs).unwrap();
        for (i, &d) in dirs.iter().enumerate() {
            assert_eq!(dir_of(&p, i), d);
        }
        assert!(pack(&[6]).is_none());
        assert!(pack(&[0; 33]).is_none());
        let full = pack(&[5; 32]).unwrap();
        assert_eq!(dir_of(&full, 31), 5);
    }

    /// The fastest path is one `walk` accepts and ends on the destination:
    /// in one province, around an impassable tile, onto a road, and across
    /// provinces in first-entered order.
    #[test]
    fn fastest_paths_walk() {
        let pc = ProvinceCoord::new(2, 0);
        let c = centre();
        let east = tile_index(Hex::new(3, 0)).unwrap();
        let check = |lands: &[Land], from: (ProvinceCoord, u8), to: (ProvinceCoord, u8)| {
            let (dirs, order) = fastest_path(from, to, lands).expect("a path");
            let ls: Vec<Land> = order
                .iter()
                .map(|o| *lands.iter().find(|l| l.at == *o).unwrap())
                .collect();
            let w = walk(from, &pack(&dirs).unwrap(), dirs.len() as u8, &ls, BPS_ONE).unwrap();
            let last = w.last().unwrap();
            assert_eq!((last.province, last.tile), to);
            (dirs, order, w)
        };
        let (d, o, _) = check(&[plain(pc)], (pc, c), (pc, east));
        assert_eq!((d, o), (alloc::vec![0, 0, 0], alloc::vec![pc]));
        // A wall on the straight line: around it, one step longer.
        let mut walled = plain(pc);
        walled.passable &= !(1u64 << tile_index(Hex::new(2, 0)).unwrap());
        let (d, _, _) = check(&[walled], (pc, c), (pc, east));
        assert_eq!(d.len(), 4);
        // Rough ground on the line and a road around it: the road wins.
        let mut slow = plain(pc);
        for q in 1..=2 {
            slow.rough |= 1u64 << tile_index(Hex::new(q, 0)).unwrap();
        }
        let line = check(&[plain(pc)], (pc, c), (pc, east))
            .2
            .last()
            .unwrap()
            .at_secs;
        let (_, _, w) = check(&[slow], (pc, c), (pc, east));
        assert!(w.last().unwrap().at_secs <= line * 3 / 2);
        // Across the border into the next province.
        let e = pc.tile(east).unwrap();
        let (next, far) = locate(Hex::new(e.q + 3, e.r));
        assert_ne!(next, pc);
        let (_, o, _) = check(&[plain(next), plain(pc)], (pc, c), (next, far));
        assert_eq!(o, alloc::vec![pc, next]);
        // Nothing to walk; no way through.
        assert_eq!(
            fastest_path((pc, c), (pc, c), &[plain(pc)])
                .unwrap()
                .0
                .len(),
            0
        );
        let mut shut = plain(pc);
        shut.passable = 1u64 << c;
        assert!(fastest_path((pc, c), (pc, east), &[shut]).is_none());
        assert!(fastest_path((pc, c), (next, far), &[plain(pc)]).is_none());
    }

    #[test]
    fn a_walk_in_one_province() {
        let pc = ProvinceCoord::new(2, 0);
        let path = pack(&[0, 0, 0]).unwrap();
        let s = walk((pc, centre()), &path, 3, &[plain(pc)], BPS_ONE).unwrap();
        assert_eq!(s.len(), 3);
        // 120 s × 1.5 a step.
        assert_eq!(
            s.iter().map(|x| x.at_secs).collect::<Vec<_>>(),
            [180, 360, 540]
        );
        assert_eq!(s[2].tile, tile_index(Hex::new(3, 0)).unwrap());
        // B Tide's doctrine: ×0.8.
        let b = walk((pc, centre()), &path, 3, &[plain(pc)], 8_000).unwrap();
        assert_eq!(b[2].at_secs, 432);
    }

    #[test]
    fn walks_refuse_bad_paths() {
        let pc = ProvinceCoord::new(2, 0);
        let path = pack(&[0, 0, 0, 0, 0, 0]).unwrap();
        // Leaves the province without the next one supplied.
        assert_eq!(
            walk((pc, centre()), &path, 6, &[plain(pc)], BPS_ONE),
            Err(CaravanError::Path)
        );
        // An impassable tile.
        let mut l = plain(pc);
        l.passable &= !(1u64 << tile_index(Hex::new(1, 0)).unwrap());
        assert_eq!(
            walk((pc, centre()), &pack(&[0]).unwrap(), 1, &[l], BPS_ONE),
            Err(CaravanError::Path)
        );
        // The origin's province must come first; no empty path.
        assert!(walk((pc, centre()), &path, 0, &[plain(pc)], BPS_ONE).is_err());
        assert!(walk(
            (pc, centre()),
            &path,
            1,
            &[plain(ProvinceCoord::new(0, 2))],
            BPS_ONE
        )
        .is_err());
    }

    #[test]
    fn a_walk_across_provinces_and_its_schedule() {
        let a = ProvinceCoord::new(2, 0);
        // Ten steps east from the centre crosses into the next province.
        let path = pack(&[0; 10]).unwrap();
        let start = (a, centre());
        let mut hex = a.tile(centre()).unwrap();
        let mut seen = alloc::vec![a];
        for _ in 0..10 {
            hex = Hex::new(hex.q + 1, hex.r);
            let (pc, _) = locate(hex);
            if !seen.contains(&pc) {
                seen.push(pc);
            }
        }
        assert!(seen.len() >= 2);
        let lands: Vec<Land> = seen.iter().map(|&p| plain(p)).collect();
        let steps = walk(start, &path, 10, &lands, BPS_ONE).unwrap();
        assert_eq!(travel_secs(&steps), 1_800);
        // Departing 1 s after a bell start: bells start at +599, +1199.
        let depart = G + 600 * 10 + 1;
        let runs = schedule(G, depart, start, &steps).unwrap();
        let bells: u32 = runs.iter().map(|r| r.tiles.len() as u32).sum();
        assert_eq!(bells, 3, "bells starting at +599, +1199, +1799 (< 1800)");
        assert_eq!(runs[0].first_bell, 11);
        // The tile at +599 s: 3 steps done (540 s ≤ 599 < 720).
        let third = steps[2];
        assert_eq!(
            (runs[0].province, runs[0].tiles[0]),
            (third.province, third.tile)
        );
    }

    #[test]
    fn schedules_refuse_long_stays_and_revisits() {
        let pc = ProvinceCoord::new(2, 0);
        // Back and forth inside one province: 32 rough steps × 270 s =
        // 8,640 s = more than 8 bells.
        let mut l = plain(pc);
        l.rough = ALL;
        let dirs: Vec<u8> = (0..32).map(|i| if i % 2 == 0 { 0 } else { 3 }).collect();
        let path = pack(&dirs).unwrap();
        let steps = walk((pc, centre()), &path, 32, &[l], BPS_ONE).unwrap();
        assert_eq!(
            schedule(G, G + 1, (pc, centre()), &steps),
            Err(CaravanError::TooSlow)
        );
    }

    #[test]
    fn ids_never_collide_with_hosts_or_the_camp() {
        let id = caravan_id(0xDEAD_BEEF_0123, 7);
        assert!(is_caravan_id(id));
        assert!(!is_caravan_id(u64::MAX));
        assert!(!is_caravan_id(u64::MAX - 3));
        assert!(!is_caravan_id(1 << 40));
        assert_ne!(caravan_id(1, 1), caravan_id(1, 2));
        assert_ne!(caravan_id(1, 1), caravan_id(2, 1));
    }

    #[test]
    fn carry_and_split() {
        assert_eq!(carry(300_000), 30_000, "300 troops carry 30 units");
        let cargo = [0, 100_000, 0, 50_000, 50_000, 0, 0, 0];
        let (t, l) = split(&cargo, 300_000);
        assert_eq!(t, cargo);
        assert_eq!(l, [0; RESOURCES]);
        let (t, l) = split(&cargo, 100_000);
        assert_eq!(t[1], 50_000);
        assert_eq!(t[3], 25_000);
        assert_eq!(t[4], 25_000);
        for r in 0..RESOURCES {
            assert_eq!(t[r] + l[r], cargo[r]);
        }
        assert!(t.iter().sum::<i64>() <= 100_000);
    }

    #[test]
    fn slots_round_trip_and_expose_one_tile_a_bell() {
        let run = Run {
            province: ProvinceCoord::new(1, 1),
            first_bell: 40,
            tiles: alloc::vec![3, 4, 5],
        };
        let mut s = CaravanSlot::of_run(caravan_id(9, 1), 2, &run).unwrap();
        s.carry = 7;
        s.raider = 99;
        let mut b = [0u8; SLOT_SIZE];
        s.encode(&mut b).unwrap();
        assert_eq!(CaravanSlot::decode(&b), Some(s));
        assert_eq!(s.tile_at(39), None);
        assert_eq!(s.tile_at(40), Some(3));
        assert_eq!(s.tile_at(42), Some(5));
        assert_eq!(s.tile_at(43), None);
        assert!(!s.reusable(42));
        assert!(s.reusable(43));
        let mut r = s;
        r.raid_off = 1;
        assert_eq!(r.tile_at(42), None, "raided: no longer here");
        assert!(r.raid_open());
        assert!(!r.reusable(100));
        r.raid_off = RAID_SETTLED;
        assert!(r.reusable(100));
        let _ = tile_offset(0);
    }
}
