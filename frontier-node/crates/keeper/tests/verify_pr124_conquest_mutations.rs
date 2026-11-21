//! verify-pr124 (independent review of devnet gap P14 option (a)): mutations
//! of the REAL Free City conquest records of the pinned devnet `.so`
//! (`da3dc1aa…`, the committed verifier recordings) that keeper A's feed guard
//! must refuse (both indexes latch, nothing applied), and honest transactions
//! (single, multi-instruction, replayed at a later seq) that it must read.
//! Written apart from the PR's own `expedition_feed_guard::p14` tests: forged
//! receipts with a recomputed operation id, interleaved pairs, a target
//! moved to a legacy province, records outside the program's frame, a
//! conquest pair mixed with expedition records in one instruction and two
//! honest instructions in one transaction. Literal bytes only: no key, no
//! signing, no network.
#![cfg(feature = "playable-lane")]
use std::io::Read as _;

use base64::Engine as _;
use fclient::addr::Addresses;
use fclient::ports::{Cursor, Signature, TxRecord};
use fclient::Address;
use frontier_abi::world_index::coord::WideCoord;
use frontier_abi::world_index::event::{self as ev, conquest as cr, WideRecord};
use frontier_abi::world_index::key::ProvinceKey;
use keeper_core::feedguard::{self, ConquestFact as C, WideScope};
use keeper_core::landindex::LandIndex;
use keeper_core::playindex::PlayIndex;
use serde_json::Value;

const FIXTURES: [&str; 3] = [
    "playable-expedition-whole.json.gz",
    "playable-cov-siege.json.gz",
    "playable-cov-closes.json.gz",
];

const DEPART: u8 = 0;
const DECLARE: u8 = 12;
const RWC: u8 = 13;
const CAPTURE: u8 = 14;
const SIEGE: u8 = 15;
const CLOSE_CONQUEST: u8 = 16;
const ESCROW: u8 = 17;
const RESERVATION: u8 = 18;

fn load_path(p: &std::path::Path) -> (Addresses, Vec<TxRecord>) {
    let name = p.display().to_string();
    let mut s = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(p).expect(&name))
        .read_to_string(&mut s)
        .unwrap();
    let v: Value = serde_json::from_str(&s).unwrap();
    let program: Address = v["config"]["program"].as_str().unwrap().parse().unwrap();
    let addrs = Addresses::new(program, v["config"]["season_id"].as_u64().unwrap());
    let b = base64::engine::general_purpose::STANDARD;
    let txs = v["txs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| TxRecord {
            seq: t["seq"].as_u64().unwrap(),
            slot: t["slot"].as_u64().unwrap(),
            signature: t["signature"]
                .as_str()
                .unwrap()
                .parse::<Signature>()
                .unwrap(),
            block_time: t["block_time"].as_i64().unwrap_or(0),
            tx: b.decode(t["tx"].as_str().unwrap()).unwrap(),
            logs: t["logs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap().to_string())
                .collect(),
            err: t["err"].as_str().map(String::from),
            code: None,
            units: t["units"].as_u64().unwrap_or(0),
            fee: 0,
            post: vec![],
        })
        .collect();
    (addrs, txs)
}

fn kind_of(tx: &TxRecord, program: &Address) -> Option<u8> {
    let t = fclient::tx::from_wire(&tx.tx).ok()?;
    let keys = &t.message.account_keys;
    t.message.instructions.iter().find_map(|ix| {
        (keys.get(ix.program_id_index as usize) == Some(program)
            && ix.data.len() >= 4
            && ix.data[1] == 0xFF
            && ix.data[2] == 2)
            .then(|| ix.data[3])
    })
}

fn all() -> Vec<(Addresses, u8, TxRecord)> {
    let mut out = vec![];
    for f in FIXTURES {
        let (a, txs) = load_path(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/verify")
                .join(f),
        );
        for t in txs.into_iter().filter(|t| t.err.is_none()) {
            if let Some(k) = kind_of(&t, &a.program) {
                out.push((a.clone(), k, t));
            }
        }
    }
    out
}

