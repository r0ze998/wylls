//! The adversarial conquest personas of MC contract v1.3 §8.6 (each ≤ 1%
//! of bots in the exit run; criterion 13), what each one does and the
//! outcome it expects. A persona whose outcome is a refusal predicts its
//! code with the local checks of [`crate::cqbehave`] (the program decides;
//! the bot's report compares the code it got with [`CqPersona::expected`]);
//! the others' outcomes are read off the chain by the stack report and the
//! verifier.

use frontier_abi::error::FrontierError;
use frontier_abi::v2::error::{Code, CqError};
use permutation_rules::frontier::geometry::is_heartland_in;

use crate::campaign::{Board, HostState, Mission, Target, World, NONE};
use crate::cqbehave::{declare_check, lead_on, outpost_check, CqIntent, SiteStates};
use crate::profile::BELLS_PER_DAY;

/// The conquest personas (§8.6, v1.1 additions included).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CqPersona {
    SiegeHeartland,
    SiegeShielded,
    SiegeSeat,
    SiegeLate,
    SiegeDouble,
    SiegeOffhex,
    FirstTaker,
    CaptureCap,
    LeadRacer,
    RetireForeign,
    RespiteFarmer,
    PingpongPair,
    PhantomDefender,
    VigilHopper,
    ImmunityFarmer,
    KeepHeartland,
    KeepConsolidation,
    OutpostInterior,
    SiegeSpammer,
}

/// What a persona expects (§8.6 table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expect {
    /// Refused with this code (the program's, or the relay's quota).
    Refused(Code),
    /// An outcome on the chain (stack report, verifier).
    Outcome(&'static str),
}

