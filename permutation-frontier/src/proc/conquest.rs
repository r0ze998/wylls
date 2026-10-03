//! The conquest instructions (MC contract §5.5): DeclareSiege (0xA0),
//! SettleSiege (0xA1), SettleCapture (0xA2), FoldMarch (0xA5), RetireHost
//! (0xA6), CloseMarch (0xA7). Implemented by CQ2-C. FileOutpost (0xA3) is
//! CQ2-A's (`proc/citizen.rs`).
//!
//! Every new instruction is an ABI v2 instruction: its account list is
//! `frontier_abi::v2::prologue::accounts_of`, its Season carries the
//! program's `RULESET_HASH` (`RULESET_HASH_V2` once CQ2-A's switch lands)
//! and the conquest block (else `RulesetMismatch`), and every
//! program account it keys is checked at its canonical address and as a
//! v2 account (`check_present_v2`: exact size, `layout_version = 2`, R-22).
//! The rules come from the kernels through `frontier_abi`
//! (`conquest_model` records, `v2::entry` lead host, `siege` v3).
//!
//! ## Pinned here (recorded in `CQ2-C-NOTES.md`, D-n)
//!
//! - **Codes 62–78** leave as `ProgramError::Custom(code)` ([`cq`]); the
//!   program's `Error` enum is M1's (CQ2-A may add a variant).
//! - **DeclareSiege** runs §3.4 steps 1–10 in order; "resident" (the target
//!   Province resolved through `now_bell − 2`, `NotResident`) is checked
//!   before step 4. The capture lock on the source Holding (step 2) is
//!   checked whenever the source's own Province is one of the two named
//!   Provinces (D-1); a Free City's `target_holding` and `owner_citizen`
//!   must be absent. "Shielded unless dormant" for the declarer applies to
//!   the source Holding whose host sounds the horn (D-2). The vigil is the
//!   owner Citizen's stored schedule (`start`, `next`, `from_ts / 86,400`),
//!   decoded by `siege3::vigil_of_snapshot` (D-3).
//! - **SettleSiege** settles everything a record owes in one call (a stake
//!   to the defender or to `src`, a reserved slot, or the season-end
//!   lapse of a siege). The slot Citizen and the escrow funder (D-6 of
//!   CQ1-C) must be present exactly when a slot is owed; otherwise the
//!   slot position must be absent.
//! - **SettleCapture** returns the stake to `src` for a holding and for a
//!   Free City capture (D-4); the victim's escrowed seal bonds are paid to
//!   the victim's rent payer and their flags cleared; a capture lands in
//!   the reserved slot only; the captured Holding is final at once.
//! - **RetireHost** after `end_bell` frees the host at once (no clash
//!   follows) once the Province resolved every bell of the season (D-5);
//!   a retire-style Leave stores the home Holding's key (`prev_home >>
//!   32`) in the entry's `op_ref`, which the return settle (`host.rs`)
//!   credits; it also binds a departed Leave of the previous generation
//!   that is still waiting for its return settle (D-6).

use alloc::vec::Vec;

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::{citizen_tag, citizen_tag15, day_of, host_id, split_host_id, AddrCtx};
use frontier_abi::conquest_model::{self as cm, Record};
use frontier_abi::entry::read_entry;
use frontier_abi::log::{divert_reason, NO_BELL};
use frontier_abi::prologue::{self as ap, PlayerCtx, SeasonHdr};
use frontier_abi::v2::error::CqError;
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::kernel::siege3;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{capture_outcome, retire_by, settle_reason, CqKind};
use frontier_abi::v2::presets::cq_layout as CQ;
use frontier_abi::v2::prologue as p2;
use frontier_abi::v2::tags::Ix as Ix2;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::doctrine::of_faction;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{capture_effects, Holding as KHolding, Resource, Tier};
use permutation_rules::frontier::siege::{self, HoldingKind, Relation, SiegeCheckV3, SiegeRefusal};

use super::holding::{self as hold, Player};
use crate::addr;
use crate::error::{kernel, BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{
    citizen2 as C, holding2 as H, join_shard2 as JS, march_state as MS, province2 as P,
    record as CR, season2 as S, site2 as SM,
};
use crate::layout::{entry as E, Ro, Rw};
use crate::prologue::{self, expect_key, key, view};
use crate::{FrontierError, R};

pub use cqlog::Chained2;
use frontier_abi::v2::log::EntityKind as E2;

// ------------------------------------------------------------ codes

/// An MC error code (62–78) as the program's error (`Error::Cq`, CQ2-A).
pub fn cq(e: CqError) -> crate::Error {
    crate::Error::Cq(e)
}

/// `Kernel` (15) sub-codes of the conquest instructions.
pub mod sub {
    /// SettleCapture: the captor Citizen does not reserve the record's
    /// slot (§5.5 check 4, "CaptureRule": a program bug the verifier also
    /// checks; no stable code of its own).
    pub const CAPTURE_RULE: u64 = 0x40;
    /// A record or a Holding field the instruction cannot interpret.
    pub const RECORD: u64 = 0x41;
    /// A kernel holding refusal while settling a Holding.
    pub const HOLDING: u64 = 0x42;
}

// ------------------------------------------------------------ account lists

/// `prologue::check_accounts` over the ABI v2 table (CQ2-A's `IxTable`).
pub fn check_accounts_v2(ix: Ix2, a: &[AccountInfo], counts: Option<&[u8]>) -> R<()> {
    prologue::check_accounts(ix, a, counts)
}

// ------------------------------------------------------------ v2 accounts

pub use crate::prologue::{presence_v2, present_v2};

/// Absent (System-owned, no data), else `BadAccount`.
pub fn absent(ai: &AccountInfo) -> R<()> {
    if init::is_absent(ai) {
        Ok(())
    } else {
        Err(BAD_ACCOUNT)
    }
}

/// Whether a Season's data carries the MC conquest block
/// (`conquest_version = 1`, §5.2.5). CreateSeason v2 (CQ2-A) writes and
/// validates it; an M1 Season has zeros there.
pub fn is_mc_season(season: &[u8]) -> R<bool> {
    Ok(Ro(season).u8(S::CONQUEST_PARAMS + CQ::CONQUEST_VERSION)?
        == frontier_abi::v2::presets::CONQUEST_VERSION)
}

/// The Season of an MC instruction: canonical PDA, effective status in
/// `allowed` (`WrongStatus`), the program's `RULESET_HASH` (CQ2-A makes it
/// `RULESET_HASH_V2`, A-28; `RulesetMismatch`), and the conquest block
/// (a Season without one is `RulesetMismatch`: no MC rules to apply).
pub fn season_v2(ai: &AccountInfo, p: &Pubkey, allowed: &[u8], now: i64) -> R<SeasonHdr> {
    let hdr = prologue::season(ai, p, Some(&crate::RULESET_HASH), allowed, now)?;
    let sd = ai.try_borrow_data()?;
    if !is_mc_season(&sd)? {
        return Err(FrontierError::RulesetMismatch.into());
    }
    Ok(hdr)
}

/// `retire_hosts` of a Season: the conquest block's for an MC season, 0
/// (no RetireHost: M1's DisbandStranded rule) otherwise.
pub fn retire_hosts_of(season: &[u8]) -> R<u8> {
    if is_mc_season(season)? {
        cq_u8(season, CQ::RETIRE_HOSTS)
    } else {
        Ok(0)
    }
}

/// The capture lock (§5.8) for a Holding at generation `gen` whose own
/// Province is `pd`: a capture completed in the resolve flipped the site
/// mirror to the captor (`mirror.gen = holding.gen + 1`, state 1) and
/// SettleCapture has not run (`CapturePending`, 62).
///
/// D-7: the lock reads the mirror alone (`capture_flags` stays 1 after a
/// first capture, so `frontier_abi::v2::prologue::capture_locked`'s
/// `capture_flags == 0` clause would leave a second capture of the same
/// Holding unlocked). The exact `+ 1` keeps every M1 state unlocked: an
/// M1 mirror always carries its live Holding's generation.
pub fn capture_lock(pd: &[u8], site: u8, gen: u8) -> R<()> {
    let s = site as usize;
    if m8(pd, s, SM::STATE)? == SM::STATE_HOLDING && m8(pd, s, SM::GEN)? == gen.wrapping_add(1) {
        return Err(cq(CqError::CapturePending));
    }
    Ok(())
}

/// [`capture_lock`] for a settle that reads the Holding's data `hd`
/// itself: only a live Holding (provisional or final) can be capture-locked;
/// a released one keeps M1's settles (its site may be re-founded at the
/// next generation by anyone, which is no capture).
pub fn capture_lock_of(pd: &[u8], hd: &[u8]) -> R<()> {
    let r = Ro(hd);
    if matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL) {
        capture_lock(pd, r.u8(H::SITE)?, r.u8(H::GEN)?)?;
    }
    Ok(())
}

/// The conquest block value at `off` (`cq_layout`) of a Season v2.
fn cq_u8(sd: &[u8], off: usize) -> R<u8> {
    Ro(sd).u8(S::CONQUEST_PARAMS + off)
}
fn cq_u16(sd: &[u8], off: usize) -> R<u16> {
    Ro(sd).u16(S::CONQUEST_PARAMS + off)
}
fn cq_u32(sd: &[u8], off: usize) -> R<u32> {
    Ro(sd).u32(S::CONQUEST_PARAMS + off)
}

