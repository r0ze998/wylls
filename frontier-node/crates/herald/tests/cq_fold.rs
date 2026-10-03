//! `cq_*`: the herald's conquest fold (MC contract §8.4; unit CQ2-E) over
//! the synthetic conquest mini-season (`herald_fold::cqfixture`):
//! completeness (every bell's control and sieges file, every overview's
//! v2 sibling, every day, every standings hour, `final.json`), the files'
//! formats (each written file decodes with `cqfmt`'s validating readers),
//! the events the contract lists, the CONQUEST digest check
//! (`conquest_mismatch` on a tampered digest), determinism (one pass,
//! batches through findex, restarts from a checkpoint), and an M1 season
//! untouched by the MC hooks.

mod common;

use std::sync::Arc;

use common::{tmp, tree, VecSource};
use fclient::log::{body_of_line, log_line};
use frontier_abi::v2::log::{self as v2log, AnyKind, CqKind};
use herald_fold::clash::Provisional;
use herald_fold::cqfixture::{self, END_BELL, SEASON_ID};
use herald_fold::cqfmt::{
    CallFile, ConquestDay, ControlFile, EventKind, FinalFile, KeepHistory, Overview2File,
    PlayersFile, SiegeHistory, SiegesFile, StandingsLatest, StandingsSeries,
};
use herald_fold::files::Out;
use herald_fold::fold::{Fold, FoldCfg};
use herald_fold::runner::{Ingest, IngestCfg};
use tokio::sync::broadcast;

fn cfg() -> FoldCfg {
    FoldCfg {
        program: cqfixture::program(),
        season_id: SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    }
}

fn fold_all(dir: &std::path::Path, txs: &[fclient::ports::TxRecord]) -> Fold {
    let mut f = Fold::new(cfg(), Out::new(dir));
    for t in txs {
        f.apply(t);
    }
    f
}

