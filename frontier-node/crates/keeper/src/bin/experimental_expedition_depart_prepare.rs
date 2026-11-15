//! One-shot stdin/stdout **unsigned** Depart preparation only
//! (`keeper_core::experimental_expedition_depart_prepare`). Never starts a
//! keeper, reads a key, signs, simulates or sends. Reads at most 16 KiB of
//! request from stdin, writes one report of at most 64 KiB to stdout; exit 0
//! only for `prepared`, 2 for any blocked report, 1 when stdout fails.
//! The RPC URL must be explicit loopback HTTP (the preview's own validator);
//! the target, payer, ruleset and budgets are explicit arguments.
use fclient::{blockhash_preflight, rpc::RpcPort};
use keeper_core::{
    experimental_expedition_depart_prepare as depart,
    experimental_expedition_prepare::Settings,
    wideexpedition_preview as preview,
};
use std::{ffi::OsString, io::Write, time::Duration};

/// The whole preparation, snapshot and blockhash reads included.
const TIMEOUT: Duration = Duration::from_secs(25);
const NAMES: [&str; 7] = [
    "--rpc-url",
    "--program",
    "--season",
    "--fee-payer",
    "--ruleset-hash",
    "--cu-limit",
    "--loaded-limit",
];

/// Exactly the seven named arguments, in order, each once.
fn options(args: impl IntoIterator<Item = OsString>) -> Result<(String, Settings), &'static str> {
    let args: Vec<_> = args
        .into_iter()
        .map(|s| s.into_string().map_err(|_| "RequestInvalid"))
        .collect::<Result<_, _>>()?;
    if args.len() != NAMES.len() * 2 || NAMES.iter().enumerate().any(|(i, name)| args[i * 2] != *name) {
        return Err("RequestInvalid");
    }
    preview::validate_rpc_url(&args[1]).map_err(|_| "RequestInvalid")?;
    let public = |text: &str| -> Result<fclient::Address, &'static str> {
        let a: fclient::Address = text.parse().map_err(|_| "RequestInvalid")?;
        if a == fclient::Address::default() || a.to_string() != text {
            return Err("RequestInvalid");
        }
        Ok(a)
    };
    let mut ruleset_hash = [0; 32];
    if args[9].len() != 64 || !args[9].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("RequestInvalid");
    }
    hex::decode_to_slice(&args[9], &mut ruleset_hash).map_err(|_| "RequestInvalid")?;
    let number = |s: &str| -> Result<u32, &'static str> {
        let n: u32 = s.parse().map_err(|_| "RequestInvalid")?;
        if n == 0 || n.to_string() != s {
            return Err("RequestInvalid");
        }
        Ok(n)
    };
    let settings = Settings {
        program: public(&args[3])?,
        season: public(&args[5])?,
        fee_payer: public(&args[7])?,
        ruleset_hash,
        cu_limit: number(&args[11])?,
        loaded_limit: number(&args[13])?,
    };
    if settings.program == settings.season || settings.cu_limit > 1_400_000 || settings.loaded_limit > 64 * 1024 * 1024 {
        return Err("RequestInvalid");
    }
    Ok((args[1].clone(), settings))
}

fn run(args: impl IntoIterator<Item = OsString>, stdin: impl std::io::Read) -> serde_json::Value {
    let (url, settings) = match options(args) {
        Ok(x) => x,
        Err(code) => return depart::failure(None, code),
    };
    let request = match depart::read_request(stdin) {
        Ok(x) => x,
        Err(code) => return depart::failure(None, code),
    };
    let source = RpcPort::new_with_response_limit(url.clone(), settings.program, preview::MAX_RPC_RESPONSE_BYTES);
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build() {
        Ok(r) => r,
        Err(_) => return depart::failure(Some(&request), "SourceUnavailable"),
    };
    let rpc_url = &url;
    runtime.block_on(async {
        match tokio::time::timeout(
            TIMEOUT,
            depart::prepare(&request, settings, &source, |floor| async move {
                blockhash_preflight::read(rpc_url, floor).await.map_err(|_| ())
            }),
        )
        .await
        {
            Ok(value) => value,
            Err(_) => depart::failure(Some(&request), "SourceUnavailable"),
        }
    })
}

/// The process exit for a report: 0 only when prepared.
fn exit_code(report: &serde_json::Value) -> i32 {
    if report["status"] == "prepared" {
        0
    } else {
        2
    }
}

