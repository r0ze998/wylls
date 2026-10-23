//! S1 (redesign stage 1, 1e): nations — proposals and votes on stances
//! and expulsion (`docs/frontier/stage1e/S1-1E-CONTRACT.md` §3; decisions
//! K1 and K2).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xBB | Propose | [`propose`] |
//! | 0xBC | Vote | [`vote`] |
//! | 0xBD | SettleProposal | [`settle_proposal`] |
//!
//! A faction's Nation account (`na‖faction`, created at its first
//! Propose) holds four proposal slots (`nation::Proposal`). The rules are
//! the kernel's (`permutation_rules::frontier::nation`): who is eligible,
//! the window, the quorum, the readmission wait.
//!
//! Pinned here:
//! - **One vote a Citizen**: the Citizen's `VOTED[slot]` keeps the id it
//!   voted on in that slot (a slot's next proposal has a new id).
//! - **One open proposal a proposer**: the Citizen's `PROPOSED` keeps its
//!   last proposal's id; Propose refuses while that one is open
//!   (`ProposalState`).
//! - **The target** of a stance proposal is the Nation itself; of an
//!   expulsion a member of the nation other than the proposer; of a
//!   readmission a village of the nation expelled at least
//!   `READMIT_BELLS` ago (`ProposalState` otherwise).
//! - **Settlement** re-checks the target: an expulsion whose target was
//!   expelled meanwhile (or a readmission of one readmitted meanwhile)
//!   settles as failed. A passed expulsion stamps `EXPELLED_SINCE` and sets
//!   `FLAG_EXPELLED` on every live holding of the target, which must all be
//!   listed in its holding-reference order; a readmission clears both.
//!   Every other settlement lists no holding.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::host_id;
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::holding::FLAG_EXPELLED;
use frontier_abi::v2::layout::s1::nation as NA;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{CqKind, EntityKind as E2};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::frontier::nation::{
    self as kn, Proposal, KIND_EXPEL, KIND_READMIT, KIND_STANCE, STATE_FAILED, STATE_OPEN,
    STATE_PASSED,
};
use permutation_rules::frontier::structure::NATIONS;

use super::conquest::{check_accounts_v2, cq, cqlog, holding_ref, present_v2, season_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner};
use crate::layout::{citizen2 as C, holding2 as H, season2 as S, Ro, Rw};
use crate::prologue::{self, expect_key, key};
use crate::{FrontierError, R};

/// The record key of a proposal: `faction ‖ id`.
fn key5(faction: u8, id: u32) -> [u8; 5] {
    let mut k = [0u8; 5];
    k[0] = faction;
    k[1..].copy_from_slice(&id.to_le_bytes());
    k
}

fn read_proposal(nd: &[u8], slot: usize) -> R<Proposal> {
    if slot >= NA::N {
        return Err(FrontierError::BadData.into());
    }
    let o = NA::at(slot);
    Proposal::decode(nd.get(o..).ok_or(BAD_ACCOUNT)?).ok_or(BAD_ACCOUNT)
}

fn write_proposal(nd: &mut [u8], slot: usize, x: &Proposal) -> R<()> {
    let o = NA::at(slot);
    x.encode(nd.get_mut(o..).ok_or(BAD_ACCOUNT)?)
        .ok_or(BAD_ACCOUNT)
}

/// The bell a timestamp falls in (0 before genesis).
fn bell_of(genesis_ts: i64, ts: i64) -> u32 {
    frontier_abi::prologue::bell_at(genesis_ts, ts).unwrap_or(0)
}

/// The proposer's or voter's faction, after the eligibility rule
/// (`NotVoter`).
fn eligible(pl: &Player, citizen: &AccountInfo) -> R<u8> {
    let cd = citizen.try_borrow_data()?;
    let r = Ro(&cd);
    let expelled = r.i64(C::EXPELLED_SINCE)? != 0;
    if !kn::eligible(r.u32(C::JOIN_BELL)?, expelled, pl.pc.now_bell) {
        return Err(cq(CqError::NotVoter));
    }
    let f = r.u8(C::FACTION)?;
    if f as usize >= NATIONS {
        return Err(cq(CqError::NotVoter));
    }
    Ok(f)
}

