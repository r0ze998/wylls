//! verifier-alt-archive (F1–F3 of verify-pr155): VT with lookup table
//! snapshots, stale table reads, and VS comparing table bodies and
//! confirming every lookup on the witness's own reads.
//!
//! Key-free: reads the committed recordings only —
//! `playable-versioned-closed-67a33c92.json.gz` (versioned_season.rs
//! `record_closed_tables_season`: the 37-transaction v0/v1 season of the
//! devnet `.so` 67a33c92…, both lookup tables CLOSED after the season, the
//! archive carrying findex-style first-use snapshots) and
//! `playable-versioned-67a33c92.json.gz` (the same season, tables open).

#![cfg(feature = "playable-lane")]

mod common;

use fclient::alt::Snapshot;
use serde_json::json;
use verify_core::codes::{
    HISTORY_UNPROVEN, LOOKUP_MISMATCH, LOOKUP_SNAPSHOT_UNPROVEN, LOOKUP_TABLE_STALE,
    LOOKUP_TABLE_UNREAD, WITNESS_MISMATCH, WITNESS_UNAVAILABLE,
};
use verify_core::history::History;
use verify_core::input::Input;
use verify_core::witness::mirror;
use verify_core::{Report, Severity, Verdict};

const CLOSED: &str = "playable-versioned-closed-67a33c92.json.gz";
const OPEN: &str = "playable-versioned-67a33c92.json.gz";
const SO_GZ: &str = "devnet-playable-67a33c92.so.gz";
const SO_SHA256: &str = "67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(hex::encode(p.sha256()), SO_SHA256);
    std::sync::Arc::new(p.so.as_ref().clone())
}

fn load(name: &str) -> Input {
    let mut i = common::fixture(name);
    i.program_so = Some(so());
    i
}

/// The closed-table season with its post-states (VX).
fn closed() -> Input {
    load(CLOSED)
}

/// As a public RPC serves it: no post-states (VG re-executes from genesis).
fn rpc_shaped(mut i: Input) -> Input {
    for t in i.txs.iter_mut() {
        t.post.clear();
    }
    i
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
                f.detail.chars().take(500).collect::<String>()
            )
        })
        .collect()
}

fn has(r: &Report, check: &str, code: &str) -> bool {
    r.findings
        .iter()
        .any(|f| f.check == check && f.code == code)
}

fn vt(r: &Report) -> Vec<&verify_core::Finding> {
    r.findings.iter().filter(|f| f.check == "VT").collect()
}

fn pass(i: &Input, what: &str) -> Report {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
    assert!(r.checks_run.contains(&"VT:lookup-tables"), "{what}");
    r
}

fn fail_vt(i: &Input, what: &str) -> Report {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Fail, "{what}: {:#?}", show(&r));
    assert!(has(&r, "VT", LOOKUP_MISMATCH), "{what}: {:#?}", show(&r));
    r
}

/// UNVERIFIABLE with VT's `code`, and no FAIL anywhere.
fn unverifiable_vt(i: &Input, code: &str, what: &str) -> Report {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{what}: {:#?}", show(&r));
    assert!(has(&r, "VT", code), "{what}: want {code}: {:#?}", show(&r));
    assert!(
        r.findings.iter().all(|f| f.severity != Severity::Fail),
        "{what}: {:#?}",
        show(&r)
    );
    r
}

/// The address a v0 transaction looked up first (table, index, address).
fn first_lookup(i: &Input) -> (usize, solana_address::Address, u8, solana_address::Address) {
    for (n, t) in i.txs.iter().enumerate() {
        let Ok(m) = verify_core::vmsg::Msg::of(t) else {
            continue;
        };
        if let Some((tb, idx, a, _)) = m.lookups().into_iter().next() {
            return (n, tb, idx, a);
        }
    }
    panic!("a v0 lookup");
}

fn snap_of<'a>(i: &'a mut Input, t: &solana_address::Address) -> &'a mut Snapshot {
    i.chain
        .lookup_snapshots
        .iter_mut()
        .find(|s| s.table == *t)
        .expect("a snapshot of the table")
}

