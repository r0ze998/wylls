//! Ingest backends (offchain design §4.1, §4.3): where the ordered stream of
//! program transactions comes from.
//!
//! - [`LocalnetFeed`] reads any [`ChainPort`]'s `feed` — `frontier_feed` on
//!   the local chain node, the transaction vector in process — with its
//!   post-state of written accounts.
//! - [`RpcPoll`] pages `getSignaturesForAddress(program)` back to the last
//!   signature it saw (`until`), then fetches each new transaction with
//!   `getTransaction`, oldest first. A public RPC gives no post-state, so
//!   snapshots and link addresses come from the logs alone. It stops at a
//!   transaction the node cannot return yet and resumes there next time.
//!   It also stops at a signature it has seen, so a server that ignores
//!   `until` still terminates; a server that ignores `before` (as the
//!   W1 local node MVP did; W2-C's node honours it) is detected when it serves a page twice and the pull fails
//!   with `Unsupported` rather than archive a gap — such a server must be
//!   polled before one page (≤ 1,000 transactions) fills. A public RPC
//!   prunes its history: once a node no longer holds the last signature
//!   archived, `until` matches nothing and the node answers with what it
//!   has. Each pull therefore checks continuity before returning anything:
//!   the signatures just older than the oldest new one must reach the last
//!   archived signature through already-archived ones only, else the pull
//!   fails with `Unavailable("history gap …")` and archives nothing (a
//!   node with longer history must serve it; see
//!   `docs/frontier/er-candidate/RECOVERY.ja.md`).
//!
//!   **Passing the check does not prove a complete history**, and an
//!   archive without a record is no evidence that something did not happen.
//!   Alone it cannot see a gap (G1) on the first pull (no cursor), or (G3)
//!   on a node that still holds the last archived signature but lacks a
//!   range in the middle (its local ledger and long-term storage disagree).
//!   A cursor that is missing or unreadable while the archive holds records
//!   (G2) is refused rather than taken for a first pull.
//!
//!   [`RpcPoll::coverage`] says which of these holds for what was archived
//!   (`/h/status` shows it): `not_fetched` (nothing archived: not an empty
//!   history), `gap` (a missing range was detected; pulls stop and archive
//!   nothing), `unverifiable` (a range was archived that nothing checked,
//!   with the reasons) or `cross_checked`. Two optional checks narrow the
//!   unverifiable part: an **origin** anchor (the program's first
//!   signature, which a first pull must reach: G1) and a **witness** node
//!   (a second RPC endpoint whose signatures between the archive's last
//!   one and the new batch must all be in the batch: G3). Neither proves
//!   completeness: a witness backed by the same storage misses the same
//!   range, and nothing here checks what a signature's transaction says.

use std::collections::{HashSet, VecDeque};
use std::future::Future;

use serde_json::{json, Value};
use solana_address::Address;

use fclient::ports::{ChainPort, Cursor, PortError, PortResult, Signature, TxRecord};
use fclient::rpc::{RpcClient, SigInfo};

/// A source of program transactions in feed order.
pub trait Source: Send {
    /// Transactions after the cursor, oldest first; advances the cursor.
    fn pull(&mut self) -> impl Future<Output = PortResult<Vec<TxRecord>>> + Send;
    /// The cursor to store with the archived batch.
    fn cursor(&self) -> Value;
    /// Replaces the current cursor with a stored one. A wrapper may restore
    /// its previous cursor when a pull fails before the batch is archived.
    fn restore(&mut self, v: &Value);
    /// What the archived history covers and how far that was checked
    /// ([`RpcPoll::coverage`]); `None` for a source that cannot miss part
    /// of its history (an ordered feed).
    fn coverage(&self) -> Option<Value> {
        None
    }
    /// Whether each record's `seq` is the source's own ledger number, to
    /// keep in the archive as `feed_seq` (an ordered feed: [`LocalnetFeed`]).
    fn ledger_seq(&self) -> bool {
        false
    }
}

