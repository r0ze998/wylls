//! Player territory's class-D crank on a devnet world (devnet-territory-dev; owner NWP-2, 2026-11-24 19:28: "the new
//! world only after territory is playable on devnet = keeper A runs upkeep/decay"). Role `territory`, feature
//! `playable-lane`, class D.
//!
//! **Why.** In a territory world (WideSetRules keep holder `NeutralTerritoryV1`, #209; program
//! `proc/wide_territory.rs`) the player's claim (0xDA op 7 WideClaimTile, wallet-paid from the page) is the only
//! territory write a player sends. Three effects of the owner's rules (12:09 T-4/T-5/T-8, 13:15 TQ-1..TQ-8) happen
//! only when someone sends the permissionless cranks:
//!
//! 1. **upkeep** — 0xDC op 12 WideTerritorySettle charges the food owed since the last settle from the first home
//!    (all or nothing); a home that cannot pay makes the territory *unpaid since this bell* (claims refused). Land
//!    nobody settles is never charged and never becomes unpaid, so it could never decay;
//! 2. **decay** — after 24 unpaid bells, 0xDC op 13 WideTerritoryDecay lets go one tile of the farthest distance per
//!    bell (it needs the settle in the same second: one transaction, settle then decay; a separate settle first, so
//!    that a home that can pay again is charged even when the decay is then refused — verify-pr206-209);
//! 3. **conquest** — after a keep capture (the captor the wide Resolve stamped into the province trailer, at the
//!    keep's current generation, its nation still holding the keep), 0xDC op 14 WideTerritoryConquer moves every tile
//!    of one non-teammate owner of that province to the captor (both summaries settled in the same transaction).
//!
//! The local runner's duty (`itest::wide_territory`, TEST only) does the same in play-local worlds; this role is its
//! devnet counterpart. Both plan with the ONE pure planner [`crate::widelane::territory::plan`].
//!
//! **What.** Once a bell (and again [`SCAN_SLOTS`] later while the bell lasts, for writes the engine dropped): read
//! every known Citizen's territory summary (`wu‖hash(citizen)`), every known territory province record
//! (`wn‖hash(sort key)`) and its wide province (the captor record and the keep), the captors' home villages and
//! Citizens; plan; and `ensure` each step under its own key ([`key_settle`], [`key_decay`], [`key_conquer`]). At most
//! `territory_per_bell` steps a bell (rotating start, as the local runner). Plain settles only every
//! `territory_settle_bells` bells (default 1); decay and conquest every bell.
//!
//! **Which accounts** (no program-account scan exists on `ChainPort`):
//! - the summaries of every Citizen the feed index knows (JOIN / RESIDENT_JOINED records): a territory summary is
//!   created only by that Citizen's claim or a conquest naming it, so no summary is missed;
//! - the territory province records of every wide province a SUCCESSFUL WideClaimTile in the feed named
//!   ([`claimed_provinces`], `LandIndex::territory_provinces`): a record is created only by a claim of a tile in that
//!   province, so no record is missed either. A restart re-reads the feed from cursor 0 and finds them again.
//!
//! **Refusals.** The engine's refusal hold and group breaker (#192, `engine.rs`) apply as to every class-D write: a
//! step refused with the same program code backs off, a whole kind refused by many keys opens the group breaker.
//! Expected refusals: a decay of a home that can pay again (`NotEligible` / the settle-alone step pays it), a
//! conquest whose keep moved again (`TooEarly`), a settle in the same second as the player's claim (harmless).
//!
//! **Who pays.** keeper A's class-D pool: the fees, and — only for a conquest whose captor never claimed a tile — the
//! rent of the captor's 320-byte territory summary (≈0.0023 SOL at 5,080 lamports/byte; the program creates it from
//! the payer, `proc/wide_territory.rs conquer`). Claimers pay their own records (owner TQ-12 (a), 21:51).
//! No player pays anything here.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::abi::{status, Class};
use fclient::ports::{Account, ChainPort, PortResult, TxRecord};
use frontier_abi::layout::player::holding as H;
use frontier_abi::world_index::holding::{self as wh, SlotBinding};
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::territory::{self as wtr, TerritoryPlayer, TerritoryProvince};
use frontier_abi::world_index::wide_ix::{WideCommand, WideIx};
use frontier_abi::world_index::WideCoord;
use serde_json::{json, Value};
use solana_address::Address;

