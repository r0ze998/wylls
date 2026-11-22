//! fix wide-herald-lag: the control fold over a GROWN map. A wide world
//! (`play-local.sh --wide`) opens the rim, ring 128 (`R_MAX_HARD`), past
//! what the dense `PSFCT1` file can hold (rings 0..=127, CF-2); before the
//! fix the first control bell after a rim province opened refused
//! (`rings > CONTROL_MAX_RING`), so `/h/control` and `/h/standings` stood
//! at the setup's last bell for the rest of the world.
//!
//! The conquest mini-season (`herald_fold::cqfixture`) is folded twice: as
//! it is, and with a TWIN of one of its ring-2 provinces at ring 128 —
//! every post-state of the original mirrored to the twin's address with
//! the twin's coordinates. Then:
//! - the control bells go on to the season's end (the gap);
//! - the positional heartland files (`h/control`, `h/call`) are byte for
//!   byte the plain fold's, and `h/sieges` is the plain fold's plus the
//!   twin's own entries (fix-code-questions, D-keep-capture-progress-2: the
//!   sieges file names provinces by (p, q) and lists the rim's keep contests
//!   and sieges too; the fog is the page's view only, the herald is public);
//! - the standings' per-nation provinces count the twin with its holder.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::tmp;
use fclient::ports::TxRecord;
use frontier_abi::v2::layout::province::province as P;
use herald_fold::clash::Provisional;
use herald_fold::cqfixture::{self, SEASON_ID};
use herald_fold::cqfmt::ControlFile;
use herald_fold::fold::{Fold, FoldCfg};
use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};

fn cfg() -> FoldCfg {
    FoldCfg {
        program: cqfixture::program(),
        season_id: SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    }
}

fn fold_all(dir: &std::path::Path, txs: &[TxRecord]) -> Fold {
    let mut f = Fold::new(cfg(), herald_fold::files::Out::new(dir));
    for t in txs {
        f.apply(t);
    }
    f
}

/// The twin's coordinate: ring 128, the rim of a grown map.
const TWIN: (i16, i16) = (R_MAX_HARD as i16, 0);

/// `txs` with every post-state of the province at `of` mirrored to a twin at [`TWIN`].
fn with_twin(txs: &[TxRecord], of: (i16, i16)) -> Vec<TxRecord> {
    let ctx = cqfixture::ctx();
    let orig = solana_address::Address::new_from_array(ctx.province(of.0 as i32, of.1 as i32));
    let twin = solana_address::Address::new_from_array(ctx.province(TWIN.0 as i32, TWIN.1 as i32));
    let ring = ProvinceCoord::new(TWIN.0 as i32, TWIN.1 as i32).ring() as u16;
    txs.iter()
        .cloned()
        .map(|mut t| {
            let mirrored: Vec<_> = t
                .post
                .iter()
                .filter(|(k, _)| *k == orig)
                .map(|(_, acc)| {
                    let acc = acc.clone().map(|mut a| {
                        a.data[P::P..P::P + 2].copy_from_slice(&TWIN.0.to_le_bytes());
                        a.data[P::Q..P::Q + 2].copy_from_slice(&TWIN.1.to_le_bytes());
                        a.data[P::RING..P::RING + 2].copy_from_slice(&ring.to_le_bytes());
                        a
                    });
                    (twin, acc)
                })
                .collect();
            t.post.extend(mirrored);
            t
        })
        .collect()
}

/// Every file under `dir/rel_dir`, by name.
fn files(dir: &std::path::Path, rel_dir: &str) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(dir.join(rel_dir)) else {
        return out;
    };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.ends_with(".tmp") {
            continue;
        }
        out.insert(n, std::fs::read(e.path()).unwrap());
    }
    out
}

fn last_control_bell(dir: &std::path::Path) -> Option<u32> {
    files(dir, "h/control")
        .keys()
        .filter_map(|n| n.strip_suffix(".bin")?.parse().ok())
        .max()
}

/// `(p, q)` of a sieges-file entry.
fn pq(e: &serde_json::Value) -> (i64, i64) {
    (e["p"].as_i64().unwrap(), e["q"].as_i64().unwrap())
}

