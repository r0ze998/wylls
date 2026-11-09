//! **Experimental** (`wide-world-experimental`): the handlers of the wide
//! land write path, dispatched on the provisional band
//! `frontier_abi::world_index::wide_ix` (0xD6–0xDE). Not in any default
//! build, never an SBF binary (`lib.rs` refuses the feature on the Solana
//! target); a build with this feature carries the `0x4000` program-version
//! bit, so its Seasons never mix with production Seasons, and every
//! handler refuses a Season of another version (`RulesetMismatch`).
//!
//! Initial-Free-City conquest has authenticated declaration, shared Resolve,
//! settlement and terminal-close implementations below, but every new public
//! command remains behind `CONQUEST_LIFECYCLE_ENABLED = false`. Private host
//! tests are not evidence that public gameplay, receipt replay or the broader
//! original-game surface is enabled. Existing Resolve stays conquest-strict.
//!
//! | tag | handler | today |
//! |---|---|---|
//! | 0xD6 | [`request_ring_seed`] | **writes**: the wide ring seed of ring `d ≥ 129`, its round fixed by the kernel's `ring_seed_round`, after the deployed OpenRing gates, paid by the payer as a legacy RingSeed is |
//! | 0xD7 | [`consume_ring_seed`] | **writes**: the seed, after the same `quick::verify` and `quick::seed_of` as the deployed ConsumeRingSeed |
//! | 0xDB | [`set_rules`] | **writes** (once, by the Season's authority): the Season's experimental rules configuration (`world_index::rules`), naming a *candidate* for each rule a wide opening needs; a byte 0 refuses |
//! | 0xD8 | [`open_province`] | **writes the whole province** when the configuration is present: the wide terrain kernel over the ring seed, the keep (tile by the deployed kernel, holder by the configured candidate), the configured Free City and camp, the deployed site mirror, funded from the geometric wedge's fund with the deployed fund and ring-seed bookkeeping. Without the configuration it validates and refuses `NotImplemented` before any write, exactly as before |
//! | 0xD9 | [`claim_site`] | **files the wide outpost ticket**: the deployed FileOutpost's checks over wide land (the player prologue, the one ticket and one inventory, the final Town first home as anchor with its unlocked province, the slot-2 holding for a slot-3 claim with the lazy finality flip, `holding::may_found_outpost` on the folded Frontier and the wide province's strength weights, the site's zero record, the settler cost) and its writes: the settler cost from the anchor (`HARVEST` of the anchor), the province's cohort, the Citizen's marker, the record holding the wide Holding's rent |
//! | 0xDC | [`settle_ticket`] | **the deployed SettleTicket over the wide ticket**: expired, or the beacon seed of the ticket's bell and the province's region, the full-width score, fresh (a **provisional** wide holding from the record's escrow), displace (the record's escrow pays the loser's funder, the loser's slot is unbound, the holding is rewritten at `gen + 1`) or taken; the ticket ends, the cohort settles, the record stays **Settled** holding the escrow a win did not consume (the deployed retention: nothing is refunded) |
//! | 0xDF | [`finalize`] | the deployed lazy provisional → final flip of a wide holding, callable by anyone: `now ≥ final_ts` **and** the ticket's cohort closed, else `TooEarly` |
//! | 0xDE | [`close`] | season end (Ended + 72 h, Aborted, the tombstone): a wide ticket record closes as CloseCitizen closes a Citizen: the escrow to its funder (listed exactly when non-zero), the rest whole to its immutable rent payer; pending, the Citizen's marker clears (before CloseCitizen, which refuses the marker); Settled, before or after CloseCitizen (the Citizen position then the absent account at its address); a wide holding closes to its rent payer after its `pool_owed` is swept to the DefencePool |
//! | 0xDD | [`resident_act`] | canonical wide player commands (ClaimSite, Depart, Muster, Dissolve, Economy, Garrison) for an NFT resident's Citizen under the deployed resident check (current Core owner or session, the signed holder generation) |
//! | 0xDA | [`depart`] | **the wide march's departure**: the deployed Depart's checks in the deployed shape (the issuing holding's own province and the **standing** province the host's roster is in, as distinct accounts): the holding canonical and the caller's at the reference's generation, its province's capture lock, the standing province a wide province of this world (a deployed Province there is the legacy/wide boundary: `NotImplemented` before any debit), final, resident, the seal's syntax, the identity gate (`NotImplemented` for a holding that never mustered), the entry paired with the standing roster, the kernel's departure, the window, the tip, the slot's transit record absent, the funds; **writes** the entry's `Spend`, the escrow into the holding, the wide transit record from the payer, the `WIDE_DEPARTED` record |
//! | 0xDC op 3 | [`settle_departure`] | **writes**: the deployed SettleDeparture over the wide transit record and the origin's roster (the entry freed and released, the record stepped to state 2 or 3), the `WIDE_DEPARTURE_SETTLED` record |
//! | 0xEE | [`reveal`] | **writes** (class W, the one tag outside the band): the deployed Reveal over the wide records (the commitment, never a decryption; the window, the latch, the wide walk, the shield, the full-identity quota), the wide ArrivalSlot from the fee payer, the `WIDE_REVEALED` record |
//! | 0xDC op 4 | [`gather`] | **writes**: the deployed GatherClash over the wide slots and transit records into the wide ClashInputs (created from the fee payer), every first-gathered transit stamped, the `WIDE_GATHERED` record; no ArrivalDay exists: a resolve needs every position scanned |
//! | 0xDC op 1 | [`resolve`] | **writes**: the bell over the residents **and** the gathered arrivals (a present, fully gathered ClashInputs), the arrivals' fates written back, the `WIDE_RESOLVE` record binding the gathered bytes |
//! | 0xDC op 5 | [`settle_transit`] | **writes**: the deployed SettleTransit over the wide records: the proof (THE anchor's signature decompressed by the chain's BLS syscall — a failure there is the instruction error `Crypto`; the opener after it judges the seal's own points and a failure there is a seal code, as deployed), the deployed outcome and payment table as a pure plan ([`plan_settlement`]), the forfeit, the home re-entry through the home roster, the slot, the transit record closed to its immutable rent recipient, the `WIDE_TRANSIT_SETTLED` and `WIDE_RETURN` records |
//! | 0xDC op 6 | `defence_exec` (private child) | **writes**: a defence refund for 1–6 canonical wide slots using THE live anchors and the deployed shared pool and keeper-day claim; caps, counters, payout and claimed bits are staged; the deployed `DEFENCE_CLAIM` payment record is emitted, without a new wide receipt allocation |
//! | 0xDA op 3 | `economy_exec` (private child, phase B of the host-only wide economy) | **writes**: the S1 Harvest, Build or Train over a wide holding under the deployed player prologue (wallet, session or NFT resident through [`resident_act`]), the holding and its own province canonical and the Citizen's, the slot wide-bound; the body is the `wide_economy` preview over copies under pins derived from the authenticated records and the real clock; the Citizen's bucket on a copy; the `WIDE_ECONOMY` (holding-chained) or `WIDE_ECONOMY_MIRROR` (walls, tier-up: province and holding) receipt committing the complete input and output state; every chain and length decided before the first live write, the record logged after the last |
//! | 0xDA op 4 | `garrison_exec` (private child) | **writes**: deployed positive Spearman-reserve reinforcement into the holding's pending garrison, under the same player authorization and own-province checks; all Citizen/holding/province bytes and both chains staged before commit; distinct holding-keyed `WIDE_GARRISON` receipt. Host-only and provisional, not production allocation |
//!
//! **The wide ticket and the deployed paths.** While a wide ticket is
//! pending the Citizen carries the marker of `world_index::ticket`
//! (`TICKET_BELL` set, zero sites, the ticket bits), so FileTicket,
//! FileOutpost and PlaceHome refuse as they refuse any open ticket, the
//! deployed lowest-free-slot rule skips the slot, and SettleTicket,
//! CloseCitizen and DeclareSiege (a reservation) refuse it **explicitly**
//! through [`refuse_wide_ticket`] before they parse, refund or count
//! anything. The wide Holding's rent is **never** in the Citizen's shared
//! `TICKET_ESCROW` (sized at the deployed rent and shared with capture
//! reservations): the record holds it as its own `escrow` with its own
//! `funder` (the deployed `TICKET_FUNDER`) beside its **immutable**
//! `rent_payer` (the deployed Citizen `RENT_PAYER`: who created the
//! record), and follows the deployed escrow's life exactly
//! (`world_index::ticket`): a filing tops the escrow up to one wide rent
//! and the payer becomes the funder only when it tops up (FileOutpost's
//! rule, so a refile reuses the retained rent without re-attributing it);
//! a win moves exactly one wide rent into the holding or to a displaced
//! funder; an expired or taken ticket keeps it; after any settle the
//! record stays, **Settled**, with no marker on the Citizen, and nothing
//! is refunded while the Season runs. At season end the record closes
//! through [`close_ticket`] as CloseCitizen closes a Citizen: the escrow
//! to the funder, then everything else (the record's rent and any excess)
//! whole to the rent payer, pending or Settled, before or after the
//! Citizen's own close, and neither recipient is ever redirected by a
//! Citizen close, an NFT transfer or a later payer. The settler cost is burned at the filing
//! and never refunded, as deployed. There is no cancellation, as deployed:
//! a ticket ends by settle (expired, taken, won) or, at season end, by
//! [`close_ticket`].
//!
//! **Refusals precede writes.** A refused instruction reverts on chain
//! whatever it wrote; the host harness has no such rollback, so these
//! handlers are written to refuse **before** their first write: every
//! deterministic transition (the bucket, the marker, the cohort, the
//! slot's clear-and-bind, the displaced slot's unbind, the counters) runs
//! first on a scratch copy, and the one lamport-moving step (a CPI or a
//! program-owned move) runs before every byte write. WideDepart writes
//! nothing at all. The host tests execute each wide instruction through a
//! snapshot-and-restore executor (every account's lamports, bytes, length
//! and owner) and compare the restored state with the pre-state, which is
//! evidence of all-or-nothing under the emulation, not of the chain.
//!
//! **No PS2 record of a wide event.** No deployed record kind is allocated
//! for a wide opening, filing or settlement (the "record kinds" allocation
//! gap of `WIDE-LAND-WRITER.md` §3), and none is borrowed: the host
//! lifecycle (Muster, Resolve, Dissolve, Return, the roster close, the
//! march's departure, settles, reveal and gather) logs the **wide
//! format** of `world_index::event` (`PSW1`, version 0x82, its own kinds,
//! full-identity keys, a domain-separated chain over the wide accounts'
//! headers), which a deployed reader refuses as an unknown version and
//! never misreads. The deployed records a wide handler emits are deployed
//! ones on deployed accounts: the anchor's `HARVEST` for the settler cost,
//! the shared pool/claim's `DEFENCE_CLAIM` payment,
//! and a `DIVERT` when a refund or a settlement payment would leave its
//! recipient below rent exemption or names a program account. Readers see
//! the anchor's stores, the fund's and the JoinShard's counters move and
//! nothing of the wide land itself.
//!
//! **The march on the host.** Every stage runs through the real dispatch
//! on the host; the one thing the host cannot do is the transit
//! settlement's proof. Its first step, the decompression of THE anchor's
//! round signature (`sys::bls_g1_decompress`), is an **instruction error**
//! on failure (`Crypto(BAD_POINT)`): a syscall that cannot run is never a
//! seal verdict, and the host build's stub fails exactly there, after
//! every pre-judgement check and before any effect. The steps after it
//! are the deployed opener's (`crypto::seal::judge_wide`): a failure of
//! the seal's **own** points (the IBE block's G2 point, the pairing, the
//! FO check) **is** a verdict, seal code 1 or 2, as deployed — a bad seal
//! is confiscated for it. No host test reaches that opener, and none
//! claims to; the post-judgement plan is a pure function with fixed-byte
//! tests of its own.
//!
//! **Who may act.** The player handlers take the program's [`super::Auth`]:
//! the wallet prologue, or an NFT resident's Citizen through the real
//! resident check (`super::resident::start`: the asset's current Core
//! owner or its session, at the signed holder generation). The plain
//! dispatch runs them as [`super::Auth::Wallet`], which refuses an NFT
//! Citizen by address (zero `WALLET`); [`resident_act`] (0xDD, this band)
//! runs them as [`super::Auth::Resident`] with the four proof accounts.
//! The deployed `ResidentAct` (0xE2) routes only the ABI v2 tags of
//! `resident_wire::ACT_RUNS`, which no draft tag is, and this band's act
//! routes only this band: neither list is extended.
//!
//! **Engineering versus product.** Everything written here reuses a
//! deployed kernel or a deployed handler's rule; the only choices that are
//! not the deployed ones are the four candidate rules a configuration
//! names (and the configuration itself is explicit, versioned, write-once
//! and host-only). What the deployed rules leave open and is **not**
//! decided here: whether wide sites count in the fund's `open_sites`
//! (they do, as every opened province's do, so the fold, θ and Join
//! capacity see them) and wide prize eligibility (nothing here touches the
//! tally).

use alloc::vec::Vec;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::archive_part_of;
use frontier_abi::conquest_model::{write_keep, write_no_keep, StepParams};
use frontier_abi::entry::{find_entry, read_entry, unit_from_u8, write_entry, Entry, EntryOp};
use frontier_abi::layout::AccountKind;
use frontier_abi::log::{divert_reason, seal_code, settle_outcome, Kind};
use frontier_abi::prologue as ap;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::arrival::{
    self as wa, WideArrival, WideArrivalSlot, WideClashInputsHdr,
};
use frontier_abi::world_index::event::{self as wev, WideEntity, WideKind, WideLink};
use frontier_abi::world_index::holding::{self as wh, HoldingError, SlotBinding, WideHolding};
use frontier_abi::world_index::land::{
    self as wl, Decision, LandError, PreviousRing, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING,
};
use frontier_abi::world_index::march::{
    self as wm, wide_host_alias, MarchError, MarchEvent, MarchState, WideTransit,
};
use frontier_abi::world_index::resolve::{self as wres, ResolveError};
use frontier_abi::world_index::roster::{self as wro, WideRoster};
use frontier_abi::world_index::rules::{self as wr, OpeningInput, RulesError, WideRulesConfig};
use frontier_abi::world_index::seal::{self as wseal, WidePlain};
use frontier_abi::world_index::ticket::{
    self as wt, CitizenTicket, TicketError, TicketStatus, WideTicket,
};
use frontier_abi::world_index::tiles::{TileAddress, WideTile};
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use permutation_rules::fixed::{MilliTroops, MILLI};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::clash::{frontier_ruleset, SlotRefusal, NEUTRAL};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::fees::{self, DefenceParams};
use permutation_rules::frontier::geometry::{R_MAX_HARD, SITES_PER_PROVINCE};
use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck, Tier};
use permutation_rules::frontier::host::{effective_bell, Host, Stamina, DESTROYED_BELOW};
use permutation_rules::frontier::seal as ks;
use permutation_rules::frontier::siege;
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::wide::generate_province_wide;
use permutation_rules::frontier::travel::{
    check_arrival_bell, is_cavalry, FLAT_HEX_SECS, MAX_PATH_PROVINCES, MAX_PATH_STEPS,
    ROUGH_HEX_SECS,
};

use crate::addr::{self, AddrCtx};
use crate::clock::SeasonClock;
use crate::crypto::{quick, seal as cseal, sys};
use crate::error::{crypto, kernel, BAD_ACCOUNT, OVERFLOW};
use crate::events::{self, Buf};
use crate::evidence;
use crate::init::{self, Paid, SeasonSigner, Sink};
use crate::layout::beacon::{archive_key, archive_tombstoned};
use crate::layout::conquest::{lifecycle, season_cq};
use crate::layout::{
    beacon_log as BL, bell_anchor as BA, camp as CP, citizen as C, citizen2 as C2, entry as E,
    frontier as FR, holding as H, join_shard2 as JS2, province as PV, province2 as PV2,
    province_fund as PF, season as S, site as SM, site2 as SM2, summary as SU, transit as T, Ro,
    Rw,
};
use crate::proc::beacon::{anchor_of_any_region, the_anchor_or_archive, AnchorSource};
use crate::proc::citizen::{self as cz, write_holding as write_founding, Founding};
use crate::proc::conquest::{capture_lock_of, check_source_province};
use crate::proc::holding as hold;
use crate::proc::map::{encode_terrain, present_at, ring_occupancy_met, LAND_STATUS, SUB_KEEP_CAP};
use crate::proc::Auth;
use crate::prologue::{self, check_accounts, expect_key, key, view, IxTable};
use crate::{FrontierError, R, RULESET_HASH};

impl IxTable for WideIx {
    fn groups(self) -> &'static [ap::Group] {
        wix::accounts_of(self)
    }
    fn top_level_only(self) -> bool {
        WideIx::top_level_only(self)
    }
}

/// Routes a draft-band instruction (the caller checked `is_draft_tag`) by
/// its **fully decoded command** (`wide_ix::WideCommand::decode`: the
/// tag's legacy encoding at its exact length, or a whole envelope
/// sub-operation; `BadData` otherwise). The legacy handlers decode their
/// own data again; the envelope handlers take the decoded command.
pub fn dispatch(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    use wix::WideCommand as C;
    match C::decode(data)? {
        C::RequestRingSeed(_) => request_ring_seed(p, a, data),
        C::ConsumeRingSeed(_) => consume_ring_seed(p, a, data),
        C::OpenProvince(_) => open_province(p, a, data),
        C::ClaimSite(_) => claim_site(p, a, data),
        C::Depart(_) => depart(p, a, data),
        C::SetRules(_) => set_rules(p, a, data),
        C::SettleTicket(_) => settle_ticket(p, a, data),
        C::ResidentAct(_) => resident_act(p, a, data),
        C::Close(_) => close(p, a, data),
        C::Finalize(_) => finalize(p, a, data),
        C::Muster(x) => muster_as(p, a, &x, &Auth::Wallet),
        C::Dissolve(x) => dissolve_as(p, a, &x, &Auth::Wallet),
        C::Economy(x) => economy_exec::economy_as(p, a, &x, &Auth::Wallet),
        C::Garrison(x) => garrison_exec::garrison_as(p, a, &x, &Auth::Wallet),
        C::DeclareSiege(x) => conquest_exec::declare_siege_as(p, a, &x, &Auth::Wallet),
        C::SettleSiege(x) => conquest_settle_exec::settle_siege(p, a, &x),
        C::SettleCapture(x) => conquest_settle_exec::settle_capture(p, a, &x),
        C::ResolveWithConquest(x) => resolve_with_conquest(p, a, &x),
        C::CloseConquest(x) => conquest_settle_exec::close_conquest(p, a, &x),
        C::CloseCaptureEscrow(_) => conquest_settle_exec::close_capture_escrow(p, a),
        C::Resolve(x) => resolve(p, a, &x),
        C::Return(_) => settle_return(p, a),
        C::CloseRoster(_) => close_roster(p, a),
        C::DisbandStranded(x) => stranded_exec::disband_stranded(p, a, &x),
        C::SettleDeparture(x) => settle_departure(p, a, &x),
        C::Gather(x) => gather(p, a, &x),
        C::SettleTransit(x) => settle_transit(p, a, &x),
        C::ClaimDefence(x) => defence_exec::claim_defence(p, a, &x),
        C::ExpeditionDepart(x) => {
            if !expedition_exec::EXPEDITION_ENABLED {
                return Err(FrontierError::NotImplemented.into());
            }
            expedition_exec::execute_depart(p, a, &x, &Auth::Wallet)
        }
        C::ExpeditionSettleOrigin(x) => {
            if !expedition_exec::EXPEDITION_ENABLED {
                return Err(FrontierError::NotImplemented.into());
            }
            expedition_exec::execute_origin(p, a, x.transit_slot)
        }
        // Provisional mixed producers remain unconditionally closed.
        C::ExpeditionReveal(_) | C::ExpeditionGather(_) => {
            Err(FrontierError::NotImplemented.into())
        }
        C::Reveal(x) => reveal(p, a, &x),
    }
}

// ------------------------------------------------------------ gates

/// The Season is this experimental build's: its stored `program_version`
/// is the build's, which carries the wide bit (`RulesetMismatch`
/// otherwise, so a production Season is never touched).
fn require_wide_season(season_ai: &AccountInfo) -> R<()> {
    let sd = season_ai.try_borrow_data()?;
    let v = Ro(&sd).u16(S::PROGRAM_VERSION)?;
    if v != crate::PROGRAM_VERSION || v & wix::WIDE_EXPERIMENTAL_VERSION_BIT == 0 {
        return Err(FrontierError::RulesetMismatch.into());
    }
    Ok(())
}

/// The one legacy world of this Season (`WorldId::derive_legacy_season`
/// of its public address context).
fn world_of(ctx: &AddrCtx) -> R<WorldId> {
    WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| BAD_ACCOUNT)
}

/// A land model refusal as a program code (no new code: the deployed
/// counterparts' codes, `NotImplemented` for an undecided rule).
fn land_err(e: LandError) -> crate::Error {
    match e {
        LandError::NotWide { .. } => FrontierError::BadData.into(),
        LandError::ChainBroken { .. } | LandError::TooEarly { .. } => {
            FrontierError::TooEarly.into()
        }
        LandError::PreviousUnseeded | LandError::NotSeeded => FrontierError::SeedNotReady.into(),
        LandError::AlreadySeeded => FrontierError::AlreadyDone.into(),
        LandError::WrongRound { .. } => FrontierError::WrongRound.into(),
        LandError::NotReady { .. } => FrontierError::NotImplemented.into(),
        LandError::Overflow => OVERFLOW,
        _ => BAD_ACCOUNT,
    }
}

fn holding_err(e: HoldingError) -> crate::Error {
    match e {
        HoldingError::NotReady => FrontierError::NotImplemented.into(),
        HoldingError::FirstHomeIsLegacy
        | HoldingError::BadSlot(_)
        | HoldingError::NotWide { .. }
        | HoldingError::SiteOrGen { .. } => FrontierError::BadData.into(),
        HoldingError::SlotTaken(_)
        | HoldingError::TicketOnSlot(_)
        | HoldingError::SlotReserved(_)
        | HoldingError::HoldingsCount(_)
        | HoldingError::NotWideBound(_) => FrontierError::TicketState.into(),
        HoldingError::DebitWithoutIdentity => FrontierError::HostInTransit.into(),
        _ => BAD_ACCOUNT,
    }
}

fn march_err(e: MarchError) -> crate::Error {
    match e {
        MarchError::HostIdentityUnallocated => FrontierError::NotImplemented.into(),
        MarchError::ArrivalBell { .. } => FrontierError::ArrivalBell.into(),
        MarchError::InvalidTransition { .. } => FrontierError::TransitState.into(),
        MarchError::WorldMismatch => FrontierError::BadAddress.into(),
        _ => BAD_ACCOUNT,
    }
}

/// A rules-configuration refusal as a program code: an unset, unknown or
/// wrong-version byte is bad data; a record of another season or world is
/// a bad account.
fn rules_err(e: RulesError) -> crate::Error {
    match e {
        RulesError::Unset(_)
        | RulesError::Unknown { .. }
        | RulesError::Version { .. }
        | RulesError::NotWide { .. } => FrontierError::BadData.into(),
        _ => BAD_ACCOUNT,
    }
}

// ------------------------------------------------------------ wide accounts

/// A wide ring seed at an address the caller checked: `None` if absent
/// (System-owned, no data); the record if present, program-owned, well
/// formed and of this season; `BadAccount` otherwise.
fn ring_seed_at(ai: &AccountInfo, p: &Pubkey, season_id: u64) -> R<Option<WideRingSeed>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideRingSeed::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// As [`ring_seed_at`] for a wide province.
fn province_at(ai: &AccountInfo, p: &Pubkey, season_id: u64) -> R<Option<WideProvince>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideProvince::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// As [`ring_seed_at`] for a wide holding.
fn holding_at(ai: &AccountInfo, p: &Pubkey, season_id: u64) -> R<Option<WideHolding>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideHolding::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// As [`ring_seed_at`] for the Season's rules configuration, which must
/// also be of this world.
fn rules_config_at(
    ai: &AccountInfo,
    p: &Pubkey,
    season_id: u64,
    world: WorldId,
) -> R<Option<WideRulesConfig>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideRulesConfig::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id || rec.world != world {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

fn read_u32x6(r: &Ro, off: usize) -> R<[u32; 6]> {
    let mut v = [0u32; 6];
    for (i, x) in v.iter_mut().enumerate() {
        *x = r.u32(off + 4 * i)?;
    }
    Ok(v)
}

// ------------------------------------------------------------ 0xD6

/// 0xD6 WideRequestRingSeed(ring): `[payer s,w] [season r] [frontier r]
/// [previous r] [wide_ringseed w] [pfund × 6 r] [system]`. The deployed
/// OpenRing gates for a ring beyond `g`, continued past the disk: the
/// Season Running and this build's; `ring ≥ 129` (`BadData`); the
/// previous ring's seed present and seeded (`previous` is the legacy
/// RingSeed of ring 128 for ring 129, else the wide seed of `ring − 1`;
/// absent: `TooEarly`, unseeded: `SeedNotReady`); the target absent
/// (`AlreadyDone`); a bell since the previous ring opened (`TooEarly`);
/// some wedge at θ occupancy on the folded Frontier (`Capacity`); every
/// wedge fund above its rent by `ring × rent(wide province)`
/// (`Insufficient`). Effects: the record, created from the payer's
/// lamports, status requested with `round = ring_seed_round(now)`. No
/// legacy account is written.
pub fn request_ring_seed(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::RequestRingSeed, a, None)?;
    let x = wix::RequestRingSeed::decode(d)?;
    let [payer, season_ai, frontier, previous, target, funds @ .., _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING],
        now.ts,
    )?;
    require_wide_season(season_ai)?;
    if x.ring < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    present_at(frontier, &ctx.frontier(), p, AccountKind::Frontier, hdr.id)?;
    // The previous ring's seed, read-only.
    if previous.is_writable {
        return Err(BAD_ACCOUNT);
    }
    let prev = if x.ring == FIRST_WIDE_RING {
        present_at(
            previous,
            &ctx.ring_seed(R_MAX_HARD),
            p,
            AccountKind::RingSeed,
            hdr.id,
        )?;
        let rd = previous.try_borrow_data()?;
        let r = Ro(&rd);
        if r.u16(crate::layout::ring_seed::D)? != R_MAX_HARD {
            return Err(BAD_ACCOUNT);
        }
        PreviousRing {
            ring: R_MAX_HARD as u64,
            seeded: r.u8(crate::layout::ring_seed::STATUS)?
                == crate::layout::ring_seed::STATUS_SEEDED,
            opened_bell: r.u32(crate::layout::ring_seed::OPENED_BELL)?,
        }
    } else {
        // `ring ≥ 130`: no underflow.
        let prev_ring = x.ring - 1;
        expect_key(previous, &wl::ring_seed_address(&ctx, prev_ring))?;
        let rec = ring_seed_at(previous, p, hdr.id)?.ok_or(FrontierError::TooEarly)?;
        if rec.ring != prev_ring || rec.world != world {
            return Err(BAD_ACCOUNT);
        }
        PreviousRing {
            ring: rec.ring,
            seeded: rec.status == wl::SeedStatus::Seeded,
            opened_bell: rec.opened_bell,
        }
    };
    expect_key(target, &wl::ring_seed_address(&ctx, x.ring))?;
    if ring_seed_at(target, p, hdr.id)?.is_some() {
        return Err(FrontierError::AlreadyDone.into());
    }
    // The model: chain, previous seeded, a bell since; the beacon round.
    let (theta_early, theta_late, theta_switch, clock) = {
        let sd = season_ai.try_borrow_data()?;
        let r = Ro(&sd);
        (
            r.u16(S::THETA_EARLY_BPS)?,
            r.u16(S::THETA_LATE_BPS)?,
            r.u32(S::THETA_SWITCH_SECS)?,
            SeasonClock::read(&sd)?,
        )
    };
    let now_bell = hdr.bell(now.ts).unwrap_or(0);
    let rec = WideRingSeed::request(
        world,
        hdr.id,
        x.ring,
        prev,
        now_bell,
        now.ts,
        &clock.beacon(),
        clock.seed_margin,
        key(payer),
    )
    .map_err(land_err)?;
    // θ on the folded legacy counters (the deployed rule, read-only).
    let (occ, open) = {
        let fd = frontier.try_borrow_data()?;
        let r = Ro(&fd);
        (
            read_u32x6(&r, FR::WEDGE_OCCUPIED)?,
            read_u32x6(&r, FR::WEDGE_OPEN)?,
        )
    };
    let theta = if now.ts.saturating_sub(hdr.genesis_ts) < theta_switch as i64 {
        theta_early
    } else {
        theta_late
    };
    if !ring_occupancy_met(&occ, &open, theta) {
        return Err(FrontierError::Capacity.into());
    }
    // The six wedge funds, canonical and present, each covering the ring.
    let need = wl::ring_rent(x.ring, init::rent(wl::province::SIZE)?).ok_or(OVERFLOW)?;
    let fund_rent = init::rent(PF::SIZE)?;
    for (w, f) in funds.iter().enumerate() {
        present_at(
            f,
            &ctx.province_fund(w as u8),
            p,
            AccountKind::ProvinceFund,
            hdr.id,
        )?;
        if f.lamports().saturating_sub(fund_rent) < need {
            return Err(FrontierError::Insufficient.into());
        }
    }
    init::init_with_seed(
        payer,
        target,
        season_ai,
        &SeasonSigner::new(hdr.id, hdr.bump),
        &wl::ring_seed_seed(x.ring),
        wl::ring_seed::SIZE,
        init::rent(wl::ring_seed::SIZE)?,
        p,
    )?;
    let mut td = target.try_borrow_mut_data()?;
    rec.write(&mut td).map_err(|_| BAD_ACCOUNT)
}

// ------------------------------------------------------------ 0xD7

/// 0xD7 WideConsumeRingSeed(ring, round, sig48, hints): K +
/// `[wide_ringseed w]`, top-level only. The deployed ConsumeRingSeed over
/// the wide record: Seeded/Running and this build's Season; the record
/// present, of this ring and world, requested (`AlreadyDone` if seeded);
/// `round == record.round` (`WrongRound`); the round due; the hinted
/// quicknet verification (`Crypto` sub-codes; the host build cannot
/// verify and fails closed); `seed = quick::seed_of(round, sig96)`.
pub fn consume_ring_seed(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::ConsumeRingSeed, a, None)?;
    prologue::top_level(WideIx::ConsumeRingSeed)?;
    let x = wix::ConsumeRingSeed::decode(d)?;
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &LAND_STATUS, now.ts)?;
    let [_fee_payer, season_ai, target] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    require_wide_season(season_ai)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(target, &wl::ring_seed_address(&ctx, x.ring))?;
    let rec = ring_seed_at(target, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if rec.ring != x.ring || rec.world != world {
        return Err(BAD_ACCOUNT);
    }
    if rec.status == wl::SeedStatus::Seeded {
        return Err(FrontierError::AlreadyDone.into());
    }
    if x.round != rec.round {
        return Err(FrontierError::WrongRound.into());
    }
    let clock = {
        let sd = season_ai.try_borrow_data()?;
        SeasonClock::read(&sd)?
    };
    super::season::round_is_due(&clock, x.round, now.ts)?;
    let sig96 = quick::verify(x.round, &x.sig48, &x.hints)?;
    let seed = quick::seed_of(x.round, &sig96);
    let seeded = rec.seed_with(x.round, seed).map_err(land_err)?;
    let mut td = target.try_borrow_mut_data()?;
    seeded.write(&mut td).map_err(|_| BAD_ACCOUNT)
}

