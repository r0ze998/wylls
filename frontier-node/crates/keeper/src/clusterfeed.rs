//! The keeper's chain port against a public cluster (devnet-readiness B2,
//! runbook G2): `keeper.toml` `feed = "rpc"`.
//!
//! Every [`ChainPort`] call but the feed goes to the wrapped [`RpcPort`].
//! The feed — `frontier_feed` exists only on `frontier-localnet` — comes
//! from [`findex::RpcPoll`], the herald's `--source rpc` poller
//! (`getSignaturesForAddress` + `getTransaction` at `finalized`, with its
//! continuity, origin and witness checks). Its records are numbered in the
//! order they are handed back (1, 2, …) into an in-memory log the keeper
//! reads by cursor exactly as it reads a localnet ledger; a restarted
//! keeper re-reads from cursor 0 (as on localnet). Without a feed store the
//! poller then rebuilds the log from the cluster's history (one
//! `getTransaction` per program transaction: ≈ 110 min for world 3's 4,139).
//!
//! **Feed store (keeper-feed-persist).** With a store ([`Polled::with_store`],
//! `keeper.toml` `feed_store`, by default the directory `<journal>.feed`
//! beside the journal) every polled batch is appended, before any reader
//! sees it, to a [`findex::Archive`] (the herald's crash-safe append-only
//! archive) together with the poller's cursor, so the log and the cursor
//! always move together. A restarted keeper loads the stored log into
//! memory and restores the cursor: its readers still fold the whole
//! history from cursor 0 (the SAME records with the SAME numbers as before
//! the restart, so every derived state is rebuilt exactly as today), but
//! from disk; only the new tail is fetched from the cluster. No restored
//! record is served until the first poll after the restart has succeeded:
//! that poll runs the poller's continuity check (findex G2: the node's
//! history must still reach the stored last signature with nothing in
//! between), so a stored tip the node does not hold (pruned, another
//! cluster, a forged or damaged store) is a detected gap. Then — and when
//! the store cannot be read back or does not check (program, numbering,
//! cursor ↔ last record) — the store is moved aside to
//! `<dir>.discarded-<unix ms>` (never deleted) and the keeper does today's
//! full read into a fresh store. A missing store is a first start: today's
//! full read.
//!
//! **Rate limits.** A poll happens only when the keeper reads at the head
//! of the log, at most once per `feed_poll_ms`; a failed poll waits a
//! doubling backoff (up to `feed_max_backoff_ms`) during which the feed
//! answers `Unavailable` (never an empty page: an empty page means "caught
//! up", and a keeper that is caught up may write). Every JSON-RPC call of
//! the keeper (feed, reads, sends) goes through one [`Pacer`]
//! (`rpc_min_gap_ms`), which also backs everyone off on HTTP 429/503.
//!
//! **Limits (documented, not hidden).** The log is in memory (one program's
//! history; a long season holds every transaction); finalized commitment
//! lags `confirmed` by ~13 s on devnet; within one slot the order is the
//! node's `getSignaturesForAddress` order reversed. A poll that leaves
//! listed signatures not yet retrievable ([`RpcPoll::held_back`]) does not
//! count as caught up either.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fclient::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};
use fclient::rpc::{Pacer, RpcClient, RpcPort};
use findex::{Archive, RpcPoll, Source};
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use tokio::time::Instant;

use crate::config::{FeedSource, KeeperConfig};

/// Records one feed read hands back (as `frontier_feed`'s page).
pub const PAGE: usize = 1_000;

/// When the feed polls and how it backs off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedPacing {
    pub poll: Duration,
    pub max_backoff: Duration,
}

/// The version of the keeper's own wrapper around the poller's cursor in
/// the feed store (`{"keeper_feed", "program", "poll"}`).
pub const STORE_VERSION: u64 = 1;

/// The persisted feed log ([`Polled::with_store`]; module note).
pub struct FeedStore {
    dir: PathBuf,
    program: Address,
    archive: Archive,
}

/// What [`Polled::with_store`] found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreOpened {
    /// No stored record: a first start (today's full read).
    Empty,
    /// This many records restored; served after the first poll checks
    /// the stored tip against the node.
    Restored(usize),
    /// The store did not check and was moved aside to `.1`; a full read.
    Discarded(String, PathBuf),
}