/// The local node's (or the in-process chain's) ordered feed.
///
/// Its records' `seq` is the node's ledger number (one numbering over every
/// landed transaction, the feed filtered by program), kept in the archive as
/// `feed_seq`. The cursor also says where the archived feed started
/// (`feed_start`: 0 is the ledger's start; absent in cursors written before
/// it was kept) and which ledger it is (`ledger`: the node's
/// `frontier_status.runId`, kept across restarts and new for a new ledger;
/// set with [`LocalnetFeed::with_ledger`]). Resuming a cursor of another
/// ledger, or a cursor that is not this feed's, is refused (every pull
/// fails) instead of numbering on from a seq that means something else.
/// `findex::ledger` joins archives of one ledger and says when they are not
/// the whole history.
pub struct LocalnetFeed<P: ChainPort> {
    pub port: P,
    pub after: Cursor,
    /// The ledger the node serves now (`runId`), if known.
    pub ledger: Option<String>,
    /// The node's ledger size (`ledgerBytes`) seen when this feed started:
    /// kept in the cursor (the largest seen), so a later check sees a ledger
    /// that shrank (`findex::ledger::check_node`).
    pub ledger_bytes: Option<u64>,
    /// The program the feed is filtered by: every record handed back must
    /// mention it (a node that does not read the filter answers with every
    /// program's transactions). `None`: not checked.
    pub program: Option<solana_address::Address>,
    /// The last archived record (`seq`, signature): on resume the node must
    /// still hold it there, else its ledger was rewound or rebuilt.
    last: Option<(u64, Signature)>,
    check_last: bool,
    /// Where the archived feed started (`None`: not known).
    start: Option<u64>,
    /// The ledger the archived records came from (`None`: not known).
    cursor_ledger: Option<String>,
    refused: Option<String>,
    /// How far the node's ledger was scanned for this archive
    /// (`frontier_feed`'s `scannedThrough`, workstream 04): every ledger entry
    /// up to it was examined, so the archive is this program's whole feed
    /// through it. `None`: not known (a node without the scan, or a pull that
    /// was not scanned throughout); then only `after` is.
    scanned: Option<u64>,
    /// Whether the node said its ledger is synced before it serves it.
    durable: Option<bool>,
}

impl<P: ChainPort> LocalnetFeed<P> {
    pub fn new(port: P) -> Self {
        LocalnetFeed {
            port,
            after: Cursor(0),
            ledger: None,
            ledger_bytes: None,
            program: None,
            last: None,
            check_last: false,
            start: Some(0),
            cursor_ledger: None,
            refused: None,
            scanned: None,
            durable: None,
        }
    }

    /// The node's ledger size now (`frontier_status.ledgerBytes`).
    pub fn with_ledger_bytes(mut self, bytes: u64) -> Self {
        self.ledger_bytes = Some(self.ledger_bytes.map_or(bytes, |b| b.max(bytes)));
        self
    }

    /// Checks that every record mentions `program` (the feed's filter).
    pub fn with_program(mut self, program: solana_address::Address) -> Self {
        self.program = Some(program);
        self
    }

    /// One read's scan against what the archive already holds (workstream
    /// 04, 2026-11-07). Refused (a history gap, never resumed over):
    /// another ledger than the archive's; a ledger shorter than the cursor; a
    /// different transaction (or none) at the cursor's seq than the one
    /// archived there; a ledger that shrank in bytes. A scan that does not
    /// say a value checks nothing about it.
    fn check_scan(
        &mut self,
        sc: &fclient::ports::FeedScan,
        known: Option<(u64, Signature)>,
    ) -> Result<(), String> {
        let after = self.after.0;
        if let Some(id) = &sc.run_id {
            let ours = self.cursor_ledger.as_ref().or(self.ledger.as_ref());
            match ours {
                Some(o) if o != id => {
                    return Err(format!(
                        "history gap: the node now serves ledger {id}, the archive is of ledger {o}"
                    ))
                }
                Some(_) => {}
                None if after == 0 && self.start == Some(0) => {
                    self.cursor_ledger = Some(id.clone());
                }
                None => {}
            }
            self.ledger.get_or_insert_with(|| id.clone());
        }
        if sc.ledger_len < after || sc.scanned_through < after {
            return Err(format!(
                "history gap: the ledger has {} entries, fewer than the archive's cursor {after}: rewound or rebuilt",
                sc.ledger_len
            ));
        }
        if let Some((seq, s)) = known.filter(|(q, _)| *q == after && after > 0) {
            if sc.at_after != Some(s) {
                return Err(format!(
                    "history gap: ledger seq {seq} is {} now, the archive holds {s} there: rewound or rebuilt",
                    sc.at_after.map_or("nothing".into(), |x| x.to_string())
                ));
            }
        }
        if let (Some(prev), Some(now)) = (self.ledger_bytes, sc.ledger_bytes) {
            if now < prev {
                return Err(format!(
                    "history gap: the ledger shrank from {prev} to {now} bytes: rewound"
                ));
            }
        }
        if let Some(now) = sc.ledger_bytes {
            self.ledger_bytes = Some(self.ledger_bytes.map_or(now, |m| m.max(now)));
        }
        if sc.durable.is_some() {
            self.durable = sc.durable;
        }
        Ok(())
    }

    /// The ledger the node serves (`frontier_status.runId`).
    pub fn with_ledger(mut self, run_id: impl Into<String>) -> Self {
        let id = run_id.into();
        if self.after.0 == 0 && self.start == Some(0) {
            self.cursor_ledger = Some(id.clone());
        }
        self.ledger = Some(id);
        self
    }
}

