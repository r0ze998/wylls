//! VL — the land preview's two instructions in a PLAYABLE-lane season
//! (program version 0x4804, `playable-lane` build only; Q16-1 = A,
//! 2026-11-18). The program's handlers are `permutation-frontier`
//! `proc/land.rs`; the rule is `permutation_rules::frontier::land`
//! ("Standing Ground" in reduced form) at `LandParams::PREVIEW`, the
//! devnet-playable build's constant.
//!
//! Every successful **FoldLand** (0xCD) and **ClaimLandYield** (0xCE) is
//! re-run from the states the archive shows before it (`World::state_before`)
//! and its written accounts must be the re-run's, byte for byte:
//!
//! * the accounts: the Season is this season's and was Running at the
//!   transaction's time (the keeper prologue, `check_season` with the S1
//!   ruleset); the Province is this season's v2 Province at its own address;
//!   the land record is the province's (`ld‖p‖q` under the Season); for a
//!   fold the fifth account is the system program and every further one a
//!   present land record of this season at its own address; for a claim the
//!   Holding is this season's, at its address, in that Province, and its
//!   site holds it (state, generation, nation);
//! * **FoldLand**: a new record begins at `resolved_next − 1` with every
//!   site paid to there; then at most `max_bells` (1..=8) bells are folded
//!   strictly in order while below `resolved_next`, each by the land kernel
//!   over the Province and the neighbours (`land_preview::fold_province`);
//! * **ClaimLandYield**: at least one folded bell is unpaid for the site
//!   (else the program refuses: `TooEarly`); the Holding is settled to the
//!   transaction's time (tier-aware, [`crate::holding::settle_tiered`]),
//!   credited `production × bonus × bells / 6` per resource with the bonus
//!   of its nation in that Province (`land::bonus_bps`), and the site's
//!   yield bell moves to the record's next bell.
//!
//! What VL does **not** prove, and why that is not a PASS hole: the byte
//! codec and the kernel are the shared crates (as V7's clash replay), so a
//! defect common to both is not seen; the lamports of a new record are not
//! checked (V0E's post-states cover what was written). A land instruction
//! that shares its transaction with another program instruction is
//! `MissingData` (the archive has no state between the two).
//!
//! Codes: `Undecodable` (data or account count the program refuses),
//! `LandAccounts` (an account the program would refuse), `LandTooEarly`,
//! `LandReplayMismatch` (a written account is not the re-run's), and
//! `MissingData`.

use frontier_abi::land_preview::{self as fl, land as LD, LandHeader};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::layout::province::{province as P, site as SM};
use frontier_abi::v2::layout::AccountKind as K2;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use permutation_rules::frontier::land::{self as kland, LandParams};

use super::Ctx;
use crate::codes::*;
use crate::world::{Ix, Key, World};

const V: &str = "VL";
/// The devnet-playable build's land numbers (`proc::land::PARAMS`).
pub const PARAMS: LandParams = LandParams::PREVIEW;
const SYSTEM: Key = [0; 32];

/// Why one instruction is not the program's, in the order the program
/// checks.
enum Wrong {
    /// The program refuses it: a FAIL.
    Fail(&'static str, String),
    /// The archive lacks a state the re-run needs.
    Missing(String),
}
use Wrong::*;

fn acc(c: &'static str, d: impl Into<String>) -> Wrong {
    Fail(c, d.into())
}

struct Env<'a> {
    w: &'a World,
    ctx: frontier_abi::addr::AddrCtx,
    sid: u64,
    tx: usize,
    now: i64,
}