/// Rewrites address `idx` of a table account's bytes.
fn edit_table(a: &mut fclient::ports::Account, idx: usize, to: [u8; 32]) {
    let o = fclient::alt::META + 32 * idx;
    a.data[o..o + 32].copy_from_slice(&to);
}

// ------------------------------------------------------------ the recording

#[test]
fn the_recording_has_closed_tables_and_first_use_snapshots() {
    let i = closed();
    assert_eq!(i.txs.len(), 37);
    let t = i.chain.lookup_tables.as_ref().expect("the final read");
    assert_eq!(t.accounts.len(), 2);
    assert!(t.accounts.values().all(|a| a.is_none()), "both closed");
    assert_eq!(i.chain.lookup_snapshots.len(), 2);
    for s in &i.chain.lookup_snapshots {
        let (sig, slot) = s.used_by.expect("taken for a record");
        let first = i
            .txs
            .iter()
            .find(|r| {
                fclient::vtx::decode(&r.tx)
                    .map(|d| d.lookups.iter().any(|l| l.account_key == s.table))
                    .unwrap_or(false)
            })
            .expect("a record uses it");
        assert_eq!(first.signature, sig, "taken for its FIRST use");
        assert_eq!(first.slot, slot);
        assert!(s.read_slot.unwrap() >= slot);
        let acc = s.account.clone().flatten().expect("read while open");
        let tb = fclient::alt::decode_table(&acc.owner, &acc.data).expect("a table");
        let b = fclient::alt::replay(&s.table, s.history.as_ref().unwrap()).expect("replays");
        assert_eq!(b.list(), tb.addresses, "its own create / extend build it");
        assert!(b.addresses.iter().all(|(_, at)| *at < slot));
    }
    // round trip through the fixture format
    let back = Input::from_json(&i.to_json()).unwrap();
    assert_eq!(back.chain.lookup_snapshots, i.chain.lookup_snapshots);
}

// ------------------------------------------------------------ F2 in VT

#[test]
fn an_honest_season_whose_tables_were_closed_passes_with_the_archive() {
    let r = pass(&closed(), "post-states (VX)");
    assert!(r.checks_run.contains(&"VX:re-execution"));
    let r = pass(&rpc_shaped(closed()), "no post-states (VG)");
    assert!(r.checks_run.contains(&"VG:genesis-replay"));
}

#[test]
fn closed_tables_without_a_snapshot_stay_unverifiable() {
    for shape in [closed(), rpc_shaped(closed())] {
        let mut i = shape;
        i.chain.lookup_snapshots.clear();
        let r = unverifiable_vt(&i, LOOKUP_TABLE_UNREAD, "no snapshot");
        assert_eq!(vt(&r).len(), 2, "one per table: {:#?}", show(&r));
        // one of two tables unsnapshotted
        let mut i = closed();
        i.chain.lookup_snapshots.remove(0);
        unverifiable_vt(&i, LOOKUP_TABLE_UNREAD, "one snapshot missing");
    }
}

#[test]
fn an_account_only_or_history_only_snapshot_settles_too() {
    let mut i = closed();
    for s in i.chain.lookup_snapshots.iter_mut() {
        s.history = None;
    }
    pass(&i, "account-only snapshots (a fixture's own reads)");
    let mut i = closed();
    for s in i.chain.lookup_snapshots.iter_mut() {
        s.account = None;
        s.source = "verifier".into();
    }
    pass(
        &i,
        "history-only snapshots (the verifier's read of a closed table)",
    );
}

