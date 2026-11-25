//! Exercise the handler and query extractor without opening a listener.
use super::*;
use crate::{clash::Provisional, fold::FoldCfg};
use fclient::ports::ChainInfo;

fn app(cluster: &str) -> Shared {
    let fold = Fold::new(
        FoldCfg {
            program: Address::new_from_array([0x5e; 32]),
            season_id: 7,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/wide-route-handler-inert"),
    );
    let (diffs, _) = broadcast::channel(1);
    Arc::new(App::new(
        Arc::new(RwLock::new(fold)),
        Out::new("/dev/null/wide-route-handler-inert"),
        SeasonStatic {
            cluster: cluster.into(),
            quotas: json!({}),
            drand: ChainInfo {
                public_key: [0; 96],
                period: 3,
                genesis_time: 0,
                genesis_seed: [0; 32],
                chain_hash: [0; 32],
                scheme: "unused".into(),
                beacon_id: "unused".into(),
            },
        },
        diffs,
    ))
}

async fn answer(res: Response) -> (StatusCode, Value) {
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), 100_000)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[cfg(feature = "wide-world-experimental")]
async fn get(app: &Shared, query: &str) -> (StatusCode, Value) {
    let uri: Uri = format!("/h/world/wide/route{query}").parse().unwrap();
    let query = Query::<Vec<(String, String)>>::try_from_uri(&uri).unwrap();
    answer(world_wide_route(State(app.clone()), query).await).await
}

#[cfg(feature = "wide-world-experimental")]
#[tokio::test]
async fn route_handler_refuses_bad_queries_fixture_and_missing_season_without_listener() {
    let app = app("localnet");
    for query in [
        "",
        "?at=",
        "?at=1,0&at=2,0",
        "?at=1,0&limit=4",
        "?other=1,0",
        "?at=1,0;1,0",
        "?at=0,0;1,0;2,0;3,0;4,0",
        "?at=%2B1,0",
        "?at=4611686018427387905,0",
    ] {
        let (status, value) = get(&app, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(value["code"], "BadRoute");
    }
    let (status, value) = get(&app, "?at=128,0;129,0").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "NoSeasonYet");
    let fixture = self::app(" Fixture ");
    let (status, value) = get(&fixture, "?at=128,0;129,0").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "FixtureWorldUnavailable");
}

