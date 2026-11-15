#![cfg(feature = "wide-live-read-experimental")]
use base64::{engine::general_purpose::STANDARD, Engine};
use fclient::snapshot::{parse_snapshot_response, Snapshot, SnapshotError, SnapshotPort};
use herald_fold::wide_live::{loopback_rpc, parse_query, Live};
use serde_json::json;
use solana_address::Address;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const QUERY: &str = "citizen=11111111111111111111111111111111&p=129&q=0&site=0&gen=1&min_slot=10";

#[test]
fn strict_literal_selection() {
    assert!(parse_query(QUERY).is_ok());
    for bad in [
        format!("{QUERY}&p=130"),
        format!("{QUERY}&rpc=http://evil"),
        QUERY.replace("p=129", "p=0129"),
        QUERY.replace("q=0", "q=-0"),
        QUERY.replace("p=129", "p=128"),
        QUERY.replace("site=0", "site=12"),
        QUERY.replace("gen=1", "gen=255"),
        QUERY.replace("min_slot=10", "min_slot=0"),
        QUERY.replace("p=129", "p=%31%32%39"),
    ] {
        assert!(parse_query(&bad).is_err(), "{bad}");
    }
}

#[test]
fn literal_loopback_only() {
    assert!(loopback_rpc("http://127.0.0.1:41010"));
    for bad in [
        "http://localhost:41010",
        "http://127.0.0.1:0",
        "http://127.0.0.1:41010/path",
        "http://127.0.0.1:41010?x",
        "https://127.0.0.1:41010",
        "http://user@127.0.0.1:41010",
    ] {
        assert!(!loopback_rpc(bad));
    }
}

struct Missing(AtomicUsize);
impl SnapshotPort for Missing {
    async fn snapshot(
        &self,
        keys: &[Address],
        rent: bool,
        min: u64,
    ) -> Result<Snapshot, SnapshotError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        assert_eq!(keys.len(), 4);
        assert!(!rent);
        assert_eq!(min, 20);
        let mut clock = [0u8; 40];
        clock[..8].copy_from_slice(&20u64.to_le_bytes());
        parse_snapshot_response(
            &json!({"context":{"slot":20}, "value":[null,null,null,null,
            {"lamports":1,"owner":"Sysvar1111111111111111111111111111111111111", "executable":false,
                "data":[STANDARD.encode(clock), "base64"]}]}),
            keys,
            false,
            min,
        )
    }
}

