//! Refusals: permission overreach, double execution, other versions, stops,
//! publication bounds, state growth, minting, atomicity. Every refused call
//! must leave the world exactly as it was.

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::describe::describe;
use wylls_ext_kernel::examples::{
    watch_vow, watch_vow_v2, wood_offering, FULFIL, PLEDGE, RENOWN, W,
};
use wylls_ext_kernel::host::Host;
use wylls_ext_kernel::manifest::{Cmp, Manifest, ManifestId, Op, Operand, MAX_OPS};
use wylls_ext_kernel::receipt::{Call, WITHDRAW};
use wylls_ext_kernel::registry::Status;
use wylls_ext_kernel::verify::{verify, Verdict};
use wylls_ext_kernel::{ExtError, Layer};

const T: i64 = T0 + 10 * BELL;

fn published(host: &mut Host, m: &Manifest) -> ManifestId {
    host.registry
        .publish(&m.author, &m.encode(), None, T)
        .unwrap()
}

fn vow_world() -> (Host, ManifestId) {
    let mut host = world();
    let id = published(&mut host, &watch_vow(AUTHOR_A));
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 15_000))
        .unwrap();
    (host, id)
}

/// The call is refused with `want`, and nothing the core keeps changed.
fn refused(host: &mut Host, c: &Call, want: ExtError) {
    let before = host.clone();
    let got = if c.entry == WITHDRAW {
        host.withdraw(c)
    } else {
        host.call(c)
    };
    assert_eq!(got.err(), Some(want), "{c:?}");
    assert_eq!(host.instances, before.instances);
    assert_eq!(host.grants, before.grants);
    assert_eq!(host.created, before.created);
    assert_eq!(host.log, before.log);
    for (k, h) in &before.holdings {
        assert_eq!(host.holdings[k].holding, h.holding);
    }
}

// ---- someone else's resources, keys and permissions ----------------------

#[test]
fn r01_no_one_uses_anothers_keys_holding_or_grant() {
    let (mut host, id) = vow_world();
    // C signs for B.
    let mut c = call(id, PLEDGE, &[5_000, 2], 0, T);
    c.signer = C_WALLET;
    refused(&mut host, &c, ExtError::NotSigned);
    // The author signs for B.
    c.signer = AUTHOR_A;
    refused(&mut host, &c, ExtError::NotSigned);
    // B pays from C's holding.
    let mut c = call(id, PLEDGE, &[5_000, 2], 0, T);
    c.holding = C_HOLDING;
    refused(&mut host, &c, ExtError::NotOwner);
    // C, with C's own key, has no grant of C's own.
    let c = Call {
        citizen: C_CITIZEN,
        holding: C_HOLDING,
        signer: C_WALLET,
        ..call(id, PLEDGE, &[5_000, 2], 0, T)
    };
    refused(&mut host, &c, ExtError::NoGrant);
    // A session key cannot grant (only the wallet can).
    assert_eq!(
        host.set_grant(&B_SESSION, grant(B_CITIZEN, id, 20_000, 20_000)),
        Err(ExtError::NotSigned)
    );
    // C cannot write a grant for B.
    assert_eq!(
        host.set_grant(&C_WALLET, grant(B_CITIZEN, id, 20_000, 20_000)),
        Err(ExtError::NotSigned)
    );
    // B's session key works before its expiry, not after.
    let mut c = call(id, PLEDGE, &[5_000, 2], 0, T0 + 100 * BELL);
    c.signer = B_SESSION;
    refused(&mut host, &c, ExtError::SessionExpired);
    c.now_ts = T;
    host.call(&c).unwrap();
}

