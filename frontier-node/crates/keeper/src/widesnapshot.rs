//! Keeper planner adapters for the shared, default-off fclient snapshot reader.
//! The parser, transport, sealed provenance and Rent math live in fclient;
//! this module preserves the keeper API and its Reads/Step planning semantics.

use std::collections::BTreeMap;
use std::future::Future;

use fclient::ports::{Account, ChainPort, ClockSysvar};
use serde_json::Value;
use solana_address::Address;

use crate::wideduty::{Block, Reads, Step};

pub use fclient::snapshot::{
    rent_sysvar, sysvar_owner, RentSysvar, SnapshotError, SnapshotMeta, ACCOUNT_STORAGE_OVERHEAD,
    CLOCK_LEN, COMMITMENT, MAX_SNAPSHOT_KEYS, RENT_LEN,
};

/// One response: the caller's accounts, the Clock, the Rent when asked.
/// Read through the accessors; the planners take it as [`Snapshot::reads`].
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot(fclient::snapshot::Snapshot);

impl Snapshot {
    pub fn meta(&self) -> &SnapshotMeta {
        self.0.meta()
    }
    pub fn accounts(&self) -> &BTreeMap<Address, Option<Account>> {
        self.0.accounts()
    }
    pub fn clock(&self) -> ClockSysvar {
        self.0.clock()
    }
    pub fn rent(&self) -> Option<RentSysvar> {
        self.0.rent()
    }

    /// The planners' reads over this one response: the accounts, the
    /// Clock and the Rent from the same response, the requested minimum
    /// slot, and the sealed meta (re-verified by every consumer).
    pub fn reads(&self) -> Reads {
        Reads {
            min_slot: self.meta().min_slot(),
            clock: Some(self.clock()),
            accounts: self.accounts().clone(),
            snapshot: Some(self.meta().clone()),
            rent: self.rent(),
        }
    }
}

/// Parse with the shared implementation and attach only the keeper adapter.
pub fn parse_snapshot_response(
    v: &Value,
    keys: &[Address],
    with_rent: bool,
    min_slot: u64,
) -> Result<Snapshot, SnapshotError> {
    fclient::snapshot::parse_snapshot_response(v, keys, with_rent, min_slot).map(Snapshot)
}

/// The additive capability. The default cannot report a context and says
/// so; nothing else about a port changes.
pub trait SnapshotPort {
    /// All of `keys`, the Clock and (when `with_rent`) the Rent in one
    /// response at or past `min_slot`, with its context slot.
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        let _ = (keys, with_rent, min_slot);
        async { Err(SnapshotError::Unsupported) }
    }
}

// Preserve the keeper-facing trait and return type while sharing the actual
// transport and validation with fclient. Custom keeper test ports still implement
// this trait directly; generic fclient ports adapt without copying the parser.
impl<P: fclient::snapshot::SnapshotPort> SnapshotPort for P {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        let pending = fclient::snapshot::SnapshotPort::snapshot(self, keys, with_rent, min_slot);
        async move { pending.await.map(Snapshot) }
    }
}

/// The **object-safe** form of [`SnapshotPort`], so a runtime generic over
/// `ChainPort` alone can carry the snapshot as an **additive, optional**
/// adapter (`Box<dyn SnapshotSource>`) without a new bound on every port
/// implementation. Every `SnapshotPort` is a `SnapshotSource` (blanket
/// impl); the keeper's JSON-RPC port is one, a fake port in a test is one,
/// a port without the capability answers `Unsupported`.
pub trait SnapshotSource: Send + Sync {
    /// [`SnapshotPort::snapshot`], boxed.
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>>;

    /// A label for status output: what the source is, never where (no URL,
    /// no secret).
    fn label(&self) -> &'static str {
        "SnapshotPort: one getMultipleAccounts with minContextSlot, parsed by parse_snapshot_response"
    }
}

impl<T: SnapshotPort + Send + Sync> SnapshotSource for T {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        Box::pin(SnapshotPort::snapshot(self, keys, with_rent, min_slot))
    }
}

/// A boxed future of one snapshot.
pub type SnapshotFuture<'a> =
    std::pin::Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>>;

/// `SnapshotPort::snapshot` of a concrete port type as a plain function
/// pointer: taken where `P: SnapshotPort` is known
/// (`Keeper::enable_wide_snapshot_via_port`) and called later where the
/// runtime only knows `P: ChainPort`. Nothing is boxed or trusted beyond
/// the port the keeper already reads through.
pub type SnapshotFn<P> = for<'a> fn(&'a P, &'a [Address], bool, u64) -> SnapshotFuture<'a>;

/// The function [`SnapshotFn`] points at.
pub fn snapshot_via<'a, P: SnapshotPort>(
    port: &'a P,
    keys: &'a [Address],
    with_rent: bool,
    min_slot: u64,
) -> SnapshotFuture<'a> {
    Box::pin(port.snapshot(keys, with_rent, min_slot))
}

/// The keeper's own read port as a snapshot source, through the function
/// pointer taken when its type was known to implement `SnapshotPort`.
pub struct PortSnapshot<'a, P> {
    pub port: &'a P,
    pub f: SnapshotFn<P>,
}

