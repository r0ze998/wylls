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

/// A conquest kind the ABI adds fails this test until a check models it
/// and `MODELLED_CQ_KINDS` names it (or `CONDITIONAL_CQ_KINDS`, judged only
/// beside the instruction that emits it); until then V0E reports its
/// records `UnverifiedRecord`.
#[test]
fn every_conquest_kind_the_abi_knows_is_modelled() {
    use verify_core::checks::v0_evidence::{
        CONDITIONAL_CQ_KINDS, GUARDED_CQ_KINDS, MODELLED_CQ_KINDS,
    };
    for k in 0..=255u8 {
        if frontier_abi::v2::log::CqKind::from_u8(k).is_some() {
            assert!(
                MODELLED_CQ_KINDS.contains(&k)
                    || CONDITIONAL_CQ_KINDS.contains(&k)
                    || GUARDED_CQ_KINDS.contains(&k),
                "conquest kind {k} is not modelled"
            );
        }
    }
    for &k in MODELLED_CQ_KINDS
        .iter()
        .chain(CONDITIONAL_CQ_KINDS)
        .chain(GUARDED_CQ_KINDS)
    {
        assert!(frontier_abi::v2::log::CqKind::from_u8(k).is_some(), "{k}");
    }
    // A guarded kind is never also modelled: V0E keeps reporting its records.
    for k in GUARDED_CQ_KINDS {
        assert!(
            !MODELLED_CQ_KINDS.contains(k) && !CONDITIONAL_CQ_KINDS.contains(k),
            "{k}"
        );
    }
}

/// A well-formed RESIDENT_JOINED (⑳, kind 130: key = the asset's resident
/// ID, a SHA-256 of a literal asset id; no key is generated or signed).
fn resident_joined(bell: u32, faction: u8, generation: u32) -> Vec<u8> {
    let asset = [0x5a; 32];
    let mut b = vec![frontier_abi::log::VERSION, 130];
    b.extend_from_slice(&bell.to_le_bytes());
    b.extend_from_slice(&frontier_abi::resident_citizen::resident_tag15(&asset));
    b.extend_from_slice(&asset);
    b.extend_from_slice(&[faction, 0]);
    b.extend_from_slice(&generation.to_le_bytes());
    b.extend_from_slice(&bell.to_le_bytes());
    b.push(0);
    assert!(frontier_abi::v2::log::decode(&b).is_ok());
    b
}

/// The first top-level program instruction's data set to `data`.
fn redata(base: &Input, t: usize, data: Vec<u8>) -> Option<Input> {
    let p = base.cfg.program;
    let mut tx = fclient::tx::from_wire(&base.txs[t].tx).ok()?;
    let keys = tx.message.account_keys.clone();
    let c = tx
        .message
        .instructions
        .iter_mut()
        .find(|c| keys[c.program_id_index as usize] == p)?;
    c.data = data;
    let mut inp = base.clone();
    inp.txs[t].tx = fclient::tx::wire(&tx);
    Some(inp)
}

fn unverified_records(r: &verify_core::Report) -> usize {
    r.findings
        .iter()
        .filter(|f| f.check == "V0E" && f.code == "UnverifiedRecord")
        .count()
}

