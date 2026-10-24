//! The caravan path vectors the web page's planner is pinned by
//! (`permutation-server/web/frontier/fcaravan.mjs`, checked by
//! `permutation-gateway/test/web-frontier-s1.test.mjs`): `fastest_path`,
//! `pack` and `walk` over pseudo-random lands.
//!
//! `CARAVAN_WRITE_VECTORS=1 cargo test -p fclient --test caravan_path_vectors`
//! rewrites the file; otherwise the file must match.

use permutation_rules::frontier::caravan::{fastest_path, pack, walk, Land};
use permutation_rules::frontier::geometry::ProvinceCoord;
use serde_json::{json, Value};

const FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../permutation-gateway/test/fixtures/caravan-path-v1.json"
);

/// A small deterministic generator (xorshift64*).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// A 61-tile mask with each bit set with probability `num/16`.
    fn mask(&mut self, num: u64) -> u64 {
        (0..61).fold(
            0u64,
            |m, i| if self.below(16) < num { m | 1 << i } else { m },
        )
    }
}

fn land_json(l: &Land) -> Value {
    json!({"p": l.at.p, "q": l.at.q, "passable": l.passable.to_string(),
        "rough": l.rough.to_string(), "road": l.road.to_string()})
}

fn cases() -> Value {
    let mut rng = Rng(0x5EED_CA2A_7A11_0001);
    let mut out = Vec::new();
    for n in 0..48 {
        let origin = ProvinceCoord {
            p: rng.below(5) as i32 - 2,
            q: rng.below(5) as i32 - 2,
        };
        // the origin's Province, then up to six of its neighbours (some missing)
        let mut lands = vec![origin];
        for nb in origin.neighbors() {
            if rng.below(4) != 0 {
                lands.push(nb);
            }
        }
        let open = if n % 4 == 0 { 16 } else { 12 + rng.below(4) };
        let lands: Vec<Land> = lands
            .into_iter()
            .map(|at| Land {
                at,
                passable: rng.mask(open),
                rough: rng.mask(5),
                road: rng.mask(3),
            })
            .collect();
        let o_tile = rng.below(61) as u8;
        let d = &lands[rng.below(lands.len() as u64) as usize];
        let d_tile = rng.below(61) as u8;
        let found = fastest_path((origin, o_tile), (d.at, d_tile), &lands);
        let answer = found.map(|(dirs, order)| {
            let path = pack(&dirs).expect("a path within 32 steps packs");
            let ordered: Vec<Land> = order
                .iter()
                .map(|pc| *lands.iter().find(|l| l.at == *pc).unwrap())
                .collect();
            let secs: Vec<u32> = if dirs.is_empty() {
                vec![]
            } else {
                walk((origin, o_tile), &path, dirs.len() as u8, &ordered, 10_000)
                    .expect("the fastest path walks")
                    .iter()
                    .map(|s| s.at_secs)
                    .collect()
            };
            json!({"dirs": dirs, "provinces": order.iter().map(|pc| json!([pc.p, pc.q])).collect::<Vec<_>>(),
                "path": path.to_vec(), "atSecs": secs})
        });
        out.push(json!({
            "origin": {"p": origin.p, "q": origin.q, "tile": o_tile},
            "dst": {"p": d.at.p, "q": d.at.q, "tile": d_tile},
            "lands": lands.iter().map(land_json).collect::<Vec<_>>(),
            "answer": answer,
        }));
    }
    json!({"v": 1, "cases": out})
}

