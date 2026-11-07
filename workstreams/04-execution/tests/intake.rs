//! Run intake: only the current holder of the pass behind the run's citizen
//! (or that holder's live session) may ask for a run (workstream 04,
//! 2026-11-07; the holder is workstream 20's single definition). After a
//! transfer, the previous owner and the previous owner's session are
//! refused, with an old or a fresh signature, also for a repeated run id;
//! the new owner and the new owner's session are admitted.
//!
//! Keyless: every key is a fixed 32-byte value; the pass's accounts are
//! written as bytes in the layouts workstream 20's runtime tests use (a Core
//! AssetV1 with its transfer guard, the resident record with its generation
//! and session); the requester is taken as authenticated (`is_signer`).
//! Nothing is generated, derived or signed.
mod common;
use common::*;
use runexec::intake::{AuthorityKind, PassAccount, PassView, Passes, Requester};
use runexec::model::*;
use std::cell::RefCell;

const PROGRAM: [u8; 32] = [0x11; 32];
const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const CORE: [u8; 32] = [0x44; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const GUARD: [u8; 32] = [0x66; 32];
const ASSET: [u8; 32] = [0x5a; 32];
const RESIDENT: [u8; 32] = [0x5b; 32];
const A: [u8; 32] = [0xa1; 32];
const B: [u8; 32] = [0xb2; 32];
const SESSION_A: [u8; 32] = [0xc1; 32];
const SESSION_B: [u8; 32] = [0xc2; 32];
const NOW: i64 = 1_800_000_000;

/// The run's citizen: an address whose `citizen_tag` (its first 8 bytes,
/// little-endian) is the harness's `OWNER`.
fn citizen() -> [u8; 32] {
    let mut c = [0u8; 32];
    c[..8].copy_from_slice(&OWNER.to_le_bytes());
    c[8..].copy_from_slice(&[0x9c; 24]);
    c
}

fn guarded_tail(base: usize) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(&GUARD);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

fn asset_bytes(owner: &[u8; 32], guarded: bool) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    if guarded {
        let base = a.len();
        a.extend_from_slice(&guarded_tail(base));
    }
    a
}

/// The resident record (133 B): generation and an optional session
/// `(key, set at generation, set by, expiry)`.
fn resident_bytes(generation: u32, session: Option<([u8; 32], u32, [u8; 32], i64)>) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    if let Some((key, gen, setter, expiry)) = session {
        r[52..84].copy_from_slice(&key);
        r[84..92].copy_from_slice(&expiry.to_le_bytes());
        r[92..96].copy_from_slice(&gen.to_le_bytes());
        r[96..128].copy_from_slice(&setter);
    }
    r
}

fn link_bytes(citizen: [u8; 32]) -> Vec<u8> {
    let mut d = vec![0u8; frontier_abi::resident_binding::LEN];
    assert!(frontier_abi::resident_binding::write_once(
        &mut d,
        &frontier_abi::resident_binding::Record {
            asset: ASSET,
            resident: RESIDENT,
            citizen,
        }
    ));
    d
}

fn policy_bytes() -> Vec<u8> {
    let mut d = vec![0u8; frontier_abi::resident_policy::LEN];
    assert!(frontier_abi::resident_policy::write_once(
        &mut d,
        &frontier_abi::resident_auth::Policy {
            core_program: CORE,
            resident_program: RESIDENT_PROGRAM,
            collection: COLLECTION,
            guard_authority: GUARD,
        }
    ));
    d
}

/// The chain as the intake reads it: one pass, for the harness's citizen.
struct Chain {
    view: RefCell<Option<PassView>>,
}

impl Passes for Chain {
    fn pass_of(&self, c: &[u8; 32]) -> Result<Option<PassView>, String> {
        Ok(if *c == citizen() {
            self.view.borrow().clone()
        } else {
            None
        })
    }
}

