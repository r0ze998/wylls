//! **Experimental** (`wide-world-experimental`): the draft handlers of the
//! wide land write path, dispatched on the provisional band
//! `frontier_abi::world_index::wide_ix` (0xD6–0xDA). Not in any default
//! build; a build with this feature carries the `0x4000` program-version
//! bit, so its Seasons never mix with production Seasons, and every
//! handler refuses a Season of another version (`RulesetMismatch`).
//!
//! | tag | handler | today |
//! |---|---|---|
//! | 0xD6 | [`request_ring_seed`] | **writes**: the wide ring seed of ring `d ≥ 129`, its round fixed by the kernel's `ring_seed_round`, after the deployed OpenRing gates (the previous ring seeded, a bell since it opened, θ on the folded Frontier, every wedge fund at `d × rent`), paid by the payer as a legacy RingSeed is |
//! | 0xD7 | [`consume_ring_seed`] | **writes**: the seed, after the same `quick::verify` of the round's quicknet signature and the same `quick::seed_of` as the deployed ConsumeRingSeed |
//! | 0xD8 | [`open_province`] | validates (season, coordinate, seed, fund, absence) then refuses `NotImplemented`: the keep-holder, Free City, camp and region rules of wide land are undecided (`WideRules::UNDECIDED`), and no byte is written and no fund lamport moves |
//! | 0xD9 | [`claim_site`] | runs the deployed player authorization read-only, validates the province, site and the one-inventory slot model, then refuses `NotImplemented`: the claim (placement) rule is undecided |
//! | 0xDA | [`depart`] | runs the deployed player authorization read-only, validates the wide holding and host reference, then refuses `NotImplemented`: no wider host identity is allocated |
//!
//! The three refusing handlers are **fail-closed at a named gate**, not
//! stubs: these are preliminary checks, not a complete entitlement or settlement validation,
//! in the order the deployed counterpart makes it, so the host tests pin
//! the refusal order and that nothing is written. The gates are the
//! `Decision`s of `land::WideRules`, `holding::WideHolding::found` and
//! `march::WideTransit::depart`; the day a rule is decided and allocated,
//! the handler's input changes and its remaining writes (the deployed
//! terrain encoder, keep kernel, mirror and holding writers over the
//! Province v2 and Holding v2 offsets the wide records keep) are the next
//! step. No PS2 record is emitted by any wide handler: the records have no
//! allocated kind, and the wide accounts carry no event chain yet.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::layout::AccountKind;
use frontier_abi::prologue as ap;
use frontier_abi::world_index::holding::{self as wh, HoldingError, WideHolding};
use frontier_abi::world_index::land::{
    self as wl, Decision, LandError, PreviousRing, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING,
};
use frontier_abi::world_index::march::{MarchError, WideTransit};
use frontier_abi::world_index::tiles::TileAddress;
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{WideCoord, WideHostRef, WorldId};
use permutation_rules::frontier::geometry::{R_MAX_HARD, SITES_PER_PROVINCE};
use permutation_rules::frontier::seal as ks;