fn pick(k: u8) -> (Addresses, TxRecord) {
    all()
        .into_iter()
        .find(|(_, kk, _)| *kk == k)
        .map(|(a, _, t)| (a, t))
        .unwrap_or_else(|| panic!("kind {k} in the recordings"))
}

fn enc(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn data(t: &TxRecord) -> Vec<(usize, Vec<u8>, Vec<u8>)> {
    let b = base64::engine::general_purpose::STANDARD;
    t.logs
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let p: Vec<&str> = l
                .strip_prefix("Program data: ")?
                .split_whitespace()
                .collect();
            (p.len() == 2).then(|| (i, b.decode(p[0]).unwrap(), b.decode(p[1]).unwrap()))
        })
        .collect()
}

fn line(tag: &[u8], body: &[u8]) -> String {
    format!("Program data: {} {}", enc(tag), enc(body))
}

fn set(t: &TxRecord, i: usize, tag: &[u8], body: &[u8]) -> TxRecord {
    let mut x = t.clone();
    x.logs[i] = line(tag, body);
    x
}

fn rec(t: &TxRecord, tag: &[u8], kind: Option<u8>) -> (usize, Vec<u8>) {
    data(t)
        .into_iter()
        .find(|(_, tg, b)| tg == tag && kind.is_none_or(|k| b[1] == k))
        .map(|(i, _, b)| (i, b))
        .unwrap_or_else(|| panic!("{} {kind:?}", String::from_utf8_lossy(tag)))
}

fn find(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len())
        .position(|w| w == needle)
        .expect("sub-slice")
}

fn facts(a: &Addresses, t: &TxRecord) -> Result<feedguard::Bodies, String> {
    let scope = WideScope::of(a).unwrap();
    feedguard::bodies_scoped(t, &a.program, Some(&scope))
}

/// Refused by the reader; BOTH indexes latch, nothing applied, cursor not moved, latch sticky.
fn latches(a: &Addresses, t: &TxRecord, what: &str) {
    let r = facts(a, t);
    assert!(
        r.is_err(),
        "{what}: must be refused, got {:?}",
        r.map(|b| b.conquest)
    );
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    land.ingest_page(std::slice::from_ref(t), a);
    play.ingest_page(std::slice::from_ref(t), a);
    assert!(land.feed.blocked().is_some(), "{what}: land latches");
    assert!(play.feed.blocked().is_some(), "{what}: play latches");
    assert_eq!(play.cursor, Cursor(0), "{what}: cursor");
    assert!(play.touched.is_empty(), "{what}: nothing applied");
    let mut honest = t.clone();
    honest.seq += 1;
    assert_eq!(
        play.ingest_page(std::slice::from_ref(&honest), a),
        0,
        "{what}: sticky"
    );
    eprintln!("LATCH {what}: {}", r.unwrap_err());
}

/// Read by both indexes without a latch; the reader's conquest facts.
fn reads(a: &Addresses, t: &TxRecord, what: &str) -> feedguard::Bodies {
    let b = facts(a, t).unwrap_or_else(|e| panic!("{what}: {e}"));
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    land.ingest_page(std::slice::from_ref(t), a);
    play.ingest_page(std::slice::from_ref(t), a);
    assert!(land.feed.blocked().is_none(), "{what}: land");
    assert!(play.feed.blocked().is_none(), "{what}: play");
    assert_eq!(play.cursor, Cursor(t.seq), "{what}");
    b
}

/// A receipt with `action` and a RECOMPUTED operation id (structurally valid).
fn receipt_with(old: &[u8], action: u8) -> Vec<u8> {
    let r = cr::Receipt::decode(old).unwrap();
    // (Receipt::new refuses an invalid action: build the bytes by hand for those)
    match cr::Receipt::new(action, r.outcome, r.input, r.output) {
        Ok(n) => n.encode().to_vec(),
        Err(_) => {
            let mut b = old.to_vec();
            b[1] = action;
            b
        }
    }
}

