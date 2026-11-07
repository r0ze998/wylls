//! One ledger's history from several per-program archives (⑲, 2026-11-07).
//!
//! A local node numbers every landed transaction once (`seq`) and its feed
//! filters that numbering by program, so per-program archives of one node
//! interleave by that number. Each archive renumbers its records with its own
//! sequence and keeps the ledger number as `feed_seq`
//! ([`crate::Archive::append_feed`]); its cursor says where the feed started
//! and which ledger it is (`LocalnetFeed`). [`join`] puts the parts in ledger
//! order and lists every reason the result is not the whole history up to
//! [`Joined::through`]:
//!
//! - a part whose cursor is not a local feed's, refused, or without `ledger`;
//! - parts of different ledgers;
//! - a part that started after the ledger's start (`feed_start` not 0, or not
//!   recorded);
//! - a record without `feed_seq`, or `feed_seq` not strictly increasing within
//!   a part (a duplicate or a reorder), or beyond its part's cursor;
//! - one `feed_seq` with different signatures in two parts, or one signature at
//!   different `feed_seq` (the same transaction is one ledger entry: a
//!   transaction of both programs is in both parts, once each, and is joined
//!   into one entry).
//!
//! Parts can be read up to different points (a restart or a crash between
//! their commits): the joined history is cut at the lowest cursor, and
//! entries past it are left out and counted ([`Joined::beyond`]). A cursor
//! is its own program's last ledger number (`feed_after`), not how far the
//! node's ledger was scanned, so the cut can fall short of what both parts
//! did read: it never claims more.
//!
//! **An empty [`Joined::problems`] is not proof of completeness** beyond the
//! node's own ledger: it says the archives are one ledger's feed from its
//! start, without holes the archives themselves show. A ledger that lost
//! transactions, or two ledgers whose `runId` collides, are not seen here.

use std::collections::BTreeMap;

use fclient::ports::{Signature, TxRecord};
use serde_json::{json, Value};

/// One per-program archive: its records with their `feed_seq`, in archive
/// order, and its cursor.
#[derive(Clone, Debug)]
pub struct Part {
    pub name: String,
    pub records: Vec<(TxRecord, Option<u64>)>,
    pub cursor: Value,
}

impl Part {
    /// Reads a whole archive.
    pub fn of_archive(name: impl Into<String>, a: &crate::Archive) -> std::io::Result<Part> {
        Ok(Part {
            name: name.into(),
            records: a.read_after_feed(0)?,
            cursor: a.cursor().clone(),
        })
    }
}

/// One ledger entry: its number, signature, and where each part holds it
/// (`(part index, archive seq)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub feed_seq: u64,
    pub signature: Signature,
    pub held_by: Vec<(usize, u64)>,
}

#[derive(Clone, Debug, Default)]
pub struct Joined {
    /// Entries with `feed_seq <= through`, in ledger order, one per
    /// transaction.
    pub entries: Vec<Entry>,
    /// Every part was read through this ledger number (the lowest cursor).
    pub through: u64,
    /// The ledger (`runId`) when every part names the same one.
    pub ledger: Option<String>,
    /// Entries past `through` (held by some parts only), left out.
    pub beyond: usize,
    /// Why this is not the whole history through `through` (empty: the
    /// archives show none; see the module note).
    pub problems: Vec<String>,
}

impl Joined {
    /// Structural consistency only. This does not detect a stale part after
    /// a same-run rollback and must not authorize complete-history verdicts.
    pub fn whole(&self) -> bool {
        self.problems.is_empty()
    }

    pub fn json(&self) -> Value {
        json!({
            "whole": false,
            "archive_consistent": self.whole(),
            "freshness": "unproven_same_run_rollback",
            "through": self.through,
            "ledger": self.ledger,
            "entries": self.entries.len(),
            "beyond": self.beyond,
            "problems": self.problems,
        })
    }
}

