//! The fold checkpoint against the archive it was taken from: a checkpoint
//! that covers more than the archive holds (the archive was restored from
//! an older copy, or lost its tail) is not trusted. `Ingest::open` discards
//! it and refolds from the archive; the files end as a one-pass fold's.
//! (A checkpoint is only taken after the archive's pending group commit;
//! a crash before one is `fold.rs`'s restart test.)

mod common;

use std::sync::Arc;

use common::{tmp, tree, VecSource};
use herald_fold::clash::Provisional;
use herald_fold::files::Out;
use herald_fold::fixture;
use herald_fold::fold::{Fold, FoldCfg};
use herald_fold::runner::{Ingest, IngestCfg};
use tokio::sync::broadcast;

fn fold_all(dir: &std::path::Path, txs: &[fclient::ports::TxRecord]) {
    let mut f = Fold::new(
        FoldCfg {
            program: fixture::program(),
            season_id: fixture::SEASON_ID,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new(dir),
    );
    for t in txs {
        f.apply(t);
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let t = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &t);
        } else {
            std::fs::copy(e.path(), &t).unwrap();
        }
    }
}

#[tokio::test]
async fn a_checkpoint_ahead_of_the_archive_is_discarded_and_the_fold_redone() {
    let txs = fixture::mini_season(12);
    let reference = tmp("cons-ref");
    fold_all(&reference.join("files"), &txs);

    let data = tmp("cons-ingest");
    let (diffs, _) = broadcast::channel(16_384);
    let mut c = IngestCfg::new(&data, fixture::program(), fixture::SEASON_ID);
    c.segment_bytes = 64 * 1024;
    c.checkpoint_slots = u64::MAX / 2;
    c.archive_commit = std::time::Duration::ZERO;
    let half = txs.len() / 2;
    let older = tmp("cons-older-findex");
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..half].to_vec(), 19);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.findex.commit().unwrap();
        // An older copy of the archive and index, as a backup would hold.
        copy_dir(&c.findex_dir(), &older);
        let mut src = VecSource::new(txs.clone(), 19);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
        assert_eq!(ing.fold.read().unwrap().st.folded_through, txs.len() as u64);
    }
    // The archive is restored from the older copy; the checkpoint stays.
    std::fs::remove_dir_all(c.findex_dir()).unwrap();
    copy_dir(&older, &c.findex_dir());
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        assert_eq!(ing.findex.archive.last_seq(), half as u64);
        assert_eq!(
            ing.fold.read().unwrap().st.folded_through,
            half as u64,
            "the checkpoint (all) is ahead of the archive (half): discarded, refolded from the archive"
        );
        let mut src = VecSource::new(txs.clone(), 1_000);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        let f = ing.fold.read().unwrap();
        assert_eq!(f.st.folded_through, txs.len() as u64);
        assert_eq!(ing.findex.index.last_event().unwrap(), f.st.events);
    }
    assert_eq!(tree(&data.join("files")), tree(&reference.join("files")));
    for d in [&data, &reference, &older] {
        let _ = std::fs::remove_dir_all(d);
    }
}
