//! The control layer: the faction map, March banners, Dominion's
//! controller rule and the map-movement measures (MC contract §3.3,
//! §3.10, §3.14, §13.4 criterion 10).
//!
//! * **Province control** ([`province_control`]) is its keep's holder;
//!   rings 0–1 have no keep: the Concord shows neutral, a Seat its faction.
//! * **March banner** ([`march_banner`]): faction f when f holds strictly
//!   more than half of the March's open keeps; otherwise contested; none
//!   when the March has no open keep.
//! * **Dominion** uses the strict-majority controller ([`controller`]) over
//!   the hourly per-side strength weights ([`site_weight_centi`]), never a
//!   map colour (R-15).
//! * **Criterion 10** counts lasting changes ([`lasting_changes`]) and
//!   banner changes ([`banner_changes`]) from per-bell series; the
//!   simulator, the stack report, the verifier and the web call the same
//!   functions.
//! * **Herald's Call** ([`herald_call`]): one March per faction a day,
//!   display only.
//!
//! Everything is a pure function of its inputs (the herald, verifier,
//! simulator, bots, report and WASM agree by construction).

/// Version of this kernel, bound into `ruleset_hash_input_v2`
/// (`super::KERNEL_VERSIONS_V2`).
pub const CONTROL_VERSION: u16 = 1;

use super::geometry::{march_members, march_of, MarchCoord, ProvinceCoord, FACTIONS};
use super::keep::Keep;
use super::laurel::{strength_weight, Tier};
use crate::fixed::MilliTroops;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};

/// Control sides: factions 0–5 and neutral (6).
pub const SIDES: usize = 7;
/// The neutral side (Free Cities, the Concord).
pub const NEUTRAL_SIDE: u8 = 6;
/// Strength weight units per snapshot unit: snapshots are in
/// centi-strength-weight (`laurel::WEIGHT_ONE / 100`), u16 per side.
pub const SNAPSHOT_UNIT: u64 = 10_000;
/// Hours in a Province's snapshot ring (MC §3.10, K-13).
pub const SNAPSHOT_RING: u32 = 6;
/// A lasting change keeps its new controller this many bells (criterion
/// 10, §3.14).
pub const LASTING_MIN_BELLS: u32 = 6;
/// Dominion control-bells per controlled hour (Frontier-7/28 default).
pub const DOMINION_PER_HOUR_DEFAULT: u16 = 6;
/// Dominion control-bells per credited capture (default).
pub const DOMINION_PER_CAPTURE_DEFAULT: u16 = 36;
/// PSFCT1 control codes (MC §8.4): 0–5 a faction, 6 neutral, 7 unopened.
pub const CODE_NEUTRAL: u8 = 6;
pub const CODE_UNOPENED: u8 = 7;
/// A March whose banner is contested or absent, in PSFCT1.
pub const CODE_NO_BANNER: u8 = 7;
/// Days back a Rally looks for a lost March (Herald's Call, §3.10).
pub const RALLY_LOOKBACK_DAYS: u32 = 2;
/// Domain of Herald's Call tie-breaks.
pub const CALL_DOMAIN: &[u8] = b"PSF-HERALD-CALL";

/// A March's id in the control layer.
pub type MarchId = MarchCoord;

/// One site's control weight for a Dominion snapshot (MC §3.10, K-14):
/// `⌊strength_weight(tier, garrison, order − 1) / 10,000⌋`, where `order`
/// is the holding's order **1-based** (1 first, 2–3 outposts; 0 counts as
/// 1; a Free City is order 1). ≤ 300.
pub fn site_weight_centi(tier: Tier, garrison: MilliTroops, order: u8) -> u16 {
    let w = strength_weight(tier, garrison, order.saturating_sub(1)) / SNAPSHOT_UNIT;
    w.min(u16::MAX as u64) as u16
}

/// The tier of a site-mirror byte (0 Hamlet … 3 Stronghold).
pub const fn tier_from_u8(t: u8) -> Option<Tier> {
    match t {
        0 => Some(Tier::Hamlet),
        1 => Some(Tier::Town),
        2 => Some(Tier::City),
        3 => Some(Tier::Stronghold),
        _ => None,
    }
}