#[tokio::test]
async fn one_read_and_missing_refuses_without_repair() {
    let source = Arc::new(Missing(AtomicUsize::new(0)));
    let live = Live::new(
        Address::new_from_array([7; 32]),
        1,
        [8; 32],
        20,
        source.clone(),
    )
    .unwrap();
    assert_eq!(source.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        live.observe(&parse_query(QUERY).unwrap())
            .await
            .unwrap_err(),
        "MissingAccount"
    );
    assert_eq!(source.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn bad_selection_never_reaches_source() {
    let source = Arc::new(Missing(AtomicUsize::new(0)));
    let live = Live::new(
        Address::new_from_array([7; 32]),
        1,
        [8; 32],
        20,
        source.clone(),
    )
    .unwrap();
    let mut query = parse_query(QUERY).unwrap();
    query.insert("account".into(), "unbounded target".into());
    assert_eq!(live.observe(&query).await.unwrap_err(), "BadSelection");
    assert_eq!(source.0.load(Ordering::SeqCst), 0);
}

#[test]
fn configuration_requires_pins_without_contacting_source() {
    let source = Arc::new(Missing(AtomicUsize::new(0)));
    assert!(Live::new(
        Address::new_from_array([7; 32]),
        1,
        [0; 32],
        20,
        source.clone()
    )
    .is_err());
    assert!(Live::new(
        Address::new_from_array([7; 32]),
        1,
        [8; 32],
        0,
        source.clone()
    )
    .is_err());
    assert_eq!(source.0.load(Ordering::SeqCst), 0);
}

// Synthetic literal account bytes, matched by web-frontier-wide-live.test.mjs.
// Public addresses only. This is not a recorded chain observation.
struct Coherent {
    response: serde_json::Value,
    expected: Vec<Address>,
    calls: AtomicUsize,
}
impl SnapshotPort for Coherent {
    async fn snapshot(
        &self,
        keys: &[Address],
        rent: bool,
        min: u64,
    ) -> Result<Snapshot, SnapshotError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(keys, self.expected);
        assert!(!rent);
        parse_snapshot_response(&self.response, keys, false, min)
    }
}
fn header(size: usize, magic: &[u8; 8], version: u16) -> Vec<u8> {
    let mut d = vec![0; size];
    d[..8].copy_from_slice(magic);
    d[8..16].copy_from_slice(&5u64.to_le_bytes());
    d[16..18].copy_from_slice(&version.to_le_bytes());
    d
}
fn positive() -> (serde_json::Value, Vec<Address>, String) {
    use frontier_abi::{
        addr::AddrCtx,
        world_index::{holding, land, WideCoord, WorldId},
    };
    let program = Address::new_from_array([94; 32]);
    let addresses = fclient::addr::Addresses::new(program, 5);
    let wallet = Address::new_from_array([65; 32]);
    let citizen = addresses.citizen(&wallet);
    let world =
        WorldId::derive_legacy_season(&addresses.season.to_bytes(), &program.to_bytes()).unwrap();
    let coord = WideCoord::checked(9_007_199_254_740_993, -130).unwrap();
    let ctx = AddrCtx {
        season: addresses.season.to_bytes(),
        program: program.to_bytes(),
    };
    let keys = vec![
        Address::new_from_array(holding::holding_address(&ctx, coord, 3)),
        Address::new_from_array(land::province_address(&ctx, coord)),
        citizen,
        addresses.season,
    ];
    let mut h = header(1344, b"PSFXWHL1", 3);
    h[68] = 3;
    h[69] = 1;
    h[72..104].copy_from_slice(&citizen.to_bytes());
    h[1280] = 1;
    h[1282] = 1;
    h[1283] = 2;
    h[1288..1320].copy_from_slice(world.as_bytes());
    h[1320..1337].copy_from_slice(&coord.sort_key());
    h[152..160].copy_from_slice(&9_007_199_254_740_993u64.to_le_bytes());
    let mut p = header(4864, b"PSFXWPV1", 3);
    p[70] = coord.wedge().unwrap();
    p[4736] = 1;
    p[4738] = 1;
    p[4739] = 15;
    p[4740..4772].copy_from_slice(world.as_bytes());
    p[4772..4789].copy_from_slice(&coord.sort_key());
    p[4800] = 1;
    p[296 + 3 * 64] = 1;
    p[296 + 3 * 64 + 4] = 1;
    let mut c = header(384, b"PSF1CITZ", 2);
    c[64..96].copy_from_slice(&wallet.to_bytes());
    c[173] = 255;
    c[178] = 12;
    c[185] = 255;
    let mut s = header(2048, b"PSF1SEAS", 2);
    s[65] = addresses.bump;
    s[104..136].fill(17);
    s[136] = 12;
    s[138..140].copy_from_slice(&0x4004u16.to_le_bytes());
    let mut clock = vec![0; 40];
    clock[..8].copy_from_slice(&101u64.to_le_bytes());
    clock[32..40].copy_from_slice(&1_800_000_000i64.to_le_bytes());
    let mut entries: Vec<_> = [h, p, c, s]
        .into_iter()
        .map(|d| {
            json!({"owner":program.to_string(),
        "lamports":1, "executable":false, "data":[STANDARD.encode(d),"base64"]})
        })
        .collect();
    entries.push(
        json!({"owner":"Sysvar1111111111111111111111111111111111111", "lamports":1,
        "executable":false, "data":[STANDARD.encode(clock),"base64"]}),
    );
    (
        json!({"context":{"slot":101}, "value":entries}),
        keys,
        format!("citizen={citizen}&p=9007199254740993&q=-130&site=3&gen=1&min_slot=100"),
    )
}
fn edit(response: &mut serde_json::Value, account: usize, offset: usize, byte: u8) {
    let mut d = STANDARD
        .decode(response["value"][account]["data"][0].as_str().unwrap())
        .unwrap();
    d[offset] = byte;
    response["value"][account]["data"][0] = json!(STANDARD.encode(d));
}
async fn observed(
    response: serde_json::Value,
    keys: Vec<Address>,
    query: &str,
) -> Result<serde_json::Value, &'static str> {
    let source = Arc::new(Coherent {
        response,
        expected: keys,
        calls: AtomicUsize::new(0),
    });
    let live = Live::new(
        Address::new_from_array([94; 32]),
        5,
        [17; 32],
        100,
        source.clone(),
    )
    .unwrap();
    let result = live.observe(&parse_query(query).unwrap()).await;
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    result
}