/// The player prologue (§5.6) of an MC instruction over `[actor, payer,
/// season, citizen, …]`: as M1's (`citizen::player`) with the v2 ruleset,
/// and the Citizen a v2 account.
pub(crate) fn player_v2(p: &Pubkey, a: &[AccountInfo]) -> R<Player> {
    let [actor, payer, season_ai, citizen, ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = {
        let sd = season_ai.try_borrow_data()?;
        let sv = view(season_ai, &sd);
        let s = ap::read_season(&sv, p.as_array(), now.ts)?;
        if addr::season_pda(s.id, s.bump, p.as_array()) != *season_ai.key.as_array() {
            return Err(FrontierError::BadAddress.into());
        }
        let cd = citizen.try_borrow_data()?;
        let views = [view(actor, &[]), view(payer, &[]), sv, view(citizen, &cd)];
        let st = ap::player_prologue(&views, p.as_array(), &crate::RULESET_HASH, now.ts, true)?;
        if !is_mc_season(views[2].data)? {
            return Err(FrontierError::RulesetMismatch.into());
        }
        p2::check_present_v2(&views[3], p.as_array(), K2::Citizen, st.season.id)?;
        st
    };
    let mut cd = citizen.try_borrow_mut_data()?;
    let pc: PlayerCtx = start.finish(&mut cd, now.ts)?;
    Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    Ok(Player {
        now,
        ctx: addr::ctx(&key(season_ai), &p.to_bytes()),
        pc,
    })
}

/// A present v2 Province at its canonical address: `(P, Q,
/// resolved_next)`.
fn province_v2(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<(i16, i16, u32)> {
    present_v2(ai, p, K2::Province, sid)?;
    let (pp, pq, rn) = {
        let d = ai.try_borrow_data()?;
        let r = Ro(&d);
        (r.i16(P::P)?, r.i16(P::Q)?, r.u32(P::RESOLVED_NEXT)?)
    };
    expect_key(ai, &ctx.province(pp as i32, pq as i32))?;
    Ok((pp, pq, rn))
}

/// A Citizen v2 at its canonical address (from its stored wallet):
/// `(citizen_tag, faction, join_shard)`.
fn citizen_v2(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<(u64, u8, u8)> {
    present_v2(ai, p, K2::Citizen, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let wallet: [u8; 32] = r.arr(C::WALLET)?;
    expect_key(ai, &ctx.citizen_by_tag15(&citizen_tag15(&wallet)))?;
    let tag = r.u64(C::CITIZEN_TAG)?;
    if tag != citizen_tag(ai.key.as_array()) {
        return Err(BAD_ACCOUNT);
    }
    Ok((tag, r.u8(C::FACTION)?, r.u8(C::JOIN_SHARD)?))
}

/// The host-id form key of a Holding (`index<<44 | site<<40 | gen<<32`).
pub fn holding_key(p: i16, q: i16, site: u8, gen: u8) -> R<u64> {
    host_id(p as i32, q as i32, site, gen, 0).ok_or(BAD_ACCOUNT)
}

/// `{P i32, Q i32, site u8}`.
fn pqs(p: i16, q: i16, site: u8) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[..4].copy_from_slice(&(p as i32).to_le_bytes());
    k[4..8].copy_from_slice(&(q as i32).to_le_bytes());
    k[8] = site;
    k
}

/// The site mirror field `f` of site `s`.
fn m8(pd: &[u8], s: usize, f: usize) -> R<u8> {
    Ro(pd).u8(P::site(s) + f)
}
fn m32(pd: &[u8], s: usize, f: usize) -> R<u32> {
    Ro(pd).u32(P::site(s) + f)
}

/// Walls the clash of bell `b` reads at site `s` (the mirror's committed
/// walls and the wall items effective by `b`; ≤ 1,200).
pub fn mirror_walls_at(pd: &[u8], s: usize, b: u32) -> R<u32> {
    let mut w = m32(pd, s, SM::WALLS_COMMITTED)?;
    for (eb, dl) in [
        (SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA),
        (SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA),
    ] {
        let delta = m32(pd, s, dl)?;
        if delta > 0 && m32(pd, s, eb)? <= b {
            w = w.saturating_add(delta);
        }
    }
    Ok(w.min(permutation_rules::frontier::holding::MAX_WALLS))
}

/// The owner's vigil as DeclareSiege snapshots it (D-3): `(start_min,
/// next_min, from_day)` from the Citizen's stored schedule.
pub fn vigil_snapshot(citizen: &[u8]) -> R<(u16, u16, u16)> {
    let r = Ro(citizen);
    let from_ts = r.i64(C::VIGIL_FROM_TS)?;
    let from_day = if from_ts > 0 {
        u16::try_from(from_ts / 86_400).map_err(|_| OVERFLOW)?
    } else {
        0
    };
    Ok((
        r.u16(C::VIGIL_START_MIN)?,
        r.u16(C::VIGIL_NEXT_MIN)?,
        from_day,
    ))
}

/// Whether Holding `hd` is dormant at `now` under the season's
/// `dormant_after_secs` (MC §3.12).
fn dormant(hd: &[u8], dormant_after: u32, now: i64) -> R<bool> {
    let last = Ro(hd).i64(H::LAST_OWNER_ACTION)?;
    Ok(now >= last.saturating_add(dormant_after as i64))
}

/// A stored tier byte (0 Hamlet … 3 Stronghold).
fn holding_tier(v: u8) -> R<Tier> {
    Ok(match v {
        0 => Tier::Hamlet,
        1 => Tier::Town,
        2 => Tier::City,
        3 => Tier::Stronghold,
        _ => return Err(kernel(sub::RECORD)),
    })
}

/// The Gold store index.
const GOLD: usize = Resource::Gold as usize;

/// Credits `amount` milli-Gold to a settled kernel holding, up to the
/// store cap: returns `(credited, burned)` (§5.5 SettleSiege).
fn credit_capped(h: &mut KHolding, amount: i64) -> (i64, i64) {
    let s = &mut h.stores[GOLD];
    let room = (s.cap - s.value).max(0);
    let add = amount.min(room).max(0);
    s.value = s.value.saturating_add(add);
    (add, amount - add)
}

// ------------------------------------------------------------ the v2 log

/// PS2 records of ABI v2 kinds (MC §6), chained over v2 entities (entity
/// kind 8 = MarchState). The program writes the body itself from
/// [`cqlog::WIDTHS`], an integer table the compiler evaluates (no pointer
/// table on chain, as M1's `events::WIDTHS`).
pub mod cqlog {
    use frontier_abi::log::{self as v1, HEAD_LEN, MAX_LINKS, VERSION};
    use frontier_abi::v2::log::{self as l2, EntityKind, Link, CQ_SPECS};

    use crate::error::{Error, BAD_ACCOUNT, OVERFLOW};
    use crate::layout::{chain_of, set_chain};

    /// Highest kind code a v2 record carries (88).
    pub const MAX_KIND: usize = 89;

    /// `(defined, key width, payload width)` per kind: M1's and MC's.
    pub const WIDTHS: [(bool, u16, u16); MAX_KIND + 1] = {
        let mut t = [(false, 0u16, 0u16); MAX_KIND + 1];
        let mut i = 0;
        while i < v1::SPECS.len() {
            let s = &v1::SPECS[i];
            let (mut k, mut p) = (0usize, 0usize);
            let mut j = 0;
            while j < s.key.len() {
                k += s.key[j].1;
                j += 1;
            }
            j = 0;
            while j < s.payload.len() {
                p += s.payload[j].1;
                j += 1;
            }
            t[s.kind as usize] = (true, k as u16, p as u16);
            i += 1;
        }
        i = 0;
        while i < CQ_SPECS.len() {
            let s = &CQ_SPECS[i];
            let (mut k, mut p) = (0usize, 0usize);
            let mut j = 0;
            while j < s.key.len() {
                k += s.key[j].1;
                j += 1;
            }
            j = 0;
            while j < s.payload.len() {
                p += s.payload[j].1;
                j += 1;
            }
            t[s.kind as usize] = (true, k as u16, p as u16);
            i += 1;
        }
        t
    };

    /// Largest v2 record: a body ≤ 137 B and a full tail.
    pub const MAX_RECORD: usize = 800;

    /// A chained account a v2 record advances.
    pub struct Chained2<'a> {
        pub entity: EntityKind,
        pub data: &'a mut [u8],
    }

    /// `body_without_tail` of kind `kind` (widths from [`WIDTHS`]).
    pub fn write_body(
        kind: u8,
        bell: u32,
        key: &[u8],
        payload: &[u8],
        out: &mut [u8],
    ) -> Option<usize> {
        let (defined, kw, pw) = *WIDTHS.get(kind as usize)?;
        if !defined || key.len() != kw as usize || payload.len() != pw as usize {
            return None;
        }
        let n = HEAD_LEN + key.len() + payload.len();
        let o = out.get_mut(..n)?;
        o[0] = VERSION;
        o[1] = kind;
        o[2..6].copy_from_slice(&bell.to_le_bytes());
        o[6..6 + key.len()].copy_from_slice(key);
        o[6 + key.len()..].copy_from_slice(payload);
        Some(n)
    }

    /// Writes the record into `out`, advancing every chained account
    /// (tail: ascending entity kind, then the order given). Returns its
    /// length.
    pub fn record(
        kind: u8,
        bell: u32,
        key: &[u8],
        payload: &[u8],
        chained: &mut [Chained2<'_>],
        out: &mut [u8; MAX_RECORD],
    ) -> Result<usize, Error> {
        if chained.len() > MAX_LINKS {
            return Err(BAD_ACCOUNT);
        }
        let n = write_body(kind, bell, key, payload, out).ok_or(BAD_ACCOUNT)?;
        let m = chained.len();
        let mut order = [0usize; MAX_LINKS];
        for (i, o) in order.iter_mut().enumerate().take(m) {
            *o = i;
        }
        for i in 1..m {
            let mut j = i;
            while j > 0 && chained[order[j - 1]].entity > chained[order[j]].entity {
                order.swap(j - 1, j);
                j -= 1;
            }
        }
        let mut links = [Link {
            entity: EntityKind::Season,
            seq: 0,
            head: [0; 32],
        }; MAX_LINKS];
        for (slot, &i) in order.iter().take(m).enumerate() {
            let c = &mut chained[i];
            let (seq, head) = chain_of(c.data)?;
            let link = l2::advance(c.entity, seq, &head, &out[..n]).ok_or(OVERFLOW)?;
            set_chain(c.data, link.seq, &link.head)?;
            links[slot] = link;
        }
        l2::write_tail(&links[..m], out, n).ok_or(BAD_ACCOUNT)
    }

    /// Builds the record and logs it (`sol_log_data(["PS2", body])`).
    pub fn emit(
        kind: u8,
        bell: u32,
        key: &[u8],
        payload: &[u8],
        chained: &mut [Chained2<'_>],
    ) -> Result<(), Error> {
        let mut out = [0u8; MAX_RECORD];
        let n = record(kind, bell, key, payload, chained, &mut out)?;
        solana_program::log::sol_log_data(&[l2::PREFIX, &out[..n]]);
        Ok(())
    }
}

fn kind(k: CqKind) -> u8 {
    k as u8
}

// ------------------------------------------------------------ DeclareSiege

/// What the target site is (§3.4 step 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    /// A first holding (order 1): occupation.
    First,
    /// A holding of order 2–3: capture.
    Other,
    /// A genesis Free City (state 5): capture.
    FreeCity,
}

impl Target {
    const fn code(self) -> u8 {
        match self {
            Target::First => CR::TARGET_FIRST,
            Target::Other => CR::TARGET_OTHER,
            Target::FreeCity => CR::TARGET_FREE_CITY,
        }
    }
    const fn kernel(self) -> HoldingKind {
        match self {
            Target::First => HoldingKind::First,
            Target::Other => HoldingKind::Other,
            Target::FreeCity => HoldingKind::FreeCity,
        }
    }
}

/// `may_besiege_v3`'s refusal as a program code (§3.4 step 8).
fn refusal(r: SiegeRefusal) -> crate::Error {
    match r {
        SiegeRefusal::Seat => FrontierError::ReservedSite.into(),
        SiegeRefusal::Friendly => cq(CqError::Friendly),
        SiegeRefusal::Shielded => FrontierError::Shielded.into(),
        SiegeRefusal::FrontierProtected => cq(CqError::FrontierProtected),
        SiegeRefusal::Heartland => cq(CqError::Heartland),
        // Unreachable under MC's Rivalry and stored faction ids.
        SiegeRefusal::BadFaction | SiegeRefusal::Truce => BAD_ACCOUNT,
    }
}

/// 0xA0 DeclareSiege(site, entry, nearby_site): P (§3.4, §5.5).
pub fn declare_siege(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::DeclareSiege, a, None)?;
    let x = ix2::DeclareSiege::decode(d)?;
    // 1. Running, now_bell < end_bell (the player prologue).
    let pl = player_v2(p, a)?;
    let [_, payer, season_ai, citizen, src, province, target_h, owner_c, nearby, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = pl.now.ts;
    let b = pl.pc.now_bell;
    let sid = pl.pc.season.id;
    let (heartland_max_ring, sieges_per_day, stake_gold, dormant_after, fp_secs, fp_after) = {
        let sd = season_ai.try_borrow_data()?;
        (
            cq_u8(&sd, CQ::HEARTLAND_MAX_RING)?,
            cq_u8(&sd, CQ::SIEGES_PER_DAY)?,
            cq_u32(&sd, CQ::SIEGE_STAKE_GOLD)?,
            cq_u32(&sd, CQ::DORMANT_AFTER_SECS)?,
            cq_u32(&sd, CQ::FRONTIER_PROTECT_SECS)?,
            cq_u32(&sd, CQ::FRONTIER_PROTECT_AFTER_SECS)?,
        )
    };
    let (attacker, cslots, cgen2, cgen3, sieges_today, siege_day, cescrow) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (
            r.u8(C::FACTION)?,
            r.u8(C::SLOTS)?,
            r.u8(C::holding_of_slot(2) + 5)?,
            r.u8(C::holding_of_slot(3) + 5)?,
            r.u8(C::SIEGES_TODAY)?,
            r.u16(C::SIEGE_DAY)?,
            r.u64(C::TICKET_ESCROW)?,
        )
    };

    // 2. The source Holding: the citizen's, final, not capture-locked.
    present_v2(src, p, K2::Holding, sid)?;
    let hh = {
        let hd = src.try_borrow_data()?;
        ap::check_holding(&view(src, &hd), &pl.ctx, sid, &key(citizen))?
    };
    hold::live(&hh)?;
    // The target Province (canonical, v2) is read now: the capture lock
    // and the lazy finality flip need the source's own Province when it is
    // one of the two named ones.
    let (tp, tq, rn) = province_v2(p, &pl.ctx, sid, province)?;
    let nearby_present = presence_v2(nearby, p, K2::Province, sid)?;
    let own_named = if (hh.p, hh.q) == (tp, tq) {
        Some(province)
    } else if nearby_present && *nearby.key.as_array() == pl.ctx.province(hh.p as i32, hh.q as i32)
    {
        Some(nearby)
    } else {
        None
    };
    let state = match own_named {
        Some(pr) if core::ptr::eq(pr, province) => {
            hold::finality(&pl, &hh, src, citizen, province)?
        }
        _ => hh.state,
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if let Some(pr) = own_named {
        let pd = pr.try_borrow_data()?;
        capture_lock(&pd, hh.site, hh.gen)?;
    }

    // 3. The target site.
    let site = x.site as usize;
    let (tile, mstate, mfaction, morder, mgen) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        if site >= (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N) {
            return Err(FrontierError::BadData.into());
        }
        (
            r.u8(P::SITES + site)?,
            m8(&pd, site, SM::STATE)?,
            m8(&pd, site, SM::FACTION)?,
            m8(&pd, site, SM::ORDER)?,
            m8(&pd, site, SM::GEN)?,
        )
    };
    let target = match mstate {
        SM::STATE_HOLDING if morder == 1 => Target::First,
        SM::STATE_HOLDING => Target::Other,
        SM::STATE_FREE_CITY => Target::FreeCity,
        _ => return Err(cq(CqError::NotBesiegeable)),
    };
    expect_key(target_h, &pl.ctx.holding(tp as i32, tq as i32, x.site))?;
    // (owner tag, vigil snapshot, shield_until, founded_ts, dormant)
    let owner = if target == Target::FreeCity {
        absent(target_h)?;
        absent(owner_c)?;
        None
    } else {
        present_v2(target_h, p, K2::Holding, sid)?;
        let (tg, owner_key, shield, founded, dorm) = {
            let hd = target_h.try_borrow_data()?;
            let r = Ro(&hd);
            (
                r.u8(H::GEN)?,
                r.arr::<32>(H::OWNER_CITIZEN)?,
                r.i64(H::SHIELD_UNTIL)?,
                r.i64(H::FOUNDED_TS)?,
                dormant(&hd, dormant_after, now)?,
            )
        };
        if tg != mgen {
            return Err(cq(CqError::CapturePending));
        }
        expect_key(owner_c, &owner_key)?;
        present_v2(owner_c, p, K2::Citizen, sid)?;
        let vig = {
            let od = owner_c.try_borrow_data()?;
            vigil_snapshot(&od)?
        };
        Some((
            citizen_tag(owner_c.key.as_array()),
            vig,
            shield,
            founded,
            dorm,
        ))
    };

    // Resident: the target Province resolved through now_bell − 2.
    if !ap::resident_ok(rn, b) {
        return Err(FrontierError::NotResident.into());
    }

    // 4. On the hex: the declaring entry, then the lead host (K-24).
    let (lead_id, lead_ok) = {
        let pd = province.try_borrow_data()?;
        let e = read_entry(&pd, x.entry as usize).map_err(|_| cq(CqError::NotOnHex))?;
        let parts = split_host_id(e.id).ok_or(cq(CqError::NotOnHex))?;
        let civilian = frontier_abi::entry::unit_from_u8(e.unit).is_none_or(|u| u.is_civilian());
        let ok = e.state == E::STATE_ROSTER
            && e.from_bell <= b
            && !e.busy()
            && !civilian
            && e.troops > 0
            && e.faction == attacker
            && e.tile == tile
            && (parts.province.p, parts.province.q, parts.site, parts.gen)
                == (hh.p as i32, hh.q as i32, hh.site, hh.gen);
        if !ok {
            return Err(cq(CqError::NotOnHex));
        }
        let lead = frontier_abi::v2::entry::lead_host(&pd, tile, attacker, b);
        (e.id, lead.is_some_and(|l| l.0 == x.entry))
    };
    if !lead_ok {
        return Err(cq(CqError::NotLead));
    }

    // 5. The record: free and owing nothing; immunity for a holding.
    let rec = {
        let pd = province.try_borrow_data()?;
        Record::read(&pd, site)?
    };
    if rec.kind != CR::KIND_NONE {
        return Err(cq(CqError::SiegeBusy));
    }
    if rec.flags & CR::OWED_MASK != 0 {
        return Err(cq(CqError::StakeUnsettled));
    }
    if target != Target::FreeCity && rec.bars(attacker, b) {
        return Err(cq(CqError::Immune));
    }

    // 6. Declarations today.
    let today = u16::try_from(day_of(b)).map_err(|_| OVERFLOW)?;
    let used = if siege_day == today { sieges_today } else { 0 };
    if used >= sieges_per_day {
        return Err(cq(CqError::SiegeCap));
    }

    // 7. A capture target reserves the lowest free slot (K-25).
    let slot = match target {
        Target::First => 0,
        _ => C::lowest_free_slot(cslots, cgen2, cgen3).ok_or(cq(CqError::HoldingsFull))?,
    };

    // 8. may_besiege v3 (Rivalry, no March flags); the declarer's source
    // Holding must not be shielded unless dormant (D-2).
    let src_shielded = {
        let hd = src.try_borrow_data()?;
        let r = Ro(&hd);
        now < r.i64(H::SHIELD_UNTIL)? && !dormant(&hd, dormant_after, now)?
    };
    if let Some((_, _, shield, founded, dorm)) = owner {
        if src_shielded {
            return Err(FrontierError::Shielded.into());
        }
        let attacker_nearby = nearby_present && {
            let (np, nq, _) = province_v2(p, &pl.ctx, sid, nearby)?;
            let dist = ProvinceCoord::new(np as i32, nq as i32)
                .distance(ProvinceCoord::new(tp as i32, tq as i32));
            let pd = nearby.try_borrow_data()?;
            let ns = x.nearby_site as usize;
            dist <= siege::FRONTIER_PROTECTION_RANGE
                && ns < (Ro(&pd).u8(P::SITE_COUNT)? as usize).min(P::SITES_N)
                && m8(&pd, ns, SM::STATE)? == SM::STATE_HOLDING
                && m8(&pd, ns, SM::FACTION)? == attacker
                && m8(&pd, ns, SM::ORDER)? == 1
        };
        let check = SiegeCheckV3 {
            province: ProvinceCoord::new(tp as i32, tq as i32),
            kind: target.kernel(),
            owner_faction: mfaction,
            attacker_faction: attacker,
            relation: Relation::Rivalry,
            march_hostility: false,
            march_truce: false,
            founded_ts: founded,
            shield_until: shield,
            dormant: dorm,
            attacker_nearby,
            now,
            heartland_max_ring,
            frontier_protect_secs: fp_secs as i64,
            frontier_protect_after_secs: fp_after as i64,
            genesis_ts: pl.pc.season.genesis_ts,
        };
        siege::may_besiege_v3(&check).map_err(refusal)?;
    } else {
        // A Free City skips step 8 except the Seat and Concord test.
        let c = ProvinceCoord::new(tp as i32, tq as i32);
        if c.is_seat() || c.is_concord() {
            return Err(FrontierError::ReservedSite.into());
        }
    }

    // 9. Required bells and TooLate (bounded, R-08).
    let walls = {
        let pd = province.try_borrow_data()?;
        mirror_walls_at(&pd, site, b)?
    };
    let required = siege::required_bells(walls, 0).min(u8::MAX as u32) as u8;
    let end_bell = pl.pc.season.end_bell;
    let from = b.checked_add(1).ok_or(OVERFLOW)?;
    let vig = owner.map(|o| o.1);
    let in_time = match vig {
        Some((s0, s1, fd)) => {
            let v = siege3::vigil_of_snapshot(s0, s1, fd);
            siege3::can_complete_before(required, Some(&v), from, end_bell, pl.pc.season.genesis_ts)
        }
        None => end_bell.saturating_sub(from) >= required as u32,
    };
    if !in_time {
        return Err(cq(CqError::TooLate));
    }

    // 10. The stake from the source Holding; the escrow for a capture.
    let mut h = hold::load_touched(src, now)?;
    let mut cost = [0i64; permutation_rules::frontier::holding::RESOURCES];
    cost[GOLD] = (stake_gold as i64).checked_mul(MILLI).ok_or(OVERFLOW)?;
    h.pay(now, &cost).map_err(hold::holding_err)?;
    let mut topped = 0u64;
    if slot != 0 {
        let ticket = cslots & C::SLOTS_TICKET_MASK;
        let reserved = cslots | C::reserved_bit(slot);
        let n = (ticket >= 2) as u64
            + (reserved & C::SLOTS_RESERVED_2 != 0) as u64
            + (reserved & C::SLOTS_RESERVED_3 != 0) as u64;
        let want = init::rent(H::SIZE)?.checked_mul(n).ok_or(OVERFLOW)?;
        topped = want.saturating_sub(cescrow);
        if topped > payer.lamports() {
            return Err(FrontierError::Insufficient.into());
        }
        init::transfer(payer, citizen, topped)?;
    }

    // Effects.
    let src_key = holding_key(hh.p, hh.q, hh.site, hh.gen)?;
    let declarer = pl.pc.citizen_tag;
    let (vs, vn, vf) = vig.unwrap_or((0, 0, 0));
    let r = Record {
        kind: CR::KIND_SIEGE,
        faction: attacker,
        flags: CR::FLAG_HELD
            | if target == Target::FreeCity {
                CR::FLAG_NEUTRAL
            } else {
                0
            },
        progress: 0,
        required,
        target: CR::target(target.code(), slot),
        vigil_start: vs,
        vigil_next: vn,
        vigil_from_day: vf,
        bell: b,
        actor: declarer,
        src: src_key,
    };
    {
        let mut pd = province.try_borrow_mut_data()?;
        r.write(&mut pd, site)?;
    }
    {
        let mut hd = src.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let mut w = Rw(&mut cd);
        w.set_u16(C::SIEGE_DAY, today)?;
        w.set_u8(C::SIEGES_TODAY, used.checked_add(1).ok_or(OVERFLOW)?)?;
        if slot != 0 {
            w.set_u8(C::SLOTS, cslots | C::reserved_bit(slot))?;
            if topped > 0 {
                w.add_u64(C::TICKET_ESCROW, topped)?;
                w.set_arr(C::TICKET_FUNDER, payer.key.as_ref())?;
            }
        }
    }
    let (owner_faction, owner_tag) = match owner {
        Some((t, ..)) => (mfaction, t),
        None => (NEUTRAL, 0),
    };
    let payload = crate::events::Buf::<51>::new()
        .u8(attacker)
        .u8(owner_faction)
        .u8(r.target)
        .u64(declarer)
        .u8(required)
        .u16(vs)
        .u16(vn)
        .u16(vf)
        .u32(stake_gold)
        .u64(src_key)
        .u64(owner_tag)
        .u64(lead_id);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = src.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::SIEGE_DECLARED),
        b,
        &pqs(tp, tq, x.site),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Holding,
                data: &mut hd,
            },
            Chained2 {
                entity: E2::Province,
                data: &mut pd,
            },
        ],
    )
}