/// RESIDENT_JOINED is judged only beside a JoinResident that names its
/// generation and faction; elsewhere, or not matching, it is
/// `UnverifiedRecord`, and never a PASS.
#[test]
fn a_resident_joined_without_its_join_is_unverifiable() {
    use frontier_abi::resident_wire::JOIN_RESIDENT;
    let base = land();
    let mut n = 0;
    for (t, bell) in spread(calls(&base), 6) {
        let line = |g: u32, f: u8| fclient::log::log_line(&resident_joined(bell, f, g));
        // In a transaction that did not join anyone.
        let lone = inject(&base, t, line(7, 2)).expect("frame");
        let r = verify_core::verify(&lone);
        assert_ne!(r.verdict, Verdict::Pass, "tx#{t}");
        assert_eq!(unverified_records(&r), 1, "tx#{t}: {}", show(&r));
        // Beside a JoinResident of another generation or faction.
        for (g, f) in [(8u32, 2u8), (7, 1)] {
            let mut d = vec![JOIN_RESIDENT];
            d.extend_from_slice(&g.to_le_bytes());
            d.push(f);
            let inp = redata(&inject(&base, t, line(7, 2)).unwrap(), t, d).unwrap();
            let r = verify_core::verify(&inp);
            assert_ne!(r.verdict, Verdict::Pass, "tx#{t}");
            assert_eq!(unverified_records(&r), 1, "tx#{t} ({g}, {f}): {}", show(&r));
        }
        // Beside its own JoinResident: V0E leaves it to V0 (which judges
        // the instruction), V9 and V12; still not a PASS here.
        let mut d = vec![JOIN_RESIDENT];
        d.extend_from_slice(&7u32.to_le_bytes());
        d.push(2);
        let inp = redata(&inject(&base, t, line(7, 2)).unwrap(), t, d).unwrap();
        let r = verify_core::verify(&inp);
        assert_ne!(r.verdict, Verdict::Pass, "tx#{t}");
        assert_eq!(unverified_records(&r), 0, "tx#{t}: {}", show(&r));
        n += 1;
    }
    assert!(n > 0);
}

/// V0 (⑪ r9): a tag outside ABI v2 is judged by who may run it. In ⑳'s
/// NFT program's seasons JoinResident is modelled (V27) and the other
/// resident commands are UNVERIFIABLE; under a program version this
/// verifier knows, an allocated tag it does not run is a FAIL naming its
/// band (②'s Grant included: no known program runs it); under an unknown
/// version, an allocated tag is UNVERIFIABLE (that program may run ②'s
/// Grant legitimately), and an unallocated one a FAIL.
#[test]
fn tags_outside_abi_v2_are_told_apart() {
    use verify_core::checks::v0_coverage::{judge_outside_v2, PROGRAM_VERSION_NFT_S1};
    use verify_core::Severity::{Fail, Unverifiable};
    let nft = Some(PROGRAM_VERSION_NFT_S1);
    let s1 = Some(4u16);
    let unknown = Some(9u16);
    let join = [0xE1, 3, 0, 0, 0, 4];
    let j = |tag: u8, data: &[u8], pv| judge_outside_v2(tag, data, pv, true).map(|x| (x.0, x.1));
    // ⑳ in its own program's season.
    assert_eq!(j(0xE1, &join, nft), None);
    // ⑱: the same join where the S1 checks (V27) did not run is Unverifiable.
    assert_eq!(
        judge_outside_v2(0xE1, &join, nft, false).map(|x| (x.0, x.1)),
        Some((Unverifiable, "UnverifiedInstruction"))
    );
    assert_eq!(j(0xE1, &join[..5], nft), Some((Fail, "Undecodable")));
    // ResidentAct (r14): an inner instruction the act runs (Harvest 0x40) is
    // left to V28 and the inner check where V28 runs (s1); not where it
    // does not, nor for an inner tag the act refuses (CreateSeason 0x01,
    // SetSession 0x31).
    assert_eq!(
        j(0xE2, &[0xE2, 0, 0, 0, 0, 0x01], nft),
        Some((Unverifiable, "UnverifiedInstruction"))
    );
    assert_eq!(
        j(0xE2, &[0xE2, 0, 0, 0, 0, 0x31], nft),
        Some((Unverifiable, "UnverifiedInstruction"))
    );
    assert_eq!(
        judge_outside_v2(0xE2, &[0xE2, 0, 0, 0, 0, 0x40], nft, true),
        None
    );
    assert!(matches!(
        judge_outside_v2(0xE2, &[0xE2, 0, 0, 0, 0, 0x40], nft, false),
        Some((Unverifiable, "UnverifiedInstruction", _))
    ));
    // Outside the NFT program's seasons, a known program refuses it.
    assert_eq!(
        j(0xE2, &[0xE2, 0, 0, 0, 0, 0x40], s1).map(|x| x.0),
        Some(Fail)
    );
    assert_eq!(
        j(0xE0, &[0xE0; 129], nft),
        Some((Unverifiable, "UnverifiedInstruction"))
    );
    // ⑳ under S1's program, which refuses it.
    let r = judge_outside_v2(0xE1, &join, s1, true).unwrap();
    assert_eq!((r.0, r.1), (Fail, "UnknownInstruction"));
    assert!(r.2.contains("workstream 20"), "{}", r.2);
    // ②'s Grant: refused by every known program (FAIL, named), possibly
    // legitimate under a version this verifier does not know.
    for tag in 0xD0..=0xD5u8 {
        for pv in [s1, nft] {
            let r = judge_outside_v2(tag, &[tag, 0, 0], pv, true).unwrap();
            assert_eq!((r.0, r.1), (Fail, "UnknownInstruction"));
            assert!(r.2.contains("workstream 2 "), "{}", r.2);
        }
        for pv in [unknown, None] {
            assert_eq!(
                j(tag, &[tag], pv),
                Some((Unverifiable, "UnverifiedInstruction"))
            );
        }
    }
    // Unallocated tags (the wide-world draft 0xD6–0xDA included) fail under
    // every version this verifier knows; under another, or none shown, they
    // are UNVERIFIABLE (r13): only a known program is evidence of refusal.
    for tag in [0xD6, 0xDA, 0xEE, 0xFE] {
        for pv in [unknown, None, Some(0x4004)] {
            assert_eq!(
                j(tag, &[tag], pv),
                Some((Unverifiable, "UnverifiedInstruction")),
                "{tag:#x} {pv:?}"
            );
        }
        for pv in [s1, nft] {
            assert_eq!(
                j(tag, &[tag], pv),
                Some((Fail, "UnknownInstruction")),
                "{tag:#x} {pv:?}"
            );
        }
    }
}

