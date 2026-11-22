//! verify-pr155: adversarial tampers of the v0/v1 season recording
//! (`playable-versioned-67a33c92.json.gz`) beyond `versioned_season.rs`.
//! Every dishonest archive must be FAIL or UNVERIFIABLE (never PASS); every
//! honest change of the lookup tables' later state (extended, deactivated)
//! must keep PASS. Reads the committed recording only: no key is generated
//! or signed.
#![cfg(feature = "playable-lane")]

mod common;

use fclient::vtx::{self, Version, VersionedTransaction};
use fclient::Address;
use solana_message::VersionedMessage;
use verify_core::input::Input;
use verify_core::{Report, Severity, Verdict};

const SO_GZ: &str = "devnet-playable-67a33c92.so.gz";
const FIXTURE: &str = "playable-versioned-67a33c92.json.gz";

fn recorded() -> Input {
    let mut i = common::fixture(FIXTURE);
    i.program_so = Some(
        verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
            .unwrap()
            .so,
    );
    i
}

fn rpc_shaped() -> Input {
    let mut i = recorded();
    for t in i.txs.iter_mut() {
        t.post.clear();
    }
    i
}

fn both() -> [(&'static str, Input); 2] {
    [("post", recorded()), ("no-post", rpc_shaped())]
}

fn show(r: &Report) -> Vec<String> {
    r.findings
        .iter()
        .map(|f| {
            format!(
                "{:?} {} {} {}",
                f.severity,
                f.check,
                f.code,
                f.detail.chars().take(200).collect::<String>()
            )
        })
        .collect()
}

fn codes(r: &Report) -> Vec<String> {
    let mut v: Vec<String> = r
        .findings
        .iter()
        .filter(|f| f.severity >= Severity::Unverifiable)
        .map(|f| format!("{:?}:{}:{}", f.severity, f.check, f.code))
        .collect();
    v.sort();
    v.dedup();
    v
}

fn version(i: &Input, t: usize) -> Version {
    vtx::decode(&i.txs[t].tx).expect("decodes").version
}

fn lookups(i: &Input) -> Vec<usize> {
    (0..i.txs.len())
        .filter(|&t| !i.txs[t].loaded.writable.is_empty() || !i.txs[t].loaded.readonly.is_empty())
        .collect()
}

/// Prints one table row for the report and returns the verdict.
fn row(name: &str, i: &Input) -> (Verdict, Report) {
    let r = verify_core::verify(i);
    println!("ROW | {name} | {:?} | {}", r.verdict, codes(&r).join(", "));
    (r.verdict, r)
}

fn never_pass(name: &str, i: &Input) -> Report {
    let (v, r) = row(name, i);
    assert_ne!(v, Verdict::Pass, "{name}: {:#?}", show(&r));
    r
}

fn table_keys(i: &Input) -> Vec<[u8; 32]> {
    i.chain
        .lookup_tables
        .as_ref()
        .unwrap()
        .accounts
        .keys()
        .copied()
        .collect()
}

fn table_mut<'a>(i: &'a mut Input, k: &[u8; 32]) -> &'a mut fclient::ports::Account {
    i.chain
        .lookup_tables
        .as_mut()
        .unwrap()
        .accounts
        .get_mut(k)
        .unwrap()
        .as_mut()
        .unwrap()
}

#[test]
fn honest_later_table_states_still_pass() {
    for (shape, base) in both() {
        // extended after every transaction (append-only): PASS
        let mut i = base.clone();
        for k in table_keys(&i) {
            let a = table_mut(&mut i, &k);
            for n in 0..5u8 {
                a.data.extend_from_slice(&[0xA0 + n; 32]);
            }
        }
        let (v, r) = row(&format!("{shape}: tables extended after the season"), &i);
        assert_eq!(v, Verdict::Pass, "{:#?}", show(&r));
        // deactivated (deactivation slot set) but not yet closed: PASS
        let mut i = base.clone();
        for k in table_keys(&i) {
            let a = table_mut(&mut i, &k);
            a.data[4..12].copy_from_slice(&180u64.to_le_bytes());
        }
        let (v, r) = row(&format!("{shape}: tables deactivated (not closed)"), &i);
        assert_eq!(v, Verdict::Pass, "{:#?}", show(&r));
        // an unrelated extra table read: PASS
        let mut i = base.clone();
        let extra = table_mut(&mut i, &table_keys(&base)[0]).clone();
        i.chain
            .lookup_tables
            .as_mut()
            .unwrap()
            .accounts
            .insert([0x77; 32], Some(extra));
        let (v, r) = row(&format!("{shape}: an unrelated extra table read"), &i);
        assert_eq!(v, Verdict::Pass, "{:#?}", show(&r));
    }
}

