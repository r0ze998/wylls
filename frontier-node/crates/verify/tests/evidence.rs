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
