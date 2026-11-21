//! verify-pr121 (independent review of devnet gap P10): mutations of the REAL
//! expedition records of the pinned devnet `.so` (`da3dc1aa…`, the committed
//! verifier recordings) that keeper A's feed guard must refuse (latch), and the
//! honest records of all 19 dispatch kinds classified as the PR says (kinds
//! 0..=11 applied; the Free City conquest kinds 12..=18 latched by design
//! until devnet-guard-conquest, P14 option (a), made the guard read them
//! exactly: now applied too, verify-pr124). Literal bytes only: no key, no
//! signing, no network.
#![cfg(feature = "playable-lane")]
use std::collections::BTreeMap;
use std::io::Read as _;

use base64::Engine as _;
use fclient::addr::Addresses;
use fclient::ports::{Cursor, Signature, TxRecord};
use fclient::Address;
use frontier_abi::world_index::key::{HOST_REF_LEN, PROVINCE_KEY_LEN};
use keeper_core::feedguard::{self, WideScope};
use keeper_core::landindex::LandIndex;
use keeper_core::playindex::PlayIndex;
use serde_json::Value;

const FIXTURES: [&str; 8] = [
    "playable-expedition-whole.json.gz",
    "playable-cov-camp.json.gz",
    "playable-cov-failure.json.gz",
    "playable-cov-forfeit.json.gz",
    "playable-cov-retained.json.gz",
    "playable-cov-terminal.json.gz",
    "playable-cov-siege.json.gz",
    "playable-cov-closes.json.gz",
];

fn load(name: &str) -> (Addresses, Vec<TxRecord>) {
    load_path(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/verify")
            .join(name),
    )
}

fn load_path(p: &std::path::Path) -> (Addresses, Vec<TxRecord>) {
    let name = p.display().to_string();
    let name = name.as_str();
    let mut s = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(p).expect(name))
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

/// The wrapper's dispatch kind (`[tag, 0xff, 2, kind]`) of the first instruction to the program.
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
        let (a, txs) = load(f);
        for t in txs.into_iter().filter(|t| t.err.is_none()) {
            if let Some(k) = kind_of(&t, &a.program) {
                out.push((a.clone(), k, t));
            }
        }
    }
    out
}

