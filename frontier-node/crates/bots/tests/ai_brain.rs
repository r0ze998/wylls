//! The brain against the agents' recorded herald world (contract §11.3 AC3a
//! tests): candidates are deterministic and follow the §4.3 table; ids map
//! to the intents they name; V6 drops what the fresh observation refuses; a
//! model answer is re-observed; a same-bell repeat sends from the cached
//! answer; every fallback runs the filtered autopilot; no `--brain` and the
//! seat behave as rule bots; the quota floor; the eager cadence.

#[path = "ai_common.rs"]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use fclient::abi::tag;
use frontier_agents::fixture::{self, FINAL, NOW, SEED};
use frontier_agents::obs::Observation;
use frontier_agents::policy::Intent;
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain::{self, Action, ChosenParams, Inputs, Taken};
use frontier_bots::ai::standing::Standing;
use frontier_bots::ai::{self, AiHook, DayState};
use frontier_bots::bot::{ClockSource, Config, Shared};
use frontier_bots::fleet::Fleet;
use serde_json::{json, Value};

const BELL: i64 = 600;

async fn observe(rig: &Rig, bot: &frontier_bots::bot::Bot) -> Observation {
    bot.observe(&rig.sh).await.unwrap()
}

fn presets(obs: &Observation) -> [u64; 3] {
    obs.season
        .tip_presets(Config::new(SEED).reveal_loaded_limit())
}

fn with_inputs<T>(obs: &Observation, ds: &DayState, f: impl FnOnce(&Inputs) -> T) -> T {
    let h = brain::home_holding(obs).expect("a final holding");
    let rows = brain::host_rows(obs, h);
    let (home, _) = brain::home_troops(obs, h, &rows);
    let inp = Inputs {
        obs,
        h,
        faction: h.faction,
        ds,
        presets: presets(obs),
        autopilot_summary: "build wood (economy and duties only)".into(),
        rows,
        home_troops: home,
        quota_left: 40,
    };
    f(&inp)
}

fn day0() -> DayState {
    DayState {
        day: 0,
        h0: 1000,
        marches: vec![],
    }
}

#[tokio::test]
async fn candidates_are_deterministic_ordered_and_capped() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let a = with_inputs(&obs, &day0(), brain::candidates);
    let b = with_inputs(&obs, &day0(), brain::candidates);
    assert_eq!(a, b, "same observation, same candidates");
    assert!(a.len() <= brain::MAX_CANDIDATES);
    let ids: Vec<&str> = a.iter().map(|o| o.cand.id.as_str()).collect();
    let want: Vec<String> = (1..=a.len()).map(|i| format!("c{i}")).collect();
    assert_eq!(ids, want.iter().map(String::as_str).collect::<Vec<_>>());
    let kinds: Vec<&str> = a.iter().map(|o| o.cand.kind.as_str()).collect();
    // The pinned order: autopilot, hold, marches, builds, walls, train, muster, explore.
    assert_eq!(&kinds[..2], &["autopilot", "hold"]);
    let pos = |k: &str| kinds.iter().position(|x| x.starts_with(k));
    assert!(pos("march") < pos("build"));
    assert!(pos("build") < pos("walls"));
    assert!(pos("walls") < pos("train"));
    assert!(pos("train") < pos("muster"));
    assert!(pos("muster") < pos("explore"));
    // Every action is distinct.
    let mut idents: Vec<String> = a.iter().map(|o| o.identity()).collect();
    idents.sort();
    idents.dedup();
    assert_eq!(idents.len(), a.len());
}

