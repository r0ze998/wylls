//! **Experimental** (`wide-world-experimental`): the handlers of the wide
//! land write path, dispatched on the provisional band
//! `frontier_abi::world_index::wide_ix` (0xD6–0xDE). Not in any default
//! build, never an SBF binary (`lib.rs` refuses the feature on the Solana
//! target); a build with this feature carries the `0x4000` program-version
//! bit, so its Seasons never mix with production Seasons, and every
//! handler refuses a Season of another version (`RulesetMismatch`).
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
//! | 0xDD | [`resident_act`] | WideClaimSite or WideDepart for an NFT resident's Citizen under the deployed resident check (current Core owner or session, the signed holder generation) |
//! | 0xDA | [`depart`] | runs the deployed Depart's checks in the deployed shape (the issuing holding's own province and the **standing** province the host's roster is in, as distinct accounts): the holding canonical and the caller's at the reference's generation, its province's capture lock, the standing province a wide province of this world (a deployed Province there is the legacy/wide boundary: `NotImplemented` before any debit), final, resident, the seal's syntax; then the **identity gate** (`NotImplemented`: no wide holding carries an allocated host identity, so no host of it can stand in any roster) and the roster lookup by the alias; nothing is debited and no transit record is written. The stages after Depart (SettleDeparture, Reveal, Gather, Resolve, SettleTransit, the return) have no wide form: see `WIDE-LAND-WRITER.md` §−2 |
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
//! lifecycle (Muster, Resolve, Dissolve, Return, the roster close) logs
//! the **wide format** of `world_index::event` (`PSW1`, version 0x81, its
//! own kinds, full-identity keys, a domain-separated chain over the wide
//! accounts' headers), which a deployed reader refuses as an unknown
//! version and never misreads. The deployed records a wide handler emits
//! are deployed ones on deployed
//! accounts: the anchor's `HARVEST` for the settler cost, and a
//! displacement's `DIVERT` when the refund would leave its recipient
//! below rent exemption. Readers see the anchor's stores, the fund's and
//! the JoinShard's counters move and nothing of the wide land itself.
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

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::conquest_model::{write_keep, write_no_keep, StepParams};
use frontier_abi::entry::{find_entry, read_entry, write_entry, Entry, EntryOp};
use frontier_abi::layout::AccountKind;
use frontier_abi::log::{divert_reason, settle_outcome, Kind};
use frontier_abi::prologue as ap;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::event::{self as wev, WideEntity, WideKind, WideLink};
use frontier_abi::world_index::holding::{self as wh, HoldingError, SlotBinding, WideHolding};
use frontier_abi::world_index::land::{
    self as wl, Decision, LandError, PreviousRing, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING,
};
use frontier_abi::world_index::march::{wide_host_alias, MarchError, WideTransit};
use frontier_abi::world_index::resolve::{self as wres, ResolveError};
use frontier_abi::world_index::roster::{self as wro, WideRoster};
use frontier_abi::world_index::rules::{self as wr, OpeningInput, RulesError, WideRulesConfig};
use frontier_abi::world_index::ticket::{
    self as wt, CitizenTicket, TicketError, TicketStatus, WideTicket,
};
use frontier_abi::world_index::tiles::TileAddress;
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use permutation_rules::fixed::{MilliTroops, MILLI};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::clash::{frontier_ruleset, NEUTRAL};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::fees;
use permutation_rules::frontier::geometry::{R_MAX_HARD, SITES_PER_PROVINCE};
use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck, Tier};
use permutation_rules::frontier::host::Host;
use permutation_rules::frontier::seal as ks;
use permutation_rules::frontier::siege;
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::wide::generate_province_wide;