impl<P: ChainPort> Source for LocalnetFeed<P> {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        if let Some(r) = &self.refused {
            return Err(PortError::Unavailable(r.clone()));
        }
        if self.check_last {
            // The archive's last record must still be at its seq: a ledger
            // rewound (its tail lost without fsync) or rebuilt numbers other
            // transactions there, under the same runId in the first case.
            if let Some((seq, s)) = self.last {
                let got = self.port.feed(Cursor(seq.saturating_sub(1))).await?;
                match got.first() {
                    Some(r) if r.seq == seq && r.signature == s => {}
                    other => {
                        return Err(PortError::Unavailable(format!(
                            "history gap: the ledger no longer holds the archive's last transaction {s} at seq {seq} (it has {}): rewound or rebuilt",
                            other.map_or("nothing there".into(), |r| format!("{} at seq {}", r.signature, r.seq))
                        )))
                    }
                }
            }
            self.check_last = false;
        }
        let mut out: Vec<TxRecord> = vec![];
        // The extent of this pull: known only when every read said it.
        let mut scanned: Option<Option<u64>> = None;
        loop {
            let (got, scan) = self.port.feed_scan(self.after).await?;
            match &scan {
                Some(sc) => {
                    let known = out.last().map(|r| (r.seq, r.signature)).or(self.last);
                    if let Err(e) = self.check_scan(sc, known) {
                        self.refused = Some(e.clone());
                        return Err(PortError::Unavailable(e));
                    }
                    scanned = Some(match scanned {
                        Some(None) => None,
                        _ => Some(sc.scanned_through),
                    });
                }
                None => scanned = Some(None),
            }
            let Some(last) = got.last() else { break };
            for r in &got {
                if out.last().map_or(self.after.0, |p| p.seq) >= r.seq {
                    return Err(PortError::Decode(format!(
                        "feed: seq {} does not follow {}",
                        r.seq,
                        out.last().map_or(self.after.0, |p| p.seq)
                    )));
                }
                if let Some(p) = &self.program {
                    let mentions =
                        fclient::tx::from_wire(&r.tx).map(|t| t.message.account_keys.contains(p));
                    if mentions != Ok(true) {
                        return Err(PortError::Decode(format!(
                            "feed: seq {} ({}) does not mention the program {p}: the node did not filter the feed",
                            r.seq, r.signature
                        )));
                    }
                }
                out.push(r.clone());
            }
            self.after = Cursor(last.seq);
        }
        if let Some(r) = out.last() {
            self.last = Some((r.seq, r.signature));
        }
        self.scanned = scanned.flatten().map(|x| x.max(self.after.0));
        Ok(out)
    }
    fn cursor(&self) -> Value {
        if let Some(r) = &self.refused {
            return json!({ "feed_refused": r });
        }
        json!({
            "feed_after": self.after.0,
            "feed_start": self.start,
            "ledger": self.cursor_ledger,
            "feed_last": self.last.map(|(q, s)| json!({"seq": q, "signature": s.to_string()})),
            "feed_scanned": self.scanned,
            "ledger_bytes": self.ledger_bytes,
            "ledger_durable": self.durable,
        })
    }
    fn restore(&mut self, v: &Value) {
        self.refused = None;
        if v.is_null() {
            // An empty archive: the next pull starts the ledger.
            self.after = Cursor(0);
            self.start = Some(0);
            self.cursor_ledger = self.ledger.clone();
            self.last = None;
            self.check_last = false;
            self.scanned = None;
            self.durable = None;
            return;
        }
        if let Some(r) = v.get("feed_refused").and_then(|x| x.as_str()) {
            self.refused = Some(r.to_string());
            return;
        }
        let Some(a) = v.get("feed_after").and_then(|x| x.as_u64()) else {
            self.refused = Some(format!(
                "history gap: the stored cursor is not a local feed's ({}): where the archive ends on the ledger is unknown",
                truncate(&v.to_string(), 120)
            ));
            return;
        };
        let theirs = v.get("ledger").and_then(|x| x.as_str()).map(String::from);
        if let (Some(t), Some(now)) = (&theirs, &self.ledger) {
            if t != now {
                self.refused = Some(format!(
                    "history gap: the archive is of ledger {t}, the node serves ledger {now}: its seq numbers mean other transactions"
                ));
                return;
            }
        }
        self.after = Cursor(a);
        self.start = v.get("feed_start").and_then(|x| x.as_u64());
        self.cursor_ledger = theirs;
        self.last = v.get("feed_last").and_then(|l| {
            Some((
                l.get("seq")?.as_u64()?,
                l.get("signature")?.as_str()?.parse().ok()?,
            ))
        });
        self.check_last = self.last.is_some();
        self.scanned = v.get("feed_scanned").and_then(|x| x.as_u64());
        // Never below a size already seen (19 and 04, 2026-11-07): the
        // stored value only lowers what a later read is compared with if it
        // were taken as is.
        if let Some(b) = v.get("ledger_bytes").and_then(|x| x.as_u64()) {
            self.ledger_bytes = Some(self.ledger_bytes.map_or(b, |m| m.max(b)));
        }
        self.durable = v.get("ledger_durable").and_then(|x| x.as_bool());
    }
    fn coverage(&self) -> Option<Value> {
        Some(json!({
            "state": if self.refused.is_some() { "gap" } else { "ledger_feed" },
            "gap": self.refused,
            "feedStart": self.start,
            "feedAfter": self.after.0,
            "ledger": self.cursor_ledger,
            "limit": "a local node's feed is its ledger; an archive of it is whole only from feed_start 0, of one ledger, with every record's feed_seq (findex::ledger)",
        }))
    }
    fn ledger_seq(&self) -> bool {
        true
    }
}

