//! A resting S1 Province in closed form (design:
//! `docs/frontier/map-growth/keeper-load-rules.ja.md` §2, stage 1).
//!
//! SkipQuiet advances a quiet Province one bell at a time: the camp's
//! daily check, the settle of what is due, the conquest step (territory,
//! records, keep, the hour snapshot) and `finish_bell`. For a Province
//! that **rests** — quiet with no work in flight, see [`resting`] — every
//! one of those is either the identity or a function of the bell number,
//! so [`project`] writes bells `resolved_next..t` at once and leaves the
//! bytes the bell-by-bell loop would (host test
//! `tests::project_equals_bell_by_bell`). The event chain is not part of
//! it: the loop chains one record per hour, a rest will chain one.
//!
//! [`rest_limit`] is how far the Province's own bytes let it rest;
//! [`quiet_through`] adds the chain's evidence (closed reveal windows,
//! no arrival bit). The official territory of a faction at a proven bell
//! is [`territory_through`]: the stored counter plus the proven tail.
//!
//! The rest is deliberately narrower than SkipQuiet's quiet: only the
//! trivial quiet test, no caravan, no fort or site change pending, no
//! roster entry joining. A Province outside it is advanced as today.

use alloc::vec::Vec;

use crate::bytes::{rd_u32, rd_u64, wr_u32, wr_u64};
use crate::clash_model::{self as cm, Camp, ModelError, DAY_BELLS, R};
use crate::conquest_model::{self as cq, Record, StepParams, HOUR_BELLS};
use crate::layout::province::entry as E;
use crate::v2::layout::province::{
    conquest as CR, fort_record as FR, keep as KP, province as P, site as SM,
};
use permutation_rules::frontier::keep::MAX_KEEP_TROOPS;

/// `Kernel` (15) sub-codes of the rest.
pub mod sub {
    /// [`super::project`] was asked past [`super::rest_limit`].
    pub const NOT_RESTING: u64 = 0x3A;
}

const BAD: ModelError = ModelError::BadAccount;
const OVERFLOW: ModelError = ModelError::Overflow;

fn rd32(pd: &[u8], o: usize) -> R<u32> {
    rd_u32(pd, o).ok_or(BAD)
}

/// Whether the Province rests at `resolved_next`: the trivial quiet test
/// holds, no siege, occupation or keep contest runs, every conquest
/// record is empty or a capture waiting, the keep (if any) is calm and no
/// caravan slot is in use.
pub fn resting(pd: &[u8]) -> R<bool> {
    if pd.len() < P::SIZE {
        return Err(BAD);
    }
    let rn = rd32(pd, P::RESOLVED_NEXT)?;
    if !cm::trivially_quiet_v2(pd, rn)? || cq::active_count(pd)? != 0 {
        return Ok(false);
    }
    for s in 0..P::SITES_N {
        let r = Record::read(pd, s)?;
        if r.kind != CR::KIND_NONE && r.kind != CR::KIND_CAPTURE_DUE {
            return Ok(false);
        }
    }
    if let Some(k) = cq::read_keep(pd)? {
        if k.contender != KP::NONE || k.progress != 0 || k.paused || k.troops > MAX_KEEP_TROOPS {
            return Ok(false);
        }
    }
    let used = cm::caravan_slots(pd)?.iter().any(|s| s.id != 0);
    Ok(!used)
}

/// The first bell of the camp's daily checks from `rn`: `rn` itself when
/// its day's check is due, else the first bell of `next_check_day`.
fn first_camp_bell(pd: &[u8], rn: u32) -> R<u32> {
    let ncd = Camp::read(pd)?.next_check_day;
    Ok(rn.max(ncd.saturating_mul(DAY_BELLS)))
}

fn next_day_bell(b: u32) -> R<u32> {
    (b / DAY_BELLS)
        .checked_add(1)
        .and_then(|d| d.checked_mul(DAY_BELLS))
        .ok_or(OVERFLOW)
}