use crate::addr::{self, AddrCtx};
use crate::clock::SeasonClock;
use crate::crypto::quick;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner};
use crate::layout::{
    frontier as FR, holding as H, province_fund as PF, ring_seed as RS, season as S, Ro,
};
use crate::proc::map::{present_at, ring_occupancy_met, LAND_STATUS};
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
        if r.u16(RS::D)? != R_MAX_HARD {
            return Err(BAD_ACCOUNT);
        }
        PreviousRing {
            ring: R_MAX_HARD as u64,
            seeded: r.u8(RS::STATUS)? == RS::STATUS_SEEDED,
            opened_bell: r.u32(RS::OPENED_BELL)?,
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

// ------------------------------------------------------------ 0xD8

/// 0xD8 WideOpenProvince(P, Q): `[payer s,w] [season r] [wide_ringseed w]
/// [pfund w] [province w] [system]`, top-level only. The deployed
/// OpenProvince checks over wide identities: Seeded/Running and this
/// build's Season; `WideCoord::checked` and `ring ≥ 129` (`BadData`; the
/// disk is `OpenProvince`'s); the ring's wide seed present and seeded
/// (`SeedNotReady`), of this world; the geometric wedge's fund canonical
/// and present; the province absent at its canonical wide address
/// (`AlreadyDone`). Then the readiness gate: the keep-holder, Free City,
/// camp and region rules are undecided (`WideRules::UNDECIDED`), so the
/// opening is refused `NotImplemented` **before any write**: no fund
/// lamport moves, no account is created, the seed's count is unchanged.
pub fn open_province(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::OpenProvince, a, None)?;
    prologue::top_level(WideIx::OpenProvince)?;
    let x = wix::OpenProvince::decode(d)?;
    let [_payer, season_ai, ringseed, fund, target, _system] = a else {
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
    if seed.terrain_seed().is_none() {
        return Err(FrontierError::SeedNotReady.into());
    }
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
    let now_bell = hdr.bell(now.ts).unwrap_or(0);
    // The readiness gate. `WideRules::UNDECIDED` is what this build knows:
    // the model refuses `NotReady` naming every rule, mapped to
    // `NotImplemented`. A decided `Opening` would be followed by the fund
    // debit (`init_funded`), the wide terrain, the keep, the mirror, the
    // camp and the Free City through the deployed writers over the v2
    // offsets; none of that exists until the rules do, so the gate is the
    // last statement that can run.
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
    Err(FrontierError::NotImplemented.into())
}

// ------------------------------------------------------------ player gates

/// Steps 1 and 2 of the deployed player prologue, **read-only** (the
/// bucket debit of step 3 is a write and does not run before a readiness
/// gate): the actor and payer sign, the Season is Running with this
/// ruleset at its recomputed PDA, the Citizen is present at its wallet
/// address and the actor is the wallet or its unexpired session. Then the
/// wide version gate.
fn player_read_only(p: &Pubkey, a: &[AccountInfo], now: i64) -> R<ap::SeasonHdr> {
    let [actor, payer, season_ai, citizen, ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let start = {
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
    Ok(start.season)
}

// ------------------------------------------------------------ 0xD9

/// 0xD9 WideClaimSite(P, Q, site, slot): the deployed player prologue
/// (read-only here) + `[province w] [holding w] [system]`. The coordinate
/// wide (`BadData`); the wide province present at its canonical address
/// (`BadAccount`), of this world; `site < 12` (`BadData`); the holding
/// absent at its canonical wide address (`AlreadyDone`); the one-inventory
/// slot model on the Citizen's own bytes, without writing them: slot 2 or
/// 3 (`BadData` for slot 1, the first home's), empty, not ticketed, not
/// reserved, `holdings_n < 3` (`TicketState`). Then the readiness gate:
/// the existing capture/outpost entitlement has not been connected and is
/// undecided, so the founding is refused `NotImplemented` before any
/// write.
pub fn claim_site(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::ClaimSite, a, None)?;
    let x = wix::ClaimSite::decode(d)?;
    let [_actor, _payer, season_ai, citizen, province, holding, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = player_read_only(p, a, now.ts)?;
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
    // The slot model on a scratch copy: every refusal of the real binding,
    // no write to the Citizen.
    {
        let cd = citizen.try_borrow_data()?;
        let mut scratch = cd.to_vec();
        wh::bind(&mut scratch, x.slot).map_err(holding_err)?;
    }
    // The readiness gate: the claim rule is undecided.
    let _founded = WideHolding::found(
        world,
        hdr.id,
        coord,
        x.site,
        1,
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
/// present; `transit_slot < 4` (`BadData`); the seal's syntax
/// (`BadData`). Then the readiness gate: the holding's host identity
/// version is the unallocated one, so the march is refused
/// `NotImplemented` before any debit.
pub fn depart(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(WideIx::Depart, a, None)?;
    let x = wix::Depart::decode(d)?;
    let [_actor, _payer, season_ai, citizen, holding, province, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = player_read_only(p, a, now.ts)?;
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
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    if !super::host::seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    let tile = {
        let hd = holding.try_borrow_data()?;
        Ro(&hd).u8(H::TILE)?
    };
    let origin = TileAddress::new(host.key(), tile).map_err(|_| BAD_ACCOUNT)?;
    let seal_root = ks::seal_root(&x.commit, &ks::ct_hash(&x.seal));
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    // The readiness gate: the holding's host identity version
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
