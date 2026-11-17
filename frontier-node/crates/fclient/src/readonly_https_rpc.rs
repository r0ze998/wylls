//! Opt-in HTTPS transport for public, read-only Solana JSON-RPC observations.
//! No signing, simulation, submission, authentication or snapshot admission.
//! Each call starts one curl process; cancellation requests kill/reap on the
//! worker's next 10 ms poll. OS scheduling can delay that poll. Both curl and
//! the worker also impose a five-second deadline. No stderr or URL is echoed.
use crate::ports::{PortError, PortResult};
use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const TIMEOUT_SECONDS: u64 = 5;
const TRAILER_BYTES: usize = 64;
const POLL: Duration = Duration::from_millis(10);

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

struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct Process {
    child: Child,
    reaped: bool,
}
impl Process {
    fn stop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            if self.child.wait().is_ok() {
                self.reaped = true;
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}

fn bounded_output(
    reader: impl Read,
    cap: usize,
    overflow: &AtomicBool,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take((cap + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > cap {
        overflow.store(true, Ordering::Release);
    }
    Ok(bytes)
}

fn run(
    args: Vec<String>,
    request: Vec<u8>,
    cap: usize,
    cancelled: Arc<AtomicBool>,
) -> PortResult<Value> {
    // Cancellation while this blocking job was queued must not start a process.
    if cancelled.load(Ordering::Acquire) {
        return Err(io("cancelled"));
    }
    let start = Instant::now();
    let child = Command::new("curl")
        .args(args)
        .env_remove("SSLKEYLOGFILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| io("process unavailable"))?;
    let mut process = Process {
        child,
        reaped: false,
    };
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| io("stdout unavailable"))?;
    let mut stdin = process
        .child
        .stdin
        .take()
        .ok_or_else(|| io("stdin unavailable"))?;
    std::thread::scope(move |scope| {
        // Own the guard inside the scoped closure: a thread-creation panic
        // must kill curl before scope's automatic joins wait on pipe readers.
        let mut process = process;
        let overflow = Arc::new(AtomicBool::new(false));
        let reader_overflow = overflow.clone();
        let output =
            scope.spawn(move || bounded_output(stdout, cap + TRAILER_BYTES, &reader_overflow));
        let input = scope.spawn(move || stdin.write_all(&request));
        let status = loop {
            if cancelled.load(Ordering::Acquire)
                || overflow.load(Ordering::Acquire)
                || start.elapsed() >= Duration::from_secs(TIMEOUT_SECONDS)
            {
                process.stop();
                break Err(io("cancelled, timed out or exceeded response limit"));
            }
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    process.reaped = true;
                    break Ok(status);
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => {
                    process.stop();
                    break Err(io("process wait failed"));
                }
            }
        };
        // On all monitor exits the child is reaped before joining pipe workers.
        let output = output
            .join()
            .map_err(|_| io("response worker failed"))?
            .map_err(|_| io("response read failed"))?;
        let input = input.join().map_err(|_| io("request worker failed"))?;
        if !status?.success() {
            return Err(io("curl failed"));
        }
        input.map_err(|_| io("request write failed"))?;
        parse_output(&output, cap)
    })
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
    let _cancel = Cancel(cancelled.clone());
    tokio::task::spawn_blocking(move || run(args, request, max_response_bytes, cancelled))
        .await
        .map_err(|_| io("worker failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_reader_stops_after_one_overflow_byte_without_process() {
        let overflow = AtomicBool::new(false);
        assert_eq!(
            bounded_output(&b"abcdef"[..], 3, &overflow).unwrap(),
            b"abcd"
        );
        assert!(overflow.load(Ordering::Acquire));
        let overflow = AtomicBool::new(false);
        assert_eq!(bounded_output(&b"abc"[..], 3, &overflow).unwrap(), b"abc");
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[test]
    fn cancelled_queued_worker_never_launches_a_process() {
        let cancelled = Arc::new(AtomicBool::new(false));
        drop(Cancel(cancelled.clone()));
        assert!(run(vec![], vec![], 100, cancelled).is_err());
    }
}
