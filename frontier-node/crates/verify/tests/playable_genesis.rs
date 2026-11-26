//! VG — an archive WITHOUT post-states (what a public RPC serves:
//! D-verify-pr81-3), re-executed from the Season's creation by the pinned
//! program (`verify_core::genesis`, Q16-1 = A, prize gate).
//!
//! The recording `fixtures/verify/playable-lane-genesis.json.gz` is the
//! natural playable-lane season of `playable_lane.rs`
//! (`record_playable_lane_natural`, AnnounceSeason → … → Join, PlaceHome,
//! Harvest, Build, Train, Muster, FoldLand, ClaimLandYield; four program
//! failures included) made with the committed devnet-playable `.so`
//! (sha256 da3dc1aa…) in the in-process LiteSVM chain, with what
//! `getTransaction` serves beside each transaction (`meta.preBalances` /
//! `postBalances`) and the ProgramData's upgrade authority. These tests
//! strip its post-states and judge what is left. Key-free: they read the
//! recording only (the recorder is `#[ignore]`).
#![cfg(feature = "playable-lane")]

mod common;

use fclient::ports::Account;
use verify_core::input::Input;
use verify_core::{Report, Severity, Verdict};

const FIXTURE: &str = "playable-lane-genesis.json.gz";
const SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";
const MAIN_SHA256: &str = "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(hex::encode(p.sha256()), MAIN_SHA256);
    std::sync::Arc::new(p.so.as_ref().clone())
}

/// The recording as the local node archived it (post-states included).
fn recorded() -> Input {
    common::fixture(FIXTURE)
}

/// The recording as a public RPC serves it: no post-states; with the
/// chain's balances and the pinned binary.
fn rpc_shaped() -> Input {
    let mut inp = recorded();
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    inp.program_so = Some(so());
    inp
}

fn show(r: &Report) -> Vec<String> {
    r.findings
        .iter()
        .map(|f| {
            format!(
                "{:?} {} {} {} {}",
                f.severity,
                f.check,
                f.code,
                f.entity,
                f.detail.chars().take(400).collect::<String>()
            )
        })
        .collect()
}

fn fails_vg(r: &Report) -> bool {
    r.findings.iter().any(|f| f.fail() && f.check == "VG")
}

fn owned(a: &Option<Account>, program: &[u8; 32]) -> bool {
    a.as_ref().is_some_and(|a| a.owner.to_bytes() == *program)
}

/// `(tx, message key index)` of a program account a successful
/// transaction writes (from the recorded post-states).
fn program_write(inp: &Input, from: usize) -> (usize, usize) {
    let program = inp.cfg.program.to_bytes();
    for (i, t) in inp.txs.iter().enumerate().skip(from) {
        if t.err.is_some() {
            continue;
        }
        let m = fclient::tx::from_wire(&t.tx).unwrap().message;
        for (k, a) in &t.post {
            if owned(a, &program) {
                let j = m.account_keys.iter().position(|x| x == k).unwrap();
                return (i, j);
            }
        }
    }
    panic!("no program write after tx#{from}");
}

fn sig(inp: &Input, i: usize) -> String {
    inp.txs[i].signature.to_string()
}

#[test]
fn the_recording_is_the_whole_honest_season_with_its_balances() {
    let inp = recorded();
    assert_eq!(
        inp.cfg.program_hash.map(hex::encode).as_deref(),
        Some(MAIN_SHA256)
    );
    assert!(inp.declared.is_empty(), "no recorder patch");
    assert!(inp.chain.upgrade_authority.is_some());
    assert_eq!(inp.chain.balances.len(), inp.txs.len());
    assert!(inp.txs.iter().filter(|t| t.err.is_some()).count() >= 4);
    // As the local node archived it (post-states), with the pinned binary
    // (VX re-executes its OpenProvinces), it passes.
    let mut inp = inp;
    inp.program_so = Some(so());
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(
        !r.checks_run.contains(&"VG:genesis-replay"),
        "VG is for archives without post-states"
    );
}

