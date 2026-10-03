//! The control layer the herald derives from Province v2 bytes (MC
//! contract §3.3, §8.4; unit CQ2-E): one [`View`] per province-bell, the
//! `PSFCT1` file of a bell, the `PSFOV2` record extension and the
//! movement summary of `final.json` (§13.4's figures).
//!
//! Every rule comes from the kernels (`control::province_control`,
//! `march_banner`, `lasting_changes`, `banner_changes`) and
//! `frontier_abi::conquest_model` (`read_keep`, `decode_records`,
//! `control_weights`), never from a copy (M1 §3.3), so the herald's map,
//! the verifier's (V21) and the simulator's agree by construction.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::clash_model::{ModelError, R};
use frontier_abi::conquest_model as qm;
use frontier_abi::v2::kernel::siege3;
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P, site as SM};
use frontier_abi::v2::log::{event, Event};
use permutation_rules::frontier::control::{self, Banner, ProvinceControl};
use permutation_rules::frontier::geometry::{march_members, MarchCoord, ProvinceCoord};

use crate::cqfmt::{
    march_order, mflag, pflag, ControlFile, ControlMarch, ControlProvince, KeepContest,
    Overview2Record, PauseReason, SiegeEntry, SiegeKind, CONTROL_NEUTRAL, CONTROL_NONE,
    KEEP_TILE_NONE, KIND_FIRST, KIND_FREE_CITY, KIND_HOLDING, KIND_RESERVED_OR_FREE, OCCUPIER_NONE,
    SIEGE_CAPTURE_DUE, SIEGE_NONE, SIEGE_PAUSED_VIGIL, SIEGE_PROGRESSING,
};
use crate::OVERVIEW_RECORD;

const BAD: ModelError = ModelError::BadAccount;

/// Seconds per bell (the conquest model's `bell_start`).
pub const BELL_SECS: i64 = 600;

/// Whether `d` is a Province v2 (MC, `layout_version` 2, 4,736 B).
pub fn is_v2_province(d: &[u8]) -> bool {
    d.len() >= P::SIZE
        && frontier_abi::v2::layout::layout_version(d)
            == Some(frontier_abi::v2::layout::LAYOUT_VERSION_V2)
}

/// One province at one bell: everything the control, overview v2,
/// sieges and standings files need from its bytes after the bell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub ring: u16,
    /// The `PSFCT1` record, without the `CHANGED` flag (the file sets it).
    pub ct: ControlProvince,
    /// The `PSFOV2` extension (its `v1` part is zero: the file takes the
    /// v1 record from `PSFOV1`).
    pub ext: Overview2Record,
    /// Active holding sieges declared by the bell, by site.
    pub sieges: Vec<SiegeEntry>,
    pub keep: Option<KeepContest>,
    /// Holdings (site state 1) by title faction.
    pub holdings: [u16; 6],
    /// Occupations by occupier faction.
    pub occupations: [u16; 6],
    /// The keep can be contested (Herald's Call): a keep, not heartland-safe.
    pub contestable: bool,
}

/// The vigil of a siege record (none for a Free City).
pub fn record_vigil(r: &qm::Record) -> Option<permutation_rules::frontier::siege::Vigil> {
    (r.flags & CR::FLAG_NEUTRAL == 0)
        .then(|| siege3::vigil_of_snapshot(r.vigil_start, r.vigil_next, r.vigil_from_day))
}

/// Whether bell `b`'s start lies inside the record's vigil.
pub fn vigil_covers(r: &qm::Record, genesis_ts: i64, b: u32) -> bool {
    record_vigil(r).is_some_and(|v| v.covers(genesis_ts.saturating_add(b as i64 * BELL_SECS)))
}

/// A siege's pause at bell `b` (§8.4 `status`): `None` while it counted
/// (or at its declaring bell), else the vigil or the defender.
pub fn siege_pause(
    r: &qm::Record,
    prev: Option<&qm::Record>,
    genesis_ts: i64,
    b: u32,
) -> Option<PauseReason> {
    if b <= r.bell {
        return None;
    }
    let p = prev.filter(|p| p.kind == CR::KIND_SIEGE && p.bell == r.bell)?;
    (p.progress == r.progress).then(|| {
        if vigil_covers(r, genesis_ts, b) {
            PauseReason::Vigil
        } else {
            PauseReason::Defender
        }
    })
}

