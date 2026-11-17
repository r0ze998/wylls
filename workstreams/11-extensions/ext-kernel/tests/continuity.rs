//! A continuing world: extension state, grants and return obligations
//! across a period boundary and a restart. Host-tested only.
//!
//! The boundary below is a **test fixture**, not a definition of a period
//! (the shared core, workstreams 04 and 08, owns that). It models what a
//! boundary might do to the core around an extension: nothing, change the
//! rules, re-create a Holding under a new address, or leave the owner with
//! no Holding for a while. Whatever it does, the extension must keep the
//! owner's state and escrow, and every unit must stay recoverable.

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE, RENOWN, VOWS};
use wylls_ext_kernel::exec::{ExitReason, Key};
use wylls_ext_kernel::host::{HoldingAcct, Host};
use wylls_ext_kernel::manifest::ManifestId;
use wylls_ext_kernel::receipt::{Call, WITHDRAW};
use wylls_ext_kernel::verify::{verify, verify_windows, Verdict};
use wylls_ext_kernel::ExtError;

const T: i64 = T0 + 10 * BELL;
const W: usize = Resource::Wood as usize;
const NEW_HOLDING: Key = [0xB5; 32];

#[derive(Clone, Copy, Debug)]
enum Boundary {
    /// The world simply continues.
    Same,
    /// The core moves to other rules (a new ruleset hash).
    RulesChange,
    /// The owner's Holding is re-created under another address, its state
    /// carried over.
    Readdressed,
    /// The owner has no Holding until a later one is founded.
    HoldingGone,
}

fn cross(host: &mut Host, b: Boundary) {
    match b {
        Boundary::Same => {}
        Boundary::RulesChange => host.core.ruleset_hash[0] ^= 1,
        Boundary::Readdressed => {
            let h = host.holdings.remove(&B_HOLDING).unwrap();
            host.holdings.insert(NEW_HOLDING, h);
        }
        Boundary::HoldingGone => {
            host.holdings.remove(&B_HOLDING);
        }
    }
}

fn vow_world(budget: i64) -> (Host, ManifestId) {
    let mut host = world();
    let id = host
        .registry
        .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, T)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, budget))
        .unwrap();
    (host, id)
}

fn seq(host: &Host, id: &ManifestId) -> u64 {
    host.instances.get(&(*id, B_CITIZEN)).map_or(0, |i| i.seq)
}

fn escrow(host: &Host, id: &ManifestId) -> i64 {
    host.instances
        .get(&(*id, B_CITIZEN))
        .map_or(0, |i| i.escrow[W])
}

/// All wood of B's: every Holding B owns, plus B's escrow.
fn b_total(host: &Host, id: &ManifestId, now: i64) -> i64 {
    host.holdings
        .iter()
        .filter(|(_, h)| h.owner_citizen == B_CITIZEN)
        .map(|(_, h)| h.holding.stock_at(now)[W])
        .sum::<i64>()
        + escrow(host, id)
}

fn at(id: ManifestId, entry: u8, args: &[i64], seq: u64, now: i64, holding: Key) -> Call {
    Call {
        holding,
        ..call(id, entry, args, seq, now)
    }
}