fn read(dir: &std::path::Path, rel: &str) -> Vec<u8> {
    std::fs::read(dir.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

#[test]
fn cq_fold_writes_every_file_and_event() {
    let txs = cqfixture::mini_season();
    let d = tmp("cqall");
    let f = fold_all(&d, &txs);
    let a = f.cq.alarms;
    eprintln!("alarms {a:?} m1 {:?}", f.st.alarms);
    assert!(f.cq.on, "an MC season turns the conquest fold on");
    assert_eq!(
        a.conquest_mismatch, 0,
        "the model's digests match the herald's bytes"
    );
    assert_eq!(a.conquest_missing, 0);
    assert_eq!(a.replay_errors, 0);
    assert_eq!(a.bad_records, 0);
    assert_eq!(a.format_errors, 0);
    assert_eq!(f.st.alarms.rewrites, 0, "no immutable file rewritten");
    assert_eq!(f.st.alarms.bad_records, 0);
    // completeness: a control and sieges file for every bell
    assert_eq!(f.cq.ct_next, Some(END_BELL));
    for b in 0..END_BELL {
        let c = ControlFile::decode(&read(&d, &format!("h/control/{b}.bin")))
            .unwrap_or_else(|e| panic!("control {b}: {e}"));
        assert_eq!(c.bell, b);
        assert_eq!(c.season, SEASON_ID);
        SiegesFile::parse(&read(&d, &format!("h/sieges/{b}.json")))
            .unwrap_or_else(|e| panic!("sieges {b}: {e}"));
    }
    // every overview has its v2 sibling with the v1 record as its prefix
    let files = Out::new(&d).list().unwrap();
    let ov1: Vec<&String> = files
        .iter()
        .filter(|p| p.starts_with("h/overview/") && p.ends_with(".bin"))
        .collect();
    assert!(!ov1.is_empty());
    for p in &ov1 {
        let v1 = read(&d, p);
        let p2 = p.replace("h/overview/", "h/overview2/");
        let v2 = Overview2File::decode(&read(&d, &p2)).unwrap_or_else(|e| panic!("{p2}: {e}"));
        let n = (v1.len() - 32) / 24;
        assert_eq!(v2.records.len(), n);
        for (i, r) in v2.records.iter().enumerate() {
            assert_eq!(
                &r.v1[..],
                &v1[32 + 24 * i..32 + 24 * (i + 1)],
                "{p2} record {i}"
            );
        }
    }
    // days, calls, standings, final
    let mut kinds = std::collections::BTreeSet::new();
    for day in 0..END_BELL / 144 {
        let cd = ConquestDay::parse(&read(&d, &format!("h/conquest/{day}.json"))).unwrap();
        kinds.extend(cd.events.iter().map(|e| e.kind));
        CallFile::parse(&read(&d, &format!("h/call/{day}.json"))).unwrap();
    }
    for k in [
        EventKind::SiegeDeclared,
        EventKind::SiegeFailed,
        EventKind::Occupied,
        EventKind::Liberated,
        EventKind::CaptureDue,
        EventKind::Captured,
        EventKind::KeepContest,
        EventKind::KeepBroken,
        EventKind::KeepTaken,
        EventKind::ProvinceControl,
        EventKind::MarchBanner,
        EventKind::MarchPointsLead,
        EventKind::FreeCity,
        EventKind::Outpost,
        EventKind::Retired,
    ] {
        assert!(
            kinds.contains(&k),
            "event kind {} missing; got {kinds:?}",
            k.as_str()
        );
    }
    // the control layer shows contests, captures and breaks; the sieges
    // files show a vigil pause
    let (mut contest, mut taken, mut broken, mut vigil, mut banner) = (0, 0, 0, 0, 0);
    for b in 0..END_BELL {
        let c = ControlFile::decode(&read(&d, &format!("h/control/{b}.bin"))).unwrap();
        contest += c.provinces.iter().filter(|p| p.contender != 7).count();
        taken += c.provinces.iter().filter(|p| p.flags & 16 != 0).count();
        broken += c.provinces.iter().filter(|p| p.flags & 32 != 0).count();
        banner += c.marches.iter().filter(|m| m.flags & 1 != 0).count();
        let sf = SiegesFile::parse(&read(&d, &format!("h/sieges/{b}.json"))).unwrap();
        vigil += sf
            .sieges
            .iter()
            .filter(|s| s.pause == Some(herald_fold::cqfmt::PauseReason::Vigil))
            .count();
    }
    assert!(
        contest > 0 && taken >= 3 && broken >= 1 && banner >= 1 && vigil > 0,
        "contest {contest} taken {taken} broken {broken} banner {banner} vigil {vigil}"
    );
    let s = StandingsSeries::decode(&read(&d, "h/standings/series.bin")).unwrap();
    assert_eq!(s.first_hour, 0);
    assert_eq!(s.hours.len() as u32, END_BELL / 6, "an hour row per hour");
    StandingsLatest::parse(&read(&d, "h/standings/latest.json")).unwrap();
    PlayersFile::parse(&read(&d, "h/standings/players.json")).unwrap();
    let fin = FinalFile::parse(&read(&d, "h/season/final.json")).unwrap();
    eprintln!("final movement {:?}", fin.movement);
    assert_eq!(fin.end_bell, END_BELL);
    assert!(
        fin.movement.lasting_changes >= 3,
        "the keeps taken are lasting changes"
    );
    assert_eq!(fin.movement.first_holdings_transferred, 0, "D9");
    let hc = fin.movement.holding_contest;
    assert!(hc.sieges_declared >= 4 && hc.occupations >= 1 && hc.liberations >= 1);
    assert!(hc.captures >= 2 && hc.outposts >= 1 && hc.sieges_failed >= 1);
    // siege and keep histories
    let sieges: Vec<&String> = files
        .iter()
        .filter(|p| p.starts_with("h/siege/") && p.ends_with(".json"))
        .collect();
    assert!(sieges.len() >= 4);
    let mut credited = vec![];
    for p in sieges {
        let h = SiegeHistory::parse(&read(&d, p)).unwrap_or_else(|e| panic!("{p}: {e}"));
        assert!(h.end.is_some(), "{p} ended");
        if let Some(c) = h.end.and_then(|e| e.credited) {
            credited.push(c);
        }
    }
    credited.sort();
    assert_eq!(
        credited,
        vec![false, true],
        "a credited capture and an uncredited recapture"
    );
    let keeps: Vec<&String> = files
        .iter()
        .filter(|p| p.starts_with("h/keep/") && p.ends_with(".json"))
        .collect();
    assert!(!keeps.is_empty());
    let mut taken = 0;
    for p in keeps {
        let k = KeepHistory::parse(&read(&d, p)).unwrap_or_else(|e| panic!("{p}: {e}"));
        taken += k.captures.len();
    }
    assert!(taken >= 3);
}

#[test]
fn cq_fold_is_deterministic() {
    let txs = cqfixture::mini_season();
    let (d1, d2) = (tmp("cqdet1"), tmp("cqdet2"));
    let f1 = fold_all(&d1, &txs);
    fold_all(&d2, &txs);
    assert_eq!(tree(&d1), tree(&d2), "one archive, one set of bytes");
    // the conquest state survives its checkpoint form
    let j = f1.cq.to_json();
    let back = herald_fold::conquest::Cq::from_json(&j).expect("decodes");
    assert_eq!(back.to_json(), j);
    let _ = std::fs::remove_dir_all(&d1);
    let _ = std::fs::remove_dir_all(&d2);
}

/// Batches through findex with a crash (no checkpoint) and restarts from
/// checkpoints taken mid-season give the one-pass files; `/h/events`
/// numbers MC records as the fold does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cq_fold_restarts_from_checkpoints() {
    let txs = cqfixture::mini_season();
    let reference = tmp("cqref");
    fold_all(&reference.join("files"), &txs);
    let data = tmp("cqingest");
    let (diffs, _) = broadcast::channel(65_536);
    let mut c = IngestCfg::new(&data, cqfixture::program(), SEASON_ID);
    c.segment_bytes = 256 * 1024;
    c.checkpoint_slots = u64::MAX / 2;
    c.archive_commit = std::time::Duration::ZERO;
    let n = txs.len();
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        let mut src = VecSource::new(txs[..n / 3].to_vec(), 37);
        ing.findex.resume(&mut src);
        while ing.step(&mut src).await.unwrap() > 0 {}
        ing.checkpoint().unwrap();
    }
    {
        let mut ing = Ingest::open(c.clone(), diffs.clone()).unwrap();
        assert!(
            ing.fold.read().unwrap().cq.on,
            "the conquest state is restored"
        );
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
        assert_eq!(
            ing.findex.index.last_event().unwrap(),
            f.st.events,
            "/h/events numbering = the fold's"
        );
        assert!(f.cq.final_done);
    }
    assert_eq!(tree(&data.join("files")), tree(&reference.join("files")));
    let _ = std::fs::remove_dir_all(&data);
    let _ = std::fs::remove_dir_all(&reference);
}

