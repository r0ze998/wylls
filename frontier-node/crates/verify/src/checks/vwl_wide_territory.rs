//! VWL, part 6 — PLAYER TERRITORY on wide land (#209 territory-impl, owner
//! decisions 2026-11-24 12:09 T-1 … T-8 and 13:15 TQ-1 … TQ-8; the keeper's
//! `territory` role of #221): the four territory instructions of a
//! playable-lane season, re-run from the states before them and compared
//! byte for byte with what they wrote (verifier-territory, 2026-11-25).
//! The program's handlers are `permutation-frontier`
//! `proc/wide_territory.rs` (`claim_tile_as`, `settle`, `decay`,
//! `conquer`); the rules are the shared pure kernels the handlers call
//! (`frontier_abi::world_index::territory`: `settle_upkeep`, `judge_claim`,
//! `apply_claim`, `apply_decay`, `transfer_tiles`; the records'
//! `read`/`write`), the deployed holding kernel (`crate::holding`, as VWL's
//! WideClaimSite pays its settler cost) and the shared prologue.
//!
//! * **WideClaimTile (0xDA op 7)** `[actor] [payer] [season] [citizen w]
//!   [province] [territory_province w] [territory_player w] [home w]
//!   [home_province] [system] [witness?] [village?]`: the player prologue
//!   (wallet form), this build's Season Running, before the end bell (a
//!   continuous world has none); a canonical coordinate of ring ≥ 129, its
//!   wide province of this world with a territory rule; the first home (the
//!   Citizen's slot-1 legacy binding, at its address, of the bound
//!   generation) final; both records at their canonical addresses, absent
//!   (created from the payer) or this season's/world's/coordinate's/
//!   Citizen's; the reach witness (1: the nation's land, as WideClaimSite's;
//!   2: a territory record where the claimer owns a tile, read only unless
//!   it is the target's own record); the village distance (the first home,
//!   or the claimer's own wide village); upkeep settled from the touched
//!   home first, then `judge_claim` on the settled summary, the ore paid,
//!   `apply_claim`. Written: both records, the Citizen (bucket,
//!   `LAST_ACTION_TS`, the `HARVEST` link) and the home (the touch, the
//!   upkeep, the ore, the `HARVEST` link).
//! * **WideTerritorySettle (0xDC op 12)** `[payer] [season] [territory_player
//!   w] [citizen w] [home w]`: the Season Running or Ended, this build's; the
//!   summary at the Citizen's address; the Citizen present. A first home
//!   that is gone (slot 1 no longer a legacy binding, or the canonical
//!   account not that village of the bound generation) pays nothing:
//!   `settle_upkeep(…, 0)`. Otherwise the home is touched and pays what
//!   `settle_upkeep` charges; the home and the Citizen change (the
//!   `HARVEST` link) only when something was charged.
//! * **WideTerritoryDecay (0xDC op 13)** `[payer] [season] [territory_player
//!   w] [territory_province w]`: the summary settled in this very second
//!   (`paid_to == now`: a settle earlier in the same transaction), the
//!   record at its address, then `apply_decay` (due after the grace, one a
//!   bell, the farthest bucket first).
//! * **WideTerritoryConquer (0xDC op 14)** `[payer] [season] [province]
//!   [territory_province w] [loser_player w] [captor_holding] [captor_citizen
//!   r|w] [captor_player w] [system]` (the captor Citizen writable or not:
//!   the keeper's settle of the captor in the same transaction makes it
//!   writable; conquest-upkeep-fix, owner Q-VT-1 (b); the flags rule is
//!   `wix::TERRITORY_CONQUER`'s, as the program's): the province's recorded captor at the
//!   keep's current generation; the captor home at its address and
//!   generation; its owner the captor Citizen, whose nation holds the keep;
//!   the loser no teammate; both summaries settled in this second (the
//!   captor's created here from the payer when absent); `transfer_tiles`
//!   (village tiles stay).
//!
//! **Whole transactions.** The keeper sends a decay after a settle of the
//! same summary, and a conquest after the settles of both owners, in ONE
//! transaction (the handlers require `paid_to == now`): the archive has no
//! state between those instructions. So a transaction whose program
//! instructions are all territory instructions is judged as a whole: each
//! instruction in order over the previous one's re-run state, and the
//! transaction's post-states compared with the end state (every other
//! program account unchanged, as everywhere in VWL). A territory
//! instruction beside any other program instruction stays `MissingData`.
//!
//! Lamports: a created record's balance is the runtime's rent from the
//! payer (not compared, as VWL's `Lam::Created`); every other program
//! account of the transaction keeps its lamports (more is `MissingData`, a
//! system transfer may have reached it; fewer is a FAIL). The payer's
//! balance (a wallet) and the rent gate on it are not judged.
//!
//! Not proved here: the printed `HARVEST` record itself (its body is the
//! chain link VWL checks on both accounts), signatures (the runtime's).
//! Continuous worlds: nothing of the season end is assumed; the claim's end
//! bell gate reads the Season's `end_bell` (`NO_END_BELL` in a continuous
//! world), and the cranks take Running or Ended as the program does.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::log::{EntityKind, Kind};
use frontier_abi::world_index::holding::{self as wh, SlotBinding};
use frontier_abi::world_index::territory::{
    self as wtr, ReachSource, TerritoryError, TerritoryPlayer, TerritoryProvince, TerritoryRule,
    TileClaim,
};
use frontier_abi::world_index::wide_ix::{self as wix, WideCommand};
use permutation_rules::frontier::holding::{Holding as KHolding, RESOURCES};

use super::*;
use crate::holding as hr;

