//! A small HTTP/1.1 client over tokio for loopback services (localnet
//! JSON-RPC, drand-replay, the keeper API). One request per connection
//! (`Connection: close`); `Content-Length` and chunked bodies are read.
//!
//! **`https://`** GETs (live drand) and JSON POSTs (a public cluster's
//! JSON-RPC, devnet-readiness B1) go through [`crate::https`], the one
//! module that speaks TLS (the system `curl`, hardened; see its notes).
//! Other `https://` methods and extra headers over https stay `Unsupported`.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
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

/// JSON POST with explicit https options (trust anchor, limits). A plain
/// `http://` URL ignores `https` and takes [`post_json_bounded`]'s path
/// when `max_response_bytes` is set, [`post_json`]'s otherwise.
pub async fn post_json_with(
    url: &str,
    body: &serde_json::Value,
    max_response_bytes: Option<usize>,
    https: &crate::https::PostOpts,
) -> Result<Response, PortError> {
    if url.starts_with("https://") {
        let body = serde_json::to_vec(body).map_err(|e| PortError::Decode(e.to_string()))?;
        let mut o = https.clone();
        if let Some(m) = max_response_bytes {
            o.max_response_bytes = m;
        }
        return crate::https::post(url, body, &o).await;
    }
    match max_response_bytes {
        Some(m) => post_json_bounded(url, body, m).await,
        None => post_json(url, body).await,
    }
}

/// JSON POST with a cap on response wire bytes, including headers and
/// chunk framing. One extra byte is read to detect overflow before parsing.
/// Over `https://` the cap is on the body ([`crate::https::post`]). The
/// timeout is 20 s.
pub async fn post_json_bounded(
    url: &str,
    body: &serde_json::Value,
    max_response_bytes: usize,
) -> Result<Response, PortError> {
    let body = serde_json::to_vec(body).map_err(|e| PortError::Decode(e.to_string()))?;
    if url.starts_with("https://") {
        let o = crate::https::PostOpts {
            max_response_bytes,
            ..Default::default()
        };
        return crate::https::post(url, body, &o).await;
    }
    tokio::time::timeout(
        TIMEOUT,
        request_inner("POST", url, Some(body), &[], Some(max_response_bytes)),
    )
    .await
    .map_err(|_| PortError::Io(format!("timeout: POST {url}")))?
}

pub async fn request(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
) -> Result<Response, PortError> {
    if url.starts_with("https://") {
        return match (method, body) {
            ("GET", _) => curl_get(url).await,
            ("POST", Some(body)) => {
                crate::https::post(url, body, &crate::https::PostOpts::default()).await
            }
            _ => Err(PortError::Unsupported(
                "https:// is GET or a JSON POST with a body only",
            )),
        };
    }
    tokio::time::timeout(TIMEOUT, request_inner(method, url, body, &[], None))
        .await
        .map_err(|_| PortError::Io(format!("timeout: {method} {url}")))?
}

/// `GET` with extra request headers (names and values must be plain
/// printable ASCII without CR/LF; others are dropped).
pub async fn get_with_headers(url: &str, headers: &[(&str, &str)]) -> Result<Response, PortError> {
    if url.starts_with("https://") {
        return Err(PortError::Unsupported("https:// takes no extra headers"));
    }
    tokio::time::timeout(TIMEOUT, request_inner("GET", url, None, headers, None))
        .await
        .map_err(|_| PortError::Io(format!("timeout: GET {url}")))?
}

async fn request_inner(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    headers: &[(&str, &str)],
    max_response_bytes: Option<usize>,
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
    read_response(&mut s, max_response_bytes).await
}

async fn read_response<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_response_bytes: Option<usize>,
) -> Result<Response, PortError> {
    let mut buf = Vec::with_capacity(max_response_bytes.map_or(4096, |n| n.min(4096)));
    if let Some(max_response_bytes) = max_response_bytes {
        // Saturation avoids wrapping a caller-supplied usize::MAX cap.
        let read_limit = (max_response_bytes as u64).saturating_add(1);
        reader
            .take(read_limit)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| PortError::Io(e.to_string()))?;
        if buf.len() > max_response_bytes {
            return Err(PortError::Decode(format!(
                "HTTP response exceeds {max_response_bytes} wire bytes"
            )));
        }
    } else {
        reader
            .read_to_end(&mut buf)
            .await
            .map_err(|e| PortError::Io(e.to_string()))?;
    }
    parse_response(&buf)
}

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

