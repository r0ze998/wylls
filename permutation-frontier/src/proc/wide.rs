//! **Experimental** (`wide-world-experimental`): the handlers of the wide
//! land write path, dispatched on the provisional band
//! `frontier_abi::world_index::wide_ix` (0xD6–0xDB). Not in any default
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
//! | 0xD9 | [`claim_site`] | runs the deployed FileOutpost's prerequisites **read-only** over wide land (the player prologue, the one-inventory slot model, the final Town first home as anchor with its unlocked province, the slot-2 holding for a slot-3 claim, `holding::may_found_outpost` on the folded Frontier and the wide province's strength weights, the site free with a zero record, the settler cost affordable from the anchor's touched stores), then refuses `NotImplemented`: the outpost **lifecycle** (FileOutpost's cohort and escrow, the beacon draw of SettleTicket, the provisional holding and its finality) is not ported to wide land, and nothing of it is substituted |
//! | 0xDA | [`depart`] | runs the deployed Depart's checks over the wide holding and province (final, resident, seal syntax, arrival window and end bell, tip floor, transit slot, funds), then refuses `NotImplemented`: no wider host identity is allocated, so no host can stand in a wide province and no march can be debited |
//!
//! **Fail closed, write nothing.** WideClaimSite and WideDepart write no
//! byte (the player prologue's bucket debit included) and move no lamport:
//! every check runs on borrowed or scratch data before the gate, and the
//! host tests compare the Citizen, the anchor, the province, the payer and
//! the absent target before and after.
//!
//! **No PS2 record of a wide event.** The wide records carry no event
//! chain and no record kind is allocated for a wide opening (the "record
//! kinds" allocation gap of `WIDE-LAND-WRITER.md` §3); an opening logs
//! nothing, so readers see the fund's counters move and nothing else.
//!
//! **Who may act.** The player handlers take the program's [`super::Auth`]:
//! the wallet prologue, or an NFT resident's Citizen through the real
//! resident check (`super::resident::start`: the asset's current Core
//! owner or its session, at the signed holder generation). The plain
//! dispatch runs them as [`super::Auth::Wallet`], which refuses an NFT
//! Citizen by address (zero `WALLET`); `ResidentAct` routes only the ABI
//! v2 tags of `resident_wire::ACT_RUNS`, which no draft tag is, so **no
//! NFT Citizen can reach a wide entry point today**: the `_as` forms are
//! the plumbing for the day the integrator allocates the tags, and the
//! holder-generation invariant is never bypassed by them.
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

use frontier_abi::conquest_model::{write_keep, write_no_keep};
use frontier_abi::layout::AccountKind;
use frontier_abi::prologue as ap;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::holding::{self as wh, HoldingError, SlotBinding, WideHolding};
use frontier_abi::world_index::land::{
    self as wl, Decision, LandError, PreviousRing, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING,
};
use frontier_abi::world_index::march::{MarchError, WideTransit};
use frontier_abi::world_index::rules::{self as wr, OpeningInput, RulesError, WideRulesConfig};
use frontier_abi::world_index::tiles::TileAddress;
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{WideCoord, WideHostRef, WorldId};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::fees;
use permutation_rules::frontier::geometry::{R_MAX_HARD, SITES_PER_PROVINCE};
use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck, Tier};
use permutation_rules::frontier::seal as ks;
use permutation_rules::frontier::terrain::wide::generate_province_wide;

use crate::addr::{self, AddrCtx};
use crate::clock::SeasonClock;
use crate::crypto::quick;
use crate::error::{kernel, BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner};
use crate::layout::conquest::season_cq;
use crate::layout::{
    camp as CP, citizen as C, citizen2 as C2, frontier as FR, holding as H, province as PV,
    province2 as PV2, province_fund as PF, season as S, site as SM, site2 as SM2, transit as T, Ro,
    Rw,
};
use crate::proc::citizen as cz;
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

