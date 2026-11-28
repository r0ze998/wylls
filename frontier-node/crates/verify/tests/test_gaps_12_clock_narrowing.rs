//! test-gaps-12 (#326 fix-verify-clock, verify-pr326 M1): an undecided
//! slot's possible Clocks bind every later transaction of the slot.
//!
//! fix-verify-clock widened VG's Clock candidates to `blockTime − k`,
//! 0 ≤ k ≤ `genesis::CLOCK_LAG_MAX` (2), and keeps, per undecided slot, the
//! Clocks every transaction of it so far reproduces at (`sets` in
//! `genesis::derive_pass`). A later transaction of the slot is run at those
//! Clocks only. verify-pr326 M1 took that narrowing out (the later
//! transaction run at all three candidates again) and no committed test
//! failed: the playable fixture has no transaction that reproduces at
//! exactly two of the three candidates. test-gaps-12 searched for one: in
//! playable-lane-genesis, single transactions' Clock bands and every pair
//! moved into one slot; in eight VG fixtures (genesis-6960, expedition-whole,
//! territory-whole, cov-camp, cov-closes, cov-failure, cov-forfeit and part
//! of cov-retained) contiguous ranges of up to six transactions merged into
//! one slot. 185 slot merges FAIL VG, and every one of them FAILs the same
//! way under M1.
//!
//! So this file uses world 3's own record: the verify-watch snapshot of
//! watch-fail-investigate cut after tx#1285
//! (`fixtures/verify/world3-cut-1285-clock.json.gz`, 593 KB; public devnet
//! chain data, the cut and its provenance are in the file). There tx#1284
//! (slot 526422138, blockTime 1795675260) sits on a bell boundary: it
//! reproduces at blockTime − 1 and − 2 only. tx#1285 (the next slot, the
//! same blockTime) reproduces at blockTime only. verify-pr326's synthetic
//! case puts tx#1285 into tx#1284's slot: one bank cannot have run them
//! both, and VG must FAIL at tx#1285. Under M1 VG accepted it (only VX
//! caught it later).
//!
//! #326 is not merged when this file lands (owner question Q-WF2-1). Before
//! it, VG has two candidates and no per-slot sets; the M1 test then says
//! SKIPPED and returns. It runs as soon as `CLOCK_LAG_MAX` is in
//! `src/genesis.rs` (the marker survives M1, so M1 still FAILs it). The
//! fixture-shape test runs always.
//!
//! Key-free: recorded transactions, the committed `.so`, no RPC, nothing
//! signed.
#![cfg(feature = "playable-lane")]

mod common;

use verify_core::input::Input;
use verify_core::Severity;

const CUT: &str = "world3-cut-1285-clock.json.gz";
const SO_GZ: &str = "devnet-playable-245ce1ab.so.gz";
/// The bell-boundary transaction (reproduces at blockTime − 1 and − 2 only).
const A: usize = 1284;
/// The next transaction (reproduces at blockTime only).
const B: usize = 1285;
const BLOCK_TIME: i64 = 1795675260;

/// fix-verify-clock (#326) is in the tree: its window constant is. (Not the
/// narrowing line itself: taking that out is what the test must catch.)
fn narrowing_present() -> bool {
    include_str!("../src/genesis.rs").contains("pub const CLOCK_LAG_MAX")
}

fn cut() -> Input {
    let mut inp = common::fixture(CUT);
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(
        Some(p.sha256()),
        inp.cfg.program_hash,
        "the cut pins the .so it was judged with"
    );
    inp.program_so = Some(std::sync::Arc::new(p.so.as_ref().clone()));
    inp
}

fn vg_fails(d: &verify_core::genesis::Derived) -> Vec<String> {
    d.findings
        .iter()
        .filter(|f| f.fail())
        .map(|f| {
            format!(
                "{} {} {}",
                f.entity,
                f.code,
                f.detail.chars().take(160).collect::<String>()
            )
        })
        .collect()
}