#[test]
fn without_post_states_the_season_was_never_a_pass() {
    // What the verifier said of such an archive before VG (no balances, or
    // no pinned binary): never PASS.
    let mut a = rpc_shaped();
    a.chain = Default::default();
    let r = verify_core::verify(&a);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    let mut b = rpc_shaped();
    b.program_so = None;
    let r = verify_core::verify(&b);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r
        .findings
        .iter()
        .any(|f| f.check == "VG" && f.severity == Severity::Unverifiable));
}

#[test]
fn an_honest_archive_without_post_states_passes_by_genesis_replay() {
    let r = verify_core::verify(&rpc_shaped());
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r.checks_run.contains(&"VG:genesis-replay"));
    assert!(r.checks_run.contains(&"VX:re-execution"));
    assert!(r.checks_run.contains(&"VL:land"));
}

#[test]
fn the_derived_post_states_are_the_ones_the_local_node_archived() {
    let rec = recorded();
    let d = verify_core::genesis::derive(&rpc_shaped());
    // (verify-pr266: the stamps nothing the chain recorded decides are
    // counted in VG's WARN even when no slot moved; nothing else)
    assert!(
        d.ran
            && d.findings
                .iter()
                .all(|f| f.severity == verify_core::Severity::Warn
                    && f.code == "ClockFromEffects"
                    && f.detail.contains(" 0 transaction(s) in 0 slot(s)")),
        "{:?}",
        d.findings
    );
    let derived = d.input.expect("derived");
    let program = rec.cfg.program.to_bytes();
    let mut compared = 0;
    for (i, (a, b)) in rec.txs.iter().zip(derived.txs.iter()).enumerate() {
        if a.err.is_some() {
            assert!(
                b.post.is_empty(),
                "tx#{i}: a failed transaction has no derived post-state"
            );
            continue;
        }
        // Every program-owned post-state the node archived, byte for byte
        // (lamports included) …
        for (k, acc) in &a.post {
            let got = b.post.iter().find(|(x, _)| x == k).map(|(_, s)| s);
            assert_eq!(got, Some(acc), "tx#{i} {k}");
            compared += 1;
        }
        // … and no program-owned one it did not.
        for (k, acc) in &b.post {
            if owned(acc, &program) {
                assert!(a.post.iter().any(|(x, _)| x == k), "tx#{i} {k}");
            }
        }
    }
    assert!(compared > 100, "{compared}");
}

// ------------------------------------------------------------ tampers

fn assert_fail(inp: &Input, what: &str) -> Report {
    let r = verify_core::verify(inp);
    assert_eq!(r.verdict, Verdict::Fail, "{what}: {:#?}", show(&r));
    r
}

#[test]
fn a_forged_record_in_the_logs_fails() {
    let mut inp = rpc_shaped();
    let i = (0..inp.txs.len())
        .find(|&i| {
            inp.txs[i].err.is_none()
                && inp.txs[i]
                    .logs
                    .iter()
                    .any(|l| l.starts_with("Program data: "))
                && i > 20
        })
        .unwrap();
    let l = inp.txs[i]
        .logs
        .iter_mut()
        .find(|l| l.starts_with("Program data: "))
        .unwrap();
    let n = l.len() - 6;
    let c = if l.as_bytes()[n] == b'A' { "B" } else { "A" };
    l.replace_range(n..n + 1, c);
    assert!(fails_vg(&assert_fail(&inp, "forged record")));
}

#[test]
fn a_forged_final_state_fails() {
    let mut inp = rpc_shaped();
    let program = inp.cfg.program.to_bytes();
    let (_, a) = inp
        .finals
        .iter_mut()
        .find(|(_, a)| owned(a, &program) && a.as_ref().is_some_and(|a| a.data.len() > 200))
        .unwrap();
    a.as_mut().unwrap().data[150] ^= 1;
    assert!(fails_vg(&assert_fail(&inp, "forged final")));
}

