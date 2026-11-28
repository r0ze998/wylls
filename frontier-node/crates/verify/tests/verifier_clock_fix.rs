//! verifier-clock-fix (Q-W3VWS-1 = a): VG takes each transaction's Clock
//! from its own recorded effects, not from the RPC's `blockTime`
//! (`verify_core::genesis::ClockRule`).
//!
//! On devnet the RPC's `blockTime` is sometimes one second above the
//! bank's `Clock.unix_timestamp` the program read (world 3 tx#21: blockTime
//! 1795663037, the program logged 1795663036), and a replay at `blockTime`
//! then logged one differing byte and cascaded into ~900 FAIL findings.
//! fix-verify-clock (Q-WF2-1): once two seconds (world 3 tx#13720, slot
//! 527244500; `fixtures/verify/world3-tx13720-clock.json`), so the
//! candidates are `blockTime − k`, 0 ≤ k ≤ `genesis::CLOCK_LAG_MAX` = 2.
//! These tests take the honest playable-lane recording of
//! `playable_genesis.rs` (made in LiteSVM, where `block_time` IS the Clock),
//! serve it as a public RPC does (no post-states) and move `blockTime` the
//! way devnet does. Key-free; no RPC.
#![cfg(feature = "playable-lane")]

mod common;

use verify_core::input::Input;
use verify_core::{Report, Severity, Verdict};

const FIXTURE: &str = "playable-lane-genesis.json.gz";
const SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";

fn rpc_shaped() -> Input {
    let mut inp = common::fixture(FIXTURE);
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    inp.program_so = Some(std::sync::Arc::new(p.so.as_ref().clone()));
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
                f.detail.chars().take(300).collect::<String>()
            )
        })
        .collect()
}

/// Every transaction's `blockTime` moved by `d` seconds (all of a slot's
/// together: one bank, one time).
fn shifted(d: i64) -> Input {
    let mut inp = rpc_shaped();
    for t in inp.txs.iter_mut() {
        t.block_time += d;
    }
    inp
}

/// The transactions whose re-execution depends on the Clock (their logged
/// records or balances change with it): the honest archive with
/// `blockTime + 1` derives them back to the recorded Clock.
fn clock_sensitive() -> Vec<usize> {
    let honest = rpc_shaped();
    let d = verify_core::genesis::derive(&shifted(1));
    let derived = d.input.expect("VG ran");
    (0..honest.txs.len())
        .filter(|&i| derived.txs[i].block_time == honest.txs[i].block_time)
        .collect()
}

use verify_core::genesis::CLOCK_LAG_MAX;

#[test]
fn the_fixture_is_clock_sensitive() {
    // Deliberate-break baseline: without the rule (a replay at blockTime)
    // the shifted archive is what devnet showed. A Clock three seconds off
    // (one beyond CLOCK_LAG_MAX) is outside the rule and must FAIL exactly
    // as before: no tolerance.
    assert_eq!(CLOCK_LAG_MAX, 2);
    let r = verify_core::verify(&shifted(CLOCK_LAG_MAX + 1));
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    assert!(
        r.findings
            .iter()
            .any(|f| f.fail() && f.check == "VG" && f.code == "ReExecMismatch"),
        "{:#?}",
        show(&r)
    );
    assert!(clock_sensitive().len() >= 3, "{:?}", clock_sensitive());
}

#[test]
fn a_block_time_one_second_above_the_clock_passes_by_the_programs_effects() {
    let honest = verify_core::verify(&rpc_shaped());
    assert_eq!(honest.verdict, Verdict::Pass, "{:#?}", show(&honest));
    // blockTime is the Clock: nothing moves. A stamp nothing the chain
    // recorded decides is still counted (verify-pr266: never passed
    // silently as proven, even when no slot moved).
    for f in honest
        .findings
        .iter()
        .filter(|f| f.code == "ClockFromEffects")
    {
        assert_eq!(f.severity, Severity::Warn);
        assert!(
            f.detail
                .contains(" 0 transaction(s) in 0 slot(s) re-executed")
                && !f.detail.contains("; 0 transaction(s) stamped"),
            "{}",
            f.detail
        );
    }
    let r = verify_core::verify(&shifted(1));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    let w: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.code == "ClockFromEffects")
        .collect();
    assert_eq!(w.len(), 1, "{:#?}", show(&r));
    assert_eq!(w[0].severity, Severity::Warn);
    assert_eq!(w[0].check, "VG");
}