use crate::addr::{self, AddrCtx};
use crate::clock::SeasonClock;
use crate::crypto::quick;
use crate::error::{kernel, BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::conquest::{lifecycle, season_cq};
use crate::layout::{
    camp as CP, citizen as C, citizen2 as C2, entry as E, frontier as FR, holding as H,
    join_shard2 as JS2, province as PV, province2 as PV2, province_fund as PF, season as S,
    site as SM, site2 as SM2, summary as SU, transit as T, Ro, Rw,
};
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
        C::Resolve(x) => resolve(p, a, &x),
        C::Return(_) => settle_return(p, a),
        C::CloseRoster(_) => close_roster(p, a),
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
        _ => Err(FrontierError::BadData.into()),
    }
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
/// asset, resident]`; `inner` is a whole draft instruction whose tag is in
/// `WideIx::ACT_RUNS` (WideClaimSite, WideDepart; `BadData` otherwise:
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
    // the inner tag alone: 0xDA carries the player Muster and Dissolve and
    // nothing of class D or N.
    use wix::WideCommand as C;
    match x.command()? {
        C::ClaimSite(_) => claim_site_as(p, a, x.inner, &auth),
        C::Depart(_) => depart_as(p, a, x.inner, &auth),
        C::Muster(m) => muster_as(p, a, &m, &auth),
        C::Dissolve(d) => dissolve_as(p, a, &d, &auth),
        _ => Err(FrontierError::BadData.into()),
    }
}

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
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &out[..m]]);
    Ok(())
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
        &host.to_bytes(),
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
    let [_actor, _payer, season_ai, citizen, holding, standing, roster_ai, own_province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
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
    // The closed path is local: a wide host never leaves its holding's
    // province (no march exists), so a foreign standing province is refused
    // until a source-capture proof for it exists.
    if stand.coord != coord {
        return Err(FrontierError::NotImplemented.into());
    }
    {
        let pd = standing.try_borrow_data()?;
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
        &host.to_bytes(),
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
    let [_fee_payer, season_ai, province, roster_ai, seed_ai, anchor_ai, inputs_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    require_wide_season(season_ai)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
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
    expect_key(inputs_ai, &wa::clash_inputs_address(&ctx, pkey, x.bell))?;
    if !init::is_absent(inputs_ai) {
        return Err(FrontierError::NotImplemented.into());
    }
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
            let r = WideRoster::new(hdr.id, pkey, [0u8; 32]);
            let mut d = alloc::vec![0u8; wro::wide_roster::SIZE];
            r.write_header(&mut d).map_err(|_| BAD_ACCOUNT)?;
            (r, d, false)
        }
    };
    // The input commitment: the province and the roster as read (an absent
    // roster is the empty table under its would-be header), the seed, the
    // bell, and the **authenticated Season bytes whole** (the ruleset
    // hash, the program version with the wide bit, the clock the seed
    // round comes from, the conquest block the step parameters come from:
    // what `prologue::keeper`, `require_wide_season` and `StepParams` read).
    let input = {
        let sd = season_ai.try_borrow_data()?;
        wev::resolve_input_digest(pkey, x.bell, &seed, &sd, &pd_s, &rd_s)
    };
    let out = wres::resolve_bell(
        &mut pd_s,
        &roster,
        &mut rd_s,
        None,
        x.bell,
        &seed,
        &frontier_ruleset(),
        &prm,
    )
    .map_err(resolve_err)?;
    {
        let o = PV::RESOLVE_SUMMARY;
        let mut w = Rw(&mut pd_s);
        w.set_u32(o + SU::BELL, x.bell)?;
        w.set_u32(o + SU::ENGAGEMENTS, out.clash.engagements)?;
        w.set_u8(o + SU::ARRIVALS, 0)?;
        w.set_u8(o + SU::DESTROYED, out.applied.destroyed)?;
        w.set_u8(o + SU::BOUNCED, out.applied.bounced)?;
        w.set_arr(o + SU::RESOLVER, &x.beneficiary[..8])?;
    }
    // The output commitment: the kernel's outcome digest and the bytes the
    // bell left (the summary included; the header's chain fields are
    // normalized out by the digest, so this record's own link does not
    // enter it).
    let output = wev::resolve_output_digest(&out.clash.digest(), &pd_s, &rd_s);
    // ---- effects: the staged bytes, whole; then the record ----
    {
        let mut pd = province.try_borrow_mut_data()?;
        if pd.len() != pd_s.len() {
            return Err(BAD_ACCOUNT);
        }
        pd.copy_from_slice(&pd_s);
    }
    if present {
        let mut rd = roster_ai.try_borrow_mut_data()?;
        if rd.len() != rd_s.len() {
            return Err(BAD_ACCOUNT);
        }
        rd.copy_from_slice(&rd_s);
    }
    let mut pd = province.try_borrow_mut_data()?;
    emit_wide(
        WideKind::Resolve,
        x.bell,
        &pkey.to_bytes(),
        &wev::resolve_payload(
            &input,
            &output,
            out.clash.engagements,
            out.applied.destroyed,
            out.applied.bounced,
            out.settled,
        ),
        &mut [(WideEntity::Province, &mut pd[..])],
    )
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
    let [_payer, season_ai, province, roster_ai, holding] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
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
    // The holding: present (its live generation) or absent. The closed
    // path is local: a holding of another province than the one the hosts
    // stand in is refused until a source-capture proof exists.
    let live = match holding_at(holding, p, hdr.id)? {
        Some(h) => {
            if h.world != world {
                return Err(BAD_ACCOUNT);
            }
            expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
            if h.coord != prov.coord {
                return Err(FrontierError::NotImplemented.into());
            }
            let hd = holding.try_borrow_data()?;
            capture_lock_of(&pd_s, &hd)?;
            let state = Ro(&hd).u8(H::STATE)?;
            matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL).then_some(h.gen)
        }
        None => None,
    };
    let hkey = key(holding);
    let bell_log = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
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
        if r.key().coord() != prov.coord {
            return Err(FrontierError::NotImplemented.into());
        }
        let credit = live == Some(r.gen());
        picked[n_picked] = (i, credit, e, Some(r));
        n_picked += 1;
        if n_picked == super::clash::RETURN_MAX {
            break;
        }
    }
    if n_picked == 0 {
        return Err(FrontierError::AlreadyDone.into());
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
    // ---- effects ----
    {
        let mut pd = province.try_borrow_mut_data()?;
        pd.copy_from_slice(&pd_s);
    }
    {
        let mut rd = roster_ai.try_borrow_mut_data()?;
        rd.copy_from_slice(&rd_s);
    }
    if live.is_some() {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        for (u, v) in reserve.iter().enumerate() {
            w.set_u32(H::reserve(u), *v)?;
        }
    }
    // The records: one per entry, each the credited milli-troops (whole
    // troops × 1,000, the amount the reserve took, once) or the loss.
    for (k, &(i, credit, e, r)) in picked[..n_picked].iter().enumerate() {
        let r = r.ok_or(BAD_ACCOUNT)?;
        let mut pd = province.try_borrow_mut_data()?;
        if credit {
            let mut hd = holding.try_borrow_mut_data()?;
            emit_wide(
                WideKind::Return,
                bell_log,
                &r.to_bytes(),
                &wev::return_payload(credited[k].saturating_mul(MILLI as u32), e.unit, i as u8),
                &mut [
                    (WideEntity::Province, &mut pd[..]),
                    (WideEntity::Holding, &mut hd[..]),
                ],
            )?;
        } else {
            emit_wide(
                WideKind::Stranded,
                bell_log,
                &r.to_bytes(),
                &wev::stranded_payload(e.troops, i as u8),
                &mut [(WideEntity::Province, &mut pd[..])],
            )?;
        }
    }
    Ok(())
}

