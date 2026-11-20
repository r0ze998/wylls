//! Devnet gap P10: the keeper's feed guard and the rim → wide expedition's
//! records, over the REAL transactions of the pinned devnet `.so`
//! (`da3dc1aa…`): the committed verifier recordings
//! `fixtures/verify/playable-expedition-whole.json.gz` and
//! `playable-cov-*.json.gz` (`verify/tests/playable_expedition.rs`), whose
//! `logs` are the program's own. Literal bytes only: no key, no signing, no
//! execution, no network.
// (the helpers below serve the `playable-lane` module too)
#![cfg_attr(not(feature = "playable-lane"), allow(unused_imports, dead_code))]
use std::collections::BTreeMap;
use std::io::Read as _;

use base64::Engine as _;
use fclient::addr::Addresses;
use fclient::ports::{Cursor, Signature, TxRecord};
use fclient::Address;
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

/// The dispatch kinds of the version-2 wrapper (`expedition_dispatch_ix::Kind`).
const KINDS: [&str; 19] = [
    "Depart",
    "SettleOrigin",
    "Reveal",
    "Gather",
    "Dissolve",
    "Return",
    "SettleMember",
    "SettleCamp",
    "SettleFailure",
    "SettleForfeit",
    "CloseTerminal",
    "SettleRetainedFailure",
    "DeclareSiege",
    "ResolveWithConquest",
    "SettleCapture",
    "SettleSiege",
    "CloseConquest",
    "CloseCaptureEscrow",
    "SettleReservation",
];

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/verify")
}

struct Rec {
    addrs: Addresses,
    txs: Vec<TxRecord>,
}

fn load(name: &str) -> Rec {
    let f = std::fs::File::open(fixture_dir().join(name)).expect(name);
    let mut s = String::new();
    flate2::read::GzDecoder::new(f)
        .read_to_string(&mut s)
        .expect("gzip");
    let v: Value = serde_json::from_str(&s).expect("json");
    let program: Address = v["config"]["program"].as_str().unwrap().parse().unwrap();
    let addrs = Addresses::new(program, v["config"]["season_id"].as_u64().unwrap());
    let b64 = base64::engine::general_purpose::STANDARD;
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
            tx: b64.decode(t["tx"].as_str().unwrap()).unwrap(),
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
    Rec { addrs, txs }
}

/// The dispatch kind of the transaction's first wrapper instruction, if any.
fn kind_of(tx: &TxRecord, program: &Address) -> Option<&'static str> {
    let t = fclient::tx::from_wire(&tx.tx).ok()?;
    let keys = &t.message.account_keys;
    t.message.instructions.iter().find_map(|ix| {
        (keys.get(ix.program_id_index as usize) == Some(program)
            && ix.data.len() >= 4
            && ix.data[1] == 0xFF
            && ix.data[2] == 2)
            .then(|| KINDS.get(ix.data[3] as usize).copied())
            .flatten()
    })
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

/// `(tag, body)` of each `Program data:` line.
fn data_lines(tx: &TxRecord) -> Vec<(usize, Vec<u8>, Vec<u8>)> {
    tx.logs
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let d = l.strip_prefix("Program data: ")?;
            let p: Vec<&str> = d.split_whitespace().collect();
            (p.len() == 2).then(|| (i, unb64(p[0]), unb64(p[1])))
        })
        .collect()
}

fn with_line(tx: &TxRecord, i: usize, tag: &[u8], body: &[u8]) -> TxRecord {
    let mut t = tx.clone();
    t.logs[i] = format!("Program data: {} {}", b64(tag), b64(body));
    t
}

/// The expedition kinds 0..=11 of the real recordings, with their transactions.
fn real_expedition_txs() -> Vec<(Addresses, &'static str, TxRecord)> {
    let mut out = vec![];
    for f in FIXTURES {
        let r = load(f);
        for t in r.txs.iter().filter(|t| t.err.is_none()) {
            if let Some(k) = kind_of(t, &r.addrs.program) {
                out.push((r.addrs.clone(), k, t.clone()));
            }
        }
    }
    out
}

