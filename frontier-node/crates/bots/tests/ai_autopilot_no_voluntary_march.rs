//! Contract §3.6 and the test `ai_autopilot_no_voluntary_march.rs` (replaces
//! v1.1's `ai_autopilot_no_betrayal.rs`): over the agents fixtures in which
//! `policy::decide` returns a combat Depart, an autopilot-only brain run
//! sends no Depart except a Strike-Order follow. Also pins the kept/dropped
//! intent list (step 0 (b)) and the standing-order filters of the follow.

#[path = "ai_common.rs"]
mod common;

use common::*;
use fclient::abi::tag;
use frontier_agents::fixture::{FINAL, NOW, SEED};
use frontier_agents::policy::{self, Ctx, Intent, Memory};
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain::{
    self, Action, ChosenParams, Taken, DROPPED, KEPT_DUTIES, KEPT_ECONOMY, QUOTA_FLOOR,
};
use frontier_bots::ai::standing::{self, Standing};
use frontier_bots::ai::DayState;
use frontier_bots::bot::{Bot, Config};

const BELL: i64 = 600;

/// Every `Intent::name()` of `agents/src/policy.rs` (17 variants).
const ALL: [&str; 17] = [
    "join",
    "file_ticket",
    "harvest",
    "build",
    "train",
    "muster",
    "explore",
    "settle_explore",
    "depart",
    "reveal",
    "settle_transit",
    "redepart",
    "prefund",
    "settle_own_ticket",
    "hold",
    "spam",
    "nudge",
];

#[test]
fn the_kept_and_dropped_lists_cover_every_intent_exactly_once() {
    for n in ALL {
        let c = KEPT_DUTIES.contains(&n) as u8
            + KEPT_ECONOMY.contains(&n) as u8
            + DROPPED.contains(&n) as u8;
        assert_eq!(c, 1, "{n} must be in exactly one list");
    }
    assert_eq!(
        KEPT_DUTIES.len() + KEPT_ECONOMY.len() + DROPPED.len(),
        ALL.len()
    );
    // The pinned lists of §3.6.
    assert_eq!(
        KEPT_DUTIES,
        [
            "join",
            "file_ticket",
            "reveal",
            "settle_transit",
            "settle_explore",
            "settle_own_ticket",
            "nudge",
            "harvest"
        ]
    );
    assert_eq!(KEPT_ECONOMY, ["build", "train", "muster", "explore"]);
    assert!(DROPPED.contains(&"depart"));
    assert_eq!(QUOTA_FLOOR, 16);
}

fn decide_at(obs: &frontier_agents::obs::Observation, arch: Arch, shift: i64) -> Vec<Intent> {
    use fclient::Signer;
    let spec = spec(FINAL, arch);
    let mem = Memory::default();
    let mut o = obs.clone();
    o.now += shift * BELL;
    resolve_all(&mut o);
    let cx = Ctx {
        spec: &spec,
        seed: SEED,
        wallet: frontier_agents::keys::wallet(SEED, FINAL).pubkey(),
        mem: &mem,
        reveal_loaded_limit: Config::new(SEED).reveal_loaded_limit(),
        direct: false,
        session: true,
    };
    policy::decide(&o, &cx)
}