/// A present Citizen of this season (the target of an expulsion or a
/// readmission): `(faction, tag, expelled_since)`.
fn target_citizen(p: &Pubkey, sid: u64, ai: &AccountInfo) -> R<(u8, u64, i64)> {
    present_v2(ai, p, K2::Citizen, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    Ok((
        r.u8(C::FACTION)?,
        r.u64(C::CITIZEN_TAG)?,
        r.i64(C::EXPELLED_SINCE)?,
    ))
}

/// Sets or clears a holding's `FLAG_EXPELLED` from its owner's Citizen
/// (every path that gives a holding an owner calls it, so a village
/// expelled before it founds, settles or captures a holding is flagged
/// there too, and a holding captured from an expelled village is not).
pub(crate) fn mark_holding(holding: &mut [u8], owner_citizen: &[u8]) -> R<()> {
    let expelled = Ro(owner_citizen).i64(C::EXPELLED_SINCE)? != 0;
    let f = Ro(holding).u8(H::FLAGS)?;
    let f = if expelled {
        f | FLAG_EXPELLED
    } else {
        f & !FLAG_EXPELLED
    };
    Rw(holding).set_u8(H::FLAGS, f)
}

// ------------------------------------------------------------ 0xBB Propose

/// 0xBB Propose(kind, target_faction, value): P + `[nation w] [target
/// r|w] [system]` (1e contract §3.3).
pub fn propose(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::Propose, a, None)?;
    let x = ix2::Propose::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, nation, target, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let now_bell = pl.pc.now_bell;
    let faction = eligible(&pl, citizen)?;
    expect_key(nation, &frontier_abi::v2::addr::nation(&pl.ctx, faction))?;
    // The target, by kind.
    let (target_faction, value, target_tag, target_key) = match x.kind {
        KIND_STANCE => {
            if !kn::stance_ok(faction, x.target_faction, x.value) {
                return Err(FrontierError::BadData.into());
            }
            if target.key != nation.key {
                return Err(BAD_ACCOUNT);
            }
            (x.target_faction, x.value, 0u64, [0u8; 32])
        }
        KIND_EXPEL | KIND_READMIT => {
            if x.target_faction != faction || x.value != 0 || target.key == citizen.key {
                return Err(FrontierError::BadData.into());
            }
            let (tf, tag, since) = target_citizen(p, sid, target)?;
            let ok = tf == faction
                && if x.kind == KIND_EXPEL {
                    since == 0
                } else {
                    since != 0
                        && kn::readmittable(bell_of(pl.pc.season.genesis_ts, since), now_bell)
                };
            if !ok {
                return Err(cq(CqError::ProposalState));
            }
            (faction, 0, tag, target.key.to_bytes())
        }
        _ => return Err(FrontierError::BadData.into()),
    };
    // The Nation: created at the first Propose.
    if init::is_absent(nation) {
        let signer = SeasonSigner::new(sid, pl.pc.season.bump);
        let seed = frontier_abi::v2::addr::nation_seed(faction);
        let rent = init::rent(NA::SIZE)?;
        init::init_with_seed(payer, nation, season_ai, &signer, &seed, NA::SIZE, rent, p)?;
        let mut nd = nation.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut nd, K2::Nation, sid) {
            return Err(BAD_ACCOUNT);
        }
        let mut w = Rw(&mut nd);
        w.set_u8(NA::FACTION, faction)?;
        w.set_u32(NA::NEXT_ID, 1)?;
    } else {
        present_v2(nation, p, K2::Nation, sid)?;
    }
    let proposed = Ro(&citizen.try_borrow_data()?).u32(C::PROPOSED)?;
    let (slot, id) = {
        let nd = nation.try_borrow_data()?;
        let mut free = None;
        for i in 0..NA::N {
            let q = read_proposal(&nd, i)?;
            if q.state == STATE_OPEN && proposed != 0 && q.id == proposed {
                return Err(cq(CqError::ProposalState));
            }
            if free.is_none() && q.free() {
                free = Some(i);
            }
        }
        (
            free.ok_or(cq(CqError::ProposalsFull))?,
            Ro(&nd).u32(NA::NEXT_ID)?,
        )
    };
    let close_bell = now_bell.checked_add(kn::WINDOW_BELLS).ok_or(OVERFLOW)?;
    let proposer_tag = pl.pc.citizen_tag;
    {
        let mut nd = nation.try_borrow_mut_data()?;
        write_proposal(
            &mut nd,
            slot,
            &Proposal {
                id,
                state: STATE_OPEN,
                kind: x.kind,
                target_faction,
                value,
                open_bell: now_bell,
                close_bell,
                yes: 0,
                no: 0,
                proposer_tag,
                target: target_key,
            },
        )?;
        Rw(&mut nd).set_u32(NA::NEXT_ID, id.checked_add(1).ok_or(OVERFLOW)?)?;
    }
    Rw(&mut citizen.try_borrow_mut_data()?).set_u32(C::PROPOSED, id)?;
    let payload = crate::events::Buf::<24>::new()
        .u8(slot as u8)
        .u8(x.kind)
        .u8(target_faction)
        .u8(value)
        .u64(proposer_tag)
        .u64(target_tag)
        .u32(close_bell);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut nd = nation.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::NATION_PROPOSED as u8,
        now_bell,
        &key5(faction, id),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Nation,
                data: &mut nd,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xBC Vote

