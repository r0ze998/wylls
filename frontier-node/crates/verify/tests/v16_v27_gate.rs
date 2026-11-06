//! ⑯ independent check of ④'s 6984acfa: V0 leaves a JoinResident (0xE1)
//! unjudged only when V27 runs (S1 checks on); otherwise it is never a PASS.
//! Pure function only: `judge_outside_v2` decodes the instruction bytes. No
//! key is generated, derived or signed, and no address (PDA or with-seed) is
//! derived: the verifier's `verify()` is NOT run (it derives the Season PDA).

use verify_core::checks::v0_coverage::{judge_outside_v2, PROGRAM_VERSION_NFT_S1};
use verify_core::Severity;

const JOIN: u8 = 0xE1;

fn join(gen: u32, faction: u8) -> Vec<u8> {
    let mut d = vec![JOIN];
    d.extend_from_slice(&gen.to_le_bytes());
    d.push(faction);
    d
}

#[test]
fn v16_j1_an_honest_join_is_left_to_v27_only_when_v27_runs() {
    let pv = Some(PROGRAM_VERSION_NFT_S1);
    for (gen, f) in [(0u32, 0u8), (1, 5), (u32::MAX, 3)] {
        assert!(judge_outside_v2(JOIN, &join(gen, f), pv, true).is_none(), "gen {gen} faction {f}: V27 judges it");
        let r = judge_outside_v2(JOIN, &join(gen, f), pv, false);
        assert!(matches!(r, Some((Severity::Unverifiable, _, _))), "gen {gen} faction {f}: without V27 it must not be left unjudged: {r:?}");
    }
}

#[test]
fn v16_j2_a_malformed_join_is_never_left_unjudged_even_when_v27_runs() {
    let pv = Some(PROGRAM_VERSION_NFT_S1);
    for d in [vec![JOIN], vec![JOIN, 1, 0, 0, 0], {
        let mut x = join(1, 2);
        x.push(9);
        x
    }] {
        for s1 in [true, false] {
            let r = judge_outside_v2(JOIN, &d, pv, s1);
            assert!(r.is_some(), "{} bytes, s1 {s1}: a JoinResident that does not decode must be judged here: {r:?}", d.len());
            assert!(!matches!(r, Some((Severity::Warn, _, _))), "{} bytes, s1 {s1}: {r:?}", d.len());
        }
    }
}

#[test]
fn v16_j3_measured_a_join_under_a_program_version_without_nft() {
    // Recorded behaviour, not a rule ⑯ sets: what V0 says of a JoinResident when the
    // season's program version is not the NFT one (or unknown), with or without V27.
    for pv in [None, Some(PROGRAM_VERSION_NFT_S1 & 0x7fff)] {
        for s1 in [true, false] {
            let r = judge_outside_v2(JOIN, &join(1, 2), pv, s1);
            println!("pv {pv:?} s1 {s1}: {r:?}");
            assert!(r.is_some(), "pv {pv:?} s1 {s1}: a JoinResident outside an NFT season must not be left unjudged");
        }
    }
}
