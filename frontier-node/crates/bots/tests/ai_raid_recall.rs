//! The `raid` and `recall:<handle>` candidate kinds (contract §4.3; unit
//! AC3b).
//!
//! **Raid**: another nation's village tile that `policy::shield_refuses`
//! allows at the arrival bell (the target's shield and the sender's own),
//! with the shield state in the facts, the fixed reward text, and no
//! candidate while either shield runs. **Recall**: a new Depart of an arrived
//! own combat host to the own holding tile (AC3a step 0 (a): the program
//! accepts a march onto the own holding tile), offered only for a ready host
//! in another province and only while a threat is live or the home floor is
//! low; a recall is exempt from the V3 caps, is not a model march of the day,
//! and reserves the host. The DEPART reader ([`ThreatFeed`]) is checked on a
//! page of **real** `/h/events` rows recorded read-only from the paused
//! m1-exit herald.

#[path = "ai_follow_common.rs"]
mod fc;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use fc::common::*;
use fc::*;
use fclient::abi::layout::{entry as le, holding as lh, province as lp, site as ls};
use frontier_agents::fixture::{self, FINAL, SEED};
use frontier_agents::obs::{b64, b64_encode, Observation};
use frontier_agents::policy;
use frontier_bots::ai::brain::{self, Action, ChosenParams, Inputs, Taken};
use frontier_bots::ai::fetch::PathCache;
use frontier_bots::ai::follow::Side;
use frontier_bots::ai::recall::{self, RawDepart, Threat, ThreatFeed};
use frontier_bots::ai::standing::Standing;
use frontier_bots::ai::{By, DayState};
use frontier_bots::ports::{HeraldPort, PortResult};
use serde_json::{json, Value};

fn day(h0: u32, marches: Vec<(u32, u32)>) -> DayState {
    DayState {
        day: 0,
        h0,
        marches,
    }
}

fn inputs<'a>(obs: &'a Observation, ds: &'a DayState) -> Inputs<'a> {
    let h = brain::home_holding(obs).expect("a final holding");
    let rows = brain::host_rows(obs, h);
    let (home, _) = brain::home_troops(obs, h, &rows);
    Inputs {
        obs,
        h,
        faction: h.faction,
        ds,
        presets: obs
            .season
            .tip_presets(frontier_bots::bot::Config::new(SEED).reveal_loaded_limit()),
        autopilot_summary: String::new(),
        rows,
        home_troops: home,
        quota_left: 40,
    }
}

async fn observe(r: &Rig) -> Observation {
    ai_bot().observe(&r.sh).await.unwrap()
}

fn kinds(o: &[brain::Offer]) -> Vec<String> {
    o.iter().map(|x| x.cand.kind.clone()).collect()
}

fn raids(o: &[brain::Offer]) -> Vec<&brain::Offer> {
    o.iter()
        .filter(|x| x.cand.facts["target_kind"] == "raid")
        .collect()
}

fn golden_sample(pred: impl Fn(&Value) -> bool) -> Value {
    let g: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../permutation-gateway/test/fixtures/ai-decide-v1.json"),
        )
        .unwrap(),
    )
    .unwrap();
    g["candidate_samples_ac3b"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| pred(s))
        .cloned()
        .expect("a sample of that kind")
}

/// Every key of the pinned wire sample is in the real candidate.
fn has_sample_keys(real: &Value, sample: &Value) {
    for k in sample.as_object().unwrap().keys() {
        assert!(real.get(k).is_some(), "sample key {k}");
    }
    for part in ["facts", "params"] {
        for k in sample[part].as_object().unwrap().keys() {
            assert!(real[part].get(k).is_some(), "sample {part}.{k}");
        }
    }
}

// ------------------------------------------------------------------ patches

/// Every other nation's village is shielded far beyond the arrival bell.
fn patch_villages_shielded() -> Patch {
    patch_province(|bytes| {
        for s in 0..12 {
            let base = lp::SITE_MIRROR + s * lp::SITE_MIRROR_STRIDE;
            if bytes[base + ls::STATE] == ls::STATE_HOLDING && bytes[base + ls::FACTION] != 0 {
                let o = base + ls::SHIELD_UNTIL_BELL;
                bytes[o..o + 4].copy_from_slice(&9_999u32.to_le_bytes());
            }
        }
    })
}

