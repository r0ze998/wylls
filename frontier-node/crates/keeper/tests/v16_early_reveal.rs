//! ⑯ independent verification (⑱ sealed marches): the keeper's
//! `/v1/reveal` accepts an owner's plaintext long before the arrival turn.
//!
//! The keeper's own contract (`src/play.rs:6`: "owner material from
//! `/v1/reveal` (from the bell start)") and the web's (M1 contract §9.3:
//! "never before the arrival bell starts") put the earliest reveal at
//! `bell_start(arrive)`. Neither `reveal_accept::judge` nor the Reveal
//! write (`play.rs`: `not_before_slot: t.slot + jitter`) enforces it, so
//! material submitted right after departure (an SDK or MCP client, not the
//! page) is accepted and the Reveal duty may send the plaintext to the RPC
//! as soon as the march is in its index: the destination is public for most
//! of the march. The seal itself opens only at T(arrive), the round at the
//! END of the arrival bell.
//!
//! Harness: the same as `tests/reveal_accept.rs` (localnet in process; the
//! program is the test-beacon `.so` when `PSF_FRONTIER_SO` names one, else
//! the native model of `tests/model`, a stand-in). What is judged here is
//! the keeper's acceptance, which is the real keeper code either way.

mod common;
mod model;

use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};

use fclient::abi::layout as l;
use fclient::seal;
use keeper_core::api;
use keeper_core::reveal_accept::{ChainGate, RevealGate};
use keeper_core::Keeper;

use common::*;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

async fn call(addr: std::net::SocketAddr, token: &str, body: Value) -> (u16, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let b = body.to_string();
    let req = format!(
        "POST /v1/reveal HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
        b.len()
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let code: u16 = out[9..12].parse().unwrap();
    let body = out.split("\r\n\r\n").nth(1).unwrap_or("{}");
    (code, serde_json::from_str(body).unwrap_or(json!({})))
}

fn put(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v16_t18_2_owner_material_before_the_arrival_turn_is_not_accepted() {
    let w = world().await;
    println!("program: {}", w.which.label());
    let mut cfg = keeper_config(&w);
    cfg.roles = vec!["beacon".into(), "rings".into()];
    let mut k = Keeper::new(cfg, w.ip.clone(), w.drand.clone(), &[0x51; 32], None).unwrap();
    fund(&w, &k.payers);
    k.start().await.unwrap();
    let genesis_ts = w.season().genesis_ts;
    while w.now() < genesis_ts + 2 * 600 {
        k.tick().await.unwrap();
        w.step();
    }
    let s = w.season();
    let now_bell = fclient::clock::bell_at(s.genesis_ts, w.now()).unwrap();
    // departed this bell, arriving in five: the march is on the road for four whole turns
    let arrive = now_bell + 5;
    let (op, oq, site) = (2i32, 0i32, 1u8);
    let (dp, dq) = (3i16, -1i16);
    let host = fclient::addr::host_id(op, oq, site, 0, 1).unwrap();
    let plain = seal::Plain {
        version: 1,
        host_id: host,
        arrive_bell: arrive,
        dest_p: dp,
        dest_q: dq,
        dest_tile: 7,
        stance: 2,
        retreat_bps: 0,
        path_len: 0,
        ..Default::default()
    };
    let pt = seal::pack(&plain);
    let salt = [0x5A; 32];
    let ct = [0xC7; 32];
    let root = seal::seal_root(&seal::commit(&pt, &salt), &ct);
    let hold_addr = w.addrs.holding(op, oq, site);
    {
        let mut h = vec![0u8; fclient::abi::size::HOLDING];
        put(&mut h, 0, fclient::abi::magic::HOLDING);
        put(&mut h, 8, &s.h.season_id.to_le_bytes());
        put(&mut h, 16, &1u16.to_le_bytes());
        put(&mut h, l::holding::P, &(op as i16).to_le_bytes());
        put(&mut h, l::holding::Q, &(oq as i16).to_le_bytes());
        h[l::holding::SITE] = site;
        h[l::holding::STATE] = l::holding::STATE_FINAL;
        let o = l::holding::TRANSIT + l::holding::TRANSIT_STRIDE;
        h[o + l::transit::STATE] = 1;
        h[o + l::transit::FACTION] = 0;
        put(&mut h, o + l::transit::HOST_ID, &host.to_le_bytes());
        put(&mut h, o + l::transit::DEPART_BELL, &now_bell.to_le_bytes());
        put(&mut h, o + l::transit::ARRIVE_BELL, &arrive.to_le_bytes());
        put(&mut h, o + l::transit::SEAL_ROOT, &root);
        w.ip.lock()
            .set_account(
                hold_addr,
                fclient::ports::Account {
                    lamports: fclient::abi::rent(h.len()),
                    data: h,
                    owner: w.program,
                    executable: false,
                },
            )
            .unwrap();
    }
    let token = "k".repeat(32);
    let gate: Arc<dyn RevealGate> = Arc::new(ChainGate {
        port: w.ip.clone(),
        addrs: w.addrs.clone(),
    });
    let srv = api::serve_with("127.0.0.1:0".parse().unwrap(), k.shared.clone(), token.clone(), Some(gate))
        .await
        .unwrap();
    let body = json!({
        "holding": hold_addr.to_string(),
        "transit_slot": 1,
        "plain_b64": B64.encode(pt),
        "salt_b64": B64.encode(salt),
        "ct_hash_b64": B64.encode(ct),
    });
    let bell_start_arrive = s.genesis_ts + 600 * arrive as i64;
    let opens_at = fclient::clock::SeasonClock::from_season(&s).tlock_round(arrive);
    println!(
        "now {} (bell {now_bell}); arrival bell {arrive} starts at {bell_start_arrive}; the seal's round {opens_at}",
        w.now()
    );
    assert!(w.now() < bell_start_arrive);
    let (c, v) = call(srv.addr, &token, body).await;
    let queued = k.shared.lock().unwrap().reveals.len();
    // The invariant (the keeper's and the web's own contract): nothing is taken before the arrival turn starts.
    assert!(
        c != 202 && queued == 0,
        "owner plaintext submitted {} s before the arrival turn starts was accepted ({c} {v}) and queued ({queued}) for the Reveal duty, whose write has no not-before bound",
        bell_start_arrive - w.now()
    );
}
