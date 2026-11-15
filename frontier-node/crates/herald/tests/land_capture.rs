//! The land preview in the herald (feature `land-preview`): a program-owned land record of this season (PSFLAND1) is
//! kept as a capture and rides the province envelope as `land`; a record of another season or owner is dropped; a
//! closed record leaves the envelope. Keyless synthetic captures over the fixture season; not a live-world run.
#![cfg(feature = "land-preview")]
mod common;
use base64::Engine as _;
use fclient::ports::{Account, Signature, TxRecord};
use frontier_abi::land_preview::{self as fl, land as LD, LandHeader};
use herald_fold::{
    clash::Provisional,
    files::Out,
    fixture,
    fold::{Fold, FoldCfg},
};
use permutation_rules::frontier::land::Land;
use solana_address::Address;
use std::sync::Arc;

fn fold() -> Fold {
    let mut f = Fold::new(
        FoldCfg { program: fixture::program(), season_id: fixture::SEASON_ID, builder: Arc::new(Provisional), exact_post: true },
        Out::new(common::tmp("land-capture")),
    );
    for tx in fixture::mini_season(1) {
        f.apply(&tx);
    }
    f
}

fn apply(f: &mut Fold, key: [u8; 32], data: Option<Vec<u8>>, owner: Address) {
    let seq = f.st.folded_through + 1;
    f.apply(&TxRecord {
        seq,
        slot: seq + 100,
        signature: Signature::from([0; 64]),
        block_time: 0,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![(Address::new_from_array(key), data.map(|data| Account { owner, data, lamports: 10, executable: false }))],
    });
}

/// A land record of `(p, q)` for `season` with nation 2 holding tiles 3 and 4.
fn record(p: i16, q: i16, season: u64) -> Vec<u8> {
    let mut d = vec![0u8; LD::SIZE];
    fl::write_header(&mut d, &LandHeader { season_id: season, p, q, yield_bell: [0; 12] }).unwrap();
    let mut l = Land::new(7);
    l.owner[3] = 2;
    l.owner[4] = 2;
    fl::write_land(&mut d, &l).unwrap();
    d
}

fn land_of(f: &Fold, pq: (i16, i16)) -> Option<serde_json::Value> {
    let env = f.envelope(pq, 1)?;
    let l = env.get("land")?.clone();
    (!l.is_null()).then_some(l)
}

#[test]
fn a_land_record_rides_the_province_envelope_and_leaves_with_its_account() {
    let mut f = fold();
    let pq = *f.provinces.keys().next().expect("the fixture opens a province");
    assert!(land_of(&f, pq).is_none(), "no land record: no `land`");
    let key = fl::land_address(&f.ctx, pq.0, pq.1);
    let data = record(pq.0, pq.1, fixture::SEASON_ID);
    apply(&mut f, key, Some(data.clone()), fixture::program());
    let l = land_of(&f, pq).expect("the land rides the envelope");
    assert_eq!(l["key"], format!("ld:{},{}", pq.0, pq.1));
    let bytes = base64::engine::general_purpose::STANDARD.decode(l["bytes"].as_str().unwrap()).unwrap();
    assert_eq!(bytes, data, "the record's bytes, as the program wrote them");
    assert_eq!(fl::read_land(&bytes).unwrap().tiles_of(2), 2);
    // closed: it leaves the envelope
    apply(&mut f, key, None, fixture::program());
    assert!(land_of(&f, pq).is_none());
}

#[test]
fn a_record_of_another_season_or_owner_is_dropped() {
    let mut f = fold();
    let pq = *f.provinces.keys().next().unwrap();
    let key = fl::land_address(&f.ctx, pq.0, pq.1);
    apply(&mut f, key, Some(record(pq.0, pq.1, fixture::SEASON_ID + 1)), fixture::program());
    assert!(land_of(&f, pq).is_none(), "another season");
    apply(&mut f, key, Some(record(pq.0, pq.1, fixture::SEASON_ID)), Address::new_from_array([9; 32]));
    assert!(land_of(&f, pq).is_none(), "another owner");
    let mut short = record(pq.0, pq.1, fixture::SEASON_ID);
    short.truncate(256);
    apply(&mut f, key, Some(short), fixture::program());
    assert!(land_of(&f, pq).is_none(), "not 272 bytes");
}