fn io_s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl FeedStore {
    fn open(dir: &Path, program: Address) -> Result<FeedStore, String> {
        let archive = Archive::open(dir, findex::archive::SEGMENT_BYTES).map_err(io_s)?;
        Ok(FeedStore {
            dir: dir.to_path_buf(),
            program,
            archive,
        })
    }

    /// Moves the store aside (never deleted) and opens a fresh one.
    fn discard(dir: &Path, program: Address) -> Result<(FeedStore, PathBuf), String> {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut aside = dir.as_os_str().to_owned();
        aside.push(format!(".discarded-{ms}"));
        let aside = PathBuf::from(aside);
        if dir.exists() {
            std::fs::rename(dir, &aside)
                .map_err(|e| format!("feed store: cannot move {} aside: {e}", dir.display()))?;
        }
        Ok((FeedStore::open(dir, program)?, aside))
    }

    fn wrap(&self, poll: &RpcPoll) -> Value {
        json!({
            "keeper_feed": STORE_VERSION,
            "program": self.program.to_string(),
            "poll": poll.cursor(),
        })
    }

    /// The stored records and the poller cursor, checked: this program,
    /// numbered 1..N, and the cursor's last signature is the last record's.
    fn load(&self) -> Result<(Vec<TxRecord>, Value), String> {
        let c = self.archive.cursor();
        if c.get("keeper_feed").and_then(|x| x.as_u64()) != Some(STORE_VERSION) {
            return Err(format!("not a keeper feed store (v{STORE_VERSION}) cursor"));
        }
        let prog = self.program.to_string();
        if c.get("program").and_then(|x| x.as_str()) != Some(prog.as_str()) {
            return Err(format!(
                "the store is of program {}, keeper.toml names {prog}",
                c.get("program").unwrap_or(&Value::Null)
            ));
        }
        let poll = c.get("poll").cloned().unwrap_or(Value::Null);
        if poll.get("rpc_refused").is_some() {
            return Err("the stored poller cursor is a refused one".into());
        }
        let recs = self.archive.read_after(0).map_err(io_s)?;
        for (i, r) in recs.iter().enumerate() {
            if r.seq != i as u64 + 1 {
                return Err(format!("record {} carries seq {}", i + 1, r.seq));
            }
        }
        if recs.len() as u64 != self.archive.last_seq() {
            return Err(format!(
                "{} records read back, the manifest names {}",
                recs.len(),
                self.archive.last_seq()
            ));
        }
        let last = poll.get("rpc_last").and_then(|x| x.as_str());
        let rec_last = recs.last().map(|r| r.signature.to_string());
        if last != rec_last.as_deref() {
            return Err(format!(
                "the stored cursor ends at {last:?}, the last stored record is {rec_last:?}"
            ));
        }
        Ok((recs, poll))
    }
}

/// One line for the keeper's log.
pub fn describe(o: &StoreOpened) -> String {
    match o {
        StoreOpened::Empty => "empty (first start: the whole history is read)".into(),
        StoreOpened::Restored(n) => format!(
            "{n} records restored; only the new tail is read (served once the first poll checks the stored tip)"
        ),
        StoreOpened::Discarded(why, aside) => format!(
            "did not check ({why}); moved aside to {}, the whole history is read",
            aside.display()
        ),
    }
}

/// The polled log behind [`ClusterPort::feed`].
pub struct Polled {
    pub poll: RpcPoll,
    pacing: FeedPacing,
    log: Vec<TxRecord>,
    next: Option<Instant>,
    backoff: Duration,
    last_err: Option<String>,
    held_back: usize,
    store: Option<FeedStore>,
    /// A restored log not yet checked against the node (the first poll
    /// after a restart): nothing of it is served.
    unproven: bool,
}

impl Polled {
    pub fn new(poll: RpcPoll, pacing: FeedPacing) -> Polled {
        Polled {
            poll,
            pacing,
            log: vec![],
            next: None,
            backoff: Duration::ZERO,
            last_err: None,
            held_back: 0,
            store: None,
            unproven: false,
        }
    }

