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
//! tickets are void"). Closed lots and issues leave the feed. Receipts (2c):
//! a lot's `claimDay` and `claim` (milli still to withdraw; null before its
//! first claim) follow RECEIPT_CLAIMED and RECEIPT_WITHDRAWN, an issue's
//! `ratioPpm` and `ratioDay` its last withdrawal; a use lot's `runDay` and
//! `runs` (2d) its runs of its last run day (USE_RUN; a gift moves used
//! runs with the units, as the program does). Share issues
//! (2b, kind 1) follow SHARES_OPENED, SHARES_DEPOSITED (a holder's deposit
//! lot, created at its first deposit) and SHARES_WITHDRAWN. Escrows (2e):
//! `escrows` lists each open or settled escrow (its two items, the goods
//! still `owed` per side) from ESCROW_OPENED until its CANCELLED or last
//! WITHDRAWN; a swap moves the lots' holders.

use std::collections::BTreeMap;

use fclient::conquest::{CqEvent, LogPlace};
use permutation_rules::frontier::ticket::{KIND_SHARE, NO_END, SRC_HOLDING, SRC_VAULT, STATE_LIVE};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IssueRow {
    /// 2c: the last withdrawal's ratio (parts per million) and its day.
    pub ratio: Option<(u32, u32)>,
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
    /// 2c: the day of the lot's last claim and its milli still to withdraw.
    pub claim: Option<(u32, u64)>,
    /// 2d: the day of the lot's last use run and its runs used that day.
    pub runs: Option<(u32, u64)>,
    pub issuer_tag: u64,
    pub issue_seq: u32,
    pub holder_tag: u64,
    pub amount: u64,
}