/// The name VWL gives a territory instruction (`None`: not one).
pub(super) fn judged(cmd: &WideCommand) -> Option<&'static str> {
    match cmd {
        WideCommand::ClaimTile(_) => Some("WideClaimTile"),
        WideCommand::TerritorySettle(_) => Some("WideTerritorySettle"),
        WideCommand::TerritoryDecay(_) => Some("WideTerritoryDecay"),
        WideCommand::TerritoryConquer(_) => Some("WideTerritoryConquer"),
        _ => None,
    }
}

/// The territory instruction of `ix` (`None`: not one).
pub(super) fn of(ix: &Ix) -> Option<&'static str> {
    if !ix.tag().is_some_and(super::super::v0_coverage::is_wide_tag) {
        return None;
    }
    judged(&WideCommand::decode(&ix.data).ok()?)
}

fn terr(what: &str, er: TerritoryError) -> Wrong {
    use permutation_rules::frontier::territory::ClaimRefusal as CR;
    match er {
        TerritoryError::Length { .. }
        | TerritoryError::Magic
        | TerritoryError::Version { .. }
        | TerritoryError::Reserved
        | TerritoryError::Corrupt
        | TerritoryError::Mismatch => fail(
            WIDE_ACCOUNTS,
            format!("{what}: {er:?} (the program refuses BadAccount)"),
        ),
        TerritoryError::Claim(r) => {
            let code = match r {
                CR::NotOpen => "BadData",
                CR::AlreadyYours => "AlreadyDone",
                CR::Owned => "SiteTaken",
                CR::Range => "OutpostRule",
                CR::TurnLimit => "Cooldown",
                CR::UpkeepUnpaid => "NotEligible",
                CR::Insufficient => "Insufficient",
                CR::Overflow => "Overflow",
            };
            fail(
                WIDE_RULE,
                format!("{what}: the territory rules refuse the claim ({r:?}; the program refuses {code})"),
            )
        }
        TerritoryError::NotDue => fail(
            WIDE_RULE,
            format!("{what}: not due (the program refuses TooEarly)"),
        ),
        TerritoryError::NotFarthest => fail(
            WIDE_RULE,
            format!(
                "{what}: the tile is not of the farthest distance (the program refuses OutOfOrder)"
            ),
        ),
        TerritoryError::NotOwner => fail(
            WIDE_RULE,
            format!("{what}: not the owner's tile (the program refuses NotOwner)"),
        ),
        TerritoryError::BadTile => fail(
            WIDE_RULE,
            format!("{what}: no such tile (the program refuses BadData)"),
        ),
        TerritoryError::KeepTile => fail(
            WIDE_RULE,
            format!("{what}: the keep's tile (the program refuses ReservedSite)"),
        ),
        TerritoryError::Overflow => fail(
            WIDE_RULE,
            format!("{what}: overflows (the program refuses Overflow)"),
        ),
    }
}

fn h_err(er: String) -> Wrong {
    fail(WIDE_RULE, format!("the holding kernel refuses ({er})"))
}

/// The re-run's state of one transaction: every account read or written,
/// over the archive's states before the transaction.
struct St<'a, 'e> {
    e: &'a Env<'e>,
    m: BTreeMap<Key, Option<Account>>,
    written: BTreeSet<Key>,
    created: BTreeSet<Key>,
}

impl<'a, 'e> St<'a, 'e> {
    fn new(e: &'a Env<'e>) -> Self {
        St {
            e,
            m: BTreeMap::new(),
            written: BTreeSet::new(),
            created: BTreeSet::new(),
        }
    }
    /// The account as the re-run has it (absent: `None`, with the archive's
    /// knowledge rules: unknown is `MissingData`).
    fn get(&mut self, k: &Key, what: &str) -> Result<Option<Account>, Wrong> {
        if let Some(a) = self.m.get(k) {
            return Ok(a.clone());
        }
        let a = self.e.acct_before(k);
        let a = match a {
            Some(a) if a.lamports > 0 || !a.data.is_empty() => Some(a),
            _ if self.e.known_before(k) || (self.e.snapshot.is_none() && self.e.w.has_post) => None,
            _ => return Err(Missing(format!("{what}: the archive has no state before"))),
        };
        self.m.insert(*k, a.clone());
        Ok(a)
    }
    /// A program account present before (its data).
    fn prog(&mut self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        match self.get(k, what)? {
            Some(a) if a.owner.to_bytes() == self.e.ctx.program && !a.data.is_empty() => Ok(a.data),
            Some(a) if !a.data.is_empty() => Err(fail(
                WIDE_ACCOUNTS,
                format!("{what} is not owned by the program (the program refuses BadAccount)"),
            )),
            _ => Err(fail(
                WIDE_ACCOUNTS,
                format!("{what} is absent (the program refuses BadAccount)"),
            )),
        }
    }
    /// A program record that may be absent (`*_at`): `Ok(None)` absent.
    fn record(&mut self, k: &Key, what: &str) -> Result<Option<Vec<u8>>, Wrong> {
        match self.get(k, what)? {
            None => Ok(None),
            Some(a) if a.data.is_empty() && a.lamports == 0 => Ok(None),
            Some(a) if a.owner.to_bytes() != self.e.ctx.program => Err(fail(
                WIDE_ACCOUNTS,
                format!("{what} is not owned by the program (the program refuses BadAccount)"),
            )),
            Some(a) => Ok(Some(a.data)),
        }
    }
    fn put(&mut self, k: &Key, data: Vec<u8>) {
        let program = solana_address::Address::new_from_array(self.e.ctx.program);
        let a = match self.m.get(k).cloned().flatten() {
            Some(mut a) => {
                a.data = data;
                a.owner = program;
                a
            }
            None => Account {
                lamports: 0,
                data,
                owner: program,
                executable: false,
            },
        };
        self.m.insert(*k, Some(a));
        self.written.insert(*k);
    }
    fn create(&mut self, k: &Key, data: Vec<u8>) {
        self.put(k, data);
        self.created.insert(*k);
    }
}