#[test]
fn c01_the_world_continues_through_a_boundary() {
    let (mut host, id) = vow_world(30_000);
    let start = host.clone();
    let r1 = host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    let mid = host.clone();
    cross(&mut host, Boundary::Same);
    // After the boundary: the same instance, chain, grant and escrow.
    assert_eq!(host.instances[&(id, B_CITIZEN)].last_receipt, r1.id());
    assert_eq!(escrow(&host, &id), 8_000);
    let r2 = host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)).unwrap();
    assert_eq!(r2.prev_receipt, r1.id());
    assert_eq!(wood(&host, &B_HOLDING, T + 6 * BELL), WOOD0);
    let inst = &host.instances[&(id, B_CITIZEN)];
    assert_eq!(
        (
            inst.seq,
            inst.fields[VOWS as usize],
            inst.fields[RENOWN as usize]
        ),
        (2, 1, 1)
    );
    // The cost was counted once: 8,000 of a 30,000 budget.
    assert_eq!(host.grants[&(B_CITIZEN, id)].budget[W], 22_000);
    assert_eq!(host.grants[&(B_CITIZEN, id)].calls_left, 8);
    // One window per side of the boundary, chained; and the whole span.
    let windows = [evidence(&start, &mid), evidence(&mid, &host)];
    assert_eq!(verify_windows(&windows), Verdict::Pass);
    assert_eq!(verify(&evidence(&start, &host)), Verdict::Pass);
    // A second window that does not start where the first ended.
    let mut gap = windows.clone();
    gap[1].instances_before.clear();
    assert!(verify_windows(&gap).fails_with("WindowGap"));
    // A first window that does not say where it ended.
    gap = windows.clone();
    gap[0].instances_after = None;
    assert!(verify_windows(&gap).unverifiable_with("MissingFinalState"));
}

#[test]
fn c02_new_rules_open_the_exit_and_nothing_is_lost() {
    let (mut host, id) = vow_world(30_000);
    let start = host.clone();
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    let mid = host.clone();
    cross(&mut host, Boundary::RulesChange);
    // The manifest names the old rules: it no longer runs...
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)),
        Err(ExtError::CoreVersion)
    );
    // ...and the owner's exit is open, once.
    let r = host
        .withdraw(&call(id, WITHDRAW, &[], 1, T + 6 * BELL))
        .unwrap();
    assert_eq!(r.events, vec![ExitReason::CoreChanged as u8]);
    assert_eq!(b_total(&host, &id, T + 6 * BELL), WOOD0);
    assert_eq!(escrow(&host, &id), 0);
    assert_eq!(
        host.withdraw(&call(id, WITHDRAW, &[], 2, T + 7 * BELL)),
        Err(ExtError::InstanceClosed)
    );
    // Each window is judged against its own rules.
    let mut after = evidence(&mid, &host);
    after.core = Some(host.core);
    let windows = [evidence(&start, &mid), after];
    assert_eq!(
        verify_windows(&windows),
        Verdict::Pass,
        "{:?}",
        verify_windows(&windows)
    );
}

#[test]
fn c03_a_re_created_holding_still_receives_what_is_owed() {
    let (mut host, id) = vow_world(30_000);
    let start = host.clone();
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    let before_boundary = host.clone();
    cross(&mut host, Boundary::Readdressed);
    let after_boundary = host.clone();
    // The old address is gone; the owner names the new one.
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)),
        Err(ExtError::NotOwner)
    );
    host.call(&at(id, FULFIL, &[], 1, T + 6 * BELL, NEW_HOLDING))
        .unwrap();
    assert_eq!(wood(&host, &NEW_HOLDING, T + 6 * BELL), WOOD0);
    assert_eq!(b_total(&host, &id, T + 6 * BELL), WOOD0);
    // The re-creation itself is the core's to judge: not a pass here, and
    // not an accusation either.
    let windows = [
        evidence(&start, &before_boundary),
        evidence(&after_boundary, &host),
    ];
    let v = verify_windows(&windows);
    assert!(v.unverifiable_with("OutsideExtensions"), "{v:?}");
}

#[test]
fn c04_an_obligation_waits_for_the_owner_however_long() {
    let (mut host, id) = vow_world(30_000);
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    cross(&mut host, Boundary::HoldingGone);
    // No Holding of B's: nothing can be paid out, and nothing is lost.
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)),
        Err(ExtError::NotOwner)
    );
    assert_eq!(escrow(&host, &id), 8_000);
    // Thirty years later (the grant long expired), a new Holding: the exit
    // is open because the grant ended, and pays into it.
    let later = T + 30 * 365 * 24 * 3600;
    host.holdings.insert(
        NEW_HOLDING,
        HoldingAcct {
            owner_citizen: B_CITIZEN,
            holding: {
                let mut h = permutation_rules::frontier::holding::Holding::found(later, 1, 1);
                h.credit(later, Resource::Wood, 0).unwrap();
                h
            },
        },
    );
    assert_eq!(
        host.call(&at(id, FULFIL, &[], 1, later, NEW_HOLDING)),
        Err(ExtError::GrantExpired)
    );
    let r = host
        .withdraw(&at(id, WITHDRAW, &[], 1, later, NEW_HOLDING))
        .unwrap();
    assert_eq!(r.events, vec![ExitReason::GrantEnded as u8]);
    assert_eq!(wood(&host, &NEW_HOLDING, later), 8_000);
}

