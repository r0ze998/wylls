//! The `recall:<handle>` candidate (contract §4.3; unit AC3b): a new Depart
//! of an **arrived** own combat host back to the own holding tile. There is
//! no recall of an in-flight march: a host in transit is never offered.
//!
//! AC3a step 0 (a) found that the program accepts a march onto the own
//! holding tile (the Reveal refuses only another nation's shielded site), so
//! the kind stays. A host standing in the home province has no path to a tile
//! it already stands on, and counts as home troops anyway, so only a host in
//! **another province** is offered.
//!
//! Offered when such a host is ready (`ready::can_depart`) **and** one of
//! two triggers holds:
//!
//! - a **threat** is live: a DEPART of another nation's host whose origin is
//!   at most 3 provinces from the AI's home and whose arrival bell has not
//!   passed (the same public fact as the mind's W-THREAT wake; its
//!   destination is sealed, so the candidate says "destination unknown").
//!   The brain reads it from `GET /h/events` itself ([`ThreatFeed`]): the
//!   request has no field for it and the mind never builds candidates;
//! - the **home floor is low**: at home there are fewer than 40 % of the
//!   day's first-step home troops (`home_troops * 100 < 40 * H0`, H0 ≥ 200:
//!   the §4.5 V3 (c) floor, here already violated).
//!
//! A recall is not a march out: it is exempt from the V3 caps, is not
//! counted in the day's model marches (`DepartPlan.why == "home"`), and the
//! recalled host is reserved so that the Strike-Order follow never moves it
//! again for [`super::standing::RESERVE_BELLS`] bells (§3.6).
//!
//! Nothing here claims the model "wants" or "intends": the candidate states
//! facts (the threat's origin, mass and arrival bell; whether the host is
//! home by then) and the model chooses or does not.

use std::collections::BTreeMap;
use std::sync::Mutex;

use fclient::decode::Holding;
use frontier_agents::obs::Observation;
use frontier_agents::policy::Target;
use permutation_rules::frontier::geometry::ProvinceCoord;
use serde_json::{json, Map, Value};

use super::brain::{default_stance, plan_depart, Action, HostRow, Inputs, MarchKind, Offer, MILLI};
use super::fetch::{self, PathCache};
use super::follow::Side;
use super::mindport::Candidate;
use super::ready;
use crate::ports::HeraldPort;

/// Provinces from home within which a DEPART counts as a threat (§3.2 W-THREAT).
pub const THREAT_RADIUS: u32 = 3;
/// At most this many recalls are offered (§4.3: "next ≤ 2").
pub const MAX_RECALLS: usize = 2;
/// Threats kept per step (the largest by mass).
pub const MAX_THREATS: usize = 3;
/// Event pages one poll reads (the feed catches up over several bells when it
/// starts behind).
pub const MAX_PAGES: usize = 20;

/// A DEPART of another nation's host near the AI's home: what is public
/// about it (origin, mass, arrival bell; the destination is sealed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Threat {
    pub host_id: u64,
    pub origin: (i16, i16),
    pub nation: u8,
    /// Whole troops (the event carries milli-troops).
    pub mass: u32,
    pub depart_bell: u32,
    pub arrive_bell: u32,
}

/// One DEPART event, as `/h/events` decodes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawDepart {
    pub host_id: u64,
    pub origin: (i16, i16),
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub mass: u32,
}

/// Parses an `/h/events` page: the DEPART rows and the cursor.
pub fn parse_events(v: &Value) -> (Vec<RawDepart>, Option<u64>, bool) {
    let mut out = vec![];
    let int = |x: &Value| {
        x.as_i64()
            .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
    };
    for e in v
        .get("events")
        .and_then(Value::as_array)
        .map_or(&[][..], |a| &a[..])
    {
        let Some(d) = e.get("decoded") else { continue };
        if d.get("name").and_then(Value::as_str) != Some("DEPART") {
            continue;
        }
        let (Some(key), Some(pay)) = (d.get("key"), d.get("payload")) else {
            continue;
        };
        let get = |o: &Value, k: &str| o.get(k).and_then(int);
        let (Some(host), Some(op), Some(oq), Some(db), Some(ab), Some(m)) = (
            key.get("host_id").and_then(|x| {
                x.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or(x.as_u64())
            }),
            get(pay, "origin_p"),
            get(pay, "origin_q"),
            get(pay, "depart_bell"),
            get(pay, "arrive_bell"),
            get(pay, "dep_mass"),
        ) else {
            continue;
        };
        out.push(RawDepart {
            host_id: host,
            origin: (op as i16, oq as i16),
            depart_bell: db.max(0) as u32,
            arrive_bell: ab.max(0) as u32,
            mass: (m.max(0) as u64 / MILLI as u64) as u32,
        });
    }
    let next = v.get("next").and_then(int).map(|n| n.max(0) as u64);
    let full = v.get("full").and_then(Value::as_bool).unwrap_or(false);
    (out, next, full)
}

