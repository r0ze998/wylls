//! The required demonstration (task statement): author A makes a new
//! feature, user B reads its content and permissions, calls it under B's own
//! grant alone, and a third party checks the result. The feature is a new
//! state transition (a time lock and a renown counter the core does not
//! have). Example rules only, not adopted game rules.

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::describe::describe;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE, RENOWN, VOWS};
use wylls_ext_kernel::manifest::Manifest;
use wylls_ext_kernel::verify::{verify, Verdict};
use wylls_ext_kernel::ExtError;

#[test]
fn f01_author_publishes_user_grants_and_calls_third_party_verifies() {
    let mut host = world();
    let t = T0 + 10 * BELL;

    // 1. Author A publishes. Only bytes go to the registry; the id is
    //    their hash.
    let bytes = watch_vow(AUTHOR_A).encode();
    let id = host.registry.publish(&AUTHOR_A, &bytes, None, t).unwrap();

    // 2. User B reads what will run, from the published bytes alone.
    let m = Manifest::decode(&host.registry.get(&id).unwrap().bytes).unwrap();
    assert_eq!(m.id(), id);
    let s = describe(&m);
    let text = s.lines.join("\n");
    println!("--- what user B reads ---\n{text}\n---");
    assert!(text.contains("may take up to 20000 milli Wood per call"));
    assert!(text.contains("cannot: create resources"));
    assert!(text.contains("pay arg0 Wood from your holding into your escrow"));
    assert!(text.contains("refund field3 Wood from your escrow to your holding"));
    assert!(!s.burns && !s.escrow_without_refund);

    // 3. B grants this exact id, with B's wallet: up to 10,000 wood a call,
    //    15,000 in all.
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 15_000))
        .unwrap();

    let before = host.clone();
    // 4. B calls with B's own signature: pledge 10,000 milli wood for 6 bells.
    let r1 = host.call(&call(id, PLEDGE, &[10_000, 6], 0, t)).unwrap();
    assert_eq!(r1.holding_delta[Resource::Wood as usize], -10_000);
    assert_eq!(r1.escrow_delta[Resource::Wood as usize], 10_000);
    assert_eq!(wood(&host, &B_HOLDING, t), WOOD0 - 10_000);
    // Nobody else's holding moved.
    assert_eq!(wood(&host, &C_HOLDING, t), WOOD0);

    // Too early: the rules refuse and nothing is written.
    let snapshot = host.clone();
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, t + 5 * BELL)),
        Err(ExtError::RequireFailed)
    );
    assert_eq!(host.instances, snapshot.instances);
    assert_eq!(host.log.len(), snapshot.log.len());

    // The lock is over: wood back, renown up.
    let r2 = host.call(&call(id, FULFIL, &[], 1, t + 6 * BELL)).unwrap();
    assert_eq!(r2.prev_receipt, r1.id());
    assert_eq!(wood(&host, &B_HOLDING, t + 6 * BELL), WOOD0);
    let inst = &host.instances[&(id, B_CITIZEN)];
    assert_eq!(inst.fields[VOWS as usize], 1);
    assert_eq!(inst.fields[RENOWN as usize], 1);
    assert_eq!(inst.last_receipt, r2.id());
    // The grant's budget fell by what the call took.
    assert_eq!(
        host.grants[&(B_CITIZEN, id)].budget[Resource::Wood as usize],
        5_000
    );

    // 5. A third party replays from the evidence alone.
    let ev = evidence(&before, &host);
    let v = verify(&ev);
    assert_eq!(v, Verdict::Pass, "{v:?}");
}

#[test]
fn f02_the_same_inputs_give_the_same_receipts() {
    let run = || {
        let mut host = world();
        let t = T0 + 10 * BELL;
        let id = host
            .registry
            .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, t)
            .unwrap();
        host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 20_000, 40_000))
            .unwrap();
        let a = host.call(&call(id, PLEDGE, &[7_000, 3], 0, t)).unwrap();
        let b = host.call(&call(id, FULFIL, &[], 1, t + 3 * BELL)).unwrap();
        (a.id(), b.id(), host.instances.clone())
    };
    assert_eq!(run(), run());
}

#[test]
fn f03_core_resources_are_conserved_across_calls() {
    // Holding + escrow is constant for the vow (it never burns): the
    // extension cannot create or lose wood, only hold it.
    let mut host = world();
    let t = T0 + 10 * BELL;
    let id = host
        .registry
        .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, t)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 20_000, 1_000_000))
        .unwrap();
    let mut seq = 0;
    let mut now = t;
    for (amount, bells) in [(1_000, 1), (20_000, 144), (5_500, 2), (19_999, 7)] {
        host.call(&call(id, PLEDGE, &[amount, bells], seq, now))
            .unwrap();
        seq += 1;
        let esc = host.instances[&(id, B_CITIZEN)].escrow[Resource::Wood as usize];
        assert_eq!(wood(&host, &B_HOLDING, now) + esc, WOOD0);
        now += bells * BELL;
        host.call(&call(id, FULFIL, &[], seq, now)).unwrap();
        seq += 1;
        assert_eq!(wood(&host, &B_HOLDING, now), WOOD0);
    }
    assert_eq!(host.instances[&(id, B_CITIZEN)].fields[RENOWN as usize], 4);
}
