//! No altered, incomplete or unknown evidence is a PASS. One honest history
//! (pledge, fulfil, pledge, pause, the user's grant revoked, the exit) is
//! verified, then every mutation below must come out FAIL or UNVERIFIABLE.
//! Host-tested: the verifier's own logic, not an archive read from a chain.

mod common;

use std::collections::BTreeMap;

use common::*;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE};
use wylls_ext_kernel::receipt::WITHDRAW;
use wylls_ext_kernel::registry::Status;
use wylls_ext_kernel::verify::{verify, Evidence, Verdict};

const T: i64 = T0 + 10 * BELL;

/// H1: the exit opens because the author paused (no grant change).
/// H2: the exit opens because the user revoked the user's own grant (no
/// pause). Each history leans on a different part of the evidence.
fn honest(revoke_instead_of_pause: bool) -> Evidence {
    let mut host = world();
    let id = host
        .registry
        .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, T)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 30_000))
        .unwrap();
    let before = host.clone();
    host.call(&call(id, PLEDGE, &[6_000, 2], 0, T)).unwrap();
    host.call(&call(id, FULFIL, &[], 1, T + 2 * BELL)).unwrap();
    host.call(&call(id, PLEDGE, &[9_000, 5], 2, T + 3 * BELL))
        .unwrap();
    if revoke_instead_of_pause {
        let mut g = host.grants[&(B_CITIZEN, id)].clone();
        g.revoked = true;
        host.set_grant(&B_WALLET, g).unwrap();
    } else {
        host.registry
            .set_status(&AUTHOR_A, &id, Status::Paused, T + 4 * BELL)
            .unwrap();
    }
    host.withdraw(&call(id, WITHDRAW, &[], 3, T + 5 * BELL))
        .unwrap();
    let ev = evidence(&before, &host);
    assert_eq!(verify(&ev), Verdict::Pass);
    ev
}

type Edit = Box<dyn Fn(&mut Evidence)>;
type Mutation = (String, Edit);

