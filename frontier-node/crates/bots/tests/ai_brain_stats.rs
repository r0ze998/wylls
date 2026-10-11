//! AC10a, contract v1.3 R5 and R6 (§3.1, §4.3, §7.2, §10.1): the brain counts its steps, the steps that
//! make no mind call (`no_session`) and the herald GETs it makes itself, per AI bot, and posts the
//! cumulative counters to the mind (`POST /v1/brain-stats`, about once per bell) so that
//! `/v1/metrics` and `PUB/metrics/latest.json` carry them (the Node side is
//! `permutation-gateway/test/citizens-ac10a-brain-stats.test.mjs`).
//!
//! The GET counters are checked against an independent record: the rig's herald logs every path it
//! serves, so each `gets:*` counter is compared with what the log shows for its kind of file.

#[path = "ai_follow_common.rs"]
mod fc;

use fc::common::*;
use fc::*;
use frontier_agents::fixture::{FINAL, JOINED, NOW};
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain;
use frontier_bots::ai::getcount::{self, Counted};
use frontier_bots::ai::recall::{self, RawDepart, ThreatFeed};
use frontier_bots::bot::Bot;
use serde_json::{json, Value};

fn key_ok(k: &str) -> bool {
    // the mind's COUNTER_KEY: ^[a-z][a-z0-9_:.]{0,47}$
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= 48
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_:.".contains(c))
}

