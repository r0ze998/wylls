//! The path fetch (contract §4.3, §6.6; unit AC3b).
//!
//! A bot observes only its own holdings and their neighbours
//! (`PROVINCE_LIMIT = 12`). `path::plan` needs every province a march path
//! crosses, so a target beyond that window has no plan. The **Strike-Order
//! follow** (and only it: own march candidates stay inside the observation)
//! therefore fetches `GET /h/province/{p},{q}/latest` for the target and for
//! every province on the hex line from the host to the target, at most 3
//! hops (province boundaries crossed) and at most 8 extra GETs per step,
//! cached for the bell (a province file changes at most once a bell).
//!
//! The fetched provinces are never merged into the bot's own observation
//! (the candidate generator would then offer far camps, §4.3): [`augment`]
//! makes a copy for planning.

use std::collections::BTreeMap;
use std::sync::Mutex;

use frontier_agents::obs::{Observation, ProvinceView};
use permutation_rules::frontier::geometry::{locate, ProvinceCoord};
use permutation_rules::hex::Hex;

use crate::ports::HeraldPort;

/// Province boundaries a fetched hex line may cross (§4.3).
pub const MAX_HOPS: usize = 3;
/// Extra herald GETs one step may spend on the fetch (§4.3).
pub const MAX_EXTRA_GETS: usize = 8;

/// Why a far target cannot be planned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The hex line crosses more than [`MAX_HOPS`] province boundaries.
    TooFar,
    /// The tile is not on the map.
    OffMap,
}

/// The hex line from `a` to `b`, both ends included (cube-coordinate
/// interpolation with the usual epsilon nudge, so ties break the same way
/// every time).
pub fn hex_line(a: Hex, b: Hex) -> Vec<Hex> {
    let n = a.distance(b) as i32;
    if n == 0 {
        return vec![a];
    }
    let (aq, ar, as_) = (a.q as f64 + 1e-6, a.r as f64 + 2e-6, a.s() as f64 - 3e-6);
    let (bq, br, bs) = (b.q as f64, b.r as f64, b.s() as f64);
    (0..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            round_cube(aq + (bq - aq) * t, ar + (br - ar) * t, as_ + (bs - as_) * t)
        })
        .collect()
}

fn round_cube(q: f64, r: f64, s: f64) -> Hex {
    let (mut rq, mut rr, rs) = (q.round(), r.round(), s.round());
    let (dq, dr, ds) = ((rq - q).abs(), (rr - r).abs(), (rs - s).abs());
    if dq > dr && dq > ds {
        rq = -rr - rs;
    } else if dr > ds {
        rr = -rq - rs;
    }
    Hex::new(rq as i32, rr as i32)
}

/// The provinces on the hex line from tile `from_tile` of province `from` to
/// tile `to_tile` of province `to`, in order of first entry, both ends
/// included.
pub fn line_provinces(
    from: (i16, i16),
    from_tile: u8,
    to: (i16, i16),
    to_tile: u8,
) -> Result<Vec<(i16, i16)>, FetchError> {
    let a = ProvinceCoord::new(from.0 as i32, from.1 as i32)
        .tile(from_tile)
        .ok_or(FetchError::OffMap)?;
    let b = ProvinceCoord::new(to.0 as i32, to.1 as i32)
        .tile(to_tile)
        .ok_or(FetchError::OffMap)?;
    let mut out: Vec<(i16, i16)> = vec![];
    for h in hex_line(a, b) {
        let (pc, _) = locate(h);
        let (Ok(p), Ok(q)) = (i16::try_from(pc.p), i16::try_from(pc.q)) else {
            return Err(FetchError::OffMap);
        };
        if !out.contains(&(p, q)) {
            out.push((p, q));
        }
    }
    if out.len() > MAX_HOPS + 1 {
        return Err(FetchError::TooFar);
    }
    Ok(out)
}

/// One cached read: the bell it was made in and the file (`None`: the herald
/// had none).
type Cached = (u32, Option<ProvinceView>);

/// Province files read through the fetch, cached for the bell they were
/// read in (shared by every bot of the process: a bell's file is the same
/// for all of them).
#[derive(Default)]
pub struct PathCache {
    inner: Mutex<BTreeMap<(i16, i16), Cached>>,
}

impl PathCache {
    pub fn new() -> PathCache {
        PathCache::default()
    }