// ------------------------------------------------------------ SettleSiege

/// A stake a record owes: the recipient's Holding key and the reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StakeOwed {
    key: u64,
    reason: u8,
}

/// The stake owed, the slot owed back `(slot, actor)` and the record after.
type SettlePlan = (Option<StakeOwed>, Option<(u8, u64)>, Record);

/// What SettleSiege does for a record at `ended` (§5.5 0xA1): the stake
/// owed (if any), the slot owed back `(slot, actor)` (if any) and the
/// record after.
fn settle_plan(r: &Record, pqs_site: (i16, i16, u8), ended: bool) -> R<SettlePlan> {
    let (sp, sq, site) = pqs_site;
    let mut stake = None;
    let mut slot = None;
    let mut after = *r;
    match r.kind {
        CR::KIND_NONE => {
            if r.flags & CR::FLAG_STAKE_TO_HOLDING != 0 {
                stake = Some(StakeOwed {
                    key: holding_key(sp, sq, site, r.progress)?,
                    reason: settle_reason::TO_DEFENDER,
                });
                after.progress = 0;
            } else if r.flags & CR::FLAG_STAKE_TO_SRC != 0 {
                stake = Some(StakeOwed {
                    key: r.src,
                    reason: settle_reason::TO_ATTACKER,
                });
                after.src = 0;
            }
            if r.flags & CR::FLAG_SLOT_OWED != 0 {
                slot = Some((r.required, r.actor));
                after.required = 0;
                after.actor = 0;
            }
            after.flags = r.flags & !CR::OWED_MASK;
        }
        CR::KIND_OCCUPATION if r.flags & CR::FLAG_STAKE_TO_SRC != 0 => {
            stake = Some(StakeOwed {
                key: r.src,
                reason: settle_reason::TO_ATTACKER,
            });
            after.flags = r.flags & !CR::FLAG_STAKE_TO_SRC;
        }
        CR::KIND_SIEGE if ended => {
            stake = Some(StakeOwed {
                key: r.src,
                reason: settle_reason::SEASON_END,
            });
            let s = CR::target_slot(r.target);
            if s != 0 {
                slot = Some((s, r.actor));
            }
            after = Record {
                faction: CR::BARRED_NONE,
                ..Record::ZERO
            };
        }
        _ => {}
    }
    Ok((stake, slot, after))
}