#[test]
fn the_cut_is_world_3s_record_around_the_bell_boundary() {
    // (runs with or without #326: the input this file's other test reads)
    let inp = common::fixture(CUT);
    assert_eq!(inp.txs.len(), B + 1);
    assert!(
        inp.finals.is_empty(),
        "finals dropped (the snapshot's are of a later slot)"
    );
    assert!(
        inp.txs.iter().all(|t| t.post.is_empty()),
        "RPC-shaped: VG applies"
    );
    assert!(verify_core::genesis::applies(&inp));
    let (a, b) = (&inp.txs[A], &inp.txs[B]);
    assert_eq!((a.slot, a.block_time, a.seq), (526422138, BLOCK_TIME, 1293));
    assert_eq!((b.slot, b.block_time, b.seq), (526422140, BLOCK_TIME, 1294));
    assert!(a.err.is_none() && b.err.is_none());
    assert_eq!(
        a.signature.to_string(),
        "Boucnji1TKAMYn2ksyXApNb6PFrVzT6R4qDDw5nbigZuiuM4LZ2URe8LZm2pntwFbW2iTRfYCVkbbL2RyAYyfLF",
        "tx#1284 of the snapshot"
    );
}

#[test]
fn a_slots_narrowed_clocks_bind_its_later_transactions() {
    if !narrowing_present() {
        eprintln!(
            "SKIPPED: fix-verify-clock (#326, held on Q-WF2-1) is not in src/genesis.rs \
             (no CLOCK_LAG_MAX): VG has no per-slot Clock sets to test yet"
        );
        return;
    }
    let honest = cut();
    // The honest record: tx#1284 alone in its slot reproduces at
    // blockTime − 1 and − 2 only, and is dated at the nearest (− 1); tx#1285
    // is at blockTime. No VG FAIL.
    let d = verify_core::genesis::derive(&honest);
    assert!(vg_fails(&d).is_empty(), "{:#?}", vg_fails(&d));
    let w: Vec<&str> = d
        .findings
        .iter()
        .filter(|f| f.code == "ClockFromEffects")
        .map(|f| f.detail.as_str())
        .collect();
    assert_eq!(w.len(), 1, "{w:?}");
    assert_eq!(
        d.findings
            .iter()
            .find(|f| f.code == "ClockFromEffects")
            .unwrap()
            .severity,
        Severity::Warn
    );
    assert!(
        w[0].contains("1 transaction(s) in 1 of those slot(s) reproduce at more than one Clock below blockTime and at no other"),
        "tx#1284's slot is the one narrowed to {{blockTime − 1, − 2}}: {}",
        w[0]
    );
    let derived = d.input.expect("VG ran");
    assert_eq!(derived.txs[A].block_time, BLOCK_TIME - 1);
    assert_eq!(derived.txs[B].block_time, BLOCK_TIME);

    // tx#1285 in tx#1284's slot (verify-pr326 §2): tx#1284 leaves the slot
    // {blockTime − 1, − 2}; tx#1285 reproduces at neither. One bank, one
    // Clock: VG FAILs at tx#1285. (M1, tx#1285 re-run at all three
    // candidates: no VG FAIL, both dated at blockTime.)
    let mut merged = honest.clone();
    merged.txs[B].slot = honest.txs[A].slot;
    let d = verify_core::genesis::derive(&merged);
    let fails = vg_fails(&d);
    assert!(
        fails.iter().any(|f| f.starts_with(&format!(
            "tx#{B} ReExecMismatch the program's log lines differ"
        ))),
        "VG must refuse tx#{B} at the slot's Clocks: {fails:#?}"
    );
    assert!(
        fails.iter().all(|f| !f.starts_with(&format!("tx#{A} "))),
        "tx#{A} itself reproduces: {fails:#?}"
    );
    let derived = d.input.expect("VG ran");
    assert_eq!(
        derived.txs[A].block_time,
        BLOCK_TIME - 1,
        "the slot is not dated at blockTime, which tx#1284 does not reproduce at"
    );
}
