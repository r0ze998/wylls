//! **Player territory (preview, opt-in feature `territory-preview`)**: the
//! pure rule seams of owner decision Q-2 (2026-11-24 09:24 JST): each
//! player owns a territory that grows by claiming, exclaves are allowed,
//! there is no fixed holding cap, upkeep limits expansion, and villages
//! become buildings inside one's territory.
//!
//! **Nothing here picks a number or an open option.** Every point r0ze has
//! not answered yet (inbox `2026-11-24-0933-territory-q2-questions.md`,
//! T-1 … T-13) is a field of [`TerritoryParams`], so each of the offered
//! options is one value of it:
//!
//! | question | seam |
//! |---|---|
//! | T-1 unit (tile / province) | none needed: a *cell* is whatever the caller counts; the kernel only sees distances and bells |
//! | T-2 reach and its sources | [`ReachRule`] (`range` 0 = unlimited; [`ReachRule::sources`] a bit set of [`SRC_HOME`], [`SRC_OWN`], [`SRC_NATION_KEEPS`], [`SRC_NATION_LAND`]) |
//! | T-3 claim cost and pace | [`ClaimCost`] (base + a share per cell owned), [`TerritoryParams::claims_per_turn`] |
//! | T-4 upkeep curve | [`UpkeepCurve`] (flat, per rank, per distance past a free distance) |
//! | T-5 unpaid upkeep | [`UnpaidRule`] (claims blocked, production share, decay after a grace) and [`DecayOrder`] |
//! | T-7 claiming owned land | [`TerritoryParams::claim_owned`] |
//!
//! No preset is defined: a world has no territory rule until r0ze answers,
//! and the tests use explicit numbers that are **not** proposals. With the
//! feature off nothing here is compiled (no default-build code, vector,
//! hash input or budget changes), and nothing is bound into any
//! `ruleset_hash`.
//!
//! All arithmetic is integer and checked: a result that would not fit, or
//! that passes [`MAX_TERRITORY_UPKEEP_PER_HOUR`], is `None`, never a wrap.

use alloc::vec::Vec;

use crate::fixed::{Bps, Milli, BPS_ONE};

/// Version of this kernel (preview; bump on any honest-outcome change).
pub const TERRITORY_VERSION: u16 = 1;

/// Largest territory upkeep of one player, milli-units per hour. Same
/// bound as a holding's (`holding::MAX_UPKEEP_PER_HOUR`), so a territory
/// upkeep can be one more upkeep rate of a holding without a new cap.
pub const MAX_TERRITORY_UPKEEP_PER_HOUR: Milli = crate::frontier::holding::MAX_UPKEEP_PER_HOUR;

/// Largest number of cells one player's upkeep is computed over. Far above
/// any map a world opens (a wide world of 2,322 provinces × 61 tiles is
/// 141,642 cells); it bounds `per_rank × n²` inside `i128`.
pub const MAX_CELLS: u32 = 1 << 20;

/// Reach source: the claimer's first home (today's outpost anchor).
pub const SRC_HOME: u8 = 1 << 0;
/// Reach source: a cell of the claimer's own territory.
pub const SRC_OWN: u8 = 1 << 1;
/// Reach source: a keep the claimer's nation holds.
pub const SRC_NATION_KEEPS: u8 = 1 << 2;
/// Reach source: any land of the claimer's nation (#206's rule: a
/// nation-mate's village or a won keep).
pub const SRC_NATION_LAND: u8 = 1 << 3;
const SRC_ALL: u8 = SRC_HOME | SRC_OWN | SRC_NATION_KEEPS | SRC_NATION_LAND;

/// Upkeep of a territory, milli-units of one resource per hour:
///
/// `Σ_i ( flat + per_rank × i + per_distance × max(0, d_i − free_distance) )`
///
/// over the owned cells, `i` = 0, 1, … (so the total does not depend on the
/// order the caller lists them in), `d_i` = the cell's distance to whatever
/// the caller measures from (T-4 (c): the nearest village or home).
/// `flat` alone is T-4 (a); `per_rank` is (b) (cell `n` costs
/// `flat + per_rank × (n − 1)`); `per_distance` is (c).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpkeepCurve {
    pub flat: Milli,
    pub per_rank: Milli,
    pub per_distance: Milli,
    pub free_distance: u32,
}