#[tokio::test]
async fn positive_coherent_observation_keeps_exact_public_bytes() {
    let (response, keys, query) = positive();
    let expected = parse_snapshot_response(&response, &keys, false, 100).unwrap();
    let v = observed(response.clone(), keys.clone(), &query)
        .await
        .unwrap();
    assert_eq!(v["kind"], "wide-village-rpc-observation");
    assert_eq!(v["label"], "RPC observed at slot");
    assert_eq!(v["observed_slot"], "101");
    assert_eq!(v["min_slot"], "100");
    assert_eq!(v["p"], "9007199254740993");
    assert_eq!(v["q"], "-130");
    assert_eq!(v["site"], 3);
    assert_eq!(v["gen"], 1);
    assert_eq!(v["slot"], 2);
    assert_eq!(v["program_version"], 0x4004);
    assert_eq!(v["season"], "5");
    assert_eq!(v["ruleset_hash"], "11".repeat(32));
    assert_eq!(v["snapshot_digest"], hex::encode(expected.meta().digest()));
    assert_eq!(v["commitment"], "confirmed");
    assert_eq!(v["single_response"], true);
    for flag in [
        "current",
        "authenticated",
        "executable",
        "source_complete",
        "wallet_ownership_verified",
    ] {
        assert_eq!(v[flag], false);
    }
    assert_eq!(v["accounts"].as_array().unwrap().len(), 4);
    for (i, kind) in ["holding", "province", "citizen", "season"]
        .iter()
        .enumerate()
    {
        assert_eq!(v["accounts"][i]["kind"], *kind);
        assert_eq!(v["accounts"][i]["address"], keys[i].to_string());
        assert_eq!(
            v["accounts"][i]["data_b64"],
            response["value"][i]["data"][0]
        );
        assert_eq!(v["accounts"][i]["lamports"], "1");
    }
    assert_eq!(v["clock"]["data_b64"], response["value"][4]["data"][0]);
    // Explicit test stdout only: the reviewed runner can feed these actual
    // Rust-produced public synthetic bytes into the independent JS parser.
    println!(
        "WYLLS_WIDE_LIVE_JSON={}",
        serde_json::to_string(&v).unwrap()
    );
}

#[tokio::test]
async fn single_field_account_mutations_refuse_even_when_snapshot_seal_is_valid() {
    for (account, offset, byte) in [
        (0, 1288, 0),             // foreign holding world
        (1, 4740, 0),             // foreign province world
        (0, 69, 2),               // holding generation
        (1, 296 + 3 * 64 + 4, 2), // province mirror generation
        (0, 72, 0),               // holding owner Citizen
        (2, 178, 0),              // Citizen wide slot marker
        (2, 64, 0),               // Citizen canonical identity
        (3, 138, 4),              // legacy program 4: high byte changed separately below
        (3, 104, 18),             // rules hash
        (3, 136, 13),             // rules version
        (0, 16, 4),
        (1, 16, 4),
        (2, 16, 3),
        (3, 16, 3), // layouts
    ] {
        let (mut response, keys, query) = positive();
        if matches!((account, offset), (0, 1288) | (1, 4740) | (0, 72)) {
            let d = STANDARD
                .decode(response["value"][account]["data"][0].as_str().unwrap())
                .unwrap();
            edit(&mut response, account, offset, d[offset] ^ 1);
        } else if account == 3 && offset == 138 {
            edit(&mut response, 3, 139, 0);
        } else {
            edit(&mut response, account, offset, byte);
        }
        assert!(
            observed(response, keys, &query).await.is_err(),
            "account {account} byte {offset}"
        );
    }
    for account in 0..4 {
        for field in ["owner", "executable"] {
            let (mut response, keys, query) = positive();
            response["value"][account][field] = if field == "owner" {
                json!(Address::new_from_array([1; 32]).to_string())
            } else {
                json!(true)
            };
            assert!(observed(response, keys, &query).await.is_err());
        }
    }
}

