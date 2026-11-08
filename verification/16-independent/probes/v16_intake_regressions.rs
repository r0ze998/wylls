//! ⑯ independent regressions for ④'s run intake (cf517b55): restart,
//! duplicate acceptance by another holder, nothing stored on a refusal,
//! A→B→A transfers, expired or stale sessions, tampered pass accounts, and a
//! run admitted before a transfer through a crash and a restart.
//!
//! Keyless: every key is a fixed 32-byte value, the pass accounts are bytes;
//! nothing is generated, derived or signed. The byte builders below are
//! copied from ④'s `tests/intake.rs` (lines 13–209 at cf517b55); the tests
//! after them are ⑯'s.
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


fn none_stored(h: &H, id: &str) {
    assert!(h.ex.store.load(id).unwrap().is_none(), "{id}: a refusal stored a run");
}

fn session(key: [u8; 32], gen: u32, by: [u8; 32], expiry: i64) -> Option<([u8; 32], u32, [u8; 32], i64)> {
    Some((key, gen, by, expiry))
}

#[test]
fn v16_i1_a_refusal_stores_nothing_and_does_not_reveal_a_run() {
    let h = H::new("v16-i1");
    let chain = Chain::new(A, 0, session(SESSION_A, 0, A, NOW + 100));
    chain.transfer(B, 1, None);
    for (who, g) in [(A, 0), (A, 1), (SESSION_A, 0), (SESSION_A, 1)] {
        assert!(h.ex.accept_as(&cargo("x", &h), &req(who, g), &chain).is_err());
        none_stored(&h, "x");
    }
    assert_eq!(h.ex.accept_as(&cargo("x", &h), &req(B, 1), &chain).unwrap(), runexec::store::Accept::Created);
    // The previous owner asking for the existing run id learns nothing.
    match h.ex.accept_as(&cargo("x", &h), &req(A, 1), &chain) {
        Err(e) => assert!(!e.contains("Existing"), "{e}"),
        Ok(a) => panic!("the previous owner got {a:?}"),
    }
}

#[test]
fn v16_i2_a_repeat_by_the_holders_session_keeps_the_first_check() {
    let h = H::new("v16-i2");
    let chain = Chain::new(B, 1, session(SESSION_B, 1, B, NOW + 100));
    assert_eq!(h.ex.accept_as(&cargo("d", &h), &req(B, 1), &chain).unwrap(), runexec::store::Accept::Created);
    assert!(matches!(
        h.ex.accept_as(&cargo("d", &h), &req(SESSION_B, 1), &chain).unwrap(),
        runexec::store::Accept::Existing(_)
    ));
    let a = h.run("d").detail.authority.expect("kept");
    assert_eq!((a.actor, a.owner, a.generation, a.by), (B, B, 1, AuthorityKind::Owner), "the first check stays");
    let mut other = cargo("d", &h);
    other.ship.cargo = r(1, 3);
    assert_eq!(h.ex.accept_as(&other, &req(SESSION_B, 1), &chain).unwrap(), runexec::store::Accept::Conflict);
}

#[test]
fn v16_i3_the_check_survives_a_restart_and_the_run_completes() {
    let mut h = H::new("v16-i3");
    let chain = Chain::new(B, 1, None);
    assert_eq!(h.ex.accept_as(&cargo("p", &h), &req(B, 1), &chain).unwrap(), runexec::store::Accept::Created);
    h.restart();
    let reopened = runexec::store::Store::open(&h.db).unwrap();
    let a = reopened.load("p").unwrap().unwrap().detail.authority.expect("persisted");
    assert_eq!((a.actor, a.generation), (B, 1));
    assert!(matches!(
        h.ex.accept_as(&cargo("p", &h), &req(B, 1), &chain).unwrap(),
        runexec::store::Accept::Existing(_)
    ));
    assert_eq!(h.drive("p", 80), None);
    assert_eq!(h.run("p").state, RunState::Fulfilled);
    h.audit();
    check_store(&h.ex.store);
}

#[test]
fn v16_i4_transfers_a_to_b_to_a_admit_only_the_current_generation() {
    let h = H::new("v16-i4");
    let chain = Chain::new(A, 0, None);
    chain.transfer(B, 1, None);
    chain.transfer(A, 2, None);
    for (who, g) in [(A, 0), (A, 1), (B, 1), (B, 2)] {
        assert!(h.ex.accept_as(&cargo("t", &h), &req(who, g), &chain).is_err(), "{:?} gen {g}", who[0]);
        none_stored(&h, "t");
    }
    assert_eq!(h.ex.accept_as(&cargo("t", &h), &req(A, 2), &chain).unwrap(), runexec::store::Accept::Created);
}