#[test]
fn loaded_address_tampers_never_pass() {
    for (shape, base) in both() {
        let ls = lookups(&base);
        // writable <-> readonly swap within one record
        let t = *ls
            .iter()
            .find(|&&t| !base.txs[t].loaded.readonly.is_empty())
            .unwrap();
        let mut i = base.clone();
        let l = &mut i.txs[t].loaded;
        std::mem::swap(&mut l.writable[0], &mut l.readonly[0]);
        never_pass(&format!("{shape}: writable[0] <-> readonly[0]"), &i);
        // whole lists exchanged where the counts allow (2+2)
        if let Some(&t) = ls
            .iter()
            .find(|&&t| base.txs[t].loaded.readonly.len() == base.txs[t].loaded.writable.len())
        {
            let mut i = base.clone();
            let l = &mut i.txs[t].loaded;
            std::mem::swap(&mut l.writable, &mut l.readonly);
            never_pass(&format!("{shape}: writable list <-> readonly list"), &i);
        }
        // readonly order reversed
        let t2 = *ls
            .iter()
            .find(|&&t| base.txs[t].loaded.readonly.len() >= 2)
            .unwrap();
        let mut i = base.clone();
        i.txs[t2].loaded.readonly.reverse();
        never_pass(&format!("{shape}: readonly order reversed"), &i);
        // one record's loaded replaced by another record's (same counts)
        let (a, b) = ls
            .iter()
            .flat_map(|&a| ls.iter().map(move |&b| (a, b)))
            .find(|&(a, b)| {
                a != b
                    && base.txs[a].loaded.writable.len() == base.txs[b].loaded.writable.len()
                    && base.txs[a].loaded.readonly.len() == base.txs[b].loaded.readonly.len()
                    && base.txs[a].loaded != base.txs[b].loaded
            })
            .unwrap();
        let mut i = base.clone();
        i.txs[a].loaded = base.txs[b].loaded.clone();
        never_pass(
            &format!("{shape}: tx#{a} carries tx#{b}'s loadedAddresses"),
            &i,
        );
        // duplicate: a looked-up address = a static key (the fee payer)
        let mut i = base.clone();
        let d = vtx::decode(&i.txs[t].tx).unwrap();
        i.txs[t].loaded.writable[0] = d.static_keys[0];
        never_pass(&format!("{shape}: loaded writable = fee payer"), &i);
        // duplicate inside loaded
        let mut i = base.clone();
        let x = i.txs[t].loaded.writable[0];
        i.txs[t].loaded.readonly[0] = x;
        never_pass(&format!("{shape}: loaded readonly[0] = writable[0]"), &i);
        // the table's own address as a looked-up address
        let mut i = base.clone();
        let tk = d.lookups[0].account_key;
        i.txs[t].loaded.writable[0] = tk;
        never_pass(&format!("{shape}: loaded = the lookup table itself"), &i);
        // an extra / a missing address
        let mut i = base.clone();
        i.txs[t]
            .loaded
            .readonly
            .push(Address::new_from_array([9; 32]));
        never_pass(&format!("{shape}: one extra loaded address"), &i);
        let mut i = base.clone();
        i.txs[t].loaded.readonly.pop();
        never_pass(&format!("{shape}: one loaded address missing"), &i);
        // the failed v0 Muster's loaded forged (VT judges failed txs too)
        let f = *ls.iter().find(|&&t| base.txs[t].err.is_some()).unwrap();
        let mut i = base.clone();
        i.txs[f].loaded.writable[0] = Address::new_from_array([5; 32]);
        never_pass(&format!("{shape}: failed v0 tx's loaded forged"), &i);
        // loaded addresses added to a v1 record
        let v1 = (0..base.txs.len())
            .find(|&t| version(&base, t) == Version::V1)
            .unwrap();
        let mut i = base.clone();
        i.txs[v1]
            .loaded
            .writable
            .push(Address::new_from_array([3; 32]));
        never_pass(&format!("{shape}: loaded on a v1 record"), &i);
    }
}