/// The entries of one array of a sieges file at `at`, re-addressed to `to` (`owner`, the holding owner's tag the fold
/// looks up by the site's own coordinate, is left out: the twin has no holdings index entry of its own; so is `key`,
/// which spells the coordinate).
fn entries_at(
    v: &serde_json::Value,
    key: &str,
    at: (i16, i16),
    to: (i16, i16),
) -> Vec<serde_json::Value> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| pq(e) == (at.0 as i64, at.1 as i64))
        .map(|e| {
            let mut e = e.clone();
            let o = e.as_object_mut().unwrap();
            o.insert("p".into(), to.0.into());
            o.insert("q".into(), to.1.into());
            o.remove("owner");
            o.remove("key");
            e
        })
        .collect()
}

/// Every `h/sieges` file of the twin fold is the plain fold's with the twin's own entries added, and those are the
/// original province's entries at `of`, re-addressed (the rim is listed, not dropped). → how many twin entries.
fn assert_sieges_with_twin(db: &std::path::Path, dt: &std::path::Path, of: (i16, i16)) -> usize {
    let json = |d| -> BTreeMap<String, Vec<u8>> {
        files(d, "h/sieges")
            .into_iter()
            .filter(|(n, _)| n.ends_with(".json"))
            .collect()
    };
    let (a, b) = (json(db), json(dt));
    assert!(!a.is_empty(), "h/sieges written");
    assert_eq!(
        a.keys().collect::<Vec<_>>(),
        b.keys().collect::<Vec<_>>(),
        "h/sieges: the same files"
    );
    let mut n = 0;
    for (name, bytes) in &a {
        let base: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let twin: serde_json::Value = serde_json::from_slice(&b[name]).unwrap();
        assert_eq!(base["bell"], twin["bell"], "h/sieges/{name}: the same bell");
        for key in ["sieges", "keeps"] {
            let t = twin[key].as_array().unwrap();
            let rest: Vec<_> = t
                .iter()
                .filter(|e| pq(e) != (TWIN.0 as i64, TWIN.1 as i64))
                .cloned()
                .collect();
            assert_eq!(
                &rest,
                base[key].as_array().unwrap(),
                "h/sieges/{name}: the heartland's {key} unchanged"
            );
            let got = entries_at(&twin, key, TWIN, TWIN);
            assert_eq!(
                got,
                entries_at(&base, key, of, TWIN),
                "h/sieges/{name}: the rim twin's {key} are listed"
            );
            n += got.len();
        }
    }
    n
}

/// D-keep-capture-progress-2: a rim (ring 128) province's keep contest is listed in `/h/sieges` (it stood empty in
/// a `--wide` world while rim keeps were contested). The twin is of a province that HAS sieges-file entries.
#[test]
fn a_rim_province_keep_contest_is_listed_in_the_sieges_file() {
    let base_txs = cqfixture::mini_season();
    let db = tmp("grown-sieges-base");
    let _fb = fold_all(&db, &base_txs);
    // the heartland province with the most keep-contest entries over the season's sieges files
    let mut count: BTreeMap<(i64, i64), usize> = BTreeMap::new();
    for (_, bytes) in files(&db, "h/sieges")
        .iter()
        .filter(|(n, _)| n.ends_with(".json"))
    {
        let v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        for e in v["keeps"].as_array().unwrap() {
            *count.entry(pq(e)).or_default() += 1;
        }
    }
    let (&(p, q), &keeps) = count
        .iter()
        .max_by_key(|(_, n)| **n)
        .expect("the mini-season has a keep contest");
    assert!(keeps > 0);
    let of = (p as i16, q as i16);
    let dt = tmp("grown-sieges-twin");
    let _ft = fold_all(&dt, &with_twin(&base_txs, of));
    let n = assert_sieges_with_twin(&db, &dt, of);
    assert!(
        n >= keeps,
        "the rim twin's keep contests are listed: {n} entries, want ≥ {keeps}"
    );
    let _ = std::fs::remove_dir_all(db);
    let _ = std::fs::remove_dir_all(dt);
}

