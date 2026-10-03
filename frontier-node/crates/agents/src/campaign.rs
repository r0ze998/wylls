//! `agents::campaign` (MC contract v1.3 §8.6, unit CQ2-F): the faction
//! campaign planner, a faithful port of the simulator's
//! (`frontier-sim/src/sim_campaign.rs`, `--policy campaign`, with D-6/D-7,
//! the plan-time `TooLate` check of A-6 and the E1 additions of A-14/A-29:
//! the occupation slot sharing the holding slot, the hold rule and the
//! campaign-only rally stay of A-26).
//!
//! The planner reads a [`World`]: the public state of one planner epoch
//! (the last completed game hour), built either from the herald's
//! immutable files ([`crate::cqobs::world_from_herald`]) or, in the
//! field-equality test (§8.7 item 6), from the simulator's own state.
//! Every function below mirrors one simulator function of the same name
//! (without the `mc_` prefix) and does its arithmetic in the same order,
//! so the scores compare bit for bit.
//!
//! | here | simulator |
//! |---|---|
//! | [`plan_epoch`] | `Sim::mc_campaign_epoch` |
//! | [`herald_call`] | `Sim::mc_herald_call` |
//! | [`World::keep_def`], [`World::hold_def`] | `mc_keep_def`, `mc_hold_def` |
//! | [`World::keep_value`] | `mc_keep_value` |
//! | [`World::target_legal`] | `mc_target_legal` (`may_besiege` v3, record, `TooLate`) |
//! | [`occ_retreat`] | `Sim::occ_retreat` (the hold rule) |
//! | [`rally_stays`] | the rally stay of `resolve_bell` (A-26) |
//! | [`board_join`] | `mc_campaign_session` (session-driven members) |
//!
//! What the bots do with a plan is in [`crate::cqbehave`]; the simulator's
//! `--forward` staging is not ported (off in every gate, OD-15).

use std::collections::{BTreeMap, BTreeSet};

use permutation_rules::fixed::{Bps, Milli, MilliTroops, MILLI};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::doctrine::Doctrine as KernelDoctrine;
use permutation_rules::frontier::geometry::{march_members, march_of, ProvinceCoord};
use permutation_rules::frontier::holding::{lowest_free_slot, Resource, Tier, RESOURCES};
use permutation_rules::frontier::host::{strength as host_strength, Stamina, MIN_HOST_TROOPS};
use permutation_rules::frontier::keep::{Keep, NO_FACTION};
use permutation_rules::frontier::siege::{
    can_complete_before, may_besiege_v3, required_bells, HoldingKind, Relation, SiegeCheckV3,
    SiegeRefusal, Vigil,
};
use permutation_rules::frontier::travel::{
    earliest_arrival_bell, march_stamina, open_ground_secs, BELLS_PER_DAY, BELL_SECS,
};
use permutation_rules::units::{self, UnitType};

use crate::profile::Arch;
use crate::rng::Rng;

/// `NONE` of the simulator: no holding on a site, no Herald's Call.
pub const NONE: u32 = u32::MAX;
/// A planner epoch is one game hour.
pub const HOUR_BELLS: u32 = 6;
/// Largest distance (provinces) a march may cover (the simulator's
/// `MAX_MARCH_DIST`).
pub const MAX_MARCH_DIST: u32 = 3;
/// The group's target strength over the estimated defence.
pub const GROUP_MARGIN: f64 = 1.5;
/// Hosts per campaign wave.
pub const WAVE_HOSTS: usize = 4;
/// Campaigns per faction kept for player holdings (D-6).
pub const HOLDING_SLOTS: usize = 1;
/// Campaigns per faction kept for a first holding to occupy (A-14).
pub const OCC_SLOTS: usize = 1;
/// A campaign with no attempt for this long leaves the plan (D-6).
pub const STALE_BELLS: u32 = 24;
/// Members per campaign: up to `⌈members / 40⌉` campaigns.
pub const MEMBERS_PER_CAMPAIGN: u32 = 40;
/// `barred` of an immunity that bars every faction.
pub const ALL_FACTIONS: u8 = 0xFF;
/// The hold rule's floor: M1's 2/3 retreat order.
pub const HOLD_FLOOR_BPS: Bps = 6_667;

/// Seconds since genesis of bell `b` (the simulator's `now_of`).
pub fn now_of(b: u32) -> i64 {
    b as i64 * BELL_SECS
}

/// Troops (whole) → milli-troops (the simulator's `troops`).
fn troops(n: i64) -> MilliTroops {
    (n.max(0) * MILLI) as MilliTroops
}

/// The garrison an owner aims for, by tier (`frontier-sim/src/model.rs`
/// `garrison_target`, whole troops).
pub fn garrison_target(t: Tier) -> i64 {
    match t {
        Tier::Hamlet => 300,
        Tier::Town => 800,
        Tier::City => 2_000,
        Tier::Stronghold => 5_000,
    }
}

/// Boldness margin per archetype (§8.6): attack only with this multiple
/// of the estimated defence. `None` = never.
pub fn margin(a: Arch) -> Option<f64> {
    match a {
        Arch::Idle => None,
        Arch::Casual => Some(3.0),
        Arch::Daily => Some(2.0),
        Arch::Skilled => Some(1.5),
        Arch::VerySkilled => Some(1.3),
        Arch::Bot => Some(1.5),
    }
}

/// The hold rule (A-14): the retreat order of an occupation strike's host
/// of `own` milli-troops in a group of `group` milli-troops,
/// `clamp(10,000 × group ÷ own, 6,667, RETREAT_MAX_BPS)`.
pub fn occ_retreat(group: MilliTroops, own: MilliTroops) -> Bps {
    let r = (10_000u128 * group.max(1) as u128 / own.max(1) as u128).clamp(
        HOLD_FLOOR_BPS as u128,
        permutation_rules::frontier::clash::RETREAT_MAX_BPS as u128,
    );
    r as Bps
}

/// The MC per-march unit-variant surcharge of `k` hundred troops of
/// `unit` (K2, §3.16: what `catalog::train_v2` charges above a Spearman
/// in ore and gold; the simulator's `k2::march_surcharge_mc`).
pub fn march_surcharge_mc(unit: UnitType, k: i64) -> [Milli; RESOURCES] {
    let mut c = [0; RESOURCES];
    if k <= 0 {
        return c;
    }
    let n = (k * 100).min(u32::MAX as i64) as u32;
    let (Some(mine), Some(base)) = (
        catalog::train_v2(unit as u8, n),
        catalog::train_v2(UnitType::Spearman as u8, n),
    ) else {
        return c;
    };
    for r in [Resource::Ore as usize, Resource::Gold as usize] {
        c[r] = (mine[r] - base[r]).max(0);
    }
    c
}

// ------------------------------------------------------------------ world

/// What a campaign aims at. The derived order (keeps first, then by
/// index) is the planner's tie-break, as in the simulator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    /// A province's keep, by province index.
    Keep(u32),
    /// A holding or Free City, by holding id.
    Hold(u32),
}

/// What a host is for (the simulator's `Mission`); `Other` for a host
/// whose purpose the planner cannot see (another wallet's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mission {
    Camp,
    Siege(u32),
    Relic,
    Defend(u32),
    Occupy(u32),
    Rally(u32),
    Keep(u32),
    KeepRally(u32),
    KeepDefend(u32),
    Stage(u32),
    Other,
}

/// A host's state (the simulator's `HState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    Marching { arrive: u32 },
    Stationed { from: u32 },
    Returning,
    Dead,
}

