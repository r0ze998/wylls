//! The https transport of `frontier-node`: the only place that speaks TLS.
//!
//! Everything goes through the system `curl` (the contract's dependency set
//! has no TLS crate; W1-F R4 is still a request, and devnet-readiness Q-D2
//! keeps it that way until r0ze decides). Replacing curl with a Rust TLS
//! client (e.g. `ureq` + `rustls`) means re-implementing [`curl_get_with`]
//! and [`post`] in this module; no caller names curl.
//!
//! **GET** (live drand: `api.drand.sh` and its mirrors, W2-C D7). `-q`
//! first (no `.curlrc` can turn verification off), `--proto =https` and no
//! redirect following, TLS ≥ 1.2, bounded time and size, the URL passed
//! with `--url` after a strict check (no userinfo, escapes, whitespace,
//! quotes or query), and the answer refused unless curl reports scheme
//! HTTPS with `ssl_verify_result` 0. Peer certificates are checked against
//! curl's trust store (`CURL_CA_BUNDLE` / `SSL_CERT_FILE` when the host sets
//! them). TLS only protects the transport: a drand round is accepted
//! because it verifies against the pinned key (`beacon::HttpDrand`), never
//! because of the certificate.
//!
//! **POST** (JSON-RPC to a public cluster: devnet-readiness B1). The same
//! hardening, plus: **nothing request-specific is on the argument vector**.
//! The URL (a provider's API key may sit in its path or query) and the body
//! (signed transactions) reach curl as a config file on stdin (`--config
//! -`; the body as `data-raw`, so a leading `@` is never a file name), so
//! `ps` shows only fixed flags. Globbing, `.netrc`, inherited
//! proxies, `--insecure` and redirects are off; `SSLKEYLOGFILE` is removed
//! from curl's environment. The response is read through a bounded pipe
//! (one byte over the cap kills curl), curl's own `--max-time` and a
//! watchdog both bound the time, and a dropped future kills and reaps the
//! process. Errors never echo the URL past its host ([`redact`]) nor curl's
//! stderr. Plain `http://` is accepted only to loopback (tests, a local
//! TLS-terminating proxy); the plain-http client in `crate::http` still
//! serves loopback POSTs itself.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::http::{is_loopback, Response};
use crate::ports::{PortError, PortResult};

/// Largest body an `https://` GET accepts (a drand round is ≈ 200 B, its
/// info ≈ 500 B).
pub const HTTPS_MAX_BODY: u64 = 64 * 1024;

/// Checks a URL handed to curl: `https://` (or `http://` on loopback
/// only), an authority of lowercase DNS letters, digits, `.`, `-` (or a
/// bracketed loopback IPv6) with an optional numeric port, and a path of
/// unreserved characters and `/` only. Nothing curl could read as an
/// option, a second URL, a glob or userinfo gets through.
pub fn check_curl_url(url: &str) -> Result<(), PortError> {
    let bad = |why: &'static str| Err(PortError::Unsupported(why));
    let (scheme, rest) = match url.split_once("://") {
        Some(("https", r)) => ("https", r),
        Some(("http", r)) if is_loopback(url) => ("http", r),
        Some(("http", _)) => return bad("plain http:// only to loopback"),
        _ => return bad("not an http(s) URL"),
    };
    let _ = scheme;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = match authority.strip_prefix('[') {
        Some(h) => match h.split_once(']') {
            Some(("::1", tail)) => ("::1", tail),
            _ => return bad("bracketed host other than [::1]"),
        },
        None => match authority.find(':') {
            Some(i) => (&authority[..i], &authority[i..]),
            None => (authority, ""),
        },
    };
    let host_ok = host == "::1"
        || (!host.is_empty()
            && host.len() <= 253
            && !host.starts_with(['-', '.'])
            && !host.contains("..")
            && host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'));
    if !host_ok {
        return bad("host must be lowercase letters, digits, '.' and '-'");
    }
    let port_ok = port.is_empty()
        || port.strip_prefix(':').is_some_and(|p| {
            !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit())
        });
    if !port_ok {
        return bad("port must be numeric");
    }
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~'))
    {
        return bad("path must be unreserved characters and '/' only");
    }
    Ok(())
}