#[test]
fn a_rim_province_keeps_the_control_bells_going_and_counts_without_a_position() {
    let base_txs = cqfixture::mini_season();
    // a ring-2 province the season opens (any; the first in order)
    let ctx = cqfixture::ctx();
    let of = (-2i16..=2)
        .flat_map(|p| (-2i16..=2).map(move |q| (p, q)))
        .find(|&(p, q)| {
            ProvinceCoord::new(p as i32, q as i32).ring() == 2 && {
                let k = solana_address::Address::new_from_array(ctx.province(p as i32, q as i32));
                base_txs.iter().any(|t| t.post.iter().any(|(a, _)| *a == k))
            }
        })
        .expect("a ring-2 province in the mini-season");
    let twin_txs = with_twin(&base_txs, of);

    let (db, dt) = (tmp("grown-base"), tmp("grown-twin"));
    let _fb = fold_all(&db, &base_txs);
    let ft = fold_all(&dt, &twin_txs);
    assert!(
        ft.provinces.contains_key(&TWIN),
        "the twin is an opened province of the fold"
    );

    // 1. the gap: control bells go on past the twin's opening, to the plain fold's last
    let (lb, lt) = (last_control_bell(&db), last_control_bell(&dt));
    assert!(
        lb.is_some_and(|b| b > 100),
        "the plain fold writes the season's control bells: {lb:?}"
    );
    assert_eq!(
        lt, lb,
        "a ring-128 province must not stop the control bells"
    );

    // 2. the positional heartland files are the plain fold's, byte for byte; the sieges file is the plain fold's
    //    plus the twin's own entries (a copy of the original's)
    assert_sieges_with_twin(&db, &dt, of);
    for rel in ["h/control", "h/call"] {
        let (a, b) = (files(&db, rel), files(&dt, rel));
        assert!(!a.is_empty() || rel == "h/call", "{rel} written");
        assert_eq!(
            a.keys().collect::<Vec<_>>(),
            b.keys().collect::<Vec<_>>(),
            "{rel}: the same files"
        );
        for (n, bytes) in &a {
            assert!(b[n] == *bytes, "{rel}/{n} differs with a rim province");
        }
    }
    let last = lb.unwrap();
    let cf = ControlFile::decode(&files(&dt, "h/control")[&format!("{last}.bin")]).unwrap();
    assert!(
        cf.rings().unwrap() < R_MAX_HARD as u32,
        "the file holds the heartland's rings only"
    );

    // 3. the public counts: the twin counts with its holder, nothing else changes
    let sl = |d: &std::path::Path| -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(d.join("h/standings/latest.json")).unwrap()).unwrap()
    };
    let (sb, st) = (sl(&db), sl(&dt));
    assert_eq!(
        sb["bell"], st["bell"],
        "the standings stand at the same bell"
    );
    let holder = ft
        .account(&ctx.province(TWIN.0 as i32, TWIN.1 as i32))
        .and_then(|c| {
            frontier_abi::conquest_model::read_keep(&c.data)
                .ok()
                .flatten()
        })
        .map(|k| k.holder);
    let mut diff = [0i64; 6];
    for (x, d) in diff.iter_mut().enumerate() {
        let n = |v: &serde_json::Value| v["factions"][x]["provinces"].as_i64().unwrap();
        *d = n(&st) - n(&sb);
    }
    match holder {
        Some(h) if h < 6 => {
            let mut want = [0i64; 6];
            want[h as usize] = 1;
            assert_eq!(
                diff, want,
                "the rim province counts for its keep's holder {h}"
            );
        }
        _ => assert_eq!(diff, [0; 6], "an unheld rim keep counts for no one"),
    }
    let _ = std::fs::remove_dir_all(db);
    let _ = std::fs::remove_dir_all(dt);
}