#[tokio::test]
async fn march_candidates_carry_the_table_facts_and_only_fixed_reward_text() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let offers = with_inputs(&obs, &day0(), brain::candidates);
    let marches: Vec<_> = offers.iter().filter(|o| o.cand.kind == "march").collect();
    assert!(!marches.is_empty() && marches.len() <= 3, "camps in view");
    for m in marches {
        let f = &m.cand.facts;
        assert_eq!(f["target_kind"], "camp");
        assert_eq!(f["reward"], "10 Works (points, no use yet)");
        assert_eq!(f["ratio_is"], "estimate");
        assert!(["favourable", "even", "unfavourable"].contains(&f["ratio"].as_str().unwrap()));
        for k in [
            "host",
            "host_id",
            "troops",
            "target",
            "hexes",
            "provinces",
            "earliest_bell",
            "enemy_troops",
            "shield",
            "idle_bells",
        ] {
            assert!(f.get(k).is_some(), "fact {k}");
        }
        assert!(f["host_id"].is_string(), "u64 ids travel as strings");
        assert_eq!(m.cand.params["stance"].len(), 4);
        assert_eq!(
            m.cand.params["retreat"],
            vec![json!(0), json!(5000), json!(10000)]
        );
        assert_eq!(m.cand.params["timing"], vec![json!("earliest")]);
        assert!(m.cand.troops.unwrap() >= 100);
        assert!(m.cand.entities[0].starts_with("pq:"));
        // A candidate never carries any reward but the fixed strings.
        let text = serde_json::to_string(&m.cand.to_json()).unwrap();
        assert!(!text.contains("capture") && !text.contains("loot"));
    }
    // The ratio word is the pinned rule.
    assert_eq!(brain::ratio_word(500, 158), "favourable");
    assert_eq!(brain::ratio_word(500, 398), "even");
    assert_eq!(brain::ratio_word(300, 398), "unfavourable");
    assert_eq!(brain::ratio_word(100, 0), "favourable");
}

#[tokio::test]
async fn the_day_caps_remove_the_march_and_hold_says_so() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    // 500 troops marched today already: 500 + 500 > 60 % of H0 = 1000.
    let ds = DayState {
        day: 0,
        h0: 1000,
        marches: vec![(38, 500)],
    };
    let offers = with_inputs(&obs, &ds, brain::candidates);
    assert!(offers.iter().all(|o| o.cand.kind != "march"));
    let hold = offers.iter().find(|o| o.cand.kind == "hold").unwrap();
    assert_eq!(hold.cand.facts["cap"], "cap: no host may march");
    // H0 < 200: no day cap and no floor, so the march is offered.
    let ds = DayState {
        day: 0,
        h0: 100,
        marches: vec![(38, 500)],
    };
    let offers = with_inputs(&obs, &ds, brain::candidates);
    assert!(offers.iter().any(|o| o.cand.kind == "march"));
    // Four model marches today: V3(d).
    let ds = DayState {
        day: 0,
        h0: 100,
        marches: vec![(1, 1), (2, 1), (3, 1), (4, 1)],
    };
    assert_eq!(brain::caps_violation(100, 1, 1000, &ds, None), Some("V3d"));
}

#[test]
fn the_caps_of_v3_are_exact() {
    let ds = |h0, marches: Vec<(u32, u32)>| DayState {
        day: 0,
        h0,
        marches,
    };
    // (a) ≤ 60 % of home_troops.
    assert_eq!(
        brain::caps_violation(600, 1, 1000, &ds(100, vec![]), None),
        None
    );
    assert_eq!(
        brain::caps_violation(601, 1, 1000, &ds(100, vec![]), None),
        Some("V3a")
    );
    // (b) the day cap, from H0 ≥ 200.
    assert_eq!(
        brain::caps_violation(300, 1, 1000, &ds(1000, vec![(1, 300)]), None),
        None
    );
    assert_eq!(
        brain::caps_violation(301, 1, 1000, &ds(1000, vec![(1, 300)]), None),
        Some("V3b")
    );
    // (c) the home floor: home − marched ≥ 40 % of H0.
    assert_eq!(
        brain::caps_violation(500, 1, 900, &ds(1000, vec![]), None),
        None
    );
    assert_eq!(
        brain::caps_violation(501, 1, 900, &ds(1000, vec![]), None),
        Some("V3c")
    );
    // H0 = 199: neither (b) nor (c).
    assert_eq!(
        brain::caps_violation(100, 1, 200, &ds(199, vec![(1, 5_000)]), None),
        None
    );
    // The mind's own caps of the current answer.
    let st = Standing {
        march_troops_left: Some(100),
        home_floor: Some(950),
        ..Standing::default()
    };
    assert_eq!(
        brain::caps_violation(101, 1, 1000, &ds(100, vec![]), Some(&st)),
        Some("caps.march_troops_left")
    );
    assert_eq!(
        brain::caps_violation(100, 1, 1000, &ds(100, vec![]), Some(&st)),
        Some("caps.home_floor")
    );
}