/// The first CONQUEST record whose payload is rewritten by `edit`.
fn tamper_conquest(txs: &mut [fclient::ports::TxRecord], edit: impl Fn(&mut [u8])) -> bool {
    for t in txs.iter_mut() {
        for l in t.logs.iter_mut() {
            let Ok(Some(mut body)) = body_of_line(l) else {
                continue;
            };
            let Ok(r) = v2log::decode(&body) else {
                continue;
            };
            if r.kind != AnyKind::Cq(CqKind::CONQUEST) || r.payload[0] == 0 {
                continue;
            }
            let len = r.payload.len();
            let off = 2 + 4 + 12;
            edit(&mut body[off..off + len]);
            *l = log_line(&body);
            return true;
        }
    }
    false
}

#[test]
fn cq_tampered_conquest_digest_raises_the_alarm() {
    let mut txs = cqfixture::mini_season();
    // the records digest sits after n (1) and 14 events (56)
    assert!(tamper_conquest(&mut txs, |p| p[1 + 56] ^= 1));
    let d = tmp("cqtamper");
    let f = fold_all(&d, &txs);
    assert_eq!(f.cq.alarms.conquest_mismatch, 1, "{:?}", f.cq.alarms);
    let st = herald_fold::conquest::status_json(&f);
    assert_eq!(st["alarms"]["conquestMismatch"], 1);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn cq_tampered_keep_fields_raise_the_alarm() {
    let mut txs = cqfixture::mini_season();
    // keep_troops (after n, events, digest, holder, contender, progress)
    assert!(tamper_conquest(&mut txs, |p| p[1 + 56 + 32 + 3] ^= 1));
    let d = tmp("cqtamper2");
    let f = fold_all(&d, &txs);
    assert_eq!(f.cq.alarms.conquest_mismatch, 1, "{:?}", f.cq.alarms);
    let _ = std::fs::remove_dir_all(&d);
}

/// A SkipQuiet run whose post-state's conquest block differs from the
/// model's replay is an alarm (the replay is the herald's own check).
#[test]
fn cq_skip_replay_checks_the_post_state() {
    use frontier_abi::v2::layout::province::province as P;
    let mut txs = cqfixture::mini_season();
    let mut hit = false;
    let mut last: std::collections::BTreeMap<Vec<u8>, u32> = Default::default();
    'outer: for t in txs.iter_mut() {
        for (k, a) in t.post.iter_mut() {
            let Some(a) = a.as_mut() else {
                continue;
            };
            if a.data.len() != P::SIZE {
                continue;
            }
            let rn = u32::from_le_bytes(
                a.data[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4]
                    .try_into()
                    .unwrap(),
            );
            let prev = last.insert(k.to_bytes().to_vec(), rn);
            if prev.is_some_and(|p| rn >= p + 2) {
                // a snapshot weight of the run's last state
                a.data[P::SNAP + 4] ^= 1;
                hit = true;
                break 'outer;
            }
        }
    }
    assert!(hit, "a multi-bell skip run exists");
    let d = tmp("cqskip");
    let f = fold_all(&d, &txs);
    assert!(f.cq.alarms.conquest_mismatch >= 1, "{:?}", f.cq.alarms);
    let _ = std::fs::remove_dir_all(&d);
}