    /// Persists the log in `dir` (module note: feed store) and restores
    /// what it holds. An unreadable or unchecked store is moved aside and a
    /// fresh one opened (a full read); `Err` only when no store can be
    /// opened at all.
    pub fn with_store(
        mut self,
        dir: &Path,
        program: Address,
    ) -> Result<(Polled, StoreOpened), String> {
        let found = match FeedStore::open(dir, program) {
            Err(e) => Err(format!("cannot open: {e}")),
            Ok(st) if st.archive.last_seq() == 0 => Ok((st, None)),
            Ok(st) => match st.load() {
                Ok(loaded) => Ok((st, Some(loaded))),
                Err(e) => Err(e),
            },
        };
        let opened = match found {
            Ok((st, None)) => {
                self.store = Some(st);
                StoreOpened::Empty
            }
            Ok((st, Some((recs, cursor)))) => {
                self.poll.restore(&cursor);
                let n = recs.len();
                self.log = recs;
                self.unproven = true;
                self.store = Some(st);
                StoreOpened::Restored(n)
            }
            Err(why) => {
                let (st, aside) = FeedStore::discard(dir, program)?;
                self.store = Some(st);
                StoreOpened::Discarded(why, aside)
            }
        };
        Ok((self, opened))
    }

    /// Whether the restored log still waits for its first checked poll.
    pub fn unproven(&self) -> bool {
        self.unproven
    }

    /// Records held (the log's last seq).
    pub fn len(&self) -> usize {
        self.log.len()
    }

    pub fn is_empty(&self) -> bool {
        self.log.is_empty()
    }

    /// The current backoff (zero after a good poll).
    pub fn backoff(&self) -> Duration {
        self.backoff
    }

    fn page(&self, a: usize) -> Vec<TxRecord> {
        self.log[a..(a + PAGE).min(self.log.len())].to_vec()
    }

    fn at_head(&self) -> PortResult<Vec<TxRecord>> {
        if let Some(e) = &self.last_err {
            return Err(PortError::Unavailable(format!(
                "cluster feed backing off {} ms after: {e}",
                self.backoff.as_millis()
            )));
        }
        if self.held_back > 0 {
            return Err(PortError::Unavailable(format!(
                "cluster feed: {} listed signatures not retrievable yet",
                self.held_back
            )));
        }
        Ok(vec![])
    }

    /// Records with `seq > after` (at most [`PAGE`]); polls the cluster
    /// when `after` is the head of the log and the pacing allows.
    pub async fn read(&mut self, after: Cursor) -> PortResult<Vec<TxRecord>> {
        let a = usize::try_from(after.0).unwrap_or(usize::MAX);
        if a > self.log.len() {
            return Err(PortError::Unavailable(format!(
                "cluster feed: cursor {a} is past the polled log ({} records)",
                self.log.len()
            )));
        }
        if a < self.log.len() && !self.unproven {
            return Ok(self.page(a));
        }
        let now = Instant::now();
        if self.next.is_some_and(|n| now < n) {
            if self.unproven {
                return Err(PortError::Unavailable(format!(
                    "cluster feed: {} restored records wait for a poll that checks them against the node (backing off {} ms)",
                    self.log.len(),
                    self.backoff.as_millis()
                )));
            }
            return self.at_head();
        }
        let before = self.store.as_ref().map(|_| self.poll.cursor());
        let pulled = match self.poll.pull().await {
            Ok(recs) => self.keep(recs, before),
            Err(e) => Err(e),
        };
        match pulled {
            Ok(()) => {
                self.unproven = false;
                self.backoff = Duration::ZERO;
                self.last_err = None;
                self.held_back = self.poll.held_back();
                self.next = Some(Instant::now() + self.pacing.poll);
                if a < self.log.len() {
                    Ok(self.page(a))
                } else {
                    self.at_head()
                }
            }
            Err(PortError::Unavailable(m)) if self.unproven && m.starts_with("history gap") => {
                // The stored tip is not on the node's history (or not
                // without a gap): nothing of it was served; start over.
                let n = self.log.len();
                let aside = self.discard_store()?;
                Err(PortError::Unavailable(format!(
                    "cluster feed: the {n} restored records do not continue on the node ({m}); store moved aside to {}, re-reading the whole history",
                    aside.display()
                )))
            }
            Err(e) => {
                self.backoff = (self.backoff * 2)
                    .max(self.pacing.poll)
                    .min(self.pacing.max_backoff);
                self.next = Some(Instant::now() + self.backoff);
                self.last_err = Some(e.to_string());
                Err(e)
            }
        }
    }

