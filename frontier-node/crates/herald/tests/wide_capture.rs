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
        open_transits: 0,
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

#[test]
fn current_writer_event_is_v82_with_standing_separate_and_never_legacy_success() {
    use base64::Engine;
    use fclient::log::{bodies_from_logs, LogError};
    use frontier_abi::world_index::{event as e, ProvinceKey, WideHostRef};
    let f = fold();
    let world = f.wide.as_ref().unwrap().world();
    let home = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let standing = ProvinceKey::new(world, WideCoord::checked(9_007_199_254_740_993, 0).unwrap());
    let host = WideHostRef::new(home, 2, 1, 7).unwrap();
    let key = e::host_key(&host, standing);
    let payload = e::muster_payload(0, 300, 17, 0, 1);
    // Literal chain heads test the wire decoder only, not validity of a game event chain.
    let links = [
        e::WideLink {
            entity: e::WideEntity::Province,
            seq: 1,
            head: [2; 32],
        },
        e::WideLink {
            entity: e::WideEntity::Holding,
            seq: 1,
            head: [3; 32],
        },
    ];
    let body = e::encode(e::WideKind::Muster, 42, &key, &payload, &links).unwrap();
    assert_eq!(body[0], 0x82);
    let decoded = e::WideRecord::decode(&body).unwrap();
    assert_eq!(decoded.home_of(), Some(home));
    assert_eq!(decoded.province_of(), Some(standing));
    assert_ne!(decoded.home_of(), decoded.province_of());
    let b64 = base64::engine::general_purpose::STANDARD;
    let logs = vec![
        format!("Program {} invoke [1]", f.cfg.program),
        format!(
            "Program data: {} {}",
            b64.encode(b"PSW1"),
            b64.encode(&body)
        ),
        format!("Program {} success", f.cfg.program),
    ];
    assert_eq!(
        bodies_from_logs(&logs, &f.cfg.program),
        Err(LogError::UnsupportedWideRecord)
    );
    let mut old = body.clone();
    old[0] = 0x81;
    assert_eq!(
        e::WideRecord::decode(&old),
        Err(e::EventError::RetiredVersion(0x81))
    );
    old[0] = 0x83;
    assert_eq!(
        e::WideRecord::decode(&old),
        Err(e::EventError::Version(0x83))
    );
}

#[test]
fn new_holding_open_transits_field_is_captured_and_unknown_layout_is_not_empty() {
    let mut f = fold();
    let c = WideCoord::checked(129, 0).unwrap();
    let (pk, pd) = province(&f, c);
    let (hk, mut hd) = holding(&f, c, 2);
    hd[holding::wide_holding::HOST_IDENTITY..holding::wide_holding::HOST_IDENTITY + 2]
        .copy_from_slice(
            &frontier_abi::world_index::march::HOST_IDENTITY_FULL_REF_V1.to_le_bytes(),
        );
    hd[holding::wide_holding::OPEN_TRANSITS] = 1;
    assert_eq!(WideHolding::read(&hd).unwrap().open_transits, 1);
    apply(&mut f, pk, Some(pd), fixture::program());
    apply(&mut f, hk, Some(hd.clone()), fixture::program());
    assert_eq!(
        entry(&f, c)["wide"]["holdings"].as_array().unwrap().len(),
        1
    );
    let mut unknown = hd.clone();
    unknown[frontier_abi::layout::header::LAYOUT_VERSION
        ..frontier_abi::layout::header::LAYOUT_VERSION + 2]
        .copy_from_slice(&4u16.to_le_bytes());
    apply(&mut f, hk, Some(unknown), fixture::program());
    assert_eq!(f.account(&hk).unwrap().data, hd);
    assert_eq!(
        WideHolding::read(&f.account(&hk).unwrap().data)
            .unwrap()
            .open_transits,
        1
    );
    assert_eq!(wide::manifest_json(&f).unwrap()["refused"], 1);
}

