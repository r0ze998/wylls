//! Stage 1d of the redesign: watchtowers (`docs/frontier/stage1d/S1-1D-CONTRACT.md`).
//!
//! A tower stands on a tile and covers the tiles of its own Province
//! within [`TOWER_RANGE`]. Until zk hides marches it cannot see a sealed
//! march on the road (plan B of `13-hidden-information` §6-1), so it does
//! two things that work with the seals as they are: it watches public
//! events in its range (the herald's feed), and it **wears down** whoever
//! walks through its range once the walk is known — a march when its seal
//! opens (Reveal), a caravan when its route is fixed (send or take). The
//! wear is by the seconds walked in hostile coverage ([`wear_bps`]); a
//! march waiting at its destination is off the road and never worn
//! (decision J4).
//!
//! The Province keeps its towers as a list of [`TowerEntry`] (not as
//! per-faction masks: a mask cannot be cleared when one of two overlapping
//! towers goes); [`hostile`] derives the coverage when it is read.
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

/// Kernel version of this module (`KERNEL_VERSIONS_V3` entry `tower`).
pub const TOWER_VERSION: u16 = 1;

/// Hexes a tower covers around its tile, within its own Province
/// [phase 6].
pub const TOWER_RANGE: i32 = 2;
/// Wear a minute walked in hostile coverage (bps) [phase 6].
pub const TOWER_WEAR_BPS_PER_MIN: u32 = 100;
/// The most one walk is worn (bps) [phase 6].
pub const TOWER_WEAR_CAP_BPS: u16 = 3_000;
/// Towers a citizen may own [phase 6].
pub const MAX_TOWERS: u8 = 2;
/// Live towers a Province may hold (its list's length).
pub const PROVINCE_TOWERS: usize = 12;
/// Bytes of a [`TowerEntry`].
pub const ENTRY_SIZE: usize = 4;
/// A tower's cost (units: wood, stone, arms, gold) [phase 6], paid from
/// one of the owner's holdings.
pub const TOWER_COST: [i64; RESOURCES] = [0, 300, 400, 0, 20, 100, 0, 0];

/// The tower's cost in milli-units.
pub fn tower_cost() -> [Milli; RESOURCES] {
    TOWER_COST.map(|x| x * 1_000)
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

/// One entry of a Province's tower list (4 bytes: `state ‖ tile ‖ faction
/// ‖ gen`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TowerEntry {
    pub live: bool,
    pub tile: u8,
    pub faction: u8,
    pub gen: u8,
}

/// `STATE` of a live entry.
pub const ENTRY_LIVE: u8 = 1;