fn mutations(ev: &Evidence) -> Vec<Mutation> {
    let mut m: Vec<Mutation> = Vec::new();
    let n = ev.log.len();
    let mut add = |name: String, f: Box<dyn Fn(&mut Evidence)>| m.push((name, f));
    // The records themselves.
    for i in 0..n {
        add(
            format!("drop #{i}"),
            Box::new(move |e| {
                e.log.remove(i);
            }),
        );
        add(
            format!("repeat #{i}"),
            Box::new(move |e| {
                let x = e.log[i].clone();
                e.log.insert(i + 1, x);
            }),
        );
        if i + 1 < n {
            add(
                format!("swap #{i}"),
                Box::new(move |e| e.log.swap(i, i + 1)),
            );
        }
        add(
            format!("#{i} receipt_version"),
            Box::new(move |e| e.log[i].1.receipt_version += 1),
        );
        add(
            format!("#{i} effect_set"),
            Box::new(move |e| e.log[i].1.effect_set += 1),
        );
        add(
            format!("#{i} entry"),
            Box::new(move |e| {
                e.log[i].0.entry ^= 1;
                e.log[i].1.entry ^= 1;
            }),
        );
        add(
            format!("#{i} seq"),
            Box::new(move |e| {
                e.log[i].0.seq += 1;
                e.log[i].1.seq += 1;
            }),
        );
        add(
            format!("#{i} time"),
            Box::new(move |e| {
                e.log[i].0.now_ts += 1;
                e.log[i].1.now_ts += 1;
            }),
        );
        add(
            format!("#{i} call time only"),
            Box::new(move |e| e.log[i].0.now_ts += 1),
        );
        add(
            format!("#{i} signer"),
            Box::new(move |e| e.log[i].0.signer = C_WALLET),
        );
        add(
            format!("#{i} citizen"),
            Box::new(move |e| {
                e.log[i].0.citizen = C_CITIZEN;
                e.log[i].1.citizen = C_CITIZEN;
            }),
        );
        add(
            format!("#{i} holding"),
            Box::new(move |e| {
                e.log[i].0.holding = C_HOLDING;
                e.log[i].1.holding = C_HOLDING;
            }),
        );
        add(
            format!("#{i} args"),
            Box::new(move |e| {
                e.log[i].0.args.push(1);
                e.log[i].1.args.push(1);
            }),
        );
        if !ev.log[i].1.args.is_empty() {
            add(
                format!("#{i} arg0"),
                Box::new(move |e| {
                    e.log[i].0.args[0] += 1_000;
                    e.log[i].1.args[0] += 1_000;
                }),
            );
        }
        add(
            format!("#{i} pre_state"),
            Box::new(move |e| e.log[i].1.pre_state[0] ^= 1),
        );
        add(
            format!("#{i} post_state"),
            Box::new(move |e| e.log[i].1.post_state[0] ^= 1),
        );
        add(
            format!("#{i} prev_receipt"),
            Box::new(move |e| e.log[i].1.prev_receipt[0] ^= 1),
        );
        add(
            format!("#{i} event added"),
            Box::new(move |e| e.log[i].1.events.push(0)),
        );
        add(
            format!("#{i} events cleared"),
            Box::new(move |e| e.log[i].1.events.clear()),
        );
        for r in 0..8 {
            add(
                format!("#{i} holding_delta[{r}]"),
                Box::new(move |e| e.log[i].1.holding_delta[r] += 1),
            );
            add(
                format!("#{i} escrow_delta[{r}]"),
                Box::new(move |e| e.log[i].1.escrow_delta[r] += 1),
            );
            add(
                format!("#{i} burned[{r}]"),
                Box::new(move |e| e.log[i].1.burned[r] += 1),
            );
        }
    }
    // What the verifier is given besides the records.
    add("no core version".into(), Box::new(|e| e.core = None));
    add(
        "other core version".into(),
        Box::new(|e| {
            if let Some(c) = e.core.as_mut() {
                c.program_version += 1
            }
        }),
    );
    add("no manifests".into(), Box::new(|e| e.manifests.clear()));
    add("no history".into(), Box::new(|e| e.history.clear()));
    add(
        "history: never paused".into(),
        Box::new(|e| {
            for h in e.history.values_mut() {
                h.truncate(1);
            }
        }),
    );
    add(
        "history: paused from the start".into(),
        Box::new(|e| {
            for h in e.history.values_mut() {
                h.insert(1, (T, Status::Paused));
            }
        }),
    );
    add("no citizens".into(), Box::new(|e| e.citizens.clear()));
    add(
        "no holdings before".into(),
        Box::new(|e| e.holdings_before.clear()),
    );
    add(
        "other holding before".into(),
        Box::new(|e| {
            let h = holding_with_wood(WOOD0 - 1);
            e.holdings_before.get_mut(&B_HOLDING).unwrap().holding = h;
        }),
    );
    add(
        "no grants before".into(),
        Box::new(|e| e.grants_before.clear()),
    );
    add("no grant updates".into(), Box::new(|e| e.grant_log.clear()));
    add(
        "grant update too late".into(),
        Box::new(|e| {
            for g in e.grant_log.iter_mut() {
                g.0 += 1;
            }
        }),
    );
    add(
        "instance cap used up".into(),
        Box::new(|e| {
            let ids: Vec<_> = e.manifests.keys().copied().collect();
            e.created_before = ids.into_iter().map(|k| (k, 3)).collect::<BTreeMap<_, _>>();
        }),
    );
    add(
        "an instance before".into(),
        Box::new(|e| {
            let k = (e.log[0].1.manifest_id, B_CITIZEN);
            let i = e.instances_after.as_ref().unwrap()[&k].clone();
            e.instances_before.insert(k, i);
        }),
    );
    add(
        "no instances after".into(),
        Box::new(|e| e.instances_after = None),
    );
    add(
        "no holdings after".into(),
        Box::new(|e| e.holdings_after = None),
    );
    add(
        "instance after edited".into(),
        Box::new(|e| {
            for i in e.instances_after.as_mut().unwrap().values_mut() {
                i.fields[2] += 1;
            }
        }),
    );
    add(
        "instance after reopened".into(),
        Box::new(|e| {
            for i in e.instances_after.as_mut().unwrap().values_mut() {
                i.closed = false;
            }
        }),
    );
    add(
        "holding after edited".into(),
        Box::new(|e| {
            let h = holding_with_wood(WOOD0 + 1);
            e.holdings_after
                .as_mut()
                .unwrap()
                .get_mut(&B_HOLDING)
                .unwrap()
                .holding = h;
        }),
    );
    add(
        "someone else's holding after edited".into(),
        Box::new(|e| {
            let h = holding_with_wood(WOOD0 + 1);
            e.holdings_after
                .as_mut()
                .unwrap()
                .get_mut(&C_HOLDING)
                .unwrap()
                .holding = h;
        }),
    );
    // Every byte of the published manifest.
    let len = ev.manifests.values().next().unwrap().len();
    for b in 0..len {
        add(
            format!("manifest byte {b}"),
            Box::new(move |e| {
                for v in e.manifests.values_mut() {
                    v[b] ^= 0x01;
                }
            }),
        );
    }
    m
}

