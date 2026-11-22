//! VT — the looked-up addresses of every v0 transaction (verifier-v0v1).
//!
//! A v0 transaction names some of its accounts by index into an address
//! lookup table. What the cluster resolved them to is in the transaction's
//! `meta.loadedAddresses` (`getTransaction`; findex archives it as
//! `loaded`, #154) — a claim of the RPC / archive, not part of the signed
//! bytes. Every other check reads the transaction's accounts through it
//! ([`crate::vmsg`]), so VT checks it against the tables themselves: each
//! looked-up address must be the one its table holds at that index in the
//! table's state read **at the pinned slot** with the final states
//! (`Input::chain.lookup_tables`; `--rpc` reads it, a finals file or a
//! fixture records it).
//!
//! Why a later read is exact: a lookup table is append-only (Extend only
//! appends; no instruction rewrites an index), and its address is a PDA of
//! (authority, recent slot) whose recent slot must be in SlotHashes at
//! creation, while closing needs the deactivation slot to have left
//! SlotHashes first — so a closed table's address can never hold a new
//! table. Hence any later state that still holds index `i` holds the very
//! address `i` held when the transaction ran (agave
//! `programs/address-lookup-table`, solana-address-lookup-table-interface
//! `state.rs`: `lookup` / `get_active_addresses_len`).
//!
//! Verdicts:
//! - an address that differs, a table account that is not a lookup table,
//!   or one too short for the index: **FAIL `LookupMismatch`** (no honest
//!   archive shows that);
//! - the table not read, or absent (closed) at the pinned slot — including
//!   a closed table's address re-funded by a System transfer (System
//!   owner, no data: nothing else can appear at the PDA):
//!   **UNVERIFIABLE `LookupTableUnread`** — the addresses rest on the
//!   archive's own claim, never a PASS;
//! - no v0 transaction with lookups: VT does not run (a legacy / v1 archive
//!   keeps its report unchanged).
//!
//! Failed transactions are judged too (their accounts' balances and the
//! history checks read them). A record whose `loaded` does not fit its
//! lookups does not decode ([`crate::vmsg::Msg::decode`]); V1 FAILs it
//! `Undecodable`, VT skips it.

use std::collections::BTreeMap;

use crate::codes::{LOOKUP_MISMATCH, LOOKUP_TABLE_UNREAD};
use crate::input::Input;
use crate::vmsg::{table_addresses, Msg};
use crate::{Finding, Severity};

pub const CHECK: &str = "VT";

/// VT's findings and whether it ran (any v0 transaction with lookups).
pub fn judge(input: &Input) -> (Vec<Finding>, bool) {
    let mut out = vec![];
    let mut ran = false;
    let tables = input.chain.lookup_tables.as_ref();
    // (one UNVERIFIABLE per unread table, naming its first transaction)
    let mut unread: BTreeMap<[u8; 32], usize> = BTreeMap::new();
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
            let state = match tables {
                None => None,
                Some(ts) => ts.accounts.get(&key).map(|a| (a, ts.slot)),
            };
            let Some((acc, slot)) = state else {
                unread.entry(key).or_insert(i);
                continue;
            };
            let at = slot.map_or("the pinned slot".to_string(), |s| format!("slot {s}"));
            // verify-pr155: a closed table's address can be re-funded by a
            // plain System transfer (anyone may send lamports to any
            // address; the lookup-table program never signs for its PDA, so
            // no data or other owner can appear there). That account says
            // only "closed": UNVERIFIABLE like an absent one, never a FAIL
            // anyone could buy against an honest season.
            let system = fclient::addr::system_program();
            let Some(acc) = acc.as_ref().filter(|a| {
                (a.lamports > 0 || !a.data.is_empty()) && !(a.data.is_empty() && a.owner == system)
            }) else {
                unread.entry(key).or_insert(i);
                continue;
            };
            let Some(list) = table_addresses(&acc.owner, &acc.data) else {
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
            };
            match list.get(idx as usize) {
                Some(a) if *a == addr => {}
                Some(a) => find(
                    Severity::Fail,
                    LOOKUP_MISMATCH,
                    format!("LookupTable:{t}"),
                    format!(
                        "tx#{i}: its {} lookup of index {idx} in table {t} is recorded as {addr} (meta.loadedAddresses), the table holds {a} there at {at} (tables are append-only: the index held it when the transaction ran)",
                        if writable { "writable" } else { "readonly" },
                    ),
                ),
                None => find(
                    Severity::Fail,
                    LOOKUP_MISMATCH,
                    format!("LookupTable:{t}"),
                    format!(
                        "tx#{i}: its lookup of index {idx} in table {t} (recorded as {addr}) is past the table's {} addresses at {at} (tables only grow)",
                        list.len()
                    ),
                ),
            }
        }
    }
    for (key, i) in unread {
        let t = solana_address::Address::new_from_array(key);
        out.push(Finding {
            code: LOOKUP_TABLE_UNREAD.into(),
            severity: Severity::Unverifiable,
            check: CHECK,
            entity: format!("LookupTable:{t}"),
            bell: 0,
            signature: input.txs[i].signature.to_string(),
            detail: format!(
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
        });
    }
    (out, ran)
}