/// D-devnet-page-war-6 (code wins): the legacy PS2 codec refuses EVERY kind of
/// the playable lane's expedition and conquest records, 145..=149, not
/// 145..=148; so does a keeper without the scope (any build).
#[test]
fn every_expedition_and_conquest_record_latches_a_reader_without_the_scope() {
    for k in 145..=149u8 {
        let mut body = vec![frontier_abi::log::VERSION, k];
        body.extend([0u8; 200]);
        assert!(
            fclient::log::Record::decode_v2(&body).is_err(),
            "PS2 kind {k} is refused by the legacy codec"
        );
    }
    let all = real_expedition_txs();
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    for (a, k, t) in &all {
        assert!(
            feedguard::bodies(t, &a.program).is_err(),
            "{k}: the strict reader refuses it"
        );
        let mut land = LandIndex::default();
        land.ingest_page(std::slice::from_ref(t), a);
        if !cfg!(feature = "playable-lane") {
            assert!(
                land.feed.blocked().is_some(),
                "{k}: latches without playable-lane"
            );
        }
        *kinds.entry(k).or_default() += 1;
    }
    // the recordings carry every dispatch kind, 0..=18, at least once
    for k in KINDS {
        assert!(
            kinds.contains_key(k),
            "{k} is in the real recordings: {kinds:?}"
        );
    }
}

#[cfg(feature = "playable-lane")]
mod p10 {
    use super::*;
    use keeper_core::feedguard::ExpeditionFact as F;

    /// The expedition kinds a playable-lane keeper applies (0..=11); the
    /// conquest kinds 12..=18 are applied too since P14 (option a, module `p14`).
    const APPLIED: [&str; 12] = [
        "Depart",
        "SettleOrigin",
        "Reveal",
        "Gather",
        "Dissolve",
        "Return",
        "SettleMember",
        "SettleCamp",
        "SettleFailure",
        "SettleForfeit",
        "CloseTerminal",
        "SettleRetainedFailure",
    ];