#[test]
fn n01_no_mutation_of_the_evidence_is_a_pass() {
    let mut total = 0;
    for (h, ev) in [("H1", honest(false)), ("H2", honest(true))] {
        let ms = mutations(&ev);
        let base = format!("{ev:?}");
        let (mut fails, mut unver, mut same) = (0, 0, 0);
        let mut by_code: BTreeMap<&'static str, usize> = BTreeMap::new();
        for (name, f) in &ms {
            let mut e = ev.clone();
            f(&mut e);
            // A mutation with nothing to change in this history (e.g. no
            // grant update to move in H1) is the honest evidence itself.
            if format!("{e:?}") == base {
                same += 1;
                continue;
            }
            match verify(&e) {
                Verdict::Pass => panic!("{h} {name}: PASS"),
                Verdict::Fail(x) => {
                    fails += 1;
                    *by_code.entry(x[0].code).or_default() += 1;
                }
                Verdict::Unverifiable(x) => {
                    unver += 1;
                    *by_code.entry(x[0].code).or_default() += 1;
                }
            }
        }
        total += fails + unver;
        println!(
            "n01 {h}: {} mutations ({same} change nothing here), {fails} FAIL, {unver} UNVERIFIABLE, 0 PASS; first finding by code: {by_code:?}",
            ms.len()
        );
    }
    assert!(total > 1_000);
}

#[test]
fn n02_unknown_or_missing_is_unverifiable_not_fail() {
    // What the verifier cannot know must be said as such (not a false
    // accusation): each of these alone is UNVERIFIABLE.
    for ev in [honest(false), honest(true)] {
        let cases: Vec<(&str, Edit, &str)> = vec![
            (
                "no core version",
                Box::new(|e| e.core = None),
                "MissingCoreVersion",
            ),
            (
                "no manifests",
                Box::new(|e| e.manifests.clear()),
                "MissingManifest",
            ),
            (
                "unknown receipt version",
                Box::new(|e| e.log[0].1.receipt_version = 9),
                "UnknownReceiptVersion",
            ),
            (
                "unknown effect set",
                Box::new(|e| e.log[0].1.effect_set = 9),
                "UnknownEffectSet",
            ),
            (
                "no citizens",
                Box::new(|e| e.citizens.clear()),
                "MissingCitizen",
            ),
            (
                "no holdings before",
                Box::new(|e| e.holdings_before.clear()),
                "MissingHolding",
            ),
            (
                "no instances after",
                Box::new(|e| e.instances_after = None),
                "MissingFinalState",
            ),
            (
                "no holdings after",
                Box::new(|e| e.holdings_after = None),
                "MissingFinalState",
            ),
        ];
        for (name, f, code) in cases {
            let mut e = ev.clone();
            f(&mut e);
            let v = verify(&e);
            assert!(v.unverifiable_with(code), "{name}: {v:?}");
        }
    }
}