/// The cost of one claim, in units of one resource:
/// `base + base × owned × per_owned_bps / 10,000` (Unciv's "dearer the more
/// you own"; `per_owned_bps` 0 is a flat price).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimCost {
    pub base: u64,
    pub per_owned_bps: u32,
}

/// Where a claim may be, measured in cells from the nearest enabled source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReachRule {
    /// Largest distance from a source; 0 = unlimited (T-2 (a)).
    pub range: u32,
    /// Bit set of `SRC_*`. With `range` > 0 it must not be empty.
    pub sources: u8,
}

/// What unpaid upkeep does (T-5). Every combination is allowed: (a) is
/// `production_bps` < 10,000, (b) is `decay_after_bells`, (c) is
/// `block_claims`, (d) is (c) + (b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnpaidRule {
    /// No new claims while upkeep is unpaid.
    pub block_claims: bool,
    /// Production share of the player's buildings while unpaid
    /// (10,000 = unchanged).
    pub production_bps: Bps,
    /// Bells of unpaid upkeep before the first cell is released; `None` =
    /// cells never decay.
    pub decay_after_bells: Option<u32>,
    /// After the grace, one more cell every this many bells (≥ 1).
    pub decay_every_bells: u32,
}

/// Which owned cell an unpaid territory releases first (T-5 (b)).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecayOrder {
    /// The farthest from its measuring point first; ties: the newest claim,
    /// then the higher cell id.
    Farthest,
    /// The newest claim first; ties: the farthest, then the higher cell id.
    Newest,
}

/// The whole territory rule of a world. No value is a default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerritoryParams {
    pub upkeep: UpkeepCurve,
    pub cost: ClaimCost,
    pub reach: ReachRule,
    /// Most claims one player may make in one turn; 0 = unlimited.
    pub claims_per_turn: u8,
    /// Whether a cell another player owns may be claimed (T-7 (a) false);
    /// a decaying cell is open again once released, whatever this says.
    pub claim_owned: bool,
    pub unpaid: UnpaidRule,
    pub decay_order: DecayOrder,
}

/// Why a parameter table is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamsError {
    NegativeUpkeep,
    UnknownSource,
    NoSource,
    ProductionAboveOne,
    DecayEveryZero,
}

impl TerritoryParams {
    pub fn validate(&self) -> Result<(), ParamsError> {
        let u = &self.upkeep;
        if u.flat < 0 || u.per_rank < 0 || u.per_distance < 0 {
            return Err(ParamsError::NegativeUpkeep);
        }
        if self.reach.sources & !SRC_ALL != 0 {
            return Err(ParamsError::UnknownSource);
        }
        if self.reach.range > 0 && self.reach.sources == 0 {
            return Err(ParamsError::NoSource);
        }
        if self.unpaid.production_bps > BPS_ONE {
            return Err(ParamsError::ProductionAboveOne);
        }
        if self.unpaid.decay_after_bells.is_some() && self.unpaid.decay_every_bells == 0 {
            return Err(ParamsError::DecayEveryZero);
        }
        Ok(())
    }
}

/// Upkeep of one cell of rank `rank` (0-based) at distance `distance`.
pub fn cell_upkeep(c: &UpkeepCurve, rank: u32, distance: u32) -> Option<Milli> {
    let far = distance.saturating_sub(c.free_distance) as i128;
    let v = c.flat as i128 + c.per_rank as i128 * rank as i128 + c.per_distance as i128 * far;
    fit(v)
}

/// Upkeep per hour of a territory whose cells lie at `distances` (any
/// order). `None` past [`MAX_CELLS`] cells or past
/// [`MAX_TERRITORY_UPKEEP_PER_HOUR`].
pub fn upkeep_per_hour(c: &UpkeepCurve, distances: &[u32]) -> Option<Milli> {
    let n = u32::try_from(distances.len())
        .ok()
        .filter(|n| *n <= MAX_CELLS)? as i128;
    // Σ rank = n (n − 1) / 2, so the total does not depend on the order.
    let mut v = c.flat as i128 * n + c.per_rank as i128 * (n * (n - 1).max(0) / 2);
    for d in distances {
        v += c.per_distance as i128 * d.saturating_sub(c.free_distance) as i128;
        if v > MAX_TERRITORY_UPKEEP_PER_HOUR as i128 {
            return None;
        }
    }
    fit(v)
}