#[test]
fn current_close_wire_shapes_remain_unsupported_by_legacy_history() {
    use base64::Engine;
    use fclient::log::{bodies_from_logs, body_of_line, LogError};
    use frontier_abi::world_index::{event as e, ProvinceKey, WideHostRef};
    let f = fold();
    let key = ProvinceKey::new(
        f.wide.as_ref().unwrap().world(),
        WideCoord::checked(9_007_199_254_740_993, -130).unwrap(),
    );
    let host = WideHostRef::new(key, 2, 1, 7).unwrap();
    // Literal link tests the ProvinceClosed wire shape, not terminal chain validity.
    let link = e::WideLink {
        entity: e::WideEntity::Province,
        seq: 9,
        head: [4; 32],
    };
    let cases = [
        (
            e::WideKind::RecordClosed,
            e::encode(
                e::WideKind::RecordClosed,
                42,
                &key.to_bytes(),
                &e::record_closed_payload(2, 40, 1, 0, &[5; 32], 100),
                &[],
            )
            .unwrap(),
        ),
        (
            e::WideKind::TransitClosed,
            e::encode(
                e::WideKind::TransitClosed,
                42,
                &e::host_key(&host, key),
                &e::transit_closed_payload(0, &[5; 32], 100),
                &[],
            )
            .unwrap(),
        ),
        (
            e::WideKind::ProvinceClosed,
            e::encode(
                e::WideKind::ProvinceClosed,
                42,
                &key.to_bytes(),
                &e::province_closed_payload(&[6; 32], 100),
                &[link],
            )
            .unwrap(),
        ),
    ];
    let b64 = base64::engine::general_purpose::STANDARD;
    for (kind, body) in cases {
        assert_eq!(&body[..2], &[0x82, kind as u8]);
        let record = e::WideRecord::decode(&body).unwrap();
        assert_eq!(record.kind, kind);
        assert_eq!(record.province_of(), Some(key));
        if kind == e::WideKind::ProvinceClosed {
            assert_eq!(record.links, [Some(link), None]);
        } else {
            assert_eq!(record.links, [None, None]);
        }
        let line = format!(
            "Program data: {} {}",
            b64.encode(b"PSW1"),
            b64.encode(&body)
        );
        let logs = vec![
            format!("Program {} invoke [1]", f.cfg.program),
            line.clone(),
            format!("Program {} success", f.cfg.program),
        ];
        assert_eq!(body_of_line(&line), Err(LogError::UnsupportedWideRecord));
        assert_eq!(
            bodies_from_logs(&logs, &f.cfg.program),
            Err(LogError::UnsupportedWideRecord)
        );
    }
}

#[test]
fn current_close_account_tables_match_the_writer_without_legacy_dispatch() {
    use frontier_abi::{
        prologue::{bounds_in, position_in},
        world_index::wide_ix as ix,
    };
    for (what, bounds, target, position) in [
        (2, (4, 5), "slot", 2),
        (3, (5, 5), "day", 3),
        (4, (5, 5), "inputs", 3),
        (5, (5, 5), "transit", 2),
        (6, (4, 4), "province", 2),
    ] {
        let bytes = [ix::Close::IX.tag(), what];
        let command = ix::WideCommand::decode(&bytes).unwrap();
        assert_eq!(command, ix::WideCommand::Close(ix::Close { what }));
        assert_eq!(bounds_in(command.accounts()), bounds);
        assert_eq!(
            position_in(command.accounts(), bounds.0, target, 0),
            Some(position)
        );
        assert_eq!(command.class(), frontier_abi::tags::Class::N);
        assert!(!command.is_player() && !command.march_stage());
    }
    assert!(ix::WideCommand::decode(&[ix::Close::IX.tag(), 7]).is_err());
}

#[test]
fn explicit_province_and_holding_closes_work_in_either_order_without_reopening_land() {
    for province_first in [true, false] {
        let mut f = fold();
        let c = WideCoord::checked(9_007_199_254_740_993, -130).unwrap();
        let (pk, pd) = province(&f, c);
        let (hk, hd) = holding(&f, c, 2);
        apply(&mut f, pk, Some(pd), fixture::program());
        apply(&mut f, hk, Some(hd), fixture::program());
        let order = if province_first { [pk, hk] } else { [hk, pk] };
        apply(&mut f, order[0], None, fixture::program());
        assert_eq!(
            entry(&f, c)["state"],
            if province_first { "closed" } else { "open" }
        );
        apply(&mut f, order[1], None, fixture::program());
        assert_eq!(entry(&f, c)["state"], "closed");
        assert!(entry(&f, c)["wide"].is_null());
        assert!(f.account(&pk).is_none());
        assert!(f.account(&hk).is_none());
        assert_eq!(wide::manifest_json(&f).unwrap()["refused"], 0);
    }
}
