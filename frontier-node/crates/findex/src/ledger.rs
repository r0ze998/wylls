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
//! their commits): the joined history is cut at the lowest extent, and
//! entries past it are left out and counted ([`Joined::beyond`]). A part's
//! extent is how far the node's ledger was scanned for it (`feed_scanned`,
//! the node's `scannedThrough`, workstream 04, 2026-11-07) when its cursor
//! keeps it, else its own program's last ledger number (`feed_after`),
//! which can fall short of what was read: it never claims more. An extent
//! below the part's own `feed_after` is a contradiction.
//!
//! Two parts of one ledger read at different times must agree that the
//! ledger only grew: the part scanned further cannot have seen fewer ledger
//! bytes (`ledger_bytes`); if it did, the ledger was rewound between the
//! reads and is not whole. (A rewind that grew back past the earlier size
//! is not seen this way; each part's own next read checks the transaction
//! at its cursor, `ingest::LocalnetFeed`.)
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
    pub fn whole(&self) -> bool {
        self.problems.is_empty()
    }

    pub fn json(&self) -> Value {
        json!({
            "whole": self.whole(),
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
            Some(a) => {
                let e = match c.get("feed_scanned").and_then(|x| x.as_u64()) {
                    Some(sc) if sc < a => {
                        j.problems.push(format!(
                            "{}: scanned through {sc}, before its own cursor {a}",
                            p.name
                        ));
                        a
                    }
                    Some(sc) => sc,
                    None => a,
                };
                through = Some(through.map_or(e, |t| t.min(e)));
            }
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
    // The ledger only grows: a part scanned further saw at least as many bytes.
    let sized: Vec<(&str, u64, u64)> = parts
        .iter()
        .filter_map(|p| {
            let c = &p.cursor;
            Some((
                p.name.as_str(),
                c.get("feed_scanned")?.as_u64()?,
                c.get("ledger_bytes")?.as_u64().filter(|b| *b > 0)?,
            ))
        })
        .collect();
    for x in &sized {
        for y in &sized {
            if x.1 < y.1 && x.2 > y.2 {
                j.problems.push(format!(
                    "{} was scanned through {} with {} ledger bytes, {} through {} with only {}: the ledger was rewound between the reads",
                    x.0, x.1, x.2, y.0, y.1, y.2
                ));
            }
        }
    }

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

/// What the node says now (`frontier_status`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NodeStatus {
    pub run_id: Option<String>,
    /// The ledger's WAL size: it only grows on one ledger.
    pub ledger_bytes: Option<u64>,
    /// Landed transactions (the highest ledger number).
    pub transactions: Option<u64>,
}

/// Reads `frontier_status` from a local node.
pub async fn node_status(url: &str) -> Result<NodeStatus, String> {
    let v = fclient::rpc::RpcClient::new(url)
        .call("frontier_status", json!([]))
        .await
        .map_err(|e| e.to_string())?;
    Ok(NodeStatus {
        run_id: v.get("runId").and_then(|x| x.as_str()).map(String::from),
        ledger_bytes: v.get("ledgerBytes").and_then(|x| x.as_u64()),
        transactions: v.get("transactions").and_then(|x| x.as_u64()),
    })
}

/// Checks archived parts against the node that serves their ledger now:
/// the same `runId`; a ledger size (`ledgerBytes`) not below what each part
/// recorded; at least as many transactions as each part's last ledger
/// number; and each part's last record still at its ledger number with its
/// signature. Returns why the parts no longer match the node (empty: they
/// do). A node that cannot be read is a reason too: nothing was confirmed.
///
/// This closes what [`join`] cannot see alone: a ledger rewound under the
/// same `runId` (a tail lost without fsync) after a part was archived, the
/// seq then taken by another transaction. Without a node (an archive alone)
/// it cannot be seen; the verifier's history says so.
pub async fn check_node(url: &str, parts: &[Part]) -> Vec<String> {
    let mut why = vec![];
    let st = match node_status(url).await {
        Ok(s) => s,
        Err(e) => {
            return vec![format!(
                "the node could not be read ({e}): nothing confirmed"
            )]
        }
    };
    for p in parts {
        // One read per part (04 and 19, 2026-11-07): `frontier_feed` with
        // the scan at the part's last ledger number answers, under the node's
        // lock, the transaction there (`atAfter`), the ledger's length, its id
        // and its size together, so nothing lands between them. A node
        // without the scan: the status above and an unfiltered read of that
        // one entry, as before.
        let last = p
            .records
            .last()
            .and_then(|(r, f)| f.map(|fs| (r.signature, fs)));
        let at = last.map_or(0, |(_, fs)| fs);
        let scan = fclient::rpc::RpcClient::new(url)
            .call("frontier_feed", json!([at, 0, null, {"scan": true}]))
            .await;
        let scan = match scan {
            Ok(v) if v.is_object() => Some(v),
            Ok(_) => None,
            Err(e) => {
                why.push(format!(
                    "{}: the node could not be read ({e}): not confirmed",
                    p.name
                ));
                continue;
            }
        };
        let (run_id, bytes, len) = match &scan {
            Some(v) => (
                v.get("runId").and_then(|x| x.as_str()).map(String::from),
                v.get("ledgerBytes").and_then(|x| x.as_u64()),
                v.get("ledgerLen").and_then(|x| x.as_u64()),
            ),
            None => (st.run_id.clone(), st.ledger_bytes, st.transactions),
        };
        let theirs = p.cursor.get("ledger").and_then(|x| x.as_str());
        match (theirs, run_id.as_deref()) {
            (Some(t), Some(n)) if t == n => {}
            (Some(t), Some(n)) => why.push(format!(
                "{}: archived from ledger {t}, the node serves ledger {n}",
                p.name
            )),
            (_, None) => why.push(format!(
                "{}: the node does not say which ledger it serves",
                p.name
            )),
            (None, _) => why.push(format!("{}: which ledger it is is not recorded", p.name)),
        }
        if let Some(rec) = p.cursor.get("ledger_bytes").and_then(|x| x.as_u64()) {
            match bytes {
                Some(now) if now < rec => why.push(format!(
                    "{}: the node's ledger is {now} bytes, {rec} when archived: it shrank (rewound)",
                    p.name
                )),
                Some(_) => {}
                None => why.push(format!("{}: the node does not report its ledger size", p.name)),
            }
        }
        // The archive's extent must still be on the ledger.
        let extent = p
            .cursor
            .get("feed_scanned")
            .and_then(|x| x.as_u64())
            .unwrap_or(at)
            .max(at);
        if len.is_some_and(|t| t < extent) {
            why.push(format!(
                "{}: the node holds {} transactions, the archive was read through ledger seq {extent}: rewound",
                p.name,
                len.unwrap_or(0)
            ));
        }
        let Some((sig, fs)) = last else {
            continue;
        };
        let found: Option<(u64, Signature)> = match &scan {
            Some(v) => v
                .get("atAfter")
                .filter(|x| !x.is_null())
                .and_then(|x| x.as_str())
                .and_then(|x| x.parse().ok())
                .map(|g| (fs, g)),
            None => {
                // The ledger's entry at `fs`, whatever program (an unfiltered feed).
                let got = fclient::rpc::RpcClient::new(url)
                    .call("frontier_feed", json!([fs.saturating_sub(1), 1]))
                    .await;
                got.ok()
                    .and_then(|v| v.as_array().and_then(|a| a.first().cloned()))
                    .and_then(|r| fclient::rpc::parse_feed_record(&r).ok())
                    .map(|r| (r.seq, r.signature))
            }
        };
        match found {
            Some((q, g)) if q == fs && g == sig => {}
            Some((q, g)) => why.push(format!(
                "{}: the archive's last transaction {sig} is at ledger seq {fs}, the node has {g} at seq {q} there: rewound or rebuilt",
                p.name
            )),
            None => why.push(format!(
                "{}: the node has nothing at the archive's last ledger seq {fs} (or could not be read): rewound or not confirmed",
                p.name
            )),
        }
    }
    why
}
