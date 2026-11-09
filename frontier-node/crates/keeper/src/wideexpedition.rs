//! Read-only original-host expedition inspection for the existing keeper.
//!
//! Unlike `wideduty::plan_return`, this path reads the original Holding and
//! home Province, owned bridge v2, and the wide standing Province/roster. It
//! never substitutes a shadow wide Holding for an original issuer. The
//! resident checks mirror `proc/wide_expedition_resident.rs`, including the
//! capture lock, issuance, full roster identity and raw voluntary-Leave payload.
//!
//! These are observations and next-read/action prerequisites, NOT executable
//! candidates. Original-host resident Dissolve/Return have no public wire
//! dispatch. No tag, instruction, transaction, signer, write spec or send path
//! exists here. Even a coherent snapshot establishes neither current state nor
//! authenticated expedition/Resolve history. Absence cannot prove completion.

use fclient::clock::SeasonClock;
use fclient::decode::{Citizen, Holding, Province};
use fclient::ports::{Account, ChainPort, DrandPort};
use frontier_abi::bytes::{rd_u16, rd_u32, rd_u64, rd_u8};
use frontier_abi::entry::{find_entry, read_entry, EntryOp};
use frontier_abi::layout::player::transit as T;
use frontier_abi::layout::province::entry as E;
use frontier_abi::prologue::{
    holding_transit_occupancy, resident_ok, AccountView, TransitOccupancy,
};
use frontier_abi::v2::layout::{player::holding as H, province::province as P, AccountKind};
use frontier_abi::v2::prologue::check_present_v2;
use frontier_abi::world_index::expedition::{AccountFamily, AccountResolver};
use frontier_abi::world_index::expedition_bridge::authenticate_pair;
use frontier_abi::world_index::expedition_transport::OwnedBridgeTransit;
use frontier_abi::world_index::{
    holding as wh, march, resolve, roster, wide_host_alias, MarchState, ProvinceKey, WideHostRef,
};
use serde_json::{json, Value};
use solana_address::Address;

use crate::wideduty::{self, Block, Deployment, Reads, Scope};
use crate::widesnapshot::{SnapshotError, SnapshotPort, SnapshotSource};

pub const KIND: &str = "original-expedition-review";

/// Full, explicit selection. `original_owner` is the departure Citizen account,
/// never a wallet, short owner tag, mutable captor or a claim of provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub host: WideHostRef,
    pub standing: ProvinceKey,
    pub original_owner: Address,
}

/// Exact canonical accounts, all fetched together with Clock. Private fields
/// prevent callers from replacing a canonical read destination after validation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadPlan {
    holding: Address,
    home: Address,
    standing: Address,
    roster: Address,
    bridges: [Address; H::TRANSIT_N],
    keys: Vec<Address>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    State(Block),
    HostMustBeOriginal,
    StandingMustBeWide,
    OriginalOwnerRequired,
    MissingReads(Vec<Address>),
    ExecutableAccount(Address),
    OriginalAccount(&'static str),
    SourceGeneration,
    SourceNotLive,
    HostNotIssued,
    OwnerChanged,
    CitizenBinding,
    InvalidTransitOccupancy,
    OrdinaryTransitOpen,
    DuplicateTransit,
    OwnedBridgeRequired,
    BridgePair,
    BridgeOwner,
    BridgeDestination,
    OrphanBridge,
    ResidentMissingHistoryRequired,
    LeavePayloadUnsupported,
    ResidentBusy,
    ResolveBehind,
    ClockMissing,
    ClockBeforeGenesis,
    PendingBellInFuture,
    Snapshot(SnapshotError),
}

impl From<Block> for Refusal {
    fn from(value: Block) -> Self {
        Self::State(value)
    }
}