/// A successful transaction of `base` that calls the program at top level
/// and is not CreateSeason (editing it keeps the Season's program version).
fn plain_call(base: &Input) -> usize {
    let create = frontier_abi::v2::tags::Ix::CreateSeason.tag();
    let p = base.cfg.program;
    calls(base)
        .into_iter()
        .map(|x| x.0)
        .find(|&t| {
            fclient::tx::from_wire(&base.txs[t].tx).is_ok_and(|tx| {
                let k = &tx.message.account_keys;
                tx.message
                    .instructions
                    .iter()
                    .filter(|c| k[c.program_id_index as usize] == p)
                    .all(|c| c.data.first() != Some(&create))
            })
        })
        .expect("a plain program call")
}

/// V0's coverage contract on the candidate, key-free (⑪ r13). This mirrors
/// ⑱'s `coverage.rs`, whose `with_ix` signs with a fixed-seed key pair and
/// whose synthetic march fixture is now a FAIL of its own (six pinned V11
/// tickets, ④ `52c0bd45`), so its "not a PASS" checks would hold for any
/// verdict. Here a recorded transaction of `land` (which PASSes) is edited
/// in place, never re-signed. For every tag of ABI v2: an instruction this
/// verifier does not model in this season is `UnverifiedInstruction` and
/// the verdict is not a PASS; data shorter than the ABI's range is
/// `Undecodable`.
#[test]
fn every_abi_v2_tag_has_a_v0_answer_on_a_recorded_season() {
    use frontier_abi::v2::tags::Ix;
    use verify_core::checks::v0_coverage::supported;
    let base = land();
    assert_eq!(verify_core::verify(&base).verdict, Verdict::Pass);
    let t = plain_call(&base);
    let v0 = |r: &verify_core::Report, code: &str| {
        r.findings.iter().any(|f| f.check == "V0" && f.code == code)
    };
    let mut unmodelled = 0;
    for &ix in Ix::ALL {
        // An M1 season: v3 and s1 are off (land is an M1 recording), and an
        // M1 instruction's length is ABI v1's (V0 reads it so).
        let (lo, _) = match ix.to_v1() {
            Some(v1) => frontier_abi::ix::data_len_range(v1),
            None => frontier_abi::v2::ix::data_len_range(ix),
        };
        if !supported(ix, false, false) {
            let mut d = vec![0u8; lo.max(1)];
            d[0] = ix.tag();
            let inp = redata(&base, t, d).expect("a program instruction");
            let r = verify_core::verify(&inp);
            assert_ne!(r.verdict, Verdict::Pass, "{}: {}", ix.name(), show(&r));
            assert!(
                v0(&r, "UnverifiedInstruction"),
                "{}: {}",
                ix.name(),
                show(&r)
            );
            unmodelled += 1;
        }
        if lo > 1 {
            let inp = redata(&base, t, vec![ix.tag(); lo - 1]).unwrap();
            let r = verify_core::verify(&inp);
            assert_eq!(
                r.verdict,
                Verdict::Fail,
                "{} short: {}",
                ix.name(),
                show(&r)
            );
            assert!(v0(&r, "Undecodable"), "{} short: {}", ix.name(), show(&r));
        }
    }
    // Conquest, S1, custody and map-growth tags are all unmodelled in M1.
    assert!(unmodelled >= 30, "{unmodelled}");
}