#[tokio::test]
async fn chosen_ids_map_to_the_intents_they_name() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let ds = day0();
    with_inputs(&obs, &ds, |inp| {
        let offers = brain::candidates(inp);
        let st = Standing::default();
        for o in &offers {
            let mut taken = Taken::default();
            let p = ChosenParams {
                stance: Some(1),
                retreat: Some(5000),
                share: Some(50),
            };
            let got = brain::replan(&o.action, &p, inp, &mut taken, &st);
            match &o.action {
                Action::Autopilot | Action::Hold { .. } => assert!(got.is_err()),
                Action::March {
                    host_id, target, ..
                } => {
                    let (Intent::Depart(d), Some(troops)) = got.unwrap() else {
                        panic!("a Depart");
                    };
                    assert_eq!(d.host_id, *host_id);
                    assert_eq!(
                        (d.plain.dest_p, d.plain.dest_q, d.plain.dest_tile),
                        (target.p, target.q, target.tile)
                    );
                    assert_eq!((d.plain.stance, d.plain.retreat_bps), (1, 5000));
                    assert_eq!(
                        d.tip, inp.presets[2],
                        "the AI pays the highest sponsored tip"
                    );
                    assert_eq!(troops, 500);
                }
                Action::Build { item } => {
                    assert!(
                        matches!(got.unwrap().0, Intent::Build { item: i, walls: false, .. } if i == *item)
                    )
                }
                Action::Walls => assert!(matches!(
                    got.unwrap().0,
                    Intent::Build { walls: true, item, .. } if item == permutation_rules::frontier::catalog::ITEM_WALLS
                )),
                Action::Train { unit } => {
                    // 50 % of the largest affordable multiple of 100 (3,400): 1,700.
                    assert!(
                        matches!(got.unwrap().0, Intent::Train { unit: u, n: 1700, .. } if u == *unit)
                    )
                }
                Action::Muster { unit } => {
                    // 50 % of the reserve (300) rounded down to 100: 100.
                    assert!(
                        matches!(got.unwrap().0, Intent::Muster { unit: u, troops: 100, .. } if u == *unit)
                    )
                }
                Action::Explore { host_id } => {
                    assert!(
                        matches!(got.unwrap().0, Intent::Explore { host_id: h, .. } if h == *host_id)
                    )
                }
            }
        }
    });
    assert_eq!(brain::share_of(3400, 25), 800);
    assert_eq!(brain::share_of(3400, 75), 2500);
    assert_eq!(brain::share_of(100, 25), 100, "at least one 100");
    assert_eq!(brain::share_of(1_000_000, 75), 30_000, "at most 30,000");
}