#[test]
fn c05_an_extensions_own_deadline_is_not_the_worlds() {
    let (mut host, id) = vow_world(30_000);
    let expires = host.grants[&(B_CITIZEN, id)].expires_ts;
    host.call(&call(id, PLEDGE, &[2_000, 1], 0, T)).unwrap();
    // A boundary changes no grant and no registration.
    let g = host.grants.clone();
    let reg = host.registry.get(&id).unwrap().history.clone();
    cross(&mut host, Boundary::Same);
    assert_eq!(host.grants, g);
    assert_eq!(host.registry.get(&id).unwrap().history, reg);
    // The grant runs until its own expiry, across the boundary...
    host.call(&call(id, FULFIL, &[], 1, expires - 1)).unwrap();
    // ...and ends there, whether or not any boundary happened.
    assert_eq!(
        host.call(&call(id, PLEDGE, &[2_000, 1], 2, expires)),
        Err(ExtError::GrantExpired)
    );
}

/// A runner sends calls, and after some of them the process stops between
/// the chain's commit and its own note of it; after reloading it sends the
/// same call again. Every call takes effect once.
#[test]
fn c06_a_restart_does_not_run_anything_twice() {
    let (mut host, id) = vow_world(1_000_000);
    let mut g = host.grants[&(B_CITIZEN, id)].clone();
    g.calls_left = 1_000;
    host.set_grant(&B_WALLET, g).unwrap();
    let start = host.clone();
    let mut now = T;
    let mut accepted = 0u64;
    let mut retried = 0;
    for step in 0..40u64 {
        let s = seq(&host, &id);
        let c = if step % 2 == 0 {
            call(id, PLEDGE, &[1_000, 1], s, now)
        } else {
            now += BELL;
            call(id, FULFIL, &[], s, now)
        };
        let r = host.call(&c).unwrap();
        accepted += 1;
        if step % 3 == 0 {
            // The process restarts: state is reloaded from what the chain
            // kept, and the runner, not knowing, sends the call again.
            let reloaded = host.clone();
            host = reloaded;
            assert_eq!(host.call(&c), Err(ExtError::SeqMismatch));
            // It can tell the call is done: the chain head is its receipt.
            assert_eq!(host.instances[&(id, B_CITIZEN)].last_receipt, r.id());
            retried += 1;
        }
    }
    assert_eq!(host.log.len() as u64, accepted);
    assert_eq!(seq(&host, &id), accepted);
    let g = &host.grants[&(B_CITIZEN, id)];
    assert_eq!(g.calls_left as u64, 1_000 - accepted);
    // Cost counted once per accepted pledge: 20 pledges of 1,000.
    assert_eq!(g.budget[W], 1_000_000 - 20 * 1_000);
    assert_eq!(b_total(&host, &id, now), WOOD0);
    assert_eq!(verify(&evidence(&start, &host)), Verdict::Pass);
    // A resent call meets the same answer even after the grant ended or
    // the extension stopped.
    let last = host.log.last().unwrap().0.clone();
    let mut g = host.grants[&(B_CITIZEN, id)].clone();
    g.revoked = true;
    host.set_grant(&B_WALLET, g).unwrap();
    assert_eq!(host.call(&last), Err(ExtError::SeqMismatch));
    host.registry
        .set_status(
            &AUTHOR_A,
            &id,
            wylls_ext_kernel::registry::Status::Paused,
            now,
        )
        .unwrap();
    assert_eq!(host.call(&last), Err(ExtError::SeqMismatch));
    println!("c06: {accepted} calls, {retried} restarts with a resent call, each applied once");
}