impl ReadPlan {
    pub fn new(scope: &Scope, selected: Selection) -> Result<Self, Refusal> {
        let ctx = wideduty::ctx_of(scope);
        let resolver = AccountResolver::for_season(&ctx).map_err(|_| Block::World)?;
        if resolver
            .family(selected.host.key())
            .map_err(|_| Block::World)?
            != AccountFamily::Legacy
        {
            return Err(Refusal::HostMustBeOriginal);
        }
        if resolver
            .family(selected.standing)
            .map_err(|_| Block::World)?
            != AccountFamily::Wide
        {
            return Err(Refusal::StandingMustBeWide);
        }
        let id = resolver
            .legacy_host_id(&selected.host)
            .map_err(|_| Refusal::HostMustBeOriginal)?;
        if resolver
            .legacy_host_ref(id)
            .map_err(|_| Refusal::HostMustBeOriginal)?
            != selected.host
        {
            return Err(Refusal::HostMustBeOriginal);
        }
        let holding = wideduty::addr(
            resolver
                .holding_address(&selected.host)
                .map_err(|_| Block::World)?,
        );
        let home = wideduty::addr(
            resolver
                .province_address(selected.host.key())
                .map_err(|_| Block::World)?,
        );
        let standing = wideduty::addr(
            resolver
                .province_address(selected.standing)
                .map_err(|_| Block::World)?,
        );
        let roster = wideduty::addr(roster::roster_address(&ctx, selected.standing));
        let bridges = std::array::from_fn(|slot| {
            wideduty::addr(march::transit_address(
                &ctx,
                &holding.to_bytes(),
                slot as u8,
            ))
        });
        let mut keys = vec![
            scope.season,
            holding,
            home,
            standing,
            roster,
            selected.original_owner,
        ];
        keys.extend(bridges);
        if selected.original_owner == Address::default()
            || keys[..5].contains(&selected.original_owner)
            || bridges.contains(&selected.original_owner)
        {
            return Err(Refusal::OriginalOwnerRequired);
        }
        Ok(Self {
            holding,
            home,
            standing,
            roster,
            bridges,
            keys,
        })
    }
    pub fn keys(&self) -> &[Address] {
        &self.keys
    }
    pub fn holding(&self) -> Address {
        self.holding
    }
    pub fn home(&self) -> Address {
        self.home
    }
    pub fn standing(&self) -> Address {
        self.standing
    }
    pub fn roster(&self) -> Address {
        self.roster
    }
    pub fn bridges(&self) -> &[Address; H::TRANSIT_N] {
        &self.bridges
    }
}

