//! V26 — map growth (S1 ExtendFrontier 0xC1, `proc/map.rs::extend_frontier`;
//! a local candidate beside the contract's §8.5 table), listed as
//! `V26:map-growth`.
//!
//! Every successful ExtendFrontier is re-judged from the Season and the
//! Frontier **before** its transaction with the program's own order of
//! checks (`fclient::land::frontier_extend_check`, pinned to
//! `extend_frontier`): a ceiling (`r_max_ceiling ≠ 0`), `d = effective
//! r_max + 1 ≤ ceiling` (the effective `r_max` is the larger of the
//! Season's and the Frontier's `r_max_ext`), effective status Running,
//! every ring up to the effective `r_max` opened (`rings_opened == d`), a
//! bell since the last ring opening, and some wedge at θ occupancy on the
//! folded values (θ early or late by the time since genesis). Then the
//! post-state: the Frontier after the transaction is the Frontier before
//! with `r_max_ext = d` and its chain advanced by one record, **nothing
//! else** (ExtendFrontier opens no ring and touches no counter). Then the
//! log: the transaction carries exactly one FRONTIER_EXTENDED (kind 104)
//! with key `d`, payload `(from = the effective r_max before, ceiling)`
//! and the transaction's bell (`NO_BELL` before genesis).
//!
//! **Attribution ([`guard`]).** The archive holds states per transaction,
//! not per instruction. The judgement above is exact only when the
//! transaction's Season before and Frontier before and after can be
//! attributed to one ExtendFrontier: exactly one ExtendFrontier, and no
//! other instruction of the program in the transaction that may write the
//! Frontier **or the Season** (`Ix::writes`: OpenRing, FoldOccupancy, a
//! second ExtendFrontier, a Season-writing lifecycle instruction, or any
//! position the tables cannot resolve that the message marks writable).
//! Instructions that only read them (FileTicket, SetVigil, …) do not
//! disturb it.
//! A transaction that bundles such instructions is **not** judged invalid
//! (the program allows the bundle): it is `MissingData`, since no
//! instruction-level state is archived to replay it. A FRONTIER_EXTENDED
//! in a transaction with no top-level ExtendFrontier is `MissingData` too
//! (an inner instruction the archive does not show; V0E reports it), not a
//! FAIL.
//!
//! Missing states (no post-states, no Season or Frontier before the
//! transaction, a Season or Frontier that does not decode, a transaction
//! whose logs the archive lost) are `MissingData`; everything else that
//! differs is `FrontierExtensionMismatch`. The folded values are taken as
//! the Frontier states them (FoldOccupancy's; the fold itself is not
//! replayed here), and the ring opening that follows is OpenRing's as
//! before (V3's ring seed, V11's terrain).

use fclient::decode::{Frontier, Season};
use fclient::land::frontier_extend_check;
use frontier_abi::layout::header;
use frontier_abi::layout::world::frontier as FR;
use frontier_abi::log::NO_BELL;
use frontier_abi::prologue::bell_at;
use frontier_abi::v2::ix::ExtendFrontier;
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::tags::Ix as V2Ix;

use super::v11_land::Judgement;
use super::Ctx;
use crate::codes::FRONTIER_EXTENSION_MISMATCH;
use crate::world::{le, Ix, Key};

const V: &str = "V26";

/// What a transaction's instructions let V26 do with it (module doc,
/// "Attribution").
#[derive(Debug)]
pub enum Guard<'a> {
    /// No ExtendFrontier and no FRONTIER_EXTENDED: nothing to judge.
    Skip,
    /// One ExtendFrontier whose Frontier before and after are the
    /// transaction's: judge it.
    Judge(&'a Ix),
    /// A verdict without judging: `Missing` for what cannot be attributed,
    /// `Fail` for an instruction that is not the season's.
    Verdict(Judgement),
}

