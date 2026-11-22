//! V11 reads a recorder's DECLARED patches (verifier-v11-patches,
//! D-verify-pr166-5 / D-fix-gw-highs-9).
//!
//! `playable-legacy-war-p8-late-patch.json.gz` is an honest `stack`
//! `operator_playable` P8 season (fix-gw-highs `run-baseline`, the devnet
//! `.so` 67a33c92) whose rim map growth is a declared Frontier patch
//! (`rings_opened 129, r_max_ext 128`) in force from before transaction 55.
//! Keeper A's last Frontier write landed at transaction 51, BEFORE the
//! patch, and none landed between the patch and the participant's rim
//! FileTicket (transaction 116, site (68, 60) in ring 128). V11 read the
//! Frontier from transaction 51 (`r_max_ext 0`) and FAILed the honest
//! ticket "beyond the effective r_max 16"; whether it did depended on
//! whether a keeper Frontier write happened to land after the patch (P8 /
//! PGWF FAIL 1 in about 3 of 4 runs).
//!
//! Now V11 takes the later of the last archived post-state and the declared
//! state, as VX and VWL do: a judgement that read a declared state is never
//! a PASS (`MissingData`), and a declared state that contradicts the
//! filing is still a FAIL.
#![cfg(feature = "playable-lane")]

mod common;

use frontier_abi::layout::world::frontier as FR;
use verify_core::input::Input;
use verify_core::{Severity, Verdict};

const TICKET_TX: usize = 116;
const ARRIVE_BELL: u32 = 21;

fn recorded() -> Input {
    let mut inp = common::fixture("playable-legacy-war-p8-late-patch.json.gz");
    let p = verify_core::reexec::Program::load(
        &common::fixtures_dir().join("devnet-playable-67a33c92.so.gz"),
    )
    .expect("the committed .so");
    assert_eq!(
        hex::encode(p.sha256()),
        "67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3"
    );
    inp.program_so = Some(std::sync::Arc::new(p.so.as_ref().clone()));
    inp
}

/// The index of the declared Frontier patch (the rim map growth).
fn frontier_patch(inp: &Input) -> usize {
    inp.declared
        .iter()
        .position(|d| d.what.starts_with("Frontier rings_opened"))
        .expect("the declared rim Frontier patch")
}

/// Whether a finding is one the declared patches explain
/// (`playable_legacy_war.rs`, plus V11's judgement from a declared state).
fn declared(f: &verify_core::Finding) -> bool {
    f.severity == Severity::Unverifiable
        && f.code == "MissingData"
        && match f.check {
            "V4" => f.bell != ARRIVE_BELL && f.detail.contains("is not in the archive before it"),
            "V7" => f.detail.contains("no seed"),
            "V11" => f.detail.contains("no seed") || f.detail.contains("only declares"),
            "V15" => f.detail.contains("V7 did not replay"),
            "VX" | "V0E" => f.detail.contains("declare") || f.detail.contains("patch"),
            _ => false,
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

fn ticket_fails(rep: &verify_core::Report, why: &str) -> bool {
    rep.findings.iter().any(|f| {
        f.fail()
            && f.check == "V11"
            && f.code == "TicketPlacementMismatch"
            && f.detail.contains(why)
    })
}

#[test]
fn the_archive_has_the_timing_that_used_to_fail() {
    let inp = recorded();
    let d = &inp.declared[frontier_patch(&inp)];
    let frontier_writes: Vec<usize> = inp
        .txs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.err.is_none() && t.post.iter().any(|(k, _)| k.to_bytes() == d.key))
        .map(|(i, _)| i)
        .take_while(|&i| i < TICKET_TX)
        .collect();
    // the last archived Frontier write before the ticket predates the patch
    let last = *frontier_writes.last().unwrap();
    assert!(
        last < d.at && d.at <= TICKET_TX,
        "{last} {} {frontier_writes:?}",
        d.at
    );
    let a = d.account.as_ref().unwrap();
    assert_eq!(
        u16::from_le_bytes(a.data[FR::R_MAX_EXT..FR::R_MAX_EXT + 2].try_into().unwrap()),
        128
    );
}

#[test]
fn an_honest_ticket_after_a_declared_patch_is_unverifiable_never_fail() {
    let rep = verify_core::verify(&recorded());
    assert_eq!(
        rep.findings.iter().filter(|f| f.fail()).count(),
        0,
        "{:#?}",
        bad(&rep)
    );
    assert!(bad(&rep).is_empty(), "{:#?}", bad(&rep));
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    // the ticket itself: judged exactly from the declared Frontier, so
    // MissingData, never a PASS
    assert!(
        rep.findings.iter().any(|f| f.check == "V11"
            && f.severity == Severity::Unverifiable
            && f.entity.starts_with("ticket of citizen")
            && f.detail.contains("only declares")),
        "{:#?}",
        rep.findings
            .iter()
            .filter(|f| f.check == "V11")
            .take(5)
            .collect::<Vec<_>>()
    );
}

/// The declared patch does not grow the map (a forged declaration): the
/// rim ticket lies beyond the effective r_max → FAIL.
#[test]
fn a_declared_patch_that_does_not_reach_the_ticket_fails() {
    let mut inp = recorded();
    let i = frontier_patch(&inp);
    let a = inp.declared[i].account.as_mut().unwrap();
    a.data[FR::R_MAX_EXT..FR::R_MAX_EXT + 2].copy_from_slice(&0u16.to_le_bytes());
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(
        ticket_fails(&rep, "beyond the effective r_max 16"),
        "{:#?}",
        bad(&rep)
    );
}

/// The declared patch opens fewer rings than the ticket's → FAIL.
#[test]
fn a_declared_patch_with_the_ring_unopened_fails() {
    let mut inp = recorded();
    let i = frontier_patch(&inp);
    let a = inp.declared[i].account.as_mut().unwrap();
    a.data[FR::RINGS_OPENED..FR::RINGS_OPENED + 2].copy_from_slice(&100u16.to_le_bytes());
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", bad(&rep));
    assert!(ticket_fails(&rep, "not opened"), "{:#?}", bad(&rep));
}

/// Without the declaration the archive's own states refuse the ticket: the
/// FAIL is not explained away.
#[test]
fn the_same_ticket_without_the_declared_patch_still_fails() {
    let mut inp = recorded();
    let i = frontier_patch(&inp);
    inp.declared.remove(i);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(ticket_fails(&rep, "beyond the effective r_max 16"));
}

/// A declared state older than the last archived write is overridden by
/// it (the later of the two, as VX's `before`): a patch declared before
/// transaction 51's write does not reach the ticket → FAIL.
#[test]
fn a_later_archived_write_overrides_an_earlier_declared_patch() {
    let mut inp = recorded();
    let i = frontier_patch(&inp);
    inp.declared[i].at = 50;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    assert!(ticket_fails(&rep, "beyond the effective r_max 16"));
}