#[test]
fn the_derived_archive_carries_the_clock_the_program_read() {
    // Every slot a Clock-sensitive transaction decides is dated with the
    // recorded Clock for every other check (V3, V7, VX … read it), and its
    // derived post-states are the local node's.
    let rec = common::fixture(FIXTURE);
    let d = verify_core::genesis::derive(&shifted(1));
    assert!(
        d.findings
            .iter()
            .all(|f| f.severity == Severity::Warn && f.code == "ClockFromEffects"),
        "{:?}",
        d.findings.iter().map(|f| &f.detail).collect::<Vec<_>>()
    );
    let derived = d.input.expect("derived");
    let sensitive = clock_sensitive();
    for &i in &sensitive {
        let slot = rec.txs[i].slot;
        for (j, t) in rec.txs.iter().enumerate().filter(|(_, t)| t.slot == slot) {
            assert_eq!(derived.txs[j].block_time, t.block_time, "tx#{j}");
        }
        for (k, acc) in &rec.txs[i].post {
            let got = derived.txs[i].post.iter().find(|(x, _)| x == k);
            assert_eq!(got.map(|(_, s)| s), Some(acc), "tx#{i} {k}");
        }
    }
}

#[test]
fn a_block_time_below_the_clock_is_not_a_candidate() {
    // Devnet showed blockTime = Clock + 1 or + 2 only; blockTime − 1 and
    // − 2 are the other candidates. A Clock above blockTime is never tried.
    let r = verify_core::verify(&shifted(-1));
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    // verify-pr266: VG itself refuses it (a Clock-sensitive transaction no
    // candidate reproduces) and moves no slot to blockTime + 1.
    assert!(
        r.findings
            .iter()
            .any(|f| f.fail() && f.check == "VG" && f.code == "ReExecMismatch"),
        "{:#?}",
        show(&r)
    );
    let d = verify_core::genesis::derive(&shifted(-1));
    let derived = d.input.expect("VG ran");
    let rec = shifted(-1);
    assert!(
        (0..rec.txs.len()).all(|i| derived.txs[i].block_time <= rec.txs[i].block_time),
        "a Clock above blockTime was taken"
    );
}

#[test]
fn one_clock_per_slot() {
    // Two Clock-sensitive transactions one second apart, put in ONE slot
    // with the later one's time as blockTime: the first decides the slot's
    // Clock to be blockTime − 1, and the second, which only blockTime
    // reproduces, is not re-run at another Clock of the same slot: FAIL.
    let s = clock_sensitive();
    let honest = rpc_shaped();
    let pair = s
        .windows(2)
        .find(|w| {
            w[1] == w[0] + 1
                && honest.txs[w[1]].block_time == honest.txs[w[0]].block_time + 1
                && honest.txs[w[0]].err.is_none()
                && honest.txs[w[1]].err.is_none()
        })
        .map(|w| (w[0], w[1]));
    let (a, b) = pair.expect("two consecutive Clock-sensitive transactions one second apart");
    let mut inp = honest.clone();
    inp.txs[a].slot = inp.txs[b].slot;
    inp.txs[a].block_time = inp.txs[b].block_time;
    // (control: each alone in its own slot passes; together they cannot share
    // one Clock)
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Fail, "tx#{a}+tx#{b}: {:#?}", show(&r));
    assert!(
        r.findings
            .iter()
            .any(|f| f.fail() && f.check == "VG" && f.entity == format!("tx#{b}")),
        "{:#?}",
        show(&r)
    );
}

#[test]
fn a_forged_record_still_fails_under_either_clock() {
    // The rule never relaxes a comparison: a forged byte in a record that
    // both candidate Clocks leave identical still FAILs.
    let mut inp = shifted(1);
    let (i, line) = inp
        .txs
        .iter()
        .enumerate()
        .find_map(|(i, t)| {
            t.logs
                .iter()
                .position(|l| l.starts_with("Program data: UFMy"))
                .map(|l| (i, l))
        })
        .expect("a PS2 record");
    let l = &mut inp.txs[i].logs[line];
    let last = l.pop().unwrap();
    l.push(if last == 'A' { 'B' } else { 'A' });
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
}