/// The strict-majority controller of a weight vector (MC §3.10, §3.14).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Controller {
    /// No weight at all.
    Unsettled,
    /// Side s (0–5 a faction, 6 neutral): `2·w[s] ≥ Σw` and strictly more
    /// than every other side.
    Side(u8),
    /// Weight, but no side with a strict majority.
    Contested,
}

/// [`Controller`] of `w` (factions 0–5, neutral 6).
pub fn controller(w: &[u32; SIDES]) -> Controller {
    let total: u64 = w.iter().map(|&x| x as u64).sum();
    if total == 0 {
        return Controller::Unsettled;
    }
    let mut best = 0usize;
    for s in 1..SIDES {
        if w[s] > w[best] {
            best = s;
        }
    }
    let top = w[best];
    let unique = w.iter().enumerate().all(|(s, &x)| s == best || x < top);
    if unique && 2 * top as u64 >= total {
        Controller::Side(best as u8)
    } else {
        Controller::Contested
    }
}

/// A province on the faction map (MC §3.1, §3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum ProvinceControl {
    /// Not opened (or a ring ≥ 2 province without a keep record).
    Unopened,
    /// The Concord (ring 0).
    Neutral,
    /// A Seat (ring 1) and its faction; not part of any banner.
    Seat(u8),
    /// A keep province and its holder.
    Keep(u8),
}

impl ProvinceControl {
    /// The faction colouring the province, if any (keep holder or Seat).
    pub const fn faction(self) -> Option<u8> {
        match self {
            ProvinceControl::Keep(f) | ProvinceControl::Seat(f) => Some(f),
            _ => None,
        }
    }

    /// The PSFCT1 `control` byte: 0–5, 6 neutral, 7 unopened.
    pub const fn code(self) -> u8 {
        match self {
            ProvinceControl::Keep(f) | ProvinceControl::Seat(f) => f,
            ProvinceControl::Neutral => CODE_NEUTRAL,
            ProvinceControl::Unopened => CODE_UNOPENED,
        }
    }

    /// An open keep (counts toward a banner).
    pub const fn is_keep(self) -> bool {
        matches!(self, ProvinceControl::Keep(_))
    }
}

/// A province's control (MC §3.1): ring 0 neutral; ring 1 its Seat's
/// faction (`seat_faction`, or the wedge's as the caller knows it); ring
/// ≥ 2 its keep's holder, unopened without a keep.
pub fn province_control(
    keep: Option<&Keep>,
    ring: u16,
    seat_faction: Option<u8>,
) -> ProvinceControl {
    match ring {
        0 => ProvinceControl::Neutral,
        1 => match seat_faction {
            Some(f) if f < FACTIONS => ProvinceControl::Seat(f),
            _ => ProvinceControl::Unopened,
        },
        _ => match keep {
            Some(k) if k.holder < FACTIONS => ProvinceControl::Keep(k.holder),
            _ => ProvinceControl::Unopened,
        },
    }
}

/// A March's banner (MC §3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Banner {
    /// No open keep among the members.
    None,
    /// Open keeps, no faction with more than half of them.
    Contested,
    Faction(u8),
}

impl Banner {
    /// The PSFCT1 `banner` byte: 0–5, 7 contested or none.
    pub const fn code(self) -> u8 {
        match self {
            Banner::Faction(f) => f,
            _ => CODE_NO_BANNER,
        }
    }
}

/// The banner of a March from its members' controls (MC §3.3): faction f
/// when `2 × held(f) > open keeps`.
pub fn march_banner(members: &[ProvinceControl]) -> Banner {
    let mut held = [0u32; FACTIONS as usize];
    let mut open = 0u32;
    for m in members {
        if let ProvinceControl::Keep(f) = m {
            if (*f as usize) < held.len() {
                held[*f as usize] += 1;
                open += 1;
            }
        }
    }
    if open == 0 {
        return Banner::None;
    }
    for (f, &h) in held.iter().enumerate() {
        if 2 * h > open {
            return Banner::Faction(f as u8);
        }
    }
    Banner::Contested
}

/// One lasting change (criterion 10): province `province` (an index into
/// the series' map) turns from faction `from` to faction `to` at `bell`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Change {
    pub province: usize,
    pub bell: u32,
    pub from: u8,
    pub to: u8,
}

