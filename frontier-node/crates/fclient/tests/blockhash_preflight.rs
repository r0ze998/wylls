//! Explicit temporary loopback RPC only. Fixed public bytes, no keys/signatures.
use fclient::{
    blockhash_preflight,
    unsigned_message_preflight::{inspect, Error, Limits},
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_message::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn fixture(replies: Vec<Value>) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for result in replies {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut bytes = Vec::new();
            let (header_end, length) = loop {
                let mut chunk = [0; 1024];
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() <= 8192);
                if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&bytes[..at]).unwrap();
                    assert!(header.starts_with("POST / HTTP/1.1\r\n"));
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    assert!(length <= 4096);
                    break (at + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let mut chunk = [0; 1024];
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() <= 8192);
            }
            let request: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let response =
                json!({"jsonrpc":"2.0", "id":request["id"], "result":result}).to_string();
            let wire = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
            stream.write_all(wire.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
            requests.push(request);
        }
        requests
    });
    (url, task)
}

fn latest() -> Value {
    json!({"context":{"slot":101},"value":{"blockhash":Hash::new_from_array([24;32]).to_string(),"lastValidBlockHeight":210}})
}
fn limits() -> Limits {
    Limits {
        max_locks: 32,
        max_writes: 8,
        min_context_slot: 100,
        min_remaining_block_heights: 2,
    }
}
fn message(hash: [u8; 32]) -> (Message, Address) {
    let payer = Address::new_from_array([21; 32]);
    (
        Message::new_with_blockhash(
            &[Instruction {
                program_id: Address::new_from_array([22; 32]),
                accounts: vec![],
                data: vec![7; 60],
            }],
            Some(&payer),
            &Hash::new_from_array(hash),
        ),
        payer,
    )
}

#[tokio::test]
async fn actual_rpc_context_flows_into_unsigned_preflight_without_signing() {
    let (url, server) = fixture(vec![
        latest(),
        json!({"context":{"slot":102},"value":true}),
        json!(200),
    ])
    .await;
    let observed = blockhash_preflight::read(&url, 100).await;
    let requests = server.await.unwrap();
    let observed = observed.unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["getLatestBlockhash", "isBlockhashValid", "getBlockHeight"]
    );
    assert_eq!(
        requests[0]["params"],
        json!([{"commitment":"confirmed","minContextSlot":100}])
    );
    assert_eq!(
        requests[1]["params"],
        json!([Hash::new_from_array([24;32]).to_string(),{"commitment":"confirmed","minContextSlot":101}])
    );
    assert_eq!(
        requests[2]["params"],
        json!([{"commitment":"confirmed","minContextSlot":102}])
    );
    assert_eq!(observed.latest_context_slot, 101);
    assert_eq!(observed.height_min_context_slot, 102);
    assert_eq!(observed.read_calls(), 3);
    assert!(!observed.coherent_snapshot());
    assert!(!observed.rpc_authority_verified());
    assert!(!observed.admitted());
    let (m, payer) = message(observed.observation.blockhash);
    let report = inspect(&m, &[payer], observed.observation, limits()).unwrap();
    assert_eq!(report.remaining_block_heights, 10);
    assert!(!report.admitted());
}

#[tokio::test]
async fn stale_or_missing_context_and_noncanonical_values_stop_later_reads() {
    for url in [
        "http://example.invalid/",
        "http://127.0.0.1:80/\r\nInjected: true",
        "https://user:password@example.invalid/",
        "https://example.invalid/?api-key=secret",
    ] {
        assert!(blockhash_preflight::read(url, 100).await.is_err());
    }
    let mut stale = latest();
    stale["context"]["slot"] = json!(99);
    let mut no_expiry = latest();
    no_expiry["value"]
        .as_object_mut()
        .unwrap()
        .remove("lastValidBlockHeight");
    let mut zero_hash = latest();
    zero_hash["value"]["blockhash"] = json!(Hash::default().to_string());
    for replies in [
        vec![stale],
        vec![no_expiry],
        vec![zero_hash],
        vec![latest(), json!({"context":{"slot":100},"value":true})],
        vec![latest(), json!({"context":{"slot":102},"value":"true"})],
        vec![
            latest(),
            json!({"context":{"slot":102},"value":true}),
            json!(-1),
        ],
    ] {
        let count = replies.len();
        let (url, server) = fixture(replies).await;
        let result = blockhash_preflight::read(&url, 100).await;
        assert_eq!(server.await.unwrap().len(), count);
        assert!(result.is_err());
    }
}

#[tokio::test]
async fn invalid_expired_or_nearly_expired_hash_is_never_ready() {
    for (valid, height, error) in [
        (false, 200, Error::BlockhashInvalid),
        (true, 211, Error::BlockhashExpired),
        (true, 209, Error::BlockhashMargin),
    ] {
        let (url, server) = fixture(vec![
            latest(),
            json!({"context":{"slot":102},"value":valid}),
            json!(height),
        ])
        .await;
        let observed = blockhash_preflight::read(&url, 100).await;
        assert_eq!(server.await.unwrap().len(), 3);
        let observed = observed.unwrap();
        let (m, payer) = message(observed.observation.blockhash);
        assert_eq!(
            inspect(&m, &[payer], observed.observation, limits()),
            Err(error)
        );
    }
}

/// Explicit public devnet reads only. No account/wallet data is sent, and no
/// transaction, simulation, airdrop, key or signature is created or requested.
#[tokio::test]
#[ignore = "explicit opt-in public HTTPS RPC observation, no signing or sending"]
async fn public_devnet_https_blockhash_observation_only() {
    let observed = blockhash_preflight::read("https://api.devnet.solana.com", 0)
        .await
        .unwrap();
    assert!(observed.observation.context_slot >= observed.latest_context_slot);
    assert!(observed.observation.valid);
    let (m, payer) = message(observed.observation.blockhash);
    let report = inspect(&m, &[payer], observed.observation, limits()).unwrap();
    assert!(!report.admitted());
    assert!(!report.public_dispatch_available());
    assert!(!observed.coherent_snapshot());
    println!(
        "public devnet: latest_slot={} validity_slot={} block_height={} last_valid_height={} remaining={} admitted=false",
        observed.latest_context_slot,
        observed.observation.context_slot,
        observed.observation.block_height,
        observed.observation.last_valid_block_height,
        report.remaining_block_heights,
    );
}