    fn expected(k: &str) -> &'static str {
        match k {
            "Depart" => "EXPEDITION_DEPART",
            "SettleOrigin" => "EXPEDITION_SETTLE_ORIGIN",
            "Reveal" => "EXPEDITION_REVEAL",
            "Gather" => "EXPEDITION_GATHER",
            "Dissolve" | "Return" => "EXPEDITION_RESIDENT",
            "SettleMember" => "EXPEDITION_SETTLE_MEMBER",
            "SettleCamp" => "EXPEDITION_SETTLE_CAMP",
            "SettleFailure" | "SettleForfeit" | "SettleRetainedFailure" => "EXPEDITION_FAILURE",
            "CloseTerminal" => "EXPEDITION_TERMINAL",
            _ => unreachable!(),
        }
    }

    #[test]
    fn every_real_expedition_and_conquest_transaction_is_applied() {
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for (a, k, t) in real_expedition_txs() {
            let scope = WideScope::of(&a).expect("a playable-lane scope");
            let got = feedguard::bodies_scoped(&t, &a.program, Some(&scope));
            if APPLIED.contains(&k) {
                let b = got.unwrap_or_else(|e| panic!("{k} (seq {}): {e}", t.seq));
                assert_eq!(
                    b.expedition.len(),
                    1,
                    "{k}: one fact per wrapper instruction"
                );
                assert_eq!(b.expedition[0].name(), expected(k), "{k}");
                assert!(b.wide.contains(&expected(k)), "{k}: counted");
                // both indexes take it, neither latches, the cursor moves past it
                let mut land = LandIndex::default();
                let mut play = PlayIndex::default();
                land.ingest_page(std::slice::from_ref(&t), &a);
                play.ingest_page(std::slice::from_ref(&t), &a);
                assert!(
                    land.feed.blocked().is_none(),
                    "{k}: {:?}",
                    land.feed.blocked()
                );
                assert!(
                    play.feed.blocked().is_none(),
                    "{k}: {:?}",
                    play.feed.blocked()
                );
                assert_eq!((land.cursor, play.cursor), (Cursor(t.seq), Cursor(t.seq)));
                match &b.expedition[0] {
                    F::Source { home, .. } | F::Resident { home, .. } | F::Failure { home, .. } => {
                        assert!(
                            play.touched.contains(home),
                            "{k}: the home province is re-read"
                        )
                    }
                    F::Settled { home, holding, .. } => {
                        assert!(play.touched.contains(home), "{k}: home re-read");
                        assert!(
                            land.owes.contains(holding),
                            "{k}: the holding's pool_owed is re-read"
                        );
                    }
                    _ => {}
                }
                if let F::Failure { holding, .. } = &b.expedition[0] {
                    assert!(land.owes.contains(holding), "{k}: pool_owed re-read");
                }
            } else {
                // P14 (a): the conquest kinds no longer latch (the exact facts: module `p14`)
                let b = got.unwrap_or_else(|e| panic!("{k} (seq {}): {e}", t.seq));
                assert!(b.expedition.is_empty(), "{k}");
                assert_eq!(b.conquest.len(), 1, "{k}: one fact per wrapper instruction");
                let mut land = LandIndex::default();
                let mut play = PlayIndex::default();
                land.ingest_page(std::slice::from_ref(&t), &a);
                play.ingest_page(std::slice::from_ref(&t), &a);
                assert!(
                    land.feed.blocked().is_none() && play.feed.blocked().is_none(),
                    "{k}"
                );
                assert_eq!((land.cursor, play.cursor), (Cursor(t.seq), Cursor(t.seq)));
            }
            *seen.entry(k).or_default() += 1;
        }
        for k in KINDS {
            assert!(seen.contains_key(k), "{k} seen: {seen:?}");
        }
    }

    /// The whole main recording through the play index: the expedition is tracked
    /// from its Depart (with the Depart's and the Reveal's wire) to its member
    /// settlement; nothing latches, the conquest that follows included (P14).
    #[test]
    fn the_play_index_tracks_the_real_expedition_from_depart_to_settlement() {
        let r = load("playable-expedition-whole.json.gz");
        let mut play = PlayIndex::default();
        let first_conquest = r
            .txs
            .iter()
            .position(|t| {
                t.err.is_none()
                    && kind_of(t, &r.addrs.program).is_some_and(|k| !APPLIED.contains(&k))
            })
            .expect("the recording's conquest part");
        play.ingest_page(&r.txs[..first_conquest], &r.addrs);
        assert!(play.feed.blocked().is_none(), "{:?}", play.feed.blocked());
        assert_eq!(play.expeditions.len(), 1, "{:?}", play.expeditions.keys());
        let (ext, e) = play.expeditions.iter().next().unwrap();
        assert!(e.ended, "settled");
        assert!(e.wires.len() >= 2, "the Depart's and the Reveal's wire");
        let landed: Vec<_> = e
            .wires
            .iter()
            .flat_map(|w| keeper_core::expedition_steps::commands_in(w, &r.addrs.program).unwrap())
            .collect();
        assert!(landed
            .iter()
            .any(|(c, _)| matches!(c, keeper_core::expedition_steps::Landed::Depart(_))));
        assert!(landed
            .iter()
            .any(|(c, _)| matches!(c, keeper_core::expedition_steps::Landed::Reveal(_))));
        assert_eq!(
            *ext,
            keeper_core::expedition_steps::external_of(&r.addrs, &e.holding, e.slot)
        );
        // P14 (a): the conquest that follows no longer latches the guard
        play.ingest_page(&r.txs[first_conquest..], &r.addrs);
        assert!(play.feed.blocked().is_none(), "{:?}", play.feed.blocked());
        assert_eq!(play.cursor, Cursor(r.txs.last().unwrap().seq));
    }

    /// Unpaired, forged, truncated, re-scoped and foreign expedition records latch.
    #[test]
    fn unpaired_forged_or_foreign_expedition_records_latch() {
        let all = real_expedition_txs();
        let pick = |k: &str| {
            all.iter()
                .find(|(_, kk, _)| *kk == k)
                .cloned()
                .unwrap_or_else(|| panic!("{k}"))
        };
        let refused = |a: &Addresses, t: &TxRecord, what: &str| {
            let scope = WideScope::of(a).unwrap();
            assert!(
                feedguard::bodies_scoped(t, &a.program, Some(&scope)).is_err(),
                "{what}: refused"
            );
            let mut land = LandIndex::default();
            let mut play = PlayIndex::default();
            land.ingest_page(std::slice::from_ref(t), a);
            play.ingest_page(std::slice::from_ref(t), a);
            assert!(
                land.feed.blocked().is_some() && play.feed.blocked().is_some(),
                "{what}: latches"
            );
            assert_eq!(play.cursor, Cursor(0), "{what}: not applied");
            assert!(play.expeditions.is_empty(), "{what}");
        };
        let mut n = 0;
        for k in ["SettleMember", "SettleCamp", "Dissolve", "Return"] {
            let (a, _, t) = pick(k);
            let lines = data_lines(&t);
            let (pi, ptag, pbody) = lines
                .iter()
                .find(|(_, tag, b)| tag == b"PS2" && matches!(b.get(1), Some(148 | 149)))
                .cloned()
                .unwrap();
            let (wi, wtag, wbody) = lines
                .iter()
                .find(|(_, tag, b)| tag == b"PSW1" && matches!(b.get(1), Some(25 | 26)))
                .cloned()
                .unwrap();
            // 1. the PSW1 part dropped; the PS2 part dropped
            let mut t1 = t.clone();
            t1.logs.remove(wi);
            refused(&a, &t1, &format!("{k} without its PSW1 part"));
            let mut t2 = t.clone();
            t2.logs.remove(pi);
            refused(&a, &t2, &format!("{k}: a PSW1 part alone"));
            // 2. the PSW1 part twice; the two parts swapped
            let mut t3 = t.clone();
            t3.logs.insert(wi + 1, t.logs[wi].clone());
            refused(&a, &t3, &format!("{k}: the PSW1 part twice"));
            let t4 = with_line(&with_line(&t, pi, &wtag, &wbody), wi, &ptag, &pbody);
            refused(&a, &t4, &format!("{k}: parts swapped"));
            // 3. every single byte of each part flipped (bounded stride)
            for (i, tag, body) in [(pi, &ptag, &pbody), (wi, &wtag, &wbody)] {
                for j in (0..body.len()).step_by(7) {
                    let mut b = body.clone();
                    b[j] ^= 0x01;
                    let tj = with_line(&t, i, tag, &b);
                    let scope = WideScope::of(&a).unwrap();
                    if let Ok(x) = feedguard::bodies_scoped(&tj, &a.program, Some(&scope)) {
                        // (a byte the codec does not cover, e.g. a digest: still the same pair and identity)
                        assert_eq!(x.expedition.len(), 1, "{k} byte {j}");
                    } else {
                        n += 1;
                    }
                }
                // every strict prefix
                for cut in [1usize, 2, 7, body.len() / 2, body.len() - 1] {
                    let tj = with_line(&t, i, tag, &body[..cut]);
                    refused(&a, &tj, &format!("{k}: a {cut}-byte prefix"));
                }
            }
        }
        assert!(n > 50, "most flips are refused ({n})");
        for k in [
            "Depart",
            "SettleOrigin",
            "Reveal",
            "Gather",
            "SettleFailure",
            "SettleForfeit",
            "SettleRetainedFailure",
            "CloseTerminal",
        ] {
            let (a, _, t) = pick(k);
            let (i, tag, body) = data_lines(&t)
                .into_iter()
                .find(|(_, tag, b)| {
                    (tag == b"PS2" && matches!(b.get(1), Some(146 | 147)))
                        || tag == b"PSFF"
                        || tag == b"PSFT"
                })
                .unwrap();
            for cut in [1usize, body.len() / 2, body.len() - 1] {
                refused(
                    &a,
                    &with_line(&t, i, &tag, &body[..cut]),
                    &format!("{k}: a {cut}-byte prefix"),
                );
            }
            let mut long = body.clone();
            long.push(0);
            refused(
                &a,
                &with_line(&t, i, &tag, &long),
                &format!("{k}: a trailing byte"),
            );
            // another Season of the same program (another world): every canonical identity differs
            let other = Addresses::new(a.program, a.season_id + 1);
            refused(&other, &t, &format!("{k} read in another Season"));
            // a truncated log after the record
            let mut tr = t.clone();
            tr.logs.insert(i + 1, "Log truncated".into());
            refused(&a, &tr, &format!("{k}: truncated log"));
        }
        // (PS2 145 is read with its pair since P14: its mutations are module `p14`'s)
        // a PS2 146 body under the PSW1 tag, and a PSW1 25 body under the PS2 tag
        let (a, _, t) = pick("Depart");
        let (i, _, body) = data_lines(&t)
            .into_iter()
            .find(|(_, tag, _)| tag == b"PS2")
            .unwrap();
        refused(&a, &with_line(&t, i, b"PSW1", &body), "PS2 146 under PSW1");
        let (a2, _, t2) = pick("SettleMember");
        let (wi, _, wbody) = data_lines(&t2)
            .into_iter()
            .find(|(_, tag, _)| tag == b"PSW1")
            .unwrap();
        refused(
            &a2,
            &with_line(&t2, wi, b"PS2", &wbody),
            "PSW1 25 under PS2",
        );
        // an expedition record logged by ANOTHER program's frame is ignored (not this program's)
        let (a, _, t) = pick("Depart");
        let mut foreign = t.clone();
        let other_program = Address::new_from_array([0x42; 32]);
        for l in foreign.logs.iter_mut() {
            *l = l.replace(&a.program.to_string(), &other_program.to_string());
        }
        let scope = WideScope::of(&a).unwrap();
        let b = feedguard::bodies_scoped(&foreign, &a.program, Some(&scope))
            .expect("another program's frames");
        assert!(
            b.expedition.is_empty() && b.ps2.is_empty(),
            "another program's records are never applied"
        );
    }
}