    /// Appends a pulled batch: first to the store (with the poller's new
    /// cursor, durable on return), then to the log. A store write that
    /// fails puts the poller back on `before` (the stored cursor), so the
    /// batch is pulled again and nothing is served that is not stored.
    fn keep(&mut self, recs: Vec<TxRecord>, before: Option<Value>) -> PortResult<()> {
        let recs = match self.store.as_mut() {
            None => recs,
            Some(_) if recs.is_empty() => recs,
            Some(st) => {
                let cursor = st.wrap(&self.poll);
                match st.archive.append(&recs, cursor) {
                    Ok(stored) => stored,
                    Err(e) => {
                        if let Some(b) = &before {
                            self.poll.restore(b);
                        }
                        return Err(PortError::Unavailable(format!(
                            "cluster feed: the feed store could not be written ({e}); the batch is pulled again"
                        )));
                    }
                }
            }
        };
        for mut r in recs {
            let seq = self.log.len() as u64 + 1;
            if self.store.is_some() && r.seq != seq {
                return Err(PortError::Unavailable(format!(
                    "cluster feed: the store numbered a record {} where the log expects {seq}",
                    r.seq
                )));
            }
            r.seq = seq;
            self.log.push(r);
        }
        Ok(())
    }

    /// Moves the store aside, empties the log and resets the poller to a
    /// first pull (its origin and witness kept): today's full read.
    /// A store that cannot be moved aside stays as it is (still
    /// unproven: nothing served; the next poll tries again after a back-off).
    fn discard_store(&mut self) -> PortResult<PathBuf> {
        let Some((dir, program)) = self.store.as_ref().map(|s| (s.dir.clone(), s.program)) else {
            return Err(PortError::Unavailable("cluster feed: no feed store".into()));
        };
        let (st, aside) = match FeedStore::discard(&dir, program) {
            Ok(x) => x,
            Err(e) => {
                self.backoff = (self.backoff * 2)
                    .max(self.pacing.poll)
                    .min(self.pacing.max_backoff);
                self.next = Some(Instant::now() + self.backoff);
                self.last_err = Some(e.clone());
                return Err(PortError::Unavailable(e));
            }
        };
        self.store = Some(st);
        self.log.clear();
        self.poll.restore(&Value::Null);
        self.unproven = false;
        self.next = None;
        self.backoff = Duration::ZERO;
        self.last_err = None;
        self.held_back = 0;
        Ok(aside)
    }
}

/// [`RpcPort`] with its feed from [`Polled`] (`feed = "rpc"`) or from the
/// port itself (`feed = "localnet"`).
pub struct ClusterPort {
    pub port: RpcPort,
    pub feed: Option<tokio::sync::Mutex<Polled>>,
}

/// The longest penalty a 429/503 imposes on the keeper's RPC calls.
pub const MAX_PENALTY: Duration = Duration::from_secs(30);

/// The one pacer of `cfg`'s RPC calls (`None`: unpaced).
pub fn pacer(cfg: &KeeperConfig) -> Option<Arc<Pacer>> {
    let gap = cfg.rpc_min_gap();
    (!gap.is_zero()).then(|| Pacer::new(gap, MAX_PENALTY))
}

fn client(url: &str, p: &Option<Arc<Pacer>>) -> RpcClient {
    let c = RpcClient::new(url);
    match p {
        Some(p) => c.with_pacer(p.clone()),
        None => c,
    }
}

/// A read port of `rpc` on `pacer` (the `/v1/reveal` gate: clock and
/// accounts only, no feed).
pub fn read_port(cfg: &KeeperConfig, rpc: &str, pacer: &Option<Arc<Pacer>>) -> RpcPort {
    let mut port = match cfg.feed {
        FeedSource::Localnet => RpcPort::localnet(rpc, cfg.program),
        FeedSource::Rpc => RpcPort::new(rpc, cfg.program),
    };
    port.rpc = client(rpc, pacer);
    port
}