/// `getSignaturesForAddress` + `getTransaction` over JSON-RPC.
pub struct RpcPoll {
    pub rpc: RpcClient,
    pub program: Address,
    /// Page size of `getSignaturesForAddress` (≤ 1,000).
    pub page: usize,
    last: Option<Signature>,
    /// The slot of `last` and every archived signature of that slot: kept
    /// in the cursor, so a restart still knows them when another node
    /// orders that slot's signatures differently.
    last_slot: Option<u64>,
    last_slot_sigs: Vec<Signature>,
    seen: HashSet<Signature>,
    seen_order: VecDeque<Signature>,
    /// The program's first signature: a first pull must reach it (G1).
    pub origin: Option<Signature>,
    /// A second node: its signatures after the archive's last one, up to
    /// the batch's newest slot, must all be in the batch (G3).
    pub witness: Option<RpcClient>,
    /// The first archived slot (`None`: nothing archived, or an archive
    /// written before coverage was recorded). Kept in the cursor.
    cov_first_slot: Option<u64>,
    /// Why an archived range is not checked: (reason, first slot it applies
    /// from), each reason once. Kept in the cursor: never cleared.
    cov_unverified: Vec<(String, u64)>,
    /// The stored cursor could not be read while the archive holds records:
    /// every pull fails (the archive's end is unknown). Kept in the cursor.
    refused: Option<String>,
    /// The last detected gap while pulls keep failing on it (not stored:
    /// the next pull detects it again).
    gap: Option<String>,
    /// Consecutive pulls the witness was behind the whole batch.
    witness_behind: u32,
    /// Signatures the node listed that the last pull did not hand back
    /// (the witness behind, or a transaction not retrievable yet): an empty
    /// pull with signatures held back is not "caught up".
    held_back: usize,
}

/// Coverage reasons ([`RpcPoll::coverage`]).
pub mod reason {
    pub const FIRST_PULL_UNANCHORED: &str = "first pull without an origin anchor: history older than the first archived transaction may have been pruned by the node";
    pub const NO_WITNESS: &str = "no witness: a range missing in the middle of the node's history (behind a kept last signature) cannot be seen";
    pub const WITNESS_UNAVAILABLE: &str = "the witness could not be read for an archived range";
    pub const WITNESS_LACKS: &str = "the witness lacked signatures the node served (behind or pruned): those were not cross-checked";
    pub const BEFORE_COVERAGE: &str =
        "archived before coverage was recorded: its start and middle were not checked";
}

/// What RPC answers cannot establish, stated with every coverage report.
pub const COVERAGE_LIMIT: &str = "RPC answers cannot prove a complete history: cross_checked only records that the node and the witness agreed (a witness on the same storage misses the same range); it is not proof of completeness or of finality, and a record absent from the archive is no evidence that the transaction did not happen";

const SEEN_KEEP: usize = 20_000;
/// Signatures read below the oldest new one to find the last archived one
/// (same-slot order may differ between nodes).
const CONTINUITY_PAGE: usize = 64;

impl RpcPoll {
    pub fn new(url: impl Into<String>, program: Address) -> RpcPoll {
        RpcPoll {
            rpc: RpcClient::new(url),
            program,
            page: 1_000,
            last: None,
            last_slot: None,
            last_slot_sigs: vec![],
            seen: HashSet::new(),
            seen_order: VecDeque::new(),
            origin: None,
            witness: None,
            cov_first_slot: None,
            cov_unverified: vec![],
            refused: None,
            gap: None,
            witness_behind: 0,
            held_back: 0,
        }
    }

    /// Sets the origin anchor (the program's first signature).
    pub fn with_origin(mut self, origin: Signature) -> RpcPoll {
        self.origin = Some(origin);
        self
    }