#[derive(Clone, Debug)]
pub struct HostView {
    pub owner: u32,
    pub home: u32,
    pub faction: u8,
    pub unit: UnitType,
    pub troops: MilliTroops,
    pub state: HostState,
    pub prov: u32,
    pub tile: u8,
    pub mission: Mission,
    /// The retreat order the planner gave it (the hold rule), if any.
    pub retreat: Option<Bps>,
}

/// A live holding siege (the simulator's `McSiege`, the fields the planner
/// reads).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiegeView {
    pub attacker_faction: u8,
    pub declared: u32,
    pub required: u32,
}

/// One site's holding or Free City (times in seconds since genesis).
#[derive(Clone, Debug)]
pub struct HoldView {
    /// The owner's agent id, [`NONE`] for a Free City.
    pub owner: u32,
    pub faction: u8,
    pub prov: u32,
    pub tile: u8,
    pub order: u8,
    pub tier: Tier,
    pub garrison: MilliTroops,
    /// Committed walls (`Holding.walls`; the defence estimate).
    pub walls: u32,
    /// Walls at the epoch's bell start (`walls_at`; the `TooLate` check).
    pub walls_now: u32,
    pub founded_ts: i64,
    pub last_owner_action: i64,
    pub alive: bool,
    pub shield_until: i64,
    pub immune_until: u32,
    pub barred: u8,
    pub siege: Option<SiegeView>,
    pub occupied: bool,
    pub occ_faction: u8,
    pub vigil: Vigil,
    /// Stores at the epoch (milli-units); only members' matter.
    pub stock: [Milli; RESOURCES],
}

impl HoldView {
    pub fn free_city(&self) -> bool {
        self.owner == NONE
    }

    pub fn kind(&self) -> HoldingKind {
        if self.free_city() {
            HoldingKind::FreeCity
        } else if self.order <= 1 {
            HoldingKind::First
        } else {
            HoldingKind::Other
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProvView {
    pub coord: ProvinceCoord,
    /// The March key: the simulator numbers Marches in opening order; the
    /// herald world uses the March's centre province index. Only ties of
    /// the Herald's Call read it.
    pub march: u32,
    /// Holding id per site slot, or [`NONE`].
    pub sites: Vec<u32>,
    /// Hosts standing in the province, in roster order.
    pub stationed: Vec<u32>,
    pub keep: Option<Keep>,
}

#[derive(Clone, Debug)]
pub struct AgentView {
    pub faction: u8,
    /// `None`: a wallet the fleet does not run (never a member).
    pub arch: Option<Arch>,
    pub settled: bool,
    /// DeclareSieges on game day `.0` (`.1` of them).
    pub declares: (u32, u32),
    /// Holding slots reserved at a horn (K-25).
    pub reserved: Vec<u8>,
    pub holdings: Vec<u32>,
}

/// Season parameters and planner switches the planner reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    pub heartland_max_ring: u8,
    pub sieges_per_day: u32,
    /// Whole Gold.
    pub siege_stake_gold: i64,
    pub dormant_after_secs: i64,
    pub frontier_protect_secs: i64,
    pub frontier_protect_after_secs: i64,
    /// Keeps are on (`--rules mc`).
    pub keeps: bool,
    pub occ_slots: usize,
    pub holding_slots: usize,
    pub siege_hold: bool,
    /// Keep interest (1.0 = every keep assignment is taken).
    pub keep_aggr: f64,
    /// Bots act at the planner epoch (`--bot-profile cq`; the stack).
    pub epoch_bots: bool,
}

impl Params {
    /// `MC_LOCAL_7D` (Frontier-7) with the planner package (A-15).
    pub const FRONTIER_7: Params = Params {
        heartland_max_ring: 3,
        sieges_per_day: 2,
        siege_stake_gold: 500,
        dormant_after_secs: 259_200,
        frontier_protect_secs: 129_600,
        frontier_protect_after_secs: 43_200,
        keeps: true,
        occ_slots: OCC_SLOTS,
        holding_slots: HOLDING_SLOTS,
        siege_hold: true,
        keep_aggr: 1.0,
        epoch_bots: true,
    };
}

/// The public state of one planner epoch.
#[derive(Clone, Debug)]
pub struct World {
    pub bell: u32,
    pub end_bell: u32,
    pub open_ring: u32,
    pub params: Params,
    pub doctrine: [KernelDoctrine; 6],
    /// Every opened province by dense index (`ProvinceCoord::index`).
    pub provs: BTreeMap<u32, ProvView>,
    pub holds: BTreeMap<u32, HoldView>,
    pub hosts: BTreeMap<u32, HostView>,
    pub agents: BTreeMap<u32, AgentView>,
    /// Provinces with a live keep contest; holdings with a live siege.
    pub keep_live: BTreeSet<u32>,
    pub msieges: BTreeSet<u32>,
    /// Herald's Call: a March key per faction ([`NONE`] none).
    pub call: [u32; 6],
    /// The id the next dispatched host gets.
    pub next_host: u32,
}

/// One launch of a campaign: who went, and when they meet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub muster: u32,
    pub hosts: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Campaign {
    pub target: Target,
    pub fails: u8,
    pub attempt: Option<Attempt>,
    pub idle_since: u32,
}

/// The planner's memory between epochs (hysteresis): each faction's
/// campaigns and the strikes under way (`pending`: target → last bell to
/// declare). Every bot of a faction carries the same board.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Board {
    pub camps: [Vec<Campaign>; 6],
    pub pending: BTreeMap<u32, u32>,
}

/// One host the plan sends (a sealed march for the bot that owns `src`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dispatch {
    /// The id the host gets in the [`World`].
    pub host: u32,
    pub agent: u32,
    pub src: u32,
    pub troops: MilliTroops,
    pub prov: u32,
    pub tile: u8,
    pub mission: Mission,
    pub arrive: u32,
    /// The hold rule's retreat order (`None`: the bot's own draw).
    pub retreat: Option<Bps>,
    pub faction: u8,
}

/// Counters of an epoch (the simulator's `McStats::dbg[11..=13]`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanStats {
    /// Plan fills with a legal first holding in reach (`dbg[11]`).
    pub fills_with_home: u64,
    /// Occupation campaigns added (`dbg[12]`).
    pub occ_added: u64,
    /// Occupation groups launched (`dbg[13]`).
    pub occ_launched: u64,
}

/// What an epoch decided.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EpochPlan {
    pub dispatches: Vec<Dispatch>,
    pub stats: PlanStats,
    /// Each fill's ranked candidates `(faction, [(score, target)])`, in
    /// fill order (a fill that had no free campaign slot ranks nothing).
    pub candidates: Vec<(u8, Vec<(f64, Target)>)>,
}

/// A member that can send (the simulator's `Member`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Member {
    pub agent: u32,
    pub src: u32,
    pub staged: bool,
    pub spare: MilliTroops,
    pub arrive: u32,
}

#[derive(Clone, Copy, Debug)]
struct Relief {
    mission: Mission,
    pi: u32,
    tile: u8,
    deadline: u32,
    attacker: u8,
}

/// Why a holding may not be besieged (the simulator's `Refusal`, the
/// codes the planner can meet).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotBesiegeable,
    SiegeBusy,
    Immune,
    Friendly,
    Shielded,
    FrontierProtected,
    Heartland,
}

impl World {
    pub fn prov(&self, i: u32) -> &ProvView {
        self.provs.get(&i).expect("open province")
    }