/// The lasting changes of a per-bell control series (MC §13.4 criterion
/// 10): province p has control f at entry b and g ≠ f at the previous
/// entry, **both factions (0–5)**, and keeps f at every entry with a bell
/// in `[bell(b), bell(b) + min_bells − 1]` (or to the series' end). The
/// series is `(bell, control code per province)` in bell order (PSFCT1
/// codes: 6 neutral and 7 unopened are not factions). Sorted by (bell,
/// province).
///
/// Generic over the map's storage: the pinned form `&[(u32, [u8; N])]`
/// and a dynamic `&[(u32, Vec<u8>)]` (the simulator) both fit. Maps of
/// different lengths compare over the shorter one.
pub fn lasting_changes<M: AsRef<[u8]>>(series: &[(u32, M)], min_bells: u32) -> Vec<Change> {
    let mut out = Vec::new();
    for i in 1..series.len() {
        let (b, cur) = &series[i];
        let (cur, prev) = (cur.as_ref(), series[i - 1].1.as_ref());
        for p in 0..cur.len().min(prev.len()) {
            let (g, f) = (prev[p], cur[p]);
            if g == f || g >= FACTIONS || f >= FACTIONS {
                continue;
            }
            let last = b.saturating_add(min_bells.saturating_sub(1));
            let mut keeps = true;
            for (bj, mj) in &series[i + 1..] {
                if *bj > last {
                    break;
                }
                if mj.as_ref().get(p) != Some(&f) {
                    keeps = false;
                    break;
                }
            }
            if keeps {
                out.push(Change {
                    province: p,
                    bell: *b,
                    from: g,
                    to: f,
                });
            }
        }
    }
    out
}

/// A March banner change (criterion 10d): faction `from` to a different
/// faction `to`, through any contested or empty interval in between.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct BannerChange {
    pub bell: u32,
    pub from: u8,
    pub to: u8,
}

/// The banner changes of one March's per-bell banner series: each bell at
/// which the banner becomes a faction different from the last faction it
/// showed (contested and none in between are skipped).
pub fn banner_changes(series: &[(u32, Banner)]) -> Vec<BannerChange> {
    let mut out = Vec::new();
    let mut last: Option<u8> = None;
    for (b, x) in series {
        if let Banner::Faction(f) = x {
            if let Some(g) = last {
                if g != *f {
                    out.push(BannerChange {
                        bell: *b,
                        from: g,
                        to: *f,
                    });
                }
            }
            last = Some(*f);
        }
    }
    out
}

/// One opened province on the control map Herald's Call reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MapProvince {
    pub coord: ProvinceCoord,
    pub control: ProvinceControl,
    /// Its keep can be contested now (not heartland-safe; consolidation is
    /// ignored: the Call is a day's target).
    pub contestable: bool,
}

/// The control map at a day boundary, plus the banner history the Rally
/// needs: `(faction, March)` for every March whose banner was the faction
/// within the last [`RALLY_LOOKBACK_DAYS`] days and is not now.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ControlMap {
    pub provinces: Vec<MapProvince>,
    pub recently_lost: Vec<(u8, MarchId)>,
}

/// A faction's Herald's Call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    pub march: MarchId,
    /// The Rally of the faction with the fewest provinces.
    pub rally: bool,
}

fn tie(day_seed: &[u8; 32], f: u8, m: MarchId) -> u64 {
    let h = crate::hash::sha256(&[
        CALL_DOMAIN,
        day_seed,
        &[f],
        &m.m.to_le_bytes(),
        &m.n.to_le_bytes(),
    ]);
    let mut w = [0u8; 8];
    w.copy_from_slice(&h[..8]);
    u64::from_le_bytes(w)
}

