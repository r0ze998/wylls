//! Chain flow, stage B (workstream 04): the NFT pass's Citizen (stage A,
//! `CHAIN_OUT/a-join.json`) sends a cargo-only caravan through the run
//! executor, on the simulated world (MOCK). The store it leaves
//! (`CHAIN_OUT/b-store.sqlite`, bound to stage A's world) is what stages C
//! (⑫ memory) and D (⑮ outcome) read.
//!
//! Run by `tools/chain-flow.sh` after stage A (`--ignored`: without stage A's
//! file it has nothing to run on). No key is generated, derived or signed:
//! the simulated chain takes no signatures.
//!
//! Not here (the owner's CC implements caravan Run acceptance and query in
//! parallel): who may ask for a run for this Citizen. The executor accepts
//! the spec as given; the acceptance must check that the requester is the
//! pass's current authority (generation and owner, as ResidentAct does in
//! stage A).
mod common;
use common::*;
use runexec::model::*;
use runexec::sim::{Sim, SimWorld};

fn field<'a>(j: &'a serde_json::Value, k: &str) -> &'a str {
    j[k].as_str()
        .unwrap_or_else(|| panic!("a-join.json: {k} missing"))
}

#[test]
#[ignore = "stage B of tools/chain-flow.sh: needs CHAIN_OUT/a-join.json from stage A"]
fn the_nft_citizen_sends_a_cargo_only_caravan() {
    let dir = std::path::PathBuf::from(std::env::var("CHAIN_OUT").expect("CHAIN_OUT"));
    let a: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("a-join.json")).expect("stage A output"))
            .unwrap();
    assert_eq!(a["stage"], "A");
    let tag: u64 = field(&a, "citizen_tag").parse().unwrap();
    // The tag is the Citizen address's (kernel citizen_tag), not the owner's
    // wallet: it does not change with the transfer.
    let citizen: [u8; 32] = hex::decode(field(&a, "citizen"))
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        permutation_rules::frontier::addr::citizen_tag(&citizen),
        tag
    );
    let world = format!(
        "game:{}/season:{}",
        field(&a, "program"),
        field(&a, "season")
    );

    let mut w = SimWorld::new();
    w.world = world.clone();
    let stock = holding(0, 0, 1);
    let dst = vault(1, 0, 5);
    w.add_place(stock, tag, r(1, 10), None);
    w.add_place(dst, tag, ZERO, Some(1_000));
    let sim = Sim::new(w);
    let db = dir.join("b-store.sqlite");
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db.display()));
    }
    let mut ex = executor(&db, &sim, "exec-chain");
    let spec = RunSpec {
        run_id: "chain-1".into(),
        owner: tag,
        stock,
        inbound: None,
        facility: None,
        inputs: ZERO,
        outputs: ZERO,
        rights_units: 0,
        ship: ShipSpec {
            dst,
            cargo: r(1, 4),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    };
    assert_eq!(ex.accept(&spec).unwrap(), runexec::store::Accept::Created);
    for _ in 0..120 {
        let row = ex.store.load("chain-1").unwrap().unwrap();
        if row.state.terminal() || row.held.is_some() {
            break;
        }
        ex.tick().expect("no crash planned");
        sim.with(|w| w.advance(1));
    }
    let row = ex.store.load("chain-1").unwrap().unwrap();
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.detail);
    assert_eq!(ex.store.world().unwrap().as_deref(), Some(world.as_str()));
    let rs = ex.store.receipts("chain-1").unwrap();
    let kinds: Vec<&str> = rs.iter().map(|r| r.kind.as_str()).collect();
    assert!(kinds.contains(&"caravan_sent"), "{kinds:?}");
    assert!(kinds.contains(&"caravan_settled"), "{kinds:?}");
    let subject = CaravanKey {
        owner: tag,
        seq: row.detail.ship_seq.unwrap(),
    }
    .text();
    assert!(rs
        .iter()
        .all(|r| r.kind == "facility_used" || r.subject == subject));
    sim.with(|w| {
        assert_eq!(w.stores(&dst), r(1, 4));
        w.audit().unwrap();
    });
    check_store(&ex.store);
    drop(ex);
    let summary = serde_json::json!({
        "stage": "B",
        "source": "workstreams/04-execution/tests/chain_caravan.rs",
        "world": world,
        "citizen_tag": tag.to_string(),
        "run_id": "chain-1",
        "state": row.state.name(),
        "subject": subject,
        "receipts": kinds,
        "store": "b-store.sqlite",
    });
    std::fs::write(
        dir.join("b-caravan.json"),
        serde_json::to_string_pretty(&summary).unwrap(),
    )
    .unwrap();
}