/// V0 honest: every real conquest transaction is read, by both indexes, with no latch.
#[test]
fn v0_every_honest_conquest_tx_is_read() {
    let mut n = std::collections::BTreeMap::<u8, usize>::new();
    for (a, k, t) in all() {
        if k < DECLARE {
            continue;
        }
        let b = reads(&a, &t, &format!("kind {k} seq {}", t.seq));
        assert!(!b.conquest.is_empty(), "kind {k}: a conquest fact");
        assert!(b.expedition.is_empty(), "kind {k}: no expedition fact");
        *n.entry(k).or_default() += 1;
    }
    eprintln!("honest conquest txs read: {n:?}");
    assert_eq!(n.len(), 7, "{n:?}");
}

/// V1 forged receipts: the action byte changed (operation id stale), and the action changed WITH a recomputed
/// operation id in the target alone, and in target and source together (a kind/action mismatch).
#[test]
fn v1_forged_receipts() {
    let (a, t) = pick(DECLARE);
    let (ti, tb) = rec(&t, b"PSW1", Some(18));
    let (si, sb) = rec(&t, b"PS2", Some(145));
    let w = WideRecord::decode(&tb).unwrap();
    let off = find(&tb, w.payload);
    let soff = find(&sb, w.payload);
    // (a) one action byte flipped, the op id stale
    let mut x = tb.clone();
    x[off + 1] ^= cr::DECLARE ^ cr::RESERVE;
    latches(
        &a,
        &set(&t, ti, b"PSW1", &x),
        "DeclareSiege: action byte flipped, op id stale",
    );
    // (b) RESERVE -> DECLARE with a recomputed op id in the target only: target and source disagree
    for action in [cr::DECLARE, cr::RESOLVE, cr::CAPTURE, 0, 10] {
        let r = receipt_with(w.payload, action);
        if r == w.payload {
            continue;
        }
        let mut x = tb.clone();
        x[off..off + cr::RECEIPT_LEN].copy_from_slice(&r);
        latches(
            &a,
            &set(&t, ti, b"PSW1", &x),
            &format!("DeclareSiege: target receipt action {action} recomputed, source unchanged"),
        );
        // (c) the same receipt in BOTH: a consistent forgery; only a debit action may pass
        let mut y = sb.clone();
        y[soff..soff + cr::RECEIPT_LEN].copy_from_slice(&r);
        let m = set(&set(&t, ti, b"PSW1", &x), si, b"PS2", &y);
        if cr::debit_action(action) {
            // DECLARE <-> RESERVE with a recomputed id is structurally valid: the reader cannot tell it from the
            // chain's bytes (the fact is a hint the duties re-read; the program is the authority)
            let b = facts(&a, &m);
            eprintln!("CONSISTENT {action}: {:?}", b.as_ref().map(|b| &b.conquest));
        } else {
            latches(
                &a,
                &m,
                &format!("DeclareSiege: action {action} in both target and source"),
            );
        }
    }
}

/// V2 half of a pair: the target removed (the source alone), the source replaced by an unrelated conquest record.
#[test]
fn v2_half_pairs() {
    for k in [DECLARE, CAPTURE] {
        let (a, t) = pick(k);
        let (ti, _) = rec(&t, b"PSW1", None);
        let mut x = t.clone();
        x.logs.remove(ti);
        latches(&a, &x, &format!("kind {k}: the source record alone"));
    }
    let (a, t) = pick(DECLARE);
    let (_, r) = pick(RWC);
    let (_, rb) = rec(&r, b"PSW1", Some(20));
    let (si, _) = rec(&t, b"PS2", Some(145));
    latches(
        &a,
        &set(&t, si, b"PSW1", &rb),
        "DeclareSiege: its debit replaced by a ResolveWithConquest record",
    );
}

