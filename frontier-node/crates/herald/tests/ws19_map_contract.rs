//! The original map's read contract through the real herald (⑲,
//! 2026-11-08): the map-growth archive (`fixture::growth`) folded by the
//! real ingest and served by the real `server::router` on 127.0.0.1:0, read
//! at each stage (before OpenRing, the ring requested with its seed missing,
//! the seed out with the ring partly created). The answers are compared with
//! the committed golden `tests/golden/ws19-map-growth.json`, which the
//! client test (`permutation-gateway/test/web-frontier-map-contract.test.mjs`)
//! decodes with the page's own `herald.mjs` and `map/world.mjs`; one golden,
//! no second encoder.
//!
//! `WS19_GOLDEN_WRITE=1` rewrites the golden instead of comparing.
//!
//! Keyless: the fixture's fixed byte-pattern signatures, no transaction
//! bytes, public PDAs; the drand description is the public quicknet
//! constants (`fclient::beacon::quicknet_info`), no key is generated.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;

use common::{tmp, VecSource};
use herald_fold::fixture::{self, growth};
use herald_fold::runner::{Ingest, IngestCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/ws19-map-growth.json"
);

async fn get(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let r = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    // A binary answer (an overview) is kept whole, base64.
    let body = serde_json::from_slice(&a.body).unwrap_or_else(|_| {
        use base64::Engine;
        json!({"b64": base64::engine::general_purpose::STANDARD.encode(&a.body)})
    });
    (a.status, body)
}

/// The paths a stage is read at: the page's boot and poll reads.
fn paths() -> Vec<String> {
    let w = fixture::wallet().to_string();
    let mut v = vec!["/h/season".to_string(), "/h/world".to_string()];
    v.extend((0..=growth::R_MAX + 1).map(|d| format!("/h/world/ring/{d}")));
    for (p, q) in [growth::HOME, growth::NEVER_OPENED, (2, 0), (0, 2)] {
        v.push(format!("/h/province/{p},{q}/latest"));
    }
    v.push(format!("/h/me/{w}"));
    v.push("/h/wide-index/status".into());
    v.push("/h/world/wide".into());
    v
}

/// Reads every stage through one herald, growing as the chain does:
/// `ends[k]` is where stage `names[k]` ends in `txs`.
async fn serve_stages(
    txs: Vec<fclient::ports::TxRecord>,
    ends: &[usize],
    names: &[&str],
    program: solana_address::Address,
    season: u64,
    paths: &[String],
) -> Map<String, Value> {
    let dir = tmp(&format!("ws19-map-{season}"));
    let (diffs, _) = broadcast::channel(64);
    let cfg = IngestCfg::new(&dir, program, season);
    let mut ing = Ingest::open(cfg.clone(), diffs.clone()).unwrap();
    let app = App::new(
        ing.fold.clone(),
        herald_fold::files::Out::new(cfg.files_dir()),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: fclient::beacon::quicknet_info(),
            quotas: json!({"perDay": 40, "burst": 60}),
        },
        diffs,
    );
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    let mut src = VecSource::new(txs, 1);
    let mut out = Map::new();
    for (stage, &end) in names.iter().zip(ends) {
        while src.pos < end {
            ing.step(&mut src).await.unwrap();
        }
        let mut answers = Map::new();
        for p in paths {
            let (status, body) = get(addr, p).await;
            answers.insert(p.clone(), json!({"status": status, "body": body}));
        }
        out.insert(stage.to_string(), Value::Object(answers));
    }
    let _ = std::fs::remove_dir_all(&dir);
    out
}

async fn read_stages() -> Value {
    let (txs, ends) = growth::map_growth();
    let out = serve_stages(
        txs,
        &ends,
        &growth::STAGES,
        fixture::program(),
        fixture::SEASON_ID,
        &paths(),
    )
    .await;
    json!({
        "v": 1,
        "note": "herald answers for fixture::growth (tests/ws19_map_contract.rs); regenerate with WS19_GOLDEN_WRITE=1",
        "wallet": fixture::wallet().to_string(),
        "program": fixture::program().to_string(),
        "season": fixture::SEASON_ID.to_string(),
        "stages": out,
    })
}