impl CqPersona {
    pub const ALL: [CqPersona; 19] = [
        CqPersona::SiegeHeartland,
        CqPersona::SiegeShielded,
        CqPersona::SiegeSeat,
        CqPersona::SiegeLate,
        CqPersona::SiegeDouble,
        CqPersona::SiegeOffhex,
        CqPersona::FirstTaker,
        CqPersona::CaptureCap,
        CqPersona::LeadRacer,
        CqPersona::RetireForeign,
        CqPersona::RespiteFarmer,
        CqPersona::PingpongPair,
        CqPersona::PhantomDefender,
        CqPersona::VigilHopper,
        CqPersona::ImmunityFarmer,
        CqPersona::KeepHeartland,
        CqPersona::KeepConsolidation,
        CqPersona::OutpostInterior,
        CqPersona::SiegeSpammer,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CqPersona::SiegeHeartland => "siege_heartland",
            CqPersona::SiegeShielded => "siege_shielded",
            CqPersona::SiegeSeat => "siege_seat",
            CqPersona::SiegeLate => "siege_late",
            CqPersona::SiegeDouble => "siege_double",
            CqPersona::SiegeOffhex => "siege_offhex",
            CqPersona::FirstTaker => "first_taker",
            CqPersona::CaptureCap => "capture_cap",
            CqPersona::LeadRacer => "lead_racer",
            CqPersona::RetireForeign => "retire_foreign",
            CqPersona::RespiteFarmer => "respite_farmer",
            CqPersona::PingpongPair => "pingpong_pair",
            CqPersona::PhantomDefender => "phantom_defender",
            CqPersona::VigilHopper => "vigil_hopper",
            CqPersona::ImmunityFarmer => "immunity_farmer",
            CqPersona::KeepHeartland => "keep_heartland",
            CqPersona::KeepConsolidation => "keep_consolidation",
            CqPersona::OutpostInterior => "outpost_interior",
            CqPersona::SiegeSpammer => "siege_spammer",
        }
    }

    pub fn parse(s: &str) -> Option<CqPersona> {
        CqPersona::ALL.into_iter().find(|p| p.name() == s)
    }

    /// The outcome §8.6 expects.
    pub fn expected(self) -> Expect {
        use CqPersona::*;
        let cq = |e| Expect::Refused(Code::Cq(e));
        match self {
            SiegeHeartland => cq(CqError::Heartland),
            SiegeShielded => Expect::Refused(Code::V1(FrontierError::Shielded)),
            SiegeSeat => Expect::Refused(Code::V1(FrontierError::ReservedSite)),
            SiegeLate => cq(CqError::TooLate),
            SiegeDouble => cq(CqError::SiegeBusy),
            SiegeOffhex => cq(CqError::NotOnHex),
            FirstTaker => Expect::Outcome("occupation only; V16 sees no transfer"),
            CaptureCap => cq(CqError::HoldingsFull),
            LeadRacer => cq(CqError::NotLead),
            RetireForeign => cq(CqError::NotLead),
            RespiteFarmer => Expect::Outcome(
                "LIBERATED with no_respite; a third faction may declare the next bell",
            ),
            PingpongPair => Expect::Outcome(
                "captures after the first uncredited (captures_by unchanged, stores zeroed)",
            ),
            PhantomDefender => Expect::Outcome("progress continues; civilians never count"),
            VigilHopper => Expect::Outcome("the horn's snapshot applies"),
            ImmunityFarmer => Expect::Outcome("the siege fails with no immunity; stake burned"),
            KeepHeartland => Expect::Outcome("no progress (flag heartland)"),
            KeepConsolidation => Expect::Outcome("no progress until consolidated_until_bell"),
            OutpostInterior => cq(CqError::OutpostRule),
            SiegeSpammer => cq(CqError::SiegeCap),
        }
    }

    /// Whether `code` (a program or relay code name) is an expected refusal
    /// of this persona. §8.6 names one code per persona, with two
    /// readings (CQ2-F notes D-10/D-11):
    ///
    /// - `siege_seat` declares on a Seat's reserved site; the program's
    ///   §3.4 step 3 refuses that `NotBesiegeable` (state 4 is no holding
    ///   and no Free City), and `ReservedSite` is only `may_besiege`'s
    ///   Seat test on a holding of a ring-1 Province, so either is the
    ///   expected refusal;
    /// - `siege_spammer`'s refusal beyond `sieges_per_day` is the relay's
    ///   `QuotaExceeded` (or `RateLimited`) on the relay route and the
    ///   program's `SiegeCap` on a direct one.
    pub fn accepts(self, code: &str) -> bool {
        let Expect::Refused(c) = self.expected() else {
            return false;
        };
        code == c.name()
            || match self {
                CqPersona::SiegeSeat => code == "NotBesiegeable",
                CqPersona::SiegeSpammer => matches!(code, "QuotaExceeded" | "RateLimited"),
                _ => false,
            }
    }

    /// Whether the bot itself sees the expected outcome (a refusal).
    pub fn locally_checkable(self) -> bool {
        matches!(self.expected(), Expect::Refused(_))
    }
}

/// The agent's resident hosts (World ids).
fn own_hosts(w: &World, agent: u32) -> Vec<u32> {
    w.hosts
        .iter()
        .filter(|(_, h)| h.owner == agent && matches!(h.state, HostState::Stationed { .. }))
        .map(|(&i, _)| i)
        .collect()
}

/// Enemy holdings on the tile of one of the agent's resident hosts:
/// `(host, holding id, site key)`.
fn on_hex(w: &World, agent: u32) -> Vec<(u32, u32, (i16, i16, u8))> {
    let f = w.agent(agent).faction;
    let mut out = vec![];
    for h in own_hosts(w, agent) {
        let x = w.host(h);
        let p = w.prov(x.prov);
        for (s, &t) in p.sites.iter().enumerate() {
            if t != NONE && w.hold(t).tile == x.tile && w.hold(t).faction != f {
                out.push((h, t, (p.coord.p as i16, p.coord.q as i16, s as u8)));
            }
        }
    }
    out
}

fn declare(w: &World, host: u32, site: (i16, i16, u8)) -> CqIntent {
    let x = w.host(host);
    CqIntent::DeclareSiege {
        src: x.home,
        host,
        site,
        nearby: crate::cqbehave::first_nearby_hold(w, w.agent(x.owner).faction, x.prov),
    }
}

