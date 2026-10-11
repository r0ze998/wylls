//! Following the Call (contract §6.6; unit AC3b): a target **three provinces
//! from the bot's holding**, outside its observation, has no plan until the
//! path fetch; then the Strike-Order follow plans it with `extra = S −
//! earliest − 1` so that the arrival is exactly the strike bell, once, for
//! the AI autopilot (`via: strike_order`, `by: autopilot`) and for a script
//! bot's micro-step; the AI's flagged candidate is offered to a member and a
//! model choice of it is `by: model`.
//!
//! Real code against the agents' fixture herald world and a fake social
//! service on `127.0.0.1:0`; no live stack, no mind but a fake, no Gemma.

#[path = "ai_follow_common.rs"]
mod fc;

use fc::common::*;
use fc::*;
use frontier_agents::fixture::{self, FINAL, NOW, SEED};
use frontier_agents::obs::Observation;
use frontier_agents::policy::{self, Target};
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain::{self, Action, Inputs};
use frontier_bots::ai::fetch::{self, FetchError, PathCache, MAX_EXTRA_GETS};
use frontier_bots::ai::follow::{self, CallCtx, CallInfo, Side};
use frontier_bots::ai::{By, DayState};
use frontier_bots::bot::Bot;
use serde_json::{json, Value};

const BELL0: u32 = 40;
const S: u32 = 52;

fn far_target() -> Target {
    Target {
        p: FAR_CAMP.0,
        q: FAR_CAMP.1,
        tile: FAR_CAMP.2,
        why: "camp",
    }
}

fn call_info(follow_from: u32, strike: u32) -> CallInfo {
    CallInfo {
        faction: 0,
        period: 5,
        option: 2,
        kind: "camp".into(),
        p: FAR_CAMP.0,
        q: FAR_CAMP.1,
        tile: FAR_CAMP.2,
        strike_bell: strike,
        follow_from,
        invited: vec![h1_id()],
    }
}

