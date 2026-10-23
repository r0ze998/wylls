//! Stages 1d and 1e of the redesign: structures — watchtowers, palisades
//! and forts (`docs/frontier/stage1d/S1-1D-CONTRACT.md`,
//! `docs/frontier/stage1e/S1-1E-CONTRACT.md`).
//!
//! A structure stands on one tile of a Province. Its Province keeps every
//! structure in a list of [`StructureEntry`] (not as per-faction masks: a
//! mask cannot be cleared when one of two overlapping works goes), and the
//! readers derive what they need from the list when they read it:
//!
//! * a **tower** covers the tiles of its own Province within
//!   [`TOWER_RANGE`] and **wears down** whoever it stops when their walk is
//!   known — a march when its seal opens (Reveal), a caravan when its route
//!   is fixed. The wear is by the seconds walked in its coverage
//!   ([`wear_bps`]); a march waiting at its destination is never worn
//!   (decision J4). It also watches public events (the herald's feed).
//! * a **palisade** makes its tile impassable to whoever it stops.
//! * a **fort** holds troops and fights, in the clash of its tile, the
//!   factions it stops (the clash model reads it; its troops are kept in
//!   the Province's fort block).
//!
//! **Who a work stops** ([`stops`]): a work of nation `N` stops a walker of
//! faction `f` when `N ≠ f` and N's stance toward `f` is WAR, or when
//! `N = f` and the walker is expelled from its nation. The stances (6 × 6,
//! one-sided) live in the Season; a fresh season's are all WAR.
//!
//! Everything here is a pure function of its inputs; the program, the
//! verifier and the herald call the same code. Numbers marked [phase 6]
//! are placeholders.

use crate::fixed::{Milli, BPS_ONE};
use crate::hex::{Hex, DIRECTIONS};

use super::caravan::{dir_of, Step};
use super::geometry::{locate, ProvinceCoord, TILE_OFFSETS};
use super::holding::RESOURCES;
use super::travel::{CAVALRY_BPS, FLAT_HEX_SECS, MAX_PATH_STEPS, ROAD_BPS, ROUGH_HEX_SECS};

/// Kernel version of this module (`KERNEL_VERSIONS_V3` entry `structure`).
pub const STRUCTURE_VERSION: u16 = 1;

/// Structure kinds (the entry's and the account's `KIND`).
pub const KIND_TOWER: u8 = 1;
pub const KIND_PALISADE: u8 = 2;
pub const KIND_FORT: u8 = 3;
/// Every kind, in code order.
pub const KINDS: [u8; 3] = [KIND_TOWER, KIND_PALISADE, KIND_FORT];

/// Stances (`stance[N][f]`, N's toward `f`).
pub const STANCE_WAR: u8 = 0;
pub const STANCE_PASS: u8 = 1;
/// Behaves as PASS in stage 1 (stage 2's relations read it).
pub const STANCE_ALLY: u8 = 2;
/// Nations (factions) the stance table covers.
pub const NATIONS: usize = 6;
/// The stance table: row `N`, column `f`.
pub type Stances = [u8; NATIONS * NATIONS];

/// Hexes a tower covers around its tile, within its own Province
/// [phase 6].
pub const TOWER_RANGE: i32 = 2;
/// Wear a minute walked in a tower's coverage (bps) [phase 6].
pub const TOWER_WEAR_BPS_PER_MIN: u32 = 100;
/// The most one walk is worn (bps) [phase 6].
pub const TOWER_WEAR_CAP_BPS: u16 = 3_000;
/// Structures a Province may hold (its list's length), every kind.
pub const PROVINCE_STRUCTURES: usize = 12;
/// Forts a Province may hold (its fort block).
pub const PROVINCE_FORTS: usize = 2;
/// Bytes of a [`StructureEntry`].
pub const ENTRY_SIZE: usize = 4;
/// Whole troops a fort may hold [phase 6].
pub const FORT_MAX_TROOPS: u32 = 2_000;

/// Structures of each kind a citizen may own [phase 6].
pub const fn max_of(kind: u8) -> u8 {
    match kind {
        KIND_TOWER => 2,
        KIND_PALISADE => 4,
        KIND_FORT => 1,
        _ => 0,
    }
}

