//! V0 / V0E (⑪ r7): the instruction tags and record kinds that workstream 4 allocated
//! to workstreams 2, 20 and 11 (2026-11-06, provisional) are not in this
//! verifier's ABI tables, so a successful transaction that carries one is
//! never a PASS. Each case changes one transaction of a recorded fixture
//! that PASSes (no key is generated, derived or signed: the message is
//! edited in place and the verifier does not check signatures). Also: a
//! record no check judges where it stands is never a PASS (V0E
//! `UnverifiedRecord`); before r7, a DIVERT written into a transaction
//! without a TRANSIT_SETTLED was a PASS (12 of 780 injections).

mod common;

use common::*;
use verify_core::input::Input;
use verify_core::Verdict;

/// ② 0xD0–0xD5, ⑳ 0xE0–0xE2, ⑪ 0xE8–0xED, and 0xFE (reserved for
/// unknown-tag tests).
const NEW_TAGS: &[u8] = &[
    0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xE0, 0xE1, 0xE2, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xFE,
];

/// ② 114–119, ⑳ 130, ⑪ 135–144.
fn new_kinds() -> Vec<u8> {
    (114..=119).chain([130]).chain(135..=144).collect()
}

/// Successful transactions that call the program at top level, with the
/// bell of their first record.
fn calls(inp: &Input) -> Vec<(usize, u32)> {
    let p = inp.cfg.program;
    (0..inp.txs.len())
        .filter_map(|t| {
            let x = &inp.txs[t];
            if x.err.is_some() {
                return None;
            }
            let tx = fclient::tx::from_wire(&x.tx).ok()?;
            let k = &tx.message.account_keys;
            if !tx
                .message
                .instructions
                .iter()
                .any(|c| k[c.program_id_index as usize] == p)
            {
                return None;
            }
            let bodies = fclient::log::bodies_from_logs(&x.logs, &p).ok()?;
            let r = frontier_abi::v2::log::decode(bodies.first()?).ok()?;
            Some((t, r.bell))
        })
        .collect()
}

fn spread<T: Copy>(v: Vec<T>, n: usize) -> Vec<T> {
    if v.len() <= n {
        return v;
    }
    (0..n).map(|i| v[i * v.len() / n]).collect()
}

fn fixtures() -> Vec<(&'static str, Input, usize)> {
    vec![("land", land(), 8), ("march_program", march_program(), 4)]
}

/// A record body of kind `k` (the ABI's widths when it knows `k`, else
/// RESIDENT_JOINED's 15 + 42), no links.
fn body(k: u8, bell: u32) -> Vec<u8> {
    let (kl, pl) = frontier_abi::v2::log::AnyKind::from_u8(k)
        .map(|a| (a.key_len(), a.payload_len()))
        .unwrap_or((15, 42));
    let mut b = vec![frontier_abi::log::VERSION, k];
    b.extend_from_slice(&bell.to_le_bytes());
    b.extend(std::iter::repeat_n(0x5a, kl + pl));
    b.push(0);
    b
}

/// `line` inserted just before the program's last `success` line of tx `t`
/// (inside the top-level frame, so the frame still closes).
fn inject(base: &Input, t: usize, line: String) -> Option<Input> {
    let end = format!("Program {} success", base.cfg.program);
    let at = base.txs[t].logs.iter().rposition(|l| *l == end)?;
    let mut inp = base.clone();
    inp.txs[t].logs.insert(at, line);
    Some(inp)
}

/// The tag of the transaction's first top-level program instruction set
/// to `tag`.
fn retag(base: &Input, t: usize, tag: u8) -> Option<Input> {
    let p = base.cfg.program;
    let mut tx = fclient::tx::from_wire(&base.txs[t].tx).ok()?;
    let keys = tx.message.account_keys.clone();
    let c = tx
        .message
        .instructions
        .iter_mut()
        .find(|c| keys[c.program_id_index as usize] == p && !c.data.is_empty())?;
    c.data[0] = tag;
    let mut inp = base.clone();
    inp.txs[t].tx = fclient::tx::wire(&tx);
    Some(inp)
}

struct Tally {
    cases: usize,
    passed: Vec<String>,
}