fn day0() -> DayState {
    DayState {
        day: 0,
        h0: 1_000,
        marches: vec![],
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

// ------------------------------------------------------------------ the fetch

#[tokio::test]
async fn a_target_three_provinces_away_has_a_plan_only_after_the_fetch() {
    let social = FakeSocial::start().await;
    let r = rig_follow(None, &[], &social, true);
    let bot = ai_bot();
    let obs = bot.observe(&r.sh).await.unwrap();
    let h = brain::home_holding(&obs).unwrap();
    let rows = brain::host_rows(&obs, h);
    let row = rows.iter().find(|x| x.e.id == h1_id()).unwrap();
    let t = far_target();
    assert_eq!((h.p, h.q), (2, 0));
    assert!(
        !obs.provinces.contains_key(&(t.p, t.q)),
        "the target is outside the observation"
    );
    // The target is three provinces from the holding.
    use permutation_rules::frontier::geometry::ProvinceCoord;
    assert_eq!(
        ProvinceCoord::new(h.p as i32, h.q as i32)
            .distance(ProvinceCoord::new(t.p as i32, t.q as i32)),
        3
    );
    // No plan over the observation alone.
    assert!(policy::plan_march(&obs, h, row.at, &row.e, t, 0, 0, 0).is_none());
    // The fetch: the hex line, at most 3 hops, at most 8 extra GETs.
    let cache = PathCache::new();
    let mut budget = MAX_EXTRA_GETS;
    let far = fetch::far_provinces(
        &r.sh.herald,
        &cache,
        &obs,
        (row.at, row.e.tile),
        ((t.p, t.q), t.tile),
        false,
        &mut budget,
    )
    .await
    .unwrap();
    assert_eq!(
        far.gets, 2,
        "the provinces of the line that were not observed"
    );
    assert_eq!(budget, MAX_EXTRA_GETS - 2);
    assert!(far.provinces.contains_key(&(t.p, t.q)));
    assert_eq!(r.gets_of("/h/province/1,-2/"), 1);
    // The same bell again: cached, no GET.
    let mut budget2 = MAX_EXTRA_GETS;
    let again = fetch::far_provinces(
        &r.sh.herald,
        &cache,
        &obs,
        (row.at, row.e.tile),
        ((t.p, t.q), t.tile),
        false,
        &mut budget2,
    )
    .await
    .unwrap();
    assert_eq!((again.gets, budget2), (0, MAX_EXTRA_GETS));
    assert_eq!(r.gets_of("/h/province/1,-2/"), 1);
    // The plan over the fetched provinces: 4 provinces, the earliest arrival,
    // then `extra = S - earliest - 1` makes the arrival exactly S.
    let aug = fetch::augment(&obs, &far.provinces);
    assert!(
        !obs.provinces.contains_key(&(t.p, t.q)),
        "the observation itself is never widened"
    );
    let (path, plain, _) = policy::plan_march(&aug, h, row.at, &row.e, t, 0, 0, 0).expect("a plan");
    assert_eq!(path.provinces.len(), 4);
    let earliest = plain.arrive_bell;
    assert_eq!(earliest, 46);
    let info = call_info(BELL0, S);
    let cp =
        follow::plan_call(&obs, h, row, &info, &far.provinces, 1, 5_000, 99).expect("call plan");
    assert_eq!(
        cp.plan.plain.arrive_bell, S,
        "the arrival is the strike bell"
    );
    assert_eq!(cp.earliest, earliest);
    assert_eq!(cp.plan.why, "call");
    assert_eq!(
        (cp.plan.plain.stance, cp.plan.plain.retreat_bps, cp.plan.tip),
        (1, 5_000, 99)
    );
    assert_eq!(cp.provinces, 4);
    // A strike bell the host cannot reach is refused; the earliest bell is fine.
    assert_eq!(
        follow::plan_call(
            &obs,
            h,
            row,
            &call_info(BELL0, earliest - 1),
            &far.provinces,
            1,
            0,
            0
        )
        .unwrap_err(),
        "cannot arrive by the strike bell"
    );
    let at_earliest = follow::plan_call(
        &obs,
        h,
        row,
        &call_info(BELL0, earliest),
        &far.provinces,
        1,
        0,
        0,
    )
    .expect("arrival at the earliest bell");
    assert_eq!(at_earliest.plan.plain.arrive_bell, earliest);
    // Without the fetched provinces there is no plan.
    assert_eq!(
        follow::plan_call(&obs, h, row, &info, &Default::default(), 1, 0, 0).unwrap_err(),
        "no path or no transit slot"
    );
}

#[tokio::test]
async fn a_line_over_three_hops_is_not_fetched() {
    let social = FakeSocial::start().await;
    let r = rig_follow(None, &[], &social, true);
    let bot = ai_bot();
    let obs = bot.observe(&r.sh).await.unwrap();
    let before = r.gets.lock().unwrap().len();
    let mut budget = MAX_EXTRA_GETS;
    let e = fetch::far_provinces(
        &r.sh.herald,
        &PathCache::new(),
        &obs,
        ((2, 0), 22),
        ((-2, 2), 30),
        false,
        &mut budget,
    )
    .await
    .unwrap_err();
    assert_eq!(e, FetchError::TooFar);
    assert_eq!(
        r.gets.lock().unwrap().len(),
        before,
        "no GET for a line that is too long"
    );
    // A budget of 0 reads nothing even for a plannable line.
    let mut none = 0usize;
    let f = fetch::far_provinces(
        &r.sh.herald,
        &PathCache::new(),
        &obs,
        ((2, 0), 22),
        ((1, -2), 56),
        false,
        &mut none,
    )
    .await
    .unwrap();
    assert_eq!((f.gets, f.provinces.len()), (0, 0));
}

// ------------------------------------------------------------------ the AI autopilot

async fn follow_rig(social: &FakeSocial) -> (Rig, Bot) {
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], social, true);
    (r, ai_bot())
}

fn departs(r: &Rig) -> usize {
    depart_count(&r.relay)
}

