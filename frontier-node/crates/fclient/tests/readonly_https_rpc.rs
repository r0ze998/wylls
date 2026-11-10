//! Pure public JSON/argument/parser checks. Never invokes curl or any endpoint.
use fclient::readonly_https_rpc::{curl_args, parse_output, request_bytes, MAX_REQUEST_BYTES};
use serde_json::json;

#[test]
fn only_read_methods_encode_and_request_size_is_bounded() {
    for method in [
        "getLatestBlockhash",
        "isBlockhashValid",
        "getBlockHeight",
        "getMultipleAccounts",
        "getAccountInfo",
        "getVersion",
        "getSlot",
    ] {
        let bytes = request_bytes(method, json!([])).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value,
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":[]})
        );
    }
    for method in [
        "sendTransaction",
        "sendRawTransaction",
        "simulateTransaction",
        "requestAirdrop",
        "getslot",
        "",
    ] {
        assert!(request_bytes(method, json!([])).is_err());
    }
    assert!(request_bytes("getSlot", json!({})).is_err());
    assert!(request_bytes("getSlot", json!(["x".repeat(MAX_REQUEST_BYTES)])).is_err());
    let overhead = request_bytes("getSlot", json!([""])).unwrap().len();
    assert_eq!(
        request_bytes("getSlot", json!(["x".repeat(MAX_REQUEST_BYTES - overhead)]))
            .unwrap()
            .len(),
        MAX_REQUEST_BYTES
    );
    assert!(request_bytes(
        "getSlot",
        json!(["x".repeat(MAX_REQUEST_BYTES - overhead + 1)])
    )
    .is_err());
}

#[test]
fn args_keep_tls_no_redirect_no_netrc_and_public_stdin_boundaries() {
    let args = curl_args("https://api.mainnet-beta.solana.com", 16384).unwrap();
    assert_eq!(args[0], "-q");
    for flag in ["--no-netrc", "--no-insecure", "--no-location", "--tlsv1.2"] {
        assert!(args.iter().any(|a| a == flag));
    }
    for pair in [
        ["--proto", "=https"],
        ["--max-redirs", "0"],
        ["--max-time", "5"],
        ["--data-binary", "@-"],
        ["--max-filesize", "16384"],
        ["--proxy", ""],
    ] {
        assert!(args.windows(2).any(|a| a == pair));
    }
    for url in [
        "http://localhost/",
        "https://user:password@example.com/",
        "https://example.com/?api-key=secret",
        "https://example.com/%20",
        "https://example.com/#secret",
        "https://example.com/\r\nHeader: injected",
    ] {
        assert!(curl_args(url, 100).is_err());
    }
    assert!(curl_args("https://example.com", 0).is_err());
}

fn wire(value: serde_json::Value, trailer: &str) -> Vec<u8> {
    format!("{value}\n{trailer}").into_bytes()
}

#[test]
fn verified_tls_and_exact_rpc_identity_are_required() {
    let good = json!({"jsonrpc":"2.0","id":1,"result":{"context":{"slot":100}}});
    assert_eq!(
        parse_output(&wire(good.clone(), "200 0 HTTPS"), 1024).unwrap(),
        good["result"]
    );
    for trailer in [
        "200 1 HTTPS",
        "200 0 HTTP",
        "302 0 HTTPS",
        "200 0 HTTPS extra",
        "",
    ] {
        assert!(parse_output(&wire(good.clone(), trailer), 1024).is_err());
    }
    for value in [
        json!({"jsonrpc":"2.0","id":2,"result":1}),
        json!({"id":1,"result":1}),
        json!({"jsonrpc":"2.0","id":1,"result":1,"error":null}),
        json!({"jsonrpc":"2.0","id":1}),
    ] {
        assert!(parse_output(&wire(value, "200 0 HTTPS"), 1024).is_err());
    }
    let body_len = good.to_string().len();
    assert!(parse_output(&wire(good.clone(), "200 0 HTTPS"), body_len).is_ok());
    assert!(parse_output(&wire(good, "200 0 HTTPS"), body_len - 1).is_err());
    let error = parse_output(
        &wire(
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"credential-secret"}}),
            "200 0 HTTPS",
        ),
        1024,
    )
    .unwrap_err();
    assert!(!format!("{error:?}").contains("credential-secret"));
}
