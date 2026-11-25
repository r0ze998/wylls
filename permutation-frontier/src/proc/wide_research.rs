//! **Research: world-first technology** (world goal ②; plan
//! `docs/design/win-conditions/02-research-plan.ja.md`; owner r0ze
//! 2026-11-25 08:56 JST: every Q-RS-1 … Q-RS-10 recommendation). The pure
//! rules are `permutation_rules::frontier::research`, the records
//! `frontier_abi::world_index::research`. Five provisional envelope ops:
//!
//! | op | handler | who | what |
//! |---|---|---|---|
//! | 0xDB op 1 WideStartResearch | [`start`] | the Season authority, once | creates the world's record (rule byte, start bell announced ahead, era 1) and the six nations' records, rent from the authority |
//! | 0xDB op 2 WidePauseResearch | [`pause`] | the Season authority | pauses / resumes pledges (the safety valve; known techs and effects stay) |
//! | 0xDA op 8 WidePledge | [`pledge_as`] | the player (wallet, session or NFT resident) | from one of the Citizen's villages (the first home or a wide village), the science pledged to the nation's research of one tech: the banked science cut once to what the village made since the start (Q-RS-3 (b)), never past the rest of the cost, the nation learns at the cost, the world's first (ties at the same bell), the era step at 3 techs |
//! | 0xDC op 15 WideResearchSettle | [`settle`] | anyone | a nation whose total reaches the cost discounted since (Q-RS-5 (a)) learns the tech |
//! | 0xDC op 16 WideResearchApply | [`apply`] | anyone (the keeper / runner) | copies the village owner's nation's techs into the village's two spare bytes (the effects); also cuts the banked science (Q-RS-3 (b)) |
//!
//! Every refusal precedes every write; StartResearch's CPIs (the records'
//! creation) run before the first byte write. A village's stores change
//! only through the holding kernel (`pay`, `set_research`) and are logged
//! with the deployed `HARVEST` record and stores digest, as the territory
//! ops log theirs. Each pledge / learn / era step / start / pause is also
//! logged as one `PSR1` research receipt (`research::Receipt`, not a PS2
//! record: no chain head moves) — the contribution ledger's source. No
//! PS2/PSW1 record of a research change is allocated (gap: the verifier
//! does not replay these ops; report research-impl).

use super::{player_start_as, settle_season, world_of, Shape};
use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner};
use crate::layout::{citizen as C, citizen2 as C2, holding as H, season as S, Ro, Rw};
use crate::proc::holding as hold;
use crate::proc::Auth;
use crate::prologue::{self, check_accounts, expect_key, key, view};
use crate::{FrontierError, R, RULESET_HASH};
use frontier_abi::log::Kind;
use frontier_abi::prologue as ap;
use frontier_abi::world_index::holding::{self as wh, WideHolding};
use frontier_abi::world_index::key::WorldId;
use frontier_abi::world_index::research::{
    self as wre, receipt_kind, NationResearch, Receipt, ResearchError, ResearchWorld, NATIONS,
};
use frontier_abi::world_index::wide_ix as wix;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Holding as KHolding, Resource, RESOURCES};
use permutation_rules::frontier::research::{
    self as kr, ResearchRefusal, ResearchRule, VillageResearch,
};
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

const SCI: usize = Resource::Science as usize;

pub(super) fn refusal_err(r: ResearchRefusal) -> crate::Error {
    use FrontierError as F;
    match r {
        ResearchRefusal::NotStarted => F::TooEarly.into(),
        ResearchRefusal::UnknownTech | ResearchRefusal::Zero => F::BadData.into(),
        ResearchRefusal::EraClosed => F::WindowClosed.into(),
        ResearchRefusal::Prereq => F::OutOfOrder.into(),
        ResearchRefusal::Known => F::AlreadyDone.into(),
        ResearchRefusal::Insufficient => F::Insufficient.into(),
        ResearchRefusal::NotDue => F::TooEarly.into(),
        ResearchRefusal::Overflow => F::Overflow.into(),
    }
}