impl Env<'_> {
    fn before(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.w
            .state_before(k, self.tx)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| Missing(format!("{what}: the archive has no state before")))
    }
    fn after(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.w
            .state_after(k, self.tx)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| Missing(format!("{what}: the archive has no post-state")))
    }
    /// The keeper prologue over the Season's state before.
    fn season(&self, ix: &Ix) -> Result<(), Wrong> {
        let k = ix
            .key(1)
            .ok_or_else(|| acc(UNDECODABLE, "no Season account"))?;
        if k != self.ctx.season {
            return Err(acc(
                LAND_ACCOUNTS,
                "the second account is not this season's Season",
            ));
        }
        let d = self.before(&k, "the Season")?;
        let view = frontier_abi::prologue::AccountView {
            key: &k,
            owner: &self.ctx.program,
            lamports: 1,
            data: &d,
            is_signer: false,
            is_writable: false,
        };
        frontier_abi::prologue::check_season(
            &view,
            &self.ctx.program,
            Some(&frontier_abi::v2::presets::RULESET_HASH_V3),
            &[frontier_abi::layout::world::season::STATUS_RUNNING],
            self.now,
        )
        .map(|_| ())
        .map_err(|e| {
            acc(
                LAND_ACCOUNTS,
                format!("the Season is not this program's Running S1-ruleset Season at the transaction's time ({e:?})"),
            )
        })
    }
    /// A present v2 account of `kind` of this season (the program's
    /// `present_v2`; the archive keeps program-owned states only).
    fn present(&self, k: &Key, d: &[u8], kind: K2) -> bool {
        let view = frontier_abi::prologue::AccountView {
            key: k,
            owner: &self.ctx.program,
            lamports: 1,
            data: d,
            is_signer: false,
            is_writable: false,
        };
        frontier_abi::v2::prologue::check_present_v2(&view, &self.ctx.program, kind, self.sid)
            .is_ok()
    }
    /// A v2 Province of this season at its own address: its bytes and `(p, q)`.
    fn province(&self, k: &Key) -> Result<(Vec<u8>, i16, i16), Wrong> {
        let d = self.before(k, "the Province")?;
        if !self.present(k, &d, K2::Province) {
            return Err(acc(
                LAND_ACCOUNTS,
                "the Province is not a v2 Province of this season",
            ));
        }
        let (p, q) = (le(&d, P::P, 2) as u16 as i16, le(&d, P::Q, 2) as u16 as i16);
        if *k != self.ctx.province(p as i32, q as i32) {
            return Err(acc(LAND_ACCOUNTS, "the Province is not at its own address"));
        }
        Ok((d, p, q))
    }
    /// A present land record of this season at its own address.
    fn land(&self, k: &Key, d: &[u8]) -> Result<LandHeader, Wrong> {
        if d.len() != LD::SIZE {
            return Err(acc(LAND_ACCOUNTS, "a land record of the wrong size"));
        }
        let h = fl::read_header(d)
            .map_err(|_| acc(LAND_ACCOUNTS, "a land record that does not decode"))?;
        if h.season_id != self.sid || *k != fl::land_address(&self.ctx, h.p, h.q) {
            return Err(acc(
                LAND_ACCOUNTS,
                "a land record of another season or not at its own address",
            ));
        }
        Ok(h)
    }
}

fn le(d: &[u8], o: usize, n: usize) -> u64 {
    crate::world::le(d.get(o..o + n).unwrap_or(&[]))
}