/// Routes a draft-band instruction (the caller checked `is_draft_tag`).
pub fn dispatch(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    match wix::tag_of(data)? {
        WideIx::RequestRingSeed => request_ring_seed(p, a, data),
        WideIx::ConsumeRingSeed => consume_ring_seed(p, a, data),
        WideIx::OpenProvince => open_province(p, a, data),
        WideIx::ClaimSite => claim_site(p, a, data),
        WideIx::Depart => depart(p, a, data),
        WideIx::SetRules => set_rules(p, a, data),
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

// ------------------------------------------------------------ 0xD9

/// The slot-2 holding of a slot-3 claim is final (the deployed
/// FileOutpost's `slot2_final`): a legacy holding at the slot's ref
/// (canonical, the citizen's, at the ref's generation, order 2, its
/// canonical province unlocked), or a wide holding record naming slot 2
/// and the citizen (at its own canonical address, its wide province
/// present and unlocked). An empty slot 2 is never final.
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
) -> R<bool> {
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
            Ok(ph.state == H::STATE_FINAL)
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
            let hd = prev.try_borrow_data()?;
            let pd = prev_province.try_borrow_data()?;
            capture_lock_of(&pd, &hd)?;
            Ok(Ro(&hd).u8(H::STATE)? == H::STATE_FINAL)
        }
        SlotBinding::Empty => Ok(false),
    }
}

/// 0xD9 WideClaimSite(P, Q, site, slot): the deployed player prologue +
/// `[frontier r] [province w] [holding w] [joinshard w] [anchor_holding w]
/// [anchor_province r] [previous_holding r] [previous_province r]
/// [system]` (`wide_ix::CLAIM_SITE`, the deployed FileOutpost's shape).
/// The deployed FileOutpost's prerequisites over wide land, **all
/// read-only**, in its order:
///
/// 1. the player prologue steps 1–2 (`Auth`, `BadAddress`, …), this
///    build's Season (`RulesetMismatch`), the end bell (`WrongStatus`);
/// 2. the coordinate wide (`BadData`); the wide province present at its
///    canonical address, of this world (`BadAccount`); `site < 12`
///    (`BadData`); the holding absent at its canonical wide address
///    (`AlreadyDone`);
/// 3. no open ticket (`TicketState`); the one-inventory slot model on a
///    scratch copy of the Citizen (slot 2 or 3 else `BadData`; taken,
///    ticketed, reserved or a full count: `TicketState`); `slot` the
///    deployed **lowest free slot** (`TicketState` otherwise);
/// 4. the anchor: the Citizen's slot-1 legacy ref (none: `OutpostRule`),
///    the Holding there canonical and the citizen's (`NotOwner`), at the
///    ref's generation (`BadData`), final (`NotFinal`), order 1
///    (`OutpostRule`), its canonical province present and not
///    capture-locked (`CapturePending`); the slot-2 holding for a slot-3
///    claim ([`previous_final`]), the anchor pair again otherwise
///    (`BadAddress`);
/// 5. the Frontier canonical; the JoinShard canonical;
///    `holding::may_found_outpost` with the deployed inputs (count and
///    prerequisite `HoldingsFull`/`OutpostRule`; the heartland, the
///    **range from the anchor** in provinces, the share of the province's
///    strength weight, the close: `OutpostRule`; the folded land gate:
///    `Capacity`);
/// 6. the site free or released-free (`TicketState`), below the
///    province's `site_count` (`BadData`), its conquest record zero
///    (`SiegeBusy`); the settler cost (`settler_cost(holdings_n)`)
///    affordable from the anchor's touched stores (`Insufficient`, on a
///    copy: nothing is paid).
///
/// Then the readiness gate (`WideHolding::found` under an undecided claim
/// rule): **`NotImplemented`**. What is missing is the deployed outpost
/// *lifecycle*, not a rule: FileOutpost writes a ticket into the Citizen
/// and a cohort into each Province, takes the Holding-rent escrow and the
/// settler cost; SettleTicket draws the beacon seed of the ticket's bell
/// and region, scores, founds a **provisional** holding from the escrow or
/// displaces, and the resident prologue flips it final once the cohort
/// closes. The wide province has the cohort table (the prefix is the
/// Province v2 layout) but the Citizen's ticket sites are `i16` and the
/// bell seed is drawn by region: porting the flow is engineering that is
/// not done, and founding at once would be a different operation. No
/// byte is written and no lamport moves.
pub fn claim_site(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    claim_site_as(p, a, d, &Auth::Wallet)
}