/// The sender's own village shield runs until `ts` (the Holding's `shield_until`).
fn patch_own_shield(ts: i64) -> Patch {
    Box::new(move |path, b| {
        if !path.starts_with("/h/me/") {
            return b;
        }
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        if let Some(hs) = v["holdings"].as_array_mut() {
            for h in hs {
                let mut bytes = b64(h["bytes_b64"].as_str().unwrap()).unwrap();
                bytes[lh::SHIELD_UNTIL..lh::SHIELD_UNTIL + 8].copy_from_slice(&ts.to_le_bytes());
                h["bytes_b64"] = json!(b64_encode(&bytes));
            }
        }
        serde_json::to_vec(&v).unwrap()
    })
}

/// Every other nation's village is gone (its site is free).
fn patch_villages_gone() -> Patch {
    patch_province(|bytes| {
        for s in 0..12 {
            let base = lp::SITE_MIRROR + s * lp::SITE_MIRROR_STRIDE;
            if bytes[base + ls::STATE] == ls::STATE_HOLDING && bytes[base + ls::FACTION] != 0 {
                bytes[base + ls::STATE] = ls::STATE_FREE;
            }
        }
    })
}

fn entry_index(bytes: &[u8], id: u64) -> Option<usize> {
    (0..56).find(|&i| {
        let o = lp::ENTRIES + i * lp::ENTRY_STRIDE;
        bytes[o + le::STATE] != le::STATE_FREE
            && u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap()) == id
    })
}

/// Moves the host `id` from province `from` to `to`, standing on `tile`
/// (the files are as the chain stores them: troops in milli-troops).
fn patch_move_host(id: u64, from: (i16, i16), to: (i16, i16), tile: u8) -> Patch {
    let from_path = format!("/h/province/{},{}/", from.0, from.1);
    let to_path = format!("/h/province/{},{}/", to.0, to.1);
    let patch = move |path: &str, b: Vec<u8>| -> Vec<u8> {
        let (is_from, is_to) = (path.starts_with(&from_path), path.starts_with(&to_path));
        if !is_from && !is_to {
            return b;
        }
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        let mut bytes = b64(v["bytes"].as_str().unwrap()).unwrap();
        if is_from {
            let i = entry_index(&bytes, id).expect("the host is in its province");
            bytes[(lp::ENTRIES + i * lp::ENTRY_STRIDE) + le::STATE] = le::STATE_FREE;
        } else {
            let free = (0..56)
                .find(|&i| {
                    bytes[(lp::ENTRIES + i * lp::ENTRY_STRIDE) + le::STATE] == le::STATE_FREE
                })
                .expect("a free entry");
            let o = lp::ENTRIES + free * lp::ENTRY_STRIDE;
            bytes[o..o + 48].fill(0);
            bytes[o..o + 8].copy_from_slice(&id.to_le_bytes());
            bytes[o + le::FACTION] = 0;
            bytes[o + le::UNIT] = 0;
            bytes[o + le::TILE] = tile;
            bytes[o + le::STATE] = le::STATE_ROSTER;
            bytes[o + le::TROOPS..o + le::TROOPS + 4].copy_from_slice(&500_000u32.to_le_bytes());
            bytes[o + le::STAMINA_VALUE..o + le::STAMINA_VALUE + 2]
                .copy_from_slice(&120u16.to_le_bytes());
            bytes[o + le::STAMINA_BELL..o + le::STAMINA_BELL + 4]
                .copy_from_slice(&30u32.to_le_bytes());
            bytes[o + le::READY_BELL..o + le::READY_BELL + 4].copy_from_slice(&30u32.to_le_bytes());
            bytes[o + le::FROM_BELL..o + le::FROM_BELL + 4].copy_from_slice(&30u32.to_le_bytes());
        }
        v["bytes"] = json!(b64_encode(&bytes));
        serde_json::to_vec(&v).unwrap()
    };
    Box::new(patch)
}

/// A free, passable tile of `to` from which a march home is plannable.
fn away_tile(obs: &Observation, to: (i16, i16)) -> u8 {
    let pv = obs.province(to.0, to.1).expect("province in view");
    let h = brain::home_holding(obs).unwrap();
    let provs: BTreeMap<(i16, i16), &fclient::decode::Province> = obs
        .provinces
        .iter()
        .map(|(&k, v)| (k, &v.province))
        .collect();
    (0..61u8)
        .filter(|&t| {
            pv.passable_mask >> t & 1 == 1
                && !pv.sites[..pv.site_count as usize].contains(&t)
                && pv.camp.tile != t
                && pv
                    .entries
                    .iter()
                    .all(|e| e.state == le::STATE_FREE || e.tile != t)
        })
        .find(|&t| {
            frontier_agents::path::plan(
                &provs,
                (to.0 as i32, to.1 as i32),
                t,
                (h.p as i32, h.q as i32),
                h.tile,
                0,
            )
            .is_some()
        })
        .expect("a tile with a way home")
}

