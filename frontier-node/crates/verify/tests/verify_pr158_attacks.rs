//! verify-pr158: an independent attack pass on the lookup table snapshots
//! (verifier-alt-archive, F1–F3). Every tamper of a snapshot or of the
//! witness's table reads must end FAIL or UNVERIFIABLE, never PASS; the
//! honest controls must PASS.
//!
//! Key-free: reads the committed recordings only (the closed-table season
//! `playable-versioned-closed-67a33c92.json.gz`, the open-table season
//! `playable-versioned-67a33c92.json.gz`) and the committed devnet `.so`.

#![cfg(feature = "playable-lane")]

mod common;

use fclient::alt::{Snapshot, META};
use serde_json::json;
use solana_address::Address;
use verify_core::codes::{
    LOOKUP_MISMATCH, LOOKUP_SNAPSHOT_UNPROVEN, LOOKUP_TABLE_STALE, LOOKUP_TABLE_UNREAD,
    WITNESS_MISMATCH, WITNESS_UNAVAILABLE,
};
use verify_core::history::History;
use verify_core::input::Input;
use verify_core::witness::mirror;
use verify_core::{Report, Severity, Verdict};

const CLOSED: &str = "playable-versioned-closed-67a33c92.json.gz";
const OPEN: &str = "playable-versioned-67a33c92.json.gz";
const SO_GZ: &str = "devnet-playable-67a33c92.so.gz";

fn load(name: &str) -> Input {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    let mut i = common::fixture(name);
    i.program_so = Some(std::sync::Arc::new(p.so.as_ref().clone()));
    i
}

fn closed() -> Input {
    load(CLOSED)
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

fn has(r: &Report, check: &str, code: &str) -> bool {
    r.findings
        .iter()
        .any(|f| f.check == check && f.code == code)
}

fn pass(i: &Input, what: &str) {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
}

fn fail_vt(i: &Input, what: &str) {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Fail, "{what}: {:#?}", show(&r));
    assert!(has(&r, "VT", LOOKUP_MISMATCH), "{what}: {:#?}", show(&r));
}

fn unverifiable_vt(i: &Input, code: &str, what: &str) {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{what}: {:#?}", show(&r));
    assert!(has(&r, "VT", code), "{what}: want {code}: {:#?}", show(&r));
    assert!(
        r.findings.iter().all(|f| f.severity != Severity::Fail),
        "{what}: {:#?}",
        show(&r)
    );
}

/// Tables the season looks up, each with the first (tx#, slot, index,
/// address) using it.
fn uses(i: &Input) -> Vec<(Address, usize, u64, u8, Address)> {
    let mut out: Vec<(Address, usize, u64, u8, Address)> = vec![];
    for (n, t) in i.txs.iter().enumerate() {
        let Ok(m) = verify_core::vmsg::Msg::of(t) else {
            continue;
        };
        for (tb, idx, a, _) in m.lookups() {
            if !out.iter().any(|u| u.0 == tb) {
                out.push((tb, n, t.slot, idx, a));
            }
        }
    }
    assert!(out.len() >= 2, "two tables in the recording");
    out
}

fn snaps_of<'a>(i: &'a mut Input, t: &Address) -> impl Iterator<Item = &'a mut Snapshot> {
    let t = *t;
    i.chain
        .lookup_snapshots
        .iter_mut()
        .filter(move |s| s.table == t)
}

fn snap_of<'a>(i: &'a mut Input, t: &Address) -> &'a mut Snapshot {
    snaps_of(i, t).next().expect("a snapshot of the table")
}

fn acct(s: &mut Snapshot) -> &mut fclient::ports::Account {
    s.account.as_mut().unwrap().as_mut().unwrap()
}

/// The table's account trimmed to `n` addresses.
fn trim(s: &mut Snapshot, n: usize) {
    acct(s).data.truncate(META + 32 * n);
}

// ------------------------------------------------------------ forged account bytes

