//! Compact output (files.rs `Out::compact`, runner `IngestCfg::compact_output`, herald
//! `--output compact-v1`; 2026-11-14): a new test world's data directory keeps only the
//! deterministic `.gz` of each output file, so a long world fits the launcher's output budget.
//! These tests hold it to the default output over the synthetic conquest mini-season:
//! - the compact root is exactly the default root's `.gz` files, byte for byte, and every
//!   file of every bell decompresses to the default plain bytes (`final.json` included: its
//!   season series is read back from every bell's control file — the review's blocker);
//! - restarts from checkpoints and a crash give the same compact files as one pass, and the
//!   world cannot be reopened in the other mode;
//! - the real router answers a gzip client with the stored member and any other client with
//!   the default plain bytes.

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use common::{tmp, tree, VecSource};
use herald_fold::clash::Provisional;
use herald_fold::cqfixture::{self, SEASON_ID};
use herald_fold::cqfmt::FinalFile;
use herald_fold::files::{gunzip, output_mode_word, Out, OUTPUT_COMPACT_V1, OUTPUT_COMPACT_V2, OUTPUT_MODE_FILE};
use herald_fold::fold::{Fold, FoldCfg};
use herald_fold::runner::{Ingest, IngestCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

fn cfg() -> FoldCfg {
    FoldCfg {
        program: cqfixture::program(),
        season_id: SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    }
}

fn fold_all(out: Out, txs: &[fclient::ports::TxRecord]) -> Fold {
    let mut f = Fold::new(cfg(), out);
    for t in txs {
        f.apply(t);
    }
    f
}

/// The compact root holds exactly the default root's `.gz` files (byte for byte) and nothing
/// else, and every default plain file reads back from the compact root unchanged.
fn assert_compact_is_default_gzipped(default: &Path, compact: &Path) {
    let d = tree(default);
    let c = tree(compact);
    let gz: Vec<(String, Vec<u8>)> = d
        .iter()
        .filter(|(r, _)| r.ends_with(".gz"))
        .cloned()
        .collect();
    assert!(!gz.is_empty());
    assert_eq!(c.len(), gz.len(), "one compact file per default sibling");
    assert_eq!(
        c, gz,
        "the compact files are the default siblings, byte for byte"
    );
    let oc = Out::synced(compact).compact();
    let mut plain = 0;
    for (rel, bytes) in d.iter().filter(|(r, _)| !r.ends_with(".gz")) {
        assert_eq!(oc.read(rel).as_deref(), Some(bytes.as_slice()), "{rel}");
        plain += 1;
    }
    assert_eq!(plain, gz.len(), "every default file has its sibling");
}

#[test]
fn compact_fold_is_the_default_history_gzipped() {
    let txs = cqfixture::mini_season();
    let (dd, dc) = (tmp("cq-default"), tmp("cq-compact"));
    let fd = fold_all(Out::new(&dd), &txs);
    let fc = fold_all(Out::new(&dc).compact(), &txs);
    assert!(
        fd.cq.final_done && fc.cq.final_done,
        "both reach the season's final files"
    );
    assert_eq!(fc.cq.alarms.conquest_mismatch, 0);
    assert_eq!(fc.st.alarms.write_errors, 0, "no write refused");
    assert_compact_is_default_gzipped(&dd, &dc);
    // the review's blocker: final.json's season series is read back from every bell's control file
    let fin_d = std::fs::read(dd.join("h/season/final.json")).unwrap();
    let fin_c = Out::synced(&dc)
        .compact()
        .read("h/season/final.json")
        .unwrap();
    assert_eq!(fin_c, fin_d, "the same final file, series included");
    FinalFile::parse(&fin_c).unwrap();
    assert!(
        !dc.join("h/season/final.json").exists(),
        "no plain file in the compact root"
    );
    let _ = (std::fs::remove_dir_all(&dd), std::fs::remove_dir_all(&dc));
}

/// As `cq_fold.rs` `cq_fold_restarts_from_checkpoints`, in compact mode.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_restarts_from_checkpoints_and_keeps_its_mode() {
    let txs = cqfixture::mini_season();
    let reference = tmp("cq-compact-ref");
    fold_all(Out::new(reference.join("files")).compact(), &txs);
    let data = tmp("cq-compact-ingest");
    let (diffs, _) = broadcast::channel(65_536);
    let mut c = IngestCfg::new(&data, cqfixture::program(), SEASON_ID);
    c.segment_bytes = 256 * 1024;
    c.checkpoint_slots = u64::MAX / 2;
    c.archive_commit = std::time::Duration::ZERO;
    c.compact_output = true;
    let n = txs.len();
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 3].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
    }
    assert_eq!(
        std::fs::read(data.join(OUTPUT_MODE_FILE)).unwrap(),
        OUTPUT_COMPACT_V1
    );
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..2 * n / 3].to_vec(), 41);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        // crash: no checkpoint
    }
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs.clone(), 1_000);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        let f = ing.fold.read().unwrap();
        assert_eq!(f.st.folded_through, txs.len() as u64);
        assert!(f.cq.final_done, "the series read back after the restarts");
    }
    assert_eq!(tree(&data.join("files")), tree(&reference.join("files")));
    // the same data directory cannot be reopened without compact output
    let mut plain = c.clone();
    plain.compact_output = false;
    let e = Ingest::open(plain, diffs.clone()).err().expect("refused");
    assert!(e.contains("compact output"), "{e}");
    // and compact output cannot start over another world's output
    let other = tmp("cq-default-world");
    {
        let mut d = IngestCfg::new(&other, cqfixture::program(), SEASON_ID);
        d.archive_commit = std::time::Duration::ZERO;
        let mut ing = Ingest::open(d.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 3].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
        let before = tree(&other.join("files"));
        d.compact_output = true;
        let e = Ingest::open(d, diffs.clone()).err().expect("refused");
        assert!(e.contains("new data directory"), "{e}");
        assert_eq!(
            tree(&other.join("files")),
            before,
            "nothing written or removed"
        );
        assert!(!other.join(OUTPUT_MODE_FILE).exists());
    }
    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&reference);
    let _ = std::fs::remove_dir_all(&other);
}