#[test]
fn a_forged_final_state_still_fails_with_a_moved_clock() {
    // Final states decide a stamped Clock only by exact bytes: a final state
    // neither candidate Clock leaves is a FAIL, as at blockTime.
    let mut inp = shifted(1);
    let program = inp.cfg.program;
    let (k, a) = inp
        .finals
        .iter_mut()
        .find_map(|(k, a)| {
            a.as_mut()
                .filter(|a| a.owner == program && a.data.len() > 200)
                .map(|a| (*k, a))
        })
        .expect("a program account's final state");
    a.data[200] ^= 0x5a;
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Fail, "{k:?}: {:#?}", show(&r));
}

#[test]
fn an_undecided_stamp_is_counted_even_when_no_slot_moved() {
    // verify-pr266: the honest archive (blockTime IS the Clock everywhere)
    // still has stamps nothing the chain recorded decides; each is counted
    // in the WARN, never passed silently as proven.
    let d = verify_core::genesis::derive(&rpc_shaped());
    let open = d
        .findings
        .iter()
        .find(|f| f.code == "ClockFromEffects")
        .map(|f| f.detail.clone());
    let derived = d.input.expect("VG ran");
    let honest = rpc_shaped();
    assert!(
        (0..honest.txs.len()).all(|i| derived.txs[i].block_time == honest.txs[i].block_time),
        "nothing moves"
    );
    // (the fixture stamps undecidable Clocks: the WARN must be there)
    let w = open.expect("the WARN counts the undecided stamps");
    assert!(w.contains(" 0 transaction(s) in 0 slot(s)"), "{w}");
    let n: usize = w
        .split("; ")
        .last()
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse().ok())
        .expect("a count");
    assert!(n > 0, "{w}");
}

fn clock_warn(r: &Report) -> String {
    let w: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.code == "ClockFromEffects")
        .collect();
    assert_eq!(w.len(), 1, "{:#?}", show(r));
    assert_eq!(w[0].severity, Severity::Warn);
    assert_eq!(w[0].check, "VG");
    w[0].detail.clone()
}

#[test]
fn a_block_time_two_seconds_above_the_clock_passes_by_the_programs_effects() {
    // fix-verify-clock: world 3 tx#13720 (blockTime 1795872970, the program
    // stamped 1795872968).
    let r = verify_core::verify(&shifted(2));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    let w = clock_warn(&r);
    assert!(w.contains("re-executed at blockTime − 2 ("), "{w}");
    assert!(!w.contains("blockTime − 1"), "{w}");
    // every Clock-sensitive slot is dated with the recorded Clock again
    let rec = common::fixture(FIXTURE);
    let derived = verify_core::genesis::derive(&shifted(2))
        .input
        .expect("VG ran");
    for i in clock_sensitive() {
        assert_eq!(derived.txs[i].block_time, rec.txs[i].block_time, "tx#{i}");
    }
}

#[test]
fn the_one_second_warn_text_is_unchanged() {
    // The earlier WARN wording stays byte-for-byte when every moved slot
    // moved by one second (the watch's earlier reports stay comparable).
    let w = clock_warn(&verify_core::verify(&shifted(1)));
    assert!(
        w.contains("slot(s) re-executed at blockTime − 1, the only Clock"),
        "{w}"
    );
    assert!(w.ends_with(": taken at blockTime"), "{w}");
}

#[test]
fn slots_one_and_two_seconds_behind_in_one_archive_pass() {
    // Each slot has its own Clock: some one second, some two behind.
    let mut inp = rpc_shaped();
    let slots: Vec<u64> = {
        let mut v: Vec<u64> = inp.txs.iter().map(|t| t.slot).collect();
        v.dedup();
        v
    };
    for t in inp.txs.iter_mut() {
        let n = slots.iter().position(|s| *s == t.slot).unwrap();
        t.block_time += if n % 2 == 0 { 1 } else { 2 };
    }
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    let w = clock_warn(&r);
    assert!(
        w.contains("blockTime − 1 (") && w.contains(" or blockTime − 2 ("),
        "{w}"
    );
}

/// The first Clock-sensitive transaction that logs PS2 records carrying its
/// Clock (tx#13720's kind) and is the only transaction of its slot.
fn lone_anchor_post(inp: &Input) -> usize {
    clock_sensitive()
        .into_iter()
        .find(|&i| {
            let t = &inp.txs[i];
            // (like tx#13720's, its PS2 records carry the Clock)
            t.err.is_none()
                && t.logs.iter().any(|l| {
                    l.strip_prefix("Program data: ")
                        .filter(|d| d.starts_with("UFMy"))
                        .map(|d| {
                            use base64::Engine as _;
                            let raw: Vec<u8> = d
                                .split(' ')
                                .flat_map(|x| {
                                    base64::engine::general_purpose::STANDARD
                                        .decode(x)
                                        .unwrap_or_default()
                                })
                                .collect();
                            raw.windows(8).any(|w| w == t.block_time.to_le_bytes())
                        })
                        .unwrap_or(false)
                })
                && inp.txs.iter().filter(|u| u.slot == t.slot).count() == 1
        })
        .expect("a lone PS2 transaction in its slot")
}

