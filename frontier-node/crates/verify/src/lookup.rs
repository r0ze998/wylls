//! VT — the looked-up addresses of every v0 transaction (verifier-v0v1;
//! table snapshots and stale reads: verifier-alt-archive, F2 / F3 of
//! verify-pr155).
//!
//! A v0 transaction names some of its accounts by index into an address
//! lookup table. What the cluster resolved them to is in the transaction's
//! `meta.loadedAddresses` (`getTransaction`; findex archives it as
//! `loaded`, #154) — a claim of the RPC / archive, not part of the signed
//! bytes. Every other check reads the transaction's accounts through it
//! ([`crate::vmsg`]), so VT checks it against the tables themselves: each
//! looked-up address must be the one its table holds at that index.
//!
//! Why any read that holds the index is exact: a lookup table is
//! append-only (Extend only appends; no instruction rewrites an index), and
//! its address is a PDA of (authority, recent slot) whose recent slot must
//! be in SlotHashes at creation, while closing needs the deactivation slot
//! to have left SlotHashes first — so a closed table's address can never
//! hold a new table. Hence any state that holds index `i` holds the very
//! address `i` held when the transaction ran (agave
//! `programs/address-lookup-table`, solana-address-lookup-table-interface
//! `state.rs`: `lookup` / `get_active_addresses_len`; [`fclient::alt`]).
//!
//! ## The evidence, in order
//!
//! 1. **The pinned read** (`Input::chain.lookup_tables`): the tables as read
//!    with the final states (`--rpc`, a finals file, a fixture). Exactly as
//!    before this module grew snapshots:
//!    - it holds the index: the address must be the archived one, else
//!      **FAIL `LookupMismatch`**;
//!    - it is not a lookup table (another owner with data): **FAIL**;
//!    - it is a table too short for the index: **FAIL** — unless it was read
//!      at a slot *before* the transaction's (F3: an index appended later
//!      is honestly past its end then), when it settles nothing;
//!    - it is absent / closed (absent, 0 lamports, or a System account with
//!      only lamports: verify-pr155), or not read: it settles nothing.
//! 2. **Snapshots** (`Input::chain.lookup_snapshots`, [`fclient::alt::Snapshot`]),
//!    consulted only where the pinned read settles nothing: findex's
//!    snapshot of a table taken the first time the archive took a
//!    transaction using it (the account at that transaction's slot or later,
//!    the slot read, and the table's own create / extend transactions), and
//!    the verifier's own read of a closed table's transactions (`--rpc`).
//!    - **Its account read** is judged by the pinned read's own rules (any
//!      honest read of an append-only table that holds the index holds the
//!      address): a different address, another owner with data, or a table
//!      too short for the index although read at or after the transaction's
//!      slot: **FAIL `LookupMismatch`**. The same address settles the
//!      lookup.
//!    - **Its history** ([`fclient::alt::replay`]: signatures checked, the
//!      `CreateLookupTable` PDA derivation must give the table, every Extend
//!      signed by the authority, nothing another program could have done by
//!      CPI) settles the lookup when it put the archived address at the
//!      index in a slot before the transaction's. A history that disagrees
//!      (another address, appended too late, not a prefix of the account
//!      read) is **UNVERIFIABLE `LookupSnapshotUnproven`**, never FAIL: an
//!      RPC may serve a table's history short (a missing Extend shifts every
//!      later index), so a disagreement shows that something is missing,
//!      not that the season is bad.
//!    - Two reads of one table (pinned and snapshots) that are both tables
//!      must be prefix-compatible: else **FAIL** (no honest pair of reads of
//!      an append-only table differs at an index both hold).
//! 3. Nothing settles the lookup: **UNVERIFIABLE** — `LookupTableUnread`
//!    (no table read, or closed, and no snapshot), `LookupTableStale` (F3:
//!    read before the transaction, index past its end then, and no snapshot
//!    settles it) or `LookupSnapshotUnproven` (snapshots, none settling). The
//!    addresses rest on the archive's own claim: never a PASS.
//!
//! **What makes a snapshot trustworthy** (stated in the report):
//! - inside VT, a snapshot is a second, independent read — an account read
//!   (`getMultipleAccounts`, its own `context.slot`) or the table's signed
//!   create / extend bytes — never the transaction's own `meta`; it settles
//!   a lookup only when it **agrees** with that `meta`, so a snapshot can
//!   never turn a mismatch into a PASS, only an UNVERIFIABLE (closed table)
//!   into one, and every rule that FAILed before still FAILs;
//! - a snapshot carried by the input is as trusted as the input's other
//!   reads (a fixture's `as_given`, a ledger feed's node); a public-RPC
//!   history additionally needs **every witness to confirm each lookup on
//!   its own reads** (VS, [`crate::witness`]: its own table read, or the
//!   snapshot's history as the witness serves it, replayed), or ⑲ stays
//!   `unproven` (never PASS). An account-only snapshot of a table that was
//!   closed since cannot be confirmed by any witness (no RPC serves an old
//!   account state), so it never lifts a public season.
//!
//! - no v0 transaction with lookups: VT does not run (a legacy / v1 archive
//!   keeps its report unchanged).
//!
//! Failed transactions are judged too (their accounts' balances and the
//! history checks read them). A record whose `loaded` does not fit its
//! lookups does not decode ([`crate::vmsg::Msg::decode`]); V1 FAILs it
//! `Undecodable`, VT skips it.