pub(super) fn research_err(e: ResearchError) -> crate::Error {
    match e {
        ResearchError::Rule(r) => refusal_err(r),
        _ => BAD_ACCOUNT,
    }
}

/// The world's research record at its canonical address (`None`: absent,
/// research never started in this world: every research op refuses
/// `NotImplemented`).
fn world_rec(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    season_id: u64,
    world: WorldId,
) -> R<ResearchWorld> {
    expect_key(ai, &wre::world_address(ctx))?;
    if init::is_absent(ai) {
        return Err(FrontierError::NotImplemented.into());
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let rec = ResearchWorld::read(&ai.try_borrow_data()?).map_err(research_err)?;
    if rec.season_id != season_id || rec.world != world {
        return Err(BAD_ACCOUNT);
    }
    Ok(rec)
}

/// A nation's research record at its canonical address.
fn nation_rec(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    w: &ResearchWorld,
    faction: u8,
) -> R<NationResearch> {
    if faction >= NATIONS {
        return Err(FrontierError::NotEligible.into());
    }
    expect_key(ai, &wre::nation_address(ctx, faction))?;
    if ai.owner != p || init::is_absent(ai) {
        return Err(BAD_ACCOUNT);
    }
    let rec = NationResearch::read(&ai.try_borrow_data()?).map_err(research_err)?;
    if rec.season_id != w.season_id
        || rec.world != w.world
        || rec.faction != faction
        || rec.rule != w.rule
    {
        return Err(BAD_ACCOUNT);
    }
    Ok(rec)
}

fn emit_receipt(r: &Receipt) {
    #[cfg(target_os = "solana")]
    solana_program::log::sol_log_data(&[wre::RECEIPT_PREFIX, &r.to_bytes()]);
    #[cfg(not(target_os = "solana"))]
    {
        let _ = r;
    }
}

/// What a village is: the first home (a deployed Holding at its canonical
/// `ctx.holding` address) or a wide village (`wh::holding_address`). Both
/// carry the deployed 1,280-B Holding head.
struct Village {
    owner: [u8; 32],
    /// `pqs_key` of the deployed HARVEST record (`0, 0, site` for a wide one).
    hkey: [u8; 9],
}

fn village(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    season_id: u64,
    world: WorldId,
) -> R<Village> {
    if ai.owner != p || init::is_absent(ai) {
        return Err(BAD_ACCOUNT);
    }
    let d = ai.try_borrow_data()?;
    if let Ok(rec) = WideHolding::read(&d) {
        if rec.season_id != season_id || rec.world != world {
            return Err(BAD_ACCOUNT);
        }
        expect_key(ai, &wh::holding_address(ctx, rec.coord, rec.site))?;
        if Ro(&d).u8(H::STATE)? != H::STATE_FINAL {
            return Err(FrontierError::NotFinal.into());
        }
        return Ok(Village {
            owner: rec.owner_citizen,
            hkey: hold::pqs_key(0, 0, rec.site)?,
        });
    }
    let owner: [u8; 32] = Ro(&d).arr(H::OWNER_CITIZEN)?;
    let hh = ap::check_holding(&view(ai, &d), ctx, season_id, &owner)?;
    if hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    Ok(Village {
        owner,
        hkey: hold::pqs_key(hh.p, hh.q, hh.site)?,
    })
}

/// Q-RS-3 (b): the first touch after the start cuts the village's banked
/// science to what it made since the start (its current net science rate ×
/// the time since the start, never more than it holds), once.
fn rebase(h: &mut KHolding, m: &mut VillageResearch, w: &ResearchWorld, now: i64) {
    if m.rebased() || !w.rule.params().pledge_after_start_only || now < w.start_ts {
        return;
    }
    let s = &mut h.stores[SCI];
    s.value = kr::rebased_science(s.value, s.rate, w.start_ts, now);
    *m = VillageResearch(m.0 | VillageResearch::REBASED);
}

fn write_village(
    ai: &AccountInfo,
    citizen: &AccountInfo,
    v: &Village,
    h: &KHolding,
    m: VillageResearch,
    now: i64,
    bell: u32,
) -> R<()> {
    let digest = {
        let mut hd = ai.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, h, now)?;
        hold::set_research_mask(&mut hd, m)?;
        hold::stores_digest(&hd)?
    };
    hold::emit3(Kind::HARVEST, bell, &v.hkey, &digest, citizen, ai, None)
}

