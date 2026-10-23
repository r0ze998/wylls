//! ABI glue: instruction tags, classes, budgets, magics, sizes, error codes,
//! log kinds and the byte layouts of M1 contract v1.1 §5.3–§5.5 and §6, and
//! of ABI v2 (MC contract §5).
//!
//! `frontier-abi` is the single home of these tables (contract §3.3). This
//! module keeps fclient's names for them (the SCREAMING tag constants, the
//! `IxInfo` rows, the `layout::*` offsets) but every value is read from
//! `frontier-abi`, so a tag, budget, error code, log kind or offset is
//! changed in one place. What is fclient's own: the keeper `Class` letters,
//! the keeper's error mapping in [`err`], and a few names that differ from
//! the ABI's (each an alias of the ABI constant).

use std::sync::LazyLock;

use frontier_abi::error::FrontierError;
use frontier_abi::v2::CqError;

/// Instruction tags (§5.5).
pub mod tag {
    use frontier_abi::tags::Ix;
    use frontier_abi::v2::Ix as V2;

    pub const ANNOUNCE_SEASON: u8 = Ix::AnnounceSeason.tag();
    pub const CREATE_SEASON: u8 = Ix::CreateSeason.tag();
    pub const INIT_BEACON_LOGS: u8 = Ix::InitBeaconLogs.tag();
    pub const INIT_SHARDS: u8 = Ix::InitShards.tag();
    pub const CONSUME_GENESIS_SEED: u8 = Ix::ConsumeGenesisSeed.tag();
    pub const END_SEASON: u8 = Ix::EndSeason.tag();
    pub const CLOSE_SEASON: u8 = Ix::CloseSeason.tag();
    pub const ABORT_SEASON: u8 = Ix::AbortSeason.tag();
    pub const SET_WINDOW_SCHEDULE: u8 = Ix::SetWindowSchedule.tag();
    pub const POST_ANCHOR: u8 = Ix::PostAnchor.tag();
    pub const POST_ANCHOR_MULTI: u8 = Ix::PostAnchorMulti.tag();
    pub const POST_SEED: u8 = Ix::PostSeed.tag();
    pub const POST_BEACON: u8 = Ix::PostBeacon.tag();
    pub const ARCHIVE_ANCHORS: u8 = Ix::ArchiveAnchors.tag();
    pub const CLOSE_SEED_CACHE: u8 = Ix::CloseSeedCache.tag();
    pub const OPEN_RING: u8 = Ix::OpenRing.tag();
    pub const CONSUME_RING_SEED: u8 = Ix::ConsumeRingSeed.tag();
    pub const OPEN_PROVINCE: u8 = Ix::OpenProvince.tag();
    pub const FOLD_OCCUPANCY: u8 = Ix::FoldOccupancy.tag();
    pub const CLOSE_PROVINCE: u8 = Ix::CloseProvince.tag();
    pub const JOIN: u8 = Ix::Join.tag();
    pub const SET_SESSION: u8 = Ix::SetSession.tag();
    pub const SET_VIGIL: u8 = Ix::SetVigil.tag();
    pub const FILE_TICKET: u8 = Ix::FileTicket.tag();
    pub const SETTLE_TICKET: u8 = Ix::SettleTicket.tag();
    pub const RELEASE_DORMANT: u8 = Ix::ReleaseDormant.tag();
    pub const CLOSE_HOLDING: u8 = Ix::CloseHolding.tag();
    pub const CLOSE_CITIZEN: u8 = Ix::CloseCitizen.tag();
    pub const PLACE_HOME: u8 = Ix::PlaceHome.tag();
    pub const HARVEST: u8 = Ix::Harvest.tag();
    pub const BUILD: u8 = Ix::Build.tag();
    pub const TRAIN: u8 = Ix::Train.tag();
    pub const MUSTER: u8 = Ix::Muster.tag();
    pub const DISSOLVE: u8 = Ix::Dissolve.tag();
    pub const GARRISON: u8 = Ix::Garrison.tag();
    pub const EXPLORE: u8 = Ix::Explore.tag();
    pub const SETTLE_EXPLORE: u8 = Ix::SettleExplore.tag();
    pub const DISBAND_STRANDED: u8 = Ix::DisbandStranded.tag();
    pub const DEPART: u8 = Ix::Depart.tag();
    pub const REVEAL: u8 = Ix::Reveal.tag();
    pub const SETTLE_DEPARTURE: u8 = Ix::SettleDeparture.tag();
    /// Reserved: ProveBadSeal was removed in v1.1 (I-44).
    pub const RESERVED_PROVE_BAD_SEAL: u8 = 0x53;
    pub const SETTLE_TRANSIT: u8 = Ix::SettleTransit.tag();
    pub const SWEEP_POOL_OWED: u8 = Ix::SweepPoolOwed.tag();
    pub const GATHER_CLASH: u8 = Ix::GatherClash.tag();
    pub const RESOLVE_FROM_INPUTS: u8 = Ix::ResolveFromInputs.tag();
    /// Only in `oracle` builds of the program (tests).
    pub const RESOLVE_CLASH: u8 = Ix::ResolveClash.tag();
    pub const SKIP_QUIET: u8 = Ix::SkipQuiet.tag();
    pub const CLOSE_CLASH_INPUTS: u8 = Ix::CloseClashInputs.tag();
    pub const CLOSE_ARRIVAL_DAY: u8 = Ix::CloseArrivalDay.tag();
    pub const CLOSE_ARRIVAL_SLOT: u8 = Ix::CloseArrivalSlot.tag();
    pub const CLAIM_DEFENCE: u8 = Ix::ClaimDefence.tag();
    // ABI v2 (MC contract §5.4): the seven conquest instructions.
    pub const DECLARE_SIEGE: u8 = V2::DeclareSiege.tag();
    pub const SETTLE_SIEGE: u8 = V2::SettleSiege.tag();
    pub const SETTLE_CAPTURE: u8 = V2::SettleCapture.tag();
    pub const FILE_OUTPOST: u8 = V2::FileOutpost.tag();
    /// Reserved: CollectTribute (M3).
    pub const RESERVED_COLLECT_TRIBUTE: u8 = 0xA4;
    pub const FOLD_MARCH: u8 = V2::FoldMarch.tag();
    pub const RETIRE_HOST: u8 = V2::RetireHost.tag();
    pub const CLOSE_MARCH: u8 = V2::CloseMarch.tag();

