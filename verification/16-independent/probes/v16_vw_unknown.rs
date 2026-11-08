//! ⑯ independent check of VW1 (verify/src/checks/vw_chains.rs, ④ 4ecef1d9 on af41e617): a wide season stays
//! UNVERIFIABLE (never PASS), and what a gap in an unproven history does to a wide chain.
//! Keyless: PSW1 bodies are built with the ABI's own encoder over literal bytes; nothing is signed or derived.
//! Run: cargo test -p verify --features wide-world-experimental --test v16_vw_unknown
#![cfg(feature = "wide-world-experimental")]
use base64::Engine;
use frontier_abi::world_index::coord::WideCoord;
use frontier_abi::world_index::event::{advance, encode, write_body, WideEntity, WideKind, MAX_BODY, WIDE_LOG_PREFIX};
use frontier_abi::world_index::key::{ProvinceKey, WorldId};
use verify_core::checks::vw_chains::{judge, Judgement, WIDE_CHAIN_BROKEN, WIDE_CHAIN_UNPROVEN, WIDE_UNMODELLED};

/// One program frame per record; `keep` selects which of the chain's records (by index) appear in the logs.
fn logs(n: u32, keep: &[usize], other_program_for: &[usize]) -> Vec<String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let key = ProvinceKey::new(WorldId::new([3; 32]).unwrap(), WideCoord::checked(130, 0).unwrap()).to_bytes();
    let (mut seq, mut head) = (0u64, [0u8; 32]);
    let mut out = vec![];
    for i in 0..n as usize {
        let bell = 20 + i as u32;
        let payload = vec![bell as u8; WideKind::Resolve.payload_len()];
        let mut buf = vec![0u8; MAX_BODY];
        let len = write_body(WideKind::Resolve, bell, &key, &payload, &mut buf).unwrap();
        let l = advance(WideEntity::Province, seq, &head, &buf[..len]).unwrap();
        (seq, head) = (l.seq, l.head);
        let rec = encode(WideKind::Resolve, bell, &key, &payload, &[l]).unwrap();
        if !keep.contains(&i) {
            continue;
        }
        let prog = if other_program_for.contains(&i) { "Q" } else { "P" };
        out.push(format!("Program {prog} invoke [1]"));
        out.push(format!("Program data: {} {}", b64.encode(WIDE_LOG_PREFIX), b64.encode(&rec)));
        out.push(format!("Program {prog} success"));
    }
    out
}

fn codes(j: &[Judgement]) -> Vec<(&'static str, &'static str)> {
    j.iter()
        .map(|x| match x {
            Judgement::Fail { code, .. } => ("FAIL", *code),
            Judgement::Unverifiable { code, .. } => ("UNVERIFIABLE", *code),
        })
        .collect()
}

#[test]
fn w1_a_whole_consistent_chain_is_still_never_pass() {
    let l = logs(3, &[0, 1, 2], &[]);
    for whole in [true, false] {
        let j = judge("P", &[(0, true, &l)], &[], whole);
        assert!(!j.iter().any(|x| matches!(x, Judgement::Fail { .. })), "{:?}", codes(&j));
        assert!(matches!(j.last(), Some(Judgement::Unverifiable { code: WIDE_UNMODELLED, .. })), "{:?}", codes(&j));
    }
}

#[test]
fn w2_records_seen_from_the_middle_of_an_unproven_history_are_unverifiable() {
    // The node pruned the first record (an RPC history gap at the start): the chain is taken from its first link.
    let l = logs(3, &[1, 2], &[]);
    let j = judge("P", &[(0, true, &l)], &[], false);
    assert!(!j.iter().any(|x| matches!(x, Judgement::Fail { .. })), "{:?}", codes(&j));
    assert!(j.iter().any(|x| matches!(x, Judgement::Unverifiable { code: WIDE_CHAIN_UNPROVEN, .. })), "{:?}", codes(&j));
}

#[test]
fn w3_a_record_missing_in_the_middle_of_an_unproven_history() {
    // Records 0 and 2 seen, 1 lost to a gap; the history is NOT shown whole. Recorded, then asserted only as
    // "never PASS": whether this should be FAIL (a broken chain) or UNVERIFIABLE (a gap) is the owner's rule.
    let l = logs(3, &[0, 2], &[]);
    let unproven = judge("P", &[(0, true, &l)], &[], false);
    let whole = judge("P", &[(0, true, &l)], &[], true);
    println!("w3 unproven history: {:?}", codes(&unproven));
    println!("w3 whole history:    {:?}", codes(&whole));
    assert!(!unproven.is_empty() && !whole.is_empty(), "never silent");
    assert!(whole.iter().any(|x| matches!(x, Judgement::Fail { code: WIDE_CHAIN_BROKEN, .. })), "a whole history with a hole is broken");
}

#[test]
fn w4_records_inside_another_programs_frame_or_a_failed_transaction_are_not_records() {
    let l = logs(2, &[0, 1], &[0, 1]);
    assert!(judge("P", &[(0, true, &l)], &[], true).is_empty(), "another program's lines are not this program's records");
    let l = logs(2, &[0, 1], &[]);
    assert!(judge("P", &[(0, false, &l)], &[], true).is_empty(), "a failed transaction's lines are not records");
    // One good and one failed transaction: the good one's record still makes the season UNVERIFIABLE.
    let a = logs(1, &[0], &[]);
    let j = judge("P", &[(0, true, &a), (1, false, &a)], &[], true);
    assert!(matches!(j.last(), Some(Judgement::Unverifiable { code: WIDE_UNMODELLED, .. })), "{:?}", codes(&j));
}

#[test]
fn w5_a_gap_in_an_unproven_history_is_unverifiable_not_a_fail_and_a_wrong_head_still_fails() {
    // ⑯'s rule check (④ fixed it in b3d08978): a record missing in the middle of an unproven history is a gap,
    // UNVERIFIABLE; the same gap in a whole history is a FAIL. Expected to FAIL on af41e617 (the defect).
    let l = logs(3, &[0, 2], &[]);
    let unproven = judge("P", &[(0, true, &l)], &[], false);
    assert!(!unproven.iter().any(|x| matches!(x, Judgement::Fail { .. })), "{:?}", codes(&unproven));
    assert!(unproven.iter().any(|x| matches!(x, Judgement::Unverifiable { code: WIDE_CHAIN_UNPROVEN, .. })), "{:?}", codes(&unproven));
    let whole = judge("P", &[(0, true, &l)], &[], true);
    assert!(whole.iter().any(|x| matches!(x, Judgement::Fail { code: WIDE_CHAIN_BROKEN, .. })), "{:?}", codes(&whole));
    // A link that follows its predecessor in sequence but with another head is a forgery whatever the history.
    let mut t = logs(2, &[0, 1], &[]);
    let b64 = base64::engine::general_purpose::STANDARD;
    let last = t.iter().rposition(|x| x.starts_with("Program data: ")).unwrap();
    let parts: Vec<String> = t[last]["Program data: ".len()..].split(' ').map(String::from).collect();
    let mut rec = b64.decode(&parts[1]).unwrap();
    let n = rec.len();
    rec[n - 1] ^= 1; // flip a byte of the record's link (its tail)
    t[last] = format!("Program data: {} {}", parts[0], b64.encode(&rec));
    for whole in [false, true] {
        let j = judge("P", &[(0, true, &t)], &[], whole);
        assert!(j.iter().any(|x| matches!(x, Judgement::Fail { .. })), "whole={whole}: {:?}", codes(&j));
    }
}