/// 0xA1 SettleSiege(site): N (§5.5).
pub fn settle_siege(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::SettleSiege, a, None)?;
    let x = ix2::SettleSiege::decode(d)?;
    let now = prologue::now()?;
    let (fixed, funder) = match a {
        [f @ .., t] if a.len() == 6 => (f, Some(t)),
        f => (f, None),
    };
    let [_payer, season_ai, province, recipient, slot_citizen] = fixed else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let stake_gold = {
        let sd = season_ai.try_borrow_data()?;
        cq_u32(&sd, CQ::SIEGE_STAKE_GOLD)?
    };
    let (pp, pq, rn) = province_v2(p, &ctx, hdr.id, province)?;
    let site = x.site as usize;
    let rec = {
        let pd = province.try_borrow_data()?;
        if site >= (Ro(&pd).u8(P::SITE_COUNT)? as usize).min(P::SITES_N) {
            return Err(FrontierError::BadData.into());
        }
        Record::read(&pd, site)?
    };
    let bell = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let ended = hdr.status == S::STATUS_ENDED || bell >= hdr.end_bell;
    // Lag only waits (§5.9, P4): a siege may complete at `end_bell - 1`
    // (DeclareSiege's TooLate allows it) and that bell's resolve can land
    // after `end_bell` has started, so a running siege lapses only once its
    // Province has resolved every bell of the season (the guard RetireHost's
    // D-5 uses). Until then the call is `TooEarly`, before any effect.
    if ended && rec.kind == CR::KIND_SIEGE && rn < hdr.end_bell {
        return Err(FrontierError::TooEarly.into());
    }
    let (stake, slot, after) = settle_plan(&rec, (pp, pq, x.site), ended)?;
    if stake.is_none() && slot.is_none() {
        return Err(FrontierError::AlreadyDone.into());
    }
    // The stake: to the recipient Holding at the owed generation, or
    // burned.
    let milli = (stake_gold as i64).checked_mul(MILLI).ok_or(OVERFLOW)?;
    let (mut reason, mut rkey, mut amount, mut burned, mut paid) =
        (settle_reason::BURNED, 0u64, 0u32, 0u32, false);
    if let Some(s) = stake {
        let parts = split_host_id(s.key).ok_or(BAD_ACCOUNT)?;
        expect_key(
            recipient,
            &ctx.holding(parts.province.p, parts.province.q, parts.site),
        )?;
        rkey = s.key;
        let live = if presence_v2(recipient, p, K2::Holding, hdr.id)? {
            let hd = recipient.try_borrow_data()?;
            let r = Ro(&hd);
            r.u8(H::GEN)? == parts.gen
                && matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
        } else {
            false
        };
        if live {
            let mut h = {
                let hd = recipient.try_borrow_data()?;
                hold::read_holding(&hd)?
            };
            hold::settle_tiered(&mut h, now.ts)?;
            let (add, burn) = credit_capped(&mut h, milli);
            {
                let mut hd = recipient.try_borrow_mut_data()?;
                hold::write_holding(&mut hd, &h, now.ts)?;
            }
            reason = s.reason;
            amount = (add / MILLI) as u32;
            burned = (burn / MILLI) as u32;
            paid = true;
        } else {
            burned = stake_gold;
        }
    }
    // The reserved slot back to its Citizen, one rent(1,280) to its funder.
    let mut released = 0u8;
    match (slot, funder) {
        (Some((s, actor)), Some(funder)) => {
            let (tag, _, _) = citizen_v2(p, &ctx, hdr.id, slot_citizen)?;
            if tag != actor {
                return Err(FrontierError::BadAddress.into());
            }
            let (slots, escrow, funder_key) = {
                let cd = slot_citizen.try_borrow_data()?;
                let r = Ro(&cd);
                (
                    r.u8(C::SLOTS)?,
                    r.u64(C::TICKET_ESCROW)?,
                    r.arr::<32>(C::TICKET_FUNDER)?,
                )
            };
            expect_key(funder, &funder_key)?;
            let refund = init::rent(H::SIZE)?.min(escrow);
            {
                let mut cd = slot_citizen.try_borrow_mut_data()?;
                let mut w = Rw(&mut cd);
                w.set_u8(C::SLOTS, slots & !C::reserved_bit(s))?;
                w.set_u64(C::TICKET_ESCROW, escrow - refund)?;
            }
            init::pay_or_divert(
                p,
                slot_citizen,
                funder,
                refund,
                &Sink::Never,
                divert_reason::ESCROW_REFUND,
                bell,
            )?;
            released = s;
        }
        (None, None) => absent(slot_citizen)?,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        after.write(&mut pd, site)?;
    }
    let payload = crate::events::Buf::<18>::new()
        .u8(reason)
        .u64(rkey)
        .u32(amount)
        .u32(burned)
        .u8(released);
    let mut pd = province.try_borrow_mut_data()?;
    if paid {
        let mut hd = recipient.try_borrow_mut_data()?;
        cqlog::emit(
            kind(CqKind::SIEGE_SETTLED),
            bell,
            &pqs(pp, pq, x.site),
            payload.get()?,
            &mut [
                Chained2 {
                    entity: E2::Holding,
                    data: &mut hd,
                },
                Chained2 {
                    entity: E2::Province,
                    data: &mut pd,
                },
            ],
        )
    } else {
        cqlog::emit(
            kind(CqKind::SIEGE_SETTLED),
            bell,
            &pqs(pp, pq, x.site),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Province,
                data: &mut pd,
            }],
        )
    }
}

