//! Literal public logs only; pure judgement, no verifier fixture execution.
#![cfg(feature = "wide-world-experimental")]
use base64::Engine;
use frontier_abi::world_index::event::conquest as c;
use verify_core::checks::vw_chains::{
    judge, psw1_bodies, Judgement, WIDE_RECORD_UNDECODABLE, WIDE_UNMODELLED,
};
fn line(body: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b.encode(b"PSWC"), b.encode(body))
}
fn body() -> Vec<u8> {
    c::SidecarClose {
        season: [24; 32],
        citizen: [25; 32],
        bell: 9,
        receipt: c::Receipt::new(c::ESCROW_CLOSE, 0, [1; 32], [2; 32]).unwrap(),
    }
    .encode()
    .unwrap()
    .to_vec()
}
#[test]
fn sidecar_is_unmodelled_without_any_fabricated_chain() {
    let logs = vec![
        "Program P invoke [1]".into(),
        line(&body()),
        "Program P success".into(),
    ];
    let findings = judge("P", &[(0, true, &logs)], &[], true);
    assert!(!findings.is_empty());
    assert!(findings.iter().all(|f| matches!(
        f,
        Judgement::Unverifiable {
            code: WIDE_UNMODELLED,
            ..
        }
    )));
    assert!(
        psw1_bodies(&logs, "P").is_err(),
        "old API must not silently omit sidecars"
    );
    assert!(judge("P", &[(0, false, &logs)], &[], true).is_empty());
}
#[test]
fn sidecar_invalid_committed_frames_fail_but_failed_subtrees_and_foreign_logs_do_not_count() {
    for data in [vec![1], {
        let mut b = body();
        b[0] = 2;
        b
    }] {
        let logs = vec![
            "Program P invoke [1]".into(),
            line(&data),
            "Program P success".into(),
        ];
        assert!(judge("P", &[(0, true, &logs)], &[], true)
            .iter()
            .any(|f| matches!(
                f,
                Judgement::Fail {
                    code: WIDE_RECORD_UNDECODABLE,
                    ..
                }
            )));
        let logs = vec![
            "Program Q invoke [1]".into(),
            "Program P invoke [2]".into(),
            line(&data),
            "Program P failed: caught".into(),
            "Program Q success".into(),
        ];
        assert!(judge("P", &[(0, true, &logs)], &[], true).is_empty());
    }
    let logs = vec![
        "Program Q invoke [1]".into(),
        line(&body()),
        "Program Q success".into(),
    ];
    assert!(judge("P", &[(0, true, &logs)], &[], true).is_empty());
    let logs = vec!["Program P invoke [1]".into(), line(&body())];
    assert!(judge("P", &[(0, true, &logs)], &[], true)
        .iter()
        .any(|f| matches!(
            f,
            Judgement::Fail {
                code: WIDE_RECORD_UNDECODABLE,
                ..
            }
        )));
}