fn march_to(w: &World, agent: u32, t: Target, mission: Mission) -> Option<CqIntent> {
    let src = *w.agent(agent).holdings.first()?;
    let (pi, tile) = match t {
        Target::Keep(pi) => (pi, w.prov(pi).keep?.tile),
        Target::Hold(h) => (w.hold(h).prov, w.hold(h).tile),
    };
    let pc = w.prov(pi).coord;
    let troops = (w.hold(src).garrison / 2).max(permutation_rules::frontier::host::MIN_HOST_TROOPS);
    Some(CqIntent::March {
        host: NONE,
        src,
        troops,
        to: (pc.p as i16, pc.q as i16),
        tile,
        arrive_min: 0,
        retreat: None,
        mission,
    })
}

/// The action persona `p` (wallet `agent`) takes now, with what it
/// expects. `None`: nothing to do yet (no target in view).
pub fn act(
    p: CqPersona,
    w: &World,
    states: &SiteStates,
    board: &Board,
    agent: u32,
) -> Option<(CqIntent, Expect)> {
    // The spammer declares until the daily cap: it acts from a lead host
    // whose declaration the local checks refuse `SiegeCap` at the cap.
    if p == CqPersona::SiegeSpammer {
        let day = w.bell / BELLS_PER_DAY;
        let mut at_cap = w.clone();
        if let Some(a) = at_cap.agents.get_mut(&agent) {
            a.declares = (day, w.params.sieges_per_day);
        }
        let f = w.agent(agent).faction;
        let ex = p.expected();
        for (h, t, s) in on_hex(w, agent) {
            let x = w.hold(t);
            if lead_on(w, x.prov, x.tile, f, w.bell) != Some(h) {
                continue;
            }
            let it = declare(w, h, s);
            if local_code(&at_cap, states, agent, &it).is_some_and(|c| p.accepts(c.name())) {
                return Some((it, ex));
            }
        }
        return None;
    }
    // A refusal persona acts only when the situation gives the refusal it
    // is after (the local checks end in a code it expects).
    let r = act_inner(p, w, states, board, agent)?;
    if p.locally_checkable()
        && !local_code(w, states, agent, &r.0).is_some_and(|c| p.accepts(c.name()))
    {
        return None;
    }
    Some(r)
}

