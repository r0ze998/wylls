//! No fixture generator, ingest, file writes, keys, or external network.
//! This target runs both feature-off and feature-on with no live source.
use fclient::ports::ChainInfo;
use herald_fold::{
    clash::Provisional,
    files::Out,
    fold::{Fold, FoldCfg},
    server::{self, App},
    views::SeasonStatic,
};
use serde_json::json;
use solana_address::Address;
use std::{
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn inert_app() -> Arc<App> {
    // A child of /dev/null cannot be used as a writable directory. Out::new
    // stores this string only; no filesystem setup or inspection is needed.
    let out = Out::new("/dev/null/wylls-wide-live-inert");
    let fold = Fold::new(
        FoldCfg {
            program: Address::new_from_array([94; 32]),
            season_id: 5,
            builder: Arc::new(Provisional),
            exact_post: false,
        },
        out.clone(),
    );
    let (diffs, _) = tokio::sync::broadcast::channel(1);
    Arc::new(App::new(
        Arc::new(RwLock::new(fold)),
        out,
        SeasonStatic {
            cluster: "localnet".into(),
            drand: ChainInfo {
                public_key: [0; 96],
                period: 3,
                genesis_time: 0,
                genesis_seed: [0; 32],
                chain_hash: [0; 32],
                scheme: "literal-unused".into(),
                beacon_id: "literal-unused".into(),
            },
            quotas: json!({}),
        },
        diffs,
    ))
}

#[tokio::test]
async fn unavailable_route_is_503_without_initialization_or_writes() {
    let app = inert_app();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(server::serve(listener, app.clone()));
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let mut socket = tokio::net::TcpStream::connect(address).await?;
        socket.write_all(format!("GET /h/wide-live/village HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
        let mut bytes = Vec::new();
        socket.take(4097).read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    }).await;
    // Clean up before any result assertions; no server is left in the background.
    task.abort();
    let _ = task.await;
    let bytes = result.expect("bounded route request").unwrap();
    assert!(bytes.len() <= 4096);
    let response = fclient::http::parse_response(&bytes).unwrap();
    assert_eq!(response.status, 503);
    let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(body["code"], "WideLiveUnavailable");
    assert!(app.out.dirty.as_ref().unwrap().lock().unwrap().is_empty());
    let fold = app.fold.read().unwrap();
    assert!(fold.st.accounts.is_empty());
    assert_eq!(fold.version, 0);
    assert!(fold.out.dirty.as_ref().unwrap().lock().unwrap().is_empty());
}
