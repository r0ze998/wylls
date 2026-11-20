//! Where the season's transactions came from, and whether that source
//! shows them to be the **whole** history (⑲, 2026-11-06).
//!
//! Every check replays the transactions it is given and ends each chain at
//! the final on-chain state (K4). Given a history with a range missing, a
//! check can report a forgery that is only the missing range (a chain that
//! does not reach its head), or a PASS over a season it never saw in full.
//! So the input says where its transactions came from ([`History`]) and
//! [`apply`] keeps the verdict from resting on a history no source showed
//! to be complete:
//!
//! | source | basis | verdict |
//! |---|---|---|
//! | a fixture file without a `history` field | `as_given`: the file's claim (recorded runs, vouched for by the fixture tests) | unchanged |
//! | the local node's live `frontier_feed` | separate status and feed reads are not an atomic snapshot: `ledger_feed` with named [`Gap`]s, unproven (never PASS) until every read was scanned from a ledger that cannot rewind under its runId and the node is still at the read's point after the final states (`input::seal_point_in_time`, ⑲ 2026-11-08) | unchanged only then |
//! | per-program local-feed archives | numbers restored when consistent, but same-run rollback freshness remains unproven | never PASS |
//! | public RPC (findex `RpcPoll`, live or as a findex archive), in **any** coverage state, `cross_checked` included | `unproven` | never PASS: `UNVERIFIABLE` with [`HISTORY_UNPROVEN`], or FAIL only on a [self-contained](self_contained) FAIL |
//! | public RPC, coverage neither `gap` nor `not_fetched`, when (a) VG re-executed it from the Season's creation with no finding AND (b) every witness RPC agreed item by item (VS, `crate::witness`, no finding) — ⑰ Q-P1 = (a)+(b), 2026-11-19 | `witnessed` | judged as a whole history: PASS, or FAIL on any FAIL; `complete` stays `null` (the witnesses' independence is assumed: [`crate::witness::RESIDUAL`]) |
//! | public RPC, coverage neither `gap` nor `not_fetched`, when VG ran over the whole archive and has a FAIL finding (known-bad: an archived success the pinned program refuses, a log or final state the re-executions do not leave) AND (b) every witness RPC agreed item by item — ⑰ Q-P2 = FAIL, 2026-11-20 | `unproven` (lifted for FAIL only) | FAIL, `failBasis` names `vg_witnessed`; never a PASS (witness agreement alone never lifts to PASS) |
//! | an archive or fixture whose source is not recorded or not readable | `unproven` | the same |
//!
//! `cross_checked` records that the node and a witness agreed on the
//! signature list while it was pulled; it is not proof of completeness or
//! of finality (findex `COVERAGE_LIMIT`), so it does not lift the verdict
//! by itself. Only the whole cross-check of `witness.rs` (every finalized
//! transaction with its meta, its block, the account set and the finals)
//! together with VG's exact end state does ([`Lift`]). Every FAIL finding stays in the report
//! (what the checks saw), but only a [self-contained](self_contained) one,
//! decided inside transactions that were fetched whatever else is missing,
//! makes the verdict FAIL; any other (a chain that does not reach its head,
//! a replay that depends on earlier state) can be the missing range, and the
//! verdict is UNVERIFIABLE. The one exception (⑰ Q-P2 = FAIL, owner
//! 2026-11-20): when every witness agrees on the season item by item (VS,
//! no finding), a VG FAIL is a known-bad season (both sources serve the
//! history that VG shows the pinned program does not produce), and the
//! verdict is FAIL with `failBasis` `vg_witnessed`. That lifts `unproven`
//! for FAIL purposes only: the history is still not shown whole, and a
//! witness disagreement, an unreachable or partial witness, or a VG that
//! is only UNVERIFIABLE (an op it does not model) leaves the verdict as
//! before. The list is the check owners' (⑪ for V0, V27 and
//! ⑳'s V9 resident joins, 2026-11-06); the other checks are ④'s to add.
//!
//! `report.json` carries `history` ([`History::report`]) for readers of the
//! report (the residents' memory, ⑫ and ⑬): `complete` is `false` whenever
//! the basis is `unproven`, and is `null` (not claimed) otherwise.