#[test]
fn an_omitted_transaction_fails() {
    let mut inp = rpc_shaped();
    // a successful Harvest / Build in the middle of the season
    let (i, _) = program_write(&recorded(), 22);
    inp.txs.remove(i);
    let r = assert_fail(&inp, "omitted transaction");
    // VG's own finding (an archive without post-states FAILs other
    // checks too: D-verifier-archive-next-1)
    assert!(fails_vg(&r), "{:#?}", show(&r));
}

#[test]
fn a_transaction_archived_twice_fails() {
    let mut inp = rpc_shaped();
    let (i, _) = program_write(&recorded(), 22);
    let t = inp.txs[i].clone();
    inp.txs.push(t);
    let r = assert_fail(&inp, "duplicated transaction");
    // VG's own finding (an archive without post-states FAILs other
    // checks too: D-verifier-archive-next-1)
    assert!(fails_vg(&r), "{:#?}", show(&r));
}

#[test]
fn a_refused_transaction_archived_as_a_success_fails() {
    let mut inp = rpc_shaped();
    let i = inp.txs.iter().position(|t| t.code.is_some()).unwrap();
    inp.txs[i].err = None;
    inp.txs[i].code = None;
    let r = assert_fail(&inp, "refused as success");
    assert!(r
        .findings
        .iter()
        .any(|f| f.check == "VG" && f.fail() && f.code == verify_core::codes::REEXEC_REFUSED));
}

#[test]
fn a_success_archived_as_a_program_failure_fails() {
    let mut inp = rpc_shaped();
    let (i, _) = program_write(&recorded(), 22);
    inp.txs[i].err = Some("InstructionError(0, Custom(22))".into());
    inp.txs[i].code = Some(22);
    let r = assert_fail(&inp, "success as failure");
    // VG's own finding (an archive without post-states FAILs other
    // checks too: D-verifier-archive-next-1)
    assert!(fails_vg(&r), "{:#?}", show(&r));
}

#[test]
fn a_program_account_debited_outside_the_program_fails() {
    let mut inp = rpc_shaped();
    let (i, j) = program_write(&recorded(), 30);
    // the account's lamports before a LATER transaction that names it
    let k = fclient::tx::from_wire(&inp.txs[i].tx)
        .unwrap()
        .message
        .account_keys[j];
    let later = (i + 1..inp.txs.len())
        .find(|&t| {
            fclient::tx::from_wire(&inp.txs[t].tx)
                .unwrap()
                .message
                .account_keys
                .contains(&k)
        })
        .expect("a later transaction names it");
    let jj = fclient::tx::from_wire(&inp.txs[later].tx)
        .unwrap()
        .message
        .account_keys
        .iter()
        .position(|x| *x == k)
        .unwrap();
    let s = sig(&inp, later);
    inp.chain.balances.get_mut(&s).unwrap().pre[jj] -= 1;
    assert!(fails_vg(&assert_fail(&inp, "debit outside")));
}

#[test]
fn a_forged_post_balance_of_a_program_account_fails() {
    let mut inp = rpc_shaped();
    let (i, j) = program_write(&recorded(), 22);
    let s = sig(&inp, i);
    inp.chain.balances.get_mut(&s).unwrap().post[j] += 1_000;
    assert!(fails_vg(&assert_fail(&inp, "post balance")));
}

#[test]
fn a_transaction_without_balances_is_unverifiable_not_a_pass() {
    let mut inp = rpc_shaped();
    let (i, _) = program_write(&recorded(), 22);
    let s = sig(&inp, i);
    inp.chain.balances.remove(&s);
    let r = verify_core::verify(&inp);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r
        .findings
        .iter()
        .any(|f| f.check == "VG" && f.severity == Severity::Unverifiable));
}

#[test]
fn a_binary_that_is_not_the_pinned_one_is_unverifiable() {
    let mut inp = rpc_shaped();
    let mut so = inp.program_so.as_ref().unwrap().as_ref().clone();
    let n = so.len() - 1;
    so[n] ^= 0xff;
    inp.program_so = Some(std::sync::Arc::new(so));
    let r = verify_core::verify(&inp);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(!r.checks_run.contains(&"VG:genesis-replay"));
}

