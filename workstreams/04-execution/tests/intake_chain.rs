//! Run intake against the chain (workstream 04, 2026-11-07; the owner's
//! decision the same day): a run accepted before an NFT transfer runs to its
//! end; a request after the transfer is admitted only from the new holder
//! (or its live session) at the new generation. The pass is read by
//! `intake::RpcPasses` over JSON-RPC from a stand-in node
//! (`common::passnode`), at the accounts' real (PDA) addresses; the external
//! intake is the `runexec run accept` command with the requester the
//! gateway hands over.
//!
//! Keyless: fixed 32-byte keys and PDAs only; no key is generated, derived
//! or signed. The requester is taken as the gateway authenticated it.
mod common;
use common::passnode::*;
use common::*;
use runexec::intake::{AuthorityKind, Requester};
use runexec::intake_rpc::RpcPasses;
use runexec::model::*;
use serde_json::Value;
use std::process::Command;

fn cargo(id: &str, h: &H) -> RunSpec {
    RunSpec {
        run_id: id.to_string(),
        owner: OWNER,
        stock: h.scene.stock,
        inbound: None,
        facility: None,
        inputs: ZERO,
        outputs: ZERO,
        rights_units: 0,
        ship: ShipSpec {
            dst: h.scene.dst,
            cargo: r(1, 2),
        },
        deadline_slot: 400,
        budget: Budget::default(),
    }
}

fn req(actor: [u8; 32], generation: u32) -> Requester {
    Requester {
        actor,
        generation,
        citizen: citizen_of(OWNER),
    }
}

fn reader(n: &PassNode) -> RpcPasses {
    RpcPasses::new(&n.url, PROGRAM, SEASON).unwrap()
}

fn refused(r: Result<runexec::store::Accept, String>, why: &str) {
    match r {
        Err(e) => assert!(e.contains(why), "refused, but for: {e}"),
        Ok(a) => panic!("admitted ({a:?}); expected refusal: {why}"),
    }
}

const STALE: &str = "another pass generation";
const NOT_CURRENT: &str = "not the pass's current owner nor its live session";

// ------------------------------------------------------------ before the transfer

/// Accepted from the owner A, read from the chain; the NFT then moves to B.
/// The accepted run is not stopped: it runs to its end (the owner's
/// decision), and it keeps who admitted it (A, generation 0).
#[test]
fn a_run_accepted_before_the_transfer_runs_to_its_end() {
    let mut h = H::new("chain-before");
    let n = PassNode::start(OWNER, A, 0, None);
    let got =
        h.ex.accept_as(&cargo("r1", &h), &req(A, 0), &reader(&n))
            .unwrap();
    assert_eq!(got, runexec::store::Accept::Created);
    n.transfer(B, 1, None);
    assert!(h.drive("r1", 80).is_none());
    let row = h.run("r1");
    assert_eq!(row.state, RunState::Fulfilled, "{:?}", row.detail);
    let a = row.detail.authority.expect("kept");
    assert_eq!(
        (a.actor, a.owner, a.generation, a.by),
        (A, A, 0, AuthorityKind::Owner)
    );
    h.sim.with(|w| assert_eq!(w.stores(&h.scene.dst), r(1, 2)));
}

/// A run A's session asked for before the transfer also runs to its end.
#[test]
fn a_run_a_session_asked_for_before_the_transfer_runs_to_its_end() {
    let mut h = H::new("chain-before-session");
    let n = PassNode::start(OWNER, A, 0, Some((SESSION_A, 0, A, NOW + 3_600)));
    h.ex.accept_as(&cargo("s1", &h), &req(SESSION_A, 0), &reader(&n))
        .unwrap();
    n.transfer(B, 1, None);
    h.drive("s1", 80);
    let row = h.run("s1");
    assert_eq!(row.state, RunState::Fulfilled);
    assert_eq!(row.detail.authority.unwrap().by, AuthorityKind::Session);
}

// ------------------------------------------------------------ after the transfer