use serde_json::{json, Value};

use crate::{Finding, Report, Severity, Verdict};

pub use crate::codes::HISTORY_UNPROVEN;

/// Whether a FAIL finding holds however much history is missing: decided
/// inside fetched transactions alone (⑪, 2026-11-06):
/// - V0: the instruction's tag and allocated band (not its length, below);
/// - V27: a JoinResident's address, bell, join close, faction range, the
///   Citizen and link post-states, two records in one transaction, a
///   record missing under complete logs;
/// - V9 on `RESIDENT_JOINED`: a second join of a resident ID in the Season
///   (both fetched; a first one outside the fetched range is not seen,
///   which the unproven history already says).
///
/// - V28 (⑳, 2026-11-07): a ResidentAct's inner instruction, proof-account
///   flags, Season, canonical addresses, its pass's JoinResident (fetched)
///   and the Citizen's post-state, all inside fetched transactions; **not**
///   `ResidentOldAuthority` and `ResidentOwnerRequired`, which rest on the
///   resident program's feed.
///
/// Everything else (V1's chains and heads, V5, V7 and the other replays
/// over earlier state) is not, until its owner says otherwise.
///
/// V0's `Undecodable` is left out (⑪, r9 §7): its length range depends on
/// the Season's version, read from the final Season account or the
/// ruleset; an archive without them can make a valid instruction look the
/// wrong length.
pub fn self_contained(f: &Finding) -> bool {
    f.fail()
        && match f.check {
            "V0" => f.code != crate::codes::UNDECODABLE,
            "V27" => true,
            "V28" => {
                f.code != crate::codes::RESIDENT_OLD_AUTHORITY
                    && f.code != crate::codes::RESIDENT_OWNER_REQUIRED
            }
            "V9" => f.entity == "RESIDENT_JOINED",
            _ => false,
        }
}

/// Where the transactions came from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Source {
    /// A fixture file without a `history` field.
    #[default]
    Fixture,
    /// The local node's ordered feed (`frontier_feed`), live or archived.
    LedgerFeed,
    /// Public RPC through findex `RpcPoll`, live or archived.
    Rpc,
    /// The source is not recorded or cannot be read.
    Unknown,
}

impl Source {
    pub fn name(&self) -> &'static str {
        match self {
            Source::Fixture => "fixture",
            Source::LedgerFeed => "ledger_feed",
            Source::Rpc => "rpc",
            Source::Unknown => "unknown",
        }
    }
    fn parse(s: &str) -> Source {
        match s {
            "fixture" => Source::Fixture,
            "ledger_feed" => Source::LedgerFeed,
            "rpc" => Source::Rpc,
            _ => Source::Unknown,
        }
    }
}

/// What a local ledger's history could not show, each named (⑲,
/// 2026-11-08). A `ledger_feed` history with any of these is `unproven`:
/// a tail that matches the node, or a ledger that kept its id and size, does
/// not alone make the read the ledger's whole history at one point.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Gap {
    /// An archive read without the node: a later rewind is not seen.
    ArchiveOnly,
    /// The archive's last records are not at their ledger numbers on the
    /// node (rewound, rebuilt, another ledger), or the node could not say.
    TailMismatch,
    /// That the ledger's records up to the read are the same ones the node
    /// holds was not shown: an archive (no node-side digest of the ledger's
    /// records exists), or a live read not scanned throughout, or one whose
    /// node could rewind under the same runId (not synced before serving).
    PrefixIdentityUnverified,
    /// That the history and the final states were read at one ledger point
    /// was not shown (the ledger moved between them, or nobody compared).
    PointInTimeUnverified,
}

