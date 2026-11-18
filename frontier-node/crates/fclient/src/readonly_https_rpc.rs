//! Opt-in HTTPS transport for public, read-only Solana JSON-RPC observations.
//! No signing, simulation, submission, authentication or snapshot admission.
//! Each call starts one curl process; cancellation requests kill/reap on the
//! worker's next 10 ms poll. OS scheduling can delay that poll. Both curl and
//! the worker also impose a five-second deadline. No stderr or URL is echoed.
use crate::ports::{PortError, PortResult};
use serde_json::Value;
use std::io::Write;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const TIMEOUT_SECONDS: u64 = 5;
const TRAILER_BYTES: usize = 64;

fn decode(what: &str) -> PortError {
    PortError::Decode(format!("read-only HTTPS RPC {what}"))
}
fn io(what: &str) -> PortError {
    PortError::Io(format!("read-only HTTPS RPC {what}"))
}

/// Encode only allowlisted read methods. Parameters must contain public data;
/// this transport does not classify arbitrary strings as secrets or credentials.
/// This helper performs no I/O and rejects writes before process creation.
pub fn request_bytes(method: &str, params: Value) -> PortResult<Vec<u8>> {
    if !matches!(
        method,
        "getLatestBlockhash"
            | "isBlockhashValid"
            | "getBlockHeight"
            | "getMultipleAccounts"
            | "getAccountInfo"
            | "getVersion"
            | "getSlot"
    ) {
        return Err(PortError::Unsupported("read-only HTTPS RPC method"));
    }
    if !params.is_array() {
        return Err(decode("params must be an array"));
    }
    // A bounded writer prevents allocating an unbounded second copy of params.
    let mut bytes = LimitedWriter(Vec::new());
    // Stream the envelope and borrow params directly, avoiding an intermediate
    // Value/envelope clone before the bounded writer takes effect.
    let encoding = || decode("request exceeds limit or cannot be encoded");
    bytes
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":")
        .map_err(|_| encoding())?;
    serde_json::to_writer(&mut bytes, method).map_err(|_| encoding())?;
    bytes.write_all(b",\"params\":").map_err(|_| encoding())?;
    serde_json::to_writer(&mut bytes, &params).map_err(|_| encoding())?;
    bytes.write_all(b"}").map_err(|_| encoding())?;
    Ok(bytes.0)
}
struct LimitedWriter(Vec<u8>);
impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_REQUEST_BYTES - self.0.len() {
            return Err(std::io::Error::other("request limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Auditable argument vector only; HTTPS, strict public URL, no redirects,
/// netrc, curlrc, insecure verification or inherited proxy. Request is stdin.
pub fn curl_args(url: &str, cap: usize) -> PortResult<Vec<String>> {
    if !url.starts_with("https://") || url.len() > 2048 {
        return Err(PortError::Unsupported(
            "read-only RPC requires a bounded HTTPS URL",
        ));
    }
    crate::http::check_curl_url(url)
        .map_err(|_| PortError::Unsupported("read-only RPC URL format"))?;
    if cap == 0 || cap > MAX_RESPONSE_BYTES {
        return Err(decode("response limit"));
    }
    Ok([
        "-q",
        "--silent",
        "--no-netrc",
        "--no-insecure",
        "--no-location",
        "--proxy",
        "",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-redirs",
        "0",
        "--tlsv1.2",
        "--connect-timeout",
        "5",
        "--max-time",
        "5",
        "--max-filesize",
        &cap.to_string(),
        "--request",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "Accept: application/json",
        "--data-binary",
        "@-",
        "--write-out",
        "\n%{http_code} %{ssl_verify_result} %{scheme}",
        "--url",
        url,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect())
}

/// Decode a successful curl process's bounded output. The TLS trailer and
/// matching JSON-RPC envelope are mandatory. Remote diagnostic text is omitted.
pub fn parse_output(bytes: &[u8], cap: usize) -> PortResult<Value> {
    if cap == 0 || cap > MAX_RESPONSE_BYTES || bytes.len() > cap + TRAILER_BYTES {
        return Err(decode("response limit"));
    }
    let split = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .ok_or_else(|| decode("TLS trailer"))?;
    if split > cap || bytes.len() - split > TRAILER_BYTES {
        return Err(decode("response limit"));
    }
    let trailer = std::str::from_utf8(&bytes[split + 1..]).map_err(|_| decode("TLS trailer"))?;
    let fields: Vec<_> = trailer.split_whitespace().collect();
    if fields.len() != 3 || fields[1] != "0" || !fields[2].eq_ignore_ascii_case("https") {
        return Err(decode("unverified TLS trailer"));
    }
    if fields[0] != "200" {
        return Err(decode("HTTP status"));
    }
    let envelope: Value = serde_json::from_slice(&bytes[..split]).map_err(|_| decode("JSON"))?;
    let object = envelope.as_object().ok_or_else(|| decode("envelope"))?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object.get("id").and_then(Value::as_u64) != Some(1)
    {
        return Err(decode("envelope identity"));
    }
    match (object.get("result"), object.get("error")) {
        (Some(value), None) => Ok(value.clone()),
        (None, Some(error)) => {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .ok_or_else(|| decode("error code"))?;
            error
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| decode("error message"))?;
            Err(PortError::Rpc {
                code,
                message: "read-only HTTPS RPC remote error".into(),
            })
        }
        _ => Err(decode("result/error envelope")),
    }
}

fn run(
    args: Vec<String>,
    request: Vec<u8>,
    cap: usize,
    cancelled: Arc<AtomicBool>,
) -> PortResult<Value> {
    // The process runner is `crate::https`'s (shared with the general POST);
    // this policy keeps its own deadline, cap and error texts.
    use crate::https::RunError;
    let output = crate::https::run_curl(
        args,
        request,
        cap + TRAILER_BYTES,
        Duration::from_secs(TIMEOUT_SECONDS),
        cancelled,
    )
    .map_err(|e| match e {
        RunError::Stopped => io("cancelled, timed out or exceeded response limit"),
        RunError::Spawn => io("process unavailable"),
        RunError::Wait => io("process wait failed"),
        RunError::Read => io("response read failed"),
        RunError::Write => io("request write failed"),
        RunError::Exit(_) => io("curl failed"),
    })?;
    parse_output(&output, cap)
}

/// Read-only RPC through verified HTTPS, with public JSON sent via stdin.
/// A caller's timeout/drop signals the worker to kill and reap curl. This is
/// transport verification only; returned account data is not execution consent.
pub async fn call(
    url: &str,
    method: &str,
    params: Value,
    max_response_bytes: usize,
) -> PortResult<Value> {
    let request = request_bytes(method, params)?;
    let args = curl_args(url, max_response_bytes)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = crate::https::Cancel(cancelled.clone());
    tokio::task::spawn_blocking(move || run(args, request, max_response_bytes, cancelled))
        .await
        .map_err(|_| io("worker failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_queued_worker_never_launches_a_process() {
        let cancelled = Arc::new(AtomicBool::new(false));
        drop(crate::https::Cancel(cancelled.clone()));
        assert!(run(vec![], vec![], 100, cancelled).is_err());
    }
}
