//! A cargo-only run (workstream 6's delivery without a making step): the
//! owner's goods shipped from stock as they are, judged on arrival exactly
//! like a making run's shipment. The simulated chain only: no key is
//! generated, derived or signed.
mod common;
use common::*;
use runexec::model::*;

fn cargo_spec(id: &str, s: &Scene, cargo: Res) -> RunSpec {
    RunSpec {
        run_id: id.to_string(),
        owner: OWNER,
        stock: s.stock,
        inbound: None,
        facility: None,
        inputs: ZERO,
        outputs: ZERO,
        rights_units: 0,
        ship: ShipSpec { dst: s.dst, cargo },
        deadline_slot: 400,
        budget: Budget::default(),
    }
}

#[test]
fn a_cargo_only_run_ships_its_cargo_and_is_fulfilled() {
    let mut h = H::new("cargo-only-fulfilled");
    let rights_before = h.sim.with(|w| format!("{:?}", w.rights));
    h.accept(&cargo_spec("c1", &h.scene, r(1, 4)));
    let halt = h.drive("c1", 80);
    assert!(halt.is_none(), "{halt:?}");
    let row = h.run("c1");
    assert_eq!(row.state, RunState::Fulfilled);
    assert_eq!(row.detail.fac_attempts, 0, "no facility request");
    let o = row.detail.outcome.unwrap();
    assert_eq!(o.delivered, Some(r(1, 4)));
    h.sim.with(|w| {
        assert_eq!(w.stores(&h.scene.dst), r(1, 4));
        assert_eq!(w.stores(&h.scene.stock), r(1, 6));
        assert_eq!(format!("{:?}", w.rights), rights_before, "no right used");
    });
    h.audit();
    // Its transitions are in its own table (Accepted → FacilityConfirmed).
    check_store(&h.ex.store);
}

#[test]
fn a_cargo_only_run_waits_for_its_cargo_and_fails_at_its_deadline() {
    let mut h = H::new("cargo-only-short");
    // 11 iron asked, 10 at stock: it waits, then fails at the deadline.
    let mut spec = cargo_spec("c2", &h.scene, r(1, 11));
    spec.deadline_slot = 30;
    h.accept(&spec);
    h.drive("c2", 120);
    let row = h.run("c2");
    assert_eq!(row.state, RunState::Expired, "{:?}", row.detail);
    h.sim
        .with(|w| assert_eq!(w.stores(&h.scene.stock), r(1, 10), "nothing left the stock"));
}

#[test]
fn a_cargo_only_spec_with_making_parts_is_refused() {
    let h = H::new("cargo-only-refused");
    for bad in [
        RunSpec {
            inputs: r(1, 1),
            ..cargo_spec("x1", &h.scene, r(1, 1))
        },
        RunSpec {
            outputs: r(6, 1),
            ..cargo_spec("x2", &h.scene, r(1, 1))
        },
        RunSpec {
            rights_units: 1,
            ..cargo_spec("x3", &h.scene, r(1, 1))
        },
    ] {
        assert!(h.ex.accept(&bad).is_err(), "{}", bad.run_id);
    }
}

/// A making run's spec serialises as before (the facility is its value,
/// not wrapped), so its digest and its stored form are unchanged; a
/// cargo-only spec has no `facility` field.
#[test]
fn a_making_spec_serialises_as_before() {
    let h = H::new("cargo-only-serde");
    let making = spec("m1", &h.scene);
    let j = serde_json::to_value(&making).unwrap();
    assert_eq!(
        j["facility"],
        serde_json::to_value(h.scene.facility).unwrap()
    );
    let back: RunSpec = serde_json::from_value(j).unwrap();
    assert_eq!(back.digest(), making.digest());
    let cargo = cargo_spec("c3", &h.scene, r(1, 1));
    let j = serde_json::to_value(&cargo).unwrap();
    assert!(j.get("facility").is_none());
    let back: RunSpec = serde_json::from_value(j).unwrap();
    assert!(back.cargo_only());
}