impl Gap {
    pub fn name(self) -> &'static str {
        match self {
            Gap::ArchiveOnly => "archive_only",
            Gap::TailMismatch => "tail_mismatch",
            Gap::PrefixIdentityUnverified => "prefix_identity_unverified",
            Gap::PointInTimeUnverified => "point_in_time_unverified",
        }
    }
    fn parse(s: &str) -> Option<Gap> {
        Some(match s {
            "archive_only" => Gap::ArchiveOnly,
            "tail_mismatch" => Gap::TailMismatch,
            "prefix_identity_unverified" => Gap::PrefixIdentityUnverified,
            "point_in_time_unverified" => Gap::PointInTimeUnverified,
            _ => return None,
        })
    }
}

/// The ledger point a history was read through: its id, how many ledger
/// entries it covered (every one up to it was examined), and the ledger's
/// size then. [`crate::input::seal_point_in_time`] compares it with the node
/// once the final states are read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerMark {
    pub run_id: String,
    pub ledger_len: u64,
    pub ledger_bytes: Option<u64>,
}

/// The input's history: its source and, for RPC, findex's coverage report
/// (`RpcPoll::coverage` or `findex::ingest::coverage_from_cursor`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct History {
    pub source: Source,
    pub coverage: Option<Value>,
    /// What the source was (a URL, an archive directory), for the report.
    pub detail: String,
    /// What it could not show ([`Gap`]); kept sorted, each once.
    pub gaps: Vec<Gap>,
    /// The ledger point it was read through, when known.
    pub mark: Option<LedgerMark>,
}

impl History {
    pub fn ledger_feed(detail: impl Into<String>) -> History {
        History {
            source: Source::LedgerFeed,
            detail: detail.into(),
            ..History::default()
        }
    }

    pub fn rpc(coverage: Value, detail: impl Into<String>) -> History {
        History {
            source: Source::Rpc,
            coverage: Some(coverage),
            detail: detail.into(),
            ..History::default()
        }
    }

    pub fn unknown(detail: impl Into<String>) -> History {
        History {
            source: Source::Unknown,
            detail: detail.into(),
            ..History::default()
        }
    }

    /// Adds what it could not show (each once).
    pub fn with_gaps(mut self, gaps: &[Gap]) -> History {
        for g in gaps {
            self.add_gap(*g);
        }
        self
    }

    pub fn add_gap(&mut self, g: Gap) {
        if !self.gaps.contains(&g) {
            self.gaps.push(g);
            self.gaps.sort();
        }
    }

    pub fn remove_gap(&mut self, g: Gap) {
        self.gaps.retain(|x| *x != g);
    }

    pub fn with_mark(mut self, mark: Option<LedgerMark>) -> History {
        self.mark = mark;
        self
    }

    /// The history of a findex archive, from the cursor its manifest holds
    /// and whether it holds records.
    pub fn of_archive(cursor: &Value, has_records: bool, dir: &str) -> History {
        if let Some(c) = findex::ingest::coverage_from_cursor(cursor) {
            return History::rpc(c, format!("archive {dir}"));
        }
        // A local feed's archive is the ledger's only when every record kept
        // its ledger number: `input::read_archive` checks that
        // (`findex::ledger`); from the cursor alone it is not known.
        if has_records && cursor.get("feed_after").and_then(Value::as_u64).is_some() {
            return History::unknown(format!(
                "archive {dir} (local node feed): read it with input::read_archive to check its ledger numbers"
            ));
        }
        if !has_records {
            return History::rpc(
                json!({"state": "not_fetched", "range": null, "gap": null, "unverifiable": [],
                       "limit": findex::ingest::COVERAGE_LIMIT}),
                format!("archive {dir} (empty)"),
            );
        }
        History::unknown(format!(
            "archive {dir}: its cursor does not say where the records came from"
        ))
    }

    /// Whether the ⑰ Q-P1 rule lifts this history (see [`Lift`]): a public
    /// RPC history whose pull detected no gap and archived something.
    pub fn liftable(&self) -> bool {
        self.source == Source::Rpc && !matches!(self.state(), Some("gap") | Some("not_fetched"))
    }