/// Herald's Call with its Rally flag (MC §3.10, display only):
///
/// * for each faction f with a controlled province, the March with the
///   highest `enemy / (1 + d)`, where `enemy` counts the March's members
///   with a contestable keep held by another faction and `d` is the
///   smallest province distance minus one from an f-controlled province to
///   such a member (adjacent = 0); only Marches with `enemy ≥ 1` and `d ≤
///   2` qualify; ties by the lowest `sha256("PSF-HERALD-CALL" ‖ day_seed ‖
///   f ‖ m ‖ n)`;
/// * the faction with the fewest controlled provinces (lowest id on a
///   tie) instead gets the nearest of its `recently_lost` Marches (by the
///   same distance from its provinces, ties as above), flagged `rally`.
pub fn herald_call_detail(map: &ControlMap, day_seed: &[u8; 32]) -> [Option<Call>; 6] {
    let mut out = [None; 6];
    let mut count = [0u32; 6];
    for p in &map.provinces {
        if let Some(f) = p.control.faction() {
            if (f as usize) < 6 {
                count[f as usize] += 1;
            }
        }
    }
    let rally_f = (0..6u8)
        .filter(|&f| count[f as usize] > 0 || map.recently_lost.iter().any(|x| x.0 == f))
        .min_by_key(|&f| (count[f as usize], f));
    for f in 0..6u8 {
        let own: Vec<ProvinceCoord> = map
            .provinces
            .iter()
            .filter(|p| p.control.faction() == Some(f))
            .map(|p| p.coord)
            .collect();
        let dist_to = |c: ProvinceCoord| -> u32 {
            own.iter()
                .map(|o| o.distance(c).saturating_sub(1))
                .min()
                .unwrap_or(u32::MAX)
        };
        if Some(f) == rally_f {
            let mut best: Option<(u32, u64, MarchId)> = None;
            for &(g, m) in &map.recently_lost {
                if g != f {
                    continue;
                }
                let d = march_members(m)
                    .iter()
                    .map(|&c| dist_to(c))
                    .min()
                    .unwrap_or(u32::MAX);
                let key = (d, tie(day_seed, f, m), m);
                if best.is_none_or(|b| (key.0, key.1) < (b.0, b.1)) {
                    best = Some(key);
                }
            }
            if let Some((_, _, m)) = best {
                out[f as usize] = Some(Call {
                    march: m,
                    rally: true,
                });
                continue;
            }
        }
        if own.is_empty() {
            continue;
        }
        // Per March: enemy contestable keeps and their nearest distance.
        let mut marches: Vec<(MarchId, u32, u32)> = Vec::new();
        for p in &map.provinces {
            let ProvinceControl::Keep(g) = p.control else {
                continue;
            };
            if g == f || !p.contestable {
                continue;
            }
            let d = dist_to(p.coord);
            if d > 2 {
                continue;
            }
            let m = march_of(p.coord);
            match marches.iter_mut().find(|x| x.0 == m) {
                Some(x) => {
                    x.1 += 1;
                    x.2 = x.2.min(d);
                }
                None => marches.push((m, 1, d)),
            }
        }
        let mut best: Option<(MarchId, u32, u32, u64)> = None;
        for (m, e, d) in marches {
            let t = tie(day_seed, f, m);
            let better = match best {
                None => true,
                // e / (1 + d) > be / (1 + bd), then the lower tie key.
                Some((_, be, bd, bt)) => {
                    let l = e as u64 * (1 + bd as u64);
                    let r = be as u64 * (1 + d as u64);
                    l > r || (l == r && t < bt)
                }
            };
            if better {
                best = Some((m, e, d, t));
            }
        }
        out[f as usize] = best.map(|(m, ..)| Call {
            march: m,
            rally: false,
        });
    }
    out
}

/// Herald's Call: one March per faction (MC §3.10). See
/// [`herald_call_detail`].
pub fn herald_call(map: &ControlMap, day_seed: &[u8; 32]) -> [Option<MarchId>; 6] {
    herald_call_detail(map, day_seed).map(|c| c.map(|c| c.march))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_majority() {
        assert_eq!(controller(&[0; SIDES]), Controller::Unsettled);
        assert_eq!(controller(&[5, 5, 0, 0, 0, 0, 0]), Controller::Contested);
        assert_eq!(controller(&[5, 4, 1, 0, 0, 0, 0]), Controller::Side(0));
        assert_eq!(controller(&[4, 3, 2, 0, 0, 0, 0]), Controller::Contested);
        assert_eq!(controller(&[0, 0, 0, 0, 0, 0, 3]), Controller::Side(6));
    }
}
