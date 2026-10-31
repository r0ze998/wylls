//! Long operation, separately from crossing a boundary: state that keeps
//! growing must stay bounded or verifiable in pieces, and time, sequence
//! numbers and counters must not wrap. Host-tested only.

mod common;

use std::time::Instant;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE, RENOWN};
use wylls_ext_kernel::host::Host;
use wylls_ext_kernel::manifest::ManifestId;
use wylls_ext_kernel::receipt::{Call, WITHDRAW};
use wylls_ext_kernel::verify::{verify_windows, Verdict};
use wylls_ext_kernel::ExtError;

const W: usize = Resource::Wood as usize;

fn vow_world(t: i64, max_instances: u32) -> (Host, ManifestId) {
    let mut host = world();
    let mut m = watch_vow(AUTHOR_A);
    m.max_instances = max_instances;
    // Counters sized for a long run (the example's 1,000 is its own limit,
    // g02).
    m.fields[wylls_ext_kernel::examples::VOWS as usize].max = 1_000_000;
    m.fields[RENOWN as usize].max = 1_000_000;
    let id = host
        .registry
        .publish(&AUTHOR_A, &m.encode(), None, t)
        .unwrap();
    let mut g = grant(B_CITIZEN, id, 20_000, i64::MAX / 2);
    g.calls_left = u32::MAX;
    g.expires_ts = i64::MAX;
    host.set_grant(&B_WALLET, g).unwrap();
    (host, id)
}

/// 20,000 calls over about 140 days, verified as 10 chained windows of
/// 2,000 records each; the per-owner state does not grow.
#[test]
fn g01_twenty_thousand_calls_verify_window_by_window() {
    let t = T0 + 10 * BELL;
    let (mut host, id) = vow_world(t, 3);
    let mut snaps = vec![host.clone()];
    let start = Instant::now();
    let mut now = t;
    for i in 0..10_000u64 {
        host.call(&call(id, PLEDGE, &[1_000, 1], 2 * i, now))
            .unwrap_or_else(|e| {
                panic!(
                    "pledge {i}: {e:?} {:?}",
                    host.instances.get(&(id, B_CITIZEN))
                )
            });
        now += BELL;
        host.call(&call(id, FULFIL, &[], 2 * i + 1, now)).unwrap();
        if host.log.len() % 2_000 == 0 {
            snaps.push(host.clone());
        }
    }
    let run = start.elapsed();
    let inst = &host.instances[&(id, B_CITIZEN)];
    assert_eq!(inst.seq, 20_000);
    assert_eq!(inst.fields.len(), 4);
    assert_eq!(inst.fields[RENOWN as usize], 10_000);
    assert_eq!(wood(&host, &B_HOLDING, now), WOOD0);
    // What grows with time is the log alone; registry history and grant
    // updates grow only when someone changes them.
    assert_eq!(host.registry.get(&id).unwrap().history.len(), 1);
    assert_eq!(host.grant_log.len(), 1);
    let windows: Vec<_> = snaps.windows(2).map(|w| evidence(&w[0], &w[1])).collect();
    assert_eq!(windows.len(), 10);
    assert!(windows.iter().all(|w| w.log.len() == 2_000));
    let start = Instant::now();
    assert_eq!(verify_windows(&windows), Verdict::Pass);
    println!(
        "g01: 20,000 calls in {run:?}, 10 windows of 2,000 records verified in {:?}",
        start.elapsed()
    );
}

/// A counter's declared maximum is the extension's own limit, not the
/// world's: once renown is full, fulfil refuses (the whole call, refund
/// included), and the owner still gets the escrow back by ending the grant.
#[test]
fn g02_a_full_counter_does_not_trap_the_escrow() {
    let t = T0 + 10 * BELL;
    let (mut host, id) = vow_world(t, 3);
    host.call(&call(id, PLEDGE, &[5_000, 1], 0, t)).unwrap();
    host.instances.get_mut(&(id, B_CITIZEN)).unwrap().fields[RENOWN as usize] = 1_000_000;
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, t + BELL)),
        Err(ExtError::FieldBounds)
    );
    let mut g = host.grants[&(B_CITIZEN, id)].clone();
    g.revoked = true;
    host.set_grant(&B_WALLET, g).unwrap();
    host.withdraw(&call(id, WITHDRAW, &[], 1, t + BELL))
        .unwrap();
    assert_eq!(wood(&host, &B_HOLDING, t + BELL), WOOD0);
}