#[test]
fn forged_snapshot_account_bytes_fail_or_stay_unverifiable() {
    let u = uses(&closed());
    let (t, _, _, idx, _) = u[0];
    // every index rewritten (incl. the one used): FAIL
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    let n = (acct(s).data.len() - META) / 32;
    for k in 0..n {
        let o = META + 32 * k;
        acct(s).data[o..o + 32].copy_from_slice(&[0xEE; 32]);
    }
    fail_vt(&i, "every address of the snapshot rewritten");
    // only the used index rewritten (the history still agrees with the
    // meta): the account read FAILs regardless
    let mut i = closed();
    let o = META + 32 * idx as usize;
    acct(snap_of(&mut i, &t)).data[o..o + 32].copy_from_slice(&[0xEE; 32]);
    fail_vt(&i, "the used address rewritten");
    // another owner: not a table, FAIL
    let mut i = closed();
    acct(snap_of(&mut i, &t)).owner = Address::new_from_array([7; 32]);
    fail_vt(&i, "the snapshot account owned by another program");
    // a ragged length / wrong discriminator: not a table, FAIL
    let mut i = closed();
    acct(snap_of(&mut i, &t)).data.pop();
    fail_vt(&i, "a ragged account length");
    let mut i = closed();
    acct(snap_of(&mut i, &t)).data[0] = 2;
    fail_vt(&i, "a wrong discriminator");
    // the authority swapped / removed (frozen): VT does not read the
    // authority; the addresses still settle (sound: authority does not
    // decide an index's address)
    let mut i = closed();
    acct(snap_of(&mut i, &t)).data[22..54].copy_from_slice(&[0x55; 32]);
    pass(&i, "the snapshot's authority swapped");
    let mut i = closed();
    acct(snap_of(&mut i, &t)).data[21] = 0;
    pass(&i, "the snapshot's authority removed");
}

// ------------------------------------------------------------ slots

#[test]
fn snapshot_slots_decide_only_what_they_can() {
    let u = uses(&closed());
    let (t, _, slot, idx, _) = u[0];
    // a read before the use that still holds the index: settles (append-only)
    let mut i = closed();
    for s in i.chain.lookup_snapshots.iter_mut() {
        s.history = None;
    }
    snap_of(&mut i, &t).read_slot = Some(1);
    pass(&i, "a read before the use holding the index");
    // short and read before the use, no history: UNVERIFIABLE
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    s.history = None;
    s.read_slot = Some(slot - 1);
    trim(s, idx as usize);
    unverifiable_vt(
        &i,
        LOOKUP_SNAPSHOT_UNPROVEN,
        "short, read before, no history",
    );
    // short with no slot said, no history: UNVERIFIABLE
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    s.history = None;
    s.read_slot = None;
    trim(s, idx as usize);
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "short, slot not said");
    // short and read at the use's slot or later: FAIL (tables only grow)
    for at in [slot, slot + 10_000] {
        let mut i = closed();
        let s = snap_of(&mut i, &t);
        s.read_slot = Some(at);
        trim(s, idx as usize);
        fail_vt(&i, &format!("short, read at slot {at}"));
    }
    // the history's Extend moved to the use's slot or later (not active
    // when the transaction ran), no account: UNVERIFIABLE
    for d in [0u64, 5] {
        let mut i = closed();
        let s = snap_of(&mut i, &t);
        s.account = None;
        for r in s.history.as_mut().unwrap().iter_mut() {
            r.slot = slot + d;
        }
        unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "an Extend at/after the use");
    }
    // F3 on the pinned read: an OPEN table read stale (before the first
    // use, trimmed) and no snapshot: UNVERIFIABLE LookupTableStale; the
    // same read holding a wrong address at an index it has: FAIL
    let mut i = load(OPEN);
    let lt = i.chain.lookup_tables.as_mut().unwrap();
    lt.slot = Some(1);
    for a in lt.accounts.values_mut().flatten() {
        a.data.truncate(META);
    }
    unverifiable_vt(&i, LOOKUP_TABLE_STALE, "stale pinned read");
    let mut i = load(OPEN);
    let lt = i.chain.lookup_tables.as_mut().unwrap();
    lt.slot = Some(1);
    for a in lt.accounts.values_mut().flatten() {
        let o = META + 32 * idx as usize;
        if a.data.len() >= o + 32 {
            a.data[o..o + 32].copy_from_slice(&[0xEE; 32]);
        }
    }
    fail_vt(&i, "stale pinned read holding another address");
}

