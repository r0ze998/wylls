//! The resident program's side of the history (⑳ for V28, 2026-11-07).
//!
//! An NFT Citizen's holder (Core owner, generation, session) lives in the
//! resident program's accounts, which the Frontier program only reads. So
//! V28 judges a ResidentAct's holder from the resident program's own
//! transactions, **in the same order as the Frontier program's**:
//!
//! - The local node (`frontier-localnet`) numbers every landed transaction
//!   with one `seq` (`localnet::chain` `landed`, airdrops included) and its
//!   `frontier_feed` filters that ledger by program. A feed of the resident
//!   program from the same node is therefore in the same order as the
//!   Frontier input's; a transaction of both programs has the same `seq`
//!   and signature in both.
//! - [`ResidentFeed::through`] says how far the feed was read: every
//!   resident-program transaction with `after < seq <= through` is in it.
//!   [`fetch`] reads it **after** the Frontier transactions and records
//!   `through` as the last Frontier `seq` it was given: the ledger only grows,
//!   so a later full read covers at least that far.
//!
//! [`ResidentFeed::gaps_before`] says why the feed does not show the whole
//! resident history before a `seq` (empty: it does). A feed read before later
//! transfers (a stale copy) stops before the act and is never whole; a feed
//! from another source, a public RPC (⑲'s `unproven` basis), or one whose
//! shared transactions disagree with the Frontier input is never whole either.
//! V28 then leaves what it cannot decide UNVERIFIABLE (`ResidentActUnproven`).

use std::collections::{BTreeMap, BTreeSet};

use fclient::ports::{Account, TxRecord};
use serde_json::{json, Value};
use solana_address::Address;

use crate::history::{History, Source};
use crate::world::{Key, World};

/// One resident-program transaction of the feed, failed ones included, with
/// the post-states of the accounts it wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResidentTx {
    pub seq: u64,
    pub signature: String,
    pub ok: bool,
    pub post: BTreeMap<Key, Account>,
}

/// The resident program's transactions and its policy accounts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentFeed {
    /// The resident program the feed was filtered by.
    pub program: Address,
    /// Where it came from (⑲'s sources; `ledger_feed` from a local node).
    pub history: History,
    /// The feed cursor the read started after (0: the ledger's start).
    pub after: u64,
    /// Every resident-program transaction with `after < seq <= through` is in `txs`.
    pub through: u64,
    /// The node's ledger length (`frontier_status.transactions`) read
    /// **after** the feed: a freshness check only (⑲, 2026-11-07). The node
    /// counts its own ledger, so a node missing a range misses it in the
    /// count too; agreeing adds nothing to wholeness, disagreeing (the
    /// range or a seq beyond the tip) means the read is inconsistent.
    pub tip: Option<u64>,
    pub txs: Vec<ResidentTx>,
    /// The policy accounts (written once: any read of one is its value).
    pub policies: BTreeMap<Key, Account>,
}

impl ResidentTx {
    pub fn of(r: &TxRecord) -> ResidentTx {
        ResidentTx {
            seq: r.seq,
            signature: r.signature.to_string(),
            ok: r.err.is_none(),
            post: r
                .post
                .iter()
                .filter_map(|(k, a)| Some((k.to_bytes(), a.clone()?)))
                .collect(),
        }
    }
}

impl ResidentFeed {
    /// The account's state after the last successful transaction before `seq`.
    pub fn state_before(&self, k: &Key, seq: u64) -> Option<&Account> {
        self.txs
            .iter()
            .filter(|t| t.ok && t.seq < seq)
            .filter_map(|t| t.post.get(k).map(|a| (t.seq, a)))
            .max_by_key(|x| x.0)
            .map(|x| x.1)
    }

    /// Every state of `k` before `seq`.
    pub fn states_before<'a>(&'a self, k: &'a Key, seq: u64) -> impl Iterator<Item = &'a Account> {
        self.txs
            .iter()
            .filter(move |t| t.ok && t.seq < seq)
            .filter_map(move |t| t.post.get(k))
    }