/// Round 14 (TEST-ONLY): `--output compact-v2` = compact output AND the findex store gzip-compressed (findex::codec). The
/// fold's output is the same as compact-v1's, the store records its codec, restarts keep the mode, and a data directory
/// is never reopened with another word, without it, or started over an existing store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_v2_compresses_the_store_gives_the_same_output_and_keeps_its_mode() {
    let txs = cqfixture::mini_season();
    let reference = tmp("cq-v2-ref");
    fold_all(Out::new(reference.join("files")).compact(), &txs);
    let data = tmp("cq-v2-ingest");
    let (diffs, _) = broadcast::channel(65_536);
    let mut c = IngestCfg::new(&data, cqfixture::program(), SEASON_ID);
    c.segment_bytes = 256 * 1024;
    c.checkpoint_slots = u64::MAX / 2;
    c.archive_commit = std::time::Duration::ZERO;
    c.compact_output = true;
    c.store_codec = findex::codec::Codec::GzipV1;
    let n = txs.len();
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 2].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
    }
    assert_eq!(std::fs::read(data.join(OUTPUT_MODE_FILE)).unwrap(), OUTPUT_COMPACT_V2);
    let m: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("findex/archive/manifest.json")).unwrap()).unwrap();
    assert_eq!(m["codec"], json!("gzip-v1"), "the archive records its codec");
    {
        // a crash (no checkpoint), then the whole season
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..3 * n / 4].to_vec(), 41);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
    }
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs.clone(), 1_000);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        let f = ing.fold.read().unwrap();
        assert_eq!(f.st.folded_through, txs.len() as u64);
        assert!(f.cq.final_done);
        let codec: i64 = ing.findex.index.conn.query_row("SELECT v FROM meta WHERE k = 'snapshot_codec'", [], |r| r.get(0)).unwrap();
        assert_eq!(codec, 1, "the index records its codec");
        assert_eq!(ing.findex.archive.verify().unwrap(), txs.len() as u64);
    }
    assert_eq!(tree(&data.join("files")), tree(&reference.join("files")), "the same output as compact-v1");
    // never reopened as compact-v1, nor without a word
    let mut v1 = c.clone();
    v1.store_codec = findex::codec::Codec::Plain;
    let e = Ingest::open(v1, diffs.clone()).err().expect("refused");
    assert!(e.contains("cannot be reopened as --output compact-v1"), "{e}");
    let mut plain = c.clone();
    plain.compact_output = false;
    plain.store_codec = findex::codec::Codec::Plain;
    let e = Ingest::open(plain, diffs.clone()).err().expect("refused");
    assert!(e.contains("compact-v2") && e.contains("without it"), "{e}");
    // a compressed store without compact output is not a mode
    let mut odd = c.clone();
    odd.compact_output = false;
    assert!(Ingest::open(odd, diffs.clone()).err().expect("refused").contains("only with compact output"));
    // a compact-v1 world is never reopened as compact-v2; an existing default world's store is never started as one
    let w1 = tmp("cq-v1-world");
    {
        let mut d = IngestCfg::new(&w1, cqfixture::program(), SEASON_ID);
        d.archive_commit = std::time::Duration::ZERO;
        d.compact_output = true;
        let mut ing = Ingest::open(d.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 4].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
        let m: serde_json::Value = serde_json::from_slice(&std::fs::read(w1.join("findex/archive/manifest.json")).unwrap()).unwrap();
        assert!(m.get("codec").is_none(), "compact-v1 keeps the default store bytes");
        d.store_codec = findex::codec::Codec::GzipV1;
        let e = Ingest::open(d, diffs.clone()).err().expect("refused");
        assert!(e.contains("cannot be reopened as --output compact-v2"), "{e}");
        assert_eq!(std::fs::read(w1.join(OUTPUT_MODE_FILE)).unwrap(), OUTPUT_COMPACT_V1, "its mode is unchanged");
    }
    let w0 = tmp("cq-v0-world");
    {
        let mut d = IngestCfg::new(&w0, cqfixture::program(), SEASON_ID);
        d.archive_commit = std::time::Duration::ZERO;
        let mut ing = Ingest::open(d.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 4].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
        let before = tree(&w0.join("findex"));
        d.compact_output = true;
        d.store_codec = findex::codec::Codec::GzipV1;
        let e = Ingest::open(d, diffs.clone()).err().expect("refused");
        assert!(e.contains("compact-v2 needs a new data directory"), "{e}");
        assert_eq!(tree(&w0.join("findex")), before, "the old store is not touched");
        assert!(!w0.join(OUTPUT_MODE_FILE).exists());
    }
    // an unknown word is never recorded
    let w9 = tmp("cq-v9");
    assert!(output_mode_word(&w9, &w9.join("files"), Some(b"compact-v9\n")).is_err());
    assert!(!w9.join(OUTPUT_MODE_FILE).exists());
    for d in [&data, &reference, &w1, &w0, &w9] {
        let _ = std::fs::remove_dir_all(d);
    }
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn h(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(x, _)| x.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
    }
}

