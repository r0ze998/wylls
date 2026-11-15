//! **Land (preview, opt-in feature `land-preview`)**: "Standing Ground" in a
//! reduced form. Land a nation holds tile by tile inside a province, which
//! grows where its hosts stand and is taken where a hostile host stands.
//!
//! The owner asked on 2026-10-10 for land that becomes yours as you move;
//! the banner rule's labelled prototype (`permutation-gateway/screens/
//! claims.mjs`) showed it in the sample world only. This module is that
//! rule's first kernel: pure, integer-only, no clock, no state of its own,
//! driven only by records the program already keeps (the site mirror, the
//! roster, the keep and the passable mask). It is **off by default**: with
//! the feature off nothing here is compiled, so no default-build code,
//! vector, hash input or budget changes, and no natural world's rule
//! changes. Nothing here is bound into any `ruleset_hash`.
//!
//! The rule, once per resolved bell `b` (`fold`, strictly in bell order):
//!
//! 1. **Village land.** Every holding's worked-radius disc
//!    ([`Tier::worked_radius`]: 1, 2, 2, 3) on passable ground is land of
//!    the holding's nation; where two discs meet the nearer site takes the
//!    tile, then the lower site index. Village land is made anew from the
//!    site mirror every bell, so a village **captured** by the program's own
//!    siege (SettleCapture flips the mirror's faction) carries its land to
//!    the captor, and a released village's land falls open. Village land is
//!    never taken by standing: only by taking the village.
//! 2. **Growth as you move.** A host *stands* when it is in the roster,
//!    has no pending order, fights (not a scout or settler) and has at
//!    least [`LandParams::floor_troops`]. A host of nation `f` that has
//!    stood [`LandParams::stand_bells`] on a tile that is open or `f`'s, and
//!    touches `f`'s land (or `f`'s keep), claims that tile and every open
//!    passable neighbour on which, and next to which, no hostile host
//!    stands. March on, stand again at the new edge, and the land follows.
//! 3. **Taking land.** A host of `f` standing on another nation `g`'s
//!    claimed (not village) land, with no host of `g` on the tile or next to
//!    it, presses the tile one bell; at [`LandParams::seize_bells`] the
//!    tile and its undefended claimed neighbours of `g` become `f`'s. A
//!    defender beside it, or the attacker leaving, breaks the count.
//! 4. **Cut off land.** Claimed land no longer joined (through its own
//!    nation's tiles) to that nation's village land, keep or a standing
//!    host of it frays one bell at a time and falls open at
//!    [`LandParams::fray_bells`].
//! 5. **Heartland.** In a nation's heartland a stranger claims, presses
//!    and denies nothing (as the keep: heartland progress never counts).
//!
//! **What land pays** ([`production_with_land`]): every holding of `f` in
//! the province produces `bonus_bps = min(claimed_f × per_tile_bps /
//! villages_f, cap_bps)` more on top of its tier's base production. Land
//! abroad, where `f` has no village, pays nothing in goods (it still
//! counts tiles for standings).

use super::geometry::{tile_index, tile_offset, PROVINCE_TILES, SITES_PER_PROVINCE};
use super::holding::{Tier, RESOURCES};
use crate::fixed::MilliTroops;
use crate::hex::Hex;

/// Version of this kernel (preview; bump on any honest-outcome change).
pub const LAND_VERSION: u16 = 1;
/// The rule's name, as a world preset announces it.
pub const LAND_RULE: &str = "standing-ground-lite-v1";
/// An open tile.
pub const OPEN: u8 = 0xFF;
/// No nation pressing.
pub const NOBODY: u8 = 0xFF;
const N: usize = PROVINCE_TILES;

/// The numbers of the rule. One table; a preset picks one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LandParams {
    /// Bells a host must have stood to claim (≥ 1).
    pub stand_bells: u32,
    /// Bells of pressing to take a claimed tile (≥ 1, ≤ 255).
    pub seize_bells: u8,
    /// Bells cut-off land lasts before it falls open (≥ 1, ≤ 255).
    pub fray_bells: u8,
    /// Least troops of a host that claims or presses (milli).
    pub floor_troops: MilliTroops,
    /// Production bonus per claimed tile, basis points.
    pub per_tile_bps: u32,
    /// Largest production bonus, basis points.
    pub cap_bps: u32,
}