/// A structure's cost (units: wood, stone, arms, gold) [phase 6], paid
/// from one of the owner's holdings.
pub const fn cost_units(kind: u8) -> [i64; RESOURCES] {
    match kind {
        KIND_TOWER => [0, 300, 400, 0, 20, 100, 0, 0],
        KIND_PALISADE => [0, 200, 100, 0, 0, 20, 0, 0],
        KIND_FORT => [0, 500, 800, 0, 50, 200, 0, 0],
        _ => [0; RESOURCES],
    }
}

/// [`cost_units`] in milli-units.
pub fn cost(kind: u8) -> [Milli; RESOURCES] {
    cost_units(kind).map(|x| x * 1_000)
}

/// The tiles a tower on each tile covers: the tiles of the same Province
/// within [`TOWER_RANGE`] hexes (bit = tile index).
pub const COVER: [u64; 61] = {
    let mut t = [0u64; 61];
    let mut a = 0;
    while a < 61 {
        let (aq, ar) = TILE_OFFSETS[a];
        let mut b = 0;
        while b < 61 {
            let (bq, br) = TILE_OFFSETS[b];
            let dq = aq as i32 - bq as i32;
            let dr = ar as i32 - br as i32;
            let ds = -dq - dr;
            let d = (dq.abs() + dr.abs() + ds.abs()) / 2;
            if d <= TOWER_RANGE {
                t[a] |= 1u64 << b;
            }
            b += 1;
        }
        a += 1;
    }
    t
};

/// The tiles a tower on `tile` covers (0 for a tile outside the Province).
pub const fn coverage(tile: u8) -> u64 {
    if (tile as usize) < 61 {
        COVER[tile as usize]
    } else {
        0
    }
}

/// Whether a work of nation `nation` stops a walker of `faction`
/// (`expelled`: the walker is expelled from its nation). A nation outside
/// the table (NEUTRAL) stops nobody; a walker outside it (a free city's
/// garrison never walks) is stopped by every work.
pub fn stops(stances: &Stances, nation: u8, faction: u8, expelled: bool) -> bool {
    let (n, f) = (nation as usize, faction as usize);
    if n >= NATIONS {
        return false;
    }
    if n == f {
        return expelled;
    }
    f >= NATIONS || stances[n * NATIONS + f] == STANCE_WAR
}

/// The stance table of a Season's bytes (`None` when short); an all-zero
/// table is all WAR.
pub fn stances_of(b: &[u8]) -> Option<Stances> {
    b.get(..NATIONS * NATIONS)?.try_into().ok()
}

/// One entry of a Province's structure list (4 bytes: `kind ‖ tile ‖
/// faction ‖ gen`; kind 0 is an empty entry).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StructureEntry {
    pub kind: u8,
    pub tile: u8,
    pub faction: u8,
    pub gen: u8,
}

impl StructureEntry {
    pub const EMPTY: StructureEntry = StructureEntry {
        kind: 0,
        tile: 0,
        faction: 0,
        gen: 0,
    };

    pub const fn live(&self) -> bool {
        self.kind != 0
    }

    /// Reads an entry (`None` for an unknown kind; an empty entry reads as
    /// [`StructureEntry::EMPTY`]).
    pub fn decode(b: &[u8]) -> Option<StructureEntry> {
        let b: &[u8; ENTRY_SIZE] = b.get(..ENTRY_SIZE)?.try_into().ok()?;
        match b[0] {
            0 => Some(StructureEntry::EMPTY),
            KIND_TOWER | KIND_PALISADE | KIND_FORT => Some(StructureEntry {
                kind: b[0],
                tile: b[1],
                faction: b[2],
                gen: b[3],
            }),
            _ => None,
        }
    }

    /// Writes the entry (an empty entry as zeros).
    pub fn encode(&self, b: &mut [u8]) -> Option<()> {
        let b = b.get_mut(..ENTRY_SIZE)?;
        if self.live() {
            b.copy_from_slice(&[self.kind, self.tile, self.faction, self.gen]);
        } else {
            b.fill(0);
        }
        Some(())
    }
}

/// What a walker meets in one Province: the tiles its stopping towers
/// cover (`wear`) and the tiles of its stopping palisades (`block`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Watch {
    pub wear: u64,
    pub block: u64,
}