/// [`claim_site`] for the Citizen's wallet or an NFT resident's Citizen
/// ([`Auth`]; module doc on reachability).
pub(crate) fn claim_site_as(p: &Pubkey, a: &[AccountInfo], d: &[u8], auth: &Auth) -> R<()> {
    check_accounts(WideIx::ClaimSite, a, None)?;
    let x = wix::ClaimSite::decode(d)?;
    let [_actor, _payer, season_ai, citizen, frontier, province, holding, shard, anchor_ai, anchor_province, prev_ai, prev_province, _system] =
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
    expect_key(holding, &wh::holding_address(&ctx, coord, x.site))?;
    if holding_at(holding, p, hdr.id)?.is_some() {
        return Err(FrontierError::AlreadyDone.into());
    }
    // 3. the Citizen and its one inventory
    let (faction, shard_i, holdings_n, slots, flags, open_ticket, bindings, gen2, gen3) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (
            r.u8(C::FACTION)?,
            r.u8(C::JOIN_SHARD)?,
            r.u8(C::HOLDINGS_N)?,
            r.u8(C2::SLOTS)?,
            r.u8(C::FLAGS)?,
            r.u32(C::TICKET_BELL)?,
            wh::bindings_of(&cd).map_err(holding_err)?,
            cz::slot_gen(&cd, 2)?,
            cz::slot_gen(&cd, 3)?,
        )
    };
    if open_ticket != C::NO_TICKET {
        return Err(FrontierError::TicketState.into());
    }
    {
        // Every refusal of the real binding, on a scratch copy.
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        wh::bind(&mut scratch, x.slot).map_err(holding_err)?;
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
    let slot2_final = if x.slot == 3 {
        previous_final(
            p,
            &ctx,
            hdr.id,
            world,
            citizen,
            bindings[1],
            prev_ai,
            prev_province,
        )?
    } else {
        expect_key(prev_ai, anchor_ai.key.as_array())?;
        expect_key(prev_province, anchor_province.key.as_array())?;
        false
    };
    // 5. the deployed outpost entitlement
    present_at(frontier, &ctx.frontier(), p, AccountKind::Frontier, hdr.id)?;
    present_at(
        shard,
        &ctx.join_shard(faction, shard_i),
        p,
        AccountKind::JoinShard,
        hdr.id,
    )?;
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
    // 6. the site (free, below the count, a zero record, a readable tile)
    // and the settler cost
    let gen = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        if x.site >= r.u8(PV::SITE_COUNT)? {
            return Err(FrontierError::BadData.into());
        }
        let o = PV::site(x.site as usize);
        if !matches!(
            r.u8(o + SM::STATE)?,
            SM::STATE_FREE | SM::STATE_RELEASED_FREE
        ) {
            return Err(FrontierError::TicketState.into());
        }
        cz::record_is_zero(&pd, x.site)?;
        let tile = r.u8(PV::SITES + x.site as usize)?;
        hold::site_terrain_ore(&pd, tile)?;
        r.u8(o + SM::GEN)?.checked_add(1).ok_or(OVERFLOW)?
    };
    // The settler cost, affordable from the anchor's touched stores: `h` is
    // a copy; the anchor account is not written.
    let cost = cz::settler_cost(holdings_n)?;
    h.pay(now.ts, &cost).map_err(hold::holding_err)?;
    // The readiness gate: the outpost lifecycle is not ported (doc above).
    // `found` refuses `NotReady` under an undecided claim rule, mapped to
    // `NotImplemented`; nothing below it exists.
    let _founded = WideHolding::found(
        world,
        hdr.id,
        coord,
        x.site,
        gen,
        x.slot,
        key(citizen),
        &Decision::Undecided,
    )
    .map_err(holding_err)?;
    Err(FrontierError::NotImplemented.into())
}