    pub fn hold(&self, t: u32) -> &HoldView {
        self.holds.get(&t).expect("holding")
    }

    fn hold_mut(&mut self, t: u32) -> &mut HoldView {
        self.holds.get_mut(&t).expect("holding")
    }

    pub fn host(&self, h: u32) -> &HostView {
        self.hosts.get(&h).expect("host")
    }

    pub fn agent(&self, a: u32) -> &AgentView {
        self.agents.get(&a).expect("agent")
    }

    /// The simulator's `prov_at`: open provinces of rings 2 and beyond.
    pub fn prov_at(&self, c: ProvinceCoord) -> Option<u32> {
        if c.ring() > self.open_ring || c.ring() < 2 {
            return None;
        }
        let i = c.index();
        self.provs.contains_key(&i).then_some(i)
    }

    /// Open provinces within `r` of `c` (rings ≥ 2), nearest first.
    pub fn provinces_near(&self, c: ProvinceCoord, r: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let r = r as i32;
        for dq in -r..=r {
            for dr in (-r).max(-dq - r)..=r.min(-dq + r) {
                let p = ProvinceCoord::new(c.p + dq, c.q + dr);
                if let Some(i) = self.prov_at(p) {
                    out.push((c.distance(p), i));
                }
            }
        }
        out.sort_unstable();
        out.into_iter().map(|x| x.1).collect()
    }

    /// Arrival bell and stamina of a march of faction `faction` from
    /// province `from` to `to` departing at `depart` (the simulator's
    /// `travel`: open ground, `9 × distance + 3` hexes).
    pub fn travel(&self, faction: u8, from: u32, to: u32, depart: u32) -> Option<(u32, u16)> {
        let dist = self.prov(from).coord.distance(self.prov(to).coord);
        if dist > MAX_MARCH_DIST {
            return None;
        }
        let d = &self.doctrine[faction as usize];
        let hexes = 9 * dist + 3;
        let secs = d.travel_secs(open_ground_secs(hexes, false, d.unit));
        let arrive = earliest_arrival_bell(0, now_of(depart), secs as u32).max(depart + 2);
        Some((arrive, march_stamina(hexes.min(32))))
    }

    pub fn epoch_driven(&self, a: u32) -> bool {
        self.params.epoch_bots && self.agents.get(&a).and_then(|x| x.arch) == Some(Arch::Bot)
    }

    fn arch_of(&self, a: u32) -> Option<Arch> {
        self.agents.get(&a).and_then(|x| x.arch)
    }

    pub fn per_troop(&self, f: u8) -> f64 {
        units::stats(self.doctrine[f as usize].unit).strength as f64
    }

    pub fn keep_back(&self, hid: u32) -> MilliTroops {
        troops(garrison_target(self.hold(hid).tier) / 4)
    }

    /// Strength of faction `f`'s hosts (`same`) or of every other
    /// faction's (`!same`) on a tile.
    pub fn tile_strength(&self, pi: u32, tile: u8, f: u8, same: bool) -> f64 {
        self.prov(pi)
            .stationed
            .iter()
            .map(|h| self.host(*h))
            .filter(|y| y.tile == tile && y.state != HostState::Dead && (y.faction == f) == same)
            .map(|y| host_strength(y.unit, y.troops) as f64)
            .sum()
    }

    /// The standing-order relief faction `f` brings to province `pi` (the 4
    /// largest 25% shares of its holdings in the March within 2).
    pub fn keep_reinforcement(&self, pi: u32, f: u8) -> f64 {
        let m = self.prov(pi).march;
        let c = self.prov(pi).coord;
        let mut v: Vec<MilliTroops> = Vec::new();
        for q in self.provinces_near(c, 2) {
            if self.prov(q).march != m {
                continue;
            }
            for &h in &self.prov(q).sites {
                if h == NONE {
                    continue;
                }
                let y = self.hold(h);
                if y.alive && y.faction == f && !y.free_city() {
                    v.push(y.garrison / 4);
                }
            }
        }
        v.sort_unstable_by(|a, b| b.cmp(a));
        v.iter().take(4).map(|&g| g as f64 * 10.0).sum()
    }

    fn relief(&self, pi: u32, g: u8) -> f64 {
        if (g as usize) >= 6 {
            return 0.0;
        }
        self.keep_reinforcement(pi, g)
    }

    /// Estimated defence of a keep: its garrison behind walls, the
    /// holder's hosts on the tile, the holder's relief.
    pub fn keep_def(&self, pi: u32) -> f64 {
        let k = self.prov(pi).keep.expect("keep");
        k.troops.saturating_mul(1_000) as f64 * 10.0 * 1.5
            + self.tile_strength(pi, k.tile, k.holder, true)
            + self.relief(pi, k.holder)
    }

    /// Estimated defence of a holding: garrison (×1.5 behind walls), the
    /// owner's hosts on the hex, the owner faction's relief.
    pub fn hold_def(&self, t: u32) -> f64 {
        let x = self.hold(t);
        let (garrison, walls, pi, tile, f, fc) = (
            x.garrison,
            x.walls,
            x.prov,
            x.tile,
            x.faction,
            x.free_city(),
        );
        let mut d = garrison as f64 * 10.0 * if walls > 0 { 1.5 } else { 1.0 };
        d += self.tile_strength(pi, tile, f, true);
        if !fc {
            d += self.relief(pi, f);
        }
        d
    }

    /// Value of taking keep `pi` for `f`: ×3 when it tips the March
    /// banner, ×1.5 when `f` already holds keeps there, ×2 in the faction's
    /// Herald's Call March (`call`).
    pub fn keep_value(&self, pi: u32, f: u8, call: bool) -> f64 {
        let pr = self.prov(pi);
        let mut value = 1.2;
        let m = pr.march;
        let (mut own, mut open) = (0u32, 0u32);
        for q in march_members(march_of(pr.coord)) {
            if let Some(qi) = self.prov_at(q) {
                let qq = self.prov(qi);
                if qq.march != m || qq.keep.is_none() {
                    continue;
                }
                open += 1;
                if qq.keep.is_some_and(|x| x.holder == f) {
                    own += 1;
                }
            }
        }
        if (own + 1) * 2 > open && own * 2 <= open {
            value *= 3.0;
        } else if own > 0 {
            value *= 1.5;
        }
        if call && self.call[f as usize] == m {
            value *= 2.0;
        }
        value
    }

    pub fn dormant(&self, x: &HoldView, now: i64) -> bool {
        x.free_city() || now - x.last_owner_action >= self.params.dormant_after_secs
    }

    /// Faction `f` has a first holding within 2 provinces of `pi`.
    pub fn first_nearby(&self, f: u8, pi: u32) -> bool {
        let c = self.prov(pi).coord;
        self.provinces_near(c, 2).into_iter().any(|q| {
            self.prov(q).sites.iter().any(|&h| {
                h != NONE && {
                    let y = self.hold(h);
                    y.alive && y.faction == f && !y.free_city() && y.order == 1
                }
            })
        })
    }

