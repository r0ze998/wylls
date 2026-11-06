//! V0H (2026-11-07): the history evidence. Each case takes the committed
//! land recording and changes only its `history` block, then reads the
//! verdict, V0H's findings and the report's history block.
//!
//! **Not run, and not runnable under the current restriction.** Every
//! case calls `verify_core::verify`, which builds `Facts` through
//! `findex::addr_ctx` and so derives the season PDA (and the checks derive
//! more). The review of 2026-11-07 ruled that out for this session; these
//! cases wait for an execution the coordinator audits. No key is generated
//! and nothing is signed here, but PDA derivation is not key-free. The
//! only tests of this change that are plain-data pure are the unit tests
//! of `src/input.rs` (`history_tests`).

mod common;

use common::*;
use verify_core::input::{Assurance, HistoryEvidence, HistoryObservation, HistorySource};
use verify_core::{codes, Severity, Verdict};

fn v0h(r: &verify_core::Report) -> Vec<String> {
    r.findings
        .iter()
        .filter(|f| f.check == "V0H")
        .map(|f| {
            assert_eq!(f.severity, Severity::Unverifiable, "{}", f.code);
            assert_eq!(f.entity, "history");
            f.code.clone()
        })
        .collect()
}

fn with(h: HistoryEvidence) -> verify_core::Input {
    let mut inp = land();
    inp.history = h;
    inp
}

/// The committed fixtures carry no `history` block: unstated, judged as a
/// dataset, labelled so in the report, and still a PASS.
#[test]
fn history_legacy_fixtures_are_judged_as_datasets_and_labelled() {
    for (name, inp) in [
        ("land", land()),
        ("march", march()),
        ("march-program", march_program()),
    ] {
        assert_eq!(inp.history, HistoryEvidence::unstated(), "{name}");
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, Verdict::Pass, "{name}: {}", show(&r));
        assert_eq!(v0h(&r), Vec::<String>::new(), "{name}");
        assert!(r.checks_run.contains(&"V0H"), "{name}");
        let j = r.json();
        assert_eq!(
            j["history"]["assurance"], "dataset-only",
            "{name}: {}",
            j["history"]
        );
        assert_eq!(j["history"]["source"]["kind"], "unstated");
        let md = r.markdown();
        assert!(
            md.contains("History evidence (dataset-only)"),
            "{name}: {md}"
        );
        assert!(
            md.contains("judges the transactions given as a dataset"),
            "{name}"
        );
    }
}

/// A local node's own feed (the harness) is judged as its dataset and
/// labelled apart from a fixture.
#[test]
fn history_local_feed_is_judged_as_the_harness_dataset() {
    let base = land();
    let h = HistoryEvidence::local_feed("http://127.0.0.1:41010", &base.txs);
    let r = verify_core::verify(&with(h));
    assert_eq!(r.verdict, Verdict::Pass, "{}", show(&r));
    assert_eq!(v0h(&r), Vec::<String>::new());
    assert_eq!(r.json()["history"]["assurance"], "local-feed");
    assert!(r.markdown().contains("History evidence (local-feed)"));
}

/// The same recording read from an archive or from one node's poll is
/// never a PASS: nothing shows it is the season's whole history. A
/// cross-check is reported and changes nothing.
#[test]
fn history_archive_and_rpc_without_coverage_evidence_are_unverifiable() {
    let base = land();
    for src in [
        HistorySource::Archive {
            dir: "/tmp/findex/archive".into(),
        },
        HistorySource::RpcPoll {
            url: "https://rpc.example".into(),
        },
    ] {
        let mut h = HistoryEvidence::fetched(src.clone(), &base.txs);
        for xc in [false, true] {
            if xc {
                h.cross_checked
                    .push("rpc https://other.example: same signatures".into());
            }
            let r = verify_core::verify(&with(h.clone()));
            assert_eq!(
                r.verdict,
                Verdict::Unverifiable,
                "{src:?} xc {xc}: {}",
                show(&r)
            );
            assert_eq!(
                v0h(&r),
                vec![codes::HISTORY_COVERAGE_UNVERIFIABLE.to_string()]
            );
            let f = r.findings.iter().find(|f| f.check == "V0H").unwrap();
            assert!(
                f.detail
                    .contains("Nothing shows they are all of the season's"),
                "{}",
                f.detail
            );
            if xc {
                assert!(
                    f.detail.contains("not proof of completeness or finality"),
                    "{}",
                    f.detail
                );
            }
            let j = r.json();
            assert_eq!(j["history"]["assurance"], "unverifiable");
            assert_eq!(j["history"]["observation"]["kind"], "fetched");
            assert_eq!(
                j["history"]["observation"]["records"],
                base.txs.len() as u64
            );
            assert_eq!(
                verify_core::exit_code(r.verdict),
                verify_core::EXIT_UNVERIFIABLE
            );
        }
    }
}