#[tokio::test]
async fn v6_drops_what_the_fresh_observation_refuses() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let ds = day0();
    let march = with_inputs(&obs, &ds, brain::candidates)
        .into_iter()
        .find(|o| o.cand.kind == "march")
        .unwrap();
    with_inputs(&obs, &ds, |inp| {
        let p = ChosenParams::default();
        // The mind's caps of the answer.
        let st = Standing {
            march_troops_left: Some(100),
            ..Standing::default()
        };
        let e = brain::replan(&march.action, &p, inp, &mut Taken::default(), &st).unwrap_err();
        assert_eq!(e, "caps.march_troops_left");
        // One action per host: the same host twice.
        let mut taken = Taken::default();
        let st = Standing::default();
        assert!(brain::replan(&march.action, &p, inp, &mut taken, &st).is_ok());
        let e = brain::replan(&march.action, &p, inp, &mut taken, &st).unwrap_err();
        assert!(e == "host already used" || e.starts_with("V3"), "{e}");
        // A host that is gone.
        let ghost = Action::March {
            host_id: 42,
            at: (0, 0),
            target: frontier_agents::policy::Target {
                p: 0,
                q: 0,
                tile: 0,
                why: "camp",
            },
            kind: brain::MarchKind::Camp,
            troops: 1,
        };
        assert_eq!(
            brain::replan(&ghost, &p, inp, &mut Taken::default(), &st).unwrap_err(),
            "host gone"
        );
    });
    // The camp is gone in the fresh files: the march is dropped.
    r.set_patch(Some(patch_no_camps()));
    let fresh = observe(&r, &bot).await;
    with_inputs(&fresh, &ds, |inp| {
        let e = brain::replan(
            &march.action,
            &ChosenParams::default(),
            inp,
            &mut Taken::default(),
            &Standing::default(),
        )
        .unwrap_err();
        assert_eq!(e, "target gone");
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_model_answer_is_reobserved_v6_checked_sent_booked_and_reported() {
    let fm = FakeMind::start(|req| match cand_id(req, "march") {
        Some(c) => model_answer(
            &[&c],
            json!({c.clone(): {"stance": "assault", "retreat": 5000, "timing": "earliest"}}),
        ),
        // The only ready host is on the march by the next bell.
        None => autopilot_answer("below_gate"),
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    r.relay.refuse_tags.lock().unwrap().clear();
    bot.step(&r.sh, true).await;
    assert_eq!(fm.n_requests(), 1);
    assert_eq!(depart_count(&r.relay), 1, "the chosen march was sent");
    // The model chose a march, so the autopilot's economy was not sent.
    for t in [tag::BUILD, tag::TRAIN, tag::MUSTER, tag::EXPLORE] {
        assert_eq!(r.relay.count_tag(t), 0, "tag {t:#x}");
    }
    assert_eq!(r.hook.stat_of("answers_model"), 1);
    assert_eq!(
        r.hook.stat_of("reobserved"),
        1,
        "every model answer is re-observed"
    );
    assert_eq!(r.hook.stat_of("model_marches_sent"), 1);
    assert_eq!(bot.ai.book.len(), 1);
    let m = &bot.ai.book[0];
    assert_eq!((m.troops_at_depart, m.depart_bell), (500, 40));
    // The outcome the mind got: the depart with its signature, and the own
    // march with its destination still unknown.
    let o = fm.outcomes.lock().unwrap().last().cloned().unwrap();
    assert_eq!(o["decision_id"], "d-test");
    assert_eq!(o["actions"][0]["intent"], "depart");
    assert_eq!(o["actions"][0]["status"], "sent");
    assert_eq!(o["actions"][0]["sig"], SIG);
    assert_eq!(o["own_marches"][0]["opened"], Value::Null);
    // The request never carried the destination of the march (it was only
    // planned, never departed, when the request was built) nor any key.
    let req = fm.requests.lock().unwrap()[0].clone();
    assert_eq!(req["own_marches"], json!([]));
    // The next bell's request lists the march; its destination stays null.
    let dest = (m.dest.0, m.dest.1, m.dest.2);
    r.sh.clock.set(NOW + BELL);
    bot.step(&r.sh, true).await;
    let req2 = fm.requests.lock().unwrap()[1].clone();
    assert_eq!(req2["own_marches"][0]["host_id"], m_host(&bot));
    assert_eq!(req2["own_marches"][0]["opened"], Value::Null);
    let s = serde_json::to_string(&req2).unwrap();
    assert!(
        !s.contains(&format!(
            "\"p\":{},\"q\":{},\"tile\":{}",
            dest.0, dest.1, dest.2
        )) || {
            // A province coordinate may legitimately appear in the situation
            // (the camp's province is in view): only an own_marches entry may not carry it.
            req2["own_marches"][0].get("p").is_none()
        }
    );
}

fn m_host(bot: &frontier_bots::bot::Bot) -> String {
    bot.ai.book[0].host_id.to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hold_sends_duties_only_and_reserves_the_hosts() {
    let fm =
        FakeMind::start(|req| model_answer(&[&cand_id(req, "hold").unwrap()], json!({}))).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 0);
    for t in [tag::BUILD, tag::TRAIN, tag::MUSTER, tag::EXPLORE] {
        assert_eq!(r.relay.count_tag(t), 0);
    }
    let req = fm.requests.lock().unwrap()[0].clone();
    let host: u64 = req["situation"]["me"]["hosts"][0]["host_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(bot.ai.standing.is_reserved(host, 40));
    assert!(!bot
        .ai
        .standing
        .is_reserved(host, 40 + brain::RESERVE_BELLS_FOR_TEST));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_same_bell_nudge_repeat_sends_from_the_cached_answer() {
    let fm = FakeMind::start(|req| {
        let c = cand_id(req, "march").unwrap();
        model_answer(
            &[&c],
            json!({c.clone(): {"stance": "hold", "retreat": 0, "timing": "earliest"}}),
        )
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    // Bell 42 with the province resolved only through bell 40: a resident
    // action is refused NotResident, so the brain nudges instead.
    r.sh.clock.set(NOW + 2 * BELL);
    bot.step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 0, "gated by residency");
    assert!(r.relay.paths().iter().any(|p| p == "/f/nudge"));
    assert!(
        bot.nudged,
        "the brain's own nudge re-runs the step (fleet.rs)"
    );
    assert_eq!(fm.n_requests(), 1);
    // The province resolves; the fleet runs the bot again in the same bell.
    r.set_patch(Some(patch_resolved(42)));
    r.sh.clock.set(NOW + 2 * BELL + 60);
    bot.step(&r.sh, true).await;
    assert_eq!(
        fm.n_requests(),
        1,
        "no second call: the cached answer is used"
    );
    assert_eq!(r.hook.stat_of("answers_reused"), 1);
    assert_eq!(depart_count(&r.relay), 1, "sent from the cached answer");
    assert!(
        r.relay.count_tag(tag::HARVEST) <= 1,
        "duties are not repeated"
    );
    // A third repeat sends nothing twice.
    r.sh.clock.set(NOW + 2 * BELL + 120);
    bot.step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_fallback_runs_the_filtered_autopilot() {
    async fn run(mind: Option<&FakeMind>, budget: Duration) -> (Rig, frontier_bots::bot::Bot) {
        let r = rig_budget(mind, &[(FINAL, "ai")], budget);
        let mut bot = ai_bot();
        bot.step(&r.sh, true).await;
        (r, bot)
    }
    let economy = |r: &Rig| {
        [tag::BUILD, tag::TRAIN, tag::MUSTER, tag::EXPLORE]
            .iter()
            .map(|t| r.relay.count_tag(*t))
            .sum::<usize>()
    };
    // (1) The mind is not listening.
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a = l.local_addr().unwrap().to_string();
        drop(l);
        frontier_bots::ai::mindport::MindPort::new(a, TOKEN)
    };
    let relay = std::sync::Arc::new(MockRelay::new());
    let mut sh: TestShared = Shared::new(
        PatchHerald {
            inner: herald(),
            patch: Default::default(),
            gets: Default::default(),
            units: true,
        },
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    let slots = frontier_bots::ai::aislots::AiSlots::parse(&slots_json(&[(FINAL, "ai")])).unwrap();
    sh = ai::install(sh, AiHook::new(slots, Some(dead), false));
    let mut bot = ai_bot();
    bot.step(&sh, true).await;
    let hook = sh.ai.clone().unwrap();
    assert_eq!(hook.stat_of("fallback_mind_down"), 1);
    assert_eq!(
        relay.count_tag(tag::DEPART),
        0,
        "the autopilot never starts a march"
    );
    assert!(
        [tag::BUILD, tag::TRAIN, tag::MUSTER, tag::EXPLORE]
            .iter()
            .any(|t| relay.count_tag(*t) > 0),
        "economy still runs"
    );
    // (2) The mind answers after the deadline: the call is aborted.
    let slow = FakeMind::start(|_| autopilot_answer("ok")).await;
    *slow.delay.lock().unwrap() = Duration::from_secs(3);
    let (r, _b) = run(Some(&slow), Duration::from_millis(600)).await;
    assert_eq!(r.hook.stat_of("fallback_mind_down"), 1);
    assert_eq!(depart_count(&r.relay), 0);
    assert!(economy(&r) > 0);
    // (3) No time left: the brain does not even call.
    let fm = FakeMind::start(|_| autopilot_answer("ok")).await;
    let (r, _b) = run(Some(&fm), Duration::from_millis(100)).await;
    assert_eq!(fm.n_requests(), 0);
    assert_eq!(r.hook.stat_of("fallback_no_time"), 1);
    assert_eq!(depart_count(&r.relay), 0);
    assert!(economy(&r) > 0);
    // (4) A malformed answer.
    let bad = FakeMind::start(|_| json!({"v": 1, "decision_id": "x", "mode": "bogus"})).await;
    let (r, _b) = run(Some(&bad), Duration::from_secs(5)).await;
    assert_eq!(r.hook.stat_of("fallback_mind_bad_answer"), 1);
    assert_eq!(depart_count(&r.relay), 0);
    assert!(economy(&r) > 0);
    // (5) A wrong token is refused (401) and falls back.
    let fm = FakeMind::start(|_| autopilot_answer("ok")).await;
    let mut port = fm.port();
    port.token = "wrong".into();
    let relay = std::sync::Arc::new(MockRelay::new());
    let mut sh: TestShared = Shared::new(
        PatchHerald {
            inner: herald(),
            patch: Default::default(),
            gets: Default::default(),
            units: true,
        },
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    let slots = frontier_bots::ai::aislots::AiSlots::parse(&slots_json(&[(FINAL, "ai")])).unwrap();
    sh = ai::install(sh, AiHook::new(slots, Some(port), false));
    let mut bot = ai_bot();
    bot.step(&sh, true).await;
    assert_eq!(sh.ai.clone().unwrap().stat_of("fallback_mind_status"), 1);
    assert_eq!(fm.unauthorised.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(relay.count_tag(tag::DEPART), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v6_all_refused_runs_the_autopilot() {
    // The mind chooses a march but its caps leave no troops to march with.
    let fm = FakeMind::start(|req| {
        let c = cand_id(req, "march").unwrap();
        let mut a = model_answer(&[&c], json!({}));
        a["caps"] = json!({"march_troops_left": 50, "home_floor": null});
        a
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 0);
    assert_eq!(r.hook.stat_of("v6_all_refused"), 1);
    assert_eq!(r.hook.stat_of("v6_dropped:caps.march_troops_left"), 1);
    assert!(
        r.relay.count_tag(tag::BUILD) + r.relay.count_tag(tag::TRAIN) > 0,
        "A' ran"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_the_brain_the_bot_acts_as_before() {
    // A rule bot with the hook installed (ai.on false) sends exactly what a
    // bot without any hook sends.
    let (sh0, relay0) = rig_plain();
    let mut b0 = frontier_bots::bot::Bot::new(spec(FINAL, Arch::Skilled), SEED);
    b0.step(&sh0, true).await;
    let fm = FakeMind::start(|_| autopilot_answer("ok")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut b1 = frontier_bots::bot::Bot::new(spec(FINAL, Arch::Skilled), SEED);
    assert!(!b1.ai.on);
    b1.step(&r.sh, true).await;
    assert_eq!(relay0.tags(), r.relay.tags());
    assert_eq!(relay0.paths(), r.relay.paths());
    assert_eq!(fm.n_requests(), 0, "no brain call");
    // And the same with the hook not installed and ai.on forced: no panic,
    // the rule path runs (the hook needs both).
    let mut b2 = ai_bot();
    let (sh2, relay2) = rig_plain();
    b2.step(&sh2, true).await;
    assert_eq!(relay0.tags(), relay2.tags());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_seat_never_calls_the_mind() {
    let fm =
        FakeMind::start(|req| model_answer(&[&cand_id(req, "march").unwrap()], json!({}))).await;
    // The fixture wallet is the seat here: not an AI slot.
    let r = rig(Some(&fm), &[(FINAL, "seat"), (1000, "ai")]);
    let slots = &r.hook.slots;
    assert!(!slots.is_ai(FINAL) && slots.seat().is_some());
    let mut bot = frontier_bots::bot::Bot::new(spec(FINAL, Arch::Idle), SEED);
    bot.ai.on = slots.is_ai(FINAL);
    for k in 0..3 {
        r.sh.clock.set(NOW + k * BELL);
        bot.step(&r.sh, true).await;
    }
    assert_eq!(fm.n_requests(), 0);
    assert_eq!(depart_count(&r.relay), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_quota_floor_skips_the_autopilots_economy_only() {
    let economy = |r: &Rig| {
        [tag::BUILD, tag::TRAIN, tag::MUSTER, tag::EXPLORE]
            .iter()
            .map(|t| r.relay.count_tag(*t))
            .sum::<usize>()
    };
    // 40 left: the autopilot builds, trains, musters, explores.
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_quota(40)));
    ai_bot().step(&r.sh, true).await;
    assert!(economy(&r) >= 3, "{}", economy(&r));
    assert_eq!(r.hook.stat_of("quota_starved_bells"), 0);
    // 16 left: the floor holds the economy back; duties go on.
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_quota(16)));
    ai_bot().step(&r.sh, true).await;
    assert_eq!(economy(&r), 0);
    assert!(r.hook.stat_of("quota_floor_skips") >= 3);
    assert_eq!(r.hook.stat_of("quota_starved_bells"), 1);
    // A model-chosen build is not subject to the floor (quota 16 > reserve 6).
    let fm2 =
        FakeMind::start(|req| model_answer(&[&cand_id(req, "build").unwrap()], json!({}))).await;
    let r = rig(Some(&fm2), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_quota(16)));
    ai_bot().step(&r.sh, true).await;
    assert_eq!(r.relay.count_tag(tag::BUILD), 1);
    // At the reserve (6) a model-chosen build is refused, a model march is not.
    let r = rig(Some(&fm2), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_quota(6)));
    ai_bot().step(&r.sh, true).await;
    assert_eq!(r.relay.count_tag(tag::BUILD), 0);
    let fm3 =
        FakeMind::start(|req| model_answer(&[&cand_id(req, "march").unwrap()], json!({}))).await;
    let r = rig(Some(&fm3), &[(FINAL, "ai")]);
    r.set_patch(Some(patch_quota(6)));
    ai_bot().step(&r.sh, true).await;
    assert_eq!(depart_count(&r.relay), 1);
    // And the request shows the quota.
    let req = fm3.requests.lock().unwrap()[0].clone();
    assert_eq!(req["situation"]["me"]["quota"]["relay_left"], 6);
}

fn fleet(
    fm: &FakeMind,
) -> (
    Fleet<PatchHerald, Relay, frontier_bots::ports::NoDirect>,
    Arc<MockRelay>,
) {
    let relay = Arc::new(MockRelay::new());
    let sh: TestShared = Shared::new(
        PatchHerald {
            inner: herald(),
            patch: Default::default(),
            gets: Default::default(),
            units: true,
        },
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    let slots = frontier_bots::ai::aislots::AiSlots::parse(&slots_json(&[(FINAL, "ai")])).unwrap();
    let sh = ai::install(sh, AiHook::new(slots.clone(), Some(fm.port()), false));
    let mut f = Fleet::new(sh, &slots.specs());
    ai::mark_bots(&mut f);
    (f, relay)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ai_bots_step_every_bell_at_90_to_150_seconds_in() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let (mut f, _relay) = fleet(&fm);
    assert!(f.bots[0].ai.on);
    let at = |bell: i64, secs: i64| NOW - 100 + bell * BELL + secs;
    // Bell 40, 100 s in: the first step.
    f.shared.clock.set(at(0, 100));
    let (ran, _) = f.step_due(2).await;
    assert_eq!((ran, fm.n_requests()), (1, 1));
    // The same bell again: nothing (a nudge retry is the only same-bell run).
    f.shared.clock.set(at(0, 400));
    assert_eq!(f.step_due(2).await.0, 0);
    // Bell 41, 60 s in: before the 90 s offset.
    f.shared.clock.set(at(1, 60));
    assert_eq!(f.step_due(2).await.0, 0);
    assert_eq!(fm.n_requests(), 1);
    // Bell 41, 151 s in: past the 90-150 s offset: a step.
    f.shared.clock.set(at(1, 151));
    assert_eq!(f.step_due(2).await.0, 1);
    assert_eq!(fm.n_requests(), 2);
    // Bell 42 at 151 s again.
    f.shared.clock.set(at(2, 151));
    assert_eq!(f.step_due(2).await.0, 1);
    assert_eq!(fm.n_requests(), 3);
    let _ = fixture::BELL;
}

#[tokio::test]
async fn v6_counts_the_queue_slots_and_the_stores_across_one_decision() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let ds = day0();
    with_inputs(&obs, &ds, |inp| {
        let offers = brain::candidates(inp);
        let find = |f: &dyn Fn(&Action) -> bool| {
            offers.iter().find(|o| f(&o.action)).unwrap().action.clone()
        };
        let builds: Vec<Action> = offers
            .iter()
            .filter(|o| matches!(o.action, Action::Build { .. }))
            .map(|o| o.action.clone())
            .collect();
        let walls = find(&|a| matches!(a, Action::Walls));
        let p = ChosenParams::default();
        let st = Standing::default();
        // A hamlet has 2 queue slots: two builds fit, the third item does not.
        let mut taken = Taken::default();
        assert!(brain::replan(&builds[0], &p, inp, &mut taken, &st).is_ok());
        assert!(brain::replan(&builds[1], &p, inp, &mut taken, &st).is_ok());
        assert_eq!(
            brain::replan(&walls, &p, inp, &mut taken, &st).unwrap_err(),
            "queue full"
        );
        assert_eq!(brain::queue_free_slots(inp.h, obs.now), 2);
        // The stores are spent across the decision: with everything already
        // spent by earlier choices, nothing more is affordable.
        let mut taken = Taken {
            spent: frontier_agents::policy::stores_at(inp.h, obs.now),
            ..Taken::default()
        };
        assert_eq!(
            brain::replan(&builds[0], &p, inp, &mut taken, &st).unwrap_err(),
            "not affordable"
        );
        let train = find(&|a| matches!(a, Action::Train { .. }));
        assert_eq!(
            brain::replan(&train, &p, inp, &mut taken, &st).unwrap_err(),
            "not affordable"
        );
        // A train spends its cost: the stores shrink for what follows.
        let mut taken = Taken::default();
        let big = ChosenParams {
            share: Some(75),
            ..ChosenParams::default()
        };
        assert!(brain::replan(&train, &big, inp, &mut taken, &st).is_ok());
        assert!(taken.spent.iter().any(|c| *c > 0));
    });
}

#[tokio::test]
async fn the_autopilot_candidate_shows_the_quota_and_the_floor() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = observe(&r, &bot).await;
    let ds = day0();
    let facts = |q: u32| {
        with_inputs(&obs, &ds, |inp| {
            let mut i = Inputs {
                quota_left: q,
                ..clone_inputs(inp)
            };
            i.quota_left = q;
            brain::candidates(&i)[0].cand.facts.clone()
        })
    };
    assert_eq!(facts(40)["quota_left"], 40);
    assert_eq!(facts(40)["economy_held_by_quota"], false);
    assert_eq!(facts(17)["economy_held_by_quota"], false);
    assert_eq!(facts(16)["economy_held_by_quota"], true);
}

fn clone_inputs<'a>(i: &Inputs<'a>) -> Inputs<'a> {
    Inputs {
        obs: i.obs,
        h: i.h,
        faction: i.faction,
        ds: i.ds,
        presets: i.presets,
        autopilot_summary: i.autopilot_summary.clone(),
        rows: i.rows.clone(),
        home_troops: i.home_troops,
        quota_left: i.quota_left,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_run_report_has_the_timeline_of_step_0_d() {
    let fm =
        FakeMind::start(|req| model_answer(&[&cand_id(req, "march").unwrap()], json!({}))).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let t = r.hook.timeline_of(FINAL).unwrap();
    // One combat host is departable at the first step (the second is in transit).
    assert_eq!(
        (t.first_final_bell, t.first_ready_bell, t.second_ready_bell),
        (Some(40), Some(40), None)
    );
    assert_eq!(t.first_model_march_bell, Some(40));
    let j = r.hook.stats_json();
    assert_eq!(j["timeline"][FINAL.to_string()]["first_ready_bell"], 40);
    assert_eq!(j["counters"]["model_marches_sent"], 1);
    assert_eq!(j["ai_bots"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_rebuilds_the_marchbook_from_the_journalled_marches() {
    let fm = FakeMind::start(|req| match cand_id(req, "march") {
        Some(c) => model_answer(
            &[&c],
            json!({c.clone(): {"stance": "hold", "retreat": 0, "timing": "earliest"}}),
        ),
        None => autopilot_answer("below_gate"),
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let first = bot.ai.book[0].clone();
    // A restart: the marchbook of the brain is lost, `mem.marches` is
    // restored from the journal (Fleet::restore).
    bot.ai.book.clear();
    r.sh.clock.set(NOW + BELL);
    bot.step(&r.sh, true).await;
    let again = bot
        .ai
        .book
        .iter()
        .find(|m| m.host_id == first.host_id)
        .expect("rebuilt");
    assert_eq!(
        (again.depart_bell, again.arrive_bell, again.dest),
        (first.depart_bell, first.arrive_bell, first.dest)
    );
    // Its `by` is unknown after a restart: counted as the autopilot's.
    assert_eq!(again.by, frontier_bots::ai::By::Autopilot);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn harvest_is_held_at_the_floor_too() {
    async fn harvests(quota: u32) -> usize {
        // No mind: every step is the filtered autopilot.
        let r = rig(None, &[(FINAL, "ai")]);
        r.set_patch(Some(patch_quota(quota)));
        let mut bot = ai_bot();
        for k in 0..60 {
            r.sh.clock.set(NOW + k * BELL);
            bot.step(&r.sh, true).await;
        }
        r.relay.count_tag(tag::HARVEST)
    }
    assert!(
        harvests(40).await >= 3,
        "the rule policy harvests at 20 % a bell"
    );
    assert_eq!(harvests(16).await, 0, "none at the floor");
}