/// The program's `check_accounts` over the ABI's account table of the
/// command (`frontier_abi::prologue::{counts_in, resolve_in, check_flags}`):
/// the count, a writable position where the table says writable, a program
/// account listed read-only not writable, the System program's key. Every
/// position reads as signed (signatures are the runtime's: a transaction
/// that landed carried them).
fn flags(ix: &Ix, groups: &[frontier_abi::prologue::Group], name: &str) -> Result<(), Wrong> {
    use frontier_abi::prologue::{self as ap, Acc, Spec, Wr};
    let n = ix.accounts.len();
    let count = || {
        fail(
            UNDECODABLE,
            format!("{name} with {n} accounts (the program refuses TooManyAccounts)"),
        )
    };
    let mut c = [0u8; 8];
    let ng = ap::counts_in(groups, n, &mut c).ok_or_else(count)?;
    let (_, hi) = ap::bounds_in(groups);
    if n > hi {
        return Err(count());
    }
    let none = Spec {
        name: "",
        acc: Acc::Any,
        signer: false,
        wr: Wr::R,
    };
    let mut specs = vec![none; hi];
    let m = ap::resolve_in(groups, c.get(..ng).ok_or_else(count)?, &mut specs).ok_or_else(count)?;
    if m != n {
        return Err(count());
    }
    let owner = [0u8; 32];
    let views: Vec<AccountView> = ix
        .accounts
        .iter()
        .map(|(k, w)| AccountView {
            key: k,
            owner: &owner,
            lamports: 0,
            data: &[],
            is_signer: true,
            is_writable: *w,
        })
        .collect();
    ap::check_flags(&specs[..n], &views).map_err(|er| {
        fail(
            WIDE_ACCOUNTS,
            format!("{name}: the account flags ({er:?}; the program refuses it)"),
        )
    })
}

fn season_hdr(e: &Env, ix: &Ix, at: usize) -> Result<frontier_abi::prologue::SeasonHdr, Wrong> {
    let sd = e.season_at(ix, at, &[S::STATUS_RUNNING, S::STATUS_ENDED])?;
    frontier_abi::prologue::read_season(&e.view(&e.ctx.season, &sd), &e.ctx.program, e.now)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the Season ({er:?})")))
}

fn now_bell(e: &Env, hdr: &frontier_abi::prologue::SeasonHdr) -> Result<u32, Wrong> {
    hdr.bell(e.now).ok_or_else(|| {
        fail(
            WIDE_RULE,
            "before genesis (the program refuses WrongStatus)",
        )
    })
}

/// The territory rule of a wide province's bytes.
fn rule_of(pd: &[u8]) -> Result<TerritoryRule, Wrong> {
    match wl::territory_rule_of(pd) {
        Some(Some(r)) => Ok(r),
        Some(None) => Err(fail(
            WIDE_RULE,
            "the wide province plays no territory rule (the program refuses NotImplemented)",
        )),
        None => Err(fail(
            WIDE_ACCOUNTS,
            "the wide province's territory byte (the program refuses BadAccount)",
        )),
    }
}

fn tprov_read(
    e: &Env,
    d: &[u8],
    world: WorldId,
    coord: Option<WideCoord>,
) -> Result<TerritoryProvince, Wrong> {
    let r = TerritoryProvince::read(d).map_err(|er| terr("the territory record", er))?;
    if r.season_id != e.sid || r.world != world || coord.is_some_and(|c| c != r.coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory record is of another season, world or province (the program refuses BadAccount)",
        ));
    }
    Ok(r)
}

fn tplayer_read(
    e: &Env,
    d: &[u8],
    world: WorldId,
    citizen: Option<&Key>,
) -> Result<TerritoryPlayer, Wrong> {
    let r = TerritoryPlayer::read(d).map_err(|er| terr("the territory summary", er))?;
    if r.season_id != e.sid || r.world != world || citizen.is_some_and(|c| *c != r.citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory summary is of another season, world or Citizen (the program refuses BadAccount)",
        ));
    }
    Ok(r)
}

fn write_prov(st: &mut St, k: &Key, r: &TerritoryProvince, new: bool) -> Result<(), Wrong> {
    let mut d = if new {
        vec![0u8; wtr::territory_province::SIZE]
    } else {
        st.prog(k, "the territory record")?
    };
    r.write(&mut d)
        .map_err(|er| terr("the territory record", er))?;
    if new {
        st.create(k, d);
    } else {
        st.put(k, d);
    }
    Ok(())
}

fn write_player(st: &mut St, k: &Key, r: &TerritoryPlayer, new: bool) -> Result<(), Wrong> {
    let mut d = if new {
        vec![0u8; wtr::territory_player::SIZE]
    } else {
        st.prog(k, "a territory summary")?
    };
    r.write(&mut d)
        .map_err(|er| terr("a territory summary", er))?;
    if new {
        st.create(k, d);
    } else {
        st.put(k, d);
    }
    Ok(())
}

/// `home_ref`: the first home of a Citizen's bytes (slot 1's legacy binding).
fn home_ref(cd: &[u8]) -> Option<wh::HoldingRef> {
    match wh::bindings_of(cd).ok()?[0] {
        SlotBinding::Legacy(h) => Some(h),
        _ => None,
    }
}

/// `check_home`: the first home at its address, the Citizen's, of the bound
/// generation. Returns its header and bytes.
fn check_home(
    st: &mut St,
    home: &Key,
    citizen: &Key,
    cd: &[u8],
) -> Result<(frontier_abi::prologue::HoldingHdr, Vec<u8>), Wrong> {
    let e = st.e;
    let r = home_ref(cd).ok_or_else(|| {
        fail(
            WIDE_RULE,
            "no legacy first home (the program refuses OutpostRule)",
        )
    })?;
    if *home != e.ctx.holding(r.p as i32, r.q as i32, r.site) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the home is not the first home's address",
        ));
    }
    let hd = st.prog(home, "the first home")?;
    let hh = frontier_abi::prologue::check_holding(&e.view(home, &hd), &e.ctx, e.sid, citizen)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the first home ({er:?})")))?;
    if hh.gen != r.gen {
        return Err(fail(
            WIDE_RULE,
            "the first home is not of the bound generation (the program refuses BadData)",
        ));
    }
    Ok((hh, hd))
}