#[tokio::test]
async fn the_ai_autopilot_follows_the_call_once_over_the_fetched_path() {
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.step(&r.sh, true).await;
    assert_eq!(
        departs(&r),
        1,
        "the Strike-Order follow is the autopilot's one march"
    );
    let m = bot.ai.book.last().expect("a marchbook entry");
    assert_eq!((m.host_id, m.dest, m.arrive_bell), (h1_id(), FAR_CAMP, S));
    assert_eq!((m.by, m.via), (By::Autopilot, Some("strike_order")));
    assert_eq!(m.troops_at_depart, 500);
    assert!(bot.ai.follow.followed.contains(&5));
    // A follow march is not a model march (G12): no model march counted.
    assert_eq!(r.hook.stat_of("model_marches_sent"), 0);
    assert_eq!(r.hook.stat_of("follow_sent_ai"), 1);
    assert_eq!(r.hook.stat_of("follow_window_ai_bots"), 1);
    assert_eq!(r.hook.stat_of("follow_calls_read"), 1);
    assert!(r.hook.stat_of("follow_fetch_gets") <= MAX_EXTRA_GETS as u64);
    assert_eq!(
        social.state.lock().unwrap().reads_ok,
        1,
        "one signed member read"
    );
    // The next steps of the window: no second march, no second read.
    bot.step(&r.sh, true).await;
    r.sh.clock.set(NOW + 600);
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1, "a bot follows a Call at most once");
    assert_eq!(social.state.lock().unwrap().reads_ok, 1);
    assert_eq!(r.hook.stat_of("follow_calls_read"), 1);
}

#[tokio::test]
async fn nothing_is_read_or_followed_outside_the_window_or_without_the_flag() {
    // Before follow_from.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0 + 1, S, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(
        social.gets_of("/f/ai/council/call"),
        0,
        "no read before the window"
    );
    // At the strike bell the window is over (b ∈ [follow_from, S − 1]).
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0 - 6, BELL0, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(social.gets_of("/f/ai/council/call"), 0);
    // Without --follow-council the brain never asks the social service.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, false);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(social.gets_of("/f/ai"), 0);
}

#[tokio::test]
async fn a_non_member_an_uninvited_host_a_reserved_host_and_a_declined_call_do_not_follow() {
    // Not a member of the nation: the read is refused for good.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    social.state.lock().unwrap().members = Some(Default::default());
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(r.hook.stat_of("follow_read_refused:NotMember"), 1);
    assert_eq!(
        social.gets_of("/f/ai/council/call"),
        1,
        "a refused read is not repeated"
    );
    // Not invited: the host is not on the list.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id() + 99]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(r.hook.stat_of("follow_no_ready_invited_host"), 1);
    // A reserved host is never moved by the follow (§3.6).
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.ai.standing.reserve(h1_id(), BELL0 + 12);
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    // A declined Call period is never followed by the autopilot.
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.ai.standing.declined_calls.push(5);
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    // The control: the same rig without either follows.
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1);
}

#[tokio::test]
async fn a_hold_made_before_the_window_opened_does_not_stop_the_autopilot_follow_but_one_made_inside_it_does(
) {
    // Pilot ai-pilot-A1: both AIs of nation 0 held their hosts (a threat) at the bell before the Call could be read; the 12-bell
    // reservation then dropped the autopilot follow in the one bell in which the target could still be reached.
    // A hold made at BELL0 - 3 (reserved until BELL0 + 9): the window opens at BELL0, so it was made without the Call: the host follows.
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.ai.standing.reserve(h1_id(), BELL0 - 3 + 12);
    assert!(bot.ai.standing.is_reserved(h1_id(), BELL0));
    bot.step(&r.sh, true).await;
    assert_eq!(
        departs(&r),
        1,
        "a hold made before the window does not stop the follow"
    );
    // A hold made at BELL0 (inside the window, the Call known): the host stays.
    let social = FakeSocial::start().await;
    let (r, mut bot) = follow_rig(&social).await;
    bot.ai.standing.reserve(h1_id(), BELL0 + 12);
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0, "an informed hold still stops it");
}

#[tokio::test]
async fn a_bad_signature_or_a_down_service_follows_nothing_and_breaks_nothing() {
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    social.state.lock().unwrap().refuse_call = Some((429, "RateLimited".into()));
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(r.hook.stat_of("follow_read_retry:RateLimited"), 1);
    // The refusal lifts: the next step reads and follows (a retry, not a final no).
    social.state.lock().unwrap().refuse_call = None;
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1);
    // A service that is not there at all: the step still runs its economy.
    let mut dead = FakeSocial::start().await;
    {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        dead.addr = l.local_addr().unwrap().to_string();
        drop(l);
    }
    let rig = rig_follow(None, &[(FINAL, "ai")], &dead, true);
    let mut bot = ai_bot();
    bot.step(&rig.sh, true).await;
    assert_eq!(depart_count(&rig.relay), 0);
    assert!(rig.hook.stat_of("follow_social_down") >= 1);
    assert!(
        !rig.relay.tags().is_empty(),
        "the economy and duties still ran"
    );
}

