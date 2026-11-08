//! **Read-only, opt-in** (feature `wide-world-experimental`): bounded
//! continuation of the wide observation after the legacy feed gate blocks.
//!
//! `Keeper::refresh_discovery` pulls feed pages from the **legacy** cursor
//! and shows each page to the wide observer before the legacy indexes
//! ingest it. Once a legacy index blocks (the PSW1 guard that stops game
//! writes), no page is pulled, so the observer sees nothing later. This
//! follower, enabled by `Keeper::enable_wide_follow`, pulls pages from
//! its **own** cursor in the ticks the legacy path did not pull, and shows
//! them to the very same observer and proof store, through the same
//! typed decode, the same accepted-prefix rule and the same extractor.
//!
//! What it never does: advance or read a legacy cursor
//! (`LandIndex`/`PlayIndex` are not touched), change a feed gate or the
//! engine's feed readiness, sign, send or simulate, or claim source
//! completeness or history authenticity (the observer's status keeps
//! `source_complete: false`; the review's denials `HistoryUnknown` and
//! `SourceUnproven` are unchanged). It is diagnostics: what the chain's
//! program feed says after the gate, as far as one bounded reader can see.
//!
//! **Fail-closed rules.**
//!
//! - *No double processing of the shared feed.* In a tick where the legacy
//!   path pulled (whether it blocked or not), the follower stands aside
//!   (`idle_shared_feed`). Before pulling, its cursor catches up to the
//!   observer's last processed sequence, so a page the observer already
//!   saw through the legacy path is not pulled again.
//! - *Order.* Every record of a page must be past the cursor and strictly
//!   increasing (the feed contract); any other page stops the follower
//!   (`page-order`) before the observer sees it. **Not contiguous**: the
//!   raw feed's sequence is the chain's global transaction order filtered
//!   to this program, so a skipped number is unknown to this reader —
//!   another program's transaction, an airdrop, or a program record it
//!   never received. Counted as `sequence_holes_unknown`, never a stop,
//!   never a claim either way: it may hide missing program records, and
//!   only a missing linked record between two observed links of the same
//!   province or holding is detected (the observer's chain check); a
//!   missing prefix, tail, never-seen entity or non-wide record is not.
//!   Only the archive's renumbered rows are contiguous, and only the typed
//!   index over them refuses a gap. Exact replays are the observer's
//!   business when pages overlap through the legacy path; the follower
//!   itself never offers a replay.
//! - *The observer decides.* The observer's own validation (program, page
//!   order, fingerprinted replays, the typed reader's refusals, the model's
//!   caps) is untouched. When it blocks — before this page, or at some
//!   record of it — the follower stops (`observer-blocked`), its cursor at
//!   the last record the observer accepted, and stays stopped. Nothing
//!   bypasses a rejected record; a stopped follower is restarted only by a
//!   new process (which starts empty, like the observer).
//! - *Bounds.* At most [`PAGES_PER_TICK`] pages per tick (a hard cap,
//!   whatever the public `pages_per_tick` says). A page longer than
//!   [`MAX_PAGE_RECORDS`] is **refused before anything reads it**: no order
//!   scan, no observer, no proof store, the cursor unchanged; the follower
//!   stops (`oversized-page`) and the status records only the count and
//!   the first record's sequence. Then the **byte preflight**
//!   ([`preflight`]): the observer fingerprints a whole record through
//!   `Debug` before it decodes it, so every record's wire, log count, log
//!   line length, aggregate log bytes, error text, post-state account
//!   count and aggregate post data, and the record's and the page's bytes
//!   in all, are bounded by reading lengths alone before any record is
//!   fingerprinted, decoded or copied; a record or page past a bound is a
//!   typed stop (`record-wire`, `record-logs`, `record-err`,
//!   `record-post`, `record-bytes`, `page-bytes`) at that record's
//!   sequence, everything untouched. The bytes were received by the port
//!   already; the preflight bounds what is done with them. Proof
//!   extraction is the store's own `MAX_EXTRACT_PER_PAGE`. The legacy
//!   pull path is unchanged (it feeds the observer as before).
//! - *Errors.* A feed read failure is counted (`read_errors`) and the tick
//!   ends; the port's text never reaches the status.
//! - *Currency.* `caught_up` is true only when the **last** step received
//!   an empty page; every step clears it first (an idle tick, a read
//!   error, a stop), so a stale empty response is never presented as
//!   current.
//! - *The observer's block is final here.* The follower never clears,
//!   reinterprets or works around `observer.model.blocked()` — whether the
//!   block came from a page the follower pulled or from a legacy replay
//!   (the legacy cursors may diverge and the legacy path may replay pages;
//!   the observer's fingerprints judge that). A blocked observer stops the
//!   follower at the next step, whatever its own cursor says.
//! - *Restart.* Nothing is persisted: a new process starts the follower at
//!   the observer's position (empty on start; the legacy replay from the
//!   legacy cursor feeds the observer first when the gate is open).
//!
//! **Status.** Counts, the cursor, the last slot seen, the typed stop
//! reason with its sequence, the bounds; `automatic_writes: false`,
//! `source_complete: false`, `history_authenticated: false`,
//! `legacy_cursors_touched: false`, always.

