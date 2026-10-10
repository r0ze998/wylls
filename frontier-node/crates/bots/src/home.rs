//! First-home planning for `--conquest` (PlaceHome 0x38): a port of the
//! browser's `homeSites` / `planHomes` (`permutation-server/web/frontier/
//! home.mjs`) with the program's own conditions
//! (`permutation-frontier/src/proc/citizen.rs`, `place_home`, `home_site`,
//! `home_entitlement`):
//!
//! * the province is in ring ≥ 2, below the rings opened, at most the
//!   Season's `heartland_max_ring` (`ReservedSite` otherwise), and in the
//!   citizen's own wedge;
//! * no ticket cohort of the province is live (`filed > settled` and less
//!   than 24 bells old): the program reserves the whole province;
//! * the site exists (`site < site_count`) and its mirror is `FREE` or
//!   `RELEASED_FREE`;
//! * the citizen was never granted a home (`HOME_GRANTED` is never cleared)
//!   and has no holding, no ticket and no provisional or refugee flag.
//!
//! The order is the browser's: the innermost ring first, then the FNV-1a
//! hash of `"{seed}|{p},{q},{site}"`, so two bots of one nation spread.

use fclient::abi::layout::site as ls;
use fclient::decode::{Citizen, Province};
use fclient::ix::Site;
use fclient::land::{cohort_free, NO_TICKET};
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_agents::obs::Observation;
use permutation_rules::frontier::geometry::ProvinceCoord;

/// `fjoin.mjs` `hash32`: FNV-1a over the string's UTF-16 code units.
pub fn hash32(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for c in s.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// `home.mjs` `homeSites`: the sites of one decoded Province a PlaceHome of
/// `faction` may name at `now_bell`. `max_ring` is the Season's
/// `heartland_max_ring` (the program's `ReservedSite` bound; the browser
/// leaves it to the program).
pub fn home_sites(
    pv: &Province,
    faction: u8,
    now_bell: u32,
    rings_opened: u16,
    max_ring: Option<u16>,
) -> Vec<Site> {
    let pc = ProvinceCoord::new(pv.p as i32, pv.q as i32);
    let ring = pc.ring();
    if ring < 2 || ring >= rings_opened as u32 || max_ring.is_some_and(|m| ring > m as u32) {
        return vec![];
    }
    if pc.wedge() != Some(faction) {
        return vec![];
    }
    if pv.cohorts.iter().any(|c| !cohort_free(c, now_bell)) {
        return vec![];
    }
    let n = (pv.site_count as usize).min(pv.site_mirror.len());
    (0..n)
        .filter(|&i| {
            matches!(
                pv.site_mirror[i].state,
                ls::STATE_FREE | ls::STATE_RELEASED_FREE
            )
        })
        .map(|i| Site {
            p: pv.p,
            q: pv.q,
            site: i as u8,
        })
        .collect()
}

/// The program's `home_entitlement` as the herald's Citizen shows it.
pub fn entitled(cz: &Citizen) -> bool {
    cz.flags
        & (C2::FLAG_HOME_GRANTED
            | C2::FLAG_PROVISIONAL
            | C2::FLAG_FIRST_HOLDING_FINAL
            | C2::FLAG_REFUGEE)
        == 0
        && cz.holdings_n == 0
        && cz.ticket_bell == NO_TICKET
}

/// The site a bot's PlaceHome names: the first of every province in view,
/// innermost ring first, then by `hash32("{seed}|{p},{q},{site}")`.
pub fn plan_home(obs: &Observation, faction: u8, seed: &str) -> Option<Site> {
    let bell = obs.bell();
    let rings = obs.season.rings_opened();
    let max_ring = obs
        .season
        .season
        .as_ref()
        .and_then(|s| s.conquest.as_ref())
        .map(|c| c.heartland_max_ring as u16);
    let mut all: Vec<(u32, u32, Site)> = obs
        .provinces
        .values()
        .flat_map(|v| home_sites(&v.province, faction, bell, rings, max_ring))
        .map(|s| {
            (
                ProvinceCoord::new(s.p as i32, s.q as i32).ring(),
                hash32(&format!("{seed}|{},{},{}", s.p, s.q, s.site)),
                s,
            )
        })
        .collect();
    all.sort_by_key(|(ring, h, s)| (*ring, *h, s.p, s.q, s.site));
    all.first().map(|x| x.2)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The browser's `hash32` values (node: `hash32('abc')`, `hash32('')`).
    #[test]
    fn hash32_is_the_browsers_fnv1a() {
        assert_eq!(hash32(""), 0x811c_9dc5);
        assert_eq!(hash32("a"), 0xe40c_292c);
        assert_eq!(hash32("abc"), 0x1a47_e90b);
    }
}