    /// Sets a witness node (another RPC endpoint, ideally on independent
    /// storage).
    pub fn with_witness(mut self, url: impl Into<String>) -> RpcPoll {
        self.witness = Some(RpcClient::new(url));
        self
    }

    /// What the archived history covers, as JSON:
    /// `{"state", "range": {"firstSlot", "lastSlot"} | null, "gap",
    /// "unverifiable": [{"reason", "fromSlot"}], "origin", "witness",
    /// "limit"}`. `state` is `gap` (pulls stop on a detected or possible
    /// missing range: archive nothing), `not_fetched` (nothing archived:
    /// not evidence of an empty history), `unverifiable` (some archived
    /// range was not checked) or `cross_checked` (the start reached the
    /// origin and every batch agreed with the witness; still not a proof,
    /// see `limit`).
    pub fn coverage(&self) -> Value {
        let gap = self.refused.as_ref().or(self.gap.as_ref());
        let state = if gap.is_some() {
            "gap"
        } else if self.last.is_none() {
            "not_fetched"
        } else if !self.cov_unverified.is_empty() {
            "unverifiable"
        } else {
            "cross_checked"
        };
        json!({
            "state": state,
            "range": self.last.map(|_| json!({"firstSlot": self.cov_first_slot, "lastSlot": self.last_slot})),
            "gap": gap,
            "unverifiable": self.cov_unverified.iter().map(|(r, s)| json!({"reason": r, "fromSlot": s})).collect::<Vec<_>>(),
            "origin": self.origin.map(|s| s.to_string()),
            "witness": self.witness.is_some(),
            "heldBack": self.held_back,
            "limit": COVERAGE_LIMIT,
        })
    }

    /// Signatures the node listed that the last pull did not hand back
    /// (see `heldBack` in [`RpcPoll::coverage`]).
    pub fn held_back(&self) -> usize {
        self.held_back
    }

    fn unverified(&mut self, reason: &str, slot: u64) {
        if !self.cov_unverified.iter().any(|(r, _)| r == reason) {
            self.cov_unverified.push((reason.to_string(), slot));
        }
    }

    fn remember(&mut self, s: Signature) {
        if self.seen.insert(s) {
            self.seen_order.push_back(s);
            if self.seen_order.len() > SEEN_KEEP {
                if let Some(old) = self.seen_order.pop_front() {
                    self.seen.remove(&old);
                }
            }
        }
    }
}

impl RpcPoll {
    /// The signatures older than `oldest_new` must reach `last` through
    /// archived ones or ones of this batch only (nothing between them was
    /// skipped). Nodes may order one slot's signatures differently, hence
    /// the batch and the stored signatures of `last`'s slot count; going
    /// below `last`'s slot without meeting it is a gap.
    async fn check_continuity(
        &self,
        oldest_new: &Signature,
        batch: &HashSet<Signature>,
    ) -> PortResult<()> {
        let Some(last) = self.last else {
            return Ok(());
        };
        let older = self
            .rpc
            .get_finalized_signatures_for_address(
                &self.program,
                Some(oldest_new),
                None,
                CONTINUITY_PAGE,
            )
            .await?;
        for s in &older {
            if s.signature == last {
                return Ok(());
            }
            if self.last_slot.is_some_and(|ls| s.slot < ls) {
                break;
            }
            if !self.seen.contains(&s.signature) && !batch.contains(&s.signature) {
                return Err(PortError::Unavailable(format!(
                    "history gap: {} lies between the archive's last signature {last} and the new batch",
                    s.signature
                )));
            }
        }
        Err(PortError::Unavailable(format!(
            "history gap: the node's history no longer reaches the archive's last signature {last}"
        )))
    }

    /// G1: a first pull (no cursor) with an origin anchor must reach it,
    /// and nothing may be older (`newest_first` holds the node's whole
    /// history then).
    fn check_origin(&self, newest_first: &[SigInfo]) -> PortResult<()> {
        let (Some(origin), None, Some(oldest)) = (self.origin, self.last, newest_first.last())
        else {
            return Ok(());
        };
        if oldest.signature == origin {
            return Ok(());
        }
        if newest_first.iter().any(|s| s.signature == origin) {
            return Err(PortError::Unavailable(format!(
                "history gap: the node holds signatures older than the origin anchor {origin} (oldest {} at slot {}): the anchor is wrong or the history is not this program's",
                oldest.signature, oldest.slot
            )));
        }
        Err(PortError::Unavailable(format!(
            "history gap: the first pull does not reach the origin anchor {origin}: the node's history starts at {} (slot {}); an older range is missing",
            oldest.signature, oldest.slot
        )))
    }