/// WideCloseRoster (0xDE, op 1): `[any s] [season r] [roster w] [rent_to
/// w]` (`wide_ix::CLOSE_ROSTER`). Class N. Season end (Ended + 72 h,
/// Aborted, the Closed tombstone): the roster side table, program-owned and
/// of this season and world at the canonical address of the province its
/// header names, closes **whole to its immutable rent recipient** (the
/// payer of the first muster that created it; `BadAddress` for any other
/// account). The hosts it names are the season's; nothing is credited.
pub fn close_roster(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::CLOSE_ROSTER), a, None)?;
    let [_any, season_ai, roster_ai, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, bell, _) = season_end(season_ai, p, now.ts)?;
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

/// 0xDA WideDepart(host ref, transit_slot, arrive_bell, tip, commit,
/// seal): the deployed player prologue + `[holding w] [province w]
/// [system] [holding_province r]`, the deployed Depart's shape: `province`
/// is the province the host **stands in** (the roster its entry is in,
/// which a march may have left home for), `holding_province` the issuing
/// holding's own province. Nothing is debited and nothing is written: the
/// stages after Depart have no wide form yet (module doc).
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
///   identity version must be an allocated one, and every wide holding is
///   founded under the unallocated version, so the departure is refused
///   `NotImplemented` here (`WideTransit::depart`); then the roster of the
///   standing province must hold the host's alias (`NotResident`);
///   Then the arrival window `b + 2 ..= b + 72` and below the end bell
///   (`ArrivalBell`); 5. the tip floor (`TipTooLow`), `transit_slot < 4`
///   (`BadData`) and free (`TransitState`), the payer covering tip, fee
///   and bond (`Insufficient`); and then, were every check passed, the
///   departure is still refused `NotImplemented`: a transit record with no
///   settle, reveal, resolve or return to follow would be a debit into an
///   unfinished destination.
pub fn depart(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    depart_as(p, a, d, &Auth::Wallet)
}