fn main() {
    let report = run(std::env::args_os().skip(1), std::io::stdin().lock());
    let bytes = depart::output_bytes(&report);
    let mut out = std::io::stdout().lock();
    if out.write_all(&bytes).is_err() || out.write_all(b"\n").is_err() || out.flush().is_err() {
        std::process::exit(1);
    }
    std::process::exit(exit_code(&report));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(n: u8) -> String {
        fclient::Address::new_from_array([n; 32]).to_string()
    }
    fn good() -> Vec<String> {
        vec![
            "--rpc-url".into(),
            "http://127.0.0.1:8899".into(),
            "--program".into(),
            addr(4),
            "--season".into(),
            addr(5),
            "--fee-payer".into(),
            addr(8),
            "--ruleset-hash".into(),
            "09".repeat(32),
            "--cu-limit".into(),
            "200000".into(),
            "--loaded-limit".into(),
            "1000000".into(),
        ]
    }
    fn os(v: &[String]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }
    fn closed(v: &serde_json::Value) {
        assert_eq!(v["schema"], depart::REPORT_SCHEMA);
        assert_eq!(v["status"], "blocked");
        assert_eq!(v["host_only"], true);
        for k in ["ready", "deployment_verified", "admitted", "signed", "enqueued", "relay_submission_available", "automatic_send", "seal_verified"] {
            assert_eq!(v[k], false, "{k}");
        }
        assert_eq!(v["prepared"], serde_json::Value::Null);
        assert_eq!(exit_code(v), 2);
        assert!(depart::output_bytes(v).len() <= depart::MAX_OUTPUT_BYTES);
    }

    #[test]
    fn explicit_arguments_parse() {
        let (url, s) = options(os(&good())).unwrap();
        assert_eq!(url, "http://127.0.0.1:8899");
        assert_eq!(s.program.to_string(), addr(4));
        assert_eq!(s.season.to_string(), addr(5));
        assert_eq!(s.fee_payer.to_string(), addr(8));
        assert_eq!(s.ruleset_hash, [9; 32]);
        assert_eq!((s.cu_limit, s.loaded_limit), (200_000, 1_000_000));
    }

    #[test]
    fn invalid_arguments_are_refused_before_any_read() {
        let mut cases: Vec<Vec<String>> = Vec::new();
        cases.push(Vec::new());
        cases.push(good()[..12].to_vec());
        let mut extra = good();
        extra.push("--send".into());
        cases.push(extra);
        let mut swapped = good();
        swapped.swap(0, 2);
        cases.push(swapped);
        let bads: Vec<(usize, String)> = vec![
            (1, String::new()),
            (1, "127.0.0.1:8899 --send".into()),
            (3, "not-an-address".into()),
            (5, fclient::Address::default().to_string()),
            (7, format!("{}x", addr(8))),
            (9, "09".repeat(31)),
            (9, "0G".repeat(32)),
            (11, "0".into()),
            (11, "0200000".into()),
            (11, "1400001".into()),
            (13, "-1".into()),
            (13, "67108865".into()),
        ];
        for (i, bad) in bads {
            let mut v = good();
            v[i] = bad;
            cases.push(v);
        }
        let mut alias = good();
        alias[5] = alias[3].clone();
        cases.push(alias);
        for args in cases {
            assert_eq!(options(os(&args)).err(), Some("RequestInvalid"), "{args:?}");
            // the whole run answers a closed failure without touching stdin or a port
            closed(&run(os(&args), std::io::Cursor::new(b"{}".to_vec())));
        }
    }

    #[test]
    fn oversize_and_malformed_stdin_are_closed_failures() {
        let big = vec![b' '; depart::MAX_REQUEST_BYTES + 1];
        let v = run(os(&good()), std::io::Cursor::new(big));
        closed(&v);
        assert_eq!(v["blocker"]["code"], "RequestInvalid");
        assert_eq!(v["request"], serde_json::Value::Null);
        for body in [&b""[..], b"null", b"{\"schema\":\"frontier-experimental-expedition-prepare-request-v1\"}"] {
            let v = run(os(&good()), std::io::Cursor::new(body.to_vec()));
            closed(&v);
            assert_eq!(v["blocker"]["code"], "RequestInvalid");
        }
    }

    /// `wideclaim_preview::validate_rpc_url`: `http://` to 127.0.0.1 or [::1]
    /// with an explicit port 1–65535 and a plain path; nothing else.
    #[test]
    fn only_explicit_loopback_http_with_a_port_is_accepted() {
        for ok in ["http://127.0.0.1:8899", "http://[::1]:8899", "http://127.0.0.1:1/rpc", "http://[::1]:65535/a-b_c.d~e"] {
            let mut v = good();
            v[1] = ok.into();
            assert!(options(os(&v)).is_ok(), "{ok}");
        }
        for bad in [
            "https://127.0.0.1:8899",
            "https://api.devnet.solana.com",
            "http://api.devnet.solana.com:8899",
            "http://203.0.113.5:8899",
            "http://localhost:8899",
            "http://127.0.0.1",
            "http://127.0.0.1:",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://user@127.0.0.1:8899",
            "http://user:pass@127.0.0.1:8899",
            "http://127.0.0.1:8899?x=1",
            "http://127.0.0.1:8899/rpc?x=1",
            "http://127.0.0.1:8899#frag",
            "http://127.0.0.1:8899/%2e%2e",
            "http://127.0.0.2:8899",
            "http://[::2]:8899",
        ] {
            let mut v = good();
            v[1] = bad.into();
            assert_eq!(options(os(&v)).err(), Some("RequestInvalid"), "{bad}");
        }
    }

    #[test]
    fn only_a_prepared_report_exits_zero() {
        assert_eq!(exit_code(&serde_json::json!({"status":"prepared"})), 0);
        assert_eq!(exit_code(&serde_json::json!({"status":"blocked"})), 2);
        assert_eq!(exit_code(&serde_json::json!({})), 2);
    }
}
