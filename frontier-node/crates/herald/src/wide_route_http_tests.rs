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