// ------------------------------------------------------------ SettleCapture

/// The `HoldingRef` (slot `slot`) of a Citizen: `(P, Q, site, gen)`.
fn holding_ref(cd: &[u8], slot: u8) -> R<(i16, i16, u8, u8)> {
    let o = C::holding_of_slot(slot);
    let r = Ro(cd);
    Ok((r.i16(o)?, r.i16(o + 2)?, r.u8(o + 4)?, r.u8(o + 5)?))
}

fn set_holding_ref(cd: &mut [u8], slot: u8, v: (i16, i16, u8, u8)) -> R<()> {
    let o = C::holding_of_slot(slot);
    let mut w = Rw(cd);
    w.set_i16(o, v.0)?;
    w.set_i16(o + 2, v.1)?;
    w.set_u8(o + 4, v.2)?;
    w.set_u8(o + 5, v.3)
}

/// An empty slot entry (v1.1: `gen = 0xFF`).
const EMPTY_REF: (i16, i16, u8, u8) = (0, 0, 0, C::EMPTY_GEN);

/// Adds `delta` to the u32 counter at `off` (saturating at 0 below).
fn bump(d: &mut [u8], off: usize, delta: i32) -> R<()> {
    let mut w = Rw(d);
    let v = w.u32(off)?;
    let nv = if delta >= 0 {
        v.checked_add(delta as u32).ok_or(OVERFLOW)?
    } else {
        v.saturating_sub(delta.unsigned_abs())
    };
    w.set_u32(off, nv)
}

