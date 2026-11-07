//! V26's state audit (custody seasons): what the accounts alone settle is
//! re-judged; a state the custody kernel cannot write is a FAIL; a rule not
//! decided (forfeiture, an open lot in a seized vault) is UNVERIFIABLE; and
//! with no replay of the history a custody season is never a PASS.

mod common;

use common::*;
use frontier_abi::v2::layout::s1::vault as VA;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::custody as K;
use permutation_rules::frontier::holding::Resource;
use verify_core::checks::v26_custody::{lot_findings, vault_findings};
use verify_core::codes::*;
use verify_core::{Input, Verdict};

const OWNER: [u8; 32] = [0xB2; 32];
const KEEPER: [u8; 32] = [0x4B; 32];
const GRANTEE: [u8; 32] = [0xC3; 32];

fn keeper() -> K::Actor {
    K::Actor {
        citizen: KEEPER,
        tag: 0x4B,
        by_session: false,
    }
}
fn owner() -> K::Actor {
    K::Actor {
        citizen: OWNER,
        tag: 0xB2,
        by_session: false,
    }
}

fn view() -> K::VaultView {
    K::VaultView {
        p: 3,
        q: -2,
        tile: 7,
        gen: 1,
        live: true,
        owner: KEEPER,
        owner_tag: 0x4B,
        stores: [0; 8],
        cap: 100 * MILLI,
        quota: [0; 8],
        lots: 0,
    }
}

/// A lot written by the kernel itself: opened, filled by an arrival, a use
/// order set and partly spent, a caravan on its way.
fn kernel_lot(v: &mut K::VaultView) -> K::Lot {
    let mut l = K::open(
        v,
        &keeper(),
        (OWNER, 0xB2),
        Resource::Ore as u8,
        30 * MILLI,
        10,
        KEEPER,
    )
    .unwrap();
    K::begin_inbound(v, &mut l, (0x77, 1), 12 * MILLI).unwrap();
    K::finish_inbound(Some(v), &mut l, (0x77, 1), 12 * MILLI).unwrap();
    let spec = K::OrderSpec {
        kind: K::ORDER_USE,
        grantee: GRANTEE,
        qty: 5 * MILLI,
        expires_bell: 100,
        dst: K::PlaceRef::default(),
        purpose: 0,
    };
    K::set_order(v, &mut l, &owner(), 0, 0, &spec, 20).unwrap();
    let user = K::Actor {
        citizen: GRANTEE,
        tag: 0xC3,
        by_session: false,
    };
    K::consume(v, &mut l, &user, 0, 0, 2 * MILLI, 0, 30).unwrap();
    K::begin_inbound(v, &mut l, (0x78, 1), 6 * MILLI).unwrap();
    l
}

fn bytes(l: &K::Lot) -> Vec<u8> {
    let mut d = vec![0u8; K::layout::lot::SIZE];
    l.encode(&mut d).unwrap();
    d
}

fn vault_bytes(v: &K::VaultView) -> Vec<u8> {
    let mut d = vec![0u8; VA::SIZE];
    d[..8].copy_from_slice(&VA::MAGIC);
    d[VA::P..VA::P + 2].copy_from_slice(&v.p.to_le_bytes());
    d[VA::Q..VA::Q + 2].copy_from_slice(&v.q.to_le_bytes());
    d[VA::TILE] = v.tile;
    d[VA::STATE] = VA::STATE_LIVE;
    d[VA::GEN] = v.gen;
    d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&v.owner);
    d[VA::CAP..VA::CAP + 8].copy_from_slice(&v.cap.to_le_bytes());
    for r in 0..8 {
        d[VA::store(r)..VA::store(r) + 8].copy_from_slice(&v.stores[r].to_le_bytes());
        d[VA::custody_quota(r)..VA::custody_quota(r) + 8]
            .copy_from_slice(&v.quota[r].to_le_bytes());
    }
    d[VA::CUSTODY_LOTS..VA::CUSTODY_LOTS + 2].copy_from_slice(&v.lots.to_le_bytes());
    d
}

