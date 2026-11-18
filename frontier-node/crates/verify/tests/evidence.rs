//! V0E (⑪): a successful transaction whose evidence is missing, cut short
//! or produced by a call the archive does not show is never a PASS. Each
//! case changes one transaction (or one post-state) of a recorded fixture
//! that PASSes. Before V0E, every case here except a few that broke an
//! event chain was a PASS (workstream 11, r5 probe).

mod common;

use common::*;
use verify_core::input::Input;
use verify_core::{Severity, Verdict};

fn v0e(r: &verify_core::Report) -> Vec<String> {
    r.findings
        .iter()
        .filter(|f| f.check == "V0E")
        .map(|f| {
            assert_eq!(f.severity, Severity::Unverifiable, "{}", f.code);
            f.code.clone()
        })
        .collect()
}

/// Successful transactions that call the program at top level.
fn calls(inp: &Input) -> Vec<usize> {
    let p = inp.cfg.program;
    (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none()
                && fclient::tx::from_wire(&inp.txs[t].tx).is_ok_and(|tx| {
                    let k = &tx.message.account_keys;
                    tx.message
                        .instructions
                        .iter()
                        .any(|c| k[c.program_id_index as usize] == p)
                })
        })
        .collect()
}

/// Counts the cases, and the ones that come out a PASS (printed, so the
/// same file measures a verifier without V0E too).
#[derive(Default)]
struct Count {
    cases: usize,
    passed: Vec<String>,
    /// Not a PASS, but neither a FAIL nor the expected V0E code.
    uncoded: Vec<String>,
}

impl Count {
    fn check(&mut self, inp: &Input, code: &str, what: &str) {
        self.cases += 1;
        let r = verify_core::verify(inp);
        if r.verdict == Verdict::Pass {
            self.passed.push(what.to_string());
            return;
        }
        if !(v0e(&r).iter().any(|c| c == code) || r.verdict == Verdict::Fail) {
            self.uncoded.push(format!("{what}: want {code} or a FAIL"));
        }
    }
    fn done(self, name: &str) {
        println!(
            "{name}: {} cases, {} PASS {:?}, {} without the code",
            self.cases,
            self.passed.len(),
            self.passed.iter().take(5).collect::<Vec<_>>(),
            self.uncoded.len()
        );
        assert!(self.cases > 0, "{name}: no case");
        assert!(
            self.passed.is_empty(),
            "{name}: {} of {} cases PASS",
            self.passed.len(),
            self.cases
        );
        assert!(
            self.uncoded.is_empty(),
            "{name}: {:?}",
            self.uncoded.first()
        );
    }
}

/// At most `n` evenly spread items (the march fixture is long).
fn spread(v: Vec<usize>, n: usize) -> Vec<usize> {
    if v.len() <= n {
        return v;
    }
    (0..n).map(|i| v[i * v.len() / n]).collect()
}

fn fixtures() -> Vec<(&'static str, Input, usize)> {
    vec![
        ("land", land(), usize::MAX),
        ("march_program", march_program(), 12),
    ]
}

#[test]
fn the_fixtures_have_nothing_for_v0e() {
    for inp in [land(), march_program()] {
        let r = verify_core::verify(&inp);
        assert_eq!(v0e(&r), Vec::<String>::new(), "{}", show(&r));
        assert_eq!(r.verdict, Verdict::Pass);
    }
    // The synthetic march season: nothing for V0E either; its only failures
    // are its six impossible tickets (V11, `common::MARCH_SYNTH_IMPOSSIBLE_TICKETS`).
    let r = verify_core::verify(&march());
    assert_eq!(v0e(&r), Vec::<String>::new(), "{}", show(&r));
    assert_only_the_impossible_tickets(&r);
}

#[test]
fn a_call_without_logs_is_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        for t in spread(calls(&base), n) {
            let mut inp = base.clone();
            inp.txs[t].logs.clear();
            c.check(&inp, "MissingLogs", &format!("{fx} tx#{t}"));
        }
    }
    c.done("no logs");
}