// ------------------------------------------------------------------ the flagged candidate

#[tokio::test]
async fn the_flagged_candidate_is_offered_to_a_member_after_hold_and_a_model_choice_is_by_model() {
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let fm = FakeMind::start(|req| {
        let id = req["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["facts"]["target_kind"] == "call")
            .and_then(|c| c["id"].as_str())
            .expect("the flagged Strike-Order candidate")
            .to_string();
        model_answer(
            &[&id],
            json!({id.clone(): {"stance": "flank", "retreat": 5000, "timing": "call"}}),
        )
    })
    .await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let req = fm.requests.lock().unwrap()[0].clone();
    check_request_shape(&req);
    let kinds: Vec<&str> = req["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        &kinds[..3],
        &["autopilot", "hold", "march"],
        "right after hold"
    );
    let c3 = &req["candidates"][2];
    assert_eq!(c3["flags"]["council"], true, "flagged");
    assert_eq!(c3["params"]["timing"], json!(["call"]));
    assert_eq!(c3["facts"]["target_kind"], "call");
    assert_eq!(c3["facts"]["strike_bell"], S);
    assert_eq!(c3["facts"]["earliest_bell"], 46);
    assert_eq!(c3["facts"]["target"], json!({"p": 1, "q": -2, "tile": 56}));
    assert_eq!(c3["facts"]["reward"], "10 Works (points, no use yet)");
    assert_eq!(c3["troops"], 500);
    // The facts keep the key set of the pinned wire sample.
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../permutation-gateway/test/fixtures/ai-decide-v1.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let sample = golden["candidate_samples_ac3b"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["flags"]["council"] == true)
        .unwrap();
    for k in sample["facts"].as_object().unwrap().keys() {
        assert!(c3["facts"].get(k).is_some(), "sample fact {k}");
    }
    for k in sample["params"].as_object().unwrap().keys() {
        assert!(c3["params"].get(k).is_some(), "sample param {k}");
    }
    for k in sample.as_object().unwrap().keys() {
        assert!(c3.get(k).is_some(), "sample key {k}");
    }
    // The model chose it: the march is sent, by the model, via the Strike Order.
    assert_eq!(departs(&r), 1);
    let m = bot.ai.book.last().unwrap();
    assert_eq!((m.dest, m.arrive_bell), (FAR_CAMP, S));
    assert_eq!((m.by, m.via), (By::Model, Some("strike_order")));
    assert_eq!(r.hook.stat_of("model_strike_order_marches_sent"), 1);
    assert_eq!(
        r.hook.stat_of("model_marches_sent"),
        0,
        "not the headline count"
    );
    assert_eq!(
        bot.ai.day.as_ref().unwrap().marches.len(),
        1,
        "but it counts in the day's caps"
    );
    assert!(bot.ai.follow.followed.contains(&5), "followed once");
    // The same answer cannot send it twice.
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1);
}

#[tokio::test]
async fn no_flagged_candidate_for_a_non_member_a_followed_call_or_an_uninvited_host() {
    for scenario in 0..3 {
        let social = FakeSocial::start().await;
        social.register(FINAL);
        let invited = if scenario == 2 { h1_id() + 7 } else { h1_id() };
        social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[invited]);
        if scenario == 0 {
            social.state.lock().unwrap().members = Some(Default::default());
        }
        let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
        let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
        let mut bot = ai_bot();
        if scenario == 1 {
            bot.ai.follow.followed.insert(5);
        }
        bot.step(&r.sh, true).await;
        let req = fm.requests.lock().unwrap()[0].clone();
        let flagged = req["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["flags"]["council"] == true);
        assert!(!flagged, "scenario {scenario}");
        assert_eq!(departs(&r), 0, "scenario {scenario}");
    }
}

