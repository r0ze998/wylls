//! The S1 rules (redesign stage 1, 1a: the arms economy): the ruleset
//! hash v3 and the kernel rules the program and verifier share.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::{self as fr, arms, catalog, doctrine};
use permutation_rules::frontier::{
    ruleset_hash, ruleset_hash_input_v2, ruleset_hash_input_v3, ruleset_hash_v2, ruleset_hash_v3,
    KERNEL_VERSIONS_V2, KERNEL_VERSIONS_V3,
};
use permutation_rules::hash::sha256;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `RULESET_HASH_V3`. Pinned here and in `frontier-abi`; a change to any S1
/// kernel version or table moves it on purpose.
const V3_RULESET_HASH: &str = "e61a3d6aeb802675f36e6e048faeb962970eb34ae60185e8cb841c9ed3e607d0";

#[test]
fn s1_ruleset_hash_pinned_and_older_hashes_unchanged() {
    assert_eq!(
        hex(&ruleset_hash()),
        "72c6b5835ded6418ed98b0c00b2ae45ce4c4b082d9614447dbce2c9d2e654bd9"
    );
    assert_eq!(
        hex(&ruleset_hash_v2()),
        "5fbaf678bcc9f66c7499c2d26ce195c9ca3f78b32a9f67f11089789b82c01a8b"
    );
    assert_eq!(fr::RULES_VERSION_FRONTIER_V3, 12);
    let v2 = ruleset_hash_input_v2();
    let v3 = ruleset_hash_input_v3();
    assert!(v3.starts_with(b"PSF-RULESET-v3"));
    assert_eq!(ruleset_hash_v3(), sha256(&[&v3]));
    assert_eq!(ruleset_hash_input_v3(), v3, "deterministic");
    // v3 = v2 with the v3 head, then the S1 tables.
    let mut tables = fr::RULESET_V3_TABLES_TAG.to_vec();
    arms::write_tables(&mut tables);
    catalog::write_tables_v3(&mut tables);
    doctrine::write_table_v3(&mut tables);
    fr::caravan::write_tables(&mut tables);
    assert!(v3.ends_with(&tables));
    let mut v2_head = fr::RULESET_DOMAIN_V2.len() + 1;
    for (n, _) in KERNEL_VERSIONS_V2 {
        v2_head += 1 + n.len() + 2;
    }
    let body = &v3[..v3.len() - tables.len()];
    assert!(body.ends_with(&v2[v2_head..]));
    // The S1 bumps.
    let ver2 = |n: &str| KERNEL_VERSIONS_V2.iter().find(|x| x.0 == n).map(|x| x.1);
    let ver3 = |n: &str| KERNEL_VERSIONS_V3.iter().find(|x| x.0 == n).unwrap().1;
    for (n, a, b) in [
        ("frontier", Some(11), 12),
        ("catalog", Some(2), 3),
        ("doctrine", Some(2), 3),
        ("holding", Some(3), 4),
        ("arms", None, 1),
        ("caravan", None, 1),
    ] {
        assert_eq!((ver2(n), ver3(n)), (a, b), "{n}");
    }
    for (n, v) in KERNEL_VERSIONS_V2 {
        if !["frontier", "catalog", "doctrine", "holding"].contains(&n) {
            assert_eq!(ver3(n), v, "{n} unchanged");
        }
    }
    assert_eq!(
        hex(&ruleset_hash_v3()),
        V3_RULESET_HASH,
        "RULESET_HASH_V3 moved"
    );
}

#[test]
fn s1_train_costs_arms_for_the_strong_units_only() {
    use permutation_rules::units::UnitType as U;
    for (u, per) in [
        (U::Spearman, 0),
        (U::Archer, 0),
        (U::Horseman, 0),
        (U::Pikeman, 50),
        (U::Crossbowman, 70),
        (U::Knight, 40),
        (U::Scout, 0),
    ] {
        let c = arms::train_v3(u as u8, 150).unwrap();
        assert_eq!(c[arms::ARMS as usize], 2 * per * MILLI, "{u:?}");
        let mut rest = c;
        rest[arms::ARMS as usize] = 0;
        assert_eq!(rest, catalog::train_v2(u as u8, 150).unwrap());
    }
    // The S1 doctrines field the three units that cost arms.
    let fielded: Vec<U> = doctrine::DOCTRINES_V3.iter().map(|d| d.unit).collect();
    for u in [U::Pikeman, U::Crossbowman, U::Knight] {
        assert!(fielded.contains(&u), "{u:?}");
    }
}