/// V3 reordered / interleaved: source before target; an unrelated conquest record between the two parts.
#[test]
fn v3_reordered_and_interleaved() {
    for k in [DECLARE, CAPTURE] {
        let (a, t) = pick(k);
        let (ti, tb) = rec(&t, b"PSW1", None);
        let (si, sb) = rec(&t, b"PS2", Some(145));
        let x = set(&set(&t, ti, b"PS2", &sb), si, b"PSW1", &tb);
        latches(&a, &x, &format!("kind {k}: source before target"));
        let (_, r) = pick(RWC);
        let (_, rb) = rec(&r, b"PSW1", Some(20));
        let mut y = t.clone();
        y.logs.insert(si, line(b"PSW1", &rb));
        latches(
            &a,
            &y,
            &format!("kind {k}: a ResolveWithConquest record between target and source"),
        );
    }
}

/// V4 truncation: the log list cut ("Log truncated", the frame's end gone), a body short by one byte.
#[test]
fn v4_truncation() {
    for k in [DECLARE, RWC, SIEGE, ESCROW, CLOSE_CONQUEST, RESERVATION] {
        let (a, t) = pick(k);
        let mut x = t.clone();
        x.logs.push("Log truncated".into());
        latches(&a, &x, &format!("kind {k}: Log truncated"));
        let mut y = t.clone();
        let end = y
            .logs
            .iter()
            .rposition(|l| l == &format!("Program {} success", a.program))
            .unwrap();
        y.logs.truncate(end);
        latches(&a, &y, &format!("kind {k}: the program frame never closes"));
        for (i, tag, body) in data(&t) {
            latches(
                &a,
                &set(&t, i, &tag, &body[..body.len() - 1]),
                &format!(
                    "kind {k}: {} short by one byte",
                    String::from_utf8_lossy(&tag)
                ),
            );
        }
    }
}

/// V5 wrong account: the target re-encoded onto a LEGACY province of this world, onto a wide province of another
/// world; PSWC naming another Season; read by a keeper of another program id.
#[test]
fn v5_wrong_account() {
    let (a, t) = pick(RWC);
    let (ti, tb) = rec(&t, b"PSW1", Some(20));
    let w = WideRecord::decode(&tb).unwrap();
    let key = ProvinceKey::from_bytes(w.key).unwrap();
    let links: Vec<_> = w.links.iter().flatten().copied().collect();
    // (a) the same record on the legacy province (0, 0) of the same world
    let legacy = ProvinceKey::new(key.world(), WideCoord::checked(0, 0).unwrap());
    let x = ev::encode(w.kind, w.bell, &legacy.to_bytes(), w.payload, &links).unwrap();
    latches(
        &a,
        &set(&t, ti, b"PSW1", &x),
        "ResolveWithConquest on a legacy province",
    );
    // (b) a neighbouring wide coordinate of ANOTHER world id
    let mut other: [u8; 32] = key.to_bytes()[1..33].try_into().unwrap();
    other[0] ^= 1;
    if let Ok(wid) = frontier_abi::world_index::key::WorldId::new(other) {
        let k2 = ProvinceKey::new(wid, key.coord());
        let y = ev::encode(w.kind, w.bell, &k2.to_bytes(), w.payload, &links).unwrap();
        latches(
            &a,
            &set(&t, ti, b"PSW1", &y),
            "ResolveWithConquest of another world",
        );
    }
    // (c) PSWC naming another Season
    let (a2, e) = pick(ESCROW);
    let (ei, eb) = rec(&e, b"PSWC", None);
    let mut z = eb.clone();
    z[1] ^= 0x55;
    latches(
        &a2,
        &set(&e, ei, b"PSWC", &z),
        "CloseCaptureEscrow of another Season",
    );
    // (d) the transaction read by a keeper of another program: no frame of its program at all
    let other_prog = Addresses::new(Address::new_from_array([7; 32]), a.season_id);
    // (the records are in ANOTHER program's frame: not this program's records, so nothing is read or applied)
    let r = feedguard::bodies_scoped(&t, &other_prog.program, WideScope::of(&other_prog).as_ref())
        .expect("no record of this program");
    assert!(r.conquest.is_empty() && r.ps2.is_empty() && r.wide.is_empty());
    let mut play = PlayIndex::default();
    play.ingest_page(std::slice::from_ref(&t), &other_prog);
    assert!(
        play.touched.is_empty(),
        "another program's records apply nothing"
    );
}

