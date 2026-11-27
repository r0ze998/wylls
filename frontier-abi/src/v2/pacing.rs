//! The NEXT world's pacing rules (world4-pacing-impl; owner decisions
//! Q-PM2-2 (a), Q-PM2-3, Q-PT-4 a/b/d/e, 2026-11-26/27), read from a
//! Season's own bytes so that a world created before them (world 3) keeps
//! its rules byte for byte:
//!
//! | rule | Season byte | world 3 (and every older world) |
//! |---|---|---|
//! | minimum arrival lead | base `min_lead` (276) | 2 (validated `== 2` at its creation) |
//! | first home at once on a settled rim province | conquest `pacing` (83) | 0: PlaceHome bounded by the base `r_max` |
//! | Depart stamina | conquest `depart_stamina` (84) | 0: the kernel's `march_stamina(32)` = 74 |
//! | starter host at the founding | conquest `starter_host` (85, `u16`) | 0: none |
//!
//! The reveal window (300 s) and the keep hold (36 bells) need no reader
//! here: every reader already takes them from the Season.
//!
//! **No kernel constant changes** (`RULESET_HASH_V3` is world 3's): the
//! kernel's `travel::check_arrival_bell` keeps its lead of 2; the
//! lead-taking twins below are the same arithmetic with the lead as an
//! input, and agree with the kernel at lead 2 (tested).

use permutation_rules::frontier::travel::{
    self, bell_at, TravelError, BELL_SECS, MAX_ARRIVAL_LEAD_BELLS, MAX_PATH_STEPS,
    MIN_ARRIVAL_LEAD_BELLS,
};

use super::presets::{cq_layout as L, PACING_FAST_V1, PACING_LEGACY, SEASON_CQ_OFFSET};
use crate::layout::world::season as S;

/// The stamina a Depart charges in a world without byte 84: the longest
/// path's (I-32), 74.
pub const DEPART_STAMINA_LEGACY: u16 = travel::march_stamina(MAX_PATH_STEPS as u32);
const _: () = assert!(DEPART_STAMINA_LEGACY == 74);

/// A world's pacing, as its Season states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pacing {
    /// The `pacing` byte ([`PACING_LEGACY`] / [`PACING_FAST_V1`]).
    pub mode: u8,
    /// Bells after the departure bell a march may arrive at the earliest
    /// (2, or 1 in a `pacing` 1 world whose `min_lead` is 1).
    pub min_lead: u32,
    /// The stamina a Depart charges.
    pub depart_stamina: u16,
    /// Whole troops of the starter host (0: none).
    pub starter_host: u16,
}

impl Pacing {
    /// Every world before the bytes (world 3).
    pub const LEGACY: Pacing = Pacing {
        mode: PACING_LEGACY,
        min_lead: MIN_ARRIVAL_LEAD_BELLS,
        depart_stamina: DEPART_STAMINA_LEGACY,
        starter_host: 0,
    };

    /// From the four bytes, as a reader takes them from a stored Season.
    /// `pacing` 0 is [`Pacing::LEGACY`] **whatever the other bytes hold**: a
    /// world created before the bytes (world 3) can never read anything else
    /// (its `min_lead` byte is not even consulted; hand-built Seasons that
    /// leave it 0 read the same). Under [`PACING_FAST_V1`] `min_lead` 1 is 1
    /// and anything else 2; `depart_stamina` 0 is 74. `None` only for an
    /// unknown `pacing` value or a stamina above the cap (CreateSeason
    /// refuses both).
    pub const fn from_bytes(mode: u8, min_lead: u8, depart_stamina: u8, starter_host: u16) -> Option<Pacing> {
        if mode == PACING_LEGACY {
            return Some(Pacing::LEGACY);
        }
        if mode != PACING_FAST_V1 {
            return None;
        }
        if depart_stamina as u16 > permutation_rules::frontier::host::STAMINA_CAP {
            return None;
        }
        Some(Pacing {
            mode,
            min_lead: if min_lead == 1 { 1 } else { MIN_ARRIVAL_LEAD_BELLS },
            depart_stamina: if depart_stamina == 0 {
                DEPART_STAMINA_LEGACY
            } else {
                depart_stamina as u16
            },
            starter_host,
        })
    }

    /// A Season account's pacing (v2 layout: the base `min_lead` at 276, the
    /// conquest block at 896). `None` if short or refused by
    /// [`Self::from_bytes`].
    pub fn of_season(season: &[u8]) -> Option<Pacing> {
        let at = |o: usize| season.get(o).copied();
        let cq = SEASON_CQ_OFFSET;
        let host = u16::from_le_bytes([at(cq + L::STARTER_HOST)?, at(cq + L::STARTER_HOST + 1)?]);
        Pacing::from_bytes(at(cq + L::PACING)?, at(S::MIN_LEAD)?, at(cq + L::DEPART_STAMINA)?, host)
    }

    /// The pacing a set of CreateSeason parameters gives.
    pub const fn of_params(p: &super::presets::SeasonParamsV2) -> Option<Pacing> {
        Pacing::from_bytes(p.cq.pacing, p.base.min_lead, p.cq.depart_stamina, p.cq.starter_host)
    }

