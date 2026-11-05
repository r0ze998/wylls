//! ⑥'s reusable processing plan (contract §7): what a user must bring,
//! how long the lent capacity takes, and when to depart, from the
//! recipe's own numbers.

use crate::recipe::Recipe;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunPlan {
    /// Output wanted (milli).
    pub output: i64,
    /// Materials to bring, per recipe input (milli).
    pub inputs: [i64; 2],
    /// Seconds of conversion on `units` copies.
    pub run_secs: i64,
    /// The earliest start: the materials' arrival.
    pub start: i64,
    /// The job's end (reserve `[start, end)`).
    pub end: i64,
}

/// A plan for `output` on `units` lent copies, with the materials leaving
/// at `depart_at` and travelling `travel_secs` (the caravan's walk).
pub fn plan(r: &Recipe, units: u32, output: i64, depart_at: i64, travel_secs: i64) -> RunPlan {
    let run_secs = r.secs_for(units, output);
    let start = depart_at + travel_secs.max(0);
    RunPlan {
        output,
        inputs: r.used_for(output),
        run_secs,
        start,
        end: start + run_secs,
    }
}