#[test]
fn r02_the_grant_caps_what_a_call_may_take() {
    let (mut host, id) = vow_world();
    // Over the grant's per-call cap (10,000) though inside the manifest's.
    refused(
        &mut host,
        &call(id, PLEDGE, &[12_000, 2], 0, T),
        ExtError::GrantCap,
    );
    // Over the manifest's own cap: the argument bound refuses first.
    refused(
        &mut host,
        &call(id, PLEDGE, &[25_000, 2], 0, T),
        ExtError::ArgBounds,
    );
    // Budget: 15,000 in all. 10,000 then 6,000 is over.
    host.call(&call(id, PLEDGE, &[10_000, 1], 0, T)).unwrap();
    host.call(&call(id, FULFIL, &[], 1, T + BELL)).unwrap();
    refused(
        &mut host,
        &call(id, PLEDGE, &[6_000, 1], 2, T + BELL),
        ExtError::GrantCap,
    );
    host.call(&call(id, PLEDGE, &[5_000, 1], 2, T + BELL))
        .unwrap();
    // Entry not granted, expiry, revocation, call count.
    let mut g = host.grants[&(B_CITIZEN, id)].clone();
    g.entries = 0b01;
    host.set_grant(&B_WALLET, g.clone()).unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 3, T + 2 * BELL),
        ExtError::GrantEntry,
    );
    g.entries = 0b11;
    g.expires_ts = T;
    host.set_grant(&B_WALLET, g.clone()).unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 3, T + 2 * BELL),
        ExtError::GrantExpired,
    );
    g.expires_ts = T + 1_000 * BELL;
    g.revoked = true;
    host.set_grant(&B_WALLET, g.clone()).unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 3, T + 2 * BELL),
        ExtError::GrantRevoked,
    );
    g.revoked = false;
    g.calls_left = 0;
    host.set_grant(&B_WALLET, g).unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 3, T + 2 * BELL),
        ExtError::GrantCalls,
    );
}

// ---- double execution ------------------------------------------------------

#[test]
fn r03_a_call_runs_once() {
    let (mut host, id) = vow_world();
    let before = host.clone();
    let c = call(id, PLEDGE, &[5_000, 2], 0, T);
    let r = host.call(&c).unwrap();
    // The same call again (a retry, a replay by anyone).
    refused(&mut host, &c, ExtError::SeqMismatch);
    // A retrying runner can tell "already done" from the chain head.
    assert_eq!(host.instances[&(id, B_CITIZEN)].last_receipt, r.id());
    assert_eq!(wood(&host, &B_HOLDING, T), WOOD0 - 5_000);
    // A skipped seq is refused as well.
    refused(
        &mut host,
        &call(id, FULFIL, &[], 2, T + 2 * BELL),
        ExtError::SeqMismatch,
    );

    // An archive that lists the call twice does not verify.
    let mut ev = evidence(&before, &host);
    ev.log.push(ev.log[0].clone());
    assert!(verify(&ev).fails_with("SeqReplay"), "{:?}", verify(&ev));
}

// ---- versions --------------------------------------------------------------

#[test]
fn r04_an_update_does_not_change_what_the_user_granted() {
    let (mut host, v1) = vow_world();
    host.call(&call(v1, PLEDGE, &[5_000, 1], 0, T)).unwrap();
    // A publishes v2, superseding v1. A new id; v1 is untouched.
    let v2 = host
        .registry
        .publish(&AUTHOR_A, &watch_vow_v2(AUTHOR_A).encode(), Some(v1), T + 1)
        .unwrap();
    assert_ne!(v1, v2);
    assert_eq!(host.registry.get(&v1).unwrap().status(), Status::Active);
    // B's grant is for v1: a call naming v2 is refused.
    let mut c = call(v2, PLEDGE, &[5_000, 0], 0, T + 1);
    c.seq = 0;
    refused(&mut host, &c, ExtError::GrantVersion);
    // B's v1 keeps v1's meaning (renown +1, not v2's +2).
    host.call(&call(v1, FULFIL, &[], 1, T + BELL)).unwrap();
    assert_eq!(host.instances[&(v1, B_CITIZEN)].fields[RENOWN as usize], 1);
    // Someone else cannot publish "an update" of A's extension.
    let mut other = watch_vow_v2(C_WALLET);
    other.name = "impostor".into();
    assert_eq!(
        host.registry
            .publish(&C_WALLET, &other.encode(), Some(v1), T + 2),
        Err(ExtError::NotAuthor)
    );
    // Nor publish under A's name.
    assert_eq!(
        host.registry
            .publish(&C_WALLET, &watch_vow_v2(AUTHOR_A).encode(), None, T + 2),
        Err(ExtError::NotSigned)
    );
    // The same bytes twice are one registration.
    assert_eq!(
        host.registry
            .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, T + 2),
        Err(ExtError::AlreadyRegistered)
    );
}

#[test]
fn r05_a_manifest_for_another_core_does_not_run() {
    let mut host = world();
    let mut m = watch_vow(AUTHOR_A);
    m.core.program_version = 5;
    let id = published(&mut host, &m);
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    refused(
        &mut host,
        &call(id, PLEDGE, &[5_000, 1], 0, T),
        ExtError::CoreVersion,
    );
    let mut m = watch_vow(AUTHOR_A);
    m.core.ruleset_hash[0] ^= 1;
    let id = published(&mut host, &m);
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    refused(
        &mut host,
        &call(id, PLEDGE, &[5_000, 1], 0, T),
        ExtError::CoreVersion,
    );
}