#[test]
fn an_unread_upgrade_authority_is_never_a_pass() {
    let mut inp = rpc_shaped();
    inp.chain.upgrade_authority = None;
    let r = verify_core::verify(&inp);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
}

#[test]
fn the_chain_witness_round_trips_through_the_fixture_format() {
    let inp = recorded();
    let back = Input::from_json(&inp.to_json()).unwrap();
    assert_eq!(back.chain, inp.chain);
}

#[test]
fn a_mutate_vg_build_judges_nothing() {
    // Under `mutate-vg` the derivation is off: an archive without
    // post-states is then never a PASS (the check of the check).
    let r = verify_core::verify(&rpc_shaped());
    if cfg!(feature = "mutate-vg") {
        assert_ne!(r.verdict, Verdict::Pass);
        assert!(!r.checks_run.contains(&"VG:genesis-replay"));
    } else {
        assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    }
}

// ------------------------------------- D-verify-pr89-3 (with post-states)

fn with_posts() -> Input {
    let mut inp = recorded();
    inp.program_so = Some(so());
    inp
}

/// The successful legacy OpenProvince (0x22) transactions.
fn open_provinces(inp: &Input) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&i| {
            inp.txs[i].err.is_none()
                && fclient::tx::from_wire(&inp.txs[i].tx).is_ok_and(|t| {
                    t.message.instructions.iter().any(|ci| {
                        t.message.account_keys[ci.program_id_index as usize] == inp.cfg.program
                            && ci.data.first() == Some(&0x22)
                    })
                })
        })
        .collect()
}

#[test]
fn an_edited_province_at_an_open_province_fails() {
    // verify-pr89 M8a: bytes 200 and 1000 of an OpenProvince's Province
    // post-state had no finding at all.
    let ops = open_provinces(&recorded());
    assert!(ops.len() >= 3, "{ops:?}");
    for at in [200usize, 1000] {
        let mut inp = with_posts();
        let program = inp.cfg.program;
        let i = ops[1];
        let (_, a) = inp.txs[i]
            .post
            .iter_mut()
            .find(|(_, a)| {
                a.as_ref()
                    .is_some_and(|a| a.owner == program && a.data.len() > at)
            })
            .expect("the Province post");
        a.as_mut().unwrap().data[at] ^= 0x5a;
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, Verdict::Fail, "byte {at}: {:#?}", show(&r));
        assert!(
            r.findings.iter().any(|f| f.fail()
                && f.check == "VX"
                && f.entity == format!("tx#{i}")
                && f.code == verify_core::codes::REEXEC_MISMATCH),
            "byte {at}: {:#?}",
            show(&r)
        );
    }
    // Without the binary it is never a PASS either.
    let mut inp = with_posts();
    inp.program_so = None;
    assert_ne!(verify_core::verify(&inp).verdict, Verdict::Pass);
}

#[test]
fn a_post_state_of_an_account_the_transaction_does_not_write_fails() {
    // verify-pr89 M8b: a post-state on a transaction that does not name the
    // account, or holds it read-only, had no finding.
    let base = with_posts();
    let program = base.cfg.program;
    let (i, k, acc) = base
        .txs
        .iter()
        .enumerate()
        .find_map(|(i, t)| {
            let m = fclient::tx::from_wire(&t.tx).ok()?.message;
            let j = (0..m.account_keys.len()).find(|&j| !fclient::tx::is_writable_index(&m, j))?;
            let acc = base
                .finals
                .values()
                .flatten()
                .find(|a| a.owner == program)?
                .clone();
            (t.err.is_none() && i > 0).then_some((i, m.account_keys[j], acc))
        })
        .unwrap();
    for (what, key) in [
        ("read-only", k),
        ("unnamed", fclient::Address::new_from_array([0x77; 32])),
    ] {
        let mut inp = base.clone();
        inp.txs[i].post.push((key, Some(acc.clone())));
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, Verdict::Fail, "{what}: {:#?}", show(&r));
        assert!(
            r.findings.iter().any(|f| f.fail()
                && f.check == "V0E"
                && f.code == verify_core::codes::UNWRITABLE_POST),
            "{what}: {:#?}",
            show(&r)
        );
    }
}