    const _: () = {
        assert!(frontier_abi::tags::is_reserved(RESERVED_PROVE_BAD_SEAL));
        assert!(frontier_abi::v2::tags::is_reserved(
            RESERVED_COLLECT_TRIBUTE
        ));
    };
}

/// Keeper class of an instruction (§5.5, I-21).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Class {
    /// Window-closing: escalate to P_def 2.0, pool-eligible (Reveal).
    W,
    /// Delay-only: escalate to P_delay 0.5 from the keeper's own budget.
    D,
    /// Non-critical: fixed low bid.
    N,
    /// Player instruction through the relay at priority 0.
    P,
    /// Operator (season authority).
    O,
    /// Test-only (`oracle` ResolveClash).
    Test,
}

impl Class {
    pub fn letter(self) -> &'static str {
        match self {
            Class::W => "W",
            Class::D => "D",
            Class::N => "N",
            Class::P => "P",
            Class::O => "O",
            Class::Test => "T",
        }
    }
}

impl From<frontier_abi::tags::Class> for Class {
    fn from(c: frontier_abi::tags::Class) -> Class {
        use frontier_abi::tags::Class as A;
        match c {
            A::W => Class::W,
            A::D => Class::D,
            A::N => Class::N,
            A::P => Class::P,
            A::O => Class::O,
            A::Test => Class::Test,
        }
    }
}

/// One row of the §5.5 table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IxInfo {
    pub tag: u8,
    pub name: &'static str,
    pub class: Class,
    /// CU ceiling asserted by the M1 gate (§5.5); for SkipQuiet the base
    /// (v1.7: 90k + 30k per recomputed bell). A row that is recorded, not
    /// gated (the oracle ResolveClash), requests the transaction maximum.
    pub cu_budget: u32,
    /// Largest legal transaction, bytes (the contract's "Tx B max").
    pub tx_max: u16,
    /// Refuses CPI (`NotTopLevel`).
    pub top_level: bool,
}

impl IxInfo {
    /// The row of one instruction from its ABI facts and budget.
    fn of(
        tag: u8,
        name: &'static str,
        class: frontier_abi::tags::Class,
        top_level: bool,
        cu_budget: u32,
        tx_contract: u32,
    ) -> IxInfo {
        IxInfo {
            tag,
            name,
            class: class.into(),
            cu_budget: if cu_budget == 0 { CU_MAX } else { cu_budget },
            tx_max: u16::try_from(tx_contract).expect("a tx ceiling fits u16"),
            top_level,
        }
    }
}

/// Every instruction of M1 (§5.5), in tag order: 49 + the test-only
/// ResolveClash (`frontier_abi::tags::Ix::ALL` and its budgets).
pub static INSTRUCTIONS: LazyLock<Vec<IxInfo>> = LazyLock::new(|| {
    let mut rows: Vec<IxInfo> = frontier_abi::tags::Ix::ALL
        .iter()
        .map(|&ix| {
            let b = frontier_abi::budgets::budget(ix);
            IxInfo::of(
                ix.tag(),
                ix.name(),
                ix.class(),
                ix.top_level_only(),
                b.cu_budget,
                b.tx_contract,
            )
        })
        .collect();
    rows.sort_by_key(|i| i.tag);
    rows
});

/// The §5.5 row of `tag`.
pub fn ix_info(tag: u8) -> Option<&'static IxInfo> {
    INSTRUCTIONS.iter().find(|i| i.tag == tag)
}

/// `program_version` of an M1 season (ABI v1).
pub const PROGRAM_VERSION_V1: u16 = 1;
/// `program_version` of an MC season (ABI v2, MC contract §5.1).
pub const PROGRAM_VERSION_V2: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_V2;
/// `layout_version` of every v2 chained header (R-22: readers dispatch on it).
pub const LAYOUT_VERSION_V2: u16 = frontier_abi::v2::layout::LAYOUT_VERSION_V2;

/// Every instruction of ABI v2 (MC contract §5.4), in tag order: M1's 50
/// rows with §5.4's budget for the changed ones, and the seven new rows
/// (`frontier_abi::v2::Ix::ALL` and `frontier_abi::v2::budgets`, which
/// keep M1's gates for GatherClash and SkipQuiet, CQ1-C D-7).
pub static INSTRUCTIONS_V2: LazyLock<Vec<IxInfo>> = LazyLock::new(|| {
    let mut rows: Vec<IxInfo> = frontier_abi::v2::Ix::ALL
        .iter()
        .map(|&ix| {
            let b = frontier_abi::v2::budgets::budget(ix);
            IxInfo::of(
                ix.tag(),
                ix.name(),
                ix.class(),
                ix.top_level_only(),
                b.cu_budget,
                b.tx_contract,
            )
        })
        .collect();
    rows.sort_by_key(|i| i.tag);
    rows
});