use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::landindex::LandIndex;
use crate::widelane::territory::{self as kt, Step, View};
use crate::Tick;

/// Slots between two scans inside one bell (writes the engine dropped are planned again).
pub const SCAN_SLOTS: u64 = 75;
/// CU limits. Measured in operator_playable P18 on the devnet `.so` 31acbb59 (devnet-territory-dev): a settle
/// ≤ 16,242 CU, settle + decay 24,324, settle × 2 + conquer (the captor's summary created) 38,333. The limits leave
/// room for larger HARVEST chains; the class-D bid is per CU of the limit.
pub const CU_SETTLE: u32 = 60_000;
pub const CU_DECAY: u32 = 90_000;
pub const CU_CONQUER: u32 = 200_000;
/// Landed / refused keys kept for the status (the newest).
pub const KEEP: usize = 64;

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

fn short(k: &[u8; 32]) -> String {
    adr(*k).to_string()
}

/// The write key of a plain upkeep settle of `citizen` at `bell`.
pub fn key_settle(citizen: &[u8; 32], bell: u32) -> String {
    format!("terr-settle:{}:{bell}", short(citizen))
}

/// The write key of a decay (settle then decay, one transaction) of `citizen` at `bell`.
pub fn key_decay(citizen: &[u8; 32], bell: u32) -> String {
    format!("terr-decay:{}:{bell}", short(citizen))
}

/// The write key of a conquest transfer of `loser`'s tiles of `province` after the capture of keep generation `gen`.
pub fn key_conquer(province: WideCoord, loser: &[u8; 32], keep_gen: u32) -> String {
    format!(
        "terr-conquer:{},{}:{}:{keep_gen}",
        province.p(),
        province.q(),
        short(loser)
    )
}

/// The write key of a step planned at `bell`.
pub fn key_of(s: &Step, bell: u32) -> String {
    match s {
        Step::Settle { citizen } => key_settle(citizen, bell),
        Step::Decay { citizen, .. } => key_decay(citizen, bell),
        Step::Conquer {
            province,
            loser,
            captor_holding,
            ..
        } => key_conquer(*province, loser, captor_holding.keep_gen),
    }
}

/// Whether a write key is this role's.
pub fn is_key(k: &str) -> bool {
    k.starts_with("terr-")
}

/// The kind of a step (status counters, the engine's duty kind).
pub fn kind_of(s: &Step) -> &'static str {
    match s {
        Step::Settle { .. } => "territory-settle",
        Step::Decay { .. } => "territory-decay",
        Step::Conquer { .. } => "territory-conquer",
    }
}

/// The wide provinces a SUCCESSFUL transaction's WideClaimTile instructions of `program` name (a territory record
/// may exist there). Undecodable transactions and other instructions name none. Pure.
pub fn claimed_provinces(tx: &TxRecord, program: &Address) -> Vec<(i64, i64)> {
    if tx.err.is_some() {
        return vec![];
    }
    let Ok(t) = fclient::vtx::decode(&tx.tx) else {
        return vec![];
    };
    let Ok(ixs) = t.instructions_resolved(&tx.loaded) else {
        return vec![];
    };
    ixs.into_iter()
        .filter(|(pid, _, _)| pid == program)
        .filter_map(|(_, _, data)| match WideCommand::decode(&data) {
            Ok(WideCommand::ClaimTile(x)) => Some((x.p, x.q)),
            _ => None,
        })
        .collect()
}