/// [`depart`] for the Citizen's wallet or an NFT resident's Citizen
/// ([`Auth`]; module doc on reachability).
pub(crate) fn depart_as(p: &Pubkey, a: &[AccountInfo], d: &[u8], auth: &Auth) -> R<()> {
    check_accounts(WideIx::Depart, a, None)?;
    let x = wix::Depart::decode(d)?;
    let [_actor, payer, season_ai, citizen, holding, standing, _system, own_province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
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
    let (state, tile) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.u8(H::STATE)?, r.u8(H::TILE)?)
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
    // 3. the host. The identity gate: the holding's host identity version
    // (`HOST_IDENTITY_UNALLOCATED` for every wide holding today) refuses
    // the departure before any transit record or escrow could be written;
    // under an allocated version the same call also bounds the arrival
    // bell (step 4). Then the host's alias in the standing roster.
    let origin = TileAddress::new(host.key(), tile).map_err(|_| BAD_ACCOUNT)?;
    let seal_root = ks::seal_root(&x.commit, &ks::ct_hash(&x.seal));
    let _transit = WideTransit::depart(
        h.host_identity,
        host,
        0,
        0,
        origin,
        now_bell,
        x.arrive_bell,
        now.ts,
        0,
        super::host::DEPART_STAMINA,
        0,
        seal_root,
        x.tip,
        0,
    )
    .map_err(march_err)?;
    {
        let pd = standing.try_borrow_data()?;
        find_entry(&pd, wide_host_alias(&host)).ok_or(FrontierError::NotResident)?;
    }
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
    {
        let hd = holding.try_borrow_data()?;
        if Ro(&hd).u8(H::transit(x.transit_slot as usize) + T::STATE)? != T::STATE_FREE {
            return Err(FrontierError::TransitState.into());
        }
    }
    let total = x
        .tip
        .checked_add(fee)
        .and_then(|v| v.checked_add(bond))
        .ok_or(OVERFLOW)?;
    if payer.lamports() < total {
        return Err(FrontierError::Insufficient.into());
    }
    // No wide SettleDeparture, Reveal, Gather, Resolve, SettleTransit or
    // return exists: a transit record and an escrow here would be a debit
    // into an unfinished destination. Refused before either.
    Err(FrontierError::NotImplemented.into())
}
