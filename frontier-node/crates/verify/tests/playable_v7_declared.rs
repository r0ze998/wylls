//! V7 (and every check reading `World::state_before`) reads a recorder's
//! DECLARED patches (verifier-v7-patches, D-dress-7; the class #169 fixed
//! for V11).
//!
//! `playable-dress-v7-declared.json.gz` is the devnet dress rehearsal's
//! run4 archive (`stack` `operator_playable` pdress, the devnet `.so`
//! 67a33c92, `evidence/devnet-dress-rehearsal/run4/pdress-season.json.gz`)
//! cut after transaction 559, with its finals rebuilt from the kept
//! post-states. The harness declared 400 Spearmen in the reserve of the
//! KEEP / PAIR / EXPED rim villages (patches at transactions 421 / 438 /
//! 444, each after the village's last archived write at 420 / 437 / 443);
//! the pages' next Harvest of each village (444 / 445 / 528) wrote a Holding
//! carrying the 400. V7's owner-action replay read the archived post-state
//! from BEFORE the patch (reserve 0) and FAILed all three
//! (`HoldingReplayMismatch`, first at byte 720 = RESERVE): the whole season
//! gave FAIL 3.
//!
//! Now the state before a transaction is the later of the last archived
//! post-state and the declared state (the VX / VWL / V11 rule): a judgement
//! that read a declared state is never a PASS (`MissingData`), and a
//! declared state that contradicts the write is still a FAIL.
#![cfg(feature = "playable-lane")]

mod common;

use frontier_abi::layout::player::holding as H;
use verify_core::input::Input;
use verify_core::{Severity, Verdict};

const FIXTURE: &str = "playable-dress-v7-declared.json.gz";
/// `(patch at, last archived write before it, the next write = a Harvest)`
/// of the three rim villages, in the declared order.
const VILLAGES: [(usize, usize, usize); 3] = [(421, 420, 444), (438, 437, 445), (444, 443, 528)];
const HOLDINGS: [&str; 3] = [
    "holding (-128, 63, 11)",
    "holding (-128, 65, 8)",
    "holding (-128, 64, 10)",
];