/// The fixture's enemy village: its province and a host id of its holding.
fn enemy(obs: &Observation) -> ((i16, i16), u8, u64) {
    for (&(p, q), v) in &obs.provinces {
        let pv = &v.province;
        for s in 0..pv.site_count as usize {
            let m = &pv.site_mirror[s];
            if m.state == ls::STATE_HOLDING && m.faction == 1 {
                return (
                    (p, q),
                    pv.sites[s],
                    fclient::addr::host_id(p as i32, q as i32, s as u8, m.gen, 1).unwrap(),
                );
            }
        }
    }
    panic!("an enemy village in view");
}

// ------------------------------------------------------------------ raid

#[tokio::test]
async fn a_raid_is_offered_with_its_shield_state_when_both_shields_have_ended() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let ds = day(1_000, vec![]);
    let inp = inputs(&obs, &ds);
    let offers = brain::candidates(&inp);
    let k = kinds(&offers);
    assert_eq!(&k[..2], &["autopilot", "hold"]);
    let raid = raids(&offers);
    assert_eq!(raid.len(), 1, "at most one raid: the nearest target");
    let o = raid[0];
    let (epq, etile, _) = enemy(&obs);
    let f = &o.cand.facts;
    assert_eq!(f["target"], json!({"p": epq.0, "q": epq.1, "tile": etile}));
    assert_eq!(
        f["shield"], "ended",
        "the shield state is a fact of the candidate"
    );
    assert_eq!(f["reward"], "troops lost only; no land can be taken");
    assert_eq!(f["ratio_is"], "estimate");
    assert_eq!(f["enemy_troops"], 200, "the garrison the site mirror shows");
    assert_eq!(f["troops"], 500);
    assert!(f["host_id"].is_string() && f["earliest_bell"].as_u64().unwrap() > 40);
    assert_eq!(
        o.cand.entities,
        vec![format!("pq:{},{}", epq.0, epq.1), "nation:1".to_string()]
    );
    assert_eq!(o.cand.params["timing"], vec![json!("earliest")]);
    assert_eq!(o.cand.params["stance"].len(), 4);
    assert!(!o.cand.council);
    // The text of the candidate never promises land or loot.
    let text = serde_json::to_string(&o.cand.to_json()).unwrap();
    assert!(!text.contains("capture") && !text.contains("loot") && !text.contains("Works"));
    // The pinned wire sample's keys are all there.
    has_sample_keys(
        &o.cand.to_json(),
        &golden_sample(|s| s["facts"]["target_kind"] == "raid"),
    );
    // The pinned order: the camp marches, then the raid, then the economy.
    let pos_raid = k.iter().rposition(|x| x == "march").unwrap();
    let pos_build = k.iter().position(|x| x.starts_with("build")).unwrap();
    assert!(pos_raid < pos_build);
    assert!(
        offers[2..pos_raid]
            .iter()
            .all(|x| x.cand.facts["target_kind"] == "camp"),
        "camps first"
    );
    assert_eq!(offers[pos_raid].cand.facts["target_kind"], "raid");
    // Deterministic, and the action is a march of kind Raid at that village.
    assert_eq!(offers, brain::candidates(&inp));
    let Action::March { target, kind, .. } = &o.action else {
        panic!("a march")
    };
    assert_eq!(*kind, brain::MarchKind::Raid);
    assert_eq!(
        (target.p, target.q, target.tile, target.why),
        (epq.0, epq.1, etile, "war")
    );
}