// ------------------------------------------------------------ 0xDB op 1 / 2

/// 0xDB op 1 WideStartResearch.
pub(crate) fn start(p: &Pubkey, a: &[AccountInfo], x: &wix::StartResearch) -> R<()> {
    check_accounts(Shape(wix::START_RESEARCH), a, None)?;
    prologue::top_level(wix::WideIx::SetRules)?;
    let [authority, season_ai, world_ai, nations @ .., _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if nations.len() != NATIONS as usize {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let now = prologue::now()?;
    // (a seeded Season before its genesis too: a new world may start research at its genesis, bell 0)
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &crate::proc::map::LAND_STATUS,
        now.ts,
    )?;
    super::require_wide_season(season_ai)?;
    let stored_authority: [u8; 32] = Ro(&season_ai.try_borrow_data()?).arr(S::AUTHORITY)?;
    if key(authority) != stored_authority {
        return Err(FrontierError::Auth.into());
    }
    // V1 only (the host-test rule is never started on chain)
    let rule = match ResearchRule::from_byte(x.rule) {
        Some(ResearchRule::V1) => ResearchRule::V1,
        _ => return Err(FrontierError::BadData.into()),
    };
    let now_bell = hdr.bell(now.ts).unwrap_or(0);
    if x.start_bell < now_bell || x.start_bell >= hdr.end_bell {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(world_ai, &wre::world_address(&ctx))?;
    if !init::is_absent(world_ai) {
        return Err(FrontierError::AlreadyDone.into());
    }
    for (f, n) in nations.iter().enumerate() {
        expect_key(n, &wre::nation_address(&ctx, f as u8))?;
        if !init::is_absent(n) {
            return Err(FrontierError::AlreadyDone.into());
        }
    }
    let start_ts = hdr
        .genesis_ts
        .checked_add(x.start_bell as i64 * 600)
        .ok_or(OVERFLOW)?;
    let payer = key(authority);
    let w = ResearchWorld::new(hdr.id, rule, world, x.start_bell, start_ts, payer);
    let rent_w = init::rent(wre::research_world::SIZE)?;
    let rent_n = init::rent(wre::nation_research::SIZE)?;
    let need = rent_n
        .checked_mul(NATIONS as u64)
        .and_then(|v| v.checked_add(rent_w))
        .ok_or(OVERFLOW)?;
    if authority.lamports() < need {
        return Err(FrontierError::Insufficient.into());
    }
    let signer = SeasonSigner::new(hdr.id, hdr.bump);
    // ---- effects: the CPIs first, then byte writes ----
    init::init_with_seed(
        authority,
        world_ai,
        season_ai,
        &signer,
        &wre::world_seed(),
        wre::research_world::SIZE,
        rent_w,
        p,
    )?;
    for (f, n) in nations.iter().enumerate() {
        init::init_with_seed(
            authority,
            n,
            season_ai,
            &signer,
            &wre::nation_seed(f as u8),
            wre::nation_research::SIZE,
            rent_n,
            p,
        )?;
    }
    w.write(&mut world_ai.try_borrow_mut_data()?)
        .map_err(research_err)?;
    for (f, n) in nations.iter().enumerate() {
        NationResearch::new(hdr.id, rule, f as u8, world, payer)
            .write(&mut n.try_borrow_mut_data()?)
            .map_err(research_err)?;
    }
    emit_receipt(&Receipt {
        kind: receipt_kind::START,
        tech: 0,
        nation: 0xFF,
        flags: 0,
        bell: x.start_bell,
        citizen: payer,
        amount: 0,
        total: 0,
        cost: 0,
        era: 1,
    });
    Ok(())
}

/// 0xDB op 2 WidePauseResearch.
pub(crate) fn pause(p: &Pubkey, a: &[AccountInfo], x: &wix::PauseResearch) -> R<()> {
    check_accounts(Shape(wix::PAUSE_RESEARCH), a, None)?;
    prologue::top_level(wix::WideIx::SetRules)?;
    let [authority, season_ai, world_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let stored_authority: [u8; 32] = Ro(&season_ai.try_borrow_data()?).arr(S::AUTHORITY)?;
    if key(authority) != stored_authority {
        return Err(FrontierError::Auth.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let mut w = world_rec(world_ai, p, &ctx, hdr.id, world)?;
    let paused = x.paused == 1;
    if w.paused == paused {
        return Err(FrontierError::AlreadyDone.into());
    }
    w.paused = paused;
    w.write(&mut world_ai.try_borrow_mut_data()?)
        .map_err(research_err)?;
    emit_receipt(&Receipt {
        kind: receipt_kind::PAUSE,
        tech: 0,
        nation: 0xFF,
        flags: paused as u8,
        bell: hdr.bell(now.ts).unwrap_or(0),
        citizen: key(authority),
        amount: 0,
        total: 0,
        cost: 0,
        era: w.era,
    });
    Ok(())
}

/// Records a learn in both records and logs it (and the era step).
fn learn(
    w: &mut ResearchWorld,
    n: &mut NationResearch,
    t: u8,
    bell: u32,
    cost: u32,
    citizen: [u8; 32],
) -> R<()> {
    n.learn(t, bell).map_err(research_err)?;
    let (first, step) = w.learn(t, n.faction, bell, n.known).map_err(research_err)?;
    emit_receipt(&Receipt {
        kind: receipt_kind::LEARN,
        tech: t,
        nation: n.faction,
        flags: if first { Receipt::FLAG_FIRST } else { 0 },
        bell,
        citizen,
        amount: 0,
        total: n.pledged[t as usize],
        cost,
        era: w.era,
    });
    if let Some(era) = step {
        emit_receipt(&Receipt {
            kind: receipt_kind::ERA,
            tech: t,
            nation: n.faction,
            flags: 0,
            bell,
            citizen,
            amount: 0,
            total: 0,
            cost: 0,
            era,
        });
    }
    Ok(())
}

fn live(w: &ResearchWorld, now_bell: u32) -> R<()> {
    if w.paused || now_bell < w.start_bell {
        return Err(refusal_err(ResearchRefusal::NotStarted));
    }
    Ok(())
}

// ------------------------------------------------------------ 0xDA op 8

/// 0xDA op 8 WidePledge (`wide_ix::PLEDGE`).
pub(crate) fn pledge_as(p: &Pubkey, a: &[AccountInfo], x: &wix::Pledge, auth: &Auth) -> R<()> {
    check_accounts(Shape(wix::PLEDGE), a, None)?;
    let [_actor, _payer, season_ai, citizen, holding, world_ai, nation_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let mut w = world_rec(world_ai, p, &ctx, hdr.id, world)?;
    live(&w, now_bell)?;
    // the Citizen: its nation, not expelled (Q-RS-10 (b))
    let ckey = key(citizen);
    let (faction, expelled, cd_copy) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (
            r.u8(C::FACTION)?,
            r.i64(C2::EXPELLED_SINCE)? != 0,
            cd.to_vec(),
        )
    };
    if expelled {
        return Err(FrontierError::NotEligible.into());
    }
    let mut n = nation_rec(nation_ai, p, &ctx, &w, faction)?;
    // the village: the Citizen's, final (the first home or a wide village)
    let v = village(holding, p, &ctx, hdr.id, world)?;
    if v.owner != ckey {
        return Err(FrontierError::NotOwner.into());
    }
    let mut m = hold::research_mask(&holding.try_borrow_data()?)?;
    let mut h = hold::load_touched(holding, now.ts)?;
    rebase(&mut h, &mut m, &w, now.ts);
    let balance = kr::whole(h.stores[SCI].value);
    let prm = w.rule.params();
    let others = w.others_knowing(x.tech, faction);
    let ok = kr::judge_pledge(prm, x.tech, w.era, &n.view(), others, x.amount, balance)
        .map_err(refusal_err)?;
    let mut cost = [0i64; RESOURCES];
    cost[SCI] = (ok.accepted as i64).checked_mul(MILLI).ok_or(OVERFLOW)?;
    h.pay(now.ts, &cost).map_err(hold::holding_err)?;
    n.add(x.tech, ok.accepted, now_bell).map_err(research_err)?;
    // preflight: the bucket on a scratch Citizen
    {
        let mut scratch = cd_copy.clone();
        start.finish(&mut scratch, now.ts)?;
    }
    // ---- effects (no CPI) ----
    emit_receipt(&Receipt {
        kind: receipt_kind::PLEDGE,
        tech: x.tech,
        nation: faction,
        flags: 0,
        bell: now_bell,
        citizen: ckey,
        amount: ok.accepted,
        total: ok.total,
        cost: ok.cost,
        era: w.era,
    });
    if ok.learns {
        learn(&mut w, &mut n, x.tech, now_bell, ok.cost, ckey)?;
        w.write(&mut world_ai.try_borrow_mut_data()?)
            .map_err(research_err)?;
    }
    n.write(&mut nation_ai.try_borrow_mut_data()?)
        .map_err(research_err)?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    }
    write_village(holding, citizen, &v, &h, m, now.ts, now_bell)
}

// ------------------------------------------------------------ 0xDC op 15

/// 0xDC op 15 WideResearchSettle (`wide_ix::RESEARCH_SETTLE`).
pub(crate) fn settle(p: &Pubkey, a: &[AccountInfo], x: &wix::ResearchSettle) -> R<()> {
    check_accounts(Shape(wix::RESEARCH_SETTLE), a, None)?;
    let [payer, season_ai, world_ai, nation_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let mut w = world_rec(world_ai, p, &ctx, hdr.id, world)?;
    live(&w, now_bell)?;
    let faction = {
        let d = nation_ai.try_borrow_data()?;
        Ro(&d).u8(wre::nation_research::FACTION)?
    };
    let mut n = nation_rec(nation_ai, p, &ctx, &w, faction)?;
    let others = w.others_knowing(x.tech, faction);
    let c =
        kr::judge_settle(w.rule.params(), x.tech, w.era, &n.view(), others).map_err(refusal_err)?;
    learn(&mut w, &mut n, x.tech, now_bell, c, key(payer))?;
    w.write(&mut world_ai.try_borrow_mut_data()?)
        .map_err(research_err)?;
    n.write(&mut nation_ai.try_borrow_mut_data()?)
        .map_err(research_err)
}

// ------------------------------------------------------------ 0xDC op 16

/// 0xDC op 16 WideResearchApply (`wide_ix::RESEARCH_APPLY`).
pub(crate) fn apply(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::RESEARCH_APPLY), a, None)?;
    let [_payer, season_ai, world_ai, nation_ai, holding, citizen] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let w = world_rec(world_ai, p, &ctx, hdr.id, world)?;
    if now_bell < w.start_bell {
        return Err(refusal_err(ResearchRefusal::NotStarted));
    }
    let v = village(holding, p, &ctx, hdr.id, world)?;
    if key(citizen) != v.owner {
        return Err(FrontierError::NotOwner.into());
    }
    prologue::present(
        citizen,
        p,
        frontier_abi::layout::AccountKind::Citizen,
        hdr.id,
    )?;
    let (faction, terrain_ore) = {
        let d = holding.try_borrow_data()?;
        (Ro(&d).u8(H::FACTION)?, hold::terrain_ore(&d)?)
    };
    let n = nation_rec(nation_ai, p, &ctx, &w, faction)?;
    let old = hold::research_mask(&holding.try_borrow_data()?)?;
    let mut m = VillageResearch::new(n.known, faction, old.rebased());
    // not an owner action: settle without touching the dormancy clock
    let mut h = hold::read_holding(&holding.try_borrow_data()?)?;
    hold::settle_tiered(&mut h, now.ts, terrain_ore)?;
    rebase(&mut h, &mut m, &w, now.ts);
    if m == old {
        return Err(FrontierError::AlreadyDone.into());
    }
    h.set_research(now.ts, m.effective(faction))
        .map_err(hold::holding_err)?;
    write_village(holding, citizen, &v, &h, m, now.ts, now_bell)
}