/// How far the Province's own bytes let it rest: the largest `t' ≤ t`
/// such that bells `resolved_next..t'` rest (`resolved_next` when it does
/// not rest at all). Bounded by the season's end, the first settle due,
/// a pending site or fort change, a roster entry joining, and a camp
/// spawn after which the trivial quiet test fails.
pub fn rest_limit(pd: &[u8], t: u32, prm: &StepParams) -> R<u32> {
    let rn = rd32(pd, P::RESOLVED_NEXT)?;
    let mut lim = t.min(prm.end_bell);
    if lim <= rn || !resting(pd)? {
        return Ok(rn);
    }
    lim = lim.min(cm::next_due(pd)?);
    let n = (pd[P::SITE_COUNT] as usize).min(P::SITES_N);
    for s in 0..n {
        let o = P::site(s);
        let st = pd[o + SM::STATE];
        if st != SM::STATE_HOLDING && st != SM::STATE_FREE_CITY {
            continue;
        }
        for (pb, dl) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            let bell = rd32(pd, o + pb)?;
            if bell != SM::NO_BELL && rd_u64(pd, o + dl).ok_or(BAD)? != 0 {
                lim = lim.min(bell);
            }
        }
    }
    for i in 0..FR::N {
        let o = FR::at(i);
        if pd[o + FR::STATE] != FR::STATE_LIVE {
            continue;
        }
        let pend = u16::from_le_bytes([pd[o + FR::PEND], pd[o + FR::PEND + 1]]);
        if pend > 0 {
            lim = lim.min(rd32(pd, o + FR::PEND_BELL)?);
        }
    }
    for i in 0..P::ENTRIES_N {
        let o = P::entry(i);
        if pd[o + E::STATE] == E::STATE_ROSTER {
            let from = rd32(pd, o + E::FROM_BELL)?;
            if from > rn {
                lim = lim.min(from);
            }
        }
    }
    // A camp that spawns where the trivial test fails ends the rest
    // before its bell (SkipQuiet would stop there too).
    let terrain = cm::terrain_of(pd)?;
    let keep_tile = cq::read_keep(pd)?.map(|k| k.tile);
    let mut scratch: Option<Vec<u8>> = None;
    let mut b = first_camp_bell(pd, rn)?;
    while b < lim {
        let s = scratch.get_or_insert_with(|| pd.to_vec());
        if let Some((c, spawned)) = cm::camp_check_v2(s, &terrain, b, keep_tile)? {
            c.write(s)?;
            if spawned && !cm::trivially_quiet_v2(s, b)? {
                lim = b;
                break;
            }
        }
        b = next_day_bell(b)?;
    }
    Ok(lim.max(rn))
}

/// [`rest_limit`] with the chain's evidence: bells at or after
/// `closed_until` have no proven-closed reveal window, and `arrived(b)`
/// says whether the Province's ArrivalDay has bell `b`'s bit (an absent
/// account: no). Returns the proven `t'`: bells `resolved_next..t'` rest.
pub fn quiet_through(
    pd: &[u8],
    t: u32,
    prm: &StepParams,
    closed_until: u32,
    mut arrived: impl FnMut(u32) -> R<bool>,
) -> R<u32> {
    let rn = rd32(pd, P::RESOLVED_NEXT)?;
    let lim = rest_limit(pd, t, prm)?.min(closed_until.max(rn));
    for b in rn..lim {
        if arrived(b)? {
            return Ok(b);
        }
    }
    Ok(lim)
}

/// The REST record's digest of the Province after a rest from `from` to
/// `to`: `sha256("PSF-REST-v1" ‖ from ‖ to ‖ state block ‖ conquest
/// block)`, SKIP's quiet digest shape with the run's end.
pub fn rest_digest(pd: &[u8], from: u32, to: u32) -> R<[u8; 32]> {
    let st = pd.get(cm::STATE_BLOCK).ok_or(BAD)?;
    let cqb = pd.get(P::CQ_BLOCK).ok_or(BAD)?;
    Ok(permutation_rules::hash::sha256(&[
        REST_DOMAIN,
        &from.to_le_bytes(),
        &to.to_le_bytes(),
        st,
        cqb,
    ]))
}