// The curl transport (GET and POST over https) lives in `crate::https`;
// these re-exports keep the old paths working.
pub use crate::https::{
    check_curl_url, curl_args, curl_get, curl_get_with, parse_curl_output, HTTPS_MAX_BODY,
};

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
mod bounded_response_tests {
    use super::*;

    // A byte slice is an in-memory AsyncRead. This runtime has no I/O or
    // time drivers, and none of these tests calls a request or curl path.
    fn read_bounded(raw: &[u8], cap: usize) -> (Result<Response, PortError>, usize) {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mut reader = raw;
        let result = rt.block_on(read_response(&mut reader, Some(cap)));
        (result, raw.len() - reader.len())
    }

    fn assert_limit_error(result: Result<Response, PortError>, cap: usize) {
        assert!(matches!(
            result,
            Err(PortError::Decode(message))
                if message == format!("HTTP response exceeds {cap} wire bytes")
        ));
    }

    #[test]
    fn exact_wire_cap_is_accepted() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi";
        let (result, consumed) = read_bounded(raw, raw.len());
        let response = result.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"hi");
        assert_eq!(consumed, raw.len());
    }

    #[test]
    fn over_cap_stops_after_one_extra_byte_before_parsing() {
        let raw = b"not HTTP, and more bytes must remain unread";
        let cap = 8;
        let (result, consumed) = read_bounded(raw, cap);
        assert_limit_error(result, cap);
        assert_eq!(consumed, cap + 1);
    }

    #[test]
    fn chunk_framing_counts_toward_wire_cap() {
        let raw =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n1\r\nb\r\n0\r\n\r\n";
        let (result, consumed) = read_bounded(raw, raw.len());
        assert_eq!(result.unwrap().body, b"ab");
        assert_eq!(consumed, raw.len());

        let cap = raw.len() - 1;
        let (result, consumed) = read_bounded(raw, cap);
        assert_limit_error(result, cap);
        assert_eq!(consumed, cap + 1);
    }

    #[test]
    fn headers_consume_wire_budget_even_without_a_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Padding: abcdefghijklmnopqrstuvwxyz\r\n\r\n";
        let cap = 32;
        let (result, consumed) = read_bounded(raw, cap);
        assert_limit_error(result, cap);
        assert_eq!(consumed, cap + 1);
    }

    #[test]
    fn advertised_content_length_does_not_control_allocation() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\nhi",
            usize::MAX
        );
        let (result, consumed) = read_bounded(raw.as_bytes(), raw.len());
        assert!(matches!(result, Err(PortError::Decode(message)) if message == "short body"));
        assert_eq!(consumed, raw.len());
    }

    #[test]
    fn zero_cap_rejects_the_first_wire_byte() {
        let (result, consumed) = read_bounded(b"HTTP/1.1 200 OK\r\n\r\n", 0);
        assert_limit_error(result, 0);
        assert_eq!(consumed, 1);
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
        // (D-verify-pr44-6: the URL goes on stdin, as a POST's does)
        assert_eq!(&a[a.len() - 2..], ["--config", "-"]);
        assert!(!a.iter().any(|x| x == "--url" || x.contains("api.drand.sh")));
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
    fn https_other_methods_and_headers_are_unsupported() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            for (m, b) in [("PUT", Some(vec![])), ("POST", None), ("DELETE", None)] {
                assert!(matches!(
                    request(m, "https://api.drand.sh/x", b).await,
                    Err(PortError::Unsupported(_))
                ));
            }
            assert!(matches!(
                get_with_headers("https://api.drand.sh/x", &[]).await,
                Err(PortError::Unsupported(_))
            ));
        });
    }
}