#[tokio::test]
async fn an_autopilot_answer_still_follows_and_a_hold_answer_does_not() {
    // choose autopilot: the filtered autopilot runs and includes the follow.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1);
    assert_eq!(bot.ai.book.last().unwrap().by, By::Autopilot);
    // choose hold: the armies stay home and the host is reserved.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let fm = FakeMind::start(|req| {
        let id = common::cand_id(req, "hold").unwrap();
        model_answer(&[&id], json!({}))
    })
    .await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 0);
    assert!(bot.ai.standing.is_reserved(h1_id(), BELL0));
}

#[tokio::test]
async fn candidates_without_a_call_have_no_flagged_march_and_the_mind_request_is_unchanged_in_shape(
) {
    let social = FakeSocial::start().await;
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let bot = ai_bot();
    let obs = bot.observe(&r.sh).await.unwrap();
    let ds = day0();
    let inp = inputs(&obs, &ds);
    let plain = brain::candidates(&inp);
    assert!(plain.iter().all(|o| !o.cand.council));
    // With a Side holding a live Call the candidate appears right after hold.
    let info = call_info(BELL0, S);
    let far = {
        let h = inp.h;
        let row = inp.rows.iter().find(|x| x.e.id == h1_id()).unwrap();
        let mut budget = MAX_EXTRA_GETS;
        fetch::far_provinces(
            &r.sh.herald,
            &PathCache::new(),
            &obs,
            (row.at, row.e.tile),
            ((info.p, info.q), info.tile),
            false,
            &mut budget,
        )
        .await
        .unwrap()
        .provinces
        .into_iter()
        .chain(std::iter::once((
            (h.p, h.q),
            obs.provinces[&(h.p, h.q)].clone(),
        )))
        .filter(|(k, _)| !obs.provinces.contains_key(k))
        .collect()
    };
    let side = Side {
        call: Some(CallCtx {
            info: info.clone(),
            far,
            followed: false,
        }),
        threats: vec![],
    };
    let with = brain::candidates_with(&inp, &side);
    assert_eq!(with[2].cand.kind, "march");
    assert!(with[2].cand.council);
    assert_eq!(with.len(), plain.len() + 1, "one more candidate");
    assert!(with.len() <= brain::MAX_CANDIDATES);
    // V6: the flagged march re-plans; a followed or over Call is refused.
    let p = brain::ChosenParams::default();
    let st = frontier_bots::ai::standing::Standing::default();
    let Action::March { .. } = &with[2].action else {
        panic!("a march action");
    };
    let ok = brain::replan_with(
        &with[2].action,
        &p,
        &inp,
        &mut Default::default(),
        &st,
        &side,
    );
    let (intent, troops) = ok.expect("re-planned");
    assert_eq!(troops, Some(500));
    let policy::Intent::Depart(plan) = intent else {
        panic!("a Depart")
    };
    assert_eq!((plan.plain.arrive_bell, plan.why), (S, "call"));
    let mut followed = side.clone();
    followed.call.as_mut().unwrap().followed = true;
    assert_eq!(
        brain::replan_with(
            &with[2].action,
            &p,
            &inp,
            &mut Default::default(),
            &st,
            &followed
        )
        .unwrap_err(),
        "already followed"
    );
    assert_eq!(
        brain::replan_with(
            &with[2].action,
            &p,
            &inp,
            &mut Default::default(),
            &st,
            &Side::default()
        )
        .unwrap_err(),
        "no live Strike Order"
    );
    // The caps still bind the flagged candidate: 1000 troops home at H0 = 1000,
    // and 600 already marched today leaves no room.
    let spent = DayState {
        day: 0,
        h0: 1_000,
        marches: vec![(BELL0, 600)],
    };
    let inp2 = Inputs {
        ds: &spent,
        ..inputs(&obs, &spent)
    };
    assert!(
        brain::candidates_with(&inp2, &side)
            .iter()
            .all(|o| !o.cand.council),
        "no candidate that V3 would drop"
    );
}

// ------------------------------------------------------------------ script bots

fn script_bot() -> Bot {
    // The fixture wallet `FINAL` as a casual script bot (no brain: ai.on is false).
    Bot::new(common::spec(FINAL, Arch::Casual), SEED)
}