    /// G3: the witness's signatures after the archive's last one, up to the
    /// newest slot of the batch, must all be in the batch (or archived).
    /// Returns how many of the batch (newest first) to keep: signatures in
    /// slots above the witness's newest are left for a later pull. Signatures
    /// of the batch the witness lacks are reported as not cross-checked.
    async fn check_witness(
        &self,
        w: &RpcClient,
        newest_first: &[SigInfo],
        batch: &HashSet<Signature>,
    ) -> Result<WitnessSaw, PortError> {
        let Some(newest) = newest_first.first() else {
            return Ok(WitnessSaw::Agrees(0));
        };
        let floor = self.last_slot.unwrap_or(0);
        let mut seen_w: Vec<SigInfo> = vec![];
        let mut ids: HashSet<Signature> = HashSet::new();
        let mut before: Option<Signature> = None;
        loop {
            let page = match w
                .get_finalized_signatures_for_address(
                    &self.program,
                    before.as_ref(),
                    self.last.as_ref(),
                    self.page,
                )
                .await
            {
                Ok(p) => p,
                Err(_) => return Ok(WitnessSaw::Unavailable),
            };
            let n = page.len();
            for s in page {
                if !ids.insert(s.signature) {
                    return Ok(WitnessSaw::Unavailable);
                }
                seen_w.push(s);
            }
            let Some(oldest) = seen_w.last() else { break };
            if n < self.page || oldest.slot < floor {
                break;
            }
            before = Some(oldest.signature);
        }
        let Some(head) = seen_w.first().map(|s| s.slot) else {
            return Ok(WitnessSaw::Behind);
        };
        let after_last = |slot: u64| self.last.is_none() || slot >= floor;
        for s in &seen_w {
            if s.slot > newest.slot || !after_last(s.slot) || Some(s.signature) == self.last {
                continue;
            }
            if !batch.contains(&s.signature) && !self.seen.contains(&s.signature) {
                return Err(PortError::Unavailable(format!(
                    "history gap: the witness holds {} (slot {}) between the archive's last signature and the new batch; the node does not",
                    s.signature, s.slot
                )));
            }
        }
        // Keep the batch up to the witness's newest slot.
        let keep = newest_first
            .iter()
            .position(|s| s.slot <= head)
            .map_or(0, |i| newest_first.len() - i);
        if keep == 0 {
            return Ok(WitnessSaw::Behind);
        }
        let lacks = newest_first[newest_first.len() - keep..]
            .iter()
            .any(|s| !ids.contains(&s.signature) && self.last_slot.is_none_or(|ls| s.slot > ls));
        Ok(if lacks {
            WitnessSaw::Lacks
        } else {
            WitnessSaw::Agrees(keep)
        })
    }
}

/// [`RpcPoll::check_witness`]'s outcome.
enum WitnessSaw {
    /// Cross-checked: fetch this many of the batch (the oldest ones).
    Agrees(usize),
    /// The witness has nothing up to the batch's oldest slot yet.
    Behind,
    /// The witness lacks part of what it should hold: fetch all, unchecked.
    Lacks,
    /// The witness could not be read: fetch all, unchecked.
    Unavailable,
}

/// Pulls a witness may be behind the node before the batch is archived
/// unchecked (so a stuck witness does not stop the archive silently).
const WITNESS_BEHIND_MAX: u32 = 30;