/// The wide land (ring 129+): a captured wide Province's keep counts for its holder in the standings, from the bell
/// its capture speaks for; it never enters the control file. (feature `wide-world-experimental`, as the local
/// wide world's herald is built.)
#[cfg(feature = "wide-world-experimental")]
#[test]
fn a_wide_keep_counts_for_its_holder_in_the_standings_only() {
    use fclient::ports::{Account, Signature};
    use frontier_abi::world_index::{land, WideCoord};
    let base_txs = cqfixture::mini_season();
    let probe = Fold::new(cfg(), herald_fold::files::Out::new(tmp("grown-probe")));
    let world = probe.wide.as_ref().expect("the wide index").world();
    let c = WideCoord::checked(-61, 129).unwrap();
    let wp = land::WideProvince {
        season_id: SEASON_ID,
        world,
        coord: c,
        wedge: c.wedge().unwrap(),
        region: 3,
        opened_bell: 1,
        readiness: land::readiness::REQUIRED,
        seed_round: 99,
        ring_seed: [7; 32],
        funded_lamports: 10,
    };
    let mut d = vec![0; land::province::SIZE];
    wp.write_identity(&mut d).unwrap();
    let keep = P::KEEP;
    d[keep + frontier_abi::v2::layout::province::keep::HOLDER] = 4;
    d[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&2u32.to_le_bytes());
    let key = land::province_address(&probe.ctx, c);
    let capture = |after: &TxRecord, data: Vec<u8>| TxRecord {
        seq: after.seq,
        slot: after.slot,
        signature: Signature::from([7; 64]),
        block_time: after.block_time,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![(
            solana_address::Address::new_from_array(key),
            Some(Account {
                owner: cqfixture::program(),
                data,
                lamports: 10,
                executable: false,
            }),
        )],
        loaded: Default::default(),
    };
    // the wide Province captured with the first transaction, then (a later capture: resolved through bell 200,
    // resolved_next 201) its keep passed to nation 1 — both before any control bell is written: the fold counts each
    // bell with the holder its captures speak for, whenever they arrive
    let mut later = d.clone();
    later[keep + frontier_abi::v2::layout::province::keep::HOLDER] = 1;
    later[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&201u32.to_le_bytes());
    let mut txs = base_txs.clone();
    let first = txs[0].clone();
    txs[0].post.extend(capture(&first, d.clone()).post);
    txs[0].post.extend(capture(&first, later.clone()).post);
    let (db, dw) = (tmp("grown-wbase"), tmp("grown-wide"));
    let _fb = fold_all(&db, &base_txs);
    let fw = fold_all(&dw, &txs);
    assert_eq!(
        fw.wide.as_ref().unwrap().keep_entries(),
        1,
        "pruned to the one holder still asked for"
    );
    assert_eq!(
        files(&db, "h/control"),
        files(&dw, "h/control"),
        "the control files are untouched"
    );
    // the hour series: nation 4 holds one more until bell 200, nation 1 from then on
    let series = |d: &std::path::Path| {
        herald_fold::cqfmt::StandingsSeries::decode(
            &std::fs::read(d.join("h/standings/series.bin")).unwrap(),
        )
        .unwrap()
    };
    let (sb, sw) = (series(&db), series(&dw));
    assert_eq!(sb.hours.len(), sw.hours.len());
    let mut seen = (false, false);
    for (h, (a, b)) in sb.hours.iter().zip(&sw.hours).enumerate() {
        let hour = sb.first_hour as usize + h;
        let bell = hour as u32 * 6 + 5;
        let d: Vec<i64> = (0..6)
            .map(|x| b[x].provinces as i64 - a[x].provinces as i64)
            .collect();
        if bell < 200 {
            assert_eq!(
                d,
                [0, 0, 0, 0, 1, 0],
                "hour {hour}: nation 4 holds the wide keep"
            );
            seen.0 = true;
        } else {
            assert_eq!(d, [0, 1, 0, 0, 0, 0], "hour {hour}: nation 1 took it");
            seen.1 = true;
        }
    }
    assert!(seen.0 && seen.1, "both holders covered");
    let _ = std::fs::remove_dir_all(db);
    let _ = std::fs::remove_dir_all(dw);
}