#[tokio::test]
async fn no_raid_while_the_target_shield_or_the_senders_own_shield_runs() {
    // The target's shield runs: the villages are shielded far past arrival.
    let r = rig(None, &[(FINAL, "ai")]);
    r.set_patch(Some(patch_villages_shielded()));
    let obs = observe(&r).await;
    let ds = day(1_000, vec![]);
    let inp = inputs(&obs, &ds);
    let offers = brain::candidates(&inp);
    assert!(
        raids(&offers).is_empty(),
        "the target's shield has not ended"
    );
    assert!(
        offers.iter().any(|o| o.cand.facts["target_kind"] == "camp"),
        "camps are still offered (§0.5: early in a run, camps and field stacks)"
    );
    // The sender's own shield runs (the program checks it at the arrival bell).
    let r = rig(None, &[(FINAL, "ai")]);
    r.set_patch(Some(patch_own_shield(fixture::GENESIS_TS + 400 * 600)));
    let obs = observe(&r).await;
    let inp = inputs(&obs, &ds);
    let offers = brain::candidates(&inp);
    assert!(
        raids(&offers).is_empty(),
        "the sender's own shield has not ended"
    );
    assert!(offers.iter().any(|o| o.cand.facts["target_kind"] == "camp"));
    // The control: neither shield runs.
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let inp = inputs(&obs, &ds);
    assert_eq!(raids(&brain::candidates(&inp)).len(), 1);
    // A shield that ends before the planned arrival bell does not block it:
    // the target's shield until bell 42, arrival at 44 or later.
    let r = rig(None, &[(FINAL, "ai")]);
    r.set_patch(Some(patch_province(|bytes| {
        for s in 0..12 {
            let base = lp::SITE_MIRROR + s * lp::SITE_MIRROR_STRIDE;
            if bytes[base + ls::STATE] == ls::STATE_HOLDING && bytes[base + ls::FACTION] != 0 {
                let o = base + ls::SHIELD_UNTIL_BELL;
                bytes[o..o + 4].copy_from_slice(&42u32.to_le_bytes());
            }
        }
    })));
    let obs = observe(&r).await;
    let inp = inputs(&obs, &ds);
    assert_eq!(
        raids(&brain::candidates(&inp)).len(),
        1,
        "judged at the arrival bell"
    );
}