/// The ABI v2 row of `tag`.
pub fn ix_info_v2(tag: u8) -> Option<&'static IxInfo> {
    INSTRUCTIONS_V2.iter().find(|i| i.tag == tag)
}

/// The row of `tag` under a season's `program_version` (R-22: v1 for an
/// M1 season, v2 for an MC season).
pub fn ix_info_for(program_version: u16, tag: u8) -> Option<&'static IxInfo> {
    if program_version >= PROGRAM_VERSION_V2 {
        ix_info_v2(tag)
    } else {
        ix_info(tag)
    }
}

/// Largest transaction (wire bytes) Solana accepts.
pub const PACKET: usize = frontier_abi::budgets::TX_MAX as usize;
/// Account locks per transaction (mainnet).
pub const LOCK_LIMIT: usize = frontier_abi::budgets::LOCKS_MAX as usize;
/// Heap ceiling asserted at every gated fill (§5.5, I-50).
pub const HEAP_GATE: u32 = frontier_abi::budgets::HEAP_GATE;
/// Heap frame the keeper's retry ladder requests (I-50).
pub const HEAP_FRAME_RETRY: u32 = frontier_abi::budgets::HEAP_FRAME;
/// CU ceiling of the keeper's retry ladder (I-50).
pub const CU_MAX: u32 = frontier_abi::budgets::CU_LADDER_MAX;

/// Account magics (§4.3).
pub mod magic {
    use frontier_abi::layout::{beacon, clash, player, province, world};

    pub const SEASON: &[u8; 8] = &world::season::MAGIC;
    pub const FRONTIER: &[u8; 8] = &world::frontier::MAGIC;
    pub const RING_SEED: &[u8; 8] = &world::ring_seed::MAGIC;
    pub const PROVINCE_FUND: &[u8; 8] = &world::province_fund::MAGIC;
    pub const JOIN_SHARD: &[u8; 8] = &world::join_shard::MAGIC;
    pub const BEACON_LOG: &[u8; 8] = &world::beacon_log::MAGIC;
    pub const DEFENCE_POOL: &[u8; 8] = &world::defence_pool::MAGIC;
    pub const CITIZEN: &[u8; 8] = &player::citizen::MAGIC;
    pub const HOLDING: &[u8; 8] = &player::holding::MAGIC;
    pub const PROVINCE: &[u8; 8] = &province::province::MAGIC;
    pub const ARRIVAL_SLOT: &[u8; 8] = &clash::arrival_slot::MAGIC;
    pub const ARRIVAL_DAY: &[u8; 8] = &clash::arrival_day::MAGIC;
    pub const CLASH_INPUTS: &[u8; 8] = &clash::clash_inputs::MAGIC;
    /// Reserved (SealVerdict removed in v1.1; no longer an account kind).
    pub const SEAL_VERDICT: &[u8; 8] = b"PSF1SVRD";
    pub const BELL_ANCHOR: &[u8; 8] = &beacon::bell_anchor::MAGIC;
    pub const SEED_CACHE: &[u8; 8] = &beacon::seed_cache::MAGIC;
    pub const ANCHOR_ARCHIVE: &[u8; 8] = &beacon::anchor_archive::MAGIC;
    pub const DEFENCE_CLAIM: &[u8; 8] = &beacon::defence_claim::MAGIC;
    /// ABI v2: MarchState (MC contract §5.2.6). Every other v2 kind keeps
    /// its M1 magic (an MC Province differs by size and `layout_version`).
    pub const MARCH_STATE: &[u8; 8] = &frontier_abi::v2::layout::world::march_state::MAGIC;
}

/// Account sizes in bytes (§5.2).
pub mod size {
    use frontier_abi::layout::{beacon, clash, player, province, world};

    pub const SEASON: usize = world::season::SIZE;
    pub const SEASON_TOMBSTONE: usize = world::season::TOMBSTONE_SIZE;
    pub const FRONTIER: usize = world::frontier::SIZE;
    pub const RING_SEED: usize = world::ring_seed::SIZE;
    pub const PROVINCE_FUND: usize = world::province_fund::SIZE;
    pub const JOIN_SHARD: usize = world::join_shard::SIZE;
    pub const BEACON_LOG: usize = world::beacon_log::SIZE;
    pub const DEFENCE_POOL: usize = world::defence_pool::SIZE;
    pub const CITIZEN: usize = player::citizen::SIZE;
    pub const HOLDING: usize = player::holding::SIZE;
    pub const PROVINCE: usize = province::province::SIZE;
    pub const ARRIVAL_SLOT: usize = clash::arrival_slot::SIZE;
    pub const ARRIVAL_DAY: usize = clash::arrival_day::SIZE;
    pub const CLASH_INPUTS: usize = clash::clash_inputs::SIZE;
    pub const BELL_ANCHOR: usize = beacon::bell_anchor::SIZE;
    pub const SEED_CACHE: usize = beacon::seed_cache::SIZE;
    pub const ANCHOR_ARCHIVE: usize = beacon::anchor_archive::SIZE;
    pub const DEFENCE_CLAIM: usize = beacon::defence_claim::SIZE;
    /// ABI v2 (MC contract §5.2.1): M1's 4,096 B and the 640-B conquest block.
    pub const PROVINCE_V2: usize = frontier_abi::v2::layout::province::province::SIZE;
    /// ABI v2 (MC contract §5.2.6).
    pub const MARCH_STATE: usize = frontier_abi::v2::layout::world::march_state::SIZE;
}