/// The curl argument vector for one GET (`-q` must stay first: it is the
/// only way to keep a `.curlrc` out). `cacert` replaces the trust store
/// (tests with their own CA).
pub fn curl_args(url: &str, cacert: Option<&std::path::Path>) -> Vec<String> {
    let proto = if url.starts_with("https://") {
        "=https"
    } else {
        "=http"
    };
    let mut a: Vec<String> = [
        "-q",
        "--silent",
        "--show-error",
        "--proto",
        proto,
        "--proto-redir",
        "=https",
        "--max-redirs",
        "0",
        "--tlsv1.2",
        "--connect-timeout",
        "10",
        "--max-time",
        "15",
        "--max-filesize",
        &HTTPS_MAX_BODY.to_string(),
        "--header",
        "Accept: application/json",
        "--write-out",
        "\n%{http_code} %{ssl_verify_result} %{scheme}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(p) = cacert {
        a.push("--cacert".into());
        a.push(p.display().to_string());
    }
    a.push("--url".into());
    a.push(url.into());
    a
}

/// `GET` through curl (see the module notes). The status is curl's; no
/// response headers are returned.
pub async fn curl_get(url: &str) -> Result<Response, PortError> {
    curl_get_with(url, None).await
}

/// [`curl_get`] with an explicit trust anchor file.
pub async fn curl_get_with(
    url: &str,
    cacert: Option<std::path::PathBuf>,
) -> Result<Response, PortError> {
    check_curl_url(url)?;
    let args = curl_args(url, cacert.as_deref());
    let https = url.starts_with("https://");
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("curl")
            .args(&args)
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await
    .map_err(|e| PortError::Io(format!("curl: {e}")))?
    .map_err(|e| PortError::Io(format!("curl: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err: String = err.trim().chars().take(300).collect();
        return Err(PortError::Io(format!(
            "curl exit {}: {err}",
            out.status.code().unwrap_or(-1)
        )));
    }
    parse_curl_output(&out.stdout, https)
}

/// Splits curl's stdout into the body and the `--write-out` trailer
/// `\n<status> <ssl_verify_result> <scheme>`, refusing an answer that did
/// not come over a verified TLS session when `https` is asked.
pub fn parse_curl_output(stdout: &[u8], https: bool) -> Result<Response, PortError> {
    parse_curl_output_capped(stdout, https, HTTPS_MAX_BODY)
}

/// [`parse_curl_output`] with a body cap other than [`HTTPS_MAX_BODY`].
pub fn parse_curl_output_capped(
    stdout: &[u8],
    https: bool,
    max_body: u64,
) -> Result<Response, PortError> {
    let nl = stdout
        .iter()
        .rposition(|&c| c == b'\n')
        .ok_or_else(|| PortError::Decode("curl: no trailer".into()))?;
    let trailer = std::str::from_utf8(&stdout[nl + 1..])
        .map_err(|_| PortError::Decode("curl: trailer utf8".into()))?;
    let mut f = trailer.split_whitespace();
    let (Some(code), Some(verify), Some(scheme), None) = (f.next(), f.next(), f.next(), f.next())
    else {
        return Err(PortError::Decode(format!("curl: trailer {trailer:?}")));
    };
    let status: u16 = code
        .parse()
        .map_err(|_| PortError::Decode(format!("curl: status {code:?}")))?;
    if https && (verify != "0" || !scheme.eq_ignore_ascii_case("https")) {
        return Err(PortError::Io(format!(
            "curl: not a verified TLS answer (ssl_verify_result {verify}, scheme {scheme})"
        )));
    }
    if status == 0 {
        return Err(PortError::Io("curl: no HTTP status".into()));
    }
    let body = stdout[..nl].to_vec();
    if body.len() as u64 > max_body {
        return Err(PortError::Decode("curl: body too large".into()));
    }
    Ok(Response {
        status,
        headers: vec![],
        body,
    })
}
// ---------------------------------------------------------------- POST

/// Largest request body [`post`] sends (a JSON-RPC call; a signed
/// transaction is ≤ 1,232 B before base64).
pub const POST_MAX_REQUEST: usize = 1 << 20;
/// Default cap on a [`post`] response body (a `getMultipleAccounts` page of
/// 100 accounts, base64).
pub const POST_MAX_RESPONSE: usize = 16 << 20;
/// Default deadline of one [`post`], connect included (= `http::TIMEOUT`).
pub const POST_TIMEOUT_SECS: u64 = 20;
/// Longest URL [`post`] accepts.
pub const MAX_URL: usize = 2048;
/// The `--write-out` trailer's bound (`\n<code> <verify> <scheme>`).
pub const TRAILER_BYTES: usize = 64;
const POLL: Duration = Duration::from_millis(10);

/// One POST's limits and trust anchor.
#[derive(Clone, Debug)]
pub struct PostOpts {
    /// Cap on the response body (1 ..= [`POST_MAX_RESPONSE`] × 4).
    pub max_response_bytes: usize,
    /// Deadline in seconds (1 ..= 120), connect included.
    pub timeout_secs: u64,
    /// Replaces curl's trust store (tests with their own CA).
    pub cacert: Option<std::path::PathBuf>,
}

impl Default for PostOpts {
    fn default() -> Self {
        PostOpts {
            max_response_bytes: POST_MAX_RESPONSE,
            timeout_secs: POST_TIMEOUT_SECS,
            cacert: None,
        }
    }
}

/// `scheme://host[:port]` of `url` (or `"<url>"` when it does not parse):
/// what errors and logs may show of an RPC URL.
pub fn redact(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme @ ("http" | "https"), rest)) => {
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            let authority = &rest[..end];
            if authority.contains('@') {
                format!("{scheme}://<redacted>")
            } else {
                format!("{scheme}://{authority}")
            }
        }
        _ => "<url>".into(),
    }
}