/// The side leading a weight vector (unique maximum) and its share × 255;
/// `(7, 0)` without weight or on a tie (points only, never a colour).
pub fn points_lead(w: &[u32; 7]) -> (u8, u8) {
    let total: u64 = w.iter().map(|&x| x as u64).sum();
    if total == 0 {
        return (CONTROL_NONE, 0);
    }
    let mut best = 0usize;
    for s in 1..7 {
        if w[s] > w[best] {
            best = s;
        }
    }
    if w.iter()
        .enumerate()
        .any(|(s, &x)| s != best && x == w[best])
    {
        return (CONTROL_NONE, 0);
    }
    (best as u8, ((w[best] as u64 * 255) / total) as u8)
}

/// The view of a Province v2 after bell `b`. `prev` is its bytes after
/// bell `b − 1` (pause detection), `events` the bell's CONQUEST events,
/// `clash` whether the bell logged a CLASH, `owner_tag(site)` the title
/// holder's citizen tag.
pub fn view_of(
    pd: &[u8],
    prev: Option<&[u8]>,
    b: u32,
    genesis_ts: i64,
    clash: bool,
    events: &[Event],
    owner_tag: &dyn Fn(usize) -> Option<u64>,
) -> R<View> {
    if !is_v2_province(pd) {
        return Err(BAD);
    }
    let ring = u16::from_le_bytes([pd[P::RING], pd[P::RING + 1]]);
    let (p, q) = qm::coord(pd)?;
    let wedge = pd[P::WEDGE];
    let keep = qm::read_keep(pd)?;
    let pc = control::province_control(keep.as_ref(), ring, (ring == 1).then_some(wedge));
    let mut flags = 0u8;
    if ring <= 1 {
        flags |= pflag::SEAT;
    }
    if clash {
        flags |= pflag::CLASH;
    }
    for e in events {
        if e.site == event::KEEP_SITE {
            match e.code & !event::DETAIL {
                event::KEEP_TAKEN => flags |= pflag::TAKEN,
                event::KEEP_BROKEN => flags |= pflag::BROKEN,
                _ => {}
            }
        }
    }
    let (mut contender, mut progress, mut required) = (CONTROL_NONE, 0u8, 0u8);
    let mut keep_contest = None;
    if let Some(k) = &keep {
        required = k.required;
        if k.heartland_safe && ring >= 2 {
            flags |= pflag::HEARTLAND;
        }
        if b.saturating_add(1) < k.consolidated_until_bell {
            flags |= pflag::CONSOLIDATING;
        }
        if k.contender != KP::NONE && k.contender < 6 && k.progress >= 1 && k.progress < k.required
        {
            contender = k.contender;
            progress = k.progress;
            keep_contest = Some(KeepContest {
                p,
                q,
                holder: k.holder,
                contender: k.contender,
                progress: k.progress,
                required: k.required,
                since: k.contest_from_bell.min(b),
                eta_bell: b.saturating_add((k.required - k.progress) as u32),
            });
        }
    }
    let recs = qm::decode_records(pd)?;
    let prev_recs = match prev {
        Some(x) if is_v2_province(x) => Some(qm::decode_records(x)?),
        _ => None,
    };
    let n = (pd[P::SITE_COUNT] as usize).min(P::SITES_N);
    let mut ext = Overview2Record::from_v1([0u8; OVERVIEW_RECORD]);
    let mut sieges = Vec::new();
    let mut holdings = [0u16; 6];
    let mut occupations = [0u16; 6];
    let (mut n_sieges, mut n_occ) = (0u32, 0u32);
    for s in 0..n {
        let o = P::site(s);
        let st = pd[o + SM::STATE];
        let faction = pd[o + SM::FACTION];
        ext.kind[s] = match st {
            SM::STATE_HOLDING if pd[o + SM::ORDER] <= 1 => KIND_FIRST,
            SM::STATE_HOLDING => KIND_HOLDING,
            SM::STATE_FREE_CITY => KIND_FREE_CITY,
            _ => KIND_RESERVED_OR_FREE,
        };
        if st == SM::STATE_HOLDING && faction < 6 {
            holdings[faction as usize] = holdings[faction as usize].saturating_add(1);
        }
        let r = recs[s];
        let pr = prev_recs.as_ref().map(|x| &x[s]);
        match r.kind {
            CR::KIND_SIEGE if r.bell <= b => {
                n_sieges += 1;
                let pause = siege_pause(&r, pr, genesis_ts, b);
                ext.siege[s] = match pause {
                    Some(PauseReason::Vigil) => SIEGE_PAUSED_VIGIL,
                    _ => SIEGE_PROGRESSING,
                };
                let tk = CR::target_kind(r.target);
                let kind = match tk {
                    CR::TARGET_FIRST => SiegeKind::First,
                    CR::TARGET_FREE_CITY => SiegeKind::Free,
                    _ => SiegeKind::Other,
                };
                let free = kind == SiegeKind::Free;
                let vigil = record_vigil(&r);
                let left = r.required.saturating_sub(r.progress);
                let eta = siege3::earliest_completion_bell(
                    left,
                    vigil.as_ref(),
                    b.saturating_add(1),
                    genesis_ts,
                )
                .max(r.bell.saturating_add(1));
                if r.faction < 6 && r.progress < r.required && r.required >= 1 {
                    sieges.push(SiegeEntry {
                        p,
                        q,
                        site: s as u8,
                        kind,
                        owner: if free {
                            None
                        } else {
                            Some(owner_tag(s).unwrap_or(0))
                        },
                        owner_faction: if free { CONTROL_NEUTRAL } else { faction },
                        attacker: r.actor,
                        attacker_faction: r.faction,
                        declared: r.bell,
                        required: r.required,
                        progress: r.progress,
                        pause,
                        eta_bell: eta,
                    });
                }
            }
            CR::KIND_OCCUPATION => {
                n_occ += 1;
                if r.faction < 6 {
                    ext.occupier[s] = r.faction;
                    occupations[r.faction as usize] =
                        occupations[r.faction as usize].saturating_add(1);
                }
            }
            CR::KIND_CAPTURE_DUE => ext.siege[s] = SIEGE_CAPTURE_DUE,
            CR::KIND_NONE if r.faction != CR::BARRED_NONE && r.bell > b => {
                ext.immune |= 1 << s;
            }
            _ => {}
        }
        if ext.occupier[s] > 5 {
            ext.occupier[s] = OCCUPIER_NONE;
        }
        if ext.siege[s] > 3 {
            ext.siege[s] = SIEGE_NONE;
        }
    }
    sieges.sort_by_key(|s| s.site);
    match &keep {
        Some(k) => {
            ext.keep_tile = k.tile;
            ext.keep_troops = Overview2Record::keep_troops_sat(k.troops);
        }
        None => {
            ext.keep_tile = KEEP_TILE_NONE;
            ext.keep_troops = 0;
        }
    }
    let w = qm::control_weights(pd, b)?;
    let (points_lead, points_share) = points_lead(&w);
    let control = if ring == 0 {
        CONTROL_NEUTRAL
    } else {
        pc.code()
    };
    let ct = ControlProvince {
        control,
        contender,
        progress,
        required,
        flags,
        points_lead,
        points_share,
        ..Default::default()
    }
    .with_counts(n_sieges, n_occ);
    Ok(View {
        ring,
        ct,
        ext,
        sieges,
        keep: keep_contest,
        holdings,
        occupations,
        contestable: keep.is_some_and(|k| !k.heartland_safe && k.holder < 6),
    })
}

