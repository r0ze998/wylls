//! Territory preview (owner Q-2) vectors: the Rust kernel's answers for a
//! fixed set of inputs, committed as `vectors/territory-preview.json`, so
//! the page and the operator AI (`permutation-server/web/frontier/
//! territory-rules.mjs`, checked by `permutation-gateway/test/
//! web-frontier-territory-rules.test.mjs`) compute the same numbers.
//! `UPDATE_TERRITORY_VECTORS=1` rewrites the file. Parameters here are test
//! numbers, not proposals (the owner questions T-2 … T-5 are open).
#![cfg(feature = "territory-preview")]

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::territory::*;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/vectors/territory-preview.json"
);

fn curves() -> Vec<UpkeepCurve> {
    vec![
        UpkeepCurve {
            flat: 2 * MILLI,
            per_rank: 0,
            per_distance: 0,
            free_distance: 0,
        },
        UpkeepCurve {
            flat: MILLI,
            per_rank: MILLI / 2,
            per_distance: 0,
            free_distance: 0,
        },
        UpkeepCurve {
            flat: 2 * MILLI,
            per_rank: 0,
            per_distance: MILLI,
            free_distance: 3,
        },
        UpkeepCurve {
            flat: 1_234,
            per_rank: 567,
            per_distance: 891,
            free_distance: 2,
        },
        UpkeepCurve {
            flat: MAX_TERRITORY_UPKEEP_PER_HOUR,
            per_rank: 0,
            per_distance: 0,
            free_distance: 0,
        },
    ]
}

fn opt<T: ToString>(v: Option<T>) -> String {
    v.map_or("null".into(), |x| x.to_string())
}

fn curve_json(c: &UpkeepCurve) -> String {
    format!(
        "{{\"flat\":{},\"perRank\":{},\"perDistance\":{},\"freeDistance\":{}}}",
        c.flat, c.per_rank, c.per_distance, c.free_distance
    )
}

fn list(v: &[u32]) -> String {
    format!(
        "[{}]",
        v.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
    )
}

fn refusal(r: ClaimRefusal) -> &'static str {
    match r {
        ClaimRefusal::NotOpen => "NotOpen",
        ClaimRefusal::AlreadyYours => "AlreadyYours",
        ClaimRefusal::Owned => "Owned",
        ClaimRefusal::Range => "Range",
        ClaimRefusal::TurnLimit => "TurnLimit",
        ClaimRefusal::UpkeepUnpaid => "UpkeepUnpaid",
        ClaimRefusal::Insufficient => "Insufficient",
        ClaimRefusal::Overflow => "Overflow",
    }
}