/// A source that returned nothing is a genuine observation, not evidence
/// of an empty season: never a PASS, from any source.
#[test]
fn history_an_empty_observation_is_not_a_pass() {
    for src in [
        HistorySource::Archive { dir: "/a".into() },
        HistorySource::RpcPoll { url: "u".into() },
        HistorySource::LocalnetFeed { url: "u".into() },
        HistorySource::Dataset { label: "x".into() },
    ] {
        let r = verify_core::verify(&with(HistoryEvidence::fetched(src.clone(), &[])));
        assert_ne!(r.verdict, Verdict::Pass, "{src:?}: {}", show(&r));
        assert_eq!(
            v0h(&r),
            vec![codes::HISTORY_COVERAGE_UNVERIFIABLE.to_string()],
            "{src:?}"
        );
        assert_eq!(r.json()["history"]["assurance"], "empty-observation");
    }
}

/// A gap, an unread source and a malformed block each carry their own
/// code, and none is a PASS.
#[test]
fn history_gap_unread_and_malformed_are_never_a_pass() {
    let src = HistorySource::RpcPoll { url: "u".into() };
    let cases = [
        (
            HistoryObservation::Gap {
                detail: "signature X lies between the archive's last and the new batch".into(),
            },
            codes::HISTORY_GAP,
            "gap",
        ),
        (
            HistoryObservation::NotFetched {
                reason: "the source was not read".into(),
            },
            codes::HISTORY_NOT_OBSERVED,
            "not-observed",
        ),
        (
            HistoryObservation::Malformed {
                detail: "history.source.kind \"complete\"".into(),
            },
            codes::HISTORY_EVIDENCE_MALFORMED,
            "malformed",
        ),
    ];
    for (obs, code, name) in cases {
        let h = HistoryEvidence {
            source: src.clone(),
            observation: obs,
            cross_checked: vec![],
        };
        assert_eq!(h.assurance().name(), name);
        let r = verify_core::verify(&with(h));
        assert_eq!(r.verdict, Verdict::Unverifiable, "{name}: {}", show(&r));
        assert_eq!(v0h(&r), vec![code.to_string()], "{name}");
        assert_eq!(r.json()["history"]["assurance"], name);
    }
}

/// The evidence survives the fixture form in memory (what `--save` writes
/// and `--fixture` reads): a saved RPC run is still unverifiable later,
/// and a block that declares more than the loader can read is malformed.
#[test]
fn history_round_trips_through_the_fixture_form_without_upgrade() {
    let base = land();
    let h = HistoryEvidence::fetched(HistorySource::RpcPoll { url: "u".into() }, &base.txs);
    let mut v = with(h.clone()).to_json();
    let back = verify_core::Input::from_json(&v).expect("loads");
    assert_eq!(back.history, h);
    assert_eq!(verify_core::verify(&back).verdict, Verdict::Unverifiable);
    // A file's own `assurance` is ignored; an unknown source kind is malformed.
    v["history"]["assurance"] = serde_json::json!("complete");
    assert_eq!(
        verify_core::Input::from_json(&v)
            .unwrap()
            .history
            .assurance(),
        Assurance::Unverifiable
    );
    v["history"]["source"] = serde_json::json!({"kind": "complete"});
    let m = verify_core::Input::from_json(&v).unwrap();
    assert_eq!(m.history.assurance(), Assurance::Malformed);
    assert_eq!(verify_core::verify(&m).verdict, Verdict::Unverifiable);
    // Without the block at all: legacy, dataset-only.
    v.as_object_mut().unwrap().remove("history");
    assert_eq!(
        verify_core::Input::from_json(&v).unwrap().history,
        HistoryEvidence::unstated()
    );
}