impl LandParams {
    /// The preview's numbers: one hour of standing claims, half a day of
    /// pressing takes, six hours cut off falls; 2% a tile, at most 30%.
    pub const PREVIEW: LandParams = LandParams {
        stand_bells: 6,
        seize_bells: 72,
        fray_bells: 36,
        floor_troops: 100_000,
        per_tile_bps: 200,
        cap_bps: 3_000,
    };
    /// Short numbers for tests and compressed test worlds only.
    pub const TEST: LandParams = LandParams {
        stand_bells: 2,
        seize_bells: 4,
        fray_bells: 3,
        floor_troops: 100_000,
        per_tile_bps: 200,
        cap_bps: 3_000,
    };
    /// `Err` names the first bad field.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.stand_bells == 0 {
            return Err("stand_bells");
        }
        if self.seize_bells == 0 {
            return Err("seize_bells");
        }
        if self.fray_bells == 0 {
            return Err("fray_bells");
        }
        if self.cap_bps > 10_000 {
            return Err("cap_bps");
        }
        Ok(())
    }
}

/// A site of the province as the fold reads it (from `SITES` and the site
/// mirror): `tile` 0..61 (or [`OPEN`] for an unused slot), and the holding's
/// nation and tier when a holding stands there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiteIn {
    pub tile: u8,
    pub holding: Option<(u8, Tier)>,
}

impl SiteIn {
    pub const NONE: SiteIn = SiteIn { tile: OPEN, holding: None };
}

/// A host of the roster as the fold reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostIn {
    pub id: u64,
    pub faction: u8,
    pub tile: u8,
    pub troops: MilliTroops,
    /// Not a scout or settler.
    pub fights: bool,
    /// In the roster with no pending order.
    pub resident: bool,
    /// The bell it stands from (`from_bell`).
    pub from_bell: u32,
}

/// One bell's inputs.
#[derive(Clone, Copy, Debug)]
pub struct BellIn<'a> {
    pub sites: &'a [SiteIn; SITES_PER_PROVINCE],
    pub hosts: &'a [HostIn],
    /// `(tile, holder)` of the province's keep.
    pub keep: Option<(u8, u8)>,
    /// Bit `t` set: tile `t` passable.
    pub passable: u64,
    /// The nation whose heartland this province is.
    pub heartland_of: Option<u8>,
    /// `outside[f]` bit `t`: tile `t` touches land of nation `f` in a
    /// neighbouring province (read from that province's land record), so
    /// land grows across province borders and stays joined across them.
    pub outside: [u64; 6],
}

/// A province's land record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Land {
    /// The first bell not yet folded.
    pub next_bell: u32,
    /// Nation 0..5, or [`OPEN`].
    pub owner: [u8; N],
    /// Bit `t`: tile `t` is village land (made anew each bell).
    pub village: u64,
    /// The nation pressing tile `t`, or [`NOBODY`].
    pub by: [u8; N],
    /// Bells of pressing (or of fraying, `by == owner`).
    pub count: [u8; N],
}

/// Why a fold was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LandError {
    /// The bell is not `next_bell`.
    OutOfOrder,
    /// A site, host or keep names a tile outside 0..61 or a nation above 5.
    BadInput,
}

/// What a fold did, for logs and tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub claimed: u32,
    pub seized: u32,
    pub frayed: u32,
}

const fn bit(m: u64, t: usize) -> bool {
    (m >> t) & 1 == 1
}

/// The tiles next to `t` inside its province.
pub fn neighbours(t: u8) -> impl Iterator<Item = u8> {
    let h = tile_offset(t).unwrap_or(Hex::ORIGIN);
    h.neighbors().into_iter().filter_map(tile_index)
}

/// Steps between two tiles of one province.
pub fn steps(a: u8, b: u8) -> u32 {
    match (tile_offset(a), tile_offset(b)) {
        (Some(x), Some(y)) => x.distance(y),
        _ => u32::MAX,
    }
}

impl Land {
    /// A province's land with nothing held, counting from bell `bell`.
    pub const fn new(bell: u32) -> Land {
        Land { next_bell: bell, owner: [OPEN; N], village: 0, by: [NOBODY; N], count: [0; N] }
    }