#[test]
fn a_tampered_snapshot_account_fails() {
    let (_, t, idx, _) = first_lookup(&closed());
    for keep_history in [true, false] {
        let mut i = closed();
        let s = snap_of(&mut i, &t);
        if !keep_history {
            s.history = None;
        }
        let a = s.account.as_mut().unwrap().as_mut().unwrap();
        edit_table(a, idx as usize, [7; 32]);
        let r = fail_vt(&i, "an address of the snapshot edited");
        assert!(show(&r).iter().any(|l| l.contains("snapshot")));
    }
    // another owner's data at the table address
    let mut i = closed();
    snap_of(&mut i, &t)
        .account
        .as_mut()
        .unwrap()
        .as_mut()
        .unwrap()
        .owner = solana_address::Address::new_from_array([3; 32]);
    fail_vt(&i, "a snapshot that is not a lookup table");
    // too short although read at the transaction's slot
    let mut i = closed();
    let a = snap_of(&mut i, &t)
        .account
        .as_mut()
        .unwrap()
        .as_mut()
        .unwrap();
    a.data.truncate(fclient::alt::META);
    fail_vt(&i, "a snapshot without the index, read at its use");
}

#[test]
fn a_snapshot_read_before_the_use_settles_nothing_by_its_account() {
    let (_, t, _, _) = first_lookup(&closed());
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    s.read_slot = Some(1);
    s.account
        .as_mut()
        .unwrap()
        .as_mut()
        .unwrap()
        .data
        .truncate(fclient::alt::META);
    pass(&i, "an early, empty read; its history settles");
    let s = snap_of(&mut i, &t);
    s.history = None;
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "an early, empty read alone");
}

#[test]
fn a_forged_or_inconsistent_snapshot_history_never_passes() {
    let (_, t, _, _) = first_lookup(&closed());
    // an Extend's bytes edited: its signature no longer verifies
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    let h = s.history.as_mut().unwrap();
    let last = h.len() - 1;
    let n = h[last].tx.len();
    h[last].tx[n - 1] ^= 1;
    unverifiable_vt(
        &i,
        LOOKUP_SNAPSHOT_UNPROVEN,
        "a forged history beside a good account read",
    );
    let s = snap_of(&mut i, &t);
    s.account = None;
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "a forged history alone");
    // the Extend's slot moved to the use's slot (an address appended in the
    // slot it is used is not active yet)
    let mut i = closed();
    let s = snap_of(&mut i, &t);
    let used = s.used_by.unwrap().1;
    for r in s.history.as_mut().unwrap().iter_mut() {
        r.slot = used;
    }
    unverifiable_vt(&i, LOOKUP_SNAPSHOT_UNPROVEN, "appended too late");
    // the other table's history: its Create derives another address (not
    // replayable, not forged): the account read still settles
    let mut i = closed();
    let other = i
        .chain
        .lookup_snapshots
        .iter()
        .find(|s| s.table != t)
        .unwrap()
        .history
        .clone();
    snap_of(&mut i, &t).history = other.clone();
    pass(&i, "an unreplayable history beside a good account read");
    snap_of(&mut i, &t).account = None;
    unverifiable_vt(
        &i,
        LOOKUP_SNAPSHOT_UNPROVEN,
        "an unreplayable history alone",
    );
}

#[test]
fn a_forged_loaded_address_still_fails_against_the_snapshot() {
    let (n, _, _, _) = first_lookup(&closed());
    for shape in [closed(), rpc_shaped(closed())] {
        let mut i = shape;
        let t = &mut i.txs[n];
        if !t.loaded.writable.is_empty() {
            t.loaded.writable[0] = solana_address::Address::new_from_array([9; 32]);
        } else {
            t.loaded.readonly[0] = solana_address::Address::new_from_array([9; 32]);
        }
        let r = verify_core::verify(&i);
        assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
        assert!(has(&r, "VT", LOOKUP_MISMATCH), "{:#?}", show(&r));
        // and with the history only (the verifier's read): never a PASS
        let mut j = i.clone();
        for s in j.chain.lookup_snapshots.iter_mut() {
            s.account = None;
        }
        let r = verify_core::verify(&j);
        assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
        assert!(
            has(&r, "VT", LOOKUP_SNAPSHOT_UNPROVEN) || has(&r, "VT", LOOKUP_MISMATCH),
            "{:#?}",
            show(&r)
        );
    }
}