impl Chain {
    /// The pass owned by `owner` at `generation`, with `session`.
    fn new(
        owner: [u8; 32],
        generation: u32,
        session: Option<([u8; 32], u32, [u8; 32], i64)>,
    ) -> Chain {
        let acct = |key, owner, data| PassAccount { key, owner, data };
        Chain {
            view: RefCell::new(Some(PassView {
                program: PROGRAM,
                link: acct([0x71; 32], PROGRAM, link_bytes(citizen())),
                policy: acct([0x72; 32], PROGRAM, policy_bytes()),
                asset: acct(ASSET, CORE, asset_bytes(&owner, true)),
                resident: acct(
                    RESIDENT,
                    RESIDENT_PROGRAM,
                    resident_bytes(generation, session),
                ),
                now: NOW,
            })),
        }
    }
    /// The resident program's TransferResident: the owner changes, the
    /// generation goes up, the session is cleared (or left as `session`).
    fn transfer(
        &self,
        to: [u8; 32],
        generation: u32,
        session: Option<([u8; 32], u32, [u8; 32], i64)>,
    ) {
        let mut v = self.view.borrow_mut();
        let v = v.as_mut().unwrap();
        v.asset.data = asset_bytes(&to, true);
        v.resident.data = resident_bytes(generation, session);
    }
    fn edit(&self, f: impl FnOnce(&mut PassView)) {
        f(self.view.borrow_mut().as_mut().unwrap());
    }
}

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
        citizen: citizen(),
    }
}

fn refused(r: Result<runexec::store::Accept, String>, why: &str) {
    match r {
        Err(e) => assert!(e.contains(why), "refused, but for: {e}"),
        Ok(a) => panic!("admitted ({a:?}); expected refusal: {why}"),
    }
}

const STALE: &str = "another pass generation";
const NOT_CURRENT: &str = "not the pass's current owner nor its live session";

#[test]
fn the_owner_is_admitted_and_the_check_is_kept_on_the_run() {
    let h = H::new("intake-owner");
    let chain = Chain::new(A, 0, None);
    let got =
        h.ex.accept_as(&cargo("r1", &h), &req(A, 0), &chain)
            .unwrap();
    assert_eq!(got, runexec::store::Accept::Created);
    let a = h.run("r1").detail.authority.expect("kept");
    assert_eq!(
        (a.actor, a.owner, a.generation, a.by),
        (A, A, 0, AuthorityKind::Owner)
    );
    assert_eq!(a.asset, ASSET);
}

/// After A → B (generation 1, session cleared): A is refused with its old
/// signature (stale) and with a fresh one (not current); A's session too;
/// nothing is stored; B is admitted at once.
#[test]
fn after_a_transfer_the_previous_owner_and_its_session_are_refused() {
    let h = H::new("intake-transfer");
    let chain = Chain::new(A, 0, Some((SESSION_A, 0, A, NOW + 3_600)));
    // Before the transfer A's session acts for A.
    let s =
        h.ex.accept_as(&cargo("s0", &h), &req(SESSION_A, 0), &chain)
            .unwrap();
    assert_eq!(s, runexec::store::Accept::Created);
    assert_eq!(
        h.run("s0").detail.authority.unwrap().by,
        AuthorityKind::Session
    );
    chain.transfer(B, 1, None);
    refused(h.ex.accept_as(&cargo("a1", &h), &req(A, 0), &chain), STALE);
    refused(
        h.ex.accept_as(&cargo("a2", &h), &req(A, 1), &chain),
        NOT_CURRENT,
    );
    refused(
        h.ex.accept_as(&cargo("a3", &h), &req(SESSION_A, 0), &chain),
        STALE,
    );
    refused(
        h.ex.accept_as(&cargo("a4", &h), &req(SESSION_A, 1), &chain),
        NOT_CURRENT,
    );
    refused(h.ex.accept_as(&cargo("a5", &h), &req(B, 0), &chain), STALE);
    for id in ["a1", "a2", "a3", "a4", "a5"] {
        assert!(h.ex.store.load(id).unwrap().is_none(), "{id} stored");
    }
    let b =
        h.ex.accept_as(&cargo("b1", &h), &req(B, 1), &chain)
            .unwrap();
    assert_eq!(b, runexec::store::Accept::Created);
    let a = h.run("b1").detail.authority.unwrap();
    assert_eq!((a.owner, a.generation, a.by), (B, 1, AuthorityKind::Owner));
}

/// A's session record may linger after the transfer (the resident program
/// left it): it is bound to generation 0 and to A, so it is not live for B.
#[test]
fn a_lingering_session_of_the_previous_owner_is_refused() {
    let h = H::new("intake-linger");
    let chain = Chain::new(A, 0, None);
    chain.transfer(B, 1, Some((SESSION_A, 0, A, NOW + 3_600)));
    refused(
        h.ex.accept_as(&cargo("x1", &h), &req(SESSION_A, 1), &chain),
        NOT_CURRENT,
    );
    // A session B sets in generation 1 acts; once expired it does not.
    chain.transfer(B, 1, Some((SESSION_B, 1, B, NOW + 3_600)));
    let got =
        h.ex.accept_as(&cargo("x2", &h), &req(SESSION_B, 1), &chain)
            .unwrap();
    assert_eq!(got, runexec::store::Accept::Created);
    assert_eq!(
        h.run("x2").detail.authority.unwrap().by,
        AuthorityKind::Session
    );
    chain.transfer(B, 1, Some((SESSION_B, 1, B, NOW - 1)));
    refused(
        h.ex.accept_as(&cargo("x3", &h), &req(SESSION_B, 1), &chain),
        NOT_CURRENT,
    );
}