// ---- stop, revoke, and what was already done -----------------------------

#[test]
fn r06_stops_refuse_new_calls_keep_what_was_done_and_let_users_out() {
    let (mut host, id) = vow_world();
    let before = host.clone();
    let r1 = host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    // Only the author or the operator may stop it.
    assert_eq!(
        host.registry
            .set_status(&C_WALLET, &id, Status::Paused, T + BELL),
        Err(ExtError::NotAuthor)
    );
    host.registry
        .set_status(&AUTHOR_A, &id, Status::Paused, T + BELL)
        .unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 1, T + 6 * BELL),
        ExtError::Paused,
    );
    // The pledge already made stays made (its receipt, its state).
    assert_eq!(host.instances[&(id, B_CITIZEN)].last_receipt, r1.id());
    // Withdraw: only the owner, only while stopped, runs no manifest op.
    let w = |seq, signer| Call {
        signer,
        ..call(id, WITHDRAW, &[], seq, T + 2 * BELL)
    };
    refused(&mut host, &w(1, C_WALLET), ExtError::NotSigned);
    host.withdraw(&w(1, B_WALLET)).unwrap();
    assert_eq!(wood(&host, &B_HOLDING, T + 2 * BELL), WOOD0);
    assert_eq!(host.instances[&(id, B_CITIZEN)].escrow, [0; 8]);
    assert_eq!(host.instances[&(id, B_CITIZEN)].fields[RENOWN as usize], 0);
    // Resume: the exit is shut again (the grant is live), and the closed
    // instance runs no entry: its fields still name a pledge it no longer
    // holds, so fulfil cannot pay it twice.
    host.registry
        .set_status(&OPERATOR, &id, Status::Active, T + 3 * BELL)
        .unwrap();
    refused(&mut host, &w(2, B_WALLET), ExtError::ExitNotOpen);
    refused(
        &mut host,
        &call(id, FULFIL, &[], 2, T + 7 * BELL),
        ExtError::InstanceClosed,
    );
    // Revoke is final.
    host.registry
        .set_status(&OPERATOR, &id, Status::Revoked, T + 8 * BELL)
        .unwrap();
    assert_eq!(
        host.registry
            .set_status(&AUTHOR_A, &id, Status::Active, T + 9 * BELL),
        Err(ExtError::Revoked)
    );
    refused(
        &mut host,
        &call(id, PLEDGE, &[1_000, 1], 2, T + 9 * BELL),
        ExtError::Revoked,
    );
    // The whole history verifies.
    let ev = evidence(&before, &host);
    assert_eq!(verify(&ev), Verdict::Pass, "{:?}", verify(&ev));
    // A history that says it was paused from the start does not.
    let mut ev2 = ev.clone();
    ev2.history
        .get_mut(&id)
        .unwrap()
        .insert(1, (T, Status::Paused));
    assert!(
        verify(&ev2).fails_with("CalledWhileStopped"),
        "{:?}",
        verify(&ev2)
    );
}

// ---- publication bounds: no loop, no unknown op, bounded size ----------

#[test]
fn r07_publication_refuses_unbounded_or_unknown_manifests() {
    let mut host = world();
    let pubm =
        |host: &mut Host, m: &Manifest| host.registry.publish(&AUTHOR_A, &m.encode(), None, T);
    let base = watch_vow(AUTHOR_A);

    let mut m = base.clone();
    m.entries[1].ops = vec![Op::Emit(0); MAX_OPS + 1];
    assert_eq!(pubm(&mut host, &m), Err(ExtError::TooManyOps));

    let mut m = base.clone();
    m.entries[0].ops.push(Op::Set(9, Operand::Const(1)));
    assert_eq!(pubm(&mut host, &m), Err(ExtError::BadReference));

    let mut m = base.clone();
    m.entries[1]
        .ops
        .push(Op::Require(Cmp::Eq, Operand::Arg(0), Operand::Const(0)));
    assert_eq!(pubm(&mut host, &m), Err(ExtError::BadReference));

    // Paying a resource with no cap.
    let mut m = base.clone();
    m.entries[0]
        .ops
        .push(Op::Pay(Resource::Gold as u8, Operand::Const(1)));
    assert_eq!(pubm(&mut host, &m), Err(ExtError::BadBounds));

    let mut m = base.clone();
    m.entries[1].id = WITHDRAW;
    assert_eq!(pubm(&mut host, &m), Err(ExtError::BadBounds));

    let mut m = base.clone();
    m.fields[0].init = 5_000;
    assert_eq!(pubm(&mut host, &m), Err(ExtError::BadBounds));

    let mut m = base.clone();
    m.effect_set = 2;
    assert_eq!(pubm(&mut host, &m), Err(ExtError::UnknownEffectSet));

    // Byte-level: every op code outside the closed set, including any
    // would-be jump or call, does not decode.
    let good = base.encode();
    let first_op = good
        .windows(3)
        .position(|w| w == [Op::REQUIRE, Cmp::Eq as u8, 2])
        .expect("pledge's first op");
    for code in 0x08..=0xFFu8 {
        let mut b = good.clone();
        b[first_op] = code;
        assert_eq!(
            Manifest::decode(&b).err(),
            Some(ExtError::UnknownOp),
            "{code:#x}"
        );
    }
    // Non-canonical bytes (a field index with high bits set) and trailing
    // bytes are refused, so one meaning has one id.
    let mut b = good.clone();
    b[first_op + 3 + 1] = 0x01; // the index's second byte
    assert_eq!(Manifest::decode(&b).err(), Some(ExtError::Malformed));
    let mut b = good.clone();
    b.push(0);
    assert_eq!(Manifest::decode(&b).err(), Some(ExtError::Malformed));
    assert_eq!(
        Manifest::decode(&vec![0u8; 1_025]).err(),
        Some(ExtError::TooLarge)
    );
    assert_eq!(ExtError::UnknownOp.layer(), Layer::Static);
}