/// Time, sequence numbers and counters near their limits refuse instead
/// of wrapping, and leave nothing changed.
#[test]
fn g03_limits_refuse_instead_of_wrapping() {
    // The year 3000 and a time of i64::MAX / 4: still ordinary calls.
    for t in [32_503_680_000i64, i64::MAX / 4] {
        let (mut host, id) = vow_world(T0, 3);
        host.call(&call(id, PLEDGE, &[5_000, 144], 0, t)).unwrap();
        host.call(&call(id, FULFIL, &[], 1, t + 144 * BELL))
            .unwrap();
        assert_eq!(wood(&host, &B_HOLDING, t + 144 * BELL), WOOD0, "t = {t}");
    }
    // A sequence number at its end.
    let (mut host, id) = vow_world(T0, 3);
    host.call(&call(id, PLEDGE, &[5_000, 1], 0, T0)).unwrap();
    host.instances.get_mut(&(id, B_CITIZEN)).unwrap().seq = u64::MAX;
    let before = host.clone();
    assert_eq!(
        host.call(&call(id, FULFIL, &[], u64::MAX, T0 + BELL)),
        Err(ExtError::Overflow)
    );
    assert_eq!(host.instances, before.instances);
    assert_eq!(host.log.len(), before.log.len());
    // A manifest whose lock field ends at bell 100,000,000 (about the year
    // 3871): its declared range is its own horizon. Past it the pledge is
    // refused whole, before any wood moves.
    let mut host = world();
    let mut m = watch_vow(AUTHOR_A);
    m.fields[wylls_ext_kernel::examples::UNTIL_BELL as usize].max = 100_000_000;
    let id = host
        .registry
        .publish(&AUTHOR_A, &m.encode(), None, T0)
        .unwrap();
    let mut g = grant(B_CITIZEN, id, 20_000, 20_000);
    g.expires_ts = i64::MAX;
    host.set_grant(&B_WALLET, g).unwrap();
    let far = 100_000_000 * BELL;
    assert_eq!(
        host.call(&call(id, PLEDGE, &[5_000, 144], 0, far)),
        Err(ExtError::FieldBounds)
    );
    assert!(host.instances.is_empty());
    assert_eq!(wood(&host, &B_HOLDING, far), WOOD0);
}

/// Many owners: the extension's state is bounded by what its manifest
/// declares (`max_instances`), whatever the number of users who try.
#[test]
fn g04_state_is_bounded_by_the_declared_number_of_owners() {
    let t = T0 + 10 * BELL;
    let (mut host, id) = vow_world(t, 2_000);
    for n in 0..2_001u32 {
        let k = |tag: u8| {
            let mut x = [tag; 32];
            x[..4].copy_from_slice(&n.to_le_bytes());
            x
        };
        let (citizen, wallet, holding) = (k(0x51), k(0x52), k(0x53));
        add_user(&mut host, citizen, wallet, [0; 32], holding);
        host.set_grant(&wallet, grant(citizen, id, 20_000, 20_000))
            .unwrap();
        let c = Call {
            citizen,
            holding,
            signer: wallet,
            ..call(id, PLEDGE, &[1_000, 1], 0, t)
        };
        let r = host.call(&c);
        if n < 2_000 {
            r.unwrap();
        } else {
            assert_eq!(r, Err(ExtError::InstanceCap));
        }
    }
    assert_eq!(host.instances.len(), 2_000);
    assert_eq!(host.created[&id], 2_000);
    let escrowed: i64 = host.instances.values().map(|i| i.escrow[W]).sum();
    assert_eq!(escrowed, 2_000 * 1_000);
}