fn act_inner(
    p: CqPersona,
    w: &World,
    states: &SiteStates,
    board: &Board,
    agent: u32,
) -> Option<(CqIntent, Expect)> {
    use CqPersona::*;
    let b = w.bell;
    let f = w.agent(agent).faction;
    let ex = p.expected();
    let hexes = on_hex(w, agent);
    // An adversary acts when the situation gives the refusal it is after:
    // the first (host, target) of its kind whose local DeclareSiege checks
    // (§3.4 in order) end in a code it expects. (The program decides; the
    // report compares its code with the persona's.)
    let pick = |pred: &dyn Fn(u32, u32) -> bool| {
        hexes
            .iter()
            .filter(|(h, t, _)| pred(*h, *t))
            .find_map(|&(h, _, s)| {
                let it = declare(w, h, s);
                local_code(w, states, agent, &it)
                    .is_some_and(|c| p.accepts(c.name()))
                    .then_some((it, ex))
            })
    };
    let hmr = w.params.heartland_max_ring;
    match p {
        SiegeHeartland => pick(&|_, t| {
            let x = w.hold(t);
            !x.free_city() && is_heartland_in(w.prov(x.prov).coord, x.faction, hmr)
        }),
        SiegeShielded => pick(&|_, t| {
            let x = w.hold(t);
            !x.free_city() && x.shield_until > w.now(b) && !w.dormant(x, w.now(b))
        }),
        SiegeSeat => {
            let (&site, _) = states
                .iter()
                .find(|(_, &st)| st == frontier_abi::v2::layout::province::site::STATE_RESERVED)?;
            let host = *own_hosts(w, agent).first()?;
            let src = w.host(host).home;
            let it = CqIntent::DeclareSiege {
                src,
                host,
                site,
                nearby: None,
            };
            local_code(w, states, agent, &it)
                .is_some_and(|c| p.accepts(c.name()))
                .then_some((it, ex))
        }
        SiegeLate => pick(&|_, t| w.hold(t).siege.is_none() && !w.can_finish(t, b + 1, b)),
        SiegeDouble => pick(&|_, t| w.hold(t).siege.is_some()),
        SiegeOffhex => {
            let host = *own_hosts(w, agent).first()?;
            let x = w.host(host);
            let (&_t, site) = w.holds.iter().find_map(|(t, y)| {
                let pc = w.prov(y.prov).coord;
                let s = w.prov(y.prov).sites.iter().position(|q| q == t)?;
                (y.faction != f && y.alive && !(y.prov == x.prov && y.tile == x.tile))
                    .then_some((t, (pc.p as i16, pc.q as i16, s as u8)))
            })?;
            let it = CqIntent::DeclareSiege {
                src: x.home,
                host,
                site,
                nearby: None,
            };
            local_code(w, states, agent, &it)
                .is_some_and(|c| p.accepts(c.name()))
                .then_some((it, ex))
        }
        CaptureCap => {
            if w.free_slot23(agent).is_some() {
                return None;
            }
            pick(&|_, t| {
                let x = w.hold(t);
                x.free_city() || x.order >= 2
            })
        }
        LeadRacer => pick(&|h, t| {
            let x = w.hold(t);
            lead_on(w, x.prov, x.tile, f, b).is_some_and(|l| l != h)
        }),
        RetireForeign => {
            // A host of another faction whose home is now held by ours (a
            // captured holding's previous generation).
            let (&h, _) = w.hosts.iter().find(|(_, x)| {
                x.faction != f
                    && matches!(x.state, HostState::Stationed { .. })
                    && w.holds.get(&x.home).is_some_and(|y| y.faction == f)
            })?;
            Some((CqIntent::RetireHost { host: h }, ex))
        }
        OutpostInterior => {
            // The persona's own home province: its faction holds ≥ 50%.
            let home = *w.agent(agent).holdings.first()?;
            let pi = w.hold(home).prov;
            let pc = w.prov(pi).coord;
            let s = (0..w.prov(pi).sites.len() as u8)
                .find(|&s| w.prov(pi).sites[s as usize] == NONE)?;
            Some((
                CqIntent::FileOutpost {
                    anchor: home,
                    sites: vec![(pc.p as i16, pc.q as i16, s)],
                },
                ex,
            ))
        }
        SiegeSpammer | FirstTaker | ImmunityFarmer | VigilHopper => {
            // (The spammer's own rule is `act`'s.)
            // Declare on any enemy hex it stands on (the spammer past its
            // daily cap; the others as an honest horn whose outcome the
            // chain shows), else march on the plan's or the nearest target.
            if let Some(&(h, _, s)) = hexes.iter().find(|(_, t, _)| {
                p != FirstTaker || {
                    let x = w.hold(*t);
                    !x.free_city() && x.order <= 1
                }
            }) {
                return Some((declare(w, h, s), ex));
            }
            let t = board.camps[f as usize % 6]
                .iter()
                .map(|c| c.target)
                .find(|t| matches!(t, Target::Hold(_)))?;
            march_to(
                w,
                agent,
                t,
                Mission::Siege(match t {
                    Target::Hold(h) => h,
                    Target::Keep(k) => k,
                }),
            )
            .map(|m| (m, ex))
        }
        PingpongPair | RespiteFarmer => {
            let t = board.camps[f as usize % 6].first()?.target;
            march_to(
                w,
                agent,
                t,
                Mission::Siege(match t {
                    Target::Hold(h) | Target::Keep(h) => h,
                }),
            )
            .map(|m| (m, ex))
        }
        PhantomDefender => {
            // A Scout to an own besieged hex or a contested own keep.
            let t = w
                .msieges
                .iter()
                .copied()
                .find(|&t| w.hold(t).faction == f)
                .map(Target::Hold)
                .or_else(|| {
                    w.keep_live
                        .iter()
                        .copied()
                        .find(|&pi| w.prov(pi).keep.is_some_and(|k| k.holder == f))
                        .map(Target::Keep)
                })?;
            let mission = match t {
                Target::Hold(h) => Mission::Defend(h),
                Target::Keep(k) => Mission::KeepDefend(k),
            };
            march_to(w, agent, t, mission).map(|m| (m, ex))
        }
        KeepHeartland => {
            let pi = w
                .provs
                .iter()
                .find(|(_, p)| p.keep.is_some_and(|k| k.holder != f && k.heartland_safe))
                .map(|(&i, _)| i)?;
            march_to(w, agent, Target::Keep(pi), Mission::Keep(pi)).map(|m| (m, ex))
        }
        KeepConsolidation => {
            let pi = w
                .provs
                .iter()
                .find(|(_, p)| {
                    p.keep.is_some_and(|k| {
                        k.holder != f && !k.heartland_safe && k.consolidated_until_bell > b
                    })
                })
                .map(|(&i, _)| i)?;
            march_to(w, agent, Target::Keep(pi), Mission::Keep(pi)).map(|m| (m, ex))
        }
    }
}