#[tokio::test]
async fn a_script_bot_follows_in_its_micro_step_and_only_once() {
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[], &social, true);
    let mut bot = script_bot();
    assert!(!bot.ai.on);
    // Too early in the bell (before 90 game seconds): nothing yet, a wake is set.
    let bell_start = fixture::GENESIS_TS + BELL0 as i64 * 600;
    r.sh.clock.set(bell_start + 10);
    follow::follow_wake(&r.sh, &mut bot, bell_start + 10).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(social.gets_of("/f/ai/council"), 0);
    let next = bot.ai.follow.next_check.expect("a wake at the offset");
    assert!(next > bell_start + 90 && next < bell_start + 160);
    assert_eq!(
        follow::next_wake(&bot, bell_start + 10, bell_start + 5_000),
        next
    );
    assert_eq!(
        follow::next_wake(&bot, next + 1, bell_start + 5_000),
        bell_start + 5_000
    );
    // At the offset the micro-step runs.
    r.sh.clock.set(NOW);
    follow::follow_wake(&r.sh, &mut bot, NOW).await;
    assert_eq!(departs(&r), 1);
    let m = &bot.mem.marches.last().unwrap();
    assert_eq!((m.dest, m.arrive_bell), ((1, -2), S));
    assert!(bot.ai.follow.followed.contains(&5));
    assert_eq!(r.hook.stat_of("follow_sent_script"), 1);
    assert_eq!(r.hook.stat_of("follow_window_script_bots"), 1);
    assert_eq!(r.hook.stat_of("follow_calls_read"), 1);
    // The same bell and the next one: no second march.
    follow::follow_wake(&r.sh, &mut bot, NOW).await;
    r.sh.clock.set(NOW + 600);
    follow::follow_wake(&r.sh, &mut bot, NOW + 600).await;
    assert_eq!(departs(&r), 1);
    assert_eq!(social.state.lock().unwrap().reads_ok, 1);
}

#[tokio::test]
async fn a_script_bot_without_an_invited_host_reads_once_and_stops() {
    let social = FakeSocial::start().await;
    social.register(FINAL);
    // A host of some other village: not the bot's.
    let other = fclient::addr::host_id(1, 0, 0, 1, 1).unwrap();
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[other]);
    let r = rig_follow(None, &[], &social, true);
    let mut bot = script_bot();
    follow::follow_wake(&r.sh, &mut bot, NOW).await;
    assert_eq!(departs(&r), 0);
    assert_eq!(r.hook.stat_of("follow_not_invited"), 1);
    // The window stays open; the bot does not read again nor wake for it.
    r.sh.clock.set(NOW + 600);
    follow::follow_wake(&r.sh, &mut bot, NOW + 600).await;
    assert_eq!(r.hook.stat_of("follow_calls_read"), 1);
    assert_eq!(bot.ai.follow.next_check, None);
    // The micro-step does not run for an AI bot nor without the flag.
    let asked = social.gets_of("/f/ai");
    let r2 = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut ai = ai_bot();
    r2.sh.clock.set(NOW + 1_200);
    follow::follow_wake(&r2.sh, &mut ai, NOW + 1_200).await;
    let r3 = rig_follow(None, &[], &social, false);
    let mut b3 = script_bot();
    r3.sh.clock.set(NOW + 1_200);
    follow::follow_wake(&r3.sh, &mut b3, NOW + 1_200).await;
    assert_eq!(
        social.gets_of("/f/ai"),
        asked,
        "an AI bot and a bot without the flag ask nothing"
    );
}

#[tokio::test]
async fn the_council_state_is_read_once_per_bell_for_the_whole_process() {
    let social = FakeSocial::start().await;
    let r = rig_follow(None, &[], &social, true);
    // Twenty bots of faction 0 wake in the same bell (past their offset, which
    // is 90 s plus index mod 60): one public GET.
    let later = NOW + 100;
    r.sh.clock.set(later);
    for i in 0..20u32 {
        let mut b = Bot::new(common::spec(100 + i, Arch::Casual), SEED);
        follow::follow_wake(&r.sh, &mut b, later).await;
    }
    assert_eq!(social.gets_of("/f/ai/council?faction=0"), 1);
    // The next bell asks again, once.
    r.sh.clock.set(later + 600);
    for i in 0..5u32 {
        let mut b = Bot::new(common::spec(100 + i, Arch::Casual), SEED);
        follow::follow_wake(&r.sh, &mut b, later + 600).await;
    }
    assert_eq!(social.gets_of("/f/ai/council?faction=0"), 2);
    // No Call, no member read.
    assert_eq!(social.gets_of("/f/ai/council/call"), 0);
}