/// The upkeep the territory adds by claiming one more cell at `distance`
/// while owning `distances` (what a claim card shows as "+x / h").
pub fn upkeep_delta(c: &UpkeepCurve, distances: &[u32], distance: u32) -> Option<Milli> {
    let rank = u32::try_from(distances.len()).ok()?;
    let before = upkeep_per_hour(c, distances)?;
    let one = cell_upkeep(c, rank, distance)?;
    fit(before as i128 + one as i128).map(|_| one)
}

/// The price of the next claim while owning `owned` cells.
pub fn claim_cost(c: &ClaimCost, owned: u32) -> Option<u64> {
    let extra = (c.base as u128)
        .checked_mul(owned as u128)?
        .checked_mul(c.per_owned_bps as u128)?
        / BPS_ONE as u128;
    u64::try_from(c.base as u128 + extra).ok()
}

/// Who owns the target cell, as the claimer sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetOwner {
    Nobody,
    Claimer,
    Other,
}

/// Distances from the target to the nearest source of each kind; `None` =
/// the claimer has no such source (or the caller did not look).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Nearest {
    pub home: Option<u32>,
    pub own: Option<u32>,
    pub nation_keep: Option<u32>,
    pub nation_land: Option<u32>,
}

/// Everything a claim is judged on, read by the caller from its records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimCheck {
    /// The cell is opened and claimable land (not heartland, not water…:
    /// the caller's land gate).
    pub open: bool,
    pub owner: TargetOwner,
    pub nearest: Nearest,
    /// Cells the claimer owns now.
    pub owned: u32,
    /// Claims the claimer made this turn already.
    pub claims_this_turn: u8,
    /// The claimer's upkeep is unpaid (see [`unpaid_effect`]).
    pub upkeep_unpaid: bool,
    /// What the claimer can pay of the claim's resource.
    pub balance: u64,
}

/// Why a claim is refused, in check order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimRefusal {
    NotOpen,
    AlreadyYours,
    Owned,
    Range,
    TurnLimit,
    UpkeepUnpaid,
    Insufficient,
    Overflow,
}

/// The distance from the target to the nearest source the rule enables.
pub fn reach_distance(r: &ReachRule, n: &Nearest) -> Option<u32> {
    [
        (SRC_HOME, n.home),
        (SRC_OWN, n.own),
        (SRC_NATION_KEEPS, n.nation_keep),
        (SRC_NATION_LAND, n.nation_land),
    ]
    .into_iter()
    .filter(|(bit, _)| r.sources & bit != 0)
    .filter_map(|(_, d)| d)
    .min()
}

/// Judge a claim. `Ok(cost)` is the price to burn.
pub fn may_claim(p: &TerritoryParams, c: &ClaimCheck) -> Result<u64, ClaimRefusal> {
    if !c.open {
        return Err(ClaimRefusal::NotOpen);
    }
    match c.owner {
        TargetOwner::Claimer => return Err(ClaimRefusal::AlreadyYours),
        TargetOwner::Other if !p.claim_owned => return Err(ClaimRefusal::Owned),
        _ => {}
    }
    if p.reach.range > 0 {
        match reach_distance(&p.reach, &c.nearest) {
            Some(d) if d <= p.reach.range => {}
            _ => return Err(ClaimRefusal::Range),
        }
    }
    if p.claims_per_turn > 0 && c.claims_this_turn >= p.claims_per_turn {
        return Err(ClaimRefusal::TurnLimit);
    }
    if c.upkeep_unpaid && p.unpaid.block_claims {
        return Err(ClaimRefusal::UpkeepUnpaid);
    }
    let cost = claim_cost(&p.cost, c.owned).ok_or(ClaimRefusal::Overflow)?;
    if c.balance < cost {
        return Err(ClaimRefusal::Insufficient);
    }
    Ok(cost)
}

/// What unpaid upkeep does at bell `now`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnpaidEffect {
    pub claims_blocked: bool,
    pub production_bps: Bps,
    /// Cells released so far by this unpaid stretch (the caller releases
    /// the difference from what it has already released).
    pub cells_released: u32,
}

/// The effect of upkeep unpaid since bell `since` (`None` = paid).
pub fn unpaid_effect(r: &UnpaidRule, since: Option<u32>, now: u32) -> UnpaidEffect {
    let Some(since) = since else {
        return UnpaidEffect {
            claims_blocked: false,
            production_bps: BPS_ONE,
            cells_released: 0,
        };
    };
    let late = now.saturating_sub(since);
    let cells_released = match r.decay_after_bells {
        Some(grace) if late >= grace => 1 + (late - grace) / r.decay_every_bells.max(1),
        _ => 0,
    };
    UnpaidEffect {
        claims_blocked: r.block_claims,
        production_bps: r.production_bps,
        cells_released,
    }
}