/// Devnet gap P14, option (a): the Free City conquest records of the wrapper's
/// kinds 12–18, over the REAL logs of the pinned `.so` (and, for the variants no
/// recording carries, bodies built by the ABI's own encoders from real ones).
#[cfg(feature = "playable-lane")]
mod p14 {
    use super::*;
    use frontier_abi::world_index::event::{
        self as ev, WideEntity, WideKind, WideLink, WideRecord,
    };
    use keeper_core::feedguard::{ConquestFact as C, ConquestSource as Src};

    const CONQUEST: [&str; 7] = [
        "DeclareSiege",
        "ResolveWithConquest",
        "SettleCapture",
        "SettleSiege",
        "CloseConquest",
        "CloseCaptureEscrow",
        "SettleReservation",
    ];

    fn conquest_txs() -> Vec<(Addresses, &'static str, TxRecord)> {
        real_expedition_txs()
            .into_iter()
            .filter(|(_, k, _)| CONQUEST.contains(k))
            .collect()
    }

    fn pick(k: &str) -> (Addresses, TxRecord) {
        conquest_txs()
            .into_iter()
            .find(|(_, kk, _)| *kk == k)
            .map(|(a, _, t)| (a, t))
            .unwrap_or_else(|| panic!("{k} in the recordings"))
    }