/// ⑱'s `an_unknown_program_version_is_never_a_pass`, which is itself
/// key-free (it edits CreateSeason's data in place).
#[test]
fn an_unknown_program_version_is_never_a_pass_keyfree() {
    use frontier_abi::v2::tags::Ix;
    for pv in [5u16, 0x8005, 0xFFFF] {
        let mut inp = land();
        let i = inp
            .txs
            .iter()
            .position(|t| {
                fclient::tx::from_wire(&t.tx).is_ok_and(|tx| {
                    tx.message
                        .instructions
                        .iter()
                        .any(|c| c.data.first() == Some(&Ix::CreateSeason.tag()))
                })
            })
            .expect("CreateSeason recorded");
        let mut tx = fclient::tx::from_wire(&inp.txs[i].tx).unwrap();
        for c in tx.message.instructions.iter_mut() {
            if c.data.first() == Some(&Ix::CreateSeason.tag()) {
                let o = 1 + frontier_abi::presets::layout::PROGRAM_VERSION;
                c.data[o..o + 2].copy_from_slice(&pv.to_le_bytes());
            }
        }
        inp.txs[i].tx = fclient::tx::wire(&tx);
        let r = verify_core::verify(&inp);
        assert_ne!(r.verdict, Verdict::Pass, "{pv:#x}: {}", show(&r));
        assert!(
            r.findings
                .iter()
                .any(|f| f.check == "V0" && f.code == "UnknownProgramVersion"),
            "{pv:#x}: {}",
            show(&r)
        );
    }
}

/// An empty program instruction (no tag) under a program version this
/// verifier knows is a FAIL (the program refuses it); a tag outside ABI v2
/// there too (0xEE, 0xFE, the wide draft 0xD6) — key-free, on `land`.
#[test]
fn no_tag_or_an_unknown_tag_under_a_known_program_fails() {
    let base = land();
    let t = plain_call(&base);
    for d in [vec![], vec![0xEE, 1, 2, 3], vec![0xFE], vec![0xD6; 9]] {
        let r = verify_core::verify(&redata(&base, t, d.clone()).unwrap());
        assert_eq!(r.verdict, Verdict::Fail, "{d:?}: {}", show(&r));
        assert!(
            r.findings
                .iter()
                .any(|f| f.check == "V0" && f.code == "UnknownInstruction"),
            "{d:?}: {}",
            show(&r)
        );
    }
}