    /// Tiles of nation `f` (village land and claimed).
    pub fn tiles_of(&self, f: u8) -> u32 {
        self.owner.iter().filter(|&&o| o == f).count() as u32
    }
    /// Claimed (not village) tiles of nation `f`.
    pub fn claimed_of(&self, f: u8) -> u32 {
        (0..N).filter(|&t| self.owner[t] == f && !bit(self.village, t)).count() as u32
    }
    /// Is `t` village land?
    pub fn is_village(&self, t: u8) -> bool {
        (t as usize) < N && bit(self.village, t as usize)
    }

    /// Folds bell `b` (must be `next_bell`); `Ok` with what changed.
    pub fn fold(&mut self, b: u32, x: &BellIn, p: &LandParams) -> Result<Changes, LandError> {
        if b != self.next_bell {
            return Err(LandError::OutOfOrder);
        }
        check(x)?;
        let mut ch = Changes::default();
        self.villages(x);
        let standing: alloc::vec::Vec<HostIn> = {
            let mut v: alloc::vec::Vec<HostIn> =
                x.hosts.iter().copied().filter(|h| stands(h, b, p)).collect();
            v.sort_by_key(|h| (h.tile, h.id));
            v
        };
        let stranger = |f: u8| x.heartland_of.is_some_and(|g| g != f);
        // what is pressed this bell: (tile, nation)
        let mut pressed = [NOBODY; N];
        for h in &standing {
            if stranger(h.faction) {
                continue;
            }
            let t = h.tile as usize;
            let o = self.owner[t];
            if o == OPEN || o == h.faction {
                if b.saturating_sub(h.from_bell) < p.stand_bells || !self.touches(h.tile, h.faction, x) {
                    continue;
                }
                if o == OPEN && bit(x.passable, t) {
                    self.take(t, h.faction);
                    ch.claimed += 1;
                }
                for j in neighbours(h.tile) {
                    let j = j as usize;
                    if self.owner[j] != OPEN || !bit(x.passable, j) || self.denied(j as u8, h.faction, x, &standing) {
                        continue;
                    }
                    self.take(j, h.faction);
                    ch.claimed += 1;
                }
            } else if !bit(self.village, t) && !stranger(h.faction) && !self.defended(h.tile, o, &standing) {
                pressed[t] = h.faction;
            }
        }
        // the presses: count on, break, or take
        for t in 0..N {
            let f = pressed[t];
            if f == NOBODY {
                if self.by[t] != NOBODY && self.by[t] != self.owner[t] {
                    self.by[t] = NOBODY;
                    self.count[t] = 0;
                }
                continue;
            }
            if self.by[t] == f {
                self.count[t] = self.count[t].saturating_add(1);
            } else {
                self.by[t] = f;
                self.count[t] = 1;
            }
            if self.count[t] >= p.seize_bells {
                let g = self.owner[t];
                self.take(t, f);
                ch.seized += 1;
                for j in neighbours(t as u8) {
                    let j = j as usize;
                    if self.owner[j] == g && !bit(self.village, j) && !self.defended(j as u8, g, &standing) {
                        self.take(j, f);
                        ch.seized += 1;
                    }
                }
            }
        }
        ch.frayed = self.fray(x, &standing, p);
        self.next_bell = b + 1;
        Ok(ch)
    }

    fn take(&mut self, t: usize, f: u8) {
        self.owner[t] = f;
        self.by[t] = NOBODY;
        self.count[t] = 0;
    }

    /// Village land made anew from the site mirror.
    fn villages(&mut self, x: &BellIn) {
        let mut best: [(u32, usize, u8); N] = [(u32::MAX, usize::MAX, OPEN); N];
        for (i, s) in x.sites.iter().enumerate() {
            let Some((f, tier)) = s.holding else { continue };
            if s.tile as usize >= N {
                continue;
            }
            let r = tier.worked_radius();
            for (t, slot) in best.iter_mut().enumerate() {
                let d = steps(s.tile, t as u8);
                if d > r || (d > 0 && !bit(x.passable, t)) {
                    continue;
                }
                if (d, i) < (slot.0, slot.1) {
                    *slot = (d, i, f);
                }
            }
        }
        let old = self.village;
        let mut now = 0u64;
        for (t, &(_, _, f)) in best.iter().enumerate() {
            if f != OPEN {
                now |= 1 << t;
                if self.owner[t] != f {
                    self.take(t, f);
                }
            } else if bit(old, t) {
                // village land with no village any more falls open
                self.take(t, OPEN);
                self.owner[t] = OPEN;
            }
        }
        self.village = now;
    }