/// A custody season (`RULESET_HASH_V4`) with `accounts` at the pinned slot.
fn season(accounts: &[(u8, Vec<u8>)]) -> Input {
    let mut inp = march();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V4;
    let program = inp.cfg.program;
    for (k, data) in accounts {
        inp.finals.insert(
            [*k; 32],
            Some(fclient::ports::Account {
                lamports: 1,
                data: data.clone(),
                owner: program,
                executable: false,
            }),
        );
    }
    inp
}

/// V26's own FAILs (the injected accounts also trip V1/V2 in this
/// fixture, which records no custody season: those are not V26's).
fn v26_fails(r: &verify_core::Report) -> Vec<String> {
    r.findings
        .iter()
        .filter(|f| f.check == "V26" && f.fail())
        .map(|f| f.code.clone())
        .collect()
}

/// V26's own findings, sorted: (code, FAIL?, entity, detail, signature).
/// The fixture (`march`) already FAILs elsewhere (V11: six bad placements),
/// so the report's verdict says nothing about custody; these do.
fn v26(r: &verify_core::Report) -> Vec<(String, bool, String, String, String)> {
    let mut v: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.check == "V26")
        .map(|f| {
            (
                f.code.clone(),
                f.fail(),
                f.entity.clone(),
                f.detail.clone(),
                f.signature.clone(),
            )
        })
        .collect();
    v.sort();
    v
}

/// The verdict custody alone would give (V26's findings only).
fn custody_verdict(r: &verify_core::Report) -> Verdict {
    let f = r.findings.iter().filter(|f| f.check == "V26");
    if f.clone().any(|f| f.fail()) {
        Verdict::Fail
    } else if f.count() > 0 {
        Verdict::Unverifiable
    } else {
        Verdict::Pass
    }
}

fn account(k: u8) -> String {
    format!("account:{}", fclient::Address::new_from_array([k; 32]))
}

/// The UNVERIFIABLE trace V26 gives every custody account at the pinned slot.
fn unverified_at_slot(k: u8, what: &str) -> (String, bool, String, String, String) {
    (
        CUSTODY_UNVERIFIED.to_string(),
        false,
        account(k),
        format!("{what} at the pinned slot: custody is not verified (no V26 replay yet)"),
        String::new(),
    )
}

fn fails(d: &[u8]) -> Vec<&'static str> {
    lot_findings(d)
        .into_iter()
        .filter(|f| f.1)
        .map(|f| f.0)
        .collect()
}

#[test]
fn what_the_kernel_writes_passes_the_audit_and_the_season_is_still_unverifiable() {
    let mut v = view();
    let l = kernel_lot(&mut v);
    assert!(
        lot_findings(&bytes(&l)).is_empty(),
        "{:?}",
        lot_findings(&bytes(&l))
    );
    assert!(vault_findings(&vault_bytes(&v)).is_empty());
    let r = verify_core::verify(&season(&[(0xD1, bytes(&l)), (0xD2, vault_bytes(&v))]));
    // Exactly the two traces, nothing broken: custody is UNVERIFIABLE.
    let mut want = vec![
        unverified_at_slot(0xD1, "a Lot account"),
        unverified_at_slot(0xD2, "a Vault with custody counts"),
    ];
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
    assert!(v26_fails(&r).is_empty(), "{}", show(&r));
    assert!(r.checks_run.contains(&"V26:custody-state"));
    for c in [
        CUSTODY_LOT_BROKEN,
        CUSTODY_OVER_CAPACITY,
        CUSTODY_VAULT_COUNTS,
    ] {
        assert!(!r.findings.iter().any(|f| f.code == c), "{}", show(&r));
    }
    assert!(r.findings.iter().any(|f| f.code == CUSTODY_UNVERIFIED));
}

