//! VWL, part 4 — the WIDE ECONOMY and GARRISON of a playable-lane season
//! (Q16-1 = A continued, 2026-11-19): **WideEconomy** (0xDA op 3: the S1
//! Harvest, Build or Train over a wide holding) and **WideGarrison** (0xDA
//! op 4: Spearmen from the reserve into the site's pending garrison), the
//! wallet forms (an NFT resident's is WideResidentAct, still
//! `WideUnmodelled`). The program's handlers are `permutation-frontier`
//! `proc/wide_economy_exec.rs` `economy_as` and `proc/wide_garrison_exec.rs`
//! `garrison_as`.
//!
//! The state transition itself is the verifier's existing independent
//! replay (`crate::wide_economy::verify_transition`,
//! `crate::wide_garrison::verify_transition`: the receipt's digests, the
//! S1 holding economy, the lazy finality flip, the Citizen's bucket, the
//! site mirror or the pending garrison, the chain links, **every byte** of
//! the three post-states). Those replays take caller-supplied snapshots
//! and say so (`NOT_PROVEN`); this part supplies what they leave open,
//! from the archive:
//!
//! * the snapshots are the archive's: the Season, the Citizen, the holding
//!   and the province **before** the transaction, the three **after** it;
//! * the player prologue (`frontier_abi::prologue::player_prologue`: the
//!   Season Running with the S1 ruleset, the Citizen at its address, the
//!   actor its wallet or its unexpired session), this build's version;
//! * the holding at its canonical wide address, of this season and world,
//!   the Citizen's (`NotOwner`); the province at the canonical address of
//!   the holding's coordinate; three distinct accounts; the province
//!   writable for a mirror write and for a garrison;
//! * the record is the one the transaction printed (exactly one `PSW1`
//!   record), its action or delta the instruction's, its `now_ts` the
//!   transaction's time, its holding this holding;
//! * every account stays the program's, and no lamport moves (`judge`).
//!
//! A transaction whose logs do not carry its record (a truncated or
//! log-less archive) is `MissingData`.

use frontier_abi::world_index::economy::Snapshots;
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::{ProvinceKey, WideHostRef};

use super::claims::{holding_rec, province_of, signed, wide_before};
use super::*;
use crate::wide_economy::Refusal;

pub(super) fn judged(cmd: &WideCommand) -> Option<&'static str> {
    match cmd {
        WideCommand::Economy(_) => Some("WideEconomy"),
        WideCommand::Garrison(_) => Some("WideGarrison"),
        c => super::march::judged(c),
    }
}

/// What both handlers authenticate before their body, and the snapshots.
struct Scene {
    citizen: Key,
    holding: Key,
    province: Key,
    href: WideHostRef,
    season: Vec<u8>,
    before: [Vec<u8>; 3],
    after: [Vec<u8>; 3],
    /// Whether the transaction shows a post-state of the province.
    province_written: bool,
    record: Vec<u8>,
}

fn refusal(r: Refusal) -> Wrong {
    let code = match &r {
        Refusal::Season(_) | Refusal::Snapshot(_) => WIDE_ACCOUNTS,
        Refusal::State(_) | Refusal::Finality(_) => WIDE_RULE,
        _ => WIDE_REPLAY_MISMATCH,
    };
    fail(code, r.to_string())
}

