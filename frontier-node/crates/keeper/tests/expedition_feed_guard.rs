//! Devnet gap P10: the keeper's feed guard and the rim → wide expedition's
//! records, over the REAL transactions of the pinned devnet `.so`
//! (`da3dc1aa…`): the committed verifier recordings
//! `fixtures/verify/playable-expedition-whole.json.gz` and
//! `playable-cov-*.json.gz` (`verify/tests/playable_expedition.rs`), whose
//! `logs` are the program's own. Literal bytes only: no key, no signing, no
//! execution, no network.
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

    /// The expedition kinds a playable-lane keeper applies (0..=11) and the
    /// conquest kinds that still latch it (12..=18, PS2 145 / PSW1 18–24 / PSWC).
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
    fn every_real_expedition_transaction_is_applied_and_every_conquest_one_still_latches() {
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
                assert!(got.is_err(), "{k} (conquest) still latches: {got:?}");
                let mut land = LandIndex::default();
                land.ingest_page(std::slice::from_ref(&t), &a);
                assert!(land.feed.blocked().is_some(), "{k}: latches");
            }
            *seen.entry(k).or_default() += 1;
        }
        for k in KINDS {
            assert!(seen.contains_key(k), "{k} seen: {seen:?}");
        }
    }

    /// The whole main recording through the play index: the expedition is tracked
    /// from its Depart (with the Depart's and the Reveal's wire) to its member
    /// settlement; nothing latches before the conquest kinds start.
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
        // the conquest that follows latches the guard, as before
        play.ingest_page(&r.txs[first_conquest..], &r.addrs);
        assert!(play.feed.blocked().is_some());
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
        // PS2 145 (the conquest's legacy source receipt) still latches, with or without a pair
        let (a, _, t) = pick("DeclareSiege");
        refused(&a, &t, "DeclareSiege (PS2 145)");
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