/// How many `/h/province/` GETs one observation makes on this rig (the provinces are not cached).
async fn observe_province_gets(r: &Rig, bot: &Bot) -> usize {
    let before = r.gets_of("/h/province/");
    bot.observe(&r.sh).await.unwrap();
    r.gets_of("/h/province/") - before
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_step_without_a_session_or_a_home_is_counted_as_no_session_by_cause() {
    // duties only (no session): no mind call, one `no_session`
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, false).await;
    assert_eq!(fm.n_requests(), 0, "no mind call");
    assert_eq!(r.hook.stat_of("steps"), 1);
    assert_eq!(r.hook.stat_of("no_session"), 1);
    assert_eq!(r.hook.stat_of("no_session:no_session"), 1);
    assert_eq!(r.hook.stat_of("no_session:no_home"), 0);
    let c = r.hook.bot_counters(FINAL);
    assert_eq!(
        (c["steps"], c["no_session"], c["no_session:no_session"]),
        (1, 1, 1)
    );
    assert!(
        c.keys().all(|k| !k.starts_with("gets:")),
        "a step that stops there makes no extra GET: {c:?}"
    );

    // a wallet that has no home holding yet: `no_home`
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(JOINED, "ai")]);
    let mut b = Bot::new(spec(JOINED, Arch::Skilled), 7);
    b.ai.on = true;
    b.step(&r.sh, true).await;
    assert_eq!(fm.n_requests(), 0);
    assert_eq!(r.hook.stat_of("no_session:no_home"), 1);
    assert_eq!(r.hook.bot_counters(JOINED)["no_session"], 1);

    // a step with a session is not a `no_session` step
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(fm.n_requests(), 1);
    assert_eq!(r.hook.stat_of("no_session"), 0);
    assert_eq!(r.hook.bot_counters(FINAL)["steps"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_get_counter_equals_what_the_herald_log_shows_for_its_kind_of_file() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    let observe_gets = observe_province_gets(&r, &bot).await; // one observation's province files
    let before = (
        r.gets_of("/h/me/"),
        r.gets_of("/h/province/"),
        r.gets_of("/h/events"),
    );
    bot.step(&r.sh, true).await;
    let me = r.gets_of("/h/me/") - before.0;
    let provinces = r.gets_of("/h/province/") - before.1;
    let events = r.gets_of("/h/events") - before.2;
    let c = r.hook.bot_counters(FINAL);
    let n = |k: &str| c.get(k).copied().unwrap_or(0) as usize;
    assert_eq!(me, 2, "observe + the brain's own /h/me read");
    assert_eq!(
        n("gets:me"),
        me - 1,
        "the brain's own read, not the baseline observation's"
    );
    assert_eq!(
        n("gets:recall_events"),
        events,
        "the threat feed's event pages"
    );
    // province files: the step's observation, the digest's re-read, the owners of threats and the path fetch
    assert_eq!(
        n("gets:digest") + n("gets:recall_owners") + n("gets:fetch_path"),
        provinces - observe_gets,
        "digest {} + owners {} + path {} against {provinces} province GETs less the observation's {observe_gets}",
        n("gets:digest"),
        n("gets:recall_owners"),
        n("gets:fetch_path"),
    );
    assert_eq!(
        n("gets:digest"),
        observe_gets,
        "obs_digest re-reads every observed province once"
    );
    assert_eq!(
        n("gets:reobserve"),
        0,
        "a fast autopilot answer is not re-observed"
    );
    assert_eq!(
        r.hook.stat_of("gets:me") as usize,
        n("gets:me"),
        "the process-wide counter agrees for one bot"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reobserve_adds_a_lower_bound_of_its_reads() {
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
    let observe_gets = observe_province_gets(&r, &bot).await;
    let before_me = r.gets_of("/h/me/");
    let before_prov = r.gets_of("/h/province/");
    bot.step(&r.sh, true).await;
    assert_eq!(
        r.hook.stat_of("reobserved"),
        1,
        "a model answer is always re-observed"
    );
    let c = r.hook.bot_counters(FINAL);
    assert_eq!(c["reobserved"], 1);
    assert_eq!(
        r.gets_of("/h/me/") - before_me,
        3,
        "observe, meview, re-observe"
    );
    // the re-observe read /h/me once and every observed province once (no marches in memory: no per-bell files)
    assert_eq!(c["gets:reobserve"] as usize, 1 + observe_gets);
    let province_total = r.gets_of("/h/province/") - before_prov;
    assert!(
        province_total >= 3 * observe_gets,
        "observe + digest + re-observe each read the provinces: {province_total} against {}",
        3 * observe_gets
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_counters_are_posted_to_the_mind_cumulatively_about_once_per_bell() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    {
        let posts = fm.brain_stats.lock().unwrap();
        assert_eq!(posts.len(), 1, "one post after the first step");
        let b = &posts[0];
        assert_eq!(b["v"], 1);
        assert_eq!(b["index"], FINAL);
        assert_eq!(b["bell"], 40);
        let counters = b["counters"].as_object().unwrap();
        assert!(
            counters.keys().all(|k| key_ok(k)),
            "names the mind accepts: {counters:?}"
        );
        assert!(counters.values().all(|v| v.is_u64()));
        assert_eq!(counters["steps"], 1);
        assert!(counters["gets:me"].as_u64().unwrap() >= 1);
        // the body is exactly the bot's counters at that moment
        assert_eq!(
            b["counters"],
            serde_json::to_value(r.hook.bot_counters(FINAL)).unwrap()
        );
    }
    // a second step of the same bell: no second post (the mind keeps the latest, and one POST a bell is cheap)
    bot.step(&r.sh, true).await;
    assert_eq!(fm.brain_stats.lock().unwrap().len(), 1);
    // the next bell: a new post that carries the larger cumulative values, `no_session` included
    r.sh.clock.set(NOW + 600);
    bot.step(&r.sh, false).await;
    let posts = fm.brain_stats.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[1]["bell"], 41);
    assert_eq!(posts[1]["counters"]["steps"], 3);
    assert_eq!(posts[1]["counters"]["no_session"], 1);
    assert_eq!(posts[1]["counters"]["no_session:no_session"], 1);
    assert!(
        posts[1]["counters"]["gets:me"].as_u64() >= posts[0]["counters"]["gets:me"].as_u64(),
        "cumulative"
    );
    assert_eq!(r.hook.stat_of("brain_stats_post_failed"), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_run_report_has_the_figures_and_a_hook_without_a_mind_posts_nothing() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let v: Value = r.hook.stats_json();
    // the run report (`ai-brain.json`) carries the process-wide counters and the per-bot ones
    assert_eq!(v["counters"]["steps"], 1);
    assert_eq!(v["per_bot"][FINAL.to_string()]["steps"], 1);
    assert!(v["per_bot"][FINAL.to_string()]["gets:me"].as_u64().unwrap() >= 1);
    // a hook without a mind posts nothing and counts no failure
    let r2 = rig(None, &[(FINAL, "ai")]);
    let mut b2 = ai_bot();
    b2.step(&r2.sh, true).await;
    assert_eq!(r2.hook.stat_of("brain_stats_post_failed"), 0);
    assert_eq!(r2.hook.stat_of("no_mind"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_path_fetch_of_a_follow_is_counted_at_the_herald_and_agrees_with_the_budget_figure() {
    // AC3b's scenario: a Strike-Order target three provinces away, outside the observation: the path fetch reads files
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, 40, 52, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let c = r.hook.bot_counters(FINAL);
    let fetched = *c.get("gets:fetch_path").expect("the fetch read files");
    assert!(fetched >= 1);
    assert_eq!(
        fetched,
        r.hook.stat_of("follow_fetch_gets"),
        "two independent counts of the same reads: the herald-level counter and the fetch's own budget figure"
    );
    assert_eq!(
        r.gets_of("/h/province/1,-2/"),
        1,
        "the target's province was read once"
    );
    assert!(*c.get("gets:me").unwrap() >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_threat_feed_counts_event_pages_and_owner_province_files_apart() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = bot.observe(&r.sh).await.unwrap();
    let h = brain::home_holding(&obs).unwrap().clone();
    // a depart whose owner's province lies outside the observation (as in ai_raid_recall.rs): one events page, one owner file
    let outside = fclient::addr::host_id(1, -2, 0, 1, 1).unwrap();
    let feed = ThreatFeed::new();
    feed.push(RawDepart {
        host_id: outside,
        origin: (1, 0),
        depart_bell: 39,
        arrive_bell: 45,
        mass: 500,
    });
    let counted = Counted::by_path(&r.sh.herald, &r.hook, FINAL, getcount::recall_key);
    let mut budget = 8;
    let cache = frontier_bots::ai::fetch::PathCache::new();
    let t = recall::threats_near(&feed, &counted, &cache, &obs, &h, &mut budget).await;
    assert!(t.is_empty());
    assert_eq!(budget, 7, "one extra GET spent");
    let c = r.hook.bot_counters(FINAL);
    assert_eq!(c["gets:recall_events"], 1, "one /h/events page");
    assert_eq!(c["gets:recall_owners"], 1, "one owner province file");
    assert_eq!(r.gets_of("/h/events"), 1);
    assert_eq!(r.gets_of("/h/province/1,-2/"), 1);
    assert_eq!(
        recall_key_probe(),
        ("gets:recall_events", "gets:recall_owners")
    );
}

fn recall_key_probe() -> (&'static str, &'static str) {
    (
        getcount::recall_key("/h/events?after=0"),
        getcount::recall_key("/h/province/1,-2/latest"),
    )
}