/// `settle_into`: settles `pl`'s upkeep against the touched home `h`.
/// Returns whether `h`'s stores changed.
fn settle_into(
    pl: &mut TerritoryPlayer,
    h: &mut KHolding,
    now: i64,
    now_bell: u32,
) -> Result<bool, Wrong> {
    let prm = pl.rule.params();
    let avail = h.stock_at(now)[prm.upkeep_resource as usize];
    let s = wtr::settle_upkeep(pl, now, now_bell, avail).map_err(|er| terr("the upkeep", er))?;
    if s.charge > 0 {
        let mut cost = [0i64; RESOURCES];
        cost[prm.upkeep_resource as usize] = s.charge;
        h.pay(now, &cost).map_err(|er| {
            fail(
                WIDE_RULE,
                format!("the home cannot pay the upkeep it was charged ({er:?})"),
            )
        })?;
        return Ok(true);
    }
    Ok(false)
}

/// `write_home`: the touched home written back and the `HARVEST` record of
/// its stores chained into the Citizen and the home (`emit3`).
fn write_home(
    st: &mut St,
    home: &Key,
    citizen: &Key,
    hh: &frontier_abi::prologue::HoldingHdr,
    h: &KHolding,
    now_bell: u32,
) -> Result<(), Wrong> {
    let now = st.e.now;
    let mut hd = st.prog(home, "the first home")?;
    hr::write(&mut hd, h, now).map_err(h_err)?;
    let digest = hr::stores_digest(&hd).map_err(h_err)?;
    let mut key = [0u8; 9];
    key[..4].copy_from_slice(&(hh.p as i32).to_le_bytes());
    key[4..8].copy_from_slice(&(hh.q as i32).to_le_bytes());
    key[8] = hh.site;
    let mut body = [0u8; 800];
    let n = frontier_abi::log::write_body(Kind::HARVEST, now_bell, &key, &digest, &mut body)
        .ok_or_else(|| fail(WIDE_RULE, "the HARVEST record's widths"))?;
    let mut cd = st.prog(citizen, "the Citizen")?;
    link(&mut cd, EntityKind::Citizen, &body[..n])?;
    link(&mut hd, EntityKind::Holding, &body[..n])?;
    st.put(citizen, cd);
    st.put(home, hd);
    Ok(())
}

/// One event-chain link: `seq + 1`, `head = H(head ‖ seq ‖ body)`.
fn link(d: &mut [u8], entity: EntityKind, body: &[u8]) -> Result<(), Wrong> {
    use frontier_abi::layout::header as HDR;
    let seq = le(d, HDR::EVENT_SEQ, 8);
    let head: [u8; 32] = d[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32]
        .try_into()
        .map_err(|_| fail(WIDE_ACCOUNTS, "an event head"))?;
    let l = frontier_abi::log::advance(entity, seq, &head, body)
        .ok_or_else(|| fail(WIDE_RULE, "an event chain overflows"))?;
    wr_u64(d, HDR::EVENT_SEQ, l.seq);
    d[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32].copy_from_slice(&l.head);
    Ok(())
}

fn citizen_present(st: &mut St, k: &Key) -> Result<Vec<u8>, Wrong> {
    let d = st.prog(k, "the Citizen")?;
    if !st.e.present(k, &d, AccountKind::Citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the Citizen is not a Citizen of this season (the program refuses BadAccount)",
        ));
    }
    Ok(d)
}

// ------------------------------------------------------------ 0xDA op 7