// ------------------------------------------------------------ histories

#[test]
fn tampered_histories_never_pass() {
    let u = uses(&closed());
    let (t, _, _, _, _) = u[0];
    let (t2, _, _, _, _) = u[1];
    let history_only = |mut i: Input| {
        for s in i.chain.lookup_snapshots.iter_mut() {
            s.account = None;
        }
        i
    };
    pass(&history_only(closed()), "control: history-only snapshots");
    // truncated history: the Extend dropped
    let mut i = history_only(closed());
    snap_of(&mut i, &t).history.as_mut().unwrap().pop();
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "the Extend dropped");
    // the Create dropped
    let mut i = history_only(closed());
    snap_of(&mut i, &t).history.as_mut().unwrap().remove(0);
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "the Create dropped");
    // the Extend marked failed
    let mut i = history_only(closed());
    let h = snap_of(&mut i, &t).history.as_mut().unwrap();
    let n = h.len();
    h[n - 1].err = Some("InstructionError".into());
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "the Extend marked failed");
    // the Extend listed twice (verify-pr158 fix: not genuine)
    let mut i = history_only(closed());
    let h = snap_of(&mut i, &t).history.as_mut().unwrap();
    let last = h[h.len() - 1].clone();
    h.push(last);
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "the Extend listed twice");
    // and beside a good account read (the account read must not paper over
    // a non-genuine history)
    let mut i = closed();
    let h = snap_of(&mut i, &t).history.as_mut().unwrap();
    let last = h[h.len() - 1].clone();
    h.push(last);
    unverifiable_vt(
        &i,
        LOOKUP_SNAPSHOT_UNPROVEN,
        "a duplicated Extend beside a good account",
    );
    // the record's signature swapped for another tx's
    let mut i = history_only(closed());
    let h = snap_of(&mut i, &t).history.as_mut().unwrap();
    h[1].signature = h[0].signature;
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "a signature swapped");
    // the other table's create/extend (its Create derives another address)
    let other = snap_of(&mut closed(), &t2).history.clone();
    let mut i = history_only(closed());
    snap_of(&mut i, &t).history = other.clone();
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "the other table's history");
    // the other table's txs mixed in: they do not touch this table, so they
    // change nothing (sound) — still PASS
    let mut i = history_only(closed());
    let h = snap_of(&mut i, &t).history.as_mut().unwrap();
    let mut mixed: Vec<_> = h.iter().cloned().chain(other.unwrap()).collect();
    mixed.sort_by_key(|r| r.slot);
    *h = mixed;
    pass(&i, "the other table's txs mixed in (inert)");
}

// ------------------------------------------------------------ frames / extra snapshots