// ------------------------------------------------------------ 0xDB

/// 0xDB WideSetRules(config_version, keep_holder, free_city, camp,
/// region): `[authority s,w] [season r] [rules_config w] [system]`,
/// top-level only. Seeded/Running and this build's Season; the signer is
/// the Season's stored authority (`Auth`); the configuration absent at its
/// canonical address (`AlreadyDone`: write-once); `config_version` the
/// current table and every byte a known candidate (`BadData`; byte 0 is
/// unset and refused). Effects: the record, created from the authority's
/// lamports. It is the one input a wide opening reads its rules from;
/// its absence keeps every opening `NotImplemented`.
pub fn set_rules(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::SetRules, a, None)?;
    prologue::top_level(WideIx::SetRules)?;
    let x = wix::SetRules::decode(d)?;
    let [authority, season_ai, config, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(season_ai, p, Some(&RULESET_HASH), &LAND_STATUS, now.ts)?;
    require_wide_season(season_ai)?;
    let stored_authority: [u8; 32] = {
        let sd = season_ai.try_borrow_data()?;
        Ro(&sd).arr(S::AUTHORITY)?
    };
    if key(authority) != stored_authority {
        return Err(FrontierError::Auth.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(config, &wr::rules_config_address(&ctx))?;
    if rules_config_at(config, p, hdr.id, world)?.is_some() {
        return Err(FrontierError::AlreadyDone.into());
    }
    if x.config_version != wr::WIDE_RULES_CONFIG_VERSION {
        return Err(FrontierError::BadData.into());
    }
    let rec = WideRulesConfig::new(
        hdr.id,
        world,
        key(authority),
        wr::RuleBytes {
            keep_holder: x.keep_holder,
            free_city: x.free_city,
            camp: x.camp,
            region: x.region,
        },
    )
    .map_err(rules_err)?;
    init::init_with_seed(
        authority,
        config,
        season_ai,
        &SeasonSigner::new(hdr.id, hdr.bump),
        &wr::rules_config_seed(),
        wr::rules_config::SIZE,
        init::rent(wr::rules_config::SIZE)?,
        p,
    )?;
    let mut cd = config.try_borrow_mut_data()?;
    rec.write(&mut cd).map_err(|_| BAD_ACCOUNT)
}

// ------------------------------------------------------------ 0xD8

/// 0xD8 WideOpenProvince(P, Q): `[payer s,w] [season r] [wide_ringseed w]
/// [pfund w] [province w] [rules_config r] [system]`, top-level only. The
/// deployed OpenProvince checks over wide identities: Seeded/Running and
/// this build's Season; `WideCoord::checked` and `ring ≥ 129` (`BadData`;
/// the disk is `OpenProvince`'s); the ring's wide seed present and seeded
/// (`SeedNotReady`), of this world; the geometric wedge's fund canonical
/// and present; the province absent at its canonical wide address
/// (`AlreadyDone`); the configuration at its canonical address,
/// read-only.
///
/// **Without a configuration** the readiness gate refuses `NotImplemented`
/// before any write (`WideRules::UNDECIDED`): no fund lamport moves, no
/// account is created, the seed's count is unchanged.
///
/// **With one**, what OpenProvince writes, over the Province v2 offsets
/// the wide record keeps: the terrain of the wide kernel
/// (`terrain::wide::generate_province_wide` over the ring seed, the same
/// shaping as the legacy kernel), `resolved_next = opened_bell =
/// score_next_bell = now_bell`, every site free and neutral, the keep on
/// the deployed symmetric tile (`kernel::keep::keep_tile`) held by the
/// configured candidate nation with the season's home guard (never
/// heartland-safe), the configured Free City (the season's garrison, as
/// the deployed one) and initial camp, `next_check_day = day + 1`; the
/// identity trailer last. The province is created from the wedge fund
/// (`init_funded`, pre-funding-safe); the fund's `open_sites +=
/// site_count`, `provinces_opened += 1`, `provinces_funded += 1`,
/// `spent_total += spent`; the wide seed's `provinces_created += 1`. No
/// Frontier write, no PS2 record (module doc).
pub fn open_province(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::OpenProvince, a, None)?;
    prologue::top_level(WideIx::OpenProvince)?;
    let x = wix::OpenProvince::decode(d)?;
    let [_payer, season_ai, ringseed, fund, target, config, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(season_ai, p, Some(&RULESET_HASH), &LAND_STATUS, now.ts)?;
    require_wide_season(season_ai)?;
    let coord = WideCoord::checked(x.p, x.q).map_err(|_| FrontierError::BadData)?;
    let ring = coord.ring();
    if ring < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(ringseed, &wl::ring_seed_address(&ctx, ring))?;
    let seed = ring_seed_at(ringseed, p, hdr.id)?.ok_or(FrontierError::SeedNotReady)?;
    if seed.ring != ring || seed.world != world {
        return Err(BAD_ACCOUNT);
    }
    let ring_seed = *seed.terrain_seed().ok_or(FrontierError::SeedNotReady)?;
    let wedge = coord.wedge().ok_or(FrontierError::BadData)?;
    present_at(
        fund,
        &ctx.province_fund(wedge),
        p,
        AccountKind::ProvinceFund,
        hdr.id,
    )?;
    expect_key(target, &wl::province_address(&ctx, coord))?;
    if province_at(target, p, hdr.id)?.is_some() {
        return Err(FrontierError::AlreadyDone.into());
    }
    if config.is_writable {
        return Err(BAD_ACCOUNT);
    }
    expect_key(config, &wr::rules_config_address(&ctx))?;
    let cfg = rules_config_at(config, p, hdr.id, world)?;
    let now_bell = hdr.bell(now.ts).unwrap_or(0);
    let Some(cfg) = cfg else {
        // No explicit configuration: the readiness gate, as before. The
        // model refuses `NotReady` naming every rule, mapped to
        // `NotImplemented`; nothing below runs.
        let _opening = WideProvince::open(
            world,
            hdr.id,
            coord,
            &seed,
            &WideRules::UNDECIDED,
            now_bell,
            0,
        )
        .map_err(land_err)?;
        return Err(FrontierError::NotImplemented.into());
    };
    // Everything the province holds, computed before any lamport moves.
    let (cq, genesis_seed) = {
        let sd = season_ai.try_borrow_data()?;
        (season_cq(&sd)?, Ro(&sd).arr::<32>(S::GENESIS_SEED)?)
    };
    let terrain = generate_province_wide(&ring_seed, coord.p(), coord.q())
        .map_err(|_| FrontierError::BadData)?;
    let day = addr::day_of(now_bell);
    // The keep's tile follows the wedge (terrain symmetry), as deployed;
    // its holder follows the configured candidate.
    let keep_tile = kkeep::keep_tile(&terrain, &terrain.sites, terrain.site_count, wedge)
        .unwrap_or(kkeep::NO_KEEP_TILE);
    let rules = cfg
        .decide(&OpeningInput {
            coord,
            genesis_seed: &genesis_seed,
            ring_seed: &ring_seed,
            terrain: &terrain,
            day,
            keep_tile: (keep_tile != kkeep::NO_KEEP_TILE).then_some(keep_tile),
            free_cities: cq.free_city_min_ring != 0,
        })
        .map_err(rules_err)?;
    let mut opening =
        WideProvince::open(world, hdr.id, coord, &seed, &rules, now_bell, 0).map_err(land_err)?;
    let keep = wr::wide_keep_open(opening.keep_holder, keep_tile, &cq.keep_params(), now_bell)
        .map_err(|_| kernel(SUB_KEEP_CAP))?;
    let garrison_milli = cq
        .free_city_garrison
        .checked_mul(MILLI as u32)
        .ok_or(OVERFLOW)?;
    let next_check_day = day.checked_add(1).ok_or(OVERFLOW)?;
    let counted = seed.with_province_created().map_err(land_err)?;
    // Check all fund-counter arithmetic before allocating or moving rent.
    // Host dispatch has no transaction rollback; refusal must remain inert.
    let site_count = terrain.site_count;
    let expected_spent = init::rent(wl::province::SIZE)?.saturating_sub(target.lamports());
    let (open_sites, provinces_opened, provinces_funded, spent_total) = {
        let fd = fund.try_borrow_data()?;
        let r = Ro(&fd);
        (
            r.u32(PF::OPEN_SITES)?
                .checked_add(site_count as u32)
                .ok_or(OVERFLOW)?,
            r.u32(PF::PROVINCES_OPENED)?
                .checked_add(1)
                .ok_or(OVERFLOW)?,
            r.u32(PF::PROVINCES_FUNDED)?
                .checked_add(1)
                .ok_or(OVERFLOW)?,
            r.u64(PF::SPENT_TOTAL)?
                .checked_add(expected_spent)
                .ok_or(OVERFLOW)?,
        )
    };
    // Effects: the account from the wedge fund, then its bytes.
    let spent = init::init_funded(
        fund,
        target,
        season_ai,
        &SeasonSigner::new(hdr.id, hdr.bump),
        &wl::province_seed(coord),
        wl::province::SIZE,
        p,
        0,
    )?;
    opening.province.funded_lamports = spent;
    {
        let mut pd = target.try_borrow_mut_data()?;
        encode_terrain(&terrain, &mut pd)?;
        {
            let mut w = Rw(&mut pd);
            w.set_u32(PV::RESOLVED_NEXT, now_bell)?;
            w.set_u32(PV2::SCORE_NEXT_BELL, now_bell)?;
            for i in 0..PV::SITES_N {
                let o = PV::site(i);
                w.set_u8(o + SM::STATE, SM::STATE_FREE)?;
                w.set_u8(o + SM::FACTION, NEUTRAL)?;
                w.set_u32(o + SM::PEND0_BELL, SM::NO_BELL)?;
                w.set_u32(o + SM::PEND1_BELL, SM::NO_BELL)?;
            }
            if let Some(fc) = opening.free_city_site {
                let o = PV::site(fc as usize);
                w.set_u8(o + SM2::STATE, SM2::STATE_FREE_CITY)?;
                w.set_u8(o + SM2::FACTION, NEUTRAL)?;
                w.set_u8(o + SM2::ORDER, 0)?;
                w.set_u8(o + SM2::TIER, Tier::Hamlet as u8)?;
                w.set_u8(o + SM2::GEN, 0)?;
                w.set_u16(o + SM2::HELD_SINCE_HOUR, 0)?;
                w.set_u32(o + SM2::GARRISON, garrison_milli)?;
            }
            if let Some(cmp) = opening.camp {
                w.set_u8(PV::CAMP + CP::TILE, cmp.tile)?;
                w.set_u8(PV::CAMP + CP::STATE, CP::STATE_PRESENT)?;
                w.set_u32(PV::CAMP + CP::TROOPS, cmp.troops)?;
                w.set_u32(PV::CAMP + CP::GEN, 1)?;
            }
            w.set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, next_check_day)?;
        }
        match keep.as_ref() {
            Some(k) => write_keep(&mut pd, k)?,
            None => write_no_keep(&mut pd)?,
        }
        // The identity last: the header, the zero legacy prefix identity,
        // the wedge, the region, the opened bell and the trailer.
        opening
            .province
            .write_identity(&mut pd)
            .map_err(|_| BAD_ACCOUNT)?;
    }
    // The wedge fund's live counters (I-48) and the wide seed's count.
    {
        let mut fdat = fund.try_borrow_mut_data()?;
        let mut w = Rw(&mut fdat);
        w.set_u32(PF::OPEN_SITES, open_sites)?;
        w.set_u32(PF::PROVINCES_OPENED, provinces_opened)?;
        w.set_u32(PF::PROVINCES_FUNDED, provinces_funded)?;
        w.set_u64(PF::SPENT_TOTAL, spent_total)?;
    }
    let mut rd = ringseed.try_borrow_mut_data()?;
    counted.write(&mut rd).map_err(|_| BAD_ACCOUNT)
}

// ------------------------------------------------------------ player gates

/// Steps 1 and 2 of the deployed player prologue, **read-only** (the
/// bucket debit of step 3 is a write and never runs before a gate the
/// handlers below cannot pass): under [`Auth::Wallet`] the actor and payer
/// sign, the Season is Running with this ruleset at its recomputed PDA,
/// the Citizen is present at its **wallet** address and the actor is the
/// wallet or its unexpired session; under [`Auth::Resident`] the same
/// signatures and Season, then the real resident check
/// (`super::resident::start`: the four read-only proof accounts, the
/// asset's current Core owner or its session, the signed holder
/// generation current). Then the wide version gate.
///
/// An NFT resident's Citizen has a zero `WALLET` and lives at the resident
/// id's address, so the wallet form refuses it by address (`BadAddress`);
/// the resident form is reachable only from a dispatcher that carries the
/// proof, and `ResidentAct` does not route a draft tag (module doc).
fn player_start_as(p: &Pubkey, a: &[AccountInfo], now: i64, auth: &Auth) -> R<ap::PlayerStart> {
    let [actor, payer, season_ai, citizen, ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let start = if let Some((proof, generation)) = super::resident::proof_of(auth) {
        super::resident::start(p, a, proof, generation, true, now)?
    } else {
        let sd = season_ai.try_borrow_data()?;
        let cd = citizen.try_borrow_data()?;
        let views = [
            view(actor, &[]),
            view(payer, &[]),
            view(season_ai, &sd),
            view(citizen, &cd),
        ];
        ap::player_prologue(&views, p.as_array(), &RULESET_HASH, now, true)?
    };
    if addr::season_pda(start.season.id, start.season.bump, p.as_array()) != key(season_ai) {
        return Err(FrontierError::BadAddress.into());
    }
    require_wide_season(season_ai)?;
    Ok(start)
}

// ------------------------------------------------------------ wide tickets

/// The explicit refusal of a pending wide ticket in a deployed path: the
/// marker (`ticket::pending`) is `TicketState`; a marker no program writes
/// is `BadAccount`; no ticket or a deployed ticket passes. Called, under
/// this feature only, by the deployed SettleTicket (before its sites are
/// parsed and before its expiry branch), CloseCitizen (before the escrow
/// refund and the close) and DeclareSiege (before a capture reservation
/// counts the ticket at the deployed rent).
pub(crate) fn refuse_wide_ticket(citizen: &[u8]) -> R<()> {
    match wt::pending(citizen) {
        Ok(CitizenTicket::Wide { .. }) => Err(FrontierError::TicketState.into()),
        Ok(_) => Ok(()),
        Err(_) => Err(BAD_ACCOUNT),
    }
}

/// Active wide capture reservations have independent rent and full target
/// bindings. Their cleanup must precede CloseCitizen. Pending WideTicket and
/// wide captures also remain an unsupported combination in both directions.
pub(crate) fn refuse_wide_capture(citizen: &[u8]) -> R<()> {
    let slots = Ro(citizen).u8(C2::SLOTS)?;
    match frontier_abi::world_index::conquest::has_wide_reservations(slots) {
        Ok(false) => Ok(()),
        Ok(true) => Err(FrontierError::TicketState.into()),
        Err(_) => Err(BAD_ACCOUNT),
    }
}

/// A ticket-model refusal as a program code (the deployed counterparts').
fn ticket_err(e: TicketError) -> crate::Error {
    match e {
        TicketError::TicketOpen
        | TicketError::NoWideTicket
        | TicketError::SlotTaken(_)
        | TicketError::SlotReserved(_) => FrontierError::TicketState.into(),
        TicketError::NotWide { .. } | TicketError::SiteOrSlot { .. } => {
            FrontierError::BadData.into()
        }
        TicketError::Escrow => FrontierError::Insufficient.into(),
        _ => BAD_ACCOUNT,
    }
}

/// The wide ticket record at an address the caller checked: `None` if
/// absent; the record if present, program-owned, well formed and of this
/// season and world; `BadAccount` otherwise.
fn ticket_at(
    ai: &AccountInfo,
    p: &Pubkey,
    season_id: u64,
    world: WorldId,
) -> R<Option<WideTicket>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideTicket::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id || rec.world != world {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// The pending wide ticket of `citizen`: the Citizen's marker and the
/// **Open** record at the Citizen's canonical ticket address, agreeing on
/// the bell and the slot and naming this Citizen (`NoTicket` without a
/// marker, `TicketState` for a deployed ticket, `BadAccount` for any
/// disagreement, a Settled record included: the marker and the record's
/// status are written together).
fn pending_ticket(
    p: &Pubkey,
    ctx: &AddrCtx,
    season_id: u64,
    world: WorldId,
    citizen: &AccountInfo,
    record: &AccountInfo,
) -> R<WideTicket> {
    let marker = {
        let cd = citizen.try_borrow_data()?;
        wt::pending(&cd).map_err(|_| BAD_ACCOUNT)?
    };
    let (bell, slot) = match marker {
        CitizenTicket::None => return Err(FrontierError::NoTicket.into()),
        CitizenTicket::Legacy => return Err(FrontierError::TicketState.into()),
        CitizenTicket::Wide { bell, slot } => (bell, slot),
    };
    expect_key(record, &wt::ticket_address(ctx, &key(citizen)))?;
    let rec = ticket_at(record, p, season_id, world)?.ok_or(BAD_ACCOUNT)?;
    if rec.status != TicketStatus::Open
        || rec.citizen != key(citizen)
        || rec.bell != bell
        || rec.slot != slot
    {
        return Err(BAD_ACCOUNT);
    }
    Ok(rec)
}

/// The record's lamports cover its own rent and its escrow (an invariant
/// every write of the record keeps; `BadAccount` otherwise).
fn escrow_covered(record: &AccountInfo, rec: &WideTicket, rent_record: u64) -> R<()> {
    let need = rent_record.checked_add(rec.escrow).ok_or(OVERFLOW)?;
    if record.lamports() < need {
        return Err(BAD_ACCOUNT);
    }
    Ok(())
}

/// The deployed lazy provisional → final condition (`prologue::finality_due`:
/// state 1, `now ≥ final_ts`, the ticket's cohort closed on the holding's
/// own province) read over a **wide** holding: `(state as stored, due)`.
/// Nothing is written.
fn wide_finality_due(
    holding: &AccountInfo,
    province: &AccountInfo,
    now: i64,
    now_bell: u32,
) -> R<(u8, bool)> {
    let hh = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        ap::HoldingHdr {
            p: 0,
            q: 0,
            site: r.u8(H::SITE)?,
            gen: r.u8(H::GEN)?,
            state: r.u8(H::STATE)?,
            ticket_bell: r.u32(H::TICKET_BELL)?,
            final_ts: r.i64(H::FINAL_TS)?,
        }
    };
    let pd = province.try_borrow_data()?;
    Ok((hh.state, ap::finality_due(&hh, &pd, now, now_bell)))
}

/// The flip itself: an outpost's, so the Holding's state alone changes and
/// the Citizen's first-home flags are untouched (as
/// `proc::holding::finality` does for `order > 1`). No `HOLDING_FINAL`
/// record: the wide holding carries no event chain. The caller checked
/// [`wide_finality_due`].
fn apply_wide_finality(holding: &AccountInfo) -> R<()> {
    let mut hd = holding.try_borrow_mut_data()?;
    Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL)
}

/// The slot-2 holding of a slot-3 claim is final (the deployed
/// FileOutpost's `slot2_final`): a legacy holding at the slot's ref
/// (canonical, the citizen's, at the ref's generation, order 2, its
/// canonical province unlocked; its state as stored, as FileOutpost reads
/// it), or a wide holding record naming slot 2 and the citizen (at its
/// own canonical address, its wide province present and unlocked), final
/// as stored or **due** to flip ([`wide_finality_due`]). Returns `(final,
/// flip)`: `flip` asks the caller to apply the due flip among its effects
/// (nothing is written here). An empty slot 2 is never final.
#[allow(clippy::too_many_arguments)]
fn previous_final(
    p: &Pubkey,
    ctx: &AddrCtx,
    season_id: u64,
    world: WorldId,
    citizen: &AccountInfo,
    binding: SlotBinding,
    prev: &AccountInfo,
    prev_province: &AccountInfo,
    now: i64,
    now_bell: u32,
) -> R<(bool, bool)> {
    match binding {
        SlotBinding::Legacy(r) => {
            expect_key(prev, &ctx.holding(r.p as i32, r.q as i32, r.site))?;
            let (ph, order) = {
                let hd = prev.try_borrow_data()?;
                (
                    ap::check_holding(&view(prev, &hd), ctx, season_id, &key(citizen))?,
                    Ro(&hd).u8(H::ORDER)?,
                )
            };
            if ph.gen != r.gen || order != 2 {
                return Err(FrontierError::NotOwner.into());
            }
            check_source_province(p, ctx, season_id, prev, prev_province)?;
            Ok((ph.state == H::STATE_FINAL, false))
        }
        SlotBinding::Wide => {
            let rec = holding_at(prev, p, season_id)?.ok_or(BAD_ACCOUNT)?;
            if rec.world != world || rec.slot != 2 || rec.owner_citizen != key(citizen) {
                return Err(FrontierError::NotOwner.into());
            }
            expect_key(prev, &wh::holding_address(ctx, rec.coord, rec.site))?;
            expect_key(prev_province, &wl::province_address(ctx, rec.coord))?;
            let prov = province_at(prev_province, p, season_id)?.ok_or(BAD_ACCOUNT)?;
            if prov.world != world || prov.coord != rec.coord {
                return Err(BAD_ACCOUNT);
            }
            {
                let hd = prev.try_borrow_data()?;
                let pd = prev_province.try_borrow_data()?;
                capture_lock_of(&pd, &hd)?;
            }
            let (state, due) = wide_finality_due(prev, prev_province, now, now_bell)?;
            Ok((
                state == H::STATE_FINAL || due,
                due && state != H::STATE_FINAL,
            ))
        }
        SlotBinding::Empty => Ok((false, false)),
    }
}

// ------------------------------------------------------------ 0xD9

/// 0xD9 WideClaimSite(P, Q, site, slot): the deployed player prologue +
/// `[frontier r] [province w] [wide_ticket w] [anchor_holding w]
/// [anchor_province r] [previous_holding w] [previous_province r]
/// [system]` (`wide_ix::CLAIM_SITE`, the deployed FileOutpost's shape).
/// **Files the wide outpost ticket**: the deployed FileOutpost's checks
/// over wide land, then FileOutpost's writes with the ticket's identity in
/// a record instead of the Citizen's `i16` sites.
///
/// Checks, in FileOutpost's order:
///
/// 1. the player prologue steps 1–2 (`Auth`, `BadAddress`, …), this
///    build's Season (`RulesetMismatch`), the end bell (`WrongStatus`);
/// 2. the coordinate wide (`BadData`); the wide province present at its
///    canonical address, of this world (`BadAccount`); `site < 12`
///    (`BadData`); the record at the Citizen's canonical ticket address
///    **absent** (a first filing) or **Settled** and this Citizen's, its
///    lamports covering its escrow (a refile; `BadAccount` otherwise); an
///    Open record is a pending ticket (`TicketState`), and a marker that
///    disagrees with the record's status is `BadAccount`;
/// 3. no ticket open, deployed or wide (`TicketState`); the slot empty,
///    unreserved, 2 or 3 (`ticket::mark` on a scratch copy: `BadData`,
///    `TicketState`); `slot` the deployed **lowest free slot**
///    (`TicketState` otherwise);
/// 4. the anchor: the Citizen's slot-1 legacy ref (none: `OutpostRule`),
///    the Holding there canonical and the citizen's (`NotOwner`), at the
///    ref's generation (`BadData`), final (`NotFinal`), order 1
///    (`OutpostRule`), its canonical province present and not
///    capture-locked (`CapturePending`); the slot-2 holding for a slot-3
///    claim ([`previous_final`]), the anchor pair again otherwise
///    (`BadAddress`);
/// 5. the Frontier canonical; `holding::may_found_outpost` with the
///    deployed inputs (count and prerequisite `HoldingsFull`/`OutpostRule`;
///    the heartland, the **range from the anchor** in provinces, the share
///    of the province's strength weight, the close: `OutpostRule`; the
///    folded land gate: `Capacity`);
/// 6. the site below the province's `site_count` (`BadData`), its conquest
///    record zero (`SiegeBusy`), its terrain readable; the settler cost
///    (`settler_cost(holdings_n)`) in the anchor's touched stores
///    (`Insufficient`); the payer covering its top-up (`Insufficient`):
///    the record's rent plus the wide Holding's rent for a first filing,
///    `rent(wide Holding) − escrow` for a refile (FileOutpost's
///    `need − escrow`, 0 when the retained rent covers it).
///
/// Effects, FileOutpost's: the bucket debit (step 3 of the prologue); the
/// anchor pays the settler cost and is written back (`HARVEST` of the
/// anchor, Citizen and Holding chained: the deployed record of that
/// debit; the cost is **not refunded**, as deployed); the province's
/// cohort of `now_bell` takes the ticket (`cohort_file`); the record:
/// created from the payer holding `rent(record) + rent(wide Holding)`
/// with the payer as funder and as immutable rent payer (a first filing), or topped up by the payer
/// and rewritten Open with the payer as funder **only when it topped up**
/// (`WideTicket::refile`: FileOutpost's funder rule; the retained rent
/// keeps its funder); the **isolated escrow** (the Citizen's shared
/// `TICKET_ESCROW` and funder are untouched); the Citizen's marker
/// (`ticket::mark`: `TICKET_BELL = now_bell`, zero sites, the ticket
/// bits). No record of the wide ticket itself (module doc).
pub fn claim_site(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    claim_site_as(p, a, d, &Auth::Wallet)
}

/// [`claim_site`] for the Citizen's wallet or an NFT resident's Citizen
/// ([`Auth`]; [`resident_act`]).
pub(crate) fn claim_site_as(p: &Pubkey, a: &[AccountInfo], d: &[u8], auth: &Auth) -> R<()> {
    check_accounts(WideIx::ClaimSite, a, None)?;
    let x = wix::ClaimSite::decode(d)?;
    let [_actor, payer, season_ai, citizen, frontier, province, record, anchor_ai, anchor_province, prev_ai, prev_province, _system] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    // 2. the land
    let coord = WideCoord::checked(x.p, x.q).map_err(|_| FrontierError::BadData)?;
    if coord.ring() < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(province, &wl::province_address(&ctx, coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    if x.site as usize >= SITES_PER_PROVINCE {
        return Err(FrontierError::BadData.into());
    }
    expect_key(record, &wt::ticket_address(&ctx, &key(citizen)))?;
    let rent_record = init::rent(wt::wide_ticket::SIZE)?;
    let rent_w = init::rent(wh::wide_holding::SIZE)?;
    // The record: absent (a first filing) or Settled (a refile over the
    // retained escrow); Open is a pending ticket. The marker must agree
    // with the record's status (they are written together).
    let retained = match ticket_at(record, p, hdr.id, world)? {
        None => None,
        Some(rec) if rec.status == TicketStatus::Open => {
            return Err(FrontierError::TicketState.into());
        }
        Some(rec) => {
            if rec.citizen != key(citizen) {
                return Err(BAD_ACCOUNT);
            }
            escrow_covered(record, &rec, rent_record)?;
            Some(rec)
        }
    };
    // 3. the Citizen and its one ticket and inventory
    let (faction, holdings_n, slots, flags, bindings, gen2, gen3) = {
        let cd = citizen.try_borrow_data()?;
        refuse_wide_capture(&cd)?;
        let r = Ro(&cd);
        if matches!(
            wt::pending(&cd).map_err(|_| BAD_ACCOUNT)?,
            CitizenTicket::Wide { .. }
        ) {
            // a wide marker over an absent or Settled record
            return Err(BAD_ACCOUNT);
        }
        (
            r.u8(C::FACTION)?,
            r.u8(C::HOLDINGS_N)?,
            r.u8(C2::SLOTS)?,
            r.u8(C::FLAGS)?,
            wh::bindings_of(&cd).map_err(holding_err)?,
            cz::slot_gen(&cd, 2)?,
            cz::slot_gen(&cd, 3)?,
        )
    };
    {
        // Every refusal of the real marker (a ticket open, the slot taken
        // or reserved), on a scratch copy.
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        wt::mark(&mut scratch, now_bell, x.slot).map_err(ticket_err)?;
    }
    let lowest = C2::lowest_free_slot(slots, gen2, gen3);
    if lowest != Some(x.slot) {
        return Err(FrontierError::TicketState.into());
    }
    // 4. the anchor: the final first home, which pays and bounds the range
    let SlotBinding::Legacy(home) = bindings[0] else {
        return Err(crate::CqError::OutpostRule.into());
    };
    expect_key(
        anchor_ai,
        &ctx.holding(home.p as i32, home.q as i32, home.site),
    )?;
    let (ah, anchor_order) = {
        let hd = anchor_ai.try_borrow_data()?;
        (
            ap::check_holding(&view(anchor_ai, &hd), &ctx, hdr.id, &key(citizen))?,
            Ro(&hd).u8(H::ORDER)?,
        )
    };
    if ah.gen != home.gen {
        return Err(FrontierError::BadData.into());
    }
    if ah.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if anchor_order != 1 {
        return Err(crate::CqError::OutpostRule.into());
    }
    check_source_province(p, &ctx, hdr.id, anchor_ai, anchor_province)?;
    let mut h = hold::load_touched(anchor_ai, now.ts)?;
    let cq = {
        let sd = season_ai.try_borrow_data()?;
        season_cq(&sd)?
    };
    let tier_min = cz::holding_tier(cq.outpost_tier_min)?;
    let (slot2_final, flip_prev) = if x.slot == 3 {
        previous_final(
            p,
            &ctx,
            hdr.id,
            world,
            citizen,
            bindings[1],
            prev_ai,
            prev_province,
            now.ts,
            now_bell,
        )?
    } else {
        expect_key(prev_ai, anchor_ai.key.as_array())?;
        expect_key(prev_province, anchor_province.key.as_array())?;
        (false, false)
    };
    // 5. the deployed outpost entitlement
    present_at(frontier, &ctx.frontier(), p, AccountKind::Frontier, hdr.id)?;
    let (open_sites, occupied) = {
        let fd = frontier.try_borrow_data()?;
        let r = Ro(&fd);
        (
            r.u32(FR::OPEN_SITES)? as u64,
            r.u32(FR::OCCUPIED_SITES)? as u64,
        )
    };
    let anchor_coord =
        WideCoord::checked(home.p as i64, home.q as i64).map_err(|_| FrontierError::BadData)?;
    // A wide ring and a wide distance are compared against `u8` bounds;
    // saturating the narrowing can only turn a pass into a refusal.
    let target_ring = u32::try_from(coord.ring()).unwrap_or(u32::MAX);
    let range = u32::try_from(anchor_coord.distance(coord)).unwrap_or(u32::MAX);
    let (mine, total) = {
        let pd = province.try_borrow_data()?;
        cz::province_weights(&pd, faction, now_bell)?
    };
    may_found_outpost(&OutpostCheck {
        slot: Some(x.slot),
        first_final: flags & C::FLAG_FIRST_HOLDING_FINAL != 0,
        first_tier: h.tier,
        tier_min,
        slot2_final,
        target_ring,
        heartland_max_ring: cq.heartland_max_ring,
        range,
        outpost_range: cq.outpost_range,
        faction_weight: mine,
        province_weight: total,
        outpost_share_bps: cq.outpost_share_bps,
        free_sites: open_sites.saturating_sub(occupied),
        open_sites,
        now_bell,
        end_bell: hdr.end_bell,
        outpost_close_bells: cq.outpost_close_bells,
    })
    .map_err(cz::outpost_err)?;
    // 6. the site (below the count, a zero conquest record, a readable
    // tile: FileOutpost's; whether it is free is the settle's question),
    // the settler cost, the payer's rents
    {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        if x.site >= r.u8(PV::SITE_COUNT)? {
            return Err(FrontierError::BadData.into());
        }
        cz::record_is_zero(&pd, x.site)?;
        let tile = r.u8(PV::SITES + x.site as usize)?;
        hold::site_terrain_ore(&pd, tile)?;
    }
    let cost = cz::settler_cost(holdings_n)?;
    h.pay(now.ts, &cost).map_err(hold::holding_err)?;
    // The escrow (FileOutpost's K-25 rule over the record): one wide rent;
    // the payer covers the shortfall and becomes the funder only then.
    let total = rent_record.checked_add(rent_w).ok_or(OVERFLOW)?;
    let (rec, top) = match retained {
        None => (
            WideTicket::file(
                world,
                hdr.id,
                key(citizen),
                coord,
                x.site,
                x.slot,
                now_bell,
                key(payer),
                rent_w,
            )
            .map_err(ticket_err)?,
            total.saturating_sub(record.lamports()),
        ),
        Some(kept) => kept
            .refile(coord, x.site, x.slot, now_bell, key(payer), rent_w)
            .map_err(ticket_err)?,
    };
    if payer.lamports() < top {
        return Err(FrontierError::Insufficient.into());
    }
    // Preflight of every remaining deterministic transition on scratch
    // copies: the bucket (`Bucket`), the marker, the cohort (`CohortFull`).
    // After this point only the one CPI can refuse, and it runs first.
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        start.finish(&mut scratch, now.ts)?;
        wt::mark(&mut scratch, now_bell, x.slot).map_err(ticket_err)?;
    }
    {
        let pd = province.try_borrow_data()?;
        let mut scratch = pd.to_vec();
        cz::cohort_file(&mut scratch, now_bell)?;
    }
    // ---- effects: FileOutpost's; the CPI first, then byte writes ----
    if retained.is_none() {
        init::init_with_seed(
            payer,
            record,
            season_ai,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &wt::ticket_seed(&key(citizen)),
            wt::wide_ticket::SIZE,
            total,
            p,
        )?;
    } else {
        // FileOutpost's `transfer(payer, citizen, top)` over the record.
        init::transfer(payer, record, top)?;
    }
    {
        let mut td = record.try_borrow_mut_data()?;
        rec.write(&mut td).map_err(|_| BAD_ACCOUNT)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
        wt::mark(&mut cd, now_bell, x.slot).map_err(ticket_err)?;
    }
    let digest = {
        let mut hd = anchor_ai.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now.ts)?;
        hold::stores_digest(&hd)?
    };
    {
        let mut pd = province.try_borrow_mut_data()?;
        cz::cohort_file(&mut pd, now_bell)?;
    }
    if flip_prev {
        apply_wide_finality(prev_ai)?;
    }
    let hkey = hold::pqs_key(ah.p, ah.q, ah.site)?;
    hold::emit3(
        Kind::HARVEST,
        now_bell,
        &hkey,
        &digest,
        citizen,
        anchor_ai,
        None,
    )
}

// ------------------------------------------------------------ 0xDC

/// 0xDC WideSettleTicket(k): `[payer s,w] [season r] [citizen w]
/// [wide_ticket w] [holding w] [province w] [joinshard w] [seedcache|archive
/// r] [anchor|archive r] [displaced_rent_payer w, displaced_citizen w,
/// displaced_joinshard w]? [system]`. Class D. The deployed SettleTicket
/// over the wide ticket:
///
/// Running and this build's Season; the Citizen present at its record
/// address (wallet or NFT resident); the pending wide ticket
/// ([`pending_ticket`]: `NoTicket`, `TicketState`, `BadAccount`), its
/// lamports covering its escrow (`BadAccount`); `k` (`AlreadyDone` below
/// the cursor, `TicketState` otherwise: one site); the holding and
/// province at the ticket's canonical wide addresses, the province
/// present; the JoinShard canonical. **Expired** (`now_bell ≥ bell + 24`)
/// ends the ticket.
/// Otherwise the seed `S(bell, region)` of the wide province's region
/// (`seed_of_bell`: THE anchor's SeedCache or the archive entry;
/// `SeedNotReady`, `NoAnchor`), the full-width score
/// (`ticket::wide_ticket_score`); the site free or released-free →
/// **fresh** unless an earlier cohort of the province is open
/// (`TicketState`, K9); a provisional wide holding of the same bell with a
/// lower score (tie: lower tag) → **displace**; else **taken**, which
/// exhausts the one-site ticket. A win needs the site's conquest record
/// zero (`SiegeBusy`) and the record's escrow to hold the wide Holding's
/// rent (`Insufficient`).
///
/// Effects: fresh: the holding is created **from the record's escrow**
/// (`init_funded`, exactly the wide rent), header and identity by the
/// wide record model, `founded_outpost` (Hamlet, the site's ore, no
/// starter kit), `order = slot`, the season's **outpost shield**,
/// **provisional** with the ticket's bell, score and `final_ts =
/// round_time(S) + 600`, `rent_payer = funder`; displace: the record's
/// escrow pays the wide rent to the displaced holding's rent payer
/// (`pay_or_divert`, sink `pool_owed`), the displaced Citizen's slot is
/// unbound and its JoinShard's outposts decremented, the holding is
/// rewritten in place at `gen + 1`; either win: the mirror (holding, the
/// faction, `order = slot`, Hamlet, the generation, the shield bell,
/// `held_since_hour`), `n_sites_used` when the site was free,
/// `roster_epoch + 1`, the JoinShard's outposts, the Citizen's ticket bits
/// cleared **then** the slot bound to the marker (one inventory). Whenever
/// the ticket ends (it always does: one site): the Citizen's marker
/// cleared, the province's cohort `settled + 1`, and the record rewritten
/// **Settled** (`WideTicket::settle`): its escrow less the one wide rent a
/// win moved, unchanged when expired or taken (the deployed
/// `TICKET_ESCROW` retention; nothing goes back to the funder before the
/// season-end close, as deployed). No `SETTLE` record (no kind is
/// allocated for the wide site key; a displacement's `pay_or_divert` may
/// log the deployed `DIVERT`).
pub fn settle_ticket(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = wix::SettleTicket::decode(d)?;
    let n_disp = match a.len() {
        10 => 0u8,
        13 => 1,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    check_accounts(WideIx::SettleTicket, a, Some(&[1, n_disp, 1]))?;
    let [_payer, season_ai, citizen, record, holding, province, shard, seed_ai, anchor_ai, rest @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let disp = match rest {
        [dp, dc, ds, _system] => Some((dp, dc, ds)),
        [_system] => None,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING],
        now.ts,
    )?;
    require_wide_season(season_ai)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // The citizen and its wide ticket.
    prologue::present(citizen, p, AccountKind::Citizen, hdr.id)?;
    {
        let cd = citizen.try_borrow_data()?;
        super::resident::expect_citizen_address(&ctx, citizen, &cd)?;
    }
    let rec = pending_ticket(p, &ctx, hdr.id, world, citizen, record)?;
    let (faction, shard_i, my_tag) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (
            r.u8(C::FACTION)?,
            r.u8(C::JOIN_SHARD)?,
            r.u64(C::CITIZEN_TAG)?,
        )
    };
    if x.k < rec.next {
        return Err(FrontierError::AlreadyDone.into());
    }
    if x.k != rec.next || x.k != 0 {
        return Err(FrontierError::TicketState.into());
    }
    let rent_w = init::rent(wh::wide_holding::SIZE)?;
    let rent_record = init::rent(wt::wide_ticket::SIZE)?;
    escrow_covered(record, &rec, rent_record)?;
    let (coord, site, slot, ticket_bell) = (rec.coord, rec.site, rec.slot, rec.bell);
    expect_key(province, &wl::province_address(&ctx, coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, coord, site))?;
    present_at(
        shard,
        &ctx.join_shard(faction, shard_i),
        p,
        AccountKind::JoinShard,
        hdr.id,
    )?;
    let cq = {
        let sd = season_ai.try_borrow_data()?;
        season_cq(&sd)?
    };
    let expired = now_bell >= ticket_bell.saturating_add(PV::COHORT_BELLS);
    let (outcome, score, final_ts) = if expired {
        (settle_outcome::EXPIRED, 0u64, 0i64)
    } else {
        let c = {
            let sd = season_ai.try_borrow_data()?;
            SeasonClock::read(&sd)?
        };
        let (seed, s_round) = cz::seed_of_bell(
            p,
            &ctx,
            hdr.id,
            &c,
            hdr.genesis_ts,
            seed_ai,
            anchor_ai,
            ticket_bell,
            prov.region,
        )?;
        let score = wt::wide_ticket_score(&seed, coord, site, my_tag);
        let final_ts = c.round_time(s_round).checked_add(600).ok_or(OVERFLOW)?;
        let state = {
            let pd = province.try_borrow_data()?;
            let r = Ro(&pd);
            if site >= r.u8(PV::SITE_COUNT)? {
                return Err(BAD_ACCOUNT);
            }
            let state = r.u8(PV::site(site as usize) + SM::STATE)?;
            if matches!(state, SM::STATE_FREE | SM::STATE_RELEASED_FREE)
                && cz::earlier_cohort_open(&pd, ticket_bell, now_bell)?
            {
                return Err(FrontierError::TicketState.into());
            }
            state
        };
        let outcome = match state {
            SM::STATE_FREE | SM::STATE_RELEASED_FREE => {
                if !init::is_absent(holding) {
                    return Err(BAD_ACCOUNT);
                }
                settle_outcome::FRESH
            }
            SM::STATE_HOLDING => {
                let held = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
                if held.world != world || held.coord != coord || held.site != site {
                    return Err(BAD_ACCOUNT);
                }
                let hd = holding.try_borrow_data()?;
                let r = Ro(&hd);
                if r.u8(H::STATE)? == H::STATE_PROVISIONAL
                    && r.u32(H::TICKET_BELL)? == ticket_bell
                    && cz::displaces(
                        score,
                        my_tag,
                        r.u64(H::TICKET_SCORE)?,
                        addr::citizen_tag(&held.owner_citizen),
                    )
                {
                    settle_outcome::DISPLACE
                } else {
                    settle_outcome::TAKEN
                }
            }
            _ => settle_outcome::TAKEN,
        };
        (outcome, score, final_ts)
    };
    if (outcome == settle_outcome::DISPLACE) != disp.is_some() {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let won = matches!(outcome, settle_outcome::FRESH | settle_outcome::DISPLACE);
    let bell_log = now_bell;
    // ---- preflight: every deterministic transition on scratch copies ----
    // The record: the ticket ends; a win consumes exactly one wide rent of
    // the escrow (`Insufficient` when the escrow does not hold it), expired
    // or taken consumes nothing (the deployed retention).
    if won && rec.escrow < rent_w {
        return Err(FrontierError::Insufficient.into());
    }
    let settled = rec
        .settle(if won { rent_w } else { 0 })
        .map_err(ticket_err)?;
    // The Citizen: the ticket bits cleared, then (on a win) the slot bound,
    // with no reservation on it (the deployed settle founds into the slot
    // its ticket named; a reservation there is a state no program writes).
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        wt::clear(&mut scratch).map_err(ticket_err)?;
        if won {
            if Ro(&scratch).u8(C2::SLOTS)? & C2::reserved_bit(slot) != 0 {
                return Err(BAD_ACCOUNT);
            }
            wh::bind(&mut scratch, slot).map_err(holding_err)?;
        }
    }
    // The win: the site, the rents, the counters, the displaced accounts.
    let win = if won {
        let (tile, old_gen, ore, was_free) = {
            let pd = province.try_borrow_data()?;
            let r = Ro(&pd);
            cz::record_is_zero(&pd, site)?;
            let o = PV::site(site as usize);
            let tile = r.u8(PV::SITES + site as usize)?;
            let was_free = r.u8(o + SM::STATE)? != SM::STATE_HOLDING;
            if was_free {
                r.u8(PV::N_SITES_USED)?.checked_add(1).ok_or(OVERFLOW)?;
            }
            (
                tile,
                r.u8(o + SM::GEN)?,
                hold::site_terrain_ore(&pd, tile)?,
                was_free,
            )
        };
        let gen = old_gen.checked_add(1).ok_or(OVERFLOW)?;
        {
            let jd = shard.try_borrow_data()?;
            let r = Ro(&jd);
            // Same-shard displacement decrements before incrementing:
            // its net change is zero, including at the maximum count.
            if disp
                .map(|(_, _, old_shard)| old_shard.key != shard.key)
                .unwrap_or(true)
            {
                for off in [JS2::EXTRA_HOLDINGS, JS2::OUTPOSTS] {
                    r.u32(off)?.checked_add(1).ok_or(OVERFLOW)?;
                }
            }
        }
        let displaced = if let Some((d_payer, d_citizen, d_shard)) = disp {
            let old = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
            let old_payer: [u8; 32] = {
                let hd = holding.try_borrow_data()?;
                Ro(&hd).arr(H::RENT_PAYER)?
            };
            expect_key(d_payer, &old_payer)?;
            expect_key(d_citizen, &old.owner_citizen)?;
            prologue::present(d_citizen, p, AccountKind::Citizen, hdr.id)?;
            let (d_faction, d_shard_i) = {
                let dd = d_citizen.try_borrow_data()?;
                let r = Ro(&dd);
                (r.u8(C::FACTION)?, r.u8(C::JOIN_SHARD)?)
            };
            present_at(
                d_shard,
                &ctx.join_shard(d_faction, d_shard_i),
                p,
                AccountKind::JoinShard,
                hdr.id,
            )?;
            {
                let dd = d_citizen.try_borrow_data()?;
                let mut scratch = dd.to_vec();
                wh::unbind(&mut scratch, old.slot).map_err(holding_err)?;
            }
            d_payer.lamports().checked_add(rent_w).ok_or(OVERFLOW)?;
            Some((d_payer, d_citizen, d_shard, old.slot))
        } else {
            None
        };
        let day = addr::day_of(now_bell);
        let kh = cz::founded_outpost(now.ts, day, slot, ore)?;
        let shield_until = now
            .ts
            .checked_add(lifecycle(&cq).shield_secs_for(slot, now.ts, hdr.genesis_ts))
            .ok_or(OVERFLOW)?;
        let founded = WideHolding::found(
            world,
            hdr.id,
            coord,
            site,
            gen,
            slot,
            key(citizen),
            // The claim rule is the deployed outpost lottery, settled here.
            &Decision::Decided(()),
        )
        .map_err(holding_err)?;
        Some((
            tile,
            gen,
            ore,
            was_free,
            displaced,
            kh,
            shield_until,
            founded,
        ))
    } else {
        None
    };
    // ---- effects: the lamport move first (the one CPI on a fresh win),
    // then byte writes that cannot fail ----
    if let Some((tile, gen, ore, was_free, displaced, kh, shield_until, founded)) = win {
        let mut pool_owed = 0u64;
        match displaced {
            None => {
                let moved = init::init_funded(
                    record,
                    holding,
                    season_ai,
                    &SeasonSigner::new(hdr.id, hdr.bump),
                    &wh::holding_seed(coord, site),
                    wh::wide_holding::SIZE,
                    p,
                    rent_w,
                )?;
                if moved != rent_w {
                    return Err(FrontierError::Insufficient.into());
                }
            }
            Some((d_payer, d_citizen, d_shard, old_slot)) => {
                // The record's wide rent pays the displaced holding's funder.
                init::pay_or_divert(
                    p,
                    record,
                    d_payer,
                    rent_w,
                    &Sink::PoolOwed(holding),
                    divert_reason::ESCROW_REFUND,
                    bell_log,
                )?;
                pool_owed = {
                    let hd = holding.try_borrow_data()?;
                    Ro(&hd).u64(H::POOL_OWED)?
                };
                {
                    let mut dd = d_citizen.try_borrow_mut_data()?;
                    wh::unbind(&mut dd, old_slot).map_err(holding_err)?;
                }
                if d_shard.key == shard.key {
                    let mut jd = shard.try_borrow_mut_data()?;
                    cz::shard_outposts(&mut jd, -1)?;
                } else {
                    let mut jd = d_shard.try_borrow_mut_data()?;
                    cz::shard_outposts(&mut jd, -1)?;
                }
            }
        }
        let f = Founding {
            p: 0,
            q: 0,
            site,
            gen,
            tile,
            owner: key(citizen),
            score,
            faction,
            ticket_bell,
            rent_payer: rec.funder,
            final_ts,
            pool_owed,
            shield_until,
            terrain_ore: ore,
        };
        {
            let mut hd = holding.try_borrow_mut_data()?;
            write_founding(&mut hd, &f, &kh)?;
            // S1 1e: an expelled village's holdings carry the flag.
            super::nation::mark_holding(&mut hd, &citizen.try_borrow_data()?)?;
            founded.write_identity(&mut hd).map_err(|_| BAD_ACCOUNT)?;
        }
        let shield_bell = cz::bell_from(hdr.genesis_ts, shield_until);
        {
            let mut pd = province.try_borrow_mut_data()?;
            let mut w = Rw(&mut pd);
            let o = PV::site(site as usize);
            w.set_arr(o, &[0u8; SM::SIZE])?;
            w.set_u8(o + SM::STATE, SM::STATE_HOLDING)?;
            w.set_u8(o + SM::FACTION, faction)?;
            w.set_u8(o + SM::ORDER, slot)?;
            w.set_u8(o + SM::TIER, Tier::Hamlet as u8)?;
            w.set_u8(o + SM::GEN, gen)?;
            w.set_u32(o + SM::PEND0_BELL, SM::NO_BELL)?;
            w.set_u32(o + SM::PEND1_BELL, SM::NO_BELL)?;
            w.set_u32(o + SM::SHIELD_UNTIL_BELL, shield_bell)?;
            w.set_u16(
                o + SM2::HELD_SINCE_HOUR,
                siege::held_since_hour_from(now_bell),
            )?;
            if was_free {
                let u = w.u8(PV::N_SITES_USED)?.checked_add(1).ok_or(OVERFLOW)?;
                w.set_u8(PV::N_SITES_USED, u)?;
            }
            let e = w.u32(PV::ROSTER_EPOCH)?;
            w.set_u32(PV::ROSTER_EPOCH, e.wrapping_add(1))?;
        }
        {
            let mut jd = shard.try_borrow_mut_data()?;
            cz::shard_outposts(&mut jd, 1)?;
        }
    }
    // The citizen's side: the ticket ends (one site), the slot is bound on
    // a win (the preflight above proved both).
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        wt::clear(&mut cd).map_err(ticket_err)?;
        if won {
            wh::bind(&mut cd, slot).map_err(holding_err)?;
        }
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        cz::cohort_settle(&mut pd, ticket_bell)?;
    }
    // The record stays, Settled, with the escrow it retained (the deployed
    // `TICKET_ESCROW` after a settle): nothing is returned to the funder
    // before the season-end close.
    {
        let mut td = record.try_borrow_mut_data()?;
        settled.write(&mut td).map_err(|_| BAD_ACCOUNT)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xDE

/// A fixed account list that is not an instruction's own (WideClose has
/// two shapes).
#[derive(Clone, Copy)]
struct Shape(&'static [ap::Group]);

impl IxTable for Shape {
    fn groups(self) -> &'static [ap::Group] {
        self.0
    }
    fn top_level_only(self) -> bool {
        false
    }
}

/// The Season of a season-end close, as CloseHolding and CloseCitizen take
/// it: `(season id, bell for logs, the tombstone's authority)`: the Closed
/// tombstone, or Ended with `now ≥ end + 72 h` (`TooEarly` before) or
/// Aborted, this build's.
fn season_end(season_ai: &AccountInfo, p: &Pubkey, now: i64) -> R<(u64, u32, Option<[u8; 32]>)> {
    match cz::end_or_tombstone(season_ai, p)? {
        Some((id, authority)) => Ok((id, frontier_abi::log::NO_BELL, Some(authority))),
        None => {
            let hdr = super::map::season_end_close(season_ai, p, now)?;
            require_wide_season(season_ai)?;
            Ok((
                hdr.id,
                hdr.bell(now).unwrap_or(frontier_abi::log::NO_BELL),
                None,
            ))
        }
    }
}

/// 0xDE WideClose(what). Class N. The season-end closes of the wide
/// records, in the states CloseHolding and CloseCitizen close in: Ended
/// with `now ≥ end + 72 h` (`TooEarly` before), Aborted, or the Closed
/// tombstone.
///
/// `what = 0`, `[any s] [season r] [citizen w] [wide_ticket w]
/// [rent_payer w] [funder w]?`: a wide ticket record, the deployed
/// CloseCitizen over it ([`close_ticket`]). The record at the canonical
/// ticket address of the Citizen position's key, of this season and world
/// (`NoTicket` when absent); the rent payer the record's immutable one
/// (`BadAddress`); the funder listed **exactly when the escrow is
/// non-zero** (`TooManyAccounts` otherwise) and the record's
/// (`BadAddress`). **Pending** (the
/// record Open): the Citizen present at its record address, its marker
/// agreeing ([`pending_ticket`]); the marker is cleared. It must run
/// before CloseCitizen, which refuses a pending wide ticket
/// (`TicketState`) so an Open record is never orphaned. **Settled** (the
/// ticket ended, the escrow retained): the Citizen position is either the
/// Citizen present at its record address with no wide marker, or the
/// **absent** account at the Citizen's address once CloseCitizen has
/// closed it; nothing on the Citizen changes. Any other pairing of marker
/// and status is `BadAccount`. Effects, CloseCitizen's: the **escrow to
/// the funder** (a direct program-owned move, as the deployed escrow
/// refund), then the record closes **whole to the rent payer** (its rent
/// and any excess lamports it was given; a whole-account refund never
/// diverts, §4.2). A later funder never receives the creator's rent, and
/// the creator never receives another payer's escrow. The province may be
/// gone, so no cohort is settled.
///
/// `what = 1`, `[any s] [season r] [holding w] [rent_payer w] [dpool w]`:
/// a wide holding (the deployed CloseHolding cannot close a 1,344-byte
/// record). The holding at its canonical wide address, of this world; the
/// rent payer the holding's; `pool_owed` to the DefencePool (on the
/// tombstone position 4 is the Season's authority, which received the
/// pool, as deployed); the holding closes whole to its rent payer. No
/// `POOL_SWEEP` or `CLOSE` record (no event chain). The owner Citizen's
/// slot marker is left as CloseHolding leaves a Holding's ref: the
/// Citizen closes separately.
///
/// `what = 2..=5`: the march records ([`close_slot`], [`close_day`],
/// [`close_inputs`], [`close_transit`]); `what = 6`: the province
/// ([`close_province`], the deployed CloseProvince).
///
/// **The deadline rule, as deployed.** After the deadline (Ended + 72 h,
/// Aborted, the tombstone) the deployed closes run in **any order** and
/// none reads another's account: CloseProvince closes the entry table
/// whatever its hosts' states, CloseHolding takes the escrow of unsettled
/// transits with the account. A settle that still finds its accounts may
/// still run (the deployed settles accept Ended with no deadline of their
/// own); one that finds them gone cannot. The rights of the season's
/// marches expire at the deadline. The wide closes reproduce that:
/// WideCloseRoster closes the side table as CloseProvince closes the
/// entries, WideClose 1 the holding, WideClose 5 the transit record,
/// WideClose 6 the province, each whole to its own immutable recipient,
/// each without reading the others' accounts beyond their canonical
/// address.
pub fn close(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = wix::Close::decode(d)?;
    match x.what {
        wix::CLOSE_WHAT_TICKET => {
            check_accounts(Shape(wix::CLOSE_TICKET), a, None)?;
            close_ticket(p, a)
        }
        wix::CLOSE_WHAT_HOLDING => {
            check_accounts(Shape(wix::CLOSE_HOLDING), a, None)?;
            close_holding(p, a)
        }
        wix::CLOSE_WHAT_SLOT => {
            check_accounts(Shape(wix::CLOSE_SLOT), a, None)?;
            close_slot(p, a)
        }
        wix::CLOSE_WHAT_DAY => {
            check_accounts(Shape(wix::CLOSE_DAY), a, None)?;
            close_day(p, a)
        }
        wix::CLOSE_WHAT_INPUTS => {
            check_accounts(Shape(wix::CLOSE_INPUTS), a, None)?;
            close_inputs(p, a)
        }
        wix::CLOSE_WHAT_TRANSIT => {
            check_accounts(Shape(wix::CLOSE_TRANSIT), a, None)?;
            close_transit(p, a)
        }
        wix::CLOSE_WHAT_PROVINCE => {
            check_accounts(Shape(wix::CLOSE_PROVINCE), a, None)?;
            close_province(p, a)
        }
        _ => Err(FrontierError::BadData.into()),
    }
}

// ------------------------------------------------------------ the march record closes

/// The Season of a march-record close, as the deployed CloseArrivalSlot /
/// CloseArrivalDay / CloseClashInputs take it (`clash::float_season`):
/// the Closed tombstone (`rules_apply` false), or live — Running, Ended or
/// Aborted — this build's, with `rules_apply` false once Ended for 72 h
/// (the season-end fallback) and true otherwise (the close's own case
/// rules apply). Returns `(season id, rules_apply, the record bell)`.
fn close_season(season_ai: &AccountInfo, p: &Pubkey, now: i64) -> R<(u64, bool, u32)> {
    use super::clash::FloatSeason;
    let statuses = [S::STATUS_RUNNING, S::STATUS_ENDED, S::STATUS_ABORTED];
    match super::clash::float_season_with(season_ai, p, &statuses, now)? {
        FloatSeason::Tomb(id) => Ok((id, false, frontier_abi::log::NO_BELL)),
        FloatSeason::Live(h) => {
            require_wide_season(season_ai)?;
            let ended_long_ago = h.status == S::STATUS_ENDED && {
                let end = super::map::season_end_ts(&h);
                now >= end.saturating_add(super::map::END_GRACE_SECS)
            };
            Ok((
                h.id,
                !ended_long_ago,
                h.bell(now).unwrap_or(frontier_abi::log::NO_BELL),
            ))
        }
    }
}

/// THE anchor of a slot's bell at a slot close, as listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AnchorClose {
    /// No anchor listed: the grace is not known to have passed.
    NotListed,
    /// Listed and absent: the bell is archived, the grace long passed.
    Archived,
    /// Listed and present: its reveal close (`A + W(b)`).
    At(i64),
}

/// The deployed CloseArrivalSlot's case rule (pure): the slot closes when
/// the close's rules no longer apply (the season-end fallback), or when it
/// is settled and claimed, or settled and its claim grace
/// (`CLAIM_GRACE_BELLS` bells after the reveal close) passed against THE
/// anchor — an archived anchor means passed, no anchor means not yet. An
/// unsettled slot never closes while the rules apply (the settle needs it).
pub(crate) fn slot_close_due(
    rules_apply: bool,
    settled: bool,
    claimed: bool,
    anchor: AnchorClose,
    now: i64,
) -> bool {
    if !rules_apply {
        return true;
    }
    if !settled {
        return false;
    }
    claimed
        || match anchor {
            AnchorClose::NotListed => false,
            AnchorClose::Archived => true,
            AnchorClose::At(close) => {
                let grace = super::transit::CLAIM_GRACE_BELLS as i64 * 600;
                now >= close.saturating_add(grace)
            }
        }
}

/// The deployed CloseArrivalDay's case rule (pure): the province resolved
/// every bell of the day (`resolved_next ≥ (day + 1) × 144`).
pub(crate) fn day_close_due(day: u32, resolved_next: u32) -> bool {
    let need = (day as u64 + 1) * wa::wide_arrival_day::BELLS as u64;
    resolved_next as u64 >= need
}

/// The deployed CloseClashInputs' case rule (pure) over a wide header:
/// (a) resolved, every present position (`present_mask`) settled and
/// `resolved_ts + grace` passed since genesis; or (b) a no-arrival record
/// whose bell the province passed (`resolved_next > bell`), the grace
/// counted from the bell's end. `Ok(false)` is `InputsOpen`; an
/// arithmetic overflow is the error it is everywhere.
pub(crate) fn inputs_close_due(
    ih: &WideClashInputsHdr,
    present_mask: u32,
    resolved_next: u32,
    grace_secs: i64,
    since_genesis: i64,
) -> R<bool> {
    if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
        if present_mask & !ih.settled_mask != 0 {
            return Ok(false);
        }
        let open_until = (ih.resolved_ts as i64)
            .checked_add(grace_secs)
            .ok_or(OVERFLOW)?;
        Ok(open_until <= since_genesis)
    } else if ih.flags & wa::wide_clash_inputs::FLAG_NO_ARRIVALS != 0 && resolved_next > ih.bell {
        let bell_end = (ih.bell as i64)
            .checked_add(1)
            .and_then(|b| b.checked_mul(600))
            .ok_or(OVERFLOW)?;
        Ok(bell_end.checked_add(grace_secs).ok_or(OVERFLOW)? <= since_genesis)
    } else {
        Ok(false)
    }
}