use fclient::ports::{ChainPort, Cursor, TxRecord};
use serde_json::{json, Value};

use crate::wideindex::WideObserver;
use crate::wideproof::ProofScope;
use crate::widetick::ProofStore;

/// Pages per tick: a hard cap.
pub const PAGES_PER_TICK: usize = 2;
/// Records of one page above which the page is refused unread (the
/// JSON-RPC feed asks for 1,000 at most; a longer page is not the feed's
/// contract).
pub const MAX_PAGE_RECORDS: usize = 1_000;

/// Why the follower stopped, typed; `seq` is the record it stopped at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stopped {
    pub code: &'static str,
    pub seq: u64,
}

/// The observer blocked (before this page or at `seq`).
pub const STOP_OBSERVER_BLOCKED: &str = "observer-blocked";
/// A page not past the cursor or not strictly increasing, at `seq`.
pub const STOP_PAGE_ORDER: &str = "page-order";
/// A page longer than [`MAX_PAGE_RECORDS`], refused unread; `seq` is its
/// first record's.
pub const STOP_OVERSIZED: &str = "oversized-page";
/// A record's wire longer than [`MAX_RECORD_WIRE_BYTES`].
pub const STOP_RECORD_WIRE: &str = "record-wire";
/// A record's logs: more lines than [`MAX_RECORD_LOG_LINES`], a line
/// longer than [`MAX_RECORD_LOG_LINE_BYTES`], or more bytes in all than
/// [`MAX_RECORD_LOG_BYTES`].
pub const STOP_RECORD_LOGS: &str = "record-logs";
/// A record's error text longer than [`MAX_RECORD_ERR_BYTES`].
pub const STOP_RECORD_ERR: &str = "record-err";
/// A record's post-state: more accounts than [`MAX_RECORD_POST_ACCOUNTS`]
/// or more data bytes in all than [`MAX_RECORD_POST_DATA_BYTES`].
pub const STOP_RECORD_POST: &str = "record-post";
/// A record's bytes in all past [`MAX_RECORD_BYTES`].
pub const STOP_RECORD_BYTES: &str = "record-bytes";
/// The page's bytes in all past [`MAX_PAGE_BYTES`]; `seq` is the record
/// that crossed it.
pub const STOP_PAGE_BYTES: &str = "page-bytes";

// ---- the byte preflight: lengths read, nothing copied ----

/// A transaction packet: the wire can be no longer (the extractor's bound).
pub const MAX_RECORD_WIRE_BYTES: usize = 1_232;
/// Log lines per record (the extractor's bound).
pub const MAX_RECORD_LOG_LINES: usize = 1_024;
/// Bytes per log line (the extractor's bound).
pub const MAX_RECORD_LOG_LINE_BYTES: usize = 4_096;
/// Log bytes per record in all (256 KiB: a program's whole log is tens of
/// KiB at most).
pub const MAX_RECORD_LOG_BYTES: usize = 256 * 1024;
/// Error text per record.
pub const MAX_RECORD_ERR_BYTES: usize = 4_096;
/// Post-state accounts per record (a transaction's account limit).
pub const MAX_RECORD_POST_ACCOUNTS: usize = 64;
/// Post-state data bytes per record in all (1 MiB; post-state is a
/// localnet diagnostic, empty from a public RPC).
pub const MAX_RECORD_POST_DATA_BYTES: usize = 1024 * 1024;
/// One record's bytes in all (wire, logs, error, signature, post-state
/// keys and data): 1 MiB.
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
/// One page's bytes in all: 8 MiB.
pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

