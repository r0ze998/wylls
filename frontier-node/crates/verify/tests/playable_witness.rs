//! VS — the second source of a public-RPC season, and ⑰ Q-P1's verdict
//! rule (owner 2026-11-19 22:32): a public-RPC history is lifted from ⑲'s
//! `unproven` ONLY when (a) VG reproduces every program-owned final state
//! from the Season's creation AND (b) every witness RPC serves the same
//! season item by item (`verify_core::witness`).
//!
//! Key-free: the committed recording `playable-lane-genesis.json.gz` (the
//! natural playable-lane season, see `playable_genesis.rs`) read as a
//! public RPC serves it (no post-states, with balances), its history marked
//! as an RPC one, and an honest witness that serves exactly what the chain
//! did ([`verify_core::witness::mirror`]). The lying sources are edits of
//! one side. The live two-node versions (real `getSignaturesForAddress`,
//! `getTransaction`, `getBlock` reads over HTTP, a lying proxy) are the
//! ignored `a_live_*witness*` tests of `playable_lane.rs`.
#![cfg(feature = "playable-lane")]

mod common;

use serde_json::json;
use verify_core::codes::{
    HISTORY_UNPROVEN, WITNESS_MISMATCH, WITNESS_MISSING_TX, WITNESS_UNAVAILABLE, WITNESS_UNKNOWN_TX,
};
use verify_core::history::History;
use verify_core::input::Input;
use verify_core::witness::{mirror, CrossCheck};
use verify_core::{Report, Verdict};

const FIXTURE: &str = "playable-lane-genesis.json.gz";
const SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    std::sync::Arc::new(p.so.as_ref().clone())
}

/// The coverage findex's `RpcPoll` reports after a pull with a witness
/// (G3) and no origin anchor.
fn rpc_history() -> History {
    History::rpc(
        json!({"state": "unverifiable", "range": {"firstSlot": 1, "lastSlot": 2}, "gap": null,
               "unverifiable": [{"reason": "first pull without an origin anchor", "fromSlot": 1}],
               "origin": null, "witness": true, "heldBack": 0, "limit": "…"}),
        "rpc http://primary",
    )
}

/// The season as the primary public RPC serves it, without a witness.
fn primary() -> Input {
    let mut inp = common::fixture(FIXTURE);
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    inp.program_so = Some(so());
    inp.history = rpc_history();
    inp
}

/// With an honest witness that served what the chain holds.
fn witnessed() -> Input {
    let mut inp = primary();
    inp.chain.cross = Some(mirror(&inp, "http://witness"));
    inp
}