use std::collections::BTreeMap;

use fclient::alt::{self, Read, Snapshot};
use solana_address::Address;

use crate::codes::{
    LOOKUP_MISMATCH, LOOKUP_SNAPSHOT_UNPROVEN, LOOKUP_TABLE_STALE, LOOKUP_TABLE_UNREAD,
};
use crate::input::Input;
use crate::vmsg::Msg;
use crate::{Finding, Severity};

pub const CHECK: &str = "VT";

/// What one piece of evidence says about one lookup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settle {
    /// It shows the archived address at the index.
    Same,
    /// It shows another address there (`fail`: an account read, FAIL; a
    /// history, UNVERIFIABLE).
    Differs { fail: bool, why: String },
    /// It says nothing about the index (why).
    Silent(String),
}

/// A snapshot's evidence, decoded once.
pub struct Evidence<'a> {
    pub snap: &'a Snapshot,
    /// The account read, classified, with its slot.
    pub read: Option<Read<'a>>,
    /// The table's own transactions replayed (`None`: not read).
    pub built: Option<Result<alt::Built, alt::Refused>>,
}

impl<'a> Evidence<'a> {
    pub fn of(snap: &'a Snapshot) -> Evidence<'a> {
        Evidence {
            snap,
            read: snap.account.as_ref().map(|a| alt::classify(a.as_ref())),
            built: snap.history.as_ref().map(|h| alt::replay(&snap.table, h)),
        }
    }

    fn who(&self) -> String {
        format!(
            "the {} snapshot{}{}",
            if self.snap.source.is_empty() {
                "archived"
            } else {
                self.snap.source.as_str()
            },
            self.snap.used_by.map_or(String::new(), |(s, slot)| format!(
                " taken for {s} (slot {slot})"
            )),
            self.snap
                .read_slot
                .map_or(String::new(), |s| format!(", read at slot {s}"))
        )
    }

    /// The snapshot's account read on the lookup of index `idx` (archived as
    /// `addr`) by a transaction at `slot`.
    pub fn account_says(&self, idx: u8, addr: &Address, slot: u64) -> Settle {
        match &self.read {
            None => Settle::Silent(format!("{}: no account read", self.who())),
            Some(Read::Closed) => Settle::Silent(format!("{}: the table was closed", self.who())),
            Some(Read::Foreign(a)) => Settle::Differs {
                fail: true,
                why: format!(
                    "{}: the account is not an address lookup table (owner {}, {} bytes); a table's address can never hold another account's data",
                    self.who(),
                    a.owner,
                    a.data.len()
                ),
            },
            Some(Read::Table(t)) => match t.addresses.get(idx as usize) {
                Some(a) if a == addr => Settle::Same,
                Some(a) => Settle::Differs {
                    fail: true,
                    why: format!(
                        "{}: the table holds {a} at index {idx} (tables are append-only: the index held it when the transaction ran)",
                        self.who()
                    ),
                },
                None if self.snap.read_slot.is_some_and(|r| r >= slot) => Settle::Differs {
                    fail: true,
                    why: format!(
                        "{}: index {idx} is past the table's {} addresses although read at or after the transaction's slot {slot} (tables only grow)",
                        self.who(),
                        t.addresses.len()
                    ),
                },
                None => Settle::Silent(format!(
                    "{}: index {idx} past its {} addresses, read {}",
                    self.who(),
                    t.addresses.len(),
                    match self.snap.read_slot {
                        Some(_) => format!("before the transaction's slot {slot}"),
                        None => "at a slot not said".into(),
                    }
                )),
            },
        }
    }

    /// The snapshot's history on the same lookup.
    pub fn history_says(&self, idx: u8, addr: &Address, slot: u64) -> Settle {
        history_says(&self.who(), self.built.as_ref(), idx, addr, slot)
    }
}

/// A replayed history (`built`, `None`: not read) on the lookup of `idx`
/// archived as `addr` by a transaction at `slot` (VT and VS).
pub fn history_says(
    who: &str,
    built: Option<&Result<alt::Built, alt::Refused>>,
    idx: u8,
    addr: &Address,
    slot: u64,
) -> Settle {
    match built {
        None => Settle::Silent(format!("{who}: its transactions were not read")),
        // Records that are not genuine transactions: the snapshot is not
        // honest, so nothing beside it settles (never FAIL: it is the
        // snapshot that is bad, not shown to be the season).
        Some(Err(e)) if e.forged => Settle::Differs {
            fail: false,
            why: format!("{who}: its transactions are not genuine: {e}"),
        },
        Some(Err(e)) => Settle::Silent(format!("{who}: its transactions do not replay: {e}")),
        Some(Ok(b)) => match b.addresses.get(idx as usize) {
            Some((a, at)) if a == addr && *at < slot => Settle::Same,
            Some((a, at)) if a == addr => Settle::Differs {
                fail: false,
                why: format!(
                    "{who}: its transactions append {a} at index {idx} in slot {at}, not before the transaction's slot {slot} (an address appended in the slot it is used is not active yet)"
                ),
            },
            Some((a, at)) => Settle::Differs {
                fail: false,
                why: format!(
                    "{who}: its transactions put {a} at index {idx} (slot {at}); a history served short shifts every later index, so this is UNVERIFIABLE, not FAIL"
                ),
            },
            None => Settle::Silent(format!(
                "{who}: its transactions append only {} addresses",
                b.addresses.len()
            )),
        },
    }
}

/// VT's findings and whether it ran (any v0 transaction with lookups).
pub fn judge(input: &Input) -> (Vec<Finding>, bool) {
    let mut out = vec![];
    let mut ran = false;
    let tables = input.chain.lookup_tables.as_ref();
    let evidence: Vec<Evidence> = input
        .chain
        .lookup_snapshots
        .iter()
        .map(Evidence::of)
        .collect();
    let of_table = |key: Address| evidence.iter().filter(move |e| e.snap.table == key);
    // (one UNVERIFIABLE per table, naming its first unsettled transaction:
    //  code, detail)
    let mut unsettled: BTreeMap<[u8; 32], (usize, &'static str, String)> = BTreeMap::new();
    // (tables whose reads were checked against each other)
    let mut cross_checked: BTreeMap<[u8; 32], ()> = BTreeMap::new();
    for (i, rec) in input.txs.iter().enumerate() {
        let Ok(m) = Msg::of(rec) else { continue };
        let looked = m.lookups();
        if looked.is_empty() {
            continue;
        }
        ran = true;
        let sig = rec.signature.to_string();
        let mut find = |sev: Severity, code: &str, entity: String, detail: String| {
            out.push(Finding {
                code: code.into(),
                severity: sev,
                check: CHECK,
                entity,
                bell: 0,
                signature: sig.clone(),
                detail,
            })
        };
        for (t, idx, addr, writable) in looked {
            let key = t.to_bytes();
            // Every two table reads of `t` agree (once per table).
            if cross_checked.insert(key, ()).is_none() {
                if let Some(d) = reads_disagree(tables, of_table(t), &t) {
                    find(
                        Severity::Fail,
                        LOOKUP_MISMATCH,
                        format!("LookupTable:{t}"),
                        format!("tx#{i}: {d}"),
                    );
                }
            }
            // 1. the pinned read
            let state = match tables {
                None => None,
                Some(ts) => ts.accounts.get(&key).map(|a| (a, ts.slot)),
            };
            let mut stale = None;
            if let Some((acc, slot)) = state {
                let at = slot.map_or("the pinned slot".to_string(), |s| format!("slot {s}"));
                match alt::classify(acc.as_ref()) {
                    Read::Closed => {}
                    Read::Foreign(acc) => {
                        find(
                            Severity::Fail,
                            LOOKUP_MISMATCH,
                            format!("LookupTable:{t}"),
                            format!(
                                "tx#{i}: the account {t} its lookup names is not an address lookup table at {at} (owner {}, {} bytes); a closed table's address can never hold another account's data",
                                acc.owner,
                                acc.data.len()
                            ),
                        );
                        continue;
                    }
                    Read::Table(tb) => match tb.addresses.get(idx as usize) {
                        Some(a) if *a == addr => continue,
                        Some(a) => {
                            find(
                                Severity::Fail,
                                LOOKUP_MISMATCH,
                                format!("LookupTable:{t}"),
                                format!(
                                    "tx#{i}: its {} lookup of index {idx} in table {t} is recorded as {addr} (meta.loadedAddresses), the table holds {a} there at {at} (tables are append-only: the index held it when the transaction ran)",
                                    if writable { "writable" } else { "readonly" },
                                ),
                            );
                            continue;
                        }
                        // F3: read before the transaction's slot, the index
                        // may honestly not exist yet.
                        None if slot.is_some_and(|s| s < rec.slot) => {
                            stale = Some(format!(
                                "its lookup of index {idx} (recorded as {addr}) is past the table's {} addresses at {at}, read before the transaction's slot {} (an index appended in between is honestly missing)",
                                tb.addresses.len(),
                                rec.slot
                            ));
                        }
                        None => {
                            find(
                                Severity::Fail,
                                LOOKUP_MISMATCH,
                                format!("LookupTable:{t}"),
                                format!(
                                    "tx#{i}: its lookup of index {idx} in table {t} (recorded as {addr}) is past the table's {} addresses at {at} (tables only grow)",
                                    tb.addresses.len()
                                ),
                            );
                            continue;
                        }
                    },
                }
            }
            // 2. the snapshots
            let mut settled = false;
            let mut failed = false;
            let mut doubts: Vec<String> = vec![];
            let mut silent: Vec<String> = vec![];
            let mut any = false;
            for e in of_table(t) {
                any = true;
                for s in [
                    e.account_says(idx, &addr, rec.slot),
                    e.history_says(idx, &addr, rec.slot),
                ] {
                    match s {
                        Settle::Same => settled = true,
                        Settle::Differs { fail: true, why } => {
                            failed = true;
                            find(
                                Severity::Fail,
                                LOOKUP_MISMATCH,
                                format!("LookupTable:{t}"),
                                format!(
                                    "tx#{i}: its {} lookup of index {idx} in table {t} is recorded as {addr} (meta.loadedAddresses); {why}",
                                    if writable { "writable" } else { "readonly" },
                                ),
                            );
                        }
                        Settle::Differs { fail: false, why } => doubts.push(why),
                        Settle::Silent(why) => silent.push(why),
                    }
                }
                // A history that is not a prefix of the account read beside
                // it: the snapshot contradicts itself.
                if let (Some(Read::Table(tb)), Some(Ok(b))) = (&e.read, &e.built) {
                    if !alt::prefix_compatible(&tb.addresses, &b.list()) {
                        doubts.push(format!(
                            "{}: its transactions replay to {} addresses that are not a prefix of (or prefixed by) its account's {}",
                            e.who(),
                            b.addresses.len(),
                            tb.addresses.len()
                        ));
                    }
                }
            }
            if failed || (settled && doubts.is_empty()) {
                continue;
            }
            // 3. unsettled
            let (code, detail) = if any {
                (
                    LOOKUP_SNAPSHOT_UNPROVEN,
                    format!(
                        "tx#{i} (and any later one naming it): no read settles its lookup of index {idx} in table {t} (recorded as {addr}): {}; the addresses rest on the archive's meta.loadedAddresses alone",
                        doubts
                            .iter()
                            .chain(stale.iter())
                            .chain(silent.iter())
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("; ")
                    ),
                )
            } else if let Some(s) = stale {
                (
                    LOOKUP_TABLE_STALE,
                    format!(
                        "tx#{i} (and any later one naming it): {s}; no snapshot of table {t} settles it, so the addresses rest on the archive's meta.loadedAddresses alone"
                    ),
                )
            } else {
                (
                    LOOKUP_TABLE_UNREAD,
                    format!(
                        "tx#{i} (and any later one naming it): lookup table {t} {}; the addresses its lookups resolved to rest on the archive's meta.loadedAddresses alone",
                        match &input.chain.lookup_tables {
                            None => "was not read (no lookup table states: --rpc reads them with the final states, a finals file or fixture records `lookup_tables`)".to_string(),
                            Some(ts) => format!(
                                "is {} at {}",
                                if ts.accounts.contains_key(&key) { "closed (absent, or only lamports sent to its address since)" } else { "not among the tables read" },
                                ts.slot.map_or("the pinned slot".into(), |s| format!("slot {s}"))
                            ),
                        }
                    ),
                )
            };
            unsettled.entry(key).or_insert((i, code, detail));
        }
    }
    for (key, (i, code, detail)) in unsettled {
        let t = Address::new_from_array(key);
        out.push(Finding {
            code: code.into(),
            severity: Severity::Unverifiable,
            check: CHECK,
            entity: format!("LookupTable:{t}"),
            bell: 0,
            signature: input.txs[i].signature.to_string(),
            detail,
        });
    }
    (out, ran)
}

/// Two table reads of `t` (the pinned read and every snapshot's account)
/// that are not prefix-compatible, said (`None`: they all agree).
fn reads_disagree<'a>(
    pinned: Option<&crate::input::LookupTables>,
    snaps: impl Iterator<Item = &'a Evidence<'a>>,
    t: &Address,
) -> Option<String> {
    let mut reads: Vec<(String, Vec<Address>)> = vec![];
    if let Some(ts) = pinned {
        if let Some(Read::Table(tb)) = ts
            .accounts
            .get(&t.to_bytes())
            .map(|a| alt::classify(a.as_ref()))
        {
            reads.push((
                format!(
                    "the pinned read ({})",
                    ts.slot
                        .map_or("slot not said".into(), |s| format!("slot {s}"))
                ),
                tb.addresses,
            ));
        }
    }
    for e in snaps {
        if let Some(Read::Table(tb)) = &e.read {
            reads.push((e.who(), tb.addresses.clone()));
        }
    }
    for (x, (wa, a)) in reads.iter().enumerate() {
        for (wb, b) in &reads[x + 1..] {
            if !alt::prefix_compatible(a, b) {
                let n = a.iter().zip(b).position(|(p, q)| p != q).unwrap_or(0);
                return Some(format!(
                    "two reads of the append-only table {t} disagree at index {n}: {wa} holds {}, {wb} holds {}",
                    a[n], b[n]
                ));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built(addrs: &[(u8, u64)]) -> Result<alt::Built, alt::Refused> {
        Ok(alt::Built {
            authority: None,
            addresses: addrs
                .iter()
                .map(|&(b, s)| (Address::new_from_array([b; 32]), s))
                .collect(),
            created_slot: 0,
            deactivated_slot: None,
            closed_slot: None,
            txs: 1,
        })
    }

    #[test]
    fn a_history_settles_only_what_it_appended_before_the_use() {
        let a = Address::new_from_array([1; 32]);
        let b = built(&[(1, 5), (2, 9)]);
        assert_eq!(history_says("h", Some(&b), 0, &a, 6), Settle::Same);
        // appended in the slot it is used: not active yet
        assert!(matches!(
            history_says("h", Some(&b), 0, &a, 5),
            Settle::Differs { fail: false, .. }
        ));
        // another address there: UNVERIFIABLE (a history may be served
        // short), never FAIL
        assert!(matches!(
            history_says("h", Some(&b), 1, &a, 10),
            Settle::Differs { fail: false, .. }
        ));
        // past its end, or not read: silent
        assert!(matches!(
            history_says("h", Some(&b), 2, &a, 10),
            Settle::Silent(_)
        ));
        assert!(matches!(
            history_says("h", None, 0, &a, 6),
            Settle::Silent(_)
        ));
        // not genuine: blocks settling; merely unreplayable: silent
        let forged = Err(alt::Refused {
            forged: true,
            why: "x".into(),
        });
        assert!(matches!(
            history_says("h", Some(&forged), 0, &a, 6),
            Settle::Differs { fail: false, .. }
        ));
        let short = Err(alt::Refused {
            forged: false,
            why: "x".into(),
        });
        assert!(matches!(
            history_says("h", Some(&short), 0, &a, 6),
            Settle::Silent(_)
        ));
    }
}