/// R-22: an M1 season never turns the conquest fold on: no MC file, an
/// M1 checkpoint without the conquest section, `/h/me` without additions.
#[test]
fn cq_m1_season_is_untouched() {
    let txs = herald_fold::fixture::mini_season(12);
    let d = tmp("cqm1");
    let cfg = FoldCfg {
        program: herald_fold::fixture::program(),
        season_id: herald_fold::fixture::SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    };
    let mut f = Fold::new(cfg, Out::new(&d));
    for t in &txs {
        f.apply(t);
    }
    assert!(!f.cq.on);
    assert!(Out::new(&d).list().unwrap().iter().all(|p| {
        ![
            "h/control/",
            "h/overview2/",
            "h/sieges/",
            "h/conquest/",
            "h/standings/",
            "h/call/",
            "h/season/",
            "h/keep/",
            "h/siege/",
        ]
        .iter()
        .any(|x| p.starts_with(x))
    }));
    let me =
        herald_fold::views::me_json(&f, &herald_fold::fixture::wallet(), serde_json::Value::Null);
    assert!(me.get("alerts").is_none() && me.get("sieges").is_none());
    let p = herald_fold::fixture::program().to_bytes();
    assert_eq!(
        herald_fold::checkpoint::encode_full(&p, herald_fold::fixture::SEASON_ID, &f.st, None),
        herald_fold::checkpoint::encode(&p, herald_fold::fixture::SEASON_ID, &f.st)
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// `/h/me` of an MC wallet: its alerts (the horn on its holding, the
/// occupation) and no live siege at the end.
#[test]
fn cq_me_alerts() {
    let txs = cqfixture::mini_season();
    let d = tmp("cqme");
    let f = fold_all(&d, &txs);
    // wallet 0 owns the first holding besieged and defended; wallet 1 the
    // one occupied and liberated
    let m0 = herald_fold::views::me_json(&f, &cqfixture::wallet(0), serde_json::Value::Null);
    let kinds = |v: &serde_json::Value| -> Vec<String> {
        v["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["kind"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(kinds(&m0).contains(&"horn".to_string()), "{m0}");
    let m1 = herald_fold::views::me_json(&f, &cqfixture::wallet(1), serde_json::Value::Null);
    let k1 = kinds(&m1);
    assert!(
        k1.contains(&"horn".to_string())
            && k1.contains(&"occupied".to_string())
            && k1.contains(&"liberated".to_string()),
        "{k1:?}"
    );
    assert_eq!(m1["sieges"].as_array().unwrap().len(), 0);
    let _ = std::fs::remove_dir_all(&d);
}