/// The `PSFCT1` record of a province with no view at the bell: unopened
/// (the Concord is always neutral; rings 0–1 carry the seat flag).
pub fn unopened(index: u32) -> ControlProvince {
    let ring = ProvinceCoord::from_index(index).ring();
    ControlProvince {
        control: if index == 0 {
            CONTROL_NEUTRAL
        } else {
            CONTROL_NONE
        },
        contender: CONTROL_NONE,
        flags: if ring <= 1 { pflag::SEAT } else { 0 },
        points_lead: CONTROL_NONE,
        ..Default::default()
    }
}

/// A province's `ProvinceControl` from its `PSFCT1` code and ring.
pub fn control_of_code(code: u8, ring: u32) -> ProvinceControl {
    match ring {
        0 => ProvinceControl::Neutral,
        1 if code < 6 => ProvinceControl::Seat(code),
        r if r >= 2 && code < 6 => ProvinceControl::Keep(code),
        _ => ProvinceControl::Unopened,
    }
}

/// What a control file's March section reads besides the provinces.
pub struct MarchInputs<'a> {
    /// Dominion lead at the last fold per March (0–6; absent = 7).
    pub lead: &'a BTreeMap<(i32, i32), u8>,
    /// Marches whose Dominion lead changed at a fold since the last file.
    pub lead_changed: &'a BTreeSet<(i32, i32)>,
    /// Herald's Call targets of the bell's day.
    pub call: &'a BTreeSet<(i32, i32)>,
}