/// Rent of an account of `space` bytes at mainnet rates (§4.2):
/// `(128 + space) × 5,080` lamports.
pub use frontier_abi::layout::rent;

/// Counts fixed by the contract.
pub const REGIONS: u8 = 16;
pub const FACTIONS: u8 = 6;
pub const SHARDS_PER_FACTION: u8 = 8;
pub const WEDGES: u8 = 6;
pub const TRANSIT_SLOTS: usize = 4;
pub const ENTRIES: usize = 56;
pub const BELLS_PER_DAY: u32 = 144;
pub const BELL_SECS: i64 = 600;
pub const NEUTRAL: u8 = 6;
/// `PostAnchorMulti` region count, pinned by W2-A's tx-size test (8 or 16);
/// the builder accepts any k up to 16 and the transaction-size check refuses
/// an oversize one.
pub const MULTI_MAX_REGIONS_CEILING: usize = 16;
/// Burned creation bonds go here (CL-24).
pub const INCINERATOR: &str = frontier_abi::presets::INCINERATOR;
pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
pub const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
pub const INSTRUCTIONS_SYSVAR: &str = "Sysvar1nstructions1111111111111111111111111";
pub const CLOCK_SYSVAR: &str = "SysvarC1ock11111111111111111111111111111111";
pub const LOADER_V3: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

/// Program error codes (§5.4), `(code, name)` in code order. Stable forever.
pub const ERRORS: [(u32, &str); FrontierError::ALL.len()] = {
    let mut out = [(0, ""); FrontierError::ALL.len()];
    let mut i = 0;
    while i < out.len() {
        let e = FrontierError::ALL[i];
        out[i] = (e.code(), e.name());
        i += 1;
    }
    out
};

/// ABI v2 error codes (MC contract §5.3), stable forever; disjoint from
/// [`ERRORS`].
pub const ERRORS_V2: [(u32, &str); CqError::ALL.len()] = {
    let mut out = [(0, ""); CqError::ALL.len()];
    let mut i = 0;
    while i < out.len() {
        let e = CqError::ALL[i];
        out[i] = (e.code(), e.name());
        i += 1;
    }
    out
};

/// The name of a program error code of either ABI (the code spaces are
/// disjoint, so one lookup serves M1 and MC seasons).
pub fn error_name(code: u32) -> Option<&'static str> {
    ERRORS
        .iter()
        .chain(ERRORS_V2.iter())
        .find(|e| e.0 == code)
        .map(|e| e.1)
}

/// Keeper mapping of the codes it acts on (§5.4, offchain P8).
pub mod err {
    use frontier_abi::error::FrontierError as E;
    use frontier_abi::v2::CqError as Cq;

    pub const SLOT_MOVED: u32 = E::SlotMoved.code();
    pub const WINDOW_CLOSED: u32 = E::WindowClosed.code();
    pub const ARCHIVED: u32 = E::Archived.code();
    pub const LATCH_CLOSED: u32 = E::LatchClosed.code();
    pub const NO_ANCHOR: u32 = E::NoAnchor.code();
    pub const SEED_NOT_READY: u32 = E::SeedNotReady.code();
    pub const NOT_GATHERED: u32 = E::NotGathered.code();
    pub const ALREADY_DONE: u32 = E::AlreadyDone.code();
    pub const QUOTA_REFUSED: u32 = E::QuotaRefused.code();
    pub const TIP_TOO_LOW: u32 = E::TipTooLow.code();
    pub const HOST_IN_TRANSIT: u32 = E::HostInTransit.code();
    /// Land (W3-C): a fold part of an older bell; a ticket whose `k` or
    /// state moved; a holding not dormant (any more).
    pub const FOLD_STALE: u32 = E::FoldStale.code();
    pub const TICKET_STATE: u32 = E::TicketState.code();
    pub const NOT_DORMANT: u32 = E::NotDormant.code();
    pub const NOT_IMPLEMENTED: u32 = E::NotImplemented.code();
    pub const NO_TICKET: u32 = E::NoTicket.code();
    /// Play (W4-C).
    pub const TOO_EARLY: u32 = E::TooEarly.code();
    pub const NOT_RESIDENT: u32 = E::NotResident.code();
    pub const TRANSIT_STATE: u32 = E::TransitState.code();
    pub const COMMIT_MISMATCH: u32 = E::CommitMismatch.code();
    pub const NEED_ARRIVAL_DAY: u32 = E::NeedArrivalDay.code();
    pub const DEPARTURE_UNSETTLED: u32 = E::DepartureUnsettled.code();
    pub const OUT_OF_ORDER: u32 = E::OutOfOrder.code();
    pub const NOT_QUIET: u32 = E::NotQuiet.code();
    pub const INPUTS_OPEN: u32 = E::InputsOpen.code();
    pub const NOT_ELIGIBLE: u32 = E::NotEligible.code();
    pub const BAD_PLAINTEXT: u32 = E::BadPlaintext.code();
    /// MC (ABI v2, §5.3) codes the keeper and the bots act on.
    pub const CAPTURE_PENDING: u32 = Cq::CapturePending.code();
    pub const IMMUNE: u32 = Cq::Immune.code();
    pub const SIEGE_BUSY: u32 = Cq::SiegeBusy.code();
    pub const STAKE_UNSETTLED: u32 = Cq::StakeUnsettled.code();
    pub const SIEGE_CAP: u32 = Cq::SiegeCap.code();
    pub const NOT_ON_HEX: u32 = Cq::NotOnHex.code();
    pub const TOO_LATE: u32 = Cq::TooLate.code();
    pub const HOLDINGS_FULL: u32 = Cq::HoldingsFull.code();
    pub const NOT_DUE: u32 = Cq::NotDue.code();
    pub const OUTPOST_RULE: u32 = Cq::OutpostRule.code();
    pub const FOLD_OUT_OF_ORDER: u32 = Cq::FoldOutOfOrder.code();
    pub const FOLD_TOO_EARLY: u32 = Cq::FoldTooEarly.code();
    pub const NOT_LEAD: u32 = Cq::NotLead.code();