/// Closes an authenticated arrival record whole to its immutable rent
/// recipient. The caller has already checked identity and eligibility;
/// `identity` is `(what, record bell, faction, index)` for the receipt.
/// Stage the zero-link receipt and Sink::Never payment, then probe every
/// eventual mutable borrow before close_to can resize or assign anything.
/// This guards predictable direct-host failures, not runtime rollback.
fn close_record_to_rent<'a>(
    p: &Pubkey,
    target: &AccountInfo<'a>,
    rent_to: &AccountInfo<'a>,
    bell_log: u32,
    dest: ProvinceKey,
    identity: (u8, u32, u8, u8),
) -> R<()> {
    let lamports = target.try_lamports()?;
    if target.key == rent_to.key {
        return Err(BAD_ACCOUNT);
    }
    if lamports != 0 {
        let after = rent_to
            .try_lamports()?
            .checked_add(lamports)
            .ok_or(OVERFLOW)?;
        if rent_to.owner != p && after < init::rent(rent_to.try_borrow_data()?.len())? {
            return Err(BAD_ACCOUNT);
        }
    }
    let (what, record_bell, faction, i) = identity;
    let (record, record_len) = prepare_wide(
        WideKind::RecordClosed,
        bell_log,
        &dest.to_bytes(),
        &wev::record_closed_payload(what, record_bell, faction, i, &key(rent_to), lamports),
        &mut [],
    )?;
    {
        let _data = target.try_borrow_mut_data()?;
        let _source_lamports = target.try_borrow_mut_lamports()?;
        let _recipient_lamports = rent_to.try_borrow_mut_lamports()?;
    }
    init::close_to(p, target, rent_to, &Sink::Never, bell_log)?;
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &record[..record_len]]);
    Ok(())
}

