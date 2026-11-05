//! ⑯ independent verification of ⑧'s continuous-world candidate
//! (`preserve/ws08-*`: the conquest block's `CONTINUOUS` flag, CreateSeason
//! validated by `SeasonParams::validate_world(true)`, `end_bell =
//! join_close_bell = NO_END_BELL = u32::MAX`, EndSeason refused).
//!
//! The same three observations as `v16_period_boundary.rs` (P2–P4 on the
//! base), now with the continuous values: a routine action at the old end
//! bell and far beyond it, a world longer than 28 days, a caravan on the
//! road across the old end bell. These are the ABI's rules and the
//! caravan kernel's schedule, executed on the host; the program's own run
//! across the old end bell is ⑧'s LiteSVM test (`svm-tests/tests/continuous.rs`),
//! which needs an SBF build and is not run here.

use frontier_abi::layout::player::citizen as C;
use frontier_abi::presets::{SeasonParams, M1_LOCAL_7D, NO_END_BELL};
use frontier_abi::prologue::{PlayerStart, SeasonHdr};
use frontier_abi::FrontierError;

fn season(end_bell: u32, join_close_bell: u32) -> SeasonHdr {
    SeasonHdr {
        id: 7,
        bump: 255,
        stored_status: 2,
        status: 2,
        genesis_ts: 1_800_000_000,
        end_bell,
        join_close_bell,
        bucket_rate_per_h: M1_LOCAL_7D.bucket_rate_per_h,
        bucket_burst: M1_LOCAL_7D.bucket_burst,
    }
}

fn citizen(s: &SeasonHdr) -> Vec<u8> {
    let mut d = vec![0u8; C::SIZE];
    d[C::BUCKET_MILLI..C::BUCKET_MILLI + 4].copy_from_slice(&(s.bucket_burst as u32 * 1_000).to_le_bytes());
    d
}

fn routine_action_at(s: &SeasonHdr, bell: u32) -> Result<u32, FrontierError> {
    let now = s.genesis_ts + 600 * bell as i64 + 5;
    let mut cd = citizen(s);
    PlayerStart { season: *s, by_session: false, citizen_tag: 1 }
        .finish(&mut cd, now)
        .map(|ctx| ctx.now_bell)
}

const OLD_END: u32 = 1_008;
/// Ten years of bells.
const TEN_YEARS: u32 = 10 * 365 * 144;

#[test]
fn v16_c2_routine_actions_continue_at_and_far_beyond_the_old_end_bell() {
    let s = season(NO_END_BELL, NO_END_BELL);
    assert_eq!(routine_action_at(&s, OLD_END - 1), Ok(OLD_END - 1));
    assert_eq!(routine_action_at(&s, OLD_END), Ok(OLD_END), "at the old end bell");
    assert_eq!(routine_action_at(&s, OLD_END + 144), Ok(OLD_END + 144), "a day later");
    assert_eq!(routine_action_at(&s, TEN_YEARS), Ok(TEN_YEARS), "ten years on");
}

#[test]
fn v16_c3_a_continuous_world_is_creatable_and_a_finite_one_keeps_the_28_day_rule() {
    let mut p: SeasonParams = M1_LOCAL_7D;
    p.end_bell = NO_END_BELL;
    p.join_close_bell = NO_END_BELL;
    assert_eq!(p.validate_world(true), Ok(()), "the continuous world validates");
    // a large but finite end is not the continuous world, and a finite season keeps the old rule
    let mut q: SeasonParams = M1_LOCAL_7D;
    q.end_bell = 4_033;
    q.join_close_bell = 4_032;
    assert_eq!(q.validate_world(true), Err("join_close_bell/end_bell"), "only NO_END_BELL means continuous");
    assert_eq!(q.validate(), Err("join_close_bell/end_bell"), "the finite rule is unchanged (28 days)");
}

#[test]
fn v16_c4_a_caravan_on_the_road_across_the_old_end_bell_can_be_settled() {
    use permutation_rules::frontier::caravan as kc;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    let end_bell = NO_END_BELL;
    let genesis_ts: i64 = 1_800_000_000;
    let pc = ProvinceCoord::new(4, 0);
    let land = kc::Land { at: pc, passable: (1u64 << 61) - 1, rough: 0, road: 0 };
    let (dirs, _) = kc::fastest_path((pc, 0), (pc, 60), &[land]).expect("a path across the Province");
    let path = kc::pack(&dirs).expect("packed");
    let steps = kc::walk((pc, 0), &path, dirs.len() as u8, &[land], 10_000).expect("walk");
    let depart_ts = genesis_ts + 600 * (OLD_END as i64 - 1) + 10;
    let runs = kc::schedule(genesis_ts, depart_ts, (pc, 0), &steps).expect("schedule");
    let last_bell = runs.iter().map(|r| r.first_bell + r.tiles.len() as u32 - 1).max().unwrap();
    assert!(last_bell >= OLD_END, "on the road at the old end bell ({last_bell})");
    // the program's settle predicate with in_season's bound: RESOLVED_NEXT may reach end_bell, here u32::MAX
    assert!(end_bell > last_bell, "the bell after the caravan's last one can be resolved, so it can be settled");
}

#[test]
fn v16_c5_the_worlds_time_horizon_is_set_by_the_citizen_bucket_clock_not_by_end_bell() {
    // `end_bell = u32::MAX` bells is ~81,700 years away, but the player prologue's rate bucket stores the time since
    // genesis as u32 SECONDS (`prologue.rs debit_bucket`: `u32::try_from(t)` → `Overflow`). That is the world's real
    // horizon: 2^32 s ≈ 136.1 years. Recorded here as a measured ceiling (P5: limits of counters and stored time).
    let s = season(NO_END_BELL, NO_END_BELL);
    let hundred_years = 100 * 365 * 144;
    assert_eq!(routine_action_at(&s, hundred_years), Ok(hundred_years), "a century on, actions still land");
    let last_ok = ((u32::MAX as u64) / 600) as u32; // the last bell whose start + 5 s still fits in u32 seconds
    assert_eq!(routine_action_at(&s, last_ok - 1), Ok(last_ok - 1));
    assert_eq!(
        routine_action_at(&s, last_ok + 1),
        Err(FrontierError::Overflow),
        "from bell {} (~{} years) every player instruction fails Overflow",
        last_ok + 1,
        (last_ok as u64 + 1) * 600 / (365 * 86_400)
    );
}