/// The bytes a record carries, by reading lengths only — no `Debug`, no
/// base64, no copy — or the typed stop its size earns. The observer's
/// fingerprint (`Debug` over the whole record) and the typed decode run
/// only on records this has passed.
pub fn preflight(r: &TxRecord) -> Result<usize, &'static str> {
    if r.tx.len() > MAX_RECORD_WIRE_BYTES {
        return Err(STOP_RECORD_WIRE);
    }
    if r.logs.len() > MAX_RECORD_LOG_LINES {
        return Err(STOP_RECORD_LOGS);
    }
    let mut log_bytes = 0usize;
    for l in &r.logs {
        if l.len() > MAX_RECORD_LOG_LINE_BYTES {
            return Err(STOP_RECORD_LOGS);
        }
        log_bytes = log_bytes.saturating_add(l.len());
        if log_bytes > MAX_RECORD_LOG_BYTES {
            return Err(STOP_RECORD_LOGS);
        }
    }
    let err_bytes = r.err.as_ref().map_or(0, String::len);
    if err_bytes > MAX_RECORD_ERR_BYTES {
        return Err(STOP_RECORD_ERR);
    }
    if r.post.len() > MAX_RECORD_POST_ACCOUNTS {
        return Err(STOP_RECORD_POST);
    }
    let mut post_bytes = 0usize;
    for (_, a) in &r.post {
        // key, owner, lamports, flag, and the data
        post_bytes = post_bytes.saturating_add(32 + 32 + 8 + 1);
        if let Some(a) = a {
            post_bytes = post_bytes.saturating_add(a.data.len());
        }
        if post_bytes > MAX_RECORD_POST_DATA_BYTES {
            return Err(STOP_RECORD_POST);
        }
    }
    // seq, slot, block_time, code, units, fee, signature
    let fixed: usize = 8 + 8 + 8 + 4 + 8 + 8 + 64;
    let total = fixed
        .saturating_add(r.tx.len())
        .saturating_add(log_bytes)
        .saturating_add(err_bytes)
        .saturating_add(post_bytes);
    if total > MAX_RECORD_BYTES {
        return Err(STOP_RECORD_BYTES);
    }
    Ok(total)
}

/// The follower's state.
pub struct WideFollow {
    cursor: Cursor,
    /// Pages per tick; clamped to [`PAGES_PER_TICK`] at every step.
    pub pages_per_tick: usize,
    pub ticks: u64,
    /// Ticks the legacy path pulled: the follower stood aside.
    pub idle_shared_feed: u64,
    /// Times the cursor caught up to the observer's position before a pull.
    pub caught_up_to_observer: u64,
    pub pages: u64,
    pub records: u64,
    /// Sequence numbers skipped between consecutive records pulled: the
    /// raw feed is the chain's global order filtered to this program, so
    /// each is **unknown** to this reader — another program's transaction,
    /// an airdrop, or a program record it never received. Reported, never
    /// a stop, never a claim either way: a hole **may** hide missing
    /// program records; only a missing linked record between two observed
    /// links of the same province or holding is detected (the observer's
    /// chain check), not a missing prefix, tail, new entity or non-wide
    /// record.
    pub sequence_holes: u64,
    /// Bytes of the records processed (the preflight's measure).
    pub bytes: u64,
    /// Pages refused unread for their length (at most one: it stops).
    pub oversized_pages: u64,
    /// Pages refused unread by the byte preflight (at most one: it stops).
    pub preflight_rejections: u64,
    pub read_errors: u64,
    /// The **last** step received an empty page; cleared at the start of
    /// every step.
    pub caught_up: bool,
    pub last_slot: Option<u64>,
    stopped: Option<Stopped>,
}

