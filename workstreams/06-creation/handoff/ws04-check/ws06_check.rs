//! Scratch check by workstream 06 (not part of 04): 06's RunSpec JSON on 04's own cargo-only runs.
mod common;
use common::*;
use runexec::model::*;

fn specs() -> Vec<RunSpec> {
    serde_json::from_str(&std::fs::read_to_string(std::env::var("WS06_FIXTURE").unwrap()).unwrap()).unwrap()
}

fn chain(name: &str, burn: bool) -> (H, String, String) {
    let mut h = H::new(name);
    h.sim.with(|w| w.add_place(holding(1, 1, 3), OWNER, ZERO, None));
    let mut s = specs();
    let (a, b) = (s[0].run_id.clone(), s[1].run_id.clone());
    assert!(s[0].cargo_only() && s[1].cargo_only());
    h.accept(&s[0]);
    for _ in 0..40 {
        if h.run(&a).state == RunState::InTransit { break; }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    let key = CaravanKey { owner: OWNER, seq: h.run(&a).detail.ship_seq.unwrap() };
    s[1].inbound = Some(key);
    h.accept(&s[1]);
    if burn {
        let home = h.scene.raider_home;
        h.sim.with(|w| w.raid(key, false, RAIDER, home));
    }
    for _ in 0..200 {
        if h.run(&a).state.terminal() && h.run(&b).state.terminal() { break; }
        h.ex.tick().unwrap();
        h.sim.with(|w| w.advance(1));
    }
    (h, a, b)
}

#[test]
fn ws06_chain_on_04_cargo_only() {
    let (h, a, b) = chain("ws06-check", false);
    for id in [&a, &b] {
        let r = h.run(id);
        println!("{id}: {} {:?}", r.state.name(), r.detail.outcome);
        assert_eq!(r.state, RunState::Fulfilled);
    }
    let slot = |id: &str, k: &str| h.ex.store.receipts(id).unwrap().into_iter().find(|r| r.kind == k).unwrap().slot;
    assert!(slot(&b, "caravan_sent") >= slot(&a, "caravan_settled"));
    // 04's own spec-aware table (check_store in tests/common uses `allowed`, which a cargo-only run cannot pass)
    for id in [&a, &b] {
        let spec = h.run(id).spec;
        for (f, t, _, _) in h.ex.store.history(id).unwrap() {
            assert!(allowed_for(&spec, RunState::parse(&f).unwrap(), RunState::parse(&t).unwrap()), "{id}: {f} -> {t}");
        }
        assert_eq!(h.ex.store.reservations_of(id).unwrap(), 0);
    }
}

#[test]
fn ws06_chain_inbound_burned() {
    let (h, a, b) = chain("ws06-check-burn", true);
    assert_eq!(h.run(&a).detail.outcome.unwrap().verification, Verification::KnownZero);
    assert_eq!(h.run(&b).state, RunState::Failed);
    println!("{b}: {:?}", h.run(&b).detail.reason);
}

#[test]
fn ws06_same_run_id_same_spec_is_existing_other_spec_conflicts() {
    let h = H::new("ws06-check-idem");
    let s = specs();
    h.accept(&s[0]);
    assert!(matches!(h.ex.accept(&s[0]).unwrap(), runexec::store::Accept::Existing(_)));
    let mut other = s[0].clone();
    other.ship.cargo[1] = 5;
    assert!(matches!(h.ex.accept(&other).unwrap(), runexec::store::Accept::Conflict));
}
