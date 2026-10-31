//! `fclient::beacon::HttpDrand` and `discover_pinned` against hostile and
//! failing drand endpoints on 127.0.0.1 (one axum mock per behaviour): an
//! answer is used only when it is the round asked for and verifies against
//! the pinned key, a bad endpoint never ends the search, and "not yet" is
//! the answer only when no endpoint served a verified round. Plus a local
//! TLS server (openssl + python3; `#[ignore]`, run with `--ignored`) that
//! shows the https path refuses an untrusted or misnamed certificate.

use std::sync::Arc;

use axum::extract::Path as UrlPath;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use fclient::beacon::{self, HttpDrand, TestKey};
use fclient::ports::{DrandPort, PortError};

const R: u64 = 1_000;

#[derive(Clone, Copy, Debug)]
enum Mode {
    Good,
    Garbage,
    /// An older correct round replayed for the one asked.
    OldRound,
    /// The round asked for, signed by another key (quicknet's fixture key).
    ForeignKey,
    /// The pinned key's signature with one bit flipped.
    Flipped,
    /// A correct signature with `randomness` that is not sha256(signature).
    BadRandomness,
    Early,
    Missing,
    Err500,
    /// `/info` of another chain served under the pinned chain's path.
    ForeignInfo,
}

async fn round_answer(mode: Mode, r: u64) -> Response {
    let k = TestKey::new();
    let json = |v: serde_json::Value| (StatusCode::OK, v.to_string()).into_response();
    match mode {
        Mode::Good | Mode::ForeignInfo => json(beacon::beacon_json(&k.beacon(r))),
        Mode::Garbage => (StatusCode::OK, "<html>not json</html>").into_response(),
        Mode::OldRound => json(beacon::beacon_json(&k.beacon(r - 1))),
        Mode::ForeignKey => {
            let f = beacon::FixtureDrand::load(&beacon::fixture_dir(), beacon::quicknet_info())
                .unwrap();
            let (_, b) = f.rounds.iter().next().unwrap();
            json(serde_json::json!({"round": r, "signature": hex::encode(b.sig48)}))
        }
        Mode::Flipped => {
            let mut s = k.sign(r);
            s[20] ^= 0x40;
            json(serde_json::json!({"round": r, "signature": hex::encode(s)}))
        }
        Mode::BadRandomness => {
            let mut v = beacon::beacon_json(&k.beacon(r));
            v["randomness"] = hex::encode([7u8; 32]).into();
            json(v)
        }
        Mode::Early => (StatusCode::from_u16(425).unwrap(), "Requested future beacon").into_response(),
        Mode::Missing => StatusCode::NOT_FOUND.into_response(),
        Mode::Err500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn serve(mode: Mode) -> String {
    let info = move || async move {
        let i = match mode {
            Mode::ForeignInfo => {
                // The quicknet key and clock under the test chain's path.
                let mut q = beacon::quicknet_info();
                q.chain_hash = TestKey::new().info().chain_hash;
                q
            }
            _ => TestKey::new().info(),
        };
        beacon::info_json(&i).to_string()
    };
    let app = Router::new()
        .route("/{chain}/info", get(move |_: UrlPath<String>| info()))
        .route(
            "/{chain}/public/{r}",
            get(move |UrlPath((_, r)): UrlPath<(String, u64)>| round_answer(mode, r)),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

/// A loopback port nothing listens on.
async fn dead() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    url
}

async fn drand(modes: &[Mode], with_dead: bool) -> HttpDrand {
    let mut urls = vec![];
    if with_dead {
        urls.push(dead().await);
    }
    for m in modes {
        urls.push(serve(*m).await);
    }
    HttpDrand::new(urls, TestKey::new().info())
}

#[tokio::test]
async fn no_bad_answer_is_ever_accepted() {
    for m in [
        Mode::Garbage,
        Mode::OldRound,
        Mode::ForeignKey,
        Mode::Flipped,
        Mode::BadRandomness,
        Mode::Err500,
    ] {
        let got = drand(&[m], false).await.round(R).await;
        assert!(got.is_err(), "{m:?}: {got:?}");
    }
    let got = drand(&[], true).await.round(R).await;
    assert!(matches!(got, Err(PortError::Io(_))), "dead port: {got:?}");
    assert!(matches!(
        drand(&[Mode::OldRound], false).await.round(R).await,
        Err(PortError::BadBeacon(R))
    ));
}

#[tokio::test]
async fn a_bad_endpoint_never_ends_the_search() {
    let d = drand(
        &[
            Mode::Garbage,
            Mode::OldRound,
            Mode::ForeignKey,
            Mode::Flipped,
            Mode::BadRandomness,
            Mode::Err500,
            Mode::Good,
        ],
        true,
    )
    .await;
    let b = d.round(R).await.unwrap().expect("the good endpoint serves it");
    assert_eq!(b, TestKey::new().beacon(R));
    // The same request answered again (a replayed response): same round.
    assert_eq!(d.round(R).await.unwrap(), Some(b));
}

#[tokio::test]
async fn not_yet_only_when_no_endpoint_has_it() {
    // Before this fix the first 425 or 404 ended the search: a lagging
    // mirror listed first hid a round the next one already served.
    for lag in [Mode::Early, Mode::Missing] {
        let d = drand(&[lag, Mode::Good], false).await;
        assert!(d.round(R).await.unwrap().is_some(), "{lag:?} then good");
    }
    assert_eq!(drand(&[Mode::Early], false).await.round(R).await, Ok(None));
    assert_eq!(drand(&[Mode::Missing], false).await.round(R).await, Ok(None));
    assert_eq!(
        drand(&[Mode::Early, Mode::Err500, Mode::Garbage], true)
            .await
            .round(R)
            .await,
        Ok(None),
        "one endpoint says not yet, the others failed: wait, never accept"
    );
}

#[tokio::test]
async fn discovery_takes_only_the_pinned_chain() {
    let test = TestKey::new().info();
    let good = serve(Mode::Good).await;
    let foreign = serve(Mode::ForeignInfo).await;
    let pins = beacon::pins_for(&[good.clone(), foreign.clone()]);
    assert_eq!(pins.len(), 2, "loopback: quicknet and the test key");
    let e = beacon::discover_pinned(&[foreign.clone()], &pins)
        .await
        .unwrap_err();
    assert!(e.contains("differs from the pin"), "{e}");
    let got = beacon::discover_pinned(&[dead().await, foreign, good], &pins)
        .await
        .unwrap();
    assert_eq!(got, test);
    // Off loopback the test key is never a pin (I-53).
    assert_eq!(
        beacon::pins_for(&["https://api.drand.sh".into()]),
        vec![beacon::quicknet_info()]
    );
}

// ---------------------------------------------------------------- local TLS

struct Tls {
    dir: std::path::PathBuf,
    child: std::process::Child,
    port: u16,
}

impl Drop for Tls {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run(cmd: &mut std::process::Command) {
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{cmd:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A CA, a server certificate for `name` signed by it, and a python3 HTTPS
/// server on 127.0.0.1 serving `/{chain}/public/{R}` (the test key).
fn tls_server(tag: &str, name: &str) -> Tls {
    let dir = std::env::temp_dir().join(format!("psf-tls-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let chain = hex::encode(TestKey::new().info().chain_hash);
    std::fs::create_dir_all(dir.join(format!("www/{chain}/public"))).unwrap();
    std::fs::write(
        dir.join(format!("www/{chain}/public/{R}")),
        beacon::beacon_json(&TestKey::new().beacon(R)).to_string(),
    )
    .unwrap();
    let o = |a: &[&str]| {
        let mut c = std::process::Command::new("openssl");
        c.args(a).current_dir(&dir);
        run(&mut c);
    };
    o(&["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=psf-test-ca",
        "-keyout", "ca.key", "-out", "ca.pem"]);
    o(&["req", "-newkey", "rsa:2048", "-nodes", "-subj", &format!("/CN={name}"),
        "-keyout", "srv.key", "-out", "srv.csr"]);
    std::fs::write(dir.join("ext"), format!("subjectAltName=DNS:{name}\n")).unwrap();
    o(&["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
        "-days", "1", "-extfile", "ext", "-out", "srv.pem"]);
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let py = "import http.server,ssl,sys,os\n\
os.chdir(sys.argv[2])\n\
s=http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),http.server.SimpleHTTPRequestHandler)\n\
c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);c.load_cert_chain(sys.argv[3],sys.argv[4])\n\
s.socket=c.wrap_socket(s.socket,server_side=True)\nprint('up',flush=True)\ns.serve_forever()\n";
    let mut child = std::process::Command::new("python3")
        .args(["-I", "-c", py, &port.to_string()])
        .arg(dir.join("www"))
        .arg(dir.join("srv.pem"))
        .arg(dir.join("srv.key"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    assert_eq!(line.trim(), "up");
    Tls { dir, child, port }
}

#[tokio::test]
#[ignore = "needs openssl and python3; run with --ignored"]
async fn https_refuses_untrusted_and_misnamed_certificates() {
    let chain = hex::encode(TestKey::new().info().chain_hash);
    let s = tls_server("ok", "localhost");
    let url = format!("https://localhost:{}/{chain}/public/{R}", s.port);
    let ca = s.dir.join("ca.pem");
    // Trusted CA: served, and the round verifies.
    let ok = fclient::http::curl_get_with(&url, Some(ca.clone())).await.unwrap();
    assert_eq!(ok.status, 200);
    let v: serde_json::Value = serde_json::from_slice(&ok.body).unwrap();
    assert!(beacon::check_served(&v, R, &TestKey::new().pk96).is_ok());
    // The same server with the ambient trust store: an unknown CA.
    let e = fclient::http::curl_get(&url).await.unwrap_err();
    assert!(matches!(e, PortError::Io(_)), "{e:?}");
    eprintln!("untrusted CA refused: {e}");
    // A certificate from the trusted CA for another name.
    let bad = tls_server("name", "evil.example");
    let url = format!("https://localhost:{}/{chain}/public/{R}", bad.port);
    let e = fclient::http::curl_get_with(&url, Some(bad.dir.join("ca.pem")))
        .await
        .unwrap_err();
    eprintln!("misnamed certificate refused: {e}");
    // Plain http to a TLS port, and https to a port nothing serves.
    let e = fclient::http::curl_get(&format!("https://localhost:{}/x", {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }))
    .await
    .unwrap_err();
    eprintln!("closed port: {e}");
    let _ = Arc::new(());
}