fn cross(inp: &mut Input) -> &mut CrossCheck {
    inp.chain.cross.as_mut().unwrap()
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

fn has(r: &Report, code: &str) -> bool {
    r.findings.iter().any(|f| f.code == code)
}

fn basis(r: &Report) -> String {
    r.history.as_ref().unwrap()["basis"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Not PASS, unproven, with VS's `code` among the findings.
fn assert_caught(inp: &Input, code: &str, what: &str) -> Report {
    let r = verify_core::verify(inp);
    assert_ne!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
    assert!(has(&r, code), "{what}: want {code}: {:#?}", show(&r));
    assert!(has(&r, HISTORY_UNPROVEN), "{what}: {:#?}", show(&r));
    assert_eq!(basis(&r), "unproven", "{what}");
    r
}

/// A failed transaction: VG alone cannot see it missing (verify-pr91 §4
/// residual 1) — only the witness's list can.
fn a_failed_tx(inp: &Input) -> usize {
    (0..inp.txs.len())
        .rev()
        .find(|&i| inp.txs[i].err.is_some())
        .expect("a failed transaction")
}

// ------------------------------------------------------------ honest

#[test]
fn an_honest_season_agreed_by_a_witness_passes_as_witnessed() {
    let r = verify_core::verify(&witnessed());
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r.checks_run.contains(&"VG:genesis-replay"));
    assert!(r.checks_run.contains(&"VS:witness"));
    assert!(!has(&r, HISTORY_UNPROVEN));
    let h = r.history.as_ref().unwrap();
    assert_eq!(h["basis"], "witnessed");
    assert_eq!(
        h["complete"],
        serde_json::Value::Null,
        "never a whole-chain claim"
    );
    assert_eq!(h["witness"]["agrees"], true);
    assert_eq!(h["witness"]["vgExact"], true);
    assert!(h["witness"]["blocks"].as_u64().unwrap() > 0);
    assert!(h["witness"]["programAccounts"].as_u64().unwrap() > 0);
    let md = r.markdown();
    assert!(md.contains("basis witnessed"), "{md}");
    assert!(md.contains("Trust that remains"), "{md}");
}

#[test]
fn two_agreeing_witnesses_pass_and_one_dissenter_does_not() {
    let mut inp = witnessed();
    let w2 = {
        let mut w = cross(&mut inp).witnesses[0].clone();
        w.url = "http://witness-2".into();
        w
    };
    cross(&mut inp).witnesses.push(w2);
    assert_eq!(verify_core::verify(&inp).verdict, Verdict::Pass);
    let i = a_failed_tx(&inp);
    let s = inp.txs[i].signature.to_string();
    cross(&mut inp).witnesses[1]
        .txs
        .get_mut(&s)
        .unwrap()
        .as_mut()
        .unwrap()
        .fee += 1;
    assert_caught(&inp, WITNESS_MISMATCH, "one of two witnesses disagrees");
}

#[test]
fn the_cross_check_round_trips_through_the_fixture_format() {
    let inp = witnessed();
    let back = Input::from_json(&inp.to_json()).unwrap();
    assert_eq!(back.chain, inp.chain);
    let mut back = back;
    back.program_so = Some(so());
    assert_eq!(verify_core::verify(&back).verdict, Verdict::Pass);
}

// ------------------------------------------------------------ (a) or (b) alone

#[test]
fn without_a_witness_it_is_unverifiable_and_says_why() {
    let r = verify_core::verify(&primary());
    assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
    let f = r
        .findings
        .iter()
        .find(|f| f.code == HISTORY_UNPROVEN)
        .unwrap();
    assert!(
        f.detail.contains("(b) no witness RPC was read"),
        "{}",
        f.detail
    );
    assert!(!f.detail.contains("(a) VG"), "{}", f.detail);
}

#[test]
fn a_witness_without_vg_is_not_enough() {
    // (b) holds, (a) does not: no pinned binary, so VG does not run.
    let mut inp = witnessed();
    inp.program_so = None;
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
    let f = r
        .findings
        .iter()
        .find(|f| f.code == HISTORY_UNPROVEN)
        .unwrap();
    assert!(f.detail.contains("(a) VG did not"), "{}", f.detail);
}

#[test]
fn a_witnessed_season_vg_fails_stays_unverifiable_per_the_owner_rule() {
    // Both sources serve the same forged log record (a lying pair, or a
    // bad season): VG FAILs, so (a) does not hold and the history is not
    // lifted; VG's FAIL is not self-contained, so the verdict is
    // UNVERIFIABLE, not FAIL (owner Q-P1: lift ONLY with (a) AND (b);
    // whether such a season should read FAIL is asked of r0ze).
    let mut inp = primary();
    let i = (21..inp.txs.len())
        .find(|&i| {
            inp.txs[i].err.is_none()
                && inp.txs[i]
                    .logs
                    .iter()
                    .any(|l| l.starts_with("Program data: "))
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
    inp.chain.cross = Some(mirror(&inp, "http://witness"));
    let r = verify_core::verify(&inp);
    assert!(r.findings.iter().any(|f| f.fail() && f.check == "VG"));
    assert!(
        !r.findings.iter().any(|f| f.check == "VS"),
        "{:#?}",
        show(&r)
    );
    assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
}

// ------------------------------------------------------------ a lying primary, an honest witness

#[test]
fn a_dropped_failed_transaction_is_caught_by_the_witness_only() {
    let honest = witnessed();
    let mut inp = honest.clone();
    let i = a_failed_tx(&inp);
    let s = inp.txs[i].signature.to_string();
    inp.txs.remove(i);
    inp.chain.balances.remove(&s);
    // VG alone does not see it (residual 1) ...
    let mut alone = inp.clone();
    alone.chain.cross = None;
    alone.history = Default::default();
    assert_eq!(verify_core::verify(&alone).verdict, Verdict::Pass);
    // ... the witness does.
    let r = assert_caught(&inp, WITNESS_MISSING_TX, "dropped failed tx");
    assert_eq!(r.verdict, Verdict::Unverifiable);
}

#[test]
fn a_dropped_successful_transaction_is_caught() {
    let mut inp = witnessed();
    let i = (22..inp.txs.len())
        .find(|&i| inp.txs[i].err.is_none())
        .unwrap();
    let s = inp.txs[i].signature.to_string();
    inp.txs.remove(i);
    inp.chain.balances.remove(&s);
    assert_caught(&inp, WITNESS_MISSING_TX, "dropped tx");
}

#[test]
fn a_transaction_that_never_landed_is_caught() {
    // The primary serves a signed transaction (and its block lists it);
    // the witness, which saw the chain, never saw it.
    let mut inp = primary();
    let i = a_failed_tx(&inp);
    let mut w = inp.clone();
    let s = w.txs[i].signature.to_string();
    w.txs.remove(i);
    w.chain.balances.remove(&s);
    let mut c = mirror(&w, "http://witness");
    // the primary's own blocks list it (a consistent liar)
    c.primary = mirror(&inp, "http://witness").primary;
    inp.chain.cross = Some(c);
    let r = assert_caught(&inp, WITNESS_UNKNOWN_TX, "never-landed tx");
    assert!(has(&r, WITNESS_MISMATCH), "its block: {:#?}", show(&r));
}

#[test]
fn an_edited_meta_is_caught() {
    // Each of the meta fields one at a time, on the primary's side; the
    // compute units and the block time change nothing VG judges.
    type Edit = fn(&mut Input, usize);
    let edits: [(&str, Edit); 6] = [
        ("units", |inp, i| inp.txs[i].units += 1),
        ("blockTime", |inp, i| inp.txs[i].block_time += 1),
        ("fee", |inp, i| inp.txs[i].fee += 5_000),
        ("err", |inp, i| {
            inp.txs[i].err = Some("InstructionError(0, Custom(1))".into())
        }),
        ("logs", |inp, i| {
            inp.txs[i].logs.push("Program log: injected".into())
        }),
        ("balances", |inp, i| {
            let s = inp.txs[i].signature.to_string();
            let b = inp.chain.balances.get_mut(&s).unwrap();
            b.post[0] += 1;
            b.pre[0] += 1;
        }),
    ];
    for (what, edit) in edits {
        let mut inp = witnessed();
        let i = a_failed_tx(&inp);
        edit(&mut inp, i);
        assert_caught(&inp, WITNESS_MISMATCH, what);
    }
}

#[test]
fn an_edited_transaction_slot_is_caught() {
    let mut inp = witnessed();
    let i = a_failed_tx(&inp);
    inp.txs[i].slot += 1;
    assert_caught(&inp, WITNESS_MISMATCH, "slot");
}

#[test]
fn an_edited_final_state_is_caught_on_either_side() {
    let program = witnessed().cfg.program.to_bytes();
    let k = *witnessed()
        .finals
        .iter()
        .find(|(_, a)| {
            a.as_ref()
                .is_some_and(|a| a.owner.to_bytes() == program && a.data.len() > 200)
        })
        .unwrap()
        .0;
    // the primary lies
    let mut inp = witnessed();
    inp.finals.get_mut(&k).unwrap().as_mut().unwrap().data[150] ^= 1;
    assert_caught(&inp, WITNESS_MISMATCH, "primary final");
    // the witness lies (or the season moved between the reads)
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0]
        .finals
        .get_mut(&k)
        .unwrap()
        .as_mut()
        .unwrap()
        .lamports += 1;
    assert_caught(&inp, WITNESS_MISMATCH, "witness final");
}

#[test]
fn a_hidden_program_account_is_caught() {
    let mut inp = witnessed();
    let k = cross(&mut inp)
        .primary
        .program_accounts
        .as_mut()
        .unwrap()
        .pop();
    assert!(k.is_some());
    assert_caught(&inp, WITNESS_MISMATCH, "account set");
}

#[test]
fn a_block_that_differs_or_lacks_the_transaction_is_caught() {
    let slot = witnessed().txs[5].slot;
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0]
        .blocks
        .get_mut(&slot)
        .unwrap()
        .as_mut()
        .unwrap()
        .blockhash = "another-fork".into();
    assert_caught(&inp, WITNESS_MISMATCH, "blockhash");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0]
        .blocks
        .get_mut(&slot)
        .unwrap()
        .as_mut()
        .unwrap()
        .signatures
        .clear();
    assert_caught(&inp, WITNESS_MISMATCH, "not in the block");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].blocks.insert(slot, None);
    assert_caught(&inp, WITNESS_UNAVAILABLE, "block not served");
}