    fn facts(a: &Addresses, t: &TxRecord) -> Result<Vec<C>, String> {
        let scope = WideScope::of(a).unwrap();
        feedguard::bodies_scoped(t, &a.program, Some(&scope)).map(|b| b.conquest)
    }

    /// Refused by the reader, and both indexes latch on it without applying anything.
    fn latches(a: &Addresses, t: &TxRecord, what: &str) {
        assert!(
            facts(a, t).is_err(),
            "{what}: refused, got {:?}",
            facts(a, t)
        );
        let mut land = LandIndex::default();
        let mut play = PlayIndex::default();
        land.ingest_page(std::slice::from_ref(t), a);
        play.ingest_page(std::slice::from_ref(t), a);
        assert!(
            land.feed.blocked().is_some() && play.feed.blocked().is_some(),
            "{what}: latches"
        );
        assert_eq!(play.cursor, Cursor(0), "{what}: not applied");
        assert!(play.touched.is_empty(), "{what}: nothing applied");
    }

    /// The `(tag, kind)` shape of a transaction's program records.
    fn shape(t: &TxRecord) -> Vec<(String, u8)> {
        data_lines(t)
            .into_iter()
            .map(|(_, tag, b)| (String::from_utf8_lossy(&tag).into_owned(), b[1]))
            .collect()
    }

    /// Step 1 of the brief, as the REAL `.so` logs them: each reachable conquest kind's
    /// records (the shapes the reader is built on), and the facts the reader makes of them.
    #[test]
    fn every_real_conquest_kind_logs_the_documented_records_and_is_read_exactly() {
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for (a, k, t) in conquest_txs() {
            let s = shape(&t);
            let s: Vec<(&str, u8)> = s.iter().map(|(t, b)| (t.as_str(), *b)).collect();
            let f = facts(&a, &t).unwrap_or_else(|e| panic!("{k} (seq {}): {e}", t.seq));
            assert_eq!(f.len(), 1, "{k}");
            match (k, s.as_slice(), &f[0]) {
                // the legacy rim host's siege: PSW1 18 then its PS2 145 debit
                (
                    "DeclareSiege",
                    [("PSW1", 18), ("PS2", 145)],
                    C::Declared {
                        source: Src::Legacy { .. },
                        ..
                    },
                ) => {}
                ("ResolveWithConquest", [("PSW1", 20)], C::Resolved { .. }) => {}
                (
                    "SettleCapture",
                    [("PSW1", 22), ("PS2", 145)],
                    C::Captured {
                        credit: Some(Src::Legacy { .. }),
                        ..
                    },
                ) => {}
                // FAILED (the host left): no credit
                (
                    "SettleSiege",
                    [("PSW1", 21)],
                    C::Settled {
                        province: Some(_),
                        action: 3,
                        credit: None,
                    },
                ) => {}
                // the NOT_APPLIED reservation of a host that left: nothing to return
                (
                    "SettleReservation",
                    [("PSW1", 21)],
                    C::Settled {
                        province: Some(_),
                        action: 9,
                        credit: None,
                    },
                ) => {}
                ("CloseConquest", [("PSW1", 24)], C::TableClosed { .. }) => {}
                ("CloseCaptureEscrow", [("PSWC", _)], C::EscrowClosed { .. }) => {}
                other => panic!("unexpected {k}: {other:?}"),
            }
            // the legacy source's home is re-read; a wide-only record touches nothing legacy
            let mut play = PlayIndex::default();
            play.ingest_page(std::slice::from_ref(&t), &a);
            match f[0].legacy_home() {
                Some(home) => assert!(play.touched.contains(&home), "{k}: home re-read"),
                None => assert!(play.touched.is_empty(), "{k}: {:?}", play.touched),
            }
            assert!(
                play.feed.wide_accounted().contains_key(f[0].name()),
                "{k}: counted"
            );
            *seen.entry(k).or_default() += 1;
        }
        for k in CONQUEST {
            assert!(seen.contains_key(k), "{k} seen: {seen:?}");
        }
        // the DeclareSiege of a reservation behind the cursor is a RESERVE (action 8) Declared
        let reserves = conquest_txs()
            .into_iter()
            .filter_map(|(a, k, t)| (k == "DeclareSiege").then(|| facts(&a, &t).unwrap()))
            .filter(|f| matches!(f[0], C::Declared { reserve: true, .. }))
            .count();
        assert!(reserves >= 1, "the recordings' reservation");
    }