#[tokio::test]
async fn the_by_model_counters_of_other_kinds_are_untouched_by_the_follow() {
    // A plain model march (a camp in view) is still `model_marches_sent`.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    let fm = FakeMind::start(|req| {
        let id = common::cand_id(req, "march").unwrap();
        model_answer(
            &[&id],
            json!({id.clone(): {"stance": "assault", "retreat": 0, "timing": "earliest"}}),
        )
    })
    .await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(departs(&r), 1);
    assert_eq!(r.hook.stat_of("model_marches_sent"), 1);
    assert_eq!(r.hook.stat_of("model_strike_order_marches_sent"), 0);
    let m = bot.ai.book.last().unwrap();
    assert_eq!((m.by, m.via), (By::Model, None));
}

#[tokio::test]
async fn the_presenters_seat_never_follows_by_itself() {
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
    // The fixture wallet `FINAL` as the seat slot of the AI fleet (index 3).
    let r = rig_follow(None, &[], &social, true);
    let slots = frontier_bots::ai::aislots::AiSlots::parse(
        &json!({"v": 1, "seed": SEED, "first_index": 0,
                "slots": [{"index": FINAL, "faction": 0, "join_bell": 5, "kind": "seat"}]})
        .to_string(),
    )
    .unwrap();
    assert_eq!(slots.seat().map(|s| s.index), Some(FINAL));
    let mut sh2: TestShared = frontier_bots::bot::Shared::new(
        PatchHerald {
            inner: herald(),
            patch: Default::default(),
            gets: Default::default(),
            units: true,
        },
        Relay(r.relay.clone()),
        None,
        frontier_bots::bot::Config::new(SEED),
        frontier_bots::bot::ClockSource::fixed(NOW),
    );
    let mut hook = frontier_bots::ai::AiHook::new(slots, None, true);
    hook.follow.social = follow::SocialPort::new(&social.addr).unwrap();
    sh2 = frontier_bots::ai::install(sh2, hook);
    let mut seat = script_bot();
    follow::follow_wake(&sh2, &mut seat, NOW).await;
    assert_eq!(
        depart_count(&r.relay),
        0,
        "the seat is moved by the operator, not by a bot"
    );
    assert_eq!(social.gets_of("/f/ai"), 0);
}

/// The `fleet.rs` hook: with a game clock, `Fleet::run` calls `follow_wake` in
/// every pass of a bot's loop, so an idle script bot (it never plays by its
/// archetype) still follows the Call, once, and a bot of a fleet without the
/// flag does not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fleet_run_gives_script_bots_their_micro_step() {
    use frontier_bots::bot::{ClockSource, Config, Shared};
    use frontier_bots::fleet::Fleet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    for flag in [true, false] {
        let social = FakeSocial::start().await;
        social.register(FINAL);
        social.adopt(0, 5, BELL0, S, "camp", FAR_CAMP, &[h1_id()]);
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
            ClockSource::Game(Mutex::new(fclient::clock::GameClock::new(1.0))),
        );
        let slots = frontier_bots::ai::aislots::AiSlots {
            seed: SEED,
            first_index: 1000,
            slots: vec![],
        };
        let mut hook = frontier_bots::ai::AiHook::new(slots, None, flag);
        hook.follow.social = follow::SocialPort::new(&social.addr).unwrap();
        let sh = frontier_bots::ai::install(sh, hook);
        let hook = sh.ai.clone().unwrap();
        let mut fleet = Fleet::new(sh, &[common::spec(FINAL, Arch::Idle)]);
        frontier_bots::ai::mark_bots(&mut fleet);
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
            s2.store(true, Ordering::Relaxed);
        });
        fleet.run(NOW + 2, stop).await;
        let departs = depart_count(&relay);
        if flag {
            assert_eq!(departs, 1, "one micro-step march, never a second");
            assert_eq!(hook.stat_of("follow_sent_script"), 1);
        } else {
            assert_eq!(departs, 0, "without --follow-council nothing follows");
            assert_eq!(social.gets_of("/f/ai"), 0);
        }
    }
}
