//! The live (not per-bell) answers built from the fold's captures:
//! `/h/season`, `/h/province/{P},{Q}/latest` and `/h/me/{wallet}`
//! (contract §8.4, §9.2; the shapes the web page reads are pinned by
//! `permutation-gateway/test/fixtures/frontier/*.json`).

use serde_json::{json, Value};
use solana_address::Address;

use fclient::decode::{Citizen, Frontier, Holding, Province};
use fclient::ports::ChainInfo;
use frontier_abi::addr::{holding_key_of_host, host_id};
use frontier_abi::layout::AccountKind;

use crate::fold::Fold;
use crate::records::B64;
use base64::Engine;

/// What the season record states besides the chain: the cluster name, the
/// drand network the season seals to, the relay's quotas.
#[derive(Clone, Debug)]
pub struct SeasonStatic {
    pub cluster: String,
    pub drand: ChainInfo,
    pub quotas: Value,
}

/// `GET /h/season` (`None` until the Season account is captured).
pub fn season_json(f: &Fold, s: &SeasonStatic) -> Option<Value> {
    let addr = f.season_address();
    let c = f.account(&addr)?;
    let se = f.season.as_ref()?;
    let mut rings: std::collections::BTreeMap<u16, [u8; 32]> = f.st.ring_seeds.clone();
    let r_max = crate::world::r_max(f).unwrap_or(se.r_max);
    for d in 0..=r_max.min(128) {
        if let Some(rc) = f.account(&f.ctx.ring_seed(d)) {
            // status 2 = seeded; the seed at 40.
            if rc.data.get(18) == Some(&2) {
                if let Some(seed) = rc.data.get(40..72).and_then(|x| x.try_into().ok()) {
                    rings.insert(d, seed);
                }
            }
        }
    }
    // The Frontier account's per-wedge site counters (§5.9 overflow rule: a wedge is
    // full when WEDGE_OPEN − WEDGE_OCCUPIED = 0). The page's automatic site ticket reads
    // them (DECISIONS V2); null until the account is folded.
    let frontier = f
        .account(&f.ctx.frontier())
        .and_then(|c| Frontier::decode(&c.data).ok());
    let (wedge_open, wedge_occupied) = match &frontier {
        Some(fr) => (json!(fr.wedge_open), json!(fr.wedge_occupied)),
        None => (Value::Null, Value::Null),
    };
    let mut v = json!({
        "v": 1,
        "programId": f.cfg.program.to_string(),
        "cluster": s.cluster,
        "sample": s.cluster.trim().eq_ignore_ascii_case("fixture"),
        "season": f.cfg.season_id.to_string(),
        "seasonAddress": Address::new_from_array(addr).to_string(),
        "genesisTs": se.genesis_ts,
        "bellSecs": se.bell_secs,
        "W": se.reveal_window,
        "windowNext": se.window_next,
        "windowFromBell": se.window_from_bell,
        "delta": se.seed_margin,
        "drand": {
            "chainHash": hex::encode(s.drand.chain_hash),
            "publicKey": hex::encode(s.drand.public_key),
            "period": s.drand.period,
            "genesis": s.drand.genesis_time,
        },
        "rulesetHash": hex::encode(se.ruleset_hash),
        "rMax": r_max,
        "wedgeOpen": wedge_open,
        "wedgeOccupied": wedge_occupied,
        "rings": rings.iter().map(|(d, seed)| json!({"d": d, "seed": hex::encode(seed)})).collect::<Vec<_>>(),
        "tipPriorityMilli": se.min_reveal_priority_milli,
        "revealCuLimit": se.reveal_cu_limit,
        "revealLoadedLimit": se.reveal_loaded_limit,
        "marchFee": se.march_fee.to_string(),
        "sealBond": se.seal_bond.to_string(),
        "quotas": s.quotas,
        "headSeq": f.st.events.to_string(),
        "latestSlot": f.live.map_or(f.st.last_slot, |l| l.0.max(f.st.last_slot)),
        "latestUnix": f.live.map_or(f.st.last_time, |l| l.1),
        "slot": c.slot,
        "bytes_b64": B64.encode(&c.data),
    });
    // Map growth (`world.rs`): `rings` above lists the seeded rings only;
    // `ringsOpened` also counts a ring whose seed is on its way, and
    // `ringProvinces[d]` how many of ring d's Provinces are on chain, so a
    // page tells "pending" land from land that is not open at all.
    let states = crate::world::ring_states(f);
    v["ringsOpened"] = json!(states.len());
    v["ringProvinces"] = json!(states.iter().map(|r| r.provinces).collect::<Vec<_>>());
    // Read from the captured Season bytes; an absent or inconsistent flag
    // never changes the page into a continuous-world view.
    v["continuous"] = json!(se.world_continues());
    // Map growth and first-home placement (the same as the Season bytes say;
    // spelled out for readers that do not decode them): the ceiling (0: none),
    // the hard limit, the prize tally's last ring, the placement, the
    // heartland rings and the genesis seed `home_nation` reads.
    v["rMaxCeiling"] = json!(crate::world::r_max_ceiling(f));
    v["rMaxHard"] = json!(permutation_rules::frontier::geometry::R_MAX_HARD);
    v["prizeMaxRing"] = json!(crate::world::PRIZE_MAX_RING);
    v["placement"] = json!(crate::world::placement(f));
    v["heartlandMaxRing"] = se
        .conquest
        .as_ref()
        .map_or(Value::Null, |c| json!(c.heartland_max_ring));
    v["genesisSeed"] = json!(hex::encode(se.genesis_seed));
    Some(v)
}