    /// `siege::may_besiege_v3` for faction `f` on `t` (Rivalry, no March
    /// flags, times since genesis).
    pub fn may_besiege(&self, t: u32, f: u8, b: u32) -> Result<(), Refusal> {
        let x = self.hold(t);
        if !x.alive {
            return Err(Refusal::NotBesiegeable);
        }
        let now = now_of(b);
        let prm = &self.params;
        let mut c = SiegeCheckV3 {
            province: self.prov(x.prov).coord,
            kind: x.kind(),
            owner_faction: x.faction,
            attacker_faction: f,
            relation: Relation::Rivalry,
            march_hostility: false,
            march_truce: false,
            founded_ts: x.founded_ts,
            shield_until: x.shield_until,
            dormant: self.dormant(x, now),
            attacker_nearby: false,
            now,
            heartland_max_ring: prm.heartland_max_ring,
            frontier_protect_secs: prm.frontier_protect_secs,
            frontier_protect_after_secs: prm.frontier_protect_after_secs,
            genesis_ts: 0,
        };
        let mut r = may_besiege_v3(&c);
        if r == Err(SiegeRefusal::FrontierProtected) && self.first_nearby(f, x.prov) {
            c.attacker_nearby = true;
            r = may_besiege_v3(&c);
        }
        r.map_err(|e| match e {
            SiegeRefusal::Friendly => Refusal::Friendly,
            SiegeRefusal::Shielded => Refusal::Shielded,
            SiegeRefusal::FrontierProtected => Refusal::FrontierProtected,
            SiegeRefusal::Heartland => Refusal::Heartland,
            _ => Refusal::NotBesiegeable,
        })
    }

    /// The record checks of §3.4 step 5 for faction `f`.
    pub fn record_free(&self, t: u32, f: u8, b: u32) -> Result<(), Refusal> {
        let x = self.hold(t);
        if x.siege.is_some() || x.occupied {
            return Err(Refusal::SiegeBusy);
        }
        if x.immune_until > b && (x.barred == ALL_FACTIONS || x.barred == f) {
            return Err(Refusal::Immune);
        }
        Ok(())
    }

    /// Whether a siege on `t` declared at bell `from − 1` could complete
    /// before the season ends (`TooLate` at plan time, A-6).
    pub fn can_finish(&self, t: u32, from: u32, _b: u32) -> bool {
        let x = self.hold(t);
        let vigil = if x.free_city() { None } else { Some(x.vigil) };
        can_complete_before(
            (required_bells(x.walls_now, 0)).min(u8::MAX as u32) as u8,
            vigil.as_ref(),
            from,
            self.end_bell,
            0,
        )
    }

    /// Lowest free holding slot of 2–3 (K-25).
    pub fn free_slot23(&self, a: u32) -> Option<u8> {
        let ag = self.agent(a);
        let occupied: [bool; 3] = core::array::from_fn(|i| {
            ag.holdings.iter().any(|&h| {
                self.holds
                    .get(&h)
                    .is_some_and(|x| x.order as usize == i + 1)
            })
        });
        let reserved = ag
            .reserved
            .iter()
            .filter(|&&s| (2..=3).contains(&s))
            .fold(0u8, |m, &s| m | 1 << (s - 2));
        lowest_free_slot(occupied, 0, reserved)
    }

    pub fn target_ours(&self, t: Target, f: u8) -> bool {
        match t {
            Target::Keep(pi) => self.prov(pi).keep.is_some_and(|k| k.holder == f),
            Target::Hold(t) => {
                let x = self.hold(t);
                (x.alive && x.faction == f) || (x.occupied && x.occ_faction == f)
            }
        }
    }

    pub fn target_legal(&self, t: Target, f: u8, b: u32) -> bool {
        match t {
            Target::Keep(pi) => self.prov(pi).keep.is_some_and(|k| {
                !k.heartland_safe && k.holder != f && k.consolidated_until_bell <= b + 12
            }),
            Target::Hold(t) => {
                let x = self.hold(t);
                x.alive
                    && x.faction != f
                    && x.siege.is_none_or(|s| s.attacker_faction == f)
                    && (x.siege.is_some() || self.record_free(t, f, b).is_ok())
                    && self.may_besiege(t, f, b).is_ok()
                    && (x.siege.is_some() || self.can_finish(t, b + 1, b))
            }
        }
    }

    pub fn host_live(&self, h: u32) -> bool {
        self.hosts.get(&h).is_some_and(|x| {
            matches!(
                x.state,
                HostState::Marching { .. } | HostState::Stationed { .. }
            )
        })
    }

    fn host_arrival(&self, h: u32) -> u32 {
        match self.hosts.get(&h).map(|x| x.state) {
            Some(HostState::Marching { arrive }) => arrive,
            _ => 0,
        }
    }

    /// A first holding (a home) as a target: occupation.
    pub fn occ_target(&self, t: &Target) -> bool {
        matches!(t, Target::Hold(h) if {
            let x = self.hold(*h);
            !x.free_city() && x.order <= 1
        })
    }

    fn player(&self, t: &Target) -> bool {
        matches!(t, Target::Hold(h) if !self.hold(*h).free_city())
    }

    /// Whether `a` can sound the horn on `t` (gold, daily cap, slot).
    pub fn can_declare(&self, a: u32, src: u32, t: u32, b: u32) -> bool {
        let x = self.hold(t);
        let capture = x.free_city() || x.order >= 2;
        if capture && self.free_slot23(a).is_none() {
            return false;
        }
        let ag = self.agent(a);
        if ag.declares.0 == b / BELLS_PER_DAY && ag.declares.1 >= self.params.sieges_per_day {
            return false;
        }
        self.hold(src).stock[Resource::Gold as usize] >= self.params.siege_stake_gold * MILLI
    }

    /// Muster a host from holding `from` and send it (the simulator's
    /// `send_at`; `arrive_min` 0 = as early as possible). Mutates the
    /// world as the simulator does: garrison, the surcharge, a new host.
    #[allow(clippy::too_many_arguments)]
    pub fn send_at(
        &mut self,
        a: u32,
        from: u32,
        n_troops: MilliTroops,
        to_prov: u32,
        tile: u8,
        mission: Mission,
        b: u32,
        arrive_min: u32,
        out: &mut Vec<Dispatch>,
    ) -> Option<u32> {
        let faction = self.agent(a).faction;
        let unit = self.doctrine[faction as usize].unit;
        let src = self.hold(from).prov;
        let (arrive, cost) = self.travel(faction, src, to_prov, b)?;
        let arrive = arrive.max(arrive_min.min(self.end_bell + 300));
        if n_troops < MIN_HOST_TROOPS || self.hold(from).garrison < n_troops {
            return None;
        }
        // The unit-variant surcharge over a Spearman (K2 under MC).
        let extra = units::stats(unit).prod_cost as i64 - 6;
        if extra > 0 {
            let k = n_troops as i64 / (100 * MILLI);
            let c = march_surcharge_mc(unit, k);
            let x = self.hold_mut(from);
            if (0..RESOURCES).any(|r| c[r] < 0 || x.stock[r] < c[r]) {
                return None;
            }
            for (s, v) in x.stock.iter_mut().zip(c) {
                *s -= v;
            }
        }
        let mut stamina = Stamina::full(b);
        if stamina.spend(b, cost).is_err() {
            return None;
        }
        self.hold_mut(from).garrison -= n_troops;
        let id = self.next_host;
        self.next_host += 1;
        self.hosts.insert(
            id,
            HostView {
                owner: a,
                home: from,
                faction,
                unit,
                troops: n_troops,
                state: HostState::Marching { arrive },
                prov: to_prov,
                tile,
                mission,
                retreat: None,
            },
        );
        out.push(Dispatch {
            host: id,
            agent: a,
            src: from,
            troops: n_troops,
            prov: to_prov,
            tile,
            mission,
            arrive,
            retreat: None,
            faction,
        });
        Some(id)
    }