async fn get(addr: SocketAddr, path: &str, gzip: bool) -> Answer {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let enc = if gzip {
        "Accept-Encoding: gzip\r\n"
    } else {
        ""
    };
    let r = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\n{enc}Connection: close\r\n\r\n");
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    Answer {
        status: a.status,
        headers: a.headers,
        body: a.body,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_world_answers_gzip_and_plain_clients_with_the_default_bytes() {
    let txs = cqfixture::mini_season();
    // the default output of the same records, for the bytes a client must get
    let dd = tmp("cq-http-default");
    fold_all(Out::new(&dd), &txs);
    let data = tmp("cq-http-compact");
    let (diffs, _) = broadcast::channel(1 << 16);
    let mut c = IngestCfg::new(&data, cqfixture::program(), SEASON_ID);
    c.archive_commit = std::time::Duration::ZERO;
    c.compact_output = true;
    let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
    let mut src = VecSource::new(txs.clone(), 1_000);
    ing.findex.resume(&mut src);
    while ing.step(&mut src).await.unwrap() > 0 {}
    assert!(ing.fold.read().unwrap().cq.final_done);
    let app = App::new(
        ing.fold.clone(),
        c.out(),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: fclient::beacon::TestKey::new().info(),
            quotas: json!({"perDay": 40, "burst": 60}),
        },
        diffs,
    );
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    // a control file of the first bell that has one, and the season's final file
    let first = (0..cqfixture::END_BELL)
        .find(|b| dd.join(format!("h/control/{b}.bin")).is_file())
        .expect("a control file");
    for (route, rel) in [
        (
            format!("/h/control/{first}.bin"),
            format!("h/control/{first}.bin"),
        ),
        (
            "/h/season/final.json".to_string(),
            "h/season/final.json".to_string(),
        ),
    ] {
        let plain = std::fs::read(dd.join(&rel)).unwrap();
        let member = std::fs::read(data.join("files").join(format!("{rel}.gz"))).unwrap();
        let z = get(addr, &route, true).await;
        assert_eq!(z.status, 200, "{route}");
        assert_eq!(z.h("content-encoding"), Some("gzip"), "{route}");
        assert_eq!(z.h("vary"), Some("Accept-Encoding"), "{route}");
        assert_eq!(z.body, member, "{route}: the stored member");
        assert_eq!(
            gunzip(&z.body).unwrap(),
            plain,
            "{route}: decompresses to the default bytes"
        );
        let p = get(addr, &route, false).await;
        assert_eq!(p.status, 200, "{route}");
        assert_eq!(p.h("content-encoding"), None, "{route}");
        assert_eq!(p.body, plain, "{route}: the default plain bytes");
    }
    // an absent file is still a 404, for both clients
    for gz in [true, false] {
        assert_eq!(get(addr, "/h/control/999999.bin", gz).await.status, 404);
    }
    let _ = (std::fs::remove_dir_all(&dd), std::fs::remove_dir_all(&data));
}