/// One owned cell as the decay order sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnedCell {
    pub id: u64,
    pub distance: u32,
    pub claimed_bell: u32,
}

/// The cells in the order an unpaid territory releases them (indices into
/// `cells`); deterministic for any input order.
pub fn release_order(order: DecayOrder, cells: &[OwnedCell]) -> Vec<usize> {
    let mut ix: Vec<usize> = (0..cells.len()).collect();
    ix.sort_by(|&a, &b| {
        let (x, y) = (&cells[a], &cells[b]);
        let key = |c: &OwnedCell| match order {
            DecayOrder::Farthest => (c.distance, c.claimed_bell, c.id),
            DecayOrder::Newest => (c.claimed_bell, c.distance, c.id),
        };
        key(y).cmp(&key(x))
    });
    ix
}

/// The most cells at one distance `distance` whose upkeep stays within
/// `income` per hour: the territory's "natural size" under a curve (the
/// calibration a simulator sweep reads). `None` = unbounded (a curve that
/// costs nothing there), capped at [`MAX_CELLS`].
pub fn natural_size(c: &UpkeepCurve, income: Milli, distance: u32) -> Option<u32> {
    let one = cell_upkeep(c, 0, distance)?;
    if one <= 0 && c.per_rank <= 0 {
        return None;
    }
    // upkeep(n) is non-decreasing in n: binary search the largest n.
    let total = |n: u32| -> i128 {
        let n = n as i128;
        let far = distance.saturating_sub(c.free_distance) as i128;
        (c.flat as i128 + c.per_distance as i128 * far) * n
            + c.per_rank as i128 * (n * (n - 1).max(0) / 2)
    };
    let (mut lo, mut hi) = (0u32, MAX_CELLS);
    if total(hi) <= income as i128 {
        return Some(MAX_CELLS);
    }
    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        if total(mid) <= income as i128 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(lo)
}