/// 0xA2 SettleCapture(site, beneficiary): D (§3.6, §5.5).
pub fn settle_capture(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::SettleCapture, a, None)?;
    let x = ix2::SettleCapture::decode(d)?;
    let now = prologue::now()?;
    let [_fee_payer, season_ai, holding, province, captor_c, captor_js, victim_c, victim_js, victim_rent_payer, stake_h, _system] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let sid = hdr.id;
    let bell = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let (immunity, stake_gold, seal_bond) = {
        let sd = season_ai.try_borrow_data()?;
        (
            cq_u16(&sd, CQ::IMMUNITY_BELLS)?,
            cq_u32(&sd, CQ::SIEGE_STAKE_GOLD)?,
            Ro(&sd).u64(S::SEAL_BOND)?,
        )
    };
    let (pp, pq, _) = province_v2(p, &ctx, sid, province)?;
    let site = x.site as usize;
    let (rec, mgen, mtier, tile) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        if site >= (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N) {
            return Err(FrontierError::BadData.into());
        }
        (
            Record::read(&pd, site)?,
            m8(&pd, site, SM::GEN)?,
            m8(&pd, site, SM::TIER)?,
            r.u8(P::SITES + site)?,
        )
    };
    // 1. Capture due.
    match rec.kind {
        CR::KIND_CAPTURE_DUE => {}
        CR::KIND_NONE => return Err(FrontierError::AlreadyDone.into()),
        _ => return Err(cq(CqError::NotDue)),
    }
    let slot = CR::target_slot(rec.target);
    let free_city = CR::target_kind(rec.target) == CR::TARGET_FREE_CITY;
    let credited = rec.flags & CR::FLAG_CREDITED != 0;
    if !(2..=3).contains(&slot) {
        return Err(kernel(sub::RECORD));
    }
    // 2. The captor: canonical, its tag the record's actor.
    let (captor_tag, captor_faction, captor_shard) = citizen_v2(p, &ctx, sid, captor_c)?;
    if captor_tag != rec.actor {
        return Err(FrontierError::BadAddress.into());
    }
    expect_key(captor_js, &ctx.join_shard(captor_faction, captor_shard))?;
    present_v2(captor_js, p, K2::JoinShard, sid)?;
    // 4. (v1.1) The captor reserves the record's slot.
    let (cslots, cescrow, cfunder) = {
        let cd = captor_c.try_borrow_data()?;
        let r = Ro(&cd);
        (
            r.u8(C::SLOTS)?,
            r.u64(C::TICKET_ESCROW)?,
            r.arr::<32>(C::TICKET_FUNDER)?,
        )
    };
    if cslots & C::reserved_bit(slot) == 0 {
        return Err(kernel(sub::CAPTURE_RULE));
    }
    expect_key(holding, &ctx.holding(pp as i32, pq as i32, x.site))?;
    let rent = init::rent(H::SIZE)?;

    // The stake back to the source Holding (both outcomes, D-4).
    let src_parts = split_host_id(rec.src).ok_or(BAD_ACCOUNT)?;
    expect_key(
        stake_h,
        &ctx.holding(src_parts.province.p, src_parts.province.q, src_parts.site),
    )?;

    let mut victim_tag = 0u64;
    let mut bonds = 0u64;
    let rent_moved;
    let walls_after;
    let new_gen = mgen;
    if free_city {
        absent(holding)?;
        absent(victim_c)?;
        absent(victim_js)?;
        absent(victim_rent_payer)?;
        // The Holding from the reservation's rent (init_funded),
        // pre-funding-safe (§4.2): only the shortfall to rent-exempt moves
        // from the escrow; the rest stays escrowed for its funder
        // (CloseCitizen).
        let signer = SeasonSigner::new(hdr.id, hdr.bump);
        let seed = frontier_abi::addr::holding_seed(pp as i32, pq as i32, x.site);
        rent_moved =
            init::init_funded(captor_c, holding, season_ai, &signer, &seed, H::SIZE, p, 0)?;
        let tier = holding_tier(mtier)?;
        let day = day_of(hdr.bell(now.ts).unwrap_or(0));
        let mut h = KHolding::found(now.ts, day, slot);
        h.tier = tier;
        for s in h.stores.iter_mut() {
            s.cap = tier.storage_cap();
        }
        h.production = catalog::base_production(tier);
        h.set_upkeep(now.ts, Resource::Food, 0)
            .map_err(|_| kernel(sub::HOLDING))?;
        {
            let mut hd = holding.try_borrow_mut_data()?;
            if !frontier_abi::v2::layout::write_header(&mut hd, K2::Holding, sid) {
                return Err(BAD_ACCOUNT);
            }
            let mut w = Rw(&mut hd);
            w.set_i16(H::P, pp)?;
            w.set_i16(H::Q, pq)?;
            w.set_u8(H::SITE, x.site)?;
            w.set_u8(H::GEN, mgen)?;
            w.set_u8(H::TILE, tile)?;
            w.set_u8(H::STATE, H::STATE_FINAL)?;
            w.set_arr(H::OWNER_CITIZEN, captor_c.key.as_ref())?;
            w.set_u8(H::FACTION, captor_faction)?;
            w.set_arr(H::RENT_PAYER, &cfunder)?;
            w.set_i64(H::FINAL_TS, now.ts)?;
            w.set_u8(H::PREV_GEN, mgen.wrapping_sub(1))?;
            w.set_u8(H::CAPTURE_FLAGS, H::CAPTURE_FLAG_CAPTURED)?;
            w.set_u32(H::CAPTURED_BELL, rec.bell)?;
            hold::write_holding(&mut hd, &h, now.ts)?;
            Rw(&mut hd).set_i64(H::SHIELD_UNTIL, 0)?;
        }
        walls_after = 0;
    } else {
        // 3. The captured Holding and its victim.
        present_v2(holding, p, K2::Holding, sid)?;
        let (hgen, horder, owner_key, rent_payer) = {
            let hd = holding.try_borrow_data()?;
            let r = Ro(&hd);
            (
                r.u8(H::GEN)?,
                r.u8(H::ORDER)?,
                r.arr::<32>(H::OWNER_CITIZEN)?,
                r.arr::<32>(H::RENT_PAYER)?,
            )
        };
        if hgen.wrapping_add(1) != mgen {
            return Err(BAD_ACCOUNT);
        }
        expect_key(victim_c, &owner_key)?;
        expect_key(victim_rent_payer, &rent_payer)?;
        let (vtag, vfaction, vshard) = citizen_v2(p, &ctx, sid, victim_c)?;
        victim_tag = vtag;
        expect_key(victim_js, &ctx.join_shard(vfaction, vshard))?;
        present_v2(victim_js, p, K2::JoinShard, sid)?;
        // Captor and victim are of different factions (Friendly is refused
        // at the horn), so their JoinShards and Citizens are distinct.
        if victim_js.key == captor_js.key || victim_c.key == captor_c.key {
            return Err(BAD_ACCOUNT);
        }
        let (vslot_ref, vhome) = {
            let cd = victim_c.try_borrow_data()?;
            (holding_ref(&cd, horder)?, holding_ref(&cd, 1)?)
        };
        if !(2..=3).contains(&horder) || vslot_ref != (pp, pq, x.site, hgen) {
            return Err(kernel(sub::RECORD));
        }
        let prev_home = if vhome.3 == C::EMPTY_GEN || vhome.3 == 0 {
            0
        } else {
            holding_key(vhome.0, vhome.1, vhome.2, vhome.3)?
        };
        // The victim's escrowed seal bonds, refunded at once (§3.6).
        for i in 0..H::TRANSIT_N {
            let o = H::transit(i);
            let (st, fl) = {
                let hd = holding.try_borrow_data()?;
                let r = Ro(&hd);
                (r.u8(o)?, r.u8(o + crate::layout::transit::FLAGS)?)
            };
            let bonded = fl & crate::layout::transit::FLAG_BOND_ESCROWED != 0;
            if !crate::layout::transit::in_transit(st) || !bonded {
                continue;
            }
            {
                let mut hd = holding.try_borrow_mut_data()?;
                let mut w = Rw(&mut hd);
                w.set_u8(
                    o + crate::layout::transit::FLAGS,
                    fl & !crate::layout::transit::FLAG_BOND_ESCROWED,
                )?;
                let esc = w
                    .u64(H::ESCROW)?
                    .checked_sub(seal_bond)
                    .ok_or(BAD_ACCOUNT)?;
                w.set_u64(H::ESCROW, esc)?;
            }
            init::pay_or_divert(
                p,
                holding,
                victim_rent_payer,
                seal_bond,
                &Sink::PoolOwed(holding),
                divert_reason::BOND,
                bell,
            )?;
            bonds = bonds.checked_add(seal_bond).ok_or(OVERFLOW)?;
        }
        // The rent swap: the reservation's rent to the victim's funder.
        if cescrow < rent {
            return Err(FrontierError::Insufficient.into());
        }
        init::pay_or_divert(
            p,
            captor_c,
            victim_rent_payer,
            rent,
            &Sink::Never,
            divert_reason::RENT_REFUND,
            bell,
        )?;
        rent_moved = rent;
        // The Holding changes hands (§3.6).
        let mut h = {
            let hd = holding.try_borrow_data()?;
            hold::read_holding(&hd)?
        };
        hold::settle_tiered(&mut h, now.ts)?;
        let doctrine = *of_faction(captor_faction).ok_or(BAD_ACCOUNT)?;
        let eff = capture_effects(&h, doctrine);
        h.walls = eff.walls;
        if !credited {
            for s in h.stores.iter_mut() {
                s.value = 0;
                s.frac = 0;
            }
        }
        h.order = slot;
        h.touch_owner(now.ts).map_err(|_| kernel(sub::HOLDING))?;
        walls_after = h.walls;
        {
            let mut hd = holding.try_borrow_mut_data()?;
            hold::write_holding(&mut hd, &h, now.ts)?;
            let mut w = Rw(&mut hd);
            w.set_u64(H::PREV_OWNER_TAG, vtag)?;
            w.set_u8(H::PREV_GEN, hgen)?;
            w.set_u8(H::CAPTURE_FLAGS, H::CAPTURE_FLAG_CAPTURED)?;
            w.set_u32(H::CAPTURED_BELL, rec.bell)?;
            w.set_u64(H::PREV_HOME, prev_home)?;
            w.set_arr(H::OWNER_CITIZEN, captor_c.key.as_ref())?;
            w.set_u8(H::GEN, mgen)?;
            w.set_u8(H::FACTION, captor_faction)?;
            w.set_u8(H::STATE, H::STATE_FINAL)?;
            let fts = w.i64(H::FINAL_TS)?.min(now.ts);
            w.set_i64(H::FINAL_TS, fts)?;
            w.set_i64(H::SHIELD_UNTIL, 0)?;
            w.set_arr(H::DELEGATE, &[0u8; 32])?;
            w.set_arr(H::RENT_PAYER, &cfunder)?;
            for u in 0..H::RESERVE_N {
                w.set_u32(H::RESERVE + 4 * u, 0)?;
            }
        }
        // The victim's Citizen and JoinShard.
        {
            let mut cd = victim_c.try_borrow_mut_data()?;
            set_holding_ref(&mut cd, horder, EMPTY_REF)?;
            let n = Ro(&cd).u8(C::HOLDINGS_N)?.saturating_sub(1);
            Rw(&mut cd).set_u8(C::HOLDINGS_N, n)?;
        }
        {
            let mut jd = victim_js.try_borrow_mut_data()?;
            bump(&mut jd, JS::EXTRA_HOLDINGS, -1)?;
            bump(&mut jd, JS::CAPTURED_OUT, 1)?;
        }
    }
    // The captor's Citizen and JoinShard: the reserved slot is consumed.
    {
        let mut cd = captor_c.try_borrow_mut_data()?;
        set_holding_ref(&mut cd, slot, (pp, pq, x.site, new_gen))?;
        let mut w = Rw(&mut cd);
        let n = w.u8(C::HOLDINGS_N)?.checked_add(1).ok_or(OVERFLOW)?;
        w.set_u8(C::HOLDINGS_N, n)?;
        w.set_u8(C::SLOTS, cslots & !C::reserved_bit(slot))?;
        let esc = w.u64(C::TICKET_ESCROW)?.saturating_sub(rent_moved);
        w.set_u64(C::TICKET_ESCROW, esc)?;
    }
    {
        let mut jd = captor_js.try_borrow_mut_data()?;
        bump(&mut jd, JS::EXTRA_HOLDINGS, 1)?;
        bump(&mut jd, JS::CAPTURED_IN, 1)?;
    }
    // The stake back to `src` (absent or another generation: burned).
    let stake_live = if presence_v2(stake_h, p, K2::Holding, sid)? {
        let sd = stake_h.try_borrow_data()?;
        let r = Ro(&sd);
        r.u8(H::GEN)? == src_parts.gen
            && matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
    } else {
        false
    };
    if stake_live && stake_h.key != holding.key {
        let mut h = {
            let sd = stake_h.try_borrow_data()?;
            hold::read_holding(&sd)?
        };
        hold::settle_tiered(&mut h, now.ts)?;
        let milli = (stake_gold as i64).checked_mul(MILLI).ok_or(OVERFLOW)?;
        credit_capped(&mut h, milli);
        let mut sd = stake_h.try_borrow_mut_data()?;
        hold::write_holding(&mut sd, &h, now.ts)?;
    }
    // The record: post-capture immunity against every faction, counted
    // from the completion bell (§3.6).
    {
        let mut pd = province.try_borrow_mut_data()?;
        Record {
            faction: CR::BARRED_ALL,
            bell: rec.bell.saturating_add(1).saturating_add(immunity as u32),
            ..Record::ZERO
        }
        .write(&mut pd, site)?;
    }
    let payload = crate::events::Buf::<40>::new()
        .u8(if free_city {
            capture_outcome::FREE_CITY
        } else {
            capture_outcome::CAPTURE
        })
        .u8(credited as u8)
        .u64(captor_tag)
        .u64(victim_tag)
        .u8(new_gen)
        .u8(slot)
        .u64(rent_moved)
        .u64(bonds)
        .u32(walls_after);
    let mut hd = holding.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    let mut cd = captor_c.try_borrow_mut_data()?;
    let mut jd = captor_js.try_borrow_mut_data()?;
    let k = pqs(pp, pq, x.site);
    if free_city {
        cqlog::emit(
            kind(CqKind::CAPTURE_SETTLED),
            bell,
            &k,
            payload.get()?,
            &mut [
                Chained2 {
                    entity: E2::Holding,
                    data: &mut hd,
                },
                Chained2 {
                    entity: E2::Province,
                    data: &mut pd,
                },
                Chained2 {
                    entity: E2::Citizen,
                    data: &mut cd,
                },
                Chained2 {
                    entity: E2::JoinShard,
                    data: &mut jd,
                },
            ],
        )
    } else {
        let mut vd = victim_c.try_borrow_mut_data()?;
        let mut vj = victim_js.try_borrow_mut_data()?;
        cqlog::emit(
            kind(CqKind::CAPTURE_SETTLED),
            bell,
            &k,
            payload.get()?,
            &mut [
                Chained2 {
                    entity: E2::Holding,
                    data: &mut hd,
                },
                Chained2 {
                    entity: E2::Province,
                    data: &mut pd,
                },
                Chained2 {
                    entity: E2::Citizen,
                    data: &mut cd,
                },
                Chained2 {
                    entity: E2::Citizen,
                    data: &mut vd,
                },
                Chained2 {
                    entity: E2::JoinShard,
                    data: &mut jd,
                },
                Chained2 {
                    entity: E2::JoinShard,
                    data: &mut vj,
                },
            ],
        )
    }
}

// ------------------------------------------------------------ FoldMarch