/// After A → B (generation 1): every new request from A or A's session is
/// refused (old or new generation; nothing stored), also a repeated run id
/// of A's earlier run; B and B's live session are admitted.
#[test]
fn after_the_transfer_only_the_new_holder_is_admitted() {
    let h = H::new("chain-after");
    let n = PassNode::start(OWNER, A, 0, Some((SESSION_A, 0, A, NOW + 3_600)));
    let earlier = cargo("e1", &h);
    h.ex.accept_as(&earlier, &req(A, 0), &reader(&n)).unwrap();
    n.transfer(B, 1, Some((SESSION_A, 0, A, NOW + 3_600))); // A's session record lingers
    let p = reader(&n);
    refused(h.ex.accept_as(&cargo("a1", &h), &req(A, 0), &p), STALE);
    refused(
        h.ex.accept_as(&cargo("a2", &h), &req(A, 1), &p),
        NOT_CURRENT,
    );
    refused(
        h.ex.accept_as(&cargo("a3", &h), &req(SESSION_A, 0), &p),
        STALE,
    );
    refused(
        h.ex.accept_as(&cargo("a4", &h), &req(SESSION_A, 1), &p),
        NOT_CURRENT,
    );
    refused(h.ex.accept_as(&earlier, &req(A, 0), &p), STALE);
    refused(h.ex.accept_as(&cargo("b0", &h), &req(B, 0), &p), STALE);
    for id in ["a1", "a2", "a3", "a4", "b0"] {
        assert!(h.ex.store.load(id).unwrap().is_none(), "{id} stored");
    }
    let got = h.ex.accept_as(&cargo("b1", &h), &req(B, 1), &p).unwrap();
    assert_eq!(got, runexec::store::Accept::Created);
    let a = h.run("b1").detail.authority.unwrap();
    assert_eq!((a.owner, a.generation, a.by), (B, 1, AuthorityKind::Owner));
    // B sets a session in generation 1: it acts; expired, it does not.
    n.transfer(B, 1, Some((SESSION_B, 1, B, NOW + 3_600)));
    let got =
        h.ex.accept_as(&cargo("b2", &h), &req(SESSION_B, 1), &p)
            .unwrap();
    assert_eq!(got, runexec::store::Accept::Created);
    n.transfer(B, 1, Some((SESSION_B, 1, B, NOW - 1)));
    refused(
        h.ex.accept_as(&cargo("b3", &h), &req(SESSION_B, 1), &p),
        NOT_CURRENT,
    );
}

/// What the chain reader refuses or finds no pass in.
#[test]
fn the_chain_reader_refuses_an_unsound_pass() {
    let h = H::new("chain-reader");
    let n = PassNode::start(OWNER, A, 0, None);
    // The Citizen not the game program's.
    n.edit(citizen_of(OWNER), |a| a.0 = [0x07; 32]);
    refused(
        h.ex.accept_as(&cargo("c1", &h), &req(A, 0), &reader(&n)),
        "not the game program's",
    );
    n.edit(citizen_of(OWNER), |a| a.0 = PROGRAM);
    // No link in this Season: no pass.
    n.remove(link_key());
    refused(
        h.ex.accept_as(&cargo("c2", &h), &req(A, 0), &reader(&n)),
        "no NFT pass",
    );
    // Another Season's reader (its link address differs): no pass.
    let other = RpcPasses::new(&n.url, PROGRAM, [0x23; 32]).unwrap();
    refused(
        h.ex.accept_as(&cargo("c3", &h), &req(A, 0), &other),
        "no NFT pass",
    );
    // The asset without its guard, or not Core's.
    let n = PassNode::start(OWNER, A, 0, None);
    n.edit(ASSET, |a| a.1.truncate(a.1.len() - 20));
    assert!(h
        .ex
        .accept_as(&cargo("c4", &h), &req(A, 0), &reader(&n))
        .is_err());
    let n = PassNode::start(OWNER, A, 0, None);
    n.edit(ASSET, |a| a.0 = [0x08; 32]);
    refused(
        h.ex.accept_as(&cargo("c5", &h), &req(A, 0), &reader(&n)),
        "bound asset",
    );
    // No node: nothing admitted.
    let gone = RpcPasses::new("http://127.0.0.1:9", PROGRAM, SEASON).unwrap();
    refused(h.ex.accept_as(&cargo("c6", &h), &req(A, 0), &gone), "rpc");
    for id in ["c1", "c2", "c3", "c4", "c5", "c6"] {
        assert!(h.ex.store.load(id).unwrap().is_none(), "{id} stored");
    }
}