/// Domain of [`rest_digest`].
pub const REST_DOMAIN: &[u8] = b"PSF-REST-v1";

/// What [`project`] wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rest {
    /// Bells `from..to` were advanced.
    pub from: u32,
    pub to: u32,
    /// The keep's holder, when a faction holds it.
    pub holder: Option<u8>,
    /// Territory bells added to `holder`.
    pub territory: u64,
    /// The camps that spawned, with their day.
    pub spawns: Vec<(Camp, u32)>,
}

/// The territory bells the bell-by-bell loop would add over
/// `resolved_next..t`: `(holder, bells, new score cursor)`.
fn territory_tail(pd: &[u8], t: u32, end_bell: u32) -> R<(Option<u8>, u64, u32)> {
    let rn = rd32(pd, P::RESOLVED_NEXT)?;
    let opened = rd32(pd, P::OPENED_BELL)?;
    let stored = rd32(pd, P::SCORE_NEXT_BELL)?;
    let next = stored.max(opened);
    let (lo, hi) = (rn.max(next), t.min(end_bell));
    if lo >= hi {
        return Ok((None, 0, stored));
    }
    // `score_territory` refuses a bell past its cursor.
    if next < rn {
        return Err(BAD);
    }
    let holder = cq::read_keep(pd)?
        .map(|k| k.holder)
        .filter(|h| (*h as usize) < P::FACTIONS);
    Ok((holder, (hi - lo) as u64, hi))
}

/// Each faction's territory bells through the proven `t'` (from
/// [`quiet_through`]): the stored counters plus the tail a rest to `t'`
/// adds (R1: the official value).
pub fn territory_through(pd: &[u8], t: u32, end_bell: u32) -> R<[u64; P::FACTIONS]> {
    let mut out = [0u64; P::FACTIONS];
    for (f, o) in out.iter_mut().enumerate() {
        *o = rd_u64(pd, P::TERRITORY_BELLS + 8 * f).ok_or(BAD)?;
    }
    if let (Some(h), k, _) = territory_tail(pd, t, end_bell)? {
        let o = out.get_mut(h as usize).ok_or(BAD)?;
        *o = o.checked_add(k).ok_or(OVERFLOW)?;
    }
    Ok(out)
}