#[tokio::test]
async fn the_caps_hold_for_the_raid_host_and_a_model_raid_is_sent_by_the_model() {
    // V3: no host may march ⇒ no raid (and no camp march) is offered.
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let spent = day(1_000, vec![(40, 600)]);
    let inp = inputs(&obs, &spent);
    assert!(raids(&brain::candidates(&inp)).is_empty());
    // A model choice of the raid is sent: by the model, as a march of the day.
    let fm = FakeMind::start(|req| {
        let id = req["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["facts"]["target_kind"] == "raid")
            .and_then(|c| c["id"].as_str())
            .expect("a raid candidate")
            .to_string();
        model_answer(
            &[&id],
            json!({id.clone(): {"stance": "brace", "retreat": 5000, "timing": "earliest"}}),
        )
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 1);
    let m = bot.ai.book.last().unwrap();
    assert_eq!((m.by, m.via), (By::Model, None));
    let obs = observe(&r).await;
    let (epq, etile, _) = enemy(&obs);
    assert_eq!(m.dest, (epq.0, epq.1, etile));
    assert_eq!(r.hook.stat_of("model_marches_sent"), 1);
    assert_eq!(bot.ai.day.as_ref().unwrap().marches.len(), 1);
}

#[tokio::test]
async fn v6_drops_a_raid_whose_village_is_gone_or_shielded_in_the_fresh_files() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let ds = day(1_000, vec![]);
    let offers = brain::candidates(&inputs(&obs, &ds));
    let raid = raids(&offers)[0].clone();
    let st = Standing::default();
    let p = ChosenParams::default();
    // Still there: re-planned.
    assert!(brain::replan(
        &raid.action,
        &p,
        &inputs(&obs, &ds),
        &mut Taken::default(),
        &st
    )
    .is_ok());
    // Gone in the fresh files.
    let r2 = rig(None, &[(FINAL, "ai")]);
    r2.set_patch(Some(patch_villages_gone()));
    let fresh = observe(&r2).await;
    assert_eq!(
        brain::replan(
            &raid.action,
            &p,
            &inputs(&fresh, &ds),
            &mut Taken::default(),
            &st
        )
        .unwrap_err(),
        "target gone"
    );
    // Shielded in the fresh files.
    let r3 = rig(None, &[(FINAL, "ai")]);
    r3.set_patch(Some(patch_villages_shielded()));
    let fresh = observe(&r3).await;
    assert_eq!(
        brain::replan(
            &raid.action,
            &p,
            &inputs(&fresh, &ds),
            &mut Taken::default(),
            &st
        )
        .unwrap_err(),
        "no plan or shield"
    );
}

// ------------------------------------------------------------------ recall

/// A rig whose H1 stands in the neighbouring province `(2, -1)`: arrived away.
async fn away_rig() -> (Rig, Observation) {
    let probe = rig(None, &[(FINAL, "ai")]);
    let obs0 = observe(&probe).await;
    let tile = away_tile(&obs0, (2, -1));
    let r = rig(None, &[(FINAL, "ai")]);
    r.set_patch(Some(patch_move_host(h1_id(), (2, 0), (2, -1), tile)));
    let obs = observe(&r).await;
    (r, obs)
}

fn threat(arrive: u32) -> Threat {
    Threat {
        host_id: 1,
        origin: (1, 0),
        nation: 1,
        mass: 800,
        depart_bell: 39,
        arrive_bell: arrive,
    }
}

fn recalls(o: &[brain::Offer]) -> Vec<&brain::Offer> {
    o.iter()
        .filter(|x| x.cand.kind.starts_with("recall:"))
        .collect()
}

#[tokio::test]
async fn a_recall_needs_an_arrived_ready_host_away_from_home_and_a_trigger() {
    let (r, obs) = away_rig().await;
    let h = brain::home_holding(&obs).unwrap();
    let rows = brain::host_rows(&obs, h);
    let away = rows.iter().find(|x| x.e.id == h1_id()).unwrap();
    assert_eq!(away.at, (2, -1));
    assert!(away.ready && !away.in_transit);
    // No trigger: the home floor is fine (H0 small) and no threat.
    let low_h0 = day(100, vec![]);
    let none = Side::default();
    assert!(recalls(&brain::candidates_with(&inputs(&obs, &low_h0), &none)).is_empty());
    // The home floor is low: fewer than 40 % of H0 at home.
    let big_h0 = day(5_000, vec![]);
    let inp = inputs(&obs, &big_h0);
    assert!(recall::home_floor_low(inp.home_troops, big_h0.h0));
    let offers = brain::candidates_with(&inp, &none);
    let rec = recalls(&offers);
    assert_eq!(rec.len(), 1);
    let o = rec[0];
    assert_eq!(o.cand.kind, format!("recall:{}", away.handle));
    assert_eq!(o.cand.facts["trigger"], "home_floor_low");
    assert_eq!(o.cand.facts["troops"], 500);
    assert_eq!(
        o.cand.facts["destination"],
        Value::Null,
        "no threat, no threat fields"
    );
    assert_eq!(o.cand.params["timing"], vec![json!("earliest")]);
    assert_eq!(o.cand.troops, Some(500));
    assert!(!o.cand.council);
    // Right after hold (no Strike Order candidate here), before the camp marches.
    let k = kinds(&offers);
    assert_eq!(
        &k[..3],
        &["autopilot".to_string(), "hold".into(), o.cand.kind.clone()]
    );
    // The action is a march to the own holding tile.
    let Action::March {
        target,
        kind,
        host_id,
        ..
    } = &o.action
    else {
        panic!("a march")
    };
    assert_eq!(*kind, brain::MarchKind::Recall);
    assert_eq!(
        (target.p, target.q, target.tile, target.why),
        (h.p, h.q, h.tile, "home")
    );
    assert_eq!(*host_id, h1_id());
    let _ = r;
}

#[tokio::test]
async fn a_live_threat_makes_a_recall_with_the_threat_facts_and_says_if_the_host_is_home_in_time() {
    let (_r, obs) = away_rig().await;
    let ds = day(100, vec![]);
    let inp = inputs(&obs, &ds);
    // The earliest arrival home (for the facts).
    let side_late = Side {
        call: None,
        threats: vec![threat(60)],
    };
    let offers = brain::candidates_with(&inp, &side_late);
    let o = recalls(&offers)[0].clone();
    let f = &o.cand.facts;
    let earliest = f["earliest_bell"].as_u64().unwrap() as u32;
    assert!(earliest > 40);
    assert_eq!(f["threat_origin"], json!({"p": 1, "q": 0}));
    assert_eq!(f["threat_mass"], 800);
    assert_eq!(f["threat_arrive_bell"], 60);
    assert_eq!(
        f["destination"], "unknown",
        "a sealed destination is never guessed"
    );
    assert_eq!(f["home_by_arrival"], true);
    assert_eq!(
        o.cand.entities,
        vec!["pq:1,0".to_string(), "nation:1".to_string()]
    );
    has_sample_keys(
        &o.cand.to_json(),
        &golden_sample(|s| s["kind"].as_str().is_some_and(|k| k.starts_with("recall"))),
    );
    // The threat lands before the host can be home.
    let side_early = Side {
        call: None,
        threats: vec![threat(earliest - 1)],
    };
    let offers = brain::candidates_with(&inp, &side_early);
    assert_eq!(recalls(&offers)[0].cand.facts["home_by_arrival"], false);
    // A threat alone is a trigger even with a healthy home floor; two hosts away
    // would give at most two recalls (one here).
    assert_eq!(recalls(&offers).len(), 1);
}

#[tokio::test]
async fn no_recall_for_a_host_at_home_in_transit_or_not_ready() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let big = day(5_000, vec![]);
    let side = Side {
        call: None,
        threats: vec![threat(60)],
    };
    // H1 is at home: it counts as home troops and has no path to its own tile.
    assert!(recalls(&brain::candidates_with(&inputs(&obs, &big), &side)).is_empty());
    // A host in transit is never recalled (there is no recall of an in-flight march).
    let inp = inputs(&obs, &big);
    assert!(
        inp.rows.iter().any(|x| x.in_transit),
        "the fixture has a march in flight"
    );
    assert!(recalls(&brain::candidates_with(&inp, &side)).is_empty());
    // Away but resting (stamina below the Depart cost): not ready, not offered.
    let (_r2, obs2) = away_rig().await;
    let probe = rig(None, &[(FINAL, "ai")]);
    let tile = away_tile(&observe(&probe).await, (2, -1));
    let r3 = rig(None, &[(FINAL, "ai")]);
    let mv = patch_move_host(h1_id(), (2, 0), (2, -1), tile);
    r3.set_patch(Some(Box::new(move |path, b| {
        let b = mv(path, b);
        if !path.starts_with("/h/province/2,-1/") {
            return b;
        }
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        let mut bytes = b64(v["bytes"].as_str().unwrap()).unwrap();
        let i = entry_index(&bytes, h1_id()).unwrap();
        let o = (lp::ENTRIES + i * lp::ENTRY_STRIDE) + le::STAMINA_VALUE;
        bytes[o..o + 2].copy_from_slice(&10u16.to_le_bytes());
        v["bytes"] = json!(b64_encode(&bytes));
        serde_json::to_vec(&v).unwrap()
    })));
    let tired = observe(&r3).await;
    let h = brain::home_holding(&tired).unwrap();
    let away = brain::host_rows(&tired, h)
        .into_iter()
        .find(|x| x.e.id == h1_id())
        .unwrap();
    assert!(!away.ready, "resting");
    assert!(recalls(&brain::candidates_with(&inputs(&tired, &big), &side)).is_empty());
    let _ = obs2;
}

