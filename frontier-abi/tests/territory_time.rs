//! Exact province-time scoring: full resolved bells, old owner through capture,
//! no replay credit, and no credit outside the province/season lifetime.
use frontier_abi::bytes::{rd_u32, rd_u64, wr_u32};
use frontier_abi::conquest_model::{self as cq, BellReport, SiteReport, StepParams};
use frontier_abi::v2::kernel::keep::Keep;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::presets::MC_TEST;

fn province(opened: u32, holder: Option<u8>) -> Vec<u8> {
    let mut d = vec![0; P::SIZE];
    assert!(wr_u32(&mut d, P::OPENED_BELL, opened));
    assert!(wr_u32(&mut d, P::SCORE_NEXT_BELL, opened));
    if let Some(holder) = holder {
        cq::write_keep(
            &mut d,
            &Keep {
                tile: 20,
                holder,
                contender: 255,
                progress: 0,
                required: 2,
                heartland_safe: false,
                paused: false,
                changes: 0,
                troops: 0,
                since_bell: opened,
                consolidated_until_bell: 0,
                contest_from_bell: 0,
                gen: 0,
                last_taken_from: 255,
            },
        )
        .unwrap();
    } else {
        cq::write_no_keep(&mut d).unwrap();
    }
    d
}
fn score(d: &[u8], faction: usize) -> u64 {
    rd_u64(d, P::TERRITORY_BELLS + 8 * faction).unwrap()
}

#[test]
fn opened_time_retries_gaps_and_season_end_are_exact() {
    let mut d = province(5, Some(2));
    cq::score_territory(&mut d, 4, 7).unwrap();
    assert_eq!(score(&d, 2), 0);
    cq::score_territory(&mut d, 5, 7).unwrap();
    let once = d.clone();
    cq::score_territory(&mut d, 5, 7).unwrap();
    assert_eq!(d, once);
    assert!(cq::score_territory(&mut d, 7, 9).is_err());
    assert_eq!(d, once);
    cq::score_territory(&mut d, 6, 7).unwrap();
    cq::score_territory(&mut d, 7, 7).unwrap();
    cq::score_territory(&mut d, 100, 7).unwrap();
    assert_eq!(score(&d, 2), 2);
    assert_eq!(rd_u32(&d, P::SCORE_NEXT_BELL), Some(7));
}

#[test]
fn actual_keep_capture_changes_score_owner_on_following_bell() {
    let mut d = province(0, Some(0));
    let mut prm = StepParams {
        genesis_ts: 0,
        end_bell: 4,
        cq: MC_TEST.cq,
    };
    prm.cq.keep_bells = 2;
    prm.cq.keep_consolidate_bells = 0;
    let attacking = BellReport {
        keep: SiteReport {
            holders: 1 << 1,
            defender_present: false,
        },
        ..BellReport::default()
    };
    assert!(cq::step(&mut d, 0, &attacking, &prm)
        .unwrap()
        .keep_taken
        .is_none());
    assert_eq!(score(&d, 0), 1);
    let taken = cq::step(&mut d, 1, &attacking, &prm)
        .unwrap()
        .keep_taken
        .unwrap();
    assert_eq!((taken.from, taken.to), (0, 1));
    assert_eq!(score(&d, 0), 2);
    assert_eq!(score(&d, 1), 0);
    cq::step(&mut d, 2, &BellReport::default(), &prm).unwrap();
    cq::step(&mut d, 3, &BellReport::default(), &prm).unwrap();
    cq::score_territory(&mut d, 4, 4).unwrap();
    assert_eq!((score(&d, 0), score(&d, 1)), (2, 2)); // Honest tie, no capture bonus.
}

#[test]
fn neutral_provinces_never_score_and_equal_land_time_has_equal_value() {
    let mut neutral = province(0, None);
    let mut a = province(0, Some(0));
    let mut b = province(0, Some(1));
    for bell in 0..6 {
        for d in [&mut neutral, &mut a, &mut b] {
            cq::score_territory(d, bell, 6).unwrap();
        }
    }
    assert_eq!((0..6).map(|f| score(&neutral, f)).sum::<u64>(), 0);
    assert_eq!(score(&a, 0), 6);
    assert_eq!(score(&b, 1), 6);
}