fn claim_tile(st: &mut St, ix: &Ix, x: &wix::ClaimTile) -> Result<(), Wrong> {
    let e = st.e;
    flags(ix, WideCommand::ClaimTile(*x).accounts(), "WideClaimTile")?;
    if ix.accounts.len() != x.accounts_len() {
        return Err(fail(
            UNDECODABLE,
            format!(
                "WideClaimTile with {} accounts, its flags name {} (the program refuses TooManyAccounts)",
                ix.accounts.len(),
                x.accounts_len()
            ),
        ));
    }
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, province, tprov_k, tplayer_k, home) = (k(3), k(4), k(5), k(6), k(7));
    let rest = &ix.accounts[10..];
    let (witness_k, village_k) = match (x.witness != 0, x.village != 0) {
        (false, false) => (None, None),
        (true, false) => (Some(rest[0]), None),
        (false, true) => (None, Some(rest[0].0)),
        (true, true) => (Some(rest[0]), Some(rest[1].0)),
    };
    // the player prologue, this build's Season Running, the end bell
    let sk = e.ctx.season;
    if k(2) != sk {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the third account is not this season's Season",
        ));
    }
    let sd = st.prog(&sk, "the Season")?;
    let cd = st.prog(&citizen, "the Citizen")?;
    let start = {
        let (a0, a1) = (k(0), k(1));
        let views = [
            claims::signed(e, &a0, &[], ix.accounts[0].1),
            claims::signed(e, &a1, &[], ix.accounts[1].1),
            claims::signed(e, &sk, &sd, ix.accounts[2].1),
            claims::signed(e, &citizen, &cd, ix.accounts[3].1),
        ];
        frontier_abi::prologue::player_prologue(
            &views,
            &e.ctx.program,
            &RULESET_HASH_V3,
            e.now,
            true,
        )
        .map_err(|er| {
            fail(
                WIDE_ACCOUNTS,
                format!("the player prologue refuses ({er:?})"),
            )
        })?
    };
    e.season_at(ix, 2, &[S::STATUS_RUNNING])?;
    let hdr = start.season;
    let now_bell = now_bell(e, &hdr)?;
    if now_bell >= hdr.end_bell {
        return Err(fail(
            WIDE_RULE,
            "at or after the end bell (the program refuses WrongStatus)",
        ));
    }
    // the land
    let coord = WideCoord::checked(x.p, x.q).map_err(|_| {
        fail(
            WIDE_RULE,
            "not a canonical coordinate (the program refuses BadData)",
        )
    })?;
    if coord.ring() < wl::FIRST_WIDE_RING {
        return Err(fail(
            WIDE_RULE,
            "the coordinate is not past the disk (the program refuses BadData)",
        ));
    }
    let world = e.world()?;
    let (_prov, pd) = claims::province_of(e, &province, coord, world)?;
    let rule = rule_of(&pd)?;
    let keep_tile = frontier_abi::conquest_model::read_keep(&pd)
        .map_err(|_| fail(WIDE_ACCOUNTS, "the wide province's keep"))?
        .map_or(wl::NO_TILE, |kp| kp.tile);
    // the Citizen and its first home
    let tag = le(&cd, C::CITIZEN_TAG, 8);
    let faction = cd[C::FACTION];
    let (hh, _hd) = check_home(st, &home, &citizen, &cd)?;
    if hh.state != H::STATE_FINAL {
        return Err(fail(
            WIDE_RULE,
            "the first home is not final (the program refuses NotFinal)",
        ));
    }
    let home_coord = WideCoord::checked(hh.p as i64, hh.q as i64)
        .map_err(|_| fail(WIDE_RULE, "the first home's coordinate"))?;
    // the records
    if tprov_k != wtr::province_address(&e.ctx, coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory record is not at its address",
        ));
    }
    if tplayer_k != wtr::player_address(&e.ctx, &citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory summary is not at the Citizen's address",
        ));
    }
    let (mut tprov, tprov_new) = match st.record(&tprov_k, "the territory record")? {
        Some(d) => (tprov_read(e, &d, world, Some(coord))?, false),
        None => (
            TerritoryProvince::new(e.sid, rule, world, coord, keep_tile, k(1)),
            true,
        ),
    };
    let (pl, tplayer_new) = match st.record(&tplayer_k, "the territory summary")? {
        Some(d) => (tplayer_read(e, &d, world, Some(&citizen))?, false),
        None => (
            TerritoryPlayer::new(e.sid, rule, world, citizen, tag, faction, e.now, k(1)),
            true,
        ),
    };
    if pl.rule != rule || tprov.rule != rule {
        return Err(fail(
            WIDE_ACCOUNTS,
            "a territory record of another rule (the program refuses BadAccount)",
        ));
    }
    // the reach witness (T-2)
    let witness = match (x.witness, witness_k) {
        (wix::CLAIM_TILE_WITNESS_NONE, _) => None,
        (wix::CLAIM_TILE_WITNESS_NATION_LAND, Some((w, wwr))) => {
            if wwr {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "a writable reach witness (the program refuses BadAccount)",
                ));
            }
            let wc = claims::nation_land_witness(e, &w, world, faction, now_bell)?;
            Some(ReachSource::NationLand(wc))
        }
        (wix::CLAIM_TILE_WITNESS_OWN, Some((w, wwr))) => {
            if wwr && w != tprov_k {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "a writable own-land witness that is not the target's record (the program refuses BadAccount)",
                ));
            }
            let rec = if w == tprov_k {
                tprov.clone()
            } else {
                let d = st.prog(&w, "the own-land witness")?;
                let r =
                    TerritoryProvince::read(&d).map_err(|er| terr("the own-land witness", er))?;
                if r.season_id != e.sid || r.world != world {
                    return Err(fail(
                        WIDE_ACCOUNTS,
                        "the own-land witness is of another season or world (the program refuses BadAccount)",
                    ));
                }
                r
            };
            if w != wtr::province_address(&e.ctx, rec.coord) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the own-land witness is not at its record's address",
                ));
            }
            if rec.owned_by(tag) == 0 {
                return Err(fail(
                    WIDE_RULE,
                    "the claimer owns no tile of the own-land witness (the program refuses OutpostRule)",
                ));
            }
            Some(ReachSource::Own(rec.coord))
        }
        _ => {
            return Err(fail(
                UNDECODABLE,
                "the witness flag names no account (the program refuses TooManyAccounts)",
            ))
        }
    };
    // the village distance (TQ-2)
    let village_distance = match village_k {
        None => home_coord.distance(coord),
        Some(v) => {
            let d = st.prog(&v, "the village")?;
            let h = claims::holding_rec(e, &d)?;
            if h.world != world || h.owner_citizen != citizen {
                return Err(fail(
                    WIDE_RULE,
                    "the village is not the claimer's (the program refuses NotOwner)",
                ));
            }
            if v != wh::holding_address(&e.ctx, h.coord, h.site) {
                return Err(fail(WIDE_ACCOUNTS, "the village is not at its address"));
            }
            h.coord.distance(coord).min(home_coord.distance(coord))
        }
    };
    // upkeep first (T-5), then the claim
    let hd = st.prog(&home, "the first home")?;
    let mut h = hr::read(&hd).map_err(h_err)?;
    hr::touch(&mut h, e.now, hr::terrain_ore(&hd).map_err(h_err)?).map_err(h_err)?;
    let mut pl = pl;
    settle_into(&mut pl, &mut h, e.now, now_bell)?;
    let prm = rule.params();
    let balance = h.stock_at(e.now)[prm.cost_resource as usize].max(0) as u64 / MILLI as u64;
    let ok = wtr::judge_claim(&TileClaim {
        province: &tprov,
        tile: x.tile,
        claimer: &pl,
        home: home_coord,
        witness,
        village_distance,
        now_bell,
        balance,
    })
    .map_err(|er| terr("WideClaimTile", er))?;
    let mut cost = [0i64; RESOURCES];
    cost[prm.cost_resource as usize] = i64::try_from(ok.cost)
        .ok()
        .and_then(|c| c.checked_mul(MILLI))
        .ok_or_else(|| fail(WIDE_RULE, "the tile's price overflows"))?;
    h.pay(e.now, &cost).map_err(|er| {
        fail(
            WIDE_RULE,
            format!(
                "the first home cannot pay the tile ({er:?}; the program refuses Insufficient)"
            ),
        )
    })?;
    wtr::apply_claim(&mut tprov, &mut pl, x.tile, ok, now_bell)
        .map_err(|er| terr("WideClaimTile", er))?;
    // ---- the writes
    write_prov(st, &tprov_k, &tprov, tprov_new)?;
    write_player(st, &tplayer_k, &pl, tplayer_new)?;
    let mut cdw = cd;
    start
        .finish(&mut cdw, e.now)
        .map_err(|er| fail(WIDE_RULE, format!("the bucket refuses ({er:?})")))?;
    claims::wr_i64(&mut cdw, C::LAST_ACTION_TS, e.now);
    st.put(&citizen, cdw);
    write_home(st, &home, &citizen, &hh, &h, now_bell)
}