    /// Whether a first home may be placed at once up to the map's effective
    /// `r_max` (the settled rim), not only within the base `r_max`.
    pub const fn first_home_at_once(&self) -> bool {
        self.mode == PACING_FAST_V1
    }
}

/// `travel::earliest_arrival_bell` with the lead an input: the arrival time
/// rounded up to the next bell start, and at least `lead` bells after the
/// departure bell.
pub const fn earliest_arrival_bell(genesis_ts: i64, depart_ts: i64, secs: u32, lead: u32) -> u32 {
    let t = depart_ts + secs as i64 - genesis_ts;
    let up = if t <= 0 {
        0
    } else {
        ((t + BELL_SECS - 1) / BELL_SECS) as u32
    };
    let after = bell_at(genesis_ts, depart_ts) + lead;
    if up > after {
        up
    } else {
        after
    }
}

/// `travel::check_arrival_bell` with the lead an input.
pub fn check_arrival_bell(
    genesis_ts: i64,
    depart_ts: i64,
    secs: u32,
    chosen: u32,
    lead: u32,
) -> Result<(), TravelError> {
    let earliest = earliest_arrival_bell(genesis_ts, depart_ts, secs, lead);
    let latest = bell_at(genesis_ts, depart_ts) + MAX_ARRIVAL_LEAD_BELLS;
    if chosen < earliest {
        return Err(TravelError::TooEarly { earliest });
    }
    if chosen > latest {
        return Err(TravelError::TooLate { latest });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::presets::{
        S1_DEVNET_TERRITORY, S1_DEVNET_TERRITORY_FAST, SEASON_PARAMS_V2_LEN,
    };

    #[test]
    fn lead_two_is_the_kernel() {
        for g in [0i64, 1_000, 1_700_000_000] {
            for d in (g - 700..g + 4_000).step_by(37) {
                for secs in [0u32, 1, 119, 599, 600, 601, 1_799, 4_000, 20_000] {
                    assert_eq!(
                        earliest_arrival_bell(g, d, secs, 2),
                        travel::earliest_arrival_bell(g, d, secs),
                        "{g} {d} {secs}"
                    );
                    for c in 0..80u32 {
                        assert_eq!(
                            check_arrival_bell(g, d, secs, c, 2),
                            travel::check_arrival_bell(g, d, secs, c)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn lead_one_only_moves_short_marches() {
        let g = 0;
        // departs in bell 10, 30 s of travel: kernel bell 12, lead 1 bell 11
        assert_eq!(travel::earliest_arrival_bell(g, 6_030, 30), 12);
        assert_eq!(earliest_arrival_bell(g, 6_030, 30, 1), 11);
        // a march longer than a bell is bound by its travel time: unchanged
        assert_eq!(earliest_arrival_bell(g, 6_030, 1_800, 1), 14);
        assert_eq!(travel::earliest_arrival_bell(g, 6_030, 1_800), 14);
        assert_eq!(check_arrival_bell(g, 6_030, 30, 10, 1), Err(TravelError::TooEarly { earliest: 11 }));
        assert!(check_arrival_bell(g, 6_030, 30, 11, 1).is_ok());
    }

    #[test]
    fn world_3_reads_legacy_and_the_fast_preset_reads_its_bytes() {
        assert_eq!(Pacing::of_params(&S1_DEVNET_TERRITORY), Some(Pacing::LEGACY));
        let f = Pacing::of_params(&S1_DEVNET_TERRITORY_FAST).unwrap();
        assert_eq!((f.mode, f.min_lead, f.depart_stamina, f.starter_host), (1, 1, 74, 500));
        assert!(f.first_home_at_once());
        // the Season account form: base bytes at 0..224 of the params map to the
        // Season's own offsets through CreateSeason; check the conquest block and lead.
        let mut season = [0u8; crate::v2::layout::world::season::SIZE];
        season[S::MIN_LEAD] = 2;
        let cq = S1_DEVNET_TERRITORY.cq.to_bytes();
        season[SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + cq.len()].copy_from_slice(&cq);
        assert_eq!(Pacing::of_season(&season), Some(Pacing::LEGACY));
        let cq = S1_DEVNET_TERRITORY_FAST.cq.to_bytes();
        season[SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + cq.len()].copy_from_slice(&cq);
        season[S::MIN_LEAD] = 1;
        assert_eq!(Pacing::of_season(&season), Some(f));
        let _ = SEASON_PARAMS_V2_LEN;
    }

    #[test]
    fn legacy_ignores_every_new_byte_and_unknown_modes_fail_closed() {
        for lead in [0u8, 1, 2, 9] {
            for st in [0u8, 37, 200] {
                for host in [0u16, 500] {
                    assert_eq!(Pacing::from_bytes(0, lead, st, host), Some(Pacing::LEGACY));
                }
            }
        }
        assert_eq!(Pacing::from_bytes(2, 2, 0, 0), None);
        assert_eq!(Pacing::from_bytes(1, 2, 121, 0), None);
        assert_eq!(Pacing::from_bytes(1, 0, 0, 0).unwrap().min_lead, 2);
        assert_eq!(Pacing::from_bytes(1, 2, 0, 0).unwrap().depart_stamina, 74);
        assert_eq!(Pacing::from_bytes(1, 1, 37, 0).unwrap().depart_stamina, 37);
    }
}