    /// A refusal that means the write's work is done (v1.5 §5.4 keeper
    /// mapping): `AlreadyDone` for every write; `NoTicket` for SettleTicket
    /// (the ticket ended — this write's or another version's settlement,
    /// an expiry, or the last preference taken — so nothing is left to
    /// settle; wave-3 review, W3-A).
    ///
    /// W4-C adds the refusals that can only mean "another version or
    /// another keeper did it" for the play writes it sends: a
    /// SettleDeparture or SettleTransit whose transit is no longer in the
    /// state it needs (`TransitState`, the record moved on), a
    /// ResolveFromInputs or SkipQuiet whose bell is no longer
    /// `resolved_next` (`OutOfOrder`: the province moved past it). The duty
    /// re-reads the chain before planning anything else for the object.
    ///
    /// CQ2-D adds the conquest writes (MC §8.2): a FoldMarch whose hour is
    /// no longer `next_hour` (`FoldOutOfOrder`: another keeper or version
    /// folded it). SettleSiege and SettleCapture answer `AlreadyDone` when
    /// nothing is left (§5.5), covered by the first rule.
    pub fn is_done(tag: u8, code: u32) -> bool {
        use super::tag as t;
        code == ALREADY_DONE
            || (tag == t::SETTLE_TICKET && code == NO_TICKET)
            || (matches!(tag, t::SETTLE_DEPARTURE | t::SETTLE_TRANSIT) && code == TRANSIT_STATE)
            || (matches!(tag, t::RESOLVE_FROM_INPUTS | t::SKIP_QUIET) && code == OUT_OF_ORDER)
            || (tag == t::FOLD_MARCH && code == FOLD_OUT_OF_ORDER)
    }

    /// The window of this write is gone for good: stop retrying.
    pub fn stops_window(code: u32) -> bool {
        matches!(code, WINDOW_CLOSED | ARCHIVED | LATCH_CLOSED)
    }
}

/// PS2 log record kinds (§6).
pub mod kind {
    use frontier_abi::log::{Kind as K, SPECS};
    use frontier_abi::v2::log::{CqKind as Cq, CQ_SPECS};

    pub const ANNOUNCE: u8 = K::ANNOUNCE as u8;
    pub const SEASON_CREATED: u8 = K::SEASON_CREATED as u8;
    pub const GENESIS_SEED: u8 = K::GENESIS_SEED as u8;
    pub const RING_OPEN: u8 = K::RING_OPEN as u8;
    pub const RING_SEED: u8 = K::RING_SEED as u8;
    pub const PROVINCE_OPEN: u8 = K::PROVINCE_OPEN as u8;
    pub const FOLD: u8 = K::FOLD as u8;
    pub const SEASON_STATUS: u8 = K::SEASON_STATUS as u8;
    pub const WINDOW: u8 = K::WINDOW as u8;
    pub const JOIN: u8 = K::JOIN as u8;
    pub const SESSION: u8 = K::SESSION as u8;
    pub const VIGIL: u8 = K::VIGIL as u8;
    pub const TICKET: u8 = K::TICKET as u8;
    pub const SETTLE: u8 = K::SETTLE as u8;
    pub const RELEASE: u8 = K::RELEASE as u8;
    pub const HOLDING_FINAL: u8 = K::HOLDING_FINAL as u8;
    pub const HOME_PLACED: u8 = K::HOME_PLACED as u8;
    pub const HARVEST: u8 = K::HARVEST as u8;
    pub const BUILD: u8 = K::BUILD as u8;
    pub const TRAIN: u8 = K::TRAIN as u8;
    pub const MUSTER: u8 = K::MUSTER as u8;
    pub const DISSOLVE: u8 = K::DISSOLVE as u8;
    pub const GARRISON: u8 = K::GARRISON as u8;
    pub const EXPLORE: u8 = K::EXPLORE as u8;
    pub const EXPLORE_RESULT: u8 = K::EXPLORE_RESULT as u8;
    pub const STRANDED: u8 = K::STRANDED as u8;
    pub const DEPART: u8 = K::DEPART as u8;
    pub const REVEAL: u8 = K::REVEAL as u8;
    pub const DEPARTURE_SETTLED: u8 = K::DEPARTURE_SETTLED as u8;
    /// Reserved (BAD_SEAL removed in v1.1).
    pub const RESERVED_BAD_SEAL: u8 = 33;
    pub const TRANSIT_SETTLED: u8 = K::TRANSIT_SETTLED as u8;
    pub const GATHER: u8 = K::GATHER as u8;
    pub const CLASH: u8 = K::CLASH as u8;
    pub const SKIP: u8 = K::SKIP as u8;
    pub const CAMP: u8 = K::CAMP as u8;
    pub const ANCHOR: u8 = K::ANCHOR as u8;
    pub const SEED: u8 = K::SEED as u8;
    pub const BEACON: u8 = K::BEACON as u8;
    pub const ARCHIVE: u8 = K::ARCHIVE as u8;
    pub const DIVERT: u8 = K::DIVERT as u8;
    pub const DEFENCE_CLAIM: u8 = K::DEFENCE_CLAIM as u8;
    pub const POOL_SWEEP: u8 = K::POOL_SWEEP as u8;
    pub const CLOSE: u8 = K::CLOSE as u8;

