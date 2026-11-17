//! The recipe and a job's output in closed form (contract §3).
//!
//! S1 has one recipe, the workshop's (`permutation_rules::frontier::arms`):
//! one lent workshop copy converts `ORE_PER_ARM` ore and `WOOD_PER_ARM`
//! wood into one arm, `WORKSHOP_ARMS_PER_HOUR` arms an hour. The numbers
//! are read from the rules crate, never restated, so a phase-6 change of
//! the workshop changes the lent capacity with it.

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::holding::{Resource, HOUR};

/// A recipe id (`RECIPE_ARMS` is the only one in S1).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct RecipeId(pub u8);

pub const RECIPE_ARMS: RecipeId = RecipeId(1);

/// What one capacity unit (one workshop copy) does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipe {
    pub id: RecipeId,
    /// Inputs per output unit, in order (resource, units per output unit).
    pub inputs: [(Resource, i64); 2],
    pub output: Resource,
    /// Output per unit of capacity, milli-units per hour.
    pub rate: i64,
}

/// The workshop's recipe.
pub const ARMS_RECIPE: Recipe = Recipe {
    id: RECIPE_ARMS,
    inputs: [
        (Resource::Ore, arms::ORE_PER_ARM),
        (Resource::Wood, arms::WOOD_PER_ARM),
    ],
    output: arms::ARMS,
    rate: arms::WORKSHOP_DELTA,
};
const _: () = assert!(ARMS_RECIPE.rate == arms::WORKSHOP_ARMS_PER_HOUR * MILLI);

pub fn recipe(id: RecipeId) -> Option<&'static Recipe> {
    (id == RECIPE_ARMS).then_some(&ARMS_RECIPE)
}

impl Recipe {
    /// Index of `r` among the inputs.
    pub fn input_index(&self, r: Resource) -> Option<usize> {
        self.inputs.iter().position(|(x, _)| *x == r)
    }

    /// Output the capacity of `units` makes in `secs` seconds (milli,
    /// rounded down).
    pub fn capacity_output(&self, units: u32, secs: i64) -> i64 {
        let v = units as i128 * self.rate as i128 * secs.max(0) as i128 / HOUR as i128;
        v.min(i64::MAX as i128) as i64
    }

    /// Seconds `units` need for `out` (milli), rounded up.
    pub fn secs_for(&self, units: u32, out: i64) -> i64 {
        if out <= 0 || units == 0 {
            return 0;
        }
        let per = units as i128 * self.rate as i128;
        let n = out as i128 * HOUR as i128;
        ((n + per - 1) / per).min(i64::MAX as i128) as i64
    }

    /// The most output `hopper` (milli, per input in order) can feed.
    pub fn fed_by(&self, hopper: &[i64; 2]) -> i64 {
        let mut m = i64::MAX;
        for (i, (_, per)) in self.inputs.iter().enumerate() {
            m = m.min(hopper[i].max(0) / per);
        }
        m
    }

    /// Inputs used for `out` (milli): exactly `out × per`.
    pub fn used_for(&self, out: i64) -> [i64; 2] {
        core::array::from_fn(|i| out * self.inputs[i].1)
    }
}
