//! Contract tests against vectors produced by workstream 06's own code at
//! `517796dc` (`vectors/gen.mjs`): 11 must read what 06 publishes exactly as
//! 06 does, refuse what 06 would refuse, and never treat 06's publication
//! status as 11's execution status.

use serde_json::{json, Value};
use wylls_creation_bridge::canonical::{canonicalize, content_hash};
use wylls_creation_bridge::envelope::{verify, verify_envelope, PUBLISH, STATUS};
use wylls_creation_bridge::map::{
    author_key, creation_to_eleven, eleven_to_creation, goods_milli, int_param,
};
use wylls_creation_bridge::registry::{
    verify_status_change, CreationRegistry, PinnedRef, PublicationStatus,
};
use wylls_creation_bridge::BridgeError;
use wylls_ext_kernel::manifest::ArgSpec;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../vectors/creation-vectors.json")).unwrap()
}

const FRONT: &str = "ok/front-supply.json";
const MINE: &str = "ok/mine-delivery.json";

#[test]
fn k01_the_vectors_are_06s_at_517796dc() {
    let v = vectors();
    assert_eq!(
        v["source"]["commit"],
        "517796dce6dec5c1496775d73ad84a0cb8befa09"
    );
    assert_eq!(v["domains"]["publish"], PUBLISH);
    assert_eq!(v["domains"]["status"], STATUS);
}

#[test]
fn k02_canonical_form_and_hash_match_06() {
    let v = vectors();
    for c in v["canonical"].as_array().unwrap() {
        let value: Value = serde_json::from_str(c["json"].as_str().unwrap()).unwrap();
        assert_eq!(
            canonicalize(&value).unwrap(),
            c["canonical"].as_str().unwrap()
        );
        assert_eq!(content_hash(&value).unwrap(), c["hash"].as_str().unwrap());
    }
    for (f, m) in v["manifests"].as_object().unwrap() {
        assert_eq!(
            canonicalize(&m["manifest"]).unwrap(),
            m["canonical"].as_str().unwrap(),
            "{f}"
        );
        assert_eq!(
            content_hash(&m["manifest"]).unwrap(),
            m["hash"].as_str().unwrap(),
            "{f}"
        );
    }
    // What 06 refuses, 11 refuses.
    for r in v["refused"].as_array().unwrap() {
        assert_eq!(r["error"], "CanonicalError");
        let value: Value = serde_json::from_str(r["json"].as_str().unwrap()).unwrap();
        assert!(
            matches!(canonicalize(&value), Err(BridgeError::NotSafeInteger(_))),
            "{r}"
        );
    }
    // Depth: 06 refuses more than 32 levels.
    let mut deep = json!(1);
    for _ in 0..33 {
        deep = json!([deep]);
    }
    assert_eq!(canonicalize(&deep), Err(BridgeError::TooDeep));
}

#[test]
fn k03_envelopes_verify_and_tampering_does_not() {
    let v = vectors();
    for f in [FRONT, MINE] {
        let env = &v["envelopes"][f];
        let p = verify_envelope(env).unwrap();
        assert_eq!(p.hash, v["manifests"][f]["hash"].as_str().unwrap());
        assert_eq!(p.author, env["manifest"]["author"].as_str().unwrap());

        // The content changed, the claimed hash kept.
        let mut e = env.clone();
        e["manifest"]["title"] = json!("x");
        assert!(matches!(
            verify_envelope(&e),
            Err(BridgeError::HashMismatch { .. })
        ));
        // The content and the hash changed together, the signature kept.
        e["hash"] = json!(content_hash(&e["manifest"]).unwrap());
        assert_eq!(verify_envelope(&e), Err(BridgeError::SignatureInvalid));
        // Another author named in the manifest.
        let mut e = env.clone();
        e["manifest"]["author"] = v["pubs"]["B"].clone();
        e["hash"] = json!(content_hash(&e["manifest"]).unwrap());
        assert_eq!(verify_envelope(&e), Err(BridgeError::SignatureInvalid));
        // One signature byte flipped.
        let mut e = env.clone();
        let s = e["signature"].as_str().unwrap();
        let flipped = format!("{}{}", if &s[..1] == "0" { "1" } else { "0" }, &s[1..]);
        e["signature"] = json!(flipped);
        assert_eq!(verify_envelope(&e), Err(BridgeError::SignatureInvalid));
        // Domains are separate: a publication signature is not a status one.
        let author = env["manifest"]["author"].as_str().unwrap();
        let (hash, sig) = (
            env["hash"].as_str().unwrap(),
            env["signature"].as_str().unwrap(),
        );
        assert!(verify(author, PUBLISH, hash, sig));
        assert!(!verify(author, STATUS, hash, sig));
    }
}

