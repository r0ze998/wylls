//! `ai/meview.rs` (contract §1.3 C2): the own hosts, transits and seals from
//! `/h/me/{wallet}`, parsed from files recorded from a real herald, plus the
//! rule for `own_marches[].opened`: null until the arrival bell has ended and
//! the destination is public.

#[path = "ai_common.rs"]
mod common;

use common::*;
use frontier_agents::fixture::{FINAL, NOW, SEED};
use frontier_bots::ai::meview::{self, MeExtra};
use serde_json::{json, Value};

const BELL: i64 = 600;

fn recorded(w: &str) -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/test/fixtures/ai-brain-real/h/me")
        .join(format!("{w}.json"));
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}

#[test]
fn a_recorded_me_file_gives_hosts_and_seals() {
    // Wallet 153 of bots seed 1: two hosts (100 troops = 100000 milli) and
    // three settled seals (a real herald's `/h/me`).
    let v = recorded("6uEHEqa5JMyPEVLKJnAc2QhE6juv68EEsaZAgy9Bogas");
    let m = MeExtra::from_json(&v).unwrap();
    assert_eq!(m.hosts.len(), 2);
    assert_eq!(m.hosts[0].id, 362843132133377);
    assert_eq!(m.hosts[0].province, (2, 1));
    assert_eq!(
        (m.hosts[0].state, m.hosts[0].unit, m.hosts[0].troops),
        (1, 0, 100_000)
    );
    assert_eq!(m.seals.len(), 3);
    assert_eq!(m.seals[0].host, 362843132133376);
    assert_eq!((m.seals[1].outcome, m.seals[2].outcome), (1, 6));
    assert_eq!(m.seals[1].bell, 990);
    assert!(m.transits.is_empty());
    assert_eq!(m.seal_of(362843132133377).unwrap().bell, 990);
    assert!(m.seal_of(1).is_none());
    // A host id travels as a decimal string (more than 2^53 for real ids).
    assert!(m.hosts[0].id > (1u64 << 48));
}

#[test]
fn transit_rows_parse_in_the_shape_of_the_heralds_source() {
    // SYNTHETIC: the herald's `me_json` (herald/src/views.rs) builds a transit
    // row as below; no recorded file has one (the recorded season had ended).
    let v = json!({"v": 1, "hosts": [], "seals": [], "transits": [
        {"holding": [2, 1, 0], "transitSlot": 3, "state": 2, "host": "362843132133377",
         "departBell": 395, "arriveBell": 403, "sealRoot": "ab".repeat(32), "tip": "20000"}]});
    let m = MeExtra::from_json(&v).unwrap();
    assert_eq!(m.transits.len(), 1);
    let t = m.transit_of(362843132133377).unwrap();
    assert_eq!(
        (t.holding, t.slot, t.state, t.depart_bell, t.arrive_bell),
        ((2, 1, 0), 3, 2, 395, 403)
    );
    // A malformed row is an error (the brain does not guess at a changed shape).
    assert!(MeExtra::from_json(&json!({"hosts": [{"id": "1"}]})).is_err());
    // Missing arrays are empty.
    assert_eq!(
        MeExtra::from_json(&json!({"v": 1})).unwrap(),
        MeExtra::default()
    );
}

#[test]
fn opened_is_none_until_the_arrival_bell_has_ended_and_the_destination_is_public() {
    let none = MeExtra::default();
    let with_seal = MeExtra::from_json(
        &json!({"seals": [{"host": "9", "outcome": 1, "code": 0, "bell": 405}]}),
    )
    .unwrap();
    let dest = (3, -2, 17);
    // Before and in the arrival bell: never.
    for bell in [400, 404, 405] {
        assert!(
            meview::opened_of(9, 405, dest, bell, true, &with_seal).is_none(),
            "bell {bell}"
        );
    }
    // After it: only if public (a REVEAL observed, or a seal record).
    assert!(meview::opened_of(9, 405, dest, 406, false, &none).is_none());
    let o = meview::opened_of(9, 405, dest, 406, true, &none).unwrap();
    assert_eq!((o.p, o.q, o.tile, o.seal), (3, -2, 17, None));
    let o = meview::opened_of(9, 405, dest, 406, false, &with_seal).unwrap();
    assert_eq!(
        o.seal,
        Some((1, 0)),
        "a settled seal makes it public and is reported"
    );
}

#[test]
fn a_seal_of_an_earlier_march_of_the_same_host_is_not_this_marches() {
    // The herald keeps one seal per host: host 9 marched at bell 380 (settled, seal logged at bell 382) and marches again,
    // arriving in 405. Until the second march settles, the old record is all /h/me shows.
    let old = MeExtra::from_json(
        &json!({"seals": [{"host": "9", "outcome": 1, "code": 0, "bell": 382}]}),
    )
    .unwrap();
    let dest = (3, -2, 17);
    assert!(old.seal_for(9, 405).is_none());
    assert!(old.seal_for(9, 380).is_some(), "it is the seal of the march that arrived in 380");
    // Not public yet: the old seal must not open the second march (no destination before the REVEAL or its own settle).
    assert!(meview::opened_of(9, 405, dest, 406, false, &old).is_none());
    // Public through a REVEAL: opened, but the old seal's outcome is not reported as this march's.
    let o = meview::opened_of(9, 405, dest, 406, true, &old).unwrap();
    assert_eq!(o.seal, None);
    // Once the second march settles, the herald overwrites the record and it is this march's.
    let new = MeExtra::from_json(
        &json!({"seals": [{"host": "9", "outcome": 4, "code": 2, "bell": 407}]}),
    )
    .unwrap();
    let o = meview::opened_of(9, 405, dest, 408, false, &new).unwrap();
    assert_eq!(o.seal, Some((4, 2)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_request_lists_an_own_march_but_opens_it_only_after_its_arrival_bell() {
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
    assert_eq!(depart_count(&r.relay), 1);
    let m = bot.ai.book[0].clone();
    let key = (m.host_id, m.depart_bell);
    let (dp, dq, dt) = m.dest;
    let at = |bell: u32| NOW - 100 + (bell as i64 - 40) * BELL + 120;
    // Even once the march's REVEAL is observed, `opened` waits for the end of
    // the arrival bell.
    bot.mem.march_mut(key).unwrap().revealed = true;
    for bell in [41, m.arrive_bell] {
        r.sh.clock.set(at(bell));
        bot.step(&r.sh, true).await;
        let req = fm.requests.lock().unwrap().last().cloned().unwrap();
        let own = &req["own_marches"][0];
        assert_eq!(own["host_id"], m.host_id.to_string());
        assert_eq!(own["opened"], Value::Null, "bell {bell}");
    }
    r.sh.clock.set(at(m.arrive_bell + 1));
    bot.step(&r.sh, true).await;
    let req = fm.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(req["own_marches"][0]["opened"]["p"], dp);
    assert_eq!(req["own_marches"][0]["opened"]["q"], dq);
    assert_eq!(req["own_marches"][0]["opened"]["tile"], dt);
    // (Without a public destination it stays closed: `opened_of` above; in this
    // static fixture the march also counts as settled once its bell passed,
    // because the recorded holding shows no transit for it.)
    let _ = SEED;
}