impl<P: Sync> SnapshotPort for PortSnapshot<'_, P> {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        // The returned future captures the port borrow (the struct's
        // lifetime) and an owned copy of the keys — never the
        // intersection of two independent borrows, which no hidden type
        // could name.
        let port = self.port;
        let f = self.f;
        let keys: Vec<Address> = keys.to_vec();
        async move { f(port, &keys, with_rent, min_slot).await }
    }
}

/// How the runtime's wide review takes its snapshot, if at all.
pub enum SnapshotMode<P> {
    /// No snapshot: ordinary reads, every candidate non-coherent.
    Off,
    /// Through the keeper's **own** read port (preferred: the same node,
    /// the same client, no second relation to trust).
    ViaPort(SnapshotFn<P>),
    /// Through a separately attached source. Its relation to the read
    /// port (same node or not) is the operator's claim and is **not**
    /// verified here; the response is still bound to its own keys,
    /// context slot and sysvars like any other.
    Separate(Box<dyn SnapshotSource>),
}

impl<P> SnapshotMode<P> {
    pub fn label(&self) -> &'static str {
        match self {
            SnapshotMode::Off => "off: ordinary reads only",
            SnapshotMode::ViaPort(_) => "the keeper's own read port (SnapshotPort)",
            SnapshotMode::Separate(_) => {
                "a separately attached source; its relation to the read port is not verified"
            }
        }
    }
}

/// Plans over one snapshot. First the key set is learned through ordinary
/// reads (non-coherent; the planner asks in rounds); then **one** snapshot
/// of every key it asked for plus `extra_keys` (a fee payer whose balance
/// the fee review bounds) is taken at or past `min_slot`; then the plan
/// runs again over that response alone. A plan that asks for a key the
/// snapshot does not hold (the state moved between the two) is
/// `Block::SnapshotIncomplete`, never patched from another read. A plan
/// that says `Block::RentSysvarMissing` while the keys are learned (a
/// Rent-dependent rule) has the Rent sysvar read once for the discovery
/// when `with_rent`; the final judgement still uses the response's own
/// Rent and nothing of the discovery reads.
pub async fn snapshot_plan<P, T, F>(
    port: &P,
    min_slot: u64,
    with_rent: bool,
    extra_keys: &[Address],
    plan: F,
) -> Result<(T, Snapshot), Block>
where
    P: ChainPort + SnapshotPort,
    F: FnMut(&Reads) -> Step<T>,
{
    snapshot_plan_with(port, port, min_slot, with_rent, extra_keys, plan).await
}

/// [`snapshot_plan`] with the ordinary reads from `port` and the one
/// response from a separate `source` (the runtime's additive adapter). The
/// same three steps, the same refusals; the planner closure is the same
/// one the orchestrator path uses.
pub async fn snapshot_plan_with<P, S, T, F>(
    port: &P,
    source: &S,
    min_slot: u64,
    with_rent: bool,
    extra_keys: &[Address],
    mut plan: F,
) -> Result<(T, Snapshot), Block>
where
    P: ChainPort,
    S: SnapshotSource + ?Sized,
    F: FnMut(&Reads) -> Step<T>,
{
    // 1. learn the keys (ordinary reads, lower bound, separate clock).
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    let mut rounds = 0;
    // A planner that judges a Rent-dependent rule (the settlement's divert
    // rule) says `RentSysvarMissing` once every account is in hand; with
    // `with_rent`, the Rent sysvar is then read **once** here (an ordinary
    // read, like the clock) so the key set can be learned. Other planners
    // never say it, so their read counts are unchanged. The judgement in
    // step 3 is over the response's own Rent alone.
    let mut rent_tried = false;
    loop {
        rounds += 1;
        if rounds > 6 {
            return Err(Block::ReadLoop);
        }
        match plan(&reads) {
            Step::Done(Err(Block::RentSysvarMissing(_)))
                if with_rent && !rent_tried && reads.rent.is_none() =>
            {
                rent_tried = true;
                let got = port
                    .accounts(&[rent_sysvar()], min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                reads.rent = match got.as_slice() {
                    [Some(acc)] => RentSysvar::decode(&acc.data),
                    _ => None,
                };
                if reads.rent.is_none() {
                    return Err(Block::RentSysvarMissing("discovery read"));
                }
            }
            Step::Done(Err(b)) => return Err(b),
            Step::Done(Ok(_)) => break,
            Step::Need(addrs) => {
                let got = port
                    .accounts(&addrs, min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                if got.len() != addrs.len() {
                    return Err(Block::Read("account count differs from the request".into()));
                }
                for (a, acc) in addrs.iter().zip(got) {
                    reads.accounts.insert(*a, acc);
                }
            }
        }
    }
    // 2. one response for every key.
    let mut keys: Vec<Address> = reads.accounts.keys().copied().collect();
    for k in extra_keys {
        if !keys.contains(k) {
            keys.push(*k);
        }
    }
    let snap = source
        .snapshot_boxed(&keys, with_rent, min_slot)
        .await
        .map_err(|e| Block::Snapshot(e.code()))?;
    // 3. the plan over that response alone.
    match plan(&snap.reads()) {
        Step::Done(Ok(t)) => Ok((t, snap)),
        Step::Done(Err(b)) => Err(b),
        Step::Need(addrs) => Err(Block::SnapshotIncomplete(addrs.len())),
    }
}
