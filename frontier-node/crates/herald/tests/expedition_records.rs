#![cfg(feature = "expedition-records-experimental")]
use herald_fold::{
    clash::Provisional,
    files::Out,
    fold::{Fold, FoldCfg},
};
use std::sync::Arc;
#[test]
fn browser_archive_and_fold_keep_the_same_ps2_event_numbering() {
    let program = "5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn"
        .parse()
        .unwrap();
    let ctx = findex::addr_ctx(&program, 11);
    let rows: Vec<serde_json::Value> = serde_json::from_slice(include_bytes!(
        "../../findex/tests/fixtures/browser_depart_v1.json"
    ))
    .unwrap();
    let txs: Vec<_> = rows
        .iter()
        .map(|r| findex::archive::record_from_json(r).unwrap())
        .collect();
    let dir = std::env::temp_dir().join(format!(
        "wylls-event-fold-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    assert!(!dir.exists());
    let mut fold = Fold::new(
        FoldCfg {
            program,
            season_id: 11,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new(&dir),
    );
    let mut index =
        findex::Index::open(std::path::Path::new(":memory:"), program, Some(ctx)).unwrap();
    index.add(&txs).unwrap();
    for tx in &txs {
        fold.apply(tx);
    }
    let events: i64 = index
        .conn
        .query_row("SELECT COUNT(*) FROM event", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fold.st.events, events as u64);
    assert_eq!(fold.st.alarms.bad_records, 0);
    assert!(fold
        .diffs
        .iter()
        .any(|d| d.kind == "event" && d.bytes.get(1) == Some(&146)));
    assert_eq!(fold.st.folded_through, 6);
}