#[tokio::test]
async fn a_recall_is_exempt_from_the_caps_is_not_a_day_march_and_reserves_the_host() {
    let (_r, obs) = away_rig().await;
    // 3,000 troops marched today: any march out is over the day cap.
    let spent = day(5_000, vec![(40, 3_000)]);
    let inp = inputs(&obs, &spent);
    let side = Side::default();
    let offers = brain::candidates_with(&inp, &side);
    let rec = recalls(&offers)[0].clone();
    assert!(
        offers.iter().all(|o| o.cand.kind != "march"),
        "V3 removes every march out"
    );
    let st = Standing {
        march_troops_left: Some(0),
        home_floor: Some(9_999),
        ..Standing::default()
    };
    let mut taken = Taken::default();
    let (intent, troops) =
        brain::replan(&rec.action, &ChosenParams::default(), &inp, &mut taken, &st)
            .expect("the recall passes the caps of the answer");
    assert_eq!(troops, Some(500));
    assert_eq!(
        (taken.marches, taken.march_troops),
        (0, 0),
        "not a march of the day"
    );
    assert!(taken.hosts.contains(&h1_id()));
    let policy::Intent::Depart(plan) = intent else {
        panic!("a Depart")
    };
    let h = brain::home_holding(&obs).unwrap();
    assert_eq!(plan.why, "home");
    assert_eq!(
        (plan.plain.dest_p, plan.plain.dest_q, plan.plain.dest_tile),
        (h.p, h.q, h.tile)
    );
    // The same host is used once in a decision.
    assert_eq!(
        brain::replan(&rec.action, &ChosenParams::default(), &inp, &mut taken, &st).unwrap_err(),
        "host already used"
    );
    // A recall of a host that is already home is refused by V6.
    let r2 = rig(None, &[(FINAL, "ai")]);
    let obs_home = observe(&r2).await;
    let h = brain::home_holding(&obs_home).unwrap();
    let fake = Action::March {
        host_id: h1_id(),
        at: (h.p, h.q),
        target: policy::Target {
            p: h.p,
            q: h.q,
            tile: h.tile,
            why: "home",
        },
        kind: brain::MarchKind::Recall,
        troops: 500,
    };
    assert_eq!(
        brain::replan(
            &fake,
            &ChosenParams::default(),
            &inputs(&obs_home, &spent),
            &mut Taken::default(),
            &st
        )
        .unwrap_err(),
        "host already home"
    );
}