#[test]
fn a_lot_the_kernel_cannot_write_fails() {
    let mut v = view();
    let good = kernel_lot(&mut v);
    type Forge = fn(&mut K::Lot);
    let cases: [(&str, Forge, &str); 14] = [
        (
            "goods from nowhere",
            |l| l.held += MILLI,
            CUSTODY_LOT_BROKEN,
        ),
        ("goods vanish", |l| l.held -= MILLI, CUSTODY_LOT_BROKEN),
        (
            "negative held",
            |l| {
                l.held = -MILLI;
                l.in_total = l.out_total + l.consumed + l.forfeited - MILLI;
            },
            CUSTODY_LOT_BROKEN,
        ),
        (
            "a resource not enabled",
            |l| l.resource = Resource::Wood as u8,
            CUSTODY_LOT_BROKEN,
        ),
        (
            "an order granted to the owner",
            |l| l.orders[0].grantee = l.owner,
            CUSTODY_LOT_BROKEN,
        ),
        (
            "an order from the future",
            |l| l.orders[0].id = l.nonce,
            CUSTODY_LOT_BROKEN,
        ),
        (
            "a spent order left set",
            |l| l.orders[0].qty_left = 0,
            CUSTODY_LOT_BROKEN,
        ),
        (
            "a free slot with goods",
            |l| l.orders[1].qty_left = MILLI,
            CUSTODY_LOT_BROKEN,
        ),
        (
            "a ship order to its own vault",
            |l| {
                l.orders[0].kind = K::ORDER_SHIP;
                l.orders[0].dst = K::PlaceRef::vault(l.p, l.q, l.tile, 1);
            },
            CUSTODY_LOT_BROKEN,
        ),
        (
            "a caravan expected twice",
            |l| l.inbound[1] = l.inbound[0],
            CUSTODY_LOT_BROKEN,
        ),
        (
            "more held and expected than the quota",
            |l| l.quota = 10 * MILLI,
            CUSTODY_OVER_CAPACITY,
        ),
        ("an unknown state", |l| l.state = 9, CUSTODY_LOT_BROKEN),
        (
            "used with no order ever set",
            |l| {
                l.nonce = 0;
                l.orders = [K::Order::default(); 4];
            },
            CUSTODY_LOT_BROKEN,
        ),
        (
            "an open lot with goods forfeited",
            |l| {
                l.forfeited = MILLI;
                l.held -= MILLI;
            },
            CUSTODY_LOT_BROKEN,
        ),
    ];
    for (name, forge, code) in cases {
        let mut l = good;
        forge(&mut l);
        let d = bytes(&l);
        assert!(fails(&d).contains(&code), "{name}: {:?}", lot_findings(&d));
        // In the verifier: a FAIL, at the pinned slot.
        let r = verify_core::verify(&season(&[(0xD1, d)]));
        assert!(
            v26_fails(&r).contains(&code.to_string()),
            "{name}: {}",
            show(&r)
        );
    }
    // A Lot that does not decode at all.
    let r = verify_core::verify(&season(&[(0xD1, bytes(&good)[..300].to_vec())]));
    assert!(r.fails_with(CUSTODY_LOT_BROKEN), "{}", show(&r));
}

#[test]
fn a_vault_over_its_cap_fails() {
    let mut v = view();
    let _ = kernel_lot(&mut v);
    v.stores[Resource::Ore as usize] = 71 * MILLI; // 71 + 30 > 100
    let d = vault_bytes(&v);
    assert_eq!(
        vault_findings(&d).iter().map(|f| f.0).collect::<Vec<_>>(),
        vec![CUSTODY_OVER_CAPACITY]
    );
    let r = verify_core::verify(&season(&[(0xD2, d)]));
    assert!(r.fails_with(CUSTODY_OVER_CAPACITY), "{}", show(&r));
}