#[test]
fn another_binary_authority_or_cluster_is_caught() {
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].program_hash = Some([7; 32]);
    assert_caught(&inp, WITNESS_MISMATCH, "binary");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].upgrade_authority = Some("none".into());
    assert_caught(&inp, WITNESS_MISMATCH, "authority");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].genesis = Some("mainnet".into());
    assert_caught(&inp, WITNESS_MISMATCH, "cluster");
}

// ------------------------------------------------------------ the witness missing or partial

#[test]
fn an_unreachable_witness_is_unverifiable() {
    let mut inp = primary();
    let mut c = mirror(&inp, "http://127.0.0.1:41549");
    c.witnesses[0] = verify_core::witness::SourceRead {
        url: "http://127.0.0.1:41549".into(),
        errors: vec!["getGenesisHash: connection refused".into()],
        ..Default::default()
    };
    inp.chain.cross = Some(c);
    let r = assert_caught(&inp, WITNESS_UNAVAILABLE, "unreachable");
    assert_eq!(r.verdict, Verdict::Unverifiable);
}

#[test]
fn a_partial_witness_is_unverifiable() {
    let mut inp = witnessed();
    let s = inp.txs[3].signature.to_string();
    cross(&mut inp).witnesses[0].txs.insert(s, None);
    assert_caught(&inp, WITNESS_UNAVAILABLE, "a tx not served");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].signatures = None;
    assert_caught(&inp, WITNESS_UNAVAILABLE, "no list");
    let mut inp = witnessed();
    cross(&mut inp).witnesses[0].finalized_slot = Some(1);
    assert_caught(&inp, WITNESS_UNAVAILABLE, "behind");
    let mut inp = witnessed();
    cross(&mut inp).witnesses.clear();
    assert_caught(&inp, WITNESS_UNAVAILABLE, "none read");
}