/// The banner of March `m` and its `keeps` byte over a file's provinces.
pub fn banner_of(m: MarchCoord, codes: &[u8]) -> (Banner, u8) {
    let ctrls: Vec<ProvinceControl> = march_members(m)
        .iter()
        .map(|c| match c.checked_index() {
            Some(i) if (i as usize) < codes.len() => control_of_code(codes[i as usize], c.ring()),
            _ => ProvinceControl::Unopened,
        })
        .collect();
    let banner = control::march_banner(&ctrls);
    let mut held = [0u8; 6];
    for c in &ctrls {
        if let ProvinceControl::Keep(f) = c {
            if (*f as usize) < 6 {
                held[*f as usize] += 1;
            }
        }
    }
    let keeps = match banner {
        Banner::Faction(f) => held[f as usize],
        _ => held.iter().copied().max().unwrap_or(0),
    };
    (banner, keeps.min(7))
}

/// Assembles bell `b`'s `PSFCT1` over rings 0..=`rings`: `views` gives
/// the record of each opened province (by dense index), `prev` is the
/// previous bell's file (the change flags).
pub fn control_file(
    season: u64,
    b: u32,
    rings: u32,
    views: &BTreeMap<u32, ControlProvince>,
    prev: Option<&ControlFile>,
    mi: &MarchInputs<'_>,
) -> ControlFile {
    let n = permutation_rules::frontier::geometry::provinces_within(rings);
    let mut provinces = Vec::with_capacity(n as usize);
    for i in 0..n {
        let mut r = views.get(&i).copied().unwrap_or_else(|| unopened(i));
        if let Some(pr) = prev.and_then(|f| f.provinces.get(i as usize)) {
            if pr.control != r.control {
                r.flags |= pflag::CHANGED;
            }
        }
        provinces.push(r);
    }
    let codes: Vec<u8> = provinces.iter().map(|r| r.control).collect();
    let order = march_order(rings);
    let prev_banner: BTreeMap<(i32, i32), u8> = match prev {
        Some(f) => {
            let po = march_order(f.rings().unwrap_or(0));
            po.iter()
                .zip(&f.marches)
                .map(|(m, r)| ((m.m, m.n), r.banner))
                .collect()
        }
        None => BTreeMap::new(),
    };
    let marches = order
        .iter()
        .map(|m| {
            let (banner, keeps) = banner_of(*m, &codes);
            let code = banner.code();
            let mut flags = 0u8;
            if prev.is_some() && prev_banner.get(&(m.m, m.n)).is_some_and(|&x| x != code) {
                flags |= mflag::BANNER_CHANGED;
            }
            if mi.lead_changed.contains(&(m.m, m.n)) {
                flags |= mflag::DOMINION_CHANGED;
            }
            if mi.call.contains(&(m.m, m.n)) {
                flags |= mflag::CALL_TARGET;
            }
            ControlMarch {
                banner: code,
                points_lead: mi
                    .lead
                    .get(&(m.m, m.n))
                    .copied()
                    .unwrap_or(CONTROL_NONE)
                    .min(7),
                keeps,
                flags,
            }
        })
        .collect();
    ControlFile {
        season,
        bell: b,
        provinces,
        marches,
    }
}

// ------------------------------------------------------------------ movement (§13.4)