// ------------------------------- balances no chain shows (verify-pr91)

fn assert_not_pass_vg(inp: &Input, what: &str) {
    let r = verify_core::verify(inp);
    assert_ne!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
    assert!(
        r.findings
            .iter()
            .any(|f| f.check == "VG" && f.severity >= Severity::Unverifiable),
        "{what}: {:#?}",
        show(&r)
    );
}

#[test]
fn balances_that_do_not_conserve_lamports_are_never_a_pass() {
    // verify-pr91 mutations: the fee payer's balances were re-based away,
    // a read-only account's and a failed transaction's were not compared.
    let base = rpc_shaped();
    let ok = (0..base.txs.len())
        .find(|&i| base.txs[i].err.is_none() && i > 20)
        .unwrap();
    let failed = base.txs.iter().position(|t| t.err.is_some()).unwrap();
    let ro = |i: usize| {
        let m = fclient::tx::from_wire(&base.txs[i].tx).unwrap().message;
        (0..m.account_keys.len())
            .find(|&j| !fclient::tx::is_writable_index(&m, j))
            .unwrap()
    };
    for (what, i, j, pre, d) in [
        ("fee payer pre +1", ok, 0, true, 1i64),
        ("fee payer pre -1", ok, 0, true, -1),
        ("fee payer post +1", ok, 0, false, 1),
        ("read-only pre +1", ok, ro(ok), true, 1),
        ("read-only post +1", ok, ro(ok), false, 1),
        ("failed: payer post +1", failed, 0, false, 1),
        ("failed: account #1 post +1", failed, 1, false, 1),
    ] {
        let mut inp = base.clone();
        let s = sig(&inp, i);
        let b = inp.chain.balances.get_mut(&s).unwrap();
        let v = if pre { &mut b.pre[j] } else { &mut b.post[j] };
        *v = (*v as i64 + d) as u64;
        assert_not_pass_vg(&inp, what);
    }
    // the fee alone
    let mut inp = base.clone();
    inp.txs[ok].fee += 1;
    assert_not_pass_vg(&inp, "fee +1");
}

#[test]
fn a_program_account_that_loses_lamports_after_a_failed_transaction_fails() {
    // A failed transaction shows a program account with one lamport more
    // (a credit, before and after it); the next transaction naming it shows
    // the old balance: only the program debits it.
    let mut inp = rpc_shaped();
    let program = inp.cfg.program.to_bytes();
    let rec = recorded();
    let (i, j) = (0..inp.txs.len())
        .filter(|&i| inp.txs[i].err.is_some())
        .find_map(|i| {
            let m = fclient::tx::from_wire(&inp.txs[i].tx).unwrap().message;
            let j = (1..m.account_keys.len()).find(|&j| {
                rec.finals
                    .get(&m.account_keys[j].to_bytes())
                    .is_some_and(|a| owned(a, &program))
            })?;
            Some((i, j))
        })
        .unwrap();
    let s = sig(&inp, i);
    let b = inp.chain.balances.get_mut(&s).unwrap();
    b.pre[j] += 1;
    b.post[j] += 1;
    b.pre[0] -= 1;
    b.post[0] -= 1;
    let r = assert_fail(&inp, "lamports lost after a failed transaction");
    assert!(fails_vg(&r), "{:#?}", show(&r));
}

#[test]
fn an_archive_out_of_slot_order_is_never_a_pass() {
    let mut inp = rpc_shaped();
    // two setup transactions whose effects commute (they write disjoint
    // accounts and log no record): swapped, every state is the same
    inp.txs.swap(3, 4);
    assert_not_pass_vg(&inp, "slots go back");
}