// ------------------------------------------------------------ the external intake

fn exe() -> &'static str {
    env!("CARGO_BIN_EXE_runexec")
}

fn run_accept(
    db: &std::path::Path,
    spec: &RunSpec,
    requester: Option<&str>,
    n: &PassNode,
) -> (i32, Value) {
    let dir = db.parent().unwrap();
    let sp = dir.join(format!("{}.spec.json", spec.run_id));
    std::fs::write(&sp, serde_json::to_string(spec).unwrap()).unwrap();
    let mut args: Vec<String> = vec![
        "run".into(),
        "accept".into(),
        "--db".into(),
        db.display().to_string(),
        "--spec".into(),
        sp.display().to_string(),
        "--rpc".into(),
        n.url.clone(),
        "--program".into(),
        b58(&PROGRAM),
        "--season".into(),
        b58(&SEASON),
    ];
    if let Some(body) = requester {
        let rp = dir.join(format!("{}.requester.json", spec.run_id));
        std::fs::write(&rp, body).unwrap();
        args.push("--requester".into());
        args.push(rp.display().to_string());
    }
    let out = Command::new(exe()).args(&args).output().unwrap();
    let line = String::from_utf8_lossy(&out.stdout);
    (
        out.status.code().unwrap_or(-1),
        serde_json::from_str(line.trim()).unwrap_or(Value::Null),
    )
}

/// The command: the owner's request is accepted; after the transfer A's is
/// refused (exit 5, NotAuthorized, nothing written) and B's accepted; a
/// request without the gateway's requester is refused (exit 2).
#[test]
fn the_run_accept_command_checks_the_requester_against_the_chain() {
    let h = H::new("chain-cli");
    let db = h.db.clone();
    let n = PassNode::start(OWNER, A, 0, None);
    let cit = citizen_of(OWNER);
    let (c, v) = run_accept(
        &db,
        &cargo("k1", &h),
        Some(&requester_json(&A, 0, &cit)),
        &n,
    );
    assert_eq!((c, v["accept"].as_str()), (0, Some("Created")), "{v}");
    n.transfer(B, 1, None);
    let (c, v) = run_accept(
        &db,
        &cargo("k2", &h),
        Some(&requester_json(&A, 0, &cit)),
        &n,
    );
    assert_eq!((c, v["error"].as_str()), (5, Some("NotAuthorized")), "{v}");
    let (c, v) = run_accept(
        &db,
        &cargo("k3", &h),
        Some(&requester_json(&A, 1, &cit)),
        &n,
    );
    assert_eq!((c, v["error"].as_str()), (5, Some("NotAuthorized")), "{v}");
    for id in ["k2", "k3"] {
        assert!(h.ex.store.load(id).unwrap().is_none(), "{id} stored");
    }
    let (c, v) = run_accept(
        &db,
        &cargo("k4", &h),
        Some(&requester_json(&B, 1, &cit)),
        &n,
    );
    assert_eq!((c, v["accept"].as_str()), (0, Some("Created")), "{v}");
    let (c, v) = run_accept(&db, &cargo("k5", &h), None, &n);
    assert_eq!(c, 2, "{v}");
    assert!(h.ex.store.load("k5").unwrap().is_none());
    // The run accepted before the transfer is still there and carries its check.
    assert_eq!(h.run("k1").detail.authority.unwrap().owner, A);
    assert_eq!(h.run("k4").detail.authority.unwrap().owner, B);
}