/// The transaction guard: `ixs` the program's top-level instructions,
/// `n_records` its FRONTIER_EXTENDED records, `season` and `frontier` the
/// season's accounts.
pub fn guard<'a>(ixs: &'a [Ix], n_records: usize, season: &Key, frontier: &Key) -> Guard<'a> {
    use Judgement::{Fail, Missing};
    let tag = V2Ix::ExtendFrontier.tag();
    let mine: Vec<&Ix> = ixs.iter().filter(|i| i.tag() == Some(tag)).collect();
    let ix = match mine.as_slice() {
        [] if n_records == 0 => return Guard::Skip,
        [] => {
            return Guard::Verdict(Missing(
                "a FRONTIER_EXTENDED record with no top-level ExtendFrontier in its transaction: an inner instruction the archive does not show (V0E reports it)".into(),
            ))
        }
        [ix] => *ix,
        n => {
            return Guard::Verdict(Missing(format!(
                "{} ExtendFrontier in one transaction: the Frontier before and after the transaction cannot be attributed to one of them",
                n.len()
            )))
        }
    };
    // `[payer s,w] [season r] [frontier w]`.
    if ix.key(1) != Some(*season) || ix.key(2) != Some(*frontier) {
        return Guard::Verdict(Fail(
            "the ExtendFrontier names another Season or Frontier".into(),
        ));
    }
    // The judgement reads the Season before the transaction too (its
    // ceiling, θ, clock and status): a writer of either account in the
    // same transaction takes that evidence away.
    let bundled: Vec<usize> = ixs
        .iter()
        .filter(|i| i.index != ix.index && (i.writes(frontier) || i.writes(season)))
        .map(|i| i.index)
        .collect();
    if !bundled.is_empty() {
        return Guard::Verdict(Missing(format!(
            "instruction(s) {bundled:?} of the transaction may write the Season or the Frontier too: the states before and after the transaction cannot be attributed to the ExtendFrontier alone"
        )));
    }
    Guard::Judge(ix)
}

/// A FRONTIER_EXTENDED record as logged: its bell, key and payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtendRecord {
    pub bell: u32,
    pub key: Vec<u8>,
    pub payload: Vec<u8>,
}

/// The evidence an ExtendFrontier is judged from.
pub struct ExtendEvidence<'a> {
    /// The instruction's `d` (`None`: its data does not decode).
    pub d: Option<u16>,
    pub season_before: Option<&'a [u8]>,
    pub frontier_before: Option<&'a [u8]>,
    pub frontier_after: Option<&'a [u8]>,
    /// The transaction's block time (the program's clock).
    pub time: i64,
    /// The FRONTIER_EXTENDED records of the transaction.
    pub records: &'a [ExtendRecord],
    /// Whether the transaction carries any record at all (a transaction
    /// without one lost its logs: V0E says so).
    pub any_record: bool,
}