    fn set_retreat(&mut self, h: u32, r: Bps, out: &mut [Dispatch]) {
        if let Some(x) = self.hosts.get_mut(&h) {
            x.retreat = Some(r);
        }
        if let Some(d) = out.iter_mut().rev().find(|d| d.host == h) {
            d.retreat = Some(r);
        }
    }

    /// The faction's holdings by province (alive, not a Free City, owner
    /// not idle), each list in holding-id order.
    pub fn by_prov(&self, f: u8) -> BTreeMap<u32, Vec<u32>> {
        let mut out: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for (&i, x) in &self.holds {
            if x.alive
                && !x.free_city()
                && x.faction == f
                && self.arch_of(x.owner) != Some(Arch::Idle)
            {
                out.entry(x.prov).or_default().push(i);
            }
        }
        out
    }

    /// Settled members per faction.
    pub fn members(&self) -> [u32; 6] {
        let mut m = [0u32; 6];
        for ag in self.agents.values() {
            if ag.settled && (ag.faction as usize) < 6 {
                m[ag.faction as usize] += 1;
            }
        }
        m
    }
}

// ------------------------------------------------------------------ planner

/// Herald's Call (§3.10; display only, the plan's tie-breaker): per
/// faction, the March with the most contestable enemy keeps adjacent to
/// the faction's keeps (lowest March key on ties).
pub fn herald_call(w: &World, b: u32) -> [u32; 6] {
    let mut call = [NONE; 6];
    for (f, slot) in call.iter_mut().enumerate() {
        let f = f as u8;
        let mut count: BTreeMap<u32, u32> = BTreeMap::new();
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        for p in w.provs.values() {
            if p.keep.is_none_or(|k| k.holder != f) {
                continue;
            }
            for q in w.provinces_near(p.coord, 1) {
                let Some(k) = w.prov(q).keep else {
                    continue;
                };
                if k.holder == f
                    || k.heartland_safe
                    || k.consolidated_until_bell > b
                    || !seen.insert(q)
                {
                    continue;
                }
                *count.entry(w.prov(q).march).or_insert(0) += 1;
            }
        }
        if let Some((&m, _)) = count.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))) {
            *slot = m;
        }
    }
    call
}

/// Won, failed (twice) or illegal campaigns leave the plan.
pub fn campaign_update(w: &World, board: &mut Board, f: u8, b: u32) {
    let mut camps = std::mem::take(&mut board.camps[f as usize]);
    camps.retain_mut(|c| {
        if w.target_ours(c.target, f) {
            return false;
        }
        if let Some(at) = &c.attempt {
            let live = at.hosts.iter().any(|&h| w.host_live(h));
            if !live {
                if !at.hosts.is_empty() {
                    c.fails += 1;
                }
                c.attempt = None;
                c.idle_since = b;
            }
        }
        if c.fails >= 2 || (c.attempt.is_none() && b >= c.idle_since + STALE_BELLS) {
            return false;
        }
        c.attempt.is_some() || w.target_legal(c.target, f, b)
    });
    board.camps[f as usize] = camps;
}

/// The scored candidates of a fill (value ÷ estimated defence, best
/// first, ties by target), the order §8.7 item 6's test compares.
pub fn candidates(
    w: &World,
    board: &Board,
    f: u8,
    b: u32,
    by_prov: &BTreeMap<u32, Vec<u32>>,
) -> Vec<(f64, Target)> {
    let taken: BTreeSet<Target> = board.camps[f as usize].iter().map(|c| c.target).collect();
    let mut cands: Vec<(f64, Target)> = Vec::new();
    let provs: Vec<u32> = by_prov.keys().copied().collect();
    if w.params.keeps {
        // Keeps adjacent to the faction's holdings or keeps.
        let mut base: BTreeSet<u32> = provs.iter().copied().collect();
        for (&i, p) in &w.provs {
            if p.keep.is_some_and(|k| k.holder == f) {
                base.insert(i);
            }
        }
        let mut front: BTreeSet<u32> = BTreeSet::new();
        for &q in &base {
            for r in w.provinces_near(w.prov(q).coord, 1) {
                front.insert(r);
            }
        }
        for pi in front {
            let t = Target::Keep(pi);
            if taken.contains(&t) || !w.target_legal(t, f, b) {
                continue;
            }
            let reach = w
                .provinces_near(w.prov(pi).coord, MAX_MARCH_DIST)
                .iter()
                .any(|q| by_prov.contains_key(q));
            if !reach {
                continue;
            }
            let v = w.keep_value(pi, f, true);
            cands.push((v / w.keep_def(pi).max(1.0), t));
        }
    }
    // Holdings 2–3, first holdings (occupation) and Free Cities within two
    // provinces of the faction's holdings.
    let now = now_of(b);
    let mut front: BTreeSet<u32> = BTreeSet::new();
    for &q in &provs {
        for r in w.provinces_near(w.prov(q).coord, 2) {
            front.insert(r);
        }
    }
    for pi in front {
        for &t in &w.prov(pi).sites {
            if t == NONE {
                continue;
            }
            let tg = Target::Hold(t);
            let x = w.hold(t);
            if taken.contains(&tg) || !x.alive || x.faction == f || board.pending.contains_key(&t) {
                continue;
            }
            let capture = x.free_city() || x.order >= 2;
            if !capture && w.dormant(x, now) {
                continue;
            }
            if !w.target_legal(tg, f, b) || x.siege.is_some() {
                continue;
            }
            let v = if capture { 1.5 } else { 1.0 };
            let call = w.params.keeps && w.call[f as usize] == w.prov(pi).march;
            let v = if call { v * 2.0 } else { v };
            cands.push((v / w.hold_def(t).max(1.0), tg));
        }
    }
    cands.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    cands
}

/// Fill the plan up to `k` campaigns with the best new targets: the
/// occupation slot first (A-14/A-29: it counts against the holding slot),
/// then the holding slot, then by score.
#[allow(clippy::too_many_arguments)]
pub fn campaign_fill(
    w: &World,
    board: &mut Board,
    f: u8,
    b: u32,
    k: usize,
    by_prov: &BTreeMap<u32, Vec<u32>>,
    st: &mut PlanStats,
    ranked: &mut Vec<(u8, Vec<(f64, Target)>)>,
) {
    let have = board.camps[f as usize].len();
    if have >= k {
        return;
    }
    let cands = candidates(w, board, f, b, by_prov);
    ranked.push((f, cands.clone()));
    let have_player = board.camps[f as usize]
        .iter()
        .filter(|c| w.player(&c.target))
        .count();
    let mut pick: Vec<Target> = Vec::new();
    let occ_slots = w.params.occ_slots;
    if occ_slots > 0 {
        let have_occ = board.camps[f as usize]
            .iter()
            .filter(|c| w.occ_target(&c.target))
            .count();
        let n_occ = cands.iter().filter(|c| w.occ_target(&c.1)).count();
        if n_occ > 0 {
            st.fills_with_home += 1;
        }
        if have_occ < occ_slots {
            let before = pick.len();
            pick.extend(
                cands
                    .iter()
                    .filter(|c| w.occ_target(&c.1))
                    .take(occ_slots - have_occ)
                    .map(|c| c.1),
            );
            st.occ_added += (pick.len() - before) as u64;
        }
    }
    let slots = w.params.holding_slots;
    let have_player = have_player + pick.len();
    if have_player < slots {
        let more: Vec<Target> = cands
            .iter()
            .filter(|c| w.player(&c.1) && !pick.contains(&c.1))
            .take(slots - have_player)
            .map(|c| c.1)
            .collect();
        pick.extend(more);
    }
    for (_, t) in &cands {
        if pick.len() >= k - have {
            break;
        }
        if !pick.contains(t) {
            pick.push(*t);
        }
    }
    pick.truncate(k - have);
    for t in pick {
        board.camps[f as usize].push(Campaign {
            target: t,
            fails: 0,
            attempt: None,
            idle_since: b,
        });
    }
}