#[test]
fn caravan_path_vectors() {
    let want = cases();
    let found = want["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["answer"].is_null())
        .count();
    assert!(found >= 16, "the vectors cover found paths ({found})");
    assert!(found < 48, "and refusals");
    if std::env::var("CARAVAN_WRITE_VECTORS").is_ok() {
        std::fs::write(FILE, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
        return;
    }
    let have: Value =
        serde_json::from_str(&std::fs::read_to_string(FILE).expect("the vectors file")).unwrap();
    assert_eq!(have, want, "rewrite with CARAVAN_WRITE_VECTORS=1");
}

const ADDR_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../permutation-gateway/test/fixtures/s1-addresses-v1.json"
);

/// The S1 accounts' addresses (vault, structure, caravan, nation) the web
/// page recomputes (`faddr.mjs`), for one program and season.
#[test]
fn s1_address_vectors() {
    use fclient::addr::Addresses;
    let program = fclient::Address::new_from_array([7u8; 32]);
    let a = Addresses::new(program, 42);
    let tiles: [(i32, i32, u8); 3] = [(3, -1, 20), (-7, 4, 0), (0, 0, 60)];
    let vault: Vec<Value> = tiles
        .iter()
        .map(|&(p, q, t)| json!({"p": p, "q": q, "tile": t, "address": a.vault(p, q, t).to_string()}))
        .collect();
    let structure: Vec<Value> = tiles
        .iter()
        .map(|&(p, q, t)| json!({"p": p, "q": q, "tile": t, "address": a.structure(p, q, t).to_string()}))
        .collect();
    let caravan: Vec<Value> = [(9u64, 0u32), (u64::MAX, 7), (0x0123_4567_89ab_cdef, 1)]
        .iter()
        .map(|&(t, s)| json!({"ownerTag": t.to_string(), "seq": s, "address": a.caravan(t, s).to_string()}))
        .collect();
    let nation: Vec<Value> = (0u8..6)
        .map(|f| json!({"faction": f, "address": a.nation(f).to_string()}))
        .collect();
    let want = json!({"v": 1, "program": program.to_string(), "seasonId": "42",
        "vault": vault, "structure": structure, "caravan": caravan, "nation": nation});
    if std::env::var("CARAVAN_WRITE_VECTORS").is_ok() {
        std::fs::write(
            ADDR_FILE,
            serde_json::to_string_pretty(&want).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    let have: Value =
        serde_json::from_str(&std::fs::read_to_string(ADDR_FILE).expect("the vectors file"))
            .unwrap();
    assert_eq!(have, want, "rewrite with CARAVAN_WRITE_VECTORS=1");
}

const IX_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../permutation-gateway/test/fixtures/s1-ix-v1.json"
);

fn ix_json(name: &str, ix: &fclient::Instruction) -> Value {
    json!({
        "name": name,
        "keys": ix.accounts.iter().map(|m| json!([m.pubkey.to_string(), m.is_signer, m.is_writable])).collect::<Vec<_>>(),
        "data": ix.data.iter().map(|b| format!("{b:02x}")).collect::<String>(),
    })
}

/// The S1 player instructions the web page builds (`fplay.mjs`), as
/// fclient's `ix::v2` builders make them, for one program, season and
/// player.
#[test]
fn s1_instruction_vectors() {
    use fclient::addr::Addresses;
    use fclient::ix::v2::{self as v2, PlaceRef, RaidCaravanArgs, SendCaravanArgs};
    use fclient::ix::{HoldingRef, Player};
    let program = fclient::Address::new_from_array([7u8; 32]);
    let a = Addresses::new(program, 42);
    let p = Player {
        actor: fclient::Address::new_from_array([1u8; 32]),
        payer: fclient::Address::new_from_array([2u8; 32]),
        wallet: fclient::Address::new_from_array([3u8; 32]),
    };
    let h = HoldingRef {
        p: 3,
        q: -1,
        site: 4,
    };
    let send = SendCaravanArgs {
        seq: 2,
        src: PlaceRef::Holding { h, gen: 1 },
        dst: PlaceRef::Vault {
            p: 4,
            q: -2,
            tile: 17,
            gen: 3,
        },
        steps: 3,
        path: pack(&[0, 1, 5]).unwrap(),
        cargo: [0, 100, 50, 0, 7, 0, 0, 0],
        fee: 50_000,
        provinces: vec![(3, -1), (4, -2)],
    };
    let take = RaidCaravanArgs {
        caravan: a.caravan(77, 1),
        raid: (4, -2),
        raider_holding: HoldingRef {
            p: 5,
            q: -2,
            site: 1,
        },
        choice: 0,
        dst: Some(PlaceRef::Holding {
            h: HoldingRef {
                p: 5,
                q: -2,
                site: 1,
            },
            gen: 2,
        }),
        steps: 2,
        path: pack(&[3, 3]).unwrap(),
        path_provinces: vec![(5, -2)],
        old_route: vec![(3, -1), (4, -2), (4, -1)],
    };
    let burn = RaidCaravanArgs {
        choice: 1,
        dst: None,
        steps: 0,
        path: [0; 12],
        path_provinces: vec![],
        ..take.clone()
    };
    let target = a.citizen(&fclient::Address::new_from_array([9u8; 32]));
    let want = json!({"v": 1, "program": program.to_string(), "seasonId": "42",
        "actor": p.actor.to_string(), "payer": p.payer.to_string(), "wallet": p.wallet.to_string(),
        "cases": [
            ix_json("BuildVault", &v2::build_vault(&a, &p, h, (3, -1), 20)),
            ix_json("BuildVault", &v2::build_vault(&a, &p, h, (4, -1), 0)),
            ix_json("BuildStructure", &v2::build_structure(&a, &p, h, (3, -1), 1, 21, 1)),
            ix_json("BuildStructure", &v2::build_structure(&a, &p, h, (4, -1), 3, 9, 0)),
            ix_json("FortGarrison", &v2::fort_garrison(&a, &p, h, 21, 250)),
            ix_json("SendCaravan", &v2::send_caravan(&a, &p, &send)),
            ix_json("RaidCaravan", &v2::raid_caravan(&a, &p, &take)),
            ix_json("RaidCaravan", &v2::raid_caravan(&a, &p, &burn)),
            ix_json("Propose", &v2::propose(&a, &p, 2, 1, 4, 2, None)),
            ix_json("Propose", &v2::propose(&a, &p, 2, 2, 2, 0, Some(target))),
            ix_json("Vote", &v2::vote(&a, &p, 2, 1, 9, true)),
        ],
        "target": target.to_string(),
    });
    if std::env::var("CARAVAN_WRITE_VECTORS").is_ok() {
        std::fs::write(IX_FILE, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
        return;
    }
    let have: Value =
        serde_json::from_str(&std::fs::read_to_string(IX_FILE).expect("the vectors file")).unwrap();
    assert_eq!(have, want, "rewrite with CARAVAN_WRITE_VECTORS=1");
}

const S2_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../permutation-gateway/test/fixtures/s2-tickets-v1.json"
);

/// S2 (2a): the Issue and Lot addresses and the ticket instructions the
/// web page builds (`faddr.mjs`, `fplay.mjs`), as fclient makes them.
#[test]
fn s2_ticket_vectors() {
    use fclient::addr::Addresses;
    use fclient::ix::v2::{self as v2, IssueArgs, PlaceRef, TicketSource, WithdrawSharesArgs};
    use fclient::ix::{HoldingRef, Player};
    let program = fclient::Address::new_from_array([7u8; 32]);
    let a = Addresses::new(program, 42);
    let p = Player {
        actor: fclient::Address::new_from_array([1u8; 32]),
        payer: fclient::Address::new_from_array([2u8; 32]),
        wallet: fclient::Address::new_from_array([3u8; 32]),
    };
    let keys: [(u64, u32); 3] = [(9, 0), (u64::MAX, 7), (0x0123_4567_89ab_cdef, 1)];
    let issue: Vec<Value> = keys
        .iter()
        .map(
            |&(t, s)| json!({"tag": t.to_string(), "seq": s, "address": a.issue(t, s).to_string()}),
        )
        .collect();
    let lot: Vec<Value> = keys
        .iter()
        .map(|&(t, s)| json!({"tag": t.to_string(), "seq": s, "address": a.lot(t, s).to_string()}))
        .collect();
    let h = HoldingRef {
        p: 3,
        q: -1,
        site: 4,
    };
    let vault = TicketSource::Vault {
        p: 4,
        q: -2,
        tile: 17,
    };
    let receipt = IssueArgs {
        kind: 2,
        resource: 3,
        amount: 10,
        per_unit: 2_000,
        until_day: u32::MAX,
    };
    let use_right = IssueArgs {
        kind: 3,
        resource: 0,
        amount: 4,
        per_unit: 3,
        until_day: 9,
    };
    let recipient = a.citizen(&fclient::Address::new_from_array([9u8; 32]));
    let rent_to = fclient::Address::new_from_array([5u8; 32]);
    let me = 0x77;
    let withdraw = WithdrawSharesArgs {
        lot: a.deposit_lot(me, me, 2),
        issue: (me, 2),
        vault: (4, -2, 17),
        amount: 40,
        seq: 5,
        dst: PlaceRef::Holding { h, gen: 1 },
        steps: 2,
        path: pack(&[3, 4]).unwrap(),
        fee: 50_000,
        provinces: vec![(4, -2), (3, -1)],
    };
    let want = json!({"v": 1, "program": program.to_string(), "seasonId": "42",
        "actor": p.actor.to_string(), "payer": p.payer.to_string(), "wallet": p.wallet.to_string(),
        "recipient": recipient.to_string(), "rentTo": rent_to.to_string(),
        "issue": issue, "lot": lot,
        "cases": [
            ix_json("IssueTickets", &v2::issue_tickets(&a, &p, h, vault, me, 0, 0, &receipt)),
            ix_json("IssueTickets", &v2::issue_tickets(&a, &p, h, TicketSource::Holding(h), me, 1, 3, &use_right)),
            ix_json("GiveLot", &v2::give_lot(&a, &p, a.lot(me, 0), (me, 0), vault, recipient, a.lot(me, 4), 4)),
            ix_json("GiveLot", &v2::give_lot(&a, &p, a.lot(me, 0), (me, 0), vault, recipient, a.lot(me, 0), 10)),
            ix_json("CloseLot", &v2::close_lot(&a, &p, (me, 0), vault, rent_to, Some((a.lot(me, 0), rent_to)), false)),
            ix_json("CloseLot", &v2::close_lot(&a, &p, (me, 0), vault, rent_to, None, true)),
            ix_json("OpenShares", &v2::open_shares(&a, &p, h, (4, -2, 17), me, 2)),
            ix_json("WithdrawShares", &v2::withdraw_shares(&a, &p, &withdraw)),
        ],
        "depositLot": a.deposit_lot(me, me, 2).to_string(),
    });
    if std::env::var("CARAVAN_WRITE_VECTORS").is_ok() {
        std::fs::write(S2_FILE, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
        return;
    }
    let have: Value =
        serde_json::from_str(&std::fs::read_to_string(S2_FILE).expect("the vectors file")).unwrap();
    assert_eq!(have, want, "rewrite with CARAVAN_WRITE_VECTORS=1");
}
