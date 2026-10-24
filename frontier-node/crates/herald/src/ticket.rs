//! The tickets feed (S2 stage 2a, `S2-2A-CONTRACT.md` §4.4): every issue
//! and lot, folded from TICKETS_ISSUED, LOT_MOVED and LOT_CLOSED. A lot's
//! address is seeded by its first holder, so readers find a holder's lots
//! here, not from the holder alone (contract §9, item 2).
//!
//! `h/tickets.json` (live, rewritten when a record changes it):
//!
//! ```json
//! {"v": 1,
//!  "issues": [{"issuerTag": "…", "seq": 0, "kind": 2,
//!    "src": {"kind": 2, "p": 3, "q": 0, "at": 40, "gen": 1, "tile": 40},
//!    "resource": 3, "perUnit": 2000, "untilDay": 4294967295,
//!    "supply": 10, "state": 1, "void": false}],
//!  "lots": [{"key": ["…", 0], "issuerTag": "…", "issueSeq": 0,
//!    "holderTag": "…", "amount": 10, "state": 1, "void": false}]}
//! ```
//!
//! Tags are decimal strings (u64). `void` follows the source's generation:
//! a VAULT_SEIZED or CAPTURE_SETTLED that moves the source to another
//! generation voids its issues and their lots (the rule "a seized vault's
//! tickets are void"). Closed lots and issues leave the feed.

use std::collections::BTreeMap;