    /// Does `t` touch land (or the keep) of `f`?
    fn touches(&self, t: u8, f: u8, x: &BellIn) -> bool {
        if self.owner[t as usize] == f || x.keep == Some((t, f)) || bit(x.outside[f as usize], t as usize) {
            return true;
        }
        neighbours(t).any(|j| self.owner[j as usize] == f || x.keep == Some((j, f)))
    }

    /// A hostile host of `f` stands on `t` or next to it.
    fn denied(&self, t: u8, f: u8, x: &BellIn, standing: &[HostIn]) -> bool {
        let stranger = |g: u8| x.heartland_of.is_some_and(|h| h != g);
        standing.iter().any(|h| h.faction != f && !stranger(h.faction) && (h.tile == t || steps(h.tile, t) == 1))
    }

    /// A host of `g` stands on `t` or next to it.
    fn defended(&self, t: u8, g: u8, standing: &[HostIn]) -> bool {
        standing.iter().any(|h| h.faction == g && (h.tile == t || steps(h.tile, t) == 1))
    }

    /// Claimed land cut off from its nation's anchors frays; returns tiles fallen.
    fn fray(&mut self, x: &BellIn, standing: &[HostIn], p: &LandParams) -> u32 {
        let mut joined = 0u64;
        // anchors: village land, the keep's tile, tiles a host of the owner stands on
        let mut stack: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        for t in 0..N {
            let o = self.owner[t];
            if o == OPEN {
                continue;
            }
            let anchor = bit(self.village, t)
                || bit(x.outside[o as usize], t)
                || x.keep.is_some_and(|(k, h)| h == o && (k as usize == t || neighbours(k).any(|j| j as usize == t)))
                || standing.iter().any(|h| h.faction == o && h.tile as usize == t);
            if anchor {
                joined |= 1 << t;
                stack.push(t as u8);
            }
        }
        while let Some(t) = stack.pop() {
            let o = self.owner[t as usize];
            for j in neighbours(t) {
                let ju = j as usize;
                if !bit(joined, ju) && self.owner[ju] == o {
                    joined |= 1 << ju;
                    stack.push(j);
                }
            }
        }
        let mut fallen = 0;
        for t in 0..N {
            let o = self.owner[t];
            if o == OPEN || bit(joined, t) {
                if o != OPEN && self.by[t] == o {
                    // joined again: the fray stops
                    self.by[t] = NOBODY;
                    self.count[t] = 0;
                }
                continue;
            }
            if self.by[t] == o {
                self.count[t] = self.count[t].saturating_add(1);
            } else if self.by[t] == NOBODY {
                self.by[t] = o;
                self.count[t] = 1;
            } else {
                continue; // pressed by an enemy: the press decides
            }
            if self.count[t] >= p.fray_bells {
                self.take(t, OPEN);
                fallen += 1;
            }
        }
        fallen
    }
}

fn stands(h: &HostIn, b: u32, p: &LandParams) -> bool {
    h.resident && h.fights && h.troops >= p.floor_troops && h.from_bell <= b && (h.tile as usize) < N
}

fn check(x: &BellIn) -> Result<(), LandError> {
    let bad_f = |f: u8| f > 5;
    for s in x.sites {
        if s.tile != OPEN && s.tile as usize >= N {
            return Err(LandError::BadInput);
        }
        if s.holding.is_some_and(|(f, _)| bad_f(f)) {
            return Err(LandError::BadInput);
        }
    }
    if x.hosts.iter().any(|h| bad_f(h.faction) || h.tile as usize >= N) {
        return Err(LandError::BadInput);
    }
    if x.keep.is_some_and(|(t, f)| t as usize >= N || bad_f(f)) || x.heartland_of.is_some_and(bad_f) {
        return Err(LandError::BadInput);
    }
    Ok(())
}

/// The production bonus of each holding of nation `f` in the province,
/// basis points: `min(claimed_f × per_tile_bps / villages_f, cap_bps)`; 0
/// where `f` has no village here.
pub fn bonus_bps(land: &Land, sites: &[SiteIn; SITES_PER_PROVINCE], f: u8, p: &LandParams) -> u32 {
    let villages = sites.iter().filter(|s| s.holding.is_some_and(|(g, _)| g == f)).count() as u32;
    if villages == 0 {
        return 0;
    }
    (land.claimed_of(f).saturating_mul(p.per_tile_bps) / villages).min(p.cap_bps)
}