#[test]
fn vault_counts_fail_only_when_the_visible_lots_exceed_them() {
    let mut v = view();
    let a = kernel_lot(&mut v);
    let mut b = K::open(
        &mut v,
        &keeper(),
        ([0xD7; 32], 0xD7),
        Resource::Ore as u8,
        20 * MILLI,
        11,
        KEEPER,
    )
    .unwrap();
    K::begin_inbound(&v, &mut b, (0x79, 1), MILLI).unwrap();
    // Consistent: no count finding.
    let r = verify_core::verify(&season(&[
        (0xD1, bytes(&a)),
        (0xD3, bytes(&b)),
        (0xD2, vault_bytes(&v)),
    ]));
    assert!(
        !r.findings.iter().any(|f| f.code == CUSTODY_VAULT_COUNTS),
        "{}",
        show(&r)
    );
    // One lot missing from the input: the sums are lower, not a FAIL.
    let r = verify_core::verify(&season(&[(0xD1, bytes(&a)), (0xD2, vault_bytes(&v))]));
    // Only the two traces: no CustodyVaultCounts of any severity (the
    // visible sums are lower, which proves nothing), custody UNVERIFIABLE.
    let mut want = vec![
        unverified_at_slot(0xD1, "a Lot account"),
        unverified_at_slot(0xD2, "a Vault with custody counts"),
    ];
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
    // The vault counts one lot fewer than are visible, or less quota.
    for forge in [
        |v: &mut K::VaultView| v.lots -= 1,
        |v: &mut K::VaultView| v.quota[0] -= MILLI,
    ] {
        let mut w = v;
        forge(&mut w);
        let r = verify_core::verify(&season(&[
            (0xD1, bytes(&a)),
            (0xD3, bytes(&b)),
            (0xD2, vault_bytes(&w)),
        ]));
        assert!(r.fails_with(CUSTODY_VAULT_COUNTS), "{}", show(&r));
    }
    // A lot of a later generation than its vault cannot exist.
    let mut c = b;
    c.vault_gen = 2;
    let r = verify_core::verify(&season(&[
        (0xD1, bytes(&a)),
        (0xD3, bytes(&c)),
        (0xD2, vault_bytes(&v)),
    ]));
    assert!(r.fails_with(CUSTODY_VAULT_COUNTS), "{}", show(&r));
}

#[test]
fn undecided_rules_are_unverifiable_not_fail() {
    // An open lot in a seized vault (the vault's generation moved on).
    let mut v = view();
    let l = kernel_lot(&mut v);
    let mut seized = v;
    seized.gen = 2;
    seized.owner = [0xEE; 32];
    let r = verify_core::verify(&season(&[(0xD1, bytes(&l)), (0xD2, vault_bytes(&seized))]));
    // The two traces and one undecided rule, on the vault, naming both
    // generations; nothing broken.
    let mut want = vec![
        unverified_at_slot(0xD1, "a Lot account"),
        unverified_at_slot(0xD2, "a Vault with custody counts"),
        (
            CUSTODY_RULE_UNDECIDED.to_string(),
            false,
            account(0xD2),
            "an open lot of generation 1 in a seized vault (generation 2): what seizure does to it is not decided".to_string(),
            String::new(),
        ),
    ];
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
    // A forfeited lot (⑩'s proposal ran): unverifiable while its totals add
    // up; a FAIL when they do not.
    let mut s = seized;
    let mut f = l;
    K::forfeit(&mut s, &mut f).unwrap();
    assert_eq!(fails(&bytes(&f)), Vec::<&str>::new());
    let r = verify_core::verify(&season(&[(0xD1, bytes(&f))]));
    // The lot's trace and one undecided rule on the lot, with what it
    // forfeited; nothing broken.
    assert!(f.forfeited > 0);
    let mut want = vec![
        unverified_at_slot(0xD1, "a Lot account"),
        (
            CUSTODY_RULE_UNDECIDED.to_string(),
            false,
            account(0xD1),
            format!(
                "a forfeited lot ({} forfeited): forfeiture is not a decided rule",
                f.forfeited
            ),
            String::new(),
        ),
    ];
    want.sort();
    assert_eq!(v26(&r), want, "{}", show(&r));
    assert_eq!(custody_verdict(&r), Verdict::Unverifiable);
    f.forfeited += MILLI;
    let r = verify_core::verify(&season(&[(0xD1, bytes(&f))]));
    assert!(r.fails_with(CUSTODY_LOT_BROKEN), "{}", show(&r));
}