/// One opened province as the movement summary needs it.
#[derive(Clone, Copy, Debug)]
pub struct ProvMeta {
    pub index: u32,
    pub ring: u32,
    pub first: u32,
}

/// The series a movement summary reads: per bell, the province codes and
/// the March banners of that bell's `PSFCT1`.
pub struct Series {
    pub bells: Vec<(u32, Vec<u8>)>,
    pub banners: BTreeMap<(i32, i32), Vec<(u32, Banner)>>,
}

impl Series {
    pub fn push(&mut self, f: &ControlFile) {
        let codes: Vec<u8> = f.provinces.iter().map(|p| p.control).collect();
        let order = march_order(f.rings().unwrap_or(0));
        for (m, r) in order.iter().zip(&f.marches) {
            let b = match r.banner {
                x if x < 6 => Banner::Faction(x),
                _ => {
                    if banner_of(*m, &codes).0 == Banner::None {
                        Banner::None
                    } else {
                        Banner::Contested
                    }
                }
            };
            self.banners
                .entry((m.m, m.n))
                .or_default()
                .push((f.bell, b));
        }
        self.bells.push((f.bell, codes));
    }
}

/// §13.4's map figures over a season's control series (`end_bell − 1`
/// is the last entry). `hmr` = `heartland_max_ring`.
pub fn movement(s: &Series, metas: &[ProvMeta], hmr: u8, end_bell: u32) -> crate::cqfmt::Movement {
    use crate::cqfmt::{Movement, Ratio};
    let changes = control::lasting_changes(&s.bells, control::LASTING_MIN_BELLS);
    let days = end_bell.div_ceil(144).max(1) as usize;
    let mut by_day = vec![0u32; days];
    for c in &changes {
        let d = (c.bell / 144) as usize;
        if d < by_day.len() {
            by_day[d] += 1;
        } else {
            by_day.resize(d + 1, 0);
            by_day[d] += 1;
        }
    }
    let days_with_change = (1..=6usize)
        .filter(|&d| by_day.get(d).is_some_and(|&x| x > 0))
        .count() as u32;
    let at = |i: u32, b: u32| -> Option<u8> {
        let k = s.bells.partition_point(|(x, _)| *x <= b);
        let (_, codes) = s.bells.get(k.checked_sub(1)?)?;
        codes.get(i as usize).copied()
    };
    let outside = |m: &ProvMeta| m.ring >= 2 && m.ring > hmr as u32;
    // 10c over P
    let p_set: Vec<&ProvMeta> = metas
        .iter()
        .filter(|m| outside(m) && m.first <= 144)
        .collect();
    let mut two = 0u32;
    for m in &p_set {
        let mut seen = BTreeSet::new();
        for (_, codes) in &s.bells {
            if let Some(&c) = codes.get(m.index as usize) {
                if c < 6 {
                    seen.insert(c);
                }
            }
        }
        if seen.len() >= 2 {
            two += 1;
        }
    }
    // 10d
    let mut banner_changes = 0u32;
    let (mut two_banners, mut marches) = (0u32, 0u32);
    for series in s.banners.values() {
        banner_changes += control::banner_changes(series).len() as u32;
        let distinct: BTreeSet<u8> = series
            .iter()
            .filter_map(|(_, b)| match b {
                Banner::Faction(f) => Some(*f),
                _ => None,
            })
            .collect();
        if !distinct.is_empty() {
            marches += 1;
        }
        if distinct.len() >= 2 {
            two_banners += 1;
        }
    }
    // 10e′ and 10e
    let last = end_bell.saturating_sub(1);
    let net = |set: &mut dyn Iterator<Item = (&ProvMeta, u32)>| -> Ratio {
        let mut r = Ratio::default();
        for (m, rb) in set {
            if let (Some(a), Some(z)) = (at(m.index, rb), at(m.index, last)) {
                if a < 6 && z < 6 {
                    r.den += 1;
                    if a != z {
                        r.num += 1;
                    }
                }
            }
        }
        r
    };
    let net_movement = net(&mut metas
        .iter()
        .filter(|m| outside(m) && m.first <= last)
        .map(|m| (m, m.first.max(287))));
    let net_10e = net(&mut metas
        .iter()
        .filter(|m| outside(m) && m.first <= 288)
        .map(|m| (m, 287)));
    // 10f
    let mut gain = [false; 6];
    let mut loss = [false; 6];
    for c in &changes {
        gain[c.to as usize % 6] = true;
        loss[c.from as usize % 6] = true;
    }
    let breadth = (0..6).filter(|&f| gain[f] && loss[f]).count() as u32;
    // 10g at end_bell − 1
    let mut count = [0u32; 6];
    if let Some((_, codes)) = s.bells.last() {
        for m in metas.iter().filter(|m| m.ring >= 2) {
            if let Some(&c) = codes.get(m.index as usize) {
                if c < 6 {
                    count[c as usize] += 1;
                }
            }
        }
    }
    let total: u32 = count.iter().sum();
    let largest = Ratio {
        num: count.iter().copied().max().unwrap_or(0),
        den: total,
    };
    let smallest = Ratio {
        num: count.iter().copied().min().unwrap_or(0),
        den: total,
    };
    Movement {
        lasting_changes: changes.len() as u32,
        lasting_by_day: by_day,
        days_with_change,
        two_controllers: Ratio {
            num: two,
            den: p_set.len() as u32,
        },
        banner_changes,
        marches_two_banners: Ratio {
            num: two_banners,
            den: marches,
        },
        net_movement,
        net_movement_10e: net_10e,
        breadth,
        largest,
        smallest,
        ..Default::default()
    }
}