/// Members of `f` within one march of `tp` with spare troops, ranked by
/// spare troops (then holding id).
pub fn members_near(
    w: &World,
    f: u8,
    tp: u32,
    b: u32,
    by_prov: &BTreeMap<u32, Vec<u32>>,
    decided: &BTreeSet<u32>,
) -> Vec<Member> {
    let mut out: Vec<Member> = Vec::new();
    let tc = w.prov(tp).coord;
    for q in w.provinces_near(tc, MAX_MARCH_DIST) {
        let Some(hs) = by_prov.get(&q) else { continue };
        for &h in hs {
            let y = w.hold(h);
            if y.siege.is_some() || y.occupied {
                continue;
            }
            if decided.contains(&y.owner) {
                continue;
            }
            let spare = y.garrison.saturating_sub(w.keep_back(h));
            if spare < MIN_HOST_TROOPS {
                continue;
            }
            let Some((arrive, _)) = w.travel(f, q, tp, b) else {
                continue;
            };
            out.push(Member {
                agent: y.owner,
                src: h,
                staged: false,
                spare,
                arrive,
            });
        }
    }
    out.sort_by(|a, b| {
        b.spare
            .cmp(&a.spare)
            .then(a.src.cmp(&b.src))
            .then(a.staged.cmp(&b.staged))
    });
    out
}

/// The group for a target: ≤ 4 members by spare troops until 1.2 × the
/// wanted strength (1.5 × the estimated defence); a holding's leader can
/// declare and the helpers stay smaller; each member needs the group at
/// its boldness margin.
pub fn form_group(
    w: &World,
    f: u8,
    target: Target,
    def: f64,
    b: u32,
    ms: &[Member],
) -> Option<Vec<Member>> {
    let per = w.per_troop(f);
    let want = def.max(1.0) * GROUP_MARGIN / per;
    let mut ms: Vec<Member> = ms.to_vec();
    if let Target::Hold(t) = target {
        let li = ms
            .iter()
            .position(|m| !m.staged && w.can_declare(m.agent, m.src, t, b))?;
        let l = ms.remove(li);
        ms.insert(0, l);
    }
    let mut group: Vec<Member> = Vec::new();
    let mut got = 0.0;
    for m in ms {
        if group.len() >= WAVE_HOSTS || got >= want * 1.2 {
            break;
        }
        if group.iter().any(|g| g.agent == m.agent) {
            continue;
        }
        let mut m = m;
        if let (Target::Hold(_), Some(l)) = (target, group.first()) {
            m.spare = m.spare.min(l.spare.saturating_sub(MILLI as MilliTroops));
            if m.spare < MIN_HOST_TROOPS {
                continue;
            }
        }
        got += m.spare as f64;
        group.push(m);
    }
    let strength = got * per;
    let lead = group.first().map(|m| m.agent);
    group.retain(|m| {
        w.arch_of(m.agent)
            .and_then(margin)
            .is_some_and(|x| strength >= x * def)
    });
    let got: f64 = group.iter().map(|m| m.spare as f64).sum();
    if got < want || group.is_empty() {
        return None;
    }
    if matches!(target, Target::Hold(_)) && group.first().map(|m| m.agent) != lead {
        return None;
    }
    Some(group)
}

/// The common arrival bell (`≥ max(earliest arrival) + 1`, ≤ `end_bell − 1`).
pub fn muster(w: &World, group: &[Member], b: u32) -> u32 {
    let latest = group.iter().map(|m| m.arrive).max().unwrap_or(b);
    (latest + 1).min(w.end_bell - 1)
}

/// An epoch decision is taken (keep assignments also need the keep
/// interest roll; no draw at keep interest 1.0).
fn heeds_epoch(w: &World, keep: bool, rng: &mut Rng) -> bool {
    let k = w.params.keep_aggr;
    !keep || k >= 1.0 || rng.chance(k)
}

#[allow(clippy::too_many_arguments)]
fn launch_group(
    w: &mut World,
    board: &mut Board,
    b: u32,
    target: Target,
    group: &[Member],
    muster: u32,
    at: &mut Attempt,
    decided: &mut BTreeSet<u32>,
    rng: &mut Rng,
    out: &mut Vec<Dispatch>,
    st: &mut PlanStats,
) {
    let (tp, tile, mission, rally, keep) = match target {
        Target::Keep(pi) => (
            pi,
            w.prov(pi).keep.expect("keep").tile,
            Mission::Keep(pi),
            Mission::KeepRally(pi),
            true,
        ),
        Target::Hold(t) => {
            let x = w.hold(t);
            (x.prov, x.tile, Mission::Siege(t), Mission::Rally(t), false)
        }
    };
    let before = at.hosts.len();
    for (i, m) in group.iter().enumerate() {
        let ms = if i == 0 { mission } else { rally };
        if w.epoch_driven(m.agent) {
            decided.insert(m.agent);
            if !heeds_epoch(w, keep, rng) {
                continue;
            }
            if let Some(h) = w.send_at(m.agent, m.src, m.spare, tp, tile, ms, b, muster, out) {
                at.hosts.push(h);
            }
        }
    }
    let occ = w.occ_target(&target);
    if w.params.siege_hold && occ && at.hosts.len() > before {
        // The hold rule: the occupation strike holds while its siege counts.
        let total: MilliTroops = at.hosts[before..].iter().map(|&h| w.host(h).troops).sum();
        let hs: Vec<u32> = at.hosts[before..].to_vec();
        for h in hs {
            let own = w.host(h).troops;
            w.set_retreat(h, occ_retreat(total, own), out);
        }
    }
    if occ && at.hosts.len() > before {
        st.occ_launched += 1;
    }
    if let Target::Hold(t) = target {
        if at.hosts.len() > before {
            let last = at.hosts[before..]
                .iter()
                .map(|&h| w.host_arrival(h))
                .max()
                .unwrap_or(b);
            let e = board.pending.entry(t).or_insert(0);
            *e = (*e).max(last + 6);
        }
    }
}