/// `GET /h/province/{P},{Q}/latest`: the current Province bytes; `bell` is
/// the next bell it resolves, with that bell's slots, day and inputs as
/// they stand.
pub fn province_latest(f: &Fold, p: i16, q: i16) -> Option<Value> {
    let c = f.account(&f.ctx.province(p as i32, q as i32))?;
    let pv = Province::decode(&c.data).ok()?;
    f.envelope((p, q), pv.resolved_next)
}

/// One captured account as `/h/me` answers it (`Null` when absent).
pub fn account_json(f: &Fold, a: &[u8; 32]) -> Value {
    acct(f, a)
}

fn acct(f: &Fold, a: &[u8; 32]) -> Value {
    match f.account(a) {
        Some(c) => {
            let (seq, head) = c.head().unwrap_or((0, [0; 32]));
            json!({"address": Address::new_from_array(*a).to_string(), "slot": c.slot,
                "seq": seq.to_string(), "head": hex::encode(head), "bytes_b64": B64.encode(&c.data)})
        }
        None => Value::Null,
    }
}

/// `GET /h/me/{wallet}`: the Citizen, its ≤ 3 Holdings (bytes), their
/// hosts wherever they stand, transit records, open ArrivalSlots, settled
/// seal codes, and the relay quota (`quota`, fetched by the caller).
pub fn me_json(f: &Fold, wallet: &Address, quota: Value) -> Value {
    let ca = crate::conquest::me_citizen(f, &wallet.to_bytes());
    let citizen = f.account(&ca).and_then(|c| Citizen::decode(&c.data).ok());
    let mut holdings = vec![];
    let mut keys = vec![];
    let mut transits = vec![];
    if let Some(ci) = &citizen {
        let cq = ci.h.layout_version >= 2;
        for (slot, s) in ci.holding.iter().enumerate().filter(|(slot, s)| {
            if cq {
                s.gen != 255
            } else {
                *slot < ci.holdings_n.min(3) as usize
            }
        }) {
            let _ = slot;
            let ha = f.ctx.holding(s.p as i32, s.q as i32, s.site);
            if let Some(hk) = host_id(s.p as i32, s.q as i32, s.site, s.gen, 0) {
                keys.push(holding_key_of_host(hk));
            }
            if let Some(h) = f.account(&ha).and_then(|c| Holding::decode(&c.data).ok()) {
                if cq && (h.gen != s.gen || h.owner_citizen.to_bytes() != ca) {
                    continue;
                }
                holdings.push(acct(f, &ha));
                for (i, t) in h.transit.iter().enumerate().filter(|(_, t)| t.state != 0) {
                    transits.push(json!({
                        "holding": [s.p, s.q, s.site], "transitSlot": i, "state": t.state,
                        "host": t.host_id.to_string(), "departBell": t.depart_bell, "arriveBell": t.arrive_bell,
                        "sealRoot": hex::encode(t.seal_root), "tip": t.tip.to_string(),
                    }));
                }
            }
        }
    }
    let mut hosts = vec![];
    let mut slots = vec![];
    if !keys.is_empty() {
        hosts = f.player_hosts.hosts(&keys);
        if let Some(ci) = &citizen {
            for address in f.player_hosts.arrivals(ci.citizen_tag) {
                if let Some(c) = f.account(address) {
                    let key = crate::records::account_key(AccountKind::ArrivalSlot, &c.data, "");
                    slots.push(
                        json!({"key": key, "slot": c.slot, "bytes_b64": B64.encode(&c.data)}),
                    );
                }
            }
        }
    }
    let mut seals = vec![];
    for k in &keys {
        for (h, s) in f.st.seals.range(*k..=(*k | 0xFFFF_FFFF)) {
            seals.push(json!({"host": h.to_string(), "outcome": s.outcome, "code": s.code, "bell": s.bell}));
        }
    }
    let mut v = json!({
        "v": 1,
        "wallet": wallet.to_string(),
        "citizen": acct(f, &ca),
        "holdings": holdings,
        "hosts": hosts,
        "transits": transits,
        "slots": slots,
        "seals": seals,
        "quota": quota,
        "latestSlot": f.st.last_slot,
    });
    #[cfg(feature = "wide-world-experimental")]
    {
        // The viewer's wide inventory, kept apart from `holdings` (never a
        // legacy Holding at (0,0)): the identity envelope every entry is
        // checked against, then the slots. Both additive; a page reads them
        // together or not at all.
        v["wideContext"] = crate::wide::context_for_citizen(f, &ca);
        v["wideHoldings"] = crate::wide::holdings_for_citizen(f, &ca);
    }
    // MC (CQ2-E, §8.4): `alerts[]`, `sieges[]` and the caller's players
    // row; an M1 season's answer is unchanged.
    if let (Some((alerts, sieges, player)), Some(o)) = (
        crate::conquest::me_additions(f, &wallet.to_bytes()),
        v.as_object_mut(),
    ) {
        o.insert("alerts".into(), alerts);
        o.insert("sieges".into(), sieges);
        o.insert("player".into(), player);
    }
    v
}