/// An ExtendFrontier re-judged as the program judges it (module doc). The
/// accounts the instruction names are the caller's to check.
pub fn judge_extension(e: &ExtendEvidence) -> Judgement {
    use Judgement::{Fail, Missing};
    let Some(d) = e.d else {
        return Fail("the ExtendFrontier data does not decode".into());
    };
    let Some(sd) = e.season_before else {
        return Missing("no Season state before the extension".into());
    };
    let Some(fd) = e.frontier_before else {
        return Missing("no Frontier state before the extension".into());
    };
    let Ok(s) = Season::decode(sd) else {
        return Missing("the Season before the extension does not decode".into());
    };
    let Ok(fr) = Frontier::decode(fd) else {
        return Missing("the Frontier before the extension does not decode".into());
    };
    let want = match frontier_extend_check(&s, &fr, e.time) {
        Ok(x) => x,
        Err(why) => {
            return Fail(format!(
                "the program's rule refuses an extension at this time: {why:?}"
            ))
        }
    };
    if want != d {
        return Fail(format!(
            "ExtendFrontier({d}) landed where the rule allows only {want}"
        ));
    }
    let from = s.r_max.max(fr.r_max_ext);
    let ceiling = s.conquest.map_or(0, |c| c.r_max_ceiling);
    let Some(ad) = e.frontier_after else {
        return Missing("no Frontier post-state".into());
    };
    let Ok(af) = Frontier::decode(ad) else {
        return Fail("the Frontier after the extension does not decode".into());
    };
    if af.r_max_ext != d {
        return Fail(format!(
            "the Frontier after it has r_max_ext {}, not {d}",
            af.r_max_ext
        ));
    }
    if ad.len() != fd.len() {
        return Fail("the Frontier changed size".into());
    }
    let may_move = |i: usize| {
        (FR::R_MAX_EXT..FR::R_MAX_EXT + 2).contains(&i)
            || (header::EVENT_SEQ..header::EVENT_HEAD + 32).contains(&i)
    };
    if let Some(i) = (0..fd.len()).find(|&i| !may_move(i) && fd[i] != ad[i]) {
        return Fail(format!(
            "the Frontier changed at byte {i}: only r_max_ext and the chain may move"
        ));
    }
    let seq = |d: &[u8]| le(&d[header::EVENT_SEQ..header::EVENT_SEQ + 8]);
    if seq(ad) != seq(fd).wrapping_add(1) {
        return Fail("the Frontier's chain did not advance by one record".into());
    }
    match e.records.len() {
        0 if !e.any_record => {
            return Missing(
                "the transaction carries no record: its logs are not in the archive".into(),
            )
        }
        0 => return Fail("no FRONTIER_EXTENDED record in the transaction".into()),
        1 => {}
        n => return Fail(format!("{n} FRONTIER_EXTENDED records, one expected")),
    }
    let r = &e.records[0];
    let bell = bell_at(s.genesis_ts, e.time).unwrap_or(NO_BELL);
    let mut want_payload = from.to_le_bytes().to_vec();
    want_payload.extend_from_slice(&ceiling.to_le_bytes());
    if r.key[..] != d.to_le_bytes()[..] || r.payload != want_payload || r.bell != bell {
        return Fail(format!(
            "FRONTIER_EXTENDED (d {}, from {}, ceiling {}, bell {}) but the extension is (d {d}, from {from}, ceiling {ceiling}, bell {bell})",
            le(&r.key),
            le(r.payload.get(..2).unwrap_or(&[])),
            le(r.payload.get(2..4).unwrap_or(&[])),
            r.bell
        ));
    }
    Judgement::Pass
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let frontier = f.ctx.frontier();
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        let records: Vec<ExtendRecord> = w
            .cq_recs
            .iter()
            .filter(|c| c.tx == t && c.kind == CqKind::FRONTIER_EXTENDED)
            .map(|c| ExtendRecord {
                bell: c.bell,
                key: c.key.clone(),
                payload: c.payload.clone(),
            })
            .collect();
        let ix = match guard(&tx.ixs, records.len(), &f.ctx.season, &frontier) {
            Guard::Skip => continue,
            Guard::Judge(ix) => Ok(ix),
            Guard::Verdict(v) => Err(v),
        };
        let bell = records
            .first()
            .map(|r| r.bell)
            .unwrap_or_else(|| bell_at(f.genesis_ts, tx.time).unwrap_or(0));
        let what = format!("frontier extension tx#{t}");
        let judged = match ix {
            Err(v) => v,
            Ok(_) if !w.has_post => Judgement::Missing(
                "no post-states: the Season and the Frontier around the extension are unknown"
                    .into(),
            ),
            Ok(ix) => judge_extension(&ExtendEvidence {
                d: ExtendFrontier::decode(&ix.data).ok().map(|x| x.d),
                season_before: w.state_before(&f.ctx.season, t),
                frontier_before: w.state_before(&frontier, t),
                frontier_after: tx.post_data(&frontier),
                time: tx.time,
                records: &records,
                any_record: !tx.recs.is_empty() || w.cq_recs.iter().any(|c| c.tx == t),
            }),
        };
        match judged {
            Judgement::Pass => {}
            Judgement::Fail(why) => {
                cx.fail(V, FRONTIER_EXTENSION_MISMATCH, what, bell, Some(t), why)
            }
            Judgement::Missing(why) => cx.missing(V, what, bell, Some(t), why),
        }
    }
}

