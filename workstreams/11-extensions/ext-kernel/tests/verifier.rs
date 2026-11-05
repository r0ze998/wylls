//! The third party's verdicts on forged, incomplete or unknown evidence.
//! A forged record FAILs; anything the verifier cannot judge is
//! UNVERIFIABLE; neither is ever a PASS.

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE};
use wylls_ext_kernel::host::Host;
use wylls_ext_kernel::manifest::id_of;
use wylls_ext_kernel::verify::{verify, Evidence, Verdict};

const T: i64 = T0 + 10 * BELL;

/// B pledges and fulfils; the evidence of both calls.
fn honest() -> (Host, Host, Evidence) {
    let mut host = world();
    let id = host
        .registry
        .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, T)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 20_000))
        .unwrap();
    let before = host.clone();
    host.call(&call(id, PLEDGE, &[6_000, 4], 0, T)).unwrap();
    host.call(&call(id, FULFIL, &[], 1, T + 4 * BELL)).unwrap();
    let ev = evidence(&before, &host);
    assert_eq!(verify(&ev), Verdict::Pass);
    (before, host, ev)
}

fn fails(ev: &Evidence, code: &str) {
    let v = verify(ev);
    assert!(v.fails_with(code), "want FAIL {code}, got {v:?}");
}

fn unverifiable(ev: &Evidence, code: &str) {
    let v = verify(ev);
    assert!(
        v.unverifiable_with(code),
        "want UNVERIFIABLE {code}, got {v:?}"
    );
}

#[test]
fn v01_a_forged_receipt_fails() {
    let (_, _, ev) = honest();
    // The receipt claims more wood came back than the rules give.
    let mut e = ev.clone();
    e.log[1].1.holding_delta[Resource::Wood as usize] += 1;
    fails(&e, "ReceiptMismatch");
    // An event that did not happen.
    let mut e = ev.clone();
    e.log[0].1.events.push(7);
    fails(&e, "ReceiptMismatch");
    // A receipt that does not describe its call.
    let mut e = ev.clone();
    e.log[0].1.args[0] = 1_000;
    fails(&e, "CallReceiptMismatch");
}

#[test]
fn v02_a_completion_that_did_not_happen_fails() {
    let (before, host, ev) = honest();
    // Someone writes a "fulfilled" record early (before the lock ends): the
    // rules refuse it on replay.
    let mut e = ev.clone();
    let (mut c, mut r) = e.log[1].clone();
    c.now_ts = T + BELL;
    r.now_ts = T + BELL;
    e.log[1] = (c, r);
    fails(&e, "RulesRefuse");
    // Dropping the fulfil record: the final state is not the replay's.
    let mut e = ev.clone();
    e.log.pop();
    fails(&e, "FinalStateMismatch");
    // Dropping the pledge: the fulfil's seq is ahead of the state.
    let mut e = ev.clone();
    e.log.remove(0);
    fails(&e, "SeqReplay");
    // A fulfil naming another predecessor: not on the chain.
    let mut e = ev.clone();
    e.log[1].1.prev_receipt[0] ^= 1;
    fails(&e, "ChainBreak");
    // The final state changed with no receipt at all.
    let mut e = evidence(&before, &before);
    let mut ia = before.instances.clone();
    ia.insert(
        *host.instances.keys().next().unwrap(),
        host.instances.values().next().unwrap().clone(),
    );
    e.instances_after = Some(ia);
    fails(&e, "UnexplainedWrite");
    // Different manifest bytes under the same id.
    let mut e = ev.clone();
    let id = e.log[0].1.manifest_id;
    e.manifests.get_mut(&id).unwrap().push(0);
    fails(&e, "ManifestHashMismatch");
}

#[test]
fn v03_what_the_verifier_does_not_know_is_never_a_pass() {
    let (_, _, ev) = honest();
    let id = ev.log[0].1.manifest_id;
    // No manifest bytes.
    let mut e = ev.clone();
    e.manifests.clear();
    unverifiable(&e, "MissingManifest");
    // A receipt of an effect set this verifier does not know.
    let mut e = ev.clone();
    e.log[0].1.effect_set = 2;
    unverifiable(&e, "UnknownEffectSet");
    // A receipt version it does not know.
    let mut e = ev.clone();
    e.log[0].1.receipt_version = 2;
    unverifiable(&e, "UnknownReceiptVersion");
    // Manifest bytes of a newer vocabulary (effect set 2 with an op 0x08
    // this verifier has never seen), under their own id.
    let mut m = watch_vow(AUTHOR_A);
    m.effect_set = 2;
    let bytes = m.encode();
    let new_id = id_of(&bytes);
    let mut e = ev.clone();
    e.manifests.insert(new_id, bytes);
    e.history.insert(new_id, e.history[&id].clone());
    for (c, r) in &mut e.log {
        c.manifest_id = new_id;
        r.manifest_id = new_id;
    }
    let rekey = |m: &mut std::collections::BTreeMap<_, _>| {
        let v = m.remove(&(id, B_CITIZEN)).unwrap();
        m.insert((new_id, B_CITIZEN), v);
    };
    rekey(e.instances_after.as_mut().unwrap());
    let rekey_grants = |m: &mut std::collections::BTreeMap<_, wylls_ext_kernel::grant::Grant>| {
        let mut g = m.remove(&(B_CITIZEN, id)).unwrap();
        g.manifest_id = new_id;
        m.insert((B_CITIZEN, new_id), g);
    };
    rekey_grants(&mut e.grants_before);
    rekey_grants(e.grants_after.as_mut().unwrap());
    unverifiable(&e, "UnknownManifestVocabulary");
    // No final state.
    let mut e = ev.clone();
    e.instances_after = None;
    unverifiable(&e, "MissingFinalState");
    // No core version.
    let mut e = ev.clone();
    e.core = None;
    unverifiable(&e, "MissingCoreVersion");
    // A Holding that changed with no extension receipt: the core
    // verifier's to judge, not a pass here.
    let mut e = ev.clone();
    let mut ha = e.holdings_after.clone().unwrap();
    ha.get_mut(&C_HOLDING)
        .unwrap()
        .holding
        .credit(T, Resource::Wood, 1)
        .unwrap();
    e.holdings_after = Some(ha);
    unverifiable(&e, "OutsideExtensions");
}

#[test]
fn v04_a_fail_outranks_an_unverifiable() {
    let (_, _, ev) = honest();
    let mut e = ev.clone();
    e.log[1].1.events.push(1);
    e.instances_after = None;
    assert!(matches!(verify(&e), Verdict::Fail(_)));
}