/// A holding's production with its land: `base × (10,000 + bonus_bps) /
/// 10,000`, entry by entry, rounded down (`base` is milli per hour).
pub fn production_with_land(base: [i64; RESOURCES], bonus_bps: u32) -> [i64; RESOURCES] {
    base.map(|v| v.saturating_mul(10_000 + bonus_bps as i64) / 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::catalog;

    const ALL: u64 = (1u64 << 61) - 1;
    const P: LandParams = LandParams::TEST;

    fn sites(list: &[(u8, Option<(u8, Tier)>)]) -> [SiteIn; 12] {
        let mut s = [SiteIn::NONE; 12];
        for (i, &(tile, holding)) in list.iter().enumerate() {
            s[i] = SiteIn { tile, holding };
        }
        s
    }
    fn host(id: u64, faction: u8, tile: u8, from_bell: u32) -> HostIn {
        HostIn { id, faction, tile, troops: 600_000, fights: true, resident: true, from_bell }
    }
    fn t(q: i32, r: i32) -> u8 {
        tile_index(Hex::new(q, r)).unwrap()
    }
    fn run(land: &mut Land, from: u32, to: u32, x: &BellIn) -> Changes {
        let mut all = Changes::default();
        for b in from..to {
            let c = land.fold(b, x, &P).unwrap();
            all.claimed += c.claimed;
            all.seized += c.seized;
            all.frayed += c.frayed;
        }
        all
    }

    #[test]
    fn village_land_is_the_worked_radius_and_follows_a_capture() {
        let s0 = sites(&[(t(0, 0), Some((1, Tier::Hamlet)))]);
        let mut land = Land::new(0);
        land.fold(0, &BellIn { sites: &s0, hosts: &[], keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P).unwrap();
        assert_eq!(land.tiles_of(1), 7);
        assert_eq!(land.claimed_of(1), 0);
        // the program's siege flips the mirror to nation 3: the land goes with it
        let s1 = sites(&[(t(0, 0), Some((3, Tier::Hamlet)))]);
        land.fold(1, &BellIn { sites: &s1, hosts: &[], keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P).unwrap();
        assert_eq!(land.tiles_of(1), 0);
        assert_eq!(land.tiles_of(3), 7);
        // tier-up widens it (Town: radius 2 = 19 tiles)
        let s2 = sites(&[(t(0, 0), Some((3, Tier::Town)))]);
        land.fold(2, &BellIn { sites: &s2, hosts: &[], keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P).unwrap();
        assert_eq!(land.tiles_of(3), 19);
        // released: it falls open
        let s3 = sites(&[(t(0, 0), None)]);
        land.fold(3, &BellIn { sites: &s3, hosts: &[], keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P).unwrap();
        assert_eq!(land.tiles_of(3), 0);
    }

    #[test]
    fn nearer_site_wins_and_water_is_never_land() {
        let s = sites(&[(t(-1, 0), Some((0, Tier::Hamlet))), (t(1, 0), Some((2, Tier::Hamlet)))]);
        let water = ALL & !(1u64 << t(0, 1));
        let mut land = Land::new(5);
        land.fold(5, &BellIn { sites: &s, hosts: &[], keep: None, passable: water, heartland_of: None, outside: [0; 6] }, &P).unwrap();
        // (0,0) is one step from both: site 0 (lower index) takes it
        assert_eq!(land.owner[t(0, 0) as usize], 0);
        assert_eq!(land.owner[t(0, 1) as usize], OPEN);
    }

    #[test]
    fn fold_is_strictly_in_bell_order() {
        let s = sites(&[]);
        let x = BellIn { sites: &s, hosts: &[], keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        let mut land = Land::new(10);
        assert_eq!(land.fold(9, &x, &P), Err(LandError::OutOfOrder));
        assert_eq!(land.fold(11, &x, &P), Err(LandError::OutOfOrder));
        assert!(land.fold(10, &x, &P).is_ok());
        assert_eq!(land.next_bell, 11);
    }

    #[test]
    fn a_host_that_marches_and_stands_grows_the_land_step_by_step() {
        let s = sites(&[(t(-3, 0), Some((1, Tier::Hamlet)))]);
        let mut land = Land::new(0);
        // stand at the edge of the village land: (-1,0) touches (-2,0)
        let h1 = [host(7, 1, t(-1, 0), 0)];
        let x1 = BellIn { sites: &s, hosts: &h1, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        land.fold(0, &x1, &P).unwrap();
        land.fold(1, &x1, &P).unwrap();
        assert_eq!(land.claimed_of(1), 0, "not stood long enough");
        let c = land.fold(2, &x1, &P).unwrap();
        assert!(c.claimed >= 4, "the tile and its open neighbours: {c:?}");
        let after_first = land.claimed_of(1);
        assert_eq!(land.owner[t(-1, 0) as usize], 1);
        // march on two tiles east and stand again: still touching, the land grows again
        let h2 = [host(7, 1, t(1, 0), 3)];
        let x2 = BellIn { sites: &s, hosts: &h2, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        run(&mut land, 3, 6, &x2);
        assert!(land.claimed_of(1) > after_first, "{} > {}", land.claimed_of(1), after_first);
        assert_eq!(land.owner[t(1, 0) as usize], 1);
        // and again
        let mid = land.claimed_of(1);
        let h3 = [host(7, 1, t(3, 0), 6)];
        let x3 = BellIn { sites: &s, hosts: &h3, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        run(&mut land, 6, 9, &x3);
        assert!(land.claimed_of(1) > mid);
        assert_eq!(land.owner[t(3, 0) as usize], 1);
    }

    #[test]
    fn a_host_away_from_its_land_claims_nothing() {
        let s = sites(&[(t(-3, 0), Some((1, Tier::Hamlet)))]);
        let h = [host(7, 1, t(3, 0), 0)];
        let x = BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        let mut land = Land::new(0);
        assert_eq!(run(&mut land, 0, 10, &x).claimed, 0);
    }

    #[test]
    fn the_keep_is_a_foothold_for_its_holder() {
        let s = sites(&[]);
        let h = [host(7, 4, t(1, 0), 0)];
        let x = BellIn { sites: &s, hosts: &h, keep: Some((t(0, 0), 4)), passable: ALL, heartland_of: None, outside: [0; 6] };
        let mut land = Land::new(0);
        run(&mut land, 0, 3, &x);
        assert_eq!(land.owner[t(1, 0) as usize], 4);
    }

    #[test]
    fn scouts_small_hosts_and_hosts_with_orders_claim_nothing() {
        let s = sites(&[(t(-3, 0), Some((1, Tier::Hamlet)))]);
        let mut scout = host(1, 1, t(-1, 0), 0);
        scout.fights = false;
        let mut small = host(2, 1, t(-1, 0), 0);
        small.troops = 99_999;
        let mut busy = host(3, 1, t(-1, 0), 0);
        busy.resident = false;
        for h in [scout, small, busy] {
            let hs = [h];
            let x = BellIn { sites: &s, hosts: &hs, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
            let mut land = Land::new(0);
            assert_eq!(run(&mut land, 0, 6, &x).claimed, 0, "{h:?}");
        }
    }

    /// Nation 1 holds a line of claimed land east of its village; nation 2's host stands on it.
    fn contested_land() -> (Land, [SiteIn; 12]) {
        let s = sites(&[(t(-3, 0), Some((1, Tier::Hamlet)))]);
        let mut land = Land::new(0);
        let h = [host(7, 1, t(-1, 0), 0)];
        run(&mut land, 0, 3, &BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] });
        let h = [host(7, 1, t(0, 0), 3)];
        run(&mut land, 3, 6, &BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] });
        assert_eq!(land.owner[t(1, 0) as usize], 1);
        (land, s)
    }

    #[test]
    fn a_hostile_host_takes_undefended_claimed_land_after_the_count() {
        let (mut land, s) = contested_land();
        let before = land.claimed_of(1);
        // nation 1's host went home (it stands on village land, far from (1,0))
        let h = [host(7, 1, t(-3, 0), 6), host(9, 2, t(1, 0), 6)];
        let x = BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        run(&mut land, 6, 9, &x);
        assert_eq!(land.owner[t(1, 0) as usize], 1, "three bells of four");
        assert_eq!(land.by[t(1, 0) as usize], 2);
        let c = land.fold(9, &x, &P).unwrap();
        assert!(c.seized >= 1);
        assert_eq!(land.owner[t(1, 0) as usize], 2);
        assert!(land.claimed_of(1) < before);
        assert!(land.claimed_of(2) >= 1);
    }

    #[test]
    fn a_defender_beside_the_tile_breaks_the_count() {
        let (mut land, s) = contested_land();
        let attack = [host(9, 2, t(1, 0), 6)];
        run(&mut land, 6, 9, &BellIn { sites: &s, hosts: &attack, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] });
        assert_eq!(land.count[t(1, 0) as usize], 3);
        // a defender arrives next to it
        let both = [host(7, 1, t(0, 0), 9), host(9, 2, t(1, 0), 6)];
        run(&mut land, 9, 20, &BellIn { sites: &s, hosts: &both, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] });
        assert_eq!(land.owner[t(1, 0) as usize], 1);
        assert_eq!(land.by[t(1, 0) as usize], NOBODY);
        assert_eq!(land.count[t(1, 0) as usize], 0);
    }

    #[test]
    fn village_land_is_taken_only_by_taking_the_village() {
        let s = sites(&[(t(0, 0), Some((1, Tier::Hamlet)))]);
        let h = [host(9, 2, t(1, 0), 0)];
        let x = BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        let mut land = Land::new(0);
        assert_eq!(run(&mut land, 0, 50, &x).seized, 0);
        assert_eq!(land.tiles_of(1), 7);
    }

    #[test]
    fn strangers_in_a_heartland_do_nothing() {
        let (mut land, s) = contested_land();
        let h = [host(9, 2, t(1, 0), 6)];
        let x = BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: Some(1), outside: [0; 6] };
        assert_eq!(run(&mut land, 6, 30, &x).seized, 0);
        assert_eq!(land.owner[t(1, 0) as usize], 1);
    }

    #[test]
    fn land_cut_off_from_its_nation_frays_and_falls_open() {
        let (mut land, s) = contested_land();
        // nation 2 takes (−1,0)? No: village land at (−2,0) stays. Cut by taking (0,0) and (−1,0)'s link:
        // simplest cut-off: the village is released, then claimed land has no anchor.
        let gone = sites(&[(t(-3, 0), None)]);
        let none: [HostIn; 0] = [];
        let x = BellIn { sites: &gone, hosts: &none, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        let claimed = land.claimed_of(1);
        assert!(claimed > 0);
        land.fold(6, &x, &P).unwrap();
        land.fold(7, &x, &P).unwrap();
        assert!(land.claimed_of(1) > 0, "two bells of three");
        let c = land.fold(8, &x, &P).unwrap();
        assert_eq!(land.tiles_of(1), 0);
        assert!(c.frayed > 0);
        let _ = s;
    }

    #[test]
    fn a_standing_host_keeps_its_land_from_fraying() {
        let (mut land, _) = contested_land();
        let gone = sites(&[(t(-3, 0), None)]);
        let h = [host(7, 1, t(0, 0), 3)];
        let x = BellIn { sites: &gone, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] };
        run(&mut land, 6, 20, &x);
        assert!(land.owner[t(0, 0) as usize] == 1 && land.owner[t(1, 0) as usize] == 1);
    }

    #[test]
    fn land_pays_production_to_the_nation_villages_in_the_province() {
        let (land, s) = contested_land();
        let claimed = land.claimed_of(1);
        assert!(claimed > 0);
        let bonus = bonus_bps(&land, &s, 1, &P);
        assert_eq!(bonus, (claimed * 200).min(3_000));
        assert_eq!(bonus_bps(&land, &s, 2, &P), 0, "no village of nation 2 here");
        let base = catalog::base_production(Tier::Hamlet);
        let with = production_with_land(base, bonus);
        for r in 0..RESOURCES {
            assert_eq!(with[r], base[r] * (10_000 + bonus as i64) / 10_000);
            assert!(with[r] >= base[r]);
        }
        assert!(with.iter().sum::<i64>() > base.iter().sum::<i64>());
        // the cap
        let mut big = land;
        for t in 0..N {
            if !big.is_village(t as u8) {
                big.owner[t] = 1;
            }
        }
        assert_eq!(bonus_bps(&big, &s, 1, &P), 3_000);
    }

    #[test]
    fn bad_input_is_refused() {
        let s = sites(&[]);
        let h = [host(1, 6, 0, 0)];
        let mut land = Land::new(0);
        assert_eq!(land.fold(0, &BellIn { sites: &s, hosts: &h, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P), Err(LandError::BadInput));
        assert_eq!(land.next_bell, 0);
        assert!(LandParams::PREVIEW.validate().is_ok());
        assert!(LandParams::TEST.validate().is_ok());
    }

    /// Two nations with a village each at opposite ends; each side's host walks out, stands, and
    /// later the other side walks onto that land. Land keeps changing hands, never both at once.
    #[test]
    fn a_long_contest_moves_land_back_and_forth() {
        let s = sites(&[(t(-4, 0), Some((1, Tier::Hamlet))), (t(4, 0), Some((2, Tier::Hamlet)))]);
        let mut land = Land::new(0);
        let mut b = 0;
        let go = |land: &mut Land, b: &mut u32, hosts: &[HostIn], n: u32| {
            for _ in 0..n {
                land.fold(*b, &BellIn { sites: &s, hosts, keep: None, passable: ALL, heartland_of: None, outside: [0; 6] }, &P).unwrap();
                *b += 1;
            }
        };
        // nation 1 walks east step by step
        for (i, q) in [-2, 0, 2].into_iter().enumerate() {
            let from = b;
            go(&mut land, &mut b, &[host(1, 1, t(q, 0), from)], 3);
            assert_eq!(land.owner[t(q, 0) as usize], 1, "step {i}");
        }
        let n1 = land.claimed_of(1);
        // nation 2 walks west onto nation 1's land and takes it, tile by tile
        let mut flips = 0;
        for q in [2, 0] {
            let from = b;
            let before = land.owner[t(q, 0) as usize];
            go(&mut land, &mut b, &[host(2, 2, t(q, 0), from)], 8);
            if before == 1 && land.owner[t(q, 0) as usize] == 2 {
                flips += 1;
            }
        }
        assert!(flips >= 1, "nation 2 took land");
        assert!(land.claimed_of(1) < n1);
        let n2 = land.claimed_of(2);
        // nation 1 comes back and takes it again
        let from = b;
        let back = land.owner[t(0, 0) as usize];
        go(&mut land, &mut b, &[host(1, 1, t(0, 0), from)], 8);
        if back == 2 {
            assert_eq!(land.owner[t(0, 0) as usize], 1, "retaken");
            assert!(land.claimed_of(2) < n2);
        }
        // conservation: every tile has exactly one owner or none
        for t in 0..N {
            assert!(land.owner[t] == OPEN || land.owner[t] <= 5);
        }
        assert_eq!(land.tiles_of(1) + land.tiles_of(2) + land.owner.iter().filter(|&&o| o == OPEN).count() as u32, N as u32);
    }

    #[test]
    fn land_grows_across_a_province_border() {
        // no own land here; the tile (4,0) touches nation 1's land next door
        let s = sites(&[]);
        let mut outside = [0u64; 6];
        outside[1] = 1u64 << t(4, 0);
        let away = [host(7, 1, t(2, 0), 0)];
        let edge = [host(7, 1, t(4, 0), 0)];
        let mut land = Land::new(0);
        run(&mut land, 0, 4, &BellIn { sites: &s, hosts: &away, keep: None, passable: ALL, heartland_of: None, outside });
        assert_eq!(land.tiles_of(1), 0, "not touching");
        let mut land = Land::new(0);
        run(&mut land, 0, 4, &BellIn { sites: &s, hosts: &edge, keep: None, passable: ALL, heartland_of: None, outside });
        assert!(land.tiles_of(1) >= 3);
        // the host leaves: the land stays joined across the border, it does not fray
        let none: [HostIn; 0] = [];
        let c = run(&mut land, 4, 20, &BellIn { sites: &s, hosts: &none, keep: None, passable: ALL, heartland_of: None, outside });
        assert_eq!(c.frayed, 0);
        assert!(land.tiles_of(1) >= 3);
    }

    #[test]
    fn the_same_inputs_give_the_same_land() {
        let s = sites(&[(t(-3, 0), Some((1, Tier::Town))), (t(3, 0), Some((2, Tier::Hamlet)))]);
        let h = [host(5, 1, t(0, 1), 0), host(6, 2, t(1, -1), 0), host(4, 1, t(-1, 2), 0)];
        let x = BellIn { sites: &s, hosts: &h, keep: Some((t(0, -3), 2)), passable: ALL, heartland_of: None, outside: [0; 6] };
        let (mut a, mut b) = (Land::new(0), Land::new(0));
        run(&mut a, 0, 12, &x);
        let mut hr = h;
        hr.reverse();
        run(&mut b, 0, 12, &BellIn { hosts: &hr, ..x });
        assert_eq!(a, b, "the roster's order does not matter");
    }
}