impl TowerEntry {
    /// Reads an entry (`None` for a state other than 0 or 1).
    pub fn decode(b: &[u8]) -> Option<TowerEntry> {
        let b: &[u8; ENTRY_SIZE] = b.get(..ENTRY_SIZE)?.try_into().ok()?;
        match b[0] {
            0 => Some(TowerEntry::default()),
            ENTRY_LIVE => Some(TowerEntry {
                live: true,
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
        if self.live {
            b.copy_from_slice(&[ENTRY_LIVE, self.tile, self.faction, self.gen]);
        } else {
            b.fill(0);
        }
        Some(())
    }
}

/// The hostile coverage for a walker of `faction` in a Province whose
/// tower list is `list` (`PROVINCE_TOWERS × ENTRY_SIZE` bytes): the union
/// of the coverage of its live towers of every other faction. A malformed
/// entry covers nothing.
pub fn hostile(list: &[u8], faction: u8) -> u64 {
    let mut m = 0u64;
    for e in list.chunks_exact(ENTRY_SIZE).take(PROVINCE_TOWERS) {
        if e[0] == ENTRY_LIVE && e[2] != faction {
            m |= coverage(e[1]);
        }
    }
    m
}

/// The wear of a walk that spent `secs` seconds in hostile coverage:
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

/// One Province a march's walk may enter, for [`march_secs_in_range`]:
/// its rough and road masks and the hostile coverage there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchedLand {
    pub at: ProvinceCoord,
    pub rough: u64,
    pub road: u64,
    pub cover: u64,
}

/// The seconds a march walks in hostile coverage: its path (`steps`
/// packed directions, as the seal's `path`) from `origin`, each step that
/// enters a covered tile counting its step time (`travel::hex_secs`: 120 s
/// flat, 180 s rough, halved on a road, halved mounted; before the
/// doctrine's bias). The origin tile does not count; the destination
/// does. `None` when a step enters a Province not in `lands` or the path
/// is longer than `MAX_PATH_STEPS` (the program refuses such a walk
/// first). Passability is the walk's own check, not this one's.
pub fn march_secs_in_range(
    origin: (ProvinceCoord, u8),
    path: &[u8; 12],
    steps: u8,
    lands: &[WatchedLand],
    cavalry: bool,
) -> Option<u32> {
    if steps as usize > MAX_PATH_STEPS {
        return None;
    }
    let mut hex: Hex = origin.0.tile(origin.1)?;
    let mut secs = 0u32;
    for i in 0..steps as usize {
        let (dq, dr) = *DIRECTIONS.get(dir_of(path, i) as usize)?;
        hex = Hex::new(hex.q + dq, hex.r + dr);
        let (pc, tile) = locate(hex);
        let l = lands.iter().find(|l| l.at == pc)?;
        let bit = 1u64 << tile;
        if l.cover & bit == 0 {
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
    Some(secs)
}

/// The seconds a caravan walks in hostile coverage: each step of its walk
/// (`caravan::walk`) that ends on a covered tile counts the time since the
/// step before (the first step's from the departure). `cover` gives the
/// hostile coverage of a Province (0 where none).
pub fn caravan_secs_in_range(steps: &[Step], cover: impl Fn(ProvinceCoord) -> u64) -> u32 {
    let mut secs = 0u32;
    let mut prev = 0u32;
    for s in steps {
        if cover(s.province) & (1u64 << s.tile) != 0 {
            secs = secs.saturating_add(s.at_secs.saturating_sub(prev));
        }
        prev = s.at_secs;
    }
    secs
}

/// Canonical bytes of the tables here, for the S1 ruleset hash. Order
/// pinned; append only.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&TOWER_VERSION.to_le_bytes());
    out.extend_from_slice(&TOWER_RANGE.to_le_bytes());
    out.extend_from_slice(&TOWER_WEAR_BPS_PER_MIN.to_le_bytes());
    out.extend_from_slice(&TOWER_WEAR_CAP_BPS.to_le_bytes());
    out.push(MAX_TOWERS);
    out.push(PROVINCE_TOWERS as u8);
    for x in TOWER_COST {
        out.extend_from_slice(&x.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::geometry::{tile_index, tile_offset};
    use crate::hex::hexes_within;

    /// The centre's coverage is the full radius-2 disc (19 tiles); a corner
    /// is clipped to the Province; coverage is symmetric (a sees b iff b
    /// sees a) and always contains the tower's own tile.
    #[test]
    fn coverage_is_a_clipped_disc() {
        let centre = tile_index(Hex::new(0, 0)).unwrap();
        assert_eq!(coverage(centre).count_ones(), 19);
        let corner = tile_index(Hex::new(4, 0)).unwrap();
        assert!(coverage(corner).count_ones() < 19);
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

    /// Hostile coverage: only live towers of other factions.
    #[test]
    fn hostile_takes_other_factions() {
        let mut list = [0u8; PROVINCE_TOWERS * ENTRY_SIZE];
        let t = |tile, faction| TowerEntry {
            live: true,
            tile,
            faction,
            gen: 1,
        };
        t(30, 1).encode(&mut list[0..4]).unwrap();
        t(10, 2).encode(&mut list[8..12]).unwrap();
        assert_eq!(hostile(&list, 1), coverage(10));
        assert_eq!(hostile(&list, 2), coverage(30));
        assert_eq!(hostile(&list, 0), coverage(10) | coverage(30));
        assert_eq!(hostile(&[0u8; 48], 0), 0);
        assert_eq!(
            TowerEntry::decode(&list[8..12]),
            Some(t(10, 2)),
            "round trip"
        );
        assert_eq!(TowerEntry::decode(&[2, 0, 0, 0]), None);
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
    }

    /// A march walked straight through a tower's disc from outside counts
    /// the covered steps only; mounted halves it; a road halves it.
    #[test]
    fn march_counts_the_covered_steps() {
        let pc = ProvinceCoord::new(4, 0);
        let at = |q, r| tile_index(Hex::new(q, r)).unwrap();
        // From (-4, 0) eastwards (direction 0 is +q) to (4, 0): 8 steps.
        assert_eq!(DIRECTIONS[0], (1, 0));
        let path = super::super::caravan::pack(&[0; 8]).unwrap();
        let cover = coverage(at(0, 0));
        let land = |road| WatchedLand {
            at: pc,
            rough: 0,
            road,
            cover,
        };
        // The covered tiles on the line: q = -2..=2, five steps × 120 s.
        let s = march_secs_in_range((pc, at(-4, 0)), &path, 8, &[land(0)], false);
        assert_eq!(s, Some(600));
        let s = march_secs_in_range((pc, at(-4, 0)), &path, 8, &[land(0)], true);
        assert_eq!(s, Some(300));
        let s = march_secs_in_range((pc, at(-4, 0)), &path, 8, &[land(u64::MAX)], false);
        assert_eq!(s, Some(300));
        // An unknown province.
        assert_eq!(
            march_secs_in_range((pc, at(-4, 0)), &path, 8, &[], false),
            None
        );
        // Ending in range: from (-4, 0) to (-1, 0), covered -2 and -1.
        let s = march_secs_in_range((pc, at(-4, 0)), &path, 3, &[land(0)], false);
        assert_eq!(s, Some(240));
    }

    #[test]
    fn caravan_counts_the_covered_steps() {
        let pc = ProvinceCoord::new(4, 0);
        let steps = [
            Step {
                province: pc,
                tile: 1,
                at_secs: 180,
            },
            Step {
                province: pc,
                tile: 2,
                at_secs: 450,
            },
            Step {
                province: pc,
                tile: 3,
                at_secs: 630,
            },
        ];
        let c = |_| (1u64 << 2) | (1 << 3);
        assert_eq!(caravan_secs_in_range(&steps, c), 270 + 180);
        assert_eq!(caravan_secs_in_range(&steps, |_| 0), 0);
    }
}