/// Checks a URL for [`post`]: [`check_curl_url`] on everything before an
/// optional query, and a query (a provider's `?api-key=…`) of unreserved
/// characters, `=` and `&` only. At most [`MAX_URL`] bytes; no fragment.
pub fn check_post_url(url: &str) -> Result<(), PortError> {
    if url.len() > MAX_URL {
        return Err(PortError::Unsupported("URL too long"));
    }
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (url, None),
    };
    check_curl_url(base)?;
    if let Some(q) = query {
        if q.is_empty()
            || !q.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'=' | b'&')
            })
        {
            return Err(PortError::Unsupported(
                "query must be unreserved characters, '=' and '&' only",
            ));
        }
    }
    Ok(())
}

/// The fixed curl argument vector of one POST (`-q` must stay first). No
/// URL, body or header carrying request data: those go on stdin
/// ([`post_config`]).
pub fn post_args(https: bool, opts: &PostOpts) -> Vec<String> {
    let mut a: Vec<String> = [
        "-q",
        "--silent",
        "--globoff",
        "--no-netrc",
        "--no-insecure",
        "--no-location",
        "--proxy",
        "",
        "--proto",
        if https { "=https" } else { "=http" },
        "--proto-redir",
        "=https",
        "--max-redirs",
        "0",
        "--tlsv1.2",
        "--connect-timeout",
        &opts.timeout_secs.min(10).to_string(),
        "--max-time",
        &opts.timeout_secs.to_string(),
        "--max-filesize",
        &opts.max_response_bytes.to_string(),
        "--header",
        "Content-Type: application/json",
        "--header",
        "Accept: application/json",
        "--header",
        "Expect:",
        "--write-out",
        "\n%{http_code} %{ssl_verify_result} %{scheme}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(p) = &opts.cacert {
        a.push("--cacert".into());
        a.push(p.display().to_string());
    }
    a.push("--config".into());
    a.push("-".into());
    a
}

/// A curl config string: `"…"` with `\` and `"` escaped. Refuses bytes a
/// config line cannot carry (CR, LF, NUL and other controls): a compact
/// `serde_json` body never has them (it escapes controls itself).
fn config_quote(out: &mut Vec<u8>, s: &[u8]) -> Result<(), PortError> {
    out.push(b'"');
    for &b in s {
        match b {
            b'\\' | b'"' => out.extend_from_slice(&[b'\\', b]),
            0..=0x1f | 0x7f => return Err(PortError::Decode("body has a control byte".into())),
            _ => out.push(b),
        }
    }
    out.push(b'"');
    Ok(())
}

/// The config curl reads on stdin for one POST: the URL and the body.
/// The body goes as `data-raw`, never `data-binary`/`data`: those read a
/// value starting with `@` as a file name and would upload that local file.
pub fn post_config(url: &str, body: &[u8]) -> Result<Vec<u8>, PortError> {
    let mut c = Vec::with_capacity(body.len() + url.len() + 32);
    c.extend_from_slice(b"url = ");
    config_quote(&mut c, url.as_bytes())?;
    c.extend_from_slice(b"\ndata-raw = ");
    config_quote(&mut c, body)?;
    c.push(b'\n');
    Ok(c)
}