fn enc(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// `(log index, tag, body)` of every `Program data:` line.
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

/// The record of `t` with `tag` and first body byte pair `(VERSION, kind)` in `kinds`.
fn rec(t: &TxRecord, tag: &[u8], kinds: &[u8]) -> (usize, Vec<u8>) {
    data(t)
        .into_iter()
        .find(|(_, tg, b)| tg == tag && (kinds.is_empty() || kinds.contains(&b[1])))
        .map(|(i, _, b)| (i, b))
        .unwrap_or_else(|| panic!("{} {kinds:?}", String::from_utf8_lossy(tag)))
}

/// Refused by the guard, latching BOTH indexes, nothing applied, cursor not moved.
fn latches(a: &Addresses, t: &TxRecord, what: &str) {
    let scope = WideScope::of(a).expect("playable-lane scope");
    let r = feedguard::bodies_scoped(t, &a.program, Some(&scope));
    assert!(
        r.is_err(),
        "{what}: must be refused, got {:?}",
        r.map(|b| b.wide)
    );
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    land.ingest_page(std::slice::from_ref(t), a);
    play.ingest_page(std::slice::from_ref(t), a);
    assert!(land.feed.blocked().is_some(), "{what}: land latches");
    assert!(play.feed.blocked().is_some(), "{what}: play latches");
    assert_eq!(play.cursor, Cursor(0), "{what}");
    assert!(
        play.expeditions.is_empty() && play.touched.is_empty(),
        "{what}: nothing applied"
    );
    // the latch is sticky: the honest next page is not read
    let n = play.ingest_page(std::slice::from_ref(t), a);
    assert_eq!(n, 0, "{what}: sticky");
}

fn pick(all: &[(Addresses, u8, TxRecord)], k: u8) -> (Addresses, TxRecord) {
    all.iter()
        .find(|(_, kk, _)| *kk == k)
        .map(|(a, _, t)| (a.clone(), t.clone()))
        .unwrap_or_else(|| panic!("kind {k}"))
}

const DEPART: u8 = 0;
const SETTLE_ORIGIN: u8 = 1;
const REVEAL: u8 = 2;
const GATHER: u8 = 3;
const DISSOLVE: u8 = 4;
const RETURN: u8 = 5;
const SETTLE_MEMBER: u8 = 6;
const SETTLE_CAMP: u8 = 7;
const FAILURE: u8 = 8;
const FORFEIT: u8 = 9;
const TERMINAL: u8 = 10;
const RETAINED: u8 = 11;

/// H: every honest successful wrapper transaction of the recordings, all 19 kinds.
#[test]
fn h_honest_records_of_all_19_kinds() {
    let mut applied: BTreeMap<u8, usize> = BTreeMap::new();
    let mut conquest: BTreeMap<u8, usize> = BTreeMap::new();
    for (a, k, t) in all() {
        let scope = WideScope::of(&a).unwrap();
        let r = feedguard::bodies_scoped(&t, &a.program, Some(&scope));
        let mut play = PlayIndex::default();
        play.ingest_page(std::slice::from_ref(&t), &a);
        if k <= 11 {
            let b = r.unwrap_or_else(|e| panic!("kind {k} seq {}: {e}", t.seq));
            assert_eq!(b.expedition.len(), 1, "kind {k}");
            assert!(play.feed.blocked().is_none(), "kind {k}");
            assert_eq!(play.cursor, Cursor(t.seq));
            *applied.entry(k).or_default() += 1;
        } else {
            // (P14 option (a), verify-pr124: read exactly, no latch)
            let b = r.unwrap_or_else(|e| panic!("conquest kind {k} seq {}: {e}", t.seq));
            assert!(
                !b.conquest.is_empty() && b.expedition.is_empty(),
                "kind {k}"
            );
            assert!(play.feed.blocked().is_none(), "kind {k}");
            assert_eq!(play.cursor, Cursor(t.seq));
            *conquest.entry(k).or_default() += 1;
        }
        // and with no scope (a default-build keeper) every one of them latches
        assert!(
            feedguard::bodies_scoped(&t, &a.program, None).is_err(),
            "kind {k}"
        );
    }
    eprintln!("applied {applied:?} conquest {conquest:?}");
    assert_eq!(applied.len(), 12, "{applied:?}");
    assert_eq!(conquest.len(), 7, "{conquest:?}");
}

/// M1 forged kind: the kind byte of a real record changed (to another expedition kind, to an unknown one).
#[test]
fn m1_forged_kind() {
    let all = all();
    let (a, t) = pick(&all, DEPART);
    let (i, b) = rec(&t, b"PS2", &[146]);
    for k in [145u8, 147, 148, 149, 150, 255, 0] {
        let mut x = b.clone();
        x[1] = k;
        latches(
            &a,
            &set(&t, i, b"PS2", &x),
            &format!("Depart PS2 146 → kind {k}"),
        );
    }
    let (a, t) = pick(&all, REVEAL);
    let (i, b) = rec(&t, b"PS2", &[147]);
    for k in [146u8, 148, 149, 150] {
        let mut x = b.clone();
        x[1] = k;
        latches(
            &a,
            &set(&t, i, b"PS2", &x),
            &format!("Reveal PS2 147 → kind {k}"),
        );
    }
    // the action byte (Depart ↔ SettleOrigin) forged
    let (a, t) = pick(&all, DEPART);
    let (i, b) = rec(&t, b"PS2", &[146]);
    let mut x = b.clone();
    x[7] = 2;
    latches(&a, &set(&t, i, b"PS2", &x), "Depart claiming SettleOrigin");
    // a PSW1 25 relabelled 26 and a PSW1 26 relabelled 25
    let (a, t) = pick(&all, SETTLE_MEMBER);
    let (wi, wb) = rec(&t, b"PSW1", &[25]);
    let mut x = wb.clone();
    x[1] = 26;
    latches(&a, &set(&t, wi, b"PSW1", &x), "PSW1 25 → 26");
    let (a, t) = pick(&all, DISSOLVE);
    let (wi, wb) = rec(&t, b"PSW1", &[26]);
    let mut x = wb.clone();
    x[1] = 25;
    latches(&a, &set(&t, wi, b"PSW1", &x), "PSW1 26 → 25");
}

/// M2 half of a pair: each part of 148+25 and 149+26 alone.
#[test]
fn m2_half_of_a_pair() {
    let all = all();
    for (k, pk, wk) in [
        (SETTLE_MEMBER, 148u8, 25u8),
        (SETTLE_CAMP, 148, 25),
        (DISSOLVE, 149, 26),
        (RETURN, 149, 26),
    ] {
        let (a, t) = pick(&all, k);
        let (pi, _) = rec(&t, b"PS2", &[pk]);
        let (wi, _) = rec(&t, b"PSW1", &[wk]);
        let mut x = t.clone();
        x.logs.remove(wi);
        latches(&a, &x, &format!("kind {k}: PS2 {pk} alone"));
        let mut x = t.clone();
        x.logs.remove(pi);
        latches(&a, &x, &format!("kind {k}: PSW1 {wk} alone"));
    }
}

/// M3 reordered pair: the PSW1 part logged before its PS2 part.
#[test]
fn m3_reordered_pair() {
    let all = all();
    for (k, pk, wk) in [
        (SETTLE_MEMBER, 148u8, 25u8),
        (SETTLE_CAMP, 148, 25),
        (DISSOLVE, 149, 26),
        (RETURN, 149, 26),
    ] {
        let (a, t) = pick(&all, k);
        let (pi, pb) = rec(&t, b"PS2", &[pk]);
        let (wi, wb) = rec(&t, b"PSW1", &[wk]);
        let x = set(&set(&t, pi, b"PSW1", &wb), wi, b"PS2", &pb);
        latches(&a, &x, &format!("kind {k}: PSW1 {wk} before PS2 {pk}"));
    }
}

/// M4 truncated or extended body, every expedition format.
#[test]
fn m4_truncated_body() {
    let all = all();
    for (k, tag, kinds) in [
        (DEPART, &b"PS2"[..], &[146u8][..]),
        (SETTLE_ORIGIN, b"PS2", &[146]),
        (REVEAL, b"PS2", &[147]),
        (GATHER, b"PS2", &[147]),
        (SETTLE_MEMBER, b"PS2", &[148]),
        (SETTLE_MEMBER, b"PSW1", &[25]),
        (DISSOLVE, b"PS2", &[149]),
        (DISSOLVE, b"PSW1", &[26]),
        (FAILURE, b"PSFF", &[]),
        (FORFEIT, b"PSFF", &[]),
        (RETAINED, b"PSFF", &[]),
        (TERMINAL, b"PSFT", &[]),
    ] {
        let (a, t) = pick(&all, k);
        let (i, b) = rec(&t, tag, kinds);
        for cut in [0usize, 1, 2, 10, b.len() / 2, b.len() - 41, b.len() - 1] {
            latches(
                &a,
                &set(&t, i, tag, &b[..cut]),
                &format!("kind {k}: {cut}/{}", b.len()),
            );
        }
        let mut long = b.clone();
        long.extend([0u8; 41]);
        latches(
            &a,
            &set(&t, i, tag, &long),
            &format!("kind {k}: one extra link"),
        );
        // a body that is not base64 at all
        let mut x = t.clone();
        x.logs[i] = format!("Program data: {} !!notbase64!!", enc(tag));
        latches(&a, &x, &format!("kind {k}: not base64"));
        // a third field after the body
        let mut x = t.clone();
        x.logs[i] = format!("{} {}", line(tag, &b), enc(b"x"));
        latches(&a, &x, &format!("kind {k}: a third field"));
    }
}

/// M5 a record naming another account: another holding, another transit slot / external, another
/// Season (another world), and a settlement's PS2 part paired with ANOTHER settlement's PSW1 part.
#[test]
fn m5_record_for_another_account() {
    let all = all();
    let (a, t) = pick(&all, DEPART);
    let (i, b) = rec(&t, b"PS2", &[146]);
    let host = 10;
    let citizen = host + HOST_REF_LEN;
    let holding = citizen + 32;
    let origin = holding + 32;
    let province = origin + PROVINCE_KEY_LEN;
    let external = province + 32;
    for (what, at) in [
        ("citizen", citizen),
        ("holding", holding),
        ("province", province),
        ("external", external),
    ] {
        let mut x = b.clone();
        // the bytes of another real account of the same Season: the program id's
        x[at..at + 32].copy_from_slice(a.program.as_ref());
        if what == "citizen" {
            // (the citizen is not derived from the host in the codec; it is the signer's account. A
            //  forged citizen alone is accepted by the codec when it differs from the other three:
            //  the guard applies no citizen-derived fact, so this is noted, not required)
            let scope = WideScope::of(&a).unwrap();
            let r = feedguard::bodies_scoped(&set(&t, i, b"PS2", &x), &a.program, Some(&scope));
            eprintln!("M5 forged citizen: {:?}", r.as_ref().map(|b| &b.wide));
            continue;
        }
        latches(
            &a,
            &set(&t, i, b"PS2", &x),
            &format!("Depart: another {what}"),
        );
    }
    // another transit slot (the external no longer matches)
    let mut x = b.clone();
    x[8] = (x[8] + 1) % 4;
    latches(&a, &set(&t, i, b"PS2", &x), "Depart: another transit slot");
    // another host of the world: its province (sort key), its site
    let site = host + 1 + 32 + (PROVINCE_KEY_LEN - 33);
    let mut x = b.clone();
    x[site - 1] ^= 1;
    latches(
        &a,
        &set(&t, i, b"PS2", &x),
        "Depart: the host in another province",
    );
    let mut x = b.clone();
    x[site] = (x[site] + 1) % 12;
    latches(
        &a,
        &set(&t, i, b"PS2", &x),
        "Depart: the host on another site",
    );
    // the host's gen / seq (the Holding is per site: the codec cannot bind them without reading the
    // Holding; the guard's facts never use them, so the facts must be IDENTICAL to the honest ones)
    let scope = WideScope::of(&a).unwrap();
    let honest = feedguard::bodies_scoped(&t, &a.program, Some(&scope))
        .unwrap()
        .expedition;
    for at in [site + 1, site + 2, site + 5] {
        let mut x = b.clone();
        x[at] ^= 0x80;
        let got = feedguard::bodies_scoped(&set(&t, i, b"PS2", &x), &a.program, Some(&scope));
        eprintln!(
            "M5 host gen/seq byte {}: {}",
            at - host,
            if got.is_err() { "LATCH" } else { "accepted" }
        );
        if let Ok(g) = got {
            assert_eq!(g.expedition, honest, "same facts");
        }
    }
    // the whole record read under another Season
    for k in [
        DEPART,
        REVEAL,
        GATHER,
        SETTLE_MEMBER,
        DISSOLVE,
        FAILURE,
        TERMINAL,
    ] {
        let (a, t) = pick(&all, k);
        latches(
            &Addresses::new(a.program, a.season_id + 1),
            &t,
            &format!("kind {k}: another Season"),
        );
    }
    // cross-spliced pairs: member PS2 148 with the camp's PSW1 25; Dissolve's 149 with Return's 26
    for (k1, k2, pk, wk) in [
        (SETTLE_MEMBER, SETTLE_CAMP, 148u8, 25u8),
        (SETTLE_CAMP, SETTLE_MEMBER, 148, 25),
        (DISSOLVE, RETURN, 149, 26),
        (RETURN, DISSOLVE, 149, 26),
    ] {
        let (a, t) = pick(&all, k1);
        let (_, t2) = pick(&all, k2);
        let (wi, _) = rec(&t, b"PSW1", &[wk]);
        let (_, wb2) = rec(&t2, b"PSW1", &[wk]);
        let _ = pk;
        latches(
            &a,
            &set(&t, wi, b"PSW1", &wb2),
            &format!("kind {k1}'s PS2 with kind {k2}'s PSW1"),
        );
    }
}

/// M6 replay: a record logged twice in one transaction, and a transaction's records replayed into
/// another transaction's logs. Records the outcome (the guard is stateless across transactions).
#[test]
fn m6_replay() {
    let all = all();
    let mut report = vec![];
    for (k, tag, kinds) in [
        (DEPART, &b"PS2"[..], &[146u8][..]),
        (SETTLE_ORIGIN, b"PS2", &[146]),
        (REVEAL, b"PS2", &[147]),
        (GATHER, b"PS2", &[147]),
        (FAILURE, b"PSFF", &[]),
        (TERMINAL, b"PSFT", &[]),
    ] {
        let (a, t) = pick(&all, k);
        let (i, _) = rec(&t, tag, kinds);
        let mut x = t.clone();
        x.logs.insert(i + 1, t.logs[i].clone());
        latches(
            &a,
            &x,
            &format!("kind {k}: the record twice in one transaction"),
        );
        report.push(format!("kind {k} twice in one tx: LATCH"));
    }
    // pairs twice: the second PS2 148 + PSW1 25 pair repeated
    for (k, pk, wk) in [(SETTLE_MEMBER, 148u8, 25u8), (DISSOLVE, 149, 26)] {
        let (a, t) = pick(&all, k);
        let (pi, _) = rec(&t, b"PS2", &[pk]);
        let (wi, _) = rec(&t, b"PSW1", &[wk]);
        let mut x = t.clone();
        x.logs.insert(wi + 1, t.logs[wi].clone());
        x.logs.insert(wi + 1, t.logs[pi].clone());
        latches(
            &a,
            &x,
            &format!("kind {k}: the pair twice in one transaction"),
        );
        report.push(format!("kind {k} pair twice: LATCH"));
    }
    // the same transaction delivered twice (same seq): read once
    let (a, t) = pick(&all, DEPART);
    let mut play = PlayIndex::default();
    play.ingest_page(&[t.clone(), t.clone()], &a);
    assert!(play.feed.blocked().is_none());
    assert_eq!(play.expeditions.len(), 1);
    assert_eq!(
        play.expeditions.values().next().unwrap().wires.len(),
        1,
        "read once"
    );
    // the same transaction under a later seq (an RPC replaying it): idempotent hints, no double track
    let mut t2 = t.clone();
    t2.seq += 1_000_000;
    play.ingest_page(&[t2], &a);
    // (stateless across transactions: the RPC feed is trusted for order and completeness; the facts are hints the
    //  duties re-read from the chain, so a replay at a new seq changes no plan; the role checks every wire against
    //  the bridge record's seal root)
    assert!(play.feed.blocked().is_none());
    assert_eq!(play.expeditions.len(), 1, "no second track");
    let e = play.expeditions.values().next().unwrap();
    report.push(format!(
        "Depart tx replayed at a later seq: blocked={} tracked={} wires={}",
        play.feed.blocked().is_some(),
        play.expeditions.len(),
        e.wires.len()
    ));
    eprintln!("M6 replay outcomes:\n  {}", report.join("\n  "));
}

/// M7 unknown kinds / versions of every expedition format.
#[test]
fn m7_unknown_kind_or_version() {
    let all = all();
    let (a, t) = pick(&all, SETTLE_MEMBER);
    let (wi, wb) = rec(&t, b"PSW1", &[25]);
    for k in [27u8, 24, 18, 0, 255] {
        let mut x = wb.clone();
        x[1] = k;
        latches(&a, &set(&t, wi, b"PSW1", &x), &format!("PSW1 kind {k}"));
    }
    for (k, tag) in [(FAILURE, &b"PSFF"[..]), (TERMINAL, b"PSFT")] {
        let (a, t) = pick(&all, k);
        let (i, b) = rec(&t, tag, &[]);
        for v in [0u8, 4, 9, 255] {
            let mut x = b.clone();
            x[4] = v;
            latches(
                &a,
                &set(&t, i, tag, &x),
                &format!("{} version byte {v}", String::from_utf8_lossy(tag)),
            );
        }
        for v in [0u8, 2, 255] {
            let mut x = b.clone();
            x[0] = v;
            latches(
                &a,
                &set(&t, i, tag, &x),
                &format!("{} first byte {v}", String::from_utf8_lossy(tag)),
            );
        }
    }
    // a record of an unknown format in the program's frame, next to an honest Depart
    let (a, t) = pick(&all, DEPART);
    let (i, _) = rec(&t, b"PS2", &[146]);
    for tag in [&b"PSWX"[..], b"PSW2", b"PSFG", b"PSWC", b"PSWR"] {
        let mut x = t.clone();
        x.logs.insert(i + 1, line(tag, &[1, 2, 3, 4, 5, 6]));
        latches(
            &a,
            &x,
            &format!("{} next to a Depart", String::from_utf8_lossy(tag)),
        );
    }
}

/// M8 the PS2 149 edge (D-devnet-page-war-6): the legacy codec refuses 145..=149 (not only
/// 145..=148); a default-build keeper latches on 149; a scoped keeper latches on 149 without its 26,
/// with a 26 of another operation, with a 25, and on a 149 body relabelled 148 (and vice versa).
#[test]
fn m8_ps2_149_edge() {
    let all = all();
    let (a, t) = pick(&all, DISSOLVE);
    let (pi, pb) = rec(&t, b"PS2", &[149]);
    let (wi, wb) = rec(&t, b"PSW1", &[26]);
    assert!(
        fclient::log::Record::decode_v2(&pb).is_err(),
        "decode_v2 refuses the real 149"
    );
    assert!(fclient::log::Record::decode_v2(&[frontier_abi::log::VERSION, 150, 0, 0]).is_err());
    // default build
    assert!(feedguard::bodies_scoped(&t, &a.program, None).is_err());
    assert!(feedguard::bodies(&t, &a.program).is_err());
    // 149 + the PSW1 25 of a member settlement
    let (_, tm) = pick(&all, SETTLE_MEMBER);
    let (_, w25) = rec(&tm, b"PSW1", &[25]);
    latches(&a, &set(&t, wi, b"PSW1", &w25), "PS2 149 + PSW1 25");
    // 149 relabelled 148, with its 26 relabelled 25
    let mut p = pb.clone();
    p[1] = 148;
    let mut w = wb.clone();
    w[1] = 25;
    latches(
        &a,
        &set(&set(&t, pi, b"PS2", &p), wi, b"PSW1", &w),
        "149+26 relabelled 148+25",
    );
    // 148 relabelled 149 (with its 25 relabelled 26)
    let (pi2, pb2) = rec(&tm, b"PS2", &[148]);
    let (wi2, wb2) = rec(&tm, b"PSW1", &[25]);
    let (mut p, mut w) = (pb2.clone(), wb2.clone());
    p[1] = 149;
    w[1] = 26;
    latches(
        &a,
        &set(&set(&tm, pi2, b"PS2", &p), wi2, b"PSW1", &w),
        "148+25 relabelled 149+26",
    );
    // Return's PS2 149 with Dissolve's PSW1 26 (another resident operation)
    let p = data(&pick(&all, RETURN).1)
        .into_iter()
        .find(|(_, tg, b)| tg == b"PS2" && b[1] == 149)
        .unwrap()
        .2;
    latches(
        &a,
        &set(&t, pi, b"PS2", &p),
        "Return's 149 with Dissolve's 26",
    );
}

/// M9 frames: an honest record outside the program's frame (a CPI of another program, after the
/// frame closes) is not this program's and is never applied; a broken frame latches.
#[test]
fn m9_frames() {
    let all = all();
    let (a, t) = pick(&all, DEPART);
    let (i, _) = rec(&t, b"PS2", &[146]);
    let pid = a.program.to_string();
    // the record moved into a nested invocation of another program inside our frame
    let other = Address::new_from_array([7; 32]).to_string();
    let mut x = t.clone();
    let rec_line = x.logs.remove(i);
    let depth = x
        .logs
        .iter()
        .find_map(|l| {
            l.strip_prefix(&format!("Program {pid} invoke ["))
                .map(|d| d.trim_end_matches(']').parse::<usize>().unwrap())
        })
        .unwrap();
    x.logs
        .insert(i, format!("Program {other} invoke [{}]", depth + 1));
    x.logs.insert(i + 1, rec_line);
    x.logs.insert(i + 2, format!("Program {other} success"));
    let scope = WideScope::of(&a).unwrap();
    let b =
        feedguard::bodies_scoped(&x, &a.program, Some(&scope)).expect("another program's frame");
    assert!(
        b.expedition.is_empty(),
        "not applied from another program's frame"
    );
    // an invoke depth skipped
    let mut x = t.clone();
    let j = x
        .logs
        .iter()
        .position(|l| l.starts_with(&format!("Program {pid} invoke [")))
        .unwrap();
    x.logs[j] = format!("Program {pid} invoke [3]");
    latches(&a, &x, "invoke depth skipped");
    // the frame never closes
    let mut x = t.clone();
    let j = x
        .logs
        .iter()
        .rposition(|l| l == &format!("Program {pid} success"))
        .unwrap();
    x.logs.remove(j);
    latches(&a, &x, "frame never closes");
}

/// P14: the conquest kinds 12..=18 a participant can send through the wrapper on the devnet `.so`.
/// They latched keeper A before devnet-guard-conquest (P14 option (a)); now both indexes read them
/// exactly and keep going (verify-pr124; the mutations in `verify_pr124_conquest_mutations.rs`).
#[test]
fn p14_conquest_kinds_are_read_by_keeper_a() {
    let mut seen: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for (a, k, t) in all() {
        if k < 12 {
            continue;
        }
        let scope = WideScope::of(&a).unwrap();
        let e = feedguard::bodies_scoped(&t, &a.program, Some(&scope))
            .map(|b| format!("{:?}", b.conquest))
            .unwrap_or_else(|e| panic!("kind {k}: {e}"));
        let tags: Vec<String> = data(&t)
            .iter()
            .map(|(_, tg, b)| {
                format!(
                    "{} {}",
                    String::from_utf8_lossy(tg),
                    b.get(1).copied().unwrap_or(0)
                )
            })
            .collect();
        let tag = fclient::tx::from_wire(&t.tx)
            .ok()
            .and_then(|w| {
                let keys = w.message.account_keys.clone();
                w.message
                    .instructions
                    .iter()
                    .find(|ix| {
                        keys.get(ix.program_id_index as usize) == Some(&a.program)
                            && ix.data.len() > 3
                            && ix.data[1] == 0xFF
                    })
                    .map(|ix| format!("0x{:02X}", ix.data[0]))
            })
            .unwrap_or_default();
        seen.entry(k)
            .or_insert_with(|| vec![format!("tag {tag} records {tags:?} → {e}")]);
        let mut land = LandIndex::default();
        land.ingest_page(std::slice::from_ref(&t), &a);
        assert!(land.feed.blocked().is_none(), "kind {k}");
    }
    for (k, v) in &seen {
        eprintln!("P14 kind {k}: {}", v[0]);
    }
    assert_eq!(seen.len(), 7, "kinds 12..=18 all in the recordings");
}

/// A whole season archive of an honest P10 run (`VERIFY_PR121_ARCHIVE=<p10-season.json.gz>`; skipped otherwise):
/// both indexes read every transaction and never latch.
#[test]
fn an_honest_p10_season_never_latches() {
    let Ok(path) = std::env::var("VERIFY_PR121_ARCHIVE") else {
        eprintln!("skipped: VERIFY_PR121_ARCHIVE not set");
        return;
    };
    let (a, txs) = load_path(std::path::Path::new(&path));
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    for page in txs.chunks(50) {
        land.ingest_page(page, &a);
        play.ingest_page(page, &a);
    }
    assert!(land.feed.blocked().is_none(), "{:?}", land.feed.blocked());
    assert!(play.feed.blocked().is_none(), "{:?}", play.feed.blocked());
    let last = txs.iter().map(|t| t.seq).max().unwrap();
    assert_eq!((land.cursor, play.cursor), (Cursor(last), Cursor(last)));
    assert_eq!(play.expeditions.len(), 1);
    assert!(play.expeditions.values().all(|e| e.ended));
    eprintln!("honest season: {} transactions, cursor {last}", txs.len());
}