impl RpcPoll {
    async fn pull_checked(&mut self) -> PortResult<Vec<TxRecord>> {
        self.held_back = 0;
        if let Some(r) = &self.refused {
            return Err(PortError::Unavailable(r.clone()));
        }
        // Newest first, back to the last signature seen.
        let mut newest_first = vec![];
        let mut collected: HashSet<Signature> = HashSet::new();
        let mut before: Option<Signature> = None;
        loop {
            let page = self
                .rpc
                .get_finalized_signatures_for_address(
                    &self.program,
                    before.as_ref(),
                    self.last.as_ref(),
                    self.page,
                )
                .await?;
            let n = page.len();
            let mut stop = n == 0;
            for s in page {
                if Some(s.signature) == self.last || self.seen.contains(&s.signature) {
                    stop = true;
                    break;
                }
                if !collected.insert(s.signature) {
                    // The server ignored `before` and served a page again:
                    // paging on would loop, stopping would leave a gap.
                    return Err(PortError::Unsupported(
                        "getSignaturesForAddress ignored `before`: cannot page without a gap",
                    ));
                }
                newest_first.push(s);
            }
            if stop || n < self.page {
                break;
            }
            let next = newest_first.last().map(|s| s.signature);
            if next == before {
                break;
            }
            before = next;
        }
        if let Some(oldest) = newest_first.last() {
            self.check_continuity(&oldest.signature, &collected).await?;
        }
        self.check_origin(&newest_first)?;
        // Reasons the batch (if archived) leaves unchecked.
        let first_pull = self.last.is_none();
        let mut unchecked: Vec<&str> = vec![];
        if first_pull && self.origin.is_none() {
            unchecked.push(reason::FIRST_PULL_UNANCHORED);
        }
        match &self.witness {
            None => unchecked.push(reason::NO_WITNESS),
            Some(w) if !newest_first.is_empty() => {
                match self.check_witness(w, &newest_first, &collected).await? {
                    WitnessSaw::Agrees(keep) => {
                        self.witness_behind = 0;
                        self.held_back = newest_first.len() - keep;
                        newest_first.drain(..self.held_back);
                    }
                    WitnessSaw::Behind if self.witness_behind < WITNESS_BEHIND_MAX => {
                        self.witness_behind += 1;
                        self.held_back = newest_first.len();
                        return Ok(vec![]);
                    }
                    WitnessSaw::Behind | WitnessSaw::Lacks => {
                        self.witness_behind = 0;
                        unchecked.push(reason::WITNESS_LACKS);
                    }
                    WitnessSaw::Unavailable => unchecked.push(reason::WITNESS_UNAVAILABLE),
                }
            }
            Some(_) => {}
        }
        let mut out = vec![];
        let listed = newest_first.len();
        for s in newest_first.into_iter().rev() {
            // The cursor advances with each transaction handed back, so a
            // failure after some of them returns those (they are archived,
            // the failing one is retried next pull); returning the error
            // instead would drop them while the cursor had moved past.
            let got = match self.rpc.get_finalized_transaction(&s.signature).await {
                Ok(got) => got,
                Err(e) if out.is_empty() => return Err(e),
                Err(_) => break,
            };
            match got {
                Some(r) => {
                    if out.is_empty() {
                        if first_pull {
                            self.cov_first_slot = Some(s.slot);
                        }
                        for r in &unchecked {
                            self.unverified(r, s.slot);
                        }
                    }
                    self.last = Some(s.signature);
                    if self.last_slot == Some(s.slot) {
                        self.last_slot_sigs.push(s.signature);
                    } else {
                        self.last_slot = Some(s.slot);
                        self.last_slot_sigs = vec![s.signature];
                    }
                    self.remember(s.signature);
                    out.push(r);
                }
                // Not retrievable yet: resume here next time.
                None => break,
            }
        }
        self.held_back += listed - out.len();
        Ok(out)
    }
}

/// The coverage an archived `RpcPoll` cursor records (the verifier reads
/// it from a findex archive's manifest): [`RpcPoll::coverage`] without the
/// reading poller's own settings (`origin`, `witness`, `heldBack` are
/// `null`: what they checked is in `unverifiable`). `None` when the cursor
/// is not an `RpcPoll` one (an ordered feed's `feed_after`, or `null`).
pub fn coverage_from_cursor(cursor: &Value) -> Option<Value> {
    let ours = ["rpc_last", "rpc_refused", "rpc_coverage"];
    if !ours.iter().any(|k| cursor.get(k).is_some()) {
        return None;
    }
    let mut p = RpcPoll::new(String::new(), Address::default());
    p.restore(cursor);
    let mut c = p.coverage();
    for k in ["origin", "witness", "heldBack"] {
        c[k] = Value::Null;
    }
    Some(c)
}