#[test]
fn tx13720_shape_a_lone_anchor_post_two_seconds_behind() {
    // Regression (world 3 tx#13720): one anchor post alone in its slot, its
    // blockTime two seconds above the Clock it stamped, every other slot
    // exact. Before the fix: VG ReExecMismatch (log line), CQ1/VG final
    // anchor data, V3 SeedRoundRule. Now: PASS, dated at the stamped Clock.
    let honest = rpc_shaped();
    let i = lone_anchor_post(&honest);
    let at = |d: i64| {
        let mut inp = honest.clone();
        inp.txs[i].block_time += d;
        inp
    };
    let r = verify_core::verify(&at(2));
    assert_eq!(r.verdict, Verdict::Pass, "tx#{i}: {:#?}", show(&r));
    assert!(
        !r.findings
            .iter()
            .any(|f| f.code == "SeedRoundRule" || f.fail()),
        "{:#?}",
        show(&r)
    );
    let w = clock_warn(&r);
    assert!(
        w.contains("1 transaction(s) in 1 slot(s) re-executed at blockTime − 2 (1 in 1 slot(s))"),
        "{w}"
    );
    let derived = verify_core::genesis::derive(&at(2)).input.expect("VG ran");
    assert_eq!(derived.txs[i].block_time, honest.txs[i].block_time);
    // one second further is outside the window: the same FAIL as before
    let r = verify_core::verify(&at(CLOCK_LAG_MAX + 1));
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    assert!(
        r.findings.iter().any(|f| f.fail()
            && f.check == "VG"
            && f.code == "ReExecMismatch"
            && f.entity == format!("tx#{i}")),
        "{:#?}",
        show(&r)
    );
}

#[test]
fn the_devnet_evidence_is_two_seconds_and_the_window_is_no_wider() {
    // `fixtures/verify/world3-tx13720-clock.json`: the chain's own record of
    // tx#13720. Every PS2 record and every anchor it wrote carry
    // blockTime − 2, none blockTime or blockTime − 1: the lag was 2, and
    // CLOCK_LAG_MAX is exactly the largest lag the chain showed.
    use base64::Engine as _;
    let p = common::fixtures_dir().join("world3-tx13720-clock.json");
    let j: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&p).expect("fixture")).expect("json");
    let bt = j["block_time"].as_i64().unwrap();
    let slot = j["slot"].as_u64().unwrap();
    assert_eq!((bt, slot), (1795872970, 527244500));
    let b64 = base64::engine::general_purpose::STANDARD;
    let has = |raw: &[u8], t: i64| raw.windows(8).any(|w| w == t.to_le_bytes());
    let mut records = 0;
    for l in j["logs"].as_array().unwrap() {
        let Some(d) = l.as_str().unwrap().strip_prefix("Program data: ") else {
            continue;
        };
        let raw: Vec<u8> = d
            .split(' ')
            .flat_map(|x| b64.decode(x).expect("base64"))
            .collect();
        if raw.starts_with(b"PS2") {
            records += 1;
            assert!(has(&raw, bt - 2), "{l}");
            assert!(!has(&raw, bt) && !has(&raw, bt - 1), "{l}");
        }
    }
    assert_eq!(records, 7);
    let anchors = j["anchor_finals"].as_array().unwrap();
    assert_eq!(anchors.len(), 7);
    let mut lag = 0;
    for a in anchors {
        let raw = b64.decode(a["data_base64"].as_str().unwrap()).unwrap();
        assert_eq!(&raw[..8], b"PSF1ANCH");
        let t = i64::from_le_bytes(raw[32..40].try_into().unwrap());
        let s = u64::from_le_bytes(raw[40..48].try_into().unwrap());
        assert_eq!(s, slot);
        lag = lag.max(bt - t);
    }
    assert_eq!(lag, 2);
    assert_eq!(
        CLOCK_LAG_MAX, lag,
        "the window is the chain's evidence, no wider"
    );
}