/// `POST` a JSON body through curl (see the module notes). The status is
/// curl's (any status is returned, e.g. 429); no response headers.
pub async fn post(url: &str, body: Vec<u8>, opts: &PostOpts) -> PortResult<Response> {
    check_post_url(url)?;
    if body.len() > POST_MAX_REQUEST {
        return Err(PortError::Decode("request body too large".into()));
    }
    if opts.max_response_bytes == 0
        || opts.max_response_bytes > POST_MAX_RESPONSE * 4
        || !(1..=120).contains(&opts.timeout_secs)
    {
        return Err(PortError::Unsupported("https POST limits out of range"));
    }
    let https = url.starts_with("https://");
    let args = post_args(https, opts);
    let stdin = post_config(url, &body)?;
    let cap = opts.max_response_bytes;
    let timeout = Duration::from_secs(opts.timeout_secs + 1);
    let host = redact(url);
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = Cancel(cancelled.clone());
    let out = tokio::task::spawn_blocking(move || {
        run_curl(args, stdin, cap + TRAILER_BYTES, timeout, cancelled)
    })
    .await
    .map_err(|_| PortError::Io(format!("POST {host}: worker failed")))?
    .map_err(|e| PortError::Io(format!("POST {host}: {e}")))?;
    parse_curl_output_capped(&out, https, cap as u64).map_err(|e| match e {
        PortError::Io(m) => PortError::Io(format!("POST {host}: {m}")),
        PortError::Decode(m) => PortError::Decode(format!("POST {host}: {m}")),
        e => e,
    })
}

// ---------------------------------------------------------------- the process

/// Why [`run_curl`] gave no output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunError {
    /// Cancelled (the caller's future dropped), timed out, or the output
    /// passed its cap.
    Stopped,
    Spawn,
    Wait,
    Read,
    Write,
    /// curl exited unsuccessfully (its exit code; 28 = timeout, 60 =
    /// certificate, 7 = connect).
    Exit(Option<i32>),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Stopped => write!(
                f,
                "curl cancelled, timed out or exceeded the response limit"
            ),
            RunError::Spawn => write!(f, "curl unavailable"),
            RunError::Wait => write!(f, "curl wait failed"),
            RunError::Read => write!(f, "curl output read failed"),
            RunError::Write => write!(f, "curl input write failed"),
            RunError::Exit(c) => write!(f, "curl exit {}", c.unwrap_or(-1)),
        }
    }
}

/// Sets the flag when dropped: a dropped caller future stops the worker.
pub(crate) struct Cancel(pub(crate) Arc<AtomicBool>);
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