// ------------------------------------------------------------ 0xDC op 12

fn settle(st: &mut St, ix: &Ix) -> Result<(), Wrong> {
    let e = st.e;
    flags(ix, wix::TERRITORY_SETTLE, "WideTerritorySettle")?;
    let k = |i: usize| ix.accounts[i].0;
    let (tplayer_k, citizen, home) = (k(2), k(3), k(4));
    let hdr = season_hdr(e, ix, 1)?;
    let now_bell = now_bell(e, &hdr)?;
    let world = e.world()?;
    if tplayer_k != wtr::player_address(&e.ctx, &citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory summary is not at the Citizen's address",
        ));
    }
    let cd = citizen_present(st, &citizen)?;
    let d = st
        .record(&tplayer_k, "the territory summary")?
        .ok_or_else(|| {
            fail(
                WIDE_ACCOUNTS,
                "the territory summary is absent (the program refuses BadAccount)",
            )
        })?;
    let mut pl = tplayer_read(e, &d, world, Some(&citizen))?;
    // a first home that is gone pays nothing
    let gone = match home_ref(&cd) {
        None => true,
        Some(r) => {
            if home != e.ctx.holding(r.p as i32, r.q as i32, r.site) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the home is not the first home's address",
                ));
            }
            match st.get(&home, "the first home")? {
                Some(a) if a.owner.to_bytes() == e.ctx.program => {
                    match frontier_abi::prologue::check_holding(
                        &e.view(&home, &a.data),
                        &e.ctx,
                        e.sid,
                        &citizen,
                    ) {
                        Ok(hh) => hh.gen != r.gen,
                        Err(_) => true,
                    }
                }
                _ => true,
            }
        }
    };
    if gone {
        wtr::settle_upkeep(&mut pl, e.now, now_bell, 0).map_err(|er| terr("the upkeep", er))?;
        return write_player(st, &tplayer_k, &pl, false);
    }
    let (hh, hd) = check_home(st, &home, &citizen, &cd)?;
    let mut h = hr::read(&hd).map_err(h_err)?;
    hr::touch(&mut h, e.now, hr::terrain_ore(&hd).map_err(h_err)?).map_err(h_err)?;
    let changed = settle_into(&mut pl, &mut h, e.now, now_bell)?;
    write_player(st, &tplayer_k, &pl, false)?;
    if changed {
        write_home(st, &home, &citizen, &hh, &h, now_bell)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xDC op 13

fn decay(st: &mut St, ix: &Ix, x: &wix::TerritoryDecay) -> Result<(), Wrong> {
    let e = st.e;
    flags(ix, wix::TERRITORY_DECAY, "WideTerritoryDecay")?;
    let (tplayer_k, tprov_k) = (ix.accounts[2].0, ix.accounts[3].0);
    let hdr = season_hdr(e, ix, 1)?;
    let now_bell = now_bell(e, &hdr)?;
    let world = e.world()?;
    let d = st
        .record(&tplayer_k, "the territory summary")?
        .ok_or_else(|| {
            fail(
                WIDE_ACCOUNTS,
                "the territory summary is absent (the program refuses BadAccount)",
            )
        })?;
    let mut pl = tplayer_read(e, &d, world, None)?;
    if tplayer_k != wtr::player_address(&e.ctx, &pl.citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory summary is not at its Citizen's address",
        ));
    }
    if pl.paid_to != e.now {
        return Err(fail(
            WIDE_RULE,
            "the summary was not settled in this second (the program refuses OutOfOrder)",
        ));
    }
    let d = st.prog(&tprov_k, "the territory record")?;
    let mut tprov = tprov_read(e, &d, world, None)?;
    if tprov_k != wtr::province_address(&e.ctx, tprov.coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory record is not at its address",
        ));
    }
    wtr::apply_decay(&mut tprov, &mut pl, x.tile, now_bell)
        .map_err(|er| terr("WideTerritoryDecay", er))?;
    write_prov(st, &tprov_k, &tprov, false)?;
    write_player(st, &tplayer_k, &pl, false)
}

// ------------------------------------------------------------ 0xDC op 14