#[cfg(feature = "wide-world-experimental")]
#[tokio::test]
async fn route_handler_preserves_exact_unknown_coordinates_and_scope_without_listener() {
    use frontier_abi::layout::{header, world::season};
    let app = app("localnet");
    let mut data = vec![0; season::SIZE];
    data[..8].copy_from_slice(&season::MAGIC);
    data[header::SEASON_ID..header::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[season::PROGRAM_VERSION..season::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    app.fold.write().unwrap().season = Some(fclient::decode::Season::decode(&data).unwrap());
    let expected = crate::wide::manifest_json(&app.fold.read().unwrap()).unwrap();
    let (status, mut value) = get(
        &app,
        "?at=9007199254740993,0%3B-4611686018427387904,0%3B128,0%3B129,0",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        value.as_object_mut().unwrap().remove("route").unwrap(),
        json!([
        {"p":"9007199254740993","q":"0","state":"unknown","capture":null},
        {"p":"-4611686018427387904","q":"0","state":"unknown","capture":null},
        {"p":"128","q":"0","state":"unknown","capture":null},
        {"p":"129","q":"0","state":"unknown","capture":null}])
    );
    assert_eq!(value, expected);
}

#[cfg(not(feature = "wide-world-experimental"))]
#[tokio::test]
async fn route_handler_feature_off_is_unavailable_without_listener() {
    let (status, value) = answer(world_wide_route(State(app("localnet"))).await).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "WideWorldUnavailable");
}

#[cfg(feature = "rights-records")]
async fn grants_get(app: &Shared, query: &str) -> (StatusCode, Value) {
    let uri: Uri = format!("/h/grants{query}").parse().unwrap();
    let query = Query::<Vec<(String, String)>>::try_from_uri(&uri).unwrap();
    answer(grants(State(app.clone()), query).await).await
}

#[cfg(feature = "rights-records")]
#[tokio::test]
async fn grants_handler_answers_the_schema_and_refuses_bad_queries() {
    let app = app("localnet");
    let (status, value) = grants_get(&app, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["schema"], "frontier-herald-grants-v1");
    assert_eq!(value["season"], 7);
    assert_eq!(value["grants"], json!([]));
    let me = Address::new_from_array([7; 32]).to_string();
    let (status, value) = grants_get(&app, &format!("?citizen={me}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["grants"], json!([]));
    for query in [
        "?citizen=nope",
        "?citizen=",
        "?other=1",
        &format!("?citizen={me}&citizen={me}"),
    ] {
        let (status, value) = grants_get(&app, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert!(
            value["code"] == "BadCitizen" || value["code"] == "BadQuery",
            "{query}"
        );
    }
}

#[cfg(not(feature = "rights-records"))]
#[tokio::test]
async fn grants_are_unavailable_without_the_feature() {
    let res = grants(State(app("localnet"))).await;
    let (status, value) = answer(res).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "GrantsUnavailable");
}

/// (territory-map-2) `/h/world/wide/territory`: one answer per territory
/// revision, ETag + 304, gzip when asked; refusals by name.
#[cfg(feature = "wide-world-experimental")]
#[tokio::test]
async fn territory_handler_caches_per_revision_with_etag_and_gzip_without_listener() {
    use frontier_abi::layout::{header as hdr, world::season};
    use frontier_abi::world_index::territory::{
        self as wtr, territory_province, TerritoryProvince, TerritoryRule,
    };
    let none = HeaderMap::new();
    let (status, value) =
        answer(world_wide_territory(State(app(" Fixture ")), none.clone()).await).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Some("FixtureWorldUnavailable")
        )
    );
    let app = app("localnet");
    let (status, value) =
        answer(world_wide_territory(State(app.clone()), none.clone()).await).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("NoSeasonYet"))
    );
    let mut data = vec![0; season::SIZE];
    data[..8].copy_from_slice(&season::MAGIC);
    data[hdr::SEASON_ID..hdr::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[hdr::LAYOUT_VERSION..hdr::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[season::PROGRAM_VERSION..season::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    app.fold.write().unwrap().season = Some(fclient::decode::Season::decode(&data).unwrap());
    async fn body(res: Response) -> (StatusCode, HeaderMap, Vec<u8>) {
        let (s, h) = (res.status(), res.headers().clone());
        (
            s,
            h,
            axum::body::to_bytes(res.into_body(), 1_000_000)
                .await
                .unwrap()
                .to_vec(),
        )
    }
    let (s, h, b) = body(world_wide_territory(State(app.clone()), none.clone()).await).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CACHE_CONTROL], "public, max-age=5");
    assert!(h.get(header::CONTENT_ENCODING).is_none());
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(
        (
            v["revision"].as_str(),
            v["provinces"].as_array().map(Vec::len)
        ),
        (Some("0"), Some(0))
    );
    let etag0 = h[header::ETAG].to_str().unwrap().to_string();
    let mut ifnm = HeaderMap::new();
    ifnm.insert(header::IF_NONE_MATCH, etag0.parse().unwrap());
    let (s, _, b) = body(world_wide_territory(State(app.clone()), ifnm.clone()).await).await;
    assert_eq!((s, b.len()), (StatusCode::NOT_MODIFIED, 0));
    // a claim lands: the revision moves, the old ETag is stale, the new answer names the tile
    {
        let mut f = app.fold.write().unwrap();
        let c = WideCoordForTest::c(130, 0);
        let mut r = TerritoryProvince::new(
            7,
            TerritoryRule::V1,
            f.wide.as_ref().unwrap().world(),
            c,
            30,
            [9; 32],
        );
        r.owner[12] = 4242;
        r.dist[12] = 1;
        let mut d = vec![0; territory_province::SIZE];
        r.write(&mut d).unwrap();
        let k = wtr::province_address(&f.ctx, c);
        f.apply(&fclient::ports::TxRecord {
            seq: 1,
            slot: 50,
            signature: Default::default(),
            block_time: 0,
            tx: vec![],
            logs: vec![],
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![(
                Address::new_from_array(k),
                Some(fclient::ports::Account {
                    lamports: 1,
                    data: d,
                    owner: Address::new_from_array([0x5e; 32]),
                    executable: false,
                }),
            )],
            loaded: Default::default(),
        });
    }
    let mut gz = ifnm.clone();
    gz.insert(header::ACCEPT_ENCODING, "br, gzip".parse().unwrap());
    let (s, h, b) = body(world_wide_territory(State(app.clone()), gz.clone()).await).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CONTENT_ENCODING], "gzip");
    assert_ne!(h[header::ETAG].to_str().unwrap(), etag0);
    let mut plain = vec![];
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&b[..]), &mut plain).unwrap();
    let v: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(v["revision"], "1");
    assert_eq!(v["tags"], json!(["4242"]));
    assert_eq!(v["provinces"][0]["tiles"], json!([[12, 0, 1]]));
    // the cached answer is the same bytes for the next viewer
    let (_, h2, b2) = body(world_wide_territory(State(app.clone()), gz).await).await;
    assert_eq!((h2[header::ETAG].clone(), b2), (h[header::ETAG].clone(), b));
}