/// WideClose(2): the deployed CloseArrivalSlot over a wide ArrivalSlot
/// (`[any s] [season r] [slot w] [rent_to w] ([anchor r])`). The slot
/// program-owned, this season's and world's, at the canonical address of
/// the destination, bell, faction and index it names (`BadAddress`);
/// `rent_to` its immutable one (`BadAccount`). Closes when (a) its
/// `settled` flag is set and it is claimed or its claim grace passed
/// (`close + 6 bells` from THE anchor of `(bell, region)` at its canonical
/// address, the region the wide rule's [`absent_destination_region`]; an
/// absent anchor means the bell is archived and the grace long passed; no
/// anchor listed means not yet), or (b) the Season Ended at least 72 h
/// ago, or the tombstone (`TooEarly` otherwise). Whole to `rent_to`; the
/// `WIDE_RECORD_CLOSED` record.
fn close_slot(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let (season_ai, slot, rent_to, anchor) = match a {
        [_any, s, sl, r] => (s, sl, r, None),
        [_any, s, sl, r, an] => (s, sl, r, Some(an)),
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let now = prologue::now()?;
    let (sid, rules_apply, bell_log) = close_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    if slot.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let s = {
        let sd = slot.try_borrow_data()?;
        WideArrivalSlot::read(&sd).map_err(|_| BAD_ACCOUNT)?
    };
    if s.season_id != sid || s.dest.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        slot,
        &wa::arrival_slot_address(&ctx, s.dest, s.bell, s.faction, s.i),
    )?;
    expect_key(rent_to, &s.rent_to)?;
    let settled = s.flags & wa::wide_arrival_slot::FLAG_SETTLED != 0;
    // THE anchor is read **only when the case needs it** — the rules
    // apply, the slot is settled and unclaimed — as the deployed close's
    // short-circuit evaluates it: under the season-end fallback or on a
    // claimed slot a listed anchor is not read (the tombstone has no
    // Season clock to read it against). When needed: its reveal close when
    // present, archived when absent, not yet when not listed.
    let anchor_close = match anchor {
        Some(an) if rules_apply && settled && !s.claimed => {
            let region = absent_destination_region(s.dest.coord());
            expect_key(an, &ctx.bell_anchor(s.bell, region))?;
            if prologue::presence(an, p, AccountKind::BellAnchor, sid)? {
                let a_ts = {
                    let ad = an.try_borrow_data()?;
                    crate::layout::beacon::Anchor::read(&ad)?.a
                };
                let clock = {
                    let sd = season_ai.try_borrow_data()?;
                    SeasonClock::read(&sd)?
                };
                AnchorClose::At(clock.reveal_close(s.bell, a_ts))
            } else {
                AnchorClose::Archived
            }
        }
        _ => AnchorClose::NotListed,
    };
    if !slot_close_due(rules_apply, settled, s.claimed, anchor_close, now.ts) {
        return Err(FrontierError::TooEarly.into());
    }
    close_record_to_rent(
        p,
        slot,
        rent_to,
        bell_log,
        s.dest,
        (wix::CLOSE_WHAT_SLOT, s.bell, s.faction, s.i),
    )
}

/// WideClose(3): the deployed CloseArrivalDay over a wide ArrivalDay
/// (`[any s] [season r] [province r] [day w] [rent_to w]`). The day record
/// program-owned, this season's and world's, at its canonical address;
/// `rent_to` its own. While the close's rules apply, the province at its
/// canonical address, present, resolved through every bell of the day
/// (`resolved_next ≥ (day + 1) × 144`, `TooEarly`); once Ended for 72 h
/// or on the tombstone only the province's address is checked (it may be
/// absent). Whole to `rent_to`; the `WIDE_RECORD_CLOSED` record (its bell
/// the day's first).
fn close_day(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [_any, season_ai, province, day_ai, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, rules_apply, bell_log) = close_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    if day_ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = {
        let dd = day_ai.try_borrow_data()?;
        wa::WideArrivalDay::read(&dd).map_err(|_| BAD_ACCOUNT)?
    };
    if d.season_id != sid || d.dest.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(day_ai, &wa::arrival_day_address(&ctx, d.dest, d.day))?;
    expect_key(rent_to, &d.rent_to)?;
    expect_key(province, &wl::province_address(&ctx, d.dest.coord()))?;
    if rules_apply {
        let prov = province_at(province, p, sid)?.ok_or(BAD_ACCOUNT)?;
        if prov.world != world || prov.coord != d.dest.coord() {
            return Err(BAD_ACCOUNT);
        }
        let rn = {
            let pd = province.try_borrow_data()?;
            Ro(&pd).u32(PV::RESOLVED_NEXT)?
        };
        if !day_close_due(d.day, rn) {
            return Err(FrontierError::TooEarly.into());
        }
    }
    close_record_to_rent(
        p,
        day_ai,
        rent_to,
        bell_log,
        d.dest,
        (
            wix::CLOSE_WHAT_DAY,
            d.day.saturating_mul(wa::wide_arrival_day::BELLS),
            0,
            0,
        ),
    )
}

/// WideClose(4): the deployed CloseClashInputs over a wide ClashInputs
/// (`[any s] [season r] [province r] [inputs w] [rent_to w]`). The record
/// program-owned, this season's and world's, at its canonical address;
/// `rent_to` its own. While the close's rules apply, the province present
/// at its canonical address and: (a) the record resolved, every present
/// position settled (`settled_mask`), and `resolved_ts + clash_close_grace`
/// passed; or (b) a no-arrival record whose bell the province passed
/// (`resolved_next > bell`), the grace counted from the bell's end;
/// `InputsOpen` otherwise. Once Ended for 72 h or on the tombstone only
/// the province's address is checked. Whole to `rent_to`; the
/// `WIDE_RECORD_CLOSED` record.
fn close_inputs(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [_any, season_ai, province, inputs, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, rules_apply, bell_log) = close_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    if inputs.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let cd = inputs.try_borrow_data()?.to_vec();
    let ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
    if ih.season_id != sid || ih.dest.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(inputs, &wa::clash_inputs_address(&ctx, ih.dest, ih.bell))?;
    expect_key(rent_to, &ih.rent_to)?;
    expect_key(province, &wl::province_address(&ctx, ih.dest.coord()))?;
    if rules_apply {
        let prov = province_at(province, p, sid)?.ok_or(BAD_ACCOUNT)?;
        if prov.world != world || prov.coord != ih.dest.coord() {
            return Err(BAD_ACCOUNT);
        }
        let (grace, genesis_ts) = {
            let sd = season_ai.try_borrow_data()?;
            let r = Ro(&sd);
            (r.u32(S::CLASH_CLOSE_GRACE)?, r.i64(S::GENESIS_TS)?)
        };
        let rn = {
            let pd = province.try_borrow_data()?;
            Ro(&pd).u32(PV::RESOLVED_NEXT)?
        };
        let grace_secs = (grace as i64).checked_mul(600).ok_or(OVERFLOW)?;
        let since_genesis = now.ts.saturating_sub(genesis_ts);
        let mut present_mask = 0u32;
        for k in 0..wa::wide_clash_inputs::POSITIONS {
            if WideArrival::read_at(&cd, k)
                .map_err(|_| BAD_ACCOUNT)?
                .is_some_and(|arr| arr.present)
            {
                present_mask |= 1 << k;
            }
        }
        if !inputs_close_due(&ih, present_mask, rn, grace_secs, since_genesis)? {
            return Err(FrontierError::InputsOpen.into());
        }
    }
    close_record_to_rent(
        p,
        inputs,
        rent_to,
        bell_log,
        ih.dest,
        (wix::CLOSE_WHAT_INPUTS, ih.bell, 0, 0),
    )
}

/// WideClose(5): a wide transit record left open at season end (`[any s]
/// [season r] [transit w] [rent_to w] [holding w]`): Ended + 72 h,
/// Aborted or the tombstone (`season_end`: the states in which the
/// deployed Holding, whose transit slots die with it, closes). The record
/// program-owned, this season's world's, at one of the four canonical
/// transit addresses of its host's holding (`BadAddress`); `rent_to` its
/// immutable one. The holding position is **always** the canonical
/// address of the host's holding (`BadAddress` for any other account):
/// present there, it is the holding and counts one open march fewer
/// (`open_transits`, the live count of a standing holding's open wide
/// transit records); absent there, the holding closed first (the deployed
/// order allows it) and there is no count to keep. Nothing else proves or
/// assumes the holding's existence. Whole to `rent_to`; the
/// `WIDE_TRANSIT_CLOSED` record keyed by the host and its home. The
/// march's escrow is not here: it closed with the holding to the holding's
/// rent payer, as deployed.
fn close_transit(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [_any, season_ai, transit_ai, rent_to, holding] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, bell_log, _tomb) = season_end(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    if transit_ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let t = {
        let td = transit_ai.try_borrow_data()?;
        WideTransit::from_bytes(&td).map_err(|_| BAD_ACCOUNT)?
    };
    if t.host.key().world() != world {
        return Err(BAD_ACCOUNT);
    }
    let hkey = wh::holding_address(&ctx, t.host.key().coord(), t.host.site());
    let slot = (0..H::TRANSIT_N as u8)
        .find(|&s| transit_ai.key.as_array() == &wm::transit_address(&ctx, &hkey, s))
        .ok_or(FrontierError::BadAddress)?;
    expect_key(rent_to, &t.rent_to)?;
    expect_key(holding, &hkey)?;
    let standing = match holding_at(holding, p, sid)? {
        Some(rec) if rec.world == world => true,
        Some(_) => return Err(BAD_ACCOUNT),
        None => false,
    };
    let lamports = transit_ai.lamports();
    init::close_to(p, transit_ai, rent_to, &Sink::Never, bell_log)?;
    if standing {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        let open = w.u8(wh::wide_holding::OPEN_TRANSITS)?.saturating_sub(1);
        w.set_u8(wh::wide_holding::OPEN_TRANSITS, open)?;
    }
    emit_wide(
        WideKind::TransitClosed,
        bell_log,
        &wev::host_key(&t.host, t.host.key()),
        &wev::transit_closed_payload(slot, &t.rent_to, lamports),
        &mut [],
    )
}

/// WideClose(6): the deployed CloseProvince over a wide province (`[any s]
/// [season r] [province w] [pfund w]`). Ended with `now ≥ end + 72 h`
/// (`TooEarly` before) or Aborted, this build's Season — never the
/// tombstone: CloseSeason's final part closed the funds, so a province
/// left open then keeps its rent, as deployed. The province program-owned,
/// this season's and world's, at its canonical address; the fund the one
/// of the wedge that opened it (`WideProvince::wedge`), present at its
/// canonical address. The province closes whole into the fund and the
/// fund's `provinces_opened` counts one fewer, as deployed (`open_sites`,
/// `provinces_funded`, `spent_total` are the opening's lifetime counters
/// and stay). Nothing of the province's entry table, camp, keep or
/// holdings is read: the deployed CloseProvince closes the entry table
/// whatever its hosts' states at the deadline, and the wide roster side
/// table closes the same way (WideCloseRoster).
///
/// **The terminal record.** The province has an event chain (every
/// muster, dissolve, resolve, return, settle of it advanced the header),
/// and the deployed CloseProvince logs `CLOSE` with the final chain before
/// it erases the account. So here: every refusal first (the Season, the
/// province, the fund's address and kind, the fund's lamports after the
/// refund, the counter read), then the `WIDE_PROVINCE_CLOSED` record is
/// **chained on the province's own header** (its link is the chain's
/// final `(seq, head)`; `emit_wide` computes the link before it writes
/// anything, so an unchainable record refuses with nothing written), and
/// only then the account closes into the fund and the counter steps. The
/// steps after the record have no refusal of their own on the chain (the
/// account was verified program-owned, the fund's room and offset were
/// read).
fn close_province(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [_any, season_ai, province, fund] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = super::map::season_end_close(season_ai, p, now.ts)?;
    require_wide_season(season_ai)?;
    let sid = hdr.id;
    let bell = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = province_at(province, p, sid)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(province, &wl::province_address(&ctx, prov.coord))?;
    present_at(
        fund,
        &ctx.province_fund(prov.wedge),
        p,
        AccountKind::ProvinceFund,
        sid,
    )?;
    let lamports = province.lamports();
    fund.lamports().checked_add(lamports).ok_or(OVERFLOW)?;
    let opened = {
        let fd = fund.try_borrow_data()?;
        Ro(&fd).u32(PF::PROVINCES_OPENED)?
    };
    // The terminal record on the province's chain, before the erase.
    {
        let mut pd = province.try_borrow_mut_data()?;
        emit_wide(
            WideKind::ProvinceClosed,
            bell,
            &ProvinceKey::new(world, prov.coord).to_bytes(),
            &wev::province_closed_payload(&key(fund), lamports),
            &mut [(WideEntity::Province, &mut pd[..])],
        )?;
    }
    init::close_to(p, province, fund, &Sink::Never, bell)?;
    let mut fdat = fund.try_borrow_mut_data()?;
    Rw(&mut fdat).set_u32(PF::PROVINCES_OPENED, opened.saturating_sub(1))
}

fn close_ticket(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let (season_ai, citizen, record, rent_payer, funder) = match a {
        [_any, s, c, r, rp] => (s, c, r, rp, None),
        [_any, s, c, r, rp, f] => (s, c, r, rp, Some(f)),
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let now = prologue::now()?;
    let (sid, bell, _) = season_end(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // The record is the one of the Citizen position's key, whether that
    // Citizen is still present or already closed.
    expect_key(record, &wt::ticket_address(&ctx, &key(citizen)))?;
    let rec = ticket_at(record, p, sid, world)?.ok_or(FrontierError::NoTicket)?;
    if rec.citizen != key(citizen) {
        return Err(BAD_ACCOUNT);
    }
    escrow_covered(record, &rec, init::rent(wt::wide_ticket::SIZE)?)?;
    // CloseCitizen's two recipients: the immutable rent payer, and the
    // funder exactly when there is an escrow to return.
    expect_key(rent_payer, &rec.rent_payer)?;
    let funder = match (rec.escrow > 0, funder) {
        (true, Some(f)) => {
            expect_key(f, &rec.funder)?;
            f.lamports().checked_add(rec.escrow).ok_or(OVERFLOW)?;
            Some(f)
        }
        (false, None) => None,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let pending = if init::is_absent(citizen) {
        // CloseCitizen closed it: it refused a pending wide ticket, so only
        // a Settled record can remain here.
        if rec.status != TicketStatus::Settled {
            return Err(BAD_ACCOUNT);
        }
        false
    } else {
        prologue::present(citizen, p, AccountKind::Citizen, sid)?;
        let cd = citizen.try_borrow_data()?;
        super::resident::expect_citizen_address(&ctx, citizen, &cd)?;
        match (wt::pending(&cd).map_err(|_| BAD_ACCOUNT)?, rec.status) {
            (CitizenTicket::Wide { bell: b, slot }, TicketStatus::Open) => {
                if rec.bell != b || rec.slot != slot {
                    return Err(BAD_ACCOUNT);
                }
                let mut scratch = cd.to_vec();
                wt::clear(&mut scratch).map_err(ticket_err)?;
                true
            }
            // A Settled record beside no wide marker: a deployed ticket may
            // be open on the Citizen (its escrow is CloseCitizen's).
            (CitizenTicket::None | CitizenTicket::Legacy, TicketStatus::Settled) => false,
            _ => return Err(BAD_ACCOUNT),
        }
    };
    if pending {
        let mut cd = citizen.try_borrow_mut_data()?;
        wt::clear(&mut cd).map_err(ticket_err)?;
    }
    // CloseCitizen's order: the escrow to the funder, then the rest whole
    // to the rent payer (a whole-account refund never diverts, §4.2).
    if let Some(f) = funder {
        init::move_lamports(record, f, rec.escrow)?;
    }
    init::close_to(p, record, rent_payer, &Sink::Never, bell)?;
    Ok(())
}

fn close_holding(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [_any, season_ai, holding, rent_payer, dpool] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, bell, tomb) = season_end(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let h = holding_at(holding, p, sid)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    let (h_payer, owed) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.arr::<32>(H::RENT_PAYER)?, r.u64(H::POOL_OWED)?)
    };
    // The deployed CloseHolding's expiry rule, verbatim: at Ended + 72 h,
    // Aborted or the tombstone the Holding closes to its rent payer, "the
    // escrow of unsettled transits included"; a transit that was not
    // settled by then is not settled afterwards (its settlement needs this
    // account). The wide transit records outlive the holding as their own
    // accounts and close to their own rent recipients (WideClose 5). No
    // guard over `open_transits` here: the deployed rule has none, and a
    // guard would hold the rent payer's whole account behind a march that
    // may never be able to settle.
    expect_key(rent_payer, &h_payer)?;
    match tomb {
        None => present_at(dpool, &ctx.defence_pool(), p, AccountKind::DefencePool, sid)?,
        Some(authority) => expect_key(dpool, &authority)?,
    }
    dpool.lamports().checked_add(owed).ok_or(OVERFLOW)?;
    if owed > 0 {
        init::move_lamports(holding, dpool, owed)?;
        let mut hd = holding.try_borrow_mut_data()?;
        Rw(&mut hd).set_u64(H::POOL_OWED, 0)?;
    }
    let sink = match tomb {
        None => Sink::DefencePool(dpool),
        Some(_) => Sink::Never,
    };
    init::close_to(p, holding, rent_payer, &sink, bell)?;
    Ok(())
}

// ------------------------------------------------------------ 0xDF

/// 0xDF WideFinalize: `[any s] [season r] [holding w] [province r]`. Class
/// N. The deployed lazy provisional → final flip of a wide holding,
/// callable by anyone (no wide resident action exists to carry it): the
/// Season Running and this build's; the holding at its canonical wide
/// address, of this world, its province present; the holding provisional
/// (`AlreadyDone` once final); `now ≥ final_ts` **and** the ticket's
/// cohort closed on the province (`prologue::finality_due`), else
/// `TooEarly`. Effects: the Holding's state alone ([`apply_wide_finality`]).
pub fn finalize(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::Finalize, a, None)?;
    wix::Finalize::decode(d)?;
    let [_any, season_ai, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING],
        now.ts,
    )?;
    require_wide_season(season_ai)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    expect_key(province, &wl::province_address(&ctx, h.coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != h.coord {
        return Err(BAD_ACCOUNT);
    }
    let (state, due) = wide_finality_due(holding, province, now.ts, now_bell)?;
    if state != H::STATE_PROVISIONAL {
        return Err(FrontierError::AlreadyDone.into());
    }
    if !due {
        return Err(FrontierError::TooEarly.into());
    }
    apply_wide_finality(holding)
}

// ------------------------------------------------------------ 0xDD

/// 0xDD WideResidentAct(generation, inner): the band's own `ResidentAct`
/// for an NFT resident's Citizen. `accounts` is the inner instruction's
/// list followed by the four read-only proof accounts `[policy, link,
/// asset, resident]`; `inner` is a whole draft instruction whose decoded
/// `WideCommand::is_player` is true (ClaimSite, Depart, Muster, Dissolve,
/// Economy or Garrison; `BadData` otherwise:
/// never a v2 tag, never a non-player draft tag, never itself). The inner
/// handler runs under [`Auth::Resident`]: the deployed `resident::start`
/// checks the policy, the link, the asset's current Core owner (or its
/// session) and the **signed holder generation** against the resident
/// record, so a previous holder, its session and anything signed before a
/// transfer are refused. The deployed `ResidentAct` (0xE2) routes only
/// ABI v2 tags and never reaches this band; this act routes only this
/// band and never a v2 tag.
pub fn resident_act(p: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = wix::ResidentAct::decode(d)?;
    let n = accounts.len();
    if n < 4 + 4 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let (a, proof) = accounts.split_at(n - 4);
    let auth = Auth::Resident {
        proof,
        generation: x.generation,
    };
    // The whitelist is the decoded command's class (`is_player`), never
    // the inner tag alone: 0xDA also carries Muster, Dissolve, Economy and
    // Garrison. Nothing of class D or N is accepted.
    use wix::WideCommand as C;
    match x.command()? {
        C::ClaimSite(_) => claim_site_as(p, a, x.inner, &auth),
        C::Depart(_) => depart_as(p, a, x.inner, &auth),
        C::Muster(m) => muster_as(p, a, &m, &auth),
        C::Dissolve(d) => dissolve_as(p, a, &d, &auth),
        C::Economy(e) => economy_exec::economy_as(p, a, &e, &auth),
        C::Garrison(x) => garrison_exec::garrison_as(p, a, &x, &auth),
        C::DeclareSiege(_) => conquest_exec::declare_siege_resident(p, accounts, d),
        _ => Err(FrontierError::BadData.into()),
    }
}

/// Phase B of the host-only wide economy (0xDA op 3, `wide_ix::Economy`):
/// the authenticated Harvest, Build and Train over a wide holding, a
/// private child so it reuses this module's prologue, loaders and shapes
/// without publishing them (its own module doc lists its order and its
/// atomicity rule). Routed from [`dispatch`] under the wallet and from
/// [`resident_act`] under the NFT resident proof.
#[path = "wide_economy_exec.rs"]
mod economy_exec;

/// Host-only WideGarrison (0xDA op 4): the deployed positive unit-0
/// reserve reinforcement under wallet/session or resident authorization.
/// Citizen, holding, province and both receipt chains commit atomically.
#[path = "wide_garrison_exec.rs"]
mod garrison_exec;

/// Original legacy departure/Spend and paired origin settlement candidates.
/// The public gate is unconditionally false; ResidentAct does not admit them.
#[path = "wide_expedition_exec.rs"]
mod expedition_exec;

/// Closed mixed resident dissolve/return candidate. No public dispatcher.
#[allow(dead_code)]
#[path = "wide_expedition_resident.rs"]
mod expedition_resident;

/// Read-only mixed route stage; no dispatch or admission is enabled.
#[path = "wide_expedition_route.rs"]
mod expedition_route;

/// Private boundary arrival producer; public dispatch remains closed.
#[path = "wide_expedition_reveal.rs"]
mod expedition_reveal;

/// Proof-pending read-only return snapshots; no settlement or public dispatch.
#[path = "wide_expedition_return.rs"]
mod expedition_return;

/// Private mixed Gather staging and producer; public dispatch remains closed.
#[path = "wide_expedition_gather.rs"]
mod expedition_gather;

/// Closed until authenticated dispatch, receipts and replay are verified as
/// one lifecycle. There is deliberately no configuration or argument override.
pub const CONQUEST_LIFECYCLE_ENABLED: bool = false;

fn require_conquest_lifecycle() -> R<()> {
    if !CONQUEST_LIFECYCLE_ENABLED {
        return Err(FrontierError::NotImplemented.into());
    }
    Ok(())
}

#[path = "wide_conquest_exec.rs"]
mod conquest_exec;

#[path = "wide_conquest_settle_exec.rs"]
mod conquest_settle_exec;

/// Host-only claim over wide arrival evidence. The deployed pool and
/// keeper-day claim are shared with narrow-world claims.
#[path = "wide_defence_exec.rs"]
mod defence_exec;

// ------------------------------------------------------------ the host lifecycle

/// The one wide instruction class whose table carries a top-level rule:
/// WideResolve (the deployed resolves are top-level).
#[derive(Clone, Copy)]
struct TopLevelShape(&'static [ap::Group]);

/// Logs a **wide** record (`world_index::event`: the `PSW1` prefix, the
/// wide version byte, a full-identity key) and advances the event chains
/// of the wide accounts it names (`chained`, exactly the kind's link set
/// in ascending entity order: the province before the holding), under the
/// wide chain rule. Every link and the whole tail are computed and
/// validated **before** any header is written, so a refused record (a
/// sequence overflow, a wrong link set) changes no chain. Nothing of the
/// deployed `PS2` format is written: no deployed reader parses these, and
/// the wide accounts' chains are advanced by wide records only. One
/// transaction may log several records (a return of several hosts); a
/// refusal after one of them reverts account writes. Raw failed-transaction
/// logs can remain, so consumers must filter transaction status before
/// treating them as successful receipts (as the host collector does).
fn emit_wide(
    kind: WideKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    chained: &mut [(WideEntity, &mut [u8])],
) -> R<()> {
    let (out, len) = prepare_wide(kind, bell, key, payload, chained)?;
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &out[..len]]);
    Ok(())
}

/// Build a record and advance the supplied headers without logging it.
/// Callers staging several transitions pass scratch images and publish
/// these bytes only after every live account has been committed.
fn prepare_wide(
    kind: WideKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    chained: &mut [(WideEntity, &mut [u8])],
) -> R<([u8; wev::MAX_BODY], usize)> {
    if chained.len() > wev::MAX_LINKS || chained.len() != kind.links().len() {
        return Err(BAD_ACCOUNT);
    }
    let mut out = [0u8; wev::MAX_BODY];
    let n = wev::write_body(kind, bell, key, payload, &mut out).ok_or(BAD_ACCOUNT)?;
    // 1. every link, from the headers as they are (no write yet)
    let mut links = [WideLink {
        entity: WideEntity::Province,
        seq: 0,
        head: [0; 32],
    }; wev::MAX_LINKS];
    for (i, (entity, data)) in chained.iter().enumerate() {
        let (seq, head) = crate::layout::chain_of(data)?;
        links[i] = wev::advance(*entity, seq, &head, &out[..n]).ok_or(OVERFLOW)?;
    }
    // 2. the tail (the kind's exact link set, in order), still no write
    let m = wev::write_tail(kind, &links[..chained.len()], &mut out, n).ok_or(BAD_ACCOUNT)?;
    // 3. the headers, then the log
    for (link, (_, data)) in links[..chained.len()].iter().zip(chained.iter_mut()) {
        crate::layout::set_chain(data, link.seq, &link.head)?;
    }
    Ok((out, m))
}

impl IxTable for TopLevelShape {
    fn groups(self) -> &'static [ap::Group] {
        self.0
    }
    fn top_level_only(self) -> bool {
        true
    }
}

/// A resolve-model refusal as a program code: the deployed model's codes
/// where the refusal is the deployed model's (`From<ModelError>`), the
/// clash's `Kernel` sub-code, `OutOfOrder` for a bell that is not due,
/// `BadAccount` for an unpaired or legacy entry and for unported state.
fn resolve_err(e: ResolveError) -> crate::Error {
    match e {
        ResolveError::Model(m) => m.into(),
        ResolveError::NotDue { .. } => FrontierError::OutOfOrder.into(),
        ResolveError::Clash(_) => kernel(super::clash::sub::CLASH_INPUT),
        ResolveError::Keep(_) => kernel(frontier_abi::conquest_model::sub::KEEP),
        ResolveError::Overflow => OVERFLOW,
        _ => BAD_ACCOUNT,
    }
}