fn scene(e: &Env, ix: &Ix, name: &str, province_w: bool) -> Result<Scene, Wrong> {
    n_accounts(ix, 6, name)?;
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, holding, province) = (k(3), k(4), k(5));
    writable(ix, 3, "the Citizen", true)?;
    writable(ix, 4, "the holding", true)?;
    if province_w {
        writable(ix, 5, "the province", true)?;
    }
    // The player prologue (steps 1–2), this build's Season.
    let sk = e.ctx.season;
    if k(2) != sk {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the third account is not this season's Season",
        ));
    }
    let sd = e.before(&sk, "the Season")?.data;
    let cd = e.before(&citizen, "the Citizen")?.data;
    {
        let (a0, a1) = (k(0), k(1));
        let views = [
            signed(e, &a0, &[], ix.accounts[0].1),
            signed(e, &a1, &[], ix.accounts[1].1),
            signed(e, &sk, &sd, ix.accounts[2].1),
            signed(e, &citizen, &cd, ix.accounts[3].1),
        ];
        // Steps 3–4 (the bucket, the end bell) are the replay's.
        let _start = frontier_abi::prologue::player_prologue(
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
        })?;
    }
    e.season_at(ix, 2, &[S::STATUS_RUNNING])?;
    let world = e.world()?;
    // The holding and its own province, canonical and the Citizen's.
    let ha = wide_before(e, &holding, "the holding")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the holding is absent (the program refuses BadAccount)",
        )
    })?;
    let h = holding_rec(e, &ha.data)?;
    if h.world != world {
        return Err(fail(WIDE_ACCOUNTS, "the holding is of another world"));
    }
    if holding != wh::holding_address(&e.ctx, h.coord, h.site) {
        return Err(fail(WIDE_ACCOUNTS, "the holding is not at its address"));
    }
    if h.owner_citizen != citizen {
        return Err(fail(
            WIDE_RULE,
            "the holding is not this Citizen's (the program refuses NotOwner)",
        ));
    }
    let (_p, pd) = province_of(e, &province, h.coord, world)?;
    if citizen == holding || citizen == province || holding == province {
        return Err(fail(WIDE_ACCOUNTS, "two positions name one account"));
    }
    let href = WideHostRef::new(ProvinceKey::new(world, h.coord), h.site, h.gen, 0)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the holding's reference: {er:?}")))?;
    // The post-states. A province the message lists read-only has none:
    // the runtime leaves it as it was.
    let owned = |k: &Key, what: &str| -> Result<Vec<u8>, Wrong> {
        let a = e.after(k, what)?;
        if a.owner.to_bytes() != e.ctx.program {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!("{what} is not owned by the program after"),
            ));
        }
        Ok(a.data)
    };
    let province_written = e.w.txs[e.tx].post.contains_key(&province);
    let after = [
        owned(&citizen, "the Citizen")?,
        owned(&holding, "the holding")?,
        if province_written {
            owned(&province, "the province")?
        } else {
            pd.clone()
        },
    ];
    // The record the transaction printed: exactly one.
    let logs = e.recs.get(e.tx).map(|t| t.logs.as_slice()).unwrap_or(&[]);
    let program = b58(&e.ctx.program);
    let mut bodies = super::super::vw_chains::psw1_bodies(logs, &program).map_err(|why| {
        Missing(format!(
            "the transaction's logs do not read ({why}): its wide record is not in the archive"
        ))
    })?;
    let record =
        match bodies.len() {
            1 => bodies.remove(0),
            0 => return Err(Missing(
                "the transaction's logs carry no wide record: the receipt is not in the archive"
                    .into(),
            )),
            n => {
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!("{n} wide records (the handler prints exactly one)"),
                ))
            }
        };
    Ok(Scene {
        citizen,
        holding,
        province,
        href,
        season: sd,
        before: [cd, ha.data, pd],
        after,
        province_written,
        record,
    })
}

impl Scene {
    fn snaps(v: &[Vec<u8>; 3]) -> Snapshots<'_> {
        Snapshots {
            citizen: &v[0],
            holding: &v[1],
            province: &v[2],
        }
    }
    /// The receipt's own claims against the transaction's.
    fn same(&self, e: &Env, href: &WideHostRef, now_ts: i64) -> Result<(), Wrong> {
        if *href != self.href {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                "the record names another holding than the instruction's",
            ));
        }
        if now_ts != e.now {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!(
                    "the record's now_ts {now_ts} is not the transaction's time {}",
                    e.now
                ),
            ));
        }
        Ok(())
    }
    fn wrote(&self) -> Vec<(Key, Lam)> {
        let mut w = vec![(self.citizen, Lam::Same), (self.holding, Lam::Same)];
        if self.province_written {
            w.push((self.province, Lam::Same));
        }
        w
    }
}

// ------------------------------------------------------------ 0xDA op 3

pub(super) fn economy(e: &Env, ix: &Ix, x: &wix::Economy) -> Result<Vec<(Key, Lam)>, Wrong> {
    if !x.action.is_valid() {
        return Err(fail(
            WIDE_RULE,
            "an action outside the canonical ranges (the program refuses BadData)",
        ));
    }
    let s = scene(e, ix, "WideEconomy", x.action.mirror_write())?;
    let v = crate::wide_economy::verify_transition(
        &s.record,
        &s.season,
        &Scene::snaps(&s.before),
        &Scene::snaps(&s.after),
    )
    .map_err(refusal)?;
    if v.action != x.action {
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "the record's action {:?} is not the instruction's {:?}",
                v.action, x.action
            ),
        ));
    }
    s.same(e, &v.holding_ref, v.now_ts)?;
    Ok(s.wrote())
}

// ------------------------------------------------------------ 0xDA op 4

pub(super) fn garrison(e: &Env, ix: &Ix, x: &wix::Garrison) -> Result<Vec<(Key, Lam)>, Wrong> {
    let s = scene(e, ix, "WideGarrison", true)?;
    let v = crate::wide_garrison::verify_transition(
        &s.record,
        &s.season,
        &Scene::snaps(&s.before),
        &Scene::snaps(&s.after),
    )
    .map_err(refusal)?;
    if v.delta != x.delta {
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "the record's delta {} is not the instruction's {}",
                v.delta, x.delta
            ),
        ));
    }
    s.same(e, &v.holding_ref, v.now_ts)?;
    Ok(s.wrote())
}
