//! P14 (b) (owner decision 2026-11-22 01:12 JST): the devnet playable build
//! (`devnet-playable-sbf`) no longer carries `conquest-dispatch-experimental`,
//! so the version-2 wrapper's Free City conquest kinds 12–18 are refused.
//!
//! Proof over REAL transactions: every successful kind 12–18 transaction the
//! committed recordings hold (made on the previous devnet `.so`, `da3dc1aa…`,
//! where they LANDED and their records latched keeper A's feed guard, P14) is
//! re-executed (`vx_reexec::replay_one`, LiteSVM, the recorded pre-states)
//! against the new devnet `.so` (`fixtures/verify/devnet-playable-<sha8>.so.gz`,
//! the bytes `scripts/build-frontier-devnet-playable-sbf.sh --twice` builds):
//!
//! - each one fails with `BadData` (custom code 1), the wrapper's kind refusal,
//!   before any account is read: no `Program data:` record, no account changed;
//! - keeper A's two indexes (`LandIndex`, `PlayIndex`, the feed guard) read that
//!   failed transaction and are NOT latched; their cursor passes it;
//! - control: the same transactions on the old `.so` still land (so the test
//!   tells the two builds apart), and every expedition kind 0–11 transaction of
//!   the whole-expedition recording lands on the new `.so` with the recorded
//!   post-states (the expedition lane is unchanged).
//!
//! Key-free: committed recordings and binaries only; signatures are checked,
//! nothing is signed.
#![cfg(feature = "playable-lane")]

mod common;

use fclient::addr::Addresses;
use fclient::ports::{Cursor, TxRecord};
use keeper_core::landindex::LandIndex;
use keeper_core::playindex::PlayIndex;
use verify_core::checks::vx_reexec::replay_one;
use verify_core::input::Input;

/// The new devnet `.so` (P14 b), committed gzipped.
const NEW_SO_GZ: &str = "devnet-playable-67a33c92.so.gz";
const NEW_SHA256: &str = "67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3";
/// The previous devnet `.so` (conquest kinds 12–18 reachable), the recordings' program.
const OLD_SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";
const OLD_SHA256: &str = "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";

/// The recordings holding conquest kinds (`keeper/tests/expedition_feed_guard.rs` reads the same).
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

fn so(name: &str, sha: &str) -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(name))
        .expect("the committed .so");
    assert_eq!(hex::encode(p.sha256()), sha, "{name}");
    std::sync::Arc::new(p.so.as_ref().clone())
}

/// The version-2 dispatch kind of transaction `t`'s program instruction
/// (`[tag, 0xff, 2, kind]`), if it has one.
fn kind(inp: &Input, t: usize) -> Option<u8> {
    let w = fclient::tx::from_wire(&inp.txs[t].tx).ok()?;
    let m = &w.message;
    m.instructions
        .iter()
        .find(|ix| m.account_keys.get(ix.program_id_index as usize) == Some(&inp.cfg.program))
        .filter(|ix| ix.data.len() > 3 && ix.data[1] == 0xFF && ix.data[2] == 2)
        .map(|ix| ix.data[3])
}

fn addrs(inp: &Input) -> Addresses {
    Addresses::new(inp.cfg.program, inp.cfg.season_id)
}

#[test]
fn the_new_devnet_so_carries_no_conquest_kind_and_keeps_its_marker() {
    let new = so(NEW_SO_GZ, NEW_SHA256);
    let has = |m: &[u8]| new.windows(m.len()).any(|w| w == m);
    assert!(has(b"PSF_DEVNET_PLAYABLE_BUILD"));
    for m in [
        &b"PSF_LOCALNET_EXPEDITION_SBF_BUILD"[..],
        b"PSF_LOCALNET_CONQUEST_SBF_BUILD",
        b"PSF_LOCALNET_WIDE_DEPART_BUILD",
    ] {
        assert!(!has(m), "{}", String::from_utf8_lossy(m));
    }
}