#[test]
fn logs_the_runtime_cut_are_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        for t in spread(calls(&base), n) {
            let mut inp = base.clone();
            let keep = inp.txs[t].logs.len() / 2;
            inp.txs[t].logs.truncate(keep.max(1));
            inp.txs[t].logs.push("Log truncated".into());
            c.check(&inp, "TruncatedLogs", &format!("{fx} tx#{t}"));
        }
    }
    c.done("truncated logs");
}

/// The transaction's program instructions moved under another program of
/// the message, the logs nesting the program one level down (a CPI).
fn cpi_shaped(base: &Input, t: usize) -> Option<Input> {
    let program = base.cfg.program;
    let mut tx = fclient::tx::from_wire(&base.txs[t].tx).ok()?;
    let keys = tx.message.account_keys.clone();
    let other = tx
        .message
        .instructions
        .iter()
        .map(|c| c.program_id_index as usize)
        .find(|&i| keys[i] != program)?;
    let mut moved = false;
    for c in tx.message.instructions.iter_mut() {
        let cpi_ok = c
            .data
            .first()
            .and_then(|x| frontier_abi::v2::Ix::from_tag(*x))
            .is_some_and(|ix| !ix.top_level_only());
        if keys[c.program_id_index as usize] == program && cpi_ok {
            c.program_id_index = other as u8;
            moved = true;
        }
    }
    if !moved {
        return None;
    }
    let mut inp = base.clone();
    inp.txs[t].tx = fclient::tx::wire(&tx);
    let wrapper = keys[other];
    let top = format!("Program {program} invoke [1]");
    let mut logs = vec![format!("Program {wrapper} invoke [1]")];
    logs.extend(inp.txs[t].logs.iter().map(|l| {
        if *l == top {
            format!("Program {program} invoke [2]")
        } else {
            l.clone()
        }
    }));
    logs.push(format!("Program {wrapper} success"));
    inp.txs[t].logs = logs;
    Some(inp)
}

#[test]
fn the_program_run_by_another_program_is_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        for t in spread(calls(&base), n) {
            let Some(inp) = cpi_shaped(&base, t) else {
                continue;
            };
            c.check(&inp, "UnverifiedInnerInstruction", &format!("{fx} tx#{t}"));
        }
    }
    c.done("cpi");
}

const HOLD: &[u8; 8] = b"PSF1HOLD";

#[test]
fn a_written_account_without_its_post_state_is_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        let program = base.cfg.program;
        let mut drops = Vec::new();
        for t in 0..base.txs.len() {
            for (k, a) in &base.txs[t].post {
                if a.as_ref()
                    .is_some_and(|a| a.owner == program && !a.data.starts_with(HOLD))
                {
                    drops.push((t, *k));
                }
            }
        }
        let picks = spread(
            (0..drops.len()).collect(),
            if n == usize::MAX { 60 } else { n },
        );
        for i in picks {
            let (t, k) = drops[i];
            let mut inp = base.clone();
            inp.txs[t].post.retain(|(x, _)| *x != k);
            // Either the chain checks already FAIL it, or V0E says so.
            c.check(&inp, "MissingPostState", &format!("{fx} tx#{t} {k}"));
        }
    }
    c.done("dropped post-states");
}

// ---- r6 (⑪, 2026-11-06): the paths 0004 left open --------------------------

/// A CPI-only transaction (the program named among its accounts, called by
/// another program) whose logs are absent: nothing tells whether, or what,
/// the program ran (⑯ P1's A8 without logs).
#[test]
fn a_cpi_only_transaction_without_logs_is_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        for t in spread(calls(&base), n) {
            let Some(mut inp) = cpi_shaped(&base, t) else {
                continue;
            };
            // A transaction whose every program call went under the wrapper.
            if fclient::tx::from_wire(&inp.txs[t].tx).is_ok_and(|tx| {
                let k = &tx.message.account_keys;
                tx.message
                    .instructions
                    .iter()
                    .any(|c| k[c.program_id_index as usize] == base.cfg.program)
            }) {
                continue;
            }
            inp.txs[t].logs.clear();
            c.check(&inp, "MissingLogs", &format!("{fx} tx#{t}"));
        }
    }
    c.done("cpi-only, no logs");
}

