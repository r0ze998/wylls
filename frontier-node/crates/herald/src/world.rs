//! The world's extent as data (map growth, `docs/frontier/map-growth/`):
//! which rings exist, which are waiting for their seed, which Provinces of
//! each ring are on chain, and where the season's map ends. Nothing here is
//! new state: it is read from the accounts the fold already captures (the
//! Season, the Frontier, each RingSeed, each Province).
//!
//! | path | answer | cache |
//! |---|---|---|
//! | `/h/world` | the manifest: identifiers, `rMax`, rings and their state | `max-age=5` |
//! | `/h/world/ring/{d}` | the Provinces of ring `d` on chain, with region, wedge and opening bell | `max-age=5` |
//!
//! **The four states of a place** (what a page or a later feature can tell
//! apart without scanning the chain): a Province whose ring `d` is
//!
//! - `d > rMax`: **outside** the season's map (it can never open this season);
//! - `d ≥ ringsOpened`, `d ≤ rMax`: **unopened** (no land yet: it opens when
//!   the crowding rule of OpenRing holds, §3.4);
//! - `d < ringsOpened` but its RingSeed is still requested, or its Province
//!   not yet created: **pending** (the seed or the OpenProvince write is on
//!   its way; the ring's land is fixed once its seed is out);
//! - on chain: **open** (fog is then the viewer's own survey, never a state
//!   of the world).
//!
//! Every list here is per ring, so no reader needs the whole world at once.

use serde_json::{json, Value};

use fclient::decode::Frontier;
use permutation_rules::frontier::geometry::{
    ring_size, ProvinceCoord, PROVINCE_RADIUS, PROVINCE_TILES, R_MAX_HARD, SITES_PER_PROVINCE,
};

use crate::fold::Fold;

/// Offset of a RingSeed's status byte (`frontier-abi` `ring_seed::STATUS`).
const RS_STATUS: usize = 18;
/// RingSeed status: requested (OpenRing landed, the beacon round not yet consumed).
const RS_REQUESTED: u8 = 1;
/// RingSeed status: seeded.
const RS_SEEDED: u8 = 2;

/// One ring as the manifest states it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RingState {
    pub d: u16,
    /// `seeded`, `requested` (OpenRing landed, seed on its way) or `absent`.
    pub seed: &'static str,
    /// Provinces of the ring on chain.
    pub provinces: usize,
    /// Provinces the ring has (`6d`, the Concord 1).
    pub size: usize,
}

/// `Frontier.rings_opened`, or (before the Frontier is captured) one past
/// the last seeded ring.
pub fn rings_opened(f: &Fold) -> u16 {
    f.account(&f.ctx.frontier())
        .and_then(|c| Frontier::decode(&c.data).ok())
        .map(|fr| fr.rings_opened)
        .unwrap_or_else(|| f.st.ring_seeds.keys().next_back().map_or(0, |d| d + 1))
}

fn seed_state(f: &Fold, d: u16) -> &'static str {
    if f.st.ring_seeds.contains_key(&d) {
        return "seeded";
    }
    match f
        .account(&f.ctx.ring_seed(d))
        .and_then(|c| c.data.get(RS_STATUS).copied())
    {
        Some(RS_SEEDED) => "seeded",
        Some(RS_REQUESTED) => "requested",
        _ => "absent",
    }
}

/// Rings `0..ringsOpened` with their seed state and Province counts.
pub fn ring_states(f: &Fold) -> Vec<RingState> {
    (0..rings_opened(f))
        .map(|d| RingState {
            d,
            seed: seed_state(f, d),
            provinces: f.rings.get(&d).map_or(0, |s| s.len()),
            size: ring_size(d as u32) as usize,
        })
        .collect()
}

/// `GET /h/world` (`None` until the Season account is captured).
pub fn world_json(f: &Fold) -> Option<Value> {
    let se = f.season.as_ref()?;
    let rings = ring_states(f);
    Some(json!({
        "v": 1,
        "season": f.cfg.season_id.to_string(),
        "rMax": se.r_max,
        "rMaxHard": R_MAX_HARD,
        "genesisRing": se.genesis_ring,
        "ringsOpened": rings.len(),
        "provinces": f.provinces.len(),
        "rings": rings.iter().map(|r| json!({
            "d": r.d, "seed": r.seed, "provinces": r.provinces, "size": r.size,
        })).collect::<Vec<_>>(),
        // The identifiers every account, instruction and feed uses; stable for the season.
        "ids": {
            "province": "P,Q: axial coordinates on the province lattice (centre P·(9,−4) + Q·(4,5)); ring = hex distance from (0,0); wedge = sextant",
            "tile": format!("P,Q,idx: idx 0..{} in hexes_within({PROVINCE_RADIUS}) order (q, then r); global hex q,r via geometry::locate", PROVINCE_TILES - 1),
            "site": format!("P,Q,site: site 0..{} of the Province's site list", SITES_PER_PROVINCE - 1),
            "region": "sha256(\"frontier/region\" ‖ le32 P ‖ le32 Q)[0] mod 16",
        },
        "paths": {
            "ring": "/h/world/ring/{d}",
            "province": "/h/province/{P},{Q}/latest",
            "overview": "/h/overview2/{d}/latest.bin",
            "roster": "/h/roster/{d}/latest.bin",
        },
    }))
}

/// `GET /h/world/ring/{d}`: the ring's Provinces on chain (`None` beyond
/// `ringsOpened` or before the Season is captured).
pub fn ring_json(f: &Fold, d: u16) -> Option<Value> {
    f.season.as_ref()?;
    if d >= rings_opened(f) {
        return None;
    }
    let list: Vec<Value> = f
        .rings
        .get(&d)
        .into_iter()
        .flatten()
        .filter_map(|&(p, q)| {
            let m = f.provinces.get(&(p, q))?;
            let wedge = ProvinceCoord::new(p as i32, q as i32).wedge();
            Some(json!({"p": p, "q": q, "region": m.region, "wedge": wedge, "openedBell": m.first}))
        })
        .collect();
    Some(json!({
        "v": 1,
        "d": d,
        "seed": seed_state(f, d),
        "size": ring_size(d as u32),
        "provinces": list,
    }))
}