#[test]
fn a_broken_lot_in_a_post_state_fails_at_its_transaction() {
    let mut v = view();
    let mut l = kernel_lot(&mut v);
    l.consumed += MILLI;
    let mut inp = season(&[]);
    let program = inp.cfg.program;
    let t = inp.txs.iter().position(|t| t.err.is_none()).unwrap();
    let acct = fclient::ports::Account {
        lamports: 1,
        data: bytes(&l),
        owner: program,
        executable: false,
    };
    // The recorded post-states: the forged lot after one landed transaction.
    inp.txs[t]
        .post
        .push((solana_address(&[0xD1; 32]), Some(acct)));
    let sig = inp.txs[t].signature.to_string();
    let r = verify_core::verify(&inp);
    assert!(
        r.findings
            .iter()
            .any(|f| f.fail() && f.code == CUSTODY_LOT_BROKEN && f.signature == sig),
        "{}",
        show(&r)
    );
}

fn solana_address(k: &[u8; 32]) -> fclient::Address {
    fclient::Address::new_from_array(*k)
}

/// The audit must never FAIL what the kernel writes: random kernel runs.
#[test]
fn random_kernel_runs_never_fail_the_audit() {
    let mut x: u64 = 0x2545_F491_4F6C_DD1D;
    let mut rnd = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    for _ in 0..300 {
        let mut v = view();
        let mut l = K::open(
            &mut v,
            &keeper(),
            (OWNER, 0xB2),
            Resource::Ore as u8,
            40 * MILLI,
            0,
            KEEPER,
        )
        .unwrap();
        let mut bell = 1u32;
        let mut seq = 1u32;
        for _ in 0..60 {
            bell += rnd(30) as u32;
            let q = (1 + rnd(8) as i64) * MILLI;
            let _ = match rnd(7) {
                0 => {
                    seq += 1;
                    K::begin_inbound(&v, &mut l, (0x70, seq), q)
                }
                1 => {
                    let live: Vec<_> = l
                        .inbound
                        .iter()
                        .filter(|i| i.live)
                        .map(|i| (i.caravan_tag, i.seq, i.qty))
                        .collect();
                    match live.first() {
                        Some(&(t, s, sent)) => K::finish_inbound(
                            Some(&v),
                            &mut l,
                            (t, s),
                            sent - rnd(2) as i64 * MILLI.min(sent),
                        )
                        .map(|_| ()),
                        None => Ok(()),
                    }
                }
                2 => {
                    let spec = K::OrderSpec {
                        kind: if rnd(2) == 0 {
                            K::ORDER_USE
                        } else {
                            K::ORDER_SHIP
                        },
                        grantee: GRANTEE,
                        qty: q,
                        expires_bell: bell + 1 + rnd(200) as u32,
                        dst: K::PlaceRef::vault(9, 9, 1, 1),
                        purpose: 0,
                    };
                    let n = l.nonce;
                    K::set_order(&v, &mut l, &owner(), rnd(4) as u8, n, &spec, bell).map(|_| ())
                }
                3 => {
                    let s = rnd(4) as u8;
                    let o = l.orders[s as usize];
                    let user = K::Actor {
                        citizen: GRANTEE,
                        tag: 0xC3,
                        by_session: false,
                    };
                    K::consume(
                        &v,
                        &mut l,
                        &user,
                        s,
                        o.id,
                        q.min(o.qty_left.max(MILLI)),
                        0,
                        bell,
                    )
                }
                4 => {
                    let s = rnd(4) as u8;
                    let o = l.orders[s as usize];
                    K::revoke_order(&mut l, &owner(), s, o.id, bell).map(|_| ())
                }
                5 => K::spend_ship(
                    &v,
                    &mut l,
                    &owner(),
                    K::By::Owner,
                    q,
                    K::ShipTo::OwnPlace(v.place()),
                    bell,
                ),
                _ => {
                    let live: Vec<_> = l
                        .inbound
                        .iter()
                        .filter(|i| i.live)
                        .map(|i| (i.caravan_tag, i.seq))
                        .collect();
                    match live.first() {
                        Some(&c) => K::drop_inbound(&mut l, c, K::CaravanSeen::Absent).map(|_| ()),
                        None => Ok(()),
                    }
                }
            };
            assert!(
                fails(&bytes(&l)).is_empty(),
                "{:?}\n{l:?}",
                lot_findings(&bytes(&l))
            );
            assert!(vault_findings(&vault_bytes(&v)).is_empty());
        }
    }
}