/// Prerequisite only, not a declaration that its handler would execute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    OriginalDepartureResolution,
    OriginalDepartureSettlement,
    RevealOrGatherEvidence,
    OriginDestroyedSettlementOrCleanupEvidence,
    DestinationResolveOrSettlementEvidence,
    OwnerDissolve,
    ResolveVoluntaryLeave,
    ReturnOriginalReserve,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observed {
    Bridge {
        slot: u8,
        state: MarchState,
        depart_bell: u32,
        arrive_bell: u32,
        destination_bound: bool,
    },
    Resident {
        entry: u8,
        state: u8,
        unit: u8,
        troops_milli: u32,
        pending_bell: u32,
        resolved_next: u32,
        return_units: Option<u32>,
        reserve_after: Option<u32>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineFacts {
    pub feed_writes_allowed: bool,
    pub kind_allowed: bool,
    pub already_pending: bool,
    pub care_unresolved: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub selected: Selection,
    pub accounts: ReadPlan,
    pub next: Next,
    pub observed: Observed,
    pub min_slot: u64,
    pub context_slot: Option<u64>,
    pub clock_slot: u64,
    pub clock_timestamp: i64,
    pub bell: u32,
    pub status_promoted_by_clock: bool,
    pub engine: Option<EngineFacts>,
}

impl Report {
    pub fn key(&self) -> String {
        format!(
            "{KIND}:{}:{}:{}",
            hex::encode(self.selected.host.to_bytes()),
            hex::encode(self.selected.standing.to_bytes()),
            self.selected.original_owner
        )
    }
    /// Admission is unconditionally denied, independent of mutable report
    /// fields or engine state. A nonexistent wire tag is JSON null, never 0xDC.
    pub fn describe(&self) -> Value {
        let mut denials = vec![
            "OriginalHostDispatchUnavailable",
            "SourceProvenanceUnverified",
            "HistoryUnverified",
            "ExecutionEvidenceUnverified",
            "SignerAbsent",
            "SliceDoesNotEnqueue",
        ];
        if self.next == Next::OwnerDissolve {
            denials.push("WalletAuthorizationAndPlayerPrologueUnverified");
        }
        denials.push(if self.context_slot.is_some() {
            "SnapshotCurrencyUnknown"
        } else {
            "NoCoherentSnapshot"
        });
        if let Some(e) = &self.engine {
            if !e.feed_writes_allowed {
                denials.push("FeedWritesPaused");
            }
            if !e.kind_allowed {
                denials.push("KindNotAllowed");
            }
            if e.already_pending {
                denials.push("AlreadyPending");
            }
            if e.care_unresolved {
                denials.push("CareUnresolved");
            }
        }
        let observed = match &self.observed {
            Observed::Bridge {
                slot,
                state,
                depart_bell,
                arrive_bell,
                destination_bound,
            } => json!({
                "kind": "owned-bridge-v2", "slot": slot, "state": format!("{state:?}"), "depart_bell": depart_bell.to_string(), "arrive_bell": arrive_bell.to_string(), "destination_bound": destination_bound,
            }),
            Observed::Resident {
                entry,
                state,
                unit,
                troops_milli,
                pending_bell,
                resolved_next,
                return_units,
                reserve_after,
            } => json!({
                "kind": "original-host-wide-resident", "entry": entry, "state": state, "unit": unit, "troops_milli": troops_milli.to_string(), "pending_bell": pending_bell.to_string(), "resolved_next": resolved_next.to_string(), "return_units": return_units.map(|v| v.to_string()), "reserve_after": reserve_after.map(|v| v.to_string()),
            }),
        };
        json!({
            "key": self.key(), "kind": KIND, "host": hex::encode(self.selected.host.to_bytes()),
            "standing_key": hex::encode(self.selected.standing.to_bytes()), "original_owner": self.selected.original_owner.to_string(),
            "accounts": { "original_holding": self.accounts.holding.to_string(), "original_home": self.accounts.home.to_string(), "wide_standing": self.accounts.standing.to_string(), "wide_roster": self.accounts.roster.to_string(), "owned_bridges": self.accounts.bridges.iter().map(ToString::to_string).collect::<Vec<_>>() },
            "next_prerequisite": format!("{:?}", self.next), "observed": observed,
            "min_slot": self.min_slot.to_string(), "context_slot": self.context_slot.map(|v| v.to_string()),
            "clock": { "slot": self.clock_slot.to_string(), "unix_timestamp": self.clock_timestamp.to_string(), "bell": self.bell.to_string(), "status_promoted_by_clock": self.status_promoted_by_clock },
            "coherent": self.context_slot.is_some(), "provenance_verified": false, "history_verified": false,
            "dispatch_available": false, "tag": null, "instruction": null, "admitted": false,
            "signed": false, "enqueued": false, "automatic_send": false, "completion_proven": false,
            "denials": denials,
        })
    }
}

fn account<'a>(
    reads: &'a Reads,
    scope: &Scope,
    address: Address,
    name: &'static str,
) -> Result<&'a Account, Refusal> {
    let account =
        wideduty::presence(reads, &address, &scope.program, name)?.ok_or(Block::Absent(name))?;
    if account.executable {
        return Err(Refusal::ExecutableAccount(address));
    }
    Ok(account)
}

fn original<'a>(
    reads: &'a Reads,
    scope: &Scope,
    address: Address,
    kind: AccountKind,
    season: u64,
    name: &'static str,
) -> Result<&'a [u8], Refusal> {
    let a = account(reads, scope, address, name)?;
    let address_bytes = address.to_bytes();
    let owner = a.owner.to_bytes();
    let view = AccountView {
        key: &address_bytes,
        owner: &owner,
        lamports: a.lamports,
        data: &a.data,
        is_signer: false,
        is_writable: false,
    };
    check_present_v2(&view, &scope.program.to_bytes(), kind, season)
        .map_err(|_| Refusal::OriginalAccount(name))?;
    Ok(&a.data)
}