#[test]
fn table_state_tampers_never_pass() {
    for (shape, base) in both() {
        let ks = table_keys(&base);
        // the two tables' states exchanged
        let mut i = base.clone();
        let a0 = table_mut(&mut i, &ks[0]).clone();
        let a1 = table_mut(&mut i, &ks[1]).clone();
        *table_mut(&mut i, &ks[0]) = a1;
        *table_mut(&mut i, &ks[1]) = a0;
        never_pass(&format!("{shape}: the two tables' states exchanged"), &i);
        // state tag 0 (uninitialized)
        let mut i = base.clone();
        table_mut(&mut i, &ks[0]).data[0] = 0;
        never_pass(&format!("{shape}: table state tag 0"), &i);
        // a stray byte (length not 56 + 32n)
        let mut i = base.clone();
        table_mut(&mut i, &ks[0]).data.push(0);
        never_pass(&format!("{shape}: table data + 1 byte"), &i);
        // one address of a table edited
        for k in &ks {
            let mut i = base.clone();
            let n = verify_core::vmsg::TABLE_META;
            let a = table_mut(&mut i, k);
            let last = a.data.len() - 32;
            for b in &mut a.data[n..n + 1] {
                *b ^= 1;
            }
            for b in &mut a.data[last..last + 1] {
                *b ^= 1;
            }
            never_pass(
                &format!("{shape}: first+last address of one table edited"),
                &i,
            );
        }
        // only one of the two tables read
        let mut i = base.clone();
        i.chain
            .lookup_tables
            .as_mut()
            .unwrap()
            .accounts
            .remove(&ks[0]);
        let r = never_pass(&format!("{shape}: one table not read"), &i);
        assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
        // closed as an account with 0 lamports and no data
        let mut i = base.clone();
        let a = table_mut(&mut i, &ks[0]);
        a.lamports = 0;
        a.data.clear();
        let r = never_pass(&format!("{shape}: table 0 lamports, no data"), &i);
        assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
        // read at a slot before the season's lookups, when the table was
        // shorter: index past the end
        let mut i = base.clone();
        i.chain.lookup_tables.as_mut().unwrap().slot = Some(1);
        for k in &ks {
            table_mut(&mut i, k)
                .data
                .truncate(verify_core::vmsg::TABLE_META + 32);
        }
        let r = never_pass(
            &format!("{shape}: tables read at slot 1 (1 address each)"),
            &i,
        );
        // verifier-alt-archive F3: read before the transactions, the index
        // is honestly past the end then: UNVERIFIABLE LookupTableStale (was
        // FAIL LookupMismatch), never PASS.
        assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
        assert!(
            r.findings
                .iter()
                .any(|f| f.check == "VT" && f.code == verify_core::codes::LOOKUP_TABLE_STALE),
            "{:#?}",
            show(&r)
        );
    }
}

/// A closed table's address re-funded by a plain System transfer (anyone
/// can send lamports to any address; the ALT program never signs for its
/// PDA, so no data or other owner can appear there): the archive is
/// honest, its tables are gone — UNVERIFIABLE is the right verdict; FAIL
/// here would let anyone fail an honest season for ~0.00089 SOL.
#[test]
fn a_closed_table_address_refunded_by_a_transfer_is_not_a_fail() {
    for (shape, base) in both() {
        let ks = table_keys(&base);
        let mut i = base.clone();
        let a = table_mut(&mut i, &ks[0]);
        a.lamports = 890_880;
        a.data.clear();
        a.owner = Address::default();
        let (v, r) = row(
            &format!("{shape}: closed table refunded (System, 0 data)"),
            &i,
        );
        assert_eq!(v, Verdict::Unverifiable, "{shape}: {:#?}", show(&r));
    }
}

