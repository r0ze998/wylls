//! JSON-RPC POST through `fclient::https` (devnet-readiness B1) against
//! loopback mocks only: a plain-http mock on 127.0.0.1 (curl's loopback
//! path, always run) and a TLS mock with its own CA (needs openssl and
//! python3: `--ignored`). Ports 41460–41469 (the fnode-devnet-rpc range) and 41800 (P2b).
//!
//!   P1 the body and the URL (path and query) arrive intact via stdin
//!   P2 a 429 comes back as a status; the shared pacer backs off and clears
//!   P2b a 429 backs off only its method; a 503 every method
//!   P3 a response over the cap kills curl (no partial body returned)
//!   P4 https with the right CA: `RpcClient::get_slot` works end to end
//!   P5 https with the ambient store (unknown CA) or a misnamed cert: refused

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fclient::https::{post, PostOpts};
use fclient::ports::PortError;
use fclient::rpc::{Pacer, RpcClient};

/// (request line, body) of each request the mock served.
type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

fn bind(port: u16) -> TcpListener {
    TcpListener::bind(("127.0.0.1", port))
        .unwrap_or_else(|e| panic!("127.0.0.1:{port} must be free (fnode-devnet-rpc range): {e}"))
}

/// A one-thread HTTP/1.1 mock: answers each request with `answer(body)`
/// (status, body) and records (request line, body).
fn mock(l: TcpListener, answer: impl Fn(&[u8]) -> (u16, Vec<u8>) + Send + 'static) -> Seen {
    let seen = Arc::new(Mutex::new(vec![]));
    let s2 = seen.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(c) = c else { break };
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            let (status, out) = answer(&body);
            s2.lock().unwrap().push((line.trim().to_string(), body));
            let mut c = c;
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    out.len()
                )
                .as_bytes(),
            );
            let _ = c.write_all(&out);
        }
    });
    seen
}

