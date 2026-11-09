//! Stdin-only, one-shot read adapter. Never enters frontier-keeper startup.
use fclient::rpc::RpcPort;
use keeper_core::wideexpedition_preview::{self as preview, Report};
use std::{ffi::OsString, io::Write, time::Duration};
fn options(args: impl IntoIterator<Item = OsString>) -> Result<String, Report> {
    let mut a = args.into_iter();
    if a.next().as_deref() != Some(std::ffi::OsStr::new("--rpc-url")) {
        return Err(preview::failure("arguments", "ExplicitRpcRequired"));
    }
    let url = a
        .next()
        .and_then(|s| s.into_string().ok())
        .ok_or_else(|| preview::failure("arguments", "Usage"))?;
    if a.next().is_some() {
        return Err(preview::failure("arguments", "Usage"));
    }
    preview::validate_rpc_url(&url).map_err(|e| preview::failure("arguments", e.code))?;
    Ok(url)
}
fn run() -> Result<Report, Report> {
    let url = options(std::env::args_os().skip(1))?;
    let request =
        preview::read_request(std::io::stdin().lock()).map_err(preview::request_failure)?;
    let source =
        RpcPort::new_with_response_limit(url, request.program(), preview::MAX_RPC_RESPONSE_BYTES);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| preview::failure("runtime", "RuntimeUnavailable"))?;
    Ok(runtime.block_on(async {
        match tokio::time::timeout(Duration::from_secs(25), preview::preview(&request, &source))
            .await
        {
            Ok(r) => r,
            Err(_) => preview::snapshot_timeout_failure(&request),
        }
    }))
}
fn main() {
    let report = match run() {
        Ok(r) | Err(r) => r,
    };
    let exit = if report.is_preview() { 0 } else { 2 };
    let mut out = std::io::stdout().lock();
    if out.write_all(&report.to_json_bytes()).is_err()
        || out.write_all(b"\n").is_err()
        || out.flush().is_err()
    {
        std::process::exit(1);
    }
    std::process::exit(exit);
}
#[cfg(test)]
mod argument_tests {
    use super::*;
    fn args(v: &[&str]) -> Result<String, Report> {
        options(v.iter().map(OsString::from))
    }
    #[test]
    fn only_explicit_bounded_loopback_rpc_option_is_accepted() {
        assert!(args(&["--rpc-url", "http://127.0.0.1:8899/rpc"]).is_ok());
        for v in [
            vec![],
            vec!["--rpc-url"],
            vec!["--init-seed"],
            vec!["--request", "secret.json"],
            vec!["--rpc-url", "http://127.0.0.1:8899", "--dev"],
            vec!["--rpc-url", "https://example.invalid"],
            vec!["--rpc-url", "http://127.0.0.1:8899/?token=hidden"],
        ] {
            assert!(args(&v).is_err());
        }
    }
}
