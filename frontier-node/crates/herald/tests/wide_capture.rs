//! Keyless synthetic account-capture tests, not a live-world run or a proof of PSW1 history.
#![cfg(feature = "wide-world-experimental")]
mod common;
use fclient::ports::{Account, Signature, TxRecord};
use frontier_abi::world_index::{
    holding::{self, WideHolding},
    land::{self, WideProvince},
    WideCoord,
};
use herald_fold::{
    clash::Provisional,
    files::Out,
    fixture,
    fold::{Fold, FoldCfg},
    wide,
};
use serde_json::Value;
use solana_address::Address;
use std::sync::Arc;

fn fold() -> Fold {
    let mut f = Fold::new(
        FoldCfg {
            program: fixture::program(),
            season_id: fixture::SEASON_ID,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new(common::tmp("wide-capture")),
    );
    for tx in fixture::mini_season(1) {
        f.apply(&tx);
    }
    f
}
fn province(f: &Fold, c: WideCoord) -> ([u8; 32], Vec<u8>) {
    let p = WideProvince {
        season_id: f.cfg.season_id,
        world: f.wide.as_ref().unwrap().world(),
        coord: c,
        wedge: c.wedge().unwrap(),
        region: 3,
        opened_bell: 5,
        readiness: land::readiness::REQUIRED,
        seed_round: 99,
        ring_seed: [7; 32],
        funded_lamports: 10,
    };
    let mut d = vec![0; land::province::SIZE];
    p.write_identity(&mut d).unwrap();
    d[frontier_abi::v2::layout::province::province::KEEP
        + frontier_abi::v2::layout::province::keep::HOLDER] = 4;
    (land::province_address(&f.ctx, c), d)
}
fn holding(f: &Fold, c: WideCoord, site: u8) -> ([u8; 32], Vec<u8>) {
    let h = WideHolding {
        season_id: f.cfg.season_id,
        world: f.wide.as_ref().unwrap().world(),
        coord: c,
        site,
        gen: 1,
        slot: 2,
        owner_citizen: [9; 32],
        host_identity: 0,
    };
    let mut d = vec![0; holding::wide_holding::SIZE];
    h.write_identity(&mut d).unwrap();
    (holding::holding_address(&f.ctx, c, site), d)
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
        post: vec![(
            Address::new_from_array(key),
            data.map(|data| Account {
                owner,
                data,
                lamports: 10,
                executable: false,
            }),
        )],
    });
}
fn entry(f: &Fold, c: WideCoord) -> Value {
    wide::page_json(f, None, Some(256)).unwrap()["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["p"] == c.p().to_string() && e["q"] == c.q().to_string())
        .unwrap()
        .clone()
}

#[test]
fn captures_full_width_land_and_holdings_without_legacy_alias_and_survives_restart() {
    let mut f = fold();
    let c = WideCoord::checked(9_007_199_254_740_993, -130).unwrap();
    let legacy = f.provinces.len();
    let (pk, pd) = province(&f, c);
    let (hk, hd) = holding(&f, c, 3);
    apply(&mut f, pk, Some(pd.clone()), fixture::program());
    apply(&mut f, hk, Some(hd.clone()), fixture::program());
    assert_eq!(f.provinces.len(), legacy);
    assert!(!f.provinces.contains_key(&(0, 0)));
    let e = entry(&f, c);
    assert_eq!(e["p"], "9007199254740993");
    assert!(e["legacy"].is_null());
    assert_eq!(e["wide"]["keepHolder"], 4);
    assert_eq!(e["wide"]["capture"]["verification"], "captured-unverified");
    assert_eq!(e["wide"]["capture"]["postState"], "transaction");
    assert_eq!(e["wide"]["holdings"][0]["site"], 3);
    assert_eq!(e["wide"]["holdings"][0]["inventorySlot"], 2);
    assert_eq!(f.account(&pk).unwrap().data, pd);
    assert_eq!(f.account(&hk).unwrap().data, hd);
    let mut cfg = f.cfg.clone();
    cfg.exact_post = false;
    let checkpoint =
        herald_fold::checkpoint::encode(&f.cfg.program.to_bytes(), f.cfg.season_id, &f.st);
    let st =
        herald_fold::checkpoint::decode(&f.cfg.program.to_bytes(), f.cfg.season_id, &checkpoint)
            .unwrap();
    let restored = Fold::with_state(cfg, Out::new(common::tmp("wide-restored")), st);
    let e = entry(&restored, c);
    assert_eq!(e["wide"]["holdings"].as_array().unwrap().len(), 1);
    assert_eq!(e["wide"]["capture"]["postState"], "at-or-after-transaction");
}

#[test]
fn refuses_forged_world_address_owner_and_invalid_replacements_without_faking_close() {
    let mut f = fold();
    let c = WideCoord::checked(129, 0).unwrap();
    let (pk, pd) = province(&f, c);
    let mut bad_world = pd.clone();
    bad_world[land::province::WORLD..land::province::WORLD + 32].fill(8);
    apply(&mut f, pk, Some(bad_world), fixture::program());
    apply(&mut f, [55; 32], Some(pd.clone()), fixture::program());
    apply(
        &mut f,
        pk,
        Some(pd.clone()),
        Address::new_from_array([56; 32]),
    );
    assert!(f.account(&pk).is_none());
    apply(&mut f, pk, Some(pd.clone()), fixture::program());
    apply(&mut f, pk, Some(vec![0; 17]), fixture::program());
    assert_eq!(entry(&f, c)["state"], "open");
    assert_eq!(f.account(&pk).unwrap().data, pd);
    assert_eq!(wide::manifest_json(&f).unwrap()["refused"], 4);
    apply(&mut f, pk, None, fixture::program());
    assert_eq!(entry(&f, c)["state"], "closed");
    assert!(entry(&f, c)["wide"].is_null());
}

#[test]
fn holding_changes_invalidate_page_snapshot_and_close_removes_only_the_holding() {
    let mut f = fold();
    let c = WideCoord::checked(129, 0).unwrap();
    let (pk, pd) = province(&f, c);
    let (hk, hd) = holding(&f, c, 2);
    apply(&mut f, pk, Some(pd), fixture::program());
    let before = wide::manifest_json(&f).unwrap()["snapshot"].clone();
    apply(&mut f, hk, Some(hd), fixture::program());
    assert_ne!(wide::manifest_json(&f).unwrap()["snapshot"], before);
    apply(&mut f, hk, None, fixture::program());
    assert_eq!(entry(&f, c)["state"], "open");
    assert!(entry(&f, c)["wide"]["holdings"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn me_reports_wide_slot_as_unknown_until_the_matching_capture_arrives() {
    use frontier_abi::v2::layout::player::{citizen as C, holding as H};
    let mut f = fold();
    let ca = f.ctx.citizen(&fixture::wallet().to_bytes());
    let mut cd = f.account(&ca).unwrap().data.clone();
    // Synthetic Citizen inventory: slot 2 wide, slot 3 empty.
    cd[C::holding_of_slot(2)..C::holding_of_slot(2) + 6].copy_from_slice(&[0, 0, 0, 0, 12, 0]);
    cd[C::holding_of_slot(3) + 5] = 255;
    apply(&mut f, ca, Some(cd), fixture::program());
    let view = herald_fold::views::me_json(&f, &fixture::wallet(), Value::Null);
    assert_eq!(view["wideHoldings"][0]["status"], "not-captured");
    assert!(view["wideHoldings"][0]["holding"].is_null());
    let c = WideCoord::checked(129, 0).unwrap();
    let (hk, mut hd) = holding(&f, c, 2);
    hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(&ca);
    apply(&mut f, hk, Some(hd), fixture::program());
    let view = herald_fold::views::me_json(&f, &fixture::wallet(), Value::Null);
    assert_eq!(view["wideHoldings"][0]["status"], "captured-unverified");
    assert_eq!(view["wideHoldings"][0]["holding"]["p"], "129");
    assert_eq!(view["wideHoldings"][0]["holding"]["site"], 2);
}