// ------------------------------------------------------------ 0xDA

/// 0xDA WideDepart(host ref, transit_slot, arrive_bell, tip, commit,
/// seal): the deployed player prologue (read-only here) + `[holding w]
/// [province w] [system]`. The host reference canonical, of this world
/// and past the disk (`BadData`/`BadAddress`); the wide holding present
/// at the reference's canonical address (`BadAccount`), owned by the
/// Citizen at the reference's generation (`NotOwner`); its province
/// present. Then the deployed Depart's checks in its order: the holding
/// final (`NotFinal`) and the province resolved through `b − 2`
/// (`NotResident`); the seal's syntax (`BadData`); the arrival window
/// `b + 2 ..= b + 72` and below the end bell (`ArrivalBell`); the tip
/// floor (`TipTooLow`); `transit_slot < 4` (`BadData`) and free
/// (`TransitState`); the payer covering tip, fee and bond
/// (`Insufficient`). Then the readiness gate: the holding's host identity
/// version is the unallocated one, and no host can stand in a wide
/// province (Muster needs a `u64` host id no wide holding has), so the
/// march is refused `NotImplemented` before any debit, transit record or
/// escrow.
pub fn depart(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    depart_as(p, a, d, &Auth::Wallet)
}

/// [`depart`] for the Citizen's wallet or an NFT resident's Citizen
/// ([`Auth`]; module doc on reachability).
pub(crate) fn depart_as(p: &Pubkey, a: &[AccountInfo], d: &[u8], auth: &Auth) -> R<()> {
    check_accounts(WideIx::Depart, a, None)?;
    let x = wix::Depart::decode(d)?;
    let [_actor, payer, season_ai, citizen, holding, province, _system] = a else {
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
    expect_key(holding, &wh::holding_address(&ctx, coord, host.site()))?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.owner_citizen != key(citizen) || h.gen != host.gen() {
        return Err(FrontierError::NotOwner.into());
    }
    if h.world != world || h.coord != coord || h.site != host.site() {
        return Err(BAD_ACCOUNT);
    }
    expect_key(province, &wl::province_address(&ctx, coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    // 1. the deployed Depart: the holding final, the province resident.
    let (state, tile) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.u8(H::STATE)?, r.u8(H::TILE)?)
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let rn = {
        let pd = province.try_borrow_data()?;
        Ro(&pd).u32(PV::RESOLVED_NEXT)?
    };
    if !ap::resident_ok(rn, now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    // 2. the seal's syntax.
    if !super::host::seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    // 4. the arrival window, and a bell of the season.
    let lo = now_bell.checked_add(2).ok_or(OVERFLOW)?;
    let hi = now_bell.checked_add(72).ok_or(OVERFLOW)?;
    if x.arrive_bell < lo || x.arrive_bell > hi || x.arrive_bell >= hdr.end_bell {
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
    let origin = TileAddress::new(host.key(), tile).map_err(|_| BAD_ACCOUNT)?;
    let seal_root = ks::seal_root(&x.commit, &ks::ct_hash(&x.seal));
    // 3. the host: the readiness gate. The holding's host identity version
    // (`HOST_IDENTITY_UNALLOCATED` for every wide holding today) refuses
    // the departure before any transit record or escrow could be written.
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
    Err(FrontierError::NotImplemented.into())
}