/// Launch (or top up) each campaign without a live attempt.
#[allow(clippy::too_many_arguments)]
pub fn campaign_launch(
    w: &mut World,
    board: &mut Board,
    f: u8,
    b: u32,
    by_prov: &BTreeMap<u32, Vec<u32>>,
    decided: &mut BTreeSet<u32>,
    rng: &mut Rng,
    out: &mut Vec<Dispatch>,
    st: &mut PlanStats,
) {
    let n = board.camps[f as usize].len();
    for ci in 0..n {
        let c = board.camps[f as usize][ci].clone();
        if c.attempt.is_some() || !w.target_legal(c.target, f, b) {
            continue;
        }
        let (tp, def) = match c.target {
            Target::Keep(pi) => (pi, w.keep_def(pi)),
            Target::Hold(t) => (w.hold(t).prov, w.hold_def(t)),
        };
        // Epoch-driven bots launch at the epoch; session-driven members
        // join from the board (`board_join`).
        let mut ms = members_near(w, f, tp, b, by_prov, decided);
        ms.retain(|m| w.epoch_driven(m.agent));
        if ms.is_empty() {
            continue;
        }
        let Some(group) = form_group(w, f, c.target, def, b, &ms) else {
            continue;
        };
        let mu = muster(w, &group, b);
        if let Target::Hold(t) = c.target {
            // TooLate at plan time: the horn sounds at the muster bell.
            if w.hold(t).siege.is_none() && !w.can_finish(t, mu + 1, b) {
                continue;
            }
        }
        let mut at = Attempt {
            muster: mu,
            hosts: Vec::new(),
        };
        launch_group(
            w, board, b, c.target, &group, mu, &mut at, decided, rng, out, st,
        );
        // A keep campaign's siege group: the weakest legal enemy player
        // holding of the province, from the members left, one bell after
        // the assault.
        if let Target::Keep(_) = c.target {
            let used: Vec<u32> = group.iter().map(|m| m.agent).collect();
            let rest: Vec<Member> = ms
                .iter()
                .copied()
                .filter(|m| !used.contains(&m.agent))
                .collect();
            let sites = w.prov(tp).sites.clone();
            let mut best: Option<(f64, u32)> = None;
            for t in sites {
                if t == NONE || board.pending.contains_key(&t) {
                    continue;
                }
                let x = w.hold(t);
                if !x.alive || x.faction == f || x.siege.is_some() || x.free_city() {
                    continue;
                }
                if !w.target_legal(Target::Hold(t), f, b) {
                    continue;
                }
                let d = w.hold_def(t);
                if best.is_none_or(|x| d < x.0) {
                    best = Some((d, t));
                }
            }
            if let Some((d, t)) = best {
                let g2 = form_group(w, f, Target::Hold(t), d, b, &rest);
                // TooLate at plan time for the siege group's horn.
                let g2 = g2.filter(|g2| {
                    let m2 = mu.max(muster(w, g2, b)) + 1;
                    w.can_finish(t, m2.min(w.end_bell - 1) + 1, b)
                });
                if let Some(g2) = g2 {
                    let m2 = mu.max(muster(w, &g2, b)) + 1;
                    let m2 = m2.min(w.end_bell - 1);
                    launch_group(
                        w,
                        board,
                        b,
                        Target::Hold(t),
                        &g2,
                        m2,
                        &mut at,
                        decided,
                        rng,
                        out,
                        st,
                    );
                }
            }
        }
        if at.hosts.is_empty() {
            continue;
        }
        board.camps[f as usize][ci].attempt = Some(at);
    }
}

/// The defence plan of an epoch: own keeps under contest and own holdings
/// under siege get relief that can arrive before 25% progress (the
/// standing order: the 4 largest 25% shares of skilled-and-up members in
/// the threatened March).
#[allow(clippy::too_many_arguments)]
pub fn defence_plan(
    w: &mut World,
    f: u8,
    b: u32,
    by_prov: &BTreeMap<u32, Vec<u32>>,
    decided: &mut BTreeSet<u32>,
    rng: &mut Rng,
    out: &mut Vec<Dispatch>,
) {
    let mut needs: Vec<Relief> = Vec::new();
    for &pi in &w.keep_live {
        let Some(k) = w.prov(pi).keep else {
            continue;
        };
        if k.holder != f || k.contender == NO_FACTION {
            continue;
        }
        let quarter = (k.required as u32).div_ceil(4);
        needs.push(Relief {
            mission: Mission::KeepDefend(pi),
            pi,
            tile: k.tile,
            deadline: k.contest_from_bell + quarter,
            attacker: k.contender,
        });
    }
    for &t in &w.msieges {
        let x = w.hold(t);
        let Some(s) = x.siege else { continue };
        if x.faction != f || x.free_city() {
            continue;
        }
        needs.push(Relief {
            mission: Mission::Defend(t),
            pi: x.prov,
            tile: x.tile,
            deadline: s.declared + s.required.div_ceil(4),
            attacker: s.attacker_faction,
        });
    }
    for r in needs {
        let _ = r.attacker;
        if b >= r.deadline {
            continue;
        }
        let going = w
            .hosts
            .values()
            .filter(|h| {
                h.mission == r.mission
                    && h.faction == f
                    && matches!(
                        h.state,
                        HostState::Marching { .. } | HostState::Stationed { .. }
                    )
            })
            .count();
        if going >= WAVE_HOSTS {
            continue;
        }
        let m = w.prov(r.pi).march;
        let mut cands: Vec<(MilliTroops, u32, u32)> = Vec::new();
        for q in w.provinces_near(w.prov(r.pi).coord, MAX_MARCH_DIST) {
            if w.prov(q).march != m {
                continue;
            }
            let Some(hs) = by_prov.get(&q) else { continue };
            for &h in hs {
                let y = w.hold(h);
                if y.siege.is_some() || y.occupied || decided.contains(&y.owner) {
                    continue;
                }
                if !matches!(
                    w.arch_of(y.owner),
                    Some(Arch::Skilled | Arch::VerySkilled | Arch::Bot)
                ) {
                    continue;
                }
                let n = y.garrison / 4;
                if n < MIN_HOST_TROOPS {
                    continue;
                }
                if w.travel(f, q, r.pi, b).is_none_or(|(a, _)| a > r.deadline) {
                    continue;
                }
                cands.push((n, h, y.owner));
            }
        }
        cands.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
        let mut sent = going;
        let mut seen: Vec<u32> = Vec::new();
        for (n, h, o) in cands {
            if sent >= WAVE_HOSTS {
                break;
            }
            if seen.contains(&o) {
                continue;
            }
            seen.push(o);
            if w.epoch_driven(o) {
                decided.insert(o);
                if !heeds_epoch(w, false, rng) {
                    continue;
                }
            }
            if w.send_at(o, h, n, r.pi, r.tile, r.mission, b, 0, out)
                .is_some()
            {
                sent += 1;
            }
        }
    }
}

/// The hourly planner epoch (§8.6) for the campaign factions `factions`
/// (the simulator's `mc_campaign_epoch`, in its order: the Herald's Call
/// at a day start, then per faction update, fill, defence and launch, each
/// faction seeing the previous factions' launches).
pub fn plan_epoch(
    w: &mut World,
    board: &mut Board,
    factions: &[bool; 6],
    rng: &mut Rng,
) -> EpochPlan {
    let b = w.bell;
    let mut plan = EpochPlan::default();
    if !factions.iter().any(|&x| x) || !b.is_multiple_of(HOUR_BELLS) {
        return plan;
    }
    if b.is_multiple_of(BELLS_PER_DAY) && w.params.keeps {
        w.call = herald_call(w, b);
    }
    let members = w.members();
    let by_prov: Vec<BTreeMap<u32, Vec<u32>>> = (0..6u8).map(|f| w.by_prov(f)).collect();
    let mut decided: BTreeSet<u32> = BTreeSet::new();
    for f in 0..6u8 {
        if !factions[f as usize] {
            continue;
        }
        campaign_update(w, board, f, b);
        let k = members[f as usize].div_ceil(MEMBERS_PER_CAMPAIGN) as usize;
        campaign_fill(
            w,
            board,
            f,
            b,
            k,
            &by_prov[f as usize],
            &mut plan.stats,
            &mut plan.candidates,
        );
        defence_plan(
            w,
            f,
            b,
            &by_prov[f as usize],
            &mut decided,
            rng,
            &mut plan.dispatches,
        );
        campaign_launch(
            w,
            board,
            f,
            b,
            &by_prov[f as usize],
            &mut decided,
            rng,
            &mut plan.dispatches,
            &mut plan.stats,
        );
    }
    plan
}

