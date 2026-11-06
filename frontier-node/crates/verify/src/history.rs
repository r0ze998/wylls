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
//! | the local node's `frontier_feed` (live or as a findex archive) | `ledger_feed`: the node's own ledger, in order | unchanged |
//! | public RPC (findex `RpcPoll`, live or as a findex archive), in **any** coverage state, `cross_checked` included | `unproven` | never PASS: `UNVERIFIABLE` with [`HISTORY_UNPROVEN`], or FAIL only on a [self-contained](self_contained) FAIL |
//! | an archive or fixture whose source is not recorded or not readable | `unproven` | the same |
//!
//! `cross_checked` records that the node and a witness agreed; it is not
//! proof of completeness or of finality (findex `COVERAGE_LIMIT`), so it
//! does not lift the verdict either. Every FAIL finding stays in the report
//! (what the checks saw), but only a [self-contained](self_contained) one,
//! decided inside transactions that were fetched whatever else is missing,
//! makes the verdict FAIL; any other (a chain that does not reach its head,
//! a replay that depends on earlier state) can be the missing range, and the
//! verdict is UNVERIFIABLE. The list is the check owners' (⑪ for V0, V27 and
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

/// The input's history: its source and, for RPC, findex's coverage report
/// (`RpcPoll::coverage` or `findex::ingest::coverage_from_cursor`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct History {
    pub source: Source,
    pub coverage: Option<Value>,
    /// What the source was (a URL, an archive directory), for the report.
    pub detail: String,
}

impl History {
    pub fn ledger_feed(detail: impl Into<String>) -> History {
        History {
            source: Source::LedgerFeed,
            coverage: None,
            detail: detail.into(),
        }
    }

    pub fn rpc(coverage: Value, detail: impl Into<String>) -> History {
        History {
            source: Source::Rpc,
            coverage: Some(coverage),
            detail: detail.into(),
        }
    }

    pub fn unknown(detail: impl Into<String>) -> History {
        History {
            source: Source::Unknown,
            coverage: None,
            detail: detail.into(),
        }
    }

    /// The history of a findex archive, from the cursor its manifest holds
    /// and whether it holds records.
    pub fn of_archive(cursor: &Value, has_records: bool, dir: &str) -> History {
        if let Some(c) = findex::ingest::coverage_from_cursor(cursor) {
            return History::rpc(c, format!("archive {dir}"));
        }
        if has_records && cursor.get("feed_after").and_then(Value::as_u64).is_some() {
            return History::ledger_feed(format!("archive {dir} (local node feed)"));
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

    /// `as_given`, `ledger_feed` or `unproven` (see the module table).
    pub fn basis(&self) -> &'static str {
        match self.source {
            Source::Fixture => "as_given",
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
        })
    }

    /// The fixture form (`Input::to_json`'s `history`); `None` for a
    /// fixture's own (absent) history.
    pub fn to_json(&self) -> Option<Value> {
        (self.source != Source::Fixture).then(|| {
            json!({"source": self.source.name(), "coverage": self.coverage, "detail": self.detail})
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
            source => History {
                source,
                coverage,
                detail,
            },
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
        if self.state() == Some("cross_checked") {
            detail.push_str("; cross_checked is agreement of two RPC answers, not proof of completeness or finality");
        }
        if !self.detail.is_empty() {
            detail.push_str(&format!(" ({})", self.detail));
        }
        detail.push_str(
            ". No source showed this to be the whole history: the verdict is never PASS, and is FAIL only on a FAIL decided inside fetched transactions; other FAIL findings may stem from a missing range",
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

/// Records the history in the report and, when it is unproven, adds
/// [`HISTORY_UNPROVEN`] and sets the verdict: FAIL when a
/// [self-contained](self_contained) FAIL finding exists, else UNVERIFIABLE
/// (never PASS; every finding stays). `history.selfContainedFails` and
/// `history.otherFails` count what the verdict rests on.
pub fn apply(history: &History, mut r: Report) -> Report {
    let mut h = history.report();
    if let Some(f) = history.finding() {
        let own = r.findings.iter().filter(|x| self_contained(x)).count();
        let other = r.findings.iter().filter(|x| x.fail()).count() - own;
        h["selfContainedFails"] = json!(own);
        h["otherFails"] = json!(other);
        r.findings.push(f);
        r.findings.sort_by_key(|x| std::cmp::Reverse(x.severity));
        r.verdict = if own > 0 {
            Verdict::Fail
        } else {
            Verdict::Unverifiable
        };
    }
    r.history = Some(h);
    r
}