    /// (kind, name) for every defined record kind, in kind order.
    pub const ALL: [(u8, &str); SPECS.len()] = {
        let mut out = [(0, ""); SPECS.len()];
        let mut i = 0;
        while i < out.len() {
            out[i] = (SPECS[i].kind as u8, SPECS[i].name);
            i += 1;
        }
        out
    };

    pub fn name(k: u8) -> Option<&'static str> {
        ALL.iter()
            .chain(ALL_V2.iter())
            .find(|e| e.0 == k)
            .map(|e| e.1)
    }

    // ABI v2 (MC contract §6): kinds 80–88; 89 reserved.
    pub const SIEGE_DECLARED: u8 = Cq::SIEGE_DECLARED as u8;
    pub const SIEGE_SETTLED: u8 = Cq::SIEGE_SETTLED as u8;
    pub const CONQUEST: u8 = Cq::CONQUEST as u8;
    pub const CAPTURE_SETTLED: u8 = Cq::CAPTURE_SETTLED as u8;
    pub const KEEP: u8 = Cq::KEEP as u8;
    pub const MARCH_FOLD: u8 = Cq::MARCH_FOLD as u8;
    pub const RETIRE: u8 = Cq::RETIRE as u8;
    pub const NEUTRAL: u8 = Cq::NEUTRAL as u8;
    pub const OUTPOST_SETTLED: u8 = Cq::OUTPOST_SETTLED as u8;
    /// Reserved (never emitted).
    pub const RESERVED_89: u8 = frontier_abi::v2::log::RESERVED_KIND;

    /// (kind, name) of every MC record kind, in kind order.
    pub const ALL_V2: [(u8, &str); CQ_SPECS.len()] = {
        let mut out = [(0, ""); CQ_SPECS.len()];
        let mut i = 0;
        while i < out.len() {
            out[i] = (CQ_SPECS[i].kind as u8, CQ_SPECS[i].name);
            i += 1;
        }
        out
    };
}

/// Chained entity kinds in a PS2 tail (§6).
pub mod entity {
    use frontier_abi::v2::log::EntityKind as E;

    pub const SEASON: u8 = E::Season as u8;
    pub const FRONTIER: u8 = E::Frontier as u8;
    pub const JOIN_SHARD: u8 = E::JoinShard as u8;
    pub const CITIZEN: u8 = E::Citizen as u8;
    pub const HOLDING: u8 = E::Holding as u8;
    pub const PROVINCE: u8 = E::Province as u8;
    pub const CLASH_INPUTS: u8 = E::ClashInputs as u8;
    /// The largest entity kind of an M1 tail.
    pub const MAX: u8 = CLASH_INPUTS;
    /// ABI v2 (MC contract §5.1): MarchState, chained by MARCH_FOLD only.
    pub const MARCH_STATE: u8 = E::MarchState as u8;
    /// The largest entity kind of a v2 tail.
    pub const MAX_V2: u8 = MARCH_STATE;
}

/// Seal verdict codes judged by SettleTransit (§5.3, I-44).
pub mod seal_code {
    pub use frontier_abi::log::seal_code::*;
    /// fclient's name for `BAD_PLAINTEXT`.
    pub const PLAINTEXT_INVALID: u8 = BAD_PLAINTEXT;
}

/// Byte offsets of every M1 account layout (§4.3, §5.3): each module
/// re-exports frontier-abi's (one `pub const` per field, `SIZE`, `MAGIC`,
/// `FIELDS`) and adds fclient's names: `END` (where the trailing reserved
/// bytes begin), `*_STRIDE` (the size of a record inside the account) and
/// the aliases of the few fields fclient names differently.
pub mod layout {
    use frontier_abi::layout as abi;

    /// Where a layout's trailing reserved range begins: the end of its
    /// last field that is not reserved.
    const fn data_end(fields: &[abi::Field]) -> usize {
        let mut i = fields.len();
        while i > 0 && is_rsv(fields[i - 1].ty) {
            i -= 1;
        }
        if i == 0 {
            0
        } else {
            fields[i - 1].off + fields[i - 1].len
        }
    }

    const fn is_rsv(ty: &str) -> bool {
        let b = ty.as_bytes();
        b.len() == 3 && b[0] == b'r' && b[1] == b's' && b[2] == b'v'
    }

