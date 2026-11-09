//! A separate one-shot executable, never `frontier-keeper` startup.
//! No config, master seed, keypair, journal, engine, duty, listener or daemon.

use std::ffi::OsString;
use std::io::Write;
use std::time::Duration;

use fclient::rpc::RpcPort;
use keeper_core::wideclaim_preview::{self as preview, Report, MAX_RPC_RESPONSE_BYTES};

const PREVIEW_TIMEOUT: Duration = Duration::from_secs(25);

struct Options {
    rpc_url: String,
    request_file: Option<OsString>,
}

fn options(args: impl IntoIterator<Item = OsString>) -> Result<Options, Report> {
    let mut args = args.into_iter();
    let mut rpc_url = None;
    let mut request_file = None;
    let mut request_seen = false;
    // At most two named options, each with a value. Unknown flags (including
    // daemon/key flags), repeats, positional args and extra args all fail.
    for _ in 0..2 {
        let Some(flag) = args.next() else { break };
        if flag == "--rpc-url" && rpc_url.is_none() {
            rpc_url = Some(
                args.next()
                    .and_then(|s| s.into_string().ok())
                    .ok_or_else(|| preview::failure("arguments", "Usage"))?,
            );
        } else if flag == "--request" && !request_seen {
            request_seen = true;
            let path = args
                .next()
                .ok_or_else(|| preview::failure("arguments", "Usage"))?;
            if path != "-" {
                request_file = Some(path);
            }
        } else {
            return Err(preview::failure("arguments", "Usage"));
        }
    }
    if args.next().is_some() {
        return Err(preview::failure("arguments", "Usage"));
    }
    let rpc_url = rpc_url.ok_or_else(|| preview::failure("arguments", "ExplicitRpcRequired"))?;
    preview::validate_rpc_url(&rpc_url).map_err(preview::request_failure)?;
    Ok(Options {
        rpc_url,
        request_file,
    })
}

fn run() -> Result<Report, Report> {
    let options = options(std::env::args_os().skip(1))?;
    let request = match options.request_file {
        Some(path) => {
            let file =
                std::fs::File::open(path).map_err(|_| preview::failure("request", "InputOpen"))?;
            preview::read_request(file)
        }
        None => preview::read_request(std::io::stdin().lock()),
    }
    .map_err(preview::request_failure)?;

    // Only validated public input reaches either constructor. Neither
    // constructor opens a key store or reads any keeper configuration.
    let source = RpcPort::new_with_response_limit(
        options.rpc_url,
        request.program(),
        MAX_RPC_RESPONSE_BYTES,
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| preview::failure("runtime", "RuntimeUnavailable"))?;
    Ok(runtime.block_on(async {
        match tokio::time::timeout(PREVIEW_TIMEOUT, preview::preview(&request, &source)).await {
            Ok(report) => report,
            Err(_) => preview::snapshot_timeout_failure(),
        }
    }))
}

fn main() {
    let report = match run() {
        Ok(report) | Err(report) => report,
    };
    let exit = if report.is_preview() { 0 } else { 2 };
    let mut output = std::io::stdout().lock();
    // All diagnostics use the same bounded JSON channel; no path, URL,
    // raw RPC/server error or debug representation is written to stderr.
    if output.write_all(&report.to_json_bytes()).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        std::process::exit(1);
    }
    std::process::exit(exit);
}

#[cfg(test)]
mod argument_tests {
    use super::{options, Options};
    use keeper_core::wideclaim_preview::Report;
    use std::ffi::OsString;

    // Only the pure argument parser is called. No std::env, request-file
    // read, stdin, runtime, source, process spawn or executable main.
    fn parse(args: &[&str]) -> Result<Options, Report> {
        options(args.iter().map(|arg| OsString::from(*arg)))
    }

    #[test]
    fn missing_explicit_url_and_missing_option_values_block() {
        for args in [vec![], vec!["--request", "input.json"]] {
            let report = parse(&args).err().unwrap();
            assert_eq!(report.json()["blocker"]["code"], "ExplicitRpcRequired");
        }
        for args in [
            vec!["--rpc-url"],
            vec!["--request"],
            vec!["--request", "input.json", "--rpc-url"],
        ] {
            assert_eq!(
                parse(&args).err().unwrap().json()["blocker"]["code"],
                "Usage"
            );
        }
    }

    #[test]
    fn repeated_unknown_and_extra_arguments_block() {
        for args in [
            vec![
                "--rpc-url",
                "http://127.0.0.1:8899",
                "--rpc-url",
                "http://127.0.0.1:8899",
            ],
            vec!["--request", "a", "--request", "b"],
            vec![
                "--rpc-url",
                "http://127.0.0.1:8899",
                "--request",
                "a",
                "extra",
            ],
            vec!["--rpc-url", "http://127.0.0.1:8899", "--unknown"],
            vec!["--config", "keeper.toml"],
            vec!["--init-seed"],
            vec!["--dev"],
            vec!["--rpc-url", "http://127.0.0.1:8899", "input.json"],
        ] {
            assert_eq!(
                parse(&args).err().unwrap().json()["blocker"]["code"],
                "Usage"
            );
        }
    }

    #[test]
    fn both_named_option_orderings_are_equivalent_without_opening_file() {
        let a = parse(&[
            "--rpc-url",
            "http://127.0.0.1:8899/rpc",
            "--request",
            "not-opened.json",
        ])
        .unwrap();
        let b = parse(&[
            "--request",
            "not-opened.json",
            "--rpc-url",
            "http://127.0.0.1:8899/rpc",
        ])
        .unwrap();
        assert_eq!(a.rpc_url, b.rpc_url);
        assert_eq!(a.request_file, b.request_file);
        assert_eq!(a.request_file, Some(OsString::from("not-opened.json")));
    }

    #[test]
    fn omitted_request_and_dash_select_stdin_without_reading_it() {
        for args in [
            vec!["--rpc-url", "http://127.0.0.1:8899"],
            vec!["--request", "-", "--rpc-url", "http://127.0.0.1:8899"],
        ] {
            assert!(parse(&args).unwrap().request_file.is_none());
        }
    }

    #[test]
    fn url_policy_is_applied_by_argument_parser() {
        for url in [
            "https://127.0.0.1:8899",
            "http://localhost:8899",
            "http://example.invalid:8899",
            "http://127.0.0.1:0",
            "http://127.0.0.1:8899/?secret=value",
        ] {
            assert!(parse(&["--rpc-url", url]).is_err());
        }
        assert!(parse(&["--rpc-url", "http://[::1]:8899/"]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_rpc_url_blocks_without_echoing_bytes() {
        use std::os::unix::ffi::OsStringExt;
        let report = options([OsString::from("--rpc-url"), OsString::from_vec(vec![0xff])])
            .err()
            .unwrap();
        assert_eq!(report.json()["blocker"]["code"], "Usage");
    }
}
