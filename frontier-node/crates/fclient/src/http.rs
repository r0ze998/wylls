//! A small HTTP/1.1 client over tokio for loopback services (localnet
//! JSON-RPC, drand-replay, the keeper API). One request per connection
//! (`Connection: close`); `Content-Length` and chunked bodies are read.
//!
//! **`https://` GETs** (live drand: `api.drand.sh` and its mirrors) go
//! through the system `curl`, as drand-replay's prefetch already does
//! (W2-C D7): the contract's dependency set has no TLS crate (W1-F R4 is
//! still a request), and curl is on every machine that runs the stack. The
//! call is hardened rather than trusted: `-q` first (no `.curlrc` can turn
//! verification off), `--proto =https` and no redirect following, TLS ≥ 1.2,
//! bounded time and size, the URL passed with `--url` after a strict check
//! (no userinfo, escapes, whitespace or quotes), and the answer refused
//! unless curl reports scheme HTTPS with `ssl_verify_result` 0. Peer
//! certificates are checked against curl's trust store (`CURL_CA_BUNDLE` /
//! `SSL_CERT_FILE` when the host sets them). TLS only protects the
//! transport: a drand round is accepted because it verifies against the
//! pinned key (`beacon::HttpDrand`), never because of the certificate.
//! `https://` POSTs (a public RPC) stay `Unsupported`.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::ports::PortError;

pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// `http://host:port/path` → (host:port, path).
pub fn split_url(url: &str) -> Result<(String, String), PortError> {
    let rest = url.strip_prefix("http://").ok_or(PortError::Unsupported(
        "only http:// URLs (loopback services)",
    ))?;
    let (hp, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let hp = if hp.contains(':') {
        hp.to_string()
    } else {
        format!("{hp}:80")
    };
    Ok((hp, path.to_string()))
}

pub async fn get(url: &str) -> Result<Response, PortError> {
    request("GET", url, None).await
}

pub async fn post_json(url: &str, body: &serde_json::Value) -> Result<Response, PortError> {
    request(
        "POST",
        url,
        Some(serde_json::to_vec(body).map_err(|e| PortError::Decode(e.to_string()))?),
    )
    .await
}

pub async fn request(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
) -> Result<Response, PortError> {
    if url.starts_with("https://") {
        if method != "GET" {
            return Err(PortError::Unsupported("https:// is GET only (live drand)"));
        }
        return curl_get(url).await;
    }
    tokio::time::timeout(TIMEOUT, request_inner(method, url, body, &[]))
        .await
        .map_err(|_| PortError::Io(format!("timeout: {method} {url}")))?
}

/// `GET` with extra request headers (names and values must be plain
/// printable ASCII without CR/LF; others are dropped).
pub async fn get_with_headers(url: &str, headers: &[(&str, &str)]) -> Result<Response, PortError> {
    if url.starts_with("https://") {
        return Err(PortError::Unsupported("https:// takes no extra headers"));
    }
    tokio::time::timeout(TIMEOUT, request_inner("GET", url, None, headers))
        .await
        .map_err(|_| PortError::Io(format!("timeout: GET {url}")))?
}

async fn request_inner(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    headers: &[(&str, &str)],
) -> Result<Response, PortError> {
    let (hp, path) = split_url(url)?;
    let mut s = TcpStream::connect(&hp)
        .await
        .map_err(|e| PortError::Io(format!("{hp}: {e}")))?;
    let body = body.unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {hp}\r\nConnection: close\r\nAccept: application/json\r\n");
    for (k, v) in headers {
        let name_ok = !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if name_ok && v.bytes().all(|b| (0x20..0x7f).contains(&b)) {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    if method != "GET" {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| PortError::Io(e.to_string()))?;
    if !body.is_empty() {
        s.write_all(&body)
            .await
            .map_err(|e| PortError::Io(e.to_string()))?;
    }
    let mut buf = Vec::with_capacity(4096);
    s.read_to_end(&mut buf)
        .await
        .map_err(|e| PortError::Io(e.to_string()))?;
    parse_response(&buf)
}

// ---------------------------------------------------------------- https (curl)

/// Largest body an `https://` GET accepts (a drand round is ≈ 200 B, its
/// info ≈ 500 B).
pub const HTTPS_MAX_BODY: u64 = 64 * 1024;

/// Whether a URL's host is loopback (`127.0.0.1`, `[::1]`, `localhost`).
///
/// The authority (up to the first `/`, `?` or `#`) must be exactly
/// `host[:port]` with a numeric port: an authority with userinfo
/// (`127.0.0.1:x@api.drand.sh`, which curl sends to the public host), a
/// backslash, a percent-escape or whitespace is never loopback (integ-W2
/// review of W2-C; moved here from drand-replay's prefetch so the keeper's
/// config check and the prefetch guard are one function).
pub fn is_loopback(url: &str) -> bool {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority
        .chars()
        .any(|c| matches!(c, '@' | '\\' | '%') || c.is_whitespace() || c.is_control())
    {
        return false;
    }
    let (host, port) = if let Some(h) = authority.strip_prefix('[') {
        match h.split_once(']') {
            Some((host, tail)) => (host, tail),
            None => return false,
        }
    } else {
        match authority.find(':') {
            Some(i) => (&authority[..i], &authority[i..]),
            None => (authority, ""),
        }
    };
    let port_ok = port.is_empty()
        || port.strip_prefix(':').is_some_and(|p| {
            !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit())
        });
    port_ok && matches!(host, "127.0.0.1" | "::1" | "localhost")
}

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
    if body.len() as u64 > HTTPS_MAX_BODY {
        return Err(PortError::Decode("curl: body too large".into()));
    }
    Ok(Response {
        status,
        headers: vec![],
        body,
    })
}

pub fn parse_response(buf: &[u8]) -> Result<Response, PortError> {
    let end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| PortError::Decode("no header end".into()))?;
    let head =
        std::str::from_utf8(&buf[..end]).map_err(|_| PortError::Decode("header utf8".into()))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status: u16 = status_line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| PortError::Decode(format!("status line {status_line:?}")))?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        })
        .collect();
    let raw = &buf[end + 4..];
    let r = Response {
        status,
        headers,
        body: vec![],
    };
    let body = if r
        .header("transfer-encoding")
        .is_some_and(|v| v.eq_ignore_ascii_case("chunked"))
    {
        dechunk(raw)?
    } else if let Some(n) = r
        .header("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        raw.get(..n)
            .ok_or_else(|| PortError::Decode("short body".into()))?
            .to_vec()
    } else {
        raw.to_vec()
    };
    Ok(Response { body, ..r })
}

fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, PortError> {
    let mut out = vec![];
    loop {
        let e = raw
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| PortError::Decode("chunk size".into()))?;
        let size_s =
            std::str::from_utf8(&raw[..e]).map_err(|_| PortError::Decode("chunk utf8".into()))?;
        let n = usize::from_str_radix(size_s.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| PortError::Decode("chunk hex".into()))?;
        raw = &raw[e + 2..];
        if n == 0 {
            return Ok(out);
        }
        out.extend_from_slice(
            raw.get(..n)
                .ok_or_else(|| PortError::Decode("short chunk".into()))?,
        );
        raw = raw
            .get(n + 2..)
            .ok_or_else(|| PortError::Decode("chunk end".into()))?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_chunked() {
        let r = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhiXX").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"hi"[..]));
        let c = parse_response(b"HTTP/1.1 425 Too Early\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap();
        assert_eq!((c.status, c.body.as_slice()), (425, &b"abcde"[..]));
        assert_eq!(
            split_url("http://127.0.0.1:41010").unwrap(),
            ("127.0.0.1:41010".into(), "/".into())
        );
        assert!(split_url("https://api.drand.sh").is_err());
    }

    #[test]
    fn curl_urls_are_checked_strictly() {
        for ok in [
            "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1",
            "https://drand.cloudflare.com/info",
            "https://api.drand.sh:443/v2/chains/ab/info",
            "http://127.0.0.1:41020/info",
            "http://[::1]:41020/info",
            "http://localhost/x",
        ] {
            assert!(check_curl_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.drand.sh/info", // plain http off loopback
            "ftp://api.drand.sh/info",
            "https://user@api.drand.sh/info", // userinfo
            "https://127.0.0.1:x@api.drand.sh/info",
            "https://API.drand.sh/info",     // case games
            "https://api.drand.sh/info?x=1", // query
            "https://api.drand.sh/a b",
            "https://api.drand.sh/%2e%2e/info",
            "https://api.drand.sh/{a,b}", // curl globbing
            "https://api.drand.sh/[1-9]",
            "https://-K/info",
            "https://api.drand.sh:44a/info",
            "https://[fe80::1]/info",
            "https://api..drand.sh/info",
            "https://api.drand.sh\\@evil/info",
            "--insecure",
        ] {
            assert!(check_curl_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn curl_never_runs_without_verification() {
        let a = curl_args("https://api.drand.sh/info", None);
        assert_eq!(a[0], "-q", ".curlrc must be ignored");
        for forbidden in ["-k", "--insecure", "-L", "--location", "--proxy-insecure"] {
            assert!(!a.iter().any(|x| x == forbidden), "{forbidden}");
        }
        let w = a.iter().position(|x| x == "--proto").unwrap();
        assert_eq!(a[w + 1], "=https");
        assert_eq!(a[a.len() - 2], "--url");
        assert_eq!(a[a.len() - 1], "https://api.drand.sh/info");
    }

    #[test]
    fn curl_trailer_must_say_verified_https() {
        let ok = parse_curl_output(b"{\"round\":1}\n200 0 HTTPS", true).unwrap();
        assert_eq!(
            (ok.status, ok.body.as_slice()),
            (200, &b"{\"round\":1}"[..])
        );
        let early = parse_curl_output(b"Requested future beacon\n425 0 HTTPS", true).unwrap();
        assert_eq!(early.status, 425);
        assert!(
            parse_curl_output(b"x\n200 19 HTTPS", true).is_err(),
            "verify failed"
        );
        assert!(
            parse_curl_output(b"x\n200 0 HTTP", true).is_err(),
            "downgraded"
        );
        assert!(
            parse_curl_output(b"x\n000 0 HTTPS", true).is_err(),
            "no status"
        );
        assert!(parse_curl_output(b"no trailer", true).is_err());
        assert!(
            parse_curl_output(b"x\n200 0 HTTP", false).is_ok(),
            "loopback http"
        );
        let big = [
            vec![b'a'; HTTPS_MAX_BODY as usize + 1],
            b"\n200 0 HTTPS".to_vec(),
        ]
        .concat();
        assert!(parse_curl_output(&big, true).is_err());
    }

    #[test]
    fn https_post_and_headers_are_unsupported() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            assert!(matches!(
                post_json("https://api.drand.sh/x", &serde_json::json!({})).await,
                Err(PortError::Unsupported(_))
            ));
            assert!(matches!(
                get_with_headers("https://api.drand.sh/x", &[]).await,
                Err(PortError::Unsupported(_))
            ));
        });
    }
}
