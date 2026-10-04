//! Contract §3.1 step 5 and the test `ai_brain_stale.rs`: a mind that sleeps
//! past 30 game-s means the brain observes twice and sends intents planned
//! from the second observation; a model answer is re-observed even when it
//! is fast (30 game-s are 3 s real at 10×).

#[path = "ai_common.rs"]
mod common;

use common::*;
use frontier_agents::fixture::{FINAL, NOW};
use serde_json::json;

const BELL: i64 = 600;

fn me_reads(r: &Rig) -> usize {
    r.gets_of("/h/me/")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_mind_means_two_observations_and_a_plan_from_the_second() {
    // Control: a fast autopilot answer: observe once (+ the brain's own /h/me read).
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(me_reads(&r), 2, "observe + meview");
    assert_eq!(r.hook.stat_of("reobserved"), 0);
    // The mind answers after 40 game-s (the same bell): stale. The model's
    // march is checked (V6) against the SECOND observation: the camp is gone
    // there, so it is dropped, which shows the plan is rebuilt from it.
    let fm = FakeMind::start(|req| match cand_id(req, "march") {
        Some(c) => model_answer(
            &[&c],
            json!({c.clone(): {"stance": "hold", "retreat": 0, "timing": "earliest"}}),
        ),
        None => autopilot_answer("below_gate"),
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let (sh, patch) = (r.sh.clone(), r.patch.clone());
    *fm.on_decide.lock().unwrap() = Some(Box::new(move |_| {
        sh.clock.set(NOW + 40);
        *patch.lock().unwrap() = Some(patch_no_camps());
    }));
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(
        me_reads(&r),
        3,
        "observe, meview, and the second observation"
    );
    assert_eq!(r.hook.stat_of("reobserved"), 1);
    assert_eq!(
        depart_count(&r.relay),
        0,
        "no camp in the second observation: V6 dropped the march"
    );
    assert_eq!(r.hook.stat_of("v6_dropped:target gone"), 1);
    assert_eq!(fm.requests.lock().unwrap()[0]["bell"], 40);
    // Without the change in the files the same slow answer is sent, planned
    // at the second observation's time.
    let fm = FakeMind::start(|req| match cand_id(req, "march") {
        Some(c) => model_answer(
            &[&c],
            json!({c.clone(): {"stance": "hold", "retreat": 0, "timing": "earliest"}}),
        ),
        None => autopilot_answer("below_gate"),
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let sh = r.sh.clone();
    *fm.on_decide.lock().unwrap() = Some(Box::new(move |_| sh.clock.set(NOW + 40)));
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(me_reads(&r), 3);
    assert_eq!(depart_count(&r.relay), 1);
    assert_eq!(bot.ai.book[0].depart_bell, 40);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_decision_that_lands_after_the_bell_is_never_executed() {
    // The mind answers 700 game-s later (bell 41): late (§3.5). The model's
    // march is not sent; the filtered autopilot runs on the fresh observation.
    let fm = FakeMind::start(|req| match cand_id(req, "march") {
        Some(c) => model_answer(
            &[&c],
            json!({c.clone(): {"stance": "hold", "retreat": 0, "timing": "earliest"}}),
        ),
        None => autopilot_answer("below_gate"),
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let sh = r.sh.clone();
    *fm.on_decide.lock().unwrap() = Some(Box::new(move |_| sh.clock.set(NOW + 700)));
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(r.hook.stat_of("late"), 1);
    assert_eq!(depart_count(&r.relay), 0, "never executed late");
    assert!(
        r.relay.count_tag(fclient::abi::tag::BUILD) + r.relay.count_tag(fclient::abi::tag::TRAIN)
            > 0,
        "the autopilot's economy still runs"
    );
    assert!(bot.ai.book.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_autopilot_answer_older_than_30_game_seconds_is_reobserved_too() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let sh = r.sh.clone();
    // 31 game-s: just past the limit; the same bell.
    *fm.on_decide.lock().unwrap() = Some(Box::new(move |_| sh.clock.set(NOW + 31)));
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(r.hook.stat_of("reobserved"), 1);
    assert_eq!(me_reads(&r), 3);
    // 30 game-s exactly: not stale.
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let sh = r.sh.clone();
    *fm.on_decide.lock().unwrap() = Some(Box::new(move |_| sh.clock.set(NOW + 30)));
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(r.hook.stat_of("reobserved"), 0);
    assert_eq!(me_reads(&r), 2);
    let _ = BELL;
}