/// 0xBC Vote(slot, id, yes): P + `[nation w]` (1e contract §3.3).
pub fn vote(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::Vote, a, None)?;
    let x = ix2::Vote::decode(d)?;
    if x.yes > 1 {
        return Err(FrontierError::BadData.into());
    }
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, _season, citizen, nation] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let now_bell = pl.pc.now_bell;
    let faction = eligible(&pl, citizen)?;
    expect_key(nation, &frontier_abi::v2::addr::nation(&pl.ctx, faction))?;
    present_v2(nation, p, K2::Nation, sid)?;
    let slot = x.slot as usize;
    let mut q = read_proposal(&nation.try_borrow_data()?, slot)?;
    if q.id != x.id || !q.open_at(now_bell) {
        return Err(cq(CqError::ProposalState));
    }
    let voted = C::VOTED + 4 * slot;
    if Ro(&citizen.try_borrow_data()?).u32(voted)? == x.id {
        return Err(FrontierError::AlreadyDone.into());
    }
    if x.yes == 1 {
        q.yes = q.yes.checked_add(1).ok_or(OVERFLOW)?;
    } else {
        q.no = q.no.checked_add(1).ok_or(OVERFLOW)?;
    }
    write_proposal(&mut nation.try_borrow_mut_data()?, slot, &q)?;
    Rw(&mut citizen.try_borrow_mut_data()?).set_u32(voted, x.id)?;
    let payload = crate::events::Buf::<13>::new()
        .u64(pl.pc.citizen_tag)
        .u8(x.yes)
        .u16(q.yes)
        .u16(q.no);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut nd = nation.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::NATION_VOTED as u8,
        now_bell,
        &key5(faction, x.id),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Nation,
                data: &mut nd,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xBD SettleProposal