fn conquer(st: &mut St, ix: &Ix) -> Result<(), Wrong> {
    use frontier_abi::layout::province::{province as PV, site as SM};
    let e = st.e;
    flags(ix, wix::TERRITORY_CONQUER, "WideTerritoryConquer")?;
    let k = |i: usize| ix.accounts[i].0;
    let (province, tprov_k, loser_k, captor_h, captor_c, captor_k) =
        (k(2), k(3), k(4), k(5), k(6), k(7));
    let hdr = season_hdr(e, ix, 1)?;
    let _ = now_bell(e, &hdr)?;
    let world = e.world()?;
    // the province: a territory world's, its keep taken by a recorded host
    let pd = st.prog(&province, "the wide province")?;
    let prov = WideProvince::read(&pd)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the wide province: {er:?}")))?;
    if prov.season_id != e.sid || prov.world != world {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the wide province is of another season or world",
        ));
    }
    if province != wl::province_address(&e.ctx, prov.coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the wide province is not at its address",
        ));
    }
    let n = (pd[PV::SITE_COUNT] as usize)
        .min(permutation_rules::frontier::geometry::SITES_PER_PROVINCE);
    let mut village_tiles = [u8::MAX; 12];
    for (j, t) in village_tiles.iter_mut().enumerate().take(n) {
        if pd[PV::site(j) + SM::STATE] == SM::STATE_HOLDING {
            *t = pd[PV::SITES + j];
        }
    }
    let keep = frontier_abi::conquest_model::read_keep(&pd)
        .map_err(|_| fail(WIDE_ACCOUNTS, "the wide province's keep"))?
        .ok_or_else(|| {
            fail(
                WIDE_RULE,
                "the province has no keep (the program refuses TooEarly)",
            )
        })?;
    let captor = wl::captor_of(&pd)
        .map_err(|_| {
            fail(
                WIDE_ACCOUNTS,
                "the captor record does not read (the program refuses BadAccount)",
            )
        })?
        .ok_or_else(|| {
            fail(
                WIDE_RULE,
                "no captor recorded (the program refuses TooEarly)",
            )
        })?;
    let rule = rule_of(&pd)?;
    if captor.keep_gen != keep.gen {
        return Err(fail(
            WIDE_RULE,
            "the captor record is not of the keep's current generation (the program refuses TooEarly)",
        ));
    }
    // the captor: the owner of the capturing host's home village
    let home_addr = if captor.home.ring() < wl::FIRST_WIDE_RING {
        e.ctx
            .holding(captor.home.p() as i32, captor.home.q() as i32, captor.site)
    } else {
        wh::holding_address(&e.ctx, captor.home, captor.site)
    };
    if captor_h != home_addr {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the captor's home is not the recorded village's address",
        ));
    }
    let hd = st.prog(&captor_h, "the captor's home")?;
    let owner: Key = hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32]
        .try_into()
        .map_err(|_| fail(WIDE_ACCOUNTS, "the captor's home is short"))?;
    if hd[H::GEN] != captor.gen {
        return Err(fail(
            WIDE_RULE,
            "the captor's home is not of the recorded generation (the program refuses TooEarly)",
        ));
    }
    if captor_c != owner {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the captor Citizen does not own the captor's home",
        ));
    }
    let ccd = citizen_present(st, &captor_c)?;
    let (ctag, cfaction) = (le(&ccd, C::CITIZEN_TAG, 8), ccd[C::FACTION]);
    if keep.holder != cfaction {
        return Err(fail(
            WIDE_RULE,
            "the captor's nation does not hold the keep (the program refuses TooEarly)",
        ));
    }
    // the records
    if tprov_k != wtr::province_address(&e.ctx, prov.coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory record is not at its address",
        ));
    }
    let d = st
        .record(&tprov_k, "the territory record")?
        .ok_or_else(|| {
            fail(
                WIDE_ACCOUNTS,
                "the territory record is absent (the program refuses BadAccount)",
            )
        })?;
    let mut tprov = tprov_read(e, &d, world, Some(prov.coord))?;
    let d = st.record(&loser_k, "the loser's summary")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the loser's summary is absent (the program refuses BadAccount)",
        )
    })?;
    let mut loser = tplayer_read(e, &d, world, None)?;
    if loser_k != wtr::player_address(&e.ctx, &loser.citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the loser's summary is not at its Citizen's address",
        ));
    }
    if loser.faction == cfaction {
        return Err(fail(
            WIDE_RULE,
            "the loser is the captor's teammate (T-8; the program refuses NotEligible)",
        ));
    }
    if captor_k != wtr::player_address(&e.ctx, &captor_c) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the captor's summary is not at its Citizen's address",
        ));
    }
    let (mut cap, captor_new) = match st.record(&captor_k, "the captor's summary")? {
        Some(d) => (tplayer_read(e, &d, world, Some(&captor_c))?, false),
        None => (
            TerritoryPlayer::new(e.sid, rule, world, captor_c, ctag, cfaction, e.now, k(0)),
            true,
        ),
    };
    if loser.rule != rule || cap.rule != rule || tprov.rule != rule {
        return Err(fail(
            WIDE_ACCOUNTS,
            "a territory record of another rule (the program refuses BadAccount)",
        ));
    }
    if loser.paid_to != e.now || cap.paid_to != e.now {
        return Err(fail(
            WIDE_RULE,
            "a summary was not settled in this second (the program refuses OutOfOrder)",
        ));
    }
    let to_dist = u8::try_from(captor.home.distance(prov.coord)).unwrap_or(u8::MAX);
    wtr::transfer_tiles(&mut tprov, &mut loser, &mut cap, to_dist, &village_tiles)
        .map_err(|er| terr("WideTerritoryConquer", er))?;
    write_prov(st, &tprov_k, &tprov, false)?;
    write_player(st, &loser_k, &loser, false)?;
    write_player(st, &captor_k, &cap, captor_new)
}

// ------------------------------------------------------------ villages (T-6)