/// Pure inspection over existing keeper read types. It never fills missing
/// snapshot keys from another response and never trusts a copied snapshot seal.
pub fn plan(scope: &Scope, selected: Selection, reads: &Reads) -> Result<Report, Refusal> {
    let keys = ReadPlan::new(scope, selected)?;
    let missing = wideduty::missing(reads, keys.keys());
    if !missing.is_empty() {
        return Err(Refusal::MissingReads(missing));
    }
    for (address, a) in &reads.accounts {
        if keys.keys.contains(address) && a.as_ref().is_some_and(|a| a.executable) {
            return Err(Refusal::ExecutableAccount(*address));
        }
    }
    let (season, promoted) = wideduty::season_of(scope, reads)?;
    let now = reads.clock.ok_or(Refusal::ClockMissing)?;
    let bell = SeasonClock::from_season(&season)
        .bell_at(now.unix_timestamp)
        .ok_or(Refusal::ClockBeforeGenesis)?;
    let ctx = wideduty::ctx_of(scope);
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| Block::World)?;
    let id = resolver
        .legacy_host_id(&selected.host)
        .map_err(|_| Refusal::HostMustBeOriginal)?;
    let hd = original(
        reads,
        scope,
        keys.holding,
        AccountKind::Holding,
        season.h.season_id,
        "original holding",
    )?;
    let home = original(
        reads,
        scope,
        keys.home,
        AccountKind::Province,
        season.h.season_id,
        "original home",
    )?;
    let holding = Holding::decode(hd).map_err(|_| Refusal::OriginalAccount("holding"))?;
    let province = Province::decode(home).map_err(|_| Refusal::OriginalAccount("home"))?;
    let parts = frontier_abi::addr::split_host_id(id).ok_or(Refusal::HostMustBeOriginal)?;
    if i32::from(holding.p) != parts.province.p
        || i32::from(holding.q) != parts.province.q
        || holding.site != parts.site
        || province.p != holding.p
        || province.q != holding.q
    {
        return Err(Refusal::OriginalAccount("source identity"));
    }
    let occupancy = holding_transit_occupancy(&ctx, &keys.holding.to_bytes(), hd)
        .map_err(|_| Refusal::InvalidTransitOccupancy)?;
    let matches: Vec<_> = occupancy
        .iter()
        .enumerate()
        .filter(|(i, state)| {
            **state != TransitOccupancy::Free && rd_u64(hd, H::transit(*i) + T::HOST_ID) == Some(id)
        })
        .collect();
    if matches.len() > 1 {
        return Err(Refusal::DuplicateTransit);
    }
    let (next, observed) = if let Some(&(slot, occupancy)) = matches.first() {
        let TransitOccupancy::Bridge(marker) = occupancy else {
            return Err(Refusal::OrdinaryTransitOpen);
        };
        let a = account(reads, scope, keys.bridges[slot], "owned bridge")?;
        let bridge = OwnedBridgeTransit::from_bytes(&ctx, &a.data)
            .map_err(|_| Refusal::OwnedBridgeRequired)?;
        if bridge.original_owner() != selected.original_owner.to_bytes() {
            return Err(Refusal::BridgeOwner);
        }
        if bridge.transit().host != selected.host {
            return Err(Refusal::BridgePair);
        }
        authenticate_pair(
            &ctx,
            &keys.holding.to_bytes(),
            slot as u8,
            &keys.bridges[slot].to_bytes(),
            marker,
            bridge.common(),
        )
        .map_err(|_| Refusal::BridgePair)?;
        let t = bridge.transit();
        if t.dest.is_some_and(|dest| dest != selected.standing) {
            return Err(Refusal::BridgeDestination);
        }
        // Capture may change the issuer while a bridge is open. Do not apply
        // current-owner/generation resident-return rules to its historical owner.
        let next = match t.state {
            MarchState::Departed => {
                let origin = wideduty::addr(
                    resolver
                        .province_address(t.origin.key())
                        .map_err(|_| Block::World)?,
                );
                if origin != keys.home {
                    // The original standing origin may differ from its issuer.
                    // No inference from the home Province's resolved clock.
                    Next::OriginalDepartureResolution
                } else if province.resolved_next > t.depart_bell {
                    Next::OriginalDepartureSettlement
                } else {
                    Next::OriginalDepartureResolution
                }
            }
            MarchState::Settled => Next::RevealOrGatherEvidence,
            MarchState::DestroyedAtOrigin => Next::OriginDestroyedSettlementOrCleanupEvidence,
            MarchState::Gathered => Next::DestinationResolveOrSettlementEvidence,
            MarchState::Free => return Err(Refusal::BridgePair),
        };
        (
            next,
            Observed::Bridge {
                slot: slot as u8,
                state: t.state,
                depart_bell: t.depart_bell,
                arrive_bell: t.arrive_bell,
                destination_bound: t.dest.is_some(),
            },
        )
    } else {
        // An envelope retained after its marker disappears is cleanup/history
        // evidence, never permission to treat this as an ordinary wide return.
        for key in keys.bridges {
            if let Some(a) = wideduty::presence(reads, &key, &scope.program, "owned bridge")? {
                let bridge = OwnedBridgeTransit::from_bytes(&ctx, &a.data)
                    .map_err(|_| Refusal::OwnedBridgeRequired)?;
                if bridge.transit().host == selected.host {
                    return Err(Refusal::OrphanBridge);
                }
            }
        }
        if holding.gen != selected.host.gen() {
            return Err(Refusal::SourceGeneration);
        }
        if !matches!(holding.state, H::STATE_PROVISIONAL | H::STATE_FINAL) {
            return Err(Refusal::SourceNotLive);
        }
        if selected.host.seq() >= holding.host_seq {
            return Err(Refusal::HostNotIssued);
        }
        if holding.owner_citizen != selected.original_owner {
            return Err(Refusal::OwnerChanged);
        }
        wideduty::capture_lock_of(home, hd)?;
        let (_, pd) = wideduty::province_at(
            reads,
            scope,
            &ctx,
            &keys.standing,
            season.h.season_id,
            selected.standing.world(),
            "wide standing",
        )?
        .ok_or(Block::Absent("wide standing"))?;
        let (roster, rd) = wideduty::roster_at(
            reads,
            scope,
            &keys.roster,
            season.h.season_id,
            selected.standing,
        )?
        .ok_or(Refusal::ResidentMissingHistoryRequired)?;
        roster
            .validate_paired(rd, &resolve::live_ids(pd).map_err(|_| Block::BadEntry)?)
            .map_err(|_| Block::RosterUnpaired)?;
        let index = find_entry(pd, wide_host_alias(&selected.host))
            .ok_or(Refusal::ResidentMissingHistoryRequired)?;
        let entry = read_entry(pd, index).map_err(|_| Block::BadEntry)?;
        if !roster.entry_matches(rd, index, entry.id, &selected.host) {
            return Err(Block::EntryUnpaired.into());
        }
        if entry.unit as usize >= H::RESERVE_N {
            return Err(Block::BadEntry.into());
        }
        let resolved_next = rd_u32(pd, P::RESOLVED_NEXT).ok_or(Block::BadEntry)?;
        let mut return_units = None;
        let mut reserve_after = None;
        let next = match (entry.state, entry.op) {
            (E::STATE_ROSTER, EntryOp::None) => {
                if holding.state != H::STATE_FINAL {
                    return Err(Refusal::SourceNotLive);
                }
                if !resident_ok(resolved_next, bell) || entry.from_bell > bell {
                    return Err(Refusal::ResolveBehind);
                }
                let cd = original(
                    reads,
                    scope,
                    selected.original_owner,
                    AccountKind::Citizen,
                    season.h.season_id,
                    "original citizen",
                )?;
                let citizen =
                    Citizen::decode(cd).map_err(|_| Refusal::OriginalAccount("citizen"))?;
                if citizen.resident_asset.is_some()
                    || ctx.citizen(&citizen.wallet.to_bytes()) != selected.original_owner.to_bytes()
                    || citizen.faction != entry.faction
                    || wh::binding_of(cd, holding.order).map_err(|_| Refusal::CitizenBinding)?
                        != wh::SlotBinding::Legacy(wh::HoldingRef {
                            p: holding.p,
                            q: holding.q,
                            site: holding.site,
                            gen: holding.gen,
                        })
                {
                    return Err(Refusal::CitizenBinding);
                }
                if season.status == fclient::abi::status::ENDED {
                    return Err(Block::SeasonEnded.into());
                }
                wideduty::chain_headroom(cd, 1, "original citizen")?;
                Next::OwnerDissolve
            }
            (E::STATE_ROSTER | E::STATE_DEPARTED, EntryOp::Leave) => {
                let row = P::entry(index);
                if rd_u8(pd, row + E::OP_A) != Some(0)
                    || rd_u16(pd, row + E::OP_B) != Some(0)
                    || rd_u32(pd, row + E::OP_TROOPS) != Some(0)
                    || rd_u32(pd, row + E::OP_REF) != Some(0)
                {
                    return Err(Refusal::LeavePayloadUnsupported);
                }
                if entry.pend_bell > bell {
                    return Err(Refusal::PendingBellInFuture);
                }
                if entry.state == E::STATE_ROSTER || resolved_next <= entry.pend_bell {
                    Next::ResolveVoluntaryLeave
                } else {
                    let units = entry.troops / permutation_rules::fixed::MILLI as u32;
                    reserve_after = Some(
                        holding.reserve[entry.unit as usize]
                            .checked_add(units)
                            .ok_or(Block::ReserveOverflow { unit: entry.unit })?,
                    );
                    return_units = Some(units);
                    if rd_u8(pd, P::N_ENTRIES).is_none_or(|n| n == 0) {
                        return Err(Block::BadEntry.into());
                    }
                    Next::ReturnOriginalReserve
                }
            }
            _ => return Err(Refusal::ResidentBusy),
        };
        wideduty::chain_headroom(hd, 1, "original holding")?;
        wideduty::chain_headroom(pd, 1, "wide standing")?;
        (
            next,
            Observed::Resident {
                entry: index as u8,
                state: entry.state,
                unit: entry.unit,
                troops_milli: entry.troops,
                pending_bell: entry.pend_bell,
                resolved_next,
                return_units,
                reserve_after,
            },
        )
    };
    Ok(Report {
        selected,
        accounts: keys,
        next,
        observed,
        min_slot: reads.min_slot,
        context_slot: reads.coherent_snapshot().map(|meta| meta.context_slot()),
        clock_slot: now.slot,
        clock_timestamp: now.unix_timestamp,
        bell,
        status_promoted_by_clock: promoted,
        engine: None,
    })
}