#[cfg(test)]
mod tests {
    //! Literal account bytes only: no key is generated, derived or signed,
    //! and no chain is run.
    use super::*;
    use frontier_abi::layout::world::season as S;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    use frontier_abi::v2::presets::{FRONTIER_7, PROGRAM_VERSION_S1, SEASON_CQ_OFFSET};

    const G: i64 = 1_000_000;
    const NOW: i64 = G + 10 * 600;

    fn put(d: &mut [u8], o: usize, v: &[u8]) {
        d[o..o + v.len()].copy_from_slice(v);
    }

    /// A Running S1 Season of `r_max` with the growth ceiling `ceiling`
    /// (θ 55% early, 65% after three days).
    fn season(r_max: u16, ceiling: u16) -> Vec<u8> {
        let mut d = vec![0u8; K2::Season.size()];
        assert!(write_header(&mut d, K2::Season, 7));
        d[S::STATUS] = S::STATUS_RUNNING;
        put(&mut d, S::R_MAX, &r_max.to_le_bytes());
        put(
            &mut d,
            S::PROGRAM_VERSION,
            &PROGRAM_VERSION_S1.to_le_bytes(),
        );
        put(&mut d, S::GENESIS_TS, &G.to_le_bytes());
        put(&mut d, S::END_BELL, &200_000u32.to_le_bytes());
        put(&mut d, S::THETA_EARLY_BPS, &5_500u16.to_le_bytes());
        put(&mut d, S::THETA_LATE_BPS, &6_500u16.to_le_bytes());
        put(&mut d, S::THETA_SWITCH_SECS, &259_200u32.to_le_bytes());
        let mut cq = FRONTIER_7;
        cq.r_max_ceiling = ceiling;
        put(&mut d, SEASON_CQ_OFFSET, &cq.to_bytes());
        d
    }

    /// A folded Frontier: every wedge 100 open sites, wedge 2 `occ2`
    /// occupied, `rings_opened` rings, the last opened at `last_bell`.
    fn frontier(rings_opened: u16, r_max_ext: u16, last_bell: u32, occ2: u32, seq: u64) -> Vec<u8> {
        let mut d = vec![0u8; K2::Frontier.size()];
        assert!(write_header(&mut d, K2::Frontier, 7));
        put(&mut d, FR::RINGS_OPENED, &rings_opened.to_le_bytes());
        put(&mut d, FR::R_MAX_EXT, &r_max_ext.to_le_bytes());
        put(&mut d, FR::LAST_RING_OPEN_BELL, &last_bell.to_le_bytes());
        put(&mut d, FR::OPEN_SITES, &600u32.to_le_bytes());
        for w in 0..6 {
            put(&mut d, FR::WEDGE_OPEN + 4 * w, &100u32.to_le_bytes());
        }
        put(&mut d, FR::WEDGE_OCCUPIED + 8, &occ2.to_le_bytes());
        put(&mut d, header::EVENT_SEQ, &seq.to_le_bytes());
        d
    }

    /// The Frontier `before` as ExtendFrontier(d) leaves it.
    fn after(before: &[u8], d: u16) -> Vec<u8> {
        let mut a = before.to_vec();
        put(&mut a, FR::R_MAX_EXT, &d.to_le_bytes());
        let seq = le(&before[header::EVENT_SEQ..header::EVENT_SEQ + 8]) + 1;
        put(&mut a, header::EVENT_SEQ, &seq.to_le_bytes());
        put(&mut a, header::EVENT_HEAD, &[9u8; 32]);
        a
    }

    fn rec(bell: u32, d: u16, from: u16, ceiling: u16) -> ExtendRecord {
        let mut payload = from.to_le_bytes().to_vec();
        payload.extend_from_slice(&ceiling.to_le_bytes());
        ExtendRecord {
            bell,
            key: d.to_le_bytes().to_vec(),
            payload,
        }
    }

    #[derive(Clone)]
    struct Case {
        d: Option<u16>,
        season: Option<Vec<u8>>,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
        time: i64,
        records: Vec<ExtendRecord>,
        any_record: bool,
    }