/// Logs that lose their tail without the runtime's `Log truncated` marker:
/// cut at the last record line (`Program data:`), so at least one record
/// and the program's `success` line are gone.
#[test]
fn logs_that_lose_their_tail_are_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        for t in spread(calls(&base), n) {
            let Some(cut) = base.txs[t]
                .logs
                .iter()
                .rposition(|l| l.starts_with("Program data: "))
            else {
                continue;
            };
            let mut inp = base.clone();
            inp.txs[t].logs.truncate(cut);
            c.check(&inp, "IncompleteLogs", &format!("{fx} tx#{t}"));
        }
    }
    c.done("tail lost, no marker");
}

/// The control: a transaction that only names the program, whose complete
/// logs show the program never ran, is not V0E's to report (V2 warns, as
/// before; whatever else the change breaks is the other checks').
#[test]
fn a_mention_whose_logs_show_no_run_is_not_reported() {
    let base = land();
    let program = base.cfg.program;
    let mut checked = 0;
    for t in spread(calls(&base), 40) {
        let Some(mut inp) = cpi_shaped(&base, t) else {
            continue;
        };
        // Drop the program's frames from the logs: it never ran.
        let mut out = Vec::new();
        let mut depth = 0usize;
        for l in &inp.txs[t].logs {
            if l.starts_with(&format!("Program {program} invoke [")) {
                depth += 1;
                continue;
            }
            if depth > 0 {
                if *l == format!("Program {program} success") {
                    depth -= 1;
                }
                continue;
            }
            out.push(l.clone());
        }
        inp.txs[t].logs = out;
        let r = verify_core::verify(&inp);
        assert!(v0e(&r).is_empty(), "tx#{t}: {}", show(&r));
        checked += 1;
    }
    assert!(checked > 0);
}