#[derive(Default)]
struct FeedState {
    after: u64,
    polled_bell: Option<u32>,
    departs: Vec<RawDepart>,
}

/// The DEPART events of the herald, polled once per bell for the whole
/// process (shared by every AI bot).
#[derive(Default)]
pub struct ThreatFeed {
    inner: Mutex<FeedState>,
}

impl ThreatFeed {
    pub fn new() -> ThreatFeed {
        ThreatFeed::default()
    }

    /// Reads the events since the last poll, at most once per `bell`.
    /// Returns `false` when the herald has no event index (the feed is then
    /// silent and no threat is ever offered).
    pub async fn poll<H: HeraldPort>(&self, herald: &H, bell: u32) -> bool {
        let mut after = {
            let mut g = self.inner.lock().expect("threat feed");
            if g.polled_bell == Some(bell) {
                return true;
            }
            g.polled_bell = Some(bell);
            g.after
        };
        let mut ok = true;
        for _ in 0..MAX_PAGES {
            let page = match herald.get(&format!("/h/events?after={after}")).await {
                Ok(Some(b)) => serde_json::from_slice::<Value>(&b).ok(),
                _ => None,
            };
            let Some(page) = page else {
                ok = false;
                break;
            };
            let (deps, next, full) = parse_events(&page);
            let mut g = self.inner.lock().expect("threat feed");
            g.departs.extend(deps);
            // A departure that has landed is never a threat again.
            g.departs.retain(|d| d.arrive_bell >= bell);
            if let Some(n) = next {
                if n > g.after {
                    g.after = n;
                    after = n;
                }
            }
            if !full {
                break;
            }
        }
        ok
    }

    /// Departures whose arrival bell has not passed at `bell`.
    pub fn live(&self, bell: u32) -> Vec<RawDepart> {
        self.inner
            .lock()
            .expect("threat feed")
            .departs
            .iter()
            .filter(|d| d.arrive_bell >= bell && d.depart_bell <= bell)
            .cloned()
            .collect()
    }

    /// Adds departures directly (the tests).
    pub fn push(&self, d: RawDepart) {
        self.inner.lock().expect("threat feed").departs.push(d);
    }
}

fn pdist(a: (i16, i16), b: (i16, i16)) -> u32 {
    ProvinceCoord::new(a.0 as i32, a.1 as i32).distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
}

/// The nation that owns a departed host: the faction of the holding site its
/// id names (the host id carries the holding's province, site and
/// generation), read from that province's file (the observation's, else the
/// fetch cache's: at most `budget` extra GETs).
async fn nation_of<H: HeraldPort>(
    herald: &H,
    cache: &PathCache,
    obs: &Observation,
    host_id: u64,
    budget: &mut usize,
) -> Option<u8> {
    let (p, q, site, _, _) = fclient::addr::host_parts(host_id).ok()?;
    let pq = (i16::try_from(p).ok()?, i16::try_from(q).ok()?);
    let mut gets = 0;
    let owned;
    let pv = match obs.province(pq.0, pq.1) {
        Some(pv) => pv,
        None => {
            owned = fetch::province(herald, cache, obs.bell(), pq, budget, &mut gets).await?;
            &owned.province
        }
    };
    let m = pv.site_mirror.get(site as usize)?;
    (m.state == fclient::abi::layout::site::STATE_HOLDING).then_some(m.faction)
}