/// 0xA5 FoldMarch(m, n, hour, count, beneficiary): D (§3.10, §5.5).
pub fn fold_march(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::FoldMarch, a, None)?;
    let x = ix2::FoldMarch::decode(d)?;
    let now = prologue::now()?;
    let [fee_payer, season_ai, march, members @ .., _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if members.len() != 7 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let sid = hdr.id;
    if x.count == 0 || x.count > ix2::FOLD_MAX_HOURS {
        return Err(FrontierError::BadData.into());
    }
    // The last hour folded must start before `end_bell` (§3.11).
    let last = x
        .hour
        .checked_add(x.count as u32 - 1)
        .and_then(|h| h.checked_mul(cm::HOUR_BELLS))
        .ok_or(OVERFLOW)?;
    if last >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let dom = {
        let sd = season_ai.try_borrow_data()?;
        cq_u16(&sd, CQ::DOMINION_PER_HOUR)?
    };
    // The March and its seven members (canonical; absent allowed).
    expect_key(march, &frontier_abi::v2::addr::march_state(&ctx, x.m, x.n))?;
    let coords = frontier_abi::v2::addr::march_members(x.m, x.n);
    let mut present = [false; 7];
    for (i, ((mp, mq), ai)) in coords.iter().zip(members).enumerate() {
        expect_key(ai, &ctx.province(*mp, *mq))?;
        present[i] = presence_v2(ai, p, K2::Province, sid)?;
    }
    let datas: Vec<_> = members
        .iter()
        .map(|m| m.try_borrow_data())
        .collect::<Result<Vec<_>, _>>()?;
    let mut views: [Option<&[u8]>; 7] = [None; 7];
    for (i, v) in views.iter_mut().enumerate() {
        if present[i] {
            *v = Some(&datas[i][..]);
        }
    }
    let bell = hdr.bell(now.ts).unwrap_or(NO_BELL);
    // First fold: create the MarchState (pre-funding safe).
    if !presence_v2(march, p, K2::MarchState, sid)? {
        let first = cm::first_hour(&views)?.ok_or(cq(CqError::FoldTooEarly))?;
        let signer = SeasonSigner::new(hdr.id, hdr.bump);
        let seed = frontier_abi::v2::addr::march_seed(x.m, x.n);
        let rent = init::rent(MS::SIZE)?;
        init::init_with_seed(
            fee_payer,
            march,
            season_ai,
            &signer,
            &seed,
            MS::SIZE,
            rent,
            p,
        )?;
        let mut md = march.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut md, K2::MarchState, sid) {
            return Err(BAD_ACCOUNT);
        }
        let mut w = Rw(&mut md);
        w.set_i32(MS::M, x.m)?;
        w.set_i32(MS::N, x.n)?;
        w.set_u32(MS::NEXT_HOUR, first)?;
        w.set_u8(MS::CONTROLLER, MS::CONTROLLER_NONE)?;
        w.set_arr(MS::RENT_TO, fee_payer.key.as_ref())?;
    } else {
        let md = march.try_borrow_data()?;
        let r = Ro(&md);
        if (r.i32(MS::M)?, r.i32(MS::N)?) != (x.m, x.n) {
            return Err(BAD_ACCOUNT);
        }
    }
    {
        let md = march.try_borrow_data()?;
        if Ro(&md).u32(MS::NEXT_HOUR)? != x.hour {
            return Err(cq(CqError::FoldOutOfOrder));
        }
    }
    // The captures sum is the same for every hour of the call (each
    // member's cumulative `captures_by` as stored now): read once.
    let captures = fold_captures(&views)?;
    let mut md = march.try_borrow_mut_data()?;
    let mut key = [0u8; 12];
    key[..4].copy_from_slice(&x.m.to_le_bytes());
    key[4..8].copy_from_slice(&x.n.to_le_bytes());
    for k in 0..x.count as u32 {
        let h = x.hour + k;
        let hf = fold_hour(&views, h, captures)?;
        let log = cm::apply_fold(&mut md, &hf, dom).map_err(fold_err)?;
        key[8..].copy_from_slice(&h.to_le_bytes());
        cqlog::emit(
            kind(CqKind::MARCH_FOLD),
            bell,
            &key,
            &log.to_bytes(),
            &mut [Chained2 {
                entity: E2::MarchState,
                data: &mut md,
            }],
        )?;
    }
    Ok(())
}

/// Σ of the present members' `captures_by[f]` (`conquest_model::fold`'s
/// `captures`, which does not depend on the hour).
fn fold_captures(members: &[Option<&[u8]>; 7]) -> R<[u16; P::FACTIONS]> {
    let mut captures = [0u16; P::FACTIONS];
    for pd in members.iter().flatten() {
        for (f, c) in captures.iter_mut().enumerate() {
            *c = c.saturating_add(Ro(pd).u16(P::captures_by(f))?);
        }
    }
    Ok(captures)
}

/// `conquest_model::fold(members, h)` with the call's `captures` (equal,
/// field for field: pinned by `fold_hour_is_the_models`).
fn fold_hour(
    members: &[Option<&[u8]>; 7],
    h: u32,
    captures: [u16; P::FACTIONS],
) -> R<cm::HourFold> {
    let mut weight = [0u32; P::SIDES];
    let mut lost = false;
    for m in members {
        match cm::member_sample(*m, h).map_err(fold_err)? {
            cm::Sample::Zero => {}
            cm::Sample::Lost => lost = true,
            cm::Sample::Weight(w) => {
                for (d, x) in weight.iter_mut().zip(w) {
                    *d = d.saturating_add(x as u32);
                }
            }
        }
    }
    Ok(cm::HourFold {
        hour: h,
        weight,
        controller: frontier_abi::v2::kernel::control::controller(&weight),
        lost,
        captures,
    })
}

fn fold_err(e: cm::FoldError) -> crate::Error {
    match e {
        cm::FoldError::TooEarly => cq(CqError::FoldTooEarly),
        cm::FoldError::OutOfOrder => cq(CqError::FoldOutOfOrder),
        cm::FoldError::Model(m) => m.into(),
    }
}

// ------------------------------------------------------------ RetireHost

/// `op_ref` of a retire-style Leave bound to its home Holding: the home
/// key's high 32 bits (`index << 12 | site << 8 | gen`), never 0 for a
/// real Holding (gen ≥ 1).
pub const fn home_ref(home_key: u64) -> u32 {
    (home_key >> 32) as u32
}

/// 0xA6 RetireHost(entry): P (the victim) during the season, N after
/// `end_bell` (K-27, §5.5).
pub fn retire_host(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::RetireHost, a, None)?;
    let x = ix2::RetireHost::decode(d)?;
    let now = prologue::now()?;
    let [actor, _payer, season_ai, victim_c, province, captured, home] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let sid = hdr.id;
    let retire_hosts = {
        let sd = season_ai.try_borrow_data()?;
        cq_u8(&sd, CQ::RETIRE_HOSTS)?
    };
    if retire_hosts != 1 {
        return Err(FrontierError::WrongStatus.into());
    }
    let b = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let in_season = b < hdr.end_bell;
    // The captured Holding (canonical from its stored key, v2).
    present_v2(captured, p, K2::Holding, sid)?;
    let (cp, cq_, csite, cgen, prev_gen, flags, prev_owner, prev_home) = {
        let hd = captured.try_borrow_data()?;
        let r = Ro(&hd);
        (
            r.i16(H::P)?,
            r.i16(H::Q)?,
            r.u8(H::SITE)?,
            r.u8(H::GEN)?,
            r.u8(H::PREV_GEN)?,
            r.u8(H::CAPTURE_FLAGS)?,
            r.u64(H::PREV_OWNER_TAG)?,
            r.u64(H::PREV_HOME)?,
        )
    };
    expect_key(captured, &ctx.holding(cp as i32, cq_ as i32, csite))?;
    // During the season only the victim (wallet or live session) retires.
    if in_season {
        let (tag, _, _) = citizen_v2(p, &ctx, sid, victim_c)?;
        let (wallet, session, expiry) = {
            let cd = victim_c.try_borrow_data()?;
            let r = Ro(&cd);
            (
                r.arr::<32>(C::WALLET)?,
                r.arr::<32>(C::SESSION)?,
                r.i64(C::SESSION_EXPIRY)?,
            )
        };
        let k = actor.key.to_bytes();
        let by_session = k != wallet;
        if by_session && (session == [0u8; 32] || k != session) {
            return Err(FrontierError::Auth.into());
        }
        if by_session && now.ts >= expiry {
            return Err(FrontierError::SessionExpired.into());
        }
        if tag != prev_owner {
            return Err(cq(CqError::NotLead));
        }
    }
    if flags & H::CAPTURE_FLAG_CAPTURED == 0 || prev_home == 0 {
        return Err(FrontierError::NotOwner.into());
    }
    // The home Holding: prev_home, present at its generation and live.
    let hp = split_host_id(prev_home).ok_or(BAD_ACCOUNT)?;
    expect_key(home, &ctx.holding(hp.province.p, hp.province.q, hp.site))?;
    present_v2(home, p, K2::Holding, sid)?;
    {
        let hd = home.try_borrow_data()?;
        let r = Ro(&hd);
        if r.u8(H::GEN)? != hp.gen
            || !matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
        {
            return Err(BAD_ACCOUNT);
        }
    }
    // The Province the host stands in, and the entry.
    let (pp, pq, rn) = province_v2(p, &ctx, sid, province)?;
    let (id, troops) = {
        let mut pd = province.try_borrow_mut_data()?;
        let e = read_entry(&pd, x.entry as usize).map_err(|_| FrontierError::BadData)?;
        let parts = split_host_id(e.id).ok_or(FrontierError::BadData)?;
        if (parts.province.p, parts.province.q, parts.site) != (cp as i32, cq_ as i32, csite)
            || parts.gen != prev_gen
            || prev_gen == cgen
        {
            return Err(FrontierError::NotOwner.into());
        }
        let o = P::entry(x.entry as usize);
        let departed_leave =
            e.state == E::STATE_DEPARTED && matches!(e.op, frontier_abi::entry::EntryOp::Leave);
        let mut w = Rw(&mut pd);
        if departed_leave {
            // D-6: a Leave already out of the roster, waiting for its
            // return settle: bound to the home Holding.
            if w.u32(o + E::OP_REF)? != 0 {
                return Err(FrontierError::AlreadyDone.into());
            }
        } else if e.state != E::STATE_ROSTER {
            return Err(FrontierError::NotResident.into());
        } else if e.busy() {
            return Err(FrontierError::HostBusy.into());
        } else if in_season {
            // A pending Leave of bell b: effective after b's clash.
            if !ap::resident_ok(rn, b) {
                return Err(FrontierError::NotResident.into());
            }
            w.set_u8(o + E::PEND_OP, E::OP_LEAVE)?;
            w.set_u32(o + E::PEND_BELL, b)?;
        } else {
            // D-5: after end_bell no clash follows; once every bell of the
            // season is resolved the host leaves at once.
            if rn < hdr.end_bell {
                return Err(FrontierError::TooEarly.into());
            }
            w.set_u8(o + E::PEND_OP, E::OP_LEAVE)?;
            w.set_u32(o + E::PEND_BELL, hdr.end_bell.saturating_sub(1))?;
            w.set_u8(o + E::STATE, E::STATE_DEPARTED)?;
        }
        w.set_u8(o + E::OP_A, frontier_abi::v2::entry::RETIRE_OP_A)?;
        w.set_u32(o + E::OP_REF, home_ref(prev_home))?;
        let ep = w.u32(P::ROSTER_EPOCH)?.wrapping_add(1);
        w.set_u32(P::ROSTER_EPOCH, ep)?;
        (e.id, e.troops)
    };
    let _ = (pp, pq);
    let payload = crate::events::Buf::<13>::new()
        .u32(troops)
        .u64(prev_home)
        .u8(if in_season {
            retire_by::VICTIM
        } else {
            retire_by::AFTER_END
        });
    let mut pd = province.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::RETIRE),
        b,
        &id.to_le_bytes(),
        payload.get()?,
        &mut [Chained2 {
            entity: E2::Province,
            data: &mut pd,
        }],
    )
}