/// FoldLand: `[fee_payer s,w] [season] [province] [land w] [system]` + up
/// to six neighbouring land records; data `[tag, max_bells]`.
fn fold(e: &Env, ix: &Ix) -> Result<(), Wrong> {
    let n = ix.accounts.len();
    if !(fl::FOLD_FIXED..=fl::FOLD_FIXED + 6).contains(&n) || ix.data.len() != 2 {
        return Err(acc(
            UNDECODABLE,
            format!(
                "FoldLand with {n} accounts and {} data bytes",
                ix.data.len()
            ),
        ));
    }
    e.season(ix)?;
    let (pk, lk, sys) = (ix.accounts[2].0, ix.accounts[3].0, ix.accounts[4].0);
    if sys != SYSTEM {
        return Err(acc(
            LAND_ACCOUNTS,
            "the fifth account is not the system program",
        ));
    }
    if !ix.accounts[3].1 {
        return Err(acc(LAND_ACCOUNTS, "the land record is not writable"));
    }
    let (pd, pp, pq) = e.province(&pk)?;
    if lk != fl::land_address(&e.ctx, pp, pq) {
        return Err(acc(LAND_ACCOUNTS, "the land record is not the Province's"));
    }
    let resolved_next = le(&pd, P::RESOLVED_NEXT, 4) as u32;
    let mut ld = match e.w.state_before(&lk, e.tx).filter(|d| !d.is_empty()) {
        Some(d) => d.to_vec(),
        None => {
            // The record is made here: it begins at the last resolved bell.
            let start = resolved_next.saturating_sub(1);
            let mut d = vec![0u8; LD::SIZE];
            fl::write_header(
                &mut d,
                &LandHeader {
                    season_id: e.sid,
                    p: pp,
                    q: pq,
                    yield_bell: [start; 12],
                },
            )
            .map_err(|_| acc(LAND_ACCOUNTS, "the new land record's header"))?;
            d
        }
    };
    e.land(&lk, &ld)?;
    let mut next: Vec<(ProvinceCoord, Vec<u8>)> = vec![];
    for (k, _) in &ix.accounts[fl::FOLD_FIXED..] {
        let d = e.before(k, "a neighbouring land record")?;
        let h = e.land(k, &d)?;
        next.push((ProvinceCoord::new(h.p as i32, h.q as i32), d));
    }
    let refs: Vec<(ProvinceCoord, &[u8])> = next.iter().map(|(c, v)| (*c, v.as_slice())).collect();
    let max = ix.data[1].clamp(1, fl::MAX_FOLD_BELLS);
    let heartland = fl::heartland_of(&pd);
    for _ in 0..max {
        let fresh = le(&ld, LD::VERSION, 2) == 0;
        let b = if fresh {
            fl::read_header(&ld).map(|h| h.yield_bell[0])
        } else {
            fl::read_land(&ld).map(|l| l.next_bell)
        }
        .map_err(|_| acc(LAND_ACCOUNTS, "the land record does not decode"))?;
        if b >= resolved_next {
            break;
        }
        fl::fold_province(&pd, &mut ld, &refs, b, heartland, &PARAMS).map_err(|er| {
            acc(
                LAND_ACCOUNTS,
                format!("the land kernel refuses bell {b}: {er:?}"),
            )
        })?;
    }
    let got = e.after(&lk, "the land record")?;
    if got != ld {
        let at = got.iter().zip(&ld).position(|(a, b)| a != b);
        return Err(acc(
            LAND_REPLAY_MISMATCH,
            format!("FoldLand wrote a land record that is not the re-run's (first differing byte {at:?}, {} vs {} bytes)", got.len(), ld.len()),
        ));
    }
    Ok(())
}