/// The threats near `home` at this bell: live DEPARTs of **another** nation's
/// hosts whose origin is at most [`THREAT_RADIUS`] provinces from home, the
/// largest first. At most `budget` extra GETs (province files of owners that
/// are outside the observation).
pub async fn threats_near<H: HeraldPort>(
    feed: &ThreatFeed,
    herald: &H,
    cache: &PathCache,
    obs: &Observation,
    home: &Holding,
    budget: &mut usize,
) -> Vec<Threat> {
    let bell = obs.bell();
    feed.poll(herald, bell).await;
    let mut near: Vec<RawDepart> = feed
        .live(bell)
        .into_iter()
        .filter(|d| pdist(d.origin, (home.p, home.q)) <= THREAT_RADIUS)
        .filter(|d| !frontier_agents::policy::host_of(home, d.host_id))
        .collect();
    near.sort_by_key(|d| (std::cmp::Reverse(d.mass), d.arrive_bell, d.host_id));
    let mut out = vec![];
    for d in near {
        if out.len() == MAX_THREATS {
            break;
        }
        let Some(nation) = nation_of(herald, cache, obs, d.host_id, budget).await else {
            continue;
        };
        if nation == home.faction {
            continue;
        }
        out.push(Threat {
            host_id: d.host_id,
            origin: d.origin,
            nation,
            mass: d.mass,
            depart_bell: d.depart_bell,
            arrive_bell: d.arrive_bell,
        });
    }
    out
}

/// Whether the home floor is low: fewer than 40 % of the day's first-step
/// home troops are at home (H0 ≥ 200; below that "no floor", §4.5 V3 (c)).
pub fn home_floor_low(home_troops: u32, h0: u32) -> bool {
    h0 >= 200 && (home_troops as u64) * 100 < 40 * h0 as u64
}

/// The recall candidates (§4.3), in the pinned order after the Strike-Order
/// march: up to [`MAX_RECALLS`] ready combat hosts standing in another
/// province, largest first, while a threat is live or the home floor is low.
pub fn offer(inp: &Inputs, side: &Side) -> Vec<Offer> {
    let h = inp.h;
    let threat = side.threats.first();
    let floor_low = home_floor_low(inp.home_troops, inp.ds.h0);
    if threat.is_none() && !floor_low {
        return vec![];
    }
    let mut rows: Vec<&HostRow> = inp
        .rows
        .iter()
        .filter(|r| r.ready && r.e.unit != ready::SCOUT && r.at != (h.p, h.q))
        .collect();
    rows.sort_by_key(|r| (std::cmp::Reverse(r.e.troops), r.e.id));
    let home = Target {
        p: h.p,
        q: h.q,
        tile: h.tile,
        why: "home",
    };
    let mut out = vec![];
    for row in rows {
        if out.len() == MAX_RECALLS {
            break;
        }
        let Some((plan, hexes, provinces)) = plan_depart(
            inp.obs,
            h,
            row.at,
            &row.e,
            home,
            0,
            default_stance(inp.faction),
            0,
            inp.presets,
        ) else {
            continue;
        };
        let troops = row.troops();
        let arrive = plan.plain.arrive_bell;
        let mut facts = Map::new();
        facts.insert("host".into(), json!(row.handle));
        facts.insert("host_id".into(), json!(row.e.id.to_string()));
        facts.insert("troops".into(), json!(troops));
        let mut entities = vec![];
        match threat {
            Some(t) => {
                facts.insert(
                    "threat_origin".into(),
                    json!({"p": t.origin.0, "q": t.origin.1}),
                );
                facts.insert("threat_mass".into(), json!(t.mass));
                facts.insert("threat_arrive_bell".into(), json!(t.arrive_bell));
                facts.insert("destination".into(), json!("unknown"));
                facts.insert("home_by_arrival".into(), json!(arrive <= t.arrive_bell));
                entities.push(format!("pq:{},{}", t.origin.0, t.origin.1));
                entities.push(format!("nation:{}", t.nation));
            }
            None => {
                facts.insert("trigger".into(), json!("home_floor_low"));
                facts.insert("home_troops".into(), json!(inp.home_troops));
                facts.insert("home_troops_day_start".into(), json!(inp.ds.h0));
                entities.push(format!("pq:{},{}", row.at.0, row.at.1));
            }
        }
        facts.insert("hexes".into(), json!(hexes));
        facts.insert("provinces".into(), json!(provinces));
        facts.insert("earliest_bell".into(), json!(arrive));
        facts.insert(
            "reward".into(),
            json!("none: the army is back in the village"),
        );
        let mut params = BTreeMap::new();
        params.insert("timing".to_string(), vec![json!("earliest")]);
        out.push(Offer {
            cand: Candidate {
                id: String::new(),
                kind: format!("recall:{}", row.handle),
                label: format!(
                    "Recall {} ({} troops) to the village; earliest arrival at bell {}",
                    row.handle, troops, arrive
                ),
                facts: Value::Object(facts),
                params,
                council: false,
                troops: Some(troops),
                entities,
            },
            action: Action::March {
                host_id: row.e.id,
                at: row.at,
                target: home,
                kind: MarchKind::Recall,
                troops,
            },
        });
    }
    out
}