impl WideFollow {
    /// A follower whose first pull is after `resume_after` (the feed
    /// sequence of the last record already processed; `None`: from the
    /// start).
    pub fn new(resume_after: Option<u64>) -> WideFollow {
        WideFollow {
            cursor: Cursor(resume_after.unwrap_or(0)),
            pages_per_tick: PAGES_PER_TICK,
            ticks: 0,
            idle_shared_feed: 0,
            caught_up_to_observer: 0,
            pages: 0,
            records: 0,
            sequence_holes: 0,
            bytes: 0,
            oversized_pages: 0,
            preflight_rejections: 0,
            read_errors: 0,
            caught_up: false,
            last_slot: None,
            stopped: None,
        }
    }

    /// A follower resuming after what the observer has processed.
    pub fn from_observer(o: &WideObserver) -> WideFollow {
        WideFollow::new(o.last_seq_seen)
    }

    /// The effective cap: never above the hard constant.
    pub fn cap(&self) -> usize {
        self.pages_per_tick.min(PAGES_PER_TICK)
    }

    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    pub fn stopped(&self) -> Option<Stopped> {
        self.stopped
    }

    /// One bounded step. `legacy_pulled`: the legacy discovery pulled feed
    /// pages this tick (the follower then stands aside). Pages are shown
    /// to `observer` and, when given, to `proofs` with the observer's
    /// accepted prefix. Returns the number of pages pulled (empty pages
    /// included).
    pub async fn step<P: ChainPort>(
        &mut self,
        port: &P,
        observer: &mut WideObserver,
        mut proofs: Option<&mut ProofStore>,
        scope: &ProofScope,
        legacy_pulled: bool,
    ) -> u64 {
        self.ticks += 1;
        // Nothing from an earlier step is current.
        self.caught_up = false;
        if legacy_pulled {
            self.idle_shared_feed += 1;
            return 0;
        }
        if self.stopped.is_some() {
            return 0;
        }
        if let Some(b) = observer.model.blocked() {
            // Blocked by whatever path — a legacy replay included: final
            // here, never reinterpreted.
            self.stopped = Some(Stopped {
                code: STOP_OBSERVER_BLOCKED,
                seq: b.seq,
            });
            return 0;
        }
        // Never behind the observer: what it processed through the legacy
        // path is not pulled again.
        if let Some(seen) = observer.last_seq_seen {
            if seen > self.cursor.0 {
                self.cursor = Cursor(seen);
                self.caught_up_to_observer += 1;
            }
        }
        let mut pulled = 0u64;
        for _ in 0..self.cap() {
            let page: Vec<TxRecord> = match port.feed(self.cursor).await {
                Ok(p) => p,
                Err(_) => {
                    // Counted, never quoted.
                    self.read_errors += 1;
                    break;
                }
            };
            pulled += 1;
            self.pages += 1;
            if page.is_empty() {
                self.caught_up = true;
                break;
            }
            // The length bound first, before any record is read: a page
            // past it is refused whole, the cursor, the observer and the
            // proof store untouched; only its count and first sequence are
            // recorded.
            if page.len() > MAX_PAGE_RECORDS {
                self.oversized_pages += 1;
                self.stopped = Some(Stopped {
                    code: STOP_OVERSIZED,
                    seq: page[0].seq,
                });
                return pulled;
            }
            // The byte preflight, lengths only: each record within its
            // bounds and the page within its aggregate, before any record
            // is fingerprinted, decoded or copied. A page past them stops
            // the follower, the cursor, the observer and the store
            // untouched. (The bytes were received already; this bounds
            // what is done with them, not the receipt.)
            let mut page_bytes = 0usize;
            for r in &page {
                let n = match preflight(r) {
                    Ok(n) => n,
                    Err(code) => {
                        self.preflight_rejections += 1;
                        self.stopped = Some(Stopped { code, seq: r.seq });
                        return pulled;
                    }
                };
                page_bytes = page_bytes.saturating_add(n);
                if page_bytes > MAX_PAGE_BYTES {
                    self.preflight_rejections += 1;
                    self.stopped = Some(Stopped {
                        code: STOP_PAGE_BYTES,
                        seq: r.seq,
                    });
                    return pulled;
                }
            }
            self.bytes = self.bytes.saturating_add(page_bytes as u64);
            // The feed contract: past the cursor and strictly increasing.
            // Not contiguous: the raw feed's sequence is the chain's global
            // transaction order filtered to this program (airdrops and
            // other programs' transactions take numbers too), so a skipped
            // number is **unknown** to this reader and may hide missing
            // program records — counted and reported
            // (`sequence_holes_unknown`), never a stop and never a claim.
            // Only the archive's renumbered rows are contiguous.
            let mut prev = self.cursor.0;
            let mut holes = 0u64;
            for r in &page {
                if r.seq <= prev {
                    self.stopped = Some(Stopped {
                        code: STOP_PAGE_ORDER,
                        seq: r.seq,
                    });
                    return pulled;
                }
                holes = holes.saturating_add(r.seq - prev - 1);
                prev = r.seq;
            }
            self.sequence_holes = self.sequence_holes.saturating_add(holes);
            self.records += page.len() as u64;
            observer.observe_page(&page, &scope.program);
            let accepted = observer.accepted_prefix;
            if let Some(p) = proofs.as_deref_mut() {
                p.observe_page(&page, scope, accepted);
            }
            if let Some(b) = observer.model.blocked() {
                // The cursor stands at the last record the observer
                // accepted; nothing past it is ever treated as seen.
                if accepted > 0 {
                    let last = &page[accepted - 1];
                    self.cursor = Cursor(last.seq);
                    self.last_slot = Some(last.slot);
                }
                self.stopped = Some(Stopped {
                    code: STOP_OBSERVER_BLOCKED,
                    seq: b.seq,
                });
                return pulled;
            }
            let last = &page[page.len() - 1];
            self.cursor = Cursor(last.seq);
            self.last_slot = Some(last.slot);
        }
        pulled
    }