/// WideClaimSite in a territory world (`require_own_site`): the 13th
/// account the target's territory record (read only) at its address, the
/// site's tile the claimer's, no village on a neighbouring site.
pub(super) fn require_own_site(
    e: &Env,
    world: WorldId,
    coord: WideCoord,
    rec_k: &Key,
    pd: &[u8],
    site: u8,
    cd: &[u8],
) -> Result<(), Wrong> {
    use frontier_abi::layout::province::{province as PV, site as SM};
    if *rec_k != wtr::province_address(&e.ctx, coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the territory record is not at its address",
        ));
    }
    let a = claims::wide_before(e, rec_k, "the territory record")?.ok_or_else(|| {
        fail(
            WIDE_RULE,
            "no territory record: the claimer owns no tile here (the program refuses NotOwner)",
        )
    })?;
    let rec = tprov_read(e, &a.data, world, Some(coord))?;
    let tile = pd[PV::SITES + site as usize];
    let n = (pd[PV::SITE_COUNT] as usize)
        .min(permutation_rules::frontier::geometry::SITES_PER_PROVINCE);
    let sites: Vec<(u8, bool)> = (0..n)
        .map(|j| {
            (
                pd[PV::SITES + j],
                pd[PV::site(j) + SM::STATE] == SM::STATE_HOLDING,
            )
        })
        .collect();
    let tag = le(cd, C::CITIZEN_TAG, 8);
    if (tile as usize) >= rec.owner.len() || rec.owner[tile as usize] != tag {
        return Err(fail(
            WIDE_RULE,
            "the site's tile is not the claimer's (T-6; the program refuses NotOwner)",
        ));
    }
    if wtr::site_crowded(site, &sites) {
        return Err(fail(
            WIDE_RULE,
            "a village stands on a neighbouring site (TQ-6 (b); the program refuses ReservedSite)",
        ));
    }
    Ok(())
}

// ------------------------------------------------------------ the transaction

/// A transaction whose program instructions are all territory
/// instructions: each re-run in order, then every program account of the
/// transaction compared with the end state.
pub(super) fn judge_tx(e: &Env, ixs: &[Ix]) -> Result<(), Wrong> {
    let mut st = St::new(e);
    for (n, ix) in ixs.iter().enumerate() {
        let cmd = WideCommand::decode(&ix.data).map_err(|er| {
            fail(
                UNDECODABLE,
                format!("instruction {n}: the wide codec refuses the data ({er:?})"),
            )
        })?;
        let r = match &cmd {
            WideCommand::ClaimTile(x) => claim_tile(&mut st, ix, x),
            WideCommand::TerritorySettle(_) => settle(&mut st, ix),
            WideCommand::TerritoryDecay(x) => decay(&mut st, ix, x),
            WideCommand::TerritoryConquer(_) => conquer(&mut st, ix),
            _ => Err(fail(
                UNDECODABLE,
                format!("instruction {n} is not a territory instruction"),
            )),
        };
        r.map_err(|w| match w {
            Fail(c, d) if ixs.len() > 1 => Fail(c, format!("instruction {n}: {d}")),
            Missing(d) if ixs.len() > 1 => Missing(format!("instruction {n}: {d}")),
            w => w,
        })?;
    }
    let listed = |k: &Key| ixs.iter().any(|ix| ix.accounts.iter().any(|(x, _)| x == k));
    let prog = |a: &Option<Account>| {
        a.as_ref()
            .is_some_and(|a| a.owner.to_bytes() == e.ctx.program)
    };
    let post = &e.w.txs[e.tx].post;
    // every account the re-run wrote must be in the archive's post-states
    for k in &st.written {
        if !post.contains_key(k) {
            return Err(Missing(format!(
                "account {} was written, but the archive has no post-state of it",
                b58(k)
            )));
        }
    }
    for (k, a) in post {
        let before = e.acct_before(k);
        if !prog(&before) && !prog(a) {
            continue;
        }
        if !listed(k) {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!("account {} changed, but no instruction lists it", b58(k)),
            ));
        }
        if a.as_ref().is_some_and(|a| a.executable) || before.as_ref().is_some_and(|b| b.executable)
        {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!("account {} is executable", b58(k)),
            ));
        }
        if st.written.contains(k) {
            let want = st.m.get(k).cloned().flatten();
            let (Some(want), Some(got)) = (want, a) else {
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!(
                        "account {} is absent after, but the re-run wrote it",
                        b58(k)
                    ),
                ));
            };
            if got.owner.to_bytes() != e.ctx.program {
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!("account {} is not owned by the program after", b58(k)),
                ));
            }
            if got.data != want.data {
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!(
                        "account {} is not the re-run's ({})",
                        b58(k),
                        first_diff(&got.data, &want.data)
                    ),
                ));
            }
            if st.created.contains(k) {
                // (created from the payer: the runtime's rent; a record
                //  that existed before is never re-created by the re-run)
                continue;
            }
        } else {
            let same = match (&before, a) {
                (Some(b), Some(a)) => b.data == a.data && b.owner == a.owner,
                (None, None) => true,
                _ => false,
            };
            if !same {
                if before.is_none() && !e.known_before(k) && a.is_some() && e.snapshot.is_some() {
                    return Err(Missing(format!(
                        "account {}: the witness has no state before",
                        b58(k)
                    )));
                }
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!(
                        "account {} changed, which these handlers never write",
                        b58(k)
                    ),
                ));
            }
        }
        match (&before, a) {
            (Some(b), Some(a)) => lamports_unchanged(b.lamports, a.lamports, k)?,
            (None, Some(_)) if st.written.contains(k) => {
                return Err(Missing(format!(
                    "account {}: the archive has no balance before",
                    b58(k)
                )))
            }
            _ => {}
        }
    }
    Ok(())
}

/// (test-gaps-territory) `settle_into` over the shared Q-LP17-1 (b) upkeep vectors.
#[cfg(test)]
#[path = "vwl_wide_territory_upkeep_b_tests.rs"]
mod upkeep_b_tests;