    fn line(t: &TxRecord, tag: &[u8], kind: u8) -> (usize, Vec<u8>) {
        data_lines(t)
            .into_iter()
            .find(|(_, tt, b)| tt == tag && b[1] == kind)
            .map(|(i, _, b)| (i, b))
            .unwrap()
    }

    // ---- mutations: each must latch (≥ 8 named ones below, plus the byte sweeps)

    #[test]
    fn m1_a_declare_siege_without_its_debit_latches() {
        let (a, t) = pick("DeclareSiege");
        let (i, _) = line(&t, b"PS2", 145);
        let mut m = t.clone();
        m.logs.remove(i);
        latches(&a, &m, "DeclareSiege without PS2 145");
    }

    #[test]
    fn m2_a_source_record_alone_latches() {
        let (a, t) = pick("DeclareSiege");
        let (i, _) = line(&t, b"PSW1", 18);
        let mut m = t.clone();
        m.logs.remove(i);
        latches(&a, &m, "PS2 145 without its target");
        // and a source record twice (the second one alone)
        let (j, _) = line(&t, b"PS2", 145);
        let mut m = t.clone();
        m.logs.insert(j + 1, t.logs[j].clone());
        latches(&a, &m, "PS2 145 twice");
    }

    #[test]
    fn m3_the_pair_swapped_latches() {
        let (a, t) = pick("SettleCapture");
        let (i, ti) = line(&t, b"PSW1", 22);
        let (j, sj) = line(&t, b"PS2", 145);
        let m = with_line(&with_line(&t, i, b"PS2", &sj), j, b"PSW1", &ti);
        latches(&a, &m, "SettleCapture's pair swapped");
    }

    #[test]
    fn m4_a_source_of_the_wrong_direction_latches() {
        // a DECLARE receipt's source marked Credit (byte 7): no longer a debit
        let (a, t) = pick("DeclareSiege");
        let (j, mut b) = line(&t, b"PS2", 145);
        assert_eq!(b[7], 1, "Debit");
        b[7] = 2;
        latches(
            &a,
            &with_line(&t, j, b"PS2", &b),
            "a Credit under DeclareSiege",
        );
        // and the capture's credit marked Debit
        let (a, t) = pick("SettleCapture");
        let (j, mut b) = line(&t, b"PS2", 145);
        assert_eq!(b[7], 2, "Credit");
        b[7] = 1;
        latches(
            &a,
            &with_line(&t, j, b"PS2", &b),
            "a Debit under SettleCapture",
        );
    }

    #[test]
    fn m5_a_source_of_another_operation_or_bell_latches() {
        // the DeclareSiege's debit under the capture's target: another receipt
        let (a, t) = pick("SettleCapture");
        let (_, d) = pick("DeclareSiege");
        let (_, debit) = line(&d, b"PS2", 145);
        let (j, _) = line(&t, b"PS2", 145);
        latches(
            &a,
            &with_line(&t, j, b"PS2", &debit),
            "another operation's source",
        );
        // the debit with its bell moved by one (its own receipt kept)
        let (a, t) = pick("DeclareSiege");
        let (j, mut b) = line(&t, b"PS2", 145);
        let bell = u32::from_le_bytes(b[2..6].try_into().unwrap()) + 1;
        b[2..6].copy_from_slice(&bell.to_le_bytes());
        latches(
            &a,
            &with_line(&t, j, b"PS2", &b),
            "the source at another bell",
        );
    }

    #[test]
    fn m6_a_source_holding_that_is_not_the_hosts_latches() {
        let (a, t) = pick("DeclareSiege");
        let (j, mut b) = line(&t, b"PS2", 145);
        b[66] ^= 0x01; // the holding address
        latches(
            &a,
            &with_line(&t, j, b"PS2", &b),
            "a non-canonical source holding",
        );
        let (j, mut b) = line(&t, b"PS2", 145);
        b[200] ^= 0x01; // the chain seq: still decodes (not verified here), the SAME fact
        let f = facts(&a, &with_line(&t, j, b"PS2", &b)).unwrap();
        assert!(matches!(f[0], C::Declared { .. }));
        let mut z = line(&t, b"PS2", 145).1;
        z[200..208].copy_from_slice(&0u64.to_le_bytes()); // seq 0: no chain
        latches(
            &a,
            &with_line(&t, j, b"PS2", &z),
            "a source with chain seq 0",
        );
    }