#[test]
fn wire_tampers_never_pass() {
    let base = rpc_shaped();
    let ls = lookups(&base);
    let t = ls[0];
    let m = 1 + 64 * base.txs[t].tx[0] as usize;
    // every message version byte
    for b in 0x80u8..=0xff {
        if b == 0x80 {
            continue;
        }
        let mut i = base.clone();
        i.txs[t].tx[m] = b;
        let r = verify_core::verify(&i);
        assert_ne!(
            r.verdict,
            Verdict::Pass,
            "v0 prefix {b:#x}: {:#?}",
            show(&r)
        );
    }
    println!("ROW | no-post: v0 message prefix 0x81..=0xFF (127 cases) | never PASS | ");
    // every truncation of one v0 and one v1 wire
    let v1 = (0..base.txs.len())
        .find(|&t| version(&base, t) == Version::V1)
        .unwrap();
    for &t in &[t, v1] {
        for n in 0..base.txs[t].tx.len() {
            let mut i = base.clone();
            i.txs[t].tx.truncate(n);
            let r = verify_core::verify(&i);
            assert_ne!(r.verdict, Verdict::Pass, "tx#{t} truncated to {n}");
        }
    }
    println!("ROW | no-post: every truncation of a v0 and a v1 wire | never PASS | ");
    // the lookup's table key swapped to the other table in the signed bytes
    let d = vtx::decode(&base.txs[t].tx).unwrap();
    let VersionedMessage::V0(mut msg) = d.tx.message.clone() else {
        panic!()
    };
    let other = table_keys(&base)
        .into_iter()
        .map(Address::new_from_array)
        .find(|k| *k != msg.address_table_lookups[0].account_key)
        .unwrap();
    msg.address_table_lookups[0].account_key = other;
    let mut i = base.clone();
    i.txs[t].tx = vtx::wire(&VersionedTransaction {
        signatures: d.tx.signatures.clone(),
        message: VersionedMessage::V0(msg),
    })
    .unwrap();
    never_pass("no-post: lookup table key swapped in the signed bytes", &i);
    // an index past 255 cannot exist; past the table: forged index 200
    let VersionedMessage::V0(mut msg) = d.tx.message.clone() else {
        panic!()
    };
    msg.address_table_lookups[0].writable_indexes[0] = 200;
    let mut i = base.clone();
    i.txs[t].tx = vtx::wire(&VersionedTransaction {
        signatures: d.tx.signatures.clone(),
        message: VersionedMessage::V0(msg),
    })
    .unwrap();
    never_pass(
        "no-post: lookup index 200 (past the table) in the signed bytes",
        &i,
    );
}

#[test]
fn rent_assumed_is_still_reported() {
    for (shape, base) in both() {
        let mut i = base.clone();
        i.chain.rent = None;
        let (v, r) = row(&format!("{shape}: no Rent read (assumed 5,080)"), &i);
        // the recording's rate is 5,080: the assumed rate is right, PASS
        assert_eq!(v, Verdict::Pass, "{:#?}", show(&r));
        assert_eq!(
            r.rent
                .as_ref()
                .and_then(|x| x.get("source"))
                .and_then(|x| x.as_str()),
            Some("assumed"),
            "{:?}",
            r.rent
        );
        // plus a forged loaded address: still FAIL, and RentAssumed WARN
        // appears beside the VX/VG mismatch (#150 rule)
        let t = lookups(&i)[1];
        i.txs[t].loaded.writable[0] = Address::new_from_array([5; 32]);
        let (v, r) = row(&format!("{shape}: assumed rent + forged loaded"), &i);
        assert_eq!(v, Verdict::Fail, "{:#?}", show(&r));
        println!(
            "  {shape}: RentAssumed WARN present: {}",
            r.findings.iter().any(|f| f.code == "RentAssumed")
        );
    }
}