/// 0xBD SettleProposal(slot, id): `[fee_payer s,w] [season w] [nation w]
/// [target r|w] [holding w ×0..3]` (1e contract §3.3), permissionless once
/// the proposal has closed.
pub fn settle_proposal(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_hold = a
        .len()
        .checked_sub(4)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::SettleProposal, a, Some(&[1, n_hold as u8]))?;
    let x = ix2::SettleProposal::decode(d)?;
    let now = prologue::now()?;
    let [_fee_payer, season_ai, nation, target, holdings @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let bell = hdr.bell(now.ts).ok_or(cq(CqError::ProposalState))?;
    present_v2(nation, p, K2::Nation, sid)?;
    let faction = Ro(&nation.try_borrow_data()?).u8(NA::FACTION)?;
    expect_key(nation, &frontier_abi::v2::addr::nation(&ctx, faction))?;
    let slot = x.slot as usize;
    let mut q = read_proposal(&nation.try_borrow_data()?, slot)?;
    if q.id != x.id || !q.settles_at(bell) {
        return Err(cq(CqError::ProposalState));
    }
    let mut passed = kn::passes(q.yes, q.no);
    let mut target_tag = 0u64;
    let mut hkeys = [0u64; 3];
    let membership = q.kind == KIND_EXPEL || q.kind == KIND_READMIT;
    if q.kind == KIND_STANCE {
        if target.key != nation.key {
            return Err(BAD_ACCOUNT);
        }
    } else if membership {
        if target.key.to_bytes() != q.target {
            return Err(BAD_ACCOUNT);
        }
        let (tf, tag, since) = target_citizen(p, sid, target)?;
        target_tag = tag;
        // Still applies? (Another proposal may have settled it meanwhile.)
        let applies = tf == faction && (since == 0) == (q.kind == KIND_EXPEL);
        passed &= applies;
    } else {
        return Err(BAD_ACCOUNT);
    }
    let flags = passed && membership;
    if !flags && !holdings.is_empty() {
        return Err(FrontierError::TooManyAccounts.into());
    }
    if passed {
        if q.kind == KIND_STANCE {
            let o = S::STANCES + faction as usize * NATIONS + q.target_faction as usize;
            Rw(&mut season_ai.try_borrow_mut_data()?).set_u8(o, q.value)?;
        } else {
            // Every live holding of the target, in its reference order.
            let td = target.try_borrow_data()?;
            let mut want = [None; 3];
            let mut n = 0usize;
            for (i, w) in want.iter_mut().enumerate() {
                let (hp, hq, site, gen) = holding_ref(&td, (i + 1) as u8)?;
                if gen != C::EMPTY_GEN {
                    *w = Some((hp, hq, site, gen));
                    n += 1;
                }
            }
            drop(td);
            if holdings.len() != n {
                return Err(FrontierError::TooManyAccounts.into());
            }
            let set = q.kind == KIND_EXPEL;
            for (k, (hp, hq, site, gen)) in want.into_iter().flatten().enumerate() {
                let h = &holdings[k];
                expect_key(h, &ctx.holding(hp as i32, hq as i32, site))?;
                present_v2(h, p, K2::Holding, sid)?;
                let mut hd = h.try_borrow_mut_data()?;
                if Ro(&hd).u8(H::GEN)? != gen {
                    return Err(BAD_ACCOUNT);
                }
                let f = Ro(&hd).u8(H::FLAGS)?;
                let f = if set {
                    f | FLAG_EXPELLED
                } else {
                    f & !FLAG_EXPELLED
                };
                Rw(&mut hd).set_u8(H::FLAGS, f)?;
                hkeys[k] = host_id(hp as i32, hq as i32, site, gen, 0).ok_or(BAD_ACCOUNT)?;
            }
            let since = if set { now.ts } else { 0 };
            Rw(&mut target.try_borrow_mut_data()?).set_i64(C::EXPELLED_SINCE, since)?;
        }
    }
    q.state = if passed { STATE_PASSED } else { STATE_FAILED };
    write_proposal(&mut nation.try_borrow_mut_data()?, slot, &q)?;
    let mut hk = [0u8; 24];
    for (i, k) in hkeys.iter().enumerate() {
        hk[8 * i..8 * i + 8].copy_from_slice(&k.to_le_bytes());
    }
    let payload = crate::events::Buf::<40>::new()
        .u8(passed as u8)
        .u8(q.kind)
        .u8(q.target_faction)
        .u8(q.value)
        .u64(target_tag)
        .u16(q.yes)
        .u16(q.no)
        .bytes(&hk);
    // Chains in entity order: Season (a passed stance), the target Citizen
    // and its holdings (a passed membership change), the Nation.
    let mut sd = season_ai.try_borrow_mut_data()?;
    let mut nd = nation.try_borrow_mut_data()?;
    let mut tdm = if flags {
        Some(target.try_borrow_mut_data()?)
    } else {
        None
    };
    let mut hds = holdings
        .iter()
        .map(|h| h.try_borrow_mut_data())
        .collect::<Result<alloc::vec::Vec<_>, _>>()?;
    let mut chained: alloc::vec::Vec<Chained2> = alloc::vec::Vec::with_capacity(6);
    if passed && q.kind == KIND_STANCE {
        chained.push(Chained2 {
            entity: E2::Season,
            data: &mut sd,
        });
    }
    if let Some(t) = tdm.as_mut() {
        chained.push(Chained2 {
            entity: E2::Citizen,
            data: t,
        });
    }
    for h in hds.iter_mut() {
        chained.push(Chained2 {
            entity: E2::Holding,
            data: h,
        });
    }
    chained.push(Chained2 {
        entity: E2::Nation,
        data: &mut nd,
    });
    cqlog::emit(
        CqKind::NATION_DECIDED as u8,
        bell,
        &key5(faction, q.id),
        payload.get()?,
        &mut chained,
    )
}

extern crate alloc;