#[test]
fn the_primary_as_its_own_witness_is_not_a_second_source() {
    let mut inp = witnessed();
    cross(&mut inp).primary.url = "http://witness/".into();
    assert_caught(&inp, WITNESS_UNAVAILABLE, "same URL");
}

#[test]
fn a_gap_in_the_pull_is_never_lifted() {
    let mut inp = witnessed();
    inp.history = History::rpc(
        json!({"state": "gap", "gap": "history gap: …", "unverifiable": [], "limit": "…"}),
        "rpc http://primary",
    );
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
}

// ------------------------------------------------------------ the stated residual

#[test]
fn two_sources_lying_identically_pass_the_stated_residual() {
    // Both drop the same failed transaction (two colluding RPCs, or one
    // storage behind both): VS has nothing to compare against and VG
    // cannot see a failed transaction missing. This PASS is the residual
    // trust assumption that `witness::RESIDUAL` states in every report.
    let mut inp = primary();
    let i = a_failed_tx(&inp);
    let s = inp.txs[i].signature.to_string();
    inp.txs.remove(i);
    inp.chain.balances.remove(&s);
    inp.chain.cross = Some(mirror(&inp, "http://colluding-witness"));
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r.markdown().contains("collude"));
}

/// The check of the check: with `mutate-vs` (a VS that trusts every
/// witness blindly) the lying primary is lifted to a PASS. Run with
/// `--features playable-lane,mutate-vs`.
#[test]
fn a_mutate_vs_build_lets_a_dropped_transaction_pass() {
    let mut inp = witnessed();
    let i = a_failed_tx(&inp);
    let s = inp.txs[i].signature.to_string();
    inp.txs.remove(i);
    inp.chain.balances.remove(&s);
    let r = verify_core::verify(&inp);
    if cfg!(feature = "mutate-vs") {
        assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    } else {
        assert_ne!(r.verdict, Verdict::Pass);
    }
}

#[test]
fn one_endpoint_in_another_spelling_is_not_a_second_source() {
    // verify-pr95: the primary's host given again (case, default port,
    // path, query, fragment, `localhost`) or one witness given twice.
    for (p, w) in [
        ("http://witness", "HTTP://WITNESS"),
        ("http://witness", "http://witness:80/"),
        ("http://witness", "http://witness/?x=1"),
        ("http://witness", "http://witness#a"),
        (
            "https://rpc.example.com",
            "https://rpc.example.com:443/key-2",
        ),
        ("https://rpc.example.com", "https://rpc.example.com:8899"),
        ("https://rpc.example.com", "https://user@RPC.example.com."),
        ("http://127.0.0.1:8899", "http://localhost:8899"),
        ("http://[::1]:8899", "http://127.0.0.1:8899/"),
    ] {
        let mut inp = witnessed();
        cross(&mut inp).primary.url = p.into();
        cross(&mut inp).witnesses[0].url = w.into();
        assert_caught(&inp, WITNESS_UNAVAILABLE, &format!("{p} vs {w}"));
    }
    // Two loopback nodes on two ports stay two sources (the live tests).
    let mut inp = witnessed();
    cross(&mut inp).primary.url = "http://127.0.0.1:8899".into();
    cross(&mut inp).witnesses[0].url = "http://127.0.0.1:8900".into();
    assert_eq!(verify_core::verify(&inp).verdict, Verdict::Pass);
    // One witness given twice.
    let mut inp = witnessed();
    let mut again = cross(&mut inp).witnesses[0].clone();
    again.url = "http://WITNESS/".into();
    cross(&mut inp).witnesses.push(again);
    assert_caught(&inp, WITNESS_UNAVAILABLE, "a witness given twice");
}