    /// Why this feed does not show the resident program's whole history
    /// before `seq`, beside the Frontier input `w` read from `frontier`
    /// (empty: it does).
    pub fn gaps_before(&self, w: &World, frontier: &History, seq: u64) -> Vec<String> {
        let mut why = vec![];
        if self.history.unproven() {
            why.push(format!(
                "the resident feed's source ({}) does not show a whole history",
                self.history.source.name()
            ));
        }
        if frontier.unproven() {
            why.push("the game program's history is unproven".into());
        }
        if self.history.source != frontier.source
            || (self.history.source == Source::LedgerFeed && self.history.detail != frontier.detail)
        {
            why.push(format!(
                "the resident feed ({} {}) is not from the game history's source ({} {})",
                self.history.source.name(),
                self.history.detail,
                frontier.source.name(),
                frontier.detail
            ));
        }
        if self.after != 0 {
            why.push(format!("the resident feed starts after seq {}", self.after));
        }
        if self.through.saturating_add(1) < seq {
            why.push(format!(
                "the resident feed was read through seq {}, before this act at seq {seq} (a stale copy)",
                self.through
            ));
        }
        let mut seen = BTreeSet::new();
        for t in &self.txs {
            if t.seq <= self.after || t.seq > self.through {
                why.push(format!(
                    "the resident feed holds seq {} outside its range",
                    t.seq
                ));
            }
            if !seen.insert(t.seq) {
                why.push(format!("the resident feed holds seq {} twice", t.seq));
            }
        }
        if let Some(tip) = self.tip {
            let last = self
                .txs
                .iter()
                .map(|t| t.seq)
                .chain(w.txs.iter().map(|t| t.seq))
                .chain([self.through])
                .max()
                .unwrap_or(0);
            if last > tip {
                why.push(format!(
                    "the ledger read after the feed ends at seq {tip}, before seq {last} the reads hold (an inconsistent read)"
                ));
            }
        }
        // A transaction of both programs is one ledger entry: one seq, one signature.
        let mine: BTreeMap<u64, &str> = w.txs.iter().map(|t| (t.seq, t.sig.as_str())).collect();
        for t in &self.txs {
            if let Some(s) = mine.get(&t.seq) {
                if *s != t.signature {
                    why.push(format!(
                        "seq {} is another transaction in the game history (not one feed order)",
                        t.seq
                    ));
                }
            }
        }
        why
    }

