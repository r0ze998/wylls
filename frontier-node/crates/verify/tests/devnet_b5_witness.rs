//! B5 (read-only devnet run, 2026-11-21): VS's judgement over a REAL
//! devnet history, read by `frontier-verify --rpc P --witness W --balances
//! --save` (`fixtures/verify/devnet-b5-lending-witness.json.gz`): the SPL
//! Token Lending program `LendZqTs…` (not ours), its whole history of 4
//! transactions (slots 127,444,349–263,528,732, 2 of them failed), read
//! from api.devnet.solana.com behind two loopback guard ports (one storage:
//! the data shapes and the judgement are real, the independence is not).
//! The live variants are in reports/devnet-readonly-rpc.md.
//!
//!   W1 the read as recorded: VS agrees (no finding), failed ones included
//!   W2 a witness whose list stops early (a pruned or truncated history):
//!      UNVERIFIABLE, `WitnessUnknownTx` per missing one
//!   W3 a witness missing one listed signature: UNVERIFIABLE
//!   W4 a witness with the shape OnFinality's public devnet RPC gave (7 days
//!      of ledger: an empty list, nothing served, `getBlock` -32001 "cleaned
//!      up"): UNVERIFIABLE, never agreeing
//!   W5 the primary's own endpoint as the witness: not a second source

mod common;

use verify_core::codes::{WITNESS_UNAVAILABLE, WITNESS_UNKNOWN_TX};
use verify_core::input::Input;
use verify_core::witness::judge;

fn real() -> Input {
    common::fixture("devnet-b5-lending-witness.json.gz")
}

fn codes(inp: &Input) -> Vec<String> {
    judge(inp).0.into_iter().map(|f| f.code).collect()
}

fn count(c: &[String], code: &str) -> usize {
    c.iter().filter(|x| x.as_str() == code).count()
}

#[test]
fn w1_the_recorded_devnet_read_agrees() {
    let inp = real();
    assert_eq!(inp.txs.len(), 4);
    assert_eq!(inp.txs.iter().filter(|t| t.err.is_some()).count(), 2);
    let cross = inp.chain.cross.as_ref().expect("a cross-check");
    let w = &cross.witnesses[0];
    assert_eq!(w.signatures.as_ref().map(Vec::len), Some(4));
    assert_eq!(
        w.signatures
            .as_ref()
            .unwrap()
            .iter()
            .filter(|s| s.2)
            .count(),
        2
    );
    assert_eq!(w.blocks.values().filter(|b| b.is_some()).count(), 4);
    assert!(w.errors.is_empty() && cross.primary.errors.is_empty());
    let (f, o) = judge(&inp);
    assert!(f.is_empty(), "{f:?}");
    let o = o.unwrap();
    assert!(o.agrees);
    assert_eq!((o.transactions, o.blocks), (4, 4));
}

#[test]
fn w2_a_truncated_witness_list_is_unverifiable() {
    let mut inp = real();
    let w = &mut inp.chain.cross.as_mut().unwrap().witnesses[0];
    // Newest first: drop the two oldest (a history pruned below a slot).
    w.signatures.as_mut().unwrap().truncate(2);
    let c = codes(&inp);
    assert_eq!(count(&c, WITNESS_UNKNOWN_TX), 2, "{c:?}");
    assert!(!judge(&inp).1.unwrap().agrees);
}

#[test]
fn w3_a_witness_missing_one_signature_is_unverifiable() {
    let mut inp = real();
    let w = &mut inp.chain.cross.as_mut().unwrap().witnesses[0];
    w.signatures.as_mut().unwrap().remove(1);
    let c = codes(&inp);
    assert_eq!(count(&c, WITNESS_UNKNOWN_TX), 1, "{c:?}");
    assert!(!judge(&inp).1.unwrap().agrees);
}

#[test]
fn w4_a_seven_day_witness_is_unverifiable() {
    let mut inp = real();
    let slots: Vec<u64> = inp.txs.iter().map(|t| t.slot).collect();
    let w = &mut inp.chain.cross.as_mut().unwrap().witnesses[0];
    w.signatures = Some(vec![]);
    for t in w.txs.values_mut() {
        *t = None;
    }
    for (s, b) in w.blocks.iter_mut() {
        *b = None;
        w.errors.push(format!(
            "getBlock {s}: Rpc {{ code: -32001, message: \"Block {s} cleaned up, does not exist on node. First available block: 522839987\" }}"
        ));
    }
    assert_eq!(w.blocks.len(), slots.len());
    let (f, o) = judge(&inp);
    let c: Vec<String> = f.into_iter().map(|f| f.code).collect();
    assert!(count(&c, WITNESS_UNAVAILABLE) >= slots.len(), "{c:?}");
    assert_eq!(count(&c, WITNESS_UNKNOWN_TX), 4, "{c:?}");
    assert!(!o.unwrap().agrees);
}

#[test]
fn w5_the_primary_as_its_own_witness_is_not_a_second_source() {
    let mut inp = real();
    let cross = inp.chain.cross.as_mut().unwrap();
    cross.witnesses[0].url = cross.primary.url.clone();
    let c = codes(&inp);
    assert!(c.iter().any(|x| x == WITNESS_UNAVAILABLE), "{c:?}");
}