#[test]
fn a_closed_table_refunded_by_a_transfer_is_settled_by_its_snapshot() {
    let mut i = closed();
    let ts = i.chain.lookup_tables.as_mut().unwrap();
    for a in ts.accounts.values_mut() {
        *a = Some(fclient::ports::Account {
            lamports: 890_880,
            data: vec![],
            owner: fclient::addr::system_program(),
            executable: false,
        });
    }
    pass(&i, "System-owned lamports at both table addresses");
}

#[test]
fn two_disagreeing_reads_of_one_table_fail() {
    // The open recording's final read beside a snapshot that differs at an
    // index no transaction uses.
    let mut open = load(OPEN);
    let closed = closed();
    // same season, same keys: the snapshots apply to the open recording
    assert_eq!(
        open.txs.iter().map(|t| t.signature).collect::<Vec<_>>(),
        closed.txs.iter().map(|t| t.signature).collect::<Vec<_>>(),
        "the two recordings are the same season"
    );
    open.chain.lookup_snapshots = closed.chain.lookup_snapshots.clone();
    pass(&open, "the open read and its first-use snapshots agree");
    let t = open.chain.lookup_snapshots[0].table;
    let a = snap_of(&mut open, &t)
        .account
        .as_mut()
        .unwrap()
        .as_mut()
        .unwrap();
    let last = (a.data.len() - fclient::alt::META) / 32 - 1;
    edit_table(a, last, [5; 32]);
    let r = verify_core::verify(&open);
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    assert!(
        show(&r).iter().any(|l| l.contains("two reads")),
        "{:#?}",
        show(&r)
    );
}

// ------------------------------------------------------------ F3

/// The open recording with its final read replaced by one "at slot 1"
/// holding only the first address of each table.
fn stale(slot: Option<u64>) -> Input {
    let mut i = load(OPEN);
    let ts = i.chain.lookup_tables.as_mut().unwrap();
    ts.slot = slot;
    for a in ts.accounts.values_mut() {
        let a = a.as_mut().unwrap();
        a.data.truncate(fclient::alt::META + 32);
    }
    i
}

#[test]
fn a_table_read_before_the_transaction_is_unverifiable_not_fail() {
    let r = unverifiable_vt(&stale(Some(1)), LOOKUP_TABLE_STALE, "read at slot 1");
    assert!(vt(&r).iter().all(|f| f.severity == Severity::Unverifiable));
    // with the first-use snapshots it is settled
    let mut i = stale(Some(1));
    i.chain.lookup_snapshots = closed().chain.lookup_snapshots;
    pass(&i, "a stale read and the snapshots");
}

#[test]
fn a_short_table_read_at_or_after_the_transaction_still_fails() {
    let last = load(OPEN).final_slot;
    fail_vt(&stale(Some(last)), "read at the final slot, short");
    fail_vt(&stale(None), "read at a slot not said, short");
}

// ------------------------------------------------------------ VS (F1, F2)

fn rpc_history() -> History {
    History::rpc(
        json!({"state": "unverifiable", "range": {"firstSlot": 1, "lastSlot": 2}, "gap": null,
               "unverifiable": [{"reason": "first pull without an origin anchor", "fromSlot": 1}],
               "origin": null, "witness": true, "heldBack": 0, "limit": "…"}),
        "rpc http://primary",
    )
}