/// A canonical holding address no account can ever have (site 255 is past every province's 12 sites): named as the
/// "first home" of a Citizen whose slot 1 binds no legacy village, so that the program's gone-home settle (upkeep
/// unpaid; `proc/wide_territory.rs settle`) still runs for its land (verify-pr206-209: such land was otherwise never
/// settled and never decayed).
pub fn no_home(a: &fclient::addr::Addresses) -> Address {
    a.holding(0, 0, 255)
}

/// The first home of a Citizen's account bytes, or [`no_home`].
pub fn home_of(a: &fclient::addr::Addresses, citizen_data: Option<&[u8]>) -> (Address, bool) {
    match citizen_data
        .and_then(|d| wh::bindings_of(d).ok())
        .map(|b| b[0])
    {
        Some(SlotBinding::Legacy(h)) => (a.holding(h.p as i32, h.q as i32, h.site), true),
        _ => (no_home(a), false),
    }
}

/// Plain settles only every `every` bells (decay's own settle-alone step, and every decay / conquest, always). Pure.
pub fn thin_settles(steps: Vec<Step>, bell: u32, every: u64) -> Vec<Step> {
    if every <= 1 || u64::from(bell) % every == 0 {
        return steps;
    }
    let decaying: BTreeSet<[u8; 32]> = steps
        .iter()
        .filter_map(|s| match s {
            Step::Decay { citizen, .. } => Some(*citizen),
            _ => None,
        })
        .collect();
    steps
        .into_iter()
        .filter(|s| match s {
            Step::Settle { citizen } => decaying.contains(citizen),
            _ => true,
        })
        .collect()
}

/// Rotates and caps a bell's steps as the local runner does (the start moves each bell, so the last are not
/// starved). Pure.
pub fn cap_steps(mut steps: Vec<Step>, bell: u32, per_bell: usize) -> Vec<Step> {
    let per_bell = per_bell.max(1);
    if steps.len() > per_bell {
        let k = (bell as usize).wrapping_mul(per_bell) % steps.len();
        steps.rotate_left(k);
        steps.truncate(per_bell);
    }
    steps
}

async fn read_all<P: ChainPort>(port: &P, keys: &[Address]) -> PortResult<Vec<Option<Account>>> {
    let mut got = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(100) {
        got.extend(port.accounts(chunk, 0).await?);
    }
    Ok(got)
}

#[derive(Default)]
pub struct TerritoryDuty {
    last_bell: Option<u32>,
    last_scan: Option<u64>,
    /// verify-pr221: the keys that LANDED in the current bell. The engine forgets a key once it lands, and a plain
    /// settle is due again as soon as the clock moves past `paid_to` (seconds), so without this every rescan of a
    /// bell ([`SCAN_SLOTS`], about 20 a 600-s bell on devnet) sent the same settle again. Cleared on a new bell.
    landed_now: BTreeSet<String>,
    /// What the last scan saw (status).
    pub players: usize,
    pub with_tiles: usize,
    pub unpaid: usize,
    pub provinces: usize,
    pub captured: usize,
    pub tiles: u64,
    /// Steps planned (ensured), landed and refused, by kind.
    pub planned: BTreeMap<&'static str, u64>,
    pub landed: BTreeMap<&'static str, u64>,
    pub refused_n: BTreeMap<&'static str, u64>,
    /// Steps skipped because the Citizen's slot 1 binds no legacy village (its gone-home settle is still sent).
    pub no_home: u64,
    /// The newest landed keys `(key, slot)` and refusals `(key, why)`.
    pub recent: Vec<(String, u64)>,
    pub refused: Vec<(String, String)>,
    /// The last scan's plan, one line per step (status).
    pub last_plan: Vec<String>,
}

fn kind_of_key(k: &str) -> &'static str {
    if k.starts_with("terr-settle:") {
        "territory-settle"
    } else if k.starts_with("terr-decay:") {
        "territory-decay"
    } else {
        "territory-conquer"
    }
}