/// 2e: an escrow in the feed (open, or settled with goods owed).
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowRow {
    pub taker_tag: u64,
    pub deadline_bell: u32,
    /// 1 open, 2 settled.
    pub state: u8,
    /// The maker's item: kind (1 goods, 2 lot), amount, lot, goods' vault.
    pub give_kind: u8,
    pub give_amount: u64,
    pub give_lot: (u64, u32),
    pub give_src: LogPlace,
    /// The taker's item as wanted (goods: kind 1 and the milli).
    pub want_kind: u8,
    pub want_amount: u64,
    pub want_lot: (u64, u32),
    /// The rent's payee (base58 in the feed).
    pub rent_to: [u8; 32],
    /// The goods' resources (0 for a lot).
    pub give_resource: u8,
    pub want_resource: u8,
    /// The taker's goods' vault once settled.
    pub take_src: Option<LogPlace>,
    /// Goods still owed, per side (0 the maker's, 1 the taker's).
    pub owed: [bool; 2],
    /// A goods side whose vault moved to another generation (void: the
    /// escrow can then be closed by a party).
    pub void_sides: [bool; 2],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tickets {
    /// `(issuer_tag, seq)` → the live issue.
    pub issues: BTreeMap<(u64, u32), IssueRow>,
    /// `(seed_tag, seq)` → the live lot.
    pub lots: BTreeMap<(u64, u32), LotRow>,
    /// 2e: `(maker_tag, seq)` → the escrow until it closes.
    pub escrows: BTreeMap<(u64, u32), EscrowRow>,
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
                        ratio: None,
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
                        claim: None,
                        runs: None,
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
                    // 2c: units of a lot that claimed carry its claim day
                    // (nothing to withdraw), so a split-off lot of today's
                    // claimant reads "claimed today" as the program has it.
                    // 2d: runs used on the lot's last run day travel with
                    // the units, as many as they carry (the program's rule
                    // for today; an older day's runs are spent anyway).
                    let per_unit = self.issues.get(&(issuer_tag, seq)).map_or(0, |i| i.per_unit);
                    let (mut day, mut moved) = (None, None);
                    if let Some(l) = self.lots.get_mut(&from) {
                        l.amount = l.amount.saturating_sub(amount);
                        day = l.claim.map(|c| (c.0, 0));
                        if let Some((d, used)) = l.runs {
                            let m = used.min(amount.saturating_mul(per_unit));
                            l.runs = Some((d, used - m));
                            moved = Some((d, m));
                        }
                    }
                    let row = self.lots.entry(to).or_insert(LotRow {
                        claim: day,
                        runs: None,
                        issuer_tag,
                        issue_seq: seq,
                        holder_tag: recipient_tag,
                        amount: 0,
                    });
                    row.amount += amount;
                    // Never over a newer day the recipient already ran.
                    if let Some((d, m)) = moved.filter(|&(_, m)| m > 0) {
                        row.runs = match row.runs {
                            Some((rd, ru)) if rd == d => Some((d, ru + m)),
                            Some((rd, ru)) if rd > d => Some((rd, ru)),
                            _ => Some((d, m)),
                        };
                    }
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
            // 2b: a share issue and the opener's deposit lot.
            CqEvent::SharesOpened {
                issuer_tag,
                seq,
                src,
                supply,
                lot_seq,
                ..
            } => {
                self.issues.insert(
                    (issuer_tag, seq),
                    IssueRow {
                        ratio: None,
                        kind: KIND_SHARE,
                        src,
                        resource: 0,
                        per_unit: 0,
                        until_day: NO_END,
                        supply,
                        void: false,
                    },
                );
                self.lots.insert(
                    (issuer_tag, lot_seq),
                    LotRow {
                        claim: None,
                        runs: None,
                        issuer_tag,
                        issue_seq: seq,
                        holder_tag: issuer_tag,
                        amount: supply,
                    },
                );
            }
            CqEvent::SharesDeposited {
                issuer_tag,
                seq,
                holder_tag,
                lot_seq,
                minted,
                supply,
                ..
            } => {
                let l = self.lots.entry((holder_tag, lot_seq)).or_insert(LotRow {
                    claim: None,
                        runs: None,
                    issuer_tag,
                    issue_seq: seq,
                    holder_tag,
                    amount: 0,
                });
                if (l.issuer_tag, l.issue_seq) == (issuer_tag, seq) {
                    l.amount = l.amount.saturating_add(minted);
                }
                if let Some(i) = self.issues.get_mut(&(issuer_tag, seq)) {
                    i.supply = supply;
                }
            }
            CqEvent::SharesWithdrawn {
                issuer_tag,
                seq,
                lot,
                amount,
                supply,
                ..
            } => {
                if let Some(l) = self.lots.get_mut(&lot) {
                    l.amount = l.amount.saturating_sub(amount);
                }
                if let Some(i) = self.issues.get_mut(&(issuer_tag, seq)) {
                    i.supply = supply;
                }
            }
            // 2c: a day's claim, and its withdrawal at the day's ratio.
            CqEvent::ReceiptClaimed {
                lot, day, claim, ..
            } => {
                if let Some(l) = self.lots.get_mut(&lot) {
                    l.claim = Some((day, claim));
                }
            }
            CqEvent::ReceiptWithdrawn {
                issuer_tag,
                seq,
                lot,
                day,
                ratio_ppm,
                ..
            } => {
                if let Some(l) = self.lots.get_mut(&lot) {
                    l.claim = Some((day, 0));
                }
                if let Some(i) = self.issues.get_mut(&(issuer_tag, seq)) {
                    i.ratio = Some((ratio_ppm, day + 1));
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
            // 2e: escrows; a swap rewrites the lots' holders in place.
            CqEvent::EscrowOpened {
                maker_tag,
                seq,
                taker_tag,
                deadline_bell,
                give_kind,
                give_amount,
                lot,
                src,
                want_kind,
                want_amount,
                want_lot,
                rent_to,
                give_resource,
                want_resource,
            } => {
                self.escrows.insert(
                    (maker_tag, seq),
                    EscrowRow {
                        taker_tag,
                        deadline_bell,
                        state: 1,
                        give_kind,
                        give_amount,
                        give_lot: lot,
                        give_src: src,
                        want_kind,
                        want_amount,
                        want_lot,
                        rent_to,
                        give_resource,
                        want_resource,
                        take_src: None,
                        owed: [false; 2],
                        void_sides: [false; 2],
                    },
                );
            }
            CqEvent::EscrowSettled {
                maker_tag,
                seq,
                taker_tag,
                maker_kind,
                taker_kind,
                maker_lot,
                taker_lot,
                src,
                ..
            } => {
                if maker_kind == 2 {
                    if let Some(l) = self.lots.get_mut(&maker_lot) {
                        l.holder_tag = taker_tag;
                    }
                }
                if taker_kind == 2 {
                    if let Some(l) = self.lots.get_mut(&taker_lot) {
                        l.holder_tag = maker_tag;
                    }
                }
                if let Some(e) = self.escrows.get_mut(&(maker_tag, seq)) {
                    e.state = 2;
                    e.owed = [maker_kind == 1, taker_kind == 1];
                    e.take_src = (taker_kind == 1).then_some(src);
                }
            }
            CqEvent::EscrowCancelled { maker_tag, seq, .. } => {
                self.escrows.remove(&(maker_tag, seq));
            }
            CqEvent::EscrowWithdrawn {
                maker_tag,
                seq,
                side,
                closed,
                ..
            } => {
                if closed {
                    self.escrows.remove(&(maker_tag, seq));
                } else if let Some(e) = self.escrows.get_mut(&(maker_tag, seq)) {
                    e.owed[(side as usize).min(1)] = false;
                }
            }
            // 2d: a lot's runs of the day.
            CqEvent::UseRun {
                lot, day, lot_runs, ..
            } => {
                if let Some(l) = self.lots.get_mut(&lot) {
                    l.runs = Some((day, lot_runs as u64));
                }
            }
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
        // 2e: goods held in that vault in another generation are void.
        for e in self.escrows.values_mut() {
            let goods = [(e.give_kind == 1).then_some(e.give_src), e.take_src];
            for (side, src) in goods.iter().enumerate() {
                if let Some(s) = src {
                    if s.kind == kind && (s.p as i32, s.q as i32, s.at) == (p, q, at) && s.gen != gen {
                        hit |= !e.void_sides[side];
                        e.void_sides[side] = true;
                    }
                }
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
                    "void": i.void, "ratioPpm": i.ratio.map(|r| r.0), "ratioDay": i.ratio.map(|r| r.1)})
            })
            .collect();
        let lots: Vec<Value> = self
            .lots
            .iter()
            .map(|((tag, seq), l)| {
                json!({"key": [tag.to_string(), seq], "issuerTag": l.issuer_tag.to_string(),
                    "issueSeq": l.issue_seq, "holderTag": l.holder_tag.to_string(),
                    "amount": l.amount, "state": STATE_LIVE, "void": self.lot_void(l),
                    "claimDay": l.claim.map(|c| c.0), "claim": l.claim.map(|c| c.1),
                    "runDay": l.runs.map(|r| r.0), "runs": l.runs.map(|r| r.1)})
            })
            .collect();
        let escrows: Vec<Value> = self
            .escrows
            .iter()
            .map(|((tag, seq), e)| {
                json!({"makerTag": tag.to_string(), "seq": seq, "takerTag": e.taker_tag.to_string(),
                    "deadlineBell": e.deadline_bell, "state": e.state, "giveKind": e.give_kind,
                    "giveAmount": e.give_amount, "giveLot": [e.give_lot.0.to_string(), e.give_lot.1],
                    "giveSrc": place(&e.give_src), "wantKind": e.want_kind, "wantAmount": e.want_amount,
                    "wantLot": [e.want_lot.0.to_string(), e.want_lot.1],
                    "rentTo": fclient::Address::new_from_array(e.rent_to).to_string(),
                    "giveResource": e.give_resource, "wantResource": e.want_resource,
                    "takeSrc": e.take_src.as_ref().map(place), "owed": e.owed,
                    "voidSides": e.void_sides})
            })
            .collect();
        json!({"v": 1, "issues": issues, "lots": lots, "escrows": escrows})
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
                    ratio: match (x["ratioPpm"].as_u64(), x["ratioDay"].as_u64()) {
                        (Some(r), Some(d)) => Some((r as u32, d as u32)),
                        _ => None,
                    },
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
                    claim: match (x["claimDay"].as_u64(), x["claim"].as_u64()) {
                        (Some(d), Some(c)) => Some((d as u32, c)),
                        _ => None,
                    },
                    runs: match (x["runDay"].as_u64(), x["runs"].as_u64()) {
                        (Some(d), Some(r)) => Some((d as u32, r)),
                        _ => None,
                    },
                    issuer_tag: tag_of(&x["issuerTag"])?,
                    issue_seq: x["issueSeq"].as_u64()? as u32,
                    holder_tag: tag_of(&x["holderTag"])?,
                    amount: x["amount"].as_u64()?,
                },
            );
        }
        // 2e (absent from older checkpoints).
        for x in v.get("escrows").and_then(|e| e.as_array()).into_iter().flatten() {
            let gl = x["giveLot"].as_array()?;
            let owed = x["owed"].as_array()?;
            t.escrows.insert(
                (tag_of(&x["makerTag"])?, x["seq"].as_u64()? as u32),
                EscrowRow {
                    taker_tag: tag_of(&x["takerTag"])?,
                    deadline_bell: x["deadlineBell"].as_u64()? as u32,
                    state: x["state"].as_u64()? as u8,
                    give_kind: x["giveKind"].as_u64()? as u8,
                    give_amount: x["giveAmount"].as_u64()?,
                    give_lot: (tag_of(gl.first()?)?, gl.get(1)?.as_u64()? as u32),
                    give_src: place_of(&x["giveSrc"])?,
                    want_kind: x["wantKind"].as_u64()? as u8,
                    want_amount: x["wantAmount"].as_u64()?,
                    want_lot: {
                        let w = x["wantLot"].as_array()?;
                        (tag_of(w.first()?)?, w.get(1)?.as_u64()? as u32)
                    },
                    rent_to: x["rentTo"].as_str()?.parse::<fclient::Address>().ok()?.to_bytes(),
                    give_resource: x["giveResource"].as_u64()? as u8,
                    want_resource: x["wantResource"].as_u64()? as u8,
                    take_src: if x["takeSrc"].is_null() { None } else { Some(place_of(&x["takeSrc"])?) },
                    owed: [owed.first()?.as_bool()?, owed.get(1)?.as_bool()?],
                    void_sides: match x["voidSides"].as_array() {
                        Some(v) => [v.first()?.as_bool()?, v.get(1)?.as_bool()?],
                        None => [false; 2],
                    },
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
            src: vault_src(1),
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

    /// 2b: opened, a deposit by another (a new deposit lot), a withdrawal.
    #[test]
    fn shares_fold() {
        let mut t = Tickets::default();
        assert!(t.fold(&CqEvent::SharesOpened {
            issuer_tag: 11,
            seq: 0,
            src: vault_src(1),
            supply: 100,
            lot_seq: 0x8000_0001,
            holding_key: 0,
        }));
        assert!(t.fold(&CqEvent::SharesDeposited {
            issuer_tag: 11,
            seq: 0,
            holder_tag: 22,
            lot_seq: 0x8000_0001,
            value: 100,
            minted: 100,
            supply: 200,
            caravan: (22, 0),
            new_lot: true,
        }));
        assert_eq!(t.lots[&(22, 0x8000_0001)].amount, 100);
        assert!(t.fold(&CqEvent::SharesWithdrawn {
            issuer_tag: 11,
            seq: 0,
            holder_tag: 22,
            lot: (22, 0x8000_0001),
            amount: 40,
            supply: 160,
            caravan_seq: 1,
        }));
        assert_eq!(t.lots[&(22, 0x8000_0001)].amount, 60);
        assert_eq!(t.issues[&(11, 0)].supply, 160);
        assert_eq!(t.file()["issues"][0]["kind"], json!(1));
    }

    /// 2c: a claim and its withdrawal.
    #[test]
    fn receipts_fold() {
        let mut t = Tickets::default();
        t.fold(&issued());
        assert!(t.fold(&CqEvent::ReceiptClaimed {
            issuer_tag: 11,
            seq: 0,
            holder_tag: 11,
            lot: (11, 0),
            day: 4,
            claim: 20_000,
            claims: 20_000,
            src: vault_src(1),
        }));
        assert_eq!(t.lots[&(11, 0)].claim, Some((4, 20_000)));
        assert!(t.fold(&CqEvent::ReceiptWithdrawn {
            issuer_tag: 11,
            seq: 0,
            holder_tag: 11,
            lot: (11, 0),
            day: 4,
            claim: 20_000,
            ratio_ppm: 750_000,
            grant: 15_000,
            caravan_seq: 0,
        }));
        let f = t.file();
        assert_eq!(f["lots"][0]["claim"], json!(0));
        assert_eq!(f["issues"][0]["ratioPpm"], json!(750_000));
        let mut back = Tickets::from_json(&t.to_json()).unwrap();
        back.dirty = t.dirty;
        assert_eq!(back, t);
    }

    /// 2d: a use lot's runs, and a gift that carries used runs.
    #[test]
    fn use_runs_fold() {
        let mut t = Tickets::default();
        t.fold(&issued());
        t.issues.get_mut(&(11, 0)).unwrap().per_unit = 2;
        assert!(t.fold(&CqEvent::UseRun {
            issuer_tag: 11,
            seq: 0,
            holder_tag: 11,
            lot: (11, 0),
            day: 4,
            runs: 5,
            lot_runs: 5,
            holding_runs: 5,
            holding_key: 0,
            src: vault_src(1),
        }));
        assert_eq!(t.lots[&(11, 0)].runs, Some((4, 5)));
        // 2 units carry 4 of the 5 used runs.
        t.fold(&moved((22, 0), 2, false));
        assert_eq!(t.lots[&(11, 0)].runs, Some((4, 1)));
        assert_eq!(t.lots[&(22, 0)].runs, Some((4, 4)));
        let f = t.file();
        assert_eq!(f["lots"][1]["runs"], json!(4));
        let mut back = Tickets::from_json(&t.to_json()).unwrap();
        back.dirty = t.dirty;
        assert_eq!(back, t);
    }


    /// 2e: an escrow opened, settled (a lot for goods), collected.
    #[test]
    fn escrows_fold() {
        let mut t = Tickets::default();
        t.fold(&issued());
        assert!(t.fold(&CqEvent::EscrowOpened {
            maker_tag: 22,
            seq: 3,
            taker_tag: 11,
            deadline_bell: 90,
            give_kind: 1,
            give_amount: 50_000,
            lot: (0, 0),
            src: vault_src(1),
            want_kind: 2,
            want_amount: 0,
            want_lot: (11, 0),
            rent_to: [7; 32],
            give_resource: 3,
            want_resource: 0,
        }));
        assert!(t.fold(&CqEvent::EscrowSettled {
            maker_tag: 22,
            seq: 3,
            taker_tag: 11,
            maker_kind: 1,
            taker_kind: 2,
            maker_lot: (0, 0),
            taker_lot: (11, 0),
            src: LogPlace { kind: 0, p: 0, q: 0, at: 0, gen: 0, tile: 0 },
            closed: false,
        }));
        assert_eq!(t.lots[&(11, 0)].holder_tag, 22);
        assert_eq!(t.escrows[&(22, 3)].owed, [true, false]);
        // A seizure of the maker's vault voids its owed goods.
        let mut v = t.clone();
        v.regen(SRC_VAULT, 3, 0, 40, 2);
        assert_eq!(v.escrows[&(22, 3)].void_sides, [true, false]);
        let f = t.file();
        assert_eq!(f["escrows"][0]["state"], json!(2));
        let mut back = Tickets::from_json(&t.to_json()).unwrap();
        back.dirty = t.dirty;
        assert_eq!(back, t);
        assert!(t.fold(&CqEvent::EscrowWithdrawn {
            maker_tag: 22,
            seq: 3,
            receiver_tag: 11,
            side: 0,
            amount: 50_000,
            caravan_seq: 0,
            closed: true,
        }));
        assert!(t.escrows.is_empty());
    }

}