/// [`Watch`] for a walker of `faction` (`expelled` from its nation) in a
/// Province whose structure list is `list`. A malformed entry does
/// nothing.
pub fn watch(list: &[u8], stances: &Stances, faction: u8, expelled: bool) -> Watch {
    let mut w = Watch::default();
    for e in list.chunks_exact(ENTRY_SIZE).take(PROVINCE_STRUCTURES) {
        let (kind, tile, nation) = (e[0], e[1], e[2]);
        if kind == 0 || kind == KIND_FORT || !stops(stances, nation, faction, expelled) {
            continue;
        }
        if kind == KIND_TOWER {
            w.wear |= coverage(tile);
        } else if kind == KIND_PALISADE && (tile as usize) < 61 {
            w.block |= 1u64 << tile;
        }
    }
    w
}

/// The wear of a walk that spent `secs` seconds in a tower's coverage:
/// [`TOWER_WEAR_BPS_PER_MIN`] a minute (pro rata), at most
/// [`TOWER_WEAR_CAP_BPS`].
pub const fn wear_bps(secs: u32) -> u16 {
    let w = secs as u64 * TOWER_WEAR_BPS_PER_MIN as u64 / 60;
    if w >= TOWER_WEAR_CAP_BPS as u64 {
        TOWER_WEAR_CAP_BPS
    } else {
        w as u16
    }
}

/// `v` worn by `bps`: the loss `⌊v × bps / 10 000⌋` is taken (so the kept
/// part rounds up). `bps` above 10 000 is taken as 10 000.
pub const fn wear(v: u64, bps: u16) -> u64 {
    let b = if bps as u32 > BPS_ONE {
        BPS_ONE as u64
    } else {
        bps as u64
    };
    v - (v as u128 * b as u128 / BPS_ONE as u128) as u64
}

/// [`wear`] for a signed amount (milli-units of a cargo; negative and
/// zero amounts are kept).
pub const fn wear_i64(v: i64, bps: u16) -> i64 {
    if v <= 0 {
        v
    } else {
        wear(v as u64, bps) as i64
    }
}

/// One Province a march's walk may enter, for [`march_watch`]: its rough
/// and road masks and what the walker meets there ([`watch`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchedLand {
    pub at: ProvinceCoord,
    pub rough: u64,
    pub road: u64,
    pub watch: Watch,
}

/// What a walk meets: the seconds in a tower's coverage, or a palisade
/// that stops it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Walked {
    /// The seconds walked in coverage.
    Secs(u32),
    /// A step enters a stopping palisade's tile.
    Blocked,
}