/// The citizens (tags) with a non-civilian host of `faction` on `tile`
/// after the bell (entries in roster or departed state), plus `extra`
/// host ids; `tag_of(host id)` names the owner.
pub fn hosts_on(
    pd: &[u8],
    tile: u8,
    faction: u8,
    extra: &[u64],
    tag_of: &dyn Fn(u64) -> Option<u64>,
) -> BTreeSet<u64> {
    use frontier_abi::layout::province::entry as E;
    let mut out = BTreeSet::new();
    let Some(block) = pd.get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE) else {
        return out;
    };
    for e in block.chunks_exact(E::SIZE) {
        if e[E::STATE] == E::STATE_FREE || e[E::TILE] != tile || e[E::FACTION] != faction {
            continue;
        }
        let civilian =
            frontier_abi::entry::unit_from_u8(e[E::UNIT]).is_none_or(|u| u.is_civilian());
        if civilian {
            continue;
        }
        let id = u64::from_le_bytes(e[E::ID..E::ID + 8].try_into().unwrap_or_default());
        if let Some(t) = tag_of(id) {
            out.insert(t);
        }
    }
    for id in extra.iter().filter(|&&x| x != 0) {
        if let Some(t) = tag_of(*id) {
            out.insert(t);
        }
    }
    out
}

/// The site tile of site `s`.
pub fn site_tile(pd: &[u8], s: usize) -> Option<u8> {
    pd.get(P::SITES + s).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_points_lead_is_a_unique_maximum() {
        assert_eq!(points_lead(&[0; 7]), (7, 0));
        assert_eq!(points_lead(&[5, 5, 0, 0, 0, 0, 0]), (7, 0));
        assert_eq!(points_lead(&[1, 3, 0, 0, 0, 0, 0]), (1, 191));
        assert_eq!(points_lead(&[0, 0, 0, 0, 0, 0, 9]), (6, 255));
    }

    #[test]
    fn cq_unopened_records_pass_the_format_checks() {
        let mut views = BTreeMap::new();
        views.insert(
            0,
            ControlProvince {
                control: CONTROL_NEUTRAL,
                contender: CONTROL_NONE,
                flags: pflag::SEAT,
                points_lead: CONTROL_NONE,
                ..Default::default()
            },
        );
        let e = BTreeMap::new();
        let s = BTreeSet::new();
        let mi = MarchInputs {
            lead: &e,
            lead_changed: &s,
            call: &s,
        };
        let f = control_file(1, 10, 3, &views, None, &mi);
        let b = f.encode().expect("a valid PSFCT1");
        assert_eq!(ControlFile::decode(&b).expect("decodes"), f);
        assert!(f.marches.iter().all(|m| m.banner == CONTROL_NONE));
    }
}