/// One bounded read of ten canonical accounts plus Clock. The reader capability
/// cannot sign/send; a failed or incomplete response is never patched or retried.
pub async fn inspect(
    source: &(impl SnapshotSource + ?Sized),
    scope: &Scope,
    selected: Selection,
    min_slot: u64,
) -> Result<Report, Refusal> {
    let keys = ReadPlan::new(scope, selected)?;
    let snapshot = source
        .snapshot_boxed(keys.keys(), false, min_slot)
        .await
        .map_err(Refusal::Snapshot)?;
    if snapshot.meta().min_slot() != min_slot || snapshot.accounts().len() != keys.keys().len() {
        return Err(Refusal::Snapshot(SnapshotError::Malformed(
            "expedition request binding",
        )));
    }
    plan(scope, selected, &snapshot.reads())
}

impl<P: ChainPort + SnapshotPort + Send + Sync, D: DrandPort> crate::Keeper<P, D> {
    /// On-demand read-only review using this keeper's existing read port and
    /// engine facts. Does not start the keeper, mutate its tick/status, initialize
    /// payers, enable a gate, enqueue or construct an executable candidate.
    pub async fn review_original_expedition(
        &self,
        selected: Selection,
        deployment: Deployment,
        min_slot: u64,
    ) -> Result<Report, Refusal> {
        let scope = Scope {
            program: self.cfg.program,
            season: self.addrs.season,
            deployment: Some(deployment),
        };
        let mut report = inspect(&self.port, &scope, selected, min_slot).await?;
        report.engine = Some(EngineFacts {
            feed_writes_allowed: self.engine.feed_writes_allowed(),
            kind_allowed: self.engine.allows_write_kind(KIND),
            already_pending: self.engine.is_pending(&report.key()),
            care_unresolved: self.engine.care_unresolved(),
        });
        Ok(report)
    }
}