impl TerritoryDuty {
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) {
        let kind = kind_of_key(key);
        match o {
            Outcome::Landed { slot, .. } => {
                self.landed_now.insert(key.to_string());
                *self.landed.entry(kind).or_default() += 1;
                self.recent.push((key.to_string(), *slot));
                if self.recent.len() > KEEP {
                    self.recent.remove(0);
                }
            }
            Outcome::Failed { err, code, .. } | Outcome::Dead { reason: err, code } => {
                eprintln!("frontier-keeper: territory: {key} refused: {err} (code {code:?})");
                *self.refused_n.entry(kind).or_default() += 1;
                self.refused
                    .push((key.to_string(), format!("{err} (code {code:?})")));
                if self.refused.len() > KEEP {
                    self.refused.remove(0);
                }
            }
            Outcome::Unresolved { .. } => {}
        }
    }

    /// The steps whose write did not land yet in this bell (verify-pr221: one settle a bell, not one a rescan).
    pub fn not_landed(&self, steps: Vec<Step>, bell: u32) -> Vec<Step> {
        steps
            .into_iter()
            .filter(|s| !self.landed_now.contains(&key_of(s, bell)))
            .collect()
    }

    pub fn status(&self, index: &LandIndex) -> Value {
        json!({
            "players": self.players,
            "with_tiles": self.with_tiles,
            "unpaid": self.unpaid,
            "tiles": self.tiles,
            "provinces": self.provinces,
            "provinces_from_feed": index.territory_provinces.len(),
            "captured": self.captured,
            "planned": self.planned,
            "landed": self.landed,
            "refused_count": self.refused_n,
            "no_home": self.no_home,
            "recent": self.recent.iter().rev().take(8).map(|(k, s)| json!({"key": k, "slot": s})).collect::<Vec<_>>(),
            "refused": self.refused.iter().rev().take(16).map(|(k, s)| json!({"key": k, "why": s})).collect::<Vec<_>>(),
            "last_plan": self.last_plan,
        })
    }

    /// The chain as the planner sees it (module doc), plus each Citizen's first home.
    async fn view<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        index: &LandIndex,
    ) -> PortResult<(View, BTreeMap<[u8; 32], (Address, bool)>)> {
        let program = t.addrs.program;
        let c = crate::widelane::ctx(t.addrs);
        let sid = t.addrs.season_id;
        let mut v = View::default();
        // the summaries of the known Citizens
        let citizens: Vec<[u8; 32]> = index.citizens.keys().map(|z| z.to_bytes()).collect();
        let pkeys: Vec<Address> = citizens
            .iter()
            .map(|z| adr(wtr::player_address(&c, z)))
            .collect();
        for (z, a) in citizens.iter().zip(read_all(port, &pkeys).await?) {
            if let Some(p) = a
                .filter(|a| a.owner == program)
                .and_then(|a| TerritoryPlayer::read(&a.data).ok())
                .filter(|p| p.season_id == sid && p.citizen == *z)
            {
                v.players.push(p);
            }
        }
        // the province records of the claimed provinces, and their wide provinces
        let coords: Vec<WideCoord> = index
            .territory_provinces
            .iter()
            .filter_map(|&(p, q)| WideCoord::checked(p, q).ok())
            .collect();
        let mut keys = Vec::with_capacity(coords.len() * 2);
        for x in &coords {
            keys.push(adr(wtr::province_address(&c, *x)));
            keys.push(adr(wl::province_address(&c, *x)));
        }
        let got = read_all(port, &keys).await?;
        for (i, x) in coords.iter().enumerate() {
            let rec = got[2 * i]
                .as_ref()
                .filter(|a| a.owner == program)
                .and_then(|a| TerritoryProvince::read(&a.data).ok())
                .filter(|p| p.season_id == sid && p.coord == *x);
            let Some(rec) = rec else { continue };
            v.provinces.push(rec);
            let Some(pa) = got[2 * i + 1].as_ref().filter(|a| a.owner == program) else {
                continue;
            };
            if !WideProvince::read(&pa.data).is_ok_and(|p| p.season_id == sid && p.coord == *x) {
                continue;
            }
            let (Ok(Some(cap)), Ok(Some(keep))) = (
                wl::captor_of(&pa.data),
                frontier_abi::conquest_model::read_keep(&pa.data),
            ) else {
                continue;
            };
            if keep.gen == cap.keep_gen {
                v.captured.push((*x, cap, keep.holder));
                v.village_tiles.insert(*x, kt::village_tiles_of(&pa.data));
            }
        }
        // the captors' home villages, then their Citizens' factions
        let hkeys: Vec<Address> = v
            .captured
            .iter()
            .map(|(_, cap, _)| kt::captor_holding(t.addrs, cap))
            .collect();
        let mut owners: Vec<(WideCoord, u8, [u8; 32])> = vec![];
        for ((_, cap, _), h) in v.captured.iter().zip(read_all(port, &hkeys).await?) {
            let Some(h) = h.filter(|a| a.owner == program) else {
                continue;
            };
            let (Some(o), Some(gen)) = (
                h.data.get(H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32),
                h.data.get(H::GEN),
            ) else {
                continue;
            };
            if *gen == cap.gen {
                owners.push((cap.home, cap.site, o.try_into().unwrap()));
            }
        }
        // the Citizens: the captors' (faction) and every player's (first home)
        let mut zs: BTreeSet<[u8; 32]> = v.players.iter().map(|p| p.citizen).collect();
        zs.extend(owners.iter().map(|(_, _, o)| *o));
        let zs: Vec<[u8; 32]> = zs.into_iter().collect();
        let zkeys: Vec<Address> = zs.iter().map(|z| adr(*z)).collect();
        let mut homes = BTreeMap::new();
        let mut faction = BTreeMap::new();
        for (z, a) in zs.iter().zip(read_all(port, &zkeys).await?) {
            let a = a.filter(|a| a.owner == program);
            homes.insert(*z, home_of(t.addrs, a.as_ref().map(|a| &a.data[..])));
            if let Some(f) = a.as_ref().and_then(|a| {
                a.data
                    .get(frontier_abi::layout::player::citizen::FACTION)
                    .copied()
            }) {
                faction.insert(*z, f);
            }
        }
        for (home, site, o) in owners {
            if let Some(f) = faction.get(&o) {
                v.captor_citizen.insert((home, site), (o, *f));
            }
        }
        Ok((v, homes))
    }

    /// One scan (module doc).
    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        index: &LandIndex,
    ) -> PortResult<()> {
        if !t.cfg.has_role("territory") || t.season.effective_status(t.now) != status::RUNNING {
            return Ok(());
        }
        let Some(bell) = t.clock.bell_at(t.now) else {
            return Ok(());
        };
        let fresh_bell = self.last_bell != Some(bell);
        if !fresh_bell
            && self
                .last_scan
                .is_some_and(|s| t.slot < s.saturating_add(SCAN_SLOTS))
        {
            return Ok(());
        }
        if fresh_bell {
            self.landed_now.clear();
        }
        self.last_bell = Some(bell);
        self.last_scan = Some(t.slot);
        let (v, homes) = self.view(t, port, index).await?;
        self.players = v.players.len();
        self.with_tiles = v.players.iter().filter(|p| p.tiles > 0).count();
        self.unpaid = v
            .players
            .iter()
            .filter(|p| p.unpaid_since.is_some())
            .count();
        self.tiles = v.players.iter().map(|p| u64::from(p.tiles)).sum();
        self.provinces = v.provinces.len();
        self.captured = v.captured.len();
        let steps = thin_settles(
            kt::plan(&v, bell, t.now),
            bell,
            t.cfg.territory_settle_bells,
        );
        let steps = cap_steps(
            self.not_landed(steps, bell),
            bell,
            t.cfg.territory_per_bell as usize,
        );
        self.last_plan = steps.iter().map(|s| format!("{s:?}")).collect();
        let home = |z: &[u8; 32]| -> Address {
            homes
                .get(z)
                .map(|h| h.0)
                .unwrap_or_else(|| no_home(t.addrs))
        };
        for s in steps {
            let k = key_of(&s, bell);
            let cu = match &s {
                Step::Settle { .. } => CU_SETTLE,
                Step::Decay { .. } => CU_DECAY,
                Step::Conquer { .. } => CU_CONQUER,
            };
            if let Step::Settle { citizen } | Step::Decay { citizen, .. } = &s {
                if homes.get(citizen).is_some_and(|h| !h.1) {
                    self.no_home += 1;
                }
            }
            let a = t.addrs.clone();
            let build: crate::engine::Builder = match s.clone() {
                Step::Settle { citizen } => {
                    let h = home(&citizen);
                    Arc::new(move |c: &BuildCtx| vec![kt::settle(&a, c.payer, &citizen, h)])
                }
                Step::Decay {
                    citizen,
                    province,
                    tile,
                } => {
                    let h = home(&citizen);
                    Arc::new(move |c: &BuildCtx| {
                        vec![
                            kt::settle(&a, c.payer, &citizen, h),
                            kt::decay(&a, c.payer, &citizen, province, tile),
                        ]
                    })
                }
                Step::Conquer {
                    province,
                    loser,
                    captor,
                    captor_has_summary,
                    captor_holding,
                } => {
                    let (hl, hc) = (home(&loser), home(&captor));
                    let ch = kt::captor_holding(&a, &captor_holding);
                    Arc::new(move |c: &BuildCtx| {
                        let mut v = vec![kt::settle(&a, c.payer, &loser, hl)];
                        if captor_has_summary {
                            v.push(kt::settle(&a, c.payer, &captor, hc));
                        }
                        v.push(kt::conquer(&a, c.payer, province, &loser, ch, &captor));
                        v
                    })
                }
            };
            if engine.ensure(
                WriteSpec {
                    key: k.clone(),
                    kind: kind_of(&s),
                    tag: WideIx::SettleTicket.tag(), // (0xDC: the class tag of ops 12, 13, 14)
                    class: Class::D,
                    bell: Some(bell),
                    region: None,
                    build,
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                engine.set_cu_limit(&k, cu);
                *self.planned.entry(kind_of(&s)).or_default() += 1;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fclient::ports::Signature;

    fn z(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn keys_are_the_roles_own_and_name_the_step() {
        let k = key_settle(&z(1), 7);
        assert!(k.starts_with("terr-settle:") && k.ends_with(":7"));
        assert!(is_key(&k) && is_key(&key_decay(&z(1), 7)));
        let c = WideCoord::checked(130, -2).unwrap();
        let kc = key_conquer(c, &z(2), 3);
        assert!(kc.starts_with("terr-conquer:130,-2:") && kc.ends_with(":3"));
        assert!(!is_key("wres:1,2:3") && !crate::wideresolve::is_key(&k));
        assert_eq!(kind_of_key(&k), "territory-settle");
        assert_eq!(kind_of_key(&key_decay(&z(1), 7)), "territory-decay");
        assert_eq!(kind_of_key(&kc), "territory-conquer");
    }

    #[test]
    fn plain_settles_thin_out_but_decay_and_its_settle_stay() {
        let c = WideCoord::checked(130, 0).unwrap();
        let steps = vec![
            Step::Settle { citizen: z(1) },
            Step::Settle { citizen: z(2) },
            Step::Decay {
                citizen: z(2),
                province: c,
                tile: 4,
            },
        ];
        assert_eq!(thin_settles(steps.clone(), 5, 1), steps);
        assert_eq!(thin_settles(steps.clone(), 6, 3), steps);
        assert_eq!(thin_settles(steps.clone(), 5, 3), steps[1..].to_vec());
    }

    #[test]
    fn a_long_plan_is_capped_and_its_start_moves_every_bell() {
        let steps: Vec<Step> = (0..10u8).map(|i| Step::Settle { citizen: z(i) }).collect();
        let a = cap_steps(steps.clone(), 0, 4);
        let b = cap_steps(steps.clone(), 1, 4);
        assert_eq!(a.len(), 4);
        assert_eq!(b.len(), 4);
        assert_ne!(a, b);
        assert_eq!(cap_steps(steps.clone(), 9, 24), steps);
    }

    /// verify-pr221: a settle that landed is not sent again by a later rescan of the same bell (the engine forgets
    /// landed keys and `paid_to < now` holds again seconds later); a refused one is planned again; a new bell
    /// settles again.
    #[test]
    fn a_landed_settle_is_not_sent_again_in_the_same_bell() {
        let mut d = TerritoryDuty::default();
        let steps = vec![
            Step::Settle { citizen: z(1) },
            Step::Settle { citizen: z(2) },
        ];
        assert_eq!(d.not_landed(steps.clone(), 7), steps);
        d.on_outcome(
            &key_settle(&z(1), 7),
            &Outcome::Landed {
                sig: Signature::default(),
                payer: Address::new_from_array([3; 32]),
                slot: 9,
                first_slot: 8,
                versions: 1,
                already_done: false,
            },
        );
        d.on_outcome(
            &key_settle(&z(2), 7),
            &Outcome::Dead {
                reason: "x".into(),
                code: None,
            },
        );
        assert_eq!(d.not_landed(steps.clone(), 7), steps[1..].to_vec());
        assert_eq!(d.not_landed(steps.clone(), 8), steps);
    }

    fn rec(tx: Vec<u8>, err: Option<String>) -> TxRecord {
        TxRecord {
            seq: 1,
            slot: 1,
            signature: Signature::default(),
            block_time: 0,
            tx,
            logs: vec![],
            err,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
            loaded: Default::default(),
        }
    }

    /// The feed discovery: a landed WideClaimTile names its province; a failed one, another program's or another
    /// command names nothing.
    #[test]
    fn a_landed_tile_claim_in_the_feed_names_its_province() {
        use fclient::{Keypair, Signer};
        let addrs = fclient::addr::Addresses::new(Address::new_from_array([0x45; 32]), 3);
        let w = Keypair::new();
        let target = WideCoord::checked(131, -5).unwrap();
        let claim = kt::claim_tile(&addrs, w.pubkey(), &z(9), (2, 1, 0), target, 17, None, None);
        let settle = kt::settle(&addrs, w.pubkey(), &z(9), addrs.holding(2, 1, 0));
        let wire = |ixs: Vec<fclient::Instruction>| {
            let b = fclient::tx::TxBudget {
                cu_limit: 200_000,
                cu_price: 0,
                loaded_limit: 1 << 20,
                heap: None,
            };
            let tx = fclient::tx::build(&ixs, &b, &[&w], &fclient::Hash::default()).unwrap();
            fclient::tx::wire(&tx)
        };
        let landed = rec(wire(vec![settle.clone(), claim.clone()]), None);
        assert_eq!(claimed_provinces(&landed, &addrs.program), vec![(131, -5)]);
        assert!(claimed_provinces(
            &rec(wire(vec![claim.clone()]), Some("x".into())),
            &addrs.program
        )
        .is_empty());
        assert!(claimed_provinces(&rec(wire(vec![settle]), None), &addrs.program).is_empty());
        let other = Address::new_from_array([0x46; 32]);
        assert!(claimed_provinces(&landed, &other).is_empty());
        assert!(claimed_provinces(&rec(vec![1, 2, 3], None), &addrs.program).is_empty());
    }

    #[test]
    fn a_citizen_without_a_legacy_first_home_names_the_unusable_holding() {
        let addrs = fclient::addr::Addresses::new(Address::new_from_array([0x45; 32]), 3);
        let (h, ok) = home_of(&addrs, None);
        assert!(!ok);
        assert_eq!(h, no_home(&addrs));
        assert_eq!(h, addrs.holding(0, 0, 255));
    }
}