    /// The status entry: counts, bounds, the cursor, the typed stop.
    pub fn status(&self) -> Value {
        json!({
            "mode": "read-only follow after the legacy feed gate",
            "automatic_writes": false,
            "source_complete": false,
            "history_authenticated": false,
            "legacy_cursors_touched": false,
            "cursor": self.cursor.0,
            "pages_per_tick": self.cap(),
            "hard_cap": PAGES_PER_TICK,
            "max_page_records": MAX_PAGE_RECORDS,
            "ticks": self.ticks,
            "idle_shared_feed": self.idle_shared_feed,
            "caught_up_to_observer": self.caught_up_to_observer,
            "pages": self.pages,
            "records": self.records,
            "sequence_holes_unknown": self.sequence_holes,
            "sequence_note": "the raw feed's sequence is the chain's global order filtered to this program; a skipped number is unknown to this reader: another program's transaction, an airdrop, or a program record it never received — it may hide missing program records, and only a missing linked record between two observed links of the same province or holding is detected (by the chain check)",
            "bytes": self.bytes,
            "oversized_pages": self.oversized_pages,
            "preflight_rejections": self.preflight_rejections,
            "bounds": {
                "record_wire_bytes": MAX_RECORD_WIRE_BYTES,
                "record_log_lines": MAX_RECORD_LOG_LINES,
                "record_log_line_bytes": MAX_RECORD_LOG_LINE_BYTES,
                "record_log_bytes": MAX_RECORD_LOG_BYTES,
                "record_err_bytes": MAX_RECORD_ERR_BYTES,
                "record_post_accounts": MAX_RECORD_POST_ACCOUNTS,
                "record_post_data_bytes": MAX_RECORD_POST_DATA_BYTES,
                "record_bytes": MAX_RECORD_BYTES,
                "page_bytes": MAX_PAGE_BYTES,
            },
            "read_errors": self.read_errors,
            "caught_up": self.caught_up,
            "last_slot": self.last_slot,
            "stopped": self.stopped.map(|s| json!({"code": s.code, "seq": s.seq})),
        })
    }
}
