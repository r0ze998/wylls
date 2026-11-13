//! One-shot stdin/stdout preparation only. Never starts a keeper or signs.
use fclient::{blockhash_preflight, rpc::RpcPort};
use keeper_core::{experimental_conquest_prepare as prepare, wideexpedition_preview as preview};
use std::{ffi::OsString, io::Write, time::Duration};

fn options(
    args: impl IntoIterator<Item = OsString>,
) -> Result<(String, prepare::Settings), &'static str> {
    let args: Vec<_> = args
        .into_iter()
        .map(|s| s.into_string().map_err(|_| "RequestInvalid"))
        .collect::<Result<_, _>>()?;
    let names = [
        "--rpc-url",
        "--program",
        "--season",
        "--fee-payer",
        "--ruleset-hash",
        "--cu-limit",
        "--loaded-limit",
    ];
    if args.len() != 14
        || names
            .iter()
            .enumerate()
            .any(|(i, name)| args[i * 2] != *name)
    {
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
    if args[9].len() != 64
        || !args[9]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
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
    Ok((
        args[1].clone(),
        prepare::Settings {
            program: public(&args[3])?,
            season: public(&args[5])?,
            fee_payer: public(&args[7])?,
            ruleset_hash,
            cu_limit: number(&args[11])?,
            loaded_limit: number(&args[13])?,
        },
    ))
}
fn run() -> serde_json::Value {
    let (url, settings) = match options(std::env::args_os().skip(1)) {
        Ok(x) => x,
        Err(code) => return prepare::failure(None, code),
    };
    let request = match prepare::read_request(std::io::stdin().lock()) {
        Ok(x) => x,
        Err(code) => return prepare::failure(None, code),
    };
    let source = RpcPort::new_with_response_limit(
        url.clone(),
        settings.program,
        preview::MAX_RPC_RESPONSE_BYTES,
    );
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
    {
        Ok(r) => r,
        Err(_) => return prepare::failure(Some(&request), "SourceUnavailable"),
    };
    let rpc_url = &url;
    runtime.block_on(async {
        match tokio::time::timeout(
            Duration::from_secs(25),
            prepare::prepare(&request, settings, &source, |floor| async move {
                blockhash_preflight::read(rpc_url, floor)
                    .await
                    .map_err(|_| ())
            }),
        )
        .await
        {
            Ok(value) => value,
            Err(_) => prepare::failure(Some(&request), "SourceUnavailable"),
        }
    })
}
fn main() {
    let report = run();
    let bytes = prepare::output_bytes(&report);
    let exit = if report["status"] == "prepared" { 0 } else { 2 };
    let mut out = std::io::stdout().lock();
    if out.write_all(&bytes).is_err() || out.write_all(b"\n").is_err() || out.flush().is_err() {
        std::process::exit(1);
    }
    std::process::exit(exit);
}