impl Tally {
    fn new() -> Self {
        Tally {
            cases: 0,
            passed: vec![],
        }
    }
    fn check(&mut self, inp: &Input, what: String) {
        self.cases += 1;
        let r = verify_core::verify(inp);
        if r.verdict == Verdict::Pass {
            self.passed.push(what);
        }
    }
    fn done(self, name: &str) {
        println!(
            "{name}: {} cases, {} PASS {:?}",
            self.cases,
            self.passed.len(),
            self.passed.iter().take(5).collect::<Vec<_>>()
        );
        assert!(self.cases > 0, "{name}: no case");
        assert!(
            self.passed.is_empty(),
            "{name}: {} of {} cases PASS",
            self.passed.len(),
            self.cases
        );
    }
}

#[test]
fn an_instruction_of_a_new_band_is_not_a_pass() {
    let mut c = Tally::new();
    for (fx, base, n) in fixtures() {
        for (t, _) in spread(calls(&base), n) {
            for &tag in NEW_TAGS {
                if let Some(inp) = retag(&base, t, tag) {
                    c.check(&inp, format!("{fx} tx#{t} tag {tag:#04x}"));
                }
            }
        }
    }
    c.done("new tags");
}

#[test]
fn a_record_of_a_new_kind_is_not_a_pass() {
    let mut c = Tally::new();
    for (fx, base, n) in fixtures() {
        for (t, bell) in spread(calls(&base), n) {
            for k in new_kinds() {
                let line = fclient::log::log_line(&body(k, bell));
                if let Some(inp) = inject(&base, t, line) {
                    c.check(&inp, format!("{fx} tx#{t} kind {k}"));
                }
            }
        }
    }
    c.done("new kinds");
}

/// Every record kind the ABI knows, written into a transaction that did
/// not emit it (no links): the verifier must notice or not PASS.
#[test]
fn a_record_no_instruction_left_is_not_a_pass() {
    let mut c = Tally::new();
    let known: Vec<u8> = (0..=255u8)
        .filter(|&k| frontier_abi::v2::log::AnyKind::from_u8(k).is_some())
        .collect();
    for (fx, base, n) in fixtures() {
        for (t, bell) in spread(calls(&base), n.min(3)) {
            for &k in &known {
                let line = fclient::log::log_line(&body(k, bell));
                if let Some(inp) = inject(&base, t, line) {
                    c.check(&inp, format!("{fx} tx#{t} kind {k}"));
                }
            }
        }
    }
    c.done("known kinds, injected");
}

#[test]
fn a_divert_outside_a_transit_settlement_is_unverifiable() {
    let mut n = 0;
    for (fx, base, k) in fixtures() {
        for (t, bell) in spread(calls(&base), k) {
            let line = fclient::log::log_line(&body(frontier_abi::log::Kind::DIVERT as u8, bell));
            let Some(inp) = inject(&base, t, line) else {
                continue;
            };
            let r = verify_core::verify(&inp);
            assert_ne!(r.verdict, Verdict::Pass, "{fx} tx#{t}");
            if r.verdict == Verdict::Unverifiable {
                assert!(
                    r.findings
                        .iter()
                        .any(|f| f.check == "V0E" && f.code == "UnverifiedRecord"),
                    "{fx} tx#{t}: {}",
                    show(&r)
                );
                n += 1;
            }
        }
    }
    assert!(n > 0, "no DIVERT case reached V0E");
}

/// A conquest kind the ABI adds (⑳'s RESIDENT_JOINED, 130) fails this
/// test until a check models it and `MODELLED_CQ_KINDS` names it; until
/// then V0E reports its records `UnverifiedRecord`.
#[test]
fn every_conquest_kind_the_abi_knows_is_modelled() {
    use verify_core::checks::v0_evidence::MODELLED_CQ_KINDS;
    for k in 0..=255u8 {
        if frontier_abi::v2::log::CqKind::from_u8(k).is_some() {
            assert!(
                MODELLED_CQ_KINDS.contains(&k),
                "conquest kind {k} is not modelled"
            );
        }
    }
    for &k in MODELLED_CQ_KINDS {
        assert!(frontier_abi::v2::log::CqKind::from_u8(k).is_some(), "{k}");
    }
}