fn build() -> String {
    let mut out = Vec::new();
    // upkeep
    let sets: [&[u32]; 5] = [
        &[],
        &[0],
        &[1, 5, 7],
        &[3, 3, 3, 3, 3, 3, 3, 3, 9, 12],
        &[7, 1, 5],
    ];
    let mut up = Vec::new();
    for c in curves() {
        for d in sets {
            let extra = 6;
            up.push(format!(
                "{{\"curve\":{},\"distances\":{},\"upkeep\":{},\"delta\":{},\"deltaAt\":{extra}}}",
                curve_json(&c),
                list(d),
                opt(upkeep_per_hour(&c, d)),
                opt(upkeep_delta(&c, d, extra))
            ));
        }
        for (income, d) in [(20, 2), (40, 5), (160, 8)] {
            up.push(format!(
                "{{\"curve\":{},\"income\":{},\"at\":{d},\"naturalSize\":{}}}",
                curve_json(&c),
                income * MILLI,
                opt(natural_size(&c, income * MILLI, d))
            ));
        }
    }
    out.push(format!("\"upkeep\":[\n{}\n]", up.join(",\n")));
    // claim cost
    let mut cc = Vec::new();
    for (base, bps) in [
        (100u64, 0u32),
        (100, 1_000),
        (800, 2_500),
        (u64::MAX, 10_000),
    ] {
        for owned in [0u32, 1, 4, 37] {
            cc.push(format!(
                "{{\"base\":\"{base}\",\"perOwnedBps\":{bps},\"owned\":{owned},\"cost\":{}}}",
                claim_cost(
                    &ClaimCost {
                        base,
                        per_owned_bps: bps
                    },
                    owned
                )
                .map_or("null".into(), |v| format!("\"{v}\""))
            ));
        }
    }
    out.push(format!("\"claimCost\":[\n{}\n]", cc.join(",\n")));
    // claims
    let base = TerritoryParams {
        upkeep: curves()[0],
        cost: ClaimCost {
            base: 100,
            per_owned_bps: 1_000,
        },
        reach: ReachRule {
            range: 3,
            sources: SRC_HOME | SRC_OWN,
        },
        claims_per_turn: 1,
        claim_owned: false,
        unpaid: UnpaidRule {
            block_claims: true,
            production_bps: 5_000,
            decay_after_bells: Some(24),
            decay_every_bells: 6,
        },
        decay_order: DecayOrder::Farthest,
    };
    let chk = ClaimCheck {
        open: true,
        owner: TargetOwner::Nobody,
        nearest: Nearest {
            home: Some(9),
            own: Some(4),
            nation_keep: Some(1),
            nation_land: Some(0),
        },
        owned: 4,
        claims_this_turn: 0,
        upkeep_unpaid: false,
        balance: 1_000,
    };
    let mut cl = Vec::new();
    for sources in [
        SRC_HOME | SRC_OWN,
        SRC_OWN | SRC_NATION_KEEPS,
        SRC_NATION_LAND,
        SRC_HOME,
    ] {
        for range in [0u32, 3, 4, 9] {
            for (owner, oname) in [
                (TargetOwner::Nobody, "nobody"),
                (TargetOwner::Other, "other"),
                (TargetOwner::Claimer, "claimer"),
            ] {
                for (claim_owned, unpaid, block, balance, turn) in [
                    (false, false, true, 1_000u64, 0u8),
                    (true, true, true, 140, 0),
                    (true, true, false, 139, 0),
                    (false, false, true, 1_000, 1),
                ] {
                    let p = TerritoryParams {
                        reach: ReachRule { range, sources },
                        claim_owned,
                        unpaid: UnpaidRule {
                            block_claims: block,
                            ..base.unpaid
                        },
                        ..base
                    };
                    let c = ClaimCheck {
                        owner,
                        upkeep_unpaid: unpaid,
                        balance,
                        claims_this_turn: turn,
                        ..chk
                    };
                    let r = match may_claim(&p, &c) {
                        Ok(v) => format!("{{\"ok\":\"{v}\"}}"),
                        Err(e) => format!("{{\"refused\":\"{}\"}}", refusal(e)),
                    };
                    cl.push(format!(
                        "{{\"range\":{range},\"sources\":{sources},\"claimOwned\":{claim_owned},\"blockClaims\":{block},\"perTurn\":1,\"cost\":{{\"base\":\"100\",\"perOwnedBps\":1000}},\"owner\":\"{oname}\",\"nearest\":{{\"home\":9,\"own\":4,\"nationKeep\":1,\"nationLand\":0}},\"owned\":4,\"claimsThisTurn\":{turn},\"upkeepUnpaid\":{unpaid},\"balance\":\"{balance}\",\"result\":{r}}}"
                    ));
                }
            }
        }
    }
    out.push(format!("\"claims\":[\n{}\n]", cl.join(",\n")));
    // unpaid
    let mut un = Vec::new();
    for (grace, every) in [(Some(24u32), 6u32), (None, 1), (Some(0), 1)] {
        for (since, now) in [
            (None, 100u32),
            (Some(10), 33),
            (Some(10), 34),
            (Some(10), 40),
            (Some(50), 10),
            (Some(0), 1_000),
        ] {
            let r = UnpaidRule {
                block_claims: true,
                production_bps: 5_000,
                decay_after_bells: grace,
                decay_every_bells: every,
            };
            let e = unpaid_effect(&r, since, now);
            un.push(format!(
                "{{\"decayAfterBells\":{},\"decayEveryBells\":{every},\"since\":{},\"now\":{now},\"claimsBlocked\":{},\"productionBps\":{},\"cellsReleased\":{}}}",
                opt(grace), opt(since), e.claims_blocked, e.production_bps, e.cells_released
            ));
        }
    }
    out.push(format!("\"unpaid\":[\n{}\n]", un.join(",\n")));
    // release order
    let cells = [
        OwnedCell {
            id: 1,
            distance: 2,
            claimed_bell: 50,
        },
        OwnedCell {
            id: 2,
            distance: 6,
            claimed_bell: 10,
        },
        OwnedCell {
            id: 3,
            distance: 6,
            claimed_bell: 20,
        },
        OwnedCell {
            id: 4,
            distance: 1,
            claimed_bell: 90,
        },
        OwnedCell {
            id: 5,
            distance: 6,
            claimed_bell: 20,
        },
    ];
    let cj = cells
        .iter()
        .map(|c| {
            format!(
                "{{\"id\":{},\"distance\":{},\"claimedBell\":{}}}",
                c.id, c.distance, c.claimed_bell
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let ord = |o| {
        release_order(o, &cells)
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    out.push(format!(
        "\"releaseOrder\":{{\"cells\":[{cj}],\"farthest\":[{}],\"newest\":[{}]}}",
        ord(DecayOrder::Farthest),
        ord(DecayOrder::Newest)
    ));
    format!(
        "{{\"version\":{TERRITORY_VERSION},\"note\":\"test numbers, not proposals (owner questions T-2..T-5 open)\",\n{}\n}}\n",
        out.join(",\n")
    )
}

#[test]
fn territory_vectors_are_fresh() {
    let now = build();
    if std::env::var_os("UPDATE_TERRITORY_VECTORS").is_some() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().unwrap()).unwrap();
        std::fs::write(PATH, &now).unwrap();
    }
    let committed = std::fs::read_to_string(PATH)
        .expect("vectors/territory-preview.json (UPDATE_TERRITORY_VECTORS=1)");
    assert_eq!(
        committed, now,
        "stale territory vectors: rerun with UPDATE_TERRITORY_VECTORS=1"
    );
}