    /// `Some(entry)` when the province was read in `bell` (`None` inside:
    /// the herald had no such file).
    pub fn get(&self, bell: u32, pq: (i16, i16)) -> Option<Option<ProvinceView>> {
        self.inner
            .lock()
            .expect("path cache")
            .get(&pq)
            .filter(|(b, _)| *b == bell)
            .map(|(_, v)| v.clone())
    }

    pub fn put(&self, bell: u32, pq: (i16, i16), v: Option<ProvinceView>) {
        let mut g = self.inner.lock().expect("path cache");
        // Entries of an older bell are never read again.
        g.retain(|_, (b, _)| *b >= bell);
        g.insert(pq, (bell, v));
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("path cache").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What a fetch read.
#[derive(Clone, Debug, Default)]
pub struct Far {
    /// Provinces that are not in the observation, as the herald serves them.
    pub provinces: BTreeMap<(i16, i16), ProvinceView>,
    /// Herald GETs this fetch made (cached files cost none).
    pub gets: usize,
}

/// One province's latest file through the cache; a GET counts against
/// `budget` and an exhausted budget answers `None` without reading.
pub async fn province<H: HeraldPort>(
    herald: &H,
    cache: &PathCache,
    bell: u32,
    pq: (i16, i16),
    budget: &mut usize,
    gets: &mut usize,
) -> Option<ProvinceView> {
    if let Some(v) = cache.get(bell, pq) {
        return v;
    }
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    *gets += 1;
    let v = match herald
        .get(&format!("/h/province/{},{}/latest", pq.0, pq.1))
        .await
    {
        Ok(Some(b)) => serde_json::from_slice(&b)
            .ok()
            .and_then(|j| ProvinceView::from_json(&j).ok()),
        _ => None,
    };
    cache.put(bell, pq, v.clone());
    v
}

/// The provinces a plan from `from` to `to` may need beyond `obs`: the hex
/// line (target included), and with `widen` also the line provinces'
/// neighbours (for a line whose tiles are not all passable). At most
/// `budget` GETs are made; a province already in `obs` costs none.
#[allow(clippy::too_many_arguments)]
pub async fn far_provinces<H: HeraldPort>(
    herald: &H,
    cache: &PathCache,
    obs: &Observation,
    from: ((i16, i16), u8),
    to: ((i16, i16), u8),
    widen: bool,
    budget: &mut usize,
) -> Result<Far, FetchError> {
    let line = line_provinces(from.0, from.1, to.0, to.1)?;
    let mut want: Vec<(i16, i16)> = line.clone();
    if widen {
        for &(p, q) in &line {
            for n in ProvinceCoord::new(p as i32, q as i32).neighbors() {
                if let (Ok(np), Ok(nq)) = (i16::try_from(n.p), i16::try_from(n.q)) {
                    if !want.contains(&(np, nq)) {
                        want.push((np, nq));
                    }
                }
            }
        }
    }
    let bell = obs.bell();
    let mut far = Far::default();
    for pq in want {
        if obs.provinces.contains_key(&pq) {
            continue;
        }
        if let Some(v) = province(herald, cache, bell, pq, budget, &mut far.gets).await {
            far.provinces.insert(pq, v);
        }
    }
    Ok(far)
}

/// A copy of `obs` with the fetched provinces added (for planning only).
pub fn augment(obs: &Observation, far: &BTreeMap<(i16, i16), ProvinceView>) -> Observation {
    let mut o = obs.clone();
    for (k, v) in far {
        o.provinces.entry(*k).or_insert_with(|| v.clone());
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_has_unit_steps_and_both_ends() {
        let a = Hex::new(0, 0);
        let b = Hex::new(7, -3);
        let l = hex_line(a, b);
        assert_eq!(l.len() as u32, a.distance(b) + 1);
        assert_eq!((l[0], *l.last().unwrap()), (a, b));
        for w in l.windows(2) {
            assert_eq!(w[0].distance(w[1]), 1);
        }
        assert_eq!(hex_line(a, a), vec![a]);
    }

    #[test]
    fn neighbouring_provinces_are_one_hop_and_far_ones_are_refused() {
        let home = (3i16, -1i16);
        let tile = 30u8;
        let n = ProvinceCoord::new(home.0 as i32, home.1 as i32).neighbors()[0];
        let l = line_provinces(home, tile, (n.p as i16, n.q as i16), tile).unwrap();
        assert!(l.len() == 2 && l[0] == home);
        let far = ProvinceCoord::new(home.0 as i32 + 6, home.1 as i32);
        assert_eq!(
            line_provinces(home, tile, (far.p as i16, far.q as i16), tile),
            Err(FetchError::TooFar)
        );
    }
}