#[test]
fn duplicate_conflicting_and_stray_snapshots() {
    let u = uses(&closed());
    let (t, _, _, idx, _) = u[0];
    // the same snapshot twice: PASS
    let mut i = closed();
    let s = snap_of(&mut i, &t).clone();
    i.chain.lookup_snapshots.push(s.clone());
    pass(&i, "a snapshot duplicated");
    // a second, conflicting snapshot of the same table (another address at
    // the used index): FAIL whatever the first says
    let mut i = closed();
    let mut bad = s.clone();
    let o = META + 32 * idx as usize;
    acct(&mut bad).data[o..o + 32].copy_from_slice(&[0xEE; 32]);
    bad.history = None;
    i.chain.lookup_snapshots.push(bad);
    fail_vt(&i, "a second snapshot disagreeing");
    // a second snapshot holding a different address at an index the
    // season never uses: two reads of an append-only table disagree: FAIL
    let mut i = closed();
    let mut bad = s.clone();
    let n = (acct(&mut bad).data.len() - META) / 32;
    let k = (0..n).find(|k| *k != idx as usize).unwrap_or(0);
    let o = META + 32 * k;
    acct(&mut bad).data[o..o + 32].copy_from_slice(&[0xEE; 32]);
    bad.history = None;
    i.chain.lookup_snapshots.push(bad);
    fail_vt(&i, "a second snapshot disagreeing at another index");
    // a snapshot of a table the season never used (even garbage): ignored
    let mut i = closed();
    let mut stray = s.clone();
    stray.table = Address::new_from_array([0x42; 32]);
    acct(&mut stray).owner = Address::new_from_array([9; 32]);
    i.chain.lookup_snapshots.push(stray);
    pass(&i, "a stray snapshot of an unused table");
    // the snapshot filed under another table (bytes of table t claimed for
    // table t2): t2's lookups are then judged against t's addresses
    let (t2, _, _, _, _) = u[1];
    let mut i = closed();
    i.chain.lookup_snapshots.retain(|x| x.table != t2);
    let mut moved = s.clone();
    moved.table = t2;
    moved.history = None;
    i.chain.lookup_snapshots.push(moved);
    let r = verify_core::verify(&i);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    // no snapshot at all, tables closed: UNVERIFIABLE
    let mut i = closed();
    i.chain.lookup_snapshots.clear();
    unverifiable_vt(&i, LOOKUP_TABLE_UNREAD, "no snapshots");
    // snapshots JSON: a truncated / malformed entry is refused at load
    let mut v = closed().chain.to_json();
    v["lookup_snapshots"][0]["history"][0] = json!({"slot": 1});
    assert!(verify_core::input::ChainWitness::from_json(&v).is_err());
    let mut v = closed().chain.to_json();
    v["lookup_snapshots"][0]["table"] = json!("not-an-address");
    assert!(verify_core::input::ChainWitness::from_json(&v).is_err());
    let mut v = closed().chain.to_json();
    v["lookup_snapshots"] = json!({"x": 1});
    assert!(verify_core::input::ChainWitness::from_json(&v).is_err());
}

// ------------------------------------------------------------ meta vs snapshot

#[test]
fn a_meta_the_snapshot_contradicts_fails() {
    let u = uses(&closed());
    let (_, n, _, _, _) = u[0];
    // the archived loadedAddresses forged (first entry): the honest
    // snapshot contradicts it: never PASS, and VT FAILs
    let mut i = closed();
    let l = &mut i.txs[n].loaded;
    if let Some(a) = l.writable.first_mut() {
        *a = Address::new_from_array([0xEE; 32]);
    } else {
        l.readonly[0] = Address::new_from_array([0xEE; 32]);
    }
    let r = verify_core::verify(&i);
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    assert!(has(&r, "VT", LOOKUP_MISMATCH), "{:#?}", show(&r));
}

// ------------------------------------------------------------ VS

fn rpc_history() -> History {
    History::rpc(
        json!({"state": "unverifiable", "range": {"firstSlot": 1, "lastSlot": 2}, "gap": null,
               "unverifiable": [{"reason": "first pull without an origin anchor", "fromSlot": 1}],
               "origin": null, "witness": true, "heldBack": 0, "limit": "…"}),
        "rpc http://primary",
    )
}

fn public(mut i: Input) -> Input {
    for t in i.txs.iter_mut() {
        t.post.clear();
    }
    i.history = rpc_history();
    i
}

fn witnessed(i: Input) -> Input {
    let mut i = public(i);
    i.chain.cross = Some(mirror(&i, "http://witness"));
    i
}

fn basis(r: &Report) -> String {
    r.history.as_ref().unwrap()["basis"]
        .as_str()
        .unwrap()
        .to_string()
}

fn unproven(i: &Input, code: &str, what: &str) {
    let r = verify_core::verify(i);
    assert_ne!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
    assert!(
        has(&r, "VS", code),
        "{what}: want VS {code}: {:#?}",
        show(&r)
    );
    assert_eq!(basis(&r), "unproven", "{what}");
}