    /// `as_given`, `ledger_feed` or `unproven` (see the module table).
    pub fn basis(&self) -> &'static str {
        match self.source {
            Source::Fixture => "as_given",
            // An archive of the node's feed not checked against the node
            // (`input::ARCHIVE_ONLY`): a rewind of the ledger after it was
            // written is not seen, so it is not shown whole (owner's rule
            // 2026-11-07: an archive the node could not confirm is never
            // whole; workstream 04 at integration, for 19's review).
            Source::LedgerFeed if self.detail.ends_with(crate::input::ARCHIVE_ONLY) => "unproven",
            // ⑲ 2026-11-08: anything it could not show (a tail match alone,
            // a live read not at the final states' point) keeps it unproven.
            Source::LedgerFeed if !self.gaps.is_empty() => "unproven",
            Source::LedgerFeed => "ledger_feed",
            Source::Rpc | Source::Unknown => "unproven",
        }
    }

    pub fn unproven(&self) -> bool {
        self.basis() == "unproven"
    }

    /// The coverage state (`gap`, `not_fetched`, `unverifiable`,
    /// `cross_checked`) for RPC, else `None`.
    pub fn state(&self) -> Option<&str> {
        self.coverage.as_ref()?.get("state")?.as_str()
    }

    /// `report.json`'s `history`.
    pub fn report(&self) -> Value {
        json!({
            "source": self.source.name(),
            "basis": self.basis(),
            "scope": if self.unproven() { "observed_transactions" } else { "dataset_only" },
            // Never `true`: no source this verifier reads proves it.
            "complete": if self.unproven() { json!(false) } else { Value::Null },
            "state": self.state(),
            "coverage": self.coverage,
            "detail": self.detail,
            // What a local ledger's history could not show, by name.
            "missing": self.gaps.iter().map(|g| g.name()).collect::<Vec<_>>(),
            "mark": self.mark_json(),
        })
    }

    fn mark_json(&self) -> Value {
        self.mark.as_ref().map_or(Value::Null, |m| {
            json!({"runId": m.run_id, "ledgerLen": m.ledger_len, "ledgerBytes": m.ledger_bytes})
        })
    }

    /// The fixture form (`Input::to_json`'s `history`); `None` for a
    /// fixture's own (absent) history.
    pub fn to_json(&self) -> Option<Value> {
        (self.source != Source::Fixture).then(|| {
            json!({"source": self.source.name(), "coverage": self.coverage, "detail": self.detail,
                   "gaps": self.gaps.iter().map(|g| g.name()).collect::<Vec<_>>(),
                   "mark": self.mark_json()})
        })
    }

    /// Reads `Input`'s `history` field; absent is a fixture's own history,
    /// present but unreadable is `unknown` (never `as_given`).
    pub fn from_json(v: Option<&Value>) -> History {
        let Some(v) = v else {
            return History::default();
        };
        let source = v
            .get("source")
            .and_then(|x| x.as_str())
            .map_or(Source::Unknown, Source::parse);
        let coverage = v.get("coverage").filter(|c| !c.is_null()).cloned();
        let detail = v
            .get("detail")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        match source {
            // A recorded `fixture` value is not the file's own claim: only
            // an absent field is.
            Source::Fixture => {
                History::unknown(format!("history.source \"fixture\" recorded: {detail}"))
            }
            Source::LedgerFeed if coverage.is_some() => History::unknown(format!(
                "ledger_feed history carries incompatible coverage: {detail}"
            )),
            Source::Rpc if coverage.is_none() => {
                History::unknown(format!("rpc history without its coverage: {detail}"))
            }
            source => {
                // Recorded gaps stay; a ledger_feed saved before gaps were
                // recorded is taken as having shown neither.
                let mut gaps: Vec<Gap> = match v.get("gaps").and_then(|g| g.as_array()) {
                    Some(a) => a
                        .iter()
                        .filter_map(|x| x.as_str())
                        .filter_map(Gap::parse)
                        .collect(),
                    None if source == Source::LedgerFeed => {
                        vec![Gap::PrefixIdentityUnverified, Gap::PointInTimeUnverified]
                    }
                    None => vec![],
                };
                gaps.sort();
                gaps.dedup();
                let unknown_gap = v
                    .get("gaps")
                    .and_then(|g| g.as_array())
                    .is_some_and(|a| a.iter().any(|x| x.as_str().and_then(Gap::parse).is_none()));
                if unknown_gap {
                    return History::unknown(format!(
                        "history with a gap this verifier does not know: {detail}"
                    ));
                }
                let mark = v.get("mark").filter(|m| !m.is_null()).and_then(|m| {
                    Some(LedgerMark {
                        run_id: m.get("runId")?.as_str()?.to_string(),
                        ledger_len: m.get("ledgerLen")?.as_u64()?,
                        ledger_bytes: m.get("ledgerBytes").and_then(|x| x.as_u64()),
                    })
                });
                History {
                    source,
                    coverage,
                    detail,
                    gaps,
                    mark,
                }
            }
        }
    }

    /// The finding an unproven history adds (`None` otherwise).
    pub fn finding(&self) -> Option<Finding> {
        if !self.unproven() {
            return None;
        }
        let reasons: Vec<String> = self
            .coverage
            .as_ref()
            .and_then(|c| c.get("unverifiable"))
            .and_then(|u| u.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|r| r.get("reason").and_then(|x| x.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let gap = self
            .coverage
            .as_ref()
            .and_then(|c| c.get("gap"))
            .and_then(|g| g.as_str());
        let mut detail = match self.state() {
            Some(s) => format!("{} history, coverage `{s}`", self.source.name()),
            None => format!("{} history", self.source.name()),
        };
        if let Some(g) = gap {
            detail.push_str(&format!("; gap: {g}"));
        }
        if !reasons.is_empty() {
            detail.push_str(&format!("; unchecked: {}", reasons.join("; ")));
        }
        if let Some(n) = self
            .coverage
            .as_ref()
            .and_then(|c| c.get("heldBack"))
            .and_then(|x| x.as_u64())
            .filter(|&n| n > 0)
        {
            detail.push_str(&format!("; {n} newer signatures listed but not fetched"));
        }
        if !self.gaps.is_empty() {
            detail.push_str(&format!(
                "; not shown: {}",
                self.gaps
                    .iter()
                    .map(|g| g.name())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if self.state() == Some("cross_checked") {
            detail.push_str("; cross_checked is agreement of two RPC answers, not proof of completeness or finality");
        }
        if !self.detail.is_empty() {
            detail.push_str(&format!(" ({})", self.detail));
        }
        detail.push_str(
            ". No source showed this to be the whole history: the verdict is never PASS, and is FAIL only on a FAIL decided inside fetched transactions or (⑰ Q-P2) on VG's FAIL over a history every witness agreed on; other FAIL findings may stem from a missing range",
        );
        Some(Finding {
            code: HISTORY_UNPROVEN.into(),
            severity: Severity::Unverifiable,
            check: "V0",
            entity: "history".into(),
            bell: 0,
            signature: String::new(),
            detail,
        })
    }
}

/// What may lift a public-RPC history from `unproven` (⑰, owner Q-P1 =
/// (a)+(b), 2026-11-19 22:32): both must hold.
#[derive(Clone, Debug, Default)]
pub struct Lift {
    /// (a) VG re-executed the whole archive from the Season's creation and
    /// had no finding: every program-owned final state reproduced exactly.
    pub vg_exact: bool,
    /// VG's FAIL findings when it ran over the whole archive (⑰ Q-P2: with
    /// (b), they make the verdict FAIL; never a PASS).
    pub vg_fails: usize,
    /// (b) VS's outcome (`None`: no witness was asked).
    pub witness: Option<crate::witness::Outcome>,
}

impl Lift {
    fn agrees(&self) -> bool {
        self.witness.as_ref().is_some_and(|w| w.agrees)
    }
    fn holds(&self) -> bool {
        self.vg_exact && self.agrees()
    }
    /// ⑰ Q-P2 (owner 2026-11-20, FAIL): the witnesses agree and VG found
    /// the season known-bad. Lifts `unproven` for FAIL only.
    fn fails(&self) -> bool {
        self.vg_fails > 0 && self.agrees()
    }
    /// Why it does not hold (report text).
    fn why_not(&self) -> Vec<String> {
        let mut v = vec![];
        if !self.vg_exact {
            v.push("(a) VG did not reproduce every program-owned final state from the Season's creation (not run, or it has findings)".to_string());
        }
        match &self.witness {
            None => v.push("(b) no witness RPC was read (`--witness URL`)".into()),
            Some(w) if !w.agrees => v.push(format!(
                "(b) the witness cross-check has {} finding(s) (VS)",
                w.findings
            )),
            Some(_) => {}
        }
        v
    }
}

/// [`apply_with`] without a lift.
pub fn apply(history: &History, r: Report) -> Report {
    apply_with(history, r, &Lift::default())
}

/// Records the history in the report and, when it is unproven, adds
/// [`HISTORY_UNPROVEN`] and sets the verdict: FAIL when a
/// [self-contained](self_contained) FAIL finding exists, else UNVERIFIABLE
/// (never PASS; every finding stays). `history.selfContainedFails` and
/// `history.otherFails` count what the verdict rests on.
///
/// A [liftable](History::liftable) history whose [`Lift`] holds is
/// `witnessed` instead: no [`HISTORY_UNPROVEN`], the verdict the findings
/// give (PASS, or FAIL on any FAIL). `history.witness` reports VS's outcome
/// whenever a witness was asked.
///
/// ⑰ Q-P2 (owner 2026-11-20 = FAIL): a liftable history whose witnesses
/// all agree while VG ran and FAILs stays `unproven` (never PASS) but is
/// FAIL. `history.failBasis` lists what the FAIL rests on:
/// `self_contained` (a FAIL decided inside fetched transactions) and/or
/// `vg_witnessed` (VG's FAIL over agreeing witnesses); empty when the
/// verdict is UNVERIFIABLE. `history.vgFails` counts VG's FAIL findings.
pub fn apply_with(history: &History, mut r: Report, lift: &Lift) -> Report {
    let mut h = history.report();
    if let Some(w) = &lift.witness {
        h["witness"] = w.json();
        h["witness"]["vgExact"] = json!(lift.vg_exact);
    }
    if history.unproven() && history.liftable() && lift.holds() {
        h["basis"] = json!("witnessed");
        h["scope"] = json!("dataset_only");
        h["complete"] = Value::Null;
        r.history = Some(h);
        return r;
    }
    if let Some(mut f) = history.finding() {
        if history.liftable() {
            f.detail.push_str(&format!(
                ". Not lifted (⑰ Q-P1 needs (a) and (b)): {}",
                lift.why_not().join("; ")
            ));
        }
        let own = r.findings.iter().filter(|x| self_contained(x)).count();
        let other = r.findings.iter().filter(|x| x.fail()).count() - own;
        // ⑰ Q-P2: VG's known-bad over a history every witness agreed on.
        let vg_witnessed = history.liftable() && lift.fails();
        let mut basis = vec![];
        if own > 0 {
            basis.push("self_contained");
        }
        if vg_witnessed {
            basis.push("vg_witnessed");
            f.detail.push_str(&format!(
                ". FAIL nonetheless (⑰ Q-P2): VG re-executed the archive from the Season's creation and has {} FAIL finding(s), over a history {} witness RPC(s) served identically item by item (VS); agreement lifts the history for FAIL only, never for PASS",
                lift.vg_fails,
                lift.witness.as_ref().map_or(0, |w| w.witnesses.len())
            ));
        }
        h["selfContainedFails"] = json!(own);
        h["otherFails"] = json!(other);
        h["vgFails"] = json!(lift.vg_fails);
        h["failBasis"] = json!(basis);
        r.findings.push(f);
        r.findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
        r.verdict = if !basis.is_empty() {
            Verdict::Fail
        } else {
            Verdict::Unverifiable
        };
    }
    r.history = Some(h);
    r
}