/// The roster side table of `province` at an address the caller checked:
/// `None` if absent; the record if present, program-owned, well formed,
/// of this season and of this province; `BadAccount` otherwise.
fn roster_at(
    ai: &AccountInfo,
    p: &Pubkey,
    season_id: u64,
    province: ProvinceKey,
) -> R<Option<WideRoster>> {
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = WideRoster::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id || rec.province != province {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// A wide province of this world at its canonical address, present.
fn canonical_province(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &AddrCtx,
    season_id: u64,
    world: WorldId,
) -> R<WideProvince> {
    let prov = province_at(ai, p, season_id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(ai, &wl::province_address(ctx, prov.coord))?;
    Ok(prov)
}

/// The Season of a settlement (Running or Ended, as the deployed
/// SettleDeparture and the resolves take it), this build's.
fn settle_season(season_ai: &AccountInfo, p: &Pubkey, now: i64) -> R<ap::SeasonHdr> {
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now,
    )?;
    require_wide_season(season_ai)?;
    Ok(hdr)
}

/// WideMuster (0xDA, op 1): the deployed player prologue + `[holding w]
/// [province w] [roster w] [system]` (`wide_ix::MUSTER`). The deployed
/// Muster over a wide holding, with the host named by its full reference
/// and its entry's `u64` the roster alias the authenticated side table
/// returns:
///
/// 1. the player prologue (wallet or NFT resident; `Auth`, `BadAddress`,
///    the signed holder generation), this build's Season; the holding at
///    its canonical wide address, of this world, the Citizen's
///    (`NotOwner`); its own province at its canonical address, present, not
///    capture-locking the holding (`CapturePending`);
/// 2. the deployed Muster: the holding final (`NotFinal`); the province
///    resolved through `b − 2` (`NotResident`); the unit (`BadData`); the
///    reserve (`Insufficient`); the kernel's host bounds (`Kernel`:
///    100–30,000 troops, a host unit); a passable tile (`BadData`); the caps
///    (48 over states 1–2, 8 per faction) and a free entry
///    (`ProvinceFull`);
/// 3. the roster side table at its canonical address: present and this
///    province's, or **absent** — then it is created here from the payer
///    (its rent recipient the payer, `Insufficient` when the payer cannot
///    cover it); the entry table and the table paired
///    (`validate_paired`, `BadAccount`); the alias claimed
///    (`claim_alias` over the whole table, `BadAccount` on a collision);
///    the Citizen's bucket and the end bell on a scratch copy
///    (`PlayerStart::finish`: `Bucket`, `WrongStatus`).
///
/// Effects: the roster created when absent (the one CPI, first), the
/// reference written at the entry's index; the muster-pending entry
/// (state 2, `from_bell = b + 1`, the alias as id, the doctrine's `dealt`
/// at Hold), `roster_epoch + 1`, `n_entries + 1`; the holding written back
/// touched, `reserve[unit] − troops`, `host_seq + 1`, and — at the
/// holding's first muster — the full-reference host identity allocated
/// (`WideHolding::allocate_identity`; a holding founded under the
/// unallocated identity carries it from then on); the Citizen's bucket.
/// The **wide** `WIDE_MUSTER` record (`world_index::event`, `PSW1`),
/// keyed by the full host reference, carrying the alias the entry holds,
/// chained to the wide province and the wide holding under the wide chain
/// rule; no deployed `PS2` record (the deployed kinds key a dense host id,
/// which no wide host has).
pub(crate) fn muster_as(p: &Pubkey, a: &[AccountInfo], x: &wix::Muster, auth: &Auth) -> R<()> {
    check_accounts(Shape(wix::MUSTER), a, None)?;
    let [_actor, payer, season_ai, citizen, holding, province, roster_ai, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // 1. the holding and its own province.
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    if h.owner_citizen != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    expect_key(province, &wl::province_address(&ctx, h.coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != h.coord {
        return Err(BAD_ACCOUNT);
    }
    {
        let pd = province.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    let pkey = ProvinceKey::new(world, h.coord);
    // 2. the deployed Muster's checks, in its order.
    let (state, faction, seq, have) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let unit_ok = (x.unit as usize) < H::RESERVE_N;
        (
            r.u8(H::STATE)?,
            r.u8(H::FACTION)?,
            r.u32(H::HOST_SEQ)?,
            if unit_ok {
                r.u32(H::reserve(x.unit as usize))?
            } else {
                0
            },
        )
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let (rn, passable) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        (r.u32(PV::RESOLVED_NEXT)?, r.u64(PV::PASSABLE_MASK)?)
    };
    if !ap::resident_ok(rn, now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    let unit = catalog::unit_of(x.unit).ok_or(FrontierError::BadData)?;
    if (x.unit as usize) >= H::RESERVE_N {
        return Err(FrontierError::BadData.into());
    }
    if have < x.troops {
        return Err(FrontierError::Insufficient.into());
    }
    let milli: MilliTroops = x
        .troops
        .checked_mul(MILLI as u32)
        .ok_or_else(|| kernel(hold::sub::HOST_TOO_LARGE))?;
    let host = WideHostRef::new(pkey, h.site, h.gen, seq).map_err(|_| BAD_ACCOUNT)?;
    let alias = wide_host_alias(&host);
    let kh = Host::muster(alias, alias, faction, unit, milli, now_bell)
        .map_err(|e| super::host::host_err(e, FrontierError::NotResident))?;
    if x.tile as usize >= PV::TILES || passable & (1u64 << x.tile) == 0 {
        return Err(FrontierError::BadData.into());
    }
    let dealt = hold::bps16(
        of_faction_v3(faction)
            .ok_or(BAD_ACCOUNT)?
            .dealt_bps(Posture::Stance(Stance::Hold), false),
    )?;
    let slot = {
        let pd = province.try_borrow_data()?;
        let (mut total, mut own, mut free) = (0usize, 0usize, None);
        for i in 0..PV::ENTRIES_N {
            let o = PV::entry(i);
            let st = Ro(&pd).u8(o + E::STATE)?;
            match st {
                E::STATE_FREE => {
                    if free.is_none() {
                        free = Some(i);
                    }
                }
                E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                    total += 1;
                    if Ro(&pd).u8(o + E::FACTION)? == faction {
                        own += 1;
                    }
                }
                _ => {}
            }
        }
        if total >= PV::ROSTER_CAP || own >= PV::FACTION_CAP {
            return Err(FrontierError::ProvinceFull.into());
        }
        free.ok_or(FrontierError::ProvinceFull)?
    };
    // 3. the roster side table: this province's, or created from the payer.
    expect_key(roster_ai, &wro::roster_address(&ctx, pkey))?;
    let rent_r = init::rent(wro::wide_roster::SIZE)?;
    let (roster, mut rd, create) = match roster_at(roster_ai, p, hdr.id, pkey)? {
        Some(r) => (r, roster_ai.try_borrow_data()?.to_vec(), false),
        None => {
            if payer.lamports() < rent_r {
                return Err(FrontierError::Insufficient.into());
            }
            let r = WideRoster::new(hdr.id, pkey, key(payer));
            let mut d = alloc::vec![0u8; wro::wide_roster::SIZE];
            r.write_header(&mut d).map_err(|_| BAD_ACCOUNT)?;
            (r, d, true)
        }
    };
    {
        let pd = province.try_borrow_data()?;
        roster
            .validate_paired(&rd, &wres::live_ids(&pd).map_err(resolve_err)?)
            .map_err(|_| BAD_ACCOUNT)?;
    }
    let claimed = roster
        .claim(&mut rd, slot, &host)
        .map_err(|_| BAD_ACCOUNT)?;
    if claimed != alias {
        return Err(BAD_ACCOUNT);
    }
    let e = Entry::from_host(&kh, x.tile, E::STATE_MUSTER_PENDING, dealt, now_bell + 1);
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        start.finish(&mut scratch, now.ts)?;
    }
    let touched = hold::load_touched(holding, now.ts)?;
    let seq_next = seq.checked_add(1).ok_or(OVERFLOW)?;
    {
        let pd = province.try_borrow_data()?;
        Ro(&pd).u8(PV::N_ENTRIES)?.checked_add(1).ok_or(OVERFLOW)?;
    }
    // ---- effects: the CPI first, then byte writes ----
    if create {
        init::init_with_seed(
            payer,
            roster_ai,
            season_ai,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &wro::roster_seed(pkey),
            wro::wide_roster::SIZE,
            rent_r,
            p,
        )?;
    }
    {
        let mut d = roster_ai.try_borrow_mut_data()?;
        if d.len() != rd.len() {
            return Err(BAD_ACCOUNT);
        }
        d.copy_from_slice(&rd);
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(&mut pd, slot, &e).map_err(|_| BAD_ACCOUNT)?;
        let mut w = Rw(&mut pd);
        let epoch = w.u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
        w.set_u32(PV::ROSTER_EPOCH, epoch)?;
        let n = w.u8(PV::N_ENTRIES)?.saturating_add(1);
        w.set_u8(PV::N_ENTRIES, n)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &touched, now.ts)?;
        let mut w = Rw(&mut hd);
        w.set_u32(H::reserve(x.unit as usize), have - x.troops)?;
        w.set_u32(H::HOST_SEQ, seq_next)?;
        if h.host_identity == wh::HOST_IDENTITY_UNALLOCATED {
            WideHolding::allocate_identity(&mut hd).map_err(|_| BAD_ACCOUNT)?;
        }
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    }
    let mut pd = province.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    emit_wide(
        WideKind::Muster,
        now_bell,
        &wev::host_key(&host, pkey),
        &wev::muster_payload(x.unit, x.troops, x.tile, slot as u8, alias),
        &mut [
            (WideEntity::Province, &mut pd[..]),
            (WideEntity::Holding, &mut hd[..]),
        ],
    )
}

/// WideDissolve (0xDA, op 2): the deployed player prologue + `[holding w]
/// [province w] [roster r] [holding_province r]` (`wide_ix::DISSOLVE`).
/// The deployed Dissolve over a wide host: the host reference canonical,
/// of this world, past the disk (`BadData`, `BadAddress`); the issuing
/// holding at the reference's canonical address, the Citizen's at the
/// reference's generation (`NotOwner`); its own province present and
/// canonical; the standing province a wide province of this world (a
/// deployed Province is the boundary: `NotImplemented`), the capture lock
/// when it is the holding's own; the holding final (`NotFinal`); the
/// standing province resolved through `b − 2` (`NotResident`); the
/// roster side table present and the standing province's; the entry at
/// the alias, **paired** with the reference at its index
/// (`entry_matches`; `NotResident` without one, `BadAccount` on a
/// mismatch), in state 1 (`NotResident`), no pending change (`HostBusy`);
/// the Citizen's bucket and the end bell on a scratch copy. Effects: the
/// pending `Leave` of `b` (the troops return at the return settle after
/// the bell's clash, as deployed), the holding written back touched, the
/// Citizen's bucket; the wide `WIDE_DISSOLVE` record keyed by the full
/// reference, chained to the province and the holding. The closed path is
/// **local**: a standing province other than the holding's own is refused
/// `NotImplemented` until a source-capture proof for it exists.
pub(crate) fn dissolve_as(p: &Pubkey, a: &[AccountInfo], x: &wix::Dissolve, auth: &Auth) -> R<()> {
    check_accounts(Shape(wix::DISSOLVE), a, None)?;
    let [_actor, _payer, season_ai, citizen, holding, standing, roster_ai, own_province, t0, t1, t2, t3] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let transits = [t0, t1, t2, t3];
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let host = WideHostRef::from_bytes(&x.host).map_err(|_| FrontierError::BadData)?;
    if host.key().world() != world {
        return Err(FrontierError::BadAddress.into());
    }
    let coord = host.key().coord();
    if coord.ring() < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    expect_key(holding, &wh::holding_address(&ctx, coord, host.site()))?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.owner_citizen != key(citizen) || h.gen != host.gen() {
        return Err(FrontierError::NotOwner.into());
    }
    if h.world != world || h.coord != coord || h.site != host.site() {
        return Err(BAD_ACCOUNT);
    }
    // The deployed step 6 (`host_in_transit`) over the wide records: a
    // host whose march is open (departed, settled at the origin, gathered
    // or awaiting its settlement) cannot dissolve — its entry at the
    // destination is what a bad seal's settlement forfeits.
    if host_has_open_transit(p, &ctx, &key(holding), &transits, &host)? {
        return Err(FrontierError::HostInTransit.into());
    }
    expect_key(own_province, &wl::province_address(&ctx, coord))?;
    let own = province_at(own_province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if own.world != world || own.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    let stand = match province_at(standing, p, hdr.id) {
        Ok(Some(sp)) => sp,
        Ok(None) => return Err(BAD_ACCOUNT),
        Err(e) => {
            if prologue::presence(standing, p, AccountKind::Province, hdr.id).unwrap_or(false) {
                return Err(FrontierError::NotImplemented.into());
            }
            return Err(e);
        }
    };
    if stand.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(standing, &wl::province_address(&ctx, stand.coord))?;
    // The source-capture proof (the deployed `check_source_province`): the
    // capture lock is read in the holding's **own** province, whichever
    // province the host stands in (a host that marched and stayed stands
    // in a foreign one; its dissolve must work there, else a keep donor's
    // survivors strand).
    {
        let pd = own_province.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    let state = {
        let hd = holding.try_borrow_data()?;
        Ro(&hd).u8(H::STATE)?
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let rn = {
        let pd = standing.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if !ap::resident_ok(rn, now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    let skey = ProvinceKey::new(world, stand.coord);
    expect_key(roster_ai, &wro::roster_address(&ctx, skey))?;
    let roster = roster_at(roster_ai, p, hdr.id, skey)?.ok_or(FrontierError::NotResident)?;
    let alias = wide_host_alias(&host);
    let (index, mut entry) = {
        let pd = standing.try_borrow_data()?;
        let i = find_entry(&pd, alias).ok_or(FrontierError::NotResident)?;
        let rd = roster_ai.try_borrow_data()?;
        if !roster.entry_matches(&rd, i, alias, &host) {
            return Err(BAD_ACCOUNT);
        }
        (i, read_entry(&pd, i).map_err(|_| BAD_ACCOUNT)?)
    };
    if entry.state != E::STATE_ROSTER {
        return Err(FrontierError::NotResident.into());
    }
    if entry.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        start.finish(&mut scratch, now.ts)?;
    }
    let touched = hold::load_touched(holding, now.ts)?;
    // ---- effects ----
    entry.op = EntryOp::Leave;
    entry.pend_bell = now_bell;
    {
        let mut pd = standing.try_borrow_mut_data()?;
        write_entry(&mut pd, index, &entry).map_err(|_| BAD_ACCOUNT)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &touched, now.ts)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    }
    let mut pd = standing.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    emit_wide(
        WideKind::Dissolve,
        now_bell,
        &wev::host_key(&host, skey),
        &wev::dissolve_payload(now_bell, entry.troops, index as u8),
        &mut [
            (WideEntity::Province, &mut pd[..]),
            (WideEntity::Holding, &mut hd[..]),
        ],
    )
}

/// WideResolve (0xDC, op 1): `[fee_payer s,w] [season r] [province w]
/// [roster w] [seedcache|archive r] [anchor|archive r] [clash_inputs r]`
/// (`wide_ix::RESOLVE`). Class D, **top-level**. The one-bell wide
/// resolve (`world_index::resolve::resolve_bell`) under the deployed
/// resolve's authentication, with no arrival path:
///
/// the keeper prologue (the Season Running or Ended, this build's); the
/// province at its canonical wide address, of this world; `bell =
/// resolved_next` (`OutOfOrder`), below the end bell (`WrongStatus`);
/// **the reveal window of `bell` closed** for the province's **stored
/// region** against THE anchor of `(bell, region)` or its archive entry
/// (`proc::clash::window_closed`, as the deployed ResolveClash: `NoAnchor`,
/// `BadAddress`, `TooEarly`); the bell seed `S(bell, region)` from the
/// SeedCache or the archive (`holding::bell_seed`, as the deployed
/// resolves: `SeedNotReady`); the wide ClashInputs position of this
/// province and bell **absent** (`NotImplemented` otherwise: no reveal or
/// gather exists, so a present record would be arrivals this resolve
/// cannot take); the roster at its canonical address, present and this
/// province's, or absent while the province has **no live entry** (an
/// empty province resolves before its first muster; `BadAccount` when
/// entries exist without their table). Then the model on scratch copies:
/// build (the tables paired, every identity by full reference), the
/// kernel, apply, settle, step (the keep contest with the full-identity
/// donor, the territory score, the hour snapshot), `finish_bell`; the
/// resolve summary (bell, engagements, 0 arrivals, destroyed, bounced,
/// the beneficiary's first 8 bytes). The province and the roster are
/// written only when everything succeeded; then the wide `WIDE_RESOLVE`
/// record keyed by the full province key, chained to the province: the
/// **input digest** (province key, bell, seed, the province and roster
/// bytes as read) and the **output digest** (the kernel outcome's digest,
/// the bytes the bell left), engagements, destroyed, bounced, settled. A
/// reader of the wide format replays the model over the logged inputs and
/// checks the logged outputs; a deployed reader sees an unknown version.
pub fn resolve(p: &Pubkey, a: &[AccountInfo], x: &wix::Resolve) -> R<()> {
    check_accounts(TopLevelShape(wix::RESOLVE), a, None)?;
    prologue::top_level(TopLevelShape(wix::RESOLVE))?;
    resolve_inner(p, a, x, None)
}

pub fn resolve_with_conquest(p: &Pubkey, a: &[AccountInfo], x: &wix::ResolveWithConquest) -> R<()> {
    require_conquest_lifecycle()?;
    check_accounts(TopLevelShape(wix::RESOLVE_WITH_CONQUEST), a, None)?;
    prologue::top_level(TopLevelShape(wix::RESOLVE_WITH_CONQUEST))?;
    resolve_inner(
        p,
        a,
        &wix::Resolve {
            bell: x.bell,
            beneficiary: x.beneficiary,
        },
        Some(x),
    )
}

/// One authenticated window/seed/arrival preparation and writeback path.
/// The optional typed command selects only the model/receipt/table branch;
/// it is private and never overrides the lifecycle dispatch gate.
fn resolve_inner(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::Resolve,
    conquest: Option<&wix::ResolveWithConquest>,
) -> R<()> {
    let [fee_payer, season_ai, province, roster_ai, seed_ai, anchor_ai, inputs_ai, day_ai, _system] =
        a.get(..9).ok_or(FrontierError::TooManyAccounts)?
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    require_wide_season(season_ai)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
    let conquest_ai = if conquest.is_some() {
        Some(a.get(9).ok_or(BAD_ACCOUNT)?)
    } else {
        None
    };
    let table_before = if let Some(ai) = conquest_ai {
        // Resolve never creates or reconstructs a lost table. In particular
        // an absent table cannot erase an outstanding nonzero prefix.
        let table = conquest_exec::table_at(ai, p, &ctx, hdr.id, pkey)?.ok_or(BAD_ACCOUNT)?;
        conquest_exec::paired(&table, &province.try_borrow_data()?)?;
        Some(table.to_bytes().to_vec())
    } else {
        None
    };
    let manifest_before = if conquest.is_some() {
        Some(conquest_exec::states(a, &[2])?)
    } else {
        None
    };
    let rn = {
        let pd = province.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if x.bell != rn {
        return Err(FrontierError::OutOfOrder.into());
    }
    if x.bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let clock = {
        let sd = season_ai.try_borrow_data()?;
        SeasonClock::read(&sd)?
    };
    let region = prov.region;
    super::clash::window_closed(p, &ctx, hdr.id, &clock, now.ts, x.bell, region, anchor_ai)?;
    let seed = hold::bell_seed(p, &ctx, hdr.id, &clock, x.bell, region, seed_ai, anchor_ai)?;
    // The arrival evidence: the wide ArrivalDay of the bell's day at its
    // canonical address. Absent, or present with the bell's bit clear, no
    // reveal reached this bell; the bit set, arrivals exist and the bell
    // needs its gathered record (`NotGathered` without it). The absence of
    // the ClashInputs alone proves nothing.
    let arrivals_expected = arrival_day_bit(day_ai, p, &ctx, hdr.id, pkey, x.bell)?;
    // The wide ClashInputs of this province and bell: absent (no reveal
    // reached this bell: the resolve runs over the residents alone), or
    // present, this province's and bell's, **fully gathered** (every
    // position scanned by WideGather, `NotGathered` otherwise), not yet
    // resolved.
    expect_key(inputs_ai, &wa::clash_inputs_address(&ctx, pkey, x.bell))?;
    let cd_before: Vec<u8> = if init::is_absent(inputs_ai) {
        if arrivals_expected {
            return Err(FrontierError::NotGathered.into());
        }
        Vec::new()
    } else {
        if inputs_ai.owner != p || !inputs_ai.is_writable {
            return Err(BAD_ACCOUNT);
        }
        let cd = inputs_ai.try_borrow_data()?;
        let ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
        if ih.season_id != hdr.id || ih.dest != pkey || ih.bell != x.bell {
            return Err(BAD_ACCOUNT);
        }
        if ih.arrivals_mask != wa::wide_clash_inputs::ALL_GATHERED {
            return Err(FrontierError::NotGathered.into());
        }
        if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
            return Err(FrontierError::AlreadyDone.into());
        }
        cd.to_vec()
    };
    let prm = {
        let sd = season_ai.try_borrow_data()?;
        let prm = StepParams::of_season(&sd).ok_or(BAD_ACCOUNT)?;
        if prm.cq.conquest_version != frontier_abi::v2::presets::CONQUEST_VERSION {
            return Err(BAD_ACCOUNT);
        }
        prm
    };
    expect_key(roster_ai, &wro::roster_address(&ctx, pkey))?;
    let mut pd_s = province.try_borrow_data()?.to_vec();
    // The roster: present, or absent while no entry is live (the
    // bootstrap). An absent roster is modelled as the empty table under
    // its would-be header with the fee payer as its immutable rent
    // recipient: should the bell claim an entry in it (an arrival that
    // stays), the record is **created** from the fee payer and written,
    // never left in scratch.
    let (roster, mut rd_s, present) = match roster_at(roster_ai, p, hdr.id, pkey)? {
        Some(r) => (r, roster_ai.try_borrow_data()?.to_vec(), true),
        None => {
            if wres::live_ids(&pd_s)
                .map_err(resolve_err)?
                .iter()
                .any(|e| e.is_some())
            {
                return Err(BAD_ACCOUNT);
            }
            let r = WideRoster::new(hdr.id, pkey, key(fee_payer));
            let mut d = alloc::vec![0u8; wro::wide_roster::SIZE];
            r.write_header(&mut d).map_err(|_| BAD_ACCOUNT)?;
            (r, d, false)
        }
    };
    let rd_initial = rd_s.clone();
    // The input commitment: the province and the roster as read (an absent
    // roster is the empty table under its would-be header), the seed, the
    // bell, and the **authenticated Season bytes whole** (the ruleset
    // hash, the program version with the wide bit, the clock the seed
    // round comes from, the conquest block the step parameters come from:
    // what `prologue::keeper`, `require_wide_season` and `StepParams` read).
    let input = {
        let sd = season_ai.try_borrow_data()?;
        wev::resolve_input_digest(pkey, x.bell, &seed, &sd, &pd_s, &rd_s, &cd_before)
    };
    let mut cd_s = cd_before;
    let (out, table_after) = if let Some(table) = table_before.as_ref() {
        let out = wres::resolve_bell_with_conquest(
            &mut pd_s,
            &roster,
            &mut rd_s,
            table,
            (!cd_s.is_empty()).then_some(&cd_s[..]),
            x.bell,
            &seed,
            &frontier_ruleset(),
            &prm,
        )
        .map_err(resolve_err)?;
        (out.bell, Some(out.conquest.to_bytes().to_vec()))
    } else {
        (
            wres::resolve_bell(
                &mut pd_s,
                &roster,
                &mut rd_s,
                (!cd_s.is_empty()).then_some(&cd_s[..]),
                x.bell,
                &seed,
                &frontier_ruleset(),
                &prm,
            )
            .map_err(resolve_err)?,
            None,
        )
    };
    // The gathered record takes the fates and the troops after of every
    // present arrival, the camp mask, the resolved flag, the resolver and
    // the resolve time (the deployed ResolveFromInputs' writes; no fee
    // evidence: the wide resolve lists no instructions sysvar).
    let n_arrivals = if cd_s.is_empty() {
        0
    } else {
        wres::write_resolved(&mut cd_s, &out.applied).map_err(resolve_err)?;
        let mut ih = WideClashInputsHdr::read(&cd_s).map_err(|_| BAD_ACCOUNT)?;
        ih.resolver = x.beneficiary;
        ih.resolved_ts = now
            .ts
            .saturating_sub(clock.genesis_ts)
            .clamp(0, u32::MAX as i64) as u32;
        ih.write(&mut cd_s).map_err(|_| BAD_ACCOUNT)?;
        ih.n_present
    };
    {
        let o = PV::RESOLVE_SUMMARY;
        let mut w = Rw(&mut pd_s);
        w.set_u32(o + SU::BELL, x.bell)?;
        w.set_u32(o + SU::ENGAGEMENTS, out.clash.engagements)?;
        w.set_u8(o + SU::ARRIVALS, n_arrivals)?;
        w.set_u8(o + SU::DESTROYED, out.applied.destroyed)?;
        w.set_u8(o + SU::BOUNCED, out.applied.bounced)?;
        w.set_arr(o + SU::RESOLVER, &x.beneficiary[..8])?;
    }
    // The output commitment: the kernel's outcome digest and the bytes the
    // bell left (the summary and the resolved arrivals included; the
    // header's chain fields are normalized out by the digest, so this
    // record's own link does not enter it).
    let output = wev::resolve_output_digest(&out.clash.digest(), &pd_s, &rd_s, &cd_s);
    // A roster the bell needed and the province had none of: created from
    // the fee payer (its rent recipient), before any byte write.
    let create_roster = !present && rd_s != rd_initial;
    let rent_r = init::rent(wro::wide_roster::SIZE)?;
    if create_roster {
        // As init::top_up, prefunding belongs to the target and only the
        // remaining shortfall must be covered by this payer.
        let need = rent_r.saturating_sub(roster_ai.lamports());
        if !roster_ai.is_writable || fee_payer.lamports() < need {
            return Err(FrontierError::Insufficient.into());
        }
        if wres::live_ids(&pd_s)
            .map_err(resolve_err)?
            .iter()
            .all(|e| e.is_none())
        {
            return Err(BAD_ACCOUNT);
        }
    }
    // The receipt and its chain can still refuse (notably at sequence
    // overflow). Finish them on scratch before allocation or live writes.
    let old_payload = wev::resolve_payload(
        &input,
        &output,
        out.clash.engagements,
        out.applied.destroyed,
        out.applied.bounced,
        out.settled,
    );
    let conquest_payload = if let (Some(command), Some(before), Some(table)) =
        (conquest, manifest_before.as_ref(), table_after.as_ref())
    {
        let mut after = before.clone();
        after[2].data = pd_s.clone();
        if present || create_roster {
            after[3].data = rd_s.clone();
            after[3].owner = p.to_bytes();
            after[3].present = true;
        }
        if create_roster {
            let need = rent_r.saturating_sub(before[3].lamports);
            after[0].lamports = after[0]
                .lamports
                .checked_sub(need)
                .ok_or(FrontierError::Insufficient)?;
            after[3].lamports = after[3].lamports.checked_add(need).ok_or(OVERFLOW)?;
        }
        if !cd_s.is_empty() {
            after[6].data = cd_s.clone();
        }
        after[9].data = table.clone();
        for i in [0, 2, 3, 6, 9] {
            let state = after[i].clone();
            conquest_exec::replace(&mut after, i, state);
        }
        Some(conquest_exec::receipt(
            2,
            &command.to_bytes(),
            now.ts,
            x.bell,
            &before[1].data,
            &seed,
            before,
            &after,
            &out.clash.digest(),
        )?)
    } else {
        None
    };
    let (record, record_len) = prepare_wide(
        if conquest.is_some() {
            WideKind::ConquestResolved
        } else {
            WideKind::Resolve
        },
        x.bell,
        &pkey.to_bytes(),
        conquest_payload
            .as_ref()
            .map_or(&old_payload[..], |p| &p[..]),
        &mut [(WideEntity::Province, &mut pd_s[..])],
    )?;
    // ---- effects: optional roster allocation, then one byte commit ----
    // Predictable borrow conflicts in the eventual commit or System CPIs
    // must not first surface after the payer has funded the new roster.
    // Release these probes before CPI, which needs the same accounts.
    // Allocation itself keeps its runtime transaction-rollback boundary.
    if create_roster {
        {
            let pd = province.try_borrow_mut_data()?;
            let rd = roster_ai.try_borrow_mut_data()?;
            let cd = if cd_s.is_empty() {
                None
            } else {
                Some(inputs_ai.try_borrow_mut_data()?)
            };
            let _payer_lamports = fee_payer.try_borrow_mut_lamports()?;
            let _roster_lamports = roster_ai.try_borrow_mut_lamports()?;
            let td = conquest_ai.map(|ai| ai.try_borrow_mut_data()).transpose()?;
            if pd.len() != pd_s.len()
                || !rd.is_empty()
                || cd.as_ref().is_some_and(|d| d.len() != cd_s.len())
                || td
                    .as_ref()
                    .zip(table_after.as_ref())
                    .is_some_and(|(d, s)| d.len() != s.len())
            {
                return Err(BAD_ACCOUNT);
            }
        }
        init::init_with_seed(
            fee_payer,
            roster_ai,
            season_ai,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &wro::roster_seed(pkey),
            wro::wide_roster::SIZE,
            rent_r,
            p,
        )?;
    }
    // Every live borrow and post-allocation length before the first copy;
    // no fallible operation follows that copy.
    {
        let mut pd = province.try_borrow_mut_data()?;
        let mut rd = if present || create_roster {
            Some(roster_ai.try_borrow_mut_data()?)
        } else {
            None
        };
        let mut cd = if cd_s.is_empty() {
            None
        } else {
            Some(inputs_ai.try_borrow_mut_data()?)
        };
        let mut td = conquest_ai.map(|ai| ai.try_borrow_mut_data()).transpose()?;
        if pd.len() != pd_s.len()
            || rd.as_ref().is_some_and(|d| d.len() != rd_s.len())
            || cd.as_ref().is_some_and(|d| d.len() != cd_s.len())
            || td
                .as_ref()
                .zip(table_after.as_ref())
                .is_some_and(|(d, s)| d.len() != s.len())
        {
            return Err(BAD_ACCOUNT);
        }
        pd.copy_from_slice(&pd_s);
        if let Some(rd) = rd.as_mut() {
            rd.copy_from_slice(&rd_s);
        }
        if let Some(cd) = cd.as_mut() {
            cd.copy_from_slice(&cd_s);
        }
        if let (Some(td), Some(table)) = (td.as_mut(), table_after.as_ref()) {
            td.copy_from_slice(table);
        }
    }
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &record[..record_len]]);
    Ok(())
}

/// WideReturn (0xDC, op 2): `[payer s,w] [season r] [province w] [roster
/// w] [holding w]` (`wide_ix::RETURN`). Class D, permissionless. The
/// deployed return settle (SettleDeparture's `transit_slot = 0xFF` form)
/// over a wide province: the Season Running or Ended; the province at its
/// canonical wide address, of this world; the roster present and this
/// province's, the tables paired (`BadAccount`); the holding position
/// either the wide holding at its canonical address (of this world, its
/// live generation read; the capture lock when the province is its own)
/// or **absent** (`None`: its hosts strand, as deployed). Every state-3
/// `Leave` entry whose **full reference** (through the roster, never a
/// packed id) names that holding — the same world, coordinate and site —
/// is freed, at most `clash::RETURN_MAX` per transaction in entry order:
/// whole troops (`troops / 1,000`, once) into `reserve[unit]` when the
/// holding is live at the reference's generation (the wide `WIDE_RETURN`
/// record, keyed by the full reference, chained to the province and the
/// holding), lost otherwise (`WIDE_STRANDED`, chained to the province);
/// `n_entries − 1`, the reference released. `AlreadyDone` when nothing is
/// returned. Survives a transfer of the Citizen: the credit goes to the
/// holding record, whoever holds it; the Citizen is not an input. The
/// closed path is **local**: a holding, or a departed host's reference, of
/// another province than the one the hosts stand in is refused
/// `NotImplemented` until a source-capture proof exists.
pub fn settle_return(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::RETURN), a, None)?;
    let [_payer, season_ai, province, roster_ai, holding, t0, t1, t2, t3, tail @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let transits = [t0, t1, t2, t3];
    let own_province = tail.first();
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
    expect_key(roster_ai, &wro::roster_address(&ctx, pkey))?;
    let roster = roster_at(roster_ai, p, hdr.id, pkey)?.ok_or(FrontierError::AlreadyDone)?;
    let mut pd_s = province.try_borrow_data()?.to_vec();
    let mut rd_s = roster_ai.try_borrow_data()?.to_vec();
    roster
        .validate_paired(&rd_s, &wres::live_ids(&pd_s).map_err(resolve_err)?)
        .map_err(|_| BAD_ACCOUNT)?;
    // The holding: present (its live generation) or absent. The
    // source-capture proof (the deployed `check_source_province`): the
    // capture lock is read in the holding's **own** province: the standing
    // province when the hosts return where their holding is, else the
    // optional `holding_province` at its canonical address, present
    // (`BadAccount` when a foreign return names no such account).
    let live = match holding_at(holding, p, hdr.id)? {
        Some(h) => {
            if h.world != world {
                return Err(BAD_ACCOUNT);
            }
            expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
            let hd = holding.try_borrow_data()?;
            if h.coord == prov.coord {
                capture_lock_of(&pd_s, &hd)?;
            } else {
                let own = own_province.ok_or(BAD_ACCOUNT)?;
                let op = canonical_province(own, p, &ctx, hdr.id, world)?;
                if op.coord != h.coord {
                    return Err(BAD_ACCOUNT);
                }
                let opd = own.try_borrow_data()?;
                capture_lock_of(&opd, &hd)?;
            }
            let state = Ro(&hd).u8(H::STATE)?;
            matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL).then_some(h.gen)
        }
        None => None,
    };
    let hkey = key(holding);
    let bell_log = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
    // The holding's four wide transit records: a departed host whose march
    // is still open is not returned (its Leave waits for the settlement;
    // the other hosts of the holding are not held back by it).
    let open = open_transits_of(p, &ctx, &hkey, &transits)?;
    let mut skipped_in_transit = 0usize;
    // Selection: the departed Leave entries whose reference names this
    // holding, by full identity (world, coordinate, site).
    let mut picked: [(usize, bool, Entry, Option<WideHostRef>); super::clash::RETURN_MAX] =
        [(0, false, Entry::FREE, None); super::clash::RETURN_MAX];
    let mut n_picked = 0usize;
    for i in 0..PV::ENTRIES_N {
        let e = read_entry(&pd_s, i).map_err(|_| BAD_ACCOUNT)?;
        if e.state != E::STATE_DEPARTED || !matches!(e.op, EntryOp::Leave) {
            continue;
        }
        let r = roster
            .ref_at(&rd_s, i)
            .map_err(|_| BAD_ACCOUNT)?
            .ok_or(BAD_ACCOUNT)?;
        if wide_host_alias(&r) != e.id {
            return Err(BAD_ACCOUNT);
        }
        let mine = r.key().world() == world
            && wh::holding_address(&ctx, r.key().coord(), r.site()) == hkey;
        if !mine {
            continue;
        }
        if open.iter().flatten().any(|t| t.host == r) {
            skipped_in_transit += 1;
            continue;
        }
        let credit = live == Some(r.gen());
        picked[n_picked] = (i, credit, e, Some(r));
        n_picked += 1;
        if n_picked == super::clash::RETURN_MAX {
            break;
        }
    }
    if n_picked == 0 {
        return Err(if skipped_in_transit > 0 {
            FrontierError::HostInTransit.into()
        } else {
            FrontierError::AlreadyDone.into()
        });
    }
    // Staged: the entries freed, the references released, the reserve.
    let mut reserve = [0u32; H::RESERVE_N];
    if live.is_some() {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        for (u, v) in reserve.iter_mut().enumerate() {
            *v = r.u32(H::reserve(u))?;
        }
    }
    let mut credited = [0u32; super::clash::RETURN_MAX];
    for (k, &(i, credit, e, _)) in picked[..n_picked].iter().enumerate() {
        write_entry(&mut pd_s, i, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
        let mut w = Rw(&mut pd_s);
        let n = w.u8(PV::N_ENTRIES)?.saturating_sub(1);
        w.set_u8(PV::N_ENTRIES, n)?;
        roster.release(&mut rd_s, i).map_err(|_| BAD_ACCOUNT)?;
        if credit {
            let whole = e.troops / MILLI as u32;
            let slot = reserve.get_mut(e.unit as usize).ok_or(BAD_ACCOUNT)?;
            *slot = slot.checked_add(whole).ok_or(OVERFLOW)?;
            credited[k] = whole;
        }
    }
    let mut hd_s = if live.is_some() {
        Some(holding.try_borrow_data()?.to_vec())
    } else {
        None
    };
    if let Some(hd) = hd_s.as_mut() {
        let mut w = Rw(hd);
        for (u, v) in reserve.iter().enumerate() {
            w.set_u32(H::reserve(u), *v)?;
        }
    }
    // Stage every record and chain advance before any live write. Even
    // an overflow on the last entry must leave no partial return or log.
    let mut logs = Vec::with_capacity(n_picked);
    for (k, &(i, credit, e, r)) in picked[..n_picked].iter().enumerate() {
        let r = r.ok_or(BAD_ACCOUNT)?;
        let record = if credit {
            let hd = hd_s.as_mut().ok_or(BAD_ACCOUNT)?;
            prepare_wide(
                WideKind::Return,
                bell_log,
                &wev::host_key(&r, pkey),
                &wev::return_payload(credited[k].saturating_mul(MILLI as u32), e.unit, i as u8),
                &mut [
                    (WideEntity::Province, &mut pd_s[..]),
                    (WideEntity::Holding, &mut hd[..]),
                ],
            )?
        } else {
            prepare_wide(
                WideKind::Stranded,
                bell_log,
                &wev::host_key(&r, pkey),
                &wev::stranded_payload(e.troops, i as u8),
                &mut [(WideEntity::Province, &mut pd_s[..])],
            )?
        };
        logs.push(record.0[..record.1].to_vec());
    }
    // Acquire all mutable borrows and check all lengths first. Nothing
    // fallible follows the first copy; receipts follow the complete commit.
    {
        let mut pd = province.try_borrow_mut_data()?;
        let mut rd = roster_ai.try_borrow_mut_data()?;
        let mut hd = if hd_s.is_some() {
            Some(holding.try_borrow_mut_data()?)
        } else {
            None
        };
        if pd.len() != pd_s.len()
            || rd.len() != rd_s.len()
            || hd
                .as_ref()
                .zip(hd_s.as_ref())
                .is_some_and(|(d, s)| d.len() != s.len())
        {
            return Err(BAD_ACCOUNT);
        }
        pd.copy_from_slice(&pd_s);
        rd.copy_from_slice(&rd_s);
        if let (Some(hd), Some(staged)) = (hd.as_mut(), hd_s.as_ref()) {
            hd.copy_from_slice(staged);
        }
    }
    for record in logs {
        solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &record]);
    }
    Ok(())
}

/// WideCloseRoster (0xDE, op 1): `[any s] [season r] [roster w] [rent_to
/// w] [province r]` (`wide_ix::CLOSE_ROSTER`). Class N. Season end (Ended
/// plus 72 h, Aborted, the Closed tombstone; `TooEarly` / `WrongStatus`
/// before): the roster side table, program-owned and of this season and
/// world at the canonical address of the province its header names,
/// closes **whole to its immutable rent recipient** (the payer of the
/// first muster that created it; `BadAddress` for any other account). The
/// hosts it names are the season's; nothing is credited.
///
/// **The deadline rule** (the deployed CloseProvince's): the deployed
/// entry table lives in the Province and closes with it at the same
/// deadline whatever its entries' states — a pending `Spend` or `Leave`, a
/// departed host, bells of the season never resolved; its hosts' rights
/// (to be resolved, to settle, to return) expire with the deadline, as the
/// escrow of an unsettled transit goes with the Holding. The side table is
/// the wide form of that entry table and closes the same way. No
/// dependency guard: a guard here (refusing while an entry is departed or
/// pending, as an earlier revision did) was not a deployed rule and, with
/// the holding, the transit record and the province closing freely at the
/// deadline, could only hold the table's rent behind dependencies the
/// other closes may already have erased. The province position is the
/// canonical address of the province the table pairs with: present, it
/// must be that province of this season and world; **absent** (closed
/// first, as the deployed order allows; the record's `rent_to` is kept
/// for exactly that), nothing is read. The settles that need the table
/// run while they still find it (the deployed settles accept Ended with
/// no deadline of their own); after this close they cannot.
pub fn close_roster(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::CLOSE_ROSTER), a, None)?;
    let [_any, season_ai, roster_ai, rent_to, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, bell, _tomb) = season_end(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    if roster_ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let r = {
        let d = roster_ai.try_borrow_data()?;
        WideRoster::read(&d).map_err(|_| BAD_ACCOUNT)?
    };
    if r.season_id != sid || r.province.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(roster_ai, &wro::roster_address(&ctx, r.province))?;
    expect_key(rent_to, &r.rent_to)?;
    // The province position: the canonical address only (the deadline
    // rule above). Present there, it is the province the table pairs with
    // (this season's and world's, that coordinate); absent, it closed.
    expect_key(province, &wl::province_address(&ctx, r.province.coord()))?;
    match province_at(province, p, sid)? {
        Some(prov) if prov.world != world || prov.coord != r.province.coord() => {
            return Err(BAD_ACCOUNT);
        }
        _ => {}
    }
    let lamports = roster_ai.lamports();
    init::close_to(p, roster_ai, rent_to, &Sink::Never, bell)?;
    // The immutable close record (no chain: the account is gone).
    emit_wide(
        WideKind::RosterClosed,
        bell,
        &r.province.to_bytes(),
        &wev::roster_closed_payload(&r.rent_to, lamports),
        &mut [],
    )
}