    #[test]
    fn m7_a_record_with_no_source_followed_by_one_latches() {
        // a FAILED settlement credited, a ResolveWithConquest with a source, a CloseConquest with one
        let (_, cap) = pick("SettleCapture");
        let (_, credit) = line(&cap, b"PS2", 145);
        for k in [
            "SettleSiege",
            "ResolveWithConquest",
            "CloseConquest",
            "CloseCaptureEscrow",
        ] {
            let (a, t) = pick(k);
            let i = data_lines(&t).last().unwrap().0;
            let mut m = t.clone();
            m.logs.insert(
                i + 1,
                format!("Program data: {} {}", b64(b"PS2"), b64(&credit)),
            );
            latches(&a, &m, &format!("{k} followed by a credit"));
        }
    }

    #[test]
    fn m8_conquest_records_of_another_season_latch() {
        for k in CONQUEST {
            let (a, t) = pick(k);
            let other = Addresses::new(a.program, a.season_id + 1);
            latches(&other, &t, &format!("{k} read in another Season"));
        }
    }

    #[test]
    fn m9_truncated_trailing_and_retagged_conquest_records_latch() {
        for k in CONQUEST {
            let (a, t) = pick(k);
            for (i, tag, body) in data_lines(&t) {
                for cut in [1usize, 2, body.len() / 2, body.len() - 1] {
                    latches(
                        &a,
                        &with_line(&t, i, &tag, &body[..cut]),
                        &format!("{k}: a {cut}-byte prefix"),
                    );
                }
                let mut long = body.clone();
                long.push(0);
                latches(
                    &a,
                    &with_line(&t, i, &tag, &long),
                    &format!("{k}: a trailing byte"),
                );
                // under another record format
                let other: &[u8] = if tag == b"PSW1" { b"PS2" } else { b"PSW1" };
                latches(
                    &a,
                    &with_line(&t, i, other, &body),
                    &format!("{k}: retagged"),
                );
                let mut tr = t.clone();
                tr.logs.insert(i + 1, "Log truncated".into());
                latches(&a, &tr, &format!("{k}: truncated log"));
            }
        }
    }

    #[test]
    fn m10_single_byte_flips_are_refused_or_read_as_the_same_fact() {
        let mut refused = 0;
        let mut total = 0;
        for k in CONQUEST {
            let (a, t) = pick(k);
            let want = facts(&a, &t).unwrap();
            for (i, tag, body) in data_lines(&t) {
                for j in (0..body.len()).step_by(3) {
                    let mut b = body.clone();
                    b[j] ^= 0x01;
                    total += 1;
                    match facts(&a, &with_line(&t, i, &tag, &b)) {
                        Err(_) => refused += 1,
                        // (a byte no codec binds — a chain head, a link seq, an outcome digest — keeps the
                        //  fact's kind and every identity it names)
                        Ok(f) => assert_eq!(
                            std::mem::discriminant(&f[0]),
                            std::mem::discriminant(&want[0]),
                            "{k} byte {j}"
                        ),
                    }
                }
            }
        }
        assert!(refused * 2 > total, "most flips refused: {refused}/{total}");
    }