    pub fn to_json(&self) -> Value {
        let acc = |a: &Account| fclient::rpc::account_json(a);
        json!({
            "program": self.program.to_string(),
            "history": self.history.to_json().unwrap_or(json!({"source": "fixture"})),
            "after": self.after,
            "through": self.through,
            "tip": self.tip,
            "txs": self.txs.iter().map(|t| json!({
                "seq": t.seq, "signature": t.signature, "ok": t.ok,
                "post": t.post.iter().map(|(k, a)| json!([Address::new_from_array(*k).to_string(), acc(a)])).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "policies": self.policies.iter().map(|(k, a)| json!([Address::new_from_array(*k).to_string(), acc(a)])).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(v: &Value) -> Result<ResidentFeed, String> {
        let keyed = |x: &Value| -> Result<BTreeMap<Key, Account>, String> {
            let mut m = BTreeMap::new();
            for p in x.as_array().ok_or("resident_feed: a key/account list")? {
                let k: Address = p
                    .get(0)
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse().ok())
                    .ok_or("resident_feed: key")?;
                let a = fclient::rpc::parse_account(p.get(1).ok_or("resident_feed: account")?)
                    .map_err(|e| e.to_string())?
                    .ok_or("resident_feed: a null account")?;
                m.insert(k.to_bytes(), a);
            }
            Ok(m)
        };
        let u = |k: &str| {
            v.get(k)
                .and_then(Value::as_u64)
                .ok_or(format!("resident_feed.{k}"))
        };
        let history = match v.get("history") {
            Some(h) if h.get("source").and_then(Value::as_str) == Some("fixture") => {
                History::default()
            }
            h => History::from_json(h),
        };
        Ok(ResidentFeed {
            program: v
                .get("program")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
                .ok_or("resident_feed.program")?,
            history,
            after: u("after")?,
            through: u("through")?,
            tip: v.get("tip").and_then(Value::as_u64),
            txs: v
                .get("txs")
                .and_then(Value::as_array)
                .ok_or("resident_feed.txs")?
                .iter()
                .map(|t| {
                    Ok(ResidentTx {
                        seq: t
                            .get("seq")
                            .and_then(Value::as_u64)
                            .ok_or("resident_feed.txs.seq")?,
                        signature: t
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .into(),
                        ok: t
                            .get("ok")
                            .and_then(Value::as_bool)
                            .ok_or("resident_feed.txs.ok")?,
                        post: keyed(t.get("post").unwrap_or(&json!([])))?,
                    })
                })
                .collect::<Result<_, String>>()?,
            policies: keyed(v.get("policies").unwrap_or(&json!([])))?,
        })
    }
}

/// The resident program's feed from the local node at `url`, read **after**
/// the Frontier transactions `frontier` (so `through` = their last seq), and
/// the policy account at `policy`. Only a local node's ordered feed gives one
/// order for both programs; anything else is refused (V28 stays
/// UNVERIFIABLE without the feed).
pub async fn fetch(
    url: &str,
    resident_program: &Address,
    policy: &Address,
    frontier: &[TxRecord],
) -> Result<ResidentFeed, String> {
    let (txs, history) = crate::input::fetch_txs(url, resident_program, true, None, None).await?;
    let through = frontier.iter().map(|t| t.seq).max().unwrap_or(0);
    // The policy account is one source of the policy (the archive's
    // CreateResidentPolicy is the other): not reading it is not an error.
    let pol = match crate::input::fetch_finals(url, &[*policy]).await {
        Ok((m, _)) => m,
        Err(e) => {
            eprintln!("frontier-verify: the resident policy account: {e}");
            BTreeMap::new()
        }
    };
    // The ledger length, read after the feed (freshness only, see `tip`).
    let tip = fclient::rpc::RpcClient::new(url)
        .call("frontier_status", json!([]))
        .await
        .map_err(|e| e.to_string())?
        .get("transactions")
        .and_then(Value::as_u64);
    Ok(ResidentFeed {
        program: *resident_program,
        // The local node's ledger feed (`fetch_txs` with `localnet`), empty
        // or not: an empty one is the ledger showing no resident transaction.
        history,
        after: 0,
        through,
        tip,
        txs: txs
            .iter()
            .filter(|t| t.seq <= through)
            .map(ResidentTx::of)
            .collect(),
        policies: pol.into_iter().filter_map(|(k, a)| Some((k, a?))).collect(),
    })
}

impl ResidentFeed {
    /// The resident program's feed from its findex archive at `dir` (⑲'s
    /// per-program archive of the local node's feed). [`crate::input::read_archive`]
    /// gives the records their ledger numbers (`feed_seq`) and the history
    /// `ledger <runId>` only when `findex::ledger` finds the archive whole from
    /// the ledger's start; otherwise its history is `unknown` and this feed is
    /// never whole ([`ResidentFeed::gaps_before`]). `through` is the
    /// archive's cursor (`feed_after`): the resident program's last ledger
    /// number read, which can fall short of how far the ledger was scanned
    /// (an act after it stays UNVERIFIABLE; it never claims more).
    pub fn from_archive(
        dir: &std::path::Path,
        program: Address,
        policies: BTreeMap<Key, Account>,
    ) -> Result<ResidentFeed, String> {
        let (txs, history) = crate::input::read_archive(dir)?;
        let a = findex::archive::Archive::open(dir, findex::archive::SEGMENT_BYTES)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        // How far the node's ledger was scanned for the archive
        // (`feed_scanned`, workstream 04), else the program's last seq: the
        // archive was found whole through it (`findex::ledger`).
        let c = a.cursor();
        let through = match history.source {
            Source::LedgerFeed => c
                .get("feed_scanned")
                .and_then(Value::as_u64)
                .or_else(|| c.get("feed_after").and_then(Value::as_u64))
                .unwrap_or(0),
            _ => 0,
        };
        Ok(ResidentFeed {
            program,
            history,
            after: 0,
            through,
            tip: None,
            txs: txs.iter().map(ResidentTx::of).collect(),
            policies,
        })
    }
}

#[cfg(test)]
mod tests {
    //! Literal feeds only: no key pair, no signature, no network.
    use super::*;
    use crate::world::Tx;

    fn tx(seq: u64, sig: &str) -> Tx {
        Tx {
            seq,
            slot: seq,
            time: 0,
            sig: sig.into(),
            ok: true,
            code: None,
            fee_payer: None,
            keys: vec![],
            ixs: vec![],
            recs: vec![],
            post: Default::default(),
            cu_price: 0,
            cu_limit: 0,
            loaded_limit: 0,
        }
    }

    fn feed(history: History, through: u64, seqs: &[(u64, &str)]) -> ResidentFeed {
        ResidentFeed {
            program: Address::new_from_array([0x44; 32]),
            history,
            after: 0,
            through,
            tip: None,
            txs: seqs
                .iter()
                .map(|(s, g)| ResidentTx {
                    seq: *s,
                    signature: (*g).into(),
                    ok: true,
                    post: Default::default(),
                })
                .collect(),
            policies: Default::default(),
        }
    }

    #[test]
    fn one_ledger_order_read_far_enough_is_whole_and_nothing_else_is() {
        let node = History::ledger_feed("local node feed http://127.0.0.1:8899");
        let w = World {
            txs: vec![tx(3, "f3"), tx(9, "both"), tx(12, "f12")],
            ..Default::default()
        };
        // Seqs 5 and 9 are the resident program's; 9 also the game's (same signature).
        let good = feed(node.clone(), 12, &[(5, "r5"), (9, "both")]);
        assert!(good.gaps_before(&w, &node, 12).is_empty());
        assert!(
            good.gaps_before(&w, &node, 13).is_empty(),
            "through 12 covers before 13"
        );
        // A stale copy read through seq 6 is not whole before 12.
        let stale = feed(node.clone(), 6, &[(5, "r5")]);
        assert!(stale.gaps_before(&w, &node, 12)[0].contains("stale copy"));
        assert!(stale.gaps_before(&w, &node, 7).is_empty());
        // Public RPC, a different node, or a fixture beside a node feed: not one order.
        let rpc = History::rpc(json!({"state": "cross_checked"}), "rpc x");
        assert!(!feed(rpc.clone(), 12, &[])
            .gaps_before(&w, &node, 12)
            .is_empty());
        assert!(
            !good.gaps_before(&w, &rpc, 12).is_empty(),
            "the game history unproven"
        );
        let other = History::ledger_feed("local node feed http://other:8899");
        assert!(!feed(other, 12, &[]).gaps_before(&w, &node, 12).is_empty());
        assert!(!feed(History::default(), 12, &[])
            .gaps_before(&w, &node, 12)
            .is_empty());
        // Two fixtures (as given) are one recorded order.
        assert!(feed(History::default(), 12, &[])
            .gaps_before(&w, &History::default(), 12)
            .is_empty());
        // A shared seq that is another transaction, a seq out of range or twice.
        let clash = feed(node.clone(), 12, &[(9, "r9")]);
        assert!(clash.gaps_before(&w, &node, 12)[0].contains("another transaction"));
        assert!(!feed(node.clone(), 12, &[(13, "r13")])
            .gaps_before(&w, &node, 12)
            .is_empty());
        assert!(!feed(node.clone(), 12, &[(5, "a"), (5, "b")])
            .gaps_before(&w, &node, 12)
            .is_empty());
        let mut late = good.clone();
        late.after = 4;
        assert!(!late.gaps_before(&w, &node, 12).is_empty());
        // The ledger length read after the feed: at or past every seq read
        // (freshness only), else the reads are inconsistent.
        let mut fresh = good.clone();
        fresh.tip = Some(12);
        assert!(fresh.gaps_before(&w, &node, 12).is_empty());
        fresh.tip = Some(40);
        assert!(fresh.gaps_before(&w, &node, 12).is_empty());
        fresh.tip = Some(11);
        assert!(fresh.gaps_before(&w, &node, 12)[0].contains("inconsistent read"));
    }

    #[test]
    fn the_fixture_form_round_trips() {
        let mut f = feed(History::ledger_feed("local node feed u"), 7, &[(2, "s2")]);
        f.tip = Some(9);
        f.txs[0].post.insert(
            [0x79; 32],
            Account {
                lamports: 5,
                data: vec![0xc2, 1, 2],
                owner: Address::new_from_array([0x44; 32]),
                executable: false,
            },
        );
        f.policies.insert(
            [0x76; 32],
            Account {
                lamports: 1,
                data: vec![9; 4],
                owner: Address::new_from_array([0x11; 32]),
                executable: false,
            },
        );
        assert_eq!(ResidentFeed::from_json(&f.to_json()).unwrap(), f);
        let g = feed(History::default(), 7, &[]);
        assert_eq!(ResidentFeed::from_json(&g.to_json()).unwrap(), g);
    }
}
