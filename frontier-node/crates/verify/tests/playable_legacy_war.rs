//! The PLAYABLE lane's legacy war on the exact devnet `.so`, as keeper A
//! plays it (verify-pr118): the whole season of `stack` `operator_playable`
//! P8 (devnet-page-war) — CreateSeason, keeper A's beacon / rings / tickets
//! and play roles, a test participant's rim FileTicket, Harvests (the first
//! one flips the village final), Muster, ONE sealed Depart onto a keep
//! arriving on the REAL round T(21), keeper A's Reveal from the public round,
//! GatherClash / ResolveFromInputs of the contested keep's bells,
//! SettleTransit and about 2,400 SkipQuiet.
//!
//! The fixture `playable-legacy-war-p8.json.gz` is that run's archive
//! (`judge_season` in `stack/tests/operator_playable/rim.rs`, saved under
//! `OPERATOR_EVIDENCE_DIR`), with every `set_account` patch of the run
//! DECLARED (`Input::declared`): the rim map growth, RingSeed(128), THE
//! anchor and SeedCache of every bell no shipped round covers (never the
//! arrival bell's anchor: keeper A's real PostAnchor), the arrival bell's
//! seed over that anchor, and 400 Spearmen in the village's reserve.
//!
//! Before verify-pr118 V7 FAILed this honest season: its owner-action replay
//! never applied the program's step-5 lazy finality flip
//! (`permutation-frontier/src/proc/holding.rs` `finality`), so the first
//! Harvest after `final_ts` differed at the Holding's state byte.
#![cfg(feature = "playable-lane")]

mod common;

use frontier_abi::layout::player::holding as H;
use verify_core::input::Input;
use verify_core::{Severity, Verdict};

const ARRIVE_BELL: u32 = 21;

fn recorded() -> Input {
    let mut inp = common::fixture("playable-legacy-war-p8.json.gz");
    inp.program_so = Some(common::pinned_so());
    inp
}

/// Whether a finding is one the declared patches explain.
fn declared(f: &verify_core::Finding) -> bool {
    f.severity == Severity::Unverifiable
        && f.code == "MissingData"
        && match f.check {
            // the declared anchors of every bell but the arrival bell's
            "V4" => f.bell != ARRIVE_BELL && f.detail.contains("is not in the archive before it"),
            // the declared seeds of the resolved bells (the arrival bell's
            // and the contested keep's)
            "V7" => f.detail.contains("no seed") || f.detail.contains("only declares"),
            // the declared rim map growth (RingSeed(128) and the rim's seeds)
            "V11" => f.detail.contains("no seed"),
            // V15 follows V7's unreplayed bells
            "V15" => f.detail.contains("V7 did not replay"),
            "VX" | "V0E" => f.detail.contains("declare") || f.detail.contains("patch"),
            // verifier-v7-patches: a judgement of any check that read a
            // declared state (World::state_before, V7's replays) and agreed
            _ => f.detail.contains("only declares"),
        }
}

fn bad(rep: &verify_core::Report) -> Vec<String> {
    rep.findings
        .iter()
        .filter(|f| f.severity != Severity::Warn && !declared(f))
        .map(|f| {
            format!(
                "{:?} {} {} {} | {}",
                f.severity, f.check, f.code, f.entity, f.detail
            )
        })
        .collect()
}

/// The first successful Harvest (0x40) that flipped its Holding final:
/// `(transaction, post index of the Holding)`.
fn final_flip(inp: &Input) -> (usize, usize) {
    for (t, x) in inp.txs.iter().enumerate() {
        if x.err.is_some() {
            continue;
        }
        let Ok(tx) = fclient::tx::from_wire(&x.tx) else {
            continue;
        };
        let keys = &tx.message.account_keys;
        let harvest = tx.message.instructions.iter().any(|c| {
            keys[c.program_id_index as usize] == inp.cfg.program && c.data.first() == Some(&0x40)
        });
        if !harvest {
            continue;
        }
        for (i, (k, a)) in x.post.iter().enumerate() {
            let Some(a) = a else { continue };
            if a.owner != inp.cfg.program
                || !a.data.starts_with(&H::MAGIC)
                || a.data.len() <= H::STATE
            {
                continue;
            }
            let before = inp.txs[..t].iter().rev().find_map(|y| {
                y.post
                    .iter()
                    .find(|(k2, _)| k2 == k)
                    .and_then(|(_, a)| a.as_ref())
            });
            if a.data[H::STATE] == H::STATE_FINAL
                && before.is_some_and(|b| b.data[H::STATE] == H::STATE_PROVISIONAL)
            {
                return (t, i);
            }
        }
    }
    panic!("no Harvest flipped a Holding final")
}

#[test]
fn the_honest_war_has_no_fail_and_only_the_declared_patches_are_unverifiable() {
    let inp = recorded();
    assert!(inp.declared.len() > 100, "the run's patches are declared");
    let rep = verify_core::verify(&inp);
    assert_eq!(
        rep.findings.iter().filter(|f| f.fail()).count(),
        0,
        "{:#?}",
        bad(&rep)
    );
    assert!(bad(&rep).is_empty(), "{:#?}", bad(&rep));
    // (the declared patches keep it from a PASS)
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    // the archive does hold the lazy flip judged here
    let _ = final_flip(&inp);
}

/// A Harvest whose post-state keeps the village provisional although the
/// rules made it final (`final_ts` passed, its cohort closed): FAIL.
#[test]
fn a_harvest_that_skips_the_due_finality_flip_fails() {
    let mut inp = recorded();
    let (t, i) = final_flip(&inp);
    inp.txs[t].post[i].1.as_mut().unwrap().data[H::STATE] = H::STATE_PROVISIONAL;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(
        rep.findings
            .iter()
            .any(|f| f.fail() && f.check == "V7" && f.code == "HoldingReplayMismatch"),
        "{:#?}",
        bad(&rep)
    );
}