/// ClaimLandYield: `[fee_payer s,w] [season] [province] [land w] [holding w]`; data `[tag]`.
fn claim(e: &Env, ix: &Ix) -> Result<(), Wrong> {
    if ix.accounts.len() != 5 || ix.data.len() != 1 {
        return Err(acc(
            UNDECODABLE,
            format!(
                "ClaimLandYield with {} accounts and {} data bytes",
                ix.accounts.len(),
                ix.data.len()
            ),
        ));
    }
    e.season(ix)?;
    let (pk, lk, hk) = (ix.accounts[2].0, ix.accounts[3].0, ix.accounts[4].0);
    if !ix.accounts[3].1 || !ix.accounts[4].1 {
        return Err(acc(
            LAND_ACCOUNTS,
            "the land record or the Holding is not writable",
        ));
    }
    let hd = e.before(&hk, "the Holding")?;
    if !e.present(&hk, &hd, K2::Holding) {
        return Err(acc(
            LAND_ACCOUNTS,
            "the Holding is not a Holding of this season",
        ));
    }
    let (hp, hq) = (
        le(&hd, H::P, 2) as u16 as i16,
        le(&hd, H::Q, 2) as u16 as i16,
    );
    let (site, gen, faction) = (hd[H::SITE], hd[H::GEN], hd[H::FACTION]);
    if hk != e.ctx.holding(hp as i32, hq as i32, site) {
        return Err(acc(LAND_ACCOUNTS, "the Holding is not at its own address"));
    }
    let (pd, pp, pq) = e.province(&pk)?;
    if (pp, pq) != (hp, hq) || site as usize >= P::SITES_N {
        return Err(acc(LAND_ACCOUNTS, "the Province is not the Holding's"));
    }
    let o = P::site(site as usize);
    if pd[o + SM::STATE] != SM::STATE_HOLDING
        || pd[o + SM::GEN] != gen
        || pd[o + SM::FACTION] != faction
    {
        return Err(acc(LAND_ACCOUNTS, "the Holding's site does not hold it"));
    }
    let ld = e.before(&lk, "the land record")?;
    let mut h = e.land(&lk, &ld)?;
    if (h.p, h.q) != (pp, pq) {
        return Err(acc(LAND_ACCOUNTS, "the land record is not the Province's"));
    }
    let l =
        fl::read_land(&ld).map_err(|_| acc(LAND_ACCOUNTS, "the land record does not decode"))?;
    let paid_to = h.yield_bell[site as usize];
    let bells = l.next_bell.saturating_sub(paid_to);
    if bells == 0 {
        return Err(acc(
            LAND_TOO_EARLY,
            format!(
                "no folded bell is unpaid for site {site} (paid to {paid_to}, folded to {})",
                l.next_bell
            ),
        ));
    }
    let x =
        fl::province_inputs(&pd).map_err(|_| acc(LAND_ACCOUNTS, "the Province's land inputs"))?;
    let bonus = kland::bonus_bps(&l, &x.sites, faction, &PARAMS);
    let mut k =
        crate::holding::read(&hd).map_err(|er| acc(LAND_ACCOUNTS, format!("the Holding: {er}")))?;
    let ore = crate::holding::terrain_ore(&hd).map_err(|er| acc(LAND_ACCOUNTS, er))?;
    crate::holding::settle_tiered(&mut k, e.now, ore)
        .map_err(|er| acc(LAND_ACCOUNTS, format!("the settle: {er}")))?;
    let y = fl::yield_for(k.production, bonus, bells);
    for (i, amount) in y.iter().enumerate().take(RESOURCES) {
        if *amount > 0 {
            k.credit(e.now, Resource::ALL[i], *amount)
                .map_err(|er| acc(LAND_ACCOUNTS, format!("the credit: {er:?}")))?;
        }
    }
    let mut want_h = hd.clone();
    crate::holding::write(&mut want_h, &k, e.now)
        .map_err(|er| acc(LAND_ACCOUNTS, format!("the Holding write: {er}")))?;
    h.yield_bell[site as usize] = l.next_bell;
    let mut want_l = ld.clone();
    fl::write_header(&mut want_l, &h).map_err(|_| acc(LAND_ACCOUNTS, "the land header"))?;
    for (k, want, what) in [(hk, want_h, "the Holding"), (lk, want_l, "the land record")] {
        let got = e.after(&k, what)?;
        if got != want {
            let at = got.iter().zip(&want).position(|(a, b)| a != b);
            return Err(acc(
                LAND_REPLAY_MISMATCH,
                format!("ClaimLandYield ({bells} bells, bonus {bonus} bps) wrote {what} that is not the re-run's (first differing byte {at:?})"),
            ));
        }
    }
    Ok(())
}

pub fn run(cx: &mut Ctx) {
    let pv = cx.f.params.as_ref().map(|p| p.program_version);
    if !super::v0_coverage::playable(pv) {
        return; // V0 judges land tags under every other version
    }
    let w = cx.w;
    let ctx = findex::addr_ctx(&cx.cfg.program, cx.cfg.season_id);
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        for ix in &t.ixs {
            let Some(tag) = ix.tag().filter(|t| fl::is_land_tag(*t)) else {
                continue;
            };
            let name = if tag == fl::TAG_FOLD_LAND {
                "FoldLand"
            } else {
                "ClaimLandYield"
            };
            if t.ixs.len() != 1 {
                cx.missing(V, format!("tx#{i}"), 0, Some(i), format!("{name} shares its transaction with another program instruction: the archive has no state between them"));
                continue;
            }
            let e = Env {
                w,
                ctx,
                sid: cx.cfg.season_id,
                tx: i,
                now: t.time,
            };
            let r = if tag == fl::TAG_FOLD_LAND {
                fold(&e, ix)
            } else {
                claim(&e, ix)
            };
            match r {
                Ok(()) => {}
                Err(Fail(code, d)) => cx.fail(
                    V,
                    code,
                    format!("tx#{i}"),
                    0,
                    Some(i),
                    format!("{name}: {d}"),
                ),
                Err(Missing(d)) => {
                    cx.missing(V, format!("tx#{i}"), 0, Some(i), format!("{name}: {d}"))
                }
            }
        }
    }
}