/// A repeated run id from the previous owner is refused before the store is
/// asked: it neither adds a run nor learns whether one exists.
#[test]
fn a_repeated_run_id_from_the_previous_owner_is_refused() {
    let h = H::new("intake-dup");
    let chain = Chain::new(A, 0, None);
    let spec = cargo("d1", &h);
    h.ex.accept_as(&spec, &req(A, 0), &chain).unwrap();
    chain.transfer(B, 1, None);
    refused(h.ex.accept_as(&spec, &req(A, 0), &chain), STALE);
    refused(h.ex.accept_as(&spec, &req(A, 1), &chain), NOT_CURRENT);
    // The new owner asking for the same spec: the existing run (idempotent).
    assert!(matches!(
        h.ex.accept_as(&spec, &req(B, 1), &chain).unwrap(),
        runexec::store::Accept::Existing(_)
    ));
}

/// What the intake refuses about the pass itself.
#[test]
fn a_run_without_a_sound_pass_is_refused() {
    let h = H::new("intake-pass");
    // No pass for the citizen (every player needs one).
    let chain = Chain::new(A, 0, None);
    let mut other = cargo("p0", &h);
    other.owner = OTHER;
    let mut no_pass = [0x9du8; 32];
    no_pass[..8].copy_from_slice(&OTHER.to_le_bytes());
    let r0 = Requester {
        citizen: no_pass,
        ..req(A, 0)
    };
    refused(h.ex.accept_as(&other, &r0, &chain), "no NFT pass");
    // A requester naming another citizen than the run's.
    refused(
        h.ex.accept_as(&cargo("p0b", &h), &r0, &chain),
        "requester's citizen is not the run's",
    );
    // The link names another citizen.
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.link.data = link_bytes([0x01; 32]));
    refused(
        h.ex.accept_as(&cargo("p1", &h), &req(A, 0), &c),
        "another citizen",
    );
    // The link or the policy not the game program's.
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.link.owner = [0x02; 32]);
    refused(
        h.ex.accept_as(&cargo("p2", &h), &req(A, 0), &c),
        "not the game program's",
    );
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.policy.owner = [0x02; 32]);
    refused(
        h.ex.accept_as(&cargo("p3", &h), &req(A, 0), &c),
        "not the game program's",
    );
    // The asset without its transfer guard; not Core's; another resident record.
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.asset.data = asset_bytes(&A, false));
    refused(
        h.ex.accept_as(&cargo("p4", &h), &req(A, 0), &c),
        "transfer guard",
    );
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.asset.owner = [0x03; 32]);
    refused(
        h.ex.accept_as(&cargo("p5", &h), &req(A, 0), &c),
        "bound asset",
    );
    let c = Chain::new(A, 0, None);
    c.edit(|v| v.resident.data[1] ^= 1);
    refused(
        h.ex.accept_as(&cargo("p6", &h), &req(A, 0), &c),
        "resident record",
    );
    for id in ["p0", "p1", "p2", "p3", "p4", "p5", "p6"] {
        assert!(h.ex.store.load(id).unwrap().is_none(), "{id} stored");
    }
}

/// A run admitted before a transfer is not re-checked by the intake when the
/// pass moves later (what a transfer does to a run in flight is undecided);
/// its record keeps who asked and at which generation, so a decision can be
/// applied to it.
#[test]
fn a_run_admitted_before_a_transfer_keeps_its_check() {
    let mut h = H::new("intake-inflight");
    let chain = Chain::new(A, 0, None);
    h.ex.accept_as(&cargo("f1", &h), &req(A, 0), &chain)
        .unwrap();
    chain.transfer(B, 1, None);
    h.drive("f1", 80);
    let row = h.run("f1");
    let a = row.detail.authority.expect("kept through the run");
    assert_eq!((a.owner, a.generation), (A, 0));
    assert_eq!(
        row.state,
        RunState::Fulfilled,
        "undecided: the run is not stopped here"
    );
}