#[test]
fn r08_state_creation_is_bounded() {
    let (mut host, id) = vow_world();
    // max_instances = 3: three other users take every slot.
    for n in 0..3u8 {
        let citizen = [0x50 + n; 32];
        let wallet = [0x60 + n; 32];
        let holding = [0x70 + n; 32];
        add_user(&mut host, citizen, wallet, [0; 32], holding);
        host.set_grant(&wallet, grant(citizen, id, 10_000, 10_000))
            .unwrap();
        let c = Call {
            citizen,
            holding,
            signer: wallet,
            ..call(id, PLEDGE, &[1_000, 1], 0, T)
        };
        host.call(&c).unwrap();
    }
    assert_eq!(host.created[&id], 3);
    // B, the fourth user, cannot create a fourth instance.
    refused(
        &mut host,
        &call(id, PLEDGE, &[1_000, 1], 0, T),
        ExtError::InstanceCap,
    );
}

// ---- no mint, no free balance writes, all or nothing -------------------

#[test]
fn r09_an_extension_cannot_mint_or_write_balances() {
    let mut host = world();
    // A manifest that tries to hand out wood it never took.
    let mut m = watch_vow(AUTHOR_A);
    m.name = "free-wood".into();
    m.entries[1].ops = vec![Op::Refund(W, Operand::Const(10_000))];
    let id = published(&mut host, &m);
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 0, T),
        ExtError::EscrowInsufficient,
    );
    // More than the holding has.
    let (mut host, id) = vow_world();
    host.holdings.get_mut(&B_HOLDING).unwrap().holding = holding_with_wood(3_000);
    refused(
        &mut host,
        &call(id, PLEDGE, &[5_000, 1], 0, T),
        ExtError::Insufficient,
    );
}

#[test]
fn r10_a_failure_after_a_payment_undoes_the_payment() {
    let mut host = world();
    let mut m = watch_vow(AUTHOR_A);
    m.name = "pay-then-refuse".into();
    m.entries[0].ops = vec![
        Op::Pay(W, Operand::Arg(0)),
        Op::Add(0, Operand::Const(1)),
        Op::Require(Cmp::Gt, Operand::Arg(1), Operand::Const(100)),
    ];
    let id = published(&mut host, &m);
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    refused(
        &mut host,
        &call(id, PLEDGE, &[5_000, 1], 0, T),
        ExtError::RequireFailed,
    );
    // Field overflow past its declared maximum.
    let mut m = watch_vow(AUTHOR_A);
    m.name = "overflow".into();
    m.entries[1].ops = vec![Op::Add(RENOWN, Operand::Const(1_001))];
    let id = published(&mut host, &m);
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    refused(
        &mut host,
        &call(id, FULFIL, &[], 0, T),
        ExtError::FieldBounds,
    );
}

#[test]
fn r11_the_description_warns_of_resources_that_never_return() {
    let s = describe(&wood_offering(AUTHOR_A));
    assert!(s.burns);
    assert!(s.lines.iter().any(|l| l.contains("never returned")));
    let mut m = watch_vow(AUTHOR_A);
    m.entries.truncate(1);
    let s = describe(&m);
    assert!(s.escrow_without_refund);
}