impl ClusterPort {
    /// The port `keeper.toml` asks for, every client of `rpc` on `pacer`
    /// ([`pacer`]; no I/O here).
    pub fn from_config(
        cfg: &KeeperConfig,
        rpc: &str,
        pacer: &Option<Arc<Pacer>>,
    ) -> Result<ClusterPort, String> {
        let gap = cfg.rpc_min_gap();
        let pacer = pacer.clone();
        match cfg.feed {
            FeedSource::Localnet => {
                let mut port = RpcPort::localnet(rpc, cfg.program);
                port.rpc = client(rpc, &pacer);
                Ok(ClusterPort { port, feed: None })
            }
            FeedSource::Rpc => {
                let mut port = RpcPort::new(rpc, cfg.program);
                port.rpc = client(rpc, &pacer);
                let mut poll = RpcPoll::new(rpc, cfg.program);
                poll.rpc = client(rpc, &pacer);
                if let Some(o) = &cfg.feed_origin {
                    poll = poll.with_origin(
                        o.parse::<Signature>()
                            .map_err(|_| "`feed_origin`: not a signature".to_string())?,
                    );
                }
                if let Some(w) = &cfg.feed_witness {
                    // Another endpoint: its own pacer (its own limit).
                    let wp = (!gap.is_zero()).then(|| Pacer::new(gap, MAX_PENALTY));
                    poll.witness = Some(client(w, &wp));
                }
                let pacing = FeedPacing {
                    poll: Duration::from_millis(cfg.feed_poll_ms),
                    max_backoff: Duration::from_millis(cfg.feed_max_backoff_ms),
                };
                Ok(ClusterPort::polled(port, poll, pacing))
            }
        }
    }

    /// Persists the polled feed in `dir` ([`Polled::with_store`]); a
    /// `feed = "localnet"` port has nothing to persist (`Empty`).
    pub fn persist_feed(&mut self, dir: &Path, program: Address) -> Result<StoreOpened, String> {
        let Some(m) = self.feed.take() else {
            return Ok(StoreOpened::Empty);
        };
        let (p, opened) = m.into_inner().with_store(dir, program)?;
        self.feed = Some(tokio::sync::Mutex::new(p));
        Ok(opened)
    }

    pub fn polled(port: RpcPort, poll: RpcPoll, pacing: FeedPacing) -> ClusterPort {
        ClusterPort {
            port,
            feed: Some(tokio::sync::Mutex::new(Polled::new(poll, pacing))),
        }
    }
}

impl ChainPort for ClusterPort {
    fn clock(&self) -> impl std::future::Future<Output = PortResult<ClockSysvar>> + Send {
        self.port.clock()
    }
    fn accounts(
        &self,
        keys: &[Address],
        min_slot: u64,
    ) -> impl std::future::Future<Output = PortResult<Vec<Option<Account>>>> + Send {
        self.port.accounts(keys, min_slot)
    }
    fn simulate(
        &self,
        tx: &[u8],
    ) -> impl std::future::Future<Output = PortResult<SimResult>> + Send {
        self.port.simulate(tx)
    }
    fn send(&self, tx: &[u8]) -> impl std::future::Future<Output = PortResult<Signature>> + Send {
        self.port.send(tx)
    }
    fn statuses(
        &self,
        sigs: &[Signature],
    ) -> impl std::future::Future<Output = PortResult<Vec<Option<Status>>>> + Send {
        self.port.statuses(sigs)
    }
    fn statuses_absent(
        &self,
        sigs: &[Signature],
    ) -> impl std::future::Future<Output = PortResult<(Vec<Option<Status>>, Vec<bool>)>> + Send
    {
        self.port.statuses_absent(sigs)
    }
    async fn feed(&self, after: Cursor) -> PortResult<Vec<TxRecord>> {
        match &self.feed {
            None => self.port.feed(after).await,
            Some(m) => m.lock().await.read(after).await,
        }
    }
    async fn feed_scan(
        &self,
        after: Cursor,
    ) -> PortResult<(Vec<TxRecord>, Option<fclient::ports::FeedScan>)> {
        match &self.feed {
            None => self.port.feed_scan(after).await,
            Some(m) => Ok((m.lock().await.read(after).await?, None)),
        }
    }
    fn blockhash(&self) -> impl std::future::Future<Output = PortResult<(Hash, u64)>> + Send {
        self.port.blockhash()
    }
}

#[cfg(feature = "wide-world-experimental")]
impl fclient::snapshot::SnapshotPort for ClusterPort {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl std::future::Future<
        Output = Result<fclient::snapshot::Snapshot, fclient::snapshot::SnapshotError>,
    > + Send {
        fclient::snapshot::SnapshotPort::snapshot(&self.port, keys, with_rent, min_slot)
    }
}