// ------------------------------------------------------------ 0xDA

/// **The debit gate.** WideDepart runs every check and then, while this is
/// `false`, refuses `NotImplemented` before its first effect (no escrow,
/// no transit record, no entry change, no record). The stages that settle
/// a departure exist in full below; the gate opens for production when the
/// closed flow passes native review (`WIDE-LAND-WRITER.md` §−2.4f lists
/// the conditions). Not a product switch: a build constant.
///
/// **Test-only opening.** The constant is `true` in exactly one build: the
/// crate's own unit tests compiled with the `native-crypto-tests` feature
/// on a non-SBF host (`cfg(test)` is never set for a library or a program
/// anyone links or deploys, and the feature is dev-only). There the
/// opt-in host experiment drives WideDepart's effects for real — the
/// escrow, the transit record from the payer, the entry's `Spend`, the
/// record — and settles them against a beacon posted through the real
/// PostAnchor and PostSeed with public round signatures (nothing mocked,
/// no verdict substituted). Every other build — the experimental host
/// library, its ordinary unit tests, SBF — keeps the gate closed and the
/// `NotImplemented` refusal. No policy gate of the departure (the player
/// prologue, the identity gate, the boundary, the funds) is bypassed by
/// this: only the final refusal-before-effects is lifted, in that build.
pub const DEPART_DEBIT_ENABLED: bool = cfg!(all(
    test,
    feature = "native-crypto-tests",
    not(target_os = "solana")
));

/// 0xDA WideDepart(host ref, transit_slot, arrive_bell, tip, commit,
/// seal): the deployed player prologue + `[holding w] [province w]
/// [system] [holding_province r] [transit w] [roster r]`, the deployed
/// Depart's shape plus the wide transit record and the standing
/// province's roster: `province` is the province the host **stands in**
/// (the roster its entry is in, which a march may have left home for),
/// `holding_province` the issuing holding's own province. **The debit**:
/// the entry's pending `Spend` of the march stamina (settled into state 3
/// by the bell's resolve, as deployed), the escrow `tip + fee + bond` from
/// the payer into the holding (`ESCROW`), the 288-byte wide transit record
/// created from the payer at `march::transit_address(holding, slot)` with
/// the payer as its immutable `rent_to`, the Citizen's arrivals counter;
/// the `WIDE_DEPARTED` record keyed by the host and the standing province,
/// chained to the standing province and the holding. Every stage that
/// settles this debit exists: WideSettleDeparture (op 3), WideReveal
/// (0xEE), WideGather (op 4), the arrival WideResolve, WideSettleTransit
/// (op 5) with the home re-entry.
///
/// Checks, in the deployed Depart's order where it has one:
///
/// * the host reference canonical, of this world and past the disk
///   (`BadData`/`BadAddress`); the wide holding present at the reference's
///   canonical address (`BadAccount`), the Citizen's at the reference's
///   generation (`NotOwner`); its own province present and canonical, the
///   holding not capture-locked there (`check_source_province`'s role);
/// * the standing province a **wide** province of this world at its
///   canonical address (`BadAccount`). A deployed Province in that position
///   is the legacy/wide **boundary**: the arrival quota, the roster caps
///   and the resolution of a destination bell are one per province, and a
///   host of the wide world standing in or marching across the disk would
///   need the legacy and the wide path to share them; they do not, so the
///   departure is refused `NotImplemented` before any debit (the reviewer's
///   finding: separate quotas or rosters for one bell would skip combat or
///   double garrison damage). The destination is sealed at Depart and can
///   only be judged at a reveal, so the boundary is judged where the host
///   stands;
/// * The holding final (`NotFinal`) and the **standing** province
///   resolved through `b − 2` (`NotResident`); 2. the seal's syntax
///   (`BadData`); 3. the host: the **identity gate** first, as
///   `caller_host` names the issuing holding first: the holding's host
///   identity version must be an allocated one (`WideTransit::depart`: a
///   holding that never mustered is refused `NotImplemented`); then the
///   entry at the host's alias in the standing province, **paired** with
///   the roster's reference at its index (`NotResident` without one,
///   `BadAccount` on a mismatch), in state 1 (`NotResident`), not busy
///   (`HostBusy`), and the kernel's departure (`Host::depart`: the stamina,
///   the cooldown); 4. the arrival window `b + 2 ..= b + 72` and below the
///   end bell (`ArrivalBell`); 5. the tip floor (`TipTooLow`),
///   `transit_slot < 4` (`BadData`) and the wide transit record of that
///   slot absent (`TransitState`), the payer covering tip, fee, bond and
///   the record's rent (`Insufficient`); the Citizen's bucket on a scratch
///   copy. Effects: the transfer and the record's creation (the CPIs,
///   first), then the byte writes, then the record.
pub fn depart(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    depart_as(p, a, d, &Auth::Wallet)
}