#[tokio::test]
async fn p1_p3_loopback_curl_post() {
    let l = bind(41460);
    let seen = mock(l, |b| {
        let v: serde_json::Value = serde_json::from_slice(b).unwrap_or_default();
        match v["method"].as_str().unwrap_or("") {
            "big" => (200, vec![b'x'; 10_000]),
            "limited" => (429, b"{}".to_vec()),
            _ => (200, br#"{"jsonrpc":"2.0","id":1,"result":7}"#.to_vec()),
        }
    });
    // P1: an escaped quote and backslash survive the config quoting.
    let body = br#"{"jsonrpc":"2.0","id":1,"method":"getSlot","params":["q\"x\\y"]}"#.to_vec();
    let r = post(
        "http://127.0.0.1:41460/tok3n/?api-key=k3y",
        body.clone(),
        &PostOpts::default(),
    )
    .await
    .unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(r.body, br#"{"jsonrpc":"2.0","id":1,"result":7}"#);
    {
        let s = seen.lock().unwrap();
        assert_eq!(s[0].0, "POST /tok3n/?api-key=k3y HTTP/1.1");
        assert_eq!(s[0].1, body);
    }
    // P1: a body starting with `@` is sent as is, never read as a file
    // name (curl's `data-binary = "@path"` would upload that local file).
    let file = std::env::temp_dir().join(format!("fnode-at-body-{}", std::process::id()));
    std::fs::write(&file, b"LOCAL FILE CONTENT").unwrap();
    let at = format!("@{}", file.display()).into_bytes();
    let r = post("http://127.0.0.1:41460/", at.clone(), &PostOpts::default())
        .await
        .unwrap();
    let _ = std::fs::remove_file(&file);
    assert_eq!(r.status, 200);
    assert_eq!(
        seen.lock().unwrap()[1].1,
        at,
        "the @-body itself, not the file"
    );
    // P2: a 429 is a status, not a transport error.
    let r = post(
        "http://127.0.0.1:41460/",
        br#"{"method":"limited"}"#.to_vec(),
        &PostOpts::default(),
    )
    .await
    .unwrap();
    assert_eq!(r.status, 429);
    // P3: over the cap → error, no body.
    let small = PostOpts {
        max_response_bytes: 1_000,
        ..PostOpts::default()
    };
    let e = post(
        "http://127.0.0.1:41460/",
        br#"{"method":"big"}"#.to_vec(),
        &small,
    )
    .await
    .unwrap_err();
    assert!(
        matches!(e, PortError::Io(_) | PortError::Decode(_)),
        "{e:?}"
    );
    // Errors name the host only.
    let e = post(
        "http://127.0.0.1:41460/s3cret/?api-key=k3y",
        br#"{"method":"big"}"#.to_vec(),
        &small,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(!e.contains("s3cret") && !e.contains("k3y"), "{e}");
}

#[tokio::test]
async fn p2_pacer_backs_off_on_429_and_clears() {
    let l = bind(41461);
    let n = Arc::new(Mutex::new(0u32));
    let n2 = n.clone();
    mock(l, move |_| {
        let mut k = n2.lock().unwrap();
        *k += 1;
        if *k == 1 {
            (429, b"{}".to_vec())
        } else {
            (200, br#"{"jsonrpc":"2.0","id":2,"result":42}"#.to_vec())
        }
    });
    let pacer = Pacer::new(Duration::from_millis(20), Duration::from_secs(2));
    let c = RpcClient::new("http://127.0.0.1:41461/").with_pacer(pacer.clone());
    let e = c.get_slot().await.unwrap_err();
    assert!(matches!(e, PortError::Http(429)), "{e:?}");
    assert_eq!(pacer.penalty().await, Duration::from_millis(500));
    let t = std::time::Instant::now();
    assert_eq!(c.get_slot().await.unwrap(), 42);
    assert!(
        t.elapsed() >= Duration::from_millis(450),
        "waited the penalty"
    );
    assert_eq!(pacer.penalty().await, Duration::ZERO);
}

/// rpc-pacer-per-method over real HTTP (port 41800): a 429 on
/// getTransaction holds back only getTransaction; getAccountInfo goes on at
/// the min gap, and a 503 still holds back every method.
#[tokio::test]
async fn p2b_a_429_backs_off_only_its_method() {
    let l = bind(41800);
    let seen = mock(l, |b| {
        let v: serde_json::Value = serde_json::from_slice(b).unwrap_or_default();
        match v["method"].as_str().unwrap_or("") {
            "getTransaction" => (429, b"{}".to_vec()),
            "unavailable" => (503, b"{}".to_vec()),
            _ => (200, br#"{"jsonrpc":"2.0","id":1,"result":7}"#.to_vec()),
        }
    });
    let pacer = fclient::rpc::Pacer::with_scope(
        Duration::from_millis(20),
        Duration::from_secs(2),
        fclient::rpc::PacerScope::Method,
    );
    let c = RpcClient::new("http://127.0.0.1:41800/").with_pacer(pacer.clone());
    let e = c
        .call("getTransaction", serde_json::json!([]))
        .await
        .unwrap_err();
    assert!(matches!(e, PortError::Http(429)), "{e:?}");
    assert_eq!(
        pacer.penalty_of("getTransaction"),
        Duration::from_millis(500)
    );
    let t = std::time::Instant::now();
    for _ in 0..5 {
        assert_eq!(
            c.call("getAccountInfo", serde_json::json!([]))
                .await
                .unwrap(),
            7
        );
    }
    assert!(
        t.elapsed() < Duration::from_millis(450),
        "not held: {:?}",
        t.elapsed()
    );
    // getTransaction itself waits its penalty out.
    let t = std::time::Instant::now();
    assert!(c
        .call("getTransaction", serde_json::json!([]))
        .await
        .is_err());
    assert!(
        t.elapsed() >= Duration::from_millis(250),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(pacer.penalty_of("getTransaction"), Duration::from_secs(1));
    // A 503: every method waits.
    assert!(c.call("unavailable", serde_json::json!([])).await.is_err());
    let t = std::time::Instant::now();
    assert_eq!(
        c.call("getAccountInfo", serde_json::json!([]))
            .await
            .unwrap(),
        7
    );
    assert!(
        t.elapsed() >= Duration::from_millis(450),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(seen.lock().unwrap().len(), 9);
}

// ---------------------------------------------------------------- TLS

struct Tls {
    dir: std::path::PathBuf,
    child: std::process::Child,
}
impl Drop for Tls {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A TLS JSON-RPC mock on 127.0.0.1:`port` with a fresh CA and a server
/// certificate for `name` (python3 `ssl`, openssl for the keys).
fn tls_rpc(tag: &str, name: &str, port: u16) -> Tls {
    let dir = std::env::temp_dir().join(format!("fnode-rpc-tls-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let o = |args: &[&str]| {
        let s = std::process::Command::new("openssl")
            .args(args)
            .current_dir(&dir)
            .stderr(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(s.success(), "openssl {args:?}");
    };
    o(&[
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=fnode-test-ca",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
    ]);
    o(&[
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        &format!("/CN={name}"),
        "-keyout",
        "srv.key",
        "-out",
        "srv.csr",
    ]);
    std::fs::write(dir.join("ext"), format!("subjectAltName=DNS:{name}\n")).unwrap();
    o(&[
        "x509",
        "-req",
        "-in",
        "srv.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        "ext",
        "-out",
        "srv.pem",
    ]);
    drop(bind(port)); // free now
    let py = r#"import http.server,ssl,sys,json
class H(http.server.BaseHTTPRequestHandler):
  def do_POST(self):
    n=int(self.headers.get('content-length','0'));q=json.loads(self.rfile.read(n))
    out=json.dumps({'jsonrpc':'2.0','id':q['id'],'result':4242}).encode()
    self.send_response(200);self.send_header('content-length',str(len(out)));self.end_headers();self.wfile.write(out)
  def log_message(self,*a): pass
s=http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),H)
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);c.load_cert_chain(sys.argv[2],sys.argv[3])
s.socket=c.wrap_socket(s.socket,server_side=True)
print('up',flush=True)
s.serve_forever()
"#;
    let mut child = std::process::Command::new("python3")
        .args(["-I", "-c", py, &port.to_string()])
        .arg(dir.join("srv.pem"))
        .arg(dir.join("srv.key"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "up");
    Tls { dir, child }
}

#[tokio::test]
#[ignore = "needs openssl and python3; run with --ignored"]
async fn p4_p5_https_json_rpc_with_a_test_ca() {
    let s = tls_rpc("ok", "localhost", 41462);
    let ca = s.dir.join("ca.pem");
    // P4: the right CA.
    let c = RpcClient::new("https://localhost:41462/").with_cacert(&ca);
    assert_eq!(c.get_slot().await.unwrap(), 4242);
    // Bounded variant too.
    let c = RpcClient::new_with_response_limit("https://localhost:41462/", 4096).with_cacert(&ca);
    assert_eq!(c.get_slot().await.unwrap(), 4242);
    // P5: the ambient trust store does not know the test CA.
    let e = RpcClient::new("https://localhost:41462/")
        .get_slot()
        .await
        .unwrap_err();
    assert!(matches!(e, PortError::Io(_)), "{e:?}");
    eprintln!("untrusted CA refused: {e}");
    // P5: a certificate from the trusted CA for another name.
    let bad = tls_rpc("name", "evil.example", 41463);
    let e = RpcClient::new("https://localhost:41463/")
        .with_cacert(bad.dir.join("ca.pem"))
        .get_slot()
        .await
        .unwrap_err();
    assert!(matches!(e, PortError::Io(_)), "{e:?}");
    eprintln!("misnamed certificate refused: {e}");
}