fn fit(v: i128) -> Option<Milli> {
    (0..=MAX_TERRITORY_UPKEEP_PER_HOUR as i128)
        .contains(&v)
        .then_some(v as Milli)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed::MILLI;
    use alloc::vec;

    /// Test numbers only: not a proposal (T-4 is open).
    const CURVE: UpkeepCurve = UpkeepCurve {
        flat: 2 * MILLI,
        per_rank: MILLI / 2,
        per_distance: MILLI,
        free_distance: 3,
    };

    fn params() -> TerritoryParams {
        TerritoryParams {
            upkeep: CURVE,
            cost: ClaimCost {
                base: 100,
                per_owned_bps: 1_000,
            },
            reach: ReachRule {
                range: 3,
                sources: SRC_HOME | SRC_OWN,
            },
            claims_per_turn: 1,
            claim_owned: false,
            unpaid: UnpaidRule {
                block_claims: true,
                production_bps: 5_000,
                decay_after_bells: Some(24),
                decay_every_bells: 6,
            },
            decay_order: DecayOrder::Farthest,
        }
    }

    fn check() -> ClaimCheck {
        ClaimCheck {
            open: true,
            owner: TargetOwner::Nobody,
            nearest: Nearest {
                home: Some(9),
                own: Some(2),
                nation_keep: Some(1),
                nation_land: Some(1),
            },
            owned: 4,
            claims_this_turn: 0,
            upkeep_unpaid: false,
            balance: 1_000,
        }
    }

    #[test]
    fn upkeep_sums_flat_rank_and_distance_in_any_order() {
        // ranks 0,1,2 → 3 flat + 0.5 (0+1+2); distances 1,5,7 → 0+2+4 past 3.
        let a = upkeep_per_hour(&CURVE, &[1, 5, 7]).unwrap();
        assert_eq!(a, 3 * 2 * MILLI + 3 * MILLI / 2 + 6 * MILLI);
        assert_eq!(upkeep_per_hour(&CURVE, &[7, 1, 5]), Some(a));
        assert_eq!(upkeep_per_hour(&CURVE, &[]), Some(0));
        let mut s = 0;
        for (i, d) in [1u32, 5, 7].iter().enumerate() {
            s += cell_upkeep(&CURVE, i as u32, *d).unwrap();
        }
        assert_eq!(s, a);
        assert_eq!(
            upkeep_delta(&CURVE, &[1, 5, 7], 4),
            Some(2 * MILLI + 3 * MILLI / 2 + MILLI)
        );
    }

    #[test]
    fn upkeep_refuses_overflow_instead_of_wrapping() {
        let huge = UpkeepCurve {
            flat: MAX_TERRITORY_UPKEEP_PER_HOUR,
            per_rank: 0,
            per_distance: 0,
            free_distance: 0,
        };
        assert_eq!(
            upkeep_per_hour(&huge, &[0]),
            Some(MAX_TERRITORY_UPKEEP_PER_HOUR)
        );
        assert_eq!(upkeep_per_hour(&huge, &[0, 0]), None);
        let far = UpkeepCurve {
            flat: 0,
            per_rank: 0,
            per_distance: Milli::MAX,
            free_distance: 0,
        };
        assert_eq!(cell_upkeep(&far, 0, u32::MAX), None);
        assert_eq!(upkeep_per_hour(&far, &[u32::MAX, u32::MAX]), None);
    }

    #[test]
    fn claim_cost_grows_with_cells_owned() {
        let c = ClaimCost {
            base: 100,
            per_owned_bps: 1_000,
        };
        assert_eq!(claim_cost(&c, 0), Some(100));
        assert_eq!(claim_cost(&c, 4), Some(140));
        assert_eq!(
            claim_cost(
                &ClaimCost {
                    base: 100,
                    per_owned_bps: 0
                },
                1_000
            ),
            Some(100)
        );
        assert_eq!(
            claim_cost(
                &ClaimCost {
                    base: u64::MAX,
                    per_owned_bps: 10_000
                },
                1
            ),
            None
        );
    }

    #[test]
    fn claim_checks_in_order() {
        let p = params();
        assert_eq!(may_claim(&p, &check()), Ok(140));
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    open: false,
                    ..check()
                }
            ),
            Err(ClaimRefusal::NotOpen)
        );
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    owner: TargetOwner::Claimer,
                    ..check()
                }
            ),
            Err(ClaimRefusal::AlreadyYours)
        );
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    owner: TargetOwner::Other,
                    ..check()
                }
            ),
            Err(ClaimRefusal::Owned)
        );
        let open_owned = TerritoryParams {
            claim_owned: true,
            ..p
        };
        assert_eq!(
            may_claim(
                &open_owned,
                &ClaimCheck {
                    owner: TargetOwner::Other,
                    ..check()
                }
            ),
            Ok(140)
        );
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    claims_this_turn: 1,
                    ..check()
                }
            ),
            Err(ClaimRefusal::TurnLimit)
        );
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    upkeep_unpaid: true,
                    ..check()
                }
            ),
            Err(ClaimRefusal::UpkeepUnpaid)
        );
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    balance: 139,
                    ..check()
                }
            ),
            Err(ClaimRefusal::Insufficient)
        );
        let soft = TerritoryParams {
            unpaid: UnpaidRule {
                block_claims: false,
                ..p.unpaid
            },
            ..p
        };
        assert_eq!(
            may_claim(
                &soft,
                &ClaimCheck {
                    upkeep_unpaid: true,
                    ..check()
                }
            ),
            Ok(140)
        );
    }

    #[test]
    fn reach_reads_only_the_enabled_sources() {
        let p = params();
        // own 4 out of range, home 9; nation sources not enabled.
        let far = Nearest {
            home: Some(9),
            own: Some(4),
            nation_keep: Some(1),
            nation_land: Some(0),
        };
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    nearest: far,
                    ..check()
                }
            ),
            Err(ClaimRefusal::Range)
        );
        let keeps = TerritoryParams {
            reach: ReachRule {
                range: 3,
                sources: SRC_OWN | SRC_NATION_KEEPS,
            },
            ..p
        };
        assert_eq!(
            may_claim(
                &keeps,
                &ClaimCheck {
                    nearest: far,
                    ..check()
                }
            ),
            Ok(140)
        );
        // No territory yet: only the home counts.
        let first = Nearest {
            home: Some(3),
            ..Nearest::default()
        };
        assert_eq!(
            may_claim(
                &p,
                &ClaimCheck {
                    nearest: first,
                    owned: 0,
                    ..check()
                }
            ),
            Ok(100)
        );
        // Unlimited range (T-2 (a)) ignores sources.
        let any = TerritoryParams {
            reach: ReachRule {
                range: 0,
                sources: 0,
            },
            ..p
        };
        assert_eq!(
            may_claim(
                &any,
                &ClaimCheck {
                    nearest: Nearest::default(),
                    ..check()
                }
            ),
            Ok(140)
        );
        assert_eq!(
            reach_distance(
                &ReachRule {
                    range: 3,
                    sources: SRC_ALL
                },
                &far
            ),
            Some(0)
        );
    }

    #[test]
    fn unpaid_effect_blocks_halves_then_decays() {
        let r = params().unpaid;
        let paid = unpaid_effect(&r, None, 100);
        assert_eq!(
            paid,
            UnpaidEffect {
                claims_blocked: false,
                production_bps: BPS_ONE,
                cells_released: 0
            }
        );
        assert_eq!(unpaid_effect(&r, Some(10), 33).cells_released, 0);
        assert_eq!(unpaid_effect(&r, Some(10), 34).cells_released, 1);
        assert_eq!(unpaid_effect(&r, Some(10), 39).cells_released, 1);
        assert_eq!(unpaid_effect(&r, Some(10), 40).cells_released, 2);
        assert!(unpaid_effect(&r, Some(10), 11).claims_blocked);
        let never = UnpaidRule {
            decay_after_bells: None,
            ..r
        };
        assert_eq!(unpaid_effect(&never, Some(0), u32::MAX).cells_released, 0);
        assert_eq!(unpaid_effect(&r, Some(50), 10).cells_released, 0); // clock behind: nothing
    }

    #[test]
    fn release_order_is_deterministic() {
        let cells = [
            OwnedCell {
                id: 1,
                distance: 2,
                claimed_bell: 50,
            },
            OwnedCell {
                id: 2,
                distance: 6,
                claimed_bell: 10,
            },
            OwnedCell {
                id: 3,
                distance: 6,
                claimed_bell: 20,
            },
            OwnedCell {
                id: 4,
                distance: 1,
                claimed_bell: 90,
            },
        ];
        assert_eq!(
            release_order(DecayOrder::Farthest, &cells),
            vec![2, 1, 0, 3]
        );
        assert_eq!(release_order(DecayOrder::Newest, &cells), vec![3, 0, 2, 1]);
        let mut rev = cells;
        rev.reverse();
        let ids = |o, c: &[OwnedCell]| {
            release_order(o, c)
                .into_iter()
                .map(|i| c[i].id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(DecayOrder::Farthest, &rev),
            ids(DecayOrder::Farthest, &cells)
        );
    }

    #[test]
    fn params_validate() {
        let p = params();
        assert_eq!(p.validate(), Ok(()));
        let bad = |q: TerritoryParams| q.validate().unwrap_err();
        assert_eq!(
            bad(TerritoryParams {
                upkeep: UpkeepCurve { flat: -1, ..CURVE },
                ..p
            }),
            ParamsError::NegativeUpkeep
        );
        assert_eq!(
            bad(TerritoryParams {
                reach: ReachRule {
                    range: 3,
                    sources: 0
                },
                ..p
            }),
            ParamsError::NoSource
        );
        assert_eq!(
            bad(TerritoryParams {
                reach: ReachRule {
                    range: 3,
                    sources: 0x80
                },
                ..p
            }),
            ParamsError::UnknownSource
        );
        assert_eq!(
            bad(TerritoryParams {
                unpaid: UnpaidRule {
                    production_bps: 10_001,
                    ..p.unpaid
                },
                ..p
            }),
            ParamsError::ProductionAboveOne
        );
        assert_eq!(
            bad(TerritoryParams {
                unpaid: UnpaidRule {
                    decay_every_bells: 0,
                    ..p.unpaid
                },
                ..p
            }),
            ParamsError::DecayEveryZero
        );
    }

    #[test]
    fn natural_size_is_the_largest_affordable_count() {
        // 40 food/h (a Hamlet's base food): flat 2, +0.5 per rank, at distance ≤ 3.
        let n = natural_size(&CURVE, 40 * MILLI, 3).unwrap();
        assert!(upkeep_per_hour(&CURVE, &vec![3; n as usize]).unwrap() <= 40 * MILLI);
        assert!(upkeep_per_hour(&CURVE, &vec![3; n as usize + 1]).unwrap() > 40 * MILLI);
        let free = UpkeepCurve {
            flat: 0,
            per_rank: 0,
            per_distance: 0,
            free_distance: 0,
        };
        assert_eq!(natural_size(&free, 40 * MILLI, 9), None);
    }
}
