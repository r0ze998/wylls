//! Keyless in-memory reads only: no fixture archive, transaction dispatch or IO.
use super::*;
use crate::{
    clash::Provisional,
    files::Out,
    fold::{FoldCfg, ProvMeta},
};
use frontier_abi::{
    layout::{header, world::season},
    v2::layout::province::province as P,
};
use std::sync::Arc;

fn fold() -> Fold {
    let mut f = Fold::new(
        FoldCfg {
            program: Address::new_from_array([0x5e; 32]),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/wide-route-inert"),
    );
    let mut data = vec![0; season::SIZE];
    data[..8].copy_from_slice(&season::MAGIC);
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[season::PROGRAM_VERSION..season::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    f.season = Some(fclient::decode::Season::decode(&data).unwrap());
    f.st.last_slot = 9007199254741009;
    f.st.folded_through = 9007199254741008;
    f
}

fn put(f: &mut Fold, p: i64, q: i64) -> [u8; 32] {
    let coord = WideCoord::checked(p, q).unwrap();
    let wide = coord.ring() > R_MAX_HARD as u64;
    let mut data = vec![0; if wide { land::province::SIZE } else { P::SIZE }];
    data[..8].copy_from_slice(if wide {
        &land::province::MAGIC
    } else {
        &P::MAGIC
    });
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    let version = if wide { land::WIDE_LAYOUT_VERSION } else { 2 };
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2]
        .copy_from_slice(&version.to_le_bytes());
    data[P::WEDGE] = coord.wedge().unwrap_or(0);
    let key = if wide {
        use land::province as W;
        data[W::FAMILY_VERSION..W::FAMILY_VERSION + 2]
            .copy_from_slice(&land::WIDE_LAND_FAMILY_VERSION.to_le_bytes());
        data[W::STATUS] = W::STATUS_OPENED;
        data[W::READINESS] = land::readiness::REQUIRED;
        data[W::WORLD..W::WORLD + 32].copy_from_slice(f.wide.as_ref().unwrap().world().as_bytes());
        data[W::SORT_KEY..W::SORT_KEY + 17].copy_from_slice(&coord.sort_key());
        data[W::RING_SEED..W::RING_SEED + 32].fill(42);
        land::province_address(&f.ctx, coord)
    } else {
        data[P::P..P::P + 2].copy_from_slice(&(p as i16).to_le_bytes());
        data[P::Q..P::Q + 2].copy_from_slice(&(q as i16).to_le_bytes());
        data[P::RING..P::RING + 2].copy_from_slice(&(coord.ring() as u16).to_le_bytes());
        f.ctx.province(p as i32, q as i32)
    };
    f.st.accounts.insert(
        key,
        Capture {
            slot: 9007199254740999,
            tx: 9007199254740997,
            data: data.clone(),
        },
    );
    if wide {
        assert!(index_capture(f, &key, &data));
    } else {
        f.provinces.insert(
            (p as i16, q as i16),
            ProvMeta {
                ring: coord.ring() as u16,
                region: 0,
                first: 0,
                addr: key,
            },
        );
        f.wide.as_mut().unwrap().observe_open(p as i16, q as i16, 0);
    }
    key
}

fn route(f: &Fold, at: &str) -> Value {
    route_json(f, &parse_route(at).unwrap()).unwrap()
}

#[test]
fn route_parser_enforces_canonical_exact_bounds_distinctness_and_four_limit() {
    let at = "4611686018427387904,-4611686018427387904;9007199254740993,0;128,0;129,0";
    let parsed = parse_route(at).unwrap();
    assert_eq!(parsed.len(), 4);
    assert_eq!(parsed[0].p(), 1i64 << 62);
    assert_eq!(parsed[0].q(), -(1i64 << 62));
    assert_eq!(parsed[1].p(), (1i64 << 53) + 1);
    for bad in [
        "",
        "0",
        "0,",
        ",0",
        "0,0;",
        "0,0,0",
        "0,0;0,0",
        "0,0;1,0;2,0;3,0;4,0",
        "01,0",
        "-0,0",
        "+1,0",
        " 1,0",
        "1, 0",
        "1,0\n",
        "1e2,0",
        "1.0,0",
        "4611686018427387905,0",
        "0,-4611686018427387905",
        "9223372036854775808,0",
        "０,0",
    ] {
        assert_eq!(parse_route(bad), Err(WideFault::BadRoute), "{bad}");
    }
    assert_eq!(WideFault::BadRoute.status(), 400);
    assert_eq!(WideFault::BadRoute.code(), "BadRoute");
    let f = fold();
    assert_eq!(route_json(&f, &[]), Err(WideFault::BadRoute));
    assert_eq!(route_json(&f, &[parsed[0]; 2]), Err(WideFault::BadRoute));
    assert_eq!(route_json(&f, &[parsed[0]; 5]), Err(WideFault::BadRoute));
}

#[test]
fn route_returns_original_and_wide_captures_in_request_order_with_manifest_scope() {
    let mut f = fold();
    let keys = [
        put(&mut f, 129, 0),
        put(&mut f, 128, 0),
        put(&mut f, 9007199254740993, 0),
        put(&mut f, -(1i64 << 62), 0),
    ];
    let v = route(&f, "129,0;128,0;9007199254740993,0;-4611686018427387904,0");
    let mut envelope = v.clone();
    envelope.as_object_mut().unwrap().remove("route");
    assert_eq!(envelope, manifest_json(&f).unwrap());
    assert_eq!(v["readOnly"], true);
    assert_eq!(v["experimental"], true);
    assert_eq!(v["completeness"], "captured");
    assert_eq!(v["snapshot"]["lastSlot"], "9007199254741009");
    for ((entry, key), p) in v["route"].as_array().unwrap().iter().zip(keys).zip([
        "129",
        "128",
        "9007199254740993",
        "-4611686018427387904",
    ]) {
        assert_eq!(entry["p"], p);
        assert_eq!(entry["q"], "0");
        assert_eq!(entry["state"], "captured");
        assert_eq!(entry["capture"], capture_json(&f, &key));
        assert_eq!(entry["capture"]["slot"], "9007199254740999");
        assert_eq!(entry["capture"]["archiveSequence"], "9007199254740997");
        assert_eq!(entry["capture"]["verification"], "captured-unverified");
        assert_eq!(entry["capture"]["postState"], "transaction");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(entry["capture"]["bytes_b64"].as_str().unwrap())
            .unwrap();
        assert_eq!(raw, f.account(&key).unwrap().data);
    }
    f.cfg.exact_post = false;
    assert_eq!(
        route(&f, "128,0")["route"][0]["capture"]["postState"],
        "at-or-after-transaction"
    );
}

#[test]
fn route_missing_closed_and_unrelated_index_entries_do_not_fabricate_land() {
    let mut f = fold();
    let key = put(&mut f, 129, 0);
    let known = route(&f, "129,0;130,0")["route"].clone();
    for p in 200..1224 {
        let w = f.wide.as_mut().unwrap();
        w.report_key(
            ProvinceKey::new(w.world(), WideCoord::checked(p, 0).unwrap()),
            ReportedState::Open,
            1,
            false,
        );
    }
    assert_eq!(route(&f, "129,0;130,0")["route"], known);
    f.st.accounts.remove(&key);
    assert_eq!(
        route(&f, "129,0;200,0;0,0")["route"],
        json!([
        {"p":"129","q":"0","state":"unknown","capture":null},
        {"p":"200","q":"0","state":"unknown","capture":null},
        {"p":"0","q":"0","state":"unknown","capture":null}])
    );
    let w = f.wide.as_mut().unwrap();
    w.report_key(
        ProvinceKey::new(w.world(), WideCoord::checked(129, 0).unwrap()),
        ReportedState::Closed,
        2,
        false,
    );
    assert_eq!(route(&f, "129,0")["route"][0]["state"], "closed");
    assert!(route(&f, "129,0")["route"][0]["capture"].is_null());
    f.season = None;
    assert_eq!(
        route_json(&f, &parse_route("129,0").unwrap()),
        Err(WideFault::NoSeasonYet)
    );
}

#[test]
fn route_refuses_mismatched_original_or_wide_capture_identities() {
    let mut f = fold();
    for p in [128, 129] {
        let key = put(&mut f, p, 0);
        let original = f.account(&key).unwrap().data.clone();
        let offsets = if p == 128 {
            vec![
                0,
                header::SEASON_ID,
                header::LAYOUT_VERSION,
                P::P,
                P::Q,
                P::RING,
                P::WEDGE,
            ]
        } else {
            vec![
                0,
                header::SEASON_ID,
                header::LAYOUT_VERSION,
                land::province::WORLD,
                land::province::SORT_KEY,
                land::province::READINESS,
                P::P,
            ]
        };
        for offset in offsets {
            let c = f.st.accounts.get_mut(&key).unwrap();
            c.data = original.clone();
            c.data[offset] ^= 1;
            let v = route(&f, &format!("{p},0"));
            assert_eq!(v["route"][0]["state"], "unknown", "p={p} offset={offset}");
            assert!(v["route"][0]["capture"].is_null());
        }
        f.st.accounts.get_mut(&key).unwrap().data = original;
        let wrong_key = [0x73; 32];
        let capture = f.account(&key).unwrap().clone();
        f.st.accounts.insert(wrong_key, capture);
        if p == 128 {
            f.provinces.get_mut(&(128, 0)).unwrap().addr = wrong_key;
        } else {
            f.wide
                .as_mut()
                .unwrap()
                .provinces
                .insert(WideCoord::checked(p, 0).unwrap(), wrong_key);
        }
        assert_eq!(route(&f, &format!("{p},0"))["route"][0]["state"], "unknown");
    }
    let key = put(&mut f, 127, 0);
    f.st.accounts.get_mut(&key).unwrap().data.truncate(4096);
    assert_eq!(route(&f, "127,0")["route"][0]["state"], "unknown");
}