    impl Case {
        fn judge(&self) -> Judgement {
            judge_extension(&ExtendEvidence {
                d: self.d,
                season_before: self.season.as_deref(),
                frontier_before: self.before.as_deref(),
                frontier_after: self.after.as_deref(),
                time: self.time,
                records: &self.records,
                any_record: self.any_record,
            })
        }
        fn fails(&self) -> bool {
            matches!(self.judge(), Judgement::Fail(_))
        }
        fn missing(&self) -> bool {
            matches!(self.judge(), Judgement::Missing(_))
        }
        /// The same case over another Frontier before (the after follows).
        fn over(mut self, before: Vec<u8>, d: u16) -> Case {
            self.after = Some(after(&before, d));
            self.before = Some(before);
            self.d = Some(d);
            self
        }
    }

    /// `r_max` 4 under a ceiling of 6, rings 0–4 opened (the last at bell
    /// 3), wedge 2 at 60% at bell 10: ExtendFrontier(5) lands, logged
    /// `(d 5, from 4, ceiling 6)`.
    fn valid() -> Case {
        let before = frontier(5, 0, 3, 60, 7);
        Case {
            d: Some(5),
            season: Some(season(4, 6)),
            after: Some(after(&before, 5)),
            before: Some(before),
            time: NOW,
            records: vec![rec(10, 5, 4, 6)],
            any_record: true,
        }
    }

    #[test]
    fn a_valid_extension_passes_and_the_next_ones_stop_at_the_ceiling() {
        assert_eq!(valid().judge(), Judgement::Pass);
        // Extended to 5 and ring 5 opened: 6 (= the ceiling) is next.
        let mut second = valid().over(frontier(6, 5, 3, 60, 8), 6);
        second.records = vec![rec(10, 6, 5, 6)];
        assert_eq!(second.judge(), Judgement::Pass);
        // At the ceiling nothing extends.
        let mut third = valid().over(frontier(7, 6, 3, 60, 9), 7);
        third.records = vec![rec(10, 7, 6, 6)];
        assert!(third.fails());
        // Late θ (65%) after three days: 60% is not crowded any more.
        let mut late = valid();
        late.time = G + 259_200;
        late.records = vec![rec(432, 5, 4, 6)];
        assert!(late.fails());
        let mut late = valid().over(frontier(5, 0, 3, 65, 7), 5);
        late.time = G + 259_200;
        late.records = vec![rec(432, 5, 4, 6)];
        assert_eq!(late.judge(), Judgement::Pass);
    }

    /// Every precondition the program checks, broken one at a time.
    #[test]
    fn an_extension_the_program_would_refuse_fails() {
        let mut c = valid();
        c.d = Some(6);
        assert!(c.fails(), "not r_max + 1");
        let mut c = valid();
        c.d = Some(4);
        assert!(c.fails(), "within r_max (AlreadyDone)");
        let mut c = valid();
        c.season = Some(season(4, 0));
        assert!(c.fails(), "no ceiling");
        let mut c = valid();
        c.season = Some(season(4, 5));
        c.d = Some(6);
        assert!(c.fails(), "beyond the ceiling");
        assert!(
            valid().over(frontier(4, 0, 3, 60, 7), 5).fails(),
            "ring 4 not opened"
        );
        assert!(
            valid().over(frontier(5, 0, 10, 60, 7), 5).fails(),
            "a ring opened this bell"
        );
        assert!(
            valid().over(frontier(5, 0, 3, 54, 7), 5).fails(),
            "no wedge crowded"
        );
        let mut c = valid();
        c.time = G - 1;
        assert!(c.fails(), "before genesis (not Running)");
        let mut c = valid();
        c.d = None;
        assert!(c.fails(), "undecodable data");
    }