#[test]
fn k04_the_registry_reads_as_06_left_it() {
    let v = vectors();
    let r = CreationRegistry::from_json(&v["registry"]).unwrap();
    let st = |name: &str| r.entries.values().find(|e| e.name == name).unwrap().status;
    assert_eq!(st("front-supply"), PublicationStatus::Withdrawn);
    assert_eq!(st("mine-delivery"), PublicationStatus::Listed);
}

fn pin(v: &Value, f: &str) -> PinnedRef {
    let m = &v["envelopes"][f]["manifest"];
    PinnedRef {
        author: m["author"].as_str().unwrap().into(),
        name: m["name"].as_str().unwrap().into(),
        version: m["version"].as_str().unwrap().into(),
        hash: v["envelopes"][f]["hash"].as_str().unwrap().into(),
    }
}

#[test]
fn k05_a_pin_resolves_with_06s_meaning_of_status() {
    let v = vectors();
    let r = CreationRegistry::from_json(&v["registry"]).unwrap();
    // Withdrawn by its author: no new adoption, the adopted plan still runs
    // (06 docs/05 §2: ENTRY_NOT_LISTED / ENTRY_DELISTED_PINNED).
    let a = r.resolve(&pin(&v, FRONT)).unwrap();
    assert_eq!(a.status, PublicationStatus::Withdrawn);
    assert!(!a.may_adopt_anew && a.adopted_plan_runs);
    let m = r.resolve(&pin(&v, MINE)).unwrap();
    assert!(m.may_adopt_anew && m.adopted_plan_runs);
    // Another hash than the one published under that version.
    let mut p = pin(&v, MINE);
    p.hash = "0".repeat(64);
    assert!(matches!(
        r.resolve(&p),
        Err(BridgeError::PinMismatch { .. })
    ));
    // A version or a name 06 never published.
    let mut p = pin(&v, MINE);
    p.version = "9.9.9".into();
    assert_eq!(r.resolve(&p), Err(BridgeError::NotFound));
    let mut p = pin(&v, MINE);
    p.name = "nothing".into();
    assert_eq!(r.resolve(&p), Err(BridgeError::NotFound));
}

fn entry_key(v: &Value, name: &str) -> String {
    v["registry"]["entries"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, e)| e["name"] == name)
        .unwrap()
        .0
        .clone()
}

#[test]
fn k06_an_inconsistent_export_is_refused() {
    let v = vectors();
    let k = entry_key(&v, "mine-delivery");
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut reg = v["registry"].clone();
        f(&mut reg["entries"][&k]);
        CreationRegistry::from_json(&reg)
    };
    let log_err =
        |r: Result<CreationRegistry, BridgeError>| matches!(r, Err(BridgeError::StatusLog(_)));
    // The entry's status is not the log's last.
    assert!(log_err(edit(&|e| e["status"] = json!("suspended"))));
    // A status change at the wrong position (a replayed or dropped one).
    assert!(log_err(edit(&|e| e["statusLog"][2]["seq"] = json!(1))));
    assert!(log_err(edit(&|e| {
        e["statusLog"].as_array_mut().unwrap().remove(1);
    })));
    // A version without its publication item.
    assert!(log_err(edit(&|e| {
        e["statusLog"].as_array_mut().unwrap().remove(0);
    })));
    // A version's envelope altered inside the export.
    assert!(matches!(
        edit(&|e| e["versions"]["1.0.0"]["manifest"]["title"] = json!("x")),
        Err(BridgeError::HashMismatch { .. })
    ));
    // An entry filed under another author's key.
    let mut reg = v["registry"].clone();
    let e = reg["entries"].as_object_mut().unwrap().remove(&k).unwrap();
    reg["entries"][format!("{}/mine-delivery", v["pubs"]["B"].as_str().unwrap())] = e;
    assert!(matches!(
        CreationRegistry::from_json(&reg),
        Err(BridgeError::Shape(_))
    ));
}