/// [`depart`] for the Citizen's wallet or an NFT resident's Citizen
/// ([`Auth`]; module doc on reachability).
pub(crate) fn depart_as(p: &Pubkey, a: &[AccountInfo], d: &[u8], auth: &Auth) -> R<()> {
    check_accounts(WideIx::Depart, a, None)?;
    let x = wix::Depart::decode(d)?;
    let [_actor, payer, season_ai, citizen, holding, standing, _system, own_province, t0, t1, t2, t3, roster_ai] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let transits = [t0, t1, t2, t3];
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let host = WideHostRef::from_bytes(&x.host).map_err(|_| FrontierError::BadData)?;
    if host.key().world() != world {
        return Err(FrontierError::BadAddress.into());
    }
    let coord = host.key().coord();
    if coord.ring() < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    // The issuing holding and its own province (the deployed
    // `holding`/`holding_province` pair).
    expect_key(holding, &wh::holding_address(&ctx, coord, host.site()))?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.owner_citizen != key(citizen) || h.gen != host.gen() {
        return Err(FrontierError::NotOwner.into());
    }
    if h.world != world || h.coord != coord || h.site != host.site() {
        return Err(BAD_ACCOUNT);
    }
    expect_key(own_province, &wl::province_address(&ctx, coord))?;
    let own = province_at(own_province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if own.world != world || own.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    {
        let pd = own_province.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    // The standing province (the deployed `province`): a wide province of
    // this world. A deployed Province here is the legacy/wide boundary.
    let stand = match province_at(standing, p, hdr.id) {
        Ok(Some(sp)) => sp,
        Ok(None) => return Err(BAD_ACCOUNT),
        Err(e) => {
            if prologue::presence(standing, p, AccountKind::Province, hdr.id).unwrap_or(false) {
                return Err(FrontierError::NotImplemented.into());
            }
            return Err(e);
        }
    };
    if stand.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(standing, &wl::province_address(&ctx, stand.coord))?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    // 1. the deployed Depart: the holding final, the standing province
    // resident.
    let state = {
        let hd = holding.try_borrow_data()?;
        Ro(&hd).u8(H::STATE)?
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let rn = {
        let pd = standing.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if !ap::resident_ok(rn, now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    // 2. the seal's syntax.
    if !super::host::seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    // 3. the host. The identity gate first (the holding's host identity
    // version must be the allocated one: `WideTransit::depart` refuses the
    // unallocated version, under which no host was ever mustered); then
    // the entry at the alias, paired with the standing roster's reference.
    // The identity gate first, as the deployed `caller_host` names the
    // issuing holding before the entry: a holding founded under the
    // unallocated identity never mustered, so no host of it stands anywhere.
    if h.host_identity == wh::HOST_IDENTITY_UNALLOCATED {
        return Err(FrontierError::NotImplemented.into());
    }
    let skey = ProvinceKey::new(world, stand.coord);
    let seal_root = cseal::wide_seal_root_of(&x.commit, &x.seal);
    let alias = wide_host_alias(&host);
    expect_key(roster_ai, &wro::roster_address(&ctx, skey))?;
    let roster = roster_at(roster_ai, p, hdr.id, skey)?.ok_or(FrontierError::NotResident)?;
    let (index, mut e) = {
        let pd = standing.try_borrow_data()?;
        let rd = roster_ai.try_borrow_data()?;
        roster
            .validate_paired(&rd, &wres::live_ids(&pd).map_err(resolve_err)?)
            .map_err(|_| BAD_ACCOUNT)?;
        let i = find_entry(&pd, alias).ok_or(FrontierError::NotResident)?;
        let e = read_entry(&pd, i).map_err(|_| BAD_ACCOUNT)?;
        if !roster.entry_matches(&rd, i, e.id, &host) {
            return Err(BAD_ACCOUNT);
        }
        (i, e)
    };
    // `WideTransit::depart` validates the identity version, the unit, the
    // faction and the arrival window (the deployed step 4's bounds). The
    // origin is the entry's tile in the standing province, as deployed.
    let origin = TileAddress::new(skey, e.tile).map_err(|_| BAD_ACCOUNT)?;
    let dealt = hold::bps16(
        of_faction_v3(e.faction)
            .ok_or(BAD_ACCOUNT)?
            .dealt_bps(Posture::Stance(Stance::Hold), true),
    )?;
    let transit = WideTransit::depart(
        h.host_identity,
        host,
        e.unit,
        e.faction,
        origin,
        now_bell,
        x.arrive_bell,
        now.ts,
        e.troops,
        super::host::DEPART_STAMINA,
        dealt,
        seal_root,
        x.tip,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        key(payer),
    )
    .map_err(march_err)?;
    if e.state != E::STATE_ROSTER {
        return Err(FrontierError::NotResident.into());
    }
    if e.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    let mut kh = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    kh.depart(now_bell, super::host::DEPART_STAMINA, rn)
        .map_err(|er| super::host::host_err(er, FrontierError::NotResident))?;
    // 4. a bell of the season (the window is step 3's).
    if x.arrive_bell >= hdr.end_bell {
        return Err(FrontierError::ArrivalBell.into());
    }
    // 5. the tip floor, the transit slot, the funds.
    let (priority, limit, loaded, fee, bond) = {
        let sd = season_ai.try_borrow_data()?;
        let r = Ro(&sd);
        (
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            r.u32(S::REVEAL_CU_LIMIT)?,
            r.u32(S::REVEAL_LOADED_LIMIT)?,
            r.u64(S::MARCH_FEE)?,
            r.u64(S::SEAL_BOND)?,
        )
    };
    if x.tip < fees::min_tip_lamports(priority, limit, loaded) {
        return Err(FrontierError::TipTooLow.into());
    }
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    // The full-slot proof (the deployed `host_in_transit` over the four
    // wide transit records, which live outside the Holding): every record
    // at its canonical address; the departing slot absent (`TransitState`)
    // and writable; no other slot holding an open march of **this host**
    // (`HostInTransit`: a host that stayed after a march cannot depart
    // again under another slot before its first march settles).
    let hkey = key(holding);
    let transit_ai = transits[x.transit_slot as usize];
    for (s, ai) in transits.iter().enumerate() {
        let rec = transit_at(ai, p, &ctx, &hkey, s as u8)?;
        if s == x.transit_slot as usize {
            if rec.is_some() {
                return Err(FrontierError::TransitState.into());
            }
            if !ai.is_writable {
                return Err(BAD_ACCOUNT);
            }
        } else if rec.is_some_and(|t| t.host == host) {
            return Err(FrontierError::HostInTransit.into());
        }
    }
    let total = x
        .tip
        .checked_add(fee)
        .and_then(|v| v.checked_add(bond))
        .ok_or(OVERFLOW)?;
    let rent_t = init::rent(wm::WIDE_TRANSIT_LEN)?;
    if payer.lamports() < total.checked_add(rent_t).ok_or(OVERFLOW)? {
        return Err(FrontierError::Insufficient.into());
    }
    // The Citizen's bucket and the end bell, on a scratch copy; the
    // holding's touch.
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        start.finish(&mut scratch, now.ts)?;
    }
    let touched = hold::load_touched(holding, now.ts)?;
    {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        r.u64(H::ESCROW)?.checked_add(total).ok_or(OVERFLOW)?;
        r.u8(wh::wide_holding::OPEN_TRANSITS)?
            .checked_add(1)
            .ok_or(OVERFLOW)?;
    }
    // The Citizen's arrival count (the deployed `arrivals + 1` below),
    // preflighted here so that its overflow is found before the escrow
    // moves and the record is created, as the holding's counters are. (The
    // event chain's advance cannot be preflighted the same way: `emit_wide`
    // computes every link before it writes a header, but after the
    // transfers; a chain at its maximum refuses `Overflow` then, and the
    // transaction reverts — the host test shows that rollback.)
    {
        let cd = citizen.try_borrow_data()?;
        Ro(&cd).u32(C::ARRIVALS)?.checked_add(1).ok_or(OVERFLOW)?;
    }
    // The debit gate (module doc): every check above passed and nothing is
    // written yet. The departure's effects stay refused here until the
    // closed flow (SettleDeparture, Reveal, Gather, the arrival Resolve,
    // SettleTransit with the home re-entry, the foreign dissolve and
    // return, the close refusal) passes native review.
    if !DEPART_DEBIT_ENABLED {
        return Err(FrontierError::NotImplemented.into());
    }
    // ---- effects: the CPIs first (the escrow, the record), then bytes ----
    init::transfer(payer, holding, total)?;
    init::init_with_seed(
        payer,
        transit_ai,
        season_ai,
        &SeasonSigner::new(hdr.id, hdr.bump),
        &wm::transit_seed(&hkey, x.transit_slot),
        wm::WIDE_TRANSIT_LEN,
        rent_t,
        p,
    )?;
    {
        let mut td = transit_ai.try_borrow_mut_data()?;
        if td.len() != wm::WIDE_TRANSIT_LEN {
            return Err(BAD_ACCOUNT);
        }
        td.copy_from_slice(&transit.to_bytes());
    }
    e.set_host(&kh);
    {
        let mut pd = standing.try_borrow_mut_data()?;
        write_entry(&mut pd, index, &e).map_err(|_| BAD_ACCOUNT)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &touched, now.ts)?;
        let mut w = Rw(&mut hd);
        w.add_u64(H::ESCROW, total)?;
        let open = w.u8(wh::wide_holding::OPEN_TRANSITS)?.saturating_add(1);
        w.set_u8(wh::wide_holding::OPEN_TRANSITS, open)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        let mut w = Rw(&mut cd);
        w.add_u32(C::ARRIVALS, 1)?;
        w.set_i64(C::LAST_ACTION_TS, now.ts)?;
    }
    let mut pd = standing.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    emit_wide(
        WideKind::Departed,
        now_bell,
        &wev::host_key(&host, skey),
        &wev::departed_payload(
            x.transit_slot,
            now_bell,
            x.arrive_bell,
            e.troops,
            super::host::DEPART_STAMINA,
            x.tip,
            fee,
            bond,
            &seal_root,
        ),
        &mut [
            (WideEntity::Province, &mut pd[..]),
            (WideEntity::Holding, &mut hd[..]),
        ],
    )
}

// ------------------------------------------------------------ the march stages

/// The arrival evidence of `(dest, bell)`: the wide ArrivalDay of the
/// bell's day at its canonical address (`BadAddress` otherwise). Absent:
/// no reveal of that day reached the province (`false`). Present:
/// program-owned, this season's, this destination's and this day's
/// (`BadAccount` otherwise); the bell's bit.
fn arrival_day_bit(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &AddrCtx,
    season_id: u64,
    dest: ProvinceKey,
    bell: u32,
) -> R<bool> {
    let day = wa::day_of(bell);
    expect_key(ai, &wa::arrival_day_address(ctx, dest, day))?;
    if init::is_absent(ai) {
        return Ok(false);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    let rec = wa::WideArrivalDay::read(&d).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != season_id || rec.dest != dest || rec.day != day {
        return Err(BAD_ACCOUNT);
    }
    Ok(rec.has(bell))
}

/// The wide transit record of slot `slot` of the wide holding at `holding`
/// at its canonical address (`BadAddress` otherwise): `None` if absent, the
/// record if present and program-owned (`BadAccount` otherwise, including
/// bytes `WideTransit::from_bytes` refuses).
fn transit_at(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &AddrCtx,
    holding: &[u8; 32],
    slot: u8,
) -> R<Option<WideTransit>> {
    expect_key(ai, &wm::transit_address(ctx, holding, slot))?;
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    Ok(Some(WideTransit::from_bytes(&d).map_err(|_| BAD_ACCOUNT)?))
}

/// The holding's four wide transit records at their canonical addresses
/// (`BadAddress` otherwise), each absent or a readable record.
fn open_transits_of(
    p: &Pubkey,
    ctx: &AddrCtx,
    holding: &[u8; 32],
    transits: &[&AccountInfo; 4],
) -> R<[Option<WideTransit>; 4]> {
    let mut out = [None; 4];
    for (s, ai) in transits.iter().enumerate() {
        out[s] = transit_at(ai, p, ctx, holding, s as u8)?;
    }
    Ok(out)
}

/// The deployed `host_in_transit` over the wide records: whether any of
/// the holding's four transit records is an open march of `host` (the
/// full reference, never the alias).
fn host_has_open_transit(
    p: &Pubkey,
    ctx: &AddrCtx,
    holding: &[u8; 32],
    transits: &[&AccountInfo; 4],
    host: &WideHostRef,
) -> R<bool> {
    Ok(open_transits_of(p, ctx, holding, transits)?
        .iter()
        .flatten()
        .any(|t| t.host == *host))
}

/// The beacon region a wide destination has when it was never opened:
/// the Season's one region rule candidate (`rules::RegionRule::SortKeyHashV1`,
/// [`wr::wide_region`]). A settlement of a valid seal to an absent
/// province takes the anchor of **this** region of the arrival bell and no
/// other (its `A` closes the window the settle is timed from). Should a
/// second region rule ever be configured, this must read the Season's
/// configuration instead; the rules module has one candidate today.
pub(crate) fn absent_destination_region(dest: WideCoord) -> u8 {
    wr::wide_region(dest)
}

/// Writes a wide transit record whole.
fn write_transit(ai: &AccountInfo, t: &WideTransit) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    if d.len() != wm::WIDE_TRANSIT_LEN {
        return Err(BAD_ACCOUNT);
    }
    d.copy_from_slice(&t.to_bytes());
    Ok(())
}

/// The entry of `host` in a wide province: the entry carrying its alias,
/// **paired** with the roster's reference at the same index
/// (`entry_matches`). `None` when no entry carries the alias; `BadAccount`
/// when an entry does but the roster does not vouch for it.
fn host_entry(
    pd: &[u8],
    roster: &WideRoster,
    rd: &[u8],
    host: &WideHostRef,
) -> R<Option<(usize, Entry)>> {
    let Some(i) = find_entry(pd, wide_host_alias(host)) else {
        return Ok(None);
    };
    let e = read_entry(pd, i).map_err(|_| BAD_ACCOUNT)?;
    if !roster.entry_matches(rd, i, e.id, host) {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some((i, e)))
}

/// The record bell of a settlement (`NO_BELL` before genesis).
fn bell_log(hdr: &ap::SeasonHdr, ts: i64) -> u32 {
    hdr.bell(ts).unwrap_or(frontier_abi::log::NO_BELL)
}

/// WideSettleDeparture (0xDC, op 3): `[payer s,w] [season r]
/// [origin_province w] [holding w] [roster w] [transit w]`
/// (`wide_ix::SETTLE_DEPARTURE`), class D, permissionless. The deployed
/// SettleDeparture over the wide records: the Season Running or Ended; the
/// host reference canonical and of this world; the issuing holding at its
/// canonical address, present (`BadAccount`); the wide transit record of
/// `transit_slot` at its canonical address, present (`TransitState`
/// otherwise: no march), the host's, in state 1 (`AlreadyDone` once
/// settled, `TransitState` otherwise); the origin province the record
/// names (where the host stood) at its canonical address, present, the
/// capture lock when it is the holding's own; the origin resolved past the
/// departure bell (`TooEarly`); the roster present and paired, the entry
/// at the host's alias paired with its reference (`NotResident` without
/// one) in state 3; the kernel's post-clash values
/// (`Host::march_values`); `destroyed = troops < 500`. Effects: the entry
/// freed and its reference released, `n_entries − 1`, the record stepped
/// to state 2 or 3 with `troops_after`, `stamina_after` and
/// `ready_bell_off` (`WideTransit::step`); the `WIDE_DEPARTURE_SETTLED`
/// record keyed by the host and the origin, chained to the origin and the
/// holding.
pub fn settle_departure(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleDeparture) -> R<()> {
    check_accounts(Shape(wix::SETTLE_DEPARTURE), a, None)?;
    let [_payer, season_ai, origin_ai, holding, roster_ai, transit_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let host = WideHostRef::from_bytes(&x.host).map_err(|_| FrontierError::BadData)?;
    if host.key().world() != world {
        return Err(FrontierError::BadAddress.into());
    }
    // 1. the holding and its transit record.
    expect_key(
        holding,
        &wh::holding_address(&ctx, host.key().coord(), host.site()),
    )?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let t = transit_at(transit_ai, p, &ctx, &key(holding), x.transit_slot)?
        .ok_or(FrontierError::TransitState)?;
    if t.host != host {
        return Err(BAD_ACCOUNT);
    }
    match t.state {
        MarchState::Departed => {}
        MarchState::Settled | MarchState::DestroyedAtOrigin => {
            return Err(FrontierError::AlreadyDone.into())
        }
        _ => return Err(FrontierError::TransitState.into()),
    }
    // 2. the origin province the record names, its roster, the entry.
    let okey = t.origin.key();
    if okey.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(origin_ai, &wl::province_address(&ctx, okey.coord()))?;
    let oprov = province_at(origin_ai, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if oprov.world != world || oprov.coord != okey.coord() {
        return Err(BAD_ACCOUNT);
    }
    if okey.coord() == h.coord {
        let pd = origin_ai.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    let rn = {
        let pd = origin_ai.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if rn <= t.depart_bell {
        return Err(FrontierError::TooEarly.into());
    }
    expect_key(roster_ai, &wro::roster_address(&ctx, okey))?;
    let roster = roster_at(roster_ai, p, hdr.id, okey)?.ok_or(BAD_ACCOUNT)?;
    let mut pd_s = origin_ai.try_borrow_data()?.to_vec();
    let mut rd_s = roster_ai.try_borrow_data()?.to_vec();
    roster
        .validate_paired(&rd_s, &wres::live_ids(&pd_s).map_err(resolve_err)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let (index, e) = host_entry(&pd_s, &roster, &rd_s, &host)?.ok_or(FrontierError::NotResident)?;
    if e.state != E::STATE_DEPARTED {
        return Err(FrontierError::NotResident.into());
    }
    let kh = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    let (troops, stamina) = kh
        .march_values(t.depart_bell, rn)
        .map_err(|er| super::host::host_err(er, FrontierError::TooEarly))?;
    let destroyed = troops < DESTROYED_BELOW;
    let (troops, stamina) = if destroyed { (0, 0) } else { (troops, stamina) };
    let ready_off = e
        .ready_bell
        .saturating_sub(t.depart_bell)
        .min(u16::MAX as u32) as u16;
    let settled = t
        .step(
            MarchEvent::SettleDeparture { destroyed },
            Some((troops, stamina, ready_off)),
        )
        .map_err(march_err)?;
    // Staged: the entry freed, the reference released.
    write_entry(&mut pd_s, index, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
    {
        let mut w = Rw(&mut pd_s);
        let n = w.u8(PV::N_ENTRIES)?.saturating_sub(1);
        w.set_u8(PV::N_ENTRIES, n)?;
    }
    roster.release(&mut rd_s, index).map_err(|_| BAD_ACCOUNT)?;
    // ---- effects ----
    {
        let mut pd = origin_ai.try_borrow_mut_data()?;
        pd.copy_from_slice(&pd_s);
    }
    {
        let mut rd = roster_ai.try_borrow_mut_data()?;
        rd.copy_from_slice(&rd_s);
    }
    write_transit(transit_ai, &settled)?;
    let mut pd = origin_ai.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    emit_wide(
        WideKind::DepartureSettled,
        bell_log(&hdr, now.ts),
        &wev::host_key(&host, okey),
        &wev::departure_settled_payload(
            x.transit_slot,
            destroyed,
            troops,
            stamina,
            ready_off,
            index as u8,
        ),
        &mut [
            (WideEntity::Province, &mut pd[..]),
            (WideEntity::Holding, &mut hd[..]),
        ],
    )
}

/// One gathered position from its wide ArrivalSlot and the slot's host's
/// wide transit record (the deployed `gather_position` over the wide
/// records). The transit account must be **the** record the slot is bound
/// to: `transit_address(holding of the slot's host, slot.transit_slot)`
/// (`BadAddress` for any other, the three sibling slots included), and it
/// must be present (`BadAccount`: a revealed march's record cannot be
/// settled before the destination's bell is resolved, which needs this
/// gather, so an absent record is never "no arrival"); it must be this
/// host's march to this bell (`BadAccount`), settled at the origin
/// (`DepartureUnsettled` in state 1): a host destroyed at the origin is
/// recorded with `FATE_DESTROYED`, a settled one with its post-origin
/// troops and its stamina at the arrival bell, present when at or above
/// `DESTROYED_BELOW`; a record already gathered must have been gathered
/// **here** (`BadAccount`). A first gather stamps the record `Gathered` at
/// this destination (staged into `stamped`).
#[allow(clippy::too_many_arguments)]
fn gather_arrival(
    p: &Pubkey,
    ctx: &AddrCtx,
    dest: ProvinceKey,
    bell: u32,
    s: &WideArrivalSlot,
    transit_ai: &AccountInfo,
    at: usize,
    stamped: &mut Vec<(usize, WideTransit)>,
) -> R<WideArrival> {
    let mut a = WideArrival {
        host: s.host,
        citizen: s.citizen,
        dep_mass: s.dep_mass,
        troops: 0,
        stamina: 0,
        retreat_bps: s.retreat_bps,
        dealt_bps: s.dealt_bps,
        faction: s.faction,
        unit: s.unit,
        tile: s.tile,
        stance: s.stance,
        present: false,
        fate: wa::wide_arrival::FATE_NONE,
        troops_after: 0,
    };
    let hkey = wh::holding_address(ctx, s.host.key().coord(), s.host.site());
    let t = transit_at(transit_ai, p, ctx, &hkey, s.transit_slot)?.ok_or(BAD_ACCOUNT)?;
    if t.host != s.host || t.arrive_bell != bell {
        return Err(BAD_ACCOUNT);
    }
    let stamp = match t.state {
        MarchState::Departed => return Err(FrontierError::DepartureUnsettled.into()),
        MarchState::Free => return Err(BAD_ACCOUNT),
        MarchState::Gathered => {
            if t.dest != Some(dest) {
                return Err(BAD_ACCOUNT);
            }
            false
        }
        MarchState::Settled | MarchState::DestroyedAtOrigin => true,
    };
    if t.state == MarchState::DestroyedAtOrigin {
        a.fate = wa::wide_arrival::FATE_DESTROYED;
    } else {
        a.troops = t.troops_after;
        a.stamina =
            frontier_abi::clash_model::arrival_stamina(t.stamina_after, t.depart_bell, bell);
        if a.troops >= DESTROYED_BELOW {
            a.present = true;
        } else {
            a.fate = wa::wide_arrival::FATE_DESTROYED;
        }
    }
    if stamp {
        // The record is written: the position must be writable (an absent
        // slot's position may be any read-only account).
        if !transit_ai.is_writable {
            return Err(BAD_ACCOUNT);
        }
        let g = t
            .step(MarchEvent::Gather { dest }, None)
            .map_err(march_err)?;
        stamped.push((at, g));
    }
    Ok(a)
}

/// WideGather (0xDC, op 4): `[fee_payer s,w] [season r] [province r]
/// [anchor|archive r] [inputs w] [ix_sysvar r] [system]` then `n × [slot r]
/// [transit w]` (`wide_ix::GATHER`), class D, top-level. The deployed
/// GatherClash over the wide records: the cursor `start..start + n` within
/// the 24 positions (`BadData`); the keeper prologue, this build's Season;
/// the destination a wide province of this world at its canonical address;
/// `bell ≥ resolved_next` (`LatchClosed`), below the end bell
/// (`WrongStatus`); the reveal window of the bell **closed** for the
/// province's stored region against THE anchor or its archive entry
/// (`TooEarly`, `NoAnchor`, `BadAddress`); the wide ClashInputs at its
/// canonical address, created from the fee payer with its fee evidence
/// (the instructions sysvar) when absent, else this province's and bell's
/// and not yet resolved (`AlreadyDone`). Each position of the cursor not
/// yet gathered: the slot at its canonical address, absent (the position
/// is empty) or this province's, bell's and position's ([`gather_arrival`]
/// from it and the named transit record). **No ArrivalDay**: the wide world
/// has none, so "no arrivals" is the state a fully scanned record reaches
/// with no present position (`FLAG_NO_ARRIVALS` then), and a resolve needs
/// every position scanned (`arrivals_mask == ALL_GATHERED`). Effects: the
/// record created when absent (the one CPI, first), its positions and
/// header written, every first-gathered transit stamped; the
/// `WIDE_GATHERED` record keyed by the province (no chain: the ClashInputs
/// has none and nothing else is written).
pub fn gather(p: &Pubkey, a: &[AccountInfo], x: &wix::Gather) -> R<()> {
    let end = x.start as usize + x.n as usize;
    if x.n == 0 || end > wa::wide_clash_inputs::POSITIONS {
        return Err(FrontierError::BadData.into());
    }
    check_accounts(TopLevelShape(wix::GATHER), a, Some(&[1, x.n]))?;
    prologue::top_level(TopLevelShape(wix::GATHER))?;
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let [fee_payer, season_ai, province, anchor_ai, inputs_ai, day_ai, ix_sysvar, _system, rest @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if rest.len() != 2 * x.n as usize {
        return Err(FrontierError::TooManyAccounts.into());
    }
    require_wide_season(season_ai)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
    let rn = {
        let pd = province.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if x.bell < rn {
        return Err(FrontierError::LatchClosed.into());
    }
    if x.bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let clock = {
        let sd = season_ai.try_borrow_data()?;
        SeasonClock::read(&sd)?
    };
    super::clash::window_closed(
        p,
        &ctx,
        hdr.id,
        &clock,
        now.ts,
        x.bell,
        prov.region,
        anchor_ai,
    )?;
    expect_key(inputs_ai, &wa::clash_inputs_address(&ctx, pkey, x.bell))?;
    let created = init::is_absent(inputs_ai);
    let mut cd_s: Vec<u8> = if created {
        let ev = evidence::read(ix_sysvar, now.slot)?;
        let mut ih = WideClashInputsHdr::new(hdr.id, pkey, x.bell, key(fee_payer));
        ih.ev_slot = ev.slot;
        ih.ev_price = ev.price;
        ih.ev_limit = ev.limit;
        let mut d = alloc::vec![0u8; wa::wide_clash_inputs::SIZE];
        ih.write(&mut d).map_err(|_| BAD_ACCOUNT)?;
        d
    } else {
        if inputs_ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let cd = inputs_ai.try_borrow_data()?;
        let ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
        if ih.season_id != hdr.id || ih.dest != pkey || ih.bell != x.bell {
            return Err(BAD_ACCOUNT);
        }
        if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
            return Err(FrontierError::AlreadyDone.into());
        }
        cd.to_vec()
    };
    let mut ih = WideClashInputsHdr::read(&cd_s).map_err(|_| BAD_ACCOUNT)?;
    let mut mask = ih.arrivals_mask;
    let mut stamped: Vec<(usize, WideTransit)> = Vec::new();
    // The arrival evidence (the deployed day bit): clear, the record is
    // complete with no arrivals and no slot is read.
    let has_arrivals = arrival_day_bit(day_ai, p, &ctx, hdr.id, pkey, x.bell)?;
    if !has_arrivals {
        mask = wa::wide_clash_inputs::ALL_GATHERED;
    }
    for j in 0..x.n as usize {
        if !has_arrivals {
            break;
        }
        let k = x.start as usize + j;
        let (f, i) = ((k / 4) as u8, (k % 4) as u8);
        let slot_ai = &rest[2 * j];
        let transit_ai = &rest[2 * j + 1];
        expect_key(slot_ai, &wa::arrival_slot_address(&ctx, pkey, x.bell, f, i))?;
        let bit = 1u32 << k;
        if mask & bit != 0 {
            continue;
        }
        let slot = if init::is_absent(slot_ai) {
            None
        } else {
            if slot_ai.owner != p {
                return Err(BAD_ACCOUNT);
            }
            let sd = slot_ai.try_borrow_data()?;
            let s = WideArrivalSlot::read(&sd).map_err(|_| BAD_ACCOUNT)?;
            if s.season_id != hdr.id
                || s.dest != pkey
                || s.bell != x.bell
                || s.faction != f
                || s.i != i
            {
                return Err(BAD_ACCOUNT);
            }
            Some(s)
        };
        let o = wa::wide_clash_inputs::arrival(k);
        cd_s[o..o + wa::wide_arrival::SIZE].fill(0);
        if let Some(s) = slot {
            let arrival = gather_arrival(
                p,
                &ctx,
                pkey,
                x.bell,
                &s,
                transit_ai,
                2 * j + 1,
                &mut stamped,
            )?;
            arrival.write_at(&mut cd_s, k).map_err(|_| BAD_ACCOUNT)?;
        }
        mask |= bit;
    }
    let mut n_present = 0u8;
    for k in 0..wa::wide_clash_inputs::POSITIONS {
        if let Some(arr) = WideArrival::read_at(&cd_s, k).map_err(|_| BAD_ACCOUNT)? {
            if arr.present {
                n_present = n_present.saturating_add(1);
            }
        }
    }
    ih.arrivals_mask = mask;
    ih.n_present = n_present;
    let no_arrivals = mask == wa::wide_clash_inputs::ALL_GATHERED && n_present == 0;
    if no_arrivals {
        ih.flags |= wa::wide_clash_inputs::FLAG_NO_ARRIVALS;
    }
    ih.write(&mut cd_s).map_err(|_| BAD_ACCOUNT)?;
    // ---- effects: the record's creation (the CPI) first, then bytes ----
    if created {
        init::init_with_seed(
            fee_payer,
            inputs_ai,
            season_ai,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &wa::clash_inputs_seed(pkey, x.bell),
            wa::wide_clash_inputs::SIZE,
            init::rent(wa::wide_clash_inputs::SIZE)?,
            p,
        )?;
    }
    {
        let mut cd = inputs_ai.try_borrow_mut_data()?;
        if cd.len() != cd_s.len() {
            return Err(BAD_ACCOUNT);
        }
        cd.copy_from_slice(&cd_s);
    }
    for (at, t) in &stamped {
        write_transit(&rest[*at], t)?;
    }
    emit_wide(
        WideKind::Gathered,
        bell_log(&hdr, now.ts),
        &pkey.to_bytes(),
        &wev::gathered_payload(x.bell, x.start, x.n, mask, n_present, no_arrivals),
        &mut [],
    )
}

/// A province's walkable masks for the wide path walk.
pub(crate) struct WideLand {
    pub(crate) key: ProvinceKey,
    pub(crate) passable: u64,
    pub(crate) rough: u64,
    pub(crate) road: u64,
}

fn land_of(pd: &[u8], key: ProvinceKey) -> R<WideLand> {
    let r = Ro(pd);
    Ok(WideLand {
        key,
        passable: r.u64(PV::PASSABLE_MASK)?,
        rough: r.u64(PV::ROUGH_MASK)?,
        road: r.u64(PV::ROAD_MASK)?,
    })
}

/// The deployed Reveal's walk over wide tiles (`reveal::walk` with the
/// province lattice replaced by `WideTile::neighbors`): from the origin
/// tile, each committed step enters the neighbour in `hex::DIRECTIONS`
/// order; `lands[0]` is the destination and `lands[1..]` the supplied path
/// provinces in **first-entered** order (a step into a province that is
/// neither the destination nor one already entered must enter the next
/// supplied one, else `Path`); every tile entered must be passable in its
/// province (`Path`); the travel seconds are the deployed per-hex costs
/// (rough or flat, halved on a road, halved mounted). The walk must end on
/// the committed destination tile having entered exactly the supplied
/// provinces (`Path`). No tower wear: the wide provinces carry no
/// structures (`resolve::refuse_unported`). Returns the raw seconds before
/// the doctrine's bias.
pub(crate) fn walk_wide(
    plain: &WidePlain,
    origin: TileAddress,
    lands: &[WideLand],
    cavalry: bool,
) -> R<u32> {
    let path = || crate::Error::from(FrontierError::Path);
    let n = plain.path_len as usize;
    let dest = lands.first().ok_or_else(path)?;
    if n == 0 || n > MAX_PATH_STEPS || lands.len() > MAX_PATH_PROVINCES {
        return Err(path());
    }
    let mut tile = WideTile::of(origin);
    let mut entered = 0usize;
    let mut secs = 0u32;
    let half = cavalry as u32;
    for i in 0..n {
        let dir = ks::path_step(&plain.path, i) as usize;
        tile = *tile
            .neighbors()
            .get(dir)
            .and_then(|t| t.as_ref())
            .ok_or_else(path)?;
        let k = tile.province();
        let land = if k == dest.key {
            dest
        } else if let Some(l) = lands[1..1 + entered].iter().find(|l| l.key == k) {
            l
        } else {
            match lands.get(1 + entered) {
                Some(l) if l.key == k => {
                    entered += 1;
                    l
                }
                _ => return Err(path()),
            }
        };
        let bit = 1u64 << tile.local();
        if land.passable & bit == 0 {
            return Err(path());
        }
        let st = if land.rough & bit != 0 {
            ROUGH_HEX_SECS
        } else {
            FLAT_HEX_SECS
        };
        secs = secs.wrapping_add(st >> (half + (land.road & bit != 0) as u32));
    }
    if tile.province() != dest.key || tile.local() != plain.dest_tile || entered + 1 != lands.len()
    {
        return Err(path());
    }
    Ok(secs)
}

// The quota over full identities (`WideSlotEntry`, `WideSlotDecision`,
// `wide_admit`) lives in the shared ABI module
// `frontier_abi::world_index::settle` since the keeper plans the
// settlement from the same functions; the names are re-exported below
// unchanged (see the settlement section).

/// WideReveal (0xEE): `[fee_payer s,w] [season r] [holding r] [transit r]
/// [anchor r] [archive r] [beaconlog r] [inputs r] [dest_province r] [slot
/// × 4] [ix_sysvar r] [system]` then 0–3 `[path_province r]`
/// (`wide_ix::REVEAL`), class W, top-level, no player. The deployed Reveal
/// over the wide records, in its order: `target_i < 4` (`BadData`) and
/// exactly that slot writable (`BadAccount`); the keeper prologue, this
/// build's Season; the holding at its canonical address and its wide
/// transit record of `transit_slot`, present (`TransitState`), the host's
/// holding's; the Ended clause (`WrongStatus`); the wide plaintext
/// decoded and validated against the record's host and arrival bell
/// (`world_index::seal::validate`: `BadPlaintext`); **the commitment**
/// `seal_root(commit(plain, salt), ct_hash) == record.seal_root`
/// (`CommitMismatch`; no decryption); the destination the plaintext names
/// at its canonical address, present and wide, its stored region; THE
/// anchor, the archive and the beacon log of `(arrive, region)` at their
/// canonical addresses: the anchor present → `now < reveal_close`
/// (`WindowClosed`) and the log's latest round below the seed round
/// (`WindowClosed`), else the archive present → not tombstoned
/// (`Archived`); the latch: the wide ClashInputs of `(dest, arrive)` absent
/// and `dest.resolved_next ≤ arrive` (`LatchClosed`); the path
/// ([`walk_wide`], `Path`) and the arrival bell within the doctrine's
/// travel time (`ArrivalBell`); the destination tile's site shield
/// (`Shielded`); the quota over the four wide slots ([`wide_admit`]:
/// `AlreadyDone`, `QuotaRefused`, `SlotMoved`); the fee evidence. Effects:
/// the slot created from the fee payer when new (its immutable `rent_to`
/// the fee payer; a displaced slot keeps its creator's), written whole
/// (`WideArrivalSlot`: the full host reference, the owner Citizen's key,
/// the committed facts, the doctrine's `dealt_bps` arriving, the
/// beneficiary, the evidence); the `WIDE_REVEALED` record keyed by the host
/// and the destination (no chain: nothing chained is written).
pub fn reveal(p: &Pubkey, a: &[AccountInfo], x: &wix::Reveal) -> R<()> {
    let n_path = a
        .len()
        .checked_sub(wix::REVEAL_FIXED)
        .ok_or(FrontierError::TooManyAccounts)?;
    if n_path + 1 > MAX_PATH_PROVINCES {
        return Err(FrontierError::TooManyAccounts.into());
    }
    check_accounts(TopLevelShape(wix::REVEAL), a, Some(&[1, n_path as u8]))?;
    prologue::top_level(TopLevelShape(wix::REVEAL))?;
    if x.target_i as usize >= 4 {
        return Err(FrontierError::BadData.into());
    }
    for i in 0..4 {
        if a[wix::REVEAL_SLOT0 + i].is_writable != (i == x.target_i as usize) {
            return Err(BAD_ACCOUNT);
        }
    }
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let [fee_payer, season_ai, holding, transit_ai, anchor, archive, log, inputs, dest_ai, day_ai, s0, s1, s2, s3, ix_sysvar, _system, path @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let slots_ai = [s0, s1, s2, s3];
    require_wide_season(season_ai)?;
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // 2. the holding, the transit record, the plaintext.
    let h = holding_at(holding, p, sid)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let t = transit_at(transit_ai, p, &ctx, &key(holding), x.transit_slot)?
        .ok_or(FrontierError::TransitState)?;
    if !t.state.in_transit() {
        return Err(FrontierError::TransitState.into());
    }
    if t.host.key().coord() != h.coord || t.host.site() != h.site {
        return Err(BAD_ACCOUNT);
    }
    let arrive = t.arrive_bell;
    if hdr.status == S::STATUS_ENDED && arrive >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let plain = wseal::unpack(&x.plain).map_err(|_| FrontierError::BadPlaintext)?;
    wseal::validate(&plain, &t.host, arrive).map_err(|_| FrontierError::BadPlaintext)?;
    // 3. the commitment.
    let commit = wseal::commit(&x.plain, &x.salt);
    if wseal::seal_root(&commit, &x.ct_hash) != t.seal_root {
        return Err(FrontierError::CommitMismatch.into());
    }
    // 4. the destination, its region and the window.
    let dest = plain.dest;
    if dest.world() != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(dest_ai, &wl::province_address(&ctx, dest.coord()))?;
    let dprov = province_at(dest_ai, p, sid)?.ok_or(BAD_ACCOUNT)?;
    if dprov.world != world || dprov.coord != dest.coord() {
        return Err(BAD_ACCOUNT);
    }
    let region = dprov.region;
    let clock = {
        let sd = season_ai.try_borrow_data()?;
        SeasonClock::read(&sd)?
    };
    expect_key(anchor, &ctx.bell_anchor(arrive, region))?;
    let part = archive_part_of(arrive);
    expect_key(archive, &ctx.anchor_archive(region, part))?;
    expect_key(log, &ctx.beacon_log(region))?;
    if prologue::presence(anchor, p, AccountKind::BellAnchor, sid)? {
        let a_ts = {
            let d = anchor.try_borrow_data()?;
            let r = Ro(&d);
            if r.u32(BA::BELL)? != arrive || r.u8(BA::REGION)? != region {
                return Err(BAD_ACCOUNT);
            }
            r.i64(BA::A)?
        };
        if now.ts >= clock.reveal_close(arrive, a_ts) {
            return Err(FrontierError::WindowClosed.into());
        }
        prologue::present(log, p, AccountKind::BeaconLog, sid)?;
        let latest = {
            let ld = log.try_borrow_data()?;
            let r = Ro(&ld);
            if r.u8(BL::REGION)? != region {
                return Err(BAD_ACCOUNT);
            }
            r.u64(BL::LATEST_ROUND)?
        };
        if latest >= clock.seed_round(arrive, a_ts) {
            return Err(FrontierError::WindowClosed.into());
        }
    } else if prologue::presence(archive, p, AccountKind::AnchorArchive, sid)? {
        let ad = archive.try_borrow_data()?;
        if archive_key(&ad)? != (region, part) {
            return Err(BAD_ACCOUNT);
        }
        if archive_tombstoned(&ad, arrive)? {
            return Err(FrontierError::Archived.into());
        }
    }
    // 5. the latch.
    expect_key(inputs, &wa::clash_inputs_address(&ctx, dest, arrive))?;
    if !init::is_absent(inputs) {
        return Err(FrontierError::LatchClosed.into());
    }
    let (resolved_next, dest_site, dest_land) = {
        let pd = dest_ai.try_borrow_data()?;
        let r = Ro(&pd);
        let n = r.u8(PV::SITE_COUNT)? as usize;
        let sites: [u8; PV::SITES_N] = r.arr(PV::SITES)?;
        let site = match sites.iter().take(n).position(|&t| t == plain.dest_tile) {
            Some(k) => {
                let o = PV::site(k);
                Some((
                    r.u8(o + SM::STATE)?,
                    r.u8(o + SM::FACTION)?,
                    r.u32(o + SM::SHIELD_UNTIL_BELL)?,
                ))
            }
            None => None,
        };
        (r.u32(PV::RESOLVED_NEXT)?, site, land_of(&pd, dest)?)
    };
    if resolved_next > arrive {
        return Err(FrontierError::LatchClosed.into());
    }
    // 6. the path: the destination's masks, then the supplied provinces.
    let mut lands: Vec<WideLand> = Vec::with_capacity(1 + n_path);
    lands.push(dest_land);
    for ai in path {
        let pp = canonical_province(ai, p, &ctx, sid, world)?;
        let pd = ai.try_borrow_data()?;
        lands.push(land_of(&pd, ProvinceKey::new(world, pp.coord))?);
    }
    let unit = unit_from_u8(t.unit).ok_or(BAD_ACCOUNT)?;
    let raw = walk_wide(&plain, t.origin, &lands, is_cavalry(unit))?;
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let secs = u32::try_from(doctrine.travel_secs(raw as u64)).map_err(|_| OVERFLOW)?;
    if check_arrival_bell(hdr.genesis_ts, t.depart_ts, secs, arrive).is_err() {
        return Err(FrontierError::ArrivalBell.into());
    }
    if let Some((state, owner, shield_bell)) = dest_site {
        let other = state == SM::STATE_HOLDING && owner != t.faction;
        if other && shield_bell > arrive {
            return Err(FrontierError::Shielded.into());
        }
        let (shield_until, dormant) = {
            let hd = holding.try_borrow_data()?;
            let r = Ro(&hd);
            (
                r.i64(H::SHIELD_UNTIL)?,
                r.u8(H::FLAGS)? & H::FLAG_DORMANT_CACHE != 0,
            )
        };
        let own_shielded = !dormant
            && shield_until
                > permutation_rules::frontier::beacon::bell_start(hdr.genesis_ts, arrive);
        if other && own_shielded {
            return Err(FrontierError::Shielded.into());
        }
    }
    // 7. the quota.
    let mut slots: [Option<WideSlotEntry>; 4] = [None; 4];
    let mut rents: [Option<[u8; 32]>; 4] = [None; 4];
    for (i, ai) in slots_ai.iter().enumerate() {
        expect_key(
            ai,
            &wa::arrival_slot_address(&ctx, dest, arrive, t.faction, i as u8),
        )?;
        if init::is_absent(ai) {
            continue;
        }
        if ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let sd = ai.try_borrow_data()?;
        let s = WideArrivalSlot::read(&sd).map_err(|_| BAD_ACCOUNT)?;
        if s.season_id != sid
            || s.dest != dest
            || s.bell != arrive
            || s.faction != t.faction
            || s.i != i as u8
        {
            return Err(BAD_ACCOUNT);
        }
        slots[i] = Some(WideSlotEntry {
            host: s.host,
            citizen: s.citizen,
            troops: s.dep_mass,
        });
        rents[i] = Some(s.rent_to);
    }
    let me = WideSlotEntry {
        host: t.host,
        citizen: h.owner_citizen,
        troops: t.dep_mass,
    };
    let (slot_i, displaced) = match wide_admit(dest, arrive, &slots, me) {
        WideSlotDecision::Refuse(SlotRefusal::AlreadyIn) => {
            return Err(FrontierError::AlreadyDone.into())
        }
        WideSlotDecision::Refuse(_) => return Err(FrontierError::QuotaRefused.into()),
        WideSlotDecision::Fill { slot } => (slot, None),
        WideSlotDecision::Displace { slot, displaced } => (slot, Some(displaced)),
    };
    if slot_i != x.target_i {
        return Err(FrontierError::SlotMoved.into());
    }
    let slot_ai = slots_ai[slot_i as usize];
    // 8. the ArrivalDay (the arrival evidence): at its canonical address,
    // present and this destination's and day's, or absent and writable
    // (`NeedArrivalDay`); the bell's bit is set below, the record created
    // from the fee payer when absent.
    let day = wa::day_of(arrive);
    expect_key(day_ai, &wa::arrival_day_address(&ctx, dest, day))?;
    let day_present = !init::is_absent(day_ai);
    let mut day_rec = if day_present {
        if day_ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let dd = day_ai.try_borrow_data()?;
        let rec = wa::WideArrivalDay::read(&dd).map_err(|_| BAD_ACCOUNT)?;
        if rec.season_id != sid || rec.dest != dest || rec.day != day {
            return Err(BAD_ACCOUNT);
        }
        rec
    } else {
        wa::WideArrivalDay::new(sid, dest, day, key(fee_payer))
    };
    let bit_set = day_rec.has(arrive);
    if !bit_set && !day_ai.is_writable {
        return Err(FrontierError::NeedArrivalDay.into());
    }
    // 9. the evidence.
    let ev = evidence::read(ix_sysvar, now.slot)?;
    let stance = Stance::from_u8(plain.stance).ok_or(FrontierError::BadPlaintext)?;
    let dealt = hold::bps16(doctrine.dealt_bps(Posture::Stance(stance), true))?;
    let new_slot = displaced.is_none();
    let created_day = !day_present;
    let rent_to = match rents[slot_i as usize] {
        Some(r) if !new_slot => r,
        _ => key(fee_payer),
    };
    let rec = WideArrivalSlot {
        season_id: sid,
        dest,
        bell: arrive,
        faction: t.faction,
        i: slot_i,
        transit_slot: x.transit_slot,
        host: t.host,
        citizen: h.owner_citizen,
        unit: t.unit,
        stance: plain.stance,
        tile: plain.dest_tile,
        retreat_bps: plain.retreat_bps,
        dealt_bps: dealt,
        dep_mass: t.dep_mass,
        flags: if created_day && new_slot {
            wa::wide_arrival_slot::FLAG_CREATED_DAY
        } else {
            0
        },
        beneficiary: x.beneficiary,
        rent_to,
        ev_slot: ev.slot,
        ev_price: ev.price,
        ev_limit: ev.limit,
        ev_loaded: ev.loaded,
        claimed: false,
    };
    let mut staged = alloc::vec![0u8; wa::wide_arrival_slot::SIZE];
    rec.write(&mut staged).map_err(|_| BAD_ACCOUNT)?;
    let mut day_staged = alloc::vec![0u8; wa::wide_arrival_day::SIZE];
    if !bit_set && !day_rec.set(arrive) {
        return Err(BAD_ACCOUNT);
    }
    day_rec.write(&mut day_staged).map_err(|_| BAD_ACCOUNT)?;
    let rent_day = init::rent(wa::wide_arrival_day::SIZE)?;
    let rent_slot = init::rent(wa::wide_arrival_slot::SIZE)?;
    let need = (if new_slot { rent_slot } else { 0 })
        .checked_add(if created_day { rent_day } else { 0 })
        .ok_or(OVERFLOW)?;
    if fee_payer.lamports() < need {
        return Err(FrontierError::Insufficient.into());
    }
    // ---- effects: the creations (the CPIs) first, then bytes ----
    if created_day {
        init::init_with_seed(
            fee_payer,
            day_ai,
            season_ai,
            &SeasonSigner::new(sid, hdr.bump),
            &wa::arrival_day_seed(dest, day),
            wa::wide_arrival_day::SIZE,
            rent_day,
            p,
        )?;
    }
    if !bit_set {
        let mut dd = day_ai.try_borrow_mut_data()?;
        if dd.len() != day_staged.len() {
            return Err(BAD_ACCOUNT);
        }
        dd.copy_from_slice(&day_staged);
    }
    if new_slot {
        init::init_with_seed(
            fee_payer,
            slot_ai,
            season_ai,
            &SeasonSigner::new(sid, hdr.bump),
            &wa::arrival_slot_seed(dest, arrive, t.faction, slot_i),
            wa::wide_arrival_slot::SIZE,
            rent_slot,
            p,
        )?;
    }
    {
        let mut sd = slot_ai.try_borrow_mut_data()?;
        if sd.len() != staged.len() {
            return Err(BAD_ACCOUNT);
        }
        sd.copy_from_slice(&staged);
    }
    emit_wide(
        WideKind::Revealed,
        bell_log(&hdr, now.ts),
        &wev::host_key(&t.host, dest),
        &wev::revealed_payload(
            x.transit_slot,
            t.faction,
            slot_i,
            plain.dest_tile,
            plain.stance,
            plain.retreat_bps,
            t.dep_mass,
            displaced.is_some(),
        ),
        &mut [],
    )
}

#[cfg(test)]
mod march_pure_tests {
    use super::*;
    use permutation_rules::frontier::geometry::REGIONS;

    /// The region an absent destination is settled under is the one rule
    /// candidate's (`wide_region`), a region below the count, and differs
    /// between coordinates in general (fixed literals).
    #[test]
    fn absent_destination_region_is_the_configured_rule() {
        let a = WideCoord::checked(129, 0).unwrap();
        let b = WideCoord::checked(129, -1).unwrap();
        let far = WideCoord::checked(1 << 40, -(1 << 40)).unwrap();
        for c in [a, b, far] {
            assert_eq!(absent_destination_region(c), wr::wide_region(c));
            assert!(absent_destination_region(c) < REGIONS);
        }
        assert_eq!(
            absent_destination_region(a),
            absent_destination_region(a),
            "deterministic"
        );
        assert_eq!(
            wr::RegionRule::from_byte(1),
            Ok(wr::RegionRule::SortKeyHashV1)
        );
        assert!(
            wr::RegionRule::from_byte(2).is_err(),
            "one candidate: a second one must make the settle read the configuration"
        );
    }

    /// The deployed CloseArrivalSlot's cases over fixed values: nothing
    /// closes unsettled while the rules apply; settled and claimed closes;
    /// settled and unclaimed closes only by the anchor's grace (archived =
    /// passed, not listed = not yet, present = `close + 6 bells` exactly);
    /// the season-end fallback closes anything.
    #[test]
    fn slot_close_follows_the_deployed_cases() {
        use super::AnchorClose as A;
        let close = 1_000_000i64;
        let grace = super::super::transit::CLAIM_GRACE_BELLS as i64 * 600;
        assert_eq!(grace, 3_600, "the deployed six bells");
        for anchor in [A::NotListed, A::Archived, A::At(close)] {
            for claimed in [false, true] {
                assert!(!slot_close_due(true, false, claimed, anchor, i64::MAX));
                assert!(slot_close_due(false, false, claimed, anchor, i64::MIN));
            }
            assert!(slot_close_due(true, true, true, anchor, i64::MIN));
        }
        assert!(!slot_close_due(true, true, false, A::NotListed, i64::MAX));
        assert!(slot_close_due(true, true, false, A::Archived, i64::MIN));
        assert!(!slot_close_due(
            true,
            true,
            false,
            A::At(close),
            close + grace - 1
        ));
        assert!(slot_close_due(
            true,
            true,
            false,
            A::At(close),
            close + grace
        ));
        assert!(
            slot_close_due(true, true, false, A::At(i64::MAX), i64::MAX),
            "saturating"
        );
    }

    /// The deployed CloseArrivalDay's case: day `d` closes at
    /// `resolved_next ≥ (d + 1) × 144`, one bell short does not.
    #[test]
    fn day_close_needs_every_bell_of_the_day_resolved() {
        let bells = wa::wide_arrival_day::BELLS;
        assert_eq!(bells, 144);
        for day in [0u32, 1, 7, u32::MAX / bells - 1] {
            let need = (day as u64 + 1) * bells as u64;
            assert!(!day_close_due(day, 0));
            assert!(!day_close_due(day, (need - 1) as u32));
            assert!(day_close_due(day, need as u32));
            assert!(day_close_due(day, u32::MAX));
        }
        assert!(!day_close_due(u32::MAX, u32::MAX), "no wrap");
    }

    /// The deployed CloseClashInputs' cases over a wide header: a resolved
    /// record with a present, unsettled position is open; settled, it waits
    /// `resolved_ts + grace` from genesis; a no-arrival record waits for the
    /// bell to be passed by the province and its end plus the grace; a
    /// record neither resolved nor no-arrivals is open; overflow is the
    /// arithmetic error, not a close.
    #[test]
    fn inputs_close_follows_the_deployed_cases() {
        let world = WorldId::new([7; 32]).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let mut h = WideClashInputsHdr::new(1, dest, 20, [9; 32]);
        assert!(
            !inputs_close_due(&h, 0, u32::MAX, 0, i64::MAX).unwrap(),
            "neither resolved nor no-arrivals: open"
        );
        h.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
        h.resolved_ts = 12_000;
        h.settled_mask = 0b01;
        assert!(!inputs_close_due(&h, 0b11, 0, 600, 100_000).unwrap());
        assert!(!inputs_close_due(&h, 0b01, 0, 600, 12_599).unwrap());
        assert!(inputs_close_due(&h, 0b01, 0, 600, 12_600).unwrap());
        assert!(inputs_close_due(&h, 0, 0, 600, 12_600).unwrap());
        assert!(
            inputs_close_due(&h, 0b01, 0, i64::MAX, 0).is_err(),
            "overflow is refused, never a close"
        );
        let mut n = WideClashInputsHdr::new(1, dest, 20, [9; 32]);
        n.flags = wa::wide_clash_inputs::FLAG_NO_ARRIVALS;
        assert!(
            !inputs_close_due(&n, 0, 20, 600, i64::MAX).unwrap(),
            "bell not passed"
        );
        assert!(!inputs_close_due(&n, 0, 21, 600, 21 * 600 + 599).unwrap());
        assert!(inputs_close_due(&n, 0, 21, 600, 21 * 600 + 600).unwrap());
        assert!(
            inputs_close_due(&n, 0, 21, i64::MAX, i64::MAX).is_err(),
            "overflow is refused, never a close"
        );
    }
}

// ------------------------------------------------------------ the settlement

// The pure settlement — the outcome against the resolved final set and
// the post-judgement payment plan — is the shared ABI module
// `frontier_abi::world_index::settle`, called by this handler and by the
// keeper's planner alike (one table, no copy). The names keep their old
// paths here; `plan_settlement` keeps its `R` signature.
pub(crate) use frontier_abi::world_index::settle::{
    wide_admit, wide_valid_outcome, PayTo, SettlementPlan, WideOutcome, WideSlotDecision,
    WideSlotEntry,
};

/// [`frontier_abi::world_index::settle::plan_settlement`] with the
/// program's `Overflow` for an escrow sum that does not fit.
pub(crate) fn plan_settlement(
    outcome: WideOutcome,
    t: &WideTransit,
    rec: Option<&WideArrival>,
    fee: u64,
    bond: u64,
    own_slot: bool,
) -> R<SettlementPlan> {
    frontier_abi::world_index::settle::plan_settlement(outcome, t, rec, fee, bond, own_slot)
        .ok_or(OVERFLOW)
}

/// Pays `amount` of the holding's lamports to `to` (`pay_or_divert`, sink
/// `pool_owed`); a recipient owned by this program is never credited
/// directly. Returns the lamports added to `pool_owed`.
fn pay_wide<'a>(
    p: &Pubkey,
    holding: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    amount: u64,
    reason: u8,
    bell: u32,
) -> R<u64> {
    if amount == 0 {
        return Ok(0);
    }
    if to.owner == p {
        return owe_wide(holding, to.key.as_ref(), amount, reason, bell);
    }
    match init::pay_or_divert(
        p,
        holding,
        to,
        amount,
        &Sink::PoolOwed(holding),
        reason,
        bell,
    )? {
        Paid::Recipient => Ok(0),
        Paid::Diverted => Ok(amount),
    }
}

/// Keeps `amount` in the holding as `pool_owed`; the deployed `DIVERT`
/// names the intended recipient when there was one (a deployed record on
/// a wallet key, as `pay_or_divert` logs).
fn owe_wide(holding: &AccountInfo, recipient: &[u8], amount: u64, reason: u8, bell: u32) -> R<u64> {
    if amount == 0 {
        return Ok(0);
    }
    {
        let mut d = holding.try_borrow_mut_data()?;
        Rw(&mut d).add_u64(H::POOL_OWED, amount)?;
    }
    if recipient != holding.key.as_ref() {
        let payload = Buf::<9>::new().u64(amount).u8(reason);
        events::emit(Kind::DIVERT, bell, recipient, payload.get()?, &mut [])?;
    }
    Ok(amount)
}

/// The staged home re-entry of a returning host (the deployed
/// `return_home` over the wide records): a muster-pending entry (state 2,
/// `from_bell = now_bell + 1`, `ready_bell = max(depart + ready_off,
/// from)`, the doctrine's `dealt` at Hold) at the first free index when
/// the caps allow (48 over states 1–2, 8 per faction) **and** the home
/// roster is present, its reference claimed there under the host's alias;
/// else `reserve[unit] += troops / 1,000` (the deployed fallback, also
/// taken when the home province has no roster yet). Returns the entry
/// index, or `None` for the reserve.
#[allow(clippy::too_many_arguments)]
fn stage_return_home(
    pd: &mut [u8],
    roster: Option<(&WideRoster, &mut [u8])>,
    reserve_unit: &mut u32,
    t: &WideTransit,
    troops: u32,
    stamina: u16,
    stamina_bell: u32,
    tile: u8,
    now_bell: u32,
) -> R<Option<u8>> {
    let unit = unit_from_u8(t.unit).ok_or(BAD_ACCOUNT)?;
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let dealt = hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Hold), false))?;
    let from = now_bell.checked_add(1).ok_or(OVERFLOW)?;
    let ready = t
        .depart_bell
        .checked_add(t.ready_bell_off as u32)
        .ok_or(OVERFLOW)?
        .max(from);
    let slot = if roster.is_some() {
        let r = Ro(pd);
        let (mut total, mut own, mut free) = (0usize, 0usize, None);
        for i in 0..PV::ENTRIES_N {
            let o = PV::entry(i);
            match r.u8(o + E::STATE)? {
                E::STATE_FREE => {
                    if free.is_none() {
                        free = Some(i);
                    }
                }
                E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                    total += 1;
                    if r.u8(o + E::FACTION)? == t.faction {
                        own += 1;
                    }
                }
                _ => {}
            }
        }
        if total >= PV::ROSTER_CAP || own >= PV::FACTION_CAP {
            None
        } else {
            free
        }
    } else {
        None
    };
    match (slot, roster) {
        (Some(i), Some((roster, rd))) => {
            let alias = wide_host_alias(&t.host);
            if roster.claim(rd, i, &t.host).map_err(|_| BAD_ACCOUNT)? != alias {
                return Err(BAD_ACCOUNT);
            }
            let host = Host {
                id: alias,
                owner: alias,
                faction: t.faction,
                unit,
                troops,
                stamina: Stamina {
                    value: stamina,
                    bell: stamina_bell,
                },
                ready_bell: ready,
                pending: None,
            };
            let e = Entry::from_host(&host, tile, E::STATE_MUSTER_PENDING, dealt, from);
            write_entry(pd, i, &e).map_err(|_| BAD_ACCOUNT)?;
            let mut w = Rw(pd);
            let n = w.u8(PV::N_ENTRIES)?.saturating_add(1);
            w.set_u8(PV::N_ENTRIES, n)?;
            let ep = w.u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
            w.set_u32(PV::ROSTER_EPOCH, ep)?;
            Ok(Some(i as u8))
        }
        _ => {
            let whole = troops / MILLI as u32;
            *reserve_unit = reserve_unit.checked_add(whole).ok_or(OVERFLOW)?;
            Ok(None)
        }
    }
}

/// The deployed claim eligibility (I-52) over a wide slot: THE anchor
/// present, the slot unclaimed, the claim grace running, the reveal late
/// by the Season's lateness and a defence refund above zero. A settle
/// keeps such a slot open, as deployed, for WideClaimDefence. Claiming marks
/// the evidence consumed; the separately gated close path retains the
/// immutable rent recipient.
pub(crate) fn wide_claim_eligible(
    s: &WideArrivalSlot,
    anchor_slot: Option<u64>,
    lateness: u8,
    params: &DefenceParams,
    now: i64,
    close: i64,
) -> R<bool> {
    let Some(anchor_slot) = anchor_slot else {
        return Ok(false);
    };
    if s.claimed {
        return Ok(false);
    }
    let grace_end = close
        .checked_add(super::transit::CLAIM_GRACE_BELLS as i64 * 600)
        .ok_or(OVERFLOW)?;
    if now >= grace_end {
        return Ok(false);
    }
    if s.ev_slot.saturating_sub(anchor_slot) < lateness as u64 {
        return Ok(false);
    }
    Ok(super::defence::refund(&s.evidence(), params) > 0)
}

/// Every retained own slot records settlement, including evidence kept for a
/// defence claim. This is the deployed transit handler's retained-slot rule:
/// it permits a later claim then CloseArrivalSlot without a second transit.
pub(crate) fn retained_slot_after_settle(mut s: WideArrivalSlot) -> WideArrivalSlot {
    s.flags |= wa::wide_arrival_slot::FLAG_SETTLED;
    s
}

/// WideSettleTransit (0xDC, op 5): `[payer s,w] [season r] [holding w]
/// [dest_province w] [inputs w] [slot w] [home_province w] [anchor|archive
/// r] [slot_beneficiary w] [resolver w] [holding_rent_payer w]
/// [settle_beneficiary w] [transit w] [home_roster w] [system] [dest_roster
/// w] [transit_rent_to w]` then the optional `[citizen w]`
/// (`wide_ix::SETTLE_TRANSIT`), class D, permissionless. The deployed
/// SettleTransit over the wide records, in its order:
///
/// 1. the holding canonical and present, its wide transit record of
///    `transit_slot` present (`TransitState`), the host's holding's, at the
///    holding's generation (a previous generation is `NotImplemented`: no
///    wide capture exists), in state 2, 3 or gathered
///    (`DepartureUnsettled` in state 1); the capture lock when the home
///    province is present;
/// 2. the destination: present → a wide province of this world at its
///    canonical address, THE anchor or archive entry of `(arrive, its
///    stored region)`; absent → the anchor or archive of the bell for the
///    region it names, which must be the region the sealed destination
///    would have ([`absent_destination_region`], checked once the seal is
///    opened: `BadAddress` otherwise), so a valid seal to a province never
///    opened settles as routed, as deployed, under that region's close;
///    `now ≥ close + 600` and `dest.resolved_next > arrive` (`TooEarly`);
/// 3. `wide_seal_root(commit, seal) == record.seal_root`
///    (`CommitMismatch`);
/// 4. **the proof**: the anchor's round signature decompressed by the
///    chain's BLS syscall — a failure there is the instruction error
///    `Crypto(BAD_POINT)`, not a seal verdict (the signature is the
///    chain's, not the seal's; the host build's stub fails closed here, so
///    no host-run settle reaches the opener); then
///    `crypto::seal::judge_wide` (the key recovery, the body under the wide
///    commitment, `world_index::seal::validate` against the record's host
///    and bell), in which a failure of the seal's own points or FO check
///    **is** a verdict (codes 1, 2), as deployed: the seal code and, for code 0, the plaintext, whose
///    destination must be the supplied province (`BadAddress`); a bad seal
///    needs a present destination (`BadAccount`); a gathered record settles
///    only against the province that gathered it (`BadAddress`);
/// 5. `settle_beneficiary == beneficiary`, `holding_rent_payer ==
///    holding.rent_payer` (`BadAddress`); the wide ClashInputs of `(dest,
///    arrive)` count when present and resolved; the host's slot `(dest,
///    arrive, faction, i)` with `i` its position in the resolved set or 0.
///
/// The outcome ([`wide_valid_outcome`]) and the plan ([`plan_settlement`])
/// are pure; the camp's loot (the lowest position of `camp_mask` that
/// stays) needs the owner Citizen (`BadAccount` without it). Effects, the
/// deterministic staging first: the escrow decremented, the payments
/// through `pay_or_divert` with sink `pool_owed` (recipients checked only
/// when paid); the host: a bad seal's Stays/Withdrew entry at the
/// destination forfeited at `now_bell` (paired through the destination's
/// roster), a staying host logged, a returning host re-entered at home
/// ([`stage_return_home`]: the home province present, its roster paired
/// or absent); the settled bit of its final-set position; its own slot
/// retained and flagged settled when claim-eligible ([`wide_claim_eligible`],
/// for WideClaimDefence followed by WideClose(2), else closed whole to
/// its `rent_to` when that is a listed wallet (payer, slot beneficiary,
/// resolver, rent payer, settle beneficiary, transit rent recipient), else
/// flagged settled; the transit record closed whole to its immutable
/// `rent_to`; the camp's Works. Records: the
/// `WIDE_TRANSIT_SETTLED` keyed by the host and the destination (the home
/// when the destination is absent), chained to that province and the
/// holding; then, for a host that came home, the `WIDE_RETURN` keyed by the
/// host and the home, chained to the home and the holding (entry `0xFF`
/// for the reserve).
pub fn settle_transit(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleTransit) -> R<()> {
    use wa::wide_arrival as AR;
    let n_cit = a
        .len()
        .checked_sub(wix::SETTLE_TRANSIT_FIXED)
        .ok_or(FrontierError::TooManyAccounts)?;
    if n_cit > 1 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    check_accounts(Shape(wix::SETTLE_TRANSIT), a, Some(&[1, n_cit as u8]))?;
    let [payer, season_ai, holding, dest_ai, inputs, slot, home_ai, anchor, slot_ben, resolver, rent_payer, settle_ben, transit_ai, home_roster, _system, dest_roster, transit_rent_to, tail @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let camp_citizen_ai = tail.first();
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let (clock, march_fee, seal_bond, lateness, defence) = {
        let sd = season_ai.try_borrow_data()?;
        let r = Ro(&sd);
        let tip_min = fees::min_tip_lamports(
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            r.u32(S::REVEAL_CU_LIMIT)?,
            r.u32(S::REVEAL_LOADED_LIMIT)?,
        );
        (
            SeasonClock::read(&sd)?,
            r.u64(S::MARCH_FEE)?,
            r.u64(S::SEAL_BOND)?,
            r.u8(S::LATENESS_SLOTS)?,
            DefenceParams {
                defence_cap_milli: r.u32(S::DEFENCE_CAP_MILLI)?,
                tip_min,
            },
        )
    };
    // 1. the holding and its transit record.
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    let hkey = key(holding);
    let home_key = ProvinceKey::new(world, h.coord);
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let t = transit_at(transit_ai, p, &ctx, &hkey, x.transit_slot)?
        .ok_or(FrontierError::TransitState)?;
    if t.host.key() != home_key || t.host.site() != h.site {
        return Err(BAD_ACCOUNT);
    }
    if t.host.gen() != h.gen {
        return Err(FrontierError::NotImplemented.into());
    }
    match t.state {
        MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered => {}
        MarchState::Departed => return Err(FrontierError::DepartureUnsettled.into()),
        MarchState::Free => return Err(FrontierError::TransitState.into()),
    }
    let (holding_rent_payer, tile) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.arr::<32>(H::RENT_PAYER)?, r.u8(H::TILE)?)
    };
    expect_key(home_ai, &wl::province_address(&ctx, h.coord))?;
    let home_present = !init::is_absent(home_ai);
    if home_present {
        let hp = province_at(home_ai, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
        if hp.world != world || hp.coord != h.coord {
            return Err(BAD_ACCOUNT);
        }
        let pd = home_ai.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    let arrive = t.arrive_bell;
    // 2. timing.
    let dest_present = !init::is_absent(dest_ai);
    let mut anchor_region: Option<u8> = None;
    let (dest_known, dest_rn, src): (Option<ProvinceKey>, Option<u32>, AnchorSource) =
        if dest_present {
            let dp = province_at(dest_ai, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
            if dp.world != world {
                return Err(BAD_ACCOUNT);
            }
            expect_key(dest_ai, &wl::province_address(&ctx, dp.coord))?;
            let rn = {
                let pd = dest_ai.try_borrow_data()?;
                Ro(&pd).u32(PV::RESOLVED_NEXT)?
            };
            let src = the_anchor_or_archive(p, &ctx, hdr.id, anchor, arrive, dp.region, &clock)?;
            (Some(ProvinceKey::new(world, dp.coord)), Some(rn), src)
        } else {
            // The region is known only once the seal is opened; the anchor
            // names its own and is held to the plaintext's below.
            let (src, region) = anchor_of_any_region(p, &ctx, hdr.id, anchor, arrive, &clock)?;
            anchor_region = Some(region);
            (None, None, src)
        };
    let close = clock.reveal_close(arrive, src.a);
    let settle_at = close
        .checked_add(super::transit::SETTLE_AFTER_CLOSE_SECS)
        .ok_or(OVERFLOW)?;
    if now.ts < settle_at || dest_rn.is_some_and(|rn| rn <= arrive) {
        return Err(FrontierError::TooEarly.into());
    }
    // 3. the logged pair is the committed one.
    if cseal::wide_seal_root_of(&x.commit, &x.seal) != t.seal_root {
        return Err(FrontierError::CommitMismatch.into());
    }
    // 4. the proof. THE anchor's signature is the chain's: its
    // decompression failing is an instruction error, not a verdict (the
    // host build's stub fails here). The opener below judges the seal's
    // own points, where a failure is a seal code, as deployed.
    let s_aff = sys::bls_g1_decompress(&src.sig48)
        .map_err(|_| crypto(crate::error::crypto_sub::BAD_POINT))?;
    let (code, plain) = cseal::judge_wide(&s_aff, &x.seal, &x.commit, &t.host, arrive);
    let dkey = match (plain, dest_known) {
        (Some(pl), Some(k)) => {
            if pl.dest != k {
                return Err(FrontierError::BadAddress.into());
            }
            k
        }
        (Some(pl), None) => {
            if pl.dest.world() != world {
                return Err(FrontierError::BadAddress.into());
            }
            expect_key(dest_ai, &wl::province_address(&ctx, pl.dest.coord()))?;
            // The anchor must be the one of the region the sealed
            // destination would have (v1.7's `region_of(dest) == region`
            // over the wide region rule): its `A` timed the close above.
            if anchor_region != Some(absent_destination_region(pl.dest.coord())) {
                return Err(FrontierError::BadAddress.into());
            }
            pl.dest
        }
        // A bad seal is settled against a present province (v1.7).
        (None, None) => return Err(BAD_ACCOUNT),
        (None, Some(k)) => k,
    };
    if let Some(g) = t.dest {
        if g != dkey {
            return Err(FrontierError::BadAddress.into());
        }
    }
    // 5. the beneficiary, the final set and the slot.
    expect_key(settle_ben, &x.beneficiary)?;
    expect_key(rent_payer, &holding_rent_payer)?;
    expect_key(inputs, &wa::clash_inputs_address(&ctx, dkey, arrive))?;
    let (set, resolver_key, camp_mask): (Option<[Option<WideArrival>; 4]>, [u8; 32], u32) =
        if !init::is_absent(inputs) {
            if inputs.owner != p {
                return Err(BAD_ACCOUNT);
            }
            let cd = inputs.try_borrow_data()?;
            let ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
            if ih.season_id != hdr.id || ih.dest != dkey || ih.bell != arrive {
                return Err(BAD_ACCOUNT);
            }
            if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
                let base = wa::wide_clash_inputs::position(t.faction, 0);
                let mut s: [Option<WideArrival>; 4] = [None; 4];
                for (i, slot_rec) in s.iter_mut().enumerate() {
                    *slot_rec = WideArrival::read_at(&cd, base + i).map_err(|_| BAD_ACCOUNT)?;
                }
                (Some(s), ih.resolver, ih.camp_mask)
            } else {
                (None, [0; 32], 0)
            }
        } else {
            (None, [0; 32], 0)
        };
    let position = set.as_ref().and_then(|s| {
        s.iter()
            .position(|a| a.is_some_and(|a| a.present && a.host == t.host))
    });
    let slot_i = position.unwrap_or(0) as u8;
    expect_key(
        slot,
        &wa::arrival_slot_address(&ctx, dkey, arrive, t.faction, slot_i),
    )?;
    let own_slot: Option<WideArrivalSlot> = if !init::is_absent(slot) {
        if slot.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let sd = slot.try_borrow_data()?;
        let s = WideArrivalSlot::read(&sd).map_err(|_| BAD_ACCOUNT)?;
        if s.season_id != hdr.id
            || s.dest != dkey
            || s.bell != arrive
            || s.faction != t.faction
            || s.i != slot_i
        {
            return Err(BAD_ACCOUNT);
        }
        (s.host == t.host).then_some(s)
    } else {
        None
    };
    let rec = position.and_then(|k| set.as_ref().and_then(|s| s[k]));
    let outcome = if code != seal_code::VALID {
        WideOutcome::BadSeal {
            code,
            fate: rec.map(|r| r.fate),
        }
    } else {
        wide_valid_outcome(
            dkey,
            arrive,
            WideSlotEntry {
                host: t.host,
                citizen: h.owner_citizen,
                troops: t.dep_mass,
            },
            set.as_ref(),
        )
    };
    if let WideOutcome::Fate(f) = outcome {
        if !(AR::FATE_STAYS..=AR::FATE_DESTROYED).contains(&f) {
            return Err(BAD_ACCOUNT);
        }
    }
    // The camp's loot (I-56): the lowest position of `camp_mask` that stays.
    let camp_works = match (outcome, position) {
        (WideOutcome::Fate(AR::FATE_STAYS), Some(k)) => {
            camp_mask != 0
                && camp_mask.trailing_zeros() as usize
                    == wa::wide_clash_inputs::position(t.faction, k as u8)
        }
        _ => false,
    };
    let camp_citizen = if camp_works {
        let c = camp_citizen_ai.ok_or(BAD_ACCOUNT)?;
        expect_key(c, &h.owner_citizen)?;
        prologue::present(c, p, AccountKind::Citizen, hdr.id)?;
        Some(c)
    } else {
        None
    };
    // The plan.
    let fee = if t.flags & T::FLAG_FEE_ESCROWED != 0 {
        march_fee
    } else {
        0
    };
    let bond = if t.flags & T::FLAG_BOND_ESCROWED != 0 {
        seal_bond
    } else {
        0
    };
    let plan = plan_settlement(outcome, &t, rec.as_ref(), fee, bond, own_slot.is_some())?;
    // The recipients a payment names are checked before any effect.
    let pays = [
        (plan.tip, divert_reason::TIP),
        (plan.fee, divert_reason::MARCH_FEE),
        (plan.bond, divert_reason::BOND),
        (plan.reward, divert_reason::REWARD),
    ];
    for ((amount, to), _) in pays {
        if amount == 0 {
            continue;
        }
        match to {
            PayTo::SlotBeneficiary => {
                let ben = own_slot.map(|s| s.beneficiary).ok_or(BAD_ACCOUNT)?;
                expect_key(slot_ben, &ben)?;
            }
            PayTo::Resolver => expect_key(resolver, &resolver_key)?,
            PayTo::RentPayer | PayTo::SettleBeneficiary | PayTo::PoolOwed => {}
        }
    }
    {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        r.u64(H::ESCROW)?
            .checked_sub(plan.total)
            .ok_or(BAD_ACCOUNT)?;
        r.u8(wh::wide_holding::OPEN_TRANSITS)?
            .checked_sub(1)
            .ok_or(BAD_ACCOUNT)?;
    }
    expect_key(transit_rent_to, &t.rent_to)?;
    // The host, staged: the forfeit at the destination, or the home
    // re-entry.
    let mut troops_logged = 0u32;
    let mut dest_stage: Option<Vec<u8>> = None;
    type HomeStage = (
        Vec<u8>,
        Option<(WideRoster, Vec<u8>)>,
        [u32; H::RESERVE_N],
        Option<u8>,
        u32,
    );
    let mut home_stage: Option<HomeStage> = None;
    if plan.forfeit {
        expect_key(dest_roster, &wro::roster_address(&ctx, dkey))?;
        if let Some(roster) = roster_at(dest_roster, p, hdr.id, dkey)? {
            let mut pd_s = dest_ai.try_borrow_data()?.to_vec();
            let rd = dest_roster.try_borrow_data()?;
            roster
                .validate_paired(&rd, &wres::live_ids(&pd_s).map_err(resolve_err)?)
                .map_err(|_| BAD_ACCOUNT)?;
            if let Some((i, mut e)) = host_entry(&pd_s, &roster, &rd, &t.host)? {
                if e.state == E::STATE_ROSTER && !e.busy() {
                    e.op = EntryOp::Forfeit;
                    e.pend_bell = now_bell;
                    write_entry(&mut pd_s, i, &e).map_err(|_| BAD_ACCOUNT)?;
                    let mut w = Rw(&mut pd_s);
                    let ep = w.u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
                    w.set_u32(PV::ROSTER_EPOCH, ep)?;
                    dest_stage = Some(pd_s);
                }
            }
        }
    } else if plan.stays {
        troops_logged = rec.map_or(0, |r| r.troops_after);
    } else if let Some((troops, stamina, routed)) = plan.returns {
        let stamina_bell = if routed {
            now_bell
        } else if rec.is_some() {
            arrive
        } else {
            effective_bell(t.depart_bell)
        };
        troops_logged = troops;
        if !home_present {
            return Err(BAD_ACCOUNT);
        }
        expect_key(home_roster, &wro::roster_address(&ctx, home_key))?;
        let mut pd_s = home_ai.try_borrow_data()?.to_vec();
        let mut roster_s = match roster_at(home_roster, p, hdr.id, home_key)? {
            Some(r) => {
                let rd = home_roster.try_borrow_data()?.to_vec();
                r.validate_paired(&rd, &wres::live_ids(&pd_s).map_err(resolve_err)?)
                    .map_err(|_| BAD_ACCOUNT)?;
                Some((r, rd))
            }
            None => None,
        };
        let mut reserve = [0u32; H::RESERVE_N];
        {
            let hd = holding.try_borrow_data()?;
            let r = Ro(&hd);
            for (u, v) in reserve.iter_mut().enumerate() {
                *v = r.u32(H::reserve(u))?;
            }
        }
        let unit_i = t.unit as usize;
        let mut reserve_unit = *reserve.get(unit_i).ok_or(BAD_ACCOUNT)?;
        let entry = stage_return_home(
            &mut pd_s,
            roster_s.as_mut().map(|(r, rd)| (&*r, &mut rd[..])),
            &mut reserve_unit,
            &t,
            troops,
            stamina,
            stamina_bell,
            tile,
            now_bell,
        )?;
        let credited = if entry.is_some() {
            troops
        } else {
            (troops / MILLI as u32).saturating_mul(MILLI as u32)
        };
        reserve[unit_i] = reserve_unit;
        home_stage = Some((pd_s, roster_s, reserve, entry, credited));
    }
    // The slot: retained for a claim, else closed to a listed rent recipient.
    // Every retained slot is flagged settled, as in the deployed handler.
    let keep = match &own_slot {
        Some(s) => wide_claim_eligible(s, src.anchor_slot, lateness, &defence, now.ts, close)?,
        None => false,
    };
    let slot_close: Option<&AccountInfo> = match own_slot {
        Some(s) if !keep => [
            payer,
            slot_ben,
            resolver,
            rent_payer,
            settle_ben,
            transit_rent_to,
        ]
        .into_iter()
        .find(|ai| ai.key.as_array() == &s.rent_to),
        _ => None,
    };
    // ---- effects ----
    {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        let esc = w
            .u64(H::ESCROW)?
            .checked_sub(plan.total)
            .ok_or(BAD_ACCOUNT)?;
        w.set_u64(H::ESCROW, esc)?;
    }
    let mut pool = 0u64;
    let mut paid = [0u64; 3];
    for (n, ((amount, to), reason)) in pays.into_iter().enumerate() {
        if amount == 0 {
            continue;
        }
        pool += match to {
            PayTo::PoolOwed => owe_wide(holding, &hkey, amount, reason, now_bell)?,
            PayTo::SlotBeneficiary => pay_wide(p, holding, slot_ben, amount, reason, now_bell)?,
            PayTo::RentPayer => pay_wide(p, holding, rent_payer, amount, reason, now_bell)?,
            PayTo::Resolver => pay_wide(p, holding, resolver, amount, reason, now_bell)?,
            PayTo::SettleBeneficiary => pay_wide(p, holding, settle_ben, amount, reason, now_bell)?,
        };
        if n < 3 {
            paid[n] = amount;
        }
    }
    let _ = pool;
    if let Some(pd_s) = &dest_stage {
        let mut pd = dest_ai.try_borrow_mut_data()?;
        pd.copy_from_slice(pd_s);
    }
    if let Some((pd_s, roster_s, reserve, _, _)) = &home_stage {
        {
            let mut pd = home_ai.try_borrow_mut_data()?;
            pd.copy_from_slice(pd_s);
        }
        if let Some((_, rd_s)) = roster_s {
            let mut rd = home_roster.try_borrow_mut_data()?;
            rd.copy_from_slice(rd_s);
        }
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        for (u, v) in reserve.iter().enumerate() {
            w.set_u32(H::reserve(u), *v)?;
        }
    }
    if let Some(k) = position {
        let mut cd = inputs.try_borrow_mut_data()?;
        let mut ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
        ih.settled_mask |= 1u32 << wa::wide_clash_inputs::position(t.faction, k as u8);
        ih.write(&mut cd).map_err(|_| BAD_ACCOUNT)?;
    }
    if let Some(s) = own_slot {
        match (keep, slot_close) {
            (false, Some(to_ai)) => {
                init::close_to(p, slot, to_ai, &Sink::Never, now_bell)?;
            }
            (true, _) | (false, None) => {
                let mut sd = slot.try_borrow_mut_data()?;
                let s2 = retained_slot_after_settle(s);
                s2.write(&mut sd).map_err(|_| BAD_ACCOUNT)?;
            }
        }
    }
    // The transit record is gone: whole to its immutable rent recipient;
    // the holding's open count down by one.
    init::close_to(p, transit_ai, transit_rent_to, &Sink::Never, now_bell)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        let open = w
            .u8(wh::wide_holding::OPEN_TRANSITS)?
            .checked_sub(1)
            .ok_or(BAD_ACCOUNT)?;
        w.set_u8(wh::wide_holding::OPEN_TRANSITS, open)?;
    }
    if let Some(c) = camp_citizen {
        let mut cd = c.try_borrow_mut_data()?;
        Rw(&mut cd).add_u64(C::WORKS, permutation_rules::frontier::camp::loot() as u64)?;
    }
    // The records: the settlement at its destination (the home when the
    // destination is absent), then the home re-entry.
    let bell = now_bell;
    let home_credited = home_stage.is_some();
    {
        let (attrib, prov_ai) = if dest_present {
            (dkey, dest_ai)
        } else {
            if !home_present {
                return Err(BAD_ACCOUNT);
            }
            (home_key, home_ai)
        };
        let mut pd = prov_ai.try_borrow_mut_data()?;
        let mut hd = holding.try_borrow_mut_data()?;
        emit_wide(
            WideKind::TransitSettled,
            bell,
            &wev::host_key(&t.host, attrib),
            &wev::transit_settled_payload(
                x.transit_slot,
                outcome.code(),
                code,
                troops_logged,
                paid[0],
                paid[1],
                paid[2],
                home_credited,
                dkey,
            ),
            &mut [
                (WideEntity::Province, &mut pd[..]),
                (WideEntity::Holding, &mut hd[..]),
            ],
        )?;
    }
    if let Some((_, _, _, entry, credited)) = home_stage {
        let mut pd = home_ai.try_borrow_mut_data()?;
        let mut hd = holding.try_borrow_mut_data()?;
        emit_wide(
            WideKind::Return,
            bell,
            &wev::host_key(&t.host, home_key),
            &wev::return_payload(credited, t.unit, entry.unwrap_or(wev::RETURN_TO_RESERVE)),
            &mut [
                (WideEntity::Province, &mut pd[..]),
                (WideEntity::Holding, &mut hd[..]),
            ],
        )?;
    }
    Ok(())
}

#[path = "wide_stranded_exec.rs"]
mod stranded_exec;

#[path = "wide_expedition_close.rs"]
mod expedition_close;

#[cfg(all(test, feature = "public-proof-tests", not(target_os = "solana")))]
#[path = "wide_public_proof_config_tests.rs"]
mod public_proof_config_tests;

#[cfg(test)]
mod wide_capture_guard_tests {
    use super::*;
    use frontier_abi::world_index::conquest as wc;

    #[test]
    fn close_and_wide_ticket_guard_refuses_active_or_orphaned_capture_markers() {
        let mut cd = alloc::vec![0xa5; C2::SIZE];
        cd[C2::SLOTS] = 0;
        assert!(refuse_wide_capture(&cd).is_ok());
        cd[C2::SLOTS] = 2 | C2::SLOTS_RESERVED_3;
        assert!(refuse_wide_capture(&cd).is_ok());
        cd[C2::SLOTS] |= wc::wide_reserved_bit(3);
        let before = cd.clone();
        assert!(refuse_wide_capture(&cd).is_err());
        assert_eq!(cd, before);
        cd[C2::SLOTS] = wc::wide_reserved_bit(2);
        assert!(refuse_wide_capture(&cd).is_err());
        assert!(refuse_wide_capture(&[]).is_err());
    }
}