    /// The Frontier after and the record, each other than the program's.
    #[test]
    fn a_post_state_or_record_other_than_the_programs_fails() {
        let v = valid();
        let before = v.before.clone().unwrap();
        let mut c = v.clone();
        c.after = Some(after(&before, 6));
        assert!(c.fails(), "r_max_ext raised to 6");
        let mut c = v.clone();
        let mut a = after(&before, 5);
        put(&mut a, FR::OPEN_SITES, &601u32.to_le_bytes());
        c.after = Some(a);
        assert!(c.fails(), "a counter changed");
        let mut c = v.clone();
        let mut a = after(&before, 5);
        put(&mut a, FR::RINGS_OPENED, &6u16.to_le_bytes());
        c.after = Some(a);
        assert!(c.fails(), "a ring opened by the extension");
        let mut c = v.clone();
        let mut a = after(&before, 5);
        put(&mut a, header::EVENT_SEQ, &7u64.to_le_bytes());
        c.after = Some(a);
        assert!(c.fails(), "the chain did not advance");
        let mut c = v.clone();
        c.after = Some(after(&before, 5)[..100].to_vec());
        assert!(c.fails(), "the Frontier after does not decode");
        for (bad, what) in [
            (rec(10, 5, 5, 6), "from"),
            (rec(10, 5, 4, 7), "ceiling"),
            (rec(10, 6, 4, 6), "d"),
            (rec(11, 5, 4, 6), "bell"),
        ] {
            let mut c = v.clone();
            c.records = vec![bad];
            assert!(c.fails(), "{what}");
        }
        let mut c = v.clone();
        c.records = vec![rec(10, 5, 4, 6), rec(10, 5, 4, 6)];
        assert!(c.fails(), "two records");
        let mut c = v.clone();
        c.records = vec![];
        assert!(c.fails(), "no record while the transaction logged others");
    }

    // --- the transaction guard (literal keys and instruction bytes)

    const SEASON: Key = [0x22; 32];
    const FRONTIER: Key = [0x33; 32];
    const PAYER: Key = [0x44; 32];
    const CITIZEN: Key = [0x55; 32];

    fn extend_ix(index: usize, d: u16, season: Key, frontier: Key) -> Ix {
        Ix {
            index,
            data: ExtendFrontier { d }.to_bytes().to_vec(),
            accounts: vec![(PAYER, true), (season, false), (frontier, true)],
        }
    }

    /// OpenRing(5): `[payer] [season] [frontier w] [ringseed w] [pfund × 6] [system]`.
    fn open_ring_ix(index: usize) -> Ix {
        let mut accounts = vec![
            (PAYER, true),
            (SEASON, false),
            (FRONTIER, true),
            ([0x66; 32], true),
        ];
        accounts.extend((0..6u8).map(|w| ([0x70 + w; 32], false)));
        accounts.push(([0; 32], false));
        Ix {
            index,
            data: frontier_abi::ix::OpenRing { d: 5 }.to_bytes().to_vec(),
            accounts,
        }
    }

    /// FileTicket of one site: the Frontier read-only.
    fn file_ticket_ix(index: usize) -> Ix {
        Ix {
            index,
            data: vec![frontier_abi::tags::Ix::FileTicket.tag(), 1, 2, 0, 0, 0, 0],
            accounts: vec![
                ([0x77; 32], true),
                (PAYER, true),
                (SEASON, false),
                (CITIZEN, true),
                (FRONTIER, false),
                ([0x78; 32], true),
                ([0; 32], false),
            ],
        }
    }

    /// SetVigil: no Frontier at all.
    fn vigil_ix(index: usize) -> Ix {
        Ix {
            index,
            data: vec![frontier_abi::tags::Ix::SetVigil.tag(), 0x58, 0x02],
            accounts: vec![
                ([0x77; 32], true),
                (PAYER, true),
                (SEASON, false),
                (CITIZEN, true),
            ],
        }
    }

    /// An instruction the tables cannot resolve (CloseMarch with one
    /// account) that the message marks the Frontier writable for.
    fn opaque_frontier_writer(index: usize) -> Ix {
        Ix {
            index,
            data: vec![V2Ix::CloseMarch.tag()],
            accounts: vec![(FRONTIER, true)],
        }
    }

    /// The same with the Season writable and the Frontier untouched.
    fn opaque_season_writer(index: usize) -> Ix {
        Ix {
            index,
            data: vec![V2Ix::CloseMarch.tag()],
            accounts: vec![(SEASON, true)],
        }
    }