#[test]
fn k07_status_signatures_verify_only_as_signed() {
    let v = vectors();
    for s in v["statusSignatures"].as_array().unwrap() {
        let (a, n, st, seq, sig) = (
            s["author"].as_str().unwrap(),
            s["name"].as_str().unwrap(),
            s["status"].as_str().unwrap(),
            s["seq"].as_u64().unwrap(),
            s["signature"].as_str().unwrap(),
        );
        assert!(verify_status_change(a, n, st, seq, sig).unwrap(), "{s}");
        // Replayed at another position, or for another status.
        assert!(!verify_status_change(a, n, st, seq + 1, sig).unwrap());
        let other = if st == "listed" {
            "withdrawn"
        } else {
            "listed"
        };
        assert!(!verify_status_change(a, n, other, seq, sig).unwrap());
    }
}

#[test]
fn k08_only_same_meaning_fields_map() {
    let v = vectors();
    let m = &v["manifests"][MINE]["manifest"];
    let r = creation_to_eleven(m).unwrap();
    // The author is the same key, byte for byte.
    let pubm = v["pubs"]["M"].as_str().unwrap();
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&pubm[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    assert_eq!(r.author.to_vec(), bytes);
    assert_eq!(r.author, author_key(m).unwrap());
    // Int params with 06's bounds; everything else refused by name.
    for (name, a, d) in &r.args {
        let p = &m["params"][name];
        assert_eq!(p["type"], "int");
        assert_eq!(a.min, p["min"].as_i64().unwrap_or(0));
        assert_eq!(a.max, p["max"].as_i64().unwrap_or(9_007_199_254_740_991));
        assert_eq!(*d, p["default"].as_i64());
    }
    let refused: Vec<String> = r
        .refused
        .iter()
        .map(|e| match e {
            BridgeError::NotMappable { field, .. } => field.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert!(refused.iter().any(|f| f.starts_with("steps[")));
    assert!(refused.iter().any(|f| f == "limits.runsPerDay"));
    for (k, p) in m["params"].as_object().unwrap() {
        if p["type"] != "int" {
            assert!(refused.contains(&format!("params.{k}")), "{k}");
        }
    }
    // Every published 06 definition has commands: 11 can read, not run it.
    for f in v["manifests"].as_object().unwrap().values() {
        let r = creation_to_eleven(&f["manifest"]).unwrap();
        assert!(!r.refused.is_empty());
    }
    // 06's int semantics: no max means up to the largest safe integer.
    assert_eq!(
        int_param("n", &json!({"type": "int"})).unwrap(),
        (
            ArgSpec {
                min: 0,
                max: 9_007_199_254_740_991
            },
            None
        )
    );
    assert!(int_param("n", &json!({"type": "int", "min": 5, "max": 2})).is_err());
}

#[test]
fn k09_goods_follow_the_cores_slots_and_units() {
    let milli = goods_milli(&json!({"ore": 24, "wood": 12, "arms": 3})).unwrap();
    assert_eq!(milli, [0, 12_000, 0, 24_000, 3_000, 0, 0, 0]);
    // "arms" is the store the core names Horses (S1's ARMS).
    assert_eq!(
        permutation_rules_arms_index(),
        wylls_creation_bridge::map::RESOURCES
            .iter()
            .position(|r| *r == "arms")
            .unwrap()
    );
    for bad in [
        json!({"iron": 1}),
        json!({"ore": -1}),
        json!({"ore": 4_294_967_296u64}),
        json!({"ore": 1.5}),
    ] {
        assert!(
            matches!(goods_milli(&bad), Err(BridgeError::NotMappable { .. })),
            "{bad}"
        );
    }
}

fn permutation_rules_arms_index() -> usize {
    // The rules kernel's own constant.
    permutation_rules::frontier::arms::ARMS as usize
}

#[test]
fn k10_no_eleven_manifest_becomes_a_06_definition() {
    let m = wylls_ext_kernel::examples::watch_vow([0xA1; 32]);
    assert!(matches!(
        eleven_to_creation(&m),
        Err(BridgeError::NotMappable { .. })
    ));
}
