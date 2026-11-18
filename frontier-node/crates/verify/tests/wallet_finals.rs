//! A real archive (the localnet feed, `input::written_keys`) holds every
//! writable account's post-state and final, the fee payer's wallet
//! included; the committed fixtures mostly keep program accounts only.
//! No check may read a wallet as a program account (round 3 of #72,
//! verify-pr72 B-2: CQ1's owner rule FAILed every such season).

mod common;

use std::collections::BTreeMap;

use fclient::ports::Account;
use fclient::Address;

#[test]
fn wallet_posts_and_finals_add_no_finding() {
    // An M1 season, and two S1-ruleset seasons (CQ1 runs on those; in the
    // default build their 0x4804 version is unknown, which does not matter
    // here: the wallets must add nothing).
    for (name, base) in [
        ("land", common::land()),
        (
            "playable-natural",
            common::fixture("playable-lane-natural.json.gz"),
        ),
        (
            "playable-setrules",
            common::fixture("playable-wide-setrules.json.gz"),
        ),
    ] {
        let rep0 = verify_core::verify(&base);
        let mut inp = base;
        let system = Address::new_from_array([0; 32]);
        let wallet = |lamports: u64| Account {
            lamports,
            data: vec![],
            owner: system,
            executable: false,
        };
        let mut bal: BTreeMap<[u8; 32], u64> = BTreeMap::new();
        for t in 0..inp.txs.len() {
            let Ok(tx) = fclient::tx::from_wire(&inp.txs[t].tx) else {
                continue;
            };
            let p = tx.message.account_keys[0].to_bytes();
            let b = *bal.entry(p).or_insert(1_000_000_000_000);
            let after = b - 5_000;
            bal.insert(p, after);
            inp.txs[t]
                .post
                .push((Address::new_from_array(p), Some(wallet(after))));
        }
        assert!(!bal.is_empty(), "{name}: no fee payer found");
        for (k, l) in bal {
            inp.finals.insert(k, Some(wallet(l)));
        }
        let rep = verify_core::verify(&inp);
        let new: Vec<_> = rep
            .findings
            .iter()
            .filter(|f| {
                !rep0
                    .findings
                    .iter()
                    .any(|g| g.code == f.code && g.entity == f.entity && g.detail == f.detail)
            })
            .map(|f| (f.check, f.code.clone(), f.entity.clone(), f.detail.clone()))
            .collect();
        assert!(new.is_empty(), "{name}: {new:#?}");
        assert_eq!(rep.verdict, rep0.verdict, "{name}");
    }
}