/// One faction's plan of an epoch, as every bot of the faction computes it
/// (§8.6 `campaign::plan`): deterministic in (`fleet_seed`, faction,
/// epoch, world, board). The board comes back advanced to this epoch.
pub fn plan(
    fleet_seed: u64,
    faction: u8,
    world: &World,
    board: &Board,
) -> (Board, EpochPlan, World) {
    let mut w = world.clone();
    let mut bd = board.clone();
    let mut factions = [false; 6];
    if (faction as usize) < 6 {
        factions[faction as usize] = true;
    }
    let mut rng = Rng::fork(
        fleet_seed,
        0x4350_4C41_4E00_0000 | (w.bell as u64) << 8 | faction as u64,
    );
    let p = plan_epoch(&mut w, &mut bd, &factions, &mut rng);
    (bd, p, w)
}

/// Rally stay (A-26): a campaign faction's Rally host that arrives on its
/// target's hex stays while the strike is pending or the target's MC
/// siege is live; a lone faction's goes home.
pub fn rally_stays(w: &World, board: &Board, target: u32, campaign_faction: bool) -> bool {
    let live = w.holds.get(&target).is_some_and(|x| x.siege.is_some())
        || board.pending.contains_key(&target);
    live && campaign_faction
}

/// A session-driven member (`mc_campaign_session`): reads its faction's
/// plan as a public board and joins the first campaign in reach that still
/// needs strength, or starts one, when the group would meet its boldness
/// margin and it heeds the plan (`aggression`, × keep interest for a keep).
pub fn board_join(
    w: &mut World,
    board: &mut Board,
    a: u32,
    aggression: f64,
    rng: &mut Rng,
) -> Option<Dispatch> {
    let b = w.bell;
    let f = w.agent(a).faction;
    if board.camps[f as usize].is_empty() {
        return None;
    }
    let mg = w.arch_of(a).and_then(margin)?;
    let hs = w.agent(a).holdings.clone();
    let &src = hs.iter().max_by_key(|&&h| {
        let y = w.hold(h);
        (
            y.garrison.saturating_sub(w.keep_back(h)),
            std::cmp::Reverse(h),
        )
    })?;
    let spare = w.hold(src).garrison.saturating_sub(w.keep_back(src));
    if spare < MIN_HOST_TROOPS || w.hold(src).siege.is_some() {
        return None;
    }
    let per = w.per_troop(f);
    let sp = w.hold(src).prov;
    let n = board.camps[f as usize].len();
    for ci in 0..n {
        let c = board.camps[f as usize][ci].clone();
        if !w.target_legal(c.target, f, b) {
            continue;
        }
        let (tp, tile, keep) = match c.target {
            Target::Keep(pi) => (pi, w.prov(pi).keep.expect("keep").tile, true),
            Target::Hold(t) => (w.hold(t).prov, w.hold(t).tile, false),
        };
        let Some((arrive, _)) = w.travel(f, sp, tp, b) else {
            continue;
        };
        let def = match c.target {
            Target::Keep(pi) => w.keep_def(pi),
            Target::Hold(t) => w.hold_def(t),
        };
        let want = def.max(1.0) * GROUP_MARGIN / per;
        let live: Vec<u32> = c
            .attempt
            .as_ref()
            .map(|at| {
                at.hosts
                    .iter()
                    .copied()
                    .filter(|&h| w.host_live(h))
                    .collect()
            })
            .unwrap_or_default();
        let sent: f64 = live.iter().map(|&h| w.host(h).troops as f64).sum();
        if sent >= want * 1.2 {
            continue;
        }
        if (sent + spare as f64) * per < mg * def {
            continue;
        }
        let lead_troops = live.iter().map(|&h| w.host(h).troops).max();
        if let Target::Hold(t) = c.target {
            if lead_troops.is_none() && !w.can_declare(a, src, t, b) {
                continue;
            }
            if lead_troops.is_none()
                && w.hold(t).siege.is_none()
                && !w.can_finish(t, arrive.max(b) + 1, b)
            {
                continue;
            }
        }
        let heed = aggression * if keep { w.params.keep_aggr } else { 1.0 };
        if !rng.chance(heed.min(1.0)) {
            continue;
        }
        let mut n_troops = (((want * 1.2 - sent).max(0.0)) as MilliTroops)
            .max(MIN_HOST_TROOPS)
            .min(spare);
        if let (Target::Hold(_), Some(l)) = (c.target, lead_troops) {
            n_troops = n_troops.min(l.saturating_sub(MILLI as MilliTroops));
            if n_troops < MIN_HOST_TROOPS {
                continue;
            }
        }
        let (mission, rally) = match c.target {
            Target::Keep(pi) => (Mission::Keep(pi), Mission::KeepRally(pi)),
            Target::Hold(t) => (Mission::Siege(t), Mission::Rally(t)),
        };
        let ms = if live.is_empty() { mission } else { rally };
        let mu = c.attempt.as_ref().map_or(0, |at| at.muster);
        let mut out = Vec::new();
        let Some(h) = w.send_at(
            a,
            src,
            n_troops,
            tp,
            tile,
            ms,
            b,
            if b < mu { mu } else { 0 },
            &mut out,
        ) else {
            continue;
        };
        let arrive = w.host_arrival(h);
        if w.params.siege_hold && w.occ_target(&c.target) {
            let own = w.host(h).troops;
            let total = sent as MilliTroops + own;
            w.set_retreat(h, occ_retreat(total, own), &mut out);
        }
        if let Target::Hold(t) = c.target {
            let e = board.pending.entry(t).or_insert(0);
            *e = (*e).max(arrive + 6);
        }
        let slot = &mut board.camps[f as usize][ci].attempt;
        match slot {
            Some(at) => at.hosts.push(h),
            None => {
                *slot = Some(Attempt {
                    muster: arrive,
                    hosts: vec![h],
                })
            }
        }
        return out.pop();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_hold_rule_is_the_sheet_formula() {
        assert_eq!(occ_retreat(1_000_000, 1_000_000), 10_000);
        assert_eq!(occ_retreat(3_000_000, 1_000_000), 30_000);
        assert_eq!(occ_retreat(100_000_000, 1_000_000), 60_000);
        assert_eq!(occ_retreat(500_000, 1_000_000), 6_667);
        assert_eq!(occ_retreat(0, 0), 10_000);
    }

    #[test]
    fn cq_margins_and_constants_are_the_contracts() {
        assert_eq!(margin(Arch::VerySkilled), Some(1.3));
        assert_eq!(margin(Arch::Skilled), Some(1.5));
        assert_eq!(margin(Arch::Daily), Some(2.0));
        assert_eq!(margin(Arch::Casual), Some(3.0));
        assert_eq!(margin(Arch::Idle), None);
        assert_eq!((OCC_SLOTS, HOLDING_SLOTS, MEMBERS_PER_CAMPAIGN), (1, 1, 40));
        assert!(Target::Keep(u32::MAX) < Target::Hold(0));
    }

    /// K2: the Horseman marches with no surcharge under MC; a Spearman
    /// never pays one.
    #[test]
    fn cq_surcharge_is_train_v2() {
        assert_eq!(march_surcharge_mc(UnitType::Horseman, 10), [0; RESOURCES]);
        assert_eq!(march_surcharge_mc(UnitType::Spearman, 10), [0; RESOURCES]);
        assert_eq!(march_surcharge_mc(UnitType::Spearman, 0), [0; RESOURCES]);
    }
}