fn recorded() -> Input {
    let mut inp = common::fixture(FIXTURE);
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

/// The declared reserve patches (index into `Input::declared`), in order.
fn reserve_patches(inp: &Input) -> Vec<usize> {
    let v: Vec<usize> = inp
        .declared
        .iter()
        .enumerate()
        .filter(|(_, d)| d.what.contains("Spearmen in"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(v.len(), 3, "the three declared rim reserves");
    v
}

/// The reserve slot the patch fills (its non-zero `u32`).
fn spear_slot(d: &verify_core::input::Declared) -> usize {
    let a = d.account.as_ref().unwrap();
    (0..H::RESERVE_N)
        .map(H::reserve)
        .find(|&o| u32::from_le_bytes(a.data[o..o + 4].try_into().unwrap()) == 400)
        .expect("400 in one reserve slot")
}

fn v7_fails(rep: &verify_core::Report) -> Vec<&verify_core::Finding> {
    rep.findings
        .iter()
        .filter(|f| f.fail() && f.check == "V7" && f.code == "HoldingReplayMismatch")
        .collect()
}

#[test]
fn the_archive_has_the_timing_that_used_to_fail() {
    let inp = recorded();
    for (n, i) in reserve_patches(&inp).into_iter().enumerate() {
        let d = &inp.declared[i];
        let (at, last, next) = VILLAGES[n];
        assert_eq!(d.at, at, "{}", d.what);
        let writes: Vec<usize> = inp
            .txs
            .iter()
            .enumerate()
            .filter(|(_, t)| t.err.is_none() && t.post.iter().any(|(k, _)| k.to_bytes() == d.key))
            .map(|(i, _)| i)
            .collect();
        let before: Vec<usize> = writes.iter().copied().filter(|&t| t < at).collect();
        let after: Vec<usize> = writes.iter().copied().filter(|&t| t >= at).collect();
        assert_eq!(before.last(), Some(&last), "{writes:?}");
        assert_eq!(after.first(), Some(&next), "{writes:?}");
        // the archived write before the patch has no Spearmen, the declared
        // state and the next write have 400
        let o = spear_slot(d);
        let rd = |t: usize| {
            let a = inp.txs[t]
                .post
                .iter()
                .find(|(k, _)| k.to_bytes() == d.key)
                .and_then(|(_, a)| a.clone())
                .unwrap();
            u32::from_le_bytes(a.data[o..o + 4].try_into().unwrap())
        };
        assert_eq!(rd(last), 0);
        assert_eq!(rd(next), 400);
    }
}

#[test]
fn honest_owner_actions_after_a_declared_patch_are_unverifiable_never_fail() {
    let rep = verify_core::verify(&recorded());
    let fails: Vec<String> = rep
        .findings
        .iter()
        .filter(|f| f.fail())
        .map(|f| format!("{} {} {} | {}", f.check, f.code, f.entity, f.detail))
        .collect();
    assert!(fails.is_empty(), "{fails:#?}");
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    // each Harvest: judged exactly from the declared Holding, so
    // MissingData, never a PASS
    for h in HOLDINGS {
        assert!(
            rep.findings.iter().any(|f| f.check == "V7"
                && f.severity == Severity::Unverifiable
                && f.entity == h
                && f.detail.contains("only declares")),
            "{h}"
        );
    }
    // the generic path (World::state_before): V16 read the same declared
    // Holdings at the three Harvests and agreed → MissingData per tx
    for (_, _, next) in VILLAGES {
        assert!(
            rep.findings.iter().any(|f| f.check == "V16"
                && f.severity == Severity::Unverifiable
                && f.entity == format!("tx#{next}")
                && f.detail.contains("only declares")),
            "V16 tx#{next}"
        );
    }
}

/// The same archive with the declaration dropped is what V7 saw before
/// the fix: the archived reserve 0 against the written 400 → FAIL 3.
#[test]
fn the_same_harvests_without_the_declared_patches_fail() {
    let mut inp = recorded();
    for i in reserve_patches(&inp).into_iter().rev() {
        inp.declared.remove(i);
    }
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    let f = v7_fails(&rep);
    assert_eq!(f.len(), 3, "{f:#?}");
    for h in HOLDINGS {
        assert!(
            f.iter()
                .any(|x| x.entity == h && x.detail.contains("byte 720")),
            "{h}"
        );
    }
}

/// A forged declaration (300 Spearmen, not the 400 the chain wrote): the
/// replay from the declared state contradicts the write → FAIL.
#[test]
fn a_declared_reserve_the_write_contradicts_fails() {
    let mut inp = recorded();
    let i = reserve_patches(&inp)[0];
    let o = spear_slot(&inp.declared[i]);
    let a = inp.declared[i].account.as_mut().unwrap();
    a.data[o..o + 4].copy_from_slice(&300u32.to_le_bytes());
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    let f = v7_fails(&rep);
    assert_eq!(f.len(), 1, "{f:#?}");
    assert_eq!(f[0].entity, HOLDINGS[0]);
    // the judgement that FAILed is not softened as well
    assert!(!rep
        .findings
        .iter()
        .any(|x| x.check == "V7" && x.entity == HOLDINGS[0] && x.detail.contains("only declares")));
}

/// A declaration in force before the village's last archived write (420,
/// itself a Harvest that wrote reserve 0; "in force from before
/// `txs[at]`", so `at = 420` reaches it too): that Harvest contradicts it
/// → FAIL, and the archived write then overrides it, so the next Harvest
/// (444) is judged from the archived reserve 0 → FAIL, as before the fix.
#[test]
fn a_declared_patch_older_than_the_last_write_is_overridden() {
    let (_, last, next) = VILLAGES[0];
    for (at, want) in [(last, vec![last, next]), (last - 1, vec![last, next])] {
        let mut inp = recorded();
        let i = reserve_patches(&inp)[0];
        inp.declared[i].at = at;
        let rep = verify_core::verify(&inp);
        assert_eq!(rep.verdict, Verdict::Fail, "at {at}");
        let f = v7_fails(&rep);
        let sigs: Vec<String> = want
            .iter()
            .map(|&t| inp.txs[t].signature.to_string())
            .collect();
        assert_eq!(f.len(), want.len(), "at {at}: {f:#?}");
        for x in &f {
            assert_eq!(x.entity, HOLDINGS[0]);
            assert!(sigs.contains(&x.signature), "at {at}: {x:#?}");
        }
    }
}

/// A patch declared in force only after the Harvest does not reach it.
#[test]
fn a_declared_patch_after_the_harvest_does_not_reach_it() {
    let mut inp = recorded();
    let i = reserve_patches(&inp)[2];
    let (_, _, next) = VILLAGES[2];
    inp.declared[i].at = next + 1;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    let f = v7_fails(&rep);
    assert_eq!(f.len(), 1, "{f:#?}");
    assert_eq!(f[0].entity, HOLDINGS[2]);
}

/// A declared Holding whose owner is forged: V7's accrual replay agrees,
/// but V16 (through `World::state_before`, the generic path) sees the first
/// holding's owner change with its generation unchanged → FAIL, not
/// softened.
#[test]
fn a_declared_owner_the_write_contradicts_fails_on_the_generic_path() {
    let mut inp = recorded();
    let i = reserve_patches(&inp)[1];
    let a = inp.declared[i].account.as_mut().unwrap();
    assert_eq!(a.data[H::ORDER], 1, "a first holding");
    a.data[H::OWNER_CITIZEN] ^= 0xff;
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail);
    let (_, _, next) = VILLAGES[1];
    let sig = inp.txs[next].signature.to_string();
    assert!(
        rep.findings
            .iter()
            .any(|f| f.fail() && f.check == "V16" && f.signature == sig),
        "{:#?}",
        rep.findings.iter().filter(|f| f.fail()).collect::<Vec<_>>()
    );
    assert!(!rep
        .findings
        .iter()
        .any(|f| f.check == "V16" && f.entity == format!("tx#{next}")));
}

/// Every tamper of the declarations: never a PASS.
#[test]
fn no_tampered_declaration_passes() {
    let tampers: Vec<Box<dyn Fn(&mut Input)>> = vec![
        Box::new(|inp| inp.declared.clear()),
        Box::new(|inp| {
            let i = reserve_patches(inp)[0];
            inp.declared[i].account = None;
        }),
        Box::new(|inp| {
            let i = reserve_patches(inp)[1];
            let a = inp.declared[i].account.as_mut().unwrap();
            a.data.truncate(100);
        }),
        Box::new(|inp| {
            let i = reserve_patches(inp)[2];
            let o = spear_slot(&inp.declared[i]);
            let a = inp.declared[i].account.as_mut().unwrap();
            a.data[o..o + 4].copy_from_slice(&4000u32.to_le_bytes());
        }),
    ];
    for (n, t) in tampers.iter().enumerate() {
        let mut inp = recorded();
        t(&mut inp);
        let rep = verify_core::verify(&inp);
        assert_ne!(rep.verdict, Verdict::Pass, "tamper {n}");
        assert!(
            rep.verdict == Verdict::Fail || !inp.declared.is_empty(),
            "tamper {n}: an archive without declarations must FAIL here"
        );
    }
}

/// The whole run4 archive (19 MB, not committed): set
/// `WYLLS_DRESS_ARCHIVE` to `evidence/devnet-dress-rehearsal/run4/pdress-season.json.gz`.
/// Before the fix: FAIL 3 × V7; now UNVERIFIABLE with 0 FAIL.
#[test]
fn the_whole_dress_rehearsal_season_is_unverifiable_never_fail() {
    let Ok(path) = std::env::var("WYLLS_DRESS_ARCHIVE") else {
        eprintln!("WYLLS_DRESS_ARCHIVE unset: skipped");
        return;
    };
    let mut inp = Input::load(std::path::Path::new(&path)).expect("the archive");
    inp.program_so = recorded().program_so;
    let rep = verify_core::verify(&inp);
    let fails: Vec<_> = rep.findings.iter().filter(|f| f.fail()).collect();
    assert!(fails.is_empty(), "{fails:#?}");
    assert_eq!(rep.verdict, Verdict::Unverifiable);
}