pub(crate) fn bounded_output(
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

/// Runs `curl args` with `stdin` written to it, reading at most `cap`
/// bytes of stdout (one more kills it), for at most `deadline`, killing
/// and reaping it as soon as `cancelled` is set. stderr is discarded.
/// Blocking: call from `spawn_blocking`.
pub(crate) fn run_curl(
    args: Vec<String>,
    stdin: Vec<u8>,
    cap: usize,
    deadline: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    // Cancellation while this blocking job was queued must not start a process.
    if cancelled.load(Ordering::Acquire) {
        return Err(RunError::Stopped);
    }
    let start = Instant::now();
    let child = Command::new("curl")
        .args(args)
        .env_remove("SSLKEYLOGFILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| RunError::Spawn)?;
    let mut process = Process {
        child,
        reaped: false,
    };
    let stdout = process.child.stdout.take().ok_or(RunError::Read)?;
    let mut input = process.child.stdin.take().ok_or(RunError::Write)?;
    std::thread::scope(move |scope| {
        // Own the guard inside the scoped closure: a thread-creation panic
        // must kill curl before scope's automatic joins wait on pipe readers.
        let mut process = process;
        let overflow = Arc::new(AtomicBool::new(false));
        let reader_overflow = overflow.clone();
        let output = scope.spawn(move || bounded_output(stdout, cap, &reader_overflow));
        let written = scope.spawn(move || input.write_all(&stdin));
        let status = loop {
            if cancelled.load(Ordering::Acquire)
                || overflow.load(Ordering::Acquire)
                || start.elapsed() >= deadline
            {
                process.stop();
                break Err(RunError::Stopped);
            }
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    process.reaped = true;
                    break Ok(status);
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => {
                    process.stop();
                    break Err(RunError::Wait);
                }
            }
        };
        // On all monitor exits the child is reaped before joining pipe workers.
        let output = output
            .join()
            .map_err(|_| RunError::Read)?
            .map_err(|_| RunError::Read)?;
        let written = written.join().map_err(|_| RunError::Write)?;
        let status = status?;
        if !status.success() {
            return Err(RunError::Exit(status.code()));
        }
        written.map_err(|_| RunError::Write)?;
        Ok(output)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_urls_allow_a_plain_query_only() {
        for ok in [
            "https://api.devnet.solana.com",
            "https://api.devnet.solana.com/",
            "https://devnet.example-rpc.com/?api-key=abc-123_X",
            "https://rpc.example.com/tok3n/",
            "http://127.0.0.1:41450/",
            "http://127.0.0.1:41450/?a=b&c=d",
        ] {
            assert!(check_post_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.devnet.solana.com",           // plain http off loopback
            "https://api.devnet.solana.com/?",        // empty query
            "https://api.devnet.solana.com/?a=b c",   // space
            "https://api.devnet.solana.com/?a=%41",   // escape
            "https://api.devnet.solana.com/?a=\"",    // quote
            "https://api.devnet.solana.com/?a={1,2}", // glob
            "https://api.devnet.solana.com/#x",
            "https://u:p@api.devnet.solana.com/",
            "https://api.devnet.solana.com/?a=b?c",
            "https://API.devnet.solana.com/",
            "--config",
        ] {
            assert!(check_post_url(bad).is_err(), "{bad}");
        }
        let long = format!("https://a.example/{}", "x".repeat(MAX_URL));
        assert!(check_post_url(&long).is_err());
    }

    #[test]
    fn post_argv_carries_no_request_data() {
        let url = "https://rpc.example.com/s3cret/?api-key=k3y";
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["AAAA"]}"#;
        let a = post_args(true, &PostOpts::default());
        assert_eq!(a[0], "-q", ".curlrc must be ignored");
        let joined = a.join(" ");
        for leak in [
            "s3cret",
            "k3y",
            "sendTransaction",
            "AAAA",
            "rpc.example.com",
        ] {
            assert!(!joined.contains(leak), "{leak} on argv");
        }
        for forbidden in [
            "-k",
            "--insecure",
            "-L",
            "--location",
            "--url",
            "--data-binary",
        ] {
            assert!(!a.iter().any(|x| x == forbidden), "{forbidden}");
        }
        let p = a.iter().position(|x| x == "--proto").unwrap();
        assert_eq!(a[p + 1], "=https");
        assert_eq!(&a[a.len() - 2..], ["--config", "-"]);
        assert!(a.iter().any(|x| x == "--globoff"));
        let c = String::from_utf8(post_config(url, body).unwrap()).unwrap();
        assert_eq!(
            c,
            format!(
                "url = \"{url}\"\ndata-raw = \"{}\"\n",
                String::from_utf8_lossy(body).replace('"', "\\\"")
            )
        );
        // A backslash in JSON (an escaped quote) survives the config quoting.
        let c = post_config("http://127.0.0.1:1/", br#"{"a":"q\"x\\y"}"#).unwrap();
        assert!(String::from_utf8(c)
            .unwrap()
            .contains(r#""{\"a\":\"q\\\"x\\\\y\"}""#));
        assert!(post_config("http://127.0.0.1:1/", b"{\n}").is_err());
        // A body starting with `@` is data, never a file name (`data-raw`).
        let c =
            String::from_utf8(post_config("http://127.0.0.1:1/", b"@/etc/hosts").unwrap()).unwrap();
        assert!(c.contains("\ndata-raw = \"@/etc/hosts\"\n"), "{c}");
        assert!(!c.contains("data-binary") && !c.contains("\ndata ="), "{c}");
        let a = post_args(false, &PostOpts::default());
        let p = a.iter().position(|x| x == "--proto").unwrap();
        assert_eq!(a[p + 1], "=http");
    }

    #[test]
    fn redaction_keeps_the_host_only() {
        assert_eq!(
            redact("https://rpc.example.com/s3cret/?api-key=k3y"),
            "https://rpc.example.com"
        );
        assert_eq!(redact("https://u:p@h/x"), "https://<redacted>");
        assert_eq!(redact("http://127.0.0.1:41450"), "http://127.0.0.1:41450");
        assert_eq!(redact("ftp://x"), "<url>");
    }

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
        assert_eq!(
            run_curl(vec![], vec![], 100, Duration::from_secs(1), cancelled),
            Err(RunError::Stopped)
        );
    }

    #[test]
    fn post_limits_are_checked_before_any_process() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let big = vec![b'a'; POST_MAX_REQUEST + 1];
            assert!(post("https://a.example/", big, &PostOpts::default())
                .await
                .is_err());
            let zero = PostOpts {
                max_response_bytes: 0,
                ..PostOpts::default()
            };
            assert!(matches!(
                post("https://a.example/", b"{}".to_vec(), &zero).await,
                Err(PortError::Unsupported(_))
            ));
            assert!(matches!(
                post("http://a.example/", b"{}".to_vec(), &PostOpts::default()).await,
                Err(PortError::Unsupported(_))
            ));
        });
    }
}
