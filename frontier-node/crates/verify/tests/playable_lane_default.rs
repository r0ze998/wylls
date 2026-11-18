//! The playable-lane recording (program version 0x4804) under a verifier
//! built WITHOUT the `playable-lane` feature: never a PASS, and the finding
//! says which build judges it (Q16-1 = A).
#![cfg(not(feature = "playable-lane"))]

mod common;

#[test]
fn the_default_build_does_not_judge_the_playable_lane() {
    let rep = verify_core::verify(&common::fixture("playable-lane-natural.json.gz"));
    let fails: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.severity == verify_core::Severity::Fail)
        .map(|f| (f.check, f.code.clone(), f.detail.clone()))
        .collect();
    assert_eq!(
        rep.verdict,
        verify_core::Verdict::Unverifiable,
        "{fails:#?}"
    );
    let f = rep
        .findings
        .iter()
        .find(|f| f.code == "UnknownProgramVersion")
        .expect("UnknownProgramVersion");
    assert!(f.detail.contains("playable-lane"), "{}", f.detail);
    assert!(!rep
        .findings
        .iter()
        .any(|f| f.severity == verify_core::Severity::Fail));
}

/// The natural season with a real WideSetRules (VWL's recording): the
/// default build has no VWL and no 0x4804, so never a PASS and no FAIL.
#[test]
fn the_default_build_does_not_judge_wide_set_rules() {
    let rep = verify_core::verify(&common::fixture("playable-wide-setrules.json.gz"));
    assert_eq!(rep.verdict, verify_core::Verdict::Unverifiable);
    assert!(rep
        .findings
        .iter()
        .any(|f| f.code == "UnknownProgramVersion"));
    assert!(!rep
        .findings
        .iter()
        .any(|f| f.severity == verify_core::Severity::Fail));
}