    /// An instruction that lists the Season and the Frontier read-only
    /// (the tables cannot resolve it either: read-only by the message).
    fn opaque_reader(index: usize) -> Ix {
        Ix {
            index,
            data: vec![V2Ix::CloseMarch.tag()],
            accounts: vec![(SEASON, false), (FRONTIER, false)],
        }
    }

    fn missing(g: &Guard) -> bool {
        matches!(g, Guard::Verdict(Judgement::Missing(_)))
    }
    fn judges(g: &Guard, index: usize) -> bool {
        matches!(g, Guard::Judge(ix) if ix.index == index)
    }

    /// The guard judges an ExtendFrontier only when the transaction's
    /// Frontier states are its alone; a bundle with another Frontier writer,
    /// a second ExtendFrontier, or a record without a top-level instruction
    /// is `MissingData`, never a FAIL; an instruction naming another Season
    /// or Frontier is a FAIL.
    #[test]
    fn the_guard_judges_only_an_isolated_extension_and_never_calls_a_bundle_invalid() {
        let ext = |i| extend_ix(i, 5, SEASON, FRONTIER);
        assert!(matches!(guard(&[], 0, &SEASON, &FRONTIER), Guard::Skip));
        assert!(matches!(
            guard(&[vigil_ix(0)], 0, &SEASON, &FRONTIER),
            Guard::Skip
        ));
        // a record without a top-level ExtendFrontier: an inner instruction, unverifiable
        assert!(missing(&guard(&[], 1, &SEASON, &FRONTIER)));
        assert!(missing(&guard(&[vigil_ix(0)], 1, &SEASON, &FRONTIER)));
        // alone, or beside instructions that only read the Season and the Frontier
        assert!(judges(&guard(&[ext(0)], 1, &SEASON, &FRONTIER), 0));
        assert!(judges(
            &guard(&[file_ticket_ix(0), ext(1)], 1, &SEASON, &FRONTIER),
            1
        ));
        assert!(judges(
            &guard(&[ext(0), vigil_ix(1)], 1, &SEASON, &FRONTIER),
            0
        ));
        assert!(judges(
            &guard(&[opaque_reader(0), ext(1)], 1, &SEASON, &FRONTIER),
            1
        ));
        // bundled with a Frontier or a Season writer, in either order:
        // unverifiable, not invalid (the judgement reads the Season before too)
        for ixs in [
            vec![ext(0), open_ring_ix(1)],
            vec![open_ring_ix(0), ext(1)],
            vec![ext(0), opaque_frontier_writer(1)],
            vec![ext(0), opaque_season_writer(1)],
            vec![opaque_season_writer(0), ext(1)],
            vec![ext(0), ext(1)],
            vec![ext(0), vigil_ix(1), ext(2)],
        ] {
            let g = guard(&ixs, 1, &SEASON, &FRONTIER);
            assert!(missing(&g), "{ixs:?}: {g:?}");
        }
        // another Season or Frontier named: not this season's
        for ix in [
            extend_ix(0, 5, [0x99; 32], FRONTIER),
            extend_ix(0, 5, SEASON, [0x99; 32]),
        ] {
            assert!(matches!(
                guard(&[ix], 1, &SEASON, &FRONTIER),
                Guard::Verdict(Judgement::Fail(_))
            ));
        }
    }

    /// Evidence the archive does not hold: never a PASS, never a FAIL.
    #[test]
    fn incomplete_evidence_is_unverifiable_never_a_pass() {
        let v = valid();
        let mut c = v.clone();
        c.season = None;
        assert!(c.missing());
        let mut c = v.clone();
        c.before = None;
        assert!(c.missing());
        let mut c = v.clone();
        c.after = None;
        assert!(c.missing());
        let mut c = v.clone();
        c.season = Some(vec![0u8; K2::Season.size()]);
        assert!(c.missing(), "the Season before does not decode");
        let mut c = v.clone();
        c.before = Some(vec![0u8; 40]);
        assert!(c.missing(), "the Frontier before does not decode");
        let mut c = v.clone();
        c.records = vec![];
        c.any_record = false;
        assert!(c.missing(), "no logs at all");
    }
}