// ------------------------------------------------------------ CloseMarch

/// 0xA7 CloseMarch: N (§5.5): the Season Ended at least 72 h ago (or its
/// Closed tombstone); the rent goes to the MarchState's `rent_to`.
pub fn close_march(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseMarch, a, None)?;
    let _ = ix2::CloseMarch::decode(d)?;
    let now = prologue::now()?;
    let [_any, season_ai, march, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let (sid, bell) = match super::season::float_tombstone(season_ai, p)? {
        Some(id) => (id, NO_BELL),
        None => {
            let hdr = season_v2(season_ai, p, &[S::STATUS_ENDED], now.ts)?;
            let end = super::map::season_end_ts(&hdr);
            if now.ts < end.saturating_add(super::map::END_GRACE_SECS) {
                return Err(FrontierError::TooEarly.into());
            }
            (hdr.id, hdr.bell(now.ts).unwrap_or(NO_BELL))
        }
    };
    present_v2(march, p, K2::MarchState, sid)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let (m, n) = {
        let md = march.try_borrow_data()?;
        let r = Ro(&md);
        if r.arr::<32>(MS::RENT_TO)? != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
        (r.i32(MS::M)?, r.i32(MS::N)?)
    };
    expect_key(march, &frontier_abi::v2::addr::march_state(&ctx, m, n))?;
    let lamports = march.lamports();
    {
        let mut md = march.try_borrow_mut_data()?;
        let (seq, head) = crate::layout::chain_of(&md)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(seq)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &frontier_abi::v2::log::close_key_march(m, n),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::MarchState,
                data: &mut md,
            }],
        )?;
    }
    init::close_to(p, march, rent_to, &Sink::Never, bell)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_cover_every_v2_kind() {
        for s in frontier_abi::v2::log::CQ_SPECS {
            let k = frontier_abi::v2::log::AnyKind::Cq(s.kind);
            let w = cqlog::WIDTHS[s.kind as usize];
            assert!(w.0, "{}", s.name);
            assert_eq!(w.1 as usize, k.key_len(), "{}", s.name);
            assert_eq!(w.2 as usize, k.payload_len(), "{}", s.name);
            let key = alloc::vec![1u8; k.key_len()];
            let pl = alloc::vec![2u8; k.payload_len()];
            let mut a = [0u8; cqlog::MAX_RECORD];
            let mut b = [0u8; cqlog::MAX_RECORD];
            let na = cqlog::write_body(s.kind as u8, 9, &key, &pl, &mut a).unwrap();
            let nb = frontier_abi::v2::log::write_body(k, 9, &key, &pl, &mut b).unwrap();
            assert_eq!(&a[..na], &b[..nb], "{}", s.name);
        }
        let close = cqlog::WIDTHS[frontier_abi::log::Kind::CLOSE as usize];
        assert_eq!((close.1, close.2), (16, 80));
    }

    #[test]
    fn records_decode_through_the_v2_decoder() {
        let mut march = alloc::vec![0u8; MS::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut march,
            K2::MarchState,
            3
        ));
        let mut out = [0u8; cqlog::MAX_RECORD];
        let n = cqlog::record(
            CqKind::MARCH_FOLD as u8,
            7,
            &[0u8; 12],
            &[0u8; 44],
            &mut [Chained2 {
                entity: E2::MarchState,
                data: &mut march,
            }],
            &mut out,
        )
        .unwrap();
        let r = frontier_abi::v2::log::decode(&out[..n]).unwrap();
        assert_eq!(r.n_links, 1);
        assert_eq!(r.links[0].unwrap().entity, E2::MarchState);
        assert_eq!(crate::layout::chain_of(&march).unwrap().0, 1);
    }

    #[test]
    fn settle_plan_owes_what_the_record_says() {
        let r = Record {
            kind: CR::KIND_NONE,
            faction: 2,
            flags: CR::FLAG_STAKE_TO_HOLDING | CR::FLAG_SLOT_OWED,
            progress: 3,
            required: 2,
            bell: 99,
            actor: 77,
            ..Record::ZERO
        };
        let (s, slot, after) = settle_plan(&r, (4, -1, 5), false).unwrap();
        assert_eq!(s.unwrap().key, holding_key(4, -1, 5, 3).unwrap());
        assert_eq!(s.unwrap().reason, settle_reason::TO_DEFENDER);
        assert_eq!(slot, Some((2, 77)));
        assert_eq!(after.flags, 0);
        // immunity survives the settle
        assert_eq!((after.faction, after.bell), (2, 99));
        // a running siege owes nothing before the end
        let siege = Record {
            kind: CR::KIND_SIEGE,
            target: CR::target(CR::TARGET_OTHER, 3),
            src: 5,
            actor: 9,
            ..Record::ZERO
        };
        let (s, slot, _) = settle_plan(&siege, (0, 0, 0), false).unwrap();
        assert!(s.is_none() && slot.is_none());
        let (s, slot, after) = settle_plan(&siege, (0, 0, 0), true).unwrap();
        assert_eq!(s.unwrap().reason, settle_reason::SEASON_END);
        assert_eq!(slot, Some((3, 9)));
        assert_eq!(after.kind, CR::KIND_NONE);
        assert_eq!(after.faction, CR::BARRED_NONE);
        // an occupation's stake to src keeps the occupation
        let occ = Record {
            kind: CR::KIND_OCCUPATION,
            flags: CR::FLAG_STAKE_TO_SRC,
            src: 11,
            ..Record::ZERO
        };
        let (s, _, after) = settle_plan(&occ, (0, 0, 0), false).unwrap();
        assert_eq!(s.unwrap().key, 11);
        assert_eq!(after.kind, CR::KIND_OCCUPATION);
        assert_eq!(after.flags, 0);
    }

    /// The program's per-call fold equals `conquest_model::fold` for
    /// every member state (absent, unopened, too early, held, lost) and
    /// random weights and captures.
    #[test]
    fn fold_hour_is_the_models() {
        let mut seed = 0x5eed_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..500 {
            let h = 2 + (next() % 20) as u32;
            let mut datas = alloc::vec::Vec::new();
            for _ in 0..7 {
                let mut pd = alloc::vec![0u8; P::SIZE];
                let ob = (next() % (6 * h as u64 + 12)) as u32;
                pd[P::OPENED_BELL..P::OPENED_BELL + 4].copy_from_slice(&ob.to_le_bytes());
                let rn = 6 * h + 1 + (next() % 3) as u32;
                pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&rn.to_le_bytes());
                for back in 0..6u32 {
                    let hh = if next() % 7 == 0 {
                        h + 6
                    } else {
                        h.saturating_sub(back)
                    };
                    let o = P::snap((hh % 6) as usize);
                    pd[o..o + 4].copy_from_slice(&hh.to_le_bytes());
                    for i in 0..P::SIDES {
                        let v = (next() % 3000) as u16;
                        pd[o + 4 + 2 * i..o + 6 + 2 * i].copy_from_slice(&v.to_le_bytes());
                    }
                }
                for f in 0..P::FACTIONS {
                    let v = (next() % 50) as u16;
                    pd[P::captures_by(f)..P::captures_by(f) + 2].copy_from_slice(&v.to_le_bytes());
                }
                datas.push((next() % 5 != 0).then_some(pd));
            }
            let views: [Option<&[u8]>; 7] = core::array::from_fn(|i| datas[i].as_deref());
            let want = cm::fold(&views, h).unwrap();
            let got = fold_hour(&views, h, fold_captures(&views).unwrap()).unwrap();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn home_ref_is_the_key_high_word() {
        let k = holding_key(3, -2, 7, 4).unwrap();
        assert_eq!((home_ref(k) as u64) << 32, k);
        assert_ne!(home_ref(k), 0);
    }

    #[test]
    fn mirror_walls_count_effective_items() {
        let mut pd = alloc::vec![0u8; P::SIZE];
        let o = P::site(2);
        pd[o + SM::WALLS_COMMITTED..o + SM::WALLS_COMMITTED + 4]
            .copy_from_slice(&100u32.to_le_bytes());
        pd[o + SM::WALL_ITEM0_BELL..o + SM::WALL_ITEM0_BELL + 4]
            .copy_from_slice(&10u32.to_le_bytes());
        pd[o + SM::WALL_ITEM0_DELTA..o + SM::WALL_ITEM0_DELTA + 4]
            .copy_from_slice(&50u32.to_le_bytes());
        assert_eq!(mirror_walls_at(&pd, 2, 9).unwrap(), 100);
        assert_eq!(mirror_walls_at(&pd, 2, 10).unwrap(), 150);
        assert_eq!(siege::required_bells(150, 0), 39);
    }
}