fn body<'a>(g: &'a Value, stage: &str, path: &str) -> &'a Value {
    &g["stages"][stage][path]["body"]
}
fn status(g: &Value, stage: &str, path: &str) -> u64 {
    g["stages"][stage][path]["status"].as_u64().unwrap_or(0)
}

#[tokio::test]
async fn the_map_growth_answers_match_the_golden_and_the_world_rules() {
    let g = read_stages().await;
    if std::env::var("WS19_GOLDEN_WRITE").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(GOLDEN).parent().unwrap()).unwrap();
        std::fs::write(GOLDEN, serde_json::to_string_pretty(&g).unwrap() + "\n").unwrap();
    }
    let rings = |s: &str| -> Vec<(u64, String, u64)> {
        body(&g, s, "/h/world")["rings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["d"].as_u64().unwrap(),
                    r["seed"].as_str().unwrap().to_string(),
                    r["provinces"].as_u64().unwrap(),
                )
            })
            .collect()
    };
    let seeded = |s: &str| -> Vec<u64> {
        body(&g, s, "/h/season")["rings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["d"].as_u64().unwrap())
            .collect()
    };

    // S0: rings 0 and 1 seeded, ring 1 one Province short.
    assert_eq!(
        rings("S0"),
        vec![(0, "seeded".into(), 1), (1, "seeded".into(), 5)]
    );
    assert_eq!(seeded("S0"), vec![0, 1]);
    assert_eq!(body(&g, "S0", "/h/season")["ringsOpened"], json!(2));
    assert_eq!(body(&g, "S0", "/h/season")["ringProvinces"], json!([1, 5]));
    assert_eq!(
        status(&g, "S0", "/h/world/ring/2"),
        404,
        "ring 2 not open yet"
    );
    // S1: ring 2 opened, its seed requested: in the world, not in `rings`.
    assert_eq!(rings("S1")[2], (2, "requested".into(), 0));
    assert_eq!(
        seeded("S1"),
        vec![0, 1],
        "the season record lists seeded rings only"
    );
    assert_eq!(body(&g, "S1", "/h/season")["ringsOpened"], json!(3));
    assert_eq!(
        body(&g, "S1", "/h/world/ring/2")["seed"],
        json!("requested")
    );
    // S2: the seed is out, two Provinces of twelve on chain.
    assert_eq!(rings("S2")[2], (2, "seeded".into(), 2));
    assert_eq!(seeded("S2"), vec![0, 1, 2]);
    assert_eq!(
        body(&g, "S2", "/h/season")["ringProvinces"],
        json!([1, 5, 2])
    );
    for s in growth::STAGES {
        // The viewer's season record and the world manifest agree.
        let se = body(&g, s, "/h/season");
        let w = body(&g, s, "/h/world");
        assert_eq!(se["ringsOpened"], w["ringsOpened"], "{s}");
        assert_eq!(se["rMax"], w["rMax"], "{s}");
        assert_eq!(w["rMax"], json!(growth::R_MAX), "{s}");
        let per_ring: Vec<Value> = w["rings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["provinces"].clone())
            .collect();
        assert_eq!(se["ringProvinces"], json!(per_ring), "{s}");
        // Never-opened ring-1 Province: absent from its ring list and 404.
        let r1: Vec<(i64, i64)> = body(&g, s, "/h/world/ring/1")["provinces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (x["p"].as_i64().unwrap(), x["q"].as_i64().unwrap()))
            .collect();
        assert_eq!(r1.len(), 5, "{s}");
        assert!(!r1.contains(&(1, -1)), "{s}");
        assert_eq!(status(&g, s, "/h/province/1,-1/latest"), 404, "{s}");
        assert_eq!(status(&g, s, "/h/province/1,0/latest"), 200, "{s}");
        assert_eq!(
            status(&g, s, "/h/world/ring/3"),
            404,
            "{s}: ring 3 unopened"
        );
        // The wallet's holding is read back by /h/me.
        let me = body(&g, s, &format!("/h/me/{}", fixture::wallet()));
        assert_eq!(
            me["holdings"].as_array().map(|a| a.len()),
            Some(1),
            "{s}: {me}"
        );
    }
    assert_eq!(status(&g, "S2", "/h/province/2,0/latest"), 200);
    assert_eq!(status(&g, "S2", "/h/province/0,2/latest"), 404);

    let want: Value = serde_json::from_str(
        &std::fs::read_to_string(GOLDEN).expect("the golden (WS19_GOLDEN_WRITE=1 writes it)"),
    )
    .unwrap();
    assert_eq!(
        g, want,
        "the herald's answers changed: regenerate and review the golden"
    );
}

const GOLDEN_S1: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/ws19-map-growth-s1.json"
);

fn s1_paths() -> Vec<String> {
    use herald_fold::cqfixture::growth as g;
    let mut v = vec!["/h/season".to_string(), "/h/world".to_string()];
    v.extend((0..=g::CEILING).map(|d| format!("/h/world/ring/{d}")));
    for (p, q) in [g::HOME, g::TARGET, (6, 0)] {
        v.push(format!("/h/province/{p},{q}/latest"));
    }
    v.push(format!("/h/me/{}", g::wallet()));
    v.push(format!("/h/me/{}", g::resident_asset()));
    v.push(format!("/h/holding/{},{},0.json", g::HOME.0, g::HOME.1));
    v.push(format!("/h/holding/{},{},1.json", g::HOME.0, g::HOME.1));
    for d in 3..=5 {
        v.push(format!("/h/overview/{d}/latest.bin"));
        v.push(format!("/h/overview2/{d}/latest.bin"));
    }
    v.push("/h/wide-index/status".into());
    v.push("/h/world/wide".into());
    v
}

/// The S1 growth (workstream 8's ring 4 → 5 contract): the same router,
/// a layout-2 world, four stages.
#[tokio::test]
async fn the_s1_ring_4_to_5_growth_matches_the_golden_and_8s_contract() {
    use herald_fold::cqfixture::growth as gr;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::terrain::generate_province;
    use sha2::{Digest, Sha256};

    // 8's GEOMETRY (growth-route.mjs) from the same rule the fixture writes.
    for ((p, q), sites, mask, terrain) in [
        (
            (4, 0),
            [4u8, 33, 49, 53, 0, 11, 13, 17, 26, 28, 38, 43],
            2305843009188528127u64,
            "de18bbc8320f96db3c9f0f222b91292d49d92b5f28789ab8c2e7536b69333f53",
        ),
        (
            (5, 0),
            [18, 28, 45, 30, 53, 1, 4, 17, 48, 12, 35, 50],
            2305843009213693951,
            "ab335170b74b22b6c14efb7864f645e721bc97e15617efb1fae788b55858bb51",
        ),
    ] {
        let c = ProvinceCoord::new(p, q);
        let t = generate_province(&gr::ring_seed(c.ring() as u16), c);
        assert_eq!(t.sites, sites, "({p},{q}) sites");
        let m = (0..61u8)
            .filter(|&i| t.passable(i))
            .fold(0u64, |m, i| m | 1 << i);
        assert_eq!(m, mask, "({p},{q}) passable mask");
        let bytes: Vec<u8> = t
            .terrain
            .iter()
            .map(|x| {
                frontier_abi::clash_model::TERRAINS
                    .iter()
                    .position(|y| y == x)
                    .unwrap_or(0) as u8
            })
            .collect();
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            terrain,
            "({p},{q}) terrain"
        );
    }

    let (txs, ends) = gr::map_growth();
    let out = serve_stages(
        txs,
        &ends,
        &gr::STAGES,
        gr::program(),
        gr::SEASON_ID,
        &s1_paths(),
    )
    .await;
    let g = json!({
        "v": 1,
        "note": "herald answers for cqfixture::growth, workstream 8's S1 ring 4 -> 5 contract (tests/ws19_map_contract.rs); regenerate with WS19_GOLDEN_WRITE=1",
        "wallet": gr::wallet().to_string(),
        "program": gr::program().to_string(),
        "season": gr::SEASON_ID.to_string(),
        "host": gr::host().to_string(),
        "residentAsset": gr::resident_asset().to_string(),
        "residentCitizen": solana_address::Address::new_from_array(gr::resident_citizen()).to_string(),
        "stages": out,
    });
    if std::env::var("WS19_GOLDEN_WRITE").is_ok() {
        std::fs::write(GOLDEN_S1, serde_json::to_string_pretty(&g).unwrap() + "\n").unwrap();
    }
    let want = [
        ("before", 4, 5, 5, vec![1, 6, 12, 18, 24]),
        ("extended", 5, 5, 5, vec![1, 6, 12, 18, 24]),
        ("opened", 5, 6, 5, vec![1, 6, 12, 18, 24, 0]),
        ("grown", 5, 6, 6, vec![1, 6, 12, 18, 24, 30]),
    ];
    for (s, r_max, opened, seeded, counts) in want {
        let se = body(&g, s, "/h/season");
        let w = body(&g, s, "/h/world");
        assert_eq!(se["rMax"], json!(r_max), "{s}");
        assert_eq!(w["rMax"], json!(r_max), "{s}");
        assert_eq!(se["ringsOpened"], json!(opened), "{s}");
        assert_eq!(w["ringsOpened"], json!(opened), "{s}");
        assert_eq!(se["ringProvinces"], json!(counts), "{s}");
        assert_eq!(se["rMaxCeiling"], json!(gr::CEILING), "{s}");
        assert_eq!(w["rMaxCeiling"], json!(gr::CEILING), "{s}");
        assert_eq!(se["rMaxHard"], json!(128), "{s}");
        assert_eq!(se["placement"], json!(0), "{s}");
        assert_eq!(se["heartlandMaxRing"], json!(3), "{s}");
        let rings: Vec<(u64, String)> = se["rings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["d"].as_u64().unwrap(), r["seed"].as_str().unwrap().into()))
            .collect();
        let expect: Vec<(u64, String)> = (0..seeded)
            .map(|d| (d as u64, hex::encode(gr::ring_seed(d))))
            .collect();
        assert_eq!(rings, expect, "{s}: seeded rings with their seeds");
        assert_eq!(status(&g, s, "/h/province/4,0/latest"), 200, "{s}");
        assert_eq!(
            status(&g, s, "/h/province/5,0/latest"),
            if s == "grown" { 200 } else { 404 },
            "{s}"
        );
        assert_eq!(status(&g, s, "/h/province/6,0/latest"), 404, "{s}");
        let me = body(&g, s, &format!("/h/me/{}", gr::wallet()));
        assert_eq!(
            me["holdings"].as_array().map(|a| a.len()),
            Some(1),
            "{s}: {me}"
        );
        let hosts = me["hosts"].as_array().cloned().unwrap_or_default();
        assert!(
            hosts
                .iter()
                .any(|h| h.to_string().contains(&gr::host().to_string())),
            "{s}: the wallet's host on (4,0): {hosts:?}"
        );
    }
    // The NFT resident: me_citizen serves its Citizen for the asset key.
    for s in gr::STAGES {
        let me = body(&g, s, &format!("/h/me/{}", gr::resident_asset()));
        assert_eq!(
            me["citizen"]["address"], g["residentCitizen"],
            "{s}: the resident-id address: {me}"
        );
        assert_eq!(me["holdings"].as_array().map(|a| a.len()), Some(1), "{s}");
    }
    assert_eq!(status(&g, "extended", "/h/world/ring/5"), 404);
    assert_eq!(
        body(&g, "opened", "/h/world/ring/5")["seed"],
        json!("requested")
    );
    assert_eq!(
        body(&g, "grown", "/h/world/ring/5")["provinces"]
            .as_array()
            .map(|a| a.len()),
        Some(30)
    );

    let want: Value = serde_json::from_str(
        &std::fs::read_to_string(GOLDEN_S1).expect("the golden (WS19_GOLDEN_WRITE=1 writes it)"),
    )
    .unwrap();
    assert_eq!(
        g, want,
        "the herald's S1 answers changed: regenerate and review the golden"
    );
}