    /// A WIDE source (PSW1 19 debit / 23 credit) and the unchained PSWR: no recording
    /// carries them (every recorded siege's source is the rim host's legacy Holding, every
    /// reservation settled while its province was open), so they are built here by the ABI's
    /// own encoder from real records: the receipt and bell of the real target, the key of the
    /// real captured WIDE holding (PSW1 22).
    #[test]
    fn m11_wide_sources_and_pswr_built_from_real_records() {
        let (a, cap) = pick("SettleCapture");
        let (ci, captured) = line(&cap, b"PSW1", 22);
        let w22 = WideRecord::decode(&captured).unwrap();
        let wide_key = w22.key.to_vec(); // a wide holding ref, sequence 0
        let link = [WideLink {
            entity: WideEntity::Holding,
            seq: 7,
            head: [9; 32],
        }];
        let rec =
            |kind, bell, payload: &[u8]| ev::encode(kind, bell, &wide_key, payload, &link).unwrap();
        // the capture credited to a WIDE source: PSW1 22 + PSW1 23
        let (j, _) = line(&cap, b"PS2", 145);
        let credit = rec(WideKind::ConquestCredited, w22.bell, w22.payload);
        let m = with_line(&cap, j, b"PSW1", &credit);
        let f = facts(&a, &m).unwrap();
        assert!(
            matches!(
                f[0],
                C::Captured {
                    credit: Some(Src::Wide { .. }),
                    ..
                }
            ),
            "{f:?}"
        );
        assert_eq!(
            f[0].legacy_home(),
            None,
            "a wide source touches nothing legacy"
        );
        // ... with a DEBITED record instead (the wrong direction), another bell, another receipt
        let (_, decl) = pick("DeclareSiege");
        let (_, d18) = line(&decl, b"PSW1", 18);
        let w18 = WideRecord::decode(&d18).unwrap();
        // (the encoder refuses a receipt of the wrong action for the kind: those two by byte edits)
        let mut debited = credit.clone();
        debited[1] = WideKind::ConquestDebited as u8;
        let mut other_receipt = credit.clone();
        other_receipt[56 + 6..56 + 6 + 100].copy_from_slice(w18.payload);
        for (what, body) in [
            ("a Debited credit", debited),
            (
                "another bell",
                rec(WideKind::ConquestCredited, w22.bell + 1, w22.payload),
            ),
            ("another receipt", other_receipt),
        ] {
            latches(&a, &with_line(&cap, j, b"PSW1", &body), what);
        }
        // a Credited record as a target, alone
        let mut alone = cap.clone();
        alone.logs[ci] = format!("Program data: {} {}", b64(b"PSW1"), b64(&credit));
        alone.logs.remove(j);
        latches(&a, &alone, "PSW1 23 alone");
        // the siege declared from a WIDE source: PSW1 18 + PSW1 19
        let (a, decl) = pick("DeclareSiege");
        let (j, _) = line(&decl, b"PS2", 145);
        let debit = rec(WideKind::ConquestDebited, w18.bell, w18.payload);
        let f = facts(&a, &with_line(&decl, j, b"PSW1", &debit)).unwrap();
        assert!(
            matches!(
                f[0],
                C::Declared {
                    source: Src::Wide { .. },
                    ..
                }
            ),
            "{f:?}"
        );

        // PSWR: version 1, Season, table, seq, bell, a RESERVATION_REFUND receipt
        let (a, res) = pick("SettleReservation");
        let (ri, r21) = line(&res, b"PSW1", 21);
        let w21 = WideRecord::decode(&r21).unwrap();
        let pswr = |season: &[u8], payload: &[u8]| {
            let mut b = vec![1u8];
            b.extend_from_slice(season);
            b.extend_from_slice(&[0x33; 32]);
            b.extend_from_slice(&1u32.to_le_bytes());
            b.extend_from_slice(&w21.bell.to_le_bytes());
            b.extend_from_slice(payload);
            b
        };
        let ok = with_line(&res, ri, b"PSWR", &pswr(&a.season.to_bytes(), w21.payload));
        let f = facts(&a, &ok).unwrap();
        assert!(
            matches!(
                f[0],
                C::Settled {
                    province: None,
                    action: 9,
                    credit: None
                }
            ),
            "{f:?}"
        );
        latches(
            &a,
            &with_line(&res, ri, b"PSWR", &pswr(&[7; 32], w21.payload)),
            "PSWR of another Season",
        );
        latches(
            &a,
            &with_line(&res, ri, b"PSWR", &pswr(&a.season.to_bytes(), w18.payload)),
            "PSWR with a DECLARE receipt",
        );
    }

    /// The whole siege recording through both indexes: nothing latches from its first
    /// transaction to its last, and every conquest kind is counted.
    #[test]
    fn the_whole_siege_and_closes_recordings_never_latch() {
        for name in [
            "playable-cov-siege.json.gz",
            "playable-cov-closes.json.gz",
            "playable-expedition-whole.json.gz",
        ] {
            let r = load(name);
            let mut land = LandIndex::default();
            let mut play = PlayIndex::default();
            land.ingest_page(&r.txs, &r.addrs);
            play.ingest_page(&r.txs, &r.addrs);
            assert!(
                land.feed.blocked().is_none(),
                "{name}: {:?}",
                land.feed.blocked()
            );
            assert!(
                play.feed.blocked().is_none(),
                "{name}: {:?}",
                play.feed.blocked()
            );
            let last = Cursor(r.txs.last().unwrap().seq);
            assert_eq!((land.cursor, play.cursor), (last, last), "{name}");
            let acc = play.feed.wide_accounted();
            assert!(
                (acc.contains_key("CONQUEST_DECLARED") || acc.contains_key("CONQUEST_RESERVED"))
                    && acc.contains_key("CONQUEST_RESOLVED"),
                "{name}: {acc:?}"
            );
        }
    }
}