/// V6 replay: a record twice in one transaction, a whole pair twice, the transaction at a later seq.
#[test]
fn v6_replay() {
    let (a, t) = pick(RWC);
    let (ti, _) = rec(&t, b"PSW1", Some(20));
    let mut x = t.clone();
    x.logs.insert(ti + 1, t.logs[ti].clone());
    latches(&a, &x, "ResolveWithConquest record twice");
    let (a, t) = pick(DECLARE);
    let (ti, _) = rec(&t, b"PSW1", Some(18));
    let (si, _) = rec(&t, b"PS2", Some(145));
    let mut y = t.clone();
    y.logs.insert(si + 1, t.logs[si].clone());
    y.logs.insert(si + 1, t.logs[ti].clone());
    latches(&a, &y, "DeclareSiege pair twice");
    // the honest tx at a later seq: read again, the same hint (idempotent), no latch
    let mut play = PlayIndex::default();
    play.ingest_page(std::slice::from_ref(&t), &a);
    let first = play.touched.clone();
    let mut t2 = t.clone();
    t2.seq += 1_000;
    play.ingest_page(std::slice::from_ref(&t2), &a);
    assert!(play.feed.blocked().is_none());
    assert_eq!(play.touched, first, "a replay adds no new hint");
    eprintln!("DeclareSiege replay at a later seq: no latch, touched {first:?}");
}

/// V7 unknown kinds / versions / tags.
#[test]
fn v7_unknown_kind_version_tag() {
    let (a, t) = pick(RWC);
    let (ti, tb) = rec(&t, b"PSW1", Some(20));
    for k in [17u8, 19, 23, 27, 0, 255] {
        let mut x = tb.clone();
        x[1] = k;
        latches(
            &a,
            &set(&t, ti, b"PSW1", &x),
            &format!("PSW1 20 retagged kind {k}"),
        );
    }
    let mut v = tb.clone();
    v[0] ^= 3;
    latches(&a, &set(&t, ti, b"PSW1", &v), "PSW1 version changed");
    latches(&a, &set(&t, ti, b"PSWX", &tb), "unknown tag PSWX");
    latches(
        &a,
        &set(&t, ti, b"PS2", &tb),
        "the PSW1 body under the PS2 tag",
    );
    // PSWC: version 2; an ESCROW_CLOSE receipt replaced by a valid TABLE_CLOSE one (recomputed id)
    let (a2, e) = pick(ESCROW);
    let (ei, eb) = rec(&e, b"PSWC", None);
    let mut z = eb.clone();
    z[0] = 2;
    latches(&a2, &set(&e, ei, b"PSWC", &z), "PSWC version 2");
    let mut z = eb.clone();
    let r = receipt_with(&eb[69..], cr::TABLE_CLOSE);
    z[69..].copy_from_slice(&r);
    latches(
        &a2,
        &set(&e, ei, b"PSWC", &z),
        "PSWC with a TABLE_CLOSE receipt",
    );
    // a PSWR body built from the PSWC's bytes (wrong length) and a PSWR with a FAILED receipt
    latches(&a2, &set(&e, ei, b"PSWR", &eb), "PSWC body under PSWR");
    let mut pswr = vec![1u8];
    pswr.extend_from_slice(&eb[1..33]); // this Season
    pswr.extend_from_slice(&[0x11; 32]); // a table
    pswr.extend_from_slice(&1u32.to_le_bytes());
    pswr.extend_from_slice(&eb[65..69]); // a bell
    pswr.extend_from_slice(&receipt_with(&eb[69..], cr::FAILED));
    assert_eq!(pswr.len(), 173);
    latches(
        &a2,
        &set(&e, ei, b"PSWR", &pswr),
        "PSWR with a FAILED receipt",
    );
}