#[test]
fn vs_attacks_on_table_reads_never_lift() {
    let u = uses(&closed());
    let (t, _, _, _, _) = u[0];
    // controls
    let r = verify_core::verify(&witnessed(closed()));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(basis(&r), "witnessed");
    let r = verify_core::verify(&witnessed(load(OPEN)));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    // account-only snapshots (findex's account read, no history): the
    // witness cannot confirm an old account state: ⑲ not lifted
    let mut i = closed();
    for s in i.chain.lookup_snapshots.iter_mut() {
        s.history = None;
    }
    unproven(&witnessed(i), WITNESS_UNAVAILABLE, "account-only snapshots");
    // the witness serves a table tx with another error
    let mut i = witnessed(closed());
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    for v in w.table_txs.values_mut() {
        v.as_mut().unwrap().err = Some("InstructionError".into());
    }
    unproven(&i, WITNESS_UNAVAILABLE, "table txs served failed");
    // the witness serves other bytes (another tx under that signature)
    let mut i = witnessed(closed());
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let other = w.table_txs.values().last().unwrap().clone();
    for v in w.table_txs.values_mut() {
        *v = other.clone();
    }
    unproven(&i, WITNESS_UNAVAILABLE, "table txs served with other bytes");
    // the witness's own read shows the closed table OPEN with another body
    // (a closed table never reopens): WitnessMismatch
    let open = load(OPEN).chain.lookup_tables.unwrap();
    let mut i = witnessed(closed());
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let wt = w.lookup_tables.as_mut().unwrap();
    for (k, a) in wt.accounts.iter_mut() {
        *a = open.accounts.get(k).cloned().flatten();
    }
    unproven(
        &i,
        WITNESS_MISMATCH,
        "witness shows a closed table reopened",
    );
    // open season: the witness's table body differs at the used index
    let mut i = witnessed(load(OPEN));
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let wt = w.lookup_tables.as_mut().unwrap();
    let a = wt
        .accounts
        .get_mut(&t.to_bytes())
        .unwrap()
        .as_mut()
        .unwrap();
    for k in 0..(a.data.len() - META) / 32 {
        let o = META + 32 * k;
        a.data[o..o + 32].copy_from_slice(&[0xEE; 32]);
    }
    unproven(&i, WITNESS_MISMATCH, "witness table body differs");
    // open season: the witness's table authority swapped
    let mut i = witnessed(load(OPEN));
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let wt = w.lookup_tables.as_mut().unwrap();
    let a = wt
        .accounts
        .get_mut(&t.to_bytes())
        .unwrap()
        .as_mut()
        .unwrap();
    a.data[21] = 1;
    a.data[22..54].copy_from_slice(&[0x55; 32]);
    unproven(&i, WITNESS_MISMATCH, "witness table authority differs");
    // open season: the witness's table is shorter at a LATER slot
    let mut i = witnessed(load(OPEN));
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let wt = w.lookup_tables.as_mut().unwrap();
    wt.slot = wt.slot.map(|s| s + 100);
    let a = wt
        .accounts
        .get_mut(&t.to_bytes())
        .unwrap()
        .as_mut()
        .unwrap();
    a.data.truncate(META);
    unproven(&i, WITNESS_UNAVAILABLE, "witness table shorter later");
    // forged loadedAddresses in the archive AND snapshots forged to agree
    // (the operator lies consistently): the witness serves the true
    // loadedAddresses: never PASS
    let (_, n, _, idx, addr) = u[0];
    let fake = Address::new_from_array([0xEE; 32]);
    let honest_cross = witnessed(closed()).chain.cross;
    let mut i = closed();
    let l = &mut i.txs[n].loaded;
    for a in l.writable.iter_mut().chain(l.readonly.iter_mut()) {
        if *a == addr {
            *a = fake;
        }
    }
    let o = META + 32 * idx as usize;
    for s in snaps_of(&mut i, &t) {
        acct(s).data[o..o + 32].copy_from_slice(&[0xEE; 32]);
        s.history = None;
    }
    let mut j = public(i);
    j.chain.cross = honest_cross;
    let r = verify_core::verify(&j);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
}