/// What a march meets on its path (`steps` packed directions, as the
/// seal's `path`) from `origin`: [`Walked::Blocked`] when a step enters a
/// palisade's tile that stops it, else the seconds of the steps that enter
/// a covered tile (`travel::hex_secs`: 120 s flat, 180 s rough, halved on a
/// road, halved mounted; before the doctrine's bias). The origin tile does
/// not count; the destination does. `None` when a step enters a Province
/// not in `lands` or the path is longer than `MAX_PATH_STEPS` (the program
/// refuses such a walk first). Passability is the walk's own check.
pub fn march_watch(
    origin: (ProvinceCoord, u8),
    path: &[u8; 12],
    steps: u8,
    lands: &[WatchedLand],
    cavalry: bool,
) -> Option<Walked> {
    if steps as usize > MAX_PATH_STEPS {
        return None;
    }
    let mut hex: Hex = origin.0.tile(origin.1)?;
    let mut secs = 0u32;
    let mut blocked = false;
    for i in 0..steps as usize {
        let (dq, dr) = *DIRECTIONS.get(dir_of(path, i) as usize)?;
        hex = Hex::new(hex.q + dq, hex.r + dr);
        let (pc, tile) = locate(hex);
        let l = lands.iter().find(|l| l.at == pc)?;
        let bit = 1u64 << tile;
        if l.watch.block & bit != 0 {
            blocked = true;
        }
        if l.watch.wear & bit == 0 {
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
        if cavalry {
            s = s * CAVALRY_BPS as u64 / BPS_ONE as u64;
        }
        secs = secs.saturating_add(s as u32);
    }
    Some(if blocked {
        Walked::Blocked
    } else {
        Walked::Secs(secs)
    })
}

/// What a caravan's walk (`caravan::walk`) meets: blocked when a step
/// ends on a stopping palisade's tile, else the seconds of the steps that
/// end on a covered tile (each the time since the step before; the first
/// step's from the departure). `watch` gives a Province's [`Watch`].
pub fn caravan_watch(steps: &[Step], watch: impl Fn(ProvinceCoord) -> Watch) -> Walked {
    let mut secs = 0u32;
    let mut prev = 0u32;
    for s in steps {
        let w = watch(s.province);
        let bit = 1u64 << s.tile;
        if w.block & bit != 0 {
            return Walked::Blocked;
        }
        if w.wear & bit != 0 {
            secs = secs.saturating_add(s.at_secs.saturating_sub(prev));
        }
        prev = s.at_secs;
    }
    Walked::Secs(secs)
}

/// Canonical bytes of the tables here, for the S1 ruleset hash. Order
/// pinned; append only.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&STRUCTURE_VERSION.to_le_bytes());
    out.extend_from_slice(&TOWER_RANGE.to_le_bytes());
    out.extend_from_slice(&TOWER_WEAR_BPS_PER_MIN.to_le_bytes());
    out.extend_from_slice(&TOWER_WEAR_CAP_BPS.to_le_bytes());
    out.push(PROVINCE_STRUCTURES as u8);
    out.push(PROVINCE_FORTS as u8);
    out.extend_from_slice(&FORT_MAX_TROOPS.to_le_bytes());
    for k in KINDS {
        out.push(k);
        out.push(max_of(k));
        for x in cost_units(k) {
            out.extend_from_slice(&x.to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::geometry::{tile_index, tile_offset};
    use crate::hex::hexes_within;

    const WAR: Stances = [STANCE_WAR; 36];

    /// The centre's coverage is the full radius-2 disc (19 tiles); a corner
    /// is clipped to the Province; coverage is symmetric (a sees b iff b
    /// sees a) and always contains the tower's own tile.
    #[test]
    fn coverage_is_a_clipped_disc() {
        let centre = tile_index(Hex::new(0, 0)).unwrap();
        assert_eq!(coverage(centre).count_ones(), 19);
        let corner = tile_index(Hex::new(4, 0)).unwrap();
        assert_eq!(coverage(corner).count_ones(), 9);
        for a in 0..61u8 {
            assert!(coverage(a) & (1 << a) != 0);
            for b in 0..61u8 {
                assert_eq!(
                    coverage(a) >> b & 1,
                    coverage(b) >> a & 1,
                    "symmetric {a} {b}"
                );
                let d = tile_offset(a).unwrap().distance(tile_offset(b).unwrap());
                assert_eq!(coverage(a) >> b & 1 == 1, d as i32 <= TOWER_RANGE);
            }
        }
        assert_eq!(coverage(61), 0);
        assert_eq!(hexes_within(2).len(), 19);
    }

    /// The stop rule: war stops, pass and ally let through, a nation never
    /// stops its own members unless expelled, NEUTRAL stops nobody.
    #[test]
    fn the_stop_rule() {
        let mut s = WAR;
        assert!(stops(&s, 1, 2, false));
        s[NATIONS + 2] = STANCE_PASS;
        assert!(!stops(&s, 1, 2, false));
        s[NATIONS + 2] = STANCE_ALLY;
        assert!(!stops(&s, 1, 2, false));
        assert!(stops(&s, 2, 1, false), "one-sided");
        assert!(!stops(&s, 1, 1, false));
        assert!(stops(&s, 1, 1, true), "the nation's expelled");
        assert!(!stops(&s, 6, 1, false), "NEUTRAL stops nobody");
        assert!(stops(&s, 1, 6, false));
        assert_eq!(stances_of(&[0u8; 40]), Some(WAR));
        assert_eq!(stances_of(&[0u8; 35]), None);
    }

    /// The watch: towers of stopping nations cover, palisades of stopping
    /// nations block, a fort does neither, malformed entries do nothing.
    #[test]
    fn the_watch_of_a_list() {
        let mut list = [0u8; PROVINCE_STRUCTURES * ENTRY_SIZE];
        let e = |kind, tile, faction| StructureEntry {
            kind,
            tile,
            faction,
            gen: 1,
        };
        e(KIND_TOWER, 30, 1).encode(&mut list[0..4]).unwrap();
        e(KIND_PALISADE, 10, 2).encode(&mut list[4..8]).unwrap();
        e(KIND_FORT, 20, 2).encode(&mut list[8..12]).unwrap();
        list[12..16].copy_from_slice(&[9, 5, 2, 1]);
        let w = watch(&list, &WAR, 0, false);
        assert_eq!(w.wear, coverage(30));
        assert_eq!(w.block, 1 << 10);
        assert_eq!(watch(&list, &WAR, 1, false).wear, 0, "its own tower");
        assert_eq!(watch(&list, &WAR, 1, true).wear, coverage(30), "expelled");
        let mut pass = WAR;
        pass[2 * NATIONS] = STANCE_PASS;
        assert_eq!(watch(&list, &pass, 0, false).block, 0, "let through");
        assert_eq!(
            StructureEntry::decode(&list[4..8]),
            Some(e(KIND_PALISADE, 10, 2))
        );
        assert_eq!(StructureEntry::decode(&list[12..16]), None);
        assert_eq!(StructureEntry::decode(&[0; 4]), Some(StructureEntry::EMPTY));
    }

    #[test]
    fn wear_rules() {
        assert_eq!(wear_bps(0), 0);
        assert_eq!(wear_bps(120), 200, "a flat step: 2 %");
        assert_eq!(wear_bps(90), 150);
        assert_eq!(wear_bps(10_000), TOWER_WEAR_CAP_BPS);
        assert_eq!(wear(1_000, 0), 1_000);
        assert_eq!(wear(1_000, 250), 975);
        assert_eq!(wear(3, 5_000), 2, "the loss rounds down");
        assert_eq!(wear(1_000, 20_000), 0);
        assert_eq!(wear_i64(-5, 5_000), -5);
        assert_eq!(wear_i64(10_000, 1_000), 9_000);
        assert_eq!(cost(KIND_TOWER)[2], 400_000);
        assert_eq!(max_of(KIND_FORT), 1);
        assert_eq!(max_of(0), 0);
    }

    /// A march walked straight through a tower's disc counts the covered
    /// steps only; mounted halves it; a road halves it; a palisade on the
    /// line blocks it.
    #[test]
    fn march_counts_the_covered_steps() {
        let pc = ProvinceCoord::new(4, 0);
        let at = |q, r| tile_index(Hex::new(q, r)).unwrap();
        assert_eq!(DIRECTIONS[0], (1, 0));
        let path = super::super::caravan::pack(&[0; 8]).unwrap();
        let land = |road, block| WatchedLand {
            at: pc,
            rough: 0,
            road,
            watch: Watch {
                wear: coverage(at(0, 0)),
                block,
            },
        };
        let go = |n, l: WatchedLand, cav| march_watch((pc, at(-4, 0)), &path, n, &[l], cav);
        assert_eq!(go(8, land(0, 0), false), Some(Walked::Secs(600)));
        assert_eq!(go(8, land(0, 0), true), Some(Walked::Secs(300)));
        assert_eq!(go(8, land(u64::MAX, 0), false), Some(Walked::Secs(300)));
        assert_eq!(go(3, land(0, 0), false), Some(Walked::Secs(240)));
        assert_eq!(go(8, land(0, 1 << at(3, 0)), false), Some(Walked::Blocked));
        assert_eq!(
            go(2, land(0, 1 << at(3, 0)), false),
            Some(Walked::Secs(120)),
            "the palisade is beyond the walk (one step in range)"
        );
        assert_eq!(march_watch((pc, at(-4, 0)), &path, 8, &[], false), None);
    }

    #[test]
    fn caravan_counts_the_covered_steps() {
        let pc = ProvinceCoord::new(4, 0);
        let step = |tile, at_secs| Step {
            province: pc,
            tile,
            at_secs,
        };
        let steps = [step(1, 180), step(2, 450), step(3, 630)];
        let w = |wear, block| move |_| Watch { wear, block };
        assert_eq!(
            caravan_watch(&steps, w((1 << 2) | (1 << 3), 0)),
            Walked::Secs(270 + 180)
        );
        assert_eq!(caravan_watch(&steps, w(0, 0)), Walked::Secs(0));
        assert_eq!(caravan_watch(&steps, w(0, 1 << 3)), Walked::Blocked);
    }
}
