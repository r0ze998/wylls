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
//! keeper re-reads from cursor 0 (as on localnet), and the poller then
//! rebuilds the log from the cluster's history.
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

use std::sync::Arc;
use std::time::Duration;

use fclient::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};
use fclient::rpc::{Pacer, RpcClient, RpcPort};
use findex::{RpcPoll, Source};
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

/// The polled log behind [`ClusterPort::feed`].
pub struct Polled {
    pub poll: RpcPoll,
    pacing: FeedPacing,
    log: Vec<TxRecord>,
    next: Option<Instant>,
    backoff: Duration,
    last_err: Option<String>,
    held_back: usize,
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
        }
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
        if a < self.log.len() {
            return Ok(self.page(a));
        }
        let now = Instant::now();
        if self.next.is_some_and(|n| now < n) {
            return self.at_head();
        }
        match self.poll.pull().await {
            Ok(recs) => {
                self.backoff = Duration::ZERO;
                self.last_err = None;
                self.held_back = self.poll.held_back();
                self.next = Some(Instant::now() + self.pacing.poll);
                for mut r in recs {
                    r.seq = self.log.len() as u64 + 1;
                    self.log.push(r);
                }
                if a < self.log.len() {
                    Ok(self.page(a))
                } else {
                    self.at_head()
                }
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
    fn statuses_absent_first(
        &self,
        sigs: &[Signature],
        first: &[bool],
    ) -> impl std::future::Future<Output = PortResult<(Vec<Option<Status>>, Vec<bool>)>> + Send
    {
        self.port.statuses_absent_first(sigs, first)
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