#[test]
fn recorded_conquest_kinds_12_to_18_are_refused_bad_data_and_never_latch_keeper_a() {
    let new = so(NEW_SO_GZ, NEW_SHA256);
    let old = so(OLD_SO_GZ, OLD_SHA256);
    let mut seen = std::collections::BTreeMap::<u8, usize>::new();
    for f in FIXTURES {
        let mut inp = common::fixture(f);
        let a = addrs(&inp);
        let picks: Vec<(usize, u8)> = (0..inp.txs.len())
            .filter(|&t| inp.txs[t].err.is_none())
            .filter_map(|t| {
                kind(&inp, t)
                    .filter(|k| (12..=18).contains(k))
                    .map(|k| (t, k))
            })
            .collect();
        for (t, k) in picks {
            // control: the recordings' own program still runs it
            inp.program_so = Some(old.clone());
            let r = replay_one(&inp, t).unwrap_or_else(|e| panic!("{f} tx#{t}: {e}"));
            assert_eq!(r.err, None, "{f} tx#{t} kind {k} on da3dc1aa: {:?}", r.logs);
            // the new devnet build refuses it as BadData (code 1) before any effect
            inp.program_so = Some(new.clone());
            let r = replay_one(&inp, t).unwrap_or_else(|e| panic!("{f} tx#{t}: {e}"));
            let err = r.err.clone().unwrap_or_else(|| {
                panic!(
                    "{f} tx#{t} kind {k} landed on the new devnet .so: {:?}",
                    r.logs
                )
            });
            assert!(err.contains("Custom(1)"), "{f} tx#{t} kind {k}: {err}");
            let pid = inp.cfg.program.to_string();
            assert!(
                r.logs
                    .iter()
                    .any(|l| l == &format!("Program {pid} failed: custom program error: 0x1")),
                "{f} tx#{t} kind {k}: {:?}",
                r.logs
            );
            assert!(
                !r.logs.iter().any(|l| l.starts_with("Program data: ")),
                "{f} tx#{t} kind {k}: a record was logged: {:?}",
                r.logs
            );
            // the program wrote nothing: every program-owned account is as it was
            for (key, _, before, after) in &r.accounts {
                if before.as_ref().is_some_and(|b| b.owner == inp.cfg.program) {
                    assert_eq!(
                        before.as_ref().map(|b| &b.data),
                        after.as_ref().map(|x| &x.data),
                        "{f} tx#{t} kind {k}: {} changed",
                        hex::encode(key)
                    );
                }
            }
            // keeper A reads the failed transaction as the chain would serve it, and is not latched
            let mut rec: TxRecord = inp.txs[t].clone();
            rec.err = Some(err.clone());
            rec.logs = r.logs.clone();
            rec.post.clear();
            let mut land = LandIndex::default();
            let mut play = PlayIndex::default();
            land.ingest_page(std::slice::from_ref(&rec), &a);
            play.ingest_page(std::slice::from_ref(&rec), &a);
            assert!(
                land.feed.blocked().is_none(),
                "{f} tx#{t} kind {k}: {:?}",
                land.feed.blocked()
            );
            assert!(
                play.feed.blocked().is_none(),
                "{f} tx#{t} kind {k}: {:?}",
                play.feed.blocked()
            );
            assert_eq!(
                (land.cursor, play.cursor),
                (Cursor(rec.seq), Cursor(rec.seq))
            );
            *seen.entry(k).or_default() += 1;
        }
    }
    eprintln!("P14 b: refused per kind {seen:?}");
    assert_eq!(
        seen.keys().copied().collect::<Vec<_>>(),
        (12..=18).collect::<Vec<_>>(),
        "every conquest kind 12..=18 is in the recordings"
    );
}

#[test]
fn expedition_kinds_0_to_11_still_land_on_the_new_devnet_so_with_the_recorded_states() {
    let new = so(NEW_SO_GZ, NEW_SHA256);
    let mut seen = std::collections::BTreeMap::<u8, usize>::new();
    for f in FIXTURES {
        let mut inp = common::fixture(f);
        inp.program_so = Some(new.clone());
        for t in 0..inp.txs.len() {
            let Some(k) = kind(&inp, t).filter(|k| *k <= 11) else {
                continue;
            };
            if inp.txs[t].err.is_some() {
                continue;
            }
            let r = replay_one(&inp, t).unwrap_or_else(|e| panic!("{f} tx#{t}: {e}"));
            assert_eq!(r.err, None, "{f} tx#{t} kind {k}: {:?}", r.logs);
            // every program-owned account the recording shows after it is byte-identical on the new build
            for (key, post) in &inp.txs[t].post {
                if post.as_ref().is_none_or(|p| p.owner != inp.cfg.program) {
                    continue;
                }
                let after = r
                    .accounts
                    .iter()
                    .find(|(x, ..)| x == &key.to_bytes())
                    .map(|(_, _, _, after)| after);
                assert_eq!(
                    after.map(|a| a.as_ref().map(|x| &x.data)),
                    Some(post.as_ref().map(|p| &p.data)),
                    "{f} tx#{t} kind {k}: {key} differs"
                );
            }
            *seen.entry(k).or_default() += 1;
        }
    }
    eprintln!("P14 b: expedition kinds replayed {seen:?}");
    assert_eq!(
        seen.keys().copied().collect::<Vec<_>>(),
        (0..=11).collect::<Vec<_>>(),
        "every expedition kind 0..=11 is in the recordings"
    );
}