/// r15 (found by workstream 2): V0E knows every program kind of ABI v2, not
/// only M1's. A program account of an S1 kind (MarchState, Vault, Caravan,
/// Structure, Nation, Lot) known by an earlier post-state, held writable by
/// a later successful transaction whose post-states leave it out, is
/// `MissingPostState`, as a Citizen (the control) always was. The recorded
/// `land` transactions are edited in place (literal account bytes; no key
/// is generated, derived or signed).
#[test]
fn a_written_s1_account_without_its_post_state_is_not_a_pass() {
    use frontier_abi::v2::layout::{write_header, AccountKind as K};
    let base = land();
    let program = base.cfg.program;
    // A later transaction with post-states that holds a non-program account
    // writable and leaves it out of its post-states, and an earlier one.
    let (t1, t2, key) = (0..base.txs.len())
        .filter(|&t| base.txs[t].err.is_none() && !base.txs[t].post.is_empty())
        .find_map(|t2| {
            let tx = fclient::tx::from_wire(&base.txs[t2].tx).ok()?;
            let k = (0..tx.message.account_keys.len()).find_map(|i| {
                let a = tx.message.account_keys[i];
                (fclient::tx::is_writable_index(&tx.message, i)
                    && a != program
                    && !base.txs[t2].post.iter().any(|(x, _)| *x == a))
                .then_some(a)
            })?;
            let t1 = (0..t2)
                .rev()
                .find(|&t| base.txs[t].err.is_none() && !base.txs[t].post.is_empty())?;
            Some((t1, t2, k))
        })
        .expect("a writable account outside a later transaction's post-states");
    let mut missed = vec![];
    for k in [
        K::Citizen,
        K::MarchState,
        K::Vault,
        K::Caravan,
        K::Structure,
        K::Nation,
        K::Lot,
    ] {
        let mut d = vec![0u8; k.size()];
        assert!(write_header(&mut d, k, base.cfg.season_id), "{k:?}");
        let mut inp = base.clone();
        inp.txs[t1].post.push((
            key,
            Some(fclient::ports::Account {
                lamports: 1,
                data: d,
                owner: program,
                executable: false,
            }),
        ));
        let r = verify_core::verify(&inp);
        assert_ne!(r.verdict, Verdict::Pass, "{k:?}");
        if !r.findings.iter().any(|f| {
            f.check == "V0E" && f.code == "MissingPostState" && f.entity == format!("tx#{t2}")
        }) {
            missed.push(format!("{k:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "V0E missed {missed:?} (tx#{t1} → tx#{t2})"
    );
}

/// A later successful transaction with post-states that holds an account
/// (not the program) writable and leaves it out of its post-states, an
/// earlier one with post-states, and that account.
fn later_write_without_post(base: &Input) -> (usize, usize, fclient::Address) {
    let program = base.cfg.program;
    (0..base.txs.len())
        .filter(|&t| base.txs[t].err.is_none() && !base.txs[t].post.is_empty())
        .find_map(|t2| {
            let tx = fclient::tx::from_wire(&base.txs[t2].tx).ok()?;
            let k = (0..tx.message.account_keys.len()).find_map(|i| {
                let a = tx.message.account_keys[i];
                (fclient::tx::is_writable_index(&tx.message, i)
                    && a != program
                    && !base.txs[t2].post.iter().any(|(x, _)| *x == a))
                .then_some(a)
            })?;
            let t1 = (0..t2)
                .rev()
                .find(|&t| base.txs[t].err.is_none() && !base.txs[t].post.is_empty())?;
            Some((t1, t2, k))
        })
        .expect("a writable account outside a later transaction's post-states")
}

/// ⑪ (2026-11-18, PR for the early verifier patches): V0E knows every
/// account the program owns, not only those with one of ABI v2's
/// [`AccountKind`](frontier_abi::v2::layout::AccountKind) magics. Workstream
/// 20's resident policy and link, 02-rights' Grant, the wide world's
/// accounts and any layout a later build adds are program accounts too: one
/// known by an earlier post-state, held writable by a later successful
/// transaction whose post-states leave it out, is `MissingPostState`, never
/// a PASS. Before this, V0E filtered by `AccountKind::from_magic` and each of
/// these was left unjudged (the 0003/0015 hole for the layouts outside the
/// list). Edits the recorded `land` transactions in place (literal bytes; no
/// key is generated, derived or signed).
#[test]
fn a_written_program_account_of_any_layout_without_its_post_state_is_not_a_pass() {
    let base = land();
    let program = base.cfg.program;
    let (t1, t2, key) = later_write_without_post(&base);
    let with_magic = |m: [u8; 8], len: usize| {
        let mut d = vec![0u8; len.max(8)];
        d[..8].copy_from_slice(&m);
        d
    };
    let layouts: Vec<(&str, Vec<u8>)> = vec![
        (
            "resident policy",
            with_magic(
                frontier_abi::resident_policy::MAGIC,
                frontier_abi::resident_policy::LEN,
            ),
        ),
        (
            "resident link",
            with_magic(
                frontier_abi::resident_binding::MAGIC,
                frontier_abi::resident_binding::LEN,
            ),
        ),
        (
            "Grant",
            with_magic(frontier_abi::v2::rights::layout::MAGIC, 272),
        ),
        ("wide roster", with_magic(*b"PSFXWRO2", 256)),
        ("wide conquest", with_magic(*b"PSFXWCQ1", 256)),
        ("a layout no ABI names", with_magic(*b"PSFZZZZ9", 64)),
        ("shorter than a magic", vec![1, 2, 3]),
    ];
    let mut missed = vec![];
    for (what, d) in layouts {
        let mut inp = base.clone();
        inp.txs[t1].post.push((
            key,
            Some(fclient::ports::Account {
                lamports: 1,
                data: d,
                owner: program,
                executable: false,
            }),
        ));
        let r = verify_core::verify(&inp);
        assert_ne!(r.verdict, Verdict::Pass, "{what}: {}", show(&r));
        if !r.findings.iter().any(|f| {
            f.check == "V0E" && f.code == "MissingPostState" && f.entity == format!("tx#{t2}")
        }) {
            missed.push(what);
        }
    }
    assert!(
        missed.is_empty(),
        "V0E missed {missed:?} (tx#{t1} → tx#{t2})"
    );
}

/// The control for the test above: the same account owned by another
/// program (a token account, the System program's wallet) is not V0E's, so
/// an honest archive that records only what it records stays as it was.
#[test]
fn a_written_foreign_account_without_its_post_state_is_not_reported() {
    let base = land();
    let (t1, t2, key) = later_write_without_post(&base);
    let mut inp = base.clone();
    inp.txs[t1].post.push((
        key,
        Some(fclient::ports::Account {
            lamports: 1,
            data: b"PSFZZZZ9 not the program's".to_vec(),
            owner: fclient::Address::new_from_array([7u8; 32]),
            executable: false,
        }),
    ));
    let r = verify_core::verify(&inp);
    assert!(
        !r.findings
            .iter()
            .any(|f| f.check == "V0E" && f.entity == format!("tx#{t2}")),
        "{}",
        show(&r)
    );
}

// ---- 2026-11-18 (⑪, the early verifier patches): invocations the message
// does not account for -------------------------------------------------------

/// The number of top-level instructions of the program in `t`'s message.
fn top_calls(inp: &Input, t: usize) -> usize {
    let p = inp.cfg.program;
    fclient::tx::from_wire(&inp.txs[t].tx).map_or(0, |tx| {
        let k = &tx.message.account_keys;
        tx.message
            .instructions
            .iter()
            .filter(|c| k[c.program_id_index as usize] == p)
            .count()
    })
}

/// Logs that lose a whole invocation at an invocation boundary: the
/// message makes one more top-level call of the program (its first program
/// instruction, listed twice) than the logs show. No `Log truncated`
/// marker, and every invocation the logs keep ends, so `IncompleteLogs`'
/// count of `success` lines saw nothing; only the records' chains could
/// notice, and a lost invocation that writes no chained record was a PASS.
#[test]
fn logs_that_lose_a_whole_invocation_are_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        let program = base.cfg.program;
        for t in spread(calls(&base), n) {
            let Ok(mut tx) = fclient::tx::from_wire(&base.txs[t].tx) else {
                continue;
            };
            let k = tx.message.account_keys.clone();
            let Some(first) = tx
                .message
                .instructions
                .iter()
                .find(|c| k[c.program_id_index as usize] == program)
                .cloned()
            else {
                continue;
            };
            tx.message.instructions.push(first);
            let mut inp = base.clone();
            inp.txs[t].tx = fclient::tx::wire(&tx);
            assert_eq!(top_calls(&inp, t), top_calls(&base, t) + 1);
            c.check(&inp, "IncompleteLogs", &format!("{fx} tx#{t}"));
        }
    }
    c.done("whole invocations lost");
}

/// 08 §3's "impossible archive": the program's instructions moved under
/// another program of the message while the logs still show the program at
/// depth 1. The records the logs carry come from instructions the archive
/// does not show; V0 judges none of them. Before this, a PASS (134 of 135
/// in r3's probe).
#[test]
fn logs_that_show_a_call_the_message_does_not_make_are_not_a_pass() {
    let mut c = Count::default();
    for (fx, base, n) in fixtures() {
        let program = base.cfg.program;
        for t in spread(calls(&base), n) {
            let Some(mut inp) = cpi_shaped(&base, t) else {
                continue;
            };
            // Undo the nesting: the program back at depth 1, no wrapper.
            let wrapper_lines = [0, inp.txs[t].logs.len() - 1];
            let logs: Vec<String> = inp.txs[t]
                .logs
                .iter()
                .enumerate()
                .filter(|(i, _)| !wrapper_lines.contains(i))
                .map(|(_, l)| {
                    if *l == format!("Program {program} invoke [2]") {
                        format!("Program {program} invoke [1]")
                    } else {
                        l.clone()
                    }
                })
                .collect();
            inp.txs[t].logs = logs;
            c.check(&inp, "UnexplainedInvocation", &format!("{fx} tx#{t}"));
        }
    }
    c.done("calls the message does not make");
}