/// The local verdict on a persona's action: the code the local checks
/// give (`None`: they pass) for a declaration, an outpost or a retire;
/// for a keep march, whether the keep can be contested.
pub fn local_code(w: &World, states: &SiteStates, agent: u32, it: &CqIntent) -> Option<Code> {
    let b = w.bell;
    match it {
        CqIntent::DeclareSiege {
            src, host, site, ..
        } => declare_check(w, states, agent, *src, *host, *site, b).err(),
        CqIntent::FileOutpost { sites, .. } => {
            let (p, q, _) = sites[0];
            let pi = permutation_rules::frontier::geometry::ProvinceCoord::new(p as i32, q as i32)
                .index();
            outpost_check(w, agent, pi, b).err()
        }
        CqIntent::RetireHost { host } => {
            let x = w.host(*host);
            // The victim is the captured holding's previous owner: never
            // the captor's faction.
            let victim_faction = x.faction;
            (w.agent(agent).faction != victim_faction).then_some(Code::Cq(CqError::NotLead))
        }
        CqIntent::March { .. } => None,
    }
}

/// The conquest personas of a roster of `n` bots (`--conquest`): each
/// persona to `per` bots, from the bots with no M1 persona, deterministic
/// in the fleet seed (`Rng::fork(seed, 0xC9)`).
pub fn assign(
    seed: u64,
    n: usize,
    taken: &dyn Fn(usize) -> bool,
    per: u32,
) -> std::collections::BTreeMap<usize, CqPersona> {
    let mut rng = crate::rng::Rng::fork(seed, 0xC9);
    let mut free: Vec<usize> = (0..n).filter(|&i| !taken(i)).collect();
    let mut out = std::collections::BTreeMap::new();
    // Each persona is at most 1% of the bots (§8.6; one bot at least).
    let per = per.min((n / 100).max(1) as u32);
    for p in CqPersona::ALL {
        for _ in 0..per {
            if free.is_empty() {
                return out;
            }
            let k = rng.below(free.len() as u64) as usize;
            out.insert(free.swap_remove(k), p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_nineteen_personas_with_unique_names() {
        assert_eq!(CqPersona::ALL.len(), 19);
        let mut names: Vec<&str> = CqPersona::ALL.iter().map(|p| p.name()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 19);
        for p in CqPersona::ALL {
            assert_eq!(CqPersona::parse(p.name()), Some(p));
        }
        let refusals = CqPersona::ALL
            .iter()
            .filter(|p| p.locally_checkable())
            .count();
        assert_eq!(refusals, 11);
    }

    #[test]
    fn cq_persona_assignment_is_deterministic_and_disjoint() {
        let a = assign(7, 1_000, &|i| i % 50 == 0, 1);
        assert_eq!(a, assign(7, 1_000, &|i| i % 50 == 0, 1));
        assert_eq!(a.len(), 19);
        assert!(a.keys().all(|i| i % 50 != 0));
    }
}