#[tokio::test]
async fn a_model_recall_is_sent_not_counted_as_a_march_and_the_host_is_reserved() {
    let probe = rig(None, &[(FINAL, "ai")]);
    let tile = away_tile(&observe(&probe).await, (2, -1));
    let fm = FakeMind::start(|req| {
        let id = common::cand_id(req, "recall").expect("a recall candidate");
        model_answer(&[&id], json!({id.clone(): {"timing": "earliest"}}))
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_move_host(h1_id(), (2, 0), (2, -1), tile)));
    // A live threat near home (the DEPART of an enemy host), as the feed holds it.
    let obs = observe(&r).await;
    let (_, _, ehost) = enemy(&obs);
    r.hook.follow.threats.push(RawDepart {
        host_id: ehost,
        origin: (1, 0),
        depart_bell: 39,
        arrive_bell: 60,
        mass: 800,
    });
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let req = fm.requests.lock().unwrap()[0].clone();
    check_request_shape(&req);
    let rc = req["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"].as_str().unwrap().starts_with("recall:"))
        .expect("the request carries the recall");
    assert_eq!(rc["facts"]["threat_mass"], 800);
    assert_eq!(rc["facts"]["destination"], "unknown");
    assert_eq!(depart_count(&r.relay), 1);
    let m = bot.ai.book.last().unwrap();
    let h = brain::home_holding(&obs).unwrap();
    assert_eq!(m.dest, (h.p, h.q, h.tile), "home");
    assert_eq!((m.by, m.via), (By::Model, None));
    assert_eq!(r.hook.stat_of("model_recalls_sent"), 1);
    assert_eq!(
        r.hook.stat_of("model_marches_sent"),
        0,
        "a recall is not a model march"
    );
    assert!(
        bot.ai.day.as_ref().unwrap().marches.is_empty(),
        "nor a march of the day"
    );
    assert!(
        bot.ai.standing.is_reserved(h1_id(), 40),
        "the recalled host stays home"
    );
    assert_eq!(r.hook.stat_of("v6_dropped"), 0);
}

// ------------------------------------------------------------------ the DEPART feed

/// A herald that serves `/h/events?after=N` pages from memory and counts GETs.
struct EventsHerald {
    pages: Mutex<BTreeMap<String, Vec<u8>>>,
    gets: AtomicUsize,
}

impl EventsHerald {
    fn new(pages: Vec<(u64, Value)>) -> EventsHerald {
        EventsHerald {
            pages: Mutex::new(
                pages
                    .into_iter()
                    .map(|(after, v)| {
                        (
                            format!("/h/events?after={after}"),
                            serde_json::to_vec(&v).unwrap(),
                        )
                    })
                    .collect(),
            ),
            gets: AtomicUsize::new(0),
        }
    }
}

impl HeraldPort for EventsHerald {
    async fn get(&self, path: &str) -> PortResult<Option<Vec<u8>>> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        Ok(self.pages.lock().unwrap().get(path).cloned())
    }
}

fn real_page() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/test/fixtures/ai-follow-real/events-departs.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("the recorded page")).unwrap()
}

#[test]
fn the_depart_reader_parses_real_herald_rows() {
    let page = real_page();
    assert_eq!(page["events"].as_array().unwrap().len(), 3);
    let (deps, next, full) = recall::parse_events(&page);
    assert_eq!(deps.len(), 3, "every recorded row is a DEPART");
    assert!(!full && next.is_some());
    // The first recorded row: host 589342527455232 left (2, -3) at bell 37,
    // arriving at 41 with 300,000 milli-troops (300 troops).
    let d = &deps[0];
    assert_eq!(d.host_id, 589342527455232);
    assert_eq!(d.origin, (2, -3));
    assert_eq!((d.depart_bell, d.arrive_bell, d.mass), (37, 41, 300));
    assert!(deps
        .iter()
        .all(|d| d.arrive_bell > d.depart_bell && d.mass >= 100));
    // A page that is not a feed page, and non-DEPART rows, give nothing.
    assert!(recall::parse_events(
        &json!({"events": [{"decoded": {"name": "CLASH"}}], "next": "1", "full": false})
    )
    .0
    .is_empty());
    assert!(recall::parse_events(&json!("x")).0.is_empty());
}