#[tokio::test]
async fn context_clock_readset_and_data_bounds_refuse() {
    for case in 0..6 {
        let (mut response, keys, query) = positive();
        match case {
            0 => edit(&mut response, 4, 0, 100), // Clock/context mismatch
            1 => response["context"]["slot"] = json!(99), // stale minimum
            2 => {
                response["value"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::Value::Null);
            }
            3 => {
                response["value"].as_array_mut().unwrap().remove(0);
            }
            4 => response["value"][0]["data"][0] = json!(STANDARD.encode(vec![0; 9001])),
            _ => {
                response["value"][4]["owner"] = json!(Address::new_from_array([1; 32]).to_string())
            }
        }
        assert!(
            observed(response, keys, &query).await.is_err(),
            "case {case}"
        );
    }
}

// Exercise only the real HTTP read adapter against a literal local fixture.
// Joined futures own every socket; the outer timeout drops both on failure.
async fn transport_case(
    mut response: serde_json::Value,
    keys: Vec<Address>,
    query: String,
    oversize: bool,
) -> Result<serde_json::Value, &'static str> {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let live = Live::rpc(Address::new_from_array([94; 32]), 5, [17; 32], 100, &url).unwrap();
    let request = parse_query(&query).unwrap();
    let fixture = async {
        let (mut socket, peer) = listener.accept().await.unwrap();
        assert!(peer.ip().is_loopback());
        let mut wire = Vec::new();
        let (end, length) = loop {
            assert!(wire.len() < 4096, "bounded fixture request");
            let mut chunk = [0; 512];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0, "request ended early");
            wire.extend_from_slice(&chunk[..n]);
            assert!(wire.len() <= 4096);
            if let Some(end) = wire.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = std::str::from_utf8(&wire[..end]).unwrap();
                assert!(header.starts_with("POST / HTTP/1.1\r\n"));
                let length = header
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                assert!(end + 4 + length <= 4096);
                if wire.len() >= end + 4 + length {
                    break (end + 4, length);
                }
            }
        };
        assert_eq!(wire.len(), end + length);
        let req: serde_json::Value = serde_json::from_slice(&wire[end..]).unwrap();
        assert_eq!(req["method"], "getMultipleAccounts");
        assert_eq!(req["jsonrpc"], "2.0");
        let mut expected: Vec<String> = keys.iter().map(ToString::to_string).collect();
        expected.push("SysvarC1ock11111111111111111111111111111111".into());
        assert_eq!(
            req["params"],
            json!([expected,
            {"encoding":"base64", "commitment":"confirmed", "minContextSlot":100}])
        );
        // Mirror the request ID exactly, as a real JSON-RPC server must.
        response = json!({"jsonrpc":"2.0", "id":req["id"], "result":response});
        let body = if oversize {
            vec![b' '; 32_769]
        } else {
            serde_json::to_vec(&response).unwrap()
        };
        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        socket.write_all(header.as_bytes()).await.unwrap();
        // A capped client may close while the deliberately oversized reply is sent.
        let sent = socket.write_all(&body).await;
        if !oversize {
            sent.unwrap();
        }
        let _ = socket.shutdown().await;
        drop(socket);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "observation attempted a second RPC connection"
        );
    };
    let ((), result) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(fixture, live.observe(&request))
    })
    .await
    .expect("bounded local transport test");
    result
}

#[tokio::test]
async fn actual_rpc_transport_is_one_bounded_five_account_read() {
    let (response, keys, query) = positive();
    let v = transport_case(response, keys, query, false).await.unwrap();
    assert_eq!(v["observed_slot"], "101");
    assert_eq!(v["accounts"].as_array().unwrap().len(), 4);
    assert_eq!(v["current"], false);
}

#[tokio::test]
async fn actual_rpc_transport_refuses_wire_overflow_and_missing_metadata() {
    let (response, keys, query) = positive();
    assert_eq!(
        transport_case(response, keys, query, true)
            .await
            .unwrap_err(),
        "ObservationUnavailable"
    );
    for mutation in 0..3 {
        let (mut response, keys, query) = positive();
        match mutation {
            0 => {
                response["value"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("executable");
            }
            1 => response["value"][0]["executable"] = json!("false"),
            _ => response["value"][0]["data"][1] = json!("base64+zstd"),
        }
        assert_eq!(
            transport_case(response, keys, query, false)
                .await
                .unwrap_err(),
            "ObservationUnavailable"
        );
    }
}