/// V8 mixed with expedition / PSW1 records in ONE instruction frame: latch. Two honest instructions (an expedition
/// Depart and a ResolveWithConquest) in ONE transaction: both read.
#[test]
fn v8_mixed() {
    let (a, d) = pick(DECLARE);
    let (_, dep) = pick(DEPART);
    let (_, depb) = rec(&dep, b"PS2", Some(146));
    let (si, _) = rec(&d, b"PS2", Some(145));
    // (a) an expedition record between DeclareSiege's target and its debit
    let mut x = d.clone();
    x.logs.insert(si, line(b"PS2", &depb));
    latches(&a, &x, "an expedition PS2 146 between DeclareSiege's parts");
    // (b) the debit replaced by an expedition PSW1 25 (settlement wide part) alone
    let (_, sm) = all()
        .into_iter()
        .find(|(_, k, _)| *k == 6)
        .map(|(a, _, t)| (a, t))
        .unwrap();
    let (_, w25) = rec(&sm, b"PSW1", Some(25));
    latches(
        &a,
        &set(&d, si, b"PSW1", &w25),
        "DeclareSiege's debit replaced by a PSW1 25",
    );
    // (c) a conquest target appended after an honest Depart's record in the Depart's frame
    let (_, r) = pick(RWC);
    let (_, rb) = rec(&r, b"PSW1", Some(20));
    let (di, _) = rec(&dep, b"PS2", Some(146));
    let mut y = dep.clone();
    y.logs.insert(di + 1, line(b"PSW1", &rb));
    let res = facts(&a, &y);
    // (the program never logs both in one instruction, but each record is decoded exactly on its own: report it)
    eprintln!(
        "Depart frame + a real PSW1 20: {:?}",
        res.as_ref().map(|b| (b.expedition.len(), b.conquest.len()))
    );
    // (d) two honest top-level instructions in ONE transaction: Depart's frame then RWC's frame
    let frame = |t: &TxRecord| -> Vec<String> {
        let open = format!("Program {} invoke [1]", a.program);
        let close = format!("Program {} success", a.program);
        let s = t.logs.iter().position(|l| l == &open).unwrap();
        let e = t.logs.iter().rposition(|l| l == &close).unwrap();
        t.logs[s..=e].to_vec()
    };
    let mut z = r.clone();
    z.logs = [frame(&dep), frame(&r)].concat();
    let b = reads(&a, &z, "Depart + ResolveWithConquest in one transaction");
    assert_eq!((b.expedition.len(), b.conquest.len()), (1, 1));
}

/// V9 frames: a record logged OUTSIDE the program's frame is not the program's; a pair split across the frame
/// boundary is a target without its source.
#[test]
fn v9_outside_the_frame() {
    let (a, t) = pick(DECLARE);
    let (si, _) = rec(&t, b"PS2", Some(145));
    let mut x = t.clone();
    let l = x.logs.remove(si);
    x.logs.push(l);
    latches(&a, &x, "DeclareSiege's debit moved after the frame closes");
    // the whole ResolveWithConquest record outside the frame: not a program record (ignored, no latch)
    let (a, r) = pick(RWC);
    let (ri, _) = rec(&r, b"PSW1", Some(20));
    let mut y = r.clone();
    let l = y.logs.remove(ri);
    y.logs.push(l);
    let b = reads(&a, &y, "RWC record outside the frame");
    assert!(b.conquest.is_empty(), "not the program's record");
}

/// V10 consistency: each conquest kind's honest facts name the target the transaction wrote, and only a legacy
/// source adds a legacy hint (`touched`).
#[test]
fn v10_facts_match_the_records() {
    for (a, k, t) in all() {
        if k < DECLARE {
            continue;
        }
        let b = facts(&a, &t).unwrap();
        let mut play = PlayIndex::default();
        play.ingest_page(std::slice::from_ref(&t), &a);
        let legacy: Vec<_> = b.conquest.iter().filter_map(C::legacy_home).collect();
        for h in &legacy {
            assert!(play.touched.contains(h), "kind {k}: {h:?} re-read");
        }
        let has145 = data(&t)
            .iter()
            .any(|(_, tg, bd)| tg == b"PS2" && bd[1] == 145);
        assert_eq!(
            !legacy.is_empty(),
            has145,
            "kind {k}: a legacy hint iff PS2 145"
        );
    }
}