use fclient::conquest::{CqEvent, LogPlace};
use permutation_rules::frontier::ticket::{SRC_HOLDING, SRC_VAULT, STATE_LIVE};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssueRow {
    pub kind: u8,
    pub src: LogPlace,
    pub resource: u8,
    pub per_unit: u64,
    pub until_day: u32,
    pub supply: u64,
    pub void: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LotRow {
    pub issuer_tag: u64,
    pub issue_seq: u32,
    pub holder_tag: u64,
    pub amount: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tickets {
    /// `(issuer_tag, seq)` → the live issue.
    pub issues: BTreeMap<(u64, u32), IssueRow>,
    /// `(seed_tag, seq)` → the live lot.
    pub lots: BTreeMap<(u64, u32), LotRow>,
    /// Changed since the file was last written.
    pub dirty: bool,
}

fn place(p: &LogPlace) -> Value {
    json!({"kind": p.kind, "p": p.p, "q": p.q, "at": p.at, "gen": p.gen, "tile": p.tile})
}

fn place_of(v: &Value) -> Option<LogPlace> {
    Some(LogPlace {
        kind: v["kind"].as_u64()? as u8,
        p: v["p"].as_i64()? as i16,
        q: v["q"].as_i64()? as i16,
        at: v["at"].as_u64()? as u8,
        gen: v["gen"].as_u64()? as u8,
        tile: v["tile"].as_u64()? as u8,
    })
}

fn tag_of(v: &Value) -> Option<u64> {
    v.as_str()?.parse().ok()
}

impl Tickets {
    /// Folds one record; `false` for any the feed does not follow.
    pub fn fold(&mut self, ev: &CqEvent) -> bool {
        match *ev {
            CqEvent::TicketsIssued {
                issuer_tag,
                seq,
                kind,
                src,
                resource,
                amount,
                per_unit,
                until_day,
                lot_seq,
                ..
            } => {
                self.issues.insert(
                    (issuer_tag, seq),
                    IssueRow {
                        kind,
                        src,
                        resource,
                        per_unit,
                        until_day,
                        supply: amount,
                        void: false,
                    },
                );
                self.lots.insert(
                    (issuer_tag, lot_seq),
                    LotRow {
                        issuer_tag,
                        issue_seq: seq,
                        holder_tag: issuer_tag,
                        amount,
                    },
                );
            }
            CqEvent::LotMoved {
                issuer_tag,
                seq,
                from,
                recipient_tag,
                to,
                amount,
                whole,
                ..
            } => {
                if whole && to == from {
                    if let Some(l) = self.lots.get_mut(&from) {
                        l.holder_tag = recipient_tag;
                    }
                } else {
                    if let Some(l) = self.lots.get_mut(&from) {
                        l.amount = l.amount.saturating_sub(amount);
                    }
                    self.lots
                        .entry(to)
                        .or_insert(LotRow {
                            issuer_tag,
                            issue_seq: seq,
                            holder_tag: recipient_tag,
                            amount: 0,
                        })
                        .amount += amount;
                }
            }
            CqEvent::LotClosed {
                issuer_tag,
                seq,
                lot,
                amount,
                lot_closed,
                issue_closed,
                ..
            } => {
                if lot_closed {
                    self.lots.remove(&lot);
                    if let Some(i) = self.issues.get_mut(&(issuer_tag, seq)) {
                        i.supply = i.supply.saturating_sub(amount);
                    }
                }
                if issue_closed {
                    self.issues.remove(&(issuer_tag, seq));
                }
            }
            CqEvent::VaultSeized {
                p,
                q,
                tile,
                new_gen,
                ..
            } => return self.regen(SRC_VAULT, p, q, tile, new_gen),
            CqEvent::CaptureSettled {
                p,
                q,
                site,
                new_gen,
                ..
            } => return self.regen(SRC_HOLDING, p, q, site, new_gen),
            _ => return false,
        }
        self.dirty = true;
        true
    }

    /// Voids the issues of the source at `(kind, p, q, at)` that are not of
    /// generation `gen`; `true` when one changed.
    fn regen(&mut self, kind: u8, p: i32, q: i32, at: u8, gen: u8) -> bool {
        let mut hit = false;
        for i in self.issues.values_mut() {
            let s = &i.src;
            if s.kind == kind && (s.p as i32, s.q as i32, s.at) == (p, q, at) && s.gen != gen {
                hit |= !i.void;
                i.void = true;
            }
        }
        self.dirty |= hit;
        hit
    }

    fn lot_void(&self, l: &LotRow) -> bool {
        self.issues
            .get(&(l.issuer_tag, l.issue_seq))
            .is_none_or(|i| i.void)
    }

    /// `h/tickets.json`.
    pub fn file(&self) -> Value {
        let issues: Vec<Value> = self
            .issues
            .iter()
            .map(|((tag, seq), i)| {
                json!({"issuerTag": tag.to_string(), "seq": seq, "kind": i.kind,
                    "src": place(&i.src), "resource": i.resource, "perUnit": i.per_unit,
                    "untilDay": i.until_day, "supply": i.supply, "state": STATE_LIVE,
                    "void": i.void})
            })
            .collect();
        let lots: Vec<Value> = self
            .lots
            .iter()
            .map(|((tag, seq), l)| {
                json!({"key": [tag.to_string(), seq], "issuerTag": l.issuer_tag.to_string(),
                    "issueSeq": l.issue_seq, "holderTag": l.holder_tag.to_string(),
                    "amount": l.amount, "state": STATE_LIVE, "void": self.lot_void(l)})
            })
            .collect();
        json!({"v": 1, "issues": issues, "lots": lots})
    }

    /// The checkpoint form (the file's).
    pub fn to_json(&self) -> Value {
        self.file()
    }

    /// The inverse of [`Tickets::to_json`] (`None` when damaged).
    pub fn from_json(v: &Value) -> Option<Tickets> {
        let mut t = Tickets::default();
        for x in v.get("issues")?.as_array()? {
            t.issues.insert(
                (tag_of(&x["issuerTag"])?, x["seq"].as_u64()? as u32),
                IssueRow {
                    kind: x["kind"].as_u64()? as u8,
                    src: place_of(&x["src"])?,
                    resource: x["resource"].as_u64()? as u8,
                    per_unit: x["perUnit"].as_u64()?,
                    until_day: x["untilDay"].as_u64()? as u32,
                    supply: x["supply"].as_u64()?,
                    void: x["void"].as_bool()?,
                },
            );
        }
        for x in v.get("lots")?.as_array()? {
            let k = x["key"].as_array()?;
            t.lots.insert(
                (tag_of(k.first()?)?, k.get(1)?.as_u64()? as u32),
                LotRow {
                    issuer_tag: tag_of(&x["issuerTag"])?,
                    issue_seq: x["issueSeq"].as_u64()? as u32,
                    holder_tag: tag_of(&x["holderTag"])?,
                    amount: x["amount"].as_u64()?,
                },
            );
        }
        Some(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_src(gen: u8) -> LogPlace {
        LogPlace {
            kind: SRC_VAULT,
            p: 3,
            q: 0,
            at: 40,
            gen,
            tile: 40,
        }
    }

    fn issued() -> CqEvent {
        CqEvent::TicketsIssued {
            issuer_tag: 11,
            seq: 0,
            kind: 2,
            src: vault_src(1),
            resource: 3,
            amount: 10,
            per_unit: 2_000,
            until_day: u32::MAX,
            lot_seq: 0,
            holding_key: 0,
        }
    }

    fn moved(to: (u64, u32), amount: u64, whole: bool) -> CqEvent {
        CqEvent::LotMoved {
            issuer_tag: 11,
            seq: 0,
            giver_tag: 11,
            from: (11, 0),
            recipient_tag: 22,
            to,
            amount,
            whole,
            new_lot: to != (11, 0),
        }
    }

    /// An issue, a split and a seizure: the lots follow the moves, the
    /// seizure voids both, and a void lot's close frees the supply.
    #[test]
    fn the_feed_folds() {
        let mut t = Tickets::default();
        assert!(t.fold(&issued()));
        assert!(t.fold(&moved((11, 1), 4, false)));
        assert_eq!(t.lots[&(11, 0)].amount, 6);
        assert_eq!(t.lots[&(11, 1)].holder_tag, 22);
        assert!(!t.fold(&CqEvent::VaultSeized {
            p: 3,
            q: 0,
            tile: 40,
            captor_tag: 33,
            prev_tag: 11,
            domestic: false,
            host_id: 0,
            new_gen: 1,
        }));
        assert!(t.fold(&CqEvent::VaultSeized {
            p: 3,
            q: 0,
            tile: 40,
            captor_tag: 33,
            prev_tag: 11,
            domestic: false,
            host_id: 0,
            new_gen: 2,
        }));
        let f = t.file();
        assert_eq!(f["issues"][0]["void"], json!(true));
        assert_eq!(f["lots"][1]["void"], json!(true));
        assert!(t.fold(&CqEvent::LotClosed {
            issuer_tag: 11,
            seq: 0,
            closer_tag: 22,
            lot: (11, 1),
            amount: 4,
            void: true,
            lot_closed: true,
            issue_closed: false,
            shares_cleared: false,
        }));
        assert_eq!(t.issues[&(11, 0)].supply, 6);
        let mut back = Tickets::from_json(&t.to_json()).unwrap();
        back.dirty = t.dirty;
        assert_eq!(back, t);
    }

    /// A whole-lot gift keeps the lot and changes its holder.
    #[test]
    fn a_whole_gift_moves_the_holder() {
        let mut t = Tickets::default();
        t.fold(&issued());
        t.fold(&moved((11, 0), 10, true));
        assert_eq!(t.lots.len(), 1);
        assert_eq!(t.lots[&(11, 0)].holder_tag, 22);
        assert_eq!(t.lots[&(11, 0)].amount, 10);
    }
}
