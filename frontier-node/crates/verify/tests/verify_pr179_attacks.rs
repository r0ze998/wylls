//! verify-pr179: forged declared patches against every check that reads
//! `World::state_before` / `lamports_before` / `state_after` (and V7 / V11's
//! `checks::Before`).
//!
//! For a successful transaction `t` and an account `k` it wrote whose last
//! archived write before `t` is `s` (state `X`):
//!
//! * **A** (the dishonest action): the archive's write at `s` is tampered
//!   to `X'`. Relative to the archive, `t` is now dishonest (it ran on `X`,
//!   not `X'`).
//! * **A+forge**: A plus a forged declared patch `X` at `t`, which "explains"
//!   `t`. Every check that FAILed at `t` in A must FAIL or be `MissingData`
//!   at `t` (never silent = PASS); the season is never PASS.
//! * **A+stale**: A plus the same patch at `s` (not later than the last
//!   write): the archived write overrides it, so every check's FAILs at `t`
//!   are exactly A's.
//! * **B** (a forged patch contradicting the later on-chain post): the
//!   archive is untouched and `X'` is declared at `t`. Every check that
//!   FAILed at `t` in A should FAIL at `t` in B too (informational:
//!   reported, a check that reads the archive's truth instead may pass).
//!
//! `X'` is either `X` with the first byte `t` changed bumped by one, or `X`
//! with 7 more lamports. Archives: `VPR179_ARCHIVES` (`:`-separated paths;
//! default the dress fixture), up to `VPR179_N` transactions each.
#![cfg(feature = "playable-lane")]

mod common;

use std::collections::{BTreeMap, BTreeSet};
use verify_core::input::{Declared, Input};
use verify_core::{Report, Severity, Verdict};

fn load(p: &str) -> Input {
    let mut inp = Input::load(std::path::Path::new(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
    for (pre, so) in [
        ("67a33c92", "devnet-playable-67a33c92.so.gz"),
        ("da3dc1aa", "devnet-playable-da3dc1aa.so.gz"),
    ] {
        if inp
            .program_hashes
            .iter()
            .any(|(_, h)| hex::encode(h).starts_with(pre))
        {
            let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(so)).unwrap();
            inp.program_so = Some(std::sync::Arc::new(p.so.as_ref().clone()));
        }
    }
    inp
}

/// `(check, severity)` of every finding on signature `sig`.
fn at(rep: &Report, sig: &str) -> BTreeSet<(&'static str, bool)> {
    rep.findings
        .iter()
        .filter(|f| f.signature == sig)
        .filter(|f| f.severity >= Severity::Unverifiable)
        .map(|f| (f.check, f.fail()))
        .collect()
}

fn fails(rep: &Report, sig: &str) -> BTreeSet<&'static str> {
    at(rep, sig)
        .into_iter()
        .filter(|x| x.1)
        .map(|x| x.0)
        .collect()
}