impl Source for RpcPoll {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        let r = self.pull_checked().await;
        match &r {
            Ok(_) => self.gap = None,
            Err(PortError::Unavailable(m)) if m.starts_with("history gap") => {
                self.gap = Some(m.clone())
            }
            Err(_) => {}
        }
        r
    }
    fn cursor(&self) -> Value {
        if let Some(r) = &self.refused {
            return json!({ "rpc_refused": r });
        }
        json!({
            "rpc_last": self.last.map(|s| s.to_string()),
            "rpc_last_slot": self.last_slot,
            "rpc_last_slot_sigs": self.last_slot_sigs.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "rpc_coverage": {
                "first_slot": self.cov_first_slot,
                "unverifiable": self.cov_unverified.iter().map(|(r, s)| json!([r, s])).collect::<Vec<_>>(),
            },
        })
    }
    fn restore(&mut self, v: &Value) {
        // Replacing an in-memory cursor must also forget signatures observed
        // after it. Otherwise a failed enrichment can rewind `last` while
        // `seen` still hides transactions that were never archived.
        self.seen.clear();
        self.seen_order.clear();
        self.refused = None;
        self.last = None;
        self.last_slot = None;
        self.last_slot_sigs.clear();
        self.cov_first_slot = None;
        self.cov_unverified.clear();
        if let Some(r) = v.get("rpc_refused").and_then(|x| x.as_str()) {
            self.refused = Some(r.to_string());
            return;
        }
        // `null` (an empty archive) and a fresh poller's own cursor
        // (`rpc_last: null`) start a first pull; anything else without a
        // readable `rpc_last` means the archive's end is unknown (G2): every
        // pull fails instead of starting over and archiving the node's
        // history again after it.
        match v.get("rpc_last") {
            _ if v.is_null() => return,
            Some(Value::Null) => return,
            Some(Value::String(s)) if s.parse::<Signature>().is_ok() => {
                self.last = s.parse().ok();
            }
            _ => {
                self.refused = Some(format!(
                    "history gap: the stored cursor cannot be read ({}): where the archive ends on the node is unknown; refusing to start over as a first pull",
                    truncate(&v.to_string(), 120)
                ));
                return;
            }
        }
        if let Some(s) = self.last {
            self.remember(s);
        }
        // Cursors written before these fields existed restore without them
        // (the check then needs `last` itself to be met).
        self.last_slot = v.get("rpc_last_slot").and_then(|x| x.as_u64());
        self.last_slot_sigs = v
            .get("rpc_last_slot_sigs")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()?.parse().ok()).collect())
            .unwrap_or_default();
        for s in self.last_slot_sigs.clone() {
            self.remember(s);
        }
        match v.get("rpc_coverage") {
            Some(c) => {
                self.cov_first_slot = c.get("first_slot").and_then(|x| x.as_u64());
                self.cov_unverified = c
                    .get("unverifiable")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| {
                                Some((e.get(0)?.as_str()?.to_string(), e.get(1)?.as_u64()?))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
            }
            None => self.cov_unverified = vec![(reason::BEFORE_COVERAGE.to_string(), 0)],
        }
    }
    fn coverage(&self) -> Option<Value> {
        Some(RpcPoll::coverage(self))
    }
}

fn truncate(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// A source whose transactions lack post-state (a public RPC) with the
/// written accounts fetched **before archiving** (offchain design §8.2
/// step 2, W3-D): for each landed transaction without post-state, the
/// message's writable accounts are read with finalized `getMultipleAccounts
/// (minContextSlot = the transaction's slot)`. The bytes are "state at a
/// slot ≥ s" (a later write can show through); each chained account's
/// `(event seq, head)` says which version it is. Because the fetched
/// post-state is archived with the transaction, every later fold of the
/// archive sees the same bytes (the herald's determinism).
pub struct Enriched<S: Source> {
    pub inner: S,
    pub rpc: RpcClient,
    /// Keys never fetched (program ids, sysvars).
    pub skip: HashSet<Address>,
}

impl<S: Source> Enriched<S> {
    pub fn new(inner: S, url: impl Into<String>, program: Address) -> Enriched<S> {
        let mut skip = HashSet::new();
        skip.insert(program);
        skip.insert(fclient::addr::system_program());
        Enriched {
            inner,
            rpc: RpcClient::new(url),
            skip,
        }
    }

    /// The writable accounts of a wire transaction (fee payer excluded).
    pub fn writable_keys(&self, wire: &[u8]) -> Vec<Address> {
        let Ok(t) = fclient::tx::from_wire(wire) else {
            return vec![];
        };
        let m = &t.message;
        (1..m.account_keys.len())
            .filter(|&i| fclient::tx::is_writable_index(m, i))
            .map(|i| m.account_keys[i])
            .filter(|k| !self.skip.contains(k))
            .collect()
    }
}

impl<S: Source> Source for Enriched<S> {
    async fn pull(&mut self) -> PortResult<Vec<TxRecord>> {
        let before = self.inner.cursor();
        let mut got = match self.inner.pull().await {
            Ok(got) => got,
            Err(e) => {
                self.inner.restore(&before);
                return Err(e);
            }
        };
        for r in got.iter_mut() {
            if r.err.is_some() || !r.post.is_empty() {
                continue;
            }
            let keys = self.writable_keys(&r.tx);
            if keys.is_empty() {
                continue;
            }
            let accts = match self
                .rpc
                .get_finalized_multiple_accounts(&keys, r.slot)
                .await
            {
                Ok(accts) => accts,
                Err(e) => {
                    // `inner.pull` may already have moved past the entire
                    // batch, but none of it has reached the archive yet.
                    self.inner.restore(&before);
                    return Err(e);
                }
            };
            r.post = keys.into_iter().zip(accts).collect();
        }
        Ok(got)
    }
    fn cursor(&self) -> Value {
        self.inner.cursor()
    }
    fn restore(&mut self, v: &Value) {
        self.inner.restore(v)
    }
    fn coverage(&self) -> Option<Value> {
        self.inner.coverage()
    }
    fn ledger_seq(&self) -> bool {
        self.inner.ledger_seq()
    }
}

/// An error of either the source or the store.
#[derive(Debug)]
pub enum IngestError {
    Port(PortError),
    Store(String),
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for IngestError {}