/// Advances a resting Province from `resolved_next` to `t` in closed
/// form: the camp's daily checks (a spawn bumps the roster epoch as
/// `finish_bell` does), the territory tail, the last `SNAP_N` hour
/// snapshots, `resolved_next = t`. The keep, the records and the roster
/// do not change in a rest. Refuses `t` past [`rest_limit`]
/// (`Kernel(NOT_RESTING)`); `t ≤ resolved_next` writes nothing.
pub fn project(pd: &mut [u8], t: u32, prm: &StepParams) -> R<Rest> {
    let rn = rd32(pd, P::RESOLVED_NEXT)?;
    let mut rest = Rest {
        from: rn,
        to: rn,
        holder: None,
        territory: 0,
        spawns: Vec::new(),
    };
    if t <= rn {
        return Ok(rest);
    }
    if rest_limit(pd, t, prm)? < t {
        return Err(ModelError::Kernel(sub::NOT_RESTING));
    }
    // 1. territory (read before step 3 moves `resolved_next`)
    let (holder, k, cursor) = territory_tail(pd, t, prm.end_bell)?;
    if let Some(h) = holder {
        let o = P::TERRITORY_BELLS + 8 * h as usize;
        let v = rd_u64(pd, o).ok_or(BAD)?.checked_add(k).ok_or(OVERFLOW)?;
        if !wr_u64(pd, o, v) {
            return Err(BAD);
        }
        rest.holder = Some(h);
        rest.territory = k;
    }
    if !wr_u32(pd, P::SCORE_NEXT_BELL, cursor) {
        return Err(BAD);
    }
    // 2. the hour snapshots (only the last SNAP_N survive the ring)
    let first_hour = rn.div_ceil(HOUR_BELLS);
    let end_hour = t.div_ceil(HOUR_BELLS);
    let from_hour = first_hour.max(end_hour.saturating_sub(P::SNAP_N as u32));
    for h in from_hour..end_hour {
        cq::write_snapshot(pd, h.checked_mul(HOUR_BELLS).ok_or(OVERFLOW)?)?;
    }
    // 3. the camp's daily checks; a spawn closes its bell as finish_bell
    // does (roster epoch, entry count)
    let terrain = cm::terrain_of(pd)?;
    let keep_tile = cq::read_keep(pd)?.map(|k| k.tile);
    let mut b = first_camp_bell(pd, rn)?;
    while b < t {
        if let Some((c, spawned)) = cm::camp_check_v2(pd, &terrain, b, keep_tile)? {
            c.write(pd)?;
            if spawned {
                rest.spawns.push((c, b / DAY_BELLS));
                cm::finish_bell(pd, b, true)?;
            }
        }
        b = next_day_bell(b)?;
    }
    // 4. close the run
    cm::finish_bell(pd, t - 1, false)?;
    rest.to = t;
    Ok(rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{write_entry, Entry, EntryOp};
    use crate::v2::kernel::keep::Keep;
    use crate::v2::layout::province::caravan_slot as CS;
    use crate::v2::layout::{write_header, AccountKind};
    use crate::v2::presets::S1_TEST;
    use permutation_rules::frontier::geometry::{region_of, ProvinceCoord, PROVINCE_TILES};
    use permutation_rules::frontier::terrain::generate_province;
    use std::vec;

    const END: u32 = 4_032;

    fn prm() -> StepParams {
        StepParams {
            genesis_ts: 1_700_000_000,
            end_bell: END,
            cq: S1_TEST.cq,
        }
    }

    /// xorshift64*: deterministic cases without a dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u32) -> u32 {
            (self.next() % n.max(1) as u64) as u32
        }
        fn chance(&mut self, pct: u32) -> bool {
            self.below(100) < pct
        }
    }

    fn put32(d: &mut [u8], o: usize, v: u32) {
        d[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put64(d: &mut [u8], o: usize, v: u64) {
        d[o..o + 8].copy_from_slice(&v.to_le_bytes());
    }

    fn host(id: u64, faction: u8, tile: u8, from: u32) -> Entry {
        Entry {
            id,
            faction,
            unit: 0,
            tile,
            state: E::STATE_ROSTER,
            troops: 1_000_000,
            stamina_value: 100,
            dealt_bps: 10_000,
            stamina_bell: 0,
            ready_bell: 0,
            from_bell: from,
            pend_bell: 0,
            op: EntryOp::None,
        }
    }

    /// A v2 Province with real terrain (as OpenProvince encodes it) and a
    /// random mix of keep, holdings, Free City, camp, residents, pending
    /// changes and forts, resolved to a random bell.
    fn province(rng: &mut Rng) -> Vec<u8> {
        let mut d = vec![0u8; P::SIZE];
        assert!(write_header(&mut d, AccountKind::Province, 7));
        let coord = ProvinceCoord::from_index(7 + rng.below(300));
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&rng.next().to_le_bytes());
        let t = generate_province(&seed, coord);
        for i in 0..PROVINCE_TILES {
            d[P::TERRAIN + i] = t.terrain[i] as u8;
            d[P::RESOURCE + i] = t.resource[i].map_or(0, |r| 1 + r as u8);
        }
        d[P::SITES..P::SITES + t.sites.len()].copy_from_slice(&t.sites);
        d[P::SITE_COUNT] = t.site_count;
        d[P::P..P::P + 2].copy_from_slice(&(coord.p as i16).to_le_bytes());
        d[P::Q..P::Q + 2].copy_from_slice(&(coord.q as i16).to_le_bytes());
        d[P::RING..P::RING + 2].copy_from_slice(&(coord.ring() as u16).to_le_bytes());
        d[P::WEDGE] = coord.wedge().unwrap_or(0xFF);
        d[P::REGION] = region_of(coord);
        let rn = rng.below(3_600);
        put32(&mut d, P::RESOLVED_NEXT, rn);
        put32(&mut d, P::OPENED_BELL, rn.saturating_sub(rng.below(400)));
        put32(&mut d, P::SCORE_NEXT_BELL, rn);
        for f in 0..P::FACTIONS {
            put64(&mut d, P::TERRITORY_BELLS + 8 * f, rng.below(2_000) as u64);
        }
        put32(&mut d, P::ROSTER_EPOCH, rng.below(50));
        // who lives here: mostly one faction, sometimes a second
        let f = rng.below(6) as u8;
        let other = if rng.chance(15) { (f + 1) % 6 } else { f };
        // the keep, on a tile that is no site
        let site_tiles = &t.sites[..t.site_count as usize];
        let free_tile = |rng: &mut Rng| loop {
            let x = rng.below(PROVINCE_TILES as u32) as u8;
            if !site_tiles.contains(&x) {
                break x;
            }
        };
        let keep_tile = free_tile(rng);
        if rng.chance(85) {
            let k = Keep {
                tile: keep_tile,
                holder: if rng.chance(80) {
                    f
                } else {
                    rng.below(6) as u8
                },
                contender: KP::NONE,
                progress: 0,
                required: 72,
                heartland_safe: rng.chance(20),
                paused: false,
                changes: 0,
                troops: rng.below(200),
                since_bell: 0,
                consolidated_until_bell: if rng.chance(30) {
                    rn + rng.below(400)
                } else {
                    0
                },
                contest_from_bell: 0,
                gen: 0,
                last_taken_from: KP::NONE,
            };
            cq::write_keep(&mut d, &k).unwrap();
        } else {
            cq::write_no_keep(&mut d).unwrap();
        }
        // sites: holdings of `f`, a Free City, some pending changes
        for s in 0..site_tiles.len() {
            let o = P::site(s);
            match rng.below(4) {
                0 | 1 => {
                    d[o + SM::STATE] = SM::STATE_HOLDING;
                    d[o + SM::FACTION] = if rng.chance(90) { f } else { other };
                    d[o + SM::ORDER] = 1 + s as u8;
                    d[o + SM::TIER] = rng.below(3) as u8;
                    put32(&mut d, o + SM::GARRISON, rng.below(50) * 1_000);
                    if rng.chance(30) {
                        d[o + SM::TIER_NEXT] = 1 + rng.below(3) as u8;
                        put32(&mut d, o + SM::TIER_NEXT_BELL, rn + rng.below(600));
                    }
                    let pend = if rng.chance(15) {
                        rn + 1 + rng.below(900)
                    } else {
                        SM::NO_BELL
                    };
                    put32(&mut d, o + SM::PEND0_BELL, pend);
                    put64(
                        &mut d,
                        o + SM::PEND0_DELTA,
                        (pend != SM::NO_BELL) as u64 * 1_000,
                    );
                    put32(&mut d, o + SM::PEND1_BELL, SM::NO_BELL);
                }
                2 => {
                    d[o + SM::STATE] = SM::STATE_FREE_CITY;
                    d[o + SM::FACTION] = permutation_rules::frontier::clash::NEUTRAL;
                    put32(&mut d, o + SM::GARRISON, 20_000);
                    put32(&mut d, o + SM::PEND0_BELL, SM::NO_BELL);
                    put32(&mut d, o + SM::PEND1_BELL, SM::NO_BELL);
                }
                _ => {
                    put32(&mut d, o + SM::PEND0_BELL, SM::NO_BELL);
                    put32(&mut d, o + SM::PEND1_BELL, SM::NO_BELL);
                }
            }
        }
        // the camp
        let day = rn / DAY_BELLS;
        let camp = Camp {
            tile: free_tile(rng),
            state: if rng.chance(25) { 1 } else { 0 },
            troops: rng.below(40),
            next_check_day: day + rng.below(2),
            gen: rng.below(5),
        };
        if camp.tile != keep_tile {
            camp.write(&mut d).unwrap();
        } else {
            Camp { state: 0, ..camp }.write(&mut d).unwrap();
        }
        // residents, one faction per tile; some join later
        for i in 0..rng.below(5) as usize {
            let tile = match rng.below(3) {
                0 => keep_tile,
                _ => free_tile(rng),
            };
            let fac = if rng.chance(90) { f } else { other };
            let from = if rng.chance(15) {
                rn + 1 + rng.below(500)
            } else {
                0
            };
            write_entry(&mut d, i, &host(100 + i as u64, fac, tile, from)).unwrap();
        }
        let n = (0..P::ENTRIES_N)
            .filter(|i| d[P::entry(*i) + E::STATE] != E::STATE_FREE)
            .count();
        d[P::N_ENTRIES] = n as u8;
        // a fort, sometimes with troops on the way
        if rng.chance(15) {
            let o = FR::at(0);
            d[o + FR::TILE] = free_tile(rng);
            d[o + FR::FACTION] = f;
            d[o + FR::STATE] = FR::STATE_LIVE;
            put32(&mut d, o + FR::TROOPS, rng.below(3) * 1_000);
            if rng.chance(50) {
                put32(&mut d, o + FR::PEND_BELL, rn + 1 + rng.below(700));
                d[o + FR::PEND..o + FR::PEND + 2].copy_from_slice(&5u16.to_le_bytes());
            }
        }
        d
    }

    /// SkipQuiet's loop over bells `resolved_next..t` (permutation-frontier
    /// `proc/clash.rs` skip_quiet, steps 3–7), without the windows, the
    /// arrival bits and the events: the reference `project` must equal.
    fn bell_by_bell(pd: &mut [u8], t: u32, prm: &StepParams) {
        let rn = rd32(pd, P::RESOLVED_NEXT).unwrap();
        let mut quiet_known = false;
        let mut masks: Option<([u8; PROVINCE_TILES], u32)> = None;
        let mut due = cm::next_due(pd).unwrap();
        for b in rn..t {
            let mut changed = false;
            if b / DAY_BELLS >= Camp::read(pd).unwrap().next_check_day {
                let terrain = cm::terrain_of(pd).unwrap();
                let kt = cq::read_keep(pd).unwrap().map(|k| k.tile);
                if let Some((c, spawned)) = cm::camp_check_v2(pd, &terrain, b, kt).unwrap() {
                    c.write(pd).unwrap();
                    if spawned {
                        changed = true;
                        quiet_known = false;
                    }
                }
            }
            if !quiet_known {
                assert!(cm::trivially_quiet_v2(pd, b).unwrap(), "not quiet at {b}");
                quiet_known = true;
            }
            let m = match masks {
                Some((m, h)) if b < h => m,
                _ => {
                    let (m, h) = cm::tile_masks_horizon(pd, b).unwrap();
                    masks = Some((m, h));
                    m
                }
            };
            let rep = cq::report_from_masks(pd, &m).unwrap();
            if b >= due {
                if cm::settle_bell(pd, b).unwrap() {
                    masks = None;
                    changed = true;
                }
                due = cm::next_due(pd).unwrap();
            }
            let st = cq::step(pd, b, &rep, prm).unwrap();
            if st.roster_changed {
                masks = None;
                changed = true;
            }
            cm::finish_bell(pd, b, changed).unwrap();
            if changed || st.quiet_inputs_changed {
                quiet_known = false;
            }
        }
    }

    fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
        a.iter().zip(b).position(|(x, y)| x != y)
    }

    /// The safety net of stage 1: over thousands of random Provinces and
    /// lengths, `project` (in one step and in two) leaves exactly the bytes
    /// of the bell-by-bell loop, and `territory_through` predicts the
    /// counters it writes. The coverage counters make sure the cases
    /// include long rests, camp spawns, held keeps, tier upgrades and
    /// every kind of bound.
    #[test]
    fn project_equals_bell_by_bell() {
        let prm = prm();
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let (mut long, mut spawns, mut held, mut stopped, mut none) = (0, 0, 0, 0, 0);
        for case in 0..3_000 {
            let pd = province(&mut rng);
            let rn = rd32(&pd, P::RESOLVED_NEXT).unwrap();
            let want = rn + 1 + rng.below(1_500);
            let lim = rest_limit(&pd, want, &prm).unwrap();
            assert!(lim >= rn && lim <= want.min(END).max(rn), "case {case}");
            if lim == rn {
                none += 1;
                continue;
            }
            if lim < want.min(END) {
                stopped += 1;
            }
            if lim - rn >= DAY_BELLS {
                long += 1;
            }
            let mut a = pd.clone();
            let rest = project(&mut a, lim, &prm).unwrap();
            let mut b = pd.clone();
            bell_by_bell(&mut b, lim, &prm);
            assert_eq!(first_diff(&a, &b), None, "case {case}: rn {rn} lim {lim}");
            spawns += rest.spawns.len();
            held += rest.holder.is_some() as u32;
            // in two steps
            let mid = rn + (lim - rn) / 2;
            let mut c = pd.clone();
            project(&mut c, mid, &prm).unwrap();
            project(&mut c, lim, &prm).unwrap();
            assert_eq!(first_diff(&c, &b), None, "case {case}: two steps at {mid}");
            // the official value
            let tv = territory_through(&pd, lim, END).unwrap();
            for (f, v) in tv.iter().enumerate() {
                assert_eq!(*v, rd_u64(&b, P::TERRITORY_BELLS + 8 * f).unwrap());
            }
        }
        std::eprintln!(
            "rests: long {long}, camp spawns {spawns}, held {held}, bounded {stopped}, none {none}"
        );
        assert!(long > 300, "long rests {long}");
        assert!(spawns > 50, "camp spawns {spawns}");
        assert!(held > 300, "held keeps {held}");
        assert!(stopped > 100, "bounded rests {stopped}");
        assert!(none > 50, "non-resting provinces {none}");
    }

    /// A Province at bell 100 that rests: one faction's keep, nothing
    /// else.
    fn calm() -> Vec<u8> {
        let mut rng = Rng(1);
        let mut d = province(&mut rng);
        for i in 0..P::ENTRIES_N {
            d[P::entry(i)..P::entry(i) + E::SIZE].fill(0);
        }
        d[P::N_ENTRIES] = 0;
        for s in 0..P::SITES_N {
            d[P::site(s)..P::site(s) + SM::SIZE].fill(0);
            put32(&mut d, P::site(s) + SM::PEND0_BELL, SM::NO_BELL);
            put32(&mut d, P::site(s) + SM::PEND1_BELL, SM::NO_BELL);
        }
        d[FR::at(0)..FR::at(0) + FR::SIZE].fill(0);
        put32(&mut d, P::RESOLVED_NEXT, 100);
        put32(&mut d, P::OPENED_BELL, 0);
        put32(&mut d, P::SCORE_NEXT_BELL, 100);
        let k = Keep {
            tile: 30,
            holder: 2,
            contender: KP::NONE,
            progress: 0,
            required: 72,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: 10,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: KP::NONE,
        };
        cq::write_keep(&mut d, &k).unwrap();
        Camp {
            tile: 0,
            state: 0,
            troops: 0,
            next_check_day: 1_000,
            gen: 0,
        }
        .write(&mut d)
        .unwrap();
        assert!(resting(&d).unwrap());
        d
    }

    /// The proof stops where the chain says something may happen.
    #[test]
    fn quiet_through_stops_at_the_evidence() {
        let prm = prm();
        let d = calm();
        let no = |_: u32| Ok(false);
        assert_eq!(quiet_through(&d, 400, &prm, u32::MAX, no).unwrap(), 400);
        // an arrival bit at 250: bells 100..250 rest
        assert_eq!(
            quiet_through(&d, 400, &prm, u32::MAX, |b| Ok(b == 250)).unwrap(),
            250
        );
        // an arrival at the first bell: nothing
        assert_eq!(
            quiet_through(&d, 400, &prm, u32::MAX, |b| Ok(b == 100)).unwrap(),
            100
        );
        // windows proven closed only before 180
        assert_eq!(quiet_through(&d, 400, &prm, 180, no).unwrap(), 180);
        assert_eq!(quiet_through(&d, 400, &prm, 50, no).unwrap(), 100);
        // the season's end
        assert_eq!(
            quiet_through(&d, END + 500, &prm, u32::MAX, no).unwrap(),
            END
        );
        // asked no further than resolved_next
        assert_eq!(quiet_through(&d, 90, &prm, u32::MAX, no).unwrap(), 100);
    }

    /// Each kind of activity takes the Province out of the rest, or bounds
    /// it, and `project` refuses to go past the bound.
    #[test]
    fn activity_ends_or_bounds_the_rest() {
        let prm = prm();
        let base = calm();
        let lim = |d: &[u8]| rest_limit(d, 400, &prm).unwrap();
        assert_eq!(lim(&base), 400);
        // a keep contest running
        let mut d = base.clone();
        let mut k = cq::read_keep(&d).unwrap().unwrap();
        k.contender = 4;
        k.progress = 3;
        cq::write_keep(&mut d, &k).unwrap();
        assert_eq!(lim(&d), 100);
        // a siege record
        let mut d = base.clone();
        Record {
            kind: CR::KIND_SIEGE,
            ..Record::ZERO
        }
        .write(&mut d, 0)
        .unwrap();
        assert_eq!(lim(&d), 100);
        // a caravan on the road
        let mut d = base.clone();
        put64(&mut d, CS::at(0) + CS::ID, 77);
        assert_eq!(lim(&d), 100);
        // two factions on one tile: not trivially quiet
        let mut d = base.clone();
        write_entry(&mut d, 0, &host(1, 2, 12, 0)).unwrap();
        write_entry(&mut d, 1, &host(2, 3, 12, 0)).unwrap();
        assert_eq!(lim(&d), 100);
        // a resident joining at 222 bounds it there
        let mut d = base.clone();
        write_entry(&mut d, 0, &host(1, 2, 12, 222)).unwrap();
        assert_eq!(lim(&d), 222);
        // a fort's troops arriving at 150
        let mut d = base.clone();
        let o = FR::at(1);
        d[o + FR::TILE] = 40;
        d[o + FR::FACTION] = 2;
        d[o + FR::STATE] = FR::STATE_LIVE;
        put32(&mut d, o + FR::PEND_BELL, 150);
        d[o + FR::PEND..o + FR::PEND + 2].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(lim(&d), 150);
        // a holding's garrison change at 300
        let mut d = base.clone();
        let s = 0;
        let o = P::site(s);
        d[o + SM::STATE] = SM::STATE_HOLDING;
        d[o + SM::FACTION] = 2;
        d[o + SM::ORDER] = 1;
        put32(&mut d, o + SM::PEND0_BELL, 300);
        put64(&mut d, o + SM::PEND0_DELTA, 1_000);
        assert_eq!(lim(&d), 300);
        let mut e = d.clone();
        assert_eq!(
            project(&mut e, 301, &prm),
            Err(ModelError::Kernel(sub::NOT_RESTING))
        );
        assert_eq!(e, d, "a refused projection writes nothing");
        assert!(project(&mut e, 300, &prm).is_ok());
    }

    /// A season's worth of rest in one projection: the holder gets every
    /// bell up to the end and nothing after; the cursor stops at the end.
    #[test]
    fn rest_to_the_season_end() {
        let prm = prm();
        let mut d = calm();
        let before = rd_u64(&d, P::TERRITORY_BELLS + 8 * 2).unwrap();
        let r = project(&mut d, END, &prm).unwrap();
        assert_eq!(
            (r.from, r.to, r.holder, r.territory),
            (100, END, Some(2), (END - 100) as u64)
        );
        assert_eq!(
            rd_u64(&d, P::TERRITORY_BELLS + 8 * 2).unwrap(),
            before + (END - 100) as u64
        );
        assert_eq!(rd32(&d, P::SCORE_NEXT_BELL).unwrap(), END);
        assert_eq!(rd32(&d, P::RESOLVED_NEXT).unwrap(), END);
        assert_eq!(rest_limit(&d, END + 10, &prm).unwrap(), END);
    }
}