#[test]
fn v16_i5_a_session_acts_only_before_its_expiry_and_in_its_generation() {
    let h = H::new("v16-i5");
    let at = |e| Chain::new(B, 1, session(SESSION_B, 1, B, e));
    assert!(h.ex.accept_as(&cargo("s", &h), &req(SESSION_B, 1), &at(NOW)).is_err(), "expiry == now");
    assert!(h.ex.accept_as(&cargo("s", &h), &req(SESSION_B, 1), &at(NOW - 1)).is_err(), "expired");
    none_stored(&h, "s");
    // A session set in an earlier generation (left in the record) does not act.
    let old = Chain::new(B, 1, session(SESSION_B, 0, B, NOW + 100));
    assert!(h.ex.accept_as(&cargo("s", &h), &req(SESSION_B, 1), &old).is_err(), "session of generation 0");
    none_stored(&h, "s");
    assert!(matches!(
        h.ex.accept_as(&cargo("s", &h), &req(SESSION_B, 1), &at(NOW + 1)).unwrap(),
        runexec::store::Accept::Created
    ));
    let a = h.run("s").detail.authority.unwrap();
    assert_eq!((a.actor, a.owner, a.by), (SESSION_B, B, AuthorityKind::Session));
}

#[test]
fn v16_i6_every_tampered_pass_account_is_refused_and_stores_nothing() {
    let h = H::new("v16-i6");
    let cases: Vec<(&str, Box<dyn Fn(&mut PassView)>)> = vec![
        ("link owned by another program", Box::new(|v| v.link.owner = [0x99; 32])),
        ("policy owned by another program", Box::new(|v| v.policy.owner = [0x99; 32])),
        ("link names another citizen", Box::new(|v| { let mut c = citizen(); c[31] ^= 1; v.link.data = link_bytes(c) })),
        ("asset not under Core", Box::new(|v| v.asset.owner = [0x99; 32])),
        ("asset without the guard", Box::new(|v| v.asset.data = asset_bytes(&B, false))),
        ("resident record at another key", Box::new(|v| v.resident.key = [0x5c; 32])),
        ("resident record not the resident program's", Box::new(|v| v.resident.owner = [0x99; 32])),
        ("asset at another key", Box::new(|v| v.asset.key = [0x5d; 32])),
        ("link data cut short", Box::new(|v| v.link.data.truncate(8))),
    ];
    for (what, f) in cases {
        let chain = Chain::new(B, 1, None);
        chain.edit(|v| f(v));
        assert!(h.ex.accept_as(&cargo("m", &h), &req(B, 1), &chain).is_err(), "admitted with {what}");
        none_stored(&h, "m");
    }
    // The requester's citizen is not the run's, and a citizen without a pass.
    let chain = Chain::new(B, 1, None);
    let mut wrong = req(B, 1);
    wrong.citizen[31] ^= 1;
    assert!(h.ex.accept_as(&cargo("m", &h), &wrong, &chain).is_err());
    let mut other = cargo("m", &h);
    other.owner = OTHER;
    assert!(h.ex.accept_as(&other, &req(B, 1), &chain).is_err());
    none_stored(&h, "m");
}

#[test]
fn v16_i7_a_run_admitted_before_a_transfer_finishes_once_through_a_crash() {
    let mut h = H::new("v16-i7");
    let chain = Chain::new(A, 0, None);
    assert_eq!(h.ex.accept_as(&cargo("f", &h), &req(A, 0), &chain).unwrap(), runexec::store::Accept::Created);
    h.crash_at("ship.before_send", 1);
    let halt = h.drive("f", 80);
    assert!(halt.is_some(), "the crash happened");
    chain.transfer(B, 1, None);
    h.restart();
    assert_eq!(h.drive("f", 120), None);
    let row = h.run("f");
    assert_eq!(row.state, RunState::Fulfilled, "the owner's decision: an admitted run runs to its end");
    let a = row.detail.authority.unwrap();
    assert_eq!((a.owner, a.generation), (A, 0));
    h.audit();
    check_store(&h.ex.store);
    // After the transfer, the previous owner cannot add another run.
    assert!(h.ex.accept_as(&cargo("g", &h), &req(A, 0), &chain).is_err());
    none_stored(&h, "g");
}