/// A base58 32-byte key (no external crate).
fn unb58(s: &str) -> Option<[u8; 32]> {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut n = [0u8; 32];
    for c in s.bytes() {
        let mut carry = A.iter().position(|&x| x == c)? as u32;
        for b in n.iter_mut().rev() {
            carry += (*b as u32) * 58;
            *b = carry as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(n)
}

fn post_of(inp: &Input, t: usize, k: &[u8; 32]) -> Option<usize> {
    inp.txs[t].post.iter().position(|(a, _)| a.to_bytes() == *k)
}

#[test]
#[ignore = "verify-pr179 attack sweep (slow): VPR179_ARCHIVES=… cargo test --test verify_pr179_attacks -- --ignored --nocapture"]
fn forged_declared_patches_never_turn_a_fail_into_a_pass() {
    let list = std::env::var("VPR179_ARCHIVES").unwrap_or_else(|_| {
        common::fixtures_dir()
            .join("playable-dress-v7-declared.json.gz")
            .display()
            .to_string()
    });
    let n: usize = std::env::var("VPR179_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let mut covered: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut b_gaps: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut breaks: Vec<String> = vec![];
    let mut runs = 0usize;
    for path in list.split(':').filter(|s| !s.is_empty()) {
        let inp = load(path);
        let base = verify_core::verify(&inp);
        // (t, k, s) candidates: t successful, k written by t and by an
        // earlier successful s with a present post-state
        let mut last: BTreeMap<[u8; 32], usize> = BTreeMap::new();
        let mut cands = vec![];
        for (t, tx) in inp.txs.iter().enumerate() {
            if tx.err.is_some() {
                continue;
            }
            for (a, acc) in &tx.post {
                let k = a.to_bytes();
                if let (Some(&s), Some(_)) = (last.get(&k), acc) {
                    let ps = post_of(&inp, s, &k).unwrap();
                    if inp.txs[s].post[ps].1.is_some() {
                        cands.push((t, k, s));
                    }
                }
            }
            for (a, _) in &tx.post {
                last.insert(a.to_bytes(), t);
            }
        }
        let step = (cands.len() / n.max(1)).max(1);
        let picked: Vec<_> = cands.iter().step_by(step).take(n).cloned().collect();
        eprintln!(
            "{path}: base {:?}, {} candidates, {} picked",
            base.verdict,
            cands.len(),
            picked.len()
        );
        for (t, k, s) in picked {
            let ps = post_of(&inp, s, &k).unwrap();
            let pt = post_of(&inp, t, &k).unwrap();
            let x = inp.txs[s].post[ps].1.clone().unwrap();
            let y = inp.txs[t].post[pt].1.clone().unwrap();
            let mut variants = vec![];
            if let Some(i) = (0..x.data.len().min(y.data.len())).find(|&i| x.data[i] != y.data[i]) {
                let mut m = x.clone();
                m.data[i] = m.data[i].wrapping_add(1);
                variants.push((format!("byte {i}"), m));
            }
            let mut m = x.clone();
            m.lamports += 7;
            variants.push(("lamports+7".into(), m));
            let sig = inp.txs[t].signature.to_string();
            let base_at = at(&base, &sig);
            for (what, xm) in variants {
                // A: the archive's write at s tampered
                let mut a = inp.clone();
                a.txs[s].post[ps].1 = Some(xm.clone());
                let ra = verify_core::verify(&a);
                let fa = fails(&ra, &sig);
                let new_fa: BTreeSet<_> = fa
                    .iter()
                    .filter(|c| !base_at.contains(&(**c, true)))
                    .cloned()
                    .collect();
                runs += 1;
                if new_fa.is_empty() {
                    continue;
                }
                for c in &new_fa {
                    *covered.entry(c).or_default() += 1;
                }
                let decl = |at_: usize, acc: &fclient::ports::Account| Declared {
                    at: at_,
                    key: k,
                    account: Some(acc.clone()),
                    what: "verify-pr179 forged".into(),
                };
                // A+forge: the forged patch X at t explains t
                let mut af = a.clone();
                af.declared.push(decl(t, &x));
                let rf = verify_core::verify(&af);
                let atf = at(&rf, &sig);
                if rf.verdict == Verdict::Pass {
                    breaks.push(format!("{path} t{t} s{s} {what}: A+forge PASS"));
                }
                for c in &new_fa {
                    if !atf.contains(&(*c, true)) && !atf.contains(&(*c, false)) {
                        breaks.push(format!(
                            "{path} t{t} s{s} {what}: {c} FAILed in A, silent (PASS) at t in A+forge; at t: {atf:?}"
                        ));
                    }
                }
                // A+stale: patch at s is overridden by the archived write
                let mut ast = a.clone();
                ast.declared.push(decl(s, &x));
                let rs = verify_core::verify(&ast);
                let fs = fails(&rs, &sig);
                if fs != fa {
                    breaks.push(format!(
                        "{path} t{t} s{s} {what}: A+stale FAILs at t {fs:?} != A {fa:?}"
                    ));
                }
                // B: forged contradicting patch X' at t over the honest archive
                let mut b = inp.clone();
                b.declared.push(decl(t, &xm));
                let rb = verify_core::verify(&b);
                let fb = fails(&rb, &sig);
                let atb = at(&rb, &sig);
                if rb.verdict == Verdict::Pass {
                    breaks.push(format!("{path} t{t} s{s} {what}: B PASS"));
                }
                for c in &new_fa {
                    if !fb.contains(c) {
                        *b_gaps.entry(c).or_default() += 1;
                        eprintln!(
                            "  B-gap {path} t{t} s{s} {what}: {c} FAILs in A, not in B; at t in B: {atb:?}"
                        );
                    }
                }
                runs += 3;
            }
        }
    }
    eprintln!("runs {runs}; checks with an A FAIL at t (covered): {covered:?}");
    eprintln!("B gaps (FAIL in A, not FAIL in B): {b_gaps:?}");
    for b in &breaks {
        eprintln!("BREAK {b}");
    }
    assert!(breaks.is_empty(), "{} breaks", breaks.len());
}

/// The dress fixture's first rim village: its reserve patch at 421 (after
/// the last archived write at 420), the Harvest at 444 that carries the 400.
fn dress() -> Input {
    load(
        &common::fixtures_dir()
            .join("playable-dress-v7-declared.json.gz")
            .display()
            .to_string(),
    )
}

fn v7_at(rep: &Report, sig: &str) -> Vec<String> {
    rep.findings
        .iter()
        .filter(|f| f.check == "V7" && f.signature == sig)
        .map(|f| format!("{:?} {} {} | {}", f.severity, f.code, f.entity, f.detail))
        .collect()
}

/// verify-pr179 V7-1: a forged declared Holding that is not a Holding
/// (magic zeroed) in force before a dishonest Harvest. Without any patch
/// the Harvest FAILs V7 (it carries 400 Spearmen the archive never gave
/// the village); with the forged state V7 must still FAIL or say
/// MissingData at the Harvest, never go silent.
#[test]
fn a_forged_non_holding_declared_state_never_silences_v7() {
    let mut inp = dress();
    let i = inp
        .declared
        .iter()
        .position(|d| d.what.contains("Spearmen in") && d.at == 421)
        .expect("the KEEP village's reserve patch");
    let mut d = inp.declared.remove(i);
    let sig = inp.txs[444].signature.to_string();
    let plain = verify_core::verify(&inp);
    assert!(
        v7_at(&plain, &sig).iter().any(|s| s.starts_with("Fail")),
        "no patch: the Harvest FAILs V7: {:?}",
        v7_at(&plain, &sig)
    );
    // the forged state: the patch with its magic zeroed, at the Harvest
    let a = d.account.as_mut().unwrap();
    a.data[..8].fill(0);
    d.at = 444;
    d.what = "verify-pr179 forged non-Holding".into();
    inp.declared.push(d);
    let rep = verify_core::verify(&inp);
    let v7 = v7_at(&rep, &sig);
    eprintln!("V7 at the Harvest: {v7:#?}");
    assert_ne!(rep.verdict, Verdict::Pass);
    assert!(
        !v7.is_empty(),
        "V7 went silent at the dishonest Harvest under a forged declared state"
    );
}

/// verify-pr179 sweep 2 (silencing): the write of `t` itself is tampered
/// (a dishonest write: some check FAILs at `t`), then a forged declared
/// state of the account in force before `t` tries to silence it: the
/// archived state with its first 8 bytes zeroed (not that account kind),
/// declared absent, or equal to the tampered write. Every check that
/// FAILed at `t` must still FAIL or be `MissingData` at `t`.
#[test]
#[ignore = "verify-pr179 silencing sweep (slow): VPR179_ARCHIVES=… -- --ignored --nocapture"]
fn forged_declared_states_never_silence_a_dishonest_write() {
    let list = std::env::var("VPR179_ARCHIVES").unwrap_or_else(|_| {
        common::fixtures_dir()
            .join("playable-dress-v7-declared.json.gz")
            .display()
            .to_string()
    });
    let n: usize = std::env::var("VPR179_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let mut covered: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut breaks: Vec<String> = vec![];
    for path in list.split(':').filter(|s| !s.is_empty()) {
        let inp = load(path);
        let base = verify_core::verify(&inp);
        let mut last: BTreeMap<[u8; 32], usize> = BTreeMap::new();
        let mut cands = vec![];
        for (t, tx) in inp.txs.iter().enumerate() {
            if tx.err.is_some() {
                continue;
            }
            for (a, acc) in &tx.post {
                let k = a.to_bytes();
                if let (Some(&s), Some(_)) = (last.get(&k), acc) {
                    let ps = post_of(&inp, s, &k).unwrap();
                    if inp.txs[s].post[ps].1.is_some() {
                        cands.push((t, k, s));
                    }
                }
            }
            for (a, _) in &tx.post {
                last.insert(a.to_bytes(), t);
            }
        }
        let step = (cands.len() / n.max(1)).max(1);
        let picked: Vec<_> = cands.iter().step_by(step).take(n).cloned().collect();
        eprintln!(
            "{path}: base {:?}, {} candidates, {} picked",
            base.verdict,
            cands.len(),
            picked.len()
        );
        for (t, k, s) in picked {
            let ps = post_of(&inp, s, &k).unwrap();
            let pt = post_of(&inp, t, &k).unwrap();
            let x = inp.txs[s].post[ps].1.clone().unwrap();
            let y = inp.txs[t].post[pt].1.clone().unwrap();
            let sig = inp.txs[t].signature.to_string();
            let base_at = at(&base, &sig);
            // tampers of t's write: bytes t changed (up to 4), lamports
            let mut tampers = vec![];
            for i in (0..x.data.len().min(y.data.len()))
                .filter(|&i| x.data[i] != y.data[i])
                .take(4)
            {
                let mut m = y.clone();
                m.data[i] = m.data[i].wrapping_add(1);
                tampers.push((format!("byte {i}"), m));
            }
            let mut m = y.clone();
            m.lamports += 7;
            tampers.push(("lamports+7".into(), m));
            for (what, ym) in tampers {
                let mut a = inp.clone();
                a.txs[t].post[pt].1 = Some(ym.clone());
                let ra = verify_core::verify(&a);
                let new_fa: BTreeSet<_> = fails(&ra, &sig)
                    .into_iter()
                    .filter(|c| !base_at.contains(&(*c, true)))
                    .collect();
                if new_fa.is_empty() {
                    continue;
                }
                for c in &new_fa {
                    *covered.entry(c).or_default() += 1;
                }
                let mut garbage = x.clone();
                let z = garbage.data.len().min(8);
                garbage.data[..z].fill(0);
                for (fw, forged) in [
                    ("garbage", Some(garbage)),
                    ("absent", None),
                    ("equal-to-write", Some(ym.clone())),
                ] {
                    let mut af = a.clone();
                    af.declared.push(Declared {
                        at: t,
                        key: k,
                        account: forged,
                        what: "verify-pr179 forged".into(),
                    });
                    let rf = verify_core::verify(&af);
                    let atf = at(&rf, &sig);
                    if rf.verdict == Verdict::Pass {
                        breaks.push(format!("{path} t{t} {what} {fw}: PASS"));
                    }
                    for c in &new_fa {
                        if !atf.contains(&(*c, true)) && !atf.contains(&(*c, false)) {
                            breaks.push(format!(
                                "{path} t{t} s{s} {what} {fw}: {c} FAILed on the dishonest write, silent under the forged state; at t: {atf:?}"
                            ));
                        }
                    }
                }
            }
        }
    }
    eprintln!("silencing: checks with a FAIL on a dishonest write (covered): {covered:?}");
    for b in &breaks {
        eprintln!("BREAK {b}");
    }
    assert!(breaks.is_empty(), "{} breaks", breaks.len());
}

/// verify-pr179 targeted sweep. Discovery: a no-op declared patch (the
/// archived state itself) right after every archived write, so every read
/// of an account through the declared path is reported (`MissingData`
/// "only declares", naming the accounts on the generic path) — and, as an
/// invariant, no FAIL appears or disappears. Then, per check (up to
/// `VPR179_PER_CHECK` transactions each), the two attacks on exactly the
/// accounts it read: A (the archived write before `t` tampered, a forged
/// patch restoring it: FAIL or `MissingData` of the check at `t`; the
/// patch at the last write instead: A's FAILs exactly) and S (`t`'s own
/// write tampered, a forged garbage / absent / equal-to-write state before
/// it: FAIL or `MissingData` of the check at `t`).
#[test]
#[ignore = "verify-pr179 targeted sweep (slow): VPR179_ARCHIVES=… -- --ignored --nocapture"]
fn targeted_forged_patches_per_check() {
    let list = std::env::var("VPR179_ARCHIVES").unwrap_or_else(|_| {
        common::fixtures_dir()
            .join("playable-dress-v7-declared.json.gz")
            .display()
            .to_string()
    });
    let per: usize = std::env::var("VPR179_PER_CHECK")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);
    let skip: BTreeSet<&str> = ["VX", "VWL", "V0", "V0E"].into_iter().collect();
    let mut tried: BTreeMap<&'static str, (usize, usize)> = BTreeMap::new();
    let mut breaks: Vec<String> = vec![];
    for path in list.split(':').filter(|s| !s.is_empty()) {
        let inp = load(path);
        let base = verify_core::verify(&inp);
        let sig_t: BTreeMap<String, usize> = inp
            .txs
            .iter()
            .enumerate()
            .map(|(i, t)| (t.signature.to_string(), i))
            .collect();
        // writers[k] = successful txs with a present post of k, in order
        let mut writers: BTreeMap<[u8; 32], Vec<usize>> = BTreeMap::new();
        for (t, tx) in inp.txs.iter().enumerate() {
            if tx.err.is_some() {
                continue;
            }
            for (a, _) in &tx.post {
                writers.entry(a.to_bytes()).or_default().push(t);
            }
        }
        let last_before = |k: &[u8; 32], t: usize| -> Option<usize> {
            let v = writers.get(k)?;
            let i = v.partition_point(|&u| u < t);
            v.get(i.checked_sub(1)?).copied()
        };
        // (the no-ops go first: a real patch at the same index wins, as the
        // last in input order does)
        let mut disc = inp.clone();
        disc.declared.clear();
        for (k, v) in &writers {
            for &s in v {
                let ps = post_of(&inp, s, k).unwrap();
                if let Some(acc) = &inp.txs[s].post[ps].1 {
                    disc.declared.push(Declared {
                        at: s + 1,
                        key: *k,
                        account: Some(acc.clone()),
                        what: "verify-pr179 no-op".into(),
                    });
                }
            }
        }
        disc.declared.extend(inp.declared.iter().cloned());
        let rd = verify_core::verify(&disc);
        let fails_of = |r: &Report| -> BTreeSet<(String, &'static str, String)> {
            r.findings
                .iter()
                .filter(|f| f.fail())
                .map(|f| (f.signature.clone(), f.check, f.code.clone()))
                .collect()
        };
        if fails_of(&rd) != fails_of(&base) {
            breaks.push(format!(
                "{path}: no-op patches changed the FAILs: base-only {:?}, patched-only {:?}",
                fails_of(&base)
                    .difference(&fails_of(&rd))
                    .collect::<Vec<_>>(),
                fails_of(&rd)
                    .difference(&fails_of(&base))
                    .collect::<Vec<_>>()
            ));
        }
        // (check, t) -> named keys (empty: per-judgement, use t's writes)
        let mut reads: BTreeMap<&'static str, BTreeMap<usize, BTreeSet<[u8; 32]>>> =
            BTreeMap::new();
        for f in &rd.findings {
            if skip.contains(f.check) || !f.detail.contains("only declares") {
                continue;
            }
            let Some(&t) = sig_t.get(&f.signature) else {
                continue;
            };
            let e = reads.entry(f.check).or_default().entry(t).or_default();
            if let Some((_, ks)) = f.detail.rsplit_once("write): ") {
                for b in ks.split(", ") {
                    if let Some(k) = unb58(b.trim()) {
                        e.insert(k);
                    }
                }
            }
        }
        eprintln!(
            "{path}: base {:?}; declared-path readers: {:?}",
            base.verdict,
            reads.iter().map(|(c, m)| (*c, m.len())).collect::<Vec<_>>()
        );
        for (check, txs) in &reads {
            let step = (txs.len() / per.max(1)).max(1);
            for (&t, named) in txs.iter().step_by(step).take(per) {
                let keys: Vec<[u8; 32]> = if named.is_empty() {
                    inp.txs[t].post.iter().map(|(a, _)| a.to_bytes()).collect()
                } else {
                    named.iter().copied().collect()
                };
                let sig = inp.txs[t].signature.to_string();
                let base_fail = fails(&base, &sig).contains(check);
                let mut hit = false;
                'keys: for k in keys {
                    let Some(s) = last_before(&k, t) else {
                        continue;
                    };
                    let ps = post_of(&inp, s, &k).unwrap();
                    let Some(x) = inp.txs[s].post[ps].1.clone() else {
                        continue;
                    };
                    let pt = post_of(&inp, t, &k);
                    let y = pt.and_then(|p| inp.txs[t].post[p].1.clone());
                    // byte positions: what t changed first, then spread
                    let mut pos: Vec<usize> = match &y {
                        Some(y) => (0..x.data.len().min(y.data.len()))
                            .filter(|&i| x.data[i] != y.data[i])
                            .take(6)
                            .collect(),
                        None => vec![],
                    };
                    let st = (x.data.len() / 8).max(1);
                    pos.extend((8..x.data.len()).step_by(st).take(8));
                    let mut variants: Vec<(String, fclient::ports::Account)> = pos
                        .into_iter()
                        .map(|i| {
                            let mut m = x.clone();
                            m.data[i] = m.data[i].wrapping_add(1);
                            (format!("byte {i}"), m)
                        })
                        .collect();
                    let mut m = x.clone();
                    m.lamports += 7;
                    variants.push(("lamports+7".into(), m));
                    for (what, xm) in variants {
                        if base_fail {
                            break;
                        }
                        // A
                        let mut a = inp.clone();
                        a.txs[s].post[ps].1 = Some(xm.clone());
                        let ra = verify_core::verify(&a);
                        if !fails(&ra, &sig).contains(check) {
                            continue;
                        }
                        hit = true;
                        tried.entry(check).or_default().0 += 1;
                        let decl = |at_: usize, acc: Option<fclient::ports::Account>| Declared {
                            at: at_,
                            key: k,
                            account: acc,
                            what: "verify-pr179 forged".into(),
                        };
                        let mut af = a.clone();
                        af.declared.push(decl(t, Some(x.clone())));
                        let rf = verify_core::verify(&af);
                        let atf = at(&rf, &sig);
                        if rf.verdict == Verdict::Pass {
                            breaks.push(format!("{path} {check} t{t} A+forge PASS"));
                        }
                        if !atf.contains(&(*check, true)) && !atf.contains(&(*check, false)) {
                            breaks.push(format!(
                                "{path} {check} t{t} s{s} {what}: A FAIL, silent under the forged restoring patch; at t {atf:?}"
                            ));
                        }
                        let mut ast = a.clone();
                        ast.declared.push(decl(s, Some(x.clone())));
                        let rs = verify_core::verify(&ast);
                        if fails(&rs, &sig) != fails(&ra, &sig) {
                            breaks.push(format!(
                                "{path} {check} t{t} s{s} {what}: a patch at the last write changed the FAILs at t"
                            ));
                        }
                        // S: t's own write tampered (when t wrote k)
                        if let (Some(p), Some(y)) = (pt, &y) {
                            let mut ym = y.clone();
                            match what
                                .strip_prefix("byte ")
                                .and_then(|i| i.parse::<usize>().ok())
                            {
                                Some(i) if i < ym.data.len() => {
                                    ym.data[i] = ym.data[i].wrapping_add(1)
                                }
                                _ => ym.lamports += 7,
                            }
                            let mut sa = inp.clone();
                            sa.txs[t].post[p].1 = Some(ym.clone());
                            let rsa = verify_core::verify(&sa);
                            if fails(&rsa, &sig).contains(check) {
                                tried.entry(check).or_default().1 += 1;
                                let mut g = x.clone();
                                let z = g.data.len().min(8);
                                g.data[..z].fill(0);
                                for (fw, forged) in [
                                    ("garbage", Some(g)),
                                    ("absent", None),
                                    ("equal-to-write", Some(ym.clone())),
                                ] {
                                    let mut sf = sa.clone();
                                    sf.declared.push(decl(t, forged));
                                    let r = verify_core::verify(&sf);
                                    let a2 = at(&r, &sig);
                                    if r.verdict == Verdict::Pass {
                                        breaks.push(format!("{path} {check} t{t} S {fw} PASS"));
                                    }
                                    if !a2.contains(&(*check, true))
                                        && !a2.contains(&(*check, false))
                                    {
                                        breaks.push(format!(
                                            "{path} {check} t{t} s{s} {what} S {fw}: dishonest write FAILed, silent under the forged state; at t {a2:?}"
                                        ));
                                    }
                                }
                            }
                        }
                        break 'keys;
                    }
                }
                if !hit {
                    eprintln!(
                        "  {check} t{t}: no tamper of its read accounts FAILed it (not attacked)"
                    );
                }
            }
        }
    }
    eprintln!("attacked (check: (A, S)): {tried:?}");
    for b in &breaks {
        eprintln!("BREAK {b}");
    }
    assert!(breaks.is_empty(), "{} breaks", breaks.len());
}

/// verify-pr179 V7-2: a forged declared Holding that is not a Holding
/// (magic zeroed) in force before a Holding write that is not an owner
/// action. V7's continuity judgement used to read it and leave without a
/// finding (`before[..8] != MAGIC` → skipped), so V7 said nothing at all
/// about a write it read a declared state for. `checks::Before` now logs
/// its reads like `World::state_before`, so the check is `MissingData` at
/// the transaction whenever it read a declared state and did not FAIL.
#[test]
fn a_forged_non_holding_declared_state_before_any_holding_write_never_silences_v7() {
    let inp = dress();
    let magic = &frontier_abi::layout::player::holding::MAGIC;
    let mut last: BTreeMap<[u8; 32], usize> = BTreeMap::new();
    let mut cases = vec![];
    for (t, tx) in inp.txs.iter().enumerate() {
        if tx.err.is_some() {
            continue;
        }
        for (a, acc) in &tx.post {
            let k = a.to_bytes();
            if acc.as_ref().is_some_and(|a| a.data.starts_with(magic)) && last.contains_key(&k) {
                cases.push((t, k, last[&k]));
            }
        }
        for (a, _) in &tx.post {
            last.insert(a.to_bytes(), t);
        }
    }
    // the Holding writes of non-owner transactions (keeper passes) and a
    // spread of the rest
    let step = if std::env::var("VPR179_ALL").is_ok() {
        1
    } else {
        (cases.len() / 24).max(1)
    };
    eprintln!(
        "{} Holding writes after an archived write, every {step}",
        cases.len()
    );
    let mut silent = vec![];
    for &(t, k, s) in cases.iter().step_by(step) {
        let mut g = inp.txs[s]
            .post
            .iter()
            .find(|(a, _)| a.to_bytes() == k)
            .and_then(|(_, a)| a.clone())
            .unwrap();
        g.data[..8].fill(0);
        let mut f = inp.clone();
        f.declared.push(Declared {
            at: t,
            key: k,
            account: Some(g),
            what: "verify-pr179 forged non-Holding".into(),
        });
        let rep = verify_core::verify(&f);
        assert_ne!(rep.verdict, Verdict::Pass);
        if v7_at(&rep, &inp.txs[t].signature.to_string()).is_empty() {
            silent.push(t);
        }
    }
    assert!(
        silent.is_empty(),
        "V7 silent after reading a forged declared Holding at {silent:?}"
    );
}