#[tokio::test]
async fn the_filter_drops_every_depart_the_rule_policy_makes() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let (mut with_depart, mut kept_econ) = (0, 0);
    for shift in 0..160 {
        let a = decide_at(&obs, Arch::Skilled, shift);
        let had_depart = a.iter().any(|i| matches!(i, Intent::Depart(_)));
        let (d, rest) = brain::split_duties(a);
        assert!(d.iter().all(|i| KEPT_DUTIES.contains(&i.name())));
        let a1 = brain::autopilot_filter(rest.clone(), vec![], 40);
        assert!(
            a1.iter().all(|i| !matches!(i, Intent::Depart(_))),
            "shift {shift}"
        );
        assert!(a1.iter().all(|i| KEPT_ECONOMY.contains(&i.name())));
        if had_depart {
            with_depart += 1;
        }
        kept_econ += a1.len();
        // The quota floor: nothing of the economy at or below 16 left.
        assert!(brain::autopilot_filter(rest.clone(), vec![], 16).is_empty());
        assert_eq!(
            brain::autopilot_filter_counted(rest.clone(), vec![], 16).1,
            rest.iter()
                .filter(|i| KEPT_ECONOMY.contains(&i.name()))
                .count()
        );
        assert_eq!(
            brain::autopilot_filter(rest.clone(), vec![], 17).len(),
            a1.len()
        );
    }
    assert!(
        with_depart >= 20,
        "the rule policy departed in {with_depart} of 160 decisions: the test bites"
    );
    assert!(kept_econ > 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_autopilot_only_brain_run_sends_no_depart_where_the_rule_bot_does() {
    let at = |k: i64| NOW + k * BELL;
    // The rule bot over 100 bells (the same world): it marches by chance.
    let (sh0, relay0, patch0) = rig_plain_patch();
    let mut rule = Bot::new(spec(FINAL, Arch::Skilled), SEED);
    for k in 0..100 {
        sh0.clock.set(at(k));
        *patch0.lock().unwrap() = Some(patch_resolved(40 + k as u32));
        rule.step(&sh0, true).await;
    }
    let rule_departs = relay0.count_tag(tag::DEPART);
    assert!(
        rule_departs >= 10,
        "the rule bot departed {rule_departs} times in 100 bells"
    );
    // The AI brain with no mind (every step is the autopilot) and with a mind
    // that answers `autopilot`: no Depart at all, economy still runs.
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    for mind in [None, Some(&fm)] {
        let r = rig(mind, &[(FINAL, "ai")]);
        let mut ai = ai_bot();
        for k in 0..100 {
            r.sh.clock.set(at(k));
            r.set_patch(Some(patch_resolved(40 + k as u32)));
            ai.step(&r.sh, true).await;
        }
        assert_eq!(depart_count(&r.relay), 0, "mind {}", mind.is_some());
        assert!(
            r.relay.count_tag(tag::BUILD)
                + r.relay.count_tag(tag::TRAIN)
                + r.relay.count_tag(tag::MUSTER)
                > 0
        );
        assert!(ai.ai.book.is_empty());
        assert_eq!(r.hook.stat_of("model_marches_sent"), 0);
    }
}

#[tokio::test]
async fn a_strike_order_follow_is_kept_but_never_for_a_reserved_host_or_a_declined_call() {
    let r = rig(None, &[(FINAL, "ai")]);
    let bot = ai_bot();
    let obs = bot.observe(&r.sh).await.unwrap();
    // A Depart intent stands in for the follow march (AC3b produces it).
    let ds = DayState {
        day: 0,
        h0: 1000,
        marches: vec![],
    };
    let h = brain::home_holding(&obs).unwrap();
    let rows = brain::host_rows(&obs, h);
    let (home, _) = brain::home_troops(&obs, h, &rows);
    let inp = brain::Inputs {
        obs: &obs,
        h,
        faction: h.faction,
        ds: &ds,
        presets: obs
            .season
            .tip_presets(Config::new(SEED).reveal_loaded_limit()),
        autopilot_summary: String::new(),
        rows,
        home_troops: home,
        quota_left: 40,
    };
    let march = brain::candidates(&inp)
        .into_iter()
        .find(|o| matches!(o.action, Action::March { .. }))
        .unwrap();
    let (follow, _) = brain::replan(
        &march.action,
        &ChosenParams::default(),
        &inp,
        &mut Taken::default(),
        &Standing::default(),
    )
    .unwrap();
    let Intent::Depart(plan) = &follow else {
        panic!()
    };
    // The filter keeps it (the follow is the one voluntary-looking march an autopilot makes).
    let a1 = brain::autopilot_filter(vec![], vec![follow.clone()], 40);
    assert_eq!(a1.len(), 1);
    // ...and a Depart from the rule policy's own list is dropped.
    assert!(brain::autopilot_filter(vec![follow.clone()], vec![], 40).is_empty());
    // Standing orders.
    let mut st = Standing::default();
    assert_eq!(
        standing::filter_follow(vec![follow.clone()], &st, 40, Some(3)).len(),
        1
    );
    st.reserve(plan.host_id, 52);
    assert!(
        standing::filter_follow(vec![follow.clone()], &st, 40, Some(3)).is_empty(),
        "reserved host"
    );
    assert_eq!(
        standing::filter_follow(vec![follow.clone()], &st, 52, Some(3)).len(),
        1,
        "the order expired"
    );
    let st2 = Standing {
        declined_calls: vec![3],
        ..Standing::default()
    };
    assert!(
        standing::filter_follow(vec![follow.clone()], &st2, 40, Some(3)).is_empty(),
        "declined period"
    );
    assert_eq!(
        standing::filter_follow(vec![follow], &st2, 40, Some(4)).len(),
        1,
        "another period"
    );
}