/// (player-territory-records, Q-TM2-1) `/h/world/wide/territory/player/{citizen}`:
/// one Citizen's summary with the territory route's cache rules; refusals by name.
#[cfg(feature = "wide-world-experimental")]
#[tokio::test]
async fn territory_player_handler_answers_one_citizen_with_etag_and_gzip_without_listener() {
    use frontier_abi::layout::{header as hdr, world::season};
    use frontier_abi::world_index::territory::{
        self as wtr, territory_player, TerritoryPlayer, TerritoryRule,
    };
    async fn body(res: Response) -> (StatusCode, HeaderMap, Vec<u8>) {
        let (s, h) = (res.status(), res.headers().clone());
        let b = axum::body::to_bytes(res.into_body(), 1_000_000)
            .await
            .unwrap();
        (s, h, b.to_vec())
    }
    let citizen = [0xa1u8; 32];
    let cit = Address::new_from_array(citizen).to_string();
    let none = HeaderMap::new();
    let call = |app: &Shared, c: &str, h: &HeaderMap| {
        world_wide_territory_player(State(app.clone()), Path(c.to_string()), h.clone())
    };
    let (status, value) = answer(call(&app(" Fixture "), &cit, &none).await).await;
    assert_eq!(value["code"], "FixtureWorldUnavailable");
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let app = app("localnet");
    let (status, value) = answer(call(&app, "not-an-address", &none).await).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("BadCitizen"))
    );
    let (status, value) = answer(call(&app, &cit, &none).await).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("NoSeasonYet"))
    );
    let mut data = vec![0; season::SIZE];
    data[..8].copy_from_slice(&season::MAGIC);
    data[hdr::SEASON_ID..hdr::SEASON_ID + 8].copy_from_slice(&7u64.to_le_bytes());
    data[hdr::LAYOUT_VERSION..hdr::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    data[season::PROGRAM_VERSION..season::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    app.fold.write().unwrap().season = Some(fclient::decode::Season::decode(&data).unwrap());
    // no summary yet: 200 with player null, cached like the territory answer
    let (s, h, b) = body(call(&app, &cit, &none).await).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CACHE_CONTROL], "public, max-age=5");
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(
        (v["player"].clone(), v["citizen"].clone()),
        (Value::Null, json!(cit))
    );
    let etag0 = h[header::ETAG].to_str().unwrap().to_string();
    let mut ifnm = HeaderMap::new();
    ifnm.insert(header::IF_NONE_MATCH, etag0.parse().unwrap());
    let (s, _, b) = body(call(&app, &cit, &ifnm).await).await;
    assert_eq!((s, b.len()), (StatusCode::NOT_MODIFIED, 0));
    // the first claim lands: a new answer with the tile
    {
        let mut f = app.fold.write().unwrap();
        let world = f.wide.as_ref().unwrap().world();
        let tag = frontier_abi::addr::citizen_tag(&citizen);
        let mut r = TerritoryPlayer::new(7, TerritoryRule::V1, world, citizen, tag, 1, 9, [9; 32]);
        r.add_tile(2).unwrap();
        let mut d = vec![0; territory_player::SIZE];
        r.write(&mut d).unwrap();
        let k = wtr::player_address(&f.ctx, &citizen);
        f.apply(&fclient::ports::TxRecord {
            seq: 1,
            slot: 50,
            signature: Default::default(),
            block_time: 0,
            tx: vec![],
            logs: vec![],
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![(
                Address::new_from_array(k),
                Some(fclient::ports::Account {
                    lamports: 1,
                    data: d,
                    owner: Address::new_from_array([0x5e; 32]),
                    executable: false,
                }),
            )],
            loaded: Default::default(),
        });
    }
    let mut gz = ifnm.clone();
    gz.insert(header::ACCEPT_ENCODING, "gzip".parse().unwrap());
    let (s, h, b) = body(call(&app, &cit, &gz).await).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h[header::CONTENT_ENCODING], "gzip");
    assert_ne!(h[header::ETAG].to_str().unwrap(), etag0);
    let mut plain = vec![];
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&b[..]), &mut plain).unwrap();
    let v: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(v["player"]["tiles"], 1);
    assert_eq!(v["player"]["upkeepMilliPerHour"], "990");
    // the same answer again: the same ETag (304 with it)
    let mut same = HeaderMap::new();
    same.insert(header::IF_NONE_MATCH, h[header::ETAG].clone());
    let (s, _, _) = body(call(&app, &cit, &same).await).await;
    assert_eq!(s, StatusCode::NOT_MODIFIED);
}

#[cfg(feature = "wide-world-experimental")]
struct WideCoordForTest;
#[cfg(feature = "wide-world-experimental")]
impl WideCoordForTest {
    fn c(p: i64, q: i64) -> frontier_abi::world_index::WideCoord {
        frontier_abi::world_index::WideCoord::checked(p, q).unwrap()
    }
}

#[cfg(not(feature = "wide-world-experimental"))]
#[tokio::test]
async fn territory_handler_feature_off_is_unavailable_without_listener() {
    let (status, value) = answer(world_wide_territory(State(app("localnet"))).await).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "WideWorldUnavailable");
    let (status, value) = answer(world_wide_territory_player(State(app("localnet"))).await).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "WideWorldUnavailable");
}
