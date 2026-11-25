//! Keyless in-memory folds: territory province records captured from
//! post-states, authenticated, served, and their revision.
use super::*;
use crate::{clash::Provisional, files::Out, fold::FoldCfg};
use fclient::ports::{Account, TxRecord};
use frontier_abi::layout::{header, world::season};
use frontier_abi::world_index::territory::TerritoryRule;
use std::sync::Arc;

const PROGRAM: [u8; 32] = [0x5e; 32];

fn fold() -> Fold {
    let mut f = Fold::new(
        FoldCfg {
            program: Address::new_from_array(PROGRAM),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/wide-territory-inert"),
    );
    let mut data = vec![0; season::SIZE];
    data[..8].copy_from_slice(&season::MAGIC);
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[season::PROGRAM_VERSION..season::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    f.season = Some(fclient::decode::Season::decode(&data).unwrap());
    f
}

fn coord(p: i64, q: i64) -> WideCoord {
    WideCoord::checked(p, q).unwrap()
}

/// A territory province record of `f`'s world at `c` with `owners` `[(tile, tag)]`.
fn record(f: &Fold, c: WideCoord, owners: &[(usize, u64)]) -> ([u8; 32], Vec<u8>) {
    record_as(f, c, 7, f.wide.as_ref().unwrap().world(), owners)
}

fn record_as(
    f: &Fold,
    c: WideCoord,
    season_id: u64,
    world: frontier_abi::world_index::WorldId,
    owners: &[(usize, u64)],
) -> ([u8; 32], Vec<u8>) {
    let mut r = TerritoryProvince::new(season_id, TerritoryRule::V1, world, c, 30, [9; 32]);
    for &(i, t) in owners {
        r.owner[i] = t;
        r.dist[i] = 1;
    }
    let mut d = vec![0; territory_province::SIZE];
    r.write(&mut d).unwrap();
    (wtr::province_address(&f.ctx, c), d)
}

/// One post-state: the address, its bytes (None: closed) and its owner.
type Post = ([u8; 32], Option<Vec<u8>>, [u8; 32]);

fn tx(seq: u64, post: Vec<Post>) -> TxRecord {
    TxRecord {
        seq,
        slot: 100 + seq,
        signature: Default::default(),
        block_time: 1_794_997_722,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: post
            .into_iter()
            .map(|(k, d, owner)| {
                (
                    Address::new_from_array(k),
                    d.map(|data| Account {
                        lamports: 1,
                        data,
                        owner: Address::new_from_array(owner),
                        executable: false,
                    }),
                )
            })
            .collect(),
        loaded: Default::default(),
    }
}

fn rev(f: &Fold) -> u64 {
    f.wide.as_ref().unwrap().territory_revision()
}

#[test]
fn a_captured_record_is_served_with_its_owned_tiles_and_one_tag_table() {
    let mut f = fold();
    let (k1, d1) = record(&f, coord(130, 0), &[(3, 11), (4, 11), (60, 22)]);
    let (k2, d2) = record(&f, coord(-131, 5), &[(0, 22)]);
    let (k3, d3) = record(&f, coord(129, 1), &[]); // (no owned tile: left out)
    f.apply(&tx(
        1,
        vec![
            (k1, Some(d1), PROGRAM),
            (k2, Some(d2), PROGRAM),
            (k3, Some(d3), PROGRAM),
        ],
    ));
    assert_eq!(rev(&f), 3);
    let v = territory_json(&f).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["readOnly"], true);
    assert_eq!(v["verification"], "captured-unverified");
    assert_eq!(v["season"], "7");
    let tags: Vec<String> = serde_json::from_value(v["tags"].clone()).unwrap();
    let ps = v["provinces"].as_array().unwrap();
    assert_eq!(ps.len(), 2, "{v}");
    let mut seen = std::collections::BTreeMap::new();
    for p in ps {
        let tiles: Vec<(usize, usize, u8)> = serde_json::from_value(p["tiles"].clone()).unwrap();
        assert!(tiles.iter().all(|t| t.2 == 1), "the record's dist");
        assert_eq!(p["owned"].as_u64().unwrap() as usize, tiles.len());
        assert_eq!(p["keepTile"], 30);
        let named: Vec<(usize, String)> = tiles
            .into_iter()
            .map(|(i, n, _)| (i, tags[n].clone()))
            .collect();
        seen.insert(
            format!("{},{}", p["p"].as_str().unwrap(), p["q"].as_str().unwrap()),
            named,
        );
    }
    assert_eq!(
        seen["130,0"],
        vec![(3, "11".into()), (4, "11".into()), (60, "22".into())]
    );
    assert_eq!(seen["-131,5"], vec![(0, "22".into())]);
    assert_eq!(tags.len(), 2, "each tag once");
    assert_eq!(
        ps.iter().find(|p| p["p"] == "130").unwrap()["address"],
        Address::new_from_array(k1).to_string()
    );
}

#[test]
fn a_record_of_another_season_world_address_or_owner_is_refused() {
    let mut f = fold();
    let c = coord(130, 0);
    let world = f.wide.as_ref().unwrap().world();
    let other_world = frontier_abi::world_index::WorldId::new([7; 32]).unwrap();
    let (k, wrong_season) = record_as(&f, c, 8, world, &[(1, 5)]);
    let (_, wrong_world) = record_as(&f, c, 7, other_world, &[(1, 5)]);
    let (_, good) = record(&f, c, &[(1, 5)]);
    let elsewhere = wtr::province_address(&f.ctx, coord(131, 0));
    let refused0 = f.wide.as_ref().unwrap().refused();
    f.apply(&tx(1, vec![(k, Some(wrong_season), PROGRAM)]));
    f.apply(&tx(2, vec![(k, Some(wrong_world), PROGRAM)]));
    f.apply(&tx(3, vec![(elsewhere, Some(good.clone()), PROGRAM)]));
    f.apply(&tx(4, vec![(k, Some(good.clone()), [0x11; 32])]));
    assert_eq!(f.wide.as_ref().unwrap().refused(), refused0 + 4);
    assert_eq!(rev(&f), 0);
    assert!(territory_json(&f).unwrap()["provinces"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(f.account(&k).is_none() && f.account(&elsewhere).is_none());
    // the right one is taken
    f.apply(&tx(5, vec![(k, Some(good), PROGRAM)]));
    assert_eq!(
        territory_json(&f).unwrap()["provinces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn the_revision_moves_on_a_change_and_a_close_but_not_on_the_same_bytes_and_leaves_the_province_index(
) {
    let mut f = fold();
    let c = coord(130, 0);
    let (k, a) = record(&f, c, &[(1, 5)]);
    let (_, b) = record(&f, c, &[(1, 5), (2, 6)]);
    let stamp0 = f.wide.as_ref().unwrap().stamp();
    let epoch0 = f.wide.as_ref().unwrap().epoch();
    f.apply(&tx(1, vec![(k, Some(a.clone()), PROGRAM)]));
    assert_eq!(rev(&f), 1);
    f.apply(&tx(2, vec![(k, Some(a), PROGRAM)]));
    assert_eq!(rev(&f), 1, "the same bytes again: no change");
    f.apply(&tx(3, vec![(k, Some(b), PROGRAM)]));
    assert_eq!(rev(&f), 2);
    assert_eq!(territory_json(&f).unwrap()["provinces"][0]["owned"], 2);
    // (a territory record is not a province entry: the wide index's snapshot is as it was)
    assert_eq!(f.wide.as_ref().unwrap().stamp(), stamp0);
    assert_eq!(f.wide.as_ref().unwrap().epoch(), epoch0);
    assert_eq!(f.wide.as_ref().unwrap().len(), 0);
    f.apply(&tx(4, vec![(k, None, PROGRAM)]));
    assert_eq!(rev(&f), 3);
    assert!(territory_json(&f).unwrap()["provinces"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn a_checkpointed_record_is_indexed_again_on_a_restart() {
    let mut f = fold();
    let (k, d) = record(&f, coord(-130, 2), &[(7, 99)]);
    f.apply(&tx(1, vec![(k, Some(d), PROGRAM)]));
    let st = f.st.clone();
    let mut g = Fold::with_state(
        FoldCfg {
            program: Address::new_from_array(PROGRAM),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/wide-territory-inert"),
        st,
    );
    g.season = f.season.clone();
    let v = territory_json(&g).unwrap();
    assert_eq!(v["provinces"].as_array().unwrap().len(), 1, "{v}");
    assert_eq!(v["provinces"][0]["p"], "-130");
    assert_eq!(v["tags"][0], "99");
}

#[test]
fn no_season_yet_is_refused_by_name() {
    let mut f = fold();
    f.season = None;
    assert_eq!(territory_json(&f).unwrap_err().code(), "NoSeasonYet");
}

// ---------------------------------------------------------------- player summaries (Q-TM2-1)

/// A territory player summary of `f`'s world for `citizen` with `tiles`
/// owned at distance 5 (excess 2 each under V1), at its canonical address.
fn player_as(
    f: &Fold,
    citizen: [u8; 32],
    season_id: u64,
    world: frontier_abi::world_index::WorldId,
    tiles: u32,
) -> ([u8; 32], Vec<u8>) {
    let tag = frontier_abi::addr::citizen_tag(&citizen);
    let mut r = TerritoryPlayer::new(
        season_id,
        TerritoryRule::V1,
        world,
        citizen,
        tag,
        2,
        1_794_000_000,
        [9; 32],
    );
    for _ in 0..tiles {
        r.add_tile(5).unwrap();
    }
    let mut d = vec![0; territory_player::SIZE];
    r.write(&mut d).unwrap();
    (wtr::player_address(&f.ctx, &citizen), d)
}

fn player(f: &Fold, citizen: [u8; 32], tiles: u32) -> ([u8; 32], Vec<u8>) {
    player_as(f, citizen, 7, f.wide.as_ref().unwrap().world(), tiles)
}

#[test]
fn a_captured_player_summary_is_served_for_its_citizen_only() {
    let mut f = fold();
    let (a, b) = ([0xa1; 32], [0xb2; 32]);
    let (ka, da) = player(&f, a, 3);
    let (kb, db) = player(&f, b, 1);
    f.apply(&tx(
        1,
        vec![(ka, Some(da.clone()), PROGRAM), (kb, Some(db), PROGRAM)],
    ));
    // (a summary is not a territory province record: the province answer and its revision are untouched)
    assert_eq!(rev(&f), 0);
    assert!(territory_json(&f).unwrap()["provinces"]
        .as_array()
        .unwrap()
        .is_empty());
    let v = player_json(&f, &a).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["verification"], "captured-unverified");
    assert_eq!(v["citizen"], Address::new_from_array(a).to_string());
    assert_eq!(v["address"], Address::new_from_array(ka).to_string());
    let p = &v["player"];
    assert_eq!(p["tiles"], 3);
    assert_eq!(
        p["citizenTag"],
        frontier_abi::addr::citizen_tag(&a).to_string()
    );
    assert_eq!(
        p["excessSum"], "6",
        "3 tiles at 5 provinces: 2 each beyond 3"
    );
    // V1 (owner Q-CUF-1 (b)): 990 milli-food/h a tile + 480 a province beyond 3
    assert_eq!(p["upkeepMilliPerHour"], (3 * 990 + 480 * 6).to_string());
    // claim cost: 10 ore + 2 % per tile owned (whole ore, rounded down)
    assert_eq!(p["nextClaimCost"], "10");
    assert_eq!(p["unpaid"], false);
    assert_eq!(p["unpaidSince"], Value::Null);
    assert_eq!(p["paidTo"], "1794000000");
    assert_eq!(p["decayAfterBells"], 24);
    assert_eq!(p["rule"], 1);
    assert_eq!(p["slot"], "101");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(p["bytes_b64"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, da, "the captured record itself");
    // the other Citizen's answer names only that Citizen
    assert_eq!(player_json(&f, &b).unwrap()["player"]["tiles"], 1);
    // a Citizen with no summary: null, not an error
    let v = player_json(&f, &[0xc3; 32]).unwrap();
    assert_eq!(v["player"], Value::Null);
}

#[test]
fn an_unpaid_summary_says_since_when_and_a_change_and_close_are_followed() {
    let mut f = fold();
    let a = [0xa1; 32];
    let tag = frontier_abi::addr::citizen_tag(&a);
    let world = f.wide.as_ref().unwrap().world();
    let mut r = TerritoryPlayer::new(7, TerritoryRule::V1, world, a, tag, 1, 50, [9; 32]);
    for _ in 0..100 {
        r.add_tile(1).unwrap();
    }
    r.unpaid_since = Some(4321);
    r.remainder = 77;
    let mut d = vec![0; territory_player::SIZE];
    r.write(&mut d).unwrap();
    let k = wtr::player_address(&f.ctx, &a);
    f.apply(&tx(1, vec![(k, Some(d), PROGRAM)]));
    let p = player_json(&f, &a).unwrap()["player"].clone();
    assert_eq!(
        (p["unpaid"].clone(), p["unpaidSince"].clone()),
        (json!(true), json!(4321))
    );
    assert_eq!(p["nextClaimCost"], "30", "10 + 10 × 100 × 2 %");
    assert_eq!(p["remainder"], "77");
    assert_eq!(p["upkeepMilliPerHour"], "99000");
    f.apply(&tx(2, vec![(k, None, PROGRAM)]));
    assert_eq!(player_json(&f, &a).unwrap()["player"], Value::Null);
    assert_eq!(rev(&f), 0);
}

#[test]
fn a_player_summary_of_another_season_world_address_or_owner_is_refused() {
    let mut f = fold();
    let a = [0xa1; 32];
    let world = f.wide.as_ref().unwrap().world();
    let other_world = frontier_abi::world_index::WorldId::new([7; 32]).unwrap();
    let (k, wrong_season) = player_as(&f, a, 8, world, 1);
    let (_, wrong_world) = player_as(&f, a, 7, other_world, 1);
    let (_, good) = player(&f, a, 1);
    // another Citizen's address holding a's record
    let elsewhere = wtr::player_address(&f.ctx, &[0xb2; 32]);
    let refused0 = f.wide.as_ref().unwrap().refused();
    f.apply(&tx(1, vec![(k, Some(wrong_season), PROGRAM)]));
    f.apply(&tx(2, vec![(k, Some(wrong_world), PROGRAM)]));
    f.apply(&tx(3, vec![(elsewhere, Some(good.clone()), PROGRAM)]));
    f.apply(&tx(4, vec![(k, Some(good.clone()), [0x11; 32])]));
    assert_eq!(f.wide.as_ref().unwrap().refused(), refused0 + 4);
    assert!(f.account(&k).is_none() && f.account(&elsewhere).is_none());
    assert_eq!(player_json(&f, &a).unwrap()["player"], Value::Null);
    assert_eq!(player_json(&f, &[0xb2; 32]).unwrap()["player"], Value::Null);
    f.apply(&tx(5, vec![(k, Some(good), PROGRAM)]));
    assert_eq!(player_json(&f, &a).unwrap()["player"]["tiles"], 1);
}

#[test]
fn a_checkpointed_player_summary_is_served_again_after_a_restart() {
    let mut f = fold();
    let a = [0xa1; 32];
    let (k, d) = player(&f, a, 2);
    f.apply(&tx(1, vec![(k, Some(d), PROGRAM)]));
    let st = f.st.clone();
    let mut g = Fold::with_state(
        FoldCfg {
            program: Address::new_from_array(PROGRAM),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/wide-territory-inert"),
        st,
    );
    g.season = f.season.clone();
    assert_eq!(player_json(&g, &a).unwrap()["player"]["tiles"], 2);
    let mut h = fold();
    h.season = None;
    assert_eq!(player_json(&h, &a).unwrap_err().code(), "NoSeasonYet");
}

/// (test-gaps-territory) The territory routes serve the chain's bytes, over random histories: three province records
/// and two player summaries change by claims, decays, conquests, settles (paid / unpaid since a bell) and closes, one
/// transaction at a time. After each, `/h/world/wide/territory` lists exactly the records' owned tiles (tile, owner tag,
/// stored distance) and nothing else, its revision moves iff a province record's bytes changed (the ETag is built per
/// revision: verify-pr240), and `/h/world/wide/territory/player/{citizen}` carries the captured bytes themselves with
/// the fields read from them (verify-pr242 checked bytes == chain live only).
#[test]
fn served_territory_and_summaries_are_the_chain_bytes_over_random_histories() {
    use std::collections::BTreeMap;
    /// (p, q) → [(tile, owner tag, distance)]
    type Served = BTreeMap<(String, String), Vec<(usize, String, u8)>>;
    struct Lcg(u64);
    impl Lcg {
        fn below(&mut self, n: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) % n.max(1)
        }
    }
    let mut r = Lcg(0x004e_7a1d);
    for case in 0..20u64 {
        let mut f = fold();
        let world = f.wide.as_ref().unwrap().world();
        let coords = [coord(130, 0), coord(-131, 5), coord(129, 1)];
        let tags = [11u64, 22, 33];
        // the chain: each province record (None = closed / never made) and each summary
        let mut provs: Vec<Option<TerritoryProvince>> = vec![None; 3];
        let citizens = [[0xa1u8; 32], [0xb2u8; 32]];
        let mut players: Vec<Option<TerritoryPlayer>> = vec![None; 2];
        let mut last_rev = rev(&f);
        let mut last_bytes: Vec<Option<Vec<u8>>> = vec![None; 3];
        for seq in 1..=40u64 {
            let mut post: Vec<Post> = vec![];
            let mut changed = false;
            let pi = r.below(3) as usize;
            match r.below(6) {
                // claims / decays / a conquest-like owner change on one province
                0..=2 => {
                    let p = provs[pi].get_or_insert_with(|| {
                        TerritoryProvince::new(7, TerritoryRule::V1, world, coords[pi], 30, [9; 32])
                    });
                    for _ in 0..1 + r.below(4) {
                        let t = r.below(61) as usize;
                        if t == 30 {
                            continue;
                        }
                        let tag = if r.below(4) == 0 {
                            0
                        } else {
                            tags[r.below(3) as usize]
                        };
                        p.owner[t] = tag;
                        p.dist[t] = if tag == 0 { 0 } else { r.below(12) as u8 };
                    }
                    let mut d = vec![0; territory_province::SIZE];
                    p.write(&mut d).unwrap();
                    changed = last_bytes[pi].as_ref() != Some(&d);
                    last_bytes[pi] = Some(d.clone());
                    post.push((wtr::province_address(&f.ctx, coords[pi]), Some(d), PROGRAM));
                }
                // the same bytes written again (a settle that left the province as it was)
                3 => {
                    if let Some(d) = last_bytes[pi].clone() {
                        post.push((wtr::province_address(&f.ctx, coords[pi]), Some(d), PROGRAM));
                    }
                }
                // a summary settled: paid, or unpaid since a bell (Q-LP17-1 (b))
                4 => {
                    let i = r.below(2) as usize;
                    let z = citizens[i];
                    let pl = players[i].get_or_insert_with(|| {
                        TerritoryPlayer::new(
                            7,
                            TerritoryRule::V1,
                            world,
                            z,
                            frontier_abi::addr::citizen_tag(&z),
                            1,
                            1_794_000_000,
                            [9; 32],
                        )
                    });
                    pl.add_tile(r.below(9) as u8).unwrap();
                    pl.paid_to += 600;
                    pl.remainder = r.below(3_600);
                    pl.unpaid_since = (r.below(2) == 0).then(|| r.below(5_000) as u32);
                    let mut d = vec![0; territory_player::SIZE];
                    pl.write(&mut d).unwrap();
                    post.push((wtr::player_address(&f.ctx, &z), Some(d), PROGRAM));
                }
                // a province record closed
                _ => {
                    if last_bytes[pi].is_some() {
                        provs[pi] = None;
                        last_bytes[pi] = None;
                        changed = true;
                        post.push((wtr::province_address(&f.ctx, coords[pi]), None, PROGRAM));
                    }
                }
            }
            f.apply(&tx(seq, post));
            let now = rev(&f);
            assert_eq!(
                now != last_rev,
                changed,
                "case {case} seq {seq}: the revision moves iff the bytes did"
            );
            last_rev = now;
            // the province answer = the records' owned tiles
            let v = territory_json(&f).unwrap();
            let served_tags: Vec<String> = serde_json::from_value(v["tags"].clone()).unwrap();
            let mut served: Served = BTreeMap::new();
            for p in v["provinces"].as_array().unwrap() {
                let tiles: Vec<(usize, usize, u8)> =
                    serde_json::from_value(p["tiles"].clone()).unwrap();
                assert_eq!(p["owned"].as_u64().unwrap() as usize, tiles.len());
                served.insert(
                    (
                        p["p"].as_str().unwrap().into(),
                        p["q"].as_str().unwrap().into(),
                    ),
                    tiles
                        .into_iter()
                        .map(|(i, n, d)| (i, served_tags[n].clone(), d))
                        .collect(),
                );
            }
            let mut want: Served = BTreeMap::new();
            for (i, p) in provs.iter().enumerate() {
                let Some(p) = p else { continue };
                let t: Vec<(usize, String, u8)> = (0..61)
                    .filter(|&k| p.owner[k] != 0)
                    .map(|k| (k, p.owner[k].to_string(), p.dist[k]))
                    .collect();
                if !t.is_empty() {
                    want.insert((coords[i].p().to_string(), coords[i].q().to_string()), t);
                }
            }
            assert_eq!(served, want, "case {case} seq {seq}");
            // each summary answer carries the chain's bytes and reads from them
            for (i, z) in citizens.iter().enumerate() {
                let a = player_json(&f, z).unwrap();
                match &players[i] {
                    None => assert_eq!(a["player"], Value::Null),
                    Some(pl) => {
                        let mut d = vec![0; territory_player::SIZE];
                        pl.write(&mut d).unwrap();
                        let p = &a["player"];
                        let b = base64::engine::general_purpose::STANDARD
                            .decode(p["bytes_b64"].as_str().unwrap())
                            .unwrap();
                        assert_eq!(b, d, "case {case} seq {seq}: the captured bytes");
                        assert_eq!(p["tiles"], pl.tiles);
                        assert_eq!(p["unpaid"], pl.unpaid_since.is_some());
                        assert_eq!(p["unpaidSince"], json!(pl.unpaid_since));
                        assert_eq!(
                            p["upkeepMilliPerHour"],
                            json!(pl.upkeep_per_hour().map(|x| x.to_string()))
                        );
                        assert_eq!(p["remainder"], pl.remainder.to_string());
                        assert_eq!(p["paidTo"], pl.paid_to.to_string());
                    }
                }
            }
        }
    }
}