#[tokio::test]
async fn the_feed_polls_once_per_bell_pages_through_full_pages_and_drops_landed_marches() {
    let real = real_page();
    let rows = real["events"].as_array().unwrap().clone();
    let h = EventsHerald::new(vec![
        (
            0,
            json!({"events": [rows[0], rows[1]], "next": "10", "full": true}),
        ),
        (
            10,
            json!({"events": [rows[2]], "next": "11", "full": false}),
        ),
    ]);
    let feed = ThreatFeed::new();
    // Bell 38: every real row is in flight (depart ≤ 38 ≤ arrive) or not yet departed.
    assert!(feed.poll(&h, 38).await);
    assert_eq!(h.gets.load(Ordering::SeqCst), 2, "two pages");
    assert!(feed.poll(&h, 38).await);
    assert_eq!(h.gets.load(Ordering::SeqCst), 2, "once per bell");
    let live = feed.live(38);
    assert!(
        !live.is_empty()
            && live
                .iter()
                .all(|d| d.depart_bell <= 38 && 38 <= d.arrive_bell)
    );
    // A later bell asks again from the cursor; there is no such page (a herald
    // without the index answers nothing): the poll says so and keeps its list.
    assert!(!feed.poll(&h, 39).await);
    assert_eq!(h.gets.load(Ordering::SeqCst), 3);
    // Marches that have landed are not live any more.
    assert!(feed.live(10_000).is_empty());
}

#[tokio::test]
async fn threats_near_keeps_other_nations_departs_within_three_provinces_of_home() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = observe(&r).await;
    let h = brain::home_holding(&obs).unwrap().clone();
    let (epq, _, ehost) = enemy(&obs);
    let own_nation_mate = fclient::addr::host_id(h.p as i32, h.q as i32, 1, 1, 1).unwrap();
    let feed = ThreatFeed::new();
    let dep = |host: u64, origin: (i16, i16), mass: u32, arrive: u32| RawDepart {
        host_id: host,
        origin,
        depart_bell: 39,
        arrive_bell: arrive,
        mass,
    };
    feed.push(dep(ehost, (epq.0, epq.1), 800, 45)); // another nation, near
    feed.push(dep(ehost + 1, (1, 0), 300, 44)); // another nation, near, smaller
    feed.push(dep(own_nation_mate, (h.p, h.q), 900, 45)); // the same nation
    feed.push(dep(h1_id(), (h.p, h.q), 900, 45)); // my own host
    feed.push(dep(ehost + 2, (-2, 2), 900, 45)); // too far from home (4 provinces)
    feed.push(dep(ehost + 3, (1, 0), 900, 39)); // already landed at bell 40
                                                // A herald with nothing to say: the pushed list is what the feed holds.
    let herald = EventsHerald::new(vec![]);
    let cache = PathCache::new();
    let mut budget = 8;
    let t = recall::threats_near(&feed, &herald, &cache, &obs, &h, &mut budget).await;
    assert_eq!(
        t.iter().map(|x| (x.host_id, x.nation, x.mass, x.arrive_bell)).collect::<Vec<_>>(),
        vec![(ehost, 1, 800, 45), (ehost + 1, 1, 300, 44)],
        "largest first; the same nation, my own host, the far one and the landed one are not threats"
    );
    assert_eq!(
        budget, 8,
        "the owners' provinces were in the observation: no GET"
    );
    // A depart whose owner's province is outside the observation costs a GET
    // (and, with no village there, is not a threat); with no budget, no GET.
    let outside = fclient::addr::host_id(1, -2, 0, 1, 1).unwrap();
    let f2 = ThreatFeed::new();
    f2.push(RawDepart {
        host_id: outside,
        origin: (1, 0),
        depart_bell: 39,
        arrive_bell: 45,
        mass: 500,
    });
    let mut b2 = 8;
    let r2 = recall::threats_near(&f2, &r.sh.herald, &cache, &obs, &h, &mut b2).await;
    assert!(r2.is_empty() && b2 == 7);
    let mut b3 = 0;
    assert!(
        recall::threats_near(&f2, &r.sh.herald, &PathCache::new(), &obs, &h, &mut b3)
            .await
            .is_empty()
    );
    assert_eq!(b3, 0);
}