/// Joins `parts` of one ledger (see the module note).
pub fn join(parts: &[Part]) -> Joined {
    let mut j = Joined::default();
    let mut ledgers: Vec<Option<String>> = vec![];
    let mut through: Option<u64> = None;
    for p in parts {
        let c = &p.cursor;
        if let Some(r) = c.get("feed_refused").and_then(|x| x.as_str()) {
            j.problems.push(format!("{}: refused: {r}", p.name));
        }
        match c.get("feed_after").and_then(|x| x.as_u64()) {
            Some(a) => through = Some(through.map_or(a, |t| t.min(a))),
            None => j.problems.push(format!(
                "{}: the cursor is not a local feed's ({})",
                p.name,
                truncate(&c.to_string(), 80)
            )),
        }
        match c.get("feed_start").and_then(|x| x.as_u64()) {
            Some(0) => {}
            Some(s) => j
                .problems
                .push(format!("{}: the feed started after ledger seq {s}", p.name)),
            None => j.problems.push(format!(
                "{}: where the feed started is not recorded",
                p.name
            )),
        }
        let l = c.get("ledger").and_then(|x| x.as_str()).map(String::from);
        if l.is_none() {
            j.problems
                .push(format!("{}: which ledger it is is not recorded", p.name));
        }
        ledgers.push(l);
    }
    let named: Vec<&String> = ledgers.iter().flatten().collect();
    if named.windows(2).any(|w| w[0] != w[1]) {
        j.problems.push(format!(
            "the parts are of different ledgers ({})",
            named
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    } else if named.len() == parts.len() {
        j.ledger = named.first().map(|s| s.to_string());
    }
    j.through = through.unwrap_or(0);

    let mut by_seq: BTreeMap<u64, Entry> = BTreeMap::new();
    let mut by_sig: BTreeMap<Signature, u64> = BTreeMap::new();
    for (i, p) in parts.iter().enumerate() {
        let after = p.cursor.get("feed_after").and_then(|x| x.as_u64());
        let mut prev: Option<u64> = None;
        for (r, f) in &p.records {
            let Some(f) = *f else {
                j.problems.push(format!(
                    "{}: archive seq {} has no feed_seq (archived before it was kept)",
                    p.name, r.seq
                ));
                continue;
            };
            if prev.is_some_and(|q| f <= q) {
                j.problems.push(format!(
                    "{}: feed_seq {f} at archive seq {} does not follow {} (a duplicate or a reorder)",
                    p.name,
                    r.seq,
                    prev.unwrap_or(0)
                ));
            }
            prev = Some(prev.map_or(f, |q| q.max(f)));
            if after.is_some_and(|a| f > a) {
                j.problems
                    .push(format!("{}: feed_seq {f} is past its own cursor", p.name));
            }
            match by_sig.get(&r.signature) {
                Some(&g) if g != f => j.problems.push(format!(
                    "{}: {} is at feed_seq {f} here and at {g} elsewhere (one transaction, two ledger numbers)",
                    p.name, r.signature
                )),
                _ => {
                    by_sig.insert(r.signature, f);
                }
            }
            match by_seq.get_mut(&f) {
                Some(e) if e.signature != r.signature => j.problems.push(format!(
                    "{}: feed_seq {f} is {} here and {} elsewhere (two transactions, one ledger number)",
                    p.name, r.signature, e.signature
                )),
                Some(e) => {
                    if e.held_by.iter().any(|(k, _)| *k == i) {
                        j.problems.push(format!(
                            "{}: feed_seq {f} twice in one part",
                            p.name
                        ));
                    }
                    e.held_by.push((i, r.seq));
                }
                None => {
                    by_seq.insert(
                        f,
                        Entry {
                            feed_seq: f,
                            signature: r.signature,
                            held_by: vec![(i, r.seq)],
                        },
                    );
                }
            }
        }
    }
    for (f, e) in by_seq {
        if f <= j.through {
            j.entries.push(e);
        } else {
            j.beyond += 1;
        }
    }
    j
}

fn truncate(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}
