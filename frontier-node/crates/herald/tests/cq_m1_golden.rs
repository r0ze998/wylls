//! `cq_*`: M1 outputs are byte-identical to the Wave-2 base (`3751173`,
//! R-22 / §4.5): the M1 fixture `mini_season(24)` folded and ingested
//! produces the same files, WS diffs, checkpoint, `/h/me` and findex index
//! rows as before the MC hooks. The digests below were produced by the
//! base's code (a scratch checkout of `3751173` running this same test in
//! print mode) and by this branch's; both gave the same values.
//!
//! Print mode: `CQ_M1_GOLDEN_PRINT=1 cargo test -p herald --test cq_m1_golden -- --nocapture`.

mod common;

use std::sync::Arc;

use common::{tmp, tree};
use herald_fold::clash::Provisional;
use herald_fold::files::Out;
use herald_fold::fixture;
use herald_fold::fold::{Fold, FoldCfg};
use sha2::{Digest, Sha256};

const TREE: &str = "76e04131995399ebf8d397a1c09c4a8b0d4c6413b46e41179851101bf31cd63e";
const DIFFS: &str = "e1f693a2ea6354cd8ee3eade1c37b251d822b40a229f6aa5e0fa4280542d29da";
const CHECKPOINT: &str = "0be391db27d2113457f627fa32250dfe98d9f249475e2bc89a8003198638bd4f";
const ME: &str = "925989bae83dbd7c54da16e5bb4838f5f6ac07c84f908f745b3944a5845230a8";
const INDEX: &str = "bce3883a982f4d4550aa8da426c32552c9e93823cc2d66be6696e7ad58a9b655";

fn h(parts: impl IntoIterator<Item = Vec<u8>>) -> String {
    let mut s = Sha256::new();
    for p in parts {
        s.update((p.len() as u64).to_le_bytes());
        s.update(&p);
    }
    hex::encode(s.finalize())
}

#[test]
fn cq_m1_outputs_match_the_base() {
    let txs = fixture::mini_season(24);
    let d = tmp("cqgold");
    let cfg = FoldCfg {
        program: fixture::program(),
        season_id: fixture::SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    };
    let mut f = Fold::new(cfg, Out::new(&d));
    let mut diffs = vec![];
    for t in &txs {
        f.apply(t);
        for x in f.take_diffs() {
            diffs.push(
                format!(
                    "{}|{}|{}|{:?}|{}|{:?}",
                    x.kind,
                    x.key,
                    x.slot,
                    x.head.map(hex::encode),
                    hex::encode(&x.bytes),
                    x.scope
                )
                .into_bytes(),
            );
        }
    }
    let files = tree(&d);
    let n_files = files.len();
    let n_diffs = diffs.len();
    let tree_h = h(files.into_iter().flat_map(|(p, b)| [p.into_bytes(), b]));
    let diffs_h = h(diffs);
    let p = fixture::program().to_bytes();
    let ck = herald_fold::checkpoint::encode(&p, fixture::SEASON_ID, &f.st);
    let ck_h = h([ck]);
    let me = herald_fold::views::me_json(&f, &fixture::wallet(), serde_json::Value::Null);
    let me_h = h([serde_json::to_vec(&me).unwrap()]);
    let dir = tmp("cqgoldidx");
    std::fs::create_dir_all(&dir).unwrap();
    let mut idx = findex::index::Index::open(
        &dir.join("i.sqlite"),
        fixture::program(),
        Some(fixture::ctx()),
    )
    .unwrap();
    idx.add(&txs).unwrap();
    let rows = idx.dump_rows().unwrap();
    let n_rows = rows.len();
    let idx_h = h(rows.into_iter().map(String::into_bytes));
    if std::env::var("CQ_M1_GOLDEN_PRINT").is_ok() {
        eprintln!(
            "GOLDEN files={n_files} diffs={n_diffs} rows={n_rows}\nTREE={tree_h}\nDIFFS={diffs_h}\nCHECKPOINT={ck_h}\nME={me_h}\nINDEX={idx_h}"
        );
        return;
    }
    assert_eq!(tree_h, TREE, "files");
    assert_eq!(diffs_h, DIFFS, "WS diffs");
    assert_eq!(ck_h, CHECKPOINT, "checkpoint");
    assert_eq!(me_h, ME, "/h/me");
    assert_eq!(idx_h, INDEX, "findex rows");
    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::remove_dir_all(&dir);
}