fn public(mut i: Input) -> Input {
    i = rpc_shaped(i);
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

fn caught(i: &Input, code: &str, what: &str) -> Report {
    let r = verify_core::verify(i);
    assert_ne!(r.verdict, Verdict::Pass, "{what}: {:#?}", show(&r));
    assert!(
        has(&r, "VS", code),
        "{what}: want VS {code}: {:#?}",
        show(&r)
    );
    assert!(
        has(&r, "history", HISTORY_UNPROVEN)
            || r.findings.iter().any(|f| f.code == HISTORY_UNPROVEN)
    );
    assert_eq!(basis(&r), "unproven", "{what}");
    r
}

#[test]
fn a_public_season_with_closed_tables_is_witnessed_through_their_history() {
    let r = verify_core::verify(&witnessed(closed()));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(basis(&r), "witnessed");
    // without a witness: unproven as always
    let r = verify_core::verify(&public(closed()));
    assert_eq!(r.verdict, Verdict::Unverifiable);
}

#[test]
fn a_public_season_with_open_tables_is_witnessed_by_the_witness_read() {
    let r = verify_core::verify(&witnessed(load(OPEN)));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(basis(&r), "witnessed");
}

#[test]
fn an_account_only_snapshot_of_a_closed_table_cannot_be_witnessed() {
    let mut i = closed();
    for s in i.chain.lookup_snapshots.iter_mut() {
        s.history = None;
    }
    // VT settles it (the input's own read) …
    pass(&i, "as given");
    // … but no witness can confirm an old account state
    caught(&witnessed(i), WITNESS_UNAVAILABLE, "account-only snapshots");
}

#[test]
fn a_witness_that_does_not_serve_the_table_history_is_unavailable() {
    let mut i = witnessed(closed());
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let k = w.table_txs.keys().next().unwrap().clone();
    w.table_txs.insert(k, None);
    caught(&i, WITNESS_UNAVAILABLE, "a table transaction not served");
    // served at another slot
    let mut i = witnessed(closed());
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    for t in w.table_txs.values_mut() {
        t.as_mut().unwrap().slot += 1;
    }
    caught(&i, WITNESS_UNAVAILABLE, "served at another slot");
    // tables not read from the witness
    let mut i = witnessed(closed());
    i.chain.cross.as_mut().unwrap().witnesses[0].lookup_tables = None;
    caught(&i, WITNESS_UNAVAILABLE, "tables not read");
}

#[test]
fn a_witness_whose_table_body_differs_is_a_mismatch() {
    // F1: the open tables, one address edited on the witness
    let mut i = witnessed(load(OPEN));
    let (_, t, idx, _) = first_lookup(&i);
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let a = w
        .lookup_tables
        .as_mut()
        .unwrap()
        .accounts
        .get_mut(&t.to_bytes())
        .unwrap()
        .as_mut()
        .unwrap();
    edit_table(a, idx as usize, [8; 32]);
    caught(
        &i,
        WITNESS_MISMATCH,
        "a table address differs on the witness",
    );
    // a table the witness reads LATER as closed, the primary as open: honest
    // (closed meanwhile); the witness then confirms nothing it cannot read
    let mut i = witnessed(load(OPEN));
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let wt = w.lookup_tables.as_mut().unwrap();
    wt.slot = wt.slot.map(|s| s + 10);
    for a in wt.accounts.values_mut() {
        *a = None;
    }
    let r = caught(
        &i,
        WITNESS_UNAVAILABLE,
        "closed on the witness's later read, no history",
    );
    assert!(!has(&r, "VS", WITNESS_MISMATCH), "{:#?}", show(&r));
    // closed on the primary's read, open on the witness's later read: a
    // closed table never reopens
    let mut i = witnessed(closed());
    let open_tables = load(OPEN).chain.lookup_tables.unwrap();
    let w = &mut i.chain.cross.as_mut().unwrap().witnesses[0];
    let mut later = open_tables.clone();
    later.slot = i.chain.lookup_tables.as_ref().unwrap().slot.map(|s| s + 1);
    w.lookup_tables = Some(later);
    caught(&i, WITNESS_MISMATCH, "reopened on the witness");
}

#[test]
fn a_legacy_cross_check_is_byte_identical() {
    // A witness read of an archive without lookups carries none of the new
    // keys (earlier fixtures and reports keep their bytes).
    let i = common::fixture("playable-lane-genesis.json.gz");
    let c = mirror(&i, "http://witness");
    let j = c.to_json();
    assert!(j["witnesses"][0].get("lookup_tables").is_none());
    assert!(j["witnesses"][0].get("table_txs").is_none());
}
