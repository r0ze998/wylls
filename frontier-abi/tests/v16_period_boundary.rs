//! ⑯ independent verification, phase 3 (the persistent world): what the
//! current rules do at a period boundary. Today the only boundary is the
//! Season's `end_bell`: every player instruction is refused from that bell
//! (`PlayerStart::finish`, step 4, `WrongStatus`), and CreateSeason refuses
//! an `end_bell` beyond 4,032 bells (28 days; `SeasonParams::validate`), so
//! "a very large end" is not a way to keep the world running.
//!
//! The invariant a persistent world needs (owner's direction, 2026-10-31):
//! a routine action (harvest, send a caravan, build) at or after a period
//! boundary is accepted, and the world's length is not capped by a season
//! parameter. These tests pin that invariant; on today's code they fail,
//! which is the evidence of the dependency.

use frontier_abi::layout::player::citizen as C;
use frontier_abi::presets::{SeasonParams, M1_LOCAL_7D};
use frontier_abi::prologue::{PlayerStart, SeasonHdr};
use frontier_abi::FrontierError;

fn season(end_bell: u32) -> SeasonHdr {
    SeasonHdr {
        id: 7,
        bump: 255,
        stored_status: 2,
        status: 2,
        genesis_ts: 1_800_000_000,
        end_bell,
        join_close_bell: end_bell.saturating_sub(1),
        bucket_rate_per_h: M1_LOCAL_7D.bucket_rate_per_h,
        bucket_burst: M1_LOCAL_7D.bucket_burst,
    }
}

/// A Citizen with a full bucket at `genesis_ts` (the prologue's step 3 debits one token).
fn citizen(s: &SeasonHdr) -> Vec<u8> {
    let mut d = vec![0u8; C::SIZE];
    // the bucket in milli-tokens, full at genesis (BUCKET_T is seconds since genesis)
    d[C::BUCKET_MILLI..C::BUCKET_MILLI + 4].copy_from_slice(&(s.bucket_burst as u32 * 1_000).to_le_bytes());
    d[C::BUCKET_T..C::BUCKET_T + 4].copy_from_slice(&0u32.to_le_bytes());
    d
}

fn routine_action_at(s: &SeasonHdr, bell: u32) -> Result<u32, FrontierError> {
    let now = s.genesis_ts + 600 * bell as i64 + 5;
    let mut cd = citizen(s);
    PlayerStart { season: *s, by_session: false, citizen_tag: 1 }
        .finish(&mut cd, now)
        .map(|ctx| ctx.now_bell)
}

#[test]
fn v16_p1_a_routine_action_in_the_last_bell_before_the_boundary_is_accepted_today() {
    let s = season(1_008);
    assert_eq!(routine_action_at(&s, 1_007), Ok(1_007));
}

#[test]
fn v16_p2_a_routine_action_at_the_period_boundary_is_still_accepted() {
    // The persistent world: the boundary of a war period is not the end of play. Today `end_bell` refuses everything.
    let s = season(1_008);
    assert_eq!(
        routine_action_at(&s, 1_008),
        Ok(1_008),
        "a player instruction at the boundary bell must be accepted; today step 4 of the player prologue answers WrongStatus"
    );
    assert_eq!(routine_action_at(&s, 1_008 + 144), Ok(1_008 + 144), "and a day later");
}

#[test]
fn v16_p3_the_worlds_length_is_not_capped_by_a_season_parameter() {
    // "Setting end_bell to a huge value" is not available either: CreateSeason refuses more than 4,032 bells (28 days).
    let mut p: SeasonParams = M1_LOCAL_7D;
    p.end_bell = 4_033;
    p.join_close_bell = 4_032;
    assert_eq!(
        p.validate(),
        Ok(()),
        "a season longer than 28 days must be creatable for a world that does not end; today validate() refuses it"
    );
}

/// A caravan on the road when the boundary comes. SendCaravan has no bound
/// on the caravan's last bell (`proc/caravan.rs send_caravan`: the prologue
/// only asks `now_bell < end_bell`), SettleCaravan waits until every path
/// Province has `RESOLVED_NEXT > last_bell` (`settle_caravan`,
/// `CaravanEarly`), and no bell at or after `end_bell` is ever resolved
/// (`proc/clash.rs in_season`). Here the kernel's own schedule
/// (`permutation_rules::frontier::caravan::{walk, schedule}`) gives the
/// last bell of a caravan sent in the last bell before the boundary; the
/// settle predicate is the program's two conditions written out (a model
/// of two lines, labelled as such; the chain-level run needs LiteSVM).
#[test]
fn v16_p4_a_caravan_sent_before_the_boundary_can_still_be_settled_after_it() {
    use permutation_rules::frontier::caravan as kc;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    let end_bell: u32 = 1_008;
    let genesis_ts: i64 = 1_800_000_000;
    // one flat Province, every tile passable, no roads
    let pc = ProvinceCoord::new(4, 0);
    let land = kc::Land { at: pc, passable: (1u64 << 61) - 1, rough: 0, road: 0 };
    let (dirs, _order) = kc::fastest_path((pc, 0), (pc, 60), &[land]).expect("a path across the Province");
    let path = kc::pack(&dirs).expect("packed");
    let steps = kc::walk((pc, 0), &path, dirs.len() as u8, &[land], 10_000).expect("walk");
    // sent in the last bell before the boundary
    let depart_ts = genesis_ts + 600 * (end_bell as i64 - 1) + 10;
    let runs = kc::schedule(genesis_ts, depart_ts, (pc, 0), &steps).expect("schedule");
    let last_bell = runs.iter().map(|r| r.first_bell + r.tiles.len() as u32 - 1).max().unwrap();
    assert!(last_bell >= end_bell, "the caravan is still on the road at the boundary (last bell {last_bell} ≥ {end_bell})");
    // the program's settle predicate: every path Province resolved past the caravan's last bell; but RESOLVED_NEXT never
    // passes end_bell (in_season), so the most it can reach is end_bell.
    let resolved_next_max = end_bell;
    let can_settle = resolved_next_max > last_bell;
    assert!(
        can_settle,
        "a caravan sent before the boundary must be settleable after it; today it waits for bell {} to resolve, which never happens (CaravanEarly for ever: cargo and rent stuck)",
        last_bell
    );
}