    /// Chained header H (64 B).
    pub mod h {
        use frontier_abi::layout::header as abi;
        pub const MAGIC: usize = abi::MAGIC;
        pub const SEASON_ID: usize = abi::SEASON_ID;
        pub const LAYOUT_VERSION: usize = abi::LAYOUT_VERSION;
        pub const EVENT_SEQ: usize = abi::EVENT_SEQ;
        pub const EVENT_HEAD: usize = abi::EVENT_HEAD;
        pub const LEN: usize = abi::H_SIZE;
    }
    /// Short header SH (16 B).
    pub mod sh {
        use frontier_abi::layout::header as abi;
        pub const MAGIC: usize = abi::MAGIC;
        pub const SEASON_ID: usize = abi::SEASON_ID;
        pub const LEN: usize = abi::SH_SIZE;
    }
    pub mod season {
        pub use frontier_abi::layout::world::season::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod frontier {
        pub use frontier_abi::layout::world::frontier::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod ring_seed {
        pub use frontier_abi::layout::world::ring_seed::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod province_fund {
        pub use frontier_abi::layout::world::province_fund::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod join_shard {
        pub use frontier_abi::layout::world::join_shard::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod beacon_log {
        pub use frontier_abi::layout::world::beacon_log::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod defence_pool {
        pub use frontier_abi::layout::world::defence_pool::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod citizen {
        pub use frontier_abi::layout::player::citizen::*;
        pub const END: usize = super::data_end(FIELDS);
        /// 3 × {P i16, Q i16, site u8, gen u8}.
        pub const HOLDING_STRIDE: usize = frontier_abi::layout::player::holding_ref::SIZE;
        /// 3 × {P i16, Q i16, site u8}.
        pub const TICKET_SITE_STRIDE: usize = frontier_abi::layout::player::ticket_site::SIZE;
        pub const FLAG_FIRST_FINAL: u8 = FLAG_FIRST_HOLDING_FINAL;
    }
    pub mod holding {
        pub use frontier_abi::layout::player::holding::*;
        pub const END: usize = super::data_end(FIELDS);
        /// 8 × Accrual {value, rate, cap, t0, frac} (i64 each).
        pub const ACCRUAL_STRIDE: usize = frontier_abi::layout::player::accrual::SIZE;
        /// 4 × {done_at i64, kind u8, arg u8, rsv[6], delta i64}.
        pub const QUEUE_STRIDE: usize = frontier_abi::layout::player::queue_item::SIZE;
        pub const TRANSIT_STRIDE: usize = frontier_abi::layout::player::transit::SIZE;
    }
    /// Transit record (96 B) inside the Holding.
    pub mod transit {
        pub use frontier_abi::layout::player::transit::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    /// Explore record (24 B) inside the Holding.
    pub mod explore {
        pub use frontier_abi::layout::player::explore::*;
        pub const LEN: usize = SIZE;
    }
    pub mod province {
        pub use frontier_abi::layout::province::province::*;
        pub const END: usize = super::data_end(FIELDS);
        pub const LAST_OUTCOME_DIGEST: usize = LAST_DIGEST;
        pub const SITE_MIRROR_STRIDE: usize = super::site::SIZE;
        pub const ENTRY_STRIDE: usize = super::entry::SIZE;
        pub const LAST_RESOLVE: usize = RESOLVE_SUMMARY;
        pub const COHORT_STRIDE: usize = frontier_abi::layout::province::cohort::SIZE;
        pub const COHORTS: usize = COHORTS_N;
    }
    /// Site mirror (64 B) inside the Province.
    pub mod site {
        pub use frontier_abi::layout::province::site::*;
        pub const WALL_ITEM0: usize = WALL_ITEM0_BELL;
        pub const WALL_ITEM1: usize = WALL_ITEM1_BELL;
    }
    /// Province entry (48 B).
    pub mod entry {
        pub use frontier_abi::layout::province::entry::*;
    }
    pub mod arrival_slot {
        pub use frontier_abi::layout::clash::arrival_slot::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod arrival_day {
        pub use frontier_abi::layout::clash::arrival_day::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod clash_inputs {
        pub use frontier_abi::layout::clash::clash_inputs::*;
        pub const END: usize = super::data_end(FIELDS);
        pub const ARRIVAL_STRIDE: usize = super::arrival::SIZE;
    }
    /// Arrival record (40 B) inside ClashInputs.
    pub mod arrival {
        pub use frontier_abi::layout::clash::arrival::*;
    }
    pub mod bell_anchor {
        pub use frontier_abi::layout::beacon::bell_anchor::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    pub mod seed_cache {
        pub use frontier_abi::layout::beacon::seed_cache::*;
        pub const END: usize = super::data_end(FIELDS);
    }
    /// v1.3: one archive per region and half day (`part = bell / 72`).
    pub mod anchor_archive {
        pub use frontier_abi::layout::beacon::anchor_archive::*;
        pub const END: usize = super::data_end(FIELDS);
        /// {a_off u32, seed [32], sig [48]}.
        pub const ENTRY_STRIDE: usize = frontier_abi::layout::beacon::archive_entry::SIZE;
    }
    pub mod defence_claim {
        pub use frontier_abi::layout::beacon::defence_claim::*;
        pub const END: usize = super::data_end(FIELDS);
    }
}

/// Season status values (§5.3).
pub mod status {
    use frontier_abi::layout::world::season as s;

    pub const ANNOUNCED: u8 = s::STATUS_ANNOUNCED;
    pub const CREATED: u8 = s::STATUS_CREATED;
    pub const SEEDED: u8 = s::STATUS_SEEDED;
    /// Never stored: Seeded with `now ≥ genesis_ts` is Running.
    pub const RUNNING: u8 = s::STATUS_RUNNING;
    pub const ENDED: u8 = s::STATUS_ENDED;
    pub const CLOSED: u8 = s::STATUS_CLOSED;
    pub const ABORTED: u8 = s::STATUS_ABORTED;
}

// Every `END` (the start of a layout's trailing reserved bytes) lies inside
// its account; frontier-abi's `layouts_tile_exactly` checks the fields
// themselves. Three spot values the contract quotes (§5.3).
const _: () = {
    assert!(layout::season::END == 516);
    assert!(layout::holding::END == 1_248);
    assert!(layout::transit::END == 93);
    assert!(layout::season::END <= 1_024);
    assert!(layout::frontier::END <= size::FRONTIER);
    assert!(layout::ring_seed::END <= size::RING_SEED);
    assert!(layout::province_fund::END <= size::PROVINCE_FUND);
    assert!(layout::join_shard::END <= size::JOIN_SHARD);
    assert!(layout::beacon_log::END <= size::BEACON_LOG);
    assert!(layout::defence_pool::END <= size::DEFENCE_POOL);
    assert!(layout::citizen::END <= size::CITIZEN);
    assert!(layout::holding::END <= size::HOLDING);
    assert!(layout::transit::END <= layout::holding::TRANSIT_STRIDE);
    assert!(layout::province::END <= size::PROVINCE);
    assert!(layout::arrival_slot::END <= size::ARRIVAL_SLOT);
    assert!(layout::arrival_day::END <= size::ARRIVAL_DAY);
    assert!(layout::clash_inputs::END <= size::CLASH_INPUTS);
    assert!(layout::bell_anchor::END <= size::BELL_ANCHOR);
    assert!(layout::seed_cache::END <= size::SEED_CACHE);
    assert!(layout::anchor_archive::END <= size::ANCHOR_ARCHIVE);
    assert!(layout::defence_claim::END <= size::DEFENCE_CLAIM);
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Figures the contract quotes, so a change in `frontier-abi` that
    /// breaks one is seen here as well.
    #[test]
    fn abi_tables_match_the_contract() {
        // 49 instructions + the oracle ResolveClash; tags unique; 0x53 reserved.
        let mut tags: Vec<u8> = INSTRUCTIONS.iter().map(|i| i.tag).collect();
        tags.sort();
        tags.dedup();
        assert_eq!(tags.len(), 51);
        assert!(ix_info(tag::RESERVED_PROVE_BAD_SEAL).is_none());
        assert_eq!(ix_info(tag::REVEAL).unwrap().class, Class::W);
        assert_eq!(ix_info(tag::SETTLE_TICKET).unwrap().class, Class::D);
        for t in [
            tag::OPEN_RING,
            tag::CONSUME_RING_SEED,
            tag::OPEN_PROVINCE,
            tag::FOLD_OCCUPANCY,
            tag::CLAIM_DEFENCE,
        ] {
            assert_eq!(
                ix_info(t).unwrap().class,
                Class::D,
                "I-47/48/52 class D: {t:#x}"
            );
        }
        // Error codes unique and 14 kept reserved.
        let mut codes: Vec<u32> = ERRORS.iter().map(|e| e.0).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), ERRORS.len());
        assert_eq!(error_name(52), Some("AlreadyDone"));
        // Rent figures quoted in §5.2.
        assert_eq!(rent(size::SEASON), 11_054_080);
        assert_eq!(rent(size::CITIZEN) + rent(size::HOLDING), 9_753_600);
        assert_eq!(rent(size::ANCHOR_ARCHIVE), 31_861_760);
        assert_eq!(rent(size::PROVINCE), 21_457_920);
        assert_eq!(rent(size::PROVINCE_V2), 24_709_120);
        assert_eq!(rent(size::MARCH_STATE), 1_950_720);
    }

    /// The rules fclient adds on top of the ABI rows: the v2 table extends
    /// the M1 one (a row MC does not change keeps its M1 values; the new
    /// rows exist only in v2) and `ix_info_for` dispatches on the season's
    /// program version.
    #[test]
    fn v2_rows_extend_the_m1_rows() {
        for ix in frontier_abi::v2::Ix::ALL {
            let row = ix_info_v2(ix.tag()).unwrap_or_else(|| panic!("{}", ix.name()));
            assert_eq!(ix_info_for(PROGRAM_VERSION_V2, ix.tag()), Some(row));
            match ix.to_v1() {
                Some(v1) if !ix.changed_in_v2() => {
                    assert_eq!(ix_info(v1.tag()), Some(row), "{}", ix.name())
                }
                Some(_) => {}
                None => assert!(ix.is_new() && ix_info(ix.tag()).is_none()),
            }
        }
        for ix in frontier_abi::tags::Ix::ALL {
            assert_eq!(ix_info_for(PROGRAM_VERSION_V1, ix.tag()), ix_info(ix.tag()));
        }
        // The recorded, not gated, row requests the ladder's maximum.
        assert_eq!(ix_info(tag::RESOLVE_CLASH).unwrap().cu_budget, CU_MAX);
    }
}
